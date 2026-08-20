/**
 * Age clauses, in both polarities — docs/05 § Stage 0 and § Stage 1 together.
 *
 * This is the requirement that is actually about the people this tool exists for, and it
 * used to be read wrongly in both directions at once:
 *
 *   - "You do not need to be 18 years of age to apply" produced a hard 18+ requirement, and
 *     the sentence inviting the student to apply was printed beside the rejection as its
 *     evidence. A false `ineligible` has no override at G3 and is documented as the worst
 *     bug this app can have.
 *   - "Must be 18 years of age or older, or 16 years of age with a valid work permit" kept
 *     only the 18, so the teen program's own 16-year-old alternative disqualified the very
 *     applicant it was written for.
 *   - "Minimum age: 18.", "Must be at least 18." and "Applicants under 18 will not be
 *     considered." matched nothing at all, so a 16-year-old was told in so many words that
 *     "the posting does not state a minimum age" beside a green tick.
 *
 * Every case below therefore states which of the two failure directions it is guarding, and
 * the false-red and false-green cases are kept side by side on purpose: a change that fixes
 * one by trading it for the other fails here.
 */
import { describe, expect, it } from 'vitest';
import type { ConfirmedProfile, JobRequirement } from '@ia/shared';
import { deterministicRequirements } from '../src/core/matching/extractRequirements';
import { evaluateEligibility, type PostingFacts } from '../src/core/matching/eligibility';

const NOW = new Date('2026-08-09T00:00:00Z');

/** The population this module exists for: a 16-year-old high schooler, not a minor edge case. */
function sixteenYearOld(): ConfirmedProfile {
  return {
    id: 'p1',
    fullName: 'Rosa Delgado',
    email: 'rosa@example.com',
    dateOfBirth: '2010-01-04',
    address: { country: 'US' },
    links: { other: [] },
    workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
    citizenships: ['US'],
    education: [
      {
        institution: 'Boston Latin School',
        level: 'high_school',
        startDate: '2024-09',
        endDate: '2028-06',
        coursework: [],
        honors: [],
      },
    ],
    experience: [],
    projects: [],
    skills: [],
    certifications: [],
    languages: [],
    availability: { start: '2027-06-01', end: '2027-08-20', flexible: true },
    locationPrefs: {
      base: { city: 'Boston', region: 'MA', country: 'US' },
      additionalBases: [],
      maxCommuteKm: 50,
      remoteOk: true,
      hybridOk: true,
      relocateTo: [],
    },
    preferences: { companySizes: [], roleFamilies: [], industries: [], excludeCompanies: [] },
    derived: {
      age: 16,
      isMinor: true,
      academicLevel: 'high_school',
      academicYear: 2,
      expectedGraduation: '2028-06',
      yearsProfessionalExperience: 0,
      seniorityBand: 'entry_intern',
    },
    confirmedAt: NOW.toISOString(),
    needsReview: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } as unknown as ConfirmedProfile;
}

const POSTING: PostingFacts = {
  id: 'j1',
  company: 'Acme Labs',
  title: 'Summer Teen Intern',
  isOpen: true,
  closesAt: null,
  locations: [{ city: 'Boston', region: 'MA', country: 'US', remote: false }],
  workArrangement: 'onsite',
  term: { season: 'summer', year: 2027, start: '2027-06', end: '2027-08' },
};

/** The minima the deterministic pass reads out of a posting, lowest first. */
function minima(description: string): number[] {
  return deterministicRequirements(description)
    .filter((c) => c.kind === 'age' && c.necessity === 'required')
    .map((c) => (c.value as { min: number }).min)
    .filter((min, i, all) => all.indexOf(min) === i)
    .sort((a, b) => a - b);
}

