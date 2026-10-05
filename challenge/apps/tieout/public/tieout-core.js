/* Tieout - the rules, in one file the page, the server and the tests all run.
 *
 * UMD: the page loads it as window.TieoutCore, the server and the tests
 * require() it. Everything that decides whether a statement ties out lives
 * here: money and dates, cleaning a model's reading (and masking account
 * numbers in it), the checks and the diagnosis that names the wrong row, the
 * fixes, reading a bank CSV, the month-to-month chain for a merged export,
 * and the four export formats. No DOM, no network, no clock of its own.
 *
 * Money is integer cents throughout, read from the digits and never through
 * a float. A row's `amount` is signed the way money moved for the account
 * holder: positive in (a deposit, a card payment or refund), negative out (a
 * withdrawal, a card purchase). A statement's balances are as printed: on a
 * checking or savings account money in raises the balance; on a credit card
 * or line of credit the balance is what is owed, so money in lowers it.
 * `dirOf(type)` is that one difference, and every sum goes through it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TieoutCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    rows: 2000,               // one statement
    pages: 15,                // one PDF, or photos of one statement
    photos: 15,
    pdfBytes: 10 * 1024 * 1024,
    photoBytes: 3 * 1024 * 1024,
    photoTotal: 18 * 1024 * 1024,
    desc: 200,
    bank: 80,
    name: 80,
    note: 300,
    notes: 12,
    csvBytes: 5 * 1024 * 1024,
    statements: 24,           // kept on one device
    maxCents: 100000000000,   // $1,000,000,000.00 - any one figure
  };

  var TYPES = ['checking', 'savings', 'credit-card', 'line-of-credit', 'other'];
  var TYPE_LABEL = { checking: 'Checking', savings: 'Savings', 'credit-card': 'Credit card', 'line-of-credit': 'Line of credit', other: 'Account' };
  var CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'MXN', 'SGD', 'HKD', 'ZAR', 'INR', 'JPY'];
  var SYMBOL = { USD: '$', CAD: '$', AUD: '$', NZD: '$', SGD: '$', HKD: '$', MXN: '$', GBP: '£', EUR: '€', JPY: '¥', INR: '₹' };
  var DATE_FORMATS = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'];

  /** +1 when money in raises the printed balance; -1 when the balance is
   *  what is owed (a card or a line of credit). */
  function dirOf(type) { return type === 'credit-card' || type === 'line-of-credit' ? -1 : 1; }
  function isLiability(type) { return dirOf(type) < 0; }

  /* ---------------- text ---------------- */

  /** Markup, control and direction-override characters out, spaces folded. */
  function scrub(s) {
    return String(s)
      .replace(/<[^>]*>?/g, ' ')
      .replace(/[<>]/g, '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function clean(v, max) {
    if (typeof v !== 'string' && typeof v !== 'number') return '';
    var lim = max || 200;
    var s = scrub(String(v).slice(0, lim * 4 + 32));
    if (s.length > lim) s = Array.from(s).slice(0, lim).join('').trim();
    return s;
  }
  /**
   * Account and card numbers out of any text: a run of eight or more digits
   * (spaces or dashes between groups allowed) becomes "••••" and its last
   * four. An ISO date is left alone. A model is asked for the last four only;
   * this is the server not trusting it to.
   */
  function maskNumbers(s) {
    return String(s).replace(/\d(?:[ -]?\d){7,}/g, function (m) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(m)) return m;
      var d = m.replace(/\D/g, '');
      return '••••' + d.slice(-4);
    });
  }
  /** Free text from outside: cleaned, bounded, numbers masked. */
  function text(v, max) { return clean(maskNumbers(clean(v, (max || 200) + 40)), max || 200); }
  /** Only the last four digits of whatever was given. */
  function last4(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    return d.length >= 4 ? d.slice(-4) : '';
  }
  function oneOf(v, list, dflt) { return list.indexOf(v) >= 0 ? v : dflt; }

  /* ---------------- money ---------------- */

  /**
   * A money string's digits: {neg, cents} or null. "$1,240.00", "(12.40)",
   * "-12.40", "12.40-", "−12.40", "1.240,00", "12,40", "1,240.00 CR" (in),
   * "45.00 DR" (out). More than two decimal places, letters left over, or
   * no digit at all is no figure: a statement prints cents, and a third
   * decimal is a misreading, not a fraction of a cent.
   */
  function readMoney(v) {
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      var a = Math.abs(v);
      if (a >= 1e12) return null;
      var c = Math.round(a * 100);
      if (Math.abs(a * 100 - c) > 1e-6) return null;
      return { neg: v < 0, cents: c };
    }
    if (typeof v !== 'string') return null;
    var s = v.trim();
    if (!s || s.length > 40 || !/\d/.test(s)) return null;
    var neg = false, forced = null;
    var cd = /\s*\b(CR|DR)\.?$/i.exec(s);
    if (cd) { forced = cd[1].toUpperCase(); s = s.slice(0, cd.index).trim(); }
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    s = s.replace(/\b(?:usd|cad|aud|nzd|eur|gbp|chf|sek|nok|dkk|mxn|sgd|hkd|zar|inr|jpy|us\$)\b/gi, '').replace(/[$£€¥₹\s ]/g, '');
    if (/^[-−–]/.test(s)) { neg = !neg; s = s.slice(1); }
    if (/[-−–]$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
    if (/^\+/.test(s)) s = s.slice(1);
    if (!/^(?:\d[\d,.]*|[.,]\d+)$/.test(s)) return null;
    var dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
    var dec = null;
    if (dot >= 0 && comma >= 0) dec = dot > comma ? '.' : ',';
    else if (comma >= 0) dec = (s.indexOf(',') === comma && s.length - comma - 1 <= 2) ? ',' : null;
    else if (dot >= 0) dec = s.indexOf('.') === dot ? '.' : null;
    if (dec === null && dot >= 0) return null; // "1.234.567" - thousands dots with no decimals: too odd to guess
    var whole = s, frac = '';
    if (dec) { var at = s.lastIndexOf(dec); whole = s.slice(0, at); frac = s.slice(at + 1); }
    if (frac.length > 2) return null;
    // Thousands separators must be in thousands.
    if (/[.,]/.test(whole) && !/^\d{1,3}(?:[.,]\d{3})+$/.test(whole)) return null;
    whole = whole.replace(/[.,]/g, '');
    if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
    if (whole.length > 12) return null;
    var cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
    if (forced === 'CR') neg = false;
    if (forced === 'DR') neg = true;
    return { neg: neg, cents: cents };
  }
  /** Signed cents, or null - within the one-figure ceiling. */
  function toCents(v) {
    var m = readMoney(v);
    if (!m || m.cents > LIMITS.maxCents) return null;
    return m.neg && m.cents ? -m.cents : m.cents;
  }
  function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /** "1,240.00" - no sign, no symbol. */
  function fmtAbs(cents) {
    var c = Math.abs(Math.round(Number(cents) || 0));
    return groups(Math.floor(c / 100)) + '.' + ('0' + (c % 100)).slice(-2);
  }
  /** "$1,240.00" / "−$12.40" / "SEK 1,240.00". */
  function money(cents, currency) {
    var c = Math.round(Number(cents) || 0);
    var sym = SYMBOL[currency || 'USD'];
    var body = fmtAbs(c);
    return (c < 0 ? '−' : '') + (sym ? sym + body : (currency || 'USD') + ' ' + body);
  }
  /** "-1240.00" - what a spreadsheet or an importer reads. */
  function plain(cents) {
    var c = Math.round(Number(cents) || 0);
    var a = Math.abs(c);
    return (c < 0 ? '-' : '') + Math.floor(a / 100) + '.' + ('0' + (a % 100)).slice(-2);
  }
  /** "−1,240.00" / "+842.15" as the review table shows an amount. */
  function signed(cents) { return (cents < 0 ? '−' : '+') + fmtAbs(cents); }

  /* ---------------- dates ---------------- */

  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function ymd(y, m, d) {
    if (y < 100) y += 2000;
    if (y < 1990 || y > 2100) return null;
    var t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
    return t.toISOString().slice(0, 10);
  }
  function isoDay(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && ymd(+v.slice(0, 4), +v.slice(5, 7), +v.slice(8, 10)) === v; }
  function dayNum(iso) { return Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000); }
  function addDays(iso, n) { return new Date((dayNum(iso) + n) * 86400000).toISOString().slice(0, 10); }
  function monthMatch(word) { var i = MONTHS.indexOf(String(word || '').toLowerCase().slice(0, 3)); return i < 0 ? 0 : i + 1; }
  /** A date as a statement or a bank CSV writes one: ISO, MM/DD/YYYY (or
   *  day first when told), DD.MM.YYYY, YYYYMMDD, "Sep 12, 2026", "12 Sep 2026". */
  function parseDate(v, dayFirst) {
    var s = String(v == null ? '' : v).trim();
    var m;
    if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:$|\s)/.exec(s))) return dayFirst ? ymd(+m[3], +m[2], +m[1]) : ymd(+m[3], +m[1], +m[2]);
    if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:$|\s)/.exec(s))) return ymd(+m[3], +m[2], +m[1]);
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(s))) return monthMatch(m[1]) ? ymd(+m[3], monthMatch(m[1]), +m[2]) : null;
    if ((m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s,-]+(\d{2,4})$/.exec(s))) return monthMatch(m[2]) ? ymd(+m[3], monthMatch(m[2]), +m[1]) : null;
    return null;
  }
  /** "Sep 14" (with the year when it differs from `year`). */
  function fmtDay(iso, year) {
    if (!isoDay(iso)) return '';
    return MON[+iso.slice(5, 7) - 1] + ' ' + (+iso.slice(8, 10)) + (year && iso.slice(0, 4) !== String(year) ? ', ' + iso.slice(0, 4) : '');
  }
  /** "Sep 1 – Sep 30, 2026". */
  function fmtPeriod(a, b) {
    if (!isoDay(a) || !isoDay(b)) return isoDay(a) ? 'From ' + fmtDay(a) + ', ' + a.slice(0, 4) : isoDay(b) ? 'To ' + fmtDay(b) + ', ' + b.slice(0, 4) : 'Period not read';
    return fmtDay(a, b.slice(0, 4)) + ' – ' + fmtDay(b) + ', ' + b.slice(0, 4);
  }
  /** "September 2026" for a statement that is one calendar month (or ends in it). */
  function monthName(st) {
    var d = st.end || st.start;
    return isoDay(d) ? MONTH_LONG[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4) : '';
  }
  function fmtDate(iso, format) {
    if (!isoDay(iso)) return '';
    var y = iso.slice(0, 4), m = iso.slice(5, 7), d = iso.slice(8, 10);
    if (format === 'DD/MM/YYYY') return d + '/' + m + '/' + y;
    if (format === 'YYYY-MM-DD') return iso;
    return m + '/' + d + '/' + y;
  }

  /* ---------------- a statement, cleaned ---------------- */

  // Lines a statement prints that are not transactions. A model is told to
  // leave them out; one that slips through would double the opening balance.
  var NOT_A_ROW = /^(?:previous|beginning|opening|starting|ending|closing|new|daily)?\s*balance(?:\s+(?:brought|carried)\s+forward|\s+forward|\s+b\/?f|\s+c\/?f)?$|^balance\s+(?:brought|carried)\s+forward\b|^(?:brought|carried)\s+forward$|^(?:beginning|opening|ending|closing|previous|new)\s+balance\b|^(?:total|subtotal)s?\b/i;
  function isNotARow(desc) { return NOT_A_ROW.test(String(desc || '').trim()); }

  var ROW_ID = /^r\d{1,6}$/;
  var ST_ID = /^[a-z][a-z0-9-]{2,40}$/;

  function newId(prefix) {
    var s = '';
    for (var i = 0; i < 10; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36));
    return (prefix || 's') + s;
  }
  function centsOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    var c = typeof v === 'number' && Number.isInteger(v) ? (Math.abs(v) <= LIMITS.maxCents ? v : null) : toCents(v);
    return c;
  }
  function pageOf(v) {
    var n = typeof v === 'string' && /^\d{1,2}$/.test(v.trim()) ? Number(v) : v;
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= LIMITS.pages ? n : null;
  }
  function cleanTotals(t) {
    if (!t || typeof t !== 'object') return null;
    var i = centsOrNull(t.in), o = centsOrNull(t.out);
    if (i === null && o === null) return null;
    return { in: i === null ? null : Math.abs(i), out: o === null ? null : Math.abs(o) };
  }

  /**
   * Any object shaped like a statement -> one that is safe to keep and draw:
   * known fields only, every string cleaned and bounded, numbers masked, every
   * figure integer cents within the ceiling, dates real, at most 2,000 rows
   * with unique ids. Cents here are already cents (integers); a string goes
   * through the money reader. Used on the model's reading, on a bank CSV, on
   * what this browser kept, and on every edit.
   */
  function cleanStatement(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var rowsIn = Array.isArray(r.rows) ? r.rows.slice(0, LIMITS.rows) : [];
    var seen = {}, next = 1;
    rowsIn.forEach(function (x) { if (x && ROW_ID.test(x.id)) next = Math.max(next, Number(x.id.slice(1)) + 1); });
    if (Number.isInteger(r.nextId) && r.nextId > next && r.nextId < 1e6) next = r.nextId;
    var rows = [];
    rowsIn.forEach(function (x) {
      if (!x || typeof x !== 'object') return;
      var id = ROW_ID.test(x.id) && !seen[x.id] ? x.id : 'r' + (next++);
      seen[id] = true;
      rows.push({
        id: id,
        date: isoDay(x.date) ? x.date : null,
        desc: text(x.desc, LIMITS.desc),
        amount: centsOrNull(x.amount),
        balance: centsOrNull(x.balance),
        page: pageOf(x.page),
      });
    });
    var pageTotals = [];
    (Array.isArray(r.pageTotals) ? r.pageTotals : []).slice(0, LIMITS.pages).forEach(function (p) {
      var pg = p && pageOf(p.page);
      var t = p && cleanTotals(p);
      if (pg && t && !pageTotals.some(function (q) { return q.page === pg; })) pageTotals.push({ page: pg, in: t.in, out: t.out });
    });
    return {
      id: typeof r.id === 'string' && ST_ID.test(r.id) ? r.id : newId('s'),
      name: text(r.name, LIMITS.name),
      src: oneOf(r.src, ['pdf', 'photo', 'csv', 'example'], 'csv'),
      bank: text(r.bank, LIMITS.bank),
      type: oneOf(r.type, TYPES, 'checking'),
      last4: last4(r.last4),
      currency: oneOf(String(r.currency || '').toUpperCase(), CURRENCIES, 'USD'),
      start: isoDay(r.start) ? r.start : null,
      end: isoDay(r.end) ? r.end : null,
      opening: centsOrNull(r.opening),
      closing: centsOrNull(r.closing),
      totals: cleanTotals(r.totals),
      pageTotals: pageTotals,
      rows: rows,
      nextId: next,
      notes: (Array.isArray(r.notes) ? r.notes : []).slice(0, LIMITS.notes).map(function (n) { return text(n, LIMITS.note); }).filter(Boolean),
      at: typeof r.at === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(r.at) ? r.at : null,
    };
  }

  /**
   * The model's `record_statement` answer -> {statement, notes} or null
   * (not a statement, or nothing read). Untrusted, all of it: every string
   * cleaned and masked, every figure through the money reader (more than
   * two decimals, words or a figure over $1B is no figure - the row is KEPT
   * with no amount, so the check says which row to type in rather than the
   * total silently going wrong), dates real or none, "balance forward" lines
   * left out with a note, at most 2,000 rows.
   */
  function fromModel(raw, opts) {
    var o = opts || {};
    if (!raw || typeof raw !== 'object' || raw.readable === false) return null;
    var notes = [];
    var rows = [], dropped = 0, badAmounts = 0, badDates = 0, forward = 0;
    var pages = Array.isArray(raw.pages) ? raw.pages : [];
    var pageTotals = [];
    for (var p = 0; p < pages.length && p < 40; p++) {
      var pg = pages[p] && typeof pages[p] === 'object' ? pages[p] : null;
      if (!pg) continue;
      var pageNo = pageOf(pg.page) || (o.page ? o.page : Math.min(p + 1, LIMITS.pages));
      var t = cleanTotals(pg.pageTotals ? { in: pg.pageTotals.moneyIn, out: pg.pageTotals.moneyOut } : null);
      if (t) pageTotals.push({ page: pageNo, in: t.in, out: t.out });
      var txs = Array.isArray(pg.transactions) ? pg.transactions : [];
      for (var i = 0; i < txs.length; i++) {
        var x = txs[i];
        if (!x || typeof x !== 'object') { dropped++; continue; }
        if (rows.length >= LIMITS.rows) { dropped++; continue; }
        var desc = text(x.description, LIMITS.desc);
        if (isNotARow(desc)) { forward++; continue; }
        var amount = toCents(typeof x.amount === 'number' || typeof x.amount === 'string' ? x.amount : '');
        var date = isoDay(x.date) ? x.date : parseDate(typeof x.date === 'string' ? x.date : '');
        if (amount === null) badAmounts++;
        if (!date) badDates++;
        rows.push({ id: 'r' + (rows.length + 1), date: date, desc: desc, amount: amount, balance: toCents(x.balance === null || x.balance === undefined ? '' : x.balance), page: pageNo });
      }
    }
    if (rows.length >= LIMITS.rows && dropped) notes.push('This statement has more than ' + LIMITS.rows.toLocaleString('en-US') + ' rows; the first ' + LIMITS.rows.toLocaleString('en-US') + ' were read.');
    else if (dropped) notes.push(dropped + ' unreadable ' + (dropped === 1 ? 'entry was' : 'entries were') + ' left out.');
    if (forward) notes.push('Left out ' + forward + ' “balance forward” or total ' + (forward === 1 ? 'line' : 'lines') + ' - they are not transactions.');
    if (badAmounts) notes.push(badAmounts + ' ' + (badAmounts === 1 ? 'row’s amount' : 'rows’ amounts') + ' could not be read as money - type ' + (badAmounts === 1 ? 'it' : 'them') + ' in from the statement.');
    if (badDates) notes.push(badDates + ' ' + (badDates === 1 ? 'row has' : 'rows have') + ' no readable date.');
    var note = text(raw.note, LIMITS.note);
    if (note) notes.unshift(note);
    var st = cleanStatement({
      src: o.src, name: o.name,
      bank: raw.bank, type: raw.accountType, last4: raw.accountLast4, currency: raw.currency,
      start: isoDay(raw.periodStart) ? raw.periodStart : parseDate(raw.periodStart),
      end: isoDay(raw.periodEnd) ? raw.periodEnd : parseDate(raw.periodEnd),
      opening: toCents(raw.openingBalance == null ? '' : raw.openingBalance),
      closing: toCents(raw.closingBalance == null ? '' : raw.closingBalance),
      totals: raw.totals && typeof raw.totals === 'object' ? { in: raw.totals.moneyIn, out: raw.totals.moneyOut } : null,
      pageTotals: pageTotals,
      rows: rows,
      notes: notes,
      at: o.at,
    });
    if (!st.rows.length && st.opening === null && st.closing === null) return null;
    return { statement: st, notes: st.notes };
  }

  /** One page re-read -> its rows (page set), for `replacePage`. */
  function pageFromModel(raw, page) {
    var r = fromModel({ readable: raw && raw.readable, pages: [{ page: page, transactions: raw && raw.transactions, pageTotals: raw && raw.pageTotals }], note: raw && raw.note }, { page: page });
    if (!r) return null;
    r.statement.rows.forEach(function (x) { x.page = page; });
    return { rows: r.statement.rows, pageTotals: r.statement.pageTotals.filter(function (t) { return t.page === page; })[0] || null, notes: r.notes };
  }

  /* ---------------- the checks ---------------- */

  function rowNo(st, id) { for (var i = 0; i < st.rows.length; i++) if (st.rows[i].id === id) return i + 1; return 0; }
  function descKey(d) { return String(d || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function sameRow(a, b) { return a && b && a.amount !== null && a.amount === b.amount && a.date === b.date && descKey(a.desc) === descKey(b.desc); }

  function digitsOf(c) { return String(Math.abs(c)); }
  /** How `read` relates to `want` (both cents), as a misreading - or null. */
  function relation(read, want) {
    if (read === want) return null;
    if (want === -read) return 'sign';
    if (read === 0 || want === 0) return null;
    if ((read < 0) !== (want < 0)) return null;
    var a = Math.abs(read), b = Math.abs(want);
    for (var k = 10; k <= 1000; k *= 10) if (a * k === b || b * k === a) return 'decimal';
    var x = digitsOf(read), y = digitsOf(want);
    if (x.length !== y.length) return null;
    var diff = [];
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) diff.push(i);
    if (diff.length === 2 && diff[1] === diff[0] + 1 && x[diff[0]] === y[diff[1]] && x[diff[1]] === y[diff[0]]) return 'swap';
    if (diff.length === 1) return 'digit';
    return null;
  }
  var RANK = { duplicate: 0, decimal: 1, sign: 2, swap: 3, digit: 4 };

  function inOut(a) { return a < 0 ? 'money out' : 'money in'; }

  /**
   * The rows in `idx` that one misreading would explain, given that the
   * effect on the balance must move by `D` cents. For each row the amount
   * that would do it is a' = a + dir·D; what matters is how a' relates to
   * what was read - a flipped sign, a slipped decimal point, two digits
   * swapped, one digit misread - or that the row is a repeat of its
   * neighbour and should not be there at all.
   */
  function candidates(st, idx, D, opts) {
    var dir = dirOf(st.type), rows = st.rows, out = [];
    idx.forEach(function (i) {
      var r = rows[i];
      if (!r || r.amount === null) return;
      var want = r.amount + dir * D;
      var n = i + 1;
      if (want === 0) {
        var twin = sameRow(rows[i - 1], r) ? i - 1 : sameRow(rows[i + 1], r) ? i + 1 : -1;
        if (twin >= 0) {
          var across = rows[twin].page !== r.page && rows[twin].page && r.page;
          out.push({ kind: 'duplicate', i: i, text: 'Row ' + n + ' looks like row ' + (twin + 1) + ' read twice' + (across ? ' across the page break' : '') + '.', fix: { op: 'delete', row: r.id, label: 'Remove row ' + n } });
        }
        return;
      }
      var rel = relation(r.amount, want);
      if (!rel || (rel === 'digit' && opts && opts.noDigit)) return;
      var t;
      if (rel === 'sign') t = 'Row ' + n + ' looks like ' + inOut(want) + ' read as ' + inOut(r.amount) + ' (' + fmtAbs(r.amount) + ').';
      else if (rel === 'decimal') t = 'Row ' + n + ' looks like ' + fmtAbs(want) + ' read as ' + fmtAbs(r.amount) + ' - a slipped decimal point.';
      else if (rel === 'swap') t = 'Row ' + n + ' looks like ' + fmtAbs(want) + ' read as ' + fmtAbs(r.amount) + ' - two digits swapped.';
      else t = 'Row ' + n + ' looks like ' + fmtAbs(want) + ' read as ' + fmtAbs(r.amount) + ' - one digit misread.';
      out.push({ kind: rel, i: i, text: t, fix: { op: 'amount', row: r.id, value: want, label: 'Make row ' + n + ' ' + signed(want) } });
    });
    out.sort(function (a, b) { return RANK[a.kind] - RANK[b.kind] || a.i - b.i; });
    if (!out.length) return out;
    var best = RANK[out[0].kind];
    var top = out.filter(function (c) { return RANK[c.kind] === best; });
    // One digit misread fits too many rows to name unless it is the only fit.
    if (out[0].kind === 'digit' && top.length > 1) return [];
    return top;
  }

  /** A sentence for what the arithmetic says is wrong in rows idx[...]. */
  function diagnose(st, idx, D, where) {
    var dir = dirOf(st.type);
    var c = candidates(st, idx, D, where && where.noDigit ? { noDigit: true } : null);
    var missing = dir * D; // the flow amount a missing row would have
    var at = where && where.before !== undefined ? where.before : null;
    var miss = {
      kind: 'missing',
      text: 'A row of ' + fmtAbs(missing) + ' ' + inOut(missing) + ' looks missing' + (at !== null && st.rows[at] ? ' before row ' + (at + 1) + (st.rows[at].date ? ' (' + fmtDay(st.rows[at].date) + ')' : '') : '') + '.',
      fix: { op: 'insert', before: at !== null && st.rows[at] ? st.rows[at].id : null, value: missing, date: at !== null && st.rows[at] ? st.rows[at].date : (st.end || null), label: 'Add a ' + fmtAbs(missing) + ' row' },
    };
    if (!c.length) return { best: miss, all: [miss], sure: false };
    if (c.length === 1) return { best: c[0], all: [c[0]], sure: true };
    return { best: c[0], all: c.slice(0, 3), sure: false };
  }

  /**
   * Every check on one statement -> the result the page draws:
   *   status   'ties' | 'off' | 'incomplete'
   *   headline "Ties out ✓" / "Off by $1,227.60" / "Can’t prove it yet"
   *   sub      the sentence that says why (the row, the fix)
   *   checks   [{id, status: pass|look|fail, title, text, fixes}]
   *   flags    {rowId: [{status, text, fixes}]}
   *   primary  the one fix to offer first, or null
   * plus the sums (moneyIn, moneyOut, computed, diff) for the proof line.
   */
  function check(st) {
    var rows = st.rows, dir = dirOf(st.type), cur = st.currency;
    var checks = [], flags = {};
    var flag = function (id, status, t, fixes) { (flags[id] = flags[id] || []).push({ status: status, text: t, fixes: fixes || [] }); };
    var moneyIn = 0, moneyOut = 0, nullAmt = [];
    rows.forEach(function (r, i) {
      if (r.amount === null) { nullAmt.push(i); return; }
      if (r.amount > 0) moneyIn += r.amount; else moneyOut -= r.amount;
    });
    var net = moneyIn - moneyOut;
    var computed = st.opening === null ? null : st.opening + dir * net;
    var amountsKnown = !nullAmt.length;
    var diff = (computed !== null && st.closing !== null && amountsKnown) ? st.closing - computed : null;
    var all = rows.map(function (_, i) { return i; });
    var primary = null;

    // ---- amounts that could not be read
    if (nullAmt.length) {
      nullAmt.forEach(function (i) { flag(rows[i].id, 'fail', 'No amount - type it in from the statement.'); });
      checks.push({ id: 'amounts', status: 'fail', title: 'Every row has an amount', text: (nullAmt.length === 1 ? 'Row ' + (nullAmt[0] + 1) + ' has' : 'Rows ' + nullAmt.slice(0, 5).map(function (i) { return i + 1; }).join(', ') + (nullAmt.length > 5 ? ' and ' + (nullAmt.length - 5) + ' more' : '') + ' have') + ' no amount - type ' + (nullAmt.length === 1 ? 'it' : 'them') + ' in from the statement.', rows: nullAmt.map(function (i) { return rows[i].id; }) });
    }

    // ---- running balance, row by row, where the statement prints one
    var breaks = [], printed = 0, matched = 0;
    var prev = st.opening, from = 0, known = st.opening !== null, sumOk = true, acc = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.amount === null) sumOk = false; else acc += dir * r.amount;
      if (r.balance !== null) {
        printed++;
        if (known && sumOk) {
          var exp = prev + acc;
          if (exp !== r.balance) breaks.push({ from: from, to: i, end: 'row', expected: exp, printed: r.balance, diff: r.balance - exp, start: prev });
          else matched++;
        }
        prev = r.balance; known = true; from = i + 1; sumOk = true; acc = 0;
      }
    }
    if (printed && known && sumOk && st.closing !== null) {
      var expC = prev + acc;
      if (expC !== st.closing) breaks.push({ from: from, to: rows.length - 1, end: 'closing', expected: expC, printed: st.closing, diff: st.closing - expC, start: prev });
    }

    // A printed balance misread on its own: the segment into it is off by e
    // and the one out of it by -e, while the amounts themselves add up.
    var explained = [];
    for (var b = 0; b + 1 < breaks.length; b++) {
      var b1 = breaks[b], b2 = breaks[b + 1];
      if (b1.end === 'row' && b2.from === b1.to + 1 && b1.diff === -b2.diff && (diff === 0 || diff === null)) {
        var rid = rows[b1.to].id, n1 = b1.to + 1;
        var fx = { op: 'balance', row: rid, value: b1.expected, label: 'Make row ' + n1 + '’s balance ' + fmtAbs(b1.expected) };
        b1.diag = { best: { kind: 'balance', text: 'Row ' + n1 + '’s printed balance looks misread: ' + fmtAbs(b1.printed) + ', where the rows around it say ' + fmtAbs(b1.expected) + '.', fix: fx }, all: [], sure: true };
        b1.diag.all = [b1.diag.best];
        explained.push(b + 1);
        b++;
      }
    }
    breaks.forEach(function (bk, k) {
      if (explained.indexOf(k) >= 0) { bk.skip = true; return; }
      if (bk.diag) return;
      var idx = [];
      for (var j = bk.from; j <= bk.to; j++) idx.push(j);
      var D = bk.diff;
      if (bk.end === 'closing' && !idx.length) {
        var fxC = { op: 'closing', value: bk.expected, label: 'Make the closing balance ' + fmtAbs(bk.expected) };
        bk.diag = { best: { kind: 'closing', text: 'The closing balance looks misread: the last printed balance is ' + fmtAbs(bk.expected) + ' and nothing comes after it.', fix: fxC }, all: [], sure: true };
        bk.diag.all = [bk.diag.best];
        return;
      }
      bk.diag = diagnose(st, idx, D, { before: bk.end === 'row' ? bk.to : rows.length });
      // The first stretch hangs off the opening balance, which can be the
      // misread figure itself.
      if (bk.from === 0 && !bk.diag.sure && st.opening !== null) {
        var op = st.opening + D;
        var fxO = { op: 'opening', value: op, label: 'Make the opening balance ' + fmtAbs(op) };
        bk.diag.all = [{ kind: 'opening', text: 'Or the opening balance was misread: ' + fmtAbs(st.opening) + ', where the first printed balance says ' + fmtAbs(op) + '.', fix: fxO }].concat(bk.diag.all);
        bk.diag.all = [bk.diag.all[1], bk.diag.all[0]].concat(bk.diag.all.slice(2));
      }
    });
    var realBreaks = breaks.filter(function (bk) { return !bk.skip; });
    realBreaks.forEach(function (bk) {
      var where = bk.end === 'row' ? 'row ' + (bk.to + 1) : 'the closing balance';
      var t = 'The running balance breaks at ' + where + ': the rows say ' + fmtAbs(bk.expected) + ', the statement prints ' + fmtAbs(bk.printed) + ' (' + (bk.diff > 0 ? '+' : '−') + fmtAbs(bk.diff) + ').';
      var fixes = bk.diag.all.map(function (c) { return c.fix; });
      if (bk.end === 'row') flag(rows[bk.to].id, 'fail', 'Balance doesn’t follow: the rows say ' + fmtAbs(bk.expected) + '.', []);
      bk.diag.all.forEach(function (c) {
        if (c.fix && c.fix.row) flag(c.fix.row, 'fail', c.text, [c.fix]);
        else if (c.fix && c.fix.op === 'insert' && c.fix.before) flag(c.fix.before, 'fail', c.text, [c.fix]);
      });
      bk.text = t; bk.fixes = fixes;
    });
    if (printed) {
      if (!realBreaks.length && (matched || printed)) {
        checks.push({ id: 'running', status: matched ? 'pass' : 'look', title: 'Running balance, row by row', text: matched ? matched + ' printed ' + (matched === 1 ? 'balance follows' : 'balances follow') + ' from the rows before ' + (matched === 1 ? 'it' : 'them') + ', to the cent.' : 'The printed balances could not be followed - some amounts are missing.' });
      } else {
        realBreaks.forEach(function (bk, k) {
          checks.push({ id: 'running' + (k ? ':' + k : ''), status: 'fail', title: 'Running balance, row by row', text: bk.text + ' ' + bk.diag.all.map(function (c) { return c.text; }).join(' '), fixes: bk.fixes, row: bk.end === 'row' ? rows[bk.to].id : null });
        });
      }
    } else if (rows.length) {
      checks.push({ id: 'running', status: 'pass', title: 'Running balance, row by row', text: 'This statement prints no running balance, so the total below is the proof.', na: true });
    }

    // ---- the printed totals (the statement's own summary, and per page)
    var totalHint = null;
    if (st.totals && amountsKnown) {
      var tin = st.totals.in, tout = st.totals.out;
      var offIn = tin !== null ? tin - moneyIn : 0, offOut = tout !== null ? tout - moneyOut : 0;
      var lab = isLiability(st.type) ? ['payments and credits', 'purchases and charges'] : ['deposits', 'withdrawals'];
      if (!offIn && !offOut) checks.push({ id: 'summary', status: 'pass', title: 'The statement’s own totals', text: 'Total ' + lab[0] + (tin !== null ? ' ' + fmtAbs(tin) : '') + ' and ' + lab[1] + (tout !== null ? ' ' + fmtAbs(tout) : '') + ' match the rows.' });
      else {
        var parts = [];
        if (offIn) parts.push('total ' + lab[0] + ' print as ' + fmtAbs(tin) + '; the rows add up to ' + fmtAbs(moneyIn));
        if (offOut) parts.push('total ' + lab[1] + ' print as ' + fmtAbs(tout) + '; the rows add up to ' + fmtAbs(moneyOut));
        checks.push({ id: 'summary', status: 'fail', title: 'The statement’s own totals', text: 'The ' + parts.join(', and the ') + '.' });
        totalHint = { offIn: offIn, offOut: offOut };
      }
    }
    var pageHint = null;
    (st.pageTotals || []).forEach(function (pt) {
      if (!amountsKnown) return;
      var pin = 0, pout = 0, has = false;
      rows.forEach(function (r) { if (r.page === pt.page && r.amount !== null) { has = true; if (r.amount > 0) pin += r.amount; else pout -= r.amount; } });
      if (!has) return;
      var bad = (pt.in !== null && pt.in !== pin) || (pt.out !== null && pt.out !== pout);
      checks.push({ id: 'page:' + pt.page, status: bad ? 'fail' : 'pass', title: 'Page ' + pt.page + ' totals', text: bad ? 'Page ' + pt.page + ' prints ' + [pt.in !== null ? fmtAbs(pt.in) + ' in' : '', pt.out !== null ? fmtAbs(pt.out) + ' out' : ''].filter(Boolean).join(' and ') + '; its rows add up to ' + fmtAbs(pin) + ' in and ' + fmtAbs(pout) + ' out.' : 'Page ' + pt.page + '’s printed totals match its rows.' });
      if (bad && !pageHint) pageHint = pt.page;
    });

    // ---- the total: opening + every row = closing
    var totalDiag = null;
    if (diff === null) {
      var why = [];
      if (st.opening === null) why.push('the opening balance');
      if (st.closing === null) why.push('the closing balance');
      checks.push({ id: 'total', status: 'fail', title: 'Opening + every row = closing', text: why.length ? 'Type ' + why.join(' and ') + ' from the statement to prove it.' : 'Some rows have no amount yet.' });
    } else if (diff === 0) {
      checks.push({ id: 'total', status: 'pass', title: 'Opening + every row = closing', text: fmtAbs(st.opening) + (dir > 0 ? ' + ' + fmtAbs(moneyIn) + ' in − ' + fmtAbs(moneyOut) + ' out' : ' − ' + fmtAbs(moneyIn) + ' paid + ' + fmtAbs(moneyOut) + ' charged') + ' = ' + fmtAbs(st.closing) + ', to the cent.' });
    } else {
      if (realBreaks.length) {
        totalDiag = realBreaks[0].diag;
      } else {
        // No running balance to point at a stretch: the whole statement, or
        // the page or the side of the summary that is off.
        var idx2 = all;
        if (pageHint) idx2 = all.filter(function (i) { return rows[i].page === pageHint; });
        if (totalHint && totalHint.offIn && !totalHint.offOut) idx2 = idx2.filter(function (i) { return rows[i].amount !== null && rows[i].amount >= 0; });
        if (totalHint && totalHint.offOut && !totalHint.offIn) idx2 = idx2.filter(function (i) { return rows[i].amount !== null && rows[i].amount <= 0; });
        totalDiag = diagnose(st, idx2, diff, { noDigit: !pageHint && !totalHint });
        totalDiag.all.forEach(function (c) {
          if (c.fix && c.fix.row) flag(c.fix.row, 'fail', c.text, [c.fix]);
        });
      }
      checks.push({ id: 'total', status: 'fail', title: 'Opening + every row = closing', text: 'Opening ' + fmtAbs(st.opening) + ' and the rows come to ' + fmtAbs(computed) + ', but the closing balance is ' + fmtAbs(st.closing) + ' - off by ' + fmtAbs(diff) + '.' + (realBreaks.length ? '' : ' ' + totalDiag.all.map(function (c) { return c.text; }).join(' ')), fixes: realBreaks.length ? [] : totalDiag.all.map(function (c) { return c.fix; }) });
    }

    // ---- dates: present, inside the period, in order
    var noDate = [], outside = [], back = [];
    rows.forEach(function (r, i) {
      if (!r.date) { noDate.push(i); return; }
      if ((st.start && r.date < st.start) || (st.end && r.date > st.end)) outside.push(i);
      for (var k = i - 1; k >= 0; k--) if (rows[k].date) { if (r.date < rows[k].date) back.push(i); break; }
    });
    noDate.forEach(function (i) { flag(rows[i].id, 'fail', 'No date - type it in from the statement.'); });
    outside.forEach(function (i) { flag(rows[i].id, 'look', fmtDay(rows[i].date, (st.end || '').slice(0, 4)) + ' is outside the statement period.'); });
    var listRows = function (a) { return a.slice(0, 4).map(function (i) { return i + 1; }).join(', ') + (a.length > 4 ? ' and ' + (a.length - 4) + ' more' : ''); };
    if (noDate.length) checks.push({ id: 'dates', status: 'fail', title: 'Every row has a date', text: (noDate.length === 1 ? 'Row ' : 'Rows ') + listRows(noDate) + (noDate.length === 1 ? ' has' : ' have') + ' no date.' });
    if (!st.start || !st.end) checks.push({ id: 'period', status: 'look', title: 'Dates inside the period', text: 'The statement period wasn’t read - add it so every date can be checked.' });
    else if (outside.length) checks.push({ id: 'period', status: 'look', title: 'Dates inside the period', text: (outside.length === 1 ? 'Row ' : 'Rows ') + listRows(outside) + ' fall' + (outside.length === 1 ? 's' : '') + ' outside ' + fmtPeriod(st.start, st.end) + (isLiability(st.type) ? ' - fine for a purchase that posted inside it.' : ' - check the year was read right.') });
    else if (rows.length) checks.push({ id: 'period', status: 'pass', title: 'Dates inside the period', text: 'Every date is inside ' + fmtPeriod(st.start, st.end) + '.' });
    if (back.length === 1) {
      flag(rows[back[0]].id, 'look', 'Goes back in time from the row before - check it is on the right page.');
      checks.push({ id: 'order', status: 'look', title: 'Rows in date order', text: 'Row ' + (back[0] + 1) + ' (' + fmtDay(rows[back[0]].date) + ') comes after a later date - check it was read on the right page.' });
    } else if (back.length > 1) {
      checks.push({ id: 'order', status: 'look', title: 'Rows in date order', text: 'Dates go backwards in ' + back.length + ' places - normal for a statement that lists deposits, withdrawals and checks separately.' });
    } else if (rows.length > 1) checks.push({ id: 'order', status: 'pass', title: 'Rows in date order', text: 'Every row is in date order.' });

    // ---- the same row on both sides of a page break
    var dupes = [];
    for (var d = 1; d < rows.length; d++) {
      if (rows[d].page && rows[d - 1].page && rows[d].page !== rows[d - 1].page && sameRow(rows[d - 1], rows[d])) dupes.push(d);
    }
    dupes.forEach(function (i) {
      var fxD = { op: 'delete', row: rows[i].id, label: 'Remove row ' + (i + 1) };
      if (!(flags[rows[i].id] || []).some(function (f) { return f.fixes.some(function (x) { return x.op === 'delete'; }); })) flag(rows[i].id, 'look', 'Repeats row ' + i + ' across the page break - pages often carry their last line over.', [fxD]);
    });
    if (dupes.length) checks.push({ id: 'dupes', status: 'look', title: 'No repeats across page breaks', text: dupes.map(function (i) { return 'Row ' + (i + 1) + ' repeats row ' + i + ' across the break from page ' + rows[i - 1].page + ' to ' + rows[i].page + '.'; }).join(' ') + ' If the total is off by the same amount, remove it.', fixes: dupes.map(function (i) { return { op: 'delete', row: rows[i].id, label: 'Remove row ' + (i + 1) }; }) });
    else if (rows.some(function (r) { return r.page && r.page > 1; })) checks.push({ id: 'dupes', status: 'pass', title: 'No repeats across page breaks', text: 'No row repeats across a page break.' });

    // ---- the verdict
    var ties = diff === 0 && !realBreaks.length && !(st.totals && totalHint) && !checks.some(function (c) { return /^page:/.test(c.id) && c.status === 'fail'; });
    var fails = checks.filter(function (c) { return c.status === 'fail'; }).length;
    var looks = checks.filter(function (c) { return c.status === 'look'; }).length;
    var status, headline, sub;
    if (!rows.length) {
      status = 'incomplete'; headline = 'No rows yet'; sub = 'Nothing was read from this statement.';
    } else if (diff === null) {
      status = 'incomplete'; headline = 'Can’t prove it yet';
      sub = checks.filter(function (c) { return c.id === 'total' || c.id === 'amounts'; }).map(function (c) { return c.text; })[0] || '';
    } else if (ties) {
      status = 'ties'; headline = 'Ties out ✓';
      sub = 'Opening ' + money(st.opening, cur) + ' and ' + rows.length + ' rows come to the closing ' + money(st.closing, cur) + ', to the penny' + (matched ? ', and ' + matched + ' printed ' + (matched === 1 ? 'balance follows' : 'balances follow') + ' row by row' : '') + '.';
      if (fails) sub += ' ' + fails + ' thing' + (fails === 1 ? '' : 's') + ' to fix before export.';
      else if (looks) sub += ' ' + looks + ' thing' + (looks === 1 ? '' : 's') + ' to look at.';
    } else {
      status = 'off';
      var off = diff !== 0 ? diff : realBreaks.length ? realBreaks[0].diff : 0;
      headline = off ? 'Off by ' + money(Math.abs(off), cur) : 'Doesn’t tie out';
      var dg = totalDiag || (realBreaks[0] && realBreaks[0].diag) || null;
      if (!dg && totalHint) sub = checks.filter(function (c) { return c.id === 'summary'; })[0].text;
      else if (dg) sub = dg.sure ? dg.best.text : dg.all.length > 1 ? 'Likely one of these: ' + dg.all.map(function (c) { return c.text; }).join(' ') : dg.best.text;
      if (realBreaks.length > 1) sub += ' (' + (realBreaks.length - 1) + ' more place' + (realBreaks.length > 2 ? 's' : '') + ' below.)';
      if (dg) primary = dg.best.fix;
    }
    return {
      status: status, ties: status === 'ties', headline: headline, sub: sub, primary: primary,
      checks: checks, flags: flags,
      moneyIn: moneyIn, moneyOut: moneyOut, computed: computed, diff: diff,
      count: rows.length, balances: { printed: printed, matched: matched }, breaks: realBreaks.length,
      fails: fails, looks: looks,
    };
  }

  /* ---------------- changes ---------------- */

  function copy(st) { return JSON.parse(JSON.stringify(st)); }
  /** A fix from `check` (or the same shape from the page), applied to a copy. */
  function applyFix(st, fix) {
    var s = copy(st);
    if (!fix || typeof fix !== 'object') return s;
    var at = -1;
    if (fix.row) for (var i = 0; i < s.rows.length; i++) if (s.rows[i].id === fix.row) at = i;
    if (fix.op === 'amount' && at >= 0) s.rows[at].amount = centsOrNull(fix.value);
    else if (fix.op === 'balance' && at >= 0) s.rows[at].balance = centsOrNull(fix.value);
    else if (fix.op === 'delete' && at >= 0) s.rows.splice(at, 1);
    else if (fix.op === 'opening') s.opening = centsOrNull(fix.value);
    else if (fix.op === 'closing') s.closing = centsOrNull(fix.value);
    else if (fix.op === 'insert') {
      var before = s.rows.length;
      if (fix.before) for (var j = 0; j < s.rows.length; j++) if (s.rows[j].id === fix.before) before = j;
      var near = s.rows[before] || s.rows[before - 1] || {};
      if (s.rows.length < LIMITS.rows) s.rows.splice(before, 0, { id: 'r' + (s.nextId++), date: isoDay(fix.date) ? fix.date : (near.date || null), desc: fix.desc ? text(fix.desc, LIMITS.desc) : 'Missing row - check the statement', amount: centsOrNull(fix.value), balance: null, page: near.page || null });
    }
    return cleanStatement(s);
  }
  /** One cell typed in the review table. Returns {statement} or {error}. */
  function editCell(st, rowId, field, value) {
    var s = copy(st);
    var r = null;
    for (var i = 0; i < s.rows.length; i++) if (s.rows[i].id === rowId) r = s.rows[i];
    if (!r) return { error: 'That row is gone.' };
    var v = String(value == null ? '' : value).trim();
    if (field === 'date') {
      var d = parseDate(v);
      if (!d) return { error: 'A date like ' + fmtDate(st.end || '2026-09-30', 'MM/DD/YYYY') + ' or ' + (st.end || '2026-09-30') + '.' };
      r.date = d;
    } else if (field === 'desc') r.desc = text(v, LIMITS.desc);
    else if (field === 'amount') {
      var a = toCents(v);
      if (a === null || a === 0) return { error: 'An amount like -1,240.00 (money out) or 842.15 (money in).' };
      r.amount = a;
    } else if (field === 'balance') {
      if (!v) r.balance = null;
      else { var b = toCents(v); if (b === null) return { error: 'A balance like 18,402.17 - or leave it empty.' }; r.balance = b; }
    } else return { error: 'Unknown field.' };
    return { statement: cleanStatement(s) };
  }
  /** A statement-level figure typed in: opening, closing, start, end, type, ... */
  function editHead(st, field, value) {
    var s = copy(st);
    var v = String(value == null ? '' : value).trim();
    if (field === 'opening' || field === 'closing') {
      if (!v) s[field] = null;
      else { var c = toCents(v); if (c === null) return { error: 'A balance like 18,402.17.' }; s[field] = c; }
    } else if (field === 'start' || field === 'end') {
      if (!v) s[field] = null;
      else { var d = parseDate(v); if (!d) return { error: 'A date like 2026-09-30.' }; s[field] = d; }
    } else if (field === 'type') s.type = oneOf(v, TYPES, s.type);
    else if (field === 'currency') s.currency = oneOf(v.toUpperCase(), CURRENCIES, s.currency);
    else if (field === 'bank') s.bank = text(v, LIMITS.bank);
    else if (field === 'last4') s.last4 = last4(v);
    else return { error: 'Unknown field.' };
    return { statement: cleanStatement(s) };
  }
  /** Rows of one page replaced by a re-reading; everything else kept. */
  function replacePage(st, page, newRows, pageTotals) {
    var s = copy(st);
    var first = -1, kept = [];
    s.rows.forEach(function (r, i) { if (r.page === page) { if (first < 0) first = kept.length; } else kept.push(r); });
    if (first < 0) {
      first = kept.length;
      for (var i = 0; i < kept.length; i++) if (kept[i].page && kept[i].page > page) { first = i; break; }
    }
    var fresh = (newRows || []).map(function (r) { return { id: 'r' + (s.nextId++), date: r.date, desc: r.desc, amount: r.amount, balance: r.balance, page: page }; });
    var before = s.rows.filter(function (r) { return r.page === page; });
    s.rows = kept.slice(0, first).concat(fresh, kept.slice(first)).slice(0, LIMITS.rows);
    s.pageTotals = (s.pageTotals || []).filter(function (t) { return t.page !== page; });
    if (pageTotals) s.pageTotals.push({ page: page, in: pageTotals.in, out: pageTotals.out });
    var changed = 0;
    for (var k = 0; k < Math.max(before.length, fresh.length); k++) {
      var a = before[k], b = fresh[k];
      if (!a || !b || a.amount !== b.amount || a.date !== b.date || a.balance !== b.balance) changed++;
    }
    return { statement: cleanStatement(s), was: before.length, now: fresh.length, changed: changed };
  }
  function pagesOf(st) {
    var p = {};
    st.rows.forEach(function (r) { if (r.page) p[r.page] = true; });
    return Object.keys(p).map(Number).sort(function (a, b) { return a - b; });
  }

  /* ---------------- several statements: the chain ---------------- */

  function accountKey(st) { return [descKey(st.bank), st.type, st.last4 || '?', st.currency].join('|'); }
  function label(st) {
    var acct = (st.bank || TYPE_LABEL[st.type]) + (st.last4 ? ' ••' + st.last4 : '');
    var m = monthName(st);
    return acct + (m ? ' · ' + m : '');
  }
  /**
   * Statements to export together, in date order, with what doesn't follow:
   * for each account, one month's closing balance must be the next month's
   * opening, and the periods must meet with no gap and no overlap.
   */
  function chain(list) {
    var sts = (list || []).slice().sort(function (a, b) { return String(a.start || a.end || '').localeCompare(String(b.start || b.end || '')); });
    var warnings = [], keys = {};
    sts.forEach(function (st) { (keys[accountKey(st)] = keys[accountKey(st)] || []).push(st); });
    var accounts = Object.keys(keys);
    if (accounts.length > 1) warnings.push({ status: 'look', text: 'These are ' + accounts.length + ' different accounts. The export keeps an Account column so they stay apart' + ' - OFX gives each its own account.' });
    accounts.forEach(function (k) {
      var g = keys[k];
      for (var i = 1; i < g.length; i++) {
        var a = g[i - 1], b = g[i];
        if (a.closing !== null && b.opening !== null && a.closing !== b.opening) {
          warnings.push({ status: 'fail', text: label(a) + ' closes at ' + fmtAbs(a.closing) + ' but ' + label(b) + ' opens at ' + fmtAbs(b.opening) + ' - a gap of ' + fmtAbs(b.opening - a.closing) + '. A statement may be missing, or a balance was misread.' });
        }
        if (a.end && b.start) {
          if (addDays(a.end, 1) < b.start) warnings.push({ status: 'fail', text: 'Nothing covers ' + fmtPeriod(addDays(a.end, 1), addDays(b.start, -1)) + ', between ' + label(a) + ' and ' + label(b) + ' - is a statement missing?' });
          else if (b.start <= a.end) warnings.push({ status: 'look', text: label(a) + ' and ' + label(b) + ' overlap (' + fmtPeriod(b.start, a.end < b.end ? a.end : b.end) + ') - check no row is in both.' });
        }
      }
    });
    return { statements: sts, warnings: warnings, accounts: accounts.length };
  }

  /* ---------------- exports ---------------- */

  /** A CSV cell: quoted when it holds a quote, comma or line break; a text
   *  cell that a spreadsheet would run as a formula gets a leading quote. A
   *  plain number (-1240.00) is left a number. */
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csv(rows) { return '\ufeff' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n'; }
  function acctText(st) { return (st.bank || TYPE_LABEL[st.type]) + (st.last4 ? ' ' + st.last4 : ''); }

  /** Generic CSV: Date, Description, Amount (or Debit, Credit), Balance, Account, Page. */
  function toCsv(list, opts) {
    var o = opts || {}, split = o.columns === 'split', fmt = o.dateFormat || 'YYYY-MM-DD';
    var out = [split ? ['Date', 'Description', 'Debit', 'Credit', 'Balance', 'Account', 'Currency', 'Page'] : ['Date', 'Description', 'Amount', 'Balance', 'Account', 'Currency', 'Page']];
    chain(list).statements.forEach(function (st) {
      st.rows.forEach(function (r) {
        var amt = r.amount === null ? '' : plain(r.amount);
        var cols = split ? [r.amount !== null && r.amount < 0 ? plain(-r.amount) : '', r.amount !== null && r.amount > 0 ? plain(r.amount) : ''] : [amt];
        out.push([fmtDate(r.date, fmt), r.desc].concat(cols, [r.balance === null ? '' : plain(r.balance), acctText(st), st.currency, r.page || '']));
      });
    });
    return csv(out);
  }
  /** QuickBooks Online's bank upload: 3 columns (Date, Description, Amount)
   *  or 4 (Date, Description, Credit, Debit - both positive). No symbols, no
   *  thousands separators, one date format. */
  function toQbo(list, opts) {
    var o = opts || {}, split = o.columns === 'split', fmt = o.dateFormat || 'MM/DD/YYYY';
    var out = [split ? ['Date', 'Description', 'Credit', 'Debit'] : ['Date', 'Description', 'Amount']];
    chain(list).statements.forEach(function (st) {
      st.rows.forEach(function (r) {
        if (r.amount === null) return;
        out.push(split ? [fmtDate(r.date, fmt), r.desc, r.amount > 0 ? plain(r.amount) : '', r.amount < 0 ? plain(-r.amount) : ''] : [fmtDate(r.date, fmt), r.desc, plain(r.amount)]);
      });
    });
    return csv(out);
  }
  function checkNo(desc) { var m = /^(?:check|chk|cheque)\s*(?:no\.?|#)?\s*(\d{1,8})\b/i.exec(String(desc || '')); return m ? m[1] : ''; }
  /** Xero's statement import: *Date, *Amount (signed), Payee, Description,
   *  Reference, Check Number. */
  function toXero(list, opts) {
    var fmt = (opts && opts.dateFormat) || 'MM/DD/YYYY';
    var out = [['*Date', '*Amount', 'Payee', 'Description', 'Reference', 'Check Number']];
    chain(list).statements.forEach(function (st) {
      st.rows.forEach(function (r) {
        if (r.amount === null) return;
        out.push([fmtDate(r.date, fmt), plain(r.amount), '', r.desc, '', checkNo(r.desc)]);
      });
    });
    return csv(out);
  }

  function fnv(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function xmlText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function ofxDate(iso) { return iso ? iso.replace(/-/g, '') : ''; }
  function ofxStamp(isoTime) { var t = String(isoTime || ''); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(t) ? t.slice(0, 19).replace(/[-:T]/g, '') : '19700101000000'; }
  /**
   * OFX 1.0.2 (the SGML header every bank import reads), every element
   * closed. One account per statement aggregate - consecutive months of one
   * account become one aggregate - TRNAMT signed as money moved (a card
   * purchase negative), FITIDs stable across exports, LEDGERBAL the last
   * closing balance (negative on a card: what is owed).
   */
  function toOfx(list, opts) {
    var o = opts || {};
    var now = ofxStamp(o.now);
    var groups2 = {};
    var order = [];
    chain(list).statements.forEach(function (st) { var k = accountKey(st); if (!groups2[k]) { groups2[k] = []; order.push(k); } groups2[k].push(st); });
    var bank = [], card = [];
    order.forEach(function (k, gi) {
      var g = groups2[k], first = g[0], lastSt = g[g.length - 1];
      var liab = isLiability(first.type);
      var acct = first.last4 ? 'XXXX' + first.last4 : 'ACCOUNT' + (gi + 1);
      var start = g.map(function (s) { return s.start || (s.rows[0] && s.rows[0].date); }).filter(Boolean).sort()[0] || '';
      var end = g.map(function (s) { return s.end || (s.rows.length && s.rows[s.rows.length - 1].date); }).filter(Boolean).sort().slice(-1)[0] || '';
      var trns = [];
      g.forEach(function (st) {
        st.rows.forEach(function (r) {
          if (r.amount === null || !r.date) return;
          var cn = checkNo(r.desc);
          trns.push('<STMTTRN><TRNTYPE>' + (cn && r.amount < 0 ? 'CHECK' : r.amount < 0 ? 'DEBIT' : 'CREDIT') + '</TRNTYPE><DTPOSTED>' + ofxDate(r.date) + '</DTPOSTED><TRNAMT>' + plain(r.amount) + '</TRNAMT><FITID>' + fnv(st.id + '|' + r.id + '|' + r.date + '|' + r.amount) + fnv(r.desc + '|' + st.id) + '</FITID>' + (cn ? '<CHECKNUM>' + cn + '</CHECKNUM>' : '') + '<NAME>' + xmlText((r.desc || 'Transaction').slice(0, 32)) + '</NAME>' + (r.desc && r.desc.length > 32 ? '<MEMO>' + xmlText(r.desc.slice(0, 255)) + '</MEMO>' : '') + '</STMTTRN>');
        });
      });
      var bal = lastSt.closing === null ? 0 : (liab ? -lastSt.closing : lastSt.closing);
      var list2 = '<BANKTRANLIST><DTSTART>' + ofxDate(start) + '</DTSTART><DTEND>' + ofxDate(end) + '</DTEND>' + trns.join('') + '</BANKTRANLIST>';
      var ledger = '<LEDGERBAL><BALAMT>' + plain(bal) + '</BALAMT><DTASOF>' + ofxDate(end) + '</DTASOF></LEDGERBAL>';
      var trnuid = fnv(k + now);
      if (liab) card.push('<CCSTMTTRNRS><TRNUID>' + trnuid + '</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><CCSTMTRS><CURDEF>' + first.currency + '</CURDEF><CCACCTFROM><ACCTID>' + acct + '</ACCTID></CCACCTFROM>' + list2 + ledger + '</CCSTMTRS></CCSTMTTRNRS>');
      else bank.push('<STMTTRNRS><TRNUID>' + trnuid + '</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><STMTRS><CURDEF>' + first.currency + '</CURDEF><BANKACCTFROM><BANKID>000000000</BANKID><ACCTID>' + acct + '</ACCTID><ACCTTYPE>' + (first.type === 'savings' ? 'SAVINGS' : 'CHECKING') + '</ACCTTYPE></BANKACCTFROM>' + list2 + ledger + '</STMTRS></STMTTRNRS>');
    });
    var head = ['OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252', 'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '', ''].join('\r\n');
    var body = '<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>' + now + '</DTSERVER><LANGUAGE>ENG</LANGUAGE></SONRS></SIGNONMSGSRSV1>' +
      (bank.length ? '<BANKMSGSRSV1>' + bank.join('') + '</BANKMSGSRSV1>' : '') +
      (card.length ? '<CREDITCARDMSGSRSV1>' + card.join('') + '</CREDITCARDMSGSRSV1>' : '') + '</OFX>';
    // ENCODING:USASCII - anything outside ASCII in a name becomes "?".
    return head + body.replace(/></g, '>\r\n<').replace(/[^\x00-\x7f]/g, '?') + '\r\n';
  }
  var FORMATS = {
    csv: { label: 'CSV', ext: 'csv', type: 'text/csv;charset=utf-8', split: true },
    qbo: { label: 'QuickBooks Online', ext: 'csv', type: 'text/csv;charset=utf-8', split: true },
    xero: { label: 'Xero', ext: 'csv', type: 'text/csv;charset=utf-8', split: false },
    ofx: { label: 'OFX', ext: 'ofx', type: 'application/x-ofx', split: false },
  };
  function exportAs(format, list, opts) {
    if (format === 'qbo') return toQbo(list, opts);
    if (format === 'xero') return toXero(list, opts);
    if (format === 'ofx') return toOfx(list, opts);
    return toCsv(list, opts);
  }
  function fileSlug(s) { return String(s || 'statement').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'statement'; }
  function fileName(format, list) {
    var sts = chain(list).statements;
    var first = sts[0] || {}, last = sts[sts.length - 1] || {};
    var span = (first.end || first.start || '').slice(0, 7) + (sts.length > 1 && last.end ? '-to-' + last.end.slice(0, 7) : '');
    return 'tieout-' + fileSlug((first.bank || 'statement') + (first.last4 ? '-' + first.last4 : '')) + (span ? '-' + span : '') + (format === 'qbo' ? '-quickbooks' : format === 'xero' ? '-xero' : '') + '.' + FORMATS[format].ext;
  }

  /* ---------------- reading a bank CSV (free, on the device) ---------------- */

  function detectDelimiter(t) {
    var head = t.slice(0, 4000).replace(/"[^"]*"/g, '');
    var n = function (re) { var x = head.match(re); return x ? x.length : 0; };
    var c = n(/,/g), sc = n(/;/g), tb = n(/\t/g);
    if (tb > c && tb >= sc) return '\t';
    if (sc > c) return ';';
    return ',';
  }
  /** RFC 4180-ish: quoted fields, doubled quotes, CRLF / LF / CR, blank lines dropped. */
  function parseCsv(t, delim, maxRows) {
    var s = String(t || ''), n = s.length, rows = [], row = [], i = 0, D = delim || ',';
    var limit = maxRows || Infinity;
    // The file's own line number where each kept row starts, so a skipped
    // row can be named the way an editor shows it.
    var lines = [], line = 1, counted = 0, rowLine = 1;
    var lineAt = function (pos) {
      for (; counted < pos; counted++) { var ch = s.charCodeAt(counted); if (ch === 10 || (ch === 13 && s.charCodeAt(counted + 1) !== 10)) line++; }
      return line;
    };
    var isEnd = function (ch) { return ch === D || ch === '\n' || ch === '\r'; };
    var keepRow = function (r) { for (var k = 0; k < r.length; k++) if (r[k].trim() !== '') return true; return false; };
    while (i < n) {
      var buf;
      if (s.charCodeAt(i) === 34) {
        var j = i + 1; buf = '';
        for (;;) {
          var q = s.indexOf('"', j);
          if (q < 0) { buf += s.slice(j); j = n; break; }
          buf += s.slice(j, q);
          if (s.charCodeAt(q + 1) === 34) { buf += '"'; j = q + 2; } else { j = q + 1; break; }
        }
        var e = j; while (e < n && !isEnd(s[e])) e++;
        buf += s.slice(j, e); i = e;
      } else {
        var e2 = i; while (e2 < n && !isEnd(s[e2])) e2++;
        buf = s.slice(i, e2); i = e2;
      }
      row.push(buf);
      if (i >= n) break;
      if (s[i] === D) { i++; if (i >= n) row.push(''); continue; }
      if (s[i] === '\r' && s[i + 1] === '\n') i += 2; else i++;
      if (keepRow(row)) { rows.push(row); lines.push(rowLine); if (rows.length > limit) return { rows: rows, lines: lines, over: true }; }
      row = [];
      rowLine = lineAt(i);
    }
    if (row.length && keepRow(row)) { rows.push(row); lines.push(rowLine); }
    return { rows: rows, lines: lines, over: rows.length > limit };
  }
  var norm = function (h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  var HEADERS = {
    date: ['date', 'transactiondate', 'transdate', 'posteddate', 'postingdate', 'postdate', 'bookingdate', 'valuedate', 'effectivedate', 'trandate', 'dateposted'],
    desc: ['description', 'transactiondescription', 'details', 'narrative', 'memo', 'payee', 'name', 'merchant', 'merchantname', 'particulars', 'originaldescription', 'reference'],
    amount: ['amount', 'transactionamount', 'amountusd', 'value', 'netamount', 'amt'],
    debit: ['debit', 'debits', 'debitamount', 'withdrawal', 'withdrawals', 'withdrawalamount', 'moneyout', 'paidout', 'charges', 'charge', 'outflow', 'payments'],
    credit: ['credit', 'credits', 'creditamount', 'deposit', 'deposits', 'depositamount', 'moneyin', 'paidin', 'inflow'],
    balance: ['balance', 'runningbalance', 'runningbal', 'ledgerbalance', 'availablebalance', 'closingbalance', 'bal'],
  };
  var ORDER = ['date', 'balance', 'amount', 'debit', 'credit', 'desc'];
  function columnsBy(header) {
    var h = header.map(norm), out = {}, used = {};
    ORDER.forEach(function (k) {
      var names = HEADERS[k];
      for (var i = 0; i < names.length; i++) {
        var at = h.indexOf(names[i]);
        if (at >= 0 && !used[at]) { out[k] = at; used[at] = true; break; }
      }
    });
    return out;
  }
  /**
   * A bank CSV's text -> {header, body, mapping guess, dayFirst} or {error}.
   * Banks put account summaries above the header; the header is the first
   * row naming a date, a description and an amount (or debit) column. A
   * file with no header at all is read by shape: a date, then an amount.
   */
  function analyzeCsv(t) {
    if (typeof t !== 'string' || !t.trim()) return { error: 'That file is empty.' };
    if (t.length > LIMITS.csvBytes) return { error: 'That file is over 5 MB - export one statement period at a time.' };
    var s = t.replace(/^\ufeff/, '');
    var delim = detectDelimiter(s);
    var parsed = parseCsv(s, delim, LIMITS.rows + 60);
    var rows = parsed.rows;
    if (!rows.length) return { error: 'No rows in that file.' };
    var h = -1, cols = null;
    for (var i = 0; i < Math.min(rows.length, 40); i++) {
      var c = columnsBy(rows[i]);
      if (c.date !== undefined && c.desc !== undefined && (c.amount !== undefined || c.debit !== undefined || c.credit !== undefined)) { h = i; cols = c; break; }
    }
    var width = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    var header;
    if (h < 0) {
      header = []; for (var k = 0; k < width; k++) header.push('Column ' + (k + 1));
      cols = {};
      var first = rows[0];
      for (var c2 = 0; c2 < first.length; c2++) {
        if (cols.date === undefined && parseDate(first[c2])) cols.date = c2;
        else if (cols.amount === undefined && toCents(first[c2]) !== null && /[.,]\d{2}\s*$/.test(first[c2])) cols.amount = c2;
      }
      var longest = -1, len = 0;
      for (var c3 = 0; c3 < first.length; c3++) if (c3 !== cols.date && c3 !== cols.amount && String(first[c3]).length > len && !/^[-\d.,\s$()]+$/.test(first[c3])) { len = String(first[c3]).length; longest = c3; }
      if (longest >= 0) cols.desc = longest;
    } else header = rows[h].map(function (x, j) { return clean(x, 40) || 'Column ' + (j + 1); });
    var body = rows.slice(h + 1);
    if (body.length > LIMITS.rows) return { error: 'That’s more than ' + LIMITS.rows.toLocaleString('en-US') + ' rows - export one statement period at a time.' };
    var dayFirst = false;
    if (cols.date !== undefined) {
      for (var b = 0; b < body.length && b < 400; b++) {
        var dm = /^\s*(\d{1,2})[/-](\d{1,2})[/-]\d{2,4}/.exec(String(body[b][cols.date] || ''));
        if (dm && +dm[1] > 12) { dayFirst = true; break; }
      }
    }
    var preamble = rows.slice(0, Math.max(h, 0)).map(function (r) { return r.join(' '); }).join(' ').slice(0, 600);
    return { header: header, body: body, lines: parsed.lines.slice(h + 1), mapping: cols, dayFirst: dayFirst, headerRow: h, preamble: preamble, delimiter: delim };
  }

  /**
   * The analysed CSV and a column mapping -> {statement, skipped, problems}
   * or {error} that says exactly why no row was read - never a silent zero.
   * mapping: {date, desc, amount | debit/credit, balance?}; opts: {sign:
   * 'in-positive' | 'out-positive' | 'auto', type, currency, bank, last4,
   * opening?, closing?}. Newest-first files are turned to oldest-first.
   */
  function fromCsv(an, mapping, opts) {
    var o = opts || {}, m = mapping || {};
    var type = oneOf(o.type, TYPES, 'checking');
    var dir = dirOf(type);
    var has = function (k) { return Number.isInteger(m[k]) && m[k] >= 0; };
    if (!has('date')) return { error: 'Pick the column that holds the date.' };
    if (!has('amount') && !has('debit') && !has('credit')) return { error: 'Pick the amount column - or the debit and credit columns.' };
    var reasons = { date: [], amount: [] };
    var read = [];
    an.body.forEach(function (row, i) {
      var line = (an.lines && an.lines[i]) || an.headerRow + 2 + i; // the file's own line number
      var date = parseDate(row[m.date], an.dayFirst);
      var amount = null, explicit = false;
      if (has('debit') || has('credit')) {
        var dv = has('debit') ? toCents(String(row[m.debit] || '').trim() || '') : null;
        var cv = has('credit') ? toCents(String(row[m.credit] || '').trim() || '') : null;
        if (dv) { amount = -Math.abs(dv); explicit = true; } else if (cv) { amount = Math.abs(cv); explicit = true; }
        else if (has('amount')) amount = toCents(row[m.amount]);
      } else amount = toCents(row[m.amount]);
      var blank = row.every(function (c) { return !String(c || '').trim(); });
      if (blank) return;
      var desc = has('desc') ? text(row[m.desc], LIMITS.desc) : '';
      if (isNotARow(desc) && !amount) return;
      if (!date) { reasons.date.push({ line: line, value: clean(row[m.date], 30) }); return; }
      if (amount === null || amount === 0) { reasons.amount.push({ line: line, value: clean(has('amount') ? row[m.amount] : (row[m.debit] || row[m.credit]), 30) }); return; }
      read.push({ date: date, desc: desc, amount: amount, explicit: explicit, balance: has('balance') ? toCents(String(row[m.balance] || '').trim() || '') : null });
    });
    if (!read.length) {
      var why = [];
      if (reasons.date.length) why.push(reasons.date.length + ' row' + (reasons.date.length === 1 ? '' : 's') + ' had no date that could be read (like “' + reasons.date[0].value + '” on line ' + reasons.date[0].line + ')');
      if (reasons.amount.length) why.push(reasons.amount.length + ' row' + (reasons.amount.length === 1 ? '' : 's') + ' had no amount that could be read (like “' + reasons.amount[0].value + '” on line ' + reasons.amount[0].line + ')');
      return { error: 'No rows could be read' + (why.length ? ': ' + why.join(', and ') + '.' : '.') + ' Check the columns picked for the date and the amount.', reasons: reasons };
    }
    // Newest first? Turn it round so balances run forward.
    if (read.length > 1 && read[0].date > read[read.length - 1].date) read.reverse();
    // Which way is money in? Explicit debit/credit columns say. Otherwise a
    // balance column decides (the sign that makes it run wins), else the
    // majority: most rows on a card are purchases, money out.
    var sign = 1;
    if (o.sign === 'out-positive') sign = -1;
    else if (o.sign !== 'in-positive') {
      var bal = read.filter(function (r) { return r.balance !== null; }).length;
      if (bal >= 2) {
        var score = function (sg) {
          var ok = 0;
          for (var i = 1; i < read.length; i++) {
            if (read[i].balance === null || read[i - 1].balance === null) continue;
            var a = read[i].explicit ? read[i].amount : sg * read[i].amount;
            if (read[i - 1].balance + dir * a === read[i].balance) ok++;
          }
          return ok;
        };
        sign = score(-1) > score(1) ? -1 : 1;
      } else if (type === 'credit-card' || type === 'line-of-credit') {
        var pos = read.filter(function (r) { return !r.explicit && r.amount > 0; }).length;
        sign = pos * 2 > read.filter(function (r) { return !r.explicit; }).length ? -1 : 1;
      }
    }
    var rows = read.map(function (r, i) { return { id: 'r' + (i + 1), date: r.date, desc: r.desc, amount: r.explicit ? r.amount : sign * r.amount, balance: r.balance, page: null }; });
    var opening = o.opening !== undefined && o.opening !== null && o.opening !== '' ? toCents(o.opening) : null;
    var closing = o.closing !== undefined && o.closing !== null && o.closing !== '' ? toCents(o.closing) : null;
    if (opening === null && rows[0].balance !== null) opening = rows[0].balance - dir * rows[0].amount;
    if (closing === null && rows[rows.length - 1].balance !== null) closing = rows[rows.length - 1].balance;
    var st = cleanStatement({
      src: 'csv', name: o.name, bank: o.bank, type: type, last4: o.last4, currency: o.currency,
      start: parseDate(o.start) || rows[0].date, end: parseDate(o.end) || rows[rows.length - 1].date,
      opening: opening, closing: closing, rows: rows, at: o.at,
    });
    var skipped = reasons.date.length + reasons.amount.length;
    var problems = [];
    if (reasons.date.length) problems.push(reasons.date.length + ' row' + (reasons.date.length === 1 ? '' : 's') + ' skipped: no readable date (line ' + reasons.date.slice(0, 3).map(function (x) { return x.line; }).join(', ') + (reasons.date.length > 3 ? '…' : '') + ').');
    if (reasons.amount.length) problems.push(reasons.amount.length + ' row' + (reasons.amount.length === 1 ? '' : 's') + ' skipped: no amount (line ' + reasons.amount.slice(0, 3).map(function (x) { return x.line; }).join(', ') + (reasons.amount.length > 3 ? '…' : '') + ').');
    return { statement: st, skipped: skipped, problems: problems, sign: sign > 0 ? 'in-positive' : 'out-positive' };
  }

  return {
    LIMITS: LIMITS, TYPES: TYPES, TYPE_LABEL: TYPE_LABEL, CURRENCIES: CURRENCIES, DATE_FORMATS: DATE_FORMATS, FORMATS: FORMATS,
    dirOf: dirOf, isLiability: isLiability,
    scrub: scrub, clean: clean, text: text, maskNumbers: maskNumbers, last4: last4,
    readMoney: readMoney, toCents: toCents, fmtAbs: fmtAbs, money: money, plain: plain, signed: signed,
    parseDate: parseDate, isoDay: isoDay, addDays: addDays, fmtDay: fmtDay, fmtPeriod: fmtPeriod, fmtDate: fmtDate, monthName: monthName,
    isNotARow: isNotARow, newId: newId, cleanStatement: cleanStatement, fromModel: fromModel, pageFromModel: pageFromModel,
    relation: relation, candidates: candidates, check: check, rowNo: rowNo,
    applyFix: applyFix, editCell: editCell, editHead: editHead, replacePage: replacePage, pagesOf: pagesOf,
    accountKey: accountKey, label: label, chain: chain,
    csvCell: csvCell, toCsv: toCsv, toQbo: toQbo, toXero: toXero, toOfx: toOfx, exportAs: exportAs, fileName: fileName, fileSlug: fileSlug, checkNo: checkNo,
    detectDelimiter: detectDelimiter, parseCsv: parseCsv, analyzeCsv: analyzeCsv, fromCsv: fromCsv,
  };
}));
