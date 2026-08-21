import { describe, expect, it } from 'vitest';
import { LINEAR_CEILING, measureGrowth } from './support/growth';
import { guardQuotes, normalizeForQuoteMatch, verifyQuote } from '../src/core/matching/quoteGuard';
import {
  deterministicRequirements,
  extractRequirements,
} from '../src/core/matching/extractRequirements';
import { validateValue } from '../src/core/matching/requirementValues';
import { stripHtml } from '../src/core/discovery/sources/types';

const JD = `
About the role
We are hiring a Software Engineering Intern for Summer 2027.

Requirements
- You must be at least 18 years of age at the start of the internship.
- Currently enrolled in a Bachelor's degree program in Computer Science or a related field.
- Graduating between December 2027 and June 2028.
- Must be legally authorized to work in the United States. We do not provide visa sponsorship.
- 2 years of professional experience with distributed systems.

Nice to have
- Experience with Kubernetes is a plus.
`.trim();

describe('quote verification', () => {
  it('accepts an exact quote', () => {
    expect(verifyQuote('We do not provide visa sponsorship.', JD).ok).toBe(true);
  });

  /** Models reproduce wording faithfully but normalise typography. That must still pass. */
  it('tolerates whitespace, curly quotes, and dash substitutions', () => {
    expect(verifyQuote('We  do   not\nprovide visa sponsorship.', JD).ok).toBe(true);
    expect(verifyQuote('Bachelor’s degree program', JD).ok).toBe(true);
  });

  it('rejects invented wording', () => {
    expect(verifyQuote('Applicants must hold a valid pilot licence.', JD).ok).toBe(false);
  });

  /** A two-word "quote" matches almost any document and proves nothing. */
  it('rejects a quote too short to mean anything', () => {
    const check = verifyQuote('the', JD);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/too short/);
  });

  it('rejects an empty quote', () => {
    expect(verifyQuote('', JD).ok).toBe(false);
  });

  it('normalises consistently', () => {
    expect(normalizeForQuoteMatch('  A—B  “x”  ')).toBe('a-b "x"');
  });

  it('drops unverifiable requirements and reports why', () => {
    const { kept, dropped } = guardQuotes(
      [
        { kind: 'age', sourceQuote: 'must be at least 18 years of age', confidence: 0.9 },
        { kind: 'other', sourceQuote: 'must own a car and a boat', confidence: 0.9 },
      ],
      JD,
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toMatch(/does not appear/);
  });
});

