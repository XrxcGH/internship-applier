/**
 * Reading a real page into a FormMap, against the hostile fixture.
 *
 * Every assertion here corresponds to a labelling strategy that real ATS forms actually
 * use. The point is not that the scanner handles well-formed HTML — it is that it handles
 * the six different places a label can hide, and that when it cannot find one it says
 * `unknown` rather than guessing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, submissions, type FixtureServer } from '@ia/fixtures';
import { openSession, type BrowserSession } from '../src/core/filling/browser';
import { buildFormMap, summarizeMap, type FormMap } from '../src/core/filling/formMap';

let fixture: FixtureServer;
let session: BrowserSession;
let profileDir: string;

beforeAll(async () => {
  fixture = await startFixtureServer(0);
  profileDir = mkdtempSync(path.join(tmpdir(), 'ia-formmap-'));
  session = await openSession({ headless: true, profileDir });
}, 120_000);

afterAll(async () => {
  await session?.close();
  await fixture?.close();
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
});

async function mapOf(pathname: string): Promise<FormMap> {
  await session.page.goto(`${fixture.url}${pathname}`);
  return buildFormMap(session.page);
}

const bySemantic = (m: FormMap, s: string) => m.fields.filter((f) => f.semantic === s);
const byLabel = (m: FormMap, re: RegExp) => m.fields.find((f) => re.test(f.label));

describe('the simple form', () => {
  it('finds every control and names each one', async () => {
    const m = await mapOf('/simple');
    expect(m.fields).toHaveLength(5);
    expect(bySemantic(m, 'first_name')).toHaveLength(1);
    expect(bySemantic(m, 'last_name')).toHaveLength(1);
    expect(bySemantic(m, 'email')).toHaveLength(1);
    expect(bySemantic(m, 'essay')).toHaveLength(1);
    expect(bySemantic(m, 'resume_upload')).toHaveLength(1);
    expect(m.unknown).toHaveLength(0);
    expect(m.redlined).toHaveLength(0);
  }, 60_000);

  it('reads control types and the character budget', async () => {
    const m = await mapOf('/simple');
    const essay = bySemantic(m, 'essay')[0]!;
    expect(essay.control).toBe('textarea');
    expect(essay.maxLength).toBe(1200);
    expect(bySemantic(m, 'resume_upload')[0]!.control).toBe('file');
  }, 60_000);

  it('never proposes the submit button as a field', async () => {
    const m = await mapOf('/simple');
    expect(m.fields.some((f) => /submit/i.test(f.locator))).toBe(false);
  }, 60_000);
});

describe('finding the label where it actually lives', () => {
  it('resolves aria-labelledby', async () => {
    const m = await mapOf('/nasty');
    const f = byLabel(m, /legal first name/i);
    expect(f).toBeDefined();
    expect(f!.semantic).toBe('first_name');
  }, 60_000);

  it('falls back to the placeholder when there is no label at all', async () => {
    const m = await mapOf('/nasty');
    const f = byLabel(m, /email address/i);
    expect(f).toBeDefined();
    expect(f!.semantic).toBe('email');
  }, 60_000);

  it('reads a label sitting in a preceding sibling div', async () => {
    // The ATS div-soup pattern: no <label>, just a styled div above the input.
    const m = await mapOf('/nasty');
    const f = byLabel(m, /mobile phone/i);
    expect(f).toBeDefined();
    expect(f!.semantic).toBe('phone');
  }, 60_000);

  it('reaches an input inside shadow DOM', async () => {
    const m = await mapOf('/nasty');
    expect(m.fields.some((f) => f.locator === '#shadow-portfolio')).toBe(true);
  }, 60_000);

  it('reaches fields inside an iframe and records which frame they came from', async () => {
    const m = await mapOf('/nasty');
    const start = bySemantic(m, 'start_date')[0];
    expect(start, 'iframe field should be mapped').toBeDefined();
    expect(start!.frame).toMatch(/\/framed$/);
  }, 60_000);
});

describe('required and unknown', () => {
  it('treats a trailing asterisk as required', async () => {
    // Very common, and never reflected in the required attribute.
    const m = await mapOf('/nasty');
    const gpa = bySemantic(m, 'gpa')[0]!;
    expect(gpa.required).toBe(true);
  }, 60_000);

  it('leaves a genuinely unrecognizable field as unknown rather than guessing', async () => {
    const m = await mapOf('/nasty');
    // The div combobox is labelled "Degree", so it should be recognised...
    expect(bySemantic(m, 'degree').length).toBeGreaterThan(0);
    // ...but nothing should have been guessed into a semantic with no evidence.
    for (const f of m.fields) {
      if (f.semantic === 'unknown') expect(f.confidence).toBe(0);
    }
  }, 60_000);

  it('detects a div-based combobox as a combobox, not a text field', async () => {
    const m = await mapOf('/nasty');
    const degree = bySemantic(m, 'degree')[0]!;
    expect(degree.control).toBe('combobox');
  }, 60_000);
});

describe('redlines are caught while reading, before anything is typed', () => {
  it('flags every redlined field on the redline page', async () => {
    const m = await mapOf('/redlines');
    // Nothing on that page is fillable.
    const fillable = m.fields.filter((f) => f.semantic !== 'REDLINE' && f.semantic !== 'unknown');
    expect(fillable.map((f) => f.label)).toEqual([]);
    // Every single field on that page. An exact count, so a regression that drops one is
    // a failure rather than a silently smaller list.
    expect(m.redlined).toHaveLength(m.fields.length);
  }, 60_000);

  it('records the category so the user is told why', async () => {
    const m = await mapOf('/redlines');
    const categories = new Set(m.redlined.map((f) => f.redlineCategory));
    for (const c of [
      'government_id',
      'financial',
      'credential',
      'attestation',
      'consent',
      'eeo_demographic',
      'ai_disclosure',
    ]) {
      expect(categories, c).toContain(c);
    }
  }, 60_000);

  it('catches a redline mislabeled to defeat semantic classification', async () => {
    const m = await mapOf('/nasty');
    const tax = byLabel(m, /taxpayer identification/i);
    expect(tax?.semantic).toBe('REDLINE');
    expect(tax?.redlineCategory).toBe('government_id');
  }, 60_000);
});

describe('radio groups', () => {
  /**
   * The fixture's radios are labelled by the legend, which is what real ATS forms do and
   * what the highest-priority label strategy finds first. Ungrouped, that gave two fields
   * with the same question, the same semantic, and no idea which was Yes and which was No.
   */
  it('collapses a group into one question with its buttons as options', async () => {
    const m = await mapOf('/nasty');
    const group = m.fields.filter((f) => f.control === 'radio');
    expect(group).toHaveLength(1);
    expect(group[0]!.label).toMatch(/legally authorized to work/i);
    expect(group[0]!.options?.map((o) => o.label)).toEqual(['Yes', 'No']);
  }, 60_000);

  it('gives each option its own locator, since the group selector matches them all', async () => {
    const m = await mapOf('/nasty');
    const group = m.fields.find((f) => f.control === 'radio')!;
    const locators = group.options?.map((o) => o.locator) ?? [];
    expect(new Set(locators).size).toBe(2);
    for (const l of locators) expect(l).toBeTruthy();
  }, 60_000);

  it('classifies the group by its question', async () => {
    const m = await mapOf('/nasty');
    expect(m.fields.find((f) => f.control === 'radio')?.semantic).toBe('work_auth');
  }, 60_000);
});

describe('long-form fields the scanner has to recognize by shape', () => {
  /**
   * A contenteditable box has no `type` attribute, so shape detection could not see it
   * and every rich-text essay landed as `unknown` — the fill engine's richtext branch was
   * unreachable for the one thing it was written for.
   */
  it('recognizes a contenteditable essay with a short question', async () => {
    const m = await mapOf('/nasty');
    const why = byLabel(m, /why do you want this internship/i);
    expect(why?.control).toBe('richtext');
    expect(why?.semantic).toBe('essay');
  }, 60_000);
});

describe('summary', () => {
  it('counts what the user needs to know', async () => {
    const m = await mapOf('/redlines');
    expect(summarizeMap(m)).toMatch(/fields found/);
    expect(summarizeMap(m)).toMatch(/left for you/);
  }, 60_000);
});

describe('gate G4', () => {
  it('reading a form never submits it', () => {
    expect(submissions).toEqual([]);
  });
});
