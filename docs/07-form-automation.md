# 07 — Form automation

Fills application forms in a **visible** browser so the user watches it happen and reviews
the real page before submitting. It does not submit.

## Browser

Playwright Chromium, launched via `launchPersistentContext` against
`data/browser-profile/`, **headed by default**. Headless is used only for the local test
fixture site.

Why persistent: many ATS platforms require an account, and a persistent profile means the
user logs in once per vendor and the session survives. Storage state per domain is
referenced from `credential_ref` — which stores **a path to a Playwright storage-state file,
never a password**.

### Login handling

When a fill run hits a login wall:

1. The run pauses.
2. The UI says: *"This site needs you to be signed in. Log in in the browser window that's
   open, then click Continue."*
3. The user logs in themselves. The tool does not type into password fields, does not
   create accounts, and does not read credentials from a password manager.
4. On Continue, storage state is saved and the run resumes.

Same for CAPTCHAs and any bot-check challenge: pause, hand it to the user, resume. There is
no solving, no bypass, no third-party solver integration.

## Typing rather than assigning — and why

Fills use `locator.pressSequentially()` rather than `fill()`, for a purely mechanical
reason: React/Vue-controlled inputs, autocomplete comboboxes, and rich-text editors
frequently ignore programmatic value assignment and only update on real key events.
Instant `fill()` breaks them. The fixture's `/nasty` page reproduces this exactly, and
`fill.test.ts` asserts both halves of it.

That is the whole rationale. The design deliberately does **not** include canvas/WebGL
fingerprint spoofing, proxy or IP rotation, user-agent randomization, or timing models
tuned against bot-detection heuristics. The browser identifies as what it is.

**On the delay between keystrokes.** This originally specified 40–120ms, described as
"human cadence". That framing was wrong and the number was a guess. What makes hostile
widgets work is that key events fire *at all*; the pacing only buys time for a debouncing
widget to keep up. Measuring it showed the cost — the fill suite spent 76 seconds almost
entirely asleep between keystrokes — so it is now **10–30ms**, and **0 for text over 120
characters**, where an essay would otherwise cost a minute a field. The commit-on-key
fixture still passes, which is the property that actually matters.

Two control types opt out of typing entirely:

- **`date`** holds a structured value, not text. Typing an ISO string into a segmented
  date editor produces nothing; `fill()` is the only thing that sets it.
- **`combobox`** (the div-based kind) has no value to set at all. It gets opened and an
  option gets clicked, the same way a person would.

## Building a FormMap

Before filling anything, the page is read into a semantic map:

```ts
type FormField = {
  id: string;
  locator: string;                 // stable Playwright selector
  label: string;                   // resolved from <label>, aria-label, aria-labelledby,
                                   // placeholder, or nearest preceding text node
  control: 'text' | 'textarea' | 'select' | 'multiselect' | 'radio' | 'checkbox'
         | 'file' | 'date' | 'combobox' | 'richtext';
  required: boolean;
  maxLength?: number;
  options?: Array<{ value: string; label: string }>;
  semantic: FieldSemantic;         // what it MEANS — see below
  confidence: number;
  step?: number;                   // multi-step wizards
  frame?: string;                  // iframe path if nested
};

type FieldSemantic =
  | 'first_name' | 'last_name' | 'full_name' | 'email' | 'phone'
  | 'address_line1' | 'city' | 'region' | 'postal' | 'country'
  | 'linkedin' | 'github' | 'portfolio' | 'website'
  | 'school' | 'degree' | 'major' | 'gpa' | 'graduation_date' | 'enrollment_status'
  | 'resume_upload' | 'cover_letter_upload' | 'transcript_upload'
  | 'work_auth' | 'sponsorship_needed' | 'start_date' | 'end_date' | 'hours_available'
  | 'essay'            // free-text question → writing engine
  | 'referral_source' | 'salary_expectation'
  | 'REDLINE'          // never auto-filled — see below
  | 'unknown';
```

