import { describe, expect, it } from 'vitest';
import type { ConfirmedProfile, JobRequirement } from '@ia/shared';
import {
  RULES,
  evaluateEligibility,
  overlapWeeks,
  type PostingFacts,
  type RuleInput,
} from '../src/core/matching/eligibility';

const NOW = new Date('2026-08-03T00:00:00Z');

function profile(over: Partial<ConfirmedProfile> = {}): ConfirmedProfile {
  const base = {
    id: 'p1',
    fullName: 'A',
    email: 'a@b.c',
    dateOfBirth: '2006-03-15',
    address: { country: 'US' },
    links: { other: [] },
    workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
    citizenships: ['US'],
    education: [
      {
        institution: 'MIT',
        level: 'bachelor',
        startDate: '2024-09',
        endDate: '2028-05',
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
      maxCommuteKm: 50,
      remoteOk: true,
      hybridOk: true,
      relocateTo: [],
    },
    preferences: { companySizes: [], industries: [], excludeCompanies: [] },
    derived: {
      age: 20,
      isMinor: false,
      academicLevel: 'undergrad',
      academicYear: 2,
      expectedGraduation: '2028-05',
      yearsProfessionalExperience: 0.3,
      seniorityBand: 'entry_intern',
    },
    confirmedAt: NOW.toISOString(),
    needsReview: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
  return base as ConfirmedProfile;
}

function posting(over: Partial<PostingFacts> = {}): PostingFacts {
  return {
    id: 'j1',
    company: 'Acme',
    title: 'SWE Intern',
    isOpen: true,
    closesAt: null,
    locations: [{ city: 'Boston', region: 'MA', country: 'US', remote: false }],
    workArrangement: 'onsite',
    term: { season: 'summer', year: 2027, start: '2027-06', end: '2027-08' },
    ...over,
  };
}

let reqSeq = 0;
function req(kind: string, value: unknown, over: Partial<JobRequirement> = {}): JobRequirement {
  return {
    id: `r${++reqSeq}`,
    postingId: 'j1',
    kind,
    operator: 'min',
    value,
    necessity: 'required',
    sourceQuote: 'quoted from the job description',
    confidence: 0.9,
    ...over,
  } as JobRequirement;
}

function input(over: Partial<RuleInput> = {}): RuleInput {
  return { profile: profile(), posting: posting(), requirements: [], now: NOW, ...over };
}

const statusOf = (o: ReturnType<typeof evaluateEligibility>, rule: string) =>
  o.rules.find((r) => r.rule === rule)?.status;

// ────────────────────────────────────────────────────────────── golden fixtures

describe('age_minimum', () => {
  it('passes when old enough', () => {
    const o = evaluateEligibility(input({ requirements: [req('age', { min: 18 })] }));
    expect(statusOf(o, 'age_minimum')).toBe('pass');
  });

  it('fails when too young, and says so', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({
          dateOfBirth: '2010-03-15',
          derived: { ...profile().derived, age: 16, isMinor: true },
        }),
        requirements: [req('age', { min: 18 })],
      }),
    );
    expect(statusOf(o, 'age_minimum')).toBe('fail');
    expect(o.eligibility).toBe('ineligible');
    expect(o.blockers[0]!.because).toMatch(/16.*18/);
  });

  /**
   * `profile.derived` is written when the profile is saved and never again, so a student who
   * filled in the wizard at 17 stayed 17 on every matching run afterwards and "must be 18 to
   * apply" went on hiding postings for months after their birthday. The rule reads the clock
   * it was handed, not the one that happened to be running the day they last saved.
   */
  it('counts a birthday that has passed since the profile was last saved', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({
          dateOfBirth: '2008-06-15',
          derived: { ...profile().derived, age: 17, isMinor: true },
        }),
        requirements: [req('age', { min: 18 })],
      }),
    );
    expect(statusOf(o, 'age_minimum')).toBe('pass');
    expect(o.blockers).toEqual([]);
  });

  /**
   * "Interns who drive company vehicles must be 21 years of age. All applicants must be 18
   * years or older to apply." is two `age` requirements, both required, both extracted at
   * the same confidence — so whichever sentence the posting printed first decided the rule,
   * and a 19-year-old was told the posting requires 21+. Printing the sentences the other
   * way round passed the same person.
   */
  it('does not let one of several stated minimum ages decide the rule', () => {
    const vehicles = req('age', { min: 21 }, { confidence: 0.95 });
    const toApply = req('age', { min: 18 }, { confidence: 0.95 });

    for (const requirements of [
      [vehicles, toApply],
      [toApply, vehicles],
    ]) {
      const o = evaluateEligibility(
        input({
          profile: profile({
            dateOfBirth: '2007-03-15',
            derived: { ...profile().derived, age: 19 },
          }),
          requirements,
        }),
      );
      expect(statusOf(o, 'age_minimum'), JSON.stringify(requirements.map((r) => r.id))).toBe(
        'unknown',
      );
      expect(o.blockers).toEqual([]);
    }
  });

  /** Someone below every minimum the posting states is still disqualified, on the lowest. */
  it('fails below the lowest of several stated minimum ages, and quotes that one', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({
          dateOfBirth: '2009-03-15',
          derived: { ...profile().derived, age: 17, isMinor: true },
        }),
        requirements: [req('age', { min: 21 }), req('age', { min: 18 })],
      }),
    );
    expect(statusOf(o, 'age_minimum')).toBe('fail');
    expect(o.blockers[0]!.because).toMatch(/17.*18/);
  });

  /** A missing DOB must ask, not assume adulthood and not hide the posting. */
  it('is unknown when the date of birth is missing', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({
          dateOfBirth: null,
          derived: { ...profile().derived, age: null },
        }),
        requirements: [req('age', { min: 18 })],
      }),
    );
    expect(statusOf(o, 'age_minimum')).toBe('unknown');
    expect(o.eligibility).toBe('unknown');
  });

  it('is not applicable when the posting says nothing about age', () => {
    expect(statusOf(evaluateEligibility(input()), 'age_minimum')).toBe('not_applicable');
  });

  it('is unknown when the age value is malformed rather than failing', () => {
    const o = evaluateEligibility(input({ requirements: [req('age', { min: 'eighteen' })] }));
    expect(statusOf(o, 'age_minimum')).toBe('unknown');
  });
});

