/**
 * The manual paste-a-URL path — docs/04 § Tier C.
 *
 * This is how a posting from LinkedIn, Indeed, or anywhere else this tool deliberately
 * does not crawl gets into the system: the user brings it. One user-directed fetch of a
 * page they are already looking at, not a crawler.
 *
 * Most career pages embed schema.org JobPosting JSON-LD, which gives us structured
 * fields for free. When it's absent we fall back to the page text and let the same
 * deterministic parsers do their work.
 */
import { politeFetch } from '../../infra/http/fetcher';
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
} from './normalize';
import { decodeEntities, stripHtml, type NormalizedPosting } from './sources/types';

interface JsonLdJobPosting {
  '@type'?: string | string[];
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  employmentType?: string | string[];
  hiringOrganization?: { name?: string; sameAs?: string };
  jobLocation?: unknown;
  jobLocationType?: string;
  applicantLocationRequirements?: unknown;
  baseSalary?: {
    currency?: string;
    value?: { minValue?: number; maxValue?: number; unitText?: string };
  };
}

function collectJsonLd(html: string): JsonLdJobPosting[] {
  const out: JsonLdJobPosting[] = [];
  for (const m of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed: unknown = JSON.parse(m[1]!.trim());
      const queue = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of queue) {
        const n = node as JsonLdJobPosting & { '@graph'?: unknown[] };
        if (Array.isArray(n['@graph'])) queue.push(...(n['@graph'] as never[]));
        const type = n['@type'];
        const types = Array.isArray(type) ? type : [type];
        if (types.includes('JobPosting')) out.push(n);
      }
    } catch {
      // A malformed block is skipped; another may still parse.
    }
  }
  return out;
}

function flattenLocations(
  loc: unknown,
): Array<{ city?: string; region?: string; country?: string; remote: boolean }> {
  const nodes = Array.isArray(loc) ? loc : [loc];
  const out: Array<{ city?: string; region?: string; country?: string; remote: boolean }> = [];
  for (const n of nodes) {
    const addr = (n as { address?: Record<string, unknown> })?.address;
    if (!addr) continue;
    out.push({
      city: typeof addr['addressLocality'] === 'string' ? addr['addressLocality'] : undefined,
      region: typeof addr['addressRegion'] === 'string' ? addr['addressRegion'] : undefined,
      country: readCountry(addr['addressCountry']),
      remote: false,
    });
  }
  return out;
}

/**
 * schema.org allows addressCountry to be a plain string or a Country object, and plenty
 * of career pages use the object. Reading only the string form and defaulting everything
 * else to "US" stored a Toronto posting with the right city, the right region, and the
 * country "US" — which is then what the database keeps and the privacy export shows.
 * This is the path the user points at any URL on earth, so an absent country stays absent.
 */
function readCountry(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value : (value as { name?: unknown } | null)?.name;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * The places a remote posting says you may live, from schema.org
 * `applicantLocationRequirements` — a Country or State node, or a list of them.
 *
 * The field was read off the page and then thrown away: `remoteEligibleIn` was written as
 * an empty list on every manual posting, so a page that said in structured data "remote,
 * but you must be resident in the United States" was stored as knowing nothing about where
 * it would take people, and that is what the privacy export showed back.
 */
function readApplicantLocations(value: unknown): string[] {
  const nodes = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const node of nodes) {
    const name = typeof node === 'string' ? node : (node as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name.trim()) out.push(name.trim());
  }
  return out;
}

export interface ManualResult {
  posting: NormalizedPosting;
  usedJsonLd: boolean;
  notes: string[];
}

