import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, sql } from 'drizzle-orm';
import { db, schema } from '../infra/db/client';
import { isProfileConfirmed } from '../core/profile/repository';
import { postingStats, runDiscovery, type DiscoveryTarget } from '../core/discovery/run';
import { resolveCompany } from '../core/discovery/resolveCompany';

const RunBody = z.object({
  targets: z
    .array(
      z.object({
        source: z.enum(['greenhouse', 'lever', 'ashby']),
        board: z.string().min(1),
      }),
    )
    .min(1)
    .max(200),
});

const ResolveBody = z.object({ name: z.string().min(1) });

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