describe('education_level', () => {
  it('accepts a level at or above the requirement', () => {
    const o = evaluateEligibility(
      input({ requirements: [req('education_level', { levels: ['bachelor'] })] }),
    );
    expect(statusOf(o, 'education_level')).toBe('pass');
  });

  it('accepts someone more advanced than asked for', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ derived: { ...profile().derived, academicLevel: 'phd' } }),
        requirements: [req('education_level', { levels: ['bachelor'] })],
      }),
    );
    expect(statusOf(o, 'education_level')).toBe('pass');
  });

  it('fails a high schooler for a bachelor-only posting', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ derived: { ...profile().derived, academicLevel: 'high_school' } }),
        requirements: [req('education_level', { levels: ['bachelor'] })],
      }),
    );
    expect(statusOf(o, 'education_level')).toBe('fail');
  });

  it('passes when the posting says any level', () => {
    const o = evaluateEligibility(
      input({ requirements: [req('education_level', { levels: ['any'] })] }),
    );
    expect(statusOf(o, 'education_level')).toBe('pass');
  });

  /**
   * "PhD candidates preferred but not required" is a sentence written to invite an
   * undergraduate, and failing them on it hid the posting from the person it was aimed at.
   */
  it('does not fail a degree level the posting only prefers', () => {
    const o = evaluateEligibility(
      input({
        requirements: [req('education_level', { levels: ['master'] }, { necessity: 'preferred' })],
      }),
    );
    expect(statusOf(o, 'education_level')).toBe('pass');
    expect(o.eligibility).toBe('eligible');
  });

  /**
   * The extraction prompt tells the model that `unclear` is non-blocking, so a model that
   * hedges honestly about ambiguous wording must not cost the user the posting.
   */
  it('asks rather than fails when the degree wording is ambiguous', () => {
    const o = evaluateEligibility(
      input({
        requirements: [req('education_level', { levels: ['doctorate'] }, { necessity: 'unclear' })],
      }),
    );
    expect(statusOf(o, 'education_level')).toBe('unknown');
    expect(o.blockers).toEqual([]);
  });

  /** "Bachelor's required, Master's preferred" is satisfied by the bachelor's alone. */
  it('does not let a preferred level subtract from a required one', () => {
    const o = evaluateEligibility(
      input({
        requirements: [
          req('education_level', { levels: ['bachelor'] }),
          req('education_level', { levels: ['master'] }, { necessity: 'preferred' }),
        ],
      }),
    );
    expect(statusOf(o, 'education_level')).toBe('pass');
  });

  /**
   * The checklist quotes the requirement a rule cites, so citing the wrong one prints a
   * sentence that had nothing to do with the verdict. A posting reading "must be enrolled in
   * a PhD program" beside "a bachelor's degree in mathematics is a plus" rejected an
   * undergraduate and showed the bachelor's line — the one written to welcome them — as the
   * reason they were turned away.
   */
  it('cites a level the posting insisted on, never one it merely liked', () => {
    const aPlus = req('education_level', { levels: ['bachelor'] }, { necessity: 'preferred' });
    const insisted = req('education_level', { levels: ['doctorate'] });
    const o = evaluateEligibility(input({ requirements: [aPlus, insisted] }));

    expect(statusOf(o, 'education_level')).toBe('fail');
    expect(o.blockers[0]!.requirementId).toBe(insisted.id);
  });

  it('cites a required clause when it has to ask which level is meant', () => {
    const aPlus = req('education_level', { levels: ['bachelor'] }, { necessity: 'preferred' });
    const insisted = req('education_level', { levels: ['master'] });
    const o = evaluateEligibility(
      input({
        profile: profile({ derived: { ...profile().derived, academicLevel: 'none' } }),
        requirements: [aPlus, insisted],
      }),
    );

    const r = o.rules.find((x) => x.rule === 'education_level')!;
    expect(r.status).toBe('unknown');
    expect(r.requirementId).toBe(insisted.id);
  });

  /**
   * A level that is not on the degree ladder cannot be ranked against one that is, and
   * ranking it anyway made it satisfy nothing at all and hard-fail. Asking is the only
   * honest answer for a bootcamp graduate against "Bachelor's required".
   */
  it('asks rather than fails when the level is not on the degree ladder', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ derived: { ...profile().derived, academicLevel: 'bootcamp' } }),
        requirements: [req('education_level', { levels: ['bachelor'] })],
      }),
    );
    expect(statusOf(o, 'education_level')).toBe('unknown');
    expect(o.blockers).toEqual([]);
  });
});

describe('graduation_window', () => {
  it('passes inside the window', () => {
    const o = evaluateEligibility(
      input({ requirements: [req('graduation_window', { from: '2027-12', to: '2028-09' })] }),
    );
    expect(statusOf(o, 'graduation_window')).toBe('pass');
  });

  it('fails when graduating too early', () => {
    const o = evaluateEligibility(
      input({ requirements: [req('graduation_window', { from: '2029-01', to: '2030-06' })] }),
    );
    expect(statusOf(o, 'graduation_window')).toBe('fail');
  });

  it('fails when graduating too late', () => {
    const o = evaluateEligibility(
      input({ requirements: [req('graduation_window', { to: '2027-06' })] }),
    );
    expect(statusOf(o, 'graduation_window')).toBe('fail');
  });

  it('is unknown when the user has no graduation date', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ derived: { ...profile().derived, expectedGraduation: null } }),
        requirements: [req('graduation_window', { from: '2027-12', to: '2028-09' })],
      }),
    );
    expect(statusOf(o, 'graduation_window')).toBe('unknown');
  });

  /**
   * A posting routinely names one window for juniors and another for sophomores, and each
   * one is an alternative rather than an extra condition. Reading only whichever sorted
   * first told a sophomore who matched the second sentence that she graduated outside the
   * window, quoting the sentence written for juniors. Both orders are checked because the
   * sort ties here and natural reading order decided it.
   */
  it('passes when the user matches any one of several stated windows', () => {
    const juniors = req('graduation_window', { from: '2026-12', to: '2027-06' });
    const sophomores = req('graduation_window', { from: '2027-12', to: '2028-06' });

    for (const requirements of [
      [juniors, sophomores],
      [sophomores, juniors],
    ]) {
      const o = evaluateEligibility(input({ requirements }));
      expect(statusOf(o, 'graduation_window'), JSON.stringify(requirements.map((r) => r.id))).toBe(
        'pass',
      );
    }
  });

  /** The sentence cannot quote one date range while the posting offered another. */
  it('names every window it measured you against when none of them match', () => {
    const o = evaluateEligibility(
      input({
        requirements: [
          req('graduation_window', { from: '2024-01', to: '2024-06' }),
          req('graduation_window', { from: '2025-01', to: '2025-06' }),
        ],
      }),
    );
    expect(statusOf(o, 'graduation_window')).toBe('fail');
    expect(o.blockers[0]!.because).toContain('2024-01 to 2024-06 or 2025-01 to 2025-06');
  });

  it('does not fail a graduation window the posting only prefers', () => {
    const o = evaluateEligibility(
      input({
        requirements: [
          req('graduation_window', { from: '2024-01', to: '2024-06' }, { necessity: 'preferred' }),
        ],
      }),
    );
    expect(statusOf(o, 'graduation_window')).toBe('pass');
  });
});

