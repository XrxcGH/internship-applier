import { describe, expect, it } from 'vitest';
import { CandidateProfile } from '@ia/shared';
import type { ResumeExtraction } from '../src/core/ingestion/extractProfile';
import { toDraftProfile } from '../src/core/ingestion/toProfile';
import {
  ageFrom,
  deriveAcademicLevel,
  deriveExpectedGraduation,
  deriveProfile,
  deriveSeniorityBand,
  deriveYearsExperience,
  hasDualEnrollment,
} from '../src/core/ingestion/deriveFields';

const NOW = new Date('2026-08-03T00:00:00Z');

function profile(over: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    id: 'p1',
    fullName: 'A',
    email: 'a@b.c',
    dateOfBirth: null,
    address: { country: 'US' },
    links: { other: [] },
    workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
    citizenships: [],
    education: [],
    experience: [],
    projects: [],
    skills: [],
    certifications: [],
    languages: [],
    availability: { flexible: true },
    locationPrefs: {
      base: { city: 'X', region: 'Y', country: 'US' },
      maxCommuteKm: 50,
      remoteOk: true,
      hybridOk: true,
      relocateTo: [],
    },
    preferences: { companySizes: [], industries: [], excludeCompanies: [] },
    derived: {
      age: null,
      isMinor: false,
      academicLevel: 'none',
      academicYear: null,
      expectedGraduation: null,
      yearsProfessionalExperience: 0,
      seniorityBand: 'entry_intern',
    },
    confirmedAt: null,
    needsReview: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  } as CandidateProfile;
}

describe('ageFrom', () => {
  it('does not round up before the birthday', () => {
    expect(ageFrom('2008-08-04', NOW)).toBe(17);
    expect(ageFrom('2008-08-03', NOW)).toBe(18);
    expect(ageFrom('2008-08-02', NOW)).toBe(18);
  });

  it('returns null rather than guessing', () => {
    expect(ageFrom(null, NOW)).toBeNull();
    expect(ageFrom('not-a-date', NOW)).toBeNull();
    expect(ageFrom('2099-01-01', NOW)).toBeNull();
  });
});

describe('isMinor', () => {
  /**
   * A missing DOB must not read as adult. An 18+ posting has to come back `unknown`
   * and ask, not silently pass or silently filter.
   */
  it('is false for an unknown age, but age stays null so rules can see the gap', () => {
    const d = deriveProfile(profile(), NOW);
    expect(d.age).toBeNull();
    expect(d.isMinor).toBe(false);
  });

  it('flags an actual minor', () => {
    expect(deriveProfile(profile({ dateOfBirth: '2010-01-01' }), NOW).isMinor).toBe(true);
  });
});

describe('academic level and graduation', () => {
  /**
   * The fixture here used to carry no dates at all on either entry, which meant it was not
   * testing the ordering it names: it was pinning the answer `degreeBearing` gives when the
   * high school says nothing about when it ran, and that answer was a guess. See
   * 'sets a college entry aside when the high-school line carries no dates' below for why
   * the guess had to go. Both entries are dated now, so the assertion is about rank.
   */
  it('takes the most advanced degree, not the first listed', () => {
    const p = profile({
      education: [
        {
          institution: 'HS',
          level: 'high_school',
          startDate: '2018-09',
          endDate: '2022-06',
          coursework: [],
          honors: [],
        },
        {
          institution: 'U',
          level: 'bachelor',
          startDate: '2022-09',
          endDate: '2026-05',
          coursework: [],
          honors: [],
        },
      ],
    });
    expect(deriveAcademicLevel(p, NOW)).toBe('undergrad');
  });

  it('uses the latest end date as expected graduation', () => {
    const p = profile({
      education: [
        { institution: 'HS', level: 'high_school', endDate: '2025-06', coursework: [], honors: [] },
        { institution: 'U', level: 'bachelor', endDate: '2029-05', coursework: [], honors: [] },
      ],
    });
    expect(deriveExpectedGraduation(p, NOW)).toBe('2029-05');
  });
});

// ─────────────────────────────────────────── programmes that are still running

type Ed = CandidateProfile['education'][number];
const ed = (o: Partial<Ed> & { institution: string; level: Ed['level'] }): Ed =>
  ({ coursework: [], honors: [], ...o }) as Ed;
const schooling = (...education: Ed[]) => profile({ education });