describe('deterministic extraction', () => {
  const found = deterministicRequirements(JD);
  const byKind = (k: string) => found.filter((r) => r.kind === k);

  it('finds the minimum age', () => {
    expect(byKind('age')[0]?.value).toEqual({ min: 18 });
  });

  it('finds the sponsorship exclusion', () => {
    const wa = byKind('work_auth').map((r) => r.value);
    expect(wa).toContainEqual({ sponsorshipUnavailable: true });
  });

  it('finds the graduation window', () => {
    expect(byKind('graduation_window')[0]?.value).toEqual({ from: '2027-12', to: '2028-06' });
  });

  it('finds the enrolment requirement', () => {
    expect(byKind('enrollment')[0]?.value).toEqual({ required: true });
  });

  /** The clause that catches an "internship" quietly demanding real experience. */
  it('finds the professional-experience requirement', () => {
    expect(byKind('experience_years')[0]?.value).toEqual({ min: 2 });
    expect(byKind('experience_years')[0]?.necessity).toBe('required');
  });

  it('quotes real text for every requirement it produces', () => {
    for (const r of found) {
      expect(verifyQuote(r.sourceQuote, JD).ok, `bad quote for ${r.kind}`).toBe(true);
    }
  });

  it('finds nothing in a posting that states no requirements', () => {
    const none = deterministicRequirements('We are a friendly team building great products.');
    expect(none).toEqual([]);
  });

  it('marks experience listed as a nice-to-have as preferred', () => {
    const soft = deterministicRequirements(
      'Nice to have: 5 years of professional experience with Go.',
    );
    expect(soft.find((r) => r.kind === 'experience_years')?.necessity).toBe('preferred');
  });

  const necessityOf = (kind: string, text: string) =>
    deterministicRequirements(text).find((r) => r.kind === kind)?.necessity;

  /**
   * A softener sits after the phrase at least as often as before it, and postings park
   * their wishes under a heading and write the bullets underneath as flat statements.
   * Every one of these produced a hard experience requirement, which hid the internship
   * from a student with none while the quote shown beside the rejection said it was
   * optional.
   */
  it('reads a softener that follows the phrase, not only one in front of it', () => {
    expect(necessityOf('experience_years', '3+ years of professional experience is a plus.')).toBe(
      'preferred',
    );
    expect(necessityOf('experience_years', '2 years of relevant experience preferred.')).toBe(
      'preferred',
    );
    expect(
      necessityOf('experience_years', '4 years of experience, though this is not required.'),
    ).toBe('preferred');
  });

  it('reads "preferred" and "preferably", not just the bare stem "prefer"', () => {
    expect(necessityOf('experience_years', 'Preferred: 3 years of professional experience.')).toBe(
      'preferred',
    );
    expect(necessityOf('experience_years', 'Preferably 2 years of industry experience.')).toBe(
      'preferred',
    );
  });

  it('reads the heading a bullet sits under, however far above it', () => {
    const posting = [
      'Preferred qualifications:',
      '- Familiarity with Kubernetes and Docker containers in a production environment.',
      '- Experience with distributed tracing and observability tooling of any kind.',
      '- 3 years of professional experience.',
    ].join('\n');
    expect(necessityOf('experience_years', posting)).toBe('preferred');
  });

  /**
   * The shape a posting really arrives in. `stripHtml` replaces `</li>` with a newline and
   * every other tag with a space, so nothing marks a bullet and every item in a list is a
   * short line with no terminal punctuation — indistinguishable, to the old heading test,
   * from a heading. That made only the FIRST item under a heading softenable; from the
   * second item on, a preferred three-year line became a hard three-year requirement and
   * hid the internship from a student with none. Hand-written "- " bullets hid this,
   * because the bullet character alone was enough to tell the two apart.
   */
  it('softens every item under a heading, not just the first, on ATS markup', () => {
    const body = stripHtml(
      '<p>About the role</p><p>We are hiring a Software Engineering Intern.</p>' +
        '<p><strong>Minimum qualifications</strong></p>' +
        '<ul><li>Currently pursuing a Bachelor&rsquo;s degree</li></ul>' +
        '<p><strong>Preferred qualifications</strong></p>' +
        '<ul><li>Experience with Python</li><li>Strong communication skills</li>' +
        '<li>3+ years of experience with backend systems</li></ul>',
    );
    expect(body).not.toMatch(/[-*•]\s/); // no bullet markers survive the strip
    const years = deterministicRequirements(body).find((r) => r.kind === 'experience_years');
    expect(years?.necessity).toBe('preferred');
    // And the sentence stored beside it is the line that states it, not the whole section.
    expect(years?.sourceQuote).toBe('3+ years of experience with backend systems');
  });

  it('softens a preferred item wherever it sits in its section', () => {
    const at = (position: number) => {
      const lines = ['Preferred qualifications'];
      for (let i = 0; i < position; i++) lines.push(`Familiarity with tool number ${i}`);
      lines.push('3 years of professional experience');
      return necessityOf('experience_years', lines.join('\n'));
    };
    expect(at(0)).toBe('preferred');
    expect(at(1)).toBe('preferred');
    expect(at(4)).toBe('preferred');
  });

  it('still reads a genuinely stated experience requirement as required', () => {
    expect(
      necessityOf(
        'experience_years',
        'Minimum qualifications\nA degree in progress\n3 years of professional experience',
      ),
    ).toBe('required');
    expect(
      necessityOf('experience_years', 'Requirements:\n- 3 years of professional experience.'),
    ).toBe('required');
    expect(necessityOf('experience_years', 'Candidates must have 5 years of experience.')).toBe(
      'required',
    );
  });

  /**
   * A degree level is as often a wish as a rule, and hardcoding every one as required
   * hard-failed undergraduates on postings that had just told them to apply anyway.
   */
  it('marks a degree level the posting only prefers as preferred', () => {
    expect(necessityOf('education_level', "Master's degree preferred.")).toBe('preferred');
    expect(necessityOf('education_level', 'PhD candidates preferred but not required.')).toBe(
      'preferred',
    );
    expect(
      necessityOf('education_level', 'We welcome all levels; graduate students preferred.'),
    ).toBe('preferred');
    expect(necessityOf('education_level', "A Bachelor's degree in CS is required.")).toBe(
      'required',
    );
  });

  /**
   * A "Graduate Program" is the name of an employer's entry-level scheme, not a statement
   * about degrees — discovery/normalize.ts reads the same two words as `new_grad`. Reading
   * them as a master's requirement meant the friendliest new-grad postings on the board
   * hard-failed every undergraduate who saw them. The assertion is that no education_level
   * requirement is produced at all, not merely that it does not fail anyone: a requirement
   * that exists can be failed on later.
   */
  it('does not read a "Graduate Program" as a demand for a graduate degree', () => {
    for (const text of [
      'Join our 2027 Graduate Program in Software Engineering. We hire final-year students.',
      'Our Graduate Programme welcomes final-year undergraduates.',
      'Applications are open for the 2027 Graduate Program.',
    ]) {
      expect(
        deterministicRequirements(text).filter((r) => r.kind === 'education_level'),
        text,
      ).toEqual([]);
    }
  });

  it('still reads the words that can only mean graduate school', () => {
    for (const text of [
      'Must be enrolled in a graduate degree program.',
      'Applicants should be pursuing a graduate degree.',
      'Open to graduate students only.',
      'Applicants must be in graduate school.',
    ]) {
      expect(
        deterministicRequirements(text).find((r) => r.kind === 'education_level')?.value,
        text,
      ).toEqual({ levels: ['master'] });
    }
  });

  /**
   * "With or without sponsorship" contains "without sponsorship" and was read as a
   * refusal, so a posting that went out of its way to invite people who need a visa was
   * hidden from precisely those people. Both directions matter here: the `without` branch
   * has to keep matching, because "authorized to work in the US without sponsorship" is a
   * genuine refusal and just as common.
   */
  const refusesSponsorship = (text: string) =>
    deterministicRequirements(text).some(
      (r) =>
        r.kind === 'work_auth' &&
        (r.value as { sponsorshipUnavailable?: boolean }).sponsorshipUnavailable === true,
    );

  it('does not read an invitation to visa holders as a refusal to sponsor', () => {
    const invitations = [
      'We will consider qualified applicants with or without the need for visa sponsorship.',
      'This position is open to candidates with or without sponsorship.',
      'Open to students with or without the need for sponsorship, now or in the future.',
      'Applicants with or without sponsorship needs are encouraged to apply.',
    ];
    for (const text of invitations) expect(refusesSponsorship(text), text).toBe(false);
  });

  it('still finds a genuine refusal to sponsor', () => {
    const refusals = [
      'We do not provide visa sponsorship.',
      'You must be authorized to work in the US without sponsorship.',
      'Candidates must be able to work without the need for sponsorship now or in the future.',
      'We are unable to offer visa sponsorship for this role.',
      'No visa sponsorship is available.',
    ];
    for (const text of refusals) expect(refusesSponsorship(text), text).toBe(true);
  });

  /**
   * Half of employers write this with "sponsorship" as the noun and half with "sponsor" as
   * the verb. The verb branch was spliced into the noun one, where it could only ever have
   * fired on the string "sponsor sponsorship" — so every phrasing below produced no
   * work-authorization requirement at all, and a student who needs a visa was shown a
   * posting whose own first line rules her out, with nothing to warn her.
   */
  it('reads "sponsor" as a verb, not only "sponsorship" as a noun', () => {
    const refusals = [
      'We are unable to sponsor visas for this position.',
      'The company does not sponsor employment visas.',
      'We will not sponsor applicants for work visas.',
      'This employer does not sponsor H-1B visas.',
      'Acme cannot sponsor visas.',
      'We are not able to sponsor candidates for employment visas.',
      'Candidates must not require sponsorship now or in the future.',
    ];
    for (const text of refusals) expect(refusesSponsorship(text), text).toBe(true);
  });

  it('does not read sponsoring an event as a refusal to sponsor a visa', () => {
    expect(refusesSponsorship('We sponsor local hackathons and student conferences.')).toBe(false);
    expect(refusesSponsorship('We do not sponsor conferences or hackathons.')).toBe(false);
  });

  /**
   * "U.S. citizenship or permanent residency is required" welcomes green-card holders, but
   * a citizenship requirement can only carry a list of countries, so recording it as
   * US-only told a lawful permanent resident they did not qualify for a posting that names
   * them in the same breath. What the posting is really saying is that you must already be
   * able to work here, which the rules deliberately never fail anyone on.
   */
  const citizenshipCountriesFor = (text: string) =>
    deterministicRequirements(text).find(
      (r) => r.kind === 'citizenship' && (r.value as { countries?: string[] }).countries,
    );

  it('does not demand citizenship of a posting that also accepts permanent residents', () => {
    for (const text of [
      'U.S. citizenship or permanent residency is required for this role.',
      'Applicants must be a U.S. citizen or permanent resident.',
      'US citizenship or green card required.',
      'Candidates must hold U.S. citizenship or lawful permanent residence.',
    ]) {
      expect(citizenshipCountriesFor(text), text).toBeUndefined();
      expect(
        deterministicRequirements(text).some(
          (r) =>
            r.kind === 'work_auth' &&
            (r.value as { requiresExistingAuthorization?: boolean }).requiresExistingAuthorization,
        ),
        text,
      ).toBe(true);
    }
  });

  it('still demands citizenship when that is all the posting accepts', () => {
    expect(citizenshipCountriesFor('U.S. citizenship is required.')?.value).toEqual({
      countries: ['US'],
    });
    expect(citizenshipCountriesFor('U.S. citizenship is not required.')).toBeUndefined();
  });

  /**
   * A posting that names a second, non-citizen way to be hireable is not a US-only posting.
   * Permanent residence was the only alternative this knew, so "or otherwise authorized to
   * work in the United States" — the commonest form of the sentence by a distance — became
   * a hard citizenship requirement and told a student on OPT she was ineligible, quoting
   * the sentence that includes her.
   */
  it('reads a work-authorization alternative the same way as a green card', () => {
    for (const text of [
      'Applicants must be a U.S. citizen or otherwise authorized to work in the United States.',
      'Must be a U.S. citizen or have permanent work authorization.',
      'Must be a U.S. citizen or eligible to work in the United States.',
      'Must be a U.S. citizen or legally able to work in the U.S.',
      'Open to U.S. citizens or anyone with the right to work in the US.',
    ]) {
      expect(citizenshipCountriesFor(text), text).toBeUndefined();
      expect(
        deterministicRequirements(text).some(
          (r) =>
            r.kind === 'work_auth' &&
            (r.value as { requiresExistingAuthorization?: boolean }).requiresExistingAuthorization,
        ),
        text,
      ).toBe(true);
    }
  });

  /**
   * "citizen(?:ship)?" cannot match "citizens" — the word boundary lands on the "s" — so a
   * posting restricted to US citizens produced no restriction at all and was shown as
   * eligible to someone who cannot be hired for it.
   */
  it('reads the plural "citizens", not only the singular', () => {
    for (const text of [
      'This position is open only to U.S. citizens.',
      'Applicants must be United States citizens.',
      'Candidates must be US citizens due to federal contract requirements.',
    ]) {
      expect(citizenshipCountriesFor(text)?.value, text).toEqual({ countries: ['US'] });
    }
    // The plural must not walk past the guards that protect the singular.
    expect(citizenshipCountriesFor('U.S. citizens are not required to apply.')).toBeUndefined();
    expect(
      citizenshipCountriesFor('Open to U.S. citizens and permanent residents.'),
    ).toBeUndefined();
  });

  /**
   * "or" and "nor" keep one statement going, and the negation stated once at the front
   * governs everything after them. Reading each alternative as its own clause put the
   * cancelling word out of view, and these sentences — written to tell a student that
   * nothing stands in her way — produced the two requirements hardest to fail: a US-only
   * citizenship requirement and a security clearance.
   */
  it('does not manufacture a requirement out of a sentence that waives two things at once', () => {
    for (const text of [
      'Neither U.S. citizenship nor a security clearance is required for this role.',
      'U.S. citizenship or work authorization is not required.',
      'No US citizenship or security clearance is required for this role.',
      'Neither sponsorship nor an active clearance is required.',
      'We do not require U.S. citizenship or a security clearance.',
    ]) {
      expect(
        deterministicRequirements(text).filter((r) => r.kind === 'citizenship'),
        text,
      ).toEqual([]);
    }
  });

  /**
   * The enrolment phrase survives its own negation — "you do not need to be currently
   * enrolled" contains it — so a recent graduate was filtered out by the exact sentence
   * written to invite them. The guard reads only as far back as the start of the clause,
   * because a "not" belonging to an earlier clause must not throw away a real requirement.
   */
  const requiresEnrollment = (text: string) =>
    deterministicRequirements(text).some((r) => r.kind === 'enrollment');

  it('does not invent an enrolment requirement from a sentence waiving one', () => {
    const waived = [
      'You do not need to be currently enrolled in a degree program.',
      'Applicants need not be currently enrolled in a degree program.',
      'Recent graduates are welcome; you do not have to be enrolled in a program.',
      'This role is open to candidates not enrolled in a university program.',
    ];
    for (const text of waived) expect(requiresEnrollment(text), text).toBe(false);
  });

  it('still finds a real enrolment requirement after an unrelated negation', () => {
    const stated = [
      'Candidates must be currently enrolled in a degree program.',
      'We do not offer relocation; candidates must be currently enrolled in a degree program.',
      'Interns must be enrolled in an accredited university and will not be considered otherwise.',
    ];
    for (const text of stated) expect(requiresEnrollment(text), text).toBe(true);
  });

  /**
   * The waiver is usually written as a list — "you do not need to be enrolled OR returning
   * to school" — and reading the second half on its own left the "not" one word out of
   * reach. Both halves of each of these has to stay waived: the single-phrase control
   * already worked, and the fix has to hold for the second phrase without breaking it.
   */
  it('carries a negation across an "or" to the phrase on the far side of it', () => {
    for (const text of [
      'You do not need to be currently enrolled in a degree program.',
      'You do not need to be currently enrolled in a degree program or returning to school after the internship.',
      'Applicants need not be currently enrolled in or pursuing at a university.',
      'Graduating seniors are welcome; you do not have to be returning to school or currently enrolled in classes.',
      'You do not need to be enrolled in a degree program, or returning to school.',
    ]) {
      expect(requiresEnrollment(text), text).toBe(false);
    }
  });

  /** Each window a posting names is an alternative, so all of them have to reach the rules. */
  it('keeps every graduation window a posting states', () => {
    const windows = deterministicRequirements(
      'Juniors graduating between December 2026 and June 2027 are eligible. ' +
        'Sophomores graduating between December 2027 and June 2028 are also eligible.',
    ).filter((r) => r.kind === 'graduation_window');

    expect(windows.map((w) => w.value)).toEqual([
      { from: '2026-12', to: '2027-06' },
      { from: '2027-12', to: '2028-06' },
    ]);
  });

  /**
   * A clearance requirement is one of the few things that can genuinely disqualify a
   * student, so both directions of this matter: inventing one contradicts the quote shown
   * beside it, and dropping a real one hides the reason a posting is out of reach.
   *
   * The negation guard has to end at a clause, not a sentence. Scanning back to the last
   * full stop meant any unrelated "no", "not" or "without" earlier in the same sentence
   * suppressed a real requirement — and job descriptions are full of them.
   */
  const clearanceOf = (text: string) =>
    deterministicRequirements(text).find(
      (r) =>
        r.kind === 'citizenship' && (r.value as { clearanceRequired?: boolean }).clearanceRequired,
    );

  it('still finds a clearance requirement after an unrelated negation in the same sentence', () => {
    expect(
      clearanceOf(
        'This role does not offer relocation, and an active security clearance is required.',
      ),
      'negation belongs to relocation, not to the clearance',
    ).toBeDefined();
    expect(
      clearanceOf('Sponsorship is not available; security clearance is required.'),
      'the semicolon ends the negated clause',
    ).toBeDefined();
  });

  it('does not invent a clearance requirement from a sentence denying one', () => {
    expect(clearanceOf('No security clearance is required for this role.')).toBeUndefined();
    expect(clearanceOf('This position does not require a security clearance.')).toBeUndefined();
  });
});