### Classification

Two-stage, cheap-first:

1. **Deterministic matcher.** A rule table over normalized label + `name` + `id` +
   `autocomplete` attributes. Handles the ~80% of fields that are recognizable
   (`autocomplete="email"`, `name="first_name"`, label "Graduation Date"). Zero cost, fully
   testable, high precision.
2. **LLM fallback** (`claude-haiku-4-5`, structured output) for the remainder. Gets the
   label, surrounding text, control type, and options; returns `{semantic, confidence}`.
   Low confidence (< 0.75) → treated as `unknown`.

`unknown` fields are **left blank** and surfaced for the user by label. They are never
guessed at. There is no cropped screenshot of the field, as this section used to promise —
nothing in the app captures a screenshot at all; see § The submit gate below.

> **Not built:** stage 2. Nothing in the classification path calls a model — there is no
> `claude-haiku-4-5` request, and the descriptor stage 1 works from carries no
> surrounding-text field for a model to read, so the seam that would feed one does not exist
> either. What ships is stage 1 and the `unknown` behaviour above: a field the rule table
> cannot name is left blank and handed to the user. That is the safe half of the two-stage
> design, so its absence costs coverage rather than correctness — the fields it would have
> recovered are the odd, one-off custom questions, and today those are all typed by hand.

> **Not built:** the classification cache. There is no store keyed on
> `(ats_vendor, normalized_label)`, so every field is classified from scratch on every run.
> Stage 1 is a rule table and costs nothing, so what a cache would really save is a repeat
> model call on the same odd label from the same vendor — worth having, not there yet.

## Redlines — fields that are never auto-filled

Hard-coded, not configurable. Detected by semantic classification *and* by a keyword
blocklist over labels, so a mislabeled field still gets caught.

| Category | Examples | Behavior |
| --- | --- | --- |
| Government/financial identifiers | SSN, SIN, national ID, passport number, driver's license, bank account, routing, credit card | Skipped. Listed for the user. The tool never stores these either. |
| Credentials | password, security questions | Skipped. |
| Attestations | "I certify the information above is true and complete", signature fields, e-sign | Skipped — this is a personal legal statement. |
| Consent | terms of service, privacy policy, background-check authorization, marketing opt-in | Skipped — consent is the user's to give. |
| EEO / demographic self-ID | race, ethnicity, gender, veteran status, disability status | Skipped — voluntary self-identification, and not the tool's to answer. |
| AI-disclosure | "Did you use AI to write any part of this application?" | Skipped and **highlighted** for the user with a note that it needs their answer. |

Every redlined field lands in `application.skipped_fields` and is enumerated in the
pre-submit checklist, so the user knows exactly what's left to do.

## ATS adapters

Strategy pattern over a common interface; a generic adapter handles the long tail.

```ts
interface AtsAdapter {
  vendor: AtsVendor;
  detect(page: Page): Promise<boolean>;
  mapForm(page: Page): Promise<FormMap>;      // may override generic mapping
  fill(page: Page, plan: FillPlan): Promise<FillResult>;
  locateSubmit(page: Page): Promise<Locator | null>;  // located, never clicked
}
```

| Adapter | Notes |
| --- | --- |
| `greenhouse` | Simple, single-page, predictable `name` attributes. Best case. |
| `lever` | Single-page, clean. Custom question blocks need label resolution. |
| `ashby` | React-heavy; requires key events, not `fill()`. Comboboxes need option matching. |
| `smartrecruiters` | Multi-section, moderate. |
| `workday` | **The hard one.** Multi-step wizard, heavy shadow DOM, dynamic IDs, per-step validation, account creation gate. Gets step-aware state, per-step screenshots, and generous waits. |
| `icims` / `taleo` | Legacy, iframe-heavy, frequently server-rendered. |
| `generic` | Pure `FormMap`-driven. Handles anything that isn't recognized. |

