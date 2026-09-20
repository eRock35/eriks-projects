// Getting a table out of whatever someone pasted.
//
// Order of preference: real HTML tables, then JSON arrays, then delimited
// text. Anything left over is handed to the model as prose, which is slower
// and costs money, so it is the last resort rather than the default.

const { fetchText } = require('./fetchsafe');

const MAX_ROWS = 2000;
const MAX_COLS = 24;

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<sup[\s\S]*?<\/sup>/gi, ' ')   // footnote markers wreck numbers
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every <table> on the page, as arrays of rows. */
function tablesFromHtml(html) {
  const out = [];
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    const rows = [];
    const rowRe = /<tr[\s\S]*?<\/tr>/gi;
    let r;
    while ((r = rowRe.exec(m[0])) !== null) {
      const cells = [];
      const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let c;
      while ((c = cellRe.exec(r[0])) !== null) cells.push(stripTags(c[2]));
      if (cells.length) rows.push(cells.slice(0, MAX_COLS));
    }
    if (rows.length >= 2) out.push(rows.slice(0, MAX_ROWS));
  }
  // Widest first: on a page full of navigation tables, the real data is
  // almost always the one with the most columns.
  return out.sort((a, b) => (b[0] || []).length - (a[0] || []).length);
}

/** CSV/TSV with quoted fields. Written out rather than pulled in because the
 *  whole parser is thirty lines and a dependency is forever. */
function parseDelimited(text) {
  const sample = text.slice(0, 5000);
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  for (const ch of sample) if (ch in counts) counts[ch]++;
  const delim = Object.keys(counts).reduce((a, b) => (counts[a] >= counts[b] ? a : b));
  if (!counts[delim]) return null;

  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field.trim()); field = ''; continue; }
    if (ch === '\n') {
      row.push(field.trim()); field = '';
      if (row.some((v) => v !== '')) rows.push(row.slice(0, MAX_COLS));
      row = [];
      if (rows.length >= MAX_ROWS) break;
      continue;
    }
    if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field.trim()); if (row.some((v) => v !== '')) rows.push(row.slice(0, MAX_COLS)); }
  return rows.length >= 2 ? rows : null;
}

/** A JSON array of flat objects is already a table. */
function tableFromJson(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return null; }
  const arr = Array.isArray(data) ? data
    : (data && typeof data === 'object'
        ? Object.values(data).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object')
        : null);
  if (!Array.isArray(arr) || !arr.length || typeof arr[0] !== 'object') return null;
  const cols = [];
  for (const row of arr.slice(0, 50)) {
    for (const k of Object.keys(row || {})) {
      if (!cols.includes(k) && cols.length < MAX_COLS && (row[k] === null || typeof row[k] !== 'object')) cols.push(k);
    }
  }
  if (!cols.length) return null;
  const rows = [cols];
  for (const row of arr.slice(0, MAX_ROWS)) {
    rows.push(cols.map((c) => (row && row[c] != null ? String(row[c]) : '')));
  }
  return rows;
}

/** Whatever was pasted, turned into candidate tables plus prose fallback. */
function fromText(text, contentType = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { tables: [], prose: '' };

  if (/json/.test(contentType) || /^[[{]/.test(trimmed)) {
    const t = tableFromJson(trimmed);
    if (t) return { tables: [t], prose: '' };
  }
  if (/<table/i.test(trimmed)) {
    const tables = tablesFromHtml(trimmed);
    if (tables.length) return { tables, prose: stripTags(trimmed).slice(0, 4000) };
  }
  const d = parseDelimited(trimmed);
  if (d) return { tables: [d], prose: '' };

  const prose = /<[a-z][\s\S]*>/i.test(trimmed) ? stripTags(trimmed) : trimmed;
  return { tables: [], prose: prose.slice(0, 12000) };
}

async function fromUrl(url) {
  const res = await fetchText(url);
  const out = fromText(res.text, res.contentType);
  return Object.assign({ sourceUrl: res.url }, out);
}

module.exports = { fromText, fromUrl, tablesFromHtml, parseDelimited, tableFromJson, stripTags };
