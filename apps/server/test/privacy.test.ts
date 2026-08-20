/**
 * Export and delete — docs/10 § User control.
 *
 * The delete test is the one that matters. "Delete everything" is a promise, and a test
 * that only checks the endpoint returns 200 would let a soft-delete or a missed table
 * through. This asserts the rows are actually gone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CandidateProfile } from '@ia/shared';
import { getTableName } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { ulid } from 'ulid';
import { buildApp } from '../src/app';
import { db, schema, sqlite } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { saveProfile } from '../src/core/profile/repository';
import { DELETE_CONFIRMATION, buildExport, deleteEverything } from '../src/core/privacy/export';
import { computeCosts, formatUsd } from '../src/core/privacy/costs';
import { saveManualPosting } from '../src/core/discovery/run';
import type { NormalizedPosting } from '../src/core/discovery/sources/types';

let app: FastifyInstance;

const PROFILE = {
  id: 'prof_priv',
  fullName: 'Rosa Alvarez',
  pronouns: null,
  email: 'rosa@example.edu',
  phone: '+1 555 0100',
  dateOfBirth: '2006-03-15',
  address: { line1: '12 Elm St', country: 'US' },
  links: { other: [] },
  workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
  citizenships: ['US'],
  education: [],
  experience: [],
  projects: [],
  skills: [],
  certifications: [],
  languages: [],
  availability: { flexible: true },
  locationPrefs: {
    base: { city: 'New Brunswick', region: 'NJ', country: 'US' },
    additionalBases: [],
    maxCommuteKm: 50,
    remoteOk: true,
    hybridOk: true,
    relocateTo: [],
  },
  preferences: { companySizes: [], roleFamilies: [], industries: [], excludeCompanies: [] },
  derived: {
    age: 20,
    isMinor: false,
    academicLevel: 'undergrad',
    academicYear: 2,
    expectedGraduation: '2028-05',
    yearsProfessionalExperience: 0,
    seniorityBand: 'entry_intern',
  },
  confirmedAt: null,
  needsReview: [],
  createdAt: '2026-08-03T00:00:00Z',
  updatedAt: '2026-08-03T00:00:00Z',
} as CandidateProfile;

beforeAll(async () => {
  runMigrations();
  app = await buildApp({ skipAuth: true });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function seed() {
  saveProfile(PROFILE);
  db.insert(schema.llmCall)
    .values({
      id: ulid(),
      purpose: 'answer_draft',
      model: 'claude-opus-5',
      inputTokens: 2600,
      outputTokens: 350,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 21_750, // micro-dollars
      latencyMs: 4200,
      stopReason: 'end_turn',
    })
    .run();
}

beforeEach(() => {
  db.delete(schema.llmCall).run();
  db.delete(schema.profile).run();
});

/** Every table the database actually has, which is the only list that cannot go stale. */
function liveTables(): string[] {
  return (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
          "AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/**
 * One throwaway row in every table the database has, derived from the database itself.
 *
 * Hand-written fixtures are the reason this file's delete test was hollow: it seeded two
 * tables and then asserted seventeen others were empty, which they already were. A table
 * added tomorrow gets a row here without anybody remembering to add one, which is the only
 * way the assertion below stays honest.
 *
 * Foreign keys are off while this runs. These rows exist to be counted and then destroyed,
 * so they do not need to reference each other, and building a valid graph by hand would put
 * the maintenance burden straight back where it came from.
 */
function seedEveryTable(): void {
  sqlite.pragma('foreign_keys = OFF');
  try {
    for (const table of liveTables()) {
      const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as ColumnInfo[];
      // A column only has to be supplied when the table would otherwise refuse the row.
      const needed = columns.filter(
        (c) => c.pk === 1 || (c.notnull === 1 && c.dflt_value === null),
      );
      // `"seed"` rather than `seed`, because several text columns hold JSON and the reader
      // parses them on the way back out. A bare word makes every later `SELECT` in the
      // process throw, which turns one seeded row into a broken test file.
      const values = needed.map((c) => (/INT|REAL|NUM/i.test(c.type) ? 1 : '"seed"'));
      const sql =
        needed.length === 0
          ? `INSERT INTO "${table}" DEFAULT VALUES`
          : `INSERT INTO "${table}" (${needed.map((c) => `"${c.name}"`).join(', ')}) ` +
            `VALUES (${needed.map(() => '?').join(', ')})`;
      sqlite.prepare(sql).run(...values);
    }
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
}

function rowCount(table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

/** A posting as the "paste a link" screen hands it over. */
function pasted(url: string): NormalizedPosting {
  return {
    externalId: null,
    canonicalUrl: url,
    applyUrl: url,
    company: 'Acme',
    companyDomain: null,
    title: 'Software Engineer Intern',
    descriptionText: 'A job.',
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
    atsVendor: 'unknown',
  } as unknown as NormalizedPosting;
}

describe('export', () => {
  it('returns every table with a filename to save it under', async () => {
    seed();
    const res = await app.inject({ method: 'GET', url: '/api/privacy/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=".*\.json"/);

    const body = JSON.parse(res.body) as {
      counts: Record<string, number>;
      data: Record<string, unknown[]>;
    };
    expect(body.counts.profile).toBe(1);
    expect(Object.keys(body.data).length).toBeGreaterThan(15);
  });

  it('hands back the user’s own data readable, not as ciphertext', async () => {
    // Field encryption protects the file at rest. Exporting a resume the user cannot read
    // would be a filing cabinet with the key thrown away.
    seed();
    const res = await app.inject({ method: 'GET', url: '/api/privacy/export' });
    expect(res.body).toContain('Rosa Alvarez');
    expect(res.body).toContain('rosa@example.edu');
    expect(res.body).not.toMatch(/"fullName":\s*"v1:/);
  });

  /**
   * The export walks every string column of every table and decrypts anything that looks
   * encrypted. Looking encrypted used to mean "starts with v1: and has four colon-separated
   * pieces", which is a shape ordinary writing reaches on its own — and the answers, posting
   * descriptions and templates that reached it were replaced in the export by a message
   * saying they could not be decrypted, while the database still held the real sentence.
   */
  it('hands back an answer that happens to look like ciphertext, word for word', async () => {
    const text = 'v1: gather requirements; v2: prototype; v3: ship it';
    db.insert(schema.answerTemplate)
      .values({ id: ulid(), questionKey: `why-us-${ulid()}`, canonicalText: text })
      .run();

    const body = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/privacy/export' })).body,
    ) as { data: Record<string, Array<Record<string, unknown>>> };

    const stored = body.data['answerTemplate']?.map((r) => r['canonicalText']);
    expect(stored).toContain(text);
  });

  it('says plainly what the file contains', async () => {
    const body = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/privacy/export' })).body,
    ) as { note: string };
    expect(body.note).toMatch(/never sent anywhere|was ever sent anywhere/i);
    expect(body.note).toMatch(/keep it somewhere safe/i);
  });
});

describe('delete', () => {
  it('refuses without the typed phrase, and deletes nothing', async () => {
    seed();
    for (const confirm of ['', 'yes', 'DELETE', 'delete']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/privacy/delete-all',
        payload: { confirm },
      });
      expect(res.statusCode, confirm).toBe(400);
      expect(res.json().error.code).toBe('CONFIRMATION_REQUIRED');
      expect(res.json().error.message).toMatch(/nothing has been deleted/i);
    }
    expect(db.select().from(schema.profile).all()).toHaveLength(1);
  });

  it('previews real counts before asking, rather than saying "your data"', async () => {
    seed();
    const res = await app.inject({ method: 'GET', url: '/api/privacy/delete-preview' });
    const body = res.json() as { items: Array<{ label: string; count: number }>; warning: string };
    expect(body.items.find((i) => i.label === 'Profile')?.count).toBe(1);
    expect(body.warning).toMatch(/no undo/i);
  });

  it('actually removes the rows', async () => {
    seed();
    expect(db.select().from(schema.profile).all()).toHaveLength(1);
    expect(db.select().from(schema.llmCall).all()).toHaveLength(1);

    const res = await app.inject({
      method: 'POST',
      url: '/api/privacy/delete-all',
      payload: { confirm: DELETE_CONFIRMATION },
    });
    expect(res.statusCode).toBe(200);

    // The promise is "everything", so this checks the tables rather than the response.
    expect(db.select().from(schema.profile).all()).toHaveLength(0);
    expect(db.select().from(schema.llmCall).all()).toHaveLength(0);
    expect(res.json().message).toMatch(/restart the app/i);
  });

  /**
   * The list of tables to delete is maintained by hand, and nothing tied it to the schema.
   * Checking two of nineteen tables — which is what this file used to do while its header
   * claimed to catch "a missed table" — would not notice a new table being added and left
   * out, so "delete everything" would quietly stop meaning everything.
   *
   * Every table is given a row FIRST. Asserting a count of zero on a table nothing ever
   * wrote to is not an assertion about the delete at all, and seventeen of the nineteen
   * assertions here were that.
   */
  it('deletes every table in the schema, not just the ones a test remembered', async () => {
    seed();
    seedEveryTable();

    // The seeding has to have worked, or the counts below are back to proving nothing.
    const tables = liveTables();
    expect(tables.length).toBeGreaterThan(15);
    for (const name of tables) {
      expect(
        rowCount(name),
        `${name} was not seeded, so deleting it proves nothing`,
      ).toBeGreaterThan(0);
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/privacy/delete-all',
      payload: { confirm: DELETE_CONFIRMATION },
    });
    expect(res.statusCode).toBe(200);

    for (const name of tables) {
      expect(rowCount(name), `${name} still has rows after "delete everything"`).toBe(0);
    }
  });

  /**
   * The hand-maintained list, checked against the database rather than against a number.
   *
   * `expect(tables.length).toBeGreaterThan(15)` reads like it guards the list and does not:
   * it passes at nineteen and would pass at twenty, which is precisely the case where a
   * table has been added and left out. This names the missing table instead.
   *
   * Read through `buildExport`, because the list itself is private to export.ts — its keys
   * ARE that list, and export and delete walk the same one.
   */
  it('names every table the database has, so a new one cannot be left out', () => {
    const listed = new Set(
      Object.keys(buildExport().data).map((key) =>
        getTableName(schema[key as keyof typeof schema] as SQLiteTable),
      ),
    );
    expect(liveTables().filter((t) => !listed.has(t))).toEqual([]);
  });

  /**
   * "Delete everything" ended by listing what it could not delete, and the OS credential
   * store was always on that list — the check treated "there was no entry to remove" the
   * same as "we could not reach the store". So every successful wipe told the user to go
   * and hunt down a keychain entry by hand, on machines where there was nothing left to
   * find, at the exact moment they were being asked to trust that the deletion was real.
   */
  it('does not report a keychain failure when there was nothing to fail', async () => {
    seed();
    const res = await app.inject({
      method: 'POST',
      url: '/api/privacy/delete-all',
      payload: { confirm: DELETE_CONFIRMATION },
    });
    const body = res.json() as { failed: Array<{ path: string; reason: string }> };
    expect(body.failed.map((f) => f.path)).not.toContain('OS credential store');
  });

  it('accepts the phrase regardless of casing or surrounding space', async () => {
    seed();
    const res = await app.inject({
      method: 'POST',
      url: '/api/privacy/delete-all',
      payload: { confirm: '  Delete Everything  ' },
    });
    expect(res.statusCode).toBe(200);
  });

  /**
   * The app has to still work afterwards, and for a while it did not.
   *
   * Discovery memoised source label → row id in a module-level Map that nothing cleared.
   * "Delete everything" truncates the source table while foreign keys are on, so the next
   * run handed the job_posting_source insert an id for a row that no longer existed and the
   * whole run died on "FOREIGN KEY constraint failed" — surfacing to the user as a 500 from
   * a search, or "Could not read that URL" about a URL that had been read perfectly. It
   * happened on every run until somebody restarted the process. The delete reply does say
   * "restart the app", but that is advice and the app carries on running.
   */
  it('leaves the app able to save a posting again', async () => {
    db.delete(schema.jobPostingSource).run();
    db.delete(schema.jobPosting).run();
    db.delete(schema.source).run();

    saveManualPosting(pasted('https://acme.com/jobs/before'));
    expect(db.select().from(schema.source).all()).toHaveLength(1);

    await deleteEverything();
    expect(db.select().from(schema.source).all()).toHaveLength(0);

    const id = saveManualPosting(pasted('https://acme.com/jobs/after'));
    expect(id).not.toBe('');
    expect(db.select().from(schema.jobPosting).all()).toHaveLength(1);
    // The source row is recreated rather than referenced by a remembered id.
    expect(db.select().from(schema.source).all()).toHaveLength(1);
    expect(db.select().from(schema.jobPostingSource).all()).toHaveLength(1);
  });
});

describe('costs', () => {
  it('reads the ledger rather than estimating', async () => {
    seed();
    const res = await app.inject({ method: 'GET', url: '/api/costs' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { totalUsd: number; byPurpose: Array<{ purpose: string }> };
    expect(body.totalUsd).toBeCloseTo(0.0218, 3);
    expect(body.byPurpose[0]?.purpose).toBe('answer_draft');
  });

  it('explains a zero total instead of showing $0.00 like a bug', () => {
    db.insert(schema.llmCall)
      .values({
        id: ulid(),
        purpose: 'answer_draft',
        model: 'claude-code-cli',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        latencyMs: 100,
        stopReason: null,
      })
      .run();

    const c = computeCosts();
    expect(c.totalUsd).toBe(0);
    // A CLI call that genuinely reported nothing. This used to be every CLI call, because the
    // ledger was written a hardcoded zero — so the note explained the zero by naming the
    // subscription, on rows that had no figure to explain.
    expect(c.note).toMatch(/none of which reported a cost/i);
  });

  it('names the subscription when the CLI reported what the work was worth', () => {
    // The CLI puts `total_cost_usd` on every envelope and those figures are recorded now, so a
    // CLI-only user has a NON-ZERO total that is not a bill. Reporting it as "$0.04 in total"
    // would be false in the direction that matters.
    db.insert(schema.llmCall)
      .values({
        id: ulid(),
        purpose: 'answer_draft',
        model: 'claude-code-cli',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 40_000,
        latencyMs: 100,
        stopReason: null,
      })
      .run();

    const c = computeCosts();
    expect(c.note).toMatch(/None of it is billed to you/i);
    expect(c.note).toMatch(/subscription you already pay for/i);
    expect(c.note).toMatch(/would have cost/i);
  });

  it('tells API spend apart from subscription usage when both are present', () => {
    for (const [model, costUsd] of [
      ['claude-code-cli', 40_000],
      ['claude-opus-5', 25_000],
    ] as const) {
      db.insert(schema.llmCall)
        .values({
          id: ulid(),
          purpose: 'answer_draft',
          model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd,
          latencyMs: 100,
          stopReason: null,
        })
        .run();
    }

    const c = computeCosts();
    expect(c.note).toMatch(/billed to your API key/i);
    expect(c.note).toMatch(/not billed to you/i);
  });

  it('says so when nothing has run', () => {
    expect(computeCosts().note).toMatch(/no model calls yet/i);
  });

  it('shows small amounts at a precision that distinguishes them', () => {
    // Rounding a two-cent drafting call to $0.01 would make a season of work look
    // like a column of identical rows.
    expect(formatUsd(0)).toBe('$0');
    // Three decimals still separates a 2.2-cent call from a 1.5-cent one. The fourth is
    // reserved for amounts under a cent, where it is the difference between a number and
    // a row of zeroes.
    expect(formatUsd(0.0218)).toBe('$0.022');
    expect(formatUsd(0.0004)).toBe('$0.0004');
    expect(formatUsd(0.35)).toBe('$0.350');
    expect(formatUsd(12.5)).toBe('$12.50');
  });
});
