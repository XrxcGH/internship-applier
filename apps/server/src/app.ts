import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from './config';
import { logger } from './infra/logger';
import { healthRoutes } from './routes/health';
import { profileRoutes } from './routes/profile';
import { resumeRoutes } from './routes/resumes';
import { discoveryRoutes } from './routes/discovery';
import { matchRoutes } from './routes/matches';
import { eventRoutes } from './routes/events';
import { writingRoutes } from './routes/writing';
import { answerRoutes } from './routes/answers';

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
    origin: [config.web.origin],
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
    // Exempt: the liveness probe and the bootstrap that hands the UI its token.
    // Both are still loopback-only and CORS-locked to the app's own origin, so a stray
    // page in another tab cannot read either response.
    if (req.url === '/api/health' || req.url === '/api/session') return;
    if (req.headers['x-app-token'] !== config.appToken) {
      return reply.code(401).send({
        error: { code: 'INTERNAL', message: 'Missing or invalid X-App-Token.' },
      });
    }
  });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    logger.error({ err }, 'unhandled request error');
    void reply.code(err.statusCode ?? 500).send({
      error: { code: 'INTERNAL', message: err.message },
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such route.' } });
  });

  await app.register(healthRoutes);
  await app.register(profileRoutes);
  await app.register(resumeRoutes);
  await app.register(discoveryRoutes);
  await app.register(matchRoutes);
  await app.register(eventRoutes);
  await app.register(writingRoutes);
  await app.register(answerRoutes);

  return app;
}