/**
 * An education entry with NO end date is a programme in progress. That is exactly what
 * extraction emits for "Lincoln High School, Aug 2023 - Present", and dropping such an
 * entry because there was no date to compare let a FINISHED sibling entry's past date be
 * published as the person's graduation.
 *
 * It cost three different students the same way. A dual-enrollment high schooler was given
 * his community college's May-2026 semester and banded new_grad. A rising freshman with a
 * bare "Ohio State University" line was given his high school's June-2026 date. An
 * ordinary undergraduate whose university line read "Sep 2023 - Present" was given his high
 * school's 2023-06. Every one of them was then told they had already graduated and hard
 * failed on "must be currently enrolled" and on every later graduation window, and there is
 * no override for an ineligible posting.
 */
describe('an education entry with no end date', () => {
  it('withholds the graduation date instead of borrowing a finished entry’s', () => {
    for (const [what, p] of [
      [
        'dual-enrollment high schooler, "Aug 2023 - Present"',
        schooling(
          ed({ institution: 'Lincoln High', level: 'high_school', startDate: '2023-08' }),
          ed({
            institution: 'Sinclair CC',
            level: 'associate',
            startDate: '2025-08',
            endDate: '2026-05',
          }),
        ),
      ],
      [
        'rising freshman, bachelor entry with no dates at all',
        schooling(
          ed({
            institution: 'Central High',
            level: 'high_school',
            startDate: '2022-09',
            endDate: '2026-06',
          }),
          ed({ institution: 'Ohio State University', level: 'bachelor' }),
        ),
      ],
      [
        'rising freshman, bachelor "Aug 2026 - Present"',
        schooling(
          ed({
            institution: 'Central High',
            level: 'high_school',
            startDate: '2022-09',
            endDate: '2026-06',
          }),
          ed({ institution: 'Ohio State University', level: 'bachelor', startDate: '2026-08' }),
        ),
      ],
      [
        'ordinary undergraduate, university "Sep 2023 - Present"',
        schooling(
          ed({
            institution: 'Central High',
            level: 'high_school',
            startDate: '2019-09',
            endDate: '2023-06',
          }),
          ed({ institution: 'State U', level: 'bachelor', startDate: '2023-09' }),
        ),
      ],
      [
        'masters in progress beside a finished bachelor',
        schooling(
          ed({
            institution: 'State U',
            level: 'bachelor',
            startDate: '2019-09',
            endDate: '2023-05',
          }),
          ed({ institution: 'State U', level: 'master', startDate: '2025-09' }),
        ),
      ],
    ] as const) {
      expect(deriveExpectedGraduation(p, NOW), what).toBeNull();
      expect(deriveProfile(p, NOW).seniorityBand, what).not.toBe('new_grad');
    }
  });

  /**
   * The opposite direction, which is the half a narrow fix would have broken. An open entry
   * that a HIGHER, dated level has already settled cannot withhold anything: high school
   * finished before the bachelor's did, whenever it was. Returning null for these would
   * badge a whole queue of postings amber for people whose graduation date is not in doubt.
   */
  it('still answers when a higher, dated level has settled the question', () => {
    // The open high school here carries a START date, which is what lets the answer stand:
    // MAX_HIGH_SCHOOL_MONTHS reads a school begun in 2012 and still open as a missing end
    // date, and the degree beside it is finished, so nothing is running that the resume
    // has failed to place. Strip that start date and the answer is withheld instead — see
    // the test below.
    const openHighSchool = schooling(
      ed({ institution: 'Central High', level: 'high_school', startDate: '2012-09' }),
      ed({ institution: 'State U', level: 'bachelor', startDate: '2016-09', endDate: '2020-05' }),
    );
    expect(deriveExpectedGraduation(openHighSchool, NOW)).toBe('2020-05');
    expect(deriveProfile(openHighSchool, NOW).seniorityBand).toBe('new_grad');

    const undatedBachelor = schooling(
      ed({ institution: 'State U', level: 'bachelor' }),
      ed({ institution: 'State U', level: 'master', startDate: '2021-09', endDate: '2023-05' }),
    );
    expect(deriveExpectedGraduation(undatedBachelor, NOW)).toBe('2023-05');

    // And a fully dated history is untouched, including one that is entirely in the future.
    const future = schooling(
      ed({
        institution: 'Central High',
        level: 'high_school',
        startDate: '2022-09',
        endDate: '2026-06',
      }),
      ed({ institution: 'State U', level: 'bachelor', startDate: '2026-09', endDate: '2030-05' }),
    );
    expect(deriveExpectedGraduation(future, NOW)).toBe('2030-05');
  });

  /**
   * A dated sibling settles an open entry only if it BOTH outranks it and ends after the
   * open entry began. Rank alone was enough, and that dropped an in-progress programme
   * ranking below a finished one: a nursing associate begun 2025-09 was silently discarded
   * in favour of a bachelor's finished 2024-05, the graduate was published as having
   * graduated, and a current-students-only posting returned `ineligible` against a
   * programme he is sitting in right now — the false red this file exists to prevent, in
   * the one family a rank test does not reach.
   */
  it('does not let a finished higher degree speak for a lower programme begun after it', () => {
    const nursing = schooling(
      ed({ institution: 'State U', level: 'bachelor', startDate: '2020-09', endDate: '2024-05' }),
      ed({ institution: 'Valley CC', level: 'associate', startDate: '2025-09' }),
    );
    expect(deriveExpectedGraduation(nursing, NOW)).toBeNull();
    expect(deriveProfile(nursing, NOW).seniorityBand).not.toBe('new_grad');

    // The settled direction is untouched: the associate here ended before the bachelor
    // began, so the bachelor's date is the answer and nothing is withheld.
    const finishedFirst = schooling(
      ed({
        institution: 'Valley CC',
        level: 'associate',
        startDate: '2018-09',
        endDate: '2020-05',
      }),
      ed({ institution: 'State U', level: 'bachelor' }),
      ed({ institution: 'State U', level: 'master', startDate: '2021-09', endDate: '2023-05' }),
    );
    expect(deriveExpectedGraduation(finishedFirst, NOW)).toBe('2023-05');
  });

  /**
   * The same false red one rank across. "At least as high" let a sibling of the SAME level
   * settle an open entry, and finishing one bachelor's says nothing about when a second one
   * finishes: a transfer student listing "State U 2020-09 - 2024-05" beside "State U
   * 2023-09 - Present" was published as having graduated 2024-05 and returned `ineligible`
   * on a current-students-only posting, while `academicYear` on the same object said he was
   * sitting in year 3 of a programme. Only a HIGHER level proves the open one is behind it.
   */
  it('does not let a finished degree speak for a second one of the same level', () => {
    const transfer = schooling(
      ed({ institution: 'State U', level: 'bachelor', startDate: '2020-09', endDate: '2024-05' }),
      ed({ institution: 'Other U', level: 'bachelor', startDate: '2023-09' }),
    );
    expect(deriveExpectedGraduation(transfer, NOW)).toBeNull();
    expect(deriveProfile(transfer, NOW).seniorityBand).not.toBe('new_grad');

    // Same level, and this time the open entry carries no dates at all — there is even less
    // on the page to settle it with.
    const undated = schooling(
      ed({ institution: 'State U', level: 'bachelor', startDate: '2020-09', endDate: '2024-05' }),
      ed({ institution: 'Other U', level: 'bachelor' }),
    );
    expect(deriveExpectedGraduation(undated, NOW)).toBeNull();

    // And the settle a HIGHER level licenses is untouched: high school finished before the
    // degree that followed it did, whenever it was, so 2020-05 is still published and an
    // adult eight years out of college is still refused a current-students-only posting.
    const leftLongAgo = schooling(
      ed({ institution: 'Central High', level: 'high_school', startDate: '2012-09' }),
      ed({ institution: 'State U', level: 'bachelor', startDate: '2016-09', endDate: '2020-05' }),
    );
    expect(deriveExpectedGraduation(leftLongAgo, NOW)).toBe('2020-05');
  });

  /**
   * See MAX_HIGH_SCHOOL_MONTHS. An adult who never wrote down when they left school emits
   * the same "no end date" shape as a student sitting in one, and reading it as an enrolment
   * would pin them at academicLevel high_school and refuse every degree requirement.
   */
  it('does not read a decade-old open high-school line as an enrolment', () => {
    const p = schooling(
      ed({ institution: 'Central High', level: 'high_school', startDate: '2012-09' }),
      ed({ institution: 'State U', level: 'bachelor', startDate: '2016-09', endDate: '2020-05' }),
    );
    expect(deriveAcademicLevel(p, NOW)).toBe('undergrad');
    expect(deriveExpectedGraduation(p, NOW)).toBe('2020-05');
  });
});

