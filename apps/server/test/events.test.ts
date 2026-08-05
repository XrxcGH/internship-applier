/**
 * The event contract, and specifically that no fill outcome can vanish from it.
 *
 * `fill.done` is the last thing a stream consumer ever hears about a run. When it carried
 * only `filled` and `skipped`, a run that typed five values and had three of them rejected
 * by the page on read-back signed off as "5 filled, 0 skipped" — the counts that carried
 * the bad news had nowhere to go. A read-back mismatch is the signal that catches a
 * silently wrong fill, so it is the one outcome that must never be the one dropped.
 */
import { describe, expect, it } from 'vitest';
import { AppEvent } from '@ia/shared';
import { events, publish } from '../src/infra/events';

describe('fill.step', () => {
  it('carries a mismatch as a mismatch', () => {
    const parsed = AppEvent.safeParse({
      type: 'fill.step',
      seq: 1,
      applicationId: 'a1',
      field: 'Phone',
      status: 'mismatch',
      note: 'The page shows "555" instead.',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts each of the four outcomes and nothing else', () => {
    for (const status of ['ok', 'mismatch', 'skipped', 'failed']) {
      const r = AppEvent.safeParse({
        type: 'fill.step',
        seq: 1,
        applicationId: 'a1',
        field: 'Phone',
        status,
      });
      expect(r.success, status).toBe(true);
    }
    expect(
      AppEvent.safeParse({
        type: 'fill.step',
        seq: 1,
        applicationId: 'a1',
        field: 'Phone',
        status: 'partial',
      }).success,
    ).toBe(false);
  });
});

describe('fill.done', () => {
  it('has a home for every outcome', () => {
    const parsed = AppEvent.safeParse({
      type: 'fill.done',
      seq: 2,
      applicationId: 'a1',
      filled: 5,
      mismatched: 3,
      failed: 1,
      skipped: 2,
    });
    expect(parsed.success).toBe(true);
  });

  /**
   * The regression guard. If someone narrows this back to filled + skipped, the mismatched
   * and failed counts stop being carried and this fails rather than the news quietly
   * stopping reaching anyone.
   */
  it('refuses a payload that drops the counts carrying bad news', () => {
    for (const missing of ['mismatched', 'failed', 'skipped']) {
      const payload: Record<string, unknown> = {
        type: 'fill.done',
        seq: 2,
        applicationId: 'a1',
        filled: 5,
        mismatched: 3,
        failed: 1,
        skipped: 2,
      };
      delete payload[missing];
      expect(AppEvent.safeParse(payload).success, `without ${missing}`).toBe(false);
    }
  });
});

describe('the bus', () => {
  it('stamps a monotonic seq and delivers what was published', async () => {
    const seen: unknown[] = [];
    const listener = (e: unknown) => seen.push(e);
    events.on('event', listener);

    try {
      publish({ type: 'fill.step', applicationId: 'a1', field: 'Phone', status: 'mismatch' });
      publish({
        type: 'fill.done',
        applicationId: 'a1',
        filled: 1,
        mismatched: 1,
        failed: 0,
        skipped: 0,
      });
    } finally {
      events.off('event', listener);
    }

    expect(seen).toHaveLength(2);
    const [step, done] = seen as Array<Record<string, unknown>>;
    expect(step!['status']).toBe('mismatch');
    expect(done!['mismatched']).toBe(1);
    expect(Number(done!['seq'])).toBeGreaterThan(Number(step!['seq']));

    // And both survive a round trip through the schema the SSE route validates against.
    expect(AppEvent.safeParse(step).success).toBe(true);
    expect(AppEvent.safeParse(done).success).toBe(true);
  });
});
