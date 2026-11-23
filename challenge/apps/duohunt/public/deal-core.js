/* Duo Hunt - "Check a deal": the rules both sides share. UMD: window.DealCore
 * in the page, require() on the server and in the tests.
 *
 * A model reads a pasted carrier offer into terms (lib/ai.js, one forced
 * tool). Everything after that happens here, with no model:
 *
 *   cleanText   what may be sent: bounded, control characters out, emails and
 *               phone-like numbers replaced before anything leaves;
 *   cleanTerms  what came back, untrusted: only the known fields, every
 *               number clamped AND found in the pasted text (a number the
 *               offer never wrote is dropped and named), every "catch" kept
 *               only if its quote is word for word in the pasted text;
 *   cost        the 36-month sum, in whole cents, with its working. The
 *               model never adds anything up.
 *
 * No clock, no storage, no network.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DealCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MONTHS = 36;
  var LIMITS = {
    text: 6000, minText: 40,
    credits: 6, fees: 6, catches: 8, unsure: 8,
    label: 80, condition: 160, catchText: 180, quote: 240, minQuote: 8,
    moneyMaxCents: 100000 * 100, monthsMax: 120,
  };
  var CREDIT_KINDS = ['bill_credit', 'instant', 'prepaid_card'];
  var FEE_KINDS = ['one_time', 'monthly'];

  // A made-up carrier and a made-up offer, written for this page. Not any
  // real company's wording or prices.
  var SAMPLE = [
    'Northwind Mobile - Fold Days offer',
    'Get the iPhone Duo 256GB for $0/mo. That is up to $1,999.80 off with an eligible trade-in.',
    'How it works: buy the iPhone Duo 256GB ($1,999.80) on a 36-month installment plan at $55.55/mo. Trade in an eligible phone and get $1,999.80 in bill credits, applied as $55.55/mo over 36 months. Credits start within 3 bill cycles.',
    'Requires the Unlimited Max plan: $90/mo for one line with AutoPay and paperless billing ($100/mo without).',
    '$35 activation fee due at sale. Sales tax on the full retail price is due at sale.',
    'If you cancel wireless service or pay off the device early, remaining credits stop and the remaining device balance is due.',
    'Trade-in must be an eligible phone in good working condition, sent back within 30 days.',
    'Northwind Mobile is a made-up carrier for this example.',
  ].join('\n');

  /** One line of plain text: no control or bidi characters, no markup brackets, bounded. */
  function clean(s, max) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
      .replace(/[<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max || 200);
  }
  /** Whitespace runs to one space: how a quote is compared with the text. */
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  /** The pasted offer, made safe to send. {text, redacted} or {error}. */
  function cleanText(raw) {
    if (typeof raw !== 'string') return { error: 'Paste the offer’s text first.' };
    if (raw.length > LIMITS.text * 2) return { error: 'That is too long. Paste just the offer and its fine print (up to ' + LIMITS.text.toLocaleString('en-US') + ' characters).' };
    var t = raw.replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    var before = t;
    // An offer needs no one's address or number: they never leave the page's server.
    t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email removed]')
      .replace(/(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, '[number removed]')
      .replace(/\b\d{9,}\b/g, '[number removed]');
    if (t.length > LIMITS.text) return { error: 'That is too long. Paste just the offer and its fine print (up to ' + LIMITS.text.toLocaleString('en-US') + ' characters).' };
    if (t.length < LIMITS.minText || !/\d/.test(t)) return { error: 'That doesn’t look like an offer yet. Paste the deal with its prices and fine print.' };
    return { text: t, redacted: t !== before };
  }

  /** Every number the text writes, in cents: "$1,999.80", "36", "$90". */
  function amountsIn(text) {
    var set = {};
    var re = /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/g, m;
    while ((m = re.exec(String(text || '')))) {
      var v = Math.round(parseFloat(m[0].replace(/,/g, '')) * 100);
      if (isFinite(v)) set[v] = true;
    }
    return set;
  }

  /** Dollars from the model -> whole cents, or null. */
  function toCents(v) {
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return null;
    var c = Math.round(v * 100);
    return c > LIMITS.moneyMaxCents ? null : c;
  }
  function toMonths(v) {
    if (typeof v !== 'number' || !isFinite(v) || Math.floor(v) !== v || v < 1 || v > LIMITS.monthsMax) return null;
    return v;
  }

  /** The quote as the text writes it, or '' when it is not word for word there. */
  function verifyQuote(quote, text) {
    var q = norm(clean(quote, LIMITS.quote * 2));
    if (q.length < LIMITS.minQuote || q.length > LIMITS.quote) return '';
    return norm(text).indexOf(q) >= 0 ? q : '';
  }

  /**
   * The model's answer -> terms a sum can be done on. `text` is exactly what
   * was sent. Returns {terms, catches, dropped} or {error}.
   */
  function cleanTerms(raw, text) {
    var r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var seen = amountsIn(text);
    var ungrounded = [];
    function money(v, name) {
      if (v === null || v === undefined) return null;
      var c = toCents(v);
      if (c === null) { ungrounded.push(name); return null; }
      if (!seen[c]) { ungrounded.push(name); return null; }
      return c;
    }
    function months(v, name) {
      if (v === null || v === undefined) return null;
      var n = toMonths(v);
      if (n === null || !seen[n * 100]) { ungrounded.push(name); return null; }
      return n;
    }
    var bool = function (v) { return v === true ? true : v === false ? false : null; };
    var list = function (v, max) { return (Array.isArray(v) ? v : []).filter(function (x) { return x && typeof x === 'object' && !Array.isArray(x); }).slice(0, max); };

    var terms = {
      deviceName: clean(r.device_name, LIMITS.label),
      devicePrice: money(r.device_price, 'the device price'),
      downPayment: money(r.down_payment, 'the down payment'),
      monthlyDevice: money(r.monthly_device_payment, 'the monthly device payment'),
      installmentMonths: months(r.installment_months, 'the installment length'),
      monthlyLine: money(r.monthly_line_cost, 'the monthly plan price'),
      monthlyLineWithout: money(r.line_cost_without_autopay, 'the plan price without AutoPay'),
      autopayRequired: bool(r.autopay_required),
      termMonths: months(r.term_months, 'the term'),
      tradeInRequired: bool(r.trade_in_required),
      tradeInNote: clean(r.trade_in_note, LIMITS.condition),
      credits: [],
      fees: [],
    };
    list(r.credits, LIMITS.credits).forEach(function (c, i) {
      var label = clean(c.label, LIMITS.label) || 'Credit';
      var name = 'a credit (' + label + ')';
      var out = {
        label: label,
        kind: CREDIT_KINDS.indexOf(c.kind) >= 0 ? c.kind : 'bill_credit',
        total: money(c.total, name),
        monthly: money(c.monthly, name),
        months: months(c.months, name),
        condition: clean(c.condition, LIMITS.condition),
      };
      // A credit with no amount the offer wrote is not a credit we can count.
      if (out.total === null && (out.monthly === null || out.months === null)) { if (ungrounded.indexOf(name) < 0) ungrounded.push(name); return; }
      terms.credits.push(out);
      void i;
    });
    list(r.fees, LIMITS.fees).forEach(function (f) {
      var label = clean(f.label, LIMITS.label) || 'Fee';
      var amount = money(f.amount, 'a fee (' + label + ')');
      if (amount === null) return;
      terms.fees.push({ label: label, kind: FEE_KINDS.indexOf(f.kind) >= 0 ? f.kind : 'one_time', amount: amount });
    });

    var catches = [], droppedCatches = 0, quotes = {};
    // Every catch offered is checked (a bounded number of them), so one that
    // fails is counted as dropped rather than silently cut; eight are kept.
    list(r.catches, LIMITS.catches * 3).forEach(function (c) {
      var t = clean(c.text, LIMITS.catchText);
      var q = verifyQuote(c.quote, text);
      if (!t || !q || quotes[q]) { droppedCatches++; return; }
      if (catches.length >= LIMITS.catches) return;
      quotes[q] = true;
      catches.push({ text: t, quote: q });
    });
    var unsure = (Array.isArray(r.unsure) ? r.unsure : []).map(function (u) { return clean(u, 60); }).filter(Boolean).slice(0, LIMITS.unsure);

    var hasNumbers = terms.devicePrice !== null || (terms.monthlyDevice !== null && terms.installmentMonths !== null) || terms.monthlyLine !== null || terms.credits.length > 0;
    if (!hasNumbers) return { error: 'Couldn’t find a deal’s prices in that. Paste the offer with its monthly price, the phone’s price and the fine print.' };
    return { terms: terms, catches: catches, unsure: unsure, dropped: { catches: droppedCatches, numbers: ungrounded.slice(0, 12) } };
  }

  /** "$1,999.80" from cents. */
  function usd(cents) {
    var neg = cents < 0, c = Math.abs(Math.round(cents));
    var whole = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var frac = String(c % 100);
    return (neg ? '-$' : '$') + whole + '.' + (frac.length < 2 ? '0' + frac : frac);
  }

  /**
   * The 36-month cost of cleaned terms, in whole cents, with its working.
   * Never throws; what is missing is named and left out of the sum.
   */
  function cost(terms) {
    var lines = [], missing = [], after = [];
    var device = null;
    if (terms.monthlyDevice !== null && terms.installmentMonths !== null) {
      var n = Math.min(terms.installmentMonths, MONTHS);
      var down = terms.downPayment || 0;
      device = down + terms.monthlyDevice * n;
      lines.push({ label: terms.deviceName || 'The phone', working: (down ? usd(down) + ' down + ' : '') + n + ' × ' + usd(terms.monthlyDevice), cents: device });
      if (terms.installmentMonths > MONTHS) {
        var left = terms.installmentMonths - MONTHS;
        after.push(left + ' more phone payments of ' + usd(terms.monthlyDevice) + ' (' + usd(left * terms.monthlyDevice) + ') come after month ' + MONTHS + '.');
      }
    } else if (terms.devicePrice !== null) {
      device = terms.devicePrice;
      lines.push({ label: terms.deviceName || 'The phone', working: 'full price', cents: device });
    } else missing.push('the phone’s price');

    var line = null;
    if (terms.monthlyLine !== null) {
      line = terms.monthlyLine * MONTHS;
      lines.push({ label: 'The plan', working: MONTHS + ' × ' + usd(terms.monthlyLine), cents: line });
    } else missing.push('the monthly plan price');

    var fees = 0;
    terms.fees.forEach(function (f) {
      var c = f.kind === 'monthly' ? f.amount * MONTHS : f.amount;
      fees += c;
      lines.push({ label: f.label, working: f.kind === 'monthly' ? MONTHS + ' × ' + usd(f.amount) : 'once', cents: c });
    });

    var conditional = 0, credits = 0;
    terms.credits.forEach(function (c) {
      var amt, working;
      if (c.monthly !== null && c.months !== null) {
        var m = Math.min(c.months, MONTHS);
        amt = c.monthly * m; working = m + ' × ' + usd(c.monthly);
      } else if (c.months !== null && c.months > MONTHS) {
        amt = Math.round(c.total * MONTHS / c.months); working = MONTHS + ' of ' + c.months + ' months of ' + usd(c.total);
        after.push(usd(c.total - amt) + ' of “' + c.label + '” arrives after month ' + MONTHS + '.');
      } else { amt = c.total; working = c.kind === 'bill_credit' ? 'over the term' : 'once'; }
      credits += amt;
      if (c.kind === 'bill_credit') conditional += amt;
      lines.push({ label: c.label, working: working, cents: -amt, credit: true, condition: c.condition });
    });

    var gross = (device || 0) + (line || 0) + fees;
    var total = Math.max(0, gross - credits);
    // If the conditions are missed: monthly bill credits stop, and the plan
    // is the price without AutoPay when the offer states one.
    var lineMissed = terms.monthlyLineWithout !== null && terms.monthlyLineWithout > (terms.monthlyLine || 0) ? terms.monthlyLineWithout * MONTHS : (line || 0);
    var missed = Math.max(0, (device || 0) + lineMissed + fees - (credits - conditional));
    return {
      months: MONTHS,
      lines: lines,
      totalCents: total,
      perMonthCents: Math.round(total / MONTHS),
      ifMissedCents: missed > total ? missed : null,
      missing: missing,
      complete: missing.length === 0,
      after: after,
    };
  }

  return {
    MONTHS: MONTHS, LIMITS: LIMITS, CREDIT_KINDS: CREDIT_KINDS, FEE_KINDS: FEE_KINDS, SAMPLE: SAMPLE,
    clean: clean, norm: norm, cleanText: cleanText, amountsIn: amountsIn, verifyQuote: verifyQuote,
    cleanTerms: cleanTerms, cost: cost, usd: usd,
  };
}));
