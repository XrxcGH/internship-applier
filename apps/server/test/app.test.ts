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

  it('contains no submit-click in server source', () => {
    const offenders = walk(serverSrc)
      .filter((f) => /[/\\]core[/\\]filling[/\\]/.test(f))
      .filter((f) => /\.click\s*\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
