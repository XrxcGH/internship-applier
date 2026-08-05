/**
 * Test isolation. Runs once per test file, before that file's imports.
 *
 * TWO THINGS ARE ISOLATED HERE AND BOTH ARE LOAD-BEARING.
 *
 * The DATABASE. `infra/db/client.ts` opens a connection at import time, so without this
 * every test file shared one SQLite file with the dev server and passes were ordering
 * luck.
 *
 * The DATA DIRECTORY. This is the one that bit. `DATABASE_PATH` alone was not enough,
 * because `resumes/`, `artifacts/`, `browser-profile/` and the master key were derived
 * from the repository root rather than from it. The privacy tests exercise
 * `deleteEverything()`, which is a real `rm -rf` — so `npm test` destroyed the developer's
 * actual data directory and encryption key. Every path now hangs off `DATA_DIR`, and this
 * points it somewhere disposable.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREFIX = 'internship-applier-test-';

/**
 * Clear out what earlier runs left behind.
 *
 * This file runs once per test file, so every `npm test` dropped twenty-five directories of
 * SQLite databases — fixture profiles, resumes, an encryption key — into the OS temp
 * directory, and nothing ever removed them. On Windows, where nothing purges %TEMP%, an
 * afternoon of `test:watch` leaves hundreds.
 *
 * Cleaning up on the way out does not work: Windows will not unlink the database while the
 * connection is still open, and a teardown that threw would fail an otherwise green test
 * file. So each run clears the previous one's, and leaves alone anything recent enough to
 * belong to a worker running right now.
 */
const stale = Date.now() - 60 * 60 * 1000;
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith(PREFIX)) continue;
  const dir = path.join(tmpdir(), name);
  try {
    if (statSync(dir).mtimeMs < stale) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Another worker's, still locked, or already gone. None of that is worth failing over.
  }
}

const root = mkdtempSync(path.join(tmpdir(), PREFIX));

process.env['NODE_ENV'] = 'test';
process.env['DATA_DIR'] = root;
process.env['DATABASE_PATH'] = path.join(root, 'app.db');

/**
 * No test may reach a model.
 *
 * Backend resolution is `auto` by default, so on a machine with the Claude Code CLI
 * installed and signed in, a test could spawn it and spend the developer's usage — and
 * the same suite would then behave differently from CI, where nothing is installed.
 * Pinning this makes "no model available" the deterministic condition everywhere.
 */
process.env['LLM_PROVIDER'] = 'none';
