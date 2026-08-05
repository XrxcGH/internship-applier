/**
 * Hard eligibility rules — docs/05 § Stage 1.
 *
 * THE most consequential module in this system. A false `ineligible` silently costs the
 * user an opportunity they'll never know existed, so every rule here is:
 *
 *   - pure, with the clock injected, so it is exhaustively testable;
 *   - tri-state — `unknown` is a first-class outcome, never rounded to `fail`;
 *   - obliged to cite evidence for every `fail` (a test enforces this).
 *
 * No model decides any of this. The LLM's only job upstream was to extract requirements
 * and quote them; the judgement is plain TypeScript over structured fields.
 */
import type { ConfirmedProfile, JobRequirement, RuleResult } from '@ia/shared';
import { validateValue } from './requirementValues';

export interface PostingFacts {
  id: string;
  company: string;
  title: string;
  isOpen: boolean;
  closesAt: string | null;
  locations: Array<{ city?: string; region?: string; country?: string; remote: boolean }>;
  workArrangement: string | null;
  term: { season: string | null; year: number | null; start?: string; end?: string };
}

export interface RuleInput {
  profile: ConfirmedProfile;
  posting: PostingFacts;
  requirements: JobRequirement[];
  now: Date;
}

export type EligibilityStatus = 'eligible' | 'ineligible' | 'unknown';

export interface EligibilityOutcome {
  eligibility: EligibilityStatus;
  rules: RuleResult[];
  blockers: RuleResult[];
}

// ---------------------------------------------------------------- helpers

const pass = (rule: string, because: string, extra: Partial<RuleResult> = {}): RuleResult => ({
  rule,
  status: 'pass',
  because,
  ...extra,
});

const fail = (
  rule: string,
  because: string,
  extra: Partial<RuleResult> & ({ requirementId: string } | { evidence: string }),
): RuleResult => ({ rule, status: 'fail', because, ...extra });

const unknown = (rule: string, because: string, extra: Partial<RuleResult> = {}): RuleResult => ({
  rule,
  status: 'unknown',
  because,
  ...extra,
});

const na = (rule: string, because: string): RuleResult => ({
  rule,
  status: 'not_applicable',
  because,
});

function firstOfKind(reqs: JobRequirement[], kind: string): JobRequirement | undefined {
  // Prefer a `required` requirement over a `preferred` one, then higher confidence.
  return reqs
    .filter((r) => r.kind === kind)
    .sort(
      (a, b) =>
        Number(b.necessity === 'required') - Number(a.necessity === 'required') ||
        b.confidence - a.confidence,
    )[0];
}

function typedValue<T>(req: JobRequirement): T | null {
  const v = validateValue(req.kind, req.value);
  return v.ok ? (v.value as T) : null;
}

function toYearMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- the rules

export function ageMinimum({ profile, requirements }: RuleInput): RuleResult {
  const req = firstOfKind(requirements, 'age');
  if (!req) return na('age_minimum', 'The posting does not state a minimum age.');

  const value = typedValue<{ min: number }>(req);
  if (!value) {
    return unknown('age_minimum', 'A minimum age is mentioned but could not be parsed.', {
      requirementId: req.id,
    });
  }

  const age = profile.derived.age;
  if (age === null) {
    return unknown(
      'age_minimum',
      `This posting requires you to be at least ${value.min}. Add your date of birth to check.`,
      { requirementId: req.id, profileRef: 'dateOfBirth' },
    );
  }

  return age >= value.min
    ? pass('age_minimum', `You are ${age}; the posting requires ${value.min}+.`, {
        requirementId: req.id,
        profileRef: 'derived.age',
      })
    : fail('age_minimum', `You are ${age}; this posting requires ${value.min}+.`, {
        requirementId: req.id,
        profileRef: 'derived.age',
      });
}

const LEVEL_ORDER = ['high_school', 'associate', 'bachelor', 'master', 'doctorate'];
const ACADEMIC_TO_LEVEL: Record<string, string> = {
  high_school: 'high_school',
  undergrad: 'bachelor',
  masters: 'master',
  phd: 'doctorate',
  bootcamp: 'other',
  none: 'none',
};

