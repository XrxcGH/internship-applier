/**
 * The shapes of the event contract that carry counts, and specifically that a count nobody
 * knows yet cannot be sent as a zero.
 *
 * `discovery.progress` fires while a source is still being fetched, before anything has been
 * compared against the stored postings, so "how many of these are new?" has no answer at that
 * moment. While the field was a plain integer the only thing a publisher could send was 0, and
 * a screen counting new postings as the run went along would have read zero for the whole run
 * — indistinguishable from a search that genuinely found nothing already-unseen.
 */
import { describe, expect, it } from 'vitest';
import { AppEvent } from '../src/events';

const progress = (n: unknown): Record<string, unknown> => ({
  type: 'discovery.progress',
  seq: 1,
  runId: 'r1',
  source: 'greenhouse:stripe',
  found: 12,
  new: n,
});

describe('discovery.progress', () => {
  it('accepts null for a count that is not known yet', () => {
    expect(AppEvent.safeParse(progress(null)).success).toBe(true);
  });

  it('still accepts a real count, for a publisher that has one', () => {
    expect(AppEvent.safeParse(progress(3)).success).toBe(true);
    expect(AppEvent.safeParse(progress(0)).success).toBe(true);
  });

  /**
   * The regression guard. If the field is made required-and-non-null again, "not known yet"
   * has to be spelled 0 once more and the zero stops meaning zero.
   */
  it('will not let the field vanish, so the distinction has to be stated', () => {
    const missing = progress(null);
    delete missing['new'];
    expect(AppEvent.safeParse(missing).success).toBe(false);
    expect(AppEvent.safeParse(progress(undefined)).success).toBe(false);
  });

  it('rejects a non-integer count', () => {
    expect(AppEvent.safeParse(progress(1.5)).success).toBe(false);
    expect(AppEvent.safeParse(progress('3')).success).toBe(false);
  });
});

/**
 * `discovery.done` is where the true totals live, and it is the only place a consumer can
 * read them — so its own `new` stays a required integer. A null here would mean the run
 * finished without ever saying what it found.
 */
describe('discovery.done', () => {
  it('requires a real total, with no null escape', () => {
    const done = (n: unknown): Record<string, unknown> => ({
      type: 'discovery.done',
      seq: 2,
      runId: 'r1',
      summary: { sources: 2, found: 12, new: n, duplicates: 1, errors: 0, skipped: [] },
    });
    expect(AppEvent.safeParse(done(4)).success).toBe(true);
    expect(AppEvent.safeParse(done(null)).success).toBe(false);
  });
});
