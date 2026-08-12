import { beforeEach, describe, expect, it } from 'vitest';
import { db, schema, sqlite } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { ALL_SOURCES, runDiscovery } from '../src/core/discovery/run';
import { wrongShape } from '../src/core/discovery/sources/types';
import type { JobSource, NormalizedPosting } from '../src/core/discovery/sources/types';

/**
 * What a second sighting of a posting is allowed to change, and what a source saying
 * "this one has closed" is allowed to do.
 *
 * A row was written once and then never touched again except for its timestamps. Anything
 * the employer added afterwards never landed — a deadline announced a week later, a pay band
 * filled in — and the deadline is the one that bites, because stage 1 of `refreshPostings`
 * closes a posting whose `closesAt` has passed and that column could only ever be set at
 * first sight. Meanwhile the community list marks a finished role `active: false` and the
 * adapter simply skipped the row: the best closure evidence in the pipeline, thrown away,
 * leaving the queue offering a student an application they could no longer make until
 * forty-five days of not-being-seen expired it.
 */

/** A term in the shape every adapter builds, including the all-null one they emit. */
function term(season: string | null, year: number | null): NormalizedPosting['term'] {
  return { season, year, durationWeeks: null, multiTerm: false } as NormalizedPosting['term'];
}

function posting(over: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    externalId: 'x1',
    canonicalUrl: 'https://acme.com/jobs/1',
    applyUrl: 'https://acme.com/jobs/1',
    company: 'Acme',
    companyDomain: null,
    title: 'Software Engineering Intern',
    descriptionHtml: null,
    descriptionText: 'Build things.',
    locations: [{ city: 'Boston', region: 'MA', remote: false }],
    positionType: 'internship',
    workArrangement: null,
    hybridDaysOnsite: null,
    remoteEligibleIn: [],
    programFlags: [],
    term: term('summer', 2027),
    compensation: null,
    requires: {},
    postedAt: null,
    closesAt: null,
    atsVendor: 'greenhouse',
    ...over,
  } as NormalizedPosting;
}

/** A source that returns exactly what a test hands it, registered under a real name. */
function stub(result: { postings?: NormalizedPosting[]; closed?: string[] }): void {
  const source: JobSource = {
    kind: 'greenhouse',
    requiresKey: false,
    isConfigured: () => true,
    fetch: async () => ({
      postings: result.postings ?? [],
      notes: [],
      ...(result.closed ? { closed: result.closed } : {}),
    }),
  };
  ALL_SOURCES['greenhouse'] = source;
}

const REAL_GREENHOUSE = ALL_SOURCES['greenhouse']!;

function stored() {
  return db.select().from(schema.jobPosting).all()[0];
}

beforeEach(() => {
  runMigrations();
  sqlite.prepare('DELETE FROM job_posting_source').run();
  sqlite.prepare('DELETE FROM job_posting').run();
  sqlite.prepare('DELETE FROM source').run();
  ALL_SOURCES['greenhouse'] = REAL_GREENHOUSE;
});

