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
    expect(readZipBounds(zip)).toEqual({ declaredBytes: 150, entries: 2, zip64: false });
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
