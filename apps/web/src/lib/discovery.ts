import { request } from './api';

/**
 * The client half of discovery — docs/04.
 *
 * Every endpoint below existed and was reachable for the whole of M2 with nothing in the
 * interface calling it, which is why the queue's empty state used to tell people to POST to
 * the API by hand. The types here are read off the server's own shapes: `QueryPlan` from
 * core/discovery/queryPlanner.ts, `RunSummary` and `SourceReport` from core/discovery/run.ts.
 *
 * There is no progress stream. The server publishes `discovery.progress` on SSE and nothing
 * subscribes (docs/08 § Real-time), so a run answers once, when it is over. The screen says
 * so rather than showing a bar that is not measuring anything.
 */

// ─────────────────────────────────────────────────────────────────── server shapes

export interface PlannedTarget {
  source: string;
  board: string;
  /** Why the planner put it in — shown beside the chip. */
  reason: string;
}

export interface QueryPlan {
  targets: PlannedTarget[];
  keywords: string[];
  roleFamilies: string[];
  termTokens: string[];
  locations: string[];
  notes: string[];
}

export interface SourceReport {
  source: string;
  board: string;
  found: number;
  new: number;
  errors: string[];
  notes: string[];
  degraded: boolean;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  targets: number;
  found: number;
  new: number;
  duplicates: number;
  /**
   * Stored postings a source said outright have closed. Optional because a summary written
   * before this existed is read back from the database by the run history.
   */
  closed?: number;
  bySource: SourceReport[];
  /** Everything the run did not cover, never left implicit — docs/04 § Pipeline reporting. */
  skipped: string[];
}

export interface AvailableSource {
  name: string;
  requiresKey: boolean;
  configured: boolean;
}

export interface Resolution {
  source: string;
  board: string;
  jobCount: number;
}

export interface ManualResult {
  postingId: string;
  posting: { company: string; title: string; canonicalUrl: string; applyUrl: string };
  usedJsonLd: boolean;
  notes: string[];
}

/**
 * One line of the run list the user is about to send.
 *
 * `reason` never goes to the server — `RunBody` would strip it anyway — but it is the whole
 * point of showing the plan before running it, so it travels with the target on the client.
 */
export interface RunTarget {
  source: string;
  board: string;
  reason: string;
  keywords?: string[];
  location?: string;
}

// ─────────────────────────────────────────────────────────────────── source facts

const SOURCE_LABEL: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  adzuna: 'Adzuna',
  usajobs: 'USAJOBS',
  github_list: 'Community list',
};

export function sourceLabel(name: string): string {
  return SOURCE_LABEL[name] ?? name;
}

/** What the board field means for each source, so an empty box is never a mystery. */
const BOARD_MEANING: Record<string, string> = {
  greenhouse: 'the company token in its Greenhouse board URL',
  lever: 'the company slug in its Lever URL',
  ashby: 'the company name in its Ashby job board URL',
  adzuna: 'not used — Adzuna is searched by keyword',
  usajobs: 'not used — USAJOBS is searched by keyword',
  github_list: 'a GitHub repo. Left empty it reads the list for the upcoming season',
};

export function boardMeaning(source: string): string {
  return BOARD_MEANING[source] ?? 'a board name';
}

/**
 * The three sources that fetch nothing without one.
 *
 * Each of their adapters answers an empty board with a note rather than an error — "no
 * board token supplied" — so a target added without one costs a slot in the run, reports
 * zero found, and looks from the outside like a company with no openings. Cheaper to refuse
 * it here.
 */
const NEEDS_BOARD = new Set(['greenhouse', 'lever', 'ashby']);

export function needsBoard(source: string): boolean {
  return NEEDS_BOARD.has(source);
}

// ─────────────────────────────────────────────────────────────────── the run list

/**
 * Defensive about `board`, because the server has been wrong about it.
 *
 * `PlannedTarget` promises a string and the plan endpoint once answered with the key missing
 * entirely: a company name with no ASCII alphanumerics — "삼성전자", or a name that is nothing
 * but a stripped suffix — left `slugCandidates` empty, a non-null assertion put `undefined`
 * in the board, and `JSON.stringify` dropped the key on the way out. The first `.trim()` on
 * this side then threw during render, and with no error boundary anywhere in the app the
 * screen went blank until a reload. The server no longer does that. This still does not
 * trust it, because a blank chip is a bad plan and a blank screen is a broken app.
 */
export function boardOf(t: { board?: string | null }): string {
  return t.board ?? '';
}

export function targetKey(t: { source: string; board?: string | null }): string {
  return `${t.source}:${boardOf(t)}`;
}

/**
 * Adds targets to the list, keeping the first reason given for each.
 *
 * Three routes reach this list — the planner, a company resolution, and the keyless-source
 * buttons — and they overlap constantly: a board resolved by hand is also a board the
 * planner knows from the last run. Sending the same `source:board` twice fetches it twice,
 * counts it twice in `found`, and files the second copy under duplicates, so the report
 * reads as though the source had returned the same jobs to two different queries.
 *
 * First reason wins because the earlier one is the one already on screen.
 */
