import { readFile } from 'node:fs/promises';

/** The few metrics libass uses to size and space text, read straight from an OpenType/TrueType file. */
export interface FontFileMetrics {
  unitsPerEm: number;
  /** OS/2 usWinAscent + usWinDescent: libass sizes text so that this height equals the ASS font size. */
  winHeight: number;
  /** Advance width (font units) per character code; characters the font lacks are absent. */
  advances: Map<number, number>;
}

interface TableRecord {
  offset: number;
  length: number;
}

function tableDirectory(buf: Buffer): Map<string, TableRecord> {
  const numTables = buf.readUInt16BE(4);
  const out = new Map<string, TableRecord>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    out.set(buf.toString('latin1', rec, rec + 4), { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) });
  }
  return out;
}

function requireTable(all: Map<string, TableRecord>, tag: string): TableRecord {
  const table = all.get(tag);
  if (!table) throw new Error(`Font has no ${tag} table`);
  return table;
}

/** Maps character codes to glyph ids using the first Unicode BMP (format 4) cmap subtable. */
function readCmapFormat4(buf: Buffer, cmap: TableRecord): Map<number, number> {
  const count = buf.readUInt16BE(cmap.offset + 2);
  let sub = -1;
  for (let i = 0; i < count; i++) {
    const rec = cmap.offset + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const offset = cmap.offset + buf.readUInt32BE(rec + 4);
    if (buf.readUInt16BE(offset) === 4 && ((platform === 3 && encoding === 1) || platform === 0)) {
      sub = offset;
      break;
    }
  }
  if (sub < 0) throw new Error('Font has no Unicode BMP cmap');
  const segX2 = buf.readUInt16BE(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const rangeOffsets = deltas + segX2;
  const map = new Map<number, number>();
  for (let s = 0; s < segX2 / 2; s++) {
    const end = buf.readUInt16BE(ends + s * 2);
    const start = buf.readUInt16BE(starts + s * 2);
    const delta = buf.readInt16BE(deltas + s * 2);
    const rangeOffset = buf.readUInt16BE(rangeOffsets + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (c + delta) & 0xffff;
      } else {
        const raw = buf.readUInt16BE(rangeOffsets + s * 2 + rangeOffset + (c - start) * 2);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) map.set(c, glyph);
    }
  }
  return map;
}

/**
 * Reads the metrics libass relies on from a font file (OTF/CFF or TTF): units per em, the Windows
 * ascent + descent (libass's line height) and the advance width of every BMP character.
 * Used by the metric-table generator and by the test that checks the table is still an upper bound.
 */
export async function readFontFileMetrics(path: string): Promise<FontFileMetrics> {
  const buf = await readFile(path);
  const all = tableDirectory(buf);
  const head = requireTable(all, 'head');
  const hhea = requireTable(all, 'hhea');
  const os2 = requireTable(all, 'OS/2');
  const hmtx = requireTable(all, 'hmtx');
  const unitsPerEm = buf.readUInt16BE(head.offset + 18);
  const numberOfHMetrics = buf.readUInt16BE(hhea.offset + 34);
  const winHeight = buf.readUInt16BE(os2.offset + 74) + buf.readUInt16BE(os2.offset + 76);
  const glyphs = readCmapFormat4(buf, requireTable(all, 'cmap'));
  const lastAdvance = buf.readUInt16BE(hmtx.offset + (numberOfHMetrics - 1) * 4);
  const advances = new Map<number, number>();
  for (const [code, glyph] of glyphs) {
    advances.set(code, glyph < numberOfHMetrics ? buf.readUInt16BE(hmtx.offset + glyph * 4) : lastAdvance);
  }
  return { unitsPerEm, winHeight, advances };
}
