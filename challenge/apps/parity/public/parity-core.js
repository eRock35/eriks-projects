/* Parity - the rules. One file, run in three places: the page (window.ParityCore),
 * the parse worker (importScripts) and the server and tests (require).
 *
 * Everything that decides a verdict lives here and is pure and deterministic:
 * the same two files and the same recipe give the same findings, in the same
 * order, on every machine. Nothing here touches the network or storage.
 *
 *   reading     createCsvParser, createJsonlParser, sniff, parseText, detectHeader
 *   profiling   createProfiler (types, null/empty/distinct counts, lengths)
 *   values      canonNum, parseDate/formatDate, DATE_FORMATS
 *   mapping     automap, suggestKey, RULES, cleanRecipe, compilePlan, learnRules
 *   comparing   createHasher, diffHashers, createDetail, diagnose, compareRows
 *   fingerprint sipHash, fingerprintFrom, compareFingerprints, rowListFrom, compareRowLists
 *   exports     toJson, toMarkdown, toHtml, examplesCsv, csvCell
 *   the model   modelSummary, cleanProposal
 *
 * Values from a file are hostile: markup, bidi overrides, control characters,
 * formula-looking cells. They are only ever drawn through esc(), and every
 * export escapes for its own format.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ParityCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    maxColumns: 1000,
    maxNameLen: 120,
    maxCellLen: 1000000,     // a single cell longer than this is cut (and counted)
    memoryBytes: 96 * 1024 * 1024, // files up to this are kept in the worker's memory; bigger ones are re-read per pass
    examples: 20,            // examples per finding
    detailCap: 50000,        // mismatched rows explained column by column; past this, the first N
    exactDistinct: 50000,    // distinct values counted exactly; past this, estimated (HyperLogLog)
    buckets: 4096,           // fingerprint buckets
    learnRows: 3000,         // rows joined to learn rules
    mapEntries: 200,
    recipePairs: 1000,
    rowListMax: 20000,
  };

  /* ---------------- text ---------------- */

  var CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩؜﻿]/g;
  /** A string safe to show: control, bidi and zero-width characters removed, bounded. */
  function clean(v, max) {
    if (v === null || v === undefined) return '';
    var s = String(v).replace(CTRL, '');
    var m = max || 500;
    return s.length > m ? s.slice(0, m - 1) + '…' : s;
  }
  /** HTML-escape, and drop control, bidi and zero-width characters: a column
   *  name with a right-to-left override must not reorder the page around it. */
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(CTRL, '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtInt(n) {
    n = Math.round(Number(n) || 0);
    var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + s;
  }
  function plural(n, one, many) { return fmtInt(n) + ' ' + (Number(n) === 1 ? one : (many || one + 's')); }
  function fmtBytes(b) {
    b = Number(b) || 0;
    if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return Math.round(b / 1e3) + ' KB';
    return b + ' bytes';
  }
  /** How a value reads in a finding: null and empty are named, spaces at the
   *  ends made visible, and the whole thing bounded. */
  function showVal(v, max) {
    if (v === null || v === undefined) return 'null';
    if (v === '') return '"" (empty)';
    var s = clean(v, max || 120);
    if (s !== s.trim()) return '"' + s + '"';
    return s;
  }

  /* ---------------- hashing ---------------- */

  // cyrb53-style: two 32-bit lanes. HA/HB hold the last result, so the hot
  // path allocates nothing.
  var HA = 0, HB = 0;
  function hash2(str, seed) {
    var h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    HA = h1 >>> 0; HB = h2 >>> 0;
  }
  /** A 53-bit hash as one Number (a Map key). */
  function h53(str, seed) { hash2(str, seed); return (HB & 0x1fffff) * 4294967296 + HA; }
  function hex32(n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }
  function textHash(str) { hash2(String(str), 7); return hex32(HB) + hex32(HA); }

  /* SipHash-2-4, a keyed hash built to resist exactly what a fingerprint
   * faces: someone holding outputs and guessing inputs. 64-bit arithmetic on
   * 32-bit halves. key: four 32-bit words (little-endian); msg: an array of
   * bytes. Returns [hi, lo]. Checked against the reference vectors in the
   * tests. */
  function sipHash(key, bytes) {
    var v0h = (key[1] ^ 0x736f6d65) >>> 0, v0l = (key[0] ^ 0x70736575) >>> 0;
    var v1h = (key[3] ^ 0x646f7261) >>> 0, v1l = (key[2] ^ 0x6e646f6d) >>> 0;
    var v2h = (key[1] ^ 0x6c796765) >>> 0, v2l = (key[0] ^ 0x6e657261) >>> 0;
    var v3h = (key[3] ^ 0x74656462) >>> 0, v3l = (key[2] ^ 0x79746573) >>> 0;
    var t, lo, hi;
    function round() {
      // v0 += v1; v1 = rotl(v1,13); v1 ^= v0; v0 = rotl(v0,32)
      lo = (v0l + v1l) >>> 0; v0h = (v0h + v1h + (lo < v0l ? 1 : 0)) >>> 0; v0l = lo;
      t = v1h; v1h = ((v1h << 13) | (v1l >>> 19)) >>> 0; v1l = ((v1l << 13) | (t >>> 19)) >>> 0;
      v1h = (v1h ^ v0h) >>> 0; v1l = (v1l ^ v0l) >>> 0;
      t = v0h; v0h = v0l; v0l = t;
      // v2 += v3; v3 = rotl(v3,16); v3 ^= v2
      lo = (v2l + v3l) >>> 0; v2h = (v2h + v3h + (lo < v2l ? 1 : 0)) >>> 0; v2l = lo;
      t = v3h; v3h = ((v3h << 16) | (v3l >>> 16)) >>> 0; v3l = ((v3l << 16) | (t >>> 16)) >>> 0;
      v3h = (v3h ^ v2h) >>> 0; v3l = (v3l ^ v2l) >>> 0;
      // v0 += v3; v3 = rotl(v3,21); v3 ^= v0
      lo = (v0l + v3l) >>> 0; v0h = (v0h + v3h + (lo < v0l ? 1 : 0)) >>> 0; v0l = lo;
      t = v3h; v3h = ((v3h << 21) | (v3l >>> 11)) >>> 0; v3l = ((v3l << 21) | (t >>> 11)) >>> 0;
      v3h = (v3h ^ v0h) >>> 0; v3l = (v3l ^ v0l) >>> 0;
      // v2 += v1; v1 = rotl(v1,17); v1 ^= v2; v2 = rotl(v2,32)
      lo = (v2l + v1l) >>> 0; v2h = (v2h + v1h + (lo < v2l ? 1 : 0)) >>> 0; v2l = lo;
      t = v1h; v1h = ((v1h << 17) | (v1l >>> 15)) >>> 0; v1l = ((v1l << 17) | (t >>> 15)) >>> 0;
      v1h = (v1h ^ v2h) >>> 0; v1l = (v1l ^ v2l) >>> 0;
      t = v2h; v2h = v2l; v2l = t;
    }
    var n = bytes.length, end = n - (n % 8), i, ml, mh;
    for (i = 0; i < end; i += 8) {
      ml = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
      mh = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
      v3h = (v3h ^ mh) >>> 0; v3l = (v3l ^ ml) >>> 0;
      round(); round();
      v0h = (v0h ^ mh) >>> 0; v0l = (v0l ^ ml) >>> 0;
    }
    var last = [0, 0, 0, 0, 0, 0, 0, (n & 0xff)];
    for (i = end; i < n; i++) last[i - end] = bytes[i];
    ml = (last[0] | (last[1] << 8) | (last[2] << 16) | (last[3] << 24)) >>> 0;
    mh = (last[4] | (last[5] << 8) | (last[6] << 16) | (last[7] << 24)) >>> 0;
    v3h = (v3h ^ mh) >>> 0; v3l = (v3l ^ ml) >>> 0;
    round(); round();
    v0h = (v0h ^ mh) >>> 0; v0l = (v0l ^ ml) >>> 0;
    v2l = (v2l ^ 0xff) >>> 0;
    round(); round(); round(); round();
    return [(v0h ^ v1h ^ v2h ^ v3h) >>> 0, (v0l ^ v1l ^ v2l ^ v3l) >>> 0];
  }
  function wordsBytes(words) {
    var out = [];
    for (var i = 0; i < words.length; i++) { var w = words[i] >>> 0; out.push(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255); }
    return out;
  }
  function utf8Bytes(s) {
    var out = [];
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
        var c2 = s.charCodeAt(++i); var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  /** The fingerprint key from a passphrase: PBKDF2-SHA-256, 210,000 rounds.
   *  Async (WebCrypto). Returns four 32-bit words. */
  var KDF = { iterations: 210000, salt: 'parity fingerprint v1' };
  function normPassphrase(p) { return String(p || '').normalize('NFKC').trim(); }
  function deriveKey(passphrase, subtle) {
    var s = subtle || (typeof crypto !== 'undefined' && crypto.subtle);
    if (!s) return Promise.reject(new Error('This browser cannot derive a key (no WebCrypto).'));
    var enc = new TextEncoder();
    return s.importKey('raw', enc.encode(normPassphrase(passphrase)), 'PBKDF2', false, ['deriveBits'])
      .then(function (k) { return s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(KDF.salt), iterations: KDF.iterations }, k, 128); })
      .then(function (bits) { var dv = new DataView(bits); return [dv.getUint32(0, true), dv.getUint32(4, true), dv.getUint32(8, true), dv.getUint32(12, true)]; });
  }
  function passphraseProblem(p) {
    var s = normPassphrase(p);
    if (s.length < 12) return 'Use at least 12 characters - four random words is a good passphrase.';
    if (/^(.)\1+$/.test(s)) return 'That passphrase is one character repeated.';
    return '';
  }

  /* ---------------- HyperLogLog (distinct counts past the exact limit) ---------------- */

  function createDistinct() {
    var set = new Set(), regs = null, P = 12, M = 1 << P;
    function addHash(a, b) {
      var idx = a >>> (32 - P);
      var w = ((a << P) | (b >>> (32 - P))) >>> 0;
      var rho = w === 0 ? 33 - P : Math.clz32(w) + 1;
      if (rho > regs[idx]) regs[idx] = rho;
    }
    return {
      add: function (s) {
        hash2(s, 99);
        if (regs) { addHash(HA, HB); return; }
        set.add((HB & 0x1fffff) * 4294967296 + HA);
        if (set.size > LIMITS.exactDistinct) {
          regs = new Uint8Array(M);
          set.forEach(function (n) { var b = Math.floor(n / 4294967296); addHash(n >>> 0, (b << 11) >>> 0); });
          set = null;
        }
      },
      count: function () {
        if (!regs) return { n: set.size, approx: false };
        var sum = 0, zeros = 0;
        for (var i = 0; i < M; i++) { sum += Math.pow(2, -regs[i]); if (!regs[i]) zeros++; }
        var est = (0.7213 / (1 + 1.079 / M)) * M * M / sum;
        if (est <= 2.5 * M && zeros) est = M * Math.log(M / zeros);
        return { n: Math.round(est), approx: true };
      },
    };
  }

  /* ---------------- numbers: exact decimal strings ---------------- */

  var NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d{1,3})?$/;
  var GROUPED_RE = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;
  /** The canonical form of a number written as text: no leading zeros, no
   *  trailing fractional zeros, "-0" is "0". Exact - no float in between, so
   *  "0.1" + "0.2" questions never arise. null if it is not a number. */
  var CANON_NUM = /^-?(0|[1-9]\d*)(\.\d*[1-9])?$/;
  function canonNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.length < 40 && CANON_NUM.test(v) && v !== '-0') return v; // already canonical: the hot path
    var s = String(v).trim();
    if (!s || s.length > 60) return null;
    if (GROUPED_RE.test(s)) s = s.replace(/,/g, '');
    else if (!NUM_RE.test(s)) return null;
    var neg = s[0] === '-';
    if (s[0] === '-' || s[0] === '+') s = s.slice(1);
    var exp = 0, e = s.search(/[eE]/);
    if (e >= 0) { exp = parseInt(s.slice(e + 1), 10); s = s.slice(0, e); }
    var dot = s.indexOf('.');
    var ip = dot >= 0 ? s.slice(0, dot) : s, fp = dot >= 0 ? s.slice(dot + 1) : '';
    if (exp > 0) { var take = fp.slice(0, exp); ip += take + '0'.repeat(Math.max(0, exp - fp.length)); fp = fp.slice(exp); }
    else if (exp < 0) { var k = -exp; var pad = '0'.repeat(Math.max(0, k - ip.length)) + ip; fp = pad.slice(pad.length - k) + fp; ip = pad.slice(0, pad.length - k); }
    ip = ip.replace(/^0+/, '') || '0';
    fp = fp.replace(/0+$/, '');
    if (ip === '0' && !fp) neg = false;
    return (neg ? '-' : '') + ip + (fp ? '.' + fp : '');
  }
  function numParts(c) {
    var neg = c[0] === '-'; if (neg) c = c.slice(1);
    var d = c.indexOf('.');
    return { neg: neg, ip: d >= 0 ? c.slice(0, d) : c, fp: d >= 0 ? c.slice(d + 1) : '' };
  }
  function fromParts(neg, ip, fp) {
    ip = ip.replace(/^0+/, '') || '0'; fp = fp.replace(/0+$/, '');
    if (ip === '0' && !fp) neg = false;
    return (neg ? '-' : '') + ip + (fp ? '.' + fp : '');
  }
  /** x * 10^k, exactly, on a canonical number. */
  function shiftNum(c, k) {
    var p = numParts(c), digits = p.ip + p.fp, point = p.ip.length + k;
    if (point <= 0) return fromParts(p.neg, '0', '0'.repeat(-point) + digits);
    if (point >= digits.length) return fromParts(p.neg, digits + '0'.repeat(point - digits.length), '');
    return fromParts(p.neg, digits.slice(0, point), digits.slice(point));
  }
  function addOne(digits) {
    var a = digits.split(''), i = a.length - 1;
    while (i >= 0) { if (a[i] === '9') { a[i] = '0'; i--; } else { a[i] = String(+a[i] + 1); break; } }
    return (i < 0 ? '1' : '') + a.join('');
  }
  /** Round half away from zero to n places, exactly. */
  function roundNum(c, n) {
    var p = numParts(c);
    if (p.fp.length <= n) return c;
    var keep = p.fp.slice(0, n), next = p.fp.charCodeAt(n) - 48;
    var digits = p.ip + keep;
    if (next >= 5) digits = addOne(digits);
    var ipLen = digits.length - keep.length;
    return fromParts(p.neg, digits.slice(0, ipLen), digits.slice(ipLen));
  }
  function scaleOf(c) { var d = c.indexOf('.'); return d >= 0 ? c.length - d - 1 : 0; }
  function cmpNum(a, b) {
    var x = numParts(a), y = numParts(b);
    if (x.neg !== y.neg) return x.neg ? -1 : 1;
    var s = x.neg ? -1 : 1;
    if (x.ip.length !== y.ip.length) return (x.ip.length < y.ip.length ? -1 : 1) * s;
    if (x.ip !== y.ip) return (x.ip < y.ip ? -1 : 1) * s;
    var l = Math.max(x.fp.length, y.fp.length);
    var fx = x.fp + '0'.repeat(l - x.fp.length), fy = y.fp + '0'.repeat(l - y.fp.length);
    return fx === fy ? 0 : (fx < fy ? -1 : 1) * s;
  }
  var SUM_SCALE = 6;
  /** A canonical number as BigInt units of 10^-6 (the sum's precision). */
  function microUnits(c) {
    var p = numParts(c);
    var fp = (p.fp + '000000').slice(0, SUM_SCALE);
    var b = BigInt(p.ip + fp);
    return p.neg ? -b : b;
  }
  function fromMicro(b) {
    var neg = b < 0n; if (neg) b = -b;
    var s = b.toString().padStart(SUM_SCALE + 1, '0');
    return fromParts(neg, s.slice(0, s.length - SUM_SCALE), s.slice(s.length - SUM_SCALE));
  }

  /* ---------------- dates ---------------- */

  var DATE_FORMATS = [
    'YYYY-MM-DDTHH:mm:ssZ', 'YYYY-MM-DDTHH:mm:ss.SSSZ', 'YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DDTHH:mm:ss.SSS',
    'YYYY-MM-DD HH:mm:ssZ', 'YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm:ss.SSS', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD',
    'YYYY/MM/DD', 'MM/DD/YYYY HH:mm:ss', 'MM/DD/YYYY HH:mm', 'MM/DD/YYYY', 'DD/MM/YYYY HH:mm:ss', 'DD/MM/YYYY HH:mm',
    'DD/MM/YYYY', 'DD.MM.YYYY', 'DD-MMM-YYYY', 'MMM D, YYYY', 'YYYYMMDD',
  ];
  // Every format but YYYYMMDD is guessed from data; eight digits is a number
  // until someone says otherwise with a rule.
  var INFER_COUNT = DATE_FORMATS.length - 1;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var compiled = {};
  function compileFormat(fmt) {
    if (compiled[fmt]) return compiled[fmt];
    var parts = [], fields = [], re = '^';
    var tok = /YYYY|MMM|MM|DD|D|HH|mm|ss|SSS|Z|./g, m;
    while ((m = tok.exec(fmt))) {
      var t = m[0];
      parts.push(t);
      if (t === 'YYYY') { re += '(\\d{4})'; fields.push('Y'); }
      else if (t === 'MMM') { re += '([A-Za-z]{3})'; fields.push('b'); }
      else if (t === 'MM') { re += fmt === 'YYYYMMDD' ? '(\\d{2})' : '(\\d{1,2})'; fields.push('M'); }
      else if (t === 'DD' || t === 'D') { re += fmt === 'YYYYMMDD' ? '(\\d{2})' : '(\\d{1,2})'; fields.push('D'); }
      else if (t === 'HH') { re += '(\\d{1,2})'; fields.push('h'); }
      else if (t === 'mm') { re += '(\\d{2})'; fields.push('m'); }
      else if (t === 'ss') { re += '(\\d{2})'; fields.push('s'); }
      // Fractions of a second are optional where the format has them: one
      // export writes "10:00:00Z" and "10:00:00.250Z" in the same column.
      else if (t === 'SSS') { if (re.slice(-2) === '\\.') re = re.slice(0, -2); re += '(?:\\.(\\d{1,9}))?'; fields.push('f'); }
      else if (t === 'Z') { re += '(Z|z|[+-]\\d{2}(?::?\\d{2})?)'; fields.push('z'); }
      else re += t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
    var c = { fmt: fmt, re: new RegExp(re + '$'), fields: fields, parts: parts, time: fmt.indexOf('HH') >= 0, zone: fmt.indexOf('Z') >= 0 };
    compiled[fmt] = c;
    return c;
  }
  function daysIn(y, m) { return [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
  /** {ms, time, zone} or null. A naive time is read as if it were UTC, so
   *  two naive times compare by their wall clocks. */
  function parseDate(s, fmt) {
    if (s === null || s === undefined) return null;
    var c = compileFormat(fmt), m = c.re.exec(String(s));
    if (!m) return null;
    var Y = 0, M = 1, D = 1, h = 0, mi = 0, se = 0, ms = 0, off = 0;
    for (var i = 0; i < c.fields.length; i++) {
      var v = m[i + 1];
      switch (c.fields[i]) {
        case 'Y': Y = +v; break;
        case 'M': M = +v; break;
        case 'b': M = MONTHS.indexOf(v[0].toUpperCase() + v.slice(1).toLowerCase()) + 1; if (!M) return null; break;
        case 'D': D = +v; break;
        case 'h': h = +v; break;
        case 'm': mi = +v; break;
        case 's': se = +v; break;
        case 'f': ms = v === undefined ? 0 : +(v + '00').slice(0, 3); break;
        case 'z': if (v !== 'Z' && v !== 'z') { var sg = v[0] === '-' ? -1 : 1; var d = v.slice(1).replace(':', ''); off = sg * (+d.slice(0, 2) * 60 + (+d.slice(2, 4) || 0)); } break;
        default: break;
      }
    }
    if (Y < 1000 || M < 1 || M > 12 || D < 1 || D > daysIn(Y, M) || h > 23 || mi > 59 || se > 59) return null;
    return { ms: Date.UTC(Y, M - 1, D, h, mi, se, ms) - off * 60000, time: c.time, zone: c.zone };
  }
  function p2(n) { return n < 10 ? '0' + n : String(n); }
  function formatDate(ms, fmt) {
    var c = compileFormat(fmt), d = new Date(ms), out = '';
    for (var i = 0; i < c.parts.length; i++) {
      var t = c.parts[i];
      if (t === 'YYYY') out += String(d.getUTCFullYear()).padStart(4, '0');
      else if (t === 'MMM') out += MONTHS[d.getUTCMonth()];
      else if (t === 'MM') out += p2(d.getUTCMonth() + 1);
      else if (t === 'DD') out += p2(d.getUTCDate());
      else if (t === 'D') out += String(d.getUTCDate());
      else if (t === 'HH') out += p2(d.getUTCHours());
      else if (t === 'mm') out += p2(d.getUTCMinutes());
      else if (t === 'ss') out += p2(d.getUTCSeconds());
      else if (t === 'SSS') out += String(d.getUTCMilliseconds()).padStart(3, '0');
      else if (t === 'Z') out += 'Z';
      else out += t;
    }
    return out;
  }
  /** The form two dates are compared in: an ISO day, or an ISO time (with Z
   *  when the column carries a zone). */
  function canonDate(p) {
    var d = new Date(p.ms);
    var day = d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
    if (!p.time) return day;
    var t = day + 'T' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
    if (d.getUTCMilliseconds()) t += '.' + String(d.getUTCMilliseconds()).padStart(3, '0');
    return t + (p.zone ? 'Z' : '');
  }
  var CANON_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z)?)?$/;
  function canonDateMs(s) {
    var m = CANON_DATE.exec(s);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), +(m[7] || 0));
  }

  /* ---------------- reading files ---------------- */

  var NULL_TOKENS = { 'NULL': 1, 'null': 1, 'Null': 1, '\\N': 1, 'None': 1, 'nil': 1, 'NaN': 1, 'N/A': 1, 'n/a': 1, '#N/A': 1 };
  var BOOL = { 'true': 'true', 'false': 'false', 't': 'true', 'f': 'false', 'yes': 'true', 'no': 'false', 'y': 'true', 'n': 'false' };

  /** A streaming CSV/TSV reader. push() text as it arrives, end() once.
   *  Quotes (with "" inside), line breaks inside quotes, CRLF/LF/CR, a BOM
   *  at the start. An unquoted null token (NULL, \N, ...) is read as null;
   *  a quoted one is the text. With emptyNull, an unquoted empty cell is
   *  null too (Postgres COPY's convention). */
  function createCsvParser(opts) {
    var delim = (opts && opts.delimiter) || ',';
    var D = delim.charCodeAt(0);
    var onRow = opts.onRow;
    var emptyNull = Boolean(opts.emptyNull);
    var buf = '', first = true, issues = { badQuotes: 0, longCells: 0 };
    function cell(raw, quoted) {
      if (raw.length > LIMITS.maxCellLen) { issues.longCells++; raw = raw.slice(0, LIMITS.maxCellLen); }
      if (quoted) return raw;
      if (raw === '') return emptyNull ? null : '';
      return NULL_TOKENS[raw] === 1 ? null : raw;
    }
    /** Parse every complete row in buf; keep the rest. */
    function drain(final) {
      var s = buf, n = s.length, pos = 0;
      for (;;) {
        if (pos >= n) { buf = ''; return; }
        var start = pos, row = [], i = pos, done = false;
        for (;;) {
          if (i >= n) {
            if (!final) { buf = s.slice(start); return; }
            row.push(cell('', false)); done = true; pos = n; break;
          }
          var c = s.charCodeAt(i);
          if (c === 34) { // a quoted field
            var parts = '', j = i + 1, closed = false;
            for (;;) {
              var q = s.indexOf('"', j);
              if (q < 0) break;
              if (q + 1 < n && s.charCodeAt(q + 1) === 34) { parts += s.slice(j, q + 1); j = q + 2; continue; }
              if (q + 1 >= n && !final) break; // might be "" split across chunks
              parts += s.slice(j, q); j = q + 1; closed = true; break;
            }
            if (!closed) {
              if (!final) { buf = s.slice(start); return; }
              issues.badQuotes++; row.push(cell(parts + s.slice(j), true)); pos = n; done = true; break;
            }
            // after the closing quote: a delimiter, a line end or the end
            var k = j;
            while (k < n) { var ck = s.charCodeAt(k); if (ck === D || ck === 10 || ck === 13) break; k++; }
            if (k > j) { issues.badQuotes++; parts += s.slice(j, k); }
            if (k >= n && !final) { buf = s.slice(start); return; }
            row.push(cell(parts, true));
            i = k;
          } else {
            var k2 = i;
            while (k2 < n) { var c2 = s.charCodeAt(k2); if (c2 === D || c2 === 10 || c2 === 13) break; k2++; }
            if (k2 >= n && !final) { buf = s.slice(start); return; }
            row.push(cell(s.slice(i, k2), false));
            i = k2;
          }
          if (i >= n) { pos = n; done = true; break; }
          var ce = s.charCodeAt(i);
          if (ce === D) { i++; if (i >= n && final) { row.push(cell('', false)); pos = n; done = true; break; } continue; }
          // a line end
          if (ce === 13) { if (i + 1 < n) { i += s.charCodeAt(i + 1) === 10 ? 2 : 1; } else if (!final) { buf = s.slice(start); return; } else i++; }
          else i++;
          pos = i; done = true; break;
        }
        if (done) {
          if (!(row.length === 1 && (row[0] === '' || (row[0] === null && emptyNull)))) onRow(row);
          else issues.blank = (issues.blank || 0) + 1;
        }
      }
    }
    return {
      issues: issues,
      push: function (text) {
        if (first) { if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); if (text.length) first = false; }
        buf += text;
        drain(false);
      },
      end: function () { drain(true); },
    };
  }

  function jsonCell(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v.length > LIMITS.maxCellLen ? v.slice(0, LIMITS.maxCellLen) : v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    // Nested numbers come back as written too (JSON.rawJSON where the engine has it).
    try { return JSON.stringify(v, function (k, x) { var u = unwrap(x); return u !== x ? (JSON.rawJSON ? JSON.rawJSON(u) : Number(u)) : x; }).slice(0, LIMITS.maxCellLen); } catch (e) { return null; }
  }
  // Keep a number as it was written ("12.50", "12345678901234567890"), where
  // the engine can say (JSON.parse source text access); else as JS prints it.
  function reviver(key, value, ctx) {
    if (typeof value === 'number' && ctx && typeof ctx.source === 'string') return { __num: ctx.source };
    return value;
  }
  function unwrap(v) { return v && typeof v === 'object' && typeof v.__num === 'string' && Object.keys(v).length === 1 ? v.__num : v; }

  /** JSON Lines: one object per line. Columns are the keys in the order they
   *  are first seen; a key a line leaves out is null for that line. */
  function createJsonlParser(opts) {
    var onRow = opts.onRow, buf = '', first = true;
    var cols = [], idx = Object.create(null);
    var issues = { malformed: 0, notObject: 0, blank: 0, tooManyKeys: 0 };
    function line(l) {
      if (l.charCodeAt(l.length - 1) === 13) l = l.slice(0, -1);
      if (!l.trim()) { issues.blank++; return; }
      var o;
      try { o = JSON.parse(l, reviver); } catch (e) { issues.malformed++; return; }
      if (!o || typeof o !== 'object' || Array.isArray(o)) { issues.notObject++; return; }
      var row = new Array(cols.length);
      for (var i = 0; i < row.length; i++) row[i] = null;
      var keys = Object.keys(o);
      for (var k = 0; k < keys.length; k++) {
        var name = keys[k], j = idx[name];
        if (j === undefined) {
          if (cols.length >= LIMITS.maxColumns) { issues.tooManyKeys++; continue; }
          j = idx[name] = cols.length; cols.push(name); row.push(null);
        }
        row[j] = jsonCell(unwrap(o[name]));
      }
      onRow(row);
    }
    function drain(final) {
      var start = 0, nl;
      while ((nl = buf.indexOf('\n', start)) >= 0) { line(buf.slice(start, nl)); start = nl + 1; }
      buf = buf.slice(start);
      if (final && buf) { line(buf); buf = ''; }
    }
    return {
      issues: issues,
      columns: cols,
      push: function (text) { if (first) { if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); if (text.length) first = false; } buf += text; drain(false); },
      end: function () { drain(true); },
    };
  }

  /** Format and delimiter from a file's name and its first few KB. */
  function sniff(text, name) {
    var n = String(name || '').toLowerCase();
    var t = String(text || '').replace(/^﻿/, '');
    var firstChar = (t.match(/\S/) || [''])[0];
    if (/\.(jsonl|ndjson|json)$/.test(n) || firstChar === '{') return { format: 'jsonl', delimiter: null };
    if (/\.(tsv|tab)$/.test(n)) return { format: 'csv', delimiter: '\t' };
    var sample = t.slice(0, 65536);
    var best = { d: ',', score: -1 };
    [',', '\t', ';', '|'].forEach(function (d) {
      var counts = [];
      var p = createCsvParser({ delimiter: d, onRow: function (r) { if (counts.length < 40) counts.push(r.length); } });
      p.push(sample); p.end();
      if (sample.length >= 65536 && counts.length > 1) counts.pop(); // the cut line
      if (!counts.length) return;
      var freq = {}; counts.forEach(function (c) { freq[c] = (freq[c] || 0) + 1; });
      var mode = 0, modeN = 0;
      Object.keys(freq).forEach(function (k) { if (freq[k] > modeN || (freq[k] === modeN && +k > mode)) { mode = +k; modeN = freq[k]; } });
      if (mode < 2) return;
      var score = (modeN / counts.length) * 1000 + mode;
      if (score > best.score) best = { d: d, score: score };
    });
    return { format: 'csv', delimiter: best.d };
  }

  function looksTyped(v) {
    if (v === null || v === '') return false;
    if (canonNum(v) !== null) return true;
    for (var i = 0; i < INFER_COUNT; i++) if (parseDate(v, DATE_FORMATS[i])) return true;
    return false;
  }
  /** Is the first row column names? Yes when every cell is a distinct,
   *  non-empty label and none is a number or a date. */
  function detectHeader(rows) {
    if (!rows.length) return false;
    var r0 = rows[0], seen = {};
    for (var i = 0; i < r0.length; i++) {
      var v = r0[i];
      if (v === null || String(v).trim() === '' || looksTyped(v)) return false;
      var k = String(v).trim().toLowerCase();
      if (seen[k]) return false;
      seen[k] = 1;
    }
    return true;
  }
  /** Column names, cleaned and made unique. */
  function nameColumns(header, width) {
    var out = [], used = {};
    for (var i = 0; i < width; i++) {
      var raw = header && header[i] !== undefined && header[i] !== null ? clean(header[i], LIMITS.maxNameLen).trim() : '';
      var name = raw || 'col_' + (i + 1);
      var base = name, n = 2;
      while (used[name.toLowerCase()]) name = base + '_' + n++;
      used[name.toLowerCase()] = 1;
      out.push(name);
    }
    return out;
  }

  /** Read a whole text at once (tests, small pastes): {format, delimiter,
   *  header, columns, rows, issues}. The worker does the same in a stream. */
  function parseText(text, name, opts) {
    opts = opts || {};
    var sn = opts.format ? { format: opts.format, delimiter: opts.delimiter || ',' } : sniff(text, name);
    var rows = [];
    if (sn.format === 'jsonl') {
      var jp = createJsonlParser({ onRow: function (r) { rows.push(r); } });
      jp.push(text); jp.end();
      var w = jp.columns.length;
      rows.forEach(function (r) { while (r.length < w) r.push(null); });
      return { format: 'jsonl', delimiter: null, header: true, headerGuess: true, columns: nameColumns(jp.columns, w), rows: rows, issues: summariseIssues(jp.issues, 0, 0) };
    }
    var p = createCsvParser({ delimiter: sn.delimiter, emptyNull: opts.emptyNull, onRow: function (r) { rows.push(r); } });
    p.push(text); p.end();
    return shapeCsv(rows, sn.delimiter, opts.header, p.issues);
  }
  /** Header decision and ragged rows for a parsed CSV. */
  function shapeCsv(rows, delimiter, header, issues) {
    var guess = detectHeader(rows.slice(0, 20));
    var hasHeader = header === true || header === false ? header : guess;
    var head = hasHeader && rows.length ? rows.shift() : null;
    var width = head ? head.length : rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    width = Math.min(width, LIMITS.maxColumns);
    var short = 0, long = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.length < width) { short++; while (r.length < width) r.push(null); }
      else if (r.length > width) { long++; r.length = width; }
    }
    return { format: 'csv', delimiter: delimiter, header: hasHeader, headerGuess: guess, columns: nameColumns(head, width), rows: rows, issues: summariseIssues(issues, short, long) };
  }
  function summariseIssues(raw, short, long) {
    var out = [];
    raw = raw || {};
    if (short) out.push(plural(short, 'row') + ' had fewer cells than the header - the missing cells read as null');
    if (long) out.push(plural(long, 'row') + ' had more cells than the header - the extra cells were left out');
    if (raw.badQuotes) out.push(plural(raw.badQuotes, 'cell') + ' had a stray quote - read as written');
    if (raw.longCells) out.push(plural(raw.longCells, 'cell') + ' longer than 1,000,000 characters were cut');
    if (raw.malformed) out.push(plural(raw.malformed, 'line') + ' were not valid JSON and were skipped');
    if (raw.notObject) out.push(plural(raw.notObject, 'line') + ' were not JSON objects and were skipped');
    if (raw.tooManyKeys) out.push('More than ' + fmtInt(LIMITS.maxColumns) + ' keys - the rest were left out');
    return out;
  }

  /* ---------------- profiling a column ---------------- */

  var TYPES = ['int', 'decimal', 'bool', 'date', 'datetime', 'text', 'empty'];
  var TYPE_LABEL = { int: 'whole number', decimal: 'decimal', bool: 'true/false', date: 'date', datetime: 'date and time', text: 'text', empty: 'all null' };

  /** Per-column statistics, streamed: no value is kept but a hash for the
   *  distinct count and the first few for the preview. */
  function createProfiler(columns) {
    function mk(name) {
      return { name: name, n: 0, nulls: 0, empties: 0, vals: 0, int: 0, dec: 0, bool: 0, date: 0, dmask: (1 << INFER_COUNT) - 1, dateMiss: 0, minLen: Infinity, maxLen: 0, padded: 0, upper: 0, lower: 0, distinct: createDistinct() };
    }
    var cols = columns.map(mk);
    var rows = 0, preview = [];
    /** A column first seen part-way (a JSON Lines key): the rows before it read it as null. */
    function addColumn(name) { var c = mk(name); c.n = rows; c.nulls = rows; cols.push(c); }
    function add(row) {
      rows++;
      if (preview.length < 8) preview.push(row.slice(0, Math.min(row.length, 60)));
      for (var i = 0; i < cols.length; i++) {
        var c = cols[i], v = row[i];
        c.n++;
        if (v === null || v === undefined) { c.nulls++; continue; }
        if (v === '') { c.empties++; continue; }
        c.vals++;
        c.distinct.add(v);
        var len = v.length;
        if (len < c.minLen) c.minLen = len;
        if (len > c.maxLen) c.maxLen = len;
        var f = v.charCodeAt(0), l = v.charCodeAt(len - 1);
        if (f === 32 || f === 9 || l === 32 || l === 9) c.padded++;
        if (v !== v.toLowerCase()) c.upper++;
        if (v !== v.toUpperCase()) c.lower++;
        // A leading zero ("02134", "007") is a code, not a number: comparing
        // it as one would call "02134" and "2134" the same.
        var num = /^[+-]?0\d/.test(v) ? null : canonNum(v);
        if (num !== null && !/^\s|\s$/.test(v)) { c.dec++; if (num.indexOf('.') < 0 && !/[.eE]/.test(v)) c.int++; }
        if (BOOL[v.toLowerCase()]) c.bool++;
        if (c.dmask && num === null) {
          var m2 = 0;
          for (var k = 0; k < INFER_COUNT; k++) if ((c.dmask & (1 << k)) && parseDate(v, DATE_FORMATS[k])) m2 |= (1 << k);
          if (m2) { c.date++; c.dmask = m2; } else c.dateMiss++;
        }
      }
    }
    function finish() {
      return {
        rows: rows,
        preview: preview,
        columns: cols.map(function (c) {
          var d = c.distinct.count();
          var out = { name: c.name, type: 'text', format: null, rows: c.n, nulls: c.nulls, empties: c.empties, distinct: d.n, distinctApprox: d.approx, minLen: c.vals ? c.minLen : 0, maxLen: c.maxLen, padded: c.padded, upper: c.upper, lower: c.lower, bad: 0 };
          var n = c.vals;
          if (!n) { out.type = 'empty'; return out; }
          var tol = Math.min(50, Math.floor(n * 0.002));
          if (c.int >= n - tol) { out.type = 'int'; out.bad = n - c.int; }
          else if (c.dec >= n - tol) { out.type = 'decimal'; out.bad = n - c.dec; }
          else if (c.bool >= n - tol && c.bool) { out.type = 'bool'; out.bad = n - c.bool; }
          else if (c.date >= n - tol && c.dmask) {
            var fi = 0; while (fi < INFER_COUNT && !(c.dmask & (1 << fi))) fi++;
            out.format = DATE_FORMATS[fi];
            out.type = out.format.indexOf('HH') >= 0 ? 'datetime' : 'date';
            out.bad = n - c.date;
            // MM/DD and DD/MM both fit: say so.
            if (out.format.indexOf('MM/DD') === 0) { var alt = DATE_FORMATS.indexOf(out.format.replace('MM/DD', 'DD/MM')); if (c.dmask & (1 << alt)) out.ambiguous = true; }
          }
          return out;
        }),
      };
    }
    return { add: add, finish: finish, addColumn: addColumn, width: function () { return cols.length; } };
  }

  /* ---------------- mapping columns ---------------- */

  var SYN = {
    cust: 'customer', cst: 'customer', client: 'customer', clients: 'customer', customers: 'customer',
    acct: 'account', acc: 'account', usr: 'user', users: 'user', emp: 'employee', prod: 'product', prd: 'product', ord: 'order', orders: 'order', txn: 'transaction', trans: 'transaction', inv: 'invoice',
    no: 'num', nbr: 'num', number: 'num', nr: 'num',
    dt: 'date', day: 'date', ts: 'time', timestamp: 'time', datetime: 'time', tstamp: 'time',
    cd: 'code', desc: 'description', descr: 'description', addr: 'address', qty: 'quantity', amt: 'amount', bal: 'balance',
    tel: 'phone', telephone: 'phone', mobile: 'phone', mail: 'email', e: 'e', fname: 'first', lname: 'last', surname: 'last', family: 'last', given: 'first', forename: 'first',
    zip: 'postal', postcode: 'postal', zipcode: 'postal', ctry: 'country', cntry: 'country', st: 'state', created: 'create', updated: 'update', modified: 'update',
    pk: 'id', uuid: 'id', guid: 'id', key: 'id',
  };
  // Tokens that describe a unit, a format or a role rather than the thing: they
  // count for a little.
  var WEAK = { at: 0.2, on: 0.2, code: 0.3, date: 0.4, time: 0.4, cents: 0.3, cent: 0.3, pennies: 0.3, minor: 0.3, units: 0.3, usd: 0.3, amount: 0.5, name: 0.5, num: 0.5, id: 0.6, flag: 0.3, ind: 0.3, val: 0.3, value: 0.3, txt: 0.2, str: 0.2, col: 0.1, fld: 0.1, tbl: 0.1, the: 0.1, of: 0.1, is: 0.3 };
  function tokens(name) {
    var s = String(name || '').replace(CTRL, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_');
    s = s.replace(/(^|_)e_mail(_|$)/g, '$1email$2');
    return s.split('_').filter(Boolean).map(function (t) { return SYN[t] || t; });
  }
  function normName(name) { return tokens(name).join('_'); }
  function weight(t) { return WEAK[t] !== undefined ? WEAK[t] : 1; }
  function similarity(a, b) {
    var ta = tokens(a), tb = tokens(b);
    if (!ta.length || !tb.length) return 0;
    if (ta.join('_') === tb.join('_')) return 1;
    var wa = 0, wb = 0, common = 0, used = {};
    ta.forEach(function (t) { wa += weight(t); });
    tb.forEach(function (t) { wb += weight(t); });
    ta.forEach(function (t) { if (!used[t] && tb.indexOf(t) >= 0) { used[t] = 1; common += weight(t); } });
    var s = (2 * common) / (wa + wb);
    // A shared strong token with nothing strong left over reads as a rename.
    var strongA = ta.filter(function (t) { return weight(t) === 1; }), strongB = tb.filter(function (t) { return weight(t) === 1; });
    if (strongA.length && strongA.join('_') === strongB.join('_')) s = Math.max(s, 0.8);
    return Math.min(0.99, s);
  }
  var NUMERIC = { int: 1, decimal: 1 };
  var DATEISH = { date: 1, datetime: 1 };
  function typesFit(a, b) {
    if (!a || !b || a === 'text' || b === 'text' || a === 'empty' || b === 'empty') return true;
    if (NUMERIC[a] && NUMERIC[b]) return true;
    if (DATEISH[a] && DATEISH[b]) return true;
    return a === b;
  }
  var FIRST = { first: 1 }, LAST = { last: 1 };
  function isFirstName(n) { var t = tokens(n); return t.some(function (x) { return FIRST[x]; }) && t.indexOf('name') >= 0 || t.join('_') === 'first'; }
  function isLastName(n) { var t = tokens(n); return t.some(function (x) { return LAST[x]; }) && t.indexOf('name') >= 0 || t.join('_') === 'last'; }
  function isFullName(n) { var t = tokens(n); return t.indexOf('name') >= 0 && !isFirstName(n) && !isLastName(n) && t.every(function (x) { return x === 'name' || x === 'full' || x === 'customer' || x === 'contact' || x === 'person' || x === 'display' || x === 'user'; }); }

  /** Pair before columns with after columns by name: renames ("cust_id" ->
   *  "customer_id"), units ("balance_cents" -> "balance"), and the common
   *  split full_name -> first_name + last_name (or its join). Each pair has a
   *  confidence: exact, likely or a guess. Types that cannot match (a date
   *  and a number) lower it. */
  function automap(before, after) {
    var bn = before.map(function (c) { return c.name; }), an = after.map(function (c) { return c.name; });
    var cands = [];
    for (var i = 0; i < before.length; i++) {
      for (var j = 0; j < after.length; j++) {
        var s = similarity(bn[i], an[j]);
        if (!typesFit(before[i].type, after[j].type)) s *= 0.5;
        if (s >= 0.45) cands.push({ i: i, j: j, s: s });
      }
    }
    cands.sort(function (x, y) { return y.s - x.s || x.i - y.i || x.j - y.j; });
    var bUsed = {}, aUsed = {}, pairs = [];
    cands.forEach(function (c) {
      if (bUsed[c.i] || aUsed[c.j]) return;
      bUsed[c.i] = aUsed[c.j] = 1;
      pairs.push({ from: [bn[c.i]], to: [an[c.j]], rules: [], conf: c.s >= 0.995 ? 'exact' : c.s >= 0.75 ? 'likely' : 'guess', score: Math.round(c.s * 100) / 100 });
    });
    // Splits and joins of a person's name.
    var freeB = bn.filter(function (n, i) { return !bUsed[i]; }), freeA = an.filter(function (n, j) { return !aUsed[j]; });
    var fA = freeA.filter(isFirstName), lA = freeA.filter(isLastName), fullB = freeB.filter(isFullName);
    if (fullB.length && fA.length && lA.length) {
      pairs.push({ from: [fullB[0]], to: [fA[0], lA[0]], sep: ' ', rules: [], conf: 'likely', score: 0.8, why: 'A name split into first and last' });
      bUsed[bn.indexOf(fullB[0])] = aUsed[an.indexOf(fA[0])] = aUsed[an.indexOf(lA[0])] = 1;
    }
    var fB = freeB.filter(isFirstName), lB = freeB.filter(isLastName), fullA = freeA.filter(isFullName);
    if (fullA.length && fB.length && lB.length && !aUsed[an.indexOf(fullA[0])]) {
      pairs.push({ from: [fB[0], lB[0]], to: [fullA[0]], sep: ' ', rules: [], conf: 'likely', score: 0.8, why: 'First and last joined into one name' });
      bUsed[bn.indexOf(fB[0])] = bUsed[bn.indexOf(lB[0])] = aUsed[an.indexOf(fullA[0])] = 1;
    }
    // Keep the before file's column order: it is how people read a table.
    pairs.sort(function (x, y) { return bn.indexOf(x.from[0]) - bn.indexOf(y.from[0]); });
    return {
      pairs: pairs,
      unmatchedBefore: bn.filter(function (n, i) { return !bUsed[i]; }),
      unmatchedAfter: an.filter(function (n, j) { return !aUsed[j]; }),
    };
  }
  /** The key to join on: a one-to-one pair unique and never null on both
   *  sides, an id-looking one first. */
  function suggestKey(pairs, before, after) {
    var byB = {}, byA = {};
    before.forEach(function (c) { byB[c.name] = c; });
    after.forEach(function (c) { byA[c.name] = c; });
    var best = null, bestScore = -1;
    pairs.forEach(function (p, idx) {
      if (p.from.length !== 1 || p.to.length !== 1) return;
      var b = byB[p.from[0]], a = byA[p.to[0]];
      if (!b || !a) return;
      var uniqB = b.nulls === 0 && b.empties === 0 && b.distinct === b.rows && !b.distinctApprox;
      var uniqA = a.nulls === 0 && a.empties === 0 && a.distinct >= a.rows - Math.max(2, Math.floor(a.rows * 0.01)) && !a.distinctApprox;
      if (!uniqB || !uniqA) return;
      var t = tokens(p.to[0]);
      var score = (t.indexOf('id') >= 0 ? 4 : 0) + (t.indexOf('num') >= 0 || t.indexOf('code') >= 0 ? 2 : 0) + (a.type === 'int' ? 1 : 0) - idx * 0.01;
      if (score > bestScore) { bestScore = score; best = p.to[0]; }
    });
    return best ? [best] : [];
  }

  /* ---------------- rules: a fixed list, no code ---------------- */

  // Applied in this order, whatever order they were added in. "both" rules
  // apply to the after side too (they are about what counts as equal); every
  // other rule shapes the before side into what the after side should be.
  var RULES = [
    { id: 'ignore', label: 'Ignore column', both: true, help: 'Not compared. Still listed in the report.' },
    { id: 'nullEmpty', label: 'Null equals empty', both: true, help: 'A null and an empty string count as the same.' },
    { id: 'trim', label: 'Trim spaces', help: 'Spaces and tabs at either end of a before value are removed.' },
    { id: 'map', label: 'Value map', help: 'Swap whole values using a table: A → active.' },
    { id: 'scale', label: 'Cents ↔ units', help: 'Divide by 100 (cents to dollars) or multiply by 100.' },
    { id: 'date', label: 'Date reformat', help: 'Read the before value with one format and write it in another.' },
    { id: 'tz', label: 'Time zone offset', help: 'Move a before date-time by a number of hours.' },
    { id: 'round', label: 'Round numbers', both: true, help: 'Compare numbers rounded to n decimal places.' },
    { id: 'fold', label: 'Case fold', both: true, help: 'Upper and lower case count as the same.' },
  ];
  var RULE_IDS = RULES.map(function (r) { return r.id; });
  var RULE_BY = {}; RULES.forEach(function (r) { RULE_BY[r.id] = r; });

  /** One rule from anywhere (a recipe file, the model, the page), checked
   *  field by field. null if it is not a rule. */
  function cleanRule(r) {
    if (!r || typeof r !== 'object') return null;
    var id = r.rule;
    if (RULE_IDS.indexOf(id) < 0) return null;
    if (id === 'scale') return ['div100', 'mul100'].indexOf(r.op) >= 0 ? { rule: id, op: r.op } : null;
    if (id === 'round') { var n = Number(r.places); return Number.isInteger(n) && n >= 0 && n <= 10 ? { rule: id, places: n } : null; }
    if (id === 'date') return DATE_FORMATS.indexOf(r.from) >= 0 && DATE_FORMATS.indexOf(r.to) >= 0 ? { rule: id, from: r.from, to: r.to } : null;
    if (id === 'tz') { var h = Number(r.hours); return Number.isFinite(h) && h !== 0 && Math.abs(h) <= 14 && Math.round(h * 4) === h * 4 ? { rule: id, hours: h } : null; }
    if (id === 'map') {
      var t = Array.isArray(r.table) ? r.table : [];
      var seen = {}, table = [];
      t.slice(0, LIMITS.mapEntries).forEach(function (e) {
        if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || typeof e[1] !== 'string') return;
        var k = clean(e[0], 200);
        if (seen[k] === undefined) { seen[k] = 1; table.push([k, clean(e[1], 200)]); }
      });
      return table.length ? { rule: id, table: table } : null;
    }
    return { rule: id };
  }
  function ruleText(r) {
    switch (r.rule) {
      case 'scale': return r.op === 'div100' ? 'Cents → units (÷100)' : 'Units → cents (×100)';
      case 'round': return 'Round to ' + plural(r.places, 'place');
      case 'date': return 'Date ' + r.from + ' → ' + r.to;
      case 'tz': return 'Time zone ' + (r.hours > 0 ? '+' : '') + r.hours + 'h';
      case 'map': return 'Value map (' + plural(r.table.length, 'entry', 'entries') + ')';
      default: return RULE_BY[r.rule].label;
    }
  }
  function sortRules(rules) {
    var by = {};
    (rules || []).forEach(function (r) { var c = cleanRule(r); if (c) by[c.rule] = c; });
    return RULE_IDS.filter(function (id) { return by[id]; }).map(function (id) { return by[id]; });
  }

  /** A recipe from anywhere, checked against the real column names. Pairs
   *  naming a column that does not exist are dropped and counted. */
  function cleanRecipe(raw, beforeNames, afterNames) {
    var out = { parity: 'recipe', v: 1, pairs: [], key: [], target: [] }, dropped = 0;
    if (!raw || typeof raw !== 'object') return { recipe: out, dropped: 0, ok: false };
    var bSet = {}, aSet = {};
    (beforeNames || []).forEach(function (n) { bSet[n] = 1; });
    (afterNames || []).forEach(function (n) { aSet[n] = 1; });
    var bTaken = {}, aTaken = {};
    (Array.isArray(raw.pairs) ? raw.pairs : []).slice(0, LIMITS.recipePairs).forEach(function (p) {
      if (!p || typeof p !== 'object') { dropped++; return; }
      var from = (Array.isArray(p.from) ? p.from : []).filter(function (n) { return typeof n === 'string'; }).slice(0, 8);
      var to = (Array.isArray(p.to) ? p.to : []).filter(function (n) { return typeof n === 'string'; }).slice(0, 8);
      if (!from.length || !to.length || from.some(function (n) { return !bSet[n] || bTaken[n]; }) || to.some(function (n) { return !aSet[n] || aTaken[n]; })) { dropped++; return; }
      if (from.length > 1 && to.length > 1) { dropped++; return; }
      from.forEach(function (n) { bTaken[n] = 1; }); to.forEach(function (n) { aTaken[n] = 1; });
      var pair = { from: from, to: to, rules: sortRules(p.rules) };
      if (from.length > 1 || to.length > 1) pair.sep = typeof p.sep === 'string' && p.sep.length <= 5 ? p.sep.replace(CTRL, '') : ' ';
      out.pairs.push(pair);
    });
    var key = (Array.isArray(raw.key) ? raw.key : []).filter(function (n) { return typeof n === 'string' && aTaken[n]; }).slice(0, 4);
    out.key = key.filter(function (n, i) { return key.indexOf(n) === i; });
    out.target = cleanShape(raw.target);
    return { recipe: out, dropped: dropped, ok: true };
  }
  /** Columns as name, type and format only - the shape of a side. */
  function cleanShape(cols) {
    return (Array.isArray(cols) ? cols : []).slice(0, LIMITS.maxColumns).map(function (c) {
      if (!c || typeof c.name !== 'string') return null;
      var o = { name: clean(c.name, LIMITS.maxNameLen), type: TYPES.indexOf(c.type) >= 0 ? c.type : 'text' };
      if (DATE_FORMATS.indexOf(c.format) >= 0 && DATEISH[o.type]) o.format = c.format;
      return o;
    }).filter(Boolean);
  }

  /* ---------------- the plan: a recipe made runnable ---------------- */

  /** Compile a recipe against the two sides' columns. The after side's types
   *  decide how both are compared: numbers as exact decimals, dates as
   *  instants, true/false as true/false, text as written. */
  function compilePlan(recipe, beforeCols, afterCols) {
    var bIdx = {}, aIdx = {}, aBy = {}, bBy = {};
    beforeCols.forEach(function (c, i) { bIdx[c.name] = i; bBy[c.name] = c; });
    afterCols.forEach(function (c, i) { aIdx[c.name] = i; aBy[c.name] = c; });
    var errors = [];
    var pairs = recipe.pairs.map(function (p, n) {
      var many = p.to.length > 1 || p.from.length > 1;
      var tcol = p.to.length === 1 ? aBy[p.to[0]] : null;
      var ttype = many ? 'text' : (tcol && tcol.type) || 'text';
      if (ttype === 'empty') ttype = (bBy[p.from[0]] && bBy[p.from[0]].type) || 'text';
      var tfmt = DATEISH[ttype] && tcol ? tcol.format : null;
      if (DATEISH[ttype] && !tfmt) ttype = 'text';
      var rules = sortRules(p.rules);
      var has = {}; rules.forEach(function (r) { has[r.rule] = r; });
      var bfmt = bBy[p.from[0]] && bBy[p.from[0]].format;
      return {
        n: n, from: p.from.map(function (x) { return bIdx[x]; }), to: p.to.map(function (x) { return aIdx[x]; }),
        fromNames: p.from.slice(), toNames: p.to.slice(), sep: p.sep === undefined ? ' ' : p.sep,
        label: p.to.join(' + '), rules: rules, has: has, ttype: ttype, tfmt: tfmt, bfmt: bfmt || null,
        ignore: Boolean(has.ignore), cache: new Map(),
      };
    });
    var keyPairs = [];
    (recipe.key || []).forEach(function (k) {
      var i = -1;
      pairs.forEach(function (p, j) { if (p.toNames.indexOf(k) >= 0) i = j; });
      if (i < 0) errors.push('The key ' + k + ' is not mapped.');
      else if (keyPairs.indexOf(i) < 0) keyPairs.push(i);
    });
    if (!keyPairs.length) errors.push('Choose a key - the column that says which row is which.');
    var compare = [];
    pairs.forEach(function (p, i) { if (!p.ignore && keyPairs.indexOf(i) < 0) compare.push(i); });
    return { pairs: pairs, keyPairs: keyPairs, compare: compare, errors: errors, recipe: recipe, keyNames: (recipe.key || []).slice() };
  }

  function joinVals(vals, sep) {
    if (vals.length === 1) return vals[0];
    var parts = [];
    for (var i = 0; i < vals.length; i++) if (vals[i] !== null && vals[i] !== '') parts.push(vals[i]);
    if (!parts.length) { for (var j = 0; j < vals.length; j++) if (vals[j] === '') return ''; return null; }
    return parts.join(sep);
  }
  function toCanon(v, p) {
    if (v === null) return null;
    var t = p.ttype;
    if (t === 'int' || t === 'decimal') { var c = canonNum(v); return c === null ? v : c; }
    if (t === 'bool') { var b = BOOL[v.toLowerCase()]; return b || v; }
    if (t === 'date' || t === 'datetime') { var d = parseDate(v, p.tfmt); return d ? canonDate(d) : v; }
    return v;
  }
  function applyDateRules(v, p) {
    var h = p.has, d = null, fmt = null;
    if (h.date) { d = parseDate(v, h.date.from); fmt = h.date.to; if (!d) return v; }
    if (h.tz) {
      if (!d) {
        var tries = [p.tfmt, p.bfmt].filter(Boolean);
        for (var i = 0; i < tries.length && !d; i++) { d = parseDate(v, tries[i]); fmt = tries[i]; }
        if (!d) return v;
      }
      d = { ms: d.ms + h.tz.hours * 3600000, time: d.time, zone: d.zone };
    }
    if (!d) return v;
    // Written in the target's own format: go straight to the compared form.
    if (fmt === p.tfmt) { var tc = compileFormat(fmt); return { canon: canonDate({ ms: d.ms, time: tc.time, zone: tc.zone }) }; }
    return formatDate(d.ms, fmt);
  }
  /** The before value of a pair, shaped by its rules into what the after
   *  value should be, in the compared form. */
  function normBefore(p, row) {
    var v;
    if (p.from.length === 1) v = row[p.from[0]]; else { var vals = []; for (var i = 0; i < p.from.length; i++) vals.push(row[p.from[i]] === undefined ? null : row[p.from[i]]); v = joinVals(vals, p.sep); }
    if (v === undefined) v = null;
    var cache = p.cache, key = v === null ? '\u0000' : v;
    var hit = cache.get(key);
    if (hit !== undefined) return hit;
    var out = v, h = p.has;
    if (out === '' && h.nullEmpty) out = null;
    if (out !== null) {
      if (h.trim) out = out.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
      if (h.nullEmpty && out === '') out = null;
    }
    if (out !== null) {
      if (h.map) { for (var m = 0; m < h.map.table.length; m++) if (h.map.table[m][0] === out) { out = h.map.table[m][1]; break; } }
      if (h.scale) { var c = canonNum(out); if (c !== null) out = shiftNum(c, h.scale.op === 'div100' ? -2 : 2); }
      var dr = h.date || h.tz ? applyDateRules(out, p) : out;
      out = typeof dr === 'object' ? dr.canon : toCanon(dr, p);
      if (h.round) { var c2 = canonNum(out); if (c2 !== null) out = roundNum(c2, h.round.places); }
      if (h.fold) out = out.toLowerCase();
    }
    if (cache.size < 20000) cache.set(key, out);
    return out;
  }
  function normAfter(p, row) {
    var v;
    if (p.to.length === 1) v = row[p.to[0]]; else { var vals = []; for (var i = 0; i < p.to.length; i++) vals.push(row[p.to[i]] === undefined ? null : row[p.to[i]]); v = joinVals(vals, p.sep); }
    if (v === undefined || v === null) return null;
    var h = p.has;
    if (v === '' && h.nullEmpty) return null;
    var out = toCanon(v, p);
    if (h.round) { var c = canonNum(out); if (c !== null) out = roundNum(c, h.round.places); }
    if (h.fold) out = out.toLowerCase();
    return out;
  }
  function rawOf(idxs, row, sep) {
    if (idxs.length === 1) return row[idxs[0]] === undefined ? null : row[idxs[0]];
    return idxs.map(function (i) { return row[i] === undefined ? null : row[i]; });
  }

  /* ---------------- per-column aggregates ---------------- */

  function createAgg(p) {
    return { type: p.ttype, count: 0, nulls: 0, empties: 0, distinct: createDistinct(), maxLen: 0, sumInt: 0, sumMicro: 0, sumBig: 0n, numN: 0, min: null, max: null };
  }
  /** Add a canonical number to an exact running sum: whole units and
   *  millionths in two Numbers (exact while they stay under 2^53), BigInt for
   *  anything wider. */
  function sumAdd(a, c) {
    var neg = c.charCodeAt(0) === 45, d = c.indexOf('.');
    var ip = d >= 0 ? c.slice(neg ? 1 : 0, d) : c.slice(neg ? 1 : 0), fp = d >= 0 ? c.slice(d + 1) : '';
    if (ip.length > 15) { a.sumBig += microUnits(c); return; }
    var micro = fp ? +((fp + '000000').slice(0, SUM_SCALE)) : 0, whole = +ip;
    if (neg) { whole = -whole; micro = -micro; }
    a.sumInt += whole; a.sumMicro += micro;
    if (a.sumMicro >= 1e12 || a.sumMicro <= -1e12) { var carry = Math.trunc(a.sumMicro / 1e6); a.sumInt += carry; a.sumMicro -= carry * 1e6; }
    if (a.sumInt >= 4e15 || a.sumInt <= -4e15) { a.sumBig += BigInt(a.sumInt) * 1000000n; a.sumInt = 0; }
  }
  function sumOut(a) { return fromMicro(a.sumBig + BigInt(a.sumInt) * 1000000n + BigInt(a.sumMicro)); }
  function aggAdd(a, v) {
    if (v === null) { a.nulls++; return; }
    if (v === '') { a.empties++; return; }
    a.count++;
    a.distinct.add(v);
    if (v.length > a.maxLen) a.maxLen = v.length;
    if (NUMERIC[a.type]) {
      var c = canonNum(v);
      if (c !== null) {
        a.numN++;
        sumAdd(a, c);
        if (a.min === null || cmpNum(c, a.min) < 0) a.min = c;
        if (a.max === null || cmpNum(c, a.max) > 0) a.max = c;
      }
    } else if (DATEISH[a.type]) {
      if (CANON_DATE.test(v)) {
        if (a.min === null || v < a.min) a.min = v;
        if (a.max === null || v > a.max) a.max = v;
      }
    }
  }
  function aggOut(a) {
    var d = a.distinct.count();
    var o = { type: a.type, count: a.count, nulls: a.nulls, empties: a.empties, distinct: d.n, distinctApprox: d.approx, maxLen: a.maxLen };
    if (NUMERIC[a.type]) { o.sum = a.numN ? sumOut(a) : null; o.min = a.min; o.max = a.max; }
    else if (DATEISH[a.type]) { o.min = a.min; o.max = a.max; }
    return o;
  }

  /* ---------------- the hash pass ---------------- */

  /** One pass over one side: every row's key and compared values, as two
   *  hashes. Memory: a Map of key hash -> slot, plus 12 bytes a key. No value
   *  is kept. Duplicate keys add their row hashes lane by lane, so the same
   *  rows in any order give the same result. */
  function createHasher(plan, side) {
    var pairs = plan.pairs, kp = plan.keyPairs, cp = plan.compare;
    var norm = side === 'before' ? normBefore : normAfter;
    var keys = new Map(), cap = 1024, used = 0;
    var lo = new Uint32Array(cap), hi = new Uint32Array(cap), cnt = new Uint32Array(cap), khi = new Uint32Array(cap), klo = new Uint32Array(cap);
    var aggs = pairs.map(createAgg);
    var rows = 0, nullKeys = 0;
    var vals = new Array(pairs.length);
    function grow() {
      cap *= 2;
      var g = function (a) { var b = new Uint32Array(cap); b.set(a); return b; };
      lo = g(lo); hi = g(hi); cnt = g(cnt); khi = g(khi); klo = g(klo);
    }
    function add(row) {
      rows++;
      for (var i = 0; i < pairs.length; i++) {
        if (pairs[i].ignore) { vals[i] = null; continue; }
        var v = norm(pairs[i], row);
        vals[i] = v;
        aggAdd(aggs[i], v);
      }
      var ks = '';
      for (var k = 0; k < kp.length; k++) { var kv = vals[kp[k]]; if (kv === null) nullKeys++; ks += (k ? '\u001f' : '') + (kv === null ? '\u0000' : kv); }
      var rs = '';
      for (var c = 0; c < cp.length; c++) { var cv = vals[cp[c]]; rs += (cv === null ? '\u0000N' : cv) + '\u001f'; }
      hash2(ks, 1);
      var kh = (HB & 0x1fffff) * 4294967296 + HA, ka = HA, kb = HB & 0x1fffff;
      hash2(rs, 2);
      var slot = keys.get(kh);
      if (slot === undefined) {
        if (used === cap) grow();
        slot = used++;
        keys.set(kh, slot);
        lo[slot] = HA; hi[slot] = HB; cnt[slot] = 1; klo[slot] = ka; khi[slot] = kb;
      } else {
        lo[slot] = (lo[slot] + HA) >>> 0; hi[slot] = (hi[slot] + HB) >>> 0; cnt[slot]++;
      }
    }
    return {
      add: add,
      finish: function () {
        return { side: side, rows: rows, nullKeys: nullKeys, keys: keys, lo: lo, hi: hi, cnt: cnt, klo: klo, khi: khi, size: used, aggs: aggs.map(aggOut) };
      },
    };
  }

  /** What differs between two hash passes, by key hash, in file order. */
  function diffHashers(hb, ha) {
    var missing = [], extra = [], dup = [], mismatch = [], notUnique = [], common = new Set();
    hb.keys.forEach(function (sb, kh) {
      var sa = ha.keys.get(kh);
      if (sa === undefined) { missing.push(kh); return; }
      var cb = hb.cnt[sb], ca = ha.cnt[sa];
      if (cb !== ca) { dup.push(kh); return; }
      var same = hb.lo[sb] === ha.lo[sa] && hb.hi[sb] === ha.hi[sa];
      if (cb > 1) { notUnique.push(kh); if (!same) mismatch.push(kh); return; }
      common.add(kh);
      if (!same) mismatch.push(kh);
    });
    ha.keys.forEach(function (sa, kh) { if (!hb.keys.has(kh)) extra.push(kh); });
    return { missing: missing, extra: extra, dup: dup, mismatch: mismatch, notUnique: notUnique, common: common };
  }

  /** The keys worth a second look: a few of each kind, and every mismatch up
   *  to the cap (to say which columns differ). */
  function wantedKeys(d) {
    var w = new Set(), E = LIMITS.examples;
    d.missing.slice(0, E).forEach(function (k) { w.add(k); });
    d.extra.slice(0, E).forEach(function (k) { w.add(k); });
    d.dup.slice(0, E).forEach(function (k) { w.add(k); });
    d.notUnique.slice(0, E).forEach(function (k) { w.add(k); });
    d.mismatch.slice(0, LIMITS.detailCap).forEach(function (k) { w.add(k); });
    return w;
  }

  /** The second pass: the rows of the wanted keys (values kept), and the
   *  like-for-like aggregates - over rows whose key is on both sides once. */
  function createDetail(plan, side, wanted, common) {
    var pairs = plan.pairs, kp = plan.keyPairs;
    var norm = side === 'before' ? normBefore : normAfter;
    var rows = new Map();
    var aggs = pairs.map(createAgg);
    var line = 0;
    function add(row) {
      line++;
      var vals = new Array(pairs.length);
      for (var i = 0; i < pairs.length; i++) vals[i] = pairs[i].ignore ? null : norm(pairs[i], row);
      var ks = '';
      for (var k = 0; k < kp.length; k++) { var kv = vals[kp[k]]; ks += (k ? '\u001f' : '') + (kv === null ? '\u0000' : kv); }
      var kh = h53(ks, 1);
      if (common && common.has(kh)) for (var a = 0; a < pairs.length; a++) if (!pairs[a].ignore) aggAdd(aggs[a], vals[a]);
      if (!wanted.has(kh)) return;
      var list = rows.get(kh);
      if (!list) { list = []; rows.set(kh, list); }
      if (list.length >= 5) return;
      list.push({
        line: line,
        key: kp.map(function (i) { return vals[i]; }),
        vals: vals,
        raw: pairs.map(function (p) { return rawOf(side === 'before' ? p.from : p.to, row); }),
      });
    }
    return { add: add, finish: function () { return { rows: rows, aggs: aggs.map(aggOut) }; } };
  }

  /* ---------------- recognising a difference ---------------- */

  var PATTERNS = {
    null2empty: { label: 'null became empty', fix: 'If null and empty mean the same thing here, add the "Null equals empty" rule to this column.' },
    empty2null: { label: 'empty became null', fix: 'If null and empty mean the same thing here, add the "Null equals empty" rule to this column.' },
    lost: { label: 'value became null', fix: 'The value was lost on the way. Check the load for this column.' },
    filled: { label: 'null now has a value', fix: 'A default or a join may be filling nulls. Check the transform.' },
    trunc: { label: 'truncated', fix: 'The target column is too narrow. Widen it and reload these rows.' },
    case: { label: 'case changed', fix: 'If case does not matter, add the "Case fold" rule.' },
    space: { label: 'spaces added or removed', fix: 'If spaces at the ends do not matter, add the "Trim spaces" rule.' },
    unicode: { label: 'characters re-encoded', fix: 'The text was normalised or re-encoded. Check the load\'s character set.' },
    mojibake: { label: 'characters damaged', fix: 'Characters were damaged in transit - a file read with the wrong encoding.' },
    sign: { label: 'sign flipped', fix: 'Debits and credits were swapped. Check the transform\'s sign convention.' },
    rounded: { label: 'rounded', fix: 'The target column has fewer decimal places. If that is intended, add the "Round numbers" rule.' },
    scaled: { label: 'scaled by 100', fix: 'Units changed (cents and dollars). If intended, add the "Cents ↔ units" rule.' },
    number: { label: 'different number', fix: 'The values disagree. Look at the transform for this column.' },
    shift: { label: 'shifted', fix: 'A time zone was applied twice, or not at all. If every row moved, add the "Time zone offset" rule.' },
    dayshift: { label: 'moved by whole days', fix: 'Dates moved by whole days - often a time zone crossing midnight, or a day/month swap.' },
    format: { label: 'date written differently', fix: 'The same date in another format. Add a "Date reformat" rule.' },
    date: { label: 'different date or time', fix: 'The dates disagree. Look at the transform for this column.' },
    other: { label: 'different value', fix: 'The values disagree. Look at the transform for this column.' },
  };
  function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n); }
  /** Name what happened between the value expected and the value found. */
  function recognize(exp, got, ttype) {
    if (exp === null && got === '') return { id: 'null2empty' };
    if (exp === '' && got === null) return { id: 'empty2null' };
    if (got === null) return { id: 'lost' };
    if (exp === null) return { id: 'filled' };
    var ne = canonNum(exp), ng = canonNum(got);
    if (ne !== null && ng !== null) {
      if (ne !== '0' && (ne[0] === '-' ? ne.slice(1) : '-' + ne) === ng) return { id: 'sign' };
      var se = scaleOf(ne);
      for (var k = 0; k < se; k++) if (roundNum(ne, k) === ng) return { id: 'rounded', n: k };
      if (shiftNum(ne, 2) === ng || shiftNum(ne, -2) === ng) return { id: 'scaled' };
      return { id: 'number' };
    }
    var me = canonDateMs(exp), mg = canonDateMs(got);
    if (me !== null && mg !== null) {
      var diff = mg - me;
      if (diff % 86400000 === 0 && Math.abs(diff) <= 400 * 86400000) return { id: 'dayshift', n: diff / 86400000 };
      if (diff % 900000 === 0 && Math.abs(diff) <= 26 * 3600000) return { id: 'shift', n: diff / 3600000 };
      return { id: 'date' };
    }
    if (DATEISH[ttype] && mg !== null) {
      for (var f = 0; f < DATE_FORMATS.length; f++) { var p = parseDate(exp, DATE_FORMATS[f]); if (p && canonDate({ ms: p.ms, time: p.time, zone: /Z$/.test(got) }) === got) return { id: 'format', from: DATE_FORMATS[f] }; }
    }
    if (got.length < exp.length && got.length && exp.indexOf(got) === 0) return { id: 'trunc', n: got.length };
    if (got.replace(/\s+$/, '').length && got.length <= exp.length && exp.indexOf(got.replace(/\s+$/, '')) === 0 && got !== exp) return { id: 'trunc', n: got.length };
    if (exp.toLowerCase() === got.toLowerCase()) return { id: 'case' };
    if (exp.trim() === got.trim() || exp.replace(/\s+/g, ' ').trim() === got.replace(/\s+/g, ' ').trim()) return { id: 'space' };
    if (exp.normalize && exp.normalize('NFC') === got.normalize('NFC')) return { id: 'unicode' };
    if ((got.indexOf('�') >= 0 || /Ã.|â€/.test(got)) && !(exp.indexOf('�') >= 0 || /Ã.|â€/.test(exp))) return { id: 'mojibake' };
    return { id: 'other' };
  }
  /** A column's patterns summed up in a phrase: "truncated to 24
   *  characters", "shifted by +4 hours". */
  function patternPhrase(pat, rows) {
    var id = pat.id, ns = pat.ns || [];
    var one = ns.length === 1 ? ns[0] : null;
    switch (id) {
      case 'trunc': return one !== null ? 'truncated to ' + plural(one, 'character') : 'cut short (to ' + Math.min.apply(null, ns) + '–' + Math.max.apply(null, ns) + ' characters)';
      case 'rounded': return one !== null ? 'rounded to ' + plural(one, 'decimal place') : 'rounded';
      case 'shift': return one !== null ? 'shifted by ' + signed(one) + ' hour' + (Math.abs(one) === 1 ? '' : 's') : 'shifted by ' + ns.slice(0, 3).map(signed).join(', ') + ' hours';
      case 'dayshift': return one !== null ? 'moved by ' + signed(one) + ' day' + (Math.abs(one) === 1 ? '' : 's') : 'moved by whole days';
      default: return PATTERNS[id].label;
    }
  }

  /** "748 values truncated to 30 characters", "1 null became an empty string". */
  function patternTitle(pt, n) {
    switch (pt.id) {
      case 'null2empty': return plural(n, 'null') + ' became ' + (n === 1 ? 'an empty string' : 'empty strings');
      case 'empty2null': return plural(n, 'empty string') + ' became null';
      case 'lost': return plural(n, 'value') + ' became null';
      case 'filled': return plural(n, 'null') + (n === 1 ? ' now has a value' : ' now have values');
      default: return plural(n, 'value') + ' ' + pt.label;
    }
  }

  /* ---------------- the verdict ---------------- */

  var KIND_ORDER = { missing: 0, extra: 1, dupkey: 2, mismatch: 3, nullkey: 4, notunique: 5 };
  function keyText(arr) { return arr.map(function (v) { return v === null ? 'null' : clean(v, 80); }).join(' · '); }

  /** Everything the page and the reports draw, from the two passes. */
  function diagnose(plan, d, hb, ha, db, da, meta) {
    meta = meta || {};
    var findings = [], E = LIMITS.examples;
    var keyLabel = plan.keyNames.join(' + ');
    function rowsOf(det, kh) { return det.rows.get(kh) || []; }
    if (d.missing.length) {
      findings.push({
        kind: 'missing', rows: d.missing.length,
        title: plural(d.missing.length, 'row is', 'rows are') + ' missing after the migration',
        detail: 'In before, not in after - no row with ' + (d.missing.length === 1 ? 'this ' : 'these ') + keyLabel + '.',
        fix: 'Find where these rows were filtered out or failed to load (a WHERE clause, a rejected-rows log, a failed batch).',
        examples: d.missing.slice(0, E).map(function (kh) { var r = rowsOf(db, kh)[0]; return r ? { key: keyText(r.key), line: r.line, values: r.raw.map(function (v) { return Array.isArray(v) ? joinVals(v, ' ') : v; }) } : null; }).filter(Boolean),
      });
    }
    if (d.extra.length) {
      findings.push({
        kind: 'extra', rows: d.extra.length,
        title: plural(d.extra.length, 'row', 'rows') + (d.extra.length === 1 ? ' appeared that was' : ' appeared that were') + ' not there before',
        detail: 'In after, not in before.',
        fix: 'New rows usually mean a join fanned out, a test load was left behind, or the key was rewritten on the way.',
        examples: d.extra.slice(0, E).map(function (kh) { var r = rowsOf(da, kh)[0]; return r ? { key: keyText(r.key), line: r.line, values: r.raw.map(function (v) { return Array.isArray(v) ? joinVals(v, ' ') : v; }) } : null; }).filter(Boolean),
      });
    }
    if (d.dup.length) {
      var dupRows = 0;
      d.dup.forEach(function (kh) { dupRows += Math.abs(ha.cnt[ha.keys.get(kh)] - hb.cnt[hb.keys.get(kh)]); });
      findings.push({
        kind: 'dupkey', rows: dupRows, keys: d.dup.length,
        title: d.dup.every(function (kh) { return ha.cnt[ha.keys.get(kh)] > hb.cnt[hb.keys.get(kh)]; })
          ? plural(d.dup.length, 'row was', 'rows were') + ' loaded more than once'
          : plural(d.dup.length, 'key appears', 'keys appear') + ' a different number of times',
        detail: 'The same ' + keyLabel + ' is on more rows on one side than the other - usually a row loaded twice.',
        fix: 'Look for a retried batch or a join that fans out. A unique constraint on ' + keyLabel + ' would have refused it.',
        examples: d.dup.slice(0, E).map(function (kh) {
          var b = rowsOf(db, kh), a = rowsOf(da, kh), r = (a[0] || b[0]);
          return { key: r ? keyText(r.key) : '?', before: hb.cnt[hb.keys.get(kh)], after: ha.cnt[ha.keys.get(kh)], lines: a.map(function (x) { return x.line; }) };
        }),
      });
    }
    // Value mismatches, column by column.
    var byCol = {};
    var single = d.mismatch.filter(function (kh) { var s = hb.keys.get(kh); return hb.cnt[s] === 1; });
    var explained = single.slice(0, LIMITS.detailCap);
    explained.forEach(function (kh) {
      var b = rowsOf(db, kh)[0], a = rowsOf(da, kh)[0];
      if (!b || !a) return;
      plan.compare.forEach(function (pi) {
        var e = b.vals[pi], g = a.vals[pi];
        if (e === g) return;
        var p = plan.pairs[pi];
        var col = byCol[pi] || (byCol[pi] = { rows: 0, pats: {}, examples: [] });
        col.rows++;
        var r = recognize(e, g, p.ttype);
        var pt = col.pats[r.id] || (col.pats[r.id] = { id: r.id, rows: 0, ns: [], from: r.from });
        pt.rows++;
        if (r.n !== undefined && pt.ns.indexOf(r.n) < 0 && pt.ns.length < 12) pt.ns.push(r.n);
        if (col.examples.length < E) col.examples.push({ key: keyText(b.key), expected: e, found: g, rawBefore: b.raw[pi], rawAfter: a.raw[pi], pattern: r.id, n: r.n });
      });
    });
    Object.keys(byCol).forEach(function (pi) {
      var col = byCol[pi], p = plan.pairs[pi];
      var pats = Object.keys(col.pats).map(function (k) { return col.pats[k]; }).sort(function (x, y) { return y.rows - x.rows || (x.id < y.id ? -1 : 1); });
      pats.forEach(function (pt) { pt.ns.sort(function (x, y) { return x - y; }); pt.label = patternPhrase(pt, pt.rows); });
      var top = pats[0];
      var all = pats.length === 1;
      var title = p.label + ': ' + (all ? patternTitle(top, col.rows) : plural(col.rows, 'value') + ' differ' + (col.rows === 1 ? 's' : '') + ', mostly ' + top.label);
      var fix = PATTERNS[top.id].fix;
      if (top.id === 'format' && top.from) fix = 'The same date written as ' + top.from + '. Add a "Date reformat" rule from ' + top.from + '.';
      findings.push({
        kind: 'mismatch', column: p.label, pair: +pi, rows: col.rows, pattern: top.id,
        patterns: pats.map(function (pt) { return { id: pt.id, label: pt.label, rows: pt.rows }; }),
        title: title, detail: 'Same ' + keyLabel + ', different ' + p.label + '.', fix: fix,
        examples: col.examples,
        sampled: single.length > explained.length ? explained.length : 0,
      });
    });
    // Mismatches on keys that repeat on both sides: counted, not explained.
    var multiMismatch = d.mismatch.length - single.length;
    if (d.notUnique.length) {
      findings.push({
        kind: 'notunique', info: true, rows: d.notUnique.length,
        title: 'The key is not unique: ' + plural(d.notUnique.length, 'value repeats', 'values repeat') + ' on both sides',
        detail: (multiMismatch ? fmtInt(multiMismatch) + ' of them hold different rows on each side. ' : 'They hold the same rows on both sides. ') + 'Choose a key that is unique to compare these row by row.',
        fix: 'Add a second key column (Map → Key) so every row has its own key.',
        examples: d.notUnique.slice(0, E).map(function (kh) { var r = rowsOf(db, kh)[0]; return { key: r ? keyText(r.key) : '?', before: hb.cnt[hb.keys.get(kh)], after: ha.cnt[ha.keys.get(kh)] }; }),
      });
    }
    findings.sort(function (x, y) { return (x.info ? 1 : 0) - (y.info ? 1 : 0) || y.rows - x.rows || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || String(x.column || '').localeCompare(String(y.column || '')); });

    var aggregates = aggregateChecks(plan, hb.aggs, ha.aggs);
    var like = aggregateChecks(plan, db.aggs, da.aggs);
    var problems = findings.filter(function (f) { return !f.info; }).length;
    var rowsB = hb.rows, rowsA = ha.rows;
    var differ = d.missing.length + d.extra.length + d.dup.length + d.mismatch.length;
    return {
      parity: 'result', v: 1,
      at: meta.at || new Date().toISOString(),
      files: meta.files || null,
      rows: { before: rowsB, after: rowsA, keysBefore: hb.size, keysAfter: ha.size, nullKeysBefore: hb.nullKeys, nullKeysAfter: ha.nullKeys },
      key: plan.keyNames.slice(),
      recipe: plan.recipe,
      pairs: plan.pairs.map(function (p) { return { from: p.fromNames, to: p.toNames, rules: p.rules.map(ruleText), type: p.ttype, format: p.tfmt, ignored: p.ignore, key: plan.keyPairs.indexOf(p.n) >= 0 }; }),
      findings: findings,
      problems: problems,
      ok: problems === 0,
      differingKeys: differ,
      headline: problems ? plural(problems, 'problem') + ' in ' + plural(rowsB, 'row') : 'Matches ✓',
      sub: problems
        ? fmtInt(differ) + ' of ' + plural(Math.max(hb.size, ha.size), 'key') + ' differ' + (differ === 1 ? 's' : '') + '. Before ' + plural(rowsB, 'row') + ', after ' + plural(rowsA, 'row') + '.'
        : 'Every one of ' + plural(rowsB, 'row') + ' is in the after table, once, with the values your recipe says it should have.',
      aggregates: aggregates,
      likeForLike: like,
      sampled: single.length > explained.length,
    };
  }

  var METRICS = [
    ['count', 'Values (not null)'], ['nulls', 'Nulls'], ['empties', 'Empty strings'], ['distinct', 'Distinct values'],
    ['sum', 'Sum'], ['min', 'Minimum'], ['max', 'Maximum'], ['maxLen', 'Longest (characters)'],
  ];
  var VALUE_METRICS = { sum: 1, min: 1, max: 1 };
  /** Side-by-side aggregates per compared column, each ✓ or ✗. */
  function aggregateChecks(plan, bAggs, aAggs, names) {
    var out = [];
    plan.pairs.forEach(function (p, i) {
      if (p.ignore) return;
      var b = bAggs[i], a = aAggs[i];
      if (!b || !a) return;
      var rows = [];
      METRICS.forEach(function (m) {
        var id = m[0];
        if (id === 'sum' && !NUMERIC[p.ttype]) return;
        if ((id === 'min' || id === 'max') && !(NUMERIC[p.ttype] || DATEISH[p.ttype])) return;
        if (id === 'maxLen' && (NUMERIC[p.ttype] || DATEISH[p.ttype] || p.ttype === 'bool')) return;
        var bv = b[id], av = a[id];
        if (bv === undefined && av === undefined) return;
        var ok;
        if (id === 'distinct' && (b.distinctApprox || a.distinctApprox)) ok = Math.abs(bv - av) <= Math.max(2, 0.02 * Math.max(bv, av));
        else ok = bv === av;
        rows.push({ metric: id, label: m[1], before: bv === undefined ? null : bv, after: av === undefined ? null : av, ok: ok, approx: id === 'distinct' && (b.distinctApprox || a.distinctApprox), value: Boolean(VALUE_METRICS[id]) });
      });
      out.push({ column: p.label, type: p.ttype, key: plan.keyPairs.indexOf(i) >= 0, checks: rows, ok: rows.every(function (r) { return r.ok; }) });
    });
    return out;
  }

  /** The whole comparison over rows already in memory (the tests, and the
   *  worker for files that fit). Two passes over each side, as in a stream. */
  function compareRows(bRows, aRows, plan, meta) {
    var hb = createHasher(plan, 'before'), ha = createHasher(plan, 'after'), i;
    for (i = 0; i < bRows.length; i++) hb.add(bRows[i]);
    for (i = 0; i < aRows.length; i++) ha.add(aRows[i]);
    var B = hb.finish(), A = ha.finish();
    var d = diffHashers(B, A), w = wantedKeys(d);
    var db = createDetail(plan, 'before', w, d.common), da = createDetail(plan, 'after', w, d.common);
    for (i = 0; i < bRows.length; i++) db.add(bRows[i]);
    for (i = 0; i < aRows.length; i++) da.add(aRows[i]);
    return diagnose(plan, d, B, A, db.finish(), da.finish(), meta);
  }

  /* ---------------- learning rules from rows that share a key ---------------- */

  /** Which rules make a pair agree, learned from rows joined by key. A rule
   *  is kept only if it fixes at least five rows, at least half of the pair's
   *  disagreements, and breaks none - so a defect on a few rows (a value
   *  truncated, one null turned empty, a batch shifted by hours) is never
   *  learned away: it stays a finding. joined: [[beforeRow, afterRow], ...]. */
  function learnRules(recipe, beforeCols, afterCols, joined) {
    var bBy = {}, aBy = {};
    beforeCols.forEach(function (c) { bBy[c.name] = c; });
    afterCols.forEach(function (c) { aBy[c.name] = c; });
    var learned = [];
    recipe.pairs.forEach(function (pair, n) {
      if ((recipe.key || []).some(function (k) { return pair.to.indexOf(k) >= 0; })) return;
      var rules = sortRules(pair.rules);
      var single = { pairs: [{ from: pair.from, to: pair.to, sep: pair.sep, rules: rules }], key: [] };
      function score(rs) {
        single.pairs[0].rules = rs;
        var plan = compilePlan(single, beforeCols, afterCols), p = plan.pairs[0];
        var ok = 0, res = new Array(joined.length);
        for (var i = 0; i < joined.length; i++) { var m = normBefore(p, joined[i][0]) === normAfter(p, joined[i][1]); res[i] = m; if (m) ok++; }
        return { ok: ok, res: res };
      }
      var base = score(rules);
      if (base.ok === joined.length) return;
      var bc = bBy[pair.from[0]] || {}, ac = pair.to.length === 1 ? (aBy[pair.to[0]] || {}) : {};
      var cands = [];
      if (pair.from.length === 1 && pair.to.length === 1) {
        if (bc.padded) cands.push({ rule: 'trim' });
        if (DATEISH[ac.type] && bc.format && ac.format && bc.format !== ac.format) cands.push({ rule: 'date', from: bc.format, to: ac.format });
        if (DATEISH[ac.type] && bc.type === 'text') {
          // A before column that did not read as dates: try the formats on the joined values.
          for (var f = 0; f < DATE_FORMATS.length; f++) {
            var fm = DATE_FORMATS[f], hits = 0, tried = 0;
            for (var j = 0; j < joined.length && tried < 50; j++) { var v = joined[j][0][beforeCols.indexOf(bc)]; if (v) { tried++; if (parseDate(v, fm)) hits++; } }
            if (tried && hits === tried && ac.format && fm !== ac.format) { cands.push({ rule: 'date', from: fm, to: ac.format }); break; }
          }
        }
        if (NUMERIC[ac.type] && NUMERIC[bc.type]) { cands.push({ rule: 'scale', op: 'div100' }); cands.push({ rule: 'scale', op: 'mul100' }); }
        if (bc.upper && ac.type === 'text') cands.push({ rule: 'fold' });
        // A value map for code columns: a few distinct values each side.
        if (bc.distinct && bc.distinct <= 40 && ac.distinct && ac.distinct <= 40 && !NUMERIC[ac.type]) {
          var bi = beforeCols.indexOf(bc), ai = afterCols.indexOf(ac), votes = {};
          joined.forEach(function (jr) { var x = jr[0][bi], y = jr[1][ai]; if (x === null || y === null || x === y) return; var m = votes[x] || (votes[x] = {}); m[y] = (m[y] || 0) + 1; });
          var table = Object.keys(votes).sort().map(function (x) { var best = null, bn = 0; Object.keys(votes[x]).sort().forEach(function (y) { if (votes[x][y] > bn) { bn = votes[x][y]; best = y; } }); return [x, best]; });
          if (table.length) cands.push({ rule: 'map', table: table });
        }
      } else if (bBy[pair.from[0]] && bBy[pair.from[0]].padded) cands.push({ rule: 'trim' });
      var cur = rules.slice(), curScore = base, why = [];
      cands.forEach(function (c) {
        if (cur.some(function (r) { return r.rule === c.rule; })) return;
        var next = sortRules(cur.concat([c]));
        var s = score(next);
        var fixed = 0, broke = 0;
        for (var i = 0; i < joined.length; i++) { if (s.res[i] && !curScore.res[i]) fixed++; if (!s.res[i] && curScore.res[i]) broke++; }
        var wrong = joined.length - curScore.ok;
        if (fixed >= 5 && broke === 0 && fixed * 2 >= wrong) { cur = next; curScore = s; why.push(cleanRule(c)); }
      });
      if (why.length) learned.push({ pair: n, rules: why, before: base.ok, after: curScore.ok, of: joined.length });
    });
    return learned;
  }

  /** The key hash of a row on one side (the rows chosen for learning are the
   *  ones whose key hash falls in the same slice on both sides, so the two
   *  samples meet). */
  function keyHashOf(plan, side, row) {
    var norm = side === 'before' ? normBefore : normAfter, ks = '';
    for (var k = 0; k < plan.keyPairs.length; k++) { var kv = norm(plan.pairs[plan.keyPairs[k]], row); ks += (k ? '\u001f' : '') + (kv === null ? '\u0000' : kv); }
    return h53(ks, 1);
  }
  function learnStride(rows) { return Math.max(1, Math.floor(rows / LIMITS.learnRows)); }
  /** Rows that share a key, for learnRules: [[before, after], ...]. */
  function sampleJoin(plan, bRows, aRows) {
    var m = learnStride(Math.max(bRows.length, aRows.length)), byKey = new Map(), out = [];
    aRows.forEach(function (r) { var kh = keyHashOf(plan, 'after', r); if (kh % m === 0 && !byKey.has(kh)) byKey.set(kh, r); });
    bRows.forEach(function (r) { if (out.length >= LIMITS.learnRows) return; var kh = keyHashOf(plan, 'before', r); if (kh % m !== 0) return; var a = byKey.get(kh); if (a) { out.push([r, a]); byKey.delete(kh); } });
    return out;
  }

  /* ---------------- fingerprints ---------------- */

  function k53Bytes(kh) { var hi = Math.floor(kh / 4294967296), lo = kh >>> 0; return [lo & 255, (lo >>> 8) & 255, (lo >>> 16) & 255, lo >>> 24, hi & 255, (hi >>> 8) & 255, (hi >>> 16) & 255, (hi >>> 24) & 255]; }
  function bucketOf(key, kh) { return sipHash(key, k53Bytes(kh))[1] & (LIMITS.buckets - 1); }
  function keyedKeyHex(key, kh) { var b = k53Bytes(kh); b.push(0x6b); var h = sipHash(key, b); return hex32(h[0]) + hex32(h[1]); }
  function checkOf(key) { var h = sipHash(key, utf8Bytes('parity passphrase check')); return hex32(h[0]).slice(0, 4) + hex32(h[1]).slice(0, 4); }
  /** The recipe in a canonical form, hashed: two fingerprints made with
   *  different recipes would disagree for reasons that are not the data. */
  function recipeId(recipe) {
    var r = { pairs: (recipe.pairs || []).map(function (p) { return { from: p.from, to: p.to, sep: p.sep || ' ', rules: sortRules(p.rules) }; }), key: recipe.key || [] };
    return textHash(JSON.stringify(r)).slice(0, 12);
  }
  /** A fingerprint from one side's hash pass. It holds counts and keyed
   *  hashes - no value from the data. Sums, minimums and maximums ARE values,
   *  so they are left out unless includeValues. */
  function fingerprintFrom(h, plan, side, key, opts) {
    opts = opts || {};
    var B = LIMITS.buckets;
    var cnt = new Uint32Array(B), lo = new Uint32Array(B), hi = new Uint32Array(B), lo2 = new Uint32Array(B), hi2 = new Uint32Array(B);
    h.keys.forEach(function (slot, kh) {
      var b = bucketOf(key, kh);
      cnt[b] += h.cnt[slot];
      // Mix the key into the row hash, so a changed key is seen too.
      var a = (h.lo[slot] ^ Math.imul(h.klo[slot], 0x9e3779b1)) >>> 0, c = (h.hi[slot] ^ Math.imul(h.khi[slot] + h.cnt[slot], 0x85ebca77)) >>> 0;
      lo[b] = (lo[b] + a) >>> 0; hi[b] = (hi[b] + c) >>> 0;
      lo2[b] = (lo2[b] ^ Math.imul(a, 0xcc9e2d51)) >>> 0; hi2[b] = (hi2[b] ^ Math.imul(c, 0x1b873593)) >>> 0;
    });
    var buckets = new Array(B);
    for (var b = 0; b < B; b++) {
      if (!cnt[b]) { buckets[b] = ''; continue; }
      var s = sipHash(key, wordsBytes([b, cnt[b], lo[b], hi[b], lo2[b], hi2[b]]));
      buckets[b] = cnt[b] + ':' + hex32(s[0]).slice(0, 4) + hex32(s[1]);
    }
    var target = plan.pairs.map(function (p) { return { name: p.label, type: p.ttype }; });
    return {
      parity: 'fingerprint', v: 1, side: side, made: opts.at || new Date().toISOString(),
      rows: h.rows, keys: h.size, bucketCount: B,
      recipe: recipeId(plan.recipe), check: checkOf(key),
      key: plan.keyNames.slice(), includesValues: Boolean(opts.includeValues),
      columns: target,
      aggregates: plan.pairs.map(function (p, i) {
        if (p.ignore) return null;
        var a = h.aggs[i], o = { column: p.label, type: p.ttype, count: a.count, nulls: a.nulls, empties: a.empties, distinct: a.distinct, distinctApprox: a.distinctApprox };
        if (!NUMERIC[p.ttype] && !DATEISH[p.ttype] && p.ttype !== 'bool') o.maxLen = a.maxLen;
        if (opts.includeValues) { if (NUMERIC[p.ttype]) o.sum = a.sum; if (NUMERIC[p.ttype] || DATEISH[p.ttype]) { o.min = a.min; o.max = a.max; } }
        return o;
      }).filter(Boolean),
      buckets: buckets,
    };
  }
  var HEXB = /^\d{1,10}:[0-9a-f]{12}$/;
  /** A fingerprint from a file, checked field by field. */
  function cleanFingerprint(f) {
    if (!f || f.parity !== 'fingerprint' || f.v !== 1 || ['before', 'after'].indexOf(f.side) < 0) return null;
    if (!Array.isArray(f.buckets) || f.buckets.length !== LIMITS.buckets) return null;
    if (!f.buckets.every(function (b) { return b === '' || (typeof b === 'string' && HEXB.test(b)); })) return null;
    var n = function (v) { var x = Number(v); return Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0; };
    var s = function (v, m) { return typeof v === 'string' ? clean(v, m || 80) : ''; };
    return {
      parity: 'fingerprint', v: 1, side: f.side, made: s(f.made, 40), rows: n(f.rows), keys: n(f.keys), bucketCount: LIMITS.buckets,
      recipe: /^[0-9a-f]{12}$/.test(f.recipe) ? f.recipe : '', check: /^[0-9a-f]{12}$/.test(f.check) ? f.check : '',
      key: (Array.isArray(f.key) ? f.key : []).slice(0, 4).map(function (k) { return s(k, LIMITS.maxNameLen); }),
      includesValues: f.includesValues === true,
      columns: cleanShape(f.columns),
      aggregates: (Array.isArray(f.aggregates) ? f.aggregates : []).slice(0, LIMITS.maxColumns).map(function (a) {
        if (!a || typeof a.column !== 'string') return null;
        var o = { column: s(a.column, LIMITS.maxNameLen), type: TYPES.indexOf(a.type) >= 0 ? a.type : 'text', count: n(a.count), nulls: n(a.nulls), empties: n(a.empties), distinct: n(a.distinct), distinctApprox: a.distinctApprox === true };
        if (a.maxLen !== undefined) o.maxLen = n(a.maxLen);
        ['sum', 'min', 'max'].forEach(function (k) { if (typeof a[k] === 'string') o[k] = s(a[k], 60); });
        return o;
      }).filter(Boolean),
      buckets: f.buckets.slice(),
    };
  }
  /** Two fingerprints compared: rows, aggregates and buckets. */
  function compareFingerprints(x, y) {
    var b = x.side === 'before' ? x : y, a = x.side === 'before' ? y : x;
    var warnings = [];
    if (b.side === a.side) warnings.push('Both fingerprints are of the ' + b.side + ' side. Make one on each side.');
    if (b.check && a.check && b.check !== a.check) return { error: 'These two were made with different passphrases, so nothing in them can be compared. Make both with the same passphrase.' };
    if (b.recipe && a.recipe && b.recipe !== a.recipe) warnings.push('They were made with different recipes (mappings or rules). Differences may come from that, not the data.');
    var differ = [], same = 0, empty = 0;
    for (var i = 0; i < LIMITS.buckets; i++) {
      var p = b.buckets[i], q = a.buckets[i];
      if (p === q) { if (p) same++; else empty++; continue; }
      differ.push({ bucket: i, before: p ? +p.split(':')[0] : 0, after: q ? +q.split(':')[0] : 0 });
    }
    var aggs = [];
    b.aggregates.forEach(function (ba) {
      var aa = a.aggregates.filter(function (z) { return z.column === ba.column; })[0];
      if (!aa) return;
      var rows = [];
      METRICS.forEach(function (m) {
        var id = m[0];
        if (ba[id] === undefined && aa[id] === undefined) return;
        var bv = ba[id] === undefined ? null : ba[id], av = aa[id] === undefined ? null : aa[id];
        var approx = id === 'distinct' && (ba.distinctApprox || aa.distinctApprox);
        var ok = approx ? Math.abs(bv - av) <= Math.max(2, 0.02 * Math.max(bv, av)) : bv === av;
        rows.push({ metric: id, label: m[1], before: bv, after: av, ok: ok, approx: approx, value: Boolean(VALUE_METRICS[id]) });
      });
      aggs.push({ column: ba.column, type: ba.type, checks: rows, ok: rows.every(function (r) { return r.ok; }) });
    });
    var rowDiff = differ.reduce(function (s, d) { return s + Math.max(d.before, d.after); }, 0);
    var ok = !differ.length && b.rows === a.rows;
    return {
      ok: ok, warnings: warnings,
      rows: { before: b.rows, after: a.rows },
      buckets: { total: LIMITS.buckets, same: same, empty: empty, differ: differ },
      aggregates: aggs,
      headline: ok ? 'Matches ✓' : plural(differ.length, 'bucket differs', 'buckets differ'),
      sub: ok ? 'Every one of ' + fmtInt(LIMITS.buckets) + ' buckets agrees: same rows, same values, ' + plural(b.rows, 'row') + ' on each side.'
        : 'The differences are inside ' + plural(differ.length, 'bucket') + ' holding at most ' + plural(rowDiff, 'row') + ' - run Find rows on both sides for just those.',
    };
  }
  /** The rows of some buckets, as keyed hashes: each side makes one, and the
   *  two lists say exactly which keys differ - still without a value, unless
   *  the person chose to include the key values. */
  function rowListFrom(h, plan, side, key, buckets, opts) {
    opts = opts || {};
    var want = {}; buckets.forEach(function (b) { want[b] = 1; });
    var rows = [];
    h.keys.forEach(function (slot, kh) {
      if (!want[bucketOf(key, kh)]) return;
      if (rows.length >= LIMITS.rowListMax) return;
      var s = sipHash(key, wordsBytes([h.lo[slot], h.hi[slot], h.cnt[slot], 0x726f77]));
      var r = { k: keyedKeyHex(key, kh), h: hex32(s[0]).slice(0, 4) + hex32(s[1]), n: h.cnt[slot] };
      if (opts.keys && opts.keys.has(kh)) r.key = opts.keys.get(kh);
      rows.push(r);
    });
    rows.sort(function (x, y) { return x.k < y.k ? -1 : x.k > y.k ? 1 : 0; });
    return { parity: 'rows', v: 1, side: side, made: opts.at || new Date().toISOString(), recipe: recipeId(plan.recipe), check: checkOf(key), key: plan.keyNames.slice(), buckets: buckets.slice().sort(function (x, y) { return x - y; }), includesKeys: Boolean(opts.keys), rows: rows };
  }
  function cleanRowList(f) {
    if (!f || f.parity !== 'rows' || f.v !== 1 || ['before', 'after'].indexOf(f.side) < 0 || !Array.isArray(f.rows)) return null;
    return {
      parity: 'rows', v: 1, side: f.side, recipe: /^[0-9a-f]{12}$/.test(f.recipe) ? f.recipe : '', check: /^[0-9a-f]{12}$/.test(f.check) ? f.check : '',
      key: (Array.isArray(f.key) ? f.key : []).slice(0, 4).map(function (k) { return clean(k, LIMITS.maxNameLen); }),
      buckets: (Array.isArray(f.buckets) ? f.buckets : []).filter(function (b) { return Number.isInteger(b) && b >= 0 && b < LIMITS.buckets; }).slice(0, LIMITS.buckets),
      includesKeys: f.includesKeys === true,
      rows: f.rows.slice(0, LIMITS.rowListMax).map(function (r) {
        if (!r || !/^[0-9a-f]{16}$/.test(r.k) || !/^[0-9a-f]{12}$/.test(r.h)) return null;
        var o = { k: r.k, h: r.h, n: Number.isInteger(r.n) && r.n > 0 ? r.n : 1 };
        if (typeof r.key === 'string') o.key = clean(r.key, 200);
        return o;
      }).filter(Boolean),
    };
  }
  /** Two row lists: which keys are missing, extra, repeated or different. */
  function compareRowLists(x, y) {
    var b = x.side === 'before' ? x : y, a = x.side === 'before' ? y : x;
    if (b.check && a.check && b.check !== a.check) return { error: 'These lists were made with different passphrases.' };
    var am = {}; a.rows.forEach(function (r) { am[r.k] = r; });
    var bm = {}; b.rows.forEach(function (r) { bm[r.k] = r; });
    var out = [];
    b.rows.forEach(function (r) {
      var q = am[r.k];
      if (!q) out.push({ k: r.k, status: 'missing', label: 'missing after', before: r.n, after: 0, key: r.key || null });
      else if (q.n !== r.n) out.push({ k: r.k, status: 'dupkey', label: 'repeated', before: r.n, after: q.n, key: r.key || q.key || null });
      else if (q.h !== r.h) out.push({ k: r.k, status: 'differs', label: 'values differ', before: r.n, after: q.n, key: r.key || q.key || null });
    });
    a.rows.forEach(function (r) { if (!bm[r.k]) out.push({ k: r.k, status: 'extra', label: 'not there before', before: 0, after: r.n, key: r.key || null }); });
    var order = { missing: 0, extra: 1, dupkey: 2, differs: 3 };
    out.sort(function (p, q) { return order[p.status] - order[q.status] || (p.k < q.k ? -1 : 1); });
    var sameBuckets = b.buckets.join(',') === a.buckets.join(',');
    return { differ: out, checked: Math.max(b.rows.length, a.rows.length), warnings: sameBuckets ? [] : ['The two lists cover different buckets.'] };
  }

  /* ---------------- exports ---------------- */

  /** A CSV cell: quoted when needed; a cell a spreadsheet would run as a
   *  formula (= + - @, tab, CR) gets a leading apostrophe - except a plain
   *  number such as -1240.50, which stays a number. */
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).replace(CTRL, '');
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csv(rows) { return '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n'; }
  function examplesCsv(res) {
    var rows = [['finding', 'column', 'key', 'expected (before, with rules)', 'found (after)', 'before as written', 'after as written', 'pattern']];
    res.findings.forEach(function (f) {
      (f.examples || []).forEach(function (e) {
        if (f.kind === 'mismatch') rows.push([f.kind, f.column, e.key, e.expected, e.found, Array.isArray(e.rawBefore) ? e.rawBefore.join(' ') : e.rawBefore, Array.isArray(e.rawAfter) ? e.rawAfter.join(' ') : e.rawAfter, PATTERNS[e.pattern] ? PATTERNS[e.pattern].label : '']);
        else if (f.kind === 'dupkey' || f.kind === 'notunique') rows.push([f.kind, '', e.key, 'rows before: ' + e.before, 'rows after: ' + e.after, '', '', '']);
        else rows.push([f.kind, '', e.key, f.kind === 'missing' ? 'present' : 'absent', f.kind === 'missing' ? 'absent' : 'present', '', '', '']);
      });
    });
    return csv(rows);
  }
  /** The report as data. summaryOnly drops every example (keys and values)
   *  and the value aggregates (sum, min, max), keeping counts. */
  function toJson(res, opts) {
    opts = opts || {};
    var o = JSON.parse(JSON.stringify(res));
    o.summaryOnly = Boolean(opts.summaryOnly);
    if (opts.summaryOnly) {
      o.findings.forEach(function (f) { delete f.examples; });
      [o.aggregates, o.likeForLike].forEach(function (list) { (list || []).forEach(function (c) { c.checks = c.checks.filter(function (r) { return !r.value; }); }); });
      if (o.recipe) o.recipe.pairs.forEach(function (p) { p.rules = p.rules.map(function (r) { return r.rule === 'map' ? { rule: 'map', entries: r.table.length } : r; }); });
    }
    return o;
  }
  /** Prose in Markdown: Markdown's own characters escaped, and < > written as
   *  entities so a value can never become markup or a link. */
  function mdText(v) { return clean(v, 300).replace(/\\/g, '\\\\').replace(/([|*_`[\]#~])/g, '\\$1').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, ' '); }
  function mdCode(v) {
    var s = v === null || v === undefined ? 'null' : clean(String(v), 200).replace(/\r?\n/g, ' ');
    if (s === '') return '`""`';
    var ticks = '`'; while (s.indexOf(ticks) >= 0) ticks += '`';
    return ticks + ' ' + s.replace(/\|/g, '¦') + ' ' + ticks;
  }
  function aggVal(r) { return r.before === null && r.after === null ? '' : r; }
  /** "2026-10-09 07:50 UTC" from an ISO time (the JSON keeps the ISO). */
  function whenText(iso) { return /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(iso || '') ? iso.slice(0, 10) + ' ' + iso.slice(11, 16) + ' UTC' : clean(iso, 40); }
  function fmtMetric(v) { return v === null || v === undefined ? '-' : typeof v === 'number' ? fmtInt(v) : String(v); }
  function toMarkdown(res, opts) {
    opts = opts || {};
    var r = toJson(res, opts), L = [];
    L.push('# Parity sign-off: ' + (r.ok ? 'Matches' : r.headline));
    L.push('');
    L.push('_' + mdText(r.sub) + '_');
    L.push('');
    L.push('- Compared: ' + mdText(whenText(r.at)));
    if (r.files) L.push('- Files: ' + ['before', 'after'].map(function (s) { var f = r.files[s]; return f ? s + ' ' + mdCode(f.name) + ' (' + fmtBytes(f.size) + ', ' + plural(f.rows, 'row') + ')' : ''; }).filter(Boolean).join('; '));
    L.push('- Key: ' + r.key.map(mdCode).join(' + '));
    L.push('- Rows: before ' + fmtInt(r.rows.before) + ', after ' + fmtInt(r.rows.after));
    if (r.summaryOnly) L.push('- Summary only: examples, key values, sums, minimums and maximums are left out.');
    L.push('- Read on the device by Parity; no data was uploaded.');
    L.push('');
    L.push('## Mapping and rules');
    L.push('');
    L.push('| Before | After | Rules |');
    L.push('|---|---|---|');
    r.pairs.forEach(function (p) { L.push('| ' + p.from.map(mdCode).join(' + ') + ' | ' + p.to.map(mdCode).join(' + ') + (p.key ? ' (key)' : '') + ' | ' + (p.ignored ? 'ignored' : p.rules.length ? p.rules.map(mdText).join(', ') : '-') + ' |'); });
    L.push('');
    L.push('## Findings');
    L.push('');
    if (!r.findings.length) L.push('None. Every row matches.');
    r.findings.forEach(function (f, i) {
      L.push('### ' + (i + 1) + '. ' + mdText(f.title) + (f.info ? ' (note)' : ''));
      L.push('');
      L.push(mdText(f.detail) + ' ' + mdText(f.fix));
      if (f.patterns && f.patterns.length > 1) L.push('', f.patterns.map(function (p) { return '- ' + mdText(p.label) + ': ' + fmtInt(p.rows); }).join('\n'));
      if (f.examples && f.examples.length) {
        L.push('');
        if (f.kind === 'mismatch') { L.push('| Key | Expected | Found | Pattern |'); L.push('|---|---|---|---|'); f.examples.forEach(function (e) { L.push('| ' + mdCode(e.key) + ' | ' + mdCode(e.expected) + ' | ' + mdCode(e.found) + ' | ' + mdText(PATTERNS[e.pattern].label) + ' |'); }); }
        else if (f.kind === 'dupkey' || f.kind === 'notunique') { L.push('| Key | Rows before | Rows after |'); L.push('|---|---|---|'); f.examples.forEach(function (e) { L.push('| ' + mdCode(e.key) + ' | ' + e.before + ' | ' + e.after + ' |'); }); }
        else { L.push('Keys: ' + f.examples.map(function (e) { return mdCode(e.key); }).join(', ') + (f.rows > f.examples.length ? ' and ' + fmtInt(f.rows - f.examples.length) + ' more' : '')); }
      }
      L.push('');
    });
    L.push('## Aggregates (rows on both sides)');
    L.push('');
    L.push('| Column | Check | Before | After | |');
    L.push('|---|---|---|---|---|');
    (r.likeForLike || []).forEach(function (c) { c.checks.forEach(function (x) { L.push('| ' + mdCode(c.column) + ' | ' + x.label + ' | ' + mdCode(fmtMetric(x.before)) + ' | ' + mdCode(fmtMetric(x.after)) + ' | ' + (x.ok ? '✓' : '✗') + ' |'); }); });
    L.push('');
    L.push('Made with Parity - https://challenge.strongtechnicalconsulting.com/parity/');
    return L.join('\n') + '\n';
  }
  /** A self-contained HTML report: inline styles, no script, no external
   *  asset, a CSP that forbids both, every string escaped. */
  function toHtml(res, opts) {
    opts = opts || {};
    var r = toJson(res, opts), e = esc;
    var cell = function (v) { return '<code>' + e(v === null || v === undefined ? 'null' : v === '' ? '""' : clean(v, 200)) + '</code>'; };
    var h = [];
    h.push('<!doctype html><html lang="en"><head><meta charset="utf-8">');
    h.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">');
    h.push('<meta name="viewport" content="width=device-width, initial-scale=1"><title>Parity sign-off: ' + e(r.ok ? 'Matches' : r.headline) + '</title>');
    h.push('<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#17202a;background:#fff;margin:0;padding:24px;max-width:980px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px;border-bottom:1px solid #d5dbe1;padding-bottom:4px}h3{font-size:15px;margin:18px 0 4px}.v{display:inline-block;padding:6px 12px;border-radius:8px;font-weight:700;color:#fff;background:' + (r.ok ? '#17663a' : '#a3281c') + '}table{border-collapse:collapse;width:100%;margin:6px 0;font-size:13px}th,td{border-bottom:1px solid #e3e7eb;padding:5px 8px;text-align:left;vertical-align:top}th{color:#46525e}code{font:12px ui-monospace,Menlo,Consolas,monospace;background:#f2f4f6;padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}.muted{color:#46525e}.bad{color:#a3281c;font-weight:700}.good{color:#17663a;font-weight:700}.wrap{overflow-x:auto}@media print{body{padding:0}}</style></head><body>');
    h.push('<p class="muted">Parity sign-off report</p><h1><span class="v">' + e(r.ok ? 'Matches ✓' : r.headline) + '</span></h1><p>' + e(r.sub) + '</p>');
    h.push('<table><tr><th>Compared</th><td>' + e(whenText(r.at)) + '</td></tr>');
    if (r.files) ['before', 'after'].forEach(function (s) { var f = r.files[s]; if (f) h.push('<tr><th>' + e(s[0].toUpperCase() + s.slice(1)) + '</th><td>' + cell(f.name) + ' · ' + e(fmtBytes(f.size)) + ' · ' + e(plural(f.rows, 'row')) + '</td></tr>'); });
    h.push('<tr><th>Key</th><td>' + r.key.map(cell).join(' + ') + '</td></tr><tr><th>Rows</th><td>before ' + e(fmtInt(r.rows.before)) + ', after ' + e(fmtInt(r.rows.after)) + '</td></tr>');
    if (r.summaryOnly) h.push('<tr><th>Summary only</th><td>Examples, key values, sums, minimums and maximums are left out.</td></tr>');
    h.push('<tr><th>Where</th><td>Read on the device by Parity. No data was uploaded.</td></tr></table>');
    h.push('<h2>Mapping and rules</h2><div class="wrap"><table><tr><th>Before</th><th>After</th><th>Rules</th></tr>');
    r.pairs.forEach(function (p) { h.push('<tr><td>' + p.from.map(cell).join(' + ') + '</td><td>' + p.to.map(cell).join(' + ') + (p.key ? ' <b>key</b>' : '') + '</td><td>' + (p.ignored ? 'ignored' : p.rules.length ? e(p.rules.join(', ')) : '-') + '</td></tr>'); });
    h.push('</table></div><h2>Findings</h2>');
    if (!r.findings.length) h.push('<p class="good">None. Every row matches.</p>');
    r.findings.forEach(function (f, i) {
      h.push('<h3>' + (i + 1) + '. ' + e(f.title) + (f.info ? ' <span class="muted">(note)</span>' : '') + '</h3><p>' + e(f.detail) + ' ' + e(f.fix) + '</p>');
      if (f.patterns && f.patterns.length > 1) h.push('<ul>' + f.patterns.map(function (p) { return '<li>' + e(p.label) + ': ' + e(fmtInt(p.rows)) + '</li>'; }).join('') + '</ul>');
      if (f.examples && f.examples.length) {
        if (f.kind === 'mismatch') h.push('<div class="wrap"><table><tr><th>Key</th><th>Expected</th><th>Found</th><th>Pattern</th></tr>' + f.examples.map(function (x) { return '<tr><td>' + cell(x.key) + '</td><td>' + cell(x.expected) + '</td><td>' + cell(x.found) + '</td><td>' + e(PATTERNS[x.pattern].label) + '</td></tr>'; }).join('') + '</table></div>');
        else if (f.kind === 'dupkey' || f.kind === 'notunique') h.push('<div class="wrap"><table><tr><th>Key</th><th>Rows before</th><th>Rows after</th></tr>' + f.examples.map(function (x) { return '<tr><td>' + cell(x.key) + '</td><td>' + e(x.before) + '</td><td>' + e(x.after) + '</td></tr>'; }).join('') + '</table></div>');
        else h.push('<p>Keys: ' + f.examples.map(function (x) { return cell(x.key); }).join(', ') + (f.rows > f.examples.length ? ' and ' + e(fmtInt(f.rows - f.examples.length)) + ' more' : '') + '</p>');
      }
    });
    h.push('<h2>Aggregates (rows on both sides)</h2><div class="wrap"><table><tr><th>Column</th><th>Check</th><th>Before</th><th>After</th><th></th></tr>');
    (r.likeForLike || []).forEach(function (c) { c.checks.forEach(function (x) { h.push('<tr><td>' + cell(c.column) + '</td><td>' + e(x.label) + '</td><td>' + cell(fmtMetric(x.before)) + '</td><td>' + cell(fmtMetric(x.after)) + '</td><td class="' + (x.ok ? 'good">✓' : 'bad">✗') + '</td></tr>'); }); });
    h.push('</table></div><p class="muted">Made with Parity, in the browser.</p></body></html>');
    return h.join('\n');
  }
  /** The mapping and rules as a reusable file - and nothing from the data
   *  but column names, types, and a value map's entries. */
  function toRecipe(recipe, afterCols) {
    var r = cleanRecipe(recipe, recipe.pairs.reduce(function (a, p) { return a.concat(p.from); }, []), recipe.pairs.reduce(function (a, p) { return a.concat(p.to); }, [])).recipe;
    r.target = cleanShape(afterCols || recipe.target || []);
    return r;
  }

  /* ---------------- the one model call ---------------- */

  /** What "Suggest the mapping and rules" sends: column names, inferred
   *  types and formats, and counts. Never a value. */
  function modelSummary(before, after) {
    function side(s) {
      return { rows: s.rows || 0, columns: s.columns.slice(0, 300).map(function (c) { var o = { name: clean(c.name, LIMITS.maxNameLen), type: c.type }; if (c.format) o.format = c.format; if (c.nulls !== undefined) { o.nulls = c.nulls; o.empties = c.empties; o.distinct = c.distinct; } return o; }) };
    }
    return { before: side(before), after: side(after) };
  }
  /** The model's proposal, checked against the real names and the fixed rule
   *  list. Anything else is dropped (and counted). */
  function cleanProposal(raw, beforeNames, afterNames) {
    if (!raw || typeof raw !== 'object') return null;
    var r = cleanRecipe({ pairs: Array.isArray(raw.pairs) ? raw.pairs : [], key: raw.key }, beforeNames, afterNames);
    var whys = (Array.isArray(raw.pairs) ? raw.pairs : []);
    var pairs = r.recipe.pairs.map(function (p) {
      var src = whys.filter(function (w) { return w && Array.isArray(w.from) && w.from.join('\u0001') === p.from.join('\u0001'); })[0];
      p.why = src && typeof src.why === 'string' ? clean(src.why, 200).replace(/[<>]/g, '') : '';
      return p;
    });
    if (!pairs.length) return null;
    return { pairs: pairs, key: r.recipe.key, dropped: r.dropped };
  }

  return {
    LIMITS: LIMITS, TYPES: TYPES, TYPE_LABEL: TYPE_LABEL, DATE_FORMATS: DATE_FORMATS, RULES: RULES, RULE_IDS: RULE_IDS, PATTERNS: PATTERNS, METRICS: METRICS, KDF: KDF, NULL_TOKENS: NULL_TOKENS,
    clean: clean, esc: esc, fmtInt: fmtInt, plural: plural, fmtBytes: fmtBytes, showVal: showVal,
    h53: h53, textHash: textHash, sipHash: sipHash, utf8Bytes: utf8Bytes, deriveKey: deriveKey, passphraseProblem: passphraseProblem,
    canonNum: canonNum, shiftNum: shiftNum, roundNum: roundNum, cmpNum: cmpNum, parseDate: parseDate, formatDate: formatDate, canonDate: canonDate,
    createCsvParser: createCsvParser, createJsonlParser: createJsonlParser, sniff: sniff, detectHeader: detectHeader, nameColumns: nameColumns, parseText: parseText, shapeCsv: shapeCsv, summariseIssues: summariseIssues,
    createProfiler: createProfiler, createDistinct: createDistinct,
    tokens: tokens, normName: normName, similarity: similarity, automap: automap, suggestKey: suggestKey,
    cleanRule: cleanRule, ruleText: ruleText, sortRules: sortRules, cleanRecipe: cleanRecipe, cleanShape: cleanShape, compilePlan: compilePlan, normBefore: normBefore, normAfter: normAfter,
    createHasher: createHasher, diffHashers: diffHashers, wantedKeys: wantedKeys, createDetail: createDetail, recognize: recognize, diagnose: diagnose, aggregateChecks: aggregateChecks, compareRows: compareRows,
    learnRules: learnRules, keyHashOf: keyHashOf, learnStride: learnStride, sampleJoin: sampleJoin,
    bucketOf: bucketOf, keyedKeyHex: keyedKeyHex, recipeId: recipeId, fingerprintFrom: fingerprintFrom, cleanFingerprint: cleanFingerprint, compareFingerprints: compareFingerprints, rowListFrom: rowListFrom, cleanRowList: cleanRowList, compareRowLists: compareRowLists,
    csvCell: csvCell, examplesCsv: examplesCsv, toJson: toJson, toMarkdown: toMarkdown, toHtml: toHtml, toRecipe: toRecipe,
    modelSummary: modelSummary, cleanProposal: cleanProposal,
  };
}));
