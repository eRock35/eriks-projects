/* Replay - the rules. Every automated decision, recorded well enough to
 * replay - and explain.
 *
 * UMD: window.ReplayCore in the page, importScripts() in the worker,
 * require() in the server and the tests. Everything that reads a decision
 * log, checks it and writes the answers lives here, so the page, the worker,
 * the server's checks and the tests run the same code. No clock, no dice, no
 * network and no storage. SHA-256 is handed in (`digest`): SubtleCrypto in
 * the browser and the worker, node:crypto in the tests - the canonical form
 * it hashes is built here, once, for all of them.
 *
 * What is in here, top to bottom:
 *   - text: cleaning, escaping, making invisible characters visible
 *   - reading: bytes to text, JSON Lines / a JSON array / CSV to records,
 *     nested keys as dot paths
 *   - keys: every key path, the SHAPE of its values (from a fixed list),
 *     and a guess at which Replay field each one is
 *   - rows: each record read through the confirmed mapping
 *   - the checks: completeness, adverse outcomes and reasons, determinism,
 *     the same inputs giving different outcomes, version drift against a
 *     change log, the hash chain (canonical JSON or the raw line), gaps,
 *     duplicates and order, overrides, time gaps
 *   - the replay pack for one decision, the reproducible sample, and the
 *     exports (Markdown, JSON, formula-safe CSV)
 *   - settings (checking preferences only - never a decision) and the AI
 *     field helper's request and answer, both checked field by field
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReplayCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    fileBytes: 20 * 1024 * 1024,  // refused before it is read
    records: 100000,               // records read from one file
    keys: 400,                     // key paths tracked
    aiKeys: 120,                   // key paths the AI helper is told
    depth: 6,                      // how deep nested objects are walked
    wide: 60,                      // an object wider than this is one value
    sampleValues: 300,             // values profiled per key
    refs: 200,                     // records listed per finding
    sample: 500,                   // the largest review sample
    codes: 200, codeChars: 16, codeText: 160,
    words: 40, wordChars: 30,
    presets: 10, presetName: 40, pathChars: 80,
    changeLog: 200, changeChars: 200,
    noteChars: 300,
    shapes: 6,
    maxReasons: 10,
    groups: 20,
    idChars: 120,
  };

  var SEV = ['critical', 'high', 'medium', 'low', 'info'];
  var SEV_WORD = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Worth knowing' };
  var SEV_MARK = { critical: '✗', high: '!', medium: '~', low: '-', info: 'i' };

  /* ================================================================== *
   * Text
   * ================================================================== */

  // Control characters, bidi overrides and isolates, zero-width characters,
  // soft hyphens, the byte-order mark. Invisible, or they reorder text: in an
  // id or a key they could make one record look like another.
  var BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/g;
  var BAD1 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/;
  var SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : (typeof v === 'boolean' ? String(v) : '')); }
  function esc(v) { return str(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function clip(s, n) {
    s = str(s);
    if (s.length <= n) return s;
    var cut = s.slice(0, Math.max(0, n - 1));
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return cut.replace(/\s+$/, '') + '…';
  }
  /** One line: invisible characters gone, spaces collapsed, bounded. */
  function line(v, max) { return clip(str(v).replace(BAD, '').replace(SPACES, ' ').replace(/\s+/g, ' ').trim(), max || 200); }
  function noMarkup(s) { return str(s).replace(/<[^>]{0,200}>/g, '').replace(/[<>]/g, ''); }
  function fold(s) { return str(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function plural(n, one, many) { return groups(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function pct(n, d) { if (!d) return '0%'; var p = n / d * 100; return (p > 0 && p < 1 ? '<1' : p > 99 && p < 100 ? '>99' : String(Math.round(p))) + '%'; }
  function pad2(n) { return ('0' + n).slice(-2); }
  function hex4(c) { return ('000' + c.toString(16).toUpperCase()).slice(-4); }
  function hasOwn(o, k) { return o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  /** Set an own property, even one called __proto__. */
  function put(o, k, v) { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); }

  var MARKS = { 0xFEFF: '‹BOM›', 0x0000: '‹NUL›', 0x0009: '⇥', 0x200B: '‹ZWSP›', 0x200C: '‹ZWNJ›', 0x200D: '‹ZWJ›', 0x00AD: '‹SHY›', 0x00A0: '‹NBSP›', 0x202E: '‹RLO›', 0x202D: '‹LRO›', 0x202A: '‹LRE›', 0x202B: '‹RLE›', 0x202C: '‹PDF›', 0x2066: '‹LRI›', 0x2067: '‹RLI›', 0x2068: '‹FSI›', 0x2069: '‹PDI›' };
  /** A string as it really is: invisible and bidi characters drawn as marks,
   *  line breaks as ⏎, bounded. For showing keys and values on the page. */
  function visible(s, max) {
    var out = '', i;
    s = str(s);
    max = max || 160;
    for (i = 0; i < s.length && out.length < max; i++) {
      var c = s.charCodeAt(i);
      if (MARKS[c] !== undefined) out += MARKS[c];
      else if (c === 10) out += '⏎';
      else if (c === 13) out += (s.charCodeAt(i + 1) === 10 ? '' : '‹CR›');
      else if (c < 32 || (c >= 0x7F && c <= 0x9F) || (c >= 0x200E && c <= 0x200F) || (c >= 0x2028 && c <= 0x202E) || (c >= 0x2060 && c <= 0x2069)) out += '‹U+' + hex4(c) + '›';
      else out += s.charAt(i);
    }
    return i < s.length ? out + '…' : out;
  }
  function hasInvisible(s) { return BAD1.test(str(s)); }

  /** Markdown-safe one line. */
  function mdEsc(s) { return str(s).replace(/([\\`*_[\]|<>~#])/g, '\\$1').replace(/^([>+-])/, '\\$1').replace(/\r?\n/g, ' '); }
  /** A CSV cell: quoted when it holds a comma, a quote, a line break or
   *  edge spaces. */
  function csvCell(v) {
    var s = str(v);
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** A text cell a spreadsheet would run as a formula (= + - @, a tab or a
   *  carriage return first) gets a leading apostrophe. */
  function formulaSafe(v) { var s = str(v); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }
  function csvRow(cells) { return cells.map(function (c) { return csvCell(formulaSafe(line(c, 400))); }).join(','); }

  /** A case id masked for sharing: its first and last two characters. */
  function mask(id) {
    var s = line(id, LIMITS.idChars);
    if (!s) return '';
    if (s.length < 6) return '•••';
    return s.charAt(0) + '•••' + s.slice(-2);
  }

  /* ================================================================== *
   * Bytes, hashing helpers
   * ================================================================== */

  function utf8(s) { return new TextEncoder().encode(str(s)); }
  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (typeof ArrayBuffer !== 'undefined' && x instanceof ArrayBuffer) return new Uint8Array(x);
    if (x && typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (typeof x === 'string') return utf8(x);
    return new Uint8Array(0);
  }
  /** An ArrayBuffer (a digest) as lowercase hex. */
  function hex(buf) {
    var b = toBytes(buf), out = '';
    for (var i = 0; i < b.length; i++) out += ('0' + b[i].toString(16)).slice(-2);
    return out;
  }
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function hexToB64(h) {
    var bytes = [];
    for (var i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.substr(i, 2), 16));
    var out = '';
    for (var j = 0; j < bytes.length; j += 3) {
      var n = (bytes[j] << 16) | ((bytes[j + 1] || 0) << 8) | (bytes[j + 2] || 0);
      out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + (j + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '=') + (j + 2 < bytes.length ? B64.charAt(n & 63) : '=');
    }
    return out;
  }
  /** FNV-1a, 32 bits: for the sample's seeded shuffle, never for proof. */
  function fnv(s) { var h = 0x811c9dc5; s = str(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  /** A seeded generator (mulberry32). The same seed, the same numbers. */
  function rng(seed) {
    var a = fnv(seed) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function decodeText(input) {
    var b = toBytes(input);
    var enc = 'utf-8', bom = false, start = 0;
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) { bom = true; start = 3; }
    else if (b[0] === 0xFF && b[1] === 0xFE) { enc = 'utf-16le'; bom = true; start = 2; }
    else if (b[0] === 0xFE && b[1] === 0xFF) { enc = 'utf-16be'; bom = true; start = 2; }
    var head = b.subarray(0, 8);
    var kind = '';
    if (head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04) kind = 'a zip file or a spreadsheet workbook (.xlsx) - save it as CSV or export the log as JSON Lines';
    else if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) kind = 'a PDF - export the log itself as JSON Lines or CSV';
    else if (head[0] === 0xD0 && head[1] === 0xCF && head[2] === 0x11 && head[3] === 0xE0) kind = 'an old Excel workbook - save it as CSV';
    else if (head[0] === 0x1F && head[1] === 0x8B) kind = 'a gzip file - unzip it first';
    else if (enc === 'utf-8') { for (var i = start; i < Math.min(b.length, 8192); i++) if (b[i] === 0) { kind = 'not a text file'; break; } }
    if (kind) return { text: '', encoding: enc, bom: bom, bad: 0, binary: kind };
    var text = new TextDecoder(enc, { fatal: false }).decode(b.subarray(start));
    var bad = 0;
    if (enc === 'utf-8') for (var k = text.indexOf('\uFFFD'); k >= 0; k = text.indexOf('\uFFFD', k + 1)) bad++;
    return { text: text, encoding: enc, bom: bom, bad: bad, binary: '' };
  }

  /* ================================================================== *
   * Canonical JSON, paths, and the hash recipe
   * ================================================================== */

  /** Canonical JSON: keys sorted by UTF-16 code units at every level, no
   *  whitespace, strings and numbers exactly as JSON.stringify writes them
   *  (the rules of RFC 8785, JCS). Undefined members are left out;
   *  undefined, a function or a non-finite number inside an array is null. */
  function canon(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return isFinite(v) ? JSON.stringify(v) : 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(function (x) { return (x === undefined || typeof x === 'function') ? 'null' : canon(x); }).join(',') + ']';
    if (typeof v === 'object') {
      var keys = Object.keys(v).filter(function (k) { return v[k] !== undefined && typeof v[k] !== 'function'; }).sort();
      return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    }
    return 'null';
  }

  /** A value by its dot path. A key that itself holds a dot ("model.version"
   *  in a CSV header) is found as it is; otherwise the path is walked. Own
   *  properties only - "__proto__" in a file is just a key. */
  function getPath(obj, path) {
    if (!isObj(obj) || !path) return undefined;
    if (hasOwn(obj, path)) return obj[path];
    for (var p = path.indexOf('.'); p > 0; p = path.indexOf('.', p + 1)) {
      var head = path.slice(0, p);
      if (hasOwn(obj, head) && isObj(obj[head])) {
        var r = getPath(obj[head], path.slice(p + 1));
        if (r !== undefined) return r;
      }
    }
    return undefined;
  }
  /** A copy of the object without the value at `path` (for hashing a record
   *  without its own hash). Untouched branches are shared, not copied. */
  function without(obj, path) {
    if (!isObj(obj)) return obj;
    var copy;
    if (hasOwn(obj, path)) {
      copy = {};
      Object.keys(obj).forEach(function (k) { if (k !== path) put(copy, k, obj[k]); });
      return copy;
    }
    for (var p = path.indexOf('.'); p > 0; p = path.indexOf('.', p + 1)) {
      var head = path.slice(0, p);
      if (hasOwn(obj, head) && isObj(obj[head])) {
        var inner = without(obj[head], path.slice(p + 1));
        if (inner !== obj[head]) {
          copy = {};
          Object.keys(obj).forEach(function (k) { put(copy, k, k === head ? inner : obj[k]); });
          return copy;
        }
      }
    }
    return obj;
  }
  /** The raw JSON line with one top-level member removed, as text, with the
   *  comma that joined it. Null when the key is not a top-level member. */
  function removeMember(raw, key) {
    var s = str(raw), depth = 0, i = 0, n = s.length;
    var members = []; // {kStart, vEnd} of top-level members
    var inStr = false, strStart = -1, lastKey = null, keyStart = -1, expectKey = false;
    while (i < n) {
      var c = s.charAt(i);
      if (inStr) {
        if (c === '\\') { i += 2; continue; }
        if (c === '"') {
          inStr = false;
          if (depth === 1 && expectKey) { lastKey = s.slice(strStart, i + 1); keyStart = strStart; expectKey = false; }
        }
        i++; continue;
      }
      if (c === '"') { inStr = true; strStart = i; i++; continue; }
      if (c === '{' || c === '[') { depth++; if (depth === 1 && c === '{') expectKey = true; i++; continue; }
      if (c === '}' || c === ']') {
        if (depth === 1 && lastKey !== null) { members.push({ key: lastKey, start: keyStart, end: i }); lastKey = null; }
        depth--; i++; continue;
      }
      if (c === ',' && depth === 1) {
        if (lastKey !== null) { members.push({ key: lastKey, start: keyStart, end: i }); lastKey = null; }
        expectKey = true; i++; continue;
      }
      i++;
    }
    var want = JSON.stringify(key);
    for (var m = 0; m < members.length; m++) {
      var mem = members[m], parsed;
      try { parsed = JSON.parse(mem.key); } catch (e) { continue; }
      if (JSON.stringify(parsed) !== want) continue;
      var valEnd = mem.end; // the comma or closing brace after the value
      while (valEnd > mem.start && /\s/.test(s.charAt(valEnd - 1))) valEnd--;
      if (m > 0) {
        // from the comma before this member to the end of its value
        var c0 = mem.start - 1;
        while (c0 >= 0 && /\s/.test(s.charAt(c0))) c0--;
        if (s.charAt(c0) !== ',') return null;
        return s.slice(0, c0) + s.slice(valEnd);
      }
      if (m === members.length - 1) return s.slice(0, mem.start) + s.slice(valEnd);
      // the first of several: it, the comma after it, and the space after that
      var after = mem.end + 1;
      while (after < n && /\s/.test(s.charAt(after))) after++;
      return s.slice(0, mem.start) + s.slice(after);
    }
    return null;
  }

  var RECIPES = { canonical: 'Canonical JSON', raw: 'The raw line' };
  /** What one record's hash is taken over: the previous record's hash (as
   *  the record writes it in its previous-hash field, else the previous
   *  record's own hash, else nothing), a line feed, then the record without
   *  its own hash - as canonical JSON, or as the raw line with the hash
   *  member (or CSV cell) removed. */
  function hashBody(rec, format, hashPath, recipe, delim) {
    if (recipe === 'raw' && format === 'jsonl') return removeMember(rec.raw, hashPath);
    if (recipe === 'raw' && format === 'csv') return removeCell(rec.raw, rec.headers, hashPath, delim);
    if (recipe === 'raw') return null;
    return canon(without(rec.obj, hashPath));
  }
  function hashInput(body, prev, prevInInput) { return (prevInInput ? str(prev) + '\n' : '') + body; }
  /** A stored hash, normalised: trimmed, a "sha256:" prefix dropped, hex
   *  lowercased. Base64 (32 bytes) kept as it is. */
  function normHash(v) {
    var s = str(v).trim().replace(/^sha-?256[:=]/i, '');
    if (/^[0-9a-f]{64}$/i.test(s)) return { kind: 'hex', value: s.toLowerCase() };
    if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) return { kind: 'b64', value: s.replace(/-/g, '+').replace(/_/g, '/').replace(/=?$/, '=') };
    return s ? { kind: 'bad', value: s } : null;
  }
  function hashMatches(stored, computedHex) {
    if (!stored || !computedHex) return false;
    if (stored.kind === 'hex') return stored.value === computedHex;
    if (stored.kind === 'b64') return stored.value === hexToB64(computedHex);
    return false;
  }
  function zeroHash(v) { var s = str(v).trim(); return !s || /^(0+|null|none|genesis)$/i.test(s.replace(/^sha-?256[:=]/i, '')); }

  /* ================================================================== *
   * Reading a log: JSON Lines, a JSON array, CSV
   * ================================================================== */

  function jsonError(e) {
    var m = /position (\d+)/i.exec(String(e && e.message));
    return m ? 'not valid JSON (it stops making sense at character ' + groups(+m[1] + 1) + ')' : 'not valid JSON';
  }
  var ARRAY_KEYS = ['records', 'decisions', 'events', 'items', 'entries', 'logs', 'log', 'data', 'rows', 'results'];

  function parseLog(text) {
    var out = { format: 'empty', records: [], unreadable: [], truncated: 0, delim: '', headers: null, blank: 0, wrapped: '' };
    var t = str(text);
    var lead = t.replace(/^\s+/, '');
    if (!lead) return out;
    var first = lead.charAt(0);
    var whole;
    if (first === '[' || first === '{') {
      if (first === '{') {
        var fl = (lead.split(/\r?\n/)[0] || '').trim();
        var asLine = null;
        try { asLine = JSON.parse(fl); } catch (e) { asLine = null; }
        if (isObj(asLine)) return parseJsonl(t, out);
      }
      try { whole = JSON.parse(t); } catch (e2) {
        if (first === '{') return parseJsonl(t, out);
        out.format = 'json';
        out.unreadable.push({ n: null, why: 'The file starts like a JSON array but is ' + jsonError(e2) + '.' });
        return out;
      }
      out.format = 'json';
      var arr = null;
      if (Array.isArray(whole)) arr = whole;
      else if (isObj(whole)) {
        var keys = Object.keys(whole);
        var pick = ARRAY_KEYS.filter(function (k) { return Array.isArray(whole[k]); })[0] ||
          keys.filter(function (k) { return Array.isArray(whole[k]) && whole[k].some(isObj); })[0];
        if (pick) { arr = whole[pick]; out.wrapped = line(pick, 40); }
        else arr = [whole];
      }
      (arr || []).some(function (item, idx) {
        if (out.records.length >= LIMITS.records) { out.truncated = arr.length - idx; return true; }
        if (!isObj(item)) out.unreadable.push({ n: null, item: idx + 1, why: 'item ' + groups(idx + 1) + ' is not an object' });
        else out.records.push({ i: out.records.length, n: null, item: idx + 1, raw: null, obj: item });
        return false;
      });
      return out;
    }
    return parseCsv(t, out);
  }

  function parseJsonl(t, out) {
    out.format = 'jsonl';
    var lines = t.split('\n');
    for (var k = 0; k < lines.length; k++) {
      var raw = lines[k];
      if (raw.charCodeAt(raw.length - 1) === 13) raw = raw.slice(0, -1);
      if (!raw.trim()) { if (k < lines.length - 1) out.blank++; continue; }
      if (out.records.length >= LIMITS.records) { out.truncated++; continue; }
      var obj;
      try { obj = JSON.parse(raw); } catch (e) { out.unreadable.push({ n: k + 1, why: jsonError(e) }); continue; }
      if (!isObj(obj)) { out.unreadable.push({ n: k + 1, why: 'a JSON ' + (Array.isArray(obj) ? 'array' : typeof obj) + ', not an object' }); continue; }
      out.records.push({ i: out.records.length, n: k + 1, raw: raw, obj: obj });
    }
    return out;
  }

  var DELIMS = [',', ';', '\t', '|'];
  function sniffDelimiter(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); }).slice(0, 20);
    var best = ',', bestScore = -1;
    DELIMS.forEach(function (d) {
      var counts = lines.map(function (l) { var n = 0, q = false; for (var i = 0; i < l.length; i++) { var c = l.charAt(i); if (c === '"') q = !q; else if (c === d && !q) n++; } return n; });
      if (!counts.length || !counts[0]) return;
      var same = counts.filter(function (c) { return c === counts[0]; }).length;
      var score = same * 100 + counts[0];
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }
  /** RFC 4180 records with their character spans (for the raw-line hash). */
  function csvRecords(text, d) {
    var recs = [], cells = [], cell = '', q = false, start = 0, lineNo = 1, recLine = 1, i = 0, n = text.length, quoted = false;
    function endCell() { cells.push(cell); cell = ''; quoted = false; }
    function endRec(end) { endCell(); recs.push({ cells: cells, start: start, end: end, n: recLine }); cells = []; }
    while (i < n) {
      var c = text.charAt(i);
      if (q) {
        if (c === '"') { if (text.charAt(i + 1) === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
        if (c === '\n') lineNo++;
        cell += c; i++; continue;
      }
      if (c === '"' && cell === '' && !quoted) { q = true; quoted = true; i++; continue; }
      if (c === d) { endCell(); i++; continue; }
      if (c === '\r' || c === '\n') {
        var end = i;
        if (c === '\r' && text.charAt(i + 1) === '\n') i++;
        i++;
        endRec(end);
        lineNo++; start = i; recLine = lineNo;
        continue;
      }
      cell += c; i++;
    }
    if (cell !== '' || cells.length || q) endRec(n);
    return recs;
  }
  /** One CSV record's raw text without one cell (and one delimiter). */
  function removeCell(raw, headers, key, d) {
    if (!headers) return null;
    var idx = headers.indexOf(key);
    if (idx < 0) return null;
    var spans = [], i = 0, q = false, s = str(raw), cellStart = 0;
    for (; i < s.length; i++) {
      var c = s.charAt(i);
      if (q) { if (c === '"') { if (s.charAt(i + 1) === '"') { i++; continue; } q = false; } continue; }
      if (c === '"') { q = true; continue; }
      if (c === d) { spans.push([cellStart, i]); cellStart = i + 1; }
    }
    spans.push([cellStart, s.length]);
    if (idx >= spans.length) return null;
    var sp = spans[idx];
    if (spans.length === 1) return '';
    if (idx === spans.length - 1) return s.slice(0, sp[0] - 1);
    return s.slice(0, sp[0]) + s.slice(sp[1] + 1);
  }

  function parseCsv(t, out) {
    out.format = 'csv';
    var d = sniffDelimiter(t);
    out.delim = d;
    var recs = csvRecords(t, d);
    var hi = 0;
    while (hi < recs.length && recs[hi].cells.every(function (c) { return !c.trim(); })) hi++;
    if (hi >= recs.length) { out.format = 'empty'; return out; }
    var seen = Object.create(null);
    var headers = recs[hi].cells.map(function (h, k) {
      var name = line(h, LIMITS.pathChars) || 'column ' + (k + 1);
      var base = name, m = 2;
      while (seen[name]) name = base + ' (' + (m++) + ')';
      seen[name] = 1;
      return name;
    });
    out.headers = headers;
    for (var r = hi + 1; r < recs.length; r++) {
      var rec = recs[r];
      if (rec.cells.every(function (c) { return !c.trim(); })) { out.blank++; continue; }
      if (out.records.length >= LIMITS.records) { out.truncated++; continue; }
      if (rec.cells.length !== headers.length) { out.unreadable.push({ n: rec.n, why: 'a row of ' + plural(rec.cells.length, 'cell') + ' under a header of ' + headers.length }); continue; }
      var obj = Object.create(null);
      headers.forEach(function (h, k) { obj[h] = rec.cells[k]; });
      out.records.push({ i: out.records.length, n: rec.n, raw: t.slice(rec.start, rec.end), obj: obj, headers: headers });
    }
    return out;
  }

  /** A CSV cell (or a JSON string) read as what it most likely is. */
  function coerce(v) {
    if (typeof v !== 'string') return v;
    var s = v.trim();
    if (s === '') return '';
    if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s) && s.length < 20) return Number(s);
    if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
    if (/^null$/i.test(s)) return null;
    if ((s.charAt(0) === '[' && s.charAt(s.length - 1) === ']') || (s.charAt(0) === '{' && s.charAt(s.length - 1) === '}')) {
      try { return JSON.parse(s); } catch (e) { return v; }
    }
    return v;
  }

  /* ================================================================== *
   * Keys and their shapes
   * ================================================================== */

  // What a key's values look like, from a fixed list. These codes - never a
  // value - are what the AI field helper is told. No digit in any code.
  var SHAPES = {
    'text-id': 'short codes of letters and digits',
    'uuid': 'UUIDs',
    'every-different': 'every value different',
    'few-values': 'a handful of repeated values',
    'outcome-words': 'words like approve, decline, refer or flag',
    'yes-no': 'yes/no or true/false',
    'date-iso': 'ISO date-times',
    'date-epoch': 'epoch timestamps (numbers)',
    'date-text': 'dates written another way',
    'number-whole': 'whole numbers',
    'number-decimal': 'decimal numbers',
    'number-unit': 'numbers between 0 and 1',
    'number-small': 'small numbers between 0 and 2',
    'number-large': 'numbers in the hundreds or more',
    'hash-hex': 'long hex strings, like a SHA-256 hash',
    'hash-base': 'base64 strings, like a hash',
    'version-like': 'version strings, like 2.4.0 or v3',
    'code-list': 'lists of short codes',
    'object-list': 'lists of objects',
    'object': 'a nested object',
    'text-short': 'text, 1 to 4 words',
    'text-long': 'text, 5 or more words',
    'names': 'handles or names of people',
    'has-at': 'values with an @ in them',
    'mostly-empty': 'mostly empty',
  };
  var SHAPE_KEYS = Object.keys(SHAPES);

  var OUTCOMES = ['approve', 'decline', 'refer', 'flag'];
  var OUTCOME_WORD = { approve: 'Approve', decline: 'Decline', refer: 'Refer', flag: 'Flag' };
  var OUTCOME_WORDS = {
    approve: ['approve', 'approved', 'approval', 'accept', 'accepted', 'pass', 'passed', 'allow', 'allowed', 'ok', 'green', 'clear', 'cleared', 'auto approve', 'auto approved', 'funded', 'approve with conditions'],
    decline: ['decline', 'declined', 'deny', 'denied', 'reject', 'rejected', 'refuse', 'refused', 'red', 'adverse', 'turn down', 'turned down', 'not approved'],
    refer: ['refer', 'referred', 'referral', 'review', 'manual review', 'manual', 'pending', 'escalate', 'escalated', 'amber', 'needs review', 'refer to underwriter', 'queue', 'queued'],
    flag: ['flag', 'flagged', 'fraud', 'suspected fraud', 'suspicious', 'alert', 'hold', 'held', 'step up', 'challenge', 'block', 'blocked', 'fraud review'],
  };
  function outcomeOf(v, words) {
    var f = fold(v);
    if (!f) return null;
    if (words) for (var w = 0; w < words.length; w++) if (fold(words[w].word) === f) return words[w].outcome;
    for (var o = 0; o < OUTCOMES.length; o++) if (OUTCOME_WORDS[OUTCOMES[o]].indexOf(f) >= 0) return OUTCOMES[o];
    return 'other';
  }

  var ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var VERSION_RE = /^(?:v|ver|version\s*)?\d+(?:\.\d+){0,3}(?:[-+][0-9a-z.]+)?$|^[a-z][a-z0-9_-]*[-_@:]v\d+(?:\.\d+){0,3}$|^[a-z][a-z0-9_-]*[-_@:]\d+(?:\.\d+){1,3}$/i;
  var YESNO = /^(yes|no|y|n|true|false|0|1|overridden|override|none|t|f)$/i;

  function newProfile(path, segs) { return { path: path, n: 0, nulls: 0, objects: 0, vals: [], order: 0, depth: segs }; }

  /** Every key path in the log (dot paths for nested JSON), how often it is
   *  there, and a few of its values for its shape. Arrays are one value;
   *  an object wider than LIMITS.wide is one value too (a map keyed by ids
   *  would otherwise turn every id into a key). */
  function discoverKeys(records) {
    var map = new Map(), order = [], more = 0;
    function track(path, depth) {
      var p = map.get(path);
      if (!p) {
        if (map.size >= LIMITS.keys) { more++; return null; }
        p = newProfile(path, depth); p.order = order.length;
        map.set(path, p); order.push(p);
      }
      return p;
    }
    function walk(obj, prefix, depth) {
      var ks = Object.keys(obj);
      for (var k = 0; k < ks.length; k++) {
        var key = ks[k];
        var path = prefix ? prefix + '.' + key : key;
        var v = obj[key];
        var prof = track(path, depth);
        if (!prof) continue;
        if (v === null || v === undefined || v === '') { prof.nulls++; continue; }
        prof.n++;
        if (isObj(v) && depth < LIMITS.depth && Object.keys(v).length <= LIMITS.wide) {
          prof.objects++;
          if (prof.vals.length < LIMITS.sampleValues) prof.vals.push(v);
          walk(v, path, depth + 1);
        } else if (prof.vals.length < LIMITS.sampleValues) prof.vals.push(v);
      }
    }
    for (var r = 0; r < records.length; r++) if (records[r].obj) walk(records[r].obj, '', 1);
    var total = records.length;
    var keys = order.map(function (p) { return keyView(p, total); });
    return { keys: keys, more: more };
  }

  function shapesOf(prof, total) {
    var vals = prof.vals.map(coerce).filter(function (v) { return v !== '' && v !== null && v !== undefined; });
    var n = vals.length, codes = [];
    if (!n) return ['mostly-empty'];
    var c = { s: 0, num: 0, b: 0, o: 0, a: 0 }, strs = [], nums = [], arrs = [];
    vals.forEach(function (v) {
      if (typeof v === 'string') { c.s++; strs.push(v); }
      else if (typeof v === 'number') { c.num++; nums.push(v); }
      else if (typeof v === 'boolean') c.b++;
      else if (Array.isArray(v)) { c.a++; arrs.push(v); }
      else if (isObj(v)) c.o++;
    });
    var most = function (k) { return c[k] >= n * 0.8; };
    if (most('o')) codes.push('object');
    else if (most('a')) {
      var items = [].concat.apply([], arrs).slice(0, 400);
      var objs = items.filter(isObj).length;
      if (items.length && objs >= items.length * 0.8) codes.push('object-list');
      else if (items.length && items.filter(function (x) { return (typeof x === 'string' || typeof x === 'number') && String(x).length <= 24 && !/\s/.test(String(x)); }).length >= items.length * 0.8) codes.push('code-list');
      else codes.push('text-short');
    } else if (c.b + strs.filter(function (s) { return YESNO.test(s.trim()); }).length >= n * 0.9 && (c.b || strs.length)) codes.push('yes-no');
    else if (most('num')) {
      var min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
      var ints = nums.every(function (x) { return Math.floor(x) === x; });
      if (ints && min >= 946684800 && max <= 4102444800) codes.push('date-epoch');
      else if (ints && min >= 946684800000 && max <= 4102444800000) codes.push('date-epoch');
      else if (min >= 0 && max <= 1 && !ints) codes.push('number-unit');
      else if (min >= 0 && max <= 2 && nums.some(function (x) { return Math.floor(x) !== x; })) codes.push('number-small');
      else if (min >= 0 && max <= 2) codes.push('number-small', 'number-whole');
      else if (ints) codes.push(max >= 100 ? 'number-large' : 'number-whole');
      else codes.push(max >= 100 ? 'number-large' : 'number-decimal');
    } else if (most('s')) {
      var share = function (re) { return strs.filter(function (s) { return re.test(s.trim()); }).length / strs.length; };
      if (share(ISO_RE) >= 0.8) codes.push('date-iso');
      else if (share(UUID_RE) >= 0.8) codes.push('uuid');
      else if (share(/^(?:sha-?256[:=])?[0-9a-f]{32,128}$/i) >= 0.8) codes.push('hash-hex');
      else if (share(/^[A-Za-z0-9+/_-]{40,88}={0,2}$/) >= 0.8 && share(/[0-9]/) >= 0.5) codes.push('hash-base');
      else if (strs.filter(function (s) { var o = outcomeOf(s); return o && o !== 'other'; }).length >= strs.length * 0.8) codes.push('outcome-words');
      else if (share(VERSION_RE) >= 0.8 && new Set(strs).size <= Math.max(3, strs.length * 0.5)) codes.push('version-like');
      else if (share(/@/) >= 0.5) codes.push('has-at');
      else if (strs.filter(function (s) { var x = s.trim(); return /^[A-Za-z0-9][A-Za-z0-9_\-:.#/]{1,60}$/.test(x) && (/\d/.test(x) || (/[_\-:#]/.test(x) && /[A-Z]/.test(x) && x === x.toUpperCase())); }).length >= strs.length * 0.8) codes.push('text-id');
      else if (share(/^[a-z]{1,12}[._][a-z]{2,16}$|^[A-Z][a-z]+(?: [A-Z][a-z.]+)+$/) >= 0.8 && new Set(strs).size >= 2) codes.push('names');
      else if (strs.filter(function (s) { return !isNaN(Date.parse(s)) && /[a-z]{3}/i.test(s) && /\d{4}/.test(s); }).length >= strs.length * 0.8) codes.push('date-text');
      else {
        var words = strs.reduce(function (a, s) { return a + s.trim().split(/\s+/).length; }, 0) / strs.length;
        codes.push(words <= 4 ? 'text-short' : 'text-long');
      }
    } else codes.push('text-short');
    if (!most('o') && !most('a') && n >= 5) {
      var seen = new Set();
      vals.forEach(function (v) { seen.add(canon(v)); });
      if (seen.size >= n * 0.95) codes.push('every-different');
      else if (seen.size <= 12 && n >= 10) codes.push('few-values');
    }
    if (total && (prof.n / total) < 0.2) codes.push('mostly-empty');
    return codes.filter(function (x, k) { return codes.indexOf(x) === k; }).slice(0, LIMITS.shapes);
  }

  function sampleText(v) {
    v = coerce(v);
    if (isObj(v)) return '{' + plural(Object.keys(v).length, 'key') + '}';
    if (Array.isArray(v)) {
      if (v.every(function (x) { return typeof x === 'string' || typeof x === 'number'; })) return '[' + v.slice(0, 4).map(String).join(', ') + (v.length > 4 ? ', …' : '') + ']';
      return '[' + plural(v.length, 'item') + ']';
    }
    return visible(str(v), 48);
  }
  function keyView(p, total) {
    var shapes = shapesOf(p, total);
    var samples = [];
    for (var k = 0; k < p.vals.length && samples.length < 2; k++) { var t = sampleText(p.vals[k]); if (t && samples.indexOf(t) < 0) samples.push(t); }
    return { path: p.path, n: p.n, share: total ? p.n / total : 0, object: p.objects > 0 && p.objects >= p.n * 0.8, depth: p.depth, shapes: shapes, samples: samples };
  }

  /* ================================================================== *
   * Guessing which key is which field
   * ================================================================== */

  var FIELDS = ['id', 'time', 'case', 'outcome', 'score', 'model', 'modelVersion', 'prompt', 'promptVersion', 'temperature', 'seed', 'inputs', 'inputsHash', 'tools', 'reasons', 'rules', 'reviewer', 'override', 'overrideReason', 'prevHash', 'hash'];
  var AI_FIELDS = FIELDS.concat(['ignore']);
  var FIELD_LABEL = {
    id: 'Decision id', time: 'Time', case: 'Case / applicant id', outcome: 'Outcome', score: 'Score',
    model: 'Model id', modelVersion: 'Model version', prompt: 'Prompt / template id', promptVersion: 'Prompt version or hash',
    temperature: 'Temperature', seed: 'Seed', inputs: 'Inputs snapshot', inputsHash: 'Inputs hash', tools: 'Tool calls',
    reasons: 'Reason codes', rules: 'Policy rules applied', reviewer: 'Human reviewer', override: 'Override (yes/no)',
    overrideReason: 'Why it was overridden', prevHash: 'Previous record’s hash', hash: 'This record’s hash', ignore: 'Not needed',
  };
  var FIELD_HELP = {
    id: 'the decision’s own id, unique per decision',
    time: 'when the decision was made',
    case: 'the case, application or applicant it was about (a pseudonymous id)',
    outcome: 'approve, decline, refer, flag - what was decided',
    score: 'the model’s score or probability',
    model: 'which model made it',
    modelVersion: 'the model’s version',
    prompt: 'which prompt or template was used',
    promptVersion: 'the prompt’s version, or a hash of its text',
    temperature: 'the sampling temperature of the call',
    seed: 'the random seed of the call',
    inputs: 'a snapshot of what went in (an object)',
    inputsHash: 'a hash of what went in',
    tools: 'tool or function calls made while deciding',
    reasons: 'reason codes given for the outcome',
    rules: 'policy rules that fired or were applied',
    reviewer: 'the person who reviewed it',
    override: 'whether a person overrode the outcome (yes/no)',
    overrideReason: 'why it was overridden, in words',
    prevHash: 'the hash of the record before this one (a hash chain)',
    hash: 'this record’s own hash',
    ignore: 'not needed for the checks',
  };

  function normPath(path) {
    return str(path).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/\[\d*\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // [regex on the normalised path, points]. The best match counts; a
  // penalty rule (negative) is added on top.
  var NAME_RULES = {
    id: [[/^(decision|event|evt|request|record|log|audit|trace|correlation|entry) ?(id|uuid|ref|key)$/, 7], [/^(id|uuid)$/, 6], [/\b(decision|event|evt|request|record|entry) (id|uuid)$/, 6]],
    time: [[/^(ts|time|timestamp|datetime|date|at|created|created at|decided at|decision time|decision at|logged at|event time|occurred at|when|time utc|timestamp utc)$/, 7], [/\b(timestamp|time|ts|at|created at|decided at|logged at|datetime)( utc)?$/, 5]],
    case: [[/^(case|applicant|application|customer|client|subject|borrower|merchant|account|app)( id| ref| reference| key| number| no| uuid)$/, 7], [/\b(case|applicant|application|customer|client|subject|borrower|merchant)( id| ref| reference| key)$/, 6], [/^(case|applicant|application)$/, 4]],
    outcome: [[/^(decision|outcome|result|action|verdict|disposition|recommendation|final decision|final outcome|status|label)$/, 7], [/\b(decision|outcome|result|verdict|disposition|final decision)$/, 5], [/\b(result|outcome|decision|verdict) (label|value|code|status|type)$/, 6]],
    score: [[/^(score|risk score|probability|pd|risk|confidence|rating|grade|model score|fraud score)$/, 7], [/\b(score|probability|confidence)$/, 5]],
    model: [[/^(model|model id|model name|engine|classifier|scorer|model key)$/, 7], [/\b(model|engine|scorer|classifier) (id|name|key)$/, 6], [/\bmodel$/, 4]],
    modelVersion: [[/\b(model|engine|scorer|classifier) (version|ver|rev|revision|build|tag|release)$/, 8], [/^(version|model ver)$/, 3]],
    prompt: [[/^(prompt|template|prompt id|template id|prompt name|template name|prompt key)$/, 7], [/\b(prompt|template)( id| name| key)?$/, 6]],
    promptVersion: [[/\b(prompt|template)s? (version|ver|rev|revision|hash|sha|sha256|digest|checksum|fingerprint)$/, 8]],
    temperature: [[/\b(temperature|temp)$/, 8]],
    seed: [[/\b(seed|random seed|rng seed|sampling seed)$/, 8]],
    inputs: [[/^(inputs?|features|request|payload|application|snapshot|context|facts|variables|input snapshot|inputs snapshot|input data|feature vector|attributes)$/, 7], [/\b(inputs?|features|input snapshot|inputs snapshot)$/, 6]],
    inputsHash: [[/\b(inputs?|features|request|payload|snapshot|input snapshot|context) (hash|sha|sha256|digest|checksum|fingerprint)$/, 8]],
    tools: [[/\b(tool calls?|tools|function calls?|calls|steps|tool use|tool uses|actions|trace)$/, 7]],
    reasons: [[/\b(reason codes?|reasons|adverse reasons|adverse action reasons|decline reasons|reason|codes|principal reasons|reason list)$/, 7], [/\b(result|decision|outcome) (why|reason codes?|reasons)$/, 7]],
    rules: [[/\b(rules?|policy rules|rules applied|policies|policy|rules fired|rule hits|rules hit|policy hits|checks)$/, 7]],
    reviewer: [[/\b(reviewer|reviewed by|analyst|underwriter|approver|approved by|agent|officer|reviewer id|operator|overridden by|override by|human|checker|by)$/, 7]],
    override: [[/\b(override|overridden|is override|manual override|overrode|override flag|human override|overriden|was overridden)$/, 8]],
    overrideReason: [[/\b(override|overridden|review|manual|human) (reason|note|notes|why|justification|comment|rationale)$/, 8], [/\b(justification|rationale|override note)$/, 5]],
    prevHash: [[/\b(prev|previous|parent|prior|last|preceding)( record)? ?(hash|sha|sha256|digest)?$/, 8], [/\bchain prev$/, 8]],
    hash: [[/\b(hash|record hash|entry hash|chain hash|sha256|sha|digest|checksum|fingerprint|self hash|this hash)$/, 6]],
  };
  var PENALTY = {
    id: /\b(model|prompt|template|tool|tools|case|applicant|application|customer|account|policy|rule|session|user|reviewer|seed|inputs?|calls?|steps?)\b/,
    time: /\b(review|reviewed|override|model|prompt|deploy|approved|inputs?|change|expires?|due)\b/,
    case: /\b(inputs?|features|request|payload)\b/,
    outcome: /\b(model decision|original|prior|previous|inputs?|reason|tool|tools)\b/,
    score: /\b(inputs?|bureau|credit score|features|request|payload)\b/,
    model: /\b(version|ver|tool|tools|inputs?)\b/,
    prompt: /\b(version|ver|hash|sha|digest|rev)\b/,
    inputs: /\b(hash|sha|sha256|digest|checksum|fingerprint)\b/,
    reasons: /\b(override|review|overridden)\b/,
    reviewer: /\b(model|prompt|inputs?)\b/,
    hash: /\b(prev|previous|parent|prior|last|preceding|inputs?|features|request|payload|prompt|template|snapshot|context)\b/,
  };
  var SHAPE_POINTS = {
    id: { 'every-different': 2, 'uuid': 2, 'text-id': 1.5, 'few-values': -5, 'object': -10, 'date-iso': -5, 'outcome-words': -6, 'hash-hex': -2 },
    time: { 'date-iso': 4, 'date-epoch': 3, 'date-text': 3, 'object': -10, 'text-short': -3, 'outcome-words': -6, 'text-id': -3 },
    case: { 'text-id': 1.5, 'uuid': 1, 'every-different': 0.5, 'object': -10, 'date-iso': -5, 'outcome-words': -6 },
    outcome: { 'outcome-words': 4, 'few-values': 1, 'object': -10, 'every-different': -4, 'date-iso': -6, 'number-unit': -6 },
    score: { 'number-unit': 2, 'number-decimal': 1.5, 'number-large': 1, 'number-whole': 0.5, 'object': -10, 'text-short': -4, 'outcome-words': -6, 'date-iso': -6 },
    model: { 'few-values': 1, 'text-short': 0.5, 'text-id': 0.5, 'object': -10, 'every-different': -3 },
    modelVersion: { 'version-like': 2, 'few-values': 1, 'object': -10, 'every-different': -3 },
    prompt: { 'few-values': 1, 'text-id': 0.5, 'object': -10, 'every-different': -3 },
    promptVersion: { 'version-like': 2, 'hash-hex': 1.5, 'few-values': 1, 'object': -10 },
    temperature: { 'number-small': 2, 'number-unit': 2, 'object': -10, 'text-short': -5 },
    seed: { 'number-whole': 1, 'number-large': 1, 'object': -10 },
    inputs: { 'object': 3, 'hash-hex': -8 },
    inputsHash: { 'hash-hex': 3, 'hash-base': 2, 'object': -10 },
    tools: { 'object-list': 3, 'code-list': 1 },
    reasons: { 'code-list': 3, 'text-short': 0.5, 'few-values': 0.5, 'object': -5, 'yes-no': -6, 'text-long': -2 },
    rules: { 'code-list': 2, 'object': -5, 'yes-no': -6 },
    reviewer: { 'names': 2, 'text-short': 0.5, 'few-values': 1, 'text-id': 0.5, 'object': -10, 'yes-no': -6, 'date-iso': -6 },
    override: { 'yes-no': 3, 'text-long': -3, 'object': -2 },
    overrideReason: { 'text-long': 2, 'text-short': 1, 'yes-no': -4, 'object': -10 },
    prevHash: { 'hash-hex': 3, 'hash-base': 2, 'object': -10 },
    hash: { 'hash-hex': 3, 'hash-base': 2, 'object': -10 },
  };
  function fieldScore(field, key) {
    var p = normPath(key.path), name = 0;
    (NAME_RULES[field] || []).forEach(function (r) { if (r[0].test(p) && r[1] > name) name = r[1]; });
    if (name < 3) return 0;
    if (PENALTY[field] && PENALTY[field].test(p)) name -= 6;
    var pts = SHAPE_POINTS[field] || {};
    var shape = 0;
    key.shapes.forEach(function (s) { if (pts[s]) shape += pts[s]; });
    if (field === 'time' && !key.shapes.some(function (s) { return /^date/.test(s); })) shape -= 3;
    if (field === 'score' && !key.shapes.some(function (s) { return /^number/.test(s); })) shape -= 4;
    if (field === 'temperature' && !key.shapes.some(function (s) { return /^number/.test(s); })) shape -= 4;
    if ((field === 'hash' || field === 'prevHash' || field === 'inputsHash') && !key.shapes.some(function (s) { return /^hash/.test(s); })) shape -= 2;
    if (key.object && field !== 'inputs') shape -= 6;
    return name + shape;
  }
  function confidenceOf(score) { return score >= 9 ? 'sure' : score >= 7 ? 'likely' : 'unsure'; }

  /** The best guess: field -> key path (or null), and how sure. Inputs and
   *  tool-call objects are placed first, and nothing inside them is offered
   *  for another field (the bureau score inside the inputs is not the
   *  decision's score). */
  function guessFields(keys) {
    var map = {}, conf = {}, used = {};
    FIELDS.forEach(function (f) { map[f] = null; });
    var under = function (path, parent) { return path.length > parent.length && path.indexOf(parent + '.') === 0; };
    var blocked = [];
    function place(fields) {
      var cand = [];
      fields.forEach(function (f) {
        keys.forEach(function (k) {
          if (blocked.some(function (b) { return under(k.path, b); })) return;
          var s = fieldScore(f, k);
          if (s >= 5) cand.push({ f: f, path: k.path, s: s, n: k.n });
        });
      });
      cand.sort(function (a, b) { return b.s - a.s || b.n - a.n || (a.path < b.path ? -1 : 1); });
      cand.forEach(function (c) {
        if (map[c.f] !== null || used[c.path]) return;
        if (blocked.some(function (b) { return under(c.path, b); })) return;
        map[c.f] = c.path; conf[c.f] = confidenceOf(c.s); used[c.path] = 1;
      });
    }
    place(['inputs', 'tools']);
    if (map.inputs) blocked.push(map.inputs);
    if (map.tools) blocked.push(map.tools);
    place(FIELDS.filter(function (f) { return f !== 'inputs' && f !== 'tools'; }));
    // Nothing by name: a key whose values can only be this field, marked
    // unsure so the person looks at it.
    var SHAPE_ONLY = { time: ['date-iso', 'date-epoch'], outcome: ['outcome-words'], hash: ['hash-hex'], reasons: ['code-list'] };
    Object.keys(SHAPE_ONLY).forEach(function (f) {
      if (map[f] !== null) return;
      var hits = keys.filter(function (k) {
        if (used[k.path] || k.object || blocked.some(function (b) { return under(k.path, b); })) return false;
        if (!k.shapes.some(function (x) { return SHAPE_ONLY[f].indexOf(x) >= 0; })) return false;
        if (f === 'hash') return k.shapes.indexOf('every-different') >= 0 && !/\b(prev|previous|parent|input|inputs|prompt|template|feature|features|request|payload)\b/.test(normPath(k.path));
        return true;
      });
      if (hits.length === 1) { map[f] = hits[0].path; conf[f] = 'unsure'; used[hits[0].path] = 1; }
    });
    return { map: map, conf: conf };
  }
  function cleanMap(raw, keys) {
    var paths = {}, map = {};
    (keys || []).forEach(function (k) { paths[k.path] = 1; });
    FIELDS.forEach(function (f) { var v = raw && typeof raw[f] === 'string' ? raw[f] : null; map[f] = v && (!keys || paths[v]) ? v : null; });
    return map;
  }

  /* ================================================================== *
   * Rows: each record read through the mapping
   * ================================================================== */

  function present(v) {
    if (v === undefined || v === null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (isObj(v)) return Object.keys(v).length > 0;
    return true;
  }
  function parseTime(v) {
    v = coerce(v);
    if (typeof v === 'number' && isFinite(v)) {
      if (v >= 946684800 && v <= 4102444800) return { ms: Math.round(v * 1000), off: null };
      if (v >= 946684800000 && v <= 4102444800000) return { ms: Math.round(v), off: null };
      return null;
    }
    var s = str(v).trim();
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
    if (m) {
      var y = +m[1], mo = +m[2], d = +m[3], h = +(m[4] || 0), mi = +(m[5] || 0), se = +(m[6] || 0), frac = m[7] ? Number('0.' + m[7]) : 0;
      if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return null;
      var off = 0, hasZone = Boolean(m[8]);
      if (m[8] && m[8].toUpperCase() !== 'Z') { var z = m[8].replace(':', ''); off = (z.charAt(0) === '-' ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.slice(3, 5)); }
      var ms = Date.UTC(y, mo - 1, d, h, mi, se) + Math.round(frac * 1000) - off * 60000;
      var back = new Date(ms + off * 60000);
      if (back.getUTCDate() !== d) return null;
      return { ms: ms, off: hasZone ? off : null };
    }
    if (/[a-z]{3}/i.test(s) && /\d{4}/.test(s)) { var t = Date.parse(s); if (isFinite(t)) return { ms: t, off: null }; }
    return null;
  }
  function listOf(v) {
    v = coerce(v);
    if (v === undefined || v === null || v === '') return null;
    if (Array.isArray(v)) return v.map(function (x) { return isObj(x) ? line(x.code || x.id || x.reason || x.name || x.rule || '', 40) : line(x, 40); }).filter(Boolean);
    if (typeof v === 'string') return v.split(/[;,|]/).map(function (x) { return line(x, 40); }).filter(Boolean);
    if (typeof v === 'number') return [String(v)];
    if (isObj(v)) return Object.keys(v).map(function (k) { return line(k, 40); });
    return null;
  }
  function yesNo(v) {
    v = coerce(v);
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (isObj(v)) return Object.keys(v).length > 0;
    var f = fold(v);
    if (/^(yes|y|true|t|1|overridden|override|overriden|manual|human)$/.test(f)) return true;
    if (/^(no|n|false|f|0|none|not overridden|auto|automatic)$/.test(f)) return false;
    return null;
  }
  function numberOf(v) { v = coerce(v); return typeof v === 'number' && isFinite(v) ? v : null; }

  function readRows(parsed, map, settings) {
    var words = settings.words;
    return parsed.records.map(function (rec) {
      var o = rec.obj;
      var get = function (f) { return map[f] ? getPath(o, map[f]) : undefined; };
      var row = { i: rec.i, n: rec.n, item: rec.item || null, has: {} };
      FIELDS.forEach(function (f) { row.has[f] = Boolean(map[f]) && present(get(f)); });
      row.id = line(get('id'), LIMITS.idChars);
      var tm = parseTime(get('time'));
      row.timeRaw = line(get('time'), 60);
      row.time = tm ? tm.ms : null;
      row.off = tm ? tm.off : null;
      row.timeBad = row.has.time && !tm;
      row.case = line(get('case'), LIMITS.idChars);
      row.outcomeRaw = line(get('outcome'), 60);
      row.outcome = row.has.outcome ? outcomeOf(get('outcome'), words) : null;
      row.score = numberOf(get('score'));
      row.scoreRaw = line(get('score'), 40);
      row.model = line(get('model'), 80);
      row.modelVersion = line(get('modelVersion'), 80);
      row.prompt = line(get('prompt'), 80);
      row.promptVersion = line(get('promptVersion'), 90);
      row.temperature = numberOf(get('temperature'));
      row.seed = line(get('seed'), 40);
      row.inputs = get('inputs');
      row.inputsHash = line(get('inputsHash'), 140);
      var tl = coerce(get('tools'));
      row.tools = Array.isArray(tl) ? tl : (present(tl) ? [tl] : null);
      row.reasons = listOf(get('reasons'));
      row.rules = listOf(get('rules'));
      row.reviewer = line(get('reviewer'), 80);
      row.override = map.override ? yesNo(get('override')) : null;
      row.overrideReason = line(get('overrideReason'), 300);
      row.prev = map.prevHash ? get('prevHash') : undefined;
      row.hash = map.hash ? get('hash') : undefined;
      if (row.has.inputsHash) row.inKey = 'h:' + row.inputsHash.toLowerCase();
      else if (row.has.inputs) { var iv = coerce(row.inputs); row.inKey = 'c:' + (isObj(iv) || Array.isArray(iv) ? canon(iv) : str(iv)); }
      else row.inKey = null;
      return row;
    });
  }
  function ref(row) {
    return { i: row.i, n: row.n, item: row.item, id: row.id, time: row.timeRaw, case: row.case, outcome: row.outcome && row.outcome !== 'other' ? row.outcome : row.outcomeRaw };
  }
  function where(r) { return r.n ? 'line ' + groups(r.n) : r.item ? 'item ' + groups(r.item) : 'record ' + groups(r.i + 1); }
  function nameOf(r) { return (r.id ? r.id + ' (' + where(r) + ')' : where(r)); }

  /* ================================================================== *
   * Time, in the log's own wall clock
   * ================================================================== */

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function wall(ms, off) { var d = new Date(ms + (off || 0) * 60000); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() }; }
  function zoneText(off) { if (off === null || off === undefined) return 'UTC'; if (!off) return 'UTC'; var a = Math.abs(off); return 'UTC' + (off < 0 ? '−' : '+') + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60); }
  function dayText(ms, off) { var w = wall(ms, off); return DOW[w.dow] + ' ' + w.d + ' ' + MON[w.m] + ' ' + w.y; }
  function clockText(ms, off) { var w = wall(ms, off); return pad2(w.h) + ':' + pad2(w.mi); }
  function whenText(ms, off) { return ms === null || ms === undefined ? '' : dayText(ms, off) + ', ' + clockText(ms, off); }
  function isoDay(ms, off) { var w = wall(ms, off); return w.y + '-' + pad2(w.m + 1) + '-' + pad2(w.d); }
  function shortDay(ms, off) { var w = wall(ms, off); return w.d + ' ' + MON[w.m]; }
  function spanText(a, b, off) {
    if (a === null || b === null) return '';
    var wa = wall(a, off), wb = wall(b, off);
    if (wa.y === wb.y && wa.m === wb.m && wa.d === wb.d) return wa.d + ' ' + MON[wa.m] + ' ' + wa.y;
    if (wa.y === wb.y) return wa.d + ' ' + MON[wa.m] + ' – ' + wb.d + ' ' + MON[wb.m] + ' ' + wb.y;
    return wa.d + ' ' + MON[wa.m] + ' ' + wa.y + ' – ' + wb.d + ' ' + MON[wb.m] + ' ' + wb.y;
  }
  function modeOffset(rows) {
    var c = new Map(), best = 0, bestN = 0;
    rows.forEach(function (r) { if (r.time === null) return; var o = r.off || 0; var n = (c.get(o) || 0) + 1; c.set(o, n); if (n > bestN) { bestN = n; best = o; } });
    return best;
  }

  /* ================================================================== *
   * Settings: checking preferences only - never a decision
   * ================================================================== */

  var REQUIRABLE = ['id', 'time', 'case', 'outcome', 'score', 'model', 'modelVersion', 'prompt', 'promptVersion', 'temperature', 'seed', 'inputs', 'tools', 'rules', 'hash'];
  var REQ_LABEL = { id: 'Decision id', time: 'Time', case: 'Case id', outcome: 'Outcome', score: 'Score', model: 'Model id', modelVersion: 'Model version', prompt: 'Prompt id', promptVersion: 'Prompt version or hash', temperature: 'Temperature', seed: 'Seed', inputs: 'Inputs or their hash', tools: 'Tool calls', rules: 'Policy rules', hash: 'A hash on every record' };
  var DEFAULT_SETTINGS = {
    version: 1,
    required: ['id', 'time', 'model', 'modelVersion', 'promptVersion', 'inputs', 'outcome'],
    when: { reasonsIfAdverse: true, reviewerIfOverride: true, whyIfOverride: false },
    adverse: ['decline'],
    maxReasons: 4,
    codes: [],
    words: [],
    determinism: { temperatureZero: true, seed: false },
    canon: 'canonical',
    prevInInput: true,
    presets: [],
  };
  function defaults() { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
  var SETTINGS_KEYS = ['version', 'required', 'when', 'adverse', 'maxReasons', 'codes', 'words', 'determinism', 'canon', 'prevInInput', 'presets', 'updatedAt'];

  /** Could this be a piece of a decision record - an address, an id, a
   *  hash, an amount or a date? Settings and the AI request refuse it. */
  function looksLikeData(s) {
    s = str(s);
    return /@/.test(s) || /\d{5,}/.test(s) || /(?:\d[\s.-]?){8,}/.test(s) || longHex(s) || /\d[.,]\d{2}\b(?![.\d])/.test(s) && /[$€£¥]/.test(s) || /[$€£¥]\s*\d/.test(s) || /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/.test(s) || /[<>{}\\`]/.test(s) || BAD1.test(s);
  }
  /** A hash-like run: 16+ hex characters, or 12+ that mix digits and a-f. */
  function longHex(s) {
    var m = str(s).match(/[0-9a-f]{12,}/gi);
    return Boolean(m && m.some(function (x) { return x.length >= 16 || (/\d/.test(x) && /[a-f]/i.test(x)); }));
  }
  var CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-/]{0,15}$/;
  var PATH_SEG = /^[A-Za-z0-9_$ \-:()#[\]]+$/;
  function pathOk(p) {
    var s = str(p);
    if (!s || s.length > LIMITS.pathChars || looksLikeData(s)) return false;
    return s.split('.').every(function (seg) { return seg && seg.length <= 40 && PATH_SEG.test(seg); });
  }
  function onlyKeys(o, keys) { return isObj(o) && Object.keys(o).every(function (k) { return keys.indexOf(k) >= 0; }); }

  /** The settings, checked. Strict mode (the server) lists every problem:
   *  unknown keys anywhere, lists too long, a code, a word, a preset name or
   *  a key path that looks like decision data. */
  function cleanSettings(raw, strict) {
    var errors = [], out = defaults();
    var err = function (m) { errors.push(m); };
    if (!isObj(raw)) return { settings: out, errors: ['Settings must be an object.'] };
    Object.keys(raw).forEach(function (k) { if (SETTINGS_KEYS.indexOf(k) < 0) err('Unknown setting: ' + line(k, 30) + '.'); });
    if (raw.version !== undefined && raw.version !== 1) err('Unknown settings version.');
    if (raw.required !== undefined) {
      if (!Array.isArray(raw.required) || raw.required.length > REQUIRABLE.length) err('The must-record list is a list of fields.');
      else {
        var req = [];
        raw.required.forEach(function (f) { if (REQUIRABLE.indexOf(f) < 0) err('Unknown must-record field.'); else if (req.indexOf(f) < 0) req.push(f); });
        out.required = REQUIRABLE.filter(function (f) { return req.indexOf(f) >= 0; });
      }
    }
    if (raw.when !== undefined) {
      if (!onlyKeys(raw.when, ['reasonsIfAdverse', 'reviewerIfOverride', 'whyIfOverride'])) err('Unknown must-record rule.');
      else Object.keys(raw.when).forEach(function (k) { if (typeof raw.when[k] !== 'boolean') err('A must-record rule is yes or no.'); else out.when[k] = raw.when[k]; });
    }
    if (raw.adverse !== undefined) {
      if (!Array.isArray(raw.adverse) || raw.adverse.length > OUTCOMES.length) err('Adverse outcomes are a list.');
      else {
        var adv = [];
        raw.adverse.forEach(function (o) { if (OUTCOMES.indexOf(o) < 0) err('Unknown outcome.'); else if (adv.indexOf(o) < 0) adv.push(o); });
        out.adverse = OUTCOMES.filter(function (o) { return adv.indexOf(o) >= 0; });
      }
    }
    if (raw.maxReasons !== undefined) {
      if (typeof raw.maxReasons !== 'number' || Math.floor(raw.maxReasons) !== raw.maxReasons || raw.maxReasons < 1 || raw.maxReasons > LIMITS.maxReasons) err('The most reasons is 1 to ' + LIMITS.maxReasons + '.');
      else out.maxReasons = raw.maxReasons;
    }
    if (raw.codes !== undefined) {
      if (!Array.isArray(raw.codes) || raw.codes.length > LIMITS.codes) err('At most ' + LIMITS.codes + ' reason codes.');
      else raw.codes.forEach(function (c) {
        if (!onlyKeys(c, ['code', 'text'])) { err('A reason code holds its code and its words - nothing else.'); return; }
        var code = typeof c.code === 'string' ? c.code.trim() : '';
        var text = typeof c.text === 'string' ? line(c.text, LIMITS.codeText + 1) : '';
        if (!CODE_RE.test(code) || /\d{5,}/.test(code)) { err('A reason code is 1 to 16 letters, digits, dots or dashes - like R02.'); return; }
        if (text.length > LIMITS.codeText) { err('A reason’s words are at most ' + LIMITS.codeText + ' characters.'); return; }
        if (looksLikeData(c.text) || looksLikeData(code)) { err('A reason code or its words must not look like a record - no addresses, ids, hashes, amounts or dates.'); return; }
        out.codes = out.codes.filter(function (x) { return x.code.toLowerCase() !== code.toLowerCase(); });
        out.codes.push({ code: code, text: text });
      });
    }
    if (raw.words !== undefined) {
      if (!Array.isArray(raw.words) || raw.words.length > LIMITS.words) err('At most ' + LIMITS.words + ' outcome words.');
      else raw.words.forEach(function (w) {
        if (!onlyKeys(w, ['word', 'outcome'])) { err('An outcome word holds the word and the outcome it means.'); return; }
        var word = typeof w.word === 'string' ? line(w.word, LIMITS.wordChars + 1) : '';
        if (!word || word.length > LIMITS.wordChars) { err('An outcome word is 1 to ' + LIMITS.wordChars + ' characters.'); return; }
        if (looksLikeData(w.word) || /\d{3,}/.test(word)) { err('An outcome word must not look like a record.'); return; }
        if (OUTCOMES.indexOf(w.outcome) < 0) { err('An outcome word means approve, decline, refer or flag.'); return; }
        out.words = out.words.filter(function (x) { return fold(x.word) !== fold(word); });
        out.words.push({ word: word, outcome: w.outcome });
      });
    }
    if (raw.determinism !== undefined) {
      if (!onlyKeys(raw.determinism, ['temperatureZero', 'seed'])) err('Unknown determinism rule.');
      else Object.keys(raw.determinism).forEach(function (k) { if (typeof raw.determinism[k] !== 'boolean') err('A determinism rule is yes or no.'); else out.determinism[k] = raw.determinism[k]; });
    }
    if (raw.canon !== undefined) { if (RECIPES[raw.canon]) out.canon = raw.canon; else err('The hash recipe is canonical JSON or the raw line.'); }
    if (raw.prevInInput !== undefined) { if (typeof raw.prevInInput === 'boolean') out.prevInInput = raw.prevInInput; else err('Whether the previous hash is hashed is yes or no.'); }
    if (raw.presets !== undefined) {
      if (!Array.isArray(raw.presets) || raw.presets.length > LIMITS.presets) err('At most ' + LIMITS.presets + ' field presets.');
      else raw.presets.forEach(function (p) {
        if (!onlyKeys(p, ['name', 'map'])) { err('A preset holds its name and its key names - nothing else.'); return; }
        var name = typeof p.name === 'string' ? line(p.name, LIMITS.presetName + 1) : '';
        if (!name || name.length > LIMITS.presetName || looksLikeData(p.name) || /\d{4,}/.test(name)) { err('A preset name is 1 to ' + LIMITS.presetName + ' characters and must not look like a record.'); return; }
        if (!isObj(p.map)) { err('A preset maps fields to key names.'); return; }
        var m = {}, bad = false;
        Object.keys(p.map).forEach(function (f) {
          if (FIELDS.indexOf(f) < 0) { bad = true; err('A preset names an unknown field.'); return; }
          var v = p.map[f];
          if (v === null) return;
          if (typeof v !== 'string' || !pathOk(v)) { bad = true; err('A preset’s key names must be key names (letters, digits, dots, dashes) - never a value, an id or a hash.'); return; }
          m[f] = v;
        });
        if (bad) return;
        if (!Object.keys(m).length) { err('A preset maps at least one field.'); return; }
        out.presets = out.presets.filter(function (x) { return fold(x.name) !== fold(name); });
        out.presets.push({ name: name, map: m });
      });
    }
    if (raw.updatedAt !== undefined) { if (typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt) && raw.updatedAt >= 0) out.updatedAt = Math.floor(raw.updatedAt); else err('Bad updatedAt.'); }
    return { settings: out, errors: strict ? errors : [] };
  }
  /** Two copies brought together: every reason code, outcome word and
   *  preset from both (this device's wins where both name the same one);
   *  the other choices this device's. */
  function mergeSettings(account, device) {
    var a = cleanSettings(account).settings, d = cleanSettings(device).settings;
    var out = cleanSettings(d).settings, added = 0;
    a.codes.forEach(function (c) { if (!out.codes.some(function (x) { return x.code.toLowerCase() === c.code.toLowerCase(); }) && out.codes.length < LIMITS.codes) { out.codes.push(c); added++; } });
    a.words.forEach(function (w) { if (!out.words.some(function (x) { return fold(x.word) === fold(w.word); }) && out.words.length < LIMITS.words) { out.words.push(w); added++; } });
    a.presets.forEach(function (p) { if (!out.presets.some(function (x) { return fold(x.name) === fold(p.name); }) && out.presets.length < LIMITS.presets) { out.presets.push(p); added++; } });
    delete out.updatedAt;
    return { settings: out, added: added };
  }
  /** Reason codes from pasted lines: "R02, Debt service coverage below
   *  policy" (a comma, a tab, a colon or " - " between). */
  function parseCodes(text) {
    var codes = [], errors = [];
    str(text).split(/\r?\n/).slice(0, LIMITS.codes + 20).forEach(function (l, k) {
      var s = l.trim();
      if (!s) return;
      var m = /^([^\s,;:\t]+)\s*(?:,|;|:|\t| - | – |\s)\s*(.*)$/.exec(s);
      var code = m ? m[1] : s, text2 = m ? m[2] : '';
      var chk = cleanSettings({ codes: [{ code: code, text: text2 }] }, true);
      if (chk.errors.length) errors.push('Line ' + (k + 1) + ': ' + chk.errors[0]);
      else codes.push(chk.settings.codes[0]);
    });
    if (codes.length > LIMITS.codes) { errors.push('At most ' + LIMITS.codes + ' reason codes.'); codes = codes.slice(0, LIMITS.codes); }
    return { codes: codes, errors: errors };
  }
  function codesText(codes) { return (codes || []).map(function (c) { return c.code + ', ' + c.text; }).join('\n'); }
  /** A preset whose key names this log has (at least four in five of them). */
  function presetFor(settings, keys) {
    var have = {};
    keys.forEach(function (k) { have[k.path] = 1; });
    var best = null, bestN = 0;
    (settings.presets || []).forEach(function (p) {
      var paths = Object.keys(p.map).map(function (f) { return p.map[f]; });
      var hit = paths.filter(function (x) { return have[x]; }).length;
      if (paths.length && hit / paths.length >= 0.8 && hit > bestN) { best = p; bestN = hit; }
    });
    return best;
  }

  /* ================================================================== *
   * The change log (pasted, never stored)
   * ================================================================== */

  function parseChangeLog(text) {
    var entries = [], errors = [];
    str(text).split(/\r?\n/).slice(0, LIMITS.changeLog).forEach(function (l, k) {
      var s = line(l, LIMITS.changeChars);
      if (!s || /^#/.test(s)) return;
      var parts = s.split(/\t|\s*[,;|]\s*/);
      if (parts.length < 2) { errors.push('Line ' + (k + 1) + ': write it as date, version, approver.'); return; }
      var t = parseTime(parts[0]);
      if (!t) { errors.push('Line ' + (k + 1) + ': the date is not one Replay can read - use 2026-10-21.'); return; }
      var version = line(parts[1], 90);
      var approver = line(parts.slice(2).join(', ').replace(/^(approved|signed off|okayed)\s+by\s*/i, ''), 80);
      if (!version) { errors.push('Line ' + (k + 1) + ': no version.'); return; }
      entries.push({ line: k + 1, day: isoDay(t.ms, t.off || 0), ms: t.ms, version: version, approver: approver });
    });
    return { entries: entries, errors: errors };
  }
  function versionMatches(entryVersion, label) {
    var e = str(entryVersion).toLowerCase(), v = str(label).toLowerCase();
    if (!e || !v) return false;
    if (e === v) return true;
    var i = e.indexOf(v);
    while (i >= 0) {
      var before = i === 0 ? '' : e.charAt(i - 1), after = e.charAt(i + v.length);
      if ((!before || /[\s_@:\-/v]/.test(before)) && (!after || /[\s,;)]/.test(after))) return true;
      i = e.indexOf(v, i + 1);
    }
    return false;
  }

  /* ================================================================== *
   * The checks
   * ================================================================== */

  var ORDER = ['unreadable', 'unmapped', 'chain-changed', 'chain-unlinked', 'chain-scheme', 'seq-gap', 'dup-id', 'adverse-none', 'adverse-unknown', 'same-inputs', 'temperature', 'drift-unlogged', 'override-noreviewer', 'incomplete', 'time-bad', 'chain-partial', 'chain-none', 'gap', 'order', 'adverse-many', 'seed', 'drift-early', 'override-noreason', 'outcome-unknown', 'chain-format', 'drift-noapprover', 'override-rate', 'drift-nolog', 'codes-nolist', 'truncated'];
  function finding(key, sev, title, detail, rows, extra) {
    rows = rows || [];
    return { key: key, sev: sev, title: title, detail: detail, count: rows.length, refs: rows.slice(0, LIMITS.refs).map(ref), more: Math.max(0, rows.length - LIMITS.refs), all: rows.map(function (r) { return r.i; }), extra: extra || null };
  }
  function sortFindings(list) {
    return list.sort(function (a, b) { return SEV.indexOf(a.sev) - SEV.indexOf(b.sev) || ORDER.indexOf(a.key) - ORDER.indexOf(b.key); });
  }
  function codeIndex(codes) { var m = new Map(); (codes || []).forEach(function (c) { m.set(c.code.toLowerCase(), c); }); return m; }

  /** What a record must carry under the profile, and what it is missing. */
  function missingFor(row, map, s) {
    var miss = [];
    s.required.forEach(function (f) {
      if (f === 'inputs') { if (!row.has.inputs && !row.has.inputsHash) miss.push('inputs'); return; }
      if (!row.has[f]) miss.push(f);
    });
    var adverse = row.outcome && s.adverse.indexOf(row.outcome) >= 0;
    if (s.when.reasonsIfAdverse && adverse && !(row.reasons && row.reasons.length)) miss.push('reasons');
    if (s.when.reviewerIfOverride && row.override === true && !row.has.reviewer) miss.push('reviewer');
    if (s.when.whyIfOverride && row.override === true && !row.has.overrideReason) miss.push('overrideReason');
    return miss;
  }
  function nondeterministic(row, map, s) {
    var why = [];
    if (s.determinism.temperatureZero && map.temperature && row.temperature !== null && row.temperature > 0) why.push('temperature');
    if (s.determinism.seed && !row.has.seed) why.push('seed');
    return why;
  }
  var MISS_WORD = { id: 'no decision id', time: 'no time', case: 'no case id', outcome: 'no outcome', score: 'no score', model: 'no model id', modelVersion: 'no model version', prompt: 'no prompt id', promptVersion: 'no prompt version or hash', temperature: 'no temperature', seed: 'no seed', inputs: 'neither the inputs nor their hash', tools: 'no tool calls recorded', rules: 'no policy rules', hash: 'no hash', reasons: 'an adverse outcome with no reasons', reviewer: 'an override with no reviewer', overrideReason: 'an override with no reason given' };

  function checkCompleteness(rows, map, s, F) {
    var unmapped = s.required.filter(function (f) { return f === 'inputs' ? !map.inputs && !map.inputsHash : !map[f]; });
    unmapped.forEach(function (f) {
      F.push(finding('unmapped', 'critical', 'Your log has no field for ' + REQ_LABEL[f].toLowerCase(), 'The must-record profile asks for ' + REQ_LABEL[f].toLowerCase() + ' on every decision, and no key in this log holds it - so no record can be replayed on that point. If it is there under another name, choose it on the Fields tab.', [], { field: f }));
    });
    var byField = {}, bad = [];
    rows.forEach(function (r) {
      var miss = missingFor(r, map, s).filter(function (f) { return unmapped.indexOf(f) < 0; });
      r.missing = missingFor(r, map, s);
      if (miss.length) { bad.push(r); miss.forEach(function (f) { (byField[f] = byField[f] || []).push(r); }); }
    });
    if (bad.length) {
      var parts = Object.keys(byField).sort(function (a, b) { return byField[b].length - byField[a].length; }).map(function (f) { return { field: f, count: byField[f].length, words: MISS_WORD[f] }; });
      F.push(finding('incomplete', 'high', plural(bad.length, 'record') + ' ' + (bad.length === 1 ? 'is' : 'are') + ' missing something the profile requires', 'Against your must-record profile: ' + parts.map(function (p) { return groups(p.count) + ' with ' + p.words; }).join('; ') + '. A record missing any of these cannot be replayed or fully explained.', bad, { parts: parts }));
    }
  }

  function checkAdverse(rows, map, s, F) {
    if (!map.outcome) return;
    var codes = codeIndex(s.codes);
    var adverse = rows.filter(function (r) { return r.outcome && s.adverse.indexOf(r.outcome) >= 0; });
    var words = s.adverse.map(function (o) { return OUTCOME_WORD[o].toLowerCase() + 's'; });
    var name = words.length === 1 ? words[0] : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
    var none = adverse.filter(function (r) { return !(r.reasons && r.reasons.length); });
    if (none.length) F.push(finding('adverse-none', 'critical', plural(none.length, 'adverse outcome') + ' with no reasons', groups(none.length) + ' of ' + groups(adverse.length) + ' ' + name + ' carry no reason code. When a customer, an auditor or an examiner asks why, the log has no answer to give - an adverse-action notice usually has to state the principal reasons.', none));
    var many = adverse.filter(function (r) { return r.reasons && r.reasons.length > s.maxReasons; });
    if (many.length) F.push(finding('adverse-many', 'medium', plural(many.length, 'adverse outcome') + ' with more than ' + s.maxReasons + ' reasons', 'Your profile caps the principal reasons at ' + s.maxReasons + '. A long list is harder to explain and may not say which reasons mattered most - check your policy for how many to give.', many));
    if (s.codes.length) {
      var unknown = [], seen = new Map();
      rows.forEach(function (r) {
        if (!r.reasons) return;
        var bad = r.reasons.filter(function (c) { return !codes.has(c.toLowerCase()); });
        if (bad.length) { unknown.push(r); bad.forEach(function (c) { seen.set(c, (seen.get(c) || 0) + 1); }); }
      });
      if (unknown.length) {
        var list = Array.from(seen.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 12);
        F.push(finding('adverse-unknown', 'high', plural(unknown.length, 'record') + ' with reason codes your list does not explain', 'These codes are not on your reason-code list, so there are no plain words to give the customer for them: ' + list.map(function (x) { return x[0] + ' (' + groups(x[1]) + ')'; }).join(', ') + '. Add them to the list in Settings, or find where they came from.', unknown, { codes: list.map(function (x) { return { code: x[0], count: x[1] }; }) }));
      }
    } else if (map.reasons) {
      F.push(finding('codes-nolist', 'info', 'No reason-code list to check against', 'Add your reason codes and their plain-language words in Settings. Replay then flags codes nobody can explain and writes the reasons in words in every replay pack.', []));
    }
  }

  function checkDeterminism(rows, map, s, F) {
    if (s.determinism.temperatureZero && map.temperature) {
      var hot = rows.filter(function (r) { return r.temperature !== null && r.temperature > 0; });
      if (hot.length) {
        var temps = new Map();
        hot.forEach(function (r) { temps.set(r.temperature, (temps.get(r.temperature) || 0) + 1); });
        var tl = Array.from(temps.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 6).map(function (x) { return x[0] + ' (' + groups(x[1]) + ')'; });
        F.push(finding('temperature', 'high', plural(hot.length, 'decision') + ' made at a temperature above 0 (' + pct(hot.length, rows.length) + ')', 'Your profile says decision calls run at temperature 0. These ran at ' + tl.join(', ') + ', so the same inputs can give a different answer each time - a replay may not reproduce the decision.', hot, { temps: tl }));
      }
    }
    if (s.determinism.seed) {
      var noSeed = rows.filter(function (r) { return !r.has.seed; });
      if (noSeed.length) F.push(finding('seed', 'medium', plural(noSeed.length, 'decision') + ' with no seed recorded', 'Your profile asks for a seed on every call, so a replay can draw the same sample. These records have none.', noSeed));
    }
    if (!map.inputsHash && !map.inputs) return;
    var groupsByInput = new Map();
    rows.forEach(function (r) { if (r.inKey && r.outcome) { var g = groupsByInput.get(r.inKey); if (!g) { g = []; groupsByInput.set(r.inKey, g); } g.push(r); } });
    var hits = [], all = [];
    groupsByInput.forEach(function (g) {
      var outs = {};
      g.forEach(function (r) { outs[r.outcome] = 1; });
      if (Object.keys(outs).length < 2) return;
      var vs = {};
      g.forEach(function (r) { vs[r.modelVersion + '|' + r.promptVersion] = 1; });
      var same = Object.keys(vs).length === 1;
      var overridden = g.some(function (r) { return r.override === true; });
      hits.push({ rows: g, same: same, overridden: overridden });
      g.forEach(function (r) { all.push(r); });
    });
    if (hits.length) {
      var strict = hits.filter(function (h) { return h.same && !h.overridden; });
      var sev = strict.length ? 'high' : 'medium';
      var first = hits[0];
      var detail = (hits.length === 1 ? 'One set of identical inputs' : groups(hits.length) + ' sets of identical inputs') + ' led to different outcomes' +
        (strict.length ? (strict.length === hits.length ? ', under the same model and prompt versions and with no person overriding' : ' - ' + groups(strict.length) + ' of them under the same model and prompt versions with no override') + '. Replaying one will not say which answer was right.' : ', each explained by a version change or an override - worth checking that is the whole story.') +
        ' First: ' + first.rows.map(function (r) { return nameOf(r) + ' → ' + (OUTCOME_WORD[r.outcome] || r.outcomeRaw); }).join(', ') + '.';
      F.push(finding('same-inputs', sev, 'The same inputs gave different outcomes', detail, all, {
        groups: hits.slice(0, LIMITS.groups).map(function (h) { return { same: h.same, overridden: h.overridden, refs: h.rows.slice(0, 10).map(ref), versions: h.rows.slice(0, 10).map(function (r) { return [r.modelVersion, r.promptVersion]; }) }; }),
      }));
    }
  }

  function versionsOf(rows, kind) {
    var key = kind === 'model' ? 'modelVersion' : 'promptVersion', idk = kind === 'model' ? 'model' : 'prompt';
    var timed = rows.filter(function (r) { return r.time !== null && r.has[key]; }).sort(function (a, b) { return a.time - b.time || a.i - b.i; });
    var ids = {};
    timed.forEach(function (r) { if (r[idk]) ids[r[idk]] = 1; });
    var multi = Object.keys(ids).length > 1;
    var label = function (r) { return multi && r[idk] ? r[idk] + ' ' + r[key] : r[key]; };
    var by = new Map(), runs = [], changes = [];
    timed.forEach(function (r) {
      var l = label(r), v = by.get(l);
      if (!v) { v = { label: l, version: r[key], count: 0, first: r.time, last: r.time, firstOff: r.off, firstRef: ref(r), firstRow: r }; by.set(l, v); }
      v.count++; v.last = r.time;
      var cur = runs[runs.length - 1];
      if (!cur || cur.label !== l) {
        if (cur) changes.push({ kind: kind, from: cur.label, to: l, at: r.time, off: r.off, ref: ref(r) });
        if (runs.length < 400) runs.push({ label: l, from: r.time, to: r.time, count: 1 });
        else runs[runs.length - 1].to = r.time;
      } else { cur.to = r.time; cur.count++; }
    });
    var list = Array.from(by.values()).sort(function (a, b) { return a.first - b.first; });
    return { kind: kind, versions: list, runs: runs, changes: changes, mixed: changes.length > list.length * 2 };
  }

  function checkDrift(rows, map, s, F, log, report) {
    var kinds = [];
    if (map.modelVersion) kinds.push(versionsOf(rows, 'model'));
    if (map.promptVersion) kinds.push(versionsOf(rows, 'prompt'));
    report.drift = kinds.map(function (k) { return { kind: k.kind, versions: k.versions.map(function (v) { return { label: v.label, version: v.version, count: v.count, first: v.first, last: v.last, off: v.firstOff, firstRef: v.firstRef }; }), runs: k.runs, changes: k.changes, mixed: k.mixed }; });
    var changes = kinds.reduce(function (a, k) { return a + k.changes.length; }, 0);
    if (!log || !log.entries.length) {
      if (changes) F.push(finding('drift-nolog', 'info', plural(changes, 'version change') + ', no change log to check ' + (changes === 1 ? 'it' : 'them') + ' against', kinds.filter(function (k) { return k.changes.length; }).map(function (k) { return (k.kind === 'model' ? 'The model' : 'The prompt') + ' changed ' + (k.changes.length === 1 ? 'once' : groups(k.changes.length) + ' times') + ': ' + k.versions.map(function (v) { return v.label + ' (' + plural(v.count, 'decision') + ')'; }).join(', '); }).join('. ') + '. Paste your change log (date, version, approver) to check every version that made a decision was approved before it did.', []));
      return;
    }
    var unlogged = [], early = [], unlRows = [], earlyRows = [];
    kinds.forEach(function (k) {
      k.versions.forEach(function (v) {
        var e = log.entries.filter(function (x) { return versionMatches(x.version, v.version) || versionMatches(x.version, v.label); })[0];
        v.entry = e || null;
        if (!e) { unlogged.push({ kind: k.kind, v: v }); unlRows.push(v.firstRow); return; }
        if (isoDay(v.first, v.firstOff || 0) < e.day) { early.push({ kind: k.kind, v: v, e: e }); earlyRows.push(v.firstRow); }
      });
    });
    report.drift.forEach(function (k, idx) { k.versions.forEach(function (v, j) { var e = kinds[idx].versions[j].entry; v.entry = e ? { day: e.day, version: e.version, approver: e.approver, line: e.line } : null; }); });
    if (unlogged.length) {
      F.push(finding('drift-unlogged', 'high', plural(unlogged.length, 'version') + ' made decisions with no change-log entry', unlogged.map(function (u) { return (u.kind === 'model' ? 'Model' : 'Prompt') + ' version ' + u.v.label + ' first decided on ' + dayText(u.v.first, u.v.firstOff) + ', in ' + nameOf(u.v.firstRow) + ', and made ' + plural(u.v.count, 'decision') + ' - your change log has no entry for it.'; }).join(' ') + ' Nobody can show who approved it, or what changed.', unlRows, { versions: unlogged.map(function (u) { return { kind: u.kind, label: u.v.label, first: u.v.first, off: u.v.firstOff, count: u.v.count }; }) }));
    }
    if (early.length) {
      F.push(finding('drift-early', 'medium', plural(early.length, 'version') + ' used before the date it was approved', early.map(function (u) { return (u.kind === 'model' ? 'Model' : 'Prompt') + ' version ' + u.v.label + ' first decided on ' + dayText(u.v.first, u.v.firstOff) + ', but the change log approves it on ' + u.e.day + '.'; }).join(' '), earlyRows));
    }
    var noAppr = log.entries.filter(function (e) { return !e.approver; });
    if (noAppr.length) F.push(finding('drift-noapprover', 'low', plural(noAppr.length, 'change-log entry', 'change-log entries') + ' with no approver', 'Lines ' + noAppr.map(function (e) { return e.line; }).join(', ') + ' of the change log name no approver.', []));
  }

  function checkOverrides(rows, map, s, F, report) {
    if (!map.override) { report.overrides = null; return; }
    var over = rows.filter(function (r) { return r.override === true; });
    var byRev = new Map(), byOut = new Map();
    rows.forEach(function (r) {
      var reviewed = r.has.reviewer || r.override === true;
      if (!reviewed) return;
      var who = r.has.reviewer ? r.reviewer : '(no reviewer recorded)';
      var x = byRev.get(who); if (!x) { x = { who: who, reviewed: 0, overrides: 0, none: !r.has.reviewer }; byRev.set(who, x); }
      x.reviewed++; if (r.override === true) x.overrides++;
      var o = r.outcome ? (OUTCOME_WORD[r.outcome] || r.outcomeRaw || 'Other') : '(no outcome)';
      var y = byOut.get(o); if (!y) { y = { outcome: o, reviewed: 0, overrides: 0 }; byOut.set(o, y); }
      y.reviewed++; if (r.override === true) y.overrides++;
    });
    var rev = Array.from(byRev.values()).sort(function (a, b) { return (a.none ? 1 : 0) - (b.none ? 1 : 0) || b.overrides - a.overrides || (a.who < b.who ? -1 : 1); });
    var out = Array.from(byOut.values()).sort(function (a, b) { return b.overrides - a.overrides; });
    var reviewed = rows.filter(function (r) { return r.has.reviewer || r.override === true; }).length;
    report.overrides = { total: over.length, reviewed: reviewed, byReviewer: rev.slice(0, 50), byOutcome: out };
    var noRev = over.filter(function (r) { return !r.has.reviewer; });
    if (noRev.length) F.push(finding('override-noreviewer', 'high', plural(noRev.length, 'override') + ' with no reviewer', groups(noRev.length) + ' of ' + groups(over.length) + ' overrides do not say who made them. A person changed what the model decided, and the log cannot say who.', noRev));
    var noWhy = map.overrideReason ? over.filter(function (r) { return !r.has.overrideReason; }) : over;
    if (noWhy.length) F.push(finding('override-noreason', 'medium', plural(noWhy.length, 'override') + ' with no reason given', map.overrideReason ? groups(noWhy.length) + ' of ' + groups(over.length) + ' overrides record no reason. The next person to ask will not know why the model was set aside.' : 'This log has no field for why a decision was overridden, so none of its ' + plural(over.length, 'override') + ' can be explained. If it is there under another name, choose it on the Fields tab.', noWhy));
    var named = rev.filter(function (x) { return !x.none; });
    var tot = named.reduce(function (a, x) { return a + x.reviewed; }, 0), totO = named.reduce(function (a, x) { return a + x.overrides; }, 0);
    var avg = tot ? totO / tot : 0;
    var heavy = named.filter(function (x) { return x.reviewed >= 10 && x.overrides >= 3 && avg > 0 && x.overrides / x.reviewed >= 2 * avg; });
    if (heavy.length) {
      var heavyRows = rows.filter(function (r) { return r.override === true && heavy.some(function (h) { return h.who === r.reviewer; }); });
      F.push(finding('override-rate', 'info', plural(heavy.length, 'reviewer') + ' override' + (heavy.length === 1 ? 's' : '') + ' far more often than the rest', heavy.map(function (h) { return h.who + ' overrode ' + groups(h.overrides) + ' of ' + groups(h.reviewed) + ' (' + pct(h.overrides, h.reviewed) + ')'; }).join('; ') + ', against ' + pct(totO, tot) + ' for everyone. Not wrong in itself - worth a look at what they see that the model does not.', heavyRows));
    }
  }

  /** Periods with nothing logged during what is normally busy time. The
   *  usual volume is worked out per hour of the day, weekdays and weekends
   *  apart, in the log's own clock; a quiet stretch is flagged when the
   *  usual volume would have put at least `expect` decisions in it - seeing
   *  none then happens by chance about e^-expect of the time. */
  function checkTimeGaps(rows, F, report, expect) {
    var ts = rows.filter(function (r) { return r.time !== null; }).sort(function (a, b) { return a.time - b.time || a.i - b.i; });
    report.days = [];
    if (ts.length < 50) return;
    var off = modeOffset(ts), H = 3600000;
    var first = ts[0].time, last = ts[ts.length - 1].time;
    if (last - first < 2 * 86400000 || last - first > 800 * 86400000) return;
    // A log written in batches (most records share the second of the one
    // before) is quiet between batches by design: no gap is a finding.
    var same = 0;
    for (var q = 1; q < ts.length; q++) if (Math.floor(ts[q].time / 1000) === Math.floor(ts[q - 1].time / 1000)) same++;
    report.batched = same >= ts.length * 0.5;
    var counts = [new Array(24).fill(0), new Array(24).fill(0)], occ = [new Array(24).fill(0), new Array(24).fill(0)];
    var type = function (w) { return w.dow === 0 || w.dow === 6 ? 1 : 0; };
    var startH = Math.floor((first + off * 60000) / H), endH = Math.floor((last + off * 60000) / H);
    for (var h = startH; h <= endH; h++) { var w = wall(h * H, 0); occ[type(w)][w.h]++; }
    var days = new Map();
    ts.forEach(function (r) {
      var w = wall(r.time, off); counts[type(w)][w.h]++;
      var k = isoDay(r.time, off), d = days.get(k);
      if (!d) { d = { day: k, dow: w.dow, count: 0, hours: new Array(24).fill(0) }; days.set(k, d); }
      d.count++; d.hours[w.h]++;
    });
    // every day in the span, so a day with nothing logged is drawn as zero
    for (var dd = Math.floor((first + off * 60000) / 86400000); dd <= Math.floor((last + off * 60000) / 86400000) && days.size < 900; dd++) {
      var dk = isoDay(dd * 86400000, 0);
      if (!days.has(dk)) days.set(dk, { day: dk, dow: wall(dd * 86400000, 0).dow, count: 0, hours: new Array(24).fill(0) });
    }
    report.days = Array.from(days.values()).sort(function (a, b) { return a.day < b.day ? -1 : 1; }).slice(0, 800);
    var rate = function (t, hr) { return occ[t][hr] ? counts[t][hr] / occ[t][hr] : 0; };
    var gaps = [], gapRows = [];
    for (var k = report.batched ? ts.length : 1; k < ts.length; k++) {
      var a = ts[k - 1].time, b = ts[k].time;
      if (b - a < 30 * 60000) continue;
      var aw = a + off * 60000, bw = b + off * 60000, lam = 0;
      for (var hh = Math.floor(aw / H); hh <= Math.floor(bw / H); hh++) {
        var s0 = Math.max(aw, hh * H), s1 = Math.min(bw, (hh + 1) * H);
        if (s1 <= s0) continue;
        var wh = wall(hh * H, 0);
        lam += rate(type(wh), wh.h) * (s1 - s0) / H;
      }
      if (lam >= expect) { gaps.push({ from: ref(ts[k - 1]), to: ref(ts[k]), a: a, b: b, off: off, minutes: Math.round((b - a) / 60000), expected: Math.round(lam * 10) / 10, p: Math.exp(-lam), day: isoDay(a, off) }); gapRows.push(ts[k - 1], ts[k]); }
    }
    report.gaps = gaps.slice(0, 50);
    if (gaps.length) {
      var g0 = gaps[0];
      var dur = function (g) { var m = g.minutes; return m < 120 ? plural(m, 'minute') : (Math.round(m / 6) / 10) + ' hours'; };
      var chance = function (p) { return p < 0.001 ? 'less than 1 in 1,000' : p < 0.01 ? 'less than 1%' : 'about ' + Math.max(1, Math.round(p * 100)) + '%'; };
      F.push(finding('gap', 'medium', plural(gaps.length, 'stretch', 'stretches') + ' with nothing logged at a normally busy time', (gaps.length === 1 ? 'Nothing' : 'The first: nothing') + ' was logged for ' + dur(g0) + ' on ' + dayText(g0.a, off) + ', from ' + clockText(g0.a, off) + ' to ' + clockText(g0.b, off) + ' (' + zoneText(off) + '). At this log’s usual volume for that time about ' + (Math.round(g0.expected * 10) / 10) + ' decisions would land there; seeing none happens by chance ' + chance(g0.p) + ' of the time. A possible logging outage - were decisions made that never reached the log?', gapRows, { gaps: gaps.slice(0, 20).map(function (g) { return { from: g.from, to: g.to, minutes: g.minutes, expected: g.expected, day: g.day, a: g.a, b: g.b, off: g.off, whenText: dayText(g.a, off) + ', ' + clockText(g.a, off) + '–' + clockText(g.b, off) }; }) }));
    }
  }

  function checkOrderAndDuplicates(rows, map, F) {
    if (map.id) {
      var byId = new Map();
      rows.forEach(function (r) { if (!r.id) return; var g = byId.get(r.id); if (!g) { g = []; byId.set(r.id, g); } g.push(r); });
      var dupRows = [], copies = 0, clashes = 0, first = null;
      byId.forEach(function (g) { if (g.length > 1) { dupRows.push.apply(dupRows, g); if (!first) first = g; } });
      if (dupRows.length) {
        F.push(finding('dup-id', 'high', plural(dupRows.length, 'record') + ' share a decision id with another', 'A decision id should name one decision. ' + nameOf(first[0]) + ' appears ' + plural(first.length, 'time') + ' (' + first.map(where).join(', ') + '). Either the same decision was written twice or two different decisions carry one id - and a replay pack cannot say which is the real one.', dupRows));
      }
      // ids like RVT-D-0001: numbered in order, with numbers missing
      var re = /^(.*?)(\d+)$/, prefixes = new Map();
      rows.forEach(function (r) { var m = re.exec(r.id || ''); if (m) prefixes.set(m[1], (prefixes.get(m[1]) || 0) + 1); });
      var top = Array.from(prefixes.entries()).sort(function (a, b) { return b[1] - a[1]; })[0];
      if (top && top[1] >= rows.length * 0.9 && top[1] >= 20) {
        var nums = [];
        rows.forEach(function (r) { var m = re.exec(r.id || ''); if (m && m[1] === top[0]) nums.push(+m[2]); });
        nums.sort(function (a, b) { return a - b; });
        var lo = nums[0], hi = nums[nums.length - 1];
        if (hi - lo + 1 <= nums.length * 1.5 && hi - lo < 2000000) {
          var missing = [], ranges = [], have = new Set(nums);
          for (var x = lo; x <= hi && missing.length < 100000; x++) if (!have.has(x)) missing.push(x);
          missing.forEach(function (v) { var rr = ranges[ranges.length - 1]; if (rr && rr[1] === v - 1) rr[1] = v; else ranges.push([v, v]); });
          if (missing.length) {
            var width = String(rows.filter(function (r) { return re.test(r.id || ''); })[0].id).replace(/^.*?(\d+)$/, '$1').length;
            var fmt = function (v) { var s2 = String(v); while (s2.length < width) s2 = '0' + s2; return top[0] + s2; };
            var near = rows.filter(function (r) { var m = re.exec(r.id || ''); return m && m[1] === top[0] && ranges.some(function (g) { return +m[2] === g[0] - 1 || +m[2] === g[1] + 1; }); });
            F.push(finding('seq-gap', 'high', plural(missing.length, 'decision id') + ' missing from a numbered sequence', 'The ids run from ' + fmt(lo) + ' to ' + fmt(hi) + ', and these numbers are not in the log: ' + ranges.slice(0, 12).map(function (g) { return g[0] === g[1] ? fmt(g[0]) : fmt(g[0]) + '–' + fmt(g[1]); }).join(', ') + (ranges.length > 12 ? ' and more' : '') + '. Records removed, or a counter that skipped - the records either side are listed.', near, { ranges: ranges.slice(0, 50) }));
          }
        }
      }
    }
    if (map.time) {
      var timed = rows.filter(function (r) { return r.time !== null; });
      var back = [], steps = 0;
      for (var i = 1; i < timed.length; i++) { steps++; if (timed[i].time < timed[i - 1].time - 1000) back.push(timed[i]); }
      if (back.length && back.length < steps * 0.9) {
        F.push(finding('order', 'medium', plural(back.length, 'record') + ' earlier than the record before ' + (back.length === 1 ? 'it' : 'them'), 'A log written as decisions happen runs forward in time. These records are dated before the record above them - written late, merged from another source, or edited. First: ' + nameOf(back[0]) + '.', back));
      }
    }
  }

  /** The hash chain, async (SHA-256 is handed in). */
  function checkChain(parsed, rows, map, s, F, report, digest, progress) {
    report.chain = { hashed: 0, verified: 0, changed: 0, unlinked: 0, recipe: s.canon, prevInInput: s.prevInInput, mapped: Boolean(map.hash), prevMapped: Boolean(map.prevHash), status: {} };
    if (!map.hash) {
      F.push(finding('chain-none', 'medium', 'Nothing proves this log was not edited', 'No record carries a hash, so an edited or deleted record would look exactly like the rest. A hash chain - each record carrying a SHA-256 of itself and of the record before it - makes any later change show. How to add one is under “How the hashes are checked”.', []));
      return Promise.resolve();
    }
    var format = parsed.format;
    var recipe = s.canon;
    var note = '';
    if (recipe === 'raw' && format === 'json') { recipe = 'canonical'; note = 'A JSON array has no lines, so its records were hashed as canonical JSON.'; }
    if (recipe === 'raw' && format === 'jsonl' && map.hash.indexOf('.') > 0 && !rows.length) note = '';
    report.chain.recipe = recipe;
    report.chain.note = note;
    var recs = parsed.records;
    var jobs = [], prevStored = null, prevRow = null;
    rows.forEach(function (r) {
      var st = { stored: normHash(r.hash), status: 'nohash' };
      report.chain.status[r.i] = st;
      if (!st.stored) { prevRow = r; prevStored = r.hash; return; }
      report.chain.hashed++;
      if (st.stored.kind === 'bad') st.status = 'badformat';
      var prev = map.prevHash ? r.prev : (prevRow ? prevStored : '');
      st.prev = str(prev === null || prev === undefined ? '' : prev);
      var body = hashBody(recs[r.i], format, map.hash, recipe, parsed.delim);
      if (body === null) { st.status = 'norecipe'; }
      else if (st.status !== 'badformat') jobs.push({ r: r, st: st, input: hashInput(body, st.prev, s.prevInInput) });
      if (map.prevHash) {
        if (!prevRow) st.linked = zeroHash(prev) ? 'genesis' : 'starts-mid';
        else {
          var np = normHash(prev), pp = normHash(prevStored);
          st.linked = np && pp && np.value === pp.value ? 'ok' : 'broken';
        }
      }
      prevRow = r; prevStored = r.hash;
    });
    var done = 0, total = jobs.length, BATCH = 1000;
    function step(k) {
      if (k >= jobs.length) return Promise.resolve();
      var batch = jobs.slice(k, k + BATCH);
      return Promise.all(batch.map(function (j) { return digest(j.input); })).then(function (outs) {
        batch.forEach(function (j, x) { j.st.computed = str(outs[x]).toLowerCase(); j.st.status = hashMatches(j.st.stored, j.st.computed) ? 'ok' : 'changed'; });
        done += batch.length;
        if (progress) progress({ step: 'hash', done: done, total: total });
        return step(k + BATCH);
      });
    }
    return step(0).then(function () {
      var C = report.chain, stored = new Map();
      rows.forEach(function (r) { var st = C.status[r.i]; if (st.stored && st.stored.kind !== 'bad') stored.set(st.stored.value, r); });
      var changed = [], broken = [], missingBefore = [], reordered = [], nohash = [], badformat = [], norecipe = [];
      rows.forEach(function (r) {
        var st = C.status[r.i];
        if (st.status === 'ok') C.verified++;
        else if (st.status === 'changed') changed.push(r);
        else if (st.status === 'nohash') nohash.push(r);
        else if (st.status === 'badformat') badformat.push(r);
        else if (st.status === 'norecipe') norecipe.push(r);
        if (st.linked === 'broken') {
          broken.push(r);
          var np = normHash(st.prev);
          var other = np ? stored.get(np.value) : null;
          st.linkKind = other ? 'reordered' : 'missing';
          if (other) { st.linkTo = ref(other); reordered.push(r); } else missingBefore.push(r);
        }
      });
      C.changed = changed.length; C.unlinked = broken.length;
      var hashedOk = C.hashed - badformat.length - norecipe.length;
      if (norecipe.length) {
        F.push(finding('chain-scheme', 'high', 'These hashes cannot be checked with the raw-line recipe', 'The raw-line recipe removes the hash member from the line as text, so the hash has to be a top-level key (here it is “' + map.hash + '”). Switch the hash recipe to canonical JSON in Settings, or choose the right key on the Fields tab.', norecipe));
      } else if (hashedOk >= 5 && C.verified === 0) {
        var r0 = rows.filter(function (r) { return C.status[r.i].status === 'changed'; })[0];
        var st0 = r0 ? C.status[r0.i] : null;
        F.push(finding('chain-scheme', 'high', 'None of the ' + groups(hashedOk) + ' hashes match Replay’s recipe', 'Every record’s hash differs from what Replay computes (' + RECIPES[recipe].toLowerCase() + ', ' + (s.prevInInput ? 'the previous hash and a line feed first' : 'without the previous hash') + '). That is almost never tampering - it means this log hashes records another way. Try the other recipe in Settings, or compare with “How the hashes are checked”. ' + (st0 ? 'For ' + nameOf(r0) + ' Replay computed ' + st0.computed.slice(0, 16) + '…, the log says ' + str(st0.stored.value).slice(0, 16) + '….' : ''), [], { recipe: recipe }));
        C.scheme = false;
      } else {
        C.scheme = true;
        if (changed.length) {
          var c0 = changed[0];
          var before = rows.filter(function (r) { return r.i < c0.i && C.status[r.i].status === 'ok'; }).length;
          var nextOk = rows.filter(function (r) { return r.i > c0.i; })[0];
          var resumes = nextOk && C.status[nextOk.i].status === 'ok' && (!map.prevHash || C.status[nextOk.i].linked === 'ok');
          F.push(finding('chain-changed', 'critical', changed.length === 1 ? 'One record was changed after it was written' : plural(changed.length, 'record') + ' were changed after they were written', 'The first broken link is ' + nameOf(c0) + (c0.timeRaw ? ', dated ' + c0.timeRaw : '') + ': its hash no longer matches what the record says now, so something in it was edited after it was hashed. ' + (before ? plural(before, 'record') + ' before it check out' : 'Nothing before it checks out') + (resumes ? ', and the chain picks up again at the next record - so it was edited in place, not inserted or removed.' : '.') + ' Treat what it says now as unproven, and find the original.', changed, { first: ref(c0), stored: C.status[c0.i].stored.value, computed: C.status[c0.i].computed, prev: C.status[c0.i].prev }));
        }
        if (broken.length) {
          var b0 = broken[0];
          var bits = [];
          if (missingBefore.length) bits.push(groups(missingBefore.length) + ' point at a record that is not in this log - records missing before them');
          if (reordered.length) bits.push(groups(reordered.length) + ' point at a record elsewhere in the log - records moved out of order');
          F.push(finding('chain-unlinked', 'critical', plural(broken.length, 'record') + ' do' + (broken.length === 1 ? 'es' : '') + ' not follow the record before ' + (broken.length === 1 ? 'it' : 'them'), 'Each record’s previous-hash should equal the hash of the record above it. The first that does not is ' + nameOf(b0) + '. Of the ' + groups(broken.length) + ': ' + bits.join('; ') + '.', broken, { first: ref(b0), kinds: { missing: missingBefore.length, reordered: reordered.length } }));
        }
      }
      if (nohash.length && C.hashed) F.push(finding('chain-partial', 'high', plural(nohash.length, 'record') + ' carr' + (nohash.length === 1 ? 'ies' : 'y') + ' no hash', 'The rest of the log is hashed, so these stand outside the chain: nothing would show if they were edited, and they break the link for the record after them.', nohash));
      if (badformat.length) F.push(finding('chain-format', 'low', plural(badformat.length, 'hash', 'hashes') + ' in a form Replay cannot read', 'Replay reads a SHA-256 as 64 hex characters (optionally after “sha256:”) or as base64. These are neither, so they could not be checked.', badformat));
    });
  }

  /* ================================================================== *
   * Analysis: everything at once
   * ================================================================== */

  function statsOf(rows, map, s, parsed) {
    var outcomes = { approve: 0, decline: 0, refer: 0, flag: 0, other: 0, none: 0 };
    var first = null, last = null;
    rows.forEach(function (r) {
      if (r.outcome) outcomes[r.outcome]++; else outcomes.none++;
      if (r.time !== null) { if (first === null || r.time < first.time) first = r; if (last === null || r.time > last.time) last = r; }
    });
    var replayable = rows.filter(function (r) { return !r.missing.length && !nondeterministic(r, map, s).length && !r.timeBad; });
    return {
      records: rows.length, unreadable: parsed.unreadable.length, truncated: parsed.truncated,
      first: first ? first.time : null, last: last ? last.time : null, off: first ? (first.off || 0) : 0,
      period: first && last ? spanText(first.time, last.time, first.off || 0) : '',
      outcomes: outcomes, replayable: replayable.length,
      share: rows.length ? replayable.length / rows.length : 0,
      adverse: rows.filter(function (r) { return r.outcome && s.adverse.indexOf(r.outcome) >= 0; }).length,
    };
  }

  /** Run every check. Returns a Promise of the report (the hashes are the
   *  only async part). `log` is a parsed change log, or null. */
  function analyze(parsed, map, settings, log, digest, progress) {
    var s = cleanSettings(settings).settings;
    var rows = readRows(parsed, map, s);
    var F = [];
    var report = { format: parsed.format, delim: parsed.delim, wrapped: parsed.wrapped, map: map, settings: s, findings: F, drift: [], overrides: null, gaps: [], days: [], chain: null };
    if (parsed.unreadable.length) {
      var u = parsed.unreadable;
      F.push({ key: 'unreadable', sev: 'high', title: plural(u.length, 'record') + ' could not be read', detail: 'A record that cannot be read cannot be replayed, and it may be the one somebody asks about. ' + u.slice(0, 5).map(function (x) { return (x.n ? 'Line ' + groups(x.n) : x.item ? 'Item ' + groups(x.item) : 'The file') + ': ' + x.why; }).join('; ') + (u.length > 5 ? '; and ' + groups(u.length - 5) + ' more.' : '.'), count: u.length, refs: u.slice(0, LIMITS.refs).map(function (x) { return { i: -1, n: x.n, item: x.item || null, id: '', time: '', case: '', outcome: '', why: x.why }; }), more: Math.max(0, u.length - LIMITS.refs), all: [], extra: null });
    }
    if (parsed.truncated) F.push({ key: 'truncated', sev: 'info', title: 'Only the first ' + groups(LIMITS.records) + ' records were read', detail: groups(parsed.truncated) + ' more records were left out. Split the log by month, or check it in parts.', count: 0, refs: [], more: 0, all: [], extra: null });
    if (map.time) {
      var bad = rows.filter(function (r) { return r.timeBad; });
      if (bad.length) F.push(finding('time-bad', 'high', plural(bad.length, 'time') + ' Replay cannot read', 'Times are read as ISO 8601 (2026-10-01T09:03:22-05:00) or epoch seconds or milliseconds. ' + plural(bad.length, 'record') + ' carry a time in another form, so they are left out of the time checks. First: ' + nameOf(bad[0]) + ' says “' + visible(bad[0].timeRaw, 40) + '”.', bad));
    }
    if (map.outcome) {
      var other = rows.filter(function (r) { return r.outcome === 'other'; });
      if (other.length) {
        var vals = new Map();
        other.forEach(function (r) { vals.set(r.outcomeRaw, (vals.get(r.outcomeRaw) || 0) + 1); });
        var vl = Array.from(vals.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);
        F.push(finding('outcome-unknown', 'medium', plural(other.length, 'outcome') + ' Replay cannot place', 'These are not approve, decline, refer or flag: ' + vl.map(function (x) { return '“' + visible(x[0], 30) + '” (' + groups(x[1]) + ')'; }).join(', ') + '. Tell Replay what each word means in Settings, so adverse outcomes are not missed.', other, { values: vl.map(function (x) { return { value: visible(x[0], 30), count: x[1] }; }) }));
      }
    }
    checkCompleteness(rows, map, s, F);
    checkAdverse(rows, map, s, F);
    checkDeterminism(rows, map, s, F);
    checkDrift(rows, map, s, F, log, report);
    checkOverrides(rows, map, s, F, report);
    checkOrderAndDuplicates(rows, map, F);
    checkTimeGaps(rows, F, report, 3);
    return checkChain(parsed, rows, map, s, F, report, digest, progress).then(function () {
      report.stats = statsOf(rows, map, s, parsed);
      sortFindings(F);
      report.counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      F.forEach(function (f) { report.counts[f.sev]++; });
      return { report: report, rows: rows };
    });
  }

  /** The report as it travels to the page: the full index lists of each
   *  finding stay behind in the engine. */
  function lean(report) {
    var out = {};
    Object.keys(report).forEach(function (k) { out[k] = report[k]; });
    out.findings = report.findings.map(function (f) { var c = {}; Object.keys(f).forEach(function (k) { if (k !== 'all') c[k] = f[k]; }); return c; });
    if (report.chain) { out.chain = {}; Object.keys(report.chain).forEach(function (k) { if (k !== 'status') out.chain[k] = report.chain[k]; }); }
    return out;
  }

  /* ================================================================== *
   * The replay pack: one decision, everything needed to answer for it
   * ================================================================== */

  function pack(row, report, rec) {
    var s = report.settings, map = report.map;
    var codes = codeIndex(s.codes);
    var st = report.chain && report.chain.status ? report.chain.status[row.i] : null;
    var adverse = Boolean(row.outcome && s.adverse.indexOf(row.outcome) >= 0);
    var reasons = (row.reasons || []).map(function (c) { var k = codes.get(c.toLowerCase()); return { code: c, text: k ? k.text : '', known: Boolean(k) }; });
    var missing = (row.missing || missingFor(row, map, s)).map(function (f) { return { field: f, why: MISS_WORD[f] }; });
    nondeterministic(row, map, s).forEach(function (w) {
      missing.push({ field: w, why: w === 'temperature' ? 'it ran at temperature ' + row.temperature + ', so a replay may not give the same answer' : 'no seed, and your profile asks for one' });
    });
    if (s.codes.length) reasons.forEach(function (x) { if (!x.known) missing.push({ field: 'reasons', why: 'reason code ' + x.code + ' is not on your list, so it has no words' }); });
    var chain = null;
    if (map.hash) {
      chain = { status: st ? st.status : 'nohash', stored: st && st.stored ? st.stored.value : '', computed: st ? st.computed || '' : '', prev: st ? st.prev || '' : '', linked: st ? st.linked || '' : '', linkKind: st ? st.linkKind || '' : '', recipe: report.chain.recipe, prevInInput: report.chain.prevInInput, scheme: report.chain.scheme !== false };
      if (chain.status === 'changed' && chain.scheme) missing.push({ field: 'hash', why: 'its hash does not match its content - it was changed after it was written' });
      if (chain.linked === 'broken') missing.push({ field: 'prevHash', why: 'it does not follow the record before it in the chain' });
      if (chain.status === 'nohash') missing.push({ field: 'hash', why: 'no hash, so nothing proves it was not edited' });
    } else missing.push({ field: 'hash', why: 'the log carries no hashes, so nothing proves this record was not edited' });
    var inputs = coerce(row.inputs);
    var answer = '';
    if (row.outcome) {
      var verb = { approve: 'Approved', decline: 'Declined', refer: 'Referred for review', flag: 'Flagged' }[row.outcome] || ('Outcome: ' + row.outcomeRaw);
      var why = reasons.length ? reasons.map(function (x) { return x.text || x.code; }) : [];
      answer = verb + (row.time !== null ? ' on ' + dayText(row.time, row.off) : '') + (row.has.model ? ' by ' + row.model + (row.has.modelVersion ? ' ' + row.modelVersion : '') : '') + '.' +
        (why.length ? ' The reasons recorded: ' + why.join('; ') + '.' : adverse ? ' The log records no reasons for it.' : '') +
        (row.override === true ? ' A person overrode the model' + (row.has.reviewer ? ' (' + row.reviewer + ')' : '') + (row.has.overrideReason ? ': ' + row.overrideReason : '') + '.' : '');
    }
    return {
      i: row.i, n: row.n, item: row.item, where: where(row), id: row.id, time: row.time, off: row.off, timeRaw: row.timeRaw, when: whenText(row.time, row.off), zone: zoneText(row.off),
      case: row.case, outcome: row.outcome, outcomeRaw: row.outcomeRaw, outcomeWord: row.outcome && OUTCOME_WORD[row.outcome] ? OUTCOME_WORD[row.outcome] : row.outcomeRaw, score: row.score !== null ? row.score : (row.scoreRaw || null), adverse: adverse,
      model: row.model, modelVersion: row.modelVersion, prompt: row.prompt, promptVersion: row.promptVersion,
      temperature: row.temperature, seed: row.seed, has: row.has,
      inputs: inputs === undefined ? null : inputs, inputsHash: row.inputsHash,
      tools: row.tools, reasons: reasons, rules: row.rules || [],
      reviewer: row.reviewer, override: row.override, overrideReason: row.overrideReason,
      chain: chain, missing: missing, replayable: !missing.length, answer: answer,
      record: rec && rec.obj ? rec.obj : null,
    };
  }
  function pretty(v, max) {
    var s;
    try { s = JSON.stringify(v, null, 2); } catch (e) { s = str(v); }
    s = str(s).replace(BAD, '');
    return max && s.length > max ? s.slice(0, max) + '\n…' : s;
  }
  function toolLine(t) {
    if (isObj(t)) {
      var name = line(t.name || t.tool || t.function || t.type || 'call', 60);
      var bits = [];
      ['status', 'ok', 'result', 'ms', 'latency_ms', 'duration_ms'].forEach(function (k) { if (hasOwn(t, k) && (typeof t[k] !== 'object')) bits.push(k + ' ' + line(t[k], 30)); });
      return name + (bits.length ? ' (' + bits.join(', ') + ')' : '');
    }
    return line(t, 80);
  }
  var CHAIN_WORD = { ok: 'Verified - the hash matches the record', changed: 'Changed after it was written - the hash does not match the record', nohash: 'No hash on this record', badformat: 'A hash Replay cannot read', norecipe: 'Not checkable with the raw-line recipe' };
  function chainWords(c) {
    if (!c) return 'The log carries no hashes.';
    if (!c.scheme && c.status === 'changed') return 'Not checked - none of the log’s hashes match Replay’s recipe, so this says nothing either way.';
    return CHAIN_WORD[c.status] || c.status;
  }
  function linkWords(c) {
    if (!c || !c.linked) return '';
    return { ok: 'Follows the record before it', genesis: 'The first record of the chain', 'starts-mid': 'The first record in this file; the chain started earlier', broken: c.linkKind === 'reordered' ? 'Does not follow the record before it - it points at a record elsewhere in the log' : 'Does not follow the record before it - the record it points at is not in this log' }[c.linked] || c.linked;
  }

  function packMarkdown(p, opts) {
    opts = opts || {};
    var caseId = opts.mask === false ? p.case : mask(p.case);
    var L = [];
    L.push('# Replay pack: ' + mdEsc(p.id || p.where));
    L.push('');
    L.push('Made on the device that holds the log. A starting point for an answer, not legal advice.');
    L.push('');
    L.push('| | |');
    L.push('|---|---|');
    L.push('| Decision | ' + mdEsc(p.id || '(no id)') + ' (' + mdEsc(p.where) + ') |');
    L.push('| When | ' + mdEsc(p.when ? p.when + ' (' + p.zone + ')' : '(no time)') + ' |');
    L.push('| Case | ' + mdEsc(caseId || '(no case id)') + (opts.mask === false || !p.case ? '' : ' (masked)') + ' |');
    L.push('| Outcome | ' + mdEsc(p.outcomeWord || '(none)') + (p.score !== null && p.score !== '' ? ' · score ' + mdEsc(p.score) : '') + ' |');
    L.push('| Model | ' + mdEsc([p.model, p.modelVersion].filter(Boolean).join(' ') || '(not recorded)') + ' |');
    L.push('| Prompt | ' + mdEsc([p.prompt, p.promptVersion].filter(Boolean).join(' ') || '(not recorded)') + ' |');
    L.push('| Parameters | ' + mdEsc('temperature ' + (p.temperature !== null ? p.temperature : '(not recorded)') + ', seed ' + (p.seed || '(not recorded)')) + ' |');
    L.push('');
    L.push('## The answer, in words');
    L.push('');
    L.push(mdEsc(p.answer || 'The record has no outcome.'));
    L.push('');
    L.push('## What is missing to replay this');
    L.push('');
    if (!p.missing.length) L.push('Nothing - every field the profile asks for is here, the call was deterministic' + (p.chain ? ' and the hash checks out' : '') + '.');
    else p.missing.forEach(function (m) { L.push('- ' + mdEsc(m.why)); });
    L.push('');
    L.push('## Reasons');
    L.push('');
    if (!p.reasons.length) L.push(p.adverse ? 'None recorded - for an adverse outcome.' : 'None recorded.');
    else p.reasons.forEach(function (r) { L.push('- **' + mdEsc(r.code) + '** ' + (r.text ? mdEsc(r.text) : '(not on the reason-code list)')); });
    if (p.rules.length) { L.push(''); L.push('Policy rules applied: ' + p.rules.map(mdEsc).join(', ')); }
    L.push('');
    L.push('## People');
    L.push('');
    L.push('- Reviewer: ' + mdEsc(p.reviewer || '(none recorded)'));
    L.push('- Overridden: ' + (p.override === true ? 'yes' : p.override === false ? 'no' : '(not recorded)') + (p.overrideReason ? ' - ' + mdEsc(p.overrideReason) : ''));
    L.push('');
    L.push('## What went in');
    L.push('');
    L.push('- Inputs hash: ' + (p.inputsHash ? '`' + mdEsc(p.inputsHash) + '`' : '(not recorded)'));
    if (p.tools && p.tools.length) { L.push('- Tool calls: ' + p.tools.slice(0, 20).map(function (t) { return mdEsc(toolLine(t)); }).join('; ')); }
    if (opts.inputs !== false && p.inputs !== null && p.inputs !== undefined && p.inputs !== '') {
      L.push('');
      L.push('Inputs snapshot (customer data - share it the way you would share the case file):');
      L.push('');
      var body = pretty(p.inputs, 20000), fence = '```';
      while (body.indexOf(fence) >= 0) fence += '`';
      L.push(fence + 'json');
      L.push(body);
      L.push(fence);
    } else if (opts.inputs === false) L.push('- Inputs snapshot: left out of this copy');
    L.push('');
    L.push('## Proof');
    L.push('');
    L.push('- ' + mdEsc(chainWords(p.chain)));
    if (p.chain) {
      if (p.chain.linked) L.push('- ' + mdEsc(linkWords(p.chain)));
      L.push('- Hash in the log: ' + (p.chain.stored ? '`' + mdEsc(p.chain.stored) + '`' : '(none)'));
      if (p.chain.computed) L.push('- Hash Replay computed: `' + mdEsc(p.chain.computed) + '`');
      L.push('- Previous hash: ' + (p.chain.prev ? '`' + mdEsc(p.chain.prev) + '`' : '(none)'));
      L.push('- Recipe: ' + mdEsc(RECIPES[p.chain.recipe] + (p.chain.prevInInput ? ', previous hash and a line feed first' : ', previous hash not included')) + ', SHA-256');
    }
    return L.join('\n') + '\n';
  }
  function packJson(p, opts) {
    opts = opts || {};
    var out = {
      replayPack: 1,
      note: 'Made on the device that holds the log. A starting point for an answer, not legal advice.',
      decision: { id: p.id || null, where: p.where, time: p.timeRaw || null, case: opts.mask === false ? (p.case || null) : (p.case ? mask(p.case) : null), caseMasked: opts.mask !== false && Boolean(p.case), outcome: p.outcome || p.outcomeRaw || null, score: p.score },
      model: { id: p.model || null, version: p.modelVersion || null },
      prompt: { id: p.prompt || null, version: p.promptVersion || null },
      parameters: { temperature: p.temperature, seed: p.seed || null },
      inputs: { hash: p.inputsHash || null },
      toolCalls: (p.tools || []).slice(0, 100),
      reasons: p.reasons,
      rules: p.rules,
      review: { reviewer: p.reviewer || null, overridden: p.override, why: p.overrideReason || null },
      proof: p.chain ? { status: p.chain.status, verified: p.chain.status === 'ok' && p.chain.scheme, link: p.chain.linked || null, storedHash: p.chain.stored || null, computedHash: p.chain.computed || null, previousHash: p.chain.prev || null, recipe: p.chain.recipe, previousHashHashed: p.chain.prevInInput } : { status: 'not hashed' },
      missingToReplay: p.missing.map(function (m) { return m.why; }),
      answer: p.answer,
    };
    if (opts.inputs !== false) out.inputs.snapshot = p.inputs;
    return JSON.stringify(out, null, 2) + '\n';
  }

  /* ================================================================== *
   * A reproducible review sample, stratified
   * ================================================================== */

  var STRATA = { outcome: 'Outcome', modelVersion: 'Model version', promptVersion: 'Prompt version' };
  function sample(rows, opts) {
    var n = Math.max(1, Math.min(LIMITS.sample, Math.floor(Number(opts.n) || 25)));
    var seed = line(opts.seed, 40) || 'replay';
    var by = (opts.by || ['outcome', 'modelVersion']).filter(function (k) { return STRATA[k]; });
    var buckets = new Map();
    rows.forEach(function (r) {
      var parts = by.map(function (k) { return k === 'outcome' ? (r.outcome ? (OUTCOME_WORD[r.outcome] || r.outcomeRaw || 'Other') : '(none)') : (r[k] || '(none)'); });
      var key = parts.join(' · ') || 'All';
      var b = buckets.get(key); if (!b) { b = { key: key, parts: parts, rows: [] }; buckets.set(key, b); }
      b.rows.push(r);
    });
    var list = Array.from(buckets.values()).sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
    var total = rows.length;
    n = Math.min(n, total);
    // proportional, at least one per group when there is room, largest remainder for the rest
    var alloc = list.map(function (b) { return { b: b, want: total ? n * b.rows.length / total : 0, take: 0 }; });
    var left = n;
    if (n >= list.length) alloc.forEach(function (a) { a.take = 1; left--; });
    alloc.forEach(function (a) { var extra = Math.max(0, Math.floor(a.want) - a.take); extra = Math.min(extra, a.b.rows.length - a.take, left); a.take += extra; left -= extra; });
    alloc.slice().sort(function (x, y) { return (y.want - Math.floor(y.want)) - (x.want - Math.floor(x.want)) || (x.b.key < y.b.key ? -1 : 1); }).forEach(function (a) { if (left > 0 && a.take < a.b.rows.length) { a.take++; left--; } });
    for (var guard = 0; left > 0 && guard < 10000; guard++) { var a2 = alloc.filter(function (a) { return a.take < a.b.rows.length; })[0]; if (!a2) break; a2.take++; left--; }
    var picks = [];
    alloc.forEach(function (a) {
      var r = rng(seed + '|' + a.b.key);
      var pool = a.b.rows.slice();
      for (var k = 0; k < a.take; k++) { var j = k + Math.floor(r() * (pool.length - k)); var t = pool[k]; pool[k] = pool[j]; pool[j] = t; }
      pool.slice(0, a.take).forEach(function (row) { picks.push({ row: row, stratum: a.b.key }); });
    });
    picks.sort(function (x, y) { return (x.row.time === null ? Infinity : x.row.time) - (y.row.time === null ? Infinity : y.row.time) || x.row.i - y.row.i; });
    return {
      seed: seed, n: picks.length, by: by, population: total,
      strata: alloc.map(function (a) { return { key: a.b.key, population: a.b.rows.length, take: a.take }; }),
      picks: picks.map(function (p) { var x = ref(p.row); x.stratum = p.stratum; x.modelVersion = p.row.modelVersion; x.promptVersion = p.row.promptVersion; return x; }),
    };
  }
  function sampleCsv(smp, opts) {
    var maskIt = !opts || opts.mask !== false;
    var head = ['decision_id', 'case_id', 'time', 'outcome', 'model_version', 'prompt_version', 'stratum', 'line'];
    var rows = smp.picks.map(function (p) { return csvRow([p.id, maskIt ? mask(p.case) : p.case, p.time, p.outcome, p.modelVersion, p.promptVersion, p.stratum, p.n || p.item || p.i + 1]); });
    return ['# Replay sample: seed ' + csvCell(formulaSafe(smp.seed)) + ', ' + smp.n + ' of ' + smp.population + ', by ' + smp.by.join(' and ')].concat([head.join(',')], rows).join('\r\n') + '\r\n';
  }

  /* ================================================================== *
   * Exports
   * ================================================================== */

  function flaggedCsv(report, rows, opts) {
    var maskIt = !opts || opts.mask !== false;
    var out = [['severity', 'finding', 'decision_id', 'case_id', 'time', 'outcome', 'line'].join(',')];
    report.findings.forEach(function (f) {
      (f.all || []).forEach(function (i) { var r = rows[i]; if (r) out.push(csvRow([SEV_WORD[f.sev], f.title, r.id, maskIt ? mask(r.case) : r.case, r.timeRaw, r.outcome || r.outcomeRaw, r.n || r.item || r.i + 1])); });
      if (f.key === 'unreadable') f.refs.forEach(function (r) { out.push(csvRow([SEV_WORD[f.sev], f.title, '', '', '', '', r.n || r.item || ''])); });
    });
    return out.join('\r\n') + '\r\n';
  }

  function reportMarkdown(report, opts) {
    opts = opts || {};
    var maskIt = opts.mask !== false;
    var st = report.stats, L = [];
    var cid = function (c) { return maskIt ? mask(c) : line(c, 80); };
    L.push('# Replay findings: ' + mdEsc(opts.name || 'decision log'));
    L.push('');
    L.push('Checked ' + mdEsc(opts.stamp || '') + ' on the device that holds the log - nothing was uploaded. A starting checklist, not legal advice.');
    L.push('');
    L.push('- Records: ' + groups(st.records) + (st.period ? ' (' + mdEsc(st.period) + ')' : '') + ', ' + mdEsc({ jsonl: 'JSON Lines', json: 'a JSON array', csv: 'CSV' }[report.format] || report.format));
    L.push('- Fully replayable: ' + groups(st.replayable) + ' of ' + groups(st.records) + ' (' + pct(st.replayable, st.records) + ')');
    if (report.chain && report.chain.mapped) L.push('- Hash chain: ' + groups(report.chain.verified) + ' verified' + (report.chain.changed ? ', ' + groups(report.chain.changed) + ' changed after they were written' : '') + (report.chain.unlinked ? ', ' + groups(report.chain.unlinked) + ' out of the chain' : '') + (report.chain.scheme === false ? ' (the recipe does not match this log)' : ''));
    else L.push('- Hash chain: none - nothing proves the log was not edited');
    report.drift.forEach(function (k) { L.push('- ' + (k.kind === 'model' ? 'Model' : 'Prompt') + ' versions: ' + k.versions.map(function (v) { return mdEsc(v.label) + ' (' + groups(v.count) + ')'; }).join(', ')); });
    L.push('- Case ids: ' + (maskIt ? 'masked' : 'shown in full'));
    L.push('');
    var F = report.findings;
    L.push('## Findings (' + F.length + ')');
    L.push('');
    if (!F.length) L.push('Nothing found against this profile.');
    F.forEach(function (f, k) {
      L.push('### ' + (k + 1) + '. ' + SEV_WORD[f.sev] + ': ' + mdEsc(f.title));
      L.push('');
      L.push(mdEsc(f.detail));
      if (f.refs.length) {
        L.push('');
        L.push('| Record | Decision id | Time | Case | Outcome |');
        L.push('|---|---|---|---|---|');
        f.refs.slice(0, 50).forEach(function (r) { L.push('| ' + mdEsc(r.n ? 'line ' + r.n : r.item ? 'item ' + r.item : r.i >= 0 ? 'record ' + (r.i + 1) : '') + ' | ' + mdEsc(r.id || '') + ' | ' + mdEsc(r.time || '') + ' | ' + mdEsc(cid(r.case)) + ' | ' + mdEsc(r.outcome || r.why || '') + ' |'); });
        var rest = f.count - Math.min(50, f.refs.length);
        if (rest > 0) L.push('', 'And ' + groups(rest) + ' more - every one is in the flagged-records CSV.');
      }
      L.push('');
    });
    if (report.drift.length) {
      L.push('## Version history');
      L.push('');
      L.push('| Kind | Version | Decisions | First | Last | Change log |');
      L.push('|---|---|---|---|---|---|');
      report.drift.forEach(function (k) { k.versions.forEach(function (v) { L.push('| ' + (k.kind === 'model' ? 'Model' : 'Prompt') + ' | ' + mdEsc(v.label) + ' | ' + groups(v.count) + ' | ' + mdEsc(whenText(v.first, v.off)) + ' | ' + mdEsc(whenText(v.last, v.off)) + ' | ' + (v.entry ? mdEsc(v.entry.day + (v.entry.approver ? ', ' + v.entry.approver : '')) : v.entry === null ? 'no entry' : '') + ' |'); }); });
      L.push('');
    }
    if (report.overrides && report.overrides.byReviewer.length) {
      L.push('## Overrides by reviewer');
      L.push('');
      L.push('| Reviewer | Reviewed | Overrides | Rate |');
      L.push('|---|---|---|---|');
      report.overrides.byReviewer.forEach(function (x) { L.push('| ' + mdEsc(x.who) + ' | ' + groups(x.reviewed) + ' | ' + groups(x.overrides) + ' | ' + pct(x.overrides, x.reviewed) + ' |'); });
      L.push('');
    }
    L.push('## How this was checked');
    L.push('');
    L.push('- Must record: ' + report.settings.required.map(function (f) { return REQ_LABEL[f]; }).join(', ') + (report.settings.when.reasonsIfAdverse ? '; reasons for ' + report.settings.adverse.map(function (o) { return OUTCOME_WORD[o].toLowerCase(); }).join(' / ') : '') + (report.settings.when.reviewerIfOverride ? '; a reviewer on every override' : '') + (report.settings.when.whyIfOverride ? '; a reason on every override' : '') + '.');
    L.push('- Determinism: ' + (report.settings.determinism.temperatureZero ? 'temperature 0' : 'temperature not checked') + (report.settings.determinism.seed ? ', a seed on every call' : '') + '.');
    if (report.chain && report.chain.mapped) L.push('- Hashes: SHA-256 over ' + (report.chain.prevInInput ? 'the previous hash, a line feed, then ' : '') + (report.chain.recipe === 'raw' ? 'the raw line without its hash' : 'the record as canonical JSON (keys sorted, no spaces) without its hash') + '.');
    L.push('- Field mapping: ' + FIELDS.filter(function (f) { return report.map[f]; }).map(function (f) { return FIELD_LABEL[f] + ' = ' + mdEsc(report.map[f]); }).join('; ') + '.');
    return L.join('\n') + '\n';
  }

  /** The recipe, as code a team can copy into its own writer. Shown on the
   *  page as text - nothing here runs. */
  var HASH_SNIPPET = [
    '// Node: write each decision with a hash chain Replay can check.',
    '// Canonical JSON: keys sorted at every level, no spaces (RFC 8785 rules).',
    "const crypto = require('crypto');",
    'const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(",")}]`',
    "  : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()",
    '      .map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",")}}`',
    '  : JSON.stringify(v);',
    "let prev = '0'.repeat(64);              // the first record's previous hash",
    'function writeDecision(decision) {',
    '  const rec = { ...decision, prev_hash: prev };',
    "  const hash = crypto.createHash('sha256').update(prev + '\\n' + canon(rec)).digest('hex');",
    '  prev = hash;',
    '  return JSON.stringify({ ...rec, hash }) + "\\n";   // append to the log',
    '}',
  ].join('\n');

  /* ================================================================== *
   * The AI field helper: key names and shapes in, a mapping out
   * ================================================================== */

  var CONFIDENCE = ['high', 'medium', 'low'];
  /** Is this key path a name, not a value? No @, no run of 5 or more digits
   *  (4 on the page), no hash-like hex, no date, no markup or invisible
   *  characters. */
  function keyOk(p, strictDigits) {
    var s = str(p);
    if (!s || s.length > LIMITS.pathChars || BAD1.test(s)) return false;
    if (/@/.test(s) || new RegExp('\\d{' + (strictDigits || 5) + ',}').test(s) || longHex(s) || /[<>{}\\`"]/.test(s)) return false;
    if (/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/.test(s) || UUID_RE.test(s)) return false;
    return Boolean(s.trim());
  }
  function safeKey(p, i) { return keyOk(p, 4) ? str(p) : 'key ' + (i + 1); }
  /** What "Help me map these fields" sends: each key path (a value-looking
   *  one as "key N") and its shape codes. Nothing else - never a value. */
  function keysPayload(keys) {
    return { keys: keys.slice(0, LIMITS.aiKeys).map(function (k, i) { return { path: safeKey(k.path, i), shape: (k.shapes || []).filter(function (c) { return hasOwn(SHAPES, c); }).slice(0, LIMITS.shapes) }; }) };
  }
  /** The server's check of that payload: exactly {keys: [{path, shape}]};
   *  every path a name; every shape code from SHAPES. */
  function keysRequest(body) {
    if (!onlyKeys(body, ['keys'])) return { error: 'Only key names and their shapes can be sent - never a value.', code: 'unknown-field' };
    if (!Array.isArray(body.keys) || !body.keys.length || body.keys.length > LIMITS.aiKeys) return { error: 'Send 1 to ' + LIMITS.aiKeys + ' key names.', code: 'bad-keys' };
    var keys = [];
    for (var i = 0; i < body.keys.length; i++) {
      var k = body.keys[i];
      if (!onlyKeys(k, ['path', 'shape'])) return { error: 'Each key is its name and its shape codes - nothing else.', code: 'unknown-field' };
      if (typeof k.path !== 'string' || !keyOk(k.path, 5)) return { error: 'A key name looked like a value (an @, a long number, a hash or a date). Send it as "key N" instead.', code: 'value-in-key' };
      if (!Array.isArray(k.shape) || k.shape.length > LIMITS.shapes) return { error: 'Each key has up to ' + LIMITS.shapes + ' shape codes.', code: 'bad-shape' };
      for (var j = 0; j < k.shape.length; j++) if (typeof k.shape[j] !== 'string' || !hasOwn(SHAPES, k.shape[j])) return { error: 'A shape code that is not on the list.', code: 'unknown-shape' };
      keys.push({ path: k.path, shape: k.shape.slice() });
    }
    return { req: { keys: keys } };
  }
  /** The model's mapping, checked: known fields, real keys, each key once
   *  and each field (but "ignore") once, a confidence from the list. */
  function cleanMapping(raw, req) {
    if (!isObj(raw) || !Array.isArray(raw.mapping)) return null;
    var map = {}, conf = {}, used = {}, dropped = 0, ignored = [];
    FIELDS.forEach(function (f) { map[f] = -1; });
    raw.mapping.slice(0, 200).forEach(function (m) {
      if (!isObj(m)) { dropped++; return; }
      var c = Number(m.key);
      if (!(Math.floor(c) === c && c >= 1 && c <= req.keys.length) || used[c] || AI_FIELDS.indexOf(m.field) < 0) { dropped++; return; }
      if (m.field === 'ignore') { used[c] = 1; ignored.push(c - 1); return; }
      if (map[m.field] >= 0) { dropped++; return; }
      map[m.field] = c - 1; used[c] = 1;
      conf[m.field] = CONFIDENCE.indexOf(m.confidence) >= 0 ? m.confidence : 'low';
    });
    if (!FIELDS.some(function (k) { return map[k] >= 0; })) return null;
    return { map: map, confidence: conf, ignored: ignored, dropped: dropped, note: line(noMarkup(raw.note).replace(/\b(?:https?:\/\/|www\.)\S+/gi, ''), LIMITS.noteChars) };
  }

  /* ================================================================== *
   * The engine: the same steps in the worker and, without one, on the page
   * ================================================================== */

  /** Keeps each loaded log, so a 20 MB file is handed over once and checked
   *  again with new choices as often as needed. `digest(text)` returns a
   *  Promise of the lowercase hex SHA-256 of the text's UTF-8 bytes. No
   *  clock, no storage, no network. */
  function createEngine(opts) {
    var digest = opts && opts.digest;
    var files = {};
    function need(id) { var f = files[id]; if (!f) throw new Error('That log is not loaded.'); return f; }
    return {
      load: function (o) {
        var b = o.bytes !== undefined ? toBytes(o.bytes) : null;
        if (b && b.length > LIMITS.fileBytes) throw new Error('That file is over ' + Math.round(LIMITS.fileBytes / 1048576) + ' MB. Check a shorter period - a month at a time.');
        var dec = b ? decodeText(b) : { text: str(o.text), encoding: 'utf-8', bom: false, bad: 0, binary: '' };
        if (dec.binary) throw new Error('That is ' + dec.binary + '.');
        var parsed = parseLog(dec.text);
        if (parsed.format === 'empty') throw new Error('That file is empty.');
        if (!parsed.records.length && parsed.unreadable.length) throw new Error('No record in that file could be read: ' + (parsed.unreadable[0].n ? 'line ' + parsed.unreadable[0].n + ' is ' : '') + parsed.unreadable[0].why.replace(/^The file /, '') + '.');
        var disc = discoverKeys(parsed.records);
        var guess = guessFields(disc.keys);
        files[o.id] = { parsed: parsed, keys: disc.keys, name: line(o.name, 120), last: null, rows: null };
        return { id: o.id, name: line(o.name, 120), format: parsed.format, delim: parsed.delim, wrapped: parsed.wrapped, encoding: dec.encoding, bom: dec.bom, badBytes: dec.bad, records: parsed.records.length, unreadable: parsed.unreadable.length, truncated: parsed.truncated, blank: parsed.blank, keys: disc.keys, moreKeys: disc.more, guess: guess, bytes: b ? b.length : utf8(o.text || '').length };
      },
      analyze: function (o, progress) {
        var f = need(o.id);
        if (!digest) return Promise.reject(new Error('No SHA-256 here.'));
        var map = cleanMap(o.map, f.keys);
        var log = o.changeLog ? parseChangeLog(o.changeLog) : null;
        return analyze(f.parsed, map, o.settings || defaults(), log, digest, progress).then(function (res) {
          f.last = res.report; f.rows = res.rows;
          var out = lean(res.report);
          out.changeLog = log ? { entries: log.entries.length, errors: log.errors } : null;
          out.name = f.name;
          return out;
        });
      },
      pack: function (o) {
        var f = need(o.id);
        if (!f.last) throw new Error('Run the checks first.');
        var row = f.rows[o.i];
        if (!row) throw new Error('No such record.');
        return pack(row, f.last, f.parsed.records[o.i]);
      },
      find: function (o) {
        var f = need(o.id);
        if (!f.rows) return [];
        var q = fold(o.q);
        var out = [];
        if (!q) return out;
        for (var k = 0; k < f.rows.length && out.length < 50; k++) {
          var r = f.rows[k];
          if (fold(r.id).indexOf(q) >= 0 || fold(r.case).indexOf(q) >= 0 || (r.n && String(r.n) === q)) out.push(ref(r));
        }
        return out;
      },
      sample: function (o) { var f = need(o.id); if (!f.rows) throw new Error('Run the checks first.'); return sample(f.rows, o); },
      flagged: function (o) { var f = need(o.id); if (!f.last) throw new Error('Run the checks first.'); return flaggedCsv(f.last, f.rows, o); },
      drop: function (o) { delete files[o.id]; return true; },
    };
  }

  return {
    LIMITS: LIMITS, SEV: SEV, SEV_WORD: SEV_WORD, SEV_MARK: SEV_MARK, FIELDS: FIELDS, AI_FIELDS: AI_FIELDS, FIELD_LABEL: FIELD_LABEL, FIELD_HELP: FIELD_HELP, SHAPES: SHAPES, SHAPE_KEYS: SHAPE_KEYS,
    OUTCOMES: OUTCOMES, OUTCOME_WORD: OUTCOME_WORD, REQUIRABLE: REQUIRABLE, REQ_LABEL: REQ_LABEL, DEFAULT_SETTINGS: DEFAULT_SETTINGS, RECIPES: RECIPES, CONFIDENCE: CONFIDENCE, STRATA: STRATA, ORDER: ORDER, HASH_SNIPPET: HASH_SNIPPET, MISS_WORD: MISS_WORD,
    str: str, esc: esc, line: line, clip: clip, fold: fold, plural: plural, groups: groups, pct: pct, visible: visible, hasInvisible: hasInvisible, noMarkup: noMarkup, mdEsc: mdEsc, csvCell: csvCell, formulaSafe: formulaSafe, csvRow: csvRow, mask: mask,
    utf8: utf8, toBytes: toBytes, hex: hex, hexToB64: hexToB64, fnv: fnv, rng: rng, decodeText: decodeText,
    canon: canon, getPath: getPath, without: without, removeMember: removeMember, removeCell: removeCell, hashBody: hashBody, hashInput: hashInput, normHash: normHash, hashMatches: hashMatches,
    parseLog: parseLog, sniffDelimiter: sniffDelimiter, coerce: coerce, discoverKeys: discoverKeys, shapesOf: shapesOf, guessFields: guessFields, fieldScore: fieldScore, normPath: normPath, cleanMap: cleanMap,
    outcomeOf: outcomeOf, parseTime: parseTime, listOf: listOf, yesNo: yesNo, readRows: readRows, missingFor: missingFor,
    whenText: whenText, dayText: dayText, clockText: clockText, isoDay: isoDay, shortDay: shortDay, spanText: spanText, zoneText: zoneText, wall: wall,
    defaults: defaults, cleanSettings: cleanSettings, mergeSettings: mergeSettings, looksLikeData: looksLikeData, longHex: longHex, pathOk: pathOk, parseCodes: parseCodes, codesText: codesText, presetFor: presetFor,
    parseChangeLog: parseChangeLog, versionMatches: versionMatches,
    analyze: analyze, lean: lean, pack: pack, packMarkdown: packMarkdown, packJson: packJson, chainWords: chainWords, linkWords: linkWords, toolLine: toolLine, pretty: pretty,
    sample: sample, sampleCsv: sampleCsv, flaggedCsv: flaggedCsv, reportMarkdown: reportMarkdown,
    keyOk: keyOk, safeKey: safeKey, keysPayload: keysPayload, keysRequest: keysRequest, cleanMapping: cleanMapping,
    createEngine: createEngine,
  };
}));
