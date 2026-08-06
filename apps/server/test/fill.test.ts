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
import type { Page } from 'playwright';
import type { ApplicationAnswer, ConfirmedProfile, FormField } from '@ia/shared';
import {
  resetSubmissions,
  startFixtureServer,
  submissions,
  type FixtureServer,
} from '@ia/fixtures';
import { openSession, type BrowserSession } from '../src/core/filling/browser';
import { buildFormMap, frameKey } from '../src/core/filling/formMap';
import { buildFillPlan, summarizePlan } from '../src/core/filling/plan';
import {
  chooseOption,
  describeFill,
  executePlan,
  type SelectOption,
} from '../src/core/filling/fill';

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

/**
 * Dropdowns, without a browser, because the interesting part is the matching.
 *
 * The fixture's only fillable select offers "Yes" and "No" and has no substring collisions
 * in it, which is why a rule that matched prose labels by substring passed the whole suite
 * while sending twenty-one of the fifty US state codes to the wrong state. These lists are
 * the ordinary ones an application actually shows.
 */
const COUNTRIES: SelectOption[] = [
  { value: '', label: 'Please select' },
  { value: 'AU', label: 'Australia' },
  { value: 'BD', label: 'Bangladesh' },
  { value: 'BR', label: 'Brazil' },
  { value: 'DE', label: 'Germany' },
  { value: 'IE', label: 'Ireland' },
  { value: 'IL', label: 'Israel' },
  { value: 'US', label: 'United States' },
  { value: 'VN', label: 'Vietnam' },
];

/**
 * Sixteen states rather than fifty, chosen because eight of these codes went somewhere
 * else: IA and OR to California, LA and MA to Alabama, NE to Connecticut, VA to Nevada,
 * WA to Delaware — and CT to "Select a state", which does not fill a required field, it
 * blanks one. The four states beginning with "New" are here so that ambiguity has
 * something to be ambiguous about.
 */
