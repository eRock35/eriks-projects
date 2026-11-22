/* Stars - the rules, in one file run three times: in the page
 * (window.StarsCore), in the server (require) and in the tests. No clock,
 * no dice, no network, no storage: every time stamp and id is passed in.
 *
 * THE METHOD - classic menu engineering, done exactly:
 *
 *   For each dish:  contribution margin  CM = price - plate cost
 *                   food cost %          = plate cost / price
 *                   menu mix %           = units sold / the section's units
 *
 *   Within a section (Starters, Mains...) of n dishes with sales:
 *     T   = the units sold of every dish in it
 *     TCM = the sum of CM x units sold - what the section earned over the
 *           plate costs
 *     the MARGIN LINE is the average contribution margin weighted by sales,
 *     TCM / T. A dish is HIGH margin when its CM is AT or ABOVE the line.
 *     the POPULARITY LINE is 70% of an even share: (1 / n) x 0.7 of T. A dish
 *     is POPULAR when its units are AT or ABOVE the line.
 *
 *     high margin, popular   STAR        keep it, show it off
 *     low margin,  popular   PLOWHORSE   reprice, or rework the plate cost
 *     high margin, unpopular PUZZLE      reposition, rename, recommend it
 *     low margin,  unpopular DOG         cut it, or rework it
 *
 *   That is the classic method from the menu-engineering literature: the
 *   sales-weighted average margin and the 70% rule. "At or above" both lines
 *   counts as high - a dish exactly on a line is a star, not a dog.
 *
 * THE ARITHMETIC IS EXACT. Money is a whole number of CENTS, units a whole
 * number. Nothing is divided before it is compared: "CM >= TCM / T" is
 * tested as CM x T >= TCM, and "units >= 0.7 T / n" as 10 x n x units >= 7 x T.
 * Percentages for display are rounded once (a half rounds up), with BigInt.
 *
 * The edges, decided (and tested):
 *   - a dish with no plate cost or no units yet is listed, not rated;
 *   - a dish with zero sales is never popular;
 *   - a section where nothing sold has no popular dishes, and its margin line
 *     falls back to the plain average of the margins;
 *   - one dish alone in a section is compared with itself: a star by
 *     definition when it sold, and the page says so;
 *   - a negative margin (the plate costs more than the price) is rated like
 *     any other and flagged: it loses money on every plate.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StarsCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    name: 60, cat: 30, period: 40, items: 400, storedBytes: 400 * 1024,
    priceMax: 99999, soldMax: 999999,
    csvBytes: 1024 * 1024, csvRows: 2000, pasteChars: 8000,
    aiImages: 2, aiImageBytes: 1.5 * 1024 * 1024, aiImageSide: 1600, aiItems: 80,
  };
  var QUADS = ['star', 'plowhorse', 'puzzle', 'dog'];
  var QUAD = {
    star: { label: 'Star', emoji: '⭐', what: 'High margin, popular' },
    plowhorse: { label: 'Plowhorse', emoji: '🐴', what: 'Low margin, popular' },
    puzzle: { label: 'Puzzle', emoji: '🧩', what: 'High margin, not popular' },
    dog: { label: 'Dog', emoji: '🐕', what: 'Low margin, not popular' },
  };
  var METHOD = {
    margin: 'the average contribution margin, weighted by units sold (TCM / T)',
    popularity: '70% of an even share of the units sold: (1 / n) x 0.7',
    onTheLine: 'at or above a line counts as high',
  };

  /* ================================================================== *
   * Text: plain words only
   * ================================================================== */

  var BAD_RANGES = [[0, 8], [11, 12], [14, 31], [0x7F, 0x9F], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF]];
  function hx4(n) { return '\\u' + ('000' + n.toString(16)).slice(-4); }
  var BAD_CLASS = '[' + BAD_RANGES.map(function (p) { return hx4(p[0]) + '-' + hx4(p[1]); }).join('') + ']';
  var BAD = new RegExp(BAD_CLASS, 'g');
  var BAD1 = new RegExp(BAD_CLASS);
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  function esc(v) { return str(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function clip(s, n) { var a = Array.from(s); return a.length <= n ? s : a.slice(0, Math.max(0, n - 1)).join('').replace(/\s+$/, '') + '…'; }
  function noMarkup(s) { return str(s).replace(/<[^>]{0,200}>/g, '').replace(/[<>]/g, ''); }
  function line(v, max) { return clip(noMarkup(str(v).replace(BAD, '')).replace(/\s+/g, ' ').trim(), max || 200); }
  function nf(s) { s = str(s); try { return s.normalize('NFKC'); } catch (e) { return s; } }
  function isObj(o) { return Boolean(o) && typeof o === 'object' && !Array.isArray(o); }
  function isInt(v) { return typeof v === 'number' && Math.round(v) === v && isFinite(v); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function list(xs) { return xs.length <= 1 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  var AT_ANY = new RegExp('[@' + String.fromCharCode(0xFF20, 0xFE6B) + ']');
  function hasAt(s) { return AT_ANY.test(str(s)) || /@/.test(nf(s)); }
  var LINK = /(https?:|ftp:|mailto:|www\.|:\/\/|\b[a-z0-9-]{2,}\.(com|net|org|io|co|uk|us|app|dev|ly|me|info|biz|tv|gg|xyz|menu|restaurant|cafe|bar|pizza|site|online|link|kitchen)\b)/i;
  function hasLink(s) { return LINK.test(nf(s)); }
  /** Seven or more digits, in any script, in one run of digits and phone
   *  punctuation. */
  function hasPhone(s) {
    var t = nf(s).replace(/\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}/gu, ' ');
    return (t.match(/\+?\p{Nd}[\p{Nd} ()\/-]{5,}\p{Nd}/gu) || []).some(function (m) { return m.replace(/[^\p{Nd}]/gu, '').length >= 7; });
  }
  function nineDigits(s) { var t = nf(s); return /\p{Nd}{9,}/u.test(t) || /\p{Nd}{3}[ -]\p{Nd}{2}[ -]\p{Nd}{4}(?!\p{Nd})/u.test(t); }
  function hasCard(s) {
    return (nf(s).match(/\p{Nd}(?:[ -]?\p{Nd}){12,18}/gu) || []).some(function (m) {
      var d = m.replace(/[ -]/g, '');
      if (!/^[0-9]+$/.test(d)) return true;
      var sum = 0;
      for (var i = 0; i < d.length; i++) { var x = +d.charAt(d.length - 1 - i); if (i % 2) { x *= 2; if (x > 9) x -= 9; } sum += x; }
      return sum % 10 === 0;
    });
  }
  /** A spreadsheet formula: a leading = or @, or + or - straight before a
   *  letter or a bracket. (-1.40 is a number and fine.) */
  function isFormula(s) { s = str(s); return /^[\t\r]/.test(s) || /^\s*[=@]/.test(nf(s)) || /^\s*[+\-][^\s\p{Nd}.]/u.test(nf(s)); }
  function hasInvisible(s) { return BAD1.test(str(s)); }
  function hasMarkup(s) { return /[<>]/.test(str(s)); }

  var WHY = {
    invisible: 'That has an invisible character in it - type it again.',
    markup: 'Leave out < and > - Stars keeps plain words.',
    at: 'That looks like an email address - Stars never keeps one.',
    link: 'That looks like a link - Stars keeps plain words.',
    formula: 'Start it with a letter or a number - a leading = + - or @ is how a spreadsheet runs a formula.',
    card: 'That looks like a card number - never write one down here.',
    phone: 'That looks like a phone number - Stars never keeps one.',
    nine: 'Nine digits in a row looks like a tax id or an account number - Stars never keeps one.',
  };
  /** The general text door: '' when `s` may be kept, else why not.
   *  Refused, never cleaned. */
  function refuse(s, max) {
    s = str(s);
    if (hasInvisible(s.replace(/[\n\t]/g, ' '))) return WHY.invisible;
    if (hasMarkup(s)) return WHY.markup;
    if (hasAt(s)) return WHY.at;
    if (hasLink(s)) return WHY.link;
    if (s.split('\n').some(isFormula)) return WHY.formula;
    if (hasCard(s)) return WHY.card;
    if (nineDigits(s)) return WHY.nine;
    if (hasPhone(s)) return WHY.phone;
    if (max && Array.from(s.trim()).length > max) return 'Up to ' + max + ' characters.';
    return '';
  }
  function nameProblem(s) {
    s = str(s).trim();
    if (!s) return 'Give the dish its name, as the menu has it.';
    if (/\n/.test(s)) return 'One line.';
    return refuse(s, LIMITS.name);
  }
  function catProblem(s) {
    s = str(s).trim();
    if (!s) return 'Which section of the menu - Starters, Mains, Desserts?';
    if (/\n/.test(s)) return 'One line.';
    return refuse(s, LIMITS.cat);
  }
  function periodProblem(s) { s = str(s).trim(); if (!s) return ''; if (/\n/.test(s)) return 'One line.'; return refuse(s, LIMITS.period); }
  /** Pasted menu text for the AI: the text door, and not too long. A menu's
   *  own phone number or web address has to come out first. */
  function pasteProblem(s) {
    s = str(s);
    if (!s.trim()) return 'Paste the menu’s text first.';
    if (Array.from(s).length > LIMITS.pasteChars) return 'That is more than a menu - paste up to ' + LIMITS.pasteChars + ' characters at a time.';
    var why = refuse(s.replace(/\r/g, ''), 0);
    if (why === WHY.phone || why === WHY.link || why === WHY.at) return 'Take out the phone number, address and web or email address (only the dishes and prices are needed), then paste again.';
    return why;
  }

  /* ================================================================== *
   * Exact numbers: money in cents, units whole
   * ================================================================== */

  function floorDiv(a, b) {
    var q = Math.trunc(a / b);
    while (q * b > a) q--;
    while ((q + 1) * b <= a) q++;
    return q;
  }
  function ceilDiv(a, b) { return -floorDiv(-a, b); }
  /** num / den rounded to a whole number, a half rounding UP; den > 0. Done
   *  in BigInt so sums of sales x cents can never lose a digit. */
  function roundDiv(num, den) {
    var n = BigInt(num), d = BigInt(den), two = BigInt(2);
    var q = (two * n + d) / (two * d), r = (two * n + d) % (two * d);
    if (r < BigInt(0)) q -= BigInt(1);
    return Number(q);
  }
  /** "$12.50", "12.5", "12", "1,234.00" -> cents. */
  function parseMoney(v, what) {
    var label = what || 'That amount';
    var s = nf(str(v)).trim().replace(/^\$\s*/, '').replace(/^usd\s*/i, '');
    if (!s) return { error: label + ' is empty.' };
    var m = /^(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{1,2}))?$/.exec(s);
    if (!m || (m[1] === undefined && m[2] === undefined)) return { error: label + ' should be dollars and cents, like 14.50.' };
    var dollars = (m[1] || '0').replace(/,/g, '');
    if (dollars.length > 7) return { error: label + ' is too large.' };
    return { v: Number(dollars) * 100 + Number(((m[2] || '') + '00').slice(0, 2)) };
  }
  function parseUnits(v, what) {
    var s = nf(str(v)).trim();
    if (!/^(\d{1,3}(,\d{3})+|\d{1,7})$/.test(s)) return { error: (what || 'Units sold') + ' should be a whole number, like 120.' };
    var n = Number(s.replace(/,/g, ''));
    if (n > LIMITS.soldMax) return { error: (what || 'Units sold') + ' should be under a million.' };
    return { v: n };
  }
  function groupDigits(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /** 1450 -> "$14.50"; -140 -> "−$1.40" (a true minus sign, for the page). */
  function fmtMoney(c) {
    if (!isInt(c)) return '';
    var a = Math.abs(c);
    return (c < 0 ? '−' : '') + '$' + groupDigits(Math.floor(a / 100)) + '.' + ('0' + (a % 100)).slice(-2);
  }
  /** For a form or a CSV: "14.50", "-1.40". */
  function moneyField(c) { if (!isInt(c)) return ''; var a = Math.abs(c); return (c < 0 ? '-' : '') + Math.floor(a / 100) + '.' + ('0' + (a % 100)).slice(-2); }
  function fmtUnits(n) { return isInt(n) ? groupDigits(n) : ''; }
  /** A share in tenths of a percent (permille), a half rounding up. */
  function permille(num, den) { return den > 0 ? roundDiv(BigInt(num) * BigInt(1000), den) : null; }
  function fmtPct(pm) { if (pm === null || pm === undefined) return '-'; var a = Math.abs(pm); return (pm < 0 ? '−' : '') + Math.floor(a / 10) + '.' + (a % 10) + '%'; }
  function pctField(pm) { if (pm === null || pm === undefined) return ''; var a = Math.abs(pm); return (pm < 0 ? '-' : '') + Math.floor(a / 10) + '.' + (a % 10); }

  /* ================================================================== *
   * The analysis
   * ================================================================== */

  /** Complete enough to rate: a price, a plate cost and units sold. */
  function rated(it) { return isInt(it.price) && isInt(it.cost) && isInt(it.sold); }

  /**
   * One group of dishes (a section, or the whole menu) worked out. `items`
   * are {id, name, cat, price, cost, sold}; a dish missing its plate cost or
   * its units is listed in `waiting` and not rated.
   */
  function analyse(items) {
    var rows = items.filter(rated), waiting = items.filter(function (x) { return !rated(x); });
    var n = rows.length, T = 0, TCM = 0, SCM = 0, rev = 0, fc = 0;
    rows.forEach(function (x) { var cm = x.price - x.cost; T += x.sold; TCM += cm * x.sold; SCM += cm; rev += x.price * x.sold; fc += x.cost * x.sold; });
    var noSales = n > 0 && T === 0;
    var out = {
      n: n, sold: T, tcm: TCM, revenue: rev, foodCost: fc, noSales: noSales, lone: n === 1,
      // The margin line, exactly: num / den. Weighted by units; the plain
      // average of the margins when nothing sold.
      line: n ? (noSales ? { num: SCM, den: n } : { num: TCM, den: T }) : null,
      avgCm: n ? (noSales ? roundDiv(SCM, n) : roundDiv(TCM, T)) : null,
      // The popularity line in units: 7T / 10n.
      pop: n ? { num: 7 * T, den: 10 * n } : null,
      popUnits10: n ? roundDiv(70 * T, 10 * n) : null,      // the line in tenths of a unit
      popShare: n ? roundDiv(700, n) : null,                 // the line as a share, permille
      foodPct: rev > 0 ? permille(fc, rev) : null,
      items: [], waiting: waiting.map(function (x) { return x.id; }),
      counts: { star: 0, plowhorse: 0, puzzle: 0, dog: 0 },
    };
    rows.forEach(function (x) {
      var cm = x.price - x.cost;
      var hiCm = n > 0 && cm * out.line.den >= out.line.num;
      var hiPop = !noSales && x.sold > 0 && 10 * n * x.sold >= 7 * T;
      var quad = hiCm ? (hiPop ? 'star' : 'puzzle') : (hiPop ? 'plowhorse' : 'dog');
      out.counts[quad]++;
      out.items.push({
        id: x.id, name: x.name, cat: x.cat, price: x.price, cost: x.cost, sold: x.sold,
        cm: cm, foodPct: permille(x.cost, x.price), mix: T > 0 ? permille(x.sold, T) : null,
        earned: cm * x.sold, hiCm: hiCm, hiPop: hiPop, quad: quad, loses: cm < 0,
        onCmLine: n > 0 && cm * out.line.den === out.line.num, onPopLine: !noSales && x.sold > 0 && 10 * n * x.sold === 7 * T,
      });
    });
    return out;
  }
  function find(g, id) { for (var i = 0; i < g.items.length; i++) if (g.items[i].id === id) return g.items[i]; return null; }

  /**
   * The price at which a low-margin dish reaches its group's margin line,
   * with the same units sold everywhere. Raising its price raises the line
   * too, so it is solved for: with Δ cents more,
   *   (cm + Δ) x T >= TCM + Δ x s   <=>   Δ >= (TCM - cm x T) / (T - s),
   * the smallest whole Δ. (Nothing sold: the plain average, (n - 1) in
   * place of T - s.) null when the dish is already on or over the line or
   * no price can do it (it is the group's only seller).
   */
  function lineDelta(g, it) {
    if (!g || !it || it.hiCm || g.n < 2) return null;
    if (g.noSales) return ceilDiv(g.line.num - it.cm * g.n, g.n - 1);
    if (g.sold - it.sold <= 0) return null;
    return ceilDiv(g.tcm - it.cm * g.sold, g.sold - it.sold);
  }
  function linePrice(g, it) { var d = lineDelta(g, it); return d === null || it.price + d > LIMITS.priceMax ? null : it.price + d; }
  /** The plate cost that does the same: the cost down by the same Δ. */
  function lineCost(g, it) { var d = lineDelta(g, it); return d === null || it.cost - d < 0 ? null : it.cost - d; }
  /**
   * The units at which an unpopular dish reaches the popularity line, the
   * others selling the same: 10n s' >= 7 (T - s + s')  <=>
   * s' >= 7 (T - s) / (10n - 7), the smallest whole s' - and at least 1.
   */
  function popNeeded(g, it) {
    if (!g || !it || it.hiPop || !g.n) return null;
    return Math.max(1, ceilDiv(7 * (g.sold - it.sold), 10 * g.n - 7));
  }
  /** A friendlier menu price: up to the next quarter. */
  function menuPrice(c) { return isInt(c) ? ceilDiv(c, 25) * 25 : null; }

  /**
   * What if this dish were priced (and sold) differently, everything else
   * the same: the group worked out again, and the dish before and after.
   */
  function whatIf(items, id, price, sold) {
    var before = analyse(items);
    var changed = items.map(function (x) {
      if (x.id !== id) return x;
      var y = clone(x);
      if (isInt(price)) y.price = price;
      if (isInt(sold)) y.sold = sold;
      return y;
    });
    var after = analyse(changed);
    return { before: find(before, id), after: find(after, id), groupBefore: before, groupAfter: after };
  }

  /** Plain suggestions, most useful first: {kind, text}. */
  function suggestions(g, it) {
    if (!g || !it) return [];
    var out = [], M = fmtMoney;
    var lp = linePrice(g, it), lc = lineCost(g, it), pn = popNeeded(g, it);
    if (it.loses) out.push({ kind: 'reprice', text: 'It loses ' + M(-it.cm) + ' on every plate: the price is under the plate cost of ' + M(it.cost) + '. Reprice it above that, or rework the plate, before anything else.' });
    if (g.lone) out.push({ kind: 'note', text: 'It is the only rated dish in its group, so it is compared with itself - a star by definition when it sells. Judge it against the whole menu too.' });
    if (it.sold === 0) out.push({ kind: 'note', text: 'Not one sold in this period.' });
    if (it.quad === 'star') {
      out.push({ kind: 'keep', text: 'Keep it as it is: hold the recipe, the portion and the plating steady.' });
      out.push({ kind: 'reposition', text: 'Give it the best spot on the menu - the top of its section, or a box - and have servers name it.' });
      out.push({ kind: 'reprice', text: 'Popular dishes can usually carry a small rise: try a higher price below and watch its sales.' });
    } else if (it.quad === 'plowhorse') {
      if (lp !== null && !it.loses) out.push({ kind: 'reprice', text: 'At ' + M(lp) + ' or more it reaches the margin line (with the same units sold) - try ' + M(menuPrice(lp)) + ' below. Raise it in small steps; people order it a lot.' });
      if (lc !== null) out.push({ kind: 'rework', text: 'Or bring the plate cost down to ' + M(lc) + ': a trimmed portion, a cheaper garnish or side, a better supplier price.' });
      out.push({ kind: 'reposition', text: 'Move it to a quieter spot on the menu, so it stops pulling orders from dishes that earn more.' });
    } else if (it.quad === 'puzzle') {
      out.push({ kind: 'reposition', text: 'It earns well but few order it: move it up the menu, rename it or describe it better, and have servers recommend it.' + (pn !== null && pn > it.sold ? ' About ' + fmtUnits(pn) + ' sold (' + fmtUnits(pn - it.sold) + ' more) would make it popular, everything else the same.' : '') });
      out.push({ kind: 'reprice', text: 'A small price cut may help it sell - check below that it stays on or over the margin line.' });
      out.push({ kind: 'cut', text: 'If it still does not sell after a fair try, it is a candidate to cut.' });
    } else {
      out.push({ kind: 'cut', text: 'Cut it, or replace it with a dish that earns more and sells.' });
      if (lp !== null && !it.loses) out.push({ kind: 'reprice', text: 'If it has to stay (a regular’s favourite, a dietary option), price it at ' + M(lp) + ' or more to reach the margin line.' });
      if (lc !== null) out.push({ kind: 'rework', text: 'Or rework the plate down to ' + M(lc) + '.' });
    }
    return out;
  }

  /* ================================================================== *
   * The menu: sections, dishes, the one door, and two phones
   * ================================================================== */

  var ID = /^i[a-z0-9]{6,12}$/;
  var ITEM_KEYS = ['name', 'cat', 'price', 'cost', 'sold', 't'];
  function newBook(t) { return { v: 1, t: t || 0, period: { label: '', t: 0 }, items: {} }; }
  function itemProblems(it) {
    var p = [];
    var a = nameProblem(it.name); if (a) p.push({ field: 'name', msg: a });
    var b = catProblem(it.cat); if (b) p.push({ field: 'cat', msg: b });
    if (!isInt(it.price) || it.price < 1 || it.price > LIMITS.priceMax) p.push({ field: 'price', msg: 'The price should be $0.01 to $999.99.' });
    if (!(it.cost === null || (isInt(it.cost) && it.cost >= 0 && it.cost <= LIMITS.priceMax))) p.push({ field: 'cost', msg: 'The plate cost should be $0.00 to $999.99.' });
    if (!(it.sold === null || (isInt(it.sold) && it.sold >= 0 && it.sold <= LIMITS.soldMax))) p.push({ field: 'sold', msg: 'Units sold should be 0 to 999,999.' });
    return p;
  }
  var FIELDS = ['name', 'cat', 'price', 'cost', 'sold'];
  var FIELD_LABEL = { name: 'Dish', cat: 'Menu section', price: 'Menu price', cost: 'Plate cost', sold: 'Units sold' };
  function emptyFields(cat) { return { name: '', cat: cat || '', price: '', cost: '', sold: '' }; }
  function fieldsOf(it) { return { name: it.name, cat: it.cat, price: moneyField(it.price), cost: isInt(it.cost) ? moneyField(it.cost) : '', sold: isInt(it.sold) ? String(it.sold) : '' }; }
  /** Form strings -> a dish {item} or {errors: [{field, msg}]}. Plate cost
   *  and units may be left empty for now. */
  function itemFrom(F, t) {
    var errs = [], it = { name: line(F.name, 400), cat: line(F.cat, 400), price: null, cost: null, sold: null, t: t || 0 };
    var p = parseMoney(F.price, 'The price'); if (p.error) errs.push({ field: 'price', msg: p.error }); else it.price = p.v;
    if (str(F.cost).trim()) { var c = parseMoney(F.cost, 'The plate cost'); if (c.error) errs.push({ field: 'cost', msg: c.error }); else it.cost = c.v; }
    if (str(F.sold).trim()) { var s = parseUnits(F.sold); if (s.error) errs.push({ field: 'sold', msg: s.error }); else it.sold = s.v; }
    var nm = nameProblem(F.name); if (nm) errs.push({ field: 'name', msg: nm });
    var ct = catProblem(F.cat); if (ct) errs.push({ field: 'cat', msg: ct });
    if (!errs.length) itemProblems(it).forEach(function (x) { errs.push(x); });
    return errs.length ? { errors: errs } : { item: it, errors: [] };
  }
  function cleanItem(raw, strict, errs, where) {
    if (!isObj(raw)) { errs.push(where + ' is not in shape.'); return null; }
    if (raw.del === true) {
      if (strict && Object.keys(raw).some(function (k) { return k !== 'del' && k !== 't'; })) errs.push(where + ': a removed dish keeps only its time.');
      if (!isInt(raw.t) || raw.t < 0) { errs.push(where + ': its time is not a number.'); return null; }
      return { del: true, t: raw.t };
    }
    var extra = Object.keys(raw).filter(function (k) { return ITEM_KEYS.indexOf(k) < 0; });
    if (extra.length) { errs.push(where + ': unknown field ' + line(extra[0], 20) + '.'); if (strict) return null; }
    if (typeof raw.name !== 'string' || typeof raw.cat !== 'string' || !isInt(raw.t) || raw.t < 0) { errs.push(where + ' is not in shape.'); return null; }
    var it = { name: raw.name, cat: raw.cat, price: raw.price, cost: raw.cost === undefined ? null : raw.cost, sold: raw.sold === undefined ? null : raw.sold, t: raw.t };
    if (!strict) { it.name = line(it.name, LIMITS.name); it.cat = line(it.cat, LIMITS.cat); }
    var p = itemProblems(it);
    if (p.length) { errs.push(where + ': ' + p[0].msg); return null; }
    return it;
  }
  /** The one door for a whole menu. Strict (the server): anything out of
   *  shape is an error and nothing is kept. Lenient (this phone's own
   *  copy): the bad dish is dropped and the rest kept. */
  function cleanBook(raw, strict) {
    var errs = [], out = newBook(0);
    if (!isObj(raw)) return { book: out, errors: ['The menu is not in shape.'] };
    var extra = Object.keys(raw).filter(function (k) { return ['v', 't', 'period', 'items'].indexOf(k) < 0; });
    if (extra.length) errs.push('Unknown field ' + line(extra[0], 20) + '.');
    if (raw.v !== 1) errs.push('Unknown version.');
    out.t = isInt(raw.t) && raw.t >= 0 ? raw.t : 0;
    var P = raw.period;
    if (isObj(P) && typeof P.label === 'string' && isInt(P.t) && P.t >= 0 && !Object.keys(P).some(function (k) { return k !== 'label' && k !== 't'; })) {
      var why = periodProblem(P.label);
      if (why) errs.push('The period: ' + why); else out.period = { label: P.label.trim(), t: P.t };
    } else if (P !== undefined) errs.push('The period is not in shape.');
    if (!isObj(raw.items)) { errs.push('No dishes.'); return { book: out, errors: errs }; }
    var ids = Object.keys(raw.items);
    if (ids.length > LIMITS.items) { errs.push('More than ' + LIMITS.items + ' dishes.'); if (strict) return { book: out, errors: errs }; ids = ids.slice(0, LIMITS.items); }
    ids.forEach(function (id) {
      if (!ID.test(id)) { errs.push('A dish id is not in shape.'); return; }
      var r = raw.items[id];
      var it = cleanItem(r, strict, errs, 'Dish ' + (r && typeof r.name === 'string' ? '“' + line(r.name, 30) + '”' : id));
      if (it) out.items[id] = it;
    });
    return { book: out, errors: errs };
  }
  /** What the server refuses whole before the door looks. */
  function bodyProblem(v, depth) {
    depth = depth || 0;
    if (depth > 8) return 'That is nested too deeply.';
    if (typeof v === 'string') {
      if (hasAt(v)) return 'Something in it has an @ - Stars keeps no email addresses.';
      if (nineDigits(v)) return 'Something in it has nine digits in a row - Stars keeps no tax ids or account numbers.';
      if (hasLink(v)) return 'Something in it looks like a link.';
      if (hasMarkup(v)) return 'Something in it has markup.';
      if (hasInvisible(v)) return 'Something in it has an invisible character.';
      return '';
    }
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) { var p = bodyProblem(v[i], depth + 1); if (p) return p; } return ''; }
    if (isObj(v)) {
      var ks = Object.keys(v);
      for (var j = 0; j < ks.length; j++) { var q = bodyProblem(ks[j], depth + 1) || bodyProblem(v[ks[j]], depth + 1); if (q) return q; }
    }
    return '';
  }
  // Sections in the order a menu reads, then A-Z.
  var CAT_ORDER = [/^(bread|snack|nibble|bar snack)/i, /^(starter|appeti|small|first|antipast|tapas|soup|salad)/i, /^(main|entr[eé]e|large|plate|pasta|pizza|grill|burger|sandwich)/i, /^(side|veg)/i, /^(kid|child)/i, /^(dessert|sweet|pudding|cheese)/i, /^(drink|beverage|coffee|tea|wine|beer|cocktail)/i];
  function catRank(c) { for (var i = 0; i < CAT_ORDER.length; i++) if (CAT_ORDER[i].test(str(c).trim())) return i; return CAT_ORDER.length; }
  function liveItems(b) {
    return b ? Object.keys(b.items).filter(function (id) { return !b.items[id].del; }).map(function (id) { var x = clone(b.items[id]); x.id = id; return x; })
      .sort(function (x, y) { return x.name.localeCompare(y.name); }) : [];
  }
  function catKey(c) { return str(c).trim().toLowerCase(); }
  /** The sections, in menu order, each with its dishes and its analysis. */
  function sections(b) {
    var by = {}, names = {};
    liveItems(b).forEach(function (x) { var k = catKey(x.cat); if (!by[k]) { by[k] = []; names[k] = x.cat; } by[k].push(x); });
    return Object.keys(by).sort(function (a, c) { return catRank(names[a]) - catRank(names[c]) || names[a].localeCompare(names[c]); })
      .map(function (k) { return { key: k, name: names[k], items: by[k], g: analyse(by[k]) }; });
  }
  function sectionOf(b, id) { var ss = sections(b); for (var i = 0; i < ss.length; i++) if (find(ss[i].g, id) || ss[i].items.some(function (x) { return x.id === id; })) return ss[i]; return null; }
  function putItem(b, id, it, t) { var n = clone(b); var x = clone(it); delete x.id; x.t = t; n.items[id] = x; n.t = Math.max(n.t, t); return n; }
  function removeItem(b, id, t) { var n = clone(b); n.items[id] = { del: true, t: t }; n.t = Math.max(n.t, t); return n; }
  function setPeriod(b, label, t) { var n = clone(b); n.period = { label: str(label).trim(), t: t }; n.t = Math.max(n.t, t); return n; }

  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function later(x, y) {
    if (!x) return y; if (!y) return x;
    if (x.t !== y.t) return x.t > y.t ? x : y;
    return canon(x) >= canon(y) ? x : y;
  }
  function same(a, b) { return canon(a) === canon(b); }
  function contentOf(x) { var y = clone(x); delete y.t; return y; }
  function copyIdOf(id) { return (id.slice(0, 9) + 'cp').slice(0, 13); }
  /**
   * Two copies of one menu, made one. Each dish by its own time (a removal
   * is a change like any other); the period label by its own. A dish both
   * phones changed since they last agreed (`since`, the sync base) keeps the
   * later one, and the other beside it as "<name> (other phone)" when they
   * really differ, so no typing is lost. Symmetric and idempotent.
   */
  function merge(a, b, since) {
    a = cleanBook(a).book; b = cleanBook(b).book;
    since = since || 0;
    var out = newBook(Math.max(a.t, b.t)), notes = [];
    out.period = clone(later(a.period, b.period));
    Object.keys(a.items).concat(Object.keys(b.items)).forEach(function (id) {
      if (out.items[id]) return;
      var x = a.items[id], y = b.items[id], w = later(x, y);
      out.items[id] = clone(w);
      var lose = w === x ? y : x;
      if (lose && x && y && !lose.del && !w.del && lose.t > since && w.t > since && canon(contentOf(lose)) !== canon(contentOf(w))) {
        var cid = copyIdOf(id);
        if (!a.items[cid] && !b.items[cid]) {
          var c = clone(lose); c.name = clip(lose.name, LIMITS.name - 14) + ' (other phone)';
          out.items[cid] = c;
          notes.push('Both phones changed “' + w.name + '”. The other phone’s version is kept as “' + c.name + '”.');
        }
      }
    });
    return { book: out, notes: notes };
  }

  /* ================================================================== *
   * A sales CSV, parsed on the phone, with a column mapper
   * ================================================================== */

  /** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. */
  function parseCsv(text) {
    text = str(text).replace(/^\uFEFF/, '');
    var rows = [], row = [], f = '', q = false, i = 0;
    for (; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"' && f === '') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return x.trim() !== ''; }); });
  }
  var COLS = {
    name: ['item', 'menu item', 'item name', 'name', 'dish', 'product', 'description'],
    cat: ['category', 'section', 'menu section', 'menu group', 'group', 'course', 'menu category'],
    price: ['price', 'menu price', 'unit price', 'item price'],
    cost: ['plate cost', 'cost', 'food cost', 'unit cost', 'recipe cost'],
    sold: ['units sold', 'sold', 'qty', 'quantity', 'qty sold', 'units', 'count', 'number sold', 'item count'],
  };
  var MAP_KEYS = ['name', 'cat', 'price', 'cost', 'sold'];
  var TEMPLATE = 'item,category,price,plate cost,units sold\n';
  function headKey(h) { return str(h).trim().toLowerCase().replace(/[_\s]+/g, ' ').replace(/[#:]$/, '').trim(); }
  /** The file read: its header, its rows, and a first guess at which
   *  column is which (the person can change every one). */
  function csvPlan(text) {
    if (Array.from(str(text)).length > LIMITS.csvBytes) return { error: 'That file is over 1 MB - split it.' };
    var rows = parseCsv(text);
    if (rows.length < 2) return { error: 'The file needs a header row and at least one dish.' };
    if (rows.length - 1 > LIMITS.csvRows) return { error: 'Up to ' + LIMITS.csvRows + ' rows at a time - split the file.' };
    var head = rows[0].map(function (h, i) { var l = line(h, 40); return l && !refuse(l, 40) ? l : 'Column ' + (i + 1); });
    var keys = rows[0].map(headKey), map = {}, used = {};
    MAP_KEYS.forEach(function (k) {
      var at = -1;
      COLS[k].forEach(function (n) { if (at < 0) { var i = keys.indexOf(n); if (i >= 0 && !used[i]) at = i; } });
      map[k] = at; if (at >= 0) used[at] = true;
    });
    return { head: head, rows: rows.slice(1), map: map };
  }
  /**
   * The rows, read with a column map ({name, cat, price, cost, sold} ->
   * column index or -1) against this menu. Two rows for one dish (a till
   * export by day) add their units. Each row says what it will do - add a
   * dish, update one (matched by name within its section, case ignored) -
   * or what is wrong with it. A refused name is never echoed.
   */
  function csvRows(plan, map, book) {
    if (!plan || plan.error) return { error: (plan && plan.error) || 'No file.' };
    if (!isInt(map.name) || map.name < 0) return { error: 'Pick the column with the dish names.' };
    if (!(map.price >= 0 || map.cost >= 0 || map.sold >= 0)) return { error: 'Pick at least one of the price, plate cost or units sold columns.' };
    var live = liveItems(book), byKey = {};
    live.forEach(function (x) { byKey[catKey(x.cat) + '|' + x.name.trim().toLowerCase()] = x; });
    var out = [], merged = {};
    plan.rows.forEach(function (cells, r) {
      var cell = function (k) { return map[k] >= 0 ? str(cells[map[k]]).trim() : ''; };
      var name = cell('name'), cat = cell('cat') || 'Menu', row = { row: r + 2, errors: [] };
      var np = nameProblem(name), cp = catProblem(cat);
      row.name = np ? '(refused name)' : line(name, LIMITS.name);
      row.cat = cp ? '(refused section)' : line(cat, LIMITS.cat);
      if (np) row.errors.push(np); else if (cp) row.errors.push(cp);
      ['price', 'cost', 'sold'].forEach(function (k) {
        var v = cell(k);
        if (!v) return;
        var p = k === 'sold' ? parseUnits(v) : parseMoney(v, k === 'price' ? 'The price' : 'The plate cost');
        if (p.error) row.errors.push(p.error);
        else if (k === 'price' && (p.v < 1 || p.v > LIMITS.priceMax)) row.errors.push('The price should be $0.01 to $999.99.');
        else if (k === 'cost' && p.v > LIMITS.priceMax) row.errors.push('The plate cost should be under $1,000.');
        else row[k] = p.v;
      });
      if (row.errors.length) { out.push(row); return; }
      var key = catKey(row.cat) + '|' + row.name.toLowerCase();
      if (merged[key]) {
        var m = merged[key];
        if (isInt(row.sold)) m.sold = Math.min(LIMITS.soldMax, (m.sold || 0) + row.sold);
        if (isInt(row.price)) m.price = row.price;
        if (isInt(row.cost)) m.cost = row.cost;
        m.rows.push(row.row);
        return;
      }
      var match = byKey[key];
      row.match = match ? match.id : null;
      row.rows = [row.row];
      if (!match && !isInt(row.price)) { row.errors.push('A new dish needs a price.'); out.push(row); return; }
      merged[key] = row; out.push(row);
    });
    var ok = out.filter(function (x) { return !x.errors.length; });
    return { rows: out, ok: ok.length, bad: out.length - ok.length, adds: ok.filter(function (x) { return !x.match; }).length, updates: ok.filter(function (x) { return x.match; }).length };
  }
  /** Apply the good rows: `newId()` gives each new dish its id (the page's
   *  dice - the core has none). */
  function applyRows(book, res, t, newId) {
    var b = clone(book);
    res.rows.forEach(function (x) {
      if (x.errors.length) return;
      if (x.match) {
        var cur = b.items[x.match], it = { name: cur.name, cat: cur.cat, price: cur.price, cost: cur.cost, sold: cur.sold };
        ['price', 'cost', 'sold'].forEach(function (k) { if (isInt(x[k])) it[k] = x[k]; });
        b = putItem(b, x.match, it, t);
      } else {
        b = putItem(b, newId(), { name: x.name, cat: x.cat, price: x.price, cost: isInt(x.cost) ? x.cost : null, sold: isInt(x.sold) ? x.sold : null }, t);
      }
    });
    return b;
  }
  /** A cell for a CSV: quoted when it must be; anything that could start a
   *  formula gets a leading ' (a plain number such as -1.40 is left). */
  function csvCell(v) {
    var s = str(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** The analysis as a CSV, every section. */
  function reportCsv(b) {
    var head = ['section', 'dish', 'price', 'plate_cost', 'food_cost_pct', 'contribution_margin', 'units_sold', 'menu_mix_pct', 'margin', 'popularity', 'quadrant', 'section_margin_line', 'section_popularity_line_units'];
    var lines = [head.join(',')];
    sections(b).forEach(function (s) {
      s.g.items.forEach(function (x) {
        lines.push([s.name, x.name, moneyField(x.price), moneyField(x.cost), pctField(x.foodPct), moneyField(x.cm), x.sold, pctField(x.mix), x.hiCm ? 'high' : 'low', x.hiPop ? 'high' : 'low', QUAD[x.quad].label, moneyField(s.g.avgCm), (s.g.popUnits10 / 10).toFixed(1)].map(csvCell).join(','));
      });
      s.items.filter(function (x) { return !rated(x); }).forEach(function (x) {
        lines.push([s.name, x.name, moneyField(x.price), isInt(x.cost) ? moneyField(x.cost) : '', '', '', isInt(x.sold) ? x.sold : '', '', '', '', 'not rated', '', ''].map(csvCell).join(','));
      });
    });
    return lines.join('\r\n') + '\r\n';
  }

  /* ================================================================== *
   * The AI: "Read the menu"
   * ================================================================== */

  var IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  /** The request, rebuilt: exactly {images: [{type, data}]} (one or two
   *  photos of the menu) OR exactly {text} (the menu pasted, through
   *  pasteProblem). Anything else is refused - never a price list's costs or
   *  sales, never the dishes already in Stars. */
  function menuRequest(body) {
    var bad = function (msg, code) { return { error: msg, code: code || 'bad-request' }; };
    if (!isObj(body)) return bad('Send a photo of the menu, or paste it.');
    var keys = Object.keys(body);
    if (keys.length === 1 && keys[0] === 'text') {
      if (typeof body.text !== 'string') return bad('Paste the text.', 'text');
      var why = pasteProblem(body.text);
      if (why) return bad(why, 'personal');
      return { req: { text: body.text.replace(/\r\n?/g, '\n').trim() } };
    }
    var extra = keys.filter(function (k) { return k !== 'images'; });
    if (extra.length) return bad('Only the photos, or only the pasted text, are sent - not ' + extra.slice(0, 3).map(function (x) { return line(x, 20); }).join(', ') + '.', 'extra-field');
    var ims = body.images;
    if (!Array.isArray(ims) || ims.length < 1 || ims.length > LIMITS.aiImages) return bad('Send one photo of the menu, or two.', 'image');
    var out = [];
    for (var i = 0; i < ims.length; i++) {
      var im = ims[i];
      if (!isObj(im) || Object.keys(im).sort().join() !== 'data,type') return bad('Send each photo as {type, data}.', 'image');
      if (IMAGE_TYPES.indexOf(im.type) < 0) return bad('A photo must be a JPEG, PNG or WebP.', 'image');
      if (typeof im.data !== 'string' || im.data.length < 16 || im.data.length > Math.ceil(LIMITS.aiImageBytes * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+=*$/.test(im.data)) return bad('That photo is too large or not a photo. The page shrinks it first - try again from the page.', 'image');
      out.push({ type: im.type, data: im.data });
    }
    return { req: { images: out } };
  }
  var AI_ITEM_KEYS = ['name', 'section', 'price', 'unsure'];
  /**
   * A model's reading, checked. Only {items: [{name, section, price,
   * unsure}]} is kept; any other field (a cost, units, a phone number, a
   * note) is dropped and named. A name or section through the text door; a
   * price through Stars' own money reader and range - one it cannot read
   * ("MP", "market price") is left empty and marked to check. The result is
   * FORM STRINGS for a person to confirm: a reading never sets a plate cost
   * or units sold. Nothing readable is an error.
   */
  function cleanAiMenu(raw) {
    var none = { error: 'Nothing on that page read as dishes and prices. Try a clearer photo, or type them in.', code: 'unreadable' };
    if (!isObj(raw)) return none;
    var dropped = [];
    Object.keys(raw).forEach(function (k) { if (k !== 'items') dropped.push(line(k, 24)); });
    var items = [], seen = {}, refused = 0;
    (Array.isArray(raw.items) ? raw.items.slice(0, LIMITS.aiItems) : []).forEach(function (x) {
      if (!isObj(x)) return;
      Object.keys(x).forEach(function (k) { if (AI_ITEM_KEYS.indexOf(k) < 0) dropped.push(line(k, 24)); });
      var name = typeof x.name === 'string' ? line(x.name, LIMITS.name) : '';
      if (!name) return;
      if (nameProblem(name)) { refused++; return; }
      var sec = typeof x.section === 'string' ? line(x.section, LIMITS.cat) : '';
      if (sec && catProblem(sec)) sec = '';
      var price = '', unsure = x.unsure === true;
      if (typeof x.price === 'string' && x.price.trim()) {
        var p = x.price.length <= 16 ? parseMoney(x.price.replace(/\s+/g, '')) : { error: 'x' };
        if (p.error || p.v < 1 || p.v > LIMITS.priceMax) unsure = true; else price = moneyField(p.v);
      } else unsure = true;
      var key = catKey(sec) + '|' + name.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      items.push({ name: name, cat: sec || 'Menu', price: price, unsure: unsure });
    });
    if (refused) dropped.push(plural(refused, 'dish name') + ' with a phone number, address or markup');
    if (!items.length) return none;
    return { items: items, dropped: dropped.filter(function (d, i, a) { return a.indexOf(d) === i; }).slice(0, 16) };
  }

  return {
    LIMITS: LIMITS, QUADS: QUADS, QUAD: QUAD, METHOD: METHOD, FIELDS: FIELDS, FIELD_LABEL: FIELD_LABEL, MAP_KEYS: MAP_KEYS, COLS: COLS, TEMPLATE: TEMPLATE, WHY: WHY,
    str: str, esc: esc, line: line, clip: clip, clone: clone, list: list, plural: plural, isObj: isObj, isInt: isInt,
    hasAt: hasAt, hasLink: hasLink, hasPhone: hasPhone, nineDigits: nineDigits, hasCard: hasCard, isFormula: isFormula,
    refuse: refuse, nameProblem: nameProblem, catProblem: catProblem, periodProblem: periodProblem, pasteProblem: pasteProblem,
    floorDiv: floorDiv, ceilDiv: ceilDiv, roundDiv: roundDiv, parseMoney: parseMoney, parseUnits: parseUnits, fmtMoney: fmtMoney, moneyField: moneyField, fmtUnits: fmtUnits, permille: permille, fmtPct: fmtPct, pctField: pctField,
    rated: rated, analyse: analyse, find: find, lineDelta: lineDelta, linePrice: linePrice, lineCost: lineCost, popNeeded: popNeeded, menuPrice: menuPrice, whatIf: whatIf, suggestions: suggestions,
    newBook: newBook, itemProblems: itemProblems, emptyFields: emptyFields, fieldsOf: fieldsOf, itemFrom: itemFrom, cleanBook: cleanBook, bodyProblem: bodyProblem,
    liveItems: liveItems, sections: sections, sectionOf: sectionOf, catRank: catRank, putItem: putItem, removeItem: removeItem, setPeriod: setPeriod,
    canon: canon, same: same, merge: merge, copyIdOf: copyIdOf,
    parseCsv: parseCsv, csvPlan: csvPlan, csvRows: csvRows, applyRows: applyRows, csvCell: csvCell, reportCsv: reportCsv,
    menuRequest: menuRequest, cleanAiMenu: cleanAiMenu,
  };
}));
