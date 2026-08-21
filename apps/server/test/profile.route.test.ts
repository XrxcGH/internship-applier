/**
 * Clearing a review flag, over the wire.
 *
 * The extractor writes whatever it read into `needsReview`, so a flag is free-form text and
 * genuinely can contain a percent sign — "honors.0.top 5%" is an honour somebody has. The
 * route decoded the path parameter a second time after Fastify had already decoded it,
 * which turned that flag into a URIError, a 500 saying the server had broken, and a flag
 * that could never be cleared. G1 refuses to confirm a profile while any flag is
 * outstanding, so the user was stuck on the wizard with no way forward at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CandidateProfile } from '@ia/shared';
import { buildApp } from '../src/app';
import { runMigrations } from '../src/infra/db/migrate';
import { getProfile, saveProfile } from '../src/core/profile/repository';
import { db, schema } from '../src/infra/db/client';

let app: FastifyInstance;

const PROFILE: CandidateProfile = {
  id: 'prof_review',
  fullName: 'Rosa Alvarez',
  pronouns: null,
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
      fieldOfStudy: 'Computer Science',
      startDate: '2024-09',
      endDate: '2028-05',
      coursework: [],
      honors: ['Top 5%'],
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

/** Exactly what the web client sends: one pass of encodeURIComponent, and no more. */
const clear = (flag: string) =>
  app.inject({
    method: 'POST',
    url: `/api/profile/reviewed/${encodeURIComponent(flag)}`,
  });

beforeAll(async () => {
  runMigrations();
  app = await buildApp({ skipAuth: true });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('POST /api/profile/reviewed/:path', () => {
  const FLAGS = ['education.0.honors.0.top 5%', '100%off', 'experience.0.startDate'];

  beforeEach(() => {
    saveProfile({ ...PROFILE, needsReview: [...FLAGS] });
  });

  it.each(FLAGS)('clears the flag %o', async (flag) => {
    const res = await clear(flag);
    expect(res.statusCode, res.body).toBe(200);
    expect(getProfile()?.needsReview).not.toContain(flag);
  });

  it('leaves the flags it was not asked about alone', async () => {
    await clear('100%off');
    expect(getProfile()?.needsReview).toEqual([
      'education.0.honors.0.top 5%',
      'experience.0.startDate',
    ]);
  });

  it('clears every flag one at a time, so G1 can be reached', async () => {
    for (const flag of FLAGS) expect((await clear(flag)).statusCode).toBe(200);
    expect(getProfile()?.needsReview).toEqual([]);
  });
});

/**
 * What `POST /api/profile/confirm` says when it cannot confirm.
 *
 * `confirmProfile` can throw four different things and only one of them means "nothing is
 * there": the other three are a stored row that will not decrypt, one that will not parse, and
 * a write that failed. All four used to land on one hardcoded 404 reading "No profile yet.
 * Upload a resume first." — so a student whose profile was CORRUPT was told to do the thing
 * they had already done, and doing it again would not have helped, because a re-upload merges
 * over the row that will not read.
 *
 * The split was added and nothing tested it: reverting both halves left the suite green.
 */
describe('confirming a profile that cannot be confirmed', () => {
  const confirm = () => app.inject({ method: 'POST', url: '/api/profile/confirm' });

  it('404s when there genuinely is no profile, and says what to do', async () => {
    db.delete(schema.profile).run();

    const res = await confirm();
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(res.json().error.message).toMatch(/no profile/i);
  });

  it('does NOT 404 when the profile is there but will not read back', async () => {
    saveProfile(PROFILE);
    // Ciphertext that is not ours: `decryptField` throws rather than returning nonsense.
    db.update(schema.profile).set({ dateOfBirth: 'not-a-sealed-value' }).run();

    const res = await confirm();
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL');
    // And it must not repeat the advice that cannot help: uploading again merges over the
    // row that will not read.
    expect(res.json().error.message).toMatch(/stored but could not be read back/i);
    expect(res.json().error.message).not.toMatch(/upload a resume/i);
  });
});
