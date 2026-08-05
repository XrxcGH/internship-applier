/**
 * FactGuard adversarial suite — the M5 release gate (docs/11).
 *
 * Every planted fabrication below must be caught. These tests are not here to describe
 * current behaviour; they are here to fail the build if the guard ever stops catching a
 * lie. Do not relax a case to make it pass — fix the guard.
 *
 * The second half matters just as much. A guard that flags honest sentences trains the
 * user to click through warnings, and a warning nobody reads protects nobody.
 */
import { describe, expect, it } from 'vitest';
import type { ConfirmedProfile } from '@ia/shared';
import {
  checkClaimDeterministically,
  extractClaimedSkills,
  extractDurations,
  extractGpas,
  extractProperNouns,
  guardDraft,
  isVerifiableClaim,
  mergeModelVerdicts,
  splitClaims,
} from '../src/core/writing/factGuard';
import { retrieveEvidence } from '../src/core/writing/retrieve';

const NOW = new Date('2026-08-03T00:00:00Z');

/**
 * A real-shaped student profile. Everything the guard is allowed to believe is here;
 * anything else is a fabrication by definition.
 *
 * Deliberate properties: the internship is SHORT (two months), so duration inflation has
 * something to catch; the degree spans years, so an unscoped duration claim has a
 * generous ceiling; the GPA is a specific number.
 */
function fixture(): ConfirmedProfile {
  return {
    id: 'p1',
    fullName: 'Rosa Alvarez',
    email: 'rosa@example.edu',
    dateOfBirth: '2006-03-15',
    address: { country: 'US' },
    links: { other: [] },
    workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
    citizenships: ['US'],
    education: [
      {
        institution: 'Rutgers University',
        level: 'bachelor',
        fieldOfStudy: 'Computer Science',
        startDate: '2024-09',
        endDate: '2028-05',
        gpa: { value: 3.62, scale: 4 },
        coursework: ['Data Structures', 'Computer Architecture'],
        honors: [],
      },
    ],
    experience: [
      {
        organization: 'Kestrel Analytics',
        title: 'Software Engineering Intern',
        type: 'internship',
        startDate: '2026-06',
        endDate: '2026-08',
        bullets: [
          'Built internal tooling that let the support team resolve billing tickets without an engineer',
          'Migrated a nightly batch report from cron to a queue, cutting its failure rate',
        ],
        skills: ['TypeScript', 'PostgreSQL'],
      },
      {
        organization: 'Rutgers Learning Center',
        title: 'Peer Tutor',
        type: 'job',
        startDate: '2025-10',
        bullets: ['Tutored introductory programming students in weekly small-group sessions'],
        skills: ['Python'],
      },
    ],
    projects: [
      {
        name: 'Tidewater',
        description: 'A tide chart for kayakers that works offline',
        bullets: ['Caches a year of predictions so the app is useful with no signal'],
        skills: ['React', 'TypeScript'],
      },
    ],
    skills: [
      { name: 'TypeScript', category: 'language', evidence: [] },
      { name: 'Python', category: 'language', evidence: [] },
      { name: 'PostgreSQL', category: 'tool', evidence: [] },
      { name: 'React', category: 'framework', evidence: [] },
    ],
    certifications: [],
    languages: [],
    availability: { start: '2027-06-01', end: '2027-08-20', flexible: true },
    locationPrefs: {
      base: { city: 'New Brunswick', region: 'NJ', country: 'US' },
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
      yearsProfessionalExperience: 0.2,
      seniorityBand: 'entry_intern',
    },
    confirmedAt: NOW.toISOString(),
    needsReview: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } as ConfirmedProfile;
}

const QUESTION = 'Tell us about a time you built something you are proud of.';
const EVIDENCE = retrieveEvidence(fixture(), QUESTION, { limit: 20 });

const verdictOf = (claim: string): string | null =>
  checkClaimDeterministically(claim, EVIDENCE).verdict;

// ───────────────────────────────────────────────────────────── the gate

