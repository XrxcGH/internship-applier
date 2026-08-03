# 08 — Frontend

React 19 + TypeScript + Vite, Tailwind + shadcn/ui, TanStack Query for server state,
Zustand for the small amount of genuinely global UI state. Runs at
`http://127.0.0.1:5173`, proxying `/api` to the Fastify server.

## Design stance

The UI's job is to make the human gates feel like the point of the product rather than
speed bumps. Concretely:

- **The review queue is keyboard-first.** Triaging 40 postings should feel like triaging
  email, not filling out a form. `J`/`K` to move, `A` to approve, `S` to skip, `X` to
  reject, `Enter` to open detail.
- **Evidence is always one click away.** Every score, every filter decision, every
  generated claim shows its source. Nothing is asserted without a receipt.
- **Nothing destructive or outbound happens without a deliberate action.** Approve buttons
  are never the default focus. There is no bulk-approve.
- **Progress is legible.** Long operations (discovery runs, fills) stream real progress over
  SSE, including which source is being hit and what failed.

## Screens

### 1. Onboarding — `/setup`

A four-step wizard, resumable. This is where G1 lives.

| Step | Contents |
| --- | --- |
| **1 · Resume** | Drag-drop upload. Shows extraction progress. Supports re-upload; keeps history. |
| **2 · Confirm profile** *(G1)* | The extracted profile as a fully editable form, section by section (identity, education, experience, projects, skills, links). Fields the extractor was unsure about are highlighted amber and must be touched. Side-by-side view of the resume for checking. **Cannot be completed while `needs_review` is non-empty.** |
| **3 · Eligibility facts** | The things a resume doesn't contain and eligibility depends on: date of birth, work authorization + sponsorship need, citizenships, availability window (start/end), location base + max commute + relocation targets, remote preference. Each explains *why it's asked* — e.g. "Date of birth: many postings require 18+. Stored encrypted on your machine and never auto-filled into forms." |
| **4 · Your voice** | Paste 2–5 writing samples. Live word counter with a "good / enough / plenty" indicator. Shows the computed `StyleProfile` back to the user in plain language ("You write in short bursts with a lot of length variation, rarely use semicolons, and open with a concrete detail"). Skippable, with an explicit note that skipping means more editing later. |

### 2. Dashboard — `/`

At-a-glance: active applications by status, deadlines in the next 14 days, new matches
awaiting review, last discovery run summary, this month's LLM cost. Each card links into the
relevant screen. Empty states point at the next useful action.

### 3. Discover — `/discover`

- Source list with per-source enable toggle, last-run time, and health.
- **Editable query plan** — the generated queries shown as chips the user can remove or add
  to before running. Discovery isn't a black box.
- Company target list (add by name; shows resolved ATS).
- "Paste a job URL" box — the manual path for postings the tool won't scrape (doc 04).
- Run button → live SSE progress panel: per-source counters, errors, and a final summary
  that explicitly reports anything skipped or rate-limited.

### 4. Matches — `/matches`

The core screen. Split view: virtualized list left, detail right.

**List item** (compact, scannable): company · title · location · term badge · fit score bar ·
deadline chip (red under 7 days) · effort chip · eligibility badge (`eligible` /
`unknown`). Filtered-out items live in a collapsed "Filtered (N)" section at the bottom.

**Detail pane:**

- Header: role, company, location, term, compensation if stated, deadline, apply-effort
  estimate.
- **Requirement checklist** — every extracted requirement with a ✅/❌/❓, the verbatim JD
  quote, and which profile field decided it. This is the trust surface of the whole app.
- **Fit breakdown** — horizontal bars per dimension with the weight shown.
- **Rationale** — two or three sentences including the honest "here's why you might not get
  it."
- Full JD, collapsible.
- Actions: **Approve & draft** (G2) · Save for later · Skip · Reject (opens a reason
  selector).