describe('enrollment', () => {
  it('passes for a currently enrolled student', () => {
    const o = evaluateEligibility(input({ requirements: [req('enrollment', { required: true })] }));
    expect(statusOf(o, 'enrollment')).toBe('pass');
  });

  it('fails for someone who already graduated', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ derived: { ...profile().derived, expectedGraduation: '2025-05' } }),
        requirements: [req('enrollment', { required: true })],
      }),
    );
    expect(statusOf(o, 'enrollment')).toBe('fail');
  });

  /** "Preferably still enrolled" is a wish, and a recent graduate may still apply on it. */
  it('does not fail a graduate on enrolment the posting only prefers', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ derived: { ...profile().derived, expectedGraduation: '2025-05' } }),
        requirements: [req('enrollment', { required: true }, { necessity: 'preferred' })],
      }),
    );
    expect(statusOf(o, 'enrollment')).toBe('pass');
    expect(o.blockers).toEqual([]);
  });

  it('asks rather than fails when the enrolment wording is ambiguous', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ derived: { ...profile().derived, expectedGraduation: '2025-05' } }),
        requirements: [req('enrollment', { required: true }, { necessity: 'unclear' })],
      }),
    );
    expect(statusOf(o, 'enrollment')).toBe('unknown');
  });

  /** A posting saying enrolment is NOT needed passes however tentatively it said so. */
  it('passes a graduate when the posting says enrolment is not needed', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ derived: { ...profile().derived, expectedGraduation: '2025-05' } }),
        requirements: [req('enrollment', { required: false }, { necessity: 'unclear' })],
      }),
    );
    expect(statusOf(o, 'enrollment')).toBe('pass');
  });

  /**
   * "Current students only" in the header and "recent graduates are also welcome to apply"
   * in the small print is one posting saying both things, and reading whichever clause was
   * extracted with the higher confidence let a coin toss filter every graduate out of a
   * posting that had invited them in so many words. Both orders are checked, because the
   * confidences tie as often as not and then text order decides.
   */
  it('lets a clause saying enrolment is not needed settle it, whatever its confidence', () => {
    const studentsOnly = req('enrollment', { required: true }, { confidence: 0.8 });
    const gradsWelcome = req('enrollment', { required: false }, { confidence: 0.7 });

    for (const requirements of [
      [studentsOnly, gradsWelcome],
      [gradsWelcome, studentsOnly],
    ]) {
      const o = evaluateEligibility(
        input({
          profile: profile({ derived: { ...profile().derived, expectedGraduation: '2025-05' } }),
          requirements,
        }),
      );
      expect(statusOf(o, 'enrollment'), JSON.stringify(requirements.map((r) => r.id))).toBe('pass');
      expect(o.blockers).toEqual([]);
    }
  });
});

describe('work_authorization', () => {
  it('passes when no sponsorship is needed', () => {
    const o = evaluateEligibility(
      input({ requirements: [req('work_auth', { sponsorshipUnavailable: true })] }),
    );
    expect(statusOf(o, 'work_authorization')).toBe('pass');
  });

  it('fails when sponsorship is needed but unavailable', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({
          workAuthorization: {
            country: 'US',
            status: 'requires_sponsorship',
            needsSponsorship: true,
          },
        }),
        requirements: [req('work_auth', { sponsorshipUnavailable: true })],
      }),
    );
    expect(statusOf(o, 'work_authorization')).toBe('fail');
  });

  it('passes when sponsorship is needed and the posting does not rule it out', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({
          workAuthorization: {
            country: 'US',
            status: 'requires_sponsorship',
            needsSponsorship: true,
          },
        }),
        requirements: [req('work_auth', { requiresExistingAuthorization: true })],
      }),
    );
    expect(statusOf(o, 'work_authorization')).toBe('pass');
  });

  it('is unknown when the user has not stated their status', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({
          workAuthorization: { country: 'US', status: 'unknown', needsSponsorship: false },
        }),
        requirements: [req('work_auth', { sponsorshipUnavailable: true })],
      }),
    );
    expect(statusOf(o, 'work_authorization')).toBe('unknown');
  });

  /**
   * These are the postings a sponsorship-dependent student most needs to see, so wording
   * that stops short of a refusal must never hide one. A clause the posting only leans
   * towards leaves the door open; one nobody could read confidently is a question.
   */
  const needsVisa = () =>
    profile({
      workAuthorization: { country: 'US', status: 'requires_sponsorship', needsSponsorship: true },
    });

  const noSponsorship = (necessity: 'preferred' | 'unclear') =>
    req('work_auth', { sponsorshipUnavailable: true }, { necessity });

  it('does not fail on a sponsorship refusal the posting only leans towards', () => {
    const o = evaluateEligibility(
      input({ profile: needsVisa(), requirements: [noSponsorship('preferred')] }),
    );
    expect(statusOf(o, 'work_authorization')).toBe('pass');
    expect(o.blockers).toEqual([]);
  });

  it('asks rather than fails when the sponsorship wording is ambiguous', () => {
    const o = evaluateEligibility(
      input({ profile: needsVisa(), requirements: [noSponsorship('unclear')] }),
    );
    expect(statusOf(o, 'work_authorization')).toBe('unknown');
  });

  /** One hedged clause must not cancel a refusal the posting states outright elsewhere. */
  it('still fails when a stated refusal sits alongside a hedged one', () => {
    const o = evaluateEligibility(
      input({
        profile: needsVisa(),
        requirements: [
          noSponsorship('unclear'),
          req('work_auth', { sponsorshipUnavailable: true }),
        ],
      }),
    );
    expect(statusOf(o, 'work_authorization')).toBe('fail');
  });
});