/** What a 16-year-old is actually told, through extraction and the rules together. */
function verdictFor16(description: string): { overall: string; age: string; because: string } {
  let seq = 0;
  const requirements = deterministicRequirements(description).map(
    (c) =>
      ({
        id: `r${++seq}`,
        postingId: POSTING.id,
        kind: c.kind,
        operator: c.operator,
        value: c.value,
        necessity: c.necessity,
        sourceQuote: c.sourceQuote,
        confidence: c.confidence,
      }) as JobRequirement,
  );
  const outcome = evaluateEligibility({
    profile: sixteenYearOld(),
    posting: POSTING,
    requirements,
    now: NOW,
  });
  const rule = outcome.rules.find((r) => r.rule === 'age_minimum')!;
  return { overall: outcome.eligibility, age: rule.status, because: rule.because };
}

// ─────────────────────────────────────────── C14: a clause that cancels the requirement

describe('an age clause the posting cancels (false red)', () => {
  /**
   * The exact sentence from the report. It was stored as the `sourceQuote` and shown to the
   * student beside "You are 16; this posting requires 18+." — the app quoting the invitation
   * as proof of the rejection.
   */
  it('reads no requirement out of "you do not need to be 18"', () => {
    expect(minima('You do not need to be 18 years of age to apply.')).toEqual([]);
    expect(verdictFor16('You do not need to be 18 years of age to apply.').overall).not.toBe(
      'ineligible',
    );
  });

  /**
   * The siblings. Whichever form is left out is the one the next posting will use, so the
   * contraction, the "need not" inversion and the trailing negation are all pinned here.
   */
  it.each([
    'Applicants need not be 18 years old.',
    'No, you do not have to be 18 years of age.',
    "You don't have to be 18 years of age to apply.",
    'Being 18 years of age is not required.',
    'There is no minimum age for this program.',
    'Applicants are not required to be 18 or older.',
    'You do not need a car or to be 18 years of age.',
  ])('reads no requirement out of %j', (text) => {
    expect(minima(text)).toEqual([]);
    expect(verdictFor16(text).overall).not.toBe('ineligible');
  });

  /**
   * The negating clause and a real lower minimum in the same breath. Dropping the 18 is only
   * half the job: the 16 the same sentence offers has to survive, or the student gets an
   * unexplained blank where the posting told her she qualifies.
   */
  it('keeps the lower minimum the same sentence does state', () => {
    const text = 'There is no requirement to be 18 years of age; students 16 and over may apply.';
    expect(minima(text)).toEqual([16]);
    const verdict = verdictFor16(text);
    expect(verdict.age).toBe('pass');
    expect(verdict.overall).toBe('eligible');
  });

  /**
   * The opposite direction, in the same shape. A "not" that belongs to a different statement
   * must not carry across a line break or a full stop — the three sibling blocks in this
   * module each lost a real requirement that way before their windows were narrowed.
   */
  it.each([
    ['line break', 'Requirements\nWe do not offer relocation\nApplicants must be 18 or older'],
    ['full stop', 'We do not offer relocation. Applicants must be 18 or older.'],
    ['conjunction', 'This role does not offer relocation, and applicants must be 18 or older.'],
    ['later clause', 'Applicants must be 18 or older; no exceptions will be made.'],
  ])('still finds a real 18+ rule across a %s', (_label, text) => {
    expect(minima(text)).toEqual([18]);
    expect(verdictFor16(text).overall).toBe('ineligible');
  });

  /**
   * The negative that belongs to a DIFFERENT predicate in the same unpunctuated clause.
   *
   * A whole-clause negation window was tried and deleted every one of these floors, because
   * "…or older with no exceptions" carries no comma and no full stop, so the "no" attached
   * to the exceptions cancelled the age. That is an ordinary adult-only warehouse, retail
   * and driving posting, and the result was the exact false green C16 was filed for: "The
   * posting does not state a minimum age." printed for a 16-year-old beside a green tick on
   * a posting that plainly says 18. The window is the lead-in for that reason.
   */
  it.each([
    ['no exceptions', 'Must be 18 years of age or older with no exceptions.'],
    ['no exceptions, at least', 'Applicants must be at least 18 years of age with no exceptions.'],
    ['without exception', 'You must be 18 years or older without exception.'],
    ['no experience necessary', 'Must be 18 years of age or older with no experience necessary.'],
    ['with or without', 'Must be 18 years of age or older with or without a high school diploma.'],
    ['regardless of', 'All applicants must be 18 or older regardless of prior experience.'],
    ['no felony convictions', 'Must be 18 years of age or older with no felony convictions.'],
    ['none of', 'Must be 18 years of age or older with none of the usual paperwork.'],
    ['no assistance', 'Must be 18 or older and able to lift 25 pounds with no assistance.'],
  ])('keeps the floor when the negative belongs to something else (%s)', (_label, text) => {
    expect(minima(text)).toEqual([18]);
    expect(verdictFor16(text).overall).toBe('ineligible');
  });

  /** The same, at a driving threshold and through the "over the age of" wording. */
  it.each([
    'Applicants must be at least 21 years of age with no exceptions.',
    'Drivers must be over the age of 21 with no moving violations.',
  ])('keeps a 21 floor beside an unrelated negative in %j', (text) => {
    expect(minima(text)).toEqual([21]);
    expect(verdictFor16(text).overall).toBe('ineligible');
  });

  /**
   * The narrow list that DOES cancel from behind. These are the only wordings allowed to,
   * and each of them cancels a requirement rather than merely containing a negative.
   */
  it.each([
    'Being 18 years of age is not required.',
    'Being 18 years of age is not a requirement.',
    'Being 18 years old is not necessary.',
    'Being 18 or older is not mandatory.',
  ])('still reads no requirement out of %j', (text) => {
    expect(minima(text)).toEqual([]);
    expect(verdictFor16(text).overall).not.toBe('ineligible');
  });
});

