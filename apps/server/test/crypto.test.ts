import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, isEncrypted } from '../src/infra/crypto/fieldCrypto';

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
