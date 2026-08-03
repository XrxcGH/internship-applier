# 09 — API

Fastify, bound to `127.0.0.1:8787` only. JSON over REST, plus one SSE stream. Every request
body and response is validated with a Zod schema from `packages/shared`, so the frontend and
backend can't drift.

**Auth:** none — loopback-only, single user, single machine. A random per-run token is
required in an `X-App-Token` header purely to stop other local processes and stray browser
pages from reaching the API; the frontend receives it from the Vite dev server / the served
`index.html`. CORS is locked to the local origin.

Errors use a consistent envelope:

```jsonc
{ "error": { "code": "PROFILE_NOT_CONFIRMED", "message": "…", "details": {} } }
```

## Profile & documents

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/profile` | Current profile incl. `derived` and `needs_review`. |
| `PUT` | `/api/profile` | Update fields. Recomputes `derived`. Does **not** confirm. |
| `POST` | `/api/profile/confirm` | **G1.** Rejects with `PROFILE_INCOMPLETE` while `needs_review` is non-empty. Sets `confirmed_at`. |
| `POST` | `/api/resumes` | Multipart upload. Returns `{ documentId, taskId }`; extraction runs as a task. |
| `GET` | `/api/resumes` | List documents. |
| `POST` | `/api/resumes/:id/primary` | Set the default resume for applications. |
| `DELETE` | `/api/resumes/:id` | Delete document + file from disk. |
| `POST` | `/api/resumes/:id/extract` | Re-run extraction (e.g. after a prompt improvement). |

## Writing voice

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` `DELETE` | `/api/writing-samples[/:id]` | Manage samples. |
| `POST` | `/api/style-profile/compute` | Recompute `StyleProfile` from current samples. |
| `GET` | `/api/style-profile` | Metrics + the plain-language summary shown in the UI. |
| `GET` `PUT` | `/api/answer-templates[/:id]` | The reusable answer library. |
| `POST` | `/api/answer-templates/:id/approve` | Mark a canonical answer user-approved. |

## Discovery

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `PUT` | `/api/sources[/:id]` | List/enable/configure sources; includes health + last run. |
| `POST` | `/api/discovery/plan` | Returns the planned queries for review. Runs nothing. |
| `POST` | `/api/discovery/run` | Body: `{ queries?, sourceIds?, companyTargets? }` → `{ runId, taskId }`. Progress via SSE. |
| `GET` | `/api/discovery/runs/:id` | Run summary: per-source counts, errors, skips, duplicates. |
| `POST` | `/api/discovery/manual` | Body: `{ url }`. The Tier-C path — fetch, normalize, match one posting. |
| `POST` | `/api/companies/resolve` | Body: `{ name \| domain }` → detected ATS + board slug. |
| `POST` | `/api/postings/:id/refresh` | Re-check open/closed and deadline. |

## Matching

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/matches` | Query: `eligibility`, `minScore`, `term`, `location`, `deadlineBefore`, `status`, `cursor`, `limit`. Returns matches with posting summary, score, breakdown, badges. |
| `GET` | `/api/matches/:id` | Full detail: posting, requirement checklist with quotes, blockers, breakdown, rationale. |
| `POST` | `/api/matches/:id/decision` | Body: `{ action: 'approved'\|'skipped'\|'rejected'\|'saved', reason?, reasonTags? }`. `approved` creates an `application` and returns its id — it does **not** submit anything. |
| `POST` | `/api/matches/recompute` | Re-run matching after a profile or weights change. |

## Applications & answers

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/applications` | List with status filter. |
| `GET` | `/api/applications/:id` | Detail: status, form map, answers, skipped fields, events. |
| `POST` | `/api/applications/:id/analyze` | Open the apply URL, build the `FormMap`, enumerate questions. → `{ taskId }`. |
| `POST` | `/api/applications/:id/answers/draft` | Draft all unanswered questions (or `{ questionIds }`). → `{ taskId }`. |
| `GET` | `/api/applications/:id/answers` | Answers with `draft_text`, `final_text`, evidence, flags, approval state. |
| `PUT` | `/api/answers/:id` | Update `final_text`; recomputes `edit_distance` and re-runs FactGuard. |
| `POST` | `/api/answers/:id/approve` | **G3.** Rejects with `UNRESOLVED_FLAGS` if any red flag remains. |
| `POST` | `/api/answers/:id/regenerate` | Redraft, optionally with a user instruction. |

