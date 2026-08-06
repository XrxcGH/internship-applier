/**
 * Take everything with you — docs/10 § User control.
 *
 * Two operations that only exist because the alternative is a tool that holds your data
 * hostage: one that hands all of it back, and one that destroys all of it.
 *
 * THE EXPORT IS DECRYPTED, deliberately. Field-level encryption protects the database file
 * at rest on this machine; it is not a reason to hand someone their own resume back as
 * ciphertext they have no key for. The export is written to a file the user chose, on
 * their own disk, and it is theirs.
 *
 * THE DELETE IS REAL. It removes rows, files, and the master key. There is no soft-delete
 * flag, no thirty-day grace period, and no copy kept anywhere. That is what "delete
 * everything" has to mean for the word to be worth anything, and it is why the confirmation
 * is a typed phrase rather than a button.
 */
import { rm } from 'node:fs/promises';
import { db, schema, sqlite } from '../../infra/db/client';
import { decryptField, isEncrypted } from '../../infra/crypto/fieldCrypto';
import { deleteMasterKey } from '../../infra/crypto/keychain';
import { logger } from '../../infra/logger';
import { config } from '../../config';

/** Every table, in a stable order so two exports of the same data diff cleanly. */
const TABLES = [
  'profile',
  'resumeDocument',
  'writingSample',
  'styleProfile',
  'answerTemplate',
  'source',
  'jobPosting',
  'jobPostingSource',
  'jobRequirement',
  'match',
  'decision',
  'application',
  'applicationAnswer',
  'applicationEvent',
  'task',
  'llmCall',
  'credentialRef',
  'filterPreset',
  'setting',
] as const;

/**
 * Decrypts any value that looks encrypted.
 *
 * Keyed on the row id, matching how it was written. A value that cannot be decrypted is
 * reported as such rather than dropped: an export that silently omits a field the user
 * knows they entered is worse than one that says a field could not be read.
 *
 * What replaces it says only what is known. It used to name a cause — "the master key has
 * changed since this was written" — which was a guess, and a wrong one every time this ran
 * over a value that was never encrypted in the first place.
 */
function decryptRow(row: Record<string, unknown>): Record<string, unknown> {
  const id = typeof row['id'] === 'string' ? row['id'] : '';
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string' && isEncrypted(value)) {
      try {
        out[key] = decryptField(value, id);
      } catch {
        out[key] = '[could not be decrypted with the master key this app is using]';
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface ExportBundle {
  exportedAt: string;
  app: string;
  note: string;
  counts: Record<string, number>;
  data: Record<string, Record<string, unknown>[]>;
}

export function buildExport(now = new Date()): ExportBundle {
  const data: Record<string, Record<string, unknown>[]> = {};
  const counts: Record<string, number> = {};

  for (const name of TABLES) {
    const table = schema[name];
    const rows = db.select().from(table).all() as Record<string, unknown>[];
    data[name] = rows.map(decryptRow);
    counts[name] = rows.length;
  }

  return {
    exportedAt: now.toISOString(),
    app: 'internship-applier',
    note:
      'Everything this tool stored about you, decrypted. Nothing here was ever sent ' +
      'anywhere. Keep it somewhere safe: it contains your resume, your contact details, ' +
      'and the answers you wrote.',
    counts,
    data,
  };
}

export function exportFilename(now = new Date()): string {
  return `internship-applier-export-${now.toISOString().slice(0, 10)}.json`;
}

// ────────────────────────────────────────────────────────────────── deletion

/**
 * The phrase that has to be typed.
 *
 * Not "yes" and not a checkbox. Something a person cannot produce by clicking through a
 * dialog they did not read, because this operation has no undo.
 */
export const DELETE_CONFIRMATION = 'delete everything';

export interface DeleteResult {
  deletedRows: Record<string, number>;
  deletedPaths: string[];
  failed: Array<{ path: string; reason: string }>;
}

/**
 * Destroys everything. Rows first, then files, then the key.
 *
 * Order matters if it is interrupted: rows are useless without the files they reference,
 * and both are unreadable without the key, so the last thing removed is the thing that
 * makes the rest recoverable. An interrupted run therefore leaves less readable data than
 * it started with, never more.
 */
export async function deleteEverything(): Promise<DeleteResult> {
  const deletedRows: Record<string, number> = {};

  // Child rows first: foreign keys are ON, and a parent delete would otherwise be refused.
  const ORDER = [...TABLES].reverse();
  for (const name of ORDER) {
    const table = schema[name];
    const before = db.select().from(table).all().length;
    db.delete(table).run();
    deletedRows[name] = before;
  }

  /**
   * Deleting rows is not the same as removing the data.
   *
   * SQLite marks freed pages reusable rather than zeroing them, and the write-ahead log
   * still holds the pre-delete images. A hex editor on app.db would have found the resume
   * text this function claims to have destroyed. Checkpointing folds the WAL back in and
   * truncates it; VACUUM rewrites the file from live content only, dropping the free
   * pages entirely.
   */
  try {
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.exec('VACUUM');
  } catch (err) {
    logger.warn({ err }, 'could not compact the database after deleting; rows are gone regardless');
  }

  const deletedPaths: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];

  const targets = [config.paths.resumes, config.paths.artifacts, config.paths.browserProfile];

  for (const target of targets) {
    try {
      await rm(target, { recursive: true, force: true });
      deletedPaths.push(target);
    } catch (err) {
      failed.push({ path: target, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // The key goes last, and it goes from the OS credential store as well as from disk.
  // Removing only the keyfile left the key intact in the keychain on every machine where
  // one is available, which is most of them.
  const key = deleteMasterKey();
  if (key.keyfile) deletedPaths.push(config.paths.masterKey);
  if (key.keychain === 'deleted') deletedPaths.push('OS credential store');
  // Only a store we could not reach, or one that refused, is a failure worth reporting. This
  // used to fire whenever the answer was anything but a clean delete, so every "delete
  // everything" — including the overwhelmingly common case where there was no keychain entry
  // in the first place — ended by telling the user to go and remove one by hand.
  if (key.keychain === 'unreachable' || key.keychain === 'failed') {
    failed.push({
      path: 'OS credential store',
      reason: 'The keychain entry could not be removed. Delete it by hand if it matters to you.',
    });
  }

  logger.warn(
    { rows: Object.values(deletedRows).reduce((a, b) => a + b, 0), paths: deletedPaths.length },
    'everything deleted at the user’s request',
  );

  return { deletedRows, deletedPaths, failed };
}

/** What the user is told before they type the phrase. */
export function describeWhatWillBeDeleted(): { label: string; count: number }[] {
  const bundle = buildExport();
  return [
    { label: 'Profile', count: bundle.counts['profile'] ?? 0 },
    { label: 'Resumes', count: bundle.counts['resumeDocument'] ?? 0 },
    { label: 'Writing samples', count: bundle.counts['writingSample'] ?? 0 },
    { label: 'Job postings', count: bundle.counts['jobPosting'] ?? 0 },
    { label: 'Applications', count: bundle.counts['application'] ?? 0 },
    { label: 'Answers you wrote', count: bundle.counts['applicationAnswer'] ?? 0 },
  ];
}
