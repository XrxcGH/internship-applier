import type { RuleResult, ScoreBreakdown } from '@ia/shared';
import { request } from './api';

export interface MatchRow {
  id: string;
  eligibility: 'eligible' | 'unknown' | 'ineligible';
  score: number;
  rationale: string;
  breakdown: ScoreBreakdown & { notes?: Record<string, string> };
  blockers: RuleResult[];
  postingId: string;
  company: string;
  title: string;
  applyUrl: string;
  canonicalUrl: string;
  locations: Array<{ city?: string; region?: string; remote?: boolean }> | null;
  positionType: string | null;
  workArrangement: string | null;
  term: { season: string | null; year: number | null } | null;
  compensation: Record<string, unknown> | null;
  closesAt: string | null;
  atsVendor: string;
}

export interface MatchListResponse {
  matches: MatchRow[];
  counts: Record<string, number>;
}

export interface JobRequirementRow {
  id: string;
  kind: string;
  operator: string;
  value: unknown;
  necessity: string;
  sourceQuote: string;
  confidence: number;
}

export interface MatchDetail {
  match: {
    id: string;
    eligibility: string;
    score: number;
    rationale: string;
    rules: RuleResult[];
    blockers: RuleResult[];
    breakdown: ScoreBreakdown & { notes?: Record<string, string> };
  };
  posting: {
    id: string;
    company: string;
    title: string;
    applyUrl: string;
    descriptionText: string;
    closesAt: string | null;
    atsVendor: string;
    locations: Array<{ city?: string; region?: string; remote?: boolean }> | null;
    term: { season: string | null; year: number | null } | null;
    compensation: Record<string, unknown> | null;
    positionType: string | null;
    workArrangement: string | null;
  };
  requirements: JobRequirementRow[];
  decision: { action: string; reason: string | null } | null;
}

/** The server's own ceiling on one page. Asking for more is rejected outright. */
const PAGE = 500;

/**
 * Every match in the band, not the first pageful.
 *
 * This asked for 300 rows and stopped there, with nothing on screen to say so. A real
 * discovery run produces more than that — the counts chip beside the list reads off the
 * whole table — so the queue claimed several hundred eligible postings and then quietly
 * withheld the tail of them, which only surfaced as rows mysteriously appearing after
 * earlier ones were decided. The safety bound is far past any local dataset and exists so
 * a server that ignored `offset` could not spin this forever.
 */
export async function listMatches(params: {
  eligibility: string;
  minScore: number;
  hideDecided: boolean;
}): Promise<MatchListResponse> {
  const matches: MatchRow[] = [];
  let counts: Record<string, number> = {};

  for (let page = 0; page < 20; page += 1) {
    const q = new URLSearchParams({
      eligibility: params.eligibility,
      minScore: String(params.minScore),
      hideDecided: String(params.hideDecided),
      limit: String(PAGE),
      offset: String(page * PAGE),
    });
    const r = await request<MatchListResponse>(`/api/matches?${q.toString()}`);
    matches.push(...r.matches);
    counts = r.counts;
    if (r.matches.length < PAGE) break;
  }

  return { matches, counts };
}

export const getMatch = (id: string) => request<MatchDetail>(`/api/matches/${id}`);

export const decide = (
  id: string,
  action: 'approved' | 'skipped' | 'rejected' | 'saved',
  reason?: string,
  reasonTags: string[] = [],
) =>
  request<{ action: string; applicationId: string | null }>(`/api/matches/${id}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, reason, reasonTags }),
  });

export const recompute = () =>
  request<{ matched: number; eligible: number; unknown: number; ineligible: number }>(
    '/api/matches/recompute',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );

export const REJECT_REASONS = [
  { tag: 'wrong_role', label: 'Wrong kind of role' },
  { tag: 'wrong_location', label: 'Location does not work' },
  { tag: 'company', label: 'Not interested in this company' },
  { tag: 'too_senior', label: 'Too senior for me' },
  { tag: 'low_pay', label: 'Pay is too low' },
  { tag: 'effort', label: 'Application is too long' },
  { tag: 'not_interested', label: 'Just not interested' },
] as const;

export function locationLabel(m: {
  locations: Array<{ city?: string; region?: string; remote?: boolean }> | null;
  workArrangement: string | null;
}): string {
  if (m.workArrangement === 'remote' || m.locations?.some((l) => l.remote)) return 'Remote';
  const first = m.locations?.[0];
  if (!first) return 'Location not stated';
  return [first.city, first.region].filter(Boolean).join(', ') || 'Location not stated';
}

export function termLabel(term: { season: string | null; year: number | null } | null): string {
  if (!term?.season && !term?.year) return 'Term not stated';
  return [term?.season?.replace('_', ' '), term?.year].filter(Boolean).join(' ');
}

export function payLabel(c: Record<string, unknown> | null): string {
  if (!c) return 'Pay not disclosed';
  if (c['unpaid']) return 'Unpaid';
  if (c['academicCreditOnly']) return 'Credit only';
  const min = c['min'];
  if (typeof min !== 'number') return 'Pay not disclosed';

  /**
   * Thousands separators and one display form per period.
   *
   * A yearly salary used to render as "$110000–130000/year", and the fallback was 'hr'
   * while every real value is one of the five schema tokens — so two hourly postings
   * could show '/hour' and '/hr' depending on whether the field happened to be set. This
   * string sits in the G2 detail pane, where someone is deciding whether to apply.
   */
  const PERIOD: Record<string, string> = {
    hour: '/hr',
    week: '/wk',
    month: '/mo',
    year: '/yr',
    total: ' total',
  };

  /**
   * The currency the posting stated, rather than a dollar sign on everything.
   *
   * This printed "$" whatever `currency` held, which was survivable only while the parser
   * could read nothing but dollars. It reads symbols now, and Ashby alone returns GBP and
   * SEK on an ordinary board — so a €2,000 stipend would have been shown to the user as
   * "$2,000/mo", which is not a formatting slip but a wrong number in the pane where
   * someone decides whether a posting is worth applying to.
   *
   * A currency with no symbol here is written out in full after the figure ("2,000 SEK")
   * rather than guessed at. That is how those currencies are ordinarily written, and it
   * cannot be mistaken for a different one.
   */
  const SYMBOL: Record<string, string> = {
    USD: '$',
    CAD: 'CA$',
    AUD: 'A$',
    NZD: 'NZ$',
    SGD: 'S$',
    HKD: 'HK$',
    TWD: 'NT$',
    MXN: 'MX$',
    BRL: 'R$',
    GBP: '£',
    EUR: '€',
    JPY: '¥',
    INR: '₹',
  };
  const code = typeof c['currency'] === 'string' ? c['currency'].toUpperCase() : 'USD';
  const symbol = SYMBOL[code];
  const money = (n: number): string => {
    const figure = n.toLocaleString('en-US');
    return symbol ? `${symbol}${figure}` : `${figure} ${code}`;
  };

  const max = typeof c['max'] === 'number' ? `–${money(c['max'])}` : '';
  const period = PERIOD[String(c['period'] ?? 'hour')] ?? '/hr';
  return `${money(min)}${max}${period}`;
}

/**
 * Whole days left, rounded away from now in both directions.
 *
 * Ceiling alone turned a deadline that passed a few hours ago into -0, which is not less
 * than zero and prints as "0" — so the queue told someone a posting that had already
 * closed had "0d left", in the same red it uses for urgency.
 */
export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return null;
  const days = ms / 86_400_000;
  return ms < 0 ? Math.floor(days) : Math.ceil(days);
}
