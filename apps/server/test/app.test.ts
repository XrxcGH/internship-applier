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
 * Who this server will answer to.
 *
 * Listening on 127.0.0.1 is not by itself a boundary: a site can point its own DNS name at
 * 127.0.0.1, and once the browser re-resolves it, that site's pages are same origin with
 * this server. The socket really does come from loopback and CORS never engages, so before
 * the Host header was checked, such a page could fetch a token from the exempt
 * /api/session and go straight on to the privacy export or the delete-everything route.
 *
 * Built without `skipAuth` because this is not the token check and must not be switched
 * off with it.
 */
describe('Host pinning', () => {
  let strict: FastifyInstance;

  beforeAll(async () => {
    strict = await buildApp();
    await strict.ready();
  });

  afterAll(async () => {
    await strict.close();
  });

  const get = (url: string, host: string) =>
    strict.inject({ method: 'GET', url, headers: { host }, remoteAddress: '127.0.0.1' });

  it('refuses a request addressed to somebody else, token route included', async () => {
    for (const url of ['/api/session', '/api/privacy/export', '/api/privacy/delete-preview']) {
      const res = await get(url, 'evil.example:8787');
      expect(res.statusCode, url).toBe(403);
      expect(res.body, url).not.toMatch(/token/);
    }
  });

  it('is not fooled by a name that merely ends in one of ours', async () => {
    for (const host of ['evil.localhost:8787', 'notlocalhost:8787', '127.0.0.1.evil.example']) {
      expect((await get('/api/session', host)).statusCode, host).toBe(403);
    }
  });

  it('lets the real interface through, on either port it can arrive from', async () => {
    // 5173 is the Vite dev proxy, which forwards with changeOrigin: false; 8787 is this
    // server handing out the built UI itself.
    for (const host of ['127.0.0.1:8787', 'localhost:8787', '127.0.0.1:5173', '[::1]:8787']) {
      expect((await get('/api/session', host)).statusCode, host).toBe(200);
    }
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
    // Any receiver, not only an identifier starting with "form". The pattern above misses
    // document.querySelector('form').submit() and page.evaluate((f) => f.submit()), both
    // of which submit an application just as thoroughly.
    [/\.\s*submit\s*\(\s*\)/, 'calls .submit() on something'],
    [/new\s+SubmitEvent/, 'constructs a SubmitEvent'],
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