// ─────────────────────────── C15: a second, lower minimum stated in the same sentence

describe('a lower minimum offered to a minor (false red)', () => {
  /**
   * The second alternative shares the subject and the verb of the first, so a pattern
   * anchored on "must be" never saw the 16 and hard-failed the 16-year-old with the words
   * "or 16 years of age" printed inside the quote given as the reason.
   *
   * `unknown` is the right answer, not `pass`: the tool cannot verify that the student has a
   * work permit, and the posting has told her two different things.
   */
  it.each([
    [
      'shared subject and verb',
      'Must be 18 years of age or older, or 16 years of age with a valid work permit.',
    ],
    ['at least, twice', 'You must be at least 18 years old, or at least 16 with a work permit.'],
    [
      'second clause with its own subject',
      'Must be 18 or older; 16 and 17 year olds must submit a work permit.',
    ],
    ['parenthetical consent', 'Applicants must be 18 or older (16 with parental consent).'],
    ['working papers', 'Applicants must be 18+ to apply, or 16 with working papers.'],
  ])('extracts both minima when the posting states them (%s)', (_label, text) => {
    expect(minima(text)).toContain(18);
    expect(minima(text)[0]).toBe(16);
    const verdict = verdictFor16(text);
    expect(verdict.age).toBe('unknown');
    expect(verdict.overall).not.toBe('ineligible');
  });

  /**
   * The lower alternative is only ever read out of a sentence that already stated a higher
   * one, which is what makes this pass incapable of inventing a floor: it can turn a `fail`
   * into the `unknown` that asks which threshold applies, and nothing else. A sentence about
   * what minors bring with them, standing on its own, states no minimum at all.
   */
  it.each([
    'We hire 16 and 17 year olds with a valid work permit.',
    'Minors require a work permit before their first shift.',
    'Applicants under 18 must provide a valid work permit.',
  ])('invents no minimum from %j', (text) => {
    expect(minima(text)).toEqual([]);
    expect(verdictFor16(text).overall).not.toBe('ineligible');
  });

  /**
   * The regression this pass could most easily have caused: a posting whose real floor is 16
   * and whose second sentence only says what a minor has to bring. Reading that "under 18"
   * as a second floor turned a clean `pass` into a hedge.
   */
  it('does not read a permit condition as a second, higher floor', () => {
    const text =
      'Applicants must be 16 years of age or older. Applicants under the age of 18 must provide a valid work permit.';
    expect(minima(text)).toEqual([16]);
    expect(verdictFor16(text).age).toBe('pass');
  });

  /** A minimum genuinely below the lowest stated one still disqualifies — 14 is not 16. */
  it('still fails an applicant below the lowest stated minimum', () => {
    const text = 'Must be 18 years of age or older, or 16 years of age with a valid work permit.';
    const under = sixteenYearOld();
    const fourteen = {
      ...under,
      dateOfBirth: '2012-01-04',
      derived: { ...under.derived, age: 14 },
    } as ConfirmedProfile;
    let seq = 0;
    const requirements = deterministicRequirements(text).map(
      (c) =>
        ({
          id: `r${++seq}`,
          postingId: POSTING.id,
          kind: c.kind,
          operator: c.operator,
          value: c.value,
          necessity: c.necessity,
          sourceQuote: c.sourceQuote,
          confidence: c.confidence,
        }) as JobRequirement,
    );
    const outcome = evaluateEligibility({
      profile: fourteen,
      posting: POSTING,
      requirements,
      now: NOW,
    });
    expect(outcome.rules.find((r) => r.rule === 'age_minimum')!.status).toBe('fail');
  });
});