export function educationLevel({ profile, requirements }: RuleInput): RuleResult {
  const req = firstOfKind(requirements, 'education_level');
  if (!req) return na('education_level', 'The posting does not state an education level.');

  const value = typedValue<{ levels: string[] }>(req);
  if (!value) {
    return unknown('education_level', 'An education requirement could not be parsed.', {
      requirementId: req.id,
    });
  }
  if (value.levels.includes('any')) {
    return pass('education_level', 'Open to any education level.', { requirementId: req.id });
  }

  const mine = ACADEMIC_TO_LEVEL[profile.derived.academicLevel] ?? 'none';
  if (mine === 'none') {
    return unknown('education_level', 'No education history on file to check against.', {
      requirementId: req.id,
      profileRef: 'education',
    });
  }

  // "Enrolled in a Bachelor's" is satisfied by anyone at or above that level.
  const mineRank = LEVEL_ORDER.indexOf(mine);
  const ok = value.levels.some((l) => {
    const rank = LEVEL_ORDER.indexOf(l);
    return rank === -1 ? false : mineRank >= rank;
  });

  return ok
    ? pass('education_level', `Your level (${mine}) meets the requirement.`, {
        requirementId: req.id,
        profileRef: 'derived.academicLevel',
      })
    : fail(
        'education_level',
        `This posting wants ${value.levels.join(' or ')}; your level is ${mine}.`,
        { requirementId: req.id, profileRef: 'derived.academicLevel' },
      );
}

export function graduationWindow({ profile, requirements }: RuleInput): RuleResult {
  const req = firstOfKind(requirements, 'graduation_window');
  if (!req) return na('graduation_window', 'The posting does not state a graduation window.');

  const value = typedValue<{ from?: string; to?: string }>(req);
  if (!value || (!value.from && !value.to)) {
    return unknown('graduation_window', 'A graduation window is mentioned but unparseable.', {
      requirementId: req.id,
    });
  }

  const grad = profile.derived.expectedGraduation;
  if (!grad) {
    return unknown(
      'graduation_window',
      'This posting restricts graduation dates, but yours is not on file.',
      { requirementId: req.id, profileRef: 'derived.expectedGraduation' },
    );
  }

  const tooEarly = value.from !== undefined && grad < value.from;
  const tooLate = value.to !== undefined && grad > value.to;
  const window = `${value.from ?? 'any'} to ${value.to ?? 'any'}`;

  return tooEarly || tooLate
    ? fail(
        'graduation_window',
        `You graduate ${grad}; this posting wants graduation between ${window}.`,
        { requirementId: req.id, profileRef: 'derived.expectedGraduation' },
      )
    : pass('graduation_window', `You graduate ${grad}, inside the ${window} window.`, {
        requirementId: req.id,
        profileRef: 'derived.expectedGraduation',
      });
}

export function enrollment({ profile, requirements, now }: RuleInput): RuleResult {
  const req = firstOfKind(requirements, 'enrollment');
  if (!req) return na('enrollment', 'The posting does not require active enrolment.');

  const value = typedValue<{ required: boolean }>(req);
  if (!value) {
    return unknown('enrollment', 'An enrolment requirement could not be parsed.', {
      requirementId: req.id,
    });
  }
  if (!value.required)
    return pass('enrollment', 'Enrolment is not required.', { requirementId: req.id });

  const grad = profile.derived.expectedGraduation;
  if (!grad) {
    return unknown('enrollment', 'Active enrolment is required; your graduation date is unknown.', {
      requirementId: req.id,
      profileRef: 'derived.expectedGraduation',
    });
  }

  return grad >= toYearMonth(now)
    ? pass('enrollment', `You are still enrolled (graduating ${grad}).`, {
        requirementId: req.id,
        profileRef: 'derived.expectedGraduation',
      })
    : fail('enrollment', `This posting requires active enrolment; you graduated ${grad}.`, {
        requirementId: req.id,
        profileRef: 'derived.expectedGraduation',
      });
}

