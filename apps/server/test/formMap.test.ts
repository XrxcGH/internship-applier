/**
 * Reading a real page into a FormMap, against the hostile fixture.
 *
 * Every assertion here corresponds to a labelling strategy that real ATS forms actually
 * use. The point is not that the scanner handles well-formed HTML — it is that it handles
 * the six different places a label can hide, and that when it cannot find one it says
 * `unknown` rather than guessing.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { startFixtureServer, submissions, type FixtureServer } from '@ia/fixtures';
import { openSession, type BrowserSession } from '../src/core/filling/browser';
import {
  buildFormMap,
  scanExpression,
  summarizeMap,
  unshimmedHelpers,
  type FormMap,
} from '../src/core/filling/formMap';
import { FILLABLE_CONTROLS } from '../src/core/filling/selectors';

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

describe('what is really on the page', () => {
  /**
   * A honeypot is an off-screen field with an attractive name, put there so that anything
   * filling it identifies itself as a bot. It has a perfectly good bounding box, and
   * Playwright considers it visible, so a rect-only check let the tool type into it.
   */
  it('does not offer a honeypot field to fill', async () => {
    const m = await mapOf('/nasty');
    expect(m.fields.find((f) => f.locator === '#f-website')).toBeUndefined();
  });

  /**
   * The other direction costs less but corrodes the report: visibility:hidden and
   * opacity:0 fields also keep a rect, so each one was attempted and spent the full
   * five-second timeout before landing as "failed" — noise in a report whose whole value
   * is that its warnings mean something.
   */
  it('drops fields that are hidden by computed style rather than by size', async () => {
    const m = await mapOf('/nasty');
    expect(m.fields.find((f) => f.locator === '#f-hidden')).toBeUndefined();
    expect(m.fields.find((f) => f.locator === '#f-clear')).toBeUndefined();
  });

  /**
   * The scanner collected light-DOM matches before descending into shadow roots, while
   * Playwright's selector engine pierces them in tree order — so on any frame with a
   * shadow-DOM control, every index locator was off by one or more. There is no label
   * read-back at fill time to catch that, so a wrong element that accepted the value was
   * reported "ok".
   */
  it('numbers index locators in the order Playwright resolves them', async () => {
    const m = await mapOf('/nasty');
    const indexed = m.fields.filter((f) => f.locator.startsWith('__index__'));
    for (const f of indexed) {
      const n = Number(/^__index__(\d+)/.exec(f.locator)![1]);
      const resolved = session.page.locator(FILLABLE_CONTROLS).nth(n);
      expect(await resolved.count(), f.label).toBe(1);
      // The element Playwright lands on must be the one the scanner described.
      const name = await resolved.getAttribute('name');
      expect(name ?? '', f.label).not.toBe('');
    }
  });

  /**
   * A shadow host that ALSO has light-DOM children of its own — the ordinary shape of a
   * real web component, and the shape the fixture happens not to have.
   *
   * Descending into a host's shadow root before walking the host's own children agrees
   * with Playwright only while the host is empty. Give it slotted children and the two
   * walks cross: the scanner numbered the shadow input 1 and the slotted one 2, while
   * `.nth(1)` lands on the slotted input and `.nth(2)` on the shadow one. Two fields then
   * swap contents — a GitHub URL into the LinkedIn box — and because read-back re-reads
   * whatever element was resolved, both come back "ok". Indices are handed out before the
   * redline pass removes anything, so the same slip can tick an attestation checkbox that
   * was deliberately left alone.
   *
   * Every control here is deliberately given no id and no name, because those are the only
   * fields that fall back to an index locator at all.
   */
  it('agrees with Playwright when a shadow host has slotted children too', async () => {
    // aria-label rather than a <label>, so each control names itself without an id.
    await session.page.setContent(`
      <input aria-label="A-first">
      <div id="host"><input aria-label="C-slotted"></div>
      <input aria-label="D-last">
      <script>
        // Wrapped, and not for tidiness. setContent runs document.write in the SAME JS
        // realm as whatever this session loaded before, so a top-level \`const\` here
        // collides with an identically named one on an earlier page — the fixture declares
        // \`root\` too. The redeclaration is a SyntaxError that aborts this whole script
        // before attachShadow runs, so the shadow input never exists and the assertion
        // fails describing a scanner bug that is not there. It passed alone and failed in
        // suite order, which is the shape that costs an afternoon.
        (() => {
          const shadow = document.getElementById('host').attachShadow({ mode: 'open' });
          shadow.innerHTML = '<input aria-label="B-shadow"><slot></slot>';
        })();
      </script>
    `);
    const m = await buildFormMap(session.page);

    // The shape is only interesting if the shadow control and the slotted one are BOTH
    // there and Playwright puts the slotted one first. Document order would be A, B, C, D.
    expect(m.fields.map((f) => f.label)).toEqual(['A-first', 'C-slotted', 'B-shadow', 'D-last']);

    for (const f of m.fields) {
      const n = Number(/^__index__(\d+)/.exec(f.locator)?.[1] ?? NaN);
      expect(Number.isNaN(n), `${f.label} got locator ${f.locator}`).toBe(false);
      const resolved = session.page.locator(FILLABLE_CONTROLS).nth(n);
      expect(await resolved.getAttribute('aria-label'), f.label).toBe(f.label);
    }
  }, 60_000);
});

