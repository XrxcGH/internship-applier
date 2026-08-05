/**
 * The tracker over the wire. The point of interest is that the status endpoint refuses
 * transitions the model forbids, rather than trusting whatever the client sends.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { buildApp } from '../src/app';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';

let app: FastifyInstance;
let applicationId: string;

beforeAll(async () => {
  runMigrations();
  app = await buildApp({ skipAuth: true });
  await app.ready();

  const postingId = ulid();
  db.insert(schema.jobPosting)
    .values({
      id: postingId,
      canonicalUrl: `https://example.com/j/${postingId}`,
      applyUrl: `https://example.com/j/${postingId}/apply`,
      company: 'Northwind Systems',
      title: 'Software Engineering Intern',
      descriptionText: 'Summer internship.',
      fingerprint: postingId,
      atsVendor: 'greenhouse',
    })
    .run();

  db.insert(schema.profile)
    .values({ id: 'p1', fullName: 'x', email: 'x', payload: {}, derived: {} } as never)
    .run();

  const matchId = ulid();
  db.insert(schema.match)
    .values({
      id: matchId,
      postingId,
      profileId: 'p1',
      eligibility: 'eligible',
      rules: [],
      blockers: [],
      score: 80,
      breakdown: {},
      rationale: 'test',
    })
    .run();

  applicationId = ulid();
  db.insert(schema.application)
    .values({
      id: applicationId,
      matchId,
      status: 'awaiting_submit',
      applyUrl: `https://example.com/j/${postingId}/apply`,
    })
    .run();
});

afterAll(async () => {
  await app.close();
});

describe('the tracker view', () => {
  it('returns applications, reminders, and stats together', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tracker' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.applications).toHaveLength(1);
    expect(b.applications[0].derived.attention).toBe('awaiting_your_submit');
    expect(b.reminders.length).toBeGreaterThan(0);
    expect(b.stats.funnel.total).toBe(1);
  });

  it('refuses to show a rate it cannot support', async () => {
    const b = (await app.inject({ method: 'GET', url: '/api/tracker' })).json();
    expect(b.stats.responseRate.value).toBeNull();
    expect(b.stats.responseRate.why).toBeTruthy();
  });
});

describe('status changes', () => {
  it('refuses a transition the model forbids', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/status`,
      payload: { status: 'offer' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('refuses to let ghosted be set by hand', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/status`,
      payload: { status: 'ghosted' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/worked out from how long/i);
  });

  it('accepts the user reporting a submission, and stamps the time', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/status`,
      payload: { status: 'submitted' },
    });
    expect(res.statusCode).toBe(200);

    const row = db.select().from(schema.application).all()[0]!;
    expect(row.submittedAt).toBeTruthy();

    // The event log records who, because that is the whole distinction.
    const ev = db
      .select()
      .from(schema.applicationEvent)
      .all()
      .find((e) => e.type === 'status_changed')!;
    expect((ev.payload as { by: string }).by).toBe('user');
  });
});

describe('drafts and export', () => {
  it('returns a follow-up as text, and says it sends nothing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/applications/${applicationId}/draft-message`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain('Subject:');
    expect(res.json().note).toMatch(/nothing here sends email/i);
  });

  it('exports CSV with the right headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tracker/export.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body).toContain('Company');
    expect(res.body).toContain('Northwind Systems');
  });
});

describe('gate G4 holds in the tracker too', () => {
  it('has no endpoint that submits', async () => {
    for (const url of ['/api/tracker/submit', `/api/applications/${applicationId}/send`]) {
      expect((await app.inject({ method: 'POST', url })).statusCode, url).toBe(404);
    }
  });
});
