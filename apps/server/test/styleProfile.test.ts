import { describe, expect, it } from 'vitest';
import {
  computeStyleProfile,
  describeStyle,
  sampleAdequacy,
  sentences,
  words,
} from '../src/core/writing/styleProfile';

const NOW = new Date('2026-08-03T00:00:00Z');

/** Varied sentence length, contractions, em-dashes — how a person actually writes. */
const HUMAN = `
I didn't expect to like databases. I really didn't.

But the first time I watched a query planner pick a completely different strategy because
I'd added one index — that was the moment it clicked for me, and I've been chasing that
feeling since. Storage engines are just an elaborate argument about what you're willing to
give up. Speed? Space? Correctness under concurrency? Pick two, mostly.

So I built a toy key-value store. It's bad! It leaks memory under load and the WAL
implementation is embarrassing. But I understand B-trees now in a way no textbook gave me.
`.trim();

/** Uniform sentence length, no contractions, formal register — the machine tell. */
const UNIFORM = `
The candidate demonstrates significant proficiency in multiple programming languages.
The candidate additionally possesses considerable experience with database technologies.
Furthermore the candidate exhibits substantial understanding of distributed architectures.
Moreover the candidate maintains extensive familiarity with contemporary methodologies.
`.trim();

describe('text segmentation', () => {
  it('splits sentences without tripping on abbreviations', () => {
    expect(sentences('I met Dr. Smith. He was late.')).toHaveLength(2);
    expect(sentences('I work at Acme Inc. It is fine.')).toHaveLength(2);
    expect(sentences('She has a Ph.D. in physics. I do not.')).toHaveLength(2);
    expect(sentences('Ship it, e.g. tomorrow. Or later.')).toHaveLength(2);
  });

  it('still splits on genuine sentence ends', () => {
    expect(sentences('One. Two. Three.')).toHaveLength(3);
  });

  it('counts words with apostrophes as one word', () => {
    expect(words("don't stop")).toEqual(["don't", 'stop']);
  });
});

describe('computeStyleProfile', () => {
  const human = computeStyleProfile([{ id: 's1', content: HUMAN }], NOW);
  const uniform = computeStyleProfile([{ id: 's2', content: UNIFORM }], NOW);

  /**
   * The headline metric. Uniform sentence length is the loudest tell of generated prose,
   * so the measure has to separate these two clearly or it isn't worth having.
   */
  it('separates varied human rhythm from uniform machine rhythm', () => {
    expect(human.sentenceLengthStdev).toBeGreaterThan(uniform.sentenceLengthStdev * 2);
  });

  it('detects contraction use', () => {
    expect(human.contractionRate).toBeGreaterThan(1);
    expect(uniform.contractionRate).toBe(0);
  });

  /**
   * The sample deliberately contains words like "implementation" and "concurrency", so
   * "mixed" is the honest reading — the meaningful distinction is that it is not formal.
   */
  it('detects register', () => {
    expect(human.vocabularyTier).not.toBe('formal');
    expect(uniform.vocabularyTier).toBe('formal');
  });

  it('picks up punctuation habits', () => {
    expect(human.punctuation.emDash).toBeGreaterThan(0);
    expect(human.punctuation.exclamation).toBeGreaterThan(0);
  });

  it('finds favoured transitions', () => {
    expect(uniform.favoredTransitions).toContain('furthermore');
    expect(human.favoredTransitions).toContain('but');
  });

  it('measures first-person density', () => {
    expect(human.firstPersonRate).toBeGreaterThan(uniform.firstPersonRate);
  });

  it('records which samples it was built from', () => {
    const p = computeStyleProfile(
      [
        { id: 'a', content: HUMAN },
        { id: 'b', content: UNIFORM },
      ],
      NOW,
    );
    expect(p.sampleIds).toEqual(['a', 'b']);
    expect(p.computedAt).toBe(NOW.toISOString());
  });

  it('does not divide by zero on empty input', () => {
    const p = computeStyleProfile([{ id: 'x', content: '' }], NOW);
    expect(Number.isFinite(p.meanSentenceLength)).toBe(true);
    expect(Number.isFinite(p.sentenceLengthStdev)).toBe(true);
  });
});

describe('adequacy and description', () => {
  it('is honest about thin input', () => {
    expect(sampleAdequacy(0).level).toBe('none');
    expect(sampleAdequacy(120).level).toBe('thin');
    expect(sampleAdequacy(500).level).toBe('enough');
    expect(sampleAdequacy(2000).level).toBe('plenty');
  });

  it('describes the voice in plain language', () => {
    const lines = describeStyle(computeStyleProfile([{ id: 's1', content: HUMAN }], NOW));
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join(' ')).toMatch(/sentence/i);
  });
});