// ─────────────────────────────── C16: ordinary 18+ phrasings that matched nothing

describe('an 18+ rule the posting really states (false green)', () => {
  /**
   * Each of these produced `age reqs: []` and the sentence "The posting does not state a
   * minimum age." beside a green tick, on a posting whose eligibility section says 18.
   */
  it.each([
    ['bare at-least', 'Must be at least 18.'],
    ['at-least to apply', 'Must be at least 18 to apply.'],
    ['a minimum of', 'Applicants must be a minimum of 18 years of age.'],
    ['labelled field', 'Minimum age: 18.'],
    ['labelled field, verb', 'Minimum age is 18.'],
    ['age requirement label', 'Age requirement: 18.'],
    ['under-not-eligible', 'Applicants under the age of 18 are not eligible.'],
    ['under-not-considered', 'Applicants under 18 will not be considered.'],
    ['no one under', 'No applicants under 18 may apply.'],
    ['cannot hire', 'We cannot hire anyone under 18.'],
    ['over the age of', 'Applicants must be over the age of 18.'],
    ['older than', 'Applicants must be older than 18.'],
    ['no younger than', 'Applicants must be no younger than 18.'],
    ['by the start date', 'You must be 18 by the start date.'],
    ['at the time of hire', 'You must be 18 at the time of hire.'],
    ['years old', 'Applicants must be 18 years old.'],
    ['hyphenated year-old', 'This role is for an 18-year-old or above.'],
    ['year olds and up', 'Open to 18 year olds and up.'],
  ])('finds the minimum in %s', (_label, text) => {
    expect(minima(text)).toEqual([18]);
    expect(verdictFor16(text).overall).toBe('ineligible');
  });

  /** The phrasings that already worked, kept here so a rewrite cannot quietly drop them. */
  it.each([
    'Applicants must be at least 18 years of age.',
    'Candidates must be 18 years of age or older.',
    'Candidates must be 18 years or older.',
    'You must be 18+ to apply.',
    'You must be 18 or over.',
  ])('still finds the minimum in %j', (text) => {
    expect(minima(text)).toEqual([18]);
  });

  /** A driving-age clause is a real minimum too, and it is not always 18. */
  it('reads a 21+ clause at its own threshold', () => {
    expect(minima('Drivers must be 21 with a valid license.')).toEqual([21]);
  });

  /**
   * A duty the adults in the intake also carry is not a bar on everyone else. Read as a
   * floor, "Applicants 18 and over must complete a background check" hard-refused the
   * 16-year-old the posting invited two lines earlier — and inside a 14-and-up programme it
   * turned an explicit `pass` into an `unknown` the student cannot resolve. The eligibility
   * predicates are a short list; the other duties an employer can name are not.
   */
  it.each([
    'Applicants aged 18 and over must complete a background check.',
    'Applicants 18 and over must complete a background check.',
    'Interns aged 18 and over may operate company vehicles.',
    'Staff aged 21 and over may serve alcohol at events.',
    'Applicants over the age of 18 must complete a background check.',
  ])('reads no floor out of a duty placed on the adults: %j', (text) => {
    expect(minima(text)).toEqual([]);
    expect(verdictFor16(text).overall).not.toBe('ineligible');
  });

  /** The same grammar stating who may APPLY is still a floor. */
  it.each([
    'Applicants aged 18 and over are eligible.',
    'Applicants aged 18 and over may apply.',
    'Applicants 18 and up may apply.',
  ])('still finds the floor when the predicate is eligibility: %j', (text) => {
    expect(minima(text)).toEqual([18]);
  });
});

