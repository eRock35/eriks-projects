/* Lastday - the rules. When someone leaves, every account leaves with them.
 *
 * UMD: window.LastdayCore in the page, importScripts() in the worker,
 * require() in the server and the tests. Everything that decides whether an
 * account is an orphan, what a leaver's checklist holds and what a pasted
 * request says lives here, so the page, the worker, the server's validation
 * and the tests run the same code. No clock, no dice, no network and no
 * storage: "today" and "now" are handed in.
 *
 * What is in here, top to bottom:
 *   - text cleaning and escaping (the one door every file string goes through)
 *   - dates, read the many ways an export writes them
 *   - a CSV / TSV reader (RFC 4180 quoting, any delimiter, BOM, CRLF, a
 *     preamble above the header, row and cell caps)
 *   - column guessing for identity-provider and app user exports
 *   - addresses: case, plus-addressing, the company's domain aliases,
 *     Entra guest UPNs; names folded for the fallback match
 *   - the orphan finder: a verdict per app account, critical first, the
 *     summary and the per-person view
 *   - the leaver checklist: timed steps from the system inventory, the
 *     orphan finder's accounts pre-filled, progress
 *   - the request parser: a pasted email or ticket read into the leaver's
 *     fields, each with the words it came from, and questions for the rest
 *   - masking for the one AI call, and its request and answer checked
 *   - exports (CSV-injection safe, JSON for a PSA, Markdown for a ticket)
 *   - the inventory and settings (never a person) - cleaned, strict, merged
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LastdayCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    fileBytes: 20 * 1024 * 1024,   // a file bigger than this is refused before it is read
    rows: 50000,                    // rows kept from one file
    apps: 20,                       // app exports at once
    columns: 80,
    cell: 300,                      // characters kept from one cell
    headerChars: 60,
    okSent: 2000,                   // OK accounts handed to the page (findings are all sent)
    systems: 60, steps: 11, systemChars: 60,
    domains: 10, patterns: 80, patternChars: 40,
    leavers: 50, tasks: 300,
    evidenceChars: 300, byChars: 24, fieldChars: 80, notesChars: 600,
    pasteChars: 20000,              // a pasted request
    aiChars: 4000,                  // what may be sent to the model, masked
    questions: 8, fromChars: 160,
    dormantMin: 14, dormantMax: 730,
  };

  /* ================================================================== *
   * Text: one door for every string a file, a person or a model wrote
   * ================================================================== */

  // Control characters, bidi overrides and zero-width characters. Each is
  // invisible or reorders text - in a name it could make one person look
  // like another.
  var BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  function esc(v) { return str(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function clip(s, n) { return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).replace(/\s+$/, '') + '…'; }
  /** One line, invisible characters gone, bounded. */
  function line(v, max) { return clip(str(v).replace(BAD, '').replace(/\s+/g, ' ').trim(), max || 200); }
  /** Several lines kept, invisible characters gone, bounded. */
  function para(v, max) {
    return clip(str(v).replace(/\r\n?/g, '\n').replace(BAD, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(), max || 2000);
  }
  function noMarkup(s) { return str(s).replace(/<[^>]{0,200}>/g, '').replace(/[<>]/g, ''); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function titleCase(s) { return str(s).toLowerCase().replace(/(^|[\s\-'’])([a-z\u00e0-\u024f])/g, function (m, a, b) { return a + b.toUpperCase(); }); }
  function fold(s) { return str(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  function onlyKeys(o, keys) { return Boolean(o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(function (k) { return keys.indexOf(k) >= 0; })); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  // Anything shaped like a web address or a link, for answers that must hold none.
  var LINK = /\b(?:https?:\/\/|www\.)\S+|\bjavascript:\S*|\b[a-z0-9-]+\.(?:com|net|org|io|co|info|biz|ly|app|dev|xyz|example)\b(?:\/\S*)?/gi;
  var EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

  /* ================================================================== *
   * Dates
   * ================================================================== */

  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function pad2(n) { return ('0' + n).slice(-2); }
  function ymd(y, m, d) {
    if (!(y >= 1900 && y <= 2199 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    var t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCMonth() !== m - 1) return null;
    return y + '-' + pad2(m) + '-' + pad2(d);
  }
  function isDay(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && ymd(+v.slice(0, 4), +v.slice(5, 7), +v.slice(8, 10)) === v; }
  function isTime(v) { return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }
  function dayNum(iso) { return Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000); }
  function addDays(iso, n) { return new Date((dayNum(iso) + n) * 86400000).toISOString().slice(0, 10); }
  function daysBetween(a, b) { return isDay(a) && isDay(b) ? dayNum(b) - dayNum(a) : null; }
  /** 0 = Sunday. */
  function weekday(iso) { return ((dayNum(iso) + 4) % 7 + 7) % 7; }
  function monthOf(w) { var i = MONTHS.indexOf(String(w || '').toLowerCase().slice(0, 3)); return i < 0 ? 0 : i + 1; }
  function year2(y) { return y < 100 ? 2000 + y : y; }
  /** "Aug 1, 2026". */
  function niceDay(iso) {
    if (!isDay(iso)) return '';
    return cap1(MONTHS[+iso.slice(5, 7) - 1]) + ' ' + (+iso.slice(8, 10)) + ', ' + iso.slice(0, 4);
  }
  /** "Aug 1" (with the year when it is not `thisYear`). */
  function shortDay(iso, thisYear) {
    if (!isDay(iso)) return '';
    var s = cap1(MONTHS[+iso.slice(5, 7) - 1]) + ' ' + (+iso.slice(8, 10));
    return thisYear && iso.slice(0, 4) !== String(thisYear) ? s + ', ' + iso.slice(0, 4) : s;
  }
  /** "Fri Nov 6". */
  function dayLabel(iso, thisYear) { return isDay(iso) ? cap1(DAYS[weekday(iso)]) + ' ' + shortDay(iso, thisYear) : ''; }
  /** "5:00 PM" from "17:00". */
  function clockLabel(t) {
    if (!isTime(t)) return '';
    var h = +t.slice(0, 2), m = t.slice(3);
    return (h % 12 || 12) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  function lastOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
  function prevWorkday(iso) { var d = addDays(iso, -1); while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, -1); return d; }

  /**
   * A date the way an export writes it, as YYYY-MM-DD, or null. A time after
   * it ("2026-08-01T09:12:44Z", "2026/10/01 14:32:11", "Aug 1, 2026 9:12 AM")
   * is ignored. order: 'mdy' (US, the default) or 'dmy' for n/n/yyyy. Unix
   * seconds or milliseconds and yyyymmdd are read only when `loose` is set
   * (the column was mapped as a date), because they look like ids.
   */
  function readDate(v, order, loose) {
    var s = line(v, 60);
    if (!s) return null;
    var m;
    if (loose && /^\d{10}(\.\d+)?$/.test(s)) { var sec = +s; if (sec > 946684800 && sec < 4102444800) return new Date(sec * 1000).toISOString().slice(0, 10); }
    if (loose && /^\d{13}$/.test(s)) { var ms = +s; if (ms > 946684800000 && ms < 4102444800000) return new Date(ms).toISOString().slice(0, 10); }
    if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T ,]\s*\d{1,2}:\d{2})/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:$|[ ,T]\s*\d{1,2}:\d{2})/.exec(s))) {
      var a = +m[1], b = +m[2], y = year2(+m[3]);
      if (order === 'dmy' || a > 12) return ymd(y, b, a);
      return ymd(y, a, b);
    }
    if ((m = /^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:$|[ ,T]\s*\d{1,2}:\d{2}|\s+at\s)/.exec(s))) return monthOf(m[1]) ? ymd(+m[3], monthOf(m[1]), +m[2]) : null;
    if ((m = /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{2}|\d{4})(?:$|[ ,T]\s*\d{1,2}:\d{2})/.exec(s))) return monthOf(m[2]) ? ymd(year2(+m[3]), monthOf(m[2]), +m[1]) : null;
    if (loose && (m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
    return null;
  }
  /** "Never", "Never logged in", "-" in a last-sign-in column. */
  function isNever(v) { return /^(never|never (logged|signed) in|not (yet )?(logged|signed) in|none|n\/a)$/i.test(line(v, 40)); }
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
    r.forEach(function (v) { if (!v) return; n++; if (/@/.test(v) || readDate(v) || /^\d{3,}$/.test(v.replace(/[\s-]/g, '')) || /^(true|false|active|suspended|member|admin)$/i.test(v)) data++; });
    return n > 0 && data / n >= 0.5;
  }

  /**
   * A whole file, read. Returns {headers, rows, delimiter, header (was there
   * one), preamble (lines skipped above it), total (data rows in the file),
   * kept, truncated, ragged, invisible, cut, openQuote, empty, wide}.
   */
  function parseTable(text, opts) {
    opts = opts || {};
    var max = opts.maxRows || LIMITS.rows;
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
   * Columns: the fields, and the guess from headers and values
   * ================================================================== */

  var FIELDS = {
    idp: [
      { key: 'email', label: 'Email or sign-in name', need: true, hint: 'The sign-in address: email, username or user principal name.' },
      { key: 'alias', label: 'Other address', need: false, hint: 'A second address for the same person (mail beside the UPN, aliases).' },
      { key: 'name', label: 'Display name', need: false, hint: 'The full name - or choose the first and last name columns.' },
      { key: 'first', label: 'First name', need: false, hint: 'Used when there is no display name.' },
      { key: 'last', label: 'Last name', need: false, hint: 'Used when there is no display name.' },
      { key: 'status', label: 'Status', need: false, hint: 'Active, suspended, deprovisioned - or an enabled yes / no column. Without one, everyone counts as active.' },
      { key: 'changed', label: 'Status changed', need: false, hint: 'When they were suspended or deprovisioned - for how long ago they left.' },
      { key: 'lastLogin', label: 'Last sign-in', need: false, hint: 'When they last signed in.' },
    ],
    app: [
      { key: 'email', label: 'Email', need: false, hint: 'The account’s address. Needed unless there is a name.' },
      { key: 'name', label: 'Name', need: false, hint: 'The person’s name - the fallback match when there is no address.' },
      { key: 'first', label: 'First name', need: false, hint: 'Used when there is no full name.' },
      { key: 'last', label: 'Last name', need: false, hint: 'Used when there is no full name.' },
      { key: 'role', label: 'Role or account type', need: false, hint: 'Owner, admin, member, guest, bot - for which orphans are critical.' },
      { key: 'status', label: 'Status', need: false, hint: 'Active or deactivated in this app.' },
      { key: 'lastActive', label: 'Last active', need: false, hint: 'Last sign-in or activity here - for dormant accounts.' },
    ],
  };
  function fieldKeys(kind) { return (FIELDS[kind] || []).map(function (f) { return f.key; }); }
  function fieldOf(kind, key) { return (FIELDS[kind] || []).filter(function (f) { return f.key === key; })[0] || null; }

  /** A header folded for the rules: camelCase split, brackets and
   *  punctuation gone ("userPrincipalName" -> "user principal name",
   *  "Email Address [Required]" -> "email address required"). */
  function headerNorm(h) {
    return str(h).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_./\\\-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  var LAST_SEEN = /\blast ?(sign ?in|signin|login|log ?in|logon|log on|seen|active|activity|accessed|access|used|session|successful sign ?in)\b|\blastlogin\b|\blast ?seen\b/;
  var HEADER_RULES = {
    idp: {
      email: [[/\b(user ?principal ?name|upn)\b/, 40], [/\bprimary e ?mail\b|\be ?mail address\b/, 38], [/\be ?mail\b/, 34], [/\b(login|username|user name|sign ?in name|user id|userid)\b/, 30], [/^mail$/, 30]],
      alias: [[/\b(other|secondary|alternate|alt|proxy|alias|aliases)\b.*\b(e ?mail|address|addresses|mail)\b|\bproxy ?addresses\b|\baliases\b/, 40], [/^mail$/, 22]],
      name: [[/\b(display ?name|full ?name)\b/, 40], [/^name$/, 34], [/\bname\b/, 20]],
      first: [[/\b(first|given) ?name\b|^first$|^given$/, 40]],
      last: [[/\b(last|sur|family) ?name\b|^last$|^surname$/, 40]],
      status: [[/\b(status|state|account ?enabled|enabled|suspended|disabled|active|account ?status|user ?status)\b/, 36]],
      changed: [[/\b(status ?changed|deactivated|deprovisioned|suspended (on|at|date)|disabled (on|at|date)|status (date|since)|since)\b/, 40], [/\b(last ?updated|updated|modified|changed)\b/, 18]],
      lastLogin: [[LAST_SEEN, 42]],
    },
    app: {
      email: [[/\be ?mail( address)?\b|\bupn\b|\buser ?principal ?name\b/, 40], [/\b(login|username|user ?name)\b/, 24]],
      name: [[/\b(full ?name|display ?name|real ?name)\b/, 40], [/^(name|user|member|person|owner)$/, 30], [/\bname\b/, 22]],
      first: [[/\b(first|given) ?name\b|^first$/, 40]],
      last: [[/\b(last|sur|family) ?name\b|^last$|^surname$/, 40]],
      role: [[/\b(role|roles|is ?admin|admin|access ?level|permission|permissions|privilege|privileges)\b/, 36], [/\b(user ?type|account ?type|type|seat|seat type|license|licence|plan|level|access)\b/, 30], [/\bstatus\b/, 10]],
      status: [[/\b(status|state|active|enabled|deactivated|disabled|suspended|account ?status)\b/, 32]],
      lastActive: [[LAST_SEEN, 42], [/\b(activity|accessed|last ?(updated|modified))\b/, 18]],
    },
  };

  function headerScore(kind, field, h) {
    var n = headerNorm(h);
    var best = 0;
    ((HEADER_RULES[kind] || {})[field] || []).forEach(function (r) { if (r[0].test(n) && r[1] > best) best = r[1]; });
    if (field === 'name' && /\b(first|last|given|sur|family|user ?name|username|org|group|company|domain|app|team|channel|file)\b/.test(n)) best = Math.min(best, 8);
    if (field === 'email' && /\b(other|secondary|alternate|alt|proxy|alias|aliases|manager|recovery|backup|personal)\b/.test(n)) best = Math.min(best, 10);
    if (field === 'status' && /\b(changed|date|since|updated|time|last|on|at)\b/.test(n)) best = Math.min(best, 8);
    if (field === 'changed' && LAST_SEEN.test(n)) best = 0;
    if ((field === 'first' || field === 'last') && /\b(login|sign|seen|active|updated)\b/.test(n)) best = 0;
    if (field === 'role' && /\b(status|state)\b/.test(n) && !/\b(role|type|admin|level)\b/.test(n)) best = Math.min(best, 10);
    if (field === 'role' && /\b(last|date|time)\b/.test(n)) best = 0;
    if ((field === 'name' || field === 'first' || field === 'last') && NOT_PERSON.test(n)) best = 0;
    if (DATE_FIELDS.indexOf(field) >= 0 && NOT_ACTIVITY.test(n)) best = 0;
    return best;
  }
  // Headers that are never a person's name (a job title is two capitalised
  // words too), and dates that are never a sign-in or a status change.
  var NOT_PERSON = /\b(title|job|position|department|dept|division|team|location|office|role|manager|company|org|organization|group|country|city|cost ?center|employee ?(id|number|no|type)|phone|mobile|type|plan|license|licence)\b/;
  var NOT_ACTIVITY = /\b(created|creation|activated|joined|added|invited|start|starts|started|hire|hired|birth|expir\w*|password)\b/;
  var DATE_FIELDS = ['changed', 'lastLogin', 'lastActive'];
  // Optional fields guessed only from their header: a second address column
  // or a date column with no name to say what it is would be read wrongly.
  var HEADER_ONLY = ['alias', 'changed', 'lastLogin', 'lastActive'];

  var ROLE_WORDS = /^(primary owner|owner|workspace owner|account owner|org owner|organization owner|master admin|company admin|team admin|workspace admin|org admin|super admin|global admin|billing admin|admin|administrator|member|full member|standard|standard user|standard all access|standard limited|limited|basic|licensed|pro|user|viewer|editor|contributor|collaborator|reader|guest|single channel guest|multi channel guest|external|outside collaborator|accountant|reports only|bot|app|integration|service account|deactivated|deactivated user|inactive|suspended|disabled)\b/;
  var STATUS_WORDS = /^(active|inactive|enabled|disabled|deactivated|suspended|deprovisioned|deleted|archived|staged|provisioned|pending|invited|locked|locked out|password expired|recovery|activated|blocked|removed|true|false|yes|no|y|n|1|0|on|off)$/;

  /** What a column's values look like, from a sample. */
  function profile(values) {
    var p = { n: 0, empty: 0, email: 0, date: 0, never: 0, name: 0, words: 0, oneword: 0, role: 0, status: 0, bool: 0, distinct: 0, digits: 0, total: 0 };
    var seen = {};
    var sample = values.length > 400 ? values.slice(0, 400) : values;
    sample.forEach(function (v) {
      v = str(v);
      if (!v) { p.empty++; return; }
      p.n++;
      var low = fold(v).replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!seen[low]) { seen[low] = 1; p.distinct++; }
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || /#ext#@/i.test(v)) p.email++;
      if (readDate(v)) p.date++;
      if (isNever(v)) p.never++;
      if (/^\d{3,}$/.test(v.replace(/[\s-]/g, ''))) p.digits++;
      var w = v.split(/\s+/);
      if (/^[A-Za-z\u00c0-\u024f.'’,\- ]+$/.test(v) && /[A-Za-z\u00c0-\u024f]{2}/.test(v) && w.length <= 4) {
        p.name++;
        if (w.length >= 2 && w.length <= 4) p.words++;
        if (w.length === 1) p.oneword++;
      }
      if (ROLE_WORDS.test(low)) p.role++;
      if (STATUS_WORDS.test(low)) p.status++;
      if (/^(true|false|yes|no|y|n|1|0)$/.test(low)) p.bool++;
    });
    p.total = sample.length;
    return p;
  }
  function frac(p, k) { return p.n ? p[k] / p.n : 0; }
  function fewValues(p) { return p.n >= 3 && p.distinct <= Math.max(2, Math.min(10, p.n / 2)); }

  function shapeScore(kind, field, p) {
    if (!p.n) return { s: 0, gate: true };
    var em = frac(p, 'email'), dt = Math.min(1, frac(p, 'date') + frac(p, 'never'));
    switch (field) {
      case 'email': case 'alias': return { s: em * 30, gate: em < 0.5 };
      case 'name': { var nm = frac(p, 'name') * 16 + frac(p, 'words') * 12 - (fewValues(p) ? 10 : 0); return { s: nm, gate: frac(p, 'name') < 0.5 || em > 0.3 || frac(p, 'role') > 0.5 }; }
      case 'first': case 'last': return { s: frac(p, 'oneword') * 18, gate: frac(p, 'name') < 0.5 || em > 0.3 };
      case 'status': return { s: frac(p, 'status') * 22 + (fewValues(p) ? 6 : 0), gate: frac(p, 'status') < 0.5 };
      case 'role': return { s: frac(p, 'role') * 22 + (fewValues(p) ? 6 : 0), gate: frac(p, 'role') < 0.4 };
      case 'changed': case 'lastLogin': case 'lastActive': return { s: dt * 26, gate: dt < 0.4 };
      default: return { s: 0, gate: true };
    }
  }

  /**
   * The deterministic guess. For every field and column: the header's points
   * plus the values' points (a header over values that do not fit counts for
   * a third). Then greedily, best pair first, each column used once. Returns
   * {map: {field: column index or -1}, sure: {field: 'sure'|'likely'|'unsure'},
   * unsure: bool}.
   */
  function guessColumns(kind, headers, rows, headerless) {
    var profiles = headers.map(function (_, i) { return profile(rows.map(function (r) { return r[i]; })); });
    var pairs = [];
    fieldKeys(kind).forEach(function (f) {
      headers.forEach(function (h, c) {
        var hs = headerScore(kind, f, h);
        var sh = shapeScore(kind, f, profiles[c]);
        // "Is admin: true / false" is a role column, though no value is a role word.
        if (f === 'role' && /\badmin/.test(headerNorm(h)) && frac(profiles[c], 'bool') > 0.8) sh = { s: 20, gate: false };
        var total = (sh.gate ? hs * 0.3 : hs) + sh.s;
        if (!headerless && !hs && (HEADER_ONLY.indexOf(f) >= 0 || ((f === 'name' || f === 'first' || f === 'last') && NOT_PERSON.test(headerNorm(h))))) total = 0;
        pairs.push({ f: f, c: c, total: total, hs: hs, ss: sh.s, gate: sh.gate });
      });
    });
    pairs.sort(function (a, b) { return b.total - a.total || a.c - b.c; });
    var map = {}, sure = {}, used = {};
    fieldKeys(kind).forEach(function (f) { map[f] = -1; sure[f] = 'unsure'; });
    pairs.forEach(function (x) {
      if (map[x.f] >= 0 || used[x.c] || x.total < 22) return;
      map[x.f] = x.c; used[x.c] = 1;
      sure[x.f] = x.hs >= 26 && !x.gate && x.ss >= 10 ? 'sure' : x.total >= 40 ? 'likely' : 'unsure';
    });
    // A display name makes first and last redundant: keep them only as a fallback.
    var unsure = kind === 'idp' ? (map.email < 0 || sure.email === 'unsure') : (map.email < 0 && map.name < 0 && map.last < 0) || (map.email >= 0 && sure.email === 'unsure');
    return { map: map, sure: sure, unsure: unsure };
  }

  /** What is still missing before the finder can run, in words. */
  function mappingProblems(kind, map) {
    var out = [];
    if (kind === 'idp' && !(map.email >= 0)) out.push('Choose the email or sign-in name column.');
    if (kind === 'app' && !(map.email >= 0) && !(map.name >= 0) && !(map.last >= 0)) out.push('Choose the email column (or at least a name column) - there is nothing to match on otherwise.');
    var seen = {};
    Object.keys(map).forEach(function (k) { var c = map[k]; if (c >= 0) { if (seen[c]) out.push('One column is chosen for two fields.'); seen[c] = 1; } });
    return out;
  }

  /** Which identity provider an export most likely came from, by its headers. */
  var IDPS = { okta: 'Okta', entra: 'Entra ID', google: 'Google Workspace', jumpcloud: 'JumpCloud', other: 'the identity provider' };
  function guessIdp(headers) {
    var h = headers.map(headerNorm).join('|');
    if (/user principal name|account enabled|on premises|user type|creation type/.test(h)) return 'entra';
    if (/\brequired\b|\bread only\b|org unit path/.test(h)) return 'google';
    if (/\bactivated\b|account locked|jumpcloud|\bsuspended\b/.test(h) && /\bfirstname\b|\blastname\b|\bfirst name\b/.test(h)) return 'jumpcloud';
    if (/primary email|status changed|\bokta\b|\blogin\b/.test(h)) return 'okta';
    return 'other';
  }
  function idpName(key) { return IDPS[key] || IDPS.other; }

  /** A file's name made into an app's name: "slack-members-2026-11-01.csv" -> "Slack". */
  function appNameFrom(fileName, n) {
    var s = str(fileName).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_\-.]+/g, ' ');
    s = s.replace(/\b(users?|members?|export(ed)?|list|accounts?|report|all|active|seats?|people|directory|members list|user list|csv|data|download|full|admin|admins)\b/gi, ' ').replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
    s = line(s, 30);
    if (/^[a-z]{2,3}$/i.test(s)) return s.toUpperCase();   // crm -> CRM, hr -> HR
    return s ? (s === s.toLowerCase() ? titleCase(s) : s) : 'App ' + (n || 1);
  }

  /* ================================================================== *
   * Addresses and names
   * ================================================================== */

  var HOST = /^(?=.{3,80}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
  function domainOf(email) { var s = str(email); var i = s.lastIndexOf('@'); return i < 0 ? '' : s.slice(i + 1); }
  function localOf(email) { var s = str(email); var i = s.lastIndexOf('@'); return i < 0 ? s : s.slice(0, i); }

  /** The domain alias map: every company domain points at the first. */
  function aliasMap(domains) {
    var m = {};
    (domains || []).forEach(function (d) { if (domains[0]) m[d] = domains[0]; });
    return m;
  }

  /**
   * An address as it is compared, and how it got there: lower case, a
   * "Name <a@b>" wrapper or "mailto:" dropped, an Entra guest UPN
   * (jo_partner.example#EXT#@tenant.onmicrosoft.com) read as the guest's own
   * address, plus-addressing (a+files@) dropped, and a company alias domain
   * swapped for the primary one. Returns {key, plus, alias, guest, cased} or
   * null when it is not an address.
   */
  function normEmail(raw, aliases) {
    var s0 = line(raw, 200);
    var s = s0;
    var w = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
    if (w) s = w[1];
    s = s.replace(/^mailto:/i, '').replace(/^smtp:/i, '').trim();
    var out = { key: '', plus: false, alias: '', guest: false, cased: false };
    if (/[A-Z]/.test(s)) out.cased = true;
    s = s.toLowerCase();
    var g = /^(.+)_([a-z0-9.-]+\.[a-z]{2,24})#ext#@/.exec(s);
    if (g) { s = g[1] + '@' + g[2]; out.guest = true; }
    var at = s.lastIndexOf('@');
    if (at < 1 || at === s.length - 1 || /\s/.test(s)) return null;
    var local = s.slice(0, at), dom = s.slice(at + 1);
    if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/.test(dom)) return null;
    if (local.indexOf('+') > 0) { local = local.slice(0, local.indexOf('+')); out.plus = true; }
    var a = aliases && has(aliases, dom) ? aliases[dom] : dom;
    if (a !== dom) out.alias = dom;
    out.key = local + '@' + a;
    return out;
  }

  var HONORIFICS = /^(mr|mrs|ms|miss|mx|dr|prof|rev|sir|dame)$/;
  var SUFFIXES = /^(jr|jnr|sr|snr|ii|iii|iv|md|phd|dds|dmd|rdh|cpa|rn|esq)$/;
  /** A name folded for comparing: accents, case, punctuation, honorifics and
   *  the order of its words ("Reyes, Jordan" = "Jordan Reyes" = "Dr. jordan
   *  reyes"). '' for anything with fewer than two words. */
  function nameKey(raw) {
    var s = fold(line(raw, 120));
    if (/,/.test(s)) { var parts = s.split(','); if (parts.length === 2) s = parts[1] + ' ' + parts[0]; }
    var toks = s.replace(/['’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(function (t) { return t && !HONORIFICS.test(t) && !SUFFIXES.test(t); });
    if (toks.length < 2) return '';
    return toks.sort().join(' ');
  }
  function nameOf(row, map) {
    var full = map.name >= 0 ? line(row[map.name], LIMITS.fieldChars) : '';
    if (full) return full;
    var f = map.first >= 0 ? line(row[map.first], 40) : '', l = map.last >= 0 ? line(row[map.last], 40) : '';
    return line((f + ' ' + l).trim(), LIMITS.fieldChars);
  }

  /** IdP status from a cell: 'active', 'pending', 'suspended',
   *  'deprovisioned', or 'unknown'. A yes/no column reads by its header:
   *  "Account enabled: False" is suspended, "Suspended: true" too. */
  function idpStatus(v, header) {
    var s = fold(line(v, 60)).replace(/[_\-]+/g, ' ').trim();
    if (!s) return 'unknown';
    var hn = headerNorm(header);
    if (/^(true|false|yes|no|y|n|1|0|on|off)$/.test(s)) {
      var yes = /^(true|yes|y|1|on)$/.test(s);
      if (/suspend|disabl|block|lock|inactive|deactivat|archiv|delet/.test(hn)) return yes ? 'suspended' : 'active';
      return yes ? 'active' : 'suspended';
    }
    if (/deprovision|deleted|removed|terminated|archived|offboard/.test(s)) return 'deprovisioned';
    if (/suspend|disabled|deactivat|blocked|inactive/.test(s)) return 'suspended';
    if (/staged|provisioned|pending|invited|not activated/.test(s)) return 'pending';
    if (/active|enabled|activated|locked|expired|recovery|normal|ok/.test(s)) return 'active';
    return 'unknown';
  }

  /** An app account's role, read from its role, status and type cells:
   *  {level: 'owner'|'admin'|'member'|'guest', off, service, text}. */
  function appRole(roleText, statusText, roleHeader) {
    var r = fold(line(roleText, 80)).replace(/[_\-]+/g, ' ').trim(), st = fold(line(statusText, 60)).replace(/[_\-]+/g, ' ').trim();
    var out = { level: 'member', off: false, service: false, text: line(roleText, 60) };
    var both = r + ' | ' + st;
    if (/\b(deactivated|disabled|suspended|inactive|removed|deleted|revoked|archived|deprovisioned)\b/.test(both) || /^(false|no|n|0|off)$/.test(st)) out.off = true;
    if (/\b(bot|integration|service account|app user|api user|system user|workflow|automation)\b/.test(r) || r === 'app') out.service = true;
    if (/^(true|false|yes|no|y|n|1|0)$/.test(r) && /admin/.test(headerNorm(roleHeader))) { if (/^(true|yes|y|1)$/.test(r)) { out.level = 'admin'; out.text = 'Admin'; } else out.text = ''; }
    else if (/\b(owner|master admin|super ?admin|global admin)\b/.test(r)) out.level = 'owner';
    else if (/\b(admin|administrator)\b/.test(r)) out.level = 'admin';
    else if (/\b(guest|external|outside collaborator|contractor|partner)\b/.test(r)) out.level = 'guest';
    return out;
  }
  function elevated(level) { return level === 'owner' || level === 'admin'; }

  /* ================================================================== *
   * Shared and service accounts
   * ================================================================== */

  var DEFAULT_PATTERNS = ['svc-*', 'svc_*', 'service-*', '*-svc', '*-bot', 'bot-*', 'integration*', 'api-*', 'system*', 'admin', 'administrator', 'support', 'help', 'helpdesk', 'info', 'office', 'reception', 'frontdesk', 'front-desk', 'hello', 'contact', 'billing', 'accounts', 'accounting', 'ap', 'ar', 'payroll', 'hr', 'sales', 'orders', 'noreply', 'no-reply', 'donotreply', 'it', 'ops', 'team', 'shared', 'scanner', 'printer', 'fax', 'postmaster', 'webmaster', 'root', 'test', 'demo', 'training'];

  /** Does a pattern fit an address's local part? A word fits the whole local
   *  part, or (four letters or more) one of its dot, dash or underscore
   *  separated pieces; "*" is any run of characters. */
  function patternFits(pattern, local) {
    var p = str(pattern).toLowerCase();
    if (!p || !local) return false;
    if (p.indexOf('*') >= 0) {
      var re = new RegExp('^' + p.split('*').map(function (x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('.*') + '$');
      return re.test(local);
    }
    if (p === local) return true;
    if (p.length < 4) return false;
    return local.split(/[._-]+/).indexOf(p) >= 0;
  }
  /** Why an account looks shared or automated, or ''. */
  function sharedWhy(email, name, role, patterns) {
    if (role && role.service) return 'a bot or integration account';
    var local = email ? localOf(email).split('+')[0] : '';
    var list = patterns && patterns.length ? patterns : DEFAULT_PATTERNS;
    for (var i = 0; i < list.length; i++) if (patternFits(list[i], local)) return 'the address matches “' + list[i] + '”';
    if (/\b(bot|integration|service account|shared|front desk|reception|scanner|printer|mailbox|do not reply|no reply)\b/i.test(str(name))) return 'the name says it is shared';
    return '';
  }

  /* ================================================================== *
   * Building the tables from a mapped file
   * ================================================================== */

  /** The identity provider's users from its mapped table. */
  function buildIdp(table, map, aliases) {
    var users = [], skipped = [];
    var col = function (k) { return map[k] >= 0 ? table.rows.map(function (r) { return r[map[k]]; }) : []; };
    var ordC = dateOrder(col('changed')), ordL = dateOrder(col('lastLogin'));
    var statusHeader = map.status >= 0 ? table.headers[map.status] : '';
    table.rows.forEach(function (r, i) {
      var e = normEmail(r[map.email], aliases);
      if (!e) { if (skipped.length < 200) skipped.push({ line: i + 2, why: 'no address in the sign-in column' }); return; }
      var alts = [];
      if (map.alias >= 0) str(r[map.alias]).split(/[;,\s]+/).forEach(function (x) { var a = normEmail(x, aliases); if (a && a.key !== e.key && alts.indexOf(a.key) < 0 && alts.length < 8) alts.push(a.key); });
      var st = map.status >= 0 ? idpStatus(r[map.status], statusHeader) : 'active';
      users.push({
        i: users.length, email: e.key, raw: line(r[map.email], 120), alts: alts, name: nameOf(r, map),
        status: st, statusText: map.status >= 0 ? line(r[map.status], 30) : '',
        changed: map.changed >= 0 ? readDate(r[map.changed], ordC, true) : null,
        lastLogin: map.lastLogin >= 0 ? readDate(r[map.lastLogin], ordL, true) : null,
        never: map.lastLogin >= 0 ? isNever(r[map.lastLogin]) : false,
      });
    });
    return { users: users, skipped: skipped };
  }

  /** One app's accounts from its mapped table. */
  function buildApp(table, map, aliases) {
    var accounts = [], skipped = [];
    var ord = dateOrder(map.lastActive >= 0 ? table.rows.map(function (r) { return r[map.lastActive]; }) : []);
    var roleHeader = map.role >= 0 ? table.headers[map.role] : '';
    table.rows.forEach(function (r, i) {
      var rawEmail = map.email >= 0 ? line(r[map.email], 120) : '';
      var e = rawEmail ? normEmail(rawEmail, aliases) : null;
      var name = nameOf(r, map);
      if (!e && !nameKey(name)) { if (skipped.length < 200) skipped.push({ line: i + 2, why: rawEmail ? 'not an address, and no full name' : 'no address or full name' }); return; }
      var role = appRole(map.role >= 0 ? r[map.role] : '', map.status >= 0 ? r[map.status] : '', roleHeader);
      accounts.push({
        line: i + 2, email: e ? e.key : '', raw: rawEmail, how: e, name: name, role: role,
        lastActive: map.lastActive >= 0 ? readDate(r[map.lastActive], ord, true) : null,
        never: map.lastActive >= 0 ? isNever(r[map.lastActive]) : false,
      });
    });
    return { accounts: accounts, skipped: skipped };
  }

  /** The company's domains: the settings' list, or - when it is empty - the
   *  domains that hold at least 2 of the identity provider's users (and 5%
   *  of them), Entra guests left out. */
  function companyDomains(settings, users) {
    var set = (settings && settings.domains) || [];
    if (set.length) return { list: set.slice(), inferred: false };
    var count = {}, n = 0;
    (users || []).forEach(function (u) { var d = domainOf(u.email); if (!d) return; count[d] = (count[d] || 0) + 1; n++; });
    var list = Object.keys(count).filter(function (d) { return count[d] >= 2 && count[d] >= n * 0.05; }).sort(function (a, b) { return count[b] - count[a] || (a < b ? -1 : 1); });
    return { list: list.slice(0, LIMITS.domains), inferred: true };
  }

  /* ================================================================== *
   * The orphan finder
   * ================================================================== */

  var VERDICTS = ['orphan', 'suspended', 'external', 'shared', 'dormant', 'off', 'ok'];
  var VERDICT_WORD = { orphan: 'Orphan', suspended: 'Suspended in IdP, active here', external: 'External', shared: 'Shared / service', dormant: 'Dormant', off: 'Already off', ok: 'OK' };
  var VERDICT_ICON = { orphan: '✗', suspended: '!', external: '↗', shared: '⇄', dormant: '…', off: '–', ok: '✓' };
  var RANK = { orphan: 1, suspended: 1, external: 3, shared: 4, dormant: 5, off: 6, ok: 7 };
  var LEVEL_WORD = { owner: 'owner', admin: 'admin', member: 'member', guest: 'guest' };

  function isOrphaned(v) { return v === 'orphan' || v === 'suspended'; }

  /** The finder's verdict on one app account. Pure: the account, the user it
   *  matched (or null) and how, the settings and today. */
  function judge(acc, user, how, ctx) {
    var s = ctx.settings || {}, today = ctx.today, idp = idpName(ctx.idp);
    var dom = acc.email ? domainOf(acc.email) : '';
    var company = ctx.domains.indexOf(dom) >= 0;
    var out = { verdict: 'ok', why: '', critical: false, leftDays: null, idleDays: null, sharedWhy: '' };
    out.idleDays = acc.lastActive && today ? Math.max(0, daysBetween(acc.lastActive, today)) : null;
    if (acc.role.off) { out.verdict = 'off'; out.why = 'Already deactivated here.'; return out; }
    var sw = sharedWhy(acc.email, acc.name, acc.role, s.patterns);
    if (sw) {
      out.verdict = 'shared'; out.sharedWhy = sw;
      out.why = 'Looks shared or automated (' + sw + '). Rotate its password whenever someone who knew it leaves.';
      return out;
    }
    var role = elevated(acc.role.level) ? ' as ' + (acc.role.text || LEVEL_WORD[acc.role.level]) : '';
    if (user && (user.status === 'suspended' || user.status === 'deprovisioned')) {
      var since = user.changed || null;
      out.leftDays = since && today ? Math.max(0, daysBetween(since, today)) : (user.lastLogin && today ? Math.max(0, daysBetween(user.lastLogin, today)) : null);
      out.leftFrom = since ? 'changed' : (user.lastLogin ? 'login' : '');
      out.verdict = user.status === 'suspended' ? 'suspended' : 'orphan';
      var yr = today ? today.slice(0, 4) : '';
      var when = since ? ' since ' + shortDay(since, yr) + (out.leftDays !== null ? ' (' + plural(out.leftDays, 'day') + ')' : '') : (user.lastLogin ? ' - last signed in ' + shortDay(user.lastLogin, yr) : '');
      out.why = cap1(user.status) + ' in ' + idp + when + ' - still active here' + role + '.';
    } else if (!user) {
      if (dom && !company) {
        out.verdict = 'external';
        out.why = 'Another domain (' + dom + ') and not in ' + idp + ' - a guest, contractor or outside firm. Check they still need it.';
      } else {
        out.verdict = 'orphan';
        out.why = 'No user in ' + idp + ' with this ' + (acc.email ? 'address' : 'name') + ' - they left and were deleted there, or were never added. Still active here' + role + '.';
      }
    } else if (dom && !company && !how.byName) {
      out.verdict = 'external';
      out.why = 'Another domain (' + dom + '), though ' + idp + ' has them as ' + user.status + '. Check they still need it.';
    } else {
      var limit = s.dormantDays || DEFAULT_SETTINGS.dormantDays;
      if ((out.idleDays !== null && out.idleDays >= limit) || (acc.never && !acc.lastActive)) {
        out.verdict = 'dormant';
        out.why = (acc.never && !acc.lastActive ? 'Never signed in here' : 'No activity here in ' + plural(out.idleDays, 'day')) + ' (your limit is ' + limit + ') - reclaim the licence if they do not need it.';
      } else {
        out.why = 'Active in ' + idp + '.';
      }
    }
    out.critical = isOrphaned(out.verdict) && elevated(acc.role.level);
    return out;
  }

  function howWords(how) {
    if (!how) return '';
    if (how.byName) return 'matched by name - check';
    var bits = [];
    if (how.plus) bits.push('the +tag ignored');
    if (how.alias) bits.push('through the alias ' + how.alias);
    if (how.guest) bits.push('read from a guest address');
    if (how.alt) bits.push('by their other address');
    return bits.length ? 'matched ' + bits.join(', ') : '';
  }

  /**
   * Every app account judged against the identity provider's users.
   *   o = {users, apps: [{id, name, accounts}], settings, today, idp, domains}
   * Returns {rows (all, sorted), summary, people, apps}.
   */
  function findOrphans(o) {
    var users = o.users || [];
    var byEmail = {}, byName = {};
    users.forEach(function (u) {
      if (!has(byEmail, u.email)) byEmail[u.email] = u;
      u.alts.forEach(function (a) { if (!has(byEmail, a)) byEmail[a] = u; });
      var k = nameKey(u.name);
      if (k) (byName[k] = byName[k] || []).push(u);
    });
    var ctx = { settings: o.settings || {}, today: o.today, idp: o.idp, domains: o.domains || [] };
    var rows = [];
    (o.apps || []).forEach(function (app) {
      app.accounts.forEach(function (acc) {
        var user = null, how = { plus: false, alias: '', guest: false, alt: false, byName: false };
        if (acc.email && has(byEmail, acc.email)) {
          user = byEmail[acc.email];
          how.plus = acc.how.plus; how.alias = acc.how.alias; how.guest = acc.how.guest; how.alt = user.email !== acc.email;
        } else {
          var k = nameKey(acc.name);
          var cands = k && has(byName, k) ? byName[k] : [];
          if (cands.length === 1) { user = cands[0]; how.byName = true; }
        }
        var j = judge(acc, user, how, ctx);
        rows.push({
          app: app.id, appName: app.name, line: acc.line, email: acc.raw || acc.email, key: acc.email, name: acc.name || (user ? user.name : ''),
          role: acc.role.text, level: acc.role.level, lastActive: acc.lastActive, never: acc.never,
          user: user ? { i: user.i, email: user.raw || user.email, key: user.email, name: user.name, status: user.status, changed: user.changed, lastLogin: user.lastLogin } : null,
          how: howWords(how), byName: how.byName,
          verdict: j.verdict, why: j.why, critical: j.critical, leftDays: j.leftDays, idleDays: j.idleDays, sharedWhy: j.sharedWhy,
        });
      });
    });
    rows.sort(compareRows);
    return { rows: rows, summary: summarise(rows), people: peopleOf(rows, o.idp), apps: (o.apps || []).map(function (a) { return appStats(a, rows); }) };
  }
  function compareRows(a, b) {
    if (a.critical !== b.critical) return a.critical ? -1 : 1;
    if (RANK[a.verdict] !== RANK[b.verdict]) return RANK[a.verdict] - RANK[b.verdict];
    var la = a.leftDays === null ? -1 : a.leftDays, lb = b.leftDays === null ? -1 : b.leftDays;
    if (la !== lb) return lb - la;
    if (a.verdict === 'dormant' && a.idleDays !== b.idleDays) return (b.idleDays || 0) - (a.idleDays || 0);
    var n = fold(a.name || a.email) < fold(b.name || b.email) ? -1 : fold(a.name || a.email) > fold(b.name || b.email) ? 1 : 0;
    return n || (a.appName < b.appName ? -1 : a.appName > b.appName ? 1 : 0);
  }
  function appStats(app, rows) {
    var c = { total: 0 };
    VERDICTS.forEach(function (v) { c[v] = 0; });
    rows.forEach(function (r) { if (r.app === app.id) { c.total++; c[r.verdict]++; } });
    return { id: app.id, name: app.name, counts: c };
  }

  /** The headline: "7 orphaned accounts in 4 apps · 2 are admins · oldest
   *  leaver: 94 days", as numbers. */
  function summarise(rows) {
    var c = { total: rows.length, critical: 0 };
    VERDICTS.forEach(function (v) { c[v] = 0; });
    var apps = {}, admins = 0, oldest = null, oldestName = '';
    rows.forEach(function (r) {
      c[r.verdict]++;
      if (r.critical) c.critical++;
      if (!isOrphaned(r.verdict)) return;
      apps[r.app] = 1;
      if (elevated(r.level)) admins++;
      if (r.leftDays !== null && (oldest === null || r.leftDays > oldest)) { oldest = r.leftDays; oldestName = r.name; }
    });
    return { counts: c, orphaned: c.orphan + c.suspended, apps: Object.keys(apps).length, admins: admins, oldest: oldest, oldestName: oldestName };
  }
  function summaryLine(s) {
    if (!s.orphaned) return 'No orphaned accounts' + (s.counts.total ? ' in ' + plural(s.counts.total, 'account') : '');
    var parts = [plural(s.orphaned, 'orphaned account') + ' in ' + plural(s.apps, 'app')];
    parts.push(s.admins ? plural(s.admins, 'is an admin', 'are admins') : 'none are admins');
    if (s.oldest !== null) parts.push('oldest leaver: ' + plural(s.oldest, 'day'));
    return parts.join(' · ');
  }

  /** People with something to act on, each with every account found for
   *  them: leavers still holding access first (critical first, then the
   *  longest gone), then outside accounts, then dormant ones. */
  function peopleOf(rows, idp) {
    var map = {}, order = [];
    rows.forEach(function (r) {
      if (r.verdict === 'shared') return;
      var k = r.user ? 'u:' + r.user.key : r.key ? 'e:' + r.key : 'n:' + nameKey(r.name);
      if (!has(map, k)) { map[k] = { key: k, name: r.user ? (r.user.name || r.name) : r.name, email: r.user ? r.user.email : r.email, user: r.user, accounts: [], critical: false, worst: 'ok', leftDays: null }; order.push(k); }
      var p = map[k];
      p.accounts.push({ app: r.app, appName: r.appName, verdict: r.verdict, level: r.level, role: r.role, lastActive: r.lastActive, idleDays: r.idleDays, byName: r.byName, email: r.email });
      if (r.critical) p.critical = true;
      if (RANK[r.verdict] < RANK[p.worst]) p.worst = r.verdict;
      if (r.leftDays !== null && (p.leftDays === null || r.leftDays > p.leftDays)) p.leftDays = r.leftDays;
    });
    var people = order.map(function (k) { return map[k]; }).filter(function (p) { return p.worst !== 'ok' && p.worst !== 'off'; });
    people.forEach(function (p) { p.line = personLine(p, idp); p.group = isOrphaned(p.worst) ? 'leaver' : p.worst; });
    people.sort(function (a, b) {
      if (a.critical !== b.critical) return a.critical ? -1 : 1;
      if (RANK[a.worst] !== RANK[b.worst]) return RANK[a.worst] - RANK[b.worst];
      var la = a.leftDays === null ? -1 : a.leftDays, lb = b.leftDays === null ? -1 : b.leftDays;
      if (la !== lb) return lb - la;
      return fold(a.name) < fold(b.name) ? -1 : 1;
    });
    return people;
  }
  /** "Jordan Reyes: suspended in Okta since Aug 1 - still active in
   *  Accounting (admin), File share, Video meetings". */
  function personLine(p, idp) {
    var who = p.name || p.email || 'Someone';
    var name = idpName(idp), u = p.user;
    var state;
    if (!u) state = 'not in ' + name;
    else if (u.status === 'suspended' || u.status === 'deprovisioned') state = u.status + ' in ' + name + (u.changed ? ' since ' + shortDay(u.changed) : '');
    else state = (u.status === 'pending' ? 'pending' : 'active') + ' in ' + name;
    var leaver = isOrphaned(p.worst);
    // A leaver's every live account counts; for anyone else, only the ones
    // with the same finding (a dormant video account, not the chat one in use).
    var live = p.accounts.filter(function (a) { return a.verdict !== 'off' && (leaver || a.verdict === p.worst); }).map(function (a) { return a.appName + (elevated(a.level) ? ' (' + LEVEL_WORD[a.level] + ')' : ''); });
    var off = p.accounts.filter(function (a) { return a.verdict === 'off'; }).map(function (a) { return a.appName; });
    var what = leaver ? 'still active in ' : p.worst === 'external' ? 'outside account in ' : 'dormant in ';
    var s = who + ': ' + state + ' - ' + what + (live.length ? live.join(', ') : 'nothing');
    if (off.length) s += ' · already off in ' + off.join(', ');
    return s;
  }

  /** Every account for one person (a leaver), by address or name. */
  function accountsFor(rows, email, name, aliases) {
    var e = email ? normEmail(email, aliases) : null, k = nameKey(name);
    return rows.filter(function (r) {
      if (e && (r.key === e.key || (r.user && r.user.key === e.key))) return true;
      if (k && (nameKey(r.name) === k || (r.user && nameKey(r.user.name) === k))) return true;
      return false;
    });
  }

  /* ================================================================== *
   * The leaver checklist
   * ================================================================== */

  var STEPS = {
    disable: { label: 'Disable or remove the account', short: 'Disable account', vol: 'moment', invol: 'moment' },
    sessions: { label: 'End live sessions - sign them out everywhere', short: 'End sessions', vol: 'moment', invol: 'moment' },
    tokens: { label: 'Revoke API tokens, app passwords and connected apps', short: 'Revoke tokens', vol: 'moment', invol: 'moment' },
    mfa: { label: 'Remove their MFA devices and recovery options', short: 'Remove MFA', vol: 'moment', invol: 'moment' },
    admin: { label: 'Hand over their admin and owner roles', short: 'Hand over admin', vol: 'before', invol: 'moment' },
    files: { label: 'Transfer file ownership', short: 'Transfer files', vol: 'before', invol: 'day1' },
    mailbox: { label: 'Convert the mailbox to shared, or forward it', short: 'Mailbox', vol: 'day1', invol: 'day1' },
    rotate: { label: 'Rotate shared passwords and codes they knew', short: 'Rotate codes', vol: 'day1', invol: 'moment' },
    devices: { label: 'Lock or wipe their devices', short: 'Wipe devices', vol: 'moment', invol: 'moment' },
    hardware: { label: 'Collect their hardware', short: 'Collect hardware', vol: 'moment', invol: 'moment' },
    licence: { label: 'Reclaim the licence', short: 'Reclaim licence', vol: 'day30', invol: 'day30' },
  };
  var STEP_KEYS = Object.keys(STEPS);
  var PHASES = ['before', 'moment', 'day1', 'day30'];
  var PHASE_WORD = { before: 'Before the last day', moment: 'At the moment they leave', day1: 'Within 24 hours', day30: 'Within 30 days' };
  var PHASE_WORD_INVOL = { before: 'Before notice is given', moment: 'At the moment of notice', day1: 'Within 24 hours', day30: 'Within 30 days' };
  var OWNERS = { msp: 'MSP / IT provider', it: 'IT', office: 'Office manager', manager: 'Their manager', hr: 'HR', finance: 'Finance', appadmin: 'The app’s admin', facilities: 'Facilities' };
  var OWNER_KEYS = Object.keys(OWNERS);
  var MAILBOX = { shared: 'Shared mailbox', forward: 'Forward it', keep: 'Keep as is', delete: 'Delete it' };
  var HARDWARE = ['laptop', 'desktop', 'phone', 'tablet', 'monitor', 'headset', 'keys', 'key fob', 'badge', 'company card', 'car', 'parking pass'];

  function slug(s) { return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'x'; }
  function phaseOf(key, invol) { var s = STEPS[key]; return s ? (invol ? s.invol : s.vol) : 'moment'; }
  function phaseWord(phase, invol) { return (invol ? PHASE_WORD_INVOL : PHASE_WORD)[phase] || phase; }

  /** When a phase is due: {day, time ('' = by the end of that day)}. */
  function dueOf(phase, lv) {
    if (!isDay(lv.lastDay)) return null;
    var t = isTime(lv.lastTime) ? lv.lastTime : (lv.involuntary ? '09:00' : '17:00');
    if (phase === 'before') return { day: prevWorkday(lv.lastDay), time: '' };
    if (phase === 'moment') return { day: lv.lastDay, time: t };
    if (phase === 'day1') return { day: addDays(lv.lastDay, 1), time: t };
    return { day: addDays(lv.lastDay, 30), time: '' };
  }
  function dueKey(d) { return d ? d.day + 'T' + (d.time || '23:59') : ''; }
  function isOverdue(task, now) { return Boolean(!task.done && task.due && now && dueKey(task.due) < now.day + 'T' + (now.time || '00:00')); }

  function hardwareWords(list) { return (list || []).length ? list.join(', ') : 'laptop, phone, keys, badge - whatever they have'; }
  function person(v, fallback) { return line(v, LIMITS.fieldChars) || fallback; }

  /** The detail line under a step, from the leaver's fields and the system. */
  function stepDetail(key, sys, lv) {
    var sso = sys && sys.sso;
    switch (key) {
      case 'disable': return sso ? 'Single sign-on stops new sign-ins; check there is no local login or password left here.' : 'Not on single sign-on - the identity provider does not reach this account.';
      case 'sessions': return sso ? 'Suspending them in the identity provider does not end sessions already open here.' : 'Sessions already open keep working until they are ended.';
      case 'tokens': return 'Tokens, app passwords and connected apps keep working after the account is suspended.';
      case 'mfa': return 'So the old phone or key cannot be used to recover the account.';
      case 'admin': return 'Give their admin or owner role to someone staying - before the account goes.';
      case 'files': return lv.filesTo ? 'Give ownership to ' + person(lv.filesTo) + '.' : 'Decide who takes over their files.';
      case 'mailbox':
        if (lv.mailbox === 'shared') return 'Convert to a shared mailbox' + (lv.mailTo ? ' and give ' + person(lv.mailTo) + ' access.' : ' and decide who reads it.');
        if (lv.mailbox === 'forward') return 'Forward their mail' + (lv.mailTo ? ' to ' + person(lv.mailTo) + '.' : ' - decide to whom.');
        if (lv.mailbox === 'keep') return 'Keep the mailbox as it is for now' + (lv.mailTo ? ', for ' + person(lv.mailTo) : '') + '.';
        if (lv.mailbox === 'delete') return 'Export what must be kept, then delete it.';
        return 'Decide: a shared mailbox, forwarding, or delete it.';
      case 'rotate': return 'Any shared login, Wi-Fi, door or alarm code they knew.';
      case 'devices': return 'Lock or wipe their laptop and phone, and remove them from device management.';
      case 'hardware': return hardwareWords(lv.hardware) + '.';
      case 'licence': return 'Once the mailbox and files are handled.';
      default: return '';
    }
  }

  function generalTasks(lv) {
    var inv = lv.involuntary === true;
    var out = [];
    var g = function (id, phase, title, detail, owner) { out.push({ id: 'g-' + id, phase: phase, system: '', key: 'general', title: title, detail: detail, owner: owner }); };
    if (inv) g('schedule', 'before', 'Line up every step below for the moment notice is given', 'Change nothing early - and keep the plan to the people doing it.', 'manager');
    else g('confirm', 'before', 'Confirm the last day and when access ends', 'With their manager' + (lv.manager ? ' (' + person(lv.manager) + ')' : '') + '.', 'manager');
    g('handover', 'before', 'Agree who takes over their files and mail', 'Files: ' + person(lv.filesTo, 'not decided yet') + ' · Mail: ' + person(lv.mailTo, 'not decided yet') + '.', 'manager');
    if (!inv) g('shared', 'before', 'Ask which shared passwords and codes they know', 'So the right ones are changed - Wi-Fi, door, alarm, shared logins.', 'manager');
    g('collect', 'moment', 'Collect their hardware', hardwareWords(lv.hardware) + '.', 'manager');
    if (lv.mailbox !== 'delete') g('autoreply', 'day1', 'Set an auto-reply saying who to contact instead', 'On their mailbox, so nobody writes into silence.', 'msp');
    g('tell', 'day1', 'Tell the team' + (inv ? '' : ', and anyone they worked with,') + ' who to contact now', 'One line is enough.', 'manager');
    g('recheck', 'day30', 'Run the orphan finder again - nothing of theirs still active', 'Load fresh exports and check their name is gone.', 'msp');
    g('retention', 'day30', 'Decide how long to keep their mailbox and files, then remove the account for good', 'Follow your retention rules.', 'it');
    return out;
  }

  /** The system a found account belongs to: same name, case and spacing
   *  folded, or one name containing the other. */
  function systemFor(inventory, appName) {
    var a = fold(appName).replace(/[^a-z0-9]/g, '');
    if (!a) return null;
    var hit = null;
    (inventory.systems || []).forEach(function (s) {
      var b = fold(s.name).replace(/[^a-z0-9]/g, '');
      if (!hit && b && (a === b || (a.length >= 4 && b.indexOf(a) >= 0) || (b.length >= 4 && a.indexOf(b) >= 0))) hit = s;
    });
    return hit;
  }

  /**
   * A leaver's checklist: general steps, then each system's steps from the
   * inventory, and each app the orphan finder found them in pre-filled (an
   * app missing from the inventory is added as a local-account system). A
   * system whose export was loaded but did not have them says so - the
   * evidence for ticking it. Within a phase: general steps first, then the
   * systems in the inventory's order, each system's steps together. Ids are
   * stable, so a rebuild after an edit keeps every tick (mergeTasks).
   *   lv: the leaver's fields; inventory: {systems}; found: accountsFor rows;
   *   checked: the names of the app exports that were loaded.
   */
  function buildChecklist(lv, inventory, found, checked) {
    var inv = lv.involuntary === true;
    var tasks = generalTasks(lv);
    var systems = (inventory && inventory.systems ? inventory.systems : []).map(function (s) { return { id: s.id || slug(s.name), name: s.name, sso: Boolean(s.sso), steps: (s.steps || []).slice(), owner: s.owner || 'it', found: [] }; });
    (found || []).forEach(function (r) {
      var sys = systemFor({ systems: systems }, r.appName);
      if (!sys) {
        sys = { id: 'found-' + slug(r.appName), name: r.appName, sso: false, steps: ['disable', 'sessions', 'licence'], owner: 'it', found: [], added: true };
        systems.push(sys);
      }
      sys.found.push(r);
      if (elevated(r.level) && r.verdict !== 'off' && sys.steps.indexOf('admin') < 0) sys.steps.unshift('admin');
    });
    var hasHardware = false;
    var looked = (checked || []).map(function (n) { return line(n, 40); }).filter(Boolean);
    systems.forEach(function (sys, si) {
      var missed = !sys.found.length ? looked.filter(function (n) { return systemFor({ systems: [sys] }, n); })[0] : '';
      STEP_KEYS.forEach(function (key) {
        if (sys.steps.indexOf(key) < 0) return;
        if (key === 'hardware') hasHardware = true;
        var f = sys.found.length ? sys.found.map(function (r) { return 'Found in the ' + r.appName + ' export: ' + (r.email || r.name) + (r.role ? ' as ' + r.role : '') + (r.verdict === 'off' ? ' - already shows as deactivated' : r.lastActive ? ' - last active ' + shortDay(r.lastActive, (lv.lastDay || r.lastActive).slice(0, 4)) : '') + (r.byName ? ' (matched by name - check)' : '') + '.'; }).join(' ') : '';
        tasks.push({ id: key + ':' + sys.id, phase: phaseOf(key, inv), system: sys.name, sso: sys.sso, key: key, title: STEPS[key].label, detail: stepDetail(key, sys, lv), owner: sys.owner, found: f, added: Boolean(sys.added), notFound: missed && key !== 'hardware' && key !== 'devices' && key !== 'rotate' ? 'Not in the ' + missed + ' export you loaded - if they never had an account here, that is the evidence.' : '', order: si });
      });
    });
    if (hasHardware) tasks = tasks.filter(function (t) { return t.id !== 'g-collect'; });
    tasks.forEach(function (t) { t.due = dueOf(t.phase, lv); t.done = false; t.by = ''; t.at = ''; t.evidence = ''; });
    tasks.sort(function (a, b) { return PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || (a.system ? 1 : 0) - (b.system ? 1 : 0) || (a.order || 0) - (b.order || 0) || STEP_KEYS.indexOf(a.key) - STEP_KEYS.indexOf(b.key); });
    tasks.forEach(function (t) { delete t.order; });
    return tasks.slice(0, LIMITS.tasks);
  }
  /** A rebuilt list with every tick, name, time and note carried over by id. */
  function mergeTasks(old, fresh) {
    var by = {};
    (old || []).forEach(function (t) { by[t.id] = t; });
    return fresh.map(function (t) {
      var o = by[t.id];
      if (o) { t.done = Boolean(o.done); t.by = line(o.by, LIMITS.byChars); t.at = str(o.at).slice(0, 25); t.evidence = line(o.evidence, LIMITS.evidenceChars); }
      return t;
    });
  }
  function progress(tasks, now) {
    var p = { total: tasks.length, done: 0, open: 0, overdue: 0, evidence: 0, next: null };
    tasks.forEach(function (t) {
      if (t.done) { p.done++; if (t.evidence) p.evidence++; return; }
      p.open++;
      if (isOverdue(t, now)) p.overdue++;
      if (t.due && (!p.next || dueKey(t.due) < dueKey(p.next.due))) p.next = t;
    });
    p.pct = p.total ? Math.round(p.done / p.total * 100) : 0;
    return p;
  }

  /** A leaver record, cleaned (from storage, or from the page's form). */
  function cleanLeaver(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var lv = {
      id: /^[a-z0-9-]{1,40}$/.test(str(r.id)) ? r.id : 'lv',
      name: line(r.name, LIMITS.fieldChars), email: line(r.email, 120),
      lastDay: isDay(r.lastDay) ? r.lastDay : '', lastTime: isTime(r.lastTime) ? r.lastTime : '',
      involuntary: r.involuntary === true ? true : r.involuntary === false ? false : null,
      manager: line(r.manager, LIMITS.fieldChars), filesTo: line(r.filesTo, LIMITS.fieldChars), mailTo: line(r.mailTo, LIMITS.fieldChars),
      mailbox: has(MAILBOX, str(r.mailbox)) ? r.mailbox : '',
      hardware: Array.isArray(r.hardware) ? r.hardware.filter(function (h) { return HARDWARE.indexOf(h) >= 0; }).slice(0, HARDWARE.length) : [],
      requestedBy: line(r.requestedBy, LIMITS.fieldChars), notes: para(r.notes, LIMITS.notesChars),
      from: {}, createdAt: str(r.createdAt).slice(0, 25), demo: r.demo === true,
      tasks: [],
    };
    if (r.from && typeof r.from === 'object') Object.keys(r.from).slice(0, 16).forEach(function (k) { if (/^[a-zA-Z]{2,14}$/.test(k)) lv.from[k] = line(r.from[k], LIMITS.fromChars); });
    if (Array.isArray(r.tasks)) {
      lv.tasks = r.tasks.slice(0, LIMITS.tasks).filter(function (t) { return t && typeof t === 'object' && /^[a-z0-9:-]{1,60}$/.test(str(t.id)); }).map(function (t) {
        return {
          id: t.id, phase: PHASES.indexOf(t.phase) >= 0 ? t.phase : 'moment', system: line(t.system, LIMITS.systemChars), sso: Boolean(t.sso), key: STEP_KEYS.indexOf(t.key) >= 0 ? t.key : 'general',
          title: line(t.title, 160), detail: line(t.detail, 300), owner: OWNER_KEYS.indexOf(t.owner) >= 0 ? t.owner : 'it', found: line(t.found, 600), added: Boolean(t.added), notFound: line(t.notFound, 200),
          due: t.due && isDay(t.due.day) ? { day: t.due.day, time: isTime(t.due.time) ? t.due.time : '' } : null,
          done: t.done === true, by: line(t.by, LIMITS.byChars), at: str(t.at).slice(0, 25), evidence: line(t.evidence, LIMITS.evidenceChars),
        };
      });
    }
    return lv;
  }

  /* ================================================================== *
   * Reading a pasted request
   * ================================================================== */

  var NAME = "([A-Z][a-zA-Z\u00c0-\u024f'’\\-]+(?:[ \\t]+(?:[A-Z][a-zA-Z\u00c0-\u024f'’\\-]+|(?:de|van|von|da|del|la|le|di)\\b)){0,3})";
  // Words that start sentences and are never a name.
  var NOT_NAME = /^(hi|hello|hey|dear|please|thanks|thank|the|our|their|his|her|they|we|you|this|that|these|those|also|and|but|so|as|it|its|re|fw|fwd|subject|from|to|cc|sent|date|team|all|everyone|friday|monday|tuesday|wednesday|thursday|saturday|sunday|today|tomorrow|january|february|march|april|may|june|july|august|september|october|november|december|leaver|offboarding|request|ticket|new|urgent|note|regards|best|cheers|kind|sincerely|i|my|me|she|he|them|end|last|day|effective|who|what|when|if|can|could|would|will|should|access|keep|give|forward|remove|disable)$/i;
  function cleanName(n) {
    var toks = str(n).replace(/['’]s$/, '').split(/\s+/).filter(Boolean);
    while (toks.length && NOT_NAME.test(toks[0])) toks.shift();
    while (toks.length && NOT_NAME.test(toks[toks.length - 1])) toks.pop();
    return toks.join(' ');
  }
  /** A regex source with every lower-case letter made case-insensitive, so a
   *  keyword matches at the start of a sentence while the NAME beside it
   *  still needs its capital letter. */
  function ci(src) { return src.replace(/(\\.)|([a-z])/g, function (m, e, ch) { return e ? e : '[' + ch + ch.toUpperCase() + ']'; }); }
  function isNameLike(s) { var t = cleanName(s); return /^[A-Z]/.test(t) && t.length >= 2 && t.split(/\s+/).length <= 4 ? t : ''; }

  var WEEKDAY = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)';
  var MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  var DATE_RE = new RegExp([
    '\\b(?:effective\\s+)?(?:immediately|right away|right now|asap)\\b',
    '\\b(?:today|tonight|this (?:morning|afternoon|evening)|tomorrow)\\b',
    '\\bend of (?:the |this )?(?:week|month)\\b|\\bend of next (?:week|month)\\b|\\b(?:eow|eom)\\b',
    '\\bin (?:a|one|two|three|four|\\d{1,2}) (?:weeks?|days?)\\b|\\b(?:two|2) weeks? from (?:today|now)\\b',
    '\\b(?:(?:this|next|coming|on)\\s+)?' + WEEKDAY + '\\b(?:,?\\s+(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\b)?(?:,?\\s+' + MONTH + '\\b\\.?\\s*\\d{1,2}(?:st|nd|rd|th)?\\b)?',
    '\\b\\d{4}-\\d{2}-\\d{2}\\b',
    '\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b|\\b\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}\\b',
    '\\b' + MONTH + '\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b',
    '\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MONTH + '\\b\\.?(?:,?\\s+\\d{4})?',
    '\\bthe \\d{1,2}(?:st|nd|rd|th)\\b(?:\\s+(?:of\\s+)?' + MONTH + '\\b\\.?(?:,?\\s+\\d{4})?)?',
  ].join('|'), 'gi');
  var TIME_RE = /\b(?:at|by|from|until|till|before)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\W|$)|\b([01]?\d|2[0-3]):([0-5]\d)\b|\b(noon|midday|end of (?:the |their )?(?:day|business day|working day)|eod|cob|close of business|end of business|first thing|lunchtime|lunch time)\b/gi;
  var TRIGGER = /last (?:working )?day|final day|leaving|leave date|end date|finish(?:es|ing)?|terminat|effective|departure|depart|access (?:should |must |needs to )?(?:end|stop|be removed|be revoked|be cut|go)|offboard|let (?:them |him |her )?go|resign/gi;

  /** A date expression, resolved against today: {day, note} or null. */
  function resolveDate(expr, today, dayFirst) {
    var s = fold(expr).replace(/\s+/g, ' ').trim().replace(/^the (\d{1,2}(?:st|nd|rd|th)? (?:of )?[a-z])/, '$1'), m;
    var y = +today.slice(0, 4), mo = +today.slice(5, 7);
    if (/immediately|right away|right now|asap/.test(s)) return { day: today, now: true, note: '“' + line(expr, 40) + '” read as now' };
    if (/^(today|tonight|this (morning|afternoon|evening))$/.test(s)) return { day: today };
    if (s === 'tomorrow') return { day: addDays(today, 1) };
    if ((m = /end of (the |this )?(week|month)|^(eow|eom)$/.exec(s)) && !/next/.test(s)) {
      if (/month|eom/.test(s)) return { day: lastOfMonth(y, mo), note: 'end of the month: ' + dayLabel(lastOfMonth(y, mo)) };
      return { day: addDays(today, (5 - weekday(today) + 7) % 7), note: 'end of the week read as Friday' };
    }
    if (/end of next week/.test(s)) return { day: addDays(today, (5 - weekday(today) + 7) % 7 + 7), note: 'end of next week read as the Friday after this one' };
    if (/end of next month/.test(s)) { var nm = mo === 12 ? 1 : mo + 1, ny = mo === 12 ? y + 1 : y; return { day: lastOfMonth(ny, nm) }; }
    if ((m = /in (a|one|two|three|four|\d{1,2}) (weeks?|days?)|(two|2) weeks? from/.exec(s))) {
      var words = { a: 1, one: 1, two: 2, three: 3, four: 4 };
      var n = m[3] ? 2 : (words[m[1]] || +m[1]);
      var d = /week/.test(m[2] || 'week') ? n * 7 : n;
      return { day: addDays(today, d), note: line(expr, 40) + ' from today' };
    }
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) { var iso = ymd(+m[1], +m[2], +m[3]); return iso ? { day: iso } : null; }
    if ((m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(s))) {
      var a = +m[1], b = +m[2], df = a > 12 ? true : b > 12 ? false : Boolean(dayFirst);
      var mm = df ? b : a, dd = df ? a : b, yy = m[3] ? year2(+m[3]) : y;
      var got = ymd(yy, mm, dd);
      if (!got) return null;
      if (!m[3] && daysBetween(got, today) > 60) got = ymd(y + 1, mm, dd) || got;
      return { day: got, note: a <= 12 && b <= 12 ? (df ? 'read day first' : 'read month first') + ' - check' : '' };
    }
    var md = new RegExp('^' + MONTH + '\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?$').exec(s) || null;
    var dm = new RegExp('^(\\d{1,2})(?:st|nd|rd|th)? (?:of )?' + MONTH + '\\.?(?:,? (\\d{4}))?$').exec(s) || null;
    if (md || dm) {
      var mon = monthOf(md ? md[1] : dm[2]), dnum = +(md ? md[2] : dm[1]), yr = (md ? md[3] : dm[3]);
      var day1 = ymd(yr ? +yr : y, mon, dnum);
      if (!day1) return null;
      if (!yr && daysBetween(day1, today) > 60) day1 = ymd(y + 1, mon, dnum) || day1;
      return { day: day1 };
    }
    if ((m = /^the (\d{1,2})(st|nd|rd|th)$/.exec(s))) {
      var dd2 = +m[1], t1 = ymd(y, mo, dd2);
      if (t1 && daysBetween(today, t1) >= 0) return { day: t1, note: 'the ' + dd2 + m[2] + ' read as this month' };
      var t2 = mo === 12 ? ymd(y + 1, 1, dd2) : ymd(y, mo + 1, dd2);
      return t2 ? { day: t2, note: 'the ' + dd2 + m[2] + ' read as next month' } : null;
    }
    // A weekday, perhaps with a day number or a month and day after it.
    var wd = new RegExp('^(?:(this|next|coming|on) )?' + WEEKDAY + '(?:,? (?:the )?(\\d{1,2})(?:st|nd|rd|th)?)?(?:,? ' + MONTH + '\\.? ?(\\d{1,2})(?:st|nd|rd|th)?)?$').exec(s);
    if (wd) {
      var target = DAYS.indexOf(wd[2].slice(0, 3));
      if (wd[4] && wd[5]) { var ex = ymd(y, monthOf(wd[4]), +wd[5]); if (ex && daysBetween(ex, today) > 60) ex = ymd(y + 1, monthOf(wd[4]), +wd[5]); if (ex) return { day: ex, note: weekday(ex) !== target ? 'that date is not a ' + DAY_NAMES[target] + ' - check' : '' }; }
      var ahead = (target - weekday(today) + 7) % 7;
      if (wd[1] === 'next') {
        var nx = addDays(today, ahead + (ahead === 0 ? 7 : 7));
        return { day: nx, note: '“next ' + DAY_NAMES[target] + '” read as ' + dayLabel(nx) + ' - check' };
      }
      var day = addDays(today, ahead);
      if (wd[3]) {
        var num = +wd[3];
        for (var k = 0; k < 70; k += 7) { var c = addDays(day, k); if (+c.slice(8, 10) === num) return { day: c }; }
        return { day: day, note: 'the day number does not fit - check' };
      }
      return { day: day, note: ahead === 0 ? DAY_NAMES[target] + ' read as today - check' : '' };
    }
    return null;
  }

  function resolveTime(m) {
    if (m[6]) {
      var w = m[6].toLowerCase();
      if (/noon|midday|lunch/.test(w)) return { time: '12:00', note: '“' + m[6] + '” read as 12:00 PM' };
      if (/first thing/.test(w)) return { time: '09:00', note: '“first thing” read as 9:00 AM' };
      return { time: '17:00', note: '“' + m[6] + '” read as 5:00 PM' };
    }
    if (m[4] !== undefined && m[4] !== '') return { time: pad2(+m[4]) + ':' + m[5] };
    var h = +m[1], mi = m[2] ? +m[2] : 0;
    if (h < 1 || h > 12 || mi > 59) return null;
    var pm = /p/i.test(m[3]);
    return { time: pad2(pm ? (h % 12) + 12 : h % 12) + ':' + pad2(mi) };
  }

  var INVOL = /\b(terminat(?:e|ed|ing|ion)|let (?:them |him |her |sam )?go|letting (?:them |him |her )?go|being let go|fired|dismiss(?:ed|al)|involuntar\w*|for cause|walk(?:ed)? (?:them |him |her )?out|escort(?:ed)? (?:them |him |her )?(?:out|off)|effective immediately|without notice|gross misconduct|laid off|lay ?off|redundan\w*|position (?:has been |was |is being )?eliminated)\b/i;
  var VOL = /\b(resign(?:ed|ation|ing)?|retir(?:e|ed|ing|ement)|moving on|two weeks'? notice|gave (?:their |his |her )?notice|handed in (?:their |his |her )?notice|new job|new role|accepted (?:a|an) (?:offer|position|role)|leaving us|relocat\w*|moving (?:away|to)|end of (?:their |his |her )?contract|contract (?:ends|is ending|finishes))\b/i;
  var HW = [['laptop', /\b(laptop|macbook|notebook)\b/i], ['desktop', /\b(desktop|workstation|pc)\b/i], ['phone', /\b(?:work|company|practice|office|their|his|her|a|the)\s+(?:mobile |cell )?(?:phone|mobile|cellphone|iphone)\b(?!\s*(?:number|no\b|call|line|:))/i], ['tablet', /\b(tablet|ipad)\b/i], ['monitor', /\bmonitors?\b/i], ['headset', /\bheadsets?\b/i], ['key fob', /\b(key ?fob|fob)\b/i], ['keys', /\bkeys?\b(?! ?fob)/i], ['badge', /\b(badge|id card|access card|card key|swipe card)\b/i], ['company card', /\b(company|corporate|credit) card\b/i], ['car', /\b(company|pool) (car|vehicle|van)\b/i], ['parking pass', /\bparking (pass|permit)\b/i]];

  // A person phrase after "to", "for", "is": a name, or a role ("the office
  // manager"). Cut at the end of the clause.
  var CLAUSE = /[.,;:!?\n]|\s(?:who|which|so|as|and then|because|until|from|by|on|at|please|pls|thanks|thx|when|while|if)(?=\s|$)/i;
  function personPhrase(s) {
    var raw = str(s);
    var me = /\((?:me|myself|that'?s me)\)/i.test(raw);
    var t = raw.replace(/\s*\((?:me|myself|that'?s me)\)/i, '').split(CLAUSE)[0].trim();
    t = t.replace(/['’]s$/, '').replace(/\s+(?:now|too|instead|going forward|for now|as well)$/i, '').trim();
    if (!t || t.length > LIMITS.fieldChars || t.split(/\s+/).length > 6) return '';
    if (/^(me|myself)$/i.test(t)) return 'me';
    return me ? t + ' (me)' : t;
  }
  /** A matched phrase cut at the end of its clause, for "the words it came from". */
  function clause(s) { var m = CLAUSE.exec(str(s)); return (m ? str(s).slice(0, m.index) : str(s)).trim(); }
  function near(text, idx, re, span) {
    var a = Math.max(0, idx - span), seg = text.slice(a, idx + span);
    re.lastIndex = 0;
    var m, best = null;
    while ((m = re.exec(seg))) { var at = a + m.index; if (!best || Math.abs(at - idx) < Math.abs(best.at - idx)) best = { m: m, at: at }; if (!m[0]) re.lastIndex++; }
    return best;
  }
  function quote(text, at, len) { return line(text.slice(at, at + len), LIMITS.fromChars); }
  /** Where the sentence holding `at` starts (at most 60 characters back). */
  function sentenceStart(text, at) {
    var from = Math.max(0, at - 60), seg = text.slice(from, at), m, last = -1, re = /[.!?\n]\s*/g;
    while ((m = re.exec(seg))) last = m.index + m[0].length;
    if (last >= 0) return from + last;
    var sp = seg.indexOf(' ');
    return from === 0 ? 0 : from + (sp >= 0 ? sp + 1 : 0);
  }

  /**
   * A pasted email or ticket read into a leaver's fields, deterministically.
   * Each field found is {value, from (the words it came from), note}; what is
   * missing becomes a question. Nothing is guessed silently: a time not given
   * stays empty (the checklist says which default it used), an ambiguous date
   * carries a note.
   *   o = {today: 'YYYY-MM-DD', time: 'HH:MM' (now), dayFirst, names: [known full names]}
   */
  function parseRequest(text, o) {
    o = o || {};
    var t = para(text, LIMITS.pasteChars);
    var today = isDay(o.today) ? o.today : '2026-01-01';
    var f = {}, people = [];
    var set = function (k, value, from, note) { if (value === '' || value === null || value === undefined || f[k]) return; f[k] = { value: value, from: line(from, LIMITS.fromChars), note: note || '' }; };
    // The sender, from a From: line.
    var from = /^(?:from|sender)\s*:\s*"?([^"<\n@]{2,60}?)"?\s*(?:<[^>\n]*>|\[[^\]\n]*\])?\s*$/im.exec(t);
    if (from && isNameLike(from[1].trim())) { set('requestedBy', isNameLike(from[1].trim()), from[0]); }
    var body = t.replace(/^(?:from|to|cc|bcc|sent|date)\s*:.*$/gim, function (x) { return x.replace(/\S/g, ' '); });

    // The leaver's name.
    var NP = [
      new RegExp(NAME + "['’]s\\s+" + ci('(?:last|final)\\s+(?:working\\s+)?day')),
      new RegExp(ci('(?:last|final)\\s+day\\s+(?:for|of)\\s+') + NAME),
      new RegExp(NAME + '\\s+(?:is|will be|has been|was|is being)\\s+(?:leaving|resigning|retiring|let go|terminated|moving on|departing|finishing|dismissed|laid off|fired|offboarded)'),
      new RegExp(NAME + '\\s+(?:has\\s+)?(?:resigned|quit|retired|handed in)'),
      new RegExp(ci('(?:offboard|off-board|remove|disable|terminate|deactivate|let go of|letting go of|lock out|revoke access for|cut off access for|remove access for)\\s+') + NAME),
      new RegExp(ci('(?:leaver|offboarding|termination|departure|leaving|exit)\\s*[:\\-–—]\\s*') + NAME),
      new RegExp(ci('(?:employee|name|user|staff member|leaver)\\s*:\\s*') + NAME),
    ];
    for (var i = 0; i < NP.length && !f.name; i++) {
      var nm = NP[i].exec(t);
      if (nm) { var nn = isNameLike(nm[1]); if (nn) set('name', nn, nm[0]); }
    }
    // A first name alone: widen it with a fuller name in the text, or a known one.
    if (f.name && f.name.value.split(' ').length === 1) {
      var first = f.name.value;
      var fuller = new RegExp('\\b' + first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+([A-Z][a-zA-Z\u00c0-\u024f\'’\\-]+)').exec(t);
      var known = (o.names || []).filter(function (n) { return fold(n.split(' ')[0]) === fold(first); });
      if (fuller && !NOT_NAME.test(fuller[1])) f.name.value = first + ' ' + fuller[1].replace(/['’]s$/, '');
      else if (known.length === 1) { f.name.value = known[0]; f.name.note = 'the full name is from your identity provider’s export'; }
    }
    if (f.name) people.push(f.name.value);
    if (f.requestedBy) people.push(f.requestedBy.value);

    // Addresses: the leaver's is the one that carries their name.
    var emails = [];
    body.replace(EMAIL, function (m, at) { emails.push({ v: m, at: at }); return m; });
    if (emails.length) {
      var toks = f.name ? fold(f.name.value).split(/\s+/).filter(function (x) { return x.length >= 2; }) : [];
      var pick = emails.filter(function (e) { var l = fold(localOf(e.v)); return toks.some(function (x) { return l.indexOf(x) >= 0; }); })[0];
      if (!pick && !f.name) pick = emails.filter(function (e) { return !/\b(forward|cc|copy|reply|contact|reach)\b[^.\n]{0,30}$/i.test(body.slice(Math.max(0, e.at - 40), e.at)); })[0];
      if (pick) { var s0 = sentenceStart(body, pick.at); set('email', pick.v, quote(body, s0, pick.at + pick.v.length - s0)); }
    }

    // The last day, and the time.
    var dates = [];
    DATE_RE.lastIndex = 0;
    var dm;
    while ((dm = DATE_RE.exec(body))) { if (!dm[0]) { DATE_RE.lastIndex++; continue; } dates.push({ v: dm[0], at: dm.index }); }
    var triggers = [];
    TRIGGER.lastIndex = 0;
    var tm;
    while ((tm = TRIGGER.exec(body))) triggers.push(tm.index);
    var chosen = null, why = '';
    triggers.forEach(function (ti) { dates.forEach(function (d) { var dist = d.at - ti; if (dist >= -40 && dist <= 80 && (!chosen || Math.abs(dist) < Math.abs(chosen.dist))) chosen = { d: d, dist: dist }; }); });
    if (!chosen && dates.length === 1) { chosen = { d: dates[0] }; why = 'the only date in the request'; }
    if (chosen) {
      var r = resolveDate(chosen.d.v, today, o.dayFirst);
      if (r) {
        var a0 = Math.max(0, Math.min(chosen.d.at, triggers.length ? triggers.reduce(function (b, x) { return Math.abs(x - chosen.d.at) < Math.abs(b - chosen.d.at) ? x : b; }) : chosen.d.at));
        set('lastDay', r.day, quote(body, a0, chosen.d.at + chosen.d.v.length - a0), [r.note, why].filter(Boolean).join('; '));
        if (r.now && isTime(o.time)) set('lastTime', o.time, chosen.d.v, 'now');
        var tt = near(body, chosen.d.at, TIME_RE, 70);
        if (tt) { var rt = resolveTime(tt.m); if (rt) set('lastTime', rt.time, tt.m[0].trim(), rt.note); }
      }
    }
    if (!f.lastTime) {
      var anyT = null; TIME_RE.lastIndex = 0; var am;
      while ((am = TIME_RE.exec(body))) { if (triggers.some(function (ti) { return Math.abs(am.index - ti) < 90; })) { anyT = am; break; } }
      if (anyT) { var rt2 = resolveTime(anyT); if (rt2) set('lastTime', rt2.time, anyT[0].trim(), rt2.note); }
    }

    // Voluntary or not.
    var iv = INVOL.exec(body), vv = VOL.exec(body);
    if (iv) set('involuntary', true, iv[0], vv ? 'it also says “' + vv[0] + '” - check' : '');
    else if (vv) set('involuntary', false, vv[0]);

    // Mail.
    var mb;
    if ((mb = /\b(?:keep|retain|preserve|hold on to|save)\s+(?:their|his|her|the|its)\s+(?:mailbox|mail|e-?mail|inbox|emails)\b(?:\s+(?:open\s+|active\s+|live\s+)?(?:for|so)\s+([^.,;\n]{2,60}))?/i.exec(body))) {
      set('mailbox', 'shared', mb[0], 'keeping a mailbox usually means a shared mailbox - check');
      if (mb[1]) { var who = personPhrase(mb[1]); if (who && !/^(now|a while|later|records?|patients?|clients?|customers?|emails?)$/i.test(who)) set('mailTo', who, mb[0]); }
    } else if ((mb = /\bconvert\w*\s+(?:their|his|her|the)?\s*(?:mailbox|inbox|mail)\s+(?:in)?to\s+(?:a\s+)?shared(?: mailbox)?\b(?:[^.\n]{0,20}?\b(?:for|give|so)\s+([^.,;\n]{2,60}))?|\bshared mailbox\b/i.exec(body))) {
      set('mailbox', 'shared', mb[0]);
      if (mb[1]) { var w2 = personPhrase(mb[1]); if (w2) set('mailTo', w2, mb[0]); }
    } else if ((mb = /\bforward\w*\s+(?:all\s+)?(?:of\s+)?(?:their|his|her|the|any|incoming)?\s*(?:mail|e-?mails?|messages|inbox)\s+to\s+([^.,;\n]{2,60})/i.exec(body))) {
      set('mailbox', 'forward', mb[0]);
      var w3 = personPhrase(mb[1]); if (w3) set('mailTo', w3, mb[0]);
    } else if ((mb = /\b(?:delete|remove|close)\s+(?:their|his|her|the)\s+(?:mailbox|inbox|e-?mail account)\b/i.exec(body))) {
      set('mailbox', 'delete', mb[0]);
    }
    if (!f.mailTo && (mb = /\bgive\s+([^.,;\n]{2,50}?)\s+access\s+to\s+(?:their|his|her|the)\s+(?:mailbox|inbox|mail|e-?mail)/i.exec(body))) { var w4 = personPhrase(mb[1]); if (w4) { set('mailTo', w4, mb[0]); set('mailbox', 'shared', mb[0]); } }

    // Files.
    var fm;
    if ((fm = /\b(?:give|transfer|move|hand|pass|send|assign|reassign)\s+(?:over\s+)?(?:all\s+(?:of\s+)?)?(?:their|his|her|the|any)?\s*(?:files?|documents?|docs|drive|one ?drive|google drive|folders?|data|work)\s+(?:over\s+)?to\s+([^.,;\n]{2,60})/i.exec(body))
      || (fm = /\b(?:files?|documents?|docs|drive|one ?drive|folders?)\s+(?:should\s+|can\s+|will\s+|need to\s+)?(?:go|goes|going|move|be (?:given|transferred|moved))\s+to\s+([^.,;\n]{2,60})/i.exec(body))) {
      var fw = personPhrase(fm[1]); if (fw) set('filesTo', fw, fm[0]);
    } else if ((fm = new RegExp(NAME + '\\s+(?:is|will be|are)\\s+(?:taking over|covering|picking up)').exec(body))) {
      var tk = isNameLike(fm[1]); if (tk) set('filesTo', tk, fm[0], 'they are taking over - check they should get the files');
    }

    // Their manager.
    var mg;
    if ((mg = new RegExp(ci('(?:their|his|her)\\s+(?:line\\s+)?manager(?:\\s+is|,|\\s*:)?\\s+') + NAME).exec(body)) || (mg = new RegExp(ci('reports?\\s+to\\s+') + NAME).exec(body)) || (mg = new RegExp(ci('manager\\s*:\\s*') + NAME).exec(body))) {
      var mn = isNameLike(mg[1]); if (mn) set('manager', mn, mg[0]);
    }

    // Hardware.
    var hw = [], hwFrom = [];
    HW.forEach(function (h) { var x = h[1].exec(body); if (x) { hw.push(h[0]); hwFrom.push(x[0]); } });
    if (hw.length) set('hardware', hw, hwFrom.join(', '));

    // "me" means the sender.
    ['mailTo', 'filesTo', 'manager'].forEach(function (k) {
      if (!f[k]) return;
      if (f[k].value === 'me') { if (f.requestedBy) { f[k].value = f.requestedBy.value; f[k].note = '“me” is the sender'; } else f[k].value = 'the person who sent this'; }
      else if (/ \(me\)$/.test(f[k].value)) { f[k].value = f[k].value.replace(/ \(me\)$/, f.requestedBy ? ' (' + f.requestedBy.value + ')' : ''); if (f.requestedBy) f[k].note = '“me” is the sender'; }
    });
    ['mailbox', 'mailTo', 'filesTo'].forEach(function (k) { if (f[k] && f[k].from) f[k].from = line(clause(f[k].from), LIMITS.fromChars); });
    ['mailTo', 'filesTo', 'manager'].forEach(function (k) { if (f[k] && isNameLike(f[k].value) && f[k].value.split(' ').length >= 2) people.push(isNameLike(f[k].value)); });

    // Names worth hiding beside the fields: greetings, sign-offs and known
    // names that appear in the text.
    var g, GREET = /\b(?:hi|hello|hey|dear|thanks|thank you|regards|best|cheers|sincerely|kind regards|many thanks)\b[ ,]*\n?\s*([A-Z][a-zA-Z'’\-]+(?:\s+[A-Z][a-zA-Z'’\-]+)?)/g;
    while ((g = GREET.exec(t))) { var gn = isNameLike(g[1]); if (gn && !/^(team|all|everyone|there|folks)$/i.test(gn)) people.push(gn); }
    (o.names || []).forEach(function (n) { var nl = line(n, 80); if (nl && nameKey(nl) && new RegExp('\\b' + nl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(t)) people.push(nl); });
    var seenP = {};
    people = people.filter(function (p) { var k = fold(p); if (!p || seenP[k]) return false; seenP[k] = 1; return true; });

    return { fields: f, questions: questionsFor(f, today), people: people, text: t };
  }

  var QUESTION = {
    name: 'Who is leaving?',
    email: 'What is their sign-in address?',
    lastDay: 'What is their last day?',
    lastTime: 'What time should their access end?',
    involuntary: 'Is this a resignation, or should access go at the moment of notice (involuntary)?',
    filesTo: 'Who takes over their files?',
    mailbox: 'What happens to their mailbox - shared, forwarded or deleted?',
    mailTo: 'Who should get their mail?',
    manager: 'Who is their manager?',
  };
  function questionsFor(f, today) {
    var q = [];
    ['name', 'email', 'lastDay', 'lastTime', 'involuntary', 'filesTo', 'mailbox', 'mailTo', 'manager'].forEach(function (k) {
      if (f[k]) return;
      if (k === 'mailTo' && (!f.mailbox || f.mailbox.value === 'delete' || f.mailbox.value === 'keep')) return;
      var text = QUESTION[k];
      if (k === 'lastTime' && f.lastDay) text = 'What time should their access end on ' + dayLabel(f.lastDay.value, today.slice(0, 4)) + '?';
      q.push({ field: k, text: text });
    });
    return q;
  }

  /** The parsed fields as a leaver record. */
  function leaverFrom(parsed) {
    var f = parsed.fields, v = function (k) { return f[k] ? f[k].value : ''; };
    var lv = cleanLeaver({ name: v('name'), email: v('email'), lastDay: v('lastDay'), lastTime: v('lastTime'), involuntary: f.involuntary ? f.involuntary.value : null, manager: v('manager'), filesTo: v('filesTo'), mailTo: v('mailTo'), mailbox: v('mailbox'), hardware: v('hardware') || [], requestedBy: v('requestedBy') });
    Object.keys(f).forEach(function (k) { if (f[k].from) lv.from[k] = line(f[k].from, LIMITS.fromChars); });
    return lv;
  }

  /* ================================================================== *
   * Masking for the one AI call
   * ================================================================== */

  var TOKEN = /\[(email|phone|person|link|number|word)(\d{1,3})\]/g;
  var PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b|\b\d{3}[\s.-]\d{4}\b|\+\d{8,14}\b/g;
  var LONGNUM = /\b\d{6,}\b/g;

  /** s.replace(re, fn), but never inside a token already put in. */
  function replaceOutside(s, re, fn) {
    var out = '', last = 0, m, tr = new RegExp(TOKEN.source, 'g');
    while ((m = tr.exec(s))) { out += s.slice(last, m.index).replace(re, fn) + m[0]; last = m.index + m[0].length; }
    return out + s.slice(last).replace(re, fn);
  }
  // Dates and clock times blanked out (same length), so a run of digits
  // check never reads "2026-11-06 17:00" as a phone number.
  function blankDates(s) {
    return str(s).replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b\d{1,2}:\d{2}\b/g, function (m) { return m.replace(/\d/g, 'D'); });
  }
  var DIGIT_RUN = /\d(?:[\s().-]?\d){8,}/g;
  /** [start, end] of every run of nine or more digits (spaces, dots, dashes
   *  and brackets allowed between them) that is not a date or a time. */
  function digitRuns(s) {
    var b = blankDates(s), out = [], m;
    DIGIT_RUN.lastIndex = 0;
    while ((m = DIGIT_RUN.exec(b))) out.push([m.index, m.index + m[0].length]);
    return out;
  }

  /**
   * The text the AI may see: every address [email1], phone [phone1], link
   * [link1], long number [number1], each person the parser found (and their
   * first or last name standing alone) [person1], and any extra words the
   * person chose [word1]. Returns {text, map: {token: original}, counts}.
   */
  function maskRequest(text, people, extraWords) {
    var map = {}, rev = {}, counts = { email: 0, phone: 0, person: 0, link: 0, number: 0, word: 0 };
    var cut = str(text).length > LIMITS.aiChars;
    var s = para(text, LIMITS.aiChars);
    function tok(kind, original, revKey) {
      var key = kind + '|' + (revKey || fold(original));
      if (has(rev, key)) return rev[key];
      var t = '[' + kind + (++counts[kind]) + ']';
      rev[key] = t; map[t] = original;
      return t;
    }
    // Addresses first: a domain inside one must never be taken for a link.
    s = replaceOutside(s, new RegExp(EMAIL.source, 'g'), function (m) { return tok('email', m); });
    s = replaceOutside(s, new RegExp(LINK.source, 'gi'), function (m) { return tok('link', m); });
    s = replaceOutside(s, PHONE, function (m) { return tok('phone', m); });
    s = replaceOutside(s, LONGNUM, function (m) { return tok('number', m); });
    // Any other long run of digits (an id typed with spaces) - the server
    // refuses the same runs, so what is shown is what will be accepted.
    var runs = digitRuns(s);
    for (var ri = runs.length - 1; ri >= 0; ri--) s = s.slice(0, runs[ri][0]) + tok('number', s.slice(runs[ri][0], runs[ri][1])) + s.slice(runs[ri][1]);
    var names = (people || []).map(function (p) { return line(p, 80); }).filter(function (p) { return p.length >= 2; });
    names.sort(function (a, b) { return b.length - a.length; });
    names.forEach(function (n) {
      var t = tok('person', n);
      var re = new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
      s = replaceOutside(s, re, function () { return t; });
    });
    // A first or last name standing alone is the same person.
    names.forEach(function (n) {
      var t = tok('person', n);
      n.split(/\s+/).forEach(function (part) {
        if (part.length < 3 || NOT_NAME.test(part)) return;
        s = replaceOutside(s, new RegExp('\\b' + part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), function () { return t; });
      });
    });
    (extraWords || []).map(function (w) { return line(w, 60); }).filter(function (w) { return w.length >= 2; }).forEach(function (w) {
      var t = tok('word', w);
      s = replaceOutside(s, new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), function () { return t; });
    });
    return { text: s, map: map, counts: counts, cut: cut };
  }
  function unmask(s, map) {
    return str(s).replace(TOKEN, function (m) { return map && has(map, m) ? map[m] : m; });
  }
  function tokensIn(s) { var out = {}; str(s).replace(TOKEN, function (m) { out[m] = 1; return m; }); return out; }

  var AI_FIELDS = ['name', 'email', 'lastDay', 'lastTime', 'involuntary', 'manager', 'filesTo', 'mailTo', 'mailbox', 'hardware'];

  /** The server's check of the request: {text, today, dayFirst?} and
   *  nothing else; the text masked - no address, no long run of digits. */
  function aiRequest(body) {
    if (!onlyKeys(body, ['text', 'today', 'dayFirst'])) return { error: 'Send only the masked text and today’s date.' };
    if (typeof body.text !== 'string' || !body.text.trim()) return { error: 'Paste the request first.' };
    if (body.text.length > LIMITS.aiChars) return { error: 'That is longer than ' + groups(LIMITS.aiChars) + ' characters. Send the part about the leaver.' };
    if (!isDay(body.today)) return { error: 'Send today’s date.' };
    if (body.dayFirst !== undefined && typeof body.dayFirst !== 'boolean') return { error: 'Send only the masked text and today’s date.' };
    var text = para(body.text, LIMITS.aiChars);
    if (/\S@\S/.test(text)) return { error: 'The text still holds an email address. Mask it before it is sent - nothing was sent.', code: 'unmasked-email' };
    if (digitRuns(text.replace(TOKEN, function (m) { return m.replace(/\d/g, 'n'); })).length) return { error: 'The text still holds a long number (a phone or an id). Mask it before it is sent - nothing was sent.', code: 'unmasked-number' };
    return { req: { text: text, today: body.today, dayFirst: body.dayFirst === true, tokens: Object.keys(tokensIn(text)) } };
  }

  /** A string the model wrote, made safe: no markup, no link, no address, no
   *  token the request did not carry, no invisible characters, bounded. */
  function aiString(v, req, max) {
    var s = noMarkup(line(v, max || 120)).replace(new RegExp(LINK.source, 'gi'), '').replace(new RegExp(EMAIL.source, 'g'), '');
    s = s.replace(TOKEN, function (m) { return req.tokens.indexOf(m) >= 0 ? m : ''; }).replace(/\s+/g, ' ').trim();
    return s;
  }
  /** A person value: a token, or a few plain words ("the office manager"). */
  function aiPerson(v, req) {
    var s = aiString(v, req, LIMITS.fieldChars);
    if (!s) return '';
    if (!/^[A-Za-z\u00c0-\u024f\[\]0-9 '’&().,-]+$/.test(s) || s.replace(TOKEN, 'x').split(/\s+/).length > 8) return '';
    return s;
  }
  function aiFrom(v, req) {
    var s = aiString(v, req, LIMITS.fromChars);
    if (!s) return '';
    var hay = fold(req.text).replace(/\s+/g, ' '), needle = fold(s).replace(/\s+/g, ' ').replace(/…$/, '');
    return needle.length >= 2 && hay.indexOf(needle) >= 0 ? s : '';
  }

  /** The model's answer, checked field by field. Returns {fields, questions,
   *  dropped} with fields shaped like parseRequest's, still masked. */
  function cleanAiAnswer(raw, req) {
    var out = { fields: {}, questions: [], dropped: 0 };
    if (!raw || typeof raw !== 'object') return out;
    var wire = { name: 'name', email: 'email', last_day: 'lastDay', last_time: 'lastTime', involuntary: 'involuntary', manager: 'manager', files_to: 'filesTo', mail_to: 'mailTo', mailbox: 'mailbox', hardware: 'hardware' };
    Object.keys(raw).forEach(function (k) { if (!has(wire, k) && k !== 'questions' && k !== 'note') out.dropped++; });
    Object.keys(wire).forEach(function (wk) {
      var x = raw[wk];
      if (x === undefined || x === null) return;
      if (typeof x !== 'object' || Array.isArray(x)) { out.dropped++; return; }
      var k = wire[wk], v = x.value, val = null;
      if (k === 'email') { var em = aiString(v, req, 20); val = /^\[email\d{1,3}\]$/.test(em) ? em : null; }
      else if (k === 'lastDay') { val = isDay(v) && Math.abs(daysBetween(req.today, v)) <= 366 ? v : null; }
      else if (k === 'lastTime') { val = isTime(v) ? v : null; }
      else if (k === 'involuntary') { val = typeof v === 'boolean' ? v : null; }
      else if (k === 'mailbox') { val = has(MAILBOX, str(v)) ? v : null; }
      else if (k === 'hardware') { val = Array.isArray(v) ? v.filter(function (h) { return HARDWARE.indexOf(h) >= 0; }).filter(function (h, i, a) { return a.indexOf(h) === i; }) : null; if (val && !val.length) val = null; }
      else { val = aiPerson(v, req) || null; }
      if (val === null) { if (v !== null && v !== undefined && v !== '') out.dropped++; return; }
      out.fields[k] = { value: val, from: aiFrom(x.from, req), note: 'read by AI - check' };
    });
    if (Array.isArray(raw.questions)) {
      raw.questions.slice(0, 20).forEach(function (q) {
        var s = aiString(q, req, LIMITS.fromChars);
        if (s && s.length >= 4 && out.questions.length < LIMITS.questions) out.questions.push(s); else if (q) out.dropped++;
      });
    }
    return out;
  }

  /* ================================================================== *
   * Exports
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
  function dueText(d) { return d ? d.day + (d.time ? ' ' + d.time : '') : ''; }

  function findingsRows(rows, idp) {
    var out = [['app', 'account', 'name', 'verdict', 'critical', 'role', 'last_active', 'idp_status', 'idp_status_changed', 'days_since_left', 'days_idle', 'matched', 'why']];
    rows.forEach(function (r) {
      out.push([r.appName, r.email, r.name, VERDICT_WORD[r.verdict].replace('IdP', idpName(idp)), r.critical ? 'yes' : '', r.role, r.lastActive || (r.never ? 'never' : ''), r.user ? r.user.status : 'not found', r.user && r.user.changed ? r.user.changed : '', r.leftDays === null ? '' : r.leftDays, r.idleDays === null ? '' : r.idleDays, r.how, r.why]);
    });
    return out;
  }
  function checklistRows(lv) {
    var inv = lv.involuntary === true;
    var out = [['leaver', 'leaver_email', 'phase', 'due', 'system', 'step', 'detail', 'owner', 'status', 'done_by', 'done_at', 'evidence']];
    lv.tasks.forEach(function (t) {
      out.push([lv.name, lv.email, phaseWord(t.phase, inv), dueText(t.due), t.system || 'General', t.title, t.detail + (t.found ? ' ' + t.found : ''), OWNERS[t.owner] || t.owner, t.done ? 'done' : 'open', t.by, t.at, t.evidence]);
    });
    return out;
  }
  /** The checklist as JSON for a PSA or ticketing import (shape documented
   *  in CLAUDE.md: "lastday.checklist.v1"). */
  function checklistJson(lv, now) {
    var p = progress(lv.tasks, now);
    return {
      format: 'lastday.checklist.v1',
      generated: now ? now.day + 'T' + (now.time || '00:00') : '',
      leaver: { name: lv.name, email: lv.email, lastDay: lv.lastDay || null, lastTime: lv.lastTime || null, involuntary: lv.involuntary, manager: lv.manager || null, filesTo: lv.filesTo || null, mailTo: lv.mailTo || null, mailbox: lv.mailbox || null, hardware: lv.hardware.slice() },
      progress: { total: p.total, done: p.done, open: p.open, overdue: p.overdue },
      tasks: lv.tasks.map(function (t) {
        return { id: t.id, phase: t.phase, phaseLabel: phaseWord(t.phase, lv.involuntary === true), due: t.due ? t.due.day + (t.due.time ? 'T' + t.due.time : '') : null, system: t.system || null, sso: t.system ? t.sso : null, action: t.key, title: t.title, detail: t.detail, foundInExport: t.found || null, owner: t.owner, ownerLabel: OWNERS[t.owner] || t.owner, status: t.done ? 'done' : 'open', doneBy: t.by || null, doneAt: t.at || null, evidence: t.evidence || null };
      }),
    };
  }
  function md(v) { return line(v, 600).replace(/([\\`*_{}\[\]<>|#~])/g, '\\$1').replace(/^([-+]|\d+\.)\s/, '\\$1 '); }
  function checklistMarkdown(lv, now) {
    var inv = lv.involuntary === true, p = progress(lv.tasks, now);
    var out = ['## Leaver: ' + md(lv.name || 'not named yet'), ''];
    out.push('- **Address:** ' + md(lv.email || 'not given'));
    out.push('- **Last day:** ' + (lv.lastDay ? md(dayLabel(lv.lastDay) + ', ' + lv.lastDay.slice(0, 4)) + (lv.lastTime ? ' at ' + md(clockLabel(lv.lastTime)) : '') : 'not set'));
    out.push('- **Kind:** ' + (lv.involuntary === true ? 'involuntary - revoke at the moment of notice' : lv.involuntary === false ? 'voluntary' : 'not said'));
    if (lv.manager) out.push('- **Manager:** ' + md(lv.manager));
    out.push('- **Files to:** ' + md(lv.filesTo || 'not decided') + ' · **Mail:** ' + md(lv.mailbox ? MAILBOX[lv.mailbox] : 'not decided') + (lv.mailTo ? ' (' + md(lv.mailTo) + ')' : ''));
    out.push('- **Progress:** ' + p.done + ' of ' + p.total + ' done, ' + p.open + ' open' + (p.overdue ? ', ' + p.overdue + ' overdue' : ''));
    PHASES.forEach(function (ph) {
      var ts = lv.tasks.filter(function (t) { return t.phase === ph; });
      if (!ts.length) return;
      out.push('', '### ' + md(phaseWord(ph, inv)) + (ts[0].due ? ' (by ' + md(dueText(ts[0].due)) + ')' : ''), '');
      ts.forEach(function (t) {
        out.push('- [' + (t.done ? 'x' : ' ') + '] ' + (t.system ? '**' + md(t.system) + ':** ' : '') + md(t.title) + ' - ' + md(OWNERS[t.owner] || t.owner) + (t.done ? ' (' + md([t.by, t.at.replace('T', ' ')].filter(Boolean).join(', ')) + ')' : '') + (t.evidence ? ' - evidence: ' + md(t.evidence) : ''));
      });
    });
    return out.join('\n') + '\n';
  }

  /* ================================================================== *
   * The inventory and settings (synced): systems and preferences, never a person
   * ================================================================== */

  var DEFAULT_SETTINGS = { domains: [], patterns: DEFAULT_PATTERNS.slice(), dormantDays: 90, idp: 'other' };
  function defaults() { return { version: 1, systems: [], settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), updatedAt: 0 }; }
  var INV_KEYS = ['version', 'systems', 'settings', 'updatedAt'];
  var SYS_KEYS = ['id', 'name', 'sso', 'steps', 'owner'];
  var SET_KEYS = ['domains', 'patterns', 'dormantDays', 'idp'];

  function looksLikePerson(s) { return /@/.test(s) || /^[a-z]{2,}\.[a-z]{2,}$/i.test(s); }

  /**
   * An inventory, cleaned. strict (the server's PUT) refuses rather than
   * repairs: unknown fields anywhere (a list of users, a checklist, a name
   * field), oversize lists, an address or anything shaped like one in any
   * string, a step or owner role that is not on the list. Returns
   * {inventory, errors}.
   */
  function cleanInventory(raw, strict) {
    var errors = [];
    var bad = function (msg) { if (errors.length < 20) errors.push(msg); };
    var r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (strict) Object.keys(r).forEach(function (k) { if (INV_KEYS.indexOf(k) < 0) bad('“' + line(k, 30) + '” is not part of a system list - only systems and settings are kept.'); });
    var out = defaults();
    out.updatedAt = Number(r.updatedAt) > 0 ? Math.floor(Number(r.updatedAt)) : 0;
    var systems = Array.isArray(r.systems) ? r.systems : [];
    if (strict && r.systems !== undefined && !Array.isArray(r.systems)) bad('Systems must be a list.');
    if (systems.length > LIMITS.systems) { if (strict) bad('At most ' + LIMITS.systems + ' systems.'); systems = systems.slice(0, LIMITS.systems); }
    var seenIds = {}, seenNames = {};
    systems.forEach(function (s, i) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) { if (strict) bad('System ' + (i + 1) + ' is not a system.'); return; }
      if (strict) Object.keys(s).forEach(function (k) { if (SYS_KEYS.indexOf(k) < 0) bad('System ' + (i + 1) + ': “' + line(k, 30) + '” is not kept - systems hold a name, single sign-on, steps and an owner role.'); });
      var name = line(s.name, LIMITS.systemChars);
      if (!name || str(s.name).length > LIMITS.systemChars + 20) { if (strict) bad('System ' + (i + 1) + ' needs a name of up to ' + LIMITS.systemChars + ' characters.'); if (!name) return; }
      if (str(s.name) !== str(s.name).replace(BAD, '') || /[<>{}]/.test(name)) { if (strict) bad('System ' + (i + 1) + '’s name has characters that are not kept.'); name = name.replace(/[<>{}]/g, ''); }
      if (looksLikePerson(name)) { if (strict) bad('“' + clip(name, 30) + '” looks like a person’s address, not a system.'); return; }
      if (seenNames[fold(name)]) { if (strict) bad('Two systems are called “' + clip(name, 30) + '”.'); return; }
      seenNames[fold(name)] = 1;
      var id = /^[a-z0-9-]{1,24}$/.test(str(s.id)) && !seenIds[s.id] ? s.id : slug(name);
      while (seenIds[id]) id = id.slice(0, 20) + '-' + (i + 1);
      seenIds[id] = 1;
      var steps = Array.isArray(s.steps) ? s.steps : [];
      if (strict && (!Array.isArray(s.steps) || s.steps.length > LIMITS.steps)) bad('System ' + (i + 1) + ': steps must be a list of up to ' + LIMITS.steps + '.');
      var st = [];
      steps.slice(0, LIMITS.steps).forEach(function (k) { if (STEP_KEYS.indexOf(k) >= 0) { if (st.indexOf(k) < 0) st.push(k); } else if (strict) bad('System ' + (i + 1) + ': “' + line(k, 30) + '” is not a step.'); });
      var owner = OWNER_KEYS.indexOf(s.owner) >= 0 ? s.owner : 'it';
      if (strict && s.owner !== undefined && OWNER_KEYS.indexOf(s.owner) < 0) bad('System ' + (i + 1) + ': the owner is a role from the list, never a person.');
      if (strict && s.sso !== undefined && typeof s.sso !== 'boolean') bad('System ' + (i + 1) + ': single sign-on is yes or no.');
      out.systems.push({ id: id, name: name, sso: s.sso === true, steps: st, owner: owner });
    });
    var st0 = r.settings && typeof r.settings === 'object' && !Array.isArray(r.settings) ? r.settings : {};
    if (strict && r.settings !== undefined && st0 !== r.settings) bad('Settings must be an object.');
    if (strict) Object.keys(st0).forEach(function (k) { if (SET_KEYS.indexOf(k) < 0) bad('“' + line(k, 30) + '” is not a setting.'); });
    if (Array.isArray(st0.domains)) {
      if (st0.domains.length > LIMITS.domains && strict) bad('At most ' + LIMITS.domains + ' domains.');
      var doms = [];
      st0.domains.slice(0, LIMITS.domains).forEach(function (d) {
        var x = fold(line(d, 90)).replace(/^@/, '');
        if (/@/.test(str(d).replace(/^@/, ''))) { if (strict) bad('“' + clip(line(d, 40), 30) + '” is an address - a domain is the part after the @.'); return; }
        if (!HOST.test(x)) { if (strict) bad('“' + clip(line(d, 40), 30) + '” is not a domain.'); return; }
        if (doms.indexOf(x) < 0) doms.push(x);
      });
      out.settings.domains = doms;
    } else if (strict && st0.domains !== undefined) bad('Domains must be a list.');
    if (Array.isArray(st0.patterns)) {
      if (st0.patterns.length > LIMITS.patterns && strict) bad('At most ' + LIMITS.patterns + ' shared-account patterns.');
      var pats = [];
      st0.patterns.slice(0, LIMITS.patterns).forEach(function (p) {
        var x = str(p).trim().toLowerCase();
        if (looksLikePerson(x)) { if (strict) bad('“' + clip(line(p, 40), 30) + '” looks like a person’s address. Use a word like “reception” or a pattern like “svc-*”.'); return; }
        if (!/^[a-z0-9*_-]{2,40}$/.test(x) || /^\*+$/.test(x)) { if (strict) bad('“' + clip(line(p, 40), 30) + '” is not a pattern (letters, digits, - _ and *).'); return; }
        if (pats.indexOf(x) < 0) pats.push(x);
      });
      out.settings.patterns = pats;
    } else if (strict && st0.patterns !== undefined) bad('Patterns must be a list.');
    if (st0.dormantDays !== undefined) {
      var dd = Number(st0.dormantDays);
      if (Math.floor(dd) === dd && dd >= LIMITS.dormantMin && dd <= LIMITS.dormantMax) out.settings.dormantDays = dd;
      else if (strict) bad('Dormant means ' + LIMITS.dormantMin + ' to ' + LIMITS.dormantMax + ' days without activity.');
    }
    if (st0.idp !== undefined) { if (has(IDPS, str(st0.idp))) out.settings.idp = st0.idp; else if (strict) bad('That identity provider is not on the list.'); }
    if (strict && r.version !== undefined && r.version !== 1) bad('Unknown version.');
    return { inventory: out, errors: errors };
  }

  /** Two copies merged: every system from both (this device's wins when both
   *  have one of the same name), domains and patterns from both, this
   *  device's numbers. Returns {inventory, added}. */
  function mergeInventory(account, device) {
    var a = cleanInventory(account).inventory, d = cleanInventory(device).inventory;
    var out = cleanInventory(d).inventory, added = 0;
    var names = {};
    out.systems.forEach(function (s) { names[fold(s.name)] = 1; });
    a.systems.forEach(function (s) { if (!names[fold(s.name)] && out.systems.length < LIMITS.systems) { out.systems.push(s); names[fold(s.name)] = 1; added++; } });
    a.settings.domains.forEach(function (x) { if (out.settings.domains.indexOf(x) < 0 && out.settings.domains.length < LIMITS.domains) out.settings.domains.push(x); });
    a.settings.patterns.forEach(function (x) { if (out.settings.patterns.indexOf(x) < 0 && out.settings.patterns.length < LIMITS.patterns) out.settings.patterns.push(x); });
    out.updatedAt = Math.max(a.updatedAt, d.updatedAt);
    return { inventory: cleanInventory(out).inventory, added: added };
  }

  /** A sensible starting list for a small business, edited from there. */
  function starterSystems() {
    return [
      { id: 'idp', name: 'Identity provider', sso: true, steps: ['disable', 'sessions', 'mfa'], owner: 'msp' },
      { id: 'email', name: 'Email and calendar', sso: true, steps: ['sessions', 'tokens', 'mailbox', 'licence'], owner: 'msp' },
      { id: 'files', name: 'File storage', sso: true, steps: ['files', 'sessions'], owner: 'msp' },
      { id: 'devices', name: 'Laptops and phones', sso: false, steps: ['devices', 'hardware'], owner: 'msp' },
      { id: 'building', name: 'Door, alarm and Wi-Fi', sso: false, steps: ['rotate'], owner: 'office' },
    ];
  }

  /* ================================================================== *
   * The engine: the same steps in the worker and, without one, on the page
   * ================================================================== */

  /** A small stateful wrapper the worker (and the page, when there is no
   *  worker) drives: it keeps the parsed files and the last result, so a
   *  50,000-row export is read once. No clock, no storage, no network. */
  function createEngine() {
    var tables = {};
    var last = {};   // the last result per workspace (the demo's and one's own)
    return {
      parse: function (o) {
        var role = o.role === 'idp' ? 'idp' : 'app';
        var t = parseTable(o.text, { maxRows: LIMITS.rows });
        tables[o.id] = { role: role, t: t };
        var g = guessColumns(role, t.headers, t.rows, !t.header);
        return {
          id: o.id, role: role, name: line(o.name, 120), headers: t.headers, sample: t.rows.slice(0, 6), guess: g,
          idp: role === 'idp' ? guessIdp(t.headers) : null, appName: role === 'app' ? appNameFrom(o.name, o.n) : null,
          stats: { delimiter: t.delimiterName, header: t.header, preamble: t.preamble, total: t.total, kept: t.kept, truncated: t.truncated, ragged: t.ragged, invisible: t.invisible, cut: t.cut, openQuote: t.openQuote, empty: t.empty, wide: t.wide },
        };
      },
      drop: function (o) { delete tables[o.id]; return true; },
      analyse: function (o) {
        var it = tables[o.idp && o.idp.id];
        if (!it) throw new Error('Load the identity provider’s export first.');
        var settings = o.settings || DEFAULT_SETTINGS;
        var first = buildIdp(it.t, o.idp.map, {});
        var cd = companyDomains(settings, first.users);
        var aliases = aliasMap(cd.list);
        var I = buildIdp(it.t, o.idp.map, aliases);
        var apps = [], skipped = [];
        (o.apps || []).slice(0, LIMITS.apps).forEach(function (a) {
          var at = tables[a.id];
          if (!at) return;
          var A = buildApp(at.t, a.map, aliases);
          apps.push({ id: a.id, name: line(a.name, 40) || 'App', accounts: A.accounts });
          A.skipped.slice(0, 20).forEach(function (s) { skipped.push({ app: line(a.name, 40), line: s.line, why: s.why }); });
        });
        var res = findOrphans({ users: I.users, apps: apps, settings: settings, today: o.today, idp: o.idpKind || settings.idp, domains: cd.list });
        last[o.ws || 'own'] = { rows: res.rows, aliases: aliases };
        var findings = res.rows.filter(function (r) { return r.verdict !== 'ok'; });
        var ok = res.rows.filter(function (r) { return r.verdict === 'ok'; });
        return {
          summary: res.summary, people: res.people, apps: res.apps, findings: findings, ok: ok.slice(0, LIMITS.okSent), okTotal: ok.length,
          users: I.users.length, idpSkipped: I.skipped.slice(0, 20), skipped: skipped, domains: cd,
          names: I.users.slice(0, 20000).map(function (u) { return u.name; }).filter(function (n) { return nameKey(n); }),
          statusCounts: I.users.reduce(function (c, u) { c[u.status] = (c[u.status] || 0) + 1; return c; }, {}),
        };
      },
      lookup: function (o) { var l = last[o.ws || 'own']; return l ? accountsFor(l.rows, o.email, o.name, l.aliases) : []; },
    };
  }

  return {
    LIMITS: LIMITS, FIELDS: FIELDS, IDPS: IDPS, VERDICTS: VERDICTS, VERDICT_WORD: VERDICT_WORD, VERDICT_ICON: VERDICT_ICON, RANK: RANK, LEVEL_WORD: LEVEL_WORD,
    STEPS: STEPS, STEP_KEYS: STEP_KEYS, PHASES: PHASES, PHASE_WORD: PHASE_WORD, PHASE_WORD_INVOL: PHASE_WORD_INVOL, OWNERS: OWNERS, OWNER_KEYS: OWNER_KEYS, MAILBOX: MAILBOX, HARDWARE: HARDWARE,
    DEFAULT_PATTERNS: DEFAULT_PATTERNS, DEFAULT_SETTINGS: DEFAULT_SETTINGS, AI_FIELDS: AI_FIELDS, QUESTION: QUESTION,
    esc: esc, line: line, para: para, clip: clip, plural: plural, groups: groups, cap1: cap1, titleCase: titleCase, fold: fold, noMarkup: noMarkup,
    isDay: isDay, isTime: isTime, addDays: addDays, daysBetween: daysBetween, weekday: weekday, niceDay: niceDay, shortDay: shortDay, dayLabel: dayLabel, clockLabel: clockLabel, readDate: readDate, isNever: isNever, dateOrder: dateOrder, prevWorkday: prevWorkday,
    splitRows: splitRows, sniffDelimiter: sniffDelimiter, parseTable: parseTable,
    headerNorm: headerNorm, headerScore: headerScore, profile: profile, guessColumns: guessColumns, mappingProblems: mappingProblems, fieldKeys: fieldKeys, fieldOf: fieldOf, guessIdp: guessIdp, idpName: idpName, appNameFrom: appNameFrom,
    normEmail: normEmail, domainOf: domainOf, localOf: localOf, aliasMap: aliasMap, nameKey: nameKey, idpStatus: idpStatus, appRole: appRole, elevated: elevated, patternFits: patternFits, sharedWhy: sharedWhy,
    buildIdp: buildIdp, buildApp: buildApp, companyDomains: companyDomains, judge: judge, findOrphans: findOrphans, summarise: summarise, summaryLine: summaryLine, peopleOf: peopleOf, personLine: personLine, accountsFor: accountsFor, isOrphaned: isOrphaned,
    phaseOf: phaseOf, phaseWord: phaseWord, dueOf: dueOf, isOverdue: isOverdue, buildChecklist: buildChecklist, mergeTasks: mergeTasks, progress: progress, cleanLeaver: cleanLeaver, systemFor: systemFor, stepDetail: stepDetail,
    parseRequest: parseRequest, resolveDate: resolveDate, questionsFor: questionsFor, leaverFrom: leaverFrom,
    maskRequest: maskRequest, unmask: unmask, tokensIn: tokensIn, aiRequest: aiRequest, cleanAiAnswer: cleanAiAnswer,
    csvCell: csvCell, toCsv: toCsv, findingsRows: findingsRows, checklistRows: checklistRows, checklistJson: checklistJson, checklistMarkdown: checklistMarkdown, md: md,
    defaults: defaults, cleanInventory: cleanInventory, mergeInventory: mergeInventory, starterSystems: starterSystems,
    createEngine: createEngine,
  };
}));
