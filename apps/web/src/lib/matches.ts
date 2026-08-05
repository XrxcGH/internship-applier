import type { RuleResult, ScoreBreakdown } from '@ia/shared';
import { appToken, clearToken } from './session';

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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      'x-app-token': await appToken(),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) clearToken();
  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = body as { error?: { message?: string } } | null;
    throw new Error(e?.error?.message ?? `${path} responded ${res.status}`);
  }
  return body as T;
}

export const listMatches = (params: {
  eligibility: string;
  minScore: number;
  hideDecided: boolean;
}) =>
  req<MatchListResponse>(
    `/api/matches?eligibility=${params.eligibility}&minScore=${params.minScore}&hideDecided=${params.hideDecided}&limit=300`,
  );

export const getMatch = (id: string) => req<MatchDetail>(`/api/matches/${id}`);

export const decide = (
  id: string,
  action: 'approved' | 'skipped' | 'rejected' | 'saved',
  reason?: string,
  reasonTags: string[] = [],
) =>
  req<{ action: string; applicationId: string | null }>(`/api/matches/${id}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, reason, reasonTags }),
  });

export const recompute = () =>
  req<{ matched: number; eligible: number; unknown: number; ineligible: number }>(
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
  const money = (n: number): string => n.toLocaleString('en-US');
  const PERIOD: Record<string, string> = {
    hour: '/hr',
    week: '/wk',
    month: '/mo',
    year: '/yr',
    total: ' total',
  };

  const max = typeof c['max'] === 'number' ? `–$${money(c['max'])}` : '';
  const period = PERIOD[String(c['period'] ?? 'hour')] ?? '/hr';
  return `$${money(min)}${max}${period}`;
}

export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  return Number.isNaN(ms) ? null : Math.ceil(ms / 86_400_000);
}
