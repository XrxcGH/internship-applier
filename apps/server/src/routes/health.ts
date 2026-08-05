import type { FastifyInstance } from 'fastify';
import { HealthResponse } from '@ia/shared';
import { config } from '../config';
import { countTables, db, isConnected, schema } from '../infra/db/client';

const startedAt = Date.now();

/** Gate G1: until a profile is confirmed, feature endpoints reject with PROFILE_NOT_CONFIRMED. */
async function profileIsConfirmed(): Promise<boolean> {
  try {
    const rows = await db.select({ confirmedAt: schema.profile.confirmedAt }).from(schema.profile);
    return rows.some((r) => r.confirmedAt !== null);
  } catch {
    return false;
  }
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    return HealthResponse.parse({
      status: 'ok',
      version: process.env.npm_package_version ?? '0.0.0',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      node: process.version,
      db: { connected: isConnected(), tables: countTables() },
      profileConfirmed: await profileIsConfirmed(),
      time: new Date().toISOString(),
    });
  });
  /**
   * Hands the local UI the per-run token it needs for every other route.
   *
   * BE HONEST ABOUT WHAT THIS COSTS. CORS constrains browsers; it does nothing to a curl
   * or a script, either of which can fetch this and then call any route. So the token is
   * not a boundary against local processes in general — it stops a stray PAGE in another
   * browser tab from driving the API, and it stops accidental cross-talk. A process
   * running as this user was never going to be kept out by it: it can read the database
   * file directly. docs/10 states the same limit rather than the stronger claim it used
   * to make.
   */
  app.get('/api/session', async () => ({ token: config.appToken }));
}
