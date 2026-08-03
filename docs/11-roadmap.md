# 11 — Roadmap, testing, risks

## Status

| Milestone | State | Notes |
| --- | --- | --- |
| M0 Skeleton | **done** | 19-table schema, CI, G4 guards, pre-commit hook |
| M1 Resume → profile | **done** | Claude-native PDF ingestion, field encryption, G1 enforced in the repository |
| M2 Discovery | **done** | Greenhouse/Lever/Ashby adapters, polite fetcher, 3-stage dedupe, run reporting. Verified live: 424 postings from two real boards, with a failing board correctly reported as degraded rather than dropped. |
| M3 Matching | **done** | Deterministic + LLM requirement extraction with quote verification, 12 pure eligibility rules, scoring, rationale. Verified live: 816 postings → 420 eligible / 244 unknown / 152 ineligible, 203 requirements, 0 dropped, 0 errors. |
| M4 Review queue | next | |
| M5–M8 | not started | |

Deferred from M2, worth doing before M3 ships: Adzuna and USAJOBS adapters (both need a
free key), the SimplifyJobs community list, the Tier-B web-search path, the manual
paste-a-URL route, the freshness/refresh job, and SSE progress. The keyless ATS adapters
carry most of the coverage, so these are additive rather than blocking.

## Milestones

Each milestone is independently demoable. Nothing after M0 depends on a big-bang
integration.

### M0 — Skeleton (½ day)

pnpm/npm workspace; `apps/server` (Fastify + health route), `apps/web` (Vite + React +
Tailwind + shadcn), `packages/shared` (Zod schemas), `packages/fixtures` stub. Drizzle wired
to SQLite with the first migration. Pino logging. Vitest + Playwright configured. CI running
lint + typecheck + tests. `.gitignore` and the PII pre-commit hook in place.

**Done when:** `npm run dev` serves a UI that reads a health endpoint, and CI is green.

### M1 — Resume → confirmed profile (2 days)

Upload endpoint + storage. Claude-native PDF extraction with structured output; DOCX/TXT/MD
text path. `deriveFields`. Field-level encryption + keychain. The G1 onboarding wizard.

**Done when:** a real resume produces a profile the user corrects and confirms, and
`confirmed_at` gates everything else.

### M2 — Discovery (3 days)

`infra/http` (rate limit, cache, backoff, robots). Adapters: Greenhouse, Lever, Ashby,
USAJOBS, Adzuna, the SimplifyJobs list. Company resolution. Query planner + editable plan.
Normalization, three-stage dedupe, refresh. Run summaries + SSE progress.

**Done when:** a run over real sources returns deduped summer-internship postings with an
honest per-source report.

### M3 — Matching (3 days)

Requirement extraction with quote verification. The eligibility rule set as pure functions
with the golden fixture suite. Scoring + breakdown + rationale. The `eligible` /
`unknown` / `ineligible` tri-state end to end.

**Done when:** every posting in the queue can be traced to a pass/fail per requirement with
the verbatim JD quote, and the filtered drawer explains every exclusion.

### M4 — Review queue (2 days)

The Matches screen: virtualized list, detail pane, requirement checklist, score breakdown,
keyboard triage, reject-reason capture, G2 approval creating an application.

**Done when:** 100 matches can be triaged from the keyboard without touching the mouse.

### M5 — Writing engine (4 days)

Writing-sample capture and `StyleProfile` computation. Retrieval. Drafting. FactGuard (LLM
verdicts + deterministic checks on numbers/dates/names). StyleCritic. Tell-scrub. Answer
library. The G3 workspace with claim highlighting, evidence panel, flags, and the
edit-distance meter.

**Done when:** a drafted answer reads like the user, every claim shows its evidence, and a
deliberately planted false claim is caught and blocks approval.

### M6 — Form automation (5 days — the long pole)

Browser lifecycle and persistent context. `FormMap` + two-stage classification. Redline
enforcement. Fill strategies per control type with read-back verification. Adapters:
generic, Greenhouse, Lever, Ashby, then Workday. Pause/resume for login and unknown fields.
Pre-submit review + G4. The fixture site and its Playwright suite.

**Done when:** the fixture site's nastiest form fills correctly, every redlined field is
skipped, and there is no code path that clicks Submit.

### M7 — Tracker (2 days)

Status model + kanban + table + CSV export. Deadline and follow-up reminders as drafts.
Optional read-only Gmail/IMAP ingestion for status updates. Outcome stats by source and by
answer variant.

### M8 — Hardening & packaging (3 days)

Privacy export/delete. Cost panel. Guardian mode. Error taxonomy and recovery paths. Docs.
Single-command packaging (`npx internship-applier`) serving the built UI from Fastify.

**Rough total: ~24 working days** for one person. M6 is the most likely to overrun; Workday
alone could eat several days and is the right thing to cut to a later milestone if the
schedule slips.

