import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractText } from '../src/core/ingestion/extractText';
import { readZipBounds } from '../src/core/ingestion/zipBounds';
import { makeDocx, makeZip } from './support/minizip';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Reading a document the app has accepted for upload.
 *
 * There was no coverage of this at all, and it turned out to be where a 944 KB file could
 * take the server down: a .docx is a zip, the 12 MB upload cap bounds the FILE and not the
 * document, and a zip can promise far more than it weighs. Measured before the limits below
 * existed — 944 KB in, a 400-million-character string out, 15.7 seconds and 2.3 GB of RSS on
 * a server that does one thing at a time. A full 12 MB upload at the same ratio is about
 * 5 GB, which is a crash rather than a stall.
 */
describe('reading an uploaded document', () => {
  let dir: string;
  const at = (name: string): string => path.join(dir, name);

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ia-extract-'));
    // `extractText` imports mammoth lazily, so whichever docx case ran first paid for loading
    // it and intermittently blew the 5s default while the rest of the suite was competing for
    // the machine. Paid here instead, where the budget is explicit.
    await import('mammoth');
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads an ordinary .docx', async () => {
    await writeFile(at('ok.docx'), makeDocx('Eric Dean — Half Moon Bay, CA'));
    expect(await extractText(at('ok.docx'), DOCX)).toBe('Eric Dean — Half Moon Bay, CA');
  });

  it('reads a .txt', async () => {
    await writeFile(at('ok.txt'), 'Half Moon Bay, CA\n\n\n\nLos Angeles, CA  \n');
    expect(await extractText(at('ok.txt'), 'text/plain')).toBe(
      'Half Moon Bay, CA\n\nLos Angeles, CA',
    );
  });

  it('hands a PDF back unread, because those go to the model as bytes', async () => {
    await writeFile(at('cv.pdf'), '%PDF-1.7 whatever');
    expect(await extractText(at('cv.pdf'), 'application/pdf')).toBeNull();
  });

  it('refuses a .docx that promises more than it weighs, before unpacking any of it', async () => {
    // 400 MB declared, a few hundred bytes on disk. This is the shape of the real bomb: the
    // header is what a reader trusts, so the header is what has to be checked first.
    const bomb = makeDocx('boom', 400 * 1024 * 1024);
    expect(bomb.byteLength).toBeLessThan(4096);
    await writeFile(at('bomb.docx'), bomb);

    const started = Date.now();
    await expect(extractText(at('bomb.docx'), DOCX)).rejects.toThrow(/unpacks to 400MB/);
    // The refusal has to come from the header. Unpacking first and complaining afterwards is
    // the failure being prevented, not a slower version of the fix.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('says what to do about it, rather than only that it refused', async () => {
    await writeFile(at('bomb2.docx'), makeDocx('boom', 400 * 1024 * 1024));
    await expect(extractText(at('bomb2.docx'), DOCX)).rejects.toThrow(/save it as a PDF/);
  });

  it('refuses a .docx that claims to hold less than it takes up', async () => {
    // The declared unpacked size is the archive's own word and a bomb can simply understate it.
    // Take a real 296MB one, write 1234 into every uncompressed-size field, and the declared
    // total reads as nothing at all — it walked straight past the size limit. jszip caught the
    // inconsistency itself, but only after inflating 317MB over 879ms, and then told the
    // student "Bug : uncompressed data size mismatch".
    //
    // The compressed size is in the same header and cannot be understated the same way: it is
    // what tells a reader how many bytes to inflate. Deflate does not meaningfully expand data.
    const content = 'x'.repeat(200_000);
    await writeFile(
      at('liar.docx'),
      makeZip([{ name: 'word/document.xml', content, declaredUnpackedBytes: 10 }]),
    );

    const started = Date.now();
    await expect(extractText(at('liar.docx'), DOCX)).rejects.toThrow(/holds less than it takes up/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('says something the student can act on when the archive is inconsistent', async () => {
    const content = 'x'.repeat(200_000);
    await writeFile(
      at('liar2.docx'),
      makeZip([{ name: 'word/document.xml', content, declaredUnpackedBytes: 10 }]),
    );
    await expect(extractText(at('liar2.docx'), DOCX)).rejects.toThrow(/save it as a PDF/);
    // Never mammoth's own wording, which begins with the word "Bug".
    await expect(extractText(at('liar2.docx'), DOCX)).rejects.not.toThrow(/^Bug/);
  });

  it('does not mistake an ordinary uncompressed archive for a liar', async () => {
    // `makeZip` STORES every entry, so declared and compressed are equal — the closest an
    // honest archive comes to the shape being refused above. It must still be read.
    await writeFile(at('stored.docx'), makeDocx('Eric Dean'));
    expect(await extractText(at('stored.docx'), DOCX)).toBe('Eric Dean');
  });

  it('refuses a document whose text is longer than any resume, whatever its type', async () => {
    // `bounded()` is the third line of defence and the ONLY size limit on the text/plain and
    // text/markdown paths — nothing there is a zip, so neither the declared-size check nor the
    // packed cross-check applies. It had no test at all.
    const huge = 'x'.repeat(4_000_001);
    await writeFile(at('huge.txt'), huge);
    await expect(extractText(at('huge.txt'), 'text/plain')).rejects.toThrow(/characters/);
    await expect(extractText(at('huge.txt'), 'text/plain')).rejects.toThrow(/4,000,001/);

    // And the same limit on the .docx path, which is what catches an archive whose header lied
    // about its size convincingly enough to get past both of the checks before it.
    await writeFile(at('huge.docx'), makeDocx('y'.repeat(4_000_001)));
    await expect(extractText(at('huge.docx'), DOCX)).rejects.toThrow(/characters/);
  }, 60_000);

  it('reads a document that is merely long', async () => {
    // Just under the line. Refusing here would turn a fifty-page academic CV into an upload the
    // student cannot use, which is a worse outcome than the limit exists to prevent.
    const long = 'z'.repeat(3_999_000);
    await writeFile(at('long.txt'), long);
    expect(await extractText(at('long.txt'), 'text/plain')).toHaveLength(3_999_000);
  }, 60_000);

  it('refuses a .docx that is not a zip at all', async () => {
    await writeFile(at('fake.docx'), 'PK this is not really an archive');
    await expect(extractText(at('fake.docx'), DOCX)).rejects.toThrow(/archive directory/);
  });

  it('allows a .docx that is genuinely large, rather than capping the honest ones too', async () => {
    // Real content, real declared size — about 2 MB unpacked, roughly a 400-page CV and far
    // beyond anything a student uploads. An inflated header cannot stand in for this: jszip
    // checks the declared size against what it actually read and refuses the mismatch, which
    // is worth knowing, because it means the header check is a first line and not the only one.
    const long = 'Eric Dean, Half Moon Bay. '.repeat(80_000);
    await writeFile(at('big.docx'), makeDocx(long));

    const bounds = readZipBounds(await readFile(at('big.docx')));
    expect(bounds!.declaredBytes).toBeGreaterThan(2_000_000);
    expect(await extractText(at('big.docx'), DOCX)).toBe(long.trim());
  });
});

/**
 * The declared-size read itself.
 *
 * These numbers are what the archive SAYS, which is why they are not the only limit —
 * `extractText` also bounds the text that comes out, and that is what catches a header that
 * understated the truth. This one exists to refuse before the memory is committed.
 */
describe('what a zip says about its own size', () => {
  it('adds up the declared sizes without unpacking anything', () => {
    const zip = makeZip([
      { name: 'a.xml', content: 'x'.repeat(100) },
      { name: 'b.xml', content: 'y'.repeat(50) },
    ]);
    // 150 unpacked, and the same 150 packed, because `makeZip` STORES everything.
    expect(readZipBounds(zip)).toEqual({
      declaredBytes: 150,
      compressedBytes: 150,
      entries: 2,
      zip64: false,
    });
  });

  it('believes an inflated header, which is the whole point of reading it', () => {
    const zip = makeZip([{ name: 'a.xml', content: 'x', declaredUnpackedBytes: 999_000_000 }]);
    expect(readZipBounds(zip)?.declaredBytes).toBe(999_000_000);
  });

  it('returns nothing for something that is not a zip', () => {
    expect(readZipBounds(Buffer.from('not a zip at all'))).toBeNull();
    expect(readZipBounds(Buffer.alloc(0))).toBeNull();
    expect(readZipBounds(Buffer.from('%PDF-1.7'))).toBeNull();
  });

  it('is not fooled by its own signature appearing inside the data', () => {
    // The end-of-directory signature is four arbitrary bytes and turns up in file content by
    // chance. Scanning forwards would find this one and read the rest from the wrong offset.
    const decoy = Buffer.alloc(4);
    decoy.writeUInt32LE(0x06054b50, 0);
    const zip = makeZip([{ name: 'a.xml', content: `${decoy.toString('binary')}payload` }]);
    expect(readZipBounds(zip)?.entries).toBe(1);
  });

  it('treats a truncated archive as unreadable rather than guessing', () => {
    const zip = makeZip([{ name: 'a.xml', content: 'x'.repeat(100) }]);
    expect(readZipBounds(zip.subarray(0, zip.length - 30))).toBeNull();
  });
});
