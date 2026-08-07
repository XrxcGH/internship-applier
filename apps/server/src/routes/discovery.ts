import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq, sql } from 'drizzle-orm';
import { DEFAULT_FILTERS, SearchFilters, type ConfirmedProfile } from '@ia/shared';
import { db, schema } from '../infra/db/client';
import { getProfile, isProfileConfirmed } from '../core/profile/repository';
import {
  ALL_SOURCES,
  getRun,
  listRuns,
  postingStats,
  runDiscovery,
  saveManualPosting,
  type DiscoveryTarget,
} from '../core/discovery/run';
import { resolveCompany } from '../core/discovery/resolveCompany';
import { fetchManualPosting } from '../core/discovery/manualPosting';
import { refreshPostings } from '../core/discovery/refresh';
import { planQueries, type PlannedTarget } from '../core/discovery/queryPlanner';

const SOURCE_NAMES = Object.keys(ALL_SOURCES) as [string, ...string[]];

const RunBody = z.object({
  targets: z
    .array(
      z.object({
        source: z.enum(SOURCE_NAMES),
        board: z.string().default(''),
        keywords: z.array(z.string()).optional(),
        location: z.string().optional(),
      }),
    )
    .min(1)
    .max(200),
});

const ResolveBody = z.object({ name: z.string().min(1) });
const ManualBody = z.object({ url: z.string().url() });

/**
 * What `planQueries` actually reads out of a SearchFilters body.
 *
 * `positionTypes` whole, and six leaves out of the four blocks it opens at all. Everything
 * else in the shape — see the header of packages/shared/src/filters.ts — parses, validates
 * and is then dropped without a word.
 */
const READ_WHOLE = ['positionTypes'];
const PARTLY_READ = ['term', 'location', 'role', 'company'];
const READ_LEAVES = [
  'term.seasons',
  'term.years',
  'location.cities',
  'role.roleFamilies',
  'role.titleIncludes',
  'company.onlyCompanies',
];

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameValue(x, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every((k) => sameValue(x[k], y[k]));
}

/**
 * The filters this caller set that the plan then ignored.
 *
 * A body with `compensation.paidOnly` or `eligibility.excludeCitizenshipRequired` set came
 * back with exactly the plan an empty body would have produced, and nothing said so — the
 * web app sends no filters, so only an API caller met this, and they met it silently and had
 * to infer it by reading the planner. Naming them is the least this can do until the filters
 * are wired up.
 *
 * Worked out from the body rather than from a hand-written list, so a block or a leaf added
 * to SearchFilters later is reported as ignored by default. That is the safe direction: a
 * filter that is read but listed here reads as an over-warning, a filter that is dropped and
 * not listed reads as a search that quietly did not do what was asked.
 */
function ignoredFilters(filters: SearchFilters): string[] {
  const given = filters as unknown as Record<string, unknown>;
  const fallback = DEFAULT_FILTERS as unknown as Record<string, unknown>;
  const out: string[] = [];

  for (const key of Object.keys(given)) {
    if (READ_WHOLE.includes(key)) continue;

    if (PARTLY_READ.includes(key)) {
      const g = (given[key] ?? {}) as Record<string, unknown>;
      const f = (fallback[key] ?? {}) as Record<string, unknown>;
      for (const leaf of new Set([...Object.keys(g), ...Object.keys(f)])) {
        const path = `${key}.${leaf}`;
        if (READ_LEAVES.includes(path)) continue;
        if (!sameValue(g[leaf], f[leaf])) out.push(path);
      }
      continue;
    }

    if (!sameValue(given[key], fallback[key])) out.push(key);
  }

  return out;
}

