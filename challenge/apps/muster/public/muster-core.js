/* Muster - the rules. Find the servicemembers in a loan book, and apply the
 * 6% cap with the paper trail.
 *
 * UMD: window.MusterCore in the page, importScripts() in the worker,
 * require() in the server and the tests. Everything that reads a portfolio,
 * builds a request file, reads results, decides a case, does the 6% math,
 * chains the audit log or checks an AI letter lives here, so the page, the
 * worker, the server's validation and the tests run the same code. No
 * clock, no dice, no network, no storage: "today", a batch id and SHA-256
 * are handed in.
 *
 * What is in here, top to bottom:
 *   - text cleaning and escaping (the one door every file string goes through)
 *   - dates, money (integer cents) and rates (ten-thousandths of a percent)
 *   - a CSV / TSV reader (RFC 4180 quoting, any delimiter, BOM, a preamble)
 *   - the portfolio's columns: guessing from header names and value shapes
 *   - loans and borrowers built from a mapped file, and the row checks
 *     (SSN shape and never-issued numbers, dates of birth, names cut and
 *     folded, duplicates, unreadable rates and dates)
 *   - the request layout (editable, checked for overlaps) and the
 *     fixed-width builder, customer record ids, the batch record
 *   - the results readers (CSV with headers, fixed width by spans)
 *   - matching results back, deciding each case, the 6% math
 *   - the worklist, the SHA-256-chained audit log, the exports
 *   - the letter template, the AI letter's request and its checks
 *   - settings (layouts and preferences only - never a borrower)
 *   - the storage guards: what may be kept on this device, and nothing else
 *
 * THE STATUTE POINTS (50 U.S.C. § 3937) this file states are in RULES and
 * nowhere else; the page and every export quote them from there. Muster is a
 * starting checklist, not legal advice - your policy and counsel decide.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MusterCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    fileBytes: 25 * 1024 * 1024,   // a file bigger than this is refused before it is read
    rows: 250000,                   // portfolio rows kept from one file
    resultLines: 500000,            // result lines kept from one file (two borrowers a loan)
    columns: 80,
    cell: 300,                      // characters kept from one cell
    headerChars: 60,
    presets: 10,
    noteChars: 600,
    initialsChars: 8,
    templateChars: 6000,
    servicerChars: 80,
    contactChars: 160,
    letterChars: 4000,
    subjectChars: 120,
    groupRows: 200,                 // rows listed per row-check group (all are counted)
    previewLines: 14,
    splitMin: 50,
    splitMax: 250000,
    auditEvents: 200000,
  };

  /* ================================================================== *
   * The statute points - the only legal statements Muster makes
   * ================================================================== */

  var RULES = {
    cap: 'Interest on an obligation or liability incurred by the servicemember (or the servicemember and spouse jointly) before military service is capped at 6% a year during military service.',
    mortgage: 'For a mortgage, trust deed or other security in the nature of a mortgage, the cap runs during military service and one year after.',
    forgiven: 'Interest above 6% is forgiven, not deferred, and the periodic payment must be reduced by the forgiven interest.',
    fees: 'Interest includes service charges, renewal charges, fees and other charges (except bona fide insurance).',
    notice: 'The servicemember gives written notice and a copy of orders no later than 180 days after release from service; the cap then applies as of the date they were called to military service.',
    dmdc: 'DMDC’s SCRA website checks active duty on a status date, whether the person left active duty within the 367 days before it, and whether they were notified of a future call-up; the status date cannot be in the future.',
  };
  var CITATION = '50 U.S.C. § 3937';
  var NOT_ADVICE = 'A starting checklist, not legal advice - your policy and counsel decide.';
  var ESTIMATE = 'An estimate - your servicing system calculates the exact amount from the payment history.';

  /* ================================================================== *
   * Text: one door for every string a file, a person or a model wrote
   * ================================================================== */

  // Control characters, bidi overrides and zero-width characters: each is
  // invisible or reorders text, so in a name or a loan id it could make one
  // record look like another.
  var BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
  var BAD1 = new RegExp(BAD.source);
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  function esc(v) { return str(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function clip(s, n) { return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).replace(/\s+$/, '') + '…'; }
  /** One line, invisible characters gone, bounded. */
  function line(v, max) { return clip(str(v).replace(BAD, '').replace(/\s+/g, ' ').trim(), max || 200); }
  /** Several lines kept (a letter, a note), invisible characters gone, bounded. */
  function para(v, max) {
    return clip(str(v).replace(/\r\n?/g, '\n').replace(BAD, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(), max || 2000);
  }
  function noMarkup(s) { return str(s).replace(/<[^>]{0,200}>/g, '').replace(/[<>]/g, ''); }
  function plural(n, one, many) { return groups(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  /** $1,234.56 from integer cents. */
  function money(cents) {
    if (typeof cents !== 'number' || !isFinite(cents)) return '';
    var neg = cents < 0, c = Math.abs(Math.round(cents));
    return (neg ? '-' : '') + '$' + groups(Math.floor(c / 100)) + '.' + ('0' + (c % 100)).slice(-2);
  }
  /** 1234.56 for a spreadsheet. */
  function plainMoney(cents) {
    if (typeof cents !== 'number' || !isFinite(cents)) return '';
    var c = Math.abs(Math.round(cents));
    return (cents < 0 ? '-' : '') + Math.floor(c / 100) + '.' + ('0' + (c % 100)).slice(-2);
  }
  /** A loan id with all but the last four characters masked: ••••2041. */
  function mask(v) {
    var s = line(v, 60);
    if (!s) return '';
    return s.length <= 4 ? '••••' : '••••' + s.slice(-4);
  }

  /* ================================================================== *
   * Dates (YYYY-MM-DD strings, UTC day counts)
   * ================================================================== */

  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function pad2(n) { return ('0' + n).slice(-2); }
  function ymd(y, m, d) {
    if (!(y >= 1900 && y <= 2199 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    var t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCMonth() !== m - 1) return null;
    return y + '-' + pad2(m) + '-' + pad2(d);
  }
  function isDay(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && ymd(+v.slice(0, 4), +v.slice(5, 7), +v.slice(8, 10)) === v; }
  function dayNum(iso) { return Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000); }
  function fromDayNum(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  function addDays(iso, n) { return fromDayNum(dayNum(iso) + n); }
  /** The same day a year later (29 Feb -> 28 Feb). */
  function addYears(iso, n) {
    var y = +iso.slice(0, 4) + n, m = +iso.slice(5, 7), d = +iso.slice(8, 10);
    return ymd(y, m, d) || ymd(y, m, d - 1);
  }
  function daysBetween(a, b) { return isDay(a) && isDay(b) ? dayNum(b) - dayNum(a) : null; }
  function minDay(a, b) { return !a ? b : !b ? a : (a < b ? a : b); }
  function maxDay(a, b) { return !a ? b : !b ? a : (a > b ? a : b); }
  /** 9 Nov 2026 - unambiguous on the page and in every export. */
  function niceDay(iso) {
    if (!isDay(iso)) return '';
    return (+iso.slice(8, 10)) + ' ' + cap1(MONTHS[+iso.slice(5, 7) - 1]) + ' ' + iso.slice(0, 4);
  }
  /** November 9, 2026 - for a letter. */
  function letterDay(iso) {
    if (!isDay(iso)) return '';
    return MONTH_LONG[+iso.slice(5, 7) - 1] + ' ' + (+iso.slice(8, 10)) + ', ' + iso.slice(0, 4);
  }
  function compact(iso) { return isDay(iso) ? iso.replace(/-/g, '') : ''; }
  function year2(y) { return y < 100 ? (y < 40 ? 2000 + y : 1900 + y) : y; }
  function monthOf(w) { var i = MONTHS.indexOf(String(w || '').toLowerCase().slice(0, 3)); return i < 0 ? 0 : i + 1; }

  /**
   * A date the way a portfolio export writes it, as YYYY-MM-DD, or null.
   * order: 'mdy' (US, the default) or 'dmy' for n/n/yyyy. An 8-digit
   * yyyymmdd and an Excel serial day are read only when `loose` is set (the
   * column was mapped as a date), because both look like other numbers.
   */
  function readDate(v, order, loose) {
    var s = line(v, 40);
    if (!s) return null;
    var m;
    if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2}|[AaPp][Mm])?)?$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?)?$/.exec(s))) {
      var a = +m[1], b = +m[2], y = year2(+m[3]);
      return order === 'dmy' ? ymd(y, b, a) : ymd(y, a, b);
    }
    if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) return monthOf(m[1]) ? ymd(+m[3], monthOf(m[1]), +m[2]) : null;
    if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{2}|\d{4})$/.exec(s))) return monthOf(m[2]) ? ymd(year2(+m[3]), monthOf(m[2]), +m[1]) : null;
    if (loose && (m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
    if (loose && /^\d{5}$/.test(s) && +s > 3000 && +s < 80000) return fromDayNum(Math.round(Date.UTC(1899, 11, 30) / 86400000) + (+s));
    return null;
  }
  /** Which way a column's n/n/yyyy dates run: 'mdy' or 'dmy' when a part
   *  over 12 says so, 'either' when every value reads both ways (03/04),
   *  'none' when the column has no n/n/yyyy dates. */
  function dateOrder(values) {
    var dmy = 0, mdy = 0, both = 0;
    for (var i = 0; i < values.length && i < 5000; i++) {
      var m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})/.exec(line(values[i], 40));
      if (!m) continue;
      if (+m[1] > 12) dmy++;
      else if (+m[2] > 12) mdy++;
      else if (+m[1] !== +m[2]) both++;
    }
    if (dmy || mdy) return dmy > mdy ? 'dmy' : 'mdy';
    return both ? 'either' : 'none';
  }
  /** The first value that reads two ways, for the question. */
  function ambiguousExample(values) {
    for (var i = 0; i < values.length && i < 5000; i++) {
      var s = line(values[i], 40), m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})/.exec(s);
      if (m && +m[1] <= 12 && +m[2] <= 12 && +m[1] !== +m[2]) return { raw: s, mdy: readDate(s, 'mdy'), dmy: readDate(s, 'dmy') };
    }
    return null;
  }
  /** A results file's date: YYYYMMDD, YYYY-MM-DD or MM/DD/YYYY - nothing else. */
  function readResultDate(v) {
    var s = line(v, 20);
    if (!s || /^0+$/.test(s.replace(/[-/]/g, ''))) return null;
    var m;
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return ymd(+m[3], +m[1], +m[2]);
    return null;
  }
  /** Yes/No/Y/N/True/False/1/0 -> true / false; anything else (blank) -> null. */
  function readYesNo(v) {
    var s = line(v, 12).toLowerCase();
    if (/^(y|yes|true|1)$/.test(s)) return true;
    if (/^(n|no|false|0)$/.test(s)) return false;
    return null;
  }

  /* ================================================================== *
   * Money - integer cents, never floats
   * ================================================================== */

  /** {cents, negative} from "$1,234.56", "1234.56", "1.234,56", "(12.00)"; null when not an amount. */
  function readMoney(v) {
    var s = line(v, 40);
    if (!s || !/\d/.test(s)) return null;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    s = s.replace(/^(usd|us\$)\s*/i, '').replace(/\s*usd$/i, '');
    if (/^-/.test(s)) { neg = true; s = s.slice(1).trim(); }
    if (/-$/.test(s)) { neg = true; s = s.slice(0, -1).trim(); }
    s = s.replace(/^\$\s*/, '');
    var whole, frac = '', m;
    if ((m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s))) { whole = m[1].replace(/,/g, ''); frac = m[2] || ''; }
    else if ((m = /^(\d{1,3}(?:\.\d{3})+|\d+),(\d{1,2})$/.exec(s))) { whole = m[1].replace(/\./g, ''); frac = m[2]; }
    else return null;
    if (whole.length > 11) return null;
    var cents = Number(whole) * 100 + (frac ? Number((frac + '0').slice(0, 2)) : 0);
    if (!isFinite(cents)) return null;
    return { cents: cents, negative: neg && cents > 0 };
  }
  function moneyCents(v) { var m = readMoney(v); return m && !m.negative ? m.cents : null; }

  /* ================================================================== *
   * Rates - integer ten-thousandths of a percent: 6% = 60000, 8.99% = 89900
   * ================================================================== */

  var CAP_U = 60000;
  /** {num, pct} from "9.49", "9.49%", "0.0949"; null when not a rate. */
  function readRate(v) {
    var s = line(v, 30).replace(/\s+/g, '');
    if (!s) return null;
    var pct = /%$/.test(s);
    s = s.replace(/%$/, '').replace(/^(apr|rate)[:=]?/i, '');
    if (!/^\d{0,3}(?:\.\d{1,8})?$/.test(s) || !/\d/.test(s)) return null;
    var num = Number(s);
    if (!isFinite(num) || num < 0 || num > 100) return null;
    return { num: num, pct: pct };
  }
  /** Rate units from a read rate: a fraction (0.0949) when `fraction`. */
  function rateUnits(r, fraction) {
    if (!r) return null;
    var u = Math.round(r.num * (fraction && !r.pct ? 1000000 : 10000));
    return u >= 0 && u <= 1000000 ? u : null;
  }
  /** 8.99% / 6.875% / 6.00% (never fewer than two places). */
  function rateText(u) {
    if (typeof u !== 'number' || !isFinite(u)) return '';
    var s = (u / 10000).toFixed(4).replace(/0+$/, '');
    if (/\.\d?$/.test(s)) s = (u / 10000).toFixed(2);
    return s + '%';
  }
  /** The points over the cap: 2.99 points. */
  function pointsText(u) { return rateText(Math.abs(u)).replace('%', '') + ' points'; }

  /* ================================================================== *
   * Reading a file: CSV / TSV with RFC 4180 quoting
   * ================================================================== */

  var DELIMS = [',', ';', '\t', '|'];
  var DELIM_NAME = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };

  /** Split text into rows of raw fields. Quoted fields may hold the
   *  delimiter, doubled quotes and line breaks; CRLF, LF and CR all end a
   *  row. Stops storing after maxRows (it keeps counting) and caps each
   *  field at maxCell characters as it reads. Each row remembers its line. */
  function splitRows(text, delim, maxRows, maxCell) {
    var rows = [], lines = [], row = [], i = 0, n = text.length, total = 0, openQuote = false, ln = 1, rowLine = 1;
    var dc = delim.charCodeAt(0);
    var keep = maxRows === undefined ? Infinity : maxRows;
    var cap = maxCell || 100000;
    function endRow() {
      if (row.length === 1 && row[0] === '') { row = []; return; }
      total++;
      if (rows.length < keep) { rows.push(row); lines.push(rowLine); }
      row = [];
    }
    while (i <= n) {
      if (i === n) { if (row.length) endRow(); break; }
      if (!row.length) rowLine = ln;
      var c = text.charCodeAt(i);
      if (c === 34) {
        var buf = '', j = i + 1;
        for (;;) {
          var q = text.indexOf('"', j);
          if (q < 0) { buf += text.slice(j, Math.min(n, j + cap)); j = n; openQuote = true; break; }
          var chunk = text.slice(j, q);
          for (var x = chunk.indexOf('\n'); x >= 0; x = chunk.indexOf('\n', x + 1)) ln++;
          if (buf.length < cap) buf += chunk.slice(0, cap);
          if (text.charCodeAt(q + 1) === 34) { if (buf.length < cap) buf += '"'; j = q + 2; continue; }
          j = q + 1; break;
        }
        var k = j;
        while (k < n) { var ck = text.charCodeAt(k); if (ck === dc || ck === 10 || ck === 13) break; k++; }
        if (k > j && buf.length < cap) buf += text.slice(j, Math.min(k, j + cap));
        row.push(buf.length > cap ? buf.slice(0, cap) : buf);
        i = k;
      } else {
        var e = i;
        while (e < n) { var ce = text.charCodeAt(e); if (ce === dc || ce === 10 || ce === 13) break; e++; }
        row.push(e - i > cap ? text.slice(i, i + cap) : text.slice(i, e));
        i = e;
      }
      if (i >= n) { endRow(); break; }
      var d = text.charCodeAt(i);
      if (d === dc) { i++; if (i === n) { row.push(''); endRow(); break; } continue; }
      if (d === 13 && text.charCodeAt(i + 1) === 10) i += 2; else i++;
      ln++;
      endRow();
    }
    return { rows: rows, lines: lines, total: total, openQuote: openQuote };
  }

  /** Which delimiter: the one that splits the first rows most consistently
   *  into more than one field. A "sep=;" first line (Excel's hint) wins. */
  function sniffDelimiter(text) {
    var head = text.slice(0, 65536);
    var hint = /^sep=(.)\r?\n/i.exec(head);
    if (hint && DELIMS.indexOf(hint[1]) >= 0) return hint[1];
    var best = ',', bestScore = -1;
    DELIMS.forEach(function (d) {
      var r = splitRows(head, d, 40, 400).rows;
      var counts = {};
      r.forEach(function (x) { counts[x.length] = (counts[x.length] || 0) + 1; });
      var mode = 1, modeN = 0;
      Object.keys(counts).forEach(function (k) { if (counts[k] > modeN || (counts[k] === modeN && +k > mode)) { mode = +k; modeN = counts[k]; } });
      if (mode < 2) return;
      var score = modeN * 10 + Math.min(mode, 30);
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return bestScore < 0 ? null : best;
  }

  function cell(v, stats) {
    var s = str(v);
    var bad = s.match(BAD);
    if (bad) { stats.invisible += bad.length; s = s.replace(BAD, ''); }
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > LIMITS.cell) { stats.cut++; s = clip(s, LIMITS.cell); }
    return s;
  }
  function looksLikeData(r) {
    var n = 0, data = 0;
    r.forEach(function (v) { if (!v) return; n++; if (readMoney(v) || readDate(v) || /^\d{3,}$/.test(v.replace(/[\s-]/g, ''))) data++; });
    return n > 0 && data / n >= 0.5;
  }

  /** A whole file, read: {headers, rows, lines, delimiter, header, preamble,
   *  total, kept, truncated, ragged, invisible, cut, openQuote, empty}. */
  function parseTable(text, opts) {
    opts = opts || {};
    var max = opts.maxRows || LIMITS.rows;
    var t = str(text);
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    var delim = opts.delimiter || sniffDelimiter(t) || ',';
    var hint = /^sep=.\r?\n/i.exec(t);
    if (hint) t = t.slice(hint[0].length);
    var sp = splitRows(t, delim, max + 12, LIMITS.cell * 4);
    var raw = sp.rows;
    var stats = { invisible: 0, cut: 0 };
    var out = { headers: [], rows: [], lines: [], delimiter: delim, delimiterName: DELIM_NAME[delim], header: true, preamble: 0, total: 0, kept: 0, truncated: 0, ragged: 0, invisible: 0, cut: 0, openQuote: sp.openQuote, empty: false, wide: 0 };
    if (!raw.length) { out.empty = true; return out; }
    var counts = {};
    raw.slice(0, 50).forEach(function (r) { if (r.length > 1) counts[r.length] = (counts[r.length] || 0) + 1; });
    var mode = 1, modeN = 0;
    Object.keys(counts).forEach(function (k) { if (counts[k] > modeN || (counts[k] === modeN && +k > mode)) { mode = +k; modeN = counts[k]; } });
    var h = 0;
    if (mode > 1) { while (h < Math.min(raw.length, 10) && raw[h].length < mode) h++; if (h >= raw.length || raw[h].length < mode) h = 0; }
    out.preamble = h;
    var width = Math.min(Math.max(mode, raw[h].length), LIMITS.columns);
    if (Math.max(mode, raw[h].length) > LIMITS.columns) out.wide = Math.max(mode, raw[h].length) - LIMITS.columns;
    var first = raw[h].slice(0, width).map(function (v) { return cell(v, stats); });
    var start = h + 1;
    if (looksLikeData(first)) { out.header = false; start = h; first = first.map(function (_, i) { return 'Column ' + (i + 1); }); }
    var seen = {};
    out.headers = first.map(function (x, i) {
      var name = line(x, LIMITS.headerChars) || 'Column ' + (i + 1);
      var key = name.toLowerCase(), k = 2;
      while (seen[key]) { name = line(x, LIMITS.headerChars - 4) + ' (' + k++ + ')'; key = name.toLowerCase(); }
      seen[key] = 1;
      return name;
    });
    while (out.headers.length < width) out.headers.push('Column ' + (out.headers.length + 1));
    for (var i = start; i < raw.length && out.rows.length < max; i++) {
      var r = raw[i];
      if (r.length !== width) out.ragged++;
      var row = [];
      for (var c = 0; c < width; c++) row.push(cell(r[c], stats));
      if (row.every(function (v) { return v === ''; })) continue;
      out.rows.push(row);
      out.lines.push(sp.lines[i]);
    }
    out.total = Math.max(0, sp.total - start);
    out.kept = out.rows.length;
    out.truncated = Math.max(0, out.total - out.kept);
    out.invisible = stats.invisible;
    out.cut = stats.cut;
    return out;
  }

  /* ================================================================== *
   * The portfolio's columns: the fields, the guess from headers and shapes
   * ================================================================== */

  var PERSON_PARTS = ['Ssn', 'Dob', 'Last', 'First', 'Middle', 'Full'];
  var PART_LABEL = { Ssn: 'SSN', Dob: 'date of birth', Last: 'last name', First: 'first name', Middle: 'middle name', Full: 'full name (only if there are no separate name columns)' };
  var LOAN_FIELDS = [
    { key: 'loan', label: 'Loan id', need: true },
    { key: 'orig', label: 'Origination date', want: true },
    { key: 'rate', label: 'Note rate / APR', want: true },
    { key: 'bal', label: 'Current principal balance', want: true },
    { key: 'pay', label: 'Monthly payment' },
    { key: 'fees', label: 'Monthly fees (counted as interest)' },
    { key: 'type', label: 'Loan type', want: true },
    { key: 'applied', label: 'SCRA already applied (a flag or a date)' },
  ];
  var PFIELDS = (function () {
    var out = [LOAN_FIELDS[0]];
    [1, 2].forEach(function (b) {
      PERSON_PARTS.forEach(function (p) {
        out.push({ key: 'b' + b + p, label: 'Borrower ' + b + (b === 2 ? ' (co-borrower)' : '') + ' ' + PART_LABEL[p], b: b, part: p, need: b === 1 && p === 'Ssn', want: b === 1 && (p === 'Dob' || p === 'Last' || p === 'First') });
      });
    });
    return out.concat(LOAN_FIELDS.slice(1));
  }());
  var PKEYS = PFIELDS.map(function (f) { return f.key; });
  function pfield(key) { return PFIELDS.filter(function (f) { return f.key === key; })[0] || null; }
  var LOAN_TYPES = ['mortgage', 'auto', 'card', 'personal', 'student', 'other'];
  var TYPE_WORD = { mortgage: 'Mortgage', auto: 'Auto', card: 'Card', personal: 'Personal', student: 'Student', other: 'Other' };

  function headerNorm(h) {
    return str(h).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/[_./\\#()[\]:-]+/g, ' ').replace(/[^a-z0-9%& ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  var SLOT2 = /\b(co|coborrower|coborr|cobrw|cob|cobor|co borrower|co borr|coapplicant|co applicant|joint|secondary|second|2nd|spouse|cosigner|co signer|b 2|borrower 2|borr 2|brw 2|bor 2|applicant 2|app 2|member 2)\b|\b2$/;
  var SLOT1 = /\b(b 1|borrower 1|borr 1|brw 1|bor 1|primary|prim|1st|applicant 1|app 1|member 1)\b|\b1$/;
  function slotOf(norm) { return SLOT2.test(norm) ? 2 : 1; }
  function stripSlot(norm) { return norm.replace(SLOT2, ' ').replace(SLOT1, ' ').replace(/\b(borrower|borr|brw|bor|customer|cust|member|applicant|primary)\b/g, function (w) { return ' ' + w + ' '; }).replace(/\s+/g, ' ').trim(); }

  var PRULES = {
    Ssn: /\b(ssn|ss n|ss no|ss num|social security( number| no| num)?|social|soc sec|ssno|tin|tax id|taxpayer id)\b/,
    Dob: /\b(dob|date of birth|birth date|birthdate|birth|d o b|bdate|bday)\b/,
    Last: /\b(last name|lastname|last nm|surname|family name|lname|last)\b/,
    First: /\b(first name|firstname|first nm|given name|forename|fname|first)\b/,
    Middle: /\b(middle name|middlename|middle initial|middle|mname|mi|mid init)\b/,
    Full: /\b(full name|name|borrower|customer|member|applicant|cobrw|coborrower|co borrower)\b/,
    loan: /\b(loan (number|no|num|id|key)|loan ?num|loan ?no|loan ?id|loan|acct (no|number|num|id)|account (number|no|num|id)|account|acct|note (number|no))\b/,
    orig: /\b(origination( date)?|orig( date)?|opened|open date|date opened|note date|funded|funding date|booked|booking date|contract date|disbursed|disbursement date|loan date|open)\b/,
    rate: /\b(note rate|interest rate|int rate|apr|rate|coupon)\b/,
    bal: /\b(principal balance|current balance|curr bal|prin bal|upb|unpaid principal|balance|bal|principal|outstanding)\b/,
    pay: /\b(monthly payment|payment amount|pmt amt|payment|pmt|installment|p i|pi|scheduled payment|sched pmt)\b|(^|\s)p ?& ?i(\s|$)/,
    fees: /\b(monthly fees?|fees?|service charges?|charges)\b/,
    type: /\b(loan type|product type|product code|product|type|class|category|collateral|purpose|portfolio)\b/,
    applied: /\b(scra|sscra|servicemember|military|mil rate|cap applied|6 pct|six percent)\b/,
  };
  var PNOT = {
    Ssn: /\b(date|verified|flag|match)\b/,
    Dob: /\b(place|city|country)\b/,
    Last: /\b(date|officer|dealer|employer|payment|paid|updated|modified|review|reviewed|contact|login)\b/,
    First: /\b(date|officer|dealer|employer|payment|due|lien|mortgage|time|paid)\b/,
    Middle: /\b(date|officer|dealer|employer)\b/,
    Full: /\b(last|first|middle|type|officer|branch|product|servicer|lender|loan name|dealer|employer|ssn|social|dob|birth|id|number|no|count|since|date)\b/,
    loan: /\b(type|amount|amt|rate|date|officer|purpose|status|term|balance|bal|payment|pmt|class|product|name|ssn|fee|fees|count)\b/,
    orig: /\b(birth|dob|amount|amt|balance|bal|rate|officer|term|payment|fee)\b/,
    rate: /\b(type|index|margin|change|reset|date|floor|ceiling|lock|code|fee|cap applied|scra|military)\b/,
    bal: /\b(orig|original|date|high|limit|available|escrow)\b/,
    pay: /\b(date|last|next|due|count|method|frequency|freq|type|history|status|number|no)\b/,
    fees: /\b(late|nsf|date|total paid|insurance|type|code)\b/,
    type: /\b(rate type|payment type|fee type|name|date|id type|scra)\b/,
    applied: /\b(start|end|eligib)\b/,
  };
  var TYPE_WORDS = {
    mortgage: /\b(mortgage|mtg|mortg|mort|heloc|home equity|he loc|he|first lien|1st lien|2nd lien|second lien|real estate|re|residential|deed|trust deed|home loan|arm|conventional|conv|fha|va|usda|1st mtg|2nd mtg)\b/,
    auto: /\b(auto|vehicle|car|truck|suv|motorcycle|rv|boat|marine|indirect|powersports?|new auto|used auto)\b/,
    card: /\b(card|credit card|visa|mastercard|master card|cc|revolving|rewards|amex)\b/,
    student: /\b(student|education|edu|stu|private student)\b/,
    personal: /\b(personal|signature|unsecured|share secured|cd secured|installment|consumer|ploan|pl|line of credit|loc)\b/,
  };
  /** The loan type a value reads as, with 'likely' for a guess worth a look. */
  function typeOf(v) {
    var s = headerNorm(v);
    if (!s) return { type: 'other', sure: false };
    if (/\b(home equity|heloc|he loc|he)\b/.test(s)) return { type: 'mortgage', sure: false };
    var order = ['mortgage', 'auto', 'card', 'student', 'personal'];
    for (var i = 0; i < order.length; i++) if (TYPE_WORDS[order[i]].test(s)) return { type: order[i], sure: true };
    return { type: 'other', sure: false };
  }

  var SSN_SHAPE = /^\d{3}[- ]?\d{2}[- ]?\d{4}$/;
  /** What a column's values look like. */
  function profile(values) {
    var p = { n: 0, ssn: 0, date: 0, years: [], money: 0, cents: [], rate: 0, rateMax: 0, alpha: 0, spaced: 0, short: 0, digits: 0, yesno: 0, typeWords: 0, distinct: 0, alnum: 0, lens: 0 };
    var seen = {};
    for (var i = 0; i < values.length && i < 600; i++) {
      var v = values[i];
      if (!v) continue;
      p.n++;
      if (!seen[v]) { seen[v] = 1; p.distinct++; }
      p.lens += v.length;
      if (SSN_SHAPE.test(v)) p.ssn++;
      var d = readDate(v, 'mdy', true);
      if (d) { p.date++; p.years.push(+d.slice(0, 4)); }
      var m = readMoney(v);
      if (m && /[.,]\d{2}$|^\$/.test(v)) { p.money++; p.cents.push(m.cents); }
      var r = readRate(v);
      if (r && (/[.%]/.test(v)) && r.num <= 40) { p.rate++; if (r.num > p.rateMax) p.rateMax = r.num; }
      if (/^[A-Za-zÀ-ÿ' .,-]+$/.test(v)) p.alpha++;
      if (/[ ,]/.test(v.trim())) p.spaced++;
      if (v.replace(/\./g, '').length <= 2) p.short++;
      if (/^\d+$/.test(v)) p.digits++;
      if (readYesNo(v) !== null) p.yesno++;
      if (typeOf(v).sure) p.typeWords++;
      if (/^[A-Za-z0-9-]+$/.test(v) && /\d/.test(v)) p.alnum++;
    }
    return p;
  }
  function frac(p, k) { return p.n ? p[k] / p.n : 0; }
  function median(a) { if (!a.length) return 0; var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; }

  /** Points a column's values earn for a field. */
  function shapePoints(key, p) {
    var part = key.charAt(0) === 'b' && /^b[12]/.test(key) ? key.slice(2) : key;
    if (!p.n) return 0;
    var yr = median(p.years);
    switch (part) {
      case 'Ssn': return frac(p, 'ssn') >= 0.8 ? 9 : -6;
      case 'Dob': return frac(p, 'date') >= 0.8 ? (yr < 2012 && yr > 1905 ? 6 : -5) : -6;
      case 'orig': return frac(p, 'date') >= 0.8 ? (yr >= 1980 ? 4 : -5) : -6;
      case 'Last': case 'First': return frac(p, 'alpha') >= 0.8 ? 3 : -4;
      case 'Middle': return frac(p, 'alpha') >= 0.8 ? (frac(p, 'short') >= 0.6 ? 3 : 2) : -4;
      case 'Full': return frac(p, 'alpha') >= 0.8 && frac(p, 'spaced') >= 0.7 ? 3 : -4;
      case 'loan': return p.distinct >= p.n * 0.9 && frac(p, 'alnum') + frac(p, 'digits') >= 0.6 ? 3 : -2;
      case 'rate': return frac(p, 'rate') >= 0.9 ? 5 : -5;
      case 'bal': return frac(p, 'money') >= 0.9 ? (median(p.cents) >= 50000 ? 3 : 1) : -4;
      case 'pay': return frac(p, 'money') >= 0.9 ? 3 : -4;
      case 'fees': return frac(p, 'money') >= 0.9 ? (median(p.cents) <= 10000 ? 2 : 0) : -3;
      case 'type': return frac(p, 'typeWords') >= 0.6 ? 6 : (p.distinct <= 12 ? 1 : -4);
      case 'applied': return frac(p, 'yesno') + frac(p, 'date') >= 0.9 ? 3 : -2;
      default: return 0;
    }
  }
  /** Header points for a field: 10 for a clear name, 0 for none. */
  function headerPoints(key, raw) {
    var norm = headerNorm(raw);
    if (!norm) return 0;
    var fd = pfield(key);
    if (fd && fd.b) {
      if (slotOf(norm) !== fd.b) return 0;
      var base = stripSlot(norm);
      if (PNOT[fd.part] && PNOT[fd.part].test(base)) return 0;
      if (fd.part === 'Full' && (PRULES.Last.test(base) || PRULES.First.test(base) || PRULES.Middle.test(base))) return 0;
      return PRULES[fd.part].test(base) ? (fd.part === 'Full' ? 7 : 10) : 0;
    }
    if (PNOT[key] && PNOT[key].test(norm)) return 0;
    return PRULES[key] && PRULES[key].test(norm) ? 10 : 0;
  }

  /**
   * Which column is which: {map: {field: column index}, conf: {field:
   * 'sure'|'likely'|'unsure'}}. Header points plus value-shape points; best
   * pair first, each column and each field once. A field with no header
   * match is placed only when its values can hardly be anything else (nine
   * digit numbers for borrower 1's SSN, loan-type words for the type).
   */
  function guessColumns(headers, rows) {
    var cols = headers.map(function (h, i) { return profile(rows.map(function (r) { return r[i] || ''; })); });
    var cands = [];
    PKEYS.forEach(function (key) {
      headers.forEach(function (h, i) {
        var hp = headerPoints(key, h), sp = shapePoints(key, cols[i]);
        var shapeOnly = !hp && ((key === 'b1Ssn' && sp >= 9) || (key === 'type' && sp >= 6));
        if (!hp && !shapeOnly) return;
        var score = hp + sp;
        // A clear header name wins even when a few hostile values spoil its shape; it is then only "likely".
        if (score < 7 && hp < 10) return;
        cands.push({ key: key, i: i, score: score, conf: hp && sp > 0 ? 'sure' : hp ? 'likely' : 'unsure' });
      });
    });
    cands.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    var map = {}, conf = {}, used = {};
    PKEYS.forEach(function (k) { map[k] = null; });
    cands.forEach(function (c) {
      if (map[c.key] !== null || used[c.i]) return;
      map[c.key] = c.i; conf[c.key] = c.conf; used[c.i] = true;
    });
    [1, 2].forEach(function (b) {
      if (map['b' + b + 'Full'] !== null && (map['b' + b + 'Last'] !== null)) { used[map['b' + b + 'Full']] = false; map['b' + b + 'Full'] = null; delete conf['b' + b + 'Full']; }
    });
    return { map: map, conf: conf, profiles: cols.map(function (p) { return { n: p.n, ssn: frac(p, 'ssn'), date: frac(p, 'date'), rateMax: p.rateMax, rate: frac(p, 'rate') }; }) };
  }

  /** What stops building from this mapping, in words. */
  function mappingProblems(map) {
    var out = [];
    if (!map || map.loan === null || map.loan === undefined) out.push('Choose the column with the loan id.');
    if (!map || map.b1Ssn === null || map.b1Ssn === undefined) out.push('Choose the column with borrower 1’s SSN.');
    if (!map || ((map.b1Last === null || map.b1Last === undefined) && (map.b1Full === null || map.b1Full === undefined))) out.push('Choose borrower 1’s last name (or a full-name column).');
    var seen = {};
    PKEYS.forEach(function (k) { var i = map && map[k]; if (i === null || i === undefined) return; if (seen[i]) out.push('One column is chosen for two fields.'); seen[i] = 1; });
    return out.filter(function (x, i, a) { return a.indexOf(x) === i; });
  }
  /** Is a header safe to remember (a name, not a value)? */
  function headerOk(h) {
    var s = str(h);
    return Boolean(s) && s.length <= LIMITS.headerChars && !/@|\d{3,}|\d[-/.:]\d|[<>{}`\\]/.test(s) && !BAD1.test(s);
  }
  /** A preset: the header names a team's export uses, never a value. */
  function presetFrom(headers, map) {
    var out = {};
    PKEYS.forEach(function (k) { var i = map[k]; if (i !== null && i !== undefined && headers[i] && headerOk(headers[i])) out[k] = headers[i]; });
    return out;
  }
  function applyPreset(headers, presets) {
    var lower = headers.map(function (h) { return str(h).toLowerCase(); });
    var best = null, bestN = 0;
    (presets || []).forEach(function (p) {
      if (p.kind !== 'portfolio') return;
      var keys = Object.keys(p.map || {}), hit = keys.filter(function (k) { return lower.indexOf(str(p.map[k]).toLowerCase()) >= 0; }).length;
      if (keys.length && hit / keys.length >= 0.8 && hit > bestN) { best = p; bestN = hit; }
    });
    if (!best) return null;
    var map = {};
    Object.keys(best.map).forEach(function (k) { var i = lower.indexOf(str(best.map[k]).toLowerCase()); if (i >= 0) map[k] = i; });
    return { name: best.name, map: map };
  }

  /* ================================================================== *
   * Names, SSNs and dates of birth - checked on the device, never kept
   * ================================================================== */

  /** A name the way a fixed-width file can carry it: accents folded to ASCII,
   *  only A-Z, space, hyphen and apostrophe kept, upper-cased. */
  var FOLDED = new Map();
  function fold(raw) {
    var key = str(raw);
    var hit = FOLDED.get(key);
    if (hit) return hit;
    var out = foldNow(key);
    if (FOLDED.size > 50000) FOLDED.clear();
    FOLDED.set(key, out);
    return out;
  }
  function foldNow(raw) {
    var s = str(raw).replace(BAD, '');
    var t = s.replace(/[ßẞ]/g, 'SS').replace(/[Ææ]/g, 'AE').replace(/[Œœ]/g, 'OE').replace(/[Øø]/g, 'O').replace(/[Łł]/g, 'L').replace(/[Đđ]/g, 'D').replace(/[Þþ]/g, 'TH').replace(/[Ðð]/g, 'D').replace(/[ıİ]/g, 'I');
    if (t.normalize) t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
    t = t.replace(/[‘’ʼ`´]/g, "'").replace(/[‐-―]/g, '-').toUpperCase();
    t = t.replace(/[^A-Z '-]+/g, ' ').replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-').replace(/^[ '-]+|[ '-]+$/g, '').trim();
    var before = line(s, 120).toUpperCase().replace(/\s+/g, ' ');
    return { text: t, changed: t !== before };
  }
  /** "LAST, FIRST MIDDLE" or "FIRST MIDDLE LAST" -> parts. */
  function splitFull(raw) {
    var s = line(raw, 120);
    if (!s) return { last: '', first: '', middle: '' };
    var suffix = '';
    var m;
    if ((m = /^([^,]+),\s*(.+)$/.exec(s))) {
      var rest = m[2].split(/\s+/);
      if (/^(jr|sr|ii|iii|iv)\.?$/i.test(rest[0]) && rest.length > 1) { suffix = rest.shift(); }
      return { last: m[1].trim() + (suffix ? ' ' + suffix : ''), first: rest.shift() || '', middle: rest.join(' ') };
    }
    var w = s.split(/\s+/);
    if (w.length > 1 && /^(jr|sr|ii|iii|iv)\.?$/i.test(w[w.length - 1])) suffix = w.pop();
    if (w.length === 1) return { last: w[0] + (suffix ? ' ' + suffix : ''), first: '', middle: '' };
    var last = w.pop();
    return { last: last + (suffix ? ' ' + suffix : ''), first: w.shift() || '', middle: w.join(' ') };
  }
  function ssnDigits(raw) { var s = line(raw, 30).replace(/[\s-]/g, ''); return s; }
  /** Why an SSN cannot be checked, or '' when it can. Never-issued numbers:
   *  area 000, 666 or 900-999, group 00, serial 0000. The example file is
   *  the one place the 900-999 area is let through. */
  function ssnProblem(digits, allowExample) {
    if (!digits) return 'missing';
    if (!/^\d{9}$/.test(digits)) return 'shape';
    var a = digits.slice(0, 3), g = digits.slice(3, 5), s = digits.slice(5);
    if (a === '000') return 'area 000';
    if (a === '666') return 'area 666';
    if (+a >= 900 && !allowExample) return 'area ' + a + ' (900-999)';
    if (g === '00') return 'group 00';
    if (s === '0000') return 'serial 0000';
    return '';
  }
  function maskSsn(digits) { var d = str(digits).replace(/\D/g, ''); return d.length >= 4 ? '•••-••-' + d.slice(-4) : '•••-••-••••'; }

  /* ================================================================== *
   * Loans and borrowers, from a mapped file
   * ================================================================== */

  function ruleFor(map, key, row) { var i = map[key]; return i === null || i === undefined ? '' : (row[i] || ''); }
  /** The questions a file needs answered once: day/month order, and whether rates are fractions. */
  function questions(table, map) {
    var q = { dates: null, fraction: null };
    var amb = null;
    ['b1Dob', 'b2Dob', 'orig'].forEach(function (k) {
      if (amb || map[k] === null || map[k] === undefined) return;
      var vals = table.rows.map(function (r) { return r[map[k]] || ''; });
      if (dateOrder(vals) === 'either') amb = ambiguousExample(vals);
    });
    q.dates = amb;
    if (map.rate !== null && map.rate !== undefined) {
      var n = 0, small = 0, pct = 0, ex = '';
      for (var i = 0; i < table.rows.length; i++) {
        var r = readRate(table.rows[i][map.rate]);
        if (!r) continue;
        n++; if (r.pct) pct++;
        if (r.num <= 1) { small++; if (!ex) ex = table.rows[i][map.rate]; }
      }
      if (n && small === n && !pct) q.fraction = { example: ex, asFraction: rateText(Math.round(Number(ex) * 1000000)), asPercent: rateText(Math.round(Number(ex) * 10000)) };
    }
    return q;
  }
  /** Each date column's order: 'mdy' unless the values or the answer say dmy. */
  function orders(table, map, answer) {
    var out = {};
    ['b1Dob', 'b2Dob', 'orig'].forEach(function (k) {
      if (map[k] === null || map[k] === undefined) return;
      var o = dateOrder(table.rows.map(function (r) { return r[map[k]] || ''; }));
      out[k] = o === 'dmy' ? 'dmy' : o === 'either' ? (answer === 'dmy' ? 'dmy' : 'mdy') : 'mdy';
    });
    return out;
  }
  function person(row, map, b, ord) {
    var k = 'b' + b;
    var ssnRaw = ruleFor(map, k + 'Ssn', row), dobRaw = ruleFor(map, k + 'Dob', row);
    var last = ruleFor(map, k + 'Last', row), first = ruleFor(map, k + 'First', row), middle = ruleFor(map, k + 'Middle', row);
    var full = ruleFor(map, k + 'Full', row);
    if (full && !last && !first) { var sp = splitFull(full); last = sp.last; first = sp.first; middle = middle || sp.middle; }
    if (!ssnRaw && !dobRaw && !last && !first && !full) return null;
    return { b: b, ssn: ssnDigits(ssnRaw), ssnRaw: line(ssnRaw, 30), dob: readDate(dobRaw, ord[k + 'Dob'], true), dobRaw: line(dobRaw, 30), last: line(last, 120), first: line(first, 120), middle: line(middle, 120) };
  }
  function readApplied(v) {
    var s = line(v, 30);
    if (!s) return false;
    if (readYesNo(s) !== null) return readYesNo(s);
    if (/^(x|applied|active|on|scra|yes - applied)$/i.test(s)) return true;
    if (/^(none|off|n\/a|na|-)$/i.test(s)) return false;
    return Boolean(readDate(s, 'mdy', true));
  }
  /**
   * Loans from a mapped table. opts: {order (the day/month answer), fraction
   * (rates are fractions), typeMap ({normalised value: type})}. Each loan
   * carries its borrowers (with SSN, date of birth and names - kept in
   * memory only, never stored) and its line in the file.
   */
  function buildLoans(table, map, opts) {
    opts = opts || {};
    var ord = orders(table, map, opts.order);
    var typeMap = opts.typeMap || {};
    var loans = [];
    for (var i = 0; i < table.rows.length; i++) {
      var r = table.rows[i];
      var rateRaw = ruleFor(map, 'rate', r), origRaw = ruleFor(map, 'orig', r), typeRaw = ruleFor(map, 'type', r);
      var tn = headerNorm(typeRaw);
      var people = [];
      var p1 = person(r, map, 1, ord), p2 = person(r, map, 2, ord);
      if (p1) people.push(p1);
      if (p2) people.push(p2);
      loans.push({
        i: i, line: table.lines[i] || i + 2,
        loan: line(ruleFor(map, 'loan', r), 60),
        orig: readDate(origRaw, ord.orig, true), origRaw: line(origRaw, 30),
        rateU: rateUnits(readRate(rateRaw), opts.fraction), rateRaw: line(rateRaw, 30),
        bal: moneyCents(ruleFor(map, 'bal', r)), pay: moneyCents(ruleFor(map, 'pay', r)), fees: map.fees === null || map.fees === undefined ? 0 : (moneyCents(ruleFor(map, 'fees', r)) || 0),
        type: map.type === null || map.type === undefined ? 'other' : (typeMap[tn] || typeOf(typeRaw).type), typeRaw: line(typeRaw, 40),
        applied: map.applied === null || map.applied === undefined ? false : readApplied(ruleFor(map, 'applied', r)),
        people: people,
      });
    }
    return loans;
  }
  /** The distinct loan-type values and Muster's reading of each. */
  function typeValues(table, map) {
    if (map.type === null || map.type === undefined) return [];
    var seen = {}, out = [];
    for (var i = 0; i < table.rows.length; i++) {
      var raw = table.rows[i][map.type] || '', k = headerNorm(raw);
      if (seen[k] !== undefined) { out[seen[k]].n++; continue; }
      if (out.length >= 60) continue;
      seen[k] = out.length;
      var g = typeOf(raw);
      out.push({ key: k, raw: line(raw, 40) || '(blank)', type: g.type, sure: g.sure, n: 1 });
    }
    return out.sort(function (a, b) { return b.n - a.n; });
  }

  /* ================================================================== *
   * The row checks
   * ================================================================== */

  var CHECKS = {
    'loan-missing': { sev: 'block', title: 'No loan id', sentence: 'Without a loan id a result cannot be matched back to a loan. Left out of the file.' },
    'ssn-missing': { sev: 'block', title: 'No SSN', sentence: 'A borrower with no SSN cannot be checked. Left out of the file.' },
    'ssn-shape': { sev: 'block', title: 'SSN is not 9 digits', sentence: 'An SSN has 9 digits (dashes and spaces are fine). Left out of the file.' },
    'ssn-never': { sev: 'block', title: 'SSN that was never issued', sentence: 'No SSN starts 000, 666 or 900-999, has group 00 or serial 0000 - this one is mistyped or a placeholder. Left out of the file.' },
    'dob-missing': { sev: 'block', title: 'No date of birth', sentence: 'Muster leaves out a record without a usable date of birth. Fix it in your system and add it to a re-check file.' },
    'dob-bad': { sev: 'block', title: 'Date of birth unreadable', sentence: 'Muster could not read this as a date. Left out of the file.' },
    'dob-odd': { sev: 'block', title: 'Date of birth implausible', sentence: 'Before 1900, after the status date, or under 16 or over 110 years old on it. Left out of the file.' },
    'last-missing': { sev: 'block', title: 'No last name', sentence: 'A record needs a last name. Left out of the file.' },
    'crid-long': { sev: 'block', title: 'Customer record id too long', sentence: 'The loan id does not fit the customer record id field. Use “a short code from Muster” in the file options, or shorten the field’s ids. Left out of the file.' },
    'crid-dup': { sev: 'block', title: 'Two records would share a customer record id', sentence: 'Two loan ids clean to the same id (only A-Z and 0-9 are kept), so results could not tell them apart. Use “a short code from Muster”. The second is left out of the file.' },
    'first-missing': { sev: 'warn', title: 'No first name', sentence: 'Included, with the first name left blank.' },
    'cut': { sev: 'warn', title: 'Names cut to fit', sentence: 'Longer than the field in the request layout, so cut on the right. Included.' },
    'folded': { sev: 'warn', title: 'Characters folded', sentence: 'Accents become plain letters and only A-Z, space, hyphen and apostrophe are kept, upper-cased. Included.' },
    'same-person': { sev: 'warn', title: 'Borrower 2 has borrower 1’s SSN', sentence: 'Probably a copy in the export. Both are included - check the co-borrower.' },
    'rate-bad': { sev: 'warn', title: 'Rate missing or unreadable', sentence: 'Included in the file, but a decision needs the rate - those cases will say “Check by hand”.' },
    'orig-bad': { sev: 'warn', title: 'Origination date missing or unreadable', sentence: 'Included in the file, but a decision needs it to tell a loan from before service from one taken out during it.' },
    'bal-bad': { sev: 'warn', title: 'Balance missing or unreadable', sentence: 'Included; the estimate of what is owed needs it.' },
    'dup': { sev: 'info', title: 'The same SSN on more than one loan', sentence: 'Fine - one request per borrower per loan, each with its own customer record id, so each result goes back to the right loan.' },
  };
  var CHECK_ORDER = Object.keys(CHECKS);

  /** Clean a loan id into a customer record id: A-Z and 0-9, upper-cased, plus B1 / B2. */
  function cleanCrid(loan, b) { return str(loan).toUpperCase().replace(/[^A-Z0-9]/g, '') + 'B' + b; }
  var B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  /** A short code from Muster: the batch id and a counter, never the loan id. */
  function shortCrid(batchId, n) {
    var s = '', x = n;
    do { s = B32.charAt(x % 32) + s; x = Math.floor(x / 32); } while (x > 0);
    while (s.length < 4) s = '0' + s;
    return str(batchId).toUpperCase().replace(/[^A-Z0-9]/g, '') + s;
  }

  /**
   * Every row check, with counts and the exact rows. Each borrower on each
   * loan is one record; a record with a blocking problem is left out of the
   * file. opts: {layout, statusDate, allowExample, cridMode, batchId}.
   */
  function rowChecks(loans, opts) {
    opts = opts || {};
    var lay = cleanLayout(opts.layout);
    var status = isDay(opts.statusDate) ? opts.statusDate : null;
    var groupsOut = {};
    CHECK_ORDER.forEach(function (k) { groupsOut[k] = { key: k, sev: CHECKS[k].sev, title: CHECKS[k].title, sentence: CHECKS[k].sentence, count: 0, rows: [] }; });
    function hit(k, rec, extra) {
      var g = groupsOut[k];
      g.count++;
      if (g.rows.length < LIMITS.groupRows) g.rows.push(Object.assign({ line: rec.line, loan: rec.loanId, b: rec.b }, extra || {}));
    }
    var records = [], bySsn = new Map(), crids = {}, seq = 0;
    loans.forEach(function (L) {
      var lr = { line: L.line, loanId: L.loan, b: 1 };
      if (L.rateU === null) hit('rate-bad', lr, { detail: L.rateRaw ? '“' + L.rateRaw + '”' : 'blank' });
      if (!L.orig) hit('orig-bad', lr, { detail: L.origRaw ? '“' + L.origRaw + '”' : 'blank' });
      if (L.bal === null) hit('bal-bad', lr, { detail: 'blank or unreadable' });
      L.people.forEach(function (P) {
        var rec = { li: L.i, line: L.line, loanId: L.loan, b: P.b, problems: [], ok: true };
        var block = function (k, extra) { rec.problems.push(k); rec.ok = false; hit(k, rec, extra); };
        if (!L.loan) block('loan-missing', {});
        var sp = ssnProblem(P.ssn, opts.allowExample);
        if (sp === 'missing') block('ssn-missing', {});
        else if (sp === 'shape') block('ssn-shape', { detail: P.ssn.replace(/\d/g, '#').slice(0, 14) + ' (' + P.ssn.replace(/\D/g, '').length + ' digits)' });
        else if (sp) block('ssn-never', { detail: sp + ' · ' + maskSsn(P.ssn) });
        if (!P.dob && !P.dobRaw) block('dob-missing', {});
        else if (!P.dob) block('dob-bad', { detail: '“' + P.dobRaw + '”' });
        else if (status) {
          var age = (dayNum(status) - dayNum(P.dob)) / 365.25;
          if (P.dob < '1900-01-01' || P.dob > status || age < 16 || age > 110) block('dob-odd', { detail: niceDay(P.dob) });
        }
        var lastF = fold(P.last), firstF = fold(P.first), midF = fold(P.middle);
        if (!lastF.text) block('last-missing', {});
        if (!firstF.text) { rec.problems.push('first-missing'); hit('first-missing', rec, {}); }
        [['last', lastF, P.last], ['first', firstF, P.first], ['middle', midF, P.middle]].forEach(function (x) {
          var f = x[1];
          if (f.changed && f.text) { if (rec.problems.indexOf('folded') < 0) rec.problems.push('folded'); hit('folded', rec, { field: x[0], before: line(x[2], 60), after: f.text }); }
          var len = lay.fields[x[0]].len;
          if (f.text.length > len) { if (rec.problems.indexOf('cut') < 0) rec.problems.push('cut'); hit('cut', rec, { field: x[0], before: f.text, after: f.text.slice(0, len).replace(/\s+$/, '') }); }
        });
        if (P.b === 2 && L.people[0] && L.people[0].ssn && L.people[0].ssn === P.ssn) { rec.problems.push('same-person'); hit('same-person', rec, {}); }
        if (rec.ok) {
          var crid = opts.cridMode === 'short' ? shortCrid(opts.batchId || 'X', ++seq) : cleanCrid(L.loan, P.b);
          if (crid.length > lay.fields.crid.len) { rec.problems.push('crid-long'); rec.ok = false; hit('crid-long', rec, { detail: crid + ' (' + crid.length + ' characters, the field holds ' + lay.fields.crid.len + ')' }); }
          else if (crids[crid]) { rec.problems.push('crid-dup'); rec.ok = false; hit('crid-dup', rec, { detail: crid + ' - also line ' + crids[crid] }); }
          else { crids[crid] = L.line; rec.crid = crid; }
        }
        if (P.ssn && /^\d{9}$/.test(P.ssn)) { var had = bySsn.get(P.ssn); if (!had) bySsn.set(P.ssn, rec); else if (Array.isArray(had)) had.push(rec); else bySsn.set(P.ssn, [had, rec]); }
        records.push(rec);
      });
    });
    bySsn.forEach(function (list, s) {
      if (!Array.isArray(list)) return;
      var loansOf = {};
      list.forEach(function (r) { loansOf[r.li] = 1; });
      if (Object.keys(loansOf).length < 2) return;
      list.forEach(function (r) { hit('dup', r, { detail: 'on ' + plural(Object.keys(loansOf).length, 'loan') + ' · ' + maskSsn(s) }); });
    });
    var groupsList = CHECK_ORDER.map(function (k) { return groupsOut[k]; }).filter(function (g) { return g.count; });
    var ok = records.filter(function (r) { return r.ok; }).length;
    return {
      records: records, groups: groupsList,
      counts: { loans: loans.length, borrowers: records.length, ok: ok, left: records.length - ok, warned: records.filter(function (r) { return r.ok && r.problems.length; }).length, coBorrowers: records.filter(function (r) { return r.b === 2; }).length },
    };
  }

  /* ================================================================== *
   * The request layout - editable, checked, never trusted blindly
   * ================================================================== */

  // From memory of DMDC's published "Multiple Record Request" format. The
  // page shows it as a table to check against the current DMDC SCRA User
  // Guide ("Format of the Request File") before a first upload; every start
  // and length can be changed.
  var LAYOUT_FIELDS = ['ssn', 'dob', 'last', 'first', 'crid', 'middle', 'status'];
  var LAYOUT_LABEL = { ssn: 'SSN', dob: 'Date of birth', last: 'Last name', first: 'First name', crid: 'Customer record ID', middle: 'Middle name', status: 'Active duty status date' };
  var LAYOUT_NOTE = { ssn: '9 digits', dob: 'YYYYMMDD', last: 'letters, padded with spaces', first: 'letters, padded with spaces', crid: 'A-Z and 0-9, padded with spaces', middle: 'letters, padded with spaces (optional)', status: 'YYYYMMDD' };
  var LAYOUT_MIN = { ssn: 9, dob: 8, last: 1, first: 1, crid: 4, middle: 1, status: 8 };
  var DEFAULT_LAYOUT = {
    lineLength: 119,
    fields: {
      ssn: { start: 1, len: 9 }, dob: { start: 10, len: 8 }, last: { start: 18, len: 26 }, first: { start: 44, len: 20 },
      crid: { start: 64, len: 28 }, middle: { start: 92, len: 20 }, status: { start: 112, len: 8 },
    },
  };
  function intIn(v, lo, hi) { var n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; }
  /** What is wrong with a layout, in words; [] when it can be used. */
  function layoutProblems(lay) {
    var out = [];
    if (!lay || typeof lay !== 'object' || !lay.fields) return ['The layout is missing.'];
    var L = intIn(lay.lineLength, 20, 1000);
    if (L === null) out.push('The line length must be a whole number from 20 to 1,000.');
    var spans = [];
    LAYOUT_FIELDS.forEach(function (k) {
      var f = lay.fields[k];
      var s = f && intIn(f.start, 1, 1000), n = f && intIn(f.len, 1, 1000);
      if (s === null || n === null) { out.push(LAYOUT_LABEL[k] + ': the start and length must be whole numbers from 1.'); return; }
      if (n < LAYOUT_MIN[k]) out.push(LAYOUT_LABEL[k] + ' needs at least ' + LAYOUT_MIN[k] + ' characters.');
      if (L !== null && s + n - 1 > L) out.push(LAYOUT_LABEL[k] + ' ends at position ' + (s + n - 1) + ', past the line length of ' + L + '.');
      spans.push({ k: k, s: s, e: s + n - 1 });
    });
    spans.sort(function (a, b) { return a.s - b.s; });
    for (var i = 1; i < spans.length; i++) if (spans[i].s <= spans[i - 1].e) out.push(LAYOUT_LABEL[spans[i - 1].k] + ' (' + spans[i - 1].s + '-' + spans[i - 1].e + ') overlaps ' + LAYOUT_LABEL[spans[i].k] + ' (' + spans[i].s + '-' + spans[i].e + ').');
    return out;
  }
  /** A layout to build with: the given one if it is sound, else the default. */
  function cleanLayout(lay) {
    if (!lay || layoutProblems(lay).length) return JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
    var out = { lineLength: Number(lay.lineLength), fields: {} };
    LAYOUT_FIELDS.forEach(function (k) { out.fields[k] = { start: Number(lay.fields[k].start), len: Number(lay.fields[k].len) }; });
    return out;
  }
  function isDefaultLayout(lay) { return JSON.stringify(cleanLayout(lay)) === JSON.stringify(DEFAULT_LAYOUT); }
  /** One fixed-width record line (no line ending). */
  var SPACES = new Array(1001).join(' ');
  function recordLine(rec, lay) {
    var vals = { ssn: rec.ssn, dob: compact(rec.dob), last: rec.last, first: rec.first, crid: rec.crid, middle: rec.middle, status: compact(rec.status) };
    var order = lay._order || (lay._order = LAYOUT_FIELDS.slice().sort(function (a, b) { return lay.fields[a].start - lay.fields[b].start; }));
    var out = '';
    for (var i = 0; i < order.length; i++) {
      var f = lay.fields[order[i]], v = str(vals[order[i]]).slice(0, f.len);
      if (out.length < f.start - 1) out += SPACES.slice(0, f.start - 1 - out.length);
      out += v + SPACES.slice(0, f.len - v.length);
    }
    return out.length < lay.lineLength ? out + SPACES.slice(0, lay.lineLength - out.length) : out;
  }
  /** Where each field sits on a line, for the coloured preview. */
  function layoutSpans(lay) {
    var l = cleanLayout(lay);
    return LAYOUT_FIELDS.map(function (k) { return { k: k, label: LAYOUT_LABEL[k], start: l.fields[k].start, len: l.fields[k].len }; }).sort(function (a, b) { return a.start - b.start; });
  }
  function rulerLines(n) {
    var tens = '', ones = '';
    for (var i = 1; i <= n; i++) { tens += i % 10 === 0 ? String((i / 10) % 10) : ' '; ones += String(i % 10); }
    return [tens, ones];
  }

  /**
   * The request file(s) and the batch record. One record per borrower per
   * loan that passed its checks. opts: {layout, statusDate, batchId,
   * createdAt, lineEnding ('crlf'|'lf'), split (0 = one file, else records
   * per file), demo}. The batch record holds NO SSN, date of birth or name -
   * only what a decision needs, keyed by customer record id.
   */
  function buildRequest(loans, checks, opts) {
    var lay = cleanLayout(opts.layout);
    if (!isDay(opts.statusDate)) throw new Error('Choose the status date.');
    if (opts.today && opts.statusDate > opts.today) throw new Error('The status date cannot be in the future.');
    var eol = opts.lineEnding === 'lf' ? '\n' : '\r\n';
    var byLoan = {};
    loans.forEach(function (L) { byLoan[L.i] = L; });
    var lines = [], map = {}, borrowersOf = {};
    checks.records.forEach(function (r) {
      if (!r.ok) return;
      var L = byLoan[r.li], P = L.people.filter(function (p) { return p.b === r.b; })[0];
      lines.push(recordLine({ ssn: P.ssn, dob: P.dob, last: fold(P.last).text, first: fold(P.first).text, middle: fold(P.middle).text, crid: r.crid, status: opts.statusDate }, lay));
      map[r.crid] = [L.loan, r.b, L.orig || '', L.rateU === null ? null : L.rateU, L.bal === null ? null : L.bal, L.pay === null ? null : L.pay, L.fees || 0, L.type, L.applied ? 1 : 0];
      borrowersOf[L.i] = 1;
    });
    var per = opts.split && Number(opts.split) >= LIMITS.splitMin ? Math.floor(Number(opts.split)) : 0;
    var chunks = [];
    if (!per || lines.length <= per) chunks.push(lines);
    else for (var i = 0; i < lines.length; i += per) chunks.push(lines.slice(i, i + per));
    var base = (opts.demo ? 'EXAMPLE-' : '') + 'muster-request-' + compact(opts.statusDate) + '-' + str(opts.batchId).toUpperCase().replace(/[^A-Z0-9]/g, '');
    var files = chunks.map(function (c, k) {
      return { name: base + (chunks.length > 1 ? '-' + (k + 1) : '') + '.txt', records: c.length, text: c.length ? c.join(eol) + eol : '' };
    });
    var batch = {
      v: 1, id: str(opts.batchId).toUpperCase().replace(/[^A-Z0-9]/g, ''), createdAt: str(opts.createdAt), statusDate: opts.statusDate,
      demo: Boolean(opts.demo), count: lines.length, loans: Object.keys(borrowersOf).length,
      lineEnding: eol === '\n' ? 'lf' : 'crlf', layoutDefault: isDefaultLayout(lay), cridMode: opts.cridMode === 'short' ? 'short' : 'loan',
      files: files.map(function (f) { return { name: f.name, records: f.records, sha256: '' }; }),
      map: map,
    };
    return { files: files, batch: batch, lineLength: lay.lineLength, allExact: lines.every(function (l) { return l.length === lay.lineLength; }) };
  }
  var MAP_COLS = ['loan', 'b', 'orig', 'rateU', 'bal', 'pay', 'fees', 'type', 'applied'];
  /** A batch-record entry as an object. */
  function entry(batch, crid) {
    var a = batch && batch.map && batch.map[crid];
    if (!a) return null;
    var o = { crid: crid };
    MAP_COLS.forEach(function (k, i) { o[k] = a[i]; });
    o.applied = Boolean(o.applied);
    return o;
  }

  /* ================================================================== *
   * Results: a CSV with headers, or fixed width by spans
   * ================================================================== */

  var RFIELDS = [
    { key: 'crid', label: 'Customer record ID', need: true },
    { key: 'active', label: 'On active duty on the status date (Yes/No)' },
    { key: 'adStart', label: 'Active duty start date' },
    { key: 'adEnd', label: 'Active duty end date' },
    { key: 'left', label: 'Left active duty within 367 days (Yes/No)' },
    { key: 'leftStart', label: 'That service’s start date' },
    { key: 'leftEnd', label: 'Date they left active duty' },
    { key: 'future', label: 'Notified of a future call-up (Yes/No)' },
    { key: 'futureStart', label: 'Future call-up start date' },
    { key: 'component', label: 'Service component / branch' },
    { key: 'match', label: 'Match or error text' },
    { key: 'statusDate', label: 'Status date (if the file repeats it)' },
  ];
  var RKEYS = RFIELDS.map(function (f) { return f.key; });
  var RDATES = ['adStart', 'adEnd', 'leftStart', 'leftEnd', 'futureStart', 'statusDate'];
  var RFLAGS = ['active', 'left', 'future'];
  // Any SSN, date-of-birth or name column in a results file is ignored and never kept.
  var RIGNORE = /\b(ssn|social|tin|dob|birth|last name|first name|middle|surname|given name|name|lname|fname)\b/;
  var RRULES = {
    crid: /\b(customer record( id)?|record id|cust rec( id)?|crid|customer id|record identifier|client record|reference id|your id|cust ref)\b/,
    left: /\b(left active duty|within 367|367 days?|left ad|released within|ld status)\b/,
    leftStart: /\b(left|367)\b.*\b(start|begin|from)\b|\b(start|begin)\b.*\b(left|367)\b/,
    leftEnd: /\b(left|367)\b.*\b(end|date|released?|separation|thru|to)\b|\b(end|release)\b.*\b(left|367)\b/,
    future: /\b(future|call ?up|notif\w*|recall)\b/,
    futureStart: /\b(future|call ?up|notif\w*)\b.*\b(start|date|report|begin)\b/,
    active: /\b(active duty status|on active duty|active duty|ad status|active status|status)\b/,
    adStart: /\b(active duty start|active duty begin|ad start|start date|eod|entry on duty|begin date|start)\b/,
    adEnd: /\b(active duty end|ad end|end date|projected end|release date|end)\b/,
    component: /\b(component|branch|service|svc)\b/,
    match: /\b(match|error|result|reason|message|comment|note|code)\b/,
    statusDate: /\b(status date|as of|query date|request(ed)? date|lookup date)\b/,
  };
  function resultHeaderPoints(key, raw) {
    var n = headerNorm(raw);
    if (!n || RIGNORE.test(n)) return 0;
    var r = RRULES[key];
    if (!r || !r.test(n)) return 0;
    var isDate = /\b(date|start|end|begin|from|thru|to|eod)\b/.test(n);
    if (key === 'left' || key === 'future') return isDate ? 0 : 10;
    if (key === 'leftStart') return /\bstart|begin|from\b/.test(n) ? 11 : 0;
    if (key === 'leftEnd') return /\b(left|367)\b/.test(n) && !/\b(start|begin|from)\b/.test(n) && isDate ? 11 : 0;
    if (key === 'futureStart') return isDate ? 11 : 0;
    if (key === 'active') return !isDate && !/\b(left|367|future|call)\b/.test(n) ? 9 : 0;
    if (key === 'adStart' || key === 'adEnd') return !/\b(left|367|future|call|status date)\b/.test(n) ? 9 : 0;
    if (key === 'statusDate') return 12;
    if (key === 'component') return /\bstatus\b/.test(n) ? 0 : 8;
    if (key === 'match') return 6;
    return 10;
  }
  /** Which results column is which, and which columns are ignored (SSN, DOB, names). */
  function guessResultColumns(headers) {
    var cands = [];
    RKEYS.forEach(function (k) { headers.forEach(function (h, i) { var p = resultHeaderPoints(k, h); if (p) cands.push({ k: k, i: i, p: p }); }); });
    cands.sort(function (a, b) { return b.p - a.p || a.i - b.i; });
    var map = {}, used = {};
    RKEYS.forEach(function (k) { map[k] = null; });
    cands.forEach(function (c) { if (map[c.k] === null && !used[c.i]) { map[c.k] = c.i; used[c.i] = true; } });
    var ignored = headers.map(function (h, i) { return RIGNORE.test(headerNorm(h)) ? i : -1; }).filter(function (i) { return i >= 0; });
    return { map: map, ignored: ignored };
  }
  function resultProblems(map) {
    var out = [];
    if (!map || map.crid === null || map.crid === undefined) out.push('Choose the column (or span) with the customer record id.');
    if (map && [map.active, map.left, map.future].every(function (x) { return x === null || x === undefined; })) out.push('Choose at least one status: on active duty, left within 367 days, or a future call-up.');
    return out;
  }
  /** Spans for a fixed-width results file: [{field, start, len}], checked. */
  function spanProblems(spans, width) {
    var out = [];
    if (!Array.isArray(spans) || !spans.length) return ['Mark at least the customer record id.'];
    var seen = {}, sorted = [];
    spans.forEach(function (s) {
      if (!s || RKEYS.indexOf(s.field) < 0) { out.push('A span is not one of the fields.'); return; }
      if (seen[s.field]) out.push(s.field === 'crid' ? 'The customer record id is marked twice.' : 'A field is marked twice.');
      seen[s.field] = 1;
      var a = intIn(s.start, 1, 2000), n = intIn(s.len, 1, 400);
      if (a === null || n === null) { out.push('A span needs a whole-number start and length.'); return; }
      if (width && a > width) out.push('A span starts past the end of the longest line (' + width + ').');
      sorted.push({ a: a, e: a + n - 1, f: s.field });
    });
    if (!seen.crid) out.push('Mark the customer record id.');
    sorted.sort(function (x, y) { return x.a - y.a; });
    for (var i = 1; i < sorted.length; i++) if (sorted[i].a <= sorted[i - 1].e) out.push('Two spans overlap (positions ' + sorted[i].a + '-' + Math.min(sorted[i].e, sorted[i - 1].e) + ').');
    return out.filter(function (x, i, a) { return a.indexOf(x) === i; });
  }
  /** Is this text a fixed-width file rather than a CSV? */
  function looksFixed(text) {
    var head = str(text).slice(0, 65536).replace(/^\uFEFF/, '');
    var ls = head.split(/\r\n|\n|\r/).filter(function (l) { return l.trim(); }).slice(0, 30);
    if (ls.length < 1) return false;
    var d = sniffDelimiter(head);
    if (d) {
      var t = splitRows(head, d, 30, 400).rows;
      var wide = t.filter(function (r) { return r.length >= 3; }).length;
      if (wide >= Math.max(1, Math.floor(t.length * 0.8))) return false;
    }
    return true;
  }
  function textLines(text) {
    var t = str(text);
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    var out = [], nums = [], n = 1, i = 0;
    while (i < t.length && out.length < LIMITS.resultLines) {
      var j = t.indexOf('\n', i);
      if (j < 0) j = t.length;
      var l = t.slice(i, j).replace(/\r$/, '');
      if (l.trim()) { out.push(l.replace(BAD, ' ').slice(0, 2000)); nums.push(n); }
      n++; i = j + 1;
    }
    return { lines: out, nums: nums, total: n - 1 };
  }
  /** One normalised result. Free text is bounded; any SSN-shaped number in it is removed. */
  function normResult(get, lineNo) {
    var r = { line: lineNo, crid: line(get('crid'), 40).toUpperCase().replace(/[^A-Z0-9]/g, '') };
    RFLAGS.forEach(function (k) { r[k] = readYesNo(get(k)); });
    RDATES.forEach(function (k) { r[k] = readResultDate(get(k)); });
    r.component = scrubDigits(line(get('component'), 40));
    r.match = scrubDigits(line(get('match'), 80));
    r.raw = {};
    RDATES.forEach(function (k) { var v = line(get(k), 20); if (v && !r[k]) r.raw[k] = v; });
    return r;
  }
  function readResultsCsv(table, map) {
    var out = [];
    for (var i = 0; i < table.rows.length; i++) {
      var row = table.rows[i];
      out.push(normResult(function (k) { var c = map[k]; return c === null || c === undefined ? '' : row[c] || ''; }, table.lines[i] || i + 2));
    }
    return out;
  }
  function readResultsFixed(lines, nums, spans) {
    var sp = {};
    spans.forEach(function (s) { sp[s.field] = s; });
    return lines.map(function (l, i) {
      return normResult(function (k) { var s = sp[k]; return s ? l.substr(s.start - 1, s.len) : ''; }, nums[i]);
    }).filter(function (r) { return r.crid; });
  }
  /** A header row in a fixed-width file (the first line with no digits at all). */
  function fixedHeaderLines(lines) { var k = 0; while (k < lines.length && k < 3 && !/\d/.test(lines[k])) k++; return k; }

  /**
   * Results matched back to the saved batches by customer record id. Picks
   * the batch most of the lines belong to (or the one named). Returns
   * {batchId, matched: [{crid, res}], unmatched: [{line, crid}], missing:
   * [crid] (in the batch, with no line), duplicates}.
   */
  function matchResults(results, batches, batchId) {
    var pick = null;
    if (batchId) pick = batches.filter(function (b) { return b.id === batchId; })[0] || null;
    if (!pick) {
      var best = -1;
      batches.forEach(function (b) {
        var n = 0;
        for (var i = 0; i < results.length && i < 5000; i++) if (b.map[results[i].crid]) n++;
        if (n > best) { best = n; pick = b; }
      });
      if (best <= 0) pick = null;
    }
    var out = { batchId: pick ? pick.id : null, matched: [], unmatched: [], missing: [], duplicates: 0 };
    if (!pick) { out.unmatched = results.map(function (r) { return { line: r.line, crid: r.crid }; }).slice(0, 2000); out.unmatchedCount = results.length; return out; }
    var seen = {};
    results.forEach(function (r) {
      if (!pick.map[r.crid]) { if (out.unmatched.length < 2000) out.unmatched.push({ line: r.line, crid: r.crid }); out.unmatchedCount = (out.unmatchedCount || 0) + 1; return; }
      if (seen[r.crid]) { out.duplicates++; return; }
      seen[r.crid] = 1;
      out.matched.push({ crid: r.crid, res: r });
    });
    out.unmatchedCount = out.unmatchedCount || 0;
    Object.keys(pick.map).forEach(function (c) { if (!seen[c]) out.missing.push(c); });
    return out;
  }

  /* ================================================================== *
   * The 6% math - integer cents, UTC day counts, BigInt where it multiplies
   * ================================================================== */

  /** round(n / d) half away from zero, in BigInt. */
  function roundDiv(n, d) {
    var neg = (n < 0n) !== (d < 0n);
    var an = n < 0n ? -n : n, ad = d < 0n ? -d : d;
    var q = an / ad, r = an % ad;
    if (r * 2n >= ad) q += 1n;
    return Number(neg ? -q : q);
  }
  /** Interest above 6% on a balance for a number of days: bal x (rate - 6%) x days / 365. */
  function overInterest(balCents, rateU, days) {
    if (!(balCents >= 0) || !(days > 0)) return 0;
    return roundDiv(BigInt(Math.round(balCents)) * BigInt(rateU - CAP_U) * BigInt(days), 1000000n * 365n);
  }
  /** Monthly fees over a number of days: fees x days x 12 / 365. */
  function feesFor(feesCents, days) {
    if (!(feesCents > 0) || !(days > 0)) return 0;
    return roundDiv(BigInt(Math.round(feesCents)) * BigInt(days) * 12n, 365n);
  }
  /** What the cap takes off each month: bal x (rate - 6%) / 12 + monthly fees (never below 0). */
  function monthlyOver(balCents, rateU, feesCents) {
    var i = balCents >= 0 ? roundDiv(BigInt(Math.round(balCents)) * BigInt(rateU - CAP_U), 1000000n * 12n) : 0;
    return Math.max(0, i + (feesCents > 0 ? feesCents : 0));
  }
  /** Is the total charged (interest and fees) over 6% a year? */
  function overCap(balCents, rateU, feesCents) {
    if (rateU > CAP_U) return true;
    if (!(feesCents > 0)) return false;
    if (!(balCents > 0)) return true;
    return monthlyOver(balCents, rateU, feesCents) > 0;
  }
  /** The estimate for one case, with the arithmetic in words. */
  function estimate(e, from, to, capOngoing) {
    var days = from && to ? Math.max(0, daysBetween(from, to)) : 0;
    var interest = e.bal === null || e.rateU === null ? 0 : overInterest(e.bal, e.rateU, days);
    var fees = feesFor(e.fees, days);
    var owed = Math.max(0, interest + fees);
    var monthly = capOngoing && e.bal !== null && e.rateU !== null ? monthlyOver(e.bal, e.rateU, e.fees) : 0;
    var math = [];
    if (e.rateU !== null) math.push(e.rateU > CAP_U ? 'Rate ' + rateText(e.rateU) + ' − 6.00% = ' + pointsText(e.rateU - CAP_U) + ' over the cap' : 'Rate ' + rateText(e.rateU) + ' is at or under 6.00%; the fees take the charges over it');
    if (e.bal !== null && e.rateU !== null && days) math.push(money(e.bal) + ' × ' + (e.rateU >= CAP_U ? pointsText(e.rateU - CAP_U).replace(' points', '%') : '−' + pointsText(CAP_U - e.rateU).replace(' points', '%')) + ' × ' + plural(days, 'day') + ' ÷ 365 = ' + money(interest) + ' (' + niceDay(from) + ' to ' + niceDay(to) + ')');
    if (e.fees > 0 && days) math.push('Fees ' + money(e.fees) + ' a month × ' + plural(days, 'day') + ' × 12 ÷ 365 = ' + money(fees) + ' (fees count as interest)');
    if (days) math.push('Owed so far ≈ ' + money(owed));
    if (monthly) math.push('Payment drop ≈ ' + money(e.bal) + ' × ' + pointsText(e.rateU - CAP_U).replace(' points', '%') + ' ÷ 12' + (e.fees > 0 ? ' + ' + money(e.fees) + ' fees' : '') + ' = ' + money(monthly) + ' a month while capped');
    if (e.bal === null) math.push('No balance in the file, so no amount could be estimated.');
    return { days: days, from: from, to: to, interest: interest, fees: fees, owed: owed, monthly: monthly, math: math };
  }

  /* ================================================================== *
   * Deciding each case - pure, each decision with the rule it rests on
   * ================================================================== */

  var DECISIONS = ['eligible', 'notice', 'policy', 'hand', 'applied', 'watch', 'under', 'none'];
  var DECISION_WORD = {
    eligible: 'Eligible', notice: 'Tell the borrower - awaiting notice', policy: 'Check policy', hand: 'Check by hand',
    applied: 'Already applied - confirm the dates', watch: 'Watch', under: 'No change - at or under 6%', none: 'No action',
  };
  var DECISION_MARK = { eligible: '✓', notice: '✉', policy: '?', hand: '!', applied: '↺', watch: '◷', under: '=', none: '-' };
  var TODO = { eligible: 1, notice: 1, policy: 1, hand: 1, applied: 1, watch: 1 };
  var ERROR_TEXT = /\b(error|no match|not found|unmatched|invalid|multiple|ambiguous|reject|failed|unable|mismatch)\b/i;
  var TYPE_NOUN = { mortgage: 'mortgage', auto: 'auto loan', card: 'card', personal: 'personal loan', student: 'student loan', other: 'loan' };

  /**
   * One case: a batch-record entry and its result. ctx: {policy
   * ('proactive'|'notice'), today, statusDate}. Returns the decision, the
   * sentence, the rules it rests on, the cap's dates and the estimate.
   */
  function decide(e, res, ctx) {
    var today = ctx.today, policy = ctx.policy === 'notice' ? 'notice' : 'proactive';
    var noun = TYPE_NOUN[e.type] || 'loan';
    var d = { crid: e.crid, loan: e.loan, b: e.b, type: e.type, rateU: e.rateU, bal: e.bal, fees: e.fees, orig: e.orig || null, code: 'none', sentence: '', rules: [], notes: [], S: null, E: null, R: null, Rs: null, C: null, capStart: null, capEnd: null, open: false, askBy: null, est: null, component: res ? res.component : '' };
    function out(code, sentence, rules) { d.code = code; d.word = DECISION_WORD[code]; d.sentence = sentence; d.rules = rules || []; return d; }
    if (e.b === 2) d.notes.push('The servicemember is borrower 2 on this loan. The cap covers an obligation incurred by the servicemember, or the servicemember and spouse jointly - confirm who borrower 1 is.');
    if (!res) return out('hand', 'No result line came back for this record - check it by hand or include it in the next file.', []);
    if (res.match && ERROR_TEXT.test(res.match)) return out('hand', 'The result says “' + res.match + '” - check this borrower by hand.', ['dmdc']);
    var svc = res.active === true, left = res.left === true, fut = res.future === true;
    d.active = svc; d.left = left; d.future = fut;
    if (res.active === null && res.left === null && res.future === null) return out('hand', 'No status could be read from this line' + (res.match ? ' (“' + res.match + '”)' : '') + ' - check it by hand.', ['dmdc']);
    if (res.statusDate && ctx.statusDate && res.statusDate !== ctx.statusDate) d.notes.push('The result’s status date (' + niceDay(res.statusDate) + ') is not the batch’s (' + niceDay(ctx.statusDate) + ').');
    if (fut && (svc || left)) d.notes.push('Also notified of a future call-up' + (res.futureStart ? ' starting ' + niceDay(res.futureStart) : '') + '.');
    if (e.applied) {
      if (svc || left || fut) return out('applied', 'Your file already marks the cap as applied. Confirm it runs from ' + (svc && res.adStart ? niceDay(res.adStart) : left && res.leftStart ? niceDay(res.leftStart) : 'the date they were called to service') + (left && res.leftEnd ? ' and when it ends (released ' + niceDay(res.leftEnd) + ')' : '') + '.', ['cap']);
      return out('applied', 'Your file marks the cap as applied, but this check shows no active duty, no release in the 367 days before the status date and no call-up - confirm when the cap ends.', ['cap', 'mortgage']);
    }
    if (!svc && !left && !fut) return out('none', 'Not on active duty on ' + niceDay(ctx.statusDate) + ', not released in the 367 days before it, and no future call-up.', ['dmdc']);
    if (!svc && !left && fut) {
      d.C = res.futureStart;
      return out('watch', 'Notified of a future call-up' + (d.C ? ' starting ' + niceDay(d.C) + ' - check again on that date' : ' - check again when the orders start') + '. The cap would run from the date they are called to service.', ['cap', 'dmdc']);
    }
    var S, endOfService, released = false;
    if (svc) {
      S = res.adStart; endOfService = res.adEnd;
      if (!S) return out('hand', 'On active duty, but the result has no start date - the cap starts on that date. Check it by hand.', ['notice']);
      if (endOfService && endOfService < S) return out('hand', 'The end date is before the start date - check it by hand.', []);
    } else {
      released = true;
      S = res.leftStart; endOfService = res.leftEnd;
      d.R = endOfService; d.Rs = S;
      if (!endOfService) return out('hand', 'Left active duty within 367 days, but the result has no date they left - check it by hand.', []);
      if (!S) return out('hand', 'Left active duty on ' + niceDay(endOfService) + ', but the result does not say when that service began - the cap starts on that date. Check it by hand.', ['notice']);
    }
    d.S = S; d.E = endOfService || null;
    if (e.rateU === null) return out('hand', 'Matched to service from ' + niceDay(S) + ', but the file has no readable rate - check it by hand.', ['cap']);
    if (!overCap(e.bal, e.rateU, e.fees)) return out('under', (released ? 'Left active duty on ' + niceDay(endOfService) : 'On active duty since ' + niceDay(S)) + ' - the rate is already at or under 6%' + (e.fees > 0 ? ' with its fees' : '') + ', so nothing changes.', ['cap', 'fees']);
    if (!e.orig) return out('hand', 'Matched to service from ' + niceDay(S) + ', but the file has no readable origination date, so Muster cannot tell whether the loan came before service - check it by hand.', ['cap']);
    if (e.orig >= S) return out('policy', 'Taken out during service (' + niceDay(e.orig) + ', service from ' + niceDay(S) + ') - the statute’s cap covers obligations from before service; your policy may still apply it.', ['cap']);
    var mortgage = e.type === 'mortgage';
    var rules = ['cap', 'forgiven'].concat(e.fees > 0 ? ['fees'] : []).concat(mortgage ? ['mortgage'] : []);
    d.capStart = S;
    var ongoing;
    if (!released) {
      d.capEnd = endOfService ? (mortgage ? addYears(endOfService, 1) : endOfService) : null;
      d.open = !d.capEnd;
      ongoing = !d.capEnd || d.capEnd > today;
      var to = d.capEnd ? minDay(today, d.capEnd) : today;
      d.est = estimate(e, S, to > S ? to : S, ongoing);
      d.askBy = null;
      var sent = 'Eligible: on active duty since ' + niceDay(S) + ', and this ' + noun + ' (' + niceDay(e.orig) + ') came before it, at ' + rateText(e.rateU) + '. ';
      sent += d.capEnd ? 'The cap runs from ' + niceDay(S) + ' to ' + niceDay(d.capEnd) + (mortgage && endOfService ? ' - one year after service ends on ' + niceDay(endOfService) + ', because it is a mortgage.' : '.') : 'The cap runs from ' + niceDay(S) + ' with no end yet' + (mortgage ? ' (and one year after service ends, because it is a mortgage).' : '.');
      d.sentence = sent;
      if (policy === 'notice') return out('notice', 'Tell the borrower - awaiting notice. ' + sent + ' Under your policy the cap waits for written notice and a copy of orders, which they can send up to 180 days after release; it then applies from ' + niceDay(S) + '.', rules.concat(['notice']));
      return out('eligible', sent, rules);
    }
    // Released within the 367 days before the status date.
    d.askBy = addDays(endOfService, 180);
    if (mortgage) {
      d.capEnd = addYears(endOfService, 1);
      ongoing = d.capEnd > today;
      d.est = estimate(e, S, minDay(today, d.capEnd), ongoing);
      var ms = 'Eligible: left active duty on ' + niceDay(endOfService) + ' (service from ' + niceDay(S) + '), and this mortgage (' + niceDay(e.orig) + ') came before it. ' + (ongoing ? 'The one-year tail runs to ' + niceDay(d.capEnd) + '' : 'The one-year tail ended on ' + niceDay(d.capEnd)) + ', plus anything owed for the service period.';
      if (policy === 'notice') {
        if (today > d.askBy) return out('policy', ms + ' The 180 days for written notice ended on ' + niceDay(d.askBy) + ' - your policy decides.', rules.concat(['notice']));
        return out('notice', 'Tell the borrower - awaiting notice. ' + ms + ' They can send written notice and orders until ' + niceDay(d.askBy) + '.', rules.concat(['notice']));
      }
      return out('eligible', ms, rules);
    }
    d.capEnd = endOfService;
    d.est = estimate(e, S, minDay(today, endOfService), false);
    var os = 'Left active duty on ' + niceDay(endOfService) + ' (service from ' + niceDay(S) + '), and this ' + noun + ' (' + niceDay(e.orig) + ') came before it: interest above 6% for the service period is owed if it was not applied.';
    if (policy === 'notice') {
      if (today > d.askBy) return out('policy', os + ' The 180 days for written notice ended on ' + niceDay(d.askBy) + ' - your policy decides.', rules.concat(['notice']));
      return out('notice', 'Tell the borrower - awaiting notice. ' + os + ' They can ask until ' + niceDay(d.askBy) + '.', rules.concat(['notice']));
    }
    return out('eligible', 'Eligible: ' + os.charAt(0).toLowerCase() + os.slice(1) + ' They can ask until ' + niceDay(d.askBy) + '; your proactive policy applies it now.', rules.concat(['notice']));
  }

  /** Every case in a batch decided: matched results, and a line for each record with none. */
  function decideAll(batch, matched, ctx) {
    var byCrid = {};
    (matched.matched || []).forEach(function (m) { byCrid[m.crid] = m.res; });
    var out = [];
    Object.keys(batch.map).forEach(function (crid) {
      out.push(decide(entry(batch, crid), byCrid[crid] || null, { policy: ctx.policy, today: ctx.today, statusDate: batch.statusDate }));
    });
    return out;
  }
  var ORDER = { eligible: 0, notice: 1, policy: 2, hand: 3, applied: 4, watch: 5, under: 6, none: 7 };
  function sortDecisions(list) {
    return list.slice().sort(function (a, b) {
      return ORDER[a.code] - ORDER[b.code] || ((b.est ? b.est.owed : 0) - (a.est ? a.est.owed : 0)) || (a.C || '').localeCompare(b.C || '') || a.crid.localeCompare(b.crid);
    });
  }
  /** The numbers a portfolio is summed up by. */
  function totals(batch, decisions) {
    var t = { records: Object.keys(batch.map).length, loans: batch.loans || 0, matched: 0, active: 0, released: 0, watch: 0, eligible: 0, notice: 0, todo: 0, owed: 0, monthly: 0, by: {} };
    DECISIONS.forEach(function (k) { t.by[k] = 0; });
    decisions.forEach(function (d) {
      t.by[d.code]++;
      if (TODO[d.code]) t.todo++;
      if (d.code === 'eligible' || d.code === 'notice') { t.owed += d.est ? d.est.owed : 0; t.monthly += d.est ? d.est.monthly : 0; }
      if (d.active) t.active++;
      if (d.left && !d.active) t.released++;
      if (d.code !== 'hand' || d.active || d.left || d.future) t.matched++;
    });
    t.eligible = t.by.eligible; t.notice = t.by.notice; t.watch = t.by.watch;
    return t;
  }

  /* ================================================================== *
   * The worklist - its state is the audit log, replayed
   * ================================================================== */

  var STEPS = [
    { key: 'rate', label: 'Rate reduced in the system', date: true },
    { key: 'refund', label: 'Refund or credit applied', date: true, amount: true },
    { key: 'letter', label: 'Letter sent', date: true },
    { key: 'done', label: 'Done' },
  ];
  var OUTCOMES = { apply: 'Apply the cap', skip: 'Do not apply', checking: 'Still checking' };
  function blankCase() { return { outcome: '', rate: null, refund: null, refundCents: null, letter: null, done: false, note: '', by: '', changed: '' }; }
  /** The worklist as the audit log says it is now: one state per case. */
  function workFrom(events) {
    var cases = {}, resultsAt = null;
    (events || []).forEach(function (ev) {
      if (ev.kind === 'results' && !resultsAt) resultsAt = str(ev.at).slice(0, 10);
      if (!ev.crid) return;
      var c = cases[ev.crid] || (cases[ev.crid] = blankCase());
      if (ev.kind === 'decision') { c.decidedAt = str(ev.at).slice(0, 10); return; }
      c.changed = ev.at;
      if (ev.by) c.by = ev.by;
      if (ev.kind === 'note') c.note = str(ev.value);
      if (ev.kind !== 'step') return;
      var v = ev.value;
      if (ev.field === 'rate' || ev.field === 'letter') c[ev.field] = isDay(v) ? v : null;
      else if (ev.field === 'refund') { c.refund = v && isDay(v.date) ? v.date : null; c.refundCents = v && Number.isInteger(v.cents) && v.cents >= 0 ? v.cents : null; }
      else if (ev.field === 'done') c.done = v === true;
      else if (ev.field === 'outcome') c.outcome = OUTCOMES[v] ? v : '';
      else if (ev.field === 'by') c.by = initials(v);
    });
    return { cases: cases, resultsAt: resultsAt };
  }
  /** What a case still needs, in order. */
  function stepsLeft(d, c) {
    c = c || blankCase();
    if (c.done) return [];
    if ((d.code === 'policy' || d.code === 'hand') && c.outcome !== 'apply') return c.outcome === 'skip' ? ['done'] : ['outcome'];
    if (d.code === 'watch') return ['done'];
    if (d.code === 'applied') return ['done'];
    var out = [];
    if (d.code !== 'notice' && !c.rate && !(d.R && d.code === 'eligible' && d.type !== 'mortgage')) out.push('rate');
    if (!c.refund && d.est && d.est.owed > 0 && d.code !== 'notice') out.push('refund');
    if (!c.letter) out.push('letter');
    out.push('done');
    return out;
  }
  /** The worklist: every case that needs a person, most pressing first. */
  function worklist(decisions, work) {
    var cases = (work && work.cases) || {};
    var list = decisions.filter(function (d) { return TODO[d.code]; }).map(function (d) {
      var c = cases[d.crid] || blankCase();
      return { d: d, c: c, left: stepsLeft(d, c) };
    });
    return list.sort(function (a, b) {
      return (a.c.done ? 1 : 0) - (b.c.done ? 1 : 0) || ORDER[a.d.code] - ORDER[b.d.code] || ((b.d.est ? b.d.est.owed : 0) - (a.d.est ? a.d.est.owed : 0)) || (a.d.C || '9').localeCompare(b.d.C || '9') || a.d.crid.localeCompare(b.d.crid);
    });
  }
  /** The re-check list: watch cases, recently released ones, open-ended eligible ones. */
  function recheckList(decisions) {
    return decisions.filter(function (d) {
      return d.code === 'watch' || ((d.code === 'eligible' || d.code === 'notice' || d.code === 'policy') && (d.R || d.open));
    }).map(function (d) {
      return { crid: d.crid, loan: d.loan, b: d.b, why: d.code === 'watch' ? 'Future call-up' + (d.C ? ' on ' + niceDay(d.C) : '') : d.R ? 'Left active duty on ' + niceDay(d.R) : 'On active duty with no end date yet', when: d.C || null };
    });
  }
  /** Median days from the results coming in to the rate being reduced. */
  function medianToRate(work) {
    var a = [];
    Object.keys(work.cases || {}).forEach(function (k) {
      var c = work.cases[k], from = c.decidedAt || work.resultsAt;
      if (c.rate && from) { var n = daysBetween(from, c.rate); if (n !== null && n >= 0) a.push(n); }
    });
    if (!a.length) return null;
    a.sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
  }

  /* ================================================================== *
   * The audit log - append-only, each event SHA-256-chained to the last
   * ================================================================== */

  var GENESIS = '0000000000000000000000000000000000000000000000000000000000000000';
  /** Canonical JSON: keys sorted at every level, no whitespace, undefined left out. */
  function canonical(v) {
    if (v === undefined) return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(function (x) { return x === undefined ? 'null' : canonical(x); }).join(',') + ']';
    return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort().map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
  }
  function hashInput(ev) { var o = {}; Object.keys(ev).forEach(function (k) { if (k !== 'hash') o[k] = ev[k]; }); return canonical(o); }
  function hex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }
  var EVENT_KINDS = ['batch', 'results', 'decision', 'step', 'note', 'policy'];
  /** The next event, chained: seq and prev from the log so far, hash over the rest. */
  function nextEvent(events, fields, digest) {
    var last = events && events.length ? events[events.length - 1] : null;
    var ev = safeEvent(Object.assign({}, fields, { seq: last ? last.seq + 1 : 1, prev: last ? last.hash : GENESIS }));
    return Promise.resolve(digest(hashInput(ev))).then(function (h) { ev.hash = h; return ev; });
  }
  /** Check every event: its own hash, its link to the one before, its number. */
  function verifyAudit(events, digest) {
    var list = events || [];
    var out = { ok: true, n: list.length, verified: 0, broken: null };
    var i = 0;
    function step() {
      if (i >= list.length) return Promise.resolve(out);
      var ev = list[i], prev = i ? list[i - 1].hash : GENESIS;
      if (!ev || ev.prev !== prev || ev.seq !== i + 1) {
        out.ok = false;
        out.broken = { i: i, seq: ev && ev.seq, why: ev && ev.seq !== i + 1 ? 'An event is missing or out of order before event ' + (i + 1) + '.' : 'Event ' + (i + 1) + ' does not point at the hash of the event before it.' };
        return Promise.resolve(out);
      }
      return Promise.resolve(digest(hashInput(ev))).then(function (h) {
        if (h !== ev.hash) {
          out.ok = false;
          out.broken = { i: i, seq: ev.seq, why: 'Event ' + (i + 1) + ' was changed after it was written - its hash no longer matches.' };
          return out;
        }
        out.verified++; i++;
        return step();
      });
    }
    return step();
  }
  function describeEvent(ev) {
    var who = ev.by ? ' · ' + ev.by : '';
    if (ev.kind === 'batch') return 'Batch ' + ev.batch + ' built: ' + plural((ev.value && ev.value.records) || 0, 'record') + who;
    if (ev.kind === 'results') return 'Results read: ' + plural((ev.value && ev.value.matched) || 0, 'line') + ' matched' + (ev.value && ev.value.unmatched ? ', ' + groups(ev.value.unmatched) + ' unmatched' : '') + who;
    if (ev.kind === 'decision') return ev.crid + ': ' + (DECISION_WORD[ev.value && ev.value.code] || 'decided') + (ev.value && ev.value.owed ? ' · est. ' + money(ev.value.owed) : '') + who;
    if (ev.kind === 'policy') return 'Policy: ' + (ev.value === 'notice' ? 'wait for written notice and orders' : 'apply on a DMDC match without waiting') + who;
    if (ev.kind === 'note') return ev.crid + ': note ' + (ev.value ? '“' + clip(str(ev.value), 60) + '”' : 'cleared') + who;
    var s = STEPS.filter(function (x) { return x.key === ev.field; })[0];
    if (ev.field === 'outcome') return ev.crid + ': ' + (OUTCOMES[ev.value] || 'outcome cleared') + who;
    if (ev.field === 'refund') return ev.crid + ': refund or credit ' + (ev.value ? money(ev.value.cents) + ' on ' + niceDay(ev.value.date) : 'cleared') + who;
    if (ev.field === 'done') return ev.crid + ': ' + (ev.value ? 'done' : 'reopened') + who;
    if (ev.field === 'by') return ev.crid + ': decided by ' + (ev.value || 'nobody named');
    return ev.crid + ': ' + (s ? s.label.toLowerCase() : ev.field) + (ev.value ? ' ' + niceDay(ev.value) : ' cleared') + who;
  }

  /* ================================================================== *
   * Exports - formula-safe CSV, escaped Markdown, the chain as JSON
   * ================================================================== */

  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows) { return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n'; }
  function md(s) { return str(s).replace(/([\\`*_{}[\]()#+!|<>])/g, '\\$1').replace(/\n/g, ' '); }
  var EXAM_HEAD = ['batch', 'status_date', 'customer_record_id', 'loan', 'borrower', 'loan_type', 'origination', 'rate', 'balance', 'decision', 'why', 'active_duty_start', 'active_duty_end', 'left_active_duty', 'future_call_up', 'cap_start', 'cap_end', 'est_owed', 'est_monthly_drop', 'rate_reduced', 'refund_date', 'refund_amount', 'letter_sent', 'done', 'decided_by', 'note'];
  /** One row per loan per result. */
  function examCsv(batch, decisions, work, opts) {
    opts = opts || {};
    var cases = (work && work.cases) || {};
    var rows = [EXAM_HEAD];
    sortDecisions(decisions).forEach(function (d) {
      var c = cases[d.crid] || blankCase();
      rows.push([batch.id, batch.statusDate, opts.mask && batch.cridMode !== 'short' ? mask(d.crid) : d.crid, opts.mask ? mask(d.loan) : d.loan, 'B' + d.b, d.type, d.orig || '', d.rateU === null ? '' : rateText(d.rateU), d.bal === null ? '' : plainMoney(d.bal), DECISION_WORD[d.code], d.sentence,
        d.R ? '' : d.S || '', d.R ? '' : d.E || '', d.R || '', d.C || '', d.capStart || '', d.capEnd || (d.open ? 'open' : ''), d.est ? plainMoney(d.est.owed) : '', d.est ? plainMoney(d.est.monthly) : '',
        c.rate || '', c.refund || '', c.refundCents === null ? '' : plainMoney(c.refundCents), c.letter || '', c.done ? 'yes' : '', c.by, c.note]);
    });
    return toCsv(rows);
  }
  /** The exam pack's one-page summary, in Markdown. */
  function summaryMarkdown(batch, decisions, work, chain, opts) {
    opts = opts || {};
    var t = totals(batch, decisions);
    var cases = (work && work.cases) || {};
    var applied = decisions.filter(function (d) { var c = cases[d.crid]; return c && c.rate; }).length;
    var refunded = decisions.reduce(function (s, d) { var c = cases[d.crid]; return s + (c && c.refundCents ? c.refundCents : 0); }, 0);
    var med = medianToRate(work || {});
    var out = [];
    out.push('# SCRA 6% cap check - batch ' + md(batch.id));
    out.push('');
    out.push('Checked ' + plural(t.records, 'borrower') + ' on ' + plural(t.loans, 'loan') + ' on ' + niceDay(batch.statusDate) + ' (the active duty status date). ' +
      plural(t.active, 'was', 'were').replace(/ (was|were)$/, ' $1') + ' on active duty, ' + groups(t.released) + ' left active duty in the 367 days before it and ' + groups(t.watch) + ' had a future call-up. ' +
      plural(t.eligible, 'case') + ' eligible' + (t.notice ? ' and ' + groups(t.notice) + ' awaiting the borrower’s notice' : '') + ', est. ' + money(t.owed) + ' owed so far and ' + money(t.monthly) + ' a month off payments. ' +
      groups(applied) + ' applied (rate reduced)' + (refunded ? ', ' + money(refunded) + ' refunded or credited' : '') + (med !== null ? ', median ' + plural(med, 'day') + ' from match to rate change' : '') + '.');
    out.push('');
    out.push('| Decision | Cases |');
    out.push('|---|---|');
    DECISIONS.forEach(function (k) { if (t.by[k]) out.push('| ' + md(DECISION_WORD[k]) + ' | ' + groups(t.by[k]) + ' |'); });
    out.push('');
    out.push('## Cases that needed a person');
    out.push('');
    var list = worklist(decisions, work);
    if (!list.length) out.push('None.');
    list.forEach(function (w) {
      var d = w.d, c = w.c;
      out.push('- **' + md(opts.mask ? mask(d.loan) : d.loan) + ' (B' + d.b + ', ' + md(TYPE_WORD[d.type] || 'Other') + ')** - ' + md(DECISION_WORD[d.code]) + '. ' + md(d.sentence) + (d.est ? ' Est. ' + money(d.est.owed) + ' owed, ' + money(d.est.monthly) + ' a month.' : '') +
        ' Steps: ' + [c.rate ? 'rate reduced ' + niceDay(c.rate) : '', c.refund ? 'refund ' + (c.refundCents !== null ? money(c.refundCents) + ' ' : '') + niceDay(c.refund) : '', c.letter ? 'letter ' + niceDay(c.letter) : '', c.done ? 'done' : 'open'].filter(Boolean).join(', ') + (c.by ? ' · by ' + md(c.by) : '') + (c.note ? ' · note: ' + md(c.note) : ''));
    });
    out.push('');
    out.push('## The request');
    out.push('');
    (batch.files || []).forEach(function (f) { out.push('- ' + md(f.name) + ': ' + plural(f.records, 'record') + ', SHA-256 `' + md(f.sha256) + '`'); });
    out.push('- Layout: ' + (batch.layoutDefault ? 'Muster’s default 119-character layout' : 'an edited layout') + '; customer record ids ' + (batch.cridMode === 'short' ? 'are short codes from Muster' : 'are the loan id plus B1 / B2') + '.');
    out.push('');
    out.push('## The audit log');
    out.push('');
    out.push(chain ? (chain.ok ? 'Verified: ' + plural(chain.n, 'event') + ', each SHA-256-chained to the one before.' : 'NOT verified: ' + md(chain.broken && chain.broken.why)) : 'Not checked.');
    out.push('');
    out.push('## The rules applied');
    out.push('');
    ['cap', 'mortgage', 'forgiven', 'fees', 'notice', 'dmdc'].forEach(function (k) { out.push('- ' + md(RULES[k])); });
    out.push('');
    out.push('Amounts are estimates: today’s balance over the whole period, the rate over 6% by UTC day counts, monthly fees counted as interest. ' + ESTIMATE);
    out.push('');
    out.push('Made by Muster on this device. ' + NOT_ADVICE + ' (' + CITATION + ')');
    return out.join('\n') + '\n';
  }
  function auditJson(batch, events, chain) {
    return JSON.stringify({ app: 'muster', kind: 'scra-audit-log', batch: batch.id, statusDate: batch.statusDate, recipe: 'sha256(canonical JSON of the event without its hash); prev = the previous event’s hash, the first points at 64 zeros', verified: chain ? chain.ok : null, events: events }, null, 1) + '\n';
  }

  /* ================================================================== *
   * The borrower letter - a plain template filled on the device
   * ================================================================== */

  var PEOPLE_PLACEHOLDERS = ['borrower_name', 'loan_number', 'servicer_name', 'contact_line'];
  var FACT_PLACEHOLDERS = ['today', 'loan_kind', 'service_start', 'service_end', 'cap_start', 'cap_end', 'cap_period', 'call_up', 'ask_by', 'new_rate', 'est_owed', 'monthly_drop', 'action_line', 'amount_line'];
  var DEFAULT_TEMPLATE = [
    '{{servicer_name}}',
    '{{today}}',
    '',
    'Dear {{borrower_name}},',
    '',
    'Re: your {{loan_kind}}, loan {{loan_number}} - the 6% interest cap for servicemembers',
    '',
    'Thank you for your service. Under the Servicemembers Civil Relief Act, interest on a loan taken out before military service is capped at {{new_rate}} a year {{cap_period}}. Interest includes most fees and charges.',
    '',
    '{{action_line}}',
    '',
    '{{amount_line}}',
    '',
    'If any of this does not match your orders, or you have a question, please contact us: {{contact_line}}.',
    '',
    'Sincerely,',
    '{{servicer_name}}',
  ].join('\n');
  /** The facts a letter is filled with, from one decided case. */
  function letterFacts(d, today) {
    var f = { today: letterDay(today), loan_kind: TYPE_NOUN[d.type] || 'loan', service_start: letterDay(d.S || d.Rs), service_end: letterDay(d.R || d.E), cap_start: letterDay(d.capStart || d.S), cap_end: letterDay(d.capEnd), call_up: letterDay(d.C), ask_by: letterDay(d.askBy), new_rate: '6%', est_owed: d.est ? money(d.est.owed) : '', monthly_drop: d.est ? money(d.est.monthly) : '' };
    f.cap_period = d.capEnd ? 'from ' + f.cap_start + ' to ' + f.cap_end : d.code === 'watch' ? 'from the date you are called to service' : 'from ' + (f.cap_start || 'the date you were called to service') + ' for as long as you serve' + (d.type === 'mortgage' ? ' and for one year after' : '');
    if (d.code === 'eligible' && d.R && d.type !== 'mortgage') f.action_line = 'Interest above 6% on this loan from ' + f.cap_start + ' to ' + f.cap_end + ' is forgiven, not deferred, and we are crediting it to your loan. You do not need to do anything for this.';
    else if (d.code === 'eligible') f.action_line = 'We are reducing the interest rate on this loan to 6% from ' + f.cap_start + '. Interest above 6% for that time is forgiven, not deferred, and your monthly payment is reduced to match. You do not need to do anything for this.';
    else if (d.code === 'notice' || d.code === 'policy') f.action_line = 'To apply the cap, please send us written notice and a copy of your orders' + (f.ask_by ? ' by ' + f.ask_by : ' at any time while you serve, or up to 180 days after your service ends') + '. Once we have them, the cap applies from ' + (f.cap_start || 'the date you were called to service') + '.';
    else if (d.code === 'watch') f.action_line = 'Our records show you have been notified of a future call-up' + (f.call_up ? ' starting ' + f.call_up : '') + '. When your service begins, please send us written notice and a copy of your orders, and we will apply the cap from the date you were called.';
    else if (d.code === 'applied') f.action_line = 'Our records show the 6% cap is applied to this loan from ' + (f.cap_start || 'the date you were called to service') + (f.cap_end ? ' to ' + f.cap_end : '') + '. Please check these dates against your orders.';
    else f.action_line = '';
    f.amount_line = d.est && d.est.owed > 0 ? 'Our estimate is that about ' + f.est_owed + ' of interest above 6% ' + (d.code === 'eligible' ? 'will be' : 'would be') + ' credited to your loan' + (d.est.monthly ? ', and your monthly payment ' + (d.code === 'eligible' ? 'will' : 'would') + ' drop by about ' + f.monthly_drop : '') + '. The exact amounts come from your payment history.' : '';
    return f;
  }
  /** Fill a template's placeholders; unknown ones are listed, never guessed. */
  function fillLetter(tpl, facts, people) {
    var unknown = [];
    var text = para(tpl, LIMITS.templateChars).replace(/\{\{\s*([a-z_]{1,30})\s*\}\}/g, function (m, k) {
      if (PEOPLE_PLACEHOLDERS.indexOf(k) >= 0) { var v = people && people[k]; return v ? line(v, 200) : '[' + k.replace(/_/g, ' ') + ']'; }
      if (FACT_PLACEHOLDERS.indexOf(k) >= 0) return facts[k] || '';
      unknown.push(k); return m;
    });
    text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    return { text: text, unknown: unknown };
  }

  /* ================================================================== *
   * The AI letter - what is sent, checked; what comes back, checked
   * ================================================================== */

  var LETTER_CODES = { eligible: 'The cap applies and is being applied now', notice: 'The borrower may be eligible: invite written notice and a copy of orders', watch: 'A future call-up: what to send once called', applied: 'The cap is already applied: confirm its dates' };
  var TONES = { warm: 'Warm and thankful', plain: 'Plain and short', formal: 'Formal' };
  var DATE_KEYS = ['serviceStart', 'serviceEnd', 'released', 'capStart', 'capEnd', 'askBy', 'callUp'];
  var PERSONAL = /@|\d{3}-?\d{2}-?\d{4}|\d{9,}/;
  function onlyKeys(o, keys) { return o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(function (k) { return keys.indexOf(k) >= 0; }); }
  /** Exactly what the page sends for one case: codes, dates and amounts - never a name, a loan id, an SSN or anything typed. */
  function letterPayload(d, tone) {
    if (!LETTER_CODES[d.code]) return null;
    var dates = {};
    var put2 = function (k, v) { if (isDay(v)) dates[k] = v; };
    put2('serviceStart', d.S || d.Rs);
    if (!d.R) put2('serviceEnd', d.E);
    put2('released', d.R);
    put2('capStart', d.capStart);
    put2('capEnd', d.capEnd);
    put2('askBy', d.askBy);
    put2('callUp', d.C);
    var out = { code: d.code, loanType: LOAN_TYPES.indexOf(d.type) >= 0 ? d.type : 'other', tone: TONES[tone] ? tone : 'warm', newRate: 6, dates: dates };
    if (d.est && d.code !== 'watch') out.amounts = { owedCents: d.est.owed, monthlyCents: d.est.monthly };
    return out;
  }
  /** The server's check of that body: anything else is a 400, before any model call. */
  function letterRequest(body) {
    var bad = function (msg, code) { return { error: msg, code: code || 'bad-request' }; };
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Send the case’s facts.');
    var flat = JSON.stringify(body);
    if (flat.length > 4000) return bad('That is more than a letter’s facts.');
    if (PERSONAL.test(flat)) return bad('That looks like borrower data (an @, an SSN-shaped number or 9 digits in a row). Only codes, dates and amounts are sent.', 'personal');
    if (!onlyKeys(body, ['code', 'loanType', 'tone', 'newRate', 'dates', 'amounts'])) return bad('Only the decision code, loan type, tone, dates and amounts are sent - nothing else.', 'unknown-field');
    if (!LETTER_CODES[body.code]) return bad('Choose a case that needs a letter.');
    if (LOAN_TYPES.indexOf(body.loanType) < 0) return bad('Unknown loan type.');
    if (!TONES[body.tone]) return bad('Unknown tone.');
    if (body.newRate !== 6) return bad('The new rate is 6%.');
    if (!onlyKeys(body.dates || {}, DATE_KEYS)) return bad('Unknown date.', 'unknown-field');
    var dates = {};
    for (var k in body.dates) { if (!isDay(body.dates[k])) return bad('Dates are YYYY-MM-DD.'); dates[k] = body.dates[k]; }
    var amounts = null;
    if (body.amounts !== undefined) {
      if (!onlyKeys(body.amounts, ['owedCents', 'monthlyCents'])) return bad('Unknown amount.', 'unknown-field');
      amounts = {};
      for (var a in body.amounts) { var n = body.amounts[a]; if (!Number.isInteger(n) || n < 0 || n > 99999999) return bad('Amounts are whole cents.'); amounts[a] = n; }
    }
    if (body.code !== 'watch' && !dates.serviceStart && !dates.capStart) return bad('A start date is needed.');
    return { req: { code: body.code, loanType: body.loanType, tone: body.tone, newRate: 6, dates: dates, amounts: amounts } };
  }
  /** The numbers a letter may use: the ones sent, and 6 / 6%. */
  function allowedNumbers(req) {
    var set = { '6': 1, '6%': 1, '6.0%': 1, '6.00%': 1, '6.00': 1 };
    var addTokens = function (s) { (str(s).match(NUM) || []).forEach(function (t) { set[normNum(t)] = 1; }); };
    Object.keys(req.dates).forEach(function (k) { addTokens(letterDay(req.dates[k])); addTokens(niceDay(req.dates[k])); addTokens(req.dates[k]); });
    if (req.amounts) Object.keys(req.amounts).forEach(function (k) { var m = money(req.amounts[k]); addTokens(m); if (req.amounts[k] % 100 === 0) addTokens(m.replace(/\.00$/, '')); });
    return set;
  }
  var NUM = /\$?\d[\d,]*(?:\.\d+)?%?/g;
  function normNum(t) { return str(t).replace(/[.,]+$/, ''); }
  var LAW_OK = 'Servicemembers Civil Relief Act';
  /** The model's letter, checked. Returns {letter, subject} or {error, code}. */
  function cleanAiLetter(raw, req) {
    var fail = function (msg, code) { return { error: msg, code: code }; };
    if (!raw || typeof raw !== 'object') return fail('The draft did not come back in the expected shape.', 'shape');
    var letterRaw = str(raw.letter), subjectRaw = str(raw.subject);
    var letter = para(noMarkup(letterRaw), LIMITS.letterChars + 1), subject = line(noMarkup(subjectRaw), LIMITS.subjectChars + 1);
    if (letter.length < 120) return fail('The draft came back empty or too short.', 'short');
    if (letter.length > LIMITS.letterChars || subject.length > LIMITS.subjectChars) return fail('The draft ran too long.', 'long');
    var both = subject + '\n' + letter;
    if (/https?:|www\.|@|\b[a-z0-9-]+\.(com|org|net|gov|mil|us|io|co|info|biz)\b/i.test(both)) return fail('The draft named a web address or an email - Muster refuses those. Use the template, or try again.', 'link');
    var ph = both.match(/\{\{\s*[^}]{0,40}\}\}/g) || [];
    var badPh = ph.filter(function (p) { return PEOPLE_PLACEHOLDERS.indexOf(p.replace(/[{}\s]/g, '')) < 0; });
    if (badPh.length || /[{}]/.test(both.replace(/\{\{\s*[a-z_]{1,30}\s*\}\}/g, ''))) return fail('The draft used a placeholder Muster does not fill.', 'placeholder');
    var missing = PEOPLE_PLACEHOLDERS.filter(function (p) { return letter.indexOf('{{' + p + '}}') < 0; });
    if (missing.length) return fail('The draft left out ' + missing.map(function (m) { return '{{' + m + '}}'; }).join(', ') + '.', 'placeholder');
    var acts = both.match(/(?:[A-Z][A-Za-z]+\s+){1,6}Act\b/g) || [];
    var otherLaw = acts.filter(function (a) { return a.trim() !== LAW_OK && !/^(?:the\s+)?Servicemembers Civil Relief Act$/i.test(a.trim()); });
    if (otherLaw.length || /U\.?\s?S\.?\s?C\b|§|C\.?F\.?R\b|\bRegulation\s+[A-Z]\b|\bTruth in Lending\b|\bTILA\b|\bMilitary Lending\b|\bstatute\b|\bsection\s+\d/i.test(both)) return fail('The draft named a law other than the Servicemembers Civil Relief Act.', 'law');
    var allowed = allowedNumbers(req);
    var nums = (both.match(NUM) || []).map(normNum).filter(function (t) { return !allowed[t]; });
    if (nums.length) return fail('The draft used a number that was not in the facts sent (' + nums.slice(0, 3).join(', ') + ') - Muster refuses it rather than guess. Try again, or use the template.', 'number');
    return { letter: letter, subject: subject };
  }

  /* ================================================================== *
   * Settings: layouts and preferences only - never a borrower
   * ================================================================== */

  var DEFAULT_SETTINGS = { version: 1, layout: DEFAULT_LAYOUT, resultsSpans: [], presets: [], policy: 'proactive', split: 0, lineEnding: 'crlf', cridMode: 'loan', letter: { template: DEFAULT_TEMPLATE, servicer: '', contact: '' }, updatedAt: 0 };
  var SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
  function defaults() { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
  function eachString(v, fn, depth) {
    if ((depth || 0) > 6) return;
    if (typeof v === 'string') fn(v);
    else if (Array.isArray(v)) v.forEach(function (x) { eachString(x, fn, (depth || 0) + 1); });
    else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { fn(k); eachString(v[k], fn, (depth || 0) + 1); });
  }
  /**
   * Settings cleaned. strict (the server): any unknown field, anything out
   * of range, and any string that looks like borrower data - an @, an
   * SSN-shaped number, 9 or more digits in a row - is an error, and the
   * caller refuses the whole request. Not strict (a stored copy): bad parts
   * fall back to the defaults.
   */
  function cleanSettings(raw, strict) {
    var out = defaults(), errors = [];
    var err = function (m) { errors.push(m); };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { settings: out, errors: strict ? ['Send the settings.'] : [] };
    if (strict) {
      Object.keys(raw).forEach(function (k) { if (SETTINGS_KEYS.indexOf(k) < 0) err('“' + line(k, 30) + '” is not a setting.'); });
      eachString(raw, function (s) { if (PERSONAL.test(s)) err('“' + clip(line(s, 60), 40) + '” looks like borrower data (an @, an SSN-shaped number or 9 digits in a row) - settings never hold one.'); else if (BAD1.test(s)) err('A setting holds invisible characters.'); });
    }
    if (raw.layout !== undefined) { if (layoutProblems(raw.layout).length) err('The request layout: ' + layoutProblems(raw.layout)[0]); else out.layout = cleanLayout(raw.layout); }
    if (raw.resultsSpans !== undefined) {
      if (!Array.isArray(raw.resultsSpans) || raw.resultsSpans.length > RKEYS.length || (raw.resultsSpans.length && spanProblems(raw.resultsSpans, 0).length)) err('The results layout is not usable.');
      else out.resultsSpans = raw.resultsSpans.map(function (s) { return { field: s.field, start: Number(s.start), len: Number(s.len) }; });
    }
    if (raw.presets !== undefined) {
      if (!Array.isArray(raw.presets) || raw.presets.length > LIMITS.presets) err('Up to ' + LIMITS.presets + ' column presets.');
      else out.presets = raw.presets.map(function (p) {
        if (!p || typeof p !== 'object' || !onlyKeys(p, ['name', 'kind', 'map']) || (p.kind !== 'portfolio' && p.kind !== 'results') || !p.map || typeof p.map !== 'object') { err('A column preset is not usable.'); return null; }
        var keys = p.kind === 'portfolio' ? PKEYS : RKEYS, map = {};
        Object.keys(p.map).forEach(function (k) { if (keys.indexOf(k) < 0 || !headerOk(p.map[k])) err('A column preset holds something that is not a header name.'); else map[k] = line(p.map[k], LIMITS.headerChars); });
        var name = line(p.name, 40);
        if (!name) err('A column preset needs a name.');
        return { name: name, kind: p.kind, map: map };
      }).filter(Boolean);
    }
    if (raw.policy !== undefined) { if (raw.policy === 'proactive' || raw.policy === 'notice') out.policy = raw.policy; else err('The policy is proactive or notice.'); }
    if (raw.split !== undefined) { var sp = Number(raw.split); if (sp === 0 || (Number.isInteger(sp) && sp >= LIMITS.splitMin && sp <= LIMITS.splitMax)) out.split = sp; else err('Records per file: 0 (one file) or ' + LIMITS.splitMin + ' to ' + groups(LIMITS.splitMax) + '.'); }
    if (raw.lineEnding !== undefined) { if (raw.lineEnding === 'crlf' || raw.lineEnding === 'lf') out.lineEnding = raw.lineEnding; else err('Line endings are CRLF or LF.'); }
    if (raw.cridMode !== undefined) { if (raw.cridMode === 'loan' || raw.cridMode === 'short') out.cridMode = raw.cridMode; else err('Customer record ids are the loan id or a short code.'); }
    if (raw.letter !== undefined) {
      var l = raw.letter;
      if (!l || typeof l !== 'object' || !onlyKeys(l, ['template', 'servicer', 'contact'])) err('The letter settings are the template, the servicer name and the contact line.');
      else {
        if (typeof l.template === 'string') { if (l.template.length > LIMITS.templateChars) err('The letter template is too long.'); else out.letter.template = para(l.template, LIMITS.templateChars) || DEFAULT_TEMPLATE; }
        if (typeof l.servicer === 'string') { if (l.servicer.length > LIMITS.servicerChars) err('The servicer name is too long.'); else out.letter.servicer = line(l.servicer, LIMITS.servicerChars); }
        if (typeof l.contact === 'string') { if (l.contact.length > LIMITS.contactChars) err('The contact line is too long.'); else out.letter.contact = line(l.contact, LIMITS.contactChars); }
      }
    }
    if (raw.version !== undefined && raw.version !== 1 && strict) err('Unknown settings version.');
    out.updatedAt = Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0;
    return { settings: out, errors: errors.filter(function (x, i, a) { return a.indexOf(x) === i; }) };
  }
  /** Two copies merged: presets from both (the newer wins a name), everything else from the newer. */
  function mergeSettings(a, b) {
    var A = cleanSettings(a).settings, B = cleanSettings(b).settings;
    var newer = (A.updatedAt || 0) >= (B.updatedAt || 0) ? A : B, older = newer === A ? B : A;
    var out = JSON.parse(JSON.stringify(newer));
    var names = {};
    out.presets.forEach(function (p) { names[p.kind + ':' + p.name.toLowerCase()] = 1; });
    var added = 0;
    older.presets.forEach(function (p) { if (!names[p.kind + ':' + p.name.toLowerCase()] && out.presets.length < LIMITS.presets) { out.presets.push(p); added++; } });
    return { settings: out, added: added };
  }

  /* ================================================================== *
   * The storage guards: what may be kept on this device - nothing else
   * ================================================================== */

  /** Every SSN, date of birth and name in memory, to keep them out of storage. */
  function peopleOf(loans) {
    var p = { ssn: {}, dob: {}, names: {} };
    (loans || []).forEach(function (L) {
      L.people.forEach(function (P) {
        if (/^\d{9}$/.test(P.ssn)) p.ssn[P.ssn] = 1;
        if (P.dob) p.dob[P.dob] = 1;
        [P.last, P.first, P.middle].forEach(function (n) { fold(n).text.split(/[ '-]+/).forEach(function (w) { if (w.length >= 3) p.names[w] = 1; }); });
      });
    });
    return p;
  }
  function dobForms(iso) { var y = iso.slice(0, 4), m = iso.slice(5, 7), d = iso.slice(8, 10); return [iso, y + m + d, m + '/' + d + '/' + y, (+m) + '/' + (+d) + '/' + y, m + '-' + d + '-' + y]; }
  /** Any SSN-shaped number and any run of 9+ digits, removed. */
  function scrubDigits(s) { return str(s).replace(/\d{3}[- ]\d{2}[- ]\d{4}|\d{9,}/g, '[number removed]'); }
  /** Free text (a note, a match message) with borrower data taken out. */
  function scrubText(text, people) {
    var s = str(text), n = 0;
    var t = s.replace(/\d{3}[- ]\d{2}[- ]\d{4}|\d{9,}/g, function () { n++; return '[number removed]'; });
    t = t.replace(/[^\s@]+@[^\s@]+/g, function () { n++; return '[address removed]'; });
    if (people) {
      Object.keys(people.dob || {}).forEach(function (iso) { dobForms(iso).forEach(function (f) { var i; while ((i = t.indexOf(f)) >= 0) { t = t.slice(0, i) + '[date removed]' + t.slice(i + f.length); n++; } }); });
      var names = Object.keys(people.names || {});
      if (names.length) {
        t = t.replace(/[A-Za-zÀ-ÿ'’-]{3,}/g, function (w) { if (people.names[fold(w).text]) { n++; return '[name removed]'; } return w; });
      }
    }
    return { text: t, removed: n };
  }
  /** Does a loan id carry someone's SSN or name? (Some books key loans on SSNs.) */
  function idCarriesPerson(id, people) {
    if (!people) return false;
    var digits = str(id).replace(/\D/g, '');
    for (var i = 0; i + 9 <= digits.length; i++) if (people.ssn[digits.substr(i, 9)]) return true;
    var words = str(id).toUpperCase().split(/[^A-Z]+/);
    return words.some(function (w) { return w.length >= 4 && people.names[w]; });
  }
  /** A file name to keep: letters, digits, dots, hyphens and underscores, no leading dot, no "..". */
  function safeName(v) { return line(v, 90).replace(/[^A-Za-z0-9._-]/g, '').replace(/\.{2,}/g, '.').replace(/^[.-]+/, ''); }
  /** Initials: letters, spaces and full stops. */
  function initials(v) { return line(str(v).replace(/[^A-Za-z .]/g, ''), LIMITS.initialsChars); }
  /** A batch record rebuilt field by field - the only shape that is ever stored. */
  function safeBatch(b, people) {
    if (!b || typeof b !== 'object' || !b.map) throw new Error('That is not a batch record.');
    var out = { v: 1, id: line(b.id, 12).toUpperCase().replace(/[^A-Z0-9]/g, ''), createdAt: line(b.createdAt, 30), statusDate: isDay(b.statusDate) ? b.statusDate : '', demo: Boolean(b.demo), count: 0, loans: Math.max(0, Math.floor(Number(b.loans) || 0)), lineEnding: b.lineEnding === 'lf' ? 'lf' : 'crlf', layoutDefault: Boolean(b.layoutDefault), cridMode: b.cridMode === 'short' ? 'short' : 'loan', files: [], map: {} };
    if (!out.id || !out.statusDate) throw new Error('That batch record has no id or status date.');
    (Array.isArray(b.files) ? b.files : []).slice(0, 2000).forEach(function (f) { out.files.push({ name: safeName(f && f.name), records: Math.max(0, Math.floor(Number(f && f.records) || 0)), sha256: /^[0-9a-f]{64}$/.test(f && f.sha256) ? f.sha256 : '' }); });
    var n = 0;
    Object.keys(b.map).forEach(function (crid) {
      var a = b.map[crid];
      var c = str(crid).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);
      if (!c || !Array.isArray(a)) return;
      var loanId = line(a[0], 60);
      if (idCarriesPerson(loanId, people) || idCarriesPerson(c, people)) throw new Error('These loan ids carry borrowers’ SSNs or names, so a batch record of them would too. Choose “a short code from Muster” for the customer record id and keep loan ids that are not SSNs.');
      out.map[c] = [loanId, a[1] === 2 ? 2 : 1, isDay(a[2]) ? a[2] : '', Number.isInteger(a[3]) && a[3] >= 0 && a[3] <= 1000000 ? a[3] : null, Number.isInteger(a[4]) && a[4] >= 0 ? a[4] : null, Number.isInteger(a[5]) && a[5] >= 0 ? a[5] : null, Number.isInteger(a[6]) && a[6] >= 0 ? a[6] : 0, LOAN_TYPES.indexOf(a[7]) >= 0 ? a[7] : 'other', a[8] ? 1 : 0];
      n++;
    });
    out.count = n;
    return out;
  }
  /** Results rebuilt field by field: statuses and dates, free text scrubbed. */
  function safeResults(list, people) {
    return (list || []).map(function (r) {
      var o = { line: Math.max(0, Math.floor(Number(r.line) || 0)), crid: str(r.crid).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40) };
      RFLAGS.forEach(function (k) { o[k] = r[k] === true ? true : r[k] === false ? false : null; });
      RDATES.forEach(function (k) { o[k] = isDay(r[k]) ? r[k] : null; });
      o.component = scrubText(line(r.component, 40), people).text;
      o.match = scrubText(line(r.match, 80), people).text;
      return o;
    }).filter(function (o) { return o.crid; });
  }
  /** An audit event rebuilt field by field: no free text but a scrubbed note. */
  function safeEvent(ev, people) {
    var o = { seq: Math.max(0, Math.floor(Number(ev.seq) || 0)), at: line(ev.at, 30), batch: line(ev.batch, 12).toUpperCase().replace(/[^A-Z0-9]/g, ''), kind: EVENT_KINDS.indexOf(ev.kind) >= 0 ? ev.kind : 'note', prev: /^[0-9a-f]{64}$/.test(ev.prev) ? ev.prev : GENESIS };
    if (ev.crid) o.crid = str(ev.crid).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);
    if (ev.by) o.by = initials(ev.by);
    if (ev.field) o.field = STEPS.some(function (s) { return s.key === ev.field; }) || ev.field === 'outcome' || ev.field === 'by' ? ev.field : 'note';
    var v = ev.value;
    if (o.kind === 'note') o.value = scrubText(para(v, LIMITS.noteChars), people).text;
    else if (o.kind === 'step') {
      if (o.field === 'refund') o.value = v && isDay(v.date) ? { date: v.date, cents: Number.isInteger(v.cents) && v.cents >= 0 ? v.cents : 0 } : null;
      else if (o.field === 'done') o.value = v === true;
      else if (o.field === 'outcome') o.value = OUTCOMES[v] ? v : '';
      else if (o.field === 'by') o.value = initials(v);
      else o.value = isDay(v) ? v : null;
    } else if (o.kind === 'decision') o.value = { code: DECISIONS.indexOf(v && v.code) >= 0 ? v.code : 'hand', owed: v && Number.isInteger(v.owed) ? v.owed : 0, monthly: v && Number.isInteger(v.monthly) ? v.monthly : 0, capStart: v && isDay(v.capStart) ? v.capStart : null, capEnd: v && isDay(v.capEnd) ? v.capEnd : null };
    else if (o.kind === 'policy') o.value = v === 'notice' ? 'notice' : 'proactive';
    else if (o.kind === 'results') o.value = { matched: Math.max(0, Math.floor(Number(v && v.matched) || 0)), unmatched: Math.max(0, Math.floor(Number(v && v.unmatched) || 0)), missing: Math.max(0, Math.floor(Number(v && v.missing) || 0)), policy: v && v.policy === 'notice' ? 'notice' : 'proactive' };
    else if (o.kind === 'batch') o.value = { records: Math.max(0, Math.floor(Number(v && v.records) || 0)), files: (v && Array.isArray(v.files) ? v.files : []).slice(0, 200).map(function (f) { return { name: safeName(f && f.name), sha256: /^[0-9a-f]{64}$/.test(f && f.sha256) ? f.sha256 : '' }; }) };
    if (ev.hash !== undefined) o.hash = /^[0-9a-f]{64}$/.test(ev.hash) ? ev.hash : '';
    return o;
  }

  /* ================================================================== *
   * The engine: what the worker (or the page, without one) runs
   * ================================================================== */

  /** Nine or more digits in a row become bullets of the same width, for a preview on screen. */
  function maskLine(l) { return str(l).replace(/\d{9,}/g, function (m) { return new Array(m.length + 1).join('•'); }); }
  function sampleCell(v) { return SSN_SHAPE.test(v) ? maskSsn(v) : v; }

  function createEngine(o) {
    var digest = (o && o.digest) || function () { return Promise.reject(new Error('No SHA-256 here.')); };
    var st = { table: null, name: '', demo: false, loans: null, map: null, opts: null, results: null, people: null };
    function people() { if (!st.loans) return null; if (!st.people) st.people = peopleOf(st.loans); return st.people; }
    function needLoans() { if (!st.loans) throw new Error('Load the portfolio first.'); }
    function runChecks(x) {
      return rowChecks(st.loans, { layout: x.layout, statusDate: x.statusDate, allowExample: st.demo, cridMode: x.cridMode, batchId: x.batchId });
    }
    return {
      loadPortfolio: function (x) {
        var t = parseTable(x.text, { maxRows: LIMITS.rows });
        if (t.empty || !t.rows.length) throw new Error('That file has no rows Muster can read.');
        st = { table: t, name: line(x.name, 120), demo: Boolean(x.demo), loans: null, map: null, opts: null, results: null, people: null };
        var g = guessColumns(t.headers, t.rows);
        return {
          name: st.name, demo: st.demo, headers: t.headers, guess: { map: g.map, conf: g.conf }, profiles: g.profiles,
          sample: t.rows.slice(0, 5).map(function (r) { return r.map(sampleCell); }),
          stats: { delimiter: t.delimiterName, header: t.header, preamble: t.preamble, total: t.total, kept: t.kept, truncated: t.truncated, ragged: t.ragged, invisible: t.invisible, cut: t.cut, openQuote: t.openQuote, wide: t.wide },
        };
      },
      questions: function (x) {
        if (!st.table) throw new Error('Load the portfolio first.');
        var q = questions(st.table, x.map);
        q.types = typeValues(st.table, x.map);
        return q;
      },
      prepare: function (x) {
        if (!st.table) throw new Error('Load the portfolio first.');
        var probs = mappingProblems(x.map);
        if (probs.length) throw new Error(probs[0]);
        st.map = x.map; st.opts = { order: x.order, fraction: x.fraction, typeMap: x.typeMap || {} };
        st.loans = buildLoans(st.table, x.map, st.opts); st.people = null;
        var c = runChecks(x);
        return { groups: c.groups, counts: c.counts, rates: st.loans.filter(function (L) { return L.rateU !== null && L.rateU > CAP_U; }).length };
      },
      checks: function (x) { needLoans(); var c = runChecks(x); return { groups: c.groups, counts: c.counts }; },
      build: function (x) { return Promise.resolve().then(function () {
        needLoans();
        var loans = st.loans;
        if (x.only) {
          var want = {};
          x.only.forEach(function (w) { want[str(w.loan) + '|' + w.b] = 1; });
          loans = st.loans.map(function (L) { return Object.assign({}, L, { people: L.people.filter(function (P) { return want[L.loan + '|' + P.b]; }) }); }).filter(function (L) { return L.people.length; });
        }
        var c = rowChecks(loans, { layout: x.layout, statusDate: x.statusDate, allowExample: st.demo, cridMode: x.cridMode, batchId: x.batchId });
        var r = buildRequest(loans, c, { layout: x.layout, statusDate: x.statusDate, today: x.today, batchId: x.batchId, createdAt: x.createdAt, lineEnding: x.lineEnding, split: x.split, demo: st.demo, cridMode: x.cridMode });
        var batch = safeBatch(r.batch, people());
        return Promise.all(r.files.map(function (f) { return Promise.resolve(digest(f.text)); })).then(function (hs) {
          hs.forEach(function (h, i) { batch.files[i].sha256 = h; });
          var first = r.files[0] ? r.files[0].text.split(/\r?\n/).filter(Boolean).slice(0, LIMITS.previewLines) : [];
          return { files: r.files.map(function (f, i) { return { name: f.name, records: f.records, text: f.text, sha256: hs[i] }; }), batch: batch, preview: first, allExact: r.allExact, lineLength: r.lineLength, groups: c.groups, counts: c.counts, wanted: x.only ? x.only.length : null };
        });
      }); },
      /** A batch record from another device or an earlier session, checked against the people in memory. */
      guard: function (x) { return safeBatch(x.batch, people()); },
      /** The name and loan number for one letter - read only while the portfolio is open. */
      person: function (x) {
        if (!st.loans) return null;
        var L = st.loans.filter(function (l) { return l.loan === x.loan; })[0];
        var P = L && L.people.filter(function (p) { return p.b === x.b; })[0];
        if (!P) return null;
        var tc = function (s) { return line(s, 60).toLowerCase().replace(/(^|[\s'-])([a-zà-ÿ])/g, function (m, a, b) { return a + b.toUpperCase(); }); };
        return { borrower_name: [tc(P.first), tc(P.middle).slice(0, 1) ? tc(P.middle).slice(0, 1) + '.' : '', tc(P.last)].filter(Boolean).join(' '), loan_number: L.loan };
      },
      /** A note with the session's borrower data taken out. */
      scrub: function (x) { return scrubText(para(x.text, LIMITS.noteChars), people()); },
      safeResults: function (x) { return safeResults(x.results, people()); },
      loadResults: function (x) {
        var text = str(x.text);
        var fixed = x.mode === 'fixed' || (x.mode !== 'csv' && looksFixed(text));
        st.results = { text: text, fixed: fixed, name: line(x.name, 120) };
        if (fixed) {
          var tl = textLines(text);
          if (!tl.lines.length) throw new Error('That file has no lines.');
          var width = tl.lines.reduce(function (m, l) { return Math.max(m, l.length); }, 0);
          return { mode: 'fixed', name: st.results.name, lines: tl.lines.slice(0, 16).map(maskLine), width: Math.min(width, 2000), total: tl.lines.length, skip: fixedHeaderLines(tl.lines) };
        }
        var t = parseTable(text, { maxRows: LIMITS.resultLines });
        if (t.empty || !t.rows.length) throw new Error('That file has no rows Muster can read.');
        var g = guessResultColumns(t.headers);
        st.results.table = t;
        return { mode: 'csv', name: st.results.name, headers: t.headers, guess: g.map, ignored: g.ignored, sample: t.rows.slice(0, 5).map(function (r) { return r.map(function (v, i) { return g.ignored.indexOf(i) >= 0 ? '(ignored)' : maskLine(v); }); }), total: t.total };
      },
      rawLines: function () { if (!st.results || !st.results.fixed) return []; return textLines(st.results.text).lines.slice(0, 16); },
      readResults: function (x) {
        if (!st.results) throw new Error('Load the results file first.');
        var list;
        if (st.results.fixed) {
          var tl = textLines(st.results.text);
          var width = tl.lines.reduce(function (m, l) { return Math.max(m, l.length); }, 0);
          var p = spanProblems(x.spans, width);
          if (p.length) throw new Error(p[0]);
          var skip = Math.max(0, Math.min(5, Math.floor(Number(x.skip) || 0)));
          list = readResultsFixed(tl.lines.slice(skip), tl.nums.slice(skip), x.spans);
        } else {
          var probs = resultProblems(x.map);
          if (probs.length) throw new Error(probs[0]);
          var ign = guessResultColumns(st.results.table.headers).ignored;
          var map = {};
          RKEYS.forEach(function (k) { var c = x.map[k]; map[k] = c === null || c === undefined || ign.indexOf(c) >= 0 ? null : c; });
          list = readResultsCsv(st.results.table, map);
        }
        var out = safeResults(list, people());
        st.results = null;
        return { results: out, count: out.length };
      },
      drop: function () { st = { table: null, name: '', demo: false, loans: null, map: null, opts: null, results: null, people: null }; return true; },
      has: function () { return { portfolio: Boolean(st.loans), name: st.name, demo: st.demo }; },
    };
  }

  return {
    LIMITS: LIMITS, RULES: RULES, CITATION: CITATION, NOT_ADVICE: NOT_ADVICE, ESTIMATE: ESTIMATE, CAP_U: CAP_U,
    PFIELDS: PFIELDS, pfield: pfield, PKEYS: PKEYS, RFIELDS: RFIELDS, RKEYS: RKEYS, LOAN_TYPES: LOAN_TYPES, TYPE_WORD: TYPE_WORD, TYPE_NOUN: TYPE_NOUN,
    CHECKS: CHECKS, LAYOUT_FIELDS: LAYOUT_FIELDS, LAYOUT_LABEL: LAYOUT_LABEL, LAYOUT_NOTE: LAYOUT_NOTE, DEFAULT_LAYOUT: DEFAULT_LAYOUT,
    DECISIONS: DECISIONS, DECISION_WORD: DECISION_WORD, DECISION_MARK: DECISION_MARK, TODO: TODO, STEPS: STEPS, OUTCOMES: OUTCOMES,
    GENESIS: GENESIS, LETTER_CODES: LETTER_CODES, TONES: TONES, PEOPLE_PLACEHOLDERS: PEOPLE_PLACEHOLDERS, FACT_PLACEHOLDERS: FACT_PLACEHOLDERS, DEFAULT_TEMPLATE: DEFAULT_TEMPLATE, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    esc: esc, line: line, para: para, clip: clip, plural: plural, groups: groups, money: money, plainMoney: plainMoney, mask: mask, noMarkup: noMarkup, cap1: cap1,
    isDay: isDay, addDays: addDays, addYears: addYears, daysBetween: daysBetween, niceDay: niceDay, letterDay: letterDay, compact: compact,
    readDate: readDate, dateOrder: dateOrder, ambiguousExample: ambiguousExample, readResultDate: readResultDate, readYesNo: readYesNo, readMoney: readMoney, moneyCents: moneyCents,
    readRate: readRate, rateUnits: rateUnits, rateText: rateText,
    sniffDelimiter: sniffDelimiter, splitRows: splitRows, parseTable: parseTable,
    headerNorm: headerNorm, guessColumns: guessColumns, mappingProblems: mappingProblems, headerOk: headerOk, presetFrom: presetFrom, applyPreset: applyPreset, typeOf: typeOf, typeValues: typeValues, questions: questions,
    fold: fold, splitFull: splitFull, ssnProblem: ssnProblem, maskSsn: maskSsn, buildLoans: buildLoans, rowChecks: rowChecks,
    cleanCrid: cleanCrid, shortCrid: shortCrid, layoutProblems: layoutProblems, cleanLayout: cleanLayout, isDefaultLayout: isDefaultLayout, recordLine: recordLine, layoutSpans: layoutSpans, rulerLines: rulerLines, buildRequest: buildRequest, entry: entry,
    guessResultColumns: guessResultColumns, resultProblems: resultProblems, spanProblems: spanProblems, looksFixed: looksFixed, textLines: textLines, readResultsCsv: readResultsCsv, readResultsFixed: readResultsFixed, fixedHeaderLines: fixedHeaderLines, matchResults: matchResults,
    overInterest: overInterest, feesFor: feesFor, monthlyOver: monthlyOver, overCap: overCap, estimate: estimate, decide: decide, decideAll: decideAll, sortDecisions: sortDecisions, totals: totals,
    workFrom: workFrom, stepsLeft: stepsLeft, worklist: worklist, recheckList: recheckList, medianToRate: medianToRate,
    canonical: canonical, hashInput: hashInput, hex: hex, nextEvent: nextEvent, verifyAudit: verifyAudit, describeEvent: describeEvent,
    csvCell: csvCell, toCsv: toCsv, examCsv: examCsv, summaryMarkdown: summaryMarkdown, auditJson: auditJson,
    letterFacts: letterFacts, fillLetter: fillLetter, letterPayload: letterPayload, letterRequest: letterRequest, allowedNumbers: allowedNumbers, cleanAiLetter: cleanAiLetter,
    defaults: defaults, cleanSettings: cleanSettings, mergeSettings: mergeSettings,
    peopleOf: peopleOf, initials: initials, safeName: safeName, scrubDigits: scrubDigits, scrubText: scrubText, safeBatch: safeBatch, safeResults: safeResults, safeEvent: safeEvent, maskLine: maskLine,
    createEngine: createEngine,
  };
}));
