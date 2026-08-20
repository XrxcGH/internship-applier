import { beforeEach, describe, expect, it } from 'vitest';
import { db, schema, sqlite } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { ALL_SOURCES, runDiscovery } from '../src/core/discovery/run';
import type { JobSource, NormalizedPosting } from '../src/core/discovery/sources/types';

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
    term: { season: 'summer', year: 2027, durationWeeks: null, multiTerm: false },
    compensation: null,
    requires: {},
    postedAt: null,
    closesAt: null,
    atsVendor: 'greenhouse',
    ...over,
  } as NormalizedPosting;
}

function stub(postings: NormalizedPosting[]): void {
  const source: JobSource = {
    kind: 'greenhouse',
    requiresKey: false,
    isConfigured: () => true,
    fetch: async () => ({ postings, notes: [] }),
  };
  ALL_SOURCES['greenhouse'] = source;
}

const REAL = ALL_SOURCES['greenhouse']!;

beforeEach(() => {
  runMigrations();
  sqlite.prepare('DELETE FROM job_posting_source').run();
  sqlite.prepare('DELETE FROM job_posting').run();
  sqlite.prepare('DELETE FROM source').run();
  ALL_SOURCES['greenhouse'] = REAL;
});

describe('lastRunAt', () => {
  it('first productive run of a board leaves lastRunAt null', async () => {
    stub([posting()]);
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    const rows = db.select().from(schema.source).all();
    console.log('AFTER RUN 1', JSON.stringify(rows));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastRunAt).toBeNull();
  });

  it('second run stamps it', async () => {
    stub([posting()]);
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    const rows = db.select().from(schema.source).all();
    console.log('AFTER RUN 2', JSON.stringify(rows));
    expect(rows[0]?.lastRunAt).not.toBeNull();
  });

  it('a board searched with nothing open never gets a row at all', async () => {
    stub([]);
    await runDiscovery([{ source: 'greenhouse', board: 'quiet' }]);
    const rows = db.select().from(schema.source).all();
    console.log('AFTER QUIET RUN', JSON.stringify(rows));
    expect(rows).toHaveLength(0);
  });
});
