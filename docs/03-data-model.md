# 03 — Data model

SQLite, one file at `data/app.db`, accessed through Drizzle. Fields marked 🔒 are
encrypted at rest with AES-256-GCM using a key held in the OS keychain
(see [`10-security-privacy.md`](10-security-privacy.md)).

All timestamps are ISO-8601 UTC strings. All IDs are ULIDs (sortable, no coordination).

## Entity map

```
profile ──1:N──▶ resume_document
   │      ──1:N──▶ writing_sample ──▶ style_profile
   │
   └──1:N──▶ answer_template          (reusable canonical answers)

source ──1:N──▶ job_posting ──1:N──▶ job_requirement
                     │
                     └──1:1──▶ match ──▶ decision
                                  │
                                  └──1:1──▶ application ──1:N──▶ application_answer
                                                  └──1:N──▶ application_event

task · llm_call · setting · credential_ref      (cross-cutting)
```

## Core tables

### `profile`

One row. The confirmed identity and eligibility facts everything else keys off.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text pk | |
| `full_name` 🔒 | text | |
| `email` 🔒 | text | |
| `phone` 🔒 | text | |
| `date_of_birth` 🔒 | text | **User-entered only.** Never extracted from a resume. Nullable. |
| `address` 🔒 | json | `{line1, line2, city, region, postal, country}` |
| `links` | json | `{github, linkedin, portfolio, other[]}` |
| `work_authorization` | json | `{country, status, needs_sponsorship, visa_type?}` |
| `citizenships` | json | `string[]` — matters for federal/defense postings |
| `education` | json | `EducationEntry[]` (below) |
| `experience` | json | `ExperienceEntry[]` |
| `projects` | json | `ProjectEntry[]` |
| `skills` | json | `Skill[]` |
| `certifications` | json | `Certification[]` |
| `languages` | json | `{name, proficiency}[]` |
| `availability` | json | `{start, end, hours_per_week?, flexible: bool}` |
| `location_prefs` | json | `{base, max_commute_km, remote_ok, hybrid_ok, relocate_to[]}` |
| `preferences` | json | `{company_sizes[], industries[], min_stipend?, exclude_companies[]}` |
| `derived` | json | Computed, not user-entered — see below |
| `confirmed_at` | text | **Null until G1 passes.** Nothing downstream may read an unconfirmed profile. |
| `needs_review` | json | `string[]` of field paths the extractor was unsure about |
| `created_at` / `updated_at` | text | |

**`derived`** is recomputed on every profile save:

```ts
type DerivedProfile = {
  age: number | null;                       // from date_of_birth, null if absent
  isMinor: boolean;                         // age < 18 → guardian mode
  academicLevel: 'high_school' | 'undergrad' | 'masters' | 'phd' | 'bootcamp' | 'none';
  academicYear: number | null;              // 1..4 for undergrad
  expectedGraduation: string | null;        // YYYY-MM
  yearsProfessionalExperience: number;      // internships weighted 0.5
  seniorityBand: 'pre_college' | 'entry_intern' | 'experienced_intern' | 'new_grad';
  skillIndex: Record<string, SkillStrength>; // normalized skill name → evidence
};
```

Supporting shapes (defined once in `packages/shared`, used by API, DB JSON, and LLM
structured-output schemas):

```ts
type EducationEntry = {
  institution: string;
  level: 'high_school' | 'associate' | 'bachelor' | 'master' | 'doctorate' | 'other';
  fieldOfStudy?: string;
  startDate?: string;         // YYYY-MM
  endDate?: string;           // YYYY-MM, may be future (expected)
  gpa?: { value: number; scale: number };
  coursework?: string[];
  honors?: string[];
};

type ExperienceEntry = {
  organization: string;
  title: string;
  type: 'job' | 'internship' | 'volunteer' | 'research' | 'club' | 'freelance';
  startDate: string;
  endDate?: string;           // absent = current
  location?: string;
  bullets: string[];          // verbatim from resume — the evidence corpus
  skills?: string[];
};

type Skill = {
  name: string;
  category: 'language' | 'framework' | 'tool' | 'domain' | 'soft';
  evidence: Array<{ kind: 'experience' | 'project' | 'course' | 'stated'; ref: string }>;
  selfRated?: 1 | 2 | 3 | 4 | 5;
};
```

