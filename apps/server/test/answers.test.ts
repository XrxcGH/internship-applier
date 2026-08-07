/**
 * Gate G3, over the wire.
 *
 * `factGuard.test.ts` proves the checker catches fabrications. This proves the server
 * refuses to approve an answer that holds one — the check has to be enforced where a
 * modified client cannot route around it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CandidateProfile } from '@ia/shared';
import { ulid } from 'ulid';
import { buildApp } from '../src/app';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { confirmProfile, saveProfile } from '../src/core/profile/repository';
import {
  classifyQuestion,
  describeEditing,
  editFraction,
  findReusable,
  saveApproved,
  wordEditDistance,
} from '../src/core/writing/answerLibrary';

let app: FastifyInstance;
let applicationId: string;

const PROFILE: CandidateProfile = {
  id: 'prof_g3',
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
      fieldOfStudy: 'Computer Science',
      startDate: '2024-09',
      endDate: '2028-05',
      gpa: { value: 3.62, scale: 4 },
      coursework: [],
      honors: [],
    },
  ],
  experience: [
    {
      organization: 'Kestrel Analytics',
      title: 'Software Engineering Intern',
      type: 'internship',
      startDate: '2026-06',
      endDate: '2026-08',
      bullets: [
        'Built internal tooling that let the support team resolve billing tickets without an engineer',
      ],
      skills: ['TypeScript'],
    },
  ],
  projects: [],
  skills: [{ name: 'TypeScript', category: 'language', evidence: [] }],
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
    yearsProfessionalExperience: 0.2,
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
      canonicalUrl: `https://example.com/jobs/${postingId}`,
      applyUrl: `https://example.com/jobs/${postingId}/apply`,
      company: 'Northwind Systems',
      title: 'Software Engineering Intern, Summer 2027',
      descriptionText: 'We are hiring summer interns to work on internal developer tooling.',
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
      applyUrl: `https://example.com/jobs/${postingId}/apply`,
    })
    .run();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  db.delete(schema.applicationAnswer).run();
  db.delete(schema.answerTemplate).run();
});

async function addQuestion(questionText: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/applications/${applicationId}/questions`,
    payload: { questionText },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function write(id: string, text: string): Promise<void> {
  const res = await app.inject({ method: 'PATCH', url: `/api/answers/${id}`, payload: { text } });
  expect(res.statusCode).toBe(200);
}

describe('G3 — approval is blocked by unverified claims', () => {
  it('refuses to approve an answer with an invented employer', async () => {
    const id = await addQuestion('Tell us about a project you are proud of.');
    await write(id, 'I spent last summer at Google building search infrastructure.');

    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('UNVERIFIED_CLAIMS');
    expect(res.json().error.details.claims[0].reason).toContain('Google');

    const after = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}` });
    expect(after.json().answers[0].approvedAt).toBeNull();
  });

  it('refuses to approve an inflated duration', async () => {
    const id = await addQuestion('Describe your most relevant experience.');
    await write(id, 'I worked at Kestrel Analytics for three years on their billing systems.');

    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
    expect(res.statusCode).toBe(409);
  });

  it('approves an answer the profile supports', async () => {
    const id = await addQuestion('Tell us about a project you are proud of.');
    await write(
      id,
      'I interned at Kestrel Analytics, where I built internal tooling in TypeScript. ' +
        'The support team had been filing tickets at engineers to answer billing questions, ' +
        'so I gave them a way to resolve those themselves.',
    );

    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
    expect(res.statusCode).toBe(200);
    expect(res.json().approvedAt).toBeTruthy();
  });

  it('drops approval when the text is edited afterwards', async () => {
    const id = await addQuestion('Tell us about a project you are proud of.');
    await write(id, 'I interned at Kestrel Analytics and built internal tooling in TypeScript.');
    expect(
      (await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` })).statusCode,
    ).toBe(200);

    await write(
      id,
      'I interned at Kestrel Analytics and built internal tooling in TypeScript. Also I led the team.',
    );
    const after = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}` });
    expect(after.json().answers[0].approvedAt).toBeNull();
  });

  it('refuses to approve an empty answer', async () => {
    const id = await addQuestion('Anything else you would like us to know?');
    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
    expect(res.statusCode).toBe(400);
  });

  it('exposes no endpoint that approves every answer at once', async () => {
    for (const url of [
      `/api/applications/${applicationId}/approve`,
      `/api/applications/${applicationId}/answers/approve-all`,
      '/api/answers/approve-all',
    ]) {
      expect((await app.inject({ method: 'POST', url })).statusCode).toBe(404);
    }
  });
});

/**
 * Naming the employer you are writing to.
 *
 * The company and the role title come from the posting and are nowhere on the profile, so
 * FactGuard has to be handed them or it reads them as inventions. It was not, on any code
 * path: every answer that named Northwind Systems came back from G3 with `"Northwind
 * Systems" does not appear anywhere on your profile`, and since G3 has no override the only
 * way to satisfy that message was to add a job at Northwind the user never had — which is
 * the fabrication FactGuard exists to stop. Mentioning is all this buys, which is the second
 * half of these tests: claiming to have WORKED there is still refused.
 */
