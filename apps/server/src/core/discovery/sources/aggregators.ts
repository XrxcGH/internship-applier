/**
 * Keyed aggregator sources and the community internship list — docs/04 § Tier A.
 *
 * Adzuna and USAJOBS both need a free API key. When one isn't configured the adapter
 * reports itself unconfigured and the run summary says so explicitly, rather than
 * quietly contributing nothing — an invisible gap in coverage reads as "we searched
 * everywhere" when we didn't.
 */
import { DEFAULT_FILTERS } from '@ia/shared';
import { fetchJson, politeFetch } from '../../../infra/http/fetcher';
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
import { parseLocation } from './ats';
import type { JobSource, NormalizedPosting, SourceQuery, SourceResult } from './types';

function build(
  partial: Pick<
    NormalizedPosting,
    'externalId' | 'canonicalUrl' | 'applyUrl' | 'company' | 'title'
  > &
    Partial<NormalizedPosting>,
  text: string,
): NormalizedPosting {
  const hay = `${partial.title}\n${text}`;
  const dates = parseTermDates(hay);
  const duration = parseDurationWeeks(hay);
  return {
    companyDomain: null,
    descriptionText: text,
    descriptionHtml: null,
    locations: [],
    positionType: parsePositionType(partial.title, text),
    workArrangement: parseWorkArrangement(hay),
    hybridDaysOnsite: parseHybridDays(hay),
    remoteEligibleIn: [],
    programFlags: [],
    term: {
      season: parseSeason(hay),
      year: parseYear(hay),
      ...(dates ?? {}),
      durationWeeks: duration,
      multiTerm: duration !== null && duration > 20,
    },
    compensation: parseCompensation(hay) as Record<string, unknown> | null,
    requires: parseRequirements(text),
    postedAt: null,
    closesAt: null,
    atsVendor: 'unknown',
    ...partial,
  };
}

// ---------------------------------------------------------------- Adzuna

interface AdzunaJob {
  id: string;
  title: string;
  description: string;
  redirect_url: string;
  created?: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  salary_min?: number;
  salary_max?: number;
}

/**
 * Adzuna splits its API by country and this adapter only ever asks the US partition — the
 * `us` segment in the search URL below. The country stamped on each result is derived from
 * that same constant so the two cannot drift apart: point this at another partition and
 * the locations follow, instead of quietly labelling Berlin and Manchester postings as
 * American the way a separately written `country: 'US'` would.
 */
const ADZUNA_COUNTRY = 'us';

export const adzuna: JobSource = {
  kind: 'adzuna',
  requiresKey: true,
  isConfigured: () => Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),
  async fetch(q: SourceQuery): Promise<SourceResult> {
    if (!adzuna.isConfigured()) {
      return {
        postings: [],
        notes: [
          'adzuna: skipped — no API key. Get a free one at developer.adzuna.com and add ' +
            'ADZUNA_APP_ID / ADZUNA_APP_KEY in Settings.',
        ],
      };
    }

    const what = encodeURIComponent(q.keywords?.join(' ') ?? 'internship');
    const where = encodeURIComponent(q.location ?? '');
    const url =
      `https://api.adzuna.com/v1/api/jobs/${ADZUNA_COUNTRY}/search/1` +
      `?app_id=${process.env.ADZUNA_APP_ID}&app_key=${process.env.ADZUNA_APP_KEY}` +
      `&results_per_page=${Math.min(q.limit ?? 50, 50)}&what=${what}${where ? `&where=${where}` : ''}` +
      `&content-type=application/json`;

    const data = await fetchJson<{ results?: AdzunaJob[] }>(url, { rps: 1 });

    const postings = (data.results ?? []).map((j) =>
      build(
        {
          externalId: j.id,
          canonicalUrl: canonicalUrl(j.redirect_url),
          applyUrl: j.redirect_url,
          company: j.company?.display_name ?? 'Unknown',
          title: j.title,
          postedAt: j.created ?? null,
          locations: j.location?.display_name
            ? [
                {
                  city: j.location.area?.at(-1),
                  region: j.location.area?.at(-2),
                  country: ADZUNA_COUNTRY.toUpperCase(),
                  remote: /remote/i.test(j.location.display_name),
                },
              ]
            : [],
          compensation: j.salary_min
            ? { min: j.salary_min, max: j.salary_max, currency: 'USD', period: 'year' }
            : null,
        },
        j.description ?? '',
      ),
    );

    return { postings, notes: [] };
  },
};

