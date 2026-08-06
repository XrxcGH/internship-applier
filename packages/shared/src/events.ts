import { z } from 'zod';

/**
 * Events pushed to the UI over SSE at GET /api/events.
 * Each carries a monotonic `seq` so a reconnecting client can detect gaps.
 *
 * Three of the members below have no publisher anywhere in the server and are marked
 * individually. Belonging to this union is not a promise that the event ever arrives, so
 * whoever wires up the first stream consumer should read the notes before waiting on one.
 */
export const AppEvent = z.discriminatedUnion('type', [
  z.object({
    /**
     * Not built: nothing publishes this. Resume extraction runs start to finish inside
     * POST /api/resumes/:id/extract and the finished profile comes back in that response,
     * so there is no moment in between at which progress could be announced.
     */
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
    /**
     * Not built: nothing publishes this. A matching run inserts or updates every match in
     * one loop and returns totals at the end, so a screen watching the stream learns nothing
     * about a new match until it refetches the list.
     */
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
    /**
     * The same four outcomes the fill engine produces, `mismatch` included. While this
     * vocabulary was three words wide, a read-back mismatch — the tool typed a value and the
     * page kept something else, which is the one signal that catches a silently wrong fill —
     * had to be sent as `failed`, arriving at a stream consumer indistinguishable from a
     * field that never got typed at all.
     */
    status: z.enum(['ok', 'mismatch', 'skipped', 'failed']),
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
    /**
     * Every outcome gets a home, because this is the terminal event and anything without a
     * field here simply stops existing for a consumer that only watches the stream. With
     * `filled` and `skipped` alone, a run whose values were rejected by the page on read-back
     * finished by reporting nothing but the fields that went right.
     */
    mismatched: z.number().int(),
    failed: z.number().int(),
    /** Fields deliberately left alone — never a euphemism for one that went wrong. */
    skipped: z.number().int(),
  }),
  z.object({
    /**
     * Not built: nothing publishes this. The `task` table is written in one place only, to
     * file a discovery run that has already finished, so there is no background worker whose
     * failure this would carry to the user.
     */
    type: z.literal('task.failed'),
    seq: z.number().int(),
    taskId: z.string(),
    kind: z.string(),
    error: z.string(),
  }),
]);

export type AppEvent = z.infer<typeof AppEvent>;
export type AppEventType = AppEvent['type'];
