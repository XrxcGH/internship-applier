import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { runMigrations } from '../src/infra/db/migrate';
import path from 'node:path';
import {
  extensionForMime,
  storedResumeFilename,
  SUPPORTED_MIME,
} from '../src/core/ingestion/extractText';

/**
 * What a resume gets stored as on disk.
 *
 * The upload route built that name with `path.extname(file.filename)`, which puts a string
 * the student's file arrived with straight into a filesystem path. `extname` reads the last
 * segment only, so it can never contain a separator and this was never a traversal — but on
 * Windows it could carry a colon. Verified before the fix: uploading `resume.txt:evil` wrote
 * the resume into an NTFS alternate data stream, and the folder then listed a 0-byte
 * `<id>.txt`. Nothing appeared broken, because every reader downstream used the same full
 * string; the resume was simply absent from any copy of that folder the student ever made.
 * A 300-character extension failed louder — the write threw ENOENT and the upload 500'd.
 */
describe('the name a resume is stored under', () => {
  it('is one of four, whatever the file was called', () => {
    for (const mime of SUPPORTED_MIME) {
      expect(['.pdf', '.docx', '.md', '.txt']).toContain(extensionForMime(mime));
    }
  });

  it('carries nothing a filename could have smuggled into the path', () => {
    const id = '01JABCDEFGHJKMNPQRSTVWXYZ';

    // Each of these is a name a browser will send, paired with what `path.extname` hands back
    // for it — the string the old code appended to the path.
    const hostile = [
      'resume.txt:evil', // an NTFS alternate data stream
      `resume.${'y'.repeat(300)}`, // ENOENT on write
      'resume.pdf ', // trailing space: Windows strips it, so the path moves
      'resume..',
      'resume.pdf.txt',
      String.raw`resume.a\b`,
      'resume.a/b',
    ];

    // What the old line would have produced for each, against what the new one does. The
    // stored names collapse to a single value: the name the file arrived under changes
    // nothing about where it lands.
    // `path.win32` explicitly, not the ambient `path`: a backslash is a separator on Windows
    // and an ordinary character elsewhere, so the plain call gives different answers on the
    // machine this runs on and on CI. The bug being pinned is a Windows one; name it.
    const wouldHaveBeen = new Set(hostile.map((f) => `${id}${path.win32.extname(f)}`));
    const areNow = new Set(hostile.map(() => storedResumeFilename(id, 'application/pdf')));

    // Six, not seven: the two names carrying a separator both give back an empty extension,
    // because `extname` reads the last path segment and a separator starts a new one. That is
    // the reason this was a Windows-stream and path-length bug rather than a traversal.
    expect(wouldHaveBeen.size).toBe(6);
    expect(path.win32.extname(String.raw`resume.a\b`)).toBe('');
    expect([...areNow]).toEqual([`${id}.pdf`]);
    expect(path.win32.basename(`${id}.pdf`)).toBe(`${id}.pdf`);
    expect(path.posix.basename(`${id}.pdf`)).toBe(`${id}.pdf`);

    // Structural, not incidental: there is no filename parameter for anyone to pass one to.
    expect(storedResumeFilename).toHaveLength(2);

    // If either of these ever stops holding, the names above are no longer hostile and this
    // test is guarding nothing — read it again rather than deleting it.
    expect(path.win32.extname('resume.txt:evil')).toBe('.txt:evil');
    expect(path.win32.extname(`resume.${'y'.repeat(300)}`)).toHaveLength(301);
  });

  it('gives an unsupported type no extension rather than a guessed one', () => {
    expect(extensionForMime('application/octet-stream')).toBe('');
    expect(extensionForMime('text/html')).toBe('');
  });
});

/**
 * The same property, asked of the ROUTE — which is where the bug actually was.
 *
 * Everything above exercises `storedResumeFilename`, and the fix was not in
 * `storedResumeFilename`: it was in `routes/resumes.ts`, which used to build the path with
 * `path.extname(file.filename)`. Reverting that one line to its vulnerable form and running
 * the entire server suite left all 1,919 tests green. A helper can be perfect while nothing
 * calls it.
 *
 * So this drives a real multipart upload through the real route and looks at what landed on
 * disk. `vitest.setup.ts` points DATA_DIR at a fresh temp directory per test file, so the
 * files written here are disposable.
 */
describe('what POST /api/resumes actually writes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    runMigrations();
    app = await buildApp({ skipAuth: true });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const upload = async (filename: string, body: string) => {
    const boundary = '----iaStoredNameTest';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          'Content-Type: text/plain\r\n\r\n',
      ),
      Buffer.from(body, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST',
      url: '/api/resumes',
      headers: {
        host: '127.0.0.1:8787',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
  };

  const storedNames = (): string[] =>
    existsSync(config.paths.resumes) ? readdirSync(config.paths.resumes) : [];

  it('names the file by its type, whatever the upload was called', async () => {
    const before = storedNames().length;
    const res = await upload('resume.txt:evil', 'Eric Dean — Half Moon Bay');
    expect(res.statusCode).toBe(201);

    const written = storedNames();
    expect(written).toHaveLength(before + 1);
    // A ULID and one of the four extensions, and nothing else. On Windows the old code put
    // this content into an NTFS alternate data stream and left a 0-byte `<id>.txt` here.
    for (const name of written) {
      expect(name, name).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.(pdf|docx|md|txt)$/);
      expect(name).not.toContain(':');
      expect(statSync(path.join(config.paths.resumes, name)).size).toBeGreaterThan(0);
    }
  });

  it('keeps the name the student chose, because that is what they will recognise', async () => {
    // The stored path is not the filename: the original is kept in the row and is what the
    // interface shows. Refusing the upload, or renaming it in the UI, would be a worse answer
    // than the bug.
    const res = await upload('My CV (final) 2027.txt', 'Eric Dean');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ filename: 'My CV (final) 2027.txt' });
  });

  it('is not fooled by an extension long enough to break the write', async () => {
    // 300 characters of extension made the old code throw ENOENT and 500 the upload.
    const res = await upload(`resume.${'y'.repeat(300)}`, 'Eric Dean');
    // The type is decided by the MIME, so this is an ordinary .txt and simply works.
    expect(res.statusCode).toBe(201);
    for (const name of storedNames()) expect(name.length).toBeLessThan(64);
  });
});
