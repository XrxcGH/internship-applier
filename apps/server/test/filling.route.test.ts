/**
 * The gates around filling, over the wire.
 *
 * Nothing here opens a browser: these assert that the server REFUSES before it would. The
 * behavioural fill tests live in fill.test.ts against the fixture.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CandidateProfile, FormField } from '@ia/shared';
import { ulid } from 'ulid';
import { buildApp } from '../src/app';
import { eq } from 'drizzle-orm';
import { config } from '../src/config';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { encryptField, isEncrypted } from '../src/infra/crypto/fieldCrypto';
import { confirmProfile, saveProfile } from '../src/core/profile/repository';
import { buildFillPlan } from '../src/core/filling/plan';
import { load } from '../src/routes/filling';

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

/**
 * Gate G1, over the wire.
 *
 * Every other test in this file runs with the profile already confirmed, so the check that
 * refuses a run built on facts the user has never looked at was never once exercised. It is
 * the gate standing between the extractor's guesses — a misread graduation date, a phone
 * number picked out of a footer — and an employer's form, and it needs a test of its own so
 * that dropping it is a failure rather than a silent change of behaviour.
 */
describe('gate G1 blocks filling', () => {
  beforeEach(() => {
    // The fixture is declared with `confirmedAt: null`, so writing it back is exactly what
    // an unconfirmed profile looks like from the route's side.
    saveProfile(PROFILE);
  });

  afterEach(() => {
    confirmProfile();
  });

  it('refuses a run against a profile the user has not confirmed', async () => {
    addAnswer(true);
    for (const url of [
      `/api/applications/${applicationId}/fill`,
      `/api/applications/${applicationId}/fill/continue`,
    ]) {
      const res = await app.inject({ method: 'POST', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code, url).toBe('PROFILE_INCOMPLETE');
      // Says which gate, because "incomplete" on its own does not tell anyone what to do.
      expect(res.json().error.message, url).toMatch(/confirm your profile/i);
    }
  });

  it('checks the profile before it checks the answers', async () => {
    // The other order would let an unapproved answer stand in for the missing confirmation:
    // the user fixes the answer, gets a second refusal, and only then learns about G1.
    addAnswer(false);
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/fill`,
    });
    expect(res.json().error.code).toBe('PROFILE_INCOMPLETE');
  });
});

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

/**
 * What the run is told to attach.
 *
 * `resume_document.path` is encrypted at rest, and the loader used to pass that column
 * through untouched: the filler was handed `v1:RUBjO4-OGVlnZuT4:...` as a filename, so
 * every resume upload field on every form came back red with a raw ENOENT, and nobody
 * could get a resume attached at all. These run against the loader rather than the route
 * because the route opens a browser.
 */
describe('the resume a fill run attaches', () => {
  function addResume({ onDisk = true } = {}) {
    const id = ulid();
    mkdirSync(config.paths.resumes, { recursive: true });
    const stored = path.join(config.paths.resumes, `${id}.txt`);
    if (onDisk) writeFileSync(stored, 'Rosa Alvarez\nRutgers University\n');
    // Stored exactly the way POST /api/resumes stores it, ciphertext and all.
    db.insert(schema.resumeDocument)
      .values({
        id,
        filename: 'rosa.txt',
        path: encryptField(stored, id),
        mime: 'text/plain',
        bytes: 30,
        sha256: 'a'.repeat(64),
        isPrimary: true,
      })
      .run();
    return stored;
  }

  function loadOk() {
    const result = load(applicationId);
    if (!result.ok) throw new Error(`load refused: ${result.code} ${result.message}`);
    return result.data;
  }

  const RESUME_FIELD: FormField = {
    id: 'f_resume',
    locator: '#resume',
    label: 'Resume',
    control: 'file',
    required: true,
    semantic: 'resume_upload',
    confidence: 0.95,
  };

  afterEach(() => {
    db.delete(schema.resumeDocument).run();
  });

  it('is a file that exists on disk, not the encrypted column', () => {
    const stored = addResume();
    const { resumePath } = loadOk();

    expect(resumePath).toBe(stored);
    expect(isEncrypted(resumePath ?? '')).toBe(false);
    expect(existsSync(resumePath ?? '')).toBe(true);
  });

  function planFor(field: FormField) {
    const data = loadOk();
    return buildFillPlan({
      fields: [field],
      profile: data.profile,
      answers: data.answers,
      resumePath: data.resumePath,
    });
  }

  it('reaches the plan as the path the browser will be given', () => {
    const stored = addResume();
    const plan = planFor(RESUME_FIELD);

    expect(plan.skips).toEqual([]);
    expect(plan.actions[0]?.filePath).toBe(stored);
  });

  it('is nothing at all when the file has been deleted from under the row', () => {
    // Better to say "no resume" than to hand the browser a path it cannot open: the first
    // is a skip the user can act on, the second is a failed field full of internals.
    addResume({ onDisk: false });

    expect(loadOk().resumePath).toBeUndefined();
    const plan = planFor(RESUME_FIELD);
    expect(plan.actions).toEqual([]);
    expect(plan.skips[0]?.note).toMatch(/no resume file is attached/i);
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
    // The row is seeded as `draft` for the G3 tests above, and draft → submitted is not a
    // transition the state machine allows. Advancing it here keeps those fixtures intact
    // while putting this application where a real one would be by the time anybody could
    // have clicked Submit on the employer's page.
    db.update(schema.application)
      .set({ status: 'awaiting_submit' })
      .where(eq(schema.application.id, applicationId))
      .run();

    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/mark-submitted`,
      payload: { confirmed: true },
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

  /**
   * The confirmation is the whole point of this endpoint.
   *
   * `{ confirmed: true }` used to be declared in the shared schema and never read, so the
   * one machine-checkable half of gate G4 was decorative: any POST at all stamped an
   * application submitted. These two tests exist so it cannot quietly become decorative
   * again.
   */
  it('refuses to record a submission nobody confirmed', async () => {
    db.update(schema.application)
      .set({ status: 'awaiting_submit', submittedAt: null })
      .where(eq(schema.application.id, applicationId))
      .run();

    for (const payload of [undefined, {}, { confirmed: false }, { confirmed: 'yes' }]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/applications/${applicationId}/mark-submitted`,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('CONFIRMATION_REQUIRED');
    }

    // And nothing was recorded on the way past.
    const row = db.select().from(schema.application).all()[0]!;
    expect(row.submittedAt).toBeNull();
    expect(row.status).toBe('awaiting_submit');
  });

  it('refuses a transition the state machine does not allow', async () => {
    db.update(schema.application)
      .set({ status: 'draft', submittedAt: null })
      .where(eq(schema.application.id, applicationId))
      .run();

    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/mark-submitted`,
      payload: { confirmed: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ILLEGAL_TRANSITION');
    expect(db.select().from(schema.application).all()[0]!.submittedAt).toBeNull();
  });
});

/**
 * Gate G2, reversed.
 *
 * Approving a match creates an application. Changing that decision to skipped or rejected
 * used to replace the decision row, answer `applicationId: null` and leave the application
 * standing — so the posting disappeared from the match queue, which hides anything decided,
 * while the tracker went on showing the card, every gate in `load()` went on passing for it,
 * and it could be walked all the way to `submitted`. The response saying there was no
 * application was the only part a client could see, and it was false.
 */
describe('gate G2 — undoing an approval takes the application with it', () => {
  let matchId: string;

  beforeEach(() => {
    const postingId = ulid();
    db.insert(schema.jobPosting)
      .values({
        id: postingId,
        canonicalUrl: `https://example.com/j/${postingId}`,
        applyUrl: `https://example.com/j/${postingId}/apply`,
        company: 'Kestrel Analytics',
        title: 'Backend Intern',
        descriptionText: 'Summer internship.',
        fingerprint: postingId,
      })
      .run();

    matchId = ulid();
    db.insert(schema.match)
      .values({
        id: matchId,
        postingId,
        profileId: PROFILE.id,
        eligibility: 'eligible',
        rules: [],
        blockers: [],
        score: 70,
        breakdown: {},
        rationale: 'test',
      })
      .run();
  });

  afterEach(() => {
    // Leave the file's own fixture as the only application again — several tests above read
    // `db.select().from(schema.application).all()[0]`.
    for (const row of db.select().from(schema.application).all()) {
      if (row.matchId !== matchId) continue;
      db.delete(schema.applicationAnswer)
        .where(eq(schema.applicationAnswer.applicationId, row.id))
        .run();
      db.delete(schema.applicationEvent)
        .where(eq(schema.applicationEvent.applicationId, row.id))
        .run();
      db.delete(schema.application).where(eq(schema.application.id, row.id)).run();
    }
    db.delete(schema.decision).where(eq(schema.decision.matchId, matchId)).run();
  });

  const decide = (action: string) =>
    app.inject({
      method: 'POST',
      url: `/api/matches/${matchId}/decision`,
      payload: { action, reason: 'changed my mind' },
    });

  it.each(['rejected', 'skipped', 'saved'])(
    'deletes the application it created when the decision becomes %s',
    async (action) => {
      const approved = await decide('approved');
      const created = approved.json().applicationId as string;
      expect(created).toBeTruthy();

      const reversed = await decide(action);
      expect(reversed.statusCode).toBe(200);
      expect(reversed.json().applicationId).toBeNull();
      expect(reversed.json().deletedApplicationId).toBe(created);

      // The claim in that body is now true: there is no application for this match.
      expect(
        db.select().from(schema.application).where(eq(schema.application.matchId, matchId)).all(),
      ).toEqual([]);

      // And nothing downstream is still holding one.
      expect(load(created)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      const list = await app.inject({ method: 'GET', url: '/api/applications' });
      expect((list.json().applications as Array<{ id: string }>).map((a) => a.id)).not.toContain(
        created,
      );
      const tracker = await app.inject({ method: 'GET', url: '/api/tracker' });
      expect((tracker.json().applications as Array<{ id: string }>).map((a) => a.id)).not.toContain(
        created,
      );
    },
  );

  it('takes the answers with it rather than orphaning them', async () => {
    const created = (await decide('approved')).json().applicationId as string;
    db.insert(schema.applicationAnswer)
      .values({
        id: ulid(),
        applicationId: created,
        questionText: 'Why here?',
        fieldKey: 'q1',
        answerType: 'long_text',
        draftText: 'Because.',
        finalText: 'Because.',
      })
      .run();

    await decide('rejected');
    expect(
      db
        .select()
        .from(schema.applicationAnswer)
        .where(eq(schema.applicationAnswer.applicationId, created))
        .all(),
    ).toEqual([]);
  });

  it('refuses instead of deleting an application the user has already submitted', async () => {
    const created = (await decide('approved')).json().applicationId as string;
    db.update(schema.application)
      .set({ status: 'submitted', submittedAt: new Date().toISOString() })
      .where(eq(schema.application.id, created))
      .run();

    const reversed = await decide('rejected');
    expect(reversed.statusCode).toBe(409);
    expect(reversed.json().error.code).toBe('APPLICATION_IN_PROGRESS');
    expect(reversed.json().error.details.applicationId).toBe(created);

    // Still there, and still submitted. Nothing the user did in the world was thrown away.
    const row = db
      .select()
      .from(schema.application)
      .where(eq(schema.application.id, created))
      .all();
    expect(row).toHaveLength(1);
    expect(row[0]!.status).toBe('submitted');
  });

  it('says nothing was deleted when the match was never approved', async () => {
    const res = await decide('rejected');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ action: 'rejected', applicationId: null });
    expect(res.json().deletedApplicationId).toBeUndefined();
  });
});

/**
 * The list of fields the user still has to fill in by hand.
 *
 * A finished run writes it onto the application, and the panel that shows it reads the run
 * in memory — which is gone when the browser is closed, when a second run starts and when
 * the server restarts. Nothing returned the stored copy, so after any of those the fields
 * still needing a person existed only in a column no endpoint would give back.
 */
describe('skipped fields survive the run that found them', () => {
  it('comes back from GET /api/applications/:id', async () => {
    const skipped = [
      { label: 'Social Security Number', reason: 'redline', category: 'government_id' },
      { label: 'Preferred pronouns', reason: 'unclassified' },
    ];
    db.update(schema.application)
      .set({ skippedFields: skipped })
      .where(eq(schema.application.id, applicationId))
      .run();

    const res = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().skippedFields).toEqual(skipped);
  });

  it('is an empty list, not missing, when no run has finished yet', async () => {
    db.update(schema.application)
      .set({ skippedFields: null })
      .where(eq(schema.application.id, applicationId))
      .run();

    const res = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}` });
    expect(res.json().skippedFields).toEqual([]);
  });
});
