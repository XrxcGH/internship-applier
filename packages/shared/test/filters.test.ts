import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, SearchFilters, STARTER_PRESETS } from '../src/filters';

describe('filter defaults', () => {
  it('fills the whole tree from an empty object', () => {
    const f = SearchFilters.parse({});
    expect(f.term.seasons).toEqual(['summer']);
    expect(f.term.years).toEqual([2027]);
    expect(f.positionTypes).toEqual(['internship', 'co_op']);
    expect(f.location.countries).toEqual(['US']);
    expect(f.view.sortBy).toBe('fit');
  });

  it('parses every starter preset', () => {
    for (const p of STARTER_PRESETS) {
      expect(() => SearchFilters.parse(p.patch)).not.toThrow();
    }
  });

  /**
   * Rule 3 in filters.ts: a posting that doesn't state something is unknown, not
   * disqualified. If any of these ever default to false, the tool starts silently
   * hiding opportunities — the worst failure mode this app has.
   */
  it('never treats unstated information as disqualifying', () => {
    expect(DEFAULT_FILTERS.compensation.includeUndisclosed).toBe(true);
    expect(DEFAULT_FILTERS.eligibility.includeUnknownEligibility).toBe(true);
    expect(DEFAULT_FILTERS.arrangement.includeUnstatedArrangement).toBe(true);
    expect(DEFAULT_FILTERS.term.includeUndatedPostings).toBe(true);
  });

  it('leaves every narrowing list empty by default', () => {
    expect(DEFAULT_FILTERS.arrangement.allowed).toEqual([]);
    expect(DEFAULT_FILTERS.company.onlyCompanies).toEqual([]);
    expect(DEFAULT_FILTERS.company.sizes).toEqual([]);
    expect(DEFAULT_FILTERS.role.roleFamilies).toEqual([]);
    expect(DEFAULT_FILTERS.programFlags).toEqual([]);
  });

  it('treats season and year as ordinary values, not hardcoded', () => {
    const f = SearchFilters.parse({ term: { seasons: ['fall', 'spring'], years: [2028, 2029] } });
    expect(f.term.seasons).toEqual(['fall', 'spring']);
    expect(f.term.years).toEqual([2028, 2029]);
  });

  it('supports every position type and work arrangement', () => {
    const f = SearchFilters.parse({
      positionTypes: [
        'internship',
        'co_op',
        'fellowship',
        'apprenticeship',
        'research',
        'new_grad',
      ],
      arrangement: { allowed: ['onsite', 'hybrid', 'remote', 'remote_geo_restricted'] },
    });
    expect(f.positionTypes).toHaveLength(6);
    expect(f.arrangement.allowed).toHaveLength(4);
  });
});
