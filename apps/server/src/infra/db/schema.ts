/**
 * SQLite schema — see docs/03-data-model.md.
 *
 * Columns commented `ENCRYPTED` hold PII and are AES-256-GCM encrypted at the
 * application layer before insert (docs/10-security-privacy.md). They are stored as
 * text and are deliberately not indexed or searchable.
 */
import { sql } from 'drizzle-orm';
import { blob, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

// ---------------------------------------------------------------- profile & documents

export const profile = sqliteTable('profile', {
  id: text('id').primaryKey(),
  fullName: text('full_name').notNull(), // ENCRYPTED
  email: text('email').notNull(), // ENCRYPTED
  phone: text('phone'), // ENCRYPTED
  dateOfBirth: text('date_of_birth'), // ENCRYPTED — user-entered only, never extracted
  address: text('address', { mode: 'json' }), // ENCRYPTED
  links: text('links', { mode: 'json' }),
  workAuthorization: text('work_authorization', { mode: 'json' }),
  citizenships: text('citizenships', { mode: 'json' }),
  education: text('education', { mode: 'json' }),
  experience: text('experience', { mode: 'json' }),
  projects: text('projects', { mode: 'json' }),
  skills: text('skills', { mode: 'json' }),
  certifications: text('certifications', { mode: 'json' }),
  languages: text('languages', { mode: 'json' }),
  availability: text('availability', { mode: 'json' }),
  locationPrefs: text('location_prefs', { mode: 'json' }),
  preferences: text('preferences', { mode: 'json' }),
  derived: text('derived', { mode: 'json' }),
  /** Gate G1. Null blocks every downstream feature. */
  confirmedAt: text('confirmed_at'),
  needsReview: text('needs_review', { mode: 'json' }),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
});

export const resumeDocument = sqliteTable('resume_document', {
  id: text('id').primaryKey(),
  filename: text('filename').notNull(),
  path: text('path').notNull(), // ENCRYPTED
  mime: text('mime').notNull(),
  bytes: integer('bytes').notNull(),
  sha256: text('sha256').notNull(),
  rawText: text('raw_text'), // ENCRYPTED
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(now),
});

export const writingSample = sqliteTable('writing_sample', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  content: text('content').notNull(), // ENCRYPTED
  wordCount: integer('word_count').notNull(),
  createdAt: text('created_at').notNull().default(now),
});

export const styleProfile = sqliteTable('style_profile', {
  id: text('id').primaryKey(),
  metrics: text('metrics', { mode: 'json' }).notNull(),
  qualitativeNotes: text('qualitative_notes'),
  sampleIds: text('sample_ids', { mode: 'json' }).notNull(),
  computedAt: text('computed_at').notNull().default(now),
});

export const answerTemplate = sqliteTable('answer_template', {
  id: text('id').primaryKey(),
  questionKey: text('question_key').notNull().unique(),
  canonicalText: text('canonical_text').notNull(),
  variants: text('variants', { mode: 'json' }),
  useCount: integer('use_count').notNull().default(0),
  lastUsedAt: text('last_used_at'),
  approvedAt: text('approved_at'),
  createdAt: text('created_at').notNull().default(now),
});

// ---------------------------------------------------------------- discovery

