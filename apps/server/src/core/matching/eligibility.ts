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

/**
 * What a requirement the posting did not insist on is allowed to do to a verdict.
 *
 * A posting that says "a Master's is preferred" has already told the user they may apply
 * without one, and failing them on it hid postings that had explicitly welcomed them —
 * "PhD candidates preferred but not required" disqualified an undergraduate on a sentence
 * that says the opposite. Wording nobody could read confidently arrives as `unclear`, and
 * the extraction prompt promises the model that unclear is non-blocking; that promise held
 * for the experience rule and for no other, so a model that hedged honestly still cost the
 * user the posting.
 *
 * A preference passes. An ambiguity is a question for the user to settle, which is exactly
 * what `unknown` is for. Returns null when the posting really does state the requirement,
 * and the rule should go on to do its own work.
 */
function softRequirement(rule: string, req: JobRequirement, what: string): RuleResult | null {
  if (req.necessity === 'preferred') {
    return pass(rule, `${what} is listed as preferred, not required.`, { requirementId: req.id });
  }
  if (req.necessity === 'unclear') {
    return unknown(rule, `${what} is worded too ambiguously to judge — check the posting.`, {
      requirementId: req.id,
    });
  }
  return null;
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

  const soft = softRequirement('age_minimum', req, 'A minimum age');
  if (soft) return soft;

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
  const reqs = requirements.filter((r) => r.kind === 'education_level');
  if (reqs.length === 0) {
    return na('education_level', 'The posting does not state an education level.');
  }

  // "Bachelor's or Master's degree" arrives as two separate requirements, one per level,
  // and reading only the first of them let the sort order decide the rule. When the model
  // was the one to spot the master's clause it outranked the regex's bachelor's on
  // confidence and hard-failed an undergraduate the posting had explicitly welcomed.
  // Every level a posting names is an alternative, so they are pooled and meeting any one
  // of them is enough.
  //
  // Only the levels the posting insists on are pooled into `wanted`. A level it merely
  // prefers must never subtract from one it requires, and on its own it cannot disqualify
  // anybody — see softRequirement.
  const wanted = new Map<string, JobRequirement>();
  const merelyLiked = new Map<string, JobRequirement>();
  let parsedAny = false;

  for (const r of reqs) {
    const levels = typedValue<{ levels: string[] }>(r)?.levels ?? [];
    if (levels.length > 0) parsedAny = true;
    const into = r.necessity === 'required' ? wanted : merelyLiked;
    for (const level of levels) if (!into.has(level)) into.set(level, r);
  }

  if (!parsedAny) {
    return unknown('education_level', 'An education requirement could not be parsed.', {
      requirementId: reqs[0]!.id,
    });
  }

  if (wanted.size === 0) {
    // An ambiguous clause outranks a merely preferred one: if any of them could not be
    // read confidently, the honest answer is a question rather than a clean pass.
    const soft = [...merelyLiked.values()];
    const speaksFor = soft.find((r) => r.necessity === 'unclear') ?? soft[0]!;
    return softRequirement('education_level', speaksFor, 'A degree level')!;
  }

  const openToAny = wanted.get('any');
  if (openToAny) {
    return pass('education_level', 'Open to any education level.', {
      requirementId: openToAny.id,
    });
  }

  const mine = ACADEMIC_TO_LEVEL[profile.derived.academicLevel] ?? 'none';
  if (mine === 'none') {
    return unknown('education_level', 'No education history on file to check against.', {
      requirementId: reqs[0]!.id,
      profileRef: 'education',
    });
  }

  // "Enrolled in a Bachelor's" is satisfied by anyone at or above that level.
  const mineRank = LEVEL_ORDER.indexOf(mine);
  const met = [...wanted].find(([level]) => {
    const rank = LEVEL_ORDER.indexOf(level);
    return rank === -1 ? false : mineRank >= rank;
  });

  return met
    ? pass('education_level', `Your level (${mine}) meets the requirement.`, {
        requirementId: met[1].id,
        profileRef: 'derived.academicLevel',
      })
    : fail(
        'education_level',
        `This posting wants ${[...wanted.keys()].join(' or ')}; your level is ${mine}.`,
        { requirementId: reqs[0]!.id, profileRef: 'derived.academicLevel' },
      );
}