export function mergeTargets(existing: RunTarget[], incoming: RunTarget[]): RunTarget[] {
  const out = [...existing];
  const seen = new Set(existing.map(targetKey));
  for (const t of incoming) {
    const key = targetKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Company names as a person types them: commas, semicolons, or one per line.
 *
 * Deduplicated case-insensitively, keeping the spelling first written, because the planner
 * turns each name into three unverified board guesses — so a list holding both "Stripe" and
 * "stripe" costs six targets out of a cap of forty to search one company.
 */
export function splitCompanies(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\n]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** The server's own ceiling on one run — `RunBody` takes between 1 and 200 targets. */
const MAX_TARGETS = 200;

/**
 * Why the Run button is off, in the words the user needs, or null when it is on.
 *
 * Each branch mirrors something the server or an adapter would do quietly: an empty list is
 * a 400, a missing board is a source that reports zero found, and 201 targets is a 400 whose
 * message names a Zod issue rather than the list on screen.
 */
export function whyCannotRun(targets: RunTarget[]): string | null {
  if (targets.length === 0) {
    return 'Nothing to search yet. Add the community list, or resolve a company below.';
  }
  const blank = targets.find((t) => needsBoard(t.source) && boardOf(t).trim() === '');
  if (blank) {
    return `The ${sourceLabel(blank.source)} target has no board name, so it would fetch nothing.`;
  }
  if (targets.length > MAX_TARGETS) {
    return `That is ${targets.length} targets. One run takes at most ${MAX_TARGETS}.`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────── reading a summary

/**
 * Postings this run saw that were already in the database.
 *
 * The summary reports `found` (everything fetched), `new` (rows inserted) and `duplicates`
 * (copies collapsed within this run), and the gap between them is the largest number of the
 * four on any second run — re-fetching a board mostly turns up what it turned up last time.
 * Left unnamed, "412 found, 3 new" reads as though 409 postings went missing.
 */
export function alreadyStored(s: RunSummary): number {
  return Math.max(0, s.found - s.new - s.duplicates);
}

/** The one-line result, with every posting fetched accounted for somewhere in it. */
export function runHeadline(s: RunSummary): string {
  // A run that fetched nothing can still have done the most useful thing in it: a source
  // that lists its own finished roles closes postings without returning a single open one.
  const closed = s.closed ?? 0;
  if (s.found === 0) {
    return closed > 0
      ? `No source returned an open posting · ${closed} closed`
      : 'No source returned a posting.';
  }
  const seen = alreadyStored(s);
  const parts = [
    `${s.found} ${s.found === 1 ? 'posting' : 'postings'} fetched`,
    s.new === 0 ? 'none new' : `${s.new} new`,
  ];
  if (seen > 0) parts.push(`${seen} already stored`);
  if (s.duplicates > 0) parts.push(`${s.duplicates} merged`);
  if (closed > 0) parts.push(`${closed} closed`);
  return parts.join(' · ');
}

/** How long a run took, from the two timestamps it stamps on itself. */
export function durationLabel(startedAt: string, finishedAt: string): string {
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (Number.isNaN(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60)}s`;
}

/**
 * When something happened, in the coarsest unit that still answers the question.
 *
 * A run list is read to find out whether a search is worth repeating, and an ISO timestamp
 * makes the reader do that arithmetic themselves. Future times are possible whenever the
 * clock moves, so they are not asserted to be in the past.
 */
export function whenLabel(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return 'at an unknown time';
  if (ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

// ─────────────────────────────────────────────────────────────────────── endpoints

const json = { 'content-type': 'application/json' };

/**
 * The plan, with the companies the user pinned.
 *
 * `company.onlyCompanies` is one of the seven filter leaves the planner actually reads
 * (packages/shared/src/filters.ts). Nothing else is sent: the rest of `SearchFilters` parses
 * and is then dropped, and the plan endpoint would answer a fully populated body with the
 * plan an empty one produces plus a note saying it had ignored everything.
 */
export const getPlan = (companies: string[] = []) =>
  request<QueryPlan>('/api/discovery/plan', {
    method: 'POST',
    headers: json,
    body: JSON.stringify(
      companies.length > 0 ? { filters: { company: { onlyCompanies: companies } } } : {},
    ),
  });

export const startRun = (targets: RunTarget[]) =>
  request<RunSummary>('/api/discovery/run', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      targets: targets.map((t) => ({
        source: t.source,
        board: t.board,
        ...(t.keywords && t.keywords.length > 0 ? { keywords: t.keywords } : {}),
        ...(t.location ? { location: t.location } : {}),
      })),
    }),
  });

export const listRuns = () => request<RunSummary[]>('/api/discovery/runs');

export const availableSources = () => request<AvailableSource[]>('/api/sources/available');

export const postingStats = () => request<{ total: number; open: number }>('/api/discovery/stats');

export const resolveCompany = (name: string) =>
  request<{ name: string; matches: Resolution[] }>('/api/companies/resolve', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ name }),
  });

/** The paste-a-URL path — docs/04 § Tier C. One posting, fetched because you asked for it. */
export const addManualPosting = (url: string) =>
  request<ManualResult>('/api/discovery/manual', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ url }),
  });
