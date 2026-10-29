/* Stray - the rules. Every stray payment home to the right account, with the
 * reason it belongs there.
 *
 * UMD: window.StrayCore in the page, importScripts() in the worker,
 * require() in the server and the tests. Everything that decides where a
 * payment goes lives here, so the page, the worker, the server's validation
 * and the tests run the same code. No clock, no dice, no network and no
 * storage: anything that needs "today" is handed it.
 *
 * What is in here, top to bottom:
 *   - text cleaning and escaping (the one door every file string goes through)
 *   - dates and money, read the many ways an export writes them
 *   - a CSV / TSV reader (RFC 4180 quoting, any delimiter, BOM, CRLF, a
 *     preamble above the header, row and cell caps)
 *   - column guessing from header names and value SHAPES, and the shape
 *     vocabulary the AI helper is allowed to see
 *   - payments and accounts built from a mapped file
 *   - names: normalising, nicknames, initials, co-borrowers, businesses
 *   - account numbers: leading zeros, one digit off, two digits swapped,
 *     numbers and invoice numbers inside a memo
 *   - the matcher: scores, reasons, splits, and the verdict
 *   - the meter, the ageing strip and the three exports (CSV-injection safe)
 *   - settings (header names and preferences only - never a value)
 *   - the two AI calls' requests, checked field by field, and their answers
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StrayCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    fileBytes: 20 * 1024 * 1024,   // a file bigger than this is refused before it is read
    payments: 5000,                 // suspense rows kept from one file
    accounts: 50000,                // account rows kept from one file
    columns: 60,
    cell: 300,                      // characters kept from one cell
    candidates: 5,                  // candidates kept per payment
    splitPool: 12,                  // accounts a split may be drawn from
    splitMax: 4,                    // accounts one split may cover
    splitVisits: 6000,              // subset-sum steps per payment, at most
    tokenFanout: 400,               // accounts read per name token, at most
    tokenCommon: 60,                // a second name word carried by more accounts than this adds none
    amountCrowd: 8,                 // more accounts than this share an amount: too common to tell
    presets: 20, presetHeaders: 60, headerChars: 60,
    nicknames: 100, prefixes: 12,
    noteChars: 400, initialsChars: 12,
    letterChars: 2000, emailChars: 1400, subjectChars: 120,
  };

  /* ================================================================== *
   * The verdicts, their points and their thresholds
   * ================================================================== */

  var VERDICTS = ['match', 'check', 'split', 'two', 'none'];
  var VERDICT_WORD = { match: 'Match', check: 'Check', split: 'Split', two: 'Two possible', none: 'No match' };
  var VERDICT_ICON = { match: '✓', check: '?', split: '÷', two: '⇄', none: '✗' };

  // What each signal is worth. A candidate's score is the best account-number
  // signal + the best name signal + the best amount signal + timing, less any
  // conflict. They are deliberately round so a person can add them up.
  var POINTS = {
    acctExact: 60,        // the account number given, exactly
    acctNorm: 55,         // ...once leading zeros, spaces, dashes or a prefix are ignored
    acctMemo: 50,         // an account number found inside the memo
    invoiceMemo: 50,      // an open invoice number found inside the memo (receivables)
    acctSwap: 40,         // two adjacent digits swapped
    acctOneOff: 30,       // one digit wrong
    nameExact: 40,        // the same person, in any order
    nameNick: 38,         // a nickname or abbreviation of the first name (Bill, Wm)
    nameInitial: 32,      // an initial and the surname (W Okafor)
    nameSpelling: 24,     // the surname one letter off
    nameBusiness: 20,     // a business named for the borrower's surname
    nameSurname: 12,      // the surname alone
    nameOther: 6,         // the surname with a different first name
    amtPayment: 32,       // the scheduled payment
    amtPayoff: 32,        // the payoff (or balance)
    amtPastDue: 30,       // the amount past due
    amtLateFee: 28,       // the payment (or past due) plus the late fee
    amtMultiple: 28,      // exactly 2 or 3 payments
    amtOnly: 30,          // what an amount-only candidate is worth (it never makes a match alone)
    timing: 5,            // received within TIMING_DAYS of the due day
    conflict: -25,        // the number given belongs to a different account
    closed: -15,          // the account is paid off, closed or charged off
  };
  var THRESHOLDS = {
    match: 70,            // a Match needs this score...
    kinds: 2,             // ...this many independent kinds of evidence (number, name, amount)...
    lead: 20,             // ...and this lead over the next candidate.
    likely: 45,           // below this a candidate is not worth a human's time
  };
  var TIMING_DAYS = 5;
  var MULTIPLES = [2, 3];

  /* ================================================================== *
   * Text: one door for every string a file, a person or a model wrote
   * ================================================================== */

  // Control characters, bidi overrides and zero-width characters. Each is
  // invisible or reorders text - in a payer's name it could make one account
  // look like another.
  var BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  function esc(v) { return str(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function clip(s, n) { return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).replace(/\s+$/, '') + '…'; }
  /** One line, invisible characters gone, bounded. */
  function line(v, max) { return clip(str(v).replace(BAD, '').replace(/\s+/g, ' ').trim(), max || 200); }
  /** Several lines kept (a letter), invisible characters gone, bounded. */
  function para(v, max) {
    return clip(str(v).replace(/\r\n?/g, '\n').replace(BAD, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(), max || 2000);
  }
  function noMarkup(s) { return str(s).replace(/<[^>]{0,200}>/g, '').replace(/[<>]/g, ''); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /** $1,234.56 from integer cents. */
  function money(cents) {
    if (typeof cents !== 'number' || !isFinite(cents)) return '';
    var neg = cents < 0, c = Math.abs(Math.round(cents));
    return (neg ? '-' : '') + '$' + groups(Math.floor(c / 100)) + '.' + ('0' + (c % 100)).slice(-2);
  }
  /** 1234.56 for a file a system imports. */
  function plainMoney(cents) {
    var c = Math.abs(Math.round(cents));
    return (cents < 0 ? '-' : '') + Math.floor(c / 100) + '.' + ('0' + (c % 100)).slice(-2);
  }
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function titleCase(s) { return str(s).toLowerCase().replace(/(^|[\s\-'])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); }); }

  /* ================================================================== *
   * Dates
   * ================================================================== */

  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function pad2(n) { return ('0' + n).slice(-2); }
  function ymd(y, m, d) {
    if (!(y >= 1900 && y <= 2199 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    var t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCMonth() !== m - 1) return null;
    return y + '-' + pad2(m) + '-' + pad2(d);
  }
  function isDay(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && ymd(+v.slice(0, 4), +v.slice(5, 7), +v.slice(8, 10)) === v; }
  function dayNum(iso) { return Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000); }
  function addDays(iso, n) { return new Date((dayNum(iso) + n) * 86400000).toISOString().slice(0, 10); }
  function daysBetween(a, b) { return isDay(a) && isDay(b) ? dayNum(b) - dayNum(a) : null; }
  function niceDay(iso) {
    if (!isDay(iso)) return '';
    return cap1(MONTHS[+iso.slice(5, 7) - 1]) + ' ' + (+iso.slice(8, 10)) + ', ' + iso.slice(0, 4);
  }
  function year2(y) { return y < 100 ? 2000 + y : y; }
  function monthOf(w) { var i = MONTHS.indexOf(String(w || '').toLowerCase().slice(0, 3)); return i < 0 ? 0 : i + 1; }

  /**
   * A date the way an export writes it, as YYYY-MM-DD, or null.
   * order: 'mdy' (US, the default) or 'dmy' for n/n/yyyy. An 8-digit
   * yyyymmdd and an Excel serial day are read only when `loose` is set (the
   * column was mapped as a date), because both look like account numbers.
   */
  function readDate(v, order, loose) {
    var s = line(v, 40);
    if (!s) return null;
    var m;
    if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2}|[AaPp][Mm])?)?$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?)?$/.exec(s))) {
      var a = +m[1], b = +m[2], y = year2(+m[3]);
      if (order === 'dmy') return ymd(y, b, a);
      return ymd(y, a, b);
    }
    if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) return monthOf(m[1]) ? ymd(+m[3], monthOf(m[1]), +m[2]) : null;
    if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{2}|\d{4})$/.exec(s))) return monthOf(m[2]) ? ymd(year2(+m[3]), monthOf(m[2]), +m[1]) : null;
    if (loose && (m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
    if (loose && /^\d{5}$/.test(s) && +s > 30000 && +s < 80000) return new Date(Date.UTC(1899, 11, 30) + (+s) * 86400000).toISOString().slice(0, 10);
    return null;
  }
  /** Which way a column's n/n/yyyy dates run: 'dmy' if any first part is over 12. */
  function dateOrder(values) {
    var dmy = 0, mdy = 0;
    for (var i = 0; i < values.length && i < 2000; i++) {
      var m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})/.exec(line(values[i], 40));
      if (!m) continue;
      if (+m[1] > 12) dmy++;
      if (+m[2] > 12) mdy++;
    }
    return dmy > mdy ? 'dmy' : 'mdy';
  }

  /* ================================================================== *
   * Money - integer cents, never floats
   * ================================================================== */

  /** {cents, negative} from "$1,234.56", "1234.56", "1.234,56", "USD 412.37",
   *  "(12.00)" or "12.00-"; null when it is not an amount. "free" is no
   *  amount, never $0.00. */
  function readMoney(v) {
    var s = line(v, 40);
    if (!s || !/\d/.test(s)) return null;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    s = s.replace(/^(usd|us\$|eur|gbp|cad|aud)\s*/i, '').replace(/\s*(usd|eur|gbp|cad|aud)$/i, '');
    if (/^-/.test(s)) { neg = true; s = s.slice(1).trim(); }
    if (/-$/.test(s)) { neg = true; s = s.slice(0, -1).trim(); }
    if (/\s?(cr|dr)$/i.test(s)) { if (/dr$/i.test(s)) neg = true; s = s.replace(/\s?(cr|dr)$/i, ''); }
    s = s.replace(/^[$€£]\s*/, '').replace(/^-/, function () { neg = true; return ''; });
    var whole, frac = '';
    var m;
    if ((m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s))) { whole = m[1].replace(/,/g, ''); frac = m[2] || ''; }
    else if ((m = /^(\d{1,3}(?:\.\d{3})+|\d+),(\d{1,2})$/.exec(s))) { whole = m[1].replace(/\./g, ''); frac = m[2]; }
    else if ((m = /^(\d{1,3}(?:[  ]\d{3})+)(?:[.,](\d{1,2}))?$/.exec(s))) { whole = m[1].replace(/[  ]/g, ''); frac = m[2] || ''; }
    else if ((m = /^(\d{1,3}(?:\.\d{3})+)$/.exec(s)) && false) { whole = m[1]; }
    else return null;
    if (whole.length > 11) return null;
    var cents = Number(whole) * 100 + (frac ? Number((frac + '0').slice(0, 2)) : 0);
    if (!isFinite(cents)) return null;
    return { cents: cents, negative: neg && cents > 0 };
  }

  /* ================================================================== *
   * Reading a file: CSV / TSV with RFC 4180 quoting
   * ================================================================== */

  var DELIMS = [',', ';', '\t', '|'];
  var DELIM_NAME = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };

  /**
   * Split text into rows of raw fields. Quoted fields may hold the delimiter,
   * doubled quotes and line breaks; CRLF, LF and CR all end a row. Stops
   * storing after maxRows (it keeps counting), and caps each field at
   * maxCell characters as it reads, so a 20 MB single cell costs nothing.
   */
  function splitRows(text, delim, maxRows, maxCell) {
    var rows = [], row = [], i = 0, n = text.length, total = 0, openQuote = false;
    var dc = delim.charCodeAt(0);
    var keep = maxRows === undefined ? Infinity : maxRows;
    var cap = maxCell || 100000;
    function endRow() {
      if (row.length === 1 && row[0] === '') { row = []; return; } // a blank line
      total++;
      if (rows.length < keep) rows.push(row);
      row = [];
    }
    while (i <= n) {
      if (i === n) { if (row.length) endRow(); break; }
      var c = text.charCodeAt(i);
      if (c === 34) { // a quoted field
        var buf = '', j = i + 1;
        for (;;) {
          var q = text.indexOf('"', j);
          if (q < 0) { buf += text.slice(j, Math.min(n, j + cap)); j = n; openQuote = true; break; }
          if (buf.length < cap) buf += text.slice(j, Math.min(q, j + cap));
          if (text.charCodeAt(q + 1) === 34) { if (buf.length < cap) buf += '"'; j = q + 2; continue; }
          j = q + 1; break;
        }
        // Anything between the closing quote and the delimiter is kept (leniently).
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
      // a line break ends the row
      if (d === 13 && text.charCodeAt(i + 1) === 10) i += 2; else i++;
      endRow();
    }
    return { rows: rows, total: total, openQuote: openQuote };
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
    return best;
  }

  /** Clean one cell, counting what was removed or cut. */
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

  /**
   * A whole file, read. Returns {headers, rows, delimiter, header (was there
   * one), preamble (lines skipped above it), total (data rows in the file),
   * kept, truncated, ragged, invisible, cut, openQuote, empty}.
   */
  function parseTable(text, opts) {
    opts = opts || {};
    var max = opts.maxRows || LIMITS.payments;
    var t = str(text);
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    var delim = opts.delimiter || sniffDelimiter(t);
    var hint = /^sep=.\r?\n/i.exec(t);
    if (hint) t = t.slice(hint[0].length);
    var sp = splitRows(t, delim, max + 12, LIMITS.cell * 4);
    var raw = sp.rows;
    var stats = { invisible: 0, cut: 0 };
    var out = { headers: [], rows: [], delimiter: delim, delimiterName: DELIM_NAME[delim], header: true, preamble: 0, total: 0, kept: 0, truncated: 0, ragged: 0, invisible: 0, cut: 0, openQuote: sp.openQuote, empty: false, wide: 0 };
    if (!raw.length) { out.empty = true; return out; }
    // The modal width of the first rows says which row is the header: a
    // report's title line or two above it are skipped.
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
    }
    out.total = Math.max(0, sp.total - start);
    out.kept = out.rows.length;
    out.truncated = Math.max(0, out.total - out.kept);
    out.invisible = stats.invisible;
    out.cut = stats.cut;
    return out;
  }

  /* ================================================================== *
   * Columns: the fields, the guess from headers and shapes
   * ================================================================== */

  var FIELDS = {
    payments: [
      { key: 'date', label: 'Date received', need: false, hint: 'When the payment arrived - for days in suspense and the due-day check.' },
      { key: 'amount', label: 'Amount', need: true, hint: 'What was paid.' },
      { key: 'payer', label: 'Payer name', need: false, hint: 'The name as written on the check or transfer.' },
      { key: 'memo', label: 'Reference / memo', need: false, hint: 'Any reference, memo or remittance text.' },
      { key: 'account', label: 'Account number given', need: false, hint: 'The account or loan number the payer wrote, if any.' },
      { key: 'method', label: 'Method', need: false, hint: 'Check, ACH, wire, cash...' },
      { key: 'id', label: 'Payment ID', need: false, hint: 'Your item or trace number. Stray numbers them if there is none.' },
    ],
    accounts: [
      { key: 'account', label: 'Account number', need: true, hint: 'The loan or account number.' },
      { key: 'borrower', label: 'Borrower', need: true, hint: 'The primary borrower or customer name.' },
      { key: 'coborrower', label: 'Co-borrower', need: false, hint: 'A co-borrower, co-signer or joint name.' },
      { key: 'payment', label: 'Scheduled payment', need: true, hint: 'The regular payment amount.' },
      { key: 'pastDue', label: 'Amount past due', need: false, hint: 'What is overdue now.' },
      { key: 'payoff', label: 'Payoff or balance', need: false, hint: 'The payoff or current balance.' },
      { key: 'dueDay', label: 'Due day', need: false, hint: 'The day of the month it is due, or the next due date.' },
      { key: 'status', label: 'Status', need: false, hint: 'Current, late, paid off...' },
      { key: 'invoices', label: 'Open invoice numbers', need: false, hint: 'For receivables: open invoices, separated by ; or ,' },
    ],
  };
  function fieldKeys(kind) { return (FIELDS[kind] || []).map(function (f) { return f.key; }); }
  function fieldOf(kind, key) { return (FIELDS[kind] || []).filter(function (f) { return f.key === key; })[0] || null; }

  // The fixed vocabulary of column SHAPES. The page describes each column with
  // these codes, computed on the device; the "help me map" helper is sent the
  // codes and the header names and nothing else, and the server refuses any
  // code that is not on this list. No code holds a digit or a value.
  var SHAPES = {
    'mostly-empty': 'mostly empty',
    'date': 'date-like',
    'money-decimals': 'number with 2 decimals',
    'money-sign': 'amount with a currency sign',
    'whole-number': 'whole number',
    'day-of-month': 'whole number from 1 to 31',
    'digits-short': '3 to 5 digits',
    'digits-mid': '6 to 10 digits',
    'digits-long': '11 or more digits',
    'code': 'letters and digits together',
    'name-like': 'text, 2 to 3 words, like a name',
    'one-word': 'text, one word',
    'few-words': 'text, 2 to 3 words',
    'many-words': 'text, 4 or more words',
    'capitals': 'mostly capital letters',
    'capitalised': 'capitalised words',
    'few-values': 'a handful of repeated values',
    'all-different': 'every value different',
    'list': 'several items separated by ; or |',
  };

  function headerNorm(h) { return str(h).toLowerCase().replace(/[_./\\]+/g, ' ').replace(/#/g, ' # ').replace(/[^a-z0-9#& ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

  // Header rules per field: [regex, points]. The best rule counts.
  var HEADER_RULES = {
    payments: {
      id: [[/\b(item|suspense|txn|transaction|trace|seq|sequence|batch item)\b/, 32], [/\bpayment (id|no|number|ref)\b/, 34], [/^(id|ref id|#|no)$/, 30]],
      date: [[/\b(received|rcvd|recvd|recv|deposit(ed)?|posted|effective|eff)\b/, 34], [/\b(date|dt)\b/, 28]],
      amount: [[/\b(amount|amt)\b/, 34], [/\b(total|paid|credit|payment|pmt|sum|remitted)\b/, 22]],
      payer: [[/\b(payer|payor|remitter|remitted by|paid by|from|sender|originator|drawer|customer|member|borrower)\b/, 34], [/\bname\b/, 28]],
      memo: [[/\b(memo|reference|ref|remittance|addenda|description|desc|details?|notes?|comments?|narrative|info)\b/, 32]],
      account: [[/\b(acct|account|loan|ln|contract)\b/, 34]],
      method: [[/\b(method|type|channel|via|source|tender|kind|instrument)\b/, 30]],
    },
    accounts: {
      account: [[/\b(acct|account|loan|ln|contract|note)\b.*\b(no|num|number|#|id)\b|\b(no|num|number|#|id)\b.*\b(acct|account|loan)\b/, 36], [/\b(acct|account|loan|ln|contract)\b/, 30]],
      borrower: [[/\b(borrower|primary|member|customer|debtor|obligor|owner|tenant|student|client)\b/, 34], [/\bname\b/, 26]],
      coborrower: [[/\b(co ?borrower|coborrower|co ?signer|cosigner|co ?applicant|co ?maker|joint|secondary|second borrower|co ?buyer|spouse|guarantor|co ?owner)\b/, 40]],
      payment: [[/\b(scheduled|sched|monthly|mthly|installment|instalment|inst|regular|reg|contractual|recurring)\b/, 34], [/\b(payment|pmt|pymt|emi|rent|dues|fee)\b/, 26]],
      pastDue: [[/\bpast ?due\b|\boverdue\b|\barrears?\b|\bdelinquen/, 40], [/\b(amount due|total due|due amount)\b/, 26]],
      payoff: [[/\bpay ?off\b/, 40], [/\b(balance|bal|principal|prin|outstanding|unpaid)\b/, 28]],
      dueDay: [[/\bdue (day|date|dt)\b|\b(next|nxt) due\b|\bday due\b|\bpayment day\b|\bdue on\b/, 40], [/\bdue\b/, 22]],
      status: [[/\b(status|sts|stat|state|stage|standing)\b/, 34]],
      invoices: [[/\binv(oice)?s?\b|\bbill (no|number)s?\b|\bopen items?\b/, 36]],
    },
  };

  function headerScore(kind, field, h) {
    var n = headerNorm(h);
    var best = 0;
    (HEADER_RULES[kind][field] || []).forEach(function (r) { if (r[0].test(n) && r[1] > best) best = r[1]; });
    // Disambiguation the regexes alone get wrong.
    if (field === 'account' && /\bname\b/.test(n)) best = 0;
    if ((field === 'borrower' || field === 'payer') && /\b(co|joint|secondary|second)\b/.test(n) && kind === 'accounts') best = 0;
    if (kind === 'accounts' && field === 'payment' && /\b(past|over|last|due date|day|date|payoff|balance)\b/.test(n)) best = 0;
    if (kind === 'accounts' && field === 'borrower' && /\b(acct|account|loan|number|no|#)\b/.test(n) && !/\bname\b/.test(n)) best = 0;
    if (kind === 'payments' && field === 'amount' && /\b(id|no|number|#|type|method|date)\b/.test(n)) best = Math.min(best, 10);
    if (kind === 'payments' && field === 'date' && /\bdue\b/.test(n)) best = Math.min(best, 10);
    if (kind === 'payments' && field === 'payer' && /\b(acct|account|loan|number|#)\b/.test(n) && !/\bname\b/.test(n)) best = 0;
    if (kind === 'payments' && field === 'id' && /\b(acct|account|loan|check|cheque)\b/.test(n)) best = 0;
    return best;
  }

  /** What a column's values look like, from a sample. */
  function profile(values) {
    var p = { n: 0, empty: 0, date: 0, money: 0, dp2: 0, sign: 0, num: 0, whole: 0, dom: 0, digits: 0, dlen: [], code: 0, name: 0, words: 0, many: 0, caps: 0, title: 0, list: 0, zero: 0, distinct: 0, mags: [] };
    var seen = {};
    var sample = values.length > 400 ? values.slice(0, 400) : values;
    sample.forEach(function (v) {
      v = str(v);
      if (!v) { p.empty++; return; }
      p.n++;
      var low = v.toLowerCase();
      if (!seen[low]) { seen[low] = 1; p.distinct++; }
      if (readDate(v)) p.date++;
      var m = readMoney(v);
      if (m) { p.num++; p.mags.push(m.cents); if (m.cents === 0) p.zero++; if (/[.,]\d{2}\)?-?$/.test(v)) p.dp2++; if (/[$€£]|\busd\b/i.test(v)) p.sign++; }
      if (/^\d+$/.test(v)) { p.whole++; if (v.length <= 2 && +v >= 1 && +v <= 31) p.dom++; }
      var dg = v.replace(/[\s-]/g, '');
      if (/^[A-Za-z]{0,4}#?\d{3,}$/.test(dg)) { p.digits++; p.dlen.push(dg.replace(/\D/g, '').length); }
      if (/[A-Za-z]/.test(v) && /\d/.test(v)) p.code++;
      var w = v.split(/\s+/);
      if (/^[A-Za-zÀ-ɏ.'’,&\- ]+$/.test(v) && /[A-Za-zÀ-ɏ]{2}/.test(v) && w.length <= 5) { p.name++; if (w.length >= 2 && w.length <= 3) p.words++; }
      if (w.length >= 4) p.many++;
      if (/[A-Z]/.test(v) && v === v.toUpperCase()) p.caps++;
      else if (/^[A-Z][a-z]/.test(v)) p.title++;
      if (/[;|]/.test(v) || /,\s*[A-Za-z]{1,6}-?\d{2,}/.test(v)) p.list++;
    });
    p.total = sample.length;
    return p;
  }
  function frac(p, k) { return p.n ? p[k] / p.n : 0; }
  function median(a) { if (!a.length) return 0; var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; }

  /** The shape codes for one column (at most four), from SHAPES. */
  function shapeCodes(p) {
    var out = [];
    if (p.total && p.empty / p.total > 0.7) out.push('mostly-empty');
    if (!p.n) return out.length ? out : ['mostly-empty'];
    var med = median(p.dlen);
    if (frac(p, 'date') > 0.6) out.push('date');
    else if (frac(p, 'num') > 0.6 && frac(p, 'dp2') > 0.5) out.push(frac(p, 'sign') > 0.5 ? 'money-sign' : 'money-decimals');
    else if (frac(p, 'dom') > 0.8) out.push('day-of-month');
    else if (frac(p, 'digits') > 0.6) out.push(med <= 5 ? 'digits-short' : med <= 10 ? 'digits-mid' : 'digits-long');
    else if (frac(p, 'whole') > 0.7) out.push('whole-number');
    else if (frac(p, 'code') > 0.6 && frac(p, 'many') < 0.3) out.push('code');
    else if (frac(p, 'name') > 0.6 && frac(p, 'words') > 0.5) out.push('name-like');
    else if (frac(p, 'many') > 0.4) out.push('many-words');
    else if (frac(p, 'name') > 0.6) out.push(frac(p, 'words') > 0.3 ? 'few-words' : 'one-word');
    else out.push(frac(p, 'many') > 0.2 ? 'many-words' : 'few-words');
    if (frac(p, 'list') > 0.3) out.push('list');
    if (frac(p, 'caps') > 0.6) out.push('capitals');
    else if (frac(p, 'title') > 0.6) out.push('capitalised');
    if (p.n >= 4 && p.distinct <= Math.max(2, Math.min(8, p.n / 3))) out.push('few-values');
    else if (p.n >= 4 && p.distinct === p.n) out.push('all-different');
    return out.slice(0, 4);
  }

  function shapeScore(kind, field, p, ctx) {
    if (!p.n) return { s: 0, gate: field !== 'coborrower' && field !== 'invoices' && field !== 'pastDue' };
    var money = frac(p, 'num'), moneyish = Math.max(frac(p, 'dp2'), frac(p, 'sign'));
    var name = frac(p, 'name');
    var digits = frac(p, 'digits');
    switch (field) {
      case 'date': return { s: frac(p, 'date') * 30, gate: frac(p, 'date') < 0.5 };
      case 'amount': case 'payment': case 'pastDue': case 'payoff': {
        var s = money * 20 + moneyish * 8;
        if (frac(p, 'date') > 0.5 || (digits > 0.6 && moneyish < 0.3)) s = 0;
        if (ctx && field === 'payoff' && ctx.maxMed && median(p.mags) === ctx.maxMed) s += 4;
        if (field === 'pastDue' && p.zero / Math.max(1, p.n) >= 0.25) s += 4;
        return { s: s, gate: money < 0.6 || s === 0 };
      }
      case 'account': {
        var a = digits * 24 + (p.distinct === p.n ? 4 : 0) + frac(p, 'code') * 4;
        if (moneyish > 0.5 || frac(p, 'date') > 0.5) a = 0;
        return { s: a, gate: kind === 'accounts' ? (digits + frac(p, 'code') < 0.5 || a === 0) : (digits + frac(p, 'code') < 0.3 && p.empty / Math.max(1, p.total) < 0.5) };
      }
      case 'payer': case 'borrower': case 'coborrower': {
        var nm = name * 18 + frac(p, 'words') * 10;
        if (field === 'coborrower') nm *= 0.8;
        return { s: nm, gate: name < 0.4 };
      }
      case 'memo': {
        var t = (1 - Math.max(frac(p, 'date'), money)) * 14 + frac(p, 'many') * 6 + frac(p, 'code') * 4;
        return { s: t, gate: money > 0.8 || frac(p, 'date') > 0.8 };
      }
      case 'method': {
        var few = p.distinct <= Math.max(2, Math.min(8, p.n / 3)) ? 1 : 0;
        var short = p.n ? (p.n - p.many) / p.n : 0;
        return { s: name * short * 14 + few * 10, gate: money > 0.5 || frac(p, 'date') > 0.5 };
      }
      case 'status': {
        var fs = p.distinct <= Math.max(2, Math.min(10, p.n / 3)) ? 1 : 0;
        return { s: fs * name * 24, gate: money > 0.5 };
      }
      case 'id': return { s: (p.distinct === p.n ? 12 : 0) + (frac(p, 'code') + digits) * 6, gate: p.distinct < p.n * 0.9 };
      case 'dueDay': return { s: Math.max(frac(p, 'dom'), frac(p, 'date')) * 26, gate: Math.max(frac(p, 'dom'), frac(p, 'date')) < 0.5 };
      case 'invoices': return { s: (frac(p, 'code') + frac(p, 'list')) * 10, gate: moneyish > 0.5 };
      default: return { s: 0, gate: true };
    }
  }

  /**
   * The deterministic guess. For every field and column: the header's points
   * plus the values' points (a header that says "amount" over a column of
   * names counts for a third). Then greedily, best pair first, each column
   * used once. Returns {map: {field: column index or -1}, sure: {field:
   * 'sure'|'likely'|'unsure'}, shapes: [codes per column], unsure: bool}.
   */
  function guessColumns(kind, headers, rows) {
    var cols = headers.map(function (_, i) { return rows.map(function (r) { return r[i]; }); });
    var profiles = cols.map(profile);
    var mags = profiles.map(function (p) { return frac(p, 'num') > 0.6 ? median(p.mags) : 0; });
    var ctx = { maxMed: Math.max.apply(null, mags.concat([0])) || 0 };
    var pairs = [];
    fieldKeys(kind).forEach(function (f) {
      headers.forEach(function (h, c) {
        var hs = headerScore(kind, f, h);
        var sh = shapeScore(kind, f, profiles[c], ctx);
        var total = (sh.gate ? hs * 0.3 : hs) + sh.s;
        pairs.push({ f: f, c: c, total: total, hs: hs, ss: sh.s, gate: sh.gate });
      });
    });
    pairs.sort(function (a, b) { return b.total - a.total || a.c - b.c; });
    var map = {}, sure = {}, used = {};
    fieldKeys(kind).forEach(function (f) { map[f] = -1; sure[f] = 'unsure'; });
    pairs.forEach(function (x) {
      if (map[x.f] >= 0 || used[x.c] || x.total < 22) return;
      map[x.f] = x.c; used[x.c] = 1;
      sure[x.f] = x.hs >= 26 && !x.gate && x.ss >= 10 ? 'sure' : x.total >= 38 ? 'likely' : 'unsure';
    });
    var need = (FIELDS[kind] || []).filter(function (f) { return f.need; });
    var unsure = need.some(function (f) { return map[f.key] < 0 || sure[f.key] === 'unsure'; });
    if (kind === 'payments' && map.payer < 0 && map.account < 0 && map.memo < 0) unsure = true;
    return { map: map, sure: sure, shapes: profiles.map(shapeCodes), unsure: unsure };
  }

  /** What is still missing before matching can run, in words. */
  function mappingProblems(kind, map) {
    var out = [];
    (FIELDS[kind] || []).forEach(function (f) { if (f.need && !(map[f.key] >= 0)) out.push('Choose the ' + f.label.toLowerCase() + ' column.'); });
    if (kind === 'payments' && !(map.payer >= 0) && !(map.account >= 0) && !(map.memo >= 0)) out.push('Choose at least one of payer name, reference / memo or account number - there is nothing to match on otherwise.');
    var seen = {};
    Object.keys(map).forEach(function (k) { var c = map[k]; if (c >= 0) { if (seen[c]) out.push('One column is chosen for two fields.'); seen[c] = 1; } });
    return out;
  }

  /** A file layout's signature: its header names, folded and sorted. */
  function layoutKey(headers) { return headers.map(function (h) { return headerNorm(h); }).filter(Boolean).sort().join('|'); }

  /** Is this header name a name, not a value? No @, no run of 3+ digits, no
   *  digits joined by punctuation ("10/05", "412.37"). The server refuses
   *  anything else; the page swaps such a header for "Column N" first. */
  function headerOk(h) {
    var s = str(h);
    if (!s || s.length > LIMITS.headerChars || s !== s.replace(BAD, '')) return false;
    if (/@/.test(s) || /\d{3,}/.test(s) || /\d[.,/:-]\d/.test(s) || /[<>{}\\]/.test(s)) return false;
    return Boolean(s.trim());
  }
  function safeHeader(h, i) { var s = line(h, LIMITS.headerChars); return headerOk(s) ? s : 'Column ' + (i + 1); }

  /** A saved layout applied to a file with exactly the same headers. */
  function applyPreset(kind, headers, presets) {
    var key = layoutKey(headers);
    var p = (presets || []).filter(function (x) { return x && x.kind === kind && layoutKey(x.headers) === key; })[0];
    if (!p) return null;
    var map = {};
    fieldKeys(kind).forEach(function (f) {
      var want = p.map[f];
      map[f] = want ? headers.map(headerNorm).indexOf(headerNorm(want)) : -1;
    });
    return map;
  }
  function presetFrom(kind, headers, map) {
    var m = {};
    fieldKeys(kind).forEach(function (f) { if (map[f] >= 0 && headers[map[f]] !== undefined) m[f] = headers[map[f]]; });
    return { kind: kind, headers: headers.slice(0, LIMITS.presetHeaders), map: m };
  }

  /* ================================================================== *
   * Payments and accounts from a mapped file
   * ================================================================== */

  var CLOSED = /\b(paid ?off|closed|charged? ?off|charge-?off|written ?off|cancel+ed|repossess|repo\b|settled in full|released)/i;

  function buildPayments(table, map) {
    var get = function (r, f) { return map[f] >= 0 ? str(r[map[f]]) : ''; };
    var order = map.date >= 0 ? dateOrder(table.rows.map(function (r) { return r[map.date]; })) : 'mdy';
    var out = [], skipped = [], ids = {};
    table.rows.forEach(function (r, i) {
      var lineNo = i + 1 + (table.header ? 1 : 0) + (table.preamble || 0);
      var m = readMoney(get(r, 'amount'));
      if (!m) { skipped.push({ line: lineNo, why: get(r, 'amount') ? 'the amount could not be read' : 'no amount' }); return; }
      if (m.negative) { skipped.push({ line: lineNo, why: 'a negative amount (a reversal or a refund?)' }); return; }
      if (!m.cents) { skipped.push({ line: lineNo, why: 'an amount of zero' }); return; }
      var rawDate = get(r, 'date');
      var date = rawDate ? readDate(rawDate, order, true) : null;
      var id = line(get(r, 'id'), 40) || 'P' + (out.length + 1);
      var base = id, k = 2;
      while (ids[id.toLowerCase()]) id = base + '-' + k++;
      ids[id.toLowerCase()] = 1;
      out.push({ id: id, line: lineNo, date: date, rawDate: date ? '' : line(rawDate, 40), cents: m.cents, payer: line(get(r, 'payer'), 120), memo: line(get(r, 'memo'), 200), account: line(get(r, 'account'), 40), method: line(get(r, 'method'), 30) });
    });
    return { payments: out, skipped: skipped, order: order };
  }

  function buildAccounts(table, map) {
    var get = function (r, f) { return map[f] >= 0 ? str(r[map[f]]) : ''; };
    var order = map.dueDay >= 0 ? dateOrder(table.rows.map(function (r) { return r[map.dueDay]; })) : 'mdy';
    var out = [], skipped = [], nums = {};
    var amt = function (v) { var m = readMoney(v); return m && !m.negative ? m.cents : null; };
    table.rows.forEach(function (r, i) {
      var lineNo = i + 1 + (table.header ? 1 : 0) + (table.preamble || 0);
      var num = line(get(r, 'account'), 40), name = line(get(r, 'borrower'), 120);
      if (!num) { skipped.push({ line: lineNo, why: 'no account number' }); return; }
      if (!name) { skipped.push({ line: lineNo, why: 'no borrower name' }); return; }
      var key = num.toUpperCase().replace(/[\s.\-/#]/g, '');
      if (nums[key]) { skipped.push({ line: lineNo, why: 'account ' + num + ' is listed twice - the first row was kept' }); return; }
      nums[key] = 1;
      var dueRaw = line(get(r, 'dueDay'), 40), due = null;
      if (/^\d{1,2}(st|nd|rd|th)?$/i.test(dueRaw)) { var dn = parseInt(dueRaw, 10); if (dn >= 1 && dn <= 31) due = dn; }
      else if (dueRaw) { var dd = readDate(dueRaw, order, true); if (dd) due = +dd.slice(8, 10); }
      var status = line(get(r, 'status'), 40);
      out.push({
        n: out.length, line: lineNo, number: num, borrower: name, coborrower: line(get(r, 'coborrower'), 120),
        payment: amt(get(r, 'payment')), pastDue: amt(get(r, 'pastDue')), payoff: amt(get(r, 'payoff')),
        dueDay: due, status: status, closed: CLOSED.test(status),
        invoices: line(get(r, 'invoices'), 300).split(/[;,|\s]+/).map(function (x) { return line(x, 30); }).filter(function (x) { return x && /\d/.test(x); }).slice(0, 30),
      });
    });
    return { accounts: out, skipped: skipped };
  }

  /* ================================================================== *
   * Names
   * ================================================================== */

  // Common nicknames and written abbreviations, grouped: any two words in one
  // group are the same first name. Deliberately small and plain - extra pairs
  // can be added in settings.
  var NICKNAME_GROUPS = [
    'william bill will billy willy willie wm liam', 'robert bob rob bobby robbie robt bert', 'elizabeth liz beth betty eliza lisa libby liza betsy elisabeth',
    'katherine catherine kathryn kate katie kathy cathy kat kay kitty', 'michael mike mikey mick mich', 'jennifer jen jenny jenn',
    'james jim jimmy jamie jas', 'john jack johnny jno', 'jonathan jon jonny', 'richard rick dick rich ricky richie',
    'thomas tom tommy thos', 'charles charlie chuck chas chaz', 'joseph joe joey jos', 'margaret maggie meg peggy marge margie',
    'patricia pat patty trish tricia', 'patrick pat paddy', 'christopher chris kit', 'christina christine chris tina chrissy',
    'daniel dan danny danl', 'david dave davey', 'edward ed eddie ted ned edw', 'anthony tony', 'andrew andy drew',
    'matthew matt', 'nicholas nick nicky', 'benjamin ben benny benj', 'samuel sam sammy saml', 'samantha sam sammy',
    'alexander alex al xander', 'alexandra alex lexi sandra', 'susan sue suzy susie', 'deborah debra deb debbie',
    'rebecca becky becca', 'victoria vicky tori', 'jessica jess jessie', 'stephen steven steve', 'timothy tim timmy',
    'gregory greg', 'nathaniel nathan nate nat', 'zachary zach zack', 'kenneth ken kenny', 'ronald ron ronnie',
    'donald don donnie', 'gerald gerry jerry', 'lawrence larry', 'leonard len lenny leo', 'raymond ray', 'francis frank fran frankie',
    'frances fran frannie', 'henry hank harry', 'harold hal harry', 'peter pete', 'philip phillip phil', 'abigail abby abbie',
    'dorothy dot dotty dottie', 'eleanor ellie nell nora', 'josephine jo josie', 'theodore ted teddy theo', 'frederick fred freddie',
    'albert al bert', 'walter walt', 'douglas doug', 'jeffrey jeff', 'joshua josh', 'kimberly kim', 'pamela pam',
    'cynthia cindy', 'melissa mel missy', 'amanda mandy', 'barbara barb babs', 'judith judy', 'sandra sandy',
    'teresa theresa terry tess', 'virginia ginny', 'george geo', 'benedict ben', 'manuel manny', 'alejandro alex',
    'guillermo memo', 'francisco paco pancho', 'jose pepe', 'roberto beto', 'alberto beto', 'dmitri dima', 'aleksandr sasha',
  ];
  var NICK = (function () {
    var m = {};
    NICKNAME_GROUPS.forEach(function (g, gi) { g.split(' ').forEach(function (w) { (m[w] = m[w] || []).push(gi); }); });
    return m;
  }());
  function nickMap(extra) {
    if (!extra || !extra.length) return null;
    var m = {};
    extra.forEach(function (p, i) {
      if (!Array.isArray(p) || p.length !== 2) return;
      var a = String(p[0]).toLowerCase(), b = String(p[1]).toLowerCase();
      (m[a] = m[a] || []).push('x' + i); (m[b] = m[b] || []).push('x' + i);
    });
    return m;
  }
  /** Are two first names the same person's? (equal, a nickname or abbreviation) */
  function nickEq(a, b, extra) {
    if (!a || !b) return false;
    if (a === b) return true;
    var ga = NICK[a] || [], gb = NICK[b] || [];
    for (var i = 0; i < ga.length; i++) if (gb.indexOf(ga[i]) >= 0) return true;
    if (extra) {
      var xa = extra[a] || [], xb = extra[b] || [];
      for (var j = 0; j < xa.length; j++) if (xb.indexOf(xa[j]) >= 0) return true;
    }
    return false;
  }

  var HONORIFICS = /^(mr|mrs|ms|miss|mx|dr|prof|rev|sir|dame|madam|mme|mlle|sr|sra|srta|herr|frau)$/;
  var SUFFIXES = /^(jr|jnr|sr|snr|ii|iii|iv|esq|md|phd|dds|cpa|rn)$/;
  var BUSINESS = /^(llc|l\.l\.c|inc|incorporated|co|corp|corporation|company|ltd|limited|llp|lp|pllc|plc|pc|gmbh|dba|enterprises?|holdings?|group|services?|solutions|landscaping|plumbing|electric|electrical|construction|consulting|trucking|farms?|dental|realty|properties|partners|associates|motors|auto|automotive|repair|roofing|cleaning|bakery|cafe|restaurant|studio|agency|ministries|church|foundation|trust|bros|brothers|sons)$/;
  var STOP = /^(the|of|and|for|payment|pmt|loan|acct|account|car|auto loan|on behalf|obo|attn)$/;
  var HOUSEHOLD = /^(family|household|house|residence|the)$/;

  /** A name broken into tokens: accents folded, punctuation dropped,
   *  honorifics and suffixes removed, businesses spotted, "A & B Smith"
   *  split into two people who share the surname. */
  function parseName(raw) {
    var s = str(raw);
    var comma = /^[^,&]+,[^,&]+$/.test(s); // "Okafor, William"
    s = s.normalize ? s.normalize('NFKD').replace(/[̀-ͯ]/g, '') : s;
    s = s.toLowerCase().replace(/['’`]/g, '').replace(/\band\b/g, '&');
    var business = false;
    var parts = s.split('&').map(function (p) {
      var toks = p.replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
      return toks.filter(function (t) {
        if (BUSINESS.test(t)) { business = true; return false; }
        return !HONORIFICS.test(t) && !SUFFIXES.test(t) && !HOUSEHOLD.test(t);
      });
    }).filter(function (t) { return t.length; });
    if (comma && parts.length === 1 && parts[0].length >= 2) {
      // "Okafor, William J" -> william j okafor
      var cut = s.split(',')[0].replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean).length;
      parts[0] = parts[0].slice(cut).concat(parts[0].slice(0, cut));
    }
    // A person named by a first name alone borrows the longest name's surname
    // (and, for a surname-first payer like "MARTINEZ HECTOR & ANA", its first word).
    var longest = parts.reduce(function (a, b) { return b.length > a.length ? b : a; }, []);
    var people = parts.map(function (t) {
      if (t.length === 1 && longest.length >= 2 && parts.length > 1) return t.concat([longest[longest.length - 1], longest[0]]);
      return t;
    });
    var all = [];
    people.forEach(function (t) { t.forEach(function (x) { if (all.indexOf(x) < 0) all.push(x); }); });
    return { people: people, tokens: all, business: business, empty: !all.length };
  }
  /** An account holder: first and last name. */
  function personOf(raw) {
    var p = parseName(raw);
    var t = p.people[0] || [];
    if (!t.length) return null;
    return { raw: line(raw, 120), first: t.length > 1 ? t[0] : '', last: t[t.length - 1], tokens: t, business: p.business };
  }
  function editOne(a, b) {
    if (a === b) return false;
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    var i = 0;
    while (i < la && i < lb && a[i] === b[i]) i++;
    if (la === lb) {
      if (a.slice(i + 1) === b.slice(i + 1)) return true;                       // one letter changed
      return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // two swapped
    }
    return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1); // one added or dropped
  }

  /**
   * How a payer's name relates to one account holder:
   *   exact | nick | initial | spelling | business | surname | other | null
   * with the payer's token that matched the first name.
   */
  function nameLevel(payer, person, extra) {
    if (!payer || payer.empty || !person) return null;
    var best = null;
    var rank = { exact: 7, nick: 6, initial: 5, spelling: 4, business: 3, surname: 2, other: 1 };
    payer.people.forEach(function (toks) {
      var lastAt = toks.indexOf(person.last), spelled = false;
      if (lastAt < 0 && person.last.length >= 5) {
        for (var i = 0; i < toks.length; i++) if (toks[i].length >= 4 && editOne(toks[i], person.last)) { lastAt = i; spelled = true; break; }
      }
      if (lastAt < 0) return;
      var others = toks.filter(function (_, i) { return i !== lastAt; });
      var r = null, word = '';
      if (payer.business) r = 'business';
      else if (!person.first) r = 'surname';
      else {
        for (var a = 0; a < others.length && !r; a++) if (others[a] === person.first) { r = 'exact'; word = others[a]; }
        for (var b = 0; b < others.length && !r; b++) if (others[b].length > 1 && nickEq(others[b], person.first, extra)) { r = 'nick'; word = others[b]; }
        for (var c = 0; c < others.length && !r; c++) if (others[c].length === 1 && others[c] === person.first[0]) { r = 'initial'; word = others[c]; }
        if (!r) r = others.some(function (t) { return t.length > 1 && t !== person.last; }) ? 'other' : 'surname';
        if (spelled && (r === 'exact' || r === 'nick' || r === 'initial')) r = 'spelling';
        else if (spelled) r = null;
      }
      if (!r) return;
      var order = toks.indexOf(person.last) === 0 && toks.length > 1 && person.first ? 'surname-first' : '';
      if (!best || rank[r] > rank[best.level]) best = { level: r, word: word, order: order };
    });
    return best;
  }
  var NAME_POINTS = { exact: POINTS.nameExact, nick: POINTS.nameNick, initial: POINTS.nameInitial, spelling: POINTS.nameSpelling, business: POINTS.nameBusiness, surname: POINTS.nameSurname, other: POINTS.nameOther };
  var NAME_KIND = { exact: 1, nick: 1, initial: 1, spelling: 1, business: 1 }; // counts as name evidence

  /* ================================================================== *
   * Account numbers
   * ================================================================== */

  /** The comparable form of an account number: prefixes, spaces, dashes and
   *  leading zeros dropped. {key, digits, raw, dropped: [what was ignored]} */
  function acctKey(raw, settings) {
    var s = line(raw, 40).toUpperCase();
    if (!s) return null;
    var dropped = [];
    var pre = (settings && settings.acctPrefixes) || [];
    var m = /^(LN|LOAN|ACCT|ACC|AC|NO|#)[\s#:.\-]*(?=\d)/.exec(s);
    if (m) { dropped.push('the “' + m[1] + '” in front'); s = s.slice(m[0].length); }
    else {
      for (var i = 0; i < pre.length; i++) {
        var p = String(pre[i]).toUpperCase();
        if (p && s.indexOf(p) === 0 && /^[\s#:.\-]*\d/.test(s.slice(p.length))) { dropped.push('the “' + p + '” in front'); s = s.slice(p.length).replace(/^[\s#:.\-]+/, ''); break; }
      }
    }
    if (/[\s]/.test(s)) dropped.push('spaces');
    if (/-/.test(s)) dropped.push('dashes');
    if (/[./#]/.test(s)) dropped.push('punctuation');
    s = s.replace(/[\s.\-/#]/g, '');
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      var z = s.replace(/^0+(?=\d)/, '');
      if (z !== s) dropped.push('leading zeros');
      return { key: 'D' + z, digits: z, raw: line(raw, 40), dropped: dropped };
    }
    if (!/^[A-Z0-9]+$/.test(s)) return null;
    var tail = /(\d{3,})$/.exec(s);
    return { key: 'A' + s, digits: tail ? tail[1].replace(/^0+(?=\d)/, '') : '', raw: line(raw, 40), dropped: dropped };
  }

  /** Numbers in a memo that could be account numbers: digit runs (spaces or
   *  dashes inside allowed) of acctDigits length, not amounts, not dates. */
  function memoNumbers(memo, settings) {
    var lo = (settings && settings.acctDigits && settings.acctDigits[0]) || 5;
    var hi = (settings && settings.acctDigits && settings.acctDigits[1]) || 12;
    var s = str(memo);
    var out = [];
    var re = /(\$?)(\d[\d -]*\d|\d)(?=([.,/:]\d)?)/g, m;
    while ((m = re.exec(s))) {
      if (m[1] || m[3]) continue;                                  // an amount or a date
      var prev = s.charAt(m.index - 1);
      if (prev === '.' || prev === '/' || prev === ':') continue;
      var raw = m[2].replace(/[ -]+$/, '');
      var d = raw.replace(/[ -]/g, '');
      if (d.length < lo || d.length > hi) {
        // "104 425 oct" - a run with spaces may hold two numbers; try each part
        raw.split(/[ -]+/).forEach(function (part) { if (part.length >= lo && part.length <= hi && out.indexOf(part) < 0) out.push(part); });
        continue;
      }
      if (out.indexOf(d) < 0) out.push(d);
    }
    return out.slice(0, 8);
  }
  /** Invoice-like codes in a memo: "INV 2207", "INV-2207", "#2207". */
  function memoInvoices(memo) {
    var s = str(memo).toUpperCase(), out = [], m;
    var re = /\b([A-Z]{1,6})[\s#:\-]*(\d{2,})\b/g;
    while ((m = re.exec(s))) { var k = m[1] + m[2]; if (out.indexOf(k) < 0) out.push(k); }
    return out.slice(0, 8);
  }
  function invKey(v) { return str(v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  /** Which digit differs (1-based) between two equal-length digit strings. */
  function oneOffAt(a, b) {
    if (a.length !== b.length) return 0;
    var at = 0;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) { if (at) return 0; at = i + 1; }
    return at;
  }
  function swappedAt(a, b) {
    if (a.length !== b.length) return 0;
    for (var i = 0; i < a.length - 1; i++) {
      if (a[i] !== b[i]) return a[i] === b[i + 1] && a[i + 1] === b[i] && a[i] !== a[i + 1] && a.slice(i + 2) === b.slice(i + 2) ? i + 1 : 0;
    }
    return 0;
  }

  /* ================================================================== *
   * The index over the account list
   * ================================================================== */

  function push(map, k, v) { var a = map.get(k); if (a) { if (a[a.length - 1] !== v) a.push(v); } else map.set(k, [v]); }

  function createIndex(accounts, settings) {
    settings = settings || {};
    var ix = { accounts: accounts, settings: settings, byKey: new Map(), byDigits: new Map(), byToken: new Map(), byAmount: new Map(), byInvoice: new Map(), people: [], extra: nickMap(settings.nicknames) };
    var fee = settings.lateFeeCents || 0;
    accounts.forEach(function (a, i) {
      var k = acctKey(a.number, settings);
      a.key = k;
      if (k) { push(ix.byKey, k.key, i); if (k.digits) push(ix.byDigits, k.digits, i); }
      var b = personOf(a.borrower), c = a.coborrower ? personOf(a.coborrower) : null;
      ix.people[i] = [b, c];
      [b, c].forEach(function (p) { if (p) p.tokens.forEach(function (t) { if (t.length > 1) push(ix.byToken, t, i); }); });
      var amt = function (cents, kind) { if (cents > 0) push(ix.byAmount, cents, i + ':' + kind); };
      amt(a.payment, 'payment'); amt(a.pastDue, 'pastDue'); amt(a.payoff, 'payoff');
      if (fee > 0) { amt(a.payment && a.payment + fee, 'lateFee'); amt(a.pastDue && a.pastDue + fee, 'pastDueFee'); }
      MULTIPLES.forEach(function (x) { amt(a.payment && a.payment * x, 'x' + x); });
      (a.invoices || []).forEach(function (v) {
        var key = invKey(v);
        if (key) push(ix.byInvoice, key, i);
        var dg = /(\d{4,})$/.exec(key);
        if (dg) push(ix.byInvoice, dg[1], i);
      });
    });
    return ix;
  }

  /* ================================================================== *
   * The matcher
   * ================================================================== */

  function acctLabel(a) { return a.number; }
  function personName(p) { return p ? titleCase(p.raw) : ''; }

  /** The best amount relation between a payment and an account, or null. */
  function amountSignal(p, a, settings) {
    var fee = (settings && settings.lateFeeCents) || 0, c = p.cents;
    if (a.payment && c === a.payment) return { sig: 'payment', points: POINTS.amtPayment, text: 'Amount is the scheduled payment, ' + money(a.payment) };
    if (a.pastDue && c === a.pastDue) return { sig: 'pastDue', points: POINTS.amtPastDue, text: 'Amount equals the past-due balance, ' + money(a.pastDue) };
    if (a.payoff && c === a.payoff) return { sig: 'payoff', points: POINTS.amtPayoff, text: 'Amount equals the payoff, ' + money(a.payoff) + ' - posting it should close the loan' };
    if (fee && a.payment && c === a.payment + fee) return { sig: 'lateFee', points: POINTS.amtLateFee, text: 'Amount is the ' + money(a.payment) + ' payment plus a ' + money(fee) + ' late fee' };
    if (fee && a.pastDue && c === a.pastDue + fee) return { sig: 'lateFee', points: POINTS.amtLateFee, text: 'Amount is the ' + money(a.pastDue) + ' past due plus a ' + money(fee) + ' late fee' };
    for (var i = 0; i < MULTIPLES.length; i++) if (a.payment && c === a.payment * MULTIPLES[i]) return { sig: 'multiple', points: POINTS.amtMultiple, text: 'Amount is exactly ' + MULTIPLES[i] + ' payments of ' + money(a.payment) };
    return null;
  }
  function amountMiss(p, a) {
    if (!a.payment) return 'This account has no scheduled payment on file to compare';
    var d = p.cents - a.payment;
    return 'Amount ' + money(p.cents) + ' is not the scheduled ' + money(a.payment) + ' (' + money(Math.abs(d)) + (d > 0 ? ' more' : ' less') + ')' + (a.pastDue || a.payoff ? ', the past due, the payoff' : '') + ' or a multiple';
  }
  function timingSignal(p, a) {
    if (!p.date || !a.dueDay) return null;
    var day = +p.date.slice(8, 10);
    var d = day - a.dueDay;
    if (d > 15) d -= 30;
    if (d < -15) d += 30;
    var when = d === 0 ? 'on the due day' : Math.abs(d) + (Math.abs(d) === 1 ? ' day ' : ' days ') + (d > 0 ? 'after' : 'before') + ' the due day';
    return { near: Math.abs(d) <= TIMING_DAYS, text: 'Received ' + when + ' (the ' + ordinal(a.dueDay) + ')' };
  }

  function nameText(level, payerRaw, person, co, extraWord) {
    var who = personName(person);
    var pr = line(payerRaw, 80);
    var prefix = co ? 'Paid by the co-borrower: ' : '';
    switch (level.level) {
      case 'exact': return co ? prefix + pr + ' = ' + who : 'Name matches' + (level.order ? ', surname first' : '') + ': ' + pr + ' = ' + who;
      case 'nick': return (co ? prefix : 'Name matches with a nickname: ') + pr + ' - ' + cap1(level.word) + ' is short for ' + cap1(person.first) + (co ? '' : ' (' + who + ')');
      case 'initial': return (co ? prefix : 'Initial and surname match: ') + pr + ' = ' + who;
      case 'spelling': return (co ? prefix : '') + 'Surname is one letter off: ' + pr + ' vs ' + who;
      case 'business': return 'A business, ' + pr + ', shares the ' + (co ? 'co-borrower’s' : 'borrower’s') + ' surname, ' + cap1(person.last) + ' - check it is paying for its owner';
      case 'surname': return 'Same surname only: ' + pr + ' - ' + who + (co ? ' (co-borrower)' : '');
      case 'other': return 'Same surname, different first name: ' + pr + ' vs ' + who + (co ? ' (co-borrower)' : '');
      default: return extraWord || '';
    }
  }

  /**
   * Score one account against one payment. Returns {i, score, kinds, hits,
   * misses, flags, name: {level, co}, acct: sig, amount: sig}.
   */
  function scoreCandidate(p, i, ix, ctx) {
    var a = ix.accounts[i], settings = ix.settings;
    var hits = [], misses = [], flags = [], kinds = {}, score = 0;
    // 1. the account number
    var as = ctx.acct[i] || null;
    if (as) { score += as.points; kinds.account = 1; hits.push({ k: 'account', sig: as.sig, text: as.text }); if (as.sig === 'oneOff') flags.push('oneOff'); }
    else if (ctx.given) misses.push({ k: 'account', text: 'Account number ' + ctx.given.raw + ' isn’t this account’s (' + acctLabel(a) + ')' });
    else if (!ctx.memoNums.length && !ctx.memoInv.length) misses.push({ k: 'account', text: 'No account number given, and none in the memo' });
    else misses.push({ k: 'account', text: 'The numbers in the memo aren’t this account’s' });
    if (ctx.givenAt.length && ctx.givenAt.indexOf(i) < 0 && !(as && as.points >= POINTS.acctMemo)) {
      var other = ix.accounts[ctx.givenAt[0]];
      score += POINTS.conflict; flags.push('conflict');
      misses.push({ k: 'account', text: 'The account number given, ' + ctx.given.raw + ', belongs to another account (' + personName(ix.people[ctx.givenAt[0]][0]) + ', ' + acctLabel(other) + ')' });
    }
    // 2. the name
    var people = ix.people[i], best = null, co = false;
    [0, 1].forEach(function (w) {
      var pp = people[w];
      if (!pp) return;
      var lv = nameLevel(ctx.payer, pp, ix.extra);
      if (lv && (!best || NAME_POINTS[lv.level] > NAME_POINTS[best.level])) { best = lv; co = w === 1; }
    });
    if (best) {
      score += NAME_POINTS[best.level];
      if (NAME_KIND[best.level]) kinds.name = 1;
      var nt = nameText(best, ctx.payerRaw, people[co ? 1 : 0], co);
      if (best.level === 'surname' || best.level === 'other') misses.push({ k: 'name', text: nt, partial: true });
      else hits.push({ k: 'name', sig: best.level, text: nt, co: co });
      if (best.level === 'business') flags.push('business');
    } else if (ctx.payer.empty) misses.push({ k: 'name', text: 'No payer name given' });
    else misses.push({ k: 'name', text: 'Name doesn’t match: ' + line(ctx.payerRaw, 80) + ' vs ' + personName(people[0]) + (people[1] ? ' or ' + personName(people[1]) : '') });
    // 3. the amount
    var am = amountSignal(p, a, settings);
    if (am) { score += am.points; kinds.amount = 1; hits.push({ k: 'amount', sig: am.sig, text: am.text }); }
    else misses.push({ k: 'amount', text: amountMiss(p, a) });
    // 4. timing (a small nudge, never decisive)
    var tm = timingSignal(p, a);
    if (tm) { if (tm.near) { score += POINTS.timing; hits.push({ k: 'timing', sig: 'timing', text: tm.text }); } else misses.push({ k: 'timing', text: tm.text }); }
    // 5. the account's own state
    if (a.closed) { score += POINTS.closed; flags.push('closed'); misses.push({ k: 'status', text: 'This account is marked ' + a.status }); }
    if (flags.indexOf('oneOff') >= 0 && kinds.amount) flags.splice(flags.indexOf('oneOff'), 1);
    if (flags.indexOf('business') >= 0 && kinds.account) flags.splice(flags.indexOf('business'), 1);
    return { i: i, score: score, kinds: Object.keys(kinds), hits: hits, misses: misses, flags: flags, name: best ? { level: best.level, co: co } : null, acct: as ? as.sig : null, amount: am ? am.sig : null };
  }

  /** Bounded subset-sum: 2..splitMax accounts from the pool whose scheduled
   *  payments add up to the payment exactly. Never more than splitVisits steps. */
  function findSplits(cents, pool) {
    var items = pool.filter(function (x) { return x.cents > 0 && x.cents < cents; }).slice(0, LIMITS.splitPool);
    items.sort(function (a, b) { return b.cents - a.cents; });
    var found = [], visits = 0, pick = [];
    (function go(start, left) {
      if (found.length >= 4 || visits > LIMITS.splitVisits) return;
      for (var j = start; j < items.length; j++) {
        visits++;
        var c = items[j].cents;
        if (c > left) continue;
        pick.push(items[j]);
        if (c === left && pick.length >= 2) found.push(pick.slice());
        else if (c < left && pick.length < LIMITS.splitMax) go(j + 1, left - c);
        pick.pop();
        if (found.length >= 4 || visits > LIMITS.splitVisits) return;
      }
    }(0, cents));
    return { found: found, visits: visits, capped: visits > LIMITS.splitVisits };
  }

  function namesList(tokens) {
    var t = tokens.map(cap1);
    if (t.length <= 1) return t.join('');
    return t.slice(0, -1).join(', ') + ' or ' + t[t.length - 1];
  }

  /**
   * Where one payment belongs. opts.exclude: account indexes ruled out by a
   * person ("Not this"). Returns {id, verdict, candidates, split, apart,
   * tried, why, crowd}.
   */
  function gather(p, ix, opts) {
    opts = opts || {};
    var exclude = opts.exclude || {};
    var settings = ix.settings;
    var ctx = { acct: {}, given: null, givenAt: [], memoNums: [], memoInv: [], payer: parseName(p.payer), payerRaw: p.payer };
    var cand = {};
    var note = function (i, sig) { if (exclude[i]) return; cand[i] = 1; var cur = ctx.acct[i]; if (sig && (!cur || sig.points > cur.points)) ctx.acct[i] = sig; };
    var tried = [];
    // The account number given.
    var g = p.account ? acctKey(p.account, settings) : null;
    if (g) {
      ctx.given = g;
      var hit = ix.byKey.get(g.key) || (g.digits ? ix.byDigits.get(g.digits) : null) || [];
      hit.forEach(function (i) {
        var a = ix.accounts[i];
        var same = line(a.number, 40).toUpperCase() === g.raw.toUpperCase();
        ctx.givenAt.push(i);
        note(i, same ? { sig: 'exact', points: POINTS.acctExact, text: 'Account number ' + a.number + ' matches exactly' }
          : { sig: 'norm', points: POINTS.acctNorm, text: 'Account number matches once ' + (g.dropped.length ? g.dropped.join(' and ') : 'formatting') + ' are ignored: ' + g.raw + ' → ' + a.number });
      });
      if (!hit.length && g.digits && g.digits.length >= 4) {
        var d = g.digits, seen = {};
        for (var s = 0; s < d.length - 1; s++) {
          if (d[s] === d[s + 1]) continue;
          var sw = d.slice(0, s) + d[s + 1] + d[s] + d.slice(s + 2);
          (ix.byDigits.get(sw) || []).forEach(function (i) { seen[i] = 1; note(i, { sig: 'swap', points: POINTS.acctSwap, text: 'Account number has two digits swapped: ' + g.raw + ' given, ' + ix.accounts[i].number + ' on file' }); });
        }
        for (var o = 0; o < d.length; o++) {
          for (var dg = 0; dg <= 9; dg++) {
            var ch = String(dg);
            if (ch === d[o] || (o === 0 && ch === '0')) continue;
            var v = d.slice(0, o) + ch + d.slice(o + 1);
            (ix.byDigits.get(v) || []).forEach(function (i) { if (!seen[i]) note(i, { sig: 'oneOff', points: POINTS.acctOneOff, text: 'Account number is one digit off: ' + g.raw + ' given, ' + ix.accounts[i].number + ' on file (' + ordinal(o + 1) + ' digit)' }); });
          }
        }
        tried.push(Object.keys(ctx.acct).length ? '' : 'Account number ' + g.raw + ': no account has it, or one a digit off, or one with two digits swapped');
      }
      // In receivables, the "account" column often carries an invoice number.
      (ix.byInvoice.get(invKey(p.account)) || []).forEach(function (i) { note(i, { sig: 'invoice', points: POINTS.invoiceMemo, text: 'Invoice ' + p.account + ' is open on this account' }); });
    }
    // Numbers and invoice codes in the memo.
    ctx.memoNums = memoNumbers(p.memo, settings);
    ctx.memoInv = memoInvoices(p.memo);
    var memoMiss = [];
    ctx.memoNums.forEach(function (n) {
      var k = n.replace(/^0+(?=\d)/, '');
      var hits = ix.byDigits.get(k) || [];
      hits.forEach(function (i) { note(i, { sig: 'memo', points: POINTS.acctMemo, text: 'The memo carries the account number: “' + line(p.memo, 60) + '” → ' + ix.accounts[i].number }); });
      var inv = ix.byInvoice.get(k) || [];
      inv.forEach(function (i) { note(i, { sig: 'invoice', points: POINTS.invoiceMemo, text: 'The memo names invoice ' + n + ', open on this account' }); });
      if (!hits.length && !inv.length) memoMiss.push(n);
    });
    ctx.memoInv.forEach(function (k) {
      (ix.byInvoice.get(k) || []).forEach(function (i) { note(i, { sig: 'invoice', points: POINTS.invoiceMemo, text: 'The memo names invoice ' + k + ', open on this account' }); });
    });
    if (memoMiss.length) tried.push('Memo: ' + memoMiss.join(', ') + (memoMiss.length === 1 ? ' is not an account number or an open invoice' : ' are not account numbers or open invoices'));
    else if (!g && !ctx.memoNums.length && !ctx.memoInv.length) tried.push(p.memo ? 'No account number given, and the memo holds none' : 'No account number or memo to go on');
    // Names: accounts sharing a word of the payer's name - led by the rarest
    // word (usually the surname), with a common one ("ana", "john") added only
    // when few enough accounts carry it to be worth scoring.
    var nameCands = {};
    var words = ctx.payer.tokens.filter(function (t) { return t.length >= 2 && !STOP.test(t); })
      .map(function (t) { return { t: t, list: ix.byToken.get(t) || [] }; })
      .sort(function (a, b) { return a.list.length - b.list.length; });
    var led = false;
    words.forEach(function (w) {
      var t = w.t, list = w.list;
      if (list.length && led && list.length > LIMITS.tokenCommon) return;
      if (list.length) led = true;
      for (var k = 0; k < list.length && k < LIMITS.tokenFanout; k++) { nameCands[list[k]] = 1; if (!exclude[list[k]]) cand[list[k]] = 1; }
      if (!list.length && t.length >= 5) {
        // a surname one letter off: look for the tokens it could have been
        ix.byToken.forEach(function (accts, tok) { if (Math.abs(tok.length - t.length) <= 1 && tok[0] === t[0] && editOne(t, tok)) accts.slice(0, 50).forEach(function (i) { nameCands[i] = 1; if (!exclude[i]) cand[i] = 1; }); });
      }
    });
    // Amounts: accounts this exact amount belongs to.
    var byAmt = ix.byAmount.get(p.cents) || [];
    var amtAccts = {};
    byAmt.forEach(function (e) { amtAccts[e.split(':')[0]] = 1; });
    var crowd = Object.keys(amtAccts).length;
    if (crowd && crowd <= LIMITS.amountCrowd) Object.keys(amtAccts).forEach(function (i) { if (!exclude[i]) cand[i] = 1; });
    return { ctx: ctx, cand: cand, nameCands: nameCands, crowd: crowd, tried: tried, exclude: exclude };
  }

  /** One account's score and reasons for one payment - for an account a
   *  person picked by hand as much as for the matcher's own candidates. */
  function explain(p, i, ix) {
    var g = gather(p, ix, {});
    return scoreCandidate(p, i, ix, g.ctx);
  }

  function matchPayment(p, ix, opts) {
    opts = opts || {};
    var g = gather(p, ix, opts);
    var ctx = g.ctx, cand = g.cand, nameCands = g.nameCands, crowd = g.crowd, tried = g.tried, exclude = g.exclude;
    var settings = ix.settings;
    // Score.
    var scored = Object.keys(cand).map(function (i) { return scoreCandidate(p, +i, ix, ctx); });
    scored.forEach(function (c) { if (!c.kinds.length && !c.name) c.score = Math.min(c.score, POINTS.amtOnly); });
    scored.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    var top = scored[0] || null, second = scored[1] || null;
    var out = { id: p.id, verdict: 'none', candidates: scored.slice(0, LIMITS.candidates), split: null, apart: [], tried: [], why: [], crowd: crowd, best: top ? ix.accounts[top.i].number + ' ' + personName(ix.people[top.i][0]) : '' };
    var lead = top ? top.score - (second ? second.score : 0) : 0;
    var matchOk = top && top.score >= THRESHOLDS.match && top.kinds.length >= THRESHOLDS.kinds && lead >= THRESHOLDS.lead && !top.flags.length;
    if (matchOk) { out.verdict = 'match'; return out; }
    // A split: one payment across a household's accounts.
    // The household: every account sharing the payer's surname (a relative's
    // loan too), or named by a number in the payment.
    var pool = scored.filter(function (c) { return c.name || c.acct; }).map(function (c) { return { i: c.i, cents: ix.accounts[c.i].payment || 0, c: c }; });
    if (!opts.noSplit && !(top && top.kinds.indexOf('amount') >= 0 && top.score >= THRESHOLDS.match) && pool.length >= 2) {
      var sp = findSplits(p.cents, pool);
      if (sp.found.length) {
        var rate = function (set) { return set.reduce(function (n, x) { return n + x.c.score; }, 0); };
        sp.found.sort(function (a, b) { return rate(b) - rate(a) || a.length - b.length; });
        var best = sp.found[0];
        var parts = best.map(function (x) { return { i: x.i, cents: x.cents }; }).sort(function (a, b) { return a.i - b.i; });
        var surnames = [];
        parts.forEach(function (x) { var pp = ix.people[x.i][0]; if (pp && surnames.indexOf(pp.last) < 0) surnames.push(pp.last); });
        var hits = ['One payment for ' + parts.length + ' accounts: ' + parts.map(function (x) { return money(x.cents); }).join(' + ') + ' = ' + money(p.cents) + ' - each is that account’s scheduled payment'];
        if (best.every(function (x) { return x.c.name; })) hits.push(surnames.length === 1 ? 'Every borrower is named ' + cap1(surnames[0]) + ', as the payer is - a household' : 'Each borrower shares a name with the payer');
        if (best.some(function (x) { return x.c.acct; })) hits.push('The account number' + (best.filter(function (x) { return x.c.acct; }).length > 1 ? 's point' : ' points') + ' at these accounts');
        out.split = { parts: parts, hits: hits, others: sp.found.length - 1 };
        if (sp.found.length > 1) out.split.hits.push('Another combination also adds up - check the split before posting it');
        out.verdict = 'split';
        return out;
      }
      if (!sp.found.length) tried.push('No combination of the ' + plural(pool.length, 'account') + ' sharing the payer’s name adds up to ' + money(p.cents));
    }
    if (top && second && top.score >= THRESHOLDS.likely && second.score >= THRESHOLDS.likely && lead < THRESHOLDS.lead) {
      out.verdict = 'two';
      out.apart = apart(top, second, ix);
      return out;
    }
    if (top && top.score >= THRESHOLDS.likely) {
      out.verdict = 'check';
      out.why = whyCheck(top, second);
      return out;
    }
    // No match: say what was tried.
    if (ctx.payer.empty) tried.push('No payer name to look up');
    else {
      var named = Object.keys(nameCands).length;
      var words = ctx.payer.tokens.filter(function (t) { return t.length > 1 && !STOP.test(t); });
      if (!named && ctx.payer.business) tried.push('Names: a business paid, and no borrower or co-borrower shares a name with ' + line(p.payer, 60));
      else if (!named) tried.push('Names: no borrower or co-borrower called ' + namesList(words.slice(0, 4)));
      else tried.push('Names: ' + plural(named, 'account') + ' share' + (named === 1 ? 's' : '') + ' a name with ' + line(p.payer, 60) + ', but nothing else ties the payment to ' + (named === 1 ? 'it' : 'one of them'));
    }
    if (!crowd) tried.push('Amount: no account’s payment, past due, payoff' + ((settings.lateFeeCents || 0) ? ', payment plus the ' + money(settings.lateFeeCents) + ' late fee' : '') + ' or 2-3 payments is ' + money(p.cents));
    else if (crowd > LIMITS.amountCrowd) tried.push('Amount: ' + money(p.cents) + ' fits ' + plural(crowd, 'account') + ' - too common to tell on its own');
    else tried.push('Amount: ' + money(p.cents) + ' fits ' + plural(crowd, 'account') + ', but nothing else ties the payment to ' + (crowd === 1 ? 'it' : 'one of them'));
    if (opts.noSplit) tried.push('You ruled out splitting it');
    var ruled = Object.keys(exclude).filter(function (k) { return exclude[k]; });
    if (ruled.length) tried.push('You ruled out ' + ruled.map(function (k) { return ix.accounts[k] ? ix.accounts[k].number : k; }).join(', '));
    out.tried = tried.filter(Boolean);
    return out;
  }

  function sigOf(c, k) { return c.hits.filter(function (h) { return h.k === k; })[0] || null; }
  /** For Two possible: what tells the two apart, in words. */
  function apart(a, b, ix) {
    var out = [];
    var nameA = personName(ix.people[a.i][0]), nameB = personName(ix.people[b.i][0]);
    ['account', 'amount', 'name', 'timing'].forEach(function (k) {
      var x = sigOf(a, k), y = sigOf(b, k);
      if (!x && !y) return;
      if (x && y && x.sig === y.sig && k !== 'name') return;
      if (k === 'name' && x && y && x.sig === y.sig) return;
      var missOf = function (c) { var m = c.misses.filter(function (mm) { return mm.k === k; })[0]; return m ? lowerFirst(m.text) : 'nothing on ' + (k === 'account' ? 'the account number' : 'the ' + k); };
      var line2 = function (who, s, c) { return who + ' (' + ix.accounts[c.i].number + '): ' + (s ? lowerFirst(s.text) : missOf(c)); };
      out.push(line2(nameA, x, a) + ' \u00b7 ' + line2(nameB, y, b));
    });
    if (!out.length) out.push('Nothing in the payment tells ' + nameA + ' and ' + nameB + ' apart');
    out.push('Ask the payer, or look at the check image for a full first name or an account number');
    return out;
  }
  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }
  function whyCheck(top, second) {
    var out = [];
    if (top.flags.indexOf('oneOff') >= 0) out.push('The account number is one digit off and the amount isn’t one of this account’s - confirm it is the right loan');
    if (top.flags.indexOf('business') >= 0) out.push('A business paid - confirm it is paying for this borrower’s loan');
    if (top.flags.indexOf('conflict') >= 0) out.push('The account number given belongs to another account');
    if (top.flags.indexOf('closed') >= 0) out.push('The account is marked closed or paid off');
    if (!out.length && top.kinds.length < THRESHOLDS.kinds) out.push('Only one kind of evidence ties the payment to this account');
    if (!out.length && second && top.score - second.score < THRESHOLDS.lead) out.push('Another account comes close');
    if (!out.length) out.push('The evidence is good but not conclusive');
    return out;
  }

  function matchAll(payments, accounts, settings, onProgress) {
    var ix = createIndex(accounts, settings);
    var out = [];
    for (var k = 0; k < payments.length; k++) {
      out.push(matchPayment(payments[k], ix));
      if (onProgress && k % 200 === 199) onProgress(k + 1, payments.length);
    }
    return { results: out, index: ix };
  }

  /** The candidates for a search box: by account number (exact, start, or a
   *  digit off) or by name tokens. */
  function searchAccounts(ix, q, limit) {
    var s = line(q, 60), out = [], seen = {};
    if (!s) return out;
    var add = function (i) { if (!seen[i] && out.length < (limit || 20)) { seen[i] = 1; out.push(i); } };
    var k = acctKey(s, ix.settings);
    if (k && /\d{3,}/.test(s)) {
      (ix.byKey.get(k.key) || []).forEach(add);
      (ix.byDigits.get(k.digits) || []).forEach(add);
      if (out.length < (limit || 20)) ix.accounts.forEach(function (a, i) { if (a.key && a.key.digits && a.key.digits.indexOf(k.digits) >= 0) add(i); });
    }
    var toks = parseName(s).tokens.filter(function (t) { return t.length > 1; });
    if (toks.length) {
      var counts = {};
      toks.forEach(function (t) { (ix.byToken.get(t) || []).forEach(function (i) { counts[i] = (counts[i] || 0) + 1; }); });
      Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a - b; }).forEach(function (i) { add(+i); });
      if (out.length < (limit || 20)) ix.byToken.forEach(function (accts, tok) { if (toks.some(function (t) { return t.length >= 3 && tok.indexOf(t) === 0; })) accts.forEach(add); });
    }
    return out;
  }

  /* ================================================================== *
   * The meter, the ageing strip and the day
   * ================================================================== */

  var AGE_BUCKETS = [
    { key: 'a', label: '0-5 days', lo: 0, hi: 5 },
    { key: 'b', label: '6-15 days', lo: 6, hi: 15 },
    { key: 'c', label: '16-30 days', lo: 16, hi: 30 },
    { key: 'd', label: 'Over 30 days', lo: 31, hi: Infinity },
  ];
  function ageOf(p, today) { var d = p.date ? daysBetween(p.date, today) : null; return d === null ? null : Math.max(0, d); }
  function bucketOf(days) { if (days === null) return null; for (var i = 0; i < AGE_BUCKETS.length; i++) if (days >= AGE_BUCKETS[i].lo && days <= AGE_BUCKETS[i].hi) return AGE_BUCKETS[i].key; return null; }
  function isOut(dec) { return Boolean(dec && (dec.kind === 'post' || dec.kind === 'split')); }

  /** "$8,412.90 of $11,206.15 out of suspense - 9 of 14 payments". */
  function meter(payments, decisions) {
    var m = { total: 0, out: 0, n: payments.length, done: 0, held: 0 };
    payments.forEach(function (p) {
      m.total += p.cents;
      var d = decisions && decisions[p.id];
      if (isOut(d)) { m.out += p.cents; m.done++; }
      else if (d && d.kind === 'hold') m.held++;
    });
    m.pct = m.total ? Math.round(m.out / m.total * 1000) / 10 : 0;
    m.line = money(m.out) + ' of ' + money(m.total) + ' out of suspense - ' + m.done + ' of ' + plural(m.n, 'payment');
    return m;
  }
  /** The ageing strip over the payments still open. */
  function ageing(payments, decisions, today, limit) {
    var b = AGE_BUCKETS.map(function (x) { return { key: x.key, label: x.label, count: 0, cents: 0 }; });
    var oldest = null, over = 0, overCents = 0, undated = 0;
    payments.forEach(function (p) {
      if (isOut(decisions && decisions[p.id])) return;
      var d = ageOf(p, today);
      if (d === null) { undated++; return; }
      var k = bucketOf(d);
      b.forEach(function (x) { if (x.key === k) { x.count++; x.cents += p.cents; } });
      if (!oldest || d > oldest.days) oldest = { id: p.id, days: d, cents: p.cents, payer: p.payer };
      if (limit && d > limit) { over++; overCents += p.cents; }
    });
    return { buckets: b, oldest: oldest, over: over, overCents: overCents, undated: undated, limit: limit };
  }

  /* ================================================================== *
   * Exports - CSV-injection safe, RFC 4180 out
   * ================================================================== */

  /** One CSV cell. A cell a spreadsheet would read as a formula (= + - @, or
   *  a tab or carriage return first) gets a ' in front; anything with a
   *  comma, quote or line break is quoted. */
  function csvCell(v) {
    var s = str(v).replace(BAD, '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows) { return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n'; }

  function reasonSummary(dec) { return line(dec && dec.reason, 300); }

  /** The posting file: one line per account a payment goes to. */
  function postingRows(payments, accounts, decisions) {
    var rows = [['payment_id', 'date_received', 'payment_amount', 'account_number', 'post_amount', 'split', 'decided_by', 'decided_at', 'reason']];
    payments.forEach(function (p) {
      var d = decisions[p.id];
      if (!isOut(d)) return;
      var parts = d.parts || [];
      parts.forEach(function (x, k) {
        rows.push([p.id, p.date || p.rawDate || '', plainMoney(p.cents), x.account, plainMoney(x.cents), parts.length > 1 ? (k + 1) + ' of ' + parts.length : '', line(d.by, LIMITS.initialsChars), str(d.at).slice(0, 19), reasonSummary(d)]);
      });
    });
    return rows;
  }
  /** The research list: every payment still in suspense, with what was tried. */
  function researchRows(payments, results, decisions, notes, today) {
    var rows = [['payment_id', 'date_received', 'amount', 'payer', 'reference', 'account_given', 'method', 'days_in_suspense', 'verdict', 'best_candidate', 'what_was_tried', 'note']];
    var byId = {};
    (results || []).forEach(function (r) { byId[r.id] = r; });
    payments.forEach(function (p) {
      var d = decisions[p.id];
      if (isOut(d)) return;
      var r = byId[p.id] || {};
      var tried = (r.tried && r.tried.length ? r.tried : (r.why || [])).concat(r.apart || []);
      rows.push([p.id, p.date || p.rawDate || '', plainMoney(p.cents), p.payer, p.memo, p.account, p.method, ageOf(p, today) === null ? '' : String(ageOf(p, today)), VERDICT_WORD[r.verdict] || '', r.best || '', tried.join(' | '), line(notes && notes[p.id], LIMITS.noteChars)]);
    });
    return rows;
  }
  /** The day, in plain words. */
  function daySummary(o) {
    var m = meter(o.payments, o.decisions);
    var ag = ageing(o.payments, o.decisions, o.today, o.limit);
    var counts = {};
    VERDICTS.forEach(function (v) { counts[v] = 0; });
    (o.results || []).forEach(function (r) { counts[r.verdict] = (counts[r.verdict] || 0) + 1; });
    var posted = 0, split = 0, held = 0;
    o.payments.forEach(function (p) { var d = o.decisions[p.id]; if (d && d.kind === 'post') posted++; else if (d && d.kind === 'split') split++; else if (d && d.kind === 'hold') held++; });
    var out = [];
    out.push('Suspense review - ' + niceDay(o.today) + (o.title ? ' - ' + line(o.title, 80) : ''));
    out.push('');
    out.push('Cleared: ' + m.line + ' (' + m.pct + '%).');
    out.push('Posted to one account: ' + posted + '. Split across accounts: ' + split + '. Held for research: ' + held + '. Still open: ' + (m.n - m.done - held) + '.');
    out.push('Stray’s read of the list: ' + VERDICTS.map(function (v) { return counts[v] + ' ' + VERDICT_WORD[v]; }).join(', ') + '.');
    out.push('Still in suspense: ' + money(m.total - m.out) + ' across ' + plural(m.n - m.done, 'payment') + '.');
    if (ag.oldest) out.push('Oldest still open: ' + money(ag.oldest.cents) + ' from ' + (ag.oldest.payer || 'an unnamed payer') + ', ' + plural(ag.oldest.days, 'day') + ' in suspense (' + ag.oldest.id + ').');
    if (ag.limit) out.push(ag.over ? plural(ag.over, 'payment') + ' (' + money(ag.overCents) + ') ' + (ag.over === 1 ? 'is' : 'are') + ' past your policy’s ' + ag.limit + '-day limit.' : 'Nothing open is past your policy’s ' + ag.limit + '-day limit.');
    out.push('Ageing of what is open: ' + ag.buckets.map(function (b) { return b.label + ': ' + b.count + ' (' + money(b.cents) + ')'; }).join('; ') + '.');
    out.push('');
    out.push('Every posting was accepted by a person; Stray only proposes. Made on this device - nothing was uploaded.');
    return out.join('\n');
  }

  /* ================================================================== *
   * Settings: preferences and header names only - never a value
   * ================================================================== */

  var DEFAULT_SETTINGS = { version: 1, lateFeeCents: 2500, ageLimitDays: 30, nicknames: [], acctPrefixes: [], acctDigits: [5, 12], presets: [], updatedAt: 0 };
  var SETTINGS_KEYS = ['version', 'lateFeeCents', 'ageLimitDays', 'nicknames', 'acctPrefixes', 'acctDigits', 'presets', 'updatedAt'];
  function defaults() { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }

  /**
   * Clean settings. strict (the server): anything unexpected is an error,
   * listed, and nothing is saved. Lenient (the page, an old copy): bad entries
   * are dropped. Either way the result holds no payment, account, name or
   * amount - header names must not look like values, nicknames are letters.
   */
  function cleanSettings(raw, strict) {
    var errors = [];
    var out = defaults();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { settings: out, errors: ['Settings must be an object.'] };
    Object.keys(raw).forEach(function (k) { if (SETTINGS_KEYS.indexOf(k) < 0) errors.push('Unknown setting: ' + line(k, 30) + '.'); });
    var int = function (v, lo, hi) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= lo && v <= hi; };
    if (raw.lateFeeCents !== undefined) { if (int(raw.lateFeeCents, 0, 100000)) out.lateFeeCents = raw.lateFeeCents; else errors.push('The late fee must be between $0 and $1,000.'); }
    if (raw.ageLimitDays !== undefined) { if (int(raw.ageLimitDays, 1, 365)) out.ageLimitDays = raw.ageLimitDays; else errors.push('The ageing limit must be 1 to 365 days.'); }
    if (raw.acctDigits !== undefined) {
      var ad = raw.acctDigits;
      if (Array.isArray(ad) && ad.length === 2 && int(ad[0], 3, 20) && int(ad[1], 3, 20) && ad[0] <= ad[1]) out.acctDigits = [ad[0], ad[1]];
      else errors.push('Account numbers must be 3 to 20 digits, shortest first.');
    }
    if (raw.nicknames !== undefined) {
      if (!Array.isArray(raw.nicknames) || raw.nicknames.length > LIMITS.nicknames) errors.push('At most ' + LIMITS.nicknames + ' nickname pairs.');
      else raw.nicknames.forEach(function (p) {
        var ok = Array.isArray(p) && p.length === 2 && p.every(function (w) { return typeof w === 'string' && /^[A-Za-z]{2,20}$/.test(w); }) && p[0].toLowerCase() !== p[1].toLowerCase();
        if (ok) { var pr = [p[0].toLowerCase(), p[1].toLowerCase()]; if (!out.nicknames.some(function (x) { return x[0] === pr[0] && x[1] === pr[1]; })) out.nicknames.push(pr); }
        else errors.push('A nickname pair is two different first names, letters only.');
      });
    }
    if (raw.acctPrefixes !== undefined) {
      if (!Array.isArray(raw.acctPrefixes) || raw.acctPrefixes.length > LIMITS.prefixes) errors.push('At most ' + LIMITS.prefixes + ' prefixes.');
      else raw.acctPrefixes.forEach(function (p) {
        if (typeof p === 'string' && /^[A-Za-z]{1,8}$/.test(p)) { if (out.acctPrefixes.indexOf(p.toUpperCase()) < 0) out.acctPrefixes.push(p.toUpperCase()); }
        else errors.push('A prefix is 1 to 8 letters.');
      });
    }
    if (raw.presets !== undefined) {
      if (!Array.isArray(raw.presets) || raw.presets.length > LIMITS.presets) errors.push('At most ' + LIMITS.presets + ' saved layouts.');
      else raw.presets.forEach(function (p) {
        var e = presetError(p);
        if (e) { errors.push(e); return; }
        var clean = { kind: p.kind, headers: p.headers.map(function (h) { return line(h, LIMITS.headerChars); }), map: {} };
        Object.keys(p.map).forEach(function (f) { clean.map[f] = line(p.map[f], LIMITS.headerChars); });
        var key = layoutKey(clean.headers);
        out.presets = out.presets.filter(function (x) { return !(x.kind === clean.kind && layoutKey(x.headers) === key); });
        out.presets.push(clean);
      });
    }
    if (raw.version !== undefined && raw.version !== 1) errors.push('Unknown settings version.');
    if (raw.updatedAt !== undefined) { if (typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt) && raw.updatedAt >= 0) out.updatedAt = Math.floor(raw.updatedAt); else errors.push('Bad updatedAt.'); }
    return { settings: out, errors: strict ? errors : [] };
  }
  function presetError(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'A saved layout must be an object.';
    if (Object.keys(p).some(function (k) { return ['kind', 'headers', 'map'].indexOf(k) < 0; })) return 'A saved layout holds only its kind, its header names and the mapping.';
    if (p.kind !== 'payments' && p.kind !== 'accounts') return 'A saved layout is for payments or accounts.';
    if (!Array.isArray(p.headers) || !p.headers.length || p.headers.length > LIMITS.presetHeaders) return 'A saved layout has 1 to ' + LIMITS.presetHeaders + ' header names.';
    for (var i = 0; i < p.headers.length; i++) if (typeof p.headers[i] !== 'string' || !headerOk(p.headers[i])) return 'A saved layout’s header names must not look like values (no @, account numbers, amounts or dates).';
    if (!p.map || typeof p.map !== 'object' || Array.isArray(p.map)) return 'A saved layout needs its mapping.';
    var fk = fieldKeys(p.kind), heads = p.headers.map(headerNorm);
    var keys = Object.keys(p.map);
    for (var j = 0; j < keys.length; j++) {
      if (fk.indexOf(keys[j]) < 0) return 'Unknown field in a saved layout.';
      if (typeof p.map[keys[j]] !== 'string' || heads.indexOf(headerNorm(p.map[keys[j]])) < 0) return 'A saved layout maps a field to a header it does not have.';
    }
    return '';
  }
  /** Two copies brought together: layouts and nicknames from both, the
   *  newer copy's numbers. */
  function mergeSettings(a, b) {
    var x = cleanSettings(a).settings, y = cleanSettings(b).settings;
    var newer = (y.updatedAt || 0) >= (x.updatedAt || 0) ? y : x, older = newer === y ? x : y;
    var out = cleanSettings({ lateFeeCents: newer.lateFeeCents, ageLimitDays: newer.ageLimitDays, acctDigits: newer.acctDigits, acctPrefixes: newer.acctPrefixes.concat(older.acctPrefixes).slice(0, LIMITS.prefixes), nicknames: older.nicknames.concat(newer.nicknames).slice(-LIMITS.nicknames), presets: older.presets.concat(newer.presets).slice(-LIMITS.presets) }).settings;
    out.updatedAt = Math.max(x.updatedAt || 0, y.updatedAt || 0);
    return out;
  }

  /* ================================================================== *
   * The two AI calls: requests checked field by field, answers cleaned
   * ================================================================== */

  // "Draft the 'which account is this for?' letter". The model is told only
  // which of four situations it is and the tone. No amount (not even rounded),
  // no name, no date, no reference: the letter comes back with placeholders,
  // and the page fills them in here, on the device.
  var SITUATIONS = {
    'no-match': 'We received a payment we cannot match to any account.',
    'two-possible': 'A payment could belong to one of two accounts, and we need the payer to say which.',
    'split-confirm': 'One payment appears to cover more than one account; we want the payer to confirm how to split it.',
    'business-for-owner': 'A business sent a payment that appears to be for a personal loan of its owner; we want the payer to confirm which loan.',
  };
  var TONES = ['friendly', 'formal'];
  var PLACEHOLDERS = ['payer_name', 'amount', 'date_received', 'reference', 'phone'];

  function onlyKeys(o, keys) { return o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(function (k) { return keys.indexOf(k) >= 0; }); }

  /** The letter request as the server accepts it: {situation, tone} and
   *  nothing else, or null. */
  function letterRequest(body) {
    if (!onlyKeys(body, ['situation', 'tone'])) return null;
    if (!Object.prototype.hasOwnProperty.call(SITUATIONS, body.situation)) return null;
    if (body.tone !== undefined && TONES.indexOf(body.tone) < 0) return null;
    return { situation: body.situation, tone: body.tone || 'friendly' };
  }
  function situationFor(verdict, result) {
    if (verdict === 'two') return 'two-possible';
    if (verdict === 'split') return 'split-confirm';
    if (result && result.candidates && result.candidates[0] && result.candidates[0].flags.indexOf('business') >= 0) return 'business-for-owner';
    return 'no-match';
  }

  // Any web address: a scheme, www., or anything shaped like a domain name.
  var LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b(?:\/\S*)?|mailto:\S+|javascript:\S*/gi;
  /** One field of the letter: no markup, no links, only the five
   *  placeholders, bounded. Returns {text, removed}. */
  function cleanLetterText(v, max) {
    var removed = 0;
    var s = para(noMarkup(v), max * 2);
    s = s.replace(LINK, function () { removed++; return ''; });
    // Kept placeholders are parked in private-use characters while any stray
    // brace is removed, then put back.
    s = s.replace(/[\uE000\uE001]/g, '').replace(/\{\{?\s*([^{}]{0,40}?)\s*\}?\}/g, function (m, name) {
      var k = name.toLowerCase().replace(/[\s-]+/g, '_');
      if (PLACEHOLDERS.indexOf(k) >= 0) return '\uE000' + k + '\uE001';
      removed++;
      return '';
    });
    s = s.replace(/[{}]/g, '').replace(/\uE000/g, '{').replace(/\uE001/g, '}').replace(/[ \t]+([,.;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ');
    return { text: clip(s.trim(), max), removed: removed };
  }
  function cleanLetter(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var a = cleanLetterText(raw.subject, LIMITS.subjectChars), b = cleanLetterText(raw.letter, LIMITS.letterChars), c = cleanLetterText(raw.email, LIMITS.emailChars);
    a.text = a.text.replace(/\n+/g, ' ');
    if (!b.text && !c.text) return null;
    return { subject: a.text, letter: b.text, email: c.text, removed: a.removed + b.removed + c.removed };
  }
  /** The placeholders filled in, on the device. */
  function fillLetter(text, values) {
    return str(text).replace(/\{(payer_name|amount|date_received|reference|phone)\}/g, function (m, k) { var v = line(values && values[k], 120); return v || '[' + k.replace(/_/g, ' ') + ']'; });
  }
  function letterValues(p, phone) {
    return { payer_name: p.payer ? titleCase(p.payer) : 'Customer', amount: money(p.cents), date_received: p.date ? niceDay(p.date) : (p.rawDate || ''), reference: p.memo || p.account || p.id, phone: line(phone, 40) };
  }

  /** What "Help me map these columns" sends: header names (a value-looking
   *  one becomes "Column N") and the shape codes. Nothing else. */
  function columnsPayload(kind, headers, shapes) {
    return { kind: kind, columns: headers.slice(0, LIMITS.columns).map(function (h, i) { return { header: safeHeader(h, i), shape: (shapes[i] || []).filter(function (c) { return Object.prototype.hasOwnProperty.call(SHAPES, c); }).slice(0, 4) }; }) };
  }
  /** The server's check of that payload: exactly {kind, columns: [{header,
   *  shape}]}, every header a name, every shape code from SHAPES. */
  function columnsRequest(body) {
    if (!onlyKeys(body, ['kind', 'columns'])) return null;
    if (body.kind !== 'payments' && body.kind !== 'accounts') return null;
    if (!Array.isArray(body.columns) || !body.columns.length || body.columns.length > LIMITS.columns) return null;
    var cols = [];
    for (var i = 0; i < body.columns.length; i++) {
      var c = body.columns[i];
      if (!onlyKeys(c, ['header', 'shape'])) return null;
      if (typeof c.header !== 'string' || !headerOk(c.header)) return null;
      if (!Array.isArray(c.shape) || c.shape.length > 4) return null;
      for (var j = 0; j < c.shape.length; j++) if (typeof c.shape[j] !== 'string' || !Object.prototype.hasOwnProperty.call(SHAPES, c.shape[j])) return null;
      cols.push({ header: c.header, shape: c.shape.slice() });
    }
    return { kind: body.kind, columns: cols };
  }
  /** The model's mapping, checked: known fields, real columns, each once. */
  function cleanColumns(raw, req) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.mapping)) return null;
    var keys = fieldKeys(req.kind), map = {}, used = {}, dropped = 0;
    keys.forEach(function (k) { map[k] = -1; });
    raw.mapping.slice(0, 40).forEach(function (m) {
      if (!m || typeof m !== 'object') { dropped++; return; }
      var c = Number(m.column);
      if (keys.indexOf(m.field) < 0 || !(Math.floor(c) === c && c >= 1 && c <= req.columns.length) || used[c] || map[m.field] >= 0) { dropped++; return; }
      map[m.field] = c - 1; used[c] = 1;
    });
    if (!Object.keys(map).some(function (k) { return map[k] >= 0; })) return null;
    return { map: map, dropped: dropped, note: noMarkup(line(raw.note, 300)).replace(LINK, '') };
  }

  /* ================================================================== *
   * The engine: the same steps in the worker and, without one, on the page
   * ================================================================== */

  /** A small stateful wrapper the worker (and the page, when there is no
   *  worker) drives: it keeps the parsed tables and the index, so a 50,000-row
   *  account list is read and indexed once. No clock, no storage, no network. */
  function createEngine() {
    var tables = {};
    var st = { ix: null, payments: [], accounts: [], byId: {} };
    function load(payments, accounts, o, onProgress, extra) {
      var ix = createIndex(accounts, o.settings || {});
      st = { ix: ix, payments: payments, accounts: accounts, byId: {} };
      payments.forEach(function (p) { st.byId[p.id] = p; });
      var results = [];
      for (var k = 0; k < payments.length; k++) {
        var ex = o.rejected && o.rejected[payments[k].id];
        results.push(matchPayment(payments[k], ix, { exclude: (ex && ex.accts) || {}, noSplit: Boolean(ex && ex.split) }));
        if (onProgress && k % 250 === 249) onProgress(k + 1, payments.length);
      }
      var out = { payments: payments, accounts: accounts, results: results };
      Object.keys(extra || {}).forEach(function (key) { out[key] = extra[key]; });
      return out;
    }
    function pay(pid) { var p = st.byId[pid]; if (!p) throw new Error('That payment is not loaded.'); return p; }
    return {
      parse: function (o) {
        var t = parseTable(o.text, { maxRows: o.kind === 'accounts' ? LIMITS.accounts : LIMITS.payments });
        tables[o.kind] = t;
        var g = guessColumns(o.kind, t.headers, t.rows);
        return {
          kind: o.kind, name: line(o.name, 120), headers: t.headers, sample: t.rows.slice(0, 8), guess: g, layout: layoutKey(t.headers),
          stats: { delimiter: t.delimiterName, header: t.header, preamble: t.preamble, total: t.total, kept: t.kept, truncated: t.truncated, ragged: t.ragged, invisible: t.invisible, cut: t.cut, openQuote: t.openQuote, empty: t.empty, wide: t.wide, chars: str(o.text).length },
        };
      },
      drop: function (o) { delete tables[o.kind]; return true; },
      prepare: function (o, onProgress) {
        if (!tables.payments || !tables.accounts) throw new Error('Load both files first.');
        var P = buildPayments(tables.payments, o.payMap), A = buildAccounts(tables.accounts, o.accMap);
        return load(P.payments, A.accounts, o, onProgress, { skippedP: P.skipped, skippedA: A.skipped, dateOrder: P.order });
      },
      restore: function (o, onProgress) { return load(o.payments || [], o.accounts || [], o, onProgress, {}); },
      relink: function (o, onProgress) { return load(st.payments, st.accounts, o, onProgress, {}); },
      rematch: function (o) { return matchPayment(pay(o.pid), st.ix, { exclude: o.exclude || {}, noSplit: Boolean(o.noSplit) }); },
      explain: function (o) { return explain(pay(o.pid), o.i, st.ix); },
      search: function (o) { return st.ix ? searchAccounts(st.ix, o.q, 20) : []; },
    };
  }

  return {
    LIMITS: LIMITS, VERDICTS: VERDICTS, VERDICT_WORD: VERDICT_WORD, VERDICT_ICON: VERDICT_ICON, POINTS: POINTS, THRESHOLDS: THRESHOLDS, TIMING_DAYS: TIMING_DAYS,
    FIELDS: FIELDS, SHAPES: SHAPES, AGE_BUCKETS: AGE_BUCKETS, NICKNAME_GROUPS: NICKNAME_GROUPS, SITUATIONS: SITUATIONS, TONES: TONES, PLACEHOLDERS: PLACEHOLDERS, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    esc: esc, line: line, para: para, clip: clip, plural: plural, money: money, plainMoney: plainMoney, ordinal: ordinal, titleCase: titleCase, noMarkup: noMarkup,
    isDay: isDay, addDays: addDays, daysBetween: daysBetween, niceDay: niceDay, readDate: readDate, dateOrder: dateOrder, readMoney: readMoney,
    sniffDelimiter: sniffDelimiter, splitRows: splitRows, parseTable: parseTable,
    profile: profile, shapeCodes: shapeCodes, guessColumns: guessColumns, headerScore: headerScore, mappingProblems: mappingProblems, layoutKey: layoutKey, headerOk: headerOk, safeHeader: safeHeader, applyPreset: applyPreset, presetFrom: presetFrom, fieldKeys: fieldKeys, fieldOf: fieldOf,
    buildPayments: buildPayments, buildAccounts: buildAccounts,
    parseName: parseName, personOf: personOf, nickEq: nickEq, nameLevel: nameLevel, editOne: editOne,
    acctKey: acctKey, memoNumbers: memoNumbers, memoInvoices: memoInvoices, oneOffAt: oneOffAt, swappedAt: swappedAt,
    createIndex: createIndex, scoreCandidate: scoreCandidate, gather: gather, explain: explain, createEngine: createEngine, findSplits: findSplits, matchPayment: matchPayment, matchAll: matchAll, searchAccounts: searchAccounts, amountSignal: amountSignal,
    ageOf: ageOf, bucketOf: bucketOf, meter: meter, ageing: ageing, isOut: isOut,
    csvCell: csvCell, toCsv: toCsv, postingRows: postingRows, researchRows: researchRows, daySummary: daySummary,
    defaults: defaults, cleanSettings: cleanSettings, mergeSettings: mergeSettings,
    letterRequest: letterRequest, situationFor: situationFor, cleanLetter: cleanLetter, fillLetter: fillLetter, letterValues: letterValues,
    columnsPayload: columnsPayload, columnsRequest: columnsRequest, cleanColumns: cleanColumns,
  };
}));
