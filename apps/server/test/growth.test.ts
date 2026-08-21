import { describe, expect, it } from 'vitest';
import { LINEAR_CEILING, measureGrowth } from './support/growth';

/**
 * The instrument the performance tests are built on.
 *
 * Two of those tests were wrong before this existed — a wall-clock bound that failed at 38
 * seconds on work taking 15ms, and a ratio measured at a size where the allocator rather than
 * the algorithm dominates. A measuring tool nothing measures is how that happens twice.
 */
describe('measureGrowth', () => {
  /** Deliberately quadratic: for each character, scan the whole string. */
  const quadratic = (s: string): number => {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.indexOf('\u0000', i) === -1) n++;
    return n;
  };

  /** Deliberately linear. */
  const linear = (s: string): number => {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 60) n++;
    return n;
  };

  const build = (units: number) => (m: number, salt: string) => salt + '<'.repeat(units * m);

  it('separates quadratic work from linear work', () => {
    // The whole point: the two must land on opposite sides of LINEAR_CEILING, or the tests
    // built on this are measuring nothing. Linear is about 4 and quadratic about 16.
    const slow = measureGrowth(build(20_000), quadratic, { bailAboveMs: 60_000 });
    const fast = measureGrowth(build(200_000), linear);

    expect(fast.ratio, `linear measured ${fast.ratio.toFixed(1)}`).toBeLessThan(LINEAR_CEILING);
    expect(slow.ratio, `quadratic measured ${slow.ratio.toFixed(1)}`).toBeGreaterThan(
      LINEAR_CEILING,
    );
  }, 120_000);

  it('bails on the small case rather than running the 4x one', () => {
    // The bail exists so a regression fails in seconds rather than minutes: the large case
    // would take roughly sixteen times as long to say what the small one already said. It is
    // checked after EVERY run, not once at the end, because a run over the line cannot come
    // back under it.
    let largestSeen = 0;
    let runs = 0;
    const work = (s: string): void => {
      runs++;
      largestSeen = Math.max(largestSeen, s.length);
      const until = performance.now() + 30;
      while (performance.now() < until) {
        /* burn */
      }
    };

    expect(() => measureGrowth(build(10), work, { bailAboveMs: 10 })).toThrow(
      /the small input alone took/,
    );
    // The 4x input was never built, so the largest string it saw is the small one.
    expect(largestSeen).toBeLessThan(build(10)(4, '').length);
    // And it stopped after the FIRST run rather than completing all five. Checking the bail
    // only at the end still throws, so the outer assertion above cannot tell the two apart —
    // this is the one that holds the early return, and the early return is the whole reason a
    // regression now fails in seconds instead of a minute.
    expect(runs).toBe(1);
  }, 60_000);

  it('gives each measurement a distinct input, so a memo cannot answer for the work', () => {
    // Several of the functions under test memoize per string. Handing the same one back would
    // measure the cache.
    const seen: string[] = [];
    measureGrowth(build(4), (s) => seen.push(s));
    expect(new Set(seen).size).toBe(seen.length);
  });
});
