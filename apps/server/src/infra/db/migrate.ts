import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../../config';
import { logger } from '../logger';
import { countTables, db } from './client';

export function runMigrations(): void {
  migrate(db, { migrationsFolder: config.paths.migrations });
  logger.info({ tables: countTables() }, 'migrations applied');
}

// Allow `npm run db:migrate` to invoke this directly.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runMigrations();
}
