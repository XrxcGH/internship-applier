import { z } from 'zod';

export const SourceKind = z.enum([
  'greenhouse',
  'lever',
  'ashby',
  'smartrecruiters',
  'workable',
  'usajobs',
  'adzuna',
  'arbeitnow',
  'remotive',
  'github_list',
  'web_search',
  'manual',
]);

export const AtsVendor = z.enum([
  'greenhouse',
  'lever',
  'ashby',
  'workday',
  'smartrecruiters',
  'icims',
  'taleo',
  'workable',
  'unknown',
]);

export const JobLocation = z.object({
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  remote: z.boolean().default(false),
});

export const JobTerm = z.object({
  season: z.enum(['summer', 'fall', 'winter', 'spring', 'year_round', 'unknown']),
  year: z.number().int().nullable(),
  start: z.string().optional(),
  end: z.string().optional(),
});

export const ApplyEffort = z.object({
  steps: z.number().int().nonnegative(),
  essayCount: z.number().int().nonnegative(),
  requiresAccount: z.boolean(),
  estMinutes: z.number().int().nonnegative(),
});

export const JobPosting = z.object({
  id: z.string(),
  sourceIds: z.array(z.string()).min(1),
  externalId: z.string().nullable(),
  canonicalUrl: z.string().url(),
  applyUrl: z.string().url(),
  company: z.string(),
  companyDomain: z.string().nullable(),
  title: z.string(),
  descriptionText: z.string(),
  locations: z.array(JobLocation).default([]),
  employmentType: z.enum(['internship', 'co_op', 'fellowship', 'part_time', 'other']),
  term: JobTerm,
  compensation: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      currency: z.string().optional(),
      period: z.enum(['hour', 'week', 'month', 'year', 'total']).optional(),
      raw: z.string().optional(),
    })
    .nullable()
    .default(null),
  postedAt: z.string().datetime().nullable(),
  closesAt: z.string().datetime().nullable(),
  isOpen: z.boolean(),
  atsVendor: AtsVendor,
  applyEffort: ApplyEffort.nullable().default(null),
  fingerprint: z.string(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});

export const RequirementKind = z.enum([
  'age',
  'education_level',
  'graduation_window',
  'enrollment',
  'work_auth',
  'citizenship',
  'location',
  'term_dates',
  'experience_years',
  'skill',
  'other',
]);

export const JobRequirement = z.object({
  id: z.string(),
  postingId: z.string(),
  kind: RequirementKind,
  operator: z.enum(['min', 'max', 'equals', 'one_of', 'between', 'present']),
  value: z.unknown(),
  necessity: z.enum(['required', 'preferred', 'unclear']),
  /**
   * Verbatim text from the job description. Every pass/fail shown in the UI cites this.
   * Verified to actually appear in the description before the row is persisted — a
   * hallucinated requirement could wrongly disqualify the user.
   */
  sourceQuote: z.string(),
  confidence: z.number().min(0).max(1),
});

export const RuleResult = z.object({
  rule: z.string(),
  status: z.enum(['pass', 'fail', 'unknown', 'not_applicable']),
  because: z.string(),
  requirementId: z.string().optional(),
  profileRef: z.string().optional(),
});

export const ScoreBreakdown = z.object({
  requiredSkillCoverage: z.number(),
  preferredSkillCoverage: z.number(),
  roleAlignment: z.number(),
  domainMatch: z.number(),
  seniorityFit: z.number(),
  locationDesirability: z.number(),
  compensation: z.number(),
  applyEffort: z.number(),
});

export const Match = z.object({
  id: z.string(),
  postingId: z.string(),
  profileId: z.string(),
  /** Tri-state. `unknown` is surfaced to the user, never silently dropped. */
  eligibility: z.enum(['eligible', 'ineligible', 'unknown']),
  rules: z.array(RuleResult),
  blockers: z.array(RuleResult),
  score: z.number().min(0).max(100),
  breakdown: ScoreBreakdown,
  /** Includes the honest downside — the most likely reason for rejection. */
  rationale: z.string(),
  computedAt: z.string().datetime(),
});

export type SourceKind = z.infer<typeof SourceKind>;
export type AtsVendor = z.infer<typeof AtsVendor>;
export type JobPosting = z.infer<typeof JobPosting>;
export type JobRequirement = z.infer<typeof JobRequirement>;
export type RuleResult = z.infer<typeof RuleResult>;
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;
export type Match = z.infer<typeof Match>;
