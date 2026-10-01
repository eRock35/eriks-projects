/* Drip - the example statement, for "Alex". Made up from start to finish:
 * every merchant name is invented (none is a real brand), and the numbers
 * are fixed by a seeded generator, so the example reads the same on every
 * phone and in the tests.
 *
 * It is a year of one credit card, in the shape a bank's "Download -> CSV"
 * gives you (purchases negative, payments positive), dated relative to
 * today so the story always lands: 14 drips (one that raised its price
 * twice, a $1 trial that turned paid, two music apps, a weekly paper, a
 * quarterly plan, a yearly plan renewing in three weeks), one that went
 * quiet, and ordinary spending - groceries, coffee, gas, takeout, a florist,
 * a refund, card payments and an interest charge - that must NOT be read as
 * a subscription.
 *
 * A year rather than a few months, because the yearly renewal is the drip
 * people forget most, and a shorter statement cannot show one.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./drip-core'));
  else root.DripSample = factory(root.DripCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var WHO = 'Alex';
  var FILE = 'example-card-alex.csv';

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function usDate(iso) { return iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4); }
  function amount(cents) { var s = (Math.abs(cents) / 100).toFixed(2); return cents < 0 ? '-' + s : s; }

  /** The example rows, oldest first: {date, desc, cents (spend), cat, type}. */
  function rows(today) {
    var R = rng(20261001);
    var pick = function (arr) { return arr[Math.floor(R() * arr.length)]; };
    var between = function (lo, hi) { return lo + Math.floor(R() * (hi - lo + 1)); };
    var end = C.addDays(today, -1);
    var start = C.addDays(today, -364);
    var out = [];
    var add = function (date, desc, cents, cat, type) { if (date >= start && date <= end) out.push({ date: date, desc: desc, cents: cents, cat: cat, type: type || (cents >= 0 ? 'Sale' : 'Payment') }); };
    var monthly = function (desc, firstDay, months, price, cat, everyN) {
      var step = everyN || 1;
      for (var i = 0; i < months; i++) {
        var d = C.addDays(C.addMonths(firstDay, i * step), between(0, 2));
        add(d, desc, typeof price === 'function' ? price(i) : price, cat);
      }
    };

    // The drips.
    monthly('Streamio.com*AB12CD 888-555-0134 CA', C.addDays(start, 4), 12, function (i) { return i < 4 ? 1399 : i < 8 ? 1549 : 1799; }, 'Entertainment');
    var trial = C.addDays(C.addMonths(end, -3), -3);
    add(trial, 'FlickHub.tv 844-555-0199', 100, 'Entertainment');
    monthly('FlickHub.tv 844-555-0199', C.addDays(trial, 30), 4, 1299, 'Entertainment');
    monthly('PAYPAL *TuneBox', C.addDays(start, 13), 12, 1099, 'Entertainment');
    monthly('Melodia Music 0423 New York NY', C.addMonths(C.addDays(start, 20), 5), 7, 1199, 'Entertainment');
    monthly('CloudVault Storage', C.addDays(start, 2), 12, 299, 'Bills & Utilities');
    monthly('FitNest Gym #0217', C.addDays(start, 0), 12, 3999, 'Health & Wellness');
    monthly('Munchr Plus*M8K2', C.addDays(start, 9), 12, 999, 'Food & Drink');
    monthly('PixelPass *Games', C.addDays(start, 17), 12, 999, 'Entertainment');
    monthly('Brightline Mobile Bill', C.addDays(start, 24), 12, 4500, 'Bills & Utilities');
    monthly('HomeGuard Renters Ins 7781A', C.addDays(start, 6), 12, 1425, 'Bills & Utilities');
    monthly('ShieldVPN.net', C.addDays(start, 11), 12, 1199, 'Shopping');
    monthly('Notely Pro*QTR', C.addDays(start, 40), 4, 2400, 'Shopping', 3);
    monthly('Sparkr*Gold Dating', C.addDays(start, 8), 7, 1999, 'Entertainment');
    add(C.addMonths(C.addDays(today, 20), -12), 'LingoOwl*Annual Plan', 7999, 'Education');
    for (var w = C.addDays(start, 1); w <= end; w = C.addDays(w, 7)) add(C.addDays(w, R() < 0.3 ? 1 : 0), 'The Daily Ledger Digital', 350, 'Shopping');

    // Ordinary life - none of this is a drip.
    for (var g = C.addDays(start, 3); g <= end; g = C.addDays(g, between(5, 9))) add(g, 'Greenleaf Market #112 Springfield IL', between(3800, 14200), 'Groceries');
    for (var c = C.addDays(start, 1); c <= end; c = C.addDays(c, between(1, 4))) add(c, 'SQ *Corner Bean Coffee', pick([475, 475, 475, 525, 610, 395]), 'Food & Drink');
    for (var f = C.addDays(start, 6); f <= end; f = C.addDays(f, between(9, 19))) add(f, 'Fuelstop 0412', between(2900, 5600), 'Gas');
    for (var t = C.addDays(start, 10); t <= end; t = C.addDays(t, between(12, 30))) add(t, 'TST* Luna Tacos', between(1350, 3800), 'Food & Drink');
    for (var o = C.addDays(start, 15); o <= end; o = C.addDays(o, between(28, 34))) add(o, 'Thai Orchid', between(3600, 6200), 'Food & Drink');
    for (var s = C.addDays(start, 30); s <= end; s = C.addDays(s, between(40, 80))) add(s, 'Starlight Cinemas', pick([2850, 3125, 1675]), 'Entertainment');
    add(C.addDays(start, 52), 'Hardware Haven', 6418, 'Home');
    add(C.addDays(start, 190), 'Hardware Haven', 2299, 'Home');
    add(C.addDays(start, 195), 'Hardware Haven', -2299, 'Home', 'Return');
    add(C.addDays(start, 120), 'Bookworm & Co', 2499, 'Shopping');
    add(C.addDays(start, 300), 'Petal & Stem Florist', 5800, 'Gifts & Donations');
    add(C.addDays(start, 233), 'Purchase Interest Charge', 1243, 'Fees & Adjustments', 'Fee');
    for (var p = C.addDays(start, 21); p <= end; p = C.addMonths(p, 1)) add(p, 'Payment Thank You - Web', -between(90000, 160000), '', 'Payment');

    out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return out;
  }

  /** The CSV text, newest first like a real download. */
  function csv(today) {
    var lines = ['Transaction Date,Post Date,Description,Category,Type,Amount,Memo'];
    rows(today).slice().reverse().forEach(function (r) {
      var post = C.addDays(r.date, 1);
      var desc = /[",]/.test(r.desc) ? '"' + r.desc.replace(/"/g, '""') + '"' : r.desc;
      lines.push([usDate(r.date), usDate(post), desc, r.cat, r.type, amount(-r.cents), ''].join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  function files(today) { return [{ name: FILE, text: csv(today) }]; }

  return { WHO: WHO, FILE: FILE, rows: rows, csv: csv, files: files };
}));
