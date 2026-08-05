import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  decryptField,
  encryptField,
  isEncrypted,
} from '../src/infra/crypto/fieldCrypto';

describe('field encryption', () => {
  it('round-trips', () => {
    const ct = encryptField('555-0100', 'row-1');
    expect(decryptField(ct, 'row-1')).toBe('555-0100');
  });

  it('produces opaque ciphertext that does not leak the plaintext', () => {
    const ct = encryptField('Eric Dean', 'row-1');
    expect(isEncrypted(ct)).toBe(true);
    expect(ct).not.toContain('Eric');
    expect(ct).not.toContain('Dean');
  });

  it('uses a fresh nonce, so the same plaintext encrypts differently each time', () => {
    const a = encryptField('same', 'row-1');
    const b = encryptField('same', 'row-1');
    expect(a).not.toBe(b);
    expect(decryptField(a, 'row-1')).toBe(decryptField(b, 'row-1'));
  });

  /**
   * The row id is bound in as AAD specifically so a ciphertext can't be lifted from one
   * row and pasted into another — that would otherwise be a silent way to move someone
   * else's data around, or to swap a field between records.
   */
  it('refuses to decrypt under a different row id', () => {
    const ct = encryptField('secret', 'row-1');
    expect(() => decryptField(ct, 'row-2')).toThrow();
  });

  it('detects tampering with the ciphertext', () => {
    const ct = encryptField('secret', 'row-1');
    const parts = ct.split(':');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    parts[3] = flipped.toString('base64url');
    expect(() => decryptField(parts.join(':'), 'row-1')).toThrow();
  });

  it('rejects malformed input instead of returning garbage', () => {
    expect(() => decryptField('not-encrypted', 'row-1')).toThrow(/v1 format/);
    expect(() => decryptField('v1:a:b', 'row-1')).toThrow(/v1 format/);
  });

  it('handles unicode and empty strings', () => {
    for (const s of ['', 'café ☕', '日本語', 'a'.repeat(10_000)]) {
      expect(decryptField(encryptField(s, 'r'), 'r')).toBe(s);
    }
  });
});

/**
 * The app-token check compares a secret, and `!==` on strings returns as soon as it finds a
 * differing byte. The timing that leaks is small and the attacker has to already be on this
 * machine, so this is not the wall the app leans on — but a comparison helper that exists
 * and is not used by the one comparison that wants it is worse than not having one.
 */
describe('constant-time comparison', () => {
  it('is true only for an exact match', () => {
    expect(constantTimeEquals('abc123', 'abc123')).toBe(true);
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('is false for a value differing only in its last character', () => {
    expect(constantTimeEquals('abc123', 'abc124')).toBe(false);
  });

  it('is false for different lengths, without throwing', () => {
    expect(constantTimeEquals('abc', 'abcdef')).toBe(false);
    expect(constantTimeEquals('abcdef', 'abc')).toBe(false);
    expect(constantTimeEquals('', 'a')).toBe(false);
  });

  it('handles multi-byte characters by comparing bytes, not code units', () => {
    expect(constantTimeEquals('café', 'café')).toBe(true);
    expect(constantTimeEquals('café', 'cafe')).toBe(false);
  });
});
