import { z } from 'zod';

/**
 * Search filters — see docs/05-matching.md § Filters.
 *
 * Three rules govern this whole file:
 *
 * 1. Every filter is OPTIONAL — nobody has to state a preference to get results. What an
 *    omitted filter falls back to is mostly permissive, but not uniformly, and the
 *    exceptions are deliberate: the term block (summer, 2027, six weeks of overlap), the
 *    US country default, the internship-and-co-op position types, and the `exclude*` flags
 *    that mirror hard eligibility all narrow to the cycle a user is actually applying for.
 *    Nothing else here narrows anything by default, because a tool that silently excludes
 *    opportunities is worse than one that shows too many.
 * 2. Filters that mirror a hard eligibility rule (age, graduation window, work
 *    authorization) are *preferences about what to show*, not the rules themselves.
 *    Eligibility is still computed deterministically in matching/eligibility.ts.
 * 3. Anything unstated in a posting is NEVER treated as disqualifying. A posting that
 *    doesn't mention pay is not "unpaid"; it's unknown, and `include*Undisclosed`
 *    defaults to true throughout.
 */

// ---------------------------------------------------------------- term & timing

export const Season = z.enum(['summer', 'fall', 'winter', 'spring', 'year_round', 'flexible']);

export const TermFilter = z.object({
  /** Empty = any season. */
  seasons: z.array(Season).default(['summer']),
  /** Empty = any year. Default is the upcoming cycle. */
  years: z.array(z.number().int()).default([2027]),
  durationWeeks: z
    .object({ min: z.number().int().optional(), max: z.number().int().optional() })
    .default({}),
  startsBetween: z.object({ from: z.string().optional(), to: z.string().optional() }).default({}),
  endsBetween: z.object({ from: z.string().optional(), to: z.string().optional() }).default({}),
  /** Co-ops and rotational programs often span two terms. */
  allowMultiTerm: z.boolean().default(true),
  /** Minimum weeks a posting's term must overlap your availability. */
  minOverlapWeeks: z.number().int().nonnegative().default(6),
  includeUndatedPostings: z.boolean().default(true),
});

// ---------------------------------------------------------------- what kind of position

export const PositionType = z.enum([
  'internship',
  'co_op',
  'fellowship',
  'apprenticeship',
  'research', // REU and lab positions
  'new_grad',
  'part_time',
  'seasonal',
  'contract',
  'externship', // short job-shadow / micro-internship
  'trainee_program',
  'volunteer',
]);

export const ProgramFlag = z.enum([
  'diversity_program',
  'first_year_or_sophomore',
  'high_school_program',
  'returnship',
  'veteran_program',
  'rotational',
  'leadership_development',
  'phd_or_research',
  'return_offer_track',
]);

// ---------------------------------------------------------------- where and how

export const WorkArrangement = z.enum([
  'onsite',
  'hybrid',
  'remote',
  'remote_geo_restricted',
  'field_or_travel',
]);

export const ArrangementFilter = z.object({
  /** Empty = any arrangement. */
  allowed: z.array(WorkArrangement).default([]),
  hybridDaysOnsite: z
    .object({
      min: z.number().int().optional(),
      max: z.number().int().optional(),
    })
    .default({}),
  /** For remote roles that restrict which states/countries you may work from. */
  remoteEligibleIn: z.array(z.string()).default([]),
  includeUnstatedArrangement: z.boolean().default(true),
});