## Filling & submission

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/applications/:id/fill` | Body: `{ dryRun?: boolean }`. Rejects with `ANSWERS_NOT_APPROVED` if any answer lacks `approved_at`. Streams steps over SSE. |
| `POST` | `/api/applications/:id/fill/continue` | Resume after a pause (login wall, CAPTCHA, needs-input). |
| `GET` | `/api/applications/:id/presubmit` | Screenshot path, filled-field table, full answer text, skipped/redlined checklist. |
| `POST` | `/api/applications/:id/mark-submitted` | **G4.** The *only* endpoint that writes `submitted_at`. Requires `{ confirmed: true }`. |
| `POST` | `/api/applications/:id/status` | Manual status transition with an optional note. |

There is deliberately **no** `POST /api/applications/:id/submit`. The server has no code path
that clicks a submit control (doc 07).

## Browser session

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/browser/status` | Running? which page? paused and why? |
| `POST` | `/api/browser/open` | Open a URL in the visible browser (used for manual login). |
| `POST` | `/api/browser/save-session` | Persist storage state for the current domain after the user logs in. |
| `GET` | `/api/browser/sessions` | Saved domains + last used. **Never returns credentials** — there are none. |
| `DELETE` | `/api/browser/sessions/:domain` | Forget a saved session. |

## Tasks

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/tasks` | Filter by status/kind. |
| `GET` | `/api/tasks/:id` | Status, progress, error. |
| `POST` | `/api/tasks/:id/cancel` | Cooperative cancellation. |

## Settings, cost, privacy

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `PUT` | `/api/settings` | App settings incl. scoring weights and rate limits. |
| `POST` | `/api/settings/keys` | Store API keys → OS keychain. Write-only; never read back. |
| `GET` | `/api/cost` | Token/spend rollups by purpose and day, from `llm_call`. |
| `GET` | `/api/privacy/export` | Full JSON export of everything stored. |
| `POST` | `/api/privacy/delete-all` | Requires `{ confirm: 'DELETE EVERYTHING' }`. Wipes DB, files, browser profile, and keychain entries. |

## Events (SSE)

`GET /api/events` — one long-lived stream, `text/event-stream`.

```ts
type AppEvent =
  | { type: 'extraction.progress'; documentId: string; stage: string; pct: number }
  | { type: 'discovery.progress'; runId: string; source: string; found: number; new: number }
  | { type: 'discovery.source_failed'; runId: string; source: string; error: string }
  | { type: 'discovery.done'; runId: string; summary: RunSummary }
  | { type: 'match.new'; matchId: string; score: number }
  | { type: 'draft.progress'; applicationId: string; questionId: string; stage: string }
  | { type: 'fill.step'; applicationId: string; field: string; status: 'ok'|'skipped'|'failed'; note?: string }
  | { type: 'fill.needs_input'; applicationId: string; reason: 'login'|'captcha'|'unknown_field'; detail: string }
  | { type: 'fill.done'; applicationId: string; filled: number; skipped: number }
  | { type: 'task.failed'; taskId: string; kind: string; error: string };
```

Each event carries a monotonic `seq`. Clients reconnect with `Last-Event-ID`; the server
replays from an in-memory ring buffer where it can and otherwise tells the client to
refetch. Heartbeat comment every 20s to keep the connection alive.

## Server-side invariants

Enforced in the route layer, above the core modules, and covered by integration tests:

1. Every endpoint except `/api/profile*`, `/api/resumes*`, `/api/settings*`, and
   `/api/events` rejects with `PROFILE_NOT_CONFIRMED` while `confirmed_at` is null.
2. `/fill` rejects unless every answer for the application has `approved_at`.
3. `/answers/:id/approve` rejects while unresolved `unsupported` or `overstated` flags exist.
4. `submitted_at` is writable only by `/mark-submitted`.
5. No endpoint returns a decrypted 🔒 field except to the local UI on the profile/settings
   routes; DOB is returned only to the Settings and Onboarding screens, never included in
   fill plans.
