/* Glovebox - the rules, in one file, run four times: by the page (a garage
 * on this phone and the example garage), by the buyer's history page (a
 * report decoded from a link), by the server (which only cleans the one AI
 * answer) and by the tests. UMD: window.GloveboxCore in the pages, require()
 * in node. It leans on glovebox-lights.js for the warning-light catalogue.
 *
 * Nothing here touches a store, the network or the clock on its own: every
 * function is handed `today` (a 'YYYY-MM-DD' in the phone's own time zone),
 * so the same car always gives the same board.
 *
 * DISTANCES ARE KEPT IN KILOMETRES, always. Miles exist only on the way in
 * (toKm) and on the way out (fromKm / dist); the tests round-trip both.
 *
 * What is in it:
 *   - the maintenance ITEMS with generic intervals by fuel (petrol, diesel,
 *     hybrid, EV - an EV has no oil, plugs, air filter or timing belt), every
 *     one editable per car, and "your manual wins" wherever they show;
 *   - cleanCar: the ONE door every car goes through - typed, imported, the
 *     example's, or rebuilt from the AI's reading of a receipt;
 *   - driving pace from odometer readings (a lower reading, a long gap and a
 *     single reading all handled), and the estimated odometer today;
 *   - each item's due point - by distance or by months, WHICHEVER COMES
 *     FIRST - the bands (Overdue / Due soon / Coming up / All good) and the
 *     one-line headline;
 *   - the actions (log a service, update the mileage, set a renewal date,
 *     change an interval, edit, delete a service) and undo;
 *   - costs: this year, all time, per mile;
 *   - the service-history report, packed into a link FRAGMENT (compressed
 *     when the browser can), decoded defensively and run back through the
 *     same cleaner, and drawn as HTML with everything escaped;
 *   - the calendar (.ics) and export / import;
 *   - the cleaners for the two AI answers (a dashboard photo, a receipt).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./glovebox-lights'));
  else root.GloveboxCore = factory(root.GloveboxLights);
})(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';

  const LIMITS = {
    cars: 10,               // on one phone
    nick: 30,
    make: 30,
    model: 30,
    shop: 60,
    other: 80,              // "other work" on a service
    note: 280,
    services: 300,          // per car, oldest dropped
    readings: 400,          // per car, oldest dropped
    itemsPerService: 16,
    maxKm: 2000000,         // an odometer reading, in km
    maxCost: 1000000,
    reportServices: 200,    // in one history link
    fragment: 16000,        // characters after the #
    inflated: 96 * 1024,    // bytes, once decompressed
    importBytes: 2 * 1024 * 1024,
    icsDays: 365,
    staleDays: 30,          // ask for a reading after this
  };

  /* ------------------------------------------------------------------ *
   * Text: untrusted until cleaned (Sprout's cleaner)
   * ------------------------------------------------------------------ */

  const STRIP = /[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
  function clean(v, max) {
    let s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 200) s = s.slice(0, max * 4 + 200);
    s = s.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
    return s;
  }
  /** A name: has to have a letter, a digit or an emoji in it. */
  function cleanText(v, max) {
    const s = clean(v, max);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(STRIP, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function nameList(names) {
    if (names.length <= 2) return names.join(' and ');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  function newId(prefix, rand) {
    const A = 'abcdefghijkmnpqrstuvwxyz23456789';
    const r = rand || ((n) => Math.floor(Math.random() * n));
    let s = prefix;
    for (let i = 0; i < 9; i++) s += A[r(A.length)];
    return s;
  }
  const CAR_ID = /^c[a-z0-9]{6,12}$/;
  const SVC_ID = /^s[a-z0-9]{6,12}$/;
  const isCarId = (v) => typeof v === 'string' && CAR_ID.test(v);
  const isSvcId = (v) => typeof v === 'string' && SVC_ID.test(v);
  function hash32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }
  const finite = (v) => typeof v === 'number' && isFinite(v);
  const round2 = (n) => Math.round(n * 100) / 100;
  function capital(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function lower(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

  /* ------------------------------------------------------------------ *
   * Days, in the phone's own time zone
   * ------------------------------------------------------------------ */

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isDate(v) {
    if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
    const ms = Date.parse(v + 'T00:00:00Z');
    return !isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === v;
  }
  function cleanTz(tz) {
    if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return 'UTC';
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return 'UTC'; }
  }
  const fmtCache = {};
  /** The calendar date at `ms` in `tz`, as 'YYYY-MM-DD'. */
  function localDate(ms, tz) {
    const z = cleanTz(tz);
    const f = fmtCache[z] || (fmtCache[z] = new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }));
    const p = {};
    for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
    return p.year + '-' + p.month + '-' + p.day;
  }
  const DAY_MS = 86400000;
  const dateMs = (d) => Date.parse(d + 'T00:00:00Z');
  const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
  function addDays(d, n) { return isoDate(dateMs(d) + Math.round(n) * DAY_MS); }
  function daysBetween(a, b) { return Math.round((dateMs(b) - dateMs(a)) / DAY_MS); }
  /** Calendar months; the 31st plus a month is the last day of the next. */
  function addMonths(d, n) {
    const y = Number(d.slice(0, 4)); const m = Number(d.slice(5, 7)) - 1; const day = Number(d.slice(8, 10));
    const t = y * 12 + m + Math.round(n);
    const ny = Math.floor(t / 12); const nm = t - ny * 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return ny + '-' + String(nm + 1).padStart(2, '0') + '-' + String(Math.min(day, last)).padStart(2, '0');
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  /** "8 Oct" ("8 Oct 2025" when not this year). */
  function dateLabel(d, today) {
    const x = new Date(dateMs(d));
    const s = x.getUTCDate() + ' ' + MONTHS[x.getUTCMonth()];
    return !today || d.slice(0, 4) !== today.slice(0, 4) ? s + ' ' + d.slice(0, 4) : s;
  }
  function monthLabel(d) { return MONTHS[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4); }
  /** How far ahead, in words: "today", "tomorrow", "in 5 days", "in about
   *  3 weeks", "in about 4 months", "in about 2 years". */
  function inWords(days) {
    const n = Math.round(days);
    if (n <= 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n < 14) return 'in ' + n + ' days';
    if (n < 56) return 'in about ' + Math.round(n / 7) + ' weeks';
    if (n < 345) { const m = Math.max(2, Math.round(n / 30.44)); return 'in about ' + m + ' months'; }
    const y = Math.round(n / 365.25);
    return y <= 1 ? 'in about a year' : 'in about ' + y + ' years';
  }
  /** How long ago: "today", "yesterday", "5 days ago", "about 3 weeks ago". */
  function agoWords(days) {
    const n = Math.round(days);
    if (n <= 0) return 'today';
    if (n === 1) return 'yesterday';
    if (n < 14) return n + ' days ago';
    if (n < 56) return 'about ' + Math.round(n / 7) + ' weeks ago';
    if (n < 345) return 'about ' + Math.max(2, Math.round(n / 30.44)) + ' months ago';
    const y = Math.round(n / 365.25);
    return y <= 1 ? 'about a year ago' : 'about ' + y + ' years ago';
  }

  /* ------------------------------------------------------------------ *
   * Units, region and money
   * ------------------------------------------------------------------ */

  const KM_PER_MI = 1.609344;
  const UNITS = ['mi', 'km'];
  /** A typed distance -> km, kept to the hundredth (so every whole mile
   *  comes back as the same whole mile). */
  function toKm(v, units) {
    if (!finite(v)) return null;
    return round2(units === 'mi' ? v * KM_PER_MI : v);
  }
  function fromKm(km, units) { return units === 'mi' ? km / KM_PER_MI : km; }
  /** A number in the phone's way: 48,230. */
  function num(n) { return Math.round(n).toLocaleString('en-US'); }
  /** "48,230 mi" / "77,618 km". `step` rounds (100 for "≈ 600 miles"). */
  function dist(km, units, opts) {
    const o = opts || {};
    let v = fromKm(km, units);
    if (o.step) v = Math.round(v / o.step) * o.step;
    return num(v) + ' ' + (o.long ? (units === 'mi' ? 'miles' : 'km') : units);
  }
  /** Round a distance for a sentence: to the 100 when it is big enough. */
  function roughly(km, units, long) {
    const v = Math.abs(fromKm(km, units));
    const step = v >= 200 ? 100 : 10;
    return dist(Math.abs(km), units, { step, long });
  }
  // Where the phone is -> units and a currency. Miles in the US, the UK,
  // Liberia and Myanmar (and the US territories); km everywhere else.
  const MILE_REGIONS = ['US', 'GB', 'LR', 'MM', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM'];
  const CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'NZD', 'INR', 'ZAR', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'SGD', 'HKD'];
  const EURO = ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'];
  const REGION_CUR = { US: 'USD', PR: 'USD', GU: 'USD', VI: 'USD', AS: 'USD', MP: 'USD', UM: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', IN: 'INR', ZA: 'ZAR', JP: 'JPY', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', MX: 'MXN', BR: 'BRL', SG: 'SGD', HK: 'HKD' };
  /** 'en-GB' -> 'GB'. Unknown -> 'US' (the lab's home). */
  function regionOf(locale) {
    const m = /^[a-z]{2,3}(?:[-_][A-Za-z]{4})?[-_]([A-Za-z]{2})\b/.exec(String(locale || ''));
    return m ? m[1].toUpperCase() : 'US';
  }
  function unitsFor(region) { return MILE_REGIONS.indexOf(region) >= 0 ? 'mi' : 'km'; }
  function currencyFor(region) { return REGION_CUR[region] || (EURO.indexOf(region) >= 0 ? 'EUR' : 'USD'); }
  const ZERO_DP = ['JPY'];
  /** "$1,240.50" / "£89.00" / "¥8,000". */
  function money(n, cur, locale) {
    if (!finite(n)) return '';
    const c = CURRENCIES.indexOf(cur) >= 0 ? cur : 'USD';
    const dp = ZERO_DP.indexOf(c) >= 0 ? 0 : 2;
    try {
      return new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: c, minimumFractionDigits: dp, maximumFractionDigits: dp }).format(n);
    } catch (e) { return c + ' ' + n.toFixed(dp); }
  }
  /** US spelling where it matters most: tire, gas. */
  function spell(text, region) {
    if (region !== 'US') return text;
    return String(text).replace(/\bTyres\b/g, 'Tires').replace(/\btyres\b/g, 'tires').replace(/\bTyre\b/g, 'Tire').replace(/\btyre\b/g, 'tire');
  }

  /* ------------------------------------------------------------------ *
   * The car and its maintenance plan
   * ------------------------------------------------------------------ */

  const FUELS = ['petrol', 'diesel', 'hybrid', 'ev'];
  const FUEL_LABEL = { petrol: 'Petrol', diesel: 'Diesel', hybrid: 'Hybrid', ev: 'Electric' };
  function fuelWord(f, region) { return f === 'petrol' && region === 'US' ? 'Gas' : (FUEL_LABEL[f] || 'Petrol'); }
  const ICE = ['petrol', 'diesel', 'hybrid'];
  const ALL = FUELS;
  const BELTS = ['belt', 'chain', 'unsure'];

  // The generic plan. Every number is a cautious middle of what owners'
  // manuals say - the page says "your manual wins" wherever it shows them,
  // and every interval can be changed per car. km: a number, a per-fuel map,
  // or null (time only). kind: 'service' (distance and/or months) or 'date'
  // (a renewal the owner gives the date of).
  const ITEMS = [
    { id: 'oil', routine: true, name: 'Oil & filter change', short: 'Oil change', emoji: '🛢️', km: { petrol: 12000, diesel: 15000, hybrid: 15000 }, months: 12, fuels: ICE,
      why: 'Fresh oil stops the engine wearing itself out. Lots of short trips, towing or dusty roads wear it faster - many manuals give a shorter “severe” interval for those.' },
    { id: 'rotate', routine: true, name: 'Tyre rotation', short: 'Tyre rotation', emoji: '🔄', km: 10000, months: 12, fuels: ALL,
      why: 'Swapping tyres front to back evens out the wear so the set lasts longer. Heavier EVs wear tyres faster.' },
    { id: 'tyres', name: 'Tyre replacement', short: 'New tyres', emoji: '🛞', km: { petrol: 60000, diesel: 60000, hybrid: 60000, ev: 45000 }, months: 72, fuels: ALL,
      why: 'Replace at about 3 mm (4/32") of tread or six years old, whichever comes first - grip in the wet falls away well before the legal minimum. Check for cracks in the sidewalls too.' },
    { id: 'brakes', routine: true, name: 'Brake check (pads & discs)', short: 'Brake check', emoji: '🛑', km: { petrol: 20000, diesel: 20000, hybrid: 30000, ev: 30000 }, months: 12, fuels: ALL,
      why: 'A look at the pads, discs (rotors) and hoses. Hybrids and EVs brake with the motor a lot, so pads last longer - but discs can rust from lack of use.' },
    { id: 'brakefluid', name: 'Brake fluid', short: 'Brake fluid', emoji: '💧', km: null, months: 24, fuels: ALL,
      why: 'Brake fluid soaks up water over time, which makes the pedal feel soft when the brakes get hot.' },
    { id: 'coolant', name: 'Coolant', short: 'Coolant', emoji: '🌡️', km: 100000, months: 60, fuels: ALL,
      why: 'Coolant (antifreeze) wears out and stops protecting against corrosion and freezing. EVs use it to cool the battery.' },
    { id: 'airfilter', routine: true, name: 'Engine air filter', short: 'Air filter', emoji: '🌬️', km: 30000, months: 24, fuels: ICE,
      why: 'A clogged filter starves the engine of air. Dusty roads clog it faster.' },
    { id: 'cabin', routine: true, name: 'Cabin (pollen) filter', short: 'Cabin filter', emoji: '🍃', km: 20000, months: 12, fuels: ALL,
      why: 'Cleans the air you breathe inside the car and keeps the windscreen from misting up.' },
    { id: 'plugs', name: 'Spark plugs', short: 'Spark plugs', emoji: '⚡', km: 100000, months: 72, fuels: ['petrol', 'hybrid'],
      why: 'Worn plugs mean misfires, rough running and more fuel. Older cars with copper plugs need them far sooner - check the manual.' },
    { id: 'fuelfilter', name: 'Fuel filter', short: 'Fuel filter', emoji: '⛽', km: 60000, months: 48, fuels: ['diesel'],
      why: 'Diesel engines are fussy about clean fuel; a blocked filter means poor running and hard starts.' },
    { id: 'timing', name: 'Timing belt', short: 'Timing belt', emoji: '⚙️', km: 100000, months: 60, fuels: ICE, belt: true,
      why: 'If a timing belt snaps, many engines are wrecked. It’s replaced on a schedule, by distance or age. A timing chain usually lasts the life of the engine.' },
    { id: 'battery', routine: true, name: '12V battery check', short: 'Battery check', emoji: '🔋', km: null, months: 12, fuels: ALL,
      why: 'A test takes minutes at most garages. Most batteries last four to five years; the first cold morning finds the weak ones. EVs have one too.' },
    { id: 'wipers', routine: true, name: 'Wiper blades', short: 'Wipers', emoji: '🧽', km: null, months: 12, fuels: ALL,
      why: 'Rubber hardens and smears after a year or so of sun and frost.' },
    { id: 'inspection', name: 'Inspection / MOT', short: 'Inspection', emoji: '📋', kind: 'date', months: 12, fuels: ALL,
      why: 'The roadworthiness test where you live (MOT, state inspection, WOF, TÜV...). Give Glovebox the date it’s due.' },
    { id: 'registration', name: 'Registration / road tax', short: 'Registration', emoji: '🪪', kind: 'date', months: 12, fuels: ALL,
      why: 'Renew before it lapses - driving unregistered or untaxed can mean a fine.' },
    { id: 'insurance', name: 'Insurance renewal', short: 'Insurance', emoji: '🛡️', kind: 'date', months: 12, fuels: ALL,
      why: 'Renewal is the best time to shop around.' },
  ];
  ITEMS.forEach((it) => { if (!it.kind) it.kind = 'service'; });
  const ITEM_BY = Object.create(null);
  ITEMS.forEach((it) => { ITEM_BY[it.id] = it; });
  const ITEM_IDS = ITEMS.map((it) => it.id);
  function item(id) { return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ITEM_BY, id) ? ITEM_BY[id] : null; }
  /** Does this item apply to this car at all? EVs skip oil, plugs, the air
   *  filter and the timing belt; a timing belt only when the car has one. */
  function applies(car, it) {
    if (it.fuels.indexOf(car.fuel) < 0) return false;
    if (it.belt && car.belt !== 'belt') return false;
    return true;
  }
  function baseKmOf(car, it) {
    if (it.km === null || it.km === undefined) return null;
    if (typeof it.km === 'number') return it.km;
    return own(it.km, car.fuel) ? it.km[car.fuel] : null;
  }
  /** This car's interval for an item: the plan's override, else generic. */
  function intervalOf(car, it) {
    const o = (car.plan && own(car.plan, it.id)) ? car.plan[it.id] : {};
    const km = it.kind === 'date' ? null : (own(o, 'km') ? o.km : baseKmOf(car, it));
    const months = own(o, 'months') ? o.months : (it.months || null);
    return { km, months, off: o.off === true, custom: own(o, 'km') || own(o, 'months'), baseKm: baseKmOf(car, it), baseMonths: it.months || null };
  }
  function itemsFor(car) { return ITEMS.filter((it) => applies(car, it)); }

  /* ------------------------------------------------------------------ *
   * One door for every car
   * ------------------------------------------------------------------ */

  function cleanKm(v) { return finite(v) && v >= 0 && v <= LIMITS.maxKm ? round2(v) : null; }
  function cleanCost(v) { return finite(v) && v >= 0 && v <= LIMITS.maxCost ? round2(v) : null; }
  function cleanCur(v) { return CURRENCIES.indexOf(v) >= 0 ? v : null; }
  function cleanService(raw, ctx) {
    if (!raw || typeof raw !== 'object') return null;
    const today = ctx.today;
    if (!isDate(raw.d) || raw.d > today || raw.d < '1950-01-01') return null;
    const items = [];
    for (const id of (Array.isArray(raw.items) ? raw.items : []).slice(0, 40)) {
      if (item(id) && items.indexOf(id) < 0) items.push(id);
      if (items.length >= LIMITS.itemsPerService) break;
    }
    const other = clean(raw.other, LIMITS.other);
    if (!items.length && !other) return null;
    return {
      id: isSvcId(raw.id) ? raw.id : newId('s', ctx.rand),
      d: raw.d,
      km: cleanKm(raw.km),
      items,
      other,
      cost: cleanCost(raw.cost),
      cur: cleanCur(raw.cur) || ctx.currency || 'USD',
      shop: clean(raw.shop, LIMITS.shop),
      note: clean(raw.note, LIMITS.note),
      photo: raw.photo === true,
    };
  }
  function cleanPlanEntry(it, raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    if (raw.off === true) out.off = true;
    if (it.kind !== 'date' && own(raw, 'km')) {
      if (raw.km === null) out.km = null;
      else if (finite(raw.km) && raw.km >= 500 && raw.km <= 500000) out.km = Math.round(raw.km);
    }
    if (own(raw, 'months')) {
      if (raw.months === null && it.kind !== 'date') out.months = null;
      else if (Number.isInteger(raw.months) && raw.months >= 1 && raw.months <= 240) out.months = raw.months;
    }
    // A service item must still come due somehow.
    const km = own(out, 'km') ? out.km : (it.kind === 'date' ? null : 1);
    const mo = own(out, 'months') ? out.months : it.months;
    if (it.kind !== 'date' && !km && !mo) { delete out.km; delete out.months; }
    return Object.keys(out).length ? out : null;
  }
  /**
   * Every car comes through here: typed, imported, the example's. Returns a
   * clean copy or null when there is nothing to call it.
   */
  function cleanCar(raw, ctx) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const today = ctx.today;
    const thisYear = Number(today.slice(0, 4));
    const car = {
      id: isCarId(raw.id) ? raw.id : newId('c', ctx.rand),
      nick: cleanText(raw.nick, LIMITS.nick),
      make: cleanText(raw.make, LIMITS.make),
      model: cleanText(raw.model, LIMITS.model),
      year: Number.isInteger(raw.year) && raw.year >= 1900 && raw.year <= thisYear + 1 ? raw.year : null,
      fuel: FUELS.indexOf(raw.fuel) >= 0 ? raw.fuel : 'petrol',
      belt: BELTS.indexOf(raw.belt) >= 0 ? raw.belt : 'unsure',
      added: isDate(raw.added) && raw.added <= today ? raw.added : today,
      rev: Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0,
    };
    if (!car.nick && !car.make && !car.model) return null;
    if (car.fuel === 'ev') car.belt = 'chain';
    // Readings: real dates, not in the future, one per day (the last given).
    const byDay = {};
    for (const r of (Array.isArray(raw.readings) ? raw.readings : []).slice(0, LIMITS.readings * 10)) {
      if (!r || !isDate(r.d) || r.d > today) continue;
      const km = cleanKm(r.km);
      if (km === null) continue;
      byDay[r.d] = km;
    }
    car.readings = Object.keys(byDay).sort().map((d) => ({ d, km: byDay[d] })).slice(-LIMITS.readings);
    // Services: through the one cleaner, unique ids, oldest first.
    const ids = new Set();
    const svcs = [];
    for (const s of (Array.isArray(raw.services) ? raw.services : []).slice(0, LIMITS.services * 10)) {
      const c = cleanService(s, ctx);
      if (!c) continue;
      if (ids.has(c.id)) c.id = newId('s', ctx.rand);
      ids.add(c.id);
      svcs.push(c);
    }
    car.services = svcs.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)).slice(-LIMITS.services);
    car.plan = {};
    const plan = raw.plan && typeof raw.plan === 'object' ? raw.plan : {};
    for (const it of ITEMS) {
      if (!own(plan, it.id)) continue;
      const p = cleanPlanEntry(it, plan[it.id]);
      if (p) car.plan[it.id] = p;
    }
    car.dates = {};
    const dates = raw.dates && typeof raw.dates === 'object' ? raw.dates : {};
    for (const it of ITEMS) {
      if (it.kind === 'date' && own(dates, it.id) && isDate(dates[it.id]) && dates[it.id] >= '1990-01-01' && dates[it.id] <= addDays(today, 3660)) car.dates[it.id] = dates[it.id];
    }
    // Where every item counts from when nothing has been logged for it.
    const b = raw.base && typeof raw.base === 'object' ? raw.base : {};
    const how = ['known', 'new', 'assumed'].indexOf(b.how) >= 0 ? b.how : 'assumed';
    const first = car.readings[0];
    car.base = (how !== 'assumed' && isDate(b.d) && b.d <= today)
      ? { d: b.d, km: cleanKm(b.km), how }
      : { d: car.added, km: first ? first.km : null, how: 'assumed' };
    return car;
  }
  /** "Family SUV" or "2018 Honda CR-V". */
  function carName(car) { return car.nick || carTitle(car) || 'My car'; }
  function carTitle(car) { return [car.year, car.make, car.model].filter(Boolean).join(' '); }

  /** A new car from the add form. Distances arrive in km already. */
  function newCar(form, ctx) {
    const f = form || {};
    const today = ctx.today;
    const raw = {
      nick: f.nick, make: f.make, model: f.model, year: f.year, fuel: f.fuel, belt: f.belt, added: today, rev: 0,
      readings: finite(f.km) ? [{ d: today, km: f.km }] : [],
      services: [], plan: {}, dates: {},
    };
    if (f.last === 'known' && isDate(f.lastD) && f.lastD <= today) raw.base = { d: f.lastD, km: finite(f.lastKm) ? f.lastKm : null, how: 'known' };
    else if (f.last === 'new') raw.base = { d: today, km: finite(f.km) ? f.km : null, how: 'new' };
    const dates = f.dates || {};
    for (const id of ['inspection', 'registration', 'insurance']) if (isDate(dates[id])) raw.dates[id] = dates[id];
    if (f.last === 'known' && isDate(f.lastD) && finite(f.lastKm) && finite(f.km) && f.lastD < today) raw.readings.unshift({ d: f.lastD, km: f.lastKm });
    return cleanCar(raw, ctx);
  }

  /* ------------------------------------------------------------------ *
   * Driving pace and the odometer today
   * ------------------------------------------------------------------ */

  // Until there are two readings a fortnight apart, assume a typical year:
  // 18,000 km (about 11,000 miles). Said so wherever it shows.
  const DEFAULT_KM_PER_YEAR = 18000;
  const MAX_KM_PER_DAY = 400;
  /** Every odometer point we know, oldest first, one per day, never going
   *  down: a reading lower than an earlier one (a typo, a swapped
   *  instrument cluster, miles typed as km) is set aside and counted. */
  function points(car, today) {
    const raw = [];
    for (const r of car.readings || []) raw.push({ d: r.d, km: r.km });
    for (const s of car.services || []) if (s.km !== null && s.km !== undefined) raw.push({ d: s.d, km: s.km });
    if (car.base && car.base.how !== 'assumed' && car.base.km !== null) raw.push({ d: car.base.d, km: car.base.km });
    const day = {};
    for (const p of raw) if (p.d <= today) day[p.d] = Math.max(day[p.d] || 0, p.km);
    const out = []; let max = -1; let lower = 0;
    for (const d of Object.keys(day).sort()) {
      if (day[d] < max) { lower++; continue; }
      max = day[d];
      out.push({ d, km: day[d] });
    }
    return { list: out, lower };
  }
  /**
   * How far this car goes a day, from its readings over the last year (or,
   * after a long gap, from the one before the year to the latest). Fewer
   * than two points a fortnight apart: the typical year, marked assumed.
   */
  function paceOf(car, today) {
    const { list, lower } = points(car, today);
    const latest = list[list.length - 1] || null;
    const out = { perDay: DEFAULT_KM_PER_YEAR / 365.25, assumed: true, latest, lower, span: 0, points: list.length, est: latest ? latest.km : null, age: latest ? daysBetween(latest.d, today) : null };
    if (list.length >= 2) {
      const from = addDays(today, -365);
      let i = list.findIndex((p) => p.d >= from);
      if (i < 0) i = list.length - 1;
      if (i > list.length - 2) i = list.length - 2; // a long gap: reach back for one more
      const a = list[i];
      const span = daysBetween(a.d, latest.d);
      if (span >= 14) {
        out.perDay = Math.min(MAX_KM_PER_DAY, Math.max(0, (latest.km - a.km) / span));
        out.assumed = false;
        out.span = span;
      }
    }
    if (latest) out.est = latest.km + out.perDay * Math.max(0, out.age);
    out.stale = latest ? out.age > LIMITS.staleDays : true;
    return out;
  }
  /** The odometer on a past date, from the points either side of it. */
  function kmAt(car, d, pc, today) {
    const { list } = points(car, today || d);
    if (!list.length) return null;
    let before = null; let after = null;
    for (const p of list) { if (p.d <= d) before = p; else if (!after) after = p; }
    if (before && before.d === d) return before.km;
    if (before && after) return before.km + (after.km - before.km) * daysBetween(before.d, d) / daysBetween(before.d, after.d);
    const per = pc ? pc.perDay : DEFAULT_KM_PER_YEAR / 365.25;
    if (before) return before.km + per * daysBetween(before.d, d);
    return Math.max(0, after.km - per * daysBetween(d, after.d));
  }
  /** "About 1,000 mi a month". */
  function paceText(pc, units) {
    const month = pc.perDay * 30.44;
    if (!pc.assumed && fromKm(month, units) < 10) return 'Hardly driven lately';
    return 'About ' + roughly(month, units) + ' a month' + (pc.assumed ? ' (a typical guess until there are two readings a fortnight apart)' : '');
  }

  /* ------------------------------------------------------------------ *
   * When each item is due - distance or months, whichever comes first
   * ------------------------------------------------------------------ */

  /** The latest time it was done: a logged service, else where the car's
   *  history starts (`base`). */
  // A "last service" the owner remembers covers the routine items (oil,
  // rotation, filters, the brake check...). A brand-new car starts every
  // item fresh. Anything else with no record counts from the day the car
  // was added, and says so ("No record").
  function lastDone(car, id) {
    for (let i = car.services.length - 1; i >= 0; i--) {
      const s = car.services[i];
      if (s.items.indexOf(id) >= 0) return { d: s.d, km: s.km, from: 'log', sid: s.id };
    }
    const it = item(id);
    const b = car.base;
    if (b.how === 'new' || (b.how === 'known' && it && it.routine)) return { d: b.d, km: b.km, from: 'base', how: b.how };
    const first = (car.readings || []).filter((r) => r.d >= car.added)[0] || (car.readings || [])[0];
    return { d: car.added, km: first ? first.km : null, from: 'base', how: 'assumed' };
  }
  const BANDS = [
    { id: 'overdue', label: 'Overdue', icon: '⛔' },
    { id: 'soon', label: 'Due soon', icon: '⏰' },
    { id: 'coming', label: 'Coming up', icon: '🗓️' },
    { id: 'good', label: 'All good', icon: '✅' },
  ];
  function soonKm(iv) { return Math.max(800, Math.min(1600, (iv.km || 0) * 0.1)); }

  function statusOf(car, it, today, pc) {
    const p = pc || paceOf(car, today);
    const iv = intervalOf(car, it);
    const st = { item: it, iv, band: 'good' };
    if (iv.off) { st.band = 'off'; return st; }
    if (it.kind === 'date') {
      // The date the owner gave, else a year (the interval) on from the
      // last time it was logged as done.
      const last = lastDone(car, it.id);
      const due = car.dates[it.id] || (last.from === 'log' && iv.months ? addMonths(last.d, iv.months) : null);
      if (!due) { st.band = 'none'; return st; }
      st.due = due; st.days = daysBetween(today, due); st.by = 'date';
      st.last = last;
      st.band = st.days < 0 ? 'overdue' : st.days <= 30 ? 'soon' : st.days <= 90 ? 'coming' : 'good';
      return st;
    }
    const last = lastDone(car, it.id);
    st.last = last;
    st.unknown = last.from === 'base' && last.how === 'assumed';
    const lastKm = last.km !== null && last.km !== undefined ? last.km : kmAt(car, last.d, p, today);
    st.lastKm = lastKm;
    st.lastKmEstimated = last.km === null || last.km === undefined;
    const dueDate = iv.months ? addMonths(last.d, iv.months) : null;
    const dueKm = iv.km && lastKm !== null ? lastKm + iv.km : null;
    const kmLeft = dueKm !== null && p.est !== null ? dueKm - p.est : null;
    const dTime = dueDate ? daysBetween(today, dueDate) : null;
    let dKm = null;
    if (kmLeft !== null) dKm = kmLeft <= 0 ? (p.perDay > 0 ? kmLeft / p.perDay : 0) : (p.perDay > 0 ? kmLeft / p.perDay : null);
    Object.assign(st, { dueDate, dueKm, kmLeft, dTime, dKm });
    const cands = [];
    if (dTime !== null) cands.push(['time', dTime]);
    if (dKm !== null) cands.push(['km', dKm]);
    if (!cands.length) { st.band = 'none'; return st; }
    cands.sort((a, b) => a[1] - b[1]);
    st.by = cands[0][0];
    st.days = cands[0][1];
    st.due = st.by === 'time' ? dueDate : addDays(today, Math.max(Math.round(st.days), -36500));
    const overKm = kmLeft !== null && kmLeft <= 0;
    const overTime = dTime !== null && dTime < 0;
    st.projected = st.by === 'km';
    if (overKm || overTime) {
      st.band = 'overdue';
      if (overKm && !overTime) st.by = 'km';
      else if (overTime && !overKm) st.by = 'time';
    } else if (st.days <= 30 || (kmLeft !== null && kmLeft <= soonKm(iv))) st.band = 'soon';
    else if (st.days <= 90 || (kmLeft !== null && iv.km && kmLeft <= iv.km * 0.25)) st.band = 'coming';
    else st.band = 'good';
    return st;
  }
  /** Every item into its band, most urgent first. `none`: a renewal with
   *  no date yet; `off`: switched off in the plan. */
  function board(car, today) {
    const pc = paceOf(car, today);
    const out = { overdue: [], soon: [], coming: [], good: [], none: [], off: [], pace: pc };
    for (const it of itemsFor(car)) {
      const st = statusOf(car, it, today, pc);
      out[st.band].push(st);
    }
    const by = (a, b) => (a.days - b.days) || ITEM_IDS.indexOf(a.item.id) - ITEM_IDS.indexOf(b.item.id);
    for (const k of ['overdue', 'soon', 'coming', 'good']) out[k].sort(by);
    return out;
  }
  /** "Due in about 3 weeks (≈ 600 mi)" / "Overdue by about 1,400 mi". */
  function dueText(st, units, today, long) {
    if (st.band === 'none') return st.item.kind === 'date' ? 'No date yet' : 'No record';
    if (st.band === 'off') return 'Not tracked';
    if (st.band === 'overdue') {
      if (st.by === 'km') return 'Overdue by about ' + roughly(-st.kmLeft, units, long);
      return 'Overdue since ' + dateLabel(st.due, today) + ' (' + agoWords(-st.days) + ')';
    }
    const when = inWords(st.days);
    if (st.by === 'km') return 'Due ' + when + ' (≈ ' + roughly(st.kmLeft, units, long) + ')';
    if (st.by === 'date') return (st.days === 0 ? 'Due today' : 'Due ' + when) + ' · ' + dateLabel(st.due, today);
    return 'Due ' + when + ' · by ' + dateLabel(st.due, today);
  }
  /** "At 52,800 mi or by 4 Mar 2027 - whichever comes first". */
  function dueRule(st, units, today) {
    if (st.item.kind === 'date' || st.band === 'none' || st.band === 'off') return '';
    const parts = [];
    if (st.dueKm !== null && st.dueKm !== undefined) parts.push('at ' + dist(st.dueKm, units, { step: 100 }));
    if (st.dueDate) parts.push('by ' + dateLabel(st.dueDate, today));
    // Only worth a line when there are two ways for it to come due.
    return parts.length === 2 ? capital(parts.join(' or ')) + ' - whichever comes first' : '';
  }
  function headline(car, today, units, region) {
    const b = board(car, today);
    const top = b.overdue[0] || b.soon[0] || b.coming[0];
    const name = (st) => spell(st.item.name, region);
    if (top && top.band === 'overdue') {
      const more = b.overdue.length - 1;
      return name(top) + ' is overdue - ' + lower(dueText(top, units, today, true).replace(/^Overdue /, '')) + '.' + (more > 0 ? ' ' + plural(more, 'more thing') + ' overdue too.' : '');
    }
    if (top) return name(top) + ' ' + lower(dueText(top, units, today, true)) + '.';
    const next = b.good[0];
    if (next) return 'All good. Next up: ' + lower(spell(next.item.short, region)) + ' ' + inWords(next.days) + '.';
    return 'Nothing to track yet - add a reading or a service.';
  }

  /* ------------------------------------------------------------------ *
   * The actions: each returns {car, msg, token} and never changes its
   * argument. undo(car, token) puts the car back exactly - but only if
   * nothing has happened to it since (its `rev` still matches).
   * ------------------------------------------------------------------ */

  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  function err(status, message) { return Object.assign(new Error(message), { status, expose: true }); }

  function act(car, kind, ctx, opts) {
    const o = opts || {};
    const today = ctx.today;
    const units = ctx.units || 'mi';
    const before = copy(car);
    let c = copy(car);
    let msg = '';
    if (kind === 'service') {
      const s = cleanService(Object.assign({}, o, { id: undefined }), ctx);
      if (!s) throw err(400, o.d && o.d > today ? 'That date is in the future.' : 'Pick what was done (or describe it) and the date.');
      c.services.push(s);
      c.services.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
      if (c.services.length > LIMITS.services) c.services = c.services.slice(-LIMITS.services);
      // A renewal logged as done moves its next date on, unless a later one
      // is already set.
      for (const id of s.items) {
        const it = item(id);
        if (it.kind === 'date') {
          const next = addMonths(s.d, intervalOf(c, it).months || 12);
          if (!c.dates[id] || c.dates[id] < next) c.dates[id] = next;
        }
      }
      const first = s.items.map(item).filter((it) => applies(c, it))[0];
      const names = s.items.map((id) => lower(spell(item(id).short, ctx.region))).concat(s.other ? [lower(s.other)] : []);
      msg = 'Logged ' + nameList(names) + '.';
      if (first) {
        const st = statusOf(c, first, today);
        if (st.band !== 'none' && st.band !== 'off') msg += ' Next ' + lower(spell(first.short, ctx.region)) + ': ' + lower(dueText(st, units, today)) + '.';
      }
      const pts = points(car, today).list;
      const max = pts.length ? pts[pts.length - 1] : null;
      if (s.km !== null && max && s.km < max.km && s.d >= max.d) msg += ' (That mileage is lower than your last reading - check it.)';
      c.lastSvc = s.id;
    } else if (kind === 'reading') {
      const d = isDate(o.d) ? o.d : today;
      if (d > today) throw err(400, 'That date is in the future.');
      const km = cleanKm(o.km);
      if (km === null) throw err(400, 'Type the number on the odometer.');
      const pts = points(car, today).list;
      const prev = pts.filter((p) => p.d <= d).pop();
      const next = pts.filter((p) => p.d > d)[0];
      if (next && km > next.km + 0.5 && !o.force) throw Object.assign(err(409, 'That’s higher than your later reading of ' + dist(next.km, units) + ' on ' + dateLabel(next.d, today) + '. A typo? Save it anyway if it’s right.'), { code: 'lower' });
      if (prev && km < prev.km - 0.5 && !o.force) throw Object.assign(err(409, 'That’s lower than your reading of ' + dist(prev.km, units) + ' on ' + dateLabel(prev.d, today) + '. A typo? If the odometer really went back (a replaced dashboard), save it anyway.'), { code: 'lower' });
      if (prev && !o.force && km - prev.km > MAX_KM_PER_DAY * Math.max(1, daysBetween(prev.d, d)) + 2000) throw Object.assign(err(409, 'That’s ' + dist(km - prev.km, units) + ' since ' + dateLabel(prev.d, today) + ' - a typo? Save it anyway if it’s right.'), { code: 'jump' });
      c.readings = c.readings.filter((r) => r.d !== d).concat([{ d, km }]).sort((a, b) => (a.d < b.d ? -1 : 1)).slice(-LIMITS.readings);
      const pc = paceOf(c, today);
      msg = 'Odometer ' + dist(km, units) + (d === today ? ' today' : ' on ' + dateLabel(d, today)) + '.' + (pc.assumed ? '' : ' ' + paceText(pc, units) + '.');
    } else if (kind === 'setdate') {
      const it = item(o.id);
      if (!it || it.kind !== 'date') throw err(400, 'Unknown renewal.');
      if (o.d === null || o.d === '') { delete c.dates[it.id]; msg = spell(it.name, ctx.region) + ': date cleared.'; } else {
        if (!isDate(o.d)) throw err(400, 'Pick a date.');
        c.dates[it.id] = o.d;
        msg = spell(it.name, ctx.region) + ' due ' + dateLabel(o.d, today) + '.';
      }
    } else if (kind === 'plan') {
      const it = item(o.id);
      if (!it) throw err(400, 'Unknown item.');
      if (o.reset) delete c.plan[it.id];
      else {
        const p = cleanPlanEntry(it, o);
        if (!p) throw err(400, 'Give a distance, a number of months, or both.');
        c.plan[it.id] = p;
      }
      const iv = intervalOf(c, it);
      msg = iv.off ? spell(it.name, ctx.region) + ' is no longer tracked.' : spell(it.name, ctx.region) + ': every ' + [iv.km ? dist(iv.km, units, { step: 100 }) : '', iv.months ? plural(iv.months, 'month') : ''].filter(Boolean).join(' or ') + '.';
    } else if (kind === 'belt') {
      if (BELTS.indexOf(o.belt) < 0) throw err(400, 'Belt, chain or not sure.');
      c.belt = c.fuel === 'ev' ? 'chain' : o.belt;
      msg = c.belt === 'belt' ? 'Timing belt added to the plan.' : c.belt === 'chain' ? 'Timing chain - nothing to schedule.' : 'Noted.';
    } else if (kind === 'edit') {
      const merged = Object.assign({}, c, {
        nick: own(o, 'nick') ? o.nick : c.nick, make: own(o, 'make') ? o.make : c.make, model: own(o, 'model') ? o.model : c.model,
        year: own(o, 'year') ? o.year : c.year, fuel: own(o, 'fuel') ? o.fuel : c.fuel, belt: own(o, 'belt') ? o.belt : c.belt,
      });
      const cl = cleanCar(merged, ctx);
      if (!cl) throw err(400, 'Give it a name, a make or a model.');
      c = cl;
      msg = 'Saved.';
    } else if (kind === 'delsvc') {
      const n = c.services.length;
      c.services = c.services.filter((s) => s.id !== o.sid);
      if (c.services.length === n) throw err(404, 'That entry isn’t there any more.');
      msg = 'Entry deleted.';
    } else {
      throw err(400, 'Unknown action.');
    }
    c.rev = (car.rev || 0) + 1;
    return { car: c, msg, token: { id: car.id, rev: c.rev, prev: before } };
  }
  function undo(car, token) {
    if (!token || token.id !== car.id || token.rev !== car.rev) throw err(409, 'Something changed since - that can’t be undone now.');
    return copy(token.prev);
  }

  /* ------------------------------------------------------------------ *
   * Costs
   * ------------------------------------------------------------------ */

  /** This year, all time, and per km over the distance the log covers. Only
   *  costs in the garage's currency are added up; others are counted. */
  function costs(car, today, currency) {
    const year = today.slice(0, 4);
    const out = { year: 0, all: 0, count: 0, yearCount: 0, other: 0, perKm: null, distance: 0, since: null };
    for (const s of car.services) {
      if (s.cost === null) continue;
      if (s.cur !== currency) { out.other++; continue; }
      out.all += s.cost; out.count++;
      if (s.d.slice(0, 4) === year) { out.year += s.cost; out.yearCount++; }
      if (!out.since || s.d < out.since) out.since = s.d;
    }
    const { list } = points(car, today);
    if (list.length >= 2) {
      const from = out.since && out.since < list[0].d ? list[0] : (list.filter((p) => p.d <= (out.since || list[0].d)).pop() || list[0]);
      out.distance = list[list.length - 1].km - from.km;
      if (out.distance >= 500 && out.all > 0) out.perKm = out.all / out.distance;
    }
    out.all = round2(out.all); out.year = round2(out.year);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * The service-history report and its link
   * ------------------------------------------------------------------ */

  /** The car's history as the buyer will see it: newest first, no
   *  receipts, no costs or notes unless the owner ticks them. Compact, for
   *  the fragment: {v, t:[year, make, model, fuel], o:[km, date], u, g,
   *  s:[[date, km|-1, [items], other, shop, note, cost|-1, cur]]}. */
  function packReport(car, opts) {
    const o = opts || {};
    const today = o.today;
    const pc = paceOf(car, today);
    const svcs = car.services.slice().sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0)).slice(0, LIMITS.reportServices);
    const rep = {
      v: 1,
      t: [car.year || 0, car.make || '', car.model || '', car.fuel],
      o: pc.latest ? [Math.round(pc.latest.km), pc.latest.d] : [-1, ''],
      u: UNITS.indexOf(o.units) >= 0 ? o.units : 'mi',
      g: today,
      s: svcs.map((s) => [s.d, s.km === null ? -1 : Math.round(s.km), s.items.slice(), s.other || '', s.shop || '', o.notes ? (s.note || '') : '', o.costs && s.cost !== null ? s.cost : -1, o.costs && s.cost !== null ? s.cur : '']),
    };
    if (!rep.t[1] && !rep.t[2]) rep.t[2] = clean(car.nick, LIMITS.nick);
    return rep;
  }
  /** The decoded link, cleaned field by field. null when it is not a
   *  report. Never trusts a length, a type or an id it was given. */
  function cleanReport(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return null;
    if (!Array.isArray(raw.t) || !Array.isArray(raw.s) || !raw.s.length) return null;
    if (!isDate(raw.g)) return null;
    const year = Number.isInteger(raw.t[0]) && raw.t[0] >= 1900 && raw.t[0] <= 2100 ? raw.t[0] : null;
    const make = cleanText(raw.t[1], LIMITS.make);
    const model = cleanText(raw.t[2], LIMITS.model);
    if (!make && !model) return null;
    const fuel = FUELS.indexOf(raw.t[3]) >= 0 ? raw.t[3] : null;
    const odo = Array.isArray(raw.o) && finite(raw.o[0]) && raw.o[0] >= 0 && raw.o[0] <= LIMITS.maxKm && isDate(raw.o[1]) ? { km: raw.o[0], d: raw.o[1] } : null;
    const services = [];
    for (const r of raw.s.slice(0, LIMITS.reportServices)) {
      if (!Array.isArray(r) || !isDate(r[0])) continue;
      const items = [];
      for (const id of (Array.isArray(r[2]) ? r[2] : []).slice(0, 40)) if (item(id) && items.indexOf(id) < 0 && items.length < LIMITS.itemsPerService) items.push(id);
      const other = clean(r[3], LIMITS.other);
      if (!items.length && !other) continue;
      services.push({
        d: r[0],
        km: finite(r[1]) && r[1] >= 0 && r[1] <= LIMITS.maxKm ? r[1] : null,
        items, other,
        shop: clean(r[4], LIMITS.shop),
        note: clean(r[5], LIMITS.note),
        cost: finite(r[6]) && r[6] >= 0 && r[6] <= LIMITS.maxCost ? round2(r[6]) : null,
        cur: cleanCur(r[7]),
      });
    }
    if (!services.length) return null;
    services.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
    return { v: 1, year, make, model, fuel, odo, units: UNITS.indexOf(raw.u) >= 0 ? raw.u : 'mi', made: raw.g, services };
  }

  function b64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64url(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
    try {
      const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) { return null; }
  }
  const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function' && typeof Blob === 'function' && typeof Response === 'function';
  async function readCapped(stream, max) {
    const reader = stream.getReader();
    const parts = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) { try { await reader.cancel(); } catch (e) { /* ignore */ } throw new Error('too big'); }
      parts.push(value);
    }
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  async function encodeOnce(rep, plain) {
    const bytes = new TextEncoder().encode(JSON.stringify(rep));
    if (plain) return 'v1.p.' + b64url(bytes);
    const z = await readCapped(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')), LIMITS.inflated * 4);
    return 'v1.z.' + b64url(z);
  }
  /** The report -> the part after '#': 'v1.z.<deflate, base64url>' when the
   *  browser can compress, else 'v1.p.<utf-8 JSON, base64url>'. Too long
   *  for a link: the oldest services are left off (`dropped` says how many). */
  async function encodeReport(rep, opts) {
    const plain = (opts && opts.plain) || !canCompress();
    let r = rep;
    let frag = await encodeOnce(r, plain);
    while (frag.length > LIMITS.fragment && r.s.length > 1) {
      r = Object.assign({}, r, { s: r.s.slice(0, Math.max(1, Math.floor(r.s.length * 0.85))) });
      frag = await encodeOnce(r, plain);
    }
    if (frag.length > LIMITS.fragment) return null;
    return { frag, kept: r.s.length, dropped: rep.s.length - r.s.length };
  }
  /** '#…' or '…' -> a clean report, or null for anything else. Never throws. */
  async function decodeReport(fragment) {
    try {
      let s = typeof fragment === 'string' ? fragment : '';
      if (s.charAt(0) === '#') s = s.slice(1);
      if (!s || s.length > LIMITS.fragment) return null;
      const m = /^v1\.([zp])\.([A-Za-z0-9_-]+)$/.exec(s);
      if (!m) return null;
      const bytes = unb64url(m[2]);
      if (!bytes || !bytes.length) return null;
      let data;
      if (m[1] === 'z') {
        if (!canCompress()) return null;
        data = await readCapped(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')), LIMITS.inflated);
      } else {
        if (bytes.length > LIMITS.inflated) return null;
        data = bytes;
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      return cleanReport(JSON.parse(text));
    } catch (e) { return null; }
  }
  /** The report drawn as HTML. Every string escaped; costs only when the
   *  owner included them. Used by the buyer's page and the owner's preview. */
  function reportHtml(rep, opts) {
    const o = opts || {};
    const units = UNITS.indexOf(o.units) >= 0 ? o.units : rep.units;
    const region = o.region || 'US';
    const today = rep.made;
    const title = [rep.year, rep.make, rep.model].filter(Boolean).join(' ');
    const svcs = rep.services;
    const first = svcs[svcs.length - 1]; const last = svcs[0];
    const kmTxt = (km) => (km === null ? '' : dist(km, units));
    let h = '<header class="rep-head"><p class="eyebrow">Service history</p><h1>' + esc(title) + '</h1><p class="rep-sub">' +
      esc([rep.fuel ? fuelWord(rep.fuel, region) : '', rep.odo ? 'Odometer ' + dist(rep.odo.km, units) + ' on ' + dateLabel(rep.odo.d) : ''].filter(Boolean).join(' · ')) + '</p></header>';
    h += '<div class="rep-stats"><div><b>' + esc(String(svcs.length)) + '</b><span>' + (svcs.length === 1 ? 'entry' : 'entries') + ' logged</span></div><div><b>' + esc(monthLabel(first.d)) + '</b><span>first entry</span></div><div><b>' + esc(monthLabel(last.d)) + '</b><span>latest entry</span></div></div>';
    // The things a buyer asks about, at a glance.
    const KEY = ['oil', 'tyres', 'brakes', 'timing', 'battery', 'brakefluid', 'coolant', 'inspection'];
    const rows = [];
    for (const id of KEY) {
      const hits = svcs.filter((s) => s.items.indexOf(id) >= 0);
      if (!hits.length) continue;
      const it = item(id);
      rows.push('<li><span class="rk">' + esc(it.emoji) + ' ' + esc(spell(it.short, region)) + (hits.length > 1 ? ' <span class="muted">×' + hits.length + '</span>' : '') + '</span><span class="rv">Last ' + esc(dateLabel(hits[0].d)) + (hits[0].km !== null ? ' at ' + esc(kmTxt(hits[0].km)) : '') + '</span></li>');
    }
    if (rows.length) h += '<section class="rep-key"><h2>At a glance</h2><ul>' + rows.join('') + '</ul></section>';
    h += '<section class="rep-log"><h2>Every entry</h2><ol class="rep-list">' + svcs.map((s) => {
      const names = s.items.map((id) => esc(spell(item(id).name, region)));
      if (s.other) names.push(esc(s.other));
      return '<li><div class="rl-when"><b>' + esc(dateLabel(s.d)) + '</b>' + (s.km !== null ? '<span>' + esc(kmTxt(s.km)) + '</span>' : '<span class="muted">mileage not noted</span>') + '</div><div class="rl-what"><p class="rl-items">' + names.join(' · ') + '</p>' +
        (s.shop ? '<p class="rl-shop">' + esc(s.shop) + '</p>' : '') + (s.note ? '<p class="rl-note">' + esc(s.note) + '</p>' : '') +
        (s.cost !== null && s.cur ? '<p class="rl-cost">' + esc(money(s.cost, s.cur)) + '</p>' : '') + '</div></li>';
    }).join('') + '</ol></section>';
    h += '<p class="rep-foot small">Kept by the owner in Glovebox and shared on ' + esc(dateLabel(today)) + '. It’s the owner’s own record, not checked by a garage - ask to see the receipts, and have the car inspected before you buy.</p>';
    return h;
  }

  /* ------------------------------------------------------------------ *
   * The calendar: one all-day event per item due in the next year
   * ------------------------------------------------------------------ */

  function icsText(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  /** Fold at 75 octets, never inside a UTF-8 character (RFC 5545 3.1). */
  function fold(line) {
    const enc = new TextEncoder();
    const out = []; let cur = ''; let n = 0;
    for (const ch of Array.from(line)) {
      const b = enc.encode(ch).length;
      if (n + b > 75) { out.push(cur); cur = ' '; n = 1; }
      cur += ch; n += b;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  function icsFor(cars, opts) {
    const o = opts || {};
    const today = o.today; const units = o.units || 'mi';
    const to = addDays(today, (o.days || LIMITS.icsDays) - 1);
    const stamp = new Date(o.now || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Glovebox//Car care//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Glovebox'];
    let n = 0;
    for (const car of cars) {
      const b = board(car, today);
      for (const st of b.overdue.concat(b.soon, b.coming, b.good)) {
        let d = st.due;
        if (!d || d > to) continue;
        if (d < today) d = today;
        const name = spell(st.item.name, o.region);
        const desc = [
          dueText(st, units, today) + '.',
          st.item.kind === 'date' ? 'The date you gave Glovebox.' : dueRule(st, units, today) + '.',
          st.projected ? 'The date is projected from your driving (' + lower(paceText(b.pace, units)) + ') - it moves if you drive more or less.' : '',
          '',
          'From Glovebox - a snapshot of the plan. Your owner’s manual wins.',
        ].filter((x, i) => x || i === 3).join('\n');
        const ymd = d.replace(/-/g, '');
        lines.push('BEGIN:VEVENT', 'UID:glovebox-' + car.id + '-' + st.item.id + '-' + ymd + '@glovebox.local', 'DTSTAMP:' + stamp,
          'DTSTART;VALUE=DATE:' + ymd, 'DTEND;VALUE=DATE:' + addDays(d, 1).replace(/-/g, ''),
          'SUMMARY:' + icsText('🔧 ' + name + ' - ' + carName(car)), 'DESCRIPTION:' + icsText(desc), 'TRANSP:TRANSPARENT', 'END:VEVENT');
        n++;
      }
    }
    lines.push('END:VCALENDAR');
    return { text: lines.map(fold).join('\r\n') + '\r\n', events: n };
  }

  /* ------------------------------------------------------------------ *
   * Settings, export / import
   * ------------------------------------------------------------------ */

  function cleanSettings(raw, locale) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const region = regionOf(locale);
    const unitsAuto = s.unitsAuto !== false;
    const curAuto = s.curAuto !== false;
    return {
      region,
      unitsAuto,
      units: unitsAuto ? unitsFor(region) : (UNITS.indexOf(s.units) >= 0 ? s.units : unitsFor(region)),
      curAuto,
      currency: curAuto ? currencyFor(region) : (cleanCur(s.currency) || currencyFor(region)),
    };
  }
  function exportGarage(garage, now) {
    return JSON.stringify({ app: 'glovebox', v: 1, exportedAt: new Date(now || Date.now()).toISOString(), settings: { units: garage.settings.units, unitsAuto: garage.settings.unitsAuto, currency: garage.settings.currency, curAuto: garage.settings.curAuto }, cars: garage.cars }, null, 1);
  }
  /** A file someone picked -> a clean garage, or an Error with a sentence.
   *  Every car goes through cleanCar; ids are made unique. */
  function importGarage(text, ctx) {
    if (typeof text !== 'string' || text.length > LIMITS.importBytes) throw err(400, 'That file is too big to be a Glovebox export.');
    let raw;
    try { raw = JSON.parse(text); } catch (e) { throw err(400, 'That file isn’t a Glovebox export (it isn’t JSON).'); }
    if (!raw || typeof raw !== 'object' || raw.app !== 'glovebox' || raw.v !== 1 || !Array.isArray(raw.cars)) throw err(400, 'That file isn’t a Glovebox export.');
    const ids = new Set();
    const cars = [];
    let dropped = 0;
    for (const r of raw.cars.slice(0, LIMITS.cars * 4)) {
      if (cars.length >= LIMITS.cars) break;
      const c = cleanCar(r, ctx);
      if (!c) { dropped++; continue; }
      if (ids.has(c.id)) c.id = newId('c', ctx.rand);
      ids.add(c.id);
      cars.push(c);
    }
    return { settings: cleanSettings(raw.settings, ctx.locale), cars, dropped, over: Math.max(0, raw.cars.length - cars.length - dropped) };
  }

  /* ------------------------------------------------------------------ *
   * The two AI answers. Untrusted: bounded, stripped, ids only if real -
   * and the model's own idea of how urgent something is never reaches the
   * page. Advice always comes from the catalogue.
   * ------------------------------------------------------------------ */

  const SEEN_COLOURS = ['red', 'amber', 'green', 'blue', 'white', 'unknown'];
  // Any sentence that tells someone a warning is fine to drive on, or safe
  // to ignore, is dropped: that is the catalogue's call, never the model's.
  const SAFE_CLAIM = /\b(safe to (drive|ignore|continue|keep)|fine to (drive|ignore|keep)|ok(ay)? to (drive|ignore|keep)|(can|could|may) (safely )?(be )?ignored?|ignore (it|this|that|the)|nothing to worry|no need to (stop|worry|panic)|not (serious|urgent|a problem|dangerous)|keep driving|drive on normally|harmless|urgen\w*|severity|critical)\b/i;
  function scrubSafe(s) { return s.split(/(?<=[.!?])\s+/).filter((x) => !SAFE_CLAIM.test(x)).join(' ').trim(); }
  const SEVERITY = { info: 0, amber: 1, red: 2 };
  const seenGroup = (c) => (c === 'red' ? 'red' : c === 'amber' ? 'amber' : c === 'green' || c === 'blue' ? 'info' : null);
  function cleanOdo(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const v = raw.value;
    if (!finite(v) || v < 0 || v > 1500000) return null;
    const unit = UNITS.indexOf(raw.unit) >= 0 ? raw.unit : null;
    return { value: Math.round(v), unit };
  }
  /** A dashboard photo's answer -> {relevant, lights, odometer, notes}.
   *  Idempotent: the page runs its own answer through it again. A
   *  light shows the catalogue's advice; its group is the MORE serious of the
   *  catalogue's and the colour seen (a check-engine light lit red is
   *  treated as red). */
  function cleanDash(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const out = { relevant: r.relevant !== false, lights: [], odometer: cleanOdo(r.odometer), notes: scrubSafe(clean(r.notes, 300)) };
    const seen = new Set();
    for (const x of (Array.isArray(r.lights) ? r.lights : []).slice(0, 30)) {
      if (!x || typeof x !== 'object') continue;
      const cat = L.light(own(x, 'catalogueId') ? x.catalogueId : x.id);
      const colour = SEEN_COLOURS.indexOf(x.colour) >= 0 ? x.colour : 'unknown';
      const description = scrubSafe(clean(x.description, 120));
      if (!cat && !description) continue;
      const key = cat ? cat.id : 'x:' + description.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let group = cat ? cat.group : (seenGroup(colour) || 'red');
      const sg = seenGroup(colour);
      if (sg && SEVERITY[sg] > SEVERITY[group]) group = sg;
      out.lights.push({ id: cat ? cat.id : null, colour, group, description });
      if (out.lights.length >= 12) break;
    }
    out.lights.sort((a, b) => SEVERITY[b.group] - SEVERITY[a.group]);
    return out;
  }
  /** A receipt's answer -> an editable service entry: a date (not in the
   *  future), mileage, shop, items matched to the plan only if real, costs
   *  bounded, a currency from the list. Nothing is saved from here. */
  function cleanReceipt(raw, ctx) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const today = ctx.today;
    const out = { relevant: r.relevant !== false, date: null, mileage: null, shop: clean(r.shop, LIMITS.shop), items: [], total: cleanCost(r.total), currency: cleanCur(typeof r.currency === 'string' ? r.currency.toUpperCase() : null) };
    if (isDate(r.date) && r.date <= today && r.date >= '1990-01-01') out.date = r.date;
    out.mileage = r.mileage && typeof r.mileage === 'object' ? cleanOdo(r.mileage) : cleanOdo({ value: r.mileage, unit: r.mileageUnit });
    for (const x of (Array.isArray(r.items) ? r.items : []).slice(0, 40)) {
      if (!x || typeof x !== 'object') continue;
      const it = item(own(x, 'catalogueItem') ? x.catalogueItem : x.item);
      const description = clean(x.description, LIMITS.other);
      if (!it && !description) continue;
      out.items.push({ item: it ? it.id : null, description: description || it.name, cost: cleanCost(x.cost) });
      if (out.items.length >= 20) break;
    }
    return out;
  }

  return {
    LIMITS, ITEMS, ITEM_IDS, BANDS, FUELS, FUEL_LABEL, BELTS, UNITS, CURRENCIES, KM_PER_MI, DEFAULT_KM_PER_YEAR, SEEN_COLOURS, Lights: L,
    clean, cleanText, esc, plural, nameList, newId, isCarId, isSvcId, hash32, capital, lower,
    isDate, cleanTz, localDate, addDays, addMonths, daysBetween, dateLabel, monthLabel, inWords, agoWords,
    toKm, fromKm, dist, roughly, num, regionOf, unitsFor, currencyFor, money, spell, fuelWord,
    item, applies, intervalOf, itemsFor, cleanCar, cleanService, newCar, carName, carTitle,
    points, paceOf, kmAt, paceText, lastDone, statusOf, board, dueText, dueRule, headline,
    act, undo, costs,
    packReport, cleanReport, encodeReport, decodeReport, reportHtml, b64url, unb64url, canCompress,
    icsFor, cleanSettings, exportGarage, importGarage,
    cleanDash, cleanReceipt, scrubSafe,
  };
});
