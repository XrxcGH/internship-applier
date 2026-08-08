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
  normalize,
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
    pronouns: null,
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

/** The same student with one field swapped, for cases that need a particular shape. */
const evidenceFor = (patch: Partial<ConfirmedProfile>) =>
  retrieveEvidence({ ...fixture(), ...patch } as ConfirmedProfile, QUESTION, { limit: 20 });

const skilledWith = (names: string[]) =>
  evidenceFor({
    skills: names.map((name) => ({ name, category: 'tool', evidence: [] })),
  } as Partial<ConfirmedProfile>);

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

  /**
   * "3.62/4.0 GPA" extracts BOTH numbers — the fraction pattern reads the value, and the
   * number-leading pattern independently matches "4.0 GPA" on the far side of the slash.
   * Comparing every extracted number against the value alone made the scale impossible to
   * satisfy, so the most natural phrasing produced a blocking "the draft says GPA 4" on a
   * sentence quoting the profile exactly.
   */
  it('does not read the scale in "3.62/4.0 GPA" as a second claimed GPA', () => {
    expect(verdictOf('I graduated with a 3.62/4.0 GPA.')).toBeNull();
    expect(verdictOf('I hold a 3.62 / 4.0 GPA in computer science.')).toBeNull();
  });

  it('still catches a wrong GPA written the same way', () => {
    const r = checkClaimDeterministically('I graduated with a 3.95/4.0 GPA.', EVIDENCE);
    expect(r?.verdict).toBe('unsupported');
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

// ────────────────────────────────────────────────────── names that are not employers

describe('a bare acronym is not an invented employer', () => {
  /**
   * Every line here is true, ordinary, and the sort of thing any engineer writes about
   * their own work. Each one used to come back blocking at G3 — `"CSV" does not appear
   * anywhere on your profile` about a file format, `"HTTP"` about a protocol — on the one
   * screen with no override, where the only remedy offered is to add the fact to a
   * profile that has no field for it.
   */
  it('leaves technology named in passing alone', () => {
    for (const line of [
      'The HTTP layer was the easy part.',
      'It replaced a CSV export that three people maintained by hand.',
      'The CSS on that page was awful.',
      'I deployed it to AWS one Friday afternoon.',
      'The SQL was the slowest thing in the request.',
      'I rewrote the HTML by hand because the generator kept mangling it.',
      'Our CI kept timing out on the same test.',
      'The ML side of it was mostly reading papers.',
      'I wrote a REST API for the billing service.',
      'The JSON payload was three megabytes.',
    ]) {
      expect(verdictOf(line), line).toBeNull();
    }
  });

  // The other half. IBM and NASA are employers as surely as CSV is a file format, and the
  // only thing that separates them is what the sentence says the writer did there.
  it('still catches an acronym the writer claims to have worked at', () => {
    for (const line of [
      'I interned at IBM last summer.',
      'I worked at NASA on flight software.',
      'I spent two summers at SAP.',
      'I studied at MIT before transferring.',
    ]) {
      expect(verdictOf(line), line).toBe('unsupported');
    }
  });

  it('does not exempt a name with an ordinary word beside it', () => {
    expect(verdictOf('I built the ingest layer at IBM Research last summer.')).toBe('unsupported');
  });

  /**
   * "I did/had/completed an internship at NASA" is an employment claim about an all-caps
   * name written the plainest way there is, and every one used to slip the affiliation frame
   * — which only listed employment verbs — and ride through unchecked. The stint noun now
   * carries the claim, so the frame catches it without treating "I had trouble with SQL" as
   * a job at SQL.
   */
  it('catches an acronym employer named through a stint noun, not just a verb', () => {
    for (const line of [
      'I did an internship at NASA working on flight software.',
      'I had an internship at NASA last summer.',
      'I completed an internship at IBM.',
      'I finished the apprenticeship at SAP.',
    ]) {
      expect(verdictOf(line), line).toBe('unsupported');
    }
  });

  it('does not read an ordinary "had ... with" as employment at a technology', () => {
    // The stint-noun branch must not fire on these; SQL and CSV are not employers here.
    for (const line of [
      'I had a great time at MITRE that week.',
      'I had trouble with the CSV parser.',
    ]) {
      expect(verdictOf(line), line).toBeNull();
    }
  });
});

describe('a short name on the profile does not vouch for an invented employer', () => {
  const MIT = evidenceFor({ education: [{ ...fixture().education[0]!, institution: 'MIT' }] });

  /**
   * "smith barney" contains "mit". Matching by bare characters meant the fabrication came
   * back with no verdict at all, and inside a sentence carrying any ordinary amount of
   * profile content it came back green — worse than a missed flag, because a green tick
   * is what tells the user at G3 that there is nothing left to check.
   */
  it('rejects an invented employer whose letters swallow a known one', () => {
    for (const line of [
      'I interned at Smith Barney last summer.',
      'I interned at Summit Consulting last summer.',
    ]) {
      expect(checkClaimDeterministically(line, MIT).verdict, line).toBe('unsupported');
    }
  });

  it('gives the same sentence the same answer whichever employer it invents', () => {
    const sentence = (employer: string): string =>
      `Last summer at ${employer} I built a tide chart that works offline because kayakers have no signal.`;
    for (const employer of ['Smith Barney', 'Goldman Sachs']) {
      expect(guardDraft(sentence(employer), MIT).blocking.length, employer).toBe(1);
    }
  });

  it("still accepts the profile's own name, shortened or extended", () => {
    expect(checkClaimDeterministically('I study computer science at MIT.', MIT).verdict).toBeNull();
    expect(
      checkClaimDeterministically('I ran the study at the MIT Media Lab.', MIT).verdict,
    ).toBeNull();
    expect(verdictOf('The Learning Center gave me my first teaching experience.')).toBeNull();
  });
});

describe('a plural on the profile supports the singular in the draft', () => {
  /**
   * The profile said "Design Patterns" and the draft said "Design Pattern", so the user
   * was blocked at G3 by a message saying the term does not appear anywhere on their
   * profile. It did, one letter away. The remedy the message offers — add the fact — had
   * already been done, and nothing on that screen said the plural was the whole problem.
   */
  it('does not call a term missing over one letter', () => {
    expect(
      checkClaimDeterministically(
        'The Design Pattern I leaned on was the outbox.',
        skilledWith(['Design Patterns', 'Python']),
      ).verdict,
    ).toBeNull();

    expect(
      checkClaimDeterministically(
        'The Design Patterns I leaned on saved me twice.',
        skilledWith(['Design Pattern', 'Python']),
      ).verdict,
    ).toBeNull();
  });

  it('still catches a term that really is absent', () => {
    const r = checkClaimDeterministically(
      'The Design Paradigm I leaned on was the outbox.',
      skilledWith(['Design Patterns', 'Python']),
    );
    expect(r.verdict).toBe('unsupported');
    expect(r.reason).toContain('Design Paradigm');
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

  /**
   * "2.5 years" used to match at the word boundary between the dot and the 5, so a half
   * was read as a whole and the guard measured five years against a thirty-month job.
   * Half-years are how students describe their own time; every one of them was wrong.
   */
  it('reads a decimal and its fraction as one count, not two', () => {
    expect(extractDurations('for 2.5 years')[0]!.months).toBe(30);
    expect(extractDurations('for 1.5 years')[0]!.months).toBe(18);
    expect(extractDurations('about 3.5 months of work')[0]!.months).toBeCloseTo(3.5, 2);
    expect(extractDurations('over 20.5 years')[0]!.months).toBe(246);
    expect(extractDurations('a 2.5-year stint')[0]!.months).toBe(30);
    // And the raw text is the whole number, since it is quoted back to the user.
    expect(extractDurations('for 2.5 years')[0]!.raw).toContain('2.5');
  });
});

describe('half-years are not read as whole ones', () => {
  // Nothing on this profile is longer than the degree, at 44 months.
  it('does not flag an honest half-year', () => {
    expect(verdictOf('I have been writing code for 2.5 years.')).toBeNull();
    expect(verdictOf('I have been writing code for 3.5 years.')).toBeNull();
  });

  it('still catches an inflated one', () => {
    expect(verdictOf('I have been writing code professionally for 8.5 years.')).toBe('overstated');
    // 10.2 read as "2 years" sat under the ceiling and was waved through.
    expect(verdictOf('I have been writing code professionally for 10.2 years.')).toBe('overstated');
  });

  /**
   * The message quotes the draft back at the user so they can find the sentence. When the
   * fraction was dropped it quoted "5 years" at someone who had written "2.5 years", and
   * G3 has no override — they were told to fix a phrase that was not in their draft.
   */
  it('quotes a phrase that is actually in the draft', () => {
    const draft = 'I have been writing code professionally for 8.5 years.';
    const r = checkClaimDeterministically(draft, EVIDENCE);
    const quoted = /"([^"]+)"/.exec(r.reason ?? '')?.[1];
    expect(quoted).toBeTruthy();
    expect(draft).toContain(quoted);
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

  /**
   * Transcripts print three decimals, and a rising freshman quoting one exactly is the most
   * honest thing this guard sees. The scale-mask capped its numerator at two decimals while
   * the number-leading pattern read three, so "3.968/4.0" slipped the mask and the guard
   * read the SCALE on the far side of the slash — 4 — as a second claimed GPA. Every one of
   * these must return the numerator the student wrote, never the denominator.
   */
  it('reads a three-decimal GPA and never the scale beside it', () => {
    expect(extractGpas('I graduated with a 3.968/4.0 GPA.')).toEqual([3.968]);
    expect(extractGpas('I earned a 3.968 out of 4.0 GPA.')).toEqual([3.968]);
    expect(extractGpas('I hold a 4.321/5.0 weighted GPA.')).toEqual([4.321]);
    expect(extractGpas('I have a 3.968 GPA on a 4.000 scale.')).toEqual([3.968]);
    expect(extractGpas('I earned a 3.968/4 GPA')).toEqual([3.968]);
    // Two-decimal forms still read exactly as before.
    expect(extractGpas('3.62/4.0 GPA')).toEqual([3.62]);
  });
});

/**
 * A rising freshman with a three-decimal, weighted GPA — the shape the whole dossier flow
 * was built around, and the one the scale-mask regression blocked.
 */
const gpaEvidenceFor = (gpa: { value: number; scale: number; weighted?: number }) =>
  evidenceFor({
    education: [{ ...fixture().education[0]!, gpa }],
  } as Partial<ConfirmedProfile>);

describe('a true three-decimal GPA is not blocked, and its scale is never quoted back', () => {
  const EV = gpaEvidenceFor({ value: 3.968, scale: 4, weighted: 4.321 });

  it('passes the exact figure in every notation', () => {
    for (const line of [
      'I graduated with a 3.968/4.0 GPA.',
      'I earned a 3.968 out of 4.0 GPA.',
      'I have a 3.968 GPA on a 4.000 scale.',
      // The weighted figure the profile also holds is a true number about the same student.
      'I hold a 4.321/5.0 weighted GPA.',
      'I have a 3.968/4.0 GPA and a 4.321 weighted GPA.',
    ]) {
      expect(checkClaimDeterministically(line, EV).verdict, line).toBeNull();
    }
  });

  it('still catches a fabricated GPA at three decimals', () => {
    expect(checkClaimDeterministically('I graduated with a 3.100/4.0 GPA.', EV).verdict).toBe(
      'unsupported',
    );
  });

  it('names the weighted figure in the mismatch reason instead of only the lower one', () => {
    const r = checkClaimDeterministically('I have a 4.5 weighted GPA.', EV);
    expect(r.verdict).toBe('unsupported');
    // The message must not steer the student to discard their true, higher weighted number.
    expect(r.reason).toContain('4.321 weighted');
    expect(r.reason).toContain('3.968');
  });
});

describe('a name whose punctuation leaves a lone letter stays checkable', () => {
  /**
   * A blanket lone-"s" strip in `normalize` collapsed "S&P" to a single "p", dropped it
   * below the checkable length, and a FABRICATED "S&P" employer sailed past with a green
   * tick — the worst thing this file can produce. These names must survive normalisation as
   * multi-character, checkable tokens.
   */
  it('keeps ampersand and hyphen names long enough to check', () => {
    for (const raw of ['S&P', 'AT&T', 'H-E-B', 'M&S']) {
      expect(normalize(raw).length, raw).toBeGreaterThan(1);
    }
  });

  it('catches a fabricated S&P employer that the profile never held', () => {
    const g = guardDraft(
      'While a Counselor at Camp Redwood I also interned at S&P using Python and Excel.',
      evidenceFor({
        experience: [
          {
            organization: 'Camp Redwood',
            title: 'Counselor',
            type: 'job',
            startDate: '2025-06',
            endDate: '2025-08',
            bullets: ['Led activities'],
            skills: ['Python'],
          },
        ],
      } as Partial<ConfirmedProfile>),
    );
    expect(g.blocking).toHaveLength(1);
    expect(g.blocking[0]!.claim).toContain('S&P');
  });

  it('still folds a possessive so a shorter award matches a longer one', () => {
    // Removing the lone-"s" strip must not reopen the "Dean's List" false-block: the short
    // form has to remain a whole-word prefix of the long form.
    expect(normalize('Dean’s List Semi-Finalist').startsWith(normalize("Dean's List"))).toBe(true);
  });
});

describe('a possessive award reads the same with or without its apostrophe', () => {
  /**
   * Extraction may keep or drop the apostrophe in "Dean's List" depending on the resume,
   * and the drafting model may write it either way. When one side wrote "Deans List" and the
   * other "Dean's List" the two forms of the student's own honor no longer vouched for each
   * other, and a true award was blocked at G3 as an invented name — one apostrophe away.
   */
  const apos = evidenceFor({
    education: [{ ...fixture().education[0]!, honors: ["Dean's List Semi-Finalist"] }],
  } as Partial<ConfirmedProfile>);
  const plain = evidenceFor({
    education: [{ ...fixture().education[0]!, honors: ['Deans List Semi-Finalist'] }],
  } as Partial<ConfirmedProfile>);

  it('does not block whichever apostrophe form each side happens to use', () => {
    expect(
      checkClaimDeterministically('I made the Deans List that year.', apos).verdict,
    ).toBeNull();
    expect(
      checkClaimDeterministically("I made the Dean's List that year.", plain).verdict,
    ).toBeNull();
    expect(
      checkClaimDeterministically("I made the Dean's List that year.", apos).verdict,
    ).toBeNull();
    expect(
      checkClaimDeterministically('I made the Deans List that year.', plain).verdict,
    ).toBeNull();
  });

  it('still blocks an award the profile does not hold', () => {
    expect(checkClaimDeterministically("I made the Provost's List that year.", apos).verdict).toBe(
      'unsupported',
    );
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
