/* Takeback - the rules, in one file run three times: `window.TakebackCore`
 * in the page, `require` in the server and in the tests.
 *
 * NO CLOCK AND NO DICE. Nothing here reads the time or makes a random
 * number: "now" (milliseconds), "today" (YYYY-MM-DD in the person's own day)
 * and every new id are handed in. Days are day numbers from Date.UTC, so a
 * return window across a clock change counts days, not hours. No lookbehind
 * regexes (older iPhones cannot parse them), no storage, no network.
 *
 * What lives here:
 *   - text cleaning and escaping (every typed store, item, note and every
 *     model answer goes through these);
 *   - money in the person's own currency, as whole cents;
 *   - a purchase: its return window (14 / 30 / 60 / 90 days or a date the
 *     person types - Takeback never guesses a store's policy), its state,
 *     its status line and colour, the return checklist, the refund expected
 *     by (business days), an overdue refund and what to do about it;
 *   - the list sorted by what needs the person soonest, its summary, nudges;
 *   - the money tally, by month;
 *   - store notes (the person's own words) and the stores already used;
 *   - reminders as an .ics in floating local time;
 *   - CSV out (formulas defused) and back in;
 *   - sync: what the account copy may hold, and a merge by item;
 *   - "Read my receipt": what is sent, and what is accepted back (no run of
 *     digits that could be a card number, ever);
 *   - the made-up purchases for "Try it".
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TakebackCore = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const LIMITS = {
    purchases: 500,          // on a device, and in the account copy
    store: 60,
    item: 80,
    note: 300,
    order: 40,
    url: 300,
    storeNote: 300,
    storeNotes: 100,
    tombstones: 500,
    priceCents: 5000000,     // 50,000.00 in any two-decimal currency
    windowMaxDays: 365,      // a preset or a typed number of days
    untilMaxDays: 400,       // "until a date": at most this far after it was bought
    boughtBackDays: 3 * 366, // older than this is not a return any more
    refundBusinessDays: 10,  // dropped off + this, unless the person changes it
    batch: 30,               // items from one order added together
    csvBytes: 2 * 1024 * 1024,
    csvRows: 1000,
    csvCols: 40,
    listBytes: 400 * 1024,   // the account copy, as JSON
    // "Read my receipt"
    aiItems: 30,
    aiImageBytes: 1000000,
    aiImageSide: 1600,
    aiQuote: 160,
    aiNote: 160,
    aiBackDays: 730,         // an order date older than two years is not believed
  };

  /* ------------------------------------------------------------------ *
   * Text
   * ------------------------------------------------------------------ */

  // Control characters, bidi overrides and isolates, zero-width characters
  // and the BOM. Written as escapes so this file carries none of its own.
  const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

  /** One line of plain text: no control or invisible characters, single
   *  spaces, at most `max` characters (never splitting one). */
  function line(v, max) {
    let s = String(v === null || v === undefined ? '' : v).slice(0, max * 8 + 64).replace(/[\r\n\t]+/g, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    const cps = Array.from(s);
    if (cps.length > max) s = cps.slice(0, max).join('').trim();
    return s;
  }
  /** A line with markup taken out as well. Angle brackets never survive. */
  function plain(v, max) {
    const s = String(v === null || v === undefined ? '' : v).slice(0, max * 8 + 64);
    return line(s.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' '), max);
  }
  /** Several lines (a note): each line plain, at most `max` characters in all. */
  function para(v, max) {
    const s = String(v === null || v === undefined ? '' : v).slice(0, max * 8 + 64).replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ');
    const out = s.split(/\r\n|\r|\n/).map((l) => line(l, max)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const cps = Array.from(out);
    return cps.length > max ? cps.slice(0, max).join('').trim() : out;
  }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function plural(n, word, many) { return `${n} ${n === 1 ? word : (many || `${word}s`)}`; }
  const hasWord = (s) => /[\p{L}\p{N}]/u.test(s);
  /** Links of any kind out of something a model wrote. */
  function stripLinks(s) {
    return String(s)
      .replace(/\b(?:https?|ftp|file|data|javascript|vbscript)\s*:\S*/gi, '')
      .replace(/\bwww\.\S+/gi, '')
      .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|uk|us|ca|au|de|app|dev|info|biz|ly|me|tv|xyz|link|site|online|shop|store|example)\b\S*/gi, '');
  }
  /** A model's words: plain, no links, bounded. */
  function plainOut(v, max) {
    if (typeof v !== 'string') return '';
    return line(stripLinks(plain(v, max * 4)).replace(/\s+([,.!?;:])/g, '$1'), max);
  }

  const ID_RE = /^[a-z0-9-]{1,24}$/;
  const isId = (v) => typeof v === 'string' && ID_RE.test(v);

  /* ------------------------------------------------------------------ *
   * Days. A day is YYYY-MM-DD in the person's own calendar; sums are done
   * on Date.UTC day numbers, so no clock change can make a day 23 or 25
   * hours long.
   * ------------------------------------------------------------------ */

  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isDay(v) {
    if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    if (y < 2000 || y > 2100) return false;
    const back = new Date(Date.UTC(y, m - 1, d));
    return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
  }
  function dayMs(day) { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); }
  function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(day, n) { return dayOf(dayMs(day) + n * 86400000); }
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / 86400000); }
  /** 0 = Sunday ... 6 = Saturday. */
  function weekday(day) { return new Date(dayMs(day)).getUTCDay(); }
  /** `n` working days after `day` (Saturdays and Sundays skipped; public
   *  holidays are not known, which is one reason the date is editable). */
  function addBusinessDays(day, n) {
    let d = day;
    let left = Math.max(0, Math.floor(n));
    while (left > 0) { d = addDays(d, 1); const w = weekday(d); if (w !== 0 && w !== 6) left--; }
    return d;
  }
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** "Nov 6" (with the year when it is not this year's). */
  function shortDay(day, today) {
    if (!isDay(day)) return '';
    const [y, m, d] = day.split('-').map(Number);
    return `${MONTH_SHORT[m - 1]} ${d}${today && isDay(today) && today.slice(0, 4) !== day.slice(0, 4) ? `, ${y}` : ''}`;
  }
  /** "Fri Nov 6". */
  function fmtDay(day, today) { return isDay(day) ? `${DAY_SHORT[weekday(day)]} ${shortDay(day, today)}` : ''; }
  function monthKey(day) { return day.slice(0, 7); }
  function monthLabel(key) { return MONTH_SHORT[Number(key.slice(5, 7)) - 1] || ''; }
  /** The calendar day at instant `ms` in time zone `tz`, from Intl alone. */
  function localDay(ms, tz) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  /* ------------------------------------------------------------------ *
   * Money: integer cents, in the person's own currency.
   * ------------------------------------------------------------------ */

  // Two-decimal currencies only, so cents are always cents.
  const CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'ZAR', 'INR', 'SGD', 'MXN'];
  const REGION_CURRENCY = {
    US: 'USD', CA: 'CAD', GB: 'GBP', UK: 'GBP', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR',
    FI: 'EUR', GR: 'EUR', LU: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', MT: 'EUR', CY: 'EUR', HR: 'EUR',
    AU: 'AUD', NZ: 'NZD', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', ZA: 'ZAR', IN: 'INR', SG: 'SGD', MX: 'MXN',
  };
  /** The currency for a locale like "en-GB" (USD when it cannot tell, or
   *  when the region's currency has no cents). */
  function currencyFor(locale) {
    const m = /[-_]([A-Za-z]{2})\b/.exec(String(locale || ''));
    return (m && REGION_CURRENCY[m[1].toUpperCase()]) || 'USD';
  }
  const isCurrency = (c) => CURRENCIES.includes(c);
  const SYMBOL = { USD: '$', CAD: '$', AUD: '$', NZD: '$', SGD: '$', MXN: '$', GBP: '£', EUR: '€', INR: '₹', ZAR: 'R', CHF: 'CHF ', SEK: 'kr ', NOK: 'kr ', DKK: 'kr ', PLN: 'zł ' };
  /** "$89", "£12.50". Whole amounts drop the pennies. */
  function money(cents, currency, locale) {
    const c = isCurrency(currency) ? currency : 'USD';
    const n = Math.round(Number(cents) || 0);
    const whole = n % 100 === 0;
    try {
      return new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: c, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(n / 100);
    } catch (e) {
      return `${n < 0 ? '-' : ''}${SYMBOL[c] || ''}${(Math.abs(n) / 100).toFixed(whole ? 0 : 2)}`;
    }
  }
  /** "89.00" - the plain number a spreadsheet reads. */
  function decimal(cents) { return Number.isInteger(cents) ? (cents / 100).toFixed(2) : ''; }
  /** What someone typed as a price, in cents - or null. "free" and "" are
   *  no price (never 0.00); a negative is refused. "12", "12.5", "$1,240",
   *  "12,50" all read. */
  function readMoney(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v * 100 <= LIMITS.priceCents ? Math.round(v * 100) : null;
    let s = String(v === null || v === undefined ? '' : v).trim().slice(0, 40);
    if (!s || /^-|\(/.test(s) || !/\d/.test(s)) return null;
    s = s.replace(/[^\d.,]/g, '');
    if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    s = s.replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s) && !/^\d+\.$/.test(s)) return null;
    const c = Math.round(parseFloat(s) * 100);
    return Number.isFinite(c) && c >= 0 && c <= LIMITS.priceCents ? c : null;
  }
  function cents(v) { return Number.isInteger(v) && v >= 0 && v <= LIMITS.priceCents ? v : null; }

  /** An https link, or ''. No credentials, no other scheme, bounded. */
  function cleanUrl(v) {
    const s = line(v, LIMITS.url);
    if (!/^https:\/\//i.test(s)) return '';
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' || u.username || u.password || !u.hostname || !/\./.test(u.hostname) || u.port) return '';
      return u.href.length <= LIMITS.url ? u.href : '';
    } catch (e) { return ''; }
  }

  /* ------------------------------------------------------------------ *
   * A purchase.
   * ------------------------------------------------------------------ */

  // The quick choices for a return window. "Until a date" is the fifth: for
  // a holiday window, or whatever the receipt says. Takeback never fills in
  // a store's policy - only what the person picks.
  const WINDOW_PRESETS = [14, 30, 60, 90];
  const HOW = [
    { id: 'mail', label: 'By mail' },
    { id: 'store', label: 'In store' },
    { id: 'dropoff', label: 'Drop-off point' },
  ];
  const HOW_IDS = HOW.map((h) => h.id);
  const howLabel = (id) => (HOW.find((h) => h.id === id) || {}).label || '';
  const DECISIONS = ['keep', 'return'];
  const REFUND_KINDS = ['card', 'credit'];
  const STEP_IDS = ['started', 'label', 'packed', 'dropped'];
  const STATES = ['deciding', 'returning', 'waiting', 'overdue', 'refunded', 'kept', 'missed'];

  /** {days} or {until}, or null. `until` must be on or after the day it was
   *  bought and not absurdly far after it. */
  function cleanWindow(w, bought) {
    if (!w || typeof w !== 'object') return null;
    if (isDay(w.until) && (!bought || (w.until >= bought && daysBetween(bought, w.until) <= LIMITS.untilMaxDays))) return { until: w.until };
    const d = w.days;
    if (Number.isInteger(d) && d >= 1 && d <= LIMITS.windowMaxDays) return { days: d };
    return null;
  }
  function returnBy(p) {
    if (!p || !p.window || !isDay(p.bought)) return null;
    return p.window.until || addDays(p.bought, p.window.days);
  }
  function windowLabel(w, today) {
    if (!w) return 'No return window yet';
    return w.until ? `Until ${shortDay(w.until, today)}` : `${w.days} days`;
  }
  function cleanSteps(s) {
    const out = {};
    for (const k of STEP_IDS) out[k] = s && isDay(s[k]) ? s[k] : null;
    return out;
  }
  function cleanRefund(r, o) {
    if (!r || typeof r !== 'object') return null;
    const amount = cents(r.amount);
    if (amount === null || !isDay(r.day) || r.day > addDays(o.today, 1)) return null;
    return { amount, day: r.day, kind: REFUND_KINDS.includes(r.kind) ? r.kind : 'card' };
  }
  const msOk = (v, o) => (Number.isInteger(v) && v > 0 ? Math.min(v, o.nowMs + 86400000) : null);
  const ORDER_JUNK = /[^A-Za-z0-9 #\-_/.]/g;

  /**
   * One door for typed, stored, imported, synced and sample purchases.
   * @param raw  anything
   * @param o    {today, nowMs}
   * @returns    the purchase, or null when it has no id, store or item
   */
  function cleanPurchase(raw, o) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isId(raw.id)) return null;
    const store = plain(raw.store, LIMITS.store);
    const item = plain(raw.item, LIMITS.item);
    if (!hasWord(store) || !hasWord(item)) return null;
    const lo = addDays(o.today, -LIMITS.boughtBackDays);
    const bought = isDay(raw.bought) && raw.bought <= addDays(o.today, 1) && raw.bought >= lo ? raw.bought : o.today;
    const decision = DECISIONS.includes(raw.decision) ? raw.decision : null;
    const steps = cleanSteps(decision === 'return' ? raw.steps : null);
    let expectBy = steps.dropped && isDay(raw.expectBy) && raw.expectBy >= steps.dropped && daysBetween(steps.dropped, raw.expectBy) <= 120 ? raw.expectBy : null;
    if (steps.dropped && !expectBy) expectBy = addBusinessDays(steps.dropped, LIMITS.refundBusinessDays);
    const createdAt = msOk(raw.createdAt, o) || o.nowMs;
    return {
      id: raw.id,
      group: isId(raw.group) ? raw.group : raw.id,
      store,
      item,
      price: cents(raw.price),
      bought,
      window: cleanWindow(raw.window, bought),
      order: line(plain(raw.order, LIMITS.order * 2).replace(ORDER_JUNK, ''), LIMITS.order),
      how: HOW_IDS.includes(raw.how) ? raw.how : '',
      gift: raw.gift === true,
      url: cleanUrl(raw.url),
      note: para(raw.note, LIMITS.note),
      photo: raw.photo === true,
      dropPhoto: raw.dropPhoto === true && Boolean(steps.dropped),
      decision,
      decidedDay: decision && isDay(raw.decidedDay) && raw.decidedDay <= addDays(o.today, 1) ? raw.decidedDay : (decision ? o.today : null),
      steps,
      expectBy,
      refund: decision === 'return' ? cleanRefund(raw.refund, o) : null,
      createdAt,
      updatedAt: Math.max(createdAt, msOk(raw.updatedAt, o) || createdAt),
    };
  }

  /**
   * The add form: one or several items from one order, sharing the store,
   * the day, the window and the rest. Returns {purchases, error}.
   * @param input {store, bought, window, order, how, gift, url, note, photo,
   *               items: [{item, price}]}
   * @param o     {today, nowMs, newId()}
   */
  function newPurchases(input, o) {
    const inp = input || {};
    const store = plain(inp.store, LIMITS.store);
    if (!hasWord(store)) return { purchases: [], error: 'Which store was it?' };
    const rows = (Array.isArray(inp.items) ? inp.items : []).slice(0, LIMITS.batch)
      .map((r) => ({ item: plain(r && r.item, LIMITS.item), price: typeof (r && r.price) === 'number' ? cents(r.price) : readMoney(r && r.price) }))
      .filter((r) => hasWord(r.item));
    if (!rows.length) return { purchases: [], error: 'What did you buy?' };
    const bought = isDay(inp.bought) && inp.bought <= addDays(o.today, 1) ? inp.bought : o.today;
    const window = cleanWindow(inp.window, bought);
    if (!window) return { purchases: [], error: 'Pick the return window - it is on the receipt or the store’s returns page.' };
    const group = o.newId();
    const purchases = rows.map((r, i) => cleanPurchase({
      id: i === 0 ? group : o.newId(), group, store, item: r.item, price: r.price, bought, window,
      order: inp.order, how: inp.how, gift: inp.gift === true, url: inp.url, note: inp.note, photo: inp.photo === true,
      createdAt: o.nowMs + i, updatedAt: o.nowMs + i,
    }, o)).filter(Boolean);
    return { purchases, error: '' };
  }

  /** Where a purchase stands today. */
  function stateOf(p, today) {
    if (p.refund) return 'refunded';
    if (p.decision === 'keep') return 'kept';
    if (p.decision === 'return' && p.steps.dropped) return p.expectBy && today > p.expectBy ? 'overdue' : 'waiting';
    const rb = returnBy(p);
    if (rb && today > rb) return 'missed';
    return p.decision === 'return' ? 'returning' : 'deciding';
  }
  const isOpen = (s) => s === 'deciding' || s === 'returning';
  function daysLeft(p, today) { const rb = returnBy(p); return rb ? daysBetween(today, rb) : null; }
  /** The colour of a countdown: red under two days, amber under a week. */
  function urgency(d) {
    if (d === null || d === undefined) return 'amber';
    if (d < 0) return 'grey';
    if (d < 2) return 'red';
    if (d < 7) return 'amber';
    return 'ok';
  }
  function lateDays(p, today) { return stateOf(p, today) === 'overdue' ? daysBetween(p.expectBy, today) : 0; }
  function refundWord(p, o) {
    const r = p.refund;
    if (!r) return '';
    const amt = money(r.amount, o.currency, o.locale);
    if (r.kind === 'credit') return `${amt} as store credit`;
    if (p.price && r.amount < p.price) return `Partly refunded: ${amt} of ${money(p.price, o.currency, o.locale)}`;
    return `Refunded ${amt}`;
  }

  /**
   * The one line under a purchase, and its tone: red, amber, ok, wait,
   * done or grey.
   * @param o {today, currency, locale}
   */
  function statusOf(p, o) {
    const today = o.today;
    const state = stateOf(p, today);
    const rb = returnBy(p);
    if (state === 'refunded') return { state, tone: 'done', text: `${refundWord(p, o)} on ${shortDay(p.refund.day, today)}` };
    if (state === 'kept') return { state, tone: 'grey', text: `Kept${p.decidedDay ? ` · decided ${shortDay(p.decidedDay, today)}` : ''}` };
    if (state === 'missed') return { state, tone: 'grey', text: `Missed - closed ${shortDay(rb, today)}` };
    if (state === 'overdue') {
      const n = lateDays(p, today);
      return { state, tone: 'red', text: `No refund yet - ${plural(n, 'day')} late` };
    }
    if (state === 'waiting') {
      const n = daysBetween(today, p.expectBy);
      return { state, tone: 'wait', text: `Dropped off ${shortDay(p.steps.dropped, today)} · refund expected by ${fmtDay(p.expectBy, today)}${n === 0 ? ' (today)' : ''}` };
    }
    if (!rb) return { state, tone: 'amber', text: 'Add the return-by date' };
    const d = daysBetween(today, rb);
    const tone = urgency(d);
    if (d === 0) return { state, tone, text: 'Return by today · last day' };
    if (d === 1) return { state, tone, text: `Return by tomorrow, ${fmtDay(rb, today)} · 1 day left` };
    return { state, tone, text: `Return by ${fmtDay(rb, today)} · ${plural(d, 'day')} left` };
  }

  /* ------------------------------------------------------------------ *
   * Sending it back: a checklist with the money at the end.
   * ------------------------------------------------------------------ */

  /** The steps for how it goes back, each with its words. */
  function stepsFor(how) {
    const label = how === 'mail' ? 'Label printed' : how === 'dropoff' ? 'Return code saved' : 'Label printed or return code saved';
    const all = [
      { id: 'started', label: 'Return started', act: 'Started the return' },
      { id: 'label', label, act: how === 'dropoff' ? 'Code saved' : 'Label printed' },
      { id: 'packed', label: 'Packed', act: 'Packed it' },
      { id: 'dropped', label: how === 'store' ? 'Taken back to the store' : 'Dropped off', act: how === 'store' ? 'Taken back' : 'Dropped off' },
    ];
    return how === 'store' ? [all[0], all[3]] : all;
  }
  /** The next thing to tick, or 'refund' once it is dropped off. */
  function nextStep(p) {
    if (p.refund || p.decision !== 'return') return null;
    if (p.steps.dropped) return 'refund';
    const s = stepsFor(p.how).find((x) => !p.steps[x.id]);
    return s ? s.id : 'dropped';
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  /** Keep it, send it back, or undecided again. Pure: a new purchase. */
  function decide(p, decision, o) {
    const next = clone(p);
    next.decision = DECISIONS.includes(decision) ? decision : null;
    next.decidedDay = next.decision ? o.today : null;
    if (next.decision !== 'return') { next.steps = cleanSteps(null); next.expectBy = null; next.refund = null; next.dropPhoto = false; }
    next.updatedAt = Math.max(o.nowMs, p.updatedAt + 1);
    return cleanPurchase(next, o);
  }
  /** Tick (or untick, with day null) one step. Dropping it off sets the
   *  refund expected by, ten business days later, unless one is given. */
  function setStep(p, id, day, o, expectBy) {
    if (!STEP_IDS.includes(id)) return p;
    const next = clone(p);
    next.decision = 'return';
    next.decidedDay = next.decidedDay || o.today;
    next.steps = cleanSteps(next.steps);
    next.steps[id] = day && isDay(day) ? day : null;
    if (id === 'dropped') {
      next.expectBy = next.steps.dropped ? (isDay(expectBy) ? expectBy : addBusinessDays(next.steps.dropped, LIMITS.refundBusinessDays)) : null;
      if (!next.steps.dropped) { next.refund = null; next.dropPhoto = false; }
    }
    if (next.steps.dropped && !next.steps.started) next.steps.started = next.steps.dropped;
    next.updatedAt = Math.max(o.nowMs, p.updatedAt + 1);
    return cleanPurchase(next, o);
  }
  function setExpectBy(p, day, o) {
    const next = clone(p);
    next.expectBy = day;
    next.updatedAt = Math.max(o.nowMs, p.updatedAt + 1);
    return cleanPurchase(next, o);
  }
  /** The refund landed: the amount (partial is fine), the day, and whether
   *  it came back to the card or as store credit. */
  function recordRefund(p, r, o) {
    const next = clone(p);
    if (!next.steps || !next.steps.dropped) { next.decision = 'return'; next.steps = cleanSteps(next.steps); next.steps.dropped = (r && isDay(r.day) && r.day) || o.today; }
    next.decision = 'return';
    const amount = r && typeof r.amount === 'number' ? cents(r.amount) : readMoney(r && r.amount);
    next.refund = { amount: amount === null ? (p.price || 0) : amount, day: (r && isDay(r.day) && r.day <= addDays(o.today, 1)) ? r.day : o.today, kind: r && r.kind === 'credit' ? 'credit' : 'card' };
    next.updatedAt = Math.max(o.nowMs, p.updatedAt + 1);
    return cleanPurchase(next, o);
  }
  function clearRefund(p, o) {
    const next = clone(p);
    next.refund = null;
    next.updatedAt = Math.max(o.nowMs, p.updatedAt + 1);
    return cleanPurchase(next, o);
  }
  /** What to do about a refund that has not landed. */
  function overdueLine(p, today) {
    const n = lateDays(p, today);
    if (!n) return '';
    const where = p.refund === null && p.gift ? 'your store credit or gift card balance' : 'your card statement';
    return `No refund yet from ${p.store} - ${plural(n, 'day')} late. Check ${where}, then contact them with the drop-off receipt.`;
  }
  /** A short, polite message to the store, ready to paste. */
  function followUpText(p, o) {
    const parts = [`Hello - I returned “${p.item}”`];
    if (p.order) parts[0] += ` (order ${p.order})`;
    parts[0] += p.steps.dropped ? ` on ${shortDay(p.steps.dropped, o.today)}${p.how === 'store' ? ' in store' : ''}.` : '.';
    parts.push(`The refund${p.price ? ` of ${money(p.price, o.currency, o.locale)}` : ''} hasn’t arrived yet${p.expectBy ? ` - it was expected by ${shortDay(p.expectBy, o.today)}` : ''}.`);
    parts.push('Could you check on it, please? I have the drop-off receipt if you need it.');
    parts.push('Thank you.');
    return parts.join(' ');
  }

  /* ------------------------------------------------------------------ *
   * The list: what needs the person soonest, first.
   * ------------------------------------------------------------------ */

  function needRank(p, today) {
    const s = stateOf(p, today);
    const d = daysLeft(p, today);
    if (isOpen(s) && d !== null && d <= 1) return [0, d];
    if (s === 'overdue') return [1, -lateDays(p, today)];
    if (isOpen(s)) return [2, d === null ? 99999 : d];
    if (s === 'waiting') return [3, daysBetween(today, p.expectBy)];
    // Done: the most recent outcome first.
    const when = p.refund ? p.refund.day : (p.decidedDay || returnBy(p) || p.bought);
    return [4, -daysBetween('2000-01-01', when)];
  }
  function byNeed(list, today) {
    return list.slice().sort((a, b) => {
      const x = needRank(a, today), y = needRank(b, today);
      return (x[0] - y[0]) || (x[1] - y[1]) || (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1);
    });
  }
  const FILTERS = [
    { id: 'all', label: 'All', has: () => true },
    { id: 'decide', label: 'To decide', has: (s) => s === 'deciding' },
    { id: 'back', label: 'Sending back', has: (s) => s === 'returning' },
    { id: 'refund', label: 'Refunds', has: (s) => s === 'waiting' || s === 'overdue' },
    { id: 'done', label: 'Done', has: (s) => s === 'refunded' || s === 'kept' || s === 'missed' },
  ];
  function filterList(list, id, today) {
    const f = FILTERS.find((x) => x.id === id) || FILTERS[0];
    return byNeed(list, today).filter((p) => f.has(stateOf(p, today)));
  }
  /** "3 decisions due this week · $214 still returnable". */
  function summary(list, o) {
    const today = o.today;
    let due = 0, returnable = 0, returnableCount = 0, waiting = 0, waitingCount = 0, overdue = 0;
    for (const p of list) {
      const s = stateOf(p, today);
      const d = daysLeft(p, today);
      if (s === 'deciding' && d !== null && d >= 0 && d <= 6) due++;
      if (isOpen(s)) { returnable += p.price || 0; returnableCount++; }
      if (s === 'waiting' || s === 'overdue') { waiting += p.price || 0; waitingCount++; }
      if (s === 'overdue') overdue++;
    }
    const first = due ? `${plural(due, 'decision')} due this week` : 'Nothing due this week';
    const text = returnableCount ? `${first} · ${money(returnable, o.currency, o.locale)} still returnable`
      : (waitingCount ? `${plural(waitingCount, 'refund')} on the way · nothing left to decide` : 'Nothing left to decide');
    return { due, returnable, returnableCount, waiting, waitingCount, overdue, text };
  }
  /** The nudges on the home list, most pressing first. */
  function nudges(list, o) {
    const today = o.today;
    const out = [];
    for (const p of list) {
      const s = stateOf(p, today);
      if (s === 'overdue') out.push({ id: p.id, kind: 'overdue', rank: 0, text: overdueLine(p, today) });
      else if (isOpen(s)) {
        const d = daysLeft(p, today);
        if (d === 0) out.push({ id: p.id, kind: 'today', rank: 1, text: `Last day to return ${p.item} to ${p.store}.` });
        else if (d === 1) out.push({ id: p.id, kind: 'tomorrow', rank: 2, text: `${p.item} from ${p.store}: the window closes tomorrow.` });
        else if (s === 'returning' && d !== null && d <= 3 && !p.steps.dropped) out.push({ id: p.id, kind: 'drop', rank: 3, text: `${p.item} isn’t dropped off yet - ${plural(d, 'day')} left.` });
      } else if (s === 'waiting' && p.expectBy === today) out.push({ id: p.id, kind: 'expect', rank: 4, text: `The ${p.store} refund for ${p.item} is due today. Has it landed?` });
    }
    return out.sort((a, b) => a.rank - b.rank).slice(0, 4);
  }

  /* ------------------------------------------------------------------ *
   * The money tally.
   * ------------------------------------------------------------------ */

  function lastMonths(today, n) {
    const out = [];
    let y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
    for (let i = 0; i < n; i++) {
      out.unshift(`${y}-${String(m).padStart(2, '0')}`);
      m--; if (m === 0) { m = 12; y--; }
    }
    return out;
  }
  /**
   * "$642 recovered this year · $214 still returnable · $96 waiting on
   * refunds · 1 window missed ($38)", and the last six months.
   * @param o {today, currency, locale}
   */
  function tally(list, o) {
    const today = o.today;
    const year = today.slice(0, 4);
    const months = lastMonths(today, 6).map((k) => ({ key: k, label: monthLabel(k), recovered: 0, missed: 0 }));
    const mi = new Map(months.map((m, i) => [m.key, i]));
    const t = { recovered: 0, card: 0, credit: 0, refunds: 0, partial: 0, returnable: 0, returnableCount: 0, waiting: 0, waitingCount: 0, overdueCount: 0, missed: 0, missedCount: 0, kept: 0, keptCount: 0, returns: 0, tracked: list.length };
    for (const p of list) {
      const s = stateOf(p, today);
      const price = p.price || 0;
      if (s === 'refunded' && p.refund.day.slice(0, 4) === year) {
        t.recovered += p.refund.amount; t.refunds++;
        if (p.refund.kind === 'credit') t.credit += p.refund.amount; else t.card += p.refund.amount;
        if (p.price && p.refund.amount < p.price) t.partial++;
      }
      if (s === 'refunded') { const i = mi.get(monthKey(p.refund.day)); if (i !== undefined) months[i].recovered += p.refund.amount; }
      if (isOpen(s)) { t.returnable += price; t.returnableCount++; }
      if (s === 'waiting' || s === 'overdue') { t.waiting += price; t.waitingCount++; if (s === 'overdue') t.overdueCount++; }
      if (s === 'missed') {
        const rb = returnBy(p);
        if (rb.slice(0, 4) === year) { t.missed += price; t.missedCount++; }
        const i = mi.get(monthKey(rb)); if (i !== undefined) months[i].missed += price;
      }
      if (s === 'kept') { t.kept += price; t.keptCount++; }
      if (p.decision === 'return' && p.steps.dropped) t.returns++;
    }
    const m = (c) => money(c, o.currency, o.locale);
    const parts = [`${m(t.recovered)} recovered this year`, `${m(t.returnable)} still returnable`, `${m(t.waiting)} waiting on refunds`];
    if (t.missedCount) parts.push(`${plural(t.missedCount, 'window')} missed (${m(t.missed)})`);
    else parts.push('no windows missed');
    t.headline = parts.join(' · ');
    t.months = months;
    t.year = year;
    return t;
  }
  /** Stores by money recovered this year, for the recap (only when the
   *  person ticks "show store names"). */
  function topStores(list, o, n) {
    const year = o.today.slice(0, 4);
    const by = new Map();
    for (const p of list) {
      if (stateOf(p, o.today) !== 'refunded' || p.refund.day.slice(0, 4) !== year) continue;
      const k = storeKey(p.store);
      const cur = by.get(k) || { name: p.store, amount: 0, count: 0 };
      cur.amount += p.refund.amount; cur.count++;
      by.set(k, cur);
    }
    return [...by.values()].sort((a, b) => (b.amount - a.amount) || (a.name < b.name ? -1 : 1)).slice(0, n || 3);
  }

  /* ------------------------------------------------------------------ *
   * Stores: the ones already used, and the person's own notes on each.
   * ------------------------------------------------------------------ */

  function storeKey(name) {
    return line(name, LIMITS.store).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  /** Stores already used, the most recent first. */
  function storesUsed(list) {
    const by = new Map();
    for (const p of list) {
      const k = storeKey(p.store);
      if (!k) continue;
      const cur = by.get(k);
      if (!cur) by.set(k, { key: k, name: p.store, count: 1, last: p.createdAt });
      else { cur.count++; if (p.createdAt > cur.last) { cur.last = p.createdAt; cur.name = p.store; } }
    }
    return [...by.values()].sort((a, b) => (b.last - a.last) || (a.key < b.key ? -1 : 1));
  }
  /** The window the person picked last time at this store - their own
   *  choice, offered again. Never a store's policy. */
  function lastWindowFor(list, store) {
    const k = storeKey(store);
    if (!k) return null;
    const hits = list.filter((p) => storeKey(p.store) === k && p.window && p.window.days).sort((a, b) => b.createdAt - a.createdAt);
    return hits.length ? { days: hits[0].window.days } : null;
  }
  /** {<store key>: {name, text, at}} - typed by the person, never supplied. */
  function cleanNotes(raw, o) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    let n = 0;
    for (const k of Object.keys(raw)) {
      if (n >= LIMITS.storeNotes) break;
      const v = raw[k];
      if (!v || typeof v !== 'object') continue;
      const name = plain(v.name, LIMITS.store);
      const key = storeKey(name);
      const text = para(v.text, LIMITS.storeNote);
      if (!key || !text || key !== k || Object.prototype.hasOwnProperty.call(out, key)) continue;
      out[key] = { name, text, at: msOk(v.at, o) || o.nowMs };
      n++;
    }
    return out;
  }
  function noteFor(notes, store) {
    const k = storeKey(store);
    return k && notes && Object.prototype.hasOwnProperty.call(notes, k) ? notes[k] : null;
  }

  /* ------------------------------------------------------------------ *
   * Reminders: an .ics made on the device, in FLOATING local time
   * (DTSTART:20261103T090000, no TZID, no Z) - 9 AM wherever the phone is,
   * across a clock change, which is what "the morning of" means. Floating
   * events need no VTIMEZONE (Tada's reasoning; see its CLAUDE.md).
   * ------------------------------------------------------------------ */

  /** What can be added to the calendar for a purchase, from today on. */
  function reminderOptions(p, today) {
    const s = stateOf(p, today);
    const rb = returnBy(p);
    const out = [];
    if (isOpen(s) && rb) {
      const before = addDays(rb, -3);
      if (before >= today) out.push({ kind: 'before', day: before, label: `3 days before - ${fmtDay(before, today)}` });
      out.push({ kind: 'day', day: rb, label: `The morning of - ${fmtDay(rb, today)}` });
    }
    if ((s === 'waiting' || s === 'overdue') && p.expectBy) {
      const day = p.expectBy >= today ? p.expectBy : addDays(today, 1);
      out.push({ kind: 'refund', day, label: `${s === 'overdue' ? 'Check the refund again' : 'Has the refund landed?'} - ${fmtDay(day, today)}` });
    }
    return out;
  }
  function icsText(v) {
    return String(v === null || v === undefined ? '' : v).replace(INVISIBLE, '')
      .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
  }
  function utf8Len(ch) { const c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  /** Lines folded at 75 octets of UTF-8, never inside a character. */
  function icsFold(l) {
    const out = [];
    let cur = '';
    let bytes = 0;
    for (const ch of Array.from(l)) {
      const n = utf8Len(ch);
      if (bytes + n > 75) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch; bytes += n;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  function stampOf(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
  const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
  /**
   * @param list   purchases
   * @param picks  [{id, kind}] - which reminders (kinds from reminderOptions)
   * @param o      {nowMs, today, time: 'HH:MM', currency, locale}
   */
  function buildIcs(list, picks, o) {
    const time = TIME_RE.test(o.time || '') ? o.time.replace(':', '') : '0900';
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Takeback//Returns//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    let n = 0;
    for (const pick of picks || []) {
      const p = list.find((x) => x.id === pick.id);
      if (!p) continue;
      const opt = reminderOptions(p, o.today).find((x) => x.kind === pick.kind);
      if (!opt) continue;
      const rb = returnBy(p);
      const what = `${p.item} (${p.store})`;
      const summary = opt.kind === 'before' ? `3 days left to return: ${what}` : opt.kind === 'day' ? `Last day to return: ${what}` : `Has the ${p.store} refund landed? (${p.item})`;
      const desc = [];
      if (p.price) desc.push(`${opt.kind === 'refund' ? 'Refund' : 'Price'}: ${money(p.price, o.currency, o.locale)}`);
      if (rb && opt.kind !== 'refund') desc.push(`Return by ${fmtDay(rb, o.today)}.`);
      if (opt.kind === 'refund') desc.push(`Dropped off ${shortDay(p.steps.dropped, o.today)}. If it hasn’t landed, check your card statement, then contact them with the drop-off receipt.`);
      if (p.order) desc.push(`Order ${p.order}`);
      if (p.url && opt.kind !== 'refund') desc.push(`Returns page: ${p.url}`);
      desc.push('Open Takeback to tick it off.');
      lines.push(
        'BEGIN:VEVENT',
        `UID:takeback-${p.id}-${opt.kind}@takeback`,
        `DTSTAMP:${stampOf(o.nowMs)}`,
        `DTSTART:${opt.day.replace(/-/g, '')}T${time}00`,
        'DURATION:PT15M',
        `SUMMARY:${icsText(summary)}`,
        `DESCRIPTION:${icsText(desc.join('\n'))}`,
        'TRANSP:TRANSPARENT',
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(summary)}`, 'TRIGGER:PT0M', 'END:VALARM',
        'END:VEVENT',
      );
      n++;
    }
    lines.push('END:VCALENDAR');
    return n ? lines.map(icsFold).join('\r\n') + '\r\n' : '';
  }

  /* ------------------------------------------------------------------ *
   * CSV: out with formulas defused, back in through cleanPurchase.
   * ------------------------------------------------------------------ */

  const CSV_HEAD = ['id', 'group', 'store', 'item', 'price', 'currency', 'bought', 'window_days', 'return_by', 'order', 'how', 'gift', 'decision', 'decided', 'started', 'label', 'packed', 'dropped', 'refund_expected', 'refund_amount', 'refund_date', 'refund_kind', 'return_page', 'note'];
  /** RFC 4180, with formulas defused (a leading = + - @ tab or CR). */
  function csvCell(v) {
    let s = String(v === null || v === undefined ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCsv(rows) { return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
  function purchasesCsv(list, o) {
    const rows = [CSV_HEAD];
    for (const p of list) {
      rows.push([
        p.id, p.group, p.store, p.item, decimal(p.price), o.currency || 'USD', p.bought, p.window && p.window.days ? p.window.days : '', returnBy(p) || '',
        p.order, p.how, p.gift ? 'yes' : '', p.decision || '', p.decidedDay || '', p.steps.started || '', p.steps.label || '', p.steps.packed || '', p.steps.dropped || '',
        p.expectBy || '', p.refund ? decimal(p.refund.amount) : '', p.refund ? p.refund.day : '', p.refund ? p.refund.kind : '', p.url, p.note,
      ]);
    }
    return toCsv(rows);
  }
  /** RFC 4180 rows: quoted delimiters, doubled quotes, line breaks inside
   *  quotes, CRLF / LF / CR, a BOM. Bounded. */
  function parseCsv(text) {
    const s = String(text || '').slice(0, LIMITS.csvBytes).replace(/^\ufeff/, '');
    const rows = [];
    let row = [], cell = '', q = false, i = 0;
    const push = () => { if (row.length < LIMITS.csvCols) row.push(cell); cell = ''; };
    while (i < s.length && rows.length <= LIMITS.csvRows) {
      const ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
        if (cell.length < 4000) cell += ch;
        i++; continue;
      }
      if (ch === '"' && cell === '') { q = true; i++; continue; }
      if (ch === ',') { push(); i++; continue; }
      if (ch === '\r' || ch === '\n') { push(); rows.push(row); row = []; i += (ch === '\r' && s[i + 1] === '\n') ? 2 : 1; continue; }
      if (cell.length < 4000) cell += ch;
      i++;
    }
    if (cell !== '' || row.length) { push(); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }
  /** Our own defusing, undone: a ' in front of = + - @ tab or CR. */
  const undefuse = (v) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);
  /**
   * A CSV back into purchases. Rows without an id get a new one; every row
   * goes through cleanPurchase. Returns {purchases, skipped, error}.
   * @param o {today, nowMs, newId()}
   */
  function fromCsv(text, o) {
    const rows = parseCsv(text);
    if (!rows.length) return { purchases: [], skipped: 0, error: 'That file is empty.' };
    const head = rows[0].map((h) => line(h, 40).toLowerCase().replace(/[^a-z_]/g, ''));
    const col = (name) => head.indexOf(name);
    if (col('store') < 0 || col('item') < 0) return { purchases: [], skipped: 0, error: 'That file has no store and item columns. Use a CSV that Takeback exported.' };
    const purchases = [];
    let skipped = 0;
    const seen = new Set();
    for (const r of rows.slice(1, LIMITS.purchases + 1)) {
      const get = (name) => { const i = col(name); return i >= 0 && r[i] !== undefined ? undefuse(String(r[i])) : ''; };
      const days = /^\d{1,3}$/.test(get('window_days').trim()) ? Number(get('window_days')) : null;
      const until = get('return_by').trim();
      const id = isId(get('id').trim()) && !seen.has(get('id').trim()) ? get('id').trim() : o.newId();
      const decision = get('decision').trim().toLowerCase();
      const raw = {
        id,
        group: isId(get('group').trim()) ? get('group').trim() : id,
        store: get('store'), item: get('item'),
        price: readMoney(get('price')),
        bought: get('bought').trim(),
        window: days ? { days } : (isDay(until) ? { until } : null),
        order: get('order'), how: get('how').trim().toLowerCase(),
        gift: /^(yes|true|1|y)$/i.test(get('gift').trim()),
        decision: DECISIONS.includes(decision) ? decision : null,
        decidedDay: get('decided').trim(),
        steps: { started: get('started').trim(), label: get('label').trim(), packed: get('packed').trim(), dropped: get('dropped').trim() },
        expectBy: get('refund_expected').trim(),
        refund: get('refund_date').trim() ? { amount: readMoney(get('refund_amount')), day: get('refund_date').trim(), kind: get('refund_kind').trim().toLowerCase() } : null,
        url: get('return_page'), note: get('note'),
        createdAt: o.nowMs + purchases.length, updatedAt: o.nowMs + purchases.length,
      };
      const p = cleanPurchase(raw, o);
      if (p) { purchases.push(p); seen.add(p.id); } else skipped++;
    }
    skipped += Math.max(0, rows.length - 1 - LIMITS.purchases);
    return { purchases, skipped, error: purchases.length ? '' : 'No purchases could be read from that file.' };
  }

  /* ------------------------------------------------------------------ *
   * Sync: the account copy holds the list (store, item, prices, dates) and
   * never a photo. A merge by item keeps the later edit of each.
   * ------------------------------------------------------------------ */

  /** What leaves the device: no photo flags (photos stay on the phone). */
  function syncPayload(list, notes, deleted) {
    return {
      purchases: list.map((p) => { const c = clone(p); delete c.photo; delete c.dropPhoto; return c; }),
      notes: notes || {},
      deleted: deleted || [],
    };
  }
  function cleanTombstones(raw, o) {
    const by = new Map();
    for (const t of Array.isArray(raw) ? raw.slice(0, LIMITS.tombstones * 2) : []) {
      if (!t || !isId(t.id)) continue;
      const at = msOk(t.at, o);
      if (!at) continue;
      if (!by.has(t.id) || by.get(t.id) < at) by.set(t.id, at);
    }
    return [...by.entries()].map(([id, at]) => ({ id, at })).sort((a, b) => b.at - a.at).slice(0, LIMITS.tombstones);
  }
  /**
   * The account copy, cleaned. Strict (the server): unknown keys or more
   * than 500 purchases are errors and nothing is saved.
   * @returns {list: {purchases, notes, deleted}, errors, dropped}
   */
  function cleanList(raw, o, strict) {
    const errors = [];
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (strict) {
      if (r !== raw) errors.push('Send the list.');
      for (const k of Object.keys(r)) if (!['purchases', 'notes', 'deleted'].includes(k)) errors.push(`Unknown field: ${line(k, 20)}`);
      if (Array.isArray(r.purchases) && r.purchases.length > LIMITS.purchases) errors.push(`At most ${LIMITS.purchases} purchases.`);
      if (r.purchases !== undefined && !Array.isArray(r.purchases)) errors.push('Purchases must be a list.');
    }
    const src = Array.isArray(r.purchases) ? r.purchases.slice(0, LIMITS.purchases) : [];
    const seen = new Set();
    const purchases = [];
    for (const x of src) {
      const p = cleanPurchase(x, o);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      if (strict) { p.photo = false; p.dropPhoto = false; }
      purchases.push(p);
    }
    return { list: { purchases, notes: cleanNotes(r.notes, o), deleted: cleanTombstones(r.deleted, o) }, errors, dropped: src.length - purchases.length };
  }
  /** Merge two copies by item: the later edit of each purchase wins, a
   *  deletion beats an older edit, and store notes merge by store. */
  function mergeLists(mine, theirs, o) {
    const a = cleanList(mine, o).list, b = cleanList(theirs, o).list;
    const deleted = cleanTombstones(a.deleted.concat(b.deleted), o);
    const gone = new Map(deleted.map((t) => [t.id, t.at]));
    const by = new Map();
    for (const p of b.purchases) by.set(p.id, p);
    for (const p of a.purchases) { const q = by.get(p.id); if (!q || p.updatedAt >= q.updatedAt) by.set(p.id, p); }
    const purchases = [...by.values()].filter((p) => !(gone.has(p.id) && gone.get(p.id) >= p.updatedAt))
      .sort((x, y) => (x.createdAt - y.createdAt) || (x.id < y.id ? -1 : 1)).slice(-LIMITS.purchases);
    const notes = Object.assign({}, b.notes);
    for (const k of Object.keys(a.notes)) if (!notes[k] || a.notes[k].at >= notes[k].at) notes[k] = a.notes[k];
    return { purchases, notes, deleted };
  }
  function listBytes(list) { return new TextEncoder().encode(JSON.stringify(list)).length; }

  /* ------------------------------------------------------------------ *
   * "Read my receipt or order email": what is sent, what is accepted back.
   * ------------------------------------------------------------------ */

  const CONFIDENCE = ['low', 'medium', 'high'];
  const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
  /** Exactly {image: {type, data}} - one JPEG or PNG and nothing else, or
   *  null. Its bytes are checked again on the server. */
  function receiptRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (Object.keys(body).length !== 1 || !body.image || typeof body.image !== 'object' || Array.isArray(body.image)) return null;
    const im = body.image;
    if (Object.keys(im).sort().join(',') !== 'data,type') return null;
    if (im.type !== 'image/jpeg' && im.type !== 'image/png') return null;
    if (typeof im.data !== 'string' || im.data.length < 16 || im.data.length > Math.ceil(LIMITS.aiImageBytes / 3) * 4 + 4 || !B64.test(im.data)) return null;
    return { image: { type: im.type, data: im.data } };
  }
  function luhn(digits) {
    let sum = 0;
    let dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d; dbl = !dbl;
    }
    return sum % 10 === 0;
  }
  /** A card number: a run of 13 to 19 digits, or a card-shaped group (4-4-4-x
   *  or 4-6-5, spaced or dashed), that passes the Luhn check. A 12-digit UPC
   *  is not one - receipts print a barcode on most lines - and other long
   *  runs are taken out of the answer by scrubRuns rather than refusing it. */
  function hasCardLike(s) {
    const t = String(s || '');
    if ((t.match(/\d+/g) || []).some((r) => r.length >= 13 && r.length <= 19 && luhn(r))) return true;
    const groups = t.match(/\b\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}\b|\b\d{4}([ -])\d{6}\2\d{4,5}\b/g) || [];
    return groups.some((g) => { const d = g.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); });
  }
  /** Barcodes and other long references: never useful in a name or a note. */
  const scrubRuns = (s) => (typeof s === 'string' ? s.replace(/\d{12,}/g, ' ').replace(/\s{2,}/g, ' ').trim() : s);
  function anyCardLike(v, depth, skipKey) {
    if (typeof v === 'string') return hasCardLike(v);
    if (!v || typeof v !== 'object' || depth > 5) return false;
    for (const k of Object.keys(v)) { if (k === skipKey) continue; if (anyCardLike(v[k], depth + 1, skipKey)) return true; }
    return false;
  }
  /**
   * The model's answer, checked. Nothing it says is trusted:
   *   - a card number anywhere (but the order number) refuses the whole
   *     answer ({refused: 'card-number'});
   *   - any other run of 12+ digits (a barcode) is taken out of the text;
   *   - an order number with a run of 12+ digits is dropped (the person types it);
   *   - names plain, no links, bounded; at most 30 items; prices whole cents
   *     at or above zero and bounded; the order date real, within two years
   *     and not in the future;
   *   - the return window only with the words it was read from.
   * @param o {today}
   */
  function cleanReceipt(raw, o) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (anyCardLike(raw, 0, 'order_number')) return { refused: 'card-number' };
    const today = o.today;
    const store = plainOut(scrubRuns(raw.store), LIMITS.store);
    const d = typeof raw.order_date === 'string' ? raw.order_date.trim() : '';
    const bought = isDay(d) && d <= addDays(today, 1) && d >= addDays(today, -LIMITS.aiBackDays) ? d : '';
    let order = line(plain(typeof raw.order_number === 'string' ? raw.order_number : '', LIMITS.order * 2).replace(ORDER_JUNK, ''), LIMITS.order);
    let orderDropped = false;
    if (/\d{12,}/.test(order) || hasCardLike(order)) { order = ''; orderDropped = true; }
    const cur = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
    const items = [];
    for (const it of Array.isArray(raw.items) ? raw.items.slice(0, LIMITS.aiItems * 3) : []) {
      if (items.length >= LIMITS.aiItems) break;
      if (!it || typeof it !== 'object') continue;
      let name = plainOut(scrubRuns(it.name), LIMITS.item);
      if (!hasWord(name)) continue;
      const q = it.quantity;
      if (Number.isInteger(q) && q >= 2 && q <= 99) name = line(`${name} ×${q}`, LIMITS.item);
      const pr = it.price;
      const price = typeof pr === 'number' && Number.isFinite(pr) && pr >= 0 && pr * 100 <= LIMITS.priceCents ? Math.round(pr * 100) : null;
      items.push({ item: name, price });
    }
    let window = null;
    let quote = '';
    const rw = raw.return_window;
    if (rw && typeof rw === 'object' && rw.found !== false) {
      quote = plainOut(scrubRuns(rw.quote), LIMITS.aiQuote);
      const from = bought || today;
      if (quote) {
        if (isDay(rw.until) && rw.until >= addDays(from, 1) && daysBetween(from, rw.until) <= LIMITS.untilMaxDays) window = { until: rw.until };
        else if (Number.isInteger(rw.days) && rw.days >= 1 && rw.days <= LIMITS.windowMaxDays) window = { days: rw.days };
      }
      if (!window) quote = '';
    }
    if (!store && !items.length) return null;
    return {
      store, bought, order, orderDropped,
      currency: isCurrency(cur) ? cur : '',
      items, window, quote,
      confidence: CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'low',
      note: plainOut(scrubRuns(raw.note), LIMITS.aiNote),
    };
  }

  /* ------------------------------------------------------------------ *
   * "Try it": a made-up set of purchases in every state. Never saved.
   * Every store and item is invented.
   * ------------------------------------------------------------------ */

  function sample(o) {
    const t = o.today;
    const at = (n) => o.nowMs - n * 86400000;
    const rows = [
      { id: 's-boots', store: 'Juniper Outfitters', item: 'Suede ankle boots', price: 8900, bought: addDays(t, -27), window: { days: 30 }, how: 'mail', order: 'JO-48213', note: 'A half size too big.' },
      { id: 's-game', store: 'Pinecone Toys', item: 'Board game (duplicate gift)', price: 4200, bought: addDays(t, -13), window: { days: 14 }, how: 'store' },
      { id: 's-scarf', store: 'Harbor & Vine', item: 'Wool scarf', price: 3400, bought: addDays(t, -5), window: { until: addDays(t, 85) }, how: 'store', note: 'Holiday window on the receipt.' },
      { id: 's-lamp', store: 'Northwind Home', item: 'Desk lamp', price: 7500, bought: addDays(t, -21), window: { days: 30 }, how: 'mail', decision: 'return', steps: { started: addDays(t, -2), label: addDays(t, -1) }, order: 'NH-20931' },
      { id: 's-buds', store: 'Bluebird Electronics', item: 'Wireless earbuds', price: 7900, bought: addDays(t, -16), window: { days: 30 }, how: 'dropoff', decision: 'return', steps: { started: addDays(t, -5), label: addDays(t, -5), packed: addDays(t, -4), dropped: addDays(t, -4) } },
      { id: 's-jacket', store: 'Juniper Outfitters', item: 'Rain jacket', price: 14800, bought: addDays(t, -40), window: { days: 30 }, how: 'mail', decision: 'return', steps: { started: addDays(t, -22), label: addDays(t, -22), packed: addDays(t, -21), dropped: addDays(t, -21) }, expectBy: addDays(t, -4), order: 'JO-47790', dropPhoto: false },
      { id: 's-grinder', store: 'Copper Kettle Co.', item: 'Coffee grinder', price: 6400, bought: addDays(t, -30), window: { days: 30 }, how: 'mail', decision: 'return', steps: { started: addDays(t, -24), label: addDays(t, -24), packed: addDays(t, -23), dropped: addDays(t, -22) }, refund: { amount: 6400, day: addDays(t, -9), kind: 'card' } },
      { id: 's-duvet', store: 'Northwind Home', item: 'Linen duvet cover', price: 12000, bought: addDays(t, -45), window: { days: 30 }, how: 'mail', decision: 'return', steps: { started: addDays(t, -36), label: addDays(t, -36), packed: addDays(t, -35), dropped: addDays(t, -34) }, refund: { amount: 9600, day: addDays(t, -20), kind: 'card' }, note: 'They kept a $24 restocking fee.' },
      { id: 's-sweater', store: 'Harbor & Vine', item: 'Cable-knit sweater (gift)', price: 4500, bought: addDays(t, -25), window: { days: 60 }, how: 'store', gift: true, decision: 'return', steps: { started: addDays(t, -12), dropped: addDays(t, -12) }, refund: { amount: 4500, day: addDays(t, -12), kind: 'credit' } },
      { id: 's-poles', store: 'Fleetfoot Sports', item: 'Trekking poles', price: 5800, bought: addDays(t, -80), window: { days: 30 }, how: 'store', decision: 'return', steps: { started: addDays(t, -60), dropped: addDays(t, -60) }, refund: { amount: 5800, day: addDays(t, -55), kind: 'card' } },
      { id: 's-blender', store: 'Copper Kettle Co.', item: 'Blender', price: 9500, bought: addDays(t, -120), window: { days: 30 }, how: 'mail', decision: 'return', steps: { started: addDays(t, -104), label: addDays(t, -104), packed: addDays(t, -103), dropped: addDays(t, -103) }, refund: { amount: 9500, day: addDays(t, -95), kind: 'card' } },
      { id: 's-shoes', store: 'Fleetfoot Sports', item: 'Running shoes', price: 11000, bought: addDays(t, -10), window: { days: 30 }, how: 'store', decision: 'keep', decidedDay: addDays(t, -3) },
      { id: 's-case', store: 'Bluebird Electronics', item: 'Phone case', price: 3800, bought: addDays(t, -33), window: { days: 30 }, how: 'mail' },
    ];
    return rows.map((r, i) => cleanPurchase(Object.assign({ group: r.id, createdAt: at(60 - i), updatedAt: at(30 - i) }, r), o)).filter(Boolean);
  }
  const SAMPLE_NOTES = {
    'juniper outfitters': { name: 'Juniper Outfitters', text: 'Free returns in store. By mail they keep $6.95 for the label.', at: 1 },
    'northwind home': { name: 'Northwind Home', text: 'Keeps the shipping fee. Ask for a return code at the till.', at: 1 },
  };

  return {
    LIMITS, INVISIBLE, WINDOW_PRESETS, HOW, HOW_IDS, howLabel, DECISIONS, REFUND_KINDS, STEP_IDS, STATES, FILTERS, CURRENCIES, CONFIDENCE, CSV_HEAD, SAMPLE_NOTES,
    line, plain, para, esc, plural, stripLinks, plainOut, isId, hasWord,
    isDay, dayMs, addDays, daysBetween, weekday, addBusinessDays, shortDay, fmtDay, monthKey, monthLabel, localDay,
    currencyFor, isCurrency, money, decimal, readMoney, cents, cleanUrl,
    cleanWindow, returnBy, windowLabel, cleanPurchase, newPurchases, stateOf, isOpen, daysLeft, urgency, lateDays, statusOf, refundWord,
    stepsFor, nextStep, decide, setStep, setExpectBy, recordRefund, clearRefund, overdueLine, followUpText,
    byNeed, filterList, summary, nudges, tally, topStores, lastMonths,
    storeKey, storesUsed, lastWindowFor, cleanNotes, noteFor,
    reminderOptions, icsText, icsFold, buildIcs,
    csvCell, toCsv, purchasesCsv, parseCsv, fromCsv,
    syncPayload, cleanTombstones, cleanList, mergeLists, listBytes,
    receiptRequest, luhn, hasCardLike, cleanReceipt,
    sample,
  };
}));
