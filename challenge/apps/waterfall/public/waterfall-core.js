/* Waterfall - the rules. Billings in, revenue out: the deferred revenue
 * schedule that ties to your ledger.
 *
 * UMD: window.WaterfallCore in the page, importScripts() in the worker,
 * require() in the server and the tests. Everything that reads a billing
 * export, guesses its columns, splits a line across months, builds the
 * waterfall, rolls deferred revenue forward, writes journal entries,
 * explains why a dashboard and a ledger disagree, or checks what the AI
 * sends and returns lives here, so the page, the worker, the server's
 * validation and the tests run the same code. No clock, no dice, no
 * network, no storage: "today" is never needed, and nothing is kept.
 *
 * What is in here, top to bottom:
 *   - text cleaning and escaping (the one door every file string goes through)
 *   - currencies and money (integer minor units - cents - never floats)
 *   - dates (UTC day numbers; ISO, Unix seconds, MM/DD/YYYY and DD/MM/YYYY)
 *   - a CSV / TSV reader (RFC 4180 quoting, any delimiter, BOM, a preamble)
 *   - the columns: guessing from header names and value shapes, the questions
 *     (day/month order, period end exclusive or inclusive, cents, discount
 *     and tax basis, the currency), presets by header name
 *   - billing lines built from a mapped file, the row checks, line types,
 *     invoice status, product keys (the rows of the rules table)
 *   - recognition: the rules, the day split with largest-remainder rounding
 *   - the schedule: recognised revenue by month, the waterfall, the deferred
 *     revenue roll-forward, the journal entries - per currency
 *   - why the dashboard and the ledger disagree: the buckets, to the cent
 *   - customers and the drill-down
 *   - exports (formula-safe CSV, masked names, escaped Markdown)
 *   - settings (presets, rules, account names - never a customer)
 *   - the AI request (product descriptions and shapes only) and its answer
 *   - the engine the worker and the page drive
 *
 * Waterfall applies the rules you choose - your accountant decides the
 * policy. It states no accounting standard and makes no claim beyond the
 * plain mechanics of the rule chosen for each product.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WaterfallCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    fileBytes: 25 * 1024 * 1024,   // a file bigger than this is refused before it is read
    rows: 250000,                   // billing lines kept from one file
    columns: 80,
    cell: 300,                      // characters kept from one cell
    headerChars: 60,
    presets: 10,
    rules: 500,                     // rules kept in settings
    products: 5000,                 // distinct products in a rules table
    aiProducts: 200,                // descriptions sent to the AI at most
    aiChars: 120,                   // characters per description sent
    reasonChars: 160,
    accountChars: 60,
    descChars: 120,
    periodDays: 3660,               // a service period longer than ten years is refused
    months: 60,                     // "over N months": 1 to 60
    amountMax: 1e12,                // minor units in one line (ten billion dollars)
    groupRows: 200,                 // rows listed per row check (all are counted)
    bucketLines: 200,               // lines listed per bucket (all are counted)
    customersShown: 200,
    lineList: 500,                  // a customer's lines listed in the drill-down
    sample: 6,
  };

  var NOT_POLICY = 'Waterfall applies the rules you choose - your accountant decides the policy.';
  var NO_FX = 'Each currency is its own schedule - Waterfall converts nothing.';
  var SETUP_LINE = 'Setup and implementation fees are often deferred - your accountant decides.';

  /* ================================================================== *
   * Text: one door for every string a file, a person or a model wrote
   * ================================================================== */

  // Control characters, bidi overrides and zero-width characters: each is
  // invisible or reorders text, so in a customer name or a description it
  // could make one line look like another. Built from code points so no
  // invisible character ever sits in this source file.
  var BAD_RANGES = [[0, 8], [11, 12], [14, 31], [0x7F, 0x9F], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF]];
  function hx4(n) { return '\\u' + ('000' + n.toString(16)).slice(-4); }
  var BAD_CLASS = '[' + BAD_RANGES.map(function (p) { return hx4(p[0]) + '-' + hx4(p[1]); }).join('') + ']';
  var BAD = new RegExp(BAD_CLASS, 'g');
  var BAD1 = new RegExp(BAD_CLASS);
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  function esc(v) { return str(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function clip(s, n) { return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).replace(/\s+$/, '') + '…'; }
  /** One line, invisible characters gone, bounded. */
  function line(v, max) { return clip(str(v).replace(BAD, '').replace(/\s+/g, ' ').trim(), max || 200); }
  function noMarkup(s) { return str(s).replace(/<[^>]{0,200}>/g, '').replace(/[<>]/g, ''); }
  function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function plural(n, one, many) { return groups(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  /* ================================================================== *
   * Currencies and money - integer minor units, never floats
   * ================================================================== */

  var ZERO_DEC = ['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'];
  var THREE_DEC = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];
  var SYMBOL = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'CA$', AUD: 'A$', NZD: 'NZ$', INR: '₹' };
  function isCcy(c) { return typeof c === 'string' && /^[A-Z]{3}$/.test(c); }
  function decimalsOf(c) { return ZERO_DEC.indexOf(c) >= 0 ? 0 : THREE_DEC.indexOf(c) >= 0 ? 3 : 2; }
  function unitOf(c) { return Math.pow(10, decimalsOf(c)); }

  /** $1,234.56 / -€12.00 / CHF 1,234.56 from minor units. */
  function money(minor, ccy) {
    if (typeof minor !== 'number' || !isFinite(minor)) return '';
    var c = isCcy(ccy) ? ccy : 'USD';
    var dp = decimalsOf(c), u = Math.pow(10, dp);
    var neg = minor < 0, a = Math.abs(Math.round(minor));
    var whole = groups(Math.floor(a / u));
    var frac = dp ? '.' + pad(a % u, dp) : '';
    var sym = SYMBOL[c];
    return (neg ? '-' : '') + (sym ? sym + whole + frac : c + ' ' + whole + frac);
  }
  /** 1234.56 for a spreadsheet: a plain number, never a formula. */
  function plain(minor, ccy) {
    if (typeof minor !== 'number' || !isFinite(minor)) return '';
    var dp = decimalsOf(isCcy(ccy) ? ccy : 'USD'), u = Math.pow(10, dp);
    var a = Math.abs(Math.round(minor));
    return (minor < 0 ? '-' : '') + Math.floor(a / u) + (dp ? '.' + pad(a % u, dp) : '');
  }
  /** A decimal as written: {neg, whole, frac} from "1,234.56", "-12", "(12.00)",
   *  "1.234,56", "$49.00", "49.00 USD"; null when it is not an amount. */
  function readDecimal(v) {
    var s = line(v, 40);
    if (!s || !/\d/.test(s)) return null;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    s = s.replace(/^[A-Za-z]{3}\s+/, '').replace(/\s+[A-Za-z]{3}$/, '');
    if (/^[-−]/.test(s)) { neg = true; s = s.slice(1).trim(); }
    if (/-$/.test(s)) { neg = true; s = s.slice(0, -1).trim(); }
    s = s.replace(/^(?:US\$|CA\$|A\$|NZ\$|[$€£¥₹])\s*/, '');
    if (/^[-−]/.test(s)) { neg = true; s = s.slice(1).trim(); }
    var m;
    if ((m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(s))) return { neg: neg, whole: m[1].replace(/,/g, ''), frac: m[2] || '' };
    if ((m = /^(\d{1,3}(?:\.\d{3})+|\d+),(\d{1,3})$/.exec(s))) return { neg: neg, whole: m[1].replace(/\./g, ''), frac: m[2] };
    if ((m = /^(\d{1,3}(?:[ ]\d{3})+)(?:[.,](\d+))?$/.exec(s))) return { neg: neg, whole: m[1].replace(/ /g, ''), frac: m[2] || '' };
    return null;
  }
  /** Minor units from a decimal: `units` 'minor' means the file already
   *  writes cents. Too many decimals for the currency is unreadable (null),
   *  unless the extra digits are zeros. */
  function toMinor(dec, ccy, units) {
    if (!dec) return null;
    var dp = decimalsOf(ccy);
    var whole = dec.whole.replace(/^0+(?=\d)/, '');
    var frac = dec.frac;
    if (units === 'minor') {
      if (frac && /[1-9]/.test(frac)) return null;
      frac = '';
      dp = 0;
    }
    if (frac.length > dp) { if (/[1-9]/.test(frac.slice(dp))) return null; frac = frac.slice(0, dp); }
    while (frac.length < dp) frac += '0';
    if (whole.length + frac.length > 15) return null;
    var n = Number(whole + frac);
    if (!isFinite(n)) return null;
    return dec.neg && n ? -n : n;
  }
  /** An exchange rate as integer millionths: "1.08" -> 1080000. */
  function readRate(v) {
    var s = line(v, 20).replace(',', '.');
    if (!/^\d{1,4}(?:\.\d{1,6})?$/.test(s)) return null;
    var p = s.split('.'), frac = (p[1] || '');
    while (frac.length < 6) frac += '0';
    var u = Number(p[0]) * 1000000 + Number(frac);
    return u > 0 && u <= 1e9 ? u : null;
  }
  function rateText(u) { var s = (u / 1000000).toFixed(6).replace(/0+$/, ''); return /\.$/.test(s) ? s + '00' : (/\.\d$/.test(s) ? s + '0' : s); }
  /** minor x rate, rounded half away from zero, in exact integer arithmetic. */
  function convert(minor, rateU) {
    if (typeof BigInt === 'function') {
      var p = BigInt(Math.round(minor)) * BigInt(rateU);
      var neg = p < BigInt(0);
      if (neg) p = -p;
      var q = (p + BigInt(500000)) / BigInt(1000000);
      return Number(neg ? -q : q);
    }
    var x = minor * rateU / 1000000;
    return x < 0 ? -Math.round(-x) : Math.round(x);
  }

  /* ================================================================== *
   * Dates - UTC day numbers (days since 1970-01-01)
   * ================================================================== */

  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Civil date <-> day number (Howard Hinnant's algorithms): no Date object,
  // no time zone, exact for any year.
  function fromCivil(y, m, d) {
    y -= m <= 2 ? 1 : 0;
    var era = Math.floor(y / 400), yoe = y - era * 400;
    var doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }
  function toCivil(z) {
    z += 719468;
    var era = Math.floor(z / 146097), doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp < 10 ? mp + 3 : mp - 9;
    return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
  }
  function daysInMonth(y, m) { return m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
  function dayOf(y, m, d) {
    if (!(y >= 1970 && y <= 2199 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m))) return null;
    return fromCivil(y, m, d);
  }
  function isoDay(day) { if (typeof day !== 'number' || !isFinite(day)) return ''; var c = toCivil(day); return c[0] + '-' + pad(c[1], 2) + '-' + pad(c[2], 2); }
  function dayFromIso(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s)); return m ? dayOf(+m[1], +m[2], +m[3]) : null; }
  /** 15 Oct 2026 - unambiguous on the page and in every export. */
  function niceDay(day) { if (typeof day !== 'number') return ''; var c = toCivil(day); return c[2] + ' ' + MONTH_SHORT[c[1] - 1] + ' ' + c[0]; }
  /** Month index: year * 12 + month - 1. */
  function monthOfDay(day) { var c = toCivil(day); return c[0] * 12 + c[1] - 1; }
  function monthStart(mi) { return fromCivil(Math.floor(mi / 12), (mi % 12) + 1, 1); }
  function monthEnd(mi) { return monthStart(mi + 1) - 1; }
  function monthKey(mi) { return Math.floor(mi / 12) + '-' + pad((mi % 12) + 1, 2); }
  function monthFromKey(k) { var m = /^(\d{4})-(\d{2})$/.exec(str(k)); return m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1970 && +m[1] <= 2199 ? +m[1] * 12 + (+m[2] - 1) : null; }
  function monthLabel(mi) { return MONTH_SHORT[mi % 12] + ' ' + Math.floor(mi / 12); }
  function monthLong(mi) { return MONTH_LONG[mi % 12] + ' ' + Math.floor(mi / 12); }
  /** The same day n months later (31 Jan + 1 month = 28 or 29 Feb). */
  function addMonths(day, n) {
    var c = toCivil(day), t = c[0] * 12 + (c[1] - 1) + n;
    var y = Math.floor(t / 12), m = (t % 12) + 1;
    return fromCivil(y, m, Math.min(c[2], daysInMonth(y, m)));
  }
  function year2(y) { return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y; }
  function monthWord(w) { var i = MONTHS.indexOf(str(w).toLowerCase().slice(0, 3)); return i < 0 ? 0 : i + 1; }

  /**
   * A date or timestamp the way a billing export writes it: {day, eod,
   * midnight} or null. `order` is 'mdy' (the default) or 'dmy' for n/n/yyyy.
   * Unix seconds (and milliseconds) and Excel serial days are read only
   * when `loose` is set (the column was mapped as a date), because they look
   * like other numbers. A timestamp with a zone is moved to UTC; one without
   * is taken as written (billing exports write UTC). eod is 23:59(:59),
   * midnight 00:00(:00) - both are evidence for how a period ends.
   */
  function readStamp(v, order, loose) {
    var s = line(v, 40);
    if (!s) return null;
    var m, day = null, hh = null, mm = 0, ss = 0;
    if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2}|UTC|GMT)?)?$/i.exec(s))) {
      day = dayOf(+m[1], +m[2], +m[3]);
      if (day === null) return null;
      if (m[4] !== undefined) {
        hh = +m[4]; mm = +m[5]; ss = m[6] ? +m[6] : 0;
        if (hh > 23 || mm > 59 || ss > 60) return null;
        var z = m[7] ? m[7].toUpperCase() : '';
        if (z && z !== 'Z' && z !== 'UTC' && z !== 'GMT') {
          var zm = /^([+-])(\d{2}):?(\d{2})$/.exec(z);
          var off = (zm[1] === '-' ? -1 : 1) * (+zm[2] * 60 + +zm[3]);
          var mins = hh * 60 + mm - off;
          day += Math.floor(mins / 1440);
          mins = ((mins % 1440) + 1440) % 1440;
          hh = Math.floor(mins / 60); mm = mins % 60;
        }
      }
    } else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(s))) {
      var a = +m[1], b = +m[2], y = year2(+m[3]);
      day = order === 'dmy' ? dayOf(y, b, a) : dayOf(y, a, b);
      if (day === null) return null;
      if (m[4] !== undefined) { hh = +m[4] % 24; mm = +m[5]; ss = m[6] ? +m[6] : 0; if (m[7]) { var pm = /p/i.test(m[7]); hh = (+m[4] % 12) + (pm ? 12 : 0); } }
    } else if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) {
      day = monthWord(m[1]) ? dayOf(+m[3], monthWord(m[1]), +m[2]) : null;
    } else if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{4})$/.exec(s))) {
      day = monthWord(m[2]) ? dayOf(+m[3], monthWord(m[2]), +m[1]) : null;
    } else if (loose && /^\d{9,13}$/.test(s)) {
      var n = Number(s);
      var secs = s.length >= 12 ? Math.floor(n / 1000) : n;
      if (secs < 86400 * 365 || secs > 7258118400) return null;
      day = Math.floor(secs / 86400);
      var rest = secs - day * 86400;
      hh = Math.floor(rest / 3600); mm = Math.floor((rest % 3600) / 60); ss = rest % 60;
    } else if (loose && /^\d{5}$/.test(s) && +s > 25569 && +s < 80000) {
      day = +s - 25569;
    } else if (loose && (m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
      day = dayOf(+m[1], +m[2], +m[3]);
    }
    if (day === null) return null;
    return { day: day, eod: hh === 23 && mm === 59, midnight: hh === 0 && mm === 0 && ss === 0 };
  }
  /** Which way a column's n/n/yyyy dates run: 'mdy' or 'dmy' when a part
   *  over 12 says so, 'either' when every value reads both ways (03/04),
   *  'none' when there are no n/n/yyyy dates. */
  function dateOrder(values) {
    var dmy = 0, mdy = 0, both = 0;
    for (var i = 0; i < values.length && i < 20000; i++) {
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
    for (var i = 0; i < values.length && i < 20000; i++) {
      var s = line(values[i], 40), m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})/.exec(s);
      if (m && +m[1] <= 12 && +m[2] <= 12 && +m[1] !== +m[2]) {
        var a = readStamp(s, 'mdy', true), b = readStamp(s, 'dmy', true);
        return { raw: s, mdy: a ? niceDay(a.day) : '', dmy: b ? niceDay(b.day) : '' };
      }
    }
    return null;
  }
  function readYesNo(v) {
    var s = line(v, 12).toLowerCase();
    if (/^(y|yes|true|1|t)$/.test(s)) return true;
    if (/^(n|no|false|0|f)$/.test(s)) return false;
    return null;
  }

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

  function cellOf(v, stats) {
    var s = str(v);
    var bad = s.match(BAD);
    if (bad) { stats.invisible += bad.length; s = s.replace(BAD, ''); }
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > LIMITS.cell) { stats.cut++; s = clip(s, LIMITS.cell); }
    return s;
  }
  function looksLikeData(r) {
    var n = 0, data = 0;
    r.forEach(function (v) { if (!v) return; n++; if (readDecimal(v) || readStamp(v) || /^\d{3,}$/.test(v.replace(/[\s-]/g, ''))) data++; });
    return n > 0 && data / n >= 0.5;
  }

  /** A whole file, read: {headers, rows, lines, delimiter, header, preamble,
   *  total, kept, truncated, ragged, invisible, cut, openQuote, empty, wide}. */
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
    var first = raw[h].slice(0, width).map(function (v) { return cellOf(v, stats); });
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
      for (var c = 0; c < width; c++) row.push(cellOf(r[c], stats));
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
   * The columns: fields, the guess from header names and value shapes
   * ================================================================== */

  var FIELDS = [
    { key: 'invoice', label: 'Invoice id', want: true },
    { key: 'lineId', label: 'Line id' },
    { key: 'customer', label: 'Customer', want: true },
    { key: 'customerId', label: 'Customer id' },
    { key: 'date', label: 'Invoice date', need: true },
    { key: 'amount', label: 'Amount', need: true },
    { key: 'discount', label: 'Discount' },
    { key: 'tax', label: 'Tax (never revenue)' },
    { key: 'currency', label: 'Currency' },
    { key: 'start', label: 'Service period start', want: true },
    { key: 'end', label: 'Service period end', want: true },
    { key: 'desc', label: 'Description', want: true },
    { key: 'product', label: 'Product / price' },
    { key: 'type', label: 'Line type' },
    { key: 'proration', label: 'Proration flag' },
    { key: 'status', label: 'Invoice status', want: true },
  ];
  var FKEYS = FIELDS.map(function (f) { return f.key; });
  function field(key) { return FIELDS.filter(function (f) { return f.key === key; })[0] || null; }

  function headerNorm(h) {
    return str(h).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/[_./\\#()[\]:-]+/g, ' ').replace(/[^a-z0-9%& ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // [pattern, points]: the first that matches gives the points.
  var HRULES = {
    invoice: [[/^(invoice (id|number|no|num|ref|reference)|invoice|inv (id|no|number)|bill (id|number|no)|document (number|no)|doc (no|number|id))$/, 10], [/\b(invoice (id|number|no|num)|invoice)\b/, 8]],
    lineId: [[/\b(line (item )?(id|number|no)|line id|item id)\b/, 10], [/^id$/, 6]],
    customer: [[/\b(customer name|client name|account name|company name|billing name|bill to name)\b/, 10], [/\b(customer|client|company|account|bill to|name)\b/, 7]],
    customerId: [[/\b(customer id|client id|account id|cust id|customer number|customer no|account number|customer key|customer code)\b/, 10], [/^(customer|client|account)$/, 6]],
    date: [[/\b(invoice date|invoice created|issue date|billing date|bill date|document date)\b/, 10], [/\b(date|created|issued|finali[sz]ed|posted)\b/, 7]],
    amount: [[/^(amount|line amount|line total|amount net|net amount|amount excl(uding)? tax)( utc)?$/, 10], [/\b(amount|subtotal|line total|charge|revenue|billed)\b/, 8], [/\b(total|net|price|value)\b/, 6]],
    discount: [[/\b(discount amount|discounts?|coupon amount|amount off)\b/, 10], [/\bcoupon\b/, 6]],
    tax: [[/\b(tax amount|tax|vat|gst|sales tax|tax total|vat amount)\b/, 10]],
    currency: [[/\b(currency|ccy|currency code|cur)\b/, 10]],
    start: [[/\b(period start|service start|start date|period from|service from|line item period start)\b/, 10], [/\b(start|from|starts|begin|begins)\b/, 7]],
    end: [[/\b(period end|service end|end date|period to|service to|line item period end)\b/, 10], [/\b(end|to|through|thru|until|ends)\b/, 7]],
    desc: [[/\b(description|line description|item description|memo)\b/, 10], [/\b(desc|details|line item|item|narrative)\b/, 7]],
    product: [[/\b(product|product name|plan|plan name|price name|sku|item name|price id|product id|plan id|offering)\b/, 10], [/\b(price|service)\b/, 5]],
    type: [[/\b(line type|item type|charge type|line kind)\b/, 10], [/\b(type|kind|category)\b/, 7]],
    proration: [[/\b(proration|prorated|prorate)\b/, 10]],
    status: [[/\b(invoice status|status)\b/, 10], [/\b(state|paid status|payment status)\b/, 7]],
  };
  var HNOT = {
    invoice: /\b(date|status|line|item|amount|total|period|created|due|paid|currency|tax|customer|url|pdf|subscription)\b/,
    lineId: /\b(customer|cust|client|account|product|price|plan|subscription|tax|charge)\b/,
    customer: /\b(id|email|e mail|number|no|type|country|address|city|state|zip|postal|tax|phone|currency|since|created|code|key|description|product)\b/,
    customerId: /\b(email|name)\b/,
    date: /\b(period|start|end|due|paid|updated|modified|from|to|through|service|birth|voided|marked|uncollectible|cancel|cancelled|trial)\b/,
    amount: /\b(tax|vat|gst|discount|coupon|currency|due|paid|remaining|unit|quantity|qty|refunded|credited|id|count|percent|rate|pct|before|gross)\b/,
    discount: /\b(code|id|name|percent|rate|pct|type)\b/,
    tax: /\b(rate|id|code|percent|pct|exempt|type|behavior|behaviour|inclusive|number|country|jurisdiction|name)\b/,
    currency: /\b(amount|rate|converted|symbol)\b/,
    start: /\b(trial|cancel|subscription created)\b/,
    end: /\b(trial|cancel|cancelled)\b/,
    desc: /\b(id|type|amount|tax|code)\b/,
    product: /\b(amount|unit|date|quantity|qty|type|period|tax|description)\b/,
    type: /\b(customer|tax|payment|billing reason|price type|id)\b/,
    proration: /\b(date|amount)\b/,
    status: /\b(subscription|customer|tax|payment intent)\b/,
  };

  var STATUS_RE = /^(paid|open|void|voided|draft|uncollectible|written off|write off|bad debt|posted|issued|finali[sz]ed|sent|past due|overdue|due|unpaid|partially paid|partial|cancell?ed|deleted)$/i;
  var TYPE_RE = /\b(subscription|recurring|plan|license|seat|usage|metered|overage|consumption|proration|prorated|one ?time|one_time|setup|invoice ?item|invoiceitem|fee|credit|refund|adjustment|service)\b/i;
  /** What a column's values look like. */
  function profile(values) {
    var p = { n: 0, date: 0, unix: 0, money: 0, neg: 0, int: 0, ccy: 0, status: 0, type: 0, yesno: 0, alpha: 0, id: 0, distinct: 0 };
    var seen = {};
    for (var i = 0; i < values.length && i < 600; i++) {
      var v = values[i];
      if (!v) continue;
      p.n++;
      if (!seen[v]) { seen[v] = 1; p.distinct++; }
      if (readStamp(v, 'mdy', true)) p.date++;
      if (/^\d{9,13}$/.test(v)) p.unix++;
      var d = readDecimal(v);
      if (d && !/^\d{4}[-/]/.test(v) && !/^\d{9,}$/.test(v)) { p.money++; if (d.neg) p.neg++; }
      if (/^-?\d+$/.test(v)) p.int++;
      if (/^[A-Za-z]{3}$/.test(v)) p.ccy++;
      if (STATUS_RE.test(v)) p.status++;
      if (TYPE_RE.test(v) && v.length <= 30) p.type++;
      if (readYesNo(v) !== null) p.yesno++;
      if (/[A-Za-z]{2,}/.test(v)) p.alpha++;
      if (/^[A-Za-z0-9_.:-]{4,40}$/.test(v) && /\d/.test(v)) p.id++;
    }
    return p;
  }
  function frac(p, k) { return p.n ? p[k] / p.n : 0; }

  /** Points a column's values earn for a field. */
  function shapePoints(key, p) {
    if (!p.n) return 0;
    switch (key) {
      case 'date': case 'start': case 'end': return frac(p, 'date') >= 0.8 ? 5 : -6;
      case 'amount': return frac(p, 'money') >= 0.9 && frac(p, 'date') < 0.5 ? (p.neg ? 5 : 4) : -6;
      case 'discount': case 'tax': return frac(p, 'money') >= 0.9 && frac(p, 'date') < 0.5 ? 3 : -5;
      case 'currency': return frac(p, 'ccy') >= 0.9 ? 6 : -6;
      case 'status': return frac(p, 'status') >= 0.6 ? 6 : -4;
      case 'type': return frac(p, 'type') >= 0.6 ? 5 : (p.distinct <= 12 ? 0 : -4);
      case 'proration': return frac(p, 'yesno') >= 0.9 ? 5 : -5;
      case 'invoice': case 'customerId': return frac(p, 'id') + frac(p, 'int') >= 0.8 ? 3 : -2;
      case 'lineId': return frac(p, 'id') + frac(p, 'int') >= 0.8 && p.distinct >= p.n * 0.95 ? 4 : -3;
      case 'customer': return frac(p, 'alpha') >= 0.8 ? 3 : (frac(p, 'id') >= 0.8 ? 1 : -3);
      case 'desc': case 'product': return frac(p, 'alpha') >= 0.8 && frac(p, 'money') < 0.5 ? 2 : -3;
      default: return 0;
    }
  }
  function headerPoints(key, raw) {
    var norm = headerNorm(raw);
    if (!norm) return 0;
    if (HNOT[key] && HNOT[key].test(norm)) return 0;
    var rules = HRULES[key] || [];
    for (var i = 0; i < rules.length; i++) if (rules[i][0].test(norm)) return rules[i][1];
    return 0;
  }

  /**
   * Which column is which: {map: {field: column index | null}, conf:
   * {field: 'sure'|'likely'|'unsure'}}. Header points plus value-shape
   * points; best pair first, each column and each field once. A field with
   * no header match is placed only when its values can hardly be anything
   * else (three-letter currency codes, invoice statuses).
   */
  function guessColumns(headers, rows) {
    var cols = headers.map(function (h, i) { return profile(rows.map(function (r) { return r[i] || ''; })); });
    var cands = [];
    FKEYS.forEach(function (key) {
      headers.forEach(function (h, i) {
        var hp = headerPoints(key, h), sp = shapePoints(key, cols[i]);
        var shapeOnly = !hp && ((key === 'currency' && sp >= 6) || (key === 'status' && sp >= 6));
        if (!hp && !shapeOnly) return;
        var score = hp + sp;
        if (score < 6 && hp < 10) return;
        cands.push({ key: key, i: i, score: score, conf: hp && sp > 0 ? 'sure' : hp ? 'likely' : 'unsure' });
      });
    });
    cands.sort(function (a, b) { return b.score - a.score || a.i - b.i || FKEYS.indexOf(a.key) - FKEYS.indexOf(b.key); });
    var map = {}, conf = {}, used = {};
    FKEYS.forEach(function (k) { map[k] = null; });
    cands.forEach(function (c) {
      if (map[c.key] !== null || used[c.i]) return;
      map[c.key] = c.i; conf[c.key] = c.conf; used[c.i] = true;
    });
    return { map: map, conf: conf };
  }

  /** What stops building from this mapping, in words. */
  function mappingProblems(map) {
    var out = [];
    var has = function (k) { return map && map[k] !== null && map[k] !== undefined; };
    if (!has('amount')) out.push('Choose the column with the amount.');
    if (!has('date') && !has('start')) out.push('Choose the invoice date (or at least the service period start).');
    if (has('end') && !has('start')) out.push('A period end needs its period start too.');
    var seen = {};
    FKEYS.forEach(function (k) { var i = map && map[k]; if (i === null || i === undefined) return; if (seen[i]) out.push('One column is chosen for two fields.'); seen[i] = 1; });
    return out.filter(function (x, i, a) { return a.indexOf(x) === i; });
  }
  /** Is a header safe to remember (a name, not a value)? */
  function headerOk(h) {
    var s = str(h);
    return Boolean(s) && s.length <= LIMITS.headerChars && !/@|\d{3,}|\d[-/.:]\d|[<>{}`\\]/.test(s) && !BAD1.test(s);
  }
  /** A preset: the header names an export uses, never a value. */
  function presetFrom(headers, map) {
    var out = {};
    FKEYS.forEach(function (k) { var i = map[k]; if (i !== null && i !== undefined && headers[i] && headerOk(headers[i])) out[k] = headers[i]; });
    return out;
  }
  function applyPreset(headers, presets) {
    var lower = headers.map(function (h) { return str(h).toLowerCase(); });
    var best = null, bestN = 0;
    (presets || []).forEach(function (p) {
      var keys = Object.keys(p.map || {}), hit = keys.filter(function (k) { return lower.indexOf(str(p.map[k]).toLowerCase()) >= 0; }).length;
      if (keys.length && hit / keys.length >= 0.8 && hit > bestN) { best = p; bestN = hit; }
    });
    if (!best) return null;
    var map = {};
    FKEYS.forEach(function (k) { map[k] = null; });
    Object.keys(best.map).forEach(function (k) { var i = lower.indexOf(str(best.map[k]).toLowerCase()); if (i >= 0 && FKEYS.indexOf(k) >= 0) map[k] = i; });
    return { name: best.name, map: map };
  }

  /* ================================================================== *
   * The questions: asked once, each with the evidence
   * ================================================================== */

  function colValues(table, i, max) {
    var out = [];
    if (i === null || i === undefined) return out;
    for (var r = 0; r < table.rows.length && out.length < (max || 20000); r++) { var v = table.rows[r][i]; if (v) out.push(v); }
    return out;
  }

  /**
   * What Waterfall needs to ask before it reads every line:
   *   order     - n/n/yyyy dates that read both ways (both readings shown)
   *   units     - amounts that are all whole numbers: dollars or cents?
   *   periodEnd - is a period's end the first day of the next period
   *               (exclusive, the way Stripe writes it) or its last day?
   *   discount  - with a discount column: is the amount before or after it?
   *   tax       - with a tax column: does the amount include it?
   *   currency  - no currency column (or blanks in it): which currency?
   * Each comes with a suggestion and why; nothing is assumed silently.
   */
  function questions(table, map, answers) {
    answers = answers || {};
    var q = {};
    var dateVals = [];
    ['date', 'start', 'end'].forEach(function (k) { dateVals = dateVals.concat(colValues(table, map[k], 8000)); });
    var ord = dateOrder(dateVals);
    q.order = { ask: ord === 'either', decided: ord === 'dmy' || ord === 'mdy' ? ord : null, example: ord === 'either' ? ambiguousExample(dateVals) : null, suggestion: ord === 'dmy' ? 'dmy' : 'mdy' };
    var order = answers.order || q.order.decided || q.order.suggestion;

    if (map.amount !== null && map.amount !== undefined) {
      var av = colValues(table, map.amount, 5000);
      var whole = function (v) { var d = readDecimal(v); return d && !d.frac ? Number(d.whole) * (d.neg ? -1 : 1) : null; };
      var ints = av.filter(function (v) { return whole(v) !== null; }).length;
      var hdr = headerNorm(table.headers[map.amount]);
      if (av.length >= 3 && ints === av.length) {
        var ex = av.filter(function (v) { return Math.abs(whole(v)) >= 100; })[0] || av[0];
        var n = whole(ex);
        var cv0 = map.currency !== null && map.currency !== undefined ? colValues(table, map.currency, 1)[0] : '';
        var c0 = isCcy(str(cv0).toUpperCase()) ? str(cv0).toUpperCase() : isCcy(answers.currency) ? answers.currency : 'USD';
        q.units = { ask: true, suggestion: /\b(cents?|minor|pennies)\b/.test(hdr) ? 'minor' : 'major', example: { raw: ex, major: money(n * unitOf(c0), c0), minor: money(n, c0) }, why: /\b(cents?|minor)\b/.test(hdr) ? 'The header says cents.' : 'Every amount is a whole number - some systems write cents that way.' };
      }
    }
    var amtHead = map.amount !== null && map.amount !== undefined ? headerNorm(table.headers[map.amount]) : '';
    if (map.discount !== null && map.discount !== undefined) {
      var after = /\b(net|after|discounted)\b/.test(amtHead), before = /\b(gross|list|before|subtotal|undiscounted)\b/.test(amtHead);
      q.discount = { ask: true, suggestion: after ? 'after' : 'before', why: after ? 'The amount’s header says net.' : before ? 'The amount’s header says it is before discounts.' : 'A separate discount column usually means the amount is before it - check one invoice.' };
    }
    if (map.tax !== null && map.tax !== undefined) {
      var incl = /\b(total|gross|incl|including|with tax|inc tax)\b/.test(amtHead) && !/\b(excl|excluding|net)\b/.test(amtHead);
      q.tax = { ask: true, suggestion: incl ? 'included' : 'excluded', why: incl ? 'The amount’s header looks like a total.' : 'The amount’s header does not say total - tax usually sits beside it.' };
    }
    if (map.currency === null || map.currency === undefined) q.currency = { ask: true, suggestion: answers.currency && isCcy(answers.currency) ? answers.currency : 'USD', why: 'There is no currency column, so every amount is taken as one currency.' };
    else {
      var cv = colValues(table, map.currency, 50000);
      var blanks = table.rows.length - cv.length;
      var seen = {};
      cv.forEach(function (v) { var c = v.toUpperCase(); if (isCcy(c)) seen[c] = (seen[c] || 0) + 1; });
      var top = Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a]; });
      q.currencies = top.slice(0, 12);
      if (blanks > 0) q.currency = { ask: true, suggestion: top[0] || 'USD', blanks: blanks, why: plural(blanks, 'line') + ' have no currency.' };
    }
    if (map.start !== null && map.start !== undefined && map.end !== null && map.end !== undefined) q.periodEnd = periodEvidence(table, map, order);
    return q;
  }

  /** Is a period's end exclusive (the next period's first day: 15 Oct - 15
   *  Nov) or inclusive (its own last day: 15 Oct - 14 Nov)? Counted from the
   *  file: ends on the same day of the month as the start, ends the day
   *  before, 23:59 ends, and periods that chain onto the next one. */
  function periodEvidence(table, map, order) {
    var ex = 0, inc = 0, exEx = [], incEx = [], chainEx = 0, chainInc = 0, n = 0;
    var starts = {};
    var custCol = map.customerId !== null && map.customerId !== undefined ? map.customerId : map.customer;
    var rows = table.rows, lim = Math.min(rows.length, 50000);
    for (var r = 0; r < lim; r++) {
      var a = readStamp(rows[r][map.start], order, true);
      if (a) starts[(custCol !== null && custCol !== undefined ? rows[r][custCol] : '') + '|' + a.day] = 1;
    }
    for (var i = 0; i < lim; i++) {
      var row = rows[i];
      var s = readStamp(row[map.start], order, true), e = readStamp(row[map.end], order, true);
      if (!s || !e || e.day <= s.day) continue;
      n++;
      var cs = toCivil(s.day), ce = toCivil(e.day), cn = toCivil(e.day + 1);
      var key = (custCol !== null && custCol !== undefined ? row[custCol] : '') + '|';
      if (e.eod) { inc += 2; if (incEx.length < 2) incEx.push({ start: niceDay(s.day), end: niceDay(e.day), why: 'ends at 23:59' }); continue; }
      if (ce[2] === cs[2] || (ce[2] === daysInMonth(ce[0], ce[1]) && cs[2] > ce[2])) { ex++; if (exEx.length < 2) exEx.push({ start: niceDay(s.day), end: niceDay(e.day), why: 'ends on the day of the month it starts' }); }
      else if (cn[2] === cs[2] || (cn[2] === 1 && cs[2] === 1)) { inc++; if (incEx.length < 2) incEx.push({ start: niceDay(s.day), end: niceDay(e.day), why: 'ends the day before' }); }
      if (starts[key + e.day]) chainEx++;
      else if (starts[key + (e.day + 1)]) chainInc++;
    }
    var exScore = ex + chainEx, incScore = inc + chainInc;
    return {
      ask: true, lines: n, exclusive: ex, inclusive: inc, chainExclusive: chainEx, chainInclusive: chainInc,
      examples: { exclusive: exEx, inclusive: incEx },
      suggestion: exScore > incScore ? 'exclusive' : 'inclusive',
      none: exScore === 0 && incScore === 0,
    };
  }

  /* ================================================================== *
   * Billing lines: types, statuses, product keys, the row checks
   * ================================================================== */

  var TYPES = ['subscription', 'usage', 'proration', 'onetime', 'credit'];
  var TYPE_WORD = { subscription: 'Subscription', usage: 'Usage', proration: 'Proration', onetime: 'One-time', credit: 'Credit' };
  var STATUSES = ['billed', 'uncollectible', 'void', 'draft'];
  var STATUS_WORD = { billed: 'Billed', uncollectible: 'Uncollectible', void: 'Void', draft: 'Draft' };

  /** An invoice status in words -> billed | uncollectible | void | draft, and
   *  whether it was one Waterfall knows (an unknown one is treated as billed
   *  and counted). Blank is billed. */
  function statusOf(v) {
    var s = line(v, 40).toLowerCase();
    if (!s) return { st: 'billed', known: true };
    if (/\b(void|voided|cancell?ed|deleted)\b/.test(s)) return { st: 'void', known: true };
    if (/\bdraft\b/.test(s)) return { st: 'draft', known: true };
    if (/\b(uncollectible|written off|write ?off|bad debt)\b/.test(s)) return { st: 'uncollectible', known: true };
    if (/\b(paid|open|posted|finali[sz]ed|issued|sent|past due|overdue|due|unpaid|partial(ly paid)?|outstanding|pending)\b/.test(s)) return { st: 'billed', known: true };
    return { st: 'billed', known: false };
  }

  var USAGE_WORDS = /\b(overage|usage|metered|api calls?|per unit|consumption|pay as you go)\b/i;
  var PRORATION_WORDS = /\b(unused time|remaining time|prorat(ed|ion|e))\b/i;
  var ONETIME_WORDS = /\b(setup|set-up|set up|implementation|onboarding|one[- ]?time|installation|training|activation)\b/i;
  var CREDIT_WORDS = /\b(credit|refund|goodwill)\b/i;
  /** The line type: subscription, usage, proration, one-time or credit -
   *  from the type column, the proration flag, the description, the product
   *  and the sign, strongest signal first. */
  function typeOf(o) {
    var tv = line(o.type, 40).toLowerCase(), words = (o.desc || '') + ' ' + (o.product || '');
    if (o.proration === true || /prorat/.test(tv) || PRORATION_WORDS.test(o.desc || '')) return 'proration';
    if (/\b(usage|meter(ed)?|overage|consumption)\b/.test(tv) || USAGE_WORDS.test(words)) return 'usage';
    if (o.amount < 0 || /\b(credit|refund|adjustment)\b/.test(tv) || CREDIT_WORDS.test(words)) return 'credit';
    if (/\b(one ?time|one_time|setup|fee)\b/.test(tv) || ONETIME_WORDS.test(words)) return 'onetime';
    if (/\b(invoice ?item|invoiceitem)\b/.test(tv)) return o.period ? 'subscription' : 'onetime';
    if (/\b(subscription|recurring|plan|license|licence|seat)\b/.test(tv)) return 'subscription';
    return o.period ? 'subscription' : 'onetime';
  }

  var DATE_TOKENS = new RegExp('\\b(\\d{4}-\\d{2}-\\d{2}(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?)?|\\d{1,2}/\\d{1,2}/\\d{2,4}|(?:' + MONTHS.join('|') + ')[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}\\s+(?:' + MONTHS.join('|') + ')[a-z]*\\.?\\s+\\d{4}|(?:' + MONTHS.join('|') + ')[a-z]*\\.?\\s+\\d{4})\\b', 'gi');
  /**
   * The product a line belongs to - one row of the rules table. The product
   * column when there is one; otherwise the description with what changes
   * from line to line taken out: a quantity ("1 × "), proration wording
   * ("Unused time on ... after 15 Mar 2026" belongs to its plan), a price in
   * brackets ("(at $49.00 / month)"), dates and month names.
   */
  function productKey(product, desc) {
    var s = line(product, 200) || line(desc, 300);
    if (!s) return '(no description)';
    s = s.replace(/^\s*\d+(?:[.,]\d+)?\s*[×x*]\s+/i, '')
      .replace(/^(unused time on|remaining time on|time on)\s+/i, '')
      .replace(new RegExp('\\s+(after|from|since|until|through|for)\\s+' + DATE_TOKENS.source + '.*$', 'i'), '')
      .replace(/\((?:[^()]*?)(?:[$€£¥]|\d)[^()]*\)/g, '')
      .replace(DATE_TOKENS, '')
      .replace(/(\s*[-–—:,|/]+\s*){2,}/g, ' - ')
      .replace(/(?:\s*[-–—:,|/]+\s*)+$/, '')
      .replace(/^(?:\s*[-–—:,|/]+\s*)+/, '')
      .replace(/\s+/g, ' ').trim();
    return clip(s, LIMITS.descChars) || '(no description)';
  }

  var CHECKS = {
    amount: { label: 'No amount Waterfall can read', out: true },
    decimals: { label: 'More decimals than the currency has', out: true },
    big: { label: 'An amount over ten billion', out: true },
    date: { label: 'No invoice date and no service period', out: true },
    baddate: { label: 'A date Waterfall cannot read', out: true },
    backwards: { label: 'The period ends before it starts', out: true },
    long: { label: 'A service period over ten years', out: true },
    currency: { label: 'A currency that is not a three-letter code', out: true },
    dupe: { label: 'The same line id twice (the second is left out)', out: true },
    halfperiod: { label: 'Only one end of the service period (read as no period)', out: false },
    zeroperiod: { label: 'A period that starts and ends on the same day (read as no period)', out: false },
    status: { label: 'An invoice status Waterfall does not know (read as billed)', out: false },
    nocustomer: { label: 'No customer (kept as “(no customer)”)', out: false },
  };
  var CHECK_ORDER = Object.keys(CHECKS);

  function cellAt(row, map, k) { var i = map[k]; return i === null || i === undefined ? '' : (row[i] || ''); }

  /**
   * Every line of a mapped file, read. `answers` carries the questions'
   * answers. Lines that cannot be read are left out and listed by their
   * file line (row checks); everything else becomes:
   *   {r, inv, lid, cust, ck, ci, ccy, amt, gross, disc, tax, bill, s, e,
   *    desc, prod, type, st}
   * amt is the revenue amount in minor units (tax and, when the amount is
   * before discounts, the discount taken off); s and e the service period
   * as UTC day numbers with e EXCLUSIVE, whatever the file wrote.
   */
  function buildLines(table, map, answers) {
    var a = answers || {};
    var order = a.order === 'dmy' ? 'dmy' : 'mdy';
    var units = a.units === 'minor' ? 'minor' : 'major';
    var inclusive = a.periodEnd === 'inclusive';
    var discBefore = a.discount !== 'after';
    var taxIncluded = a.tax === 'included';
    var defCcy = isCcy(a.currency) ? a.currency : 'USD';
    var checks = {};
    CHECK_ORDER.forEach(function (k) { checks[k] = { n: 0, rows: [] }; });
    function flag(k, r) { var c = checks[k]; c.n++; if (c.rows.length < LIMITS.groupRows) c.rows.push(r); }
    var lines = [], ids = {}, custIdx = {}, customers = [];
    var has = function (k) { return map[k] !== null && map[k] !== undefined; };
    for (var x = 0; x < table.rows.length; x++) {
      var row = table.rows[x], r = table.lines[x] || x + 2;
      var ccyRaw = has('currency') ? line(cellAt(row, map, 'currency'), 10).toUpperCase() : '';
      var ccy = ccyRaw || defCcy;
      if (!isCcy(ccy)) { flag('currency', r); continue; }
      var dec = readDecimal(cellAt(row, map, 'amount'));
      if (!dec) { flag('amount', r); continue; }
      var gross = toMinor(dec, ccy, units);
      if (gross === null) { flag('decimals', r); continue; }
      if (Math.abs(gross) > LIMITS.amountMax) { flag('big', r); continue; }
      var disc = 0, tax = 0;
      if (has('discount') && cellAt(row, map, 'discount')) { var dd = toMinor(readDecimal(cellAt(row, map, 'discount')), ccy, units); if (dd === null) { flag('amount', r); continue; } disc = Math.abs(dd); }
      if (has('tax') && cellAt(row, map, 'tax')) { var td = toMinor(readDecimal(cellAt(row, map, 'tax')), ccy, units); if (td === null) { flag('amount', r); continue; } tax = td; }
      var amt = gross;
      if (taxIncluded) amt -= tax;
      if (discBefore && disc) { if (amt > 0) amt = Math.max(0, amt - disc); else if (amt < 0) amt = Math.min(0, amt + disc); }
      var dRaw = cellAt(row, map, 'date'), sRaw = cellAt(row, map, 'start'), eRaw = cellAt(row, map, 'end');
      var dS = dRaw ? readStamp(dRaw, order, true) : null, sS = sRaw ? readStamp(sRaw, order, true) : null, eS = eRaw ? readStamp(eRaw, order, true) : null;
      if ((dRaw && !dS) || (sRaw && !sS) || (eRaw && !eS)) { flag('baddate', r); continue; }
      var s = null, e = null;
      if (sS && eS) {
        s = sS.day; e = eS.day + (inclusive ? 1 : 0);
        if (e < s) { flag('backwards', r); continue; }
        if (e === s) { flag('zeroperiod', r); s = null; e = null; }
        else if (e - s > LIMITS.periodDays) { flag('long', r); continue; }
      } else if (sS || eS) { flag('halfperiod', r); }
      var bill = dS ? dS.day : (sS ? sS.day : null);
      if (bill === null) { flag('date', r); continue; }
      var lid = line(cellAt(row, map, 'lineId'), 80);
      if (lid) { if (ids[lid]) { flag('dupe', r); continue; } ids[lid] = 1; }
      var stt = statusOf(cellAt(row, map, 'status'));
      if (!stt.known) flag('status', r);
      var custName = line(cellAt(row, map, 'customer'), 120), custId = line(cellAt(row, map, 'customerId'), 80);
      var ck = (custId || custName).toLowerCase();
      if (!ck) { flag('nocustomer', r); ck = '(no customer)'; }
      if (custIdx[ck] === undefined) { custIdx[ck] = customers.length; customers.push({ key: ck, name: custName || custId || '(no customer)', id: custId }); }
      var desc = line(cellAt(row, map, 'desc'), 300), prodRaw = line(cellAt(row, map, 'product'), 200);
      var period = s !== null;
      lines.push({
        r: r, inv: line(cellAt(row, map, 'invoice'), 80), lid: lid,
        cust: customers[custIdx[ck]].name, ck: ck, ci: custIdx[ck],
        ccy: ccy, amt: amt, gross: gross, disc: disc, tax: tax,
        bill: bill, s: s, e: e,
        desc: desc, prod: productKey(prodRaw, desc),
        type: typeOf({ type: cellAt(row, map, 'type'), proration: has('proration') ? readYesNo(cellAt(row, map, 'proration')) : null, desc: desc, product: prodRaw, amount: amt, period: period }),
        st: stt.st,
      });
    }
    return { lines: lines, checks: checks, customers: customers };
  }

  /** The rows of the rules table: one per product, with its shape. */
  function productsOf(lines) {
    var by = {}, list = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var p = by[l.prod];
      if (!p) {
        if (list.length >= LIMITS.products) continue;
        p = by[l.prod] = { key: l.prod, n: 0, period: 0, types: {}, days: [], neg: 0, totals: {}, statuses: {} };
        list.push(p);
      }
      p.n++;
      if (l.s !== null) { p.period++; if (p.days.length < 400) p.days.push(l.e - l.s); }
      p.types[l.type] = (p.types[l.type] || 0) + 1;
      if (l.amt < 0) p.neg++;
      if (l.st !== 'void' && l.st !== 'draft') p.totals[l.ccy] = (p.totals[l.ccy] || 0) + l.amt;
      p.statuses[l.st] = (p.statuses[l.st] || 0) + 1;
    }
    return list.map(function (p) {
      return { key: p.key, n: p.n, periodShare: Math.round(100 * p.period / p.n), types: TYPES.filter(function (t) { return p.types[t]; }), typeCounts: p.types, len: lenOf(p.days, p.period, p.n), neg: p.neg, totals: p.totals };
    }).sort(function (a, b) { return totalAbs(b.totals) - totalAbs(a.totals) || b.n - a.n || (a.key < b.key ? -1 : 1); });
  }
  function totalAbs(t) { var s = 0; Object.keys(t).forEach(function (k) { s += Math.abs(t[k]) / unitOf(k); }); return s; }
  var LENS = ['none', 'short', 'month', 'quarter', 'half', 'year', 'multi', 'mixed'];
  var LEN_WORD = { none: 'no service period', short: 'periods under a month', month: 'monthly periods', quarter: 'quarterly periods', half: 'half-year periods', year: 'annual periods', multi: 'periods over a year', mixed: 'periods of mixed lengths' };
  function lenOf(days, withPeriod, n) {
    if (!withPeriod) return 'none';
    var b = { short: 0, month: 0, quarter: 0, half: 0, year: 0, multi: 0 };
    days.forEach(function (d) { b[d < 27 ? 'short' : d <= 32 ? 'month' : d <= 93 ? 'quarter' : d <= 186 ? 'half' : d <= 367 ? 'year' : 'multi']++; });
    var top = Object.keys(b).sort(function (x, y) { return b[y] - b[x]; })[0];
    if (b[top] < days.length * 0.7) return 'mixed';
    return top;
  }

  /* ================================================================== *
   * Recognition: the rules, and the day split
   * ================================================================== */

  var RULES = ['period', 'invoice', 'months', 'exclude'];
  var RULE_WORD = { period: 'Over the service period, by day', invoice: 'On the invoice date', months: 'Over N months from the invoice date', exclude: 'Exclude - not revenue' };
  function ruleText(r) {
    if (!r) return RULE_WORD.period;
    if (r.rule === 'months') return 'Over ' + plural(r.months, 'month') + ' from the invoice date, by day';
    return RULE_WORD[r.rule] || RULE_WORD.period;
  }
  /** The rules table as a lookup: product key -> {rule, months}. */
  function rulesMap(rules) {
    var m = {};
    (Array.isArray(rules) ? rules : []).forEach(function (x) {
      if (!x || typeof x.d !== 'string' || RULES.indexOf(x.r) < 0) return;
      var n = Math.floor(Number(x.n));
      m[x.d] = x.r === 'months' ? { rule: 'months', months: n >= 1 && n <= LIMITS.months ? n : 12 } : { rule: x.r };
    });
    return m;
  }
  function ruleOf(rmap, key) { return (rmap && rmap[key]) || { rule: 'period' }; }

  /**
   * Split `amount` (minor units, either sign) across the months of the days
   * [s, e) - e exclusive - by the days each month holds. Each month gets
   * the whole part of its share; the minor units left over go one each to
   * the months with the largest remainders (the earlier month on a tie), so
   * a line's months always add up to exactly its amount.
   */
  function splitDays(amount, s, e) {
    var D = e - s;
    if (!(D > 0)) return [[monthOfDay(s), amount]];
    var a = Math.abs(amount), sign = amount < 0 ? -1 : 1;
    var m0 = monthOfDay(s), m1 = monthOfDay(e - 1);
    var out = [], floors = 0;
    for (var mi = m0; mi <= m1; mi++) {
      var ms = Math.max(s, monthStart(mi)), me = Math.min(e, monthStart(mi + 1));
      var d = me - ms, num = a * d;
      var f = Math.floor(num / D), r = num - f * D;
      if (r < 0) { f--; r += D; } else if (r >= D) { f++; r -= D; }
      out.push({ m: mi, v: f, r: r });
      floors += f;
    }
    var left = a - floors;
    if (left > 0) {
      var idx = out.map(function (_, i) { return i; }).sort(function (x, y) { return out[y].r - out[x].r || x - y; });
      for (var k = 0; k < left; k++) out[idx[k % idx.length]].v++;
    }
    var res = [];
    for (var j = 0; j < out.length; j++) if (out[j].v || out.length === 1) res.push([out[j].m, sign * out[j].v]);
    if (!res.length) res.push([m0, 0]);
    return res;
  }

  /** How one line is recognised under its rule: {kind: 'pit' | 'time' |
   *  'excluded', s, e, parts: [[month, minor], ...]}. */
  function recognise(l, rule) {
    var r = rule || { rule: 'period' };
    if (r.rule === 'exclude') return { kind: 'excluded', s: null, e: null, parts: [] };
    if (r.rule === 'months') {
      var e = addMonths(l.bill, r.months || 12);
      return { kind: 'time', s: l.bill, e: e, parts: splitDays(l.amt, l.bill, e) };
    }
    if (r.rule === 'period' && l.s !== null && l.e > l.s) return { kind: 'time', s: l.s, e: l.e, parts: splitDays(l.amt, l.s, l.e) };
    return { kind: 'pit', s: l.bill, e: l.bill + 1, parts: [[monthOfDay(l.bill), l.amt]] };
  }
  function isRevenue(l) { return l.st === 'billed' || l.st === 'uncollectible'; }
  function partFor(parts, mi) { for (var i = 0; i < parts.length; i++) if (parts[i][0] === mi) return parts[i][1]; return 0; }
  function partsTo(parts, mi) { var s = 0; for (var i = 0; i < parts.length && parts[i][0] <= mi; i++) s += parts[i][1]; return s; }

  /* ================================================================== *
   * The schedule: per currency - recognised by month, the waterfall, the
   * deferred revenue roll-forward, the journal
   * ================================================================== */

  function zeros(n) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = 0; return a; }

  /**
   * Everything a month-end close needs, per currency (no conversion):
   *   months        the month keys from the first billing or recognition to the last
   *   billed[m]     revenue lines billed (invoice dated) in m
   *   rec[m]        recognised in m
   *   matrix[b][m]  billed in b, recognised in m - the waterfall
   *   roll          opening + billed - recognised = closing, per month;
   *                 closing split into billed ahead (deferred) and earned
   *                 ahead of billing (usage in arrears)
   *   pitBilled / timeBilled / timeRec / tax   for the journal
   * Void and draft invoices are left out; uncollectible ones stay in and are
   * listed; lines a rule excludes are listed; tax is never revenue.
   */
  function buildSchedule(lines, rmap) {
    var by = {}, lists = { void: {}, draft: {}, uncollectible: {}, excluded: {}, tax: {} };
    function bump(o, ccy, v) { var x = o[ccy] || (o[ccy] = { n: 0, cents: 0 }); x.n++; x.cents += v; }
    var recs = new Array(lines.length);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (l.st === 'void' || l.st === 'draft') { bump(lists[l.st], l.ccy, l.amt); continue; }
      var rule = ruleOf(rmap, l.prod), rec = recognise(l, rule);
      if (rec.kind === 'excluded') { bump(lists.excluded, l.ccy, l.amt); continue; }
      if (l.st === 'uncollectible') bump(lists.uncollectible, l.ccy, l.amt);
      if (l.tax) bump(lists.tax, l.ccy, l.tax);
      recs[i] = rec;
      var bm = monthOfDay(l.bill), lo = Math.min(bm, rec.parts[0][0]), hi = Math.max(bm, rec.parts[rec.parts.length - 1][0]);
      var c = by[l.ccy] || (by[l.ccy] = { ccy: l.ccy, m0: lo, m1: hi, lines: 0 });
      if (lo < c.m0) c.m0 = lo;
      if (hi > c.m1) c.m1 = hi;
      c.lines++;
    }
    Object.keys(by).forEach(function (k) {
      var c = by[k], n = c.m1 - c.m0 + 1;
      c.n = n;
      c.months = []; for (var m = 0; m < n; m++) c.months.push(monthKey(c.m0 + m));
      c.billed = zeros(n); c.rec = zeros(n); c.pitBilled = zeros(n); c.timeBilled = zeros(n); c.timeRec = zeros(n); c.tax = zeros(n);
      c.ahead = zeros(n); c.unbilled = zeros(n);
      c.matrix = []; for (var b = 0; b < n; b++) c.matrix.push(zeros(n));
      c.billRows = zeros(n);
    });
    for (var j = 0; j < lines.length; j++) {
      var rc = recs[j];
      if (!rc) continue;
      var L = lines[j], C = by[L.ccy], b0 = monthOfDay(L.bill) - C.m0;
      C.billed[b0] += L.amt;
      C.billRows[b0]++;
      C.tax[b0] += L.tax;
      if (rc.kind === 'pit') C.pitBilled[b0] += L.amt; else C.timeBilled[b0] += L.amt;
      var row = C.matrix[b0], parts = rc.parts;
      for (var p = 0; p < parts.length; p++) {
        var mo = parts[p][0] - C.m0;
        C.rec[mo] += parts[p][1];
        row[mo] += parts[p][1];
        if (rc.kind === 'time') C.timeRec[mo] += parts[p][1];
      }
      // The line's own balance month by month: billed so far less recognised
      // so far. Before its invoice month that is revenue earned ahead of
      // billing; from it on, billing ahead of revenue.
      var lo2 = Math.min(b0, parts[0][0] - C.m0), hi2 = Math.max(b0, parts[parts.length - 1][0] - C.m0), P = 0, pi = 0;
      for (var m2 = lo2; m2 <= hi2; m2++) {
        if (m2 === b0) P += L.amt;
        while (pi < parts.length && parts[pi][0] - C.m0 === m2) { P -= parts[pi][1]; pi++; }
        if (P) { if (m2 >= b0) C.ahead[m2] += P; else C.unbilled[m2] -= P; }
      }
    }
    var ok = true;
    Object.keys(by).forEach(function (k) {
      var c = by[k], open = 0, tb = 0, tr = 0;
      c.roll = [];
      for (var m = 0; m < c.n; m++) {
        var close = open + c.billed[m] - c.rec[m];
        tb += c.billed[m]; tr += c.rec[m];
        var row = { mi: c.m0 + m, key: c.months[m], opening: open, billed: c.billed[m], rec: c.rec[m], closing: close, ahead: c.ahead[m], unbilled: c.unbilled[m] };
        row.ok = close === c.ahead[m] - c.unbilled[m];
        if (!row.ok) ok = false;
        c.roll.push(row);
        open = close;
      }
      var cols = zeros(c.n), rows = zeros(c.n);
      for (var b = 0; b < c.n; b++) for (var m3 = 0; m3 < c.n; m3++) { rows[b] += c.matrix[b][m3]; cols[m3] += c.matrix[b][m3]; }
      c.rowTotals = rows; c.colTotals = cols;
      c.totals = { billed: tb, rec: tr, closing: open, lines: c.lines };
      c.checks = {
        rows: rows.every(function (v, i) { return v === c.billed[i]; }),
        cols: cols.every(function (v, i) { return v === c.rec[i]; }),
        grand: tb - tr === open,
        continuity: c.roll.every(function (r, i) { return i === 0 ? r.opening === 0 : r.opening === c.roll[i - 1].closing; }),
        split: c.roll.every(function (r) { return r.ok; }),
      };
      if (!c.checks.rows || !c.checks.cols || !c.checks.grand || !c.checks.continuity || !c.checks.split) ok = false;
    });
    var ccys = Object.keys(by).sort(function (a, b) { return by[b].lines - by[a].lines || (a < b ? -1 : 1); });
    return { currencies: ccys, by: by, lists: lists, ok: ok };
  }

  var DEFAULT_ACCOUNTS = { ar: 'Accounts receivable', deferred: 'Deferred revenue', revenue: 'Revenue', tax: 'Sales tax payable' };
  var ACCOUNT_KEYS = Object.keys(DEFAULT_ACCOUNTS);
  function accountsOf(a) {
    var out = {};
    ACCOUNT_KEYS.forEach(function (k) { var v = line(a && a[k], LIMITS.accountChars); out[k] = v || DEFAULT_ACCOUNTS[k]; });
    return out;
  }
  /**
   * The journal entries for one currency, month by month - two entries a
   * month, each balanced:
   *   Billing:     Dr Accounts receivable (revenue lines + their tax)
   *                Cr Revenue            (lines recognised on the invoice date)
   *                Cr Deferred revenue   (lines recognised over time)
   *                Cr Sales tax payable  (tax - never revenue)
   *   Recognition: Dr Deferred revenue / Cr Revenue (this month's share)
   * A negative total (more credited than billed) swaps sides.
   */
  function journal(c, accounts) {
    var A = accountsOf(accounts), out = [];
    function row(rows, account, v, debitSide) {
      if (!v) return;
      var dr = debitSide ? v : -v;
      rows.push(dr >= 0 ? { account: account, dr: dr, cr: 0 } : { account: account, dr: 0, cr: -dr });
    }
    for (var m = 0; m < c.n; m++) {
      var bill = [], recg = [];
      row(bill, A.ar, c.billed[m] + c.tax[m], true);
      row(bill, A.revenue, c.pitBilled[m], false);
      row(bill, A.deferred, c.timeBilled[m], false);
      row(bill, A.tax, c.tax[m], false);
      row(recg, A.deferred, c.timeRec[m], true);
      row(recg, A.revenue, c.timeRec[m], false);
      var entries = [];
      if (bill.length) entries.push({ name: 'Billing', rows: bill });
      if (recg.length) entries.push({ name: 'Recognition', rows: recg });
      if (!entries.length) continue;
      var dr = 0, cr = 0;
      entries.forEach(function (e) { e.rows.forEach(function (r) { dr += r.dr; cr += r.cr; }); });
      out.push({ mi: c.m0 + m, key: c.months[m], date: isoDay(monthEnd(c.m0 + m)), entries: entries, dr: dr, cr: cr, balanced: dr === cr });
    }
    return out;
  }

  /* ================================================================== *
   * Why the dashboard and the ledger disagree - buckets, to the cent
   * ================================================================== */

  var CATS = ['prepay', 'outside', 'proration', 'usage', 'credit', 'onetime'];
  var BUCKET_WORD = {
    prepay: 'Annual and multi-month prepayments', outside: 'Lines outside the month', proration: 'Prorations', usage: 'Usage billed in arrears',
    credit: 'Credits and refunds', onetime: 'Setup and one-time fees', excluded: 'Excluded by your rules', discount: 'Discounts', tax: 'Tax',
    void: 'Void invoices', uncollectible: 'Uncollectible invoices', fx: 'Other currencies', unbilled: 'Usage earned, not yet billed', residual: 'Not explained by the lines',
  };
  var KINDS = { billings: 'Billings for the month', mrr: 'MRR at month end' };
  /** Which bucket a line's difference belongs to. */
  function categoryOf(l, rec) {
    if (l.type === 'proration') return 'proration';
    if (l.type === 'credit' || l.amt < 0) return 'credit';
    if (l.type === 'usage') return 'usage';
    if (l.type === 'onetime') return 'onetime';
    if (rec.kind === 'time' && rec.e - rec.s > 31) return 'prepay';
    return 'outside';
  }
  /** MRR's monthly figure for a line: an annual plan is 1/12 a month, a
   *  quarter 1/3 - the period in whole months, at least one. */
  function monthsIn(days) { return Math.max(1, Math.round(days / 30.4375)); }
  function normOf(amt, days) { var n = monthsIn(days); return (amt < 0 ? -1 : 1) * Math.round(Math.abs(amt) / n); }
  function lenWord(days) { return days >= 360 && days <= 370 ? 'annual' : days >= 88 && days <= 93 ? 'quarterly' : days >= 180 && days <= 186 ? 'half-year' : days > 370 ? 'multi-year' : 'multi-month'; }

  function newAgg() {
    var t = {};
    CATS.forEach(function (k) { t[k] = { b: 0, m: 0, bn: 0, bAmt: 0, bRec: 0, on: 0, oRec: 0, ahead: 0, an: 0, lens: {} }; });
    return { R: 0, netBilled: 0, disc: 0, tax: 0, excl: 0, exclN: 0, exclMrr: 0, mrrNet: 0, mrrDisc: 0, mrrN: 0, unbilled: 0, unbilledN: 0, rN: 0,
      void: { amt: 0, disc: 0, tax: 0, n: 0 }, unc: { amt: 0, disc: 0, tax: 0, n: 0, rM: 0, rN: 0, mrr: 0, mrrDisc: 0 }, discN: 0, taxN: 0, billedN: 0, timing: t };
  }
  /** Every subset of `cands` ({key, cents}) whose sum is `target`: the
   *  smallest, the earliest on a tie. null when none ties. */
  function findSubset(cands, target) {
    var c = cands.filter(function (x) { return x.cents; }).slice(0, 14), best = null;
    for (var mask = 0; mask < (1 << c.length); mask++) {
      var sum = 0, size = 0;
      for (var i = 0; i < c.length; i++) if (mask & (1 << i)) { sum += c[i].cents; size++; }
      if (sum === target && (!best || size < best.size)) best = { mask: mask, size: size };
    }
    if (!best) return null;
    return c.filter(function (_, i) { return best.mask & (1 << i); }).map(function (x) { return x.key; });
  }
  function popTop(list, max) {
    return list.slice().sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v) || a.i - b.i; }).slice(0, max);
  }

  /**
   * Reconcile one month in one currency (the home currency H) against what
   * the person typed: the billing dashboard's figure (billings for the month
   * or MRR at month end), the ledger's revenue for the month and its
   * deferred revenue balance at month end. Other currencies come in only at
   * the rates typed for them.
   *
   * For each typed figure: Waterfall's own number, the gap, and the buckets
   * that make it up - each bucket a set of lines, each line in at most one
   * timing bucket - plus "not explained by the lines" so the buckets always
   * add up to the gap exactly. How the dashboard counts (tax, before
   * discounts, void invoices, uncollectible ones) is found by trying every
   * reading and keeping the smallest one that ties to the cent; the person
   * can set it by hand instead. For the ledger, the smallest set of known
   * differences that ties is found the same way.
   *
   * o = {month: 'YYYY-MM', ccy, dashboard: {kind, cents}, ledger: {revenue,
   *      deferred}, fx: {EUR: rateU}, reading: {tax, disc, void, uncoll} | null,
   *      ledgerPick: [keys] | null, deferredPick: [keys] | null}
   */
  function reconcile(lines, rmap, o) {
    var M = monthFromKey(o.month), H = o.ccy;
    if (M === null || !isCcy(H)) return null;
    var endDay = monthEnd(M), agg = {}, L = {};
    var covers = function (s, e) { return s !== null && s <= endDay && endDay < e; };
    function list(k) { return L[k] || (L[k] = []); }
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i], A = agg[l.ccy] || (agg[l.ccy] = newAgg()), home = l.ccy === H;
      var bm = monthOfDay(l.bill), inM = bm === M;
      if (l.st === 'void' || l.st === 'draft') {
        if (l.st === 'void' && inM) { A.void.amt += l.amt; A.void.disc += l.disc; A.void.tax += l.tax; A.void.n++; if (home) list('void').push({ i: i, v: l.amt }); }
        continue;
      }
      var rule = ruleOf(rmap, l.prod), rec = recognise(l, rule);
      if (rec.kind === 'excluded') {
        if (inM) { A.excl += l.amt; A.exclN++; if (home) list('excluded').push({ i: i, v: l.amt }); }
        if (l.type === 'subscription' && covers(l.s, l.e)) { var en = normOf(l.amt, l.e - l.s); A.exclMrr += en; if (home) list('excludedMrr').push({ i: i, v: en }); }
        continue;
      }
      var rM = partFor(rec.parts, M), cat = categoryOf(l, rec), T = A.timing[cat];
      A.R += rM;
      if (rM) A.rN++;
      var gB = (inM ? l.amt : 0) - rM;
      var inMrr = l.type === 'subscription' && rec.kind === 'time' && covers(rec.s, rec.e);
      var nNet = inMrr ? normOf(l.amt, rec.e - rec.s) : 0, nGross = inMrr ? normOf(l.amt + l.disc, rec.e - rec.s) : 0;
      var gM = nNet - rM;
      T.b += gB; T.m += gM;
      if (inM) { T.bn++; T.bAmt += l.amt; T.bRec += rM; var lw = rec.kind === 'time' ? lenWord(rec.e - rec.s) : 'other'; T.lens[lw] = (T.lens[lw] || 0) + 1; }
      else if (rM) { T.on++; T.oRec += rM; }
      if (inMrr) { A.mrrNet += nNet; A.mrrDisc += nGross - nNet; A.mrrN++; }
      if (inM) { A.netBilled += l.amt; A.billedN++; if (l.disc) { A.disc += l.disc; A.discN++; } if (l.tax) { A.tax += l.tax; A.taxN++; } }
      if (l.st === 'uncollectible') {
        if (inM) { A.unc.amt += l.amt; A.unc.disc += l.disc; A.unc.tax += l.tax; A.unc.n++; }
        if (rM) { A.unc.rM += rM; A.unc.rN++; }
        A.unc.mrr += nNet; A.unc.mrrDisc += nGross - nNet;
      }
      var pos = (bm <= M ? l.amt : 0) - partsTo(rec.parts, M);
      if (pos) { if (bm <= M) { T.ahead += pos; T.an++; } else { A.unbilled -= pos; A.unbilledN++; } }
      if (home) {
        if (gB) list('b:' + cat).push({ i: i, v: gB });
        if (gM) list('m:' + cat).push({ i: i, v: gM });
        if (inM && l.disc) list('discount').push({ i: i, v: l.disc });
        if (inMrr && nGross !== nNet) list('discountMrr').push({ i: i, v: nGross - nNet });
        if (inM && l.tax) list('tax').push({ i: i, v: l.tax });
        if (l.st === 'uncollectible') { if (inM) list('unc').push({ i: i, v: l.amt }); if (rM) list('uncR').push({ i: i, v: rM }); if (nNet) list('uncM').push({ i: i, v: nNet }); }
        if (pos) list(bm <= M ? 'ahead:' + cat : 'unbilled').push({ i: i, v: bm <= M ? pos : -pos });
      } else {
        if (inM) list('fxb:' + l.ccy).push({ i: i, v: l.amt });
        if (rM) list('fxr:' + l.ccy).push({ i: i, v: rM });
        if (pos) list('fxd:' + l.ccy).push({ i: i, v: bm <= M ? pos : -pos });
      }
    }
    var A0 = agg[H] || newAgg();
    var others = Object.keys(agg).filter(function (c) { return c !== H; }).sort();
    var rates = {};
    others.forEach(function (c) { var u = o.fx && o.fx[c]; if (typeof u === 'number' && u > 0 && u <= 1e9) rates[c] = u; });
    var closing = A0.unbilled ? -A0.unbilled : 0;
    CATS.forEach(function (k) { closing += A0.timing[k].ahead; });
    var ml = monthLong(M), mShort = MONTH_LONG[M % 12];
    function mo(v) { return money(v, H); }
    function linesOf(key, max) {
      var src = L[key] || [];
      return { n: src.length, lines: popTop(src, max || LIMITS.bucketLines).map(function (x) { return lineView(lines[x.i], x.v); }) };
    }
    function bucket(key, label, cents, src, sentence, kind) {
      var li = src ? linesOf(src) : { n: 0, lines: [] };
      return { key: key, label: label, cents: cents, n: li.n, lines: li.lines, sentence: sentence, kind: kind || 'timing' };
    }
    function ccyFigure(c, kind, T) {
      var a = agg[c];
      if (kind === 'mrr') return a.mrrNet + a.exclMrr + (T.disc ? a.mrrDisc : 0) - (T.uncoll ? a.unc.mrr + (T.disc ? a.unc.mrrDisc : 0) : 0);
      return a.netBilled + a.excl + (T.disc ? a.disc : 0) + (T.tax ? a.tax : 0) +
        (T.void ? a.void.amt + (T.disc ? a.void.disc : 0) + (T.tax ? a.void.tax : 0) : 0) -
        (T.uncoll ? a.unc.amt + (T.disc ? a.unc.disc : 0) + (T.tax ? a.unc.tax : 0) : 0);
    }
    var out = { month: monthKey(M), monthLabel: ml, ccy: H, others: others, rates: rates,
      ours: { revenue: A0.R, billed: A0.netBilled, mrr: A0.mrrNet, deferred: closing, unbilled: A0.unbilled, ahead: closing + A0.unbilled, revenueLines: A0.rN } };

    /* ---- the dashboard ---- */
    var dash = o.dashboard && typeof o.dashboard.cents === 'number' && isFinite(o.dashboard.cents) ? o.dashboard : null;
    if (dash) {
      var kind = dash.kind === 'mrr' ? 'mrr' : 'billings';
      var mkT = function (bits) { return { disc: Boolean(bits & 1), tax: kind === 'billings' && Boolean(bits & 2), void: kind === 'billings' && Boolean(bits & 4), uncoll: Boolean(bits & 8) }; };
      var modeled = function (T) {
        var v = A0.R, f = {};
        CATS.forEach(function (k) { v += kind === 'mrr' ? A0.timing[k].m : A0.timing[k].b; });
        v += kind === 'mrr' ? A0.exclMrr : A0.excl;
        if (T.disc) v += kind === 'mrr' ? A0.mrrDisc : A0.disc;
        if (T.tax) v += A0.tax;
        if (T.void) v += A0.void.amt + (T.disc ? A0.void.disc : 0) + (T.tax ? A0.void.tax : 0);
        if (T.uncoll) v -= kind === 'mrr' ? A0.unc.mrr + (T.disc ? A0.unc.mrrDisc : 0) : A0.unc.amt + (T.disc ? A0.unc.disc : 0) + (T.tax ? A0.unc.tax : 0);
        Object.keys(rates).forEach(function (c) { f[c] = convert(ccyFigure(c, kind, T), rates[c]); v += f[c]; });
        return { v: v, fx: f };
      };
      var T0, auto = false, tried = [];
      if (o.reading && typeof o.reading === 'object') T0 = { disc: Boolean(o.reading.disc), tax: kind === 'billings' && Boolean(o.reading.tax), void: kind === 'billings' && Boolean(o.reading.void), uncoll: Boolean(o.reading.uncoll) };
      else {
        var bestBits = null, bestSize = 99;
        for (var bits = 0; bits < 16; bits++) {
          if (kind === 'mrr' && (bits & 6)) continue;
          var T1 = mkT(bits), md = modeled(T1);
          var size = (T1.disc ? 1 : 0) + (T1.tax ? 1 : 0) + (T1.void ? 1 : 0) + (T1.uncoll ? 1 : 0);
          tried.push(md.v);
          if (md.v === dash.cents && size < bestSize) { bestBits = bits; bestSize = size; }
        }
        T0 = mkT(bestBits === null ? 0 : bestBits);
        auto = bestBits !== null;
      }
      var mod = modeled(T0), gap = dash.cents - A0.R, bs = [];
      var pre = kind === 'mrr' ? 'm:' : 'b:';
      CATS.forEach(function (k) {
        var t = A0.timing[k], v = kind === 'mrr' ? t.m : t.b;
        if (v || (L[pre + k] || []).length) bs.push(bucket(k, BUCKET_WORD[k], v, pre + k, kind === 'mrr' ? mrrSentence(k, t, v) : billSentence(k, t, v)));
      });
      var ex = kind === 'mrr' ? A0.exclMrr : A0.excl;
      if (ex) bs.push(bucket('excluded', BUCKET_WORD.excluded, ex, kind === 'mrr' ? 'excludedMrr' : 'excluded', mo(ex) + ' of lines your rules exclude from revenue ' + (kind === 'mrr' ? 'are subscriptions the dashboard counts in MRR.' : 'were billed in ' + ml + ' - the dashboard counts them.'), 'reading'));
      if (T0.disc) { var dv = kind === 'mrr' ? A0.mrrDisc : A0.disc; bs.push(bucket('discount', BUCKET_WORD.discount, dv, kind === 'mrr' ? 'discountMrr' : 'discount', 'Your dashboard shows amounts before discounts: ' + plural(A0.discN, 'discounted line') + ' billed in ' + ml + ' carry ' + mo(A0.disc) + ' of discounts' + (kind === 'mrr' ? ' (' + mo(dv) + ' a month in MRR)' : '') + '. Revenue here is after them.', 'reading')); }
      if (T0.tax) bs.push(bucket('tax', BUCKET_WORD.tax, A0.tax, 'tax', 'Your dashboard counts tax: ' + mo(A0.tax) + ' of tax on lines billed in ' + ml + '. Tax is never revenue.', 'reading'));
      if (T0.void) { var vv = A0.void.amt + (T0.disc ? A0.void.disc : 0) + (T0.tax ? A0.void.tax : 0); bs.push(bucket('void', BUCKET_WORD.void, vv, 'void', 'Your dashboard counts ' + plural(A0.void.n, 'line') + ' on void invoices dated ' + ml + ' (' + mo(vv) + '). A void invoice is not revenue.', 'reading')); }
      if (T0.uncoll) { var uv = kind === 'mrr' ? -(A0.unc.mrr + (T0.disc ? A0.unc.mrrDisc : 0)) : -(A0.unc.amt + (T0.disc ? A0.unc.disc : 0) + (T0.tax ? A0.unc.tax : 0)); bs.push(bucket('uncollectible', BUCKET_WORD.uncollectible, uv, kind === 'mrr' ? 'uncM' : 'unc', 'Your dashboard leaves out invoices marked uncollectible (' + mo(-uv) + '). Waterfall keeps them in revenue: a write-off is not less revenue - shown apart for your accountant.', 'reading')); }
      Object.keys(mod.fx).forEach(function (c) {
        var a = agg[c], fig = ccyFigure(c, kind, T0);
        bs.push(bucket('fx:' + c, BUCKET_WORD.fx + ' - ' + c, mod.fx[c], kind === 'mrr' ? 'fxr:' + c : 'fxb:' + c, money(fig, c) + ' of ' + c + ' ' + (kind === 'mrr' ? 'MRR' : 'billings in ' + ml) + ' at your dashboard’s rate of ' + rateText(rates[c]) + ' = ' + mo(mod.fx[c]) + '. Waterfall keeps ' + c + ' in its own schedule.', 'fx'));
      });
      var resid = dash.cents - mod.v;
      var unconverted = others.filter(function (c) { return !rates[c] && (kind === 'mrr' ? agg[c].mrrNet : agg[c].netBilled); });
      if (resid) bs.push({ key: 'residual', label: BUCKET_WORD.residual, cents: resid, n: 0, lines: [], kind: 'residual', sentence: mo(resid) + ' that these lines do not explain' + (unconverted.length ? ' - your file also has ' + unconverted.join(', ') + ' lines: type the rate your dashboard uses for them' : ' - a line missing from the export, a manual adjustment, or a different reading of the dashboard') + '.' });
      out.dashboard = finish({ kind: kind, kindLabel: KINDS[kind], typed: dash.cents, ours: A0.R, gap: gap, buckets: bs, residual: resid, ties: resid === 0, reading: T0, auto: auto, modeled: mod.v });
    }

    /* ---- the ledger's revenue for the month ---- */
    var lr = o.ledger && typeof o.ledger.revenue === 'number' && isFinite(o.ledger.revenue) ? o.ledger.revenue : null;
    if (lr !== null) {
      var cands = [];
      CATS.forEach(function (k) { var t = A0.timing[k]; if (t.b) cands.push({ key: 'when:' + k, cents: t.b, label: BUCKET_WORD[k] + ' booked when billed', src: 'b:' + k, sentence: whenSentence(k, t) }); });
      if (A0.excl) cands.push({ key: 'excluded', cents: A0.excl, label: 'Lines your rules exclude, booked as revenue', src: 'excluded', sentence: mo(A0.excl) + ' billed in ' + ml + ' on lines your rules exclude - the ledger books them as revenue.' });
      if (A0.unc.rM) cands.push({ key: 'uncollectible', cents: -A0.unc.rM, label: 'Uncollectible invoices taken off revenue', src: 'uncR', sentence: mo(A0.unc.rM) + ' of ' + ml + ' revenue here comes from invoices marked uncollectible; the ledger takes it off revenue. A write-off is not less revenue - shown apart for your accountant.' });
      if (A0.tax) cands.push({ key: 'tax', cents: A0.tax, label: 'Tax booked as revenue', src: 'tax', sentence: mo(A0.tax) + ' of tax on lines billed in ' + ml + ' - tax is never revenue.' });
      Object.keys(rates).forEach(function (c) { if (agg[c].R) cands.push({ key: 'fx:' + c, cents: convert(agg[c].R, rates[c]), label: BUCKET_WORD.fx + ' - ' + c, src: 'fxr:' + c, kind: 'fx', sentence: money(agg[c].R, c) + ' of ' + c + ' revenue in ' + ml + ' at ' + rateText(rates[c]) + ' = ' + mo(convert(agg[c].R, rates[c])) + '. Waterfall keeps ' + c + ' in its own schedule.' }); });
      out.ledgerRevenue = pick(cands, lr, A0.R, o.ledgerPick, 'revenue');
    }

    /* ---- the ledger's deferred revenue balance at month end ---- */
    var ld = o.ledger && typeof o.ledger.deferred === 'number' && isFinite(o.ledger.deferred) ? o.ledger.deferred : null;
    if (ld !== null) {
      var dc = [];
      CATS.forEach(function (k) { var t = A0.timing[k]; if (t.ahead) dc.push({ key: 'notdeferred:' + k, cents: -t.ahead, label: BUCKET_WORD[k] + ' not deferred in the ledger', src: 'ahead:' + k, sentence: 'Waterfall still defers ' + mo(t.ahead) + ' of ' + BUCKET_WORD[k].toLowerCase() + ' at ' + niceDay(endDay) + ' (' + plural(t.an, 'line') + '); the ledger does not.' }); });
      if (A0.unbilled) dc.push({ key: 'unbilled', cents: A0.unbilled, label: 'Usage earned, not yet billed, kept apart', src: 'unbilled', sentence: 'Waterfall nets ' + mo(A0.unbilled) + ' of revenue earned before it was billed (' + plural(A0.unbilledN, 'line') + ', usage in arrears) against deferred revenue; the ledger keeps it in its own account.' });
      Object.keys(rates).forEach(function (c) {
        var a = agg[c], net = -a.unbilled;
        CATS.forEach(function (k) { net += a.timing[k].ahead; });
        if (net) dc.push({ key: 'fx:' + c, cents: convert(net, rates[c]), label: BUCKET_WORD.fx + ' - ' + c, src: 'fxd:' + c, kind: 'fx', sentence: money(net, c) + ' of ' + c + ' deferred revenue at ' + rateText(rates[c]) + ' = ' + mo(convert(net, rates[c])) + '.' });
      });
      out.ledgerDeferred = pick(dc, ld, closing, o.deferredPick, 'deferred');
    }
    return out;

    function pick(cands, typed, ours, chosen, what) {
      var gap = typed - ours, keys, auto = false;
      if (Array.isArray(chosen)) keys = chosen.filter(function (k) { return cands.some(function (c) { return c.key === k; }); });
      else { keys = findSubset(cands, gap); auto = keys !== null; if (!keys) keys = []; }
      var bs = cands.filter(function (c) { return keys.indexOf(c.key) >= 0; }).map(function (c) { return bucket(c.key, c.label, c.cents, c.src, c.sentence, c.kind || 'reading'); });
      var sum = bs.reduce(function (s, b) { return s + b.cents; }, 0), resid = gap - sum;
      if (resid) bs.push({ key: 'residual', label: BUCKET_WORD.residual, cents: resid, n: 0, lines: [], kind: 'residual', sentence: mo(resid) + (what === 'revenue' ? ' of the revenue gap' : ' of the balance gap') + ' that these lines do not explain - a manual journal, an opening balance from before this export, or a line missing from it.' });
      return finish({ typed: typed, ours: ours, gap: gap, buckets: bs, residual: resid, ties: resid === 0, auto: auto, candidates: cands.map(function (c) { return { key: c.key, label: c.label, cents: c.cents, chosen: keys.indexOf(c.key) >= 0 }; }) });
    }
    function finish(x) {
      x.buckets.sort(function (a, b) { return (a.kind === 'residual') - (b.kind === 'residual') || Math.abs(b.cents) - Math.abs(a.cents) || (a.key < b.key ? -1 : 1); });
      var nonzero = x.buckets.filter(function (b) { return b.cents && b.kind !== 'residual'; });
      x.biggest = nonzero.length ? nonzero[0].key : null;
      x.sum = x.buckets.reduce(function (s, b) { return s + b.cents; }, 0);
      return x;
    }
    function lensPhrase(t, fallback) {
      var ks = Object.keys(t.lens);
      if (ks.length === 1 && ks[0] !== 'other') return ks[0] + ' ' + (t.bn === 1 ? 'plan' : 'plans');
      return fallback;
    }
    function billSentence(k, t, v) {
      var here = t.bn ? plural(t.bn, '') : '';
      var head = mo(v) + ' of the gap: ';
      switch (k) {
        case 'prepay': {
          var what = t.bn ? (t.bn + ' ' + lensPhrase(t, t.bn === 1 ? 'multi-month line' : 'multi-month lines')) : '';
          var annual = Object.keys(t.lens).length === 1 && t.lens.annual;
          return head + (t.bn ? what + ' billed in ' + ml + ' (' + mo(t.bAmt) + ') - only ' + (annual ? 'their ' + mShort + ' days, about 1/12 of each,' : 'the ' + mShort + ' days of each') + ' are ' + mShort + ' revenue (' + mo(t.bRec) + ')' : 'nothing multi-month was billed in ' + ml) +
            (t.on ? '; ' + plural(t.on, 'plan') + ' billed before ' + mShort + ' bring ' + mo(t.oRec) + ' of ' + mShort + ' revenue.' : '.');
        }
        case 'outside': return head + (t.bn ? plural(t.bn, 'line') + ' billed in ' + ml + ' (' + mo(t.bAmt) + ') run past the month end - ' + mo(t.bAmt - t.bRec) + ' of them is next month’s revenue' : 'nothing billed in ' + ml + ' runs past its end') + (t.on ? '; ' + plural(t.on, 'line') + ' billed the month before bring ' + mo(t.oRec) + ' of ' + mShort + ' revenue.' : '.');
        case 'proration': return head + (t.bn ? plural(t.bn, 'proration line') + ' from mid-cycle plan changes billed in ' + ml + ' (' + mo(t.bAmt) + '), ' + mo(t.bRec) + ' of it ' + mShort + ' revenue' : 'no prorations billed in ' + ml) + (t.on ? '; ' + plural(t.on, 'earlier proration') + ' bring ' + mo(t.oRec) + '.' : '.');
        case 'usage': return head + (t.bn ? plural(t.bn, 'usage line') + ' billed in ' + ml + ' (' + mo(t.bAmt) + ') are mostly for usage before ' + mShort + ' - earned when used, billed after (' + mo(t.bRec) + ' is ' + mShort + ' usage)' : 'no usage billed in ' + ml) + (t.on ? '; ' + plural(t.on, 'usage line') + ' for ' + mShort + ' usage are billed after it (' + mo(t.oRec) + ').' : '. Usage for ' + mShort + ' billed after the export is not in the file.');
        case 'credit': return head + (t.bn ? plural(t.bn, 'credit') + ' in ' + ml + ' (' + mo(t.bAmt) + '), ' + mo(t.bRec) + ' of it against ' + mShort + ' revenue' : 'no credits in ' + ml) + (t.on ? '; ' + plural(t.on, 'earlier credit') + ' still reduce ' + mShort + ' by ' + mo(-t.oRec) + '.' : '.');
        case 'onetime': return head + (t.bn ? plural(t.bn, 'setup or one-time fee') + ' billed in ' + ml + ' (' + mo(t.bAmt) + '), ' + mo(t.bRec) + ' of it ' + mShort + ' revenue under your rules' : 'no one-time fees billed in ' + ml) + (t.on ? '; ' + plural(t.on, 'fee') + ' billed earlier bring ' + mo(t.oRec) + '.' : '.');
        default: return head + here;
      }
    }
    function mrrSentence(k, t, v) {
      var head = mo(v) + ' of the gap: ';
      switch (k) {
        case 'prepay': return head + 'MRR counts each annual or multi-month plan as its share of a month (1/12 of a year); revenue counts its days in ' + ml + '.';
        case 'outside': return head + 'monthly plans that started, ended or renewed mid-month - MRR counts a full month at month end, revenue counts the days.';
        case 'proration': return head + 'prorations are not in MRR (' + mo(t.bRec + t.oRec) + ' of ' + mShort + ' revenue).';
        case 'usage': return head + 'usage is not in MRR (' + mo(t.bRec + t.oRec) + ' of ' + mShort + ' revenue).';
        case 'credit': return head + 'credits are not in MRR (' + mo(t.bRec + t.oRec) + ' of ' + mShort + ' revenue).';
        case 'onetime': return head + 'setup and one-time fees are not in MRR (' + mo(t.bRec + t.oRec) + ' of ' + mShort + ' revenue).';
        default: return head;
      }
    }
    function whenSentence(k, t) {
      return cap1(BUCKET_WORD[k].toLowerCase()) + ' booked when billed, not over time: ' + plural(t.bn, 'line') + ' billed in ' + ml + ' (' + mo(t.bAmt) + ') less the ' + mo(t.bRec + t.oRec) + ' that is ' + mShort + ' revenue under your rules = ' + mo(t.b) + '.';
    }
  }

  /* ================================================================== *
   * Lines on the page, customers and the drill-down
   * ================================================================== */

  function maskName(ci) { return 'Customer ' + pad(ci + 1, 4); }
  /** A line as the page and the bucket lists draw it (v: its part in a bucket). */
  function lineView(l, v) {
    return {
      r: l.r, inv: l.inv, lid: l.lid, cust: l.cust, ci: l.ci, ccy: l.ccy, amt: l.amt, disc: l.disc, tax: l.tax,
      bill: niceDay(l.bill), start: l.s !== null ? niceDay(l.s) : '', last: l.s !== null ? niceDay(l.e - 1) : '', days: l.s !== null ? l.e - l.s : 0,
      desc: l.desc, prod: l.prod, type: l.type, st: l.st, v: v === undefined ? null : v,
    };
  }
  /** Customers by what they were billed (net, per currency), filtered by a
   *  search; the list shows the first 200. */
  function customersList(lines, customers, opts) {
    var q = line(opts && opts.q, 60).toLowerCase(), by = {};
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i], c = by[l.ci] || (by[l.ci] = { ci: l.ci, name: customers[l.ci].name, id: customers[l.ci].id, n: 0, billed: {}, abs: 0 });
      c.n++;
      if (isRevenue(l)) { c.billed[l.ccy] = (c.billed[l.ccy] || 0) + l.amt; c.abs += Math.abs(l.amt) / unitOf(l.ccy); }
    }
    var all = Object.keys(by).map(function (k) { return by[k]; });
    var hit = q ? all.filter(function (c) { return c.name.toLowerCase().indexOf(q) >= 0 || (c.id && c.id.toLowerCase().indexOf(q) >= 0); }) : all;
    hit.sort(function (a, b) { return b.abs - a.abs || a.ci - b.ci; });
    return { total: all.length, matched: hit.length, shown: hit.slice(0, LIMITS.customersShown).map(function (c) { return { ci: c.ci, name: c.name, id: c.id, n: c.n, billed: c.billed }; }) };
  }
  /** One customer: their lines (with the rule each follows and how it
   *  splits), their schedule by month and their deferred balance at every
   *  month end - per currency. */
  function customerDetail(lines, customers, rmap, ci) {
    var mine = lines.filter(function (l) { return l.ci === ci; });
    if (!customers[ci] || !mine.length) return null;
    var sched = buildSchedule(mine, rmap);
    var views = mine.slice(0, LIMITS.lineList).map(function (l) {
      var rule = ruleOf(rmap, l.prod), rec = (l.st === 'void' || l.st === 'draft') ? null : recognise(l, rule);
      var v = lineView(l);
      v.rule = l.st === 'void' ? 'Void - left out' : l.st === 'draft' ? 'Draft - left out' : ruleText(rule);
      v.parts = rec ? rec.parts.map(function (p) { return [monthKey(p[0]), p[1]]; }) : [];
      return v;
    });
    var by = {};
    sched.currencies.forEach(function (k) {
      var c = sched.by[k];
      by[k] = { months: c.months, billed: c.billed, rec: c.rec, closing: c.roll.map(function (r) { return r.closing; }), totals: c.totals };
    });
    return { ci: ci, name: customers[ci].name, id: customers[ci].id, n: mine.length, lines: views, by: by, currencies: sched.currencies };
  }

  /* ================================================================== *
   * Exports: formula-safe CSV, masked names, escaped Markdown
   * ================================================================== */

  /** A spreadsheet cell: a plain number stays a number; text that starts
   *  like a formula (= + - @, a tab or a CR) gets a leading ' so no
   *  spreadsheet runs it. */
  function csvCell(v) {
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    var s = str(v).replace(BAD, '');
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows) { return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n'; }
  // Markdown's own marks are escaped, brackets too, so no link can be made.
  // Parentheses stay plain: without a bracket before them they mean nothing.
  function md(s) { return str(s).replace(BAD, '').replace(/([\\`*_{}[\]#|<>~])/g, '\\$1').replace(/\r?\n/g, ' '); }
  function custOut(l, mask) { return mask ? maskName(l.ci) : l.cust; }

  /** Every revenue line with its rule and its share of every month - the
   *  deferred revenue schedule a spreadsheet would hold. */
  function scheduleCsv(lines, rmap, opts) {
    var mask = Boolean(opts && opts.mask), rows = [], lo = Infinity, hi = -Infinity, recs = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!isRevenue(l)) continue;
      var rule = ruleOf(rmap, l.prod), rec = recognise(l, rule);
      if (rec.kind === 'excluded') continue;
      recs.push([l, rule, rec]);
      if (rec.parts[0][0] < lo) lo = rec.parts[0][0];
      if (rec.parts[rec.parts.length - 1][0] > hi) hi = rec.parts[rec.parts.length - 1][0];
    }
    var months = [];
    for (var m = lo; m <= hi; m++) months.push(m);
    rows.push(['currency', 'invoice', 'line', 'customer', 'description', 'product', 'type', 'status', 'invoice_date', 'service_start', 'service_last_day', 'amount', 'rule'].concat(months.map(monthKey)));
    recs.forEach(function (x) {
      var l = x[0], rec = x[2], cells = months.map(function () { return ''; });
      rec.parts.forEach(function (p) { cells[p[0] - lo] = plain(p[1], l.ccy); });
      rows.push([l.ccy, l.inv, l.lid, custOut(l, mask), l.desc, l.prod, TYPE_WORD[l.type], STATUS_WORD[l.st], isoDay(l.bill), l.s !== null ? isoDay(l.s) : '', l.s !== null ? isoDay(l.e - 1) : '', plain(l.amt, l.ccy), ruleText(x[1])].concat(cells));
    });
    return toCsv(rows);
  }
  function waterfallCsv(c) {
    var rows = [['billed_in'].concat(c.months, ['total_billed'])];
    for (var b = 0; b < c.n; b++) {
      if (!c.billRows[b] && !c.billed[b]) continue;
      rows.push([c.months[b]].concat(c.matrix[b].map(function (v) { return v ? plain(v, c.ccy) : ''; }), [plain(c.rowTotals[b], c.ccy)]));
    }
    rows.push(['total_recognised'].concat(c.colTotals.map(function (v) { return plain(v, c.ccy); }), [plain(c.totals.billed, c.ccy)]));
    return toCsv(rows);
  }
  function rollCsv(c) {
    var rows = [['month', 'currency', 'opening_deferred', 'billed', 'recognised', 'closing_deferred', 'billed_ahead', 'earned_ahead_of_billing']];
    c.roll.forEach(function (r) { rows.push([r.key, c.ccy, plain(r.opening, c.ccy), plain(r.billed, c.ccy), plain(r.rec, c.ccy), plain(r.closing, c.ccy), plain(r.ahead, c.ccy), plain(r.unbilled, c.ccy)]); });
    return toCsv(rows);
  }
  /** A generic journal: one row per account per entry, debits and credits
   *  in their own columns, the account names the person chose. */
  function journalCsv(sched, accounts, opts) {
    var only = opts && typeof opts.mi === 'number' ? opts.mi : null;
    var rows = [['date', 'journal', 'currency', 'account', 'debit', 'credit', 'memo']];
    sched.currencies.forEach(function (k) {
      var c = sched.by[k];
      journal(c, accounts).forEach(function (j) {
        if (only !== null && j.mi !== only) return;
        j.entries.forEach(function (e) {
          var id = 'WF-' + j.key.replace('-', '') + '-' + k + '-' + (e.name === 'Billing' ? 'B' : 'R');
          e.rows.forEach(function (r) { rows.push([j.date, id, k, r.account, r.dr ? plain(r.dr, k) : '', r.cr ? plain(r.cr, k) : '', 'Waterfall: ' + e.name.toLowerCase() + ', ' + monthLabel(j.mi)]); });
        });
      });
    });
    return toCsv(rows);
  }

  /** The one-page close memo for a month, in Markdown: totals, the
   *  roll-forward, the reconciliation buckets, the rules used, what was
   *  left out and listed apart. Every name from the file is escaped. */
  function closeMemo(sched, o) {
    var mi = o.mi, ml = monthLong(mi), out = [];
    out.push('# Close memo - ' + ml);
    out.push('');
    out.push('From ' + md(o.file || 'a billing export') + ' (' + plural(o.lines || 0, 'line') + '), prepared with Waterfall. ' + NOT_POLICY + ' ' + NO_FX);
    sched.currencies.forEach(function (k) {
      var c = sched.by[k], i = mi - c.m0;
      if (i < 0 || i >= c.n) return;
      var r = c.roll[i];
      out.push('', '## ' + k, '', '| ' + md(ml) + ' | ' + k + ' |', '|---|---:|');
      out.push('| Billed | ' + money(c.billed[i], k) + ' |', '| Recognised | ' + money(c.rec[i], k) + ' |', '| Deferred revenue at ' + md(niceDay(monthEnd(mi))) + ' | ' + money(r.closing, k) + ' |');
      if (r.unbilled) out.push('| ... billed ahead of revenue | ' + money(r.ahead, k) + ' |', '| ... less revenue earned before it was billed (usage in arrears) | ' + money(-r.unbilled, k) + ' |');
      out.push('', '### Deferred revenue roll-forward', '', '| Month | Opening | Billed | Recognised | Closing |', '|---|---:|---:|---:|---:|');
      for (var j = Math.max(0, i - 11); j <= i; j++) { var x = c.roll[j]; out.push('| ' + monthLabel(x.mi) + ' | ' + money(x.opening, k) + ' | ' + money(x.billed, k) + ' | ' + money(x.rec, k) + ' | ' + money(x.closing, k) + ' |'); }
      out.push('', (c.checks.continuity && c.checks.grand ? 'Checked: each month’s closing is the next month’s opening, and everything billed less everything recognised is the closing balance (' + money(c.totals.billed, k) + ' - ' + money(c.totals.rec, k) + ' = ' + money(c.totals.closing, k) + ' at ' + monthLabel(c.m1) + ').' : 'The roll-forward did not check - see the schedule.'));
    });
    var rc = o.recon;
    if (rc && (rc.dashboard || rc.ledgerRevenue || rc.ledgerDeferred)) {
      out.push('', '## Why the dashboard and the ledger disagree - ' + rc.ccy);
      [['dashboard', 'Billing dashboard (' + (rc.dashboard ? rc.dashboard.kindLabel.toLowerCase() : '') + ')', 'Waterfall’s recognised revenue'], ['ledgerRevenue', 'Ledger revenue', 'Waterfall’s recognised revenue'], ['ledgerDeferred', 'Ledger deferred revenue at month end', 'Waterfall’s deferred revenue']].forEach(function (p) {
        var x = rc[p[0]];
        if (!x) return;
        out.push('', '### ' + p[1], '', p[1] + ': ' + money(x.typed, rc.ccy) + '. ' + p[2] + ': ' + money(x.ours, rc.ccy) + '. Gap: ' + money(x.gap, rc.ccy) + (x.ties ? ' - explained to the cent.' : '.'), '', '| Bucket | Amount | Lines |', '|---|---:|---:|');
        x.buckets.forEach(function (b) { out.push('| ' + md(b.label) + ' | ' + money(b.cents, rc.ccy) + ' | ' + (b.n || '') + ' |'); });
        out.push('| **Total** | **' + money(x.sum, rc.ccy) + '** | |');
        x.buckets.forEach(function (b) { if (b.cents) out.push('', '- ' + md(b.sentence)); });
      });
    }
    out.push('', '## Rules used', '', '| Product | Rule | Lines |', '|---|---|---:|');
    (o.products || []).forEach(function (p) { out.push('| ' + md(p.key) + ' | ' + md(ruleText(ruleOf(o.rmap, p.key))) + ' | ' + p.n + ' |'); });
    var L = sched.lists, lst = [];
    function each(o2, word) { Object.keys(o2).forEach(function (k) { lst.push('- ' + word + ' (' + k + '): ' + plural(o2[k].n, 'line') + ', ' + money(o2[k].cents, k)); }); }
    each(L.void, 'Void invoices - not revenue');
    each(L.draft, 'Draft invoices - not issued, left out');
    each(L.uncollectible, 'Uncollectible - kept in revenue; a write-off is not less revenue, shown apart for your accountant');
    each(L.excluded, 'Excluded by your rules');
    each(L.tax, 'Tax - never revenue');
    if (o.leftOut) lst.push('- Rows Waterfall could not read: ' + plural(o.leftOut, 'row') + ', left out and listed on the rules page');
    if (lst.length) out.push('', '## Left out and listed apart', '');
    lst.forEach(function (x) { out.push(x); });
    out.push('', '_' + md(NOT_POLICY) + '_', '');
    return out.join('\n');
  }

  /* ================================================================== *
   * Settings: presets, the rules table, account names - never a customer
   * ================================================================== */

  var DEFAULT_SETTINGS = { version: 1, presets: [], rules: [], accounts: DEFAULT_ACCOUNTS, periodEnd: '', mask: true, updatedAt: 0 };
  var SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
  function defaults() { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
  var PERSONAL = /@|\d{9,}/;
  function onlyKeys(o, keys) { return o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(function (k) { return keys.indexOf(k) >= 0; }); }
  function textOk(s, max) { return typeof s === 'string' && s.length >= 1 && s.length <= max && !BAD1.test(s) && !/[<>]/.test(s) && !PERSONAL.test(s); }

  /** Settings, rebuilt field by field. strict: anything unknown or
   *  customer-shaped is an error (the server refuses the whole body);
   *  otherwise it is dropped. */
  function cleanSettings(raw, strict) {
    var s = defaults(), errors = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { settings: s, errors: ['Send the settings.'] };
    Object.keys(raw).forEach(function (k) { if (SETTINGS_KEYS.indexOf(k) < 0) errors.push('Unknown setting: ' + line(k, 30) + '.'); });
    if (raw.presets !== undefined) {
      if (!Array.isArray(raw.presets)) errors.push('Presets must be a list.');
      else {
        if (raw.presets.length > LIMITS.presets) errors.push('At most ' + LIMITS.presets + ' presets.');
        raw.presets.slice(0, LIMITS.presets).forEach(function (p) {
          if (!onlyKeys(p, ['name', 'map']) || !textOk(p.name, 40) || !p.map || typeof p.map !== 'object' || Array.isArray(p.map)) { errors.push('A preset is a name and header names.'); return; }
          var map = {}, bad = false;
          Object.keys(p.map).forEach(function (k) { if (FKEYS.indexOf(k) < 0 || !headerOk(p.map[k])) bad = true; else map[k] = p.map[k]; });
          if (bad) { errors.push('A preset holds header names only - one looked like a value.'); return; }
          if (!Object.keys(map).length) return;
          s.presets.push({ name: line(p.name, 40), map: map });
        });
      }
    }
    if (raw.rules !== undefined) {
      if (!Array.isArray(raw.rules)) errors.push('Rules must be a list.');
      else {
        if (raw.rules.length > LIMITS.rules) errors.push('At most ' + LIMITS.rules + ' rules.');
        var seen = {};
        raw.rules.slice(0, LIMITS.rules).forEach(function (x) {
          if (!onlyKeys(x, ['d', 'r', 'n']) || !textOk(x.d, LIMITS.descChars) || RULES.indexOf(x.r) < 0) { errors.push('A rule is a product description and one of the rules.'); return; }
          var n = x.n;
          if (x.r === 'months' && !(Number.isInteger(n) && n >= 1 && n <= LIMITS.months)) { errors.push('“Over N months” needs N from 1 to 60.'); return; }
          if (x.r !== 'months' && n !== undefined) { errors.push('Only “over N months” takes a number.'); return; }
          if (seen[x.d]) return;
          seen[x.d] = 1;
          s.rules.push(x.r === 'months' ? { d: x.d, r: 'months', n: n } : { d: x.d, r: x.r });
        });
      }
    }
    if (raw.accounts !== undefined) {
      if (!onlyKeys(raw.accounts, ACCOUNT_KEYS)) errors.push('Account names: receivable, deferred, revenue and tax only.');
      else ACCOUNT_KEYS.forEach(function (k) {
        var v = raw.accounts[k];
        if (v === undefined) return;
        if (!textOk(v, LIMITS.accountChars)) { errors.push('An account name is up to 60 characters of plain text.'); return; }
        s.accounts[k] = line(v, LIMITS.accountChars);
      });
    }
    if (raw.periodEnd !== undefined) { if (['', 'exclusive', 'inclusive'].indexOf(raw.periodEnd) < 0) errors.push('Period end is exclusive or inclusive.'); else s.periodEnd = raw.periodEnd; }
    if (raw.mask !== undefined) { if (typeof raw.mask !== 'boolean') errors.push('Masking is on or off.'); else s.mask = raw.mask; }
    if (raw.version !== undefined && raw.version !== 1) errors.push('Unknown settings version.');
    if (!strict && typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt)) s.updatedAt = raw.updatedAt;
    else if (strict && raw.updatedAt !== undefined) errors.push('Unknown setting: updatedAt.');
    return { settings: s, errors: strict ? errors : [] };
  }
  /** This device's settings and the account's: the account's choices, plus
   *  every rule and preset only this device has. */
  function mergeSettings(local, account) {
    var a = cleanSettings(account).settings, l = cleanSettings(local).settings;
    var have = {};
    a.rules.forEach(function (r) { have[r.d] = 1; });
    l.rules.forEach(function (r) { if (!have[r.d] && a.rules.length < LIMITS.rules) a.rules.push(r); });
    var names = {};
    a.presets.forEach(function (p) { names[p.name.toLowerCase()] = 1; });
    l.presets.forEach(function (p) { if (!names[p.name.toLowerCase()] && a.presets.length < LIMITS.presets) a.presets.push(p); });
    return a;
  }

  /* ================================================================== *
   * The AI: "Suggest rules for my products"
   *
   * Sent: up to 200 product descriptions, each cut to 120 characters, with
   * shapes worked out on this device - the share of its lines that have a
   * service period, the line types seen, and the usual period length. Never
   * a customer, an invoice id, an amount or a date: a description that names
   * a customer from the file is held back, and amounts, dates and ids are
   * taken out of the rest before the person sees exactly what is sent.
   * ================================================================== */

  var AI_RULES = ['period', 'invoice', 'months', 'exclude', 'unsure'];
  var MONEYISH = /[$€£¥₹]\s?\d|\d[\d,]*[.,]\d{2}\b|\b\d+(?:[.,]\d+)?\s?(?:usd|eur|gbp|cad|aud|jpy)\b/i;
  var DATEISH = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;
  var IDISH = /\b[a-z]{2,6}_[A-Za-z0-9]{6,}\b|\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{12,}\b/;
  function aiLabel(key) {
    var s = line(key, 300).replace(/[<>]/g, ' ')
      .replace(/\S+@\S+/g, ' ')
      .replace(new RegExp(MONEYISH.source, 'gi'), ' ')
      .replace(DATE_TOKENS, ' ')
      .replace(new RegExp(DATEISH.source, 'g'), ' ')
      .replace(new RegExp(IDISH.source, 'g'), ' ')
      .replace(/\d{5,}/g, ' ')
      .replace(/\(\s*\)/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return clip(s, LIMITS.aiChars).replace(/…$/, '').trim();
  }
  /** What "Suggest rules" would send, built from the rules table; and what
   *  was held back (a description naming a customer, an invoice or a
   *  customer id from the file). */
  function aiPayload(products, people) {
    var names = (people || []).map(function (p) { return str(p).toLowerCase(); }).filter(function (p) { return p.length >= 3 && p !== '(no customer)'; });
    var out = [], held = [], seen = {};
    for (var i = 0; i < products.length; i++) {
      var p = products[i], d = aiLabel(p.key), low = d.toLowerCase(), raw = str(p.key).toLowerCase();
      if (!d || d === '(no description)') continue;
      if (names.some(function (n) { return low.indexOf(n) >= 0 || raw.indexOf(n) >= 0; })) { held.push(p.key); continue; }
      if (seen[d]) continue;
      seen[d] = 1;
      if (out.length >= LIMITS.aiProducts) { held.push(p.key); continue; }
      out.push({ d: d, period: Math.max(0, Math.min(100, Math.round(p.periodShare))), types: p.types.slice(0, 5), len: LENS.indexOf(p.len) >= 0 ? p.len : 'mixed', key: p.key });
    }
    return { products: out.map(function (x) { return { d: x.d, period: x.period, types: x.types, len: x.len }; }), keys: out.map(function (x) { return x.key; }), held: held.length, heldKeys: held.slice(0, 50) };
  }
  /** The request body, rebuilt field by field on the server. Anything else -
   *  an unknown field, an @, nine digits in a row, an amount, a date, an
   *  id-shaped token, markup - is a 400 before any model call. */
  function rulesRequest(body) {
    var fail = function (msg, code) { return { error: msg, code: code || 'shape' }; };
    if (!onlyKeys(body, ['products']) || !Array.isArray(body.products)) return fail('Send the product descriptions and nothing else.');
    var raw = JSON.stringify(body);
    if (PERSONAL.test(raw)) return fail('That looks like customer data (an @ or nine digits in a row) - nothing was sent.', 'personal');
    if (!body.products.length || body.products.length > LIMITS.aiProducts) return fail('Send 1 to ' + LIMITS.aiProducts + ' product descriptions.');
    var seen = {}, out = [];
    for (var i = 0; i < body.products.length; i++) {
      var p = body.products[i];
      if (!onlyKeys(p, ['d', 'period', 'types', 'len'])) return fail('Each product is a description, a period share, its line types and its period length.');
      if (typeof p.d !== 'string' || !p.d || p.d.length > LIMITS.aiChars || line(p.d, LIMITS.aiChars + 5) !== p.d || /[<>{}`]/.test(p.d)) return fail('A description is 1 to 120 characters of plain text.');
      if (MONEYISH.test(p.d)) return fail('A description carries an amount - nothing was sent.', 'amount');
      if (DATEISH.test(p.d) || new RegExp(DATE_TOKENS.source, 'i').test(p.d)) return fail('A description carries a date - nothing was sent.', 'date');
      if (IDISH.test(p.d)) return fail('A description carries an id - nothing was sent.', 'id');
      if (!Number.isInteger(p.period) || p.period < 0 || p.period > 100) return fail('A period share is a whole number from 0 to 100.');
      if (!Array.isArray(p.types) || p.types.length > TYPES.length || p.types.some(function (t) { return TYPES.indexOf(t) < 0; }) || new Set(p.types).size !== p.types.length) return fail('Line types come from the fixed list.');
      if (LENS.indexOf(p.len) < 0) return fail('A period length comes from the fixed list.');
      if (seen[p.d]) return fail('A description is sent once.');
      seen[p.d] = 1;
      out.push({ d: p.d, period: p.period, types: p.types.slice(), len: p.len });
    }
    return { req: { products: out } };
  }
  /** The model's answer, checked: only the products sent (by number), each
   *  once, only the fixed rules, N from 1 to 60, a short plain reason with
   *  no links or markup. */
  function cleanAiRules(raw, req) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.suggestions)) return { error: 'The suggestions did not come back in the expected shape.', code: 'shape' };
    var count = req.products.length, seen = {}, out = [], dropped = Math.max(0, raw.suggestions.length - 1000);
    raw.suggestions.slice(0, 1000).forEach(function (x) {
      if (!x || typeof x !== 'object') { dropped++; return; }
      var n = x.n;
      if (!Number.isInteger(n) || n < 1 || n > count || seen[n]) { dropped++; return; }
      if (AI_RULES.indexOf(x.rule) < 0) { dropped++; return; }
      var months = null;
      if (x.rule === 'months') { if (!(Number.isInteger(x.months) && x.months >= 1 && x.months <= LIMITS.months)) { dropped++; return; } months = x.months; }
      var reason = line(noMarkup(str(x.reason)), 400)
        .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
        .replace(/\S+@\S+/g, '')
        .replace(/\b[a-z0-9-]+\.(?:com|net|org|io|ai|dev|co|app|example)\b\S*/gi, '')
        .replace(/[{}`]/g, '').replace(/\s+/g, ' ').trim();
      seen[n] = 1;
      out.push({ n: n, d: req.products[n - 1].d, rule: x.rule, months: months, reason: clip(reason, LIMITS.reasonChars) });
    });
    if (!out.length) return { error: 'The suggestions came back empty. Choose the rules by hand - the table is free.', code: 'empty' };
    out.sort(function (a, b) { return a.n - b.n; });
    return { suggestions: out, dropped: dropped };
  }

  /* ================================================================== *
   * The engine the worker (or the page) drives. It holds the file and its
   * lines in memory - in the worker, that is the only place they ever are -
   * and answers with summaries the page draws. Nothing here is kept after
   * the page closes.
   * ================================================================== */

  function sampleRows(table) { return table.rows.slice(0, LIMITS.sample); }
  function cleanMap(map) {
    var out = {};
    FKEYS.forEach(function (k) { var v = map && map[k]; out[k] = Number.isInteger(v) && v >= 0 && v < LIMITS.columns ? v : null; });
    return out;
  }
  function cleanAnswers(a) {
    a = a || {};
    return {
      order: a.order === 'dmy' ? 'dmy' : 'mdy', units: a.units === 'minor' ? 'minor' : 'major',
      periodEnd: a.periodEnd === 'inclusive' ? 'inclusive' : 'exclusive', discount: a.discount === 'after' ? 'after' : 'before',
      tax: a.tax === 'included' ? 'included' : 'excluded', currency: isCcy(a.currency) ? a.currency : 'USD',
    };
  }

  function createEngine() {
    var st = null;
    function need() { if (!st || !st.table) throw new Error('Load a billing export first.'); return st; }
    function needLines() { need(); if (!st.built) throw new Error('Confirm the columns first.'); return st; }
    return {
      /** Read a file: headers, a sample, the guess, the questions. */
      load: function (x) {
        var t = parseTable(str(x.text));
        if (t.empty || !t.rows.length) throw new Error('That file has no rows Waterfall can read. It needs a header row and one line per invoice line.');
        if (t.headers.length < 2) throw new Error('That file has one column. Waterfall reads CSV or TSV with a column for each field.');
        var g = guessColumns(t.headers, t.rows);
        var preset = x.presets ? applyPreset(t.headers, x.presets) : null;
        var map = preset ? preset.map : g.map;
        st = { table: t, name: line(x.name, 120) || 'billing export', demo: Boolean(x.demo), map: map, built: null, products: null };
        return {
          name: st.name, demo: st.demo, headers: t.headers, sample: sampleRows(t), total: t.total, kept: t.kept, truncated: t.truncated, ragged: t.ragged,
          invisible: t.invisible, cut: t.cut, wide: t.wide, delimiterName: t.delimiterName, header: t.header, preamble: t.preamble, openQuote: t.openQuote,
          guess: g.map, conf: g.conf, map: map, preset: preset ? preset.name : '', questions: questions(t, map, {}), problems: mappingProblems(map),
        };
      },
      questions: function (x) { var s = need(); var map = cleanMap(x.map); return { questions: questions(s.table, map, x.answers || {}), problems: mappingProblems(map) }; },
      /** Read every line with the confirmed columns and answers. */
      prepare: function (x) {
        var s = need(), map = cleanMap(x.map), probs = mappingProblems(map);
        if (probs.length) throw new Error(probs[0]);
        var ans = cleanAnswers(x.answers);
        var b = buildLines(s.table, map, ans);
        s.map = map; s.answers = ans; s.built = b; s.products = productsOf(b.lines);
        var counts = { lines: b.lines.length, customers: b.customers.length, status: {}, types: {}, ccy: {} };
        var lo = Infinity, hi = -Infinity;
        b.lines.forEach(function (l) {
          counts.status[l.st] = (counts.status[l.st] || 0) + 1;
          counts.types[l.type] = (counts.types[l.type] || 0) + 1;
          counts.ccy[l.ccy] = (counts.ccy[l.ccy] || 0) + 1;
          if (l.bill < lo) lo = l.bill;
          if (l.bill > hi) hi = l.bill;
        });
        var out = 0;
        CHECK_ORDER.forEach(function (k) { if (CHECKS[k].out) out += b.checks[k].n; });
        return { checks: b.checks, leftOut: out, counts: counts, products: s.products, first: lo === Infinity ? '' : isoDay(lo), last: hi === -Infinity ? '' : isoDay(hi), lastMonth: hi === -Infinity ? '' : monthKey(monthOfDay(hi)), answers: ans };
      },
      schedule: function (x) {
        var s = needLines();
        s.rmap = rulesMap(x.rules);
        var sc = buildSchedule(s.built.lines, s.rmap);
        s.sched = sc;
        var out = { currencies: sc.currencies, lists: sc.lists, ok: sc.ok, by: {} };
        sc.currencies.forEach(function (k) {
          var c = sc.by[k];
          out.by[k] = { ccy: k, m0: c.m0, n: c.n, months: c.months, billed: c.billed, rec: c.rec, matrix: c.matrix, billRows: c.billRows, rowTotals: c.rowTotals, colTotals: c.colTotals, roll: c.roll, totals: c.totals, checks: c.checks, journal: journal(c, x.accounts) };
        });
        return out;
      },
      reconcile: function (x) { var s = needLines(); return reconcile(s.built.lines, s.rmap || rulesMap(x.rules), x); },
      customers: function (x) { var s = needLines(); return customersList(s.built.lines, s.built.customers, x || {}); },
      customer: function (x) { var s = needLines(); return customerDetail(s.built.lines, s.built.customers, s.rmap || {}, Number(x.ci)); },
      /** A file to save, made here: schedule, waterfall, roll, journal, memo. */
      exportFile: function (x) {
        var s = needLines(), sc = s.sched || buildSchedule(s.built.lines, s.rmap || {});
        var base = (s.demo ? 'EXAMPLE-' : '') + 'waterfall';
        var c = x.ccy && sc.by[x.ccy] ? sc.by[x.ccy] : sc.by[sc.currencies[0]];
        switch (x.kind) {
          case 'schedule': return { name: base + '-schedule.csv', type: 'text/csv', text: scheduleCsv(s.built.lines, s.rmap || {}, { mask: x.mask }) };
          case 'waterfall': return { name: base + '-waterfall-' + c.ccy + '.csv', type: 'text/csv', text: waterfallCsv(c) };
          case 'roll': return { name: base + '-rollforward-' + c.ccy + '.csv', type: 'text/csv', text: rollCsv(c) };
          case 'journal': {
            var mi = monthFromKey(x.month);
            return { name: base + '-journal' + (mi !== null ? '-' + monthKey(mi) : '') + '.csv', type: 'text/csv', text: journalCsv(sc, x.accounts, mi !== null ? { mi: mi } : null) };
          }
          case 'memo': {
            var m2 = monthFromKey(x.month);
            if (m2 === null) throw new Error('Pick a month for the memo.');
            var leftOut = 0;
            CHECK_ORDER.forEach(function (k) { if (CHECKS[k].out) leftOut += s.built.checks[k].n; });
            var rc = x.recon ? reconcile(s.built.lines, s.rmap || {}, x.recon) : null;
            return { name: base + '-close-memo-' + monthKey(m2) + '.md', type: 'text/markdown', text: closeMemo(sc, { mi: m2, file: s.name, lines: s.built.lines.length, recon: rc, products: s.products, rmap: s.rmap || {}, leftOut: leftOut }) };
          }
          default: throw new Error('Unknown export.');
        }
      },
      aiPayload: function () {
        var s = needLines(), people = [];
        s.built.customers.forEach(function (c) { people.push(c.name); if (c.id) people.push(c.id); });
        var inv = {};
        s.built.lines.forEach(function (l) { if (l.inv && !inv[l.inv]) { inv[l.inv] = 1; people.push(l.inv); } });
        return aiPayload(s.products, people);
      },
      drop: function () { st = null; return true; },
      has: function () { return { file: Boolean(st && st.table), lines: Boolean(st && st.built), name: st ? st.name : '', demo: Boolean(st && st.demo) }; },
    };
  }

  return {
    LIMITS: LIMITS, NOT_POLICY: NOT_POLICY, NO_FX: NO_FX, SETUP_LINE: SETUP_LINE,
    FIELDS: FIELDS, FKEYS: FKEYS, field: field, TYPES: TYPES, TYPE_WORD: TYPE_WORD, STATUSES: STATUSES, STATUS_WORD: STATUS_WORD, LENS: LENS, LEN_WORD: LEN_WORD,
    RULES: RULES, RULE_WORD: RULE_WORD, AI_RULES: AI_RULES, CHECKS: CHECKS, CHECK_ORDER: CHECK_ORDER, CATS: CATS, BUCKET_WORD: BUCKET_WORD, KINDS: KINDS,
    DEFAULT_ACCOUNTS: DEFAULT_ACCOUNTS, ACCOUNT_KEYS: ACCOUNT_KEYS, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    str: str, esc: esc, line: line, clip: clip, noMarkup: noMarkup, groups: groups, plural: plural, cap1: cap1, pad: pad,
    isCcy: isCcy, decimalsOf: decimalsOf, money: money, plain: plain, readDecimal: readDecimal, toMinor: toMinor, readRate: readRate, rateText: rateText, convert: convert,
    fromCivil: fromCivil, toCivil: toCivil, dayOf: dayOf, isoDay: isoDay, dayFromIso: dayFromIso, niceDay: niceDay, monthOfDay: monthOfDay, monthStart: monthStart, monthEnd: monthEnd,
    monthKey: monthKey, monthFromKey: monthFromKey, monthLabel: monthLabel, monthLong: monthLong, addMonths: addMonths,
    readStamp: readStamp, dateOrder: dateOrder, ambiguousExample: ambiguousExample, readYesNo: readYesNo,
    sniffDelimiter: sniffDelimiter, splitRows: splitRows, parseTable: parseTable,
    headerNorm: headerNorm, guessColumns: guessColumns, mappingProblems: mappingProblems, headerOk: headerOk, presetFrom: presetFrom, applyPreset: applyPreset,
    questions: questions, periodEvidence: periodEvidence, statusOf: statusOf, typeOf: typeOf, productKey: productKey, buildLines: buildLines, productsOf: productsOf,
    ruleText: ruleText, rulesMap: rulesMap, ruleOf: ruleOf, splitDays: splitDays, recognise: recognise, buildSchedule: buildSchedule, accountsOf: accountsOf, journal: journal,
    categoryOf: categoryOf, normOf: normOf, findSubset: findSubset, reconcile: reconcile,
    lineView: lineView, maskName: maskName, customersList: customersList, customerDetail: customerDetail,
    csvCell: csvCell, toCsv: toCsv, md: md, scheduleCsv: scheduleCsv, waterfallCsv: waterfallCsv, rollCsv: rollCsv, journalCsv: journalCsv, closeMemo: closeMemo,
    defaults: defaults, cleanSettings: cleanSettings, mergeSettings: mergeSettings,
    aiLabel: aiLabel, aiPayload: aiPayload, rulesRequest: rulesRequest, cleanAiRules: cleanAiRules,
    createEngine: createEngine, cleanMap: cleanMap, cleanAnswers: cleanAnswers,
  };
}));
