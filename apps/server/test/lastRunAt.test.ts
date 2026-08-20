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

/**
 * When a board is recorded as having been searched.
 *
 * `last_run_at` sat on the table, read by `GET /api/sources` and written by nothing, so the
 * Settings board list said "not searched yet" about boards this machine had been through an
 * hour earlier. The stamp added for it was a bare UPDATE keyed on the label — and source rows
 * are written in only two places, `ensureSource` from `persist()` (which runs after the whole
 * worker loop) and the resolve route. So on a board's FIRST run the update matched no row and
 * the stamp went nowhere, and a board that had nothing open never got a row at all, because
 * `ensureSource` fires once per persisted posting.
 *
 * These three were written as a reproduction of that, and now hold the fixed behaviour: the
 * row is ensured before it is stamped, so a search is recorded because it happened rather than
 * because it returned something.
 */
describe('when a board is recorded as searched', () => {
  it('stamps a board on its very first run', async () => {
    stub([posting()]);
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    const rows = db.select().from(schema.source).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastRunAt).not.toBeNull();
  });

  it('stamps a board that was searched honestly and had nothing open', async () => {
    // The case the column is most useful for, and the one that never got a row: "we asked,
    // and there was nothing" is a different fact from "we never asked".
    stub([]);
    await runDiscovery([{ source: 'greenhouse', board: 'quiet' }]);
    const rows = db.select().from(schema.source).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('greenhouse:quiet');
    expect(rows[0]?.lastRunAt).not.toBeNull();
  });

  it('moves the stamp forward on a later run rather than adding a second row', async () => {
    stub([posting()]);
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);
    const first = db.select().from(schema.source).all()[0]?.lastRunAt;

    await new Promise((r) => setTimeout(r, 1100));
    await runDiscovery([{ source: 'greenhouse', board: 'acme' }]);

    const rows = db.select().from(schema.source).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastRunAt).not.toBe(first);
  });

  it('does not stamp a board whose fetch threw', async () => {
    // A source that failed was not searched, whatever it was asked to do.
    ALL_SOURCES['greenhouse'] = {
      kind: 'greenhouse',
      requiresKey: false,
      isConfigured: () => true,
      fetch: () => Promise.reject(new Error('board is on fire')),
    } as unknown as JobSource;

    await runDiscovery([{ source: 'greenhouse', board: 'burning' }]);
    const rows = db.select().from(schema.source).all();
    expect(rows.find((r) => r.label === 'greenhouse:burning')?.lastRunAt ?? null).toBeNull();
  });
});
