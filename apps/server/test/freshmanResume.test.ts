/**
 * The rising-freshman resume, end to end below the model.
 *
 * Every fixture before this one described a mid-degree CS student: bulleted internships, a
 * skills section, one GPA with two decimals. A student applying the summer after high
 * school looks nothing like that — the substance is in awards, leadership and clubs; the
 * experience lines have no bullets; the transcript prints THREE decimals and TWO GPAs, one
 * of them above the scale; the header states pronouns. Each of those shapes found a real
 * gap when it first arrived, so this file holds the whole shape together: extraction schema
 * through draft profile, derivation, role inference, and FactGuard in both directions.
 */
import { describe, expect, it } from 'vitest';
import { CandidateProfile } from '@ia/shared';
import { ResumeExtraction } from '../src/core/ingestion/extractProfile';
import { toDraftProfile } from '../src/core/ingestion/toProfile';
import { inferRoleFamilies } from '../src/core/discovery/queryPlanner';
import { retrieveEvidence } from '../src/core/writing/retrieve';
import { checkClaimDeterministically } from '../src/core/writing/factGuard';

const EXTRACTION = {
  fullName: 'Jordan Q. Sample',
  pronouns: 'he/they',
  email: 'jordan.sample@example.edu',
  phone: '+1.555.010.0100',
  location: 'San Mateo, CA',
  links: { github: null, linkedin: null, portfolio: null },
  education: [
    {
      institution: 'UCLA',
      level: 'bachelor' as const,
      fieldOfStudy: 'Mechanical Engineering',
      startDate: '2025-09',
      endDate: '2029-06',
      gpaValue: null,
      gpaScale: null,
      gpaWeighted: null,
      coursework: [],
      honors: [],
    },
    {
      institution: 'St. Sample High School',
      level: 'high_school' as const,
      fieldOfStudy: null,
      startDate: '2021-08',
      endDate: '2025-05',
      gpaValue: 3.968,
      gpaScale: 4,
      gpaWeighted: 4.321,
      coursework: ['11 Advanced Placement and honors subjects'],
      honors: [
        '4.321 GPA weighted, 3.968 unweighted (4.000 scale)',
        "Dean's List Semi-Finalist, FIRST Robotics Competition",
        'National Merit Commended Student',
        'Magna Cum Laude',
      ],
    },
  ],
  experience: [
    {
      organization: 'Tech Camp',
      title: 'Instructor',
      type: 'job' as const,
      startDate: '2026-06',
      endDate: null,
      location: 'Stanford, CA',
      bullets: [],
    },
    {
      organization: 'Regional Robotics Forum',
      title: 'Intern',
      type: 'internship' as const,
      startDate: '2026-05',
      endDate: null,
      location: 'San Jose, CA',
      bullets: [],
    },
    {
      organization: 'Sample Robotics / 0000, FIRST Robotics Competition',
      title: 'Team Captain / Founding Member',
      type: 'club' as const,
      startDate: null,
      endDate: null,
      location: null,
      bullets: [],
    },
    {
      organization: 'Gourd Bots / 9999, FIRST Robotics Competition',
      title: 'Mentor',
      type: 'volunteer' as const,
      startDate: null,
      endDate: null,
      location: null,
      bullets: [],
    },
  ],
  projects: [],
  skills: [],
  certifications: [{ name: 'First Aid/CPR/AED', issuer: 'American Red Cross', date: '2024-01' }],
  languages: [],
  needsReview: ['experience.2.startDate', 'experience.3.startDate'],
};

function draftOf() {
  const parsed = ResumeExtraction.parse(EXTRACTION);
  return toDraftProfile(parsed);
}

describe('the shape survives every schema on the way in', () => {
  it('parses as an extraction and as a profile', () => {
    const draft = draftOf();
    const cp = CandidateProfile.safeParse(draft);
    expect(cp.success, JSON.stringify(cp.success ? '' : cp.error.issues.slice(0, 3))).toBe(true);
  });

  it('keeps both GPAs, the pronouns and the certification date', () => {
    const draft = draftOf();
    expect(draft.pronouns).toBe('he/they');
    expect(draft.education[1]?.gpa).toEqual({ value: 3.968, scale: 4, weighted: 4.321 });
    expect(draft.certifications[0]?.date).toBe('2024-01');
  });

  it('derives a first-year undergraduate, not a high schooler', () => {
    const d = draftOf().derived;
    expect(d.academicLevel).toBe('undergrad');
    expect(d.academicYear).toBe(1);
    expect(d.expectedGraduation).toBe('2029-06');
    expect(d.seniorityBand).toBe('entry_intern');
  });

  it('infers robotics from a FIRST-shaped history', () => {
    const families = inferRoleFamilies(draftOf() as never);
    expect(families).toContain('robotics');
    expect(families).toContain('mechanical engineering');
  });
});

describe('FactGuard reads this resume the way its owner would write about it', () => {
  const confirmed = { ...draftOf(), confirmedAt: '2026-08-07T00:00:00Z' };
  const evidence = retrieveEvidence(confirmed as never, 'Tell us about your robotics experience.');
  const verdictOf = (claim: string) => checkClaimDeterministically(claim, evidence).verdict;

  it('accepts true sentences, including both GPAs at three decimals', () => {
    for (const claim of [
      'I have a 3.968 GPA on a 4.0 scale.',
      'I graduated with a 4.321 weighted GPA.',
      'I was the founding team captain of Sample Robotics.',
      'I mentor Gourd Bots, a FIRST Robotics Competition team.',
      'I am studying Mechanical Engineering at UCLA.',
    ]) {
      expect(verdictOf(claim), claim).toBeNull();
    }
  });

  /** Honors are evidence now, so a true sentence about an award is approvable. */
  it('accepts an award the resume states', () => {
    expect(verdictOf("I was a Dean's List semifinalist in the FIRST Robotics Competition.")).toBe(
      null,
    );
  });

  /** And the same widening must not have opened the other direction. */
  it('still blocks an invented GPA, weighted or not', () => {
    expect(verdictOf('I maintain a 4.9 weighted GPA.')).toBe('unsupported');
    expect(verdictOf('My GPA is 3.55.')).toBe('unsupported');
  });

  it('still blocks an invented employer', () => {
    expect(verdictOf('I interned at Initech last summer.')).toBe('unsupported');
  });
});
