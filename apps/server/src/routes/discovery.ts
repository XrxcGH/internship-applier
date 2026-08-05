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

export async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Gate G1: discovery is meaningless against an unconfirmed profile, since eligibility
   * would have nothing to check against.
   */
  app.addHook('onRequest', async (req, reply) => {
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

    const body = z.object({ filters: SearchFilters.optional() }).parse(req.body ?? {});
    const filters = body.filters ?? DEFAULT_FILTERS;

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

    return planQueries(profile as ConfirmedProfile, filters, knownBoards);
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

  app.post('/api/discovery/refresh', async (req) => {
    const body = z
      .object({
        checkUrls: z.boolean().default(false),
        limit: z.number().int().max(200).default(50),
      })
      .parse(req.body ?? {});
    return refreshPostings(body);
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
    db.update(schema.source)
      .set({ enabled: body.data.enabled })
      .where(eq(schema.source.id, req.params.id))
      .run();
    return { id: req.params.id, enabled: body.data.enabled };
  });

  app.get('/api/postings', async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query ?? {});

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
      .limit(q.limit)
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
