import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../../config';
import * as schema from './schema';

function ensureDataDir(): void {
  for (const dir of [config.paths.data, config.paths.resumes, config.paths.artifacts]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function openDatabase(file: string = config.paths.database) {
  if (file !== ':memory:') {
    ensureDataDir();
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
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
