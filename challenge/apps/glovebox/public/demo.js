/* The example garage: two cars with real-looking histories, every date
 * worked out from TODAY (in the viewer's time zone) so the story is the
 * same whenever it is opened:
 *
 *   "The family SUV" - a 2018 Honda CR-V bought used three years ago at
 *   12,000 miles, driven about 1,000 miles a month, with a full log: oil
 *   changes, rotations, new tyres, a battery, brakes and brake fluid,
 *   filters, wipers, an inspection - and the renewals dated. Its tyre
 *   rotation is OVERDUE (about 1,400 miles past), its oil change is DUE
 *   SOON (about three weeks, ≈ 600 miles), and brake fluid, wipers and the
 *   registration are coming up. Everything else is all good.
 *
 *   "The runaround" - a 2012 Ford Fiesta bought eight months ago with no
 *   paperwork: one oil change logged, two odometer readings (the last six
 *   weeks old, so it asks for a new one), timing belt or chain unknown, no
 *   inspection date yet. Sparse, the way most people's records start.
 *
 * Every car goes through GloveboxCore.cleanCar, like a typed one. The board,
 * the pace, the costs, the report and the calendar are the app's own sums
 * over this, never written by hand. Played with on this phone only: taps
 * work and are never saved. UMD: window.GloveboxDemo, require() in tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./glovebox-core'));
  else root.GloveboxDemo = factory(root.GloveboxCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  // Costs are written in dollars; a few currencies are scaled so the
  // example doesn't show a ¥94 oil change.
  const SCALE = { JPY: 150, INR: 85, SEK: 10, NOK: 10, DKK: 7, MXN: 18, ZAR: 18, BRL: 5, PLN: 4, HKD: 8 };

  const SUV_PACE = 53;            // km a day, about 1,000 miles a month
  const SUV_START = 1095;         // bought three years ago
  const SUV_START_KM = 19312;     // at 12,000 miles
  // [days ago, items, other work, cost in dollars, shop, note]
  const SUV_LOG = [
    [1090, [], 'Pre-purchase inspection', 120, 'Mile High Motors', 'All fine - bought it the next day.'],
    [1080, ['oil', 'cabin', 'rotate'], '', 94, 'QuickLube on Main', ''],
    [1000, ['coolant'], '', 129, 'Corner Garage', 'Coolant flush - the old stuff looked brown.'],
    [900, ['rotate'], '', 25, 'Tyre Town', ''],
    [790, ['tyres', 'rotate'], '', 684, 'Tyre Town', 'Four new all-seasons.'],
    [730, ['battery'], '', 189, 'Corner Garage', 'Wouldn’t start on a frosty morning - new battery.'],
    [715, ['oil', 'cabin'], '', 89, 'QuickLube on Main', ''],
    [670, ['brakefluid', 'brakes'], '', 110, 'Corner Garage', ''],
    [560, ['wipers'], '', 34, '', 'Did it myself.'],
    [470, ['oil', 'rotate', 'battery'], '', 99, 'QuickLube on Main', 'Battery tested fine.'],
    [395, ['airfilter', 'cabin'], '', 62, 'Corner Garage', ''],
    [300, ['wipers'], '', 38, '', ''],
    [230, ['rotate'], '', 25, 'Tyre Town', ''],
    [215, ['inspection'], '', 35, 'State inspection station', 'Passed.'],
    [207, ['oil', 'cabin', 'battery'], '', 95, 'QuickLube on Main', ''],
    [150, ['brakes'], 'Front brake pads', 320, 'Corner Garage', 'Squealing - front pads were down to 3 mm.'],
  ];

  const HATCH_PACE = 32;          // km a day, about 600 miles a month
  const HATCH_ADDED = 240;
  const HATCH_START_KM = 98571;   // 61,250 miles

  function suv(today, cur) {
    const k = SCALE[cur] || 1;
    const kmAgo = (n) => Math.round((SUV_START_KM + SUV_PACE * (SUV_START - n)) * 100) / 100;
    const readings = [];
    for (let n = 6; n <= SUV_START; n += 30) readings.push({ d: C.addDays(today, -n), km: kmAgo(n) });
    readings.push({ d: C.addDays(today, -SUV_START), km: SUV_START_KM });
    const services = SUV_LOG.map((r, i) => ({
      id: 'sxsuv' + String(i).padStart(4, '0'), d: C.addDays(today, -r[0]), km: kmAgo(r[0]), items: r[1], other: r[2],
      cost: Math.round(r[3] * k * 100) / 100, cur, shop: r[4], note: r[5],
    }));
    return C.cleanCar({
      id: 'cxdemosuv1', nick: 'The family SUV', make: 'Honda', model: 'CR-V', year: 2018, fuel: 'petrol', belt: 'chain',
      added: C.addDays(today, -SUV_START), readings, services,
      base: { d: C.addDays(today, -SUV_START), km: SUV_START_KM, how: 'known' },
      dates: { registration: C.addDays(today, 75), insurance: C.addDays(today, 200) },
    }, { today, currency: cur });
  }

  function hatch(today, cur) {
    const k = SCALE[cur] || 1;
    const kmAgo = (n) => HATCH_START_KM + HATCH_PACE * (HATCH_ADDED - n);
    return C.cleanCar({
      id: 'cxdemohatch', nick: 'The runaround', make: 'Ford', model: 'Fiesta', year: 2012, fuel: 'petrol', belt: 'unsure',
      added: C.addDays(today, -HATCH_ADDED),
      readings: [{ d: C.addDays(today, -HATCH_ADDED), km: kmAgo(HATCH_ADDED) }, { d: C.addDays(today, -45), km: kmAgo(45) }],
      services: [{ id: 'sxhatch0001', d: C.addDays(today, -150), km: kmAgo(150), items: ['oil'], other: '', cost: Math.round(65 * k * 100) / 100, cur, shop: 'Quick Fit', note: 'No paperwork came with it, so this is where the record starts.' }],
      dates: { insurance: C.addDays(today, 40) },
    }, { today, currency: cur });
  }

  /** The two cars for `today`, costs in `cur`. */
  function build(today, cur) {
    const c = C.CURRENCIES.indexOf(cur) >= 0 ? cur : 'USD';
    return { cars: [suv(today, c), hatch(today, c)] };
  }

  return { build, SUV_LOG };
});
