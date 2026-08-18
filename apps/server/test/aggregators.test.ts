/**
 * The keyless aggregators, plus the row-reading rules the keyed two now share with them,
 * driven over fixtures shaped like the live feeds.
 *
 * Both keyless sources are firehoses of every seniority, so the properties that matter are
 * the ones a green "N found" line cannot show: that the internship filter keeps what it
 * should and drops what it should, that the drop is counted out loud in the notes, that
 * coverage not obtained (a page cap, a truncated response, a row nobody could read, a host
 * whose robots.txt says no) lands in gaps rather than nowhere, and that no location is ever
 * more specific than what the source actually said. No test here touches the network;
 * `globalThis.fetch` is swapped for a fixture router, the same way sources.test.ts drives
 * the Greenhouse adapter.
 *
 * Two module-level caches in the fetcher decide the shape of these tests. Response bodies
 * are cached by URL for the life of the process, and robots.txt verdicts by origin, and both
 * keyless adapters now begin at a fixed URL — Remotive's `search=` parameter is gone because
 * the live endpoint ignored it. So every test takes a fresh module through `vi.resetModules()`
 * plus a dynamic import, or the first test's page one and the first test's robots verdict
 * would be served to every test after it.
 *
 * `serve` answers any robots.txt request with an allow-all file unless the test supplies its
 * own, because the interesting cases are the ones where a host says no.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATOR_SOURCES, arbeitnow, remotive } from '../src/core/discovery/sources/aggregators';
import type { JobSource } from '../src/core/discovery/sources/types';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** An allow-all robots.txt: an empty Disallow is the REP's way of permitting everything. */
const ROBOTS_ALLOW_ALL = 'User-agent: *\nDisallow:\n';

/** remotive.com/robots.txt as it really reads, trimmed to the rules that matter here. */
const REMOTIVE_ROBOTS = `
        User-agent: *
        Disallow: /website/translations
        Disallow: /*search=
        Disallow: /jobs/*
        Disallow: /api/*
        Disallow: /join
`;

interface ServeOptions {
  /** robots.txt bodies by origin. Any origin not named gets an allow-all file. */
  robots?: Record<string, string>;
  /** Origins whose robots.txt answers 503, which the REP reads as a complete disallow. */
  robotsDown?: string[];
}

/** Routes each requested URL to a fixture body and records what was fetched. */
function serve(
  routes: Array<[matches: (url: string) => boolean, body: unknown]>,
  opts: ServeOptions = {},
): string[] {
  const fetched: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);

    if (url.endsWith('/robots.txt')) {
      const origin = url.slice(0, -'/robots.txt'.length);
      if (opts.robotsDown?.includes(origin)) {
        return Promise.resolve(
          new Response('down', { status: 503, statusText: 'Service Unavailable' }),
        );
      }
      return Promise.resolve(
        new Response(opts.robots?.[origin] ?? ROBOTS_ALLOW_ALL, { status: 200 }),
      );
    }

    const route = routes.find(([matches]) => matches(url));
    // A 404 rather than a rejection: the fetcher retries network-shaped failures with
    // backoff, so a missing fixture would stall the test for seconds before failing.
    if (!route) {
      return Promise.resolve(new Response('no fixture', { status: 404, statusText: 'missing' }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(route[1]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof globalThis.fetch;
  return fetched;
}

/** The fetches that went to a feed, as opposed to the robots.txt each one now asks for. */
function feedCalls(fetched: string[]): string[] {
  return fetched.filter((u) => !u.endsWith('/robots.txt'));
}

/** A source instance whose fetcher has an empty body cache and an empty robots cache. */
async function freshSource(
  kind: 'arbeitnow' | 'remotive' | 'adzuna' | 'usajobs',
): Promise<JobSource> {
  vi.resetModules();
  const mod = await import('../src/core/discovery/sources/aggregators');
  return mod[kind];
}

// ---------------------------------------------------------------- fixtures

const API = 'https://www.arbeitnow.com/api/job-board-api';
const ARBEITNOW_ORIGIN = 'https://www.arbeitnow.com';
const REMOTIVE_API = 'https://remotive.com/api/remote-jobs';
const REMOTIVE_ORIGIN = 'https://remotive.com';

function arbeitnowRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'software-intern-berlin-1',
    company_name: 'Acme',
    title: 'Software Engineering Intern',
    // Escaped HTML, exactly as the live feed sends it.
    description: '&lt;p&gt;Work on the &lt;b&gt;backend&lt;/b&gt;&lt;/p&gt;',
    remote: false,
    url: 'https://www.arbeitnow.com/jobs/companies/acme/software-intern-berlin-1',
    tags: ['Engineering'],
    job_types: ['internship'],
    location: 'Berlin',
    created_at: 1755400000,
    ...over,
  };
}

function arbeitnowPage(rows: unknown[], next: string | null): Record<string, unknown> {
  return { data: rows, links: { next }, meta: { per_page: 175 } };
}

function remotiveJob(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1919266,
    url: 'https://remotive.com/remote-jobs/software-development/data-intern-1919266',
    title: 'Data Science Intern',
    company_name: 'Acme',
    category: 'Data',
    job_type: 'internship',
    publication_date: '2026-08-16T10:09:41',
    candidate_required_location: 'Worldwide',
    salary: '$25 /hour',
    description: '<p>Analyze <b>data</b> all summer</p>',
    ...over,
  };
}

