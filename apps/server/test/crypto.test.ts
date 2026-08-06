import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  decryptField,
  encryptField,
  isEncrypted,
} from '../src/infra/crypto/fieldCrypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

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
 * `isEncrypted` decides, for every string column of every table, whether the export tries to
 * decrypt it. A predicate that says yes to English therefore replaces the user's own writing
 * with an error message in the file they were handed as "everything this tool stored about
 * you" — and the export is the artifact they are invited to check before deleting the lot.
 */
describe('telling ciphertext apart from prose', () => {
  it('does not mistake an answer that happens to start "v1:" for ciphertext', () => {
    for (const s of [
      'v1: design, v2: build, v3: ship',
      'v1: gather requirements; v2: prototype; v3: ship it',
      'v1: I owned the parser. v2: I owned the UI. v3: I owned the deploy.',
      'v1: 9am standup, 10: design review, 2: ship',
      'v1:a:b:c',
      'v1::: ',
      'Normal answer with no colons at all',
    ]) {
      expect(isEncrypted(s), s).toBe(false);
    }
  });

  it('still recognises everything encryptField actually produces', () => {
    for (const s of ['', 'x', 'café ☕', 'a'.repeat(5_000)]) {
      expect(isEncrypted(encryptField(s, 'row-1')), JSON.stringify(s)).toBe(true);
    }
  });
});

/**
 * The credential store has to be reachable under the runtime the app SHIPS with.
 *
 * The module loaded its binding with a bare `require`, which does not exist in an ES module.
 * Both workspaces are `"type": "module"` and the server runs under tsx, so that threw on
 * every real start, was swallowed as "this platform has no credential store", and put the
 * master key in a plaintext keyfile on machines whose credential store worked perfectly. The
 * suite never noticed because Vitest hands modules a working `require`. So this runs the
 * module in a child process the way `npm start` does, and asserts on what came out.
 */
describe('master key custody, under the runtime the server actually uses', () => {
  function runUnderTsx(dataDir: string): { hasStore: boolean; bytes: number; keyfile: boolean } {
    const script = path.join(dataDir, 'probe.mjs');
    const keychain = pathToFileURL(path.join(SRC, 'infra/crypto/keychain.ts')).href;
    fs.writeFileSync(
      script,
      [
        `import fs from 'node:fs';`,
        `import path from 'node:path';`,
        `import { createRequire } from 'node:module';`,
        `let hasStore = false;`,
        `try {`,
        `  // Resolved from the module under test, not from this throwaway script's directory.`,
        `  const { Entry } = createRequire(${JSON.stringify(keychain)})('@napi-rs/keyring');`,
        `  new Entry('internship-applier', 'availability-probe').getPassword();`,
        `  hasStore = true;`,
        `} catch { hasStore = false; }`,
        `const m = await import(${JSON.stringify(keychain)});`,
        `const bytes = m.getMasterKey().length;`,
        `const keyfile = fs.existsSync(path.join(process.env.DATA_DIR, '.master.key'));`,
        `m.deleteMasterKey();`,
        `console.log('RESULT ' + JSON.stringify({ hasStore, bytes, keyfile }));`,
      ].join('\n'),
    );

    const run = spawnSync(process.execPath, ['--import', 'tsx', script], {
      encoding: 'utf8',
      env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test' },
    });
    const line = (run.stdout + run.stderr).split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, `child produced no result:\n${run.stdout}\n${run.stderr}`).toBeDefined();
    return JSON.parse(line!.slice('RESULT '.length)) as ReturnType<typeof runUnderTsx>;
  }

  it('uses the OS credential store, and writes no keyfile, when there is one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keychain-'));
    const out = runUnderTsx(dir);

    expect(out.bytes).toBe(32);
    if (!out.hasStore) return; // Headless Linux, CI without libsecret: the keyfile is correct.
    expect(out.keyfile, 'the master key was written to disk despite a working keychain').toBe(
      false,
    );
  });

  /**
   * The same mistake, one module over, would be just as invisible. `require` is not the only
   * CommonJS-only name — `__dirname` and `__filename` fail the same way, in the same silence,
   * under the same runtime that the test suite does not reproduce.
   */
  it('has no CommonJS-only globals anywhere in the server source', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.name.endsWith('.ts')) {
          const text = fs.readFileSync(full, 'utf8');
          for (const [i, line] of text.split('\n').entries()) {
            if (/(?<![.\w])(?:require\s*\(|__dirname|__filename)/.test(line)) {
              // `createRequire(import.meta.url)` is the ESM-safe form and is what to use.
              if (/createRequire\s*\(/.test(line)) continue;
              offenders.push(`${path.relative(SRC, full)}:${String(i + 1)}: ${line.trim()}`);
            }
          }
        }
      }
    };
    walk(SRC);
    expect(offenders, offenders.join('\n')).toEqual([]);
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