export async function fetchManualPosting(url: string): Promise<ManualResult> {
  const notes: string[] = [];
  // A user-directed fetch of a single page. robots.txt still applies.
  const html = await politeFetch(url, { rps: 1, timeoutMs: 20_000 });

  const ld = collectJsonLd(html)[0];
  const pageText = stripHtml(html);

  const title = ld?.title ?? guessTitle(html) ?? 'Untitled posting';
  const company = ld?.hiringOrganization?.name ?? guessCompany(url);
  const description = ld?.description ? stripHtml(ld.description) : pageText;

  if (!ld) {
    notes.push(
      'No structured JobPosting data on the page, so the title, company, and dates were ' +
        'read from the page text and may need correcting.',
    );
  }
  if (description.length < 200) {
    notes.push('Very little text was readable at that URL — the page may require JavaScript.');
  }

  const hay = `${title}\n${description}`;
  const dates = parseTermDates(hay);
  const duration = parseDurationWeeks(hay);

  /**
   * Remoteness, from the structured signal first and the text through the shared parser.
   *
   * This used to be a bare /\bremote\b/ over the title and the first 500 characters,
   * which fired on "no remote work" and "this role is not remote" as readily as on the
   * real thing — and then threw away the structured jobLocation and the parsed
   * arrangement to replace both with "remote". The manual path is the one the user
   * invoked deliberately; it has no business being less careful than the automated one.
   */
  const arrangement = parseWorkArrangement(hay);
  const remote = ld?.jobLocationType === 'TELECOMMUTE' || arrangement === 'remote';
  // A posting can be remote AND name a city ("New York or Remote"). Keeping the stated
  // locations is what lets the eligibility rule tell those two cases apart.
  const stated = flattenLocations(ld?.jobLocation);
  const locations = remote
    ? stated.length > 0
      ? stated.map((l) => ({ ...l, remote: true }))
      : [{ remote: true }]
    : stated;

  const salary = ld?.baseSalary?.value;

  const posting: NormalizedPosting = {
    externalId: null,
    canonicalUrl: canonicalUrl(url),
    applyUrl: url,
    company,
    companyDomain: safeHost(ld?.hiringOrganization?.sameAs ?? url),
    title,
    descriptionText: description,
    descriptionHtml: ld?.description ?? null,
    locations,
    positionType: parsePositionType(title, description),
    workArrangement: remote ? 'remote' : arrangement,
    hybridDaysOnsite: parseHybridDays(hay),
    remoteEligibleIn: readApplicantLocations(ld?.applicantLocationRequirements),
    programFlags: [],
    term: {
      season: parseSeason(hay),
      year: parseYear(hay),
      ...(dates ?? {}),
      durationWeeks: duration,
      multiTerm: duration !== null && duration > 20,
    },
    compensation: salary?.minValue
      ? {
          min: salary.minValue,
          max: salary.maxValue,
          currency: ld?.baseSalary?.currency ?? 'USD',
          period: mapUnit(salary.unitText),
        }
      : (parseCompensation(hay) as Record<string, unknown> | null),
    requires: parseRequirements(description),
    postedAt: ld?.datePosted ?? null,
    closesAt: ld?.validThrough ?? null,
    atsVendor: detectVendor(url, html),
  };

  return { posting, usedJsonLd: Boolean(ld), notes };
}

function mapUnit(unit?: string): 'hour' | 'week' | 'month' | 'year' {
  switch ((unit ?? '').toUpperCase()) {
    case 'HOUR':
      return 'hour';
    case 'WEEK':
      return 'week';
    case 'MONTH':
      return 'month';
    default:
      return 'year';
  }
}

function guessTitle(html: string): string | null {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og?.[1]) return decodeEntities(og[1]);
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return t?.[1] ? decodeEntities(t[1].trim()) : null;
}

function guessCompany(url: string): string {
  const host = safeHost(url) ?? 'unknown';
  return host.replace(/^(www|jobs|careers|boards|apply)\./, '').split('.')[0] ?? 'unknown';
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
}

export function detectVendor(url: string, html = ''): string {
  const h = `${url} ${html.slice(0, 4000)}`.toLowerCase();
  if (h.includes('greenhouse.io')) return 'greenhouse';
  if (h.includes('lever.co')) return 'lever';
  if (h.includes('ashbyhq.com')) return 'ashby';
  if (h.includes('myworkdayjobs.com') || h.includes('workday')) return 'workday';
  if (h.includes('smartrecruiters.com')) return 'smartrecruiters';
  if (h.includes('icims.com')) return 'icims';
  if (h.includes('taleo.net')) return 'taleo';
  if (h.includes('workable.com')) return 'workable';
  return 'unknown';
}
