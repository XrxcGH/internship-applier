import { z } from 'zod';

/** YYYY-MM */
export const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');
/** YYYY-MM-DD */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const EducationLevel = z.enum([
  'high_school',
  'associate',
  'bachelor',
  'master',
  'doctorate',
  'other',
]);

export const EducationEntry = z.object({
  institution: z.string().min(1),
  level: EducationLevel,
  fieldOfStudy: z.string().optional(),
  startDate: YearMonth.optional(),
  /** May be in the future — an expected graduation date. */
  endDate: YearMonth.optional(),
  gpa: z.object({ value: z.number(), scale: z.number() }).optional(),
  coursework: z.array(z.string()).optional(),
  honors: z.array(z.string()).optional(),
});

export const ExperienceType = z.enum([
  'job',
  'internship',
  'volunteer',
  'research',
  'club',
  'freelance',
]);

export const ExperienceEntry = z.object({
  organization: z.string().min(1),
  title: z.string().min(1),
  type: ExperienceType,
  /**
   * Absent means the resume did not say when this started.
   *
   * Optional rather than filled with a sentinel. Ingestion used to substitute '1970-01',
   * which arithmetic treats as a real date: a single undated job derived fifty-six years
   * of professional experience, moved the user into the wrong seniority band, and made
   * every "requires N years" requirement pass. A missing date has to stay missing.
   */
  startDate: YearMonth.optional(),
  /** Absent means current. */
  endDate: YearMonth.optional(),
  location: z.string().optional(),
  /** Verbatim resume bullets. This is the evidence corpus FactGuard checks against. */
  bullets: z.array(z.string()),
  skills: z.array(z.string()).optional(),
});

export const ProjectEntry = z.object({
  name: z.string().min(1),
  description: z.string(),
  url: z.string().url().optional(),
  startDate: YearMonth.optional(),
  endDate: YearMonth.optional(),
  skills: z.array(z.string()).optional(),
  bullets: z.array(z.string()).default([]),
});

/**
 * A skill is never a free-floating string — it points at where in the profile it came
 * from. This is what makes claim verification (docs/06) possible.
 */
export const SkillEvidence = z.object({
  kind: z.enum(['experience', 'project', 'course', 'stated']),
  ref: z.string(),
});

export const Skill = z.object({
  name: z.string().min(1),
  category: z.enum(['language', 'framework', 'tool', 'domain', 'soft']),
  evidence: z.array(SkillEvidence).default([]),
  selfRated: z.number().int().min(1).max(5).optional(),
});

export const WorkAuthorization = z.object({
  country: z.string().default('US'),
  status: z.enum([
    'citizen',
    'permanent_resident',
    'student_visa',
    'work_visa',
    'requires_sponsorship',
    'other',
    'unknown',
  ]),
  needsSponsorship: z.boolean(),
  visaType: z.string().optional(),
});

export const Availability = z.object({
  start: IsoDate.optional(),
  end: IsoDate.optional(),
  hoursPerWeek: z.number().int().positive().optional(),
  flexible: z.boolean().default(true),
});

export const LocationPrefs = z.object({
  base: z.object({ city: z.string(), region: z.string(), country: z.string().default('US') }),
  maxCommuteKm: z.number().nonnegative().default(50),
  remoteOk: z.boolean().default(true),
  hybridOk: z.boolean().default(true),
  relocateTo: z.array(z.string()).default([]),
});

export const SeniorityBand = z.enum([
  'pre_college',
  'entry_intern',
  'experienced_intern',
  'new_grad',
]);

export const AcademicLevel = z.enum([
  'high_school',
  'undergrad',
  'masters',
  'phd',
  'bootcamp',
  'none',
]);

/** Computed on every profile save. Never user-entered. */
export const DerivedProfile = z.object({
  age: z.number().int().nullable(),
  isMinor: z.boolean(),
  academicLevel: AcademicLevel,
  academicYear: z.number().int().nullable(),
  expectedGraduation: YearMonth.nullable(),
  yearsProfessionalExperience: z.number(),
  seniorityBand: SeniorityBand,
});

