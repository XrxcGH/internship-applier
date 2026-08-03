# 05 — Matching: eligibility and fit

Two distinct stages with different trust models.

**Eligibility is deterministic.** Hard rules run in pure TypeScript over structured fields.
A model never decides whether the user qualifies for something. Outcome is a tri-state:
`eligible` / `ineligible` / `unknown` — never a silent drop.

**Fit is advisory.** A 0–100 score with a visible per-dimension breakdown, used only for
ordering the review queue. It never filters anything out on its own.

## Stage 0 — Requirement extraction

Turns unstructured JD text into `job_requirement` rows. This *is* an LLM call
(`claude-opus-5`, structured output, `strict: true`), and it is deliberately narrow: it
extracts and quotes, it does not judge.

```ts
const RequirementSchema = z.object({
  requirements: z.array(z.object({
    kind: z.enum(['age','education_level','graduation_window','enrollment','work_auth',
                  'citizenship','location','term_dates','experience_years','skill','other']),
    operator: z.enum(['min','max','equals','one_of','between','present']),
    value: z.unknown(),                       // typed per kind, validated after parse
    necessity: z.enum(['required','preferred','unclear']),
    sourceQuote: z.string(),                  // MUST be verbatim from the JD
    confidence: z.number().min(0).max(1),
  })),
});
```

Two guards on the output:

1. **Quote verification.** Every `sourceQuote` is checked to actually appear in
   `description_text` (whitespace-normalized). A hallucinated quote drops that requirement
   and logs a warning — an invented requirement could wrongly disqualify the user.
2. **Value typing.** `value` is re-validated against a per-`kind` Zod schema after parsing.
   Anything that fails becomes `kind: 'other'` with `necessity: 'unclear'`, which routes to
   `unknown` rather than to a rejection.

Caching: requirements are extracted once per posting and reused across profile changes.
The prompt prefix (system + extraction schema + few-shot) is stable and cached.

## Stage 1 — Hard eligibility rules

Each rule is a pure function, individually unit-tested, returning a `RuleResult`:

```ts
type RuleResult = {
  rule: string;
  status: 'pass' | 'fail' | 'unknown' | 'not_applicable';
  because: string;            // human-readable, shown in the UI
  requirementId?: string;     // links to the verbatim JD quote
  profileRef?: string;        // which profile field decided it
};

type EligibilityRule = (p: ConfirmedProfile, j: JobPosting, r: JobRequirement[]) => RuleResult;
```

### The rules

| Rule | Logic | On missing data |
| --- | --- | --- |
| `age_minimum` | `profile.derived.age >= req.value`. Common values: 16, 18. | If DOB absent → `unknown` + prompt the user to add it (it's the single highest-value missing field). |
| `age_work_permit` | If `isMinor` and jurisdiction requires a work permit / restricts hours for the posting's location, attach an advisory (not a fail) with what's needed. | `unknown` |
| `education_level` | `profile.derived.academicLevel` ∈ required set. Handles "currently enrolled in a Bachelor's" vs "must have completed". | `unknown` |
| `enrollment_status` | Many internships require active enrollment during the term or return-to-school after. Checks `education[].endDate` against `term`. | `unknown` |
| `graduation_window` | `expectedGraduation` within `[min, max]`. Very common ("graduating Dec 2027 – Jun 2028") and a frequent silent disqualifier. | `unknown` |
| `work_authorization` | If posting requires authorization without sponsorship and `profile.work_authorization.needs_sponsorship` → `fail`. | `unknown` |
| `citizenship` | Federal/defense postings requiring US citizenship or a clearance. Checked against `profile.citizenships`. | `unknown` |
| `location` | Onsite/hybrid: `primaryLocation` within `max_commute_km` of `location_prefs.base`, or in `relocate_to`. Remote: pass, subject to any stated geo restriction. | `unknown` |
| `term_overlap` | Posting term must overlap `profile.availability` by ≥ 6 weeks (configurable). | `unknown` |
| `deadline` | `closes_at` in the future (with a 24h grace warning band). | pass |
| `posting_open` | `is_open = 1`. | `fail` |
| `experience_ceiling` | `fail` if required professional years > `derived.yearsProfessionalExperience + tolerance` (default tolerance 1). Catches "internships" wanting 3+ years. | pass |
| `excluded_company` | `company` ∈ `preferences.exclude_companies`. | pass |

`eligibility` = `ineligible` if any rule fails; else `unknown` if any rule is unknown; else
`eligible`.

### How the three states are presented

- **eligible** — in the queue, ranked by fit.
- **unknown** — in the queue, badged, with the specific unresolved question stated
  ("This posting's graduation window couldn't be parsed — here's what it says: '…'"). The
  user decides. Unknowns are shown *below* eligible items but never hidden.
- **ineligible** — collapsed into a "Filtered (N)" drawer, expandable, each with its
  blocker and the verbatim JD quote that caused it. This exists so the user can catch the
  tool being wrong. A filter you can't inspect is a filter you can't trust.

## Stage 2 — Fit scoring

Weighted sum over normalized dimensions. Weights live in `settings` and are user-adjustable.

| Dimension | Default weight | Computation |
| --- | --- | --- |
| Required-skill coverage | 30 | Fraction of `necessity: 'required'` skill requirements matched by `derived.skillIndex`. Exact + alias + embedding-similarity match, in that order of confidence. |
| Preferred-skill coverage | 12 | Same over `preferred`. |
| Role-family alignment | 18 | Cosine similarity between the posting title/description embedding and the user's role-family vector. |
| Domain/interest match | 10 | Company industry vs `preferences.industries`. |
| Seniority fit | 10 | Distance between required experience and `derived.seniorityBand`. Penalizes both over- and under-shooting. |
| Location desirability | 8 | Remote / base city / relocation target, ranked by stated preference. |
| Compensation | 6 | Only when disclosed; unstated compensation is neutral, never penalized. |
| Application effort | 6 | Inverse of `apply_effort.estMinutes` + essay count. A one-click Greenhouse form outranks a 40-minute Workday wizard, all else equal. |

Score is clamped 0–100 and stored with the full breakdown so the UI can show the bars.

**`rationale`** is a 2–3 sentence explanation generated from the breakdown — and it is
required to include the honest downside. The prompt asks explicitly for "the strongest
reason to apply and the most likely reason you'd be rejected," both grounded in the
breakdown and the requirement quotes. A ranking tool that only tells you why things are
good is a ranking tool you stop believing.

## Preference learning

Rejections carry structured `reason_tags` (`wrong_role`, `wrong_location`, `company`,
`too_senior`, `low_pay`, `effort`, `not_interested`). These adjust dimension weights *within
a bounded range* and only after enough signal (default: 5 rejections sharing a tag).

Two guardrails:

- Learned weights are shown in Settings with a "why" and a one-click reset.
- Learning only ever reorders. It never converts an `eligible` posting into a hidden one.

## Testing

`eligibility.ts` is the highest-stakes module in the system — a bug there silently costs the
user opportunities. It gets:

- A golden fixture set of ~60 real anonymized JD excerpts with hand-labeled expected
  outcomes, covering each rule's pass/fail/unknown paths.
- Property tests: no rule may return `fail` without a `requirementId`; `unknown` inputs can
  never produce `fail`; adding a profile fact can never turn `eligible` into `ineligible`
  for an unchanged posting.
- A regression test per bug found, forever.
