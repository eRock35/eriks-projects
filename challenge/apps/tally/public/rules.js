/* Tally's rules - everything that needs no model, in one file that runs in the
 * browser AND on the server (server.js requires it).
 *
 *   toCents / money        money is INTEGER CENTS everywhere. Dollars typed as
 *                          text are read digit by digit, never through a
 *                          float, so "$1,284.50" is 128450 and 0.1 + 0.2 never
 *                          happens to anyone's books.
 *   holidays / business    the settlement calendar: weekends and the Federal
 *                          Reserve's bank holidays roll a payout forward.
 *   expected               what a closed day should put in the bank: card
 *                          sales + card tips - refunds - the estimated fee
 *                          (flat % + per transaction, from settings).
 *   reconcile              deposits matched to days inside each day's
 *                          settlement window, batched multi-day deposits
 *                          allowed. Every day comes out matched, short,
 *                          pending or missing - with the reason in words.
 *   month                  the calendar heatmap, the month's totals, the
 *                          streak of reconciled days, fee creep.
 *   parseBankCsv           deposits out of the CSV a bank's website already
 *                          offers. No bank connection, ever.
 *   exportCsv              the month's reconciliation, formula-injection safe.
 *
 * One implementation on purpose: the demo, the page and the server compute
 * the same statuses from the same code, so what the calendar shows and what
 * the export says cannot disagree by a cent. Every fee here is an ESTIMATE
 * from the fee model in settings, and the page says so.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY_MS = 86400000;

  var LIMITS = {
    days: 400,              // closed days one person keeps (13 months)
    deposits: 2000,         // deposits one person keeps
    importRows: 500,        // deposits added in one request
    csvBytes: 2 * 1024 * 1024,
    csvRows: 5000,
    maxCents: 1000000000,   // $10,000,000 - a day or a deposit, not a GDP
    maxTx: 100000,
    keywords: 40,
    keywordLen: 30,
    note: 200,
    description: 120,
    business: 60,
    maxBatchDays: 5,        // consecutive days one deposit may cover
    lateBusinessDays: 5,    // a deposit this far past due still matches, marked late
  };

  /* ---------------- text ---------------- */

  /** Plain text: tags and control characters out, whitespace collapsed,
   *  bounded. Cut to four times the limit BEFORE any pattern runs, so a
   *  megabyte of '<' costs nothing. */
  function clean(v, max) {
    var s = String(v == null ? '' : v).slice(0, (max || 200) * 4);
    s = s.replace(/<[^<>]*>/g, ' ').replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return s.slice(0, max || 200).trim();
  }

  /* ---------------- money: integer cents ---------------- */

  var MONEY_RE = /^(-)?\$?(-)?((?:\d{1,3}(?:,\d{3})+)|\d+)?(?:\.(\d*))?(-)?$/;

  /**
   * "$1,284.50" -> 128450. Accepts a number or text; "(12.00)" and a trailing
   * or leading minus are negative (refused unless `allowNegative`). More than
   * two decimals round half up on the third digit - read from the digits,
   * never from a float. Anything else is null.
   */
  function toCents(v, allowNegative) {
    if (v == null) return null;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return null;
      // A JS number is shown shortest-round-trip, so 1284.5 reads "1284.5"
      // and 0.1 + 0.2 reads "0.30000000000000004" -> 30 cents after rounding.
      v = Math.abs(v) < 1e-6 ? '0' : String(v);
      if (/e/i.test(v)) return null;
    }
    var s = String(v).trim().replace(/\s+/g, '').replace(/^usd/i, '').replace(/usd$/i, '');
    if (!s) return null;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    var m = MONEY_RE.exec(s);
    if (!m || (m[3] === undefined && !m[4])) return null;
    if (m[1] || m[2] || m[5]) neg = true;
    var whole = Number((m[3] || '0').replace(/,/g, ''));
    var frac = (m[4] || '') + '000';
    var cents = whole * 100 + Number(frac.slice(0, 2)) + (Number(frac.charAt(2)) >= 5 ? 1 : 0);
    if (!Number.isSafeInteger(cents)) return null;
    if (neg && cents !== 0) {
      if (!allowNegative) return null;
      cents = -cents;
    }
    return cents;
  }

  function group3(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /** 128450 -> "$1,284.50"; negative "−$12.00" (a real minus sign). */
  function money(c) {
    c = Math.round(Number(c) || 0);
    var a = Math.abs(c);
    return (c < 0 ? '−' : '') + '$' + group3(Math.floor(a / 100)) + '.' + String(a % 100).padStart(2, '0');
  }
  /** Whole dollars: "$1,285". */
  function money0(c) {
    c = Math.round(Number(c) || 0);
    var a = Math.round(Math.abs(c) / 100);
    return (c < 0 ? '−' : '') + '$' + group3(a);
  }
  /** Compact for a calendar cell: "$842", "$1.3k", "$12k". */
  function moneyShort(c) {
    var d = Math.round(Math.abs(Number(c) || 0) / 100);
    if (d < 1000) return '$' + d;
    if (d < 10000) return '$' + (Math.round(d / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'k';
    return '$' + Math.round(d / 1000) + 'k';
  }
  /** 128450 -> "1284.50" for a CSV or an input's value. */
  function plain(c) {
    c = Math.round(Number(c) || 0);
    var a = Math.abs(c);
    return (c < 0 ? '-' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
  }
  /** A rate (0.0277) as "2.77%". */
  function pct(r, digits) {
    if (r == null || !Number.isFinite(r)) return '—';
    return (r * 100).toFixed(digits == null ? 2 : digits) + '%';
  }
  /** Basis points (260) as "2.6%". */
  function bpsText(b) { return (Math.round(b) / 100).toFixed(2).replace(/0$/, '').replace(/\.0$/, '') + '%'; }
  /** "2.6" (percent, as typed) -> 260 bps; two decimals of a percent at most. */
  function toBps(v) {
    var s = String(v == null ? '' : v).trim().replace(/%$/, '').trim();
    if (!/^\d{1,2}(\.\d{1,2})?$|^\.\d{1,2}$/.test(s)) return null;
    var parts = s.split('.');
    return Number(parts[0] || 0) * 100 + Number(((parts[1] || '') + '00').slice(0, 2));
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* ---------------- the calendar ---------------- */

  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function ymd(y, m, d) {
    var t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
    return t.toISOString().slice(0, 10);
  }
  /** A real calendar day as YYYY-MM-DD, or null. "2026-02-30" is null. */
  function isoDay(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v == null ? '' : v).trim());
    if (!m) return null;
    var y = +m[1];
    if (y < 2000 || y > 2100) return null;
    return ymd(y, +m[2], +m[3]);
  }
  function isoMonth(v) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(v == null ? '' : v).trim());
    return m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 2000 && +m[1] <= 2100 ? m[0] : null;
  }
  function addDays(iso, n) {
    var t = new Date(iso + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS); }
  function dow(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); }
  function weekday(iso) { return WEEKDAYS[dow(iso)]; }
  function monthOf(iso) { return String(iso).slice(0, 7); }
  function addMonths(month, n) {
    var y = +month.slice(0, 4); var m = +month.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + String(m + 1).padStart(2, '0');
  }
  function monthLabel(month) { return MONTHS[+month.slice(5, 7) - 1] + ' ' + month.slice(0, 4); }
  /** "Tue, Sep 22" */
  function dayShort(iso) { return WEEKDAYS[dow(iso)].slice(0, 3) + ', ' + MONTHS[+iso.slice(5, 7) - 1].slice(0, 3) + ' ' + (+iso.slice(8, 10)); }
  /** "Tuesday, Sep 22" */
  function dayLong(iso) { return WEEKDAYS[dow(iso)] + ', ' + MONTHS[+iso.slice(5, 7) - 1].slice(0, 3) + ' ' + (+iso.slice(8, 10)); }
  /** "Sep 22" */
  function monthDay(iso) { return MONTHS[+iso.slice(5, 7) - 1].slice(0, 3) + ' ' + (+iso.slice(8, 10)); }

  function nthWeekday(y, month, wd, n) {
    if (n > 0) {
      var first = dow(ymd(y, month, 1));
      return ymd(y, month, 1 + ((wd - first + 7) % 7) + (n - 1) * 7);
    }
    var lastDay = new Date(Date.UTC(y, month, 0)).getUTCDate();
    var last = dow(ymd(y, month, lastDay));
    return ymd(y, month, lastDay - ((last - wd + 7) % 7));
  }

  var holidayCache = {};
  /**
   * The Federal Reserve's holidays for a year, observed: a Sunday holiday is
   * observed Monday; a Saturday one is NOT moved to Friday (the Fed stays
   * open), which is why July 3, 2026 is an ordinary banking day. ACH - and so
   * every card payout - does not settle on these.
   */
  function holidays(y) {
    if (holidayCache[y]) return holidayCache[y];
    var out = {};
    function fixed(m, d, name) {
      var iso = ymd(y, m, d);
      var w = dow(iso);
      if (w === 0) out[addDays(iso, 1)] = name + ' (observed)';
      else if (w !== 6) out[iso] = name;
    }
    fixed(1, 1, 'New Year’s Day');
    out[nthWeekday(y, 1, 1, 3)] = 'Martin Luther King Jr. Day';
    out[nthWeekday(y, 2, 1, 3)] = 'Presidents’ Day';
    out[nthWeekday(y, 5, 1, -1)] = 'Memorial Day';
    fixed(6, 19, 'Juneteenth');
    fixed(7, 4, 'Independence Day');
    out[nthWeekday(y, 9, 1, 1)] = 'Labor Day';
    out[nthWeekday(y, 10, 1, 2)] = 'Columbus Day';
    fixed(11, 11, 'Veterans Day');
    out[nthWeekday(y, 11, 4, 4)] = 'Thanksgiving';
    fixed(12, 25, 'Christmas Day');
    holidayCache[y] = out;
    return out;
  }
  function holidayName(iso) { return holidays(+iso.slice(0, 4))[iso] || null; }
  function isBusinessDay(iso) { var w = dow(iso); return w !== 0 && w !== 6 && !holidayName(iso); }
  /** n business days after `iso` (weekends and bank holidays skipped). */
  function addBusinessDays(iso, n) {
    var d = iso; var k = 0;
    while (k < n) { d = addDays(d, 1); if (isBusinessDay(d)) k++; }
    return d;
  }
  /** Bank holidays that fall inside (from, to]. */
  function holidaysBetween(from, to) {
    var out = [];
    for (var d = addDays(from, 1); d <= to; d = addDays(d, 1)) { var h = holidayName(d); if (h) out.push({ date: d, name: h }); }
    return out;
  }

  /* ---------------- settings: the fee model ---------------- */

  // Typical published US in-person rates and payout speeds as we understand
  // them in September 2026. ESTIMATES: plans, card mix and contracts differ,
  // and interchange-plus processors (Heartland, Worldpay) have no single rate
  // at all. The page says so beside every one; a statement is the truth.
  var PRESETS = [
    { key: 'square', label: 'Square', feeBps: 260, feeFixedCents: 15, windowDays: 1, note: 'In person · next-business-day transfers' },
    { key: 'stripe', label: 'Stripe', feeBps: 270, feeFixedCents: 5, windowDays: 2, note: 'Terminal · standard 2-day payouts' },
    { key: 'clover', label: 'Clover', feeBps: 260, feeFixedCents: 10, windowDays: 2, note: 'In person · varies by plan' },
    { key: 'toast', label: 'Toast', feeBps: 249, feeFixedCents: 15, windowDays: 2, note: 'Restaurants · varies by plan' },
    { key: 'sumup', label: 'SumUp', feeBps: 275, feeFixedCents: 0, windowDays: 2, note: 'In person · flat rate' },
    { key: 'zettle', label: 'Zettle', feeBps: 229, feeFixedCents: 9, windowDays: 2, note: 'PayPal Zettle, in person · 1–2 day payouts' },
    { key: 'heartland', label: 'Heartland', feeBps: 290, feeFixedCents: 10, windowDays: 2, note: 'Interchange-plus · a placeholder, use your statement' },
    { key: 'worldpay', label: 'Worldpay', feeBps: 290, feeFixedCents: 10, windowDays: 2, note: 'Interchange-plus · a placeholder, use your statement' },
    { key: 'custom', label: 'Something else', feeBps: 290, feeFixedCents: 10, windowDays: 2, note: 'Type the rate from your statement' },
  ];
  var PRESET_KEYS = PRESETS.map(function (p) { return p.key; });
  function preset(key) { for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].key === key) return PRESETS[i]; return PRESETS[PRESETS.length - 1]; }

  // Words a processor's payout carries in a bank statement's description.
  // Editable in settings: a bank that writes "MRCH SVC" is one tap away.
  var DEFAULT_KEYWORDS = ['SQUARE', 'SQ *', 'STRIPE', 'CLOVER', 'FIRST DATA', 'FISERV', 'TOAST', 'SUMUP', 'PAYPAL', 'ZETTLE',
    'HEARTLAND', 'WORLDPAY', 'VANTIV', 'ELAVON', 'TSYS', 'GLOBAL PAYMENTS', 'SHOPIFY', 'MERCH DEP', 'MERCHANT DEP', 'MERCH SETTLE',
    'BANKCARD', 'BNKCD', 'CARD SETTLE'];
  // Which processor a keyword names, for the little tag on an imported row.
  var KEYWORD_PROCESSOR = { 'SQUARE': 'Square', 'SQ *': 'Square', 'STRIPE': 'Stripe', 'CLOVER': 'Clover', 'FIRST DATA': 'Clover', 'FISERV': 'Clover',
    'TOAST': 'Toast', 'SUMUP': 'SumUp', 'PAYPAL': 'PayPal', 'ZETTLE': 'Zettle', 'HEARTLAND': 'Heartland', 'WORLDPAY': 'Worldpay',
    'VANTIV': 'Worldpay', 'ELAVON': 'Elavon', 'TSYS': 'TSYS', 'GLOBAL PAYMENTS': 'Global Payments', 'SHOPIFY': 'Shopify' };

  var DEFAULTS = {
    business: '',
    processor: 'square',
    feeBps: 260,
    feeFixedCents: 15,
    windowDays: 1,
    tolCents: 200,      // a deposit may be this far under...
    tolBps: 50,         // ...or this share of the expected amount, whichever is larger
    keywords: DEFAULT_KEYWORDS.slice(),
    configured: false,  // true once the owner has chosen a processor
  };

  function normKeyword(k) { return clean(k, LIMITS.keywordLen).toUpperCase(); }

  /** A settings document, cleaned; anything missing or bad falls back. */
  function settingsOf(raw) {
    var r = raw || {};
    var s = {};
    s.business = clean(r.business, LIMITS.business);
    s.processor = PRESET_KEYS.indexOf(r.processor) >= 0 ? r.processor : DEFAULTS.processor;
    s.feeBps = Number.isInteger(r.feeBps) && r.feeBps >= 0 && r.feeBps <= 1500 ? r.feeBps : DEFAULTS.feeBps;
    s.feeFixedCents = Number.isInteger(r.feeFixedCents) && r.feeFixedCents >= 0 && r.feeFixedCents <= 500 ? r.feeFixedCents : DEFAULTS.feeFixedCents;
    s.windowDays = [1, 2, 3].indexOf(r.windowDays) >= 0 ? r.windowDays : DEFAULTS.windowDays;
    s.tolCents = Number.isInteger(r.tolCents) && r.tolCents >= 0 && r.tolCents <= 100000 ? r.tolCents : DEFAULTS.tolCents;
    s.tolBps = Number.isInteger(r.tolBps) && r.tolBps >= 0 && r.tolBps <= 1000 ? r.tolBps : DEFAULTS.tolBps;
    var kw = Array.isArray(r.keywords) ? r.keywords : DEFAULTS.keywords;
    var seen = {};
    s.keywords = kw.map(normKeyword).filter(function (k) { if (k.length < 2 || seen[k]) return false; seen[k] = 1; return true; }).slice(0, LIMITS.keywords);
    s.configured = r.configured === true;
    return s;
  }

  /**
   * Settings from a form. Percent as typed ("2.6"), the per-transaction fee in
   * dollars ("0.15"), the tolerance in dollars and percent. Returns
   * { settings } or { error, field }.
   */
  function validateSettings(raw, prev) {
    var r = raw || {};
    var base = settingsOf(prev);
    var out = Object.assign({}, base);
    if (r.business !== undefined) out.business = clean(r.business, LIMITS.business);
    if (r.processor !== undefined) {
      if (PRESET_KEYS.indexOf(r.processor) < 0) return { error: 'Pick a processor from the list, or “Something else”.', field: 'processor' };
      out.processor = r.processor;
    }
    if (r.feePct !== undefined) {
      var b = toBps(r.feePct);
      if (b === null || b > 1500) return { error: 'The fee percentage should look like 2.6 (0 to 15).', field: 'feePct' };
      out.feeBps = b;
    }
    if (r.feeFixed !== undefined) {
      var f = toCents(r.feeFixed);
      if (f === null || f > 500) return { error: 'The per-transaction fee should look like 0.15 (up to $5).', field: 'feeFixed' };
      out.feeFixedCents = f;
    }
    if (r.windowDays !== undefined) {
      var w = Number(r.windowDays);
      if ([1, 2, 3].indexOf(w) < 0) return { error: 'Deposits arrive in 1, 2 or 3 business days.', field: 'windowDays' };
      out.windowDays = w;
    }
    if (r.tol !== undefined) {
      var t = toCents(r.tol);
      if (t === null || t > 100000) return { error: 'The allowance should be a dollar amount, like 2.00.', field: 'tol' };
      out.tolCents = t;
    }
    if (r.tolPct !== undefined) {
      var tb = toBps(r.tolPct);
      if (tb === null || tb > 1000) return { error: 'The percentage allowance should be 0 to 10.', field: 'tolPct' };
      out.tolBps = tb;
    }
    if (r.keywords !== undefined) {
      if (!Array.isArray(r.keywords)) return { error: 'Keywords are a list.', field: 'keywords' };
      var kws = settingsOf({ keywords: r.keywords }).keywords;
      if (!kws.length) return { error: 'Keep at least one word that marks a card deposit.', field: 'keywords' };
      out.keywords = kws;
    }
    out.configured = true;
    return { settings: out };
  }

  function feeText(s) {
    s = settingsOf(s);
    return bpsText(s.feeBps) + (s.feeFixedCents ? ' + ' + (s.feeFixedCents < 100 ? s.feeFixedCents + '¢' : money(s.feeFixedCents)) : '');
  }
  function windowText(n) { return n === 1 ? 'next business day' : n + ' business days'; }

  /* ---------------- days and deposits ---------------- */

  function centsField(v, name, label, required) {
    if ((v === undefined || v === null || v === '') && !required) return { value: 0 };
    var c = toCents(v);
    if (c === null) return { error: label + ' should be an amount like 1,284.50.', field: name };
    if (c > LIMITS.maxCents) return { error: label + ' looks too large for one day.', field: name };
    return { value: c };
  }

  /**
   * A closed day, from the form: date, card sales, refunds, card tips, card
   * transactions. Amounts arrive as dollars (text or number) and leave as
   * cents. `today` bounds it: a day that has not happened cannot be closed.
   */
  function validateDay(raw, today) {
    var r = raw || {};
    var date = isoDay(r.date);
    if (!date) return { error: 'Which day is this? Pick a date.', field: 'date' };
    if (today && date > addDays(today, 1)) return { error: 'That day hasn’t happened yet.', field: 'date' };
    if (today && date < addDays(today, -LIMITS.days)) return { error: 'That’s more than 13 months ago - Tally keeps about a year.', field: 'date' };
    var g = centsField(r.gross, 'gross', 'Card sales', true);
    if (g.error) return g;
    var rf = centsField(r.refunds, 'refunds', 'Refunds', false);
    if (rf.error) return rf;
    var tp = centsField(r.tips, 'tips', 'Tips', false);
    if (tp.error) return tp;
    var tx = r.tx === undefined || r.tx === null || r.tx === '' ? null : Number(String(r.tx).replace(/,/g, ''));
    if (tx !== null && (!Number.isInteger(tx) || tx < 0 || tx > LIMITS.maxTx)) return { error: 'Transactions should be a whole number, like 96.', field: 'tx' };
    if (g.value > 0 && !tx) return { error: 'How many card transactions? It’s on the report as “count” or “#”.', field: 'tx' };
    if (rf.value > g.value + tp.value) return { error: 'Refunds are more than the day’s card sales - check the numbers.', field: 'refunds' };
    return {
      day: {
        date: date, grossCents: g.value, refundsCents: rf.value, tipsCents: tp.value, txCount: tx || 0,
        note: clean(r.note, LIMITS.note), source: r.source === 'snap' ? 'snap' : 'typed',
      },
    };
  }

  function validateDeposit(raw, today) {
    var r = raw || {};
    var date = isoDay(r.date);
    if (!date) return { error: 'When did it reach the bank? Pick a date.', field: 'date' };
    if (today && date > addDays(today, 1)) return { error: 'That date is in the future.', field: 'date' };
    var a = toCents(r.amount);
    if (a === null || a <= 0) return { error: 'The deposit should be an amount like 1,248.87.', field: 'amount' };
    if (a > LIMITS.maxCents) return { error: 'That deposit looks too large.', field: 'amount' };
    return { deposit: { date: date, amountCents: a, description: clean(r.description, LIMITS.description) || 'Card deposit', source: r.source === 'csv' ? 'csv' : 'typed' } };
  }

  /** The dedupe key for a deposit: the same date, amount and description. */
  function depositKey(d) {
    return d.date + '|' + d.amountCents + '|' + String(d.description || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
  }

  /** Which keyword (if any) marks this description as a card payout. */
  function processorOf(description, keywords) {
    var d = ' ' + String(description || '').toUpperCase().replace(/\s+/g, ' ') + ' ';
    var list = keywords || DEFAULT_KEYWORDS;
    for (var i = 0; i < list.length; i++) {
      var k = normKeyword(list[i]);
      if (!k) continue;
      // Whole words where the keyword starts and ends with a letter, so
      // "TOAST" is not "TOASTED BAGEL CO" and "SQUARE" is not "SQUAREFOOT".
      var esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*');
      var re = new RegExp((/^[A-Z0-9]/.test(k) ? '(^|[^A-Z0-9])' : '') + esc + (/[A-Z0-9]$/.test(k) ? '(?![A-Z0-9])' : ''));
      if (re.test(d)) return { keyword: k, label: KEYWORD_PROCESSOR[k] || 'Card deposit' };
    }
    return null;
  }

  /* ---------------- the fee model ---------------- */

  /**
   * What a closed day should put in the bank. Fees are charged on everything
   * that went through the card (sales + card tips); refunds come out of the
   * payout and - like most processors today - get no fee back.
   */
  function expected(day, settings) {
    var s = settingsOf(settings);
    var gross = day.grossCents || 0; var tips = day.tipsCents || 0; var refunds = day.refundsCents || 0; var tx = day.txCount || 0;
    var charged = gross + tips;
    var fee = charged > 0 ? Math.round(charged * s.feeBps / 10000) + tx * s.feeFixedCents : 0;
    var net = charged - refunds - fee;
    return { charged: charged, refunds: refunds, fee: fee, net: net, feeRate: charged > 0 ? fee / charged : 0 };
  }
  /** The last business day a day's money should arrive by. */
  function dueBy(date, settings) { return addBusinessDays(date, settingsOf(settings).windowDays); }
  /** How far under expected a deposit may be before it is short. */
  function tolerance(expectedCents, settings) {
    var s = settingsOf(settings);
    return Math.max(s.tolCents, Math.round(Math.abs(expectedCents) * s.tolBps / 10000));
  }
  // A fee this far above the model on a paid day is "higher than expected":
  // 0.15 percentage points of the volume, and at least a dollar.
  var FEE_HIGH_BPS = 15;
  var FEE_HIGH_MIN = 100;

  /* ---------------- matching ---------------- */

  var STATUS = {
    matched: { label: 'Matched', emoji: '✅', icon: '✓', bucket: 'green' },
    short: { label: 'Short', emoji: '⚠️', icon: '!', bucket: 'amber' },
    pending: { label: 'Pending', emoji: '⏳', icon: '…', bucket: 'grey' },
    missing: { label: 'Missing', emoji: '❌', icon: '×', bucket: 'red' },
    none: { label: 'Nothing due', emoji: '➖', icon: '–', bucket: 'zero' },
  };

  function depositOf(d) {
    return { id: String(d.id || ''), date: d.date, amountCents: d.amountCents, description: d.description || 'Card deposit', source: d.source || 'typed' };
  }

  /**
   * Match deposits to closed days.
   *
   * A day's money may arrive from the day itself up to its due date
   * (`windowDays` business days on, weekends and bank holidays skipped) -
   * or up to five business days after that, marked late. One deposit may
   * cover up to five CONSECUTIVE open days (Friday to Sunday, paid Monday).
   *
   *   pass 1  every deposit that lands within tolerance of some run of days
   *           claims the cheapest such run - exact matches first, so a short
   *           deposit can never take a day that has an exact one;
   *   pass 2  what is left goes to the closest remaining run, if it is within
   *           35% (a hold or a chargeback), else it stays unplaced;
   *   pass 3  two leftover deposits that together make a run exactly are
   *           one payout sent as two transfers; and a leftover that brings
   *           a short run back within tolerance joins it.
   *
   * Cost of a run: the relative difference, plus a little for each extra day,
   * a lot for a deposit dated the same day as the sales (rare: it is usually
   * yesterday's), and some for lateness.
   */
  function reconcile(days, deposits, settings, today) {
    var s = settingsOf(settings);
    var rows = (days || []).filter(function (d) { return d && isoDay(d.date); }).map(function (d) {
      var e = expected(d, s);
      return {
        date: d.date, grossCents: d.grossCents || 0, refundsCents: d.refundsCents || 0, tipsCents: d.tipsCents || 0, txCount: d.txCount || 0,
        source: d.source || 'typed', note: d.note || '',
        charged: e.charged, refunds: e.refunds, fee: e.fee, net: e.net, feeRate: e.feeRate,
        due: dueBy(d.date, s), status: null, group: null, paid: 0, shortfall: 0, actualFee: null, actualRate: null,
      };
    }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var deps = (deposits || []).filter(function (d) { return d && isoDay(d.date) && d.amountCents > 0; }).map(depositOf)
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.amountCents - b.amountCents) || (a.id < b.id ? -1 : 1); });
    var open = rows.filter(function (r) { return r.net > 0; });
    var taken = {};
    var used = {};
    var groups = [];

    function late(r) { return addBusinessDays(r.due, LIMITS.lateBusinessDays); }
    function options(dep) {
      var c = open.filter(function (r) { return !taken[r.date] && r.date <= dep.date && dep.date <= late(r); });
      var out = [];
      for (var i = 0; i < c.length; i++) {
        var exp = 0;
        for (var j = i; j < c.length && j < i + LIMITS.maxBatchDays; j++) {
          // Consecutive open days only: a run cannot skip a day that is
          // still waiting for its own money.
          if (j > i && open.indexOf(c[j]) !== open.indexOf(c[j - 1]) + 1) break;
          exp += c[j].net;
          var g = c.slice(i, j + 1);
          var diff = dep.amountCents - exp;
          var tol = tolerance(exp, s);
          var rel = Math.abs(diff) / exp;
          var lateDays = g.filter(function (r) { return dep.date > r.due; }).length;
          var sameDay = g[g.length - 1].date === dep.date;
          out.push({ rows: g, expected: exp, diff: diff, tol: tol, within: Math.abs(diff) <= tol, rel: rel,
            cost: rel + 0.004 * (g.length - 1) + (sameDay ? 0.25 : 0) + 0.02 * lateDays });
        }
      }
      return out.sort(function (a, b) { return a.cost - b.cost; });
    }
    function claim(dep, o) {
      used[dep.id + '|' + dep.date + '|' + dep.amountCents] = true;
      o.rows.forEach(function (r) { taken[r.date] = true; });
      groups.push({ rows: o.rows, deposits: [dep] });
    }
    var keyOf = function (d) { return d.id + '|' + d.date + '|' + d.amountCents; };

    deps.forEach(function (dep) {
      var best = options(dep).filter(function (o) { return o.within; })[0];
      if (best) claim(dep, best);
    });
    deps.forEach(function (dep) {
      if (used[keyOf(dep)]) return;
      var best = options(dep).filter(function (o) { return o.rel <= 0.35; })[0];
      if (best) claim(dep, best);
    });
    // Two leftovers that together make one run exactly: a payout the
    // processor sent as two transfers of about half each.
    var left = deps.filter(function (d) { return !used[keyOf(d)]; }).slice(0, 200);
    for (var a = 0; a < left.length; a++) {
      if (used[keyOf(left[a])]) continue;
      for (var z = a + 1; z < left.length; z++) {
        if (used[keyOf(left[z])] || used[keyOf(left[a])]) continue;
        var later = left[a].date > left[z].date ? left[a] : left[z];
        var both = { id: later.id, date: later.date, amountCents: left[a].amountCents + left[z].amountCents };
        var fit = options(both).filter(function (o) {
          return o.within && o.rows.every(function (r) { return r.date <= left[a].date && r.date <= left[z].date; });
        })[0];
        if (fit) {
          claim(left[a], fit);
          used[keyOf(left[z])] = true;
          groups[groups.length - 1].deposits.push(left[z]);
        }
      }
    }
    deps.forEach(function (dep) {
      if (used[keyOf(dep)]) return;
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        var exp = g.rows.reduce(function (a, r) { return a + r.net; }, 0);
        var paid = g.deposits.reduce(function (a, d) { return a + d.amountCents; }, 0);
        var fits = g.rows.every(function (r) { return r.date <= dep.date && dep.date <= late(r); });
        if (fits && paid < exp - tolerance(exp, s) && Math.abs(paid + dep.amountCents - exp) <= tolerance(exp, s)) {
          g.deposits.push(dep); used[keyOf(dep)] = true; return;
        }
      }
    });

    // Each run's verdict, and each day's share of what was paid (in whole
    // cents, in proportion to what it was owed; the last day takes the
    // rounding, so the shares add up to the deposit exactly).
    groups.sort(function (a, b) { return a.rows[0].date < b.rows[0].date ? -1 : 1; });
    groups = groups.map(function (g, gi) {
      var exp = 0; var charged = 0; var refunds = 0; var fee = 0;
      g.rows.forEach(function (r) { exp += r.net; charged += r.charged; refunds += r.refunds; fee += r.fee; });
      var paid = g.deposits.reduce(function (a, d) { return a + d.amountCents; }, 0);
      var tol = tolerance(exp, s);
      var diff = paid - exp;
      var status = diff < -tol ? 'short' : 'matched';
      var actualFee = charged - refunds - paid;
      var lastDep = g.deposits.reduce(function (a, d) { return d.date > a ? d.date : a; }, g.deposits[0].date);
      var out = {
        id: 'g' + gi, dates: g.rows.map(function (r) { return r.date; }), deposits: g.deposits,
        paidOn: lastDep, expected: exp, paid: paid, diff: diff, tol: tol, status: status,
        charged: charged, refunds: refunds, fee: fee, actualFee: actualFee,
        feeRate: charged ? fee / charged : 0, actualRate: charged ? actualFee / charged : 0,
        over: diff > tol,
        late: g.rows.some(function (r) { return lastDep > r.due; }),
        feeHigh: status === 'matched' && actualFee - fee > Math.max(FEE_HIGH_MIN, Math.round(charged * FEE_HIGH_BPS / 10000)),
      };
      var left = paid;
      g.rows.forEach(function (r, i) {
        var share = i === g.rows.length - 1 ? left : Math.floor(paid * r.net / exp);
        left -= share;
        r.status = status; r.group = out.id; r.paid = share;
        r.shortfall = status === 'short' ? Math.max(0, r.net - share) : 0;
        r.actualFee = r.charged - r.refunds - share;
        r.actualRate = r.charged ? r.actualFee / r.charged : null;
      });
      return out;
    });

    var lastDepositDate = deps.length ? deps[deps.length - 1].date : null;
    rows.forEach(function (r) {
      if (r.status) return;
      if (r.net <= 0) r.status = 'none';
      else r.status = today && today > r.due ? 'missing' : 'pending';
    });
    var unplaced = deps.filter(function (d) { return !used[keyOf(d)]; });
    return { rows: rows, groups: groups, unplaced: unplaced, settings: s, today: today || null, lastDepositDate: lastDepositDate };
  }

  function groupOf(result, row) {
    for (var i = 0; i < result.groups.length; i++) if (result.groups[i].id === row.group) return result.groups[i];
    return null;
  }
  function rowOf(result, date) {
    for (var i = 0; i < result.rows.length; i++) if (result.rows[i].date === date) return result.rows[i];
    return null;
  }

  function procName(s) { var p = preset(s.processor); return p.key === 'custom' ? 'your processor' : p.label; }

  /** Why a day is what it is, in plain words. */
  function explain(result, row) {
    var s = result.settings;
    var wd = weekday(row.date);
    var sales = money(row.grossCents);
    var what = sales + ' in card sales' + (row.tipsCents ? ' and ' + money(row.tipsCents) + ' in tips' : '');
    if (row.status === 'none') {
      if (!row.charged) return 'No card sales recorded, so nothing is owed.';
      return wd + '’s refunds and fees came to more than its card sales, so no deposit is due' + (row.net < 0 ? ' — ' + procName(s) + ' may take ' + money(-row.net) + ' back out of a later payout.' : '.');
    }
    var hol = holidaysBetween(row.date, row.due);
    var holText = hol.length ? ' (' + hol.map(function (h) { return h.name; }).join(', ') + ' pushes it back)' : '';
    if (row.status === 'pending') {
      return wd + '’s ' + what + ' should land by ' + dayLong(row.due) + holText + ': about ' + money(row.net) + ' after ' + (row.refundsCents ? 'refunds and ' : '') + 'fees. Nothing yet: that’s normal.';
    }
    if (row.status === 'missing') {
      var t = wd + '’s ' + what + ' should have landed by ' + dayLong(row.due) + holText + '; nothing yet. That’s ' + money(row.net) + ' missing, after ' + (row.refundsCents ? 'refunds and ' : '') + 'fees.';
      if (!result.lastDepositDate || result.lastDepositDate < row.due) {
        t += result.lastDepositDate ? ' Your newest deposit on file is from ' + monthDay(result.lastDepositDate) + ' — add newer bank lines first.' : ' Add your bank deposits and Tally will look for it.';
      } else {
        t += ' Check ' + procName(s) + '’s payouts for ' + monthDay(row.date) + ': a batch left open on the terminal is the usual cause.';
      }
      return t;
    }
    var g = groupOf(result, row);
    var others = g.dates.filter(function (d) { return d !== row.date; });
    var depText = g.deposits.length === 1 ? 'one ' + money(g.paid) + ' deposit' : g.deposits.length + ' deposits totalling ' + money(g.paid);
    if (row.status === 'short') {
      var who = others.length ? 'These ' + g.dates.length + ' days (' + g.dates.map(dayShort).join(', ') + ')' : wd + '’s ' + what;
      return who + ' should have brought ' + money(g.expected) + ' after fees. ' + (g.deposits.length === 1 ? 'The deposit on ' + dayLong(g.paidOn) + ' was ' : 'The deposits came to ') +
        money(g.paid) + ' — ' + money(-g.diff) + ' (' + pct(-g.diff / g.expected, 1) + ') short.' +
        ' A chargeback, a hold or a refund you didn’t record would explain it; ' + procName(s) + '’s payout report for ' + monthDay(g.dates[0]) + ' will say which.';
    }
    var feeBit = money(g.actualFee) + ' in fees (' + pct(g.actualRate) + ')';
    var t2 = others.length
      ? 'Paid together with ' + others.map(dayShort).join(' and ') + ': ' + depText + ' on ' + dayLong(g.paidOn) + ' for ' + g.dates.length + ' days of sales, after ' + feeBit + '.'
      : wd + '’s ' + what + ' landed ' + dayLong(g.paidOn) + ': ' + money(g.paid) + ' after ' + (g.refunds ? money(g.refunds) + ' in refunds and ' : '') + feeBit + '.';
    var hols = holidaysBetween(g.dates[0], g.paidOn);
    if (hols.length && !g.late) t2 += ' ' + hols.map(function (h) { return h.name; }).join(' and ') + ' pushed it to ' + weekday(g.paidOn) + '.';
    if (g.feeHigh) t2 += ' Your plan (' + feeText(s) + ') says about ' + money(g.fee) + ' (' + pct(g.feeRate) + '): ' + money(g.actualFee - g.fee) + ' more went to fees. Keep an eye on it.';
    else if (g.over) t2 += ' That’s ' + money(g.diff) + ' more than expected — were some tips or sales left off the report?';
    else t2 += ' Books balanced.';
    if (g.late) {
      var n = 0;
      for (var d = dueBy(g.dates[g.dates.length - 1], s); d < g.paidOn; d = addDays(d, 1)) if (isBusinessDay(addDays(d, 1))) n++;
      t2 += ' It came ' + plural(Math.max(1, n), 'business day') + ' later than usual.';
    }
    return t2;
  }

  /* ---------------- the month ---------------- */

  /** A day's colour on the calendar. No record is 'empty'. */
  function bucket(status) { return status && STATUS[status] ? STATUS[status].bucket : 'empty'; }

  /** Reconciled days in a row, counting back from the newest settled day.
   *  Pending days are skipped (not yet due is not a failure); a day with
   *  nothing owed counts as reconciled. */
  function streak(rows) {
    var list = (rows || []).filter(function (r) { return r.status !== 'pending'; });
    var best = 0; var run = 0;
    list.forEach(function (r) {
      if (r.status === 'matched' || r.status === 'none') { run++; if (run > best) best = run; } else run = 0;
    });
    var current = 0;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].status === 'matched' || list[i].status === 'none') current++; else break;
    }
    return { current: current, best: best };
  }

  /**
   * Fee creep: the effective rate on paid runs (short ones left out - their
   * gap is not a fee) split at the point where it rose most. Named only when
   * the later part is at least 0.15 points higher than the earlier AND above
   * the plan, over at least three runs each side.
   */
  function feeCreep(result) {
    var gs = result.groups.filter(function (g) { return g.status === 'matched' && g.charged > 0; });
    if (gs.length < 6) return null;
    function rate(list) {
      var f = 0; var c = 0;
      list.forEach(function (g) { f += g.actualFee; c += g.charged; });
      return c ? f / c : 0;
    }
    var best = null;
    for (var k = 3; k <= gs.length - 3; k++) {
      var before = rate(gs.slice(0, k)); var after = rate(gs.slice(k));
      if (!best || after - before > best.delta) best = { k: k, before: before, after: after, delta: after - before };
    }
    var plan = rate(gs.map(function (g) { return { actualFee: g.fee, charged: g.charged }; }));
    if (!best || best.delta < 0.0015 || best.after < plan + 0.001) return null;
    var tail = gs.slice(best.k);
    var charged = 0; var nDays = 0;
    tail.forEach(function (g) { charged += g.charged; nDays += g.dates.length; });
    return {
      fromRate: best.before, toRate: best.after, planRate: plan, since: tail[0].dates[0],
      monthlyCents: Math.round(best.delta * (charged / nDays) * 30),
    };
  }

  /**
   * The month view: a calendar (Sunday first), totals, counts, the streak and
   * the days needing a look. Money is summed over the days IN the month; a
   * deposit covering the 30th and the 1st is split between them by share.
   */
  function month(result, m) {
    var first = m + '-01';
    var days = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
    var byDate = {};
    result.rows.forEach(function (r) { if (monthOf(r.date) === m) byDate[r.date] = r; });
    var cells = [];
    for (var i = 0; i < days; i++) {
      var d = addDays(first, i);
      var r = byDate[d] || null;
      cells.push({ date: d, day: i + 1, status: r ? r.status : null, bucket: bucket(r ? r.status : null), charged: r ? r.charged : 0, future: result.today ? d > result.today : false });
    }
    var t = { sales: 0, refunds: 0, tips: 0, charged: 0, expected: 0, paid: 0, fees: 0, feeCharged: 0, unaccounted: 0, onTheWay: 0, days: 0 };
    var counts = { matched: 0, short: 0, pending: 0, missing: 0, none: 0 };
    var attention = [];
    Object.keys(byDate).forEach(function (d) {
      var r = byDate[d];
      t.days++; counts[r.status]++;
      t.sales += r.grossCents; t.refunds += r.refundsCents; t.tips += r.tipsCents; t.charged += r.charged;
      if (r.net > 0) t.expected += r.net;
      t.paid += r.paid;
      if (r.status === 'matched') { t.fees += r.actualFee; t.feeCharged += r.charged; }
      if (r.status === 'short') t.unaccounted += r.shortfall;
      if (r.status === 'missing') { t.unaccounted += r.net; }
      if (r.status === 'pending') t.onTheWay += r.net;
      if (r.status === 'short' || r.status === 'missing') attention.push(r);
    });
    t.feeRate = t.feeCharged ? t.fees / t.feeCharged : null;
    attention.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return {
      month: m, label: monthLabel(m), lead: dow(first), cells: cells, totals: t, counts: counts,
      attention: attention, streak: streak(result.rows), creep: feeCreep(result),
    };
  }

  /** Months that have a closed day, newest first. */
  function monthsOf(result) {
    var seen = {};
    result.rows.forEach(function (r) { seen[monthOf(r.date)] = 1; });
    return Object.keys(seen).sort().reverse();
  }

  /* ---------------- bank CSV in ---------------- */

  /** RFC 4180-ish: quoted fields, doubled quotes, CRLF, a leading BOM;
   *  semicolons or tabs when the header has no commas. */
  function parseCsv(text) {
    var s = String(text || '').replace(/^\uFEFF/, '');
    var firstLine = s.split(/\r?\n/, 1)[0] || '';
    var sep = firstLine.indexOf(',') < 0 ? (firstLine.indexOf(';') >= 0 ? ';' : firstLine.indexOf('\t') >= 0 ? '\t' : ',') : ',';
    var rows = []; var row = []; var field = ''; var q = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
      } else if (c === '"') q = true;
      else if (c === sep) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(function (f) { return f.trim() !== ''; })) rows.push(row);
        row = [];
        if (rows.length > LIMITS.csvRows + 20) break;
      } else field += c;
    }
    row.push(field);
    if (row.some(function (f) { return f.trim() !== ''; })) rows.push(row);
    return rows;
  }

  var hnorm = function (h) { return String(h || '').toLowerCase().replace(/[^a-z]/g, ''); };
  // Order is preference: the first match wins. For money INTO a bank account
  // the posting date is the day it arrived, so it beats the transaction date.
  var HEADERS = {
    date: ['postingdate', 'posteddate', 'postdate', 'date', 'transactiondate', 'transdate', 'effectivedate', 'bookingdate', 'valuedate'],
    description: ['description', 'transactiondescription', 'payee', 'name', 'memo', 'narrative', 'details', 'merchant'],
    amount: ['amount', 'transactionamount', 'amountusd', 'value'],
    credit: ['credit', 'credits', 'creditamount', 'deposit', 'deposits', 'depositscredits', 'moneyin', 'paidin'],
    debit: ['debit', 'debits', 'debitamount', 'withdrawal', 'withdrawals', 'withdrawalsdebits', 'moneyout', 'paidout'],
    type: ['details', 'type', 'transactiontype', 'creditdebit', 'drcr', 'creditordebit'],
  };
  function columns(header) {
    var h = header.map(hnorm);
    var out = {};
    var used = {};
    ['date', 'description', 'amount', 'credit', 'debit', 'type'].forEach(function (k) {
      for (var i = 0; i < HEADERS[k].length; i++) {
        var at = h.indexOf(HEADERS[k][i]);
        if (at >= 0 && !used[at]) { out[k] = at; used[at] = 1; break; }
      }
    });
    return out;
  }
  var SHORT_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  /** A bank's date: ISO, US month-first slashes, "Sep 15, 2026", "15 Sep 2026". */
  function parseDate(v) {
    var s = String(v || '').trim(); var m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(s))) return ymd(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
    if ((m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/.exec(s))) { var mo = SHORT_MONTHS.indexOf(m[1].toLowerCase()); return mo < 0 ? null : ymd(+m[3], mo + 1, +m[2]); }
    if ((m = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{4})/.exec(s))) { var mo2 = SHORT_MONTHS.indexOf(m[2].toLowerCase()); return mo2 < 0 ? null : ymd(+m[3], mo2 + 1, +m[1]); }
    return null;
  }
  var OUTFLOW_TYPE = /^(debit|dr|withdrawal|payment|check|fee|dbt)/i;

  /**
   * Money that came IN, from a bank's CSV. Returns
   * { rows: [{date, description, amountCents, processor, key}], skipped } or
   * { error }. Each row says whether its description names a card processor
   * (the keywords in settings); the page ticks those and leaves the rest.
   */
  function parseBankCsv(text, keywords) {
    if (typeof text !== 'string' || !text.trim()) return { error: 'That file is empty.' };
    if (text.length > LIMITS.csvBytes) return { error: 'That file is larger than a statement should be (2 MB). Download a shorter date range.' };
    var rows = parseCsv(text);
    var h = -1; var cols = null;
    // A few lines of account summary can sit above the real header.
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var c = columns(rows[i]);
      if (c.date != null && c.description != null && (c.amount != null || c.credit != null)) { h = i; cols = c; break; }
    }
    // Wells Fargo and some credit unions export no header: date, amount, two
    // reference columns, the description last. Recognised by shape.
    if (h < 0) {
      var probe = rows.slice(0, 3);
      if (probe.length && probe.every(function (r) { return r.length >= 3 && parseDate(r[0]) && toCents(r[1], true) !== null; })) {
        cols = { date: 0, amount: 1, description: rows[0].length - 1 };
      } else {
        return { error: 'This doesn’t look like a bank statement. Download the CSV from your bank’s website, with date, description and amount columns.' };
      }
    }
    var out = []; var seen = {};
    var skipped = { outflows: 0, unreadable: 0, duplicates: 0 };
    rows.slice(h + 1, h + 1 + LIMITS.csvRows).forEach(function (r) {
      var date = parseDate(r[cols.date]);
      var description = clean(r[cols.description], LIMITS.description);
      var cents = null;
      if (cols.credit != null && String(r[cols.credit] || '').trim() !== '') {
        var cr = toCents(r[cols.credit], true);
        cents = cr === null ? null : Math.abs(cr);
      } else if (cols.debit != null && String(r[cols.debit] || '').trim() !== '' && toCents(r[cols.debit], true)) {
        cents = -1;
      } else if (cols.amount != null) {
        cents = toCents(r[cols.amount], true);
        if (cents !== null && cols.type != null && OUTFLOW_TYPE.test(String(r[cols.type] || '').trim()) && cents > 0) cents = -cents;
      }
      if (!date || !description || cents === null) { skipped.unreadable++; return; }
      if (cents <= 0) { skipped.outflows++; return; }
      if (cents > LIMITS.maxCents) { skipped.unreadable++; return; }
      var row = { date: date, description: description, amountCents: cents };
      row.key = depositKey(row);
      if (seen[row.key]) { skipped.duplicates++; return; }
      seen[row.key] = 1;
      var p = processorOf(description, keywords);
      row.processor = p ? p.label : null;
      out.push(row);
    });
    out.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : b.amountCents - a.amountCents; });
    return { rows: out, skipped: skipped, cards: out.filter(function (x) { return x.processor; }).length };
  }

  /* ---------------- CSV out ---------------- */

  /**
   * One CSV cell. Text that a spreadsheet would run as a formula (= + - @,
   * tab, CR) gets a leading apostrophe; anything with a comma, quote or line
   * break is quoted. Numbers WE formatted (digits, one dot, maybe a minus)
   * are written as numbers - they never came from anyone's typing.
   */
  function csvCell(v, isNumber) {
    var s = String(v == null ? '' : v);
    if (!(isNumber && /^-?\d+(\.\d+)?$/.test(s)) && /^[=+\-@\t\r]/.test(s)) s = '\'' + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv(result, m) {
    var head = ['Date', 'Weekday', 'Card sales', 'Card tips', 'Refunds', 'Transactions', 'Expected fee (estimate)', 'Expected deposit', 'Deposited', 'Deposit date', 'Deposit description', 'Difference', 'Effective fee %', 'Status', 'Explanation'];
    var lines = [head.map(function (h) { return csvCell(h); }).join(',')];
    result.rows.filter(function (r) { return !m || monthOf(r.date) === m; }).forEach(function (r) {
      var g = groupOf(result, r);
      var settled = r.status === 'matched' || r.status === 'short';
      lines.push([
        csvCell(r.date), csvCell(weekday(r.date)), csvCell(plain(r.grossCents), true), csvCell(plain(r.tipsCents), true), csvCell(plain(r.refundsCents), true),
        csvCell(String(r.txCount), true), csvCell(plain(r.fee), true), csvCell(plain(Math.max(0, r.net)), true),
        csvCell(settled ? plain(r.paid) : '', true), csvCell(g ? g.paidOn : ''),
        csvCell(g ? g.deposits.map(function (d) { return d.description; }).join(' + ') : ''),
        csvCell(settled ? plain(r.paid - r.net) : '', true),
        csvCell(r.status === 'matched' && r.charged ? (r.actualRate * 100).toFixed(2) : '', true),
        csvCell(STATUS[r.status].label), csvCell(explain(result, r)),
      ].join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  return {
    LIMITS: LIMITS, PRESETS: PRESETS, DEFAULT_KEYWORDS: DEFAULT_KEYWORDS, DEFAULTS: DEFAULTS, STATUS: STATUS, WEEKDAYS: WEEKDAYS, MONTHS: MONTHS,
    clean: clean, toCents: toCents, money: money, money0: money0, moneyShort: moneyShort, plain: plain, pct: pct, bpsText: bpsText, toBps: toBps, plural: plural,
    isoDay: isoDay, isoMonth: isoMonth, addDays: addDays, daysBetween: daysBetween, dow: dow, weekday: weekday, monthOf: monthOf, addMonths: addMonths,
    monthLabel: monthLabel, dayShort: dayShort, dayLong: dayLong, monthDay: monthDay,
    holidays: holidays, holidayName: holidayName, isBusinessDay: isBusinessDay, addBusinessDays: addBusinessDays, holidaysBetween: holidaysBetween,
    preset: preset, settingsOf: settingsOf, validateSettings: validateSettings, feeText: feeText, windowText: windowText,
    validateDay: validateDay, validateDeposit: validateDeposit, depositKey: depositKey, processorOf: processorOf,
    expected: expected, dueBy: dueBy, tolerance: tolerance, reconcile: reconcile, explain: explain, rowOf: rowOf, groupOf: groupOf,
    bucket: bucket, streak: streak, feeCreep: feeCreep, month: month, monthsOf: monthsOf,
    parseCsv: parseCsv, parseDate: parseDate, parseBankCsv: parseBankCsv, csvCell: csvCell, exportCsv: exportCsv,
  };
});