// ---------------------------------------------------------------- USAJOBS

interface UsaJob {
  MatchedObjectId: string;
  MatchedObjectDescriptor: {
    PositionTitle: string;
    PositionURI: string;
    ApplyURI?: string[];
    OrganizationName?: string;
    PositionLocation?: Array<{ CityName?: string; CountrySubDivisionCode?: string }>;
    PublicationStartDate?: string;
    ApplicationCloseDate?: string;
    UserArea?: { Details?: { JobSummary?: string; MajorDuties?: string[] } };
  };
}

export const usajobs: JobSource = {
  kind: 'usajobs',
  requiresKey: true,
  isConfigured: () => Boolean(process.env.USAJOBS_API_KEY && process.env.USAJOBS_USER_AGENT),
  async fetch(q: SourceQuery): Promise<SourceResult> {
    if (!usajobs.isConfigured()) {
      return {
        postings: [],
        notes: [
          'usajobs: skipped — no API key. Register free at developer.usajobs.gov and add ' +
            'USAJOBS_API_KEY / USAJOBS_USER_AGENT in Settings. This is the source for ' +
            'federal internships and Pathways.',
        ],
      };
    }

    const keyword = encodeURIComponent(q.keywords?.join(' ') ?? 'intern');
    const url =
      `https://data.usajobs.gov/api/search?Keyword=${keyword}` +
      `&ResultsPerPage=${Math.min(q.limit ?? 50, 100)}&HiringPath=student`;

    // HiringPath, not WhoMayApply. WhoMayApply takes All/Public/Status; "student" is
    // not one of them, so the filter was ignored and this source returned general
    // federal vacancies rather than the Pathways postings it promises. Untested against
    // the live API — it needs a key this machine does not have.

    const raw = await politeFetch(url, {
      isDocumentedApi: true,
      rps: 1,
      headers: {
        'Authorization-Key': process.env.USAJOBS_API_KEY!,
        'User-Agent': process.env.USAJOBS_USER_AGENT!,
        Host: 'data.usajobs.gov',
      },
    });
    const data = JSON.parse(raw) as { SearchResult?: { SearchResultItems?: UsaJob[] } };

    const postings = (data.SearchResult?.SearchResultItems ?? []).map((item) => {
      const d = item.MatchedObjectDescriptor;
      const text = [d.UserArea?.Details?.JobSummary, ...(d.UserArea?.Details?.MajorDuties ?? [])]
        .filter(Boolean)
        .join('\n');
      return build(
        {
          externalId: item.MatchedObjectId,
          canonicalUrl: canonicalUrl(d.PositionURI),
          applyUrl: d.ApplyURI?.[0] ?? d.PositionURI,
          company: d.OrganizationName ?? 'US Federal Government',
          title: d.PositionTitle,
          postedAt: d.PublicationStartDate ?? null,
          closesAt: d.ApplicationCloseDate ?? null,
          // 'US' is asserted here on purpose, unlike the other adapters. This is the US
          // federal government's own hiring system, and the only geographic field read
          // back is a country subdivision code — a state. The country is what the source
          // says, not a default standing in for a value it never gave us.
          locations: (d.PositionLocation ?? []).map((l) => ({
            city: l.CityName,
            region: l.CountrySubDivisionCode,
            country: 'US',
            remote: false,
          })),
        },
        text,
      );
    });

    return { postings, notes: [] };
  },
};

