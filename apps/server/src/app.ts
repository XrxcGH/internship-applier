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
  /** Disable the X-App-Token check. Test-only. */
  skipAuth?: boolean;
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

  // Loopback-only guard. Belt-and-braces alongside binding to 127.0.0.1.
  app.addHook('onRequest', async (req, reply) => {
    const ip = req.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      return reply.code(403).send({
        error: { code: 'INTERNAL', message: 'This API accepts loopback connections only.' },
      });
    }
    if (opts.skipAuth || config.isTest) return;

    // The token guards the API, not the interface. When this server also serves the built
    // UI, requiring a token for `/index.html` would mean the browser could never load the
    // page that fetches the token. The bundle carries no user data; everything that does
    // goes through /api, which stays protected.
    if (!req.url.startsWith('/api/')) return;

    // Exempt: the liveness probe and the bootstrap that hands the UI its token.
    //
    // What this exemption is and is not worth. CORS keeps a stray page in another browser
    // tab from reading /api/session, which is the case the token was added for. It does
    // nothing to a local script: curl can fetch the token here and then call every guarded
    // route. That is not a hole this exemption opened — a process running as this user can
    // read data/app.db and the keyfile directly, so the token was never a boundary against
    // it. docs/10 says the same thing rather than the stronger claim it used to make.
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
