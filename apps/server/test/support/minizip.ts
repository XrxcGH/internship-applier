/**
 * A zip writer small enough to be read in one sitting, for building .docx files in tests.
 *
 * Entries are STORED, never deflated, because nothing here needs to be small — the tests
 * that care about size say what size they want in the header rather than producing it. That
 * is the point of `declaredUnpackedBytes`: a decompression bomb can be described in a few
 * hundred bytes instead of being built out of four hundred megabytes.
 *
 * Written rather than imported because the only zip library in the tree, jszip, is a
 * transitive dependency of mammoth. A test that reaches for it is a test that breaks when
 * mammoth changes what it depends on.
 */

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

export interface ZipEntry {
  name: string;
  content: string;
  /**
   * The size to WRITE into the headers, when it should differ from the real one.
   *
   * Only a test that wants a lying or oversized archive should set this. Everything reading
   * the zip properly — jszip, Word, `readZipBounds` — takes this number at its word.
   */
  declaredUnpackedBytes?: number;
}

export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content, 'utf8');
    const declared = entry.declaredUnpackedBytes ?? content.length;
    const crc = crc32(content);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18); // compressed
    local.writeUInt32LE(declared, 22); // uncompressed
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, content);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + content.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}

/** A .docx holding one paragraph — the smallest thing mammoth will read as a document. */
export function makeDocx(text: string, declaredUnpackedBytes?: number): Buffer {
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

  return makeZip([
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    { name: 'word/document.xml', content: document, declaredUnpackedBytes },
  ]);
}

/** Table-less CRC-32, computed the slow readable way. Nothing here is large enough to care. */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
