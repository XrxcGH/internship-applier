import { describe, expect, it } from 'vitest';
import { startFixtureServer } from '@ia/fixtures';

describe('fixture site', () => {
  it('serves every page and shuts down cleanly', async () => {
    const s = await startFixtureServer(0);
    try {
      for (const p of ['/', '/simple', '/redlines', '/nasty', '/framed', '/wizard', '/login']) {
        const r = await fetch(s.url + p);
        expect(r.status, p).toBe(200);
        expect((await r.text()).length, p).toBeGreaterThan(100);
      }
      expect((await fetch(s.url + '/nope')).status).toBe(404);
    } finally {
      await s.close();
    }
  }, 20000);
});
