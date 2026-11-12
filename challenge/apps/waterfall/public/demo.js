/* Waterfall - the example. A MADE-UP company, Brightwell Analytics, that
 * sells a made-up analytics product by subscription, and its made-up
 * billing export: 120 invented customers, 14 months of invoices
 * (September 2025 to October 2026, plus the first ten days of November -
 * the export ran on 10 Nov 2026), in a Stripe-shaped invoice line-item
 * layout invented for this demo. Every customer name is an invented
 * compound word, every id says DEMO, and the file is called EXAMPLE-...
 *
 * What is in it, and planted on purpose (the tests hold each one):
 *   - monthly plans (Starter $49, Team $199, Business $599) billed on each
 *     customer's own day of the month, so periods cross month ends;
 *   - 14 annual plans (Team, Business, Enterprise) - exactly THREE billed in
 *     October 2026: Quorvane Robotics and Glimmerford Media renewing
 *     Business, and Saltmoth Logistics starting Enterprise;
 *   - usage overages billed in arrears (each invoice carries the API calls
 *     over the plan for the period just ended);
 *   - four mid-cycle upgrades, Team to Business, with the two proration
 *     lines Stripe writes ("Unused time on Team after ...", "Remaining time
 *     on Business after ...") - one on 12 Oct 2026;
 *   - onboarding and implementation fees ($2,500, no service period) -
 *     Brightwell's accountant spreads them over 12 months (the example's
 *     one rule);
 *   - a service credit of $150 on Tumblewick Freight's October invoice;
 *   - a void invoice: Brimbleton Clinic's October invoice, issued twice;
 *   - an uncollectible one: Ottercap Dental's August quarterly invoice;
 *   - 12 customers billed in EUR beside USD; sales tax on some lines, VAT
 *     on the EUR ones; a launch discount (20% off three invoices) for some
 *     new customers.
 *
 * And the month-end question it answers: for October 2026, the billing
 * dashboard said BILLINGS (it counts amounts before discounts, counts the
 * void invoice, and converts EUR at 1.08), the ledger said REVENUE and
 * DEFERRED (the bookkeeper books onboarding fees when billed, takes the
 * uncollectible invoice's October revenue off, keeps unbilled usage in its
 * own account and converts EUR at 1.08). Waterfall's buckets explain every
 * gap to the cent.
 *
 * No clock, no dice (a seeded generator), no network, no storage.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WaterfallDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COMPANY = 'Brightwell Analytics';
  var FILE = 'EXAMPLE-brightwell-invoice-lines.csv';
  var HEAD = ['Invoice Line Item ID', 'Invoice ID', 'Invoice Date (UTC)', 'Invoice Status', 'Customer ID', 'Customer Name', 'Description', 'Product', 'Type', 'Proration', 'Period Start (UTC)', 'Period End (UTC)', 'Currency', 'Amount', 'Discount Amount', 'Tax Amount'];

  /** The example's one rule (the rest are Waterfall's defaults). */
  var RULES = [{ d: 'Onboarding and implementation', r: 'months', n: 12 }];

  /** What the October 2026 close typed in (cents, USD). */
  var RECON = {
    month: '2026-10', ccy: 'USD', kind: 'billings', fx: { EUR: '1.08' },
    dashboard: 7004346,
    ledgerRevenue: 4124375,
    ledgerDeferred: 7727126,
    reading: { disc: true, tax: false, void: true, uncoll: false },
    ledgerPick: ['when:onetime', 'uncollectible', 'fx:EUR'],
    deferredPick: ['notdeferred:onetime', 'unbilled', 'fx:EUR'],
  };

  /* ---------------- a seeded generator ---------------- */

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- days (UTC day numbers) ---------------- */

  function fromCivil(y, m, d) {
    y -= m <= 2 ? 1 : 0;
    var era = Math.floor(y / 400), yoe = y - era * 400;
    var doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
  }
  function toCivil(z) {
    z += 719468;
    var era = Math.floor(z / 146097), doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp < 10 ? mp + 3 : mp - 9;
    return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
  }
  function D(y, m, d) { return fromCivil(y, m, d); }
  function addMonths(day, n) {
    var c = toCivil(day), t = c[0] * 12 + (c[1] - 1) + n, y = Math.floor(t / 12), m = (t % 12) + 1;
    var dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    return fromCivil(y, m, Math.min(c[2], dim));
  }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  function stamp(day) { var c = toCivil(day); return c[0] + '-' + pad(c[1], 2) + '-' + pad(c[2], 2) + ' 00:00:00'; }
  var SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function nice(day) { var c = toCivil(day); return c[2] + ' ' + SHORT[c[1] - 1] + ' ' + c[0]; }
  function monthName(day) { var c = toCivil(day); return SHORT[c[1] - 1] + ' ' + c[0]; }
  function amount(cents) { var a = Math.abs(cents); return (cents < 0 ? '-' : '') + Math.floor(a / 100) + '.' + pad(a % 100, 2); }
  function grouped(cents) { var a = Math.abs(cents); return (cents < 0 ? '-' : '') + String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + pad(a % 100, 2); }

  var START = D(2025, 9, 1), END = D(2026, 11, 10), OCT = D(2026, 10, 1), NOV = D(2026, 11, 1);

  /* ---------------- the price list ---------------- */

  var PLAN = {
    Starter: { usd: 4900, eur: 4500, months: 1 },
    Team: { usd: 19900, eur: 18500, months: 1 },
    Business: { usd: 59900, months: 1 },
    'Team (annual)': { usd: 199000, months: 12 },
    'Business (annual)': { usd: 599000, months: 12 },
    'Enterprise (annual)': { usd: 2400000, months: 12 },
    'Team (quarterly)': { usd: 57000, months: 3 },
  };
  var ONBOARDING = 250000;

  /* ---------------- 120 invented customers ---------------- */

  var FIRST = ['Quorvane', 'Zephlin', 'Tumblewick', 'Snorrelby', 'Vexmoor', 'Ottercap', 'Glimmerford', 'Saltmoth', 'Brimbleton', 'Puddlewick', 'Larkspindle', 'Cinderwhistle', 'Mossbright', 'Thimblecrest', 'Fennelwhip', 'Wobblestone', 'Pickleharbor', 'Dapplequill', 'Crumbleforth', 'Nimbleroot', 'Bramblefizz', 'Kettlewisp', 'Lumbergast', 'Quibbleton', 'Sprocketmoor', 'Teacupvale', 'Umberwhisk', 'Velvetgrub', 'Wafflecrag', 'Yarrowpip'];
  var SECOND = ['Labs', 'Freight', 'Studio', 'Outfitters', 'Dental', 'Bakery Co', 'Robotics', 'Brokers', 'Logistics', 'Clinic', 'Media', 'Supply'];

  function customers() {
    var r = rng(20261111), used = {}, list = [];
    function take(name) { used[name] = 1; return name; }
    // The planted customers' first words are theirs alone, so no invented
    // name reads like one of them.
    var RESERVED = ['Quorvane', 'Glimmerford', 'Saltmoth', 'Ottercap', 'Tumblewick', 'Brimbleton', 'Larkspindle', 'Pickleharbor', 'Fennelwhip', 'Nimbleroot'];
    var POOL = FIRST.filter(function (w) { return RESERVED.indexOf(w) < 0; });
    function fresh() {
      for (;;) {
        var n = POOL[Math.floor(r() * POOL.length)] + ' ' + SECOND[Math.floor(r() * SECOND.length)];
        if (!used[n]) return take(n);
      }
    }
    function add(o) { o.id = 'cus_DEMO' + pad(list.length + 1, 4); list.push(o); return o; }
    // The planted ones first.
    add({ name: take('Quorvane Robotics'), ccy: 'usd', plan: 'Business (annual)', start: D(2025, 10, 7), tax: 725 });
    add({ name: take('Glimmerford Media'), ccy: 'usd', plan: 'Business (annual)', start: D(2025, 10, 21), tax: 0 });
    add({ name: take('Saltmoth Logistics'), ccy: 'usd', plan: 'Enterprise (annual)', start: D(2026, 10, 12), tax: 0, onboarding: true });
    add({ name: take('Ottercap Dental'), ccy: 'usd', plan: 'Team (quarterly)', start: D(2025, 11, 20), tax: 0, stopAfter: D(2026, 8, 20), uncollectible: D(2026, 8, 20) });
    add({ name: take('Tumblewick Freight'), ccy: 'usd', plan: 'Business', start: D(2025, 3, 5), tax: 725, usage: true, credit: true });
    add({ name: take('Brimbleton Clinic'), ccy: 'usd', plan: 'Business', start: D(2025, 2, 9), tax: 0, voidDup: true });
    add({ name: take('Larkspindle Studio'), ccy: 'usd', plan: 'Team', start: D(2025, 1, 3), tax: 0, upgrade: D(2026, 2, 10) });
    add({ name: take('Pickleharbor Outfitters'), ccy: 'usd', plan: 'Team', start: D(2025, 4, 14), tax: 725, upgrade: D(2026, 5, 18) });
    add({ name: take('Fennelwhip Brokers'), ccy: 'usd', plan: 'Team', start: D(2025, 6, 22), tax: 0, upgrade: D(2026, 8, 7), usage: true });
    add({ name: take('Nimbleroot Labs'), ccy: 'usd', plan: 'Team', start: D(2025, 7, 1), tax: 0, upgrade: D(2026, 10, 12), usage: true });
    // The other eleven annual plans: none billed in October 2026.
    [[2025, 9, 4, 'Team (annual)'], [2025, 9, 16, 'Business (annual)'], [2025, 11, 3, 'Team (annual)'], [2025, 12, 15, 'Business (annual)'], [2026, 1, 8, 'Enterprise (annual)'],
      [2026, 2, 19, 'Team (annual)'], [2026, 3, 2, 'Business (annual)'], [2026, 4, 27, 'Team (annual)'], [2026, 5, 11, 'Business (annual)'], [2026, 6, 23, 'Enterprise (annual)'], [2026, 8, 17, 'Team (annual)']]
      .forEach(function (x) { add({ name: fresh(), ccy: 'usd', plan: x[3], start: D(x[0], x[1], x[2]), tax: r() < 0.3 ? 725 : 0, onboarding: x[3] === 'Enterprise (annual)' }); });
    // Twelve in EUR, monthly.
    for (var e = 0; e < 12; e++) {
      var existing = e < 6, anchor = 1 + Math.floor(r() * 28);
      var st = existing ? D(2025, 1 + Math.floor(r() * 8), anchor) : addMonths(D(2025, 9, anchor), Math.floor(r() * 13));
      add({ name: fresh(), ccy: 'eur', plan: r() < 0.5 ? 'Starter' : 'Team', start: st, tax: 2000, churn: r() < 0.15 ? addMonths(st, 4 + Math.floor(r() * 8)) : null });
    }
    // The rest in USD, monthly, until there are 120.
    while (list.length < 120) {
      var old = r() < 0.48, a2 = 1 + Math.floor(r() * 28), x = r();
      var plan = x < 0.45 ? 'Starter' : x < 0.8 ? 'Team' : 'Business';
      var s2 = old ? D(2025, 1 + Math.floor(r() * 8), a2) : addMonths(D(2025, 9, a2), Math.floor(r() * 14));
      var isNew = !old;
      add({
        name: fresh(), ccy: 'usd', plan: plan, start: s2, tax: r() < 0.3 ? 725 : 0,
        usage: plan !== 'Starter' && r() < 0.5,
        onboarding: isNew && plan === 'Business' && r() < 0.6,
        launch: isNew && s2 >= D(2026, 6, 1) && r() < 0.5 ? 3 : 0,
        churn: r() < 0.1 ? addMonths(s2, 3 + Math.floor(r() * 10)) : null,
      });
    }
    return list;
  }

  /* ---------------- the invoices ---------------- */

  function rows() {
    var r = rng(4242), out = [], invN = 0, lineN = 0;
    function taxOf(c, cents) { return c.tax ? Math.round(cents * c.tax / 10000) : 0; }
    function invoice(c, day, lines, status) {
      var id = 'in_DEMO' + pad(10001 + invN++, 5);
      var st = status || (day >= D(2026, 10, 20) && r() < 0.6 ? 'open' : 'paid');
      lines.forEach(function (l) {
        var net = l.amount - (l.discount || 0);
        out.push({
          lid: 'il_DEMO' + pad(++lineN, 6), inv: id, day: day, status: st, cid: c.id, name: c.name, desc: l.desc, product: l.product, type: l.type, proration: Boolean(l.proration),
          s: l.s === undefined ? null : l.s, e: l.e === undefined ? null : l.e, ccy: c.ccy, amount: l.amount, discount: l.discount || 0, tax: taxOf(c, net),
        });
      });
      return id;
    }
    function price(c, plan) { return PLAN[plan][c.ccy]; }
    function sym(c) { return c.ccy === 'eur' ? '€' : '$'; }
    function planLine(c, plan, s, e) {
      var p = price(c, plan), monthsN = PLAN[plan].months;
      var per = monthsN === 12 ? 'year' : monthsN === 3 ? '3 months' : 'month';
      var disc = c.launch > 0 && monthsN === 1 ? Math.round(p * 0.2) : 0;
      if (disc) c.launch--;
      return { desc: '1 × ' + plan + ' (at ' + sym(c) + grouped(p) + ' / ' + per + ')', product: plan, type: 'subscription', s: s, e: e, amount: p, discount: disc };
    }
    function usageLine(c, s, e) {
      var units = 3 + Math.floor(r() * 220);
      return { desc: 'API calls overage - ' + monthName(s) + ' (' + units + ' × 1,000 calls)', product: 'API calls overage', type: 'subscription', s: s, e: e, amount: units * 400 };
    }
    customers().forEach(function (c) {
      var months = PLAN[c.plan].months;
      var d = c.start;
      if (d < START) { while (d < START) d = addMonths(d, months); }
      var first = true, plan = c.plan;
      while (d <= END && (!c.churn || d < c.churn) && (!c.stopAfter || d <= c.stopAfter)) {
        var next = addMonths(d, months);
        if (c.upgrade && c.upgrade < d) plan = 'Business';
        var lines = [planLine(c, plan, d, next)];
        if (c.usage) lines.push(usageLine(c, addMonths(d, -1), d));
        if (first && c.onboarding && c.start >= START) lines.push({ desc: 'Onboarding and implementation', product: 'Onboarding and implementation', type: 'invoiceitem', amount: ONBOARDING });
        if (c.credit && d >= OCT && d < NOV) lines.push({ desc: 'Service credit - September outage', product: 'Service credit', type: 'invoiceitem', amount: -15000 });
        invoice(c, d, lines, c.uncollectible === d ? 'uncollectible' : null);
        if (c.voidDup && d >= OCT && d < NOV) invoice(c, d, lines.map(function (l) { return Object.assign({}, l); }), 'void');
        if (c.upgrade && c.upgrade > d && c.upgrade < next) {
          var frac = (next - c.upgrade) / (next - d);
          invoice(c, c.upgrade, [
            { desc: 'Unused time on Team after ' + nice(c.upgrade), product: 'Team', type: 'subscription', proration: true, s: c.upgrade, e: next, amount: -Math.round(price(c, 'Team') * frac) },
            { desc: 'Remaining time on Business after ' + nice(c.upgrade), product: 'Business', type: 'subscription', proration: true, s: c.upgrade, e: next, amount: Math.round(PLAN.Business.usd * frac) },
          ]);
        }
        first = false;
        d = next;
      }
    });
    out.sort(function (a, b) { return a.day - b.day || (a.inv < b.inv ? -1 : a.inv > b.inv ? 1 : 0) || (a.lid < b.lid ? -1 : 1); });
    return out;
  }

  function cell(v) { var s = String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  /** The export, as the billing system would have written it. */
  function csv() {
    var lines = [HEAD.map(cell).join(',')];
    rows().forEach(function (x) {
      lines.push([x.lid, x.inv, stamp(x.day), x.status, x.cid, x.name, x.desc, x.product, x.type, x.proration ? 'true' : 'false',
        x.s === null ? '' : stamp(x.s), x.e === null ? '' : stamp(x.e), x.ccy, amount(x.amount), amount(x.discount), amount(x.tax)].map(cell).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  return { COMPANY: COMPANY, FILE: FILE, HEAD: HEAD, RULES: RULES, RECON: RECON, customers: customers, rows: rows, csv: csv };
}));
