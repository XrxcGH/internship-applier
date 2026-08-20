import { describe, expect, it } from 'vitest';
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
