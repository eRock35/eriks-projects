/* Chorus - the rules, in one file, run three times: by the page (a household
 * on this phone, the example home, and the board of an online one), by the
 * server (which deals each week and checks every tick and swap), and by the
 * tests. UMD: window.ChorusCore in the page, require() in node.
 *
 * Nothing here touches a store, the network or the clock on its own: every
 * function is handed what it needs, and the same inputs always give the same
 * answer - two phones looking at one household draw the same week.
 *
 * The fair rotation (deal) is the point of the app:
 *   - every chore due this week becomes one or more SLOTS (a daily chore is
 *     seven, "2-3x a week" alternates three and two, every 2 weeks and
 *     monthly fall due from the week they were added);
 *   - a slot is worth its effort (1-5 points);
 *   - each person has a capacity WEIGHT (1 = a full share, a kid 0.5), and the
 *     deal aims every person at total x weight / sum of weights;
 *   - nobody gets a chore they said they can't or won't do;
 *   - someone who had a chore recently pays a penalty for getting it again,
 *     doubled when it is on their least-liked list, so the bathroom moves on;
 *   - greedy first (biggest and most constrained slots first), then a bounded
 *     hill-climb (moves and swaps) on one objective: the squared distance of
 *     each person's load per unit of weight from the household's, plus the
 *     rotation penalties. Ties break by a hash of the week, the slot and the
 *     person - deterministic, and different week to week.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChorusCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  const LIMITS = {
    members: 12,
    chores: 60,
    homeName: 40,
    memberName: 20,
    choreName: 40,
    dislikes: 3,
    suggestText: 500,
    suggestions: 20,
    historyWeeks: 4,   // what the rotation and "this month" look back over
    keepWeeks: 9,      // what a phone or a read keeps (the streak looks back this far)
  };
  const FREQS = [
    { id: 'daily', label: 'Daily', short: 'Every day' },
    { id: 'often', label: '2–3× a week', short: '2–3× a week' },
    { id: 'weekly', label: 'Weekly', short: 'Once a week' },
    { id: 'biweekly', label: 'Every 2 weeks', short: 'Every 2 weeks' },
    { id: 'monthly', label: 'Monthly', short: 'Every 4 weeks' },
  ];
  const FREQ_IDS = FREQS.map((f) => f.id);
  const EFFORT = ['', 'Quick', 'Easy', 'Medium', 'Big', 'Huge'];
  const EFFORT_HINT = ['', 'a few minutes', 'about 15 minutes', 'about half an hour', 'an hour or so', 'a long job'];
  const WEIGHTS = [
    { v: 0.25, label: 'A little (¼)' },
    { v: 0.5, label: 'Half - a kid' },
    { v: 0.75, label: 'Three quarters' },
    { v: 1, label: 'A full share' },
    { v: 1.25, label: 'A bit more' },
    { v: 1.5, label: 'One and a half' },
  ];
  const WEIGHT_VALUES = WEIGHTS.map((w) => w.v);
  const EMOJI = ['🦊', '🐻', '🦋', '🐢', '🐙', '🦉', '🐝', '🌵', '🦄', '🐸', '🐧', '🦁', '🐳', '🌻', '🍋', '🍓', '🌈', '⚡', '🎸', '🚲', '🎯', '🧢', '🦖', '🐼'];
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const NUMBERS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

  /** Starter chores. `nudge` is how a friendly reminder phrases it. */
  const TEMPLATES = [
    {
      id: 'roommates', name: 'Roommates', emoji: '🛋️', blurb: 'Shared kitchen, shared bathroom, nobody’s parent.',
      people: [{ name: '', weight: 1 }, { name: '', weight: 1 }, { name: '', weight: 1 }],
      chores: [
        ['Dishes and kitchen tidy', '🍽️', 2, 'daily'],
        ['Take the bins out', '🗑️', 2, 'weekly', 'the bins go out tonight'],
        ['Recycling', '♻️', 1, 'weekly', 'the recycling goes out tonight'],
        ['Clean the bathroom', '🛁', 4, 'weekly'],
        ['Vacuum the shared rooms', '🧹', 3, 'weekly'],
        ['Wipe counters and stove', '🧽', 2, 'often'],
        ['Tidy the living room', '🛋️', 2, 'often'],
        ['Mop the floors', '🪣', 3, 'biweekly'],
        ['Clear out the fridge', '🧊', 3, 'biweekly', 'the fridge needs clearing out'],
        ['Restock loo roll and soap', '🧻', 1, 'biweekly'],
      ],
    },
    {
      id: 'couple', name: 'Couple', emoji: '💞', blurb: 'Two people, one home, no scorekeeping in your head.',
      people: [{ name: '', weight: 1 }, { name: '', weight: 1 }],
      chores: [
        ['Dishes', '🍽️', 2, 'daily'],
        ['Cook dinner', '🍳', 3, 'often'],
        ['Grocery run', '🛒', 3, 'weekly', 'the grocery run is yours this week'],
        ['Laundry', '🧺', 3, 'often'],
        ['Take the bins out', '🗑️', 2, 'weekly', 'the bins go out tonight'],
        ['Clean the bathroom', '🛁', 4, 'weekly'],
        ['Vacuum', '🧹', 3, 'weekly'],
        ['Change the sheets', '🛏️', 2, 'biweekly'],
        ['Water the plants', '🪴', 1, 'often', 'the plants are thirsty'],
        ['Pay the bills', '💳', 2, 'monthly'],
      ],
    },
    {
      id: 'family', name: 'Family with kids', emoji: '👨‍👩‍👧‍👦', blurb: 'Grown-ups carry more; kids count half and still pitch in.',
      people: [{ name: '', weight: 1 }, { name: '', weight: 1 }, { name: '', weight: 0.5 }, { name: '', weight: 0.5 }],
      chores: [
        ['Load and unload the dishwasher', '🍽️', 2, 'daily'],
        ['Set and clear the table', '🍴', 1, 'daily'],
        ['Feed the pet', '🐶', 1, 'daily', 'the pet needs feeding'],
        ['Laundry', '🧺', 3, 'often'],
        ['Fold and put away laundry', '🧦', 2, 'often'],
        ['Take the bins out', '🗑️', 2, 'weekly', 'the bins go out tonight'],
        ['Clean the bathroom', '🛁', 4, 'weekly'],
        ['Vacuum', '🧹', 3, 'weekly'],
        ['Grocery shop', '🛒', 3, 'weekly'],
        ['Tidy the playroom', '🧸', 1, 'often'],
        ['Change the sheets', '🛏️', 2, 'biweekly'],
        ['Clean the car', '🚗', 3, 'monthly'],
      ],
    },
  ];

  /* ------------------------------------------------------------------ *
   * Text and ids
   * ------------------------------------------------------------------ */

  // Control characters, zero-width marks and bidi overrides are removed from
  // anything typed or read (a name like "‮Sam" would draw backwards on
  // every phone). The zero-width joiner stays: family emoji need it.
  const STRIP = /[\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁠-⁩﻿]/g;

  /** One line of untrusted text: no markup, no control or bidi characters,
   *  single spaces, at most `max` characters, cut on a whole character. Cut
   *  before any pattern runs, so hostile input costs linear time. */
  function clean(v, max) {
    let s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 200) s = s.slice(0, max * 4 + 200);
    s = s.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
    return s;
  }
  /** A person's name: has to have a letter, digit or emoji in it. */
  function cleanName(v) {
    const s = clean(v, LIMITS.memberName);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  function cleanEmoji(v) { return EMOJI.indexOf(v) >= 0 ? v : null; }
  /** A chore's emoji: one emoji (a ZWJ sequence counts as one), else null. */
  function cleanChoreEmoji(v) {
    if (typeof v !== 'string' || v.length > 24) return null;
    const s = v.replace(STRIP, '').trim();
    if (!/^\p{Extended_Pictographic}/u.test(s)) return null;
    if (/[\p{L}\p{N}<>&"'\s]/u.test(s.replace(/[⃣️]/g, ''))) return null;
    let n = 0;
    if (typeof Intl !== 'undefined' && Intl.Segmenter) { for (const _ of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)) n++; } else n = 1;
    return n === 1 ? s : null;
  }
  function cleanEffort(v) {
    const n = typeof v === 'string' && /^\d$/.test(v.trim()) ? Number(v) : v;
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  }
  function cleanFreq(v) { return FREQ_IDS.indexOf(v) >= 0 ? v : null; }
  function cleanWeight(v) {
    const n = typeof v === 'string' ? Number(v) : v;
    return WEIGHT_VALUES.indexOf(n) >= 0 ? n : null;
  }

  const MEMBER_ID = /^m[a-z0-9]{6,12}$/;
  const CHORE_ID = /^c[a-z0-9]{6,12}$/;
  const SLOT_ID = /^c[a-z0-9]{6,12}_[0-6]$/;
  const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isMemberId = (v) => typeof v === 'string' && MEMBER_ID.test(v);
  const isChoreId = (v) => typeof v === 'string' && CHORE_ID.test(v);
  const isSlotId = (v) => typeof v === 'string' && SLOT_ID.test(v);
  const isWeek = (v) => typeof v === 'string' && WEEK_RE.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z'));

  /** A short random id from an unambiguous alphabet. `rand(n)` -> 0..n-1. */
  function newId(prefix, rand) {
    const A = 'abcdefghijkmnpqrstuvwxyz23456789';
    const r = rand || ((n) => Math.floor(Math.random() * n));
    let s = prefix;
    for (let i = 0; i < 9; i++) s += A[r(A.length)];
    return s;
  }

  function fail(status, message, extra) {
    const e = new Error(message);
    e.status = status; e.expose = true;
    if (extra) Object.assign(e, extra);
    return e;
  }
  /** "Ana", "Ana and Ben", "Ana, Ben and Cleo". */
  function nameList(names) {
    if (names.length <= 2) return names.join(' and ');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function pct(x) { return Math.round(x * 100) + '%'; }

  /** FNV-1a, 32 bits, finalised - for the deal's tie-breaks and the basis stamp. */
  function hash32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    // murmur3's finaliser, so strings that differ only at the end still
    // spread over the whole range.
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }

  /* ------------------------------------------------------------------ *
   * Weeks and days, in the household's own time zone
   * ------------------------------------------------------------------ */

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
  /** 0 = Monday ... 6 = Sunday, for a 'YYYY-MM-DD'. */
  function weekday(d) { return (new Date(dateMs(d)).getUTCDay() + 6) % 7; }
  /** The Monday that starts the week holding `ms`, in `tz`. */
  function weekKey(ms, tz) { const d = localDate(ms, tz); return isoDate(dateMs(d) - weekday(d) * DAY_MS); }
  function dayIndex(ms, tz) { return weekday(localDate(ms, tz)); }
  function addWeeks(week, n) { return isoDate(dateMs(week) + n * 7 * DAY_MS); }
  function weeksBetween(a, b) { return Math.round((dateMs(b) - dateMs(a)) / (7 * DAY_MS)); }
  function weekIndex(week) { return Math.round((dateMs(week) - dateMs('1970-01-05')) / (7 * DAY_MS)); }
  function dayDate(week, i) { return isoDate(dateMs(week) + i * DAY_MS); }
  function weekLabel(week) {
    const a = new Date(dateMs(week)); const b = new Date(dateMs(week) + 6 * DAY_MS);
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return M[a.getUTCMonth()] + ' ' + a.getUTCDate() + ' – ' + (a.getUTCMonth() === b.getUTCMonth() ? '' : M[b.getUTCMonth()] + ' ') + b.getUTCDate();
  }

  /* ------------------------------------------------------------------ *
   * Cleaning a household
   * ------------------------------------------------------------------ */

  function cleanChore(raw, ctx) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const name = clean(r.name, LIMITS.choreName);
    if (!/[\p{L}\p{N}]/u.test(name)) throw fail(400, 'Give the chore a name.');
    const effort = cleanEffort(r.effort);
    if (!effort) throw fail(400, 'Effort is 1 (quick) to 5 (a big job).');
    const freq = cleanFreq(r.freq);
    if (!freq) throw fail(400, 'Pick how often it needs doing.');
    const id = isChoreId(r.id) ? r.id : newId('c', ctx && ctx.rand);
    const start = isWeek(r.start) ? r.start : (ctx && ctx.week) || null;
    const nudge = clean(r.nudge, 60);
    return { id, name, emoji: cleanChoreEmoji(r.emoji) || '🧹', effort, freq, start, ...(nudge ? { nudge } : {}) };
  }
  function cleanMemberFields(raw, choreIds) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const ids = choreIds || [];
    const list = (v, max) => (Array.isArray(v) ? v : []).filter((x, i, a) => ids.indexOf(x) >= 0 && a.indexOf(x) === i).slice(0, max);
    return {
      weight: cleanWeight(r.weight) || 1,
      cant: list(r.cant, LIMITS.chores),
      dislikes: list(r.dislikes, LIMITS.dislikes),
    };
  }
  /** A household from a phone (or the create screen): name, people, chores.
   *  Ids are kept when they are well formed and unique, else re-minted;
   *  exclusions keep only chores that exist. Throws a 400 sentence. */
  function cleanHome(raw, ctx) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const name = clean(r.name, LIMITS.homeName);
    if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(name)) throw fail(400, 'Give the household a name.');
    const rawChores = Array.isArray(r.chores) ? r.chores : [];
    if (rawChores.length > LIMITS.chores) throw fail(400, `A household keeps ${LIMITS.chores} chores at most.`);
    const chores = [];
    for (const c of rawChores) {
      const ch = cleanChore(c, ctx);
      if (chores.some((x) => x.id === ch.id)) ch.id = newId('c', ctx && ctx.rand);
      chores.push(ch);
    }
    const choreIds = chores.map((c) => c.id);
    const rawMembers = Array.isArray(r.members) ? r.members : [];
    if (!rawMembers.length) throw fail(400, 'Add at least one person.');
    if (rawMembers.length > LIMITS.members) throw fail(400, `A household has ${LIMITS.members} people at most.`);
    const members = [];
    const used = new Set();
    for (const m of rawMembers) {
      const n = cleanName(m && m.name);
      if (!n) throw fail(400, 'Every person needs a name.');
      if (members.some((x) => x.name.toLocaleLowerCase() === n.toLocaleLowerCase())) throw fail(400, `Two people are called ${n} - add an initial.`);
      let id = isMemberId(m.id) && !members.some((x) => x.id === m.id) ? m.id : newId('m', ctx && ctx.rand);
      let emoji = cleanEmoji(m.emoji);
      if (!emoji || used.has(emoji)) emoji = EMOJI.find((e) => !used.has(e)) || EMOJI[0];
      used.add(emoji);
      members.push({ id, name: n, emoji, ...cleanMemberFields(m, choreIds) });
    }
    const since = typeof r.since === 'string' && isWeek(r.since) ? r.since : null;
    return { name, members, chores, ...(since ? { since } : {}) };
  }

  /* ------------------------------------------------------------------ *
   * Slots: what is due this week
   * ------------------------------------------------------------------ */

  const OFTEN_DAYS = { 3: [0, 2, 4], 2: [1, 5] };   // Mon Wed Fri / Tue Sat
  /** The slots a chore has in `week`: [{id, chore, n, day|null, pts}]. */
  function slotsFor(chore, week) {
    const out = [];
    const add = (n, day) => out.push({ id: chore.id + '_' + n, chore: chore.id, n, day, pts: chore.effort });
    const since = chore.start && isWeek(chore.start) ? weeksBetween(chore.start, week) : 0;
    const due = (every) => ((since % every) + every) % every === 0;
    switch (chore.freq) {
      case 'daily': for (let i = 0; i < 7; i++) add(i, i); break;
      case 'often': (weekIndex(week) % 2 === 0 ? OFTEN_DAYS[3] : OFTEN_DAYS[2]).forEach((d, i) => add(i, d)); break;
      case 'weekly': add(0, null); break;
      case 'biweekly': if (due(2)) add(0, null); break;
      case 'monthly': if (due(4)) add(0, null); break;
      default: break;
    }
    return out;
  }
  /** Every slot due in `week`. `since` ('YYYY-MM-DD', the day a household
   *  started) trims its first, partial week: no slot on a day before it, and
   *  no "this week" chore when it started on a Friday or later - nobody
   *  should open a new app to a week's worth of chores due by Sunday. */
  function weekSlots(chores, week, since) {
    const out = [];
    const first = inFirstWeek(since, week) ? since : null;
    const fromDay = first ? weekday(first) : 0;
    for (const c of chores) {
      for (const s of slotsFor(c, week)) {
        if (first && (s.day === null ? fromDay >= 4 : s.day < fromDay)) continue;
        out.push(s);
      }
    }
    return out;
  }
  /** Is `week` a household's first, partial week? */
  function partialWeek(home, week) {
    return inFirstWeek(home && home.since, week);
  }
  function inFirstWeek(since, week) { return isWeek(since) && since > week && dateMs(since) - dateMs(week) < 7 * DAY_MS; }

  /** What decides a week's deal: everything but names and emoji. A week is
   *  re-dealt (keeping what is done or swapped) when this changes. */
  function basisOf(home) {
    const m = (home.members || []).map((x) => [x.id, x.weight, (x.cant || []).slice().sort(), (x.dislikes || []).slice().sort()]);
    const c = (home.chores || []).map((x) => [x.id, x.effort, x.freq, x.start || '']);
    return hash32(JSON.stringify([m, c])).toString(36);
  }

  /** Who holds each slot once swaps are applied. */
  function effective(doc) {
    const out = Object.assign({}, (doc && doc.assign) || {});
    const sw = (doc && doc.swaps) || {};
    for (const k of Object.keys(sw)) if (sw[k] && sw[k].state === 'claimed' && sw[k].to) out[k] = sw[k].to;
    return out;
  }

  /* ------------------------------------------------------------------ *
   * The deal
   * ------------------------------------------------------------------ */

  const DECAY = [1, 0.6, 0.35, 0.2];    // last week counts most
  const ROTATE = 1.5;                   // per point of effort, per unit of "had it lately"
  const DISLIKE_AGAIN = 1;              // extra, per point, when it is on their least-liked list
  const DISLIKE = 0.15;                 // a nudge, per point, even with no history
  const SAME_WEEK = 0.35;               // a daily chore spreads across people rather than piling up

  /** How much each person had each chore lately: {mid: {cid: 0..~2}}, from
   *  history docs newest first (last week = index 0). Shares: holding 3 of
   *  a daily chore's 7 slots counts 3/7. */
  function recency(history, members) {
    const out = {};
    for (const m of members) out[m.id] = {};
    (history || []).slice(0, DECAY.length).forEach((doc, k) => {
      const eff = effective(doc);
      const per = {};
      for (const slot of Object.keys(eff)) { const c = slot.split('_')[0]; per[c] = (per[c] || 0) + 1; }
      for (const slot of Object.keys(eff)) {
        const mid = eff[slot]; const c = slot.split('_')[0];
        if (!out[mid]) continue;
        out[mid][c] = (out[mid][c] || 0) + DECAY[k] / per[c];
      }
    });
    return out;
  }

  /**
   * Deal a week. Pure and deterministic.
   *   home:    {members, chores}
   *   week:    'YYYY-MM-DD' (a Monday)
   *   history: past week docs, newest first
   *   pins:    {slotId: mid} - done or swapped slots that must stay put
   * -> {week, basis, assign: {slotId: mid|null}}
   */
  function deal(home, week, history, pins) {
    const members = (home.members || []).filter((m) => m.weight > 0);
    const chores = home.chores || [];
    const slots = weekSlots(chores, week, home.since);
    const byChore = {};
    for (const c of chores) byChore[c.id] = c;
    const mids = members.map((m) => m.id);
    const W = {}; for (const m of members) W[m.id] = m.weight;
    const totalW = members.reduce((s, m) => s + m.weight, 0) || 1;
    const totalP = slots.reduce((s, x) => s + x.pts, 0);
    const T = totalP / totalW;
    const rec = recency(history, home.members || []);
    const eligible = {};
    for (const c of chores) eligible[c.id] = members.filter((m) => (m.cant || []).indexOf(c.id) < 0).map((m) => m.id);
    const dislikes = {};
    for (const m of members) dislikes[m.id] = m.dislikes || [];

    const load = {}; for (const id of mids) load[id] = 0;
    const count = {}; for (const id of mids) count[id] = {};
    const assign = {};
    const fixed = {};
    for (const s of slots) {
      const p = pins && pins[s.id];
      if (p && W[p]) { assign[s.id] = p; fixed[s.id] = true; load[p] += s.pts; count[p][s.chore] = (count[p][s.chore] || 0) + 1; }
    }
    const tie = (s, mid) => (hash32(week + '|' + s.id + '|' + mid) / 4294967296) * 1e-6;
    // The penalty part of the objective for one slot held by one person.
    function pen(s, mid, sameBefore) {
      const r = (rec[mid] && rec[mid][s.chore]) || 0;
      const dis = dislikes[mid].indexOf(s.chore) >= 0;
      return s.pts * (ROTATE * r + (dis ? DISLIKE + DISLIKE_AGAIN * r : 0)) + SAME_WEEK * sameBefore;
    }
    const sq = (mid, L) => { const d = L / W[mid] - T; return d * d; };

    // Greedy: most constrained first, then the biggest, then a stable order.
    const order = slots.filter((s) => !fixed[s.id]).sort((a, b) =>
      (eligible[a.chore].length - eligible[b.chore].length) || (b.pts - a.pts) || (chores.indexOf(byChore[a.chore]) - chores.indexOf(byChore[b.chore])) || (a.n - b.n));
    for (const s of order) {
      let best = null; let bestV = Infinity;
      for (const mid of eligible[s.chore]) {
        const same = count[mid][s.chore] || 0;
        const v = sq(mid, load[mid] + s.pts) - sq(mid, load[mid]) + pen(s, mid, same) + tie(s, mid);
        if (v < bestV) { bestV = v; best = mid; }
      }
      assign[s.id] = best || null;
      if (best) { load[best] += s.pts; count[best][s.chore] = (count[best][s.chore] || 0) + 1; }
    }

    // Improve: single moves, then pairwise swaps, until nothing helps.
    const free = order.filter((s) => assign[s.id]);
    const moveDelta = (s, from, to) => {
      const sameFrom = count[from][s.chore] - 1;
      const sameTo = count[to][s.chore] || 0;
      return (sq(from, load[from] - s.pts) - sq(from, load[from])) + (sq(to, load[to] + s.pts) - sq(to, load[to]))
        + pen(s, to, sameTo) - pen(s, from, sameFrom) + tie(s, to) - tie(s, from);
    };
    const apply = (s, from, to) => {
      load[from] -= s.pts; load[to] += s.pts;
      count[from][s.chore]--; count[to][s.chore] = (count[to][s.chore] || 0) + 1;
      assign[s.id] = to;
    };
    for (let pass = 0; pass < 25; pass++) {
      let improved = false;
      for (const s of free) {
        const from = assign[s.id];
        let best = null; let bestD = -1e-9;
        for (const to of eligible[s.chore]) {
          if (to === from) continue;
          const d = moveDelta(s, from, to);
          if (d < bestD) { bestD = d; best = to; }
        }
        if (best) { apply(s, from, best); improved = true; }
      }
      if (free.length <= 240) {
        for (let i = 0; i < free.length; i++) {
          for (let j = i + 1; j < free.length; j++) {
            const a = free[i]; const b = free[j];
            const x = assign[a.id]; const y = assign[b.id];
            if (x === y || a.pts === b.pts && a.chore === b.chore) continue;
            if (eligible[a.chore].indexOf(y) < 0 || eligible[b.chore].indexOf(x) < 0) continue;
            const before = sq(x, load[x]) + sq(y, load[y]) + pen(a, x, count[x][a.chore] - 1) + pen(b, y, count[y][b.chore] - 1) + tie(a, x) + tie(b, y);
            const lx = load[x] - a.pts + b.pts; const ly = load[y] - b.pts + a.pts;
            const sameXb = (count[x][b.chore] || 0) - (a.chore === b.chore ? 1 : 0);
            const sameYa = (count[y][a.chore] || 0) - (a.chore === b.chore ? 1 : 0);
            const after = sq(x, lx) + sq(y, ly) + pen(b, x, sameXb) + pen(a, y, sameYa) + tie(a, y) + tie(b, x);
            if (after < before - 1e-9) { apply(a, x, y); apply(b, y, x); improved = true; }
          }
        }
      }
      if (!improved) break;
    }
    return { week, basis: basisOf(home), assign };
  }

  /** The slots that must stay put when a week is re-dealt: done ones with
   *  whoever did them, swapped ones with whoever took them, offered ones
   *  with whoever is offering. Only people still in the household. */
  function pinsOf(doc, home) {
    const ids = (home.members || []).map((m) => m.id);
    const pins = {};
    const sw = (doc && doc.swaps) || {};
    for (const k of Object.keys(sw)) {
      const who = sw[k] && (sw[k].state === 'claimed' ? sw[k].to : sw[k].from);
      if (ids.indexOf(who) >= 0) pins[k] = who;
    }
    const t = (doc && doc.ticks) || {};
    for (const k of Object.keys(t)) if (t[k] && ids.indexOf(t[k].who) >= 0) pins[k] = t[k].who;
    return pins;
  }

  /** Does this week's document need (re)dealing? */
  function needsDeal(home, doc) { return !doc || !doc.assign || doc.basis !== basisOf(home); }

  /** The week's document, dealt or re-dealt from history. Returns a new
   *  object when anything changed, else the same one. Ticks and swaps are
   *  kept; swaps on slots that no longer exist are dropped. */
  function ensureWeek(home, doc, week, history) {
    if (!needsDeal(home, doc)) return doc;
    const d = deal(home, week, history, pinsOf(doc, home));
    const slots = {}; for (const s of weekSlots(home.chores || [], week, home.since)) slots[s.id] = true;
    const swaps = {};
    const ids = (home.members || []).map((m) => m.id);
    const old = (doc && doc.swaps) || {};
    for (const k of Object.keys(old)) if (slots[k] && ids.indexOf(old[k].from) >= 0 && (old[k].state !== 'claimed' || ids.indexOf(old[k].to) >= 0)) swaps[k] = old[k];
    return Object.assign({}, doc || {}, { week, basis: d.basis, assign: d.assign, ticks: (doc && doc.ticks) || {}, swaps });
  }

  /* ------------------------------------------------------------------ *
   * Ticks and swaps: each returns a patch of ONE key - {set, del} - which
   * the server writes with update() inside a transaction and the page
   * applies to its own copy.
   * ------------------------------------------------------------------ */

  function slotOf(home, doc, slotId) {
    if (!isSlotId(slotId)) throw fail(404, 'No such chore this week.');
    const c = (home.chores || []).find((x) => x.id === slotId.split('_')[0]);
    const s = c && weekSlots([c], doc.week, home.since).find((x) => x.id === slotId);
    if (!s) throw fail(404, 'No such chore this week.');
    return { chore: c, slot: s };
  }
  function memberOf(home, mid) { return (home.members || []).find((m) => m.id === mid) || null; }

  /** actor: {mid, host, local}. A tick credits whoever holds the slot (a
   *  parent can tick a kid's), or the ticker when nobody does. */
  function tick(home, doc, slotId, actor, now) {
    const { slot } = slotOf(home, doc, slotId);
    if (doc.ticks && doc.ticks[slotId]) return null; // already done - two phones, one tick
    const holder = effective(doc)[slotId];
    const who = memberOf(home, holder) ? holder : actor.mid;
    if (!who) throw fail(409, 'Pick who did it first.');
    const set = {}; set['ticks.' + slotId] = { who, by: actor.mid || who, pts: slot.pts, at: new Date(now).toISOString() };
    const sw = doc.swaps && doc.swaps[slotId];
    return { set, del: sw && sw.state === 'offered' ? ['swaps.' + slotId] : [] };
  }
  function untick(home, doc, slotId) {
    if (!isSlotId(slotId)) throw fail(404, 'No such chore this week.');
    if (!doc.ticks || !doc.ticks[slotId]) return null;
    return { set: {}, del: ['ticks.' + slotId] };
  }
  /** offer | cancel | claim on a phone shared by a household online, and
   *  give (straight to someone) on a phone the household shares. */
  function swap(home, doc, slotId, actor, action, now, to) {
    const { chore } = slotOf(home, doc, slotId);
    if (doc.ticks && doc.ticks[slotId]) throw fail(409, 'That one is already done.');
    const holder = effective(doc)[slotId];
    const cur = doc.swaps && doc.swaps[slotId];
    const open = cur && cur.state === 'offered';
    const at = new Date(now).toISOString();
    const key = 'swaps.' + slotId;
    const canDo = (mid) => { const m = memberOf(home, mid); return Boolean(m && m.weight > 0 && (m.cant || []).indexOf(chore.id) < 0); };
    if (action === 'offer') {
      if (!holder || (holder !== actor.mid && !actor.host)) throw fail(403, 'You can only offer your own chores.');
      if (open) return null;
      return { set: { [key]: { from: holder, state: 'offered', at } }, del: [] };
    }
    if (action === 'cancel') {
      if (!open) return null;
      if (cur.from !== actor.mid && !actor.host) throw fail(403, 'Only whoever offered it can take it back.');
      return { set: {}, del: [key] };
    }
    if (action === 'claim') {
      if (!open) throw fail(409, cur && cur.state === 'claimed' ? 'Someone already took that one.' : 'That isn’t up for grabs any more.');
      if (!actor.mid) throw fail(403, 'Join the household first.');
      if (actor.mid === cur.from) throw fail(409, 'That’s your own offer - cancel it instead.');
      if (!canDo(actor.mid)) throw fail(409, 'That one is on your can’t-do list.');
      return { set: { [key]: { from: cur.from, to: actor.mid, state: 'claimed', at } }, del: [] };
    }
    if (action === 'give') {
      if (!actor.local && !actor.host) throw fail(403, 'Offer it instead - someone claims it from their own phone.');
      if (!holder) throw fail(409, 'Nobody has that one yet.');
      if (to === holder) return null;
      if (!canDo(to)) throw fail(409, 'They can’t take that one.');
      return { set: { [key]: { from: holder, to, state: 'claimed', at } }, del: [] };
    }
    throw fail(400, 'Unknown swap action.');
  }

  /** Apply a patch to a copy of a week document (the page's own copy, the
   *  memory store, the tests). */
  function applyPatch(doc, patch) {
    if (!patch) return doc;
    const next = JSON.parse(JSON.stringify(doc));
    for (const k of Object.keys(patch.set || {})) { const [a, b] = k.split('.'); next[a] = next[a] || {}; next[a][b] = patch.set[k]; }
    for (const k of patch.del || []) { const [a, b] = k.split('.'); if (next[a]) delete next[a][b]; }
    return next;
  }

  /* ------------------------------------------------------------------ *
   * Reading a week: the board, the words, fairness, streaks
   * ------------------------------------------------------------------ */

  const doneBy = (doc, mid) => Object.values((doc && doc.ticks) || {}).filter((t) => t && t.who === mid).reduce((s, t) => s + (t.pts || 0), 0);

  /** Who held chore `cid` in a past doc: the person with most of its slots. */
  function mainHolder(doc, cid) {
    const eff = effective(doc); const n = {};
    for (const k of Object.keys(eff)) if (k.split('_')[0] === cid && eff[k]) n[eff[k]] = (n[eff[k]] || 0) + 1;
    let best = null; for (const k of Object.keys(n)) if (!best || n[k] > n[best]) best = k;
    return best;
  }

  /** One plain sentence per chore and person this week, keyed `cid:mid`. */
  function explain(home, doc, history) {
    const out = {};
    const eff = effective(doc);
    const members = home.members || [];
    const name = (mid) => { const m = memberOf(home, mid); return m ? m.name : 'Someone'; };
    const able = (cid) => members.filter((m) => m.weight > 0 && (m.cant || []).indexOf(cid) < 0);
    const groups = {};
    for (const s of weekSlots(home.chores || [], doc.week, home.since)) {
      const mid = eff[s.id] || null;
      const k = s.chore + ':' + (mid || '-');
      (groups[k] = groups[k] || []).push(s);
    }
    for (const k of Object.keys(groups)) {
      const [cid, mid] = k.split(':');
      const chore = (home.chores || []).find((c) => c.id === cid);
      const sw = doc.swaps || {};
      const swapped = groups[k].find((s) => sw[s.id] && sw[s.id].state === 'claimed' && sw[s.id].to === mid);
      if (mid === '-') { out[k] = 'Everyone has this one on their can’t-do list, so nobody has it. Take it off someone’s list, or do it together.'; continue; }
      if (swapped) {
        const n = groups[k].filter((s) => sw[s.id] && sw[s.id].state === 'claimed' && sw[s.id].to === mid).length;
        out[k] = groups[k].length > 1
          ? name(mid) + ' took ' + (n === groups[k].length ? 'these' : (NUMBERS[n] || n) + ' of these') + ' from ' + name(sw[swapped.id].from) + ' - the points moved with ' + (n === 1 ? 'it.' : 'them.')
          : name(mid) + ' took this from ' + name(sw[swapped.id].from) + ' - the points moved with it.';
        continue;
      }
      const can = able(cid);
      const holders = (history || []).slice(0, 4).map((d) => mainHolder(d, cid));
      let run = 0; const prev = holders[0];
      while (prev && run < holders.length && holders[run] === prev) run++;
      const daily = chore.freq === 'daily' || chore.freq === 'often';
      if (prev && prev !== mid && memberOf(home, prev) && !daily) {
        out[k] = name(mid) + '’s turn this week - ' + name(prev) + ' had it ' + (run >= 2 ? 'the last ' + (NUMBERS[run] || run) + ' weeks.' : 'last week.');
        continue;
      }
      if (can.length < members.filter((m) => m.weight > 0).length && can.length <= 2) {
        out[k] = 'Only ' + nameList(can.map((m) => m.name)) + ' can do this one - the others have it on their can’t-do list.';
        continue;
      }
      if (prev === mid && !daily) {
        out[k] = name(mid) + ' has it again - giving it to anyone else would have made the week lopsided.';
        continue;
      }
      if (daily && groups[k].length < weekSlots([chore], doc.week, home.since).length) {
        out[k] = 'Shared out by day, so it isn’t always the same person.';
        continue;
      }
      out[k] = 'It evens out everyone’s points this week.';
    }
    return out;
  }
  function lower(s) { return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s; }

  /** Per person: {id, total, done, slots: [{id, chore, day, pts, done, swap}]}. */
  function board(home, doc) {
    const eff = effective(doc);
    const by = {};
    for (const m of home.members || []) by[m.id] = { id: m.id, total: 0, done: 0, slots: [] };
    const nobody = { id: null, total: 0, done: 0, slots: [] };
    for (const s of weekSlots(home.chores || [], doc.week, home.since)) {
      const mid = eff[s.id];
      const t = doc.ticks && doc.ticks[s.id];
      const row = by[mid] || nobody;
      const sw = doc.swaps && doc.swaps[s.id];
      row.slots.push({ id: s.id, chore: s.chore, n: s.n, day: s.day, pts: s.pts, done: Boolean(t), doneBy: t ? t.who : null, swap: sw || null });
      row.total += s.pts;
      if (t) row.done += s.pts;
    }
    const rows = Object.values(by);
    if (nobody.slots.length) rows.push(nobody);
    return rows;
  }

  /** Fairness: this week (planned and done) and the last four weeks (done),
   *  against each person's fair share by weight, plus one plain line. */
  function fairness(home, docs) {
    const members = home.members || [];
    const cur = docs[0];
    const totalW = members.reduce((s, m) => s + (m.weight || 0), 0) || 1;
    const eff = cur ? effective(cur) : {};
    const planned = {};
    if (cur) for (const s of weekSlots(home.chores || [], cur.week, home.since)) if (eff[s.id]) planned[eff[s.id]] = (planned[eff[s.id]] || 0) + s.pts;
    const month = docs.slice(0, LIMITS.historyWeeks);
    const rows = members.map((m) => ({
      id: m.id,
      fair: (m.weight || 0) / totalW,
      week: { planned: planned[m.id] || 0, done: cur ? doneBy(cur, m.id) : 0 },
      month: month.reduce((s, d) => s + doneBy(d, m.id), 0),
    }));
    const monthTotal = rows.reduce((s, r) => s + r.month, 0);
    for (const r of rows) r.share = monthTotal ? r.month / monthTotal : 0;
    let line;
    if (!monthTotal) line = 'Nothing ticked yet. As chores get done, this shows who is carrying the house.';
    else {
      const most = rows.slice().sort((a, b) => (b.share - b.fair) - (a.share - a.fair) || b.month - a.month)[0];
      const m = memberOf(home, most.id);
      const span = month.length > 1 ? 'in the last ' + (NUMBERS[month.length] || month.length) + ' weeks' : 'this week';
      if (rows.every((r) => Math.abs(r.share - r.fair) < 0.05)) line = 'Nicely shared: everyone is within 5% of their fair share ' + span + '.';
      else line = m.name + ' did ' + pct(most.share) + ' of the work ' + span + ' - a fair share is ' + pct(most.fair) + '.';
    }
    return { rows, monthTotal, weeks: month.length, line };
  }

  /** Weeks in a row this person finished everything they had (this week
   *  counts once it is all done; a week with nothing for them neither
   *  counts nor breaks it). docs newest first. */
  function streak(home, docs, mid) {
    let n = 0;
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      const eff = effective(d);
      const mine = weekSlots(home.chores || [], d.week, home.since).filter((s) => eff[s.id] === mid);
      if (!mine.length) continue;
      const all = mine.every((s) => d.ticks && d.ticks[s.id]);
      if (all) { n++; continue; }
      if (i === 0) continue; // this week is still going
      break;
    }
    return n;
  }

  /** One summary line for the week's split. */
  function weekSummary(home, doc) {
    const members = (home.members || []).filter((m) => m.weight > 0);
    const slots = weekSlots(home.chores || [], doc.week, home.since);
    const total = slots.reduce((s, x) => s + x.pts, 0);
    const W = members.reduce((s, m) => s + m.weight, 0) || 1;
    if (!slots.length) return 'Nothing is due this week.';
    const per = total / W;
    const part = members.filter((m) => m.weight !== 1);
    return plural(total, 'point') + ' of chores, about ' + Math.round(per) + ' for each full share' +
      (part.length ? ' (' + sharePhrase(part) + ')' : '') + '.';
  }

  /** "a quarter", "half", "three quarters"... for a weight. */
  function shareWord(w) {
    return { 0.25: 'a quarter', 0.5: 'half', 0.75: 'three quarters', 1: 'a full share', 1.25: 'a bit more', 1.5: 'one and a half' }[w] || String(w);
  }
  /** "Sofia counts three quarters and Mateo half", "Ana and Ben count half". */
  function sharePhrase(people) {
    const by = {};
    const order = [];
    for (const m of people) { const k = shareWord(m.weight); if (!by[k]) { by[k] = []; order.push(k); } by[k].push(m.name); }
    return order.map((k, i) => nameList(by[k]) + (i === 0 ? (by[k].length === 1 ? ' counts ' : ' count ') : ' ') + k).join(order.length > 2 ? ', ' : ' and ');
  }

  /** A friendly nudge for the share sheet. Never sent by the app. */
  function nudgeText(member, chore, slot, todayIdx) {
    const when = slot.day === null || slot.day === undefined ? 'this week'
      : slot.day === todayIdx ? 'today' : slot.day === (todayIdx + 1) % 7 ? 'tomorrow' : 'on ' + DAY_NAMES[slot.day];
    if (chore.nudge) return 'Hey ' + member.name + ' - ' + chore.nudge + (when === 'today' ? '' : ' (' + when + ')') + ' ' + chore.emoji + ' Thank you!';
    return 'Hey ' + member.name + ' - ' + lower(chore.name) + ' is yours ' + when + ' ' + chore.emoji + ' Thank you!';
  }

  /** Starter chores for a template, ready for cleanHome. */
  function templateChores(id) {
    const t = TEMPLATES.find((x) => x.id === id) || TEMPLATES[0];
    return t.chores.map((c) => ({ name: c[0], emoji: c[1], effort: c[2], freq: c[3], ...(c[4] ? { nudge: c[4] } : {}) }));
  }

  return {
    LIMITS, FREQS, FREQ_IDS, EFFORT, EFFORT_HINT, WEIGHTS, WEIGHT_VALUES, EMOJI, DAYS, DAY_NAMES, TEMPLATES,
    clean, cleanName, cleanEmoji, cleanChoreEmoji, cleanEffort, cleanFreq, cleanWeight, cleanTz, cleanChore, cleanMemberFields, cleanHome,
    isMemberId, isChoreId, isSlotId, isWeek, newId, fail, nameList, plural, pct, hash32,
    localDate, weekKey, dayIndex, addWeeks, weeksBetween, weekIndex, dayDate, weekLabel, weekday,
    slotsFor, weekSlots, partialWeek, basisOf, effective, recency, deal, pinsOf, needsDeal, ensureWeek,
    tick, untick, swap, applyPatch, slotOf,
    explain, board, fairness, streak, weekSummary, shareWord, sharePhrase, nudgeText, templateChores, lower,
  };
});
