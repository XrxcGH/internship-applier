/**
 * Company → ATS board resolution — docs/04 § Company target list.
 *
 * Probes the public board endpoints for a slug. Resolved mappings are cached in the
 * `source` table so later runs are a single request.
 */
import { fetchJson, HttpError } from '../../infra/http/fetcher';
import type { AtsSourceName } from './sources/ats';

export interface Resolution {
  source: AtsSourceName;
  board: string;
  jobCount: number;
}

const PROBES: Array<{
  source: AtsSourceName;
  url: (slug: string) => string;
  count: (data: unknown) => number;
}> = [
  {
    source: 'greenhouse',
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    count: (d) => (d as { jobs?: unknown[] }).jobs?.length ?? 0,
  },
  {
    source: 'lever',
    url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json&limit=1`,
    count: (d) => (Array.isArray(d) ? d.length : 0),
  },
  {
    source: 'ashby',
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    count: (d) => (d as { jobs?: unknown[] }).jobs?.length ?? 0,
  },
];

/** Slug candidates, most likely first. */
export function slugCandidates(name: string): string[] {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  return [
    ...new Set([base.replace(/\s+/g, ''), base.replace(/\s+/g, '-'), base.split(' ')[0] ?? base]),
  ].filter(Boolean);
}

export async function resolveCompany(name: string): Promise<Resolution[]> {
  const found: Resolution[] = [];

  for (const slug of slugCandidates(name)) {
    for (const probe of PROBES) {
      try {
        const data = await fetchJson<unknown>(probe.url(slug), { rps: 2, timeoutMs: 8000 });
        const jobCount = probe.count(data);
        // A board that exists but is empty is still a valid mapping worth caching.
        found.push({ source: probe.source, board: slug, jobCount });
      } catch (err) {
        // 404 just means "not this vendor"; anything else is worth knowing about.
        if (!(err instanceof HttpError) || err.status !== 404) continue;
      }
    }
    if (found.length > 0) break;
  }

  return found.sort((a, b) => b.jobCount - a.jobCount);
}