describe('a second sighting of a stored posting', () => {
  it('lands a deadline the employer announced after we first saw it', async () => {
    // The whole reason stage 1 of refresh had nothing to read on most of the table.
    stub({ postings: [posting()] });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    expect(stored()?.closesAt).toBeNull();

    stub({ postings: [posting({ closesAt: '2027-03-01T00:00:00Z' })] });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    expect(stored()?.closesAt).toBe('2027-03-01T00:00:00Z');
  });

  it('fills in a pay band that was not there the first time', async () => {
    stub({ postings: [posting()] });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    expect(stored()?.compensation).toBeNull();

    stub({ postings: [posting({ compensation: { min: 30, period: 'hour', currency: 'USD' } })] });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    expect(stored()?.compensation).toMatchObject({ min: 30 });
  });

  it('never replaces something with nothing', async () => {
    // The same posting is seen through different sources, and the community list carries no
    // description at all. Overwriting blindly would blank the description, the pay and the
    // requirements of a Greenhouse posting the moment a thinner source re-sighted it.
    stub({
      postings: [
        posting({
          descriptionText: 'Build things.',
          compensation: { min: 30, period: 'hour' },
          closesAt: '2027-03-01T00:00:00Z',
        }),
      ],
    });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);

    stub({
      postings: [
        posting({ descriptionText: '', compensation: null, closesAt: null, locations: [] }),
      ],
    });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);

    const row = stored();
    expect(row?.descriptionText).toBe('Build things.');
    expect(row?.compensation).toMatchObject({ min: 30 });
    expect(row?.closesAt).toBe('2027-03-01T00:00:00Z');
    expect(row?.locations).toHaveLength(1);
  });

  it('does not overwrite a term with the empty one every parser returns', async () => {
    // The case a null check cannot see, and the one that would actually happen: `term` is
    // ALWAYS an object, so a source that read no season, year or duration still hands over
    // `{season: null, year: null, durationWeeks: null, multiTerm: false}` — non-null, and
    // straight past a null test onto a posting whose term was known. `requires` is `{}` the
    // same way. The community list carries neither, and it re-sights everything.
    stub({ postings: [posting({ term: term('summer', 2027) })] });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    expect(stored()?.term).toMatchObject({ season: 'summer', year: 2027 });

    stub({
      postings: [
        posting({
          term: term(null, null),
          requires: {},
        }),
      ],
    });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    expect(stored()?.term).toMatchObject({ season: 'summer', year: 2027 });
  });

  it('still lets a later sighting correct a term it can actually read', async () => {
    // The other direction, which the fix above must not break: a real term replaces a real
    // term, and a term arriving where there was none lands.
    stub({ postings: [posting({ term: term(null, null) })] });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);

    stub({ postings: [posting({ term: term('fall', 2027) })] });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    expect(stored()?.term).toMatchObject({ season: 'fall', year: 2027 });
  });

  it('keeps a zero, which is a measurement rather than an absence', async () => {
    // `hybridDaysOnsite: 0` says fully remote. Treating every falsy value as nothing would
    // lose that fact on the next sighting.
    stub({ postings: [posting({ hybridDaysOnsite: 0 })] });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    expect(stored()?.hybridDaysOnsite).toBe(0);
  });

  it('leaves the fields dedupe matched on alone', async () => {
    // Rewriting company, title or canonical URL from another source's spelling would move
    // the row out from under the key that found it.
    stub({ postings: [posting()] });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    stub({ postings: [posting({ title: 'SWE Intern (Summer)' })] });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    expect(stored()?.title).toBe('Software Engineering Intern');
  });
});

describe('a source that says a posting has closed', () => {
  it('closes the stored row, and counts it', async () => {
    stub({ postings: [posting()] });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    expect(stored()?.isOpen).toBe(true);

    stub({ postings: [], closed: ['https://acme.com/jobs/1'] });
    const summary = await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);

    expect(stored()?.isOpen).toBe(false);
    expect(summary.closed).toBe(1);
  });

  it('keeps a posting open when the same run also returned it as open', async () => {
    // One source's stale "closed" list must not shut a posting another source just handed
    // back. A sighting is the stronger signal, and it is also the more recent one.
    stub({ postings: [posting()] });
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);

    stub({ postings: [posting()], closed: ['https://acme.com/jobs/1'] });
    const summary = await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);

    expect(stored()?.isOpen).toBe(true);
    expect(summary.closed).toBe(0);
  });

  it('says nothing about a URL that was never stored', async () => {
    // A source listing its own closed roles will always name plenty we never saw open.
    stub({ postings: [], closed: ['https://acme.com/jobs/never-seen'] });
    const summary = await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    expect(summary.closed).toBe(0);
    expect(summary.skipped).toEqual([]);
  });
});

describe('wrongShape', () => {
  it('says so when a source answers with something that is not a list', () => {
    // `data.jobs ?? []` could not tell a board with nothing posted from an endpoint that
    // had changed: both came out as "0 found", not degraded, nothing in `skipped` — a run
    // reporting a complete search of a source it had failed to read.
    const drift = wrongShape('greenhouse', { error: 'gone' });
    expect(drift?.gaps?.[0]).toMatch(/not a list of postings/i);
    expect(drift?.postings).toEqual([]);
  });

  it('leaves a genuinely empty board alone', () => {
    expect(wrongShape('greenhouse', [])).toBeNull();
    expect(wrongShape('greenhouse', undefined)).toBeNull();
    expect(wrongShape('greenhouse', null)).toBeNull();
  });

  it('reaches the run summary as a gap rather than a quiet zero', async () => {
    ALL_SOURCES['greenhouse'] = {
      kind: 'greenhouse',
      requiresKey: false,
      isConfigured: () => true,
      fetch: async () => wrongShape('greenhouse', { error: 'gone' })!,
    };
    const summary = await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    expect(summary.bySource[0]?.degraded).toBe(true);
    expect(summary.skipped.join(' ')).toMatch(/not a list of postings/i);
  });
});
