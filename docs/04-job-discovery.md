# 04 — Job discovery

## Sourcing policy

Sources are tiered by legitimacy, and the tier determines whether we build an adapter.

**Tier A — official, documented APIs. Build adapters.** These exist to be consumed
programmatically; using them is what they're for.

| Source | Endpoint shape | Notes |
| --- | --- | --- |
| Greenhouse Job Board | `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | Public, no key. Huge coverage — most tech companies. |
| Lever Postings | `api.lever.co/v0/postings/{company}?mode=json` | Public, no key. |
| Ashby Job Board | `api.ashbyhq.com/posting-api/job-board/{name}` | Public. |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{id}/postings` | Public. |
| Workable | `apply.workable.com/api/v1/widget/accounts/{id}` | Public. |
| Recruitee / Teamtailor / Personio | per-vendor public board JSON | Smaller coverage, cheap to add. |
| USAJOBS | `data.usajobs.gov/api/search` | Free API key. Federal internships + Pathways. |
| Adzuna | `api.adzuna.com/v1/api/jobs/{country}/search` | Free tier key. Good aggregate coverage. |
| Arbeitnow / Remotive / RemoteOK / The Muse / Findwork | documented JSON endpoints | Free, remote-heavy. |
| SimplifyJobs Summer internship lists | public GitHub repo README/JSON | Community-maintained, well-structured, explicitly published for this. |

Six of those ship today: Greenhouse, Lever and Ashby in `sources/ats.ts`, and Adzuna,
USAJOBS and the SimplifyJobs list in `sources/aggregators.ts`. The rest are in the table
because they qualify under this policy, not because an adapter exists — each is a small
self-contained addition when someone wants it.

**Tier B — general web search + structured page data. Designed, not built.** The design: a
search provider (Brave Search API or Google Programmable Search — key supplied by the user)
returns candidate career-page URLs; we fetch each and read the embedded
`schema.org/JobPosting` JSON-LD, which most ATS pages ship, falling back to Claude reading
the page text where it is absent. `robots.txt`, the per-domain rate limit and the identifying
User-Agent already exist in `infra/http` and would apply.

**None of the crawl exists.** No search provider is called anywhere in the server, and
`BRAVE_SEARCH_API_KEY` in `.env.example` is read by nothing. The only JSON-LD reader that
ships is `core/discovery/manualPosting.ts`, and it serves the manual path below — one
user-directed fetch of a page the user is already looking at, not a walk over search
results.

**Tier C — not scraped.** LinkedIn, Indeed, Glassdoor, and similar sites whose terms of
service prohibit automated access, or whose listings sit behind authentication. There is no
adapter for these and none should be added. Instead:

**The manual path.** A "Paste a job URL" box in the UI. The user brings a posting they
found anywhere; the tool fetches that single page (a user-directed fetch of a page the user
is already looking at), normalizes it, and runs it through matching. This covers Tier C
without building a scraper against sites that forbid it.

## Company target list

Beyond query-driven search, the user can name companies they care about. `resolveCompany`
probes known ATS endpoints for a company slug:

```
acme → try boards-api.greenhouse.io/v1/boards/acme/jobs
     → try api.lever.co/v0/postings/acme
     → try api.ashbyhq.com/posting-api/job-board/acme
```

All three vendors are tried for one slug candidate before the next candidate is tried, and
the first candidate that answers anywhere ends the search; whichever boards answered come
back sorted by how many jobs they hold. A board that answered with nothing posted today is still
returned, with a count of zero, because it answers the question that was asked — which
vendor this company uses. A 404 is the ordinary "no board here" and passes without comment;
anything else is logged, because a timeout or a 503 means that vendor was never actually
checked and an empty answer would read as "this company has no board there".

**Not built:** the domain fallback — fetching `acme.com` when none of the three answers and
looking for a careers link and an ATS fingerprint in the HTML — and the mapping cache.
Nothing in `resolveCompany` writes to the database, so resolving the same company twice
re-probes every vendor, and the `source` row labelled `greenhouse:acme` appears only once a
discovery run has actually pulled that board.

## Query planning

`queryPlanner` turns the confirmed profile into a bounded set of source queries. It does
**not** ask the model to invent queries freely; it composes them from profile facts:

