/**
 * Discovery orchestration — docs/04 § Pipeline.
 *
 * Every run produces a summary the UI shows: per source, what was fetched, what was new,
 * what was merged, and what failed. Silent truncation would read as "we searched
 * everywhere" when we didn't, which is the failure mode that makes an automated search
 * tool untrustworthy — so degradation is always reported.
 */
import { desc, eq, or, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { db, schema } from '../../infra/db/client';
import { logger } from '../../infra/logger';
import { publish } from '../../infra/events';
import { ATS_SOURCES } from './sources/ats';
import { AGGREGATOR_SOURCES } from './sources/aggregators';
import { dedupe } from './dedupe';
import { fingerprint } from './dedupe';
import type { JobSource, NormalizedPosting } from './sources/types';

/** Every source the runner knows about, keyless and keyed alike. */
export const ALL_SOURCES: Record<string, JobSource> = {
  ...ATS_SOURCES,
  ...AGGREGATOR_SOURCES,
};

export type SourceName = keyof typeof ALL_SOURCES;

export interface DiscoveryTarget {
  source: string;
  /** Board slug for ATS sources; a repo for github_list; unused for aggregators. */
  board: string;
  keywords?: string[];
  location?: string;
}

export interface SourceReport {
  source: string;
  board: string;
  found: number;
  new: number;
  errors: string[];
  notes: string[];
  degraded: boolean;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  targets: number;
  found: number;
  new: number;
  duplicates: number;
  bySource: SourceReport[];
  /** Populated whenever coverage was reduced. Never left implicit. */
  skipped: string[];
}

export async function runDiscovery(
  targets: DiscoveryTarget[],
  opts: { concurrency?: number } = {},
): Promise<RunSummary> {
  const runId = ulid();
  const startedAt = new Date().toISOString();
  const reports: SourceReport[] = [];
  const collected: Array<{ posting: NormalizedPosting; source: string }> = [];
  const skipped: string[] = [];

  const limit = opts.concurrency ?? 4;
  const queue = [...targets];

  async function worker(): Promise<void> {
    for (;;) {
      const target = queue.shift();
      if (!target) return;

      const adapter = ALL_SOURCES[target.source];
      const report: SourceReport = {
        source: target.source,
        board: target.board,
        found: 0,
        new: 0,
        errors: [],
        notes: [],
        degraded: false,
      };

      if (!adapter) {
        report.errors.push(`unknown source "${target.source}"`);
        report.degraded = true;
        skipped.push(`${target.source}/${target.board}: unknown source`);
        reports.push(report);
        publish({
          type: 'discovery.source_failed',
          runId,
          source: target.source,
          error: 'unknown source',
        });
        continue;
      }

      // A keyed source with no key is a real coverage gap and is reported as one.
      if (adapter.requiresKey && !adapter.isConfigured()) {
        const result = await adapter.fetch({ board: target.board });
        report.notes = result.notes;
        report.degraded = true;
        skipped.push(...result.notes);
        reports.push(report);
        continue;
      }

      try {
        const result = await adapter.fetch({
          board: target.board,
          keywords: target.keywords,
          location: target.location,
        });
        report.found = result.postings.length;
        report.notes = [...result.notes, ...(result.gaps ?? [])];
        // A source that came back short says so here. Without this a run that stopped at
        // the first page of a paginated source, or dropped rows it could not read, was
        // reported to the user as a complete search of that source.
        if (result.gaps?.length) {
          report.degraded = true;
          skipped.push(...result.gaps);
        }
        for (const p of result.postings) {
          collected.push({ posting: p, source: `${target.source}:${target.board}` });
        }
        publish({
          type: 'discovery.progress',
          runId,
          source: `${target.source}:${target.board}`,
          found: result.postings.length,
          new: 0,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.errors.push(message);
        report.degraded = true;
        skipped.push(`${target.source}/${target.board}: ${message}`);
        logger.warn({ err, target }, 'discovery source failed');
        publish({
          type: 'discovery.source_failed',
          runId,
          source: `${target.source}:${target.board}`,
          error: message,
        });
      }

      reports.push(report);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, targets.length || 1) }, worker));

  const { unique, duplicates } = dedupe(collected);
  const inserted = persist(unique);

  for (const r of reports) {
    r.new = inserted.perSource.get(`${r.source}:${r.board}`) ?? 0;
  }

  const summary: RunSummary = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    targets: targets.length,
    found: collected.length,
    new: inserted.total,
    duplicates,
    bySource: reports,
    skipped,
  };

  logger.info(
    { runId, found: summary.found, new: summary.new, duplicates, skipped: skipped.length },
    'discovery run complete',
  );

  publish({
    type: 'discovery.done',
    runId,
    summary: {
      sources: targets.length,
      found: summary.found,
      new: summary.new,
      duplicates,
      errors: reports.filter((r) => r.errors.length > 0).length,
      skipped,
    },
  });

  persistRun(summary);
  return summary;
}

/** Run summaries are kept so `GET /api/discovery/runs/:id` can answer after the fact. */
function persistRun(summary: RunSummary): void {
  db.insert(schema.task)
    .values({
      id: summary.runId,
      kind: 'discovery_run',
      payload: summary,
      status: 'done',
      finishedAt: summary.finishedAt,
    })
    .run();
}

export function getRun(runId: string): RunSummary | null {
  const row = db.select().from(schema.task).where(eq(schema.task.id, runId)).all()[0];
  return row && row.kind === 'discovery_run' ? (row.payload as RunSummary) : null;
}