export function workAuthorization({ profile, requirements }: RuleInput): RuleResult {
  const req = firstOfKind(requirements, 'work_auth');
  if (!req) return na('work_authorization', 'The posting does not mention work authorization.');

  const value = typedValue<{
    sponsorshipUnavailable?: boolean;
    requiresExistingAuthorization?: boolean;
  }>(req);
  if (!value) {
    return unknown('work_authorization', 'A work-authorization clause could not be parsed.', {
      requirementId: req.id,
    });
  }

  const auth = profile.workAuthorization;
  if (auth.status === 'unknown') {
    return unknown('work_authorization', 'Your work-authorization status is not on file.', {
      requirementId: req.id,
      profileRef: 'workAuthorization.status',
    });
  }

  if (!auth.needsSponsorship) {
    return pass('work_authorization', 'You do not need sponsorship.', {
      requirementId: req.id,
      profileRef: 'workAuthorization.needsSponsorship',
    });
  }

  return value.sponsorshipUnavailable
    ? fail(
        'work_authorization',
        'You need sponsorship and this posting states it is not available.',
        { requirementId: req.id, profileRef: 'workAuthorization.needsSponsorship' },
      )
    : pass('work_authorization', 'You need sponsorship; the posting does not rule it out.', {
        requirementId: req.id,
        profileRef: 'workAuthorization.needsSponsorship',
      });
}

