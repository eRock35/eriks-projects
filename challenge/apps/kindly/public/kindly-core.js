/* Kindly - the rules, in one file. Never miss the people who matter - and
 * always know what to give.
 *
 * Run three times: by the page (window.KindlyCore), by the server and by the
 * tests (require). UMD, no dependencies, no clock and no dice of its own:
 * every function that needs "today" is handed it as a 'YYYY-MM-DD' string in
 * the viewer's own day, so the same birthday is the same number of days away
 * on every phone, and the tests can stand on any day they like (a leap day,
 * New Year's Eve, a daylight-saving weekend).
 *
 * What is here:
 *   - cleaning: one door for every typed string (no markup, no control or
 *     bidi characters, bounded, cut on a whole character), links (https only);
 *   - a person: name, relationship, their dates (birthday, anniversary, any
 *     custom day), a lead time, notes, budgets, ideas, a wishlist link;
 *   - the dates: the next time each falls, across year ends; Feb 29 on Feb 28
 *     or Mar 1 outside leap years (the person's choice); ages, years together
 *     and the milestones ("turns 40", "silver anniversary");
 *   - Coming up: the next 60 days, the countdown, when to start (the lead
 *     time) and when to order by for it to arrive;
 *   - gift ideas: idea -> bought -> given, "given before", and the no-repeat
 *     rule (does this idea look like something already given?);
 *   - budgets per occasion and what has been spent on it so far;
 *   - the calendar file (.ics): every date as a yearly event with a reminder
 *     at the person's lead time;
 *   - what "Gift ideas for them" may send (never the name) and the sample.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KindlyCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = {
    name: 40,          // "Grandma Rose"
    first: 24,         // a first name on a wishlist link
    label: 30,         // "Gotcha day"
    people: 150,       // one circle
    dates: 6,          // custom dates per person
    ideas: 80,         // ideas (and past gifts) per person
    idea: 100,         // "The blue Le Creuset mug from the market"
    link: 300,
    noteField: 120,    // each of sizes, likes, dislikes, allergies, other
    maxCents: 1000000, // $10,000.00
    leadMax: 60,       // days ahead a nudge may start
    leadDefault: 10,
    comingDays: 60,    // "Coming up" looks this far ahead
    shipDefault: 5,    // days an order takes to arrive, by default
    shipMax: 21,
    wishAdds: 30,      // ideas a friend may leave waiting on one link
    wishDays: 60,      // a wishlist link lasts this long
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
  /** A link someone typed or pasted: https only (a bare "www." gets it),
   *  no credentials, no spaces, bounded. Anything else is no link. */
  function cleanLink(v) {
    if (typeof v !== 'string') return '';
    let s = v.trim().replace(STRIP, '');
    if (!s || s.length > LIMITS.link) return '';
    if (/^www\./i.test(s)) s = 'https://' + s;
    if (!/^https:\/\/[^\s/?#@]+\.[^\s/?#@]+(?:[/?#][^\s]*)?$/i.test(s)) return '';
    if (/[<>"'`\\]/.test(s)) return '';
    return s;
  }
  /** The site a link goes to, for showing it ("etsy.com"). */
  function hostOf(link) {
    const m = /^https:\/\/([^/?#:]+)/i.exec(link || '');
    return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
  }

  /* ------------------------------------------------------------------ *
   * Calendar days. Every date is a civil 'YYYY-MM-DD' and the sums are done
   * on UTC midnights, so a daylight-saving change can never move a birthday
   * or miscount the days to it.
   * ------------------------------------------------------------------ */

  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function daysInMonth(y, m) { return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
  function isDay(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    return y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
  }
  const dayMs = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / DAY_MS); }
  function addDays(day, n) { return fromMs(dayMs(day) + n * DAY_MS); }
  const pad = (n) => String(n).padStart(2, '0');
  function ymd(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
  /** The viewer's own day, from a Date, in their zone. */
  function localDay(date) { return ymd(date.getFullYear(), date.getMonth() + 1, date.getDate()); }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function weekday(day) { return new Date(dayMs(day)).getUTCDay(); }
  /** "Oct 26", or "Oct 26, 2027" outside today's year. */
  function fmtDay(day, today) {
    if (!isDay(day)) return '';
    const [y, m, d] = day.split('-').map(Number);
    return `${MONTHS[m - 1]} ${d}${today && today.slice(0, 4) !== String(y) ? `, ${y}` : ''}`;
  }
  /** "March 14" - a date without its year. */
  function fmtMonthDay(m, d) { return `${MONTHS_LONG[m - 1]} ${d}`; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function ordinal(n) {
    const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    return n + s;
  }
  /** "Today", "Tomorrow", "in 9 days". */
  function countdown(n) { return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `in ${n} days`; }

  /* ------------------------------------------------------------------ *
   * Money, in whole cents.
   * ------------------------------------------------------------------ */

  /** "$1,240.50" -> 124050, "about 40" -> 4000, "free" / "" -> null.
   *  A minus sign or brackets are refused (a gift is never negative). */
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
  function cleanCents(v) { return Number.isInteger(v) && v >= 0 && v <= LIMITS.maxCents ? v : null; }
  /** 4250 -> "$42.50"; whole dollars drop the cents ("$40"). */
  function fmtMoney(cents) {
    if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
    const c = Math.abs(Math.round(cents));
    const dollars = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${cents < 0 ? '-' : ''}$${dollars}${c % 100 ? `.${pad(c % 100)}` : ''}`;
  }

  /* ------------------------------------------------------------------ *
   * A person
   * ------------------------------------------------------------------ */

  const RELATIONSHIPS = [
    { id: 'family', label: 'Family', emoji: '🏡' },
    { id: 'friend', label: 'Friend', emoji: '🫶' },
    { id: 'partner', label: 'Partner', emoji: '💞' },
    { id: 'work', label: 'Work', emoji: '💼' },
    { id: 'other', label: 'Other', emoji: '✨' },
  ];
  const REL_IDS = RELATIONSHIPS.map((r) => r.id);
  const REL = Object.fromEntries(RELATIONSHIPS.map((r) => [r.id, r]));
  const NOTE_FIELDS = ['sizes', 'likes', 'dislikes', 'allergies', 'other'];
  const NOTE_LABEL = { sizes: 'Sizes', likes: 'Likes', dislikes: 'Not for them', allergies: 'Allergies', other: 'Good to know' };
  const STATUSES = ['idea', 'bought', 'given'];
  const ID_RE = /^[A-Za-z0-9-]{4,40}$/;
  const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
  const SAVED_FIELDS = ['id', 'name', 'relationship', 'birthday', 'anniversary', 'dates', 'leadDays', 'budgets', 'notes', 'ideas', 'wish', 'createdAt', 'updatedAt'];

  const intIn = (v, lo, hi) => { const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v; return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
  const msOf = (v) => (Number.isFinite(v) && v > 0 && v < 8e15 ? Math.round(v) : null);

  /** A date as a person keeps it: a month and a day (Feb 29 allowed), an
   *  optional year, and for Feb 29 which day it is kept on in other years.
   *  A year that would put the date after today is dropped (an age cannot be
   *  known for a day that has not happened). */
  function cleanDate(raw, today) {
    if (!raw || typeof raw !== 'object') return null;
    const month = intIn(raw.month, 1, 12);
    const day = month ? intIn(raw.day, 1, daysInMonth(2000, month)) : null; // 2000 is a leap year: Feb 29 is a real date
    if (!month || !day) return null;
    let year = intIn(raw.year, 1900, 2200);
    if (year !== null && (!isLeap(year) && month === 2 && day === 29)) year = null;
    if (year !== null && today && ymd(year, month, day) > today) year = null;
    const out = { month, day, year };
    if (month === 2 && day === 29) out.leap = raw.leap === 'mar1' ? 'mar1' : 'feb28';
    return out;
  }
  function cleanCustom(raw, today) {
    const d = cleanDate(raw, today);
    const label = raw && cleanText(raw.label, LIMITS.label);
    const id = raw && typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
    if (!d || !label || !id) return null;
    return { id, label, ...d };
  }
  function cleanNotes(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const k of NOTE_FIELDS) out[k] = cleanText(r[k], LIMITS.noteField);
    out.hasEverything = r.hasEverything === true;
    return out;
  }
  function cleanIdea(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = cleanText(raw.text, LIMITS.idea);
    const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
    if (!text || !id) return null;
    const status = STATUSES.includes(raw.status) ? raw.status : 'idea';
    const price = raw.price === null || raw.price === undefined ? null : cleanCents(raw.price);
    const year = status === 'idea' ? null : intIn(raw.year, 1900, 2200);
    const occasion = status !== 'idea' && typeof raw.occasion === 'string' && /^(birthday|anniversary|[A-Za-z0-9-]{4,40})$/.test(raw.occasion) ? raw.occasion : null;
    return {
      id, text, link: cleanLink(raw.link), price, status,
      occasion, year: status === 'idea' ? null : year,
      from: raw.from === 'them' ? 'them' : raw.from === 'ai' ? 'ai' : 'me',
      addedAt: msOf(raw.addedAt), doneAt: status === 'idea' ? null : msOf(raw.doneAt),
    };
  }
  function cleanBudgets(raw, keys) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const k of keys) { const c = cleanCents(raw[k]); if (c !== null && c > 0) out[k] = c; }
    return out;
  }
  function cleanWish(raw) {
    if (!raw || typeof raw !== 'object' || !TOKEN_RE.test(raw.token || '') || !TOKEN_RE.test(raw.key || '')) return null;
    return { token: raw.token, key: raw.key, at: msOf(raw.at) };
  }

  /**
   * One person as Kindly keeps them, or null when there is no name. Only the
   * known fields are read; anything else a request or an old phone carries
   * is dropped here.
   */
  function cleanPerson(raw, today, opts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = cleanText(raw.name, LIMITS.name);
    const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
    if (!name || !id) return null;
    const dates = [];
    const seen = new Set();
    for (const c of Array.isArray(raw.dates) ? raw.dates.slice(0, LIMITS.dates * 2) : []) {
      const d = cleanCustom(c, today);
      if (d && !seen.has(d.id) && d.id !== 'birthday' && d.id !== 'anniversary' && dates.length < LIMITS.dates) { seen.add(d.id); dates.push(d); }
    }
    const ideas = [];
    const ids = new Set();
    for (const i of Array.isArray(raw.ideas) ? raw.ideas.slice(0, LIMITS.ideas * 2) : []) {
      const c = cleanIdea(i);
      if (c && !ids.has(c.id) && ideas.length < LIMITS.ideas) { ids.add(c.id); ideas.push(c); }
    }
    const birthday = cleanDate(raw.birthday, today);
    const anniversary = cleanDate(raw.anniversary, today);
    const keys = [...(birthday ? ['birthday'] : []), ...(anniversary ? ['anniversary'] : []), ...dates.map((d) => d.id)];
    const out = {
      id, name,
      relationship: REL_IDS.includes(raw.relationship) ? raw.relationship : 'friend',
      birthday, anniversary, dates,
      leadDays: intIn(raw.leadDays, 0, LIMITS.leadMax) ?? LIMITS.leadDefault,
      budgets: cleanBudgets(raw.budgets, keys),
      notes: cleanNotes(raw.notes),
      ideas,
      wish: cleanWish(raw.wish),
      createdAt: msOf(raw.createdAt) || 0,
      updatedAt: msOf(raw.updatedAt) || 0,
    };
    if (opts && opts.keepSample && raw.sample === true) out.sample = true;
    return out;
  }
  function toSaved(p) { const o = {}; for (const k of SAVED_FIELDS) o[k] = p[k] === undefined ? null : p[k]; return o; }
  function relOf(id) { return REL[id] || REL.other; }
  function initials(name) {
    const w = String(name || '').trim().split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x));
    const first = (s) => (/[\p{L}\p{N}]/u.exec(s) || [''])[0];
    return ((first(w[0] || '') + (w.length > 1 ? first(w[w.length - 1]) : '')) || '?').toUpperCase();
  }
  /** The first word of a name - all a wishlist link ever shows. */
  function firstName(name) {
    const w = cleanText(name, LIMITS.name).split(' ')[0] || '';
    return cleanText(w.replace(/[’']s$/i, ''), LIMITS.first);
  }
  /** "Maya’s" / "James’" */
  function possessive(name) { return /s$/i.test(name) ? `${name}’` : `${name}’s`; }

  /* ------------------------------------------------------------------ *
   * The dates, as they fall
   * ------------------------------------------------------------------ */

  /** The day a date is kept on in `year`: Feb 29 falls on Feb 28 or Mar 1
   *  outside leap years, as the person chose. */
  function dayIn(date, year) {
    if (date.month === 2 && date.day === 29 && !isLeap(year)) return date.leap === 'mar1' ? ymd(year, 3, 1) : ymd(year, 2, 28);
    return ymd(year, date.month, date.day);
  }
  /** The next time a date falls, today included: {day, year}. */
  function nextOf(date, today) {
    const y = Number(today.slice(0, 4));
    const a = dayIn(date, y);
    return a >= today ? { day: a, year: y } : { day: dayIn(date, y + 1), year: y + 1 };
  }

  const BIRTHDAY_MILESTONES = [1, 16, 18, 21, 30, 40, 50, 60, 65, 70, 75, 80, 90, 100];
  const ANNIVERSARY_NAMES = { 1: 'paper', 5: 'wood', 10: 'tin', 15: 'crystal', 20: 'china', 25: 'silver', 30: 'pearl', 35: 'coral', 40: 'ruby', 45: 'sapphire', 50: 'golden', 55: 'emerald', 60: 'diamond', 70: 'platinum' };
  /** {n, words} when this one is a big one, else null. */
  function milestone(kind, n) {
    if (!Number.isInteger(n) || n < 1) return null;
    if (kind === 'birthday') {
      if (BIRTHDAY_MILESTONES.includes(n) || (n > 100 && n % 5 === 0)) return { n, words: `turns ${n}`, short: `turns ${n}` };
      return null;
    }
    if (kind === 'anniversary') {
      if (ANNIVERSARY_NAMES[n]) return { n, words: `${ordinal(n)} - the ${ANNIVERSARY_NAMES[n]} anniversary`, short: `${ordinal(n)} anniversary` };
      return null;
    }
    if (n === 1 || n % 5 === 0) return { n, words: plural(n, 'year'), short: plural(n, 'year') };
    return null;
  }

  const KIND_EMOJI = { birthday: '🎂', anniversary: '💍' };
  function customEmoji(label) {
    const f = fold(label);
    if (/gotcha|adopt|rescue|pup|kitten|dog|cat/.test(f)) return '🐾';
    if (/name day|saint/.test(f)) return '🕯️';
    if (/graduat/.test(f)) return '🎓';
    if (/memorial|passed|remember/.test(f)) return '🕊️';
    if (/sober|clean/.test(f)) return '🌱';
    if (/wedding|engag/.test(f)) return '💍';
    return '🎉';
  }
  /** "birthday", "gotcha day" - a date's name inside a sentence (an
   *  acronym like "BBQ day" keeps its capitals). */
  function ownLabel(d) { return d.kind === 'custom' && /^[A-Z]{2}/.test(d.label) ? d.label : d.label.charAt(0).toLowerCase() + d.label.slice(1); }
  /** A person's dates as a list: {key, kind, label, emoji, date}. */
  function datesOf(p) {
    const out = [];
    if (p.birthday) out.push({ key: 'birthday', kind: 'birthday', label: 'Birthday', emoji: KIND_EMOJI.birthday, date: p.birthday });
    if (p.anniversary) out.push({ key: 'anniversary', kind: 'anniversary', label: 'Anniversary', emoji: KIND_EMOJI.anniversary, date: p.anniversary });
    for (const d of p.dates || []) out.push({ key: d.id, kind: 'custom', label: d.label, emoji: customEmoji(d.label), date: d });
    return out;
  }

  /** Every occasion of one person, next time each falls. */
  function occasionsOf(p, today, opts) {
    const ship = intIn(opts && opts.shipDays, 0, LIMITS.shipMax) ?? LIMITS.shipDefault;
    return datesOf(p).map((d) => {
      const nx = nextOf(d.date, today);
      const n = d.date.year ? nx.year - d.date.year : null;
      const inDays = daysBetween(today, nx.day);
      const orderBy = addDays(nx.day, -ship);
      const own = ownLabel(d);
      return {
        id: p.id, key: d.key, kind: d.kind, label: d.label, emoji: d.emoji,
        title: `${possessive(p.name)} ${own}`,
        day: nx.day, year: nx.year, inDays,
        n, // age at that birthday, or years since the date
        milestone: milestone(d.kind, n),
        leap: d.date.month === 2 && d.date.day === 29 ? d.date.leap : null,
        lead: p.leadDays,
        nudge: inDays <= p.leadDays,
        orderBy: orderBy >= today ? orderBy : null,
        budget: (p.budgets || {})[d.key] ?? null,
        spent: spentFor(p, d.key, nx.year),
        ideas: (p.ideas || []).filter((i) => i.status === 'idea').length,
        ready: (p.ideas || []).filter((i) => i.status === 'bought' && i.occasion === d.key && i.year === nx.year).length,
      };
    }).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }
  /** Everything in the next `days` days (60 by default), soonest first. */
  function upcoming(people, today, opts) {
    const days = intIn(opts && opts.days, 1, 400) ?? LIMITS.comingDays;
    const out = [];
    for (const p of people || []) for (const o of occasionsOf(p, today, opts)) if (o.inDays <= days) out.push({ ...o, name: p.name });
    return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.name.localeCompare(b.name)));
  }
  /** The first occasion after the window, for an empty "Coming up". */
  function nextAfter(people, today, days) {
    let best = null;
    for (const p of people || []) for (const o of occasionsOf(p, today)) if (o.inDays > days && (!best || o.day < best.day)) best = { ...o, name: p.name };
    return best;
  }
  /** "in 9 days · order by Oct 26 to arrive" - the words under a row. */
  function whenWords(o, today) {
    const parts = [countdown(o.inDays)];
    if (o.inDays > 0 && !o.ready) {
      if (o.orderBy === today) parts.push('order today to arrive');
      else if (o.orderBy) parts.push(`order by ${fmtDay(o.orderBy, today)} to arrive`);
      else parts.push('too late to ship - shop local or give an experience');
    }
    return parts.join(' · ');
  }
  /** What the row's status chip says. */
  function stageOf(o, today) {
    if (o.inDays === 0) return { id: 'today', words: 'Today!' };
    if (o.ready) return { id: 'ready', words: o.ready === 1 ? 'Gift ready' : `${o.ready} gifts ready` };
    if (o.nudge) return { id: 'shop', words: o.ideas ? 'Time to choose' : 'Time to think of something' };
    return { id: 'later', words: `Nudge from ${fmtDay(addDays(o.day, -o.lead), today)}` };
  }
  /** "Feb 29 - kept on Mar 1 in other years" */
  function dateWords(date) {
    const base = fmtMonthDay(date.month, date.day) + (date.year ? `, ${date.year}` : '');
    if (date.month === 2 && date.day === 29) return `${base} - kept on ${date.leap === 'mar1' ? 'Mar 1' : 'Feb 28'} in other years`;
    return base;
  }

  /* ------------------------------------------------------------------ *
   * Ideas, gifts given, and the no-repeat rule
   * ------------------------------------------------------------------ */

  const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'with', 'in', 'on', 'from', 'some', 'new', 'nice', 'set', 'her', 'his', 'their', 'my', 'kit', 'gift']);
  /** A rough singular: classes -> class, mugs -> mug, glass stays glass. */
  const stem = (w) => (w.length > 4 && /(?:ss|x|ch|sh)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);
  const words = (s) => fold(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
  /** Do two gift descriptions look like the same thing? "Grey cashmere
   *  scarf" and "cashmere scarf (grey)" do; "scarf" and "sweater" don't. */
  function similar(a, b) {
    const x = words(a); const y = words(b);
    if (!x.length || !y.length) return false;
    const X = new Set(x); const Y = new Set(y);
    let both = 0;
    for (const w of X) if (Y.has(w)) both++;
    const small = Math.min(X.size, Y.size);
    if (both === small && small >= (Math.max(X.size, Y.size) > 3 ? 2 : 1)) return true;
    return both / (X.size + Y.size - both) >= 0.5;
  }
  /** Past gifts, newest first. */
  function givenBefore(p) {
    return (p.ideas || []).filter((i) => i.status === 'given').sort((a, b) => (b.year || 0) - (a.year || 0) || (b.doneAt || 0) - (a.doneAt || 0));
  }
  /** The past gift (or one already bought) this idea repeats, or null. */
  function repeatOf(p, text, exceptId) {
    for (const i of p.ideas || []) {
      if (i.id === exceptId || i.status === 'idea') continue;
      if (similar(i.text, text)) return i;
    }
    return null;
  }
  /** What has been spent on one occasion in one year. */
  function spentFor(p, key, year) {
    let s = 0;
    for (const i of p.ideas || []) if (i.status !== 'idea' && i.occasion === key && i.year === year && i.price) s += i.price;
    return s;
  }
  /** Budget words for an occasion: "$34 of $60 · $26 left". */
  function budgetWords(o) {
    if (o.budget === null || o.budget === undefined) return o.spent ? `${fmtMoney(o.spent)} spent` : '';
    const left = o.budget - o.spent;
    return `${fmtMoney(o.spent)} of ${fmtMoney(o.budget)} · ${left >= 0 ? `${fmtMoney(left)} left` : `${fmtMoney(-left)} over`}`;
  }

  /* ------------------------------------------------------------------ *
   * "Gift ideas for them": what may leave the phone. Never the name - not as
   * a field, and not inside a note either (it is taken out of the text).
   * ------------------------------------------------------------------ */

  function redactName(text, name) {
    let s = String(text || '');
    const parts = fold(name).split(' ').filter((w) => w.length >= 2);
    for (const w of parts) {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?:[’']s)?(?=$|[^\\p{L}\\p{N}])`, 'giu'), '$1them');
    }
    return s;
  }
  /** The brief for one occasion of one person. */
  function aiBrief(p, o) {
    const n = p.notes || {};
    const r = (v) => cleanText(redactName(v, p.name), LIMITS.noteField);
    return {
      relationship: p.relationship,
      age: o && o.kind === 'birthday' && Number.isInteger(o.n) ? o.n : null,
      years: o && o.kind !== 'birthday' && Number.isInteger(o.n) ? o.n : null,
      occasion: o ? (o.kind === 'custom' ? 'custom' : o.kind) : 'any',
      occasionLabel: o && o.kind === 'custom' ? r(o.label) : '',
      budget: o && o.budget ? o.budget : null,
      likes: r(n.likes), dislikes: r(n.dislikes), sizes: r(n.sizes), allergies: r(n.allergies), other: r(n.other),
      hasEverything: n.hasEverything === true,
    };
  }
  /** A web search for a suggestion: the page builds the link, never the model. */
  function searchUrl(q) { return `https://duckduckgo.com/?q=${encodeURIComponent(clean(q, 80))}`; }

  /* ------------------------------------------------------------------ *
   * The calendar file (.ics): every date as a yearly all-day event, with a
   * reminder at the person's lead time (9 am) and one on the day. The
   * device's own calendar does the rest - nothing in the cloud writes any
   * calendar. No gift ideas go in it: calendars get shared.
   * ------------------------------------------------------------------ */

  function icsText(v) {
    return String(v === null || v === undefined ? '' : v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
  }
  function utf8Len(ch) { const c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  /** Lines folded at 75 octets (UTF-8), never inside a character. */
  function icsFold(line) {
    const out = [];
    let cur = ''; let bytes = 0;
    for (const ch of Array.from(line)) {
      const n = utf8Len(ch);
      if (bytes + n > 75) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch; bytes += n;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  const compact = (day) => day.replace(/-/g, '');
  function stampOf(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
  /** The yearly rule for a date. Feb 29 kept on Feb 28 is "the last day of
   *  February"; kept on Mar 1 it is the 60th day of the year (Feb 29 in a
   *  leap year, Mar 1 in any other). */
  function rrule(date) {
    if (date.month === 2 && date.day === 29) return date.leap === 'mar1' ? 'FREQ=YEARLY;BYYEARDAY=60' : 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1';
    return `FREQ=YEARLY;BYMONTH=${date.month};BYMONTHDAY=${date.day}`;
  }
  function alarm(n, what) {
    // Relative to the event's start, midnight of the day: n days before at
    // 9:00 is -(n-1) days and 15 hours; the day itself at 9:00 is +9 hours.
    const trig = n > 0 ? `-P${n - 1 ? `${n - 1}D` : ''}T15H` : 'PT9H';
    return ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(what)}`, `TRIGGER:${trig}`, 'END:VALARM'];
  }
  /**
   * @param people  the people to include
   * @param o       {today, nowMs, name}
   * @returns       the .ics file's text, CRLF line endings
   */
  function buildIcs(people, o) {
    const stamp = stampOf(o.nowMs);
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kindly//Birthdays and dates//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(o.name || 'Birthdays & dates (Kindly)')}`];
    for (const p of people || []) {
      for (const d of datesOf(p)) {
        const nx = nextOf(d.date, o.today);
        const what = ownLabel(d);
        const summary = `${d.emoji} ${possessive(p.name)} ${what}`;
        const since = d.date.year ? (d.kind === 'birthday' ? `Born ${d.date.year}.` : `Since ${d.date.year}.`) : '';
        const leap = d.date.month === 2 && d.date.day === 29 ? `Born on Feb 29 - kept on ${d.date.leap === 'mar1' ? 'Mar 1' : 'Feb 28'} in other years.` : '';
        const desc = [since, leap, 'Gift ideas are in Kindly, on your phone.'].filter(Boolean).join('\n');
        const lead = p.leadDays;
        lines.push('BEGIN:VEVENT', `UID:${p.id}-${d.key}@kindly`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${compact(nx.day)}`, `DTEND;VALUE=DATE:${compact(addDays(nx.day, 1))}`,
          `RRULE:${rrule(d.date)}`, `SUMMARY:${icsText(summary)}`, `DESCRIPTION:${icsText(desc)}`, 'TRANSP:TRANSPARENT');
        if (lead > 0) lines.push(...alarm(lead, `${possessive(p.name)} ${what} is ${lead === 1 ? 'tomorrow' : `in ${lead} days`} - time to sort a gift.`));
        lines.push(...alarm(0, `It’s ${possessive(p.name)} ${what} today.`), 'END:VEVENT');
      }
    }
    lines.push('END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ *
   * The sample circle: eight made-up people with dates around today - a
   * birthday in 4 days, a 40th next month, an anniversary, a dog's gotcha
   * day, a leap-day grandmother - with ideas, budgets and past gifts, so
   * every part of the app has something to show in one tap. Every name is
   * invented.
   * ------------------------------------------------------------------ */

  function sample(today, nowMs) {
    const ty = Number(today.slice(0, 4));
    /** A month and day `n` days from today (never Feb 29), with the year
     *  that makes them `age` on it. */
    const at = (n, age) => {
      let d = addDays(today, n);
      if (d.slice(5) === '02-29') d = addDays(d, -1);
      const [y, m, dd] = d.split('-').map(Number);
      return { month: m, day: dd, year: age === undefined ? null : y - age };
    };
    const created = nowMs - 300 * DAY_MS;
    const ago = (days) => nowMs - days * DAY_MS;
    let k = 0;
    const idea = (text, o) => ({ id: `sample-i${++k}`, text, status: 'idea', addedAt: ago(40 + k), ...(o || {}) });
    const gave = (text, year, occasion, price) => idea(text, { status: 'given', year, occasion, price: price || null, doneAt: ago(400) });
    const mk = (o) => ({ createdAt: created, updatedAt: created, dates: [], budgets: {}, ideas: [], wish: null, leadDays: 10, notes: {}, ...o, sample: true });
    const maya = at(4, 33);
    const mayaYear = nextOf(maya, today).year;
    const sam = at(19, undefined);
    const samYear = nextOf({ ...sam, year: null }, today).year;
    const people = [
      mk({ id: 'sample-maya', name: 'Maya Ortiz', relationship: 'friend', birthday: maya, leadDays: 14,
        budgets: { birthday: 6000 },
        notes: { likes: 'Ceramics, oat flat whites, anything green', dislikes: 'Scented candles', sizes: 'M top, 7.5 shoe', allergies: '', other: 'Just got into pottery' },
        ideas: [
          idea('Handmade speckled mug from the Saturday market', { status: 'bought', occasion: 'birthday', year: mayaYear, price: 3400, doneAt: ago(3) }),
          idea('Pottery wheel taster class', { price: 6500, link: 'https://example.com/pottery-taster' }),
          idea('Monstera cutting in a nice pot', { from: 'them', addedAt: ago(20) }),
          gave('Grey cashmere scarf', ty - 2, 'birthday', 5500),
          gave('Coffee subscription, 3 months', ty - 1, 'birthday', 4800),
        ] }),
      mk({ id: 'sample-priya', name: 'Priya Shah', relationship: 'family', birthday: at(33, 40), leadDays: 21,
        budgets: { birthday: 15000 },
        notes: { likes: 'Hiking, mystery novels, good olive oil', dislikes: 'Clutter - she does not need more stuff', sizes: '', allergies: 'Tree nuts', other: '', hasEverything: true },
        ideas: [
          idea('A weekend cabin near the trail she loves', { price: 32000 }),
          idea('Signed first edition from her favourite crime author'),
          gave('Olive oil tasting set', ty - 1, 'birthday', 6200),
        ] }),
      mk({ id: 'sample-sam', name: 'Sam', relationship: 'partner', birthday: at(140, 36), anniversary: { ...sam, year: samYear - 5 }, leadDays: 21,
        budgets: { anniversary: 20000, birthday: 15000 },
        notes: { likes: 'Vinyl, ramen, the coast', dislikes: 'Surprise parties', sizes: 'L, 10 shoe', allergies: '', other: '' },
        ideas: [
          idea('Carved wooden record crate (5th = wood)', { price: 9000 }),
          idea('Ramen-making class for two', { price: 11000 }),
          gave('Weekend in Big Sur', samYear - 1, 'anniversary', 42000),
          gave('Record player', samYear - 2, 'anniversary', 18900),
        ] }),
      mk({ id: 'sample-biscuit', name: 'Biscuit 🐶', relationship: 'family', leadDays: 5,
        dates: [{ id: 'sample-gotcha', label: 'Gotcha day', ...at(11, 3) }],
        notes: { likes: 'Squeaky ducks, peanut butter, the beach', dislikes: 'Baths', sizes: 'Medium harness', allergies: 'Chicken', other: '' },
        ideas: [idea('Puzzle feeder toy', { price: 1800 }), gave('Personalised collar', ty - 1, 'sample-gotcha', 2400)] }),
      mk({ id: 'sample-rose', name: 'Grandma Rose', relationship: 'family', birthday: { month: 2, day: 29, year: 1944, leap: 'mar1' }, leadDays: 14,
        notes: { likes: 'Gardening, crosswords, photos of the grandkids', dislikes: '', sizes: '', allergies: '', other: 'Prefers a card she can keep' },
        ideas: [idea('Photo book of the year'), gave('Digital photo frame', ty - 1, 'birthday', 8900)] }),
      mk({ id: 'sample-leo', name: 'Leo', relationship: 'family', birthday: at(46, 7), leadDays: 10,
        budgets: { birthday: 4000 },
        notes: { likes: 'Dinosaurs, Lego, anything with wheels', dislikes: '', sizes: 'Kids 7-8', allergies: 'Peanuts', other: 'Nephew' },
        ideas: [idea('Lego dinosaur fossil set', { price: 3500 })] }),
      mk({ id: 'sample-alex', name: 'Alex Kim', relationship: 'work', birthday: at(52, undefined), leadDays: 7,
        notes: { likes: 'Single-origin coffee, cycling', dislikes: '', sizes: '', allergies: '', other: 'Team card + a small treat' },
        ideas: [] }),
      mk({ id: 'sample-noor', name: 'Noor Haddad', relationship: 'friend', birthday: at(160, 29),
        notes: { likes: 'Baking, sourdough, jazz', dislikes: '', sizes: '', allergies: '', other: '' },
        ideas: [idea('Bread maker - mentioned it at the July barbecue', { addedAt: ago(95) })] }),
    ];
    return people.map((p) => cleanPerson(p, today, { keepSample: true }));
  }

  return {
    LIMITS, DAY_MS, RELATIONSHIPS, REL_IDS, NOTE_FIELDS, NOTE_LABEL, STATUSES, ID_RE, TOKEN_RE, SAVED_FIELDS, MONTHS, MONTHS_LONG, WEEKDAYS,
    BIRTHDAY_MILESTONES, ANNIVERSARY_NAMES,
    clean, cleanText, fold, fail, cleanLink, hostOf,
    isLeap, daysInMonth, isDay, daysBetween, addDays, localDay, fmtDay, fmtMonthDay, plural, ordinal, countdown, weekday,
    parseMoney, cleanCents, fmtMoney,
    cleanDate, cleanIdea, cleanNotes, cleanPerson, toSaved, relOf, initials, firstName, possessive,
    dayIn, nextOf, milestone, datesOf, occasionsOf, upcoming, nextAfter, whenWords, stageOf, dateWords, customEmoji,
    similar, givenBefore, repeatOf, spentFor, budgetWords,
    redactName, aiBrief, searchUrl,
    icsText, icsFold, rrule, buildIcs,
    sample,
  };
});
