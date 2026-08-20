import { beforeEach, describe, expect, it } from 'vitest';
import { db, schema, sqlite } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { refreshPostings } from '../src/core/discovery/refresh';

/** Mid-morning UTC on 2026-08-05, so a deadline of "2026-08-05" is today and still live. */
const NOW = new Date('2026-08-05T09:00:00.000Z');

function seed(rows: Array<{ id: string; closesAt: string | null; lastSeenAt?: string }>): void {
  sqlite.prepare('DELETE FROM job_posting').run();
  for (const r of rows) {
    db.insert(schema.jobPosting)
      .values({
        id: r.id,
        company: 'Acme',
        title: `Intern ${r.id}`,
        canonicalUrl: `https://acme.com/jobs/${r.id}`,
        applyUrl: `https://acme.com/jobs/${r.id}`,
        fingerprint: `acme|intern ${r.id}|nyc`,
        descriptionText: 'A job.',
        isOpen: true,
        closesAt: r.closesAt,
        firstSeenAt: '2026-07-01T00:00:00Z',
        lastSeenAt: r.lastSeenAt ?? '2026-08-01T00:00:00Z',
      })
      .run();
  }
}

function openIds(): string[] {
  return (
    sqlite.prepare('SELECT id FROM job_posting WHERE is_open = 1 ORDER BY id').all() as Array<{
      id: string;
    }>
  ).map((r) => r.id);
}

describe('refreshPostings', () => {
  beforeEach(() => {
    runMigrations();
  });

  /**
   * Feeds hand over bare dates, and a bare date sorts before every timestamp on that day.
   * A posting whose deadline is today was therefore closed at 00:00 UTC — for a US Pacific
   * user, from 17:00 the evening before — and the student was told "This posting is no
   * longer open" on the last and most urgent day they could still apply. The deadline rule
   * in eligibility already reads a bare date as end of day; this is the other half of that.
   */
  it('leaves a date-only deadline open for the whole of its last day', async () => {
    seed([
      { id: 'today', closesAt: '2026-08-05' },
      { id: 'tomorrow', closesAt: '2026-08-06' },
      { id: 'endOfToday', closesAt: '2026-08-05T23:59:59Z' },
      { id: 'midnightToday', closesAt: '2026-08-05T00:00:00Z' },
      { id: 'yesterday', closesAt: '2026-08-04' },
      { id: 'noDeadline', closesAt: null },
    ]);

    const summary = await refreshPostings({ now: NOW });

    expect(summary.closedByDeadline).toBe(2);
    expect(openIds()).toEqual(['endOfToday', 'noDeadline', 'today', 'tomorrow']);
  });

  /**
   * "Refresh this one posting" used to re-evaluate the whole table first, so refreshing an
   * expired posting could close every other row whose bare deadline happened to be today,
   * and then report the count as though it were about the one that was asked for.
   */
  it('touches only the posting it was asked about', async () => {
    seed([
      { id: 'today', closesAt: '2026-08-05' },
      { id: 'midnightToday', closesAt: '2026-08-05T00:00:00Z' },
      { id: 'yesterday', closesAt: '2026-08-04' },
    ]);

    const summary = await refreshPostings({ now: NOW, postingId: 'yesterday' });

    expect(summary.closedByDeadline).toBe(1);
    expect(openIds()).toEqual(['midnightToday', 'today']);
  });

  it('closes a posting that has not been seen in a long time', async () => {
    seed([
      { id: 'fresh', closesAt: null, lastSeenAt: '2026-08-01T00:00:00Z' },
      { id: 'stale', closesAt: null, lastSeenAt: '2026-05-01T00:00:00Z' },
    ]);

    const summary = await refreshPostings({ now: NOW });

    expect(summary.closedAsStale).toBe(1);
    expect(openIds()).toEqual(['fresh']);
  });
});

/**
 * A stored address on a board this tool will not open.
 *
 * `POST /api/discovery/paste` exists so a student can bring a Handshake, LinkedIn or Indeed
 * posting WITHOUT this tool contacting those sites, and it stores their address as the
 * posting's identity on the undertaking that storing an address is not visiting one. This
 * loop walks every open posting and fetches its canonical URL, filtered on `is_open` alone —
 * so refreshing issued an unattended, timed GET at app.joinhandshake.com, robots.txt request
 * and all. The careful path armed the visit it was built to avoid.
 */
function seedAggregator(): void {
  sqlite.prepare('DELETE FROM job_posting').run();
  for (const [id, url] of [
    ['h1', 'https://app.joinhandshake.com/jobs/1'],
    ['l1', 'https://www.linkedin.com/jobs/view/2'],
    ['a1', 'https://boards.greenhouse.io/acme/jobs/3'],
  ] as const) {
    db.insert(schema.jobPosting)
      .values({
        id,
        company: 'Acme',
        title: `Intern ${id}`,
        canonicalUrl: url,
        applyUrl: url,
        fingerprint: `acme|intern ${id}|nyc`,
        descriptionText: 'A job.',
        isOpen: true,
        closesAt: null,
        firstSeenAt: '2026-07-01T00:00:00Z',
        lastSeenAt: '2026-08-01T00:00:00Z',
      })
      .run();
  }
}

describe('refreshing a posting whose address this tool will not open', () => {
  it('does not fetch it, and counts it as unchecked rather than as checked', async () => {
    // Counted rather than skipped in silence: a posting nobody could re-check is a posting
    // whose freshness is unknown, and reporting it as checked would be exactly the false
    // completeness this summary exists to prevent.
    seedAggregator();
    const real = globalThis.fetch;
    const reached: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      reached.push(String(input));
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    try {
      const summary = await refreshPostings({ now: NOW, checkUrls: true, limit: 10 });
      expect(summary.notChecked).toBe(2);
      expect(reached.join(' ')).not.toMatch(/joinhandshake|linkedin/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('still checks the ones it is allowed to open', async () => {
    seedAggregator();
    const real = globalThis.fetch;
    const reached: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      reached.push(String(input));
      return new Response('ok', { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      const summary = await refreshPostings({ now: NOW, checkUrls: true, limit: 10 });
      expect(summary.checked).toBe(1);
      expect(reached.join(' ')).toMatch(/boards\.greenhouse\.io/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('does not close a posting merely because it could not be checked', async () => {
    // The worst possible reading of "unchecked": a Handshake posting the student pasted
    // themselves disappearing from their queue because this tool declined to visit it.
    seedAggregator();
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof globalThis.fetch;
    try {
      await refreshPostings({ now: NOW, checkUrls: true, limit: 10 });
      expect(openIds()).toContain('h1');
      expect(openIds()).toContain('l1');
    } finally {
      globalThis.fetch = real;
    }
  });
});