export function graduationWindow({ profile, requirements }: RuleInput): RuleResult {
  // A posting routinely names more than one window — "juniors graduating between December
  // 2026 and June 2027, sophomores graduating between December 2027 and June 2028" — and
  // each one is an alternative, not an extra condition. Consulting only whichever sorted
  // first told a sophomore who matched the second sentence that she graduated outside the
  // window, quoting the sentence written for juniors. Every window is read, and matching
  // any one of them is enough.
  const reqs = requirements.filter((r) => r.kind === 'graduation_window');
  if (reqs.length === 0) {
    return na('graduation_window', 'The posting does not state a graduation window.');
  }

  const parsed: Array<{ req: JobRequirement; from?: string; to?: string }> = [];
  for (const r of reqs) {
    const value = typedValue<{ from?: string; to?: string }>(r);
    if (value && (value.from || value.to)) parsed.push({ req: r, ...value });
  }

  if (parsed.length === 0) {
    return unknown('graduation_window', 'A graduation window is mentioned but unparseable.', {
      requirementId: reqs[0]!.id,
    });
  }

  const grad = profile.derived.expectedGraduation;
  if (!grad) {
    return unknown(
      'graduation_window',
      'This posting restricts graduation dates, but yours is not on file.',
      { requirementId: parsed[0]!.req.id, profileRef: 'derived.expectedGraduation' },
    );
  }

  const label = (w: { from?: string; to?: string }) => `${w.from ?? 'any'} to ${w.to ?? 'any'}`;
  const inside = (w: { from?: string; to?: string }) =>
    !(w.from !== undefined && grad < w.from) && !(w.to !== undefined && grad > w.to);

  const met = parsed.find(inside);
  if (met) {
    return pass('graduation_window', `You graduate ${grad}, inside the ${label(met)} window.`, {
      requirementId: met.req.id,
      profileRef: 'derived.expectedGraduation',
    });
  }

  const binding = parsed.filter((w) => w.req.necessity === 'required');
  if (binding.length === 0) {
    const speaksFor = parsed.find((w) => w.req.necessity === 'unclear') ?? parsed[0]!;
    return softRequirement('graduation_window', speaksFor.req, 'A graduation window')!;
  }

  // Naming every window the user was actually measured against, so the sentence cannot
  // quote one date range while the posting offered another.
  return fail(
    'graduation_window',
    `You graduate ${grad}; this posting wants graduation between ${binding.map(label).join(' or ')}.`,
    { requirementId: binding[0]!.req.id, profileRef: 'derived.expectedGraduation' },
  );
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

  // Whether enrolment is needed at all is settled first, because a posting that says it is
  // not should pass however tentatively it said so. Only then does how firmly the posting
  // asks for it matter: "preferably still enrolled" was read as a rule and filtered recent
  // graduates out of postings that had merely expressed a wish.
  const soft = softRequirement('enrollment', req, 'Active enrolment');
  if (soft) return soft;

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

interface WorkAuthValue {
  sponsorshipUnavailable?: boolean;
  requiresExistingAuthorization?: boolean;
}

export function workAuthorization({ profile, requirements }: RuleInput): RuleResult {
  const reqs = requirements.filter((r) => r.kind === 'work_auth');
  if (reqs.length === 0) {
    return na('work_authorization', 'The posting does not mention work authorization.');
  }

  const parsed: Array<{ req: JobRequirement; value: WorkAuthValue }> = [];
  for (const req of reqs) {
    const value = typedValue<WorkAuthValue>(req);
    if (value) parsed.push({ req, value });
  }

  if (parsed.length === 0) {
    return unknown('work_authorization', 'A work-authorization clause could not be parsed.', {
      requirementId: reqs[0]!.id,
    });
  }

  const auth = profile.workAuthorization;
  if (auth.status === 'unknown') {
    return unknown('work_authorization', 'Your work-authorization status is not on file.', {
      requirementId: reqs[0]!.id,
      profileRef: 'workAuthorization.status',
    });
  }

  if (!auth.needsSponsorship) {
    return pass('work_authorization', 'You do not need sponsorship.', {
      requirementId: reqs[0]!.id,
      profileRef: 'workAuthorization.needsSponsorship',
    });
  }

  // A posting can say both "must be authorized to work in the US" and "we do not sponsor".
  // Judging it on whichever of the two sorted first told a user who needs sponsorship that
  // the posting "does not rule it out" while one of its own sentences did exactly that, so
  // every clause is read and any refusal the posting states decides.
  //
  // Requiring existing authorization is deliberately not a blocker by itself: plenty of
  // employers write that line and sponsor anyway, and treating it as a refusal would hide
  // postings the user could actually get.
  //
  // Only a refusal the posting actually states closes the door. A clause that merely says
  // the employer would rather not sponsor, or one nobody could read confidently, used to
  // hard-fail every applicant who needs a visa on wording that never ruled them out — and
  // this is the rule where that costs the most, because these are the postings a
  // sponsorship-dependent student most needs to see.
  const refusals = parsed.filter((p) => p.value.sponsorshipUnavailable);
  const stated = refusals.find((p) => p.req.necessity === 'required');
  if (stated) {
    return fail(
      'work_authorization',
      'You need sponsorship and this posting states it is not available.',
      { requirementId: stated.req.id, profileRef: 'workAuthorization.needsSponsorship' },
    );
  }

  const hedged = refusals.find((p) => p.req.necessity === 'unclear');
  if (hedged) {
    return unknown(
      'work_authorization',
      'You need sponsorship, and the posting is too vague about whether it offers any — check it.',
      { requirementId: hedged.req.id, profileRef: 'workAuthorization.needsSponsorship' },
    );
  }

  const wished = refusals[0];
  if (wished) {
    return pass(
      'work_authorization',
      'You need sponsorship; the posting would rather you did not, but it does not rule it out.',
      { requirementId: wished.req.id, profileRef: 'workAuthorization.needsSponsorship' },
    );
  }

  return pass('work_authorization', 'You need sponsorship; the posting does not rule it out.', {
    requirementId: parsed[0]!.req.id,
    profileRef: 'workAuthorization.needsSponsorship',
  });
}

export function citizenship({ profile, requirements }: RuleInput): RuleResult {
  const reqs = requirements.filter((r) => r.kind === 'citizenship');
  if (reqs.length === 0) {
    return na('citizenship', 'The posting does not state a citizenship requirement.');
  }

  // "Requires US citizenship and an active security clearance" is two requirements, and
  // reading only one of them dropped the clearance advisory on the floor — the user was
  // told the citizenship requirement was met and never heard about the clearance at all.
  // Countries are pooled across the clauses, which can only widen who qualifies.
  //
  // Only the countries a posting insists on are pooled. "U.S. citizens preferred" is
  // ordinary wording on defence-adjacent postings and it hard-failed everyone who is not
  // one, on a sentence that had not actually ruled them out.
  const countries: string[] = [];
  let countriesFrom: JobRequirement | undefined;
  const merelyLiked: JobRequirement[] = [];
  let clearanceFrom: JobRequirement | undefined;
  let parsedAny = false;

  for (const r of reqs) {
    const value = typedValue<{ countries?: string[]; clearanceRequired?: boolean }>(r);
    if (!value) continue;
    parsedAny = true;
    if (value.countries?.length) {
      if (r.necessity === 'required') {
        countries.push(...value.countries);
        countriesFrom ??= r;
      } else {
        merelyLiked.push(r);
      }
    }
    if (value.clearanceRequired) clearanceFrom ??= r;
  }

  if (!parsedAny) {
    return unknown('citizenship', 'A citizenship clause could not be parsed.', {
      requirementId: reqs[0]!.id,
    });
  }

  if (countriesFrom && countries.length) {
    if (profile.citizenships.length === 0) {
      return unknown(
        'citizenship',
        `This posting requires ${countries.join(' or ')} citizenship; yours is not on file.`,
        { requirementId: countriesFrom.id, profileRef: 'citizenships' },
      );
    }
    const ok = countries.some((c) =>
      profile.citizenships.some((mine) => mine.toUpperCase() === c.toUpperCase()),
    );
    if (!ok) {
      return fail(
        'citizenship',
        `Requires ${countries.join(' or ')} citizenship; you hold ${profile.citizenships.join(', ')}.`,
        { requirementId: countriesFrom.id, profileRef: 'citizenships' },
      );
    }
  }

  if (clearanceFrom) {
    return unknown(
      'citizenship',
      'This posting requires a security clearance. The tool cannot verify that — check yourself.',
      { requirementId: clearanceFrom.id },
    );
  }

  if (!countriesFrom && merelyLiked.length > 0) {
    // An ambiguous clause outranks a merely preferred one: if any of them could not be
    // read confidently, the honest answer is a question rather than a clean pass.
    const speaksFor = merelyLiked.find((r) => r.necessity === 'unclear') ?? merelyLiked[0]!;
    return softRequirement('citizenship', speaksFor, 'A citizenship requirement')!;
  }

  return pass('citizenship', 'Citizenship requirement met.', { requirementId: reqs[0]!.id });
}

/**
 * Locations are compared as text, not as distances.
 *
 * Nothing upstream geocodes a posting, so there are no coordinates to measure with and
 * `locationPrefs.maxCommuteKm` decides nothing in this rule. A city the rule does not
 * recognise comes back `unknown` for the user to judge, rather than being guessed at.
 */
export function location({ profile, posting }: RuleInput): RuleResult {
  const arrangement = posting.workArrangement;
  const prefs = profile.locationPrefs;

  // "Remote" and "offers remote" are different postings, and only the first one can be
  // failed on a remote preference. Greenhouse writes "New York, NY or Remote" as ONE
  // location, which parseLocation turns into {city:'New York', remote:true} — so a
  // `.some(l => l.remote)` test used to hard-fail a user living in New York who simply
  // prefers to go in. A remote flag is disqualifying only when nowhere else is offered.
  const remoteOnly =
    arrangement === 'remote' ||
    (posting.locations.length > 0 &&
      posting.locations.every((l) => l.remote && !l.city && !l.region));

  if (remoteOnly) {
    return prefs.remoteOk
      ? pass('location', 'Remote, which you accept.', { profileRef: 'locationPrefs.remoteOk' })
      : fail('location', 'This posting is remote and you have remote turned off.', {
          evidence: `workArrangement=${arrangement ?? 'remote'}`,
          profileRef: 'locationPrefs.remoteOk',
        });
  }

  if (prefs.remoteOk && posting.locations.some((l) => l.remote)) {
    return pass('location', 'Offered remote, which you accept.', {
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

  // Empty strings are the enemy of `includes`. The home city starts as '' and the wizard
  // lets a user fill in the state alone, which made label.includes('') true and passed
  // EVERY posting on earth with "within your commute area" — a confident sentence about a
  // comparison that never happened. Same hole in an empty relocation target.
  const city = prefs.base.city.trim().toLowerCase();
  const base = `${prefs.base.city} ${prefs.base.region}`.toLowerCase().trim();
  const targets = prefs.relocateTo.map((t) => t.trim().toLowerCase()).filter(Boolean);

  const matches = posting.locations.some((l) => {
    const label = [l.city, l.region].filter(Boolean).join(' ').toLowerCase();
    if (!label) return false;
    if (city && (label.includes(city) || base.includes(label))) return true;
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

export function termOverlap({ profile, posting, requirements }: RuleInput): RuleResult {
  const derived = deriveTermWindow(posting.term);
  let window = derived.window;
  let approximate = derived.approximate;
  let inferredAs = `a ${posting.term.season} ${posting.term.year} term`;
  let requirementId: string | undefined;

  // Dates a posting only states in prose ("runs June through August 2027") never reach
  // posting.term — they come back as a term_dates requirement — so the rule went
  // not_applicable on postings that plainly said when the role runs. Extracted dates are
  // treated as approximate, which means they can raise a question but can never hard-fail
  // anyone on a date nobody parsed from a structured field.
  if (!window) {
    const req = firstOfKind(requirements, 'term_dates');
    const value = req ? typedValue<{ start?: string; end?: string }>(req) : null;
    if (req && value?.start && value.end) {
      window = { start: value.start, end: value.end };
      approximate = true;
      inferredAs = `a ${value.start} to ${value.end} term`;
      requirementId = req.id;
    }
  }

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
        ...(requirementId ? { requirementId } : {}),
      },
    );
  }

  const weeks = overlapWeeks(window, profile.availability);

  if (weeks === null) {
    return unknown(
      'term_overlap',
      'Either the posting or your availability has unreadable dates, so overlap cannot be checked.',
      requirementId ? { requirementId } : {},
    );
  }

  // An inferred window is a guess about the calendar, not about the user. Never let it
  // produce a hard rejection.
  if (approximate && weeks < MIN_OVERLAP_WEEKS) {
    return unknown(
      'term_overlap',
      `Inferred ${inferredAs} from the posting, which looks like ` +
        `about ${Math.round(weeks)} week(s) of overlap with your availability. The posting gives no exact dates — check it.`,
      { profileRef: 'availability', ...(requirementId ? { requirementId } : {}) },
    );
  }

  const rounded = Math.round(weeks);
  return weeks >= MIN_OVERLAP_WEEKS
    ? pass('term_overlap', `Overlaps your availability by about ${rounded} weeks.`, {
        profileRef: 'availability',
        ...(requirementId ? { requirementId } : {}),
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

  // A date with no time means the whole of that day, not its first instant. USAJOBS and
  // JSON-LD both hand over bare dates, and Date.parse puts those at midnight UTC — which
  // closed the posting a full day early and reported "Closed on <today>" to a user who
  // still had hours to apply. Close of business, generously: end of that day.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(posting.closesAt.trim());
  const closes = dateOnly
    ? Date.parse(`${posting.closesAt.trim()}T23:59:59Z`)
    : Date.parse(posting.closesAt);
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

  // Wording that could not be read confidently used to be reported as "listed as
  // preferred" — a claim about the posting that it never made. It is a question now.
  const soft = softRequirement('experience_ceiling', req, 'Professional experience');
  if (soft) return soft;

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
