import { describe, expect, it } from 'vitest';
import { guardQuotes, normalizeForQuoteMatch, verifyQuote } from '../src/core/matching/quoteGuard';
import {
  deterministicRequirements,
  extractRequirements,
} from '../src/core/matching/extractRequirements';
import { validateValue } from '../src/core/matching/requirementValues';

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

  it('still reads a genuinely stated experience requirement as required', () => {
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
