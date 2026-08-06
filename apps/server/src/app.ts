import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from './config';
import { logger } from './infra/logger';
import { constantTimeEquals } from './infra/crypto/fieldCrypto';
import { healthRoutes } from './routes/health';
import { profileRoutes } from './routes/profile';
import { resumeRoutes } from './routes/resumes';
import { discoveryRoutes } from './routes/discovery';
import { matchRoutes } from './routes/matches';
import { eventRoutes } from './routes/events';
import { writingRoutes } from './routes/writing';
import { answerRoutes } from './routes/answers';
import { fillingRoutes } from './routes/filling';
import { trackerRoutes } from './routes/tracker';
import { privacyRoutes } from './routes/privacy';
import { registerUiStatic } from './ui';

export interface BuildOptions {
  /**
   * Disable the X-App-Token check. Test-only.
   *
   * Left undefined it follows `config.isTest`, which is how the suite runs. Passing `false`
   * on purpose turns the check on inside a test, which is the only way to have a test that
   * asserts anything about the token at all.
   */
  skipAuth?: boolean;
}

/**
 * The names this server will answer to.
 *
 * Binding to 127.0.0.1 does not keep a web page out. Any site can point one of its own DNS
 * names at 127.0.0.1 and wait for the browser to re-resolve it; from then on that site's
 * pages are same origin with this server. The connection genuinely arrives from loopback,
 * so the check below it passes, and nothing is cross-origin any more, so CORS never
 * engages — which is how a stray tab could fetch a token from the exempt /api/session and
 * then read the privacy export or delete the database, resumes and encryption key outright.
 * The Host header is the one part of such a request that still carries the attacker's own
 * name, so it is the thing worth checking.
 *
 * The port deliberately is not checked. The Vite dev proxy forwards with
 * `changeOrigin: false`, so in development the Host that arrives is 127.0.0.1:5173 while
 * the built-UI mode sends 127.0.0.1:8787, and both are the same user at the same machine.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * The one spelling of a request target that this server is allowed to reason about.
 *
 * The router percent-decodes a path before it matches, so `/%61pi/privacy/export` reaches
 * the privacy handler exactly as `/api/privacy/export` does. Every guard here and in the
 * route modules compared the raw, still-encoded target against a literal path, so changing
 * a single character to its escape walked past all of them at once: an unauthenticated
 * `GET /%61pi/privacy/export` returned the whole decrypted export, PII included, and
 * `POST /%61pi/discovery/run` started a real discovery run against a profile the user had
 * never confirmed — gate G1, bypassed by typing `%61` instead of `a`.
 *
 * THE RULE, so the next guard keeps it: never compare a raw request target against a
 * literal path. Ask this function first. Percent-encoding is one way to spell a path
 * differently and it is not the only one, so `.` and `..` segments come out here too — the
 * router does not collapse them today, but a guard that only knew about the one trick
 * someone happened to try is how this file got into trouble in the first place.
 *
 * Empty segments are deliberately kept: `//api/matches` is a different path to the router
 * (it 404s), and folding it to `/api/matches` here would only ever make this guard more
 * permissive than the thing it guards. Everything this function does errs the other way.
 */
export function canonicalTarget(target: string): string {
  const q = target.indexOf('?');
  const rawPath = q === -1 ? target : target.slice(0, q);
  const query = q === -1 ? '' : target.slice(q);

  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // A malformed escape is not a path anybody meant. Fastify rejects most of these with a
    // 400 before a hook ever runs; leaving the target as sent means the guards see an
    // undecoded string and treat it as guarded, which is the safe direction.
  }

  const out: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const path = out.join('/');
  return (path.startsWith('/') ? path : `/${path}`) + query;
}

