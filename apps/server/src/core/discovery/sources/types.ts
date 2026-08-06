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
  /**
   * The notes that describe coverage we did not get — a page of results we stopped at,
   * rows that could not be read — as opposed to a plain status line. The runner marks the
   * source degraded for these and repeats them in the run summary's `skipped` list, which
   * is where the UI gets "the search was incomplete" from. A note in `notes` alone does
   * neither, so a source that quietly returned its first fifty of eight hundred matches
   * read as complete coverage.
   */
  gaps?: string[];
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
 * The named entities that actually turn up in job descriptions.
 *
 * `&amp;` is deliberately absent: it is decoded last, on its own, so that "&amp;lt;" ends
 * up as the literal text "&lt;" rather than as a tag. Anything not listed is left exactly
 * as written, because a stray "&foo;" printed as-is is easier to read past than a wrong
 * guess at what it meant.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  prime: '′',
  minus: '−',
  aacute: 'á',
  agrave: 'à',
  acirc: 'â',
  auml: 'ä',
  aring: 'å',
  atilde: 'ã',
  aelig: 'æ',
  ccedil: 'ç',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  euml: 'ë',
  iacute: 'í',
  igrave: 'ì',
  icirc: 'î',
  iuml: 'ï',
  ntilde: 'ñ',
  oacute: 'ó',
  ograve: 'ò',
  ocirc: 'ô',
  ouml: 'ö',
  otilde: 'õ',
  oslash: 'ø',
  uacute: 'ú',
  ugrave: 'ù',
  ucirc: 'û',
  uuml: 'ü',
  yacute: 'ý',
  szlig: 'ß',
};

function decodeNamedEntity(match: string, name: string): string {
  const exact = NAMED_ENTITIES[name];
  if (exact !== undefined) return exact;
  const lower = NAMED_ENTITIES[name.toLowerCase()];
  if (lower === undefined) return match;
  // The table is written in lower case, and "&Eacute;" is simply the capital of "&eacute;".
  return /^[A-Z]/.test(name) ? lower.toUpperCase() : lower;
}

/**
 * One decoding pass, shared by both entry points below so the two cannot drift apart.
 *
 * Only decimal `&#39;` used to be handled, and boards write the hexadecimal `&#x27;` just
 * as often. A posting that asked for a "bachelor&#x27;s program" reached the requirement
 * parsers with the raw entity still in it — the degree pattern needs a space where the
 * "&" sits, so the education requirement was never extracted — and the same literal junk
 * was shown to the user in the description pane. `&mdash;` and the accented names were in
 * the same position: written out in full on screen.
 *
 * The ampersand is always last. Decoding it first turned a description that talked about
 * the "&amp;lt;code&amp;gt; tag" into one that talked about the "<code> tag".
 */
function decodeAll(text: string): string {
  return text
    .replace(/&([a-z][a-z0-9]{1,9});/gi, decodeNamedEntity)
    .replace(/&#(\d+);/g, decodeNumericEntity)
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) =>
      decodeNumericEntity(m, String(parseInt(hex, 16))),
    )
    .replace(/&amp;/gi, '&');
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
  return decodeAll(html);
}

export function stripHtml(html: string): string {
  return decodeAll(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