function remotiveBody(jobs: unknown[], count?: number): Record<string, unknown> {
  return { 'job-count': count ?? jobs.length, jobs };
}

// ---------------------------------------------------------------- arbeitnow

describe('arbeitnow', () => {
  it('parses a row into a posting without inventing anything', async () => {
    const source = await freshSource('arbeitnow');
    serve([[(u) => u.startsWith(API), arbeitnowPage([arbeitnowRow()], null)]]);
    const { postings, gaps } = await source.fetch({ board: '' });

    expect(postings).toHaveLength(1);
    const p = postings[0]!;
    expect(p.externalId).toBe('software-intern-berlin-1');
    expect(p.company).toBe('Acme');
    expect(p.title).toBe('Software Engineering Intern');
    // Escaped HTML decoded before stripping, so no literal markup survives.
    expect(p.descriptionText).not.toMatch(/<[a-z/]/i);
    expect(p.descriptionText).toMatch(/backend/);
    expect(p.postedAt).toBe(new Date(1755400000 * 1000).toISOString());
    // "Berlin" names no country, so none is stored.
    expect(p.locations[0]).toMatchObject({ city: 'Berlin', remote: false });
    expect(p.locations[0]!.country).toBeUndefined();
    expect(gaps).toEqual([]);
  });

  it('keeps internship-shaped rows and counts the dropped ones in the notes', async () => {
    const source = await freshSource('arbeitnow');
    serve([
      [
        (u) => u.startsWith(API),
        arbeitnowPage(
          [
            arbeitnowRow({ slug: 'a' }),
            // Kept via job_types even though the title never says intern.
            arbeitnowRow({ slug: 'b', title: 'Working Student, Data', job_types: ['Intern'] }),
            // Kept via the German title on a row with empty job_types.
            arbeitnowRow({ slug: 'c', title: 'Praktikum Marketing', job_types: [] }),
            // Dropped: a senior role, and "International" must not read as intern.
            arbeitnowRow({ slug: 'd', title: 'Senior Backend Engineer', job_types: ['Full Time'] }),
            arbeitnowRow({
              slug: 'e',
              title: 'International Sales Manager',
              job_types: ['Full Time'],
            }),
            // The live feed's malformed job_types shape must not throw the page away, and
            // "Internal" is not "intern".
            arbeitnowRow({ slug: 'f', title: 'Internal Auditor', job_types: { 1: 'entry' } }),
          ],
          null,
        ),
      ],
    ]);
    const { postings, notes } = await source.fetch({ board: '' });

    expect(postings.map((p) => p.externalId)).toEqual(['a', 'b', 'c']);
    const note = notes.join(' ');
    expect(note).toMatch(/read 6 jobs/);
    expect(note).toMatch(/kept 3/);
    expect(note).toMatch(/dropped 3/);
  });

  it('follows links.next up to the page cap and reports the unread rest as a gap', async () => {
    const source = await freshSource('arbeitnow');
    const page = (n: number) => `${API}?page=${n}`;
    const fetched = serve([
      [(u) => u === page(4), arbeitnowPage([arbeitnowRow({ slug: 'never' })], null)],
      [(u) => u === page(3), arbeitnowPage([arbeitnowRow({ slug: 'p3' })], page(4))],
      [(u) => u === page(2), arbeitnowPage([arbeitnowRow({ slug: 'p2' })], page(3))],
      [(u) => u.startsWith(API), arbeitnowPage([arbeitnowRow({ slug: 'p1' })], page(2))],
    ]);
    const { postings, gaps, notes } = await source.fetch({ board: '' });

    expect(postings.map((p) => p.externalId)).toEqual(['p1', 'p2', 'p3']);
    // Three pages fetched; the fourth is never asked for.
    expect(feedCalls(fetched)).toHaveLength(3);
    expect(gaps?.join(' ')).toMatch(/3 pages/);
    expect(gaps?.join(' ')).toMatch(/older pages exist/);
    expect(notes.join(' ')).toMatch(/read 3 jobs/);
  });

  it('does not follow a next link that points off its own API', async () => {
    const source = await freshSource('arbeitnow');
    const fetched = serve([
      [
        (u) => u.startsWith(API),
        arbeitnowPage([arbeitnowRow({ slug: 'only' })], 'https://evil.example.com/page2'),
      ],
    ]);
    const { postings, gaps } = await source.fetch({ board: '' });

    expect(postings.map((p) => p.externalId)).toEqual(['only']);
    expect(feedCalls(fetched)).toHaveLength(1);
    expect(gaps?.join(' ')).toMatch(/outside its own API/);
  });

  it('reports first-page drift through wrongShape', async () => {
    const source = await freshSource('arbeitnow');
    serve([[(u) => u.startsWith(API), { data: { error: 'gone' }, links: {} }]]);
    const { postings, gaps } = await source.fetch({ board: '' });

    expect(postings).toEqual([]);
    expect(gaps?.join(' ')).toMatch(/not a list of postings/);
  });

  it('keeps the readable pages when a later page drifts, and says what was lost', async () => {
    const source = await freshSource('arbeitnow');
    const next = `${API}?page=2`;
    serve([
      [(u) => u === next, { data: 'not a list', links: {} }],
      [(u) => u.startsWith(API), arbeitnowPage([arbeitnowRow({ slug: 'ok' })], next)],
    ]);
    const { postings, gaps } = await source.fetch({ board: '' });

    expect(postings.map((p) => p.externalId)).toEqual(['ok']);
    expect(gaps?.join(' ')).toMatch(/page 2 of the feed answered with an unexpected shape/);
    expect(gaps?.join(' ')).toMatch(/first page is/);
  });

  it('records a remote row as remote without a location string', async () => {
    const source = await freshSource('arbeitnow');
    serve([
      [
        (u) => u.startsWith(API),
        arbeitnowPage([arbeitnowRow({ location: '', remote: true })], null),
      ],
    ]);
    const { postings } = await source.fetch({ board: '' });
    expect(postings[0]!.locations).toEqual([{ remote: true }]);
  });
});

