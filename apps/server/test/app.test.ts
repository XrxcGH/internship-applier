import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { HealthResponse } from '@ia/shared';
import { buildApp } from '../src/app';
import { runMigrations } from '../src/infra/db/migrate';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(here, '../src');

let app: FastifyInstance;

beforeAll(async () => {
  runMigrations();
  app = await buildApp({ skipAuth: true });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('health', () => {
  it('reports ok and a connected database', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);

    const body = HealthResponse.parse(res.json());
    expect(body.status).toBe('ok');
    expect(body.db.connected).toBe(true);
    expect(body.db.tables).toBeGreaterThan(0);
    expect(body.profileConfirmed).toBe(false);
  });

  it('404s unknown routes with the standard error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

/**
 * Gate G4 (docs/07-form-automation.md): the tool fills forms, the user submits them.
 * This is a release gate, not a style check — it asserts that no route capable of
 * submitting an application can exist in the codebase.
 */
describe('G4 — no auto-submit path exists', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
    });
  }

  it('registers no route that submits an application', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/applications/abc/submit' });
    expect(res.statusCode).toBe(404);
  });

  /**
   * This started as "no `.click(` anywhere in core/filling", which was right until the
   * filler needed to click a text input to focus it and click an option in a div-based
   * combobox. A guard that forbids every click would either be deleted or worked around,
   * and neither leaves any protection behind.
   *
   * So it is narrower AND wider now. Narrower: only submit-shaped targets are banned.
   * Wider: it also bans the routes to submission that are not clicks at all — calling
   * `form.submit()`, `requestSubmit()`, or pressing Enter, which submits a single-input
   * form in every browser.
   *
   * The behavioural check is stronger than any of this and lives in fill.test.ts: the
   * fixture counts POSTs, so the suite asserts no form was submitted however it happened.
   */
  const fillingSources = (): Array<{ file: string; src: string }> =>
    walk(serverSrc)
      .filter((f) => /[/\\]core[/\\]filling[/\\]/.test(f))
      .map((f) => ({ file: path.relative(serverSrc, f), src: readFileSync(f, 'utf8') }));

  const BANNED: Array<[RegExp, string]> = [
    [/\.click\s*\([^)]*submit/i, 'clicks something named submit'],
    [/submit[A-Za-z]*\s*\.\s*click\s*\(/i, 'clicks a submit locator'],
    [/\.\s*requestSubmit\s*\(/, 'calls requestSubmit()'],
    [/\bform[A-Za-z]*\s*\.\s*submit\s*\(/i, 'calls form.submit()'],
    [/\.press\s*\(\s*['"`]Enter/i, 'presses Enter, which submits a single-input form'],
    // Only a selector that SELECTS a submit control. The lookbehind is load-bearing:
    // `input:not([type=submit])` is the scanner deliberately excluding them, and a guard
    // that flagged it would be arguing for its own removal.
    [/(?<!:not\()\[type\s*=\s*['"]?submit/i, 'targets a submit control by type'],
  ];

  it('contains no path to submitting a form', () => {
    const offenders: string[] = [];
    for (const { file, src } of fillingSources()) {
      for (const [pattern, why] of BANNED) {
        if (pattern.test(src)) offenders.push(`${file} ${why}`);
      }

      // Catches the chained form the whole-file patterns miss:
      //   page.locator('#submit-application').click()
      // where "submit" sits in the selector rather than in the click call. Checked per
      // line so an exclusion selector elsewhere in the file cannot trigger it.
      src.split('\n').forEach((line, i) => {
        const hasClick = /\.click\s*\(/.test(line);
        const namesSubmit = /submit/i.test(line) && !/:not\(\[type\s*=\s*['"]?submit/i.test(line);
        if (hasClick && namesSubmit) {
          offenders.push(`${file}:${String(i + 1)} clicks something named submit`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('still guards something — the filling module exists and does click things', () => {
    // Without this, deleting core/filling entirely would make the check above pass.
    const sources = fillingSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some(({ src }) => /\.click\s*\(/.test(src))).toBe(true);
  });
});
