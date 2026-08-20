/**
 * Gate G4 (docs/07-form-automation.md): the tool fills forms, the user submits them.
 *
 * The interface tells the user this is enforced by a test, a lint rule and a CI check.
 * This is the CI check. Run with: npx tsx scripts/g4-scan.ts
 *
 * WHAT IT REPLACED, BECAUSE THE SHAPE OF THE MISTAKE MATTERS. CI used to run
 *
 *     grep -rniE 'submit[A-Za-z]*\.click|click\(\).*submit' apps/server/src
 *
 * and `click\(\)` there means literally empty parentheses, so `page.click('button[type=
 * submit]')` — the ordinary Playwright way to submit a form, and the first thing anyone
 * adding "just advance the wizard" would write — sailed through a gate that then printed
 * "ok — no submit-click found". The lint rule had the mirror-image hole: it matched on the
 * receiver identifier only, so `submitBtn.click()` was caught and `page.click(...)` was not.
 * Two of the three advertised gates could not see the common case.
 *
 * The rule to keep: a G4 pattern has to match the submit control wherever it is named — in
 * the receiver, in the selector string, in a chained locator on the line before — and it has
 * to cover the ways to submit that are not clicks at all. Adding one pattern for the one
 * example in a bug report is how this reopened twice.
 *
 * Scope is `apps/server/src` and not `apps/web/src` on purpose: a submit button in the web
 * interface is the user pressing it themselves, which is the whole point of G4. The server
 * is the side that drives a real browser on an employer's page, and it is the side that must
 * never press anything.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['apps/server/src'];

/**
 * Lines that are only a comment are not code and must not be scanned.
 *
 * `fill.ts` documents the guarantee in prose — "merely that no `.click()` was written. Not
 * clicking submit is only half of it" — which puts `.click(` and the word "submit" on one
 * line and trips every proximity rule below. A gate that fails on the comment explaining the
 * gate gets deleted or worked around, and then there is no gate. Only whole-line comments
 * are dropped; a trailing `// ...` on a real line is left in, because stripping it means
 * parsing strings and this file is not worth a parser.
 */
function isCommentOnly(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
}

/**
 * `:not(...)` is an exclusion, so anything inside it is the opposite of an offence.
 *
 * `input:not([type=submit])` is the scanner deliberately refusing to touch submit controls.
 * A guard that flagged it would be arguing for its own removal.
 *
 * Parentheses are counted rather than matched with `[^)]*`, which stopped at the first `)` it
 * saw. That was fine while every exclusion was flat, and wrong the moment one nested:
 * `:not(:has(input[type=submit]))` had only its inner half removed, so the scanner read the
 * leftovers as a line targeting a submit control and failed the build over the exclusion that
 * exists to stop exactly that. A guard whose false alarm is "you excluded it too carefully"
 * teaches the next person to weaken the exclusion.
 */
function dropExclusions(line: string): string {
  let out = '';
  for (let i = 0; i < line.length;) {
    if (!line.startsWith(':not(', i)) {
      out += line[i];
      i++;
      continue;
    }
    let depth = 0;
    let j = i + ':not'.length;
    for (; j < line.length; j++) {
      if (line[j] === '(') depth++;
      else if (line[j] === ')' && --depth === 0) break;
    }
    // An unbalanced `:not(` means the exclusion is split across lines, and this scanner reads
    // one line at a time. Dropping the rest would hide whatever follows it, so it stays.
    if (depth !== 0) {
      out += line.slice(i);
      break;
    }
    i = j + 1;
  }
  return out;
}

interface Rule {
  readonly test: (line: string) => boolean;
  readonly why: string;
}

const rule = (re: RegExp, why: string): Rule => ({ test: (l) => re.test(l), why });

