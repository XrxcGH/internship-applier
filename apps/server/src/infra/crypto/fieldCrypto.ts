/**
 * Field-level encryption for PII — see docs/10-security-privacy.md.
 *
 * AES-256-GCM. Every value gets a fresh 96-bit nonce, and the row id is bound in as
 * additional authenticated data so a ciphertext cannot be moved between rows or tables
 * and still decrypt.
 *
 * Chosen over whole-database encryption (SQLCipher) so that non-sensitive columns stay
 * indexable and the schema makes it explicit which fields are sensitive. The tradeoff —
 * encrypted fields can't be searched — is fine: nothing needs to query by name, phone,
 * or date of birth.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { getMasterKey } from './keychain';

const ALGO = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'v1';

/** `v1:<nonce b64url>:<tag b64url>:<ciphertext b64url>` */
export function encryptField(plaintext: string, aad: string): string {
  const key = getMasterKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, b64(nonce), b64(tag), b64(ct)].join(':');
}

export function decryptField(encoded: string, aad: string): string {
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('ciphertext is not in the expected v1 format');
  }
  const [, nonceB64, tagB64, ctB64] = parts as [string, string, string, string];
  const key = getMasterKey();
  const decipher = createDecipheriv(ALGO, key, unb64(nonceB64));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  const tag = unb64(tagB64);
  if (tag.length !== TAG_BYTES) throw new Error('auth tag has the wrong length');
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(unb64(ctB64)), decipher.final()]).toString('utf8');
}

/** Encrypted-at-rest values are opaque; this is only for round-trip assertions. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(`${PREFIX}:`) && value.split(':').length === 4;
}

/**
 * Compares two secrets without letting the comparison time say how close a guess was.
 *
 * `a === b` on a string stops at the first byte that differs, so a wrong token that shares
 * its first eight characters takes measurably longer to reject than one that differs
 * immediately. Anything that can time the answer — a local script hammering the API, a
 * page measuring its own failed fetches — can recover a secret a character at a time from
 * that difference instead of having to guess all thirty-six at once.
 *
 * `timingSafeEqual` throws on unequal lengths rather than returning false, which would
 * hand back the same leak through an exception, so a length mismatch is compared against
 * itself and reported false. That still reveals the length, which is not a secret here.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

const b64 = (b: Buffer): string => b.toString('base64url');
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64url');
