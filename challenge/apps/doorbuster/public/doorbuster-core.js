/* Doorbuster - the rules, in one file, run three times: in the page
 * (window.DoorbusterCore), on the server and in the tests (require).
 *
 * A sale is a few days, a handful of items and a handful of deals. For each
 * deal the arithmetic here says what the customer pays and saves, what the
 * shop makes on one before and after, and THE BREAK-EVEN: how many the shop
 * must sell at the deal price before the deal makes a cent more than its
 * usual days would have. Then safer shapes of the same deal, the words for
 * the sign, the live tally at the counter and the verdict afterwards.
 *
 * ALL MONEY IS WHOLE CENTS. Nothing here divides money into a fraction and
 * keeps it: a break-even is rounded UP to a whole sale, a percentage shown
 * to a shopper is rounded DOWN (the sign never promises more than the deal
 * gives), a "you need $X of other shopping" is rounded up.
 *
 * Every "usual" figure is the owner's own (how many they usually sell, their
 * usual margin, their usual baskets). The results are estimates built on
 * those, and the page says so. Nothing is invented: an alternative deal is
 * made only from the owner's own items.
 *
 * NO CLOCK AND NO DICE: "today", "now" and every new id are handed in
 * (tested), so the same input gives the same answer on every phone and on
 * the server.
 *
 * NOT ADVICE: the notes about a "was" price and combining offers are
 * conventional plain wording - only show a "was" price you really charged -
 * not legal advice, and no law is cited.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DoorbusterCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    members: 20,        // people on one sale (the owner and the staff)
    items: 40,          // items in one sale
    deals: 20,          // deals in one sale
    name: 20,           // a first name
    shop: 40,           // the shop's name
    title: 40,          // the sale's name
    item: 40,           // an item's name
    price: 9999999,     // cents: 99,999.99
    units: 100000,      // a count of anything
    saleDays: 14,       // a sale runs at most this many days
    backDays: 14,       // a sale may have started this long ago
    aheadDays: 400,     // or start this far ahead
    keepDays: 30,       // a sale is deleted this long after its last day
    perCustomer: 20,    // "limit N per customer"
    drafts: 20,         // draft items from one price list
    batch: 20,          // items added in one go
    pasteChars: 8000,   // a pasted price list
  };
  var CURRENCIES = ['$', '£', '€'];
  var KINDS = ['pct', 'amount', 'multi', 'bundle', 'spend'];
  var KIND_NAMES = { pct: 'Percent off', amount: 'Amount off', multi: 'Multi-buy', bundle: 'Bundle', spend: 'Spend and save' };
  var GOALS = ['more', 'clear', 'traffic'];
  var GOAL_NAMES = { more: 'Make more', clear: 'Clear stock', traffic: 'Bring people in' };
  var ENDS = ['99', '00', '50'];
  var GOOD_X10 = 15;   // up to 1.5x the usual sales: a deal that should pay
  var TIGHT_X10 = 25;  // up to 2.5x: tight; beyond: unlikely
  var SMALL_PCT = 10;  // under this a discount gets a soft "may be too small to notice"
  var ESTIMATE = 'An estimate from your own usual numbers - not a forecast.';
  var WAS_RULE = 'Only show a “was” price you really charged.';

  function fail(status, message, extra) {
    var e = new Error(message);
    e.status = status; e.expose = true;
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    return e;
  }
  function own(o, k) { return Boolean(o) && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ------------------------------------------------------------------ *
   * Text
   * ------------------------------------------------------------------ */

  // Control characters, zero-width and bidirectional marks.
  var INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  function line(v, max) {
    var s = str(v).slice(0, (max || 200) * 8).replace(/<[^>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    var cps = Array.from(s);
    return cps.length > max ? cps.slice(0, max).join('').trim() : s;
  }
  function esc(v) { return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function norm(v) { return line(v, 80).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function cleanName(v) {
    var s = line(v, LIMITS.name * 2).replace(/[^\p{L}\p{M}' ’.-]/gu, ' ').replace(/\s+/g, ' ').replace(/^[ '.’-]+|[ '.’-]+$/g, '').trim();
    s = Array.from(s).slice(0, LIMITS.name).join('').trim();
    return /\p{L}/u.test(s) ? s : '';
  }
  /** Why a piece of free text is not kept - or ''. Doorbuster collects no
   *  email address, no phone number and no customer's details from anyone,
   *  and this is where that is held: every text field passes here. */
  function refuse(v) {
    var s = str(v);
    if (/[@＠﹫]/.test(s)) return 'No email addresses, please - Doorbuster keeps shop names, first names and items only.';
    if (/[a-z][a-z0-9+.-]*:\/\/|\bwww\./i.test(s)) return 'No links, please.';
    if (/\p{Nd}(?:[\s.\-()]*\p{Nd}){6}/u.test(s)) return 'No phone numbers or long numbers, please - Doorbuster keeps shop names, first names and items only.';
    if (/[<>]/.test(s)) return 'No markup, please.';
    return '';
  }
  /** A text field: refused with a reason, or cleaned to `max`. */
  function field(v, max, label) {
    var why = refuse(v);
    if (why) throw fail(400, (label ? label + ': ' : '') + why);
    return line(v, max);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function listNames(names) {
    if (names.length <= 1) return names.join('');
    if (names.length === 2) return names[0] + ' and ' + names[1];
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  function initials(name) { var w = String(name || '?').split(/[\s+&-]+/).filter(Boolean); return (w.length > 1 ? Array.from(w[0])[0] + Array.from(w[w.length - 1])[0] : Array.from(w[0] || '?').slice(0, 2).join('')).toUpperCase(); }

  /* ------------------------------------------------------------------ *
   * Ids and codes
   * ------------------------------------------------------------------ */

  var ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
  function newId(rand, n, prefix) { var s = prefix || ''; for (var i = 0; i < (n || 8); i++) s += ID_CHARS[rand(ID_CHARS.length)]; return s; }
  function isId(v) { return typeof v === 'string' && /^[a-z][a-z0-9]{5,24}$/.test(v); }
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var CODE_LEN = 6;
  function normalizeCode(v) { return str(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
  function isCode(v) { return typeof v === 'string' && v.length === CODE_LEN && v.split('').every(function (c) { return CODE_ALPHABET.indexOf(c) >= 0; }); }
  function formatCode(v) { var c = normalizeCode(v); return c.slice(0, 3) + '-' + c.slice(3); }
  function isGid(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{16}$/.test(v); }

  // Ten colours for people, each holding white text at 4.5:1 or better
  // (tested); past ten they repeat, and initials tell people apart.
  var COLORS = ['#0b6bcb', '#a3122f', '#1b6e2a', '#7a2e8f', '#805400', '#0f6470', '#b5420e', '#4a4f9e', '#9c2d6b', '#3f5563'];

  /* ------------------------------------------------------------------ *
   * Days: calendar dates as YYYY-MM-DD. A sale is whole days; which day it
   * is "today" is handed in (the phone's own date on the page, the server's
   * UTC date for expiry).
   * ------------------------------------------------------------------ */

  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function isDay(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var d = new Date(v + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === v && v >= '2000-01-01' && v <= '2100-12-31';
  }
  function dayMs(day) { return Date.parse(day + 'T00:00:00Z'); }
  function addDays(day, n) { return new Date(dayMs(day) + n * 86400000).toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / 86400000); }
  function weekday(day) { return WEEKDAYS[new Date(dayMs(day)).getUTCDay()]; }
  /** "Friday, Nov 27" */
  function dayLong(day) { return weekday(day) + ', ' + MONTHS[Number(day.slice(5, 7)) - 1] + ' ' + Number(day.slice(8)); }
  /** "Nov 27 - 30" or "Nov 29 - Dec 2" */
  function dateRange(from, to) {
    var a = MONTHS[Number(from.slice(5, 7)) - 1] + ' ' + Number(from.slice(8));
    if (from === to) return a;
    return a + ' - ' + (from.slice(0, 7) === to.slice(0, 7) ? '' : MONTHS[Number(to.slice(5, 7)) - 1] + ' ') + Number(to.slice(8));
  }
  function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

  /* ------------------------------------------------------------------ *
   * Money: whole cents in, words out
   * ------------------------------------------------------------------ */

  function intIn(v, lo, hi, dflt) {
    var n = typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : v;
    return typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
  }
  function isCents(v, lo, hi) { return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi; }
  /** What was typed in a money box, as cents - or null. "12", "12.5",
   *  "$1,250.00". Never a float: the digits are read as digits. */
  function parseMoney(v) {
    var t = str(v).replace(/[\s$£€]/g, '');
    if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) t = t.replace(/,/g, '');
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) return null;
    var p = t.split('.');
    return Number(p[0]) * 100 + (p[1] ? Number((p[1] + '0').slice(0, 2)) : 0);
  }
  function group(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /** 2800 -> "$28.00"; -120 -> "-$1.20" */
  function money(c, cur) { var a = Math.abs(c); return (c < 0 ? '-' : '') + (cur || '$') + group(Math.floor(a / 100)) + '.' + pad(a % 100); }
  /** For a sign's headline: "$5" when it is whole, "$4.50" when not. */
  function moneyShort(c, cur) { var s = money(c, cur); return s.slice(-3) === '.00' ? s.slice(0, -3) : s; }
  /** "about $412": to the whole unit. */
  function about(c, cur) { return (cur || '$') + group(Math.round(Math.abs(c) / 100)); }
  /** For a form's box: "28.00" */
  function moneyField(c) { return Math.floor(c / 100) + '.' + pad(c % 100); }
  /** A price with `pct` percent off, to the cent (half a cent rounds up). */
  function pctOff(price, pct) { return Math.floor((price * (100 - pct) + 50) / 100); }
  /** The price nearest `c` that ends in `.end` (a tie goes to the lower). */
  function toEnding(c, end) {
    var e = Number(end), lo = Math.floor(c / 100) * 100 + e;
    if (lo > c) lo -= 100;
    var hi = lo + 100;
    if (lo < 1) return hi;
    return (c - lo) <= (hi - c) ? lo : hi;
  }
  /** 23 -> "2.3x" */
  function times(x10) { return Math.floor(x10 / 10) + '.' + (x10 % 10) + 'x'; }
  function ceilDiv(a, b) { return Math.floor((a + b - 1) / b); }

  /* ------------------------------------------------------------------ *
   * A sale's own details, an item, a deal - what was typed, checked
   * ------------------------------------------------------------------ */

  /** {shop, title, from, to, cur, margin}, checked against the day. */
  function cleanSale(b, today) {
    b = isObj(b) ? b : {};
    var shop = field(b.shop, LIMITS.shop, 'Shop');
    if (!/[\p{L}\p{N}]/u.test(shop)) throw fail(400, 'Type the shop’s name - it goes on the signs.');
    var title = field(b.title, LIMITS.title, 'Sale') || 'Sale';
    if (!isDay(b.from) || !isDay(b.to)) throw fail(400, 'Pick the first and the last day of the sale.');
    if (b.to < b.from) throw fail(400, 'The last day is before the first.');
    if (daysBetween(b.from, b.to) >= LIMITS.saleDays) throw fail(400, 'A sale here runs up to ' + LIMITS.saleDays + ' days - this is about one short promotion.');
    if (b.from < addDays(today, -LIMITS.backDays) || b.from > addDays(today, LIMITS.aheadDays)) throw fail(400, 'Pick a sale that starts within about a year - or started in the last two weeks.');
    var margin = b.margin === undefined || b.margin === null || b.margin === '' ? 50 : intIn(b.margin, 0, 95, null);
    if (margin === null) throw fail(400, 'Your usual margin is a whole percent from 0 to 95.');
    return { shop: shop, title: title, from: b.from, to: b.to, cur: CURRENCIES.indexOf(b.cur) >= 0 ? b.cur : '$', margin: margin };
  }

  /** {name, price, cost, base, stock}: cents and whole numbers. `base` is
   *  how many the shop would usually sell over the sale's days with no
   *  deal; `stock` what is on hand when it starts, or null. */
  function cleanItem(b) {
    b = isObj(b) ? b : {};
    var name = field(b.name, LIMITS.item, 'Item');
    if (!/[\p{L}\p{N}]/u.test(name)) throw fail(400, 'Give the item a name.');
    if (!isCents(b.price, 1, LIMITS.price)) throw fail(400, 'The usual price is from 0.01 to 99,999.99.');
    if (!isCents(b.cost, 0, LIMITS.price)) throw fail(400, 'What it costs you is from 0 to 99,999.99.');
    if (!isCents(b.base, 0, LIMITS.units)) throw fail(400, 'How many you’d usually sell is a whole number, 0 or more.');
    var stock = b.stock === null || b.stock === undefined || b.stock === '' ? null : b.stock;
    if (stock !== null && !isCents(stock, 0, LIMITS.units)) throw fail(400, 'Stock on hand is a whole number - or leave it empty.');
    return { name: name, price: b.price, cost: b.cost, base: b.base, stock: stock };
  }

  /** What was typed, made into a deal - or refused with a reason. `doc` has
   *  the items (a map) and the currency; `prev` is the deal being edited
   *  (its goal is kept unless a new one is sent).
   *
   *   pct     {items: [i], pct 5-90}
   *   amount  {items: [i], off (cents, less than the price)}
   *   multi   {items: [i], n, m, mpct}   buy n, get m at mpct% off (100 = free)
   *   bundle  {items: [2-4, the first is the one people come for], price}
   *   spend   {spend, save, basket, baskets, clear}   spend T get G off; the
   *           usual basket, how many baskets these days usually see, and
   *           how many of those already reach T
   *   every kind: limit (per customer, 0 = none), wsl (while supplies
   *   last), goal, was ("that is the price I really charged"), end (round
   *   the deal price to .99 / .00 / .50; pct and amount only). */
  function cleanDeal(b, doc, prev) {
    b = isObj(b) ? b : {};
    var cur = doc.cur || '$', items = doc.items || {};
    if (KINDS.indexOf(b.kind) < 0) throw fail(400, 'Pick a kind of deal.');
    var k = b.kind;
    var d = { kind: k, items: [], pct: 0, off: 0, n: 0, m: 0, mpct: 0, price: 0, spend: 0, save: 0, basket: 0, baskets: 0, clear: 0, limit: 0, wsl: b.wsl === true, goal: GOALS.indexOf(b.goal) >= 0 ? b.goal : (prev && GOALS.indexOf(prev.goal) >= 0 ? prev.goal : 'more'), was: b.was === true && k !== 'spend', end: '' };
    if (!(b.limit === undefined || b.limit === null || b.limit === '' || b.limit === 0)) {
      d.limit = intIn(b.limit, 1, LIMITS.perCustomer, null);
      if (d.limit === null) throw fail(400, 'A limit per customer is 1 to ' + LIMITS.perCustomer + ' - or leave it empty.');
    }
    var ids = Array.isArray(b.items) ? b.items.slice(0, 8) : [];
    function it(id) { if (!isId(id) || !own(items, id)) throw fail(400, 'Pick an item from your list.'); return items[id]; }
    if (k === 'spend') {
      if (!isCents(b.spend, 100, LIMITS.price)) throw fail(400, 'The spend is at least ' + money(100, cur) + '.');
      if (!isCents(b.save, 1, b.spend - 1)) throw fail(400, 'The amount off must be less than the spend (' + money(b.spend, cur) + ').');
      if (!isCents(b.basket, 1, LIMITS.price)) throw fail(400, 'Type your usual basket - what one shopper usually spends.');
      if (!isCents(b.baskets, 0, LIMITS.units)) throw fail(400, 'Type how many baskets you’d usually ring up over these days.');
      if (!isCents(b.clear, 0, b.baskets)) throw fail(400, 'The baskets that already reach ' + money(b.spend, cur) + ' can’t be more than your usual baskets (' + b.baskets + ').');
      d.spend = b.spend; d.save = b.save; d.basket = b.basket; d.baskets = b.baskets; d.clear = b.clear;
      return d;
    }
    if (k === 'bundle') {
      if (ids.length < 2 || ids.length > 4) throw fail(400, 'A bundle is two to four items.');
      var sum = 0, seen = {};
      ids.forEach(function (id) { var x = it(id); if (seen[id]) throw fail(400, 'A bundle is two to four different items.'); seen[id] = 1; sum += x.price; });
      if (!isCents(b.price, 1, sum - 1)) throw fail(400, 'A bundle must cost less than the items bought separately (' + money(sum, cur) + ').');
      d.items = ids.slice(); d.price = b.price;
      return d;
    }
    if (ids.length !== 1) throw fail(400, 'Pick the item this deal is on.');
    var item = it(ids[0]);
    d.items = [ids[0]];
    if (k === 'multi') {
      d.n = intIn(b.n, 1, 10, null); d.m = intIn(b.m, 1, 10, null); d.mpct = intIn(b.mpct, 5, 100, null);
      if (d.n === null || d.m === null) throw fail(400, 'Buy 1 to 10, get 1 to 10.');
      if (d.mpct === null) throw fail(400, 'The extra ones are free (100) or 5 to 95 percent off.');
      return d;
    }
    var raw;
    if (k === 'pct') {
      d.pct = intIn(b.pct, 5, 90, null);
      if (d.pct === null) throw fail(400, 'Percent off is a whole number from 5 to 90.');
      raw = pctOff(item.price, d.pct);
      if (raw < 1 || raw >= item.price) throw fail(400, 'That percent leaves the price where it was - the item is too cheap for it.');
    } else {
      if (!isCents(b.off, 1, item.price - 1)) throw fail(400, 'The amount off must be less than the price (' + money(item.price, cur) + ').');
      d.off = b.off; raw = item.price - b.off;
    }
    if (ENDS.indexOf(b.end) >= 0) { var r = toEnding(raw, b.end); if (r >= 1 && r < item.price && r !== raw) d.end = b.end; }
    return d;
  }

  /* ------------------------------------------------------------------ *
   * The sale as the rules read it
   *
   * flat(doc) -> {shop, title, from, to, cur, margin, items: [...], deals:
   * [...]}: items and deals in the order they were added, each deal with
   * its `count` (the tally), each item with what is `left`, each deal with
   * its `room` (how many more the stock allows, or null for no limit).
   * view(doc, mid) is this, cut down to what that phone may see.
   * ------------------------------------------------------------------ */

  function byTs(map) { return Object.keys(map || {}).sort(function (a, b) { var x = map[a].ts || 0, y = map[b].ts || 0; return x - y || (a < b ? -1 : 1); }); }
  function itemById(s, id) { for (var i = 0; i < s.items.length; i++) if (s.items[i].id === id) return s.items[i]; return null; }
  function dealById(s, id) { for (var i = 0; i < s.deals.length; i++) if (s.deals[i].id === id) return s.deals[i]; return null; }
  /** How many of each item one sale of this deal takes: {item id: units}. */
  function unitsOf(d) {
    var per = {};
    if (d.kind === 'spend') return per;
    (d.items || []).forEach(function (id) { per[id] = d.kind === 'multi' ? d.n + d.m : 1; });
    return per;
  }
  function flat(doc) {
    var s = { shop: doc.shop, title: doc.title, from: doc.from, to: doc.to, cur: CURRENCIES.indexOf(doc.cur) >= 0 ? doc.cur : '$', margin: intIn(doc.margin, 0, 95, 50), items: [], deals: [] };
    var sold = {};
    byTs(doc.deals).forEach(function (id) {
      var d = doc.deals[id], count = intIn(own(doc.tally, id) ? doc.tally[id] : 0, 0, LIMITS.units, 0);
      var x = { id: id, kind: d.kind, items: Array.isArray(d.items) ? d.items.slice() : [], pct: d.pct || 0, off: d.off || 0, n: d.n || 0, m: d.m || 0, mpct: d.mpct || 0, price: d.price || 0, spend: d.spend || 0, save: d.save || 0, basket: d.basket || 0, baskets: d.baskets || 0, clear: d.clear || 0, limit: d.limit || 0, wsl: Boolean(d.wsl), goal: GOALS.indexOf(d.goal) >= 0 ? d.goal : 'more', was: Boolean(d.was), end: ENDS.indexOf(d.end) >= 0 ? d.end : '', count: count, undo: isObj(d.undo), alt: line(d.alt, 200) };
      var per = unitsOf(x);
      Object.keys(per).forEach(function (iid) { sold[iid] = (sold[iid] || 0) + count * per[iid]; });
      s.deals.push(x);
    });
    byTs(doc.items).forEach(function (id) {
      var it = doc.items[id], stock = isCents(it.stock, 0, LIMITS.units) ? it.stock : null;
      s.items.push({ id: id, name: it.name, price: it.price, cost: it.cost, base: it.base, stock: stock, sold: sold[id] || 0, left: stock === null ? null : Math.max(0, stock - (sold[id] || 0)) });
    });
    s.deals.forEach(function (x) { x.room = roomOf(s, x); });
    return s;
  }
  /** How many more of this deal the stock allows - or null for no limit. */
  function roomOf(s, d) {
    var per = unitsOf(d), room = null;
    Object.keys(per).forEach(function (iid) {
      var it = itemById(s, iid);
      if (!it || it.left === null) return;
      var r = Math.floor(it.left / per[iid]);
      if (room === null || r < room) room = r;
    });
    return room;
  }

  /* ------------------------------------------------------------------ *
   * The offer: what the SHOPPER sees. Prices only - nothing here reads a
   * cost, so a staff phone (which is never sent one) can draw it.
   *
   *   pay   what one sale of the deal costs the shopper (one unit; one set
   *         of n+m; one bundle; a basket of exactly the spend)
   *   full  the same at the usual prices
   *   save  full - pay, and pct = that as a whole percent, rounded DOWN
   * ------------------------------------------------------------------ */

  function multiHead(d) { return 'Buy ' + d.n + ', get ' + d.m + (d.mpct >= 100 ? ' free' : d.mpct === 50 ? ' half price' : ' at ' + d.mpct + '% off'); }
  function offer(s, d) {
    var its = (d.items || []).map(function (id) { return itemById(s, id); });
    if (its.some(function (x) { return !x; })) return { ok: false };
    var o = { ok: true, kind: d.kind, noun: '', units: 1, full: 0, pay: 0, raw: 0, rounded: false, names: its.map(function (x) { return x.name; }) };
    if (d.kind === 'pct' || d.kind === 'amount') {
      if (its.length !== 1) return { ok: false };
      o.full = its[0].price;
      o.raw = d.kind === 'pct' ? pctOff(o.full, d.pct) : o.full - d.off;
      o.pay = o.raw;
      if (d.end) { var r = toEnding(o.raw, d.end); if (r >= 1 && r < o.full) o.pay = r; }
      o.rounded = o.pay !== o.raw;
    } else if (d.kind === 'multi') {
      if (its.length !== 1) return { ok: false };
      o.noun = 'set'; o.units = d.n + d.m;
      o.full = o.units * its[0].price;
      o.pay = d.n * its[0].price + d.m * pctOff(its[0].price, d.mpct);
    } else if (d.kind === 'bundle') {
      if (its.length < 2) return { ok: false };
      o.noun = 'bundle'; o.units = its.length;
      its.forEach(function (x) { o.full += x.price; });
      o.pay = d.price;
    } else if (d.kind === 'spend') {
      o.noun = 'use'; o.units = 0; o.full = d.spend; o.pay = d.spend - d.save;
    } else return { ok: false };
    if (o.pay < 0 || o.pay >= o.full || o.full < 1) return { ok: false };
    o.save = o.full - o.pay;
    o.pct = Math.floor(o.save * 100 / o.full);
    return o;
  }
  /** The deal in a few words: "30% off Wool scarf". */
  function dealTitle(s, d) {
    var o = offer(s, d), cur = s.cur;
    if (!o.ok) return KIND_NAMES[d.kind] || 'Deal';
    if (d.kind === 'pct') return d.pct + '% off ' + o.names[0];
    if (d.kind === 'amount') return moneyShort(d.off, cur) + ' off ' + o.names[0];
    if (d.kind === 'multi') return multiHead(d) + ': ' + o.names[0];
    if (d.kind === 'bundle') return o.names.join(' + ') + ' for ' + moneyShort(d.price, cur);
    return 'Spend ' + moneyShort(d.spend, cur) + ', get ' + moneyShort(d.save, cur) + ' off';
  }
  /** "45", "45 sets", "45 bundles", "45 uses" */
  function countOf(n, noun) { return noun ? plural(n, noun) : String(n); }
  /** The other deals this one overlaps: another deal on one of its items.
   *  Spend-and-save is on the whole shop, so IT overlaps every other deal
   *  (and its sign says so); the item deals are not each flagged for it. */
  function overlaps(s, d) {
    return s.deals.filter(function (x) {
      if (x.id === d.id) return false;
      if (d.kind === 'spend') return true;
      return x.kind !== 'spend' && x.items.some(function (id) { return d.items.indexOf(id) >= 0; });
    });
  }

  /* ------------------------------------------------------------------ *
   * The analysis: what the SHOP makes. Owner only (it reads costs).
   *
   * One vocabulary for every shape - a deal is sold in COUNTS (a unit, a
   * set, a bundle, a use of the offer):
   *
   *   after       what one count makes at the deal price: pay - its costs
   *   before      what ONE USUAL SALE makes: the item's price - cost (for a
   *               multi-buy, one unit - the usual buyer buys one; for a
   *               bundle, the first item - the one people come for)
   *   fullMargin  what the same units would make at usual prices
   *   base        how many the shop usually sells (of that item)
   *   baseProfit  base x before: what the usual days make
   *   breakEven   the counts needed before the deal has made as much:
   *               baseProfit / after, rounded UP. null when after <= 0.
   *   x10         breakEven / base in tenths, rounded up ("2.3x"); null with
   *               no usual sales to compare with
   *
   * THE MODELS (each said on the page, each an estimate from the owner's
   * own usual numbers):
   *   - percent / amount off: while the deal is on, every unit sells at the
   *     deal price - including to the people who would have paid full.
   *   - multi-buy: the usual buyer of one now takes the set. A buyer who
   *     still takes just one pays full price and is not counted.
   *   - bundle: a bundle buyer would otherwise have bought only the first
   *     item. (Someone who would have bought all of it anyway simply saves
   *     the difference at the shop's expense - the page says how much.)
   *   - spend and save: the baskets that already reach the spend get the
   *     money off for nothing (`free`); every use beyond those is counted
   *     as a NEW basket of exactly the spend, making the shop's usual
   *     margin on it less the money off (`after`). A shopper who stretches
   *     from the usual basket up to the spend adds `stretch`.
   *
   * A loss leader (after < 0): `loss` per count; `payback` = the other
   * full-price shopping, at the usual margin, one sale needs in the same
   * basket to pay for itself (rounded up); `exposure` = loss x stock when
   * the stock is known.
   * ------------------------------------------------------------------ */

  function analyse(s, d) {
    var o = offer(s, d);
    if (!o.ok) return { ok: false, status: 'bad', verdict: 'This deal no longer fits its items - edit it.', lines: [], flags: [], model: '' };
    var a = { ok: true, o: o, kind: d.kind, noun: o.noun, pay: o.pay, full: o.full, save: o.save, pct: o.pct, cost: 0, before: 0, after: 0, fullMargin: 0, base: 0, baseProfit: 0, breakEven: null, x10: null, stock: null, loss: 0, payback: null, exposure: null, free: 0, extra: null, stretch: null, stretchNeed: null, lead: null };
    if (d.kind === 'spend') {
      a.before = Math.floor(d.spend * s.margin / 100);
      a.after = a.before - d.save;
      a.fullMargin = a.before;
      a.base = d.clear;
      a.free = d.clear * d.save;
      if (a.after > 0) { a.extra = ceilDiv(a.free, a.after); a.breakEven = d.clear + a.extra; if (d.clear > 0) a.x10 = ceilDiv(a.breakEven * 10, d.clear); }
      if (d.basket < d.spend) { a.stretch = Math.floor((d.spend - d.basket) * s.margin / 100) - d.save; if (a.stretch > 0) a.stretchNeed = ceilDiv(a.free, a.stretch); }
      if (a.after < 0) a.loss = -a.after;
      return a;
    }
    var per = unitsOf(d), lead = itemById(s, d.items[0]);
    d.items.forEach(function (id) {
      var it = itemById(s, id);
      a.cost += per[id] * it.cost;
      if (it.stock !== null) { var n = Math.floor(it.stock / per[id]); if (a.stock === null || n < a.stock) a.stock = n; }
    });
    a.lead = lead.id;
    a.before = lead.price - lead.cost;
    a.after = o.pay - a.cost;
    a.fullMargin = o.full - a.cost;
    a.base = lead.base;
    a.baseProfit = a.base * a.before;
    if (a.after > 0) {
      a.breakEven = a.baseProfit > 0 ? ceilDiv(a.baseProfit, a.after) : 0;
      if (a.base > 0) a.x10 = ceilDiv(a.breakEven * 10, a.base);
    } else {
      a.loss = a.after < 0 ? -a.after : 0;
      if (a.loss > 0 && s.margin > 0) a.payback = ceilDiv(a.loss * 100, s.margin);
      if (a.stock !== null) a.exposure = a.loss * a.stock;
    }
    return a;
  }
  /** What `count` sales of the deal have made (spend and save: against the
   *  baskets that would have come anyway). */
  function madeAt(a, d, count) {
    if (!a.ok) return 0;
    if (d.kind === 'spend') return Math.max(0, count - d.clear) * a.after - Math.min(count, d.clear) * d.save;
    return count * a.after;
  }
  /** Lower is kinder: the usual-sales multiple, or - with no usual sales -
   *  0 for a deal that makes something. A deal that makes nothing is last. */
  function score(a) {
    if (!a.ok || a.after <= 0) return 100000 + (a.ok ? a.loss : 0);
    return a.x10 === null ? 0 : a.x10;
  }

  var MODEL = {
    pct: 'This assumes every one you sell during the sale goes at the deal price - including to shoppers who would have paid full price.',
    multi: 'This assumes your usual buyer of one now takes the set. Someone who still takes just one pays full price and isn’t counted.',
    bundle: 'This assumes a bundle buyer would otherwise have bought only the first item, the one they came for.',
    spend: 'This assumes the baskets that already reach the spend get the money off for nothing, and every use beyond them is a new basket of exactly the spend at your usual margin.',
  };

  /** The verdict, in words beside a status, shaped by the deal's goal.
   *  -> {status: 'good'|'tight'|'bad'|'loss'|'stock', label, verdict, lines} */
  function judge(s, d, a) {
    var cur = s.cur, M = function (c) { return money(c, cur); }, N = function (n) { return countOf(n, a.noun); };
    var lines = [], status, verdict, label;
    var capped = a.stock !== null;
    if (d.kind === 'spend') {
      var T = M(d.spend), G = M(d.save);
      if (d.clear > 0) lines.push(d.clear + ' of your usual ' + plural(d.baskets, 'basket') + ' already reach ' + T + ': they get ' + G + ' off for nothing - ' + M(a.free) + '.');
      else lines.push('None of your usual baskets reaches ' + T + ', so nobody gets the ' + G + ' for nothing.');
      if (a.after <= 0) {
        return { status: 'loss', label: 'Loses money', verdict: 'A ' + T + ' basket makes about ' + M(a.before) + ' at your usual ' + s.margin + '% margin - ' + (a.after === 0 ? 'exactly' : 'less than') + ' the ' + G + ' off. Every use at the threshold makes nothing' + (a.after < 0 ? ' and loses ' + M(a.loss) : '') + '.', lines: lines.concat(['Raise the spend or lower the amount off until a basket at the threshold still makes something.']) };
      }
      lines.push('A new ' + T + ' basket makes about ' + M(a.after) + ' after the ' + G + ' off' + (a.free ? ', so it takes ' + plural(a.extra, 'extra basket') + ' to pay for the free ones.' : '.'));
      if (a.stretch !== null) {
        lines.push(a.stretch > 0
          ? 'A shopper who stretches from your usual ' + M(d.basket) + ' basket up to ' + T + ' adds about ' + M(a.stretch) + (a.free ? ' - ' + plural(a.stretchNeed, 'of those pays', 'of those pay') + ' for the free ones too.' : '.')
          : 'Stretching a ' + M(d.basket) + ' basket up to ' + T + ' adds less margin than the ' + G + ' off, so only new baskets pay for this.');
      }
      if (!a.free) return { status: 'good', label: 'Should pay', verdict: 'Costs nothing unless it works: each basket it lifts to ' + T + ' makes about ' + M(a.after) + '.', lines: lines };
      var sx = a.x10;
      status = sx <= GOOD_X10 ? 'good' : sx <= TIGHT_X10 ? 'tight' : 'bad';
      verdict = (status === 'good' ? 'Makes money after ' : status === 'tight' ? 'Tight: makes money only after ' : 'Unlikely to pay: it needs ') + plural(a.breakEven, 'use') + ' (' + d.clear + ' you’d have had anyway + ' + a.extra + ' new)' + (d.goal === 'traffic' ? ' - worth it only if it really brings new people in.' : '.');
      return { status: status, label: status === 'good' ? 'Should pay' : status === 'tight' ? 'Tight' : 'Unlikely', verdict: verdict, lines: lines };
    }
    var each = a.noun ? 'a ' + a.noun : 'each', what = dealShort(s, d);
    // Clearing stock: cash back against what the stock already cost.
    if (d.goal === 'clear') {
      if (capped) {
        var cash = a.pay * a.stock, sunk = a.cost * a.stock, all = a.stock === 1 ? 'the last one' : 'all ' + N(a.stock);
        if (cash >= sunk) { status = 'good'; label = 'Clears above cost'; verdict = 'Clears above cost: selling ' + all + ' brings in ' + M(cash) + ' against the ' + M(sunk) + ' you already paid for them.'; }
        else { status = 'tight'; label = 'Clears below cost'; verdict = 'Clears below cost: selling ' + all + ' brings back ' + M(cash) + ' of the ' + M(sunk) + ' you already paid. The stock is already paid for, so this is cash recovered - ' + M(sunk - cash) + ' short of what it cost.'; }
        lines.push('At your usual prices the same stock would bring ' + M(a.full * a.stock) + ' - if it would sell at all. That is the choice you are making.');
      } else {
        status = a.pay >= a.cost ? 'good' : 'tight'; label = a.pay >= a.cost ? 'Clears above cost' : 'Clears below cost';
        verdict = 'Each ' + (a.noun || 'one') + ' sold brings back ' + M(a.pay) + ' against the ' + M(a.cost) + ' it cost you' + (a.pay < a.cost ? ' - the stock is already paid for, so this is cash recovered, not a new loss.' : '.');
        lines.push('Type the stock on hand on the item to see what clearing all of it brings back.');
      }
      if (a.breakEven !== null && a.base > 0) lines.push('For the record, matching your usual ' + M(a.baseProfit) + ' would take ' + N(a.breakEven) + ' (' + times(a.x10) + ' usual).');
      return { status: status, label: label, verdict: verdict, lines: lines };
    }
    if (a.after <= 0) {
      // Sold at or below cost: a loss leader.
      var cap = a.exposure !== null ? 'At most ' + M(a.exposure) + ' if ' + (a.stock === 1 ? 'the one in stock goes' : 'all ' + N(a.stock) + ' go') + '.' : 'There is no cap on that yet: type the stock on hand, or set a limit per customer.';
      if (a.after === 0) {
        verdict = 'Sells at cost: you make nothing on ' + (a.noun ? 'a ' + a.noun : 'each one') + '.';
        lines.push('It only pays through what else lands in the same basket.');
      } else {
        verdict = (d.goal === 'traffic' ? 'A loss leader' : 'Sells below cost') + ': every ' + (a.noun || 'sale') + ' loses ' + M(a.loss) + '.';
        if (a.payback !== null) lines.push('Each one needs ' + M(a.payback) + ' of other full-price shopping in the same basket to pay for itself (at your usual ' + s.margin + '% margin).');
        lines.push(cap);
      }
      if (a.baseProfit > 0) lines.push('You also give up the ' + M(a.baseProfit) + ' these usually make.');
      if (!d.limit) lines.push('Set a limit per customer, so one shopper can’t take them all.');
      status = d.goal === 'traffic' ? (capped || d.limit ? 'tight' : 'bad') : 'loss';
      return { status: status, label: d.goal === 'traffic' ? 'Loss leader' : (a.after === 0 ? 'Sells at cost' : 'Sells below cost'), verdict: verdict, lines: lines };
    }
    // Makes something on each: the break-even against the usual days.
    if (a.base > 0 && a.baseProfit > 0) {
      lines.push('You usually sell ' + a.base + ' and make ' + M(a.baseProfit) + '. ' + (d.kind === 'multi' || d.kind === 'bundle' ? 'A ' + a.noun + ' makes ' + M(a.after) : 'At ' + what + ' you make ' + M(a.after) + ' each') + ', so you need ' + (a.noun ? N(a.breakEven) : 'to sell ' + a.breakEven) + ' - ' + times(a.x10) + ' as many - before this deal makes you a cent more.');
    } else {
      lines.push('Each ' + (a.noun || 'sale') + ' makes ' + M(a.after) + ', and there are no usual sales to beat' + (a.base > 0 ? ' (at your usual price it makes nothing)' : '') + ' - every one is extra.');
    }
    if (capped && a.breakEven > a.stock) {
      return { status: 'stock', label: 'Not enough stock', verdict: 'You can’t break even: you need ' + N(a.breakEven) + ' and have ' + a.stock + ' in stock.', lines: lines.concat(['Selling every one still makes ' + M(a.baseProfit - a.after * a.stock) + ' less than your usual days.']) };
    }
    if (a.x10 === null) return { status: 'good', label: 'Should pay', verdict: 'Makes ' + M(a.after) + ' on every ' + (a.noun || 'sale') + ' - all of it extra.', lines: lines };
    status = a.x10 <= GOOD_X10 ? 'good' : a.x10 <= TIGHT_X10 ? 'tight' : 'bad';
    var need = N(a.breakEven) + (a.noun ? '' : '+') + ' (' + times(a.x10) + ' usual)';
    if (d.goal === 'traffic') {
      verdict = 'Brings people in and still makes ' + M(a.after) + ' ' + each + '. It matches your usual ' + M(a.baseProfit) + ' at ' + need + '; below that it pays only if they buy other things too.';
      status = status === 'bad' ? 'tight' : status;
    } else if (a.breakEven <= a.base) verdict = 'Makes money from ' + (a.noun ? N(a.breakEven) : 'sale ' + a.breakEven) + ' - no more than you usually sell (' + times(a.x10) + ' usual).';
    else verdict = status === 'good' ? 'Makes money if you sell ' + need + '.' : status === 'tight' ? 'Tight: makes money only if you sell ' + need + '.' : 'Unlikely to pay: you’d need to sell ' + need + '.';
    return { status: status, label: status === 'good' ? 'Should pay' : status === 'tight' ? 'Tight' : 'Unlikely', verdict: verdict, lines: lines };
  }
  /** "30% off", "$5 off", "buy 2, get 1 free", "the bundle" - mid-sentence. */
  function dealShort(s, d) {
    if (d.kind === 'pct') return d.pct + '% off';
    if (d.kind === 'amount') return moneyShort(d.off, s.cur) + ' off';
    if (d.kind === 'multi') { var h = multiHead(d); return h.charAt(0).toLowerCase() + h.slice(1); }
    if (d.kind === 'bundle') return 'the bundle';
    return 'spend ' + moneyShort(d.spend, s.cur) + ', get ' + moneyShort(d.save, s.cur) + ' off';
  }

  /** Plain flags, each with its reason. `k` names it; `soft` is a note. */
  function flagsFor(s, d, a) {
    var out = [], cur = s.cur;
    if (!a.ok) return out;
    if (d.kind !== 'spend' && a.after < 0) out.push({ k: 'cost', text: 'Below cost: the shopper pays ' + money(a.pay, cur) + ' for what cost you ' + money(a.cost, cur) + '.' });
    if (d.kind !== 'spend' && d.goal !== 'clear' && a.breakEven !== null && a.stock !== null && a.breakEven > a.stock) out.push({ k: 'stock', text: 'Stock is lower than the break-even: ' + a.stock + ' on hand, ' + a.breakEven + ' needed.' });
    var others = overlaps(s, d);
    if (others.length) out.push({ k: 'overlap', text: (d.kind === 'spend' ? 'Runs alongside ' + (others.length === 1 ? 'your other deal' : 'your ' + others.length + ' other deals') + '. Decide whether sale items count toward the ' + moneyShort(d.spend, cur) : 'Overlaps ' + listNames(others.slice(0, 3).map(function (x) { return '“' + dealTitle(s, x) + '”'; })) + (others.length > 3 ? ' and more' : '') + '. Decide which one applies at the till') + ' - the sign says it cannot be combined with other offers.' });
    if (d.kind !== 'spend' && !d.was) {
      out.push({ k: 'was', ask: true, text: (d.kind === 'bundle' || d.kind === 'multi'
        ? 'Are ' + (d.kind === 'bundle' ? 'these prices (' + money(a.full, cur) + ' together)' : money(itemById(s, d.items[0]).price, cur) + ' each') + ' what you really charged in the last few weeks?'
        : 'Is ' + money(a.full, cur) + ' what you really charged in the last few weeks?') + ' Until you tick that, the sign shows the deal with no “was” price and no “you save”. ' + WAS_RULE });
    }
    if (a.pct < SMALL_PCT) out.push({ k: 'small', soft: true, text: 'This works out at ' + a.pct + '% off. A discount under ' + SMALL_PCT + '% may be too small for shoppers to notice.' });
    if ((d.kind === 'pct' || d.kind === 'amount') && !d.end && [0, 50, 95, 99].indexOf(a.pay % 100) < 0) out.push({ k: 'ending', soft: true, text: 'The deal price comes to ' + money(a.pay, cur) + '. A price ending in .99, .00 or .50 reads cleaner on a sign.' });
    if (d.kind !== 'spend' && a.after <= 0 && !d.limit && d.goal !== 'clear') out.push({ k: 'limit', soft: true, text: 'No limit per customer on a deal that makes nothing on each one.' });
    return out;
  }
  /** Rounding the deal price to a cleaner ending, and what each does to the
   *  break-even: [{end, price, breakEven, x10, after}] (pct and amount). */
  function endings(s, d) {
    if (d.kind !== 'pct' && d.kind !== 'amount') return [];
    var plain = clone(d); plain.end = '';
    var o = offer(s, plain), out = [];
    if (!o.ok) return out;
    ENDS.forEach(function (e) {
      var p = toEnding(o.raw, e);
      if (p === o.raw || p < 1 || p >= o.full) return;
      var c = clone(plain); c.end = e;
      var a = analyse(s, c);
      out.push({ end: e, price: p, breakEven: a.breakEven, x10: a.x10, after: a.after, on: d.end === e });
    });
    return out;
  }
  /** Everything the owner's page shows about one deal. */
  function report(s, d) {
    var a = analyse(s, d);
    if (!a.ok) return a;
    var j = judge(s, d, a);
    a.status = j.status; a.label = j.label; a.verdict = j.verdict; a.lines = j.lines;
    a.flags = flagsFor(s, d, a);
    a.model = MODEL[d.kind === 'amount' ? 'pct' : d.kind] + ' ' + ESTIMATE;
    if (d.kind === 'bundle') a.model = MODEL.bundle + ' Someone who would have bought all of it anyway saves ' + money(a.save, s.cur) + ' at your expense. ' + ESTIMATE;
    return a;
  }

  /* ------------------------------------------------------------------ *
   * "Same pull, kinder to your margin"
   *
   * Up to three other shapes of the same deal, by rule, each made ONLY from
   * the owner's own items and each with its own break-even. A shape is
   * offered only if it is kinder (a lower multiple of the usual sales; or,
   * for a deal that loses on each one, anything that makes something) -
   * except the limit per customer, which changes no break-even and is
   * offered for what it is: a cap.
   *
   *   percent / amount off  -> the multi-buy that looks at least as big
   *                            (16%: buy 2 get 1 half price; 25%: buy 1 get
   *                            1 half price; 33%: buy 2 get 1 free; 50%:
   *                            buy 1 get 1 free);
   *                            five points less (a fifth less, for an amount);
   *                            a bundle with the owner's highest-margin
   *                            other item, saving the shopper the same money
   *   multi-buy             -> the next gentler multi-buy
   *   bundle                -> a fifth less off
   *   spend and save        -> a fifth less off
   *   any, with no limit    -> a limit of 2 per customer
   * ------------------------------------------------------------------ */

  var MULTIS = [{ n: 2, m: 1, mpct: 50 }, { n: 1, m: 1, mpct: 50 }, { n: 2, m: 1, mpct: 100 }, { n: 1, m: 1, mpct: 100 }];
  function multiPct(x) { return Math.floor(x.m * x.mpct / (x.n + x.m)); }
  function fifthLess(c) { var x = Math.floor(c * 4 / 5); return x >= 1000 ? Math.floor(x / 100) * 100 : x >= 100 ? Math.floor(x / 50) * 50 : x; }
  function plain(d) { var c = {}; ['kind', 'items', 'pct', 'off', 'n', 'm', 'mpct', 'price', 'spend', 'save', 'basket', 'baskets', 'clear', 'limit', 'wsl', 'goal', 'was', 'end'].forEach(function (k) { c[k] = clone(d[k]); }); return c; }
  function needText(s, d, a) {
    if (!a.ok || a.after < 0) return 'loses ' + money(a.loss, s.cur) + ' on each';
    if (a.after === 0) return 'makes nothing on each';
    if (d.kind === 'spend' && a.breakEven !== null) return 'needs ' + plural(a.breakEven, 'use');
    if (a.x10 !== null) return 'needs ' + times(a.x10) + ' your usual sales';
    return 'makes ' + money(a.after, s.cur) + ' on each';
  }
  function alternatives(s, d) {
    var a0 = analyse(s, d), out = [];
    if (!a0.ok) return out;
    var docLike = { cur: s.cur, items: {} };
    s.items.forEach(function (it) { docLike.items[it.id] = it; });
    function cand(k, head, raw) {
      var c;
      try { c = cleanDeal(raw, docLike, d); } catch (e) { return; }
      c.goal = d.goal; c.was = d.was && c.kind !== 'spend';
      var tmp = clone(c); tmp.id = d.id;
      var a = analyse(s, tmp);
      if (!a.ok) return;
      var better = score(a) < score(a0);
      if (!better) return;
      var both = a0.x10 !== null && a.x10 !== null && a.after > 0 && a0.after > 0 && d.kind !== 'spend';
      var tail = both ? 'needs ' + times(a.x10) + ' your usual sales, not ' + times(a0.x10) : needText(s, tmp, a) + ' - this one ' + needText(s, d, a0);
      out.push({ k: k, label: head + ': ' + tail + '.', deal: c, score: score(a), breakEven: a.breakEven, x10: a.x10, after: a.after });
    }
    var base = plain(d), lead = d.items.length ? itemById(s, d.items[0]) : null;
    if (d.kind === 'pct' || d.kind === 'amount') {
      var mb = null;
      MULTIS.forEach(function (x) { if (!mb && multiPct(x) >= a0.pct) mb = x; });
      if (mb) cand('multi', multiHead(mb) + ' looks like ' + multiPct(mb) + '% off, but only costs you on the ' + (mb.mpct >= 100 ? 'free one' : 'discounted one'), { kind: 'multi', items: d.items, n: mb.n, m: mb.m, mpct: mb.mpct, limit: d.limit, wsl: d.wsl });
      if (d.kind === 'pct' && d.pct - 5 >= 5) cand('less', (d.pct - 5) + '% off', Object.assign({}, base, { pct: d.pct - 5, end: '' }));
      if (d.kind === 'amount' && fifthLess(d.off) >= 1 && fifthLess(d.off) < d.off) cand('less', moneyShort(fifthLess(d.off), s.cur) + ' off', Object.assign({}, base, { off: fifthLess(d.off), end: '' }));
      // The owner's own highest-margin other item, the same money saved.
      var mate = null;
      s.items.forEach(function (it) {
        if (it.id === lead.id || it.price <= it.cost) return;
        if (!mate || (it.price - it.cost) * mate.price > (mate.price - mate.cost) * it.price) mate = it;
      });
      if (mate && lead.price + mate.price - a0.save > 0) cand('bundle', lead.name + ' + ' + mate.name + ' for ' + moneyShort(lead.price + mate.price - a0.save, s.cur) + ' saves the shopper the same ' + moneyShort(a0.save, s.cur), { kind: 'bundle', items: [lead.id, mate.id], price: lead.price + mate.price - a0.save, limit: d.limit, wsl: d.wsl });
    } else if (d.kind === 'multi') {
      var mine = multiPct(d), g = null;
      MULTIS.forEach(function (x) { if (multiPct(x) < mine) g = x; });
      if (g) cand('multi', multiHead(g) + ' (about ' + multiPct(g) + '% off)', Object.assign({}, base, g));
    } else if (d.kind === 'bundle') {
      var less = a0.save - fifthLess(a0.save);
      if (less > 0 && fifthLess(a0.save) >= 1) cand('less', 'The same bundle for ' + moneyShort(d.price + less, s.cur) + ' (saves ' + moneyShort(fifthLess(a0.save), s.cur) + ')', Object.assign({}, base, { price: d.price + less }));
    } else if (d.kind === 'spend') {
      if (fifthLess(d.save) >= 1 && fifthLess(d.save) < d.save) cand('less', 'Spend ' + moneyShort(d.spend, s.cur) + ', get ' + moneyShort(fifthLess(d.save), s.cur) + ' off', Object.assign({}, base, { save: fifthLess(d.save) }));
    }
    out.sort(function (x, y) { return x.score - y.score; });
    var wantCap = !d.limit && d.goal !== 'clear' && (a0.after <= 0 || a0.x10 === null || a0.x10 > GOOD_X10 || d.kind === 'spend');
    out = out.slice(0, wantCap ? 2 : 3);
    if (wantCap) {
      var cap = cleanDeal(Object.assign({}, base, { limit: d.kind === 'spend' ? 1 : 2 }), docLike, d);
      cap.goal = d.goal; cap.was = d.was;
      out.push({ k: 'limit', label: dealShort(s, d).replace(/^./, function (c) { return c.toUpperCase(); }) + ' with a limit of ' + cap.limit + ' per customer: the same break-even, but it caps what one shopper can take.', deal: cap, score: score(a0), breakEven: a0.breakEven, x10: a0.x10, after: a0.after });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * The sign
   *
   * Drawn from the deal's own numbers, so nothing on it can be false: a
   * percentage is rounded DOWN; a "was" price and a "you save" appear only
   * when the owner has ticked that the usual price is one they really
   * charged; "cannot be combined" appears when another deal overlaps.
   * Templates, not a model. Prices only: a staff phone can draw it.
   * ------------------------------------------------------------------ */

  function sign(s, d) {
    var o = offer(s, d), cur = s.cur, M = function (c) { return money(c, cur); };
    if (!o.ok) return null;
    var g = { head: '', sub: '', lines: [], fine: [], shop: s.shop, title: s.title, dates: dateRange(s.from, s.to) };
    if (d.kind === 'pct' || d.kind === 'amount') {
      g.sub = o.names[0];
      g.head = o.rounded ? 'Now ' + M(o.pay) : (d.kind === 'pct' ? d.pct + '% off' : moneyShort(d.off, cur) + ' off');
      if (d.was) { g.lines.push('Was ' + M(o.full) + (o.rounded ? '' : ' · Now ' + M(o.pay))); g.lines.push('You save ' + M(o.save) + ' (' + o.pct + '%)'); }
      else if (!o.rounded) g.lines.push('Now ' + M(o.pay));
    } else if (d.kind === 'multi') {
      g.head = multiHead(d); g.sub = o.names[0];
      g.lines.push(o.units + ' for ' + M(o.pay));
      if (d.was) g.lines.push('You save ' + M(o.save) + ' (' + o.pct + '%)');
    } else if (d.kind === 'bundle') {
      g.head = (o.names.length === 2 ? 'Both' : 'All ' + o.names.length) + ' for ' + moneyShort(o.pay, cur); g.sub = o.names.join(' + ');
      if (d.was) { g.lines.push('Separately ' + M(o.full)); g.lines.push('You save ' + M(o.save) + ' (' + o.pct + '%)'); }
    } else {
      g.head = 'Spend ' + moneyShort(d.spend, cur) + ', get ' + moneyShort(d.save, cur) + ' off';
      g.sub = 'In one visit';
    }
    if (d.limit) g.fine.push(d.kind === 'spend' ? (d.limit === 1 ? 'One per customer' : 'Limit ' + d.limit + ' per customer') : 'Limit ' + d.limit + ' per customer');
    if (d.wsl) g.fine.push('While supplies last');
    if (overlaps(s, d).length) g.fine.push('Cannot be combined with other offers');
    var what = o.rounded ? g.sub + ' - now ' + M(o.pay) : dealTitle(s, d);
    var tail = g.fine.length ? ' ' + g.fine.join('. ') + '.' : '';
    g.text = what + ' at ' + s.shop + ', ' + g.dates + '.' + tail;
    g.post = s.title + ' at ' + s.shop + ' - ' + what + (g.lines.length ? '. ' + g.lines.join('. ') : '') + '. ' + g.dates + '.' + tail;
    return g;
  }

  /* ------------------------------------------------------------------ *
   * The day, and afterwards
   * ------------------------------------------------------------------ */

  /** 'before' | 'during' | 'after', the day number and how many days. */
  function phase(s, today) {
    var days = daysBetween(s.from, s.to) + 1;
    if (today < s.from) return { k: 'before', day: 0, days: days, starts: daysBetween(today, s.from) };
    if (today > s.to) return { k: 'after', day: days, days: days };
    return { k: 'during', day: daysBetween(s.from, today) + 1, days: days };
  }
  /** One deal's place on the tally, for the owner: the bar to break-even
   *  and the words under it. {p (0-20, twentieths), line, status} */
  function progress(s, d, a) {
    var cur = s.cur, n = d.count, noun = a.noun || 'sale';
    if (!a.ok) return { p: 0, line: '', status: 'bad' };
    if (d.goal === 'clear' && d.kind !== 'spend') {
      var total = a.stock;
      return { p: total ? Math.min(20, Math.floor(n * 20 / total)) : 0, status: 'good', line: (total !== null ? n + ' of ' + total + ' cleared' : n + ' cleared') + ' - ' + money(n * a.pay, cur) + ' back' + (n ? ' against ' + money(n * a.cost, cur) + ' of cost.' : '.') };
    }
    if (a.breakEven === null) return { p: 0, status: 'loss', line: n ? plural(n, noun) + ' - ' + (a.loss ? money(n * a.loss, cur) + ' spent bringing people in.' : 'nothing made on them.') : 'Nothing sold yet.' };
    if (a.breakEven === 0) return { p: 20, status: 'good', line: plural(n, noun) + ' - each one adds ' + money(a.after, cur) + '.' };
    if (n >= a.breakEven) return { p: 20, status: 'good', line: 'Past break-even at ' + noun + ' ' + a.breakEven + ' - every ' + noun + ' now adds ' + money(a.after, cur) + '.' };
    return { p: Math.floor(n * 20 / a.breakEven), status: 'way', line: n + ' of ' + a.breakEven + ' - ' + (a.breakEven - n) + ' to go.' };
  }
  /** The whole sale so far, for the owner: what the tallied sales have
   *  made, and what the same items usually make over these days. Two deals
   *  on one item share that item's usual figure once. */
  function totals(s) {
    var made = 0, usual = 0, seen = {}, rows = [];
    s.deals.forEach(function (d) {
      var a = analyse(s, d);
      if (!a.ok) return;
      var m = madeAt(a, d, d.count);
      made += m;
      if (a.lead && !seen[a.lead]) { seen[a.lead] = 1; usual += a.baseProfit; }
      rows.push({ id: d.id, d: d, a: a, made: m, delta: m - a.baseProfit });
    });
    return { made: made, usual: usual, delta: made - usual, rows: rows };
  }
  /** "This sale so far vs. your usual days", honest about its footing. */
  function paceLine(s, today) {
    var t = totals(s), ph = phase(s, today), cur = s.cur;
    if (!s.deals.length) return '';
    var byNow = Math.round(t.usual * ph.day / ph.days), diff = t.made - byNow;
    return 'So far the deals have made about ' + (t.made < 0 ? '-' : '') + about(t.made, cur) + '. By day ' + ph.day + ' of ' + ph.days + ' the same items usually make about ' + about(byNow, cur) + ' - ' +
      (Math.abs(diff) < 50 ? 'level with your usual days' : about(diff, cur) + (diff > 0 ? ' ahead of' : ' behind') + ' your usual days') + '. Built on your own usual numbers and on what was tallied.';
  }
  /** After the last day: the verdict, per deal and overall, and what to do
   *  next time. -> {text, rows: [{id, title, text, next, status}], delta} */
  function wrapUp(s) {
    var t = totals(s), cur = s.cur, days = daysBetween(s.from, s.to) + 1;
    var rows = t.rows.map(function (r) {
      var d = r.d, a = r.a, n = d.count, noun = a.noun || 'sale', title = dealTitle(s, d), text, next, status;
      var alts = alternatives(s, d).filter(function (x) { return x.k !== 'limit'; });
      if (!n) { status = 'bad'; text = 'Nobody took it.'; next = 'Next time: put the sign where people see it - or drop it.'; }
      else if (d.goal === 'clear' && d.kind !== 'spend') {
        status = 'good';
        text = 'Cleared ' + n + (a.stock !== null ? ' of ' + a.stock : '') + ': ' + money(n * a.pay, cur) + ' back against ' + money(n * a.cost, cur) + ' of stock already paid for.';
        next = a.stock !== null && n < a.stock ? 'Next time: ' + (a.stock - n) + ' still on the shelf - a deeper cut, or a bundle with something that sells.' : 'Next time: it worked - the shelf is clear.';
      } else if (a.after <= 0) {
        status = 'loss';
        text = (a.loss ? 'Cost about ' + about(n * a.loss, cur) + ' to bring people in' : 'Made nothing itself') + ' (' + plural(n, noun) + ').';
        next = 'Next time: worth it only if those baskets held other things' + (a.payback !== null ? ' - about ' + money(a.payback, cur) + ' each.' : '.');
      } else if (d.kind === 'spend') {
        status = r.made >= 0 ? 'good' : 'bad';
        text = plural(n, 'use') + ': ' + (r.made >= 0 ? 'about ' + about(r.made, cur) + ' more than without it.' : 'about ' + about(r.made, cur) + ' less than without it - it did not reach break-even (' + n + ' of ' + a.breakEven + ').');
        next = r.made >= 0 ? 'Next time: run it again.' : 'Next time: ' + (alts.length ? alts[0].label : 'a higher spend, or less off.');
      } else if (n >= a.breakEven) {
        status = 'good';
        text = 'Made about ' + about(r.delta, cur) + ' more than usual (' + plural(n, noun) + ', break-even ' + a.breakEven + ').';
        next = 'Next time: run it again as it is.';
      } else {
        status = 'bad';
        text = 'Made about ' + about(r.delta, cur) + ' less than usual - it did not reach break-even (' + n + ' of ' + a.breakEven + ').';
        next = 'Next time: ' + (alts.length ? alts[0].label : 'a smaller discount, or leave this item at full price.');
      }
      return { id: d.id, title: title, text: text, next: next, status: status, delta: r.delta, count: n };
    });
    var text;
    if (!rows.length) text = 'There were no deals in this sale.';
    else {
      var best = null, worst = null;
      rows.forEach(function (r) { if (r.status === 'good' && (!best || r.delta > best.delta)) best = r; if (r.status === 'bad' && r.count && (!worst || r.delta < worst.delta)) worst = r; });
      text = (s.title === 'Sale' ? 'The sale' : s.title) + ' made about ' + about(t.delta, cur) + (t.delta >= 0 ? ' more' : ' less') + ' than your usual ' + (days === 1 ? 'day' : days + ' days') + ' on these items';
      var bits = [];
      if (best) bits.push('“' + best.title + '” carried it');
      if (worst) bits.push('“' + worst.title + '” did not reach break-even');
      text += bits.length ? ' - ' + bits.join(', ') + '.' : '.';
    }
    return { text: text, rows: rows, delta: t.delta, made: t.made, usual: t.usual, note: 'Built on your own usual numbers and on what was tallied - sales nobody tapped are not in it.' };
  }

  /* ------------------------------------------------------------------ *
   * The one door: every change to a sale
   *
   * act(doc, mid, action, ctx) -> {set: {'dotted.key': value}, del: [...]}
   * - or it throws, with a status and a reason. The server runs it inside a
   * transaction on the current document and writes exactly what comes back;
   * the example on the page runs the same function.
   * ctx = {now, ids, today} - the clock and the new ids are handed in.
   *
   * THE OWNER alone adds, edits and removes items and deals, changes the
   * sale's details, applies or undoes an alternative, corrects stock.
   * ANYONE on the sale taps the tally: +1, and -1 to undo a tap of THEIR
   * OWN (the owner may undo any).
   * ------------------------------------------------------------------ */

  var OWNER_ONLY = 'Only the owner of this sale can change that.';
  function isOwner(doc, mid) { return own(doc.members, mid) && doc.members[mid].host === true && !doc.members[mid].left; }
  function itemOf(doc, id) {
    if (!isId(id) || !own(doc.items, id)) throw fail(404, 'That item isn’t in the sale any more.', { code: 'no-item' });
    return doc.items[id];
  }
  function dealOf(doc, id) {
    if (!isId(id) || !own(doc.deals, id)) throw fail(404, 'That deal isn’t in the sale any more.', { code: 'no-deal' });
    return doc.deals[id];
  }
  function countIn(doc, id) { return intIn(own(doc.tally, id) ? doc.tally[id] : 0, 0, LIMITS.units, 0); }
  function sameShape(a, b) { return a.kind === b.kind && JSON.stringify(a.items) === JSON.stringify(b.items) && a.n === b.n && a.m === b.m; }
  function lockShape(doc, id, prev, next) {
    if (countIn(doc, id) > 0 && !sameShape(prev, next)) throw fail(409, 'This deal has sales counted. Changing its shape would muddle the count - remove it and add a new one.', { code: 'counted' });
  }
  function act(doc, mid, a, ctx) {
    a = isObj(a) ? a : {};
    var set = {}, del = [], k = typeof a.t === 'string' ? a.t : '', d, prev, next;
    function out() { return { set: set, del: del }; }
    function owner() { if (!isOwner(doc, mid)) throw fail(403, OWNER_ONLY, { code: 'not-owner' }); }

    if (k === 'tally') {
      d = dealOf(doc, a.id);
      if (a.n !== 1 && a.n !== -1) throw fail(400, 'A tap is one sale, or one undone.');
      if (ctx.today < addDays(doc.from, -1)) throw fail(409, 'The sale hasn’t started - the tally opens on ' + dayLong(doc.from) + '.', { code: 'not-yet' });
      if (ctx.today > addDays(doc.to, 1)) throw fail(409, 'The sale is over - the tally is closed.', { code: 'over' });
      var n = countIn(doc, a.id), mine = own(doc.taps, mid) && isObj(doc.taps[mid]) ? intIn(doc.taps[mid][a.id], 0, LIMITS.units, 0) : 0;
      if (a.n === 1) {
        var s = flat(doc), room = dealById(s, a.id).room;
        if (room !== null && room < 1) throw fail(409, 'None left in stock - pull the sign. If the shelf says otherwise, the owner can correct the stock.', { code: 'no-stock' });
        if (n >= LIMITS.units) throw fail(409, 'That is as high as a tally goes.');
        set['tally.' + a.id] = n + 1; set['taps.' + mid + '.' + a.id] = mine + 1;
      } else {
        if (n < 1) throw fail(409, 'There is nothing to undo.', { code: 'zero' });
        if (mine < 1 && !isOwner(doc, mid)) throw fail(409, 'You can only undo your own taps.', { code: 'not-yours' });
        set['tally.' + a.id] = n - 1; set['taps.' + mid + '.' + a.id] = Math.max(0, mine - 1);
      }
      return out();
    }
    owner();
    if (k === 'additem' || k === 'additems') {
      var list = k === 'additem' ? [a.item] : (Array.isArray(a.items) ? a.items : []);
      if (!list.length || list.length > LIMITS.batch) throw fail(400, 'Add 1 to ' + LIMITS.batch + ' items at a time.');
      if (Object.keys(doc.items || {}).length + list.length > LIMITS.items) throw fail(409, 'A sale holds up to ' + LIMITS.items + ' items.', { code: 'full' });
      list.forEach(function (raw, i) { var it = cleanItem(raw); it.ts = ctx.now + i; set['items.' + ctx.ids[i]] = it; });
      return out();
    }
    if (k === 'edititem') {
      prev = itemOf(doc, a.id);
      next = cleanItem(a.item); next.ts = prev.ts;
      var after = clone(doc); after.items[a.id] = next;
      Object.keys(doc.deals || {}).forEach(function (did) {
        if ((doc.deals[did].items || []).indexOf(a.id) < 0) return;
        try { cleanDeal(doc.deals[did], after, doc.deals[did]); } catch (e) { throw fail(409, 'A deal on this item would no longer fit: ' + e.message + ' Change the deal first.', { code: 'deal-fit' }); }
      });
      set['items.' + a.id] = next;
      return out();
    }
    if (k === 'delitem') {
      itemOf(doc, a.id);
      if (Object.keys(doc.deals || {}).some(function (did) { return (doc.deals[did].items || []).indexOf(a.id) >= 0; })) throw fail(409, 'That item is in a deal - remove the deal first.', { code: 'in-deal' });
      del.push('items.' + a.id);
      return out();
    }
    if (k === 'stock') {
      // "There are really 9 left": the stock on hand becomes what is left
      // plus what the tally says has gone. Empty = no stock kept.
      prev = itemOf(doc, a.id);
      if (a.left === null || a.left === undefined || a.left === '') { set['items.' + a.id + '.stock'] = null; return out(); }
      if (!isCents(a.left, 0, LIMITS.units)) throw fail(400, 'What is left is a whole number - or leave it empty.');
      var it0 = itemById(flat(doc), a.id);
      set['items.' + a.id + '.stock'] = Math.min(LIMITS.units, a.left + it0.sold);
      return out();
    }
    if (k === 'adddeal') {
      if (Object.keys(doc.deals || {}).length >= LIMITS.deals) throw fail(409, 'A sale holds up to ' + LIMITS.deals + ' deals.', { code: 'full' });
      d = cleanDeal(a.deal, doc, null); d.ts = ctx.now;
      set['deals.' + ctx.ids[0]] = d;
      return out();
    }
    if (k === 'editdeal' || k === 'set' || k === 'alt' || k === 'undo') {
      prev = dealOf(doc, a.id);
      if (k === 'editdeal') { next = cleanDeal(a.deal, doc, prev); }
      else if (k === 'set') {
        var b = plain(prev);
        if (a.k === 'goal') { if (GOALS.indexOf(a.v) < 0) throw fail(400, 'Pick what the deal is for.'); b.goal = a.v; }
        else if (a.k === 'was') b.was = a.v === true;
        else if (a.k === 'wsl') b.wsl = a.v === true;
        else if (a.k === 'limit') b.limit = a.v;
        else if (a.k === 'end') { if (a.v !== '' && ENDS.indexOf(a.v) < 0) throw fail(400, 'Round to .99, .00 or .50.'); if (prev.kind !== 'pct' && prev.kind !== 'amount') throw fail(400, 'Only a percent or an amount off has a price to round.'); b.end = a.v; }
        else throw fail(400, 'That is not something to set.');
        next = cleanDeal(b, doc, prev);
        if (a.k === 'end' && a.v !== '' && next.end !== a.v) throw fail(400, 'That ending doesn’t fit this price.');
      } else if (k === 'alt') {
        var sNow = flat(doc), list2 = alternatives(sNow, dealById(sNow, a.id)), pick = isCents(a.n, 0, 2) ? list2[a.n] : null;
        if (!pick || (typeof a.k === 'string' && pick.k !== a.k)) throw fail(409, 'That suggestion has changed - look again.', { code: 'stale' });
        next = cleanDeal(pick.deal, doc, prev);
        next.undo = isObj(prev.undo) ? clone(prev.undo) : plain(prev);
        next.alt = line(pick.label, 200);
      } else {
        if (!isObj(prev.undo)) throw fail(409, 'There is nothing to undo on this deal.', { code: 'no-undo' });
        try { next = cleanDeal(prev.undo, doc, prev); } catch (e) { throw fail(409, 'It can’t go back: ' + e.message, { code: 'no-undo' }); }
        next.goal = GOALS.indexOf(prev.undo.goal) >= 0 ? prev.undo.goal : next.goal;
      }
      lockShape(doc, a.id, prev, next);
      next.ts = prev.ts;
      // An edit by hand keeps nothing to undo; a tap on goal, "was", a
      // limit or an ending keeps what an alternative left to undo.
      if (k === 'set' && isObj(prev.undo)) { next.undo = clone(prev.undo); next.alt = line(prev.alt, 200); }
      set['deals.' + a.id] = next;
      return out();
    }
    if (k === 'deldeal') {
      dealOf(doc, a.id);
      del.push('deals.' + a.id);
      if (own(doc.tally, a.id)) del.push('tally.' + a.id);
      Object.keys(doc.taps || {}).forEach(function (m) { if (own(doc.taps[m], a.id)) del.push('taps.' + m + '.' + a.id); });
      return out();
    }
    if (k === 'details') {
      var g = cleanSale({ shop: a.shop, title: a.title, from: a.from, to: a.to, cur: a.cur, margin: a.margin }, ctx.today < doc.from ? ctx.today : doc.from);
      return { set: { shop: g.shop, title: g.title, from: g.from, to: g.to, cur: g.cur, margin: g.margin }, del: del };
    }
    throw fail(400, 'That is not something Doorbuster does.');
  }
  /** A change applied to a copy (the example on the page; the tests). */
  function patch(doc, change) {
    var out = clone(doc);
    function walk(key, fn) { var parts = key.split('.'), at = out; for (var i = 0; i < parts.length - 1; i++) { if (!isObj(at[parts[i]])) at[parts[i]] = {}; at = at[parts[i]]; } fn(at, parts[parts.length - 1]); }
    Object.keys(change.set || {}).forEach(function (k) { walk(k, function (o, last) { o[last] = clone(change.set[k]); }); });
    (change.del || []).forEach(function (k) { walk(k, function (o, last) { delete o[last]; }); });
    out.v = (out.v || 0) + 1;
    return out;
  }
  /** A sale is deleted keepDays after its last day. */
  function expired(doc, today) { return !isDay(doc.to) || today > addDays(doc.to, LIMITS.keepDays); }

  /* ------------------------------------------------------------------ *
   * What one phone is shown
   *
   * THE OWNER: everything but key hashes and account tags.
   * STAFF: the deals, the prices, the tally and the stock - and NOTHING
   * that says what the shop pays or makes: no unit cost, no usual sales, no
   * usual margin, no baskets, no goal, no alternative's wording. It is
   * filtered HERE, on the server; a staff phone cannot work out a
   * break-even from what it is sent.
   * ------------------------------------------------------------------ */

  function memberIds(doc) {
    return Object.keys(doc.members || {}).sort(function (a, b) { var x = doc.members[a].joinedAt || '', y = doc.members[b].joinedAt || ''; return x < y ? -1 : x > y ? 1 : (a < b ? -1 : 1); });
  }
  function view(doc, mid) {
    var s = flat(doc), boss = isOwner(doc, mid);
    var members = memberIds(doc).map(function (id) { var m = doc.members[id]; return { id: id, name: m.name, c: m.c || 0, host: Boolean(m.host), left: Boolean(m.left), me: id === mid }; });
    var taps = own(doc.taps, mid) && isObj(doc.taps[mid]) ? doc.taps[mid] : {};
    var v = { id: doc.id, code: doc.code, shop: s.shop, title: s.title, from: s.from, to: s.to, cur: s.cur, v: doc.v || 0, me: mid, owner: boss, members: members, keptUntil: addDays(s.to, LIMITS.keepDays) };
    if (boss) v.margin = s.margin;
    v.items = s.items.map(function (it) {
      var x = { id: it.id, name: it.name, price: it.price, stock: it.stock, sold: it.sold, left: it.left };
      if (boss) { x.cost = it.cost; x.base = it.base; }
      return x;
    });
    v.deals = s.deals.map(function (d) {
      var x = { id: d.id, kind: d.kind, items: d.items, pct: d.pct, off: d.off, n: d.n, m: d.m, mpct: d.mpct, price: d.price, spend: d.spend, save: d.save, limit: d.limit, wsl: d.wsl, was: d.was, end: d.end, count: d.count, room: d.room, mine: intIn(taps[d.id], 0, LIMITS.units, 0) };
      if (boss) { x.basket = d.basket; x.baskets = d.baskets; x.clear = d.clear; x.goal = d.goal; x.undo = d.undo; x.alt = d.alt; }
      return x;
    });
    return v;
  }
  function memberOf(v, mid) { for (var i = 0; i < v.members.length; i++) if (v.members[i].id === mid) return v.members[i]; return null; }
  /** One line about an item. The owner's has the cost; staff's cannot. */
  function itemLine(it, cur) {
    var bits = [money(it.price, cur)];
    if (own(it, 'cost')) { bits.push('costs you ' + money(it.cost, cur)); bits.push('usually ' + it.base); }
    if (it.left !== null) bits.push(it.left + ' left');
    return bits.join(' · ');
  }
  /** Draft items read from a price list: every field bounded, a name with
   *  an @, a link, a long number or markup dropped. Never throws.
   *  -> [{name, price (cents or null), cost (cents or null)}] */
  function cleanDrafts(list) {
    var out = [];
    (Array.isArray(list) ? list : []).slice(0, 60).forEach(function (r) {
      if (out.length >= LIMITS.drafts || !isObj(r)) return;
      var name = refuse(r.name) ? '' : line(r.name, LIMITS.item);
      if (!/\p{L}/u.test(name)) return;
      function c(v) { var n = typeof v === 'number' && isFinite(v) ? Math.round(v * 100) : null; return n !== null && n >= 1 && n <= LIMITS.price ? n : null; }
      out.push({ name: name, price: c(r.price), cost: c(r.cost) });
    });
    return out;
  }

  return {
    LIMITS: LIMITS, CURRENCIES: CURRENCIES, KINDS: KINDS, KIND_NAMES: KIND_NAMES, GOALS: GOALS, GOAL_NAMES: GOAL_NAMES, ENDS: ENDS, GOOD_X10: GOOD_X10, TIGHT_X10: TIGHT_X10, SMALL_PCT: SMALL_PCT, ESTIMATE: ESTIMATE, WAS_RULE: WAS_RULE, MODEL: MODEL, MULTIS: MULTIS,
    fail: fail, own: own, isObj: isObj, clone: clone,
    str: str, line: line, esc: esc, norm: norm, cleanName: cleanName, refuse: refuse, field: field, plural: plural, listNames: listNames, initials: initials,
    newId: newId, isId: isId, CODE_ALPHABET: CODE_ALPHABET, CODE_LEN: CODE_LEN, normalizeCode: normalizeCode, isCode: isCode, formatCode: formatCode, isGid: isGid, COLORS: COLORS,
    isDay: isDay, addDays: addDays, daysBetween: daysBetween, weekday: weekday, dayLong: dayLong, dateRange: dateRange, utcDay: utcDay,
    intIn: intIn, isCents: isCents, parseMoney: parseMoney, money: money, moneyShort: moneyShort, about: about, moneyField: moneyField, pctOff: pctOff, toEnding: toEnding, times: times, ceilDiv: ceilDiv,
    cleanSale: cleanSale, cleanItem: cleanItem, cleanDeal: cleanDeal, cleanDrafts: cleanDrafts,
    flat: flat, unitsOf: unitsOf, roomOf: roomOf, itemById: itemById, dealById: dealById,
    multiHead: multiHead, offer: offer, dealTitle: dealTitle, dealShort: dealShort, countOf: countOf, overlaps: overlaps,
    analyse: analyse, madeAt: madeAt, score: score, judge: judge, flagsFor: flagsFor, endings: endings, report: report,
    multiPct: multiPct, fifthLess: fifthLess, plain: plain, alternatives: alternatives,
    sign: sign, phase: phase, progress: progress, totals: totals, paceLine: paceLine, wrapUp: wrapUp,
    isOwner: isOwner, act: act, patch: patch, expired: expired,
    memberIds: memberIds, view: view, memberOf: memberOf, itemLine: itemLine,
  };
});