describe('adversarial: planted fabrications (release gate)', () => {
  it('catches an invented employer', () => {
    const r = checkClaimDeterministically(
      'I spent last summer at Google working on search infrastructure.',
      EVIDENCE,
    );
    expect(r.verdict).toBe('unsupported');
    expect(r.reason).toContain('Google');
  });

  it('catches an invented school', () => {
    expect(verdictOf('I transferred in from Stanford after my first year.')).toBe('unsupported');
  });

  it('catches an inflated duration against the employer it names', () => {
    const r = checkClaimDeterministically(
      'I worked at Kestrel Analytics for two years on their billing systems.',
      EVIDENCE,
    );
    expect(r.verdict).toBe('overstated');
    expect(r.profileRef).toMatch(/^experience\.0/);
    // The message has to say what the profile actually holds, or it is not actionable.
    expect(r.reason).toMatch(/2 months/);
  });

  it('catches an inflated duration with no employer named', () => {
    // Nothing on the profile spans eight years — not even the degree.
    expect(verdictOf('I have been writing code professionally for eight years.')).toBe(
      'overstated',
    );
  });

  it('catches a wrong GPA', () => {
    const r = checkClaimDeterministically('My GPA is 3.9 and I made the dean’s list.', EVIDENCE);
    expect(r.verdict).toBe('unsupported');
    expect(r.reason).toContain('3.62');
  });

  it('catches a wrong GPA written as a fraction', () => {
    expect(verdictOf('I am carrying a 3.95/4.0 while working part time.')).toBe('unsupported');
  });

  it('catches a nonexistent skill', () => {
    const r = checkClaimDeterministically('I built the whole backend in Rust.', EVIDENCE);
    expect(r.verdict).toBe('unsupported');
    expect(r.reason).toContain('Rust');
  });

  it('catches a nonexistent skill behind a softer verb', () => {
    expect(verdictOf('I am proficient with Kubernetes and ship to it weekly.')).toBe('unsupported');
  });

  it('catches an invented project', () => {
    const g = guardDraft(
      'I wrote a distributed key-value store that handles ten thousand writes a second.',
      EVIDENCE,
    );
    expect(g.blocking).toHaveLength(1);
  });

  it('does not let an opinion frame smuggle a fabrication through', () => {
    // Every one of these reads as motivation, and every one asserts something false.
    for (const smuggled of [
      'I would love to bring the Rust experience I gained at Google to your team.',
      'I am excited to build on the two years I spent at Kestrel Analytics.',
      'I am proud of the 3.9 GPA I have maintained.',
    ]) {
      expect(isVerifiableClaim(smuggled), smuggled).toBe(true);
      expect(guardDraft(smuggled, EVIDENCE).blocking.length, smuggled).toBeGreaterThan(0);
    }
  });

  it('blocks a whole draft when any one sentence is fabricated', () => {
    const draft = [
      'I interned at Kestrel Analytics last summer, where I built internal tooling in TypeScript.',
      'The work I am proudest of is Tidewater, a tide chart that caches a year of predictions so it still works with no signal.',
      'Before that I led a team of six at Palantir.',
    ].join(' ');

    const g = guardDraft(draft, EVIDENCE);
    expect(g.blocking).toHaveLength(1);
    expect(g.blocking[0]!.claim).toContain('Palantir');
  });
});

// ───────────────────────────────────────────────── the other failure direction

