/**
 * 無圧縮(stored) ZIP の生成 (PKWARE APPNOTE 準拠の最小実装)
 *
 * Figma プラグインは networkAccess: none でサンドボックス内実行のため、
 * 外部の zip ライブラリを使えない。構造JSONとPNG群を1ファイルで渡すために自前実装する。
 * ファイル名は UTF-8 (general purpose bit 11) で格納する。
 */

export interface ZipEntry {
  /** ZIP 内パス。区切りは "/" */
  readonly name: string;
  readonly data: Uint8Array;
}

/** TextEncoder がプラグインサンドボックスに無い場合に備えた自前 UTF-8 エンコーダ */
export function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const VERSION = 20;
/**
 * 上位バイト 3 = Unix。0 (MS-DOS) のままだと macOS の unzip が bit 11 を無視して
 * 名前を CP437 として扱い、日本語のパスで展開に失敗する
 */
const VERSION_MADE_BY_UNIX = (3 << 8) | VERSION;
/** made by = Unix のとき上位 16 bit が st_mode として使われる。0 だと権限なしで展開される */
const EXTERNAL_ATTR_REGULAR_FILE_0644 = (0o100644 << 16) >>> 0;
const FLAG_UTF8_NAME = 0x0800;
const METHOD_STORED = 0;
/** 1980-01-01 (DOS date の最小値)。生成日時は meta 側に持つため固定でよい */
const DOS_DATE_1980_01_01 = 0x21;

/** EOCD のエントリ数は 16 bit。超えると件数が切り詰められた壊れた ZIP になる (ZIP64 は未対応) */
const MAX_ENTRIES = 0xffff;

export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(
      `ZIP のエントリが多すぎます (${entries.length} 件。上限 ${MAX_ENTRIES} 件)`
    );
  }
  const located = entries.map((entry) => ({
    nameBytes: utf8Encode(entry.name),
    data: entry.data,
    crc: crc32(entry.data),
    offset: 0,
  }));

  let localTotal = 0;
  for (const e of located) {
    e.offset = localTotal;
    localTotal += LOCAL_HEADER_SIZE + e.nameBytes.length + e.data.length;
  }
  const centralTotal = located.reduce(
    (sum, e) => sum + CENTRAL_HEADER_SIZE + e.nameBytes.length,
    0
  );

  const out = new Uint8Array(localTotal + centralTotal + EOCD_SIZE);
  const view = new DataView(out.buffer);
  let pos = 0;
  const u16 = (v: number) => {
    view.setUint16(pos, v, true);
    pos += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(pos, v, true);
    pos += 4;
  };
  const raw = (b: Uint8Array) => {
    out.set(b, pos);
    pos += b.length;
  };

  for (const e of located) {
    u32(0x04034b50); // local file header signature
    u16(VERSION);
    u16(FLAG_UTF8_NAME);
    u16(METHOD_STORED);
    u16(0); // mod time
    u16(DOS_DATE_1980_01_01);
    u32(e.crc);
    u32(e.data.length); // compressed size (stored = 同値)
    u32(e.data.length); // uncompressed size
    u16(e.nameBytes.length);
    u16(0); // extra length
    raw(e.nameBytes);
    raw(e.data);
  }

  const centralOffset = pos;
  for (const e of located) {
    u32(0x02014b50); // central directory header signature
    u16(VERSION_MADE_BY_UNIX);
    u16(VERSION); // version needed
    u16(FLAG_UTF8_NAME);
    u16(METHOD_STORED);
    u16(0); // mod time
    u16(DOS_DATE_1980_01_01);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.nameBytes.length);
    u16(0); // extra length
    u16(0); // comment length
    u16(0); // disk number start
    u16(0); // internal attributes
    u32(EXTERNAL_ATTR_REGULAR_FILE_0644);
    u32(e.offset);
    raw(e.nameBytes);
  }

  u32(0x06054b50); // end of central directory signature
  u16(0); // disk number
  u16(0); // central directory start disk
  u16(located.length);
  u16(located.length);
  u32(centralTotal);
  u32(centralOffset);
  u16(0); // comment length

  return out;
}
