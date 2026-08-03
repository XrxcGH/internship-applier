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

## Human-cadence typing — and why

Fills use `locator.pressSequentially()` with small randomized inter-key delays (40–120ms)
rather than `fill()`, for a purely mechanical reason: React/Vue-controlled inputs,
autocomplete comboboxes, and rich-text editors frequently ignore programmatic value
assignment and only update on real key events. Instant `fill()` breaks them.

That is the whole rationale. The design deliberately does **not** include canvas/WebGL
fingerprint spoofing, proxy or IP rotation, user-agent randomization, or timing models
tuned against bot-detection heuristics. The browser identifies as what it is.

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

`unknown` fields are **left blank** and surfaced in a "Needs your input" panel with a
cropped screenshot of the field. They are never guessed at.

Learned mappings are cached per `(ats_vendor, normalized_label)` so the same field on the
next Greenhouse form is free.

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
- **multi-step** — advance only after the current step validates; capture a screenshot per
  step; on validation failure, stop and report which field the site rejected.

Every write is verified by read-back. A field that didn't take is reported, not assumed.

## The submit gate (G4)

The strongest structural guarantee in the system.

1. Filling completes. A full-page screenshot is captured to `application.screenshot_path`.
2. The UI shows a **pre-submit review**: field-by-field what was filled, the full text of
   every essay answer, the list of skipped/redlined fields still needing the user, and the
   screenshot.
3. The submit button is **located but not clicked**. The tool scrolls it into view and
   highlights it in the visible browser.
4. The user clicks Submit themselves, in the browser.
5. The user confirms in the app that they submitted. Only that endpoint writes
   `application.submitted_at`.

There is no `autoSubmit` setting, no `--yes` flag, and no code path in `filling/` that can
click a submit control. `locateSubmit` returns a `Locator`; nothing in the module calls
`.click()` on it. This is asserted by a test that greps the module for submit-click patterns
and by a runtime guard that throws if a submit-like element is clicked during a fill run.

## Testing

- **Fixture site** (`packages/fixtures`) — a local Express app serving deliberately nasty
  forms: React-controlled inputs, shadow-DOM widgets, an iframe form, a 4-step wizard, a
  fake login wall, a combobox with near-miss options, and a page containing every redlined
  field type. Playwright tests run headless against it in CI.
- **Recorded page snapshots** — saved HTML from real ATS pages (scrubbed of PII) as
  regression fixtures for `formMap` + `classify`. No network, no real submissions.
- **Redline test** — asserts that no redlined field is ever written, on every fixture.
- **Dry-run mode** — `--dry-run` maps and plans the fill, prints what it *would* enter, and
  touches nothing. Available in the UI as "Preview fill."
