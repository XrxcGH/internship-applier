# 02 — Architecture

## Shape

A local-first app: one Node process serving a local API + a browser-based UI, driving a
Playwright-controlled browser window. Nothing is hosted; there is no multi-tenant server.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser tab · http://127.0.0.1:5173                                │
│  React + TypeScript UI                                              │
│    Onboarding · Discover · Matches · Application workspace · Tracker│
└───────────────┬─────────────────────────────────────────────────────┘
                │ REST (JSON) + SSE (progress/events)
┌───────────────▼─────────────────────────────────────────────────────┐
│  Node process · Fastify @ 127.0.0.1:8787                            │
│                                                                     │
│  ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐  │
│  │ Ingestion │ │ Discovery │ │ Matching │ │ Writing  │ │ Filling │  │
│  │  resume→  │ │  sources→ │ │ rules +  │ │ voice +  │ │ adapters│  │
│  │  profile  │ │  postings │ │ scoring  │ │ factguard│ │ + forms │  │
│  └─────┬─────┘ └─────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬────┘  │
│        └─────────────┴────────────┴────────────┴───────────┘        │
│                              │                                      │
│        ┌─────────────────────┼──────────────────────┐               │
│        ▼                     ▼                      ▼               │
│  ┌───────────┐        ┌────────────┐         ┌────────────┐         │
│  │ Job queue │        │  SQLite    │         │ LLM client │         │
│  │ (in-proc, │        │  (Drizzle) │         │ (Anthropic)│         │
│  │  SQLite-  │        │  app.db    │         │ opus/haiku │         │
│  │  backed)  │        └────────────┘         └────────────┘         │
│  └───────────┘                                                      │
└───────────────┬─────────────────────────────────────────────────────┘
                │ CDP
