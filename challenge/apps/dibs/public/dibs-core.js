/* Dibs - the rules. One file, run twice: the page loads it as
 * window.DibsCore, the server and the tests `require` it, so the numbers a
 * guest sees on their phone are the numbers the host sees and the numbers the
 * tests check.
 *
 * Money is integer cents everywhere. Typed money is read from its digits
 * (toCents), never through a float. Percentages are basis points (2000 =
 * 20%). Every split is allocated with the largest-remainder method, so the
 * cents always add up to exactly the bill - nobody is a penny short and
 * nobody pays a penny extra.
 *
 * What is here: reading a pasted receipt (parseReceipt), cleaning a bill from
 * anywhere (cleanBill - a model, a phone, localStorage), the totals and the
 * check against the printed total, the split (who had what, and their fair
 * share of tax, tip, fees and discounts), the fairness line, pay links and
 * the group-chat summary. Nothing here touches the network or the clock.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DibsCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    items: 120,           // lines on one bill
    qty: 99,              // units on one line
    unitMax: 1000000,     // $10,000 for one unit
    billMax: 10000000,    // $100,000 for the whole bill
    name: 60,             // an item's name
    title: 60,
    people: 20,           // everyone at one table, the host included
    personName: 20,
    weight: 99,           // the most shares (or units) one person can take of one line
    fees: 10,
    discounts: 10,
    tipMaxBp: 10000,      // 100% - a typo guard, not a judgement
    paste: 20000,         // characters of pasted receipt text
    photos: 2,
  };

  var CURRENCIES = { USD: '$', CAD: '$', AUD: '$', GBP: '£', EUR: '€' };

  // Person colours. Each carries white text at 4.5:1 or better (checked in
  // the tests), and they are far enough apart to tell at a glance. A colour
  // is never the only way to tell people apart: every chip has the name.
  var COLORS = [
    { id: 'tomato', hex: '#c0352b', label: 'Tomato' },
    { id: 'ocean', hex: '#1f5fbf', label: 'Ocean' },
    { id: 'basil', hex: '#1d7a45', label: 'Basil' },
    { id: 'grape', hex: '#6b3fc4', label: 'Grape' },
    { id: 'amber', hex: '#9a5b00', label: 'Amber' },
    { id: 'berry', hex: '#b0206d', label: 'Berry' },
    { id: 'teal', hex: '#0d7275', label: 'Teal' },
    { id: 'slate', hex: '#4a5568', label: 'Slate' },
    { id: 'rust', hex: '#a3431a', label: 'Rust' },
    { id: 'indigo', hex: '#3b4bb0', label: 'Indigo' },
    { id: 'olive', hex: '#5a6b12', label: 'Olive' },
    { id: 'plum', hex: '#8a2f86', label: 'Plum' },
  ];
  var COLOR_IDS = COLORS.map(function (c) { return c.id; });
  function colorHex(id) { for (var i = 0; i < COLORS.length; i++) if (COLORS[i].id === id) return COLORS[i].hex; return COLORS[0].hex; }

  var ID_RE = /^[a-z0-9]{4,16}$/;

  /* ------------------------------------------------------------------ *
   * Text
   * ------------------------------------------------------------------ */

  // Control characters, zero-width marks and bidi overrides are removed from
  // anything typed or read: a name like "‮Sam" would draw backwards in every
  // guest's list. The zero-width JOINER (U+200D) stays - family and
  // skin-tone emoji are built from it, and "first name or emoji" is allowed.
  var STRIP = /[\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁠-⁩﻿]/g;

  /** One line of untrusted text: no markup, no control or bidi characters,
   *  one space between words, at most `max` characters (cut on a whole
   *  character, never half an emoji). The input is cut BEFORE any pattern
   *  runs, and the tag pattern stops at the next "<", so a hostile string
   *  costs linear time. */
  function clean(v, max) {
    var s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 200) s = s.slice(0, max * 4 + 200);
    s = s.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    var chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
    return s;
  }
  /** A person's name: first name or emoji, max 20 characters. */
  function cleanName(v) {
    var s = clean(v, LIMITS.personName);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  function oneOf(v, list, dflt) { return list.indexOf(v) >= 0 ? v : dflt; }

  /** "LUIGI'S TRATTORIA" -> "Luigi's Trattoria"; mixed case is left alone. */
  // Words that stay in capitals when an ALL-CAPS receipt is tidied.
  var KEEP_CAPS = ['IPA', 'DIPA', 'BLT', 'BBQ', 'NY', 'NYC', 'OJ', 'XL', 'XXL', 'LG', 'SM', 'MD', 'NA', 'GF', 'VG', 'DJ', 'TV', 'USA', 'UK'];
  function tidyCase(s) {
    if (!/[A-Z]{2}/.test(s) || /[a-z]/.test(s)) return s;
    return s.toLowerCase().replace(/(^|[\s(/&-])(\p{L}[\p{L}']*)/gu, function (m, a, w) {
      return a + (KEEP_CAPS.indexOf(w.toUpperCase()) >= 0 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1));
    });
  }

  /* ------------------------------------------------------------------ *
   * Money
   * ------------------------------------------------------------------ */

  /**
   * Typed money as whole cents, read from its digits: "$1,240.50", "12.5",
   * "12", "12,50", "£3", "45¢" all read. Anything without a digit is no
   * figure (null) - "free" is never $0.00. Negatives are refused unless
   * `negative` is set (a discount line), and then "-4.00", "(4.00)" and
   * "4.00-" all read as -400.
   */
  function toCents(v, opts) {
    var allowNeg = Boolean(opts && opts.negative);
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      v = v.toFixed(3);
    }
    if (typeof v !== 'string') return null;
    var s = v.trim().toLowerCase();
    if (!/\d/.test(s) || s.length > 40) return null;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    if (/-$/.test(s)) { neg = true; s = s.slice(0, -1).trim(); }
    if (/^[-−–]/.test(s)) { neg = true; s = s.slice(1).trim(); }
    s = s.replace(/^(usd|us\$|cad|c\$|aud|a\$|gbp|eur)\s*/, '').replace(/\s*(usd|cad|aud|gbp|eur|each|ea\.?)$/, '');
    s = s.replace(/^[$£€]\s*/, '').replace(/\s*[$£€]$/, '');
    if (/^[-−–]/.test(s)) { neg = true; s = s.slice(1).trim(); }
    var centsMark = /^(\d+)\s*(¢|c)$/.exec(s);
    var cents;
    if (centsMark) cents = Number(centsMark[1]);
    else {
      if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
      else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
      if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
      var parts = s.split('.');
      var whole = parts[0] || '0';
      var frac = (parts[1] || '') + '000';
      if (whole.replace(/^0+/, '').length > 8) return null;
      cents = Number(whole) * 100 + Number(frac.slice(0, 2)) + (Number(frac.charAt(2)) >= 5 ? 1 : 0);
    }
    if (!isFinite(cents) || cents > LIMITS.billMax) return null;
    if (neg) { if (!allowNeg) return null; return cents === 0 ? 0 : -cents; }
    return cents;
  }

  /** A typed percentage as basis points: "20", "20%", "18.5 %", 20 -> 2000. */
  function toBp(v) {
    if (typeof v === 'number') v = isFinite(v) && v >= 0 ? v.toFixed(4) : '';
    if (typeof v !== 'string') return null;
    var s = v.trim().replace(/\s*%$/, '');
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
    var parts = s.split('.');
    var frac = (parts[1] || '') + '000';
    if (parts[0].length > 5) return null;
    return Number(parts[0] || '0') * 100 + Number(frac.slice(0, 2)) + (Number(frac.charAt(2)) >= 5 ? 1 : 0);
  }

  function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function symbolOf(cur) { return CURRENCIES[cur] || '$'; }
  /** 124050 -> "$1,240.50"; -200 -> "−$2.00". */
  function money(c, cur) {
    var n = Number(c) || 0;
    var neg = n < 0;
    n = Math.abs(Math.round(n));
    return (neg ? '−' : '') + symbolOf(cur) + groups(Math.floor(n / 100)) + '.' + String(n % 100).padStart(2, '0');
  }
  /** 2347 -> "23.47", for a pay link. */
  function plain(c) { var n = Math.max(0, Math.round(Number(c) || 0)); return Math.floor(n / 100) + '.' + String(n % 100).padStart(2, '0'); }
  function bpText(bp) { var n = Math.round(bp); return (n % 100 ? (n / 100).toFixed(n % 10 ? 2 : 1) : String(n / 100)) + '%'; }

  /** round(a * b / c) for non-negative integers, half up, exact (BigInt). */
  function mulDiv(a, b, c) {
    if (!c) return 0;
    var A = BigInt(Math.round(a)), B = BigInt(Math.round(b)), C = BigInt(Math.round(c));
    var neg = (A < 0n) !== (B < 0n);
    if (A < 0n) A = -A;
    if (B < 0n) B = -B;
    var q = (A * B * 2n + C) / (2n * C);
    return Number(neg ? -q : q);
  }

  /**
   * Split `total` cents by `weights` so the parts add up to exactly `total`:
   * everyone gets the floor of their exact share, and the cents left over go
   * one each to the largest remainders. Ties go to the larger weight, then to
   * the earlier position - deterministic, so every phone agrees. All-zero
   * weights split evenly. A negative total (a discount) is split as its size.
   */
  function allocate(total, weights) {
    var n = weights.length;
    var out = new Array(n).fill(0);
    total = Math.round(Number(total) || 0);
    if (!n || !total) return out;
    var neg = total < 0;
    var T = BigInt(Math.abs(total));
    var w = weights.map(function (x) { return x > 0 ? BigInt(Math.round(x)) : 0n; });
    var sum = w.reduce(function (a, b) { return a + b; }, 0n);
    if (sum === 0n) { w = w.map(function () { return 1n; }); sum = BigInt(n); }
    var given = 0n;
    var rems = [];
    for (var i = 0; i < n; i++) {
      var exact = T * w[i];
      var base = exact / sum;
      out[i] = base;
      given += base;
      rems.push({ i: i, r: exact % sum, w: w[i] });
    }
    var left = T - given;
    rems.sort(function (a, b) {
      if (a.r !== b.r) return a.r > b.r ? -1 : 1;
      if (a.w !== b.w) return a.w > b.w ? -1 : 1;
      return a.i - b.i;
    });
    for (var k = 0; k < rems.length && left > 0n; k++) {
      if (rems[k].w === 0n) continue;
      out[rems[k].i] += 1n;
      left -= 1n;
    }
    return out.map(function (x) { return neg ? -Number(x) : Number(x); });
  }

  /* ------------------------------------------------------------------ *
   * Reading a pasted receipt - deterministic and free
   * ------------------------------------------------------------------ */

  var UNIT_WORDS = /^(oz|fl|g|gr|kg|lb|lbs|ml|cl|l|ltr|in|inch|pc|pcs|piece|pieces|pk|pack|%|cm|mm|yr|year|years|day|days|min|mins|hr|hrs)\b/i;

  // Lines that are not part of the bill. Each has a reason, so "Skipped 6
  // lines" can say what they were.
  var JUNK = [
    { why: 'card or payment', re: /(\*{2,}|x{3,}|#{3,})\s*\d{2,4}\b|\b(visa|mastercard|master card|amex|american express|discover|debit|credit card|contactless|chip read|swiped|auth(orization)?( code)?|approval|approved|aid\b|entry method|card ?#|acct|account)\b|\b(cash|change|change due|tendered|payment|paid)\b/i },
    { why: 'staff', re: /\b(server|served by|cashier|waiter|waitress|bartender|employee|emp)\b\s*[:#]?/i },
    { why: 'order details', re: /\b(table|tbl|guests?|covers?|party of|check|chk|order|ticket|receipt|invoice|trans(action)?|terminal|merchant|store|station|ref(erence)?|seq|batch|reg(ister)?)\b\s*(no\.?|number|#|:|id)?\s*#?\s*\d/i },
    { why: 'suggested tip', re: /\b(suggested|tip guide|gratuity guide|tip calculation|for your convenience)\b|^\s*\d{1,2}(\.\d+)?\s*%\s*(tip|gratuity)?\s*[:=(-]?\s*[$£€]?\s*\d/i },
    { why: 'tax already included', re: /\b(incl\.?|included|including|inclusive)\b/i },
    { why: 'website or message', re: /thank|come again|visit us|see you|www\.|https?:|\.com\b|survey|feedback|follow us|review us|@[a-z]/i },
    { why: 'phone number', re: /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/ },
  ];
  var DATE_RE = /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?,?\s+\d{4}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}\b/gi;

  /** One whitespace token as money: {cents, neg, mark} or null.
   *  `bare` lets a plain whole number ("15") count, for the last token. */
  function moneyToken(tok, bare) {
    var t = String(tok);
    var neg = false;
    var mark = false;
    if (/\d\.?\d[A-Z]$/.test(t)) t = t.slice(0, -1); // a tax flag glued on: "4.50T"
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    if (t.length > 1 && /[-−]$/.test(t)) { neg = true; t = t.slice(0, -1); }
    if (/^[-−–]/.test(t)) { neg = true; t = t.slice(1); }
    if (/^(usd|us\$)/i.test(t)) { t = t.replace(/^(usd|us\$)/i, ''); mark = true; }
    if (/^[$£€]/.test(t)) { t = t.slice(1); mark = true; }
    if (/[$£€]$/.test(t)) { t = t.slice(0, -1); mark = true; }
    if (/^[-−]/.test(t)) { neg = true; t = t.slice(1); }
    var cents = null;
    if (/^\d{1,3}(,\d{3})+\.\d{2}$/.test(t) || /^\d{1,6}\.\d{2}$/.test(t)) cents = toCents(t);
    else if (/^\d{1,6},\d{2}$/.test(t)) cents = toCents(t.replace(',', '.'));
    else if (mark && /^(\d{1,3}(,\d{3})+|\d{1,5})$/.test(t)) cents = toCents(t);
    else if (bare && /^\d{1,4}$/.test(t)) cents = toCents(t);
    if (cents === null) return null;
    return { cents: cents, neg: neg, mark: mark };
  }

  /** Split a label into {qty, name, unit} from its own words: "2 x
   *  Margarita", "Margarita x2", "2 Margarita", "2 @ 12.00 Margarita",
   *  "Margarita 2 @ 12.00", "Margarita 2 12.00". */
  function readQty(label, lineCents) {
    var s = label.trim();
    var qty = 1, unit = null, explicit = false, m;
    // An "@ unit price" anywhere: "2 @ 12.00", "@12.00", "2@$12".
    m = /(?:^|\s)(\d{1,2})?\s*@\s*(\S+)/.exec(s);
    if (m) {
      var u = moneyToken(m[2], true);
      if (u && u.cents > 0) {
        unit = u.cents;
        if (m[1]) { qty = Number(m[1]); explicit = true; }
        s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
      }
    }
    if ((m = /^(\d{1,2})\s*(?:x|×)\s*(?=\S)(.+)$/i.exec(s)) && /\p{L}/u.test(m[2])) { qty = Number(m[1]); s = m[2]; explicit = true; }
    else if ((m = /^(?:x|×)\s?(\d{1,2})\s+(.+)$/i.exec(s))) { qty = Number(m[1]); s = m[2]; explicit = true; }
    else if ((m = /^(.+?)\s*\(?(?:x|×)\s?(\d{1,2})\)?$/i.exec(s)) && /\p{L}/u.test(m[1])) { qty = Number(m[2]); s = m[1]; explicit = true; }
    else if ((m = /^(\d{1,2})\s+(.+)$/.exec(s)) && /^\p{L}/u.test(m[2]) && !UNIT_WORDS.test(m[2]) && !explicit) {
      // A bare leading count: "2 Margarita". Up to 5 only - "12 Wings" is
      // one order of twelve, not twelve orders.
      if (Number(m[1]) >= 1 && Number(m[1]) <= 5) { qty = Number(m[1]); s = m[2]; explicit = qty > 1; }
    }
    // Trailing columns: "Margarita 2 12.00" (count and unit price before the
    // line total) or "Margarita 12.00" (unit price, then the total).
    if (unit === null) {
      var toks = s.split(' ');
      var last = toks.length > 1 ? moneyToken(toks[toks.length - 1], false) : null;
      if (last && !last.neg && last.cents > 0) {
        var before = toks.length > 2 && /^\d{1,2}$/.test(toks[toks.length - 2]) ? Number(toks[toks.length - 2]) : null;
        if (before && before * last.cents === lineCents) { qty = before; unit = last.cents; s = toks.slice(0, -2).join(' '); explicit = true; }
        else if (lineCents % last.cents === 0 && lineCents / last.cents <= 50) { qty = lineCents / last.cents; unit = last.cents; s = toks.slice(0, -1).join(' '); explicit = qty > 1; }
      } else if (toks.length > 1 && /^\d{1,2}$/.test(toks[toks.length - 1]) && qty === 1) {
        // "Coke 2" as a column: a count, when it divides the line.
        var c = Number(toks[toks.length - 1]);
        if (c >= 2 && c <= 20 && lineCents % c === 0) { qty = c; s = toks.slice(0, -1).join(' '); explicit = true; }
      }
    }
    if (qty < 1 || qty > LIMITS.qty) { qty = 1; }
    if (unit === null) {
      if (qty > 1 && lineCents % qty === 0) unit = lineCents / qty;
      else if (qty > 1) { s = s + ' (' + qty + ')'; qty = 1; unit = lineCents; }
      else unit = lineCents;
    } else if (lineCents !== null && unit * qty !== lineCents && lineCents > 0) {
      // "2 @ 12.00 ... 25.00": the printed total wins; the count stays only
      // if it divides it.
      if (lineCents % qty === 0) unit = lineCents / qty;
      else { s = s + ' (' + qty + ')'; qty = 1; unit = lineCents; }
    }
    return { qty: qty, unit: unit, name: s, explicit: explicit };
  }

  function classify(label) {
    var l = label.toLowerCase();
    if (/\bsub\s*-?\s*total\b|\bsubtl\b|\bsub-tot\b|\bnet total\b|\bitems? total\b|\bfood (and|&) (bev|drink)/.test(l)) return 'subtotal';
    if (/\b(service charge|service fee|svc|srv chg|serv\.? chg|auto(matic)?\s*-?\s*grat(uity)?|gratuity|grat\.?|service)\b/.test(l)) return 'service';
    if (/^\W*(tip|tips)\b/.test(l)) return 'tip';
    if (/\b(sales tax|tax|hst|gst|pst|qst|vat|state tax|city tax|local tax)\b/.test(l)) return 'tax';
    if (/\b(grand total|total due|amount due|balance due|totale?|totaal|gesamt|amount|to pay|due)\b/.test(l)) return 'total';
    if (/\b(discount|disc\b|coupon|promo|voucher|savings|reward|loyalty|comp|comped|% off|off\b)/.test(l)) return 'discount';
    if (/\b(fee|surcharge|delivery|mandate|health|kitchen appreciation|corkage|cover charge|bag|packaging|container|convenience|booking|small order)\b/.test(l)) return 'fee';
    return 'item';
  }

  /** A readable percentage in a label: "Service charge 20%" -> 2000. */
  function rateIn(label) {
    var m = /(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(label);
    return m ? toBp(m[1]) : null;
  }

  var shortId = (function () {
    var n = 0;
    return function (prefix) { n = (n + 1) % 1e6; return (prefix || 'i') + n.toString(36) + Math.floor(Math.random() * 1e9).toString(36).padStart(6, '0').slice(0, 6); };
  }());

  /**
   * Read the text of a receipt, as pasted or typed. Returns {title,
   * currency, items, tax, tip, fees, discounts, subtotal, total, skipped}.
   * `skipped` lists every line it did not use and why - nothing disappears
   * silently. Totals are what is PRINTED; nothing is made to add up.
   */
  function parseReceipt(text) {
    var src = String(text == null ? '' : text).slice(0, LIMITS.paste);
    var out = { title: '', currency: 'USD', items: [], tax: 0, tip: null, fees: [], discounts: [], subtotal: null, total: null, skipped: [] };
    if (/£/.test(src)) out.currency = 'GBP';
    else if (/€/.test(src)) out.currency = 'EUR';
    var rows = src.replace(/\r\n?/g, '\n').split('\n').slice(0, 400);
    var seenPrice = false;
    var taxSeen = false;
    for (var r = 0; r < rows.length; r++) {
      var raw = clean(rows[r], 200);
      if (!raw) continue;
      if (!/[\p{L}\p{N}]/u.test(raw)) continue; // "------", "*****": decoration
      var line = raw.replace(/\.{2,}|·{2,}|_{2,}|-{3,}|={2,}|…/g, ' ').replace(/\s+/g, ' ').trim();
      var skipWhy = null;
      for (var j = 0; j < JUNK.length; j++) if (JUNK[j].re.test(line)) { skipWhy = JUNK[j].why; break; }
      // A card or payment word can sit on a real total line ("Total due
      // (Visa) 142.60") - that one is still the total. Staff and order lines
      // never are.
      var noDates = line.replace(DATE_RE, ' ').replace(/\s+/g, ' ').trim();
      // Merge "$ 12.00" and "- 4.00" into one token.
      var toks = noDates.replace(/([$£€]|-|−)\s+(?=\d)/g, '$1').split(' ').filter(Boolean);
      var end = toks.length - 1;
      if (end > 0 && /^([A-Z]{1,2}|\*|[A-Z]\*|\*[A-Z])$/.test(toks[end])) end--; // tax flag: "15.00 T"
      var amt = end >= 0 ? moneyToken(toks[end], end > 0 && /\p{L}{2,}/u.test(toks.slice(0, end).join(' '))) : null;
      if (!amt) {
        if (!seenPrice && !out.title && !skipWhy && noDates === line && /\p{L}{3,}/u.test(line) && line.length <= 40 && !/\d{3,}/.test(line)) {
          out.title = tidyCase(line);
          continue;
        }
        out.skipped.push({ line: raw, why: skipWhy || (noDates !== line && !/\p{L}{3,}/u.test(noDates) ? 'date or time' : 'no price') });
        continue;
      }
      var label = toks.slice(0, end).join(' ').replace(/[:=]+$/, '').replace(/^[#*•\-]+\s*/, '').trim();
      var kind = classify(label);
      if (skipWhy && !(skipWhy === 'card or payment' && kind === 'total' && !/\b(change|tendered|cash)\b/i.test(label))) {
        out.skipped.push({ line: raw, why: skipWhy });
        continue;
      }
      if (!/\p{L}/u.test(label)) { out.skipped.push({ line: raw, why: 'no name' }); continue; }
      var cents = amt.neg ? -amt.cents : amt.cents;
      seenPrice = true;
      if (kind === 'subtotal') { if (out.subtotal === null) out.subtotal = cents; else out.skipped.push({ line: raw, why: 'another subtotal' }); continue; }
      if (kind === 'total') { if (out.total === null) out.total = cents; else out.skipped.push({ line: raw, why: 'another total' }); continue; }
      if (kind === 'tax') { if (cents > 0) { out.tax += cents; taxSeen = true; } else out.skipped.push({ line: raw, why: 'no charge' }); continue; }
      if (kind === 'tip') { if (cents > 0) out.tip = cents; else out.skipped.push({ line: raw, why: 'no charge' }); continue; }
      if (cents < 0 || kind === 'discount') {
        if (cents !== 0) out.discounts.push({ id: shortId('d'), name: tidyCase(clean(label, LIMITS.name)) || 'Discount', cents: Math.abs(cents) });
        else out.skipped.push({ line: raw, why: 'no charge' });
        continue;
      }
      if (kind === 'service' || kind === 'fee') {
        if (cents > 0) out.fees.push({ id: shortId('f'), name: tidyCase(clean(label, LIMITS.name)), cents: cents, service: kind === 'service', rateBp: kind === 'service' ? rateIn(label) : null });
        else out.skipped.push({ line: raw, why: 'no charge' });
        continue;
      }
      if (cents === 0) { out.skipped.push({ line: raw, why: 'no charge' }); continue; }
      if (out.items.length >= LIMITS.items) { out.skipped.push({ line: raw, why: 'too many lines' }); continue; }
      var q = readQty(label, cents);
      var name = tidyCase(clean(q.name, LIMITS.name));
      if (!name || !/\p{L}/u.test(name)) { out.skipped.push({ line: raw, why: 'no name' }); continue; }
      if (q.unit > LIMITS.unitMax) { out.skipped.push({ line: raw, why: 'price too large' }); continue; }
      out.items.push({ id: shortId('i'), name: name, unit: q.unit, qty: q.qty });
    }
    void taxSeen;
    return out;
  }

  /** A parsed (or snapped) receipt as a bill: the printed tip becomes an
   *  amount, and a service charge on the bill sets the tip to nothing. */
  function billFromParsed(p, base) {
    var b = cleanBill(base || {});
    b.title = clean(p.title, LIMITS.title) || b.title;
    b.currency = CURRENCIES[p.currency] ? p.currency : b.currency;
    b.items = (p.items || []).slice(0, LIMITS.items);
    b.tax = Math.max(0, p.tax || 0);
    b.fees = (p.fees || []).slice(0, LIMITS.fees);
    b.discounts = (p.discounts || []).slice(0, LIMITS.discounts);
    b.printed = { subtotal: p.subtotal == null ? null : p.subtotal, total: p.total == null ? null : p.total };
    if (p.tip) b.tip = { mode: 'amount', bp: b.tip.bp, cents: p.tip, base: b.tip.base, even: b.tip.even, onReceipt: true };
    else if (b.fees.some(function (f) { return f.service; })) b.tip = { mode: 'amount', bp: b.tip.bp, cents: 0, base: b.tip.base, even: b.tip.even, onReceipt: false };
    return cleanBill(b);
  }

  /* ------------------------------------------------------------------ *
   * The bill
   * ------------------------------------------------------------------ */

  function blankBill() {
    return {
      title: '', currency: 'USD', items: [], tax: 0,
      tip: { mode: 'percent', bp: 2000, cents: 0, base: 'subtotal', even: false, onReceipt: false },
      fees: [], discounts: [], printed: { subtotal: null, total: null },
      payerId: null, handles: { venmo: '', cashapp: '', paypal: '' },
    };
  }

  function centsOr(v, dflt, opts) {
    if (typeof v === 'number' && isFinite(v) && Math.floor(v) === v) return v;
    var c = toCents(v, opts);
    return c === null ? dflt : c;
  }

  /** Any bill-shaped thing -> a clean bill. Used on everything: a model's
   *  answer, a phone's PUT, localStorage. Bad fields become defaults; bad
   *  lines are dropped; ids that do not look like ids are replaced. */
  function cleanBill(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var b = blankBill();
    b.title = clean(r.title, LIMITS.title);
    b.currency = CURRENCIES[r.currency] ? r.currency : 'USD';
    var seen = {};
    var items = Array.isArray(r.items) ? r.items.slice(0, LIMITS.items * 2) : [];
    for (var i = 0; i < items.length && b.items.length < LIMITS.items; i++) {
      var it = items[i];
      if (!it || typeof it !== 'object') continue;
      var name = clean(it.name, LIMITS.name);
      var unit = centsOr(it.unit, null);
      var qty = typeof it.qty === 'number' ? it.qty : Number(String(it.qty == null ? 1 : it.qty).trim());
      if (!name || !/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(name) || unit === null || unit <= 0 || unit > LIMITS.unitMax) continue;
      if (!isFinite(qty) || Math.floor(qty) !== qty || qty < 1) qty = 1;
      if (qty > LIMITS.qty) qty = LIMITS.qty;
      var id = typeof it.id === 'string' && ID_RE.test(it.id) && !seen[it.id] ? it.id : shortId('i');
      seen[id] = true;
      b.items.push({ id: id, name: name, unit: unit, qty: qty });
    }
    b.tax = Math.max(0, Math.min(LIMITS.billMax, centsOr(r.tax, 0)));
    var t = r.tip && typeof r.tip === 'object' ? r.tip : {};
    var bp = typeof t.bp === 'number' && isFinite(t.bp) ? Math.round(t.bp) : toBp(t.bp);
    b.tip = {
      mode: oneOf(t.mode, ['percent', 'amount'], 'percent'),
      bp: bp === null || bp < 0 ? 2000 : Math.min(LIMITS.tipMaxBp, bp),
      cents: Math.max(0, Math.min(LIMITS.billMax, centsOr(t.cents, 0))),
      base: oneOf(t.base, ['subtotal', 'total'], 'subtotal'),
      even: t.even === true,
      onReceipt: t.onReceipt === true,
    };
    function lines(list, max, service) {
      var out = [];
      (Array.isArray(list) ? list.slice(0, max * 2) : []).forEach(function (f) {
        if (out.length >= max || !f || typeof f !== 'object') return;
        var c = centsOr(f.cents, null);
        if (c === null || c <= 0 || c > LIMITS.billMax) return;
        var fid = typeof f.id === 'string' && ID_RE.test(f.id) && !seen[f.id] ? f.id : shortId(service ? 'f' : 'd');
        seen[fid] = true;
        var row = { id: fid, name: clean(f.name, LIMITS.name) || (service ? 'Fee' : 'Discount'), cents: c };
        if (service) {
          row.service = f.service === true;
          var rb = typeof f.rateBp === 'number' && isFinite(f.rateBp) ? Math.round(f.rateBp) : null;
          row.rateBp = row.service && rb !== null && rb > 0 && rb <= 10000 ? rb : null;
        }
        out.push(row);
      });
      return out;
    }
    b.fees = lines(r.fees, LIMITS.fees, true);
    b.discounts = lines(r.discounts, LIMITS.discounts, false);
    var pr = r.printed && typeof r.printed === 'object' ? r.printed : {};
    var ps = centsOr(pr.subtotal, null), pt = centsOr(pr.total, null);
    b.printed = { subtotal: ps !== null && ps >= 0 ? ps : null, total: pt !== null && pt >= 0 ? pt : null };
    b.payerId = typeof r.payerId === 'string' && ID_RE.test(r.payerId) ? r.payerId : null;
    var h = r.handles && typeof r.handles === 'object' ? r.handles : {};
    b.handles = { venmo: handleOf('venmo', h.venmo) || '', cashapp: handleOf('cashapp', h.cashapp) || '', paypal: handleOf('paypal', h.paypal) || '' };
    return b;
  }

  function itemTotal(it) { return it.unit * it.qty; }

  function tipCents(b, itemsSum, tax, fees, disc) {
    if (b.tip.mode === 'amount') return b.tip.cents;
    var base = b.tip.base === 'total' ? Math.max(0, itemsSum + tax + fees - disc) : itemsSum;
    return mulDiv(base, b.tip.bp, 10000);
  }

  /** {items, tax, fees, discounts, tip, grand, service} in cents. */
  function totals(b) {
    var items = b.items.reduce(function (s, it) { return s + itemTotal(it); }, 0);
    var fees = b.fees.reduce(function (s, f) { return s + f.cents; }, 0);
    var disc = b.discounts.reduce(function (s, d) { return s + d.cents; }, 0);
    var tip = tipCents(b, items, b.tax, fees, disc);
    var service = b.fees.filter(function (f) { return f.service; });
    return { items: items, tax: b.tax, fees: fees, discounts: disc, tip: tip, grand: items + b.tax + fees + tip - disc, service: service };
  }

  /**
   * The check against what the receipt printed. Never fudged: a gap is
   * named and left for a person to fix.
   *   {status: 'none'|'ok'|'short'|'over', diff, against, text}
   */
  function check(b) {
    var t = totals(b);
    var against = null, have = null, target = null;
    if (b.printed.total !== null) {
      against = 'total';
      have = t.items + t.tax + t.fees - t.discounts + (b.tip.onReceipt ? t.tip : 0);
      target = b.printed.total;
    } else if (b.printed.subtotal !== null) {
      against = 'subtotal';
      have = t.items;
      target = b.printed.subtotal;
    }
    if (against === null || !b.items.length) return { status: 'none', diff: 0, against: null, text: '' };
    var diff = have - target;
    if (diff === 0) return { status: 'ok', diff: 0, against: against, text: 'Matches the receipt’s ' + against + ' of ' + money(target, b.currency) + '.' };
    // If the subtotal matches, say so: the gap is in the tax or fees.
    var subOk = b.printed.subtotal !== null && t.items === b.printed.subtotal && against === 'total';
    if (diff < 0) {
      return { status: 'short', diff: diff, against: against, text: (subOk ? 'The items match, but tax, fees and discounts' : 'Items') + ' add up to ' + money(-diff, b.currency) + ' less than the receipt' + (against === 'subtotal' ? '’s subtotal' : '') + ' - ' + (subOk ? 'a tax or fee line may be missing.' : 'a line may be missing.') };
    }
    return { status: 'over', diff: diff, against: against, text: (subOk ? 'The items match, but tax, fees and discounts' : 'Items') + ' add up to ' + money(diff, b.currency) + ' more than the receipt' + (against === 'subtotal' ? '’s subtotal' : '') + ' - ' + (subOk ? 'a discount may be missing.' : 'a line may be in twice, or a discount missing.') };
  }

  /** "A 20% service charge is already on this bill", when there is one. */
  function serviceNote(b) {
    var t = totals(b);
    if (!t.service.length) return '';
    var f = t.service[0];
    var bp = f.rateBp || (t.items ? Math.round(f.cents * 10000 / t.items / 50) * 50 : null);
    return (bp ? 'A ' + bpText(bp) + ' ' : 'A ') + (/grat/i.test(f.name) ? 'gratuity' : 'service charge') + ' is already on this bill' + (t.tip ? ' - check before tipping on top.' : ', so the tip starts at nothing.');
  }

  /* ------------------------------------------------------------------ *
   * People and claims
   * ------------------------------------------------------------------ */

  function cleanPeople(list) {
    var out = [];
    var seen = {};
    (Array.isArray(list) ? list.slice(0, LIMITS.people * 2) : []).forEach(function (p, i) {
      if (out.length >= LIMITS.people || !p || typeof p !== 'object') return;
      var name = cleanName(p.name);
      if (!name) return;
      var id = typeof p.id === 'string' && ID_RE.test(p.id) && !seen[p.id] ? p.id : shortId('p');
      seen[id] = true;
      out.push({ id: id, name: name, color: oneOf(p.color, COLOR_IDS, COLOR_IDS[i % COLOR_IDS.length]) });
    });
    return out;
  }

  /** claims: {itemId: {personId: weight}} - only real items and people,
   *  whole weights 1..99. everyone: {itemId: true}. */
  function cleanClaims(raw, bill, people) {
    var items = {}, who = {};
    bill.items.forEach(function (it) { items[it.id] = it; });
    people.forEach(function (p) { who[p.id] = true; });
    var out = {};
    var src = raw && typeof raw === 'object' ? raw : {};
    Object.keys(src).forEach(function (iid) {
      if (!items[iid] || !src[iid] || typeof src[iid] !== 'object') return;
      var row = {};
      Object.keys(src[iid]).forEach(function (pid) {
        var w = src[iid][pid];
        if (!who[pid] || typeof w !== 'number' || !isFinite(w)) return;
        w = Math.floor(w);
        if (w < 1) return;
        row[pid] = Math.min(LIMITS.weight, w);
      });
      if (Object.keys(row).length) out[iid] = row;
    });
    return out;
  }
  function cleanEveryone(raw, bill) {
    var out = {};
    var src = raw && typeof raw === 'object' ? raw : {};
    bill.items.forEach(function (it) { if (src[it.id] === true) out[it.id] = true; });
    return out;
  }

  /**
   * The split. For each line:
   *   - a line of qty q at unit price u is claimed by weights w (a unit each
   *     by default). While the weights add up to less than q, each person
   *     pays u x their units exactly and the rest is unclaimed. Once they
   *     reach q, the whole line is shared by weight (3 people on 2
   *     margaritas pay two-thirds of one each; 2:1 on a pizza is 2/3 and
   *     1/3), allocated to the cent.
   *   - "among everyone" splits whatever is left of the line evenly between
   *     everyone at the table.
   * Then tax, fees and discounts - and the tip, unless it is split evenly -
   * are shared in proportion to each person's items (the unclaimed rest
   * carries its own share, so claiming it later moves its tax and tip with
   * it). Every pool is allocated with the largest remainder, so the people
   * and the unclaimed rest add up to exactly the bill.
   */
  function split(bill, people, claims, everyone) {
    var b = bill;
    var t = totals(b);
    var n = people.length;
    var idx = {};
    people.forEach(function (p, i) { idx[p.id] = i; });
    var sub = new Array(n).fill(0);
    var lines = people.map(function () { return []; });
    var unclaimed = 0;
    var open = [];
    var claimedItems = 0;
    b.items.forEach(function (it) {
      var total = itemTotal(it);
      var row = (claims && claims[it.id]) || {};
      var ids = Object.keys(row).filter(function (pid) { return idx[pid] !== undefined && row[pid] > 0; });
      ids.sort(function (x, y) { return idx[x] - idx[y]; });
      var ws = ids.map(function (pid) { return row[pid]; });
      var sumw = ws.reduce(function (a, c) { return a + c; }, 0);
      var parts;
      var rest;
      if (sumw >= it.qty) { parts = allocate(total, ws); rest = 0; }
      else { parts = ws.map(function (w) { return it.unit * w; }); rest = total - it.unit * sumw; }
      ids.forEach(function (pid, k) {
        var i = idx[pid];
        sub[i] += parts[k];
        lines[i].push({ itemId: it.id, cents: parts[k], weight: ws[k], shared: ids.length > 1 || (everyone && everyone[it.id] && rest > 0) });
      });
      if (rest > 0 && everyone && everyone[it.id] && n) {
        var even = allocate(rest, people.map(function () { return 1; }));
        people.forEach(function (p, i) {
          sub[i] += even[i];
          var mine = lines[i].filter(function (l) { return l.itemId === it.id; })[0];
          if (mine) { mine.cents += even[i]; mine.shared = true; }
          else lines[i].push({ itemId: it.id, cents: even[i], weight: 0, shared: true, everyone: true });
        });
        rest = 0;
      }
      if (rest > 0) { unclaimed += rest; open.push({ itemId: it.id, cents: rest, units: sumw >= it.qty ? 0 : it.qty - sumw, whole: sumw === 0 }); }
      else claimedItems++;
    });
    var shareW = sub.concat([unclaimed]);
    var tax = allocate(t.tax, shareW);
    var fees = allocate(t.fees, shareW);
    var disc = allocate(t.discounts, shareW);
    var tip = b.tip.even ? allocate(t.tip, people.map(function () { return 1; }).concat([0])) : allocate(t.tip, shareW);
    if (b.tip.even && !n) tip = [t.tip];
    var rows = people.map(function (p, i) {
      return { id: p.id, name: p.name, color: p.color, items: sub[i], tax: tax[i], fees: fees[i], discounts: disc[i], tip: tip[i], total: sub[i] + tax[i] + fees[i] + tip[i] - disc[i], lines: lines[i] };
    });
    var u = { items: unclaimed, tax: tax[n], fees: fees[n], discounts: disc[n], tip: tip[n] || 0 };
    u.total = u.items + u.tax + u.fees + u.tip - u.discounts;
    u.open = open;
    return { people: rows, unclaimed: u, totals: t, grand: t.grand, claimedLines: claimedItems, lines: b.items.length };
  }

  /** "Splitting evenly would have cost Ana $9.40 more" - the person an even
   *  split would have overcharged most, over what has been claimed. */
  function fairness(result, cur) {
    var rows = result.people.filter(function (r) { return r.total > 0; });
    if (rows.length < 2) return null;
    var claimed = rows.reduce(function (s, r) { return s + r.total; }, 0);
    var even = allocate(claimed, rows.map(function () { return 1; }));
    var best = null;
    rows.forEach(function (r, i) {
      var d = even[i] - r.total;
      if (d > 0 && (!best || d > best.cents)) best = { id: r.id, name: r.name, cents: d };
    });
    if (!best || best.cents < 100) return { even: true, text: 'An even split would have been about fair tonight.' };
    return { even: false, id: best.id, name: best.name, cents: best.cents, text: 'Splitting evenly would have cost ' + best.name + ' ' + money(best.cents, cur) + ' more' + (result.unclaimed.total > 0 ? ' (so far).' : '.') };
  }

  /* ------------------------------------------------------------------ *
   * Paying: handles and links
   * ------------------------------------------------------------------ */

  // Strict patterns, and a pasted profile link is read down to its handle.
  // Only https links to these three hosts are ever built.
  var HANDLES = {
    venmo: { label: 'Venmo', host: 'venmo.com', re: /^[A-Za-z0-9_-]{5,30}$/, strip: /^(?:https?:\/\/)?(?:www\.|account\.)?venmo\.com\/(?:u\/)?|^@/i },
    cashapp: { label: 'Cash App', host: 'cash.app', re: /^(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,20}$/, strip: /^(?:https?:\/\/)?(?:www\.)?cash\.app\/\$?|^\$/i },
    paypal: { label: 'PayPal', host: 'paypal.me', re: /^[A-Za-z0-9]{1,20}$/, strip: /^(?:https?:\/\/)?(?:www\.)?paypal\.me\/|^@/i },
  };
  var PAY_HOSTS = ['venmo.com', 'cash.app', 'paypal.me'];

  /** A typed handle as the bare handle, or null if it is not one. */
  function handleOf(service, v) {
    var h = HANDLES[service];
    if (!h || typeof v !== 'string') return null;
    var s = v.trim().replace(h.strip, '').replace(/[/?#].*$/, '').trim();
    if (service === 'paypal') s = s.replace(/\/.*$/, '');
    return h.re.test(s) ? s : null;
  }

  /** A link is only ever https to one of the three hosts. */
  function safePayUrl(u) {
    try {
      var x = new URL(u);
      return x.protocol === 'https:' && PAY_HOSTS.indexOf(x.hostname) >= 0 && !x.username && !x.password && !x.port ? x.href : null;
    } catch (e) { return null; }
  }

  /**
   * The pay buttons for one person: [{service, label, url}]. Venmo and Cash
   * App take dollars only; PayPal takes the currency code after the amount
   * when it is not dollars. The amount and note are prefilled where the
   * service reads them from the link.
   */
  function payLinks(handles, cents, note, currency) {
    var out = [];
    if (!handles || !(cents > 0)) return out;
    var amt = plain(cents);
    var cur = CURRENCIES[currency] ? currency : 'USD';
    var v = handleOf('venmo', handles.venmo || '');
    if (v && cur === 'USD') out.push({ service: 'venmo', label: 'Venmo', url: 'https://venmo.com/' + encodeURIComponent(v) + '?txn=pay&amount=' + amt + '&note=' + encodeURIComponent(clean(note, 80) || 'Dibs') });
    var c = handleOf('cashapp', handles.cashapp || '');
    if (c && cur === 'USD') out.push({ service: 'cashapp', label: 'Cash App', url: 'https://cash.app/$' + encodeURIComponent(c) + '/' + amt });
    var p = handleOf('paypal', handles.paypal || '');
    if (p) out.push({ service: 'paypal', label: 'PayPal', url: 'https://paypal.me/' + encodeURIComponent(p) + '/' + amt + (cur === 'USD' ? '' : cur) });
    return out.filter(function (l) { return safePayUrl(l.url) === l.url; });
  }

  /** "Venmo @sam-lee · Cash App $samlee · PayPal paypal.me/samlee" */
  function handlesText(h) {
    var out = [];
    var v = handleOf('venmo', (h && h.venmo) || ''), c = handleOf('cashapp', (h && h.cashapp) || ''), p = handleOf('paypal', (h && h.paypal) || '');
    if (v) out.push('Venmo @' + v);
    if (c) out.push('Cash App $' + c);
    if (p) out.push('PayPal paypal.me/' + p);
    return out.join(' · ');
  }

  /**
   * The group-chat summary: "Dinner at Luigi's - Sam paid $267.42. Ana
   * $54.77, Ben $104.39, Cleo $45.75 (Sam's own share $49.62)."
   */
  function summary(bill, result) {
    var cur = bill.currency;
    var title = bill.title || 'The bill';
    var payer = result.people.filter(function (r) { return r.id === bill.payerId; })[0];
    var owe = result.people.filter(function (r) { return r !== payer && r.total > 0; }).map(function (r) { return r.name + ' ' + money(r.total, cur); });
    var s = title + ' - ' + (payer ? payer.name + ' paid ' : 'total ') + money(result.grand, cur) + '.';
    if (owe.length) s += ' ' + (payer ? 'Owes ' + payer.name + ': ' : '') + owe.join(', ') + '.';
    if (payer && payer.total > 0) s += ' (' + payer.name + '’s own share ' + money(payer.total, cur) + '.)';
    if (result.unclaimed.total > 0) s += ' Still unclaimed: ' + money(result.unclaimed.total, cur) + '.';
    var h = handlesText(bill.handles);
    if (payer && h) s += '\nPay ' + payer.name + ': ' + h;
    s += '\nSplit to the cent with Dibs.';
    return s;
  }

  return {
    LIMITS: LIMITS, CURRENCIES: CURRENCIES, COLORS: COLORS, COLOR_IDS: COLOR_IDS, ID_RE: ID_RE, HANDLES: HANDLES, PAY_HOSTS: PAY_HOSTS,
    clean: clean, cleanName: cleanName, tidyCase: tidyCase, colorHex: colorHex,
    toCents: toCents, toBp: toBp, money: money, plain: plain, bpText: bpText, symbolOf: symbolOf, mulDiv: mulDiv, allocate: allocate,
    moneyToken: moneyToken, readQty: readQty, parseReceipt: parseReceipt, billFromParsed: billFromParsed,
    blankBill: blankBill, cleanBill: cleanBill, itemTotal: itemTotal, totals: totals, check: check, serviceNote: serviceNote,
    cleanPeople: cleanPeople, cleanClaims: cleanClaims, cleanEveryone: cleanEveryone, split: split, fairness: fairness,
    handleOf: handleOf, safePayUrl: safePayUrl, payLinks: payLinks, handlesText: handlesText, summary: summary, shortId: shortId,
  };
}));
