/**
 * Audits this app's own interface copy with the same detector used on generated answers.
 *
 * A tool that flags machine-sounding prose in your application while writing it on its
 * own buttons has no standing. Run with: npm run audit:copy
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTells } from '../apps/server/src/core/writing/tellScrub';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, exts: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full, exts);
    return exts.some((x) => full.endsWith(x)) ? [full] : [];
  });
}

/**
 * Files that NAME the tells rather than committing them.
 *
 * `tellScrub.ts` is the word list itself. `draft.ts` carries the drafting prompt, which
 * spells out the banned constructions verbatim so the model knows what to avoid — a
 * prompt is instructions to a model, not copy shown to a person, and auditing it just
 * rediscovers the list. Nothing else gets an exemption: if a string in this codebase is
 * shown to the user, it is audited.
 */
const EXEMPT = ['tellScrub.ts', 'core/writing/draft.ts'];

const files = [
  ...walk(path.join(root, 'apps/web/src'), ['.tsx', '.ts']),
  ...walk(path.join(root, 'apps/server/src'), ['.ts']),
].filter((f) => !EXEMPT.some((e) => f.replace(/\\/g, '/').endsWith(e)));

interface Finding {
  file: string;
  kind: string;
  match: string;
  context: string;
}

const findings: Finding[] = [];

/**
 * Removes regex literals before scanning.
 *
 * `redlines.ts` and `classify.ts` are tables of patterns that DETECT machine-sounding and
 * bureaucratic vocabulary on someone else's form. Auditing their sources finds the words
 * they are built to look for, which is backwards. Exempting the whole file would be worse:
 * both also carry `note:` strings that are shown to the user and do need auditing.
 */
function stripRegexLiterals(src: string): string {
  return src.replace(/\/(?![/*])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/g, ' ');
}

/**
 * The prose between JSX tags — the sentences a user actually reads on screen.
 *
 * Only `.tsx` has JSX. Run over server `.ts` this pattern matched whatever sat between a
 * `>` (a comparison, an arrow, a closing generic) and the next `<`, so two dozen fragments
 * of ordinary code were audited as interface copy on every run, and a fifth of the words in
 * the aggregate corpus were TypeScript rather than English.
 */
function textNodes(file: string, src: string): string[] {
  if (!file.endsWith('.tsx')) return [];
  return (src.match(/>[^<>{}]{25,400}</g) ?? []).map((s) => s.slice(1, -1));
}

/**
 * Quoted strings long enough to be prose.
 *
 * A run of characters between two quotes that crosses a line break is never one string
 * literal — TypeScript does not allow it — it is the gap between two of them, and that gap
 * is code. One `className="…"` followed by a JSX comment three lines down was enough to
 * capture the comment as user-facing copy and fail the build on a word in it.
 */
function quotedStrings(src: string): string[] {
  return [
    ...(src.match(/'[^'\n]{35,400}'/g) ?? []).map((s) => s.slice(1, -1)),
    ...(src.match(/"[^"\n]{35,400}"/g) ?? []).map((s) => s.slice(1, -1)),
  ];
}

function normalize(raw: string[]): string[] {
  return raw.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 25);
}

const allProse: string[] = [];

for (const f of files) {
  const src = stripRegexLiterals(readFileSync(f, 'utf8'));
  const prose = normalize(textNodes(f, src));
  allProse.push(...prose);

  for (const text of [...prose, ...normalize(quotedStrings(src))]) {
    // Structural checks are meaningless on individual UI strings; lexical ones are not.
    for (const t of findTells(text, { minWordsForStructural: 100_000 })) {
      findings.push({
        file: path.relative(root, f).replace(/\\/g, '/'),
        kind: t.kind,
        match: t.match,
        context: text.slice(0, 80),
      });
    }
  }
}

const seen = new Set<string>();
const unique = findings.filter((f) => {
  const k = [f.file, f.kind, f.match.toLowerCase(), f.context].join('|');
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

console.log(unique.length + " lexical finding(s) in this app's own copy");
console.log('');
for (const f of unique) {
  console.log(f.file);
  console.log('  [' + f.kind + '] "' + f.match + '"');
  console.log('  ' + f.context);
  console.log('');
}

/**
 * Structural checks need the copy in aggregate — em-dash density and sentence rhythm are
 * properties of a body of prose, not of one button label.
 *
 * Screen text only, which is why this corpus is narrower than what the lexical pass reads.
 * Quoted strings are mostly class attributes and query fragments; feeding those in counted
 * every `--custom-property` as an em-dash and reported a density five times the real one.
 */
const corpus = allProse.join(' ');
const wordCount = (corpus.match(/[\p{L}'-]+/gu) ?? []).length;
const emDashes = (corpus.match(/—/g) ?? []).length;

console.log('--- interface copy in aggregate ---');
console.log('words: ' + wordCount);
console.log(
  'em-dashes: ' +
    emDashes +
    ' (' +
    ((emDashes / Math.max(1, wordCount)) * 100).toFixed(2) +
    ' per 100 words)',
);

const structural = findTells(corpus, { minWordsForStructural: 60 });
console.log('structural findings: ' + structural.length);
for (const t of structural) {
  console.log('  [' + t.kind + '] ' + t.note);
}

if (unique.length > 0) process.exitCode = 1;
