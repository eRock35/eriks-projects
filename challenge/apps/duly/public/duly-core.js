/* Duly - the rules, in one file. Every bill on time - without paying them
 * yourself.
 *
 * Run three times: by the page (window.DulyCore), by the server and by the
 * tests (require). UMD, no dependencies, no clock of its own: every function
 * that needs "today" is handed it as a 'YYYY-MM-DD' string in the viewer's own
 * day, so the same bill is due on the same date on every phone and the tests
 * can stand on any day they like (a leap day, a month end, a DST weekend).
 *
 * What is here:
 *   - cleaning: one door for every typed string (no markup, no control or
 *     bidi characters, bounded, cut on a whole character);
 *   - the account-number rule: a field named like one, or a value shaped like
 *     one, is refused with a sentence; text from a model is stripped of them;
 *   - the category guess: a fixed keyword map, "City Power" -> electric;
 *   - a bill: cleanBill, its cycle (monthly on day N, every N months, yearly,
 *     per statement) and the dates it falls due, across month ends and leap
 *     years, in whole calendar days (so a clock change never moves one);
 *   - AutoPay health and the generic "Turn on AutoPay" checklists;
 *   - the month: what is due, paid, overdue, and what is still to come;
 *   - amounts over time: the median, the "higher than usual" rule, alerts;
 *   - the calendar file (.ics): recurring events with a reminder;
 *   - the sample household for the first run.
 *
 * Duly never pays anything, never signs in anywhere and never holds a
 * password or an account number. Nothing in this file knows how to.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DulyCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = {
    payee: 48,         // "Brightwater Electric & Gas"
    note: 140,         // "Paid from the joint account"
    bills: 120,        // one household
    history: 36,       // amounts kept per bill (three years of monthly bills)
    paid: 48,          // "marked paid" dates kept per bill
    dates: 24,         // statement due dates kept per bill
    maxCents: 100000000, // $1,000,000.00
    soonDays: 7,       // "due soon" is the next seven days
    pastDays: 3650,    // a logged amount may be up to ten years old
    pasteChars: 20000, // a pasted statement
  };
  const DAY_MS = 86400000;

  /* ------------------------------------------------------------------ *
   * Cleaning
   * ------------------------------------------------------------------ */

  // Control characters and the bidi overrides and isolates. The zero-width
  // joiner stays: emoji need it.
  const STRIP = /[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

  /** One line of untrusted text: no markup, no control or bidi characters,
   *  single spaces, at most `max` characters. Cut before any pattern runs,
   *  so hostile input costs linear time. */
  function clean(v, max) {
    let s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 200) s = s.slice(0, max * 4 + 200);
    s = s.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
    return s;
  }
  /** The same, but it has to say something: a letter, a digit or an emoji. */
  function cleanText(v, max) {
    const s = clean(v, max);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  function fold(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function fail(status, message, extra) {
    return Object.assign(new Error(message), { status, expose: true }, extra || {});
  }

  /* ------------------------------------------------------------------ *
   * Account numbers: never kept.
   *
   * Two rules, both deliberately blunt:
   *   - a FIELD named like an account, card, routing or sort-code number (or
   *     a password or PIN) is refused, whatever it holds;
   *   - a VALUE with eight or more digits in a row (spaces and dashes between
   *     them allowed) is refused. Dates (2026-10-14, 10/14/2026) and phone
   *     numbers written the usual ways ((555) 010-1234, 1-800-555-0100,
   *     555.010.1234) are read first and left alone; "ending 4421" is fine.
   * Text a model sends back is not refused but stripped (stripAccountNumbers),
   * and the server strips a pasted statement before the model sees it.
   * ------------------------------------------------------------------ */

  const ACCOUNT_FIELD_RE = /acc(?:oun)?t|acct|routing|\biban\b|^iban|sort.?code|card.?(?:num|no\b|#)|^pan$|^cvv|^cvc|^ssn$|social.?security|passw(?:or)?d|passcode|^pin$|login|username/i;
  const REFUSAL = 'Duly never keeps account, card or routing numbers - leave that out. “Ending 4421” is fine.';
  const SAFE_SHAPES = [
    /\b\d{4}-\d{2}-\d{2}\b/g,                                        // 2026-10-14
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,                                // 10/14/2026
    /(?:\+?1[\s.-])?\(\d{3}\)\s?\d{3}[\s.-]\d{4}\b/g,                  // (555) 010-1234
    /\b(?:\+?1[\s.-])?\d{3}[.-]\d{3}[.-]\d{4}\b/g,                    // 1-800-555-0100, 555.010.1234
  ];
  const LONG_DIGITS = /\d(?:[ -]?\d){7,}/g;

  /** Does this text carry something shaped like an account or card number? */
  function hasAccountNumber(v) {
    if (typeof v !== 'string') return false;
    let s = v.slice(0, 50000);
    for (const re of SAFE_SHAPES) s = s.replace(re, ' ');
    LONG_DIGITS.lastIndex = 0;
    return LONG_DIGITS.test(s);
  }
  /** The same text with anything account-shaped taken out (for model output
   *  and a pasted statement). Dates and phone numbers stay. */
  function stripAccountNumbers(v) {
    if (typeof v !== 'string') return { text: '', stripped: false };
    const keep = [];
    let s = v.slice(0, 50000);
    for (const re of SAFE_SHAPES) s = s.replace(re, (m) => { keep.push(m); return `\u0001${keep.length - 1}\u0001`; });
    let stripped = false;
    s = s.replace(LONG_DIGITS, () => { stripped = true; return '[number removed]'; });
    s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => keep[Number(i)]);
    return { text: s, stripped };
  }
  /** Any key, at any depth, named like an account number. Returns its name. */
  function accountField(obj, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 3) return null;
    for (const k of Object.keys(obj).slice(0, 80)) {
      if (ACCOUNT_FIELD_RE.test(k)) return k;
      const v = obj[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) { const hit = accountField(v, (depth || 0) + 1); if (hit) return hit; }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Calendar days. Every date is a civil 'YYYY-MM-DD' and the sums are done
   * on UTC midnights, so a daylight-saving change (a 23- or 25-hour day in
   * the viewer's zone) can never move a due date or miscount a gap.
   * ------------------------------------------------------------------ */

  function isDay(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    return y >= 1970 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
  }
  const dayMs = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / DAY_MS); }
  function addDays(day, n) { return fromMs(dayMs(day) + n * DAY_MS); }
  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function daysInMonth(y, m) { return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
  const pad = (n) => String(n).padStart(2, '0');
  function ymd(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
  /** Day `d` of a month, or the month's last day when it is shorter. */
  function clampDay(y, m, d) { return ymd(y, m, Math.min(d, daysInMonth(y, m))); }
  /** 'YYYY-MM' n months on. */
  function addMonths(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const i = y * 12 + (m - 1) + n;
    return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
  }
  const monthIndex = (ym) => { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); };
  const ymOf = (day) => day.slice(0, 7);
  /** The viewer's own day, from a Date, in their zone. */
  function localDay(date) { return ymd(date.getFullYear(), date.getMonth() + 1, date.getDate()); }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function weekday(day) { return new Date(dayMs(day)).getUTCDay(); }
  function ordinal(n) {
    const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    return n + s;
  }
  /** "Oct 14", or "Oct 14, 2027" outside today's year. */
  function fmtDay(day, today) {
    if (!isDay(day)) return '';
    const [y, m, d] = day.split('-').map(Number);
    return `${MONTHS[m - 1]} ${d}${today && today.slice(0, 4) !== String(y) ? `, ${y}` : ''}`;
  }
  function fmtMonth(ym) { const [y, m] = ym.split('-').map(Number); return `${MONTHS_LONG[m - 1]} ${y}`; }
  /** "today", "tomorrow", "in 5 days", "yesterday", "3 days ago". */
  function relDay(day, today) {
    const n = daysBetween(today, day);
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    return n > 0 ? `in ${n} days` : `${-n} days ago`;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* ------------------------------------------------------------------ *
   * Money, in whole cents.
   * ------------------------------------------------------------------ */

  /** "$1,240.50" -> 124050, "about 40" -> 4000, "free" / "" -> null.
   *  A minus sign or brackets are refused (a bill is never negative here). */
  function parseMoney(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v * 100 <= LIMITS.maxCents ? Math.round(v * 100) : null;
    if (typeof v !== 'string') return null;
    const s = v.slice(0, 40).trim();
    if (/^\(|^-|-\s*\$|\$\s*-/.test(s)) return null;
    const m = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(s);
    if (!m) return null;
    const cents = Number(m[1].replace(/,/g, '')) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
    return Number.isFinite(cents) && cents <= LIMITS.maxCents ? cents : null;
  }
  function cleanCents(v) {
    return Number.isInteger(v) && v >= 0 && v <= LIMITS.maxCents ? v : null;
  }
  /** 124050 -> "$1,240.50"; whole dollars keep their cents ("$70.00"). */
  function fmtMoney(cents, opts) {
    if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
    const neg = cents < 0;
    const c = Math.abs(Math.round(cents));
    const dollars = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const out = opts && opts.round ? `$${Math.round(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}` : `$${dollars}.${pad(c % 100)}`;
    return (neg ? '-' : '') + out;
  }
  function median(list) {
    const a = list.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
  }

  /* ------------------------------------------------------------------ *
   * Categories and the guess. A fixed keyword map, read in a fixed order of
   * precedence ("car insurance" is insurance, "credit card" is a card).
   * ------------------------------------------------------------------ */

  const CATEGORIES = [
    { id: 'electric', label: 'Electric', emoji: '⚡' },
    { id: 'gas', label: 'Gas & heating', emoji: '🔥' },
    { id: 'water', label: 'Water & trash', emoji: '💧' },
    { id: 'internet', label: 'Internet', emoji: '📶' },
    { id: 'phone', label: 'Phone', emoji: '📱' },
    { id: 'card', label: 'Credit card', emoji: '💳' },
    { id: 'home', label: 'Mortgage or rent', emoji: '🏠' },
    { id: 'insurance', label: 'Insurance', emoji: '🛡️' },
    { id: 'car', label: 'Car', emoji: '🚗' },
    { id: 'streaming', label: 'Streaming', emoji: '🎬' },
    { id: 'other', label: 'Other', emoji: '🧾' },
  ];
  const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
  const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
  const KEYWORDS = [
    ['card', ['credit card', 'card', 'visa', 'mastercard', 'amex', 'american express', 'discover', 'store card', 'charge card']],
    ['home', ['mortgage', 'rent', 'landlord', 'lease', 'hoa', 'home loan', 'housing', 'apartment', 'apartments', 'condo', 'property management', 'escrow']],
    ['insurance', ['insurance', 'insure', 'insurer', 'assurance', 'policy', 'premium', 'life cover', 'renters', 'homeowners']],
    ['car', ['car', 'auto', 'vehicle', 'motors', 'car loan', 'auto loan', 'lease car', 'toll', 'tolls', 'parking', 'garage', 'dmv']],
    ['streaming', ['streaming', 'netflix', 'hulu', 'spotify', 'disney', 'youtube', 'peacock', 'paramount', 'prime video', 'music', 'tv', 'video', 'movies', 'plus', 'podcast']],
    ['internet', ['internet', 'broadband', 'fiber', 'fibre', 'wifi', 'wi fi', 'cable', 'isp', 'dsl', 'satellite']],
    ['phone', ['phone', 'mobile', 'cell', 'cellular', 'wireless', 'telecom', 'landline']],
    ['electric', ['electric', 'electricity', 'power', 'energy', 'light', 'solar', 'utility', 'utilities']],
    ['gas', ['gas', 'propane', 'heating', 'heating oil', 'oil', 'natural gas', 'fuel']],
    ['water', ['water', 'sewer', 'sewage', 'trash', 'garbage', 'waste', 'recycling', 'refuse', 'sanitation']],
  ];

  /** The category a payee's words suggest, or null. Whole words only:
   *  "Carmen's cleaning" is not a car. */
  function guessCategory(payee) {
    const words = ` ${fold(payee)} `;
    if (words.trim() === '') return null;
    for (const [id, keys] of KEYWORDS) {
      for (const k of keys) if (words.includes(` ${k} `)) return id;
    }
    return null;
  }
  function categoryOf(id) { return CAT[id] || CAT.other; }

  /* ------------------------------------------------------------------ *
   * A bill
   *
   * {id, payee, category, amount (cents|null), varies, cycle, pay, note,
   *  history: [{d, a}], paid: [day], since, createdAt, updatedAt, sample?}
   *
   * cycle is one of:
   *   {kind: 'monthly', day: 1..31}
   *   {kind: 'months', every: 2..12, day: 1..31, anchor: 'YYYY-MM'}
   *   {kind: 'yearly', month: 1..12, day: 1..31}
   *   {kind: 'statement', dates: [day...]}   (a due date entered per cycle)
   * A day past the month's end means "or the month's last day".
   * pay is 'auto' (AutoPay on), 'off' (AutoPay off) or 'manual' (I pay it).
   * ------------------------------------------------------------------ */

  const PAY = ['auto', 'off', 'manual'];
  const PAY_LABEL = { auto: 'AutoPay on', off: 'AutoPay off', manual: 'I pay by hand' };
  const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
  const SAVED_FIELDS = ['id', 'payee', 'category', 'amount', 'varies', 'cycle', 'pay', 'note', 'history', 'paid', 'since', 'createdAt', 'updatedAt'];

  const int = (v, lo, hi) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi && v !== '' && v !== null ? Number(v) : null);

  function cleanCycle(c, today) {
    if (!c || typeof c !== 'object') return null;
    if (c.kind === 'monthly') { const day = int(c.day, 1, 31); return day ? { kind: 'monthly', day } : null; }
    if (c.kind === 'months') {
      const every = int(c.every, 2, 12); const day = int(c.day, 1, 31);
      const anchor = typeof c.anchor === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(c.anchor) ? c.anchor : null;
      return every && day && anchor ? { kind: 'months', every, day, anchor } : null;
    }
    if (c.kind === 'yearly') { const month = int(c.month, 1, 12); const day = int(c.day, 1, 31); return month && day && day <= daysInMonth(2024, month) ? { kind: 'yearly', month, day } : null; }
    if (c.kind === 'statement') {
      const lo = addDays(today, -LIMITS.pastDays); const hi = addDays(today, 400);
      const dates = [...new Set((Array.isArray(c.dates) ? c.dates : []).slice(0, 200).filter((d) => isDay(d) && d >= lo && d <= hi))].sort().slice(-LIMITS.dates);
      return { kind: 'statement', dates };
    }
    return null;
  }

  /**
   * The one door for a bill: typed, synced, proposed or the sample. Throws a
   * 400 with REFUSAL when anything carries an account number; returns null
   * when there is no bill (no payee, no cycle).
   */
  function cleanBill(raw, today, opts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const field = accountField(raw);
    if (field) throw fail(400, REFUSAL, { code: 'account-number', field: clean(field, 30) });
    for (const k of ['payee', 'note']) if (hasAccountNumber(raw[k])) throw fail(400, REFUSAL, { code: 'account-number', field: k });
    const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
    if (!id) return null;
    const payee = cleanText(raw.payee, LIMITS.payee);
    const cycle = cleanCycle(raw.cycle, today);
    if (!payee || !cycle) return null;
    const category = CATEGORY_IDS.includes(raw.category) ? raw.category : (guessCategory(payee) || 'other');
    const varies = raw.varies === true;
    const amount = varies ? null : cleanCents(raw.amount);
    const pay = PAY.includes(raw.pay) ? raw.pay : 'manual';
    const note = cleanText(raw.note, LIMITS.note);
    const lo = addDays(today, -LIMITS.pastDays); const hi = addDays(today, 400);
    const seen = new Map();
    for (const h of (Array.isArray(raw.history) ? raw.history : []).slice(0, 400)) {
      if (!h || !isDay(h.d) || h.d < lo || h.d > hi) continue;
      const a = cleanCents(h.a);
      if (a === null) continue;
      seen.set(h.d, a);
    }
    const history = [...seen.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).slice(-LIMITS.history).map(([d, a]) => ({ d, a }));
    const paid = [...new Set((Array.isArray(raw.paid) ? raw.paid : []).slice(0, 400).filter((d) => isDay(d) && d >= lo && d <= hi))].sort().slice(-LIMITS.paid);
    const since = isDay(raw.since) && raw.since <= today ? raw.since : today;
    const num = (v) => (Number.isFinite(v) && v >= 0 && v < 1e14 ? Math.round(v) : 0);
    const out = { id, payee, category, amount, varies, cycle, pay, note, history, paid, since, createdAt: num(raw.createdAt), updatedAt: num(raw.updatedAt) };
    if (opts && opts.keepSample && raw.sample === true) out.sample = true;
    return out;
  }
  /** What an account keeps of a bill: its own fields, never the sample flag. */
  function toSaved(b) {
    const out = {};
    for (const k of SAVED_FIELDS) out[k] = b[k];
    return out;
  }
  function emojiOf(b) { return categoryOf(b && b.category).emoji; }

  /** "Monthly on the 14th", "Every 3 months on the 5th", "Yearly on Mar 2",
   *  "Per statement". */
  function describeCycle(c) {
    if (!c) return '';
    const dayWord = (d) => (d >= 29 ? `${ordinal(d)} (or the month’s last day)` : ordinal(d));
    if (c.kind === 'monthly') return `Monthly on the ${dayWord(c.day)}`;
    if (c.kind === 'months') return `Every ${c.every} months on the ${dayWord(c.day)}`;
    if (c.kind === 'yearly') return `Yearly on ${MONTHS[c.month - 1]} ${c.day}${c.month === 2 && c.day === 29 ? ' (Feb 28 in other years)' : ''}`;
    return 'Due date from each statement';
  }

  /** Every due date of a bill from `from` to `to`, inclusive, in order. */
  function occurrences(bill, from, to) {
    const c = bill && bill.cycle;
    if (!c || !isDay(from) || !isDay(to) || to < from) return [];
    if (c.kind === 'statement') return c.dates.filter((d) => d >= from && d <= to);
    const out = [];
    const first = monthIndex(ymOf(from));
    const last = Math.min(monthIndex(ymOf(to)), first + 12 * 50);
    for (let i = first; i <= last; i++) {
      const y = Math.floor(i / 12); const m = (i % 12) + 1;
      let day = null;
      if (c.kind === 'monthly') day = clampDay(y, m, c.day);
      else if (c.kind === 'months') { const diff = i - monthIndex(c.anchor); if (((diff % c.every) + c.every) % c.every === 0) day = clampDay(y, m, c.day); }
      else if (c.kind === 'yearly') { if (m === c.month) day = clampDay(y, m, c.day); }
      if (day && day >= from && day <= to) out.push(day);
    }
    return out;
  }
  /** The next due date on or after today, or null (a statement with no
   *  future date entered). */
  function nextDue(bill, today) { return occurrences(bill, today, addDays(today, 400))[0] || null; }
  /** The last due date before today, or null. */
  function lastDue(bill, today) { const o = occurrences(bill, addDays(today, -400), addDays(today, -1)); return o[o.length - 1] || null; }
  /** Average monthly cost, for the household's total. */
  function perMonth(bill, today) {
    const t = typical(bill);
    if (t === null) return null;
    const c = bill.cycle;
    if (c.kind === 'monthly') return t;
    if (c.kind === 'months') return Math.round(t / c.every);
    if (c.kind === 'yearly') return Math.round(t / 12);
    const d = c.dates.filter((x) => x <= addDays(today, 60));
    if (d.length >= 2) { const span = daysBetween(d[0], d[d.length - 1]) / (d.length - 1); return span > 0 ? Math.round(t * 30.44 / span) : t; }
    return t;
  }

  /* ------------------------------------------------------------------ *
   * Amounts over time
   * ------------------------------------------------------------------ */

  /** What a bill usually is: its fixed amount, or the median of what it has
   *  been (the last 12). */
  function typical(bill) {
    if (!bill) return null;
    if (!bill.varies && bill.amount !== null && bill.amount !== undefined) return bill.amount;
    return median((bill.history || []).slice(-12).map((h) => h.a));
  }
  /** What one cycle comes to: the logged amount, else the typical one. */
  function amountFor(bill, day) {
    const h = (bill.history || []).find((x) => x.d === day);
    return h ? h.a : typical(bill);
  }
  function lastAmount(bill) { const h = bill.history || []; return h.length ? h[h.length - 1].a : null; }

  /**
   * Every logged amount, with the "higher than usual" rule: more than `pct`
   * percent over the bill's own median. The median is of the amounts BEFORE
   * that one (the last 12), so one jump does not drag its own baseline up;
   * with fewer than two before it, a fixed bill is judged against its typed
   * amount and a varying one is not judged at all.
   */
  function amountFlags(bill, pct) {
    const p = Number.isFinite(pct) ? pct : 20;
    const h = bill.history || [];
    return h.map((e, i) => {
      const prior = h.slice(Math.max(0, i - 12), i).map((x) => x.a);
      let base = prior.length >= 2 ? median(prior) : (!bill.varies && bill.amount ? bill.amount : null);
      if (base !== null && base <= 0) base = null;
      const high = base !== null && e.a > base * (1 + p / 100);
      return { d: e.d, a: e.a, base, high, over: base ? Math.round(((e.a - base) / base) * 100) : null };
    });
  }

  /* ------------------------------------------------------------------ *
   * AutoPay health and the checklists. Generic steps by category - never a
   * claim about where a particular company keeps its settings.
   * ------------------------------------------------------------------ */

  function health(bills) {
    const list = bills || [];
    const on = list.filter((b) => b.pay === 'auto');
    const off = list.filter((b) => b.pay !== 'auto');
    const score = list.length ? Math.round((on.length / list.length) * 100) : 0;
    return { on: on.length, total: list.length, score, off, words: list.length ? `${on.length} of ${plural(list.length, 'bill')} on AutoPay` : 'No bills yet' };
  }

  const STEPS_UTILITY = [
    'Open the provider’s app or website and sign in there - look under Billing or Payments.',
    'Find AutoPay (it may be called automatic payments or recurring payments) and switch it on.',
    'Pick your checking account to pay from. Some providers charge a fee for paying by card - check before you choose one.',
    'Note the day it will take the money - usually on or a few days before the due date.',
  ];
  const STEPS = {
    card: [
      'In the card’s app or website, find AutoPay under Payments.',
      'Choose to pay the statement balance - not the minimum. Paying the minimum on AutoPay keeps the bill “on time” while interest builds up.',
      'Pay it from your checking account.',
      'If you are carrying a balance, the minimum on AutoPay is a safety net while you pay the rest by hand - it beats a late fee.',
    ],
    home: [
      'Ask your landlord, property manager or lender whether they take automatic payments, and how.',
      'If they don’t: set up a recurring payment in your own bank’s bill pay, timed a few days before the due day so it lands in time.',
      'Keep the confirmation of the first one - rent is the bill you most want proof of.',
    ],
    insurance: [
      'In the insurer’s app or website, look under Billing or Payment options for automatic payments.',
      'Ask whether paying for the whole term at once costs less than monthly - some policies add a fee for instalments.',
      'The amount can change at each renewal. Duly will flag it when you log a higher one.',
    ],
    car: [
      'In the lender’s or leasing company’s account, look under Payments for automatic payments.',
      'If you can choose the day, put it a few days after payday.',
      'For tolls and parking, check which card the account charges and that it isn’t about to expire.',
    ],
    streaming: [
      'These usually charge a card automatically already - check which card, and that it isn’t about to expire.',
      'If you have stopped watching or listening, cancelling beats paying on time.',
    ],
    other: [
      'Look in the company’s app or website under Billing or Payments for automatic payments.',
      'If they don’t offer it, set up a recurring payment in your own bank’s bill pay, a few days before the due date.',
    ],
  };
  const HONEST = [
    'Keep a buffer in the account it pays from, enough for the biggest bill you expect - an AutoPay into an empty account is still a missed payment, plus a fee.',
    'Watch the first payment: check it went through, from the right account, for the right amount.',
    'Duly can’t switch it on for you, and will never ask for your login.',
  ];
  /** The "Turn on AutoPay" card for one bill. */
  function checklist(bill) {
    const cat = bill && bill.category;
    const steps = (['electric', 'gas', 'water', 'internet', 'phone'].includes(cat) ? STEPS_UTILITY : STEPS[cat] || STEPS.other).slice();
    const notes = HONEST.slice();
    if (bill && bill.pay === 'manual') notes.push('Rather pay it by hand? Leave it on “I pay by hand” - Duly will tell you when it’s due and if it’s late.');
    return { title: `Turn on AutoPay for ${bill ? bill.payee : 'this bill'}`, steps, notes };
  }

  /* ------------------------------------------------------------------ *
   * The month and its words
   * ------------------------------------------------------------------ */

  /**
   * One due date of one bill:
   *   paid    - marked paid, or on AutoPay and the day has come (assumed paid
   *             on the due date), or a date before the bill was added;
   *   today   - due today and not paid;
   *   overdue - a past due date on a bill not on AutoPay, not marked paid;
   *   soon    - within the next seven days;
   *   later   - the rest.
   */
  function dueStatus(bill, day, today) {
    if ((bill.paid || []).includes(day)) return { status: 'paid', how: 'marked' };
    if (day < (bill.since || '0000')) return { status: 'paid', how: 'before' };
    if (bill.pay === 'auto' && day <= today) return { status: 'paid', how: 'auto' };
    if (day === today) return { status: 'today' };
    if (day < today) return { status: 'overdue' };
    if (daysBetween(today, day) <= LIMITS.soonDays) return { status: 'soon' };
    return { status: 'later' };
  }
  function statusWords(s, day, today) {
    if (s.status === 'paid') return s.how === 'auto' ? 'Paid by AutoPay (assumed)' : s.how === 'before' ? 'Before you added it' : 'Marked paid';
    if (s.status === 'today') return 'Due today';
    if (s.status === 'overdue') { const n = daysBetween(day, today); return `${plural(n, 'day')} late`; }
    if (s.status === 'soon') return `Due ${relDay(day, today)}`;
    return `Due ${fmtDay(day, today)}`;
  }

  /** Every due date in one month ('YYYY-MM'), with totals. Amounts that are
   *  not known (a varying bill with no history) are counted, not guessed. */
  function monthView(bills, ym, today) {
    const from = `${ym}-01`;
    const [y, m] = ym.split('-').map(Number);
    const to = ymd(y, m, daysInMonth(y, m));
    const items = [];
    for (const b of bills || []) {
      for (const day of occurrences(b, from, to)) {
        const s = dueStatus(b, day, today);
        items.push({ id: b.id, day, amount: amountFor(b, day), logged: (b.history || []).some((h) => h.d === day), ...s });
      }
    }
    const order = { overdue: 0, today: 1, soon: 2, later: 3, paid: 4 };
    items.sort((a, b) => (order[a.status] - order[b.status]) || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const sum = (list) => list.reduce((n, x) => n + (x.amount || 0), 0);
    const open = items.filter((x) => x.status !== 'paid');
    return {
      ym, from, to, items,
      total: sum(items), toCome: sum(open), paid: sum(items.filter((x) => x.status === 'paid')),
      unknown: items.filter((x) => x.amount === null).length,
      counts: Object.fromEntries(Object.keys(order).map((k) => [k, items.filter((x) => x.status === k).length])),
    };
  }
  /** The month grid: weeks of 7 cells (Sunday first), null outside the month. */
  function monthGrid(ym) {
    const [y, m] = ym.split('-').map(Number);
    const lead = weekday(ymd(y, m, 1));
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth(y, m); d++) cells.push(ymd(y, m, d));
    while (cells.length % 7) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }

  /** Bills in due order, from today: the next one each. */
  function upcoming(bills, today, days) {
    const until = addDays(today, days || 30);
    const out = [];
    for (const b of bills || []) {
      for (const day of occurrences(b, addDays(today, -45), until)) {
        const s = dueStatus(b, day, today);
        if (s.status === 'paid') continue;
        out.push({ id: b.id, day, amount: amountFor(b, day), ...s });
      }
    }
    return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }

  /**
   * What Duly speaks up about - and only this: a bill that is WRONG (higher
   * than usual), LATE (a past due date not paid), NEW (added in the last two
   * weeks, or its first amount), DUE with nothing paying it, a statement bill
   * with no due date entered, and bills NOT ON AUTOPAY (one line).
   */
  function alerts(bills, today, opts) {
    const pct = opts && Number.isFinite(opts.spikePct) ? opts.spikePct : 20;
    const nowMs = opts && Number.isFinite(opts.nowMs) ? opts.nowMs : dayMs(today);
    const out = [];
    for (const b of bills || []) {
      const flags = amountFlags(b, pct);
      const last = flags[flags.length - 1];
      if (last && last.high && daysBetween(last.d, today) <= 60) {
        out.push({ kind: 'high', id: b.id, rank: 1, day: last.d, title: `${b.payee} is higher than usual`, text: `${fmtMoney(last.a)} for ${fmtDay(last.d, today)} - ${last.over}% over its usual ${fmtMoney(last.base)}. Worth a look before it’s paid.` });
      }
      const late = occurrences(b, addDays(today, -45), addDays(today, -1)).filter((d) => dueStatus(b, d, today).status === 'overdue');
      if (late.length) {
        const d = late[late.length - 1];
        out.push({ kind: 'late', id: b.id, rank: 0, day: d, title: `${b.payee} looks late`, text: `It was due ${fmtDay(d, today)} (${relDay(d, today)}) and isn’t marked paid. Paid it already? Mark it paid.` });
      }
      const nx = nextDue(b, today);
      if (b.pay !== 'auto' && nx && daysBetween(today, nx) <= 3 && dueStatus(b, nx, today).status !== 'paid') {
        out.push({ kind: 'due', id: b.id, rank: 2, day: nx, title: `${b.payee} is due ${relDay(nx, today)}`, text: `${b.pay === 'manual' ? 'You pay this one by hand' : 'AutoPay is off for this one'} - ${amountFor(b, nx) !== null ? fmtMoney(amountFor(b, nx)) : 'the amount varies'}.` });
      }
      if (b.cycle.kind === 'statement' && !nx) {
        out.push({ kind: 'date', id: b.id, rank: 3, title: `${b.payee}: when is this statement due?`, text: 'It’s a statement-based bill and no upcoming due date is entered. Add it from the statement.' });
      }
      const ageDays = b.createdAt ? Math.floor((nowMs - b.createdAt) / DAY_MS) : null;
      const isNew = (ageDays !== null && ageDays >= 0 && ageDays <= 14) || ((b.history || []).length === 1 && daysBetween(b.history[0].d, today) <= 31 && daysBetween(b.history[0].d, today) >= -31);
      if (isNew) {
        const t = typical(b);
        out.push({ kind: 'new', id: b.id, rank: 4, title: `New bill: ${b.payee}`, text: `${t !== null ? fmtMoney(t) + ' · ' : ''}${describeCycle(b.cycle)}. Expected? If not, it’s worth a call.` });
      }
    }
    const h = health(bills);
    if (h.off.length) out.push({ kind: 'autopay', rank: 5, title: `${plural(h.off.length, 'bill')} ${h.off.length === 1 ? 'isn’t' : 'aren’t'} on AutoPay`, text: h.off.slice(0, 3).map((b) => b.payee).join(', ') + (h.off.length > 3 ? ` and ${h.off.length - 3} more` : '') + '. See how to turn it on.' });
    return out.sort((a, b) => a.rank - b.rank || ((a.day || '') < (b.day || '') ? -1 : 1));
  }

  /* ------------------------------------------------------------------ *
   * The calendar file (RFC 5545). All-day events, so a time zone or a clock
   * change can never move a due date; a recurring rule per bill (a statement
   * bill: one event per entered date); a reminder N days before at 9 am.
   * The device's own calendar does the rest - nothing in the cloud writes
   * any calendar.
   * ------------------------------------------------------------------ */

  /** TEXT values: backslash, semicolon, comma and newlines escaped. */
  function icsText(v) {
    return String(v === null || v === undefined ? '' : v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
  }
  /** Lines folded at 75 octets (UTF-8), never inside a character. */
  function icsFold(line) {
    const out = [];
    let cur = ''; let bytes = 0; let limit = 75;
    for (const ch of Array.from(line)) {
      const n = utf8Len(ch);
      if (bytes + n > limit) { out.push(cur); cur = ' '; bytes = 1; limit = 75; }
      cur += ch; bytes += n;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  function utf8Len(ch) { const c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  const compact = (day) => day.replace(/-/g, '');
  function stampOf(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
  /** BYMONTHDAY for "day N, or the month's last day when it is shorter". */
  function byMonthDay(d) {
    if (d <= 28) return `BYMONTHDAY=${d}`;
    const days = []; for (let i = 28; i <= d; i++) days.push(i);
    return `BYMONTHDAY=${days.join(',')};BYSETPOS=-1`;
  }
  /** The RRULE for a bill, or null (a statement bill repeats by its dates). */
  function rrule(c) {
    if (c.kind === 'monthly') return `FREQ=MONTHLY;${byMonthDay(c.day)}`;
    if (c.kind === 'months') return `FREQ=MONTHLY;INTERVAL=${c.every};${byMonthDay(c.day)}`;
    if (c.kind === 'yearly') return c.month === 2 && c.day === 29 ? 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1' : `FREQ=YEARLY;BYMONTH=${c.month};BYMONTHDAY=${c.day}`;
    return null;
  }
  function alarm(n, what) {
    // TRIGGER is relative to the event's start, midnight of the due day:
    // n days before at 9:00 is -(n-1) days and 15 hours; the day itself at
    // 9:00 is +9 hours.
    const trig = n > 0 ? `-P${n - 1 ? `${n - 1}D` : ''}T15H` : 'PT9H';
    return ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(what)}`, `TRIGGER:${trig}`, 'END:VALARM'];
  }
  /**
   * @param bills  the bills to include
   * @param o      {today, nowMs, remindDays (0-14), name}
   * @returns      the .ics file's text, CRLF line endings
   */
  function buildIcs(bills, o) {
    const today = o.today;
    const n = Number.isInteger(o.remindDays) && o.remindDays >= 0 && o.remindDays <= 14 ? o.remindDays : 3;
    const stamp = stampOf(o.nowMs);
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Duly//Bill due dates//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(o.name || 'Bills (Duly)')}`];
    for (const b of bills || []) {
      const t = typical(b);
      const how = b.pay === 'auto' ? 'AutoPay is on - check it went through.' : b.pay === 'off' ? 'AutoPay is off - pay it yourself.' : 'You pay this one by hand.';
      const summary = `${emojiOf(b)} ${b.payee} due${t !== null ? ` · ${fmtMoney(t)}` : ''}`;
      const desc = [how, describeCycle(b.cycle) + '.', b.note ? `Note: ${b.note}` : '', 'From Duly. Duly never pays bills and never holds account numbers.'].filter(Boolean).join('\n');
      const remind = `${b.payee} is due ${n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`}.${b.pay === 'auto' ? ' AutoPay is on.' : ' Not on AutoPay.'}`;
      const events = [];
      const rule = rrule(b.cycle);
      if (rule) {
        const start = nextDue(b, today);
        if (start) events.push({ uid: `${b.id}@duly`, day: start, rule });
      } else {
        for (const d of b.cycle.dates.filter((x) => x >= today)) events.push({ uid: `${b.id}-${compact(d)}@duly`, day: d, rule: null });
      }
      for (const e of events) {
        lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${compact(e.day)}`, `DTEND;VALUE=DATE:${compact(addDays(e.day, 1))}`);
        if (e.rule) lines.push(`RRULE:${e.rule}`);
        lines.push(`SUMMARY:${icsText(summary)}`, `DESCRIPTION:${icsText(desc)}`, 'TRANSP:TRANSPARENT', ...alarm(n, remind), 'END:VEVENT');
      }
    }
    lines.push('END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ *
   * The sample household: nine made-up bills with history, dated from
   * today, so every part of the app has something to show in one tap - one
   * amount spike, two bills not on AutoPay, one statement-based card, one
   * new bill. Every name is invented.
   * ------------------------------------------------------------------ */

  function sample(today, nowMs) {
    const [ty, tm, td] = today.split('-').map(Number);
    const ym = today.slice(0, 7);
    /** Due dates of a monthly bill on day `day`, `back` months back to now. */
    const monthsBack = (day, back) => { const out = []; for (let i = back; i >= 1; i--) out.push(clampDay(...addMonths(ym, -i).split('-').map(Number), day)); const cur = clampDay(ty, tm, day); if (cur <= today) out.push(cur); return out; };
    const hist = (days, amounts) => days.slice(-amounts.length).map((d, i) => ({ d, a: amounts[amounts.length - Math.min(days.length, amounts.length) + i] }));
    const since = addDays(today, -400);
    const created = nowMs - 200 * DAY_MS;
    const mk = (o) => ({ since, createdAt: created, updatedAt: created, paid: [], note: '', varies: false, amount: null, history: [], ...o, sample: true });
    // A monthly day close to today, so "due soon" and "due today" have something in them.
    const soonDay = ((td + 2 - 1) % 28) + 1;
    const rentDay = 1;
    const insurance = { kind: 'yearly', month: ((tm + 1) % 12) + 1, day: 2 };
    // Water: due four days ago and not paid yet, so the sample shows a late bill.
    const waterDue = addDays(today, -4);
    const water = { kind: 'months', every: 3, day: Number(waterDue.slice(8)), anchor: waterDue.slice(0, 7) };
    const card = (() => {
      const dates = [];
      for (let i = 5; i >= 1; i--) dates.push(clampDay(...addMonths(ym, -i).split('-').map(Number), 9 + (i % 3)));
      const next = addDays(today, 12);
      dates.push(next);
      return dates;
    })();
    const elecDays = monthsBack(14, 8);
    const netDays = monthsBack(soonDay, 8);
    const bills = [
      mk({ id: 'sample-electric', payee: 'Brightwater Electric', category: 'electric', varies: true, cycle: { kind: 'monthly', day: 14 }, pay: 'auto',
        history: hist(elecDays, [11240, 10480, 9620, 10150, 11290, 11820, 11260, 10870, 9980]), note: 'Budget billing is an option - ask them.' }),
      mk({ id: 'sample-gas', payee: 'Northgate Gas', category: 'gas', varies: true, cycle: { kind: 'monthly', day: 22 }, pay: 'auto',
        history: hist(monthsBack(22, 8), [4210, 3980, 3620, 3390, 3120, 2940, 3060, 3180, 3350]) }),
      mk({ id: 'sample-water', payee: 'Cedar Valley Water & Sewer', category: 'water', varies: true, cycle: water, pay: 'off',
        history: occurrences({ cycle: water }, addDays(today, -400), today).slice(-4).map((d, i, all) => ({ d, a: [8840, 9120, 10360, 9480].slice(-all.length)[i] })),
        paid: occurrences({ cycle: water }, addDays(today, -400), addDays(today, -5)) }),
      mk({ id: 'sample-internet', payee: 'Fibrelink Internet', category: 'internet', amount: 7000, cycle: { kind: 'monthly', day: soonDay }, pay: 'auto',
        history: hist(netDays, [7000, 7000, 7000, 7000, 7000, 7000, 7000, 9199]), note: 'Promo price ended?' }),
      mk({ id: 'sample-phone', payee: 'Cellwave Mobile', category: 'phone', amount: 8500, cycle: { kind: 'monthly', day: 18 }, pay: 'auto',
        history: hist(monthsBack(18, 6), [8500, 8500, 8500, 8500, 8500, 8500, 8500]) }),
      mk({ id: 'sample-card', payee: 'Harbor Rewards Card', category: 'card', varies: true, cycle: { kind: 'statement', dates: card }, pay: 'auto',
        history: card.slice(0, -1).map((d, i) => ({ d, a: [64210, 81975, 55340, 72018, 69402][i] })), note: 'AutoPay: statement balance, from checking.' }),
      mk({ id: 'sample-rent', payee: 'Maple Court Apartments (rent)', category: 'home', amount: 185000, cycle: { kind: 'monthly', day: rentDay }, pay: 'manual',
        history: hist(monthsBack(rentDay, 5), [185000, 185000, 185000, 185000, 185000, 185000]),
        paid: monthsBack(rentDay, 5), note: 'Landlord takes checks or the portal.' }),
      mk({ id: 'sample-insurance', payee: 'Steadfast Renters Insurance', category: 'insurance', amount: 16800, cycle: insurance, pay: 'auto',
        history: occurrences({ cycle: insurance }, addDays(today, -400), today).slice(-1).map((d) => ({ d, a: 15900 })) }),
      mk({ id: 'sample-streaming', payee: 'Streamio Plus', category: 'streaming', amount: 1549, cycle: { kind: 'monthly', day: 27 }, pay: 'auto',
        createdAt: nowMs - 6 * DAY_MS, since: addDays(today, -6), history: [] }),
    ];
    return bills.map((b) => cleanBill(b, today, { keepSample: true }));
  }

  return {
    LIMITS, DAY_MS, REFUSAL, CATEGORIES, CATEGORY_IDS, PAY, PAY_LABEL, ID_RE, SAVED_FIELDS, MONTHS, WEEKDAYS,
    clean, cleanText, fold, fail,
    hasAccountNumber, stripAccountNumbers, accountField,
    isDay, daysBetween, addDays, isLeap, daysInMonth, clampDay, addMonths, localDay, fmtDay, fmtMonth, relDay, plural, ordinal, weekday,
    parseMoney, cleanCents, fmtMoney, median,
    guessCategory, categoryOf, emojiOf,
    cleanCycle, cleanBill, toSaved, describeCycle, occurrences, nextDue, lastDue, perMonth,
    typical, amountFor, lastAmount, amountFlags,
    health, checklist, dueStatus, statusWords, monthView, monthGrid, upcoming, alerts,
    icsText, icsFold, rrule, buildIcs,
    sample,
  };
});
