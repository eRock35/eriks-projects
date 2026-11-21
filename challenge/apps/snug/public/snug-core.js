/* Snug - the rules. One file, run three times: in the page
 * (window.SnugCore), in the server (require) and in the tests. No clock and
 * no dice: "today", every time stamp and every id are passed in.
 *
 *   - the text door: what may be kept, refused (never cleaned) - an @ in any
 *     width, nine digits in any script, a phone or card number, a link, a
 *     formula, markup, invisible characters, and any code or password
 *   - days and months
 *   - the home: a few chips about it (never an address, never a location)
 *   - the 44 jobs, each with why, how, how long and whether it is a pro's
 *   - the plan: when each job is next due, Overdue / This week / This month,
 *     the on-time ring, the Winter-ready checklist, the landlord's note
 *   - the breaker panel: spaces, circuits, search, the door label
 *   - house facts and appliances
 *   - the one door for a whole home (cleanHome) and bodyProblem
 *   - the calendar file (.ics), built on the phone
 *   - two phones: the merge
 *   - the AI: "Read the label" - the request rebuilt to the image alone, the
 *     answer checked (no serial; prices, recalls, safety verdicts and
 *     "replace it" dropped)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnugCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    name: 40, label: 40, cnote: 80, fact: 160, maker: 40, model: 40, size: 30, filter: 30, anote: 120,
    done: 12, circuits: 80, appliances: 40, spacesMin: 2, spacesMax: 60,
    storedBytes: 200 * 1024,
    aiImageBytes: 2.5 * 1024 * 1024, aiImageSide: 1600, aiDropped: 16,
  };

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
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function nf(s) { s = str(s); try { return s.normalize('NFKC'); } catch (e) { return s; } }
  /** For matching: lower case, accents off, letters and digits only. */
  function fold(s) { var t = nf(s).toLowerCase(); try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* old engines */ } return t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(o) { return Boolean(o) && typeof o === 'object' && !Array.isArray(o); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function list(xs) { return xs.length <= 1 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  var AT_ANY = new RegExp('[@' + String.fromCharCode(0xFF20, 0xFE6B) + ']');
  function hasAt(s) { return AT_ANY.test(str(s)) || /@/.test(nf(s)); }
  var LINK = /(https?:|ftp:|mailto:|www\.|:\/\/|\b[a-z0-9-]{2,}\.(com|net|org|io|co|uk|us|app|dev|ly|me|info|biz|tv|gg|xyz|shop|store|site|online|link|home)\b)/i;
  function hasLink(s) { return LINK.test(nf(s)); }
  /** Seven or more digits - in any script - in one run of digits and phone
   *  punctuation. */
  function hasPhone(s) { return (nf(s).match(/\+?\p{Nd}[\p{Nd}\s().\/-]{5,}\p{Nd}/gu) || []).some(function (m) { return m.replace(/[^\p{Nd}]/gu, '').length >= 7; }); }
  /** Nine digits in a row, in any script (NFKC folds the full-width ones;
   *  \p{Nd} catches Arabic-Indic, Devanagari and the rest - JavaScript's \d
   *  is ASCII only). */
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
  /** A street address: a house number then a street word, or a box/unit.
   *  Snug never keeps where the home is. */
  var STREET = /(^|[^\p{L}\p{N}])\p{Nd}{1,6}[a-z]?\s+(?:[\p{L}'.-]+\s+){0,3}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct|way|place|pl|terrace|close|crescent|highway|hwy|parkway|pkwy|square|sq|circle|cir)\b/iu;
  function hasAddress(s) { var t = nf(s); return STREET.test(t) || /\b(p\.?\s?o\.?\s?box|apt\.?\s*#?\p{Nd}|suite\s*#?\p{Nd}|unit\s*#?\p{Nd}|zip\s*(code)?\s*\p{Nd}|postcode)/iu.test(t); }
  /** A code or a password: the wifi, the alarm, the gate, the lockbox, the
   *  garage door. Snug keeps none - a house manual left on a counter is read
   *  by everyone who comes in. */
  var CODE_WORD = /\b(pass(word|code|phrase)s?|pin ?(number|code)|wi-?fi ?(key|password)|alarm ?code|gate ?code|door ?code|garage ?code|entry ?code|key ?code|lock ?box|key ?safe|lock combination|security ?code|access ?code|disarm)\b/i;
  function hasCode(s) { var t = nf(s); return CODE_WORD.test(t) || /\b(code|pin)\b[^\p{L}]{0,6}[\p{L}\p{Nd}-]*\p{Nd}{3,}/iu.test(t); }
  function isFormula(s) { s = str(s); return /^[\t\r]/.test(s) || /^\s*[=+\-@]/.test(nf(s)); }
  function hasInvisible(s) { return BAD1.test(str(s)); }
  function hasMarkup(s) { return /[<>]/.test(str(s)); }

  var WHY = {
    invisible: 'That has an invisible character in it - type it again.',
    markup: 'Leave out < and > - Snug keeps plain words.',
    at: 'That looks like an email address - Snug never keeps one.',
    link: 'That looks like a link - Snug keeps plain words.',
    formula: 'Start it with a letter or a number - a leading = + - or @ is how a spreadsheet runs a formula.',
    card: 'That looks like a card number - never write one down here.',
    phone: 'That looks like a phone number - keep those in your contacts.',
    nine: 'Nine digits in a row looks like a serial, phone or account number - Snug never keeps one.',
    code: 'That looks like a code or a password - Snug never keeps those. Keep them in your phone’s password manager.',
    address: 'That looks like an address - Snug never keeps where your home is.',
  };
  /** The text door: '' when `s` may be kept, else the sentence that says why
   *  not. Refused, never cleaned - a person re-types it. */
  function refuse(s, max) {
    s = str(s);
    if (hasInvisible(s)) return WHY.invisible;
    if (hasMarkup(s)) return WHY.markup;
    if (hasAt(s)) return WHY.at;
    if (hasLink(s)) return WHY.link;
    if (isFormula(s)) return WHY.formula;
    if (hasCard(s)) return WHY.card;
    if (nineDigits(s)) return WHY.nine;
    if (hasPhone(s)) return WHY.phone;
    if (hasCode(s)) return WHY.code;
    if (hasAddress(s)) return WHY.address;
    if (max && Array.from(s.trim()).length > max) return 'Up to ' + max + ' characters.';
    return '';
  }

  /* ================================================================== *
   * Days and months
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
  function dayOf(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1950 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var n = daysFromCivil(y, mo, d);
    return iso(n) === s ? n : null;
  }
  function isIso(s) { return dayOf(s) !== null; }
  function addDays(s, k) { return iso(dayOf(s) + k); }
  function between(a, b) { return dayOf(b) - dayOf(a); }
  function monthLen(y, m) { return daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - daysFromCivil(y, m, 1); }
  /** The same day of the month, n months on - the 31st of a short month
   *  becomes its last day. */
  function addMonths(s, n) {
    var c = civil(dayOf(s)), t = c.y * 12 + (c.m - 1) + n, y = Math.floor(t / 12), m = (t % 12) + 1;
    return y + '-' + pad2(m) + '-' + pad2(Math.min(c.d, monthLen(y, m)));
  }
  function monthNo(s) { return civil(dayOf(s)).m; }
  function firstOfNext(s) { var c = civil(dayOf(s)); return c.m === 12 ? (c.y + 1) + '-01-01' : c.y + '-' + pad2(c.m + 1) + '-01'; }
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function weekday(n) { return ((n % 7) + 11) % 7; }
  /** "Sat 21 Nov" */
  function dayLabel(s) { var n = dayOf(s); if (n === null) return ''; var c = civil(n); return WD[weekday(n)] + ' ' + c.d + ' ' + MON[c.m - 1]; }
  /** "21 Nov 2026" */
  function dateLabel(s) { var n = dayOf(s); if (n === null) return ''; var c = civil(n); return c.d + ' ' + MON[c.m - 1] + ' ' + c.y; }
  /** "October 2025" */
  function monthLabel(s) { var n = dayOf(s); if (n === null) return ''; var c = civil(n); return MON_LONG[c.m - 1] + ' ' + c.y; }
  function monthsText(ms) { return list(ms.map(function (m) { return MON_LONG[m - 1]; })); }
  /** "every 3 months", "every year", "every 2 years". */
  function everyText(months) {
    if (months === 1) return 'every month';
    if (months % 12 === 0) return months === 12 ? 'every year' : 'every ' + (months / 12) + ' years';
    return 'every ' + months + ' months';
  }
  /** "Due today", "3 days overdue", "Due in 5 days", "Due Sat 12 Dec". */
  function dueText(due, today) {
    var k = between(today, due);
    if (k === 0) return 'Due today';
    if (k < 0) return k === -1 ? '1 day overdue' : (-k > 60 ? Math.round(-k / 30) + ' months overdue' : (-k) + ' days overdue');
    if (k === 1) return 'Due tomorrow';
    if (k <= 13) return 'Due in ' + k + ' days';
    return 'Due ' + dayLabel(due);
  }
  /** Minutes as words: "10 min", "1 hr", "1 hr 30 min", "half a day". */
  function minsText(m) {
    if (m >= 240) return 'half a day';
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return h + ' hr' + (r ? ' ' + r + ' min' : '');
  }

  /* ================================================================== *
   * The home: a few chips. Never an address, never a location.
   * ================================================================== */

  var CHIPS = {
    tenure: { q: 'Do you own it or rent it?', opts: [['own', 'We own it'], ['rent', 'We rent it']] },
    kind: { q: 'What kind of home?', opts: [['house', 'A house'], ['townhouse', 'A townhouse'], ['apartment', 'An apartment or condo']] },
    heat: { q: 'How is it heated?', opts: [['furnace', 'Furnace (warm air from vents)'], ['heatpump', 'Heat pump'], ['boiler', 'Boiler and radiators'], ['electric', 'Electric heaters'], ['other', 'Something else']] },
    cool: { q: 'How is it cooled?', opts: [['central', 'Central air'], ['window', 'Window or wall units'], ['none', 'No air conditioning'], ['heatpump', 'The heat pump']] },
    water: { q: 'Hot water from…', opts: [['tank', 'A water heater tank'], ['tankless', 'A tankless heater'], ['building', 'The building - not ours']] },
    gas: { q: 'Any gas in the home?', opts: [['yes', 'Yes - gas or propane'], ['no', 'No - all electric']] },
    climate: { q: 'Winters where you are…', opts: [['cold', 'Freeze hard'], ['mild', 'Are mild'], ['hot', 'Barely happen']] },
  };
  var FEATURES = [
    ['gutters', 'Gutters'], ['fireplace', 'Fireplace or wood stove'], ['garage', 'Garage door'], ['laundry', 'Washer and dryer'],
    ['dishwasher', 'Dishwasher'], ['icemaker', 'Fridge with water or ice'], ['fans', 'Ceiling fans'], ['sump', 'Sump pump'],
    ['septic', 'Septic tank'], ['well', 'Well water'], ['sprinklers', 'Lawn sprinklers'],
  ];
  var FEATURE_IDS = FEATURES.map(function (f) { return f[0]; });
  function optIds(k) { return CHIPS[k].opts.map(function (o) { return o[0]; }); }
  function chipLabel(k, v) { var o = CHIPS[k].opts.filter(function (x) { return x[0] === v; })[0]; return o ? o[1] : ''; }
  function featureLabel(id) { var f = FEATURES.filter(function (x) { return x[0] === id; })[0]; return f ? f[1] : ''; }
  function defaultProfile() {
    return { name: 'Our home', tenure: 'own', kind: 'house', heat: 'furnace', cool: 'central', water: 'tank', gas: 'yes', climate: 'cold', has: ['gutters', 'laundry', 'dishwasher'], since: null };
  }
  function hasF(p, f) { return p.has.indexOf(f) >= 0; }

  /** What a job needs of the home, by name. */
  var COND = {
    ducted: function (p) { return p.heat === 'furnace' || p.heat === 'heatpump' || p.cool === 'central'; },
    furnace: function (p) { return p.heat === 'furnace'; },
    heatpump: function (p) { return p.heat === 'heatpump' || p.cool === 'heatpump'; },
    central: function (p) { return p.cool === 'central'; },
    outdoorUnit: function (p) { return p.cool === 'central' || p.heat === 'heatpump' || p.cool === 'heatpump'; },
    boiler: function (p) { return p.heat === 'boiler'; },
    window: function (p) { return p.cool === 'window'; },
    tank: function (p) { return p.water === 'tank'; },
    tankless: function (p) { return p.water === 'tankless'; },
    coAlarm: function (p) { return p.gas === 'yes' || hasF(p, 'fireplace') || hasF(p, 'garage'); },
    cold: function (p) { return p.climate === 'cold'; },
    ground: function (p) { return p.kind !== 'apartment'; },
    house: function (p) { return p.kind === 'house'; },
  };
  FEATURE_IDS.forEach(function (f) { COND[f] = function (p) { return hasF(p, f); }; });

  /* ================================================================== *
   * The 44 jobs. Rule-based, in our own words. `every` is in months;
   * `months` pins a seasonal job to the months it belongs in; `pro` is
   * diy (do it yourself), either, or pro (book someone); `mins` is how
   * long it takes a first-timer; `landlord` marks a renter's landlord's
   * job; `winter` puts it on the Winter-ready checklist. Listed in the
   * order a first round should go: safety first.
   * ================================================================== */

  var AREAS = { safety: 'Safety', heat: 'Heating and cooling', water: 'Water', kitchen: 'Kitchen and laundry', outside: 'Outside' };
  var JOBS = [
    // ---- safety ----
    { id: 'smoke-test', area: 'safety', title: 'Test the smoke alarms', every: 1, pro: 'diy', mins: 10, need: [],
      why: 'A smoke alarm with a dead battery or a failed sensor gives no warning. A monthly press of the button is the only way to know.',
      how: ['Press and hold the test button on each alarm until it sounds.', 'One that is quiet or weak gets a new battery today.', 'Vacuum the vents on the cover while you are up there.'] },
    { id: 'smoke-battery', area: 'safety', title: 'Change the smoke alarm batteries', every: 12, months: [11], pro: 'diy', mins: 20, need: [], winter: true,
      why: 'Batteries fade before they die, and the low-battery chirp always starts at night. Once a year, all at once, on a day you will remember.',
      how: ['Twist each alarm off its base and swap the battery.', 'Sealed ten-year alarms have no battery to change - skip those.', 'Test each one as it goes back up.'] },
    { id: 'co-test', area: 'safety', title: 'Test the carbon monoxide alarms', every: 1, pro: 'diy', mins: 5, need: ['coAlarm'], winter: true,
      why: 'Carbon monoxide has no smell. Anything that burns fuel - a furnace, a fireplace, a car in an attached garage - can make it, and the alarm is the only thing that notices.',
      how: ['Press and hold the test button until it beeps.', 'There should be one on every sleeping floor and near the bedrooms.', 'Note the replace-by date on the back; most last seven to ten years.'] },
    { id: 'alarms-age', area: 'safety', title: 'Replace smoke alarms over ten years old', every: 120, pro: 'either', mins: 45, need: [], landlord: true, ask: 'replacing any smoke alarms over ten years old',
      why: 'The sensor inside a smoke alarm wears out after about ten years even when the test button still beeps.',
      how: ['Look for the date printed on the back of each alarm.', 'Replace any older than ten years with the same kind (battery, or wired to the house).', 'Wired ones are a quick electrician job if you are not sure.'] },
    { id: 'extinguisher', area: 'safety', title: 'Check the fire extinguisher', every: 12, pro: 'diy', mins: 5, need: [],
      why: 'A kitchen fire is the one you are most likely to meet, and an extinguisher with a flat gauge is just a heavy can.',
      how: ['Check the needle is in the green.', 'Make sure the pin and seal are in place and it is where everyone can find it.', 'No extinguisher? Get one for the kitchen.'] },
    { id: 'gfci', area: 'safety', title: 'Test the GFCI outlets', every: 6, pro: 'diy', mins: 10, need: [],
      why: 'The outlets with TEST and RESET buttons, near water, cut the power before a shock can hurt anyone - if they still work.',
      how: ['Plug in a lamp and press TEST: the lamp should go off.', 'Press RESET to bring it back.', 'One that will not trip or reset needs an electrician.'] },
    { id: 'panel-look', area: 'safety', title: 'Look over the breaker panel', every: 12, pro: 'diy', mins: 20, need: [],
      why: 'Knowing which breaker is which is what you want in the dark with water on the floor. A yearly look also catches a warm or buzzing breaker early.',
      how: ['Open the panel door - never the cover behind it.', 'Check every breaker has a label; fill in the panel map in Snug.', 'A breaker that is warm, buzzing or smells hot is an electrician’s job, today.'] },
    { id: 'emergency-kit', area: 'safety', title: 'Refresh the emergency kit', every: 12, months: [9, 10], pro: 'diy', mins: 30, need: [], winter: true,
      why: 'A power cut is when you find out the flashlight batteries are flat. Once a year before the storms, check the box.',
      how: ['Flashlights and fresh batteries, a radio, water, a first-aid kit.', 'Make sure everyone knows where it is.', 'Put the main shutoffs in Snug’s house facts while you think of it.'] },

    // ---- heating and cooling ----
    { id: 'furnace-filter', area: 'heat', title: 'Change the furnace filter', every: 3, pro: 'diy', mins: 10, need: ['ducted'],
      why: 'A clogged filter makes the system work harder for less heat, and is the most common reason a furnace shuts itself off.',
      how: ['Turn the thermostat off.', 'Slide out the old filter beside the furnace and read the size printed on its edge.', 'Put the new one in with the arrow pointing toward the furnace.'] },
    { id: 'furnace-service', area: 'heat', title: 'Book the furnace tune-up', every: 12, months: [9, 10], pro: 'pro', mins: 90, need: ['furnace'], landlord: true, winter: true, ask: 'the yearly furnace tune-up',
      why: 'A yearly check before the cold catches a cracked part or a dirty burner while it is cheap, and before the first cold night.',
      how: ['Book a heating technician in early autumn, before they are busy.', 'Ask them to check the burner, the flue and the safety switches.', 'Change the filter the same day.'] },
    { id: 'heatpump-service', area: 'heat', title: 'Book the heat pump service', every: 12, months: [9, 10], pro: 'pro', mins: 90, need: ['heatpump'], landlord: true, winter: true, ask: 'the yearly heat pump service',
      why: 'A heat pump does the heating and the cooling, so it works all year. A yearly service keeps the refrigerant and the defrost cycle right.',
      how: ['Book a technician before the heating season.', 'Clear the outdoor unit so they can reach it.', 'Clean or change the indoor filter the same day.'] },
    { id: 'ac-service', area: 'heat', title: 'Book the air conditioning tune-up', every: 12, months: [4, 5], pro: 'pro', mins: 60, need: ['central'], landlord: true, ask: 'the yearly air conditioning tune-up',
      why: 'The first hot week is when every technician is booked. A spring check finds a weak part before it fails in a heatwave.',
      how: ['Book in spring.', 'Clear leaves and plants back from the outdoor unit.', 'Change the furnace filter: the air conditioning uses it too.'] },
    { id: 'condenser-clear', area: 'heat', title: 'Clear around the outdoor unit', every: 6, months: [4, 10], pro: 'diy', mins: 15, need: ['outdoorUnit'],
      why: 'The outdoor unit breathes through its fins. Leaves, grass and snow piled against it make it run hot and long.',
      how: ['Pull leaves and weeds away - two feet of space all round.', 'Rinse the fins gently with a hose from the inside out (power off first).', 'Never cover a heat pump in winter; it is still working.'] },
    { id: 'boiler-service', area: 'heat', title: 'Book the boiler service', every: 12, months: [9, 10], pro: 'pro', mins: 90, need: ['boiler'], landlord: true, winter: true, ask: 'the yearly boiler service',
      why: 'A boiler burns fuel and holds water under pressure. A yearly service checks both, and is often a condition of its warranty.',
      how: ['Book a heating engineer before the cold.', 'Have them check the pressure, the flue and the safety valve.', 'Bleed the radiators after it runs.'] },
    { id: 'radiators-bleed', area: 'heat', title: 'Bleed the radiators', every: 12, months: [10, 11], pro: 'diy', mins: 30, need: ['boiler'], winter: true,
      why: 'Air trapped at the top of a radiator leaves it cold at the top and makes the whole system work harder.',
      how: ['With the heating on and warm, hold a cloth under the small valve at the top.', 'Turn it a quarter turn with a radiator key until water, not air, comes out.', 'Check the boiler pressure afterwards and top it up if it dropped.'] },
    { id: 'vents-clear', area: 'heat', title: 'Vacuum the vents and return grilles', every: 6, pro: 'diy', mins: 20, need: ['ducted'],
      why: 'Dust on the grilles goes straight back into the filter, and a vent hidden behind a sofa leaves a room cold.',
      how: ['Vacuum each supply vent and the big return grilles.', 'Move furniture and rugs off any vent.', 'Leave every vent at least partly open.'] },
    { id: 'fans-winter', area: 'heat', title: 'Switch the ceiling fans to winter', every: 12, months: [11], pro: 'diy', mins: 5, need: ['fans'], winter: true,
      why: 'Run slowly clockwise, a ceiling fan pushes the warm air that rises back down along the walls.',
      how: ['Stop the fan and find the small switch on its body.', 'Flip it so the blades turn clockwise.', 'Run it on low.'] },
    { id: 'fans-summer', area: 'heat', title: 'Switch the ceiling fans to summer', every: 12, months: [5], pro: 'diy', mins: 5, need: ['fans'],
      why: 'Counter-clockwise, a fan sends a breeze straight down - it feels a few degrees cooler without touching the thermostat.',
      how: ['Stop the fan and flip the switch on its body.', 'The blades should turn counter-clockwise from below.', 'Dust the tops of the blades while it is stopped.'] },
    { id: 'chimney', area: 'heat', title: 'Book the chimney sweep', every: 12, months: [8, 9, 10], pro: 'pro', mins: 90, need: ['fireplace'], landlord: true, winter: true, ask: 'the yearly chimney sweep and inspection',
      why: 'Burning wood leaves a tar inside the chimney that can catch fire. A sweep also checks for nests and cracks before the first fire.',
      how: ['Book a chimney sweep in late summer.', 'Do not light a fire until it has been checked.', 'Test the carbon monoxide alarm the same week.'] },
    { id: 'window-ac-filter', area: 'heat', title: 'Wash the window unit filters', every: 1, months: [5, 6, 7, 8, 9], pro: 'diy', mins: 10, need: ['window'],
      why: 'A window unit’s filter clogs fast in summer, and a clogged one cools less and freezes up.',
      how: ['Unplug the unit and slide out the filter behind the front grille.', 'Rinse it in warm water and let it dry.', 'Put it back before you plug it in.'] },

    // ---- water ----
    { id: 'water-main', area: 'water', title: 'Find and turn the main water shutoff', every: 12, pro: 'diy', mins: 10, need: [],
      why: 'When a pipe bursts, the minutes it takes to find the shutoff are the expensive ones. A valve that is never turned can seize.',
      how: ['Find it: usually where the water pipe comes in - a basement wall, under the kitchen sink, a closet.', 'Turn it off and on again once.', 'Write where it is in Snug’s house facts and show everyone.'] },
    { id: 'leaks', area: 'water', title: 'Check under the sinks for drips', every: 3, pro: 'diy', mins: 10, need: [],
      why: 'A slow drip inside a cabinet rots the floor for months before anyone sees it.',
      how: ['Empty the cabinet under each sink and feel the pipes and the floor.', 'A damp patch or a ring of water is a leak - tighten the nut by hand, or call a plumber.', 'Check behind the toilet and the washing machine while you are at it.'] },
    { id: 'toilets', area: 'water', title: 'Check the toilets for leaks and wobbles', every: 6, pro: 'diy', mins: 15, need: [],
      why: 'A running toilet can waste more water than a shower a day, and a wobbling one is breaking its seal to the floor.',
      how: ['Put a few drops of food colouring in the tank and wait 15 minutes without flushing.', 'Colour in the bowl means the flapper leaks - an easy part to change.', 'Rock the toilet gently; if it moves, it needs re-seating.'] },
    { id: 'wh-flush', area: 'water', title: 'Drain the sediment from the water heater', every: 12, pro: 'either', mins: 60, need: ['tank'], landlord: true, ask: 'the yearly water heater flush',
      why: 'Minerals settle at the bottom of the tank, make it rumble, waste energy and shorten its life.',
      how: ['Turn the heater to "vacation" or off (and the power off, if electric).', 'Run a hose from the drain valve at the bottom to a drain and let a few buckets out until it runs clear.', 'Close the valve, refill, and turn it back on.'] },
    { id: 'wh-relief', area: 'water', title: 'Test the water heater relief valve', every: 12, pro: 'either', mins: 10, need: ['tank'], landlord: true, ask: 'a test of the water heater relief valve',
      why: 'The relief valve is what stops a tank from building too much pressure. One that is stuck is the dangerous kind of broken.',
      how: ['Put a bucket under the pipe from the valve.', 'Lift the lever for a second: hot water should rush out, then stop.', 'If nothing comes out, or it will not stop dripping, call a plumber.'] },
    { id: 'tankless-descale', area: 'water', title: 'Book the tankless heater descale', every: 12, pro: 'pro', mins: 60, need: ['tankless'], landlord: true, ask: 'the yearly descale of the tankless water heater',
      why: 'Scale builds up inside a tankless heater, especially with hard water, until it shuts itself off.',
      how: ['Book a plumber, or use the service valves if yours has them.', 'Clean the small inlet filter screen at the same time.', 'Every year with hard water; every two with soft.'] },
    { id: 'hoses-off', area: 'water', title: 'Disconnect the garden hoses', every: 12, months: [10, 11], pro: 'diy', mins: 15, need: ['cold', 'ground'], winter: true,
      why: 'A hose left on traps water in the outdoor tap, which freezes and splits the pipe inside the wall - you find out in spring.',
      how: ['Unscrew every hose and drain it.', 'Shut the indoor valve to each outdoor tap if there is one, then open the outdoor tap to drain it.', 'Fit a foam cover over each tap.'] },
    { id: 'pipes-insulate', area: 'water', title: 'Wrap the pipes in cold spots', every: 12, months: [10, 11], pro: 'diy', mins: 45, need: ['cold', 'ground'], landlord: true, winter: true, ask: 'insulating the exposed pipes before it freezes',
      why: 'Pipes in a crawl space, a garage or an outside wall are the ones that freeze and burst.',
      how: ['Find pipes in unheated spaces.', 'Slip foam pipe sleeves over them and tape the seams.', 'On the coldest nights, open the cabinet doors under sinks on outside walls.'] },
    { id: 'sump', area: 'water', title: 'Test the sump pump', every: 3, pro: 'diy', mins: 10, need: ['sump'], landlord: true, ask: 'a check of the sump pump',
      why: 'A sump pump sits idle for months, then has one job during the worst storm of the year.',
      how: ['Pour a bucket of water slowly into the pit.', 'The pump should start, empty it and stop.', 'Check the outlet pipe outside is clear and pointing away from the house.'] },
    { id: 'septic', area: 'water', title: 'Book the septic tank pump-out', every: 36, pro: 'pro', mins: 120, need: ['septic'], landlord: true, ask: 'the septic tank pump-out',
      why: 'A septic tank that is never pumped overflows into the drain field - the most expensive repair in this list.',
      how: ['Book a septic service every three years (more often for a big household).', 'Ask them to note the sludge level for next time.', 'Keep wipes, grease and paint out of every drain.'] },
    { id: 'well', area: 'water', title: 'Test the well water', every: 12, pro: 'either', mins: 30, need: ['well'], landlord: true, ask: 'the yearly well water test',
      why: 'Nobody tests a private well but you. Bacteria and nitrates have no taste.',
      how: ['Get a test kit from your local health office or a certified lab.', 'Follow the kit for taking the sample.', 'Test again after a flood or if the taste changes.'] },

    // ---- kitchen and laundry ----
    { id: 'dryer-vent', area: 'kitchen', title: 'Clean the dryer vent duct', every: 12, pro: 'either', mins: 45, need: ['laundry'], landlord: true, ask: 'cleaning the dryer vent duct',
      why: 'Lint in the duct behind the dryer is one of the commonest causes of house fires - and why clothes take two cycles to dry.',
      how: ['Unplug the dryer and pull it out.', 'Disconnect the duct and brush or vacuum it through to the outside flap.', 'Check the flap outside opens freely when the dryer runs.'] },
    { id: 'lint-screen', area: 'kitchen', title: 'Wash the dryer lint screen', every: 3, pro: 'diy', mins: 10, need: ['laundry'],
      why: 'Dryer sheets leave a film on the screen you cannot see, and air stops getting through it.',
      how: ['Pull the screen out and run water over it.', 'If water pools on it, scrub it with a soft brush and dish soap.', 'Let it dry before it goes back.'] },
    { id: 'washer-hoses', area: 'kitchen', title: 'Check the washing machine hoses', every: 12, pro: 'diy', mins: 10, need: ['laundry'], landlord: true, ask: 'checking the washing machine hoses',
      why: 'A burst washer hose lets out water as fast as a tap - all day, if nobody is home.',
      how: ['Pull the washer out and look along both hoses.', 'A bulge, a crack or rust at the ends means new hoses (braided steel ones last longer).', 'Leave four inches behind the machine so they do not kink.'] },
    { id: 'fridge-coils', area: 'kitchen', title: 'Vacuum the fridge coils', every: 12, pro: 'diy', mins: 20, need: [],
      why: 'Dusty coils make the fridge run longer and hotter. Ten minutes with a vacuum helps it last.',
      how: ['Unplug the fridge.', 'Pull off the grille at the bottom front (or find the coils at the back).', 'Vacuum the coils with a brush attachment, then plug it back in.'] },
    { id: 'fridge-filter', area: 'kitchen', title: 'Change the fridge water filter', every: 6, pro: 'diy', mins: 10, need: ['icemaker'],
      why: 'An old filter stops filtering and slows the water to a trickle.',
      how: ['Find the filter inside the fridge or at the bottom grille.', 'Twist it out and the new one in.', 'Run a few glasses of water through before drinking.'] },
    { id: 'hood-filter', area: 'kitchen', title: 'Degrease the range hood filter', every: 3, pro: 'diy', mins: 15, need: [],
      why: 'A greasy hood filter stops pulling the steam and smoke out, and the grease in it can catch.',
      how: ['Pop the metal filter out of the hood.', 'Soak it in hot water with dish soap and a spoon of baking soda, then scrub.', 'Dry it and put it back.'] },
    { id: 'dishwasher-filter', area: 'kitchen', title: 'Clean the dishwasher filter', every: 3, pro: 'diy', mins: 10, need: ['dishwasher'],
      why: 'Most dishwashers have a filter under the bottom rack that nobody mentions. A clogged one leaves grit on the dishes and a smell.',
      how: ['Pull out the bottom rack.', 'Twist out the round filter in the floor of the tub.', 'Rinse it under the tap, scrub the mesh, and twist it back.'] },

    // ---- outside ----
    { id: 'gutters', area: 'outside', title: 'Clean the gutters', every: 6, months: [4, 5, 10, 11], pro: 'either', mins: 120, need: ['gutters', 'ground'], landlord: true, winter: true, ask: 'cleaning the gutters',
      why: 'Blocked gutters spill water down the walls and into the foundation, and in winter they turn into ice dams.',
      how: ['Wait for most of the leaves to fall.', 'From a steady ladder - with someone holding it - scoop out the leaves, then flush with a hose.', 'Check the downspouts run clear and empty away from the house. High roofs are a pro’s job.'] },
    { id: 'roof-look', area: 'outside', title: 'Look over the roof from the ground', every: 12, months: [4, 5], pro: 'diy', mins: 15, need: ['house'], landlord: true, ask: 'a look at the roof',
      why: 'A missing shingle is a small repair. The leak it lets in, a year later, is not.',
      how: ['Walk round the house with binoculars after the winter.', 'Look for missing, lifted or cracked shingles and loose flashing round the chimney.', 'Anything you find is a roofer’s job - stay off the roof.'] },
    { id: 'weatherstrip', area: 'outside', title: 'Check the door and window seals', every: 12, months: [9, 10], pro: 'diy', mins: 30, need: [], landlord: true, winter: true, ask: 'fixing the draughty seals on the doors',
      why: 'A gap under a door lets out as much heat as a small open window, all winter.',
      how: ['On a windy day, hold your hand round each outside door and window.', 'Replace worn foam or rubber strips - they press in or screw on.', 'A door sweep fixes the gap at the bottom.'] },
    { id: 'garage-door', area: 'outside', title: 'Test the garage door safety reverse', every: 6, pro: 'diy', mins: 10, need: ['garage'], landlord: true, ask: 'a check of the garage door safety reverse',
      why: 'An automatic garage door is the heaviest moving thing in most homes. It must reverse when something is in the way.',
      how: ['Lay a roll of paper towels flat where the door closes.', 'Close the door: it should touch it and go back up.', 'Wave a broom through the beam by the floor while it closes: it should reverse. If not, call a technician.'] },
    { id: 'sprinklers', area: 'outside', title: 'Winterize the sprinklers', every: 12, months: [10], pro: 'pro', mins: 60, need: ['sprinklers', 'cold'], landlord: true, winter: true, ask: 'winterizing the lawn sprinklers',
      why: 'Water left in sprinkler pipes freezes and splits them underground.',
      how: ['Shut off the water to the sprinklers.', 'Book a blow-out: compressed air pushes the water out of the lines.', 'Turn the controller to off for the winter.'] },
    { id: 'snow-ready', area: 'outside', title: 'Get the shovel and ice melt ready', every: 12, months: [11], pro: 'diy', mins: 15, need: ['cold', 'ground'], winter: true,
      why: 'The first snow always comes the morning you have somewhere to be.',
      how: ['Find the shovel and check the blade.', 'Buy ice melt that is kind to concrete and pets.', 'Put both by the door you use most.'] },
  ];
  var JOB = {};
  JOBS.forEach(function (j, i) { j.rank = i; JOB[j.id] = j; });
  var PRO = { diy: 'Do it yourself', either: 'Yourself or a pro', pro: 'Book a pro' };

  function applies(job, p) { return job.need.every(function (c) { return COND[c](p); }); }
  function jobsFor(p) { return JOBS.filter(function (j) { return applies(j, p); }); }
  /** A renter's landlord's job. */
  function landlords(job, p) { return p.tenure === 'rent' && Boolean(job.landlord); }

  /* ================================================================== *
   * The plan
   * ================================================================== */

  /** Move a date forward to the first day of the next month the job
   *  belongs in. */
  function fitMonths(d, months) {
    if (!months) return d;
    for (var i = 0; i < 13 && months.indexOf(monthNo(d)) < 0; i++) d = firstOfNext(d);
    return d;
  }
  function lastDone(rec) { return rec && rec.done && rec.done.length ? rec.done[rec.done.length - 1] : null; }
  /**
   * When a job is next due. Done before: its interval on from the last
   * time, moved into its season. Never done here: the first round is spread
   * over eight weeks, six jobs a week, safety first - so a new home is not
   * 44 jobs due today. "Not now" moves it to the day chosen.
   */
  function dueOf(job, rec, today, firstRank) {
    var last = lastDone(rec), due;
    if (last) due = fitMonths(addMonths(last, job.every), job.months);
    else due = fitMonths(addDays(today, Math.floor((firstRank || 0) / 6) * 7), job.months);
    if (rec && rec.snooze && (!last || rec.snooze > last) && rec.snooze > due) due = rec.snooze;
    return due;
  }
  /**
   * The plan for today: every job that applies to this home and is not
   * set aside, with its due date, its bucket and whose job it is.
   */
  function plan(home, today) {
    var p = home.profile, rank = 0;
    return jobsFor(p).filter(function (j) { return !(home.jobs[j.id] && home.jobs[j.id].skip); }).map(function (j) {
      var rec = home.jobs[j.id] || null, first = lastDone(rec) ? 0 : rank++;
      var due = dueOf(j, rec, today, first), k = between(today, due);
      return { job: j, due: due, days: k, last: lastDone(rec), landlord: landlords(j, p), bucket: k < 0 ? 'overdue' : k <= 6 ? 'week' : k <= 30 ? 'month' : 'later' };
    }).sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : a.job.rank - b.job.rank; });
  }
  var BUCKETS = [['overdue', 'Overdue'], ['week', 'This week'], ['month', 'This month'], ['later', 'Later']];
  function buckets(pl) {
    var out = {};
    BUCKETS.forEach(function (b) { out[b[0]] = pl.filter(function (x) { return x.bucket === b[0]; }); });
    return out;
  }
  /** The on-time ring: of your own jobs (a renter's landlord's are left
   *  out - they are not yours to be late on), how many are not overdue. */
  function ring(pl) {
    var mine = pl.filter(function (x) { return !x.landlord; });
    var on = mine.filter(function (x) { return x.days >= 0; }).length;
    return { on: on, of: mine.length, pct: mine.length ? Math.round(100 * on / mine.length) : 100 };
  }
  /** This winter starts on 1 August: anything done since counts. */
  function seasonStart(today) { var c = civil(dayOf(today)); return (c.m >= 8 ? c.y : c.y - 1) + '-08-01'; }
  /** The Winter-ready checklist: the winter jobs that apply, each ready once
   *  done since 1 August. */
  function winter(home, today) {
    var from = seasonStart(today), p = home.profile;
    var rows = jobsFor(p).filter(function (j) { return j.winter && !(home.jobs[j.id] && home.jobs[j.id].skip); }).map(function (j) {
      var last = lastDone(home.jobs[j.id]);
      return { job: j, ready: Boolean(last && last >= from), last: last, landlord: landlords(j, p) };
    });
    return { from: from, rows: rows, ready: rows.filter(function (r) { return r.ready; }).length, of: rows.length };
  }
  /** The polite note to a landlord, as plain text. */
  function landlordNote(item, today) {
    var j = item.job;
    var when = item.days <= 0 ? 'is due now' : item.days <= 30 ? 'is coming up' : 'will be due in ' + monthLabel(item.due);
    var since = item.last ? ' (it was last done in ' + monthLabel(item.last) + ')' : ' (I don’t think it has been done since I moved in)';
    return 'Hi - a quick one about the home. ' + cap1(j.ask || j.title.toLowerCase()) + ' ' + when + since + '. ' +
      (j.pro === 'pro' ? 'Could you let me know when someone can come by? I’m happy to let them in.' : 'Would you like to arrange it, or are you happy for me to take care of it?') +
      ' Thanks so much.';
  }

  /** Mark a job done on a day (not in the future); a "Not now" is cleared. */
  function markDone(home, id, day, today, t) {
    if (!JOB[id] || !isIso(day) || day > today) return home;
    var h = clone(home), rec = h.jobs[id] || { done: [], snooze: null, skip: false, t: 0 };
    rec.done = rec.done.concat([day]).filter(function (d, i, a) { return a.indexOf(d) === i; }).sort().slice(-LIMITS.done);
    rec.snooze = null; rec.t = t;
    h.jobs[id] = rec;
    return h;
  }
  /** Take back the last "done". */
  function undoDone(home, id, day, t) {
    var h = clone(home), rec = h.jobs[id];
    if (!rec) return home;
    rec.done = rec.done.filter(function (d) { return d !== day; }); rec.t = t;
    return h;
  }
  /** "Not now": due again on `until`. */
  function snooze(home, id, until, t) {
    if (!JOB[id] || !isIso(until)) return home;
    var h = clone(home), rec = h.jobs[id] || { done: [], snooze: null, skip: false, t: 0 };
    rec.snooze = until; rec.t = t; h.jobs[id] = rec;
    return h;
  }
  /** "Not for us" (and back). */
  function setSkip(home, id, on, t) {
    if (!JOB[id]) return home;
    var h = clone(home), rec = h.jobs[id] || { done: [], snooze: null, skip: false, t: 0 };
    rec.skip = Boolean(on); rec.t = t; h.jobs[id] = rec;
    return h;
  }

  /* ================================================================== *
   * The breaker panel. Spaces are numbered the usual way: odd down the
   * left, even down the right. A two-pole breaker at space n also takes
   * n + 2, the space below it.
   * ================================================================== */

  var AMPS = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100];
  var MAIN_AMPS = [60, 100, 125, 150, 200, 225, 300, 400];
  function spacesOf(c) { return c.poles === 2 ? [c.n, c.n + 2] : [c.n]; }
  function liveCircuits(home) {
    return Object.keys(home.circuits).map(function (k) { var c = clone(home.circuits[k]); c.id = k; return c; }).filter(function (c) { return !c.del; }).sort(function (a, b) { return a.n - b.n || (a.id < b.id ? -1 : 1); });
  }
  /** Which circuit sits in each space. Two in one space are a clash - a
   *  merge can make one; the page flags it, nothing is dropped. */
  function occupancy(home) {
    var at = {}, clashes = [];
    liveCircuits(home).forEach(function (c) {
      spacesOf(c).forEach(function (n) {
        if (at[n] && at[n] !== c.id) clashes.push({ n: n, a: at[n], b: c.id });
        else at[n] = c.id;
      });
    });
    return { at: at, clashes: clashes };
  }
  function circuitName(c) { return c && c.label ? c.label : 'Not labelled yet'; }
  /** '' when the circuit fits, else the sentence that says why not. */
  function checkCircuit(home, c) {
    var spaces = home.panel.spaces;
    if (!(c.n >= 1 && c.n <= spaces && Math.round(c.n) === c.n)) return 'Pick a space from 1 to ' + spaces + '.';
    if (c.poles === 2 && c.n + 2 > spaces) return 'A two-pole breaker at space ' + c.n + ' would need space ' + (c.n + 2) + ' - the panel has ' + spaces + '.';
    if (AMPS.indexOf(c.amps) < 0) return 'Pick the amps printed on the breaker’s handle.';
    var why = refuse(c.label, LIMITS.label) || refuse(c.note, LIMITS.cnote);
    if (why) return why;
    var occ = occupancy(home).at, taken = '';
    spacesOf(c).forEach(function (n) { if (!taken && occ[n] && occ[n] !== c.id) taken = 'Space ' + n + ' already has ' + circuitName(home.circuits[occ[n]]) + ' - pick another, or change that one first.'; });
    return taken;
  }
  function putCircuit(home, c, t) {
    var h = clone(home);
    h.circuits[c.id] = { n: c.n, poles: c.poles === 2 ? 2 : 1, amps: c.amps, label: line(c.label, LIMITS.label), note: line(c.note, LIMITS.cnote), t: t, del: false };
    return h;
  }
  function removeCircuit(home, id, t) {
    var h = clone(home), c = h.circuits[id];
    if (c) { c.del = true; c.t = t; }
    return h;
  }
  /** Search by what is on it: "dishwasher", "bath", "20". */
  function searchCircuits(home, q) {
    var words = fold(q).split(' ').filter(Boolean);
    if (!words.length) return [];
    return liveCircuits(home).filter(function (c) {
      var hay = ' ' + fold(c.label + ' ' + c.note) + ' ' + c.amps + ' ' + c.n + ' ';
      return words.every(function (w) { return /^\d+$/.test(w) ? hay.indexOf(' ' + w + ' ') >= 0 : hay.indexOf(w) >= 0; });
    });
  }
  /** The door label, row by row: each side a circuit (with how many rows it
   *  spans), a blank, or the second half of a two-pole breaker. */
  function panelRows(home) {
    var occ = occupancy(home).at, rows = [];
    for (var r = 0; r < home.panel.spaces / 2; r++) {
      var row = [];
      [2 * r + 1, 2 * r + 2].forEach(function (n) {
        var id = occ[n], c = id ? home.circuits[id] : null;
        if (!c) row.push({ n: n, kind: 'empty' });
        else if (c.n !== n) row.push({ n: n, kind: 'cont', id: id });
        else row.push({ n: n, kind: 'circuit', id: id, label: circuitName(c), amps: c.amps, poles: c.poles, note: c.note, blank: !c.label });
      });
      rows.push(row);
    }
    return rows;
  }
  function unlabelled(home) { return liveCircuits(home).filter(function (c) { return !c.label; }).length; }

  /* ================================================================== *
   * House facts and appliances. Photos stay on the phone (snug-store.js);
   * nothing here is a code or a password.
   * ================================================================== */

  var FACTS = [
    ['water', 'Main water shutoff', 'Where it is, and which way it turns'],
    ['gas', 'Gas shutoff', 'At the meter, and the valve by each appliance'],
    ['power', 'Breaker panel and main switch', 'Where the panel is'],
    ['heater', 'Water heater', 'Where it is, and its own shutoff'],
    ['filter', 'Furnace filter size', 'Printed on the filter’s edge, like 16 x 25 x 1'],
    ['bins', 'Bins and recycling', 'Which day, which bin'],
    ['paint', 'Paint colours', 'Room by room, from the can’s label'],
    ['other', 'Anything else', 'Where the spare fuses, bulbs and keys-to-nothing live'],
  ];
  var FACT_KEYS = FACTS.map(function (f) { return f[0]; });
  var KINDS = [['furnace', 'Furnace'], ['boiler', 'Boiler'], ['heatpump', 'Heat pump'], ['ac', 'Air conditioner'], ['water-heater', 'Water heater'],
    ['fridge', 'Fridge'], ['freezer', 'Freezer'], ['dishwasher', 'Dishwasher'], ['washer', 'Washing machine'], ['dryer', 'Dryer'], ['range', 'Cooker or range'], ['other', 'Something else']];
  var KIND_IDS = KINDS.map(function (k) { return k[0]; });
  var FUELS = [['gas', 'Natural gas'], ['propane', 'Propane'], ['electric', 'Electric'], ['oil', 'Oil'], ['unknown', 'Not sure']];
  var FUEL_IDS = FUELS.map(function (f) { return f[0]; });
  function kindLabel(k) { var x = KINDS.filter(function (y) { return y[0] === k; })[0]; return x ? x[1] : 'Appliance'; }
  function fuelLabel(k) { var x = FUELS.filter(function (y) { return y[0] === k; })[0]; return x ? x[1] : ''; }
  function liveAppliances(home) {
    return Object.keys(home.appliances).map(function (k) { var x = clone(home.appliances[k]); x.id = k; return x; }).filter(function (a) { return !a.del; })
      .sort(function (a, b) { return KIND_IDS.indexOf(a.kind) - KIND_IDS.indexOf(b.kind) || (a.id < b.id ? -1 : 1); });
  }
  /** '' when an appliance may be kept, else why not. */
  function checkAppliance(a, thisYear) {
    if (KIND_IDS.indexOf(a.kind) < 0) return 'Pick what it is.';
    if (FUEL_IDS.indexOf(a.fuel) < 0) return 'Pick how it runs.';
    if (a.year !== null && !(Math.round(a.year) === a.year && a.year >= 1950 && a.year <= thisYear)) return 'The year it was made, like 2014 - or leave it empty.';
    var fields = [['maker', LIMITS.maker], ['model', LIMITS.model], ['size', LIMITS.size], ['filter', LIMITS.filter], ['note', LIMITS.anote]];
    for (var i = 0; i < fields.length; i++) { var why = refuse(a[fields[i][0]], fields[i][1]); if (why) return cap1(fields[i][0]) + ': ' + why; }
    if (!str(a.maker).trim() && !str(a.model).trim() && !str(a.note).trim()) return 'Add the maker, the model or a note.';
    return '';
  }
  function putAppliance(home, a, t) {
    var h = clone(home);
    h.appliances[a.id] = { kind: a.kind, maker: line(a.maker, LIMITS.maker), model: line(a.model, LIMITS.model), year: a.year, fuel: a.fuel, size: line(a.size, LIMITS.size), filter: line(a.filter, LIMITS.filter), note: line(a.note, LIMITS.anote), t: t, del: false };
    return h;
  }
  function removeAppliance(home, id, t) { var h = clone(home), a = h.appliances[id]; if (a) { a.del = true; a.t = t; } return h; }
  function putFact(home, k, text, t) { var h = clone(home); h.facts[k] = { text: line(text, LIMITS.fact), t: t }; return h; }
  /** How old an appliance is, in plain words - never a verdict on it. */
  function ageText(a, thisYear) { if (a.year === null) return ''; var n = thisYear - a.year; return n <= 0 ? 'made this year' : 'about ' + plural(n, 'year') + ' old'; }

  /* ================================================================== *
   * The one door for a whole home, and what the server refuses first
   * ================================================================== */

  var ID = { circuit: /^c[a-z0-9]{4,12}$/, appliance: /^a[a-z0-9]{4,12}$/ };
  function isTime(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && Math.round(v) === v && v < 1e14; }
  function newHome(profile, t) {
    return { v: 1, profile: profile, profileT: t, jobs: {}, panel: { spaces: 40, main: null, t: t }, circuits: {}, facts: {}, appliances: {} };
  }
  function keysOnly(o, ks) { return isObj(o) && Object.keys(o).every(function (k) { return ks.indexOf(k) >= 0; }); }

  /**
   * Every home read back from the phone, sent to the server or merged goes
   * through here. Strict (the server): anything out of shape is an error
   * and the whole body is refused. Not strict (reading this phone's own
   * copy): the bad bit is dropped or mended. {home, errors}.
   */
  function cleanHome(raw, strict) {
    var errors = [];
    var e = function (m) { errors.push(m); };
    raw = isObj(raw) ? raw : (e('Send the home.'), {});
    if (strict && !keysOnly(raw, ['v', 'profile', 'profileT', 'jobs', 'panel', 'circuits', 'facts', 'appliances', 'updatedAt'])) e('The home has a field Snug does not keep.');
    var t0 = isTime(raw.profileT) ? raw.profileT : (strict && e('A time is not a time.'), 0);

    // The profile
    var rp = isObj(raw.profile) ? raw.profile : (e('The home has no profile.'), {});
    if (strict && !keysOnly(rp, ['name', 'tenure', 'kind', 'heat', 'cool', 'water', 'gas', 'climate', 'has', 'since'])) e('The home’s chips have a field Snug does not keep.');
    var p = defaultProfile();
    var why = refuse(rp.name, LIMITS.name);
    if (typeof rp.name === 'string' && !why && rp.name.trim()) p.name = line(rp.name, LIMITS.name);
    else if (strict && (typeof rp.name !== 'string' || why)) e('The home’s nickname: ' + (why || 'it is not words.'));
    Object.keys(CHIPS).forEach(function (k) {
      if (optIds(k).indexOf(rp[k]) >= 0) p[k] = rp[k];
      else if (strict) e('Unknown ' + k + ': ' + line(str(rp[k]), 20) + '.');
    });
    if (Array.isArray(rp.has)) {
      p.has = rp.has.filter(function (f, i, a) { var ok = FEATURE_IDS.indexOf(f) >= 0 && a.indexOf(f) === i; if (!ok && strict) e('Unknown feature.'); return ok; });
    } else if (strict) e('The features are a list.');
    if (rp.since === null || rp.since === undefined) p.since = null;
    else if (isIso(rp.since)) p.since = rp.since;
    else if (strict) e('The move-in date is not a date.');

    // Jobs
    var jobs = {};
    var rj = isObj(raw.jobs) ? raw.jobs : (strict && e('The jobs are missing.'), {});
    Object.keys(rj).forEach(function (id) {
      var r = rj[id];
      if (!JOB[id]) { if (strict) e('Unknown job: ' + line(id, 30) + '.'); return; }
      if (!isObj(r) || (strict && !keysOnly(r, ['done', 'snooze', 'skip', 't']))) { if (strict) e('A job record is out of shape.'); return; }
      var done = Array.isArray(r.done) ? r.done.filter(function (d) { var ok = isIso(d); if (!ok && strict) e('A done date is not a date.'); return ok; }) : (strict && e('Done dates are a list.'), []);
      if (strict && done.length > LIMITS.done) e('At most ' + LIMITS.done + ' done dates a job.');
      done = done.filter(function (d, i, a) { return a.indexOf(d) === i; }).sort().slice(-LIMITS.done);
      var sn = r.snooze === null || r.snooze === undefined ? null : (isIso(r.snooze) ? r.snooze : (strict && e('A "not now" date is not a date.'), null));
      if (strict && typeof r.skip !== 'boolean') e('Skip is yes or no.');
      if (strict && !isTime(r.t)) e('A time is not a time.');
      jobs[id] = { done: done, snooze: sn, skip: r.skip === true, t: isTime(r.t) ? r.t : 0 };
    });

    // The panel
    var rpn = isObj(raw.panel) ? raw.panel : (strict && e('The panel is missing.'), {});
    if (strict && !keysOnly(rpn, ['spaces', 'main', 't'])) e('The panel has a field Snug does not keep.');
    var spaces = rpn.spaces;
    if (!(typeof spaces === 'number' && spaces % 2 === 0 && spaces >= LIMITS.spacesMin && spaces <= LIMITS.spacesMax)) { if (strict) e('A panel has an even number of spaces, 2 to 60.'); spaces = 40; }
    var main = rpn.main === null || rpn.main === undefined ? null : (MAIN_AMPS.indexOf(rpn.main) >= 0 ? rpn.main : (strict && e('The main breaker’s amps are not ones Snug knows.'), null));
    if (strict && !isTime(rpn.t)) e('A time is not a time.');
    var panel = { spaces: spaces, main: main, t: isTime(rpn.t) ? rpn.t : 0 };

    // Circuits
    var circuits = {};
    var rc = isObj(raw.circuits) ? raw.circuits : (strict && e('The circuits are missing.'), {});
    var ck = Object.keys(rc);
    if (ck.length > LIMITS.circuits) { if (strict) e('At most ' + LIMITS.circuits + ' circuits.'); ck = ck.slice(0, LIMITS.circuits); }
    ck.forEach(function (id) {
      var c = rc[id];
      if (!ID.circuit.test(id) || !isObj(c)) { if (strict) e('A circuit is out of shape.'); return; }
      if (strict && !keysOnly(c, ['n', 'poles', 'amps', 'label', 'note', 't', 'del'])) { e('A circuit has a field Snug does not keep.'); return; }
      var bad = !(typeof c.n === 'number' && Math.round(c.n) === c.n && c.n >= 1 && c.n <= spaces) || (c.poles !== 1 && c.poles !== 2) || (c.poles === 2 && c.n + 2 > spaces) || AMPS.indexOf(c.amps) < 0 || typeof c.label !== 'string' || typeof c.note !== 'string' || typeof c.del !== 'boolean' || !isTime(c.t);
      var w = refuse(c.label, LIMITS.label) || refuse(c.note, LIMITS.cnote);
      if (bad || w) { if (strict) e('Circuit ' + str(c.n) + ': ' + (w || 'out of shape.')); return; }
      circuits[id] = { n: c.n, poles: c.poles, amps: c.amps, label: line(c.label, LIMITS.label), note: line(c.note, LIMITS.cnote), t: c.t, del: c.del };
    });

    // Facts
    var facts = {};
    var rf = isObj(raw.facts) ? raw.facts : (strict && e('The facts are missing.'), {});
    Object.keys(rf).forEach(function (k) {
      var f = rf[k];
      if (FACT_KEYS.indexOf(k) < 0 || !isObj(f) || (strict && !keysOnly(f, ['text', 't']))) { if (strict) e('A house fact is out of shape.'); return; }
      var w = typeof f.text === 'string' ? refuse(f.text, LIMITS.fact) : 'it is not words.';
      if (w || !isTime(f.t)) { if (strict) e(FACTS[FACT_KEYS.indexOf(k)][1] + ': ' + (w || 'a time is not a time.')); return; }
      facts[k] = { text: line(f.text, LIMITS.fact), t: f.t };
    });

    // Appliances
    var appliances = {};
    var ra = isObj(raw.appliances) ? raw.appliances : (strict && e('The appliances are missing.'), {});
    var ak = Object.keys(ra);
    if (ak.length > LIMITS.appliances) { if (strict) e('At most ' + LIMITS.appliances + ' appliances.'); ak = ak.slice(0, LIMITS.appliances); }
    ak.forEach(function (id) {
      var a = ra[id];
      if (!ID.appliance.test(id) || !isObj(a)) { if (strict) e('An appliance is out of shape.'); return; }
      if (strict && !keysOnly(a, ['kind', 'maker', 'model', 'year', 'fuel', 'size', 'filter', 'note', 't', 'del'])) { e('An appliance has a field Snug does not keep.'); return; }
      var typed = ['maker', 'model', 'size', 'filter', 'note'].every(function (f) { return typeof a[f] === 'string'; }) && (a.year === null || typeof a.year === 'number') && typeof a.del === 'boolean' && isTime(a.t);
      var w = typed ? checkAppliance(a, 2100) : 'out of shape.';
      if (w && !(typed && a.del && /Add the maker/.test(w))) { if (strict) e('An appliance: ' + w); return; }
      appliances[id] = { kind: a.kind, maker: line(a.maker, LIMITS.maker), model: line(a.model, LIMITS.model), year: a.year, fuel: a.fuel, size: line(a.size, LIMITS.size), filter: line(a.filter, LIMITS.filter), note: line(a.note, LIMITS.anote), t: a.t, del: a.del };
    });

    if (strict && raw.v !== 1) e('Unknown version.');
    return { home: { v: 1, profile: p, profileT: t0, jobs: jobs, panel: panel, circuits: circuits, facts: facts, appliances: appliances }, errors: errors };
  }

  /** What the server refuses whole before the one door even looks: any
   *  string anywhere with an @ (any width), nine digits in a row (any
   *  script), a link, a formula, markup, an invisible character or a code
   *  or password. The first problem, or ''. */
  function bodyProblem(v, depth) {
    depth = depth || 0;
    if (depth > 8) return 'That is nested too deeply.';
    if (typeof v === 'string') {
      if (hasAt(v)) return 'Something in it has an @ - Snug keeps no email addresses.';
      if (nineDigits(v)) return 'Something in it has nine digits in a row - Snug keeps no serial, phone or account numbers.';
      if (hasLink(v)) return 'Something in it looks like a link.';
      if (isFormula(v)) return 'Something in it starts like a spreadsheet formula.';
      if (hasMarkup(v)) return 'Something in it has markup.';
      if (hasInvisible(v)) return 'Something in it has an invisible character.';
      if (hasCode(v)) return 'Something in it looks like a code or a password - Snug keeps none.';
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
   * The calendar file, built on the phone
   * ================================================================== */

  function icsText(s) { return str(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  /** Lines of at most 75 octets, continued with a space (RFC 5545). */
  function fold75(lineStr) {
    var out = [], cur = '', bytes = 0, limit = 75;
    Array.from(lineStr).forEach(function (ch) {
      var b = unescape(encodeURIComponent(ch)).length;
      if (bytes + b > limit) { out.push(cur); cur = ' '; bytes = 1; limit = 75; }
      cur += ch; bytes += b;
    });
    out.push(cur);
    return out.join('\r\n');
  }
  function stampOf(ms) {
    var d = Math.floor(ms / 86400000), s = Math.floor((ms - d * 86400000) / 1000);
    return iso(d).replace(/-/g, '') + 'T' + pad2(Math.floor(s / 3600)) + pad2(Math.floor(s / 60) % 60) + pad2(s % 60) + 'Z';
  }
  /**
   * A calendar of every job's next time, repeating at its interval:
   * all-day events, so no time zone. Overdue ones start today. A renter's
   * landlord's jobs are left out unless `opts.landlord`. `nowMs` is the
   * page's clock, for DTSTAMP.
   */
  function ics(home, today, nowMs, opts) {
    opts = opts || {};
    var pl = plan(home, today).filter(function (x) { return opts.landlord || !x.landlord; });
    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Snug//Home jobs//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsText(home.profile.name + ' - home jobs')];
    pl.forEach(function (x) {
      var j = x.job, start = x.due < today ? today : x.due;
      L.push('BEGIN:VEVENT', 'UID:snug-' + j.id + '-' + start.replace(/-/g, ''), 'DTSTAMP:' + stampOf(nowMs),
        'DTSTART;VALUE=DATE:' + start.replace(/-/g, ''), 'DTEND;VALUE=DATE:' + addDays(start, 1).replace(/-/g, ''),
        j.every % 12 === 0 ? 'RRULE:FREQ=YEARLY;INTERVAL=' + (j.every / 12) : 'RRULE:FREQ=MONTHLY;INTERVAL=' + j.every,
        'SUMMARY:' + icsText(j.title + (x.landlord ? ' (landlord)' : '')),
        'DESCRIPTION:' + icsText(j.why + '\n\n' + j.how.map(function (h, i) { return (i + 1) + '. ' + h; }).join('\n') + '\n\nAbout ' + minsText(j.mins) + '. ' + PRO[j.pro] + '.'),
        'TRANSP:TRANSPARENT', 'END:VEVENT');
    });
    L.push('END:VCALENDAR');
    return L.map(fold75).join('\r\n') + '\r\n';
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
   * Two copies of one home, made one. The chips and the panel's size by
   * their own times. Each job: every "done" date from both phones (the
   * most recent twelve), its "not now" and "not for us" from the later
   * change. Each circuit, fact and appliance by its own time; a removal is
   * a change like any other. Two breakers in one space are kept and
   * flagged, never dropped. Symmetric and idempotent.
   */
  function merge(a, b) {
    a = cleanHome(a).home; b = cleanHome(b).home;
    var pa = { p: a.profile, t: a.profileT }, pb = { p: b.profile, t: b.profileT };
    var prof = pa.t !== pb.t ? (pa.t > pb.t ? pa : pb) : (canon(pa) >= canon(pb) ? pa : pb);
    var out = { v: 1, profile: clone(prof.p), profileT: prof.t, jobs: {}, panel: clone(later(a.panel, b.panel)), circuits: {}, facts: {}, appliances: {} };
    Object.keys(a.jobs).concat(Object.keys(b.jobs)).forEach(function (id) {
      if (out.jobs[id]) return;
      var x = a.jobs[id], y = b.jobs[id], w = clone(later(x, y));
      w.done = (x ? x.done : []).concat(y ? y.done : []).filter(function (d, i, arr) { return arr.indexOf(d) === i; }).sort().slice(-LIMITS.done);
      w.t = Math.max(x ? x.t : 0, y ? y.t : 0);
      out.jobs[id] = w;
    });
    ['circuits', 'facts', 'appliances'].forEach(function (k) {
      Object.keys(a[k]).concat(Object.keys(b[k])).forEach(function (id) { if (!out[k][id]) out[k][id] = clone(later(a[k][id], b[k][id])); });
    });
    var notes = occupancy(out).clashes.map(function (c) {
      return 'Both phones put a breaker in space ' + c.n + ': ' + circuitName(out.circuits[c.a]) + ' and ' + circuitName(out.circuits[c.b]) + '. Move one?';
    });
    return { home: out, notes: notes };
  }

  /* ================================================================== *
   * The AI: "Read the label"
   * ================================================================== */

  var IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  /** The request, rebuilt to the image alone: exactly {image: {type, data}}.
   *  Anything else - a home, a note, a question - is refused. */
  function labelRequest(body) {
    var bad = function (msg, code) { return { error: msg, code: code || 'bad-request' }; };
    if (!isObj(body)) return bad('Send the photo.');
    var extra = Object.keys(body).filter(function (k) { return k !== 'image'; });
    if (extra.length) return bad('Only the photo is sent - not ' + extra.slice(0, 3).map(function (x) { return line(x, 20); }).join(', ') + '.', 'extra-field');
    var im = body.image;
    if (!isObj(im) || Object.keys(im).sort().join() !== 'data,type') return bad('Send one photo as {type, data}.', 'image');
    if (IMAGE_TYPES.indexOf(im.type) < 0) return bad('The photo must be a JPEG, PNG or WebP.', 'image');
    if (typeof im.data !== 'string' || im.data.length < 16 || im.data.length > Math.ceil(LIMITS.aiImageBytes * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+=*$/.test(im.data)) return bad('That photo is too large or not a photo. The page shrinks it first - try again from the page.', 'image');
    return { req: { image: { type: im.type, data: im.data } } };
  }
  var PLATE_FIELDS = ['kind', 'maker', 'model', 'year', 'fuel', 'size', 'volts', 'amps', 'unsure'];
  var UNSURE = ['kind', 'maker', 'model', 'year', 'fuel', 'size', 'volts', 'amps'];
  /** Words a rating plate never says, which a model might add: a price, a
   *  recall, a safety verdict, advice to replace it. */
  var ADVICE = /(\$|£|€|\bprices?\b|\bcosts?\b|\bworth\b|\bvalue\b|\bcheap|\bexpensive|\brecall|\bunsafe\b|\bsafe\b|\bsafety\b|\bdanger|\bhazard|\brisk|\bdefect|\bfaulty\b|\breplac|\bend of (its )?life\b|\btoo old\b|\bupgrade|\bwarrant|\bbuy\b|\bshould\b|\brecommend)/i;
  var SERIAL = /\b(serial|s\s*\/\s*n|ser\.?\s*no|sn\s*[:#])/i;
  function plateField(v, max) {
    if (typeof v !== 'string') return '';
    if (hasMarkup(v) && /<[a-z!/]/i.test(v)) return '';
    var s = line(v, max);
    if (!s || hasAt(s) || hasLink(s) || hasPhone(s) || hasCard(s) || nineDigits(s) || hasAddress(s) || isFormula(s) || hasCode(s) || ADVICE.test(s) || SERIAL.test(s)) return '';
    return s;
  }
  /**
   * The model's answer, checked. Only the plate's own fields are kept: any
   * other field (a serial number, a price, a recall, a verdict) is dropped
   * and named; a text that strays into a price, a recall, a safety verdict
   * or "replace it", or carries a serial, an email, a phone number, a link
   * or markup, is dropped; an unknown kind or fuel is dropped; a year
   * outside 1950 to this year is dropped. Nothing readable is an error.
   * {plate, unsure, dropped} or {error, code}.
   */
  function cleanAiLabel(raw, thisYear) {
    if (!isObj(raw)) return { error: 'The label could not be read. Try a sharper photo, straight on - or type it in.', code: 'unreadable' };
    var dropped = [];
    Object.keys(raw).forEach(function (k) { if (PLATE_FIELDS.indexOf(k) < 0 && dropped.length < LIMITS.aiDropped) dropped.push(line(k, 20) || 'a field'); });
    var plate = { kind: '', maker: '', model: '', year: null, fuel: '', size: '', volts: '', amps: '' };
    if (KIND_IDS.indexOf(raw.kind) >= 0) plate.kind = raw.kind; else if (raw.kind !== undefined && raw.kind !== null && raw.kind !== '') dropped.push('kind');
    if (FUEL_IDS.indexOf(raw.fuel) >= 0) plate.fuel = raw.fuel; else if (raw.fuel !== undefined && raw.fuel !== null && raw.fuel !== '') dropped.push('fuel');
    if (typeof raw.year === 'number' && Math.round(raw.year) === raw.year && raw.year >= 1950 && raw.year <= thisYear) plate.year = raw.year;
    else if (raw.year !== undefined && raw.year !== null) dropped.push('year');
    [['maker', LIMITS.maker], ['model', LIMITS.model], ['size', LIMITS.size], ['volts', 20], ['amps', 20]].forEach(function (f) {
      var v = raw[f[0]];
      if (v === undefined || v === null || v === '') return;
      plate[f[0]] = plateField(v, f[1]);
      if (!plate[f[0]]) dropped.push(f[0]);
    });
    var unsure = (Array.isArray(raw.unsure) ? raw.unsure : []).filter(function (u, i, a) { return UNSURE.indexOf(u) >= 0 && a.indexOf(u) === i; });
    if (!plate.maker && !plate.model && !plate.size) return { error: 'Nothing on that label could be read. Try a sharper photo, straight on and close - or type it in.', code: 'unreadable' };
    return { plate: plate, unsure: unsure, dropped: dropped.filter(function (d, i, a) { return a.indexOf(d) === i; }).slice(0, LIMITS.aiDropped) };
  }
  /** A reading, as an appliance draft for a person to check and save. */
  function plateDraft(plate, id) {
    var bits = [plate.volts, plate.amps].filter(Boolean).join(', ');
    return { id: id, kind: plate.kind || 'other', maker: plate.maker, model: plate.model, year: plate.year, fuel: plate.fuel || 'unknown', size: plate.size, filter: '', note: bits ? line('Electrical: ' + bits, LIMITS.anote) : '', t: 0, del: false };
  }

  /* ================================================================== *
   * The house manual: what it holds, in order (the page draws it)
   * ================================================================== */

  function manual(home, today, thisYear) {
    var pl = plan(home, today);
    return {
      name: home.profile.name,
      chips: Object.keys(CHIPS).map(function (k) { return chipLabel(k, home.profile[k]); }).concat(home.profile.has.map(featureLabel)),
      facts: FACTS.filter(function (f) { return home.facts[f[0]] && home.facts[f[0]].text; }).map(function (f) { return { label: f[1], text: home.facts[f[0]].text }; }),
      appliances: liveAppliances(home).map(function (a) { return { kind: kindLabel(a.kind), what: [a.maker, a.model].filter(Boolean).join(' '), year: a.year, age: ageText(a, thisYear), fuel: a.fuel === 'unknown' ? '' : fuelLabel(a.fuel), size: a.size, filter: a.filter, note: a.note }; }),
      panel: { spaces: home.panel.spaces, main: home.panel.main, circuits: liveCircuits(home).map(function (c) { return { n: c.poles === 2 ? c.n + ' + ' + (c.n + 2) : String(c.n), label: circuitName(c), amps: c.amps, note: c.note }; }) },
      jobs: Object.keys(AREAS).map(function (area) {
        return { area: AREAS[area], rows: pl.filter(function (x) { return x.job.area === area; }).sort(function (x, y) { return x.job.rank - y.job.rank; }).map(function (x) {
          return { title: x.job.title, every: everyText(x.job.every) + (x.job.months ? ', in ' + monthsText(x.job.months) : ''), next: dateLabel(x.due < today ? today : x.due), last: x.last ? dateLabel(x.last) : 'Not yet', who: x.landlord ? 'Landlord' : PRO[x.job.pro] };
        }) };
      }).filter(function (g) { return g.rows.length; }),
    };
  }

  return {
    LIMITS: LIMITS, WHY: WHY, CHIPS: CHIPS, FEATURES: FEATURES, FEATURE_IDS: FEATURE_IDS, COND: COND, JOBS: JOBS, JOB: JOB, AREAS: AREAS, PRO: PRO, BUCKETS: BUCKETS,
    AMPS: AMPS, MAIN_AMPS: MAIN_AMPS, FACTS: FACTS, FACT_KEYS: FACT_KEYS, KINDS: KINDS, KIND_IDS: KIND_IDS, FUELS: FUELS, FUEL_IDS: FUEL_IDS, IMAGE_TYPES: IMAGE_TYPES, UNSURE: UNSURE, MON: MON,
    str: str, esc: esc, line: line, fold: fold, clone: clone, list: list, plural: plural, cap1: cap1, own: own,
    hasAt: hasAt, hasLink: hasLink, hasPhone: hasPhone, nineDigits: nineDigits, hasCard: hasCard, hasAddress: hasAddress, hasCode: hasCode, isFormula: isFormula, hasInvisible: hasInvisible, refuse: refuse,
    dayOf: dayOf, isIso: isIso, iso: iso, addDays: addDays, addMonths: addMonths, between: between, dayLabel: dayLabel, dateLabel: dateLabel, monthLabel: monthLabel, monthsText: monthsText, everyText: everyText, dueText: dueText, minsText: minsText,
    chipLabel: chipLabel, featureLabel: featureLabel, defaultProfile: defaultProfile, applies: applies, jobsFor: jobsFor, landlords: landlords,
    fitMonths: fitMonths, lastDone: lastDone, dueOf: dueOf, plan: plan, buckets: buckets, ring: ring, seasonStart: seasonStart, winter: winter, landlordNote: landlordNote,
    markDone: markDone, undoDone: undoDone, snooze: snooze, setSkip: setSkip,
    spacesOf: spacesOf, liveCircuits: liveCircuits, occupancy: occupancy, circuitName: circuitName, checkCircuit: checkCircuit, putCircuit: putCircuit, removeCircuit: removeCircuit, searchCircuits: searchCircuits, panelRows: panelRows, unlabelled: unlabelled,
    kindLabel: kindLabel, fuelLabel: fuelLabel, liveAppliances: liveAppliances, checkAppliance: checkAppliance, putAppliance: putAppliance, removeAppliance: removeAppliance, putFact: putFact, ageText: ageText,
    newHome: newHome, cleanHome: cleanHome, bodyProblem: bodyProblem, isTime: isTime, ID: ID,
    ics: ics, fold75: fold75, stampOf: stampOf,
    canon: canon, same: same, merge: merge,
    labelRequest: labelRequest, cleanAiLabel: cleanAiLabel, plateDraft: plateDraft, ADVICE: ADVICE, SERIAL: SERIAL,
    manual: manual,
  };
}));
