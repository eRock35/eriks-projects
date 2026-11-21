/* Ladle - the rules. One file, run three times: in the page
 * (window.LadleCore), in the server (require) and in the tests. No clock and
 * no dice: every time stamp and every id are passed in.
 *
 *   - the text door: what may be kept, refused (never cleaned) - an @ in any
 *     width, nine digits in any script, a phone or card number, a link, a
 *     formula, markup and invisible characters
 *   - real fractions: exact arithmetic on whole numbers, shown as cooks
 *     write them (1 ½, ⅔, 2 ⅛), "about" only when no cook's fraction is exact
 *   - units: what a card says ("1 c.", "2 T", "1 t", "8 oz") read into
 *     units, converted between US and metric, tidied after scaling
 *   - an ingredient line read into amount, unit and the rest
 *   - a recipe, scaled; oven temperatures and timers found in its steps
 *   - the shopping list across recipes: like lines added up, by aisle
 *   - the one door for a whole box (cleanBox) and bodyProblem
 *   - two phones: the merge
 *   - the AI: "Type it up" - the request rebuilt to the photos alone, the
 *     answer checked (only recipe fields; no names, no nutrition, no links)
 *   - a fresh card to print
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LadleCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    title: 80, from: 60, notes: 600, item: 120, step: 400, extra: 80, tag: 24,
    ingredients: 60, steps: 40, recipes: 250, extras: 60, serves: 48,
    storedBytes: 600 * 1024,
    aiImages: 2, aiImageBytes: 1.5 * 1024 * 1024, aiImageSide: 1600, aiDropped: 16,
  };

  /* ================================================================== *
   * Text
   * ================================================================== */

  // Control characters, bidi overrides and zero-width characters: built from
  // code points so no invisible character ever sits in this file. (Tab and
  // newline are allowed: notes and steps have line breaks.)
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
  /** One line: invisible characters and markup gone, spaces collapsed,
   *  bounded. For reading back what was already checked - never instead of
   *  a refusal. */
  function line(v, max) { return clip(noMarkup(str(v).replace(BAD, '')).replace(/\s+/g, ' ').trim(), max || 200); }
  /** Several lines kept (notes): each line tidied, at most two blank lines. */
  function lines(v, max) { return clip(noMarkup(str(v).replace(/\r\n?/g, '\n').replace(BAD, '')).split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); }).join('\n').replace(/\n{3,}/g, '\n\n').trim(), max || 600); }
  function nf(s) { s = str(s); try { return s.normalize('NFKC'); } catch (e) { return s; } }
  /** For matching: lower case, accents off, letters and digits only. */
  function fold(s) { var t = nf(s).toLowerCase(); try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* old engines */ } return t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
  function isObj(o) { return Boolean(o) && typeof o === 'object' && !Array.isArray(o); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function list(xs) { return xs.length <= 1 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  var AT_ANY = new RegExp('[@' + String.fromCharCode(0xFF20, 0xFE6B) + ']');
  function hasAt(s) { return AT_ANY.test(str(s)) || /@/.test(nf(s)); }
  var LINK = /(https?:|ftp:|mailto:|www\.|:\/\/|\b[a-z0-9-]{2,}\.(com|net|org|io|co|uk|us|app|dev|ly|me|info|biz|tv|gg|xyz|shop|store|site|online|link|recipes|kitchen|cooking|food)\b)/i;
  function hasLink(s) { return LINK.test(nf(s)); }
  /** Seven or more digits - in any script - in one run of digits and phone
   *  punctuation. ("1 1/2 cups" is three digits; a phone number is ten.) */
  function hasPhone(s) { return (nf(s).match(/\+?\p{Nd}[\p{Nd} ().\/-]{5,}\p{Nd}/gu) || []).some(function (m) { return m.replace(/\p{Nd}{1,2}\/\p{Nd}{1,2}(?!\p{Nd})/gu, ' ').replace(/[^\p{Nd}]/gu, '').length >= 7; }); }
  /** Nine digits in a row, in any script (NFKC folds the full-width ones;
   *  \p{Nd} catches Arabic-Indic, Devanagari and the rest). */
  function nineDigits(s) { return /\p{Nd}{9,}/u.test(nf(s)); }
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
   *  letter or a bracket. ("- 2 cups flour", a dash and a space, is a card's
   *  bullet, and is fine.) */
  function isFormula(s) { s = str(s); return /^[\t\r]/.test(s) || /^\s*[=@]/.test(nf(s)) || /^\s*[+\-][^\s\p{Nd}.]/u.test(nf(s)); }
  function hasInvisible(s) { return BAD1.test(str(s)); }
  function hasMarkup(s) { return /[<>]/.test(str(s)); }

  var WHY = {
    invisible: 'That has an invisible character in it - type it again.',
    markup: 'Leave out < and > - Ladle keeps plain words.',
    at: 'That looks like an email address - Ladle never keeps one.',
    link: 'That looks like a link - Ladle keeps plain words.',
    formula: 'Start it with a letter or a number - a leading = + - or @ is how a spreadsheet runs a formula.',
    card: 'That looks like a card number - never write one down here.',
    phone: 'That looks like a phone number - keep those in your contacts.',
    nine: 'Nine digits in a row looks like a phone or account number - Ladle never keeps one.',
  };
  /** The text door: '' when `s` may be kept, else the sentence that says why
   *  not. Refused, never cleaned - a person re-types it. */
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

  /* ================================================================== *
   * Real fractions: [numerator, denominator], whole numbers, reduced
   * ================================================================== */

  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = b; b = a % b; a = t; } return a || 1; }
  function Q(n, d) {
    d = d === undefined ? 1 : d;
    if (d < 0) { n = -n; d = -d; }
    var g = gcd(n, d);
    return [n / g, d / g];
  }
  function qadd(a, b) { return Q(a[0] * b[1] + b[0] * a[1], a[1] * b[1]); }
  function qmul(a, b) { return Q(a[0] * b[0], a[1] * b[1]); }
  function qdiv(a, b) { return Q(a[0] * b[1], a[1] * b[0]); }
  function qnum(a) { return a[0] / a[1]; }
  function qeq(a, b) { return a[0] === b[0] && a[1] === b[1]; }
  /** A fraction that is safe to keep: whole numbers, a small denominator. */
  function isQ(v) { return Array.isArray(v) && v.length === 2 && v.every(function (x) { return typeof x === 'number' && Math.round(x) === x; }) && v[0] >= 0 && v[1] >= 1 && v[1] <= 1000 && v[0] <= 1e6; }

  // How cooks write fractions. Exact when the denominator is one of these.
  var GLYPH = { '1/2': '½', '1/3': '⅓', '2/3': '⅔', '1/4': '¼', '3/4': '¾', '1/8': '⅛', '3/8': '⅜', '5/8': '⅝', '7/8': '⅞', '1/5': '⅕', '2/5': '⅖', '3/5': '⅗', '4/5': '⅘', '1/6': '⅙', '5/6': '⅚' };
  var GLYPH_BACK = {};
  Object.keys(GLYPH).forEach(function (k) { GLYPH_BACK[GLYPH[k]] = k; });
  GLYPH_BACK['⅐'] = '1/7'; GLYPH_BACK['⅑'] = '1/9'; GLYPH_BACK['⅒'] = '1/10';
  var FRIENDLY = [1, 2, 3, 4, 8];
  function friendly(q) { return FRIENDLY.indexOf(q[1]) >= 0; }
  /** The nearest eighth or third - whichever is nearer - and whether that
   *  was a rounding. A small amount never rounds to nothing: it becomes ⅛. */
  function nearest(q) {
    if (friendly(q)) return { q: q, about: false };
    var x = qnum(q);
    var e = Q(Math.round(x * 8), 8), t = Q(Math.round(x * 3), 3);
    var best = Math.abs(qnum(e) - x) <= Math.abs(qnum(t) - x) ? e : t;
    if (best[0] === 0) best = Q(1, 8);
    return { q: best, about: true };
  }
  /** "1 ½", "⅔", "3", "2 ⅛". A denominator cooks do not use is shown as
   *  digits ("1 5/16") - nearest() decides before this whether to round. */
  function fracText(q) {
    var whole = Math.floor(q[0] / q[1]), rest = q[0] - whole * q[1];
    if (!rest) return String(whole);
    var key = rest + '/' + q[1], f = GLYPH[key] || key;
    return whole ? whole + ' ' + f : f;
  }
  /** A decimal written on a card - 0.5, 1.25, .75 - as a fraction. */
  function decQ(s) {
    var m = /^(\d*)\.(\d{1,3})$/.exec(s);
    if (!m) return null;
    var d = Math.pow(10, m[2].length);
    return Q(Number(m[1] || 0) * d + Number(m[2]), d);
  }
  /** One amount as written: "1", "1/2", "1 1/2", "1½", "½", "0.75", "1-1/2"
   *  (an old card's mixed number). null when it is not one. */
  function parseAmount(s) {
    s = str(s).trim().replace(/[⅐-⅞½¼¾]/g, function (g) { return ' ' + (GLYPH_BACK[g] || '') + ' '; }).replace(/\s+/g, ' ').trim();
    var m;
    if ((m = /^(\d{1,4})$/.exec(s))) return Q(+m[1]);
    if ((m = /^(\d{1,3})\/(\d{1,3})$/.exec(s)) && +m[2] > 0) return Q(+m[1], +m[2]);
    if ((m = /^(\d{1,4})(?: |-)(\d{1,3})\/(\d{1,3})$/.exec(s)) && +m[3] > 0 && +m[2] < +m[3]) return qadd(Q(+m[1]), Q(+m[2], +m[3]));
    return decQ(s);
  }

  /* ================================================================== *
   * Units
   * ================================================================== */

  // Volumes in teaspoons and weights in ounces, exactly, so US amounts add
  // and scale as fractions; ml and g for metric. A count unit (a can, a
  // clove) never converts.
  var UNITS = {
    tsp: { dim: 'vol', us: Q(1), ml: 4.92892, one: 'tsp', many: 'tsp', name: 'teaspoon' },
    tbsp: { dim: 'vol', us: Q(3), ml: 14.7868, one: 'tbsp', many: 'tbsp', name: 'tablespoon' },
    floz: { dim: 'vol', us: Q(6), ml: 29.5735, one: 'fl oz', many: 'fl oz', name: 'fluid ounce' },
    cup: { dim: 'vol', us: Q(48), ml: 236.588, one: 'cup', many: 'cups', name: 'cup' },
    pint: { dim: 'vol', us: Q(96), ml: 473.176, one: 'pint', many: 'pints', name: 'pint' },
    quart: { dim: 'vol', us: Q(192), ml: 946.353, one: 'quart', many: 'quarts', name: 'quart' },
    gallon: { dim: 'vol', us: Q(768), ml: 3785.41, one: 'gallon', many: 'gallons', name: 'gallon' },
    ml: { dim: 'vol', metric: 1, one: 'ml', many: 'ml', name: 'millilitre' },
    l: { dim: 'vol', metric: 1000, one: 'l', many: 'l', name: 'litre' },
    oz: { dim: 'mass', us: Q(1), g: 28.3495, one: 'oz', many: 'oz', name: 'ounce' },
    lb: { dim: 'mass', us: Q(16), g: 453.592, one: 'lb', many: 'lb', name: 'pound' },
    g: { dim: 'mass', metric: 1, one: 'g', many: 'g', name: 'gram' },
    kg: { dim: 'mass', metric: 1000, one: 'kg', many: 'kg', name: 'kilogram' },
    stick: { dim: '', one: 'stick', many: 'sticks', name: 'stick' },
    can: { dim: '', one: 'can', many: 'cans', name: 'can' },
    pkg: { dim: '', one: 'package', many: 'packages', name: 'package' },
    clove: { dim: '', one: 'clove', many: 'cloves', name: 'clove' },
    pinch: { dim: '', one: 'pinch', many: 'pinches', name: 'pinch' },
    dash: { dim: '', one: 'dash', many: 'dashes', name: 'dash' },
    bunch: { dim: '', one: 'bunch', many: 'bunches', name: 'bunch' },
    slice: { dim: '', one: 'slice', many: 'slices', name: 'slice' },
    head: { dim: '', one: 'head', many: 'heads', name: 'head' },
    sprig: { dim: '', one: 'sprig', many: 'sprigs', name: 'sprig' },
    jar: { dim: '', one: 'jar', many: 'jars', name: 'jar' },
    box: { dim: '', one: 'box', many: 'boxes', name: 'box' },
  };
  var UNIT_IDS = Object.keys(UNITS);
  // What cards say. Case matters for one pair only: an old card's capital T
  // is a tablespoon and its small t a teaspoon.
  var ALIAS = {
    T: 'tbsp', Tb: 'tbsp', Tbs: 'tbsp', TB: 'tbsp', TBS: 'tbsp', TBSP: 'tbsp', Tbsp: 'tbsp', t: 'tsp', ts: 'tsp', TSP: 'tsp', Tsp: 'tsp', C: 'cup',
  };
  var ALIAS_LOWER = {
    teaspoon: 'tsp', teaspoons: 'tsp', tsp: 'tsp', tsps: 'tsp', tea: 'tsp',
    tablespoon: 'tbsp', tablespoons: 'tbsp', tbsp: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tbl: 'tbsp', tbls: 'tbsp',
    cup: 'cup', cups: 'cup', c: 'cup',
    'fl oz': 'floz', 'fl. oz': 'floz', 'fluid ounce': 'floz', 'fluid ounces': 'floz',
    pint: 'pint', pints: 'pint', pt: 'pint', pts: 'pint',
    quart: 'quart', quarts: 'quart', qt: 'quart', qts: 'quart',
    gallon: 'gallon', gallons: 'gallon', gal: 'gallon',
    ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
    l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
    oz: 'oz', ounce: 'oz', ounces: 'oz',
    lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', '#': 'lb',
    g: 'g', gram: 'g', grams: 'g', gr: 'g', kg: 'kg', kilogram: 'kg', kilograms: 'kg',
    stick: 'stick', sticks: 'stick', can: 'can', cans: 'can', package: 'pkg', packages: 'pkg', pkg: 'pkg', pkgs: 'pkg',
    clove: 'clove', cloves: 'clove', pinch: 'pinch', pinches: 'pinch', dash: 'dash', dashes: 'dash',
    bunch: 'bunch', bunches: 'bunch', slice: 'slice', slices: 'slice', head: 'head', heads: 'head', sprig: 'sprig', sprigs: 'sprig',
    jar: 'jar', jars: 'jar', box: 'box', boxes: 'box',
  };
  /** A unit word as a card writes it ("c.", "T", "Tbsp", "lbs."), or ''. */
  function unitOf(word) {
    var w = str(word).trim().replace(/\.$/, '');
    if (!w) return '';
    if (Object.prototype.hasOwnProperty.call(ALIAS, w)) return ALIAS[w];
    var l = w.toLowerCase().replace(/\.\s*/g, '. ').replace(/\.$/, '').replace(/\. /g, ' ').trim();
    return Object.prototype.hasOwnProperty.call(ALIAS_LOWER, l) ? ALIAS_LOWER[l] : '';
  }
  function unitText(u, q) { var x = UNITS[u]; if (!x) return ''; return q && qnum(q) > 1 ? x.many : x.one; }

  /* ================================================================== *
   * An ingredient line
   *
   *   {q: [n, d] | null, q2: [n, d] | null, unit: '' | unit id, item}
   *
   * q2 is the top of a range ("2 to 3 apples"). Anything the reader does
   * not understand stays in `item`, word for word - nothing is lost.
   * ================================================================== */

  var AMOUNT = '(?:\\d{1,4}(?:[ -]\\d{1,3}\\/\\d{1,3}|\\/\\d{1,3}|\\.\\d{1,3})?|\\d{0,4}\\s?[⅐-⅞½¼¾]|\\.\\d{1,3})';
  var LEAD = new RegExp('^(' + AMOUNT + ')(?:\\s*(?:-|–|to|or)\\s*(' + AMOUNT + '))?(?=\\s|$|[a-zA-Z(])\\s*');
  function parseIngredient(text) {
    var s = line(text, LIMITS.item + 40).replace(/^[-•*·]\s+/, '').trim();
    var out = { q: null, q2: null, unit: '', item: '' };
    var m = LEAD.exec(s);
    if (m) {
      var a = parseAmount(m[1]), b = m[2] ? parseAmount(m[2]) : null;
      if (a && (!m[2] || (b && qnum(b) > qnum(a)))) {
        out.q = a; out.q2 = b; s = s.slice(m[0].length);
        // "1 (15 oz) can pumpkin": the can is the unit, the size goes after.
        var sized = /^\(([^()]{1,24})\)\s*([A-Za-z]+\.?)(?=\s|$|,)\s*/.exec(s);
        if (sized && unitOf(sized[2]) && !UNITS[unitOf(sized[2])].dim) {
          out.unit = unitOf(sized[2]);
          out.item = line(s.slice(sized[0].length) + ' (' + sized[1] + ')', LIMITS.item);
          return out;
        }
        // "fl oz" and "fl. oz." are two words; everything else is one.
        var two = /^(fl\.?\s*oz\.?|fluid ounces?)(?=\s|$|[,(])/i.exec(s);
        var u = two ? unitOf(two[1].replace(/\s+/g, ' ')) || 'floz' : '';
        var w = two ? two[0] : (/^([A-Za-z#]+\.?)(?=\s|$|[,(])/.exec(s) || [])[0];
        if (!u && w) u = unitOf(w);
        if (u) s = s.slice(w.length).replace(/^\s*of\s+/i, '').trim();
        out.unit = u;
      }
    }
    out.item = line(s, LIMITS.item);
    return out;
  }
  /** An ingredient as text, the way it was read: "1 ½ cups flour". */
  function amountText(q, q2) { return q ? fracText(q) + (q2 ? '-' + fracText(q2) : '') : ''; }
  function ingredientText(ing) {
    var a = amountText(ing.q, ing.q2);
    return [a, ing.unit ? unitText(ing.unit, ing.q2 || ing.q) : '', ing.item].filter(Boolean).join(' ');
  }

  /* ================================================================== *
   * Scaling and converting
   * ================================================================== */

  function round(x, step) { return Math.round(x / step) * step; }
  function trimNum(x) { return String(Math.round(x * 100) / 100); }
  /** A metric amount, rounded the way a metric recipe would say it. */
  function metricText(x, dim) {
    var small = dim === 'vol' ? 'ml' : 'g', big = dim === 'vol' ? 'l' : 'kg';
    if (x >= 1000) return { n: trimNum(x / 1000), unit: big };
    var r = x < 10 ? Math.round(x * 2) / 2 : x < 100 ? Math.round(x) : x < 250 ? round(x, 5) : round(x, 10);
    if (r === 0) r = 0.5;
    return { n: trimNum(r), unit: small };
  }
  /** A US volume in teaspoons, said in the unit that reads best: cups from a
   *  quarter cup, tablespoons from one, teaspoons below - exact when a cook's
   *  fraction fits, else "1 cup + 2 tbsp", else the nearest eighth. */
  function usVolume(tsp) {
    var x = qnum(tsp);
    // From a quarter cup up, teaspoons are never the answer ("50 ¾ tsp").
    var order = x >= 12 ? ['cup', 'tbsp'] : x >= 3 ? ['tbsp', 'tsp'] : ['tsp'];
    // The unit that reads best first; below a cup, the next one down too
    // (5 tsp stays 5 tsp, never 1 ⅔ tbsp).
    for (var i = 0; i < (order[0] === 'cup' ? 1 : order.length); i++) {
      var q = qdiv(tsp, UNITS[order[i]].us);
      if (friendly(q) && (order[i] !== 'tbsp' || q[1] <= 2)) return { parts: [{ q: q, unit: order[i] }], about: false };
    }
    // A whole number of the big unit and the rest in the next one.
    if (order.length > 1) {
      var big = order[0], small = order[1];
      var whole = Math.floor(qnum(qdiv(tsp, UNITS[big].us)));
      if (whole >= 1) {
        var rest = qdiv(qadd(tsp, Q(-whole * UNITS[big].us[0], UNITS[big].us[1])), UNITS[small].us);
        if (friendly(rest) && (small !== 'tbsp' || rest[1] <= 2)) return { parts: [{ q: Q(whole), unit: big }, { q: rest, unit: small }], about: false };
      }
    }
    var n = nearest(qdiv(tsp, UNITS[order[0]].us));
    return { parts: [{ q: n.q, unit: order[0] }], about: n.about };
  }
  /** A US weight in ounces: pounds from one pound. */
  function usMass(oz) {
    if (qnum(oz) >= 16) { var lb = qdiv(oz, Q(16)); if (friendly(lb)) return { parts: [{ q: lb, unit: 'lb' }], about: false }; var n = nearest(lb); return { parts: [{ q: n.q, unit: 'lb' }], about: n.about }; }
    var o = nearest(oz);
    return { parts: [{ q: o.q, unit: 'oz' }], about: o.about };
  }
  /** Turn a float US amount (from metric) into teaspoons or ounces to the
   *  nearest eighth, for usVolume / usMass. */
  function floatQ(x) { return Q(Math.max(1, Math.round(x * 8)), 8); }

  /**
   * One amount of one unit, scaled by `k` and shown in `mode`:
   *   'written' - the card's own unit, but a US volume that scales into an
   *               awkward fraction is re-said (¼ cup x ¼ is 1 tbsp);
   *   'us'      - cups, tablespoons, teaspoons, ounces and pounds;
   *   'metric'  - ml, l, g and kg, rounded as a metric recipe would.
   * Returns {text, about}; text is '' when there is no amount.
   */
  function amountIn(q, unit, k, mode) {
    if (!q) return { text: '', about: false, parts: [] };
    var u = UNITS[unit], x = qmul(q, k);
    var said = function (r) { return { text: r.parts.map(function (p) { return fracText(p.q) + ' ' + unitText(p.unit, p.q); }).join(' + '), about: r.about, parts: r.parts }; };
    if (!u || !u.dim) {
      var n = nearest(x);
      return { text: fracText(n.q) + (u ? ' ' + unitText(unit, n.q) : ''), about: n.about, parts: [{ q: n.q, unit: unit }] };
    }
    var isUS = Boolean(u.us);
    if (mode === 'metric') {
      var base = isUS ? qnum(x) * (u.dim === 'vol' ? u.ml : u.g) : qnum(x) * u.metric;
      var mt = metricText(base, u.dim);
      return { text: mt.n + ' ' + mt.unit, about: isUS, parts: [] };
    }
    if (mode === 'us' && !isUS) {
      var b = qnum(x) * u.metric;
      var r = u.dim === 'vol' ? usVolume(floatQ(b / UNITS.tsp.ml)) : usMass(floatQ(b / UNITS.oz.g));
      r.about = true;
      return said(r);
    }
    if (!isUS) { var m = metricText(qnum(x) * u.metric, u.dim); return { text: m.n + ' ' + m.unit, about: false, parts: [] }; }
    // Scaled, a US volume is tidied the way a cook would say it: 4 tbsp is
    // ¼ cup, 3 tsp is 1 tbsp, ⅛ cup is 2 tbsp. As written (k = 1) it stays.
    var tsp = u.dim === 'vol' ? qnum(qmul(x, u.us)) : 0, scaled = !qeq(k, Q(1));
    var untidy = u.dim === 'vol' && scaled && ((unit === 'tsp' && tsp >= 3) || (unit === 'tbsp' && (tsp >= 12 || tsp < 3)) || (UNITS[unit].us[0] >= 48 && tsp < 12));
    if (mode === 'us' || !friendly(x) || untidy) {
      return said(u.dim === 'vol' ? usVolume(qmul(x, u.us)) : usMass(qmul(x, u.us)));
    }
    return { text: fracText(x) + ' ' + unitText(unit, x), about: false, parts: [{ q: x, unit: unit }] };
  }
  /** An ingredient line, scaled and converted: {amount, item, about}. */
  function scaleIngredient(ing, k, mode) {
    var a = amountIn(ing.q, ing.unit, k, mode);
    var text = a.text;
    if (ing.q2) {
      var b = amountIn(ing.q2, ing.unit, k, mode);
      // "2-3 cups" - the unit said once, when both ends landed in one unit.
      var unitA = a.text.replace(/^[\d ⅐-⅞½¼¾/.]+/, ''), unitB = b.text.replace(/^[\d ⅐-⅞½¼¾/.]+/, '');
      text = unitA === unitB && a.parts.length < 2 && b.parts.length < 2 ? a.text.slice(0, a.text.length - unitA.length).trim() + '-' + b.text : a.text + ' to ' + b.text;
      a.about = a.about || b.about;
    }
    return { amount: text, item: ing.item, about: a.about };
  }
  /** The scale factor from servings: the card's to yours. */
  function factor(serves, want) { return serves && want ? Q(want, serves) : Q(1); }

  /** Oven temperatures in a step, with the other scale beside them:
   *  "350°F" -> "350°F (175°C)". Rounded to 5 degrees, as ovens are. */
  var TEMP = /(\d{2,3})\s?(?:°\s?|º\s?|\s?degrees?\s?)(F|C|Fahrenheit|Celsius)?(?![A-Za-z]|\s*\()/gi;
  function withTemps(text, mode) {
    if (mode === 'written') return text;
    return str(text).replace(TEMP, function (all, n, scale) {
      var deg = Number(n), sc = (scale || 'F').charAt(0).toUpperCase();
      if (sc === 'F' && deg >= 200 && deg <= 550 && mode === 'metric') return all + ' (' + round((deg - 32) * 5 / 9, 5) + '°C)';
      if (sc === 'C' && deg >= 90 && deg <= 290 && mode === 'us') return all + ' (' + round(deg * 9 / 5 + 32, 5) + '°F)';
      return all;
    });
  }
  /** Timers a step asks for: "bake 25-30 minutes" offers 25 (check at the
   *  low end), "1 1/2 hours" 90, "an hour" 60. Seconds are bounded to a day. */
  var TIME = /(\d{1,3}(?:\s+\d\/\d|\/\d)?|an?|one|half an?)\s*(?:(?:-|–|to|or)\s*\d{1,3}\s*)?(hours?|hrs?|minutes?|mins?)\b/gi;
  function timers(text) {
    var out = [], m;
    TIME.lastIndex = 0;
    while ((m = TIME.exec(str(text))) && out.length < 4) {
      var w = m[1].toLowerCase(), n;
      if (w === 'a' || w === 'an' || w === 'one') n = 1;
      else if (/^half/.test(w)) n = 0.5;
      else { var q = parseAmount(w); n = q ? qnum(q) : 0; }
      var mins = /^h/i.test(m[2]) ? n * 60 : n;
      if (mins >= 1 && mins <= 1440) {
        mins = Math.round(mins);
        if (!out.some(function (t) { return t.mins === mins; })) out.push({ mins: mins, label: minsText(mins) });
      }
    }
    return out;
  }
  function minsText(m) { if (m < 60) return m + ' min'; var h = Math.floor(m / 60), r = m % 60; return h + ' hr' + (r ? ' ' + r + ' min' : ''); }
  /** "4:05" / "1:02:09" */
  function clockText(secs) {
    secs = Math.max(0, Math.ceil(secs));
    var h = Math.floor(secs / 3600), mm = Math.floor(secs / 60) % 60, ss = secs % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + p(mm) + ':' + p(ss) : mm + ':' + p(ss);
  }

  /* ================================================================== *
   * The shopping list across recipes
   * ================================================================== */

  // Aisles, by the words in a line. First match wins; listed in shop order.
  var AISLES = [
    ['produce', 'Fruit and vegetables', /\b(apples?|bananas?|lemons?|limes?|oranges?|zest|berr(y|ies)|cranberr|grapes?|pears?|peach(es)?|onions?|shallots?|garlic|celery|carrots?|potato(es)?|sweet potato|yams?|squash|pumpkins?|lettuce|spinach|kale|cabbage|parsley|cilantro|basil|thyme|rosemary|sage|chives|dill|mint|scallions?|green onions?|leeks?|tomato(es)?|peppers?|jalape|mushrooms?|beans? sprouts|cucumbers?|zucchini|corn on|avocados?|ginger root|fresh ginger|herbs?)\b/],
    ['dairy', 'Dairy and eggs', /\b(milk|buttermilk|cream|half and half|half-and-half|butter|cheese|cheddar|parmesan|mozzarella|ricotta|yogh?urt|sour cream|eggs?|egg yolks?|egg whites?)\b/],
    ['meat', 'Meat and fish', /\b(chicken|turkey|beef|pork|bacon|ham|sausages?|lamb|veal|ground|fish|salmon|tuna|shrimp|prawns?|stock|broth)\b/],
    ['bread', 'Bread', /\b(bread|rolls?|buns?|cornbread|tortillas?|crackers?|breadcrumbs?|bread crumbs?|stuffing)\b/],
    ['baking', 'Baking', /\b(flour|sugar|brown sugar|powdered sugar|baking powder|baking soda|soda|yeast|cornmeal|corn meal|cornstarch|cocoa|chocolate|chips|vanilla|extract|shortening|molasses|syrup|honey|marshmallows?|pecans?|walnuts?|almonds?|nuts?|raisins?|coconut|oats|evaporated milk|condensed milk|pie crust|pastry)\b/],
    ['spices', 'Spices', /\b(salt|pepper|cinnamon|nutmeg|cloves? ground|ground cloves?|allspice|ginger|paprika|cumin|chili powder|chilli powder|oregano|bay leaf|bay leaves|mustard powder|cayenne|seasoning|spice)\b/],
    ['pantry', 'Pantry', /\b(oil|olive oil|vinegar|beans?|rice|pasta|noodles|tomato paste|tomato sauce|canned|soup|ketchup|mustard|mayonnaise|mayo|soy sauce|worcestershire|sauce|jam|jelly|peanut butter|lentils?)\b/],
    ['frozen', 'Frozen', /\b(frozen|ice cream)\b/],
  ];
  var AISLE_IDS = AISLES.map(function (a) { return a[0]; }).concat(['other']);
  var AISLE_NAMES = {}; AISLES.forEach(function (a) { AISLE_NAMES[a[0]] = a[1]; }); AISLE_NAMES.other = 'Everything else';
  function aisleOf(item) {
    var t = fold(item);
    if (/\b(frozen)\b/.test(t)) return 'frozen';
    // An "evaporated milk" is baking, not dairy; "ground beef" is meat; "ground
    // cinnamon" a spice.
    if (/\b(evaporated|condensed) milk\b/.test(t)) return 'baking';
    if (/\bground (cinnamon|nutmeg|ginger|cloves|allspice|pepper|cumin)\b/.test(t) || /\bdried (sage|thyme|rosemary|oregano|basil|parsley|dill|mint|herbs?)\b/.test(t) || /\b(black|white) pepper\b|\bpeppercorns?\b/.test(t)) return 'spices';
    for (var i = 0; i < AISLES.length; i++) if (AISLES[i][2].test(t)) return AISLES[i][0];
    return 'other';
  }
  // Words a list line can do without: how the card wants it cut or measured.
  var PREP = /,.*$|\b(chopped|diced|minced|sliced|grated|shredded|melted|softened|beaten|divided|packed|sifted|cubed|peeled|cooked|crushed|mashed|crumbled|torn|warm|unbaked|toasted|finely|roughly|coarsely|fresh(ly)?|large|medium|small|room temperature|at room temperature|to taste|for serving|optional|plus more)\b|\(.*?\)/gi;
  function singular(w) { return w.replace(/(ies)$/, 'y').replace(/(oes|ches|shes|sses)$/, function (x) { return x.slice(0, -2); }).replace(/([^s])s$/, '$1'); }
  /** The key two recipes' lines share when they are the same thing to buy. */
  function shopKey(item) {
    var t = fold(str(item).replace(PREP, ' '));
    return t.split(' ').filter(Boolean).map(singular).join(' ') || fold(item);
  }
  /** The name to show for a merged line: the shortest wording used. */
  function shopName(items) { return items.slice().sort(function (a, b) { return a.length - b.length || (a < b ? -1 : 1); })[0]; }

  /**
   * One list from the recipes picked, each at its own scale. Lines for the
   * same thing in the same kind of measure are added up exactly (US
   * volumes in teaspoons, weights in ounces, metric in ml and g, counts by
   * their unit); a line with no amount ("salt") is listed once. Grouped by
   * aisle, in shop order. `ticks` marks what is already in the trolley or
   * the cupboard; `extra` is what was typed by hand.
   */
  function shopping(box, mode) {
    mode = mode || 'written';
    var lines2 = {}, order = [];
    Object.keys(box.shop.plan).sort().forEach(function (rid) {
      var p = box.shop.plan[rid], r = box.recipes[rid];
      if (!p || !p.on || !r || r.del) return;
      r.ingredients.forEach(function (ing) {
        if (!ing.item) return;
        var u = UNITS[ing.unit], dim = u ? (u.dim || 'n:' + ing.unit) : 'n:';
        var sys = u && u.dim ? (u.us ? 'us' : 'metric') : '';
        var key = shopKey(ing.item) + '|' + (ing.q ? dim : '-');
        var L = lines2[key];
        if (!L) { L = lines2[key] = { key: key, items: [], from: [], usQ: null, metric: 0, sys: {}, dim: dim, unit: u && !u.dim ? ing.unit : '', count: null, any: false, none: false }; order.push(key); }
        L.items.push(ing.item);
        if (L.from.indexOf(r.title) < 0) L.from.push(r.title);
        if (!ing.q) { L.none = true; return; }
        var k = isQ(p.k) ? p.k : Q(1);
        var top = ing.q2 || ing.q, x = qmul(top, k);
        L.any = true;
        if (u && u.dim) {
          L.sys[sys] = true;
          if (u.us) L.usQ = L.usQ ? qadd(L.usQ, qmul(x, u.us)) : qmul(x, u.us);
          L.metric += u.us ? qnum(x) * (u.dim === 'vol' ? u.ml : u.g) : qnum(x) * u.metric;
        } else {
          L.count = L.count ? qadd(L.count, x) : x;
        }
      });
    });
    // "Salt to taste" beside "1 tsp salt": one line, "and a little more".
    order = order.filter(function (key) {
      if (!/\|-$/.test(key)) return true;
      var stem = key.slice(0, -1), into = order.filter(function (k) { return k !== key && k.indexOf(stem) === 0; })[0];
      if (!into) return true;
      var L = lines2[key], M = lines2[into];
      M.none = true; M.items = M.items.concat(L.items);
      L.from.forEach(function (f) { if (M.from.indexOf(f) < 0) M.from.push(f); });
      return false;
    });
    var rows = order.map(function (key) {
      var L = lines2[key], amount = '', about = false;
      if (L.any) {
        if (L.dim === 'vol' || L.dim === 'mass') {
          var useMetric = mode === 'metric' || (mode !== 'us' && !L.sys.us);
          if (useMetric) { var mt = metricText(L.metric, L.dim); amount = mt.n + ' ' + mt.unit; about = Boolean(L.sys.us); }
          else {
            var r = L.dim === 'vol' ? usVolume(L.usQ && !L.sys.metric ? L.usQ : floatQ(L.metric / UNITS.tsp.ml)) : usMass(L.usQ && !L.sys.metric ? L.usQ : floatQ(L.metric / UNITS.oz.g));
            amount = r.parts.map(function (p) { return fracText(p.q) + ' ' + unitText(p.unit, p.q); }).join(' + ');
            about = r.about || Boolean(L.sys.metric);
          }
        } else {
          var n = nearest(L.count);
          amount = fracText(n.q) + (L.unit ? ' ' + unitText(L.unit, n.q) : '');
          about = n.about;
        }
      }
      var name = shopName(L.items).replace(/\s*,.*$/, '');
      var aisle = aisleOf(name);
      if (aisle === 'produce' && /^(can|jar|box|pkg)$/.test(L.unit)) aisle = 'pantry';
      return { key: key, amount: amount, about: about, name: name, plus: L.none && L.any, from: L.from, aisle: aisle, on: Boolean(box.shop.ticks[key] && box.shop.ticks[key].on), extra: false };
    });
    Object.keys(box.shop.extra).sort().forEach(function (id) {
      var x = box.shop.extra[id];
      if (!x || x.del) return;
      var tk = 'x:' + id;
      rows.push({ key: tk, amount: '', about: false, name: x.text, plus: false, from: [], aisle: aisleOf(x.text), on: Boolean(box.shop.ticks[tk] && box.shop.ticks[tk].on), extra: true, id: id });
    });
    var groups = AISLE_IDS.map(function (a) {
      return { aisle: a, name: AISLE_NAMES[a], rows: rows.filter(function (r) { return r.aisle === a; }).sort(function (x, y) { return x.on - y.on || (fold(x.name) < fold(y.name) ? -1 : 1); }) };
    }).filter(function (g) { return g.rows.length; });
    return { groups: groups, rows: rows, left: rows.filter(function (r) { return !r.on; }).length, of: rows.length };
  }
  /** The list as plain text, to paste into a message - what is left only. */
  function shoppingText(sh, title) {
    var out = [title || 'Shopping list'];
    sh.groups.forEach(function (g) {
      var left = g.rows.filter(function (r) { return !r.on; });
      if (!left.length) return;
      out.push('', g.name);
      left.forEach(function (r) { out.push('- ' + (r.amount ? (r.about ? 'about ' : '') + r.amount + ' ' : '') + r.name + (r.plus ? ' (and a little more)' : '')); });
    });
    return out.join('\n');
  }

  /* ================================================================== *
   * The box: recipes and the shopping list
   * ================================================================== */

  var ID = { recipe: /^r[a-z0-9]{5,12}$/, extra: /^x[a-z0-9]{5,12}$/ };
  var KEY = /^(x:x[a-z0-9]{5,12}|[\p{L}\p{N} ]{1,100}\|(vol|mass|n:[a-z]*|-))$/u;
  function isTime(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && Math.round(v) === v && v < 1e14; }
  function newBox(t) { return { v: 1, recipes: {}, shop: { plan: {}, ticks: {}, extra: {} }, t: t || 0 }; }
  function newRecipe(t) { return { title: '', from: '', serves: null, ingredients: [], steps: [], notes: '', photos: 0, t: t, del: false }; }
  function keysOnly(o, ks) { return isObj(o) && Object.keys(o).every(function (k) { return ks.indexOf(k) >= 0; }); }
  function liveRecipes(box) {
    return Object.keys(box.recipes).map(function (id) { var r = clone(box.recipes[id]); r.id = id; return r; }).filter(function (r) { return !r.del; })
      .sort(function (a, b) { return fold(a.title) < fold(b.title) ? -1 : fold(a.title) > fold(b.title) ? 1 : (a.id < b.id ? -1 : 1); });
  }
  /** Search the box: every word in the title, whose it is, an ingredient or
   *  a note. */
  function search(box, q) {
    var words = fold(q).split(' ').filter(Boolean);
    if (!words.length) return liveRecipes(box);
    return liveRecipes(box).filter(function (r) {
      var hay = ' ' + fold([r.title, r.from, r.notes].concat(r.ingredients.map(function (i) { return i.item; })).join(' ')) + ' ';
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    });
  }
  /** "From Nana Dot", or "". */
  function whose(r) { return r.from ? 'From ' + r.from : ''; }

  /** A recipe as typed (the editor's fields) checked and read. {recipe, errors}.
   *  Ingredient and step lines are one per line; a blank line between steps
   *  is fine. */
  function recipeFrom(fields, t) {
    var errors = [];
    var e = function (m) { errors.push(m); };
    var title = str(fields.title).trim(), from = str(fields.from).trim(), notes = str(fields.notes);
    if (!title) e('Give it a name - “Pumpkin pie”, “Nana’s rolls”.');
    var w;
    if ((w = refuse(title, LIMITS.title))) e('The name: ' + w);
    if ((w = refuse(from, LIMITS.from))) e('Whose it is: ' + w);
    if ((w = refuse(notes, LIMITS.notes))) e('The notes: ' + w);
    var serves = str(fields.serves).trim() === '' ? null : Number(fields.serves);
    if (serves !== null && !(Math.round(serves) === serves && serves >= 1 && serves <= LIMITS.serves)) e('Serves is a whole number, 1 to ' + LIMITS.serves + ' - or leave it empty.');
    var ingLines = str(fields.ingredients).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var stepLines = str(fields.steps).split(/\r?\n/).map(function (l) { return l.trim().replace(/^(\d{1,2}[.)]|step \d{1,2}[.:)]?)\s*/i, ''); }).filter(Boolean);
    if (ingLines.length > LIMITS.ingredients) e('Up to ' + LIMITS.ingredients + ' ingredient lines.');
    if (stepLines.length > LIMITS.steps) e('Up to ' + LIMITS.steps + ' steps.');
    ingLines.forEach(function (l, i) { var why = refuse(l, LIMITS.item + 40); if (why) e('Ingredient ' + (i + 1) + ': ' + why); });
    stepLines.forEach(function (l, i) { var why = refuse(l, LIMITS.step); if (why) e('Step ' + (i + 1) + ': ' + why); });
    if (!ingLines.length && !stepLines.length) e('Add the ingredients or the steps - one per line.');
    var r = {
      title: line(title, LIMITS.title), from: line(from, LIMITS.from), serves: serves,
      ingredients: ingLines.slice(0, LIMITS.ingredients).map(parseIngredient).filter(function (i) { return i.item || i.q; }),
      steps: stepLines.slice(0, LIMITS.steps).map(function (s) { return line(s, LIMITS.step); }),
      notes: lines(notes, LIMITS.notes), photos: Math.max(0, Math.min(2, Number(fields.photos) || 0)), t: t, del: false,
    };
    r.ingredients.forEach(function (i) { if (!i.item) i.item = 'something'; });
    return { recipe: r, errors: errors };
  }
  /** The editor's fields from a recipe. */
  function fieldsOf(r) {
    return { title: r.title, from: r.from, serves: r.serves === null ? '' : String(r.serves), ingredients: r.ingredients.map(ingredientText).join('\n'), steps: r.steps.join('\n'), notes: r.notes, photos: r.photos || 0 };
  }
  function putRecipe(box, id, r) { var b = clone(box); b.recipes[id] = clone(r); return b; }
  function removeRecipe(box, id, t) {
    var b = clone(box), r = b.recipes[id];
    if (r) b.recipes[id] = { title: r.title, from: '', serves: null, ingredients: [], steps: [], notes: '', photos: 0, t: t, del: true };
    if (b.shop.plan[id]) b.shop.plan[id] = { on: false, k: [1, 1], t: t };
    return b;
  }
  /** Put a recipe on the shopping list at scale k (a fraction), or take it off. */
  function planRecipe(box, id, on, k, t) { var b = clone(box); b.shop.plan[id] = { on: Boolean(on), k: isQ(k) && k[0] > 0 ? Q(k[0], k[1]) : [1, 1], t: t }; return b; }
  function tick(box, key, on, t) { var b = clone(box); b.shop.ticks[key] = { on: Boolean(on), t: t }; return b; }
  function addExtra(box, id, text, t) { var b = clone(box); b.shop.extra[id] = { text: line(text, LIMITS.extra), t: t, del: false }; return b; }
  function removeExtra(box, id, t) { var b = clone(box); if (b.shop.extra[id]) { b.shop.extra[id] = { text: b.shop.extra[id].text, t: t, del: true }; } return b; }
  /** A fresh start for the list: every tick cleared, every recipe taken off. */
  function clearList(box, t) {
    var b = clone(box);
    Object.keys(b.shop.plan).forEach(function (id) { b.shop.plan[id] = { on: false, k: b.shop.plan[id].k, t: t }; });
    Object.keys(b.shop.ticks).forEach(function (k) { b.shop.ticks[k] = { on: false, t: t }; });
    Object.keys(b.shop.extra).forEach(function (id) { if (!b.shop.extra[id].del) b.shop.extra[id] = { text: b.shop.extra[id].text, t: t, del: true }; });
    return b;
  }

  /**
   * Every box read back from the phone, sent to the server or merged goes
   * through here. Strict (the server): anything out of shape is an error
   * and the whole body is refused. Not strict (reading this phone's own
   * copy): the bad bit is dropped or mended. {box, errors}.
   */
  function cleanBox(raw, strict) {
    var errors = [];
    var e = function (m) { errors.push(m); };
    raw = isObj(raw) ? raw : (e('Send the recipe box.'), {});
    if (strict && !keysOnly(raw, ['v', 'recipes', 'shop', 't', 'updatedAt'])) e('The box has a field Ladle does not keep.');
    if (strict && raw.v !== 1) e('Unknown version.');
    var out = newBox(isTime(raw.t) ? raw.t : 0);
    var rr = isObj(raw.recipes) ? raw.recipes : (strict && e('The recipes are missing.'), {});
    var ids = Object.keys(rr);
    if (ids.length > LIMITS.recipes) { if (strict) e('At most ' + LIMITS.recipes + ' recipes.'); ids = ids.slice(0, LIMITS.recipes); }
    ids.forEach(function (id) {
      var r = rr[id];
      if (!ID.recipe.test(id) || !isObj(r)) { if (strict) e('A recipe is out of shape.'); return; }
      if (strict && !keysOnly(r, ['title', 'from', 'serves', 'ingredients', 'steps', 'notes', 'photos', 't', 'del'])) { e('A recipe has a field Ladle does not keep.'); return; }
      var typed = typeof r.title === 'string' && typeof r.from === 'string' && typeof r.notes === 'string' && Array.isArray(r.ingredients) && Array.isArray(r.steps) && typeof r.del === 'boolean' && isTime(r.t) &&
        (r.serves === null || (typeof r.serves === 'number' && Math.round(r.serves) === r.serves && r.serves >= 1 && r.serves <= LIMITS.serves)) && (r.photos === undefined || r.photos === 0 || r.photos === 1 || r.photos === 2);
      if (!typed) { if (strict) e('A recipe is out of shape.'); return; }
      var name = line(r.title, 30) || 'a recipe';
      var w = refuse(r.title, LIMITS.title) || refuse(r.from, LIMITS.from) || refuse(r.notes, LIMITS.notes);
      if (w) { if (strict) e(name + ': ' + w); return; }
      if (r.ingredients.length > LIMITS.ingredients || r.steps.length > LIMITS.steps) { if (strict) e(name + ': too many lines.'); return; }
      var ings = [], bad = '';
      r.ingredients.forEach(function (i) {
        if (!isObj(i) || (strict && !keysOnly(i, ['q', 'q2', 'unit', 'item'])) || !(i.q === null || isQ(i.q)) || !(i.q2 === null || i.q2 === undefined || isQ(i.q2)) || (i.q2 && !i.q) || typeof i.item !== 'string' || (i.unit !== '' && UNIT_IDS.indexOf(i.unit) < 0)) { bad = bad || 'an ingredient is out of shape.'; return; }
        var why = refuse(i.item, LIMITS.item);
        if (why) { bad = bad || why; return; }
        ings.push({ q: i.q ? Q(i.q[0], i.q[1]) : null, q2: i.q2 ? Q(i.q2[0], i.q2[1]) : null, unit: i.unit, item: line(i.item, LIMITS.item) });
      });
      var steps = [];
      r.steps.forEach(function (s) { var why = typeof s === 'string' ? refuse(s, LIMITS.step) : 'a step is not words.'; if (why) { bad = bad || why; return; } steps.push(line(s, LIMITS.step)); });
      if (bad) { if (strict) { e(name + ': ' + bad); return; } }
      out.recipes[id] = { title: line(r.title, LIMITS.title), from: line(r.from, LIMITS.from), serves: r.serves, ingredients: ings, steps: steps, notes: lines(r.notes, LIMITS.notes), photos: r.photos || 0, t: r.t, del: r.del };
    });
    var rs = isObj(raw.shop) ? raw.shop : (strict && e('The shopping list is missing.'), {});
    if (strict && !keysOnly(rs, ['plan', 'ticks', 'extra'])) e('The shopping list has a field Ladle does not keep.');
    var rp = isObj(rs.plan) ? rs.plan : (strict && e('The shopping plan is missing.'), {});
    Object.keys(rp).forEach(function (id) {
      var p = rp[id];
      if (!ID.recipe.test(id) || !isObj(p) || (strict && !keysOnly(p, ['on', 'k', 't'])) || typeof p.on !== 'boolean' || !isQ(p.k) || p.k[0] === 0 || qnum(p.k) > 48 || !isTime(p.t)) { if (strict) e('A recipe on the list is out of shape.'); return; }
      out.shop.plan[id] = { on: p.on, k: Q(p.k[0], p.k[1]), t: p.t };
    });
    var rt = isObj(rs.ticks) ? rs.ticks : (strict && e('The ticks are missing.'), {});
    var tks = Object.keys(rt);
    if (tks.length > 600) { if (strict) e('Too many ticks.'); tks = tks.slice(0, 600); }
    tks.forEach(function (k) {
      var x = rt[k];
      if (!KEY.test(k) || !isObj(x) || (strict && !keysOnly(x, ['on', 't'])) || typeof x.on !== 'boolean' || !isTime(x.t)) { if (strict) e('A tick is out of shape.'); return; }
      out.shop.ticks[k] = { on: x.on, t: x.t };
    });
    var rx = isObj(rs.extra) ? rs.extra : (strict && e('The extra items are missing.'), {});
    var xs = Object.keys(rx);
    if (xs.length > LIMITS.extras * 2) { if (strict) e('Too many extra items.'); xs = xs.slice(0, LIMITS.extras * 2); }
    xs.forEach(function (id) {
      var x = rx[id];
      if (!ID.extra.test(id) || !isObj(x) || (strict && !keysOnly(x, ['text', 't', 'del'])) || typeof x.text !== 'string' || typeof x.del !== 'boolean' || !isTime(x.t)) { if (strict) e('An extra item is out of shape.'); return; }
      var w = refuse(x.text, LIMITS.extra);
      if (w) { if (strict) e('An extra item: ' + w); return; }
      out.shop.extra[id] = { text: line(x.text, LIMITS.extra), t: x.t, del: x.del };
    });
    return { box: out, errors: errors };
  }

  /** What the server refuses whole before the one door even looks: any
   *  string anywhere with an @ (any width), nine digits in a row (any
   *  script), a link, markup or an invisible character. The first problem,
   *  or ''. (Phone numbers, cards and formulas are the door's.) */
  function bodyProblem(v, depth) {
    depth = depth || 0;
    if (depth > 8) return 'That is nested too deeply.';
    if (typeof v === 'string') {
      if (hasAt(v)) return 'Something in it has an @ - Ladle keeps no email addresses.';
      if (nineDigits(v)) return 'Something in it has nine digits in a row - Ladle keeps no phone or account numbers.';
      if (hasLink(v)) return 'Something in it looks like a link.';
      if (hasMarkup(v)) return 'Something in it has markup.';
      if (hasInvisible(v.replace(/[\n\t]/g, ' '))) return 'Something in it has an invisible character.';
      return '';
    }
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) { var p = bodyProblem(v[i], depth + 1); if (p) return p; } return ''; }
    if (isObj(v)) {
      var ks = Object.keys(v);
      for (var j = 0; j < ks.length; j++) { var q = bodyProblem(ks[j], depth + 1) || bodyProblem(v[ks[j]], depth + 1); if (q) return q; }
    }
    return '';
  }

  /* ================================================================== *
   * Two phones: the merge
   * ================================================================== */

  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  /** The later of two stamped records; a tie goes the same way from either side. */
  function later(x, y) {
    if (!x) return y; if (!y) return x;
    if (x.t !== y.t) return x.t > y.t ? x : y;
    return canon(x) >= canon(y) ? x : y;
  }
  function same(a, b) { var x = clone(a), y = clone(b); delete x.updatedAt; delete y.updatedAt; return canon(x) === canon(y); }
  /**
   * Two copies of one box, made one. Each recipe by its own time (a removal
   * is a change like any other); each recipe's place on the list, each tick
   * and each hand-typed item by its own time. A recipe both phones changed
   * keeps the later change, and the earlier one is kept beside it as a copy
   * - "(other phone)" - when they really differ, so no typing is lost.
   * `since` is the time of the copy both phones last agreed on (the sync
   * base); a recipe changed on only one phone since then is never copied.
   * Symmetric and idempotent.
   */
  function merge(a, b, since, copyId) {
    a = cleanBox(a).box; b = cleanBox(b).box;
    since = since || 0;
    var out = newBox(Math.max(a.t, b.t)), notes = [];
    Object.keys(a.recipes).concat(Object.keys(b.recipes)).forEach(function (id) {
      if (out.recipes[id]) return;
      var x = a.recipes[id], y = b.recipes[id], w = later(x, y);
      out.recipes[id] = clone(w);
      var lose = w === x ? y : x;
      if (lose && x && y && !lose.del && !w.del && lose.t > since && w.t > since && canon(contentOf(lose)) !== canon(contentOf(w)) && copyId) {
        var cid = copyId(id);
        if (!a.recipes[cid] && !b.recipes[cid]) {
          var c = clone(lose); c.title = line(c.title + ' (other phone)', LIMITS.title); c.photos = 0;
          out.recipes[cid] = c;
          notes.push('Both phones changed “' + w.title + '”. The other phone’s version is kept as “' + c.title + '”.');
        }
      }
    });
    ['plan', 'ticks', 'extra'].forEach(function (k) {
      Object.keys(a.shop[k]).concat(Object.keys(b.shop[k])).forEach(function (id) { if (!out.shop[k][id]) out.shop[k][id] = clone(later(a.shop[k][id], b.shop[k][id])); });
    });
    return { box: out, notes: notes };
  }
  function contentOf(r) { return { title: r.title, from: r.from, serves: r.serves, ingredients: r.ingredients, steps: r.steps, notes: r.notes }; }
  /** The id of the "(other phone)" copy: the recipe's id with a fixed
   *  suffix, so both phones pick the same one. */
  function copyIdOf(id) { return (id.slice(0, 9) + 'cp').slice(0, 13); }

  /* ================================================================== *
   * The AI: "Type it up"
   * ================================================================== */

  var IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  /** The request, rebuilt to the photos alone: exactly {images: [{type,
   *  data}]}, one or two (the front and the back of a card). Anything else -
   *  a recipe, a name, a question - is refused. */
  function cardRequest(body) {
    var bad = function (msg, code) { return { error: msg, code: code || 'bad-request' }; };
    if (!isObj(body)) return bad('Send the photo of the card.');
    var extra = Object.keys(body).filter(function (k) { return k !== 'images'; });
    if (extra.length) return bad('Only the photos are sent - not ' + extra.slice(0, 3).map(function (x) { return line(x, 20); }).join(', ') + '.', 'extra-field');
    var ims = body.images;
    if (!Array.isArray(ims) || ims.length < 1 || ims.length > LIMITS.aiImages) return bad('Send one photo of the card, or two - its front and back.', 'image');
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
  var CARD_FIELDS = ['title', 'serves', 'ingredients', 'steps', 'notes', 'unsure'];
  var UNSURE = ['title', 'serves', 'ingredients', 'steps', 'notes'];
  // What a card never says and a model might add: nutrition, health and
  // allergy claims, prices, where to buy.
  var CLAIM = /\b(calories|kcal|nutrition|nutritional|protein grams|carbs|keto|healthy|healthier|diabetic|allergen|allergy|allergies|safe for|price|\$\d|buy (it )?at|sponsored)\b/i;
  function aiText(v, max) {
    if (typeof v !== 'string') return null;
    if (hasMarkup(v) && /<[a-z!/]/i.test(v)) return null;
    var s = line(v, max);
    if (!s) return '';
    if (hasAt(s) || hasLink(s) || hasPhone(s) || hasCard(s) || nineDigits(s) || isFormula(s) || CLAIM.test(s)) return null;
    return s;
  }
  /**
   * The model's answer, checked. Only a recipe's own fields are kept: any
   * other field (who it is from, nutrition, a price) is dropped and named; a
   * line that carries an email, a phone number, a link, markup or a
   * nutrition or allergy claim is dropped and counted; an ingredient's
   * amount is read by Ladle's own reader, never trusted as a number.
   * Nothing readable is an error. {draft, unclear, dropped} or {error, code}.
   */
  function cleanAiCard(raw) {
    if (!isObj(raw)) return { error: 'The card could not be read. Try a sharper photo, straight on, in good light - or type it in.', code: 'unreadable' };
    var dropped = [], unclear = { ingredients: [], steps: [] }, n = 0;
    var drop = function (what) { if (dropped.length < LIMITS.aiDropped && dropped.indexOf(what) < 0) dropped.push(what); };
    Object.keys(raw).forEach(function (k) { if (CARD_FIELDS.indexOf(k) < 0) drop(line(k, 20) || 'a field'); });
    var title = aiText(raw.title, LIMITS.title);
    if (title === null) { drop('title'); title = ''; }
    var serves = typeof raw.serves === 'number' && Math.round(raw.serves) === raw.serves && raw.serves >= 1 && raw.serves <= LIMITS.serves ? raw.serves : null;
    if (raw.serves !== null && raw.serves !== undefined && serves === null) drop('serves');
    var ings = [];
    (Array.isArray(raw.ingredients) ? raw.ingredients : []).slice(0, LIMITS.ingredients).forEach(function (i) {
      if (!isObj(i)) { n++; return; }
      Object.keys(i).forEach(function (k) { if (['amount', 'unit', 'item', 'unclear'].indexOf(k) < 0) drop('ingredient ' + line(k, 16)); });
      var parts = [aiText(i.amount || '', 20), aiText(i.unit || '', 20), aiText(i.item || '', LIMITS.item)];
      if (parts.some(function (p) { return p === null; })) { n++; return; }
      var text = parts.filter(Boolean).join(' ');
      if (!text) return;
      var ing = parseIngredient(text);
      if (!ing.item && !ing.q) return;
      ings.push(ing);
      if (i.unclear === true) unclear.ingredients.push(ings.length - 1);
    });
    var steps = [];
    (Array.isArray(raw.steps) ? raw.steps : []).slice(0, LIMITS.steps).forEach(function (s) {
      var text = isObj(s) ? s.text : s;
      if (isObj(s)) Object.keys(s).forEach(function (k) { if (['text', 'unclear'].indexOf(k) < 0) drop('step ' + line(k, 16)); });
      var t = aiText(text, LIMITS.step);
      if (t === null) { n++; return; }
      if (!t) return;
      steps.push(t.replace(/^(\d{1,2}[.)]|step \d{1,2}[.:)]?)\s*/i, ''));
      if (isObj(s) && s.unclear === true) unclear.steps.push(steps.length - 1);
    });
    var notes = aiText(raw.notes || '', LIMITS.notes);
    if (notes === null) { drop('notes'); notes = ''; }
    if (n) drop(plural(n, 'line') + ' with an email, a phone number, a link or a nutrition claim');
    var unsure = (Array.isArray(raw.unsure) ? raw.unsure : []).filter(function (u, i, a) { return UNSURE.indexOf(u) >= 0 && a.indexOf(u) === i; });
    if (!title && !ings.length && !steps.length) return { error: 'Nothing on that card could be read. Try a sharper photo, straight on, in good light - or type it in.', code: 'unreadable' };
    return { draft: { title: title, serves: serves, ingredients: ings, steps: steps, notes: notes }, unclear: unclear, unsure: unsure, dropped: dropped };
  }
  /** A reading, as the editor's fields for a person to check. */
  function draftFields(d, from) {
    return { title: d.title, from: from || '', serves: d.serves === null ? '' : String(d.serves), ingredients: d.ingredients.map(ingredientText).join('\n'), steps: d.steps.join('\n'), notes: d.notes, photos: 0 };
  }

  /* ================================================================== *
   * A fresh card to print: what it holds (the page draws it)
   * ================================================================== */

  function card(r, k, mode) {
    return {
      title: r.title, from: r.from, serves: r.serves ? Math.round(qnum(qmul(Q(r.serves), k)) * 100) / 100 : null,
      ingredients: r.ingredients.map(function (i) { var s = scaleIngredient(i, k, mode); return { amount: (s.about ? '~' : '') + s.amount, item: s.item }; }),
      steps: r.steps.map(function (s) { return withTemps(s, mode); }), notes: r.notes,
    };
  }

  return {
    LIMITS: LIMITS, WHY: WHY, UNITS: UNITS, UNIT_IDS: UNIT_IDS, AISLES: AISLES, AISLE_IDS: AISLE_IDS, AISLE_NAMES: AISLE_NAMES, IMAGE_TYPES: IMAGE_TYPES, UNSURE: UNSURE, ID: ID, KEY: KEY,
    str: str, esc: esc, line: line, lines: lines, fold: fold, clone: clone, list: list, plural: plural,
    hasAt: hasAt, hasLink: hasLink, hasPhone: hasPhone, nineDigits: nineDigits, hasCard: hasCard, isFormula: isFormula, hasInvisible: hasInvisible, refuse: refuse,
    Q: Q, qadd: qadd, qmul: qmul, qdiv: qdiv, qnum: qnum, qeq: qeq, isQ: isQ, friendly: friendly, nearest: nearest, fracText: fracText, parseAmount: parseAmount,
    unitOf: unitOf, unitText: unitText, parseIngredient: parseIngredient, ingredientText: ingredientText, amountText: amountText,
    metricText: metricText, usVolume: usVolume, usMass: usMass, amountIn: amountIn, scaleIngredient: scaleIngredient, factor: factor, withTemps: withTemps, timers: timers, minsText: minsText, clockText: clockText,
    aisleOf: aisleOf, shopKey: shopKey, shopping: shopping, shoppingText: shoppingText,
    isTime: isTime, newBox: newBox, newRecipe: newRecipe, liveRecipes: liveRecipes, search: search, whose: whose, recipeFrom: recipeFrom, fieldsOf: fieldsOf,
    putRecipe: putRecipe, removeRecipe: removeRecipe, planRecipe: planRecipe, tick: tick, addExtra: addExtra, removeExtra: removeExtra, clearList: clearList,
    cleanBox: cleanBox, bodyProblem: bodyProblem, canon: canon, same: same, merge: merge, copyIdOf: copyIdOf,
    cardRequest: cardRequest, cleanAiCard: cleanAiCard, draftFields: draftFields, CLAIM: CLAIM, card: card,
  };
}));