┌───────────────▼─────────────────────────────────────────────────────┐
│  Playwright Chromium — HEADED, visible to the user                   │
│  Persistent profile dir · per-site storage state · user logs in here │
└─────────────────────────────────────────────────────────────────────┘
```

## Stack and why

| Layer | Choice | Rationale |
| --- | --- | --- |
| Language | TypeScript (Node 24) | See [ADR-001](#adr-001--typescript-over-python) below. Short version: the riskiest module is Playwright form automation, where Node is the reference implementation; the frontend is TypeScript regardless, so TS-everywhere means one toolchain instead of two. |
| Backend | Fastify 5 | Small, fast, first-class TS types, native SSE via `reply.raw`, plugin model fits the module split. |
| DB | SQLite via `better-sqlite3` + Drizzle ORM | Single file, zero-ops, synchronous, good enough for one user. Drizzle gives typed queries + migrations without a heavy runtime. |
| Browser | Playwright (`playwright` npm) | Best-in-class selector engine, `getByLabel`/`getByRole` map directly onto form-field semantics, persistent contexts, tracing for debugging. |
| Frontend | React 19 + Vite + TypeScript | Fast dev loop; the UI is form- and list-heavy, which React handles well. |
| Styling | Tailwind + shadcn/ui (Radix) | Accessible primitives (dialog, combobox, toast) matter for a keyboard-driven review queue. |
| Data fetching | TanStack Query | Cache/invalidate around a local API; handles the polling and SSE-invalidations cleanly. |
| Client state | Zustand | Small amount of genuinely global state (active review item, keyboard mode). |
| LLM | Anthropic TS SDK, `claude-opus-5` | Structured extraction, drafting, field classification. `claude-haiku-4-5` for high-volume cheap classification. |
| Validation | Zod | One schema per boundary: API bodies, LLM structured outputs, config. |
| Testing | Vitest + Playwright test | Unit/integration in Vitest; form-filling tested against a local fixture site. |
| Logging | Pino | Structured JSON logs to `logs/app.jsonl`, pretty in dev. |

### ADR-001 — TypeScript over Python

**Status:** accepted 2026-08-03. **Revisit if:** the maintainer is substantially more fluent
in Python than TypeScript.

Both platforms were evaluated with Python 3.14.6 and Node 24.16.0 available on the machine.
This was a close call (~60/40), and the reasoning is recorded here so it can be re-litigated
honestly rather than from memory.

**Where Python is genuinely better:**

- Stdlib `sqlite3` — no native build. Node's `better-sqlite3` needs prebuilt binaries and is
  a real (if usually painless) Windows risk. `@libsql/client` sidesteps this if it bites.
- `textstat` / `nltk` / `spaCy` for the `StyleProfile` metrics in doc 06.
- FastAPI + Pydantic auto-generates OpenAPI, from which TypeScript types can be generated —
  arguably a *better* single source of truth than Zod schemas imported by both sides.
- `numpy` for the embedding math in dedupe and skill matching.
- pytest + pandas make the extraction-quality and FactGuard eval harnesses (doc 11) nicer.

**Why TypeScript was chosen anyway:**

1. **The long pole is Playwright.** Form automation (M6) is the largest, riskiest module and
   the one most likely to overrun. Node is Playwright's reference implementation: features
   land there first, and nearly all community knowledge about ATS-specific breakage —
   Workday's shadow DOM, iframe traversal, React-controlled inputs that ignore
   programmatic value assignment — is written in JS. Optimizing the language choice around
   the highest-risk module is the right trade.
2. **Python's classic advantage for this domain is already designed out.** The usual reason
   to pick Python for a resume tool is PDF extraction and NLP. The design routes PDFs
   directly to Claude's native document support (doc 02 § Notable stack decisions), which
   handles scanned documents better than an OCR pipeline. And the `StyleProfile` metrics are
   sentence segmentation plus counting — Node's built-in `Intl.Segmenter` covers the hard
   part in well under 200 lines.
3. **The frontend is TypeScript either way.** So the real question is one toolchain or two.
   For a solo, single-user, locally-run app, a second dependency tree, linter, test runner,
   and upgrade treadmill is a permanent tax that the Python-side wins don't cover.

**Rejected as non-reasons:** "Python isn't installed" (it is, as of 2026-08-03) and "shared
Zod types" (OpenAPI codegen from Pydantic is an equally good single source of truth).

**Minor tax on the Python side, noted for completeness:** Python 3.14 is recent enough that
Windows wheels for some C extensions can still lag.

### Notable stack decisions

**Resume parsing goes through Claude's native PDF support, not a PDF library.** The
`document` content block accepts base64 PDF directly, so the primary ingestion path is
`PDF bytes → Claude → structured JSON` with no `pdfjs`/OCR dependency and no layout-mangling.
Local text extraction (`mammoth` for DOCX, plain read for TXT/MD) exists as the fallback for
non-PDF formats and as a cheap re-run path when the raw text is already cached. Scanned
PDFs work because Claude reads them as images.

**No Redis, no external queue.** A `tasks` table plus an in-process async worker pool covers
the concurrency needs (a few dozen HTTP fetches, a handful of LLM calls). Adding a broker
would be the single biggest ops cost for no benefit at this scale.

**Headed browser by default.** The user should see the form being filled. Headless mode
exists only for the test fixture site.

## Processes and lifecycle

One command starts everything:

```bash
npm run dev
```

- `apps/server` — Fastify on `127.0.0.1:8787`, bound to loopback only. Owns the DB, the
  task worker, and the Playwright browser.
- `apps/web` — Vite dev server on `127.0.0.1:5173`, proxying `/api` to the server.
- Playwright browser launches lazily on the first fill request and persists for the session.

In production packaging (M8), `apps/web` is built to static files served by Fastify, and the
whole thing ships as a single `npx internship-applier` command that opens the browser to
the local UI. Electron/Tauri wrapping is deliberately deferred — it adds a build pipeline
and a code-signing problem for a UI that works fine in a browser tab.

## Module layout

```
internship-applier/
├─ apps/
│  ├─ server/
│  │  └─ src/
│  │     ├─ index.ts                 # Fastify bootstrap, route registration
│  │     ├─ routes/                  # thin HTTP layer, Zod-validated → calls core/
│  │     │  ├─ profile.ts  discovery.ts  matches.ts
│  │     │  ├─ applications.ts  answers.ts  fill.ts  events.ts
│  │     ├─ core/
│  │     │  ├─ ingestion/            # resume → CandidateProfile
│  │     │  │  ├─ extractText.ts     # DOCX/TXT/MD; PDF passes through as bytes
│  │     │  │  ├─ extractProfile.ts  # Claude structured output
│  │     │  │  └─ deriveFields.ts    # age, academic level, YOE, seniority band
│  │     │  ├─ discovery/
│  │     │  │  ├─ sources/           # one adapter per source (see doc 04)
│  │     │  │  ├─ queryPlanner.ts    # profile → search queries
│  │     │  │  ├─ normalize.ts       # source payload → JobPosting
│  │     │  │  ├─ dedupe.ts          # URL → fuzzy key → embedding near-dup
│  │     │  │  └─ refresh.ts         # re-check open/closed, deadlines
│  │     │  ├─ matching/
│  │     │  │  ├─ requirements.ts    # JD text → structured requirements (LLM)
│  │     │  │  ├─ eligibility.ts     # hard rules — pure, deterministic, tested
│  │     │  │  ├─ score.ts           # soft fit scoring + breakdown
│  │     │  │  └─ rationale.ts       # short natural-language explanation
│  │     │  ├─ writing/
│  │     │  │  ├─ styleProfile.ts    # writing samples → measured StyleProfile
│  │     │  │  ├─ answerLibrary.ts   # reusable canonical answers
│  │     │  │  ├─ draft.ts           # generate answer from question + profile
│  │     │  │  ├─ factGuard.ts       # claim → profile evidence, or flag
│  │     │  │  └─ styleCritic.ts     # measure draft vs StyleProfile, revise
│  │     │  ├─ filling/
│  │     │  │  ├─ browser.ts         # Playwright lifecycle, persistent context
│  │     │  │  ├─ formMap.ts         # DOM → FormField[] semantic map
│  │     │  │  ├─ classify.ts        # deterministic matcher → LLM fallback
│  │     │  │  ├─ fill.ts            # typing, selects, uploads, multi-step
│  │     │  │  ├─ redlines.ts        # fields that must never be auto-filled
│  │     │  │  └─ adapters/          # greenhouse, lever, ashby, workday, generic
│  │     │  └─ tracking/             # status transitions, reminders, stats
│  │     ├─ infra/
│  │     │  ├─ db/                   # drizzle schema, migrations, client
│  │     │  ├─ llm/                  # Anthropic client, retry, cost accounting
│  │     │  ├─ http/                 # fetch wrapper: rate limit, cache, backoff
│  │     │  ├─ queue/                # tasks table + worker pool
│  │     │  ├─ crypto/               # AES-GCM field encryption, keychain
│  │     │  └─ events.ts             # in-proc event bus → SSE
│  │     └─ config.ts                # env + settings, Zod-validated
│  └─ web/
│     └─ src/                        # see doc 08
├─ packages/
│  ├─ shared/                        # Zod schemas + TS types used by both apps
│  └─ fixtures/                      # local mock application site for tests
├─ docs/
└─ data/                             # gitignored: app.db, resumes/, browser-profile/
```

## Data flow: one application, end to end

1. **Ingest.** User uploads `resume.pdf`. Stored under `data/resumes/`. `extractProfile`
   sends it to Claude with a strict JSON schema → draft `CandidateProfile`.
2. **G1 · Confirm.** UI shows the extracted profile in an editable form. User corrects it,
   adds DOB, work authorization, availability window, location preferences. Saved as
   confirmed.
3. **Discover.** `queryPlanner` turns the profile into source queries. Worker fans out
   across source adapters, normalizes results into `job_posting`, dedupes.
4. **Match.** For each new posting: `requirements` extracts structured requirements from the
   JD; `eligibility` runs hard rules (pure functions); survivors get a `score` with a
   per-dimension breakdown and a `rationale`.
5. **G2 · Approve.** Matches land in the review queue. User approves, skips, or rejects with
   a reason (rejection reasons feed preference learning).
6. **Draft.** On approval, the tool opens the application page, builds a `FormMap`, and for
   each free-text question drafts an answer: retrieve relevant profile facts → generate in
   the user's `StyleProfile` → `factGuard` verifies → `styleCritic` revises.
7. **G3 · Review.** Answer workspace shows each question, the draft, the supporting profile
   evidence, and any unsupported-claim flags. User edits and approves each one.
8. **Fill.** The visible browser fills the form field by field. Redlined fields
   (SSN/ID/attestations/EEO/consent) are skipped and listed for the user.
9. **G4 · Submit.** Full-page screenshot + diff review, then the user clicks Submit in the
   browser. The tool records the submission and archives the final answers.
10. **Track.** Application moves through the tracker; optional read-only email ingestion
    updates status; deadline and follow-up reminders surface as drafts only.

## Concurrency and rate limiting

- Task worker: bounded pool, default 6 concurrent tasks, configurable.
- Per-domain token bucket in `infra/http` — default 1 request/sec/domain, honors
  `Retry-After`, exponential backoff with jitter on 429/5xx.
- Response cache keyed by URL + ETag, 6h default TTL, so re-running discovery is cheap.
- Identifiable User-Agent. `robots.txt` respected for any generic page fetch (source APIs
  are exempt as documented API surfaces).
- LLM calls: `claude-opus-5` for extraction/drafting/rationale; `claude-haiku-4-5` for
  bulk field classification and cheap yes/no checks. Prompt caching on the stable prefix
  (system prompt + confirmed profile) — the profile is the dominant repeated context, so
  it goes early and is frozen between edits.

## Failure posture

| Failure | Behavior |
| --- | --- |
| Source API down | That source is marked degraded for the run; others continue; UI shows which sources ran. |
| Resume extraction low-confidence | Profile fields marked `needs_review`; G1 cannot be completed until they're touched. |
| Requirement text unparseable | Posting surfaces with `eligibility: unknown` and the raw text quoted — never silently filtered out. |
| Form field unclassifiable | Left blank, listed in the "needs your input" panel with a screenshot crop. |
| Login wall hit | Browser pauses, UI says "log in in the open window, then Continue." Tool never types credentials. |
| LLM refusal / error | Surfaced verbatim to the user for that step; no silent retry loop, no fabricated fallback. |