```ts
QueryPlan {
  targets      // {source, board, reason}[] — the boards a run actually hits, capped at 40
  roleFamilies // inferred from the profile, top 4
  keywords     // roleFamilies + the filters' own role families and title-includes
  termTokens   // "summer 2027 internship", "summer 2027 co-op", … — from the filters
  locations    // base city, relocation targets, "remote"
  notes        // every truncation, guess and gap, in plain sentences
}
```

`targets` is the part that costs requests, and companies the user pinned by name go in
first and survive the cap. Slicing one concatenated list dropped them silently as soon as
the pinned list alone exceeded 40 — losing exactly the boards that had been asked for by
name. A pinned company with no resolved board is guessed on all three keyless vendors, with
a note saying the guess is unverified so it can be pointed at the resolve endpoint.

Role families are derived deterministically — no model call. `inferRoleFamilies` counts how
many terms of each entry in a curated 21-family taxonomy appear in the profile, ranks the
families with at least one hit by hit count, and keeps the top four.

It reads the profile as two separate corpora, because they can afford different amounts of
reach:

- the **stem corpus** — skills, experience titles and bullets, project names and
  descriptions, fields of study, coursework and honors — where a term may match as a
  prefix, so `biolog` reaches "biological";
- the **organization corpus** — the organization named on each experience — where every
  term must be a whole word. A young applicant's field is often stated only there ("Sample
  Robotics" with nothing in the bullets), so the line has to count; but under a prefix stem
  "Brandeis University" scored the `brand` term and a campus dining job came back wanting
  marketing roles.

A school's own name is identity, not role evidence, so each education institution is
subtracted from the organization corpus before anything is counted: "Student Ambassador,
Design and Architecture Senior High" was minting a design family for a student with no
design work behind it, while the rest of that line — "Speech & Debate Team", written after
the school name — still counts.

Both corpora then pass through `scrubFalseSignals`, which removes the phrases that borrow a
taxonomy stem without being evidence of it. "robots.txt" is an SEO artifact and "robotic
process automation" an ops one, and both handed a marketing resume robotics queries;
"tutorial" starts with the `tutor` stem, so following a React tutorial read as teaching;
"self-taught" and "mentored by" describe learning rather than teaching; and a clock time is
not a job title, so "Worked 4 to 9 PM shifts on weekends" no longer hands a cashier a
product-management search plan. Scrubbing the phrase is deliberate — narrowing the stem
instead would cost the genuine uses.

Matching is word-boundary anchored rather than a bare substring test, and that distinction
is the whole point of curating the taxonomy: `includes('ml')` is true of "html",
`includes('ai')` of "email", `includes('ui')` of "building", so a resume mentioning HTML and
email used to come back wanting machine-learning roles. In the stem corpus, terms of three
characters or fewer must be whole words and longer ones need only start at a boundary,
because entries like `biolog` and `prototyp` are deliberate stems; in the organization
corpus every term is whole-word regardless of length.

The user sees and can edit the query list before a run — discovery is not a black box
either.

## Pipeline

```
plan queries
   │
   ├─▶ [Tier A adapters]   ─┐
   ├─▶ [company targets]   ─┤
   └─▶ [manual paste-a-URL]─┤
                            ▼
                    normalize → NormalizedPosting
                            │
                            ▼
                    dedupe (3 stages)
                            │
                            ▼
              persist job_posting + job_posting_source
                            │
                            ▼
        matching run (doc 05) — extracts job_requirement, then scores
```

A run is one pass, not a resumable pipeline. `runDiscovery` fans the targets out across a
small worker pool, collects everything, dedupes, persists, and writes a **single** `task`
row at the end — already `status: 'done'` — purely so `GET /api/discovery/runs/:id` can
answer afterwards. There is no queue, no worker loop, and nothing to resume from; a run
that dies halfway is re-run. `runDiscovery` does publish `discovery.progress`,
`discovery.source_failed` and `discovery.done` onto the SSE stream at `GET /api/events`, but
nothing in the frontend subscribes to it — `EventSource` appears nowhere in `apps/web/src`
(docs/08 § Real-time). So a run reports itself only in the response that arrives when it is
already over: while it is running, the screen sits there with no indication of which board is
being fetched or how far along it is.