// ─────────────────────────────────── numbers in a posting that are not ages at all

describe('a number that is not an age', () => {
  /**
   * Widening the patterns so "Must be at least 18." is caught is exactly how a posting's
   * credit hours, weekly hours, hourly pay and cohort size become a hard age floor. Each of
   * these would hard-fail a 16-year-old on a posting with no age rule whatsoever.
   */
  it.each([
    ['credit hours', 'You must be enrolled in at least 18 credit hours per semester.'],
    ['months of experience', 'We ask for at least 18 months of experience.'],
    ['years of experience', 'We ask for at least 18 years of experience on the senior track.'],
    ['weekly hours', 'Interns must be available at least 20 hours per week.'],
    ['an hours range', 'Interns must be available between 20 and 25 hours per week.'],
    ['a pay range', 'The role pays between 18 and 24 dollars per hour.'],
    ['hourly pay', 'This role pays $18 and up depending on experience.'],
    ['a starting rate', 'Pay starts at 18+ per hour for returning interns.'],
    ['a cohort size', 'Each cohort will be 20 students.'],
    ['a street address', 'Our office is on Route 18 in Framingham.'],
    ['a lifting limit', 'Must be able to lift 25 pounds.'],
    ['a grade band', 'Open to students in grades 9 to 12.'],
    // The units an application-materials section can name are not enumerable, and the
    // allowlist of what may follow an age cannot separate them either: "to", "and" and
    // "with" have to be on it for "18 to apply" and "18 with a valid license", and they are
    // also how a measurement continues before it reaches its unit. It is the SUBJECT that
    // is bounded — an age belongs to a person.
    ['a presentation length', 'Presentations must be at least 20 to 25 minutes.'],
    ['a video length', 'Your video must be at least 20 to 25 seconds long.'],
    ['an essay length', 'Your essay must be at least 18 and no more than 22 pages long.'],
    ['a slide count', 'Slide decks must be at least 15 with a title slide.'],
    ['a team size', 'Teams must be at least 15 and at most 20 people.'],
    ['a reading-list length', 'Your reading list must be at least 20 with citations.'],
    ['a waitlist size', 'The waitlist is a minimum of 20 and a maximum of 30.'],
  ])('reads no age requirement out of %s', (_label, text) => {
    expect(minima(text)).toEqual([]);
    // The age rule specifically, because some of these sentences legitimately trip a
    // different rule — an internship asking for eighteen years of experience really is
    // out of reach, and that is the experience rule's judgement to make, not this one's.
    expect(verdictFor16(text).age).toBe('not_applicable');
  });

  /**
   * "N+ <countable noun>" is standard About-us copy, and a trailing "+" that needed nothing
   * in front of it turned every one of these into a hard age floor — an invented
   * `ineligible` for a 16-year-old out of a sentence with no age content whatsoever, on
   * postings written for high schoolers. A denylist of nouns cannot close this: the nouns
   * are unbounded, which is why the requirement sits in front of the digits instead.
   */
  it.each([
    'We operate in 20+ countries.',
    'Our summer program partners with 20+ companies across Boston.',
    'You will join a team of 20+ engineers.',
    'Every intern is paired with a network of 15+ mentors.',
    'We host 20+ workshops and events over the summer.',
    'We receive 20+ applications a day.',
    'Acme supports 25+ nonprofit partners.',
    'You will use 16+ tools across the stack.',
    'There are 20+ offices worldwide.',
  ])('reads no age requirement out of the company prose %j', (text) => {
    expect(minima(text)).toEqual([]);
    expect(verdictFor16(text).age).toBe('not_applicable');
  });

  /**
   * A condition placed on ADULTS is not a floor against a minor. This is the mirror of
   * "Applicants under 18 must provide a work permit", which the block above already refuses
   * to read as a floor; reading its opposite as one invented an 18+ or 21+ rule and, on a
   * posting that also states its real 14+ floor, downgraded a clean `pass` to a hedge the
   * student has no way to resolve. The difference is the verb: a floor says the applicant
   * must BE over the age, these say what someone already over it has to do.
   */
  it.each([
    'Applicants over the age of 18 must complete a background check.',
    'Interns over the age of 18 may operate company vehicles.',
    'Candidates older than 18 must provide their own transportation.',
    'Staff over the age of 21 may serve alcohol at events.',
    'Interns who are over the age of 18 may operate company vehicles.',
  ])('reads no floor out of a condition placed on adults: %j', (text) => {
    expect(minima(text)).toEqual([]);
    expect(verdictFor16(text).age).toBe('not_applicable');
  });

  /**
   * A "between N and M" that never says "age" is a pay band or a class size. The unit that
   * would give it away sits in prose the exclusion list cannot enumerate — "an hour", "per
   * hour", or nothing at all — so the band has to name an age instead.
   */
  it.each([
    'We offer between 18 and 22 an hour.',
    'Stipends range between 18 and 25 per hour.',
    'Class size is between 15 and 25.',
  ])('reads no age band out of %j', (text) => {
    expect(minima(text)).toEqual([]);
    expect(verdictFor16(text).age).toBe('not_applicable');
  });

  /**
   * An application-materials section states minimums about the submission, not the person.
   * "seconds" and "slides" are not on the unit exclusion list and the units such a section
   * can name — lines, samples, photos, questions — cannot all be put on it, so what may
   * follow an age is stated positively instead: punctuation, a preposition, or "years".
   */
  it.each([
    'Your submission must be a minimum of 20 seconds long.',
    'Your portfolio must be a minimum of 15 slides.',
    'Your essay must be a minimum of 20 lines.',
    'Applicants must submit a minimum of 20 photos.',
  ])('reads no age floor out of a submission requirement: %j', (text) => {
    expect(minima(text)).toEqual([]);
    expect(verdictFor16(text).age).toBe('not_applicable');
  });
});