// ─────────────────────────────────────────── dual enrollment

/**
 * College coursework taken alongside high school does not make its owner an undergraduate.
 * The seniority band knew that; academicLevel did not, and academicLevel is what the
 * education_level eligibility rule reads. A 16-year-old high-school junior came back band
 * `pre_college` and level `undergrad` at the same time, and a posting reading "must be
 * pursuing a Bachelor's degree" told him "Your level (bachelor) meets the requirement" with
 * a green tick beside it.
 */
describe('dual enrollment', () => {
  const stillInSchool = schooling(
    ed({
      institution: 'Sample High School',
      level: 'high_school',
      startDate: '2023-08',
      endDate: '2027-06',
    }),
    ed({
      institution: 'Valley Community College',
      level: 'associate',
      startDate: '2025-09',
      endDate: '2027-06',
    }),
  );

  const openEndedHighSchool = schooling(
    ed({ institution: 'Lincoln High', level: 'high_school', startDate: '2023-08' }),
    ed({
      institution: 'Sinclair CC',
      level: 'associate',
      startDate: '2025-08',
      endDate: '2026-05',
    }),
  );

  const leaver = schooling(
    ed({
      institution: 'Central High',
      level: 'high_school',
      startDate: '2022-09',
      endDate: '2026-06',
    }),
    ed({ institution: 'Valley CC', level: 'associate', startDate: '2024-09', endDate: '2026-06' }),
  );

  it('does not promote a high schooler to undergrad on a community-college entry', () => {
    for (const [what, p] of [
      ['high school still running, dated', stillInSchool],
      ['high school still running, open ended', openEndedHighSchool],
      ['both finished in the same month', leaver],
    ] as const) {
      expect(deriveAcademicLevel(p, NOW), what).toBe('high_school');
      expect(hasDualEnrollment(p, NOW), what).toBe(true);
      expect(deriveProfile(p, NOW).seniorityBand, what).toBe('pre_college');
    }
  });

  it('reports the high-school year, not year one of the concurrent coursework', () => {
    // Reporting "academicYear 1" beside "academicLevel high_school" put a contradiction
    // about the person into the profile, and the privacy export carries it verbatim.
    expect(deriveProfile(stillInSchool, NOW).academicYear).toBe(4);
    expect(deriveProfile(openEndedHighSchool, NOW).academicYear).toBe(4);
  });

  /**
   * The other direction: a real degree earned AFTER high school still promotes, or the fix
   * would have hidden every posting from every genuine community-college student.
   */
  it('still promotes a degree that outlasts the high school', () => {
    const realAssociate = schooling(
      ed({
        institution: 'Central High',
        level: 'high_school',
        startDate: '2020-09',
        endDate: '2024-06',
      }),
      ed({
        institution: 'Valley CC',
        level: 'associate',
        startDate: '2024-09',
        endDate: '2026-05',
      }),
    );
    expect(deriveAcademicLevel(realAssociate, NOW)).toBe('undergrad');
    expect(hasDualEnrollment(realAssociate, NOW)).toBe(false);
    expect(deriveExpectedGraduation(realAssociate, NOW)).toBe('2026-05');

    const bachelorAfterSchool = schooling(
      ed({
        institution: 'Central High',
        level: 'high_school',
        startDate: '2021-08',
        endDate: '2025-05',
      }),
      ed({ institution: 'UCLA', level: 'bachelor', startDate: '2025-09', endDate: '2029-06' }),
    );
    expect(deriveAcademicLevel(bachelorAfterSchool, NOW)).toBe('undergrad');
    expect(hasDualEnrollment(bachelorAfterSchool, NOW)).toBe(false);
  });

  /**
   * THE GUARD MAY NOT DEPEND ON THE HIGH SCHOOL CARRYING DATES. Every entry point into the
   * version this replaces needed one, and a high-school line with no dates on it is the
   * commonest way a 16-year-old writes his own school down — `toDraftProfile` emits exactly
   * that shape, with `startDate` and `endDate` simply absent. It switched the whole guard
   * off, and both halves of the failure came back on one profile: "Lincoln High School"
   * undated beside "Valley Community College, Sep 2025 - Jun 2027" derived as `undergrad`,
   * was told "Your level (bachelor) meets the requirement" on a posting demanding a
   * Bachelor's, and was then returned `ineligible` on a class-of-2030 window measured
   * against the community college's semester. Nothing in needsReview asked for the dates.
   *
   * The undated school cannot say the coursework ran alongside it, and cannot say it ran
   * after it either. Withholding is the answer the rules are built to receive: it produces
   * `unknown`, which blocks nobody, where either guess blocks somebody.
   */
  it('sets a college entry aside when the high-school line carries no dates', () => {
    for (const [what, p] of [
      [
        'no dates at all, community college still running',
        schooling(
          ed({ institution: 'Lincoln High School', level: 'high_school' }),
          ed({
            institution: 'Valley Community College',
            level: 'associate',
            startDate: '2025-09',
            endDate: '2027-06',
          }),
        ),
      ],
      [
        'no dates at all, a named university beside it',
        schooling(
          ed({ institution: 'Lincoln High School', level: 'high_school' }),
          ed({
            institution: 'Ohio State University',
            level: 'bachelor',
            startDate: '2025-09',
            endDate: '2029-06',
          }),
        ),
      ],
      [
        'no dates on either entry',
        schooling(
          ed({ institution: 'Lincoln High School', level: 'high_school' }),
          ed({ institution: 'Valley CC', level: 'associate' }),
        ),
      ],
      [
        // One month past MAX_HIGH_SCHOOL_MONTHS. The cap reads a missing end date as a
        // missing date rather than a desk still warm, and that reading settles entries the
        // resume puts in the past — not one that is still running today beside a school
        // line that, being open, also claims to be running today.
        'open-ended high school past the cap, coursework still running',
        schooling(
          ed({ institution: 'Lincoln High School', level: 'high_school', startDate: '2021-06' }),
          ed({
            institution: 'Valley CC',
            level: 'associate',
            startDate: '2025-09',
            endDate: '2027-06',
          }),
        ),
      ],
    ] as const) {
      expect(deriveAcademicLevel(p, NOW), what).toBe('high_school');
      expect(hasDualEnrollment(p, NOW), what).toBe(true);
      const d = deriveProfile(p, NOW);
      expect(d.expectedGraduation, what).toBeNull();
      expect(d.seniorityBand, what).toBe('pre_college');
      // "Year 6 of high school" is a mistyped start date, not a fact about the person, and
      // the privacy export prints whatever lands here verbatim.
      expect(d.academicYear === null || d.academicYear <= 5, what).toBe(true);
    }
  });

  /**
   * The opposite direction, and the one the previous repair broke: while the high school was
   * running it discarded EVERY other entry with no test that the entry overlapped it. A
   * senior who has already written down the university he starts in the autumn — the
   * ordinary rising-freshman resume — had that university deleted from the derivation, was
   * published with his 2027-06 school date as his graduation, and a class-of-2031 posting he
   * plainly matches went from pass to "add the programme you are going on to", which he had.
   */
  it('keeps a degree that starts after the high school ends, while school is still running', () => {
    const senior = schooling(
      ed({
        institution: 'Lincoln High',
        level: 'high_school',
        startDate: '2023-08',
        endDate: '2027-06',
      }),
      ed({
        institution: 'Ohio State University',
        level: 'bachelor',
        startDate: '2027-08',
        endDate: '2031-05',
      }),
    );
    expect(deriveAcademicLevel(senior, NOW)).toBe('undergrad');
    expect(hasDualEnrollment(senior, NOW)).toBe(false);
    expect(deriveExpectedGraduation(senior, NOW)).toBe('2031-05');
    // He is still sitting in a high-school classroom, whatever the level says.
    expect(deriveProfile(senior, NOW).seniorityBand).toBe('pre_college');
    // And "year 4" beside "undergrad" would say he is a college senior. The programme the
    // level speaks for has not started, so he is in no year of it.
    expect(deriveProfile(senior, NOW).academicYear).toBeNull();

    // The same resume read one month after school ends must not answer differently: a
    // verdict that turns over on the calendar rather than on the resume is a verdict the
    // student cannot act on.
    const later = new Date('2027-07-03T00:00:00Z');
    expect(deriveExpectedGraduation(senior, later)).toBe('2031-05');
  });
});