/** A page-like global scope: a DOM, and none of Node's module scope. */
function bareContext(): Record<string, unknown> {
  return {
    document: { children: [], querySelectorAll: () => ({ length: 0 }) },
    CSS: { escape: (s: string) => s },
    Node: { TEXT_NODE: 3 },
    getComputedStyle: () => ({}),
  };
}

/**
 * Compiles formMap.ts with esbuild and asks the result for the expression it would send to
 * a page. esbuild is what both tsx and vitest run on, so the option is the only variable.
 */
function compiledWith(options: { keepNames: boolean }): string {
  const source = fileURLToPath(new URL('../src/core/filling/formMap.ts', import.meta.url));
  const { code } = transformSync(readFileSync(source, 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    keepNames: options.keepNames,
    target: `node${process.versions.node.split('.')[0]!}`,
  });
  // Nothing the scanner itself needs comes from these, so one stub answers for all of them.
  const stub = {
    logger: { warn: () => {}, error: () => {} },
    classifyField: () => ({ semantic: 'unknown', confidence: 0 }),
    checkRedline: () => undefined,
    ulid: () => 'id',
  };
  const mod = { exports: {} as Record<string, unknown> };
  runInNewContext(code, { module: mod, exports: mod.exports, require: () => stub });
  return (mod.exports as { scanExpression: () => string }).scanExpression();
}

/**
 * Playwright serializes a function into the page and sends nothing else, so anything the
 * compiler puts NEXT to that function is left behind in Node.
 *
 * Both ways the server really starts go through tsx, whose esbuild transform keeps function
 * names: every named arrow inside the scanner is rewritten to `__name(fn, "fn")`, and
 * `__name` is declared once at module scope. Handing the function object to `evaluate` meant
 * the page got a call to something that was not there, the scanner threw on its first line of
 * every frame of every page, and the run told the user "0 fields found: 0 fillable, 0 left for
 * you, 0 not recognized" about a form with twenty inputs on it. The whole form-filling feature
 * had never once run outside the tests, and the tests were green because vitest compiles
 * without keepNames.
 *
 * These tests exist so the next person to add a helper to the scanner finds out here rather
 * than in a silent production run.
 */
describe('the scanner has to survive the trip into the page', () => {
  it('is handed to the page as source text, not as a function', async () => {
    const sent: unknown[] = [];
    const frame = {
      url: () => 'http://example.test/',
      evaluate: (arg: unknown) => {
        sent.push(arg);
        return Promise.resolve([]);
      },
    };
    const page = {
      frames: () => [frame],
      mainFrame: () => frame,
      url: () => 'http://example.test/',
    };

    await buildFormMap(page as unknown as Page);
    expect(sent).toHaveLength(1);
    // A function object would be serialized by Playwright with its compiled body intact,
    // helper calls and all. A string is the whole expression, helpers declared inside it.
    expect(typeof sent[0]).toBe('string');
  });

  it('spots a compiler helper that the page would not have', () => {
    expect(unshimmedHelpers('(() => { const f = __async(x => x, "f"); return f(1); })')).toEqual([
      '__async',
    ]);
    // `__index__` is written into locator strings and is never called, so it is not one.
    expect(unshimmedHelpers('return `__index__${String(i)}`;')).toEqual([]);
  });

  it('runs with nothing else in scope', () => {
    expect(() => runInNewContext(scanExpression(), bareContext())).not.toThrow();
  });

  /**
   * The one that matters, because vitest's own transform is not the one that ships. This
   * compiles the scanner the way tsx does — esbuild with keepNames on — and then runs the
   * expression the page would receive in a context that has a DOM and nothing else.
   */
  it('still runs when compiled the way the server actually starts', () => {
    const production = compiledWith({ keepNames: true });
    const asVitestSeesIt = compiledWith({ keepNames: false });

    // If this stops being true, keepNames has stopped mattering and the rest is harmless.
    expect(/__name\(/.test(production)).toBe(true);
    expect(/__name\(/.test(asVitestSeesIt)).toBe(false);

    expect(() => runInNewContext(production, bareContext())).not.toThrow();
    // And the declarations the expression carries are what save it: without them the page
    // gets exactly the ReferenceError that made every real run find zero fields.
    expect(() =>
      runInNewContext(production.replace('const __name = (fn) => fn;', ''), bareContext()),
    ).toThrow(/__name is not defined/);
  }, 30_000);
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