describe('citizenship', () => {
  it('passes a US citizen for a US-citizen posting', () => {
    const o = evaluateEligibility(
      input({ requirements: [req('citizenship', { countries: ['US'] })] }),
    );
    expect(statusOf(o, 'citizenship')).toBe('pass');
  });

  it('fails when citizenship does not match', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ citizenships: ['CA'] }),
        requirements: [req('citizenship', { countries: ['US'] })],
      }),
    );
    expect(statusOf(o, 'citizenship')).toBe('fail');
  });

  /** A clearance is something only the user can confirm, so we ask rather than decide. */
  it('is unknown when a security clearance is required', () => {
    const o = evaluateEligibility(
      input({ requirements: [req('citizenship', { clearanceRequired: true })] }),
    );
    expect(statusOf(o, 'citizenship')).toBe('unknown');
  });

  /**
   * "U.S. citizens preferred" is ordinary wording on defence-adjacent postings, and it
   * hard-failed everyone who is not one on a sentence that had not ruled them out.
   */
  it('does not fail a non-citizen on citizenship the posting merely prefers', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ citizenships: ['IN'] }),
        requirements: [req('citizenship', { countries: ['US'] }, { necessity: 'preferred' })],
      }),
    );
    expect(statusOf(o, 'citizenship')).toBe('pass');
    expect(o.blockers).toEqual([]);
  });

  it('asks rather than fails when the citizenship wording is ambiguous', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ citizenships: ['IN'] }),
        requirements: [req('citizenship', { countries: ['US'] }, { necessity: 'unclear' })],
      }),
    );
    expect(statusOf(o, 'citizenship')).toBe('unknown');
  });

  /**
   * A preferred country must not widen — or narrow — one the posting actually insists on,
   * for somebody who holds neither. "Canadian citizens preferred" beside "US citizenship
   * required" still rules out an Indian citizen, and the rejection quotes the rule.
   */
  it('still fails on a stated citizenship requirement beside a preferred one', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ citizenships: ['IN'] }),
        requirements: [
          req('citizenship', { countries: ['CA'] }, { necessity: 'preferred' }),
          req('citizenship', { countries: ['US'] }),
        ],
      }),
    );
    expect(statusOf(o, 'citizenship')).toBe('fail');
    expect(o.blockers[0]!.because).toContain('US');
  });

  /**
   * The person that same posting is arguing about is the Canadian. Pooling only the
   * countries the posting insisted on threw away the softer clause entirely, so "US
   * citizenship required" beside "Canadian citizens may also apply" hard-failed exactly the
   * applicant the second sentence was written for. A posting that says both is contradicting
   * itself and only the user can settle it, so they are asked and shown the clause that
   * named their own nationality.
   */
  it('asks rather than fails when a softer clause names a nationality the user holds', () => {
    for (const necessity of ['preferred', 'unclear'] as const) {
      const alsoWelcome = req('citizenship', { countries: ['CA'] }, { necessity });
      const o = evaluateEligibility(
        input({
          profile: profile({ citizenships: ['CA'] }),
          requirements: [req('citizenship', { countries: ['US'] }), alsoWelcome],
        }),
      );
      const r = o.rules.find((x) => x.rule === 'citizenship')!;
      expect(r.status, necessity).toBe('unknown');
      expect(r.requirementId).toBe(alsoWelcome.id);
      expect(o.blockers).toEqual([]);
    }
  });
});

