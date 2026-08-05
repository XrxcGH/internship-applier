import { pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../../config';
import { logger } from '../logger';
import { countTables, db } from './client';

export function runMigrations(): void {
  migrate(db, { migrationsFolder: config.paths.migrations });
  logger.info({ tables: countTables() }, 'migrations applied');
}

// Allow `npm run db:migrate` to invoke this directly. Building the URL by hand never
// matched on Windows — Node spells an absolute path 'file:///C:/…' with three slashes, not
// two — so the command printed nothing, exited 0, and applied no migrations at all.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runMigrations();
}
