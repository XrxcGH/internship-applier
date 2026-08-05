import { z } from 'zod';

export const ApplicationStatus = z.enum([
  'draft',
  'answers_ready',
  'filled',
  'awaiting_submit',
  'submitted',
  'acknowledged',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
  'ghosted',
]);

/**
 * Semantic meaning of a form field. `REDLINE` fields are NEVER auto-filled — see
 * docs/07-form-automation.md § Redlines.
 */
export const FieldSemantic = z.enum([
  'first_name',
  'last_name',
  'full_name',
  'email',
  'phone',
  'address_line1',
  'city',
  'region',
  'postal',
  'country',
  'linkedin',
  'github',
  'portfolio',
  'website',
  'school',
  'degree',
  'major',
  'gpa',
  'graduation_date',
  'enrollment_status',
  'resume_upload',
  'cover_letter_upload',
  'transcript_upload',
  'work_auth',
  'sponsorship_needed',
  'start_date',
  'end_date',
  'hours_available',
  'essay',
  'referral_source',
  'salary_expectation',
  'REDLINE',
  'unknown',
]);

export const RedlineCategory = z.enum([
  'government_id',
  'financial',
  'credential',
  'attestation',
  'consent',
  'eeo_demographic',
  'ai_disclosure',
]);

export const FormField = z.object({
  id: z.string(),
  locator: z.string(),
  label: z.string(),
  control: z.enum([
    'text',
    'textarea',
    'select',
    'multiselect',
    'radio',
    'checkbox',
    'file',
    'date',
    'combobox',
    'richtext',
  ]),
  required: z.boolean(),
  maxLength: z.number().int().positive().optional(),
  /**
   * The choices, for a control that has them.
   *
   * `locator` is set only for a radio group, where the options are separate elements
   * rather than children of one control — the group's own locator matches all of them,
   * so choosing an option means addressing that option's own input.
   */
  options: z
    .array(z.object({ value: z.string(), label: z.string(), locator: z.string().optional() }))
    .optional(),
  semantic: FieldSemantic,
  redlineCategory: RedlineCategory.optional(),
  confidence: z.number().min(0).max(1),
  step: z.number().int().optional(),
  frame: z.string().optional(),
});

export const ClaimVerdict = z.enum(['supported', 'inferred', 'unsupported', 'overstated']);

export const AnswerFlag = z.object({
  type: z.enum(['unsupported', 'overstated', 'style_drift', 'ai_tell']),
  span: z.object({ start: z.number().int(), end: z.number().int() }),
  note: z.string(),
});

export const AnswerEvidence = z.object({
  claim: z.string(),
  verdict: ClaimVerdict,
  profileRef: z.string().nullable(),
  quote: z.string().nullable(),
});

export const ApplicationAnswer = z.object({
  id: z.string(),
  applicationId: z.string(),
  questionText: z.string(),
  fieldKey: z.string(),
  answerType: z.enum(['short_text', 'long_text', 'select', 'multi', 'boolean', 'file', 'date']),
  draftText: z.string(),
  finalText: z.string(),
  /** draft → final. Surfaced in the UI; zero triggers a re-read nudge at gate G3. */
  editDistance: z.number().int().nonnegative(),
  evidence: z.array(AnswerEvidence).default([]),
  flags: z.array(AnswerFlag).default([]),
  /** Null blocks form filling. Set only by an explicit user action (gate G3). */
  approvedAt: z.string().datetime().nullable(),
});

export const Application = z.object({
  id: z.string(),
  matchId: z.string(),
  status: ApplicationStatus,
  applyUrl: z.string().url(),
  atsVendor: z.string(),
  resumeDocumentId: z.string().nullable(),
  /** Written ONLY by POST /api/applications/:id/mark-submitted (gate G4). */
  submittedAt: z.string().datetime().nullable(),
  deadlineAt: z.string().datetime().nullable(),
  screenshotPath: z.string().nullable(),
  /** Redlined and unclassifiable fields the user must handle themselves. */
  skippedFields: z
    .array(
      z.object({
        label: z.string(),
        reason: z.enum(['redline', 'unclassified', 'no_match', 'failed']),
        category: RedlineCategory.optional(),
      }),
    )
    .default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ApplicationStatus = z.infer<typeof ApplicationStatus>;
export type FieldSemantic = z.infer<typeof FieldSemantic>;
export type RedlineCategory = z.infer<typeof RedlineCategory>;
export type FormField = z.infer<typeof FormField>;
export type ClaimVerdict = z.infer<typeof ClaimVerdict>;
export type AnswerFlag = z.infer<typeof AnswerFlag>;
export type AnswerEvidence = z.infer<typeof AnswerEvidence>;
export type ApplicationAnswer = z.infer<typeof ApplicationAnswer>;
export type Application = z.infer<typeof Application>;