const STATES: SelectOption[] = [
  { value: '', label: 'Select a state' },
  { value: 'AL', label: 'Alabama' },
  { value: 'CA', label: 'California' },
  { value: 'CT', label: 'Connecticut' },
  { value: 'DE', label: 'Delaware' },
  { value: 'IA', label: 'Iowa' },
  { value: 'LA', label: 'Louisiana' },
  { value: 'MA', label: 'Massachusetts' },
  { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' },
  { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' },
  { value: 'NM', label: 'New Mexico' },
  { value: 'NY', label: 'New York' },
  { value: 'OR', label: 'Oregon' },
  { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' },
];

const SPONSORSHIP: SelectOption[] = [
  { value: '', label: 'Select an option' },
  { value: '1', label: 'Yes, now or in the future' },
  { value: '2', label: 'No, not now or in the future' },
];

describe('choosing an option in a dropdown', () => {
  /**
   * "US" is the profile's default country, and "Australia" contains the letters u-s. The
   * substring rule reached that label before it ever looked at the option carrying the
   * value "US", so the out-of-the-box profile selected the wrong country.
   */
  it('prefers an option that carries the value over a label that merely contains it', () => {
    expect(chooseOption(COUNTRIES, 'US')?.label).toBe('United States');
    expect(chooseOption(COUNTRIES, 'DE')?.label).toBe('Germany');
    expect(chooseOption(COUNTRIES, 'IE')?.label).toBe('Ireland');
    expect(chooseOption(COUNTRIES, 'IL')?.label).toBe('Israel');
    // And the same question asked with the full name still works.
    expect(chooseOption(COUNTRIES, 'United States')?.value).toBe('US');
  });

  it('sends every state code to its own state', () => {
    const codes = STATES.map((s) => s.value).filter(Boolean);
    const wrong = codes.filter((code) => chooseOption(STATES, code)?.value !== code);
    expect(wrong).toEqual([]);
  });

  /**
   * The one that decides applications. "No, not now or in the future" contains "no", and so
   * does "Yes, now or in the future" — a candidate who needs no sponsorship was recorded as
   * needing it, and one not authorized to work was recorded as authorized. Whole leading
   * words are what tell the two apart.
   */
  it('answers a prose sponsorship question on the side the profile meant', () => {
    expect(chooseOption(SPONSORSHIP, 'No')?.label).toBe('No, not now or in the future');
    expect(chooseOption(SPONSORSHIP, 'Yes')?.label).toBe('Yes, now or in the future');
  });

  it('never chooses the placeholder, which would blank the field rather than fill it', () => {
    expect(chooseOption(SPONSORSHIP, 'Select an option')).toBeUndefined();
    expect(chooseOption(COUNTRIES, 'Please select')).toBeUndefined();
  });

  it('refuses when two options fit equally well', () => {
    expect(chooseOption(STATES, 'New')).toBeUndefined();
  });

  it('will not identify an option from a single character', () => {
    const levels: SelectOption[] = [
      { value: 'a', label: 'A Levels' },
      { value: 'b', label: 'Baccalaureate' },
    ];
    expect(chooseOption(levels, 'A')?.value).toBe('a'); // an exact value still counts
    expect(chooseOption(levels, 'X')).toBeUndefined();
  });

  it('leaves a value it cannot place for the user', () => {
    expect(chooseOption(STATES, 'Ontario')).toBeUndefined();
  });
});

/** A `<select>` with no browser: it keeps the value it is given, or refuses it. */
function selectStub(options: SelectOption[], behaviour: { ignores?: boolean } = {}) {
  let held = '';
  const locator = {
    waitFor: () => Promise.resolve(),
    selectOption: (v: string) => {
      if (behaviour.ignores) return Promise.resolve();
      const hit = options.find((o) => o.value === v);
      if (!hit) return Promise.reject(new Error(`no option with value "${v}"`));
      held = hit.value;
      return Promise.resolve();
    },
    inputValue: () => Promise.resolve(held),
  };
  return {
    locator,
    get held() {
      return held;
    },
  };
}

/** A text box with no browser, reachable by a plain selector or by index. */
function textStub() {
  let held = '';
  const locator = {
    nth: () => locator,
    waitFor: () => Promise.resolve(),
    click: () => Promise.resolve(),
    fill: (v: string) => {
      held = v;
      return Promise.resolve();
    },
    pressSequentially: (v: string) => {
      held += v;
      return Promise.resolve();
    },
    inputValue: () => Promise.resolve(held),
  };
  return {
    locator,
    get held() {
      return held;
    },
  };
}

function fieldOf(over: Partial<FormField>): FormField {
  return {
    id: 'f1',
    locator: '#control',
    label: 'A field',
    control: 'select',
    required: false,
    semantic: 'country',
    confidence: 1,
    ...over,
  } as FormField;
}

function pageOfFrames(frames: { url: string; locator: unknown }[]): Page {
  const built = frames.map((f) => ({
    url: () => f.url,
    isDetached: () => false,
    locator: () => f.locator,
  }));
  return { mainFrame: () => built[0], frames: () => built } as unknown as Page;
}

async function fillOnce(page: Page, field: FormField, value: string) {
  const result = await executePlan(page, {
    actions: [{ field, value, source: 'profile' }],
    skips: [],
  });
  return result.results[0]!;
}

/**
 * What the user is shown about a dropdown after it has been set.
 *
 * Re-reading a select cannot tell a good choice from a bad one — the page holds whatever it
 * was told — so the report used to print the value that was ASKED for whenever it differed
 * from the option code. The page said "Australia" and the report said "US", with a tick
 * beside it, on the one field a reader most needed to look at.
 */
describe('a dropdown reports the words the page is now showing', () => {
  it('shows the option label rather than the value that was planned', async () => {
    const select = selectStub(COUNTRIES);
    const page = pageOfFrames([{ url: 'http://form.test/', locator: select.locator }]);
    const r = await fillOnce(page, fieldOf({ label: 'Country', options: COUNTRIES }), 'US');

    expect(select.held).toBe('US');
    expect(r.status).toBe('ok');
    expect(r.readBack).toBe('United States');
  });

  it('reports a mismatch when the page does not keep the choice', async () => {
    const select = selectStub(COUNTRIES, { ignores: true });
    const page = pageOfFrames([{ url: 'http://form.test/', locator: select.locator }]);
    const r = await fillOnce(page, fieldOf({ label: 'Country', options: COUNTRIES }), 'US');

    expect(r.status).toBe('mismatch');
    expect(r.readBack).toBe('Please select');
    expect(r.note).toMatch(/Please select/);
  });

  it('leaves the dropdown untouched when nothing matches', async () => {
    const select = selectStub(STATES);
    const page = pageOfFrames([{ url: 'http://form.test/', locator: select.locator }]);
    const r = await fillOnce(page, fieldOf({ label: 'State', options: STATES }), 'Ontario');

    expect(r.status).toBe('skipped');
    expect(r.note).toMatch(/Choose it yourself/);
    expect(select.held).toBe('');
  });
});

/**
 * Which document a value goes into.
 *
 * A URL is not a frame's identity: every `srcdoc` iframe reports `about:srcdoc` and every
 * blank one `about:blank`, so a page with two essay editors sent both answers into the
 * first, left the second empty, and reported both filled. And when the recorded frame had
 * gone, falling back to the main document meant an index locator resolved in a completely
 * different page — which is how an approved essay was typed into a Social Security Number
 * box the redline pass had deliberately left alone.
 */
describe('the frame a field was found in', () => {
  it('tells two frames with the same URL apart', async () => {
    const main = textStub();
    const editorA = textStub();
    const editorB = textStub();
    const page = pageOfFrames([
      { url: 'http://form.test/', locator: main.locator },
      { url: 'about:srcdoc', locator: editorA.locator },
      { url: 'about:srcdoc', locator: editorB.locator },
    ]);

    // Neither editor has an id, so both fall back to the same index locator. The frame is
    // the only thing that distinguishes them.
    const q1 = fieldOf({
      id: 'q1',
      label: 'Question 1',
      control: 'textarea',
      semantic: 'essay',
      locator: '__index__0',
      frame: frameKey(1, 'about:srcdoc'),
    });
    const q2 = fieldOf({
      id: 'q2',
      label: 'Question 2',
      control: 'textarea',
      semantic: 'essay',
      locator: '__index__0',
      frame: frameKey(2, 'about:srcdoc'),
    });

    const result = await executePlan(page, {
      actions: [
        { field: q1, value: 'answer one', source: 'answer' },
        { field: q2, value: 'answer two', source: 'answer' },
      ],
      skips: [],
    });

    expect(result.results.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(editorA.held).toBe('answer one');
    expect(editorB.held).toBe('answer two');
  });

  it('says so rather than typing into a different document when the frame is gone', async () => {
    const main = textStub();
    const page = pageOfFrames([{ url: 'http://form.test/', locator: main.locator }]);
    const essay = fieldOf({
      label: 'Tell us about a project',
      control: 'textarea',
      semantic: 'essay',
      locator: '__index__0',
      frame: frameKey(1, 'about:srcdoc'),
    });

    const r = await fillOnce(page, essay, 'I built a tide chart that works offline.');

    expect(r.status).toBe('failed');
    expect(r.note).toMatch(/no longer there/i);
    // The main document, where the fallback used to land, is untouched.
    expect(main.held).toBe('');
  });
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
