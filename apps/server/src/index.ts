import { buildApp } from './app';
import { config } from './config';
import { runMigrations } from './infra/db/migrate';
import { logger } from './infra/logger';
import { closeAllRuns } from './core/filling/run';
import { uiIsBuilt } from './ui';

/** Long enough for a browser to close politely, short enough that Ctrl+C feels like Ctrl+C. */
const SHUTDOWN_TIMEOUT_MS = 5000;

async function main(): Promise<void> {
  runMigrations();

  const app = await buildApp();
  await app.listen({ host: config.server.host, port: config.server.port });

  const url = `http://${config.server.host}:${config.server.port}`;
  // The token is deliberately absent. Logging it defeats the redaction rule that strips
  // it from request headers, and it ends up in whatever collects stdout.
  logger.info({ url }, 'server listening (loopback only)');

  // Through the logger everything is one structured line among many, and the address is
  // the thing a person actually needs. Printed plainly, once, on the way up.
  if (uiIsBuilt()) {
    console.log(`\n  Internship applier is running at ${url}\n  Press Ctrl+C to stop.\n`);
  } else {
    console.log(
      `\n  API running at ${url}. The interface is not built yet.\n` +
        `  Run \`npm run build\` and restart, or use \`npm run dev\` while working on it.\n`,
    );
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    // A second Ctrl+C used to re-enter this and close everything twice. Fastify rejects
    // when an already-closing instance is closed again, and with no handler on the tail
    // of the chain that rejection killed the process instead of the clean exit below.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // Installing signal handlers removed Node's own terminate-on-signal, so a Chromium
    // that never finishes closing left Ctrl+C doing nothing at all and the server still
    // holding the port — the stale-server state explainStartupFailure apologises for.
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();

    // Fill runs hold a real Chromium window. Without this, stopping the server leaves
    // browsers scattered across the user's desktop with no way back to them.
    void closeAllRuns()
      .catch(() => undefined)
      .then(() => app.close())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'shutdown did not complete cleanly');
        process.exit(1);
      });
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
