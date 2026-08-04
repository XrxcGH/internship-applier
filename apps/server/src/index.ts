import { buildApp } from './app';
import { config } from './config';
import { runMigrations } from './infra/db/migrate';
import { logger } from './infra/logger';

async function main(): Promise<void> {
  runMigrations();

  const app = await buildApp();
  await app.listen({ host: config.server.host, port: config.server.port });

  logger.info(
    { url: `http://${config.server.host}:${config.server.port}`, token: config.appToken },
    'server listening (loopback only)',
  );

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * A stale dev server holding the port is the most common way this fails, and a raw
 * EADDRINUSE stack trace tells you nothing about how to fix it. Say what happened and
 * give the exact command for the platform in front of you.
 */
function explainStartupFailure(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code !== 'EADDRINUSE') return null;

  const { host, port } = config.server;
  const findAndKill =
    process.platform === 'win32'
      ? `  netstat -ano | findstr :${port}\n` +
        `  taskkill /PID <pid-from-the-last-column> /F\n\n` +
        `Or in one step:\n` +
        `  npx kill-port ${port}`
      : `  lsof -ti :${port} | xargs kill\n\n` + `Or:\n` + `  npx kill-port ${port}`;

  return (
    `Port ${port} is already in use, so the server could not start.\n\n` +
    `Something is already listening on ${host}:${port} — almost always a dev server from ` +
    `an earlier run that did not shut down cleanly.\n\n` +
    `Find and stop it:\n${findAndKill}\n\n` +
    `Then run npm run dev again. To use a different port instead, set SERVER_PORT in .env.`
  );
}

main().catch((err: unknown) => {
  const explanation = explainStartupFailure(err);
  if (explanation) {
    // Deliberately not through the logger: this is an instruction for a person, and
    // pino's structured output buries it.
    console.error(`\n${explanation}\n`);
    process.exit(1);
  }
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