export function listRuns(limit = 20): RunSummary[] {
  return db
    .select()
    .from(schema.task)
    .where(eq(schema.task.kind, 'discovery_run'))
    .orderBy(desc(schema.task.createdAt))
    .limit(limit)
    .all()
    .map((r) => r.payload as RunSummary);
}

/** Adds a manually-pasted posting (docs/04 § Tier C). Returns its id. */
export function saveManualPosting(posting: NormalizedPosting): string {
  const { unique } = dedupe([{ posting, source: 'manual:pasted' }]);
  // The id comes back from persist rather than a second lookup by URL. Now that
  // persistence also matches on fingerprint, a pasted posting can merge into a row that
  // was discovered under a different URL — and a URL lookup would find nothing and return
  // an empty id for a posting that was saved perfectly well.
  return persist(unique).ids[0] ?? '';
}

interface PersistResult {
  total: number;
  perSource: Map<string, number>;
  /** The row id each entry ended up in, new or matched, in the order given. */
  ids: string[];
}

function persist(unique: ReturnType<typeof dedupe>['unique']): PersistResult {
  const perSource = new Map<string, number>();
  const ids: string[] = [];
  let total = 0;

  for (const entry of unique) {
    const p = entry.posting;
    const fp = fingerprint(p);

    /**
     * Cross-run matching, which used to be stage 1 only.
     *
     * dedupe() applies all three stages WITHIN a run, but persistence compared against
     * the database by canonical URL alone — so the same job found on Greenhouse in one
     * run and Adzuna in the next was stored twice, each copy with its own match row and
     * its own G2 decision to make. The fingerprint column and its index were written on
     * every insert and read by nothing.
     *
     * The fingerprint (company + normalized title + primary city) is the same stage-2
     * key, so this is the existing rule applied across runs rather than a new one.
     */
    const existing = db
      .select({ id: schema.jobPosting.id })
      .from(schema.jobPosting)
      .where(
        or(
          eq(schema.jobPosting.canonicalUrl, p.canonicalUrl),
          eq(schema.jobPosting.fingerprint, fp),
        ),
      )
      .all();

    const now = new Date().toISOString();

    if (existing[0]) {
      db.update(schema.jobPosting)
        // The fingerprint is rewritten, not just the timestamps. Its definition became more
        // cautious — it used to erase the tokens that tell "Intern I" from "Intern II" —
        // and rows stored under the old key would otherwise keep matching two distinct
        // requisitions onto one row forever. Recomputing on every sighting means the table
        // heals itself as postings are seen again, with no data migration to get wrong.
        .set({ lastSeenAt: now, isOpen: true, fingerprint: fp })
        .where(eq(schema.jobPosting.id, existing[0].id))
        .run();
      linkSources(existing[0].id, entry.sources, p.externalId);
      ids.push(existing[0].id);
      continue;
    }

    const id = ulid();
    db.insert(schema.jobPosting)
      .values({
        id,
        externalId: p.externalId,
        canonicalUrl: p.canonicalUrl,
        applyUrl: p.applyUrl,
        company: p.company,
        companyDomain: p.companyDomain,
        title: p.title,
        descriptionHtml: p.descriptionHtml,
        descriptionText: p.descriptionText,
        locations: p.locations,
        positionType: p.positionType,
        workArrangement: p.workArrangement,
        hybridDaysOnsite: p.hybridDaysOnsite,
        remoteEligibleIn: p.remoteEligibleIn,
        programFlags: p.programFlags,
        term: p.term,
        compensation: p.compensation,
        requires: p.requires,
        postedAt: p.postedAt,
        closesAt: p.closesAt,
        isOpen: true,
        atsVendor: p.atsVendor,
        fingerprint: fp,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();

    linkSources(id, entry.sources, p.externalId);
    ids.push(id);
    total++;
    for (const s of entry.sources) perSource.set(s, (perSource.get(s) ?? 0) + 1);
  }

  return { total, perSource, ids };
}

/** Provenance: a merged posting keeps every source that saw it. */
function linkSources(postingId: string, sources: string[], externalId: string | null): void {
  for (const s of sources) {
    const sourceId = ensureSource(s);
    db.insert(schema.jobPostingSource)
      .values({ postingId, sourceId, externalId })
      .onConflictDoNothing()
      .run();
  }
}

/**
 * The source row for a label, looked up every time on purpose.
 *
 * This used to memoise label → row id in a module-level Map that nothing ever cleared. "Delete
 * everything" in Settings truncates the source table, and foreign keys are on — so the first
 * discovery run after a delete handed the job_posting_source insert an id for a row that no
 * longer existed and the whole run died on "FOREIGN KEY constraint failed". The user saw a 500
 * from a search, or a 502 saying "Could not read that URL" about a URL that had been fetched
 * and parsed perfectly, and it happened on every run until someone restarted the process. The
 * delete reply says "Restart the app to begin again", but that is advice and the app keeps
 * running.
 *
 * The lookup it replaces is one indexed hit on a table with a handful of rows, a few times per
 * run. Cached state that outlives the database it describes is not worth that.
 */
function ensureSource(label: string): string {
  const kind = label.split(':')[0] ?? 'manual';
  const rows = db
    .select({ id: schema.source.id })
    .from(schema.source)
    .where(eq(schema.source.label, label))
    .all();

  const id = rows[0]?.id ?? ulid();
  if (!rows[0]) {
    db.insert(schema.source).values({ id, kind, label, enabled: true }).run();
  }
  return id;
}

/** Counts for the dashboard. */
export function postingStats(): { total: number; open: number } {
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.jobPosting)
      .all()[0]?.n ?? 0;
  const open =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.jobPosting)
      .where(eq(schema.jobPosting.isOpen, true))
      .all()[0]?.n ?? 0;
  return { total, open };
}
