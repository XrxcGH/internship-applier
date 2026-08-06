/**
 * Freshness — docs/04 § Freshness.
 *
 * Nothing is ever hard-deleted. A closed posting stays in the database so the tracker,
 * the application history, and the stats all remain intact; it is only marked closed.
 */
import { and, asc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { db, schema } from '../../infra/db/client';
import { HttpError, politeFetch, scrubUrl } from '../../infra/http/fetcher';
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

  // Every stage is scoped when a single posting was asked for. Stages 1 and 2 used to run
  // over the whole table regardless, so "refresh this one posting" quietly re-evaluated and
  // closed every other row in the database, then reported the result as though it were
  // about the requested one.
  const onlyRequested = opts.postingId ? eq(schema.jobPosting.id, opts.postingId) : undefined;

  // 1. Deadline in the past — pure data, no network needed.
  //
  // A closing date with no time means the whole of that day, not its first instant. Feeds
  // hand over bare dates ("2026-08-05"), and a bare date sorts before every timestamp on
  // that day, so a posting flipped to closed at 00:00 UTC on its own deadline — for a US
  // Pacific user, from 17:00 the evening before. The user was then told "This posting is no
  // longer open" on the last and most urgent day they could still apply, in the same rule
  // list where the deadline rule said "Closes 2026-08-05", because that rule already reads a
  // bare date as end of day. Pad here so the two agree.
  const closesAtEndOfDay = sql`(CASE WHEN length(${schema.jobPosting.closesAt}) = 10 THEN ${schema.jobPosting.closesAt} || 'T23:59:59.999Z' ELSE ${schema.jobPosting.closesAt} END)`;
  const expired = db
    .update(schema.jobPosting)
    .set({ isOpen: false })
    .where(
      and(
        eq(schema.jobPosting.isOpen, true),
        isNotNull(schema.jobPosting.closesAt),
        sql`${closesAtEndOfDay} < ${now.toISOString()}`,
        onlyRequested,
      ),
    )
    .run();
  summary.closedByDeadline = expired.changes;

  // 2. Not seen in a long time.
  const staleCutoff = new Date(now.getTime() - STALE_DAYS * 86_400_000).toISOString();
  const stale = db
    .update(schema.jobPosting)
    .set({ isOpen: false })
    .where(
      and(
        eq(schema.jobPosting.isOpen, true),
        lt(schema.jobPosting.lastSeenAt, staleCutoff),
        onlyRequested,
      ),
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
    .where(onlyRequested ?? eq(schema.jobPosting.isOpen, true))
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
        logger.debug({ err, url: scrubUrl(c.url) }, 'refresh check failed; leaving posting open');
      }
    }
  }

  return summary;
}
