import { describe, expect, it } from 'vitest';
import { dedupe, fingerprint, titlesMatch } from '../src/core/discovery/dedupe';
import type { NormalizedPosting } from '../src/core/discovery/sources/types';

function posting(over: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    externalId: '1',
    canonicalUrl: 'https://example.com/jobs/1',
    applyUrl: 'https://example.com/jobs/1',
    company: 'Acme',
    companyDomain: null,
    title: 'Software Engineer Intern',
    descriptionText: 'desc',
    descriptionHtml: null,
    locations: [{ city: 'Boston', remote: false }],
    positionType: 'internship',
    workArrangement: 'onsite',
    hybridDaysOnsite: null,
    remoteEligibleIn: [],
    programFlags: [],
    term: { season: 'summer', year: 2027, durationWeeks: 12, multiTerm: false },
    compensation: null,
    requires: {},
    postedAt: null,
    closesAt: null,
    atsVendor: 'greenhouse',
    ...over,
  };
}

describe('fingerprint', () => {
  it('ignores requisition ids, casing and legal suffixes', () => {
    const a = fingerprint({
      company: 'Acme, Inc.',
      title: 'Software Engineer Intern',
      locations: [{ city: 'Boston' }],
    });
    const b = fingerprint({
      company: 'ACME LLC',
      title: 'Software Engineer Intern - Req #9931',
      locations: [{ city: 'boston' }],
    });
    expect(a).toBe(b);
  });

  /**
   * This used to assert that "(Summer 2027)" collapsed away too, which is the behaviour the
   * key must NOT have. Stage 2 merges on this alone, with no different-source guard, so a
   * Summer and a Fall requisition sharing a title would become one row and the user would
   * be shown whichever arrived first — possibly the one they are ineligible for, with the
   * one they could take never appearing at all.
   */
  it('keeps two requisitions apart when only the term distinguishes them', () => {
    const summer = fingerprint({
      company: 'Acme',
      title: 'Software Engineer Intern (Summer 2027)',
      locations: [{ city: 'Boston' }],
    });
    const fall = fingerprint({
      company: 'Acme',
      title: 'Software Engineer Intern (Fall 2027)',
      locations: [{ city: 'Boston' }],
    });
    expect(summer).not.toBe(fall);
  });

  it('keeps numbered levels of the same role apart', () => {
    const one = fingerprint({
      company: 'Acme',
      title: 'Machine Learning Intern I',
      locations: [{ city: 'Boston' }],
    });
    const two = fingerprint({
      company: 'Acme',
      title: 'Machine Learning Intern II',
      locations: [{ city: 'Boston' }],
    });
    expect(one).not.toBe(two);
  });
});

describe('titlesMatch', () => {
  it('matches inflection and suffix-noise variants of the same role', () => {
    expect(titlesMatch('Software Engineer Intern', 'Software Engineering Intern')).toBe(true);
    expect(titlesMatch('Software Engineer Intern', 'Software Engineer Intern - Summer 2027')).toBe(
      true,
    );
    expect(titlesMatch('Software Engineer Intern (Req #4021)', 'Software Engineer Intern II')).toBe(
      true,
    );
  });

  /**
   * These are exactly the cases character-similarity got wrong. A discriminating token
   * means a different requisition, and merging would hide one of them from the user.
   * "Intern" vs "Intern, Backend" scored 0.758 on trigrams — higher than some pairs that
   * genuinely are the same job.
   */
  it('refuses to merge roles separated by a discriminating token', () => {
    expect(titlesMatch('Software Engineer Intern', 'Software Engineer Intern, Backend')).toBe(
      false,
    );
    expect(titlesMatch('Software Engineer Intern', 'Hardware Engineer Intern')).toBe(false);
    expect(titlesMatch('Frontend Engineer Intern', 'Backend Engineer Intern')).toBe(false);
    expect(titlesMatch('Product Manager Intern', 'Product Design Intern')).toBe(false);
    expect(titlesMatch('Data Science Intern', 'Data Scientist Intern')).toBe(false);
  });

  it('rejects unrelated roles', () => {
    expect(titlesMatch('Software Engineer Intern', 'Marketing Analyst')).toBe(false);
  });
});

describe('dedupe', () => {
  it('merges by canonical url and keeps both sources', () => {
    const { unique, duplicates } = dedupe([
      { posting: posting(), source: 'greenhouse:acme' },
      { posting: posting(), source: 'adzuna:us' },
    ]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
    expect(unique[0]!.sources).toEqual(['greenhouse:acme', 'adzuna:us']);
  });

  it('merges by fingerprint when the urls differ', () => {
    const { unique } = dedupe([
      { posting: posting({ canonicalUrl: 'https://a.com/1' }), source: 's1' },
      {
        posting: posting({
          canonicalUrl: 'https://b.com/2',
          title: 'Software Engineer Intern (Summer 2027)',
        }),
        source: 's2',
      },
    ]);
    expect(unique).toHaveLength(1);
    expect(unique[0]!.sources).toEqual(['s1', 's2']);
  });

  it('catches near-duplicate titles across different sources', () => {
    const { unique } = dedupe([
      { posting: posting({ canonicalUrl: 'https://a.com/1' }), source: 'greenhouse:acme' },
      {
        posting: posting({
          canonicalUrl: 'https://b.com/2',
          title: 'Software Engineering Intern',
          locations: [{ city: 'Cambridge', remote: false }],
        }),
        source: 'adzuna:us',
      },
    ]);
    expect(unique).toHaveLength(1);
    expect(unique[0]!.mergedBy).toContain('title');
  });

  /**
   * Two similar titles from the SAME source are usually genuinely distinct requisitions
   * (a frontend and a backend intern posting, say). Merging them would silently hide one.
   */
  it('does not merge similar titles within a single source', () => {
    const { unique } = dedupe([
      { posting: posting({ canonicalUrl: 'https://a.com/1' }), source: 'greenhouse:acme' },
      {
        posting: posting({
          canonicalUrl: 'https://a.com/2',
          title: 'Software Engineering Intern',
          locations: [{ city: 'Cambridge', remote: false }],
        }),
        source: 'greenhouse:acme',
      },
    ]);
    expect(unique).toHaveLength(2);
  });

  it('keeps genuinely different roles apart', () => {
    const { unique, duplicates } = dedupe([
      { posting: posting(), source: 's1' },
      {
        posting: posting({
          canonicalUrl: 'https://example.com/jobs/2',
          title: 'Marketing Intern',
        }),
        source: 's1',
      },
    ]);
    expect(unique).toHaveLength(2);
    expect(duplicates).toBe(0);
  });
});