// ─────────────────────────────────────────── the whole young population

/**
 * Every young shape this tool exists for, swept at once. None of them has finished college,
 * so none may be banded `new_grad`, and none whose date of birth is on file and under 18 may
 * come back as anything but a minor. The dual-enrollment case used to fail both halves.
 */
describe('young applicants', () => {
  const cases: Array<[string, CandidateProfile]> = [
    [
      '14-year-old rising freshman',
      profile({
        dateOfBirth: '2012-03-01',
        education: [
          ed({ institution: 'Lincoln High', level: 'high_school', startDate: '2026-08' }),
        ],
      }),
    ],
    [
      '15-year-old sophomore',
      profile({
        dateOfBirth: '2011-01-20',
        education: [
          ed({
            institution: 'Lincoln High',
            level: 'high_school',
            startDate: '2025-08',
            endDate: '2029-06',
          }),
        ],
      }),
    ],
    [
      '17-year-old senior graduating in three months',
      profile({
        dateOfBirth: '2008-12-01',
        education: [
          ed({
            institution: 'Lincoln High',
            level: 'high_school',
            startDate: '2023-08',
            endDate: '2026-11',
          }),
        ],
      }),
    ],
    [
      '17-year-old dual-enrollment junior with two live entries',
      profile({
        dateOfBirth: '2009-05-01',
        education: [
          ed({ institution: 'Lincoln High', level: 'high_school', startDate: '2023-08' }),
          ed({
            institution: 'Sinclair CC',
            level: 'associate',
            startDate: '2025-08',
            endDate: '2026-05',
          }),
        ],
      }),
    ],
    [
      'rising college freshman in the gap between schools',
      profile({
        dateOfBirth: '2008-04-01',
        education: [
          ed({
            institution: 'Central High',
            level: 'high_school',
            startDate: '2022-09',
            endDate: '2026-06',
          }),
        ],
      }),
    ],
    [
      'gap-year student',
      profile({
        dateOfBirth: '2007-04-01',
        education: [
          ed({
            institution: 'Central High',
            level: 'high_school',
            startDate: '2021-09',
            endDate: '2025-06',
          }),
        ],
      }),
    ],
    [
      'no dateOfBirth at all',
      profile({
        education: [
          ed({ institution: 'Lincoln High', level: 'high_school', startDate: '2023-08' }),
        ],
      }),
    ],
    [
      'an entry that has not started yet',
      profile({
        dateOfBirth: '2008-04-01',
        education: [
          ed({
            institution: 'Central High',
            level: 'high_school',
            startDate: '2022-09',
            endDate: '2026-06',
          }),
          ed({
            institution: 'State U',
            level: 'bachelor',
            startDate: '2026-09',
            endDate: '2030-05',
          }),
        ],
      }),
    ],
    ['no education entries at all', profile({ dateOfBirth: '2008-04-01' })],
  ];

  it('bands none of them as a new graduate', () => {
    for (const [what, p] of cases) {
      expect(deriveProfile(p, NOW).seniorityBand, what).not.toBe('new_grad');
    }
  });

  it('never derives a minor as an adult', () => {
    for (const [what, p] of cases) {
      const d = deriveProfile(p, NOW);
      const age = ageFrom(p.dateOfBirth, NOW);
      expect(d.age, what).toBe(age);
      expect(d.isMinor, what).toBe(age !== null && age < 18);
      // A missing date of birth must not read as adult either: `age` stays null so the
      // age_minimum rule can see the gap and ask.
      if (age === null) expect(d.age, what).toBeNull();
    }
  });

  it('produces a graduation date only where one is actually knowable', () => {
    const grads = Object.fromEntries(
      cases.map(([what, p]) => [what, deriveProfile(p, NOW).expectedGraduation]),
    );
    expect(grads).toEqual({
      '14-year-old rising freshman': null,
      '15-year-old sophomore': '2029-06',
      '17-year-old senior graduating in three months': '2026-11',
      '17-year-old dual-enrollment junior with two live entries': null,
      'rising college freshman in the gap between schools': '2026-06',
      'gap-year student': '2025-06',
      'no dateOfBirth at all': null,
      'an entry that has not started yet': '2030-05',
      'no education entries at all': null,
    });
  });
});