// ─────────────────── the floors the narrowing above must not have taken with it

describe('the floors those exclusions must still find', () => {
  /** A "+" that really is an age still needs a lead-in, and these all have one. */
  it.each([
    ['must be', 'You must be 18+ to apply.'],
    ['should be', 'Applicants should be 18+.'],
    ['at least', 'Must be at least 18+ years of age.'],
    ['labelled', 'Age requirement: 18+'],
  ])('finds the 18+ floor written with %s', (_label, text) => {
    expect(minima(text)).toEqual([18]);
    expect(verdictFor16(text).overall).toBe('ineligible');
  });

  /** And the low "+" floor a youth program states must still let the 16-year-old through. */
  it.each(['Open to ages 16+.', 'Age: 16+'])('reads the low floor in %j', (text) => {
    expect(minima(text)).toEqual([16]);
    expect(verdictFor16(text).age).toBe('pass');
  });

  /** "over the age of" with the verb in front of it is a real floor and still one. */
  it.each([
    'Applicants must be over the age of 18.',
    'Applicants must be older than 18.',
    'You need to be over the age of 18.',
    'Applicants are required to be over the age of 18.',
    'Candidates must have reached the age of 18 by the start date.',
  ])('finds the floor in %j', (text) => {
    expect(minima(text)).toEqual([18]);
    expect(verdictFor16(text).overall).toBe('ineligible');
  });

  /** A bare "must be at least N" is still a floor whatever ordinary words follow it. */
  it.each([
    'You must be at least 18 on your first day.',
    'Applicants must be at least 18 as of June 1.',
    'Candidates must be 18 upon hire.',
    'You must be at least 18 in order to apply.',
    'Must be at least 18, and available in June.',
  ])('finds the floor in %j', (text) => {
    expect(minima(text)).toEqual([18]);
    expect(verdictFor16(text).overall).toBe('ineligible');
  });

  /** A band that names an age is still a band, whichever side the age word sits on. */
  it.each([
    ['the ages of', 'Open to applicants between the ages of 16 and 18.'],
    ['years of age after', 'Open to applicants between 16 and 18 years of age.'],
    ['years old after', 'Open to applicants between 16 and 18 years old.'],
  ])('takes the lower end of a band written with %s', (_label, text) => {
    expect(minima(text)).toEqual([16]);
    expect(verdictFor16(text).age).toBe('pass');
  });

  /**
   * A "between 16 and 18" that names no age at all is a clause the app cannot read. The
   * repo's rule is to say so rather than guess, and the safe shape of saying so here is to
   * record nothing: what must never happen is the 18 at the end of it becoming a floor
   * against the 16-year-old the sentence is probably about.
   */
  it('invents no floor from a range that never says "age"', () => {
    expect(minima('Open to applicants between 16 and 18.')).toEqual([]);
    expect(verdictFor16('Open to applicants between 16 and 18.').overall).not.toBe('ineligible');
  });
});