describe('location', () => {
  it('passes a remote posting when remote is acceptable', () => {
    const o = evaluateEligibility(
      input({ posting: posting({ workArrangement: 'remote', locations: [{ remote: true }] }) }),
    );
    expect(statusOf(o, 'location')).toBe('pass');
  });

  it('fails a remote posting when the user turned remote off', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({
          locationPrefs: { ...profile().locationPrefs, remoteOk: false },
        }),
        posting: posting({ workArrangement: 'remote', locations: [{ remote: true }] }),
      }),
    );
    expect(statusOf(o, 'location')).toBe('fail');
  });

  it('passes the home city', () => {
    expect(statusOf(evaluateEligibility(input()), 'location')).toBe('pass');
  });

  it('passes a stated relocation target', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({
          locationPrefs: { ...profile().locationPrefs, relocateTo: ['Seattle'] },
        }),
        posting: posting({
          locations: [{ city: 'Seattle', region: 'WA', country: 'US', remote: false }],
        }),
      }),
    );
    expect(statusOf(o, 'location')).toBe('pass');
  });

  /**
   * "New York, NY or Remote" is ONE Greenhouse location string, and parseLocation turns
   * it into a city with the remote flag set. Reading that as remote-only hard-failed a
   * user who lives in New York and simply prefers to go into an office.
   *
   * `workArrangement` is 'remote' here because that is what discovery stores for such a
   * posting: parseWorkArrangement scrapes the word out of the description text, so a line
   * like "our teams collaborate with remote colleagues" is enough to set it. Passing null
   * was the one value the pipeline will not produce for that text, and the test could not
   * fail.
   */
  it('does not fail a posting that offers remote alongside a city the user lives in', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ locationPrefs: { ...profile().locationPrefs, remoteOk: false } }),
        posting: posting({
          workArrangement: 'remote',
          locations: [{ city: 'Boston', region: 'MA', country: 'US', remote: true }],
        }),
      }),
    );
    expect(statusOf(o, 'location')).toBe('pass');
  });

  /**
   * The word is scraped out of prose and the office is a field the board filled in, so the
   * office wins. "Our teams collaborate with remote colleagues across the world" under a
   * heading of "Location: New York, NY" parses as `remote` and hid an onsite job in the
   * user's own city; "some full-time roles are hybrid" did the same to a posting that says
   * interns are onsite five days a week.
   */
  it('does not fail on a scraped arrangement while the posting names an office', () => {
    for (const workArrangement of ['remote', 'hybrid']) {
      const o = evaluateEligibility(
        input({
          profile: profile({
            locationPrefs: { ...profile().locationPrefs, remoteOk: false, hybridOk: false },
          }),
          posting: posting({
            workArrangement,
            locations: [{ city: 'Boston', region: 'MA', country: 'US', remote: false }],
          }),
        }),
      );
      expect(statusOf(o, 'location'), workArrangement).toBe('pass');
      expect(o.blockers).toEqual([]);
    }
  });

  /** An office somewhere the user has not said they would go is a question, not a rejection. */
  it('asks about a hybrid posting in an unfamiliar city rather than failing it', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ locationPrefs: { ...profile().locationPrefs, hybridOk: false } }),
        posting: posting({
          workArrangement: 'hybrid',
          locations: [{ city: 'Austin', region: 'TX', country: 'US', remote: false }],
        }),
      }),
    );
    expect(statusOf(o, 'location')).toBe('unknown');
  });

  /** With nowhere to go, the arrangement is all there is, and it still decides. */
  it('still fails a hybrid posting that names no office at all', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ locationPrefs: { ...profile().locationPrefs, hybridOk: false } }),
        posting: posting({ workArrangement: 'hybrid', locations: [] }),
      }),
    );
    expect(statusOf(o, 'location')).toBe('fail');
  });

  it('still fails a remote posting that names no office at all', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ locationPrefs: { ...profile().locationPrefs, remoteOk: false } }),
        posting: posting({ workArrangement: 'remote', locations: [] }),
      }),
    );
    expect(statusOf(o, 'location')).toBe('fail');
  });

  it('still fails a posting that is only remote', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ locationPrefs: { ...profile().locationPrefs, remoteOk: false } }),
        posting: posting({ workArrangement: null, locations: [{ remote: true }] }),
      }),
    );
    expect(statusOf(o, 'location')).toBe('fail');
  });

  /**
   * The wizard lets someone fill in the state and leave the city blank, and the home city
   * starts as ''. `label.includes('')` is true, so every posting on earth came back
   * "within your commute area" — a confident sentence about a comparison that never ran.
   */
  it('does not claim a commute match when the home city is blank', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({
          locationPrefs: {
            ...profile().locationPrefs,
            base: { city: '', region: 'MA', country: 'US' },
          },
        }),
        posting: posting({
          locations: [{ city: 'Austin', region: 'TX', country: 'US', remote: false }],
        }),
      }),
    );
    expect(statusOf(o, 'location')).toBe('unknown');
  });

  it('ignores an empty relocation target', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({
          locationPrefs: {
            ...profile().locationPrefs,
            base: { city: '', region: '', country: 'US' },
            relocateTo: [''],
          },
        }),
        posting: posting({
          locations: [{ city: 'Austin', region: 'TX', country: 'US', remote: false }],
        }),
      }),
    );
    expect(statusOf(o, 'location')).toBe('unknown');
  });

  /**
   * Without coordinates we cannot measure a radius. Guessing would hide a posting one
   * town over, so an unfamiliar city is `unknown` and the user decides.
   */
  it('is unknown, not a failure, for an unfamiliar city', () => {
    const o = evaluateEligibility(
      input({
        posting: posting({
          locations: [{ city: 'Austin', region: 'TX', country: 'US', remote: false }],
        }),
      }),
    );
    expect(statusOf(o, 'location')).toBe('unknown');
  });
});

