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
  it('takes the most advanced degree, not the first listed', () => {
    const p = profile({
      education: [
        { institution: 'HS', level: 'high_school', coursework: [], honors: [] },
        { institution: 'U', level: 'bachelor', coursework: [], honors: [] },
      ],
    });
    expect(deriveAcademicLevel(p)).toBe('undergrad');
  });

  it('uses the latest end date as expected graduation', () => {
    const p = profile({
      education: [
        { institution: 'HS', level: 'high_school', endDate: '2025-06', coursework: [], honors: [] },
        { institution: 'U', level: 'bachelor', endDate: '2029-05', coursework: [], honors: [] },
      ],
    });
    expect(deriveExpectedGraduation(p)).toBe('2029-05');
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
