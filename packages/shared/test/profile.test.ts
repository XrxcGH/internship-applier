import { describe, expect, it } from 'vitest';
import { bulletlessExperience, lostTheEvidence, workLocations } from '../src/profile';

/**
 * The question "did the reader keep the titles and drop the substance?"
 *
 * `bullets` is the evidence corpus. A generated sentence about an entry can only be traced to
 * a line under that entry, and gate G3 refuses a sentence it cannot trace, with no override —
 * so an extraction that comes back the right shape with no lines in it produces a profile
 * whose owner cannot write a checkable sentence about anything they have done. On screen that
 * reads as a healthy "27 entries" unless something asks this question.
 *
 * Both G1 surfaces read this one function: the server raises `experience.bullets` from it and
 * the wizard shows the paragraph explaining what it costs. Two copies of the threshold would
 * be two answers to one question about one profile.
 */

const bare = (n: number): Array<{ bullets: string[] }> =>
  Array.from({ length: n }, () => ({ bullets: [] }));

const full = (n: number): Array<{ bullets: string[] }> =>
  Array.from({ length: n }, () => ({ bullets: ['Did the thing'] }));

describe('bulletlessExperience', () => {
  it('counts the entries carrying nothing', () => {
    expect(bulletlessExperience([...bare(26), ...full(1)])).toBe(26);
    expect(bulletlessExperience(full(4))).toBe(0);
    expect(bulletlessExperience([])).toBe(0);
  });
});

describe('lostTheEvidence', () => {
  it('fires on the reading this was written for', () => {
    // Twenty-seven entries carrying one line between them. The first version of this check
    // was `every(e => e.bullets.length === 0)`, which called that profile fine — the screen
    // said "27 entries · 1 line of detail" with no notice beside it and nothing flagged.
    expect(lostTheEvidence([...bare(26), ...full(1)])).toBe(true);
  });

  it('fires when nothing at all came through', () => {
    expect(lostTheEvidence(bare(5))).toBe(true);
  });

  it('leaves an ordinary mixed resume alone', () => {
    // Half the entries being one-liners is a resume, not a reading failure. Nagging here
    // would put a caution on the G1 screen of nearly every student who uses this.
    expect(lostTheEvidence([...bare(5), ...full(5)])).toBe(false);
    expect(lostTheEvidence(full(10))).toBe(false);
  });

  it('says nothing below three entries, where the fraction means nothing', () => {
    // One bare entry out of one is an ordinary line on an ordinary resume, and calling it a
    // failed reading would be the app inventing an alarm out of a sample of one.
    expect(lostTheEvidence([])).toBe(false);
    expect(lostTheEvidence(bare(1))).toBe(false);
    expect(lostTheEvidence(bare(2))).toBe(false);
    expect(lostTheEvidence(bare(3))).toBe(true);
  });

  it('turns over at four fifths, counted the same way at every size', () => {
    expect(lostTheEvidence([...bare(8), ...full(2)])).toBe(true);
    expect(lostTheEvidence([...bare(7), ...full(3)])).toBe(false);
    expect(lostTheEvidence([...bare(80), ...full(20)])).toBe(true);
    expect(lostTheEvidence([...bare(79), ...full(21)])).toBe(false);
  });
});

describe('workLocations', () => {
  /**
   * A student is routinely reachable from more than one city — home over the summer, campus
   * during term — and the profile held exactly one. Everything downstream read that single
   * city as the whole answer, so a posting in their own college town came back "not your
   * home city", scored 0.4, and was never searched for in the first place.
   */
  const prefs = (over = {}) => ({
    base: { city: 'Half Moon Bay', region: 'CA', country: 'US' },
    additionalBases: [],
    maxCommuteKm: 50,
    remoteOk: true,
    hybridOk: true,
    relocateTo: [],
    ...over,
  });

  it('treats the home address and every added place as equals', () => {
    expect(
      workLocations(
        prefs({
          additionalBases: [
            { city: 'Los Angeles', region: 'CA', country: 'US', label: 'school' },
            { city: 'Austin', region: 'TX', country: 'US' },
          ],
        }),
      ),
    ).toEqual([
      { city: 'Half Moon Bay', region: 'CA' },
      { city: 'Los Angeles', region: 'CA' },
      { city: 'Austin', region: 'TX' },
    ]);
  });

  it('drops a place with nothing in it, because an empty one matches everything', () => {
    // `label.includes('')` is true for every posting on earth, which is how a blank home
    // city once passed EVERY posting as "within your commute area".
    expect(
      workLocations(prefs({ additionalBases: [{ city: '  ', region: ' ', country: 'US' }] })),
    ).toEqual([{ city: 'Half Moon Bay', region: 'CA' }]);
  });

  it('drops a place that states only a state, because nothing can match one', () => {
    // Not "half an answer is still an answer": every reader compares on the city and discards
    // a row without one, so returning it promised the caller a place nothing then searched.
    // Region alone cannot be substring-matched safely either — 'sunnyvale ca'.includes('ny').
    expect(
      workLocations(prefs({ additionalBases: [{ city: '', region: 'NY', country: 'US' }] })),
    ).toEqual([{ city: 'Half Moon Bay', region: 'CA' }]);
  });

  it('is just the base when nothing was added', () => {
    expect(workLocations(prefs())).toEqual([{ city: 'Half Moon Bay', region: 'CA' }]);
  });
});
