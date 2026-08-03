/**
 * Per-kind schemas for `job_requirement.value` — docs/05 § Stage 0.
 *
 * The extractor returns `value` as unknown JSON. It is re-validated here after parsing,
 * and anything that fails becomes `kind: 'other'` with `necessity: 'unclear'`, which
 * routes to `unknown` rather than to a rejection. A malformed requirement must never
 * disqualify the user.
 */
import { z } from 'zod';

export const AgeValue = z.object({ min: z.number().int().min(0).max(99) });

export const EducationLevelValue = z.object({
  levels: z
    .array(z.enum(['high_school', 'associate', 'bachelor', 'master', 'doctorate', 'any']))
    .min(1),
});

export const GraduationWindowValue = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});

export const EnrollmentValue = z.object({ required: z.boolean() });

export const WorkAuthValue = z.object({
  /** True when the posting says it will not sponsor. */
  sponsorshipUnavailable: z.boolean().optional(),
  requiresExistingAuthorization: z.boolean().optional(),
});

export const CitizenshipValue = z.object({
  countries: z.array(z.string()).optional(),
  clearanceRequired: z.boolean().optional(),
});

export const LocationValue = z.object({
  cities: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  countries: z.array(z.string()).optional(),
  remoteAllowed: z.boolean().optional(),
});

export const TermDatesValue = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
});

export const ExperienceYearsValue = z.object({ min: z.number().min(0).max(50) });

export const SkillValue = z.object({ name: z.string().min(1) });

export const VALUE_SCHEMAS = {
  age: AgeValue,
  education_level: EducationLevelValue,
  graduation_window: GraduationWindowValue,
  enrollment: EnrollmentValue,
  work_auth: WorkAuthValue,
  citizenship: CitizenshipValue,
  location: LocationValue,
  term_dates: TermDatesValue,
  experience_years: ExperienceYearsValue,
  skill: SkillValue,
  other: z.unknown(),
} as const;

export type RequirementKindName = keyof typeof VALUE_SCHEMAS;

export function validateValue(
  kind: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const schema = VALUE_SCHEMAS[kind as RequirementKindName];
  if (!schema) return { ok: false, reason: `unknown requirement kind "${kind}"` };
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: parsed.error.issues.map((i) => i.message).join('; ') };
}
