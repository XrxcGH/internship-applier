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

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