export const CandidateProfile = z.object({
  id: z.string(),
  fullName: z.string(),
  /**
   * Empty is a legal state, and a deliberate one.
   *
   * A resume without a readable email address produces '', which `needsReview` flags so
   * G1 cannot be passed until the user supplies it. A bare `.email()` rejected that on
   * the way back OUT of the database — the write path is typed but unvalidated, so the
   * empty string stored fine and then failed to parse on every read, locking the user out
   * of the very screen where they would have filled it in.
   */
  email: z.union([z.string().email(), z.literal('')]),
  phone: z.string().optional(),
  /**
   * User-entered only — never extracted from a resume. Used for local eligibility
   * filtering (18+ requirements are common) and never auto-filled into a form.
   */
  dateOfBirth: IsoDate.nullable().default(null),
  address: z
    .object({
      line1: z.string().optional(),
      line2: z.string().optional(),
      city: z.string().optional(),
      region: z.string().optional(),
      postal: z.string().optional(),
      country: z.string().default('US'),
    })
    .default({ country: 'US' }),
  links: z
    .object({
      github: z.string().url().optional(),
      linkedin: z.string().url().optional(),
      portfolio: z.string().url().optional(),
      other: z.array(z.string().url()).default([]),
    })
    .default({ other: [] }),
  workAuthorization: WorkAuthorization,
  citizenships: z.array(z.string()).default([]),
  education: z.array(EducationEntry).default([]),
  experience: z.array(ExperienceEntry).default([]),
  projects: z.array(ProjectEntry).default([]),
  skills: z.array(Skill).default([]),
  certifications: z
    .array(
      z.object({ name: z.string(), issuer: z.string().optional(), date: YearMonth.optional() }),
    )
    .default([]),
  languages: z.array(z.object({ name: z.string(), proficiency: z.string() })).default([]),
  availability: Availability,
  locationPrefs: LocationPrefs,
  preferences: z
    .object({
      companySizes: z.array(z.string()).default([]),
      industries: z.array(z.string()).default([]),
      minStipend: z.number().optional(),
      excludeCompanies: z.array(z.string()).default([]),
    })
    .default({ companySizes: [], industries: [], excludeCompanies: [] }),
  derived: DerivedProfile,
  /** Null until gate G1 passes. Nothing downstream may read an unconfirmed profile. */
  confirmedAt: z.string().datetime().nullable().default(null),
  /** Field paths the extractor was unsure about. G1 cannot complete while non-empty. */
  needsReview: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** A profile that has passed G1. Only this type may be consumed downstream. */
export const ConfirmedProfile = CandidateProfile.extend({
  confirmedAt: z.string().datetime(),
});

export const StyleProfile = z.object({
  meanSentenceLength: z.number(),
  /** Variance matters more than the mean — uniform sentence length is the loudest tell. */
  sentenceLengthStdev: z.number(),
  contractionRate: z.number(),
  firstPersonRate: z.number(),
  vocabularyTier: z.enum(['plain', 'mixed', 'formal']),
  punctuation: z.object({
    emDash: z.number(),
    semicolon: z.number(),
    parenthetical: z.number(),
    exclamation: z.number(),
  }),
  paragraphMeanSentences: z.number(),
  listUsage: z.enum(['never', 'rare', 'common']),
  favoredTransitions: z.array(z.string()),
  hedgeRate: z.number(),
  openingPatterns: z.array(z.string()),
  sampleIds: z.array(z.string()),
  computedAt: z.string().datetime(),
});

export type EducationEntry = z.infer<typeof EducationEntry>;
export type ExperienceEntry = z.infer<typeof ExperienceEntry>;
export type ProjectEntry = z.infer<typeof ProjectEntry>;
export type Skill = z.infer<typeof Skill>;
export type WorkAuthorization = z.infer<typeof WorkAuthorization>;
export type DerivedProfile = z.infer<typeof DerivedProfile>;
export type CandidateProfile = z.infer<typeof CandidateProfile>;
export type ConfirmedProfile = z.infer<typeof ConfirmedProfile>;
export type StyleProfile = z.infer<typeof StyleProfile>;
export type SeniorityBand = z.infer<typeof SeniorityBand>;
export type AcademicLevel = z.infer<typeof AcademicLevel>;
