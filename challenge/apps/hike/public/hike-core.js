/* Hike - the rules, in one file the page and the server both run.
 *
 * UMD: the page loads it as window.HikeCore, the server and the tests
 * require() it. Everything that decides a number lives here - reading money,
 * the break-even meter, rounding a price list like a pro (and holding a price
 * under $10), the blended raise, the rollout dates and the .ics file, the
 * "did it work?" verdict, the free announcement templates and the check that
 * an AI draft did not invent a figure - plus the cleaning every plan goes
 * through, whether it came from a model, the page or localStorage. No DOM,
 * no network, no clock of its own: "today" is always passed in.
 *
 * Money is integer cents throughout, read from the typed digits and never
 * through a float. Shares are worked out in integers too: a break-even of
 * 17.6% is 176 per-mille... tenths of a percent, floored, so the room to lose
 * customers is never overstated.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HikeCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    plans: 10,             // saved plans per person
    lines: 200,            // price-list lines per plan
    tracker: 52,           // weekly tracker entries per plan
    photos: 4,             // menu photos per snap
    planName: 80,
    lineName: 60,
    section: 40,
    business: 80,
    reasons: 300,          // the free-text reason
    voice: 1500,           // the voice sample
    summary: 400,          // the summary of the change
    grandfather: 200,
    paste: 20000,          // characters pasted into the price list box
    maxCents: 10000000,    // $100,000 - any one price
    maxVolume: 10000000,   // sales a month on one line / in the meter
    maxWeekly: 10000000000, // a week's sales in cents ($100M) or units
    targetMin: 50,         // basis points: 0.5%
    targetMax: 5000,       // 50%
    grandfatherWeeks: 52,
  };

  var STYLES = [
    { id: 'cafe', label: 'Ends in .95 / .45', hint: 'Cafés and bakeries' },
    { id: 'ninety', label: 'Ends in .99 / .49', hint: 'Shops' },
    { id: 'nickel', label: 'Nearest $0.05', hint: 'Anything' },
    { id: 'dollar', label: 'Whole dollars', hint: 'Restaurants, salons' },
    { id: 'five', label: 'Nearest $5', hint: 'Services and trades' },
  ];
  var STYLE_IDS = STYLES.map(function (s) { return s.id; });

  // Round prices people notice. A price that sat under one of these and
  // would now cross it is held just under it (hold-under). Under $5 every
  // whole dollar counts: $2.95 -> $3.15 feels like "over three".
  var THRESHOLDS = [100, 200, 300, 400, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000, 2000000, 5000000, 10000000];

  var CURRENCIES = { USD: '$', CAD: '$', AUD: '$', GBP: '£', EUR: '€' };
  var UNITS = ['customers', 'sales', 'orders', 'clients', 'jobs'];
  var TONES = ['warm', 'plain', 'playful'];
  var BUSINESS_TYPES = ['café', 'restaurant', 'bar', 'bakery', 'salon', 'barber', 'spa', 'trade', 'shop', 'studio', 'freelancer', 'other'];
  var REASONS = [
    { id: 'ingredients', label: 'Ingredients', phrase: 'ingredients' },
    { id: 'materials', label: 'Materials', phrase: 'materials' },
    { id: 'wages', label: 'Wages', phrase: 'wages' },
    { id: 'rent', label: 'Rent', phrase: 'rent' },
    { id: 'energy', label: 'Energy', phrase: 'energy' },
    { id: 'suppliers', label: 'Supplier prices', phrase: 'what our suppliers charge' },
    { id: 'insurance', label: 'Insurance', phrase: 'insurance' },
    { id: 'since', label: 'First raise in a while', phrase: '' },
  ];
  var REASON_IDS = REASONS.map(function (r) { return r.id; });

  /* ---------------- text ---------------- */

  /** Plain text only: markup, control and direction-override characters
   *  out, whitespace collapsed, cut to `max` with an ellipsis. */
  function clean(v, max) {
    var s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 2000) s = s.slice(0, max * 4 + 2000);
    s = s.replace(/<[^>]*>?/g, ' ')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (s.length > max) s = s.slice(0, max - 1).replace(/\s+$/, '') + '…';
    return s;
  }
  /** Like clean, but keeps line breaks (for an email body or a voice sample). */
  function cleanBlock(v, max) {
    var s = typeof v === 'string' ? v : '';
    if (s.length > max * 4 + 2000) s = s.slice(0, max * 4 + 2000);
    s = s.replace(/\r\n?/g, '\n').replace(/<[^>]*>?/g, ' ')
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
      .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (s.length > max) s = s.slice(0, max - 1).replace(/\s+$/, '') + '…';
    return s;
  }
  function oneOf(v, list, dflt) { return list.indexOf(v) >= 0 ? v : dflt; }

  /* ---------------- money ---------------- */

  /**
   * Typed money as integer cents, or null. "$1,240.50", "4.5", "4", "£4",
   * "4,50" (a decimal comma), "1 240.50", "45¢" and "USD 12" all read; a
   * third decimal rounds half up. Read from the digits as text, never a
   * float. Anything without a digit ("free", "market price") is no figure,
   * and a negative is not a price.
   */
  function toCents(v) {
    if (typeof v === 'number') {
      if (!isFinite(v) || v < 0) return null;
      v = v.toFixed(3);
    }
    if (typeof v !== 'string') return null;
    var s = v.trim().toLowerCase();
    if (!/\d/.test(s) || s.length > 40) return null;
    s = s.replace(/^(usd|us\$|cad|c\$|aud|a\$|gbp|eur)\s*/, '').replace(/\s*(usd|cad|aud|gbp|eur|each|ea\.?)$/, '');
    var centsMark = /^\d+\s*(¢|c)$/.exec(s);
    if (centsMark) {
      var c = Number(s.replace(/\D/g, ''));
      return c <= LIMITS.maxCents ? c : null;
    }
    s = s.replace(/^[$£€]\s*/, '').replace(/\s*[$£€]$/, '');
    if (/^\d{1,3}( \d{3})+(\.\d+)?$/.test(s)) s = s.replace(/ /g, '');
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
    var parts = s.split('.');
    var whole = parts[0] || '0';
    var frac = (parts[1] || '') + '000';
    if (whole.replace(/^0+/, '').length > 9) return null;
    var cents = Number(whole) * 100 + Number(frac.slice(0, 2)) + (Number(frac.charAt(2)) >= 5 ? 1 : 0);
    if (!isFinite(cents) || cents > LIMITS.maxCents) return null;
    return cents;
  }

  /** A typed percentage as basis points: "8", "8%", "8.5 %", 8 -> 800, 850. */
  function toBp(v) {
    if (typeof v === 'number') v = isFinite(v) ? v.toFixed(4) : '';
    if (typeof v !== 'string') return null;
    var s = v.trim().replace(/\s*%$/, '');
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
    var parts = s.split('.');
    var frac = (parts[1] || '') + '000';
    if (parts[0].length > 5) return null;
    return Number(parts[0] || '0') * 100 + Number(frac.slice(0, 2)) + (Number(frac.charAt(2)) >= 5 ? 1 : 0);
  }

  /** A count of sales: "1,400", "1400", "900/mo", 900 -> whole, non-negative. */
  function toCount(v, max) {
    if (typeof v === 'number') return isFinite(v) && v >= 0 && Math.floor(v) === v && v <= (max || LIMITS.maxVolume) ? v : null;
    if (typeof v !== 'string') return null;
    var s = v.trim().toLowerCase().replace(/\s*(\/\s*)?(a|per)?\s*(mo|month|wk|week)\.?$/, '').replace(/,(?=\d{3}\b)/g, '');
    if (!/^\d+$/.test(s)) return null;
    var n = Number(s);
    return n <= (max || LIMITS.maxVolume) ? n : null;
  }

  function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function symbolOf(cur) { return CURRENCIES[cur] || '$'; }
  /** $4.50, or $45 when `auto` and the cents are zero. */
  function money(cents, sym, auto) {
    if (cents === null || cents === undefined || !isFinite(cents)) return '';
    sym = sym || '$';
    var neg = cents < 0;
    var a = Math.abs(Math.round(cents));
    var s = (auto && a % 100 === 0) ? sym + groups(a / 100) : sym + groups(Math.floor(a / 100)) + '.' + String(a % 100).padStart(2, '0');
    return neg ? '−' + s : s;
  }
  /** Whole dollars, rounded the way the caller says: 'down' toward zero for
   *  a gain (never overstate it), 'up' away from zero for a loss. */
  function dollars(cents, sym, how) {
    sym = sym || '$';
    var a = Math.abs(cents);
    var d = how === 'up' ? Math.ceil(a / 100) : how === 'nearest' ? Math.round(a / 100) : Math.floor(a / 100);
    return sym + groups(d);
  }
  /** Cents as the text a form field holds: 126300 -> "1,263" or "4.50". */
  function plainMoney(cents) {
    if (cents === null || cents === undefined) return '';
    var a = Math.abs(cents);
    return groups(Math.floor(a / 100)) + (a % 100 ? '.' + String(a % 100).padStart(2, '0') : '');
  }
  /** A change in cents as people say it at a counter: "45¢", "$1.20". */
  function changeText(cents, sym) {
    if (cents > 0 && cents < 100 && (sym || '$') === '$') return cents + '¢';
    return money(cents, sym, true);
  }
  /** Tenths of a percent as text: 176 -> "17.6%", 80 -> "8%". */
  function pmText(pm) {
    var neg = pm < 0; var a = Math.abs(pm);
    return (neg ? '−' : '') + Math.floor(a / 10) + (a % 10 ? '.' + (a % 10) : '') + '%';
  }
  function bpText(bp) {
    var a = Math.abs(bp);
    var s = String(Math.floor(a / 100));
    var f = a % 100;
    if (f) s += '.' + String(f).padStart(2, '0').replace(/0$/, '');
    return (bp < 0 ? '−' : '') + s + '%';
  }
  function trimNum(n) { return String(Math.round(n * 10) / 10); }

  /* BigInt helpers: exact arithmetic for products of prices and volumes. */
  function B(n) { return BigInt(Math.round(n)); }
  function bDivFloor(a, b) { var q = a / b; return (a % b !== 0n && ((a < 0n) !== (b < 0n))) ? q - 1n : q; }

  /* ---------------- the break-even meter ---------------- */

  /** The meter's typed fields -> numbers. Anything unreadable is null. */
  function meterFrom(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var costMode = r.costMode === 'margin' ? 'margin' : 'cost';
    var margin = toBp(typeof r.margin === 'number' ? String(r.margin) : r.margin);
    return {
      price: toCents(r.price),
      cost: costMode === 'cost' ? toCents(r.cost) : null,
      margin: costMode === 'margin' && margin !== null && margin <= 10000 ? margin : null,
      costMode: costMode,
      volume: toCount(r.volume),
      newPrice: toCents(r.newPrice),
      unit: oneOf(r.unit, UNITS, 'customers'),
    };
  }

  function perMonth(unit) { return unit + ' a month'; }

  /**
   * The hero: how many customers could you lose and still make more?
   *
   *   margin now  m0 = p0 - c      margin after  m1 = p1 - c
   *   break-even loss = 1 - m0/m1 = (p1 - p0) / (p1 - c)   when m1 > m0 > 0
   *
   * The share is floored to a tenth of a percent, and "1 in N" uses the
   * next whole N up, so neither ever says there is more room than there is.
   * Returns {status, parts (the sentence, with the bold bit marked), ...}.
   */
  function breakEven(m, sym) {
    sym = sym || '$';
    var unit = m.unit || 'customers';
    var out = { status: '', parts: [], working: '', p0: m.price, p1: m.newPrice, cost: null, m0: null, m1: null, lossPm: null, oneIn: null, volume: m.volume, unit: unit };
    function say() { out.parts = Array.prototype.slice.call(arguments).map(function (x) { return typeof x === 'string' ? { t: x } : x; }); }
    if (m.price === null || m.price === undefined || m.price <= 0) { out.status = 'need-price'; say('Enter what you charge now to start.'); return out; }
    var cost = m.cost;
    if ((cost === null || cost === undefined) && m.margin !== null && m.margin !== undefined) {
      cost = Math.round(m.price * (10000 - m.margin) / 10000);
      out.fromMargin = m.margin;
    }
    out.cost = (cost === null || cost === undefined) ? null : cost;
    if (m.newPrice === null || m.newPrice === undefined) { out.status = 'need-new'; say('Pick a new price with the slider or type one.'); return out; }
    if (m.newPrice === m.price) { out.status = 'same'; say('That’s the price you charge now. Slide it up to see how much room a raise gives you.'); return out; }
    if (out.cost === null) {
      out.status = 'need-cost';
      say('That’s a ', { b: bpText(Math.round((m.newPrice - m.price) * 10000 / m.price)) + (m.newPrice > m.price ? ' raise' : ' cut') }, '. To say how many ' + unit + ' you could lose, Hike needs what each sale costs you - or your margin.');
      out.working = 'The room to lose ' + unit + ' depends on your margin: a raise on a thin margin gives far more room than the same raise on a fat one. Type your cost per sale (ingredients, materials, card fees - what one more sale costs you), or switch to margin %.';
      return out;
    }
    var p0 = m.price, p1 = m.newPrice, c = out.cost;
    var m0 = p0 - c, m1 = p1 - c;
    out.m0 = m0; out.m1 = m1;
    var costLine = out.fromMargin !== undefined
      ? 'A ' + bpText(out.fromMargin) + ' margin on ' + money(p0, sym) + ' means each sale costs you about ' + money(c, sym) + '. '
      : '';
    if (p1 < p0) {
      out.status = 'cut';
      if (m1 > 0 && m0 > 0) {
        // Extra sales needed to make the same: m0/m1 - 1, rounded UP.
        var needPm = Number(bDivFloor(B(m0 - m1) * 1000n + B(m1) - 1n, B(m1)));
        out.needPm = needPm;
        say('That’s a price cut. You’d need ', { b: pmText(needPm) + ' more ' + unit }, ' just to make the same.');
      } else say('That’s a price cut, and at ' + money(p1, sym) + ' every sale would lose money.');
      out.working = costLine + 'Now each sale makes ' + money(p0, sym) + ' − ' + money(c, sym) + ' = ' + money(m0, sym) + '. At ' + money(p1, sym) + ' it makes ' + money(m1, sym) + '.';
      return out;
    }
    if (m0 <= 0) {
      out.status = 'losing';
      if (m1 <= 0) say(m0 < 0 ? 'Every sale loses money today, and at ' + money(p1, sym) + ' it still would. ' : 'Every sale just breaks even today, and at ' + money(p1, sym) + ' it still would. ', { b: 'Your price needs to be over ' + money(c, sym) }, ' to make anything.');
      else say(m0 < 0 ? 'Every sale loses money today - ' : 'Every sale just breaks even today - ', { b: 'any raise helps' }, '. At ' + money(p1, sym) + ' each sale makes ' + money(m1, sym) + '.');
      out.working = costLine + 'Each sale costs you ' + money(c, sym) + ' and brings in ' + money(p0, sym) + (m0 < 0 ? ', so it loses ' + money(-m0, sym) + '.' : ', so it makes nothing.') + ' There is no “customers you can lose” here: fewer sales at a loss is less loss.';
      return out;
    }
    // m1 > m0 > 0: the ordinary case.
    var lossPm = Number(bDivFloor(B(p1 - p0) * 1000n, B(m1)));
    out.lossPm = lossPm;
    var keepPm = 1000 - lossPm;
    if (lossPm < 1) {
      out.status = 'ok';
      out.oneIn = null;
      say('That raise is too small to lose anyone over: ', { b: 'under 0.1%' }, ' of ' + unit + ' is the most you could lose and still make more.');
    } else {
      out.status = 'ok';
      var oneIn = Math.max(2, Math.ceil(1000 / lossPm));
      out.oneIn = oneIn;
      say('You could lose up to ', { b: '1 in ' + oneIn }, ' ' + unit + ' (' + pmText(lossPm) + ') and still make more.');
    }
    out.working = costLine + 'Now each sale makes ' + money(p0, sym) + ' − ' + money(c, sym) + ' = ' + money(m0, sym) + '. At ' + money(p1, sym) + ' it makes ' + money(p1, sym) + ' − ' + money(c, sym) + ' = ' + money(m1, sym) + '. ' +
      money(m0, sym) + ' ÷ ' + money(m1, sym) + ' = ' + pmText(keepPm) + ': keep that share of your ' + unit + ' and you make what you make now, so you can lose up to ' + pmText(lossPm) + '. Rounded so it never shows more room than there is.';
    return out;
  }

  /**
   * Monthly profit change if `lossPm` tenths of a percent of sales go away
   * at the new price. A gain is rounded down to the dollar, a loss up.
   * Returns {cents, text, sign} or null when there is no volume or cost.
   */
  function profitChange(be, lossPm, sym) {
    if (!be || be.m0 === null || be.m1 === null || !be.volume) return null;
    var V = B(be.volume);
    var after = bDivFloor(B(be.m1) * V * B(1000 - lossPm), 1000n);
    var before = B(be.m0) * V;
    var d = Number(after - before);
    var text;
    if (Math.abs(d) < 100) text = 'About the same as now';
    else if (d > 0) text = '+' + dollars(d, sym, 'down') + ' a month';
    else text = dollars(-d, sym, 'up') + ' a month less';
    return { cents: d, text: text, sign: Math.abs(d) < 100 ? 0 : (d > 0 ? 1 : -1), before: Number(before), after: Number(after) };
  }

  /* ---------------- rounding a price list ---------------- */

  var ENDINGS = { cafe: [45, 95], ninety: [49, 99] };
  var STEP = { nickel: 5, dollar: 100, five: 500 };

  /** The smallest price in this style strictly above c. */
  function nextAbove(style, c) {
    if (ENDINGS[style]) {
      var d = Math.floor(c / 100);
      for (var k = d; k <= d + 2; k++) {
        for (var i = 0; i < 2; i++) { var v = k * 100 + ENDINGS[style][i]; if (v > c) return v; }
      }
    }
    var s = STEP[style] || 5;
    return (Math.floor(c / s) + 1) * s;
  }
  /** The largest price in this style strictly below c, or null. */
  function prevBelow(style, c) {
    if (ENDINGS[style]) {
      var d = Math.floor(c / 100);
      for (var k = d; k >= d - 2 && k >= 0; k--) {
        for (var i = 1; i >= 0; i--) { var v = k * 100 + ENDINGS[style][i]; if (v < c) return v; }
      }
      return null;
    }
    var s = STEP[style] || 5;
    var p = (Math.ceil(c / s) - 1) * s;
    return p > 0 ? p : null;
  }
  function thresholdAbove(c) {
    for (var i = 0; i < THRESHOLDS.length; i++) if (THRESHOLDS[i] > c) return THRESHOLDS[i];
    return null;
  }

  /**
   * One line's new price. The exact target is old x (1 + target); the price
   * is the style's nearest price point to it (a tie goes up), never at or
   * below the old price. With hold-under, a price that would cross a round
   * number the old one sat under is held at the style's last point below
   * it - if there is room above the old price; if not it crosses, flagged.
   * A price typed by hand (above the old one) wins over all of it.
   */
  function newPriceFor(line, settings) {
    var old = line.price;
    var r = { price: old, held: null, crosses: null, manual: false, exact: old, target: null };
    if (!old || old <= 0) return r;
    if (line.locked) return r;
    if (line.manual && line.manual > old) { r.price = line.manual; r.manual = true; return r; }
    var style = oneOf(settings.style, STYLE_IDS, 'cafe');
    var bp = settings.target;
    var T = B(old) * B(10000 + bp);          // the exact target x 10000
    var ceilT = Number(bDivFloor(T + 9999n, 10000n));
    var floorT = Number(bDivFloor(T, 10000n));
    r.exact = Math.round(old * (10000 + bp) / 10000);
    var up = nextAbove(style, ceilT - 1);
    var down = prevBelow(style, floorT + 1);
    var pick = up;
    if (down !== null) {
      var du = B(up) * 10000n - T, dd = T - B(down) * 10000n;
      if (dd < du) pick = down;
    }
    if (pick <= old) pick = nextAbove(style, old);
    r.target = pick;
    var th = thresholdAbove(old);
    if (th !== null && pick >= th) {
      var hold = prevBelow(style, th);
      if (settings.holdUnder !== false && line.hold !== false && hold !== null && hold > old) {
        r.price = hold; r.held = th; return r;
      }
      r.crosses = th;
      r.noRoom = !(hold !== null && hold > old);
    }
    r.price = pick;
    return r;
  }

  /** A price-list line, cleaned: from a paste, a model, the page or a save. */
  function cleanLine(raw, i) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var name = clean(r.name, LIMITS.lineName);
    var price = typeof r.price === 'number' && Number.isInteger(r.price) ? (r.price > 0 && r.price <= LIMITS.maxCents ? r.price : null) : toCents(r.price);
    if (!name || !price) return null;
    var cost = typeof r.cost === 'number' && Number.isInteger(r.cost) ? (r.cost >= 0 && r.cost <= LIMITS.maxCents ? r.cost : null) : (r.cost === '' || r.cost === null || r.cost === undefined ? null : toCents(r.cost));
    var volume = toCount(typeof r.volume === 'string' ? r.volume : r.volume === null || r.volume === undefined ? '' : r.volume);
    var manual = typeof r.manual === 'number' && Number.isInteger(r.manual) ? (r.manual > 0 && r.manual <= LIMITS.maxCents ? r.manual : null) : (r.manual ? toCents(r.manual) : null);
    var id = typeof r.id === 'string' && /^[a-z0-9]{1,16}$/i.test(r.id) ? r.id : 'l' + (i === undefined ? Math.random().toString(36).slice(2, 8) : String(i));
    return {
      id: id,
      name: name,
      price: price,
      cost: cost,
      volume: volume,
      locked: r.locked === true,
      hold: r.hold !== false,
      manual: manual,
      section: clean(r.section, LIMITS.section) || null,
    };
  }
  function cleanLines(list) {
    var out = [], seen = {}, ids = {};
    (Array.isArray(list) ? list : []).slice(0, LIMITS.lines * 3).forEach(function (raw, i) {
      if (out.length >= LIMITS.lines) return;
      var l = cleanLine(raw, i);
      if (!l) return;
      while (ids[l.id]) l.id = l.id + 'x';
      ids[l.id] = true;
      out.push(l);
    });
    return out;
  }

  function cleanSettings(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var t = typeof r.target === 'number' ? Math.round(r.target) : toBp(r.target);
    return {
      target: t !== null && t >= LIMITS.targetMin && t <= LIMITS.targetMax ? t : 800,
      style: oneOf(r.style, STYLE_IDS, 'cafe'),
      holdUnder: r.holdUnder !== false,
      currency: oneOf(r.currency, Object.keys(CURRENCIES), 'USD'),
    };
  }

  /**
   * The whole list, repriced: rows old -> new, the blended raise actually
   * achieved (weighted by each line's sales when every line has a volume,
   * else a simple average of the lines' raises), and - when every line has
   * a cost and a volume - the list-wide break-even.
   */
  function priceList(lines, settings) {
    var s = cleanSettings(settings);
    var rows = (lines || []).map(function (l) {
      var n = newPriceFor(l, s);
      var change = n.price - l.price;
      return {
        id: l.id, name: l.name, section: l.section, old: l.price, price: n.price, change: change,
        pctBp: Math.round(change * 10000 / l.price), locked: l.locked, held: n.held, crosses: n.crosses, noRoom: Boolean(n.noRoom),
        manual: n.manual, target: n.target, cost: l.cost, volume: l.volume, hold: l.hold,
      };
    });
    var out = { rows: rows, settings: s, counts: { lines: rows.length, raised: 0, locked: 0, held: 0, crosses: 0, manual: 0 }, blended: null, list: null };
    rows.forEach(function (r) {
      if (r.locked) out.counts.locked++; else if (r.change > 0) out.counts.raised++;
      if (r.held) out.counts.held++;
      if (r.crosses) out.counts.crosses++;
      if (r.manual) out.counts.manual++;
    });
    if (!rows.length) return out;
    var weighted = rows.every(function (r) { return r.volume > 0; });
    if (weighted) {
      var now = 0n, after = 0n;
      rows.forEach(function (r) { now += B(r.old) * B(r.volume); after += B(r.price) * B(r.volume); });
      var bp = Number(bDivFloor((after - now) * 10000n, now));
      out.blended = { bp: bp, weighted: true, revenueNow: Number(now), revenueAfter: Number(after) };
    } else {
      var sum = rows.reduce(function (a, r) { return a + (r.price - r.old) * 10000 / r.old; }, 0);
      out.blended = { bp: Math.floor(sum / rows.length), weighted: false };
    }
    out.blended.target = s.target;
    var costed = rows.every(function (r) { return r.volume > 0 && r.cost !== null && r.cost !== undefined; });
    if (costed) {
      var m0 = 0n, m1 = 0n;
      rows.forEach(function (r) { m0 += B(r.old - r.cost) * B(r.volume); m1 += B(r.price - r.cost) * B(r.volume); });
      var L = { m0: Number(m0), m1: Number(m1), gain: Number(m1 - m0), lossPm: null, oneIn: null };
      if (m1 > m0 && m0 > 0n) {
        L.lossPm = Number(bDivFloor((m1 - m0) * 1000n, m1));
        L.oneIn = L.lossPm >= 1 ? Math.max(2, Math.ceil(1000 / L.lossPm)) : null;
      }
      out.list = L;
    }
    return out;
  }

  /**
   * The smallest target (in half-percent steps) whose blended raise reaches
   * `goalBp`, or null if even 50% cannot (everything locked). "To reach 8%
   * overall, set the target to 11%."
   */
  function targetFor(lines, settings, goalBp) {
    var s = cleanSettings(settings);
    for (var t = 50; t <= LIMITS.targetMax; t += 50) {
      var p = priceList(lines, { target: t, style: s.style, holdUnder: s.holdUnder, currency: s.currency });
      if (p.blended && p.blended.bp >= goalBp) return t;
    }
    return null;
  }

  /** The new list as text, grouped by section: for Copy and Print. */
  function listText(rows, sym, which) {
    var out = [], sec = null, fmt = priceFormat(rows, sym);
    rows.forEach(function (r) {
      if (r.section && r.section !== sec) { if (out.length) out.push(''); out.push(r.section.toUpperCase()); sec = r.section; }
      if (which === 'changes') out.push(r.name + ': ' + fmt(r.old) + ' → ' + fmt(r.price) + (r.change ? ' (+' + changeText(r.change, sym) + ')' : ' (no change)'));
      else out.push(r.name + '  ' + fmt(r.price));
    });
    return out.join('\n');
  }

  /* ---------------- reading a pasted price list ---------------- */

  var UNIT_WORDS = /^(oz|fl|ml|cl|l|ltr|litre|liter|g|gr|kg|lb|lbs|in|inch|inches|ft|cm|mm|m|pc|pcs|piece|pieces|pk|pack|ct|count|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|x|people|person|guests|sq|yr|yrs|years?)\b/i;
  var MONEY_TOKEN = /(^|[^\w.$£€])((?:us\$|[$£€])\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+[.,]\d{1,2}|\d+|\.\d{2})(¢|\s?[$£€])?(?![\w%]|[.,]\d)/gi;

  function tokens(line) {
    var out = [];
    MONEY_TOKEN.lastIndex = 0;
    var m;
    while ((m = MONEY_TOKEN.exec(line))) {
      var start = m.index + m[1].length;
      var end = m.index + m[0].length;
      var marked = Boolean(m[2] || m[4]);
      var after = line.slice(end);
      if (!marked && UNIT_WORDS.test(after.replace(/^\s+/, ''))) continue;          // "16 oz", "60 min"
      if (!marked && (/\d\s?[-–]\s?$/.test(line.slice(0, start)) || /^\s?[-–]\s?\d/.test(after))) continue; // "555-1234", "30-45", "7-3"
      var cents = m[4] === '¢' ? Number(m[3]) : toCents(m[3]);
      if (cents === null || cents > LIMITS.maxCents) continue;
      out.push({ start: start, end: end, cents: cents, marked: marked });
    }
    return out;
  }

  function tidyName(s) {
    return clean(String(s || '')
      .replace(/(\.{2,}|…+|_{2,}|·{2,}|-{2,}|\s[-–—]+\s|\s[-–—]+$|^[-–—]+\s)/g, ' ')
      .replace(/^\s*(?:[•*·▪◦-]|\d{1,2}[.)])\s+/, '')
      .replace(/[\s:;|,=–—-]+$/, '').replace(/^[\s:;|,=–—-]+/, '')
      .replace(/\s+(each|ea\.?)$/i, ''), LIMITS.lineName);
  }

  function splitCsv(line) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  /** Cells from a tab, pipe, semicolon or comma separated line; null if the
   *  line is free text. */
  function cellsOf(line) {
    if (line.indexOf('\t') >= 0) return line.split('\t');
    if (line.indexOf('|') >= 0) return line.split('|');
    if (line.indexOf(';') >= 0) return line.split(';');
    // One decimal comma ("Café crème 3,50 €") is a price, not two columns.
    // ...and neither is a thousands comma ("Room rate $1,240.50").
    var collapsed = line.replace(/(^|[^\d.])(\d{1,3}),(\d{3})(?!\d)/g, '$1$2$3');
    if (collapsed.indexOf(',') >= 0 && !/^[^,]*\d,\d{1,2}(?!\d)[^,]*$/.test(line)) {
      var raw = splitCsv(line);
      // "$1,240.00" split by the commas: put the thousands back together.
      var cells = [];
      raw.forEach(function (c) {
        var prev = cells[cells.length - 1];
        if (prev !== undefined && /^\s*[$£€]?\d{1,3}$/.test(prev) && /^\d{3}(\.\d{1,2})?\s*$/.test(c)) cells[cells.length - 1] = prev + c;
        else cells.push(c);
      });
      var filled = cells.filter(function (c) { return c.trim(); });
      var named = filled.filter(function (c) { return /[a-z]/i.test(c) && toCents(c) === null; });
      var nums = filled.filter(function (c) { return toCents(c) !== null; });
      if (named.length === 1 && nums.length >= 1 && nums.length + 1 === filled.length) return cells;
    }
    return null;
  }

  /**
   * A pasted price list, read deterministically - free for everyone, no
   * model. Menus ("Latte 4.50", "Latte ....... $4.50", "$4.50 Latte"),
   * service lists ("Haircut - $45"), spreadsheets (tab or comma columns:
   * name, price, cost, sales a month) and headings ("COFFEE", "Drinks:")
   * all read. Sizes and counts ("16 oz", "60 min", "2 eggs") are not prices.
   * Returns {lines, skipped, notes, currency}.
   */
  function parseList(text) {
    var src = typeof text === 'string' ? text.slice(0, LIMITS.paste) : '';
    var lines = [], skipped = [], notes = [], seen = {}, section = null, marks = {};
    var rows = src.replace(/\r\n?/g, '\n').split('\n');
    rows.forEach(function (rawLine) {
      var line = rawLine.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\ufeff]/g, ' ').replace(/\u00a0/g, ' ');
      if (!line.trim()) return;
      var mk = /[$£€]/.exec(line); if (mk) marks[mk[0]] = (marks[mk[0]] || 0) + 1;
      var item = null;
      var cells = cellsOf(line);
      if (cells) {
        var name = '', vals = [];
        cells.forEach(function (c) {
          var v = c.trim();
          var isMoney = v && toCents(v) !== null;
          if (!name && v && !isMoney && /[a-z]/i.test(v)) { name = v; return; }
          if (v && !isMoney) return;
          if (name || v) vals.push(v || null);
        });
        while (vals.length && vals[0] === null) vals.shift();
        if (name && vals.length) {
          item = { name: tidyName(name), price: toCents(vals[0]), cost: vals[1] ? toCents(vals[1]) : null, volume: vals[2] ? toCount(String(vals[2]).replace(/\.0+$/, '')) : null };
        }
      }
      if (!item) {
        // Dot leaders become spaces of the same length, so "Latte.....4.50"
        // reads and every position still points into the line.
        line = line.replace(/\.{2,}|…+/g, function (m) { return ' '.repeat(m.length); });
        var t = tokens(line);
        if (t.length) {
          // The run of numbers at the end of the line ("Latte 4.50 / 5.25").
          var run = [t[t.length - 1]];
          for (var i = t.length - 2; i >= 0; i--) {
            if (/^[\s/|,&–—-]*$/.test(line.slice(t[i].end, run[0].start))) run.unshift(t[i]); else break;
          }
          if (line.slice(run[run.length - 1].end).trim() && !/^[\s.)]*$/.test(line.slice(run[run.length - 1].end))) {
            // Price not at the end: "$4.50 Latte" or "Latte $4.50 hot or iced".
            var marked = t.filter(function (x) { return x.marked; });
            run = [marked[0] || t[0]];
          }
          var pick = run.filter(function (x) { return x.marked; })[0] || run[0];
          var nm = tidyName((line.slice(0, run[0].start) + ' ' + line.slice(run[run.length - 1].end)));
          if (nm && /[a-z]/i.test(nm)) {
            item = { name: nm, price: pick.cents, cost: null, volume: null, prices: run.length };
          }
        }
      }
      if (item && item.price > 0) {
        item.section = section;
        var key = item.name.toLowerCase() + '|' + item.price;
        if (seen[key]) return;
        seen[key] = true;
        if (item.prices > 1) notes.push('“' + item.name + '” had ' + item.prices + ' prices - kept ' + money(item.price, '$', true) + '.');
        delete item.prices;
        if (lines.length < LIMITS.lines) lines.push(item);
        else if (lines.length === LIMITS.lines) { notes.push('Only the first ' + LIMITS.lines + ' lines are kept.'); lines.push(null); }
        return;
      }
      var plain = clean(line, 200);
      if (!/[a-z0-9]/i.test(plain)) return;                       // "----------"
      if (/\b(price|cost|item|name|qty|quantity|volume|sold|monthly)\b/i.test(plain) && (cells || /,|\t/.test(line))) return; // a header row
      if (!/\d/.test(plain) && plain.length <= 40 && plain.split(' ').length <= 5 && /[a-z]/i.test(plain)) { section = tidyName(plain.replace(/:$/, '')) || null; return; }
      skipped.push(plain.slice(0, 80));
    });
    lines = lines.filter(Boolean);
    var cur = 'USD';
    if ((marks['£'] || 0) > (marks.$ || 0) && (marks['£'] || 0) >= (marks['€'] || 0)) cur = 'GBP';
    else if ((marks['€'] || 0) > (marks.$ || 0)) cur = 'EUR';
    return { lines: lines, skipped: skipped, notes: notes, currency: cur };
  }

  /* ---------------- dates ---------------- */

  function isoDay(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    var d = new Date(v + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === v ? v : null;
  }
  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function fmtDate(iso, long) {
    if (!isoDay(iso)) return '';
    var d = new Date(iso + 'T00:00:00Z');
    return long ? DAYS[d.getUTCDay()] + ', ' + MONTHS_LONG[d.getUTCMonth()] + ' ' + d.getUTCDate() : MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }
  function fmtShort(iso) { if (!isoDay(iso)) return ''; var d = new Date(iso + 'T00:00:00Z'); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate(); }
  /** "Monday, November 2" - the way an announcement says a date. */
  function sayDate(iso) { return fmtDate(iso, true); }

  /* ---------------- the rollout plan ---------------- */

  function cleanRollout(raw, today) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var t = isoDay(today) || '2026-01-01';
    var notice = isoDay(r.notice) || t;
    var effective = isoDay(r.effective) || addDays(notice, 30);
    var gw = Number(r.grandfatherWeeks);
    return { notice: notice, effective: effective, grandfatherWeeks: Number.isInteger(gw) && gw >= 0 && gw <= LIMITS.grandfatherWeeks ? gw : 0 };
  }

  /**
   * Notice, the change, any grandfathering, then check-ins 2, 4 and 8 weeks
   * after the change. Under 14 days' notice is warned about, not refused.
   */
  function rollout(raw, today) {
    var r = cleanRollout(raw, today);
    var noticeDays = daysBetween(r.notice, r.effective);
    var items = [], warnings = [];
    if (noticeDays <= 0) warnings.push('The new prices start before you announce them. Pick a start date after the announcement.');
    else if (noticeDays < 14) warnings.push('Only ' + noticeDays + ' day' + (noticeDays === 1 ? '' : 's') + '’ notice. Two weeks or more is kinder to regulars, and fewer of them feel caught out.');
    items.push({ kind: 'announce', date: r.notice, title: 'Announce the new prices', detail: 'Email, sign on the door, social post and a text to regulars. Brief the team with the counter script.' });
    items.push({ kind: 'effective', date: r.effective, title: 'New prices start', detail: 'Swap the menu board and the till. Keep the counter script by the register.' });
    if (r.grandfatherWeeks) items.push({ kind: 'grandfather', date: addDays(r.effective, r.grandfatherWeeks * 7), title: 'Existing clients move to the new prices', detail: 'The ' + r.grandfatherWeeks + '-week grace period for existing clients ends. A friendly reminder a week before helps.' });
    [2, 4, 8].forEach(function (w) {
      items.push({ kind: 'check' + w, date: addDays(r.effective, w * 7), title: 'Check-in: did it work? (week ' + w + ')', detail: 'Log this week’s sales in Hike’s tracker and compare them with your break-even.' });
    });
    items.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return { plan: r, items: items, noticeDays: noticeDays, warnings: warnings, ok: noticeDays > 0 };
  }

  /* ---------------- the calendar file (RFC 5545) ---------------- */

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
  /** 64 bits of FNV-1a as hex: a stable id, the same in browser and server. */
  function hash(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
  }
  function stamp(iso) {
    var d = new Date(iso || Date.now());
    if (isNaN(d)) d = new Date();
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  /**
   * The rollout as an .ics: one all-day event per step with a reminder at
   * 9am that day. UIDs come from the plan and the step's KIND, not its date,
   * so importing again after moving a date moves the event instead of
   * adding a second one.
   */
  function ics(opts) {
    var o = opts || {};
    var name = clean(o.name || 'Price rise', 80) || 'Price rise';
    var key = String(o.planKey || name);
    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Challenge Lab//Hike//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsText(name + ' - price rise')];
    var dt = stamp(o.now);
    (o.items || []).forEach(function (it) {
      if (!isoDay(it.date)) return;
      L.push('BEGIN:VEVENT',
        'UID:' + hash(key + '|' + it.kind) + '@hike.challenge.strongtechnicalconsulting.com',
        'DTSTAMP:' + dt,
        'DTSTART;VALUE=DATE:' + it.date.replace(/-/g, ''),
        'DTEND;VALUE=DATE:' + addDays(it.date, 1).replace(/-/g, ''),
        'SUMMARY:' + icsText(it.title + ' - ' + name),
        'DESCRIPTION:' + icsText((it.detail || '') + '\nFrom your Hike plan for ' + name + '.'),
        'TRANSP:TRANSPARENT',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(it.title), 'TRIGGER:PT9H', 'END:VALARM',
        'END:VEVENT');
    });
    L.push('END:VCALENDAR');
    return L.map(fold).join('\r\n') + '\r\n';
  }
  function icsFilename(name) {
    var s = String(name || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan';
    return s + '-price-rise.ics';
  }

  /* ---------------- did it work? ---------------- */

  function cleanTracker(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var mode = r.mode === 'revenue' ? 'revenue' : 'units';
    var read = function (v) {
      if (mode === 'revenue') return typeof v === 'number' && Number.isInteger(v) ? (v >= 0 && v <= LIMITS.maxWeekly ? v : null) : toCents(v);
      return toCount(typeof v === 'number' ? v : String(v === null || v === undefined ? '' : v), LIMITS.maxWeekly);
    };
    var seen = {};
    var entries = (Array.isArray(r.entries) ? r.entries : []).slice(0, LIMITS.tracker * 2).map(function (e) {
      if (!e || typeof e !== 'object') return null;
      var week = isoDay(e.week);
      var value = read(e.value);
      if (!week || value === null || seen[week]) return null;
      seen[week] = true;
      return { week: week, value: value };
    }).filter(Boolean).sort(function (a, b) { return a.week < b.week ? -1 : 1; }).slice(-LIMITS.tracker);
    return { mode: mode, baseline: read(r.baseline), entries: entries };
  }

  /**
   * The verdict, against the break-even. In units mode the tracker counts
   * sales (customers, cups, jobs). In revenue mode it counts money taken,
   * which already includes the new price - so it is turned back into sales
   * (revenue / price) before comparing: 4% less revenue after an 8% raise
   * is about 11% fewer sales, not 4%.
   */
  function verdict(trackerRaw, be, sym) {
    sym = sym || '$';
    var t = cleanTracker(trackerRaw);
    var out = { status: '', parts: [], explain: '', changePm: null, monthly: null, weeks: t.entries.length, mode: t.mode, points: [], baseline: t.baseline, line: null };
    function say() { out.parts = Array.prototype.slice.call(arguments).map(function (x) { return typeof x === 'string' ? { t: x } : x; }); }
    if (!t.baseline) { out.status = 'need-baseline'; say('Enter a typical week’s sales before the change, then add each week after it.'); return out; }
    out.points = t.entries.map(function (e) { return { week: e.week, value: e.value }; });
    if (!t.entries.length) { out.status = 'need-weeks'; say('Add your first week after the change to see how it’s going.'); return out; }
    var n = t.entries.length;
    var total = t.entries.reduce(function (a, e) { return a + e.value; }, 0);
    var p0 = be && be.p0, p1 = be && be.p1;
    var ratioNum, ratioDen; // sales after / sales before
    if (t.mode === 'revenue') {
      if (!p0 || !p1 || p1 <= p0) {
        out.status = 'need-prices';
        say('To judge revenue, Hike needs your old and new price in the break-even meter above - revenue already includes the new price.');
        return out;
      }
      ratioNum = B(total) * B(p0); ratioDen = B(n) * B(t.baseline) * B(p1);
      out.explain = 'Revenue already includes the new price, so Hike divides it by the price to compare sales: ' + money(Math.round(total / n), sym) + ' a week ÷ ' + money(p1, sym) + ' against ' + money(t.baseline, sym) + ' ÷ ' + money(p0, sym) + '.';
    } else {
      ratioNum = B(total); ratioDen = B(n) * B(t.baseline);
      out.explain = 'The average of your ' + n + ' week' + (n === 1 ? '' : 's') + ' since the change, against the week before it.';
    }
    // Change in sales in tenths of a percent, rounded toward zero.
    var diff = (ratioNum - ratioDen) * 1000n;
    var changePm = Number(bDivFloor(diff, ratioDen));
    out.changePm = changePm;
    if (be && be.m0 !== null && be.m1 !== null && be.m0 > 0) {
      // Monthly profit change: (weekly profit after - before) x 52 / 12.
      // Revenue mode turns money back into sales first (revenue / price).
      if (t.mode === 'revenue') {
        out.monthly = Number(bDivFloor((B(total) * B(be.m1) * B(p0) - B(n) * B(t.baseline) * B(be.m0) * B(p1)) * 52n, B(n) * B(p0) * B(p1) * 12n));
      } else {
        out.monthly = Number(bDivFloor((B(total) * B(be.m1) - B(n) * B(t.baseline) * B(be.m0)) * 52n, B(n) * 12n));
      }
    }
    var money$ = function (c) { return c >= 0 ? dollars(c, sym, 'down') : dollars(-c, sym, 'up'); };
    var what = t.mode === 'revenue' ? 'Sales (worked out from revenue) are ' : 'Sales are ';
    var change = changePm === 0 ? 'flat' : (changePm < 0 ? 'down ' + pmText(-changePm) : 'up ' + pmText(changePm));
    var be_ = be && be.lossPm !== null && be.lossPm !== undefined ? be.lossPm : null;
    var money_ = out.monthly === null ? '' : (out.monthly >= 0 ? ' You’re ahead about ' + money$(out.monthly) + ' a month.' : ' You’re behind about ' + money$(out.monthly) + ' a month.');
    if (changePm >= 0) {
      out.status = 'ahead';
      say(what + change + ' - ', { b: 'every sale makes more and nobody left' }, '.' + money_);
    } else if (be_ === null) {
      out.status = 'unknown';
      say(what + change + '. ', { b: 'Add your cost per sale in the meter' }, ' to see whether that beats your break-even.');
    } else if (-changePm < be_) {
      out.status = 'ahead';
      say(what + change + ' - your break-even was ' + pmText(be_) + '. ', { b: out.monthly !== null && out.monthly >= 0 ? 'You’re ahead about ' + money$(out.monthly) + ' a month.' : 'You’re ahead.' });
    } else if (-changePm === be_) {
      out.status = 'even';
      say(what + change + ' - right on your break-even of ' + pmText(be_) + '. ', { b: 'About the same profit as before' }, ', with fewer ' + (be.unit || 'customers') + ' to serve.');
    } else {
      out.status = 'behind';
      say(what + change + ' - more than your break-even of ' + pmText(be_) + '. ', { b: out.monthly !== null ? 'You’re behind about ' + money$(out.monthly) + ' a month.' : 'You’re behind.' });
    }
    if (n < 3) out.note = n === 1 ? 'One week is early to judge - give it three or four. Regulars who grumble often come back.' : 'Two weeks in. Give it one or two more before deciding anything.';
    if (be_ !== null) out.line = t.mode === 'revenue'
      ? Math.round(t.baseline * (1000 - be_) / 1000 * p1 / p0)
      : Math.round(t.baseline * (1000 - be_) / 1000);
    return out;
  }

  /* ---------------- the announcement ---------------- */

  function cleanAnnounce(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var reasons = (Array.isArray(r.reasons) ? r.reasons : []).filter(function (x, i, a) { return REASON_IDS.indexOf(x) >= 0 && a.indexOf(x) === i; });
    var since = typeof r.since === 'string' && /^(19|20)\d{2}$/.test(r.since.trim()) ? r.since.trim() : '';
    return {
      business: clean(r.business, LIMITS.business),
      type: oneOf(r.type, BUSINESS_TYPES, 'other'),
      reasons: reasons,
      since: since,
      other: clean(r.other, LIMITS.reasons),
      tone: oneOf(r.tone, TONES, 'warm'),
      summary: clean(r.summary, LIMITS.summary),
      grandfather: clean(r.grandfather, LIMITS.grandfather),
      voice: cleanBlock(r.voice, LIMITS.voice),
    };
  }

  /** The summary of the change, from the repriced list: only numbers that
   *  are in it. The page puts it in an editable box. */
  function changeSummary(pl, sym) {
    if (!pl || !pl.rows || !pl.rows.length || !pl.blended) return '';
    var raised = pl.rows.filter(function (r) { return r.change > 0; });
    if (!raised.length) return '';
    // The middle of the changes, not the extremes: a 5¢ add-on and a $1.45
    // bag of beans are not what a regular will notice. Both ends are still
    // changes from the list, so the figure check allows them.
    var changes = raised.map(function (r) { return r.change; }).sort(function (a, b) { return a - b; });
    var cutEnds = changes.length >= 5 ? Math.floor(changes.length * 0.2) : 0;
    var lo = changes[cutEnds], hi = changes[changes.length - 1 - cutEnds];
    var range = lo === hi ? 'by ' + changeText(lo, sym) : 'by ' + changeText(lo, sym) + ' to ' + changeText(hi, sym);
    var s = (raised.length === pl.rows.length ? 'Prices go up ' : 'Most prices go up ') + range + ' (about ' + bpText(Math.round(pl.blended.bp / 100) * 100) + ' overall).';
    var kept = pl.rows.filter(function (r) { return r.locked; }).slice(0, 2);
    var fmt = priceFormat(pl.rows, sym);
    if (kept.length) s += ' ' + kept.map(function (r) { return r.name; }).join(' and ') + (kept.length === 1 ? ' stays' : ' stay') + ' at ' + kept.map(function (r) { return fmt(r.old); }).join(' and ') + '.';
    return clean(s, LIMITS.summary);
  }

  /** How a list shows its prices: "$45" when every price is whole dollars,
   *  "$3.00" beside "$4.50" when any has cents. */
  function priceFormat(rows, sym) {
    var whole = (rows || []).every(function (r) { return r.old % 100 === 0 && r.price % 100 === 0; });
    return function (c) { return money(c, sym, whole); };
  }

  function listJoin(a) { return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  function reasonPhrases(a) {
    var p = a.reasons.filter(function (id) { return id !== 'since'; }).map(function (id) { return REASONS[REASON_IDS.indexOf(id)].phrase; });
    return p;
  }
  function cut(s, max) {
    if (s.length <= max) return s;
    var sentences = s.match(/[^.!?]+[.!?]+(\s|$)/g) || [s];
    var out = '';
    for (var i = 0; i < sentences.length; i++) { if ((out + sentences[i]).trim().length > max) break; out += sentences[i]; }
    out = out.trim();
    return out || s.slice(0, max - 1) + '…';
  }

  /**
   * Plain, honest versions of all five pieces, filled from the inputs alone:
   * nothing here adds a reason, a number or a promise the owner did not give.
   * Signed-out visitors and anyone out of credit get these.
   */
  function templates(raw, facts) {
    var a = cleanAnnounce(raw);
    var f = facts || {};
    var name = a.business || 'our business';
    var team = a.business ? 'The ' + a.business + ' team' : 'The team';
    var when = isoDay(f.effective) ? sayDate(f.effective) : 'soon';
    var costs = reasonPhrases(a);
    var why = costs.length ? 'what we pay for ' + listJoin(costs) + ' has gone up' : '';
    var other = a.other ? a.other.replace(/[.!?]*$/, '.') : '';
    var since = a.reasons.indexOf('since') >= 0 ? (a.since ? 'It’s our first price change since ' + a.since + '.' : 'It’s our first price change in a long while.') : '';
    var sum = a.summary;
    // Items kept at their old price, unless the summary already says so.
    var kept = (f.kept || []).slice(0, 2).filter(function (k) { return !sum || sum.indexOf(k.name) < 0; });
    var keepLine = kept.length ? kept.map(function (k) { return k.name + ' stays at ' + k.price; }).join(' and ') + '.' : '';
    var grand = a.grandfather ? a.grandfather.replace(/[.!?]*$/, '.') : '';
    var tone = a.tone;
    var open = { warm: 'Thank you for being part of ' + name + '.', plain: 'A quick note about our prices.', playful: 'Some news, served with a thank-you on the side.' }[tone];
    var close = { warm: 'We’re grateful for every one of you, and we’ll keep doing our best work.', plain: 'Thank you for your business.', playful: 'Same people, same care - see you soon!' }[tone];
    var whySentence = why ? (tone === 'plain' ? 'The reason: ' + why + '.' : 'Like a lot of small businesses, ' + why + ', and we’d rather adjust our prices than cut corners.') : '';
    var body = [
      tone === 'plain' ? 'Hello,' : 'Hi there,',
      open + ' From ' + when + ', some of our prices are changing.' + (sum ? ' ' + sum : ''),
      [whySentence, other, since].filter(Boolean).join(' '),
      keepLine,
      grand,
      close,
      team,
    ].filter(Boolean).join('\n\n');
    var subject = { warm: 'A note about our prices at ' + name, plain: 'Price changes at ' + name + ' from ' + fmtShort(f.effective || ''), playful: 'A small change at ' + name + ' (and a big thank-you)' }[tone].replace(/ from $/, '');
    var sign = cut(['New prices from ' + when + '.', sum, why ? cap(why) + ', and we won’t cut corners.' : '', grand, 'Thank you for sticking with us. - ' + (a.business || 'The team')].filter(Boolean).join(' '), 280);
    var social = cut([open, 'From ' + when + ', some of our prices are changing.', sum, whySentence, other, since, keepLine, grand, close].filter(Boolean).join(' '), 600);
    var text = cut([(a.business ? a.business + ': ' : '') + 'a heads-up - from ' + when + ' some of our prices go up.', sum, keepLine, grand, 'Thanks for being a regular!'].filter(Boolean).join(' '), 320);
    var script = [];
    script.push({ question: 'Why did prices go up?', answer: why || other ? [why ? cap(why) + '.' : '', other, 'We’d rather adjust prices a little than cut corners on what you come here for.'].filter(Boolean).join(' ') : 'Our costs have gone up, and we’d rather adjust prices a little than cut corners.' });
    if (sum) script.push({ question: 'How much did prices go up?', answer: sum });
    script.push({ question: 'When does it start?', answer: 'The new prices start ' + when + '.' });
    if (keepLine) script.push({ question: 'Is anything staying the same?', answer: keepLine });
    if (grand) script.push({ question: 'Do I keep my current price?', answer: grand });
    return {
      email: { subject: clean(subject, 120), body: cleanBlock(body, 2000) },
      sign: clean(sign, 280),
      social: clean(social, 600),
      text: clean(text, 320),
      staffScript: script.slice(0, 5).map(function (q) { return { question: clean(q.question, 140), answer: clean(q.answer, 400) }; }),
    };
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* ---------------- figures a draft may use ---------------- */

  var PCT_RE = /(\d+(?:\.\d+)?)\s?(?:%|per\s?cent\b|percent\b)/gi;
  var DOLLAR_RE = /[$£€]\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:dollars?\b|bucks\b)|(\d{1,3})\s?(?:¢|cents?\b)/gi;

  /** Every percentage and money figure in a text: {pct: [tenths], money: [cents]}. */
  function figures(text) {
    var s = String(text || '');
    var pct = [], cents = [], m;
    PCT_RE.lastIndex = 0;
    while ((m = PCT_RE.exec(s))) pct.push(Math.round(Number(m[1]) * 10));
    DOLLAR_RE.lastIndex = 0;
    while ((m = DOLLAR_RE.exec(s))) {
      if (m[5] !== undefined) { cents.push(Number(m[5])); continue; }
      var whole = (m[1] || m[3] || '0').replace(/,/g, '');
      var frac = m[2] !== undefined ? m[2] : m[4];
      cents.push(Number(whole) * 100 + (frac ? Number((frac + '0').slice(0, 2)) : 0));
    }
    return { pct: pct, money: cents };
  }

  /**
   * The figures an announcement may mention: anything in the owner's own
   * inputs (the summary, their reason, their grandfather line, the business
   * name) and the price list's own prices, changes and raises - with every
   * percentage allowed at its whole and one-decimal rounding ("about 6%").
   * The voice sample is NOT a source: "20% off Tuesdays" in last year's
   * post is not a fact about this change.
   */
  function allowedFigures(raw, facts) {
    var a = cleanAnnounce(raw);
    var f = facts || {};
    var pct = {}, cents = {};
    function addPct(tenths) {
      if (!isFinite(tenths)) return;
      pct[Math.round(tenths)] = true;              // 6.8%
      pct[Math.round(tenths / 10) * 10] = true;    // "about 7%"
    }
    [a.summary, a.other, a.grandfather, a.business].forEach(function (t) {
      var fg = figures(t);
      fg.pct.forEach(addPct);
      fg.money.forEach(function (c) { cents[c] = true; });
    });
    (f.rows || []).forEach(function (r) {
      cents[r.old] = true; cents[r.price] = true; if (r.change) cents[r.change] = true;
      if (r.old) addPct(r.change * 1000 / r.old);
    });
    if (f.blendedBp !== undefined && f.blendedBp !== null) addPct(f.blendedBp / 10);
    if (f.targetBp) addPct(f.targetBp / 10);
    return { pct: pct, money: cents };
  }

  /** The figures in `text` that are not allowed: ["12%", "$6"]. */
  function inventedFigures(text, allowed) {
    var fg = figures(text), bad = [];
    fg.pct.forEach(function (t) { if (!allowed.pct[t]) bad.push(trimNum(t / 10) + '%'); });
    fg.money.forEach(function (c) { if (!allowed.money[c]) bad.push(money(c, '$', true)); });
    return bad.filter(function (x, i, arr) { return arr.indexOf(x) === i; });
  }

  /** A model's (or the page's) draft, bounded and stripped of markup. */
  function cleanDraft(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var e = r.email && typeof r.email === 'object' ? r.email : {};
    var script = (Array.isArray(r.staffScript) ? r.staffScript : []).map(function (q) {
      if (!q || typeof q !== 'object') return null;
      var question = clean(q.question, 140), answer = clean(q.answer, 400);
      return question && answer ? { question: question, answer: answer } : null;
    }).filter(Boolean).slice(0, 5);
    return {
      email: { subject: clean(e.subject, 120), body: cleanBlock(e.body, 2000) },
      sign: clean(r.sign, 280),
      social: clean(r.social, 600),
      text: clean(r.text, 320),
      staffScript: script,
    };
  }

  /** Which pieces of a draft mention a figure that was not given:
   *  {email: ['12%'], staffScript: [...]} - empty when it is clean. */
  function draftProblems(draft, allowed) {
    var out = {};
    var check = function (key, text) { var bad = inventedFigures(text, allowed); if (bad.length) out[key] = bad; };
    check('email', draft.email.subject + '\n' + draft.email.body);
    check('sign', draft.sign);
    check('social', draft.social);
    check('text', draft.text);
    check('staffScript', draft.staffScript.map(function (q) { return q.question + ' ' + q.answer; }).join('\n'));
    return out;
  }

  /* ---------------- a whole plan ---------------- */

  function cleanMeter(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var s = function (v, n) { return typeof v === 'string' || typeof v === 'number' ? clean(String(v), n || 20) : ''; };
    return { price: s(r.price), cost: s(r.cost), margin: s(r.margin), costMode: r.costMode === 'margin' ? 'margin' : 'cost', volume: s(r.volume), newPrice: s(r.newPrice), unit: oneOf(r.unit, UNITS, 'customers'), whatIf: Number.isInteger(r.whatIf) && r.whatIf >= 0 && r.whatIf <= 1000 ? r.whatIf : null };
  }

  /** Everything a plan keeps - never a photo. Used on save, on load, and on
   *  what the page restores from localStorage. */
  function cleanPlan(raw, today) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var drafts = r.draft && typeof r.draft === 'object' ? cleanDraft(r.draft) : null;
    return {
      name: clean(r.name, LIMITS.planName),
      meter: cleanMeter(r.meter),
      lines: cleanLines(r.lines),
      settings: cleanSettings(r.settings),
      rollout: cleanRollout(r.rollout, today),
      announce: cleanAnnounce(r.announce),
      draft: drafts && (drafts.sign || drafts.email.body || drafts.social) ? drafts : null,
      tracker: cleanTracker(r.tracker),
    };
  }

  return {
    LIMITS: LIMITS, STYLES: STYLES, STYLE_IDS: STYLE_IDS, THRESHOLDS: THRESHOLDS, CURRENCIES: CURRENCIES, UNITS: UNITS, TONES: TONES,
    BUSINESS_TYPES: BUSINESS_TYPES, REASONS: REASONS, MONTHS_LONG: MONTHS_LONG,
    clean: clean, cleanBlock: cleanBlock, toCents: toCents, toBp: toBp, toCount: toCount, money: money, dollars: dollars, plainMoney: plainMoney,
    changeText: changeText, priceFormat: priceFormat, pmText: pmText, bpText: bpText, symbolOf: symbolOf, groups: groups,
    meterFrom: meterFrom, breakEven: breakEven, profitChange: profitChange, perMonth: perMonth,
    nextAbove: nextAbove, prevBelow: prevBelow, thresholdAbove: thresholdAbove, newPriceFor: newPriceFor,
    cleanLine: cleanLine, cleanLines: cleanLines, cleanSettings: cleanSettings, priceList: priceList, targetFor: targetFor, listText: listText,
    parseList: parseList,
    isoDay: isoDay, addDays: addDays, daysBetween: daysBetween, fmtDate: fmtDate, fmtShort: fmtShort, sayDate: sayDate,
    cleanRollout: cleanRollout, rollout: rollout, icsText: icsText, fold: fold, hash: hash, ics: ics, icsFilename: icsFilename,
    cleanTracker: cleanTracker, verdict: verdict,
    cleanAnnounce: cleanAnnounce, changeSummary: changeSummary, templates: templates,
    figures: figures, allowedFigures: allowedFigures, inventedFigures: inventedFigures, cleanDraft: cleanDraft, draftProblems: draftProblems,
    cleanMeter: cleanMeter, cleanPlan: cleanPlan,
  };
}));