Note `Skill.evidence`: a skill is not a free-floating string, it points at where in the
profile it came from. This is what makes `factGuard` (doc 06) possible.

### `resume_document`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text pk | |
| `filename` | text | |
| `path` 🔒 | text | Under `data/resumes/`, restrictive ACL |
| `mime` | text | |
| `bytes` | integer | |
| `sha256` | text | Dedupe re-uploads |
| `raw_text` 🔒 | text | Extracted text where applicable; null for PDFs sent as bytes |
| `is_primary` | integer | The one attached to applications by default |
| `created_at` | text | |

### `writing_sample` / `style_profile`

`writing_sample` stores user-supplied prose (past essays, emails, cover letters) —
🔒 `content`, plus `kind` (`essay` \| `email` \| `cover_letter` \| `other`), `word_count`,
`created_at`.

`style_profile` is the measured fingerprint derived from those samples. Stored as JSON with
a `computed_at` and the sample IDs it was built from:

```ts
type StyleProfile = {
  meanSentenceLength: number;
  sentenceLengthStdev: number;      // variance matters more than mean
  contractionRate: number;          // per 100 words
  firstPersonRate: number;
  vocabularyTier: 'plain' | 'mixed' | 'formal';
  punctuation: { emDash: number; semicolon: number; parenthetical: number; exclamation: number };
  paragraphMeanSentences: number;
  listUsage: 'never' | 'rare' | 'common';
  favoredTransitions: string[];
  hedgeRate: number;
  openingPatterns: string[];        // how they actually start things
  sampleIds: string[];
  computedAt: string;
};
```

### `source` / `job_posting` / `job_requirement`

`source`: `id`, `kind` (`greenhouse` \| `lever` \| `ashby` \| `usajobs` \| `adzuna` \| `github_list` \| `manual` \| …), `label`, `config` json, `enabled`, `last_run_at`, `last_status`.

`job_posting`:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text pk | |
| `source_id` | text fk | |
| `external_id` | text | Source's own ID; `(source_id, external_id)` unique |
| `canonical_url` | text | Unique index — first dedupe key |
| `apply_url` | text | Often differs from the listing URL |
| `company` / `company_domain` | text | |
| `title` | text | |
| `description_html` / `description_text` | text | |
| `locations` | json | `{city, region, country, remote}[]` |
| `employment_type` | text | `internship` \| `co_op` \| `fellowship` \| `part_time` \| `other` |
| `term` | json | `{season: 'summer', year: 2027, start?, end?}` |
| `compensation` | json | `{min?, max?, currency?, period?, raw?}` |
| `posted_at` / `closes_at` | text | `closes_at` nullable |
| `is_open` | integer | Refreshed by `refresh.ts` |
| `ats_vendor` | text | Detected: greenhouse/lever/ashby/workday/icims/taleo/smartrecruiters/unknown |
| `apply_effort` | json | `{steps, essayCount, requiresAccount, estMinutes}` |
| `fingerprint` | text | Fuzzy `(company, normTitle, normLocation)` hash — second dedupe key |
| `embedding` | blob | Optional third dedupe key + similarity search |
| `first_seen_at` / `last_seen_at` | text | |

`job_requirement` — one row per extracted requirement, so eligibility decisions can cite
their evidence:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text pk | |
| `posting_id` | text fk | |
| `kind` | text | `age` \| `education_level` \| `graduation_window` \| `enrollment` \| `work_auth` \| `citizenship` \| `location` \| `term_dates` \| `experience_years` \| `skill` \| `other` |
| `operator` | text | `min` \| `max` \| `equals` \| `one_of` \| `between` \| `present` |
| `value` | json | Typed per `kind` |
| `necessity` | text | `required` \| `preferred` \| `unclear` |
| `source_quote` | text | **Verbatim JD text.** Shown in the UI next to every pass/fail. |
| `confidence` | real | 0–1 from the extractor |

### `match` / `decision`

`match`: `id`, `posting_id`, `profile_id`, `eligibility` (`eligible` \| `ineligible` \| `unknown`), `blockers` json (`RuleResult[]`), `score` (0–100), `breakdown` json, `rationale` text, `computed_at`, `model_version`.

