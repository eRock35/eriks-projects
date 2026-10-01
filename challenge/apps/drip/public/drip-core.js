/* Drip - the rules, in one file the page, the server and the tests all run.
 *
 * UMD: the page loads it as window.DripCore, the server and the tests
 * require() it. Everything that decides a number lives here:
 *
 *   - reading a bank or card CSV (parseStatement / parseStatements): the
 *     dialects, the sign of the amount column, payments, transfers, refunds
 *     and interest skipped and counted, several files merged and
 *     de-duplicated. This runs IN THE BROWSER. No server route ever sees a
 *     statement.
 *   - turning a messy card descriptor into a merchant (merchantInfo): the
 *     processor noise, store numbers, phone numbers, places, and a curated
 *     table of well-known subscriptions (names only - never a cancellation
 *     link, which changes and is worse wrong than missing).
 *   - finding what bills on repeat (findRecurring): weekly, monthly,
 *     quarterly and yearly, from the gaps between charges, with a tolerance
 *     band on amounts; and the flags - price creep, a trial that turned
 *     paid, doubles, gone quiet, a yearly renewal coming up.
 *   - the totals, the savings and their fun equivalents, the reminder
 *     calendar (.ics), and the cleaning every drip goes through whether it
 *     came from a statement, a model's reading of a screenshot, a typed form,
 *     localStorage or a request body.
 *
 * Money is integer cents throughout, read from the digits and never through
 * a float. Dates are ISO days ("2026-10-01"); "today" is always passed in.
 * No DOM, no network, no clock of its own.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DripCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    bytes: 5 * 1024 * 1024,   // every file together
    rows: 20000,              // every file together
    files: 6,
    drips: 150,               // one saved list
    name: 40,
    notes: 200,
    snapItems: 60,
    snapImages: 3,
    maxCents: 1000000,        // $10,000 a charge
  };

  var CADENCES = ['weekly', 'monthly', 'quarterly', 'annual'];
  var PER_YEAR = { weekly: 52, monthly: 12, quarterly: 4, annual: 1 };
  var CADENCE_WORD = { weekly: 'a week', monthly: 'a month', quarterly: 'every 3 months', annual: 'a year' };
  var CADENCE_LABEL = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Every 3 months', annual: 'Yearly' };
  var DECISIONS = ['keep', 'cut', 'unsure'];
  var SOURCES = ['statement', 'snap', 'hand'];
  var FLAG_TYPES = ['creep', 'trial', 'double', 'twice', 'quiet', 'renewal'];

  var CATS = {
    streaming: { label: 'Streaming', short: 'Streaming', emoji: '📺', color: '#7c3aed' },
    music: { label: 'Music & audio', short: 'Music', emoji: '🎵', color: '#db2777' },
    cloud: { label: 'Cloud storage', short: 'Cloud', emoji: '☁️', color: '#0284c7' },
    software: { label: 'Apps & software', short: 'Apps', emoji: '💻', color: '#4f46e5' },
    news: { label: 'News & reading', short: 'News', emoji: '📰', color: '#64748b' },
    fitness: { label: 'Fitness & wellness', short: 'Fitness', emoji: '💪', color: '#16a34a' },
    food: { label: 'Food & delivery', short: 'Food', emoji: '🍔', color: '#ea580c' },
    dating: { label: 'Dating', short: 'Dating', emoji: '💘', color: '#e11d48' },
    games: { label: 'Games', short: 'Games', emoji: '🎮', color: '#9333ea' },
    phone: { label: 'Phone & internet', short: 'Phone', emoji: '📱', color: '#0d9488' },
    insurance: { label: 'Insurance', short: 'Insurance', emoji: '🛡️', color: '#475569' },
    learning: { label: 'Learning', short: 'Learning', emoji: '🎓', color: '#ca8a04' },
    shopping: { label: 'Shopping & memberships', short: 'Memberships', emoji: '🛒', color: '#b45309' },
    other: { label: 'Other', short: 'Other', emoji: '🔁', color: '#6b7280' },
  };
  var CAT_IDS = Object.keys(CATS);
  // Two of these at once is usually one too many. Streaming is left out on
  // purpose: three services is a choice people make, not a mistake.
  var DOUBLE_CATS = ['music', 'cloud', 'fitness', 'food', 'dating'];

  /* ---------------- text ---------------- */

  // Control characters, and the bidi and zero-width ones that can make a
  // merchant name read backwards on screen. The emoji joiner (U+200D) stays.
  var CTRL = /[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;

  /** A plain, bounded, single-line string: markup, control and bidi
   *  characters gone. Anything that is not a string or number is ''. */
  function clean(v, max) {
    if (typeof v !== 'string' && typeof v !== 'number') return '';
    var lim = max || 400;
    var s = String(v).slice(0, lim * 4 + 16)
      .replace(/<[^>]*>?/g, ' ').replace(CTRL, ' ').replace(/[<>]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (s.length > lim) s = Array.from(s).slice(0, lim).join('').trim();
    return s;
  }

  /** "STREAMIO MONTHLY" -> "Streamio Monthly"; mixed case is left as typed.
   *  Short words with no vowel ("TV", "BBQ") stay upper case. */
  function tidyCase(s) {
    if (!s || s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
    return s.toLowerCase().replace(/[a-z0-9'&+]+/g, function (w) {
      if (w.length <= 3 && !/[aeiouy]/.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
  }

  /* ---------------- money ---------------- */

  /**
   * A money string's digits: {neg, cents} or null. "$1,234.56", "12,50",
   * "1.234,56", "(12.00)", "-12.00", "12.00-", "USD 12", "€3". Anything
   * without a digit, or with letters left over, is no figure.
   */
  function readMoney(v) {
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      var a = Math.abs(v);
      if (a >= 1e9) return null;
      return { neg: v < 0, cents: Math.round(Number(a.toFixed(2)) * 100) };
    }
    if (typeof v !== 'string') return null;
    var s = v.trim();
    if (!s || s.length > 40 || !/\d/.test(s)) return null;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    s = s.replace(/\b(?:usd|eur|gbp|cad|aud|us\$)\b/gi, '').replace(/[$£€¥\s\u00a0]/g, '');
    s = s.replace(/\/(?:mo|month|yr|year|wk|week)\.?$/i, '');
    if (/^[-−–]/.test(s)) { neg = true; s = s.slice(1); }
    if (/[-−–]$/.test(s)) { neg = true; s = s.slice(0, -1); }
    if (/^\+/.test(s)) s = s.slice(1);
    if (/^[-−–]/.test(s)) { neg = true; s = s.slice(1); } // "$-4.00"
    if (!/^(?:\d[\d,.]*|[.,]\d+)$/.test(s)) return null;
    var dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
    var dec = null;
    if (dot >= 0 && comma >= 0) dec = dot > comma ? '.' : ',';
    else if (comma >= 0) dec = (s.indexOf(',') === comma && s.length - comma - 1 === 2) ? ',' : null;
    else if (dot >= 0) dec = s.indexOf('.') === dot ? '.' : null;
    var whole = s, frac = '';
    if (dec) { var at = s.lastIndexOf(dec); whole = s.slice(0, at); frac = s.slice(at + 1); }
    whole = whole.replace(/[.,]/g, '');
    if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
    if (whole.length > 9) return null;
    var cents = Number(whole || '0') * 100;
    if (frac) {
      var f = (frac + '000').slice(0, 3);
      cents += Number(f.slice(0, 2)) + (Number(f.charAt(2)) >= 5 ? 1 : 0);
    }
    return { neg: neg, cents: cents };
  }

  /** A price someone typed or a model read: non-negative cents, or null. */
  function toCents(v) {
    var m = readMoney(v);
    if (!m || m.neg || m.cents > LIMITS.maxCents) return null;
    return m.cents;
  }
  /** A statement amount: signed cents, or null. */
  function signedCents(v) {
    var m = readMoney(v);
    if (!m) return null;
    return m.neg ? -m.cents : m.cents;
  }

  var SYMBOL = { USD: '$', GBP: '£', EUR: '€', CAD: '$', AUD: '$' };
  /** "$1,234.56"; {whole: true} rounds to "$1,235". */
  function money(cents, opts) {
    var o = opts || {};
    var sym = SYMBOL[o.currency] || '$';
    var c = Math.round(Number(cents) || 0);
    var neg = c < 0; c = Math.abs(c);
    var s;
    if (o.whole) s = String(Math.round(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    else s = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + ('0' + (c % 100)).slice(-2);
    return (neg ? '−' : '') + sym + s;
  }
  /** Cents for the page's number inputs: "17.99". */
  function plain(cents) { var c = Math.max(0, Math.round(cents || 0)); return Math.floor(c / 100) + '.' + ('0' + (c % 100)).slice(-2); }

  function yearlyOf(cents, cadence) { return (cents || 0) * (PER_YEAR[cadence] || 12); }
  function monthlyOf(cents, cadence) { return Math.round(yearlyOf(cents, cadence) / 12); }

  /* ---------------- dates ---------------- */

  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function ymd(y, m, d) {
    if (y < 100) y += 2000;
    if (y < 1990 || y > 2100) return null;
    var t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
    return t.toISOString().slice(0, 10);
  }
  function isoDay(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && ymd(+v.slice(0, 4), +v.slice(5, 7), +v.slice(8, 10)) === v; }
  function dayNum(iso) { return Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000); }
  function fromDayNum(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  function addDays(iso, n) { return fromDayNum(dayNum(iso) + n); }
  function daysBetween(a, b) { return dayNum(b) - dayNum(a); }
  /** Same day next month(s), held to the month's last day (Jan 31 -> Feb 28). */
  function addMonths(iso, n) {
    var y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1 + n, d = +iso.slice(8, 10);
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return ymd(y, m + 1, Math.min(d, last));
  }
  function step(iso, cadence, k) {
    var n = k === undefined ? 1 : k;
    if (cadence === 'weekly') return addDays(iso, 7 * n);
    if (cadence === 'quarterly') return addMonths(iso, 3 * n);
    if (cadence === 'annual') return addMonths(iso, 12 * n);
    return addMonths(iso, n);
  }
  function monthMatch(word) {
    var w = String(word || '').toLowerCase().slice(0, 3);
    var i = MONTHS.indexOf(w);
    return i < 0 ? 0 : i + 1;
  }
  /** "Oct 12" (and the year when it is not `thisYear`). */
  function fmtDate(iso, thisYear) {
    if (!isoDay(iso)) return '';
    var s = MONTHS_LONG[+iso.slice(5, 7) - 1].slice(0, 3) + ' ' + (+iso.slice(8, 10));
    if (thisYear && iso.slice(0, 4) !== String(thisYear)) s += ', ' + iso.slice(0, 4);
    return s;
  }
  function monthName(iso) { return isoDay(iso) ? MONTHS_LONG[+iso.slice(5, 7) - 1] : ''; }

  /**
   * A statement date. Slashes are month-first (US banks) unless the file
   * says otherwise (`dayFirst`, decided once per file: a first part over 12
   * anywhere). Dots are day-first (European). ISO, "Sep 12, 2026",
   * "12 Sep 2026", "12-Sep-26" and "20260912" are read as written.
   */
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

  /* ---------------- CSV ---------------- */

  /** Comma, semicolon or tab: whichever the first lines use most. */
  function detectDelimiter(text) {
    var head = text.slice(0, 4000).replace(/"[^"]*"/g, '');
    var n = function (re) { var x = head.match(re); return x ? x.length : 0; };
    var c = n(/,/g), sc = n(/;/g), t = n(/\t/g);
    if (t > c && t >= sc) return '\t';
    if (sc > c) return ';';
    return ',';
  }

  /**
   * RFC 4180-ish, in one pass with slices: quoted fields, doubled quotes,
   * CRLF / LF / CR, blank lines dropped. Stops after `maxRows` rows.
   */
  function parseCsv(text, delim, maxRows) {
    var s = String(text || ''), n = s.length, rows = [], row = [], i = 0, D = delim || ',';
    var limit = maxRows || Infinity;
    var isEnd = function (ch) { return ch === D || ch === '\n' || ch === '\r'; };
    var keep = function (r) { for (var k = 0; k < r.length; k++) if (r[k].trim() !== '') return true; return false; };
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
      if (keep(row)) { rows.push(row); if (rows.length > limit) return { rows: rows, over: true }; }
      row = [];
    }
    if (row.length && keep(row)) rows.push(row);
    return { rows: rows, over: rows.length > limit };
  }

  var norm = function (h) { return String(h || '').toLowerCase().replace(/[^a-z]/g, ''); };
  // Order is preference: the first name found wins. The transaction date
  // beats the posting date (posting lags a day or three).
  var HEADERS = {
    date: ['transactiondate', 'transdate', 'trandate', 'date', 'purchasedate', 'bookingdate', 'valuedate', 'posteddate', 'postdate', 'postingdate'],
    description: ['merchant', 'merchantname', 'description', 'payee', 'name', 'transactiondescription', 'originaldescription', 'narrative', 'details', 'memo'],
    amount: ['amount', 'transactionamount', 'amountusd', 'billingamount', 'amountgbp', 'amounteur', 'value'],
    debit: ['debit', 'debitamount', 'debits', 'withdrawal', 'withdrawals', 'withdrawalamount', 'charge', 'charges', 'moneyout', 'paidout', 'outflow'],
    credit: ['credit', 'creditamount', 'credits', 'deposit', 'deposits', 'depositamount', 'payment', 'payments', 'moneyin', 'paidin', 'inflow'],
    type: ['type', 'transactiontype', 'details', 'transaction'],
  };
  function columns(header) {
    var h = header.map(norm), out = {}, used = {};
    ['date', 'amount', 'debit', 'credit', 'description', 'type'].forEach(function (k) {
      var names = HEADERS[k];
      for (var i = 0; i < names.length; i++) {
        var at = h.indexOf(names[i]);
        if (at >= 0 && !used[at]) { out[k] = at; used[at] = true; break; }
      }
    });
    return out;
  }

  // What is not spending. Each is skipped and counted, never silently.
  var CARD_PAYMENT = /payment[\s-]*thank ?you|thank you for (your )?payment|(credit ?(card|crd)|\bcrd\b|card ?services|\bcc\b|e-?payment|amex|american express|discover|capital one|citi ?card|chase card|barclay|synchrony|apple card).{0,30}\b(pmt|pymt|payment|autopay|auto pay)\b|\b(pmt|pymt|payment|autopay|auto pay)\b.{0,20}\b(credit ?(card|crd)|card)\b|^(internet|online|mobile|automatic|auto)? ?payment\b|^autopay\b/i;
  var TRANSFER = /\b(transfer|xfer|trnsfr|zelle|wire( transfer)?|to savings|from savings|to checking|from checking|atm|cash withdrawal|square cash|apple cash|p2p)\b|^check\s*#?\s*\d+$|^venmo\b(?!\s*\*)|^cash ?app\b(?!\s*\*)/i;
  var INTEREST = /\b(interest|finance charge)\b/i;
  var REFUND = /\b(refund|return|reversal|credit adj|adjustment|chargeback|statement credit|cash ?back|reward)\b/i;
  function isCardPayment(desc) { return CARD_PAYMENT.test(desc) && !/\bpayment\b[^a-z]{0,24}\b(to|for)\b/i.test(desc) || /payment[\s-]*thank ?you/i.test(desc); }
  var MONEY_IN_TYPE = /^(credit|payment|return|refund|deposit|adjustment|reversal|ach_credit|dslip)/i;

  /**
   * One statement's text -> {transactions, skipped, rows, range, currency}
   * or {error}. Nothing leaves the function but these numbers and the
   * descriptors, and it never leaves the browser.
   */
  function parseStatement(text, opts) {
    var o = opts || {};
    if (typeof text !== 'string' || !text.trim()) return { error: 'That file is empty.' };
    if (text.length > LIMITS.bytes) return { error: 'That file is larger than a statement should be (5 MB). Download a shorter date range.' };
    var t = text.replace(/^\ufeff/, '');
    var parsed = parseCsv(t, detectDelimiter(t), (o.maxRows || LIMITS.rows) + 40);
    var rows = parsed.rows;
    // Some banks put an account summary above the real header. The header is
    // the first row that names a date, a description and an amount column.
    var h = -1, cols = null;
    for (var i = 0; i < Math.min(rows.length, 40); i++) {
      var c = columns(rows[i]);
      if (c.date != null && c.description != null && (c.amount != null || c.debit != null)) { h = i; cols = c; break; }
    }
    // Wells Fargo and some credit unions export no header: date, amount, two
    // spare columns, then the description last. Recognised by shape.
    if (h < 0) {
      var first = rows.slice(0, 3);
      if (first.length && first.every(function (r) { return r.length >= 3 && parseDate(r[0]) && signedCents(r[1]) !== null; })) {
        cols = { date: 0, amount: 1, description: first[0].length - 1 };
      } else {
        return { error: 'This doesn’t look like a bank or card statement. Download the CSV version, with date, description and amount columns.' };
      }
    }
    var body = rows.slice(h + 1);
    if (body.length > (o.maxRows || LIMITS.rows)) return { error: 'That’s more than ' + (o.maxRows || LIMITS.rows).toLocaleString('en-US') + ' rows. Download a shorter date range - 3 to 12 months is plenty.' };
    // Day-first slashes, decided once for the file.
    var dayFirst = false;
    for (var k = 0; k < body.length && k < 400; k++) {
      var dm = /^\s*(\d{1,2})[/-](\d{1,2})[/-]\d{2,4}/.exec(String(body[k][cols.date] || ''));
      if (dm && +dm[1] > 12) { dayFirst = true; break; }
    }
    var sym = { '$': 0, '£': 0, '€': 0 };
    var raw = [], skipped = { payments: 0, transfers: 0, refunds: 0, interest: 0, moneyIn: 0, unreadable: 0 };
    for (var r = 0; r < body.length; r++) {
      var row = body[r];
      var date = parseDate(row[cols.date], dayFirst);
      var desc = clean(String(row[cols.description] || ''), 200);
      if (!desc && cols.type != null) desc = '';
      var type = cols.type != null ? String(row[cols.type] || '').trim() : '';
      var val = null;
      if (cols.debit != null || cols.credit != null) {
        var d = cols.debit != null ? signedCents(row[cols.debit]) : null;
        var cr = cols.credit != null ? signedCents(row[cols.credit]) : null;
        if (d !== null && d !== 0) val = { spend: Math.abs(d), sure: true };
        else if (cr !== null && cr !== 0) val = { spend: -Math.abs(cr), sure: true };
        else if (cols.amount != null) { var a0 = signedCents(row[cols.amount]); if (a0 !== null) val = { raw: a0 }; }
        else if (d === 0 || cr === 0) val = { spend: 0, sure: true };
      } else {
        var amt = String(row[cols.amount] == null ? '' : row[cols.amount]);
        var a1 = signedCents(amt.replace(/\s*(CR|DR)\s*$/i, ''));
        if (a1 !== null) {
          if (/CR\s*$/i.test(amt)) val = { spend: -Math.abs(a1), sure: true };
          else if (/DR\s*$/i.test(amt)) val = { spend: Math.abs(a1), sure: true };
          else val = { raw: a1 };
        }
      }
      if (!date || !desc || !val) { skipped.unreadable++; continue; }
      var cell = String(row[cols.amount != null ? cols.amount : cols.debit] || '');
      if (cell.indexOf('£') >= 0) sym['£']++; else if (cell.indexOf('€') >= 0) sym['€']++; else if (cell.indexOf('$') >= 0) sym['$']++;
      raw.push({ date: date, desc: desc, val: val, type: type });
    }
    // The sign of a lone Amount column is not a convention anyone agrees on:
    // Chase and Bank of America write purchases negative, Amex and Discover
    // positive. Purchases are most of any statement, so the majority sign is
    // spending. Payments and refunds do not vote.
    var votes = 0, neg = 0;
    raw.forEach(function (x) {
      if (x.val.raw === undefined || x.val.raw === 0) return;
      if (MONEY_IN_TYPE.test(x.type) || isCardPayment(x.desc) || REFUND.test(x.desc)) return;
      votes++; if (x.val.raw < 0) neg++;
    });
    var spendIsNegative = neg * 2 > votes;
    var out = [];
    raw.forEach(function (x) {
      var spend = x.val.spend !== undefined ? x.val.spend : (spendIsNegative ? -x.val.raw : x.val.raw);
      if (spend < 0 || (x.val.spend === undefined && MONEY_IN_TYPE.test(x.type) && spend !== 0)) {
        if (INTEREST.test(x.desc)) skipped.interest++;
        else if (isCardPayment(x.desc) || /^payment/i.test(x.type)) skipped.payments++;
        else if (REFUND.test(x.desc) || /^(return|refund|reversal|adjustment)/i.test(x.type)) skipped.refunds++;
        else if (TRANSFER.test(x.desc)) skipped.transfers++;
        else skipped.moneyIn++;
        return;
      }
      if (isCardPayment(x.desc)) { skipped.payments++; return; }
      if (INTEREST.test(x.desc) || /^interest/i.test(x.type)) { skipped.interest++; return; }
      if (TRANSFER.test(x.desc)) { skipped.transfers++; return; }
      if (spend > LIMITS.maxCents * 10) { skipped.unreadable++; return; }
      out.push({ date: x.date, cents: spend, desc: x.desc });
    });
    out.sort(byDate);
    var currency = sym['£'] > sym['$'] && sym['£'] >= sym['€'] ? 'GBP' : sym['€'] > sym['$'] ? 'EUR' : 'USD';
    return { transactions: out, skipped: skipped, rows: body.length, range: rangeOf(out), currency: currency };
  }

  function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.cents - b.cents; }
  function rangeOf(txs) { return txs.length ? { from: txs[0].date, to: txs[txs.length - 1].date } : null; }

  /**
   * Several files at once (a checking account and a card, or the same card
   * downloaded twice with overlapping dates). A row that appears in two
   * files is counted once; two identical charges in ONE file (two $0.99 app
   * charges on one day) are both real and both kept: each key is kept as
   * many times as the file that has it most.
   */
  function parseStatements(files, opts) {
    var list = Array.isArray(files) ? files.slice(0, LIMITS.files) : [];
    var total = list.reduce(function (n, f) { return n + String((f && f.text) || '').length; }, 0);
    if (!list.length) return { error: 'Add a CSV file.' };
    if (total > LIMITS.bytes) return { error: 'Those files add up to more than 5 MB. Download a shorter date range - 3 to 12 months is plenty.' };
    var have = new Map(), txs = [], report = [], dupes = 0, rowsLeft = LIMITS.rows;
    var skipped = { payments: 0, transfers: 0, refunds: 0, interest: 0, moneyIn: 0, unreadable: 0 };
    var currency = 'USD';
    for (var f = 0; f < list.length; f++) {
      var file = list[f] || {};
      var p = parseStatement(String(file.text || ''), { maxRows: rowsLeft });
      var name = clean(String(file.name || 'statement.csv'), 60);
      if (p.error) { report.push({ name: name, error: p.error }); continue; }
      rowsLeft -= p.rows;
      Object.keys(skipped).forEach(function (k) { skipped[k] += p.skipped[k]; });
      if (p.currency !== 'USD') currency = p.currency;
      var local = new Map();
      p.transactions.forEach(function (t) {
        var key = t.date + '|' + t.cents + '|' + merchantInfo(t.desc).key;
        var l = local.get(key) || [];
        l.push(t); local.set(key, l);
      });
      var added = 0;
      local.forEach(function (rows, key) {
        var already = have.get(key) || 0;
        if (rows.length > already) {
          for (var i = already; i < rows.length; i++) { txs.push(rows[i]); added++; }
          have.set(key, rows.length);
        }
        dupes += Math.min(already, rows.length);
      });
      report.push({ name: name, rows: p.rows, found: added, range: p.range });
    }
    txs.sort(byDate);
    if (!txs.length) {
      var err = report.filter(function (r) { return r.error; })[0];
      return { error: err ? err.error : 'No charges were found in that file.', files: report };
    }
    return { transactions: txs, skipped: skipped, files: report, dupes: dupes, range: rangeOf(txs), currency: currency };
  }

  /* ---------------- merchants ---------------- */

  // [id, name, category, descriptor pattern, usually billed yearly]
  // Specific before generic (YouTube TV before YouTube, Google One before
  // Google Play). Names only - deliberately no cancellation links.
  var KNOWN_RAW = [
    ['netflix', 'Netflix', 'streaming', /NETFLIX/],
    ['hulu', 'Hulu', 'streaming', /\bHULU\b/],
    ['disney', 'Disney+', 'streaming', /DISNEY ?(PLUS|\+)|DISNEYPLUS/],
    ['max', 'Max', 'streaming', /HBO ?MAX|\bMAX\.COM|HBO ?NOW|\bHBO\b/],
    ['paramount', 'Paramount+', 'streaming', /PARAMOUNT ?(PLUS|\+)|PARAMOUNTPLUS|CBS ALL ACCESS/],
    ['peacock', 'Peacock', 'streaming', /PEACOCK/],
    ['youtubetv', 'YouTube TV', 'streaming', /YOUTUBE ?TV/],
    ['youtube', 'YouTube Premium', 'streaming', /YOUTUBE/],
    ['primevideo', 'Prime Video', 'streaming', /PRIME ?VIDEO/],
    ['crunchyroll', 'Crunchyroll', 'streaming', /CRUNCHYROLL/],
    ['espn', 'ESPN+', 'streaming', /ESPN ?(PLUS|\+)|ESPNPLUS/],
    ['sling', 'Sling TV', 'streaming', /\bSLING\b/],
    ['fubo', 'Fubo', 'streaming', /\bFUBO/],
    ['philo', 'Philo', 'streaming', /\bPHILO\b/],
    ['starz', 'Starz', 'streaming', /STARZ/],
    ['amcplus', 'AMC+', 'streaming', /AMC ?(PLUS|\+)/],
    ['britbox', 'BritBox', 'streaming', /BRITBOX/],
    ['discovery', 'Discovery+', 'streaming', /DISCOVERY ?(PLUS|\+)/],
    ['showtime', 'Showtime', 'streaming', /SHOWTIME/],
    ['mgmplus', 'MGM+', 'streaming', /MGM ?(PLUS|\+)|\bEPIX\b/],
    ['twitch', 'Twitch', 'streaming', /TWITCH/],
    ['spotify', 'Spotify', 'music', /SPOTIFY/],
    ['tidal', 'Tidal', 'music', /\bTIDAL\b/],
    ['pandora', 'Pandora', 'music', /PANDORA/],
    ['siriusxm', 'SiriusXM', 'music', /SIRIUS ?XM|\bSXM\b/],
    ['deezer', 'Deezer', 'music', /DEEZER/],
    ['amazonmusic', 'Amazon Music', 'music', /(AMAZON|AMZN) ?MUSIC/],
    ['soundcloud', 'SoundCloud', 'music', /SOUNDCLOUD/],
    ['audible', 'Audible', 'learning', /AUDIBLE/],
    ['apple', 'Apple (App Store & iCloud)', 'software', /APPLE\.COM ?\/? ?BILL|ITUNES\.COM|APPLE SERVICES/],
    ['googleone', 'Google One', 'cloud', /GOOGLE ?\*? ?(ONE|STORAGE)\b/],
    ['googlefi', 'Google Fi', 'phone', /GOOGLE ?\*? ?FI\b/],
    ['dropbox', 'Dropbox', 'cloud', /DROPBOX/],
    ['onedrive', 'OneDrive', 'cloud', /ONEDRIVE/],
    ['box', 'Box', 'cloud', /\bBOX\.COM\b/],
    ['backblaze', 'Backblaze', 'cloud', /BACKBLAZE/, true],
    ['pcloud', 'pCloud', 'cloud', /\bPCLOUD\b/],
    ['microsoft365', 'Microsoft 365', 'software', /(MICROSOFT|MSFT) ?\*? ?(365|OFFICE)|OFFICE ?365/, true],
    ['xbox', 'Xbox Game Pass', 'games', /XBOX|GAME ?PASS/],
    ['adobe', 'Adobe', 'software', /ADOBE/],
    ['notion', 'Notion', 'software', /\bNOTION\b/],
    ['canva', 'Canva', 'software', /\bCANVA\b/],
    ['openai', 'ChatGPT', 'software', /OPENAI|CHATGPT/],
    ['anthropic', 'Claude', 'software', /ANTHROPIC|CLAUDE\.AI/],
    ['onepassword', '1Password', 'software', /1PASSWORD|AGILEBITS/, true],
    ['lastpass', 'LastPass', 'software', /LASTPASS/, true],
    ['nordvpn', 'NordVPN', 'software', /NORDVPN|NORD ?SEC/, true],
    ['expressvpn', 'ExpressVPN', 'software', /EXPRESS ?VPN/, true],
    ['surfshark', 'Surfshark', 'software', /SURFSHARK/, true],
    ['grammarly', 'Grammarly', 'software', /GRAMMARLY/],
    ['zoom', 'Zoom', 'software', /ZOOM\.US|ZOOM VIDEO/],
    ['github', 'GitHub', 'software', /GITHUB/],
    ['evernote', 'Evernote', 'software', /EVERNOTE/],
    ['norton', 'Norton', 'software', /NORTON|GEN DIGITAL/, true],
    ['mcafee', 'McAfee', 'software', /MCAFEE/, true],
    ['squarespace', 'Squarespace', 'software', /SQUARESPACE|\bSQSP\b/, true],
    ['godaddy', 'GoDaddy', 'software', /GO ?DADDY/, true],
    ['midjourney', 'Midjourney', 'software', /MIDJOURNEY/],
    ['nyt', 'The New York Times', 'news', /NYTIMES|NY ?TIMES|NEW ?YORK ?TIMES/],
    ['wsj', 'The Wall Street Journal', 'news', /\bWSJ\b|WALL ?ST(REET)? ?JOURNAL|DOW ?JONES/],
    ['wapo', 'The Washington Post', 'news', /WASHINGTON ?POST|WASHPOST/],
    ['atlantic', 'The Atlantic', 'news', /THE ?ATLANTIC/],
    ['economist', 'The Economist', 'news', /ECONOMIST/],
    ['substack', 'Substack', 'news', /SUBSTACK/],
    ['medium', 'Medium', 'news', /MEDIUM\.COM/],
    ['patreon', 'Patreon', 'other', /PATREON/],
    ['planetfitness', 'Planet Fitness', 'fitness', /PLANET ?FIT|PF ?BLACK ?CARD/],
    ['peloton', 'Peloton', 'fitness', /PELOTON/],
    ['strava', 'Strava', 'fitness', /STRAVA/, true],
    ['classpass', 'ClassPass', 'fitness', /CLASSPASS/],
    ['equinox', 'Equinox', 'fitness', /EQUINOX/],
    ['lafitness', 'LA Fitness', 'fitness', /LA ?FITNESS|FITNESS INTERNATIONAL/],
    ['anytime', 'Anytime Fitness', 'fitness', /ANYTIME ?FITNESS/],
    ['crunch', 'Crunch Fitness', 'fitness', /CRUNCH ?FIT/],
    ['orangetheory', 'Orangetheory', 'fitness', /ORANGE ?THEORY/],
    ['ymca', 'YMCA', 'fitness', /\bYMCA\b/],
    ['noom', 'Noom', 'fitness', /\bNOOM\b/],
    ['myfitnesspal', 'MyFitnessPal', 'fitness', /MYFITNESSPAL/],
    ['calm', 'Calm', 'fitness', /CALM\.COM|\bCALM ?APP\b/, true],
    ['headspace', 'Headspace', 'fitness', /HEADSPACE/],
    ['fitbit', 'Fitbit Premium', 'fitness', /FITBIT/],
    ['dashpass', 'DoorDash DashPass', 'food', /DASHPASS/],
    ['uberone', 'Uber One', 'food', /UBER ?\*? ?ONE\b/],
    ['grubhubplus', 'Grubhub+', 'food', /GRUBHUB ?(\+|PLUS)/],
    ['instacartplus', 'Instacart+', 'food', /INSTACART ?(\+|PLUS|EXPRESS|MEMBERSHIP)/],
    ['hellofresh', 'HelloFresh', 'food', /HELLO ?FRESH/],
    ['blueapron', 'Blue Apron', 'food', /BLUE ?APRON/],
    ['factor', 'Factor', 'food', /FACTOR ?(75|MEALS)/],
    ['homechef', 'Home Chef', 'food', /HOME ?CHEF/],
    ['tinder', 'Tinder', 'dating', /TINDER/],
    ['bumble', 'Bumble', 'dating', /BUMBLE/],
    ['hinge', 'Hinge', 'dating', /\bHINGE\b/],
    ['match', 'Match', 'dating', /MATCH\.COM/],
    ['eharmony', 'eharmony', 'dating', /EHARMONY/],
    ['psplus', 'PlayStation Plus', 'games', /PLAYSTATION|SONY ?(INTERACTIVE|NETWORK)|\bPSN\b/],
    ['nintendo', 'Nintendo Switch Online', 'games', /NINTENDO/, true],
    ['eaplay', 'EA Play', 'games', /EA ?PLAY/],
    ['roblox', 'Roblox', 'games', /ROBLOX/],
    ['verizon', 'Verizon', 'phone', /VERIZON|\bVZW\b/],
    ['att', 'AT&T', 'phone', /\bAT ?& ?T\b|\bATT\b/],
    ['tmobile', 'T-Mobile', 'phone', /T-?MOBILE/],
    ['xfinity', 'Xfinity', 'phone', /XFINITY|COMCAST/],
    ['spectrum', 'Spectrum', 'phone', /SPECTRUM|CHARTER ?COMM/],
    ['cox', 'Cox', 'phone', /\bCOX ?(COMM|CABLE)|COX\.COM/],
    ['mintmobile', 'Mint Mobile', 'phone', /MINT ?MOBILE/],
    ['visible', 'Visible', 'phone', /VISIBLE ?(SERVICE|WIRELESS)|VISIBLE\.COM/],
    ['cricket', 'Cricket Wireless', 'phone', /CRICKET ?WIRELESS/],
    ['optimum', 'Optimum', 'phone', /OPTIMUM/],
    ['geico', 'GEICO', 'insurance', /GEICO/],
    ['progressive', 'Progressive', 'insurance', /PROGRESSIVE/],
    ['statefarm', 'State Farm', 'insurance', /STATE ?FARM/],
    ['allstate', 'Allstate', 'insurance', /ALLSTATE/],
    ['lemonade', 'Lemonade', 'insurance', /LEMONADE ?(INS|INC|\.COM)/],
    ['libertymutual', 'Liberty Mutual', 'insurance', /LIBERTY ?MUTUAL/],
    ['duolingo', 'Duolingo', 'learning', /DUOLINGO/, true],
    ['kindle', 'Kindle Unlimited', 'learning', /KINDLE ?(UNLTD|UNLIMITED|SVCS)/],
    ['masterclass', 'MasterClass', 'learning', /MASTERCLASS/, true],
    ['coursera', 'Coursera', 'learning', /COURSERA/],
    ['skillshare', 'Skillshare', 'learning', /SKILLSHARE/, true],
    ['linkedin', 'LinkedIn Premium', 'learning', /LINKEDIN/],
    ['scribd', 'Scribd', 'learning', /SCRIBD|EVERAND/],
    ['amazonprime', 'Amazon Prime', 'shopping', /(AMAZON|AMZN) ?PRIME|PRIME ?MEMBERSHIP/, true],
    ['walmartplus', 'Walmart+', 'shopping', /WALMART ?(\+|PLUS)|WMT ?PLUS/],
    ['costco', 'Costco membership', 'shopping', /COSTCO.{0,20}(MEMBER|RENEW|ANNUAL)/, true],
    ['samsclub', 'Sam’s Club membership', 'shopping', /SAM'?S ?CLUB.{0,20}(MEMBER|RENEW)/, true],
    ['ring', 'Ring Protect', 'other', /\bRING ?(PROTECT|\.COM|YEARLY|MONTHLY)\b/],
    ['simplisafe', 'SimpliSafe', 'other', /SIMPLISAFE/],
    ['adt', 'ADT', 'other', /\bADT\b/],
    ['dollarshave', 'Dollar Shave Club', 'shopping', /DOLLAR ?SHAVE/],
    ['ipsy', 'Ipsy', 'shopping', /\bIPSY\b/],
    ['fabfitfun', 'FabFitFun', 'shopping', /FABFITFUN/],
    ['barkbox', 'BarkBox', 'shopping', /BARKBOX/],
    ['googleplay', 'Google Play', 'software', /GOOGLE ?\*|GOOGLE ?PLAY/],
  ];
  var KNOWN = KNOWN_RAW.map(function (r) { return { id: r[0], name: r[1], cat: r[2], re: r[3], yearly: Boolean(r[4]) }; });
  var KNOWN_BY_ID = {};
  KNOWN.forEach(function (k) { KNOWN_BY_ID[k.id] = k; });

  var SUB_HINT = /\b(subscription|subscr|membership|member|monthly|premium|plus|pro|recurring|renewal|plan|annual|yearly|gold|unlimited)\b/i;
  var ANNUAL_HINT = /\b(annual|annually|yearly|1 ?yr|12 ?mo|year plan)\b/i;
  var KEYWORD_CATS = [
    [/\b(dating|singles)\b/i, 'dating'],
    [/vpn|software|\.io\b/i, 'software'],
    [/stream|\btv\b|video|movie|flix|flick|cinema|\bfilm/i, 'streaming'],
    [/music|tune|melod|radio|audio|\bsound|\bsong|podcast/i, 'music'],
    [/cloud|storage|backup|vault/i, 'cloud'],
    [/\bgym\b|fitness|\bfit|yoga|pilates|workout|wellness|meditat/i, 'fitness'],
    [/\bmeal|\bfood|\beats\b|delivery|snack|munch/i, 'food'],
    [/\bgames?\b|gaming|arcade/i, 'games'],
    [/mobile|wireless|cellular|internet|broadband|fiber|telecom|\bphone\b/i, 'phone'],
    [/insur|\bins\b|assurance|warranty/i, 'insurance'],
    [/learn|lingo|course|academy|lesson|tutor|language/i, 'learning'],
    [/\bnews|times\b|journal|ledger|gazette|herald|tribune|magazine|\bdaily\b|\bweekly\b|\bpress\b/i, 'news'],
    [/\bapp\b|\bpro\b|\blabs?\b|studio|\bnote/i, 'software'],
  ];
  var STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC ON BC QC AB'.split(' ');
  var CITIES = ['NEW YORK', 'LOS ANGELES', 'LOS GATOS', 'SAN FRANCISCO', 'SAN JOSE', 'SAN DIEGO', 'SANTA MONICA', 'MOUNTAIN VIEW', 'CUPERTINO', 'PALO ALTO', 'MENLO PARK', 'SUNNYVALE', 'SEATTLE', 'REDMOND', 'BELLEVUE', 'CHICAGO', 'BOSTON', 'AUSTIN', 'DALLAS', 'HOUSTON', 'ATLANTA', 'MIAMI', 'DENVER', 'PHOENIX', 'PORTLAND', 'NEW YORK CITY', 'BROOKLYN', 'BURBANK', 'CULVER CITY', 'GLENDALE', 'OAKLAND', 'BERKELEY', 'IRVINE', 'NASHVILLE', 'CHARLOTTE', 'PHILADELPHIA', 'PITTSBURGH', 'WASHINGTON', 'ARLINGTON', 'TORONTO', 'VANCOUVER', 'LONDON', 'DUBLIN', 'LUXEMBOURG', 'STOCKHOLM', 'AMSTERDAM'];
  var STOP = { inc: 1, llc: 1, ltd: 1, co: 1, corp: 1, the: 1, com: 1, usa: 1, us: 1, company: 1, online: 1, www: 1, and: 1 };

  function matchKnown(up) {
    for (var i = 0; i < KNOWN.length; i++) if (KNOWN[i].re.test(up)) return KNOWN[i];
    return null;
  }
  function catFor(text, known) {
    if (known) return known.cat;
    for (var i = 0; i < KEYWORD_CATS.length; i++) if (KEYWORD_CATS[i][0].test(text)) return KEYWORD_CATS[i][1];
    return 'other';
  }

  /** The merchant inside a card descriptor, without the noise. */
  function stripDescriptor(desc) {
    var s = String(desc || '');
    // Fixed-width exports pad the name and the place with runs of spaces:
    // the first run is the most reliable separator there is.
    var parts = s.split(/\s{2,}|\t/).filter(function (p) { return p.trim(); });
    if (parts.length > 1 && /[A-Za-z]{2}/.test(parts[0])) s = parts[0];
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/\b(?:PURCHASE|PAYMENT|RECURRING PAYMENT|RECURRING)?\s*AUTHORI[ZS]ED ON\s+\d{1,2}\/\d{1,2}\s*/i, '');
    s = s.replace(/^(?:online |internet |mobile |web |bill )*(?:payment|pmt|pymt)\s*(?:#?\d+\s*)?(?:to|for)\s+/i, '');
    s = s.replace(/^(?:(?:POS|DEBIT|VISA|MC|ACH|CHECKCARD|CHECK CARD|CHKCARD|PURCHASE|RECURRING|PREAUTHORIZED|PRE-AUTHORIZED|DBT|CARD|DDA|WEB|PPD|BILL PAYMENT|BILL PAY)\b(?:\s+\d{4}\b)?[\s:#-]*)+/i, '');
    s = s.replace(/^(?:SQ|SQU|SQUARE|TST|TOAST|SP|SPO|PP|PAYPAL|PY|IN|DD|FS|BT|IC|WPY|CKO|PADDLE|STRIPE|LS|EB|ZTL|GOOGLE|GOOG|APL|AMZ|2CO|FSP|PMNT|WL|SUMUP|IZ|CLV|CLOVER)\s*\*\s*/i, '');
    var star = s.indexOf('*');
    if (star >= 0) {
      var before = s.slice(0, star).trim(), after = s.slice(star + 1).trim();
      s = /[A-Za-z].*[A-Za-z]/.test(before) && before.length >= 3 ? before : after;
    }
    s = s.replace(/\b(?:WWW|HELP|PAY|BILLING)\./gi, '')
      .replace(/\.(?:COM|NET|ORG|IO|CO|TV|APP|US|AI|ME|FM)\b(?:\/\S*)?/gi, '')
      .replace(/\+?\b1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, ' ')
      .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
      .replace(/#\s*\d+/g, ' ')
      .replace(/\b(?:STORE|STR|NO|NUM|LOC|UNIT|CARD|REF|ID)\.?\s*#?\s*\d+\b/gi, ' ')
      .replace(/\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z\d]{5,}\b/g, ' ')
      .replace(/\b\d{3,}\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
    // Places: a trailing state or country code, then a well-known city.
    for (var pass = 0; pass < 3; pass++) {
      var m = /\s+([A-Za-z]{2,3})$/.exec(s);
      if (m && (STATES.indexOf(m[1].toUpperCase()) >= 0 || /^(USA|US|GBR|CAN)$/i.test(m[1])) && s.length - m[0].length >= 3) s = s.slice(0, m.index).trim();
      else break;
    }
    var up = s.toUpperCase();
    for (var c = 0; c < CITIES.length; c++) {
      var city = CITIES[c];
      if (up.length > city.length + 2 && up.slice(-city.length - 1) === ' ' + city) { s = s.slice(0, s.length - city.length - 1).trim(); break; }
    }
    s = s.replace(/^[\s\-*,.&/:]+|[\s\-*,.&/:]+$/g, '').trim();
    // A trailing word that says how it was paid, not who was paid.
    var t = s.replace(/\s+(?:bill|billing|payment|pmt|pymt|autopay|recurring|online|purchase)$/i, '');
    return t.length >= 3 ? t : s;
  }

  var infoCache = new Map();
  /**
   * {key, name, cat, emoji, known, hint, annualHint} for a descriptor.
   * The key groups one merchant's charges: the curated id when it is a
   * known service, else the first three meaningful words, lower case.
   */
  function merchantInfo(desc) {
    var d = clean(desc, 200);
    if (infoCache.has(d)) return infoCache.get(d);
    var up = d.toUpperCase();
    var known = matchKnown(up);
    var stripped = stripDescriptor(d);
    var words = stripped.toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').split(' ').filter(function (w) { return w && !STOP[w]; });
    var key = known ? 'k:' + known.id : words.slice(0, 3).join(' ');
    if (!key) key = d.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 2).join(' ');
    if (!key) key = 'm' + hash(d).slice(0, 10);
    var name = known ? known.name : tidyCase(stripped.split(' ').slice(0, 4).join(' ')).slice(0, LIMITS.name).trim();
    if (!name) name = tidyCase(d.slice(0, LIMITS.name));
    var cat = catFor(d, known);
    var info = { key: key, name: name, cat: cat, emoji: CATS[cat].emoji, known: known ? known.id : null, yearly: Boolean(known && known.yearly), hint: SUB_HINT.test(d), annualHint: ANNUAL_HINT.test(d) };
    if (infoCache.size > 50000) infoCache.clear();
    infoCache.set(d, info);
    return info;
  }

  /* ---------------- finding the drips ---------------- */

  // Gaps between charges that count as each cadence, in days. Banks post on
  // business days (and February is short), so a monthly charge lands 25-36
  // days apart.
  var BANDS = {
    weekly: [6, 8, 7],
    monthly: [24, 37, 30],
    quarterly: [84, 98, 91],
    annual: [350, 380, 365],
  };
  var GRACE = { weekly: 4, monthly: 10, quarterly: 20, annual: 30 };

  /** Which cadence the gaps fit, or null. One skipped cycle (a gap of about
   *  two periods) is forgiven; anything else must sit in the band. */
  function cadenceOf(dates) {
    var gaps = [];
    for (var i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
    if (!gaps.length) return null;
    for (var c = 0; c < CADENCES.length; c++) {
      var b = BANDS[CADENCES[c]];
      var inBand = 0, skips = 0, bad = 0;
      gaps.forEach(function (g) {
        if (g >= b[0] && g <= b[1]) inBand++;
        else if (g >= 2 * b[0] && g <= 2 * b[1]) skips++;
        else bad++;
      });
      if (!bad && inBand >= 1 && skips <= Math.max(1, Math.floor(gaps.length / 4)) && inBand >= skips) return CADENCES[c];
    }
    return null;
  }

  /**
   * One merchant's charges split into series: one per thing it bills (Apple
   * bills iCloud and a music plan separately, on different days). A charge
   * joins the series whose last amount it matches exactly, else the closest
   * within 25% - but only once a cycle has passed since that series' last
   * charge, so two plans a fortnight apart are not woven into one.
   */
  function buildSeries(charges) {
    var series = [], exact = new Map(), recent = [], seq = 0;
    charges.forEach(function (c) {
      var pick = null;
      var ex = exact.get(c.cents);
      if (ex && ex.length) pick = ex[ex.length - 1];
      else {
        var best = null, bestD = Infinity, seen = 0, dn = dayNum(c.date);
        for (var k = recent.length - 1; k >= 0 && seen < 60; k--) {
          var e = recent[k];
          if (e.seq !== e.s.seq) continue;
          seen++;
          var s = e.s, last = s.charges[s.charges.length - 1];
          var diff = Math.abs(c.cents - last.cents), mx = Math.max(c.cents, last.cents);
          if (!mx || diff > 0.25 * mx) continue;
          var gap = dn - dayNum(last.date);
          var span = s.charges.length > 1 ? (dayNum(last.date) - dayNum(s.charges[0].date)) / (s.charges.length - 1) : 0;
          if (gap < (span ? 0.75 * span : 20)) continue;
          if (diff < bestD) { best = s; bestD = diff; }
        }
        pick = best;
      }
      if (!pick) { pick = { charges: [], seq: 0 }; series.push(pick); }
      else {
        var lastC = pick.charges[pick.charges.length - 1].cents;
        if (lastC !== c.cents) {
          var arr = exact.get(lastC) || [];
          var at = arr.indexOf(pick); if (at >= 0) arr.splice(at, 1);
        }
      }
      var list = exact.get(c.cents) || [];
      if (list.indexOf(pick) < 0) list.push(pick);
      exact.set(c.cents, list);
      pick.charges.push(c);
      pick.seq = ++seq;
      recent.push({ s: pick, seq: pick.seq });
    });
    return series;
  }

  /** Charges a few days apart for the same amount, as one cycle with copies. */
  function clusters(charges) {
    var out = [];
    charges.forEach(function (c) {
      var last = out[out.length - 1];
      if (last && last.cents === c.cents && daysBetween(last.date, c.date) <= 3) last.items.push(c);
      else out.push({ date: c.date, cents: c.cents, items: [c] });
    });
    return out;
  }

  function hash(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
  }

  /** The next expected charge on or after `from`. `day` is the usual
   *  billing day of the month (posting jitters a few days either way). */
  function nextOnOrAfter(last, cadence, from, day) {
    var at = function (k) {
      var n = step(last, cadence, k);
      if (!day || cadence === 'weekly') return n;
      var y = +n.slice(0, 4), m = +n.slice(5, 7);
      var lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      var fixed = ymd(y, m, Math.min(day, lastDay));
      return daysBetween(last, fixed) >= (cadence === 'monthly' ? 20 : cadence === 'quarterly' ? 75 : 340) ? fixed : n;
    };
    var k = 1, n = at(1);
    while (from && n < from && k < 600) { k++; n = at(k); }
    return n;
  }
  function usualDay(dates) {
    var days = dates.slice(-6).map(function (d) { return +d.slice(8, 10); }).sort(function (a, b) { return a - b; });
    return days[Math.floor((days.length - 1) / 2)];
  }

  /**
   * The whole job: transactions -> drips. `today` (ISO) decides what is
   * "coming up"; `asOf` (the statement's last day, by default) decides what
   * has "gone quiet".
   */
  function findRecurring(transactions, opts) {
    var o = opts || {};
    var txs = (Array.isArray(transactions) ? transactions : []).filter(function (t) { return t && isoDay(t.date) && Number.isInteger(t.cents) && t.cents >= 0 && t.desc; });
    txs.sort(byDate);
    var asOf = o.asOf && isoDay(o.asOf) ? o.asOf : (txs.length ? txs[txs.length - 1].date : o.today);
    var today = o.today && isoDay(o.today) ? o.today : asOf;
    var groups = new Map();
    txs.forEach(function (t) {
      var info = merchantInfo(t.desc);
      var g = groups.get(info.key);
      if (!g) { g = { info: info, charges: [] }; groups.set(info.key, g); }
      g.charges.push(t);
    });
    var drips = [];
    groups.forEach(function (g) {
      var paid = g.charges.filter(function (c) { return c.cents > 0; });
      var all = buildSeries(g.charges);
      var used = [];
      all.forEach(function (s) {
        if (!s.charges.some(function (c) { return c.cents > 0; })) return;
        var cl = clusters(s.charges);
        var doubled = cl.filter(function (x) { return x.items.length >= 2; });
        var tracks = [cl.map(function (x) { return x.items[0]; })];
        var twice = false;
        if (doubled.length >= 2 && doubled.length * 2 >= cl.length) {
          twice = true;
          tracks.push(doubled.map(function (x) { return x.items[1]; }));
        }
        tracks.forEach(function (charges, ti) {
          var d = evaluate(g, charges, paid.length, asOf, today);
          if (!d) return;
          d.twice = twice;
          d.copy = ti;
          d._series = s;
          drips.push(d);
          used.push(s);
        });
      });
      // A trial: a $0 or $1 charge, then the full price 3 to 45 days later.
      all.forEach(function (t) {
        if (t.charges.length !== 1 || t.charges[0].cents > 100) return;
        var trial = t.charges[0];
        drips.forEach(function (d) {
          if (d.key !== g.info.key || d.trial) return;
          var first = d.charges[0];
          var gap = daysBetween(trial.date, first.date);
          if (gap >= 3 && gap <= 45 && first.cents >= 3 * Math.max(trial.cents, 1)) d.trial = { date: trial.date, cents: trial.cents };
        });
      });
    });
    // Stable ids: the merchant and cadence, then a counter for a merchant
    // with two plans on the same cadence (most expensive first).
    drips.sort(function (a, b) { return b.cents - a.cents; });
    var ids = {};
    drips.forEach(function (d) {
      var base = d.key + '|' + d.cadence + (d.copy ? '|copy' : '');
      ids[base] = (ids[base] || 0) + 1;
      d.id = 'd' + hash(base + (ids[base] > 1 ? '|' + ids[base] : '')).slice(0, 12);
      if (d.copy) d.name = clean(d.name + ' (2nd charge)', LIMITS.name + 13);
      delete d._series; delete d.copy;
    });
    flagAll(drips, today);
    drips.sort(function (a, b) { return (a.quiet - b.quiet) || (yearlyOf(b.cents, b.cadence) - yearlyOf(a.cents, a.cadence)) || (a.name < b.name ? -1 : 1); });
    return { drips: drips, asOf: asOf, today: today, considered: txs.length };
  }

  function evaluate(g, charges, groupPaid, asOf, today) {
    var info = g.info;
    var paidCharges = charges.filter(function (c) { return c.cents > 0; });
    if (!paidCharges.length) return null;
    var dates = paidCharges.map(function (c) { return c.date; });
    var n = paidCharges.length;
    var cadence = null, confidence = 'medium', probablyYearly = false;
    var trusted = Boolean(info.known) || info.hint;
    if (n === 1) {
      // One charge only: a yearly service, if the descriptor or the curated
      // table says so and the statement runs long enough after it that a
      // monthly one would have shown up again.
      if (!(info.yearly || info.annualHint)) return null;
      if (daysBetween(dates[0], asOf) < 40 || paidCharges[0].cents < 300) return null;
      cadence = 'annual'; probablyYearly = true; confidence = 'low';
    } else {
      cadence = cadenceOf(dates);
      if (!cadence) return null;
      var amounts = paidCharges.map(function (c) { return c.cents; });
      var changes = 0;
      for (var i = 1; i < amounts.length; i++) if (amounts[i] !== amounts[i - 1]) changes++;
      var rising = amounts.every(function (a, j) { return !j || a >= amounts[j - 1]; });
      if (!trusted) {
        // An unknown merchant has to look like a subscription, not a shop
        // you happen to visit monthly: enough charges, near-fixed amounts
        // (or a clean step up), and most of that merchant's charges.
        var need = cadence === 'weekly' ? 4 : cadence === 'annual' ? 2 : 3;
        if (n < need) return null;
        if (changes > Math.max(1, Math.floor((n - 1) / 4)) && !(rising && changes <= 3)) return null;
        if (n * 10 < groupPaid * 4 && n < 6) return null;
        if (cadence === 'weekly' && changes > 1) return null;
      }
      confidence = n >= 3 && (trusted || changes <= 1) ? 'high' : n >= 3 ? 'medium' : 'low';
    }
    var last = dates[dates.length - 1];
    var cents = paidCharges[paidCharges.length - 1].cents;
    var expected = step(last, cadence, 1);
    var quiet = !probablyYearly && dayNum(expected) + GRACE[cadence] < dayNum(asOf);
    return {
      key: info.key,
      name: info.name,
      cat: info.cat,
      emoji: CATS[info.cat].emoji,
      known: info.known,
      cadence: cadence,
      cents: cents,
      monthly: monthlyOf(cents, cadence),
      yearly: yearlyOf(cents, cadence),
      first: dates[0],
      last: last,
      next: quiet ? null : nextOnOrAfter(last, cadence, today, dates.length > 2 ? usualDay(dates) : null),
      confidence: confidence,
      probablyYearly: probablyYearly,
      quiet: quiet,
      charges: paidCharges.map(function (c) { return { date: c.date, cents: c.cents }; }),
      source: 'statement',
      decision: null,
      notes: '',
      flags: [],
    };
  }

  /* ---------------- the flags ---------------- */

  var FLAG_RANK = { creep: 0, trial: 1, double: 2, twice: 3, renewal: 4, quiet: 5 };

  function flagAll(drips, today) {
    drips.forEach(function (d) { d.flags = []; });
    drips.forEach(function (d) {
      if (d.quiet) {
        d.flags.push({ type: 'quiet', money: 0, text: d.name + ': last charged in ' + monthName(d.last) + '. Did you cancel? (Not counted in your total.)' });
        return;
      }
      var f = creepOf(d);
      if (f) d.flags.push(f);
      if (d.trial) {
        d.flags.push({ type: 'trial', money: d.yearly, text: d.name + ' began as a ' + money(d.trial.cents) + ' trial in ' + monthName(d.trial.date) + ' - now ' + money(d.charges[d.charges.length - 1].cents) + ' ' + CADENCE_WORD[d.cadence] + '.' });
      }
      if (d.twice) {
        d.flags.push({ type: 'twice', money: d.yearly, text: d.name.replace(/ \(2nd charge\)$/, '') + ' charges you twice ' + (d.cadence === 'weekly' ? 'a week' : d.cadence === 'annual' ? 'a year' : 'each cycle') + ' - two accounts, or a family plan and your own?' });
      }
      if (d.cadence === 'annual' && d.next && daysBetween(today, d.next) >= 0 && daysBetween(today, d.next) <= 30) {
        var days = daysBetween(today, d.next);
        d.flags.push({ type: 'renewal', money: d.cents, text: d.name + ' renews ' + (days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'on ' + fmtDate(d.next) + ' (in ' + days + ' days)') + ' - ' + money(d.cents) + ' for another year.' });
      }
    });
    // Doubles: two active services in a category where one is usually enough.
    var byCat = {};
    drips.forEach(function (d) { if (!d.quiet && DOUBLE_CATS.indexOf(d.cat) >= 0 && !d.twice) (byCat[d.cat] = byCat[d.cat] || []).push(d); });
    Object.keys(byCat).forEach(function (cat) {
      var list = byCat[cat];
      if (list.length < 2) return;
      var names = list.map(function (d) { return d.name; });
      var together = list.reduce(function (s, d) { return s + d.yearly; }, 0);
      var cheapest = list.reduce(function (m, d) { return Math.min(m, d.yearly); }, Infinity);
      var what = { music: 'music apps', cloud: 'cloud storage plans', fitness: 'fitness memberships', food: 'delivery passes', dating: 'dating apps' }[cat];
      var text = (list.length === 2 ? 'Two ' : list.length + ' ') + what + ': ' + joinNames(names) + ' - ' + money(together) + ' a year together.';
      list.forEach(function (d) { d.flags.push({ type: 'double', money: cheapest, text: text, with: list.filter(function (x) { return x !== d; }).map(function (x) { return x.id; }) }); });
    });
    drips.forEach(function (d) { d.flags.sort(function (a, b) { return FLAG_RANK[a.type] - FLAG_RANK[b.type]; }); });
  }
  function joinNames(n) { return n.length <= 2 ? n.join(' and ') : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1]; }

  /** Price creep: the amount only ever went up, and ended higher. */
  function creepOf(d) {
    var a = d.charges.map(function (c) { return c.cents; });
    if (a.length < 2) return null;
    var rising = a.every(function (x, i) { return !i || x >= a[i - 1]; });
    var from = a[0], to = a[a.length - 1];
    if (!rising || to <= from || (to - from) * 100 < from * 2) return null;
    var rises = 0, lastAt = null;
    for (var i = 1; i < a.length; i++) if (a[i] > a[i - 1]) { rises++; lastAt = d.charges[i].date; }
    var up = (to - from) * (PER_YEAR[d.cadence] || 12);
    var when = rises > 1 ? ' (' + (rises === 2 ? 'twice' : rises + ' times') + ', last in ' + monthName(lastAt) + ')' : ' in ' + monthName(lastAt);
    return { type: 'creep', money: up, from: from, to: to, rises: rises, text: d.name + ' went from ' + money(from) + ' to ' + money(to) + when + ' - up ' + money(up, { whole: up >= 1000 }) + ' a year.' };
  }

  /** Every flag across the list, most surprising first. */
  function topFlags(drips, n) {
    var out = [];
    (drips || []).forEach(function (d) {
      (d.flags || []).forEach(function (f) {
        // A double is one flag, not one per service.
        if (f.type === 'double' && out.some(function (x) { return x.type === 'double' && x.text === f.text; })) return;
        out.push({ type: f.type, text: f.text, money: f.money || 0, id: d.id, emoji: d.emoji });
      });
    });
    out.sort(function (a, b) { return (FLAG_RANK[a.type] - FLAG_RANK[b.type]) || (b.money - a.money); });
    return n ? out.slice(0, n) : out;
  }

  /* ---------------- totals, savings ---------------- */

  /** Active drips only: a drip that has gone quiet is not counted. */
  function totals(drips) {
    var active = (drips || []).filter(function (d) { return !d.quiet; });
    var yearly = 0, cats = {};
    active.forEach(function (d) {
      var y = yearlyOf(d.cents, d.cadence);
      yearly += y;
      var c = cats[d.cat] || (cats[d.cat] = { cat: d.cat, label: CATS[d.cat].label, short: CATS[d.cat].short, emoji: CATS[d.cat].emoji, color: CATS[d.cat].color, yearly: 0, count: 0 });
      c.yearly += y; c.count++;
    });
    var byCat = Object.keys(cats).map(function (k) { var c = cats[k]; c.monthly = Math.round(c.yearly / 12); return c; })
      .sort(function (a, b) { return b.yearly - a.yearly || (a.label < b.label ? -1 : 1); });
    return { count: active.length, quiet: (drips || []).length - active.length, yearly: yearly, monthly: Math.round(yearly / 12), byCat: byCat };
  }

  // What a year of savings buys, smallest first. Deterministic: the same
  // amount always gets the same line.
  var EQUIVALENTS = [
    [0, 'a takeaway coffee or two'],
    [2000, 'a few fancy coffees'],
    [5000, 'a couple of movie nights'],
    [12000, 'a really nice dinner out'],
    [25000, 'concert tickets for two'],
    [50000, 'a weekend away'],
    [100000, 'a new phone'],
    [200000, 'a week somewhere warm'],
    [400000, 'a proper holiday for two'],
  ];
  function equivalent(yearlyCents) {
    var y = Math.max(0, Math.round(yearlyCents || 0));
    if (!y) return '';
    var pick = EQUIVALENTS[0][1];
    for (var i = 0; i < EQUIVALENTS.length; i++) if (y >= EQUIVALENTS[i][0]) pick = EQUIVALENTS[i][1];
    return pick;
  }
  function savings(drips) {
    var cut = (drips || []).filter(function (d) { return d.decision === 'cut' && !d.quiet; });
    var yearly = cut.reduce(function (s, d) { return s + yearlyOf(d.cents, d.cadence); }, 0);
    return { count: cut.length, yearly: yearly, monthly: Math.round(yearly / 12), equivalent: equivalent(yearly) };
  }
  function savingsLine(s) {
    if (!s.count) return 'Swipe left on anything you’d cancel - the savings add up here.';
    return 'Cutting ' + s.count + ' saves ' + money(s.yearly, { whole: s.yearly >= 10000 }) + ' a year - that’s ' + s.equivalent + '.';
  }

  function howToCancel(d) {
    var base = 'Usually: Account → Subscription → Cancel. Bought through Apple or Google? Cancel in your phone’s Settings → Subscriptions.';
    if (d && d.cat === 'fitness' && !d.known) return 'Gyms often want it in person or in writing - ask for a confirmation email. ' + base;
    if (d && (d.cat === 'phone' || d.cat === 'insurance')) return 'Call them or use their app - and ask about a cheaper plan before you go. Keep the confirmation number.';
    if (d && d.known === 'apple') return 'Settings → your name → Subscriptions on your iPhone shows every Apple charge separately.';
    if (d && d.known === 'googleplay') return 'Google Play → profile → Payments & subscriptions → Subscriptions.';
    return base;
  }

  /* ---------------- the reminder calendar (RFC 5545) ---------------- */

  function icsText(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n');
  }
  function utf8Len(ch) { var c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  /** Lines of at most 75 octets, continued with CRLF + space, never
   *  splitting a UTF-8 character. */
  function fold(line) {
    var out = [], cur = '', len = 0;
    Array.from(line).forEach(function (ch) {
      var l = utf8Len(ch);
      if (len + l > 75) { out.push(cur); cur = ' '; len = 1; }
      cur += ch; len += l;
    });
    out.push(cur);
    return out.join('\r\n');
  }
  function stamp(iso) {
    var d = new Date(iso || Date.now());
    if (isNaN(d)) d = new Date();
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  /**
   * What goes in the calendar: a "cancel before" reminder two days ahead of
   * each cut drip's next charge, and a heads-up a week before each yearly
   * renewal that is not being cut. Never in the past.
   */
  function reminders(drips, today) {
    var out = [];
    (drips || []).forEach(function (d) {
      if (d.quiet || !isoDay(d.next)) return;
      if (d.decision === 'cut') {
        var at = addDays(d.next, -2);
        if (today && at < today) at = today;
        out.push({ id: d.id, kind: 'cancel', date: at, title: 'Cancel ' + d.name + ' before ' + fmtDate(d.next), detail: 'Next charge: ' + money(d.cents) + ' on ' + fmtDate(d.next, today && today.slice(0, 4)) + '. ' + howToCancel(d) });
      } else if (d.cadence === 'annual') {
        var at2 = addDays(d.next, -7);
        if (today && at2 < today) at2 = today;
        out.push({ id: d.id, kind: 'renew', date: at2, title: d.name + ' renews ' + fmtDate(d.next) + ' - ' + money(d.cents), detail: 'Your yearly ' + d.name + ' renews on ' + fmtDate(d.next, today && today.slice(0, 4)) + ' for ' + money(d.cents) + '. Still using it? ' + howToCancel(d) });
      }
    });
    return out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }

  /** One all-day event per reminder, with an alert at 9am that day. UIDs
   *  come from the drip and the kind, not the date, so importing again
   *  moves an event instead of adding a second. */
  function ics(opts) {
    var o = opts || {};
    var items = o.items || reminders(o.drips, o.today);
    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Challenge Lab//Drip//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsText('Drip reminders')];
    var dt = stamp(o.now);
    items.forEach(function (it) {
      if (!isoDay(it.date)) return;
      L.push('BEGIN:VEVENT',
        'UID:' + hash(String(it.id) + '|' + it.kind) + '@drip.challenge.strongtechnicalconsulting.com',
        'DTSTAMP:' + dt,
        'DTSTART;VALUE=DATE:' + it.date.replace(/-/g, ''),
        'DTEND;VALUE=DATE:' + addDays(it.date, 1).replace(/-/g, ''),
        'SUMMARY:' + icsText(it.title),
        'DESCRIPTION:' + icsText(it.detail + '\nFrom your Drip list.'),
        'TRANSP:TRANSPARENT',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(it.title), 'TRIGGER:PT9H', 'END:VALARM',
        'END:VEVENT');
    });
    L.push('END:VCALENDAR');
    return L.map(fold).join('\r\n') + '\r\n';
  }

  /* ---------------- cleaning a drip from anywhere ---------------- */

  var ID_RE = /^d[0-9a-f]{12}$/;
  var SAVED_FIELDS = ['id', 'key', 'name', 'cat', 'cents', 'cadence', 'next', 'decision', 'notes', 'source', 'quiet'];

  function cadenceFrom(v) {
    var s = String(v == null ? '' : v).toLowerCase().trim();
    if (CADENCES.indexOf(s) >= 0) return s;
    if (/^(year|yearly|annually|per year|a year|yr|\/yr|12 months)$/.test(s)) return 'annual';
    if (/^(month|monthly|per month|a month|mo|\/mo|every month)$/.test(s)) return 'monthly';
    if (/^(week|weekly|per week|a week|wk|every week)$/.test(s)) return 'weekly';
    if (/^(quarter|quarterly|every 3 months|3 months|every three months)$/.test(s)) return 'quarterly';
    return null;
  }

  /**
   * A drip, made safe: bounded strings, markup and control characters gone,
   * cents through the parser, enums checked. null when it has no name or no
   * price. `opts.local` keeps the flag sentences (this phone only); the
   * server never gets them.
   */
  function cleanDrip(raw, opts) {
    var o = opts || {};
    if (!raw || typeof raw !== 'object') return null;
    var name = clean(raw.name, LIMITS.name);
    var cents = Number.isInteger(raw.cents) ? raw.cents : toCents(raw.cents);
    if (!name || !/[\p{L}\p{N}]/u.test(name) || !cents || cents < 1 || cents > LIMITS.maxCents) return null;
    var cadence = CADENCES.indexOf(raw.cadence) >= 0 ? raw.cadence : 'monthly';
    var key = typeof raw.key === 'string' && /^(k:[a-z0-9]{1,24}|[a-z0-9& ]{1,60})$/.test(raw.key) ? raw.key : merchantInfo(name).key;
    var cat = CAT_IDS.indexOf(raw.cat) >= 0 ? raw.cat : merchantInfo(name).cat;
    var d = {
      id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : 'd' + hash(key + '|' + cadence + '|' + name).slice(0, 12),
      key: key,
      name: name,
      cat: cat,
      cents: cents,
      cadence: cadence,
      next: isoDay(raw.next) ? raw.next : null,
      decision: DECISIONS.indexOf(raw.decision) >= 0 ? raw.decision : null,
      notes: clean(raw.notes, LIMITS.notes),
      source: SOURCES.indexOf(raw.source) >= 0 ? raw.source : 'hand',
      quiet: raw.quiet === true,
    };
    if (o.local) {
      d.flags = (Array.isArray(raw.flags) ? raw.flags : []).slice(0, 6).map(function (f) {
        return f && FLAG_TYPES.indexOf(f.type) >= 0 ? { type: f.type, text: clean(f.text, 220), money: Number.isInteger(f.money) && f.money >= 0 ? f.money : 0 } : null;
      }).filter(Boolean);
      if (isoDay(raw.last)) d.last = raw.last;
      if (['high', 'medium', 'low'].indexOf(raw.confidence) >= 0) d.confidence = raw.confidence;
      if (raw.probablyYearly === true) d.probablyYearly = true;
      d.charges = (Array.isArray(raw.charges) ? raw.charges : []).slice(-24).map(function (c) {
        return c && isoDay(c.date) && Number.isInteger(c.cents) && c.cents >= 0 && c.cents <= LIMITS.maxCents ? { date: c.date, cents: c.cents } : null;
      }).filter(Boolean);
    }
    return withDerived(d);
  }
  function withDerived(d) {
    d.emoji = CATS[d.cat].emoji;
    d.monthly = monthlyOf(d.cents, d.cadence);
    d.yearly = yearlyOf(d.cents, d.cadence);
    if (!d.flags) d.flags = [];
    return d;
  }
  /** A list: cleaned, unique ids, at most `max`. */
  function cleanList(arr, opts) {
    var o = opts || {};
    var seen = {}, out = [];
    (Array.isArray(arr) ? arr : []).slice(0, (o.max || LIMITS.drips) * 2).forEach(function (r) {
      var d = cleanDrip(r, o);
      if (!d || seen[d.id] || out.length >= (o.max || LIMITS.drips)) return;
      seen[d.id] = true; out.push(d);
    });
    return out;
  }
  /** Only the fields a saved list keeps. Never a charge, never a flag. */
  function toSaved(d) {
    var out = {};
    SAVED_FIELDS.forEach(function (k) { out[k] = d[k]; });
    return out;
  }

  /** A hand-typed drip from the form's fields. */
  function handDrip(f, today) {
    var cents = toCents(String((f && f.amount) || ''));
    if (!cents) return { error: 'Type what it costs, like 9.99.' };
    var name = clean(f.name, LIMITS.name);
    if (!name) return { error: 'Give it a name.' };
    var cadence = cadenceFrom(f.cadence) || 'monthly';
    var next = isoDay(f.next) ? f.next : null;
    var info = merchantInfo(name);
    if (next && today && next < today) next = nextOnOrAfter(next, cadence, today);
    var d = cleanDrip({ name: name, cents: cents, cadence: cadence, next: next, cat: CAT_IDS.indexOf(f.cat) >= 0 ? f.cat : info.cat, source: 'hand', key: info.key, notes: f.notes }, { local: true });
    if (!d) return { error: 'That one could not be added.' };
    return { drip: d };
  }

  /**
   * A model's reading of a subscriptions screenshot, made safe: at most 60
   * items, prices through the cents parser (a price in words is no price and
   * the item is dropped), cadence from a fixed set, renewal dates checked
   * against today. Returns {items, dropped}.
   */
  function cleanSnapItems(raw, today) {
    var list = raw && Array.isArray(raw.items) ? raw.items : [];
    var items = [], dropped = 0;
    var lo = today ? addDays(today, -400) : null, hi = today ? addDays(today, 800) : null;
    list.slice(0, LIMITS.snapItems * 3).forEach(function (it) {
      if (!it || typeof it !== 'object') { dropped++; return; }
      var name = clean(typeof it.name === 'string' ? it.name : '', LIMITS.name);
      var cents = toCents(typeof it.price === 'number' || typeof it.price === 'string' ? it.price : null);
      var cadence = cadenceFrom(it.cadence);
      if (!name || !/[\p{L}\p{N}]/u.test(name) || !cents || !cadence || items.length >= LIMITS.snapItems) { dropped++; return; }
      var renews = typeof it.renews === 'string' && isoDay(it.renews.slice(0, 10)) ? it.renews.slice(0, 10) : null;
      if (renews && lo && (renews < lo || renews > hi)) renews = null;
      items.push({ name: name, cents: cents, cadence: cadence, renews: renews });
    });
    return { items: items, dropped: dropped };
  }
  /** Reviewed snap items as drips. */
  function snapToDrips(items, today) {
    return (items || []).map(function (it) {
      var info = merchantInfo(it.name);
      var next = it.renews || null;
      if (next && today && next < today) next = nextOnOrAfter(next, it.cadence, today);
      return cleanDrip({ name: info.known ? KNOWN_BY_ID[info.known].name : it.name, cents: it.cents, cadence: it.cadence, next: next, cat: info.cat, key: info.key, source: 'snap' }, { local: true });
    }).filter(Boolean);
  }

  /**
   * Bring decisions and notes over from an earlier list onto newly found
   * drips (by id, else merchant and cadence), and keep hand-added and
   * snapped drips the statement could not see.
   */
  function carryOver(found, prev) {
    var old = cleanList(prev, { local: true });
    var byId = {}, byKey = {};
    old.forEach(function (d) { byId[d.id] = d; byKey[d.key + '|' + d.cadence] = d; });
    var taken = {};
    var out = found.map(function (d) {
      var p = byId[d.id] || byKey[d.key + '|' + d.cadence];
      if (!p) return d;
      taken[p.id] = true;
      var c = Object.assign({}, d, { decision: p.decision, notes: p.notes });
      if (p.source === 'hand' || p.source === 'snap') c.name = p.name;
      return c;
    });
    old.forEach(function (d) { if (!taken[d.id] && d.source !== 'statement') out.push(d); });
    return out;
  }

  /** Since the last check: new drips, price changes, and ones that went. */
  function compare(prev, next) {
    var p = cleanList(prev, { max: 400 }), n = cleanList(next, { max: 400 });
    var key = function (d) { return d.key + '|' + d.cadence; };
    var pk = {}, nk = {};
    p.forEach(function (d) { pk[key(d)] = d; });
    n.forEach(function (d) { nk[key(d)] = d; });
    var added = [], changed = [], gone = [];
    n.forEach(function (d) {
      if (d.quiet) return;
      var o = pk[key(d)];
      if (!o) added.push({ name: d.name, cents: d.cents, cadence: d.cadence });
      else if (o.cents !== d.cents) changed.push({ name: d.name, from: o.cents, to: d.cents, cadence: d.cadence, yearly: (d.cents - o.cents) * PER_YEAR[d.cadence] });
    });
    p.forEach(function (d) { if (!d.quiet && d.source === 'statement' && (!nk[key(d)] || nk[key(d)].quiet)) gone.push({ name: d.name, cents: d.cents, cadence: d.cadence }); });
    return { added: added, changed: changed, gone: gone };
  }

  return {
    LIMITS: LIMITS, CADENCES: CADENCES, PER_YEAR: PER_YEAR, CADENCE_WORD: CADENCE_WORD, CADENCE_LABEL: CADENCE_LABEL,
    CATS: CATS, CAT_IDS: CAT_IDS, DOUBLE_CATS: DOUBLE_CATS, DECISIONS: DECISIONS, SOURCES: SOURCES, FLAG_TYPES: FLAG_TYPES,
    KNOWN: KNOWN, SAVED_FIELDS: SAVED_FIELDS, ID_RE: ID_RE, EQUIVALENTS: EQUIVALENTS, BANDS: BANDS,
    clean: clean, tidyCase: tidyCase, readMoney: readMoney, toCents: toCents, signedCents: signedCents, money: money, plain: plain,
    yearlyOf: yearlyOf, monthlyOf: monthlyOf,
    isoDay: isoDay, addDays: addDays, addMonths: addMonths, daysBetween: daysBetween, step: step, fmtDate: fmtDate, monthName: monthName, parseDate: parseDate,
    detectDelimiter: detectDelimiter, parseCsv: parseCsv, columns: columns, parseStatement: parseStatement, parseStatements: parseStatements,
    stripDescriptor: stripDescriptor, merchantInfo: merchantInfo,
    cadenceOf: cadenceOf, buildSeries: buildSeries, findRecurring: findRecurring, creepOf: creepOf, topFlags: topFlags,
    totals: totals, equivalent: equivalent, savings: savings, savingsLine: savingsLine, howToCancel: howToCancel,
    icsText: icsText, fold: fold, hash: hash, reminders: reminders, ics: ics,
    cadenceFrom: cadenceFrom, cleanDrip: cleanDrip, cleanList: cleanList, toSaved: toSaved, handDrip: handDrip,
    cleanSnapItems: cleanSnapItems, snapToDrips: snapToDrips, carryOver: carryOver, compare: compare,
  };
}));
