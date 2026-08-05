/**
 * Company → ATS board resolution — docs/04 § Company target list.
 *
 * Probes the public board endpoints for a slug and returns whichever answered. Nothing
 * here writes to the database: a resolution is shown to the user and then forgotten, and
 * the `source` row labelled "greenhouse:acme" only appears once a discovery run has
 * actually pulled that board. Caching the mapping so a second resolve is a single request
 * is not built, so resolving the same company twice re-probes every vendor.
 */
import { fetchJson, HttpError } from '../../infra/http/fetcher';
import { logger } from '../../infra/logger';
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
    // No limit. The count is what the resolution sort ranks boards by, and limit=1
    // capped every Lever board at a jobCount of 1 — so an almost-empty Greenhouse board
    // outranked a Lever board with two hundred openings, and the number shown to the
    // caller was wrong for every Lever result.
    url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
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
        // A board that answered but has nothing posted today still answers the question
        // the caller asked — which vendor this company uses — so it is returned with a
        // count of zero rather than dropped. The sort at the end puts it last.
        found.push({ source: probe.source, board: slug, jobCount });
      } catch (err) {
        // A 404 is the ordinary answer to "does this company use this vendor?" and needs
        // no comment. Anything else — DNS failure, timeout, a 503, a rate limit that
        // outlasted the retries — means the vendor was never actually checked, and the
        // caller sees the same empty result as a company that genuinely has no board
        // there. The condition used to be `continue`, which did nothing at all.
        if (!(err instanceof HttpError) || err.status !== 404) {
          logger.warn({ err, source: probe.source, slug }, 'company board probe failed');
        }
      }
    }
    if (found.length > 0) break;
  }

  return found.sort((a, b) => b.jobCount - a.jobCount);
}