export function citizenship({ profile, requirements }: RuleInput): RuleResult {
  const req = firstOfKind(requirements, 'citizenship');
  if (!req) return na('citizenship', 'The posting does not state a citizenship requirement.');

  const value = typedValue<{ countries?: string[]; clearanceRequired?: boolean }>(req);
  if (!value) {
    return unknown('citizenship', 'A citizenship clause could not be parsed.', {
      requirementId: req.id,
    });
  }

  if (value.countries?.length) {
    if (profile.citizenships.length === 0) {
      return unknown(
        'citizenship',
        `This posting requires ${value.countries.join(' or ')} citizenship; yours is not on file.`,
        { requirementId: req.id, profileRef: 'citizenships' },
      );
    }
    const ok = value.countries.some((c) =>
      profile.citizenships.some((mine) => mine.toUpperCase() === c.toUpperCase()),
    );
    if (!ok) {
      return fail(
        'citizenship',
        `Requires ${value.countries.join(' or ')} citizenship; you hold ${profile.citizenships.join(', ')}.`,
        { requirementId: req.id, profileRef: 'citizenships' },
      );
    }
  }

  if (value.clearanceRequired) {
    return unknown(
      'citizenship',
      'This posting requires a security clearance. The tool cannot verify that — check yourself.',
      { requirementId: req.id },
    );
  }

  return pass('citizenship', 'Citizenship requirement met.', { requirementId: req.id });
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance. Only used when both points have coordinates. */
export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function location({ profile, posting }: RuleInput): RuleResult {
  const arrangement = posting.workArrangement;
  const prefs = profile.locationPrefs;

  if (arrangement === 'remote' || posting.locations.some((l) => l.remote)) {
    return prefs.remoteOk
      ? pass('location', 'Remote, which you accept.', { profileRef: 'locationPrefs.remoteOk' })
      : fail('location', 'This posting is remote and you have remote turned off.', {
          evidence: `workArrangement=${arrangement ?? 'remote'}`,
          profileRef: 'locationPrefs.remoteOk',
        });
  }

  if (arrangement === 'hybrid' && !prefs.hybridOk) {
    return fail('location', 'This posting is hybrid and you have hybrid turned off.', {
      evidence: 'workArrangement=hybrid',
      profileRef: 'locationPrefs.hybridOk',
    });
  }

  if (posting.locations.length === 0) {
    return unknown('location', 'The posting does not say where the role is based.');
  }

  const base = `${prefs.base.city} ${prefs.base.region}`.toLowerCase().trim();
  const targets = prefs.relocateTo.map((t) => t.toLowerCase());

  const matches = posting.locations.some((l) => {
    const label = [l.city, l.region].filter(Boolean).join(' ').toLowerCase();
    if (!label) return false;
    if (base && (label.includes(prefs.base.city.toLowerCase()) || base.includes(label)))
      return true;
    return targets.some((t) => label.includes(t) || t.includes(label));
  });

  if (matches) {
    return pass('location', 'Within your commute area or a relocation target.', {
      profileRef: 'locationPrefs',
    });
  }

  const where = posting.locations
    .map((l) => [l.city, l.region].filter(Boolean).join(', '))
    .filter(Boolean)
    .join(' / ');

  // Without coordinates we cannot measure a radius, so this is `unknown`, not `fail`.
  // Guessing here would hide postings in a neighbouring town.
  return unknown(
    'location',
    `Based in ${where}, which is not your home city or a stated relocation target. ` +
      'Distance cannot be measured without coordinates — check whether it works for you.',
    { evidence: where, profileRef: 'locationPrefs.base' },
  );
}

/** Weeks of overlap between the posting's term and the user's availability window. */
export function overlapWeeks(
  term: { start?: string; end?: string },
  avail: { start?: string; end?: string },
): number | null {
  if (!term.start || !term.end || !avail.start || !avail.end) return null;

  // Starts open at the first of the month, ends close at the end of it. Treating both as
  // the first was the bug: it shortened every month-precision term by up to 30 days.
  const ts = Date.parse(monthStart(term.start));
  const te = endBound(term.end);
  const as = Date.parse(monthStart(avail.start));
  const ae = endBound(avail.end);
  if ([ts, te, as, ae].some(Number.isNaN)) return null;

  const start = Math.max(ts, as);
  const end = Math.min(te, ae);
  return end <= start ? 0 : (end - start) / (1000 * 60 * 60 * 24 * 7);
}

/**
 * A month-only bound has to be widened at the END, not just parsed.
 *
 * `2027-08` as a term end means "through August", but reading it as 2027-08-01 threw away
 * up to a month of overlap — and always in the direction of a hard fail. A June-to-August
 * internship against a July-to-September availability computed three weeks of overlap
 * instead of seven and came back `ineligible`.
 *
 * A day-precision date is already exact and is left alone.
 */
function monthStart(d: string): string {
  return /^\d{4}-\d{2}$/.test(d) ? `${d}-01` : d;
}

/** The instant a bound stops covering: the first of the next month, exclusive. */
function endBound(d: string): number {
  if (!/^\d{4}-\d{2}$/.test(d)) return Date.parse(d);
  const [y, m] = d.split('-').map(Number);
  // Month is 1-based here and 0-based in Date.UTC, so this is already "the next month".
  return Date.UTC(y!, m!, 1);
}

const MIN_OVERLAP_WEEKS = 6;

/**
 * Typical Northern-Hemisphere academic terms. US-only is a locked v1 decision
 * (docs/11 § Decisions), so these are safe; revisit if other markets are added.
 */
const SEASON_MONTHS: Record<string, { start: number; end: number }> = {
  summer: { start: 6, end: 8 },
  fall: { start: 9, end: 12 },
  winter: { start: 1, end: 3 },
  spring: { start: 3, end: 5 },
};

/**
 * Explicit dates when the posting gives them, otherwise an approximate window derived
 * from "Summer 2027" and similar.
 *
 * Measured against real postings, almost none state explicit start and end dates, so
 * requiring them made `term_overlap` return `unknown` for 100% of a 302-posting run —
 * which badged the entire queue and destroyed the signal the tri-state exists to carry.
 * A season plus a year is enough to answer the only question this rule asks.
 */
export function deriveTermWindow(term: PostingFacts['term']): {
  window: { start: string; end: string } | null;
  approximate: boolean;
} {
  if (term.start && term.end)
    return { window: { start: term.start, end: term.end }, approximate: false };

  if (term.season && term.year) {
    const months = SEASON_MONTHS[term.season];
    if (months) {
      return {
        window: {
          start: `${term.year}-${String(months.start).padStart(2, '0')}`,
          end: `${term.year}-${String(months.end).padStart(2, '0')}`,
        },
        approximate: true,
      };
    }
  }

  return { window: null, approximate: false };
}

export function termOverlap({ profile, posting }: RuleInput): RuleResult {
  const { window, approximate } = deriveTermWindow(posting.term);

  if (!window) {
    // The posting simply doesn't say when the role runs. That's missing information
    // about the posting, not an unresolved question about the user's eligibility, so
    // flagging it would put a badge on nearly every row and mean nothing.
    return na('term_overlap', 'The posting does not say when the role runs.');
  }

  if (!profile.availability.start || !profile.availability.end) {
    return unknown(
      'term_overlap',
      'Your availability window is not set, so overlap cannot be checked.',
      {
        profileRef: 'availability',
      },
    );
  }

  const weeks = overlapWeeks(window, profile.availability);

  if (weeks === null) {
    return unknown(
      'term_overlap',
      'Either the posting or your availability has unreadable dates, so overlap cannot be checked.',
    );
  }

  // An inferred window is a guess about the calendar, not about the user. Never let it
  // produce a hard rejection.
  if (approximate && weeks < MIN_OVERLAP_WEEKS) {
    return unknown(
      'term_overlap',
      `Inferred a ${posting.term.season} ${posting.term.year} term from the posting, which looks like ` +
        `about ${Math.round(weeks)} week(s) of overlap with your availability. The posting gives no exact dates — check it.`,
      { profileRef: 'availability' },
    );
  }

  const rounded = Math.round(weeks);
  return weeks >= MIN_OVERLAP_WEEKS
    ? pass('term_overlap', `Overlaps your availability by about ${rounded} weeks.`, {
        profileRef: 'availability',
      })
    : fail(
        'term_overlap',
        `Overlaps your availability by only about ${rounded} week(s); ${MIN_OVERLAP_WEEKS} are needed.`,
        {
          evidence: `term ${posting.term.start ?? '?'}..${posting.term.end ?? '?'}`,
          profileRef: 'availability',
        },
      );
}

export function deadline({ posting, now }: RuleInput): RuleResult {
  if (!posting.closesAt) return na('deadline', 'No closing date stated.');

  const closes = Date.parse(posting.closesAt);
  if (Number.isNaN(closes)) return unknown('deadline', 'The closing date could not be read.');

  return closes >= now.getTime()
    ? pass('deadline', `Closes ${posting.closesAt.slice(0, 10)}.`, { evidence: posting.closesAt })
    : fail('deadline', `Closed on ${posting.closesAt.slice(0, 10)}.`, {
        evidence: posting.closesAt,
      });
}

export function postingOpen({ posting }: RuleInput): RuleResult {
  return posting.isOpen
    ? pass('posting_open', 'Still listed as open.')
    : fail('posting_open', 'This posting is no longer open.', { evidence: 'isOpen=false' });
}

const EXPERIENCE_TOLERANCE_YEARS = 1;

export function experienceCeiling({ profile, requirements }: RuleInput): RuleResult {
  const req = firstOfKind(requirements, 'experience_years');
  if (!req) return na('experience_ceiling', 'No professional-experience requirement stated.');
  if (req.necessity !== 'required') {
    return pass('experience_ceiling', 'Experience is listed as preferred, not required.', {
      requirementId: req.id,
    });
  }

  const value = typedValue<{ min: number }>(req);
  if (!value) {
    return unknown('experience_ceiling', 'An experience requirement could not be parsed.', {
      requirementId: req.id,
    });
  }

  const mine = profile.derived.yearsProfessionalExperience;
  const ceiling = mine + EXPERIENCE_TOLERANCE_YEARS;

  return value.min <= ceiling
    ? pass('experience_ceiling', `Wants ${value.min}y; you have about ${mine}y.`, {
        requirementId: req.id,
        profileRef: 'derived.yearsProfessionalExperience',
      })
    : fail(
        'experience_ceiling',
        `Requires ${value.min} years of professional experience; you have about ${mine}.`,
        { requirementId: req.id, profileRef: 'derived.yearsProfessionalExperience' },
      );
}

export function excludedCompany({ profile, posting }: RuleInput): RuleResult {
  const excluded = profile.preferences.excludeCompanies.map((c) => c.toLowerCase().trim());
  const company = posting.company.toLowerCase().trim();

  return excluded.some((e) => e && company.includes(e))
    ? fail('excluded_company', `${posting.company} is on your exclude list.`, {
        evidence: posting.company,
        profileRef: 'preferences.excludeCompanies',
      })
    : pass('excluded_company', 'Not on your exclude list.');
}

export const RULES = [
  postingOpen,
  deadline,
  ageMinimum,
  educationLevel,
  graduationWindow,
  enrollment,
  workAuthorization,
  citizenship,
  location,
  termOverlap,
  experienceCeiling,
  excludedCompany,
] as const;

export function evaluateEligibility(input: RuleInput): EligibilityOutcome {
  const rules = RULES.map((rule) => rule(input));
  const blockers = rules.filter((r) => r.status === 'fail');

  const eligibility: EligibilityStatus =
    blockers.length > 0
      ? 'ineligible'
      : rules.some((r) => r.status === 'unknown')
        ? 'unknown'
        : 'eligible';

  return { eligibility, rules, blockers };
}
