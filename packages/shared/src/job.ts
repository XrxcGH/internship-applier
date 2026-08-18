import { z } from 'zod';
import { PositionType, ProgramFlag, Season, WorkArrangement } from './filters';

export const SourceKind = z.enum([
  'greenhouse',
  'lever',
  'ashby',
  'workday',
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
  /** `null` means the parser couldn't tell. Badged in the UI, never silently filtered. */
  season: Season.nullable(),
  year: z.number().int().nullable(),
  start: z.string().optional(),
  end: z.string().optional(),
  durationWeeks: z.number().int().positive().nullable().default(null),
  /** Co-ops and rotational programs spanning more than one academic term. */
  multiTerm: z.boolean().default(false),
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
  /** `null` when the posting doesn't say — treated as unknown, never as a mismatch. */
  positionType: PositionType.nullable(),
  workArrangement: WorkArrangement.nullable(),
  hybridDaysOnsite: z.number().int().nonnegative().nullable().default(null),
  /** States/countries a remote posting restricts you to, if any. */
  remoteEligibleIn: z.array(z.string()).default([]),
  programFlags: z.array(ProgramFlag).default([]),
  term: JobTerm,
  compensation: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      currency: z.string().optional(),
      period: z.enum(['hour', 'week', 'month', 'year', 'total']).optional(),
      unpaid: z.boolean().optional(),
      academicCreditOnly: z.boolean().optional(),
      housingProvided: z.boolean().optional(),
      relocationAssistance: z.boolean().optional(),
      raw: z.string().optional(),
    })
    .nullable()
    .default(null),
  /** What the application itself demands, for the effort estimate and filters. */
  requires: z
    .object({
      coverLetter: z.boolean().optional(),
      transcript: z.boolean().optional(),
      portfolio: z.boolean().optional(),
      references: z.boolean().optional(),
      videoInterview: z.boolean().optional(),
      account: z.boolean().optional(),
    })
    .default({}),
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
  /** Human-readable, shown verbatim in the UI next to the pass/fail mark. */
  because: z.string(),
  /** Set when the decision came from an extracted job requirement. */
  requirementId: z.string().optional(),
  /** Which profile field decided it, e.g. "derived.age". */
  profileRef: z.string().optional(),
  /**
   * Verbatim supporting text — the JD quote, or the posting field for rules that derive
   * from the posting itself (deadline, closed). A `fail` must always carry either a
   * requirementId or this; an unexplained exclusion is a bug, and a test enforces it.
   */
  evidence: z.string().optional(),
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