`decision`: `id`, `match_id`, `action` (`approved` \| `skipped` \| `rejected` \| `saved`), `reason` text, `reason_tags` json, `decided_at`. Rejection reasons feed preference learning; they are never used to auto-reject future postings without showing why.

### `application` / `application_answer` / `application_event`

`application`:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text pk | |
| `match_id` | text fk | |
| `status` | text | `draft` \| `answers_ready` \| `filled` \| `awaiting_submit` \| `submitted` \| `acknowledged` \| `interview` \| `offer` \| `rejected` \| `withdrawn` \| `ghosted` |
| `apply_url` | text | |
| `ats_vendor` | text | |
| `resume_document_id` | text fk | Which resume was attached |
| `submitted_at` | text | Set **only** when the user confirms they clicked Submit |
| `deadline_at` | text | Copied from posting for reminder scheduling |
| `screenshot_path` | text | Final pre-submit full-page capture |
| `skipped_fields` | json | Redlined/unclassifiable fields the user must handle |
| `notes` 🔒 | text | |

`application_answer` — the audit trail that makes G3 meaningful:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text pk | |
| `application_id` | text fk | |
| `question_text` | text | As it appeared on the form |
| `field_key` | text | Stable key for the answer library |
| `answer_type` | text | `short_text` \| `long_text` \| `select` \| `multi` \| `boolean` \| `file` \| `date` |
| `draft_text` | text | What the model produced |
| `final_text` | text | What the user approved |
| `edit_distance` | integer | `draft` → `final`. Surfaced in the UI; 0 triggers a re-read nudge |
| `evidence` | json | `{profileRef, quote}[]` per claim |
| `flags` | json | `{type: 'unsupported' \| 'overstated' \| 'style_drift', span, note}[]` |
| `approved_at` | text | **Null blocks filling.** |

`application_event`: `id`, `application_id`, `type` (`created` \| `answers_drafted` \| `answers_approved` \| `filled` \| `submitted` \| `email_received` \| `status_changed` \| `note`), `payload` json, `at`.

### `answer_template`

The reusable answer library. `id`, `question_key` (`why_this_company`, `greatest_strength`,
`describe_a_project`, …), `canonical_text`, `variants` json, `use_count`, `last_used_at`,
`approved_at`. Templates are user-approved once and adapted per application — this reduces
generation risk and keeps a consistent story across applications.

### Cross-cutting

- **`task`** — `id`, `kind`, `payload` json, `status` (`queued`\|`running`\|`done`\|`failed`\|`cancelled`), `attempts`, `max_attempts`, `run_after`, `started_at`, `finished_at`, `error`, `progress` json. The queue is just this table plus a worker loop.
- **`llm_call`** — `id`, `purpose`, `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `latency_ms`, `stop_reason`, `at`. Powers the cost panel and lets a bad prompt be traced to a bad output.
- **`credential_ref`** — `id`, `domain`, `label`, `storage_state_path`, `last_used_at`. **Never stores passwords.** Points at a Playwright storage-state file the user created by logging in themselves.
- **`setting`** — key/value JSON for app config the user can change in the UI.

## Invariants

Enforced in code, and where possible as DB constraints or triggers:

1. Nothing downstream of ingestion reads a `profile` with `confirmed_at IS NULL`.
2. `application.status` may not advance to `filled` while any `application_answer` for it
   has `approved_at IS NULL`.
3. `application.submitted_at` is settable only by the explicit user-confirmation endpoint —
   no code path in filling or drafting can write it.
4. `job_posting.canonical_url` is unique; `(source_id, external_id)` is unique.
5. Every `match` with `eligibility = 'ineligible'` has at least one `blockers` entry, and
   every blocker cites a `job_requirement.source_quote`. No unexplained rejections.
6. Redlined field types (SSN, government ID, bank, payment, password) never appear in
   `application_answer` — they are recorded in `application.skipped_fields` only.

## Migrations

Drizzle Kit, forward-only, checked into `apps/server/drizzle/`. Every migration is
accompanied by a Vitest fixture asserting the invariants above still hold.
