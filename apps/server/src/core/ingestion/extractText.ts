/**
 * Local text extraction for non-PDF formats. PDFs deliberately skip this and go to
 * Claude as bytes — see docs/02 § Notable stack decisions.
 */
import { readFile } from 'node:fs/promises';

/**
 * What can actually be read.
 *
 * Legacy .doc used to be in here. It should not have been: a real .doc is an OLE compound
 * file, mammoth reads OOXML zips only, and the failure surfaced two steps later as a 502
 * during extraction with a message about no text being readable. Accepting an upload the
 * app cannot use is worse than declining it, because the user only finds out after
 * choosing the file, waiting, and being told something that does not explain why.
 */
export const SUPPORTED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);

export function mimeFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

/**
 * The name a resume is stored under, built from its id and its validated type — and from
 * nothing the student's file arrived carrying.
 *
 * It takes no filename ON PURPOSE. A helper that accepted one could have it appended again
 * by the next person to touch the route, which is exactly the bug below.
 *
 * The upload route used to build the stored filename with `path.extname(file.filename)`,
 * which puts a user-supplied string into a filesystem path. It cannot contain a separator —
 * `extname` reads the last segment only — so this was never a traversal, but on Windows it
 * could still carry a colon: uploading `resume.txt:evil` stored the resume in an NTFS
 * ALTERNATE DATA STREAM, and the directory then listed a 0-byte `<id>.txt`. The app kept
 * working, because everything downstream reads back the same full string, so the resume
 * would simply have been missing from any backup, sync or copy the student ever made of that
 * folder. A 300-character extension was a plainer failure: the write threw ENOENT and the
 * upload 500'd.
 *
 * The MIME is already validated against `SUPPORTED_MIME` before this is called, so the
 * result is one of four fixed strings. The name the student chose is kept — it is stored in
 * `resume_document.filename` and is what the UI shows them.
 */
export function storedResumeFilename(id: string, mime: string): string {
  return `${id}${extensionForMime(mime)}`;
}

export function extensionForMime(mime: string): string {
  switch (mime) {
    case 'application/pdf':
      return '.pdf';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return '.docx';
    case 'text/markdown':
      return '.md';
    case 'text/plain':
      return '.txt';
    default:
      return '';
  }
}

/** Returns null for PDFs — they are passed to the model as bytes, not text. */
export async function extractText(path: string, mime: string): Promise<string | null> {
  if (mime === 'application/pdf') return null;

  if (mime.includes('wordprocessingml')) {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ path });
    return normalize(value);
  }

  if (mime.startsWith('text/')) {
    return normalize(await readFile(path, 'utf8'));
  }

  throw new Error(`Unsupported document type: ${mime}`);
}

/** U+00A0 non-breaking space — pervasive in Word exports, and it defeats naive \s matching. */
const NBSP = new RegExp(String.fromCharCode(0x00a0), 'g');

function normalize(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(NBSP, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
