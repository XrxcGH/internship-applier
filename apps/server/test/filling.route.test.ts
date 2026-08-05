/**
 * The gates around filling, over the wire.
 *
 * Nothing here opens a browser: these assert that the server REFUSES before it would. The
 * behavioural fill tests live in fill.test.ts against the fixture.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CandidateProfile } from '@ia/shared';
import { ulid } from 'ulid';
import { buildApp } from '../src/app';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { confirmProfile, saveProfile } from '../src/core/profile/repository';

let app: FastifyInstance;
let applicationId: string;

const PROFILE = {
  id: 'prof_fill',
  fullName: 'Rosa Alvarez',
  email: 'rosa@example.edu',
  dateOfBirth: '2006-03-15',
  address: { country: 'US' },
  links: { other: [] },
  workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
  citizenships: ['US'],
  education: [
    {
      institution: 'Rutgers University',
      level: 'bachelor',
      endDate: '2028-05',
      coursework: [],
      honors: [],
    },
  ],
  experience: [],
  projects: [],
  skills: [],
  certifications: [],
  languages: [],
  availability: { start: '2027-06-01', end: '2027-08-20', flexible: true },
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

  saveProfile(PROFILE);
  confirmProfile();

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
    })
    .run();

  const matchId = ulid();
  db.insert(schema.match)
    .values({
      id: matchId,
      postingId,
      profileId: PROFILE.id,
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
      status: 'draft',
      applyUrl: `https://example.com/j/${postingId}/apply`,
    })
    .run();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  db.delete(schema.applicationAnswer).run();
});

function addAnswer(approved: boolean, question = 'Why do you want this internship?') {
  const id = ulid();
  db.insert(schema.applicationAnswer)
    .values({
      id,
      applicationId,
      questionText: question,
      fieldKey: 'q1',
      answerType: 'long_text',
      draftText: 'Because the work is interesting.',
      finalText: 'Because the work is interesting.',
      approvedAt: approved ? new Date().toISOString() : null,
    })
    .run();
  return id;
}

describe('gate G3 blocks filling', () => {
  it('refuses to open a browser while an answer is unapproved', async () => {
    addAnswer(false);
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/fill`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ANSWERS_NOT_APPROVED');
    // Names the question, so the user knows which one to go and review.
    expect(res.json().error.details.questions[0]).toMatch(/why do you want/i);
  });

  it('names the count when several are unapproved', async () => {
    addAnswer(false, 'Question one?');
    addAnswer(false, 'Question two?');
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/fill`,
    });
    expect(res.json().error.message).toMatch(/2 answers/);
  });

  it('refuses on continue as well, not just on start', async () => {
    // Otherwise approving, starting a run, then unapproving would slip past the gate.
    addAnswer(false);
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/fill/continue`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ANSWERS_NOT_APPROVED');
  });
});

describe('no run, no fill', () => {
  it('will not type into a page it never opened', async () => {
    addAnswer(true);
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/fill/continue`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NO_RUN');
  });

  it('reports no open run rather than inventing one', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}/fill` });
    expect(res.statusCode).toBe(404);
  });
});

describe('gate G4', () => {
  it('exposes no endpoint that submits an application', async () => {
    for (const url of [
      `/api/applications/${applicationId}/submit`,
      `/api/applications/${applicationId}/fill/submit`,
      `/api/applications/${applicationId}/send`,
    ]) {
      expect((await app.inject({ method: 'POST', url })).statusCode, url).toBe(404);
    }
  });

  it('records that the USER submitted, without touching a browser', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/mark-submitted`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('submitted');
    expect(res.json().submittedAt).toBeTruthy();

    const row = db.select().from(schema.application).all()[0]!;
    expect(row.submittedAt).toBeTruthy();

    // The event log says who did it, because that distinction is the whole design.
    const events = db.select().from(schema.applicationEvent).all();
    const marked = events.find((e) => e.type === 'marked_submitted')!;
    expect((marked.payload as { by: string }).by).toBe('user');
  });
});
