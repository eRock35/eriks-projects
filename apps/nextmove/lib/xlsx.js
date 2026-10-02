// Reading the Department of Labor's and BLS's spreadsheets row by row, with
// no dependency and bounded memory.
//
// An .xlsx is a zip of XML. The DOL's yearly LCA file is ~100 MB zipped and
// well over a gigabyte of sheet XML unzipped, so loading it whole (which is
// what most xlsx libraries do) is not an option on a 2 GiB job. Instead:
//
//   1. the file is downloaded to disk (the job's /tmp);
//   2. the zip's central directory is read from the end of the file (zip64
//      included - these files can pass 4 GB unzipped);
//   3. the shared-strings part is streamed once into an array (the one thing
//      held in memory: the distinct strings, not the rows);
//   4. the first worksheet is streamed through inflate and cut into <row>
//      elements as they arrive, each parsed and handed to the caller.
//
// CSV files (older DOL years, or a converted file) go through csvRows, the
// same row-by-row shape.

const fs = require('fs');
const zlib = require('zlib');
const { decodeEntities } = require('./text');

/* ------------------------------------------------------------------ *
 * Zip
 * ------------------------------------------------------------------ */

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return b.subarray(0, n);
}

/** The central directory of a zip on disk -> Map(name -> entry). */
function openZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557 + 20);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    // Zip64: the locator sits just before the EOCD.
    if ((cdOffset === 0xffffffff || count === 0xffff) && eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {
      const z64at = Number(tail.readBigUInt64LE(eocd - 20 + 8));
      const z64 = readAt(fd, z64at, 56);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('bad zip64 end of central directory');
      count = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let local = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      let q = 0;
      while (q + 4 <= extra.length) {
        const id = extra.readUInt16LE(q);
        const len = extra.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (compSize === 0xffffffff) { compSize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (local === 0xffffffff) { local = Number(extra.readBigUInt64LE(r)); r += 8; }
        }
        q += 4 + len;
      }
      entries.set(name, { name, method, compSize, uncompSize, local });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { file, entries };
  } finally { fs.closeSync(fd); }
}

/** A readable stream of one entry's uncompressed bytes. */
function entryStream(zip, name) {
  const e = zip.entries.get(name);
  if (!e) throw new Error(`zip has no ${name}`);
  const fd = fs.openSync(zip.file, 'r');
  const h = readAt(fd, e.local, 30);
  fs.closeSync(fd);
  if (h.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local file header');
  const start = e.local + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  const raw = fs.createReadStream(zip.file, { start, end: start + e.compSize - 1, highWaterMark: 1 << 20 });
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new Error(`zip compression method ${e.method} is not supported`);
  const inflate = zlib.createInflateRaw({ chunkSize: 1 << 20 });
  raw.on('error', (err) => inflate.destroy(err));
  return raw.pipe(inflate);
}

/** Copy one entry out to a file (an .xlsx inside BLS's .zip). */
async function extractEntry(zip, name, toFile) {
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(toFile);
    const s = entryStream(zip, name);
    s.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    s.pipe(out);
  });
  return toFile;
}

/* ------------------------------------------------------------------ *
 * Streaming XML elements
 * ------------------------------------------------------------------ */

/** Yield each complete `<tag ...>...</tag>` (or self-closed) element from a stream. */
async function* elements(stream, tag, maxElement = 4 * 1024 * 1024) {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let buf = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    buf += chunk;
    let from = 0;
    for (;;) {
      let s = buf.indexOf(open, from);
      // `<row` must not match `<rowBreaks`, `<si` not `<sizes`.
      while (s >= 0 && /[a-zA-Z]/.test(buf[s + open.length] || '')) s = buf.indexOf(open, s + 1);
      if (s < 0) { from = Math.max(from, buf.length - open.length); break; }
      const gt = buf.indexOf('>', s);
      if (gt < 0) { from = s; break; }
      if (buf[gt - 1] === '/') { yield buf.slice(s, gt + 1); from = gt + 1; continue; }
      const e = buf.indexOf(close, gt);
      if (e < 0) {
        if (buf.length - s > maxElement) throw new Error(`a <${tag}> element is larger than ${maxElement} bytes`);
        from = s; break;
      }
      yield buf.slice(s, e + close.length);
      from = e + close.length;
    }
    buf = buf.slice(from);
  }
}

function textOf(xml) {
  // Every <t> in the element, excluding phonetic runs (<rPh>).
  const noPh = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of noPh.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1];
  return decodeEntities(out);
}

