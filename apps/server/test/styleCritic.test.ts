import { describe, expect, it } from 'vitest';
import { critiqueStyle, describeMatch } from '../src/core/writing/styleCritic';
import { computeStyleProfile } from '../src/core/writing/styleProfile';

/** Varied rhythm, contractions, plain words. */
const SAMPLES = `
I didn't expect to like databases. I really didn't.

But the first time I watched a query planner pick a completely different strategy because
I'd added one index, that was the moment it clicked, and I've been chasing that feeling
since. Storage engines are just an elaborate argument about what you're willing to give
up. Speed? Space? Pick two, mostly.

So I built a toy key-value store. It's bad! It leaks memory under load and the write-ahead
log is embarrassing. But I understand B-trees now in a way no textbook gave me.
`.trim();

const YOURS = computeStyleProfile([{ id: 's1', content: SAMPLES }]);

describe('style drift', () => {
  it('measures the user as matching their own writing', () => {
    const r = critiqueStyle(SAMPLES, YOURS);
    expect(r.drift).toEqual([]);
    expect(r.match).toBe(1);
    expect(describeMatch(r)).toContain('like your other writing');
  });

  it('catches uniform sentence rhythm', () => {
    const flat = `
The candidate demonstrates significant proficiency in multiple programming languages today.
The candidate additionally possesses considerable experience with database technologies now.
Furthermore the candidate exhibits substantial understanding of distributed architectures.
Moreover the candidate maintains extensive familiarity with contemporary methodologies here.
The candidate has consistently delivered measurable results across several technical teams.
Additionally the candidate approaches every problem with a structured analytical mindset.
The candidate would bring considerable value to any engineering organization going forward.
`.trim();

    const r = critiqueStyle(flat, YOURS);
    const variation = r.drift.find((d) => d.dimension === 'sentence_variation');
    expect(variation).toBeDefined();
    expect(variation!.note).toMatch(/flatter/);
    expect(r.match).toBeLessThan(0.6);
  });

  it('catches a formal register replacing a plain one', () => {
    const formal = `
I would like to articulate my substantial enthusiasm regarding this particular opportunity.
My academic preparation has furnished me with considerable analytical capabilities.
I anticipate contributing meaningfully to your organizational objectives going forward.
Additionally I possess demonstrable competencies across numerous technical domains.
`.trim();

    const r = critiqueStyle(formal, YOURS);
    expect(r.drift.map((d) => d.dimension)).toContain('contractions');
  });

  it('flags em dashes the user does not use', () => {
    const dashes = `
I built a small thing — a tide chart — and it worked. The first version — honestly — was
bad. I rewrote it — twice — before it felt right. That's the whole story, more or less.
The hard part wasn't the tides — it was the caching — because kayakers have no signal out
there. I read the NOAA docs — all of them — over a weekend I'd rather have spent outside.
`.trim();

    const r = critiqueStyle(dashes, YOURS);
    expect(r.drift.map((d) => d.dimension)).toContain('em_dash');
  });

  it('does not flag a draft for using FEWER em dashes than the user', () => {
    const plain = `
I built a small tide chart and it worked. The first version was bad, honestly. I rewrote
it twice before it felt right. That's the whole story, more or less. The hard part wasn't
the tides, it was the caching, because kayakers have no signal out there. I read the NOAA
docs over a weekend I'd rather have spent outside.
`.trim();

    const r = critiqueStyle(plain, YOURS);
    expect(r.drift.map((d) => d.dimension)).not.toContain('em_dash');
  });

  it('flags bullets when the user writes prose', () => {
    const bulleted = `
Here is what I did:

- Built a key-value store from scratch over one winter.
- Learned why write-ahead logs exist the hard way.
- Rewrote the whole storage layer twice before it held up.
- Shipped it to nobody in particular, which was fine.
`.trim();

    const r = critiqueStyle(bulleted, YOURS);
    expect(r.drift.map((d) => d.dimension)).toContain('lists');
  });
});

describe('honest refusal to measure', () => {
  it('says so rather than scoring a one-liner', () => {
    const r = critiqueStyle('I built a tide chart.', YOURS);
    expect(r.tooShort).toBe(true);
    expect(r.drift).toEqual([]);
    expect(describeMatch(r)).toContain('Too short');
  });

  it('reports no drift when there is no measured voice to compare against', () => {
    const r = critiqueStyle(SAMPLES, undefined);
    expect(r.drift).toEqual([]);
    expect(r.match).toBe(1);
  });
});