export const LocationFilter = z.object({
  cities: z.array(z.string()).default([]),
  regions: z.array(z.string()).default([]),
  countries: z.array(z.string()).default(['US']),
  /** Applied from the profile's base location. Ignored for remote postings. */
  radiusKm: z.number().nonnegative().optional(),
  relocationTargets: z.array(z.string()).default([]),
  willRelocate: z.boolean().default(false),
  excludeLocations: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------- money

export const PayBasis = z.enum(['hour', 'week', 'month', 'year', 'total']);

export const CompensationFilter = z.object({
  paidOnly: z.boolean().default(false),
  academicCreditAcceptable: z.boolean().default(true),
  minAmount: z.number().nonnegative().optional(),
  minAmountBasis: PayBasis.default('hour'),
  currency: z.string().default('USD'),
  /** A posting that doesn't state pay is unknown, not unpaid. Keep this true. */
  includeUndisclosed: z.boolean().default(true),
  requireHousingStipend: z.boolean().default(false),
  requireRelocationAssistance: z.boolean().default(false),
});

// ---------------------------------------------------------------- who can apply

export const EligibilityFilter = z.object({
  educationLevels: z.array(z.string()).default([]),
  graduationBetween: z
    .object({ from: z.string().optional(), to: z.string().optional() })
    .default({}),
  enrollmentRequired: z.enum(['any', 'required', 'not_required']).default('any'),
  /** Hide postings whose minimum age exceeds yours. */
  excludeAboveMyAge: z.boolean().default(true),
  /** Hide postings that won't sponsor when you need sponsorship. */
  excludeIfSponsorshipUnavailable: z.boolean().default(true),
  excludeCitizenshipRequired: z.boolean().default(false),
  excludeClearanceRequired: z.boolean().default(false),
  /** Hide postings whose minimum GPA is above yours. */
  excludeAboveMyGpa: z.boolean().default(false),
  /** Show postings whose requirements couldn't be parsed. Keep true — see rule 3. */
  includeUnknownEligibility: z.boolean().default(true),
});

// ---------------------------------------------------------------- who you'd work for

export const CompanySize = z.enum(['startup', 'small', 'mid', 'large', 'enterprise']);
export const CompanySector = z.enum([
  'private',
  'public_company',
  'nonprofit',
  'government',
  'academic',
  'startup',
]);

export const CompanyFilter = z.object({
  sizes: z.array(CompanySize).default([]),
  sectors: z.array(CompanySector).default([]),
  industries: z.array(z.string()).default([]),
  /** If non-empty, ONLY these companies are searched. */
  onlyCompanies: z.array(z.string()).default([]),
  excludeCompanies: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------- what you'd do

export const RoleFilter = z.object({
  roleFamilies: z.array(z.string()).default([]),
  titleIncludes: z.array(z.string()).default([]),
  titleExcludes: z.array(z.string()).default([]),
  descriptionIncludes: z.array(z.string()).default([]),
  descriptionExcludes: z.array(z.string()).default([]),
  requiredSkills: z.array(z.string()).default([]),
  /** Hide postings demanding more professional years than you have, plus tolerance. */
  excludeOverqualifiedRequirements: z.boolean().default(true),
  experienceToleranceYears: z.number().nonnegative().default(1),
});

// ---------------------------------------------------------------- cost of applying

export const ApplicationFilter = z.object({
  maxSteps: z.number().int().positive().optional(),
  maxEssays: z.number().int().nonnegative().optional(),
  maxEstimatedMinutes: z.number().int().positive().optional(),
  excludeRequiresAccount: z.boolean().default(false),
  atsVendorsAllowed: z.array(z.string()).default([]),
  atsVendorsExcluded: z.array(z.string()).default([]),
  deadlineWithinDays: z.number().int().positive().optional(),
  postedWithinDays: z.number().int().positive().optional(),
  excludeExpired: z.boolean().default(true),
  excludeRequiresCoverLetter: z.boolean().default(false),
  excludeRequiresTranscript: z.boolean().default(false),
  excludeRequiresPortfolio: z.boolean().default(false),
  excludeRequiresReferences: z.boolean().default(false),
  excludeRequiresVideoInterview: z.boolean().default(false),
});

// ---------------------------------------------------------------- presentation

export const SortKey = z.enum([
  'fit',
  'deadline',
  'posted',
  'effort',
  'compensation',
  'company',
  'title',
]);

export const ViewFilter = z.object({
  /** `all` includes ineligible postings in the collapsed, inspectable drawer. */
  eligibility: z.enum(['eligible', 'eligible_and_unknown', 'all']).default('eligible_and_unknown'),
  minScore: z.number().min(0).max(100).default(0),
  sortBy: SortKey.default('fit'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  hideDecided: z.boolean().default(true),
});

// ---------------------------------------------------------------- the whole thing

export const SearchFilters = z.object({
  term: TermFilter.prefault({}),
  positionTypes: z.array(PositionType).default(['internship', 'co_op']),
  programFlags: z.array(ProgramFlag).default([]),
  arrangement: ArrangementFilter.prefault({}),
  location: LocationFilter.prefault({}),
  compensation: CompensationFilter.prefault({}),
  eligibility: EligibilityFilter.prefault({}),
  company: CompanyFilter.prefault({}),
  role: RoleFilter.prefault({}),
  application: ApplicationFilter.prefault({}),
  view: ViewFilter.prefault({}),
});

export const FilterPreset = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  filters: SearchFilters,
  isDefault: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Parsing `{}` yields every default. Summer 2027 internships and co-ops, US, any
 * arrangement, any pay, undisclosed-and-unknown included.
 */
export const DEFAULT_FILTERS: SearchFilters = SearchFilters.parse({});

/**
 * The starting set of named filters, meant to be editable and deletable like any other.
 *
 * Not wired up: nothing seeds `filter_preset` from this list, no route serves presets, and
 * the web app has no preset picker, so no user has ever seen one of these. The shared tests
 * are the only reader. Treat it as the intended starting set, not as shipped behaviour.
 */
export const STARTER_PRESETS: ReadonlyArray<{ name: string; description: string; patch: unknown }> =
  [
    {
      name: 'Summer 2027',
      description: 'The default cycle — internships and co-ops, any arrangement.',
      patch: {},
    },
    {
      name: 'Remote only',
      description: 'Anything you can do without moving.',
      patch: { arrangement: { allowed: ['remote', 'remote_geo_restricted'] } },
    },
    {
      name: 'Co-ops (6+ months)',
      description: 'Longer placements, often alternating with school terms.',
      patch: {
        positionTypes: ['co_op'],
        term: { seasons: [], years: [], durationWeeks: { min: 24 }, allowMultiTerm: true },
      },
    },
    {
      name: 'Paid only',
      description: 'Excludes unpaid and credit-only postings, keeps undisclosed pay.',
      patch: { compensation: { paidOnly: true, academicCreditAcceptable: false } },
    },
    {
      name: 'Quick applications',
      description: 'One-page forms, no account, no essays — for high-volume days.',
      patch: { application: { maxEssays: 0, maxSteps: 1, excludeRequiresAccount: true } },
    },
    {
      name: 'Closing soon',
      description: 'Anything with a deadline inside two weeks, deadline-sorted.',
      patch: {
        application: { deadlineWithinDays: 14 },
        view: { sortBy: 'deadline', sortDir: 'asc' },
      },
    },
    {
      name: 'Government & research',
      description: 'Federal, national labs, and academic research programs.',
      patch: {
        positionTypes: ['internship', 'fellowship', 'research'],
        company: { sectors: ['government', 'academic', 'nonprofit'] },
      },
    },
    {
      name: 'Cast a wide net',
      description: 'Every position type, every season, every year. Maximum recall.',
      patch: {
        positionTypes: [
          'internship',
          'co_op',
          'fellowship',
          'apprenticeship',
          'research',
          'new_grad',
          'part_time',
          'seasonal',
          'contract',
          'externship',
          'trainee_program',
          'volunteer',
        ],
        term: { seasons: [], years: [] },
        view: { eligibility: 'all' },
      },
    },
  ];

export type Season = z.infer<typeof Season>;
export type PositionType = z.infer<typeof PositionType>;
export type ProgramFlag = z.infer<typeof ProgramFlag>;
export type WorkArrangement = z.infer<typeof WorkArrangement>;
export type CompanySize = z.infer<typeof CompanySize>;
export type CompanySector = z.infer<typeof CompanySector>;
export type SortKey = z.infer<typeof SortKey>;
export type SearchFilters = z.infer<typeof SearchFilters>;
export type FilterPreset = z.infer<typeof FilterPreset>;