async function sharedStrings(zip) {
  if (!zip.entries.has('xl/sharedStrings.xml')) return [];
  const out = [];
  for await (const si of elements(entryStream(zip, 'xl/sharedStrings.xml'), 'si')) out.push(si.endsWith('/>') && !si.includes('</si>') ? '' : textOf(si));
  return out;
}

/** The first worksheet's path, from the workbook and its relationships. */
async function firstSheet(zip) {
  const read = async (name) => {
    if (!zip.entries.has(name)) return '';
    let s = '';
    const st = entryStream(zip, name);
    st.setEncoding('utf8');
    for await (const c of st) { s += c; if (s.length > 2e6) break; }
    return s;
  };
  const wb = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const sheet = wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/) || wb.match(/<sheet\b[^>]*\bid="([^"]+)"/);
  if (sheet) {
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${sheet[1]}"`));
    const target = rel && (rel.match(/Target="([^"]+)"/) || [])[1];
    if (target) {
      const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      if (zip.entries.has(path)) return path;
    }
  }
  const any = [...zip.entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  if (!any.length) throw new Error('no worksheet in this file');
  return any[0];
}

function colIndex(ref) {
  const m = String(ref || '').match(/^([A-Z]+)/);
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseRow(xml, strings) {
  const cells = [];
  let next = 0;
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    const r = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
    const t = (attrs.match(/\bt="([a-zA-Z]+)"/) || [])[1] || 'n';
    const i = r ? colIndex(r) : next;
    next = i + 1;
    let v = null;
    if (t === 'inlineStr') v = textOf(body);
    else {
      const raw = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (raw !== undefined) {
        if (t === 's') v = strings[Number(raw)] !== undefined ? strings[Number(raw)] : '';
        else if (t === 'b') v = raw === '1' ? 'TRUE' : 'FALSE';
        else v = decodeEntities(raw);
      }
    }
    if (i !== null && i < 2000) cells[i] = v;
  }
  for (let k = 0; k < cells.length; k++) if (cells[k] === undefined) cells[k] = null;
  return cells;
}

/** Every row of the first worksheet of an .xlsx on disk, as an array of cell strings. */
async function* xlsxRows(file) {
  const zip = openZip(file);
  const strings = await sharedStrings(zip);
  const sheet = await firstSheet(zip);
  for await (const row of elements(entryStream(zip, sheet), 'row')) yield parseRow(row, strings);
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

/** RFC 4180-ish: quotes, doubled quotes, CRLF, newlines inside quotes. */
async function* csvRows(stream) {
  stream.setEncoding('utf8');
  let field = '';
  let row = [];
  let quoted = false;
  let afterQuote = false;
  let first = true;
  for await (let chunk of stream) {
    if (first) { chunk = chunk.replace(/^﻿/, ''); first = false; }
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (quoted) {
        if (c === '"') { quoted = false; afterQuote = true; } else field += c;
        if (field.length > 1e6) throw new Error('a CSV field is larger than 1 MB');
        continue;
      }
      if (c === '"') { if (afterQuote) { field += '"'; quoted = true; afterQuote = false; } else if (!field.length) quoted = true; else field += c; continue; }
      afterQuote = false;
      if (c === ',') { row.push(field); field = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { row.push(field); yield row; row = []; field = ''; continue; }
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); yield row; }
}

/* ------------------------------------------------------------------ *
 * Rows as objects
 * ------------------------------------------------------------------ */

/** Header row -> objects keyed by the upper-cased, trimmed header. */
async function* records(rows, { headerScan = 10 } = {}) {
  let header = null;
  let scanned = 0;
  for await (const r of rows) {
    if (!header) {
      scanned++;
      // Some files open with a title row; the header is the first row with
      // several non-empty cells.
      const filled = r.filter((x) => x !== null && String(x).trim() !== '');
      if (filled.length >= 3 || scanned >= headerScan) header = r.map((h) => String(h || '').trim().toUpperCase().replace(/\s+/g, '_'));
      continue;
    }
    const o = {};
    for (let i = 0; i < header.length; i++) if (header[i]) o[header[i]] = r[i] === undefined ? null : r[i];
    yield o;
  }
}

/** Rows of a file on disk, by its type (xlsx by its bytes, else CSV). */
function rowsOf(file) {
  const fd = fs.openSync(file, 'r');
  const head = readAt(fd, 0, 4);
  fs.closeSync(fd);
  if (head.length === 4 && head.readUInt32LE(0) === 0x04034b50) return xlsxRows(file);
  return csvRows(fs.createReadStream(file, { highWaterMark: 1 << 20 }));
}

module.exports = { openZip, entryStream, extractEntry, elements, sharedStrings, firstSheet, parseRow, xlsxRows, csvRows, records, rowsOf, colIndex };
