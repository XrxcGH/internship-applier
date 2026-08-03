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

**Tier B — general web search + structured page data.** A search provider (Brave Search API
or Google Programmable Search — key supplied by the user) returns candidate career-page
URLs; we fetch each and read the embedded `schema.org/JobPosting` JSON-LD, which most ATS
pages ship. Fall back to Claude reading the page text if JSON-LD is absent. `robots.txt` is
respected, per-domain rate limit applies, and we identify ourselves in the User-Agent.

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
     → else: fetch acme.com, look for a careers link + ATS fingerprint in the HTML
```

Resolved company → ATS mappings are cached in `source.config` so subsequent runs are one
request.

## Query planning

`queryPlanner` turns the confirmed profile into a bounded set of source queries. It does
**not** ask the model to invent queries freely; it composes them from profile facts:

```ts
roleFamilies   // derived from skills + experience titles + stated interests
  × termTokens // ["summer 2027 internship", "summer intern", "2027 summer analyst", ...]
  × locations  // base city, relocation targets, "remote"
  → deduped, capped at N queries per run (default 40)
```

Role families come from a small LLM call over the profile (returns a ranked list with
confidence), then get filtered against a curated taxonomy so a bad generation can't send
40 queries for a role the user has no evidence for. The user sees and can edit the query
list before a run — discovery is not a black box either.

## Pipeline

```
plan queries
   │
   ├─▶ [Tier A adapters]  ─┐
   ├─▶ [company targets]  ─┤
   └─▶ [Tier B search]    ─┤
                            ▼
                    normalize → JobPosting
                            │
                            ▼
                    dedupe (3 stages)
                            │
                            ▼
                    persist job_posting
                            │
                            ▼
                    extract job_requirement (LLM, batched)
                            │
                            ▼
                    matching (doc 05)
```

Every stage is a task in the `tasks` table, so a run is resumable and its progress is
streamable to the UI over SSE.

### Normalization

Each adapter implements one interface:

```ts
interface JobSource {
  kind: SourceKind;
  fetch(query: SourceQuery, ctx: FetchCtx): AsyncIterable<RawPosting>;
  normalize(raw: RawPosting): NormalizedPosting;   // pure, unit-tested per source
  health(): Promise<SourceHealth>;
}
```

Normalization is deterministic parsing, not an LLM call: title/company/location/dates come
straight from structured source fields. The only LLM step in discovery is requirement
extraction, which happens after persistence and is cached by posting.

Term detection (`summer 2027` vs `fall`) is a small deterministic parser over title + dates
+ description, with an `unknown` outcome rather than a guess. `unknown` postings are shown
with a badge, not filtered out.

### Dedupe

Three stages, cheapest first:

1. **Canonical URL.** Strip tracking params (`utm_*`, `gh_src`, `lever-source`, `ref`),
   normalize host/case/trailing slash. Unique index does the work.
2. **Fingerprint.** `sha1(normalize(company) + '|' + normalize(title) + '|' + normalize(primaryLocation))`.
   Title normalization strips req IDs, roman numerals, and location suffixes.
3. **Near-duplicate.** Optional embedding cosine similarity over `title + first 500 chars`
   at threshold ~0.94, to catch "Software Engineer Intern" vs "Software Engineering
   Intern — Summer 2027". Only runs for postings that survived 1 and 2 from *different*
   sources.

Duplicates are merged, not dropped: the surviving row keeps every `source_id` that saw it,
so the UI can show "found on Greenhouse + Adzuna" and a source going dark doesn't silently
lose postings.

### Freshness

A `refresh` task re-checks open postings on a schedule (default every 24h, and always
before an application is drafted):

- Re-fetch by external ID where the source supports it, else HEAD/GET the canonical URL.
- 404/410 or an explicit closed flag → `is_open = 0`.
- `closes_at` in the past → `is_open = 0`, and any pending application for it is flagged
  urgently in the UI.
- `last_seen_at` older than 45 days with no successful refetch → `is_open = 0` with reason
  `stale`.

Nothing is hard-deleted. A closed posting stays in the DB so the tracker and stats stay
intact.

## Politeness and caching

Implemented once in `infra/http`, used by every adapter:

- Per-domain token bucket, default 1 rps, configurable per source.
- Honors `Retry-After`; exponential backoff with full jitter on 429/5xx; 5 attempts max.
- Conditional requests via stored `ETag`/`Last-Modified`; response cache with 6h default TTL
  keyed on URL. Re-running discovery within the TTL costs almost nothing.
- Concurrency cap across all sources (default 6) so a run can't saturate the user's link.
- User-Agent: `internship-applier/<version> (+local personal job-search tool)`.
- `robots.txt` fetched and cached per host for Tier B page fetches; disallowed paths are
  skipped and reported in the run summary.

## Run reporting

Every discovery run produces a summary the UI shows: per source — requests made, postings
returned, new, duplicates, errors, and whether the source was degraded or skipped. If a
source was rate-limited or a query was dropped, that is stated. Silent truncation would
read as "we searched everywhere" when we didn't, which is exactly the failure mode that
makes an automated search tool untrustworthy.
