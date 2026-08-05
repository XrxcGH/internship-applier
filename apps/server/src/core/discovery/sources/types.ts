import type { SourceKind } from '@ia/shared';

/** A posting as it comes off a source, before eligibility or scoring. */
export interface NormalizedPosting {
  externalId: string | null;
  canonicalUrl: string;
  applyUrl: string;
  company: string;
  companyDomain: string | null;
  title: string;
  descriptionText: string;
  descriptionHtml: string | null;
  locations: Array<{ city?: string; region?: string; country?: string; remote: boolean }>;
  positionType: string | null;
  workArrangement: string | null;
  hybridDaysOnsite: number | null;
  remoteEligibleIn: string[];
  programFlags: string[];
  term: {
    season: string | null;
    year: number | null;
    start?: string;
    end?: string;
    durationWeeks: number | null;
    multiTerm: boolean;
  };
  compensation: Record<string, unknown> | null;
  requires: Record<string, boolean>;
  postedAt: string | null;
  closesAt: string | null;
  atsVendor: string;
}

export interface SourceQuery {
  /** Board slug / company token for ATS sources. */
  board?: string;
  keywords?: string[];
  location?: string;
  limit?: number;
}

export interface SourceResult {
  postings: NormalizedPosting[];
  /** Anything skipped or truncated is reported, never silently dropped (docs/04). */
  notes: string[];
}

export interface JobSource {
  kind: SourceKind;
  /** Whether this source needs an API key the user hasn't supplied. */
  requiresKey: boolean;
  isConfigured(): boolean;
  fetch(query: SourceQuery): Promise<SourceResult>;
}

/**
 * A numeric entity, decoded as a code point rather than a UTF-16 unit.
 *
 * String.fromCharCode takes the number modulo 65536, so `&#128077;` (a thumbs-up, the
 * kind of thing a job description puts in a perks list) came out as an unrelated CJK
 * character. Anything outside the Unicode range is left as written rather than throwing —
 * a stray `&#99999999;` in one posting must not take down the whole source.
 */
function decodeNumericEntity(match: string, digits: string): string {
  const cp = Number(digits);
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
}

/**
 * Turns HTML entities back into the characters they stand for.
 *
 * Separate from stripHtml because order matters and the two are needed at different
 * points. Greenhouse returns its job content ESCAPED — `&lt;p&gt;About the role&lt;/p&gt;`
 * — so stripping tags first finds none to strip, and the decode afterwards puts the
 * markup back as literal text. Every requirement parser and the model then read `<p>` and
 * `<li>` as part of the job description, and the UI rendered them on screen.
 */
export function decodeEntities(html: string): string {
  return (
    html
      .replace(/&nbsp;/gi, ' ')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#(\d+);/g, decodeNumericEntity)
      // Ampersand last, so "&amp;lt;" does not become a tag.
      .replace(/&amp;/gi, '&')
  );
}

export function stripHtml(html: string): string {
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#(\d+);/g, decodeNumericEntity)
      // Ampersand last here too. Decoding it first turned a description that talked about
      // the "&amp;lt;code&amp;gt; tag" into one that talked about the "<code> tag".
      .replace(/&amp;/gi, '&')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
