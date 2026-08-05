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
        profile: profile({ derived: { ...profile().derived, age: 16, isMinor: true } }),
        requirements: [req('age', { min: 18 })],
      }),
    );
    expect(statusOf(o, 'age_minimum')).toBe('fail');
    expect(o.eligibility).toBe('ineligible');
    expect(o.blockers[0]!.because).toMatch(/16.*18/);
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
   */
  it('does not fail a posting that offers remote alongside a city the user lives in', () => {
    const o = evaluateEligibility(
      input({
        profile: profile({ locationPrefs: { ...profile().locationPrefs, remoteOk: false } }),
        posting: posting({
          workArrangement: null,
          locations: [{ city: 'Boston', region: 'MA', country: 'US', remote: true }],
        }),
      }),
    );
    expect(statusOf(o, 'location')).toBe('pass');
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

  it('does not widen a day-precision date', () => {
    // Only month-only bounds are ambiguous; an exact date is already exact.
    expect(
      overlapWeeks(
        { start: '2027-06-01', end: '2027-06-15' },
        { start: '2027-06-01', end: '2027-12-31' },
      ),
    ).toBeCloseTo(2, 0);
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
    const o = evaluateEligibility(
      input({
        posting: posting({ isOpen: false, term: { season: 'summer', year: 2027 } }),
      }),
    );
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

  it('is deterministic for identical input', () => {
    for (const s of scenarios) {
      expect(evaluateEligibility(s)).toEqual(evaluateEligibility(s));
    }
  });
});
