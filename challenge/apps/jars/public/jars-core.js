/* Jars - the rules, in one file, run four times: by the page (a family on
 * this phone and the example family), by the grandparents' page (a snapshot
 * decoded from a link), by the server (which only serves files - it never
 * sees a child, a name or an amount) and by the tests. UMD: window.JarsCore
 * in the pages, require() in node.
 *
 * Nothing here touches a store, the network or the clock on its own: every
 * function is handed `today` (a 'YYYY-MM-DD' in the phone's own time zone),
 * so the same family always gives the same jars.
 *
 * MONEY IS INTEGER MINOR UNITS, always - pence, cents, yen. A split that does
 * not divide evenly rounds Spend and Give DOWN and puts the odd pennies in
 * Save, so the three parts always add up to exactly the pocket money. Interest
 * is worked out in integers too (half a penny rounds up). Floating point only
 * ever appears on the way out, in Intl's formatting.
 *
 * DATES ARE CALENDAR DAYS. A payday is a 'YYYY-MM-DD' whose weekday is the
 * kid's payday, counted with UTC-midnight arithmetic on the date string, so a
 * clock change (DST) can never move one, skip one or pay one twice.
 *
 * What is in it:
 *   - money: parse what a parent types ("2.40", "2,40", "60p") into minor
 *     units, format with Intl ("£2.40", and "60p"/"£3" in a kid's sentence);
 *   - the split (always sums to 100%, sliders that rebalance) and splitting
 *     an amount into the three jars;
 *   - cleanKid: the ONE door every child's record goes through - typed,
 *     imported or the example's;
 *   - paydays: due since the last one, caught up, idempotent per week;
 *   - Bank of Mum & Dad interest, the goal ETA and the projection chart;
 *   - the moves (spend, give, move, add, buy, fix) - never below zero - and
 *     undo of the latest;
 *   - the grandparents' snapshot link and the gift note code, decoded
 *     defensively;
 *   - the grown-up PIN (hashed, a speed bump not a lock), the CSV, the
 *     calendar file and export / import;
 *   - the jar and ring drawings (SVG strings, everything escaped).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JarsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = {
    kids: 8,
    name: 20,
    cause: 40,
    what: 40,
    note: 80,
    goalName: 30,
    goals: 12,
    history: 400,            // events per child, oldest dropped
    maxJar: 10000000,        // minor units in one jar (100,000.00)
    maxWeekly: 100000,       // minor units of pocket money a week (1,000.00)
    maxAmount: 1000000,      // one spend / add / gift (10,000.00)
    catchUpWeeks: 104,       // missed paydays paid at once, at most
    recent: 12,              // "where the money went" rows in a link
    fragment: 6000,          // characters after the # in a grandparents' link
    inflated: 64 * 1024,     // bytes, once decompressed
    gift: 800,               // characters in a gift note code
    giftMsg: 140,
    giftFrom: 20,
    importBytes: 2 * 1024 * 1024,
    etaWeeks: 520,           // ten years: past that, "a long way off"
  };
  const JARS = ['spend', 'save', 'give'];
  const JAR_LABEL = { spend: 'Spend', save: 'Save', give: 'Give' };
  const JAR_ICON = { spend: '🛍️', save: '🐷', give: '💝' };

  /* ------------------------------------------------------------------ *
   * Text: untrusted until cleaned (Sprout's and Glovebox's cleaner)
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
  /** A name or a label: has to have a letter, a digit or an emoji in it. */
  function cleanText(v, max) {
    const s = clean(v, max);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  /** A child's name: a first name or nickname - letters required, no digits
   *  needed or kept beyond what was typed, 20 characters. */
  function cleanName(v) {
    const s = clean(v, LIMITS.name);
    return /\p{L}/u.test(s) ? s : '';
  }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(STRIP, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  const isInt = (v) => typeof v === 'number' && Number.isSafeInteger(v);
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
  const KID_ID = /^k[a-z0-9]{6,12}$/;
  const GOAL_ID = /^g[a-z0-9]{6,12}$/;
  const EV_ID = /^e[a-z0-9]{1,12}$/;
  const isKidId = (v) => typeof v === 'string' && KID_ID.test(v);
  const isGoalId = (v) => typeof v === 'string' && GOAL_ID.test(v);
  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  function err(status, message) { return Object.assign(new Error(message), { status, expose: true }); }

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
  /** 0 = Sunday ... 6 = Saturday, of the calendar date itself. */
  function weekdayOf(d) { return new Date(dateMs(d)).getUTCDay(); }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAYS3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  /** "17 Oct" ("17 Oct 2025" when not this year). */
  function dateLabel(d, today) {
    const x = new Date(dateMs(d));
    const s = x.getUTCDate() + ' ' + MONTHS[x.getUTCMonth()];
    return !today || d.slice(0, 4) !== today.slice(0, 4) ? s + ' ' + d.slice(0, 4) : s;
  }
  /** "Sat 17 Oct". */
  function dayLabel(d, today) { return DAYS3[weekdayOf(d)] + ' ' + dateLabel(d, today); }
  /** "today", "yesterday", "Saturday" (this past week), else "17 Oct". */
  function whenLabel(d, today) {
    const n = daysBetween(d, today);
    if (n === 0) return 'today';
    if (n === 1) return 'yesterday';
    if (n > 1 && n < 7) return DAYS[weekdayOf(d)];
    return dateLabel(d, today);
  }
  /** "today", "tomorrow", "on Saturday" (within the week), "on 24 Oct". */
  function aheadLabel(d, today) {
    const n = daysBetween(today, d);
    if (n <= 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n < 7) return 'on ' + DAYS[weekdayOf(d)];
    return 'on ' + dateLabel(d, today);
  }

  /* ------------------------------------------------------------------ *
   * Money: integer minor units in, Intl out
   * ------------------------------------------------------------------ */

  const CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'NZD', 'INR', 'ZAR', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'SGD', 'HKD'];
  const EURO = ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'];
  const REGION_CUR = { US: 'USD', PR: 'USD', GU: 'USD', VI: 'USD', AS: 'USD', MP: 'USD', UM: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', IN: 'INR', ZA: 'ZAR', JP: 'JPY', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', MX: 'MXN', BR: 'BRL', SG: 'SGD', HK: 'HKD' };
  /** Cents and pence get their own word in a kid's sentence ("60p"). */
  const SMALL_UNIT = { GBP: 'p', USD: '¢', CAD: '¢', AUD: 'c', NZD: 'c', HKD: '¢', SGD: '¢' };
  /** 'en-GB' -> 'GB'. Unknown -> 'US' (the lab's home). */
  function regionOf(locale) {
    const m = /^[a-z]{2,3}(?:[-_][A-Za-z]{4})?[-_]([A-Za-z]{2})\b/.exec(String(locale || ''));
    return m ? m[1].toUpperCase() : 'US';
  }
  function currencyFor(region) { return REGION_CUR[region] || (EURO.indexOf(region) >= 0 ? 'EUR' : 'USD'); }
  function cleanCur(v) { return CURRENCIES.indexOf(v) >= 0 ? v : null; }
  /** Digits after the point: yen has none. */
  function decimals(cur) { return cur === 'JPY' ? 0 : 2; }
  const pow10 = (n) => (n === 0 ? 1 : 100);
  /** Minor units -> a plain decimal string, by integer arithmetic: 240 ->
   *  "2.40", -5 -> "-0.05", 600 yen -> "600". Used by the CSV. */
  function plain(minor, cur) {
    const dp = decimals(cur);
    const neg = minor < 0; const m = Math.abs(minor);
    if (!dp) return (neg ? '-' : '') + String(m);
    const s = String(m).padStart(3, '0');
    return (neg ? '-' : '') + s.slice(0, -2) + '.' + s.slice(-2);
  }
  const nfCache = {};
  function nf(locale, cur, dp) {
    const key = locale + '|' + cur + '|' + dp;
    if (!nfCache[key]) {
      try { nfCache[key] = new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: cur, minimumFractionDigits: dp, maximumFractionDigits: dp }); } catch (e) { nfCache[key] = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: dp, maximumFractionDigits: dp }); }
    }
    return nfCache[key];
  }
  /** "£2.40" / "$1,240.50" / "¥600". */
  function money(minor, cur, locale) {
    if (!isInt(minor)) return '';
    const c = cleanCur(cur) || 'USD';
    const dp = decimals(c);
    return nf(locale, c, dp).format(Number(plain(minor, c)));
  }
  /** The way a kid says it: "£3", "£2.40", "60p", "45¢". */
  function short(minor, cur, locale) {
    if (!isInt(minor)) return '';
    const c = cleanCur(cur) || 'USD';
    const dp = decimals(c);
    const m = Math.abs(minor);
    if (dp && m > 0 && m < 100 && SMALL_UNIT[c]) return (minor < 0 ? '-' : '') + m + SMALL_UNIT[c];
    if (dp && m % 100 === 0) return nf(locale, c, 0).format(minor / 100);
    return money(minor, c, locale);
  }
  /** What a parent typed -> minor units, or null. "2.40", "2,40", "£2.40",
   *  "1,240.50", "1.240,50", "60p", "45c", "3". Never a negative, never a
   *  float: the digits are put together as a string. */
  function parseMoney(text, cur) {
    if (typeof text === 'number') text = String(text);
    if (typeof text !== 'string') return null;
    let s = text.trim().toLowerCase();
    if (!s || s.length > 24 || s.indexOf('-') >= 0) return null;
    const dp = decimals(cleanCur(cur) || 'USD');
    // "60p" / "45c" / "45¢" with no point: a count of minor units.
    const pm = /^(\d{1,7})\s*(p|c|¢|pence|cents?)$/.exec(s);
    if (pm) { const v = Number(pm[1]); return dp && v <= LIMITS.maxAmount ? v : null; }
    s = s.replace(/[^0-9.,\s']/g, '').trim().replace(/[\s']/g, '');
    if (!s || !/\d/.test(s) || !/^[0-9.,]+$/.test(s)) return null;
    let whole = s; let frac = '';
    const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    if (last >= 0) {
      const after = s.slice(last + 1);
      const before = s.slice(0, last);
      const isDecimal = dp && after.length >= 1 && after.length <= 2 && !(after.length === 3);
      if (isDecimal) { whole = before; frac = after; }
      else if (after.length === 3) { whole = s; frac = ''; } // a thousands separator
      else return null;
    }
    // Whatever is left in the whole part may only be thousands separators.
    if (/[.,]/.test(whole)) {
      if (!/^\d{1,3}([.,]\d{3})+$/.test(whole)) return null;
      whole = whole.replace(/[.,]/g, '');
    }
    if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
    if (!whole && !frac) return null;
    const major = Number(whole || '0');
    const minor = dp ? Number((frac + '00').slice(0, 2)) : 0;
    const v = major * pow10(dp) + minor;
    return isInt(v) && v <= LIMITS.maxAmount ? v : null;
  }
  /** Minor units -> the text a form field starts with ("2.40", "600"). */
  function inputValue(minor, cur) { return isInt(minor) && minor > 0 ? plain(minor, cleanCur(cur) || 'USD') : ''; }

  /* ------------------------------------------------------------------ *
   * The split: Spend / Save / Give, whole percents that always sum to 100
   * ------------------------------------------------------------------ */

  const DEFAULT_SPLIT = { spend: 50, save: 40, give: 10 };
  function cleanSplit(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const v = JARS.map((j) => r[j]);
    if (!v.every((x) => isInt(x) && x >= 0 && x <= 100) || v[0] + v[1] + v[2] !== 100) return Object.assign({}, DEFAULT_SPLIT);
    return { spend: v[0], save: v[1], give: v[2] };
  }
  /** An amount into the three jars. Spend and Give round DOWN; Save takes
   *  what is left, so the odd pennies always go to Save and the parts add up
   *  to exactly the amount. */
  function splitAmount(minor, split) {
    const s = cleanSplit(split);
    const m = isInt(minor) && minor > 0 ? minor : 0;
    const spend = Math.floor((m * s.spend) / 100);
    const give = Math.floor((m * s.give) / 100);
    return { spend, save: m - spend - give, give };
  }
  /** One slider moved to `value`: the other two share what is left in the
   *  proportion they had (whole percents - or multiples of `step` when the
   *  slider moves in steps - the rounding to Save when it is one of them),
   *  so the three always sum to 100. */
  function rebalance(split, key, value, step) {
    const s = cleanSplit(split);
    if (JARS.indexOf(key) < 0) return s;
    const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    const others = JARS.filter((j) => j !== key);
    const rest = 100 - v;
    const a = s[others[0]]; const b = s[others[1]];
    const out = {}; out[key] = v;
    if (a + b === 0) {
      // Nothing to keep in proportion: Save takes it if it can, else halves.
      if (others.indexOf('save') >= 0) { out.save = rest; out[others.filter((j) => j !== 'save')[0]] = 0; }
      else { out[others[0]] = rest - Math.floor(rest / 2); out[others[1]] = Math.floor(rest / 2); }
      return { spend: out.spend, save: out.save, give: out.give };
    }
    const sIdx = others.indexOf('save');
    const firstNonSave = sIdx === 0 ? 1 : 0;
    const x = others[firstNonSave];
    const y = others[1 - firstNonSave];
    // With a slider step (5%), the others land on the step too when they can.
    const st = isInt(step) && step > 1 && v % step === 0 ? step : 1;
    out[x] = Math.round((rest * s[x]) / (a + b) / st) * st;
    out[y] = rest - out[x];
    return { spend: out.spend, save: out.save, give: out.give };
  }
  function splitWords(split) { const s = cleanSplit(split); return s.spend + '% spend, ' + s.save + '% save, ' + s.give + '% give'; }

  /* ------------------------------------------------------------------ *
   * The child: one door for every record
   * ------------------------------------------------------------------ */

  const AVATARS = ['🦊', '🐸', '🐼', '🦄', '🐯', '🐙', '🦖', '🐧', '🐝', '🐢', '🦁', '🐰', '🐨', '🐳', '🦉', '🚀'];
  const COLOURS = [
    { id: 'berry', name: 'Berry' }, { id: 'sky', name: 'Sky' }, { id: 'leaf', name: 'Leaf' },
    { id: 'sun', name: 'Sunny' }, { id: 'grape', name: 'Grape' }, { id: 'coral', name: 'Coral' },
  ];
  const COLOUR_IDS = COLOURS.map((c) => c.id);
  const GOAL_EMOJI = ['🧱', '📒', '🎮', '🧸', '🚲', '⚽', '🎨', '📚', '🎧', '🛹', '🦕', '🎁', '🌟', '🐶', '🎟️', '👟'];
  const RATES = [50, 100, 200, 300, 500];        // basis points a week
  const KINDS = ['start', 'pay', 'spend', 'give', 'move', 'add', 'buy', 'fix'];
  const ADD_WHY = [
    { id: 'birthday', label: 'Birthday', icon: '🎂' }, { id: 'gift', label: 'A gift', icon: '🎁' },
    { id: 'chore', label: 'Earned it', icon: '🧹' }, { id: 'tooth', label: 'Tooth fairy', icon: '🦷' },
    { id: 'other', label: 'Something else', icon: '✨' },
  ];
  const ADD_IDS = ADD_WHY.map((w) => w.id);

  function cleanAmt(v, max) { return isInt(v) && v >= 0 && v <= (max || LIMITS.maxJar) ? v : null; }
  function cleanDelta(v) { return isInt(v) && Math.abs(v) <= LIMITS.maxJar ? v : 0; }
  function cleanInterest(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
      on: r.on === true,
      bp: RATES.indexOf(r.bp) >= 0 ? r.bp : 200,
      cap: cleanAmt(r.cap, LIMITS.maxWeekly) === null ? 0 : r.cap,
    };
  }
  function cleanGoal(raw, ctx) {
    if (!raw || typeof raw !== 'object') return null;
    const name = cleanText(raw.name, LIMITS.goalName);
    const price = cleanAmt(raw.price, LIMITS.maxJar);
    if (!name || !price) return null;
    const today = ctx && ctx.today;
    const okDate = (d) => isDate(d) && (!today || d <= addDays(today, 1));
    return {
      id: isGoalId(raw.id) ? raw.id : newId('g', ctx && ctx.rand),
      name,
      emoji: GOAL_EMOJI.indexOf(raw.emoji) >= 0 ? raw.emoji : '🎁',
      price,
      added: okDate(raw.added) ? raw.added : (today || '2026-01-01'),
      reached: okDate(raw.reached) ? raw.reached : null,
      bought: okDate(raw.bought) ? raw.bought : null,
    };
  }
  function cleanEvent(raw, ctx) {
    if (!raw || typeof raw !== 'object' || KINDS.indexOf(raw.k) < 0 || !isDate(raw.d)) return null;
    if (ctx && ctx.today && raw.d > addDays(ctx.today, 1)) return null;
    const a = raw.a && typeof raw.a === 'object' ? raw.a : {};
    const ev = { id: typeof raw.id === 'string' && EV_ID.test(raw.id) ? raw.id : null, d: raw.d, k: raw.k, a: { spend: cleanDelta(a.spend), save: cleanDelta(a.save), give: cleanDelta(a.give) } };
    if (raw.k === 'pay') { ev.week = isDate(raw.week) ? raw.week : raw.d; ev.int = cleanAmt(raw.int, LIMITS.maxJar) || 0; }
    if (raw.k === 'spend' || raw.k === 'buy') ev.what = clean(raw.what, LIMITS.what);
    if (raw.k === 'give') ev.to = clean(raw.to, LIMITS.cause);
    if (raw.k === 'add') { ev.why = ADD_IDS.indexOf(raw.why) >= 0 ? raw.why : 'other'; ev.note = clean(raw.note, LIMITS.note); }
    if (raw.k === 'move') { ev.from = JARS.indexOf(raw.from) >= 0 ? raw.from : null; ev.to = JARS.indexOf(raw.to) >= 0 ? raw.to : null; if (!ev.from || !ev.to || ev.from === ev.to) return null; }
    if (raw.k === 'fix') ev.jar = JARS.indexOf(raw.jar) >= 0 ? raw.jar : 'spend';
    if (raw.k === 'buy' && isGoalId(raw.gid)) ev.gid = raw.gid;
    return ev;
  }
  /**
   * Every child goes through here: typed, imported, the example's. Names are
   * cleaned (first names only, by design - see setup), emoji and colours come
   * from their lists, amounts are whole minor units within bounds (anything
   * else is 0, never a float, never negative), dates are real, goals and
   * history are capped. null when there is no usable name.
   */
  function cleanKid(raw, ctx) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const c = ctx || {};
    const today = c.today;
    const name = cleanName(raw.name);
    if (!name) return null;
    const jars = raw.jars && typeof raw.jars === 'object' ? raw.jars : {};
    const kid = {
      id: isKidId(raw.id) ? raw.id : newId('k', c.rand),
      name,
      emoji: AVATARS.indexOf(raw.emoji) >= 0 ? raw.emoji : AVATARS[0],
      colour: COLOUR_IDS.indexOf(raw.colour) >= 0 ? raw.colour : COLOUR_IDS[0],
      age: isInt(raw.age) && raw.age >= 3 && raw.age <= 17 ? raw.age : null,
      cause: clean(raw.cause, LIMITS.cause),
      weekly: cleanAmt(raw.weekly, LIMITS.maxWeekly) || 0,
      payday: isInt(raw.payday) && raw.payday >= 0 && raw.payday <= 6 ? raw.payday : 6,
      split: cleanSplit(raw.split),
      interest: cleanInterest(raw.interest),
      start: isDate(raw.start) ? raw.start : (today || '2026-01-01'),
      paidThrough: isDate(raw.paidThrough) && (!today || raw.paidThrough <= today) ? raw.paidThrough : null,
      jars: { spend: cleanAmt(jars.spend) || 0, save: cleanAmt(jars.save) || 0, give: cleanAmt(jars.give) || 0 },
      goals: [],
      goal: null,
      history: [],
      seq: isInt(raw.seq) && raw.seq >= 0 ? raw.seq : 0,
      rev: isInt(raw.rev) && raw.rev >= 0 ? raw.rev : 0,
      made: isDate(raw.made) ? raw.made : (today || '2026-01-01'),
    };
    const gids = new Set();
    for (const g of (Array.isArray(raw.goals) ? raw.goals : []).slice(0, LIMITS.goals * 2)) {
      if (kid.goals.length >= LIMITS.goals) break;
      const cg = cleanGoal(g, c);
      if (!cg) continue;
      if (gids.has(cg.id)) cg.id = newId('g', c.rand);
      gids.add(cg.id);
      kid.goals.push(cg);
    }
    const open = kid.goals.filter((g) => !g.bought);
    kid.goal = isGoalId(raw.goal) && open.some((g) => g.id === raw.goal) ? raw.goal : (open[0] ? open[0].id : null);
    const hist = Array.isArray(raw.history) ? raw.history.slice(-LIMITS.history * 2) : [];
    const eids = new Set();
    for (const e of hist) {
      const ce = cleanEvent(e, c);
      if (!ce) continue;
      if (!ce.id || eids.has(ce.id)) ce.id = 'e' + (++kid.seq).toString(36);
      eids.add(ce.id);
      kid.history.push(ce);
    }
    if (kid.history.length > LIMITS.history) kid.history = kid.history.slice(-LIMITS.history);
    return kid;
  }
  /** A new child from the setup form. `startNow`: today is payday and the
   *  parent wants it paid now; otherwise the first payday is the next one. */
  function newKid(form, ctx) {
    const f = form || {};
    const today = ctx.today;
    const start = f.startNow ? today : addDays(today, 1);
    const kid = cleanKid({
      id: newId('k', ctx.rand), name: f.name, emoji: f.emoji, colour: f.colour, age: f.age, cause: f.cause,
      weekly: f.weekly, payday: f.payday, split: f.split, interest: f.interest, start, made: today,
    }, ctx);
    if (!kid) throw err(400, 'Give them a name - a first name or a nickname is all Jars needs.');
    const st = f.starting || {};
    const a = { spend: cleanAmt(st.spend) || 0, save: cleanAmt(st.save) || 0, give: cleanAmt(st.give) || 0 };
    if (a.spend || a.save || a.give) {
      kid.jars = Object.assign({}, a);
      kid.history.push({ id: 'e' + (++kid.seq).toString(36), d: today, k: 'start', a });
    }
    return kid;
  }
  /** Edit a child's settings. A payday moved to another weekday never pays
   *  twice in a week: the next one is the first new weekday at least seven
   *  days after the last payday. Amounts and the split apply from the next
   *  payday; nothing already paid changes. */
  function editKid(kid, form, ctx) {
    const f = form || {};
    const k = copy(kid);
    const name = cleanName(f.name);
    if (!name) throw err(400, 'Give them a name - a first name or a nickname is all Jars needs.');
    k.name = name;
    if (AVATARS.indexOf(f.emoji) >= 0) k.emoji = f.emoji;
    if (COLOUR_IDS.indexOf(f.colour) >= 0) k.colour = f.colour;
    k.age = isInt(f.age) && f.age >= 3 && f.age <= 17 ? f.age : null;
    k.cause = clean(f.cause, LIMITS.cause);
    if (cleanAmt(f.weekly, LIMITS.maxWeekly) !== null) k.weekly = f.weekly;
    k.split = cleanSplit(f.split);
    k.interest = cleanInterest(f.interest);
    if (isInt(f.payday) && f.payday >= 0 && f.payday <= 6 && f.payday !== k.payday) {
      k.payday = f.payday;
      const floor = k.paidThrough ? addDays(k.paidThrough, 7) : addDays(ctx.today, 1);
      k.start = floor > k.start ? floor : k.start;
    }
    k.rev++;
    return k;
  }

  /* ------------------------------------------------------------------ *
   * Paydays and interest
   * ------------------------------------------------------------------ */

  /** Bank of Mum & Dad: `bp` basis points of Save a week (200 = 2%), half a
   *  penny rounds up, never more than `cap` (0 = no cap). Integers only. */
  function interestFor(save, interest) {
    const i = cleanInterest(interest);
    if (!i.on || !isInt(save) || save <= 0) return 0;
    let v = Math.floor((save * i.bp + 5000) / 10000);
    if (i.cap > 0 && v > i.cap) v = i.cap;
    return v;
  }
  /** The first date on or after `d` that falls on weekday `wd`. */
  function onOrAfter(d, wd) { return addDays(d, (wd - weekdayOf(d) + 7) % 7); }
  /** The first payday that has not been paid: on or after the start, after
   *  the last one paid, on the kid's weekday. */
  function firstUnpaid(kid) {
    let from = kid.start;
    if (kid.paidThrough && addDays(kid.paidThrough, 1) > from) from = addDays(kid.paidThrough, 1);
    return onOrAfter(from, kid.payday);
  }
  /** Every payday due by today, oldest first (at most catchUpWeeks; the rest
   *  are counted in `skipped`, said so on the screen). */
  function duePaydays(kid, today) {
    const out = [];
    let d = firstUnpaid(kid);
    let n = 0;
    while (d <= today && n < 10000) { out.push(d); d = addDays(d, 7); n++; }
    const skipped = Math.max(0, out.length - LIMITS.catchUpWeeks);
    return { dates: out.slice(skipped), skipped };
  }
  /** The next payday from today (today itself when it is due and unpaid). */
  function nextPayday(kid, today) {
    const f = firstUnpaid(kid);
    return f >= today ? f : onOrAfter(today, kid.payday);
  }
  function pushEvent(kid, ev) {
    ev.id = 'e' + (++kid.seq).toString(36);
    kid.history.push(ev);
    if (kid.history.length > LIMITS.history) kid.history.splice(0, kid.history.length - LIMITS.history);
    return ev;
  }
  /**
   * Pay every payday due by today. For each, in date order: interest on the
   * Save jar as it stood (if switched on), then the pocket money split three
   * ways (odd pennies to Save). Idempotent: paidThrough moves to the last
   * one paid, and a payday already in the history is never paid again.
   * Returns {kid, paid: [{d, parts, interest, total}], skipped}.
   */
  function runPaydays(kid, today) {
    const due = duePaydays(kid, today);
    if (!due.dates.length) return { kid, paid: [], skipped: 0 };
    const k = copy(kid);
    const done = new Set(k.history.filter((e) => e.k === 'pay').map((e) => e.week));
    const paid = [];
    for (const d of due.dates) {
      if (done.has(d)) { k.paidThrough = d; continue; }
      let interest = interestFor(k.jars.save, k.interest);
      const parts = splitAmount(k.weekly, k.split);
      // Never past a jar's ceiling: the overflow is simply not added.
      const room = (j) => LIMITS.maxJar - k.jars[j];
      parts.spend = Math.min(parts.spend, room('spend'));
      parts.give = Math.min(parts.give, room('give'));
      parts.save = Math.min(parts.save, room('save'));
      interest = Math.min(interest, room('save') - parts.save);
      k.jars.spend += parts.spend; k.jars.give += parts.give; k.jars.save += parts.save + interest;
      pushEvent(k, { d, k: 'pay', week: d, int: interest, a: { spend: parts.spend, save: parts.save + interest, give: parts.give } });
      k.paidThrough = d;
      done.add(d);
      paid.push({ d, parts, interest, total: parts.spend + parts.save + parts.give + interest });
    }
    if (due.skipped) k.paidThrough = due.dates[due.dates.length - 1];
    k.rev++;
    return { kid: k, paid, skipped: due.skipped };
  }
  /** "Paid Saturday: £3 spend, £2.40 save, 60p give" */
  function payLine(p, cur, locale, today) {
    const when = today && daysBetween(p.d, today) === 0 ? 'today' : (today && daysBetween(p.d, today) < 7 ? DAYS[weekdayOf(p.d)] : dateLabel(p.d, today));
    return 'Paid ' + when + ': ' + short(p.parts.spend, cur, locale) + ' spend, ' + short(p.parts.save, cur, locale) + ' save, ' + short(p.parts.give, cur, locale) + ' give';
  }
  /** "Your savings earned 8p!" (or '' when there was none). */
  function interestLine(minor, cur, locale) { return minor > 0 ? 'Your savings earned ' + short(minor, cur, locale) + '!' : ''; }

  /* ------------------------------------------------------------------ *
   * Goals: progress, ETA with interest, the projection
   * ------------------------------------------------------------------ */

  /** One payday's growth of Save, exactly as runPaydays does it. */
  function grow(save, kid, withInterest) {
    const i = withInterest ? interestFor(save, kid.interest) : 0;
    return save + i + splitAmount(kid.weekly, kid.split).save;
  }
  /** Paydays until Save reaches `target`: 0 when it already has, null when
   *  it never will (nothing goes to Save) or not within ten years. */
  function paydaysTo(kid, target, withInterest) {
    let s = kid.jars.save;
    if (s >= target) return 0;
    for (let w = 1; w <= LIMITS.etaWeeks; w++) {
      const n = grow(s, kid, withInterest);
      if (n <= s) return null;
      s = n;
      if (s >= target) return w;
    }
    return null;
  }
  function activeGoal(kid) { return kid.goals.filter((g) => g.id === kid.goal && !g.bought)[0] || null; }
  /** The active goal's progress, and when it should be reached. */
  function goalStatus(kid, today) {
    const g = activeGoal(kid);
    if (!g) return null;
    const saved = Math.min(kid.jars.save, g.price);
    const reached = kid.jars.save >= g.price;
    const pct = reached ? 100 : Math.min(99, Math.floor((saved * 100) / g.price));
    const weeks = paydaysTo(kid, g.price, true);
    const plainWeeks = paydaysTo(kid, g.price, false);
    let date = null;
    if (weeks) date = addDays(nextPayday(kid, addDays(today, 1)), 7 * (weeks - 1));
    return { goal: g, saved, left: Math.max(0, g.price - kid.jars.save), pct, reached, weeks, plainWeeks, date };
  }
  /** "About 6 more paydays", "Next payday!", "Done!", or the nudge. */
  function etaWords(st) {
    if (!st) return '';
    if (st.reached) return 'You did it!';
    if (st.weeks === null) return 'Add to the Save jar to get going';
    if (st.weeks === 1) return 'Next payday!';
    return 'About ' + st.weeks + ' more paydays';
  }
  /** Mark the active goal reached the first time Save covers it. */
  function checkReached(kid, today) {
    const g = activeGoal(kid);
    if (!g || g.reached || kid.jars.save < g.price) return { kid, reached: null };
    const k = copy(kid);
    const kg = k.goals.filter((x) => x.id === g.id)[0];
    kg.reached = today;
    return { kid: k, reached: kg };
  }
  /** Save over the next `weeks` paydays, with and without interest (both
   *  with the weekly Save share). Week 0 is now. */
  function projection(kid, weeks) {
    const n = weeks || 12;
    const w = [kid.jars.save]; const p = [kid.jars.save];
    for (let i = 1; i <= n; i++) { w.push(grow(w[i - 1], kid, true)); p.push(grow(p[i - 1], kid, false)); }
    return { with: w, without: p, extra: w[n] - p[n] };
  }
  function addGoal(kid, form, ctx) {
    const open = kid.goals.filter((g) => !g.bought);
    if (open.length >= LIMITS.goals) throw err(400, 'That’s a lot of goals! Buy or remove one first.');
    const g = cleanGoal({ name: form.name, emoji: form.emoji, price: form.price, added: ctx.today }, ctx);
    if (!g) throw err(400, 'A goal needs a name and a price.');
    const k = copy(kid);
    k.goals = k.goals.filter((x) => x.bought).slice(-LIMITS.goals).concat(open);
    k.goals.push(g);
    if (!activeGoal(k)) k.goal = g.id;
    k.rev++;
    return k;
  }
  function setGoal(kid, gid) {
    const k = copy(kid);
    if (k.goals.some((g) => g.id === gid && !g.bought)) k.goal = gid;
    k.rev++;
    return k;
  }
  function removeGoal(kid, gid) {
    const k = copy(kid);
    k.goals = k.goals.filter((g) => g.id !== gid);
    if (k.goal === gid) { const o = k.goals.filter((g) => !g.bought)[0]; k.goal = o ? o.id : null; }
    k.rev++;
    return k;
  }

  /* ------------------------------------------------------------------ *
   * The moves, and undo of the latest
   * ------------------------------------------------------------------ */

  /** Which moves need a grown-up: anything that adds money, takes from
   *  Save (or Give, which was promised to someone), buys a goal or corrects
   *  a jar. Spending from Spend, giving from Give and moving money INTO Save
   *  are the kid's own. */
  function needsGrownUp(kind, opts) {
    if (kind === 'add' || kind === 'buy' || kind === 'fix') return true;
    if (kind === 'move') return Boolean(opts && (opts.from === 'save' || opts.from === 'give'));
    return false;
  }
  function amountOk(v) { return isInt(v) && v > 0 && v <= LIMITS.maxAmount; }
  /**
   * One move -> {kid, ev, msg, token}. Throws an Error with a sentence (and
   * status 400) when it can't be done - above all, never takes a jar below
   * zero. `token` lets undo put the child back exactly, only if nothing has
   * happened since.
   */
  function act(kid, kind, opts, ctx) {
    const o = opts || {};
    const cur = ctx.currency; const loc = ctx.locale; const today = ctx.today;
    const k = copy(kid);
    const S = (m) => short(m, cur, loc);
    let ev; let msg;
    const room = (j, v) => { if (k.jars[j] + v > LIMITS.maxJar) throw err(400, 'That jar is full to the brim - that’s more than Jars can count.'); };
    if (kind === 'spend' || kind === 'give') {
      const jar = kind;
      if (!amountOk(o.amount)) throw err(400, 'How much? Type an amount.');
      if (o.amount > k.jars[jar]) throw err(400, k.jars[jar] ? 'There’s only ' + S(k.jars[jar]) + ' in ' + k.name + '’s ' + JAR_LABEL[jar] + ' jar.' : k.name + '’s ' + JAR_LABEL[jar] + ' jar is empty.');
      k.jars[jar] -= o.amount;
      const a = { spend: 0, save: 0, give: 0 }; a[jar] = -o.amount;
      if (kind === 'spend') { ev = { d: today, k: 'spend', what: clean(o.what, LIMITS.what) || 'Something nice', a }; msg = S(o.amount) + ' spent - ' + ev.what + '.'; }
      else { ev = { d: today, k: 'give', to: clean(o.to, LIMITS.cause) || k.cause || 'someone who needs it', a }; msg = S(o.amount) + ' given to ' + ev.to + '. Kind!'; }
    } else if (kind === 'move') {
      if (JARS.indexOf(o.from) < 0 || JARS.indexOf(o.to) < 0 || o.from === o.to) throw err(400, 'Pick two different jars.');
      if (!amountOk(o.amount)) throw err(400, 'How much? Type an amount.');
      if (o.amount > k.jars[o.from]) throw err(400, k.jars[o.from] ? 'There’s only ' + S(k.jars[o.from]) + ' in the ' + JAR_LABEL[o.from] + ' jar.' : 'The ' + JAR_LABEL[o.from] + ' jar is empty.');
      room(o.to, o.amount);
      k.jars[o.from] -= o.amount; k.jars[o.to] += o.amount;
      const a = { spend: 0, save: 0, give: 0 }; a[o.from] = -o.amount; a[o.to] = o.amount;
      ev = { d: today, k: 'move', from: o.from, to: o.to, a };
      msg = S(o.amount) + ' moved from ' + JAR_LABEL[o.from] + ' to ' + JAR_LABEL[o.to] + '.';
    } else if (kind === 'add') {
      if (!amountOk(o.amount)) throw err(400, 'How much? Type an amount.');
      const into = o.into === 'split' || JARS.indexOf(o.into) >= 0 ? o.into : 'split';
      const a = into === 'split' ? splitAmount(o.amount, k.split) : { spend: 0, save: 0, give: 0 };
      if (into !== 'split') a[into] = o.amount;
      JARS.forEach((j) => room(j, a[j]));
      JARS.forEach((j) => { k.jars[j] += a[j]; });
      const why = ADD_IDS.indexOf(o.why) >= 0 ? o.why : 'other';
      ev = { d: today, k: 'add', why, note: clean(o.note, LIMITS.note), a };
      msg = S(o.amount) + ' added' + (into === 'split' ? ' - ' + S(a.spend) + ' spend, ' + S(a.save) + ' save, ' + S(a.give) + ' give.' : ' to ' + JAR_LABEL[into] + '.');
    } else if (kind === 'buy') {
      const g = k.goals.filter((x) => x.id === o.gid && !x.bought)[0];
      if (!g) throw err(400, 'That goal has gone.');
      if (k.jars.save < g.price) throw err(400, 'Not quite yet - ' + S(g.price - k.jars.save) + ' to go.');
      k.jars.save -= g.price;
      g.bought = today; if (!g.reached) g.reached = today;
      const next = k.goals.filter((x) => !x.bought)[0];
      if (k.goal === g.id) k.goal = next ? next.id : null;
      ev = { d: today, k: 'buy', gid: g.id, what: g.name, a: { spend: 0, save: -g.price, give: 0 } };
      msg = g.emoji + ' ' + g.name + ' bought with ' + S(g.price) + ' of savings. Enjoy it!';
    } else if (kind === 'fix') {
      if (JARS.indexOf(o.jar) < 0) throw err(400, 'Which jar?');
      if (!isInt(o.amount) || o.amount < 0 || o.amount > LIMITS.maxJar) throw err(400, 'Type what’s really in the jar.');
      const delta = o.amount - k.jars[o.jar];
      if (!delta) throw err(400, 'That’s what it already says.');
      k.jars[o.jar] = o.amount;
      const a = { spend: 0, save: 0, give: 0 }; a[o.jar] = delta;
      ev = { d: today, k: 'fix', jar: o.jar, a };
      msg = JAR_LABEL[o.jar] + ' set to ' + S(o.amount) + '.';
    } else {
      throw err(400, 'Unknown move.');
    }
    pushEvent(k, ev);
    k.rev = kid.rev + 1;
    return { kid: k, ev, msg, token: { id: kid.id, rev: k.rev, before: copy(kid) } };
  }
  /** Put the child back as it was before the latest move - only if nothing
   *  has happened since (a payday, another move). */
  function undo(kid, token) {
    if (!token || token.id !== kid.id || token.rev !== kid.rev || !token.before) throw err(409, 'Something else changed since - that can’t be undone now.');
    return copy(token.before);
  }

  /* ------------------------------------------------------------------ *
   * Reading the history
   * ------------------------------------------------------------------ */

  const ADD_BY = {}; ADD_WHY.forEach((w) => { ADD_BY[w.id] = w; });
  /** One line per event, for lists and the CSV: {icon, title, jar, amount}. */
  function describe(ev, kid, cur, locale) {
    const S = (m) => short(Math.abs(m), cur, locale);
    const tot = ev.a.spend + ev.a.save + ev.a.give;
    switch (ev.k) {
      case 'pay': return { icon: '💰', title: 'Pocket money' + (ev.int ? ' + ' + S(ev.int) + ' interest' : ''), amount: tot, jar: null };
      case 'start': return { icon: '🫙', title: 'Already in the jars', amount: tot, jar: null };
      case 'spend': return { icon: '🛍️', title: ev.what || 'Spent', amount: ev.a.spend, jar: 'spend' };
      case 'give': return { icon: '💝', title: 'Gave to ' + (ev.to || 'someone'), amount: ev.a.give, jar: 'give' };
      case 'move': return { icon: '🔁', title: JAR_LABEL[ev.from] + ' → ' + JAR_LABEL[ev.to], amount: ev.a[ev.to], jar: null, move: true };
      case 'add': { const w = ADD_BY[ev.why] || ADD_BY.other; return { icon: w.icon, title: (ev.note || w.label), amount: tot, jar: null }; }
      case 'buy': return { icon: '🎉', title: 'Bought ' + (ev.what || 'the goal'), amount: ev.a.save, jar: 'save' };
      case 'fix': return { icon: '✏️', title: JAR_LABEL[ev.jar] + ' corrected', amount: ev.a[ev.jar], jar: ev.jar };
      default: return { icon: '•', title: '', amount: tot, jar: null };
    }
  }
  /** The events that touched one jar, newest first. */
  function jarHistory(kid, jar) { return kid.history.filter((e) => e.a[jar] !== 0).slice().reverse(); }
  /** This calendar month: money in (pocket money, interest, added) and out
   *  (spent, given, bought). Moves between jars are neither. */
  function monthSummary(kid, today) {
    const m = today.slice(0, 7);
    const s = { pocket: 0, interest: 0, added: 0, spent: 0, given: 0, bought: 0, fixed: 0, in: 0, out: 0 };
    for (const e of kid.history) {
      if (e.d.slice(0, 7) !== m) continue;
      const t = e.a.spend + e.a.save + e.a.give;
      if (e.k === 'pay') { s.interest += e.int || 0; s.pocket += t - (e.int || 0); }
      else if (e.k === 'add' || e.k === 'start') s.added += t;
      else if (e.k === 'spend') s.spent -= t;
      else if (e.k === 'give') s.given -= t;
      else if (e.k === 'buy') s.bought -= t;
      else if (e.k === 'fix') s.fixed += t;
    }
    s.in = s.pocket + s.interest + s.added + Math.max(0, s.fixed);
    s.out = s.spent + s.given + s.bought + Math.max(0, -s.fixed);
    return s;
  }
  function total(kid) { return kid.jars.spend + kid.jars.save + kid.jars.give; }

  /* ------------------------------------------------------------------ *
   * Drawings: a jar and a progress ring, as SVG strings (no text from the
   * child's record is ever put inside one except escaped)
   * ------------------------------------------------------------------ */

  /** A glass jar `fill` (0..1) full, with coins. `kind` picks the colour
   *  class (jar-spend / jar-save / jar-give); the label is drawn by the page
   *  next to it, in words. Deterministic: the coins sit where `seed` says. */
  function jarSvg(kind, fill, opts) {
    const o = opts || {};
    const f = Math.max(0, Math.min(1, Number(fill) || 0));
    const shown = f > 0 ? Math.max(0.06, f) : 0;
    const top = 40; const bottom = 196; const h = (bottom - top) * shown; const y = bottom - h;
    const id = 'jc' + esc(String(o.uid || kind)).replace(/[^a-z0-9]/gi, '');
    let coins = '';
    if (shown > 0) {
      const n = Math.max(1, Math.min(9, Math.round(shown * 9)));
      let s = (o.seed || 7) >>> 0;
      for (let i = 0; i < n; i++) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        const cx = 40 + (s % 80);
        const cy = Math.min(186, Math.max(y + 12, bottom - 10 - ((i * 37 + (s >>> 8) % 23) % Math.max(10, h - 18))));
        coins += '<ellipse class="coin" cx="' + cx + '" cy="' + cy + '" rx="11" ry="6"/>';
      }
    }
    return '<svg class="jar-svg ' + esc(kind ? 'jar-' + kind : '') + '" viewBox="0 0 160 210" role="img" aria-hidden="true" focusable="false">' +
      '<defs><clipPath id="' + id + '"><path d="M30 46 Q30 36 40 36 H120 Q130 36 130 46 V186 Q130 200 116 200 H44 Q30 200 30 186 Z"/></clipPath></defs>' +
      '<rect class="jar-lid" x="38" y="10" width="84" height="22" rx="7"/>' +
      '<path class="jar-glass" d="M30 46 Q30 36 40 36 H120 Q130 36 130 46 V186 Q130 200 116 200 H44 Q30 200 30 186 Z"/>' +
      (shown > 0 ? '<g clip-path="url(#' + id + ')"><path class="jar-fill" d="M20 ' + y.toFixed(1) + ' Q50 ' + (y - 6).toFixed(1) + ' 80 ' + y.toFixed(1) + ' T140 ' + y.toFixed(1) + ' V210 H20 Z"/>' + coins + '</g>' : '') +
      '<path class="jar-shine" d="M44 60 V170" />' +
      '<path class="jar-edge" d="M30 46 Q30 36 40 36 H120 Q130 36 130 46 V186 Q130 200 116 200 H44 Q30 200 30 186 Z"/>' +
      '</svg>';
  }
  /** A progress ring, `pct` 0..100, with the goal's emoji in the middle. */
  function ringSvg(pct, emoji) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const r = 52; const c = 2 * Math.PI * r;
    return '<svg class="ring" viewBox="0 0 128 128" role="img" aria-hidden="true" focusable="false"><circle class="ring-track" cx="64" cy="64" r="' + r + '"/>' +
      '<circle class="ring-done" cx="64" cy="64" r="' + r + '" stroke-dasharray="' + (c * p / 100).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 64 64)"/>' +
      '<text x="64" y="76" text-anchor="middle" class="ring-emoji">' + esc(GOAL_EMOJI.indexOf(emoji) >= 0 ? emoji : '🎁') + '</text></svg>';
  }

  /** How full each jar is drawn, 0..1. Save fills toward the active goal
   *  (so a kid watches it fill up to the LEGO set); with no goal, and for
   *  Spend and Give, a jar is "full" at about eight weeks of its share - or
   *  a little more than what it holds, so it is never drawn overflowing. */
  function fills(kid) {
    const share = splitAmount(kid.weekly, kid.split);
    const g = activeGoal(kid);
    const out = {};
    for (const j of JARS) {
      const v = kid.jars[j];
      if (j === 'save' && g) { out[j] = Math.min(1, v / g.price); continue; }
      const cap = Math.max(Math.ceil(v * 1.15), share[j] * 8, 1);
      out[j] = Math.min(1, v / cap);
    }
    return out;
  }
  /** A hidden amount, said in words: how full the jar is next to the
   *  fullest of the three. */
  function fullness(pct) {
    if (pct <= 0) return 'Empty';
    if (pct >= 100) return 'The fullest';
    if (pct >= 60) return 'Lots in it';
    if (pct >= 25) return 'Some in it';
    return 'A little';
  }
  /** A decoded snapshot drawn as HTML, for the grandparents' page and the
   *  parent's preview. Every string escaped; amounts only when the parent
   *  left them in. */
  function snapshotHtml(snap, opts) {
    const o = opts || {};
    const loc = o.locale; const cur = snap.currency;
    const S = (m) => esc(short(m, cur, loc));
    const big = Math.max(snap.jars.spend, snap.jars.save, snap.jars.give, 1);
    let h = '<header class="snap-head"><span class="avatar big c-' + esc(snap.colour) + '" aria-hidden="true">' + esc(snap.emoji) + '</span><div class="snap-id"><p class="eyebrow">A snapshot from Jars</p><h1>' + esc(snap.name) + '’s jars</h1><p class="muted">' +
      esc('On ' + dateLabel(snap.made) + (snap.total !== null ? ' · ' + money(snap.total, cur, loc) + ' in all' : '')) + '</p></div></header>';
    h += '<div class="jars-row snap-jars">' + JARS.map((j) => {
      const v = snap.jars[j];
      const fill = snap.hide ? (v / 100) * 0.9 : (v / big) * 0.9;
      return '<div class="jar-col j-' + j + '"><p class="jar-name"><span aria-hidden="true">' + JAR_ICON[j] + '</span> ' + JAR_LABEL[j] + '</p>' + jarSvg(j, fill, { uid: 's' + j, seed: j.length * 7 }) +
        '<p class="jar-amt">' + (snap.hide ? esc(fullness(v)) : S(v)) + '</p></div>';
    }).join('') + '</div>';
    if (snap.goal) {
      const g = snap.goal;
      const eta = g.pct >= 100 || g.weeks === 0 ? 'Got enough - it’s within reach!' : g.weeks > 0 ? (g.weeks === 1 ? 'Next payday, if the saving keeps going.' : 'About ' + g.weeks + ' more paydays, if the saving keeps going.') : 'Saving up.';
      h += '<section class="snap-goal"><div class="ringwrap">' + ringSvg(g.pct, g.emoji) + '</div><div><p class="eyebrow">Saving for</p><h2>' + esc(g.emoji + ' ' + g.name) + '</h2><p><b>' + esc(g.pct + '% of the way') + '</b>' + (g.price ? ' to ' + S(g.price) : '') + '</p><p class="muted small">' + esc(eta) + '</p></div></section>';
    }
    if (snap.cause) h += '<p class="snap-cause"><span aria-hidden="true">💝</span> The Give jar is for <b>' + esc(snap.cause) + '</b>.</p>';
    if (snap.went.length) {
      h += '<section class="snap-went"><h2>Where the money went</h2><ul class="acts">' + snap.went.map((w) => {
        const icon = w.k === 's' ? '🛍️' : w.k === 'g' ? '💝' : '🎉';
        const title = w.k === 'g' ? 'Gave to ' + (w.text || 'someone') : w.k === 'b' ? 'Bought ' + (w.text || 'a goal') : (w.text || 'Spent');
        return '<li><span class="ai" aria-hidden="true">' + icon + '</span><span class="ab"><span class="at">' + esc(title) + '</span><span class="aw">' + esc(dateLabel(w.d, snap.made)) + '</span></span>' + (w.amount !== null ? '<span class="aa out">' + esc('−' + short(w.amount, cur, loc)) + '</span>' : '') + '</li>';
      }).join('') + '</ul></section>';
    }
    h += '<p class="snap-foot small muted">A snapshot, not live: it shows the jars on ' + esc(dateLabel(snap.made)) + '. Nothing is stored on a server - it all travels inside this link.</p>';
    return h;
  }

  /* ------------------------------------------------------------------ *
   * The grandparents' link: a snapshot carried in the FRAGMENT
   * ------------------------------------------------------------------ */

  /** What the link carries, compact: {v, n, e, c, cu, g, h, j:[spend, save,
   *  give] (or fill percents when amounts are hidden), go:[name, emoji,
   *  price|-1, pct, paydays|-1] | 0, ca, w:[[date, 's'|'g'|'b', text,
   *  amount|-1]]}. Never: the child's id, age, settings, the PIN, other
   *  children. */
  function packSnapshot(kid, opts) {
    const o = opts || {};
    const today = o.today; const hide = Boolean(o.hide);
    const st = goalStatus(kid, today);
    const t = total(kid);
    const big = Math.max(kid.jars.spend, kid.jars.save, kid.jars.give, 1);
    const recent = kid.history.filter((e) => e.k === 'spend' || e.k === 'give' || e.k === 'buy').slice(-LIMITS.recent).reverse();
    return {
      v: 1,
      n: kid.name,
      e: kid.emoji,
      c: kid.colour,
      cu: o.currency,
      g: today,
      h: hide ? 1 : 0,
      j: hide ? JARS.map((j) => Math.round((kid.jars[j] * 100) / big)) : JARS.map((j) => kid.jars[j]),
      go: st ? [st.goal.name, st.goal.emoji, hide ? -1 : st.goal.price, st.pct, st.reached ? 0 : (st.weeks === null ? -1 : st.weeks)] : 0,
      ca: kid.cause || '',
      w: recent.map((e) => [e.d, e.k === 'spend' ? 's' : e.k === 'give' ? 'g' : 'b', e.k === 'give' ? (e.to || '') : (e.what || ''), hide ? -1 : -(e.a.spend + e.a.save + e.a.give)]),
      tt: hide ? -1 : t,
    };
  }
  /** The decoded link, cleaned field by field. null when it is not one. */
  function cleanSnapshot(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return null;
    const name = cleanName(raw.n);
    if (!name || !isDate(raw.g) || !Array.isArray(raw.j) || raw.j.length !== 3) return null;
    const hide = raw.h === 1;
    const cur = cleanCur(raw.cu);
    if (!cur) return null;
    const jars = raw.j.map((x) => (hide ? (isInt(x) && x >= 0 && x <= 100 ? x : null) : cleanAmt(x)));
    if (jars.some((x) => x === null)) return null;
    let goal = null;
    if (Array.isArray(raw.go)) {
      const gname = cleanText(raw.go[0], LIMITS.goalName);
      const price = hide ? null : cleanAmt(raw.go[2]);
      const pct = isInt(raw.go[3]) && raw.go[3] >= 0 && raw.go[3] <= 100 ? raw.go[3] : null;
      const weeks = isInt(raw.go[4]) && raw.go[4] >= -1 && raw.go[4] <= LIMITS.etaWeeks ? raw.go[4] : -1;
      if (gname && pct !== null && (hide || price)) goal = { name: gname, emoji: GOAL_EMOJI.indexOf(raw.go[1]) >= 0 ? raw.go[1] : '🎁', price, pct, weeks };
    }
    const went = [];
    for (const r of (Array.isArray(raw.w) ? raw.w : []).slice(0, LIMITS.recent)) {
      if (!Array.isArray(r) || !isDate(r[0]) || ['s', 'g', 'b'].indexOf(r[1]) < 0) continue;
      const amt = hide ? null : cleanAmt(r[3], LIMITS.maxJar);
      if (!hide && !amt) continue;
      went.push({ d: r[0], k: r[1], text: clean(r[2], r[1] === 'g' ? LIMITS.cause : LIMITS.what), amount: amt });
    }
    return {
      v: 1, name, emoji: AVATARS.indexOf(raw.e) >= 0 ? raw.e : AVATARS[0], colour: COLOUR_IDS.indexOf(raw.c) >= 0 ? raw.c : COLOUR_IDS[0],
      currency: cur, made: raw.g, hide, jars: { spend: jars[0], save: jars[1], give: jars[2] }, goal, cause: clean(raw.ca, LIMITS.cause), went,
      total: hide ? null : cleanAmt(raw.tt),
    };
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
  async function encodeOnce(snap, plainText) {
    const bytes = new TextEncoder().encode(JSON.stringify(snap));
    if (plainText) return 'v1.p.' + b64url(bytes);
    const z = await readCapped(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')), LIMITS.inflated * 4);
    return 'v1.z.' + b64url(z);
  }
  /** The snapshot -> the part after '#': 'v1.z.<deflate, base64url>' when the
   *  browser can compress, else 'v1.p.<utf-8 JSON, base64url>'. Too long:
   *  the oldest "where it went" rows are left off; null if still too long. */
  async function encodeSnapshot(snap, opts) {
    const plainText = (opts && opts.plain) || !canCompress();
    let s = snap;
    let frag = await encodeOnce(s, plainText);
    while (frag.length > LIMITS.fragment && s.w.length) {
      s = Object.assign({}, s, { w: s.w.slice(0, s.w.length - 1) });
      frag = await encodeOnce(s, plainText);
    }
    return frag.length > LIMITS.fragment ? null : frag;
  }
  /** '#…' or '…' -> a clean snapshot, or null for anything else. Never throws. */
  async function decodeSnapshot(fragment) {
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
      return cleanSnapshot(JSON.parse(text));
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ *
   * The gift note: a grandparent's "I'm sending £10" as a short code the
   * parent pastes back. A NOTE, never money - nothing moves until the parent
   * adds it (behind the grown-up PIN).
   * ------------------------------------------------------------------ */

  const GIFT_INTO = ['split', 'spend', 'save', 'give'];
  function makeGift(g) {
    const amount = parseMoney(g.amount, g.currency);
    if (!amountOk(amount)) throw err(400, 'How much are you sending? Type an amount.');
    const body = { v: 1, k: cleanName(g.kid) || '', a: amount, c: cleanCur(g.currency) || 'USD', j: GIFT_INTO.indexOf(g.into) >= 0 ? g.into : 'split', m: clean(g.message, LIMITS.giftMsg), f: clean(g.from, LIMITS.giftFrom), d: isDate(g.today) ? g.today : '' };
    return 'g1.' + b64url(new TextEncoder().encode(JSON.stringify(body)));
  }
  /** A pasted code or a link with '#gift/<code>' in it -> a clean gift, or
   *  null. Never throws. */
  function readGift(text) {
    try {
      if (typeof text !== 'string') return null;
      const t = text.trim();
      if (!t || t.length > LIMITS.gift + 1200) return null;
      const m = /#gift\/(g1\.[A-Za-z0-9_-]{8,})/.exec(t) || /(?:^|\s)(g1\.[A-Za-z0-9_-]{8,})(?=\s|$)/.exec(t);
      if (!m || m[1].length > LIMITS.gift) return null;
      const bytes = unb64url(m[1].slice(3));
      if (!bytes || bytes.length > LIMITS.gift) return null;
      const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return null;
      const cur = cleanCur(raw.c);
      if (!cur || !amountOk(raw.a)) return null;
      return { kid: cleanName(raw.k), amount: raw.a, currency: cur, into: GIFT_INTO.indexOf(raw.j) >= 0 ? raw.j : 'split', message: clean(raw.m, LIMITS.giftMsg), from: clean(raw.f, LIMITS.giftFrom), date: isDate(raw.d) ? raw.d : null };
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ *
   * The grown-up PIN: four digits, stored only as a salted PBKDF2 hash on
   * this phone. A speed bump for little fingers, NOT security: four digits
   * are ten thousand guesses, and anyone holding the phone can clear site
   * data. Said so wherever it is set.
   * ------------------------------------------------------------------ */

  const PIN_ITER = 60000;
  const validPin = (p) => typeof p === 'string' && /^\d{4}$/.test(p);
  function randomBytes(n) {
    const out = new Uint8Array(n);
    const cr = typeof crypto !== 'undefined' ? crypto : null;
    if (cr && cr.getRandomValues) cr.getRandomValues(out);
    else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  }
  function fnvHash(pin, salt) {
    // Only when WebCrypto is missing (an old browser on plain http): still
    // salted and repeated, still a speed bump.
    let h = 0x811c9dc5; const s = salt + ':' + pin;
    for (let r = 0; r < 5000; r++) for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) + r; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }
  async function hashPin(pin, rec) {
    if (!validPin(pin)) throw err(400, 'Four digits, please.');
    const r = rec || {};
    const salt = typeof r.s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(r.s) ? r.s : b64url(randomBytes(16));
    const subtle = typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null;
    const algo = r.a ? r.a : (subtle ? 'pbkdf2-sha256' : 'fnv');
    if (algo === 'pbkdf2-sha256' && subtle) {
      const iter = isInt(r.i) && r.i >= 1000 && r.i <= 1000000 ? r.i : PIN_ITER;
      const key = await subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
      const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: iter }, key, 256);
      return { a: 'pbkdf2-sha256', i: iter, s: salt, h: b64url(new Uint8Array(bits)) };
    }
    if (algo === 'pbkdf2-sha256') throw err(500, 'This browser can’t check the PIN.');
    return { a: 'fnv', s: salt, h: fnvHash(pin, salt) };
  }
  function cleanPinRecord(r) {
    if (!r || typeof r !== 'object') return null;
    if (['pbkdf2-sha256', 'fnv'].indexOf(r.a) < 0 || typeof r.s !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(r.s) || typeof r.h !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(r.h)) return null;
    return r.a === 'fnv' ? { a: 'fnv', s: r.s, h: r.h } : { a: r.a, i: isInt(r.i) && r.i >= 1000 && r.i <= 1000000 ? r.i : PIN_ITER, s: r.s, h: r.h };
  }
  async function checkPin(pin, rec) {
    const r = cleanPinRecord(rec);
    if (!r || !validPin(pin)) return false;
    let h;
    try { h = (await hashPin(pin, r)).h; } catch (e) { return false; }
    if (h.length !== r.h.length) return false;
    let diff = 0;
    for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ r.h.charCodeAt(i);
    return diff === 0;
  }

  /* ------------------------------------------------------------------ *
   * CSV, the calendar file, export / import
   * ------------------------------------------------------------------ */

  /** A text cell a spreadsheet must never run: =, +, -, @, tab or CR at the
   *  start gets an apostrophe in front. Quoted when it has to be. */
  function csvCell(v, isText) {
    let s = String(v === null || v === undefined ? '' : v);
    if (isText && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvFor(kids, opts) {
    const cur = (opts && opts.currency) || 'USD';
    const rows = [['Date', 'Child', 'What', 'Spend', 'Save', 'Give', 'Total', 'Note'].join(',')];
    const all = [];
    for (const k of kids) for (const e of k.history) all.push([e, k]);
    all.sort((x, y) => (x[0].d < y[0].d ? -1 : x[0].d > y[0].d ? 1 : 0));
    for (const [e, k] of all) {
      const d = describe(e, k, cur);
      const note = e.k === 'add' ? (ADD_BY[e.why] || ADD_BY.other).label : e.k === 'pay' && e.int ? 'Interest ' + plain(e.int, cur) : '';
      rows.push([e.d, csvCell(k.name, true), csvCell(d.title, true), plain(e.a.spend, cur), plain(e.a.save, cur), plain(e.a.give, cur), plain(e.a.spend + e.a.save + e.a.give, cur), csvCell(note, true)].join(','));
    }
    return rows.join('\r\n') + '\r\n';
  }

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
  const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  /** Each child's payday as a weekly all-day event for six months (amounts
   *  change, so it ends), and the active goal on its expected payday. */
  function icsFor(kids, opts) {
    const o = opts || {};
    const today = o.today; const cur = o.currency; const loc = o.locale;
    const stamp = new Date(o.now || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jars//Pocket money//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Jars paydays'];
    let n = 0;
    for (const k of kids) {
      if (k.weekly > 0) {
        const first = nextPayday(k, today);
        const p = splitAmount(k.weekly, k.split);
        const ymd = first.replace(/-/g, '');
        lines.push('BEGIN:VEVENT', 'UID:jars-' + k.id + '-payday@jars.local', 'DTSTAMP:' + stamp,
          'DTSTART;VALUE=DATE:' + ymd, 'DTEND;VALUE=DATE:' + addDays(first, 1).replace(/-/g, ''),
          'RRULE:FREQ=WEEKLY;COUNT=26;BYDAY=' + BYDAY[k.payday],
          'SUMMARY:' + icsText('💰 Payday: ' + k.name + ' - ' + short(k.weekly, cur, loc)),
          'DESCRIPTION:' + icsText(short(p.spend, cur, loc) + ' spend, ' + short(p.save, cur, loc) + ' save, ' + short(p.give, cur, loc) + ' give.\nOpen Jars and payday runs itself.\n\nA snapshot from Jars - if the pocket money changes, download it again.'),
          'TRANSP:TRANSPARENT', 'END:VEVENT');
        n++;
      }
      const st = goalStatus(k, today);
      if (st && st.date && !st.reached && daysBetween(today, st.date) <= 366) {
        const ymd = st.date.replace(/-/g, '');
        lines.push('BEGIN:VEVENT', 'UID:jars-' + k.id + '-' + st.goal.id + '@jars.local', 'DTSTAMP:' + stamp,
          'DTSTART;VALUE=DATE:' + ymd, 'DTEND;VALUE=DATE:' + addDays(st.date, 1).replace(/-/g, ''),
          'SUMMARY:' + icsText('🎯 ' + k.name + '’s ' + st.goal.name + ' - about now'),
          'DESCRIPTION:' + icsText('If the saving keeps going like this, ' + k.name + ' reaches ' + short(st.goal.price, cur, loc) + ' around this payday.'),
          'TRANSP:TRANSPARENT', 'END:VEVENT');
        n++;
      }
    }
    lines.push('END:VCALENDAR');
    return { text: lines.map(fold).join('\r\n') + '\r\n', events: n };
  }

  function cleanSettings(raw, locale) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const region = regionOf(locale);
    const curAuto = s.curAuto !== false;
    return { region, curAuto, currency: curAuto ? currencyFor(region) : (cleanCur(s.currency) || currencyFor(region)) };
  }
  /** The family as a file. The PIN stays on this phone (said so). */
  function exportFamily(family, now) {
    return JSON.stringify({ app: 'jars', v: 1, exportedAt: new Date(now || Date.now()).toISOString(), settings: { currency: family.settings.currency, curAuto: family.settings.curAuto }, kids: family.kids }, null, 1);
  }
  /** A file someone picked -> a clean family, or an Error with a sentence. */
  function importFamily(text, ctx) {
    if (typeof text !== 'string' || text.length > LIMITS.importBytes) throw err(400, 'That file is too big to be a Jars export.');
    let raw;
    try { raw = JSON.parse(text); } catch (e) { throw err(400, 'That file isn’t a Jars export (it isn’t JSON).'); }
    if (!raw || typeof raw !== 'object' || raw.app !== 'jars' || raw.v !== 1 || !Array.isArray(raw.kids)) throw err(400, 'That file isn’t a Jars export.');
    const ids = new Set(); const kids = []; let dropped = 0;
    for (const r of raw.kids.slice(0, LIMITS.kids * 4)) {
      if (kids.length >= LIMITS.kids) break;
      const k = cleanKid(r, ctx);
      if (!k) { dropped++; continue; }
      if (ids.has(k.id)) k.id = newId('k', ctx.rand);
      ids.add(k.id);
      kids.push(k);
    }
    return { settings: cleanSettings(raw.settings, ctx.locale), kids, dropped, over: Math.max(0, raw.kids.length - kids.length - dropped) };
  }

  return {
    LIMITS, JARS, JAR_LABEL, JAR_ICON, CURRENCIES, DEFAULT_SPLIT, AVATARS, COLOURS, COLOUR_IDS, GOAL_EMOJI, RATES, KINDS, ADD_WHY, DAYS, DAYS3, GIFT_INTO,
    clean, cleanText, cleanName, esc, plural, nameList, newId, isKidId, isGoalId, copy,
    isDate, cleanTz, localDate, addDays, daysBetween, weekdayOf, dateLabel, dayLabel, whenLabel, aheadLabel,
    regionOf, currencyFor, cleanCur, decimals, plain, money, short, parseMoney, inputValue,
    cleanSplit, splitAmount, rebalance, splitWords,
    cleanKid, cleanGoal, cleanEvent, cleanInterest, newKid, editKid,
    interestFor, duePaydays, nextPayday, runPaydays, payLine, interestLine,
    paydaysTo, activeGoal, goalStatus, etaWords, checkReached, projection, addGoal, setGoal, removeGoal,
    needsGrownUp, act, undo, describe, jarHistory, monthSummary, total,
    jarSvg, ringSvg, fills, fullness, snapshotHtml,
    packSnapshot, cleanSnapshot, encodeSnapshot, decodeSnapshot, b64url, unb64url, canCompress,
    makeGift, readGift,
    validPin, hashPin, checkPin, cleanPinRecord,
    csvCell, csvFor, icsFor, fold, cleanSettings, exportFamily, importFamily,
  };
});
