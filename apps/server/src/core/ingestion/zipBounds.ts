/**
 * How big a zip says it will be, read without unpacking any of it.
 *
 * A DOCX is a zip, and a zip can be a decompression bomb. Measured against this app before
 * this file existed: a 944 KB .docx — comfortably inside the 12 MB upload cap — held a
 * `document.xml` that inflated to 394 MB. `extractText` produced a 400-million-character
 * string, took 15.7 seconds and 2.3 GB of RSS, and the server is single-threaded, so nothing
 * else it had been asked to do happened for those 15.7 seconds. A full 12 MB upload at the
 * same 428:1 ratio is about 5 GB, which is not a stall but a crash.
 *
 * The sizes are read out of the central directory, which every zip writes at the end of the
 * file precisely so a reader can learn what is inside without inflating it. That takes about
 * 10 ms and a megabyte.
 *
 * The numbers here are DECLARED, not proven — a hostile zip can understate them. That is why
 * this is one of two limits and not the only one: `extractText` also bounds the text that
 * comes out, which is what catches a header that lied. This one exists to refuse the bomb
 * before the memory is committed rather than after.
 *
 * Written by hand rather than with a zip library because the only library already in the
 * tree, jszip, arrives as a transitive dependency of mammoth and exposes the size on a
 * private `_data` field. Depending on either of those is depending on something that can be
 * taken away by a patch release of a package this file does not otherwise use.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;

/** The end-of-central-directory record is 22 bytes plus a comment of up to 64 KB. */
const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

/** A size field holding this means the real one is in a ZIP64 extra field. */
const ZIP64_SENTINEL = 0xffffffff;

export interface ZipBounds {
  /** What the archive says its contents come to, unpacked. */
  declaredBytes: number;
  entries: number;
  /**
   * Whether any size was too large for the classic 32-bit field.
   *
   * The real value then lives in a ZIP64 extra field, which this does not parse. A resume is
   * never a ZIP64 archive, so the honest answer is "over the limit" rather than a guess, and
   * callers should treat it as such.
   */
  zip64: boolean;
}

/** Reads the declared unpacked size of a zip, or null if this is not a readable zip. */
export function readZipBounds(buf: Buffer): ZipBounds | null {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd === -1) return null;

  const entries = buf.readUInt16LE(eocd + 10);
  const directorySize = buf.readUInt32LE(eocd + 12);
  const directoryOffset = buf.readUInt32LE(eocd + 16);

  if (directoryOffset === ZIP64_SENTINEL || directorySize === ZIP64_SENTINEL) {
    return { declaredBytes: Number.POSITIVE_INFINITY, entries, zip64: true };
  }
  if (directoryOffset + directorySize > buf.length) return null;

  let declaredBytes = 0;
  let zip64 = false;
  let at = directoryOffset;

  for (let i = 0; i < entries; i++) {
    // A truncated or lying directory is not something to guess around: the caller is deciding
    // whether to hand this to a parser, and "unreadable" is the answer that makes it refuse.
    if (at + 46 > buf.length) return null;
    if (buf.readUInt32LE(at) !== CENTRAL_FILE_SIGNATURE) return null;

    const uncompressed = buf.readUInt32LE(at + 24);
    if (uncompressed === ZIP64_SENTINEL) zip64 = true;
    else declaredBytes += uncompressed;

    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    at += 46 + nameLength + extraLength + commentLength;
  }

  return { declaredBytes: zip64 ? Number.POSITIVE_INFINITY : declaredBytes, entries, zip64 };
}

/**
 * Where the end-of-central-directory record starts, or -1.
 *
 * Searched backwards, because the record is last and its 22-byte fixed part is followed only
 * by a comment. Scanning forwards would find the signature inside compressed data first —
 * four arbitrary bytes turn up in a large enough file, and the whole read would be aimed at
 * the wrong offset.
 */
function findEndOfCentralDirectory(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
  for (let at = buf.length - EOCD_MIN_BYTES; at >= earliest; at--) {
    if (buf.readUInt32LE(at) !== EOCD_SIGNATURE) continue;
    // The comment length has to account for the rest of the file, or this is a coincidence
    // rather than the record.
    const commentLength = buf.readUInt16LE(at + 20);
    if (at + EOCD_MIN_BYTES + commentLength === buf.length) return at;
  }
  return -1;
}
