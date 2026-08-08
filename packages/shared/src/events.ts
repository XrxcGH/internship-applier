import { z } from 'zod';

/**
 * Events pushed to the UI over SSE at GET /api/events.
 * Each carries a monotonic `seq` so a reconnecting client can detect gaps.
 *
 * Three of the members below have no publisher anywhere in the server and are marked
 * individually. Belonging to this union is not a promise that the event ever arrives, so
 * whoever wires up the first stream consumer should read the notes before waiting on one.
 *
 * The same goes one level down, which is where it was once being missed: a value inside a
 * built event's enum can be just as unreachable as a whole event type — `fill.needs_input`
 * carried a third `unknown_field` reason that no code path emitted until it was removed.
 * Anything here without a producer gets a note, whether it is a member of this union or a
 * member of an enum inside one.
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
    /**
     * How many of `found` had not been seen before, or null when that is not knowable yet.
     *
     * A run fetches every source first and writes to the database once, at the end, so at the
     * moment this event fires for a source there is no answer to "how many of these are new?"
     * — nothing has been compared against the stored postings yet. While the only permitted
     * value was an integer, the one thing a publisher could put here was 0, and a screen
     * counting new postings as the run went along would have read zero for the whole run and
     * then jumped to the real total when `discovery.done` arrived, with nothing to tell that
     * apart from a search that genuinely turned up nothing it had not seen before.
     *
     * The rule, for any count added here later: a number that is not known at the moment the
     * event fires is nullable. Zero has to keep meaning zero, or every consumer has to guess
     * which of the two it is looking at. The true per-source totals live on `discovery.done`,
     * which is where a consumer should read them until a publisher sends a real number here.
     */
    new: z.number().int().nullable(),
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
    /**
     * The two reasons a run stops and hands the browser back: a login wall and a bot check.
     * There is no third. A field the classifier cannot place is skipped and reported in the
     * review, not a reason to halt.
     *
     * `unknown_field` was once listed here as a third reason with no producer. It mattered to
     * remove it, because the one screen reading this treats "not login" as "bot check":
     * FillReview renders every other reason as "Bot check." with a button saying the user has
     * dealt with it. A run halted on `unknown_field` would have told the user to go solve a
     * challenge that is not on the page. The server's `InterventionReason` dropped it, so it
     * is gone here too — the enum only names reasons a code path can actually emit.
     */
    reason: z.enum(['login', 'captcha']),
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