export async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Gate G1: discovery is meaningless against an unconfirmed profile, since eligibility
   * would have nothing to check against.
   */
  app.addHook('onRequest', async (req, reply) => {
    // Safe to compare against a literal path because app.ts has already rewritten the
    // target to its one canonical spelling. Before it did, `POST /%61pi/discovery/run`
    // routed here, slipped past this line, and ran a complete discovery run against a
    // profile the user had never confirmed.
    if (!req.url.startsWith('/api/discovery')) return;
    if (!isProfileConfirmed()) {
      return reply.code(409).send({
        error: {
          code: 'PROFILE_NOT_CONFIRMED',
          message: 'Confirm your profile first (gate G1) — eligibility needs something to check.',
        },
      });
    }
  });

  app.post('/api/discovery/run', async (req, reply) => {
    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Expected { targets: [{ source, board }] }.',
          details: { issues: parsed.error.issues },
        },
      });
    }
    return runDiscovery(parsed.data.targets as DiscoveryTarget[]);
  });

  app.post('/api/companies/resolve', async (req, reply) => {
    const parsed = ResolveBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'Expected { name }.' } });
    }
    const matches = await resolveCompany(parsed.data.name);
    return { name: parsed.data.name, matches };
  });

  app.get('/api/discovery/stats', async () => postingStats());

  /** The editable plan — shown as chips before a run so the search isn't a black box. */
  app.post('/api/discovery/plan', async (req, reply) => {
    const profile = getProfile();
    if (!profile?.confirmedAt) {
      return reply
        .code(409)
        .send({ error: { code: 'PROFILE_NOT_CONFIRMED', message: 'Confirm your profile first.' } });
    }

    const body = z.object({ filters: SearchFilters.optional() }).safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Expected { filters }.',
          details: { issues: body.error.issues },
        },
      });
    }
    const filters = body.data.filters ?? DEFAULT_FILTERS;

    const knownBoards = db
      .select({ label: schema.source.label, kind: schema.source.kind })
      .from(schema.source)
      .where(eq(schema.source.enabled, true))
      .all()
      // Filtered on the source kind the runner actually knows, not on "the label has a
      // colon in it". Pasting a single job URL creates a `manual:pasted` source row, and
      // that heuristic turned it into a permanent plan chip for a source that does not
      // exist — which the run endpoint then rejected outright. The cast that used to sit
      // on `source` hid exactly this mismatch from the type checker.
      .filter((s) => s.label.includes(':') && s.kind in ALL_SOURCES)
      .map((s) => ({
        source: s.kind as PlannedTarget['source'],
        board: s.label.split(':')[1] ?? '',
        reason: 'already resolved from a previous run',
      }));

    const plan = planQueries(profile as ConfirmedProfile, filters, knownBoards);

    const ignored = ignoredFilters(filters);
    if (ignored.length > 0) {
      plan.notes.push(
        `The query planner does not read these filters, so they made no difference to this ` +
          `plan: ${ignored.join(', ')}. It is the plan an empty filter body would have ` +
          'produced for them.',
      );
    }

    return plan;
  });

  app.get<{ Params: { id: string } }>('/api/discovery/runs/:id', async (req, reply) => {
    const run = getRun(req.params.id);
    if (!run) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such run.' } });
    }
    return run;
  });

  app.get('/api/discovery/runs', async () => listRuns());

  /**
   * The manual path (docs/04 § Tier C). The user brings a posting from anywhere —
   * including sites this tool deliberately will not crawl.
   */
  app.post('/api/discovery/manual', async (req, reply) => {
    const parsed = ManualBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'Expected { url }.' } });
    }
    try {
      const { posting, usedJsonLd, notes } = await fetchManualPosting(parsed.data.url);
      const id = saveManualPosting(posting);
      return { postingId: id, posting, usedJsonLd, notes };
    } catch (err) {
      return reply.code(502).send({
        error: {
          code: 'SOURCE_UNAVAILABLE',
          message: `Could not read that URL: ${(err as Error).message}`,
        },
      });
    }
  });

  app.post('/api/discovery/refresh', async (req, reply) => {
    const body = z
      .object({
        checkUrls: z.boolean().default(false),
        // SQLite reads a negative LIMIT as no limit at all, so `limit: -1` inverted the
        // cap: one request went out and checked every open-or-stale posting URL in the
        // database, rate limiter and all.
        limit: z.number().int().min(1).max(200).default(50),
      })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Expected { checkUrls?, limit? }.',
          details: { issues: body.error.issues },
        },
      });
    }
    return refreshPostings(body.data);
  });

  app.post<{ Params: { id: string } }>('/api/postings/:id/refresh', async (req, reply) => {
    const row = db
      .select()
      .from(schema.jobPosting)
      .where(eq(schema.jobPosting.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such posting.' } });
    }
    const summary = await refreshPostings({ checkUrls: true, postingId: req.params.id });
    const after = db
      .select({ isOpen: schema.jobPosting.isOpen })
      .from(schema.jobPosting)
      .where(eq(schema.jobPosting.id, req.params.id))
      .all()[0];
    return { isOpen: after?.isOpen ?? row.isOpen, summary };
  });

  /** Which sources exist, whether they need a key, and whether that key is present. */
  app.get('/api/sources/available', async () =>
    Object.entries(ALL_SOURCES).map(([name, s]) => ({
      name,
      requiresKey: s.requiresKey,
      configured: s.isConfigured(),
    })),
  );

  app.put<{ Params: { id: string } }>('/api/sources/:id', async (req, reply) => {
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'Expected { enabled }.' } });
    }
    const row = db
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(eq(schema.source.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such source.' } });
    }

    db.update(schema.source)
      .set({ enabled: body.data.enabled })
      .where(eq(schema.source.id, req.params.id))
      .run();
    return { id: req.params.id, enabled: body.data.enabled };
  });

  app.get('/api/postings', async (req, reply) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .safeParse(req.query ?? {});
    if (!q.success) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'Expected a limit between 1 and 200.' },
      });
    }

    return db
      .select({
        id: schema.jobPosting.id,
        company: schema.jobPosting.company,
        title: schema.jobPosting.title,
        canonicalUrl: schema.jobPosting.canonicalUrl,
        positionType: schema.jobPosting.positionType,
        workArrangement: schema.jobPosting.workArrangement,
        term: schema.jobPosting.term,
        compensation: schema.jobPosting.compensation,
        locations: schema.jobPosting.locations,
        atsVendor: schema.jobPosting.atsVendor,
        isOpen: schema.jobPosting.isOpen,
        firstSeenAt: schema.jobPosting.firstSeenAt,
      })
      .from(schema.jobPosting)
      .orderBy(desc(schema.jobPosting.firstSeenAt))
      .limit(q.data.limit)
      .all();
  });

  app.get('/api/sources', async () => {
    return db
      .select({
        id: schema.source.id,
        kind: schema.source.kind,
        label: schema.source.label,
        enabled: schema.source.enabled,
        lastRunAt: schema.source.lastRunAt,
        postings: sql<number>`(
          SELECT count(*) FROM job_posting_source jps WHERE jps.source_id = ${schema.source.id}
        )`,
      })
      .from(schema.source)
      .all();
  });
}