// ------------------------------------------------- one bad row costs one row

/**
 * The rule these cases pin: a row the feed sent in a shape nobody can read costs that row
 * and is counted, never the board. Every one of them used to throw a TypeError out of the
 * adapter, which cost the source its entire run.
 */
describe('a row that cannot be read', () => {
  it('arbeitnow: a null entry loses that entry only, and is reported as a gap', async () => {
    const source = await freshSource('arbeitnow');
    serve([
      [
        (u) => u.startsWith(API),
        arbeitnowPage([arbeitnowRow({ slug: 'a' }), null, arbeitnowRow({ slug: 'b' })], null),
      ],
    ]);
    const { postings, notes, gaps } = await source.fetch({ board: '' });

    expect(postings.map((p) => p.externalId)).toEqual(['a', 'b']);
    expect(gaps?.join(' ')).toMatch(/skipped 1 row that could not be read/);
    // The null row is not counted as "not an internship": nobody could have known that.
    expect(notes.join(' ')).toMatch(/read 2 jobs/);
    expect(notes.join(' ')).toMatch(/dropped 0/);
  });

  it('remotive: a null entry loses that entry only, and is reported as a gap', async () => {
    const source = await freshSource('remotive');
    serve([[(u) => u.startsWith(REMOTIVE_API), remotiveBody([remotiveJob({ id: 1 }), null], 2)]]);
    const { postings, gaps } = await source.fetch({ board: '' });

    expect(postings.map((p) => p.externalId)).toEqual(['1']);
    expect(gaps?.join(' ')).toMatch(/skipped 1 row that could not be read/);
    // The response carried two entries, so the declared count of two is not a truncation.
    expect(gaps?.join(' ')).not.toMatch(/were not seen/);
  });

  it('arbeitnow: a non-text description or location keeps the posting and says so', async () => {
    const source = await freshSource('arbeitnow');
    serve([
      [
        (u) => u.startsWith(API),
        arbeitnowPage(
          [arbeitnowRow({ slug: 'a', description: 42 }), arbeitnowRow({ slug: 'b', location: 42 })],
          null,
        ),
      ],
    ]);
    const { postings, gaps } = await source.fetch({ board: '' });

    expect(postings.map((p) => p.externalId)).toEqual(['a', 'b']);
    // Nothing of the unreadable field is invented: no HTML, and none of the row's real text.
    expect(postings[0]!.descriptionHtml).toBeNull();
    expect(postings[0]!.descriptionText).not.toMatch(/backend/);
    expect(postings[1]!.locations).toEqual([]);
    // Two emptied postings would otherwise read as two complete ones.
    expect(gaps?.join(' ')).toMatch(/kept 2 postings whose description or location/);
  });

  it('remotive: a non-text description or eligibility keeps the posting and says so', async () => {
    const source = await freshSource('remotive');
    serve([
      [
        (u) => u.startsWith(REMOTIVE_API),
        remotiveBody([
          remotiveJob({ id: 1, description: 42 }),
          remotiveJob({ id: 2, candidate_required_location: 42 }),
        ]),
      ],
    ]);
    const { postings, gaps } = await source.fetch({ board: '' });

    expect(postings.map((p) => p.externalId)).toEqual(['1', '2']);
    expect(postings[0]!.descriptionHtml).toBeNull();
    expect(postings[0]!.descriptionText).not.toMatch(/Analyze/);
    expect(postings[1]!.remoteEligibleIn).toEqual([]);
    expect(gaps?.join(' ')).toMatch(/kept 2 postings whose description or location/);
  });

  it('a row with no readable title is skipped rather than queued as a blank line', async () => {
    const source = await freshSource('arbeitnow');
    serve([
      [
        (u) => u.startsWith(API),
        // Kept by job_types, so the title filter is not what removes it.
        arbeitnowPage([arbeitnowRow({ slug: 'a', title: 7 })], null),
      ],
    ]);
    const { postings, gaps } = await source.fetch({ board: '' });

    expect(postings).toEqual([]);
    expect(gaps?.join(' ')).toMatch(/skipped 1 row that could not be read/);
  });

  it('adzuna: a null result loses that result only', async () => {
    const source = await freshSource('adzuna');
    process.env.ADZUNA_APP_ID = 'test-id';
    process.env.ADZUNA_APP_KEY = 'test-key';
    try {
      serve([
        [
          (u) => u.startsWith('https://api.adzuna.com/'),
          {
            count: 2,
            results: [
              null,
              {
                id: '77',
                title: 'Data Intern',
                description: 'Work with data',
                redirect_url: 'https://www.adzuna.com/details/77',
              },
            ],
          },
        ],
      ]);
      const { postings, gaps } = await source.fetch({ board: '' });

      expect(postings.map((p) => p.externalId)).toEqual(['77']);
      expect(gaps?.join(' ')).toMatch(/skipped 1 row that could not be read/);
      // Two rows sent against a declared two: not a truncation, only an unreadable row.
      expect(gaps?.join(' ')).not.toMatch(/showing the first/);
    } finally {
      delete process.env.ADZUNA_APP_ID;
      delete process.env.ADZUNA_APP_KEY;
    }
  });

  it('usajobs: a null item loses that item only', async () => {
    const source = await freshSource('usajobs');
    process.env.USAJOBS_API_KEY = 'test-key';
    process.env.USAJOBS_USER_AGENT = 'test@example.com';
    try {
      serve([
        [
          (u) => u.startsWith('https://data.usajobs.gov/'),
          {
            SearchResult: {
              SearchResultCountAll: 2,
              SearchResultItems: [
                null,
                {
                  MatchedObjectId: '900',
                  MatchedObjectDescriptor: {
                    PositionTitle: 'Student Trainee (Engineering)',
                    PositionURI: 'https://www.usajobs.gov/job/900',
                  },
                },
              ],
            },
          },
        ],
      ]);
      const { postings, gaps } = await source.fetch({ board: '' });

      expect(postings.map((p) => p.externalId)).toEqual(['900']);
      expect(gaps?.join(' ')).toMatch(/skipped 1 row that could not be read/);
    } finally {
      delete process.env.USAJOBS_API_KEY;
      delete process.env.USAJOBS_USER_AGENT;
    }
  });
});