// ───────────────────────────────────────────────────────── bands and invitations

describe('an age band', () => {
  /**
   * A youth program describes itself by the band it serves. The top of that band is not a
   * floor, and reading "aged 16 to 18" as an 18+ rule hard-failed the 16-year-old the
   * program exists for.
   */
  it.each([
    ['to', 'Open to students aged 16 to 18 years of age.'],
    ['hyphen', 'This program is for 16-18 year olds.'],
    ['between the ages of', 'Open to applicants between the ages of 16 and 18.'],
  ])('takes the lower end of a band written with %s', (_label, text) => {
    expect(minima(text)).toEqual([16]);
    expect(verdictFor16(text).age).toBe('pass');
  });

  /** An invitation stating a low floor is a floor, and it must let the 16-year-old through. */
  it.each(['Open to applicants 16 and up.', 'Students 16 and over may apply.'])(
    'reads the low floor in %j',
    (text) => {
      expect(minima(text)).toEqual([16]);
      expect(verdictFor16(text).age).toBe('pass');
    },
  );

  /** A plain welcome is not an age rule; inventing one from it would be an invented block. */
  it.each([
    'High school students are welcome to apply.',
    'This program is popular with 18 year olds.',
  ])('reads no floor out of %j', (text) => {
    expect(minima(text)).toEqual([]);
    expect(verdictFor16(text).overall).not.toBe('ineligible');
  });
});

// ─────────────────────────────────────────────────── an age gate with no number in it