describe('honest drafts are not flagged', () => {
  it('passes an accurate answer end to end', () => {
    const draft = [
      'I interned at Kestrel Analytics last summer, where I built internal tooling in TypeScript.',
      'The support team had been filing tickets at engineers to get billing questions answered, so I gave them a way to resolve those themselves.',
      'It was not glamorous work. It cut a queue nobody wanted to be on.',
    ].join(' ');

    const g = guardDraft(draft, EVIDENCE);
    expect(g.blocking).toEqual([]);
  });

  it('accepts an honestly rounded duration', () => {
    // June to August is two months on paper; nobody describes it as anything but a summer.
    expect(verdictOf('I worked at Kestrel Analytics for three months over the summer.')).toBeNull();
  });

  it('accepts a correct GPA in either notation', () => {
    expect(verdictOf('I have a 3.62 GPA in computer science.')).toBeNull();
    expect(verdictOf('My GPA is 3.62 out of 4.0.')).toBeNull();
  });

  it('accepts skills the profile holds', () => {
    expect(
      verdictOf('I built Tidewater in React and shipped it to a handful of friends.'),
    ).toBeNull();
    expect(verdictOf('Most of my day at Kestrel Analytics was spent in PostgreSQL.')).toBeNull();
  });

  it('does not measure a duration that is not about the writer working', () => {
    // Reading about a company for years is not a claim about employment.
    expect(verdictOf('I have been following Kestrel Analytics for four years.')).toBeNull();
  });

  it('does not treat months, seasons, or sentence openers as employers', () => {
    for (const line of [
      'Last summer I finally understood why indexes matter.',
      'During my second year I started tutoring.',
      'Working on that report taught me more than the course did.',
      'The Learning Center gave me my first teaching experience.',
    ]) {
      expect(verdictOf(line), line).toBeNull();
    }
  });

  it('skips motivation sentences instead of flagging them', () => {
    const draft =
      'I would like to spend a summer on developer tooling. Honestly, I am drawn to the unglamorous parts.';
    const g = guardDraft(draft, EVIDENCE);
    expect(g.claims).toEqual([]);
    expect(g.blocking).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────── the pieces

describe('duration extraction', () => {
  it('reads digits and words in every unit', () => {
    expect(extractDurations('for two years')[0]!.months).toBe(24);
    expect(extractDurations('over 18 months')[0]!.months).toBe(18);
    expect(extractDurations('a three-month internship')[0]!.months).toBe(3);
    expect(extractDurations('10 weeks')[0]!.months).toBeCloseTo(2.3, 1);
  });

  it('ignores vague quantities rather than guessing a number', () => {
    expect(extractDurations('several years of experience')).toEqual([]);
    expect(extractDurations('many months later')).toEqual([]);
  });
});

describe('GPA extraction', () => {
  it('reads the common notations', () => {
    expect(extractGpas('GPA: 3.62')).toEqual([3.62]);
    expect(extractGpas('my GPA is a 3.9')).toEqual([3.9]);
    expect(extractGpas('3.45/4.0')).toEqual([3.45]);
    expect(extractGpas('3.45 out of 4')).toEqual([3.45]);
  });

  it('does not read arbitrary decimals as grades', () => {
    expect(extractGpas('cut latency to 1.4 seconds')).toEqual([]);
  });
});

describe('proper-noun extraction', () => {
  it('finds names wherever they sit in the sentence', () => {
    expect(extractProperNouns('I worked at Kestrel Analytics.')).toContain('Kestrel Analytics');
    expect(extractProperNouns('Kestrel Analytics hired me in June.')).toContain(
      'Kestrel Analytics',
    );
    expect(extractProperNouns('I go to the University of Michigan.')).toContain(
      'University of Michigan',
    );
  });

  it('does not split a name across a conjunction', () => {
    // "Kestrel Analytics and Rutgers" as one blob would match neither.
    const names = extractProperNouns('I worked at Kestrel Analytics and Rutgers University.');
    expect(names).toContain('Kestrel Analytics');
    expect(names).toContain('Rutgers University');
  });

  it('does not read a contraction as a company name', () => {
    // This blocked G3 approval on any naturally written answer: "I've" normalised to
    // "i ve", matched nothing on the profile, and came back unsupported.
    for (const s of [
      "I've been writing Python since high school.",
      "I'm proud of that one.",
      "Don't ask me why it took so long.",
      "It's the part I liked most.",
      "We've shipped it twice.",
    ]) {
      expect(
        extractProperNouns(s).filter((n) => /['’]/.test(n)),
        s,
      ).toEqual([]);
    }
    expect(verdictOf("I've been writing code since high school.")).toBeNull();
  });

  it('reads a possessive as the name that owns it', () => {
    // "Google's" used to normalise to "google s" and match no employer at all.
    expect(extractProperNouns("I worked on Google's search team.")).toContain('Google');
    expect(verdictOf("I worked on Google's search team.")).toBe('unsupported');
  });

  it('leaves ordinary capitalised words alone', () => {
    expect(extractProperNouns('Last summer was hard.')).toEqual([]);
    expect(extractProperNouns('During June I moved.')).toEqual([]);
    expect(extractProperNouns('I did.')).toEqual([]);
  });
});

describe('claimed-skill extraction', () => {
  it('finds technologies presented as things the writer used', () => {
    expect(extractClaimedSkills('built in Rust')).toEqual(['Rust']);
    expect(extractClaimedSkills('experience with Kubernetes')).toEqual(['Kubernetes']);
    expect(extractClaimedSkills('written in Go')).toEqual(['Go']);
  });

  it('does not treat a following clause as a technology', () => {
    expect(extractClaimedSkills('worked with The team')).toEqual([]);
  });
});

describe('claim segmentation', () => {
  it('splits sentences', () => {
    expect(splitClaims('I built the parser. It was slow at first.')).toHaveLength(2);
  });

  it('splits coordinated clauses when punctuation makes them unambiguous', () => {
    const claims = splitClaims('I built the parser, and I shipped it to production that week.');
    expect(claims).toHaveLength(2);
  });

  it('does not split coordinated nouns', () => {
    // "research and development" is one thing. Splitting it invents a claim.
    expect(splitClaims('I did research and development work at the lab.')).toHaveLength(1);
  });

  it('reports spans that index back into the original text', () => {
    const text = 'I built the parser. It was slow at first.';
    for (const c of splitClaims(text)) {
      expect(text.slice(c.span.start, c.span.end)).toBe(c.text);
    }
  });
});

// ───────────────────────────────────────────────────────── layer precedence

describe('the model layer cannot clear a deterministic rejection', () => {
  const base = guardDraft('I spent two years at Google building search infrastructure.', EVIDENCE);

  it('has something to override', () => {
    expect(base.blocking.length).toBeGreaterThan(0);
  });

  it('ignores a model that calls a caught fabrication supported', () => {
    const merged = mergeModelVerdicts(
      base,
      base.claims.map((c) => ({ claim: c.claim, verdict: 'supported' as const })),
    );
    expect(merged.blocking.length).toBe(base.blocking.length);
    expect(merged.claims.every((c) => c.decidedBy === 'deterministic')).toBe(true);
  });

  it('accepts a model that downgrades a claim the regexes could not reach', () => {
    const honest = guardDraft(
      'I built internal tooling that let the support team resolve billing tickets without an engineer.',
      EVIDENCE,
    );
    expect(honest.blocking).toEqual([]);

    const merged = mergeModelVerdicts(honest, [
      {
        claim: honest.claims[0]!.claim,
        verdict: 'overstated',
        reason:
          'The evidence says you built tooling, not that you removed engineers from the loop.',
      },
    ]);
    expect(merged.blocking).toHaveLength(1);
    expect(merged.claims[0]!.decidedBy).toBe('model');
  });

  it('leaves claims the model did not mention untouched', () => {
    const merged = mergeModelVerdicts(base, []);
    expect(merged.claims).toEqual(base.claims);
  });
});