describe('term_overlap', () => {
  it('passes a full summer overlap', () => {
    expect(statusOf(evaluateEligibility(input()), 'term_overlap')).toBe('pass');
  });

  /** The posting says "fall 2027" and its dates say August to December: the two agree, so
   *  the window is firm enough to turn a summer-only student away on. */
  it('fails a term that barely overlaps', () => {
    const o = evaluateEligibility(
      input({
        posting: posting({
          term: { season: 'fall', year: 2027, start: '2027-08', end: '2027-12' },
        }),
      }),
    );
    expect(statusOf(o, 'term_overlap')).toBe('fail');
  });

  /**
   * Almost no real posting states explicit start/end dates — measured at 0 of 302 in a
   * live run. A season plus a year answers the only question this rule asks, so it is
   * used rather than surrendering to `unknown`.
   */
  it('derives a window from season and year when exact dates are absent', () => {
    const o = evaluateEligibility(
      input({ posting: posting({ term: { season: 'summer', year: 2027 } }) }),
    );
    expect(statusOf(o, 'term_overlap')).toBe('pass');
  });

  it('never hard-fails on an inferred window — it asks instead', () => {
    const o = evaluateEligibility(
      input({ posting: posting({ term: { season: 'winter', year: 2027 } }) }),
    );
    expect(statusOf(o, 'term_overlap')).toBe('unknown');
  });

  /**
   * `term.start`/`term.end` are not fields any job board publishes. They come from a regex
   * hunting the description for any "<month> <year> to <month> <year>" it can find, and that
   * regex cannot tell a term from an application window: "applications are accepted from
   * September 2026 through November 2026 for our Summer 2027 program" was stored as a term
   * of 2026-09..2026-11 and hard-failed every summer-2027 student on the deadline for the
   * very job they were reading about. The posting's own season and year say otherwise, so
   * the scraped window is a question at most.
   */
  it('does not hard-fail on a scraped window that contradicts the stated season', () => {
    const o = evaluateEligibility(
      input({
        posting: posting({
          term: { season: 'summer', year: 2027, start: '2026-09', end: '2026-11' },
        }),
      }),
    );
    expect(statusOf(o, 'term_overlap')).toBe('unknown');
    expect(o.blockers).toEqual([]);
  });

  /** With no season or year printed, there is nothing to confirm the scraped dates either. */
  it('does not hard-fail on a scraped window with nothing to corroborate it', () => {
    const o = evaluateEligibility(
      input({
        posting: posting({
          term: { season: null, year: null, start: '2026-09', end: '2026-11' },
        }),
      }),
    );
    expect(statusOf(o, 'term_overlap')).toBe('unknown');
    expect(o.blockers).toEqual([]);
  });

  /**
   * A posting naming a spring cohort and a summer one is naming alternatives, exactly as a
   * posting naming two graduation windows is. Judging a summer student against whichever
   * range was extracted most confidently told her she had no overlap with a term she was
   * free for the whole of.
   */
  it('measures against every term the posting states, not the first one', () => {
    const spring = req('term_dates', { start: '2027-01', end: '2027-03' }, { confidence: 0.95 });
    const summer = req('term_dates', { start: '2027-06', end: '2027-08' }, { confidence: 0.8 });

    for (const requirements of [
      [spring, summer],
      [summer, spring],
    ]) {
      const o = evaluateEligibility(
        input({ posting: posting({ term: { season: null, year: null } }), requirements }),
      );
      expect(statusOf(o, 'term_overlap'), JSON.stringify(requirements.map((r) => r.id))).toBe(
        'pass',
      );
    }
  });

  /**
   * A posting with no timing information at all is missing information about the
   * posting, not an unresolved question about the user. Marking it `unknown` badged
   * every row in a 302-posting run and made the badge meaningless.
   */
  it('is not applicable when the posting states no timing at all', () => {
    const o = evaluateEligibility(
      input({ posting: posting({ term: { season: null, year: null } }) }),
    );
    expect(statusOf(o, 'term_overlap')).toBe('not_applicable');
  });

  it('is unknown when the user has no availability window', () => {
    const o = evaluateEligibility(
      input({ profile: profile({ availability: { flexible: true } }) }),
    );
    expect(statusOf(o, 'term_overlap')).toBe('unknown');
  });

  it('computes overlap in weeks', () => {
    // June 1 to August 20, bounded by the availability end. The term end '2027-08' means
    // "through August", so it does not cut the window short.
    expect(
      overlapWeeks(
        { start: '2027-06', end: '2027-08' },
        { start: '2027-06-01', end: '2027-08-20' },
      ),
    ).toBeCloseTo(11.4, 0);

    expect(
      overlapWeeks(
        { start: '2027-09', end: '2027-12' },
        { start: '2027-06-01', end: '2027-08-20' },
      ),
    ).toBe(0);
  });

  it('reads a month-only term end as the END of that month', () => {
    // This was a real false-ineligible. Reading '2027-08' as August 1st threw away up to
    // a month of overlap and could push a genuinely eligible posting under the six-week
    // minimum. A July-to-September student against a June-to-August internship overlaps
    // by about seven and a half weeks, not three.
    const weeks = overlapWeeks(
      { start: '2027-06', end: '2027-08' },
      { start: '2027-07-10', end: '2027-09-30' },
    );
    expect(weeks).toBeGreaterThan(7);
    expect(weeks).toBeLessThan(8);
  });

  it('counts an end date as the whole of the day it names', () => {
    // An end bound is inclusive at both precisions: '2027-08' means through August, and
    // '2027-06-15' means through the 15th. This test used to read "does not widen a
    // day-precision date" and assert `toBeCloseTo(2, 0)`, which was true of a June 1–15
    // window under either reading — so it pinned nothing and hid the off-by-a-day. Ending
    // the window at midnight dropped the user's own last available day, and availability
    // is always day-precision: June 1 through July 12 is 6 weeks to the hour, and was
    // being refused against a 6-week minimum. 15 inclusive days, exactly.
    expect(
      overlapWeeks(
        { start: '2027-06-01', end: '2027-06-15' },
        { start: '2027-06-01', end: '2027-12-31' },
      ),
    ).toBeCloseTo(15 / 7, 5);
    expect(
      overlapWeeks(
        { start: '2027-06-01', end: '2027-07-12' },
        { start: '2027-06-01', end: '2027-07-12' },
      ),
    ).toBe(6);
  });
});

describe('deadline and open state', () => {
  it('fails a closed posting', () => {
    const o = evaluateEligibility(input({ posting: posting({ isOpen: false }) }));
    expect(statusOf(o, 'posting_open')).toBe('fail');
  });

  it('fails a past deadline', () => {
    const o = evaluateEligibility(
      input({ posting: posting({ closesAt: '2026-01-01T00:00:00Z' }) }),
    );
    expect(statusOf(o, 'deadline')).toBe('fail');
  });

  it('passes a future deadline', () => {
    const o = evaluateEligibility(
      input({ posting: posting({ closesAt: '2027-01-01T00:00:00Z' }) }),
    );
    expect(statusOf(o, 'deadline')).toBe('pass');
  });

  /**
   * USAJOBS and JSON-LD both hand over bare dates. Date.parse puts those at midnight UTC,
   * which closed the posting for the whole of its final day and told the user "Closed on
   * <today>" while the employer was still accepting applications.
   */
  it('treats a date-only deadline as the end of that day, not its first instant', () => {
    const o = evaluateEligibility(input({ posting: posting({ closesAt: '2026-08-03' }) }));
    expect(statusOf(o, 'deadline')).toBe('pass');
  });

  it('still fails the day after a date-only deadline', () => {
    const o = evaluateEligibility(input({ posting: posting({ closesAt: '2026-08-02' }) }));
    expect(statusOf(o, 'deadline')).toBe('fail');
  });
});

