import { z } from 'zod';

/**
 * Consistent error envelope for every endpoint.
 *
 * Nothing validates a reply against this list at runtime, so it drifts quietly. It named
 * `UNRESOLVED_FLAGS` as the G3 rejection, which the approve route has never sent — it sends
 * `UNVERIFIED_CLAIMS` — so a client branching on the documented code would have sat waiting
 * for a rejection that never arrived. Every code below is one a route in apps/server/src
 * emits today; add one here in the same commit that starts emitting it.
 */
export const ApiErrorCode = z.enum([
  'PROFILE_NOT_CONFIRMED',
  'PROFILE_INCOMPLETE',
  'ANSWERS_NOT_APPROVED',
  'UNVERIFIED_CLAIMS',
  'CONFIRMATION_REQUIRED',
  'ILLEGAL_TRANSITION',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'SOURCE_UNAVAILABLE',
  'NO_MODEL_ACCESS',
  'DRAFT_FAILED',
  'FILL_FAILED',
  'NO_RUN',
  'INTERNAL',
]);

export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSeconds: z.number(),
  node: z.string(),
  db: z.object({
    connected: z.boolean(),
    tables: z.number().int(),
  }),
  /**
   * Gate G1. While false, discovery and matching reject with PROFILE_NOT_CONFIRMED, and
   * drafting and filling reject the same condition with PROFILE_INCOMPLETE. The resume,
   * profile and writing-sample endpoints stay open — they are how a profile gets confirmed
   * in the first place.
   */
  profileConfirmed: z.boolean(),
  time: z.string().datetime(),
});

/**
 * Gate G4 (docs/07-form-automation.md). The user clicks Submit on the real page and then
 * tells the tracker they did. There is deliberately no endpoint that submits for them.
 *
 * `application.submittedAt` is written only by the two user-initiated status endpoints —
 * POST /api/applications/:id/mark-submitted and POST /api/applications/:id/status when the
 * target status is `submitted` — and never by the fill engine. mark-submitted parses this
 * schema and refuses with CONFIRMATION_REQUIRED without it, so it requires the user to
 * confirm they clicked Submit themselves rather than merely inviting them to. It then
 * applies the same transition rules as /status, so an application still being prepared
 * cannot be stamped submitted at all.
 */
export const MarkSubmittedRequest = z.object({
  confirmed: z.literal(true),
  note: z.string().optional(),
});

export type ApiErrorCode = z.infer<typeof ApiErrorCode>;
export type ApiError = z.infer<typeof ApiError>;
export type HealthResponse = z.infer<typeof HealthResponse>;
export type MarkSubmittedRequest = z.infer<typeof MarkSubmittedRequest>;