/** Ways to submit that fit on one line. */
const LINE_RULES: readonly Rule[] = [
  rule(/submit[A-Za-z]*\s*\.\s*click\s*\(/i, 'clicks a locator named submit'),
  rule(/\[\s*type\s*[=~|^$*]*=?\s*['"]?\s*submit/i, 'targets a submit control by type'),
  rule(/\.\s*requestSubmit\s*\(/i, 'calls requestSubmit()'),
  rule(/\.\s*submit\s*\(\s*\)/i, 'calls .submit() on something'),
  rule(/new\s+SubmitEvent\b/, 'constructs a SubmitEvent'),
  rule(/new\s+Event\s*\(\s*['"`]submit/i, 'constructs a submit Event'),
  rule(/dispatchEvent\s*\([^)]*submit/i, 'dispatches a submit event'),
  // Enter submits a single-input form in every browser, so it is a submit path that
  // contains neither the word "click" nor the word "submit". `pressSequentially` and `type`
  // press a real key per character, so a "\n" inside the string is an Enter press too.
  //
  // `keyboard.insertText` is deliberately absent. It sets the value without dispatching
  // keydown at all, which is exactly why `fill.ts` uses it to put a line break into a
  // textarea, and flagging it would mean flagging the code written to avoid this problem.
  rule(/\.\s*(?:press|down)\s*\(\s*['"`]\s*(?:Enter|\\n|\\r)/i, 'presses Enter'),
  rule(
    /\.\s*(?:type|pressSequentially)\s*\(\s*['"`][^'"`]*\\[nr]/i,
    'types a newline, which presses Enter',
  ),
];

/**
 * A click and a submit-shaped target, within three lines of each other.
 *
 * Three lines rather than one because Playwright chains wrap:
 *
 *     await page
 *       .locator('#submit-application')
 *       .click();
 *
 * puts the target and the click on different lines, and a per-line rule reads both halves as
 * innocent. Comment-only lines are removed before the window is formed, so prose between two
 * statements cannot pull them together.
 */
const CLICK = /\.\s*click\s*\(/i;
const NAMES_SUBMIT = /submit/i;
const WINDOW = 3;

export interface Offence {
  readonly file: string;
  readonly line: number;
  readonly why: string;
  readonly text: string;
}

export function scanSource(file: string, src: string): Offence[] {
  const found: Offence[] = [];
  const lines = src.split('\n').map((l) => (isCommentOnly(l) ? '' : dropExclusions(l)));

  lines.forEach((l, i) => {
    if (l === '') return;
    for (const rule of LINE_RULES) {
      if (rule.test(l)) found.push({ file, line: i + 1, why: rule.why, text: l.trim() });
    }
  });

  const code = lines.map((l, i) => ({ l, i })).filter(({ l }) => l !== '');
  code.forEach((_, at) => {
    const window = code.slice(at, at + WINDOW);
    const joined = window.map((w) => w.l).join(' ');
    if (CLICK.test(joined) && NAMES_SUBMIT.test(joined)) {
      const first = window[0];
      if (first !== undefined) {
        found.push({
          file,
          line: first.i + 1,
          why: 'clicks something named submit',
          text: joined.trim().slice(0, 160),
        });
      }
    }
  });

  // One line can trip several rules; report it once.
  const seen = new Set<string>();
  return found.filter((o) => {
    const key = `${o.file}:${String(o.line)}:${o.why}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * The scanner has to prove it still catches things before it is allowed to say "clean".
 *
 * The old CI step could not tell "there is no submit path" from "my pattern matches
 * nothing", and it printed the same reassuring line either way for however long the pattern
 * had been broken. These samples are the ones a person would actually write.
 */
const MUST_CATCH: ReadonlyArray<readonly [string, string]> = [
  ['page.click selector', "await page.click('button[type=submit]');"],
  ['page.click input selector', 'await page.click("input[type=submit]");'],
  ['double-quoted attribute', 'await page.click(\'button[type="submit"]\');'],
  ['chained locator', "await page.locator('#submit-application').click();"],
  ['role locator', "await page.getByRole('button', { name: 'Submit' }).click();"],
  ['identifier receiver', 'await submitButton.click();'],
  ['multi-line chain', "await page\n  .locator('#submit-application')\n  .click();"],
  ['enter key', "await page.keyboard.press('Enter');"],
  ['requestSubmit', 'form.requestSubmit();'],
  ['form.submit inside evaluate', 'await page.evaluate((f) => f.submit());'],
  ['dispatched event', "el.dispatchEvent(new Event('submit', { bubbles: true }));"],
  ['typed newline', 'await loc.type("done\\n");'],
];

const MUST_NOT_CATCH: ReadonlyArray<readonly [string, string]> = [
  [
    'the scanner excluding submit controls',
    "const SELECTORS = 'input:not([type=hidden]):not([type=submit]):not([type=button])';",
  ],
  [
    'prose describing the guarantee',
    ' * merely that no `.click()` was written. Not clicking submit is',
  ],
  ['a line comment naming submit', '// Nothing in this file clicks a submit control.'],
  ['an ordinary click', 'await loc.click();'],
  ['an ordinary field type', "await loc.pressSequentially('Ada Lovelace');"],
  ['a line break that presses no key', "await page.keyboard.insertText('\\n');"],
];

function selfTest(): string[] {
  const broken: string[] = [];
  for (const [name, sample] of MUST_CATCH) {
    if (scanSource('sample.ts', sample).length === 0) broken.push(`misses ${name}: ${sample}`);
  }
  for (const [name, sample] of MUST_NOT_CATCH) {
    const hits = scanSource('sample.ts', sample);
    if (hits.length > 0) broken.push(`false positive on ${name}: ${hits[0]?.why ?? ''}`);
  }
  return broken;
}

function main(): void {
  const broken = selfTest();
  if (broken.length > 0) {
    console.error('The G4 scanner is broken, so it cannot vouch for anything:');
    for (const b of broken) console.error(`  ${b}`);
    process.exit(2);
  }

  const files: string[] = [];
  for (const root of ROOTS) {
    const abs = path.resolve(REPO_ROOT, root);
    try {
      files.push(...walk(abs));
    } catch {
      // A missing root means the scan checked nothing, which must never read as a pass:
      // renaming apps/server/src once would have printed "ok" having opened no files.
      console.error(`${root} is missing, so the G4 scan checked nothing.`);
      process.exit(2);
    }
  }

  if (files.length === 0) {
    console.error(`No TypeScript files under ${ROOTS.join(', ')}; the G4 scan checked nothing.`);
    process.exit(2);
  }

  const offences = files.flatMap((f) =>
    scanSource(path.relative(REPO_ROOT, f).replace(/\\/g, '/'), readFileSync(f, 'utf8')),
  );

  if (offences.length > 0) {
    console.error('The tool must never submit an application. The user does that (G4).');
    for (const o of offences) {
      console.error(`  ${o.file}:${String(o.line)} ${o.why}\n    ${o.text}`);
    }
    process.exit(1);
  }

  console.log(`ok — ${String(files.length)} files scanned, no submit path found`);
}

// Only when run as a command. `scanSource` above is exported so a test can drive the same
// patterns instead of keeping a second copy of them that drifts.
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