describe('value validation', () => {
  it('accepts well-formed values', () => {
    expect(validateValue('age', { min: 18 }).ok).toBe(true);
    expect(validateValue('graduation_window', { from: '2027-12' }).ok).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(validateValue('age', { min: 'eighteen' }).ok).toBe(false);
    expect(validateValue('graduation_window', { from: 'December 2027' }).ok).toBe(false);
    expect(validateValue('nonsense_kind', {}).ok).toBe(false);
  });
});

describe('end-to-end extraction without a model', () => {
  it('produces guarded requirements from the regex pass alone', async () => {
    const result = await extractRequirements('p1', JD, { useModel: false });

    expect(result.usedModel).toBe(false);
    expect(result.requirements.length).toBeGreaterThan(3);

    for (const r of result.requirements) {
      expect(r.postingId).toBe('p1');
      expect(verifyQuote(r.sourceQuote, JD).ok).toBe(true);
      expect(r.confidence).toBeGreaterThan(0);
    }

    const kinds = new Set(result.requirements.map((r) => r.kind));
    expect(kinds.has('age')).toBe(true);
    expect(kinds.has('work_auth')).toBe(true);
    expect(kinds.has('graduation_window')).toBe(true);
  });

  it('returns an empty set rather than inventing requirements', async () => {
    const result = await extractRequirements('p2', 'Join our team. We like building things.', {
      useModel: false,
    });
    expect(result.requirements).toEqual([]);
  });

  /**
   * The guards can only discard or soften, never invent, so a posting whose only
   * sponsorship sentence is an invitation must come out of the whole pipeline with no
   * work-authorization requirement attached to it at all.
   */
  it('extracts no sponsorship requirement from a posting that invites visa holders', async () => {
    const welcoming =
      'Software Engineering Intern, Summer 2027.\n' +
      'We will consider qualified applicants with or without the need for visa sponsorship.';
    const result = await extractRequirements('p4', welcoming, { useModel: false });
    expect(result.requirements.filter((r) => r.kind === 'work_auth')).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('does not emit the same requirement twice', async () => {
    const repeated = `${JD}\n\nReminder: we do not provide visa sponsorship.`;
    const result = await extractRequirements('p3', repeated, { useModel: false });
    const sponsorship = result.requirements.filter(
      (r) =>
        r.kind === 'work_auth' && JSON.stringify(r.value) === '{"sponsorshipUnavailable":true}',
    );
    expect(sponsorship).toHaveLength(1);
  });
});

describe('a long posting must not stall the server', () => {
  /**
   * A single-paragraph description is the shape that hurt: `sentenceSpan` asked for the newline
   * after each match, found none, and walked to the end of the document — once per candidate
   * requirement, with the candidate count itself rising with the length. Measured before the
   * fix: 45KB took 288ms and 180KB took 16.4 SECONDS. The server is single-threaded, so that is
   * 16 seconds in which nothing else it was asked to do happens, and nobody has to be malicious
   * for a posting to get that long — an employer pasting a handbook into the description field
   * is enough, and nothing upstream caps the length.
   *
   * WHAT THIS ASSERTS IS THE SHAPE OF THE CURVE, NOT A STOPWATCH READING. It was written as a
   * wall-clock bound first, with what looked like two orders of magnitude of headroom, and it
   * failed at 38 SECONDS on work that takes 15ms — the suite was sharing the machine with a
   * dozen other processes. Quadruple the input and linear work takes about 4 times as long
   * while quadratic work takes about 16; a loaded machine slows both by the same factor, so the
   * ratio survives what the clock cannot.
   */
  it('costs about four times as much for four times the text, not sixteen', () => {
    const growth = measureGrowth(
      (multiplier, salt) =>
        `${salt} ` + 'Applicants must be at least 18 years of age. '.repeat(4000 * multiplier),
      (text) => deterministicRequirements(text),
    );
    expect(
      growth.ratio,
      `${growth.small.toFixed(1)}ms -> ${growth.large.toFixed(1)}ms`,
    ).toBeLessThan(LINEAR_CEILING);
  }, 60_000);

  it('still reads every requirement out of the long version', () => {
    // The ratio above would also be satisfied by a function that got fast by doing nothing.
    const huge = 'Applicants must be at least 18 years of age. '.repeat(4000);
    expect(deterministicRequirements(huge).length).toBeGreaterThan(0);
  }, 60_000);

  /**
   * The shape with NO full stop and NO newline anywhere, which is the one that kept hurting.
   *
   * Three separate windows were open-ended in that case and each was quadratic on its own:
   * `sentenceSpan`'s start ran back to position zero, `softenerWindow`'s end ran to the end of
   * the document, and `clauseBounds` returned the whole text because a description with no
   * punctuation and no conjunction contains no clause breaks — and every caller SLICES that
   * span and runs a regex over it. Fixing the first two left the third: 352KB still took 6.1
   * seconds. It is not an exotic shape. `stripHtml` turns a run of `<li>` into lines with no
   * terminal punctuation, and a board that emits one `<p>` for the whole description produces
   * exactly it.
   */
  it('costs about four times as much for four times of it, with no punctuation at all', () => {
    const growth = measureGrowth(
      (multiplier, salt) =>
        `${salt} ` + 'Applicants must be at least 18 years of age '.repeat(4000 * multiplier),
      (text) => deterministicRequirements(text),
    );
    expect(
      growth.ratio,
      `${growth.small.toFixed(1)}ms -> ${growth.large.toFixed(1)}ms`,
    ).toBeLessThan(LINEAR_CEILING);
  }, 60_000);

  /**
   * The quote is the EVIDENCE. It has to contain the thing it is evidence for.
   *
   * `sentenceAround` returns `slice(start, end).trim().slice(0, 400)`, and `start` was "just
   * after the last full stop or newline at or before the match" — which on a description
   * containing neither is position zero. So the quote was the first 400 characters of the
   * document, and a student ruled out for being under 18 was shown "We are hiring interns for
   * many teams this year..." as the reason they were ruled out. `verifyQuote` cannot catch it:
   * that text really does appear in the posting, which is all it checks.
   */
  it('quotes text that contains the requirement, even with nothing to break the line', () => {
    const filler = 'We are hiring interns for many teams this year and it is going to be great ';
    const found = deterministicRequirements(
      filler.repeat(60) + 'Applicants must be at least 18 years of age',
    );
    expect(found.length).toBeGreaterThan(0);
    for (const r of found) {
      expect(r.sourceQuote, `${r.kind} cites text that does not contain it`).toMatch(
        /18 years of age/,
      );
      // And still verifiable against the posting, which is the other half of the contract.
      expect(
        verifyQuote(
          r.sourceQuote,
          filler.repeat(60) + 'Applicants must be at least 18 years of age',
        ).ok,
      ).toBe(true);
    }
  });

  it('reads a description with no newline in it the same way as one with', () => {
    const JOINED = [
      'Applicants must be at least 18 years of age.',
      'U.S. citizenship is required for this position.',
      'We do not provide visa sponsorship.',
    ];
    const spaced = deterministicRequirements(JOINED.join(' '));
    const lined = deterministicRequirements(JOINED.join('\n'));
    expect(spaced.map((r) => r.kind).sort()).toEqual(lined.map((r) => r.kind).sort());
    expect(spaced.map((r) => r.necessity)).toEqual(lined.map((r) => r.necessity));
  });
});
