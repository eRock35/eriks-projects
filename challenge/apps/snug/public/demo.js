/* Snug - the made-up example. Everything here is invented: the blue
 * bungalow, its history and its appliances' makers (Corvane, Aldermoss and
 * Brindlecote are coined names). The clock is fixed at Saturday 21 November
 * 2026, so every number the tour points at holds. It is never kept, sent
 * or synced. No clock and no dice: the times are constants.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./snug-core'));
  else root.SnugDemo = factory(root.SnugCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var TODAY = '2026-11-21';
  var YEAR = 2026;
  var T = 1795251600000;   // 21 Nov 2026, 09:00 UTC - the example's "now"
  var NAME = 'The blue bungalow';
  var NOTICE = 'Made up: the blue bungalow, its history and its appliances’ makers (Corvane, Aldermoss and Brindlecote) are invented. The example’s clock is set to Saturday 21 November 2026. Nothing here is kept or sent.';

  var PROFILE = { name: NAME, tenure: 'own', kind: 'house', heat: 'furnace', cool: 'central', water: 'tank', gas: 'yes', climate: 'cold', has: ['gutters', 'fireplace', 'garage', 'laundry', 'dishwasher', 'icemaker', 'fans', 'sump'], since: '2025-06-14' };

  // When each job was last done. Two are never done here (the panel look,
  // so the first round puts it today), one was put off with "Not now".
  var DONE = {
    'smoke-test': ['2026-08-15', '2026-09-13', '2026-10-14'],
    'smoke-battery': ['2025-11-29'],
    'co-test': ['2026-09-30', '2026-11-01'],
    'alarms-age': ['2025-06-20'],
    'extinguisher': ['2026-06-28'],
    'gfci': ['2026-02-14', '2026-08-16'],
    'emergency-kit': ['2025-09-21', '2026-09-20'],
    'furnace-filter': ['2026-02-01', '2026-05-03', '2026-08-02'],
    'furnace-service': ['2025-10-04', '2026-10-09'],
    'ac-service': ['2026-05-09'],
    'condenser-clear': ['2026-04-19', '2026-10-11'],
    'vents-clear': ['2026-06-07'],
    'fans-winter': ['2025-11-09', '2026-11-15'],
    'fans-summer': ['2026-05-17'],
    'chimney': ['2025-09-06', '2026-09-12'],
    'water-main': ['2025-06-15', '2026-01-10'],
    'leaks': ['2026-06-06', '2026-09-05'],
    'toilets': ['2026-07-11'],
    'wh-flush': ['2026-03-14'],
    'wh-relief': ['2026-03-14'],
    'hoses-off': ['2025-10-26'],
    'pipes-insulate': ['2025-11-24'],
    'sump': ['2026-06-20', '2026-09-19'],
    'dryer-vent': ['2026-02-21'],
    'lint-screen': ['2026-05-30', '2026-08-30'],
    'washer-hoses': ['2025-12-13'],
    'fridge-coils': ['2025-12-06'],
    'fridge-filter': ['2025-12-01', '2026-06-01'],
    'hood-filter': ['2026-05-25', '2026-08-25'],
    'dishwasher-filter': ['2026-06-01', '2026-09-01'],
    'gutters': ['2025-11-15', '2026-04-25'],
    'roof-look': ['2026-04-12'],
    'weatherstrip': ['2026-10-18'],
    'garage-door': ['2026-06-14'],
    'snow-ready': ['2025-11-30'],
  };
  var SNOOZED = { 'hoses-off': '2026-11-23' };

  // The breaker panel: 40 spaces, a 200 A main, two breakers nobody has
  // labelled yet.
  var CIRCUITS = [
    [1, 1, 20, 'Kitchen counter - left', 'GFCI by the sink resets it'],
    [2, 1, 20, 'Kitchen counter - right', ''],
    [3, 1, 20, 'Dishwasher', ''],
    [4, 1, 20, 'Microwave', ''],
    [5, 1, 15, 'Living room and hall lights', ''],
    [6, 1, 15, 'Bedrooms 1 and 2', 'Lights and outlets'],
    [7, 2, 30, 'Dryer', ''],
    [8, 2, 40, 'Air conditioner', 'Outdoor unit - switch off before rinsing it'],
    [11, 1, 20, 'Laundry outlets', ''],
    [12, 1, 15, 'Main bedroom', ''],
    [13, 1, 20, 'Bathroom', 'GFCI in the bathroom resets it'],
    [14, 1, 15, 'Basement lights', ''],
    [15, 1, 20, 'Garage and outside outlets', ''],
    [16, 1, 15, 'Furnace', ''],
    [17, 1, 20, 'Fridge', ''],
    [18, 1, 15, '', ''],
    [19, 1, 15, '', ''],
    [20, 1, 20, 'Sump pump', 'Never leave this off'],
    [21, 1, 15, 'Dining room', ''],
    [22, 1, 15, 'Front porch and doorbell', ''],
  ];

  var FACTS = {
    water: 'Basement, front wall behind the shelf. Red handle - turn it clockwise to close.',
    gas: 'At the meter by the side gate: a quarter turn with a wrench. Each appliance has its own yellow valve.',
    power: 'Basement, at the foot of the stairs. The main switch is the big one at the top.',
    heater: 'Basement, beside the furnace. Its cold-water valve is on the pipe above it.',
    filter: '16 x 25 x 1, pleated',
    bins: 'Tuesday morning. Recycling every other week - the blue lid.',
    paint: 'Living room: pale grey-green, eggshell. Kitchen: warm white, satin.',
  };

  var APPLIANCES = [
    ['afurnace1', 'furnace', 'Corvane', 'GX80-40B', 2014, 'gas', '80,000 BTU/h', '16 x 25 x 1', ''],
    ['aaircon1', 'ac', 'Corvane', 'AC3-24C', 2014, 'electric', '2 ton', '', 'Outdoor unit by the back steps'],
    ['awaterh1', 'water-heater', 'Aldermoss', 'AW-50G', 2011, 'gas', '50 gal', '', ''],
    ['afridge1', 'fridge', 'Brindlecote', 'BF-36', 2019, 'electric', '', 'BWF-2 water filter', ''],
    ['adishw01', 'dishwasher', 'Brindlecote', 'BD-240', 2020, 'electric', '', '', ''],
    ['awasher1', 'washer', 'Aldermoss', 'AWM-8', 2017, 'electric', '', '', ''],
  ];

  function home() {
    var h = C.newHome(C.clone(PROFILE), T);
    h.panel = { spaces: 40, main: 200, t: T };
    Object.keys(DONE).forEach(function (id) { h.jobs[id] = { done: DONE[id].slice(), snooze: SNOOZED[id] || null, skip: false, t: T }; });
    CIRCUITS.forEach(function (c, i) { h.circuits['cdemo' + (i < 9 ? '0' : '') + (i + 1)] = { n: c[0], poles: c[1], amps: c[2], label: c[3], note: c[4], t: T, del: false }; });
    Object.keys(FACTS).forEach(function (k) { h.facts[k] = { text: FACTS[k], t: T }; });
    APPLIANCES.forEach(function (a) { h.appliances[a[0]] = { kind: a[1], maker: a[2], model: a[3], year: a[4], fuel: a[5], size: a[6], filter: a[7], note: a[8], t: T, del: false }; });
    return h;
  }

  /* ---- "Read the label": a made-up rating plate, and its reading ---- */

  // A dryer's plate, drawn as SVG. The serial number is blacked out on the
  // plate itself - Snug's tool has no serial field anyway.
  function plateSvg() {
    return '<svg class="plate" viewBox="0 0 340 210" role="img" aria-label="A made-up rating plate: Aldermoss clothes dryer, model ADR-75E, 240 volts, 30 amps, made in 2018">' +
      '<rect x="4" y="4" width="332" height="202" rx="10" fill="#d9dde2" stroke="#5a6270" stroke-width="3"/>' +
      '<circle cx="18" cy="18" r="4" fill="#8a929e"/><circle cx="322" cy="18" r="4" fill="#8a929e"/><circle cx="18" cy="192" r="4" fill="#8a929e"/><circle cx="322" cy="192" r="4" fill="#8a929e"/>' +
      '<text x="170" y="40" text-anchor="middle" font-family="system-ui, sans-serif" font-size="22" font-weight="900" letter-spacing="3" fill="#1f2630">ALDERMOSS</text>' +
      '<text x="170" y="60" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#1f2630">ELECTRIC CLOTHES DRYER</text>' +
      '<line x1="24" y1="70" x2="316" y2="70" stroke="#5a6270" stroke-width="1.5"/>' +
      '<g font-family="ui-monospace, monospace" font-size="13" fill="#1f2630">' +
      '<text x="28" y="94">MODEL</text><text x="128" y="94" font-weight="800">ADR-75E</text>' +
      '<text x="28" y="116">SERIAL</text><rect x="126" y="104" width="120" height="15" fill="#1f2630"/>' +
      '<text x="28" y="138">RATING</text><text x="128" y="138" font-weight="800">240 V  60 Hz  30 A</text>' +
      '<text x="28" y="160">CAPACITY</text><text x="128" y="160" font-weight="800">7.5 CU FT</text>' +
      '<text x="28" y="182">MFD</text><text x="128" y="182" font-weight="800">2018 / 0?</text>' +
      '</g></svg>';
  }
  // What a model might send back for that plate - the fields a rating plate
  // has, and three it should not: a serial, a recall line and advice. The
  // example goes through the same check as a real reading, which drops them.
  var LABEL_RAW = {
    kind: 'dryer', maker: 'Aldermoss', model: 'ADR-75E', year: 2018, fuel: 'electric', size: '7.5 cu ft', volts: '240 V, 60 Hz', amps: '30 A',
    unsure: ['year'],
    serial: 'AD18X4471',
    recall: 'Check whether this model was recalled',
    advice: 'Eight years old - worth replacing soon',
  };

  /* ---- what the tour expects (the suite checks every one) ---- */
  var STORY = {
    overdue: ['gutters', 'furnace-filter', 'smoke-test'],
    week: ['panel-look', 'hoses-off', 'pipes-insulate', 'hood-filter'],
    month: 12, later: 17, jobs: 36,
    ring: { on: 33, of: 36, pct: 92 },
    winter: { ready: 6, of: 11 },
    unlabelled: 2,
  };

  return { TODAY: TODAY, YEAR: YEAR, T: T, NAME: NAME, NOTICE: NOTICE, home: home, plateSvg: plateSvg, LABEL_RAW: LABEL_RAW, STORY: STORY };
}));