## Testing strategy

| Layer | Approach |
| --- | --- |
| **Eligibility rules** | The highest-stakes code. ~60 hand-labeled JD excerpts as golden fixtures; property tests (no `fail` without a citation; `unknown` never yields `fail`; adding a profile fact never turns `eligible` into `ineligible`); a regression test per bug, permanently. |
| **Source adapters** | Recorded HTTP fixtures (nock/msw). Normalization is pure and unit-tested per source. A weekly CI job hits the live APIs to detect schema drift and opens an issue on failure — never fails the main build. |
| **Extraction quality** | An eval harness over a small set of anonymized resumes with hand-labeled expected profiles; reports per-field precision/recall. Run before any extraction-prompt change ships. |
| **FactGuard** | An adversarial suite: drafts with planted fabrications (invented employer, inflated duration, wrong GPA, nonexistent skill). Every one must be caught. This suite is a release gate. |
| **StyleProfile** | Metric computation unit-tested against hand-measured samples; a round-trip test that a draft targeting a profile lands within tolerance. |
| **Form filling** | Playwright against `packages/fixtures` in CI (headless). Recorded real-ATS HTML snapshots (PII-scrubbed) as regression fixtures for mapping/classification. Never against live employer forms in CI. |
| **Redlines** | A dedicated suite asserting no redlined field is ever written, across every fixture form. Release gate. |
| **Submit gate** | A static check that `filling/` contains no click on a submit-like locator, plus a runtime guard that throws if one occurs. Release gate. |
| **API contracts** | Shared Zod schemas mean a contract break is a typecheck failure. Integration tests cover each server-side invariant in doc 09. |
| **E2E** | One full happy path against the fixture site: upload → confirm → discover (mocked) → match → approve → draft → review → fill → pre-submit. Stops short of submission, by design. |

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| ATS DOM changes break filling | High | Medium | Semantic `FormMap` over brittle selectors; generic adapter as fallback; read-back verification means silent wrong-fills surface as errors; recorded snapshots catch drift. |
| Workday complexity | High | Medium | Explicitly last in M6; ship the other four adapters first; degrade to "we mapped the form, here's what to paste" rather than a broken fill. |
| Source API changes / rate limits | Medium | Medium | Many independent sources; per-source health and degradation; weekly drift check; caching. |
| Requirement extraction gets eligibility wrong | Medium | **High** | Tri-state with `unknown`; quote verification; the inspectable filtered drawer; golden fixtures; property tests. A false `ineligible` is the worst bug this app can have. |
| FactGuard misses a fabrication | Low | **High** | Deterministic checks on numbers/dates/names in addition to the model pass; adversarial release-gate suite; the human review gate as the last line. |
| Generated text still reads as machine-written | Medium | Low | StyleCritic + tell-scrub + the edit-distance nudge. Ultimately the user edits; the tool's job is a good first draft, not a final one. |
| LLM cost surprises the user | Medium | Low | Prompt caching on the stable prefix; Haiku for bulk classification; a live cost panel; a configurable monthly cap that pauses LLM features rather than silently spending. |
| Local PII exposure | Low | High | Field encryption, keychain, restrictive ACLs, redacted logs, pre-commit hook, export/delete. |
| User over-applies to poor fits | Medium | Low | Rationale states the likely rejection reason; effort estimates; per-application friction is deliberate. |

## Decisions (locked 2026-08-03)

| Question | Decision | Consequence |
| --- | --- | --- |
| Build order | **M0 only, then reassess** | Skeleton is built; M1+ starts on explicit go-ahead. |
| Submit behavior | **G4 as designed — the user clicks Submit in the browser** | No auto-submit path exists anywhere in the codebase. Enforced by test + runtime guard. |
| Age | **18 or older** | Guardian mode is **deferred out of v1**. DOB is still collected (18+ requirements are common) and still encrypted; the minor-specific handling in doc 10 is not built. |
| Market | **United States only** | Sources: USAJOBS, Adzuna-US, US ATS boards. Work-authorization rules built for US visa/sponsorship status and citizenship requirements. UK/EU adapters deferred. |

## Still open

1. **Target term.** Summer 2026 is past as of August 2026; the default term filter is
   assumed to be **Summer 2027** unless told otherwise. Trivially changed in settings.
2. **Field / role family.** Assumed to be derived from the resume, with the query plan
   editable by the user before each run. No hardcoded taxonomy needed up front.
3. **Anthropic API key.** Needed from M1 onward. The design assumes `claude-opus-5` for
   extraction, drafting, and FactGuard, with `claude-haiku-4-5` for bulk field
   classification. M0 does not call the API at all.

## Deferred (explicitly not v1)

Resume tailoring per posting · referral/network detection · interview scheduling ·
multi-user support · mobile UI · Electron/Tauri packaging · browser-extension companion ·
automatic follow-up email sending (drafts only, always).