// ---------------------------------------------------------------- remotive

describe('remotive', () => {
  it('parses a job, linking back to Remotive as both canonical and apply URL', async () => {
    const source = await freshSource('remotive');
    serve([[(u) => u.startsWith(REMOTIVE_API), remotiveBody([remotiveJob()])]]);
    const { postings, gaps } = await source.fetch({ board: '' });

    expect(postings).toHaveLength(1);
    const p = postings[0]!;
    // The API terms require the Remotive URL as the listing link; both fields carry it.
    expect(p.canonicalUrl).toBe(
      'https://remotive.com/remote-jobs/software-development/data-intern-1919266',
    );
    expect(p.applyUrl).toBe(p.canonicalUrl);
    expect(p.externalId).toBe('1919266');
    expect(p.company).toBe('Acme');
    expect(p.descriptionText).not.toMatch(/<[a-z/]/i);
    expect(p.descriptionText).toMatch(/Analyze/);
    expect(p.positionType).toBe('internship');
    expect(p.workArrangement).toBe('remote');
    expect(gaps).toEqual([]);
  });

  it('keeps internships by job_type or title and counts the dropped rest', async () => {
    const source = await freshSource('remotive');
    serve([
      [
        (u) => u.startsWith(REMOTIVE_API),
        remotiveBody([
          remotiveJob({ id: 1 }),
          // Kept: full_time job_type but the title says intern.
          remotiveJob({ id: 2, title: 'Marketing Intern', job_type: 'full_time' }),
          // Dropped: neither the type nor the title says internship.
          remotiveJob({ id: 3, title: 'Senior AI Engineer', job_type: 'full_time' }),
          // Dropped: "Internal" is not "intern".
          remotiveJob({ id: 4, title: 'Internal Communications Lead', job_type: 'contract' }),
        ]),
      ],
    ]);
    const { postings, notes } = await source.fetch({ board: '' });

    expect(postings.map((p) => p.externalId)).toEqual(['1', '2']);
    const note = notes.join(' ');
    // "read", not "matched": the endpoint runs no server-side search.
    expect(note).toMatch(/read 4 jobs from the board/);
    expect(note).toMatch(/kept 2/);
    expect(note).toMatch(/dropped 2/);
  });

  /**
   * Probed live on 2026-08-17: search=intern, search=nurse and search=python each returned
   * the identical sixteen rows, and limit= was ignored too. A parameter the server discards
   * is not a search, and this one also put the request under a second robots.txt rule
   * ("Disallow: /*search="), so it is no longer sent and the note no longer claims a match.
   */
  it('sends no search parameter, because the endpoint ignores it', async () => {
    const source = await freshSource('remotive');
    const fetched = serve([[(u) => u.startsWith(REMOTIVE_API), remotiveBody([remotiveJob()])]]);
    await source.fetch({ board: '', keywords: ['machine learning'] });

    expect(feedCalls(fetched)).toEqual([REMOTIVE_API]);
  });

  describe('the remote location rule', () => {
    it('keeps a bare recognized country, and remoteness always', async () => {
      const source = await freshSource('remotive');
      serve([
        [
          (u) => u.startsWith(REMOTIVE_API),
          remotiveBody([remotiveJob({ candidate_required_location: 'USA' })]),
        ],
      ]);
      const { postings } = await source.fetch({ board: '' });
      expect(postings[0]!.locations).toEqual([{ country: 'USA', remote: true }]);
      expect(postings[0]!.remoteEligibleIn).toEqual(['USA']);
    });

    it('never stores "Worldwide" or a region list as geography', async () => {
      const worldwideSource = await freshSource('remotive');
      serve([
        [
          (u) => u.startsWith(REMOTIVE_API),
          remotiveBody([remotiveJob({ candidate_required_location: 'Worldwide' })]),
        ],
      ]);
      const worldwide = await worldwideSource.fetch({ board: '' });
      expect(worldwide.postings[0]!.locations).toEqual([{ remote: true }]);
      expect(worldwide.postings[0]!.remoteEligibleIn).toEqual(['Worldwide']);

      const regionSource = await freshSource('remotive');
      serve([
        [
          (u) => u.startsWith(REMOTIVE_API),
          remotiveBody([remotiveJob({ candidate_required_location: 'Americas, Europe, Israel' })]),
        ],
      ]);
      const regions = await regionSource.fetch({ board: '' });
      // "Americas" must not become a city, and "Israel" must not become the country.
      expect(regions.postings[0]!.locations).toEqual([{ remote: true }]);
      expect(regions.postings[0]!.remoteEligibleIn).toEqual(['Americas', 'Europe', 'Israel']);
    });

    it('stays remote-with-nothing-else when the field is absent', async () => {
      const source = await freshSource('remotive');
      serve([
        [
          (u) => u.startsWith(REMOTIVE_API),
          remotiveBody([remotiveJob({ candidate_required_location: undefined })]),
        ],
      ]);
      const { postings } = await source.fetch({ board: '' });
      expect(postings[0]!.locations).toEqual([{ remote: true }]);
      expect(postings[0]!.remoteEligibleIn).toEqual([]);
    });
  });

  it('reads the stated salary text through the compensation parser', async () => {
    const source = await freshSource('remotive');
    serve([
      [(u) => u.startsWith(REMOTIVE_API), remotiveBody([remotiveJob({ salary: '$25 per hour' })])],
    ]);
    const { postings } = await source.fetch({ board: '' });
    expect(postings[0]!.compensation).toMatchObject({ period: 'hour' });
  });

  it('reports a truncated response as a gap, not as complete coverage', async () => {
    const source = await freshSource('remotive');
    serve([[(u) => u.startsWith(REMOTIVE_API), remotiveBody([remotiveJob()], 240)]]);
    const { gaps } = await source.fetch({ board: '' });
    expect(gaps?.join(' ')).toMatch(/said 240 jobs are on the board but sent 1/);
  });

  /**
   * `job-count` equalled the rows sent on every live probe, so reading it alone left the
   * truncation check unable to fire. `total-job-count` is the board's own total and is read
   * alongside it; the larger of the two decides.
   */
  it('reads total-job-count as well, so one inert counter cannot hide a truncation', async () => {
    const source = await freshSource('remotive');
    serve([
      [
        (u) => u.startsWith(REMOTIVE_API),
        { 'job-count': 1, 'total-job-count': 900, jobs: [remotiveJob()] },
      ],
    ]);
    const { gaps } = await source.fetch({ board: '' });
    expect(gaps?.join(' ')).toMatch(/said 900 jobs are on the board but sent 1/);
  });

  it('reports drift through wrongShape', async () => {
    const source = await freshSource('remotive');
    serve([[(u) => u.startsWith(REMOTIVE_API), { 'job-count': 5, jobs: { error: 'nope' } }]]);
    const { postings, gaps } = await source.fetch({ board: '' });
    expect(postings).toEqual([]);
    expect(gaps?.join(' ')).toMatch(/not a list of postings/);
  });
});