### Normalization

Each adapter implements one interface:

```ts
interface JobSource {
  kind: SourceKind;
  /** Whether this source needs an API key the user hasn't supplied. */
  requiresKey: boolean;
  isConfigured(): boolean;
  fetch(query: SourceQuery): Promise<SourceResult>;
}
```

`fetch` returns `{ postings: NormalizedPosting[]; notes: string[]; gaps?: string[]; closed?: string[] }` — one
call, one array, already normalized. Normalization is not a separate method: each adapter
maps its own vendor payload inline, because the mapping is the only part that differs
between sources and a second method would only be a place to forget to call.

`notes` is how a source says it did less than it looks like it did. A source that needs an
API key the user hasn't supplied is still called, and answers with an empty list and a note
saying exactly that — which is why the run summary can report a coverage gap instead of
showing zero postings and no reason.

`gaps` is a second, separate list carrying the coverage we did not get: a page of results
we stopped at, rows that could not be read. It is **not a subset of `notes`** — the runner
concatenates the two into the source report, so a line written into both is printed to the
user twice. Adzuna and USAJOBS return an empty `notes` beside a populated `gaps`;
`github_list` returns a status line in one and a different coverage-loss line in the other.
The runner also marks a source degraded for a gap and repeats it in the run summary's
`skipped` list, which is where the UI gets "the search was incomplete" from. A plain note
does neither, so a source that quietly returned its first fifty of eight hundred matches
used to read as complete coverage.

`closed` is a fourth channel, and a different kind of thing from the other three: canonical
URLs the source itself says are no longer open. The community list marks a finished role
`active: false`, and that row used to be skipped and forgotten — the best closure evidence in
the pipeline, costing no request, thrown away, so a stored posting stayed open until the
45-day staleness window expired it and the queue went on offering an application that could
no longer be made. `runDiscovery` applies these after every source has been read, and a
posting the same run also fetched OPEN stays open: the sighting is the stronger signal, and
it is matched by stored row rather than by URL, because dedupe merges two addresses for one
job onto one row. The count appears on the run summary as `closed` and on the Discover
screen's headline.

Normalization is deterministic parsing, not an LLM call: title/company/location/dates come
straight from structured source fields. Discovery makes no model calls at all — requirement
extraction is the matching run's job (doc 05), and it is cached per posting.

Term detection (`summer 2027` vs `fall`) is a small deterministic parser over title + dates
+ description, with an `unknown` outcome rather than a guess. `unknown` postings are shown
with a badge, not filtered out.

### Dedupe

Three stages, cheapest first:

1. **Canonical URL.** Strip tracking params (`utm_*`, `gh_src`, `gh_jid`, `lever-*`, `ref`,
   `source`, `src`, `trk`), force https, lowercase the host, drop `www.` and the fragment,
   sort the remaining query and trim a trailing slash. A unique index does the work.
2. **Fingerprint.** The plain joined string
   `normalizeCompany(company) + '|' + fingerprintTitle(title) + '|' + primary city`. Not
   hashed — there is nothing to hide and the raw key is readable in the database when you
   are working out why two rows did or didn't merge. This stage merges on that key alone,
   with no different-source guard, so every token the title normalizer throws away costs a
   posting outright. `fingerprintTitle` is therefore the cautious form: it strips a
   *labelled* requisition id ("Req #9931", "Job ID 4471") and a bracketed aside that holds
   nothing else, and it keeps roman numerals, season words and years. Under the aggressive
   form, "Machine Learning Intern I" and "Machine Learning Intern II" collapsed onto one row
   and one of two real openings never appeared in the queue, and a "(Summer 2026)" and a
   "(Fall 2026)" requisition became one. That aggressive form, `normalizeTitle`, belongs to
   stage 3, which can afford it because it only ever merges across different sources.
3. **Same title, different source.** Merge when the stemmed, stopword-stripped token *sets*
   of the two titles are equal, the company matches, and the posting comes from a source
   the surviving row hasn't already been seen on.

Stage 3 began as character-trigram similarity and that does not work here. Measured against
real pairs:

```
0.767  "Software Engineer Intern"  vs  "Software Engineering Intern"        ← same job
0.758  "Software Engineer Intern"  vs  "Software Engineer Intern, Backend"  ← DIFFERENT job
0.613  "Software Engineer Intern"  vs  "Hardware Engineer Intern"           ← DIFFERENT job
```