describe('G3 — the posting supplies names the profile cannot', () => {
  const approve = (id: string) => app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });

  it('approves an answer that names the company it is addressed to', async () => {
    const id = await addQuestion('Why do you want to intern here?');
    await write(
      id,
      'What draws me to Northwind Systems is the quality of their developer documentation.',
    );
    const res = await approve(id);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(res.json().approvedAt).toBeTruthy();
  });

  it('approves it wherever in the sentence the name falls', async () => {
    // The company opening the sentence goes down a different branch of the name extractor
    // (`extractProperNouns` drops a lone capitalised opener), so a fix proved only on a
    // mid-sentence mention would leave this one blocked.
    const id = await addQuestion('Why do you want to intern here?');
    await write(
      id,
      'Northwind Systems builds the kind of internal tooling I spent last summer building.',
    );
    expect((await approve(id)).statusCode).toBe(200);
  });

  it('extends the same allowance to the role title', async () => {
    const id = await addQuestion('Why are you interested in this role?');
    await write(
      id,
      'I am applying for the Software Engineering Intern role because Northwind Systems ' +
        'works on developer tooling.',
    );
    expect((await approve(id)).statusCode).toBe(200);
  });

  it('still refuses a claim of having worked there', async () => {
    const id = await addQuestion('Describe your most relevant experience.');
    await write(id, 'I interned at Northwind Systems last summer and shipped their billing tools.');
    const res = await approve(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('UNVERIFIED_CLAIMS');
    expect(res.json().error.details.claims[0].reason).toMatch(/employer you are applying to/);
  });

  it('still refuses an employer that is neither on the profile nor on the posting', async () => {
    const id = await addQuestion('Tell us about a project you are proud of.');
    await write(id, 'I spent last summer at Google building search infrastructure.');
    expect((await approve(id)).statusCode).toBe(409);
  });

  it('stores no blocking flag for the mention when the answer is merely edited', async () => {
    // The PATCH route re-verifies too, and it was the same call with the same missing
    // argument. Left unfixed, approval would succeed while the review screen went on
    // showing a red "does not appear anywhere on your profile" against the same sentence.
    const id = await addQuestion('Why do you want to intern here?');
    await write(id, 'What draws me to Northwind Systems is their developer documentation.');

    const after = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}` });
    const flags = after.json().answers[0].flags as Array<{ type: string }>;
    expect(flags.filter((f) => f.type === 'unsupported' || f.type === 'overstated')).toEqual([]);
  });
});

/**
 * Gate G1, from the approval side.
 *
 * The fact check runs against the confirmed profile, so with no confirmed profile there is
 * nothing to check a claim against. A verification that could not run must not read as a
 * verification that passed: a null result once meant "zero blocking flags", which let any
 * text at all through the gate and on towards an employer's form.
 */
describe('G1 — approval needs a confirmed profile', () => {
  afterEach(() => {
    confirmProfile();
  });

  it('refuses to approve while the profile is unconfirmed', async () => {
    const id = await addQuestion('Tell us about a project you are proud of.');
    // Text the profile fully supports, so G1 is the only thing that can refuse it.
    await write(id, 'I interned at Kestrel Analytics and built internal tooling in TypeScript.');

    // The fixture is declared with `confirmedAt: null`, so writing it back un-confirms it.
    saveProfile(PROFILE);

    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PROFILE_INCOMPLETE');
    expect(res.json().error.message).toMatch(/confirm your profile/i);

    // And nothing was stamped on the way past.
    expect(db.select().from(schema.applicationAnswer).all()[0]!.approvedAt).toBeNull();
  });
});

/**
 * The suite pins LLM_PROVIDER=none (see vitest.setup.ts), so "no model available" is the
 * deterministic state here regardless of what is installed on the machine running it.
 */
describe('drafting without model access', () => {
  it('explains the situation instead of failing opaquely', async () => {
    const id = await addQuestion('Why do you want to intern here?');
    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/draft` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NO_MODEL_ACCESS');
    // Names both routes in, and the fallback. A dead end here is a dead end for the app.
    expect(res.json().error.message).toContain('Claude Code CLI');
    expect(res.json().error.message).toContain('write the answer yourself');
  });

  it('reports what is and is not available, without pretending', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/model-access' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(false);
    expect(body.provider).toBe('none');
    // The limitations have to say the rest of the app still works, or a user with no
    // model access will reasonably assume the whole tool is broken.
    expect(body.limitations.join(' ')).toMatch(/Everything else works/);
  });

  it('still fact-checks an answer the user wrote by hand', async () => {
    const id = await addQuestion('Tell us about a project you are proud of.');
    await write(id, 'I spent last summer at Google building search infrastructure.');
    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('UNVERIFIED_CLAIMS');
  });
});

