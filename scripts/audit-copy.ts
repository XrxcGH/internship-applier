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

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  // User-facing text: JSX text nodes plus quoted strings long enough to be prose.
  const strings = [
    ...(src.match(/>[^<>{}]{25,400}</g) ?? []).map((s) => s.slice(1, -1)),
    ...(src.match(/'[^']{35,400}'/g) ?? []).map((s) => s.slice(1, -1)),
    ...(src.match(/"[^"]{35,400}"/g) ?? []).map((s) => s.slice(1, -1)),
  ];

  for (const s of strings) {
    const text = s.replace(/\s+/g, ' ').trim();
    if (text.length < 25) continue;
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
 */
const allProse: string[] = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const s of src.match(/>[^<>{}]{25,400}</g) ?? []) {
    allProse.push(s.slice(1, -1).replace(/\s+/g, ' ').trim());
  }
}

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
