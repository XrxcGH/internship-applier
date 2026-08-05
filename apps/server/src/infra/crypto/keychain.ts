/**
 * Master key custody — see docs/10-security-privacy.md.
 *
 * The 256-bit field-encryption key lives in the OS credential store (Windows Credential
 * Manager / macOS Keychain / libsecret). It is never written to disk in plaintext and
 * never appears in a config file.
 *
 * If the OS store is unavailable — headless Linux without libsecret, CI, a locked
 * session — we fall back to a keyfile with owner-only permissions and log a loud warning.
 * Failing shut instead would make the app unusable in exactly the environments where
 * people run tests; failing silently would be worse. So: fall back, but be noisy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../../config';
import { logger } from '../logger';

const SERVICE = 'internship-applier';
const ACCOUNT = 'field-encryption-key';
const KEY_BYTES = 32;

let cached: Buffer | null = null;

interface Entry {
  getPassword(): string | null;
  setPassword(v: string): void;
  deletePassword?(): boolean;
}

function openEntry(): Entry | null {
  try {
    // Optional dependency: absent or unusable on some platforms.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Entry: KeyringEntry } = require('@napi-rs/keyring') as {
      Entry: new (service: string, account: string) => Entry;
    };
    return new KeyringEntry(SERVICE, ACCOUNT);
  } catch {
    return null;
  }
}

function keyfilePath(): string {
  return config.paths.masterKey;
}

/**
 * The key an earlier fallback run left on disk, if there is a usable one.
 *
 * Deliberately narrower than readFallbackKey: a keyfile of the wrong length is reported as
 * absent rather than adopted, so a damaged file never gets copied into the credential store
 * and made authoritative.
 */
function existingFallbackKey(): Buffer | null {
  const file = keyfilePath();
  if (!fs.existsSync(file)) return null;
  try {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    return key.length === KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

function readFallbackKey(): Buffer {
  const file = keyfilePath();
  if (fs.existsSync(file)) {
    return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  }
  const key = randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on Windows; ACLs are applied at the data/ level */
  }
  return key;
}

/**
 * The one error here that must never be swallowed.
 *
 * Distinct from "the credential store is unavailable", which is survivable and falls back
 * to a keyfile. A key of the wrong length means something wrote over ours, and generating
 * a replacement would abandon every field already encrypted under the real one.
 */
export class CorruptMasterKeyError extends Error {
  constructor() {
    super(
      'The master key in the OS credential store is not a valid key. This tool will not ' +
        'generate a replacement, because doing so would make everything already stored ' +
        'unreadable. Restore the credential-store entry, or delete your data and start again.',
    );
    this.name = 'CorruptMasterKeyError';
  }
}

export function getMasterKey(): Buffer {
  if (cached) return cached;

  const entry = openEntry();
  if (entry) {
    try {
      const existing = entry.getPassword();
      if (existing) {
        const key = Buffer.from(existing, 'base64');
        if (key.length === KEY_BYTES) {
          cached = key;
          return cached;
        }
        logger.error('master key in the OS keychain has the wrong length; refusing to use it');
        throw new CorruptMasterKeyError();
      }
      /**
       * An empty credential store is not necessarily a first run.
       *
       * The fallback keyfile is a supported path — headless, CI, a locked session — so a
       * profile can already be encrypted under it by the time the store becomes usable.
       * Minting a fresh key here regardless meant name, email, phone, date of birth,
       * address and resume text all stopped decrypting the moment the keychain started
       * working, with nothing but an authentication failure to explain it. The keyfile is
       * left where it is: the credential store may not persist what we just wrote, and one
       * copy of the key is worth more than a tidy data directory. "Delete everything"
       * still removes both.
       */
      const adopted = existingFallbackKey();
      const key = adopted ?? randomBytes(KEY_BYTES);
      entry.setPassword(key.toString('base64'));
      logger.info(
        adopted
          ? 'adopted the existing keyfile as the field-encryption key in the OS credential store'
          : 'generated a new field-encryption key in the OS credential store',
      );
      cached = key;
      return cached;
    } catch (err) {
      /**
       * A corrupt key is not an unavailable store, and it must not fall through.
       *
       * The throw above was inside this try, so "refusing to use it" was followed
       * immediately by minting a fresh random key in a keyfile — silently re-keying the
       * database. Every field written before that point (name, email, phone, date of
       * birth, address, resume text) becomes undecryptable while new writes succeed, and
       * nothing tells the user their data just became unreadable. Failing shut is the
       * only honest option: the old key may still be recoverable, and a mixed-key
       * database is not.
       */
      if (err instanceof CorruptMasterKeyError) throw err;
      logger.warn({ err }, 'OS credential store unavailable; falling back to a keyfile');
    }
  }

  logger.warn(
    { file: keyfilePath() },
    'USING A KEYFILE FOR FIELD ENCRYPTION. The OS credential store was unavailable, so the ' +
      'master key sits on disk under data/ with owner-only permissions. Anyone who can read ' +
      'that directory can decrypt your profile.',
  );
  cached = readFallbackKey();
  return cached;
}

/**
 * Destroys the master key everywhere it lives.
 *
 * "Delete everything" removed the keyfile but left the OS credential store untouched, so
 * on a machine where the keychain was available — the normal case — the key survived a
 * wipe that promised to take it. Everything encrypted with it stayed decryptable by the
 * next install.
 *
 * Best effort by design: a keychain that refuses is reported, not thrown, because the rest
 * of the deletion still needs to finish.
 */
export function deleteMasterKey(): { keychain: boolean; keyfile: boolean } {
  let keychain = false;
  try {
    const entry = openEntry();
    if (entry?.deletePassword) keychain = entry.deletePassword();
  } catch {
    keychain = false;
  }

  let keyfile = false;
  try {
    const file = keyfilePath();
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      keyfile = true;
    }
  } catch {
    keyfile = false;
  }

  cached = null;
  return { keychain, keyfile };
}