describe('answer library', () => {
  it('classifies the questions that actually get asked', () => {
    expect(classifyQuestion('Why do you want to work at Northwind?').archetype).toBe('why_company');
    expect(classifyQuestion('Why are you interested in this role?').archetype).toBe('why_role');
    expect(classifyQuestion('Tell us about a project you are proud of.').archetype).toBe(
      'proud_of',
    );
    expect(classifyQuestion('Describe a challenging bug you fixed.').archetype).toBe('challenge');
    expect(classifyQuestion('How did you hear about this opening?').archetype).toBe('how_heard');
  });

  it('gives unrecognised questions a key that survives rewording', () => {
    const a = classifyQuestion('What is your favorite text editor?');
    const b = classifyQuestion('Please, briefly: what is your favorite text editor? (100 words)');
    expect(a.archetype).toBe('other');
    expect(a.key).toBe(b.key);
  });

  it('reuses a general answer across companies', () => {
    saveApproved('Tell us about a project you are proud of.', 'The tide chart.', 'Kestrel');
    expect(findReusable('Tell us about a project you are proud of.', 'Northwind')?.text).toBe(
      'The tide chart.',
    );
  });

  it('never reuses a company-specific answer for a different company', () => {
    saveApproved('Why do you want to work at Kestrel?', 'Because Kestrel does X.', 'Kestrel');
    expect(findReusable('Why do you want to work at Northwind?', 'Northwind')).toBeNull();
    expect(findReusable('Why do you want to work at Kestrel?', 'Kestrel')?.text).toBe(
      'Because Kestrel does X.',
    );
  });

  it('offers nothing that was never approved', () => {
    expect(findReusable('Tell us about a project you are proud of.', 'Northwind')).toBeNull();
  });

  it('never reuses an answer whose own text names the company it was written for', () => {
    // The archetype flag says whether a good answer to this QUESTION names the company;
    // it says nothing about what the writer actually typed. A `proud_of` answer is
    // reusable by archetype, so before this check one that happened to name Kestrel was
    // handed to the next application verbatim and the Northwind form went out talking
    // about Kestrel. Reuse is a convenience; a letter addressed to the wrong employer
    // ends the application, so the ambiguous case is refused and the user writes fresh.
    saveApproved(
      'Tell us about a project you are proud of.',
      'I built internal tooling at Kestrel.',
      'Kestrel',
    );
    expect(findReusable('Tell us about a project you are proud of.', 'Northwind')).toBeNull();
    expect(findReusable('Tell us about a project you are proud of.', 'Kestrel')?.text).toContain(
      'Kestrel',
    );
  });

  /**
   * The two shapes of company name the whole-string check could not see.
   *
   * Companies are stored exactly as the posting writes them — "IBM Corp.", "Box, Inc." —
   * while the sentence a person types says "IBM" or "Box". Looking for the stored string as
   * one run therefore hunted for "ibm corp", which appears in nobody's prose, and the answer
   * was handed to the next employer. Whether reuse was refused turned on whether the posting
   * happened to carry a full stop, which is not a distinction anyone could have predicted
   * from the outside.
   *
   * The short name is the second half of it. A three-letter word is normally too common to
   * treat as a company mention, but IBM, SAP, AWS and GE are the whole distinctive name
   * rather than a fragment of one, so an all-caps run is exempt from that floor. "Box" is
   * the case in the other direction: short, ordinary, and still the company's entire name.
   *
   * The cases are picked so each half of the check is the one deciding somewhere. "Box,
   * Inc." is caught only by dropping the legal suffix and looking for the whole remaining
   * run; "IBM Watson Health" is caught only by the per-word pass, where the three-letter
   * exemption is what keeps "IBM" in the running.
   */
  it.each([['IBM'], ['IBM Corp.'], ['IBM Corporation'], ['IBM Watson Health']])(
    'refuses to reuse an answer naming IBM when it was written for %s',
    (stored) => {
      saveApproved(
        'Tell us about a project you are proud of.',
        'IBM is where mainframes still matter, and that is exactly the kind of unfashionable ' +
          'problem I want.',
        stored,
      );
      expect(findReusable('Tell us about a project you are proud of.', 'Northwind')).toBeNull();
      // And it is still offered back to the company it was written for.
      expect(findReusable('Tell us about a project you are proud of.', stored)?.text).toContain(
        'IBM',
      );
    },
  );

  it.each([['Box'], ['Box, Inc.']])(
    'refuses to reuse an answer naming Box when it was written for %s',
    (stored) => {
      saveApproved(
        'Tell us about a project you are proud of.',
        'The Box integration is the piece of that project I am proudest of.',
        stored,
      );
      expect(findReusable('Tell us about a project you are proud of.', 'Northwind')).toBeNull();
    },
  );

  it('does not treat a longer name that merely starts the same as a mention', () => {
    // The check matches whole word runs, not substrings. "Boxer Holdings" shares its opening
    // with "Box" and appears nowhere in this text, so refusing here would cost the user a
    // reuse for nothing — and a check that refused everything would stop being consulted.
    saveApproved(
      'Tell us about a project you are proud of.',
      'The Box integration is the piece of that project I am proudest of.',
      'Boxer Holdings',
    );
    expect(findReusable('Tell us about a project you are proud of.', 'Northwind')?.text).toContain(
      'Box integration',
    );
  });

  it('pre-fills from the library but does not approve', async () => {
    // The stored text deliberately does not name Kestrel, the company it was written for.
    // Reuse across companies is refused for text that names its own company (see the test
    // above), and this case is about the pre-fill/approve split, not about that refusal.
    saveApproved(
      'Tell us about a project you are proud of.',
      'I built internal tooling that let support close billing tickets without an engineer.',
      'Kestrel',
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/questions`,
      payload: { questionText: 'Tell us about a project you are proud of.' },
    });
    expect(res.json().text).toContain('internal tooling');
    expect(res.json().approvedAt).toBeNull();
    expect(res.json().reusedFrom).not.toBeNull();
  });
});

describe('edit distance', () => {
  it('counts words, not characters', () => {
    expect(wordEditDistance('I built a parser', 'I built a parser')).toBe(0);
    expect(wordEditDistance('I built a parser', 'I built a compiler')).toBe(1);
    expect(wordEditDistance('', 'three words here')).toBe(3);
  });

  it('reports a fraction the meter can show', () => {
    expect(editFraction('I built a parser', 'I built a parser')).toBe(0);
    expect(editFraction('a b c d', 'w x y z')).toBe(1);
    expect(describeEditing(0)).toContain('unchanged');
    expect(describeEditing(0.9)).toContain('writing sample');
  });
});
