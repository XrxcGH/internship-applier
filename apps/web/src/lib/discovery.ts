import type { SourceKind } from '@ia/shared';
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

interface SourceFacts {
  /** The vendor's own spelling of itself, for a chip, a report line, or a button. */
  label: string;
  /** What the board box holds for this source, so an empty one is never a mystery. */
  board: string;
  /**
   * Whether the adapter fetches nothing at all without a board.
   *
   * True for exactly the six ATS vendors whose fetch opens with `noBoard(...)` in
   * sources/ats.ts. Each of them answers an empty board with a note rather than an error,
   * so a target added without one costs a slot in the run, reports zero found, and looks
   * from the outside like a company with no openings. Cheaper to refuse it here.
   */
  needsBoard: boolean;
  /**
   * The reason shown beside a one-press add, for the sources that need neither a key nor a
   * board. Absent means this source is not offered as a button — see `keylessTargets`.
   */
  addReason?: string;
  /**
   * What the sources panel calls this source's prerequisite, when "key" is the wrong word.
   *
   * Web search needs no key of its own — it runs through the same model access that reads
   * a resume — and a panel saying "key set" about a signed-in Claude Code CLI would be
   * describing a credential that does not exist.
   */
  access?: { yes: string; no: string };
  /**
   * Why this source cannot contribute, when that is a standing fact rather than a run outcome.
   *
   * Shown wherever the source is listed, so the coverage gap is visible without a run having
   * to fail to reveal it.
   */
  unavailable?: string;
}

/**
 * Everything the interface knows about each source, in one table keyed by the shared enum.
 *
 * `Record<SourceKind, …>` rather than three loose lookups, because three loose lookups is
 * what this was and all three stopped at six sources through the change that shipped five
 * more. A resolved Workday board rendered as the raw word "workday", its board box offered
 * "a board name" for an address that has to be written tenant@host/site, and `needsBoard`
 * waved through the three vendors whose adapters refuse an empty board. Adding a kind to
 * SourceKind now fails the web typecheck until this table has an answer for it.
 */
const SOURCE_FACTS: Record<SourceKind, SourceFacts> = {
  greenhouse: {
    label: 'Greenhouse',
    board: 'the company token in its Greenhouse board URL',
    needsBoard: true,
  },
  lever: { label: 'Lever', board: 'the company slug in its Lever URL', needsBoard: true },
  ashby: { label: 'Ashby', board: 'the company name in its Ashby job board URL', needsBoard: true },
  workday: {
    label: 'Workday',
    // Not a slug, which is why the planner never guesses one: a Workday board is a tenant,
    // a host and a site name the company chose freely, and the resolver hands the whole
    // address over in this shape.
    board: 'the board address, written tenant@host/site',
    needsBoard: true,
  },
  smartrecruiters: {
    label: 'SmartRecruiters',
    board: 'the company identifier in its SmartRecruiters URL',
    needsBoard: true,
  },
  workable: {
    label: 'Workable',
    board: 'the account name in its Workable URL',
    needsBoard: true,
  },
  usajobs: {
    label: 'USAJOBS',
    board: 'not used — USAJOBS is searched by keyword',
    needsBoard: false,
  },
  adzuna: { label: 'Adzuna', board: 'not used — Adzuna is searched by keyword', needsBoard: false },
  arbeitnow: {
    label: 'Arbeitnow',
    board: 'not used — Arbeitnow is searched without a company',
    needsBoard: false,
    addReason: 'the Arbeitnow feed, no company and no key needed',
  },
  // Remotive's own robots.txt asks automated clients to stay off the address this adapter
  // uses, so the adapter asks, is refused, and reports the refusal. Saying it is "searched
  // by keyword" was doubly untrue: the endpoint discards every parameter it is given, and
  // the fetch does not happen at all. The student should not press a button expecting
  // postings from a source that will tell them at run time it read nothing.
  /**
   * Remotive's own robots.txt asks automated clients off the path this adapter reads, the
   * adapter asks, is refused, and reports the refusal. So it gets no `addReason` and
   * `keylessTargets` offers no button for it — a one-press button that answers every press
   * with a refusal teaches the user that this screen wastes their time.
   *
   * The refusal stays written down here rather than being deleted with the button. It is a
   * real limitation of this tool's coverage, and the first attempt at this change removed the
   * sentence that said so while leaving the button in place under a fabricated caption, which
   * is the exact trade this repo exists not to make.
   */
  remotive: {
    label: 'Remotive',
    board: 'not used — Remotive takes no company and no keyword',
    needsBoard: false,
    unavailable: 'declines automated reads, so nothing from it reaches your results',
  },
  github_list: {
    label: 'Community list',
    board: 'a GitHub repo. Left empty it reads the list for the upcoming season',
    needsBoard: false,
    addReason: 'the community list for the upcoming season',
  },
  web_search: {
    label: 'Web search',
    board: "not used — the plan's keywords are the search",
    needsBoard: false,
    access: { yes: 'model access', no: 'no model access' },
  },
  manual: {
    label: 'Pasted by URL',
    board: 'not used — a pasted address is the whole target',
    needsBoard: false,
  },
};

