import { z } from 'zod';

/**
 * Events pushed to the UI over SSE at GET /api/events.
 * Each carries a monotonic `seq` so a reconnecting client can detect gaps.
 */
export const AppEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('extraction.progress'),
    seq: z.number().int(),
    documentId: z.string(),
    stage: z.string(),
    pct: z.number().min(0).max(100),
  }),
  z.object({
    type: z.literal('discovery.progress'),
    seq: z.number().int(),
    runId: z.string(),
    source: z.string(),
    found: z.number().int(),
    new: z.number().int(),
  }),
  z.object({
    type: z.literal('discovery.source_failed'),
    seq: z.number().int(),
    runId: z.string(),
    source: z.string(),
    error: z.string(),
  }),
  z.object({
    type: z.literal('discovery.done'),
    seq: z.number().int(),
    runId: z.string(),
    summary: z.object({
      sources: z.number().int(),
      found: z.number().int(),
      new: z.number().int(),
      duplicates: z.number().int(),
      errors: z.number().int(),
      /** Anything dropped or rate-limited is reported explicitly, never silently. */
      skipped: z.array(z.string()),
    }),
  }),
  z.object({
    type: z.literal('match.new'),
    seq: z.number().int(),
    matchId: z.string(),
    score: z.number(),
  }),
  z.object({
    type: z.literal('draft.progress'),
    seq: z.number().int(),
    applicationId: z.string(),
    questionId: z.string(),
    stage: z.enum(['retrieve', 'generate', 'factguard', 'style', 'done']),
  }),
  z.object({
    type: z.literal('fill.step'),
    seq: z.number().int(),
    applicationId: z.string(),
    field: z.string(),
    status: z.enum(['ok', 'skipped', 'failed']),
    note: z.string().optional(),
  }),
  z.object({
    type: z.literal('fill.needs_input'),
    seq: z.number().int(),
    applicationId: z.string(),
    reason: z.enum(['login', 'captcha', 'unknown_field']),
    detail: z.string(),
  }),
  z.object({
    type: z.literal('fill.done'),
    seq: z.number().int(),
    applicationId: z.string(),
    filled: z.number().int(),
    skipped: z.number().int(),
  }),
  z.object({
    type: z.literal('task.failed'),
    seq: z.number().int(),
    taskId: z.string(),
    kind: z.string(),
    error: z.string(),
  }),
]);

export type AppEvent = z.infer<typeof AppEvent>;
export type AppEventType = AppEvent['type'];