describe('experience_ceiling', () => {
  it('fails an "internship" demanding three years', () => {
    const o = evaluateEligibility(input({ requirements: [req('experience_years', { min: 3 })] }));
    expect(statusOf(o, 'experience_ceiling')).toBe('fail');
  });

  it('allows a one-year tolerance', () => {
    const o = evaluateEligibility(input({ requirements: [req('experience_years', { min: 1 })] }));
    expect(statusOf(o, 'experience_ceiling')).toBe('pass');
  });

  it('ignores experience listed as preferred', () => {
    const o = evaluateEligibility(
      input({ requirements: [req('experience_years', { min: 5 }, { necessity: 'preferred' })] }),
    );
    expect(statusOf(o, 'experience_ceiling')).toBe('pass');
  });

  /**
   * A job with no end date goes on accruing months while `profile.derived` stands still at
   * whatever it said the day the profile was last saved. Someone who had 1.6 years in
   * January and 2.2 by August was still judged on the 1.6 and turned away from a posting
   * asking for three, which the one-year tolerance would otherwise have let through.
   */
  it('counts experience accrued since the profile was last saved', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({
          experience: [
            {
              type: 'job',
              title: 'Developer',
              organization: 'X',
              startDate: '2024-06',
              bullets: [],
            },
          ],
          derived: { ...profile().derived, yearsProfessionalExperience: 1.6 },
        }),
        requirements: [req('experience_years', { min: 3 })],
      }),
    );
    expect(statusOf(o, 'experience_ceiling')).toBe('pass');
    expect(o.blockers).toEqual([]);
  });

  /** Several stated lengths are alternatives, and the lowest is the one that gates applying. */
  it('does not let one of several stated experience minimums decide the rule', () => {
    const senior = req('experience_years', { min: 5 }, { confidence: 0.95 });
    const toApply = req('experience_years', { min: 1 }, { confidence: 0.95 });

    for (const requirements of [
      [senior, toApply],
      [toApply, senior],
    ]) {
      const o = evaluateEligibility(input({ requirements }));
      expect(statusOf(o, 'experience_ceiling'), JSON.stringify(requirements.map((r) => r.id))).toBe(
        'unknown',
      );
      expect(o.blockers).toEqual([]);
    }
  });

  it('still fails an "internship" whose every stated minimum is out of reach', () => {
    const o = evaluateEligibility(
      input({
        requirements: [req('experience_years', { min: 5 }), req('experience_years', { min: 3 })],
      }),
    );
    expect(statusOf(o, 'experience_ceiling')).toBe('fail');
    expect(o.blockers[0]!.because).toContain('3 years');
  });
});

describe('excluded_company', () => {
  it('fails a company on the exclude list', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({
          preferences: { companySizes: [], industries: [], excludeCompanies: ['acme'] },
        }),
      }),
    );
    expect(statusOf(o, 'excluded_company')).toBe('fail');
  });

  /**
   * An entry used to match anywhere in the company name, so short entries buried companies
   * the user had never heard of and could not find in their own settings: "Meta" hid
   * Metabase, "AI" hid Airbnb and Chainalysis, one "X" hid Netflix.
   */
  it('does not match an exclude-list entry in the middle of another company name', () => {
    for (const [entry, company] of [
      ['Meta', 'Metabase'],
      ['AI', 'Airbnb'],
      ['AI', 'Chainalysis'],
      ['X', 'Netflix'],
    ]) {
      const o = evaluateEligibility(
        input({
          profile: profile({
            preferences: { companySizes: [], industries: [], excludeCompanies: [entry!] },
          }),
          posting: posting({ company: company! }),
        }),
      );
      expect(statusOf(o, 'excluded_company'), `${entry} vs ${company}`).toBe('pass');
    }
  });

  /** Excluding a company still excludes its subsidiaries — whole words, not whole names. */
  it('still matches an entry that is a whole word of the company name', () => {
    for (const [entry, company] of [
      ['Amazon', 'Amazon Web Services'],
      ['Meta', 'Meta Platforms'],
      ['IBM', 'IBM'],
    ]) {
      const o = evaluateEligibility(
        input({
          profile: profile({
            preferences: { companySizes: [], industries: [], excludeCompanies: [entry!] },
          }),
          posting: posting({ company: company! }),
        }),
      );
      expect(statusOf(o, 'excluded_company'), `${entry} vs ${company}`).toBe('fail');
    }
  });
});

describe('overall verdict', () => {
  it('is eligible when everything passes', () => {
    expect(evaluateEligibility(input()).eligibility).toBe('eligible');
  });

  it('is unknown when anything is unresolved and nothing fails', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ dateOfBirth: null, derived: { ...profile().derived, age: null } }),
        requirements: [req('age', { min: 18 })],
      }),
    );
    expect(o.eligibility).toBe('unknown');
  });

  it('is ineligible as soon as one rule fails, even with unknowns present', () => {
    // The unfamiliar city is what makes this test earn its name: it puts a real `unknown`
    // alongside the closed posting's `fail`. Without it the scenario had no unknown in it
    // at all, so reordering the verdict to check unknowns first would have badged a
    // plainly disqualifying posting "unknown" and left this test green.
    const o = evaluateEligibility(
      input({
        posting: posting({
          isOpen: false,
          term: { season: 'summer', year: 2027 },
          locations: [{ city: 'Austin', region: 'TX', country: 'US', remote: false }],
        }),
      }),
    );
    expect(statusOf(o, 'location')).toBe('unknown');
    expect(o.rules.some((r) => r.status === 'unknown')).toBe(true);
    expect(o.eligibility).toBe('ineligible');
  });
});

// ────────────────────────────────────────────────────────────── properties

