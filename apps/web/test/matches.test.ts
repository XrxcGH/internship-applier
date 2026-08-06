import { describe, expect, it } from 'vitest';
import { daysUntil, locationLabel, payLabel, termLabel } from '../src/lib/matches';

/**
 * The four pure helpers behind the G2 queue. Each of them carries a docstring describing a
 * user-visible bug that was fixed and, until now, could have come back without a single
 * test failing.
 */

describe('daysUntil', () => {
  it('reports a deadline that has passed as negative, never as minus zero', () => {
    // Math.ceil on a small negative number gives -0, which is not less than zero and
    // prints as "0" — so the queue put a posting that closed three hours ago in urgency
    // red reading "0d left".
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    const days = daysUntil(threeHoursAgo);
    expect(days).not.toBeNull();
    expect(days! < 0).toBe(true);
    expect(Object.is(days, -0)).toBe(false);
    expect(days).toBe(-1);
  });

  it('rounds an upcoming deadline up, so part of a day still counts as a day', () => {
    expect(daysUntil(new Date(Date.now() + 3 * 3600_000).toISOString())).toBe(1);
    expect(daysUntil(new Date(Date.now() + 6.5 * 86_400_000).toISOString())).toBe(7);
  });

  it('answers nothing for a posting with no deadline or an unreadable one', () => {
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil('whenever')).toBeNull();
  });
});

describe('payLabel', () => {
  it('gives one display form per period token', () => {
    // "$110000–130000/year" was what a yearly salary used to look like, in the pane where
    // someone is deciding whether to apply.
    expect(payLabel({ min: 110_000, max: 130_000, period: 'year' })).toBe('$110,000–$130,000/yr');
    expect(payLabel({ min: 45, period: 'hour' })).toBe('$45/hr');
    expect(payLabel({ min: 1800, period: 'week' })).toBe('$1,800/wk');
    expect(payLabel({ min: 7200, period: 'month' })).toBe('$7,200/mo');
    expect(payLabel({ min: 20_000, period: 'total' })).toBe('$20,000 total');
  });

  it('falls back to hourly for an unknown or absent period', () => {
    expect(payLabel({ min: 45 })).toBe('$45/hr');
    expect(payLabel({ min: 45, period: 'fortnight' })).toBe('$45/hr');
  });

  it('says so plainly when there is no number to show', () => {
    expect(payLabel(null)).toBe('Pay not disclosed');
    expect(payLabel({ period: 'year' })).toBe('Pay not disclosed');
    expect(payLabel({ min: '45' })).toBe('Pay not disclosed');
  });

  it('puts unpaid and credit-only ahead of any figure', () => {
    expect(payLabel({ unpaid: true, min: 45 })).toBe('Unpaid');
    expect(payLabel({ academicCreditOnly: true, min: 45 })).toBe('Credit only');
  });
});

describe('locationLabel', () => {
  it('calls it remote whichever field says so', () => {
    expect(locationLabel({ locations: null, workArrangement: 'remote' })).toBe('Remote');
    expect(locationLabel({ locations: [{ remote: true }], workArrangement: null })).toBe('Remote');
  });

  it('uses the first location, and never renders a stray comma', () => {
    expect(
      locationLabel({ locations: [{ city: 'Ithaca', region: 'NY' }], workArrangement: 'onsite' }),
    ).toBe('Ithaca, NY');
    expect(locationLabel({ locations: [{ city: 'Ithaca' }], workArrangement: null })).toBe(
      'Ithaca',
    );
    expect(locationLabel({ locations: [{ region: 'NY' }], workArrangement: null })).toBe('NY');
  });

  it('says the posting did not state one rather than showing an empty gap', () => {
    expect(locationLabel({ locations: null, workArrangement: null })).toBe('Location not stated');
    expect(locationLabel({ locations: [], workArrangement: null })).toBe('Location not stated');
    expect(locationLabel({ locations: [{}], workArrangement: null })).toBe('Location not stated');
  });
});

describe('termLabel', () => {
  it('shows whichever half of the term the posting gave', () => {
    expect(termLabel({ season: 'summer', year: 2027 })).toBe('summer 2027');
    expect(termLabel({ season: 'fall_winter', year: null })).toBe('fall winter');
    expect(termLabel({ season: null, year: 2027 })).toBe('2027');
  });

  it('says the posting did not state one', () => {
    expect(termLabel(null)).toBe('Term not stated');
    expect(termLabel({ season: null, year: null })).toBe('Term not stated');
  });
});
