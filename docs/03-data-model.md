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

source ──M:N──▶ job_posting ──1:N──▶ job_requirement
  (via job_posting_source)
                     │
                     └──1:1──▶ match ──▶ decision
                                  │
                                  └──1:1──▶ application ──1:N──▶ application_answer
                                                  └──1:N──▶ application_event

task · llm_call · setting · credential_ref · filter_preset      (cross-cutting)
```

## Core tables

### `profile`

One row. The confirmed identity and eligibility facts everything else keys off.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text pk | |
| `full_name` 🔒 | text | |
| `pronouns` 🔒 | text | Stated on the resume or entered at G1. Shown for the user's reference; **never typed into a form** — a pronoun question is self-identification and the redline list leaves it to the user. Nullable. |
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
| `location_prefs` | json | `{base, additional_bases[], max_commute_km, remote_ok, hybrid_ok, relocate_to[]}` — `base` is the address a form is filled from; `additional_bases` are further places you can work in person, equal to it for searching and matching |
| `preferences` | json | `{company_sizes[], industries[], min_stipend?, exclude_companies[], role_families[]}` — `role_families` empty means "infer from the resume"; non-empty replaces that inference |
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
  gpa?: { value: number; scale: number; weighted?: number };  // weighted may exceed scale
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

### `source` / `job_posting_source` / `job_posting` / `job_requirement`

`source`: `id`, `kind` (`greenhouse` \| `lever` \| `ashby` \| `usajobs` \| `adzuna` \| `github_list` \| `manual` \| …), `label`, `config` json, `enabled`, `last_run_at`, `last_status`.

`job_posting_source` is the provenance join, and the reason `job_posting` carries no
`source_id`: the same job turns up on Greenhouse and on Adzuna, dedupe merges the two rather
than keeping both, and a merged posting has to remember every source that saw it — otherwise
the UI can't say "found on Greenhouse + Adzuna" and a source going dark silently loses
postings. Columns: `posting_id` fk, `source_id` fk, `external_id` (that source's own ID for
this posting), `seen_at`. Unique on `(posting_id, source_id)`.

`job_posting`:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text pk | |
| `external_id` | text | The ID carried by whichever copy of the posting was persisted first. Per-source IDs live in `job_posting_source`; this is a convenience, not the provenance |
| `canonical_url` | text | Unique index — first dedupe key |
| `apply_url` | text | Often differs from the listing URL |
| `company` / `company_domain` | text | |
| `title` | text | |
| `description_html` / `description_text` | text | |
| `locations` | json | `{city, region, country, remote}[]` |
| `position_type` | text | `internship` \| `co_op` \| `fellowship` \| `apprenticeship` \| `research` \| `new_grad` \| `part_time` \| `seasonal` \| `contract` \| `externship` \| `trainee_program` \| `volunteer`. **Null means the posting didn't say** — never read as a mismatch |
| `work_arrangement` | text | `onsite` \| `hybrid` \| `remote` \| `remote_geo_restricted` \| `field_or_travel`, nullable on the same terms |
| `hybrid_days_onsite` | integer | Days per week on site, when a hybrid posting states one |
| `remote_eligible_in` | json | `string[]` — states/countries a remote posting restricts you to |
| `program_flags` | json | `ProgramFlag[]` — diversity, first-year, returnship, rotational, … |
| `requires` | json | What the application itself demands: `{coverLetter?, transcript?, portfolio?, references?, videoInterview?, account?}` |
| `term` | json | `{season, year, start?, end?, durationWeeks, multiTerm}`; `season`/`year` null when the parser couldn't tell |
| `compensation` | json | `{min?, max?, currency?, period?, unpaid?, academicCreditOnly?, raw?, …}` |
| `posted_at` / `closes_at` | text | `closes_at` nullable |
| `is_open` | integer | Cleared by `refresh.ts`, and by a discovery run when a source itself reports the posting closed (docs/04 § SourceResult) |
| `ats_vendor` | text | Detected: greenhouse/lever/ashby/workday/icims/taleo/smartrecruiters/workable/unknown |
| `apply_effort` | json | `{steps, essayCount, requiresAccount, estMinutes}`. **Nothing writes it**: no adapter, no refresh and no manual-posting path sets it, so it is always null and the Application-effort dimension in docs/05 scores every posting the same neutral 0.6 |
| `fingerprint` | text | `company \| normalized title \| primary city` — second dedupe key, indexed |
| `embedding` | blob | Reserved for similarity search. **Nothing writes it**: dedupe stage 3 is token-set equality over titles, not embeddings (docs/04 § Dedupe) |
| `requirements_extracted_at` | text | When requirements were last extracted, whatever the outcome. Null and "extracted, found none" are different states and the cache has to tell them apart |
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

`match`: `id`, `posting_id`, `profile_id`, `eligibility` (`eligible` \| `ineligible` \| `unknown`), `rules` json (every `RuleResult`, pass and fail alike), `blockers` json (just the failures), `score` (0–100), `breakdown` json, `rationale` text, `computed_at`. Unique on `(posting_id, profile_id)`.

Both `rules` and `blockers` are stored, not just the failures: the requirement checklist in
the review queue shows what passed as well as what didn't, and recomputing it from the
posting on every render would be a different answer from the one the user was shown.

`decision`: `id`, `match_id`, `action` (`approved` \| `skipped` \| `rejected` \| `saved`), `reason` text, `reason_tags` json, `decided_at`. Rejection reasons are captured for preference learning, which is **not built** — nothing reads `reason_tags` yet (docs/05 § Preference learning). The tags are collected against the day it is, and the guardrail then is that a learned weight may reorder the queue but may never auto-reject a posting without showing why.

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
| `screenshot_path` | text | Final pre-submit full-page capture. **Nothing writes it** — no screenshot is captured anywhere in the app (docs/07 § G4). The column is kept because the pre-submit review is the place one would belong. |
| `skipped_fields` | json | Redlined/unclassifiable fields the user must handle |
| `notes` | text | Plaintext — no writer yet. This carried a 🔒 while nothing in the app wrote it at all, which promised a protection that did not exist and would have had whoever built the first notes feature take the column as handled. Whatever writes it must call `encryptField(value, applicationId)` and add the 🔒 in the same commit |

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

`application_event`: `id`, `application_id`, `type`, `payload` json, `at`.

The types the code actually writes are `created`, `answer_approved`, `filled`,
`marked_submitted` and `status_changed`. This list previously named `answers_drafted`,
`submitted`, `email_received` and `note` — none of which anything emits — and spelled
`answer_approved` as a plural, so a reader grepping for the documented name found nothing.
Email ingestion is not built; see docs/11.

### `answer_template`

The reusable answer library. `id`, `question_key` (`why_this_company`, `greatest_strength`,
`describe_a_project`, …), `canonical_text`, `variants` json, `use_count`, `last_used_at`,
`approved_at`. Templates are user-approved once and adapted per application — this reduces
generation risk and keeps a consistent story across applications.

### Cross-cutting

- **`task`** — `id`, `kind`, `payload` json, `status` (`queued`\|`running`\|`done`\|`failed`\|`cancelled`), `attempts`, `max_attempts`, `run_after`, `started_at`, `finished_at`, `error`, `progress` json. **There is no queue and no worker loop** — neither was built. Only
`kind: 'discovery_run'` rows are ever written, by `runDiscovery` after a run has finished, so
`GET /api/discovery/runs/:id` can answer about it afterwards; every other column here is
part of a design that was never used. See docs/02 § Concurrency.
| `cost_usd_micros` | integer | Micro-dollars — `Math.round(usd * 1_000_000)`, so an integer column holds a fraction of a cent without float drift. Divide by 1e6 to read it as dollars. |
- **`credential_ref`** — `id`, `domain`, `label`, `storage_state_path`, `last_used_at`. **Never stores passwords.** Points at a Playwright storage-state file the user created by logging in themselves.
- **`filter_preset`** — `id`, `name` (unique), `description`, `filters` json, `is_default`, `created_at`, `updated_at`. The named, saved filter sets in docs/05 § Presets. The table and the starter set exist; **no feature reads or writes either yet** — the one thing that touches the table is the privacy export, which includes it so that "everything stored" means everything.
- **`setting`** — key/value JSON for app config the user can change in the UI. **Nothing writes it yet**: there is no settings API, and configuration comes from environment variables (docs/09 § Cost & privacy).

## Invariants

Enforced in code, and where possible as DB constraints or triggers:

1. Nothing downstream of ingestion reads a `profile` with `confirmed_at IS NULL`.
2. Gate G3 — no form is filled from an answer the user has not approved. `load()` in
   `routes/filling.ts` refuses to start or continue a fill run while any
   `application_answer` for the application has `approved_at IS NULL`, and that is the
   boundary that matters, because it is the only one on the way to an employer's page.

   **This is not a constraint on the `status` column, and this list used to say it was.**
   `POST /api/applications/:id/status` checks `canTransition` and nothing else, and
   `answers_ready → filled` is a legal user transition, so a client can set the status to
   `filled` with every answer unapproved: the tracker board then shows `filled` and the CSV
   export says `filled` for an application whose answers have never been read. There is no
   DB trigger either. Nothing has been filled — G3 held where it counts — but the column
   lies, and anyone auditing this list was told a check existed that did not.
3. `application.submitted_at` is written only where the user themselves says the application
   was submitted. Two endpoints do that: `POST /api/applications/:id/mark-submitted`, and
   `POST /api/applications/:id/status` when the target status is `submitted`. Both are
   reached only by a person clicking something, both record the actor as `user` in
   `application_event`, and both keep the first timestamp rather than overwriting it. No code
   path in filling or drafting can write it — which is the whole of gate G4, and the count of
   endpoints is not what makes it hold.
4. `job_posting.canonical_url` is unique, and `job_posting_source` is unique on
   `(posting_id, source_id)` so re-running discovery re-links rather than duplicating
   provenance. There is deliberately no unique index on an external ID: two sources number
   the same job differently, and a posting is identified by its URL or its fingerprint.
5. Every `match` with `eligibility = 'ineligible'` has at least one `blockers` entry, and
   every blocker cites a `job_requirement.source_quote`. No unexplained rejections.
6. Redlined field types (SSN, government ID, bank, payment, password) never appear in
   `application_answer` — they are recorded in `application.skipped_fields` only.

## Migrations

Drizzle Kit, forward-only, checked into `apps/server/drizzle/`. Every migration is
accompanied by a Vitest fixture asserting the invariants above still hold.
