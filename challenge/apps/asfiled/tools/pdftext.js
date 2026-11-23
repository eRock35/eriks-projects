// A small PDF text reader, enough for a text-set list such as Apple's
// Supplier List (no dependency, so the pipeline needs nothing installed).
// It reads each page's content streams, follows the page's fonts to their
// ToUnicode maps, and returns the text in drawing order, one line per
// text line. It does not handle encrypted files or object streams; it
// throws rather than guess.

const zlib = require('zlib');

function pdfText(buf) {
  const src = buf.toString('latin1');
  if (/\/Encrypt\b/.test(src.slice(-4096))) throw new Error('encrypted PDF');
  const objs = {};
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endobj', start);
    if (end < 0) break;
    objs[m[1]] = { start, end };
    re.lastIndex = end;
  }
  if (!Object.keys(objs).length) throw new Error('no objects found');
  const body = (n) => (objs[n] ? src.slice(objs[n].start, objs[n].end) : '');
  function stream(n) {
    const b = body(n);
    const s = b.indexOf('stream');
    if (s < 0) return '';
    let from = s + 6;
    if (b[from] === '\r') from += 1;
    if (b[from] === '\n') from += 1;
    const to = b.lastIndexOf('endstream');
    const raw = Buffer.from(b.slice(from, to), 'latin1');
    const dict = b.slice(0, s);
    if (/\/FlateDecode/.test(dict)) return zlib.inflateSync(raw).toString('latin1');
    if (/\/Filter/.test(dict)) throw new Error('unsupported stream filter');
    return raw.toString('latin1');
  }
  const deref = (text) => { const r = /^\s*(\d+)\s+0\s+R/.exec(text); return r ? body(r[1]) : text; };
  /** The balanced << ... >> that follows `key` in a dictionary. */
  function sub(dict, key) {
    const i = dict.indexOf(key);
    if (i < 0) return '';
    const rest = dict.slice(i + key.length);
    const ref = /^\s*(\d+)\s+0\s+R/.exec(rest);
    if (ref) return body(ref[1]);
    const o = rest.indexOf('<<');
    if (o < 0) return '';
    let depth = 0;
    for (let j = o; j < rest.length - 1; j += 1) {
      if (rest[j] === '<' && rest[j + 1] === '<') { depth += 1; j += 1; } else if (rest[j] === '>' && rest[j + 1] === '>') { depth -= 1; j += 1; if (!depth) return rest.slice(o, j + 1); }
    }
    return '';
  }
  function cmap(n) {
    const t = stream(n);
    const map = {};
    const hex = (h) => { let s = ''; for (let i = 0; i < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return s; };
    for (const blk of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map[parseInt(p[1], 16)] = hex(p[2]);
    for (const blk of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const p of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
        const a = parseInt(p[1], 16); const b = parseInt(p[2], 16);
        if (p[3]) { const base = parseInt(p[3], 16); for (let c = a; c <= b; c += 1) map[c] = String.fromCodePoint(base + c - a); } else { const arr = [...p[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => hex(x[1])); for (let c = a; c <= b; c += 1) map[c] = arr[c - a] || ''; }
      }
    }
    return map;
  }
  // Pages in document order: walk the page tree from its root.
  const isPage = (n) => /\/Type\s*\/Page(?![a-zA-Z])/.test(body(n));
  const pages = [];
  const walk = (n, depth) => {
    if (depth > 20) return;
    if (isPage(n)) { pages.push(Number(n)); return; }
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(body(n));
    if (kids) for (const k of kids[1].matchAll(/(\d+)\s+0\s+R/g)) walk(k[1], depth + 1);
  };
  const rootNode = Object.keys(objs).find((n) => /\/Type\s*\/Pages\b/.test(body(n)) && !/\/Parent\b/.test(body(n)));
  if (rootNode) walk(rootNode, 0);
  if (!pages.length) throw new Error('no page tree found');
  const out = [];
  for (const p of pages) {
    const dict = body(p);
    const fontsDict = sub(deref(sub(dict, '/Resources')) || sub(dict, '/Resources'), '/Font');
    const fonts = {};
    for (const f of fontsDict.matchAll(/\/([^\s/<>\[\]]+)\s+(\d+)\s+0\s+R/g)) {
      const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(body(f[2]));
      // A composite (Type0) font is written two bytes a glyph; every other
      // kind one - whatever its map's codespace line claims.
      fonts[f[1]] = { map: tu ? cmap(tu[1]) : {}, bytes: /\/Subtype\s*\/Type0/.test(body(f[2])) ? 2 : 1 };
    }
    const cm = /\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/.exec(dict);
    if (!cm) continue;
    const content = [...cm[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => stream(r[1])).join('\n');
    let font = null; let line = '';
    const lines = [];
    const flush = () => { if (line.trim()) lines.push(line.replace(/\s+/g, ' ').trim()); line = ''; };
    const decode = (bytes) => {
      if (!font) return bytes;
      let s = '';
      for (let i = 0; i < bytes.length; i += font.bytes) {
        const code = font.bytes === 2 ? (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1) : bytes.charCodeAt(i);
        s += font.map[code] !== undefined ? font.map[code] : (font.bytes === 1 ? bytes[i] : '');
      }
      return s;
    };
    const lit = (raw) => raw.replace(/\\(\d{1,3}|[\s\S])/g, (_, e) => (/^\d/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[e] || e)));
    const hexs = (h) => { let s = ''; const c = h.replace(/\s+/g, ''); for (let i = 0; i < c.length; i += 2) s += String.fromCharCode(parseInt(c.slice(i, i + 2).padEnd(2, '0'), 16)); return s; };
    const tok = /\/([^\s/<>\[\]()]+)\s+[\d.]+\s+Tf|\[((?:\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>|[^\]])*)\]\s*TJ|\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|<[0-9a-fA-F\s]*>\s*Tj|(-?[\d.]+)\s+(-?[\d.]+)\s+T[dD]|T\*|\bET\b|[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+Tm/g;
    let t;
    while ((t = tok.exec(content))) {
      const s = t[0];
      if (t[1] !== undefined) { font = fonts[t[1]] || null; continue; }
      if (/TJ$/.test(s)) {
        for (const part of t[2].matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9a-fA-F\s]*)>|(-?[\d.]+)/g)) {
          if (part[1] !== undefined) line += decode(lit(part[1])); else if (part[2] !== undefined) line += decode(hexs(part[2])); else if (Number(part[3]) < -180) line += ' ';
        }
        continue;
      }
      if (/(Tj|'|")$/.test(s)) { const lm = /^\(([\s\S]*)\)\s*\S+$/.exec(s); const hm = /^<([\s\S]*)>\s*Tj$/.exec(s); line += lm ? decode(lit(lm[1])) : decode(hexs(hm[1])); continue; }
      if (/T[dD]$/.test(s)) { if (Math.abs(Number(t[4])) > 0.01) flush(); else line += ' '; continue; }
      flush();
    }
    flush();
    out.push(lines);
  }
  return out;
}

module.exports = { pdfText };
