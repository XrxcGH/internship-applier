/**
 * Per-file database isolation.
 *
 * `infra/db/client.ts` opens a connection at import time from `DATABASE_PATH`, so every
 * test file was writing to the same SQLite file. Order-dependent passes are worse than
 * failures — a confirmed profile left behind by one file quietly changed what another
 * file observed. Vitest runs setup once per test file, so pointing each at a fresh
 * temporary database makes the isolation real rather than incidental.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_PATH'] = path.join(
  mkdtempSync(path.join(tmpdir(), 'internship-applier-test-')),
  'app.db',
);

/**
 * No test may reach a model.
 *
 * Backend resolution is `auto` by default, so on a machine with the Claude Code CLI
 * installed and signed in, a test could spawn it and spend the developer's usage —
 * and the same suite would then behave differently from CI, where nothing is installed.
 * Pinning this makes "no model available" the deterministic condition everywhere.
 */
process.env['LLM_PROVIDER'] = 'none';