The approve action opens a confirmation that names the company and role and states what
happens next ("This will open the application page and draft your answers. Nothing will be
submitted."). One posting at a time; there is no multi-select.

### 5. Application workspace — `/applications/:id`

Where G3 lives. Three panes.

**Left — question list.** Every field the form asks for, grouped: auto-fillable (green),
needs-a-written-answer (amber until approved), needs-you (redlined/unknown, blue).
Per-question approval state is visible at a glance.

**Center — answer editor.** For the selected question:

- The question exactly as it appears on the form + length limit + live character counter.
- Editable draft with claim highlighting inline (green/amber/red per FactGuard verdict).
- Flag list with one-click fixes ("rewrite this span", "add this fact to my profile").
- **Edit-distance meter.** Approving with zero edits triggers a dialog: *"You haven't
  changed anything. Read it once more — you're the one signing this."*
- Approve button, disabled while any red flag is unresolved.

**Right — evidence.** The profile facts backing the current answer, each with a link to the
profile field; plus the posting requirements relevant to this question.

**Footer — fill controls.** "Preview fill" (dry run, shows what would be entered) and
"Fill form" (disabled until every answer is approved). During a fill, a live step log
streams over SSE alongside the visible browser window.

**Pre-submit review** — a full-screen modal after filling: the page screenshot, a
field-by-field table of what was entered, every essay in full, and the checklist of
redlined/skipped fields the user still has to handle. Then a clear instruction: *"Review the
form in the browser window and click Submit yourself. Come back here when you have."* with
an "I submitted this" confirmation button (the only thing that writes `submitted_at`) and a
"Didn't submit" escape.

### 6. Tracker — `/tracker`

Kanban by status (`draft` → `submitted` → `acknowledged` → `interview` → `offer` /
`rejected` / `ghosted`), plus a table view with sort/filter and CSV export. Per-application
detail shows the timeline, the exact answers submitted, and the screenshot. Deadline and
follow-up reminders appear here as **drafts only** — the tool never sends email.

### 7. Settings — `/settings`

- Profile (re-open the G1 form anytime; edits recompute `derived` and re-run matching).
- Resumes and documents.
- Writing samples and the computed style profile.
- Answer library — view, edit, and approve canonical answers.
- Sources and API keys (Anthropic, search provider, USAJOBS, Adzuna).
- Scoring weights, with learned adjustments shown and a reset button.
- **Privacy** — what's stored where, export everything as JSON, and delete everything
  (with a real confirmation, not a toast).
- Cost — token usage and spend by purpose, from `llm_call`.

## Component inventory

| Component | Used by |
| --- | --- |
| `ResumeDropzone` | Onboarding |
| `ProfileEditor` (+ per-section subforms) | Onboarding, Settings |
| `EligibilityFactsForm` | Onboarding, Settings |
| `WritingSampleEditor` / `StyleProfileCard` | Onboarding, Settings |
| `QueryPlanEditor` / `SourceHealthList` / `RunProgressPanel` | Discover |
| `MatchList` (virtualized) / `MatchCard` / `MatchDetail` | Matches |
| `RequirementChecklist` | Matches, Workspace |
| `ScoreBreakdown` | Matches |
| `RejectReasonDialog` | Matches |
| `QuestionList` / `AnswerEditor` / `ClaimHighlighter` / `EvidencePanel` / `FlagList` | Workspace |
| `EditDistanceMeter` | Workspace |
| `FillProgressLog` / `PreSubmitReview` | Workspace |
| `KanbanBoard` / `ApplicationTimeline` | Tracker |
| `CostPanel` / `DataPrivacyPanel` | Settings |

## State management

**Server state → TanStack Query.** Query keys mirror the API: `['matches', filters]`,
`['application', id]`, `['profile']`. SSE events invalidate the relevant keys rather than
the UI polling.

**Client state → Zustand**, deliberately small:

```ts
type UiStore = {
  selectedMatchId: string | null;
  selectedQuestionId: string | null;
  keyboardMode: boolean;
  runPanelOpen: boolean;
  filters: MatchFilters;
};
```

**Form state → React Hook Form + Zod**, sharing the exact schemas from
`packages/shared` that the API validates against. One schema, both ends.

## Real-time

One SSE stream at `GET /api/events`. Event types: `discovery.progress`, `discovery.done`,
`extraction.progress`, `draft.progress`, `fill.step`, `fill.needs_input`, `task.failed`.
The client maps each to a Query invalidation plus, where relevant, a live progress panel.
Reconnect with exponential backoff; on reconnect, refetch rather than assume continuity.

## Accessibility and polish

- Every interactive element reachable and operable by keyboard; visible focus rings.
- Radix primitives give correct dialog/combobox/tooltip semantics and focus trapping.
- Colour is never the only signal — flags carry icons and text labels alongside red/amber/green.
- Light and dark themes via CSS variables, following the OS preference.
- Long lists virtualized (`@tanstack/react-virtual`); a 2,000-posting queue must stay smooth.
- Optimistic updates for triage actions (approve/skip/reject), with rollback on error.
