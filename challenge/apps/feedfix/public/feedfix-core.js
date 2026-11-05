/* Feedfix - the rules. Your bank file imported zero rows? Find out why, and
 * fix it.
 *
 * UMD: window.FeedfixCore in the page, importScripts() in the worker,
 * require() in the server and the tests. Everything that reads a statement
 * file, names what is wrong with it and writes the clean one lives here, so
 * the page, the worker, the server's checks and the tests run the same code.
 * No clock, no dice, no network and no storage.
 *
 * What is in here, top to bottom:
 *   - text: cleaning, escaping, making invisible characters visible
 *   - bytes: UTF-8, UTF-16 and Windows-1252 read and written by hand, the
 *     byte-order mark, NULs, garbled ("mojibake") text repaired
 *   - dates and amounts, read the many ways a bank writes them
 *   - a CSV / TSV reader (any delimiter, RFC 4180 quoting, unclosed quotes,
 *     amounts split by an unquoted comma)
 *   - the table: preamble, header, summary rows, blank rows, page breaks,
 *     column guessing from header words and value SHAPES
 *   - OFX / QFX (SGML 1.x and XML 2.x) and QIF readers
 *   - the diagnosis: every finding with its severity, line and a
 *     before/after preview; the day/month question; the running balance;
 *     duplicates
 *   - the fix: five target profiles, every fix listed with an undo, the
 *     re-check of the output, the totals before and after
 *   - exports: the report (masked), the duplicates list (formula-safe)
 *   - settings (preferences only - never a transaction) and the AI column
 *     helper's request and answer, both checked field by field
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FeedfixCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    fileBytes: 20 * 1024 * 1024,  // refused before it is read
    rows: 50000,                   // transactions read from one file
    columns: 60,                   // columns mapped
    cellsRead: 200,                // cells kept per row while reading
    cell: 500,                     // characters kept from one cell
    examples: 3,                   // before/after previews per finding
    lines: 200,                    // line numbers kept per finding
    preview: 120,                  // lines of a file shown
    previewChars: 400,             // characters of one previewed line
    headerChars: 60,
    labelChars: 40, wordChars: 30, sources: 30, words: 30,
    noteChars: 300,
    ofxName: 32, ofxMemo: 255, fitid: 255,
    duplicates: 500,
  };

  var SEV = ['blocks', 'wrong', 'info'];
  var SEV_WORD = { blocks: 'Blocks import', wrong: 'Will import wrong', info: 'Worth knowing' };

  /* ================================================================== *
   * Text
   * ================================================================== */

  // Control characters, bidi overrides, zero-width characters, soft hyphens,
  // the byte-order mark. Each is invisible or reorders text; in a payee it
  // could make one name look like another, and in a header it stops an
  // importer finding the column.
  var BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/g;
  var BAD1 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/;
  var SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  function esc(v) { return str(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function clip(s, n) {
    if (s.length <= n) return s;
    var cut = s.slice(0, Math.max(0, n - 1));
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return cut.replace(/\s+$/, '') + '…';
  }
  /** One line: invisible characters gone, spaces collapsed, bounded. */
  function line(v, max) { return clip(str(v).replace(BAD, '').replace(SPACES, ' ').replace(/\s+/g, ' ').trim(), max || 200); }
  function noMarkup(s) { return str(s).replace(/<[^>]{0,200}>/g, '').replace(/[<>]/g, ''); }
  function fold(s) { return str(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function plural(n, one, many) { return groups(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function pad2(n) { return ('0' + n).slice(-2); }
  function hex4(c) { return ('000' + c.toString(16).toUpperCase()).slice(-4); }

  var MARKS = { 0xFEFF: '‹BOM›', 0x0000: '‹NUL›', 0x0009: '⇥', 0x200B: '‹ZWSP›', 0x200C: '‹ZWNJ›', 0x200D: '‹ZWJ›', 0x00AD: '‹SHY›', 0x00A0: '‹NBSP›' };
  /** A line as it really is: tabs, NULs, the byte-order mark, bidi and
   *  zero-width characters drawn as visible marks, line breaks as ⏎. */
  function visible(s, max) {
    var out = '';
    s = str(s);
    for (var i = 0; i < s.length && out.length < (max || LIMITS.previewChars); i++) {
      var c = s.charCodeAt(i);
      if (MARKS[c] !== undefined) out += MARKS[c];
      else if (c === 10) out += '⏎';
      else if (c === 13) out += (s.charCodeAt(i + 1) === 10 ? '' : '‹CR›');
      else if (c < 32 || (c >= 0x7F && c <= 0x9F) || (c >= 0x200E && c <= 0x200F) || (c >= 0x2028 && c <= 0x202E) || (c >= 0x2060 && c <= 0x2069)) out += '‹U+' + hex4(c) + '›';
      else out += s.charAt(i);
    }
    return out.length >= (max || LIMITS.previewChars) && i < s.length ? out + '…' : out;
  }

  /* ================================================================== *
   * Bytes
   * ================================================================== */

  // Windows-1252's 0x80-0x9F. Five bytes are undefined there; browsers read
  // them as the C1 control with the same number, and so does this.
  var W1252 = [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
    0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178];
  var W1252_BACK = {};
  for (var wi = 0; wi < 32; wi++) W1252_BACK[W1252[wi]] = 0x80 + wi;

  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (x && typeof ArrayBuffer !== 'undefined' && x instanceof ArrayBuffer) return new Uint8Array(x);
    if (x && x.buffer instanceof ArrayBuffer && typeof x.byteLength === 'number') return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength);
    if (typeof x === 'string') return utf8Encode(x);
    if (Array.isArray(x)) return new Uint8Array(x);
    return new Uint8Array(0);
  }

  /** Strict UTF-8: every bad sequence becomes U+FFFD and is counted. */
  function utf8Decode(b, start, end) {
    var out = [], parts = [], invalid = 0, multi = 0, i = start || 0, n = end === undefined ? b.length : end;
    while (i < n) {
      var c = b[i];
      var cp = -1, need = 0;
      if (c < 0x80) { cp = c; i++; }
      else if (c >= 0xC2 && c <= 0xDF) { need = 1; cp = c & 0x1F; }
      else if (c >= 0xE0 && c <= 0xEF) { need = 2; cp = c & 0x0F; }
      else if (c >= 0xF0 && c <= 0xF4) { need = 3; cp = c & 0x07; }
      else { invalid++; out.push(0xFFFD); i++; }
      if (need) {
        var ok = i + need < n + 1 && i + need <= n;
        for (var k = 1; ok && k <= need; k++) { var cc = b[i + k]; if (cc === undefined || (cc & 0xC0) !== 0x80) ok = false; else cp = (cp << 6) | (cc & 0x3F); }
        if (ok && ((need === 2 && cp < 0x800) || (need === 3 && (cp < 0x10000 || cp > 0x10FFFF)) || (cp >= 0xD800 && cp <= 0xDFFF))) ok = false;
        if (ok) {
          multi++; i += need + 1;
          if (cp > 0xFFFF) { cp -= 0x10000; out.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); } else out.push(cp);
        } else { invalid++; out.push(0xFFFD); i++; }
      } else if (cp >= 0 && c < 0x80) out.push(cp);
      if (out.length > 8192) { parts.push(String.fromCharCode.apply(null, out)); out = []; }
    }
    parts.push(String.fromCharCode.apply(null, out));
    return { text: parts.join(''), invalid: invalid, multi: multi };
  }
  function cp1252Decode(b, start, end) {
    var out = [], parts = [], n = end === undefined ? b.length : end;
    for (var i = start || 0; i < n; i++) {
      var c = b[i];
      out.push(c >= 0x80 && c <= 0x9F ? W1252[c - 0x80] : c);
      if (out.length > 8192) { parts.push(String.fromCharCode.apply(null, out)); out = []; }
    }
    parts.push(String.fromCharCode.apply(null, out));
    return parts.join('');
  }
  function utf16Decode(b, start, le) {
    var out = [], parts = [];
    for (var i = start || 0; i + 1 < b.length; i += 2) {
      out.push(le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
      if (out.length > 8192) { parts.push(String.fromCharCode.apply(null, out)); out = []; }
    }
    parts.push(String.fromCharCode.apply(null, out));
    return parts.join('');
  }
  function utf8Encode(s) {
    s = str(s);
    var out = new Uint8Array(s.length * 3), j = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
      }
      if (c < 0x80) out[j++] = c;
      else if (c < 0x800) { out[j++] = 0xC0 | (c >> 6); out[j++] = 0x80 | (c & 0x3F); }
      else if (c < 0x10000) { out[j++] = 0xE0 | (c >> 12); out[j++] = 0x80 | ((c >> 6) & 0x3F); out[j++] = 0x80 | (c & 0x3F); }
      else { out[j++] = 0xF0 | (c >> 18); out[j++] = 0x80 | ((c >> 12) & 0x3F); out[j++] = 0x80 | ((c >> 6) & 0x3F); out[j++] = 0x80 | (c & 0x3F); }
    }
    return out.slice(0, j);
  }
  /** Windows-1252; a character it cannot hold becomes '?', counted. */
  function cp1252Encode(s) {
    s = str(s);
    var out = new Uint8Array(s.length), lost = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80 || (c >= 0xA0 && c <= 0xFF)) out[i] = c;
      else if (W1252_BACK[c] !== undefined) out[i] = W1252_BACK[c];
      else { out[i] = 0x3F; lost++; }
    }
    return { bytes: out, lost: lost };
  }
  function utf16leEncode(s) {
    s = str(s);
    var out = new Uint8Array(s.length * 2);
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); out[i * 2] = c & 0xFF; out[i * 2 + 1] = c >> 8; }
    return out;
  }
  function concat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
  var BOM8 = new Uint8Array([0xEF, 0xBB, 0xBF]);
  /** Text written in an encoding, with or without a byte-order mark. */
  function encode(text, encoding, bom) {
    if (encoding === 'utf-16le') return concat(new Uint8Array([0xFF, 0xFE]), utf16leEncode(text));
    if (encoding === 'windows-1252') return cp1252Encode(text).bytes;
    var b = utf8Encode(text);
    return bom ? concat(BOM8, b) : b;
  }

  function startsWith(b, sig) { for (var i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return false; return true; }

  /** What a file's bytes are: the encoding, a byte-order mark, NULs, bad
   *  bytes - and whether it is a spreadsheet, a PDF or not text at all. */
  function decode(input) {
    var b = toBytes(input);
    var info = { bytes: b.length, encoding: 'utf-8', bom: false, utf16NoBom: false, nul: 0, trailingNul: 0, invalid: 0, multi: 0, binary: null, text: '' };
    if (!b.length) return info;
    if (startsWith(b, [0x50, 0x4B, 0x03, 0x04])) { info.binary = 'xlsx'; return info; }
    if (startsWith(b, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])) { info.binary = 'xls'; return info; }
    if (startsWith(b, [0x25, 0x50, 0x44, 0x46])) { info.binary = 'pdf'; return info; }
    if (startsWith(b, [0x89, 0x50, 0x4E, 0x47]) || startsWith(b, [0xFF, 0xD8, 0xFF]) || startsWith(b, [0x47, 0x49, 0x46, 0x38])) { info.binary = 'image'; return info; }
    if (startsWith(b, [0xEF, 0xBB, 0xBF])) { info.bom = true; info.encoding = 'utf-8'; }
    else if (startsWith(b, [0xFF, 0xFE])) { info.bom = true; info.encoding = 'utf-16le'; }
    else if (startsWith(b, [0xFE, 0xFF])) { info.bom = true; info.encoding = 'utf-16be'; }
    else {
      // UTF-16 without a mark: every other byte is zero.
      var even = 0, odd = 0, m = Math.min(b.length, 4000);
      for (var i = 0; i < m; i++) if (b[i] === 0) { if (i % 2) odd++; else even++; }
      if (m >= 8 && odd > m * 0.3 && even < m * 0.02) { info.encoding = 'utf-16le'; info.utf16NoBom = true; }
      else if (m >= 8 && even > m * 0.3 && odd < m * 0.02) { info.encoding = 'utf-16be'; info.utf16NoBom = true; }
    }
    var text;
    if (info.encoding === 'utf-16le' || info.encoding === 'utf-16be') {
      text = utf16Decode(b, info.bom ? 2 : 0, info.encoding === 'utf-16le');
      var t = text.length; while (t > 0 && text.charCodeAt(t - 1) === 0) t--;
      info.trailingNul = text.length - t; text = text.slice(0, t);
    } else {
      var end = b.length; while (end > 0 && b[end - 1] === 0) end--;
      info.trailingNul = b.length - end;
      var u = utf8Decode(b, info.bom ? 3 : 0, end);
      info.multi = u.multi;
      if (u.invalid && !info.bom && u.invalid * 4 >= u.multi) { info.encoding = 'windows-1252'; text = cp1252Decode(b, 0, end); }
      else { text = u.text; info.invalid = u.invalid; }
    }
    for (var j = 0; j < text.length; j++) if (text.charCodeAt(j) === 0) info.nul++;
    // Not text at all: many control characters, NULs aside from UTF-16's.
    var ctrl = 0, look = Math.min(text.length, 8000);
    for (var k = 0; k < look; k++) { var c = text.charCodeAt(k); if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xFFFD) ctrl++; }
    if (look && ctrl > look * 0.1) info.binary = 'binary';
    info.text = text;
    return info;
  }

  // UTF-8 text that was read as Windows-1252 and saved again: "CafÃ©" for
  // "Café", "â€™" for a curly apostrophe. A run is repaired only when every
  // character maps back to one byte and the bytes are valid UTF-8.
  var MOJI = /[\u00C2-\u00F4][\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]{1,3}/g;
  function unmojibake(s) {
    var count = 0;
    var text = str(s).replace(MOJI, function (run) {
      var bytes = [];
      for (var i = 0; i < run.length; i++) {
        var c = run.charCodeAt(i);
        if (c <= 0xFF && !(c >= 0x80 && c <= 0x9F)) bytes.push(c);
        else if (W1252_BACK[c] !== undefined) bytes.push(W1252_BACK[c]);
        else return run;
      }
      var u = utf8Decode(new Uint8Array(bytes));
      if (u.invalid || !u.multi) return run;
      count++;
      return u.text;
    });
    return { text: text, count: count };
  }

  /* ================================================================== *
   * Dates
   * ================================================================== */

  var MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function leap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function daysIn(y, m) { return [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
  function validYmd(y, m, d) { return y >= 1900 && y <= 2199 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m); }
  function iso(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
  function isDay(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s)); return Boolean(m && validYmd(+m[1], +m[2], +m[3])); }
  function dayNumber(isoDay) { var p = isoDay.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000; }
  function niceDay(isoDay) { if (!isDay(isoDay)) return ''; var p = isoDay.split('-'); return (+p[2]) + ' ' + MONTH_SHORT[+p[1] - 1] + ' ' + p[0]; }
  function expandYear(y) { return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y; }

  var TIME_TAIL = /(?:[T ,]+\d{1,2}[:.]\d{2}(?:[:.]\d{2}(?:\.\d+)?)?\s*(?:am|pm)?\s*(?:z|utc|gmt|[+-]\d{2}:?\d{2})?)$/i;
  /** The parts of a date cell. Unambiguous shapes come back as y/m/d; n/n/y
   *  comes back as kind 'num' with both numbers, for the column's order to
   *  decide. `mapped` allows yyyymmdd (only in a column known to be dates). */
  function dateParts(raw, mapped) {
    var s = line(raw, 60);
    if (!s || !/\d/.test(s)) return null;
    var time = false;
    s = s.replace(/^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i, '');
    var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?$/i.exec(s);
    if (m) { if (m[0].length > 10) time = true; return validYmd(+m[1], +m[2], +m[3]) ? { kind: 'iso', y: +m[1], m: +m[2], d: +m[3], time: time } : { kind: 'bad' }; }
    if (mapped && (m = /^(\d{4})(\d{2})(\d{2})(?:\d{4,6}(?:\.\d{1,3})?)?(?:\[[^\]]{0,12}\])?$/.exec(s))) return validYmd(+m[1], +m[2], +m[3]) ? { kind: 'compact', y: +m[1], m: +m[2], d: +m[3] } : { kind: 'bad' };
    if (TIME_TAIL.test(s) && !/^\d{1,2}[:.]\d{2}/.test(s)) { var cut = s.replace(TIME_TAIL, ''); if (cut !== s && /\d/.test(cut)) { s = cut; time = true; } }
    if ((m = /^(\d{1,2})\/\s?(\d{1,2})'\s?(\d{2})$/.exec(s))) return { kind: 'num', a: +m[1], b: +m[2], y: 2000 + (+m[3]), two: true, quicken: true, time: time };
    if ((m = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4}|\d{2})$/.exec(s))) return { kind: 'num', a: +m[1], b: +m[3], y: expandYear(+m[4]), two: m[4].length === 2, sep: m[2], time: time };
    if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[ \-./]?([a-z]{3,9})\.?[ \-./,]*(\d{4}|\d{2})$/i.exec(s)) && MONTHS[m[2].toLowerCase()]) {
      var y1 = expandYear(+m[3]), mo1 = MONTHS[m[2].toLowerCase()];
      return validYmd(y1, mo1, +m[1]) ? { kind: 'text', y: y1, m: mo1, d: +m[1], two: m[3].length === 2, time: time } : { kind: 'bad' };
    }
    if ((m = /^([a-z]{3,9})\.?[ \-]?(\d{1,2})(?:st|nd|rd|th)?,?[ \-]*(\d{4}|\d{2})$/i.exec(s)) && MONTHS[m[1].toLowerCase()]) {
      var y2 = expandYear(+m[3]), mo2 = MONTHS[m[1].toLowerCase()];
      return validYmd(y2, mo2, +m[2]) ? { kind: 'text', y: y2, m: mo2, d: +m[2], two: m[3].length === 2, time: time } : { kind: 'bad' };
    }
    if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(s)) return { kind: 'bad' };
    return null;
  }
  /** A date cell as YYYY-MM-DD, or null. `order` decides n/n/y. */
  function readDate(raw, order, mapped) {
    var p = dateParts(raw, mapped);
    if (!p || p.kind === 'bad') return null;
    if (p.kind !== 'num') return iso(p.y, p.m, p.d);
    var o = order === 'dmy' ? 'dmy' : order === 'mdy' ? 'mdy' : (p.a > 12 ? 'dmy' : 'mdy');
    if (p.a > 12 && o === 'mdy') o = 'dmy';
    if (p.b > 12 && o === 'dmy') o = 'mdy';
    var d = o === 'dmy' ? p.a : p.b, mo = o === 'dmy' ? p.b : p.a;
    return validYmd(p.y, mo, d) ? iso(p.y, mo, d) : null;
  }
  function looksDate(raw) { var p = dateParts(raw, false); return Boolean(p && p.kind !== 'bad'); }

  /** How a column of dates is written: the n/n/y order the values prove
   *  ('dmy' when a first part is over 12, 'mdy' when a second is, 'mixed'
   *  when both happen, 'ambiguous' when every one is 12 or under), plus two-
   *  digit years, month names, times and the cells that are not dates. */
  function dateStyle(values, mapped) {
    var s = { dmy: 0, mdy: 0, amb: 0, iso: 0, text: 0, compact: 0, two: 0, time: 0, bad: [], num: 0, order: 'none', quicken: 0 };
    values.forEach(function (v, i) {
      var p = dateParts(v, mapped);
      if (!p || p.kind === 'bad') { if (line(v, 5)) s.bad.push(i); return; }
      if (p.two) s.two++;
      if (p.time) s.time++;
      if (p.quicken) s.quicken++;
      if (p.kind === 'num') {
        s.num++;
        if (p.a > 12 && p.b <= 12) s.dmy++; else if (p.b > 12 && p.a <= 12) s.mdy++; else if (p.a <= 12 && p.b <= 12) s.amb++; else s.bad.push(i);
      } else s[p.kind]++;
    });
    s.order = s.dmy && s.mdy ? 'mixed' : s.dmy ? 'dmy' : s.mdy ? 'mdy' : s.amb ? 'ambiguous' : 'none';
    var kinds = (s.num ? 1 : 0) + (s.iso ? 1 : 0) + (s.text ? 1 : 0) + (s.compact ? 1 : 0);
    s.mixedKinds = kinds > 1;
    return s;
  }
  /** Read a column one way and say whether the dates then run in order -
   *  a statement is sorted, oldest or newest first. */
  function ordering(values, order, mapped) {
    var days = [];
    values.forEach(function (v) { var d = readDate(v, order, mapped); if (d) days.push(d); });
    var up = 0, down = 0;
    for (var i = 1; i < days.length; i++) { if (days[i] < days[i - 1]) down++; else if (days[i] > days[i - 1]) up++; }
    var sorted = days.slice().sort();
    return { read: days.length, inversions: Math.min(up, down), inOrder: Math.min(up, down) === 0, direction: down > up ? 'newest first' : 'oldest first', first: sorted[0] || null, last: sorted[sorted.length - 1] || null, spanDays: sorted.length ? dayNumber(sorted[sorted.length - 1]) - dayNumber(sorted[0]) : 0 };
  }
  /** For a column where every n/n/y date is 12 or under: both readings, and
   *  the one that makes the dates run in order (else the shorter span, else
   *  how this browser writes dates). */
  function orderQuestion(values, dayFirst, mapped) {
    var a = ordering(values, 'dmy', mapped), b = ordering(values, 'mdy', mapped);
    var pick;
    if (a.inversions !== b.inversions) pick = a.inversions < b.inversions ? 'dmy' : 'mdy';
    else if (a.spanDays !== b.spanDays) pick = a.spanDays < b.spanDays ? 'dmy' : 'mdy';
    else pick = dayFirst ? 'dmy' : 'mdy';
    var why = a.inversions !== b.inversions ? 'in order' : a.spanDays !== b.spanDays ? 'shorter' : 'locale';
    var ex = [];
    for (var i = 0; i < values.length && ex.length < 3; i++) {
      var p = dateParts(values[i], mapped);
      if (p && p.kind === 'num' && p.a !== p.b) ex.push({ raw: line(values[i], 20), dmy: readDate(values[i], 'dmy', mapped), mdy: readDate(values[i], 'mdy', mapped) });
    }
    return { dmy: a, mdy: b, suggestion: pick, why: why, examples: ex };
  }
  var DATE_FORMATS = {
    mdy: { label: 'MM/DD/YYYY', write: function (d) { var p = d.split('-'); return p[1] + '/' + p[2] + '/' + p[0]; }, re: /^(\d{2})\/(\d{2})\/(\d{4})$/, order: 'mdy' },
    dmy: { label: 'DD/MM/YYYY', write: function (d) { var p = d.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }, re: /^(\d{2})\/(\d{2})\/(\d{4})$/, order: 'dmy' },
    iso: { label: 'YYYY-MM-DD', write: function (d) { return d; }, re: /^(\d{4})-(\d{2})-(\d{2})$/, order: 'iso' },
  };

  /* ================================================================== *
   * Amounts (integer cents)
   * ================================================================== */

  var CUR_SYM = /^(?:[A-Z]{0,3}\$|€|£|¥|₹|₩|₪|₱|kr\.?|R\$?|Fr\.?|zł|Kč)\s*|\s*(?:[A-Z]{0,3}\$|€|£|¥|₹|₩|₪|₱|kr\.?|zł|Kč)$/;
  var CUR_CODE = /^(?:USD|EUR|GBP|CAD|AUD|NZD|CHF|SEK|NOK|DKK|ZAR|JPY|INR|SGD|HKD|MXN|BRL|PLN|CZK|HUF|IEP)\s*|\s*(?:USD|EUR|GBP|CAD|AUD|NZD|CHF|SEK|NOK|DKK|ZAR|JPY|INR|SGD|HKD|MXN|BRL|PLN|CZK|HUF)$/i;
  var SYM_CUR = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };

  /** An amount cell in integer cents, with notes on how it was written:
   *  symbol, code, thousands, comma (decimal comma), paren, trailing (minus),
   *  crdr, minus (a typographic minus), plus, precision (more than two
   *  decimals). `decimal` is the column's decimal mark when known. Empty is
   *  null; not a number is {error}. */
  function readAmount(raw, decimal) {
    var s = str(raw).replace(BAD, '').replace(SPACES, ' ').trim();
    if (!s) return null;
    var notes = {}, neg = false, m;
    if ((m = /^(.*\d\)?)\s*(cr|dr)\.?$/i.exec(s)) || (m = /^(cr|dr)\.?\s+(.*\d.*)$/i.exec(s))) {
      var word = /^(cr|dr)$/i.test(m[1]) ? m[1] : m[2];
      s = (/^(cr|dr)$/i.test(m[1]) ? m[2] : m[1]).trim();
      notes.crdr = 1;
      if (/dr/i.test(word)) neg = true;
    }
    if (/^\(.*\)$/.test(s)) { s = s.slice(1, -1).trim(); neg = !neg; notes.paren = 1; }
    if (/^[-\u2212\u2012\u2013]/.test(s)) { if (s.charAt(0) !== '-') notes.minus = 1; s = s.slice(1).trim(); neg = !neg; }
    else if (/^\+/.test(s)) { s = s.slice(1).trim(); notes.plus = 1; }
    if (CUR_CODE.test(s)) { var cc = (/[A-Z]{3}/i.exec(s) || [''])[0].toUpperCase(); s = s.replace(CUR_CODE, '').trim(); notes.code = cc || 1; }
    if (CUR_SYM.test(s)) { var sy = (/[$€£¥₹]/.exec(s) || [''])[0]; s = s.replace(CUR_SYM, '').trim(); notes.symbol = SYM_CUR[sy] || 1; }
    if (/^[-\u2212]/.test(s)) { s = s.slice(1).trim(); neg = !neg; }
    if (/-$/.test(s)) { s = s.slice(0, -1).trim(); neg = !neg; notes.trailing = 1; }
    if (/^\(.*\)$/.test(s)) { s = s.slice(1, -1).trim(); neg = !neg; notes.paren = 1; }
    if (!/^[\d.,' ]+$/.test(s) || !/\d/.test(s)) return { error: true };
    if (/ /.test(s)) { if (!/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(s)) return { error: true }; s = s.replace(/ /g, ''); notes.thousands = 1; }
    if (/'/.test(s)) { s = s.replace(/'/g, ''); notes.thousands = 1; }
    var lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    var dec;
    if (decimal === ',' || decimal === '.') dec = decimal;
    else if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
    else if (lastComma >= 0) dec = /,\d{3}$/.test(s) ? '.' : ',';
    else dec = '.';
    // One value can prove its own mark: 12,50 in a dot column, or 1,234.56
    // in a comma one, can only be read one way.
    if (dec === '.' && (/^\d+,\d{1,2}$/.test(s) || /^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s))) dec = ',';
    else if (dec === ',' && (/^\d+\.\d{1,2}$/.test(s) || /^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(s))) dec = '.';
    // In a dot-decimal column "1,234" is thousands; in a comma one "1.234" is.
    var thou = dec === '.' ? ',' : '.';
    var intPart = s, frac = '';
    var at = s.lastIndexOf(dec);
    if (at >= 0) { intPart = s.slice(0, at); frac = s.slice(at + 1); }
    if (frac.indexOf(thou) >= 0 || frac.indexOf(dec) >= 0) return { error: true };
    if (intPart.indexOf(dec) >= 0) {
      // "1.234.567" in a dot column: the dots were thousands after all.
      if (dec === '.' && !frac.length) return { error: true };
      return { error: true };
    }
    if (intPart.indexOf(thou) >= 0) {
      if (!/^\d{1,3}([.,]\d{3})+$/.test(intPart)) return { error: true };
      intPart = intPart.split(thou).join('');
      notes.thousands = 1;
    }
    if (!/^\d*$/.test(intPart) || !/^\d*$/.test(frac) || (!intPart && !frac)) return { error: true };
    if (dec === ',' && frac.length) notes.comma = 1;
    var cents;
    if (frac.length > 2) { notes.precision = 1; cents = Math.round(Number((intPart || '0') + '.' + frac) * 100); }
    else cents = Number(intPart || '0') * 100 + Number((frac + '00').slice(0, 2));
    if (!isFinite(cents) || Math.abs(cents) > 1e15) return { error: true };
    if (neg && cents) cents = -cents;
    return { cents: cents, notes: notes };
  }
  /** A column's decimal mark, from its values: comma when values end ",56"
   *  and none end ".56". */
  function amountStyle(values) {
    var comma = 0, dot = 0;
    values.forEach(function (v) {
      var s = str(v).replace(/\s*(cr|dr)\.?$/i, '').replace(/[)\-\s]+$/, '');
      if (/\d,\d{1,2}$/.test(s)) comma++;
      else if (/\d\.\d{1,2}$/.test(s)) dot++;
      else if (/\d\.\d{3},/.test(s)) comma++;
      else if (/\d,\d{3}\./.test(s)) dot++;
    });
    return comma > 0 && comma >= dot * 2 ? ',' : '.';
  }
  /** 1234.56 for a file an importer reads. */
  function plain(cents) {
    var c = Math.abs(Math.round(cents));
    return (cents < 0 ? '-' : '') + Math.floor(c / 100) + '.' + pad2(c % 100);
  }
  var CUR_SIGN = { USD: '$', CAD: 'CA$', AUD: 'A$', NZD: 'NZ$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹', CHF: 'CHF ', SEK: 'SEK ', NOK: 'NOK ', DKK: 'DKK ', ZAR: 'R', SGD: 'S$', HKD: 'HK$', MXN: 'MX$' };
  var CURRENCIES = Object.keys(CUR_SIGN);
  /** $8,214.50 for people. */
  function money(cents, cur) {
    if (typeof cents !== 'number' || !isFinite(cents)) return '';
    var c = Math.abs(Math.round(cents)), sign = CUR_SIGN[cur] || (cur ? cur + ' ' : '$');
    return (cents < 0 ? '-' : '') + sign + groups(Math.floor(c / 100)) + '.' + pad2(c % 100);
  }

  /* ================================================================== *
   * Delimited files
   * ================================================================== */

  var DELIMS = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };

  /** The delimiter, from the first 60 lines: the one that splits the most
   *  lines into the same number of fields. Excel's sep= line wins. */
  function sniffDelimiter(text) {
    var sep = /^sep=(.)\r?\n/i.exec(text);
    if (sep && DELIMS[sep[1]]) return { delim: sep[1], sep: true };
    var lines = text.slice(0, 64000).split(/\r\n|\n|\r/).slice(0, 60).filter(function (l) { return l.trim(); });
    var best = ',', bestScore = -1;
    Object.keys(DELIMS).forEach(function (d) {
      var counts = {};
      lines.forEach(function (l) {
        var n = 0, q = false;
        for (var i = 0; i < l.length; i++) { var ch = l.charAt(i); if (ch === '"') q = !q; else if (ch === d && !q) n++; }
        counts[n] = (counts[n] || 0) + 1;
      });
      var modal = 0, freq = 0;
      Object.keys(counts).forEach(function (k) { if (+k > 0 && (counts[k] > freq || (counts[k] === freq && +k > modal))) { modal = +k; freq = counts[k]; } });
      var score = modal ? (freq / Math.max(1, lines.length)) * Math.min(modal + 1, 12) : 0;
      if (score > bestScore + 1e-9) { best = d; bestScore = score; }
    });
    return { delim: best, sep: false };
  }

  /** RFC 4180 records with their starting line. `breakAt` closes a quote
   *  that opened on one of those lines at the end of that line (the repair
   *  for an unclosed quote). */
  function parseRecords(text, delim, opts) {
    opts = opts || {};
    var breakAt = opts.breakAt || {};
    var D = delim.charCodeAt(0);
    var records = [], n = text.length, i = 0, lineNo = 1, open = null, cut = 0, multi = [], stray = {}, fixed = [], truncated = false;
    var maxRecords = LIMITS.rows + 2000;
    while (i < n) {
      if (records.length >= maxRecords) { truncated = true; break; }
      var start = i, startLine = lineNo, cells = [], wasFixed = false;
      for (;;) {
        var val;
        if (text.charCodeAt(i) === 34 && breakAt[lineNo]) {
          // The repair for a quote that never closes: it was a stray
          // character, so the field is read as unquoted, without it.
          var rs = ++i;
          while (i < n) { var rc = text.charCodeAt(i); if (rc === D || rc === 10 || rc === 13) break; i++; }
          val = text.slice(rs, i).replace(/"$/, '');
          wasFixed = true;
        } else if (text.charCodeAt(i) === 34) {
          var qLine = lineNo, buf = '', seg = i + 1, spanned = false;
          i++;
          for (;;) {
            if (i >= n) { if (!open) open = qLine; buf += text.slice(seg, i); break; }
            var c = text.charCodeAt(i);
            if (c === 34) {
              if (text.charCodeAt(i + 1) === 34) { buf += text.slice(seg, i + 1); i += 2; seg = i; continue; }
              buf += text.slice(seg, i); i++; break;
            }
            if (c === 10 || c === 13) {
              spanned = true; lineNo++;
              if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
              i++; continue;
            }
            i++;
          }
          var tail = i;
          while (i < n) { var t = text.charCodeAt(i); if (t === D || t === 10 || t === 13) break; i++; }
          if (i > tail) { buf += text.slice(tail, i); if (text.slice(tail, i).trim()) stray[lineNo] = 1; }
          if (spanned) multi.push({ line: qLine, value: buf });
          val = buf;
        } else {
          var fs = i;
          while (i < n) { var ch = text.charCodeAt(i); if (ch === D || ch === 10 || ch === 13) break; if (ch === 34) stray[lineNo] = 1; i++; }
          val = text.slice(fs, i);
        }
        if (val.length > LIMITS.cell) { val = val.slice(0, LIMITS.cell); cut++; }
        if (cells.length < LIMITS.cellsRead) cells.push(val);
        if (i < n && text.charCodeAt(i) === D) { i++; if (i >= n) { cells.push(''); break; } continue; }
        break;
      }
      var end = i;
      if (i < n) { if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) i += 2; else i++; lineNo++; }
      if (wasFixed) fixed.push(startLine);
      records.push({ line: startLine, cells: cells, raw: text.slice(start, end) });
    }
    return { records: records, open: open, multi: multi, stray: Object.keys(stray).map(Number), fixed: fixed, cut: cut, truncated: truncated };
  }
  function modalWidth(records) {
    var c = {}, best = 0, f = 0;
    records.forEach(function (r) { var k = r.cells.length; if (k >= 2 && r.cells.some(function (x) { return x.trim(); })) c[k] = (c[k] || 0) + 1; });
    Object.keys(c).forEach(function (k) { if (c[k] > f || (c[k] === f && +k > best)) { best = +k; f = c[k]; } });
    return best || 1;
  }
  /** Parse, then repair unclosed quotes: a quote that runs to the end of the
   *  file, or swallows a line that looks like a whole row, is closed at the
   *  end of the line it opened on. */
  function readDelimited(text, delim, repair) {
    var breakAt = {}, p = parseRecords(text, delim, {}), found = [];
    if (repair) {
      for (var round = 0; round < 25; round++) {
        var w = modalWidth(p.records), add = [];
        if (p.open && !breakAt[p.open]) add.push(p.open);
        p.multi.forEach(function (mf) {
          if (breakAt[mf.line]) return;
          var rest = mf.value.split(/\r\n|\n|\r/).slice(1);
          if (rest.some(function (l) { return l.split(delim).length - 1 >= Math.max(1, w - 2); })) add.push(mf.line);
        });
        if (!add.length) break;
        add.forEach(function (l) { if (!breakAt[l]) { breakAt[l] = true; found.push(l); } });
        p = parseRecords(text, delim, { breakAt: breakAt });
      }
    }
    p.unclosed = found.filter(function (x, k) { return found.indexOf(x) === k; }).sort(function (a, b) { return a - b; });
    p.strictOpen = repair ? null : p.open;
    return p;
  }

  /* ================================================================== *
   * The table: header, preamble, summary rows, columns
   * ================================================================== */

  var FIELDS = ['date', 'description', 'payee', 'amount', 'debit', 'credit', 'balance', 'reference', 'type', 'ignore'];
  var FIELD_LABEL = { date: 'Date', description: 'Description', payee: 'Payee', amount: 'Amount', debit: 'Debit (money out)', credit: 'Credit (money in)', balance: 'Balance', reference: 'Reference / check no.', type: 'Type (debit/credit)', ignore: 'Not needed' };
  var MAP_FIELDS = FIELDS.filter(function (f) { return f !== 'ignore'; });

  function headerNorm(h) { return str(h).replace(BAD, '').toLowerCase().replace(/[_./\\#()[\]:*]+/g, ' ').replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  // Header words per field: [regex, points]. The best rule counts.
  var HEADER_RULES = {
    date: [[/\b(transaction date|trans date|txn date|posting date|posted date|booking date|date posted|date)\b/, 38], [/\b(posted|booked|booking|datum|fecha)\b/, 30], [/\b(value date|effective date|value dt)\b/, 24]],
    description: [[/\b(description|descr|desc|details?|narrative|particulars|transaction details|memo|remarks?|text|narration)\b/, 34], [/\btransaction\b/, 22]],
    payee: [[/\b(payee|merchant|counterparty|beneficiary|paid to|recipient|vendor|other party|payer|name)\b/, 34]],
    amount: [[/\b(amount|amt|transaction amount|betrag|montant|importe|value)\b/, 36]],
    debit: [[/\b(debit|debits|withdrawals?|withdrawal amount|paid out|money out|outflow|spent|charges?|dr)\b/, 40], [/\bout\b/, 26]],
    credit: [[/\b(credit|credits|deposits?|deposit amount|paid in|money in|inflow|received|cr)\b/, 40], [/\bin\b/, 22]],
    balance: [[/\b(balance|running balance|bal|saldo|solde)\b/, 42]],
    reference: [[/\b(ref|reference|check|cheque|chk|check number|cheque number|transaction id|fitid|serial|doc|document)\b/, 32], [/\b(number|no|id)\b/, 20]],
    type: [[/\b(type|transaction type|tran type|dr cr|debit credit|kind|code)\b/, 32]],
  };
  function headerScore(field, h) {
    var n = headerNorm(h), best = 0;
    (HEADER_RULES[field] || []).forEach(function (r) { if (r[0].test(n) && r[1] > best) best = r[1]; });
    if (field === 'payee' && /\b(file|account|bank|user)\s*name\b/.test(n)) best = 0;
    if (field === 'amount' && /\b(balance|bal)\b/.test(n)) best = 0;
    if (field === 'description' && /\b(type|code)\b/.test(n) && !/description/.test(n)) best = Math.min(best, 10);
    if (field === 'reference' && /\b(date|amount|balance)\b/.test(n)) best = 0;
    if ((field === 'debit' || field === 'credit') && /\b(card|date|type|account)\b/.test(n)) best = 0;
    if (field === 'type' && /\b(debit|credit)\b/.test(n) && !/\b(type|dr cr|debit credit)\b/.test(n)) best = 0;
    if (field === 'date' && /\b(value date|effective)\b/.test(n) && best > 24) best = 24;
    return best;
  }

  var TYPE_OUT = /^(debit|dr|d|withdrawal|withdraw|payment|pmt|purchase|sale|charge|fee|out|outgoing|debit card|pos|atm|check|cheque|direct debit|dd|so|standing order|transfer out)$/i;
  var TYPE_IN = /^(credit|cr|c|deposit|dep|refund|payment received|interest|int|in|incoming|transfer in|dividend|salary|bgc|bacs credit)$/i;

  /** What a column's values look like, from a sample. */
  function profile(values, decimal) {
    var p = { n: 0, total: values.length, empty: 0, date: 0, num: 0, neg: 0, paren: 0, crdr: 0, comma: 0, symbol: 0, whole: 0, long: 0, code: 0, text: 0, words: 0, many: 0, caps: 0, typeWords: 0, distinct: 0, ambig: 0, dmy: 0, mdy: 0, isoish: 0, textMonth: 0 };
    var seen = {};
    values.slice(0, 400).forEach(function (raw) {
      var v = line(raw, 120);
      if (!v) { p.empty++; return; }
      p.n++;
      var k = v.toLowerCase(); if (!seen[k]) { seen[k] = 1; p.distinct++; }
      var dp = dateParts(v, false);
      if (dp && dp.kind !== 'bad') {
        p.date++;
        if (dp.kind === 'num') { if (dp.a > 12) p.dmy++; else if (dp.b > 12) p.mdy++; else p.ambig++; }
        else if (dp.kind === 'text') p.textMonth++; else p.isoish++;
        return;
      }
      var a = readAmount(v, decimal);
      if (a && !a.error && /\d/.test(v) && !/^\d{7,}$/.test(v.replace(/[\s-]/g, ''))) {
        p.num++;
        if (a.cents < 0) p.neg++;
        if (a.notes.paren) p.paren++;
        if (a.notes.crdr) p.crdr++;
        if (a.notes.comma) p.comma++;
        if (a.notes.symbol || a.notes.code) p.symbol++;
        if (/^\d+$/.test(v)) p.whole++;
        if (/^\d{5,}$/.test(v)) p.long++;
        return;
      }
      if (/^[A-Za-z]{0,6}[-#]?\d{5,}$/.test(v.replace(/\s/g, ''))) { p.long++; return; }
      if (/[A-Za-z]/.test(v) && /\d/.test(v) && v.split(/\s+/).length <= 2) { p.code++; }
      if (TYPE_OUT.test(v) || TYPE_IN.test(v)) p.typeWords++;
      p.text++;
      var w = v.split(/\s+/).length;
      if (w >= 5) p.many++; else p.words++;
      if (/[A-Z]/.test(v) && v === v.toUpperCase()) p.caps++;
    });
    return p;
  }
  function frac(p, k) { return p.n ? p[k] / p.n : 0; }

  // The fixed vocabulary of column SHAPES. The page describes each column
  // with these codes, computed on the device; "Help me read these columns"
  // sends the codes and the header names and nothing else, and the server
  // refuses any code not on this list. No code holds a digit or a value.
  var SHAPES = {
    'empty-mostly': 'mostly empty',
    'date-iso': 'date-like, year first',
    'date-dmy': 'date-like, day first',
    'date-mdy': 'date-like, month first',
    'date-unclear': 'date-like, day and month order unclear',
    'date-text': 'date with a month name',
    'number-dot': 'number with dot decimals',
    'number-comma': 'number with comma decimals',
    'number-currency': 'amount with a currency sign',
    'number-paren': 'some numbers in parentheses',
    'number-negative': 'some numbers negative',
    'number-positive': 'numbers, all positive',
    'number-crdr': 'numbers marked CR or DR',
    'number-whole': 'whole numbers',
    'digits-long': 'long runs of digits, like ids',
    'code': 'letters and digits together',
    'text-short': 'text, 1 to 4 words',
    'text-long': 'text, 5 or more words',
    'text-caps': 'mostly capital letters',
    'type-words': 'words like debit and credit',
    'few-values': 'a handful of repeated values',
    'all-different': 'every value different',
  };
  /** The shape codes for one column (at most five), from SHAPES. */
  function shapeCodes(p) {
    var out = [];
    if (p.total && p.empty / p.total > 0.6) out.push('empty-mostly');
    if (!p.n) return out.length ? out : ['empty-mostly'];
    if (frac(p, 'date') > 0.6) {
      out.push(p.textMonth > p.date / 2 ? 'date-text' : p.isoish > p.date / 2 ? 'date-iso' : p.dmy ? 'date-dmy' : p.mdy ? 'date-mdy' : 'date-unclear');
    } else if (frac(p, 'num') > 0.6) {
      out.push(p.whole === p.num && !p.comma ? 'number-whole' : p.comma ? 'number-comma' : 'number-dot');
      if (p.symbol) out.push('number-currency');
      if (p.paren) out.push('number-paren');
      if (p.crdr) out.push('number-crdr');
      out.push(p.neg ? 'number-negative' : 'number-positive');
    } else if (frac(p, 'long') > 0.6) out.push('digits-long');
    else if (frac(p, 'code') > 0.6) out.push('code');
    else {
      out.push(frac(p, 'many') > 0.4 ? 'text-long' : 'text-short');
      if (frac(p, 'typeWords') > 0.6) out.push('type-words');
      if (frac(p, 'caps') > 0.6) out.push('text-caps');
    }
    if (p.n >= 4 && p.distinct <= Math.max(2, Math.min(6, p.n / 3))) out.push('few-values');
    else if (p.n >= 4 && p.distinct === p.n) out.push('all-different');
    return out.slice(0, 5);
  }
  function shapeScore(field, p) {
    if (!p.n) return { s: 0, gate: true };
    var date = frac(p, 'date'), num = frac(p, 'num'), text = frac(p, 'text');
    var emptyShare = p.total ? p.empty / p.total : 0;
    switch (field) {
      case 'date': return { s: date * 30, gate: date < 0.5 };
      case 'amount': return { s: num * 20 + (p.neg ? 6 : 0) - emptyShare * 12, gate: num < 0.6 };
      case 'debit': case 'credit': return { s: num * 14 + (emptyShare > 0.15 ? 8 : 0), gate: num < 0.6 };
      case 'balance': return { s: num * 16 - emptyShare * 10, gate: num < 0.6 };
      case 'description': return { s: text * 14 + frac(p, 'many') * 8 + (p.distinct > p.n / 2 ? 4 : 0), gate: text < 0.5 };
      case 'payee': return { s: text * 12 + frac(p, 'caps') * 2, gate: text < 0.5 };
      case 'reference': return { s: (frac(p, 'long') + frac(p, 'code') + frac(p, 'whole')) * 10, gate: date > 0.5 };
      case 'type': return { s: frac(p, 'typeWords') * 26, gate: frac(p, 'typeWords') < 0.5 };
    }
    return { s: 0, gate: true };
  }

  /** Which column holds which field: header points plus value-shape points,
   *  the best pair first, each column once. Each field is sure / likely /
   *  unsure. A Debit and a Credit column together replace Amount. */
  function guessColumns(headers, rows, hasHeader) {
    var cols = headers.length;
    var vals = [];
    for (var c = 0; c < cols; c++) vals.push(rows.slice(0, 400).map(function (r) { return r[c] === undefined ? '' : r[c]; }));
    var decimals = vals.map(amountStyle);
    var profiles = vals.map(function (v, i) { return profile(v, decimals[i]); });
    var pairs = [];
    MAP_FIELDS.forEach(function (f) {
      for (var c2 = 0; c2 < cols; c2++) {
        var h = hasHeader ? headerScore(f, headers[c2]) : 0;
        var sh = shapeScore(f, profiles[c2]);
        if (sh.gate && !(h >= 30 && profiles[c2].n === 0)) { if (h < 30 || sh.gate) { if (!(h >= 30 && !profiles[c2].n)) continue; } }
        var score = h + sh.s;
        if (!h && !hasHeader) score += 0;
        if (score >= 12) pairs.push({ f: f, c: c2, s: score, h: h, sh: sh.s });
      }
    });
    pairs.sort(function (a, b) { return b.s - a.s || a.c - b.c; });
    var map = {}, sure = {}, used = {};
    MAP_FIELDS.forEach(function (f) { map[f] = -1; sure[f] = 'none'; });
    pairs.forEach(function (p) {
      if (map[p.f] >= 0 || used[p.c]) return;
      if (p.f === 'amount' && (map.debit >= 0 || map.credit >= 0) && p.h < 30) return;
      if ((p.f === 'debit' || p.f === 'credit') && map.amount >= 0 && p.h < 38) return;
      map[p.f] = p.c; used[p.c] = 1;
      sure[p.f] = p.h >= 30 && p.sh > 5 ? 'sure' : (p.h >= 30 || p.sh >= 14) ? 'likely' : 'unsure';
    });
    // A lone Debit or Credit column with no partner is really the amount.
    if (map.amount < 0 && (map.debit >= 0) !== (map.credit >= 0)) {
      var one = map.debit >= 0 ? 'debit' : 'credit';
      if (profiles[map[one]].neg) { map.amount = map[one]; sure.amount = 'unsure'; map[one] = -1; sure[one] = 'none'; }
    }
    var unsure = ['date', 'amount', 'description'].some(function (f) { return sure[f] === 'unsure' || (f === 'amount' && map.amount < 0 && map.debit < 0 && map.credit < 0); }) || (!hasHeader);
    return { map: map, sure: sure, shapes: profiles.map(shapeCodes), decimals: decimals, unsure: unsure };
  }
  /** What is still missing before a file can be written, in words. */
  function mappingProblems(map) {
    var out = [];
    if (!(map.date >= 0)) out.push('Choose the date column.');
    if (!(map.amount >= 0) && !(map.debit >= 0) && !(map.credit >= 0)) out.push('Choose the amount column (or the Debit and Credit columns).');
    if (!(map.description >= 0) && !(map.payee >= 0)) out.push('Choose the description or payee column.');
    var seen = {};
    Object.keys(map).forEach(function (k) { var c = map[k]; if (c >= 0) { if (seen[c]) out.push('One column is chosen for two fields.'); seen[c] = 1; } });
    return out;
  }

  // Rows that are not transactions. Strong phrases mark a row whatever else
  // it holds; weak ones only a row with no date.
  var SUMMARY_STRONG = /\b(opening balance|closing balance|balance brought forward|brought forward|carried forward|balance carried forward|balance forward|beginning balance|ending balance|starting balance|previous balance|new balance|available balance|ledger balance|statement balance|end of statement|end of report|statement ends|number of transactions|total debits|total credits|total withdrawals|total deposits|b\/f|c\/f)\b/i;
  var SUMMARY_WEAK = /\b(total|totals|sub ?total|grand total|summary|balance|disclaimer|generated|printed|continued)\b/i;
  var PAGE_LINE = /^\s*(page \d+( of \d+)?|continued( on next page)?|-+\s*page break\s*-+)\s*$/i;
  var OPENING = /\b(opening balance|balance brought forward|brought forward|beginning balance|starting balance|previous balance|b\/f)\b/i;
  var CLOSING = /\b(closing balance|carried forward|balance carried forward|ending balance|new balance|statement balance|c\/f)\b/i;

  function rowText(cells) { return cells.map(function (c) { return line(c, 120); }).filter(Boolean).join(' '); }
  function sameHeader(cells, headers) {
    if (cells.length < 2) return false;
    var a = cells.map(headerNorm).filter(Boolean).join('|'), b = headers.map(headerNorm).filter(Boolean).join('|');
    return Boolean(a) && a === b;
  }
  function customWords(words) {
    var list = (words || []).map(function (w) { return fold(w); }).filter(function (w) { return w.length >= 3; });
    return list.length ? new RegExp('\\b(' + list.map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'); }).join('|') + ')\\b', 'i') : null;
  }

  /** The header row: the first row as wide as the data, mostly words, none
   *  a date, with a header word in it or dates in the row below. Rows above
   *  it are the preamble. Data first means no header. */
  function findHeader(records, width) {
    var lim = Math.min(records.length, 40);
    for (var i = 0; i < lim; i++) {
      var cells = records[i].cells, filled = cells.filter(function (c) { return line(c, 80); });
      var dated = cells.some(looksDate);
      var amounts = cells.filter(function (c) { var a = readAmount(c); return a && !a.error && /\d/.test(c); }).length;
      if (dated && amounts) return { index: -1, preamble: i };
      if (cells.length >= Math.max(2, width - 1) && filled.length >= Math.max(2, Math.ceil(width * 0.5)) && !dated && amounts <= 1) {
        var words = cells.some(function (c) { return MAP_FIELDS.some(function (f) { return headerScore(f, c) >= 30; }); });
        var next = records[i + 1] && records[i + 1].cells.some(looksDate);
        if (words || next) return { index: i, preamble: i };
      }
    }
    return { index: -1, preamble: 0 };
  }

  /* ================================================================== *
   * OFX / QFX and QIF
   * ================================================================== */

  var OFX_AGG = ['OFX', 'SIGNONMSGSRSV1', 'SONRS', 'STATUS', 'FI', 'BANKMSGSRSV1', 'STMTTRNRS', 'STMTRS', 'BANKACCTFROM', 'BANKTRANLIST', 'STMTTRN', 'LEDGERBAL', 'AVAILBAL', 'CREDITCARDMSGSRSV1', 'CCSTMTTRNRS', 'CCSTMTRS', 'CCACCTFROM', 'PAYEE'];
  var DEBIT_TYPES = ['DEBIT', 'PAYMENT', 'CHECK', 'FEE', 'SRVCHG', 'ATM', 'POS', 'DIRECTDEBIT', 'REPEATPMT', 'CASH'];
  var CREDIT_TYPES = ['CREDIT', 'DEP', 'DIRECTDEP', 'INT', 'DIV'];
  var TRNTYPES = DEBIT_TYPES.concat(CREDIT_TYPES, ['XFER', 'OTHER', 'HOLD']);
  var OFX_DATE = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(?:(\d{2})(?:\.\d{1,3})?)?)?(?:\[[+-]?\d{1,2}(?:\.\d{1,2})?(?::[A-Za-z]{1,5})?\])?$/;
  var OFX_AMT = /^[+-]?\d+(\.\d+)?$/;
  function ofxDay(s) { var m = OFX_DATE.exec(str(s).trim()); return m && validYmd(+m[1], +m[2], +m[3]) ? iso(+m[1], +m[2], +m[3]) : null; }
  function unent(s) { return str(s).replace(/&(amp|lt|gt|quot|apos|nbsp|#\d{1,6}|#x[0-9a-f]{1,6});/gi, function (m, e) { var k = e.toLowerCase(); return k === 'amp' ? '&' : k === 'lt' ? '<' : k === 'gt' ? '>' : k === 'quot' ? '"' : k === 'apos' ? "'" : k === 'nbsp' ? ' ' : k.charAt(1) === 'x' ? String.fromCharCode(parseInt(k.slice(2), 16) || 32) : String.fromCharCode(+k.slice(1) || 32); }); }
  function lineIndex(text) { var starts = [0]; for (var i = 0; i < text.length; i++) { var c = text.charCodeAt(i); if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) starts.push(i + 1); } return starts; }
  function lineAt(starts, off) { var lo = 0, hi = starts.length - 1; while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; }

  function looksOfx(text) { var h = text.slice(0, 4000); return /^\s*OFXHEADER\s*:/i.test(h) || /<\?OFX/i.test(h) || (/<OFX>/i.test(text.slice(0, 20000)) && /<(STMTTRN|BANKMSGSRSV1|CREDITCARDMSGSRSV1)>/i.test(text.slice(0, 200000))); }
  function looksQif(text) {
    var first = (/^\s*(\S[^\r\n]*)/.exec(text) || [])[1] || '';
    if (/^!(type|account|option|clear)\b/i.test(first)) return true;
    var ls = text.slice(0, 20000).split(/\r\n|\n|\r/);
    var carets = 0, codes = 0;
    ls.forEach(function (l) { if (/^\^\s*$/.test(l)) carets++; else if (/^[DTUPMNLC]\S/.test(l)) codes++; });
    return carets >= 2 && codes >= carets * 2 && codes >= ls.filter(function (l) { return l.trim(); }).length * 0.6;
  }

  function parseOfx(text) {
    var starts = lineIndex(text);
    var out = { xml: false, header: {}, headerProblems: [], txs: [], acct: null, cc: false, curdef: '', dtstart: '', dtend: '', ledger: null, fi: null, intuBid: '', unclosed: [], amps: [], counts: {} };
    var lt = text.search(/<[A-Za-z?!]/);
    var head = lt >= 0 ? text.slice(0, lt) : text;
    out.xml = /<\?xml|<\?OFX/i.test(text.slice(0, 2000));
    if (out.xml) {
      if (!/<\?OFX[^>]*OFXHEADER\s*=\s*"200"/i.test(text.slice(0, 2000))) out.headerProblems.push({ code: 'pi', line: 1 });
    } else {
      var hl = head.split(/\r\n|\n|\r/);
      var firstReal = -1;
      for (var i = 0; i < hl.length; i++) if (hl[i].trim()) { firstReal = i; break; }
      if (firstReal > 0) out.headerProblems.push({ code: 'lead', line: 1 });
      var lastHeaderLine = 0;
      hl.forEach(function (l, k) {
        if (!l.trim()) return;
        var m = /^(\s*)([A-Za-z]+)(\s*):(\s*)(.*?)\s*$/.exec(l);
        if (!m) { out.headerProblems.push({ code: 'junk', line: k + 1 }); return; }
        if (m[1] || m[3] || m[4]) out.headerProblems.push({ code: 'space', line: k + 1 });
        out.header[m[2].toUpperCase()] = m[5];
        lastHeaderLine = k + 1;
      });
      if (!out.header.OFXHEADER) out.headerProblems.push({ code: 'missing', line: 1 });
      else {
        if (out.header.DATA && out.header.DATA.toUpperCase() !== 'OFXSGML') out.headerProblems.push({ code: 'data', line: lastHeaderLine });
        ['DATA', 'VERSION', 'SECURITY', 'ENCODING', 'CHARSET', 'COMPRESSION', 'OLDFILEUID', 'NEWFILEUID'].forEach(function (k) { if (out.header[k] === undefined) out.headerProblems.push({ code: 'field', field: k, line: lastHeaderLine }); });
        var tailParts = head.split(/\r\n|\n|\r/);
        if (!(tailParts.length >= 3 && !tailParts[tailParts.length - 2].trim() && !tailParts[tailParts.length - 1].trim())) out.headerProblems.push({ code: 'blank', line: lastHeaderLine + 1 });
      }
    }
    var re = /<(\/?)([A-Za-z0-9._]+)(?:\s[^>]*)?>([^<]*)/g, m2, cur = null, opens = {}, closes = {}, inPayee = false, path = [];
    var amp = /&(?!(amp|lt|gt|quot|apos|nbsp|#\d{1,6}|#x[0-9a-f]{1,6});)/i;
    while ((m2 = re.exec(text))) {
      var close = m2[1] === '/', tag = m2[2].toUpperCase(), val = m2[3], at = m2.index;
      var value = val.replace(/\s+$/, '').replace(/^\s+/, '');
      if (OFX_AGG.indexOf(tag) >= 0) {
        if (close) { closes[tag] = (closes[tag] || 0) + 1; if (path[path.length - 1] === tag) path.pop(); else { var pi = path.lastIndexOf(tag); if (pi >= 0) path.length = pi; } }
        else { opens[tag] = (opens[tag] || 0) + 1; path.push(tag); }
        if (tag === 'STMTTRN') {
          if (!close) { if (cur) { out.unclosed.push({ tag: 'STMTTRN', line: cur.line }); out.txs.push(cur); } cur = { line: lineAt(starts, at), f: {} }; }
          else if (cur) { out.txs.push(cur); cur = null; }
        }
        if (tag === 'PAYEE') inPayee = !close;
        if (tag === 'CCACCTFROM' && !close) { out.cc = true; out.acct = out.acct || {}; }
        if (tag === 'BANKACCTFROM' && !close) out.acct = out.acct || {};
        continue;
      }
      if (close) continue;
      if (value && amp.test(value)) out.amps.push(lineAt(starts, at));
      var v = unent(value);
      if (cur) {
        if (inPayee && tag === 'NAME') cur.f.PAYEENAME = v;
        else cur.f[tag] = v;
        continue;
      }
      var inside = path.join('/');
      if (tag === 'CURDEF') out.curdef = v;
      else if (/BANKACCTFROM|CCACCTFROM/.test(inside) && ['BANKID', 'BRANCHID', 'ACCTID', 'ACCTTYPE', 'ACCTKEY'].indexOf(tag) >= 0) { out.acct = out.acct || {}; out.acct[tag] = v; }
      else if (/BANKTRANLIST/.test(inside) && tag === 'DTSTART') out.dtstart = v;
      else if (/BANKTRANLIST/.test(inside) && tag === 'DTEND') out.dtend = v;
      else if (/LEDGERBAL/.test(inside) && tag === 'BALAMT') { out.ledger = out.ledger || {}; out.ledger.amt = v; }
      else if (/LEDGERBAL/.test(inside) && tag === 'DTASOF') { out.ledger = out.ledger || {}; out.ledger.asof = v; }
      else if (/\bFI\b/.test(inside) && (tag === 'ORG' || tag === 'FID')) { out.fi = out.fi || {}; out.fi[tag] = v; }
      else if (tag === 'INTU.BID') out.intuBid = v;
    }
    if (cur) { out.unclosed.push({ tag: 'STMTTRN', line: cur.line }); out.txs.push(cur); }
    OFX_AGG.forEach(function (t) { if ((opens[t] || 0) > (closes[t] || 0) && t !== 'STMTTRN') out.unclosed.push({ tag: t, line: null }); });
    out.counts = { opens: opens, closes: closes };
    return out;
  }

  function parseQif(text) {
    var ls = text.split(/\r\n|\n|\r/);
    var out = { type: '', typeLine: 0, records: [], unknown: 0, noEnd: false, investment: false };
    var cur = null;
    ls.forEach(function (l, k) {
      var n = k + 1;
      if (!l.trim()) return;
      if (/^!/.test(l)) {
        var t = /^!type:\s*(.*)$/i.exec(l.trim());
        if (t && !out.type) { out.type = t[1].trim(); out.typeLine = n; if (/invst/i.test(t[1])) out.investment = true; }
        return;
      }
      if (/^\^/.test(l)) { if (cur) out.records.push(cur); cur = null; return; }
      var code = l.charAt(0), val = l.slice(1);
      if (!cur) cur = { line: n, f: {} };
      if ('DTUPMNLCA'.indexOf(code) >= 0) { if (code === 'A') cur.f.A = (cur.f.A ? cur.f.A + ', ' : '') + val; else if (cur.f[code] === undefined) cur.f[code] = val; }
      else if ('SE$%'.indexOf(code) < 0) out.unknown++;
    });
    if (cur && Object.keys(cur.f).length) { out.records.push(cur); out.noEnd = true; }
    return out;
  }

  /* ================================================================== *
   * The diagnosis
   * ================================================================== */

  // The order findings are drawn in, within a severity: what explains "0
  // rows imported" best first.
  var ORDER = ['binary', 'empty', 'utf16', 'delimiter', 'sep', 'preamble', 'noheader', 'bom', 'cp1252', 'mojibake', 'nul', 'badbytes', 'endings-cr', 'unclosed', 'split', 'pages', 'blank', 'summary', 'ofx-header', 'ofx-account', 'fitid-dup', 'fitid-missing', 'dtposted', 'trnamt', 'unclosed-tag', 'ampersand', 'qif-type', 'dates-bad', 'dates-mixed', 'dates-ambiguous', 'amount-bad', 'amount-missing', 'amount-comma', 'amount-paren', 'amount-trailing', 'amount-crdr', 'amount-symbol', 'amount-thousands', 'both-columns', 'sign-type', 'sign-balance', 'trnamt-sign', 'curdef', 'balance-break', 'opening-closing', 'ragged', 'columns-unsure', 'dates-two', 'dates-text', 'dates-time', 'debit-credit', 'debit-negative', 'duplicates', 'name-long', 'formula', 'stray-quote', 'invisible', 'endings-mixed', 'qif-end', 'qif-unknown', 'balance-ok', 'truncated', 'cut'];

  function finding(key, sev, title, detail, extra) {
    var f = { key: key, sev: sev, title: title, detail: detail || '', lines: [], more: 0, examples: [], fix: null, count: 0 };
    Object.keys(extra || {}).forEach(function (k) { f[k] = extra[k]; });
    if (f.lines.length > LIMITS.lines) { f.more = f.lines.length - LIMITS.lines; f.lines = f.lines.slice(0, LIMITS.lines); }
    if (!f.count) f.count = f.lines.length + f.more;
    return f;
  }
  function linesWord(ls, more) {
    if (!ls.length) return '';
    var shown = ls.slice(0, 6).join(', ');
    var rest = ls.length - 6 + (more || 0);
    return (ls.length === 1 ? 'Line ' : 'Lines ') + shown + (rest > 0 ? ' and ' + groups(rest) + ' more' : '');
  }
  function sortFindings(list) {
    return list.sort(function (a, b) { return SEV.indexOf(a.sev) - SEV.indexOf(b.sev) || ORDER.indexOf(a.key) - ORDER.indexOf(b.key); });
  }

  /** One transaction from a row of a table. */
  function rowTx(rec, map, dec, order, ctx) {
    var cells = rec.cells;
    var cell = function (k) { return map[k] >= 0 && cells[map[k]] !== undefined ? cells[map[k]] : ''; };
    var t = { line: rec.line, rawDate: cell('date'), date: null, rawAmount: '', amount: null, notes: {}, description: line(cell('description'), LIMITS.cell), payee: line(cell('payee'), LIMITS.cell), reference: line(cell('reference'), 120), type: line(cell('type'), 40), balance: null, rawBalance: cell('balance'), problems: [] };
    t.date = readDate(t.rawDate, order, true);
    if (map.amount >= 0) {
      t.rawAmount = cell('amount');
      var a = readAmount(t.rawAmount, dec[map.amount]);
      if (a && !a.error) { t.amount = a.cents; t.notes = a.notes; }
      else if (a && a.error) t.problems.push('amount');
      else t.problems.push('noamount');
    } else {
      var dr = map.debit >= 0 ? readAmount(cell('debit'), dec[map.debit]) : null;
      var cr = map.credit >= 0 ? readAmount(cell('credit'), dec[map.credit]) : null;
      t.rawAmount = [cell('credit'), cell('debit')].filter(function (x) { return line(x, 40); }).join(' / ');
      if ((dr && dr.error) || (cr && cr.error)) t.problems.push('amount');
      else if (!dr && !cr) t.problems.push('noamount');
      else {
        var dv = dr ? dr.cents : 0, cv = cr ? cr.cents : 0;
        if (dv < 0) t.notes.debitNeg = 1;
        if (dv && cv) t.notes.both = 1;
        t.amount = Math.abs(cv) - Math.abs(dv);
        if (cv < 0 && !dv) t.amount = cv;
        Object.keys((dr && dr.notes) || {}).forEach(function (k) { t.notes[k] = 1; });
        Object.keys((cr && cr.notes) || {}).forEach(function (k) { t.notes[k] = 1; });
        t.notes.split = 1;
      }
    }
    if (map.balance >= 0) { var b = readAmount(t.rawBalance, dec[map.balance]); if (b && !b.error) t.balance = b.cents; }
    if (!t.date) t.problems.push(line(t.rawDate, 5) ? 'date' : 'nodate');
    if (ctx) ctx.invisible += (cells.join('').match(BAD) || []).length;
    return t;
  }

  /** The running balance: each row's balance = the one before + its amount
   *  (or, newest first, the other way round). Which model fits best, and the
   *  rows where it breaks - where a dropped row shows up. Amounts that move
   *  the balance the wrong way round are reported as a sign problem. */
  function balanceCheck(txs) {
    var rows = txs.filter(function (t) { return t.balance !== null && t.amount !== null && t.date; });
    if (rows.length < 3) return null;
    var models = { up: 0, down: 0, upInv: 0, downInv: 0 };
    var fits = function (k, i) {
      var a = rows[i - 1], b = rows[i];
      if (k === 'up') return b.balance - a.balance === b.amount;
      if (k === 'down') return a.balance - b.balance === a.amount;
      if (k === 'upInv') return b.balance - a.balance === -b.amount;
      return a.balance - b.balance === -a.amount;
    };
    for (var i = 1; i < rows.length; i++) Object.keys(models).forEach(function (k) { if (fits(k, i)) models[k]++; });
    var best = Object.keys(models).sort(function (x, y) { return models[y] - models[x]; })[0];
    var steps = rows.length - 1;
    if (models[best] < steps * 0.5) return { model: null, rows: rows.length, steps: steps, breaks: [], fit: models[best] };
    var breaks = [];
    for (var j = 1; j < rows.length; j++) {
      if (fits(best, j)) continue;
      // Two rows on one day the bank listed in another order: not a break.
      if (j + 1 < rows.length && rows[j].date === rows[j + 1].date && !fits(best, j + 1)) {
        var a = rows[j - 1], b = rows[j], c = rows[j + 1];
        if (/^up/.test(best) && c.balance - a.balance === (best === 'up' ? 1 : -1) * (b.amount + c.amount)) { j++; continue; }
      }
      var prev = rows[j - 1], here = rows[j];
      var moved = here.balance - prev.balance;
      var expect = best === 'up' ? here.amount : best === 'upInv' ? -here.amount : best === 'down' ? -prev.amount : prev.amount;
      breaks.push({ line: here.line, after: prev.line, gap: moved - expect });
    }
    return { model: best, inverted: /Inv$/.test(best), rows: rows.length, steps: steps, fit: models[best], breaks: breaks, newestFirst: /^down/.test(best) };
  }

  function dupKey(t) { return [t.date, t.amount, fold(t.description), fold(t.payee), fold(t.reference)].join('|'); }
  /** The same date, amount, description, payee and reference twice. Kept and
   *  listed - two coffees on one day are real - never removed silently. */
  function duplicates(txs) {
    var seen = {}, out = [];
    txs.forEach(function (t, i) {
      if (!t.date || t.amount === null) return;
      var k = dupKey(t);
      if (seen[k] !== undefined) out.push({ i: i, line: t.line, of: txs[seen[k]].line });
      else seen[k] = i;
    });
    return out;
  }

  /** Read a statement file and say everything that is wrong with it.
   *  opts: {name, order ('dmy'|'mdy' - the person's answer), dayFirst, words
   *  (extra summary-row words), map (columns chosen by hand or the AI),
   *  flip (true: every sign the other way), repair ({quote, rejoin}: false
   *  reads strictly), currency}. */
  function diagnose(input, opts) {
    opts = opts || {};
    var repair = opts.repair || {};
    var dec = decode(input);
    var st = { name: line(opts.name, 120), bytes: dec.bytes, decoded: { encoding: dec.encoding, bom: dec.bom, utf16NoBom: dec.utf16NoBom, nul: dec.nul, trailingNul: dec.trailingNul, invalid: dec.invalid }, format: 'csv', findings: [], questions: [], txs: [], removed: { preamble: [], summary: [], blank: [], pages: [], sep: [] }, rawRows: {}, currency: '', meta: {} };
    var F = st.findings;
    if (dec.binary) {
      st.format = 'binary';
      var what = { xlsx: ['an Excel workbook (or a zip file)', 'Open it in Excel or Numbers and use Save As / Export to CSV, then check that file.'], xls: ['an old-style Excel workbook (.xls)', 'Open it in Excel and use Save As > CSV, then check that file.'], pdf: ['a PDF', 'Importers need the CSV, OFX or QFX download, not the printable statement. Most banks offer it next to the PDF; Tieout in this lab turns a PDF statement into a CSV.'], image: ['a picture', 'Download the CSV, OFX or QFX file from the bank instead.'], binary: ['not a text file', 'It is not a statement file Feedfix can read - it may be a spreadsheet or a damaged download. Download it again from the bank as CSV, OFX or QFX.'] }[dec.binary];
      F.push(finding('binary', 'blocks', dec.binary === 'binary' ? 'This is not a text file' : 'This is ' + what[0] + ', not a statement file', what[1]));
      return finish(st);
    }
    var text = dec.text;
    if (!text.replace(/[\s\u0000]/g, '')) { st.format = 'empty'; F.push(finding('empty', 'blocks', 'The file is empty', 'There is nothing in it to import. Download it from the bank again.')); return finish(st); }
    // Encoding.
    if (dec.encoding === 'utf-16le' || dec.encoding === 'utf-16be') {
      F.push(finding('utf16', 'blocks', 'Saved as UTF-16, not UTF-8', 'Most importers read UTF-8 or plain ASCII; to them every other byte of this file is a NUL, so they find no columns. Feedfix writes UTF-8.', { lines: [1], fix: 'encoding', examples: [{ line: 1, before: (dec.bom ? '‹FF FE›' : '') + visible(text.split(/\r\n|\n|\r/)[0]).replace(/(.)/g, '$1‹NUL›').slice(0, 120), after: visible(text.split(/\r\n|\n|\r/)[0], 120) }] }));
    } else if (dec.bom) {
      var first = text.split(/\r\n|\n|\r/)[0];
      F.push(finding('bom', 'blocks', 'An invisible byte-order mark before the first column', 'The file starts with three bytes (EF BB BF) that mark it as UTF-8. Many importers keep them as part of the first header, so “' + line(first.split(/[,;\t|]/)[0], 30) + '” no longer matches the column they look for. Feedfix leaves the mark out.', { lines: [1], fix: 'bom', examples: [{ line: 1, before: '‹BOM›' + visible(first, 160), after: visible(first, 160) }] }));
    }
    if (dec.encoding === 'windows-1252') {
      var hi = []; text.split(/\r\n|\n|\r/).some(function (l, k) { if (/[\u0080-\uFFFF]/.test(l)) hi.push(k + 1); return hi.length > LIMITS.lines; });
      st.meta.cp1252 = hi;
    }
    if (dec.invalid) F.push(finding('badbytes', 'wrong', 'Some bytes are not valid UTF-8', groups(dec.invalid) + ' characters could not be read and show as �. The bank’s download may be damaged - try downloading it again.', { count: dec.invalid }));
    var moj = unmojibake(text);
    if (moj.count) {
      var mojLines = [], ex = [];
      text.split(/\r\n|\n|\r/).forEach(function (l, k) { var r = unmojibake(l); if (r.count) { mojLines.push(k + 1); if (ex.length < LIMITS.examples) ex.push({ line: k + 1, before: visible(l, 160), after: visible(r.text, 160) }); } });
      F.push(finding('mojibake', 'wrong', 'Garbled accents and symbols (Ã© for é)', 'The file was saved as UTF-8, read as Windows-1252 and saved again, so accented letters and curly quotes turned into pairs of symbols. Payees then fail to match the ones you already have. Feedfix puts them back.', { lines: mojLines, count: moj.count, fix: 'mojibake', examples: ex }));
      if (opts.undo && opts.undo.mojibake) { /* kept as garbled */ } else text = moj.text;
    }
    if (dec.trailingNul) F.push(finding('nul', 'blocks', 'NUL bytes at the end of the file', groups(dec.trailingNul) + ' zero bytes pad the end. Importers stop or read them as a junk row. Feedfix leaves them out.', { fix: 'nul', count: dec.trailingNul }));
    if (dec.nul && dec.encoding.indexOf('utf-16') < 0) { st.meta.nulInside = dec.nul; }
    text = text.replace(/\u0000/g, '');
    // Line endings.
    var crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/\n/g) || []).length - crlf, cr = (text.match(/\r/g) || []).length - crlf;
    st.endings = { crlf: crlf, lf: lf, cr: cr };
    if (cr && !lf && !crlf) F.push(finding('endings-cr', 'blocks', 'Lines end with a bare carriage return (old Mac style)', 'Many importers see the whole file as one line. Feedfix ends every line with CR LF.', { fix: 'endings' }));
    else if ((crlf ? 1 : 0) + (lf ? 1 : 0) + (cr ? 1 : 0) > 1) F.push(finding('endings-mixed', 'info', 'Mixed line endings', groups(crlf) + ' lines end CR LF, ' + groups(lf + cr) + ' another way - usually a file edited by hand. Feedfix ends every line the same way.', { fix: 'endings' }));
    st.lineCount = lineIndex(text).length - (/(\r\n|\n|\r)$/.test(text) ? 1 : 0);
    st.preview = text.replace(/(\r\n|\n|\r)$/, '').split(/\r\n|\n|\r/).slice(0, LIMITS.preview).map(function (l, k) { return { line: k + 1, text: visible((k === 0 && dec.bom ? '\uFEFF' : '') + l) }; });
    // Format, by content.
    if (looksOfx(text)) { st.format = 'ofx'; diagnoseOfx(st, text, opts); }
    else if (looksQif(text)) { st.format = 'qif'; diagnoseQif(st, text, opts); }
    else diagnoseTable(st, text, opts, repair, dec);
    if (dec.encoding === 'windows-1252' && !(st.format === 'ofx' && /1252|ISO-8859-1|LATIN/i.test(String(st.ofx && st.ofx.header && (st.ofx.header.CHARSET || '')) + ' ' + String(st.ofx && st.ofx.header && st.ofx.header.ENCODING || '')))) {
      var cl = st.meta.cp1252 || [];
      F.push(finding('cp1252', 'wrong', 'Saved as Windows-1252, not UTF-8', 'Accented letters and symbols (é, £, €, curly quotes) are single bytes that an importer reading UTF-8 shows as �. Feedfix writes UTF-8.', { lines: cl, fix: 'encoding', examples: cl.slice(0, 2).map(function (n) { var l = text.split(/\r\n|\n|\r/)[n - 1] || ''; return { line: n, before: visible(l.replace(/[\u0080-\uFFFF]/g, '�'), 160), after: visible(l, 160) }; }) }));
    }
    return finish(st);
  }

  function amountFindings(st, txs, F) {
    var notes = { comma: [], paren: [], trailing: [], crdr: [], symbol: [], thousands: [], minus: [], precision: [] };
    var ex = {};
    txs.forEach(function (t) {
      Object.keys(notes).forEach(function (k) {
        if (t.notes[k]) { notes[k].push(t.line); ex[k] = ex[k] || []; if (ex[k].length < LIMITS.examples) ex[k].push({ line: t.line, before: visible(line(t.rawAmount, 60)), after: plain(t.amount) }); }
      });
    });
    var defs = {
      comma: ['amount-comma', 'wrong', 'Amounts written with a decimal comma (1.234,56)', 'An importer expecting a dot reads 1.234,56 as 1.234 or as 123456. Feedfix writes 1234.56.'],
      paren: ['amount-paren', 'wrong', 'Negative amounts in parentheses', 'Accounting style (84.12) is read as a positive amount, or refused. Feedfix writes -84.12.'],
      trailing: ['amount-trailing', 'wrong', 'A minus sign after the amount (84.12-)', 'Importers read the number and drop the sign, so money out arrives as money in. Feedfix moves the sign to the front.'],
      crdr: ['amount-crdr', 'wrong', 'Amounts marked CR or DR', 'The letters make the amount unreadable to most importers. Feedfix reads DR as money out and CR as money in, and writes plain numbers.'],
      symbol: ['amount-symbol', 'wrong', 'Currency signs inside the amounts', 'Importers often refuse or misread an amount with a $, € or £ in it. Feedfix writes plain numbers.'],
      thousands: ['amount-thousands', 'wrong', 'Thousands separators inside the amounts', 'Some importers stop at the separator and read 1,250.00 as 1. Feedfix writes 1250.00.'],
      minus: ['amount-symbol', 'wrong', 'A typographic minus (−) instead of a hyphen', 'It looks like a minus sign but is a different character, so importers read the amount as text. Feedfix writes a plain hyphen.'],
    };
    Object.keys(defs).forEach(function (k) {
      if (!notes[k].length) return;
      var d = defs[k];
      var exist = F.filter(function (f) { return f.key === d[0]; })[0];
      if (exist) { exist.lines = exist.lines.concat(notes[k]).slice(0, LIMITS.lines); exist.count += notes[k].length; return; }
      F.push(finding(d[0], d[1], d[2], d[3], { lines: notes[k], fix: 'amounts', examples: ex[k] }));
    });
    if (notes.precision.length) F.push(finding('amount-symbol', 'info', 'Amounts with more than two decimals', 'They were rounded to the cent.', { lines: notes.precision, fix: 'amounts' }));
  }

  function dateFindings(st, txs, F, style, order) {
    var bad = txs.filter(function (t) { return t.problems.indexOf('date') >= 0; });
    var none = txs.filter(function (t) { return t.problems.indexOf('nodate') >= 0; });
    if (bad.length) F.push(finding('dates-bad', 'blocks', 'Dates that are not dates', 'An importer refuses the whole file, or skips these rows. Fix the date in the bank’s file, or leave the line out (it is listed).', { lines: bad.map(function (t) { return t.line; }), fix: 'leaveOut', examples: bad.slice(0, LIMITS.examples).map(function (t) { return { line: t.line, before: visible(line(t.rawDate, 40)), after: '(no date)' }; }) }));
    if (none.length) F.push(finding('dates-bad', 'blocks', 'Rows with no date', 'Every transaction needs a date.', { lines: none.map(function (t) { return t.line; }), fix: 'leaveOut' }));
    if (style.order === 'mixed') F.push(finding('dates-mixed', 'wrong', 'Day-first and month-first dates in one column', 'Some dates only make sense as day/month and others only as month/day. Each was read the way that is possible; check the lines listed.', { lines: [], count: style.dmy + style.mdy, fix: 'dates' }));
    else if (style.mixedKinds) F.push(finding('dates-mixed', 'wrong', 'Dates written in more than one format', 'Importers pick one format for the whole column and refuse the rest. Feedfix writes them all one way.', { fix: 'dates', count: txs.length }));
    if (style.two) F.push(style.quicken === style.two ? finding('dates-two', 'info', 'Quicken-style dates (1/31\'26)', 'The apostrophe means a year in the 2000s. Written with four-digit years.', { count: style.two, fix: 'dates' }) : finding('dates-two', 'info', 'Two-digit years', 'Read as 20xx (70 to 99 as 19xx) and written with four digits, so no importer has to guess the century.', { count: style.two, fix: 'dates' }));
    if (style.text) F.push(finding('dates-text', 'info', 'Dates with month names (31 Jan 2026)', 'Written as numbers in the target format, so no importer has to read English month names.', { count: style.text, fix: 'dates' }));
    if (style.time) F.push(finding('dates-time', 'info', 'Dates carry a time', 'Importers want the day only. The time is left out.', { count: style.time, fix: 'dates' }));
    st.dates = { order: order, style: { dmy: style.dmy, mdy: style.mdy, amb: style.amb, order: style.order, two: style.two } };
  }

  function orderStep(st, values, opts, F, mapped) {
    var style = dateStyle(values, mapped);
    var order = style.order === 'dmy' || style.order === 'mdy' ? style.order : null;
    if (style.order === 'ambiguous') {
      var q = orderQuestion(values, opts.dayFirst, mapped);
      order = opts.order === 'dmy' || opts.order === 'mdy' ? opts.order : q.suggestion;
      var wrongWay = 0;
      values.forEach(function (v) { var p = dateParts(v, mapped); if (p && p.kind === 'num' && p.a !== p.b) wrongWay++; });
      st.questions.push({ key: 'order', answered: Boolean(opts.order), chosen: order, suggestion: q.suggestion, why: q.why, dmy: q.dmy, mdy: q.mdy, examples: q.examples, count: wrongWay });
      F.push(finding('dates-ambiguous', opts.order ? 'info' : 'wrong', 'Day and month could be either way round', 'Every date has a day of 12 or under, so 03/04 could be 3 April or March 4. Read the wrong way, ' + plural(wrongWay, 'date') + ' land in the wrong month. ' + (opts.order ? 'You chose ' + (order === 'dmy' ? 'day/month' : 'month/day') + '.' : (q.why === 'in order' ? 'Read as ' + (order === 'dmy' ? 'day/month' : 'month/day') + ' they run in order; the other way they jump about. Check it.' : 'Choose which way round they are.')), { fix: 'dates', count: wrongWay, unit: 'date', question: 'order' }));
    }
    return { style: style, order: order };
  }

  function diagnoseTable(st, text, opts, repair, dec) {
    var F = st.findings;
    var sn = sniffDelimiter(text);
    var delim = sn.delim;
    st.delimiter = DELIMS[delim];
    st.delim = delim;
    var p = readDelimited(text, delim, repair.quote !== false);
    var recs = p.records;
    st.meta.truncated = p.truncated;
    if (p.truncated) F.push(finding('truncated', 'info', 'Only the first ' + groups(LIMITS.rows) + ' rows were read', 'Split the file into smaller periods to check the rest.'));
    if (p.cut) F.push(finding('cut', 'info', 'Very long cells were cut', groups(p.cut) + ' cells were over ' + LIMITS.cell + ' characters and were cut as they were read.', { count: p.cut }));
    if (sn.sep && recs.length) {
      st.removed.sep.push(recs[0].line);
      F.push(finding('sep', 'blocks', 'An Excel “sep=” line above the header', 'Excel writes it to say which delimiter the file uses; importers read it as the header row. Feedfix leaves it out.', { lines: [1], fix: 'sep', examples: [{ line: 1, before: visible(recs[0].raw), after: '(left out)' }] }));
      recs = recs.slice(1);
    }
    if (delim !== ',') {
      var hr = recs[Math.min(recs.length - 1, 0)];
      F.push(finding('delimiter', 'blocks', 'Separated by ' + (delim === '\t' ? 'tabs' : delim === ';' ? 'semicolons' : 'pipes') + ', not commas', 'QuickBooks, Xero and most importers expect commas, so they see each line as one column and find no date or amount. Feedfix writes commas.', { lines: [], count: recs.length, every: true, fix: 'delimiter', examples: recs.filter(function (r) { return r.cells.length > 1; }).slice(0, 1).map(function (r) { return { line: r.line, before: visible(r.raw, 200), after: visible(r.cells.map(function (c) { return csvCell(line(c, LIMITS.cell)); }).join(','), 200) }; }) }));
      void hr;
    }
    if (p.unclosed.length) {
      var strict = parseRecords(text, delim, {});
      F.push(finding('unclosed', 'blocks', 'A quote that never closes', 'A field opens with " and never closes, so a strict reader swallows the lines after it into one cell' + (strict.open ? ' - to the end of the file.' : '.') + ' Feedfix reads that quote as a stray character and leaves it out.', { lines: p.unclosed, fix: 'quote', examples: p.unclosed.slice(0, LIMITS.examples).map(function (n) { var r = recs.filter(function (x) { return x.line === n; })[0]; return { line: n, before: visible((text.split(/\r\n|\n|\r/)[n - 1]) || '', 200), after: r ? visible(r.cells.map(function (c) { return csvCell(line(c, LIMITS.cell)); }).join(','), 200) : '' }; }) }));
    } else if (repair.quote === false && p.strictOpen) {
      st.meta.strictOpen = p.strictOpen;
    }
    if (p.stray.length) F.push(finding('stray-quote', 'info', 'Quote marks inside unquoted fields', 'They are kept as text, but a strict importer may refuse the line. Feedfix writes those fields properly quoted.', { lines: p.stray }));
    var width = modalWidth(recs);
    var hdr = findHeader(recs, width);
    var headers, startAt;
    if (hdr.index >= 0) {
      headers = recs[hdr.index].cells.slice(0, LIMITS.columns).map(function (h, i) { return line(h, LIMITS.headerChars) || 'Column ' + (i + 1); });
      startAt = hdr.index + 1;
    } else {
      headers = []; for (var c = 0; c < Math.min(width, LIMITS.columns); c++) headers.push('Column ' + (c + 1));
      startAt = hdr.preamble;
    }
    var seenH = {};
    headers = headers.map(function (h) { var k = h.toLowerCase(), n = seenH[k] = (seenH[k] || 0) + 1; return n > 1 ? h + ' (' + n + ')' : h; });
    var pre = recs.slice(0, hdr.index >= 0 ? hdr.index : hdr.preamble);
    pre.forEach(function (r) { st.removed.preamble.push(r.line); st.rawRows[r.line] = r.cells; });
    if (pre.length) F.push(finding('preamble', 'blocks', plural(pre.length, 'line') + ' above the header', 'The bank put its name, the account or the period above the column names. Importers expect the header on line 1, so they read these lines as the columns and find no date or amount. Feedfix leaves them out.', { lines: pre.map(function (r) { return r.line; }), fix: 'preamble', examples: pre.slice(0, LIMITS.examples).map(function (r) { return { line: r.line, before: visible(r.raw, 200), after: '(left out)' }; }) }));
    if (hdr.index < 0) F.push(finding('noheader', 'blocks', 'No header row', 'The first row is already a transaction, so an importer takes it for the column names and loses it. Feedfix guessed the columns from their values - check them - and writes a header.', { lines: [recs[startAt] ? recs[startAt].line : 1] }));
    var body = recs.slice(startAt);
    var dataRows = body.filter(function (r) { return r.cells.length >= Math.max(2, width - 1); }).map(function (r) { return r.cells; });
    var g = guessColumns(headers, dataRows.slice(0, 400), hdr.index >= 0);
    var map = g.map;
    if (opts.map && typeof opts.map === 'object') {
      var om = {};
      MAP_FIELDS.forEach(function (f) { var v = opts.map[f]; om[f] = typeof v === 'number' && Math.floor(v) === v && v >= -1 && v < headers.length ? v : -1; });
      map = om;
      MAP_FIELDS.forEach(function (f) { if (map[f] !== g.map[f]) g.sure[f] = map[f] >= 0 ? 'you' : 'none'; });
    }
    st.columns = { headers: headers, map: map, sure: g.sure, shapes: g.shapes, decimals: g.decimals, guessUnsure: g.unsure, hasHeader: hdr.index >= 0, width: width, sample: dataRows.slice(0, 8).map(function (r) { return r.slice(0, LIMITS.columns).map(function (x) { return line(x, 80); }); }), problems: mappingProblems(map) };
    var words = customWords(opts.words);
    // Rows: transactions, or not.
    var kinds = [];
    var lastData = -1;
    var dateCol = map.date;
    var amountCols = ['amount', 'debit', 'credit'].map(function (k) { return map[k]; }).filter(function (x) { return x >= 0; });
    var splitRows = [], ragged = [];
    body.forEach(function (r, i) {
      var cells = r.cells;
      var txt = rowText(cells);
      if (!txt) { kinds.push('blank'); return; }
      if (hdr.index >= 0 && sameHeader(cells, recs[hdr.index].cells)) { kinds.push('pages'); return; }
      if (PAGE_LINE.test(txt)) { kinds.push('pages'); return; }
      // An amount split by an unquoted comma: "1,250.00" written bare.
      if (cells.length > width && delim === ',' && repair.rejoin !== false) {
        var fixedCells = rejoin(cells, width, map);
        if (fixedCells) { splitRows.push({ line: r.line, before: r.raw, cells: fixedCells }); r.cells = cells = fixedCells; }
      }
      if (cells.length !== width && cells.length > 1) ragged.push(r.line);
      var hasDate = dateCol >= 0 && looksDate(cells[dateCol] || '');
      var hasAmt = amountCols.some(function (k) { var a = readAmount(cells[k]); return a && !a.error; });
      if (SUMMARY_STRONG.test(txt) || (words && words.test(fold(txt)))) { kinds.push('summary'); return; }
      if (!hasDate && (SUMMARY_WEAK.test(txt) || !hasAmt)) { kinds.push(hasAmt || SUMMARY_WEAK.test(txt) || cells.length <= 2 ? 'summary' : 'data'); if (kinds[kinds.length - 1] === 'data') lastData = i; return; }
      kinds.push('data'); lastData = i;
    });
    // After the last transaction everything is footer.
    kinds = kinds.map(function (k, i) { return i > lastData && k === 'data' ? 'summary' : k; });
    var txs = [], ctx = { invisible: 0 };
    var dateValues = [];
    body.forEach(function (r, i) {
      var k = kinds[i];
      if (k !== 'data') { st.removed[k].push(r.line); st.rawRows[r.line] = r.cells; return; }
      dateValues.push(dateCol >= 0 ? (r.cells[dateCol] || '') : '');
    });
    var os = orderStep(st, dateValues, opts, F, true);
    body.forEach(function (r, i) { if (kinds[i] === 'data') { var t = rowTx(r, map, g.decimals, os.order, ctx); t.raw = r.raw; st.rawRows[r.line] = r.cells; txs.push(t); } });
    // Opening and closing balances stated in summary rows.
    body.forEach(function (r, i) {
      if (kinds[i] !== 'summary') return;
      var txt = rowText(r.cells), amt = null;
      for (var c2 = r.cells.length - 1; c2 >= 0; c2--) { var a = readAmount(r.cells[c2], map.balance >= 0 ? g.decimals[map.balance] : (amountCols.length ? g.decimals[amountCols[0]] : undefined)); if (a && !a.error) { amt = a.cents; break; } }
      if (amt === null) return;
      if (OPENING.test(txt) && st.meta.opening === undefined) st.meta.opening = amt;
      else if (CLOSING.test(txt)) st.meta.closing = amt;
    });
    if (splitRows.length) F.push(finding('split', 'blocks', 'Amounts split in two by an unquoted comma', 'An amount like 1,250.00 was written without quotes, so its comma splits it into two fields and the row has one field too many. Importers refuse the row or read 1 and 250.00. Feedfix joins them again.', { lines: splitRows.map(function (s) { return s.line; }), fix: 'rejoin', examples: splitRows.slice(0, LIMITS.examples).map(function (s) { return { line: s.line, before: visible(s.before, 200), after: visible(s.cells.map(function (c3) { return csvCell(line(c3, LIMITS.cell)); }).join(','), 200) }; }) }));
    if (ragged.length) F.push(finding('ragged', 'wrong', 'Rows with a different number of fields', 'The header has ' + width + ' fields and these rows do not. An importer may shift their columns. Feedfix writes every row the same width; check them.', { lines: ragged }));
    var rem = st.removed;
    if (rem.pages.length) F.push(finding('pages', 'blocks', plural(rem.pages.length, 'page-break line'), 'The header repeats, or a “Page 2 of 3” line sits, where a printed page would end. An importer reads them as transactions with “Date” as the date and stops. Feedfix leaves them out.', { lines: rem.pages, fix: 'pages', examples: rem.pages.slice(0, LIMITS.examples).map(function (n) { return { line: n, before: visible(body.filter(function (r) { return r.line === n; })[0].raw, 200), after: '(left out)' }; }) }));
    if (rem.blank.length) F.push(finding('blank', 'wrong', plural(rem.blank.length, 'blank row'), 'Some importers stop reading at the first blank row, so everything after it never arrives. Feedfix leaves them out.', { lines: rem.blank, fix: 'blank', examples: rem.blank.slice(0, 1).map(function (n) { return { line: n, before: visible(body.filter(function (r) { return r.line === n; })[0].raw || '', 200) || '(empty)', after: '(left out)' }; }) }));
    if (rem.summary.length) F.push(finding('summary', 'wrong', plural(rem.summary.length, 'summary row', 'summary rows') + ' among the transactions', 'Opening and closing balances, totals and “End of statement” lines are not transactions. Imported, a closing balance becomes a deposit and the books no longer reconcile. Feedfix leaves them out' + (st.meta.closing !== undefined || st.meta.opening !== undefined ? ', and uses the balances to check the rows add up.' : '.'), { lines: rem.summary, fix: 'summary', examples: rem.summary.slice(0, LIMITS.examples).map(function (n) { return { line: n, before: visible(body.filter(function (r) { return r.line === n; })[0].raw, 200), after: '(left out)' }; }) }));
    if (st.columns.problems.length) F.push(finding('columns-unsure', 'blocks', 'Feedfix needs a column chosen', st.columns.problems.join(' '), { question: 'columns' }));
    else if (g.unsure && !opts.map) F.push(finding('columns-unsure', 'info', 'Check which column is which', 'Feedfix is not sure of every column from the header names - check them below, or ask the AI helper (it sees the column names, never a value).', { question: 'columns' }));
    if (ctx.invisible) F.push(finding('invisible', 'info', 'Invisible characters inside cells', groups(ctx.invisible) + ' zero-width, direction or control characters were found. They can make two payees look alike while an importer sees them as different. Feedfix leaves them out.', { count: ctx.invisible, fix: 'invisible' }));
    finishTxs(st, txs, opts, F, os);
  }

  /** Two adjacent fields that are one amount split at its thousands comma -
   *  "1" and "250.00" - joined while the row is too wide. Only where the
   *  joined field lands in an amount or balance column. */
  function rejoin(cells, width, map) {
    var out = cells.slice(), money = ['amount', 'debit', 'credit', 'balance'].map(function (k) { return map[k]; }).filter(function (x) { return x >= 0; });
    var guard = 0;
    while (out.length > width && guard++ < 8) {
      var done = false;
      for (var k = 0; k < out.length - 1; k++) {
        if (/^\s*[-(]?\s*[$€£]?\s*\d{1,3}\s*$/.test(out[k]) && /^\d{3}(\.\d{1,2})?\)?-?\s*$/.test(out[k + 1])) {
          var target = k;
          if (!money.length || money.indexOf(target) >= 0 || money.indexOf(target + (out.length - width) - 1) >= 0) { out.splice(k, 2, out[k] + ',' + out[k + 1]); done = true; break; }
        }
      }
      if (!done) return null;
    }
    return out.length === width ? out : null;
  }

  /** Signs, the running balance, duplicates, totals: everything after the
   *  rows are read, whatever the format. */
  function finishTxs(st, txs, opts, F, os) {
    var ex = function (list, f) { return list.slice(0, LIMITS.examples).map(f); };
    amountFindings(st, txs, F);
    dateFindings(st, txs, F, os.style, os.order);
    var badAmt = txs.filter(function (t) { return t.problems.indexOf('amount') >= 0; });
    var noAmt = txs.filter(function (t) { return t.problems.indexOf('noamount') >= 0; });
    if (badAmt.length) F.push(finding('amount-bad', 'blocks', 'Amounts that are not numbers', 'An importer refuses these rows. Fix the amount in the bank’s file, or leave the line out (it is listed).', { lines: badAmt.map(function (t) { return t.line; }), fix: 'leaveOut', examples: ex(badAmt, function (t) { return { line: t.line, before: visible(line(t.rawAmount, 40)), after: '(no amount)' }; }) }));
    if (noAmt.length) F.push(finding('amount-missing', 'blocks', 'Rows with no amount', 'Every transaction needs an amount.', { lines: noAmt.map(function (t) { return t.line; }), fix: 'leaveOut' }));
    var split = txs.filter(function (t) { return t.notes.split; });
    if (split.length) F.push(finding('debit-credit', 'info', 'Money in and money out are in separate columns', 'For a one-amount target they are combined: money in positive, money out negative.', { count: split.length }));
    var dneg = txs.filter(function (t) { return t.notes.debitNeg; });
    if (dneg.length) F.push(finding('debit-negative', 'info', 'Debits already written as negative numbers', 'Read as money out either way, so nothing is counted twice.', { lines: dneg.map(function (t) { return t.line; }) }));
    var both = txs.filter(function (t) { return t.notes.both; });
    if (both.length) F.push(finding('both-columns', 'wrong', 'Rows with both a debit and a credit', 'Feedfix takes the difference. Check these lines.', { lines: both.map(function (t) { return t.line; }) }));
    // Signs: from a type column when every amount is positive...
    var flipped = [];
    var typed = st.columns && st.columns.map.type >= 0 && txs.length && txs.every(function (t) { return t.amount === null || t.amount >= 0; });
    if (typed) {
      txs.forEach(function (t) { if (t.amount && TYPE_OUT.test(t.type)) { t.amount = -t.amount; t.flipped = 'type'; flipped.push(t.line); } });
      if (flipped.length) F.push(finding('sign-type', 'wrong', 'Every amount is positive; the Type column says which way', plural(flipped.length, 'row') + ' marked as a debit or withdrawal would import as money in. Feedfix makes them negative.', { lines: flipped, fix: 'signs', examples: ex(txs.filter(function (t) { return t.flipped; }), function (t) { return { line: t.line, before: visible(line(t.type, 20) + ' ' + line(t.rawAmount, 30)), after: plain(t.amount) }; }) }));
    }
    // ...or row by row from the running balance, when every amount is
    // positive and nothing else says which way each one went.
    if (!flipped.length && txs.length >= 3 && txs.every(function (t) { return t.amount === null || t.amount >= 0; })) {
      var br = txs.filter(function (t) { return t.balance !== null && t.amount !== null && t.date; });
      if (br.length >= 3) {
        var upFit = 0, downFit = 0;
        for (var bi = 1; bi < br.length; bi++) {
          if (Math.abs(br[bi].balance - br[bi - 1].balance) === br[bi].amount) upFit++;
          if (Math.abs(br[bi - 1].balance - br[bi].balance) === br[bi - 1].amount) downFit++;
        }
        if (Math.max(upFit, downFit) >= (br.length - 1) * 0.8) {
          var upward = upFit >= downFit, changed = [], unsureRow = [];
          br.forEach(function (t, k) {
            var other = upward ? br[k - 1] : br[k + 1];
            var delta = other ? t.balance - other.balance : (st.meta.opening !== undefined ? t.balance - st.meta.opening : null);
            if (delta === null) { unsureRow.push(t.line); return; }
            if (Math.abs(delta) === t.amount && delta < 0) { t.amount = -t.amount; t.flipped = 'balance'; changed.push(t.line); }
          });
          if (changed.length) F.push(finding('sign-balance', 'wrong', 'Every amount is positive; the balance shows which way each went', plural(changed.length, 'row') + ' lower the balance, so they are money out - imported as they are, they would be money in. Feedfix makes them negative.' + (unsureRow.length ? ' ' + linesWord(unsureRow) + ' could not be told from the balance - check ' + (unsureRow.length === 1 ? 'it' : 'them') + '.' : ''), { lines: changed, fix: 'signs' }));
        }
      }
    }
    // ...then from the running balance as a whole.
    var bal = balanceCheck(txs);
    if (bal && bal.inverted && bal.fit >= bal.steps * 0.8) {
      txs.forEach(function (t) { if (t.amount) { t.amount = -t.amount; t.flipped = 'balance'; } });
      bal = balanceCheck(txs);
      F.push(finding('sign-balance', 'wrong', 'The amounts move the balance the wrong way round', 'The running balance goes down where an amount is positive - a card statement, where a purchase is positive. Imported as it is, every purchase would be money in. Feedfix flips every sign.', { count: txs.length, fix: 'signs' }));
    }
    // "Undo" on the sign fix: the findings stay, the amounts go back.
    if (opts.noSigns && txs.some(function (t) { return t.flipped; })) { txs.forEach(function (t) { if (t.flipped) { t.amount = -t.amount; t.flipped = null; } }); bal = balanceCheck(txs); }
    if (opts.flip === true) txs.forEach(function (t) { if (t.amount) { t.amount = -t.amount; t.flipped = t.flipped ? null : 'manual'; } });
    st.balance = bal ? { model: bal.model, newestFirst: bal.newestFirst, rows: bal.rows, breaks: bal.breaks.slice(0, LIMITS.lines), breakCount: bal.breaks.length, fit: bal.fit, steps: bal.steps } : null;
    var cur = st.currency;
    if (bal && bal.model) {
      if (bal.breaks.length) F.push(finding('balance-break', 'wrong', 'The running balance breaks - a row may be missing', bal.breaks.slice(0, 3).map(function (b) { return 'Line ' + b.line + ': the balance moves ' + money(Math.abs(b.gap), cur) + (b.gap > 0 ? ' more' : ' less') + ' than the amounts say, so a row may be missing between line ' + b.after + ' and line ' + b.line + '.'; }).join(' ') + ' Check the bank’s statement for these dates - a file fix cannot bring a missing row back.', { lines: bal.breaks.map(function (b) { return b.line; }), carried: true }));
      else F.push(finding('balance-ok', 'info', 'Every balance follows from the row above', 'The balance column was checked row by row' + (bal.newestFirst ? ' (newest first)' : '') + ': nothing is missing in between.', { count: bal.rows, ok: true }));
    }
    // Opening + the rows = closing.
    var sum = 0; txs.forEach(function (t) { if (t.amount !== null && !t.problems.length) sum += t.amount; });
    var o = st.meta.opening, c = st.meta.closing;
    if (o === undefined && c !== undefined && bal && bal.model && txs.length) {
      var firstRow = bal.newestFirst ? txs[txs.length - 1] : txs[0];
      if (firstRow.balance !== null && firstRow.amount !== null) o = firstRow.balance - firstRow.amount;
    }
    if (o !== undefined && c !== undefined) {
      st.meta.tie = { opening: o, closing: c, net: sum, ok: o + sum === c };
      if (o + sum === c) F.push(finding('opening-closing', 'info', 'Opening balance + the rows = the closing balance', money(o, cur) + ' + ' + money(sum, cur) + ' = ' + money(c, cur) + '. Every transaction is accounted for.', { ok: true }));
      else F.push(finding('opening-closing', 'wrong', 'The rows do not add up to the closing balance', 'Opening ' + money(o, cur) + ' + the rows ' + money(sum, cur) + ' = ' + money(o + sum, cur) + ', but the statement says ' + money(c, cur) + ' - ' + money(Math.abs(c - o - sum), cur) + ' is unaccounted for. A row may be missing.', { carried: true }));
    }
    // Text a spreadsheet would run as a formula. Harmless to an importer,
    // but the CSV gets opened in Excel on the way.
    var formulaRows = txs.filter(function (t) { return [t.description, t.payee, t.reference].some(function (v) { return /^[=+\-@]/.test(str(v)); }); });
    if (formulaRows.length) F.push(finding('formula', 'info', 'Cells a spreadsheet would run as a formula', 'A payee or description starting with = + - or @ is run as a formula when the file is opened in Excel or Sheets - a known way to smuggle a link or a command into a spreadsheet. In a CSV target Feedfix puts an apostrophe in front, and the report says so.', { lines: formulaRows.map(function (t) { return t.line; }), examples: formulaRows.slice(0, 2).map(function (t) { var v = [t.description, t.payee, t.reference].filter(function (x) { return /^[=+\-@]/.test(str(x)); })[0]; return { line: t.line, before: visible(v, 80), after: visible("'" + v, 80) }; }) }));
    var dups = duplicates(txs);
    st.dups = dups.slice(0, LIMITS.duplicates).map(function (d) { var t = txs[d.i]; return { line: d.line, of: d.of, date: t.date, amount: t.amount, description: t.description, payee: t.payee, reference: t.reference }; });
    if (dups.length) F.push(finding('duplicates', 'info', plural(dups.length, 'possible duplicate'), 'The same date, amount and description appear more than once. Two coffees on one day are real, so they are kept - and listed in the duplicates report, so you can check them against the bank.', { lines: dups.map(function (d) { return d.line; }), fix: 'duplicates', carried: true, examples: dups.slice(0, LIMITS.examples).map(function (d) { var t = txs[d.i]; return { line: d.line, before: 'Line ' + d.of + ' and line ' + d.line, after: (t.date || '') + ' · ' + plain(t.amount) + ' · ' + line(t.description || t.payee, 60) }; }) }));
    st.txs = txs;
  }

  function diagnoseOfx(st, text, opts) {
    var F = st.findings;
    var o = parseOfx(text);
    st.ofx = { xml: o.xml, header: o.header, acct: o.acct, cc: o.cc, curdef: o.curdef, dtstart: o.dtstart, dtend: o.dtend, ledger: o.ledger, fi: o.fi, intuBid: o.intuBid, version: o.header.VERSION || (o.xml ? '2xx' : '') };
    st.currency = /^[A-Z]{3}$/.test(o.curdef) ? o.curdef : '';
    var tl = text.split(/\r\n|\n|\r/);
    if (o.headerProblems.length) {
      var words = { blank: 'no blank line between the header and <OFX>', lead: 'blank lines or spaces before OFXHEADER', space: 'spaces around a header’s colon', missing: 'no OFXHEADER line', data: 'DATA is not OFXSGML', field: 'a header line missing', junk: 'a line that is not a header', pi: 'no <?OFX ... ?> line' };
      var codes = []; o.headerProblems.forEach(function (h) { var w = h.code === 'field' ? 'no ' + h.field + ' line' : words[h.code]; if (codes.indexOf(w) < 0) codes.push(w); });
      var hp = o.headerProblems[0];
      var lastHead = 0; for (var k = 0; k < tl.length && k < 30; k++) { if (/^\s*<OFX>/i.test(tl[k])) { lastHead = k; break; } }
      F.push(finding('ofx-header', 'blocks', 'The OFX header is not what strict readers expect', 'Found: ' + codes.join('; ') + '. QuickBooks Desktop and other strict SGML readers refuse the file before reading a single transaction. Feedfix writes a clean OFX 1.0.2 header.', { lines: o.headerProblems.map(function (h) { return h.line; }).filter(function (x, i, a) { return x && a.indexOf(x) === i; }), fix: 'ofxheader', examples: [{ line: hp.line, before: tl.slice(Math.max(0, lastHead - 1), lastHead + 1).map(function (l) { return visible(l, 80); }).join(' ⏎ '), after: hp.code === 'blank' ? visible(tl[Math.max(0, lastHead - 1)] || '', 80) + ' ⏎ (blank line) ⏎ ' + visible(tl[lastHead] || '', 80) : 'OFXHEADER:100 ⏎ DATA:OFXSGML ⏎ VERSION:102 ⏎ … ⏎ (blank line) ⏎ <OFX>' }] }));
    }
    if (!o.acct || !o.acct.ACCTID) F.push(finding('ofx-account', 'blocks', 'No account in the file', 'There is no BANKACCTFROM or CCACCTFROM with an ACCTID, so the importer cannot tell which account the transactions belong to. For an OFX file, type the account in the fix; a CSV target does not need it.', { fix: 'account' }));
    if (!st.currency) F.push(finding('curdef', 'wrong', 'No currency (CURDEF)', 'Importers assume their own currency. Feedfix writes the one you choose.', { fix: 'account' }));
    if (o.unclosed.length) F.push(finding('unclosed-tag', 'blocks', 'Sections that never close', o.unclosed.map(function (u) { return '<' + u.tag + '>'; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join(', ') + ' open and never close. A strict reader stops there. Feedfix writes every section closed.', { lines: o.unclosed.map(function (u) { return u.line; }).filter(Boolean), fix: 'ofxheader' }));
    if (o.amps.length) F.push(finding('ampersand', o.xml ? 'blocks' : 'wrong', 'A bare & in a name', 'In OFX an ampersand must be written &amp;. ' + (o.xml ? 'An XML reader stops at the first one.' : 'Strict readers stop or cut the name there.') + ' Feedfix escapes them.', { lines: o.amps, fix: 'escape', examples: o.amps.slice(0, 2).map(function (n) { return { line: n, before: visible(tl[n - 1], 120), after: visible(tl[n - 1].replace(/&(?!(amp|lt|gt|quot|apos|nbsp|#\d{1,6}|#x[0-9a-f]{1,6});)/gi, '&amp;'), 120) }; }) }));
    var ctx = { invisible: 0 };
    var raws = o.txs;
    if (raws.length > LIMITS.rows) { raws = raws.slice(0, LIMITS.rows); F.push(finding('truncated', 'info', 'Only the first ' + groups(LIMITS.rows) + ' transactions were read', 'Split the file into smaller periods to check the rest.')); }
    var amtStyle = amountStyle(raws.map(function (r) { return r.f.TRNAMT || ''; }));
    var badDt = [], badAmt = [], fitidSeen = {}, fitidDup = [], fitidMissing = [], typeSign = [], longName = [];
    var dtVals = raws.map(function (r) { return r.f.DTPOSTED || ''; });
    var loose = dtVals.filter(function (v) { return !ofxDay(v); });
    var os = orderStep(st, loose, opts, F, false);
    var txs = raws.map(function (r) {
      var f = r.f;
      var t = { line: r.line, rawDate: f.DTPOSTED || '', date: ofxDay(f.DTPOSTED), rawAmount: f.TRNAMT || '', amount: null, notes: {}, payee: line(f.NAME || f.PAYEENAME || '', LIMITS.cell), description: line(f.MEMO || '', LIMITS.cell), reference: line(f.CHECKNUM || f.REFNUM || '', 120), type: line(f.TRNTYPE || '', 20).toUpperCase(), fitid: line(f.FITID || '', LIMITS.fitid), balance: null, problems: [] };
      ctx.invisible += ((f.NAME || '') + (f.MEMO || '')).match(BAD) ? ((f.NAME || '') + (f.MEMO || '')).match(BAD).length : 0;
      if (!t.date) {
        var d2 = readDate(f.DTPOSTED, os.order, true);
        if (d2) { t.date = d2; badDt.push(t.line); } else t.problems.push(f.DTPOSTED ? 'date' : 'nodate');
      }
      var a = readAmount(f.TRNAMT, amtStyle);
      if (a && !a.error) { t.amount = a.cents; if (!OFX_AMT.test(str(f.TRNAMT).trim())) badAmt.push({ line: t.line, raw: f.TRNAMT, cents: a.cents }); }
      else t.problems.push(a ? 'amount' : 'noamount');
      if (!t.fitid) fitidMissing.push(t.line);
      else if (fitidSeen[t.fitid]) fitidDup.push({ line: t.line, of: fitidSeen[t.fitid], fitid: t.fitid }); else fitidSeen[t.fitid] = t.line;
      if (t.amount && ((t.amount > 0 && DEBIT_TYPES.indexOf(t.type) >= 0) || (t.amount < 0 && CREDIT_TYPES.indexOf(t.type) >= 0))) typeSign.push(t.line);
      if (str(f.NAME).length > LIMITS.ofxName) longName.push(t.line);
      return t;
    });
    if (badDt.length) F.push(finding('dtposted', 'blocks', 'DTPOSTED dates not in OFX form', 'OFX dates are written YYYYMMDD (20261031). Readers refuse anything else. Feedfix rewrites them.', { lines: badDt, fix: 'dates', examples: txs.filter(function (t) { return badDt.indexOf(t.line) >= 0; }).slice(0, 2).map(function (t) { return { line: t.line, before: '<DTPOSTED>' + visible(t.rawDate), after: '<DTPOSTED>' + t.date.replace(/-/g, '') + '120000' }; }) }));
    if (badAmt.length) F.push(finding('trnamt', 'blocks', 'TRNAMT amounts not written as plain numbers', 'OFX amounts are written like -45.90 - no commas, signs at the front. Feedfix rewrites them.', { lines: badAmt.map(function (b) { return b.line; }), fix: 'amounts', examples: badAmt.slice(0, 2).map(function (b) { return { line: b.line, before: '<TRNAMT>' + visible(b.raw), after: '<TRNAMT>' + plain(b.cents) }; }) }));
    if (fitidDup.length) {
      var lost = 0; fitidDup.forEach(function (d) { var t = txs.filter(function (x) { return x.line === d.line; })[0]; if (t && t.amount !== null) lost += Math.abs(t.amount); });
      F.push(finding('fitid-dup', 'blocks', plural(fitidDup.length, 'transaction') + ' reuse' + (fitidDup.length === 1 ? 's' : '') + ' another’s FITID', 'Every OFX transaction carries an id (FITID) that importers use to skip what they have seen before. Two transactions with one id: the second is skipped as already imported, with no error - ' + money(lost, st.currency) + ' never arrives. Feedfix gives each a unique id and keeps the ones that were already unique.', { lines: fitidDup.map(function (d) { return d.line; }), fix: 'fitid', examples: fitidDup.slice(0, LIMITS.examples).map(function (d) { return { line: d.line, before: 'line ' + d.of + ': <FITID>' + visible(d.fitid, 60) + '\nline ' + d.line + ': <FITID>' + visible(d.fitid, 60), after: 'line ' + d.of + ': <FITID>' + visible(d.fitid, 60) + '  (kept)\nline ' + d.line + ': <FITID>' + visible(uniqueFitid(d.fitid, 2), 60) }; }) }));
    }
    if (fitidMissing.length) F.push(finding('fitid-missing', 'blocks', plural(fitidMissing.length, 'transaction') + ' with no FITID', 'Importers skip, or refuse, a transaction with no id. Feedfix gives each one a stable id made from its date, amount and name, so importing the fixed file twice does not duplicate it.', { lines: fitidMissing, fix: 'fitid' }));
    // Every amount positive: the bank left the signs out and TRNTYPE says
    // which way. Otherwise a few disagree: the amount is the bank's money,
    // so the type is rewritten to match it.
    var allPos = txs.length && txs.every(function (t) { return t.amount === null || t.amount >= 0; });
    var debits = txs.filter(function (t) { return t.amount > 0 && DEBIT_TYPES.indexOf(t.type) >= 0; });
    if (allPos && debits.length) {
      debits.forEach(function (t) { t.amount = -t.amount; t.flipped = 'type'; });
      F.push(finding('sign-type', 'wrong', 'Every TRNAMT is positive; TRNTYPE says which are money out', plural(debits.length, 'debit') + ' would import as money in. Feedfix makes them negative.', { lines: debits.map(function (t) { return t.line; }), fix: 'signs' }));
    } else if (typeSign.length) F.push(finding('trnamt-sign', 'info', 'The type and the sign disagree', plural(typeSign.length, 'transaction') + (typeSign.length === 1 ? ' has' : ' have') + ' a sign that disagrees with its type - a debit with a positive amount, or a credit with a negative one. The amount is kept as the bank wrote it and the type is rewritten to match.', { lines: typeSign, fix: 'retype' }));
    if (longName.length) F.push(finding('name-long', 'info', 'Payee names over 32 characters', 'OFX 1.0.2 allows 32 characters in NAME, and some importers refuse longer ones. Feedfix cuts NAME at 32 and keeps the whole name at the start of MEMO.', { lines: longName, fix: 'namelen' }));
    if (ctx.invisible) F.push(finding('invisible', 'info', 'Invisible characters inside names', groups(ctx.invisible) + ' zero-width, direction or control characters were found and are left out.', { count: ctx.invisible, fix: 'invisible' }));
    if (o.ledger && o.ledger.amt !== undefined) { var lb = readAmount(o.ledger.amt, amtStyle); if (lb && !lb.error) st.meta.closing = lb.cents; }
    st.columns = null;
    finishTxs(st, txs, opts, F, os);
  }

  function diagnoseQif(st, text, opts) {
    var F = st.findings;
    var q = parseQif(text);
    st.qif = { type: q.type, records: q.records.length };
    if (!q.type) F.push(finding('qif-type', 'blocks', 'No !Type header', 'A QIF file must start with a line like !Type:Bank so the importer knows what account it is. Without it most refuse the file. Converting it to a target below makes the header unnecessary.', { lines: [1], examples: [{ line: 1, before: visible(text.split(/\r\n|\n|\r/)[0], 80), after: '!Type:Bank ⏎ ' + visible(text.split(/\r\n|\n|\r/)[0], 60) }] }));
    if (q.investment) F.push(finding('qif-type', 'wrong', 'An investment QIF', 'Only the cash amount of each entry is read - quantities and prices are not part of a bank statement import.'));
    if (q.noEnd) F.push(finding('qif-end', 'info', 'The last entry has no closing ^', 'It is read anyway.'));
    if (q.unknown) F.push(finding('qif-unknown', 'info', 'Lines Feedfix does not read', groups(q.unknown) + ' lines with codes other than D, T, U, P, M, N, L, C and A are skipped.'));
    var recs = q.records.slice(0, LIMITS.rows);
    var dvals = recs.map(function (r) { return r.f.D || ''; });
    var os = orderStep(st, dvals, opts, F, true);
    var amtStyle = amountStyle(recs.map(function (r) { return r.f.T || r.f.U || ''; }));
    var ctx = { invisible: 0 };
    var txs = recs.map(function (r) {
      var f = r.f;
      var t = { line: r.line, rawDate: f.D || '', date: readDate(f.D, os.order, true), rawAmount: f.T !== undefined ? f.T : (f.U || ''), amount: null, notes: {}, payee: line(f.P || '', LIMITS.cell), description: line(f.M || '', LIMITS.cell), reference: line(f.N || '', 120), type: '', balance: null, problems: [] };
      var a = readAmount(t.rawAmount, amtStyle);
      if (a && !a.error) { t.amount = a.cents; t.notes = a.notes; } else t.problems.push(a ? 'amount' : 'noamount');
      if (!t.date) t.problems.push(line(f.D, 3) ? 'date' : 'nodate');
      ctx.invisible += ((f.P || '') + (f.M || '')).match(BAD) ? ((f.P || '') + (f.M || '')).match(BAD).length : 0;
      return t;
    });
    if (ctx.invisible) F.push(finding('invisible', 'info', 'Invisible characters inside names', groups(ctx.invisible) + ' zero-width, direction or control characters were found and are left out.', { count: ctx.invisible, fix: 'invisible' }));
    st.columns = null;
    finishTxs(st, txs, opts, F, os);
  }

  function totals(txs) {
    var t = { rows: 0, inCents: 0, outCents: 0, net: 0, first: null, last: null, unread: 0 };
    txs.forEach(function (x) {
      t.rows++;
      if (x.amount === null || x.amount === undefined) { t.unread++; return; }
      if (x.amount > 0) t.inCents += x.amount; else t.outCents += -x.amount;
      if (x.date) { if (!t.first || x.date < t.first) t.first = x.date; if (!t.last || x.date > t.last) t.last = x.date; }
    });
    t.net = t.inCents - t.outCents;
    return t;
  }
  function verdict(st) {
    var n = { blocks: 0, wrong: 0, info: 0 };
    st.findings.forEach(function (f) { if (!f.ok) n[f.sev]++; });
    var bits = [];
    if (n.blocks) bits.push(n.blocks + (n.blocks === 1 ? ' stops an import' : ' stop an import'));
    if (n.wrong) bits.push(n.wrong + ' would import wrong');
    if (n.info) bits.push(n.info + ' worth knowing');
    return { blocks: n.blocks, wrong: n.wrong, info: n.info, line: bits.length ? bits.join(' · ') : 'Nothing found that would stop or spoil an import', clean: !n.blocks && !n.wrong };
  }
  function finish(st) {
    sortFindings(st.findings);
    st.totals = totals(st.txs);
    st.verdict = verdict(st);
    if (!st.currency) {
      var syms = {};
      st.txs.slice(0, 200).forEach(function (t) { var s = t.notes && (t.notes.symbol || t.notes.code); if (typeof s === 'string') syms[s] = (syms[s] || 0) + 1; });
      st.currency = Object.keys(syms).sort(function (a, b) { return syms[b] - syms[a]; })[0] || '';
    }
    return st;
  }

  /** What the page needs from a diagnosis: no internal rows, a bounded
   *  sample. Everything still stays on the device. */
  function view(st) {
    return {
      name: st.name, bytes: st.bytes, format: st.format, decoded: st.decoded, delimiter: st.delimiter || null, endings: st.endings || null, lineCount: st.lineCount || 0,
      findings: st.findings, questions: st.questions, verdict: st.verdict, totals: st.totals, currency: st.currency,
      columns: st.columns, balance: st.balance, dates: st.dates || null, dups: st.dups || [], ofx: st.ofx || null, qif: st.qif || null, meta: { tie: st.meta.tie || null, opening: st.meta.opening, closing: st.meta.closing },
      preview: st.preview || [], removed: { preamble: st.removed.preamble.length, summary: st.removed.summary.length, blank: st.removed.blank.length, pages: st.removed.pages.length, sep: st.removed.sep.length },
      sampleTx: st.txs.slice(0, 8).map(function (t) { return { line: t.line, date: t.date, amount: t.amount, description: t.description, payee: t.payee, reference: t.reference }; }),
    };
  }

  /* ================================================================== *
   * The fix: target profiles, writers, the re-check, the totals
   * ================================================================== */

  var PROFILES = {
    qbo3: { key: 'qbo3', name: 'QuickBooks Online', shape: '3-column: Date, Description, Amount', header: ['Date', 'Description', 'Amount'], ext: 'csv', dates: ['mdy', 'dmy'], assumes: 'One amount column: money in positive, money out negative. Dates MM/DD/YYYY (or DD/MM/YYYY if your company is set up that way). Comma-separated, UTF-8 without a byte-order mark, one header row.' },
    qbo4: { key: 'qbo4', name: 'QuickBooks Online', shape: '4-column: Date, Description, Credit, Debit', header: ['Date', 'Description', 'Credit', 'Debit'], ext: 'csv', dates: ['mdy', 'dmy'], assumes: 'Money in under Credit and money out under Debit, both as positive numbers, the other cell empty. Dates MM/DD/YYYY (or DD/MM/YYYY). Comma-separated, UTF-8 without a byte-order mark.' },
    xero: { key: 'xero', name: 'Xero', shape: 'Date, Amount, Payee, Description, Reference', header: ['Date', 'Amount', 'Payee', 'Description', 'Reference'], ext: 'csv', dates: ['dmy', 'mdy'], assumes: 'One amount column, money out negative. Payee is the payee (or the description when the file has no payee). Dates in your organisation’s format - DD/MM/YYYY or MM/DD/YYYY. Comma-separated, UTF-8.' },
    generic: { key: 'generic', name: 'Generic clean CSV', shape: 'ISO dates', header: ['Date', 'Description', 'Payee', 'Reference', 'Amount', 'Balance'], ext: 'csv', dates: ['iso'], assumes: 'Date (YYYY-MM-DD), Description, Amount, plus Payee, Reference and Balance when the file had them. Money out negative. Comma-separated, UTF-8.' },
    ofx: { key: 'ofx', name: 'OFX 1.0.2', shape: 'rebuilt with unique FITIDs', header: null, ext: 'ofx', dates: ['ofx'], assumes: 'An SGML OFX 1.0.2 bank (or credit card) statement: a clean header, CURDEF, the account, every transaction with TRNTYPE, a YYYYMMDD date, a plain signed amount, a unique FITID, NAME up to 32 characters and MEMO. Windows-1252, CR LF.' },
  };
  var PROFILE_KEYS = Object.keys(PROFILES);
  /** A target that takes either order starts on how this browser writes
   *  dates: 14/11 for day first, 11/14 for month first. */
  function profileDates(key, dayFirst) { var p = PROFILES[key]; if (!p) return 'iso'; if (p.dates.length === 1) return p.dates[0]; return dayFirst ? 'dmy' : 'mdy'; }

  /** A CSV cell: quoted when it holds the delimiter, a quote, a line break
   *  or edge spaces. */
  function csvCell(v, delim) {
    var s = str(v);
    var d = delim || ',';
    return s.indexOf(d) >= 0 || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** A text cell a spreadsheet would run as a formula (= + - @, a tab or a
   *  carriage return first) gets a leading apostrophe. Counted. */
  function formulaSafe(v, counter) {
    var s = str(v);
    if (/^[=+\-@\t\r]/.test(s)) { if (counter) counter.n++; return "'" + s; }
    return s;
  }
  function fnv(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8).toUpperCase(); }
  function uniqueFitid(id, n) { var base = str(id).slice(0, LIMITS.fitid - 6); return base + '-' + n; }
  function ofxText(s) { return str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function ofxIdText(s) { return str(s).replace(/[^\x20-\x7E]/g, '').replace(/[<>&]/g, '').trim(); }

  /** Write the fixed file. opts: everything diagnose takes, plus profile,
   *  dateFormat ('mdy'|'dmy'|'iso'), undo ({fixKey: true}), dropDuplicates,
   *  leaveOut ({line: true}), account ({acctId, bankId, acctType}), currency.
   *  Returns the bytes, a preview, every fix with its count and undo state,
   *  what the target shaped, the re-check of the output and the totals. */
  function fixFile(input, opts) {
    opts = opts || {};
    var undo = opts.undo || {};
    var key = PROFILES[opts.profile] ? opts.profile : 'qbo3';
    var P = PROFILES[key];
    var diagOpts = { name: opts.name, order: opts.order, dayFirst: opts.dayFirst, words: opts.words, map: opts.map, flip: opts.flip, noSigns: Boolean(undo.signs), repair: { quote: !undo.quote, rejoin: !undo.rejoin }, undo: { mojibake: Boolean(undo.mojibake) } };
    var st = diagnose(input, diagOpts);
    var fmt = P.dates[0] === 'ofx' ? 'ofx' : (P.dates.indexOf(opts.dateFormat) >= 0 ? opts.dateFormat : profileDates(key, opts.dayFirst));
    var cur = /^[A-Z]{3}$/.test(str(opts.currency)) ? opts.currency : (st.currency || 'USD');
    var out = { profile: key, dateFormat: fmt, fixes: [], shaped: [], ok: true, problem: '' };
    if (st.format === 'binary' || st.format === 'empty') { out.ok = false; out.problem = st.findings[0] ? st.findings[0].title : 'Nothing to fix.'; out.diagnosis = view(st); return out; }
    if (st.columns && st.columns.problems.length) { out.ok = false; out.problem = st.columns.problems[0]; out.diagnosis = view(st); return out; }
    var isOfx = key === 'ofx';
    var has = function (k) { return st.findings.some(function (f) { return f.key === k; }); };
    var fix = function (k, label, count, opt) { out.fixes.push({ key: k, label: label, count: count || 0, undone: Boolean(undo[k]), required: Boolean(opt && opt.required), why: (opt && opt.why) || '', optional: Boolean(opt && opt.optional) }); };
    // Rows: what goes in, in file order.
    var rows = [];
    var removed = { duplicates: [], leaveOut: [] };
    var dupLines = {};
    (st.dups || []).forEach(function (d) { dupLines[d.line] = d.of; });
    var leave = opts.leaveOut || {};
    var kept = function (k) { return isOfx || !undo[k]; };
    var rawKept = [];
    if (st.format === 'csv') {
      ['sep', 'preamble', 'summary', 'blank', 'pages'].forEach(function (k) { if (!kept(k)) st.removed[k].forEach(function (n) { rawKept.push(n); }); });
    }
    st.txs.forEach(function (t) {
      if (opts.dropDuplicates && dupLines[t.line] !== undefined) { removed.duplicates.push(t); return; }
      if (leave[t.line] && t.problems.length) { removed.leaveOut.push(t); return; }
      rows.push(t);
    });
    var all = rows.map(function (t) { return { line: t.line, tx: t }; }).concat(rawKept.map(function (n) { return { line: n, raw: st.rawRows[n] || [] }; })).sort(function (a, b) { return a.line - b.line; });
    // Text: invisible characters out, spaces tidied unless undone, formula
    // cells neutralised in CSV.
    var formula = { n: 0 };
    var textOf = function (v) { return line(v, LIMITS.cell); };
    var dateOut = function (t) {
      if (!t.date || undo.dates) return line(t.rawDate, 40);
      if (isOfx) return t.date.replace(/-/g, '') + '120000';
      return DATE_FORMATS[fmt].write(t.date);
    };
    var amtOut = function (cents, raw) { return cents === null || undo.amounts ? line(raw, 40) : plain(cents); };
    var text;
    var nDates = 0, nAmounts = 0;
    st.txs.forEach(function (t) { if (t.date) nDates++; if (t.amount !== null && (t.notes && Object.keys(t.notes).length || !/^-?\d+\.\d{2}$/.test(str(t.rawAmount).trim()))) nAmounts++; });
    var counter = formula;
    if (!isOfx) {
      var delim = undo.delimiter && st.delim ? st.delim : ',';
      var header = P.header.slice();
      var lines = [];
      var cells = all.map(function (r) {
        if (r.raw) {
          var c = r.raw, m = st.columns ? st.columns.map : {};
          var g = function (k) { return m[k] >= 0 ? str(c[m[k]] || '') : ''; };
          return { date: g('date') || str(c[0] || ''), description: g('description') || (m.description >= 0 ? '' : ''), payee: g('payee'), reference: g('reference'), amount: g('amount') || g('credit') || g('debit'), credit: g('credit'), debit: g('debit'), balance: g('balance'), raw: true };
        }
        var t = r.tx;
        return { date: dateOut(t), description: textOf(t.description), payee: textOf(t.payee), reference: textOf(t.reference), cents: t.amount, rawAmount: t.rawAmount, balanceCents: t.balance, rawBalance: t.rawBalance };
      });
      var desc = function (x) { return x.payee && x.description && fold(x.payee) !== fold(x.description) ? x.payee + ' - ' + x.description : (x.description || x.payee); };
      var hasCol = { payee: false, reference: false, balance: false };
      cells.forEach(function (x) { if (x.payee && !x.raw) hasCol.payee = true; if (x.reference && !x.raw) hasCol.reference = true; if (x.balanceCents !== null && x.balanceCents !== undefined && !x.raw) hasCol.balance = true; });
      if (key === 'generic') header = ['Date', 'Description'].concat(hasCol.payee ? ['Payee'] : [], hasCol.reference ? ['Reference'] : [], ['Amount'], hasCol.balance ? ['Balance'] : []);
      lines.push(header.map(function (h) { return csvCell(h, delim); }).join(delim));
      cells.forEach(function (x) {
        var row;
        var safe = function (v) { return formulaSafe(v, counter); };
        if (x.raw) {
          var rawRow = { Date: x.date, Description: x.description || x.payee, Payee: x.payee, Reference: x.reference, Amount: x.amount, Credit: x.credit, Debit: x.debit, Balance: x.balance };
          row = header.map(function (h) { return rawRow[h] || ''; });
        } else if (key === 'qbo3') row = [x.date, safe(desc(x)), amtOut(x.cents, x.rawAmount)];
        else if (key === 'qbo4') row = [x.date, safe(desc(x)), x.cents !== null && x.cents >= 0 ? amtOut(x.cents, x.rawAmount) : '', x.cents !== null && x.cents < 0 ? amtOut(undo.amounts ? x.cents : -x.cents, x.rawAmount) : (x.cents === null ? line(x.rawAmount, 40) : '')];
        else if (key === 'xero') row = [x.date, amtOut(x.cents, x.rawAmount), safe(x.payee || x.description), safe(x.payee ? x.description : ''), safe(x.reference)];
        else {
          var gen = { Date: x.date, Description: safe(x.description || x.payee), Payee: safe(x.payee), Reference: safe(x.reference), Amount: amtOut(x.cents, x.rawAmount), Balance: x.balanceCents === null || x.balanceCents === undefined ? '' : (undo.amounts ? line(x.rawBalance, 40) : plain(x.balanceCents)) };
          row = header.map(function (h) { return gen[h]; });
        }
        lines.push(row.map(function (v) { return csvCell(v, delim); }).join(delim));
      });
      var eol = undo.endings && st.endings && st.endings.cr && !st.endings.lf && !st.endings.crlf ? '\r' : '\r\n';
      text = lines.join(eol) + eol;
      if (key === 'qbo3' || key === 'qbo4') { if (cells.some(function (x) { return x.payee && x.description && !x.raw; })) out.shaped.push('Payee and description joined into Description (“Payee - description”)'); }
      if (key === 'qbo4') out.shaped.push('Money in under Credit and money out under Debit, both positive');
      if (key === 'xero' && !hasCol.payee) out.shaped.push('No payee column in the file, so the description goes under Payee');
      if (key === 'generic') out.shaped.push('Columns: ' + header.join(', '));
      if (st.format === 'ofx') out.shaped.push('Converted from OFX: NAME is the payee and MEMO the description. A CSV carries no FITIDs, so no transaction can be skipped as “already imported”');
      if (st.format === 'qif') out.shaped.push('Converted from QIF: P is the payee, M the description and N the reference; categories (L) are not part of these targets');
      if (st.txs.some(function (t) { return t.notes && t.notes.split; }) && key !== 'qbo4') out.shaped.push('Debit and Credit combined into one Amount (money out negative)');
      if (st.columns && !st.columns.hasHeader) fix('header', 'Wrote a header row', 1, { required: true, why: 'part of the format' });
      if (st.format === 'csv' && st.delim !== ',') fix('delimiter', 'Wrote commas instead of ' + (st.delim === '\t' ? 'tabs' : st.delim === ';' ? 'semicolons' : st.delim === '|' ? 'pipes' : 'commas'), st.txs.length, {});
    } else {
      text = writeOfx(st, rows, opts, cur, out, undo, counter);
    }
    // The fixes, in the order the findings are drawn.
    var encodingFrom = st.decoded.encoding;
    if (has('bom')) fix('bom', 'Left out the byte-order mark', 1, isOfx ? { required: true, why: 'part of the format' } : {});
    if (has('utf16') || has('cp1252')) fix('encoding', 'Wrote UTF-8 instead of ' + (encodingFrom === 'windows-1252' ? 'Windows-1252' : 'UTF-16'), 1, isOfx ? { required: true, why: 'OFX 1.0.2 is written as Windows-1252' } : {});
    if (has('mojibake')) fix('mojibake', 'Repaired ' + plural((st.findings.filter(function (f) { return f.key === 'mojibake'; })[0] || {}).count || 0, 'garbled character run'), 1);
    if (has('nul')) fix('nul', 'Left out ' + plural(st.decoded.trailingNul, 'NUL byte'), st.decoded.trailingNul);
    if (has('endings-cr') || has('endings-mixed')) fix('endings', 'Ended every line with CR LF', 1, isOfx ? { required: true, why: 'part of the format' } : {});
    if (st.removed.sep.length) fix('sep', 'Left out the Excel sep= line', 1, isOfx ? { required: true } : {});
    if (has('unclosed')) fix('quote', 'Closed ' + plural((st.findings.filter(function (f) { return f.key === 'unclosed'; })[0] || {}).count, 'unclosed quote'), 1);
    if (has('split')) fix('rejoin', 'Joined ' + plural((st.findings.filter(function (f) { return f.key === 'split'; })[0] || {}).count, 'split amount'), 1);
    if (st.removed.preamble.length) fix('preamble', 'Left out ' + plural(st.removed.preamble.length, 'line') + ' above the header', st.removed.preamble.length, isOfx ? { required: true, why: 'not possible in OFX' } : {});
    if (st.removed.summary.length) fix('summary', 'Left out ' + plural(st.removed.summary.length, 'summary row'), st.removed.summary.length, isOfx ? { required: true, why: 'not possible in OFX' } : {});
    if (st.removed.blank.length) fix('blank', 'Left out ' + plural(st.removed.blank.length, 'blank row'), st.removed.blank.length, isOfx ? { required: true } : {});
    if (st.removed.pages.length) fix('pages', 'Left out ' + plural(st.removed.pages.length, 'page-break line'), st.removed.pages.length, isOfx ? { required: true } : {});
    var orderQ = st.questions.filter(function (q) { return q.key === 'order'; })[0];
    var dOrder = st.dates && st.dates.order;
    var needsDates = !(st.format === 'ofx' && isOfx) || has('dtposted');
    if (needsDates && nDates) fix('dates', (isOfx ? 'Wrote ' + plural(nDates, 'date') + ' as YYYYMMDD' : 'Wrote ' + plural(nDates, 'date') + ' as ' + DATE_FORMATS[fmt].label) + (dOrder ? ', read as ' + (dOrder === 'dmy' ? 'day/month' : 'month/day') + (orderQ ? (orderQ.answered ? ' (your answer)' : ' (check the question above)') : '') : ''), nDates, isOfx && !has('dtposted') ? { required: true } : {});
    if (nAmounts && (!(st.format === 'ofx' && isOfx) || has('trnamt'))) fix('amounts', 'Wrote ' + plural(nAmounts, 'amount') + ' as plain numbers with a dot', nAmounts);
    var flips = st.txs.filter(function (t) { return t.flipped && t.flipped !== 'manual'; });
    var why = flips.length && flips[0].flipped === 'balance' ? ' (the balance shows which way)' : st.format === 'ofx' ? ' (from TRNTYPE)' : ' (from the Type column)';
    if (flips.length || (undo.signs && (has('sign-type') || has('sign-balance')))) fix('signs', 'Made ' + plural(flips.length || (st.findings.filter(function (f) { return f.key === 'sign-type' || f.key === 'sign-balance'; })[0] || {}).count || 0, 'amount') + ' money out' + why, flips.length);
    if (opts.flip) fix('flip', 'Flipped every sign (your choice)', st.txs.length, { optional: true });
    if (counter.n) fix('formula', 'Put an apostrophe before ' + plural(counter.n, 'cell') + ' starting = + - or @ so a spreadsheet does not run it', counter.n, { required: true, why: 'kept for safety' });
    if (has('invisible')) fix('invisible', 'Left out invisible characters', 1, { required: true, why: 'kept for safety' });
    if (removed.duplicates.length || (st.dups && st.dups.length)) fix('duplicates', opts.dropDuplicates ? 'Left out ' + plural(removed.duplicates.length, 'duplicate copy', 'duplicate copies') : 'Kept ' + plural(st.dups.length, 'possible duplicate') + ' (listed in the duplicates report)', st.dups.length, { optional: true });
    if (removed.leaveOut.length) fix('leaveOut', 'Left out ' + plural(removed.leaveOut.length, 'line') + ' that could not be read (' + linesWord(removed.leaveOut.map(function (t) { return t.line; })) + ')', removed.leaveOut.length, { optional: true });
    // Encoding the bytes.
    var bytes;
    if (isOfx) { var e1 = cp1252Encode(text); bytes = e1.bytes; if (e1.lost) out.shaped.push(plural(e1.lost, 'character') + ' Windows-1252 cannot hold written as ?'); }
    else if (undo.encoding && (encodingFrom === 'windows-1252' || encodingFrom.indexOf('utf-16') === 0)) bytes = encode(text, encodingFrom === 'windows-1252' ? 'windows-1252' : 'utf-16le');
    else bytes = encode(text, 'utf-8', Boolean(undo.bom && st.decoded.bom));
    if (undo.nul && st.decoded.trailingNul) bytes = concat(bytes, new Uint8Array(st.decoded.trailingNul));
    out.bytes = bytes;
    out.text = text;
    out.preview = text.replace(/(\r\n|\n|\r)$/, '').split(/\r\n|\n|\r/).slice(0, LIMITS.preview).map(function (l, k) { return { line: k + 1, text: visible(l) }; });
    out.lineCount = text.split(/\r\n|\n|\r/).length - 1;
    out.mime = isOfx ? 'application/x-ofx' : 'text/csv';
    out.fileName = fixedName(opts.name || st.name, key);
    out.formulaCount = counter.n;
    // The re-check: the output read back as a new file, against its profile.
    var rc = recheck(bytes, key, fmt, opts);
    out.recheck = rc;
    // Totals: the original as read, against the output read back.
    // "Before" is always the original as Feedfix reads it with every repair
    // on - so undoing a repair that changes the money (a split amount, the
    // signs, a quote) shows as a mismatch, not as a new normal.
    var ref = undo.quote || undo.rejoin || undo.signs ? diagnose(input, Object.assign({}, diagOpts, { noSigns: false, repair: {}, undo: {} })) : st;
    var goneLines = {};
    removed.duplicates.concat(removed.leaveOut).forEach(function (t) { goneLines[t.line] = 1; });
    var before = totals(ref.txs);
    var expected = totals(ref.txs.filter(function (t) { return !goneLines[t.line]; }));
    var after = rc.totals;
    var same = after.rows === expected.rows && after.inCents === expected.inCents && after.outCents === expected.outCents && after.first === expected.first && after.last === expected.last;
    var gone = removed.duplicates.concat(removed.leaveOut);
    out.ready = rc.clean && same;
    out.totals = { before: before, after: after, expected: expected, same: same, removedRows: gone.length, removed: gone.map(function (t) { return { line: t.line, amount: t.amount, why: removed.duplicates.indexOf(t) >= 0 ? 'duplicate' : 'unreadable' }; }), currency: cur };
    out.diagnosis = view(st);
    out.dups = st.dups || [];
    return out;
  }
  function fixedName(name, key) {
    var base = str(name).replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'statement';
    return base + '-feedfix-' + key + '.' + PROFILES[key].ext;
  }

  function writeOfx(st, rows, opts, cur, out, undo, counter) {
    void counter;
    var acct = opts.account || {};
    var srcAcct = (st.ofx && st.ofx.acct) || {};
    var acctId = ofxIdText(acct.acctId || srcAcct.ACCTID || '').slice(0, 22);
    var bankId = ofxIdText(acct.bankId || srcAcct.BANKID || '').slice(0, 9);
    var acctType = ['CHECKING', 'SAVINGS', 'MONEYMRKT', 'CREDITLINE', 'CREDITCARD'].indexOf(acct.acctType) >= 0 ? acct.acctType : (st.ofx && st.ofx.cc ? 'CREDITCARD' : (['CHECKING', 'SAVINGS', 'MONEYMRKT', 'CREDITLINE'].indexOf(str(srcAcct.ACCTTYPE).toUpperCase()) >= 0 ? str(srcAcct.ACCTTYPE).toUpperCase() : 'CHECKING'));
    var cc = acctType === 'CREDITCARD';
    var days = rows.map(function (t) { return t.date; }).filter(Boolean).sort();
    var d0 = (days[0] || '').replace(/-/g, ''), d1 = (days[days.length - 1] || '').replace(/-/g, '');
    var L = [];
    L.push('OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252', 'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '');
    L.push('<OFX>', '<SIGNONMSGSRSV1>', '<SONRS>', '<STATUS>', '<CODE>0', '<SEVERITY>INFO', '</STATUS>', '<DTSERVER>' + (d1 || '19700101') + '120000', '<LANGUAGE>ENG');
    var fi = st.ofx && st.ofx.fi;
    if (fi && (fi.ORG || fi.FID)) { L.push('<FI>'); if (fi.ORG) L.push('<ORG>' + ofxText(line(fi.ORG, 32))); if (fi.FID) L.push('<FID>' + ofxIdText(fi.FID).slice(0, 32)); L.push('</FI>'); }
    if (st.ofx && st.ofx.intuBid) L.push('<INTU.BID>' + ofxIdText(st.ofx.intuBid).slice(0, 10));
    L.push('</SONRS>', '</SIGNONMSGSRSV1>');
    L.push(cc ? '<CREDITCARDMSGSRSV1>' : '<BANKMSGSRSV1>', cc ? '<CCSTMTTRNRS>' : '<STMTTRNRS>', '<TRNUID>1', '<STATUS>', '<CODE>0', '<SEVERITY>INFO', '</STATUS>', cc ? '<CCSTMTRS>' : '<STMTRS>', '<CURDEF>' + cur);
    if (cc) L.push('<CCACCTFROM>', '<ACCTID>' + acctId, '</CCACCTFROM>');
    else L.push('<BANKACCTFROM>', '<BANKID>' + (bankId || '000000000'), '<ACCTID>' + acctId, '<ACCTTYPE>' + acctType, '</BANKACCTFROM>');
    if (!acctId) out.problemAccount = true;
    if (!bankId && !cc) out.shaped.push('No bank id in the file, so BANKID is 000000000 - type yours in the OFX details if your software checks it');
    L.push('<BANKTRANLIST>', '<DTSTART>' + (d0 || '19700101') + '120000', '<DTEND>' + (d1 || '19700101') + '120000');
    var used = {}, fitNew = 0, retyped = 0, cut = 0;
    var occurrence = {};
    rows.forEach(function (t) {
      var name = line(t.payee || t.description || 'Transaction', 200);
      var memo = t.payee ? line(t.description, LIMITS.ofxMemo) : '';
      var fullName = name;
      if (name.length > LIMITS.ofxName && !undo.namelen) { name = name.slice(0, LIMITS.ofxName).replace(/\s+$/, ''); memo = clip(fullName + (memo ? ' - ' + memo : ''), LIMITS.ofxMemo); cut++; }
      var type = t.type && TRNTYPES.indexOf(t.type) >= 0 ? t.type : '';
      var wantDebit = t.amount !== null && t.amount < 0;
      if (!type || (!undo.retype && t.amount && ((t.amount > 0 && DEBIT_TYPES.indexOf(type) >= 0) || (t.amount < 0 && CREDIT_TYPES.indexOf(type) >= 0)))) { if (type) retyped++; type = wantDebit ? 'DEBIT' : 'CREDIT'; }
      var fitid = t.fitid || '';
      if (!undo.fitid) {
        if (!fitid) {
          var basis = [t.date, t.amount, fold(name), fold(memo)].join('|');
          occurrence[basis] = (occurrence[basis] || 0) + 1;
          fitid = 'FF' + str(t.date).replace(/-/g, '') + fnv(basis + '|' + occurrence[basis]);
          fitNew++;
        }
        var n = 2, base = fitid;
        while (used[fitid]) { fitid = uniqueFitid(base, n++); }
        if (fitid !== base) fitNew++;
      }
      used[fitid] = 1;
      L.push('<STMTTRN>', '<TRNTYPE>' + type, '<DTPOSTED>' + (t.date && !undo.dates ? t.date.replace(/-/g, '') + '120000' : line(t.rawDate, 30)), '<TRNAMT>' + (t.amount === null || undo.amounts ? line(t.rawAmount, 30) : plain(t.amount)), '<FITID>' + ofxIdText(fitid).slice(0, LIMITS.fitid));
      if (t.reference && /^[A-Za-z0-9-]{1,12}$/.test(t.reference)) L.push('<CHECKNUM>' + t.reference);
      L.push('<NAME>' + ofxText(name));
      if (memo) L.push('<MEMO>' + ofxText(memo));
      L.push('</STMTTRN>');
    });
    L.push('</BANKTRANLIST>');
    if (st.meta.closing !== undefined && st.meta.closing !== null) L.push('<LEDGERBAL>', '<BALAMT>' + plain(st.meta.closing), '<DTASOF>' + (d1 || '19700101') + '120000', '</LEDGERBAL>');
    L.push(cc ? '</CCSTMTRS>' : '</STMTRS>', cc ? '</CCSTMTTRNRS>' : '</STMTTRNRS>', cc ? '</CREDITCARDMSGSRSV1>' : '</BANKMSGSRSV1>', '</OFX>');
    out.fitNew = fitNew;
    var hadFitid = st.format === 'ofx';
    out.fixes.push({ key: 'ofxheader', label: hadFitid ? 'Wrote a clean OFX 1.0.2 header and closed every section' : 'Built an OFX 1.0.2 statement from the rows', count: 1, undone: false, required: true, why: 'part of the format' });
    if (fitNew) out.fixes.push({ key: 'fitid', label: hadFitid ? 'Gave ' + plural(fitNew, 'transaction') + ' a unique FITID (the unique ones kept)' : 'Gave every transaction a stable, unique FITID', count: fitNew, undone: Boolean(undo.fitid), required: !hadFitid, why: hadFitid ? '' : 'part of the format' });
    else if (undo.fitid) out.fixes.push({ key: 'fitid', label: 'Gave transactions unique FITIDs', count: 0, undone: true });
    if (retyped || undo.retype) out.fixes.push({ key: 'retype', label: 'Rewrote ' + plural(retyped, 'TRNTYPE') + ' to match the sign', count: retyped, undone: Boolean(undo.retype) });
    if (cut || undo.namelen) out.fixes.push({ key: 'namelen', label: 'Cut ' + plural(cut, 'NAME') + ' to 32 characters (the whole name kept in MEMO)', count: cut, undone: Boolean(undo.namelen) });
    if (st.findings.some(function (f) { return f.key === 'ampersand'; })) out.fixes.push({ key: 'escape', label: 'Escaped & in names as &amp;', count: 1, undone: false, required: true, why: 'part of the format' });
    out.shaped.push('Account ' + (acctId ? '•••' + acctId.slice(-4) : '(not set)') + ' · ' + acctType + ' · ' + cur);
    return L.join('\r\n') + '\r\n';
  }

  /** The fixed file read back as if someone had just dropped it here, and
   *  checked against what its profile promises. Clean means nothing that
   *  stops or spoils an import - findings about the data itself (a balance
   *  that breaks, duplicates kept on purpose) are carried, not counted. */
  function recheck(bytes, key, fmt, opts) {
    var P = PROFILES[key];
    var order = fmt === 'dmy' || fmt === 'mdy' ? fmt : null;
    var map = null;
    var st0 = decode(bytes);
    if (key !== 'ofx' && !st0.binary) {
      var firstLine = st0.text.split(/\r\n|\n|\r/)[0] || '';
      var hs = firstLine.split(',');
      map = {};
      MAP_FIELDS.forEach(function (f) { map[f] = -1; });
      hs.forEach(function (h, i) { var k = h.trim().toLowerCase(); if (k === 'date') map.date = i; else if (k === 'description') map.description = i; else if (k === 'payee') map.payee = i; else if (k === 'reference') map.reference = i; else if (k === 'amount') map.amount = i; else if (k === 'credit') map.credit = i; else if (k === 'debit') map.debit = i; else if (k === 'balance') map.balance = i; });
    }
    var st = diagnose(bytes, { order: order, map: map, words: opts && opts.words, dayFirst: fmt === 'dmy' });
    var problems = st.findings.filter(function (f) { return (f.sev === 'blocks' || f.sev === 'wrong') && !f.carried && !(f.key === 'ofx-account' && false); });
    var carried = st.findings.filter(function (f) { return f.carried; });
    var conform = [];
    var text = decode(bytes).text;
    var ls = text.split('\r\n');
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) conform.push({ title: 'Starts with a byte-order mark', lines: [1] });
    if (/[^\r]\n|\r(?!\n)/.test(text)) conform.push({ title: 'Line endings are not all CR LF', lines: [] });
    if (key !== 'ofx') {
      var want = P.header ? P.header : null;
      var head = (ls[0] || '').split(',');
      if (key === 'generic') { if (head[0] !== 'Date' || head.indexOf('Amount') < 0 || head.indexOf('Description') !== 1) conform.push({ title: 'The header is not Date, Description, …, Amount', lines: [1] }); }
      else if (want && ls[0] !== want.join(',')) conform.push({ title: 'The header is not ' + want.join(', '), lines: [1] });
      var re = DATE_FORMATS[fmt] ? DATE_FORMATS[fmt].re : null;
      var badDate = [], badAmt = [], width = [], blank = [];
      var p = parseRecords(text, ',', {});
      var hd = p.records[0] ? p.records[0].cells : [];
      var di = hd.indexOf('Date'), ai = hd.indexOf('Amount'), ci = hd.indexOf('Credit'), dbi = hd.indexOf('Debit');
      p.records.slice(1).forEach(function (r) {
        if (!r.cells.join('').trim()) { blank.push(r.line); return; }
        if (r.cells.length !== hd.length) width.push(r.line);
        var dv = r.cells[di] || '';
        if (!re || !re.test(dv) || !readDate(dv, order === null ? 'mdy' : order, true) || (fmt === 'iso' && !isDay(dv))) badDate.push(r.line);
        if (ai >= 0 && !/^-?\d+\.\d{2}$/.test(r.cells[ai] || '')) badAmt.push(r.line);
        if (ci >= 0) { var cv = r.cells[ci] || '', dbv = r.cells[dbi] || ''; if (!((/^\d+\.\d{2}$/.test(cv) && !dbv) || (/^\d+\.\d{2}$/.test(dbv) && !cv))) badAmt.push(r.line); }
      });
      if (badDate.length) conform.push({ title: 'Dates not written as ' + (DATE_FORMATS[fmt] ? DATE_FORMATS[fmt].label : 'the target format'), lines: badDate.slice(0, LIMITS.lines) });
      if (badAmt.length) conform.push({ title: 'Amounts that are not plain numbers with two decimals', lines: badAmt.slice(0, LIMITS.lines) });
      if (width.length) conform.push({ title: 'Rows wider or narrower than the header', lines: width.slice(0, LIMITS.lines) });
      if (blank.length) conform.push({ title: 'Blank rows', lines: blank.slice(0, LIMITS.lines) });
    } else {
      var o = parseOfx(text);
      if (o.headerProblems.length) conform.push({ title: 'The OFX header is not clean', lines: [] });
      var seen = {}, dup = [], miss = [], dt = [], am = [], nm = [];
      o.txs.forEach(function (t) {
        var f = t.f;
        if (!f.FITID) miss.push(t.line); else if (seen[f.FITID]) dup.push(t.line); else seen[f.FITID] = 1;
        if (!ofxDay(f.DTPOSTED)) dt.push(t.line);
        if (!OFX_AMT.test(str(f.TRNAMT))) am.push(t.line);
        if (str(f.NAME).length > LIMITS.ofxName) nm.push(t.line);
      });
      if (dup.length) conform.push({ title: 'FITIDs used twice', lines: dup });
      if (miss.length) conform.push({ title: 'Transactions with no FITID', lines: miss });
      if (dt.length) conform.push({ title: 'DTPOSTED not YYYYMMDD', lines: dt });
      if (am.length) conform.push({ title: 'TRNAMT not a plain number', lines: am });
      if (nm.length) conform.push({ title: 'NAME over 32 characters', lines: nm });
      if (!o.acct || !o.acct.ACCTID) conform.push({ title: 'No account id - type the account in the OFX details', lines: [], account: true });
      if (!/^[A-Z]{3}$/.test(o.curdef)) conform.push({ title: 'No currency', lines: [] });
      if (o.unclosed.length) conform.push({ title: 'Sections left open', lines: [] });
    }
    var clean = !problems.length && !conform.length;
    return { clean: clean, problems: problems.map(function (f) { return { key: f.key, sev: f.sev, title: f.title, lines: f.lines.slice(0, 20), count: f.count }; }), conform: conform, carried: carried.map(function (f) { return { key: f.key, title: f.title, count: f.count }; }), totals: totals(st.txs), rows: st.txs.length };
  }

  /* ================================================================== *
   * Exports: the report, the duplicates list
   * ================================================================== */

  /** Markdown-safe: nothing can become emphasis, a link, a table cell, an
   *  HTML tag or a heading. */
  function mdEsc(s) { return str(s).replace(/([\\`*_[\]|<>~])/g, '\\$1').replace(/^([#>+-])/, '\\$1').replace(/\r?\n/g, ' '); }
  /** The diagnosis as Markdown, masked: finding titles, line numbers and
   *  counts, the fixes, the totals and the re-check - never a payee, a
   *  description or one transaction's amount. */
  function report(d, fx, stamp) {
    var cur = (fx && fx.totals && fx.totals.currency) || d.currency || 'USD';
    var L = ['# Feedfix diagnosis', ''];
    L.push('- File: ' + mdEsc(d.name || 'statement') + ' (' + groups(d.bytes) + ' bytes, ' + plural(d.lineCount, 'line') + ')');
    L.push('- Read as: ' + mdEsc(formatLabel(d)));
    if (stamp) L.push('- Checked: ' + mdEsc(stamp) + ', on this device - nothing was uploaded');
    L.push('- Transactions found: ' + groups(d.totals.rows) + (d.totals.first ? ' (' + d.totals.first + ' to ' + d.totals.last + ')' : ''));
    L.push('- Verdict: ' + mdEsc(d.verdict.line), '');
    L.push('## Findings', '');
    if (!d.findings.length) L.push('Nothing found.');
    d.findings.forEach(function (f) {
      L.push('- **' + SEV_WORD[f.sev] + ':** ' + mdEsc(f.title) + (f.lines.length ? ' - ' + mdEsc(linesWord(f.lines, f.more)) : (f.count > 1 ? ' - ' + groups(f.count) + ' found' : '')));
    });
    (d.questions || []).forEach(function (q) { if (q.key === 'order') L.push('', 'Dates were read as ' + (q.chosen === 'dmy' ? 'day/month' : 'month/day') + (q.answered ? ' (chosen by hand).' : ' (the reading that puts them in order - check it).')); });
    if (fx && fx.ok !== false && fx.fixes) {
      var P = PROFILES[fx.profile];
      L.push('', '## Fixed for ' + mdEsc(P.name + ' (' + P.shape + ')'), '');
      fx.fixes.forEach(function (x) { L.push('- ' + (x.undone ? '~~' + mdEsc(x.label) + '~~ (undone)' : mdEsc(x.label))); });
      fx.shaped.forEach(function (s) { L.push('- ' + mdEsc(s)); });
      if (fx.formulaCount) L.push('', 'Formula safety: ' + plural(fx.formulaCount, 'text cell') + ' began with = + - or @ and ' + (fx.formulaCount === 1 ? 'was' : 'were') + ' given a leading apostrophe, so a spreadsheet opening the file does not run ' + (fx.formulaCount === 1 ? 'it' : 'them') + ' as a formula.');
      var t = fx.totals;
      L.push('', '## Totals', '', '| | Rows | Money in | Money out | Net | First | Last |', '|---|---:|---:|---:|---:|---|---|');
      L.push('| Original | ' + groups(t.before.rows) + ' | ' + money(t.before.inCents, cur) + ' | ' + money(t.before.outCents, cur) + ' | ' + money(t.before.net, cur) + ' | ' + (t.before.first || '') + ' | ' + (t.before.last || '') + ' |');
      L.push('| Fixed file | ' + groups(t.after.rows) + ' | ' + money(t.after.inCents, cur) + ' | ' + money(t.after.outCents, cur) + ' | ' + money(t.after.net, cur) + ' | ' + (t.after.first || '') + ' | ' + (t.after.last || '') + ' |');
      L.push('', t.same ? (t.removedRows ? 'The fixed file matches the original less ' + plural(t.removedRows, 'row') + ' left out on purpose (' + mdEsc(linesWord(t.removed.map(function (r) { return r.line; }))) + ').' : 'The fixed file matches the original: same rows, same money in and out, same dates.') : 'The fixed file does NOT match the original - see the re-check.');
      L.push('', '## Re-check of the fixed file', '');
      if (fx.recheck.clean) L.push('Clean: nothing found that would stop or spoil an import.');
      fx.recheck.problems.forEach(function (p) { L.push('- ' + SEV_WORD[p.sev] + ': ' + mdEsc(p.title)); });
      fx.recheck.conform.forEach(function (c) { L.push('- ' + mdEsc(c.title) + (c.lines.length ? ' - ' + mdEsc(linesWord(c.lines)) : '')); });
      fx.recheck.carried.forEach(function (c) { L.push('- Still true of the data: ' + mdEsc(c.title)); });
    }
    L.push('', 'Amounts and payees are left out of this report; only counts and totals are shown. Check your software’s current import guide - these are the common shapes.', '');
    return L.join('\n');
  }
  function formatLabel(d) {
    if (d.format === 'ofx') return (d.ofx && d.ofx.xml ? 'OFX 2 (XML)' : 'OFX ' + (d.ofx && d.ofx.version ? d.ofx.version.replace(/^(\d)(\d)(\d)$/, '$1.$2.$3') : '1.x') + ' (SGML)') + ' · ' + encodingLabel(d.decoded);
    if (d.format === 'qif') return 'QIF' + (d.qif && d.qif.type ? ' (' + d.qif.type + ')' : '') + ' · ' + encodingLabel(d.decoded);
    if (d.format === 'csv') return ({ comma: 'Comma', semicolon: 'Semicolon', tab: 'Tab', pipe: 'Pipe' }[d.delimiter] || 'Comma') + '-separated text · ' + encodingLabel(d.decoded);
    return d.format === 'empty' ? 'Empty' : 'Not a text file';
  }
  function encodingLabel(dec) { return ({ 'utf-8': 'UTF-8', 'utf-16le': 'UTF-16', 'utf-16be': 'UTF-16 (big-endian)', 'windows-1252': 'Windows-1252' }[dec.encoding] || dec.encoding) + (dec.bom ? ' with a byte-order mark' : ''); }

  /** The duplicates as CSV: each copy with the line it repeats. Formula
   *  cells defused. */
  function duplicatesCsv(dups) {
    var c = { n: 0 };
    var rows = [['line', 'same_as_line', 'date', 'amount', 'description', 'payee', 'reference']];
    (dups || []).forEach(function (d) { rows.push([d.line, d.of, d.date || '', d.amount === null ? '' : plain(d.amount), formulaSafe(d.description, c), formulaSafe(d.payee, c), formulaSafe(d.reference, c)]); });
    return rows.map(function (r) { return r.map(function (v) { return csvCell(str(v)); }).join(','); }).join('\r\n') + '\r\n';
  }

  /* ================================================================== *
   * Settings: preferences only - never a transaction
   * ================================================================== */

  var DEFAULT_SETTINGS = { version: 1, profile: 'qbo3', dateFormats: {}, sources: [], words: [], currency: '' };
  function defaults() { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
  var SETTINGS_KEYS = ['version', 'profile', 'dateFormats', 'sources', 'words', 'currency', 'updatedAt'];
  /** Could this be a piece of a transaction? An amount, a date, a long run
   *  of digits (an account or card number), an address. */
  function looksLikeData(s) {
    s = str(s);
    return /@/.test(s) || /\d{4,}/.test(s) || /\d[.,]\d{2}\b/.test(s) || /[$€£¥]\s*\d/.test(s) || /\d\s*[$€£¥]/.test(s) || /\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/.test(s) || /[<>{}\\]/.test(s) || BAD1.test(s);
  }
  function labelKey(s) { return fold(s); }
  /** The settings, checked. Strict mode (the server) lists every problem:
   *  unknown keys anywhere, too many sources or words, a label or word that
   *  looks like transaction data, a profile or format not on the list. */
  function cleanSettings(raw, strict) {
    var errors = [], out = defaults();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { settings: out, errors: ['Settings must be an object.'] };
    Object.keys(raw).forEach(function (k) { if (SETTINGS_KEYS.indexOf(k) < 0) errors.push('Unknown setting: ' + line(k, 30) + '.'); });
    if (raw.version !== undefined && raw.version !== 1) errors.push('Unknown settings version.');
    if (raw.profile !== undefined) { if (PROFILES[raw.profile]) out.profile = raw.profile; else errors.push('Unknown target.'); }
    if (raw.currency !== undefined) { if (raw.currency === '' || CURRENCIES.indexOf(raw.currency) >= 0) out.currency = raw.currency; else errors.push('Unknown currency.'); }
    if (raw.dateFormats !== undefined) {
      if (!raw.dateFormats || typeof raw.dateFormats !== 'object' || Array.isArray(raw.dateFormats)) errors.push('Date formats must be an object.');
      else Object.keys(raw.dateFormats).forEach(function (k) {
        var v = raw.dateFormats[k];
        if (!PROFILES[k] || PROFILES[k].dates.indexOf(v) < 0) errors.push('A date format for an unknown target.');
        else out.dateFormats[k] = v;
      });
    }
    if (raw.sources !== undefined) {
      if (!Array.isArray(raw.sources) || raw.sources.length > LIMITS.sources) errors.push('At most ' + LIMITS.sources + ' named sources.');
      else raw.sources.forEach(function (s) {
        if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(function (k) { return ['label', 'order', 'flip'].indexOf(k) < 0; })) { errors.push('A source holds only its label, its date order and whether to flip signs.'); return; }
        var label = typeof s.label === 'string' ? line(s.label, LIMITS.labelChars + 1) : '';
        if (!label || label.length > LIMITS.labelChars) { errors.push('A source label is 1 to ' + LIMITS.labelChars + ' characters.'); return; }
        if (looksLikeData(s.label)) { errors.push('A source label must not look like an account number, an amount, a date or an address - "Riverton checking" is fine.'); return; }
        if (s.order !== undefined && s.order !== 'dmy' && s.order !== 'mdy') { errors.push('A source’s date order is day/month or month/day.'); return; }
        if (s.flip !== undefined && typeof s.flip !== 'boolean') { errors.push('Flip is yes or no.'); return; }
        var k2 = labelKey(label);
        out.sources = out.sources.filter(function (x) { return labelKey(x.label) !== k2; });
        var row = { label: label };
        if (s.order) row.order = s.order;
        if (s.flip) row.flip = true;
        out.sources.push(row);
      });
    }
    if (raw.words !== undefined) {
      if (!Array.isArray(raw.words) || raw.words.length > LIMITS.words) errors.push('At most ' + LIMITS.words + ' summary-row words.');
      else raw.words.forEach(function (w) {
        var v = typeof w === 'string' ? line(w, LIMITS.wordChars + 1) : '';
        if (!v || v.length > LIMITS.wordChars || fold(v).length < 3) errors.push('A summary-row word is 3 to ' + LIMITS.wordChars + ' characters.');
        else if (looksLikeData(w)) errors.push('A summary-row word must not hold digits like an amount or a date.');
        else if (out.words.map(fold).indexOf(fold(v)) < 0) out.words.push(v);
      });
    }
    if (raw.updatedAt !== undefined) { if (typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt) && raw.updatedAt >= 0) out.updatedAt = Math.floor(raw.updatedAt); else errors.push('Bad updatedAt.'); }
    return { settings: out, errors: strict ? errors : [] };
  }
  /** Two copies brought together: every source and word from both, this
   *  device's winning where both name a source; the other choices this
   *  device's. */
  function mergeSettings(account, device) {
    var a = cleanSettings(account).settings, d = cleanSettings(device).settings;
    var out = cleanSettings(d).settings;
    var added = 0;
    a.sources.forEach(function (s) { if (!out.sources.some(function (x) { return labelKey(x.label) === labelKey(s.label); }) && out.sources.length < LIMITS.sources) { out.sources.push(s); added++; } });
    a.words.forEach(function (w) { if (out.words.map(fold).indexOf(fold(w)) < 0 && out.words.length < LIMITS.words) { out.words.push(w); added++; } });
    Object.keys(a.dateFormats).forEach(function (k) { if (!out.dateFormats[k]) out.dateFormats[k] = a.dateFormats[k]; });
    if (!out.currency) out.currency = a.currency;
    delete out.updatedAt;
    return { settings: out, added: added };
  }
  function sourceFor(settings, label) { var k = labelKey(label); return k ? (settings.sources || []).filter(function (s) { return labelKey(s.label) === k; })[0] || null : null; }
  /** A label suggested from a file name: words only, no digits. */
  function labelFrom(name) {
    var s = str(name).replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[_\-.]+/g, ' ').replace(/\d+/g, ' ').replace(/\b(export|statement|transactions|download|history|csv|ofx|qfx|qif)\b/gi, ' ');
    s = line(s, LIMITS.labelChars);
    return s && !looksLikeData(s) ? s : '';
  }

  /* ================================================================== *
   * The AI column helper: header names and shapes in, a mapping out
   * ================================================================== */

  var CONFIDENCE = ['high', 'medium', 'low'];
  /** Is this header a name, not a value? No @, no run of 5 or more digits,
   *  no digits joined like a date or an amount, no markup. */
  function headerOk(h) {
    var s = str(h);
    if (!s || s.length > LIMITS.headerChars || BAD1.test(s)) return false;
    if (/@/.test(s) || /\d{5,}/.test(s) || /\d[.,/:-]\d/.test(s) || /[$€£¥]\s*\d/.test(s) || /[<>{}\\]/.test(s)) return false;
    return Boolean(s.trim());
  }
  function safeHeader(h, i) { var s = line(h, LIMITS.headerChars); return headerOk(s) ? s : 'Column ' + (i + 1); }
  /** What "Help me read these columns" sends: each header (a value-looking
   *  one as "Column N") and its shape codes. Nothing else. */
  function columnsPayload(headers, shapes) {
    return { columns: headers.slice(0, LIMITS.columns).map(function (h, i) { return { header: safeHeader(h, i), shape: (shapes[i] || []).filter(function (c) { return Object.prototype.hasOwnProperty.call(SHAPES, c); }).slice(0, 5) }; }) };
  }
  function onlyKeys(o, keys) { return o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(function (k) { return keys.indexOf(k) >= 0; }); }
  /** The server's check of that payload: exactly {columns: [{header,
   *  shape}]}; every header a name; every shape code from SHAPES. */
  function columnsRequest(body) {
    if (!onlyKeys(body, ['columns'])) return { error: 'Only the column names and their shapes can be sent - nothing else.', code: 'unknown-field' };
    if (!Array.isArray(body.columns) || !body.columns.length || body.columns.length > LIMITS.columns) return { error: 'Send 1 to ' + LIMITS.columns + ' columns.', code: 'bad-columns' };
    var cols = [];
    for (var i = 0; i < body.columns.length; i++) {
      var c = body.columns[i];
      if (!onlyKeys(c, ['header', 'shape'])) return { error: 'Each column is a header name and its shape codes - nothing else.', code: 'unknown-field' };
      if (typeof c.header !== 'string' || !headerOk(c.header)) return { error: 'A header looked like a value (an @, a long number, a date or an amount). Send it as "Column N" instead.', code: 'value-in-header' };
      if (!Array.isArray(c.shape) || c.shape.length > 5) return { error: 'Each column has up to 5 shape codes.', code: 'bad-shape' };
      for (var j = 0; j < c.shape.length; j++) if (typeof c.shape[j] !== 'string' || !Object.prototype.hasOwnProperty.call(SHAPES, c.shape[j])) return { error: 'A shape code that is not on the list.', code: 'unknown-shape' };
      cols.push({ header: c.header, shape: c.shape.slice() });
    }
    return { req: { columns: cols } };
  }
  /** The model's mapping, checked: known fields, real columns, each column
   *  once and each field (but "ignore") once, Amount or Debit/Credit, a
   *  confidence from the list. */
  function cleanColumns(raw, req) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.mapping)) return null;
    var map = {}, conf = {}, used = {}, dropped = 0, ignored = [];
    MAP_FIELDS.forEach(function (f) { map[f] = -1; });
    raw.mapping.slice(0, 80).forEach(function (m) {
      if (!m || typeof m !== 'object') { dropped++; return; }
      var c = Number(m.column);
      if (!(Math.floor(c) === c && c >= 1 && c <= req.columns.length) || used[c] || FIELDS.indexOf(m.field) < 0) { dropped++; return; }
      if (m.field === 'ignore') { used[c] = 1; ignored.push(c - 1); return; }
      if (map[m.field] >= 0) { dropped++; return; }
      map[m.field] = c - 1; used[c] = 1;
      conf[m.field] = CONFIDENCE.indexOf(m.confidence) >= 0 ? m.confidence : 'low';
    });
    if (map.amount >= 0 && (map.debit >= 0 || map.credit >= 0)) { map.debit = -1; map.credit = -1; delete conf.debit; delete conf.credit; dropped++; }
    if (!MAP_FIELDS.some(function (k) { return map[k] >= 0; })) return null;
    return { map: map, confidence: conf, ignored: ignored, dropped: dropped, note: line(noMarkup(raw.note).replace(/\b(?:https?:\/\/|www\.)\S+/gi, ''), LIMITS.noteChars) };
  }

  /* ================================================================== *
   * The engine: the same steps in the worker and, without one, on the page
   * ================================================================== */

  /** Keeps each loaded file's bytes, so a 20 MB statement is handed over
   *  once and re-read with new choices as often as needed. No clock, no
   *  storage, no network. */
  function createEngine() {
    var files = {};
    return {
      load: function (o) {
        var b = toBytes(o.bytes !== undefined ? o.bytes : encode(o.text || '', o.encoding, o.bom));
        if (b.length > LIMITS.fileBytes) throw new Error('That file is over ' + Math.round(LIMITS.fileBytes / 1048576) + ' MB. Download a shorter period from the bank.');
        files[o.id] = { bytes: b, name: line(o.name, 120) };
        return view(diagnose(b, Object.assign({ name: o.name }, o.opts || {})));
      },
      diagnose: function (o) { var f = files[o.id]; if (!f) throw new Error('That file is not loaded.'); return view(diagnose(f.bytes, Object.assign({ name: f.name }, o.opts || {}))); },
      fix: function (o) { var f = files[o.id]; if (!f) throw new Error('That file is not loaded.'); return fixFile(f.bytes, Object.assign({ name: f.name }, o.opts || {})); },
      drop: function (o) { delete files[o.id]; return true; },
    };
  }

  return {
    LIMITS: LIMITS, SEV: SEV, SEV_WORD: SEV_WORD, FIELDS: FIELDS, MAP_FIELDS: MAP_FIELDS, FIELD_LABEL: FIELD_LABEL, SHAPES: SHAPES, PROFILES: PROFILES, PROFILE_KEYS: PROFILE_KEYS, DATE_FORMATS: DATE_FORMATS, CURRENCIES: CURRENCIES, CONFIDENCE: CONFIDENCE, DEFAULT_SETTINGS: DEFAULT_SETTINGS, ORDER: ORDER,
    str: str, esc: esc, line: line, clip: clip, fold: fold, plural: plural, groups: groups, visible: visible, noMarkup: noMarkup, money: money, plain: plain, niceDay: niceDay, isDay: isDay,
    toBytes: toBytes, utf8Decode: utf8Decode, utf8Encode: utf8Encode, cp1252Decode: cp1252Decode, cp1252Encode: cp1252Encode, utf16Decode: utf16Decode, encode: encode, decode: decode, unmojibake: unmojibake,
    dateParts: dateParts, readDate: readDate, dateStyle: dateStyle, ordering: ordering, orderQuestion: orderQuestion, readAmount: readAmount, amountStyle: amountStyle,
    sniffDelimiter: sniffDelimiter, parseRecords: parseRecords, readDelimited: readDelimited, findHeader: findHeader, headerScore: headerScore, profile: profile, shapeCodes: shapeCodes, guessColumns: guessColumns, mappingProblems: mappingProblems, rejoin: rejoin,
    parseOfx: parseOfx, parseQif: parseQif, ofxDay: ofxDay, looksOfx: looksOfx, looksQif: looksQif,
    diagnose: diagnose, view: view, balanceCheck: balanceCheck, duplicates: duplicates, totals: totals, verdict: verdict, linesWord: linesWord,
    fixFile: fixFile, recheck: recheck, profileDates: profileDates, csvCell: csvCell, formulaSafe: formulaSafe, fixedName: fixedName, uniqueFitid: uniqueFitid,
    report: report, formatLabel: formatLabel, encodingLabel: encodingLabel, duplicatesCsv: duplicatesCsv, mdEsc: mdEsc,
    defaults: defaults, cleanSettings: cleanSettings, mergeSettings: mergeSettings, sourceFor: sourceFor, labelFrom: labelFrom, looksLikeData: looksLikeData,
    headerOk: headerOk, safeHeader: safeHeader, columnsPayload: columnsPayload, columnsRequest: columnsRequest, cleanColumns: cleanColumns,
    createEngine: createEngine,
  };
}));
