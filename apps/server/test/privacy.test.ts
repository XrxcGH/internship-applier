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
import { ulid } from 'ulid';
import { buildApp } from '../src/app';
import { db, schema, sqlite } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { saveProfile } from '../src/core/profile/repository';
import { DELETE_CONFIRMATION } from '../src/core/privacy/export';
import { computeCosts, formatUsd } from '../src/core/privacy/costs';

let app: FastifyInstance;

const PROFILE = {
  id: 'prof_priv',
  fullName: 'Rosa Alvarez',
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
    maxCommuteKm: 50,
    remoteOk: true,
    hybridOk: true,
    relocateTo: [],
  },
  preferences: { companySizes: [], industries: [], excludeCompanies: [] },
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
   */
  it('deletes every table in the schema, not just the ones a test remembered', async () => {
    seed();

    const res = await app.inject({
      method: 'POST',
      url: '/api/privacy/delete-all',
      payload: { confirm: DELETE_CONFIRMATION },
    });
    expect(res.statusCode).toBe(200);

    // Read from sqlite_master rather than from the hand-maintained TABLES const, so a
    // table added to the schema and forgotten in that list fails here.
    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
          "AND name NOT LIKE '__drizzle%'",
      )
      .all() as Array<{ name: string }>;
    expect(tables.length).toBeGreaterThan(15);

    for (const { name } of tables) {
      const { n } = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
      expect(n, `${name} still has rows after "delete everything"`).toBe(0);
    }
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
    expect(c.note).toMatch(/subscription you already pay for/i);
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
