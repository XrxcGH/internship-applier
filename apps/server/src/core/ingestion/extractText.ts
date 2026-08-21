/**
 * Local text extraction for non-PDF formats. PDFs deliberately skip this and go to
 * Claude as bytes — see docs/02 § Notable stack decisions.
 */
import { readFile } from 'node:fs/promises';
import { readZipBounds } from './zipBounds';

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

/**
 * What a .docx is allowed to weigh once unpacked.
 *
 * The 12 MB upload cap bounds the file, not the document: a zip can hold far more than it
 * takes up. Measured on this app, a 944 KB .docx inflated to 394 MB, and reading it cost
 * 15.7 seconds and 2.3 GB of RSS on a server that does one thing at a time.
 *
 * 64 MB is far above any real resume. The text of one runs to a few thousand characters, and
 * embedded photographs are already-compressed JPEG or PNG, so they do not inflate on the way
 * out. Anything reaching this number is not a document somebody wrote.
 */
const MAX_DOCX_UNPACKED_BYTES = 64 * 1024 * 1024;

/**
 * What any document is allowed to yield in text.
 *
 * The zip's declared sizes are what it SAYS, and a hostile archive can understate them, so
 * this is the limit that does not depend on being told the truth. It also covers the formats
 * that are not zips: a 12 MB .txt is bounded by the upload cap and by nothing else.
 *
 * 4 million characters is roughly a thousand pages. A fifty-page academic CV — the longest
 * thing anyone legitimately uploads here — is around 150,000.
 */
const MAX_TEXT_CHARS = 4_000_000;

/** Returns null for PDFs — they are passed to the model as bytes, not text. */
export async function extractText(path: string, mime: string): Promise<string | null> {
  if (mime === 'application/pdf') return null;

  if (mime.includes('wordprocessingml')) {
    const bytes = await readFile(path);
    const bounds = readZipBounds(bytes);

    // An unreadable directory is refused rather than passed along. The only caller hands this
    // a file it has already accepted as a .docx, so "this is not a zip" means the type check
    // upstream was fooled, and mammoth should not be the thing that finds that out.
    if (!bounds) {
      throw new Error('This .docx could not be read — its archive directory is missing.');
    }
    if (bounds.declaredBytes > MAX_DOCX_UNPACKED_BYTES) {
      throw new Error(
        `This .docx unpacks to ${Math.round(bounds.declaredBytes / 1024 / 1024)}MB, ` +
          `over the ${MAX_DOCX_UNPACKED_BYTES / 1024 / 1024}MB limit. ` +
          'Export it again from your word processor, or save it as a PDF.',
      );
    }

    /**
     * An archive that claims to unpack to less than it packs to is lying about one of the two.
     *
     * The declared unpacked size is the archive's own word, and a bomb can simply understate
     * it: take a real 296MB one, write 1234 into every uncompressed-size field, and the total
     * above reads as nothing at all. Measured — that file walked past the limit, and jszip
     * caught the inconsistency itself, but only after inflating 317MB and spending 879ms doing
     * it, then reporting "Bug : uncompressed data size mismatch" to the student.
     *
     * The compressed size sits in the same header and cannot be understated the same way,
     * because it is what tells a reader how many bytes to inflate. Deflate does not
     * meaningfully expand data, so a total that packs to more than it claims to unpack to is
     * not a document. The margin is for the handful of bytes deflate adds to incompressible
     * content, which is the only honest way this comparison can come out close.
     */
    if (bounds.declaredBytes * 1.05 + 1024 < bounds.compressedBytes) {
      throw new Error(
        'This .docx says it holds less than it takes up, so it was not opened. Export it ' +
          'again from your word processor, or save it as a PDF.',
      );
    }

    const mammoth = await import('mammoth');
    // Handed the bytes already in memory rather than the path, so the file is read once.
    const { value } = await mammoth
      .extractRawText({ buffer: bytes })
      // mammoth's own failures are written for whoever is debugging mammoth — the one this
      // raises for a size mismatch begins with the word "Bug". The student did not write this
      // file and cannot act on that, so it is said again in terms of what they can do.
      .catch(() => {
        throw new Error(
          'This .docx could not be opened — its contents do not match what the file says ' +
            'they are. Export it again from your word processor, or save it as a PDF.',
        );
      });
    return normalize(bounded(value));
  }

  if (mime.startsWith('text/')) {
    return normalize(bounded(await readFile(path, 'utf8')));
  }

  throw new Error(`Unsupported document type: ${mime}`);
}

/**
 * The extracted text, or a refusal — never a silent truncation.
 *
 * Cutting it short and carrying on would send half a document to the model and produce a
 * profile built from it, with nothing anywhere saying a word was missing. That is the one
 * outcome this repo does not accept: a partial read reported as a complete one.
 */
function bounded(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  throw new Error(
    `This document holds ${text.length.toLocaleString('en-US')} characters, far more than a ` +
      'resume. Upload the resume itself rather than an archive or an export of one.',
  );
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
