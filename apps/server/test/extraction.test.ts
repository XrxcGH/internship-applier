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