/**
 * The same table, widened so a name off the wire can be looked up in it.
 *
 * Every one of these three readers takes whatever string the server sent. The server is
 * ahead of this file often enough — a source can ship there and reach a run report before
 * anyone touches the interface — that an unknown name has to degrade rather than throw.
 */
const FACTS: Record<string, SourceFacts> = SOURCE_FACTS;

export function sourceLabel(name: string): string {
  return FACTS[name]?.label ?? name;
}

export function boardMeaning(source: string): string {
  return FACTS[source]?.board ?? 'a board name';
}

/**
 * The words the sources panel puts beside a source, for whether it can run today.
 *
 * One helper rather than a ternary in the page, because the ternary said "key set" about
 * every configured keyed source — including web search, whose prerequisite is model access
 * and involves no key at all when the Claude Code CLI is signed in.
 */
export function accessBadge(s: {
  name: string;
  requiresKey: boolean;
  configured: boolean;
}): string {
  if (!s.requiresKey) return 'no key needed';
  const words = FACTS[s.name]?.access ?? { yes: 'key set', no: 'no key' };
  return s.configured ? words.yes : words.no;
}
export function needsBoard(source: string): boolean {
  return FACTS[source]?.needsBoard ?? false;
}

/** The community list, which a fresh install has before it has anything else. */
const ALWAYS_OFFERED = 'github_list';

/**
 * The sources one button can add whole: no key to configure, no board to type.
 *
 * Read off what the server says it has rather than listed here, because a hand-written list
 * is what this row was and it stayed at the community list alone through the change that
 * shipped Arbeitnow and Remotive. Both are keyless, both need no company, and neither could
 * be added on its own: the only way to run them was to take the whole plan. A user who
 * builds their run by hand was quietly searching two feeds fewer than the tool has.
 *
 * The community list is offered before `/api/sources/available` answers, and again if that
 * read fails, so the one source a fresh install depends on is never behind a fetch.
 */