describe('an age gate the posting never puts a number on', () => {
  /**
   * "Legal working age" depends on the state, the industry and the hours, so guessing 16 or
   * 18 would invent a requirement the posting does not state. The repo's answer for wording
   * nobody can read confidently is `unclear`, which the rules route to a non-blocking
   * `unknown` — better than the green tick and "the posting does not state a minimum age"
   * this used to print on a posting that plainly does gate on age.
   */
  it('records it as unclear, which blocks nobody', () => {
    const text = 'Applicants must be of legal working age in Massachusetts.';
    const found = deterministicRequirements(text).filter((c) => c.kind === 'age');
    expect(found).toHaveLength(1);
    expect(found[0]!.necessity).toBe('unclear');

    const verdict = verdictFor16(text);
    expect(verdict.age).toBe('unknown');
    expect(verdict.overall).not.toBe('ineligible');
    expect(verdict.because).toMatch(/check the posting/i);
  });

  /** Once the posting names its number, the hedge is noise and the number is the answer. */
  it('defers to a stated number in the same posting', () => {
    const text = 'Applicants must be of legal working age. Applicants must be at least 18.';
    expect(minima(text)).toEqual([18]);
    expect(
      deterministicRequirements(text).filter((c) => c.kind === 'age' && c.necessity === 'unclear'),
    ).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────── whole postings, not sentences

describe('whole postings', () => {
  /**
   * The report's realism check: an ATS-shaped body with a heading, unpunctuated bullets and
   * the invitation on one line. The line that says a 16-year-old may apply was the line that
   * filtered her out.
   */
  it('lets a 16-year-old through the posting written to invite her', () => {
    const posting = `Summer Youth Intern - Acme Labs

Eligibility
Open to current high school students in the Boston area.
You do not need to be 18 years of age to apply; students 16 and older are eligible.
Must be available 20 to 25 hours per week.
Pay starts at $18 and up depending on experience.`;
    expect(minima(posting)).toEqual([16]);
    const verdict = verdictFor16(posting);
    expect(verdict.age).toBe('pass');
    expect(verdict.overall).toBe('eligible');
  });

  /** And the opposite posting, whose eligibility box is one unpunctuated line, still blocks. */
  it('rules her out of a posting whose eligibility box says 18', () => {
    const posting = `Warehouse Summer Associate

Eligibility
Minimum age: 18
Must be able to lift 25 pounds
We do not offer relocation`;
    expect(minima(posting)).toEqual([18]);
    expect(verdictFor16(posting).overall).toBe('ineligible');
  });

  /**
   * The posting that carries a number in its About section and its real floor further down.
   * Reading "20+ companies" as an age floor did not merely add a second minimum: it
   * downgraded the `pass` the posting's own 16+ line grants to an `unknown` the student
   * cannot resolve, on a programme written for high schoolers.
   */
  it('ignores a number in the About section and keeps the posting open', () => {
    const posting = `Summer Youth Intern - Acme Labs

About us
Acme Labs partners with 20+ companies across Boston to place high school students in paid summer roles.

Eligibility
Students 16 and older are eligible.`;
    expect(minima(posting)).toEqual([16]);
    const verdict = verdictFor16(posting);
    expect(verdict.age).toBe('pass');
    expect(verdict.overall).toBe('eligible');
  });

  /** The same posting with an adults-only condition in it stays open too. */
  it('ignores an adults-only condition and keeps the posting open', () => {
    const posting = `Summer Youth Intern - Acme Labs

Eligibility
Open to students 14 and up.
Applicants over the age of 18 must complete a background check.`;
    expect(minima(posting)).toEqual([14]);
    const verdict = verdictFor16(posting);
    expect(verdict.age).toBe('pass');
    expect(verdict.overall).toBe('eligible');
  });

  /** And the adult-only posting whose one age line ends in an unrelated negative still blocks. */
  it('rules her out of an adult-only posting that says "no exceptions" on the same line', () => {
    const posting = `Warehouse Associate - Night Shift

Requirements
Applicants must be at least 18 years of age with no exceptions.
Must be able to lift 25 pounds
We do not offer relocation`;
    expect(minima(posting)).toEqual([18]);
    expect(verdictFor16(posting).overall).toBe('ineligible');
  });

  /** Every quote stored beside an age requirement has to be findable in the posting itself. */
  it('quotes only text that appears in the posting', () => {
    const posting = `Summer Teen Intern Program

Eligibility
Must be 18 years of age or older, or 16 years of age with a valid work permit.
Interns who drive company vehicles must be 21 years of age.`;
    const found = deterministicRequirements(posting).filter((c) => c.kind === 'age');
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) expect(posting).toContain(c.sourceQuote);
    expect(minima(posting)).toEqual([16, 18, 21]);
  });
});