// ---------------------------------------------------------------- robots.txt

/**
 * The politeness promise, held where it is actually made.
 *
 * Both adapters used to reach the network through fetchJson's `isDocumentedApi: true`
 * default, which skips robots.txt entirely — and remotive.com's robots.txt disallows both
 * `/api/*` and `/*search=`, the two rules the old URL was matched by. The tests below pin
 * the three things that must be true now: the file is consulted, a refusal ends in a gap
 * rather than an exception or a clean-looking zero, and a host that permits the fetch is
 * still fetched.
 */
describe('robots.txt', () => {
  it('remotive: a disallowed path is not fetched, and the run says why', async () => {
    const source = await freshSource('remotive');
    const fetched = serve([[(u) => u.startsWith(REMOTIVE_API), remotiveBody([remotiveJob()])]], {
      robots: { [REMOTIVE_ORIGIN]: REMOTIVE_ROBOTS },
    });
    const { postings, notes, gaps } = await source.fetch({ board: '' });

    // The API itself is never asked for.
    expect(feedCalls(fetched)).toEqual([]);
    expect(fetched).toEqual([`${REMOTIVE_ORIGIN}/robots.txt`]);
    expect(postings).toEqual([]);
    // A gap, so run.ts marks the source degraded and lists it in `skipped`. A note alone
    // would have left "remotive: 0 found" reading as a complete search.
    expect(gaps).toHaveLength(1);
    expect(gaps?.[0]).toMatch(/robots\.txt asks automated clients to stay off/);
    expect(gaps?.[0]).toMatch(/paste a job URL directly/);
    // Nothing is claimed in the status line about a search that did not happen.
    expect(notes).toEqual([]);
  });

  it('remotive: a robots.txt that cannot be read stops the fetch and says that instead', async () => {
    const source = await freshSource('remotive');
    const fetched = serve([[(u) => u.startsWith(REMOTIVE_API), remotiveBody([remotiveJob()])]], {
      robotsDown: [REMOTIVE_ORIGIN],
    });
    const { postings, gaps } = await source.fetch({ board: '' });

    expect(feedCalls(fetched)).toEqual([]);
    expect(postings).toEqual([]);
    expect(gaps?.join(' ')).toMatch(/could not be read/);
    // Not the same claim as a site that said no: this one never answered.
    expect(gaps?.join(' ')).not.toMatch(/asks automated clients/);
  });

  it('arbeitnow: the feed is allowed, so it is read, and the file is consulted first', async () => {
    const source = await freshSource('arbeitnow');
    const fetched = serve([[(u) => u.startsWith(API), arbeitnowPage([arbeitnowRow()], null)]], {
      // www.arbeitnow.com's real file, which disallows only an analytics parameter and the
      // apply pages. Checked live rather than assumed.
      robots: {
        [ARBEITNOW_ORIGIN]:
          'User-agent: *\nDisallow:\nDisallow: /*?__hstc\nDisallow: /jobs/companies/*/apply\n',
      },
    });
    const { postings, gaps } = await source.fetch({ board: '' });

    expect(fetched[0]).toBe(`${ARBEITNOW_ORIGIN}/robots.txt`);
    expect(postings).toHaveLength(1);
    expect(gaps).toEqual([]);
  });

  it('arbeitnow: a refusal degrades the source instead of throwing out of the run', async () => {
    const source = await freshSource('arbeitnow');
    const fetched = serve([[(u) => u.startsWith(API), arbeitnowPage([arbeitnowRow()], null)]], {
      robots: { [ARBEITNOW_ORIGIN]: 'User-agent: *\nDisallow: /api/\n' },
    });
    const { postings, gaps } = await source.fetch({ board: '' });

    expect(feedCalls(fetched)).toEqual([]);
    expect(postings).toEqual([]);
    expect(gaps?.join(' ')).toMatch(/robots\.txt asks automated clients to stay off/);
  });
});