export function keylessTargets(sources: AvailableSource[] | null): RunTarget[] {
  const names = [
    ALWAYS_OFFERED,
    ...(sources ?? [])
      .filter(
        (s) =>
          !s.requiresKey &&
          s.name !== ALWAYS_OFFERED &&
          /**
           * KNOWN and board-free, not merely "not known to need a board".
           *
           * `needsBoard` answers false for a name this table has never heard of, which is the
           * right way to be wrong when labelling something — but as a filter it turned that
           * fallback into an offer: an unrecognised source got a one-press button, was added
           * with an empty board, passed the run guard, and reached the adapter's own
           * "no board was supplied" path. That is the reading-as-complete failure `needsBoard`
           * exists to prevent, under a reason line inventing that the source is "searched
           * without a company". A source this file cannot describe is not a source it can
           * offer in one press; it still appears everywhere else, where the fallback label is
           * the honest answer.
           *
           * Gating on `addReason` rather than on mere presence in the table, because the two
           * came apart: Remotive was given no `addReason` under a comment claiming "no button
           * offers it", and the button went on rendering — it is in FACTS and needs no board,
           * which was the whole test — captioned by the fallback below with a search the
           * adapter refuses before it sends a request. A source that has not been given a
           * reason to be offered in one press is a source with no one-press offer.
           */
          FACTS[s.name]?.addReason !== undefined &&
          !needsBoard(s.name),
      )
      .map((s) => s.name),
  ];
  return names.map((name) => ({
    source: name,
    board: '',
    // The fallback asserts nothing about what a search will do, because it cannot know: the
    // filter above only admits names that HAVE an addReason, and the one name that reaches
    // this branch is ALWAYS_OFFERED. "Searched without a company" was a claim, and it was
    // false for the one source that ever reached it.
    reason: FACTS[name]?.addReason ?? `${sourceLabel(name)}, no company or key needed`,
  }));
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
 * turns each name into five unverified board guesses — Greenhouse, Lever, Ashby,
 * SmartRecruiters and Workable — so a list holding both "Stripe" and "stripe" costs ten
 * targets out of a cap of forty to search one company.
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
    return 'Nothing to search yet. Add one of the keyless feeds, or resolve a company in section 03.';
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

/**
 * The `notes` are half the answer and were being thrown away here.
 *
 * An empty `matches` reads as "this company has no board at any vendor we asked", and the
 * server says in a note that it cannot make that claim for SmartRecruiters, which answers a
 * name it has never heard of exactly as it answers a real company with nothing posted. The
 * response type stopped at `matches`, so the sentence that qualifies it never reached the
 * screen.
 */
export const resolveCompany = (name: string) =>
  request<{ name: string; matches: Resolution[]; notes: string[] }>('/api/companies/resolve', {
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

/**
 * The paste-the-TEXT path, for postings on sites this tool will not fetch — docs/04 § Tier C.
 *
 * Handshake, LinkedIn and Indeed prohibit automated access, and Handshake sits behind a
 * university login besides. A student reading their own account is not automated access, so
 * the text comes from them. The URL is stored as the way back and is never fetched.
 */
export const addPastedPosting = (input: {
  text: string;
  title: string;
  company: string;
  url: string;
  readOn?: string;
}) =>
  request<ManualResult>('/api/discovery/paste', {
    method: 'POST',
    headers: json,
    body: JSON.stringify(input),
  });

/** Why a source cannot contribute at all, when that is a standing fact. See `SourceFacts`. */
export function unavailableReason(name: string): string | null {
  return FACTS[name]?.unavailable ?? null;
}

export interface StoredSource {
  id: string;
  kind: string;
  label: string;
  enabled: boolean;
  /** On the table, written by nothing in apps/server — see the Settings comment. */
  lastRunAt: string | null;
  postings: number;
}

/**
 * The boards this machine has written down, and the switch for each.
 *
 * Both endpoints have existed and been documented since M2 with nothing in the interface
 * calling them, while two comments in `routes/discovery.ts` offered "the source can be
 * switched off in Settings" as the mitigation that justifies writing a resolution row at
 * all. There was no such control. It matters more now that a board answering 404/410/422
 * switches ITSELF off: without this, one bad answer removed a board from every future plan
 * with no way back — and Workday is deliberately never guessed, so a Workday board could not
 * even be re-resolved by pinning the company again.
 */
export const listStoredSources = () => request<StoredSource[]>('/api/sources');

export const setSourceEnabled = (id: string, enabled: boolean) =>
  request<{ id: string; enabled: boolean }>(`/api/sources/${id}`, {
    method: 'PUT',
    headers: json,
    body: JSON.stringify({ enabled }),
  });
