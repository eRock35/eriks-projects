/* Rush - the rules. Holiday preorders without the chaos: slots that fill,
 * the bake list, a pickup line that moves.
 *
 * UMD: window.RushCore in the page, require() in the server and the tests.
 * Everything that works out a shop's pickup slots, checks an order against
 * the places left and each item's cap for the day, books, edits, moves,
 * cancels and restores, counts the bake list and the trays, sorts the
 * pickup line, adds up the money, writes the CSV, lays out the box labels,
 * writes the share texts, merges two phones and checks what the AI is sent
 * and sends back lives here, so the page, the server's checks and the
 * tests run the same code.
 *
 * NO CLOCK AND NO DICE in here (tested): "now", every time stamp and every
 * id are passed in. Days are 'YYYY-MM-DD' and times 'HH:MM' on a five-minute
 * step; the arithmetic is on day numbers and minutes, with no time zone.
 * Money is whole cents: "about $28" is refused, not guessed.
 *
 * Top to bottom:
 *   - text: the doors every typed, synced or model-written string goes
 *     through (an @ in any width, nine digits in any script, a phone or card
 *     number, a link, a formula, markup, invisible characters)
 *   - days and times
 *   - the setup: the event, its pickup days, slots, the deposit rule
 *   - the menu: items, units, plurals, the starter menus
 *   - the one door for a whole shop (cleanShop) and bodyProblem
 *   - orders: money, places, caps, checkOrder and every way into a slot
 *   - the board, the bake list, the pickup line, search
 *   - the money and the CSV
 *   - box labels
 *   - the share texts
 *   - two phones: the merge, and what it flags
 *   - the AI: the request rebuilt, the answer checked, readings to drafts
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RushCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    shop: 40, event: 40, name: 40, item: 40, unit: 20, note: 200,
    days: 4, items: 40, itemRecords: 80, orders: 500, lines: 12, qty: 99, perSlot: 30,
    priceMax: 100000, batchMax: 99, capMax: 999, depositMax: 100000, noMax: 9999, trays: 99,
    storedBytes: 300 * 1024,
    aiMenu: 40, aiOrders: 8, aiLines: 6, aiName: 40, aiWords: 40, aiTime: 20, aiNote: 120,
    aiImageBytes: 2.5 * 1024 * 1024, aiImageSide: 1600,
  };
  var SLOT_MINS = [15, 20, 30, 60];

  /* ================================================================== *
   * Text
   * ================================================================== */

  // Control characters, bidi overrides and zero-width characters: built from
  // code points so no invisible character ever sits in this file.
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
  function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function pad3(n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : String(n); }
  function nf(s) { s = str(s); try { return s.normalize('NFKC'); } catch (e) { return s; } }
  /** For matching names: lower case, accents off, letters and digits only. */
  function fold(s) { var t = nf(s).toLowerCase(); try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* old engines */ } return t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(o) { return Boolean(o) && typeof o === 'object' && !Array.isArray(o); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  /** "Pumpkin pie" -> "pumpkin pie" inside a sentence, but "BBQ ribs" stays. */
  function lowerFirst(s) { s = str(s); return s.length > 1 && /\p{Ll}/u.test(s.charAt(1)) ? s.charAt(0).toLowerCase() + s.slice(1) : (s.length === 1 ? s.toLowerCase() : s); }
  function list(xs) { return xs.length <= 1 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]; }
  /** "1 order", "2 orders". */
  function plural(n, one, many) { return groups(n) + ' ' + (n === 1 ? one : (many || one + 's')); }

  // An @ in any width: NFKC folds the full-width and small forms into the
  // plain one, and the raw check catches them where normalize is missing.
  var AT_ANY = new RegExp('[@' + String.fromCharCode(0xFF20, 0xFE6B) + ']');
  function hasAt(s) { return AT_ANY.test(str(s)) || /@/.test(nf(s)); }
  var LINK = /(https?:|ftp:|mailto:|www\.|:\/\/|\b[a-z0-9-]{2,}\.(com|net|org|io|co|uk|us|app|dev|ly|me|info|biz|tv|gg|xyz|shop|store|site|online|link)\b)/i;
  function hasLink(s) { return LINK.test(nf(s)); }
  /** Seven or more digits - in any script - in one run of digits and phone
   *  punctuation: a phone number, in a name or a note. */
  function hasPhone(s) { return (nf(s).match(/\+?\p{Nd}[\p{Nd}\s().\/-]{5,}\p{Nd}/gu) || []).some(function (m) { return m.replace(/[^\p{Nd}]/gu, '').length >= 7; }); }
  /** Nine digits in a row, in any script (NFKC folds the full-width ones;
   *  \p{Nd} catches Arabic-Indic, Devanagari and the rest - JavaScript's \d
   *  is ASCII only, which is how nine Arabic-Indic digits once got past). */
  function nineDigits(s) { return /\p{Nd}{9,}/u.test(nf(s)); }
  /** A card number: 13 to 19 digits with spaces or dashes between, passing
   *  the Luhn check (or in a script whose digit values we do not fold). */
  function hasCard(s) {
    return (nf(s).match(/\p{Nd}(?:[ -]?\p{Nd}){12,18}/gu) || []).some(function (m) {
      var d = m.replace(/[ -]/g, '');
      if (!/^[0-9]+$/.test(d)) return true;
      var sum = 0;
      for (var i = 0; i < d.length; i++) { var x = +d.charAt(d.length - 1 - i); if (i % 2) { x *= 2; if (x > 9) x -= 9; } sum += x; }
      return sum % 10 === 0;
    });
  }
  /** A street address: a house number then a street word, or a box/unit. */
  var STREET = /(^|[^\p{L}\p{N}])\p{Nd}{1,6}[a-z]?\s+(?:[\p{L}'.-]+\s+){0,3}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct|way|place|pl|terrace|close|crescent|highway|hwy|parkway|pkwy|square|sq|circle|cir)\b/iu;
  function hasAddress(s) { var t = nf(s); return STREET.test(t) || /\b(p\.?\s?o\.?\s?box|apt\.?\s*#?\p{Nd}|suite\s*#?\p{Nd}|unit\s*#?\p{Nd})/iu.test(t); }
  /** What a spreadsheet would run: a leading = + - @ (or a tab or CR). */
  function isFormula(s) { s = str(s); return /^[\t\r]/.test(s) || /^\s*[=+\-@]/.test(nf(s)); }
  function hasInvisible(s) { return BAD1.test(str(s)); }
  function hasMarkup(s) { return /[<>]/.test(str(s)); }

  var WHY = {
    invisible: 'That has an invisible character in it - type it again.',
    markup: 'Leave out < and > - Rush keeps plain words.',
    at: 'That looks like an email address - Rush never keeps one. Keep those in your till or your contacts.',
    link: 'That looks like a link - Rush keeps plain words.',
    formula: 'Start it with a letter or a number - a leading = + - or @ is how a spreadsheet runs a formula.',
    card: 'That looks like a card number - never write one down here.',
    phone: 'That looks like a phone number - Rush never asks for one. Keep those in your till or your contacts.',
    nine: 'Nine digits in a row looks like a phone or account number - Rush never keeps one.',
  };
  /**
   * The text door: '' when `s` may be kept, else the sentence that says why
   * not. Refused, never cleaned - a person re-types it. `people` is for a
   * customer's name and a note, where seven digits already read as a phone
   * number.
   */
  function refuse(s, max, people) {
    s = str(s);
    if (hasInvisible(s)) return WHY.invisible;
    if (hasMarkup(s)) return WHY.markup;
    if (hasAt(s)) return WHY.at;
    if (hasLink(s)) return WHY.link;
    if (isFormula(s)) return WHY.formula;
    if (hasCard(s)) return WHY.card;
    if (people && hasPhone(s)) return WHY.phone;
    if (nineDigits(s)) return WHY.nine;
    if (max && Array.from(s.trim()).length > max) return 'Up to ' + max + ' characters.';
    return '';
  }
  /** Allergy words in a note: shown in bold on the ticket and the label. */
  var ALLERGY = /\b(allerg\w*|anaphyla\w*|epi-?pen|nuts?|peanuts?|tree ?nuts?|walnuts?|almonds?|cashews?|hazelnuts?|pecans?|gluten|coeliac|celiac|wheat|dairy|lactose|milk|eggs?|sesame|soy|soya|shellfish|fish)\b/i;
  function isAllergy(note) { return ALLERGY.test(nf(note)) && /\b(allerg\w*|anaphyla\w*|epi-?pen|no |free|intoleran\w*|coeliac|celiac|can'?t have|cannot have|avoid)/i.test(nf(note)); }

  /* ================================================================== *
   * Days and times
   * ================================================================== */

  function daysFromCivil(y, m, d) {
    y -= m <= 2 ? 1 : 0;
    var era = Math.floor(y / 400), yoe = y - era * 400;
    var doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }
  function civil(n) {
    n += 719468;
    var era = Math.floor(n / 146097), doe = n - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp + (mp < 10 ? 3 : -9);
    return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m: m, d: d };
  }
  function iso(n) { var c = civil(n); return c.y + '-' + pad2(c.m) + '-' + pad2(c.d); }
  /** 'YYYY-MM-DD' -> a day number, or null when it is not a real date. */
  function dayOf(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var n = daysFromCivil(y, mo, d);
    return iso(n) === s ? n : null;
  }
  function isIso(s) { return dayOf(s) !== null; }
  function weekday(n) { return ((n % 7) + 11) % 7; }   // 0 Sunday ... 6 Saturday
  function addDays(s, k) { return iso(dayOf(s) + k); }
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  /** "Wed 25 Nov" */
  function dayLabel(s) { var n = dayOf(s); if (n === null) return ''; var c = civil(n); return WD[weekday(n)] + ' ' + c.d + ' ' + MON[c.m - 1]; }
  /** "Wednesday 25 November" */
  function longDay(s) { var n = dayOf(s); if (n === null) return ''; var c = civil(n); return WD_LONG[weekday(n)] + ' ' + c.d + ' ' + MON_LONG[c.m - 1]; }
  function wdLong(s) { var n = dayOf(s); return n === null ? '' : WD_LONG[weekday(n)]; }

  /** 'HH:MM' on a five-minute step -> minutes after midnight, else null. */
  function mins(s) {
    var m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(str(s));
    if (!m) return null;
    var v = +m[1] * 60 + +m[2];
    return v % 5 === 0 ? v : null;
  }
  function hm(v) { return pad2(Math.floor(v / 60)) + ':' + pad2(v % 60); }
  /** 14:00 -> {t: '2:00', ap: 'pm'}: the board keeps am/pm small, on one line. */
  function clockParts(v) { var h = Math.floor(v / 60) % 24, m = v % 60; return { t: (h % 12 || 12) + ':' + pad2(m), ap: h < 12 ? 'am' : 'pm' }; }
  function clock(v) { var p = clockParts(v); return p.t + ' ' + p.ap; }
  /** "2:00-2:30 pm", "11:30 am-12:00 pm". */
  function span(a, b) {
    var x = clockParts(a), y = clockParts(b % 1440);
    return x.ap === y.ap ? x.t + '-' + y.t + ' ' + y.ap : x.t + ' ' + x.ap + '-' + y.t + ' ' + y.ap;
  }

  /** Thanksgiving: the fourth Thursday of November. */
  function thanksgiving(y) {
    var first = daysFromCivil(y, 11, 1);
    return iso(first + ((4 - weekday(first) + 7) % 7) + 21);
  }

  /* ================================================================== *
   * The setup: the event, its pickup days, the slots, the deposit
   * ================================================================== */

  var EVENTS = ['Thanksgiving pickup', 'Christmas Eve pickup'];
  var DEPOSITS = ['none', 'fixed', 'percent'];
  var PAY_KINDS = ['pickup', 'deposit', 'full'];
  var PAY_WORD = { pickup: 'Pay at pickup', deposit: 'Deposit', full: 'Paid in full' };
  var HOWS = ['cash', 'card', 'other'];
  var HOW_WORD = { cash: 'Cash', card: 'Card', other: 'Other' };
  var STATUSES = ['waiting', 'boxed', 'picked', 'cancelled'];
  var STATUS_WORD = { waiting: 'Waiting', boxed: 'Boxed - ready', picked: 'Picked up', cancelled: 'Cancelled' };

  /**
   * The event a new shop starts with, from today: the Tuesday and Wednesday
   * before Thanksgiving while it is coming, then Christmas Eve and the day
   * before, then next year's Thanksgiving.
   */
  function defaultSetup(today) {
    var n = dayOf(today), y = civil(n).y;
    var tg = dayOf(thanksgiving(y));
    var cut = function (first) { return { d: iso(first - 2), t: '18:00' }; };
    var base = { name: '', slotMin: 30, perSlot: 4, deposit: { mode: 'none', cents: 1000, pct: 25 } };
    if (n <= tg - 1) {
      return Object.assign(base, { event: EVENTS[0], days: [{ d: iso(tg - 2), open: '10:00', close: '18:00' }, { d: iso(tg - 1), open: '08:00', close: '16:00' }], cutoff: cut(tg - 2) });
    }
    var eve = daysFromCivil(y, 12, 24);
    if (n <= eve) {
      return Object.assign(base, { event: EVENTS[1], days: [{ d: iso(eve - 1), open: '10:00', close: '18:00' }, { d: iso(eve), open: '08:00', close: '14:00' }], cutoff: cut(eve - 1) });
    }
    var tg2 = dayOf(thanksgiving(y + 1));
    return Object.assign(base, { event: EVENTS[0], days: [{ d: iso(tg2 - 2), open: '10:00', close: '18:00' }, { d: iso(tg2 - 1), open: '08:00', close: '16:00' }], cutoff: cut(tg2 - 2) });
  }
  /** The first letter of the event starts every order number: T-001. */
  function letterOf(setup) {
    var t = nf(setup && setup.event);
    try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* old engines */ }
    var m = /\p{L}/u.exec(t);
    var l = m ? m[0].toUpperCase() : 'R';
    return /^[A-Z]$/.test(l) ? l : 'R';
  }
  function orderNo(setup, no) { return letterOf(setup) + '-' + pad3(no); }
  function dayOfSetup(setup, d) { return (setup.days || []).filter(function (x) { return x.d === d; })[0] || null; }
  /** A day by its weekday name ("Wednesday"), or its date when two pickup
   *  days share a weekday. */
  function dayWord(setup, d) {
    var w = wdLong(d);
    var twice = (setup.days || []).filter(function (x) { return wdLong(x.d) === w; }).length > 1;
    return twice ? dayLabel(d) : w;
  }
  /** The day's slots, each {key: 'HH:MM', s, e} in minutes. */
  function slots(setup, d) {
    var day = typeof d === 'string' ? dayOfSetup(setup, d) : d;
    if (!day) return [];
    var a = mins(day.open), b = mins(day.close), len = setup.slotMin, out = [];
    if (a === null || b === null || !len) return out;
    for (var s = a; s + len <= b; s += len) out.push({ key: hm(s), s: s, e: s + len });
    return out;
  }
  function slotOf(setup, d, key) { return slots(setup, d).filter(function (x) { return x.key === key; })[0] || null; }
  function slotSpan(setup, key) { var s = mins(key); return s === null ? '' : span(s, s + setup.slotMin); }
  function depositFor(setup, total) {
    var dp = setup.deposit || {};
    if (dp.mode === 'fixed') return Math.min(total, dp.cents || 0);
    if (dp.mode === 'percent') return Math.min(total, Math.round(total * (dp.pct || 0) / 100));
    return 0;
  }
  function depositWord(setup) {
    var dp = setup.deposit || {};
    if (dp.mode === 'fixed') return 'A ' + money(dp.cents) + ' deposit holds your order.';
    if (dp.mode === 'percent') return 'A ' + dp.pct + '% deposit holds your order.';
    return 'No deposit - pay at pickup.';
  }

  /* ================================================================== *
   * The menu
   * ================================================================== */

  /** One word in its plural: "pie" pies, "loaf" loaves, "dozen" dozen. */
  function pluralWord(w) {
    if (/^(dozen|each|half-dozen|cheese|bread|cornbread|stuffing|gravy)$/i.test(w)) return w;
    if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + 'ies';
    if (/(s|x|z|ch|sh)$/i.test(w)) return w + 'es';
    if (/(loaf|half|shelf|leaf|calf)$/i.test(w)) return w.slice(0, -1) + 'ves';
    if (/fe$/i.test(w)) return w.slice(0, -2) + 'ves';
    return w + 's';
  }
  function pluralPhrase(p) { var ws = str(p).split(' '); ws[ws.length - 1] = pluralWord(ws[ws.length - 1]); return ws.join(' '); }
  function lastWord(p) { var ws = str(p).trim().toLowerCase().split(/\s+/); return ws[ws.length - 1] || ''; }
  /**
   * "1 pumpkin pie", "2 pumpkin pies", "1 dozen dinner rolls", "2 trays of
   * mac and cheese", "3 cranberry loaves": the unit is part of the name when
   * the name ends with it, a count word when it is a dozen, and "of"
   * otherwise.
   */
  function qtyText(item, n) {
    var u = str(item.unit).trim().toLowerCase(), nm = lowerFirst(str(item.name).trim());
    if (/^(half )?dozen$|^half-dozen$/.test(u)) return n + ' ' + u + ' ' + nm;
    var lu = lastWord(u), ln = lastWord(nm);
    if (!u || u === 'each' || ln === lu) return n + ' ' + (n === 1 ? nm : pluralPhrase(nm));
    if (ln === pluralWord(lu)) return n + ' ' + nm;
    return n + ' ' + (n === 1 ? u : pluralPhrase(u)) + ' of ' + nm;
  }
  /** "$30 a whole pie", "$12 a dozen". */
  function priceWord(item) {
    var u = str(item.unit).trim().toLowerCase();
    return money(item.price) + (u && u !== 'each' ? ' ' + (/^[aeiou]/.test(u) ? 'an ' : 'a ') + u : ' each');
  }
  function capWord(item) { return item.cap === null || item.cap === undefined ? 'No limit' : 'Up to ' + item.cap + ' a day'; }

  // Three starter menus, plain names only: tap one and change anything.
  var STARTERS = {
    bakery: { label: 'Bakery: pies and rolls', items: [
      ['Pumpkin pie', 'whole pie', 2800, 6, 30], ['Pecan pie', 'whole pie', 3200, 6, 24], ['Apple pie', 'whole pie', 3000, 6, 30],
      ['Dinner rolls', 'dozen', 1000, 4, null], ['Pumpkin bread', 'loaf', 1400, 8, 24]] },
    butcher: { label: 'Butcher: turkeys and hams', items: [
      ['Fresh turkey', 'whole turkey', 6800, 10, 25], ['Turkey breast', 'breast', 3400, 12, 30], ['Spiral ham', 'half ham', 5200, 8, 20],
      ['Sausage stuffing', 'tray', 1800, 6, null], ['Turkey gravy', 'quart', 900, 12, null]] },
    caterer: { label: 'Caterer: sides and platters', items: [
      ['Mac and cheese', 'tray', 4500, 4, 20], ['Green bean casserole', 'tray', 3800, 4, 20], ['Mashed potatoes', 'tray', 3200, 4, 24],
      ['Roasted vegetable platter', 'platter', 5500, 3, 12], ['Cheese board', 'board', 6000, 2, 10], ['Dinner rolls', 'dozen', 1000, 6, null]] },
  };
  /** A starter menu as items, with the ids the page passes in. */
  function starterItems(key, ids, t) {
    var s = STARTERS[key];
    if (!s) return [];
    return s.items.map(function (x, i) { return { id: ids[i], name: x[0], unit: x[1], price: x[2], batch: x[3], cap: x[4], off: false, del: false, pos: i, t: t }; });
  }
  /** The menu as it is offered: not removed, in its own order. */
  function menu(shop) {
    return Object.keys(shop.items || {}).map(function (k) { return shop.items[k]; }).filter(function (x) { return !x.del; })
      .sort(function (a, b) { return a.pos - b.pos || (a.id < b.id ? -1 : 1); });
  }
  function itemOf(shop, id) { return (shop.items && own(shop.items, id)) ? shop.items[id] : null; }

  /* ================================================================== *
   * The one door for a whole shop
   * ================================================================== */

  var ID = { item: /^[a-z][a-z0-9]{2,15}$/, order: /^o[a-z0-9]{9}$/ };
  function isT(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && v < 1e14; }
  function isInt(v, lo, hi) { return typeof v === 'number' && Math.floor(v) === v && v >= lo && v <= hi; }
  function keysOnly(o, allowed, path, errs, strict) {
    if (!strict) return;
    Object.keys(o).forEach(function (k) { if (allowed.indexOf(k) < 0) errs.push('Unknown field ' + path + k + '.'); });
  }
  /** A typed string: strict refuses anything the text door would; lenient
   *  (what this phone reads back) mends it. */
  function text(v, max, path, errs, strict, need, people) {
    if (typeof v !== 'string') { if (strict && (v !== undefined || need)) errs.push(path + ' must be text.'); return ''; }
    if (strict) {
      var why = refuse(v, max, people);
      if (why) errs.push(path + ': ' + why);
    }
    var out = line(v, max);
    if (strict && need && !out) errs.push(path + ' is empty.');
    return out;
  }

  function cleanSetup(raw, errs, strict) {
    var s = isObj(raw) ? raw : {};
    if (strict && !isObj(raw)) errs.push('setup is missing.');
    keysOnly(s, ['name', 'event', 'days', 'slotMin', 'perSlot', 'cutoff', 'deposit'], 'setup.', errs, strict);
    var out = {};
    out.name = text(s.name, LIMITS.shop, 'setup.name', errs, strict);
    out.event = text(s.event, LIMITS.event, 'setup.event', errs, strict, true) || EVENTS[0];
    out.slotMin = SLOT_MINS.indexOf(s.slotMin) >= 0 ? s.slotMin : (strict && errs.push('setup.slotMin must be 15, 20, 30 or 60.'), 30);
    out.perSlot = isInt(s.perSlot, 1, LIMITS.perSlot) ? s.perSlot : (strict && errs.push('setup.perSlot must be 1 to ' + LIMITS.perSlot + '.'), 3);
    var days = Array.isArray(s.days) ? s.days : [];
    if (strict && !Array.isArray(s.days)) errs.push('setup.days is missing.');
    if (days.length > LIMITS.days) { if (strict) errs.push('setup.days: up to ' + LIMITS.days + '.'); days = days.slice(0, LIMITS.days); }
    var seen = {};
    out.days = days.map(function (d, i) {
      var p = 'setup.days[' + i + ']';
      if (!isObj(d)) { if (strict) errs.push(p + ' is not a day.'); return null; }
      keysOnly(d, ['d', 'open', 'close'], p + '.', errs, strict);
      var a = mins(d.open), b = mins(d.close);
      if (!isIso(d.d) || a === null || b === null || b - a < out.slotMin || seen[d.d]) { if (strict) errs.push(p + ' needs a date, and open and close times a slot apart.'); return null; }
      seen[d.d] = true;
      return { d: d.d, open: d.open, close: d.close };
    }).filter(Boolean).sort(function (x, y) { return x.d < y.d ? -1 : 1; });
    if (!out.days.length && strict) errs.push('setup.days: at least one pickup day.');
    var c = s.cutoff;
    if (c === null || c === undefined) out.cutoff = null;
    else if (isObj(c) && isIso(c.d) && mins(c.t) !== null) { keysOnly(c, ['d', 't'], 'setup.cutoff.', errs, strict); out.cutoff = { d: c.d, t: c.t }; }
    else { if (strict) errs.push('setup.cutoff is not a day and a time.'); out.cutoff = null; }
    var dp = isObj(s.deposit) ? s.deposit : {};
    if (strict && !isObj(s.deposit)) errs.push('setup.deposit is missing.');
    keysOnly(dp, ['mode', 'cents', 'pct'], 'setup.deposit.', errs, strict);
    out.deposit = {
      mode: DEPOSITS.indexOf(dp.mode) >= 0 ? dp.mode : (strict && errs.push('setup.deposit.mode is not none, fixed or percent.'), 'none'),
      cents: isInt(dp.cents, 0, LIMITS.depositMax) ? dp.cents : (strict && errs.push('setup.deposit.cents is not an amount.'), 1000),
      pct: isInt(dp.pct, 1, 100) ? dp.pct : (strict && errs.push('setup.deposit.pct must be 1 to 100.'), 25),
    };
    return out;
  }

  function cleanItem(k, v, errs, strict) {
    var p = 'items.' + k;
    if (!ID.item.test(k)) { if (strict) errs.push(p + ': not an item id.'); return null; }
    if (!isObj(v)) { if (strict) errs.push(p + ' is not an item.'); return null; }
    keysOnly(v, ['id', 'name', 'unit', 'price', 'batch', 'cap', 'off', 'del', 'pos', 't'], p + '.', errs, strict);
    var name = text(v.name, LIMITS.item, p + '.name', errs, strict, true);
    var unit = text(v.unit, LIMITS.unit, p + '.unit', errs, strict);
    var ok = true;
    var num = function (f, lo, hi, dflt) { if (isInt(v[f], lo, hi)) return v[f]; if (strict) errs.push(p + '.' + f + ' must be a whole number from ' + lo + ' to ' + hi + '.'); ok = ok && !strict; return dflt; };
    var out = {
      id: k, name: name, unit: unit,
      price: num('price', 0, LIMITS.priceMax, 0),
      batch: num('batch', 1, LIMITS.batchMax, 6),
      cap: v.cap === null || v.cap === undefined ? null : num('cap', 1, LIMITS.capMax, null),
      off: v.off === true, del: v.del === true,
      pos: isInt(v.pos, 0, 999) ? v.pos : 0,
      t: isT(v.t) ? v.t : (strict && errs.push(p + '.t is not a time.'), 0),
    };
    if (strict && v.id !== undefined && v.id !== k) errs.push(p + '.id does not match.');
    ['off', 'del'].forEach(function (f) { if (strict && v[f] !== undefined && typeof v[f] !== 'boolean') errs.push(p + '.' + f + ' must be true or false.'); });
    if (!name) return null;
    return out;
  }

  function cleanOrder(k, v, items, errs, strict) {
    var p = 'orders.' + k;
    if (!ID.order.test(k)) { if (strict) errs.push(p + ': not an order id.'); return null; }
    if (!isObj(v)) { if (strict) errs.push(p + ' is not an order.'); return null; }
    keysOnly(v, ['id', 'no', 'name', 'day', 'slot', 'lines', 'note', 'pay', 'status', 'got', 'prev', 'at', 'u', 'su'], p + '.', errs, strict);
    var bad = function (m) { if (strict) errs.push(p + m); };
    var name = text(v.name, LIMITS.name, p + '.name', errs, strict, true, true);
    var note = text(v.note, LIMITS.note, p + '.note', errs, strict, false, true);
    var no = isInt(v.no, 1, LIMITS.noMax) ? v.no : (bad('.no is not an order number.'), 0);
    var status = STATUSES.indexOf(v.status) >= 0 ? v.status : (bad('.status is not waiting, boxed, picked or cancelled.'), 'waiting');
    var prev = v.prev === undefined || v.prev === '' ? '' : (STATUSES.indexOf(v.prev) >= 0 && v.prev !== 'picked' ? v.prev : (bad('.prev is not a status.'), ''));
    if (!isIso(v.day)) bad('.day is not a date.');
    if (mins(v.slot) === null) bad('.slot is not a time.');
    var lines = (Array.isArray(v.lines) ? v.lines : []);
    if (!Array.isArray(v.lines)) bad('.lines is missing.');
    if (lines.length > LIMITS.lines) { bad('.lines: up to ' + LIMITS.lines + '.'); lines = lines.slice(0, LIMITS.lines); }
    var seenI = {};
    lines = lines.map(function (l, i) {
      var lp = '.lines[' + i + ']';
      if (!isObj(l)) { bad(lp + ' is not a line.'); return null; }
      if (strict) Object.keys(l).forEach(function (f) { if (['item', 'qty', 'price'].indexOf(f) < 0) errs.push('Unknown field ' + p + lp + '.' + f + '.'); });
      if (typeof l.item !== 'string' || !own(items, l.item)) { bad(lp + '.item is not on this shop’s menu.'); return null; }
      if (seenI[l.item]) { bad(lp + ': the same item twice.'); return null; }
      if (!isInt(l.qty, 1, LIMITS.qty)) { bad(lp + '.qty must be 1 to ' + LIMITS.qty + '.'); return null; }
      if (!isInt(l.price, 0, LIMITS.priceMax)) { bad(lp + '.price is not an amount.'); return null; }
      seenI[l.item] = true;
      return { item: l.item, qty: l.qty, price: l.price };
    }).filter(Boolean);
    if (!lines.length) bad(' has no items.');
    var py = isObj(v.pay) ? v.pay : {};
    if (!isObj(v.pay)) bad('.pay is missing.');
    if (strict) Object.keys(py).forEach(function (f) { if (['kind', 'paid', 'how'].indexOf(f) < 0) errs.push('Unknown field ' + p + '.pay.' + f + '.'); });
    var pay = {
      kind: PAY_KINDS.indexOf(py.kind) >= 0 ? py.kind : (bad('.pay.kind is not pickup, deposit or full.'), 'pickup'),
      paid: isInt(py.paid, 0, 10000000) ? py.paid : (bad('.pay.paid is not an amount.'), 0),
      how: py.how === '' || py.how === undefined ? '' : (HOWS.indexOf(py.how) >= 0 ? py.how : (bad('.pay.how is not cash, card or other.'), '')),
    };
    var got = null;
    if (v.got !== null && v.got !== undefined) {
      if (!isObj(v.got) || !isInt(v.got.cents, 0, 10000000) || HOWS.indexOf(v.got.how) < 0) bad('.got is not an amount and how.');
      else { if (strict) Object.keys(v.got).forEach(function (f) { if (['cents', 'how'].indexOf(f) < 0) errs.push('Unknown field ' + p + '.got.' + f + '.'); }); got = { cents: v.got.cents, how: v.got.how }; }
    }
    if (strict && v.id !== undefined && v.id !== k) errs.push(p + '.id does not match.');
    var t = function (f) { return isT(v[f]) ? v[f] : (bad('.' + f + ' is not a time.'), 0); };
    var out = { id: k, no: no, name: name, day: isIso(v.day) ? v.day : '', slot: mins(v.slot) !== null ? v.slot : '', lines: lines, note: note, pay: pay, status: status, got: got, prev: prev, at: t('at'), u: t('u'), su: t('su') };
    if (!out.day || !out.slot || !lines.length || !no || !name) return null;
    return out;
  }

  function cleanBake(map, setup, items, errs, strict) {
    var out = {};
    if (map !== undefined && !isObj(map)) { if (strict) errs.push('bake is not a map.'); return out; }
    Object.keys(map || {}).forEach(function (k) {
      var v = map[k], m = /^(\d{4}-\d{2}-\d{2})\|([a-z][a-z0-9]{2,15})$/.exec(k);
      if (!m || !isIso(m[1]) || !own(items, m[2])) { if (strict) errs.push('bake.' + k + ': not a day and an item of this shop.'); return; }
      if (!isObj(v) || !isInt(v.n, 0, LIMITS.trays) || !isT(v.t)) { if (strict) errs.push('bake.' + k + ' is not a tray count.'); return; }
      keysOnly(v, ['n', 't'], 'bake.' + k + '.', errs, strict);
      out[k] = { n: v.n, t: v.t };
    });
    return out;
  }

  /**
   * The one door. Every shop read back from this phone, from the account,
   * or sent to the server is rebuilt field by field: unknown fields dropped
   * (strict: refused), every enum, date, time, id and number checked, every
   * string through the text door. `strict` is the server's mode: it
   * collects every problem in `errors` instead of mending it. A live order
   * on a day the shop does not have, or a line naming an item it does not
   * have, is refused (strict) or dropped.
   */
  function cleanShop(raw, strict) {
    var errs = [];
    var r = isObj(raw) ? raw : {};
    if (strict && !isObj(raw)) errs.push('Send a shop.');
    keysOnly(r, ['v', 'setup', 'setupT', 'items', 'orders', 'bake', 'updatedAt'], '', errs, strict);
    var setup = cleanSetup(r.setup, errs, strict);
    var itemsIn = isObj(r.items) ? r.items : {};
    if (r.items !== undefined && !isObj(r.items) && strict) errs.push('items is not a map.');
    var ik = Object.keys(itemsIn);
    if (ik.length > LIMITS.itemRecords) { if (strict) errs.push('items: too many.'); ik = ik.slice(0, LIMITS.itemRecords); }
    var items = {};
    ik.forEach(function (k) { var it = cleanItem(k, itemsIn[k], errs, strict); if (it) items[k] = it; });
    if (Object.keys(items).filter(function (k) { return !items[k].del; }).length > LIMITS.items) errs.push('items: up to ' + LIMITS.items + ' on the menu.');
    var ordersIn = isObj(r.orders) ? r.orders : {};
    if (r.orders !== undefined && !isObj(r.orders) && strict) errs.push('orders is not a map.');
    var ok = Object.keys(ordersIn);
    if (ok.length > LIMITS.orders) { if (strict) errs.push('orders: up to ' + LIMITS.orders + '.'); ok = ok.slice(0, LIMITS.orders); }
    var orders = {};
    ok.forEach(function (k) {
      var o = cleanOrder(k, ordersIn[k], items, errs, strict);
      if (!o) return;
      if (o.status !== 'cancelled' && !dayOfSetup(setup, o.day)) { if (strict) errs.push('orders.' + k + ': its day is not one of this shop’s pickup days.'); else return; }
      orders[k] = o;
    });
    var out = {
      v: 1, setup: setup,
      setupT: isT(r.setupT) ? r.setupT : (strict && errs.push('setupT is not a time.'), 0),
      items: items, orders: orders,
      bake: cleanBake(r.bake, setup, items, errs, strict),
    };
    if (strict && r.v !== undefined && r.v !== 1) errs.push('v must be 1.');
    if (isT(r.updatedAt)) out.updatedAt = r.updatedAt;
    return { shop: out, errors: errs };
  }

  /**
   * What the server refuses whole before the one door even looks: any
   * string anywhere with an @ (any width), nine digits in a row (any
   * script), a link, a formula, markup or an invisible character. Numbers
   * are numbers - times and prices are never strings. The first problem, or ''.
   */
  function bodyProblem(v, depth) {
    depth = depth || 0;
    if (depth > 8) return 'That is nested too deeply.';
    if (typeof v === 'string') {
      if (hasAt(v)) return 'Something in it has an @ - Rush keeps no email addresses.';
      if (nineDigits(v)) return 'Something in it has nine digits in a row - Rush keeps no phone, card or account numbers.';
      if (hasLink(v)) return 'Something in it looks like a link.';
      if (isFormula(v)) return 'Something in it starts like a spreadsheet formula.';
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

  function newShop(setup, t) { return { v: 1, setup: setup, setupT: t, items: {}, orders: {}, bake: {} }; }

  /* ================================================================== *
   * Orders
   * ================================================================== */

  function money(cents) {
    var c = Math.round(cents || 0), neg = c < 0; c = Math.abs(c);
    var d = Math.floor(c / 100), r = c % 100;
    return (neg ? '-' : '') + '$' + groups(d) + (r ? '.' + pad2(r) : '');
  }
  /** "$12.50" or "12.5" -> 1250; "about $28", "twelve" -> null. */
  function parseMoney(s) {
    var m = /^\s*\$?\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(nf(s).replace(/,(?=\d{3}\b)/g, ''));
    if (!m) return null;
    return +m[1] * 100 + (m[2] ? +(m[2] + '0').slice(0, 2) : 0);
  }
  function allOrders(shop) { return Object.keys(shop.orders || {}).map(function (k) { return shop.orders[k]; }); }
  function live(o) { return o.status !== 'cancelled'; }
  function liveOrders(shop) { return allOrders(shop).filter(live); }
  function byPlace(a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : (mins(a.slot) - mins(b.slot)) || (a.no - b.no) || (a.id < b.id ? -1 : 1); }
  function total(o) { return o.lines.reduce(function (s, l) { return s + l.qty * l.price; }, 0); }
  /** What is still owed at pickup. */
  function balance(o) { return Math.max(0, total(o) - (o.pay ? o.pay.paid : 0) - (o.got ? o.got.cents : 0)); }
  function dueWord(o) { var b = balance(o); return b ? money(b) + ' due' : 'Paid'; }
  function nextNo(shop) { return allOrders(shop).reduce(function (m, o) { return Math.max(m, o.no || 0); }, 0) + 1; }
  function booked(shop, d, key, except) {
    return liveOrders(shop).filter(function (o) { return o.day === d && o.slot === key && o.id !== except; }).length;
  }
  function itemBooked(shop, item, d, except) {
    return liveOrders(shop).reduce(function (s, o) {
      if (o.day !== d || o.id === except) return s;
      return s + o.lines.reduce(function (t, l) { return t + (l.item === item ? l.qty : 0); }, 0);
    }, 0);
  }
  /** How many of an item are left for a day, or null with no cap. */
  function itemLeft(shop, item, d, except) {
    var it = itemOf(shop, item);
    if (!it || it.cap === null || it.cap === undefined) return null;
    return it.cap - itemBooked(shop, item, d, except);
  }
  /** "Pecan pie: 4 left for Wednesday", "Pecan pie: sold out for Wednesday". */
  function capLine(shop, item, d, except) {
    var it = itemOf(shop, item), left = itemLeft(shop, item, d, except), w = dayWord(shop.setup, d);
    if (!it) return '';
    if (left === null) return it.name + ': no limit for ' + w;
    return it.name + ': ' + (left <= 0 ? 'sold out' : left + ' left') + ' for ' + w;
  }
  function isPast(d, s, now) { if (!now) return false; return d < now.d || (d === now.d && s.e <= now.m); }
  /** The open slot nearest `key` on day `d` with room for one more order and
   *  not yet over; ties go to the earlier one. */
  function nearestSlot(shop, d, key, o) {
    o = o || {};
    var want = mins(key), best = null;
    slots(shop.setup, d).forEach(function (s) {
      if (s.key === key && o.notSame) return;
      if (isPast(d, s, o.now) || booked(shop, d, s.key, o.except) >= shop.setup.perSlot) return;
      var dist = want === null ? s.s : Math.abs(s.s - want);
      if (!best || dist < best.dist) best = { key: s.key, dist: dist };
    });
    return best ? best.key : null;
  }
  /** Would every line fit day `d`? */
  function linesFit(shop, lines, d, except) {
    return lines.every(function (l) { var left = itemLeft(shop, l.item, d, except); return left === null || l.qty <= left; });
  }
  /** The other pickup day where the whole order fits and a slot has room. */
  function otherDay(shop, ord, o) {
    var found = null;
    shop.setup.days.forEach(function (day) {
      if (found || day.d === ord.day) return;
      if (!linesFit(shop, ord.lines, day.d, ord.id)) return;
      var slot = slotOf(shop.setup, day.d, ord.slot) && !isPast(day.d, slotOf(shop.setup, day.d, ord.slot), o.now) && booked(shop, day.d, ord.slot, ord.id) < shop.setup.perSlot ? ord.slot : nearestSlot(shop, day.d, ord.slot, { now: o.now, except: ord.id });
      if (slot) found = { day: day.d, slot: slot };
    });
    return found;
  }

  /**
   * ONE check for every way into a slot - typed, edited, moved, restored, an
   * AI draft, or what a merge brought in: the places left in the slot and
   * each item's cap for the day, leaving this order's own places out of the
   * count. Every refusal carries a fix the page draws as a button:
   *   {ok: true} or {ok: false, msg, fixes: [{label, act, ...}], problems}
   * Acts: 'moveDay' {day, slot}, 'moveSlot' {slot}, 'drop' {item},
   * 'set' {item, qty}, 'focus' {target}.
   */
  function checkOrder(shop, ord, o) {
    o = o || {};
    var setup = shop.setup, problems = [], except = ord.id;
    var add = function (code, msg, fixes) { problems.push({ code: code, msg: msg, fixes: fixes }); };
    var whyName = refuse(ord.name, LIMITS.name, true);
    if (!line(ord.name, LIMITS.name)) add('name', 'Add the customer’s name - a first name and last initial is plenty.', [{ label: 'Add a name', act: 'focus', target: 'name' }]);
    else if (whyName) add('name', whyName, [{ label: 'Change the name', act: 'focus', target: 'name' }]);
    var whyNote = ord.note ? refuse(ord.note, LIMITS.note, true) : '';
    if (whyNote) add('note', whyNote, [{ label: 'Change the note', act: 'focus', target: 'note' }]);
    var lines = (ord.lines || []).filter(function (l) { return l.qty > 0; });
    if (!lines.length) add('items', 'Add at least one item.', [{ label: 'Pick the items', act: 'focus', target: 'items' }]);
    lines.forEach(function (l) {
      var it = itemOf(shop, l.item);
      if (!it || it.del) add('item', 'That item is no longer on the menu.', [{ label: 'Take it off', act: 'drop', item: l.item }]);
      else if (l.qty > LIMITS.qty) add('qty', 'Up to ' + LIMITS.qty + ' of one item in an order.', [{ label: 'Make it ' + LIMITS.qty, act: 'set', item: l.item, qty: LIMITS.qty }]);
    });
    var day = dayOfSetup(setup, ord.day);
    if (!day) {
      var first = setup.days[0];
      add('day', 'Pick one of the pickup days.', first ? [{ label: 'Pick ' + dayLabel(first.d), act: 'moveDay', day: first.d, slot: nearestSlot(shop, first.d, ord.slot, { now: o.now, except: except }) || '' }] : [{ label: 'Add a pickup day in Setup', act: 'setup' }]);
      return refusal(problems);
    }
    var s = slotOf(setup, ord.day, ord.slot), w = dayWord(setup, ord.day);
    var alt = function () { return nearestSlot(shop, ord.day, ord.slot, { now: o.now, except: except, notSame: true }); };
    var elsewhere = function () { return otherDay(shop, { id: except, day: ord.day, slot: ord.slot, lines: lines }, o); };
    var slotFix = function () {
      var k = alt();
      if (k) return [{ label: 'Move it to ' + clock(mins(k)), act: 'moveSlot', slot: k }];
      var e = elsewhere();
      return e ? [{ label: 'Move the order to ' + dayWord(setup, e.day), act: 'moveDay', day: e.day, slot: e.slot }] : [{ label: 'Add room in Setup', act: 'setup' }];
    };
    if (!s) add('slot', 'Pick a pickup time on ' + w + '.', slotFix());
    else if (isPast(ord.day, s, o.now)) {
      var nk = alt();
      add('past', clock(s.s) + ' on ' + w + ' has passed' + (nk ? ' - ' + clock(mins(nk)) + ' has room.' : '.'), slotFix());
    } else if (booked(shop, ord.day, ord.slot, except) >= setup.perSlot) {
      var fk = alt();
      add('full', clock(s.s) + ' on ' + w + ' is full' + (fk ? ' - ' + clock(mins(fk)) + ' has room.' : '.'), slotFix());
    }
    lines.forEach(function (l) {
      var it = itemOf(shop, l.item);
      if (!it || it.del) return;
      var left = itemLeft(shop, l.item, ord.day, except);
      if (left === null || l.qty <= left) return;
      var e = elsewhere(), name = lowerFirst(it.name), fixes = [];
      var otherLeft = e ? itemLeft(shop, l.item, e.day, except) : null;
      var there = e ? ' - ' + (otherLeft === null ? 'there is room ' : otherLeft + ' left ') + dayWord(setup, e.day) : '';
      if (left > 0) fixes.push({ label: 'Make it ' + left, act: 'set', item: l.item, qty: left });
      if (e) fixes.push({ label: 'Move the order to ' + dayWord(setup, e.day), act: 'moveDay', day: e.day, slot: e.slot });
      fixes.push({ label: 'Take the ' + name + ' off', act: 'drop', item: l.item });
      if (left <= 0) add('soldout', it.name + ' is sold out for ' + w + there + (e ? '. Move it?' : '.'), fixes);
      else add('cap', 'Only ' + qtyText(it, left) + ' left for ' + w + ' - this order has ' + l.qty + there + '.', fixes);
    });
    return problems.length ? refusal(problems) : { ok: true };
  }
  function refusal(problems) { return { ok: false, msg: problems[0].msg, fixes: problems[0].fixes, problems: problems }; }

  /** A draft from the order form into an order: new lines take today's menu
   *  price, lines the order already had keep the price it was taken at. */
  function shapeOrder(shop, draft, prev) {
    var had = {};
    (prev ? prev.lines : []).forEach(function (l) { had[l.item] = l.price; });
    var lines = (draft.lines || []).filter(function (l) { return l.qty > 0; }).map(function (l) {
      var it = itemOf(shop, l.item);
      return { item: l.item, qty: l.qty, price: own(had, l.item) ? had[l.item] : (it ? it.price : 0) };
    });
    var t = lines.reduce(function (s, l) { return s + l.qty * l.price; }, 0);
    var py = draft.pay || { kind: 'pickup', paid: 0, how: '' };
    var paid = py.kind === 'full' ? t : py.kind === 'deposit' ? Math.min(t, Math.max(0, py.paid | 0)) : 0;
    return { lines: lines, pay: { kind: py.kind, paid: paid, how: py.kind === 'pickup' ? '' : (HOWS.indexOf(py.how) >= 0 ? py.how : 'cash') } };
  }
  /**
   * Book a new order or save an edit. `o` = {t, now, id}: the time stamp,
   * the page's now and, for a new order, its id. Through checkOrder first.
   */
  function saveOrder(shop, draft, o) {
    var prev = draft.id && shop.orders[draft.id] ? shop.orders[draft.id] : null;
    var sh = shapeOrder(shop, draft, prev);
    var ord = {
      id: prev ? prev.id : o.id, no: prev ? prev.no : nextNo(shop), name: str(draft.name), day: draft.day, slot: draft.slot,
      lines: sh.lines, note: str(draft.note), pay: sh.pay,
      status: prev ? prev.status : 'waiting', got: prev ? prev.got : null, prev: prev ? prev.prev : '',
      at: prev ? prev.at : o.t, u: o.t, su: prev ? prev.su : o.t,
    };
    if (prev && prev.status === 'cancelled') return refusal([{ code: 'cancelled', msg: 'This order is cancelled - restore it first.', fixes: [{ label: 'Restore it', act: 'restore' }] }]);
    var unchangedPlace = prev && prev.day === ord.day && prev.slot === ord.slot;
    // The check sees the text as typed: markup, an invisible character or one
    // too many is refused, never quietly cleaned. Only what passed is kept.
    var chk = checkOrder(shop, ord, { now: unchangedPlace && prev.status !== 'waiting' ? null : o.now });
    if (!chk.ok) return chk;
    ord.name = line(ord.name, LIMITS.name); ord.note = line(ord.note, LIMITS.note);
    if (!prev && allOrders(shop).length >= LIMITS.orders) return refusal([{ code: 'full', msg: 'Rush keeps up to ' + LIMITS.orders + ' orders a shop.', fixes: [{ label: 'See the orders', act: 'orders' }] }]);
    if (!ord.id || !ID.order.test(ord.id)) throw new Error('saveOrder needs an id');
    var next = clone(shop);
    next.orders[ord.id] = ord;
    return { ok: true, shop: next, order: ord };
  }
  /** Move an order to another day and slot - through the same check. */
  function moveOrder(shop, id, day, slot, o) {
    var prev = shop.orders[id];
    if (!prev) return refusal([{ code: 'gone', msg: 'That order is not here any more.', fixes: [{ label: 'See the orders', act: 'orders' }] }]);
    return saveOrder(shop, { id: id, name: prev.name, day: day, slot: slot, lines: prev.lines, note: prev.note, pay: prev.pay }, o);
  }
  function stamp(shop, id, fields, t) {
    var next = clone(shop), ord = next.orders[id];
    Object.keys(fields).forEach(function (k) { ord[k] = fields[k]; });
    ord.su = t;
    return { ok: true, shop: next, order: ord };
  }
  /** Cancel: it stays in the history with its number, and frees its place
   *  and its items. */
  function cancelOrder(shop, id, t) {
    var o = shop.orders[id];
    if (!o) return refusal([{ code: 'gone', msg: 'That order is not here any more.', fixes: [{ label: 'See the orders', act: 'orders' }] }]);
    if (o.status === 'picked') return refusal([{ code: 'picked', msg: 'It has been picked up - undo that first.', fixes: [{ label: 'Undo the pickup', act: 'undo' }] }]);
    if (o.status === 'cancelled') return { ok: true, shop: shop, order: o };
    return stamp(shop, id, { status: 'cancelled', prev: o.status }, t);
  }
  /** Restore a cancelled order - through the caps again. */
  function restoreOrder(shop, id, o) {
    var ord = shop.orders[id];
    if (!ord || ord.status !== 'cancelled') return refusal([{ code: 'gone', msg: 'That order is not cancelled.', fixes: [{ label: 'See the orders', act: 'orders' }] }]);
    var back = clone(ord); back.status = 'waiting';
    var chk = checkOrder(shop, back, { now: o.now });
    if (!chk.ok) return chk;
    return stamp(shop, id, { status: ord.prev === 'boxed' ? 'boxed' : 'waiting', prev: '' }, o.t);
  }
  /** Waiting -> Boxed - ready, and back. */
  function setBoxed(shop, id, on, t) {
    var o = shop.orders[id];
    if (!o || o.status === 'cancelled' || o.status === 'picked') return refusal([{ code: 'state', msg: 'That order can’t be boxed now.', fixes: [{ label: 'See the orders', act: 'orders' }] }]);
    return stamp(shop, id, { status: on ? 'boxed' : 'waiting' }, t);
  }
  /** Picked up: a balance is collected, and how it was paid is said. */
  function pickUp(shop, id, how, t) {
    var o = shop.orders[id];
    if (!o || o.status === 'cancelled') return refusal([{ code: 'state', msg: 'That order is cancelled.', fixes: [{ label: 'See the orders', act: 'orders' }] }]);
    if (o.status === 'picked') return { ok: true, shop: shop, order: o };
    var due = balance(o);
    if (due > 0 && HOWS.indexOf(how) < 0) return refusal([{ code: 'how', msg: money(due) + ' is due - how was it paid?', fixes: HOWS.map(function (h) { return { label: HOW_WORD[h], act: 'collect', how: h }; }) }]);
    return stamp(shop, id, { status: 'picked', prev: o.status, got: due > 0 ? { cents: due, how: how } : null }, t);
  }
  /** Undo a pickup: the order is back where it was and the money given back. */
  function undoPickup(shop, id, t) {
    var o = shop.orders[id];
    if (!o || o.status !== 'picked') return refusal([{ code: 'state', msg: 'That order is not picked up.', fixes: [{ label: 'See the orders', act: 'orders' }] }]);
    return stamp(shop, id, { status: o.prev === 'boxed' ? 'boxed' : 'waiting', prev: '', got: null }, t);
  }

  /* ================================================================== *
   * The board, the bake list, the pickup line
   * ================================================================== */

  /** One pickup day as the board draws it: every slot with its orders, and
   *  what is left of each item. */
  function board(shop, d, now) {
    var setup = shop.setup, per = setup.perSlot;
    var on = liveOrders(shop).filter(function (o) { return o.day === d; });
    var keys = {};
    var out = slots(setup, d).map(function (s) {
      keys[s.key] = true;
      var os = on.filter(function (o) { return o.slot === s.key; }).sort(byPlace);
      var n = os.length;
      return { key: s.key, s: s.s, e: s.e, n: n, per: per, left: Math.max(0, per - n), full: n >= per, over: Math.max(0, n - per), past: isPast(d, s, now), current: Boolean(now && now.d === d && s.s <= now.m && now.m < s.e), orders: os };
    });
    var outside = on.filter(function (o) { return !keys[o.slot]; }).sort(byPlace);
    var items = menu(shop).map(function (it) {
      var b = itemBooked(shop, it.id, d), left = it.cap === null ? null : it.cap - b;
      return { id: it.id, name: it.name, booked: b, cap: it.cap, left: left, soldOut: left !== null && left <= 0, over: left !== null && left < 0 ? -left : 0 };
    }).filter(function (x) { return x.booked > 0 || x.cap !== null; });
    return { day: d, slots: out, items: items, outside: outside, orders: on.length, full: out.filter(function (x) { return x.full; }).length };
  }

  /** An item's trays for a day: oven loads of `batch`, the last one part. */
  function trays(qty, batch) { var out = []; for (var left = qty; left > 0; left -= batch) out.push(Math.min(batch, left)); return out; }
  /**
   * The bake list for a day: for each item ordered, how many must be ready by
   * its first pickup, in trays to tick ("18 of 37 done"), first pickup first.
   */
  function bakeList(shop, d) {
    var on = liveOrders(shop).filter(function (o) { return o.day === d; });
    var rows = menu(shop).concat(Object.keys(shop.items).map(function (k) { return shop.items[k]; }).filter(function (x) { return x.del; })).map(function (it) {
      var qty = 0, first = null;
      on.forEach(function (o) { o.lines.forEach(function (l) { if (l.item === it.id) { qty += l.qty; var m = mins(o.slot); if (first === null || m < first) first = m; } }); });
      if (!qty) return null;
      var tr = trays(qty, it.batch), rec = (shop.bake || {})[d + '|' + it.id], n = Math.min(tr.length, rec ? rec.n : 0);
      var doneUnits = tr.slice(0, n).reduce(function (s, x) { return s + x; }, 0);
      return { item: it.id, name: it.name, unit: it.unit, qty: qty, batch: it.batch, trays: tr, n: n, done: doneUnits, first: first, allDone: n >= tr.length };
    }).filter(Boolean).sort(function (a, b) { return a.first - b.first || (itemOf(shop, a.item).pos - itemOf(shop, b.item).pos); });
    var qty = rows.reduce(function (s, r) { return s + r.qty; }, 0), done = rows.reduce(function (s, r) { return s + r.done; }, 0);
    var tr = rows.reduce(function (s, r) { return s + r.trays.length; }, 0), tn = rows.reduce(function (s, r) { return s + r.n; }, 0);
    return { day: d, rows: rows, qty: qty, done: done, trays: tr, ticked: tn };
  }
  /** Tap tray `k` of an item: ticks it (and every tray before it), or, if it
   *  was ticked, unticks it and every tray after it. */
  function tickTray(shop, d, item, k, t) {
    var key = d + '|' + item, cur = (shop.bake || {})[key], n = cur ? cur.n : 0;
    var next = clone(shop);
    next.bake = next.bake || {};
    next.bake[key] = { n: k < n ? k : k + 1, t: t };
    return { ok: true, shop: next };
  }
  /** Hour by hour: what each hour's pickups need, and how many by then. */
  function byHour(shop, d) {
    var day = dayOfSetup(shop.setup, d);
    if (!day) return [];
    var on = liveOrders(shop).filter(function (o) { return o.day === d; });
    var ids = bakeList(shop, d).rows.map(function (r) { return r.item; });
    var cum = {}, out = [];
    ids.forEach(function (id) { cum[id] = 0; });
    for (var h = Math.floor(mins(day.open) / 60); h * 60 < mins(day.close); h++) {
      var need = {}, orders = 0;
      on.forEach(function (o) {
        var m = mins(o.slot);
        if (m < h * 60 || m >= h * 60 + 60) return;
        orders++;
        o.lines.forEach(function (l) { need[l.item] = (need[l.item] || 0) + l.qty; });
      });
      var by = {};
      ids.forEach(function (id) { cum[id] += need[id] || 0; by[id] = cum[id]; });
      out.push({ h: h, label: clock(h * 60), orders: orders, need: ids.filter(function (id) { return need[id]; }).map(function (id) { return { item: id, qty: need[id], by: by[id] }; }) });
    }
    return out;
  }

  /** Search the orders by name or number ("dana", "14", "T-014"). */
  function search(shop, list2, q) {
    var raw = nf(q).trim();
    if (!raw) return list2;
    var m = /^(?:[a-z]\s*-?\s*)?0*(\d{1,4})$/i.exec(raw);
    if (m) { var n = +m[1]; return list2.filter(function (o) { return o.no === n; }); }
    var f = fold(raw);
    return list2.filter(function (o) { return fold(o.name).indexOf(f) >= 0; });
  }
  /**
   * The pickup line for a day at the page's `now`: Late first (its slot has
   * ended and it is not picked up), then Now (the current slot), then Coming
   * up by slot, and Picked up folded away. The summary on top: picked up N of
   * M, still to come, collected today, still due.
   */
  function pickupLine(shop, d, now, q) {
    var on = liveOrders(shop).filter(function (o) { return o.day === d; }).sort(byPlace);
    var picked = on.filter(function (o) { return o.status === 'picked'; });
    var summary = {
      total: on.length, picked: picked.length, toCome: on.length - picked.length,
      collected: picked.reduce(function (s, o) { return s + (o.got ? o.got.cents : 0); }, 0),
      due: on.reduce(function (s, o) { return s + (o.status === 'picked' ? 0 : balance(o)); }, 0),
      allDone: on.length > 0 && picked.length === on.length,
    };
    var shown = search(shop, on, q || '');
    var late = [], cur = [], coming = [], got = [];
    var slotLen = shop.setup.slotMin;
    shown.forEach(function (o) {
      if (o.status === 'picked') { got.push(o); return; }
      var s = mins(o.slot), e = s + slotLen;
      if (now && (d < now.d || (d === now.d && e <= now.m))) late.push(o);
      else if (now && d === now.d && s <= now.m && now.m < e) cur.push(o);
      else coming.push(o);
    });
    var groups2 = [];
    coming.forEach(function (o) { var g = groups2[groups2.length - 1]; if (!g || g.slot !== o.slot) groups2.push(g = { slot: o.slot, span: slotSpan(shop.setup, o.slot), orders: [] }); g.orders.push(o); });
    return { day: d, summary: summary, late: late, now: cur, coming: groups2, picked: got, matched: shown.length };
  }

  /* ================================================================== *
   * The money and the CSV
   * ================================================================== */

  function moneyOf(shop) {
    var ons = liveOrders(shop), off = allOrders(shop).filter(function (o) { return !live(o); });
    var sum = function (xs, f) { return xs.reduce(function (s, o) { return s + f(o); }, 0); };
    var items = menu(shop).concat(Object.keys(shop.items).map(function (k) { return shop.items[k]; }).filter(function (x) { return x.del; })).map(function (it) {
      var qty = 0, tot = 0;
      ons.forEach(function (o) { o.lines.forEach(function (l) { if (l.item === it.id) { qty += l.qty; tot += l.qty * l.price; } }); });
      return { item: it.id, name: it.name, qty: qty, text: qty ? qtyText(it, qty) : '', total: tot };
    }).filter(function (x) { return x.qty; });
    var byPay = { pickup: 0, deposit: 0, full: 0 };
    ons.forEach(function (o) { byPay[o.pay.kind]++; });
    return {
      orders: ons.length, ordered: sum(ons, total), paidWhenOrdered: sum(ons, function (o) { return o.pay.paid; }),
      collected: sum(ons, function (o) { return o.got ? o.got.cents : 0; }), due: sum(ons, balance),
      byPay: byPay, items: items,
      cancelled: { n: off.length, paid: sum(off, function (o) { return o.pay.paid + (o.got ? o.got.cents : 0); }), nos: off.sort(byPlace).map(function (o) { return orderNo(shop.setup, o.no); }) },
    };
  }
  /** A CSV cell: a leading = + - @ (or a tab or CR) gets a quote first, so a
   *  spreadsheet shows it rather than running it; commas, quotes and line
   *  breaks are quoted. */
  function csvCell(v) {
    var s = str(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csv(shop) {
    var setup = shop.setup;
    var rows = [['Order', 'Name', 'Day', 'Pickup', 'Items', 'Total', 'Paid when ordered', 'Paid how', 'Collected at pickup', 'Collected how', 'Balance due', 'Status', 'Note']];
    allOrders(shop).sort(byPlace).forEach(function (o) {
      rows.push([orderNo(setup, o.no), o.name, o.day, slotSpan(setup, o.slot), o.lines.map(function (l) { var it = itemOf(shop, l.item); return it ? qtyText(it, l.qty) : ''; }).join('; '),
        (total(o) / 100).toFixed(2), (o.pay.paid / 100).toFixed(2), o.pay.how ? HOW_WORD[o.pay.how] : '', ((o.got ? o.got.cents : 0) / 100).toFixed(2), o.got ? HOW_WORD[o.got.how] : '',
        (live(o) ? balance(o) / 100 : 0).toFixed(2), STATUS_WORD[o.status], o.note]);
    });
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  /* ================================================================== *
   * Box labels
   * ================================================================== */

  // Label stock by its size only. Letter: 2 x 4 in, two across and five
  // down, a half-inch top margin and a 3/16 in gap between the columns. A4:
  // 99.1 x 57 mm, two across and five down, 6 mm top and bottom.
  var SHEETS = {
    letter: { id: 'letter', name: 'Letter', w: 215.9, h: 279.4, css: 'letter', cols: 2, rows: 5, lw: 101.6, lh: 50.8, left: 3.96875, top: 12.7, gap: 4.7625, desc: '2 x 4 in, 10 to a Letter sheet' },
    a4: { id: 'a4', name: 'A4', w: 210, h: 297, css: 'A4', cols: 2, rows: 5, lw: 99.1, lh: 57, left: 4.65, top: 6, gap: 2.5, desc: '99 x 57 mm, 10 to an A4 sheet' },
  };
  /** Letter where it is the paper in the shops, A4 everywhere else. */
  function paperFor(locale) {
    var l = str(locale);
    return /^(en-(US|CA|PH)|es-(US|MX|CO|VE|CL|GT|PR|CR|PA|DO|SV|HN|NI|BO|EC|PE)|fr-CA|fil)\b/i.test(l) || /^en$/i.test(l) ? 'letter' : 'a4';
  }
  /** The ten label positions on a sheet, in millimetres, row by row. */
  function labelGrid(paper) {
    var P = SHEETS[paper] || SHEETS.letter, cells = [];
    for (var r = 0; r < P.rows; r++) for (var c = 0; c < P.cols; c++) cells.push({ i: r * P.cols + c, x: P.left + c * (P.lw + P.gap), y: P.top + r * P.lh, w: P.lw, h: P.lh });
    return { sheet: P, per: P.cols * P.rows, cells: cells };
  }
  /** What one order's label says. */
  function labelFor(shop, o) {
    var setup = shop.setup;
    return {
      id: o.id, no: orderNo(setup, o.no), name: o.name, day: dayLabel(o.day), slot: slotSpan(setup, o.slot),
      items: o.lines.map(function (l) { var it = itemOf(shop, l.item); return it ? qtyText(it, l.qty) : ''; }).filter(Boolean),
      note: o.note, allergy: Boolean(o.note) && isAllergy(o.note), due: dueWord(o),
    };
  }
  /** The labels for one order, a slot or a day, in pickup order. */
  function labelsFor(shop, scope) {
    var on = liveOrders(shop).filter(function (o) {
      if (scope.order) return o.id === scope.order;
      if (o.day !== scope.day) return false;
      return !scope.slot || o.slot === scope.slot;
    }).sort(byPlace);
    return on.map(function (o) { return labelFor(shop, o); });
  }
  /** Labels onto sheets, starting at position `start` (1-10) of a part-used
   *  first sheet: [[{cell, label|null}]] - a null is a label left blank. */
  function labelPages(labels, paper, start) {
    var g = labelGrid(paper), s = Math.max(1, Math.min(g.per, start | 0 || 1)) - 1, pages = [], at = s, page = null;
    if (!labels.length) return [];
    labels.forEach(function (lb) {
      if (!page || at >= g.per) { page = g.cells.map(function (c) { return { cell: c, label: null }; }); pages.push(page); if (pages.length > 1) at = 0; }
      page[at].label = lb; at++;
    });
    return pages;
  }

  /* ================================================================== *
   * The share texts
   * ================================================================== */

  /**
   * An order confirmation as plain text, for the customer:
   * "Thanks, Dana - 1 pumpkin pie and 1 dozen dinner rolls. Pickup Wed 25
   * Nov, 2:00-2:30 pm. Balance $32 due at pickup ($10 paid). Order T-014 -
   * Larkmoor Bakehouse."
   */
  function confirmText(shop, o) {
    var setup = shop.setup, first = str(o.name).trim().split(/\s+/)[0] || 'there';
    var items = list(o.lines.map(function (l) { var it = itemOf(shop, l.item); return it ? qtyText(it, l.qty) : ''; }).filter(Boolean));
    var due = balance(o), paid = o.pay.paid + (o.got ? o.got.cents : 0);
    var payLine = !due ? 'Paid in full - thank you.' : paid ? 'Balance ' + money(due) + ' due at pickup (' + money(paid) + ' paid).' : money(due) + ' due at pickup.';
    var shopName = setup.name ? ' - ' + setup.name : '';
    return 'Thanks, ' + first + ' - ' + items + '. Pickup ' + dayLabel(o.day) + ', ' + slotSpan(setup, o.slot) + '. ' + payLine + ' Order ' + orderNo(setup, o.no) + shopName + '.';
  }
  /** "What we're taking orders for": the items and prices, the pickup days
   *  and hours, the cutoff, the deposit, and what is sold out. */
  function menuText(shop) {
    var setup = shop.setup, items = menu(shop).filter(function (x) { return !x.off; });
    var out = [(setup.name ? setup.name + ' - ' : '') + setup.event, '', 'Taking orders for:'];
    items.forEach(function (it) { out.push('- ' + it.name + ', ' + priceWord(it)); });
    out.push('', 'Pickup: ' + setup.days.map(function (d) { return dayLabel(d.d) + ', ' + span(mins(d.open), mins(d.close)); }).join('; ') + '.');
    if (setup.cutoff) out.push('Order by ' + dayLabel(setup.cutoff.d) + ', ' + clock(mins(setup.cutoff.t)) + '.');
    out.push(depositWord(setup));
    var gone = [];
    items.forEach(function (it) {
      var days = setup.days.filter(function (d) { var left = itemLeft(shop, it.id, d.d); return left !== null && left <= 0; });
      if (days.length === setup.days.length) gone.push(it.name + ' (every day)');
      else if (days.length) gone.push(it.name + ' for ' + list(days.map(function (d) { return dayLabel(d.d); })));
    });
    var fullDays = setup.days.filter(function (d) { var b = board(shop, d.d); return b.slots.length && b.slots.every(function (s) { return s.full; }); });
    if (gone.length) out.push('Sold out: ' + gone.join('; ') + '.');
    if (fullDays.length) out.push('Every pickup time is taken on ' + list(fullDays.map(function (d) { return dayLabel(d.d); })) + '.');
    return out.join('\n');
  }

  /* ================================================================== *
   * Two phones: the merge
   * ================================================================== */

  /** JSON with every object's keys sorted: two copies that hold the same
   *  things compare equal whatever order their keys were written in. */
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  /** The later of two stamped values; a tie goes the same way from either side. */
  function later(x, tx, y, ty) {
    if (tx !== ty) return tx > ty ? x : y;
    return canon(x) >= canon(y) ? x : y;
  }
  var DETAIL = ['no', 'name', 'day', 'slot', 'lines', 'note', 'pay', 'u'];
  var STATUS_HALF = ['status', 'got', 'prev', 'su'];
  function pick(o, fs) { var out = {}; fs.forEach(function (f) { out[f] = clone(o[f]); }); return out; }
  /**
   * Merge this phone's copy `a` with the account's `b` - two phones at one
   * counter. Each order carries two times: `u` for its details and `su` for
   * its status, and each half comes from the copy that changed it last, so
   * an edit on one phone and a pickup tick on the other both survive. Menu
   * items by their own time - an item a live order still uses is kept even if
   * the other phone removed it. Bake counts by their own time. The newer
   * setup, keeping any day a live order is on. Two phones can give the same
   * order number offline: the order taken first keeps it, the later one gets
   * the next free number, and the merge says so. A slot or item booked past
   * its cap is never dropped - `overs()` flags it. Symmetric (either side as
   * `a`) and idempotent (merging the result again changes nothing).
   * `since` is this phone's last sync: an order both phones changed since
   * then is noted.
   */
  function merge(a, b, since) {
    since = typeof since === 'number' ? since : 0;
    var notes = [], both = 0;
    var sa = { v: a.setup, t: a.setupT || 0 }, sb = { v: b.setup, t: b.setupT || 0 };
    var sw = canon(sa.v) === canon(sb.v) ? (sa.t >= sb.t ? sa : sb) : later(sa, sa.t, sb, sb.t);
    var out = { v: 1, setup: clone(sw.v), setupT: sw.t, items: {}, orders: {}, bake: {} };
    // Orders: each half from whichever copy changed it last.
    var A = a.orders || {}, B = b.orders || {};
    Object.keys(A).concat(Object.keys(B)).sort().forEach(function (k) {
      if (own(out.orders, k)) return;
      var x = A[k], y = B[k];
      if (!x || !y) { out.orders[k] = clone(x || y); return; }
      var d = later(pick(x, DETAIL), x.u, pick(y, DETAIL), y.u), s = later(pick(x, STATUS_HALF), x.su, pick(y, STATUS_HALF), y.su);
      out.orders[k] = Object.assign({ id: k, at: Math.min(x.at, y.at) }, clone(d), clone(s));
      if (canon(x) !== canon(y) && (x.u > since || x.su > since) && (y.u > since || y.su > since)) both++;
    });
    // Items by their own time; one a live order uses is never removed.
    var IA = a.items || {}, IB = b.items || {};
    Object.keys(IA).concat(Object.keys(IB)).sort().forEach(function (k) {
      if (own(out.items, k)) return;
      var x = IA[k], y = IB[k];
      out.items[k] = clone(!x || !y ? (x || y) : later(x, x.t, y, y.t));
    });
    var usedItem = {};
    Object.keys(out.orders).forEach(function (k) { out.orders[k].lines.forEach(function (l) { usedItem[l.item] = true; }); });
    Object.keys(out.items).forEach(function (k) {
      var it = out.items[k];
      if (it.del && usedItem[k] && liveOrdersIn(out).some(function (o) { return o.lines.some(function (l) { return l.item === k; }); })) {
        it.del = false;
        notes.push(it.name + ' was removed on one phone but an order still has it - kept.');
      }
    });
    // Bake counts by their own time.
    var BA = a.bake || {}, BB = b.bake || {};
    Object.keys(BA).concat(Object.keys(BB)).sort().forEach(function (k) {
      if (own(out.bake, k)) return;
      var x = BA[k], y = BB[k];
      out.bake[k] = clone(!x || !y ? (x || y) : later(x, x.t, y, y.t));
    });
    // The newer setup, keeping any day a live order is on (with its hours
    // from whichever copy had it).
    var other = sw === sa ? sb.v : sa.v;
    liveOrdersIn(out).forEach(function (o) {
      if (dayOfSetup(out.setup, o.day)) return;
      var d = dayOfSetup(other, o.day) || { d: o.day, open: hm(Math.max(0, mins(o.slot))), close: hm(Math.min(1435, mins(o.slot) + out.setup.slotMin)) };
      out.setup.days.push(clone(d));
      out.setup.days.sort(function (x, y) { return x.d < y.d ? -1 : 1; });
      notes.push(dayLabel(o.day) + ' was removed on one phone but orders are still on it - kept.');
    });
    // Order numbers: the order taken first keeps a shared number.
    var renumbered = [], byNo = {};
    Object.keys(out.orders).map(function (k) { return out.orders[k]; }).sort(function (x, y) { return x.at - y.at || (x.id < y.id ? -1 : 1); }).forEach(function (o) {
      if (!byNo[o.no]) { byNo[o.no] = o; return; }
      var keeper = byNo[o.no], was = o.no;
      o.no = Object.keys(out.orders).reduce(function (m, k) { return Math.max(m, out.orders[k].no); }, 0) + 1;
      o.u = Math.max(o.u, keeper.u) + 1;
      byNo[o.no] = o;
      renumbered.push({ id: o.id, from: was, to: o.no, keeper: keeper.id });
      notes.push('Both phones gave ' + orderNo(out.setup, was) + ' to an order: ' + keeper.name + ' keeps it (taken first), and ' + o.name + '’s is now ' + orderNo(out.setup, o.no) + '.');
    });
    var u = Math.max(a.updatedAt || 0, b.updatedAt || 0);
    if (u) out.updatedAt = u;
    if (both) notes.push(plural(both, 'order was', 'orders were') + ' changed on both phones - each part kept from the later change.');
    return { shop: out, notes: notes, renumbered: renumbered, flags: overs(out) };
  }
  function liveOrdersIn(shop) { return Object.keys(shop.orders).map(function (k) { return shop.orders[k]; }).filter(live); }
  /** Two copies hold the same shop (updatedAt aside). */
  function same(a, b) { var x = clone(a), y = clone(b); delete x.updatedAt; delete y.updatedAt; return canon(x) === canon(y); }

  /**
   * What is booked past its cap - two phones can each take the last place
   * offline, and a setup change can shrink a slot - never dropped, flagged:
   * a slot over its places, an item over its day's cap, an order outside the
   * day's hours. Each with the orders that could move.
   */
  function overs(shop) {
    var out = [], setup = shop.setup;
    (setup.days || []).forEach(function (day) {
      var b = board(shop, day.d), w = dayLabel(day.d).slice(0, 3);
      b.slots.forEach(function (s) {
        if (s.over > 0) out.push({ kind: 'slot', day: day.d, slot: s.key, over: s.over, orders: s.orders.slice().sort(function (x, y) { return y.at - x.at; }).map(function (o) { return o.id; }), msg: 'Two phones booked the last ' + clockParts(s.s).t + ' place on ' + w + ' - ' + s.over + ' over. Move one?' });
      });
      b.items.forEach(function (it) {
        if (it.over > 0) {
          var os = liveOrders(shop).filter(function (o) { return o.day === day.d && o.lines.some(function (l) { return l.item === it.id; }); }).sort(function (x, y) { return y.at - x.at; });
          out.push({ kind: 'item', day: day.d, item: it.id, over: it.over, orders: os.map(function (o) { return o.id; }), msg: it.name + ' on ' + w + ' is booked ' + it.over + ' over its ' + it.cap + '. Move one?' });
        }
      });
      b.outside.forEach(function (o) { out.push({ kind: 'hours', day: day.d, slot: o.slot, over: 1, orders: [o.id], msg: orderNo(setup, o.no) + ' is booked at ' + clock(mins(o.slot)) + ' on ' + w + ', outside the day’s pickup times. Move it?' }); });
    });
    return out;
  }
  /** Where a flagged order could go: the nearest slot with room that day
   *  whose items fit, else another day. */
  function moveSuggestion(shop, id, now) {
    var o = shop.orders[id];
    if (!o) return null;
    var k = nearestSlot(shop, o.day, o.slot, { now: now, except: id, notSame: true });
    if (k && linesFit(shop, o.lines, o.day, id)) return { day: o.day, slot: k };
    return otherDay(shop, o, { now: now });
  }

  /* ================================================================== *
   * The AI: "Read the order slip"
   * ================================================================== */

  var AI_PAID = ['none', 'deposit', 'full', 'unknown'];
  var AI_UNSURE = ['name', 'items', 'day', 'time', 'note', 'paid'];
  /** What the page sends besides the photo: the menu's ids and names, and
   *  nothing else about the shop, its customers or its orders. */
  function slipMenu(shop) { return menu(shop).filter(function (x) { return !x.off; }).slice(0, LIMITS.aiMenu).map(function (x) { return { id: x.id, name: x.name }; }); }
  /**
   * The request, rebuilt: exactly {image: {type, data}, menu: [{id, name}]}
   * - at most 40 items, each name through the text door - or a refusal that
   * costs nothing.
   */
  function slipRequest(body) {
    var bad = function (msg, code) { return { error: msg, code: code || 'bad-request' }; };
    if (!isObj(body)) return bad('Send the photo and the menu.');
    var extra = Object.keys(body).filter(function (k) { return k !== 'image' && k !== 'menu'; });
    if (extra.length) return bad('Only the photo and the menu’s item names are sent - not ' + extra.slice(0, 3).join(', ') + '.', 'extra-field');
    var im = body.image;
    if (!isObj(im) || Object.keys(im).sort().join() !== 'data,type') return bad('Send one photo as {type, data}.', 'image');
    if (['image/jpeg', 'image/png', 'image/webp'].indexOf(im.type) < 0) return bad('The photo must be a JPEG, PNG or WebP.', 'image');
    if (typeof im.data !== 'string' || im.data.length < 16 || im.data.length > Math.ceil(LIMITS.aiImageBytes * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+=*$/.test(im.data)) return bad('That photo is too large or not a photo. The page shrinks it first - try again from the page.', 'image');
    if (!Array.isArray(body.menu) || !body.menu.length || body.menu.length > LIMITS.aiMenu) return bad('Send your menu’s items - 1 to ' + LIMITS.aiMenu + '.', 'menu');
    var seen = {}, menu2 = [];
    for (var i = 0; i < body.menu.length; i++) {
      var m = body.menu[i];
      if (!isObj(m) || Object.keys(m).sort().join() !== 'id,name') return bad('Each menu item is {id, name} and nothing else.', 'menu');
      if (!ID.item.test(str(m.id)) || seen[m.id] || m.id === 'other') return bad('A menu item’s id is not an id.', 'menu');
      if (typeof m.name !== 'string' || !m.name.trim() || refuse(m.name, LIMITS.item)) return bad('A menu item’s name: ' + (refuse(m.name, LIMITS.item) || 'it is empty.'), 'menu');
      seen[m.id] = true;
      menu2.push({ id: m.id, name: line(m.name, LIMITS.item) });
    }
    return { req: { image: { type: im.type, data: im.data }, menu: menu2 } };
  }
  /** A field a model wrote, kept only if it carries nothing it should not:
   *  markup and bidi out; a phone number, an email, a card number, a street
   *  address, a link or a formula drops it. */
  function aiField(v, max) {
    if (typeof v !== 'string') return '';
    if (hasMarkup(v) && /<[a-z!/]/i.test(v)) return '';
    var s = line(v, max);
    if (!s || hasAt(s) || hasLink(s) || hasPhone(s) || hasCard(s) || nineDigits(s) || hasAddress(s) || isFormula(s)) return '';
    return s;
  }
  /**
   * The model's answer, checked: up to 8 orders; every text through the
   * doors (a field carrying a phone number, an email, a card number, a
   * street address, a link, a formula or markup is dropped); an item id
   * never sent becomes "other"; an unknown weekday, payment or day of the
   * month is dropped; a quantity outside 1-99 drops its line; an order with
   * no name and no items is dropped. {orders, dropped} or {error}.
   */
  function cleanAiSlip(raw, req) {
    var ids = {};
    req.menu.forEach(function (m) { ids[m.id] = true; });
    var list2 = isObj(raw) && Array.isArray(raw.orders) ? raw.orders : [];
    var out = [], dropped = 0;
    list2.forEach(function (x) {
      if (out.length >= LIMITS.aiOrders || !isObj(x)) { dropped++; return; }
      var lines = (Array.isArray(x.items) ? x.items : []).slice(0, LIMITS.aiLines).map(function (l) {
        if (!isObj(l) || !isInt(l.qty, 1, LIMITS.qty)) return null;
        var item = typeof l.item === 'string' && own(ids, l.item) ? l.item : 'other';
        var words = item === 'other' ? aiField(l.words, LIMITS.aiWords) : '';
        if (item === 'other' && !words) return null;
        return { item: item, qty: l.qty, words: words };
      }).filter(Boolean);
      var name = aiField(x.name, LIMITS.aiName);
      if (!name && !lines.length) { dropped++; return; }
      var wd = typeof x.weekday === 'string' && WEEKDAYS.indexOf(x.weekday.toLowerCase()) >= 0 ? x.weekday.toLowerCase() : null;
      var dom = isInt(x.dayOfMonth, 1, 31) ? x.dayOfMonth : null;
      out.push({
        name: name, items: lines, weekday: wd, dayOfMonth: dom,
        time: aiField(x.time, LIMITS.aiTime), note: aiField(x.note, LIMITS.aiNote),
        paid: AI_PAID.indexOf(x.paid) >= 0 ? x.paid : 'unknown',
        unsure: (Array.isArray(x.unsure) ? x.unsure : []).filter(function (f, i, a) { return AI_UNSURE.indexOf(f) >= 0 && a.indexOf(f) === i; }),
      });
    });
    if (!out.length) return { error: 'Nothing could be read from that photo. Try one from straight above, in good light - or type the orders in.', code: 'empty' };
    return { orders: out, dropped: dropped };
  }
  /** A time as written - "10:30", "5pm", "5:15 pm", "noon", "half 2" -
   *  as minutes on day `day` (a bare hour is read inside its open hours), or
   *  null. */
  function writtenTime(s, day) {
    var t = nf(s).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (/\b(noon|midday)\b/.test(t)) return 720;
    var half = /\bhalf (?:past )?(\d{1,2})\b/.exec(t);
    var m = half ? [null, half[1], '30', ''] : /(\d{1,2})(?:[:.h](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/.exec(t);
    if (!m) return null;
    var h = +m[1], mm = m[2] ? +m[2] : 0, ap = m[3] ? m[3].charAt(0) : '';
    if (h > 23 || mm > 59) return null;
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    var v = h * 60 + mm;
    if (!ap && h >= 1 && h <= 12 && day) {
      var a = mins(day.open), b = mins(day.close), alt = (h % 12 + 12) * 60 + mm;
      var inside = function (x) { return x >= a && x < b; };
      if (!inside(v) && inside(alt)) v = alt;
    }
    return v;
  }
  /**
   * The readings, on the phone, as drafts for the order form: the weekday or
   * the day of the month to one of the event's days, the time to the nearest
   * open slot (marked to check when it is not the one written), "paid?" to
   * pay at pickup marked to check, and anything not on the menu kept as
   * words in the note. The model never saw a date.
   */
  function slipDrafts(shop, readings, o) {
    o = o || {};
    var setup = shop.setup;
    return readings.map(function (r) {
      var unsure = r.unsure.slice(), days = setup.days, day = null;
      var byWd = r.weekday ? days.filter(function (d) { return WEEKDAYS[weekday(dayOf(d.d))] === r.weekday; }) : [];
      var byDom = r.dayOfMonth ? days.filter(function (d) { return civil(dayOf(d.d)).d === r.dayOfMonth; }) : [];
      if (byDom.length && byWd.length && byDom[0].d !== byWd[0].d) { day = byDom[0]; unsure.push('day'); }
      else if (byDom.length) day = byDom[0];
      else if (byWd.length === 1) day = byWd[0];
      else { day = days[0]; if (days.length > 1 || r.weekday || r.dayOfMonth) unsure.push('day'); }
      var lines = r.items.filter(function (l) { return l.item !== 'other' && itemOf(shop, l.item) && !itemOf(shop, l.item).del; }).map(function (l) { return { item: l.item, qty: l.qty }; });
      var merged = {};
      lines = lines.filter(function (l) { if (merged[l.item]) { merged[l.item].qty = Math.min(LIMITS.qty, merged[l.item].qty + l.qty); return false; } merged[l.item] = l; return true; });
      var other = r.items.filter(function (l) { return l.item === 'other'; }).map(function (l) { return l.qty + ' ' + l.words; });
      var want = writtenTime(r.time, day), slot = '';
      var ss = slots(setup, day.d);
      var hit = want === null ? null : ss.filter(function (x) { return x.s <= want && want < x.e; })[0];
      if (hit && !isPast(day.d, hit, o.now) && booked(shop, day.d, hit.key) < setup.perSlot) slot = hit.key;
      else {
        slot = nearestSlot(shop, day.d, want === null ? (ss[0] ? ss[0].key : '') : hm(Math.floor(want / 5) * 5), { now: o.now }) || (ss[0] ? ss[0].key : '');
        unsure.push('time');
      }
      var note = r.note;
      if (other.length) note = (note ? note + ' - ' : '') + 'Also asked for ' + list(other) + ' (not on the menu)';
      var kind = r.paid === 'full' ? 'full' : r.paid === 'deposit' ? 'deposit' : 'pickup';
      var t = lines.reduce(function (s, l) { var it = itemOf(shop, l.item); return s + l.qty * (it ? it.price : 0); }, 0);
      if (r.paid === 'unknown' || (kind === 'deposit' && !depositFor(setup, t))) unsure.push('paid');
      return {
        name: r.name, lines: lines, day: day.d, slot: slot, note: line(note, LIMITS.note),
        pay: { kind: kind, paid: kind === 'deposit' ? depositFor(setup, t) : kind === 'full' ? t : 0, how: kind === 'pickup' ? '' : 'cash' },
        unsure: unsure.filter(function (f, i, a) { return a.indexOf(f) === i; }), written: { time: r.time, weekday: r.weekday, dayOfMonth: r.dayOfMonth }, other: other,
      };
    });
  }

  return {
    LIMITS: LIMITS, SLOT_MINS: SLOT_MINS, EVENTS: EVENTS, DEPOSITS: DEPOSITS, PAY_KINDS: PAY_KINDS, PAY_WORD: PAY_WORD, HOWS: HOWS, HOW_WORD: HOW_WORD,
    STATUSES: STATUSES, STATUS_WORD: STATUS_WORD, STARTERS: STARTERS, SHEETS: SHEETS, ID: ID, WD: WD, WD_LONG: WD_LONG, WEEKDAYS: WEEKDAYS, MON: MON,
    AI_PAID: AI_PAID, AI_UNSURE: AI_UNSURE, WHY: WHY,
    str: str, esc: esc, line: line, clip: clip, plural: plural, groups: groups, cap1: cap1, lowerFirst: lowerFirst, list: list, fold: fold, clone: clone, canon: canon, pad3: pad3,
    hasAt: hasAt, hasLink: hasLink, hasPhone: hasPhone, nineDigits: nineDigits, hasCard: hasCard, hasAddress: hasAddress, isFormula: isFormula, hasInvisible: hasInvisible, hasMarkup: hasMarkup,
    refuse: refuse, isAllergy: isAllergy,
    dayOf: dayOf, isIso: isIso, iso: iso, civil: civil, weekday: weekday, addDays: addDays, daysFromCivil: daysFromCivil, dayLabel: dayLabel, longDay: longDay, wdLong: wdLong,
    mins: mins, hm: hm, clock: clock, clockParts: clockParts, span: span, thanksgiving: thanksgiving,
    defaultSetup: defaultSetup, letterOf: letterOf, orderNo: orderNo, dayOfSetup: dayOfSetup, dayWord: dayWord, slots: slots, slotOf: slotOf, slotSpan: slotSpan, depositFor: depositFor, depositWord: depositWord,
    pluralWord: pluralWord, qtyText: qtyText, priceWord: priceWord, capWord: capWord, starterItems: starterItems, menu: menu, itemOf: itemOf,
    cleanShop: cleanShop, cleanSetup: cleanSetup, bodyProblem: bodyProblem, newShop: newShop,
    money: money, parseMoney: parseMoney, allOrders: allOrders, liveOrders: liveOrders, byPlace: byPlace, total: total, balance: balance, dueWord: dueWord, nextNo: nextNo,
    booked: booked, itemBooked: itemBooked, itemLeft: itemLeft, capLine: capLine, isPast: isPast, nearestSlot: nearestSlot, linesFit: linesFit,
    checkOrder: checkOrder, shapeOrder: shapeOrder, saveOrder: saveOrder, moveOrder: moveOrder, cancelOrder: cancelOrder, restoreOrder: restoreOrder, setBoxed: setBoxed, pickUp: pickUp, undoPickup: undoPickup,
    board: board, trays: trays, bakeList: bakeList, tickTray: tickTray, byHour: byHour, search: search, pickupLine: pickupLine,
    moneyOf: moneyOf, csvCell: csvCell, csv: csv,
    paperFor: paperFor, labelGrid: labelGrid, labelFor: labelFor, labelsFor: labelsFor, labelPages: labelPages,
    confirmText: confirmText, menuText: menuText,
    merge: merge, same: same, overs: overs, moveSuggestion: moveSuggestion,
    slipMenu: slipMenu, slipRequest: slipRequest, cleanAiSlip: cleanAiSlip, writtenTime: writtenTime, slipDrafts: slipDrafts, aiField: aiField,
  };
}));