The pair that must merge and the pair that must not sit 0.009 apart, so no threshold
separates them, and an embedding would face the same problem for the same reason. Character
overlap is the wrong signal: what distinguishes these titles is whether one carries a
discriminating token — backend, hardware, design — that the other lacks. Set equality
catches engineer/engineering and refuses every pair that shouldn't merge. It errs toward not
merging, which is the safe direction: a visible duplicate is a minor annoyance, a silently
hidden posting is the worst failure this tool has.

The different-source requirement is part of the same caution. Two similar titles from one
board are almost always distinct requisitions, and merging them would hide one.

Duplicates are merged, not dropped: the surviving row keeps a `job_posting_source` link for
every source that saw it, so the UI can show "found on Greenhouse + Adzuna" and a source
going dark doesn't silently lose postings. Persistence applies the URL and fingerprint keys
against the database as well, so the same job found on Greenhouse in one run and Adzuna in
the next merges across runs rather than becoming two rows with two decisions to make.

### Freshness

`refreshPostings` runs **on demand, not on a schedule.** There is no timer, cron entry or
job runner anywhere in the repo; the only callers are `POST /api/discovery/refresh` for the
whole table and `POST /api/postings/:id/refresh` for one row. Nothing in the drafting or
filling path calls it either, so re-checking before an application goes out is something the
user does rather than something the tool enforces.

What a refresh does, in order:

- **Deadline passed.** `closes_at` in the past → `is_open = 0`. Pure SQL, no network.
- **Not seen in 45 days.** `last_seen_at` older than that → `is_open = 0`. The count comes
  back in the summary as `closedAsStale`; nothing records a per-row reason.
- **Optional URL check** (`checkUrls`). GET the canonical URL — oldest `last_seen_at` first,
  50 rows per call by default, open postings only, since this pass can only ever close
  something. Only 404 and 410 close a posting: a 500 or a timeout means the site is having a
  bad day, not that the job is gone, so those are counted as errors and the posting is left
  open. A successful fetch bumps `last_seen_at`.

There is no re-fetch by external ID for any source, and no HEAD request — `politeFetch`
takes no method. The canonical URL is the only probe.

Deadline pressure reaches the user through the tracker rather than through this pass: an
application carries its own `deadline_at`, and `buildReminders` (doc 11 § M7) raises it as
the highest-urgency reminder as the date nears and again once it has gone by.

Nothing is hard-deleted. A closed posting stays in the DB so the tracker and stats stay
intact.

## Politeness and caching

Implemented once in `infra/http`, used by every adapter:

- Per-domain token bucket, default 1 rps, configurable per call.
- Honors `Retry-After`, but capped at 60s — waiting longer than that is not politeness, it
  is a run that appears to have hung. An absent or unparseable header falls through to
  exponential backoff with full jitter on 429/5xx. 5 attempts max.
- Conditional requests via stored `ETag`/`Last-Modified`; response cache with 6h default TTL
  keyed on URL. Re-running discovery within the TTL costs almost nothing.
- User-Agent: `internship-applier/0.1 (+local personal job-search tool)`.
- `robots.txt` fetched and cached per origin for every page fetch — the manual paste-a-URL
  path and the refresh URL check. Documented API endpoints opt out with `isDocumentedApi`.
  A disallowed path raises a 403, which surfaces in the run summary rather than being
  silently skipped. `Allow:` is deliberately unimplemented: ignoring one can only make this
  refuse a fetch it could have made, which is the direction to be wrong in.

The concurrency cap lives in the discovery runner rather than here: `runDiscovery` fans
targets out across **4** workers by default, so a run can't saturate the user's link.

## Run reporting

Every discovery run produces a summary the UI shows: per source — postings found, how many
were new, every error, the source's own notes, and whether it was degraded. Run totals carry
found, new, duplicates and `closed`, plus a `skipped` list naming each source that contributed less
than it looks like it did. If a source was rate-limited, missing a key, or unknown to the
runner, that is stated. Silent truncation would read as "we searched everywhere" when we
didn't, which is exactly the failure mode that makes an automated search tool untrustworthy.
