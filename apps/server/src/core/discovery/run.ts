/**
 * Discovery orchestration — docs/04 § Pipeline.
 *
 * Every run produces a summary the UI shows: per source, what was fetched, what was new,
 * what was merged, and what failed. Silent truncation would read as "we searched
 * everywhere" when we didn't, which is the failure mode that makes an automated search
 * tool untrustworthy — so degradation is always reported.
 */
import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { db, schema } from '../../infra/db/client';
import { logger } from '../../infra/logger';
import { ATS_SOURCES, type AtsSourceName } from './sources/ats';
import { dedupe } from './dedupe';
import { fingerprint } from './dedupe';
import type { NormalizedPosting } from './sources/types';

export interface DiscoveryTarget {
  source: AtsSourceName;
  board: string;
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

      const adapter = ATS_SOURCES[target.source];
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
        continue;
      }

      try {
        const result = await adapter.fetch({ board: target.board });
        report.found = result.postings.length;
        report.notes = result.notes;
        for (const p of result.postings) {
          collected.push({ posting: p, source: `${target.source}:${target.board}` });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.errors.push(message);
        report.degraded = true;
        skipped.push(`${target.source}/${target.board}: ${message}`);
        logger.warn({ err, target }, 'discovery source failed');
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
  return summary;
}

interface PersistResult {
  total: number;
  perSource: Map<string, number>;
}

function persist(unique: ReturnType<typeof dedupe>['unique']): PersistResult {
  const perSource = new Map<string, number>();
  let total = 0;

  for (const entry of unique) {
    const p = entry.posting;
    const existing = db
      .select({ id: schema.jobPosting.id })
      .from(schema.jobPosting)
      .where(eq(schema.jobPosting.canonicalUrl, p.canonicalUrl))
      .all();

    const now = new Date().toISOString();

    if (existing[0]) {
      db.update(schema.jobPosting)
        .set({ lastSeenAt: now, isOpen: true })
        .where(eq(schema.jobPosting.id, existing[0].id))
        .run();
      linkSources(existing[0].id, entry.sources, p.externalId);
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
        fingerprint: fingerprint(p),
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();

    linkSources(id, entry.sources, p.externalId);
    total++;
    for (const s of entry.sources) perSource.set(s, (perSource.get(s) ?? 0) + 1);
  }

  return { total, perSource };
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

const sourceIds = new Map<string, string>();

function ensureSource(label: string): string {
  const cached = sourceIds.get(label);
  if (cached) return cached;

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
  sourceIds.set(label, id);
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
