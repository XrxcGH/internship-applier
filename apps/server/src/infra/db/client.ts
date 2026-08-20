import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../../config';
import * as schema from './schema';

/**
 * Narrows a path to its owner, where the platform has such a concept.
 *
 * chmod is a no-op on Windows for anything but the read-only bit, and a throw here would take
 * down a process over a permission this platform does not model — so a failure is logged and
 * swallowed rather than raised. On Windows the file inherits the profile directory's ACL,
 * which for a per-user data directory is the same protection by a different mechanism.
 */
function restrictToOwner(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Best effort by design. See above.
  }
}

function ensureDataDir(): void {
  for (const dir of [config.paths.data, config.paths.resumes, config.paths.artifacts]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `mode` on mkdirSync is masked by the process umask and ignored entirely for a directory
    // that already exists, which is every run after the first.
    restrictToOwner(dir, 0o700);
  }
}

export function openDatabase(file: string = config.paths.database) {
  if (file !== ':memory:') {
    ensureDataDir();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  /**
   * The database is owner-only, like the key file and the stored resumes already were.
   *
   * better-sqlite3 creates it with the default mode — 0o644 under a typical umask — so on a
   * shared machine every other account could read it. Six profile columns are encrypted, but
   * the file also holds every drafted answer in `draft_text` and `final_text`, every writing
   * sample, every posting, and the whole application history, none of which is: a student's
   * essay about why they want a job says more about them than their name does, and the name
   * was the part behind the cipher.
   *
   * WAL means two more files carrying the same bytes. `-wal` holds committed pages not yet
   * checkpointed and `-shm` its index, so protecting only the main file protects the tail of
   * the data and not the most recent writes. They may not exist yet at this point, which is
   * what `restrictToOwner` swallowing is for.
   */
  if (file !== ':memory:') {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) restrictToOwner(f, 0o600);
  }

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

const instance = openDatabase();

export const sqlite = instance.sqlite;
export const db = instance.db;
export { schema };

export function countTables(): number {
  const row = sqlite
    .prepare(
      `SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    )
    .get() as { n: number };
  return row.n;
}

export function isConnected(): boolean {
  try {
    sqlite.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}
