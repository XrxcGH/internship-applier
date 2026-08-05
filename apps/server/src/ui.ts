/**
 * Serving the built interface from the API server — docs/11 § M8.
 *
 * In development, Vite serves the UI on its own port and proxies to this one. That is two
 * processes and two ports, which is fine for working on the thing and wrong for using it.
 * In production the built assets are served from here, so the whole app is one command and
 * one URL.
 *
 * THE FALLBACK IS THE FIDDLY PART. A single-page app owns its routing, so any path that is
 * not a real file has to return index.html rather than a 404 — but that must not swallow
 * `/api/*`, or a mistyped endpoint returns an HTML page and the client's `res.json()`
 * throws something incomprehensible instead of reporting a 404.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { config } from './config';
import { logger } from './infra/logger';

/** Where `npm run build` puts the interface. */
export const UI_DIR = path.resolve(config.paths.root, 'apps/web/dist');

export function uiIsBuilt(): boolean {
  return existsSync(path.join(UI_DIR, 'index.html'));
}

/**
 * Registers the static plugin and reports whether it is serving.
 *
 * It does NOT install a not-found handler. Fastify permits exactly one per instance, and
 * setting a second throws at boot — which is how this was found, by running it. The single
 * handler lives in `app.ts` and asks this module what it should do.
 */
export async function registerUiStatic(app: FastifyInstance): Promise<boolean> {
  if (!uiIsBuilt()) {
    logger.info(
      { dir: UI_DIR },
      'no built interface found; serving the API only (run npm run build first)',
    );
    return false;
  }

  await app.register(fastifyStatic, { root: UI_DIR, wildcard: false });
  logger.info({ dir: UI_DIR }, 'serving the built interface');
  return true;
}
