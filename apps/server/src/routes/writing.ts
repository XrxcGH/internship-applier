import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { db, schema } from '../infra/db/client';
import { decryptField, encryptField } from '../infra/crypto/fieldCrypto';
import {
  computeStyleProfile,
  describeStyle,
  sampleAdequacy,
  words,
} from '../core/writing/styleProfile';

const SampleBody = z.object({
  kind: z.enum(['essay', 'email', 'cover_letter', 'other']).default('other'),
  content: z.string().min(20, 'A sample needs to be at least 20 characters to be useful.'),
});

function loadSamples(): Array<{ id: string; kind: string; content: string; wordCount: number }> {
  return db
    .select()
    .from(schema.writingSample)
    .orderBy(desc(schema.writingSample.createdAt))
    .all()
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      content: decryptField(r.content, r.id),
      wordCount: r.wordCount,
    }));
}

export async function writingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/writing-samples', async () => {
    const samples = loadSamples();
    const total = samples.reduce((a, s) => a + s.wordCount, 0);
    return {
      samples: samples.map((s) => ({
        id: s.id,
        kind: s.kind,
        wordCount: s.wordCount,
        preview: s.content.slice(0, 160),
      })),
      totalWords: total,
      adequacy: sampleAdequacy(total),
    };
  });

  app.post('/api/writing-samples', async (req, reply) => {
    const parsed = SampleBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: parsed.error.issues[0]?.message ?? 'Invalid sample.',
        },
      });
    }
    const id = ulid();
    db.insert(schema.writingSample)
      .values({
        id,
        kind: parsed.data.kind,
        // Samples are the user's own writing — encrypted like any other personal content.
        content: encryptField(parsed.data.content, id),
        wordCount: words(parsed.data.content).length,
      })
      .run();
    return reply.code(201).send({ id });
  });

  app.delete<{ Params: { id: string } }>('/api/writing-samples/:id', async (req, reply) => {
    db.delete(schema.writingSample).where(eq(schema.writingSample.id, req.params.id)).run();
    return reply.code(204).send();
  });

  app.post('/api/style-profile/compute', async (_req, reply) => {
    const samples = loadSamples();
    if (samples.length === 0) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Add at least one writing sample first.',
        },
      });
    }

    const metrics = computeStyleProfile(samples);
    const description = describeStyle(metrics);

    db.delete(schema.styleProfile).run();
    db.insert(schema.styleProfile)
      .values({
        id: ulid(),
        metrics,
        qualitativeNotes: description.join('\n'),
        sampleIds: metrics.sampleIds,
      })
      .run();

    return { metrics, description };
  });

  app.get('/api/style-profile', async (_req, reply) => {
    const row = db
      .select()
      .from(schema.styleProfile)
      .orderBy(desc(schema.styleProfile.computedAt))
      .all()[0];

    if (!row) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'No style profile computed yet.' },
      });
    }
    return {
      metrics: row.metrics,
      description: (row.qualitativeNotes ?? '').split('\n').filter(Boolean),
      computedAt: row.computedAt,
    };
  });
}
