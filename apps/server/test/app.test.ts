import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { HealthResponse } from '@ia/shared';
import { buildApp, canonicalTarget } from '../src/app';
import { config } from '../src/config';
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
 * One path, one spelling.
 *
 * The router percent-decodes a path before matching, so `/%61pi/privacy/export` reaches the
 * privacy handler exactly as `/api/privacy/export` does — while every guard compared the
 * raw, still-encoded target against a literal string and saw nothing beginning `/api/`.
 * Changing one character to its escape therefore turned off the token check AND both G1
 * hooks at once: the whole decrypted export came back unauthenticated, and a discovery run
 * executed against a profile that had never been confirmed.
 *
 * Nothing could catch it, either. NODE_ENV is `test` for the whole suite, so `config.isTest`
 * switched the token branch off before any test could reach it — which is why `skipAuth`
 * has to be passed as `false` here rather than left out.
 */
describe('request paths are decided on after decoding', () => {
  it.each([
    ['/api/privacy/export', '/%61pi/privacy/export'],
    ['/api/privacy/export', '/ap%69/privacy/export'],
    ['/api/tracker', '/%61pi/tracker'],
    ['/api/matches', '/%61pi/matches'],
  ])('%s is guarded however it is spelled (%s)', (plain, encoded) => {
    expect(canonicalTarget(encoded)).toBe(plain);
  });

  it('leaves an ordinary target, its query string, and its parameters alone', () => {
    expect(canonicalTarget('/api/matches?minScore=40&limit=10')).toBe(
      '/api/matches?minScore=40&limit=10',
    );
    // A review flag really can contain a space and a percent sign — "honors.0.top 5%" — and
    // the client encodes it exactly once. Decoding the path must not disturb the query.
    expect(canonicalTarget('/api/profile/reviewed/honors.0.top%205%25?x=1')).toBe(
      '/api/profile/reviewed/honors.0.top 5%?x=1',
    );
  });

  it('never widens a path into one the router would not have matched', () => {
    // `//api/x` is a different path to the router, which 404s it. Folding the empty segment
    // away here would leave this guard more permissive than the thing it guards, so empty
    // segments stay while `.` and `..` — the next spelling anyone would try — come out.
    expect(canonicalTarget('//api/matches')).toBe('//api/matches');
    expect(canonicalTarget('/%2e/api/matches')).toBe('/api/matches');
    expect(canonicalTarget('/x/%2e%2e/api/matches')).toBe('/api/matches');
    // A malformed escape is nobody's path. It is left as sent, which reads as guarded.
    expect(canonicalTarget('/api/%zz')).toBe('/api/%zz');
  });

  describe('with the token check actually switched on', () => {
    let guarded: FastifyInstance;

    beforeAll(async () => {
      guarded = await buildApp({ skipAuth: false });
      await guarded.ready();
    });

    afterAll(async () => {
      await guarded.close();
    });

    const get = (url: string, token?: string) =>
      guarded.inject({
        method: 'GET',
        url,
        headers: { host: '127.0.0.1:8787', ...(token ? { 'x-app-token': token } : {}) },
        remoteAddress: '127.0.0.1',
      });

    it('refuses an encoded path exactly as it refuses the plain one', async () => {
      for (const url of [
        '/api/privacy/export',
        '/%61pi/privacy/export',
        '/ap%69/privacy/export',
        '/api/tracker',
        '/%61pi/tracker',
      ]) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(401);
        expect(res.json().error.message, url).toMatch(/X-App-Token/);
      }
    });

    it('still lets the real token through, and still exempts the two bootstrap routes', async () => {
      expect((await get('/api/tracker', config.appToken)).statusCode).toBe(200);
      expect((await get('/api/health')).statusCode).toBe(200);
      expect((await get('/api/session')).statusCode).toBe(200);
    });
  });

  it('holds gate G1 shut on an encoded path', async () => {
    // No profile has been confirmed in this file, so both of these must refuse. `app` is
    // built with skipAuth, which leaves the two route-level hooks as the only thing between
    // an encoded path and a real discovery run.
    for (const [method, url] of [
      ['GET', '/api/matches'],
      ['GET', '/%61pi/matches'],
      ['GET', '/ap%69/matches?minScore=0'],
      ['POST', '/api/discovery/run'],
      ['POST', '/%61pi/discovery/run'],
      ['POST', '/api/disc%6fvery/run'],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, url).toBe(409);
      expect(res.json().error.code, url).toBe('PROFILE_NOT_CONFIRMED');
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
      //
      // A line that is nothing but a comment is skipped, because it cannot click anything.
      // The docblock at the top of fill.ts explains G4 by saying the fixture proves no form
      // was submitted "rather than merely that no `.click()` was written" — a sentence about
      // this very rule, which the rule then reported as a violation. A release gate that
      // fails on prose describing it is a gate people start editing around. Lines that mix
      // code and a trailing comment are still checked; only whole-comment lines are exempt.
      src.split('\n').forEach((line, i) => {
        if (/^\s*(?:\/\/|\/?\*)/.test(line)) return;
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
