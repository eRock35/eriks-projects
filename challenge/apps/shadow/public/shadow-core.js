/* Shadow - the rules, in one file the page, the server and the tests all run.
 *
 * UMD: the page loads it as window.ShadowCore, the server and the tests
 * require() it. Everything that decides a number lives here: reading a card
 * statement and finding the software in it (and the trials), reading a Google
 * Workspace or Microsoft Entra app-access export and turning scope strings
 * into plain risk words, merging every source into one inventory, the Shadow
 * score, the fix list, the trial and renewal radar and its .ics, the CSV
 * export, the staff requests, and the cleaning a vendor-terms reading goes
 * through. No DOM, no network, no clock of its own: "today" is always passed
 * in, so a test can pin it.
 *
 * Money is integer cents throughout, read from the typed digits and never
 * through a float.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShadowCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    bytes: 5 * 1024 * 1024,   // across the files of one import
    rows: 20000,              // across the files of one import
    files: 6,
    tools: 500,               // in one inventory
    openRequests: 200,        // waiting in one org's queue
    orgs: 3,                  // per account
    name: 60,
    owner: 60,
    notes: 600,
    reason: 400,
    conditions: 400,
    listLines: 300,           // a pasted list
    termsText: 60000,         // characters of vendor terms per reading
    termsMin: 300,
    maxCents: 100000000000,   // $1,000,000,000 - any one figure
    maxUsers: 1000000,
    done: 100,                // applied fixes remembered
  };

  /* ---------------- vocabulary ---------------- */

  var STATUSES = ['approved', 'review', 'unapproved', 'retiring'];
  var STATUS_LABEL = { approved: 'Approved', review: 'Under review', unapproved: 'Not approved', retiring: 'Retiring' };
  var CONTRACTS = ['none', 'clickthrough', 'signed'];
  var CONTRACT_LABEL = { none: 'No contract', clickthrough: 'Click-through terms', signed: 'Signed contract' };
  var DATA = ['customer', 'employee', 'financial', 'health', 'student', 'confidential', 'none'];
  var DATA_LABEL = { customer: 'Customer PII', employee: 'Employee PII', financial: 'Financial', health: 'Health', student: 'Student records', confidential: 'Confidential / internal', none: 'None' };
  var DATA_WORDS = { customer: 'customer PII', employee: 'employee PII', financial: 'financial data', health: 'health data', student: 'student records', confidential: 'internal files', none: 'nothing sensitive' };
  // Personal data: the kinds a data-processing agreement is for.
  var PERSONAL = ['customer', 'employee', 'financial', 'health', 'student'];
  var CADENCES = ['weekly', 'monthly', 'quarterly', 'annual'];
  var PER_YEAR = { weekly: 52, monthly: 12, quarterly: 4, annual: 1 };
  var SOURCES = ['card', 'signin', 'list', 'hand', 'request'];
  var SOURCE_LABEL = { card: 'Card', signin: 'Sign-ins', list: 'List', hand: 'Added by hand', request: 'Request' };

  var CATS = {
    suite: { label: 'Office suite', emoji: '🏢' },
    crm: { label: 'CRM & sales', emoji: '🤝' },
    hr: { label: 'HR & payroll', emoji: '🧑‍💼' },
    edu: { label: 'Teaching & learning', emoji: '🎓' },
    files: { label: 'File sharing & backup', emoji: '🗂️' },
    esign: { label: 'E-signature', emoji: '✍️' },
    design: { label: 'Design', emoji: '🎨' },
    ai: { label: 'AI assistants', emoji: '🤖' },
    analytics: { label: 'Analytics', emoji: '📊' },
    scheduling: { label: 'Scheduling & booking', emoji: '📅' },
    chat: { label: 'Chat & phones', emoji: '💬' },
    video: { label: 'Video meetings', emoji: '🎥' },
    project: { label: 'Projects & tasks', emoji: '📋' },
    docs: { label: 'Docs & notes', emoji: '📝' },
    forms: { label: 'Forms & surveys', emoji: '🧾' },
    marketing: { label: 'Email & marketing', emoji: '📣' },
    finance: { label: 'Accounting & payments', emoji: '💵' },
    support: { label: 'Help desk', emoji: '🎧' },
    dev: { label: 'Developer & automation', emoji: '🛠️' },
    security: { label: 'Passwords & security', emoji: '🔐' },
    web: { label: 'Website & hosting', emoji: '🌐' },
    health: { label: 'Health records', emoji: '🩺' },
    other: { label: 'Other software', emoji: '🧩' },
  };
  var CAT_IDS = Object.keys(CATS);
  // Categories where one tool is usually enough: two is a cost and a second
  // place the same data lives.
  var OVERLAP_CATS = ['esign', 'files', 'video', 'chat', 'scheduling', 'forms', 'project', 'docs', 'security', 'marketing', 'support'];
  var OVERLAP_NOUN = { esign: 'e-signature tools', files: 'file-sharing tools', video: 'video-meeting tools', chat: 'chat tools', scheduling: 'booking tools', forms: 'form builders', project: 'project tools', docs: 'note apps', security: 'password managers', marketing: 'email-marketing tools', support: 'help desks' };

  /* ---------------- text ---------------- */

  // Control characters, and the bidi and zero-width ones that can make a
  // name read backwards on screen. The emoji joiner (U+200D) stays.
  var CTRL = /[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;

  /** Markup, control and bidi characters out, whitespace collapsed - what
   *  clean() does before it bounds a string. */
  function scrub(v) {
    return String(v).replace(/<[^>]*>?/g, ' ').replace(CTRL, ' ').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  /** A plain, bounded, single-line string: markup, control and bidi
   *  characters gone. Anything that is not a string or number is ''. */
  function clean(v, max) {
    if (typeof v !== 'string' && typeof v !== 'number') return '';
    var lim = max || 400;
    var s = scrub(String(v).slice(0, lim * 4 + 16));
    if (s.length > lim) s = Array.from(s).slice(0, lim).join('').trim();
    return s;
  }
  function oneOf(v, list, dflt) { return list.indexOf(v) >= 0 ? v : dflt; }

  /** "NOTEWISE AI" -> "Notewise AI"; mixed case is left as typed. Short
   *  words with no vowel ("HR", "CRM") and known initialisms stay upper. */
  function tidyCase(s) {
    if (!s || s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
    return s.toLowerCase().replace(/[a-z0-9'&+]+/g, function (w) {
      if ((w.length <= 3 && !/[aeiouy]/.test(w)) || /^(ai|hq|io|it|hr|lms|crm|sso|api|pdf)$/.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
  }

  function hash(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
  }

  /** How a quote is compared with the text it claims to come from:
   *  Unicode-normalised, curly quotes and dashes made plain, invisible
   *  characters dropped, whitespace collapsed. Everything else - spelling,
   *  case, punctuation, the numbers - must match exactly. */
  function normForMatch(s) {
    s = String(s || '');
    if (s.normalize) s = s.normalize('NFKC');
    return s
      .replace(/[\u2018\u2019\u201a\u201b\u2032\u00b4`]/g, "'")
      .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  /** Whether a quote is in `text`, as an exact substring after
   *  normForMatch. Under 12 characters never counts: "personal data" is in
   *  every privacy policy and proves nothing. */
  function matcher(text) {
    // The quote reaching here was cleaned (markup and angle brackets out), so
    // the text it is looked for in is cleaned the same way first.
    var hay = normForMatch(scrub(text || ''));
    return function (quote) {
      var q = normForMatch(quote);
      if (q.length < 12) return false;
      return hay.indexOf(q) >= 0;
    };
  }

  /* ---------------- money ---------------- */

  /** A money string's digits: {neg, cents} or null. "$1,234.56", "12,50",
   *  "1.234,56", "(12.00)", "-12.00", "12.00-", "USD 12". Anything without
   *  a digit, or with letters left over, is no figure. */
  function readMoney(v) {
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      var a = Math.abs(v);
      if (a >= 1e10) return null;
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
    if (/^[-−–]/.test(s)) { neg = true; s = s.slice(1); }
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
    if (whole.length > 10) return null;
    var cents = Number(whole || '0') * 100;
    if (frac) {
      var f = (frac + '000').slice(0, 3);
      cents += Number(f.slice(0, 2)) + (Number(f.charAt(2)) >= 5 ? 1 : 0);
    }
    return { neg: neg, cents: cents };
  }
  /** A figure someone typed: non-negative cents, or null. */
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
  /** Cents as the page's number inputs show them: "1200" or "17.99". */
  function plain(cents) {
    var c = Math.max(0, Math.round(cents || 0));
    return c % 100 ? Math.floor(c / 100) + '.' + ('0' + (c % 100)).slice(-2) : String(c / 100);
  }
  function int(v, max) {
    if (typeof v === 'string' && /^\s*[\d,]+\s*$/.test(v)) v = Number(v.replace(/[,\s]/g, ''));
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return null;
    return Math.min(Math.floor(v), max || LIMITS.maxUsers);
  }

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
  /** A statement date: ISO, MM/DD/YYYY (day-first only when the file says
   *  so), DD.MM.YYYY, YYYYMMDD, "Sep 12, 2026", "12 Sep 2026". */
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
  /** RFC 4180-ish in one pass: quoted fields, doubled quotes, CRLF / LF /
   *  CR, blank lines dropped. Stops after `maxRows` rows. */
  function parseCsv(text, delim, maxRows) {
    var s = String(text || ''), n = s.length, rows = [], row = [], i = 0, D = delim || ',';
    var limit = maxRows || Infinity;
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
      if (keepRow(row)) { rows.push(row); if (rows.length > limit) return { rows: rows, over: true }; }
      row = [];
    }
    if (row.length && keepRow(row)) rows.push(row);
    return { rows: rows, over: rows.length > limit };
  }
  var norm = function (h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  /** Columns by header name: the first name in each list that is found
   *  wins, and one column is never used twice. */
  function columnsBy(header, spec, order) {
    var h = header.map(norm), out = {}, used = {};
    order.forEach(function (k) {
      var names = spec[k];
      for (var i = 0; i < names.length; i++) {
        var at = h.indexOf(names[i]);
        if (at >= 0 && !used[at]) { out[k] = at; used[at] = true; break; }
      }
    });
    return out;
  }

  /* ---------------- reading a card or expense statement ---------------- */

  var STATEMENT_HEADERS = {
    date: ['transactiondate', 'transdate', 'timestamp', 'trandate', 'date', 'purchasedate', 'expensedate', 'bookingdate', 'valuedate', 'posteddate', 'postdate', 'postingdate'],
    description: ['merchant', 'merchantname', 'vendor', 'vendorname', 'supplier', 'payee', 'description', 'name', 'transactiondescription', 'originaldescription', 'narrative', 'details', 'memo'],
    amount: ['amount', 'transactionamount', 'amountusd', 'billingamount', 'total', 'totalamount', 'amountgbp', 'amounteur', 'value'],
    debit: ['debit', 'debitamount', 'debits', 'withdrawal', 'withdrawals', 'charge', 'charges', 'moneyout', 'paidout', 'outflow'],
    credit: ['credit', 'creditamount', 'credits', 'deposit', 'deposits', 'payment', 'payments', 'moneyin', 'paidin', 'inflow'],
    type: ['type', 'transactiontype', 'details', 'transaction'],
    card: ['cardholder', 'cardmember', 'employee', 'spender', 'submittedby', 'user', 'cardholdername'],
  };
  var STATEMENT_ORDER = ['date', 'amount', 'debit', 'credit', 'description', 'type', 'card'];

  // What is not spending. Each is skipped and counted, never silently.
  var CARD_PAYMENT = /payment[\s-]*thank ?you|thank you for (your )?payment|(credit ?(card|crd)|\bcrd\b|card ?services|\bcc\b|e-?payment|amex|american express|discover|capital one|citi ?card|chase card|barclay|synchrony|brex|ramp|divvy).{0,30}\b(pmt|pymt|payment|autopay|auto pay)\b|\b(pmt|pymt|payment|autopay|auto pay)\b.{0,20}\b(credit ?(card|crd)|card)\b|^(internet|online|mobile|automatic|auto)? ?payment\b|^autopay\b/i;
  var TRANSFER = /\b(transfer|xfer|trnsfr|zelle|wire( transfer)?|to savings|from savings|to checking|from checking|atm|cash withdrawal|p2p)\b|^check\s*#?\s*\d+$/i;
  var INTEREST = /\b(interest|finance charge|late fee|annual fee)\b/i;
  var REFUND = /\b(refund|return|reversal|credit adj|adjustment|chargeback|statement credit|cash ?back|reward)\b/i;
  function isCardPayment(desc) { return (CARD_PAYMENT.test(desc) && !/\bpayment\b[^a-z]{0,24}\b(to|for)\b/i.test(desc)) || /payment[\s-]*thank ?you/i.test(desc); }
  var MONEY_IN_TYPE = /^(credit|payment|return|refund|deposit|adjustment|reversal|ach_credit|dslip)/i;

  /**
   * One statement's text -> {transactions, skipped, rows, range} or
   * {error}. Read entirely where it is called - in the browser, for the
   * page - and nothing but these numbers and the descriptors come out.
   */
  function parseStatement(text, opts) {
    var o = opts || {};
    if (typeof text !== 'string' || !text.trim()) return { error: 'That file is empty.' };
    if (text.length > LIMITS.bytes) return { error: 'That file is larger than a statement should be (5 MB). Download a shorter date range.' };
    var t = text.replace(/^\ufeff/, '');
    var rows = parseCsv(t, detectDelimiter(t), (o.maxRows || LIMITS.rows) + 40).rows;
    // Some banks put an account summary above the real header: the header is
    // the first row naming a date, a description and an amount column.
    var h = -1, cols = null;
    for (var i = 0; i < Math.min(rows.length, 40); i++) {
      var c = columnsBy(rows[i], STATEMENT_HEADERS, STATEMENT_ORDER);
      if (c.date != null && c.description != null && (c.amount != null || c.debit != null)) { h = i; cols = c; break; }
    }
    // Some banks export no header: date, amount, two spare columns, then the
    // description last. Recognised by shape.
    if (h < 0) {
      var first = rows.slice(0, 3);
      if (first.length && first.every(function (r) { return r.length >= 3 && parseDate(r[0]) && signedCents(r[1]) !== null; })) {
        cols = { date: 0, amount: 1, description: first[0].length - 1 };
      } else {
        return { error: 'This doesn’t look like a card or expense statement. Download the CSV version, with date, description and amount columns.' };
      }
    }
    var body = rows.slice(h + 1);
    var maxRows = o.maxRows || LIMITS.rows;
    if (body.length > maxRows) return { error: 'That’s more than ' + maxRows.toLocaleString('en-US') + ' rows. Download a shorter date range - 6 to 12 months is plenty.' };
    var dayFirst = false;
    for (var k = 0; k < body.length && k < 400; k++) {
      var dm = /^\s*(\d{1,2})[/-](\d{1,2})[/-]\d{2,4}/.exec(String(body[k][cols.date] || ''));
      if (dm && +dm[1] > 12) { dayFirst = true; break; }
    }
    var raw = [], skipped = { payments: 0, transfers: 0, refunds: 0, interest: 0, moneyIn: 0, unreadable: 0 };
    for (var r = 0; r < body.length; r++) {
      var row = body[r];
      var date = parseDate(row[cols.date], dayFirst);
      var desc = clean(String(row[cols.description] || ''), 200);
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
      raw.push({ date: date, desc: desc, val: val, type: type });
    }
    // The sign of a lone Amount column is not a convention anyone agrees on:
    // Chase and Bank of America write purchases negative, Amex positive.
    // Purchases are most of any statement, so the majority sign is spending.
    // Payments and refunds do not vote.
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
      if (spend > LIMITS.maxCents) { skipped.unreadable++; return; }
      out.push({ date: x.date, cents: spend, desc: x.desc });
    });
    out.sort(byDate);
    return { transactions: out, skipped: skipped, rows: body.length, range: rangeOf(out) };
  }
  function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.cents - b.cents; }
  function rangeOf(txs) { return txs.length ? { from: txs[0].date, to: txs[txs.length - 1].date } : null; }

  /** Several files at once (two cards, or one downloaded twice with
   *  overlapping dates): a row in two files counts once; two identical
   *  charges in ONE file both stay. */
  function parseStatements(files, opts) {
    var list = Array.isArray(files) ? files.slice(0, LIMITS.files) : [];
    if (!list.length) return { error: 'Add a CSV file.' };
    var total = list.reduce(function (n, f) { return n + String((f && f.text) || '').length; }, 0);
    if (total > LIMITS.bytes) return { error: 'Those files add up to more than 5 MB. Download a shorter date range - 6 to 12 months is plenty.' };
    var have = new Map(), txs = [], report = [], dupes = 0, rowsLeft = (opts && opts.maxRows) || LIMITS.rows;
    var skipped = { payments: 0, transfers: 0, refunds: 0, interest: 0, moneyIn: 0, unreadable: 0 };
    for (var f = 0; f < list.length; f++) {
      var file = list[f] || {};
      var name = clean(String(file.name || 'statement.csv'), 60);
      var p = parseStatement(String(file.text || ''), { maxRows: rowsLeft });
      if (p.error) { report.push({ name: name, error: p.error }); continue; }
      rowsLeft -= p.rows;
      Object.keys(skipped).forEach(function (k) { skipped[k] += p.skipped[k]; });
      var local = new Map();
      p.transactions.forEach(function (t) {
        var key = t.date + '|' + t.cents + '|' + vendorInfo(t.desc).key;
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
    return { transactions: txs, skipped: skipped, files: report, dupes: dupes, range: rangeOf(txs) };
  }

  /* ---------------- the curated software table ---------------- */

  // [id, name, category, the data it typically holds, descriptor pattern].
  // Data: c customer PII, e employee PII, f financial, h health, s student
  // records, i confidential/internal, n none. Specific before generic
  // (Dropbox Sign before Dropbox, Mailchimp before Intuit). Names only - no
  // links, no claims about any vendor: "typical data" is what a tool of that
  // kind usually ends up holding, for the person to correct.
  var KNOWN_RAW = [
    // Office suites
    ['gworkspace', 'Google Workspace', 'suite', 'ice', /GOOGLE\s*\*?\s*(GSUITE|G SUITE|WORKSPACE)|\bGSUITE\b|GOOGLE WORKSPACE/],
    ['gcloud', 'Google Cloud', 'dev', 'i', /GOOGLE\s*\*?\s*CLOUD|\bGCP\b/],
    ['gemini', 'Google Gemini', 'ai', 'i', /GOOGLE\s*\*?\s*GEMINI|\bGEMINI\b/],
    ['gone', 'Google One', 'files', 'i', /GOOGLE\s*\*?\s*(ONE|STORAGE)\b/],
    ['azure', 'Microsoft Azure', 'dev', 'i', /MICROSOFT\s*\*?\s*AZURE|\bAZURE\b/],
    ['m365', 'Microsoft 365', 'suite', 'ice', /MICROSOFT\s*(\*|365|OFFICE|#)|\bMSFT\s*\*|OFFICE ?365|MICROSOFT 365|MICROSOFT CORPORATION/],
    ['zoho', 'Zoho', 'suite', 'ic', /\bZOHO\b/],
    ['apple', 'Apple App Store & iCloud', 'files', 'i', /APPLE\.COM\/BILL|APPLE\.COM BILL|\bITUNES\b/],
    // CRM & sales
    ['salesforce', 'Salesforce', 'crm', 'c', /SALESFORCE|\bSFDC\b/],
    ['hubspot', 'HubSpot', 'crm', 'c', /HUBSPOT/],
    ['pipedrive', 'Pipedrive', 'crm', 'c', /PIPEDRIVE/],
    ['closecrm', 'Close', 'crm', 'c', /CLOSE\.COM|CLOSE\.IO/],
    ['copper', 'Copper', 'crm', 'c', /COPPER CRM|PROSPERWORKS/],
    ['insightly', 'Insightly', 'crm', 'c', /INSIGHTLY/],
    ['keap', 'Keap', 'crm', 'c', /\bKEAP\b|INFUSIONSOFT/],
    ['apollo', 'Apollo.io', 'crm', 'c', /APOLLO\.IO|APOLLO IO/],
    ['zoominfo', 'ZoomInfo', 'crm', 'c', /ZOOMINFO/],
    ['linkedin', 'LinkedIn Premium', 'crm', 'c', /LINKEDIN/],
    ['freshsales', 'Freshsales', 'crm', 'c', /FRESHSALES/],
    // HR & payroll
    ['gusto', 'Gusto', 'hr', 'ef', /\bGUSTO\b/],
    ['adp', 'ADP', 'hr', 'ef', /\bADP\b/],
    ['paychex', 'Paychex', 'hr', 'ef', /PAYCHEX/],
    ['rippling', 'Rippling', 'hr', 'ef', /RIPPLING/],
    ['bamboohr', 'BambooHR', 'hr', 'e', /BAMBOO ?HR/],
    ['justworks', 'Justworks', 'hr', 'ef', /JUSTWORKS/],
    ['deel', 'Deel', 'hr', 'ef', /\bDEEL\b/],
    ['paylocity', 'Paylocity', 'hr', 'ef', /PAYLOCITY/],
    ['paycom', 'Paycom', 'hr', 'ef', /\bPAYCOM\b/],
    ['workday', 'Workday', 'hr', 'ef', /WORKDAY/],
    ['trinet', 'TriNet Zenefits', 'hr', 'ef', /ZENEFITS|TRINET/],
    ['homebase', 'Homebase', 'hr', 'e', /HOMEBASE/],
    ['wheniwork', 'When I Work', 'hr', 'e', /WHEN ?I ?WORK/],
    ['deputy', 'Deputy', 'hr', 'e', /\bDEPUTY\b/],
    ['7shifts', '7shifts', 'hr', 'e', /7SHIFTS/],
    ['greenhouse', 'Greenhouse', 'hr', 'e', /GREENHOUSE\.IO|GREENHOUSE SOFTWARE/],
    ['lever', 'Lever', 'hr', 'e', /LEVER\.CO\b/],
    ['workable', 'Workable', 'hr', 'e', /WORKABLE/],
    ['lattice', 'Lattice', 'hr', 'e', /LATTICE/],
    ['cultureamp', 'Culture Amp', 'hr', 'e', /CULTURE ?AMP/],
    // Teaching & learning
    ['canvas', 'Canvas LMS', 'edu', 's', /INSTRUCTURE|CANVAS LMS/],
    ['powerschool', 'PowerSchool', 'edu', 's', /POWERSCHOOL/],
    ['schoology', 'Schoology', 'edu', 's', /SCHOOLOGY/],
    ['blackboard', 'Blackboard', 'edu', 's', /BLACKBOARD/],
    ['moodle', 'Moodle', 'edu', 's', /MOODLE/],
    ['seesaw', 'Seesaw', 'edu', 's', /SEESAW/],
    ['classdojo', 'ClassDojo', 'edu', 's', /CLASS ?DOJO/],
    ['kahoot', 'Kahoot!', 'edu', 's', /KAHOOT/],
    ['quizlet', 'Quizlet', 'edu', 's', /QUIZLET/],
    ['nearpod', 'Nearpod', 'edu', 's', /NEARPOD/],
    ['edpuzzle', 'Edpuzzle', 'edu', 's', /EDPUZZLE/],
    ['ixl', 'IXL', 'edu', 's', /\bIXL\b/],
    ['turnitin', 'Turnitin', 'edu', 's', /TURNITIN/],
    ['remind', 'Remind', 'edu', 's', /REMIND\.COM|REMIND101/],
    ['brainpop', 'BrainPOP', 'edu', 's', /BRAINPOP/],
    ['padlet', 'Padlet', 'edu', 's', /PADLET/],
    ['teachable', 'Teachable', 'edu', 'c', /TEACHABLE/],
    ['thinkific', 'Thinkific', 'edu', 'c', /THINKIFIC/],
    ['kajabi', 'Kajabi', 'edu', 'c', /KAJABI/],
    ['talentlms', 'TalentLMS', 'edu', 'e', /TALENTLMS/],
    ['docebo', 'Docebo', 'edu', 'e', /DOCEBO/],
    ['articulate', 'Articulate 360', 'edu', 'i', /ARTICULATE/],
    // E-signature (before the file tools that share a parent)
    ['dropboxsign', 'Dropbox Sign', 'esign', 'ci', /HELLOSIGN|DROPBOX SIGN/],
    ['adobesign', 'Adobe Acrobat Sign', 'esign', 'ci', /ADOBE ?SIGN|ECHOSIGN/],
    ['docusign', 'DocuSign', 'esign', 'ci', /DOCUSIGN/],
    ['pandadoc', 'PandaDoc', 'esign', 'ci', /PANDADOC/],
    ['signnow', 'signNow', 'esign', 'ci', /SIGNNOW/],
    ['signwell', 'SignWell', 'esign', 'ci', /SIGNWELL/],
    // File sharing & backup
    ['dropbox', 'Dropbox', 'files', 'i', /DROPBOX/],
    ['box', 'Box', 'files', 'i', /\bBOX\.COM|\bBOX,? INC|\bBOX (BUSINESS|ENTERPRISE)/],
    ['wetransfer', 'WeTransfer', 'files', 'i', /WETRANSFER/],
    ['egnyte', 'Egnyte', 'files', 'i', /EGNYTE/],
    ['sharefile', 'ShareFile', 'files', 'ci', /SHAREFILE/],
    ['backblaze', 'Backblaze', 'files', 'i', /BACKBLAZE/],
    ['carbonite', 'Carbonite', 'files', 'i', /CARBONITE/],
    ['docsend', 'DocSend', 'files', 'i', /DOCSEND/],
    // Design
    ['adobe', 'Adobe Creative Cloud', 'design', 'i', /ADOBE/],
    ['canva', 'Canva', 'design', 'i', /CANVA\b/],
    ['figma', 'Figma', 'design', 'i', /FIGMA/],
    ['miro', 'Miro', 'design', 'i', /\bMIRO\b|REALTIMEBOARD/],
    ['lucid', 'Lucid', 'design', 'i', /LUCID ?(CHART|SOFTWARE|SPARK)/],
    ['sketch', 'Sketch', 'design', 'i', /SKETCH\.COM|SKETCH B\.?V/],
    ['shutterstock', 'Shutterstock', 'design', 'n', /SHUTTERSTOCK/],
    ['getty', 'Getty Images / iStock', 'design', 'n', /GETTY ?IMAGES|ISTOCK/],
    ['envato', 'Envato', 'design', 'n', /ENVATO/],
    ['vimeo', 'Vimeo', 'video', 'i', /VIMEO/],
    // AI assistants
    ['openai', 'ChatGPT', 'ai', 'i', /OPENAI|CHATGPT/],
    ['anthropic', 'Claude', 'ai', 'i', /ANTHROPIC|CLAUDE\.AI/],
    ['perplexity', 'Perplexity', 'ai', 'i', /PERPLEXITY/],
    ['jasper', 'Jasper', 'ai', 'i', /JASPER\.AI|JASPER AI/],
    ['grammarly', 'Grammarly', 'ai', 'i', /GRAMMARLY/],
    ['otter', 'Otter.ai', 'ai', 'ic', /OTTER\.AI|OTTER AI/],
    ['fireflies', 'Fireflies.ai', 'ai', 'ic', /FIREFLIES/],
    ['fathom', 'Fathom', 'ai', 'ic', /FATHOM VIDEO|FATHOM\.VIDEO/],
    ['midjourney', 'Midjourney', 'ai', 'n', /MIDJOURNEY/],
    ['copyai', 'Copy.ai', 'ai', 'i', /COPY\.AI|\bCOPYAI\b/],
    ['descript', 'Descript', 'ai', 'i', /DESCRIPT\b/],
    ['elevenlabs', 'ElevenLabs', 'ai', 'n', /ELEVENLABS/],
    ['ghcopilot', 'GitHub Copilot', 'ai', 'i', /GITHUB.{0,4}COPILOT/],
    // Analytics
    ['mixpanel', 'Mixpanel', 'analytics', 'c', /MIXPANEL/],
    ['amplitude', 'Amplitude', 'analytics', 'c', /AMPLITUDE/],
    ['hotjar', 'Hotjar', 'analytics', 'c', /HOTJAR/],
    ['fullstory', 'FullStory', 'analytics', 'c', /FULLSTORY/],
    ['segment', 'Segment', 'analytics', 'c', /SEGMENT\.(IO|COM)|TWILIO SEGMENT/],
    ['semrush', 'Semrush', 'analytics', 'n', /SEMRUSH/],
    ['ahrefs', 'Ahrefs', 'analytics', 'n', /AHREFS/],
    ['tableau', 'Tableau', 'analytics', 'i', /TABLEAU/],
    ['databox', 'Databox', 'analytics', 'i', /DATABOX/],
    // Scheduling & booking
    ['calendly', 'Calendly', 'scheduling', 'c', /CALENDLY/],
    ['acuity', 'Acuity Scheduling', 'scheduling', 'c', /ACUITY|SQUARESPACE SCHED/],
    ['doodle', 'Doodle', 'scheduling', 'c', /DOODLE/],
    ['youcanbook', 'YouCanBookMe', 'scheduling', 'c', /YOUCANBOOK/],
    ['setmore', 'Setmore', 'scheduling', 'c', /SETMORE/],
    ['mindbody', 'Mindbody', 'scheduling', 'cf', /MINDBODY/],
    ['vagaro', 'Vagaro', 'scheduling', 'cf', /VAGARO/],
    ['signupgenius', 'SignUpGenius', 'scheduling', 'c', /SIGN ?UP ?GENIUS/],
    ['eventbrite', 'Eventbrite', 'scheduling', 'c', /EVENTBRITE/],
    // Health records
    ['simplepractice', 'SimplePractice', 'health', 'hc', /SIMPLE ?PRACTICE/],
    ['janeapp', 'Jane', 'health', 'hc', /JANE ?APP\b/],
    ['therapynotes', 'TherapyNotes', 'health', 'hc', /THERAPY ?NOTES/],
    ['drchrono', 'DrChrono', 'health', 'hc', /DRCHRONO/],
    ['tebra', 'Tebra', 'health', 'hc', /TEBRA|KAREO/],
    // Chat & phones
    ['slack', 'Slack', 'chat', 'i', /SLACK/],
    ['discord', 'Discord', 'chat', 'i', /DISCORD/],
    ['ringcentral', 'RingCentral', 'chat', 'c', /RINGCENTRAL/],
    ['dialpad', 'Dialpad', 'chat', 'c', /DIALPAD/],
    ['grasshopper', 'Grasshopper', 'chat', 'c', /GRASSHOPPER/],
    ['aircall', 'Aircall', 'chat', 'c', /AIRCALL/],
    ['openphone', 'OpenPhone', 'chat', 'c', /OPENPHONE/],
    ['nextiva', 'Nextiva', 'chat', 'c', /NEXTIVA/],
    ['twilio', 'Twilio', 'dev', 'c', /TWILIO/],
    // Video meetings
    ['zoom', 'Zoom', 'video', 'i', /ZOOM\.US|ZOOM VIDEO|ZOOM\.COM|ZOOM COMMUNICATIONS|^ZOOM\b|\bZOOM WORKPLACE/],
    ['webex', 'Webex', 'video', 'i', /WEBEX/],
    ['goto', 'GoTo Meeting', 'video', 'i', /GOTO ?MEETING|GOTO\.COM|LOGMEIN/],
    ['loom', 'Loom', 'video', 'i', /\bLOOM\b/],
    ['riverside', 'Riverside', 'video', 'n', /RIVERSIDE\.FM/],
    ['streamyard', 'StreamYard', 'video', 'n', /STREAMYARD/],
    // Projects & tasks
    ['asana', 'Asana', 'project', 'i', /ASANA/],
    ['trello', 'Trello', 'project', 'i', /TRELLO/],
    ['atlassian', 'Atlassian (Jira, Confluence)', 'project', 'i', /ATLASSIAN|\bJIRA\b|CONFLUENCE/],
    ['clickup', 'ClickUp', 'project', 'i', /CLICKUP/],
    ['monday', 'monday.com', 'project', 'i', /MONDAY\.COM|MONDAY COM/],
    ['basecamp', 'Basecamp', 'project', 'i', /BASECAMP/],
    ['smartsheet', 'Smartsheet', 'project', 'i', /SMARTSHEET/],
    ['wrike', 'Wrike', 'project', 'i', /WRIKE/],
    ['airtable', 'Airtable', 'project', 'ic', /AIRTABLE/],
    ['linear', 'Linear', 'project', 'i', /LINEAR\.APP/],
    ['todoist', 'Todoist', 'project', 'i', /TODOIST/],
    // Docs & notes
    ['notion', 'Notion', 'docs', 'i', /NOTION\b/],
    ['evernote', 'Evernote', 'docs', 'i', /EVERNOTE/],
    ['coda', 'Coda', 'docs', 'i', /CODA\.IO/],
    // Forms & surveys
    ['typeform', 'Typeform', 'forms', 'c', /TYPEFORM/],
    ['jotform', 'Jotform', 'forms', 'c', /JOTFORM/],
    ['surveymonkey', 'SurveyMonkey', 'forms', 'c', /SURVEY ?MONKEY|MOMENTIVE/],
    ['formstack', 'Formstack', 'forms', 'c', /FORMSTACK/],
    ['qualtrics', 'Qualtrics', 'forms', 'c', /QUALTRICS/],
    ['cognito', 'Cognito Forms', 'forms', 'c', /COGNITO ?FORMS/],
    ['tallyforms', 'Tally Forms', 'forms', 'c', /TALLY\.SO/],
    // Email & marketing
    ['mailchimp', 'Mailchimp', 'marketing', 'c', /MAILCHIMP/],
    ['constantcontact', 'Constant Contact', 'marketing', 'c', /CONSTANT ?CONTACT/],
    ['klaviyo', 'Klaviyo', 'marketing', 'c', /KLAVIYO/],
    ['activecampaign', 'ActiveCampaign', 'marketing', 'c', /ACTIVE ?CAMPAIGN/],
    ['sendgrid', 'SendGrid', 'marketing', 'c', /SENDGRID/],
    ['convertkit', 'Kit (ConvertKit)', 'marketing', 'c', /CONVERTKIT|\bKIT\.COM/],
    ['brevo', 'Brevo', 'marketing', 'c', /BREVO|SENDINBLUE/],
    ['campaignmonitor', 'Campaign Monitor', 'marketing', 'c', /CAMPAIGN ?MONITOR/],
    ['beehiiv', 'beehiiv', 'marketing', 'c', /BEEHIIV/],
    ['hootsuite', 'Hootsuite', 'marketing', 'n', /HOOTSUITE/],
    ['buffer', 'Buffer', 'marketing', 'n', /BUFFER\.COM|BUFFERAPP|BUFFER PUBLISH/],
    ['sproutsocial', 'Sprout Social', 'marketing', 'n', /SPROUT ?SOCIAL/],
    ['later', 'Later', 'marketing', 'n', /LATER\.COM/],
    ['birdeye', 'Birdeye', 'marketing', 'c', /BIRDEYE/],
    ['podium', 'Podium', 'marketing', 'c', /PODIUM/],
    ['yext', 'Yext', 'marketing', 'n', /\bYEXT\b/],
    // Accounting & payments
    ['quickbooks', 'QuickBooks', 'finance', 'f', /QUICKBOOKS|QBOOKS|\bQBO\b|INTUIT/],
    ['xero', 'Xero', 'finance', 'f', /\bXERO\b/],
    ['freshbooks', 'FreshBooks', 'finance', 'f', /FRESHBOOKS/],
    ['wave', 'Wave', 'finance', 'f', /WAVE ?(FINANCIAL|APPS|HQ)/],
    ['billcom', 'BILL', 'finance', 'f', /BILL\.COM/],
    ['netsuite', 'NetSuite', 'finance', 'f', /NETSUITE/],
    ['sage', 'Sage Intacct', 'finance', 'f', /SAGE ?(INTACCT|SOFTWARE|SBC)/],
    ['avalara', 'Avalara', 'finance', 'f', /AVALARA/],
    ['taxjar', 'TaxJar', 'finance', 'f', /TAXJAR/],
    ['expensify', 'Expensify', 'finance', 'fe', /EXPENSIFY/],
    ['carta', 'Carta', 'finance', 'fe', /\bCARTA\b/],
    ['shopify', 'Shopify', 'web', 'cf', /SHOPIFY/],
    // Help desk
    ['zendesk', 'Zendesk', 'support', 'c', /ZENDESK/],
    ['freshdesk', 'Freshdesk', 'support', 'c', /FRESHDESK|FRESHWORKS/],
    ['intercom', 'Intercom', 'support', 'c', /INTERCOM/],
    ['helpscout', 'Help Scout', 'support', 'c', /HELP ?SCOUT/],
    ['gorgias', 'Gorgias', 'support', 'c', /GORGIAS/],
    ['livechat', 'LiveChat', 'support', 'c', /LIVECHAT/],
    // Developer & automation
    ['github', 'GitHub', 'dev', 'i', /GITHUB/],
    ['gitlab', 'GitLab', 'dev', 'i', /GITLAB/],
    ['aws', 'Amazon Web Services', 'dev', 'ic', /AMAZON WEB SERVICES|\bAWS\b/],
    ['digitalocean', 'DigitalOcean', 'dev', 'i', /DIGITALOCEAN/],
    ['heroku', 'Heroku', 'dev', 'i', /HEROKU/],
    ['vercel', 'Vercel', 'dev', 'i', /VERCEL/],
    ['netlify', 'Netlify', 'dev', 'i', /NETLIFY/],
    ['cloudflare', 'Cloudflare', 'dev', 'i', /CLOUDFLARE/],
    ['jetbrains', 'JetBrains', 'dev', 'n', /JETBRAINS/],
    ['postman', 'Postman', 'dev', 'i', /POSTMAN/],
    ['sentry', 'Sentry', 'dev', 'i', /SENTRY\.IO|FUNCTIONAL SOFTWARE/],
    ['datadog', 'Datadog', 'dev', 'i', /DATADOG/],
    ['zapier', 'Zapier', 'dev', 'ic', /ZAPIER/],
    ['make', 'Make', 'dev', 'ic', /MAKE\.COM|INTEGROMAT/],
    // Passwords & security
    ['1password', '1Password', 'security', 'i', /1PASSWORD|AGILEBITS/],
    ['lastpass', 'LastPass', 'security', 'i', /LASTPASS/],
    ['dashlane', 'Dashlane', 'security', 'i', /DASHLANE/],
    ['bitwarden', 'Bitwarden', 'security', 'i', /BITWARDEN/],
    ['keeper', 'Keeper', 'security', 'i', /KEEPER SECURITY/],
    ['okta', 'Okta', 'security', 'e', /\bOKTA\b/],
    ['duo', 'Duo Security', 'security', 'e', /DUO SECURITY|CISCO DUO/],
    ['jumpcloud', 'JumpCloud', 'security', 'e', /JUMPCLOUD/],
    ['knowbe4', 'KnowBe4', 'security', 'e', /KNOWBE4/],
    ['crowdstrike', 'CrowdStrike', 'security', 'i', /CROWDSTRIKE/],
    ['malwarebytes', 'Malwarebytes', 'security', 'n', /MALWAREBYTES/],
    ['nordlayer', 'NordLayer / NordVPN', 'security', 'n', /NORD ?(LAYER|VPN)/],
    // Website & hosting
    ['squarespace', 'Squarespace', 'web', 'c', /SQUARESPACE/],
    ['wix', 'Wix', 'web', 'c', /\bWIX\b/],
    ['wordpress', 'WordPress.com', 'web', 'c', /WORDPRESS|AUTOMATTIC/],
    ['wpengine', 'WP Engine', 'web', 'c', /WP ?ENGINE/],
    ['webflow', 'Webflow', 'web', 'c', /WEBFLOW/],
    ['godaddy', 'GoDaddy', 'web', 'n', /GO ?DADDY/],
    ['namecheap', 'Namecheap', 'web', 'n', /NAMECHEAP/],
    ['bluehost', 'Bluehost', 'web', 'n', /BLUEHOST/],
  ];
  var DATA_CODE = { c: 'customer', e: 'employee', f: 'financial', h: 'health', s: 'student', i: 'confidential', n: 'none' };
  var KNOWN = KNOWN_RAW.map(function (r) {
    return { id: r[0], name: r[1], cat: r[2], data: r[3].split('').map(function (k) { return DATA_CODE[k]; }), re: r[4] };
  });
  var KNOWN_BY_ID = {};
  KNOWN.forEach(function (k) { KNOWN_BY_ID[k.id] = k; });
  function matchKnown(text) {
    var up = String(text || '').toUpperCase();
    for (var i = 0; i < KNOWN.length; i++) if (KNOWN[i].re.test(up)) return KNOWN[i];
    return null;
  }

  // Unknown merchants. A strong hint says software on one charge; a weak one
  // needs a regular bill behind it. What is plainly not software is never
  // called software, whatever its name.
  var STRONG_SOFT = /\.(io|ai|app|so|dev|tech|cloud)\b|\b(software|saas|subscr|subscription|licen[cs]e|seats?|per seat|cloud|labs?|hq)\b/i;
  var WEAK_SOFT = /\b(app|apps|tech|systems|platform|pro|plus|premium|ai|cloud|data|analytics|crm|portal|hub|suite|monthly|annual)\b|\.com\b/i;
  var NOT_SOFTWARE = /\b(restaurant|cafe|coffee|starbucks|doordash|grubhub|uber ?eats|kitchen|thai|sushi|burger|taco|bistro|grill|pizza|bakery|deli|diner|bar|pub|hotel|inn|motel|airbnb|airline|airlines|airways|delta air|united air|southwest|jetblue|uber|lyft|taxi|parking|fuel|gas|shell|chevron|exxon|mobil|marathon|sunoco|costco|walmart|target|staples|office ?depot|officemax|home depot|lowe'?s|amazon|amzn|ups|fedex|usps|postal|hardware|grocery|market|kroger|safeway|publix|whole foods|trader joe|pharmacy|cvs|walgreens|insurance|utility|utilities|electric|water|power|energy|rent|lease|toll|ebay|etsy|florist|catering|uniform|janitorial|landscaping|plumbing|comcast|xfinity|verizon|at&t|t-mobile|spectrum|cox comm|best buy|b&h|cdw|dell|lenovo|hp store|bookstore|books|library supply|demco|gaylord)\b/i;
  var STOP = { inc: 1, llc: 1, ltd: 1, co: 1, corp: 1, the: 1, com: 1, io: 1, usa: 1, us: 1, company: 1, online: 1, www: 1, and: 1, app: 1, apps: 1, ai: 1, hq: 1, software: 1, subscr: 1, subscription: 1, monthly: 1, annual: 1, bill: 1, billing: 1, payment: 1, plan: 1, seats: 1, seat: 1, license: 1, licence: 1, trial: 1 };
  var CITIES = ['NEW YORK', 'LOS ANGELES', 'SAN FRANCISCO', 'SAN JOSE', 'SAN DIEGO', 'SAN MATEO', 'SANTA MONICA', 'MOUNTAIN VIEW', 'CUPERTINO', 'PALO ALTO', 'MENLO PARK', 'SUNNYVALE', 'SEATTLE', 'REDMOND', 'BELLEVUE', 'CHICAGO', 'BOSTON', 'AUSTIN', 'DALLAS', 'HOUSTON', 'ATLANTA', 'MIAMI', 'DENVER', 'BOULDER', 'PHOENIX', 'SCOTTSDALE', 'PORTLAND', 'BROOKLYN', 'OAKLAND', 'BERKELEY', 'IRVINE', 'NASHVILLE', 'CHARLOTTE', 'RALEIGH', 'PHILADELPHIA', 'PITTSBURGH', 'WASHINGTON', 'ARLINGTON', 'SALT LAKE CITY', 'LEHI', 'MINNEAPOLIS', 'TORONTO', 'VANCOUVER', 'MONTREAL', 'LONDON', 'DUBLIN', 'SYDNEY', 'AMSTERDAM', 'BERLIN', 'PARIS', 'TALLINN'];
  // Words that say how a vendor bills, not who it is.
  var TRAIL = /\s+(software|svcs|services|service|hq|app|apps|subscription|subscr|portal|tech|cloud|online|inc|llc|ltd|corp|co|booking|charge|saas|platform)$/i;
  var STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC ON BC QC AB'.split(' ');

  /** The vendor inside a card descriptor, without the noise. */
  function stripDescriptor(desc) {
    var s = String(desc || '');
    var parts = s.split(/\s{2,}|\t/).filter(function (p) { return p.trim(); });
    if (parts.length > 1 && /[A-Za-z]{2}/.test(parts[0])) s = parts[0];
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/\b(?:PURCHASE|RECURRING PAYMENT|RECURRING)?\s*AUTHORI[ZS]ED ON\s+\d{1,2}\/\d{1,2}\s*/i, '');
    s = s.replace(/^(?:(?:POS|DEBIT|VISA|MC|ACH|CHECKCARD|CHECK CARD|PURCHASE|RECURRING|PREAUTHORIZED|DBT|CARD|WEB|PPD)\b(?:\s+\d{4}\b)?[\s:#-]*)+/i, '');
    s = s.replace(/^(?:SQ|SQUARE|TST|SP|PP|PAYPAL|PY|IN|FS|BT|CKO|PADDLE|PADDLE\.NET|STRIPE|LS|2CO|FSP|GOOGLE|GOOG)\s*\*\s*/i, '');
    var star = s.indexOf('*');
    if (star >= 0) {
      var before = s.slice(0, star).trim(), after = s.slice(star + 1).trim();
      s = /[A-Za-z].*[A-Za-z]/.test(before) && before.length >= 3 ? before : after;
    }
    s = s.replace(/\b(?:WWW|HELP|PAY|BILLING)\./gi, '')
      .replace(/\.(?:COM|NET|ORG|IO|CO|TV|APP|US|AI|ME|FM|SO|DEV)\b(?:\/\S*)?/gi, '')
      .replace(/\+?\b1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, ' ')
      .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
      .replace(/#\s*\d+/g, ' ')
      .replace(/\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z\d]{6,}\b/g, ' ')
      .replace(/\b\d{3,}\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
    for (var pass = 0; pass < 3; pass++) {
      var m = /\s+([A-Za-z]{2,3})$/.exec(s);
      if (m && (STATES.indexOf(m[1].toUpperCase()) >= 0 || /^(USA|US|GBR|CAN|IRL)$/i.test(m[1])) && s.length - m[0].length >= 3) s = s.slice(0, m.index).trim();
      else break;
    }
    var upc = s.toUpperCase();
    for (var ci = 0; ci < CITIES.length; ci++) {
      var city = CITIES[ci];
      if (upc.length > city.length + 2 && upc.slice(-city.length - 1) === ' ' + city) { s = s.slice(0, s.length - city.length - 1).trim(); break; }
    }
    s = s.replace(/^[\s\-*,.&/:]+|[\s\-*,.&/:]+$/g, '').trim();
    for (var tr = 0; tr < 3 && TRAIL.test(s) && s.replace(TRAIL, '').trim().length >= 4; tr++) s = s.replace(TRAIL, '').trim();
    var t = s.replace(/\s+(?:bill|billing|payment|pmt|autopay|recurring|purchase|subscr|subscription|monthly|annual|trial|free trial)$/i, '');
    return t.length >= 3 ? t : s;
  }

  // First words too common to name a vendor on their own.
  var GENERIC = { cloud: 1, tech: 1, digital: 1, smart: 1, data: 1, web: 1, my: 1, go: 1, get: 1, team: 1, work: 1, net: 1, pro: 1, easy: 1, simple: 1, open: 1, global: 1, united: 1, american: 1, national: 1, first: 1, city: 1, county: 1, library: 1, school: 1, google: 1, microsoft: 1, apple: 1, amazon: 1, adobe: 1, meta: 1, social: 1, online: 1, mobile: 1, the: 1, best: 1, super: 1, one: 1 };
  /** The key a tool is merged on, from any of its names: a curated id when
   *  it is in the table, else its first meaningful word ("Inkswift Sign"
   *  and "InkSwift" meet), or the first two run together when the first is
   *  short or generic ("Ink Swift", "Cloud Copy"). */
  function toolKey(name) {
    var known = matchKnown(name);
    if (known) return 'k:' + known.id;
    var words = String(name || '').toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').split(' ').filter(function (w) { return w && !STOP[w]; });
    if (!words.length) return 'm' + hash(String(name || '').toLowerCase()).slice(0, 10);
    var key = words[0].length >= 4 && !GENERIC[words[0]] ? words[0] : words.slice(0, 2).join('');
    return key.slice(0, 60);
  }

  var infoCache = new Map();
  /** {key, name, cat, data, known, strong, weak, notSoftware, trialWord}
   *  for a card descriptor. */
  function vendorInfo(desc) {
    var d = clean(desc, 200);
    if (infoCache.has(d)) return infoCache.get(d);
    var known = matchKnown(d);
    var stripped = stripDescriptor(d);
    var name = known ? known.name : tidyCase(stripped.split(' ').slice(0, 4).join(' ')).slice(0, LIMITS.name).trim();
    if (!name) name = tidyCase(d.slice(0, LIMITS.name));
    var info = {
      key: known ? 'k:' + known.id : toolKey(stripped || d),
      name: name,
      cat: known ? known.cat : guessCat(d),
      data: known ? known.data.slice() : [],
      known: known ? known.id : null,
      strong: STRONG_SOFT.test(d),
      weak: WEAK_SOFT.test(d),
      notSoftware: !known && NOT_SOFTWARE.test(d),
      trialWord: /\btrial\b/i.test(d),
    };
    if (infoCache.size > 50000) infoCache.clear();
    infoCache.set(d, info);
    return info;
  }
  var KEYWORD_CATS = [
    [/\b(crm|sales|leads?)\b/i, 'crm'], [/payroll|\bhr\b|hiring|recruit|shifts?\b/i, 'hr'],
    [/homework|tutor|class|school|learn|lms|course|quiz|student|lesson/i, 'edu'],
    [/sign\b|esign|signature/i, 'esign'], [/\bfiles?\b|share|transfer|backup|storage|drive|vault/i, 'files'],
    [/design|photo|graphic|font|stock/i, 'design'], [/\bai\b|\.ai\b|gpt|assistant|copilot|note.?tak|transcri|notewise/i, 'ai'],
    [/analytic|metrics|insight|tracking/i, 'analytics'], [/schedul|booking|book\b|calendar|appoint/i, 'scheduling'],
    [/chat|messag|phone|voip|\bsms\b|text/i, 'chat'], [/video|meet|webinar|stream/i, 'video'],
    [/project|task|board|kanban/i, 'project'], [/\bnotes?\b|docs?\b|wiki/i, 'docs'], [/forms?\b|survey|poll/i, 'forms'],
    [/mail|newsletter|campaign|social|marketing/i, 'marketing'], [/invoice|account|ledger|tax|expense|billing/i, 'finance'],
    [/support|helpdesk|ticket/i, 'support'], [/host|domain|website|\bsite\b|\bweb\b/i, 'web'], [/password|vpn|security|secure/i, 'security'],
    [/\bdev|code|api|deploy|automat/i, 'dev'],
  ];
  function guessCat(text) {
    for (var i = 0; i < KEYWORD_CATS.length; i++) if (KEYWORD_CATS[i][0].test(text)) return KEYWORD_CATS[i][1];
    return 'other';
  }

  /* ---------------- finding the software on a card ---------------- */

  var BANDS = { weekly: [6, 8], monthly: [24, 37], quarterly: [84, 98], annual: [350, 380] };
  /** Which cadence the gaps fit, or null. One skipped cycle is forgiven. */
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
  /** Charges a few days apart, as one billing cycle (a seat added mid-month
   *  posts a second charge). */
  function cycles(charges) {
    var out = [];
    charges.forEach(function (c) {
      var last = out[out.length - 1];
      if (last && daysBetween(last.date, c.date) <= 5) { last.cents += c.cents; last.n++; }
      else out.push({ date: c.date, cents: c.cents, n: 1 });
    });
    return out;
  }
  var TRIAL_DAYS = 14; // when a trial's length is unknown: most SaaS trials run 14 days

  /**
   * Transactions -> the software in them: {tools, considered, notSoftware,
   * range}. Each tool carries only what an inventory needs - a name, a
   * category, the data it typically holds, spend a year, cadence, the next
   * renewal, a trial - never a transaction.
   *
   * - A curated vendor: any charge. Two or more on a cadence are a
   *   subscription; one big one with 40+ days of statement after it is
   *   probably yearly; otherwise a one-off.
   * - Anything else is software only with a strong hint in its descriptor,
   *   or a weak hint and a regular bill (2+ near-fixed charges on a
   *   cadence). Those are marked `probable`: "probably software - check".
   * - Trials: a charge of $1 or less followed 3-45 days later by the full
   *   price (converted), or still alone and recent (converts about 14 days
   *   after it), or "trial" in the descriptor.
   */
  function findSoftware(transactions, opts) {
    var o = opts || {};
    var txs = (Array.isArray(transactions) ? transactions : []).filter(function (t) { return t && isoDay(t.date) && Number.isInteger(t.cents) && t.cents >= 0 && t.desc; });
    txs.sort(byDate);
    var asOf = txs.length ? txs[txs.length - 1].date : o.today;
    var today = isoDay(o.today) ? o.today : asOf;
    var from = txs.length ? txs[0].date : today;
    var groups = new Map();
    txs.forEach(function (t) {
      var info = vendorInfo(t.desc);
      var g = groups.get(info.key);
      if (!g) { g = { info: info, charges: [], trialWord: false }; groups.set(info.key, g); }
      g.charges.push(t);
      if (info.trialWord) g.trialWord = true;
      if (info.strong) g.info = Object.assign({}, g.info, { strong: true });
      if (info.weak) g.info = Object.assign({}, g.info, { weak: true });
    });
    var tools = [], notSoftware = 0;
    groups.forEach(function (g) {
      var info = g.info;
      if (info.notSoftware) { notSoftware += g.charges.length; return; }
      var small = g.charges.filter(function (c) { return c.cents <= 100; });
      var paid = g.charges.filter(function (c) { return c.cents > 100; });
      var cy = cycles(paid);
      var cadence = cy.length >= 2 ? cadenceOf(cy.map(function (c) { return c.date; })) : null;
      var amounts = cy.map(function (c) { return c.cents; });
      var maxA = Math.max.apply(null, amounts.concat([0])), minA = Math.min.apply(null, amounts.length ? amounts : [0]);
      var steady = amounts.length >= 2 && minA * 1.5 >= maxA;
      var known = Boolean(info.known);
      var software = known || info.strong || g.trialWord || (info.weak && cadence && steady && cadence !== 'weekly');
      if (!software) { notSoftware += g.charges.length; return; }
      // The trial.
      var trial = null;
      var firstSmall = small.length ? small[0] : (g.trialWord ? g.charges[0] : null);
      if (firstSmall) {
        var after = paid.filter(function (c) { return c.date > firstSmall.date; })[0];
        var gap = after ? daysBetween(firstSmall.date, after.date) : null;
        if (after && gap >= 3 && gap <= 45 && after.cents >= 3 * Math.max(firstSmall.cents, 1)) {
          trial = { start: firstSmall.date, converts: after.date, cents: firstSmall.cents, converted: true, estimated: false };
        } else if (!after && daysBetween(firstSmall.date, today) <= 45) {
          trial = { start: firstSmall.date, converts: addDays(firstSmall.date, TRIAL_DAYS), cents: firstSmall.cents, converted: false, estimated: true };
        }
      }
      if (!paid.length && !trial) { notSoftware += g.charges.length; return; }
      // Spend a year, and when it renews.
      var spend = 0, renewal = null, kind = 'once';
      var last = cy.length ? cy[cy.length - 1] : null;
      if (cadence) {
        kind = cadence;
        spend = last.cents * PER_YEAR[cadence];
        if (cadence === 'annual' || cadence === 'quarterly') {
          renewal = step(last.date, cadence, 1);
          var k = 1;
          while (renewal < today && k < 40) { k++; renewal = step(last.date, cadence, k); }
        }
      } else if (cy.length >= 2) {
        kind = 'irregular';
        var yearAgo = addDays(asOf, -365);
        var span = Math.max(30, Math.min(365, daysBetween(from, asOf)));
        var sum = cy.filter(function (c) { return c.date > yearAgo; }).reduce(function (s, c) { return s + c.cents; }, 0);
        spend = Math.round(sum * 365 / span);
      } else if (cy.length === 1) {
        if (daysBetween(last.date, asOf) >= 40 && last.cents >= 10000) {
          kind = 'annual';
          spend = last.cents;
          renewal = step(last.date, 'annual', 1);
        } else {
          kind = 'once';
          spend = last.cents;
        }
      }
      if (trial && trial.converted === false && !paid.length) kind = 'trial';
      tools.push({
        key: info.key,
        name: info.name,
        cat: info.cat,
        data: info.data.slice(),
        known: info.known,
        probable: !known,
        spendCents: Math.min(spend, LIMITS.maxCents),
        cadence: oneOf(kind, CADENCES, null),
        billing: kind,
        renewal: renewal,
        trial: trial,
        charges: paid.length,
        lastCharge: last ? last.date : (trial ? trial.start : null),
        sources: ['card'],
      });
    });
    tools.sort(function (a, b) { return b.spendCents - a.spendCents || (a.name < b.name ? -1 : 1); });
    return { tools: tools, considered: txs.length, notSoftware: notSoftware, range: rangeOf(txs) };
  }

  /* ---------------- sign-in and app-access exports ---------------- */

  // Plain words for what a grant lets an app do, and how broad it is (0-1).
  // `data` is what such access usually reaches.
  var RISKS = {
    admin: { label: 'act as an administrator', w: 1, data: ['confidential', 'employee'] },
    mail_full: { label: 'read, send and delete all mail', w: 1, data: ['confidential', 'customer'] },
    mail_rw: { label: 'read and change all mail', w: 0.95, data: ['confidential', 'customer'] },
    mail_read: { label: 'read all mail', w: 0.9, data: ['confidential', 'customer'] },
    files_rw: { label: 'read and write all files', w: 0.9, data: ['confidential'] },
    directory_rw: { label: 'change the staff directory', w: 0.95, data: ['employee'] },
    sites_rw: { label: 'read and write all shared sites', w: 0.85, data: ['confidential'] },
    docs_rw: { label: 'read and write all documents and sheets', w: 0.85, data: ['confidential'] },
    classroom: { label: 'read classes, rosters and coursework', w: 0.85, data: ['student'] },
    chat_read: { label: 'read chat messages', w: 0.8, data: ['confidential'] },
    files_read: { label: 'read all files', w: 0.75, data: ['confidential'] },
    sites_read: { label: 'read all shared sites', w: 0.7, data: ['confidential'] },
    mail_send: { label: 'send mail as the person', w: 0.6, data: [] },
    files_user: { label: 'read and write each person’s own files', w: 0.55, data: ['confidential'] },
    cal_rw: { label: 'read and change calendars', w: 0.5, data: [] },
    directory_read: { label: 'read the staff directory', w: 0.5, data: ['employee'] },
    contacts: { label: 'read contacts', w: 0.45, data: ['customer'] },
    mail_meta: { label: 'see who emailed whom', w: 0.4, data: [] },
    cal_read: { label: 'read calendars', w: 0.35, data: [] },
    files_meta: { label: 'see file names', w: 0.3, data: [] },
    other: { label: 'other access', w: 0.3, data: [] },
    offline: { label: 'keep access when nobody is signed in', w: 0.25, data: [] },
    files_own: { label: 'only files it made or was given', w: 0.2, data: [] },
    signin: { label: 'sign-in and profile only', w: 0.05, data: [] },
  };
  var RISK_IDS = Object.keys(RISKS);

  /** One scope string (a Google OAuth scope URL, a Microsoft Graph
   *  permission, or a service name from an export) -> a risk id. */
  function scopeRisk(scope) {
    var s = String(scope || '').trim().toLowerCase();
    if (!s) return null;
    var g = s.replace(/^https?:\/\/www\.googleapis\.com\/auth\//, '');
    // Google
    if (s === 'https://mail.google.com/' || s === 'https://mail.google.com' || s === 'mail.google.com') return 'mail_full';
    if (/^gmail\.(readonly)$/.test(g)) return 'mail_read';
    if (/^gmail\.modify$/.test(g)) return 'mail_rw';
    if (/^gmail\.(send|compose|insert)$/.test(g)) return 'mail_send';
    if (/^gmail\.(metadata|labels)$/.test(g)) return 'mail_meta';
    if (/^gmail\b/.test(g)) return 'mail_read';
    if (g === 'drive') return 'files_rw';
    if (/^drive\.(readonly|photos\.readonly)$/.test(g)) return 'files_read';
    if (/^drive\.(file|appdata|install)$/.test(g)) return 'files_own';
    if (/^drive\.metadata/.test(g)) return 'files_meta';
    if (/^(spreadsheets|documents|presentations)$/.test(g)) return 'docs_rw';
    if (/^(spreadsheets|documents|presentations)\.readonly$/.test(g)) return 'files_read';
    if (/^calendar(\.events)?$/.test(g)) return 'cal_rw';
    if (/^calendar\./.test(g)) return 'cal_read';
    if (/^(contacts|contacts\.readonly|contacts\.other\.readonly|directory\.readonly)$/.test(g)) return g === 'directory.readonly' ? 'directory_read' : 'contacts';
    if (/^admin\.directory\.[a-z.]*readonly$/.test(g)) return 'directory_read';
    if (/^admin\.directory/.test(g)) return 'directory_rw';
    if (/^admin\./.test(g)) return 'admin';
    if (/^classroom\./.test(g)) return 'classroom';
    if (/^cloud-platform$/.test(g)) return 'admin';
    if (/^userinfo\.(email|profile)$/.test(g) || /^(openid|email|profile)$/.test(s)) return 'signin';
    // Microsoft Graph and friends
    if (/^mail\.readwrite(\.shared)?$/.test(s)) return 'mail_rw';
    if (/^mail\.read(\.shared)?$/.test(s)) return 'mail_read';
    if (/^mail\.send(\.shared)?$/.test(s)) return 'mail_send';
    if (/^mail\.readbasic/.test(s)) return 'mail_meta';
    if (/^(full_access_as_app|exchange\.manageasapp)$/.test(s)) return 'mail_full';
    if (/^files\.readwrite\.all$/.test(s)) return 'files_rw';
    if (/^files\.read\.all$/.test(s)) return 'files_read';
    if (/^files\.(read|readwrite)$/.test(s)) return 'files_user';
    if (/^files\.readwrite\.(appfolder|selected)$|^files\.selectedoperations/.test(s)) return 'files_own';
    if (/^sites\.(readwrite|manage|fullcontrol)\.all$/.test(s)) return 'sites_rw';
    if (/^sites\.read\.all$/.test(s)) return 'sites_read';
    if (/^calendars\.readwrite/.test(s)) return 'cal_rw';
    if (/^calendars\.read/.test(s)) return 'cal_read';
    if (/^contacts\.read/.test(s)) return 'contacts';
    if (/^(directory|user|group)\.readwrite\.all$|^rolemanagement|^application\.readwrite\.all$/.test(s)) return /^rolemanagement|^application/.test(s) ? 'admin' : 'directory_rw';
    if (/^(directory|user|group|people)\.read(basic)?\.all$/.test(s)) return 'directory_read';
    if (/^(chat|channelmessage|chatmessage)\.read/.test(s)) return 'chat_read';
    if (/^edu(roster|assignments|administration)/.test(s)) return 'classroom';
    if (/^notes\.read/.test(s)) return 'files_user';
    if (s === 'offline_access') return 'offline';
    if (/^(user\.read|user\.readbasic)$/.test(s)) return 'signin';
    // Service names, as some exports list them
    if (/^(gmail|mail|email access|outlook mail)$/.test(s)) return 'mail_read';
    if (/^(google )?drive$|^onedrive$/.test(s)) return 'files_rw';
    if (/^(google )?(calendar|calendars)$/.test(s)) return 'cal_rw';
    if (/^(google )?contacts$/.test(s)) return 'contacts';
    if (/^(google )?classroom$/.test(s)) return 'classroom';
    if (/^(google )?(docs|sheets|slides)$/.test(s)) return 'docs_rw';
    if (/^(sign in|sign-in|google sign-in|basic profile|profile info|openid connect)$/.test(s)) return 'signin';
    if (/^(admin|administrator|directory|admin sdk)$/.test(s)) return 'admin';
    return 'other';
  }
  /** A cell of scopes -> the risk ids it holds, broadest first, each once. */
  function risksOf(cell) {
    var parts = String(cell || '').split(/[\s,;|]+/).filter(Boolean);
    // Service names can carry spaces ("Google Drive"): try the whole cell's
    // comma/semicolon pieces when they are words, not URLs or dotted names.
    var pieces = String(cell || '').split(/[,;|\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    var wordy = pieces.length && pieces.every(function (p) { return /^[A-Za-z][A-Za-z -]*$/.test(p) && !/\./.test(p); });
    var src = wordy ? pieces : parts;
    var seen = {}, out = [];
    src.forEach(function (p) { var r = scopeRisk(p); if (r && !seen[r]) { seen[r] = 1; out.push(r); } });
    return sortRisks(out);
  }
  function sortRisks(ids) {
    return ids.filter(function (r) { return RISKS[r]; }).sort(function (a, b) { return RISKS[b].w - RISKS[a].w || (a < b ? -1 : 1); });
  }
  /** How broad a tool's access is, 0-1: its broadest grant, plus a little
   *  for each further broad one. Never lowered by another grant. */
  function breadthOf(risks) {
    var ws = (risks || []).filter(function (r) { return RISKS[r]; }).map(function (r) { return RISKS[r].w; }).sort(function (a, b) { return b - a; });
    if (!ws.length) return 0;
    var extra = ws.slice(1).filter(function (w) { return w >= 0.5; }).length;
    return Math.min(1, ws[0] + 0.05 * extra);
  }
  function riskWords(risks) {
    return sortRisks(risks || []).filter(function (r) { return r !== 'signin' && r !== 'other'; }).map(function (r) { return RISKS[r].label; });
  }

  var ACCESS_HEADERS = {
    name: ['appname', 'applicationname', 'application', 'app', 'appdisplayname', 'displayname', 'clientname', 'oauthclientname', 'name', 'resourcedisplayname', 'serviceprincipalname', 'product', 'productname'],
    users: ['users', 'usercount', 'numberofusers', 'userswithaccess', 'authorizedusers', 'totalusers', 'assignedusers', 'consentedusers', 'usersconsented', 'userandgroupcount', 'userandgroupassignments', 'installs'],
    user: ['user', 'useremail', 'email', 'actor', 'actoremail', 'userprincipalname', 'username', 'upn', 'principal', 'principalname', 'usersignin'],
    scopes: ['scopes', 'scope', 'oauthscope', 'oauthscopes', 'requestedscopes', 'grantedscopes', 'scopesgranted', 'requestedservices', 'servicesaccessed', 'accesstogoogledata', 'permissions', 'apipermissions', 'delegatedpermissions', 'applicationpermissions', 'grantedpermissions', 'claimvalue'],
    id: ['clientid', 'appid', 'applicationid', 'objectid', 'id'],
    publisher: ['publisher', 'publishername', 'verifiedpublisher', 'developer'],
  };
  var ACCESS_ORDER = ['users', 'user', 'scopes', 'id', 'publisher', 'name'];
  // Google's and Microsoft's own apps: part of the suite, not shadow IT.
  var BUILTIN = /^(google (chrome|drive for desktop|drive|docs|sheets|slides|calendar|meet|chat|classroom|play|workspace|apps script|cloud sdk|photos|keep|sites|forms|android)|android( device)?|ios account manager|macos|gmail|chrome os|chromebook|microsoft (graph|graph explorer|office|teams|outlook|azure|edge|authenticator|365|exchange|sharepoint|onedrive|intune|substrate|forms|planner|to do|stream|power bi|powerapps|power automate|whiteboard|bookings|loop|copilot|defender)|office 365|office|outlook( mobile)?|onedrive|sharepoint( online)?|exchange online|windows( sign in| 10| 11)?|my apps|my profile|azure portal|azure active directory|graph explorer|teams)\b/i;

  /**
   * A Google Workspace "Apps with access" / OAuth token export, a Microsoft
   * Entra "Enterprise applications" or sign-in export, or anything shaped
   * like them -> {kind, apps, rows, builtin} or {error}. Rows of one app per
   * user (a token or sign-in log) are counted into distinct users.
   */
  function parseAccess(text) {
    if (typeof text !== 'string' || !text.trim()) return { error: 'That file is empty.' };
    if (text.length > LIMITS.bytes) return { error: 'That file is larger than an export should be (5 MB).' };
    var t = text.replace(/^\ufeff/, '');
    var rows = parseCsv(t, detectDelimiter(t), LIMITS.rows + 40).rows;
    var h = -1, cols = null;
    for (var i = 0; i < Math.min(rows.length, 20); i++) {
      var c = columnsBy(rows[i], ACCESS_HEADERS, ACCESS_ORDER);
      if (c.name != null && (c.users != null || c.user != null || c.scopes != null || c.id != null)) { h = i; cols = c; break; }
    }
    if (h < 0) return { error: 'This doesn’t look like an app-access export. It needs an app name column and users, scopes or permissions.' };
    var body = rows.slice(h + 1);
    if (body.length > LIMITS.rows) return { error: 'That’s more than ' + LIMITS.rows.toLocaleString('en-US') + ' rows. Export one app list rather than a full log.' };
    var header = rows[h].map(norm).join(' ');
    var apps = new Map(), builtin = 0, builtinSeen = {}, unreadable = 0, google = 0, ms = 0;
    body.forEach(function (row) {
      var name = clean(String(row[cols.name] || ''), LIMITS.name);
      if (!name) { unreadable++; return; }
      var scopeCell = cols.scopes != null ? String(row[cols.scopes] || '') : '';
      if (/googleapis|mail\.google/.test(scopeCell)) google++;
      if (/\b(Mail|Files|User|Sites|Directory|Calendars)\.[A-Z]/.test(scopeCell)) ms++;
      if (BUILTIN.test(name)) { if (!builtinSeen[name]) { builtinSeen[name] = 1; builtin++; } return; }
      var key = toolKey(name);
      var a = apps.get(key);
      if (!a) { a = { key: key, name: name, users: null, people: new Set(), risks: [], rows: 0 }; apps.set(key, a); }
      a.rows++;
      if (cols.users != null) {
        var n = int(String(row[cols.users] || '').trim());
        if (n !== null) a.users = Math.max(a.users || 0, n);
      }
      if (cols.user != null) {
        var who = String(row[cols.user] || '').trim().toLowerCase();
        if (who && a.people.size < LIMITS.maxUsers) a.people.add(who);
      }
      if (scopeCell) {
        risksOf(scopeCell).forEach(function (r) { if (a.risks.indexOf(r) < 0) a.risks.push(r); });
      }
    });
    var out = [];
    apps.forEach(function (a) {
      var known = matchKnown(a.name);
      var users = a.users !== null ? a.users : (a.people.size ? a.people.size : null);
      var risks = sortRisks(a.risks);
      var data = known ? known.data.slice() : [];
      risks.forEach(function (r) { RISKS[r].data.forEach(function (d) { if (data.indexOf(d) < 0) data.push(d); }); });
      if (data.length > 1) data = data.filter(function (d) { return d !== 'none'; });
      out.push({
        key: a.key,
        name: known ? known.name : tidyCase(a.name),
        cat: known ? known.cat : guessCat(a.name),
        data: data,
        known: known ? known.id : null,
        users: users,
        scopes: risks,
        sources: ['signin'],
      });
    });
    out.sort(function (a, b) { return (b.users || 0) - (a.users || 0) || (a.name < b.name ? -1 : 1); });
    var kind = /requestedservices|accesstogoogledata|verifiedstatus/.test(header) || google > ms ? 'google' : (/userprincipalname|objectid|appid|applicationid|requestid|delegatedpermissions|applicationpermissions/.test(header) || ms > 0 ? 'microsoft' : 'generic');
    return { kind: kind, apps: out, rows: body.length, builtin: builtin, unreadable: unreadable };
  }

  /** A pasted list of tool names: one a line, or separated by commas. */
  function parseList(text) {
    var lines = String(text || '').split(/\r?\n|,|;|\t/).map(function (l) { return clean(l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''), LIMITS.name); }).filter(function (l) { return l.length >= 2; });
    var seen = {}, out = [];
    lines.slice(0, LIMITS.listLines).forEach(function (l) {
      var key = toolKey(l);
      if (seen[key]) return;
      seen[key] = 1;
      var known = matchKnown(l);
      out.push({ key: key, name: known ? known.name : tidyCase(l), cat: known ? known.cat : guessCat(l), data: known ? known.data.slice() : [], known: known ? known.id : null, sources: ['list'] });
    });
    return { tools: out, over: lines.length > LIMITS.listLines };
  }

  /* ---------------- the inventory ---------------- */

  var ID_RE = /^t[0-9a-f]{12}$/;
  var SAVED_FIELDS = ['id', 'key', 'name', 'cat', 'status', 'owner', 'contract', 'contractEnd', 'dpa', 'data', 'sso', 'spendCents', 'users', 'renewal', 'notes', 'sources', 'scopes', 'trial', 'probable', 'billing'];

  function uniq(list, allowed) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (x) { if (allowed.indexOf(x) >= 0 && out.indexOf(x) < 0) out.push(x); });
    return out;
  }
  function cleanData(list) {
    var d = uniq(list, DATA);
    if (d.length > 1) d = d.filter(function (x) { return x !== 'none'; });
    return d;
  }
  function cleanTrial(t) {
    if (!t || typeof t !== 'object' || !isoDay(t.start) || !isoDay(t.converts)) return null;
    return { start: t.start, converts: t.converts, cents: Math.max(0, Math.min(int(t.cents, 10000) || 0, 10000)), converted: t.converted === true, estimated: t.estimated === true };
  }

  /**
   * One tool from anywhere - a detection, the page's edit form, a saved
   * document, a model - made safe to keep and to draw. Null when it has no
   * name.
   */
  function cleanTool(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = clean(raw.name, LIMITS.name);
    if (!name) return null;
    var key = typeof raw.key === 'string' && /^(k:[a-z0-9]{1,24}|[a-z0-9&]{1,60}|m[0-9a-f]{10})$/.test(raw.key) ? raw.key : toolKey(name);
    var spend = raw.spendCents !== undefined ? int(raw.spendCents, LIMITS.maxCents) : null;
    return {
      id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : 't' + hash('tool|' + key).slice(0, 12),
      key: key,
      name: name,
      cat: oneOf(raw.cat, CAT_IDS, 'other'),
      status: oneOf(raw.status, STATUSES, 'unapproved'),
      owner: clean(raw.owner, LIMITS.owner),
      contract: oneOf(raw.contract, CONTRACTS, 'none'),
      contractEnd: isoDay(raw.contractEnd) ? raw.contractEnd : null,
      dpa: raw.dpa === true,
      data: cleanData(raw.data),
      sso: raw.sso === true,
      spendCents: spend || 0,
      users: raw.users === null || raw.users === undefined || raw.users === '' ? null : int(raw.users),
      renewal: isoDay(raw.renewal) ? raw.renewal : null,
      notes: clean(raw.notes, LIMITS.notes),
      sources: uniq(raw.sources, SOURCES),
      scopes: sortRisks(uniq(raw.scopes, RISK_IDS)),
      trial: cleanTrial(raw.trial),
      probable: raw.probable === true,
      billing: oneOf(raw.billing, ['weekly', 'monthly', 'quarterly', 'annual', 'irregular', 'once', 'trial'], null),
    };
  }
  /** A whole inventory: cleaned, one tool per id and per key, capped. */
  function cleanTools(arr) {
    var out = [], ids = {}, keys = {};
    (Array.isArray(arr) ? arr : []).slice(0, LIMITS.tools * 2).forEach(function (r) {
      var t = cleanTool(r);
      if (!t || ids[t.id] || keys[t.key] || out.length >= LIMITS.tools) return;
      ids[t.id] = 1; keys[t.key] = 1;
      out.push(t);
    });
    return out;
  }
  /** Exactly what is stored for a tool: SAVED_FIELDS and nothing else. */
  function toSaved(t) {
    var c = cleanTool(t);
    if (!c) return null;
    var out = {};
    SAVED_FIELDS.forEach(function (k) { out[k] = c[k]; });
    return out;
  }

  /** A tool someone typed: {tool, error}. */
  function handTool(f, today) {
    var name = clean(f && f.name, LIMITS.name);
    if (name.length < 2) return { error: 'Give it a name.' };
    var known = matchKnown(name);
    var spendIn = f.spend === '' || f.spend === undefined || f.spend === null ? 0 : toCents(String(f.spend));
    if (spendIn === null) return { error: 'Type what it costs a year as a number, like 1200.' };
    var tool = cleanTool({
      name: known && name.toLowerCase() === known.name.toLowerCase() ? known.name : name,
      key: toolKey(name),
      cat: f.cat && CAT_IDS.indexOf(f.cat) >= 0 ? f.cat : (known ? known.cat : guessCat(name)),
      data: f.data && f.data.length ? f.data : (known ? known.data : []),
      status: f.status || 'unapproved',
      owner: f.owner,
      spendCents: spendIn,
      users: f.users,
      renewal: isoDay(f.renewal) && (!today || f.renewal >= today) ? f.renewal : null,
      sources: ['hand'],
    });
    return { tool: tool };
  }

  /**
   * Several sources -> one inventory, keyed by the normalised tool name.
   * Measured fields combine (spend from the card, users and scopes from the
   * sign-in export, the sources together); the data a tool touches is the
   * union. Each source's own order is kept for the first sighting.
   */
  function mergeSources(lists) {
    var by = new Map();
    (lists || []).forEach(function (list) {
      (list || []).forEach(function (raw) {
        if (!raw || !raw.name) return;
        var key = raw.key || toolKey(raw.name);
        var t = by.get(key);
        if (!t) {
          t = { key: key, name: raw.name, cat: raw.cat || 'other', data: [], sources: [], scopes: [], spendCents: 0, users: null, renewal: null, trial: null, probable: raw.probable === true, billing: raw.billing || null, known: raw.known || null };
          by.set(key, t);
        }
        if (raw.known && !t.known) { t.known = raw.known; t.name = raw.name; t.cat = raw.cat; }
        // An unknown tool's name from a sign-in export or a typed list is
        // how the vendor spells itself; a card descriptor's is a guess.
        else if (!t.known && t.sources.indexOf('card') >= 0 && t.sources.length === 1 && (raw.sources || []).some(function (x) { return x !== 'card'; })) t.name = raw.name;
        if (t.cat === 'other' && raw.cat) t.cat = raw.cat;
        (raw.data || []).forEach(function (d) { if (t.data.indexOf(d) < 0) t.data.push(d); });
        (raw.sources || []).forEach(function (s) { if (t.sources.indexOf(s) < 0) t.sources.push(s); });
        (raw.scopes || []).forEach(function (s) { if (t.scopes.indexOf(s) < 0) t.scopes.push(s); });
        if (raw.spendCents) t.spendCents = Math.max(t.spendCents, raw.spendCents);
        if (raw.users !== null && raw.users !== undefined) t.users = Math.max(t.users || 0, raw.users);
        if (raw.renewal && (!t.renewal || raw.renewal < t.renewal)) t.renewal = raw.renewal;
        if (raw.trial && !t.trial) t.trial = raw.trial;
        if (raw.billing && !t.billing) t.billing = raw.billing;
        // Seen in a sign-in export or named in a list: it is software, even
        // when the card alone could only say "probably".
        if (raw.probable !== true) t.probable = t.probable && (raw.sources || []).indexOf('card') >= 0 && !(raw.sources || []).some(function (s) { return s !== 'card'; });
      });
    });
    var out = [];
    by.forEach(function (t) { out.push(cleanTool(t)); });
    return out.filter(Boolean);
  }

  /**
   * A new import into an existing inventory. What a person decided (status,
   * owner, paperwork, the data it touches, SSO, notes) is kept; what was
   * measured (spend, users, scopes, a trial, a renewal from the card) is
   * refreshed; new tools join as "Not approved". {tools, added, updated}.
   */
  function mergeInto(existing, found) {
    var tools = cleanTools(existing);
    var byKey = {};
    tools.forEach(function (t, i) { byKey[t.key] = i; });
    var added = [], updated = [];
    cleanTools(found).forEach(function (f) {
      var at = byKey[f.key];
      if (at === undefined) {
        if (tools.length >= LIMITS.tools) return;
        f.status = 'unapproved';
        tools.push(f); byKey[f.key] = tools.length - 1; added.push(f.id);
        return;
      }
      var t = tools[at];
      if (f.spendCents) t.spendCents = f.spendCents;
      if (f.users !== null) t.users = f.users;
      if (f.scopes.length) t.scopes = sortRisks(uniq(t.scopes.concat(f.scopes), RISK_IDS));
      if (f.trial) t.trial = f.trial;
      if (f.renewal) t.renewal = f.renewal;
      if (f.billing) t.billing = f.billing;
      f.sources.forEach(function (s) { if (t.sources.indexOf(s) < 0) t.sources.push(s); });
      if (!f.probable) t.probable = false;
      if (!t.data.length) t.data = f.data.slice();
      updated.push(t.id);
    });
    return { tools: tools, added: added, updated: updated };
  }

  /* ---------------- the Shadow score ---------------- */

  var STATUS_W = { approved: 0.3, retiring: 0.45, review: 0.65, unapproved: 1 };
  var DATA_W = { health: 1, student: 1, customer: 0.8, employee: 0.8, financial: 0.8, confidential: 0.5, none: 0.1 };
  var BANDS_SCORE = [[75, 'Severe'], [50, 'High'], [25, 'Watch'], [0, 'Low']];
  function band(score) { for (var i = 0; i < BANDS_SCORE.length; i++) if (score >= BANDS_SCORE[i][0]) return BANDS_SCORE[i][1]; return 'Low'; }
  function personal(t) { return (t.data || []).some(function (d) { return PERSONAL.indexOf(d) >= 0; }); }
  function log10(x) { return Math.log(x) / Math.LN10; }

  /**
   * One tool's risk. Every factor is 1 when the tool is in good shape and
   * grows as it gets worse, so making any one thing worse can never lower
   * the score (tested). raw = 40 x status x data x access x users x spend x
   * contract x DPA x SSO x owner; score = 100 (1 - e^(-raw/100)).
   */
  function toolRisk(t) {
    var status = STATUS_W[t.status] || 1;
    var data = (t.data || []).filter(function (d) { return DATA_W[d] !== undefined; });
    var sens = data.length ? Math.max.apply(null, data.map(function (d) { return DATA_W[d]; })) : 0.5;
    var extra = data.filter(function (d) { return PERSONAL.indexOf(d) >= 0; }).length;
    sens = Math.min(1.3, sens + 0.1 * Math.max(0, extra - 1));
    var breadth = breadthOf(t.scopes);
    var access = 1 + breadth;
    var users = t.users === null || t.users === undefined ? 1 : t.users;
    var people = 1 + 0.5 * Math.min(1, log10(1 + users) / 2);
    var dollars = (t.spendCents || 0) / 100;
    var spend = 1 + 0.3 * Math.min(1, log10(1 + dollars) / log10(20001));
    var contract = t.contract === 'signed' ? 1 : t.contract === 'clickthrough' ? 1.15 : 1.3;
    var dpa = personal(t) && !t.dpa ? ((t.data || []).some(function (d) { return d === 'student' || d === 'health'; }) ? 1.5 : 1.35) : 1;
    var sso = !t.sso && (t.users === null || t.users === undefined || t.users >= 2) ? 1.15 : 1;
    var owner = t.owner ? 1 : 1.15;
    var raw = 40 * status * sens * access * people * spend * contract * dpa * sso * owner;
    var score = Math.round(100 * (1 - Math.exp(-raw / 100)));
    return {
      raw: raw, score: score, band: band(score),
      factors: { status: status, data: sens, access: access, users: people, spend: spend, contract: contract, dpa: dpa, sso: sso, owner: owner },
    };
  }
  var TOP = 10;     // how many of the riskiest tools the overall leans on
  var YARD = 100;   // the overall's yardstick, in raw points
  /**
   * The whole inventory: R = three quarters of the average raw risk of the
   * ten riskiest tools (missing places count as 0) plus a quarter of the
   * average over every tool, then score = 100 (1 - e^(-R/100)). The riskiest
   * ten are what a breach comes from, so they carry the score; the average
   * keeps a messy estate from hiding behind them. Raising any tool's risk
   * can never lower it, and a fix can never raise it (tested).
   */
  function scoreAll(tools) {
    var list = (tools || []).filter(Boolean);
    var per = {}, raws = [];
    list.forEach(function (t) { var r = toolRisk(t); per[t.id] = r; raws.push(r.raw); });
    raws.sort(function (a, b) { return b - a; });
    var total = raws.reduce(function (s, x) { return s + x; }, 0);
    var mean = list.length ? total / list.length : 0;
    var top = raws.slice(0, TOP).reduce(function (s, x) { return s + x; }, 0) / TOP;
    var R = 0.75 * top + 0.25 * mean;
    var exact = 100 * (1 - Math.exp(-R / YARD));
    var score = Math.round(exact);
    return { score: score, exact: exact, band: band(score), raw: total, mean: mean, top: top, R: R, tools: per };
  }

  /** The sentence at the top. */
  function headline(tools) {
    var list = tools || [];
    var unapproved = list.filter(function (t) { return t.status === 'unapproved'; }).length;
    var custNoContract = list.filter(function (t) { return t.status !== 'retiring' && (t.data || []).indexOf('customer') >= 0 && t.contract === 'none'; }).length;
    var noOwnerSpend = list.filter(function (t) { return !t.owner; }).reduce(function (s, t) { return s + (t.spendCents || 0); }, 0);
    var spend = list.reduce(function (s, t) { return s + (t.spendCents || 0); }, 0);
    var students = list.filter(function (t) { return t.status !== 'approved' && (t.data || []).indexOf('student') >= 0 && !t.dpa; }).length;
    return { tools: list.length, unapproved: unapproved, custNoContract: custNoContract, noOwnerSpendCents: noOwnerSpend, spendCents: spend, studentsNoDpa: students };
  }

  /* ---------------- the fix list ---------------- */

  function dataPhrase(t) {
    var d = (t.data || []).filter(function (x) { return PERSONAL.indexOf(x) >= 0; });
    if (!d.length) d = (t.data || []).filter(function (x) { return x !== 'none'; });
    var words = d.map(function (x) { return DATA_WORDS[x]; });
    return words.length <= 2 ? words.join(' and ') : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
  }
  function per$(cents) { return money(cents, { whole: true }) + ' a year'; }
  // Grants worth cutting: the broad ones that are rarely what a tool needs.
  // Rosters for a homework tool, or a calendar for a booking tool, are the
  // job itself and are left alone.
  function isBroad(r) { return Boolean(RISKS[r]) && RISKS[r].w >= 0.7 && r !== 'classroom'; }

  /** What could be done to each tool: {id, kind, toolId, text, why, patch}.
   *  `patch` is the change Apply makes to that tool. */
  function candidates(tools) {
    var out = [];
    var live = tools.filter(function (t) { return t.status !== 'retiring'; });
    live.forEach(function (t) {
      if (personal(t) && !t.dpa) out.push({ kind: 'dpa', toolId: t.id, text: 'Get a DPA from ' + t.name + ' - it holds ' + dataPhrase(t), why: 'A data-processing agreement says what they may do with that data and how fast they tell you about a breach.', patch: { dpa: true } });
      if (t.contract !== 'signed' && (personal(t) || t.spendCents >= 100000)) out.push({ kind: 'contract', toolId: t.id, text: 'Put ' + t.name + ' on a signed contract' + (t.spendCents ? ' - ' + per$(t.spendCents) : ''), why: t.contract === 'clickthrough' ? 'Click-through terms can change without asking you.' : 'Today nothing written says what you get or how to leave.', patch: { contract: 'signed' } });
      if (!t.sso && (t.users || 0) >= 2) out.push({ kind: 'sso', toolId: t.id, text: 'Turn on SSO for ' + t.name + ' - ' + t.users + ' users', why: 'When someone leaves, one switch in your directory locks them out of it too.', patch: { sso: true } });
      var broad = (t.scopes || []).filter(isBroad);
      if (broad.length) out.push({ kind: 'scope', toolId: t.id, text: 'Cut ' + t.name + '’s access to ' + RISKS[broad[0]].label + (t.users ? ' - ' + t.users + ' people granted it' : ''), why: 'Revoke the grant in your admin console and allow only what it needs.', patch: { scopes: (t.scopes || []).filter(function (r) { return !isBroad(r); }) } });
      if (!t.owner) out.push({ kind: 'owner', toolId: t.id, text: 'Name an owner for ' + t.name + (t.spendCents ? ' - ' + per$(t.spendCents) + ' with nobody’s name on it' : ''), why: 'Someone who decides on renewals, offboarding and what goes in it.', patch: { owner: 'Named owner' }, needs: 'owner' });
      if (t.status === 'unapproved' && !t.owner && (t.users || 0) <= 3) out.push({ kind: 'retire', toolId: t.id, text: 'Retire ' + t.name + ' - nobody approved it or owns it', why: 'Export what is in it, cancel it, and point people at the tool you already pay for.', patch: { status: 'retiring' } });
    });
    // Doubles: two tools doing one job.
    var byCat = {};
    live.forEach(function (t) { if (OVERLAP_CATS.indexOf(t.cat) >= 0) (byCat[t.cat] = byCat[t.cat] || []).push(t); });
    Object.keys(byCat).forEach(function (cat) {
      var list = byCat[cat];
      if (list.length < 2) return;
      // Keep the approved, most-used one; retire the next.
      var sorted = list.slice().sort(function (a, b) {
        return (a.status === 'approved' ? 0 : 1) - (b.status === 'approved' ? 0 : 1) || (b.users || 0) - (a.users || 0) || b.spendCents - a.spendCents || (a.name < b.name ? -1 : 1);
      });
      var drop = sorted[sorted.length - 1];
      var n = list.length;
      var count = ['', '', 'two', 'three', 'four', 'five'][n] || String(n);
      out.push({ kind: 'overlap', toolId: drop.id, text: 'Retire one of the ' + count + ' ' + OVERLAP_NOUN[cat] + ' - ' + drop.name + (drop.spendCents ? ' costs ' + per$(drop.spendCents) : ''), why: 'Keep ' + sorted[0].name + '. Two tools for one job is two bills and two places the same data lives.', patch: { status: 'retiring' } });
    });
    out.forEach(function (c) { c.id = c.kind + ':' + c.toolId; });
    return out;
  }
  function patchTools(tools, toolId, patch) {
    return tools.map(function (t) { return t.id === toolId ? Object.assign({}, t, patch) : t; });
  }
  /** Apply one fix: the tools with its patch (and a typed owner, for the
   *  owner fix). The inventory passed in is never changed. */
  function applyFix(tools, fix, opts) {
    var patch = Object.assign({}, fix.patch);
    if (fix.kind === 'owner') patch.owner = clean((opts && opts.owner) || patch.owner, LIMITS.owner) || 'Named owner';
    return patchTools(tools, fix.toolId, patch);
  }
  /**
   * The fix list: every candidate applied and re-scored. `delta` is exactly
   * score(now) - score(applied), to a tenth of a point (the overall is drawn
   * whole; a fix is often worth less than one). Under a tenth is not
   * offered. Biggest first.
   */
  function fixes(tools) {
    var list = cleanTools(tools);
    var now = scoreAll(list);
    var out = [];
    candidates(list).forEach(function (c) {
      var after = scoreAll(applyFix(list, c));
      var exact = now.exact - after.exact;
      var delta = Math.round(exact * 10) / 10;
      if (delta < 0.1) return;
      c.delta = delta;
      c.exact = exact;
      c.after = after.score;
      var t = list.filter(function (x) { return x.id === c.toolId; })[0];
      c.toolName = t ? t.name : '';
      out.push(c);
    });
    out.sort(function (a, b) { return b.exact - a.exact || (a.id < b.id ? -1 : 1); });
    return out;
  }
  /** The first `n` to show: the best fix for each tool, in order, so three
   *  fixes are three tools; then the rest in order. */
  function topFixes(list, n) {
    var seen = {}, first = [], rest = [];
    (list || []).forEach(function (f) { if (seen[f.toolId]) rest.push(f); else { seen[f.toolId] = 1; first.push(f); } });
    var all = first.concat(rest);
    return n ? all.slice(0, n) : all;
  }

  /* ---------------- trial and renewal radar ---------------- */

  function inDays(n) { return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 0 ? (-n === 1 ? 'yesterday' : -n + ' days ago') : 'in ' + n + ' days'; }
  /**
   * What needs a decision soon: trials converting, yearly or quarterly
   * renewals and contract ends in the next `days` (60) days - and a trial
   * that probably converted in the last week. Sorted by date.
   */
  function radar(tools, today, days) {
    var horizon = days || 60;
    var out = [];
    (tools || []).forEach(function (t) {
      if (t.trial && !t.trial.converted) {
        var d = daysBetween(today, t.trial.converts);
        if (d >= -7 && d <= horizon) {
          out.push({ id: t.id, kind: 'trial', date: t.trial.converts, days: d, toolName: t.name,
            title: d < 0 ? t.name + ' trial probably converted ' + inDays(d) + ' - check' : 'Trial converts ' + inDays(d) + ' - decide',
            detail: t.name + (t.trial.estimated ? ' started a trial on ' + fmtDate(t.trial.start) + '; most trials run ' + TRIAL_DAYS + ' days, so it converts about ' + fmtDate(t.trial.converts) + ' - check the sign-up email.' : ' trial converts on ' + fmtDate(t.trial.converts) + '.') + ' Approve it, or cancel before then.' });
        }
      }
      if (t.renewal) {
        var r = daysBetween(today, t.renewal);
        if (r >= 0 && r <= horizon) {
          out.push({ id: t.id, kind: 'renewal', date: t.renewal, days: r, toolName: t.name,
            title: t.status === 'retiring' ? 'Cancel ' + t.name + ' before it renews ' + inDays(r) : t.name + ' renews ' + inDays(r) + (t.spendCents ? ' - ' + money(t.spendCents, { whole: true }) : ''),
            detail: t.name + ' renews on ' + fmtDate(t.renewal, today.slice(0, 4)) + (t.spendCents ? ' for about ' + per$(t.spendCents) : '') + '.' + (t.status !== 'approved' ? ' Nobody has approved it yet.' : '') + (t.contract !== 'signed' ? ' No signed contract.' : '') });
        }
      }
      if (t.contractEnd) {
        var c = daysBetween(today, t.contractEnd);
        if (c >= 0 && c <= horizon) {
          out.push({ id: t.id, kind: 'contract', date: t.contractEnd, days: c, toolName: t.name,
            title: t.name + '’s contract ends ' + inDays(c),
            detail: 'The contract for ' + t.name + ' ends on ' + fmtDate(t.contractEnd, today.slice(0, 4)) + '. Renegotiate, renew or plan the exit - and check the notice period.' });
        }
      }
    });
    return out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.kind < b.kind ? -1 : 1); });
  }

  function icsText(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(CTRL, ' ')
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
  /** When to be reminded: the day before a trial converts, a week before a
   *  renewal, two weeks before a contract ends - never before today. */
  function remindOn(item, today) {
    var lead = item.kind === 'trial' ? 1 : item.kind === 'renewal' ? 7 : 14;
    var at = addDays(item.date, -lead);
    return today && at < today ? today : at;
  }
  /** One all-day event per radar item, with a 9am alert. UIDs come from the
   *  tool and the kind, not the date, so importing again moves an event
   *  rather than adding a second. */
  function ics(opts) {
    var o = opts || {};
    var items = (o.items || radar(o.tools, o.today)).filter(function (it) { return it.days === undefined || it.days >= 0; });
    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Challenge Lab//Shadow//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsText('Shadow: trials and renewals')];
    var dt = stamp(o.now);
    items.forEach(function (it) {
      var on = remindOn(it, o.today);
      if (!isoDay(on)) return;
      L.push('BEGIN:VEVENT',
        'UID:' + hash(String(it.id) + '|' + it.kind) + '@shadow.challenge.strongtechnicalconsulting.com',
        'DTSTAMP:' + dt,
        'DTSTART;VALUE=DATE:' + on.replace(/-/g, ''),
        'DTEND;VALUE=DATE:' + addDays(on, 1).replace(/-/g, ''),
        'SUMMARY:' + icsText(it.title),
        'DESCRIPTION:' + icsText(it.detail + '\nFrom your Shadow inventory.'),
        'TRANSP:TRANSPARENT',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(it.title), 'TRIGGER:PT9H', 'END:VALARM',
        'END:VEVENT');
    });
    L.push('END:VCALENDAR');
    return L.map(fold).join('\r\n') + '\r\n';
  }

  /* ---------------- the CSV export ---------------- */

  /** One CSV cell, safe to open in a spreadsheet: a leading = + - @ (or a
   *  tab or CR) would run as a formula, so it gets a ' in front. */
  function csvCell(v) {
    var s = String(v === null || v === undefined ? '' : v).replace(CTRL, ' ');
    if (/^\s*[=+\-@]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function toCsv(tools) {
    var list = cleanTools(tools);
    var sc = scoreAll(list);
    var head = ['Tool', 'Category', 'Status', 'Owner', 'Contract', 'Contract ends', 'DPA', 'Data it touches', 'SSO', 'Users', 'Spend a year (USD)', 'Renews', 'Access granted', 'Risk', 'Band', 'Found in', 'Notes'];
    var rows = [head.map(csvCell).join(',')];
    list.forEach(function (t) {
      var r = sc.tools[t.id];
      rows.push([t.name, CATS[t.cat].label, STATUS_LABEL[t.status], t.owner, CONTRACT_LABEL[t.contract], t.contractEnd || '', t.dpa ? 'Yes' : 'No', t.data.map(function (d) { return DATA_LABEL[d]; }).join('; '), t.sso ? 'Yes' : 'No', t.users === null ? '' : t.users, plain(t.spendCents), t.renewal || '', riskWords(t.scopes).join('; '), r.score, r.band, t.sources.map(function (s) { return SOURCE_LABEL[s]; }).join('; '), t.notes].map(csvCell).join(','));
    });
    return '\ufeff' + rows.join('\r\n') + '\r\n';
  }

  /* ---------------- "Can I use this?" requests ---------------- */

  var TRIAL_ANSWERS = ['yes', 'no', 'unsure'];
  /** What a staff member sends: {request} or {error}. */
  function cleanRequest(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var tool = clean(r.tool, LIMITS.name);
    var name = clean(r.name, LIMITS.owner);
    if (tool.length < 2) return { error: 'Which tool? Give its name.' };
    if (!name) return { error: 'Add your name, so they know who asked.' };
    return {
      request: {
        tool: tool,
        name: name,
        why: clean(r.why, LIMITS.reason),
        data: cleanData(r.data),
        trial: oneOf(r.trial, TRIAL_ANSWERS, 'unsure'),
        users: int(r.users, 100000),
      },
    };
  }
  /**
   * An owner's decision folded into the inventory. Approve: the tool is
   * added (or updated) as Approved, with the conditions in its notes and the
   * requester as owner when it has none. Decline: an existing tool goes to
   * Not approved; a new one is added only when a trial is already running,
   * so the trial is on the radar.
   */
  function applyDecision(tools, req, decision, conditions, today) {
    var list = cleanTools(tools);
    var key = toolKey(req.tool);
    var known = matchKnown(req.tool);
    var at = -1;
    list.forEach(function (t, i) { if (t.key === key) at = i; });
    var note = (decision === 'approve' ? 'Approved ' : 'Declined ') + fmtDate(today, today.slice(0, 4)) + ' for ' + req.name + (conditions ? ': ' + conditions : '.');
    if (at >= 0) {
      var t = Object.assign({}, list[at]);
      t.status = decision === 'approve' ? 'approved' : 'unapproved';
      if (decision === 'approve' && !t.owner) t.owner = req.name;
      t.data = cleanData(t.data.concat(req.data || []));
      if (t.sources.indexOf('request') < 0) t.sources = t.sources.concat(['request']);
      t.notes = clean((note + ' ' + t.notes).trim(), LIMITS.notes);
      list[at] = cleanTool(t);
      return { tools: list, toolId: list[at].id, added: false };
    }
    if (decision !== 'approve' && req.trial !== 'yes') return { tools: list, toolId: null, added: false };
    if (list.length >= LIMITS.tools) return { tools: list, toolId: null, added: false, full: true };
    var fresh = cleanTool({
      name: known ? known.name : req.tool, key: key, cat: known ? known.cat : guessCat(req.tool),
      data: (req.data && req.data.length) ? req.data : (known ? known.data : []),
      status: decision === 'approve' ? 'approved' : 'unapproved',
      owner: decision === 'approve' ? req.name : '', users: req.users, notes: note, sources: ['request'],
      trial: req.trial === 'yes' && decision !== 'approve' ? { start: today, converts: addDays(today, TRIAL_DAYS), cents: 0, estimated: true } : null,
    });
    list.push(fresh);
    return { tools: list, toolId: fresh.id, added: true };
  }

  /* ---------------- reading a vendor's terms ---------------- */

  var TERMS = [
    { key: 'trainsAi', label: 'Trains AI on your data', answers: ['yes', 'no', 'opt-out', 'unclear'] },
    { key: 'retention', label: 'How long they keep it' },
    { key: 'location', label: 'Where it is stored' },
    { key: 'subprocessors', label: 'Subprocessors named' },
    { key: 'breachNotice', label: 'Breach notice' },
    { key: 'dpa', label: 'DPA offered', answers: ['yes', 'no', 'unclear'] },
    { key: 'autoRenewal', label: 'Auto-renewal' },
    { key: 'cancellation', label: 'Cancellation notice' },
  ];
  var TERM_KEYS = TERMS.map(function (t) { return t.key; });
  var CONF = ['high', 'medium', 'low'];
  // The answers that need a second look, by item.
  function termWorry(key, answer) {
    var a = String(answer || '').toLowerCase();
    if (key === 'trainsAi') return a === 'yes' ? 'bad' : a === 'opt-out' || a === 'unclear' ? 'warn' : 'ok';
    if (key === 'dpa') return a === 'no' ? 'bad' : a === 'unclear' ? 'warn' : 'ok';
    if (/not stated|unclear|not found|^$/.test(a)) return 'warn';
    return 'neutral';
  }

  /**
   * A model's reading of a vendor's terms, made safe to draw. Each item's
   * answer comes from a fixed list where there is one (anything else is
   * "unclear"), every string is bounded and stripped, and EVERY QUOTE IS
   * LOOKED FOR in the pasted text as an exact substring (after normForMatch).
   * One that is not there is kept, marked `verified: false`. An item with no
   * quote is "not found in the text". Null when nothing came back.
   */
  function cleanTerms(raw, text) {
    if (!raw || typeof raw !== 'object' || raw.readable === false) return null;
    var found = matcher(typeof text === 'string' ? text.slice(0, LIMITS.termsText * 2) : '');
    var items = [], unverified = 0, answered = 0;
    var src = raw.items && typeof raw.items === 'object' ? raw.items : {};
    TERMS.forEach(function (def) {
      var it = src[def.key];
      if (!it || typeof it !== 'object') it = {};
      var answer = def.answers ? oneOf(String(it.answer || '').toLowerCase(), def.answers, 'unclear') : clean(it.answer, 80);
      if (!def.answers && !answer) answer = 'Not stated';
      var quote = clean(it.quote, 600);
      var verified = Boolean(quote) && found(quote);
      if (quote && !verified) unverified++;
      if (quote) answered++;
      items.push({
        key: def.key,
        label: def.label,
        answer: answer,
        detail: clean(it.detail, 280),
        quote: quote,
        verified: verified,
        noQuote: !quote,
        confidence: oneOf(it.confidence, CONF, 'low'),
        worry: termWorry(def.key, answer),
      });
    });
    if (!answered && items.every(function (i) { return /^(unclear|not stated)$/i.test(i.answer); })) return null;
    return {
      vendor: clean(raw.vendor, 80),
      summary: clean(raw.summary, 300),
      items: items,
      unverified: unverified,
      confidence: oneOf(raw.confidence, CONF, 'low'),
    };
  }
  /** One line for a tool's notes, from a reading: no quotes, no text. */
  function termsNote(r, today) {
    if (!r) return '';
    var get = function (k) { return r.items.filter(function (i) { return i.key === k; })[0] || {}; };
    return clean('Terms read ' + fmtDate(today, today.slice(0, 4)) + ': trains AI ' + get('trainsAi').answer + '; DPA offered ' + get('dpa').answer + '; breach notice ' + get('breachNotice').answer + '; retention ' + get('retention').answer + '.', 300);
  }

  return {
    LIMITS: LIMITS, STATUSES: STATUSES, STATUS_LABEL: STATUS_LABEL, CONTRACTS: CONTRACTS, CONTRACT_LABEL: CONTRACT_LABEL,
    DATA: DATA, DATA_LABEL: DATA_LABEL, DATA_WORDS: DATA_WORDS, PERSONAL: PERSONAL, CATS: CATS, CAT_IDS: CAT_IDS, SOURCES: SOURCES, SOURCE_LABEL: SOURCE_LABEL,
    CADENCES: CADENCES, RISKS: RISKS, RISK_IDS: RISK_IDS, KNOWN: KNOWN, KNOWN_BY_ID: KNOWN_BY_ID, TERMS: TERMS, TERM_KEYS: TERM_KEYS, TRIAL_DAYS: TRIAL_DAYS,
    STATUS_W: STATUS_W, DATA_W: DATA_W, TOP: TOP, YARD: YARD, SAVED_FIELDS: SAVED_FIELDS, ID_RE: ID_RE, TRIAL_ANSWERS: TRIAL_ANSWERS,
    clean: clean, scrub: scrub, tidyCase: tidyCase, hash: hash, normForMatch: normForMatch, matcher: matcher,
    readMoney: readMoney, toCents: toCents, signedCents: signedCents, money: money, plain: plain, int: int,
    ymd: ymd, isoDay: isoDay, dayNum: dayNum, addDays: addDays, addMonths: addMonths, daysBetween: daysBetween, step: step, fmtDate: fmtDate, parseDate: parseDate,
    detectDelimiter: detectDelimiter, parseCsv: parseCsv,
    parseStatement: parseStatement, parseStatements: parseStatements,
    matchKnown: matchKnown, stripDescriptor: stripDescriptor, toolKey: toolKey, vendorInfo: vendorInfo, guessCat: guessCat, cadenceOf: cadenceOf,
    findSoftware: findSoftware,
    scopeRisk: scopeRisk, risksOf: risksOf, breadthOf: breadthOf, riskWords: riskWords, parseAccess: parseAccess, parseList: parseList,
    cleanTool: cleanTool, cleanTools: cleanTools, toSaved: toSaved, handTool: handTool, mergeSources: mergeSources, mergeInto: mergeInto,
    toolRisk: toolRisk, scoreAll: scoreAll, band: band, personal: personal, headline: headline,
    candidates: candidates, applyFix: applyFix, fixes: fixes, topFixes: topFixes,
    radar: radar, ics: ics, icsText: icsText, fold: fold, remindOn: remindOn,
    csvCell: csvCell, toCsv: toCsv,
    cleanRequest: cleanRequest, applyDecision: applyDecision,
    cleanTerms: cleanTerms, termsNote: termsNote, termWorry: termWorry,
  };
}));