// ---------------------------------------------------------------- the keyless promise

describe('the keyless promise', () => {
  it('both adapters are registered, keyless, and always configured', () => {
    expect(AGGREGATOR_SOURCES.arbeitnow).toBe(arbeitnow);
    expect(AGGREGATOR_SOURCES.remotive).toBe(remotive);
    for (const source of [arbeitnow, remotive]) {
      expect(source.requiresKey, source.kind).toBe(false);
      expect(source.isConfigured(), source.kind).toBe(true);
    }
  });

  /**
   * Held against the source text, because "no env var, no key, no auth header" is a claim
   * about what the code reads, not about what a fixture run happened to exercise. The two
   * adapter sections are cut out of the file so the keyed siblings above them (which
   * legitimately read process.env) do not mask a violation.
   */
  it('neither adapter reads an env var, a key, or an auth header', () => {
    const section = keylessSection();
    expect(section).toBeTruthy();
    expect(section).not.toMatch(/process\.env/);
    expect(section).not.toMatch(/authorization/i);
    expect(section).not.toMatch(/api[_-]?key/i);
    expect(section).not.toMatch(/headers:/);
  });

  /**
   * Also held against the source text, and for the same reason: `isDocumentedApi: true` is
   * how the robots check gets skipped, and a fixture run cannot show that a future edit did
   * not put it back. Both adapters must ask for the robots-respecting path by name.
   */
  it('neither adapter opts out of the robots.txt check', () => {
    const section = keylessSection();
    expect(section).not.toMatch(/isDocumentedApi:\s*true/);
    // Matched at the call site rather than anywhere in the section, so a comment mentioning
    // the option cannot stand in for an adapter that stopped passing it.
    expect(section?.match(/fetchJson\([^;]*?isDocumentedApi:\s*false/g)).toHaveLength(2);
  });
});

/** The Arbeitnow and Remotive adapters as written, without their keyed siblings. */
function keylessSection(): string | undefined {
  const file = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/core/discovery/sources/aggregators.ts',
    ),
    'utf8',
  );
  return /\/\/ -+ Arbeitnow([\s\S]*?)\/\/ -+ community list/.exec(file)?.[1];
}
