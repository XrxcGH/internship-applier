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

/** The word itself plus the qualifiers boards habitually attach to it. */
const REMOTE_TOKEN = /\b(?:fully\s+|100%\s+)?remote(?:[- ](?:only|first|work|position|role))?\b/gi;

/**
 * The same pattern without `/g`, for asking rather than replacing.
 *
 * `test` on a global regex advances `lastIndex` and leaves it there, so reusing
 * REMOTE_TOKEN to ask the question would make each answer depend on which part was asked
 * about before it.
 */
const MENTIONS_REMOTE = new RegExp(REMOTE_TOKEN.source, 'i');

/**
 * Removes the remote wording from one comma-separated part and keeps whatever geography
 * was sitting next to it.
 *
 * A part that so much as mentioned remoteness used to be dropped whole, so "Remote - US"
 * lost the country entirely and "New York, NY or Remote" lost the state. Both are ordinary
 * Greenhouse and Lever location strings, and both left the posting looking like it names
 * nowhere at all.
 */
function stripRemoteToken(part: string): string {
  // Nothing to strip means nothing to tidy. This runs over EVERY comma-part, and the
  // conjunction trim below would otherwise eat a part that is exactly "OR" — Oregon's
  // state code — leaving "Portland, OR" recorded as a city in no state at all. A part that
  // never mentioned remoteness is returned untouched.
  if (!MENTIONS_REMOTE.test(part)) return part.trim();

  return (
    part
      .replace(REMOTE_TOKEN, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—/|]+|[\s\-–—/|]+$/g, '')
      // One conjunction, from one end, and never down to nothing. Trimming both ends at
      // once turned "OR or Remote" — Portland's state followed by the conjunction — into an
      // empty string, so a Portland posting recorded a city in no state at all.
      .replace(/\s+(?:or|and)$/i, '')
      .replace(/^(?:or|and)\s+/i, '')
      // "Remote (US)" leaves a lone bracketed country behind. Only a part that is bracketed
      // end to end is unwrapped, so "New York (NY)" keeps both of its brackets.
      .replace(/^[([{]([^()[\]{}]*)[)\]}]$/, '$1')
      .trim()
  );
}

/**
 * Country names as boards write them, used to tell "Berlin, Germany" from "Austin, TX".
 *
 * Two-letter ISO codes are deliberately absent. CA, IN, DE, LA, MD, MT, NE and PA are all
 * US state abbreviations as well as country codes, and the state reading is overwhelmingly
 * the more common one on these boards — treating "San Francisco, CA" as a Canadian posting
 * would be a far worse error than the one this table is here to fix. England, Scotland and
 * Wales are absent for the same reason in reverse: they are the region half of "London,
 * England", not the country.
 */
const COUNTRY_NAMES = new Set([
  'us',
  'u s',
  'usa',
  'u s a',
  'united states',
  'united states of america',
  'uk',
  'united kingdom',
  'great britain',
  'ireland',
  'canada',
  'mexico',
  'brazil',
  'argentina',
  'chile',
  'colombia',
  'costa rica',
  'germany',
  'france',
  'spain',
  'italy',
  'portugal',
  'netherlands',
  'the netherlands',
  'belgium',
  'luxembourg',
  'switzerland',
  'austria',
  'denmark',
  'sweden',
  'norway',
  'finland',
  'iceland',
  'poland',
  'czechia',
  'czech republic',
  'slovakia',
  'hungary',
  'romania',
  'bulgaria',
  'greece',
  'croatia',
  'serbia',
  'ukraine',
  'estonia',
  'latvia',
  'lithuania',
  'turkey',
  'india',
  'china',
  'japan',
  'korea',
  'south korea',
  'taiwan',
  'hong kong',
  'singapore',
  'malaysia',
  'thailand',
  'vietnam',
  'indonesia',
  'philippines',
  'pakistan',
  'bangladesh',
  'israel',
  'saudi arabia',
  'qatar',
  'uae',
  'united arab emirates',
  'egypt',
  'morocco',
  'nigeria',
  'kenya',
  'ghana',
  'south africa',
  'australia',
  'new zealand',
]);

function asCountry(part: string | undefined): string | undefined {
  if (!part) return undefined;
  return COUNTRY_NAMES.has(part.replace(/\./g, '').trim().toLowerCase()) ? part : undefined;
}

export function parseLocation(
  raw: string,
  remoteHint?: boolean,
): { city?: string; region?: string; country?: string; remote: boolean } {
  const remote = remoteHint ?? REMOTE_RE.test(raw);
  const parts = raw
    .split(/[,|]/)
    .map((s) => stripRemoteToken(s.trim()))
    .filter(Boolean);

  // "Berlin, Germany" and "London, UK" are as common on these boards as "Austin, TX", and
  // reading the second part positionally as a region filed the country under region — so a
  // posting the user opened said "Based in Berlin Germany" with no country recorded at all,
  // and the privacy export showed the same. Only the last part is tested, and only against
  // names, so a two-part string that really is "City, Region" is untouched.
  if (parts.length <= 2) {
    const country = asCountry(parts.at(-1));
    if (country) return { city: parts.length === 2 ? parts[0] : undefined, country, remote };
  }

  // No country unless the string names one. These boards usually give "City, Region" and
  // nothing more, so filling the gap with "US" recorded "London, England" and "Toronto,
  // Ontario" as American — and that is what gets stored on the posting and handed back in
  // the privacy export. An unknown country stays unknown, the same as every other parser
  // in the discovery path.
  //
  // The trailing part goes through asCountry too, exactly like the two-part branch above: a
  // three-part free-text string is as often "City, Region, <arrangement/metro>" as it is
  // "City, Region, Country" — "New York, NY, Hybrid", "Austin, TX, Onsite", "San Francisco,
  // CA, Bay Area" — and taking parts[2] verbatim filed "Hybrid" as the country and exported
  // it as a fact. When the last part is not a country name it is dropped, not guessed at.
  return { city: parts[0], region: parts[1], country: asCountry(parts[2]), remote };
}

export const ATS_SOURCES = { greenhouse, lever, ashby } as const;
export type AtsSourceName = keyof typeof ATS_SOURCES;