describe('properties that must always hold', () => {
  const scenarios: RuleInput[] = [
    input(),
    input({ requirements: [req('age', { min: 21 })] }),
    input({ requirements: [req('experience_years', { min: 8 })] }),
    input({ posting: posting({ isOpen: false }) }),
    input({ posting: posting({ closesAt: '2020-01-01T00:00:00Z' }) }),
    input({
      profile: profile({ derived: { ...profile().derived, age: null } }),
      requirements: [req('age', { min: 18 })],
    }),
    input({ requirements: [req('citizenship', { countries: ['JP'] })] }),
    input({ requirements: [req('education_level', { levels: ['doctorate'] })] }),
    input({
      profile: profile({
        preferences: { companySizes: [], industries: [], excludeCompanies: ['acme'] },
      }),
    }),
  ];

  /** An exclusion the user cannot inspect is indistinguishable from a bug. */
  it('never fails without citing a requirement or posting evidence', () => {
    for (const s of scenarios) {
      for (const r of evaluateEligibility(s).rules) {
        if (r.status === 'fail') {
          expect(
            Boolean(r.requirementId) || Boolean(r.evidence),
            `${r.rule} failed with no citation`,
          ).toBe(true);
          expect(r.because.length).toBeGreaterThan(10);
        }
      }
    }
  });

  it('always returns exactly one result per rule', () => {
    for (const s of scenarios) {
      const o = evaluateEligibility(s);
      expect(o.rules).toHaveLength(RULES.length);
      expect(new Set(o.rules.map((r) => r.rule)).size).toBe(RULES.length);
    }
  });

  /**
   * Missing information must never manufacture a rejection. This is the single most
   * important property here: it is what stops the tool hiding a job because it didn't
   * understand the posting.
   */
  it('never turns missing data into a failure', () => {
    const blank = input({
      profile: profile({
        dateOfBirth: null,
        citizenships: [],
        availability: { flexible: true },
        workAuthorization: { country: 'US', status: 'unknown', needsSponsorship: false },
        derived: {
          age: null,
          isMinor: false,
          academicLevel: 'none',
          academicYear: null,
          expectedGraduation: null,
          yearsProfessionalExperience: 0,
          seniorityBand: 'entry_intern',
        },
      }),
      posting: posting({
        locations: [],
        workArrangement: null,
        term: { season: null, year: null },
      }),
      requirements: [
        req('age', { min: 18 }),
        req('education_level', { levels: ['bachelor'] }),
        req('graduation_window', { from: '2027-01', to: '2028-12' }),
        req('work_auth', { sponsorshipUnavailable: true }),
        req('citizenship', { countries: ['US'] }),
        req('enrollment', { required: true }),
      ],
    });

    const o = evaluateEligibility(blank);
    expect(o.blockers).toEqual([]);
    expect(o.eligibility).toBe('unknown');
  });

  /**
   * A posting that says it would merely like something has already told the user they may
   * apply without it, and the extraction prompt promises the model that `unclear` is
   * non-blocking. Both promises were kept by the experience rule and by no other, so
   * "Master's preferred", "U.S. citizens preferred" and "preferably still enrolled" each
   * hard-failed the very people the sentence was written to include. This walks every rule
   * that reads a requirement, against a user who fails all of them on the merits.
   */
  it('never fails on a requirement the posting did not insist on', () => {
    const stated: Array<[string, unknown]> = [
      ['age', { min: 21 }],
      ['education_level', { levels: ['doctorate'] }],
      ['graduation_window', { from: '2029-01', to: '2030-06' }],
      ['enrollment', { required: true }],
      ['work_auth', { sponsorshipUnavailable: true }],
      ['citizenship', { countries: ['JP'] }],
      ['experience_years', { min: 8 }],
    ];

    const qualifiesForNothing = profile({
      citizenships: ['IN'],
      // The date of birth has to agree with the derived age: the age rule recomputes it
      // against the clock it is handed rather than trusting a figure frozen at the last save.
      dateOfBirth: '2010-03-15',
      workAuthorization: { country: 'US', status: 'requires_sponsorship', needsSponsorship: true },
      derived: {
        ...profile().derived,
        age: 16,
        isMinor: true,
        academicLevel: 'high_school',
        expectedGraduation: '2025-05',
      },
    });

    for (const [kind, value] of stated) {
      for (const necessity of ['preferred', 'unclear'] as const) {
        const o = evaluateEligibility(
          input({ profile: qualifiesForNothing, requirements: [req(kind, value, { necessity })] }),
        );
        expect(o.blockers, `${kind} stated as ${necessity}`).toEqual([]);
      }

      // The same fact stated as a rule must still be able to disqualify, or the check
      // above would pass for the wrong reason.
      const firm = evaluateEligibility(
        input({ profile: qualifiesForNothing, requirements: [req(kind, value)] }),
      );
      expect(firm.blockers.length, `${kind} stated as required`).toBeGreaterThan(0);
    }
  });

  /**
   * Filling in a profile field can only ever resolve an unknown. If adding information
   * could newly disqualify you, the rules would be punishing you for being complete.
   */
  it('adding profile information never turns eligible into ineligible', () => {
    const sparse = input({
      profile: profile({
        derived: { ...profile().derived, age: null, expectedGraduation: null },
      }),
      requirements: [req('age', { min: 18 }), req('graduation_window', { from: '2027-01' })],
    });
    const before = evaluateEligibility(sparse);
    expect(before.eligibility).not.toBe('eligible');

    const filled = evaluateEligibility({
      ...sparse,
      profile: profile({
        derived: { ...profile().derived, age: 20, expectedGraduation: '2028-05' },
      }),
    });
    expect(filled.eligibility).toBe('eligible');
  });

  /**
   * The case above goes unknown → eligible, which does not test the property it is named
   * for: it cannot catch a rule that flips an ALREADY-eligible verdict to ineligible when
   * a field is filled in. This one starts from eligible and adds facts one at a time.
   *
   * Only facts that genuinely cannot disqualify are added. Two rules legitimately turn
   * pass into fail on new information — stating a citizenship the posting excludes, or a
   * work-authorization status that needs sponsorship the employer does not offer — and
   * those are correct behaviour rather than exceptions to hide.
   */
  it('stays eligible as neutral profile facts are filled in one by one', () => {
    const base = input({
      profile: profile({
        derived: { ...profile().derived, age: null, expectedGraduation: null },
      }),
      requirements: [],
    });
    expect(evaluateEligibility(base).eligibility).toBe('eligible');

    const additions: Array<[string, Partial<ConfirmedProfile>]> = [
      ['dateOfBirth', { dateOfBirth: '2006-03-15' }],
      ['derived.age', { derived: { ...profile().derived, age: 20 } }],
      [
        'derived.expectedGraduation',
        { derived: { ...profile().derived, age: 20, expectedGraduation: '2028-05' } },
      ],
      ['availability', { availability: profile().availability }],
      ['citizenships', { citizenships: ['US'] }],
    ];

    let acc = base.profile;
    for (const [what, patch] of additions) {
      acc = { ...acc, ...patch } as ConfirmedProfile;
      const o = evaluateEligibility({ ...base, profile: acc });
      expect(o.eligibility, `became ${o.eligibility} after adding ${what}`).toBe('eligible');
    }
  });

  it('is deterministic for identical input', () => {
    for (const s of scenarios) {
      expect(evaluateEligibility(s)).toEqual(evaluateEligibility(s));
    }
  });
});
