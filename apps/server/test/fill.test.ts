/**
 * Filling a real form, end to end, against the fixture.
 *
 * This is the M6 release gate from docs/11: the nastiest form fills correctly, every
 * redlined field is skipped, and no code path submits.
 *
 * The read-back assertions are the ones worth reading. It is easy to write a filler that
 * reports success because it called a method without error; the question that matters is
 * whether the page kept the value.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApplicationAnswer, ConfirmedProfile } from '@ia/shared';
import {
  resetSubmissions,
  startFixtureServer,
  submissions,
  type FixtureServer,
} from '@ia/fixtures';
import { openSession, type BrowserSession } from '../src/core/filling/browser';
import { buildFormMap } from '../src/core/filling/formMap';
import { buildFillPlan, summarizePlan } from '../src/core/filling/plan';
import { describeFill, executePlan } from '../src/core/filling/fill';

let fixture: FixtureServer;
let session: BrowserSession;
let workDir: string;
let resumePath: string;

const PROFILE = {
  id: 'p1',
  fullName: 'Rosa Alvarez',
  email: 'rosa@example.edu',
  phone: '+1 555 0100',
  dateOfBirth: '2006-03-15',
  address: {
    line1: '12 Elm St',
    city: 'New Brunswick',
    region: 'NJ',
    postal: '08901',
    country: 'US',
  },
  links: { github: 'https://github.com/rosa', portfolio: 'https://rosa.dev', other: [] },
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
  experience: [],
  projects: [],
  skills: [],
  certifications: [],
  languages: [],
  availability: { start: '2027-06-01', end: '2027-08-20', hoursPerWeek: 40, flexible: true },
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
  confirmedAt: '2026-08-03T00:00:00Z',
  needsReview: [],
  createdAt: '2026-08-03T00:00:00Z',
  updatedAt: '2026-08-03T00:00:00Z',
} as ConfirmedProfile;

const WHY_ANSWER = {
  id: 'a0',
  applicationId: 'app1',
  questionText: 'Why do you want this internship?',
  fieldKey: 'why',
  answerType: 'long_text',
  draftText: '',
  finalText: 'I want to spend a summer on the unglamorous parts of developer tooling.',
  editDistance: 0,
  evidence: [],
  flags: [],
  approvedAt: '2026-08-04T00:00:00Z',
} as unknown as ApplicationAnswer;

const APPROVED_ANSWER = {
  id: 'a1',
  applicationId: 'app1',
  questionText: 'Tell us about a project you are proud of.',
  fieldKey: 'essay',
  answerType: 'long_text',
  draftText: '',
  finalText: 'I built a tide chart that works offline, because kayakers have no signal.',
  editDistance: 0,
  evidence: [],
  flags: [],
  approvedAt: '2026-08-04T00:00:00Z',
} as unknown as ApplicationAnswer;

beforeAll(async () => {
  fixture = await startFixtureServer(0);
  workDir = mkdtempSync(path.join(tmpdir(), 'ia-fill-'));
  resumePath = path.join(workDir, 'resume.txt');
  writeFileSync(resumePath, 'Rosa Alvarez — resume', 'utf8');
  session = await openSession({ headless: true, profileDir: path.join(workDir, 'profile') });
  resetSubmissions();
}, 120_000);

afterAll(async () => {
  await session?.close();
  await fixture?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function run(pathname: string, answers: ApplicationAnswer[] = []) {
  await session.page.goto(`${fixture.url}${pathname}`);
  const map = await buildFormMap(session.page);
  const plan = buildFillPlan({ fields: map.fields, profile: PROFILE, answers, resumePath });
  const result = await executePlan(session.page, plan);
  return { map, plan, result };
}

describe('the simple form', () => {
  it('fills every field and the page keeps the values', async () => {
    const { result } = await run('/simple', [WHY_ANSWER, APPROVED_ANSWER]);
    const bad = result.results.filter((r) => r.status !== 'ok');
    expect(bad.map((r) => `${r.field.label}: ${r.status} ${r.note ?? ''}`)).toEqual([]);

    expect(await session.page.locator('#first').inputValue()).toBe('Rosa');
    expect(await session.page.locator('#last').inputValue()).toBe('Alvarez');
    expect(await session.page.locator('#email').inputValue()).toBe('rosa@example.edu');
    expect(await session.page.locator('#why').inputValue()).toContain('developer tooling');
  }, 90_000);

  it('attaches the resume', async () => {
    const { result } = await run('/simple', [WHY_ANSWER, APPROVED_ANSWER]);
    const file = result.results.find((r) => r.field.semantic === 'resume_upload')!;
    expect(file.status).toBe('ok');
    expect(file.readBack).toContain('resume.txt');
  }, 90_000);

  it('reports honestly when it is done', async () => {
    const { result } = await run('/simple', [WHY_ANSWER, APPROVED_ANSWER]);
    // The summary must not read as finished, because it is not.
    expect(describeFill(result)).toMatch(/submit it yourself/i);
  }, 90_000);
});

describe('an unapproved answer never reaches a form', () => {
  it('refuses to type an answer that has not passed G3', async () => {
    const unapproved = { ...WHY_ANSWER, approvedAt: null } as ApplicationAnswer;
    const { plan, result } = await run('/simple', [unapproved]);

    const essaySkip = plan.skips.find((s) => s.field.semantic === 'essay');
    expect(essaySkip?.reason).toBe('needs_answer');
    expect(essaySkip?.note).toMatch(/not approved/i);

    // And the box on the page is genuinely still empty.
    expect(await session.page.locator('#why').inputValue()).toBe('');
    expect(result.results.find((r) => r.field.semantic === 'essay')?.status).toBe('skipped');
  }, 90_000);

  it('leaves an essay blank when no answer exists at all', async () => {
    const { plan } = await run('/simple', []);
    expect(plan.skips.find((s) => s.field.semantic === 'essay')?.reason).toBe('needs_answer');
    expect(await session.page.locator('#why').inputValue()).toBe('');
  }, 90_000);
});

describe('the hostile form', () => {
  it('fills the widgets that ignore programmatic values', async () => {
    await run('/nasty', []);
    // The commit-on-keystroke widget: proof that typing, not fill(), was used.
    expect(await session.page.locator('#f-school').getAttribute('data-committed')).toBe(
      'Rutgers University',
    );
  }, 90_000);

  it('drives a div-based combobox by opening it and clicking an option', async () => {
    await run('/nasty', []);
    expect(await session.page.locator('#f-degree').getAttribute('data-value')).toBe('bachelor');
  }, 90_000);

  it('fills fields inside an iframe', async () => {
    await run('/nasty', []);
    const frame = session.page.frameLocator('#extra');
    expect(await frame.locator('#f-start').inputValue()).toBe('2027-06-01');
    expect(await frame.locator('#f-auth').inputValue()).toBe('Yes');
  }, 90_000);

  /**
   * The profile is authorized to work, so the answer is Yes. What makes this test worth
   * having is the No: the radios are labelled by the legend, so before grouping, both
   * classified as the same question and both were ticked in turn — the last one winning.
   * A tool that answers a work-authorization question by document order is worse than one
   * that leaves it blank.
   */
  it('ticks the radio that matches the answer, and leaves the other alone', async () => {
    await run('/nasty', []);
    expect(await session.page.locator('#f-auth-yes').isChecked()).toBe(true);
    expect(await session.page.locator('#f-auth-no').isChecked()).toBe(false);
  }, 90_000);

  it('reports the radio group once, with the choice it made', async () => {
    const { result } = await run('/nasty', []);
    const radios = result.results.filter((r) => r.field.control === 'radio');
    expect(radios).toHaveLength(1);
    expect(radios[0]!.status).toBe('ok');
    expect(radios[0]!.readBack).toBe('Yes');
  }, 90_000);

  it('types an approved answer into a contenteditable essay box', async () => {
    const why = {
      ...WHY_ANSWER,
      questionText: 'Why do you want this internship?',
    } as ApplicationAnswer;
    await run('/nasty', [why]);
    expect(await session.page.locator('#f-why').innerText()).toContain('developer tooling');
  }, 90_000);

  it('respects a maxlength budget rather than letting the form truncate silently', async () => {
    const long = {
      ...APPROVED_ANSWER,
      finalText: 'x'.repeat(2000),
    } as ApplicationAnswer;
    const { plan } = await run('/nasty', [long]);
    const essay = plan.actions.find((a) => a.field.semantic === 'essay');
    expect(essay?.value.length).toBe(600);
  }, 90_000);
});

