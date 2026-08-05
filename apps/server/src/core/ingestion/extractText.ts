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