function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  // `[::1]:8787` — an IPv6 literal in a Host header is always bracketed when a port follows.
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    return close === -1 ? value : value.slice(1, close);
  }
  // A bare IPv6 literal has several colons and no port; everything else has at most one.
  return value.split(':').length > 2 ? value : (value.split(':')[0] ?? '');
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // pino's exported Logger type and Fastify's bundled FastifyBaseLogger drift between
    // major versions; they are structurally compatible at runtime.
    // Request logging is controlled by the logger's level (see infra/logger.ts) rather
    // than Fastify's `disableRequestLogging`, which is deprecated in v5.
    loggerInstance: logger as unknown as FastifyBaseLogger,
  });

  await app.register(cors, {
    // The Vite dev server, plus this server's own address for when it serves the built
    // interface itself. Same-origin requests skip CORS entirely, but naming it keeps the
    // two modes from behaving differently for no visible reason.
    origin: [config.web.origin, `http://${config.server.host}:${String(config.server.port)}`],
    credentials: true,
  });

  await app.register(multipart, { limits: { fileSize: 12 * 1024 * 1024, files: 1 } });

  // Who is allowed to talk to this server: the connection has to come from loopback, and
  // the request has to have been addressed to it. Belt-and-braces alongside binding to
  // 127.0.0.1, which on its own stops neither a local script nor a rebound web page.
  app.addHook('onRequest', async (req, reply) => {
    const ip = req.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      return reply.code(403).send({
        error: { code: 'INTERNAL', message: 'This API accepts loopback connections only.' },
      });
    }

    // A missing Host is as suspect as a foreign one. Nothing that reaches this server
    // legitimately omits it, and treating an absent header as permission is how a check
    // like this quietly stops working. Kept out of `skipAuth` on purpose: it is not the
    // token check, and the tests should be running against the real thing.
    const host = req.headers.host;
    if (typeof host !== 'string' || !LOOPBACK_HOSTS.has(hostnameOf(host))) {
      return reply.code(403).send({
        error: {
          code: 'INTERNAL',
          message: 'This API answers to localhost only, and this request asked for something else.',
        },
      });
    }

    // Fix the target once, here, rather than asking every guard to decode for itself. This
    // hook is registered on the root instance and so runs before the onRequest hooks the
    // route modules add, which means the two G1 checks — `/api/matches` in routes/matches.ts
    // and `/api/discovery` in routes/discovery.ts — and anything added later all see a path
    // that cannot be disguised, without having to remember anything. Only the API surface is
    // rewritten: static assets are looked up on disk by the target they arrived with, and
    // handing that code a decoded name would make it decode twice.
    const canonical = canonicalTarget(req.url);
    if (canonical !== req.url && canonical.startsWith('/api/')) req.raw.url = canonical;

    // `skipAuth: false` passed explicitly is how the test suite reaches the token check at
    // all: NODE_ENV is `test` throughout the suite, so `config.isTest` used to switch this
    // branch off before any test could exercise it, and a token bypass was invisible to
    // every test that could have caught it. Omitting the option keeps the old behaviour.
    if ((opts.skipAuth ?? config.isTest) === true) return;

    // The token guards the API, not the interface. When this server also serves the built
    // UI, requiring a token for `/index.html` would mean the browser could never load the
    // page that fetches the token. The bundle carries no user data; everything that does
    // goes through /api, which stays protected.
    if (!req.url.startsWith('/api/')) return;

    // Exempt: the liveness probe and the bootstrap that hands the UI its token.
    //
    // What this exemption is and is not worth. A stray page in another browser tab cannot
    // read /api/session, which is the case the token was added for — CORS stops the
    // ordinary cross-origin fetch, and the Host check above stops the DNS-rebinding version
    // that CORS cannot see. It does nothing to a local script: curl can fetch the token
    // here and then call every guarded route. That is not a hole this exemption opened — a
    // process running as this user can read data/app.db and the keyfile directly, so the
    // token was never a boundary against it. docs/10 says the same thing rather than the
    // stronger claim it used to make.
    if (req.url === '/api/health' || req.url === '/api/session') return;

    // A missing header is `undefined` and a header sent twice can arrive as an array;
    // neither is the token, and both are rejected before the comparison rather than being
    // coerced into a string that might accidentally match. The comparison itself is
    // constant-time so that the time a rejection takes says nothing about how many leading
    // characters of the token a guess got right.
    const presented = req.headers['x-app-token'];
    if (typeof presented !== 'string' || !constantTimeEquals(presented, config.appToken)) {
      return reply.code(401).send({
        error: { code: 'INTERNAL', message: 'Missing or invalid X-App-Token.' },
      });
    }
  });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    logger.error({ err }, 'unhandled request error');
    // Fastify raises client mistakes here too, and they kept the status while being labelled
    // INTERNAL: a 13 MB resume trips the multipart limit and came back as a 413 that told the
    // user the server had broken, when the fix was to upload a smaller file.
    const status = err.statusCode ?? 500;
    void reply.code(status).send({
      error: { code: status < 500 ? 'VALIDATION_FAILED' : 'INTERNAL', message: err.message },
    });
  });

  await app.register(healthRoutes);
  await app.register(profileRoutes);
  await app.register(resumeRoutes);
  await app.register(discoveryRoutes);
  await app.register(matchRoutes);
  await app.register(eventRoutes);
  await app.register(writingRoutes);
  await app.register(answerRoutes);
  await app.register(fillingRoutes);
  await app.register(trackerRoutes);
  await app.register(privacyRoutes);

  // Last only because it reads that way. Registration order does not decide anything here:
  // Fastify's router resolves by specificity, and a genuinely duplicated path throws at
  // boot rather than letting one side win quietly. The static plugin is registered with
  // `wildcard: false` besides, so it claims concrete files and never `/api/*`.
  // Skipped in tests: they assert the JSON 404, and a built UI sitting on disk would
  // change it.
  const servingUi = !config.isTest && (await registerUiStatic(app));

  /**
   * Exactly one not-found handler, because Fastify permits exactly one and throws at boot
   * on a second. An unknown UI path gets the app shell so the single-page router can
   * handle it; `/api/*` always keeps its JSON 404, or a mistyped endpoint would return
   * HTML and the client's `res.json()` would throw something incomprehensible.
   */
  app.setNotFoundHandler((req, reply) => {
    if (servingUi && !req.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such route.' } });
  });

  return app;
}