export const source = sqliteTable('source', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  config: text('config', { mode: 'json' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastRunAt: text('last_run_at'),
  lastStatus: text('last_status'),
});

export const jobPosting = sqliteTable(
  'job_posting',
  {
    id: text('id').primaryKey(),
    externalId: text('external_id'),
    canonicalUrl: text('canonical_url').notNull(),
    applyUrl: text('apply_url').notNull(),
    company: text('company').notNull(),
    companyDomain: text('company_domain'),
    title: text('title').notNull(),
    descriptionHtml: text('description_html'),
    descriptionText: text('description_text').notNull(),
    locations: text('locations', { mode: 'json' }),
    /** Null = the posting didn't say. Never treated as a mismatch. */
    positionType: text('position_type'),
    workArrangement: text('work_arrangement'),
    hybridDaysOnsite: integer('hybrid_days_onsite'),
    remoteEligibleIn: text('remote_eligible_in', { mode: 'json' }),
    programFlags: text('program_flags', { mode: 'json' }),
    term: text('term', { mode: 'json' }),
    compensation: text('compensation', { mode: 'json' }),
    requires: text('requires', { mode: 'json' }),
    postedAt: text('posted_at'),
    closesAt: text('closes_at'),
    isOpen: integer('is_open', { mode: 'boolean' }).notNull().default(true),
    atsVendor: text('ats_vendor').notNull().default('unknown'),
    applyEffort: text('apply_effort', { mode: 'json' }),
    fingerprint: text('fingerprint').notNull(),
    embedding: blob('embedding'),
    firstSeenAt: text('first_seen_at').notNull().default(now),
    lastSeenAt: text('last_seen_at').notNull().default(now),
    /**
     * When requirements were last extracted from this posting, whatever the outcome.
     *
     * The cache used to be keyed on "are there any requirement rows", which cannot tell
     * "never looked" from "looked, found none" — a result the extractor itself calls
     * valid and common. Every posting in the second category paid for a fresh model call
     * on every recompute, contradicting the promise that extraction happens once.
     */
    requirementsExtractedAt: text('requirements_extracted_at'),
  },
  (t) => [
    uniqueIndex('job_posting_canonical_url_idx').on(t.canonicalUrl),
    index('job_posting_fingerprint_idx').on(t.fingerprint),
    index('job_posting_open_idx').on(t.isOpen, t.closesAt),
    index('job_posting_filter_idx').on(t.positionType, t.workArrangement, t.isOpen),
  ],
);

/** A posting can be seen by several sources; merging must not lose provenance. */
export const jobPostingSource = sqliteTable(
  'job_posting_source',
  {
    postingId: text('posting_id')
      .notNull()
      .references(() => jobPosting.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => source.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    seenAt: text('seen_at').notNull().default(now),
  },
  (t) => [uniqueIndex('job_posting_source_pk').on(t.postingId, t.sourceId)],
);

export const jobRequirement = sqliteTable(
  'job_requirement',
  {
    id: text('id').primaryKey(),
    postingId: text('posting_id')
      .notNull()
      .references(() => jobPosting.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    operator: text('operator').notNull(),
    value: text('value', { mode: 'json' }),
    necessity: text('necessity').notNull(),
    /** Verified to appear verbatim in description_text before insert. */
    sourceQuote: text('source_quote').notNull(),
    confidence: integer('confidence').notNull(),
  },
  (t) => [index('job_requirement_posting_idx').on(t.postingId)],
);

// ---------------------------------------------------------------- matching

export const match = sqliteTable(
  'match',
  {
    id: text('id').primaryKey(),
    postingId: text('posting_id')
      .notNull()
      .references(() => jobPosting.id, { onDelete: 'cascade' }),
    profileId: text('profile_id')
      .notNull()
      .references(() => profile.id, { onDelete: 'cascade' }),
    /** eligible | ineligible | unknown — never a silent drop. */
    eligibility: text('eligibility').notNull(),
    rules: text('rules', { mode: 'json' }).notNull(),
    blockers: text('blockers', { mode: 'json' }).notNull(),
    score: integer('score').notNull(),
    breakdown: text('breakdown', { mode: 'json' }).notNull(),
    rationale: text('rationale').notNull(),
    computedAt: text('computed_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('match_posting_profile_idx').on(t.postingId, t.profileId),
    index('match_rank_idx').on(t.eligibility, t.score),
  ],
);

export const decision = sqliteTable('decision', {
  id: text('id').primaryKey(),
  matchId: text('match_id')
    .notNull()
    .references(() => match.id, { onDelete: 'cascade' }),
  action: text('action').notNull(),
  reason: text('reason'),
  reasonTags: text('reason_tags', { mode: 'json' }),
  decidedAt: text('decided_at').notNull().default(now),
});

// ---------------------------------------------------------------- applications

export const application = sqliteTable(
  'application',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => match.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('draft'),
    applyUrl: text('apply_url').notNull(),
    atsVendor: text('ats_vendor').notNull().default('unknown'),
    resumeDocumentId: text('resume_document_id').references(() => resumeDocument.id),
    /**
     * Gate G4. Written only where the user themselves says it was submitted: POST
     * /api/applications/:id/mark-submitted, and a user status change to 'submitted' via
     * POST /api/applications/:id/status. Never by the fill run.
     */
    submittedAt: text('submitted_at'),
    deadlineAt: text('deadline_at'),
    screenshotPath: text('screenshot_path'),
    skippedFields: text('skipped_fields', { mode: 'json' }),
    // This carried the same ENCRYPTED marker as the eight columns that really are, while
    // nothing in the app writes it at all — so it promised a protection that did not exist,
    // and whoever adds the first notes feature would have taken the column as handled.
    // Whatever writes it must call encryptField(value, applicationId) and mark it then.
    notes: text('notes'), // plaintext — no writer yet
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [index('application_status_idx').on(t.status, t.deadlineAt)],
);

export const applicationAnswer = sqliteTable(
  'application_answer',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => application.id, { onDelete: 'cascade' }),
    questionText: text('question_text').notNull(),
    fieldKey: text('field_key').notNull(),
    answerType: text('answer_type').notNull(),
    draftText: text('draft_text').notNull().default(''),
    finalText: text('final_text').notNull().default(''),
    editDistance: integer('edit_distance').notNull().default(0),
    evidence: text('evidence', { mode: 'json' }),
    flags: text('flags', { mode: 'json' }),
    /** Gate G3. Null blocks form filling for the whole application. */
    approvedAt: text('approved_at'),
  },
  (t) => [index('application_answer_app_idx').on(t.applicationId)],
);

export const applicationEvent = sqliteTable(
  'application_event',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => application.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }),
    at: text('at').notNull().default(now),
  },
  (t) => [index('application_event_app_idx').on(t.applicationId, t.at)],
);

// ---------------------------------------------------------------- cross-cutting

export const task = sqliteTable(
  'task',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    payload: text('payload', { mode: 'json' }),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    runAfter: text('run_after'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    error: text('error'),
    progress: text('progress', { mode: 'json' }),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('task_queue_idx').on(t.status, t.runAfter)],
);

export const llmCall = sqliteTable('llm_call', {
  id: text('id').primaryKey(),
  purpose: text('purpose').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  costUsd: integer('cost_usd_micros').notNull().default(0),
  latencyMs: integer('latency_ms').notNull().default(0),
  stopReason: text('stop_reason'),
  at: text('at').notNull().default(now),
});

/** Points at a Playwright storage-state file. NEVER stores a password. */
export const credentialRef = sqliteTable('credential_ref', {
  id: text('id').primaryKey(),
  domain: text('domain').notNull().unique(),
  label: text('label'),
  storageStatePath: text('storage_state_path').notNull(),
  lastUsedAt: text('last_used_at'),
});

/** Saved search filters — see docs/05-matching.md § Filters. */
export const filterPreset = sqliteTable('filter_preset', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  filters: text('filters', { mode: 'json' }).notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
});

export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull().default(now),
});
