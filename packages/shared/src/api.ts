import { z } from 'zod';

/** Consistent error envelope for every endpoint. */
export const ApiErrorCode = z.enum([
  'PROFILE_NOT_CONFIRMED',
  'PROFILE_INCOMPLETE',
  'ANSWERS_NOT_APPROVED',
  'UNRESOLVED_FLAGS',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'SOURCE_UNAVAILABLE',
  'BROWSER_UNAVAILABLE',
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
  /** Gate G1. While false, all feature endpoints reject with PROFILE_NOT_CONFIRMED. */
  profileConfirmed: z.boolean(),
  time: z.string().datetime(),
});

/**
 * Gate G4 (docs/07-form-automation.md). This is the ONLY payload that may result in
 * `application.submittedAt` being written, and it requires the user to confirm they
 * clicked Submit themselves. There is deliberately no endpoint that submits for them.
 */
export const MarkSubmittedRequest = z.object({
  confirmed: z.literal(true),
  note: z.string().optional(),
});

export type ApiErrorCode = z.infer<typeof ApiErrorCode>;
export type ApiError = z.infer<typeof ApiError>;
export type HealthResponse = z.infer<typeof HealthResponse>;
export type MarkSubmittedRequest = z.infer<typeof MarkSubmittedRequest>;