describe('years of experience', () => {
  it('weights internships at half and ignores clubs', () => {
    const p = profile({
      experience: [
        {
          organization: 'A',
          title: 'SWE Intern',
          type: 'internship',
          startDate: '2025-06',
          endDate: '2025-08',
          bullets: [],
        },
        {
          organization: 'B',
          title: 'Treasurer',
          type: 'club',
          startDate: '2024-09',
          endDate: '2026-05',
          bullets: [],
        },
      ],
    });
    // 2 months of internship at 0.5 weight = 1 month = 0.1 years.
    expect(deriveYearsExperience(p, NOW)).toBeCloseTo(0.1, 5);
  });

  it('treats a missing end date as ongoing', () => {
    const p = profile({
      experience: [
        {
          organization: 'A',
          title: 'Dev',
          type: 'job',
          startDate: '2025-08',
          bullets: [],
        },
      ],
    });
    expect(deriveYearsExperience(p, NOW)).toBeCloseTo(1.0, 1);
  });

  /**
   * Nobody has been working since before they could hold a job. The union cap counts
   * concurrent entries once, but a single entry never overlaps itself, so one wrong start
   * date walks straight through it: a fifteen-year-old whose only job line read "2010-01 to
   * 2026-06" derived 16.4 years of professional experience and cleared a "3+ years
   * required" posting with a green tick beside it. See MIN_WORKING_AGE_YEARS.
   */
  it('cannot report more experience than the applicant has been alive to earn', () => {
    const wrongDate = (dateOfBirth: string) =>
      profile({
        dateOfBirth,
        experience: [
          {
            organization: 'Family Store',
            title: 'Clerk',
            type: 'job',
            startDate: '2010-01',
            endDate: '2026-06',
            bullets: [],
          },
        ],
      });

    // 15 years old: at most three years of working life behind them.
    expect(deriveYearsExperience(wrongDate('2011-05-01'), NOW)).toBe(3);
    // 14 years old: at most two.
    expect(deriveYearsExperience(wrongDate('2012-05-01'), NOW)).toBe(2);
    // 12 and under: none of it can be real.
    expect(deriveYearsExperience(wrongDate('2014-05-01'), NOW)).toBe(0);
  });

  /**
   * The other direction. The cap may never invent a shortfall, because a shortfall is what
   * the experience_ceiling rule hard-fails on. A plausible history is left exactly as it
   * was, and a profile with no date of birth on file is not capped at all rather than being
   * capped against a guessed age.
   */
  it('leaves a plausible history and an unknown age alone', () => {
    const realTeenJob = {
      organization: 'Neighbourhood Tutoring',
      title: 'Tutor',
      type: 'freelance' as const,
      startDate: '2023-06',
      endDate: '2026-06',
      bullets: [],
    };
    // Started at 14, three real years by 17. Nothing is taken away.
    expect(
      deriveYearsExperience(profile({ dateOfBirth: '2009-01-01', experience: [realTeenJob] }), NOW),
    ).toBe(3);
    expect(deriveYearsExperience(profile({ experience: [realTeenJob] }), NOW)).toBe(3);

    const adult = profile({
      dateOfBirth: '1990-01-01',
      experience: [
        {
          organization: 'Acme',
          title: 'Engineer',
          type: 'job',
          startDate: '2014-01',
          endDate: '2026-01',
          bullets: [],
        },
      ],
    });
    expect(deriveYearsExperience(adult, NOW)).toBe(12);
  });
});

