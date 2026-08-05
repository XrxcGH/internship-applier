/**
 * Adapters for the public ATS job-board APIs — docs/04 § Tier A.
 *
 * These are documented, keyless, public endpoints that exist to be consumed
 * programmatically. Between them they cover most of the companies a student would
 * apply to. Nothing here touches a site whose terms prohibit automated access.
 */
import { fetchJson } from '../../../infra/http/fetcher';
import {
  canonicalUrl,
  parseCompensation,
  parseDurationWeeks,
  parseHybridDays,
  parsePositionType,
  parseRequirements,
  parseSeason,
  parseTermDates,
  parseWorkArrangement,
  parseYear,
} from '../normalize';
import {
  decodeEntities,
  stripHtml,
  type JobSource,
  type NormalizedPosting,
  type SourceQuery,
  type SourceResult,
} from './types';

function build(
  partial: Pick<
    NormalizedPosting,
    'externalId' | 'canonicalUrl' | 'applyUrl' | 'company' | 'title'
  > &
    Partial<NormalizedPosting>,
  text: string,
): NormalizedPosting {
  const haystack = `${partial.title}\n${text}`;
  const dates = parseTermDates(haystack);
  const comp = parseCompensation(haystack);
  const season = parseSeason(haystack);
  const duration = parseDurationWeeks(haystack);

  return {
    companyDomain: null,
    descriptionText: text,
    descriptionHtml: null,
    locations: [],
    positionType: parsePositionType(partial.title, text),
    workArrangement: parseWorkArrangement(haystack),
    hybridDaysOnsite: parseHybridDays(haystack),
    remoteEligibleIn: [],
    programFlags: [],
    term: {
      season,
      year: parseYear(haystack),
      ...(dates ?? {}),
      durationWeeks: duration,
      // A co-op or anything past ~20 weeks spans more than one academic term.
      multiTerm: duration !== null && duration > 20,
    },
    compensation: comp as Record<string, unknown> | null,
    requires: parseRequirements(text),
    postedAt: null,
    closesAt: null,
    atsVendor: 'unknown',
    ...partial,
  };
}

// ---------------------------------------------------------------- Greenhouse

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  content?: string;
  updated_at?: string;
  location?: { name?: string };
}

export const greenhouse: JobSource = {
  kind: 'greenhouse',
  requiresKey: false,
  isConfigured: () => true,
  async fetch(q: SourceQuery): Promise<SourceResult> {
    if (!q.board) return { postings: [], notes: ['greenhouse: no board token supplied'] };
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(q.board)}/jobs?content=true`;
    const data = await fetchJson<{ jobs?: GhJob[] }>(url, { rps: 2 });

    const postings = (data.jobs ?? []).map((j) => {
      // Greenhouse returns `content` HTML-escaped. Decoded first, or stripHtml finds no
      // tags to strip and its own decode step reintroduces them as visible text.
      const html = j.content ? decodeEntities(j.content) : '';
      const text = stripHtml(html);
      return build(
        {
          externalId: String(j.id),
          canonicalUrl: canonicalUrl(j.absolute_url),
          applyUrl: j.absolute_url,
          company: q.board!,
          title: j.title,
          atsVendor: 'greenhouse',
          descriptionHtml: html || null,
          postedAt: j.updated_at ?? null,
          locations: j.location?.name ? [parseLocation(j.location.name)] : [],
        },
        text,
      );
    });

    return { postings, notes: [] };
  },
};

// ---------------------------------------------------------------- Lever

interface LeverPost {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  descriptionPlain?: string;
  createdAt?: number;
  categories?: { location?: string; commitment?: string; team?: string };
}

export const lever: JobSource = {
  kind: 'lever',
  requiresKey: false,
  isConfigured: () => true,
  async fetch(q: SourceQuery): Promise<SourceResult> {
    if (!q.board) return { postings: [], notes: ['lever: no company slug supplied'] };
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(q.board)}?mode=json`;
    const data = await fetchJson<LeverPost[]>(url, { rps: 2 });

    const postings = data.map((p) => {
      const text = p.descriptionPlain ?? '';
      return build(
        {
          externalId: p.id,
          canonicalUrl: canonicalUrl(p.hostedUrl),
          applyUrl: p.applyUrl ?? p.hostedUrl,
          company: q.board!,
          title: p.text,
          atsVendor: 'lever',
          postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
          locations: p.categories?.location ? [parseLocation(p.categories.location)] : [],
        },
        `${text}\n${p.categories?.commitment ?? ''}`,
      );
    });

    return { postings, notes: [] };
  },
};

// ---------------------------------------------------------------- Ashby

interface AshbyJob {
  id: string;
  title: string;
  jobUrl: string;
  location?: string;
  descriptionPlain?: string;
  employmentType?: string;
  isRemote?: boolean;
  publishedAt?: string;
}

export const ashby: JobSource = {
  kind: 'ashby',
  requiresKey: false,
  isConfigured: () => true,
  async fetch(q: SourceQuery): Promise<SourceResult> {
    if (!q.board) return { postings: [], notes: ['ashby: no board name supplied'] };
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(q.board)}?includeCompensation=true`;
    const data = await fetchJson<{ jobs?: AshbyJob[] }>(url, { rps: 2 });

    const postings = (data.jobs ?? []).map((j) => {
      const text = j.descriptionPlain ?? '';
      const p = build(
        {
          externalId: j.id,
          canonicalUrl: canonicalUrl(j.jobUrl),
          applyUrl: j.jobUrl,
          company: q.board!,
          title: j.title,
          atsVendor: 'ashby',
          postedAt: j.publishedAt ?? null,
          locations: j.location ? [parseLocation(j.location, j.isRemote)] : [],
        },
        `${text}\n${j.employmentType ?? ''}`,
      );
      // Ashby states remoteness structurally; trust that over the text heuristic.
      if (j.isRemote && !p.workArrangement) p.workArrangement = 'remote';
      return p;
    });

    return { postings, notes: [] };
  },
};

// ---------------------------------------------------------------- shared

const REMOTE_RE = /\bremote\b/i;

export function parseLocation(
  raw: string,
  remoteHint?: boolean,
): { city?: string; region?: string; country?: string; remote: boolean } {
  const remote = remoteHint ?? REMOTE_RE.test(raw);
  const parts = raw
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter((s) => s && !REMOTE_RE.test(s));

  // No country unless the string names one. These boards usually give "City, Region" and
  // nothing more, so filling the gap with "US" recorded "London, England" and "Toronto,
  // Ontario" as American — and that is what gets stored on the posting and handed back in
  // the privacy export. An unknown country stays unknown, the same as every other parser
  // in the discovery path.
  return { city: parts[0], region: parts[1], country: parts[2], remote };
}

export const ATS_SOURCES = { greenhouse, lever, ashby } as const;
export type AtsSourceName = keyof typeof ATS_SOURCES;
