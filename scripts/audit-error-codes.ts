/**
 * Keeps `ApiErrorCode` honest about what the server actually sends.
 *
 * The doc block on that enum has always said "add one here in the same commit that starts
 * emitting it", and saying it was all it did. `PAST_FILLING` and `APPLICATION_IN_PROGRESS`
 * were both live in the fill route while the enum denied they existed, which means a client
 * that ran `ApiError.parse(body)` on either got a ZodError where it expected a code to
 * branch on — the error about the error. Run with: npx tsx scripts/audit-error-codes.ts
 *
 * Only the enum being too NARROW is a failure. A code listed here and no longer emitted is
 * reported and does not fail: removing one is a breaking change for anyone already
 * branching on it, and that call belongs to a person.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiErrorCode } from '../packages/shared/src/api';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = path.join(REPO_ROOT, 'apps/server/src');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const emitted = new Map<string, string>();
for (const file of walk(SERVER_SRC)) {
  const src = readFileSync(file, 'utf8');
  for (const [, code] of src.matchAll(/\bcode:\s*'([A-Z][A-Z0-9_]*)'/g)) {
    if (code !== undefined && !emitted.has(code)) {
      emitted.set(code, path.relative(REPO_ROOT, file).replace(/\\/g, '/'));
    }
  }
}

if (emitted.size === 0) {
  console.error('Found no error codes in apps/server/src, so this audit checked nothing.');
  process.exit(2);
}

const declared = new Set<string>(ApiErrorCode.options);
const missing = [...emitted].filter(([code]) => !declared.has(code));
const unused = [...declared].filter((code) => !emitted.has(code));

if (unused.length > 0) {
  console.log(`declared but not emitted (not a failure): ${unused.join(', ')}`);
}

if (missing.length > 0) {
  console.error('These error codes are sent by the server and missing from ApiErrorCode:');
  for (const [code, file] of missing) console.error(`  ${code} — ${file}`);
  console.error('A client parsing one of these gets a ZodError instead of the code.');
  process.exit(1);
}

console.log(`ok — all ${String(emitted.size)} emitted error codes are declared`);
