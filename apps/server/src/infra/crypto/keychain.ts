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
  return path.join(config.paths.data, '.master.key');
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
        throw new Error('corrupt master key in OS keychain');
      }
      const key = randomBytes(KEY_BYTES);
      entry.setPassword(key.toString('base64'));
      logger.info('generated a new field-encryption key in the OS credential store');
      cached = key;
      return cached;
    } catch (err) {
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

/** Test-only: drop the cached key so a fresh one is read. */
export function resetMasterKeyCache(): void {
  cached = null;
}