describe('redlines, on a live page', () => {
  it('types nothing at all into the redline form', async () => {
    const { plan, result } = await run('/redlines', [WHY_ANSWER, APPROVED_ANSWER]);

    expect(plan.actions).toEqual([]);
    expect(result.filled).toBe(0);

    // Every input on the page is still empty, and every checkbox still unchecked.
    const values = await session.page.evaluate(() =>
      Array.from(document.querySelectorAll('input, select')).map((el) => {
        const i = el as HTMLInputElement;
        return i.type === 'checkbox' ? String(i.checked) : i.value;
      }),
    );
    expect(values.filter((v) => v !== '' && v !== 'false')).toEqual([]);
  }, 90_000);

  it('tells the user why each one was left, in their words', async () => {
    const { plan } = await run('/redlines', []);
    const notes = plan.skips.map((s) => s.note).join(' ');
    expect(notes).toMatch(/yours to give|only you can make it|type this yourself/i);
    expect(summarizePlan(plan)).toMatch(/left for you/);
  }, 90_000);
});

describe('gate G4 — the whole point', () => {
  it('has not submitted a single form across this entire suite', () => {
    // The fixture counts POSTs. This asserts the outcome, not the implementation.
    expect(submissions).toEqual([]);
  });

  it('has no submit control in any fill plan', async () => {
    const { plan } = await run('/simple', [WHY_ANSWER, APPROVED_ANSWER]);
    for (const a of plan.actions) {
      expect(a.field.locator).not.toMatch(/submit/i);
      expect(a.field.control).not.toBe('button');
    }
  }, 90_000);
});
