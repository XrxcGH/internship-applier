/**
 * Freshness — docs/04 § Freshness.
 *
 * Nothing is ever hard-deleted. A closed posting stays in the database so the tracker,
 * the application history, and the stats all remain intact; it is only marked closed.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { db, schema } from '../../infra/db/client';
import { HttpError, politeFetch } from '../../infra/http/fetcher';
import { logger } from '../../infra/logger';

export interface RefreshSummary {
  checked: number;
  closedByDeadline: number;
  closedByFetch: number;
  closedAsStale: number;
  errors: number;
}

const STALE_DAYS = 45;

export async function refreshPostings(
  opts: { limit?: number; now?: Date; checkUrls?: boolean; postingId?: string } = {},
): Promise<RefreshSummary> {
  const now = opts.now ?? new Date();
  const summary: RefreshSummary = {
    checked: 0,
    closedByDeadline: 0,
    closedByFetch: 0,
    closedAsStale: 0,
    errors: 0,
  };

  // 1. Deadline in the past — pure data, no network needed.
  const expired = db
    .update(schema.jobPosting)
    .set({ isOpen: false })
    .where(
      sql`${schema.jobPosting.isOpen} = 1 AND ${schema.jobPosting.closesAt} IS NOT NULL AND ${schema.jobPosting.closesAt} < ${now.toISOString()}`,
    )
    .run();
  summary.closedByDeadline = expired.changes;

  // 2. Not seen in a long time.
  const staleCutoff = new Date(now.getTime() - STALE_DAYS * 86_400_000).toISOString();
  const stale = db
    .update(schema.jobPosting)
    .set({ isOpen: false })
    .where(
      sql`${schema.jobPosting.isOpen} = 1 AND ${schema.jobPosting.lastSeenAt} < ${staleCutoff}`,
    )
    .run();
  summary.closedAsStale = stale.changes;

  if (!opts.checkUrls) return summary;

  // 3. Optional per-URL check. Only 404/410 closes a posting — a 500 or a timeout means
  //    the site is having a bad day, not that the job is gone.
  // Two fixes live in this query.
  //
  // `postingId` narrows to one row. Without it, "refresh this posting" from the UI
  // checked whichever rows the unordered query happened to return, then reported the
  // result as though it were about the requested one.
  //
  // And the batch case now only considers OPEN postings. This pass can only ever close
  // something, so an already-closed row spends a slot from the limit and can never change
  // state — it was starving the open postings the check exists for.
  const candidates = db
    .select({ id: schema.jobPosting.id, url: schema.jobPosting.canonicalUrl })
    .from(schema.jobPosting)
    .where(
      opts.postingId
        ? eq(schema.jobPosting.id, opts.postingId)
        : eq(schema.jobPosting.isOpen, true),
    )
    // Oldest first. Unordered, which rows got checked was down to whatever SQLite
    // returned, so with more postings than the limit the same arbitrary subset could be
    // rechecked run after run while others were never looked at again.
    .orderBy(asc(schema.jobPosting.lastSeenAt))
    .limit(opts.postingId ? 1 : (opts.limit ?? 50))
    .all();

  for (const c of candidates) {
    summary.checked++;
    try {
      await politeFetch(c.url, { rps: 1, timeoutMs: 12_000 });
      db.update(schema.jobPosting)
        .set({ lastSeenAt: now.toISOString() })
        .where(eq(schema.jobPosting.id, c.id))
        .run();
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) {
        db.update(schema.jobPosting)
          .set({ isOpen: false })
          .where(eq(schema.jobPosting.id, c.id))
          .run();
        summary.closedByFetch++;
      } else {
        summary.errors++;
        logger.debug({ err, url: c.url }, 'refresh check failed; leaving posting open');
      }
    }
  }

  return summary;
}
