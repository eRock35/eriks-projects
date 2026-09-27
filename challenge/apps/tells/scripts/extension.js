#!/usr/bin/env node
// npm run extension
//
//   1. copies public/tells-core.js and public/tells-meta.js into extension/,
//      byte for byte (the page, the server and the extension run the same
//      quick scan and metadata scanner; test/run.js fails if a copy drifts);
//   2. zips extension/ into public/tells-extension.zip, which the page offers
//      for "Load unpacked".
//
// The zip is written here, in plain Node (stored entries, CRC-32), so the
// build needs no zip tool and no dependency, and it is deterministic: fixed
// timestamps and sorted entries, so the same files make the same bytes.
//
//   node scripts/extension.js --check   exit 1 if the copies or the zip are stale

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const ZIP = path.join(ROOT, 'public', 'tells-extension.zip');
const SHARED = ['tells-core.js', 'tells-meta.js'];
// What goes in the zip: the extension itself, not its docs.
const SKIP = /\.md$/i;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function files(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...files(full, rel));
    else if (!SKIP.test(name)) out.push(rel);
  }
  return out;
}

/** A zip of stored (uncompressed) entries. DOS time 2026-01-01 00:00. */
function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, n, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** The zip's entries back out (for the test): stored entries only. */
function unzip(buf) {
  const out = {};
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 18), nlen = buf.readUInt16LE(i + 26), xlen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nlen).toString('utf8');
    const s = i + 30 + nlen + xlen;
    out[name] = { data: buf.subarray(s, s + size), crc: buf.readUInt32LE(i + 14) };
    i = s + size;
  }
  return out;
}

function build() {
  for (const f of SHARED) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(EXT, f));
  const entries = files(EXT).map((name) => ({ name, data: fs.readFileSync(path.join(EXT, name)) }));
  return zip(entries);
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const stale = SHARED.filter((f) => !fs.readFileSync(path.join(ROOT, 'public', f)).equals(fs.readFileSync(path.join(EXT, f))));
    const want = zip(files(EXT).map((name) => ({ name, data: fs.readFileSync(path.join(EXT, name)) })));
    const have = fs.existsSync(ZIP) ? fs.readFileSync(ZIP) : null;
    if (stale.length || !have || !have.equals(want)) {
      console.error(`stale: ${[...stale, ...(!have || !have.equals(want) ? ['public/tells-extension.zip'] : [])].join(', ')} - run npm run extension`);
      process.exit(1);
    }
    console.log('extension copies and zip are current');
  } else {
    const z = build();
    fs.writeFileSync(ZIP, z);
    console.log(`wrote public/tells-extension.zip (${z.length} bytes, ${files(EXT).length} files)`);
  }
}

module.exports = { zip, unzip, crc32, files, build, EXT, ZIP, SHARED };
