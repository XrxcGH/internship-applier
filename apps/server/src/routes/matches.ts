import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { db, schema } from '../infra/db/client';
import { isProfileConfirmed } from '../core/profile/repository';
import { runMatching } from '../core/matching/run';

const ListQuery = z.object({
  eligibility: z.enum(['eligible', 'eligible_and_unknown', 'all']).default('eligible_and_unknown'),
  minScore: z.coerce.number().min(0).max(100).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  hideDecided: z.coerce.boolean().default(true),
});

const DecisionBody = z.object({
  action: z.enum(['approved', 'skipped', 'rejected', 'saved']),
  reason: z.string().optional(),
  reasonTags: z.array(z.string()).default([]),
});

export async function matchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/matches')) return;
    if (!isProfileConfirmed()) {
      return reply.code(409).send({
        error: {
          code: 'PROFILE_NOT_CONFIRMED',
          message: 'Confirm your profile first (gate G1).',
        },
      });
    }
  });

  app.post('/api/matches/recompute', async (req, reply) => {
    const body = z
      .object({ reextract: z.boolean().default(false), useModel: z.boolean().default(true) })
      .parse(req.body ?? {});
    try {
      return await runMatching(body);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      return reply
        .code(code === 'PROFILE_NOT_CONFIRMED' ? 409 : 500)
        .send({ error: { code: code ?? 'INTERNAL', message: (err as Error).message } });
    }
  });

  app.get('/api/matches', async (req) => {
    const q = ListQuery.parse(req.query ?? {});

    const bands =
      q.eligibility === 'all'
        ? ['eligible', 'unknown', 'ineligible']
        : q.eligibility === 'eligible'
          ? ['eligible']
          : ['eligible', 'unknown'];

    const decided = q.hideDecided
      ? db
          .select({ matchId: schema.decision.matchId })
          .from(schema.decision)
          .all()
          .map((d) => d.matchId)
      : [];

    const rows = db
      .select({
        id: schema.match.id,
        eligibility: schema.match.eligibility,
        score: schema.match.score,
        rationale: schema.match.rationale,
        breakdown: schema.match.breakdown,
        blockers: schema.match.blockers,
        postingId: schema.jobPosting.id,
        company: schema.jobPosting.company,
        title: schema.jobPosting.title,
        applyUrl: schema.jobPosting.applyUrl,
        canonicalUrl: schema.jobPosting.canonicalUrl,
        locations: schema.jobPosting.locations,
        positionType: schema.jobPosting.positionType,
        workArrangement: schema.jobPosting.workArrangement,
        term: schema.jobPosting.term,
        compensation: schema.jobPosting.compensation,
        closesAt: schema.jobPosting.closesAt,
        atsVendor: schema.jobPosting.atsVendor,
      })
      .from(schema.match)
      .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
      .where(
        and(
          inArray(schema.match.eligibility, bands),
          gte(schema.match.score, q.minScore),
          decided.length > 0 ? sql`${schema.match.id} NOT IN ${decided}` : undefined,
        ),
      )
      .orderBy(desc(schema.match.score))
      .limit(q.limit)
      .offset(q.offset)
      .all();

    const counts = db
      .select({ eligibility: schema.match.eligibility, n: sql<number>`count(*)` })
      .from(schema.match)
      .groupBy(schema.match.eligibility)
      .all();

    return {
      matches: rows,
      counts: Object.fromEntries(counts.map((c) => [c.eligibility, c.n])),
    };
  });

  /** Full detail: every rule with its verbatim JD quote. This is the trust surface. */
  app.get<{ Params: { id: string } }>('/api/matches/:id', async (req, reply) => {
    const rows = db
      .select()
      .from(schema.match)
      .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
      .where(eq(schema.match.id, req.params.id))
      .all();

    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such match.' } });
    }

    const requirements = db
      .select()
      .from(schema.jobRequirement)
      .where(eq(schema.jobRequirement.postingId, row.job_posting.id))
      .all();

    const decision = db
      .select()
      .from(schema.decision)
      .where(eq(schema.decision.matchId, row.match.id))
      .all()[0];

    return {
      match: row.match,
      posting: row.job_posting,
      requirements: requirements.map((r) => ({ ...r, confidence: r.confidence / 100 })),
      decision: decision ?? null,
    };
  });

  /**
   * Gate G2. `approved` creates an application record; it does NOT submit anything and
   * does not draft anything on its own.
   */
  app.post<{ Params: { id: string } }>('/api/matches/:id/decision', async (req, reply) => {
    const parsed = DecisionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'Expected { action, reason?, reasonTags? }.' },
      });
    }

    const matchRows = db
      .select()
      .from(schema.match)
      .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
      .where(eq(schema.match.id, req.params.id))
      .all();
    const row = matchRows[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such match.' } });
    }

    db.delete(schema.decision).where(eq(schema.decision.matchId, req.params.id)).run();
    db.insert(schema.decision)
      .values({
        id: ulid(),
        matchId: req.params.id,
        action: parsed.data.action,
        reason: parsed.data.reason ?? null,
        reasonTags: parsed.data.reasonTags,
      })
      .run();

    if (parsed.data.action !== 'approved') {
      return { action: parsed.data.action, applicationId: null };
    }

    const existing = db
      .select({ id: schema.application.id })
      .from(schema.application)
      .where(eq(schema.application.matchId, req.params.id))
      .all();

    if (existing[0]) return { action: 'approved', applicationId: existing[0].id };

    const applicationId = ulid();
    db.insert(schema.application)
      .values({
        id: applicationId,
        matchId: req.params.id,
        status: 'draft',
        applyUrl: row.job_posting.applyUrl,
        atsVendor: row.job_posting.atsVendor,
        deadlineAt: row.job_posting.closesAt,
      })
      .run();

    db.insert(schema.applicationEvent)
      .values({
        id: ulid(),
        applicationId,
        type: 'created',
        payload: { via: 'gate_g2', company: row.job_posting.company, title: row.job_posting.title },
      })
      .run();

    return { action: 'approved', applicationId };
  });
}