describe('seniority band', () => {
  it('keeps a high schooler out of the intern bands', () => {
    expect(deriveSeniorityBand('high_school', 0, '2027-06', NOW)).toBe('pre_college');
  });

  it('promotes past graduation', () => {
    expect(deriveSeniorityBand('undergrad', 0, '2026-05', NOW)).toBe('new_grad');
  });

  it('distinguishes a first internship from a repeat one', () => {
    expect(deriveSeniorityBand('undergrad', 0.2, '2029-05', NOW)).toBe('entry_intern');
    expect(deriveSeniorityBand('undergrad', 1.5, '2029-05', NOW)).toBe('experienced_intern');
  });
});

describe('determinism', () => {
  it('produces identical output for identical input and clock', () => {
    const p = profile({ dateOfBirth: '2006-03-15' });
    expect(deriveProfile(p, NOW)).toEqual(deriveProfile(p, NOW));
  });
});

/**
 * Everything the extractor produces has to survive a round trip through the schema.
 *
 * The write path is typed and unvalidated; the read path parses strictly. A value the schema
 * will not take therefore stores cleanly and fails on every later read — including the G1
 * screen where it would have been corrected, and including the re-upload that is supposed to
 * rebuild the profile. So the draft has to be parseable no matter what came back from the
 * model, and anything that could not be used has to be flagged rather than dropped in
 * silence.
 */
