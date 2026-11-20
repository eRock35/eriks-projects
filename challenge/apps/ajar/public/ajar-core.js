/* Ajar - the rules. One little door a day to the big day, planned around
 * the family's real week.
 *
 * UMD: window.AjarCore in the page, require() in the server and the tests.
 * Everything that works out a countdown's days, places the chosen
 * activities on them, explains each placement, swaps and moves them, rolls
 * up the shopping, opens doors, asks the kid-mode question, lays out the
 * printed cards, counts the recap, merges two phones and checks what the AI
 * is sent and sends back lives here, so the page, the server's checks and
 * the tests run the same code.
 *
 * NO CLOCK AND NO DICE in here (tested): "today", every time stamp, every
 * seed and the kid-mode number are passed in. The same countdown, seed and
 * day always give the same plan.
 *
 * Top to bottom:
 *   - text: cleaning, escaping, and the checks for an @, links, phone
 *     numbers, formulas and brand or title names
 *   - dates (UTC day numbers, no Date object)
 *   - the big day: Christmas, from the first Sunday of Advent, any big day
 *   - activities: the deck, your own, pinned events, fillers, costs
 *   - the countdown and its one door (cleanCountdown)
 *   - the plan: the rules, the planner, reasons, swaps, pins and moves
 *   - the shopping list and the budget
 *   - the doors, kid mode, print layouts, the recap
 *   - two phones: the merge
 *   - the AI: the request rebuilt, the answer checked
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ajar-deck'));
  else root.AjarCore = factory(root.AjarDeck);
}(typeof self !== 'undefined' ? self : this, function (DK) {
  'use strict';

  var LIMITS = {
    doorsMin: 3, doorsMax: 31,
    kids: 6, kidName: 20, adultsMax: 8,
    name: 40, pins: 10, pinTitle: 40, busyDates: 31,
    custom: 40, title: 50, how: 160, needs: 4, need: 30,
    picks: 150, planDays: 62, shop: 300, shopKey: 40,
    usdMax: 2000, amtMax: 50000,       // a budget in whole dollars; one activity’s cost in cents
    countdowns: 3,
    bodyBytes: 96 * 1024,
    aiMin: 4, aiMax: 12, aiAges: 6, aiAvoid: 100,
  };

  /* ================================================================== *
   * Text: one door for every string a person, the server or a model wrote
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
  function clip(s, n) { return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).replace(/\s+$/, '') + '…'; }
  function noMarkup(s) { return str(s).replace(/<[^>]{0,200}>/g, '').replace(/[<>]/g, ''); }
  /** One line: invisible characters and markup gone, spaces collapsed, bounded. */
  function line(v, max) { return clip(noMarkup(str(v).replace(BAD, '')).replace(/\s+/g, ' ').trim(), max || 200); }
  function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function plural(n, one, many) { return groups(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function nf(s) { s = str(s); try { return s.normalize('NFKC'); } catch (e) { return s; } }
  /** For matching titles: lower case, letters and digits only. */
  function norm(s) { return nf(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(o) { return Boolean(o) && typeof o === 'object' && !Array.isArray(o); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

  // An @ in any width: NFKC folds the full-width and small forms into the
  // plain one, and the raw check catches them where normalize is missing.
  var AT_ANY = new RegExp('[@' + String.fromCharCode(0xFF20, 0xFE6B) + ']');
  function hasAt(s) { return AT_ANY.test(str(s)) || /@/.test(nf(s)); }
  var LINK = /(https?:|ftp:|mailto:|www\.|:\/\/|\b[a-z0-9-]{2,}\.(com|net|org|io|co|uk|us|app|dev|ly|me|info|biz|tv|gg|xyz|shop|store|site|online)\b)/i;
  function hasLink(s) { return LINK.test(nf(s)); }
  /** Seven or more digits - in any script - in one run of digits and
   *  phone punctuation. */
  function hasPhone(s) { return (nf(s).match(/\+?\p{Nd}[\p{Nd}\s().\/-]{5,}\p{Nd}/gu) || []).some(function (m) { return m.replace(/[^\p{Nd}]/gu, '').length >= 7; }); }
  /** Nine digits in a row, in any script (NFKC folds the full-width ones;
   *  \p{Nd} catches Arabic-Indic, Devanagari and the rest). */
  function nineDigits(s) { return /\p{Nd}{9,}/u.test(nf(s)); }
  /** What a spreadsheet would run: a leading = + - @ (or a tab or CR). */
  function isFormula(s) { return /^\s*[=+\-@\t\r]/.test(nf(s)); }
  function hasInvisible(s) { return BAD1.test(str(s)); }
  function hasMarkup(s) { return /[<>]/.test(str(s)); }

  // Brand, shop, film, show, book, song and character names a model might
  // reach for. Built from pieces so this file never carries the words it
  // looks for. Ordinary words (a film that is also an adjective, a shop that
  // is also a noun) are matched only with their capital, as a title or a
  // name would be written.
  var BRAND_PIECES = [
    ['Le', 'go'], ['Play', 'mobil'], ['Bar', 'bie'], ['Hot ', 'Wheels'], ['Play-', 'Doh'], ['Cray', 'ola'], ['Ne', 'rf'], ['Has', 'bro'], ['Mat', 'tel'], ['Fisher-', 'Price'],
    ['Hers', 'hey'], ['Cad', 'bury'], ['Nest', 'le'], ['M&', 'M'], ['Ore', 'o'], ['Hari', 'bo'], ['Skit', 'tles'], ['Smar', 'ties'], ['Lin', 'dt'], ['Ferr', 'ero'], ['Tobler', 'one'], ['Kit ', 'Kat'], ['Nu', 'tella'],
    ['Coca-', 'Cola'], ['Pep', 'si'], ['Star', 'bucks'], ['Nes', 'quik'], ['Cri', 'cut'], ['Klu', 'tz'],
    ['Wal', 'mart'], ['Cost', 'co'], ['Tes', 'co'], ['Hobby ', 'Lobby'], ['IK', 'EA'], ['Ik', 'ea'], ['Et', 'sy'], ['Hobby', 'craft'], ['Sains', 'bury'], ['Al', 'di'], ['Li', 'dl'], ['Kro', 'ger'], ['Insta', 'cart'], ['Door', 'Dash'], ['Fed', 'Ex'], ['Deliv', 'eroo'],
    ['Rud', 'olph'], ['Fros', 'ty'], ['Grin', 'ch'], ['Polar ', 'Express'], ['Home ', 'Alone'], ['Ola', 'f'], ['El', 'sa'], ['Padd', 'ington'], ['Gruff', 'alo'], ['Pep', 'pa'], ['Blu', 'ey'], ['Dis', 'ney'], ['Pix', 'ar'], ['Scroo', 'ge'], ['Harry ', 'Potter'], ['Hog', 'warts'], ['Nar', 'nia'], ['Mup', 'pet'], ['Mic', 'key'], ['Poke', 'mon'], ['Mine', 'craft'], ['Fort', 'nite'], ['Rob', 'lox'], ['Paw ', 'Patrol'], ['Sesame ', 'Street'], ['Snoo', 'py'], ['Jingle ', 'Bells'], ['Nut', 'cracker'], ['Elf on the ', 'Shelf'],
    ['Net', 'flix'], ['Hu', 'lu'], ['You', 'Tube'], ['Spot', 'ify'], ['Prime ', 'Video'], ['H', 'BO'], ['Dis', 'neyland'], ['Le', 'goland'], ['Universal ', 'Studios'], ['Six ', 'Flags'],
    ['Fro', 'zen'], ['Tar', 'get'], ['Ama', 'zon'], ['Mich', 'aels'], ['Kin', 'der'], ['Mars ', 'bar'],
  ].map(function (p) { return p.join(''); });
  var BRAND_RE = new RegExp('(^|[^A-Za-z])(' + BRAND_PIECES.map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')(?![A-Za-z])');
  function namesBrand(s) { return BRAND_RE.test(nf(s)); }

  /* ================================================================== *
   * Dates: UTC day numbers, no Date object
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
  function weekday(n) { return ((n % 7) + 11) % 7; }   // 0 Sunday ... 6 Saturday (1 Jan 1970 was a Thursday)
  function addDays(s, k) { return iso(dayOf(s) + k); }
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  /** "Wed 16 Dec" */
  function dayLabel(s) { var n = dayOf(s); if (n === null) return ''; var c = civil(n); return WD[weekday(n)] + ' ' + c.d + ' ' + MON[c.m - 1]; }
  /** "Wednesday 16 December" */
  function longDay(s) { var n = dayOf(s); if (n === null) return ''; var c = civil(n); return WD_LONG[weekday(n)] + ' ' + c.d + ' ' + MON_LONG[c.m - 1]; }
  function monthOf(s) { var n = dayOf(s); return n === null ? 0 : civil(n).m; }
  /** "Opens tomorrow", "Opens Thursday", "Opens Sat 19 Dec". */
  function opensWord(s, today) {
    var k = dayOf(s) - dayOf(today);
    if (k <= 0) return 'Open now';
    if (k === 1) return 'Opens tomorrow';
    if (k < 7) return 'Opens ' + WD_LONG[weekday(dayOf(s))];
    return 'Opens ' + dayLabel(s);
  }
  /** "Today", "Tomorrow", "Thu 10 Dec" for a buy-by date. */
  function relDay(s, today) {
    var k = dayOf(s) - dayOf(today);
    if (k === 0) return 'today';
    if (k === 1) return 'tomorrow';
    return dayLabel(s);
  }
  /** 18:15 -> "6:15 pm" (with a no-break space so am/pm never wraps away). */
  function clock(h, m) { return (h % 12 || 12) + ':' + pad2(m) + ' ' + (h < 12 ? 'am' : 'pm'); }

  /* ================================================================== *
   * The big day
   * ================================================================== */

  var TEMPLATES = ['christmas', 'advent', 'custom'];
  var LOOKS = ['festive', 'winter', 'birthday', 'trip', 'any'];
  var LOOK_WORD = { festive: 'Winter festive', winter: 'Winter', birthday: 'Birthday', trip: 'A trip', any: 'Any time' };
  /** The first Sunday of Advent: the fourth Sunday before 25 December. */
  function adventStart(year) {
    var xmas = daysFromCivil(year, 12, 25), w = weekday(xmas);
    return iso(xmas - (w === 0 ? 7 : w) - 21);
  }
  /** The year a Christmas countdown is for, from today: this year until
   *  24 December, then next year. */
  function christmasYear(today) {
    var n = dayOf(today), c = civil(n);
    return n > daysFromCivil(c.y, 12, 24) ? c.y + 1 : c.y;
  }
  /** The days a countdown covers: {start, end, bigDay, doors, dates[]}. */
  function range(setup) {
    var s = setup || {}, start, end, big;
    if (s.template === 'christmas' || s.template === 'advent') {
      var y = s.year;
      big = y + '-12-25'; end = y + '-12-24';
      start = s.template === 'advent' ? adventStart(y) : y + '-12-01';
    } else {
      big = s.bigDay;
      if (!isIso(big)) return null;
      end = s.ends === 'day' ? big : addDays(big, -1);
      start = addDays(end, -((s.doors || 24) - 1));
    }
    var a = dayOf(start), b = dayOf(end), dates = [];
    for (var n = a; n <= b; n++) dates.push(iso(n));
    return { start: start, end: end, bigDay: big, doors: dates.length, dates: dates };
  }
  function bigName(setup) {
    if (setup.template === 'christmas' || setup.template === 'advent') return setup.name || 'Christmas';
    return setup.name || 'The big day';
  }
  function lookOf(setup) { return setup.template === 'custom' ? setup.look : 'festive'; }
  /** The deck's themes a countdown shows. */
  function themesFor(setup) {
    var l = lookOf(setup);
    if (l === 'festive') return ['festive', 'winter', 'any'];
    if (l === 'any') return ['any'];
    return [l, 'any'];
  }
  function rangeLine(setup) {
    var r = range(setup);
    if (!r) return '';
    return 'Doors ' + dayLabel(r.start) + ' to ' + dayLabel(r.end) + ' - ' + plural(r.doors, 'door') +
      (setup.template === 'custom' ? (setup.ends === 'day' ? ', the last on the day itself' : ', the last on the day before') : '');
  }

  /* ================================================================== *
   * Activities
   * ================================================================== */

  var TIMES = ['quick', 'short', 'evening', 'half'];
  var TIME_WORD = { quick: '5 min', short: '30 min', evening: 'An evening', half: 'Half a day' };
  var TIME_MIN = { quick: 5, short: 30, evening: 90, half: 240 };
  var COSTS = ['free', 'little', 'some'];
  var COST_WORD = { free: 'Free', little: 'A little', some: 'Some' };
  var COST_DEFAULT = { free: 0, little: 300, some: 1000 };   // cents, for an idea or your own with no amount
  var WHERES = ['home', 'nearby', 'outdoors'];
  var WHERE_WORD = { home: 'At home', nearby: 'Out nearby', outdoors: 'Outdoors' };
  var MESSES = ['none', 'some', 'lots'];
  var MESS_WORD = { none: 'No mess', some: 'Some mess', lots: 'Messy' };
  var THEMES = ['festive', 'winter', 'any', 'birthday', 'trip'];
  var THEME_WORD = { festive: 'Winter festive', winter: 'Winter', any: 'Any time', birthday: 'Birthday', trip: 'Trip' };
  var LIKES = ['crafts', 'baking', 'outdoors', 'music', 'building', 'reading', 'giving', 'science', 'games', 'quiet'];
  var LIKE_WORD = { crafts: 'Crafts', baking: 'Baking & cooking', outdoors: 'Outdoors', music: 'Music', building: 'Building', reading: 'Stories & words', giving: 'Giving', science: 'Science', games: 'Games', quiet: 'Quiet & cosy' };
  var EVENINGS = [15, 30, 60, 120];
  var EVENING_WORD = { 15: '15 minutes', 30: 'Half an hour', 60: 'An hour', 120: 'Two hours or more' };
  var BUDGET_MODES = ['none', 'little', 'set'];
  var LITTLE_USD = 25;

  var DECK = DK.DECK.map(function (x) {
    return { id: x.id, t: x.t, th: x.th, tm: x.tm, c: x.c, amt: x.c === 'free' ? 0 : Math.round(x.$ * 100), w: x.w, m: x.m, k: x.k, a: x.a.slice(), n: x.n.slice(), h: x.h, src: 'deck' };
  });
  var DECK_BY = {};
  DECK.forEach(function (x) { DECK_BY[x.id] = x; });
  var DECK_TITLES = {};
  DECK.forEach(function (x) { DECK_TITLES[norm(x.t)] = x.id; });

  var ID = { deck: /^[a-z][a-z0-9-]{2,31}$/, custom: /^c-[a-z0-9]{8}$/, pin: /^p-[a-z0-9]{6}$/, filler: /^(joke|treat|note)-\d{2}$/, cd: /^[a-z0-9]{10}$/ };
  function isDeckId(id) { return typeof id === 'string' && own(DECK_BY, id); }

  /** A filler door: a joke, a tiny treat or a note to each other. */
  function filler(id) {
    var m = /^(joke|treat|note)-(\d{2})$/.exec(str(id));
    if (!m) return null;
    var i = +m[2] - 1, kind = m[1];
    var list = kind === 'joke' ? DK.JOKES : kind === 'treat' ? DK.TREATS : DK.NOTES;
    if (i < 0 || i >= list.length) return null;
    var base = { id: id, filler: kind, tm: 'quick', c: 'free', amt: 0, w: 'home', m: 'none', k: 'quiet', a: [0, 17], n: [], src: 'filler' };
    if (kind === 'joke') return Object.assign(base, { t: 'A joke', h: list[i][0], answer: list[i][1] });
    if (kind === 'treat') return Object.assign(base, { t: 'A tiny treat', h: list[i] });
    return Object.assign(base, { t: 'A note to each other', h: list[i] });
  }
  var FILLER_IDS = [];
  ['joke', 'treat', 'note'].forEach(function (k) {
    var n = (k === 'joke' ? DK.JOKES : k === 'treat' ? DK.TREATS : DK.NOTES).length;
    for (var i = 1; i <= n; i++) FILLER_IDS.push(k + '-' + pad2(i));
  });

  /** Any activity a countdown can name: the deck, your own, a pinned event or a filler. */
  function activity(cd, id) {
    if (!id) return null;
    if (own(DECK_BY, id)) return DECK_BY[id];
    if (ID.custom.test(id)) { var c = (cd.deck.custom || []).filter(function (x) { return x.id === id; })[0]; return c || null; }
    if (ID.pin.test(id)) {
      var p = (cd.setup.pins || []).filter(function (x) { return x.id === id; })[0];
      return p ? { id: p.id, t: p.title, h: 'On the calendar for ' + longDay(p.date) + ' - this is its door. Nothing else tonight.', tm: 'quick', c: 'free', amt: 0, w: 'nearby', m: 'none', k: 'quiet', a: [0, 17], n: [], src: 'pin', date: p.date } : null;
    }
    return filler(id);
  }
  /** What an activity costs this family, in cents (their amount, else its default). */
  function costOf(cd, act) {
    if (!act || act.c === 'free') return 0;
    var o = cd && cd.deck && cd.deck.costs && cd.deck.costs[act.id];
    return typeof o === 'number' && isFinite(o) ? o : act.amt;
  }
  function money(cents) {
    var c = Math.round(cents || 0), neg = c < 0; c = Math.abs(c);
    var d = Math.floor(c / 100), r = c % 100;
    return (neg ? '-' : '') + '$' + groups(d) + (r ? '.' + pad2(r) : '');
  }
  function budgetCap(setup) {
    var b = setup.budget || {};
    return b.mode === 'none' ? 0 : b.mode === 'set' ? Math.round((b.usd || 0) * 100) : LITTLE_USD * 100;
  }
  function budgetWord(setup) {
    var b = setup.budget || {};
    return b.mode === 'none' ? 'No money - free things only' : b.mode === 'set' ? money(b.usd * 100) + ' for the whole countdown' : 'A little - about ' + money(LITTLE_USD * 100);
  }
  function suitsAges(act, ages) {
    if (!ages.length) return true;
    return ages.every(function (g) { return g >= act.a[0] && g <= act.a[1]; });
  }
  function kidAges(setup) { return (setup.kids || []).map(function (k) { return k.age; }).filter(function (a) { return typeof a === 'number'; }); }

  /* ================================================================== *
   * The countdown, and the one door every copy of one goes through
   * ================================================================== */

  function defaultSetup(today) {
    return { template: 'christmas', year: christmasYear(today), name: 'Christmas', bigDay: '', doors: 24, ends: 'eve', look: 'winter', kids: [], adults: 2, busy: [], busyDates: [], pins: [], budget: { mode: 'little', usd: LITTLE_USD }, evening: 30 };
  }
  function newCountdown(id, setup, t) {
    return { id: id, v: 1, setup: setup, setupT: t, deck: { picks: [], custom: [], costs: {} }, deckT: t, plan: {}, doors: {}, shop: {} };
  }

  var KID_NAME = /^[\p{L}][\p{L}\p{M} '’.-]*$/u;
  var SHOP_KEY = /^[a-z0-9][a-z0-9 ]{0,39}$/;
  function isT(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && v < 1e14; }
  function isInt(v, lo, hi) { return typeof v === 'number' && Math.floor(v) === v && v >= lo && v <= hi; }

  /** A typed string: no markup, no invisible characters (strict refuses
   *  them; lenient strips them), bounded. Strict also refuses an @, a link
   *  or nine digits in a row - the account never holds an address or a
   *  number. */
  function text(v, max, path, errs, strict, need) {
    if (typeof v !== 'string') { if (strict && (v !== undefined || need)) errs.push(path + ' must be text.'); return ''; }
    if (strict) {
      if (hasInvisible(v)) errs.push(path + ' has an invisible character.');
      if (hasMarkup(v)) errs.push(path + ' has markup.');
      if (hasAt(v) || hasLink(v) || nineDigits(v)) errs.push(path + ' looks like an address, a link or a number.');
      if (Array.from(v).length > max) errs.push(path + ' is too long.');
    }
    var out = line(v, max);
    if (strict && need && !out) errs.push(path + ' is empty.');
    return out;
  }
  function keysOnly(o, allowed, path, errs, strict) {
    if (!strict) return;
    Object.keys(o).forEach(function (k) { if (allowed.indexOf(k) < 0) errs.push('Unknown field ' + path + k + '.'); });
  }

  function cleanSetup(raw, errs, strict) {
    var s = isObj(raw) ? raw : {};
    if (strict && !isObj(raw)) errs.push('setup is missing.');
    keysOnly(s, ['template', 'year', 'name', 'bigDay', 'doors', 'ends', 'look', 'kids', 'adults', 'busy', 'busyDates', 'pins', 'budget', 'evening'], 'setup.', errs, strict);
    var out = {};
    out.template = TEMPLATES.indexOf(s.template) >= 0 ? s.template : (strict && errs.push('setup.template is not one of the three.'), 'christmas');
    out.year = isInt(s.year, 2024, 2100) ? s.year : (strict && out.template !== 'custom' && errs.push('setup.year is not a year.'), 2026);
    out.name = text(s.name, LIMITS.name, 'setup.name', errs, strict) || (out.template === 'custom' ? 'The big day' : 'Christmas');
    out.bigDay = isIso(s.bigDay) ? s.bigDay : (strict && out.template === 'custom' && errs.push('setup.bigDay is not a date.'), '');
    out.doors = isInt(s.doors, LIMITS.doorsMin, LIMITS.doorsMax) ? s.doors : (strict && out.template === 'custom' && errs.push('setup.doors must be 3 to 31.'), 24);
    out.ends = s.ends === 'day' ? 'day' : 'eve';
    if (strict && s.ends !== undefined && s.ends !== 'day' && s.ends !== 'eve') errs.push('setup.ends is not eve or day.');
    out.look = LOOKS.indexOf(s.look) >= 0 ? s.look : 'winter';
    out.kids = (Array.isArray(s.kids) ? s.kids : []).slice(0, strict ? 99 : LIMITS.kids).map(function (k, i) {
      var p = 'setup.kids[' + i + ']';
      if (!isObj(k)) { if (strict) errs.push(p + ' is not a child.'); return null; }
      keysOnly(k, ['name', 'age'], p + '.', errs, strict);
      var name = text(k.name, LIMITS.kidName, p + '.name', errs, strict);
      if (name && !KID_NAME.test(name)) { if (strict) errs.push(p + '.name: a first name or nickname - letters only.'); name = name.replace(/[^\p{L}\p{M} '’.-]/gu, '').trim(); }
      var age = k.age === null || k.age === undefined ? null : (isInt(k.age, 0, 17) ? k.age : (strict && errs.push(p + '.age must be 0 to 17.'), null));
      return { name: name, age: age };
    }).filter(Boolean);
    if (strict && out.kids.length > LIMITS.kids) errs.push('setup.kids: up to ' + LIMITS.kids + '.');
    out.kids = out.kids.slice(0, LIMITS.kids);
    out.adults = isInt(s.adults, 0, LIMITS.adultsMax) ? s.adults : (strict && s.adults !== undefined && errs.push('setup.adults must be 0 to 8.'), 2);
    out.busy = (Array.isArray(s.busy) ? s.busy : []).filter(function (d, i, a) { var ok = isInt(d, 0, 6) && a.indexOf(d) === i; if (!ok && strict) errs.push('setup.busy has a day that is not a weekday.'); return ok; }).sort();
    out.busyDates = (Array.isArray(s.busyDates) ? s.busyDates : []).filter(function (d, i, a) { var ok = isIso(d) && a.indexOf(d) === i; if (!ok && strict) errs.push('setup.busyDates has something that is not a date.'); return ok; }).sort();
    if (out.busyDates.length > LIMITS.busyDates) { if (strict) errs.push('setup.busyDates: up to ' + LIMITS.busyDates + '.'); out.busyDates = out.busyDates.slice(0, LIMITS.busyDates); }
    out.pins = (Array.isArray(s.pins) ? s.pins : []).map(function (p, i) {
      var pp = 'setup.pins[' + i + ']';
      if (!isObj(p)) { if (strict) errs.push(pp + ' is not an event.'); return null; }
      keysOnly(p, ['id', 'title', 'date'], pp + '.', errs, strict);
      var title = text(p.title, LIMITS.pinTitle, pp + '.title', errs, strict, true);
      if (!ID.pin.test(str(p.id)) || !isIso(p.date) || !title) { if (strict) errs.push(pp + ' needs an id, a title and a date.'); return null; }
      return { id: p.id, title: title, date: p.date };
    }).filter(Boolean);
    var seenPin = {};
    out.pins = out.pins.filter(function (p) { if (seenPin[p.date] || seenPin[p.id]) { if (strict) errs.push('Two events on ' + p.date + '.'); return false; } seenPin[p.date] = seenPin[p.id] = true; return true; });
    if (out.pins.length > LIMITS.pins) { if (strict) errs.push('setup.pins: up to ' + LIMITS.pins + '.'); out.pins = out.pins.slice(0, LIMITS.pins); }
    var b = isObj(s.budget) ? s.budget : {};
    keysOnly(b, ['mode', 'usd'], 'setup.budget.', errs, strict);
    out.budget = { mode: BUDGET_MODES.indexOf(b.mode) >= 0 ? b.mode : (strict && errs.push('setup.budget.mode is not none, little or set.'), 'little'), usd: isInt(b.usd, 0, LIMITS.usdMax) ? b.usd : (strict && b.usd !== undefined && errs.push('setup.budget.usd must be 0 to ' + LIMITS.usdMax + '.'), LITTLE_USD) };
    out.evening = EVENINGS.indexOf(s.evening) >= 0 ? s.evening : (strict && s.evening !== undefined && errs.push('setup.evening is not one of the four.'), 30);
    return out;
  }

  /** Your own activity (typed, or an AI idea someone tapped to add). */
  function cleanActivity(raw, errs, strict, path) {
    var p = path || 'activity';
    if (!isObj(raw)) { if (strict) errs.push(p + ' is not an activity.'); return null; }
    keysOnly(raw, ['id', 't', 'h', 'th', 'tm', 'c', 'amt', 'w', 'm', 'k', 'a', 'n', 'src'], p + '.', errs, strict);
    var t = text(raw.t, LIMITS.title, p + '.t', errs, strict, true);
    var h = text(raw.h, LIMITS.how, p + '.h', errs, strict);
    var en = function (v, list, f) { if (list.indexOf(v) >= 0) return v; if (strict) errs.push(p + '.' + f + ' is not one of ' + list.join(', ') + '.'); return list[0]; };
    var a = Array.isArray(raw.a) && raw.a.length === 2 && isInt(raw.a[0], 0, 17) && isInt(raw.a[1], 0, 17) && raw.a[0] <= raw.a[1] ? [raw.a[0], raw.a[1]] : (strict && errs.push(p + '.a must be two ages, 0 to 17.'), [0, 17]);
    var n = (Array.isArray(raw.n) ? raw.n : []).map(function (x, i) { return text(x, LIMITS.need, p + '.n[' + i + ']', errs, strict); }).filter(Boolean);
    if (n.length > LIMITS.needs) { if (strict) errs.push(p + '.n: up to 4 things.'); n = n.slice(0, LIMITS.needs); }
    var c = en(raw.c, COSTS, 'c');
    var amt = c === 'free' ? 0 : (isInt(raw.amt, 0, LIMITS.amtMax) ? raw.amt : (strict && raw.amt !== undefined && errs.push(p + '.amt must be 0 to ' + LIMITS.amtMax + ' cents.'), COST_DEFAULT[c]));
    var out = { id: raw.id, t: t, h: h, th: en(raw.th, THEMES, 'th'), tm: en(raw.tm, TIMES, 'tm'), c: c, amt: amt, w: en(raw.w, WHERES, 'w'), m: en(raw.m, MESSES, 'm'), k: en(raw.k, LIKES, 'k'), a: a, n: n, src: raw.src === 'ai' ? 'ai' : 'own' };
    if (!ID.custom.test(str(raw.id))) { if (strict) errs.push(p + '.id is not an id.'); return null; }
    if (!t) return null;
    return out;
  }

  function cleanStamped(map, fields, path, errs, strict, keyOk, max) {
    var out = {};
    if (map !== undefined && !isObj(map)) { if (strict) errs.push(path + ' is not a map.'); return out; }
    var keys = Object.keys(map || {});
    if (keys.length > max) { if (strict) errs.push(path + ': too many entries.'); keys = keys.slice(0, max); }
    keys.forEach(function (k) {
      var v = map[k], p = path + '.' + k;
      if (!keyOk(k)) { if (strict) errs.push(p + ': not a valid key.'); return; }
      if (!isObj(v)) { if (strict) errs.push(p + ' is not an entry.'); return; }
      keysOnly(v, Object.keys(fields).concat(['t']), p + '.', errs, strict);
      if (!isT(v.t)) { if (strict) errs.push(p + '.t is not a time.'); return; }
      var e = { t: v.t };
      var bad = false;
      Object.keys(fields).forEach(function (f) { var r = fields[f](v[f]); if (r === undefined) { bad = true; if (strict) errs.push(p + '.' + f + ' is not valid.'); } else e[f] = r; });
      if (!bad) out[k] = e;
    });
    return out;
  }
  var anyId = function (v) { v = v === undefined ? '' : v; return v === '' || ID.deck.test(v) || ID.custom.test(v) || ID.pin.test(v) || ID.filler.test(v) ? v : undefined; };
  var bool = function (v) { return v === undefined ? false : typeof v === 'boolean' ? v : undefined; };
  var STATUSES = ['', 'done', 'skipped', 'moved'];
  var PLAN_FIELDS = { a: anyId, pin: bool };
  var DOOR_FIELDS = { open: bool, status: function (v) { v = v === undefined ? '' : v; return STATUSES.indexOf(v) >= 0 ? v : undefined; }, star: bool, to: function (v) { v = v === undefined ? '' : v; return v === '' || isIso(v) ? v : undefined; } };
  var SHOP_FIELDS = { got: bool };

  /**
   * The one door. Every countdown read back from this phone, from the
   * account, or sent to the server is rebuilt field by field: unknown fields
   * dropped (strict: refused), every enum, date, id and number checked,
   * every string cleaned and bounded. `strict` is the server's mode: it
   * collects every problem in `errors` instead of mending it.
   */
  function cleanCountdown(raw, strict) {
    var errs = [];
    var r = isObj(raw) ? raw : {};
    if (strict && !isObj(raw)) errs.push('Send a countdown.');
    keysOnly(r, ['id', 'v', 'setup', 'setupT', 'deck', 'deckT', 'plan', 'doors', 'shop', 'updatedAt'], '', errs, strict);
    var id = ID.cd.test(str(r.id)) ? r.id : (strict && errs.push('id is not an id.'), '');
    var setup = cleanSetup(r.setup, errs, strict);
    var d = isObj(r.deck) ? r.deck : {};
    keysOnly(d, ['picks', 'custom', 'costs'], 'deck.', errs, strict);
    var custom = (Array.isArray(d.custom) ? d.custom : []).map(function (x, i) { return cleanActivity(x, errs, strict, 'deck.custom[' + i + ']'); }).filter(Boolean);
    var seen = {};
    custom = custom.filter(function (x) { if (seen[x.id]) return false; seen[x.id] = true; return true; });
    if (custom.length > LIMITS.custom) { if (strict) errs.push('deck.custom: up to ' + LIMITS.custom + '.'); custom = custom.slice(0, LIMITS.custom); }
    var picks = (Array.isArray(d.picks) ? d.picks : []).filter(function (x, i, a) {
      var ok = (isDeckId(x) || (ID.custom.test(str(x)) && seen[x])) && a.indexOf(x) === i;
      if (!ok && strict) errs.push('deck.picks has something that is not an activity.');
      return ok;
    });
    if (picks.length > LIMITS.picks) { if (strict) errs.push('deck.picks: too many.'); picks = picks.slice(0, LIMITS.picks); }
    var costs = {};
    if (d.costs !== undefined && !isObj(d.costs)) { if (strict) errs.push('deck.costs is not a map.'); }
    Object.keys(isObj(d.costs) ? d.costs : {}).forEach(function (k) {
      var v = d.costs[k];
      if ((isDeckId(k) || seen[k]) && isInt(v, 0, LIMITS.amtMax)) costs[k] = v;
      else if (strict) errs.push('deck.costs.' + k + ' is not valid.');
    });
    var out = {
      id: id, v: 1, setup: setup,
      setupT: isT(r.setupT) ? r.setupT : (strict && errs.push('setupT is not a time.'), 0),
      deck: { picks: picks, custom: custom, costs: costs },
      deckT: isT(r.deckT) ? r.deckT : (strict && errs.push('deckT is not a time.'), 0),
      plan: cleanStamped(r.plan, PLAN_FIELDS, 'plan', errs, strict, isIso, LIMITS.planDays),
      doors: cleanStamped(r.doors, DOOR_FIELDS, 'doors', errs, strict, isIso, LIMITS.planDays),
      shop: cleanStamped(r.shop, SHOP_FIELDS, 'shop', errs, strict, function (k) { return SHOP_KEY.test(k); }, LIMITS.shop),
    };
    if (isT(r.updatedAt)) out.updatedAt = r.updatedAt;
    if (setup.template === 'custom' && !range(setup)) { if (strict) errs.push('The big day needs a date.'); }
    return { countdown: out, errors: errs };
  }

  /**
   * What the server refuses whole before the one door even looks: any
   * string anywhere with an @ (any width), nine digits in a row, a link,
   * markup or an invisible character. Numbers are numbers - time stamps are
   * never strings. Returns the first problem, or ''.
   */
  function bodyProblem(v, depth) {
    depth = depth || 0;
    if (depth > 8) return 'That is nested too deeply.';
    if (typeof v === 'string') {
      if (hasAt(v)) return 'Something in it has an @ - Ajar keeps no addresses.';
      if (nineDigits(v)) return 'Something in it has nine digits in a row - Ajar keeps no phone or account numbers.';
      if (hasLink(v)) return 'Something in it looks like a link.';
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

  /* ================================================================== *
   * The plan
   * ================================================================== */

  function datesOf(cd) { var r = range(cd.setup); return r ? r.dates : []; }
  /** Everything the rules ask about one day. */
  function info(cd, d) {
    var dates = datesOf(cd), idx = dates.indexOf(d), n = dayOf(d), wd = weekday(n);
    var s = cd.setup, pin = (s.pins || []).filter(function (p) { return p.date === d; })[0] || null;
    var busyWd = (s.busy || []).indexOf(wd) >= 0, busyDate = (s.busyDates || []).indexOf(d) >= 0;
    var door = cd.doors[d] || {}, pl = cd.plan[d] || {};
    return { iso: d, idx: idx, door: idx + 1, wd: wd, weekend: wd === 0 || wd === 6, busy: busyWd || busyDate, busyWhy: busyDate ? 'busy that day' : busyWd ? 'a busy ' + WD_LONG[wd] : '', pin: pin, opened: Boolean(door.open), userPin: Boolean(pl.pin) };
  }
  function planned(cd, d) { var e = cd.plan[d]; return e && e.a ? activity(cd, e.a) : null; }

  /** Why an activity does NOT fit a day under the hard rules, or ''. */
  function misfit(cd, act, inf) {
    if (!act || act.filler) return '';
    if (act.src === 'pin') return act.date === inf.iso ? '' : 'pin';
    if (inf.pin) return 'event';
    var ev = cd.setup.evening;
    if (inf.busy && act.tm !== 'quick') return 'busy';
    if (act.tm === 'half' && !inf.weekend) return 'half';
    if (act.tm === 'evening' && !inf.weekend && ev < 60) return 'evening';
    if (act.tm === 'short' && !inf.weekend && ev < 30) return 'short';
    if (act.n.length && inf.idx >= 0 && inf.idx < 2) return 'buy';
    return '';
  }
  var MISFIT_WORD = {
    busy: function (a, inf) { return cap1(inf.busyWhy) + ' - this takes ' + TIME_WORD[a.tm].toLowerCase() + '.'; },
    half: function (a, inf) { return 'It takes half a day, and ' + WD_LONG[inf.wd] + ' is a school or work day.'; },
    short: function (a, inf) { return 'It takes half an hour, and a normal evening here has 15 minutes.'; },
    buy: function (a, inf) { return 'It needs ' + a.n[0] + ', and door ' + inf.door + ' leaves no time to buy it.'; },
    event: function (a, inf) { return inf.pin.title + ' has this day.'; },
    pin: function () { return 'A fixed event stays on its own date.'; },
    messy: function (a) { return 'Two messy ones in a row.'; },
  };
  function misfitWord(code, act, inf, cd) {
    if (code === 'evening') return 'It takes a whole evening, and a normal ' + WD_LONG[inf.wd] + ' has ' + EVENING_WORD[cd.setup.evening].toLowerCase() + '.';
    return MISFIT_WORD[code](act, inf);
  }
  function messyAt(cd, plan, d) { var e = plan[d]; var a = e && e.a ? activity(cd, e.a) : null; return Boolean(a && a.m === 'lots'); }
  /** Would `act` on `d` sit next to another messy one? */
  function messyClash(cd, plan, act, d) {
    if (!act || act.m !== 'lots') return false;
    return messyAt(cd, plan, addDays(d, -1)) || messyAt(cd, plan, addDays(d, 1));
  }

  /** A small seeded generator (mulberry32). The seed is passed in. */
  function prng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd) { var a = arr.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var x = a[i]; a[i] = a[j]; a[j] = x; } return a; }
  function hashStr(s) { var h = 2166136261; s = str(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  var HARD_ORDER = { half: 0, evening: 1, short: 3, quick: 5 };
  function difficulty(a) { return HARD_ORDER[a.tm] - (a.m === 'lots' ? 1 : 0) - (a.n.length ? 1 : 0); }

  /**
   * Place the chosen activities on the days, deterministically from `seed`.
   *
   *   - a pinned event is its own door, on its date;
   *   - an opened door and a day you pinned keep what they have;
   *   - busy evenings get 5-minute ones and fillers;
   *   - half-day ones go on weekends; a whole evening on a weekend or a
   *     free evening long enough for it;
   *   - nothing that needs shopping on the first two days (time to buy it);
   *   - no two messy ones in a row, and the kinds spread out;
   *   - the total stays under the budget: the dearest are left out (and
   *     said) until it does, and a budget of no money places free ones only;
   *   - empty days get fillers (a joke, a tiny treat, a note).
   *
   * Returns {plan, report: {placed, leftOut: [{id, why}], fillers}}.
   */
  function makePlan(cd, o) {
    var t = o.t, rnd = prng(o.seed);
    var dates = datesOf(cd), plan = {}, used = {}, fixedCost = 0;
    dates.forEach(function (d) {
      var inf = info(cd, d), cur = cd.plan[d];
      if (inf.pin) { plan[d] = { a: inf.pin.id, pin: false, t: cur && cur.a === inf.pin.id ? cur.t : t }; used[inf.pin.id] = true; return; }
      if ((inf.opened || inf.userPin) && cur) {
        plan[d] = clone(cur);
        if (cur.a) { used[cur.a] = true; fixedCost += costOf(cd, activity(cd, cur.a)); }
      }
    });
    var pool = cd.deck.picks.filter(function (id) { return !used[id]; }).map(function (id) { return activity(cd, id); }).filter(Boolean);
    var leftOut = [];
    // The budget first: the dearest go until the rest fit.
    var cap = budgetCap(cd.setup);
    var poolCost = function () { return pool.reduce(function (s, a) { return s + costOf(cd, a); }, 0); };
    if (fixedCost + poolCost() > cap) {
      var dear = pool.filter(function (a) { return costOf(cd, a) > 0; }).sort(function (x, y) { return costOf(cd, y) - costOf(cd, x) || (x.id < y.id ? -1 : 1); });
      for (var i = 0; i < dear.length && fixedCost + poolCost() > cap; i++) {
        pool.splice(pool.indexOf(dear[i]), 1);
        leftOut.push({ id: dear[i].id, why: 'budget' });
      }
    }
    pool = shuffle(pool, rnd).sort(function (x, y) { return difficulty(x) - difficulty(y); });
    var free = function () { return dates.filter(function (d) { return !plan[d]; }); };
    var neighbourKinds = function (act, d) {
      var n = 0;
      [-1, 1].forEach(function (k) { var e = plan[addDays(d, k)]; var b = e && e.a ? activity(cd, e.a) : null; if (b && !b.filler && b.k === act.k) n++; });
      return n;
    };
    var fitsDay = function (act, d) { var inf = info(cd, d); return !misfit(cd, act, inf) && !messyClash(cd, plan, act, d); };
    var score = function (act, d) {
      var inf = info(cd, d), s = rnd() * 0.9;
      if (inf.weekend && (act.tm === 'quick' || act.tm === 'short')) s += 3;   // keep weekends for the big ones
      if (inf.busy) s -= 2;                                                      // a quick one is what a busy evening needs
      if (inf.weekend && (act.tm === 'half' || act.tm === 'evening')) s -= 2;
      s += 2 * neighbourKinds(act, d);
      return s;
    };
    var placed = 0;
    pool.forEach(function (act) {
      var cands = free().filter(function (d) { return fitsDay(act, d); });
      if (!cands.length) {
        // One repair: move something already placed to a free day it fits,
        // and take its day.
        var done = false;
        dates.forEach(function (d) {
          if (done || !plan[d] || !plan[d].mine) return;
          var other = activity(cd, plan[d].a), keep = plan[d];
          delete plan[d];
          if (fitsDay(act, d)) {
            plan[d] = { a: act.id, pin: false, t: t, mine: true };
            var dest = free().filter(function (e) { return !misfit(cd, other, info(cd, e)) && !messyClash(cd, plan, other, e); })[0];
            if (dest) { plan[dest] = keep; placed++; done = true; return; }
          }
          plan[d] = keep;
        });
        if (!done) leftOut.push({ id: act.id, why: free().length ? 'rules' : 'full' });
        return;
      }
      cands.sort(function (x, y) { return score(act, x) - score(act, y); });
      plan[cands[0]] = { a: act.id, pin: false, t: t, mine: true };
      placed++;
    });
    // Fillers on what is left: a joke on a busy evening, otherwise a treat
    // or a note, taking turns so no two in a row are the same kind.
    var jokes = shuffle(FILLER_IDS.filter(function (f) { return f.indexOf('joke') === 0; }), rnd);
    var others = shuffle(FILLER_IDS.filter(function (f) { return f.indexOf('joke') !== 0; }), rnd);
    var fillers = 0;
    free().forEach(function (d, i) {
      var inf = info(cd, d);
      var id = (inf.busy || i % 2 === 0 ? jokes.shift() : others.shift()) || jokes.shift() || others.shift() || '';
      plan[d] = { a: id, pin: false, t: t, mine: true };
      fillers++;
    });
    Object.keys(plan).forEach(function (d) {
      var e = plan[d];
      if (e.mine) { var prev = cd.plan[d]; delete e.mine; if (prev && prev.a === e.a && !prev.pin) e.t = prev.t; }
    });
    return { plan: plan, report: { placed: placed, leftOut: leftOut, fillers: fillers } };
  }
  /** Deck activities that suit this countdown: its themes, every child's
   *  age, and a budget of no money takes free ones only. */
  function suitable(cd) {
    var th = themesFor(cd.setup), ages = kidAges(cd.setup), freeOnly = cd.setup.budget.mode === 'none';
    return DECK.filter(function (a) { return th.indexOf(a.th) >= 0 && suitsAges(a, ages) && (!freeOnly || a.c === 'free'); });
  }
  /**
   * "Pick a good mix for us": enough of each kind of activity for the week
   * this family has - a 5-minute one for most busy evenings (a filler takes
   * the rest), something big for each free weekend day, half-hour ones for
   * the free weekday evenings - kinds spread, within the budget. From `seed`.
   */
  function starterPicks(cd, seed) {
    var rnd = prng(seed), dates = datesOf(cd), want = { quick: 0, short: 0, evening: 0, half: 0 };
    dates.forEach(function (d) {
      var inf = info(cd, d);
      if (inf.pin) return;
      if (inf.busy) want.quick++;
      else if (inf.weekend) { if (want.half <= want.evening) want.half++; else want.evening++; }
      else if (cd.setup.evening >= 60 && rnd() < 0.25) want.evening++;
      else want[cd.setup.evening >= 30 ? 'short' : 'quick']++;
    });
    want.quick = Math.max(0, want.quick - Math.min(2, Math.floor(want.quick / 3)));   // leave room for a filler or two
    var cap = budgetCap(cd.setup), spent = 0, out = [], kinds = {};
    var pool = shuffle(suitable(cd), rnd).sort(function (x, y) { return (kinds[x.k] || 0) - (kinds[y.k] || 0); });
    ['half', 'evening', 'short', 'quick'].forEach(function (tm) {
      var got = 0;
      pool.filter(function (a) { return a.tm === tm; }).sort(function (x, y) { return (kinds[x.k] || 0) - (kinds[y.k] || 0); }).forEach(function (a) {
        if (got >= want[tm]) return;
        var c = costOf(cd, a);
        if (spent + c > cap) return;
        spent += c; got++; out.push(a.id); kinds[a.k] = (kinds[a.k] || 0) + 1;
      });
    });
    return out;
  }
  /** The countdown with a fresh plan (pinned, opened and fixed days kept). */
  function replan(cd, o) {
    var r = makePlan(cd, o);
    var next = clone(cd);
    // Days outside the range are dropped; days inside take the new entry
    // only when it changed, so an unchanged day keeps its time stamp.
    next.plan = {};
    Object.keys(r.plan).forEach(function (d) {
      var old = cd.plan[d], e = r.plan[d];
      next.plan[d] = old && old.a === e.a && Boolean(old.pin) === Boolean(e.pin) ? old : e;
    });
    return { cd: next, report: r.report };
  }

  /**
   * Every rule, checked on the plan as it stands (the planner's, or after a
   * "swap anyway"): [{iso, door, code, msg}] plus the plan-level problems.
   */
  function checkPlan(cd) {
    var out = [], dates = datesOf(cd);
    dates.forEach(function (d) {
      var inf = info(cd, d), act = planned(cd, d);
      if (!act) { out.push({ iso: d, door: inf.door, code: 'empty', msg: 'Door ' + inf.door + ' has nothing behind it.' }); return; }
      var m = misfit(cd, act, inf);
      if (m) out.push({ iso: d, door: inf.door, code: m, msg: 'Door ' + inf.door + ': ' + misfitWord(m, act, inf, cd) });
      if (act.m === 'lots' && messyAt(cd, cd.plan, addDays(d, 1))) out.push({ iso: d, door: inf.door, code: 'messy', msg: 'Doors ' + inf.door + ' and ' + (inf.door + 1) + ' are both messy.' });
    });
    return out;
  }
  /** Picks that are on no day. */
  function unplaced(cd) {
    var on = {};
    datesOf(cd).forEach(function (d) { var e = cd.plan[d]; if (e && e.a) on[e.a] = true; });
    return cd.deck.picks.filter(function (id) { return !on[id]; });
  }

  /** Why this day has what it has, in a few words. */
  function explain(cd, d) {
    var inf = info(cd, d), act = planned(cd, d);
    if (!act) return { text: 'Nothing here yet', warn: true };
    if (act.src === 'pin') return { text: 'Fixed: ' + act.t + ' - a quick door', warn: false };
    var m = misfit(cd, act, inf), messy = act.m === 'lots' && (messyAt(cd, cd.plan, addDays(d, -1)) || messyAt(cd, cd.plan, addDays(d, 1)));
    if (m) return { text: misfitWord(m, act, inf, cd) + ' (moved here by hand)', warn: true };
    if (messy) return { text: 'Messy, next to another messy one (moved here by hand)', warn: true };
    var bits = [];
    if (inf.userPin) bits.push('Pinned by you');
    if (act.filler) bits.push(inf.busy ? cap1(inf.busyWhy) + ' - a one-minute door' : 'A spare door - something tiny');
    else if (inf.busy) bits.push(cap1(inf.busyWhy) + ' - 5 minutes');
    else if (act.tm === 'half') bits.push(WD_LONG[inf.wd] + ' - room for half a day');
    else if (act.tm === 'evening') bits.push(inf.weekend ? WD_LONG[inf.wd] + ' - time for a longer one' : 'A free evening - room for a longer one');
    else if (inf.weekend && act.tm === 'short') bits.push(WD_LONG[inf.wd] + ' - an easy half hour');
    else if (act.tm === 'short') bits.push('A free evening - half an hour');
    else bits.push('A quick one');
    if (!act.filler && act.n.length) bits.push('needs shopping - on the list by ' + dayLabel(addDays(d, -1)));
    else if (!act.filler && inf.idx < 2) bits.push('door ' + inf.door + ' - nothing to buy yet');
    if (act.m === 'lots') bits.push('messy - tidy days either side');
    return { text: bits.join(' · '), warn: false };
  }

  /** A refusal always carries a way out the page draws as a button. */
  function no(msg, way) { return { ok: false, msg: msg, way: way }; }

  /**
   * Swap the activities on two days. Refused (with a way out) for a fixed
   * event, an opened door, a pinned day (way out: unpin and swap) and a swap
   * that breaks a rule (way out: swap anyway).
   */
  function swap(cd, d1, d2, o) {
    o = o || {};
    var dates = datesOf(cd);
    if (d1 === d2) return no('Pick two different days.', { label: 'Pick another day', act: 'cancel' });
    if (dates.indexOf(d1) < 0 || dates.indexOf(d2) < 0) return no('That day is not in this countdown.', { label: 'Pick another day', act: 'cancel' });
    var i1 = info(cd, d1), i2 = info(cd, d2);
    var fixed = [i1, i2].filter(function (x) { return x.pin; })[0];
    if (fixed) return no(fixed.pin.title + ' stays on ' + dayLabel(fixed.iso) + ' - it is a fixed date.', { label: 'Change it in Setup', act: 'setup' });
    var opened = [i1, i2].filter(function (x) { return x.opened; })[0];
    if (opened) return no('Door ' + opened.door + ' is already open - an opened door keeps its activity.', { label: 'Pick a door that’s still shut', act: 'cancel' });
    var pinned = [i1, i2].filter(function (x) { return x.userPin; })[0];
    if (pinned && !o.unpin) return no('Door ' + pinned.door + ' is pinned to ' + dayLabel(pinned.iso) + '.', { label: 'Unpin it and swap', act: 'swap', unpin: true });
    var e1 = cd.plan[d1] || { a: '' }, e2 = cd.plan[d2] || { a: '' };
    var next = clone(cd);
    next.plan[d1] = { a: e2.a, pin: false, t: o.t };
    next.plan[d2] = { a: e1.a, pin: false, t: o.t };
    if (!o.force) {
      var probs = [];
      [[d1, e2.a], [d2, e1.a]].forEach(function (p) {
        var act = activity(cd, p[1]), inf = info(next, p[0]);
        var m = misfit(next, act, inf);
        if (m) probs.push(act.t + ': ' + misfitWord(m, act, inf, cd));
        else if (messyClash(next, next.plan, act, p[0])) probs.push(act.t + ': it would sit next to another messy one.');
      });
      if (probs.length) return no(probs.join(' '), { label: 'Swap anyway', act: 'swap', force: true, unpin: Boolean(o.unpin) });
    }
    return { ok: true, cd: next, msg: 'Swapped doors ' + i1.door + ' and ' + i2.door + '.' };
  }

  /**
   * From an opened door: "not tonight - move it to another day". The
   * activity goes to a later shut day, and that day's activity (often a
   * little filler) comes to tonight's door instead. The door is marked
   * moved.
   */
  function move(cd, from, to, o) {
    o = o || {};
    var dates = datesOf(cd);
    if (dates.indexOf(from) < 0 || dates.indexOf(to) < 0) return no('That day is not in this countdown.', { label: 'Pick another day', act: 'cancel' });
    var f = info(cd, from), g = info(cd, to);
    if (!f.opened) return no('Open door ' + f.door + ' first.', { label: 'Open it', act: 'open' });
    if ((cd.doors[from] || {}).status === 'moved') return no('Door ' + f.door + '’s activity has already moved.', { label: 'Keep tonight’s', act: 'cancel' });
    if (dayOf(to) <= dayOf(from) || (o.today && dayOf(to) <= dayOf(o.today))) return no('Move it to a day that hasn’t come yet.', { label: 'Pick a later day', act: 'cancel' });
    if (g.pin) return no(g.pin.title + ' has ' + dayLabel(to) + '.', { label: 'Pick another day', act: 'cancel' });
    if (g.opened) return no('Door ' + g.door + ' is already open.', { label: 'Pick another day', act: 'cancel' });
    if (g.userPin && !o.unpin) return no('Door ' + g.door + ' is pinned.', { label: 'Unpin it and move', act: 'move', unpin: true });
    var act = planned(cd, from);
    if (!act || act.src === 'pin') return no('A fixed event stays on its own date.', { label: 'Keep it', act: 'cancel' });
    if (!o.force) {
      var tmp = clone(cd); tmp.plan[to] = { a: act.id, t: o.t }; tmp.plan[from] = { a: (cd.plan[to] || {}).a || '', t: o.t };
      var m = misfit(tmp, act, info(tmp, to));
      if (m) return no(misfitWord(m, act, info(tmp, to), cd), { label: 'Move it anyway', act: 'move', force: true, unpin: Boolean(o.unpin) });
    }
    var next = clone(cd);
    var there = (cd.plan[to] || {}).a || '';
    next.plan[to] = { a: act.id, pin: false, t: o.t };
    next.plan[from] = { a: there, pin: false, t: o.t };
    next.doors[from] = Object.assign({}, cd.doors[from], { status: 'moved', to: to, t: o.t });
    return { ok: true, cd: next, msg: act.t + ' moved to ' + dayLabel(to) + '.' };
  }

  function togglePin(cd, d, o) {
    var inf = info(cd, d);
    if (inf.idx < 0) return no('That day is not in this countdown.', { label: 'Back to the plan', act: 'cancel' });
    if (inf.pin) return no(inf.pin.title + ' is already fixed to its date.', { label: 'Change it in Setup', act: 'setup' });
    if (inf.opened) return no('Door ' + inf.door + ' is open - it stays as it is anyway.', { label: 'Back to the plan', act: 'cancel' });
    var next = clone(cd), e = next.plan[d] || { a: '' };
    next.plan[d] = { a: e.a || '', pin: !e.pin, t: o.t };
    return { ok: true, cd: next, msg: e.pin ? 'Door ' + inf.door + ' unpinned - a shuffle can move it.' : 'Door ' + inf.door + ' pinned - a shuffle leaves it where it is.' };
  }

  /* ================================================================== *
   * The shopping list and the budget
   * ================================================================== */

  /** "Paper plates" and "paper plate" are one thing on the list. */
  function shopKey(s) {
    return norm(s).replace(/^(a|an|some|the) /, '').split(' ').map(function (w) { return w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w; }).join(' ').slice(0, LIMITS.shopKey).trim();
  }
  /** Monday of a date's week. */
  function weekStart(d) { var n = dayOf(d); return iso(n - ((weekday(n) + 6) % 7)); }

  /**
   * Every planned activity's needs, rolled up and de-duplicated, each to buy
   * by the day before it is first used, grouped by week. `today` marks what
   * is due.
   */
  function shopping(cd, today) {
    var dates = datesOf(cd), items = {}, order = [];
    dates.forEach(function (d) {
      var act = planned(cd, d);
      if (!act || act.filler || act.src === 'pin') return;
      act.n.forEach(function (need) {
        var k = shopKey(need);
        if (!k) return;
        if (!items[k]) { items[k] = { key: k, label: line(need, LIMITS.need), first: d, by: addDays(d, -1), uses: [] }; order.push(k); }
        items[k].uses.push({ iso: d, door: dates.indexOf(d) + 1, title: act.t });
      });
    });
    var list = order.map(function (k) {
      var it = items[k], st = cd.shop[k] || {};
      it.got = Boolean(st.got);
      it.byLabel = dayLabel(it.by);
      it.due = !today || it.got ? '' : dayOf(it.by) < dayOf(today) ? 'late' : it.by === today ? 'today' : dayOf(it.by) - dayOf(today) === 1 ? 'tomorrow' : '';
      return it;
    }).sort(function (a, b) { return dayOf(a.by) - dayOf(b.by) || (a.label < b.label ? -1 : 1); });
    var start = dates[0], groupsOut = [], byG = {};
    list.forEach(function (it) {
      var g = dayOf(it.by) < dayOf(start) ? 'before' : weekStart(it.by);
      if (!byG[g]) { byG[g] = { key: g, label: g === 'before' ? 'Before door 1 (' + dayLabel(start) + ')' : 'Week of ' + dayLabel(g), items: [] }; groupsOut.push(byG[g]); }
      byG[g].items.push(it);
    });
    var got = list.filter(function (x) { return x.got; }).length;
    return { items: list, groups: groupsOut, got: got, left: list.length - got };
  }
  /** Per-door costs and the total against the budget. */
  function budget(cd) {
    var cap = budgetCap(cd.setup), rows = [], total = 0;
    datesOf(cd).forEach(function (d, i) {
      var act = planned(cd, d);
      var c = act ? costOf(cd, act) : 0;
      if (c > 0) rows.push({ iso: d, door: i + 1, title: act.t, cents: c });
      total += c;
    });
    var over = total - cap;
    var word = cd.setup.budget.mode === 'none'
      ? (total > 0 ? 'The plan costs ' + money(total) + ', and the budget is no money - ' + money(total) + ' over.' : 'Nothing in the plan costs money.')
      : over > 0 ? 'The plan costs ' + money(total) + ' and the budget is ' + money(cap) + ' - ' + money(over) + ' over.' : money(total) + ' of ' + money(cap) + ' - ' + money(-over) + ' left.';
    return { cap: cap, total: total, left: Math.max(0, -over), over: Math.max(0, over), rows: rows, word: word };
  }
  /** The list as plain text, to share or paste. */
  function shopText(cd, today) {
    var s = shopping(cd, today);
    var out = ['Shopping for ' + bigName(cd.setup) + ' (' + plural(s.items.length, 'thing') + ' to get)'];
    s.groups.forEach(function (g) {
      out.push('', g.label);
      g.items.forEach(function (it) {
        out.push((it.got ? '[x] ' : '[ ] ') + it.label + ' - by ' + it.byLabel + ' (door ' + it.uses[0].door + (it.uses.length > 1 ? ' and ' + plural(it.uses.length - 1, 'more') : '') + ')');
      });
    });
    return out.join('\n');
  }

  /* ================================================================== *
   * The doors
   * ================================================================== */

  /** One door as the calendar draws it, from a passed-in today. */
  function door(cd, d, today) {
    var dates = datesOf(cd), i = dates.indexOf(d);
    if (i < 0) return null;
    var st = cd.doors[d] || {}, act = planned(cd, d), k = dayOf(d) - dayOf(today);
    var state = st.open ? 'open' : k > 0 ? 'shut' : k === 0 ? 'today' : 'missed';
    return { iso: d, n: i + 1, state: state, locked: k > 0, opens: k > 0 ? opensWord(d, today) : '', act: act, status: st.status || '', star: Boolean(st.star), to: st.to || '', label: dayLabel(d) };
  }
  function doors(cd, today) { return datesOf(cd).map(function (d) { return door(cd, d, today); }); }
  /** The positions on the calendar: the door numbers shuffled once, the same
   *  every time for this countdown. */
  function layout(cd) {
    var n = datesOf(cd).length, nums = [];
    for (var i = 1; i <= n; i++) nums.push(i);
    return shuffle(nums, prng(hashStr(cd.id + ':doors')));
  }
  function openDoor(cd, d, today, t) {
    var x = door(cd, d, today);
    if (!x) return no('That door is not on this calendar.', { label: 'Back to the doors', act: 'cancel' });
    if (x.locked) return no('Door ' + x.n + ' ' + x.opens.replace(/^Opens/, 'opens') + '.', { label: 'A grown-up can peek in the plan', act: 'plan' });
    var next = clone(cd);
    next.doors[d] = Object.assign({ status: '', star: false, to: '' }, cd.doors[d], { open: true, t: t });
    return { ok: true, cd: next };
  }
  function setStatus(cd, d, status, t) {
    var st = cd.doors[d] || {};
    if (!st.open) return no('Open the door first.', { label: 'Open it', act: 'open' });
    if (st.status === 'moved') return no('This one moved to ' + dayLabel(st.to) + '.', { label: 'Go to that door', act: 'cancel' });
    if (['', 'done', 'skipped'].indexOf(status) < 0) return no('Not a door state.', { label: 'Back', act: 'cancel' });
    var next = clone(cd);
    next.doors[d] = Object.assign({}, st, { status: st.status === status ? '' : status, t: t });
    return { ok: true, cd: next };
  }
  function toggleStar(cd, d, t) {
    var st = cd.doors[d] || {};
    if (!st.open) return no('Open the door first.', { label: 'Open it', act: 'open' });
    var next = clone(cd);
    next.doors[d] = Object.assign({}, st, { star: !st.star, t: t });
    return { ok: true, cd: next };
  }
  /** The day after the last door, or every door open. */
  function isOver(cd, today) {
    var ds = datesOf(cd);
    if (!ds.length) return false;
    return dayOf(today) > dayOf(ds[ds.length - 1]) || ds.every(function (d) { return (cd.doors[d] || {}).open; });
  }
  /** Days to go to the big day (0 on the day). */
  function daysToGo(cd, today) { var r = range(cd.setup); return r ? dayOf(r.bigDay) - dayOf(today) : 0; }

  /* ================================================================== *
   * Kid mode: the grown-up question
   * ================================================================== */

  /** "7 + 5" and four big choices, from a number the page passes in (the
   *  core rolls no dice). A speed bump for small fingers, not a lock. */
  function kidQuestion(n) {
    n = Math.abs(Math.floor(Number(n) || 0));
    var a = 4 + (n % 6), b = 4 + (Math.floor(n / 6) % 6), ans = a + b;
    var opts = [ans, ans + 1, ans - 1, ans + 2];
    var r = prng(n + 7);
    return { a: a, b: b, text: a + ' + ' + b, answer: ans, choices: shuffle(opts, r) };
  }

  /* ================================================================== *
   * Print: door cards, eight to a sheet, and the fridge plan
   * ================================================================== */

  var PAPERS = { letter: { id: 'letter', name: 'Letter', w: 215.9, h: 279.4, css: 'letter' }, a4: { id: 'a4', name: 'A4', w: 210, h: 297, css: 'A4' } };
  var MARGIN = 9;
  /** Letter where it is the paper in the shops, A4 everywhere else. */
  function paperFor(locale) {
    var l = str(locale);
    return /^(en-(US|CA|PH)|es-(US|MX|CO|VE|CL|GT|PR|CR|PA|DO|SV|HN|NI|BO|EC|PE)|fr-CA|fil)\b/i.test(l) || /^en$/i.test(l) ? 'letter' : 'a4';
  }
  var f1 = function (v) { return Math.floor(v * 10 + 1e-9) / 10; };
  /** Eight cards a sheet, two across and four down, edge to edge inside the
   *  margins so one cut separates two cards. In millimetres. */
  function cardGrid(paperIn) {
    var P = PAPERS[paperIn] || PAPERS.letter;
    var cols = 2, rows = 4;
    var w = f1((P.w - 2 * MARGIN) / cols), h = f1((P.h - 2 * MARGIN - 2) / rows);
    var cards = [];
    for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) cards.push({ i: r * cols + c, x: f1(MARGIN + c * w), y: f1(MARGIN + r * h), w: w, h: h });
    var x0 = MARGIN, y0 = MARGIN, x1 = f1(MARGIN + cols * w), y1 = f1(MARGIN + rows * h), cuts = [];
    for (var cc = 0; cc <= cols; cc++) cuts.push({ x1: f1(x0 + cc * w), y1: y0, x2: f1(x0 + cc * w), y2: y1 });
    for (var rr = 0; rr <= rows; rr++) cuts.push({ x1: x0, y1: f1(y0 + rr * h), x2: x1, y2: f1(y0 + rr * h) });
    return { paper: P, per: 8, cols: cols, rows: rows, margin: MARGIN, w: w, h: h, cards: cards, cuts: cuts };
  }
  /** What each door's card says, door 1 first. */
  function cards(cd) {
    return datesOf(cd).map(function (d, i) {
      var act = planned(cd, d) || { t: 'A surprise', h: '', n: [] };
      return { n: i + 1, iso: d, day: dayLabel(d), title: act.t, how: act.h + (act.answer ? ' ' + act.answer : ''), answer: act.answer || '', needs: act.n.slice(), filler: act.filler || '' };
    });
  }
  /** A card's text cut to fit: titles 50, how 160 at most already; the card
   *  holds the title on two lines and the how on five. */
  function sheets(cd) { var cs = cards(cd), out = []; for (var i = 0; i < cs.length; i += 8) out.push(cs.slice(i, i + 8)); return out; }
  /** The fridge plan: the weeks as rows of Monday to Sunday. */
  function fridge(cd) {
    var ds = datesOf(cd);
    if (!ds.length) return { weeks: [] };
    var first = dayOf(weekStart(ds[0])), last = dayOf(ds[ds.length - 1]), weeks = [];
    for (var w = first; w <= last; w += 7) {
      var row = [];
      for (var k = 0; k < 7; k++) {
        var d = iso(w + k), i = ds.indexOf(d), act = i >= 0 ? planned(cd, d) : null;
        row.push(i < 0 ? { iso: d, blank: true, day: civil(w + k).d } : { iso: d, n: i + 1, day: civil(w + k).d, title: act ? act.t : '', busy: info(cd, d).busy, needs: act && act.n.length > 0 });
      }
      weeks.push(row);
    }
    return { weeks: weeks };
  }

  /* ================================================================== *
   * The end: the recap
   * ================================================================== */

  function recap(cd, today) {
    var ds = datesOf(cd), opened = 0, done = 0, skipped = 0, moved = 0, favs = [];
    var grid = ds.map(function (d, i) {
      var st = cd.doors[d] || {}, act = planned(cd, d);
      if (st.open) opened++;
      if (st.status === 'done') done++;
      if (st.status === 'skipped') skipped++;
      if (st.status === 'moved') moved++;
      if (st.star && act) favs.push({ n: i + 1, iso: d, title: act.t });
      return { n: i + 1, iso: d, open: Boolean(st.open), status: st.status || '', star: Boolean(st.star) };
    });
    return { over: isOver(cd, today), doors: ds.length, opened: opened, done: done, skipped: skipped, moved: moved, stars: favs.length, favourites: favs, grid: grid, name: bigName(cd.setup) };
  }
  /** The recap card's words (1080 x 1350, drawn on the phone). */
  function recapCard(cd, today) {
    var r = recap(cd, today), rg = range(cd.setup);
    var c1 = rg ? civil(dayOf(rg.start)) : null;
    return {
      title: r.name,
      sub: plural(r.doors, 'door') + (c1 ? ' · ' + MON_LONG[c1.m - 1] + ' ' + c1.y : ''),
      counts: [[r.opened, 'opened'], [r.done, 'done'], [r.skipped, 'skipped'], [r.stars, r.stars === 1 ? 'favourite' : 'favourites']],
      grid: r.grid,
      favourites: r.favourites.slice(0, 4).map(function (f) { return f.title; }),
      more: Math.max(0, r.favourites.length - 4),
    };
  }
  /** Cut `s` until `measure(s)` fits `max` pixels, with an ellipsis. */
  function fitText(measure, s, max) {
    s = str(s);
    if (measure(s) <= max) return s;
    var cps = Array.from(s);
    while (cps.length > 1 && measure(cps.join('').replace(/\s+$/, '') + '…') > max) cps.pop();
    return cps.join('').replace(/\s+$/, '') + '…';
  }
  /** Words onto at most `lines` lines of `width`; the last is cut to fit. */
  function wrapText(measure, s, width, lines) {
    var words = str(s).split(/\s+/).filter(Boolean), out = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var next = cur ? cur + ' ' + words[i] : words[i];
      if (measure(next) <= width || !cur) { cur = next; continue; }
      out.push(cur); cur = words[i];
      if (out.length === lines - 1) { cur = words.slice(i).join(' '); break; }
    }
    if (cur) out.push(cur);
    return out.slice(0, lines).map(function (l, i) { return i === lines - 1 || measure(l) > width ? fitText(measure, l, width) : l; });
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
  function later(x, y) {
    if (x.t !== y.t) return x.t > y.t ? x : y;
    return canon(x) >= canon(y) ? x : y;   // the same answer from either side
  }
  /**
   * Merge this phone's copy `a` with the account's `b`. Each day of the plan,
   * each door and each shopping tick carries its own time, and so do the
   * setup and the deck as wholes: for each, the later change wins, so an
   * edit on one phone and a door opened on the other both survive. A key both
   * phones changed since `since` (this phone's last sync) is noted. The
   * result is the same whichever side is `a` (symmetric), and merging it
   * again changes nothing (idempotent).
   */
  function merge(a, b, since) {
    since = typeof since === 'number' ? since : 0;
    var out = { id: a.id || b.id, v: 1 }, both = [];
    [['setup', 'setupT'], ['deck', 'deckT']].forEach(function (p) {
      var x = { v: a[p[0]], t: a[p[1]] || 0 }, y = { v: b[p[0]], t: b[p[1]] || 0 };
      var w = canon(x.v) === canon(y.v) ? (x.t >= y.t ? x : y) : later(x, y);
      if (canon(x.v) !== canon(y.v) && x.t > since && y.t > since) both.push({ what: p[0] });
      out[p[0]] = clone(w.v); out[p[1]] = w.t;
    });
    ['plan', 'doors', 'shop'].forEach(function (f) {
      var A = a[f] || {}, B = b[f] || {}, m = {};
      Object.keys(A).concat(Object.keys(B)).sort().forEach(function (k) {
        if (own(m, k)) return;
        var x = A[k], y = B[k];
        if (!x) { m[k] = clone(y); return; }
        if (!y) { m[k] = clone(x); return; }
        if (canon(x) === canon(y)) { m[k] = clone(x); return; }
        m[k] = clone(later(x, y));
        if (x.t > since && y.t > since) both.push({ what: f, key: k });
      });
      out[f] = m;
    });
    var u = Math.max(a.updatedAt || 0, b.updatedAt || 0);
    if (u) out.updatedAt = u;
    var notes = both.map(function (x) {
      if (x.what === 'plan') return dayLabel(x.key) + ' was changed on both phones - kept the later change.';
      if (x.what === 'doors') return 'Door ' + (datesOf(out).indexOf(x.key) + 1) + ' was changed on both phones - kept the later change.';
      if (x.what === 'shop') return 'A shopping tick changed on both phones - kept the later one.';
      return (x.what === 'setup' ? 'The setup' : 'The deck') + ' was changed on both phones - kept the later change.';
    });
    return { cd: out, both: both.length, notes: notes };
  }
  /** Two copies hold the same countdown (times aside from updatedAt). */
  function same(a, b) { var x = clone(a), y = clone(b); delete x.updatedAt; delete y.updatedAt; return canon(x) === canon(y); }

  /* ================================================================== *
   * The AI: "More ideas for us"
   * ================================================================== */

  var AI_BUDGETS = ['free', 'little', 'some'];
  var AI_FIELDS = ['theme', 'month', 'ages', 'likes', 'budget', 'count', 'avoid'];
  /** What the page sends: the kids' AGES (never names), the chips, the
   *  budget and the month, the theme, how many, and the deck ids already
   *  chosen - never a title the family typed. */
  function ideasPayload(cd, likes, count) {
    var s = cd.setup, r = range(s);
    // The budget word per activity: a set amount spread over the doors.
    var per = s.budget.mode === 'set' && r ? (s.budget.usd || 0) / r.doors : 0;
    var b = s.budget.mode === 'none' ? 'free' : s.budget.mode === 'little' || per < 3 ? 'little' : 'some';
    return {
      theme: lookOf(s) === 'any' ? 'any' : lookOf(s),
      month: r ? monthOf(r.start) : 12,
      ages: kidAges(s).slice(0, LIMITS.aiAges).sort(function (x, y) { return x - y; }),
      likes: LIKES.filter(function (k) { return (likes || []).indexOf(k) >= 0; }),
      budget: b,
      count: Math.max(LIMITS.aiMin, Math.min(LIMITS.aiMax, Math.floor(count) || 8)),
      avoid: cd.deck.picks.filter(isDeckId).slice(0, LIMITS.aiAvoid),
    };
  }
  /** The request, rebuilt field by field: exactly these seven, or a refusal
   *  that costs nothing. */
  function ideasRequest(body) {
    var bad = function (msg, code) { return { error: msg, code: code || 'bad-request' }; };
    if (!isObj(body)) return bad('Send the ideas request.');
    var extra = Object.keys(body).filter(function (k) { return AI_FIELDS.indexOf(k) < 0; });
    if (extra.length) return bad('Only the theme, month, ages, chips, budget, count and chosen deck ids are sent - not ' + extra.slice(0, 3).join(', ') + '.', 'extra-field');
    if (THEMES.indexOf(body.theme) < 0) return bad('Pick a theme from the list.');
    if (!isInt(body.month, 1, 12)) return bad('The month is 1 to 12.');
    if (!Array.isArray(body.ages) || body.ages.length > LIMITS.aiAges) return bad('Up to ' + LIMITS.aiAges + ' ages.');
    if (body.ages.some(function (g) { return typeof g === 'string'; })) return bad('Ages only, as whole numbers - never names.', 'names');
    if (!body.ages.every(function (g) { return isInt(g, 0, 17); })) return bad('Each age is a whole number from 0 to 17.');
    if (!Array.isArray(body.likes) || body.likes.length > LIKES.length || !body.likes.every(function (k, i, a) { return LIKES.indexOf(k) >= 0 && a.indexOf(k) === i; })) return bad('Pick chips from the list.');
    if (AI_BUDGETS.indexOf(body.budget) < 0) return bad('The budget is free, a little or some.');
    if (!isInt(body.count, LIMITS.aiMin, LIMITS.aiMax)) return bad('Ask for ' + LIMITS.aiMin + ' to ' + LIMITS.aiMax + ' ideas.');
    if (!Array.isArray(body.avoid) || body.avoid.length > LIMITS.aiAvoid) return bad('Up to ' + LIMITS.aiAvoid + ' chosen ids.');
    if (!body.avoid.every(function (x, i, a) { return isDeckId(x) && a.indexOf(x) === i; })) return bad('Only ids from the built-in deck - your own ideas are never sent.', 'not-deck');
    var ages = body.ages.slice().sort(function (x, y) { return x - y; });
    return { req: { theme: body.theme, month: body.month, ages: ages, likes: body.likes.slice(), budget: body.budget, count: body.count, avoid: body.avoid.slice() } };
  }
  var KIND_WORDS = [['baking', /\b(bake|baking|biscuit|cake|cook|dough|pancake|soup|pizza|bread|muffin|recipe)/i], ['science', /\b(science|experiment|freeze|crystal|fizz|magnet|grow|stars?|moon)\b/i], ['music', /\b(song|sing|music|dance|band|drum)/i], ['outdoors', /\b(walk|park|garden|outside|outdoor|hike|woods?)\b/i], ['building', /\b(build|tower|fort|den|box|construct)/i], ['reading', /\b(read|story|stories|book|poem|words?)\b/i], ['giving', /\b(give|giving|kind|neighbou?r|thank|donate|card for)/i], ['games', /\b(game|quiz|hunt|race|play|charades|bingo)\b/i], ['crafts', /\b(paint|draw|glue|craft|paper|make|cut)/i]];
  function guessKind(s, likes) { for (var i = 0; i < KIND_WORDS.length; i++) if (KIND_WORDS[i][1].test(s)) return KIND_WORDS[i][0]; return (likes && likes[0]) || 'quiet'; }
  /** A field a model wrote, kept only if it carries nothing it should not:
   *  markup and bidi are taken out; an @, a link, a phone-like number, a
   *  formula or a brand drops it. */
  function aiField(v, max) {
    if (typeof v !== 'string') return '';
    var s = line(v, max);
    if (!s || hasAt(s) || hasLink(s) || hasPhone(s) || isFormula(s) || namesBrand(s)) return '';
    return s;
  }
  /**
   * The model's answer, checked: at most `count` ideas; each title and how
   * clean; the deck's enums only; needs up to four short things; ages
   * clamped into the asked range (no overlap drops it); a cost the budget
   * allows; nothing that repeats a deck title, an already-chosen one or
   * another idea. Returns {ideas, dropped} or {error}.
   */
  function cleanIdeas(raw, req) {
    var list = isObj(raw) && Array.isArray(raw.ideas) ? raw.ideas : [];
    var lo = req.ages.length ? req.ages[0] : 0, hi = req.ages.length ? req.ages[req.ages.length - 1] : 17;
    var seen = {}, out = [], dropped = 0;
    var chosen = {};
    req.avoid.forEach(function (id) { chosen[norm(DECK_BY[id].t)] = true; });
    var allowedCost = req.budget === 'free' ? ['free'] : req.budget === 'little' ? ['free', 'little'] : COSTS;
    list.forEach(function (x) {
      if (out.length >= req.count) { dropped++; return; }
      if (!isObj(x)) { dropped++; return; }
      var title = aiField(x.title, LIMITS.title), how = aiField(x.how, LIMITS.how);
      var key = norm(title);
      var ok = title && how && key && !own(DECK_TITLES, key) && !chosen[key] && !seen[key] &&
        TIMES.indexOf(x.time) >= 0 && COSTS.indexOf(x.cost) >= 0 && WHERES.indexOf(x.where) >= 0 && MESSES.indexOf(x.mess) >= 0 &&
        allowedCost.indexOf(x.cost) >= 0 && isInt(x.ageMin, 0, 17) && isInt(x.ageMax, 0, 17) && x.ageMin <= x.ageMax &&
        x.ageMax >= lo && x.ageMin <= hi;
      if (!ok) { dropped++; return; }
      var needs = (Array.isArray(x.needs) ? x.needs : []).slice(0, LIMITS.needs).map(function (n) { return aiField(n, LIMITS.need); }).filter(Boolean);
      seen[key] = true;
      out.push({ title: title, how: how, time: x.time, cost: x.cost, where: x.where, mess: x.mess, needs: needs, ageMin: Math.max(x.ageMin, lo), ageMax: Math.min(x.ageMax, hi) });
    });
    if (!out.length) return { error: 'Nothing usable came back. Try other chips - the built-in deck is free.', code: 'empty' };
    return { ideas: out, dropped: dropped };
  }
  /** An idea someone tapped to add becomes their own activity. */
  function ideaToActivity(idea, id, req) {
    return {
      id: id, t: idea.title, h: idea.how, th: req.theme, tm: idea.time, c: idea.cost, amt: COST_DEFAULT[idea.cost],
      w: idea.where, m: idea.mess, k: guessKind(idea.title + ' ' + idea.how, req.likes), a: [idea.ageMin, idea.ageMax], n: idea.needs.slice(), src: 'ai',
    };
  }

  return {
    LIMITS: LIMITS, DECK: DECK, DECK_BY: DECK_BY, FILLER_IDS: FILLER_IDS,
    TEMPLATES: TEMPLATES, LOOKS: LOOKS, LOOK_WORD: LOOK_WORD, THEMES: THEMES, THEME_WORD: THEME_WORD,
    TIMES: TIMES, TIME_WORD: TIME_WORD, TIME_MIN: TIME_MIN, COSTS: COSTS, COST_WORD: COST_WORD, COST_DEFAULT: COST_DEFAULT,
    WHERES: WHERES, WHERE_WORD: WHERE_WORD, MESSES: MESSES, MESS_WORD: MESS_WORD, LIKES: LIKES, LIKE_WORD: LIKE_WORD,
    EVENINGS: EVENINGS, EVENING_WORD: EVENING_WORD, BUDGET_MODES: BUDGET_MODES, LITTLE_USD: LITTLE_USD, AI_BUDGETS: AI_BUDGETS, AI_FIELDS: AI_FIELDS,
    ID: ID, WD: WD, WD_LONG: WD_LONG, MON: MON, MON_LONG: MON_LONG, PAPERS: PAPERS, MARGIN: MARGIN,
    str: str, esc: esc, clip: clip, line: line, noMarkup: noMarkup, plural: plural, groups: groups, cap1: cap1, norm: norm, clone: clone,
    hasAt: hasAt, hasLink: hasLink, hasPhone: hasPhone, nineDigits: nineDigits, isFormula: isFormula, hasInvisible: hasInvisible, namesBrand: namesBrand,
    dayOf: dayOf, isIso: isIso, iso: iso, civil: civil, weekday: weekday, addDays: addDays, daysFromCivil: daysFromCivil,
    dayLabel: dayLabel, longDay: longDay, opensWord: opensWord, relDay: relDay, clock: clock, monthOf: monthOf,
    adventStart: adventStart, christmasYear: christmasYear, range: range, rangeLine: rangeLine, bigName: bigName, lookOf: lookOf, themesFor: themesFor,
    activity: activity, filler: filler, costOf: costOf, money: money, budgetCap: budgetCap, budgetWord: budgetWord, suitsAges: suitsAges, kidAges: kidAges, isDeckId: isDeckId,
    defaultSetup: defaultSetup, newCountdown: newCountdown, cleanCountdown: cleanCountdown, cleanSetup: cleanSetup, cleanActivity: cleanActivity, bodyProblem: bodyProblem,
    datesOf: datesOf, info: info, planned: planned, misfit: misfit, prng: prng, shuffle: shuffle, hashStr: hashStr,
    makePlan: makePlan, replan: replan, suitable: suitable, starterPicks: starterPicks, checkPlan: checkPlan, unplaced: unplaced, explain: explain,
    swap: swap, move: move, togglePin: togglePin,
    shopKey: shopKey, shopping: shopping, budget: budget, shopText: shopText, weekStart: weekStart,
    door: door, doors: doors, layout: layout, openDoor: openDoor, setStatus: setStatus, toggleStar: toggleStar, isOver: isOver, daysToGo: daysToGo,
    kidQuestion: kidQuestion, paperFor: paperFor, cardGrid: cardGrid, cards: cards, sheets: sheets, fridge: fridge,
    recap: recap, recapCard: recapCard, fitText: fitText, wrapText: wrapText,
    merge: merge, same: same, canon: canon,
    ideasPayload: ideasPayload, ideasRequest: ideasRequest, cleanIdeas: cleanIdeas, ideaToActivity: ideaToActivity, guessKind: guessKind,
  };
}));