// ---------------------------------------------------------------- community list

/**
 * Which cycle the default list covers, read from the default term filter so that one
 * place decides what "the upcoming season" is. The repo name used to be written out as
 * Summer 2026, so a run with no repo override fetched an archived list of a season that
 * had already closed while every filter in the app was set to Summer 2027.
 */
const DEFAULT_LIST_YEAR = DEFAULT_FILTERS.term.years[0] ?? new Date().getUTCFullYear() + 1;
const DEFAULT_LIST_REPO = `SimplifyJobs/Summer${DEFAULT_LIST_YEAR}-Internships`;

/**
 * SimplifyJobs maintains a well-structured, publicly published list of summer internship
 * postings specifically so tools can consume it. Read-only fetch of a raw JSON file.
 */
export const githubList: JobSource = {
  kind: 'github_list',
  requiresKey: false,
  isConfigured: () => true,
  async fetch(q: SourceQuery): Promise<SourceResult> {
    // `??` only catches null and undefined. The run route declares board as a string
    // with a default of '', so an omitted board arrives as an empty string and was
    // used verbatim — producing a raw.githubusercontent.com URL with nothing where the
    // repo goes. The sibling adapters all use a truthiness check for this reason.
    const repo = q.board || DEFAULT_LIST_REPO;
    const url = `https://raw.githubusercontent.com/${repo}/dev/.github/scripts/listings.json`;

    let data: Array<Record<string, unknown>>;
    try {
      data = await fetchJson<Array<Record<string, unknown>>>(url, { rps: 1 });
    } catch (err) {
      return {
        postings: [],
        notes: [`github_list: could not read ${repo} (${(err as Error).message})`],
      };
    }

    const postings: NormalizedPosting[] = [];
    let unreadable = 0;
    for (const row of data) {
      const active = row['active'];
      const link = String(row['url'] ?? '');
      if (active === false || !link.startsWith('http')) continue;

      const title = String(row['title'] ?? '');
      const company = String(row['company_name'] ?? '');
      const locations = Array.isArray(row['locations']) ? (row['locations'] as string[]) : [];
      const terms = Array.isArray(row['terms']) ? (row['terms'] as string[]) : [];

      try {
        postings.push(
          build(
            {
              externalId: String(row['id'] ?? ''),
              canonicalUrl: canonicalUrl(link),
              applyUrl: link,
              company,
              title,
              postedAt: row['date_posted']
                ? new Date(Number(row['date_posted']) * 1000).toISOString()
                : null,
              // The same parser the ATS adapters use, rather than a second splitter that
              // filled the country in as "US" for every row. This list is not US-only —
              // it carries Toronto, London and Zurich postings among the rest — and being
              // the highest-volume source it put more wrongly-Americanised locations into
              // the database than everything else combined, all of them visible to the
              // user in the privacy export. A location that does not name its country now
              // leaves the field empty instead of asserting the wrong one.
              locations: locations.map((l) => parseLocation(l)),
            },
            `${title} at ${company}. ${terms.join(', ')}. ${locations.join('; ')}`,
          ),
        );
      } catch {
        // A malformed row is skipped rather than failing the whole source, but it is
        // counted. If the list changes date_posted from epoch seconds to an ISO string,
        // every dated row throws here — and reporting only the survivors made a run that
        // lost hundreds of listings read as complete coverage of a very short list.
        unreadable++;
      }
    }

    const notes = [`github_list: ${postings.length} active listings from ${repo}`];
    if (unreadable > 0) {
      notes.push(
        `github_list: skipped ${unreadable} ${unreadable === 1 ? 'row' : 'rows'} in ${repo} ` +
          'that could not be read. The list format may have changed.',
      );
    }

    return { postings, notes };
  },
};

export const AGGREGATOR_SOURCES = { adzuna, usajobs, github_list: githubList } as const;