describe('turning an extraction into a profile the schema accepts', () => {
  function extraction(over: Partial<ResumeExtraction> = {}): ResumeExtraction {
    return {
      fullName: 'Rosa Dean',
      pronouns: null,
      email: 'rosa@example.edu',
      phone: '555-0100',
      location: 'Boston, MA',
      links: { github: null, linkedin: null, portfolio: null },
      education: [],
      experience: [],
      projects: [],
      skills: [],
      certifications: [],
      languages: [],
      needsReview: [],
      ...over,
    };
  }

  it('keeps an address it can use, and repairs only what is mechanical', () => {
    for (const [raw, expected] of [
      ['rosa@example.edu', 'rosa@example.edu'],
      ['  rosa@example.edu  ', 'rosa@example.edu'],
      ['mailto:rosa@example.edu', 'rosa@example.edu'],
    ] as const) {
      const d = toDraftProfile(extraction({ email: raw }), NOW);
      expect(d.email, raw).toBe(expected);
      expect(d.needsReview, raw).not.toContain('email');
    }
  });

  it('refuses an address it cannot use, and sends the user to fill it in', () => {
    // Resumes obfuscate addresses to dodge scrapers, and PDF text extraction breaks them.
    for (const raw of [
      'rosa.dean [at] gmail.com',
      'rosa.dean(at)gmail.com',
      'rosa.dean@gmail',
      'rosa dean@gmail.com',
      'not an address at all',
      null,
    ]) {
      const d = toDraftProfile(extraction({ email: raw }), NOW);
      expect(d.email, String(raw)).toBe('');
      expect(d.needsReview, String(raw)).toContain('email');
      expect(CandidateProfile.safeParse(d).success, String(raw)).toBe(true);
    }
  });

  it('flags a stated GPA it cannot store rather than dropping the number', () => {
    // The profile shape holds a value+scale pair, so a figure that is not that pair — a
    // transcript printing only "4.321 weighted", or a number with no scale — cannot be
    // stored. Dropping it in silence left a true "4.32 weighted GPA" sentence with nothing
    // on the profile to match, and it came back red at G3. Each of these must be flagged so
    // the user completes the missing half at G1.
    function ed(over: Partial<ResumeExtraction['education'][number]>) {
      return {
        institution: 'Sample High',
        level: 'high_school' as const,
        fieldOfStudy: null,
        startDate: null,
        endDate: null,
        gpaValue: null,
        gpaScale: null,
        gpaWeighted: null,
        coursework: [],
        honors: [],
        ...over,
      };
    }

    for (const partial of [
      { gpaValue: null, gpaScale: 4, gpaWeighted: 4.321 }, // weighted only, with a scale
      { gpaValue: null, gpaScale: null, gpaWeighted: 3.7 }, // weighted only, no scale
      { gpaValue: 3.9, gpaScale: null, gpaWeighted: null }, // a number with no scale
    ]) {
      const d = toDraftProfile(extraction({ education: [ed(partial)] }), NOW);
      expect(d.education[0]?.gpa, JSON.stringify(partial)).toBeUndefined();
      expect(d.needsReview, JSON.stringify(partial)).toContain('education.0.gpa');
      expect(CandidateProfile.safeParse(d).success, JSON.stringify(partial)).toBe(true);
    }

    // A complete pair is kept and must NOT be flagged — the guard only fires on a figure
    // that could not be stored.
    const kept = toDraftProfile(
      extraction({ education: [ed({ gpaValue: 3.9, gpaScale: 4, gpaWeighted: 4.3 })] }),
      NOW,
    );
    expect(kept.education[0]?.gpa).toEqual({ value: 3.9, scale: 4, weighted: 4.3 });
    expect(kept.needsReview).not.toContain('education.0.gpa');
  });

  it('repairs a project URL the same way it repairs a profile link', () => {
    const d = toDraftProfile(
      extraction({
        links: { github: 'github.com/rosa', linkedin: null, portfolio: null },
        projects: [
          { name: 'Parser', description: 'A parser', url: 'github.com/rosa/parser', bullets: [] },
          { name: 'Nameless', description: 'No link', url: 'not a url', bullets: [] },
        ],
      }),
      NOW,
    );

    expect(d.links.github).toBe('https://github.com/rosa');
    expect(d.projects[0]?.url).toBe('https://github.com/rosa/parser');
    expect(
      d.projects[1]?.url,
      'a link that cannot be repaired is dropped, not guessed at',
    ).toBeUndefined();
    expect(CandidateProfile.safeParse(d).success).toBe(true);
  });
});
