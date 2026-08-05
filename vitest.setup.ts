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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'internship-applier-test-'));

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