Detection order: URL host → embedded script fingerprints → DOM markers → `generic`.

> **Not built:** any of the per-vendor adapters, and the interface above is the design
> rather than shipped code — there is no `locateSubmit`, and nothing takes the per-step
> screenshots the Workday row describes. What runs today is the generic `FormMap`-driven
> path, which handles all of these in principle because it works from labels and roles
> rather than vendor markup, but has never been pointed at a real posting from any of them.
> docs/11 § M6 has the detail.

## Filling

Per field, by control type:

- **text/textarea** — `pressSequentially`, respecting `maxLength`; verify the value stuck by
  reading it back.
- **select** — match by option `value`, then exact label, then normalized label, then
  fuzzy. Below a similarity threshold, leave blank and flag.
- **combobox/autocomplete** — type a prefix, wait for the listbox, select by exact match.
  If no exact match appears, blank + flag. Never picks "close enough" on a combobox.
- **radio/checkbox** — click by resolved label. (Never for redlined categories.)
- **date** — try native `input[type=date]` first; else drive the picker widget; verify the
  resulting value.
- **file** — `setInputFiles` with the primary resume, plus generated cover letter / transcript
  when the field asks for them.
- **richtext** — focus and type; verify via `innerText`.
- **multi-step** — advance only after the current step validates; on validation failure,
  stop and report which field the site rejected. No screenshot is taken per step, or ever.

Every write is verified by read-back. A field that didn't take is reported, not assumed.

## The submit gate (G4)

The strongest structural guarantee in the system.

1. Filling completes. The browser stays open, on the form, with the values in place.
2. The UI shows a **pre-submit review**: field by field what was filled, the full text of
   every essay answer, every read-back that did not match what was typed, and the list of
   skipped and redlined fields still needing the user.
3. The user finds the submit button and clicks it themselves, in the browser.
4. The user confirms in the app that they submitted.

There is no `autoSubmit` setting, no `--yes` flag, and no code path in `filling/` that can
click a submit control.

**How that is actually enforced**, because a promise is worth what its enforcement is worth:

- an ESLint `no-restricted-syntax` rule that fails the build on a submit-shaped click,
  `requestSubmit()`, `form.submit()`, or an Enter keypress inside the filling module;
- a test that scans the module's own source for the same patterns, so the rule cannot be
  silenced with a disable comment without the test noticing;
- a fixture test asserting the mock ATS recorded **zero** POSTs across the entire suite;
- and a CI grep for any endpoint that could write `submitted_at` without the user.

Two things this section used to claim were never built, said plainly rather than quietly
dropped. **No screenshot is captured** — `application.screenshot_path` exists in the schema
and nothing writes it. **The submit button is not located or highlighted** — there is no
`locateSubmit`, and the tool never touches that control at all. The enforcement above is
static and behavioural; there is no runtime guard.

## Testing

- **Fixture site** (`packages/fixtures`) — a dependency-free `node:http` server (the package
  declares no dependencies at all) serving deliberately nasty forms: React-controlled
  inputs, shadow-DOM widgets, an iframe form, a 3-step wizard, a fake login wall, a combobox
  with near-miss options, and a page containing every redlined field type. Playwright tests
  run headless against it in CI.
- **Recorded page snapshots** — saved HTML from real ATS pages (scrubbed of PII) as
  regression fixtures for `formMap` + `classify`. No network, no real submissions.
- **Redline test** — asserts that no redlined field is ever written, on every fixture.
- **The plan step** — `buildFillPlan` produces the complete list of intended values, with a
  reason attached to every skip, before anything is typed. It is a pure function over the
  form map, the profile and the approved answers, so most of what a dry run would tell you
  is assertable in a unit test with no browser at all.

> **Not built:** a `--dry-run` flag or a "Preview fill" control. docs/08 and docs/09
> described both; neither exists. The plan above is the closest real thing, and it is not
> currently surfaced on its own before a run.
