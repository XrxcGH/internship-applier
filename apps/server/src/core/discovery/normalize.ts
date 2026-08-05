/**
 * Deterministic parsing of posting text into structured fields — docs/04 § Normalization.
 *
 * No LLM here. These parsers return `null` rather than guessing, and every `null` shows
 * up in the UI as a badge instead of causing a silent filter-out. The cost of a wrong
 * guess (a posting hidden from the user) is much higher than the cost of an "unknown".
 */
import type { PositionType, Season, WorkArrangement } from '@ia/shared';

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// ---------------------------------------------------------------- season & year

const SEASON_WORDS: Array<[RegExp, Season]> = [
  [/\bsummer\b/i, 'summer'],
  [/\bfall\b|\bautumn\b/i, 'fall'],
  [/\bwinter\b/i, 'winter'],
  [/\bspring\b/i, 'spring'],
  [/\byear[-\s]?round\b/i, 'year_round'],
];

export function parseSeason(text: string): Season | null {
  for (const [re, season] of SEASON_WORDS) if (re.test(text)) return season;
  return null;
}

/** A 4-digit year in a plausible hiring range, preferring one adjacent to a season word. */
export function parseYear(text: string, now: Date = new Date()): number | null {
  const min = now.getUTCFullYear() - 1;
  const max = now.getUTCFullYear() + 3;

  const nearSeason = text.match(/\b(?:summer|fall|autumn|winter|spring)\s*'?\s*(\d{2,4})\b/i);
  if (nearSeason?.[1]) {
    const y = expandYear(nearSeason[1]);
    if (y >= min && y <= max) return y;
  }

  for (const m of text.matchAll(/\b(20\d{2})\b/g)) {
    const y = Number(m[1]);
    if (y >= min && y <= max) return y;
  }
  return null;
}

function expandYear(raw: string): number {
  const n = Number(raw);
  return raw.length === 2 ? 2000 + n : n;
}

// ---------------------------------------------------------------- position type

const POSITION_PATTERNS: Array<[RegExp, PositionType]> = [
  [/\bco-?op\b/i, 'co_op'],
  [/\bapprentice(ship)?\b/i, 'apprenticeship'],
  [/\bfellow(ship)?\b/i, 'fellowship'],
  [/\bexternship\b|\bjob shadow\b|\bmicro-?internship\b/i, 'externship'],
  [/\bREU\b|\bresearch (assistant|intern|experience)\b/i, 'research'],
  [/\b(new ?grad|graduate programme?|entry[- ]level)\b/i, 'new_grad'],
  [/\b(rotational|leadership development) program\b/i, 'trainee_program'],
  [/\bintern(ship)?\b/i, 'internship'],
  [/\bseasonal\b/i, 'seasonal'],
  [/\bpart[- ]time\b/i, 'part_time'],
  [/\bvolunteer\b/i, 'volunteer'],
  [/\bcontract(or)?\b|\btemp(orary)?\b/i, 'contract'],
];

export function parsePositionType(title: string, description = ''): PositionType | null {
  // Title first: it is far more reliable than a passing mention in the body.
  for (const [re, type] of POSITION_PATTERNS) if (re.test(title)) return type;
  for (const [re, type] of POSITION_PATTERNS) if (re.test(description.slice(0, 2000))) return type;
  return null;
}

// ---------------------------------------------------------------- work arrangement

export function parseWorkArrangement(text: string): WorkArrangement | null {
  if (/\bhybrid\b/i.test(text)) return 'hybrid';
  if (/\b(fully remote|100% remote|remote[- ]first|work from home|wfh)\b/i.test(text)) {
    return /\b(only|must reside|residents of|located in|based in)\b/i.test(text)
      ? 'remote_geo_restricted'
      : 'remote';
  }
  if (/\bremote\b/i.test(text)) {
    if (/\bno remote\b|\bnot remote\b|\bremote is not\b/i.test(text)) return 'onsite';
    return 'remote';
  }
  if (/\b(on[- ]site|onsite|in[- ]person|in office|in-office)\b/i.test(text)) return 'onsite';
  if (/\b(field work|travel required|traveling)\b/i.test(text)) return 'field_or_travel';
  return null;
}

export function parseHybridDays(text: string): number | null {
  // "onsite" as one word is written at least as often as "on-site", and without the
  // optional hyphen "3 days per week onsite" came back as no answer at all while
  // "on-site" parsed — so parseWorkArrangement called the same sentence hybrid and this
  // called the day count unknown. The bare "in" already covers "in office" and "in person".
  const m = text.match(/(\d)\s*(?:days?|x)\s*(?:per|a|\/)\s*week\s*(?:in|on[- ]?site)/i);
  if (m?.[1]) {
    const n = Number(m[1]);
    return n >= 0 && n <= 7 ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------- dates & duration

/** Extracts an explicit term window, e.g. "June 2027 – August 2027". */
export function parseTermDates(text: string): { start: string; end: string } | null {
  const re =
    /\b([a-z]{3,9})\.?\s+(20\d{2})\s*(?:-|–|—|to|through|until)\s*([a-z]{3,9})\.?\s+(20\d{2})\b/i;
  const m = text.match(re);
  if (!m) return null;

  const sm = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  const em = MONTHS[m[3]!.slice(0, 3).toLowerCase()];
  if (!sm || !em) return null;

  return {
    start: `${m[2]}-${String(sm).padStart(2, '0')}`,
    end: `${m[4]}-${String(em).padStart(2, '0')}`,
  };
}

export function parseDurationWeeks(text: string): number | null {
  const weeks = text.match(/\b(\d{1,2})\s*[-–]?\s*(?:to\s*)?(\d{1,2})?\s*weeks?\b/i);
  if (weeks?.[1]) {
    const a = Number(weeks[1]);
    const b = weeks[2] ? Number(weeks[2]) : a;
    const avg = Math.round((a + b) / 2);
    if (avg >= 1 && avg <= 104) return avg;
  }
  const months = text.match(/\b(\d{1,2})\s*[-–]?\s*(?:to\s*)?(\d{1,2})?\s*months?\b/i);
  if (months?.[1]) {
    const a = Number(months[1]);
    const b = months[2] ? Number(months[2]) : a;
    const avg = Math.round(((a + b) / 2) * 4.345);
    if (avg >= 1 && avg <= 104) return avg;
  }
  return null;
}

// ---------------------------------------------------------------- compensation

export interface ParsedComp {
  min?: number;
  max?: number;
  currency?: string;
  period?: 'hour' | 'week' | 'month' | 'year' | 'total';
  unpaid?: boolean;
  academicCreditOnly?: boolean;
  raw?: string;
}

export function parseCompensation(text: string): ParsedComp | null {
  if (/\bunpaid\b/i.test(text)) return { unpaid: true, raw: 'unpaid' };
  if (/\b(academic|course|school) credit only\b/i.test(text)) {
    return { academicCreditOnly: true, raw: 'academic credit only' };
  }

  const m = text.match(
    /\$\s?([\d,]+(?:\.\d{2})?)\s*(?:-|–|—|to)?\s*\$?\s?([\d,]+(?:\.\d{2})?)?\s*(?:\/|per\s+)?\s*(hour|hr|week|wk|month|mo|year|yr|annually)?/i,
  );
  if (!m?.[1]) return null;

  const min = Number(m[1].replace(/,/g, ''));
  const max = m[2] ? Number(m[2].replace(/,/g, '')) : undefined;
  const unit = m[3]?.toLowerCase();

  const period: ParsedComp['period'] = unit?.startsWith('h')
    ? 'hour'
    : unit?.startsWith('w')
      ? 'week'
      : unit?.startsWith('mo') || unit === 'm'
        ? 'month'
        : unit
          ? 'year'
          : // No unit given: infer from magnitude. Interns are quoted hourly far more
            // often than annually, and the two ranges don't overlap in practice.
            min < 200
            ? 'hour'
            : min < 20_000
              ? 'month'
              : 'year';

  return { min, max, currency: 'USD', period, raw: m[0].trim() };
}

// ---------------------------------------------------------------- application demands

export function parseRequirements(text: string): Record<string, boolean> {
  const t = text.toLowerCase();
  return {
    coverLetter: /cover letter/.test(t) && !/no cover letter|cover letter.{0,20}optional/.test(t),
    transcript: /\btranscript/.test(t),
    portfolio: /\bportfolio\b|\bwork samples?\b/.test(t),
    references: /\breferences?\b.{0,30}\brequired\b|\bletters? of recommendation\b/.test(t),
    videoInterview: /\b(video interview|hirevue|one-way interview|recorded interview)\b/.test(t),
  };
}

// ---------------------------------------------------------------- identity helpers

const TRACKING_PARAMS = /^(utm_|gh_src|gh_jid|lever-|ref$|source$|src$|trk$)/i;

/** First dedupe key — see docs/04 § Dedupe. */
export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = '';
  u.protocol = 'https:';
  u.host = u.host.toLowerCase().replace(/^www\./, '');
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export function normalizeTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/\[.*?\]/g, ' ')
      // Requisition ids, roman numerals, and trailing season/year noise.
      .replace(/\b(req|requisition|job)?\s*#?\s*\d{4,}\b/g, ' ')
      .replace(/\b(i{1,3}|iv|v|vi{1,3}|ix|x)\b/g, ' ')
      .replace(/\b(summer|fall|autumn|winter|spring)\b/g, ' ')
      .replace(/\b20\d{2}\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  );
}

export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|gmbh|plc|sa|nv|ag)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
