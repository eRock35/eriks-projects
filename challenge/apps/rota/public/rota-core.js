/* Rota - the rules. One file, run three times: in the page (window.RotaCore),
 * in the server (require) and in the tests. It holds:
 *
 *   - cleaning: every typed string goes through one door (markup, control
 *     and direction characters stripped, bounded); a person is a first name
 *     and at most an initial;
 *   - time: shifts are civil times in the business's own zone, turned into
 *     real instants with Intl - so a shift across a daylight-saving change is
 *     as long as it really is, and rest is counted in real hours;
 *   - the rules every placement must keep: the role, "can't", the hours a
 *     person said, no overlaps, the rest between a close and the next day's
 *     open, the max hours;
 *   - "Fill the gaps": a deterministic solver (most-constrained seat first,
 *     then the fairest candidate) that explains every placement and every
 *     seat it could not fill;
 *   - fairness: hours against target, closes, weekends, "prefer not"s used,
 *     a score, and who has been short-changed over the last four weeks;
 *   - swaps, the change log, the views a manager and a staff phone see, the
 *     .ics, templates and the sample cafe.
 *
 * No clock and no dice: anything that needs "now" is handed it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotaCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = {
    people: 30,          // a team
    roles: 8,            // stations a team names
    shifts: 140,         // shifts in one week
    need: 10,            // people on one shift
    name: 24,            // a first name (plus an initial)
    team: 48,            // the business's name
    role: 20,
    note: 120,           // a staff member's note for the week
    weeks: 6,            // weeks kept (fairness looks back four)
    log: 200,            // change-log entries kept
    swaps: 60,           // swaps in one week
    hours: 80,           // max hours a person can be set to
    minRest: [0, 8, 9, 10, 11, 12],
    text: 6000,          // pasted texts, for "Read their texts"
  };
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const STATES = ['can', 'prefer', 'cant'];
  const STATE_LABEL = { can: 'Can', prefer: 'Prefer not', cant: 'Can’t' };
  const HOUR = 3600000;

  /* ------------------------------------------------------------------ *
   * Cleaning
   * ------------------------------------------------------------------ */

  // Control characters, zero-width and bidi overrides/isolates, BOM.
  const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
  /** Any typed string: tags and stray angle brackets out, control and bidi
   *  characters out, whitespace collapsed, cut to `max` characters. Huge
   *  input is cut before any pattern runs. Only strings. */
  function clean(v, max) {
    if (typeof v !== 'string') return '';
    const m = Math.max(1, max || 200);
    let s = v.slice(0, m * 4 + 64);
    s = s.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, '').replace(CTRL, '').replace(/\s+/g, ' ').trim();
    return Array.from(s).slice(0, m).join('').trim();
  }
  /** A first name, and at most an initial: "Mia Rodriguez" -> "Mia R.". A
   *  team link shows first names only, so the rule lives here, not in copy. */
  function firstName(v) {
    const s = clean(v, 80).replace(/[^\p{L}\p{M}'’ .-]/gu, ' ').replace(/\s+/g, ' ').trim();
    const words = s.split(' ').map((w) => w.replace(/^[.'’-]+|[.'’-]+$/g, '')).filter(Boolean);
    if (!words.length) return '';
    const first = Array.from(words[0]).slice(0, 20).join('');
    const initial = words[1] ? `${Array.from(words[1])[0].toUpperCase()}.` : '';
    return Array.from(initial ? `${first} ${initial}` : first).slice(0, LIMITS.name).join('');
  }
  /** Case, accents and punctuation folded: "zoë" meets "Zoe". */
  function fold(v) {
    return String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function cleanRole(v) { return clean(v, LIMITS.role); }
  function intIn(v, lo, hi) { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; }

  /* ------------------------------------------------------------------ *
   * Civil time
   * ------------------------------------------------------------------ */

  const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  /** "6:30" -> "06:30"; anything else -> null. */
  function cleanTime(v) {
    const m = TIME_RE.exec(String(v == null ? '' : v).trim());
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
  }
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  /** 390 -> "6:30am", 1080 -> "6pm", 0 or 1440 -> "midnight". */
  function fmtTime(t) {
    let m = typeof t === 'number' ? t : toMin(t);
    m = ((m % 1440) + 1440) % 1440;
    if (m === 0) return 'midnight';
    if (m === 720) return 'noon';
    const h = Math.floor(m / 60); const mm = m % 60;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
  }
  function cleanDate(v) {
    const m = DATE_RE.exec(String(v || ''));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0] : null;
  }
  const dayMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  function addDays(s, n) { return isoOf(dayMs(s) + n * 86400000); }
  /** 0 = Monday ... 6 = Sunday. */
  function weekday(s) { return (new Date(dayMs(s)).getUTCDay() + 6) % 7; }
  function mondayOf(s) { return addDays(s, -weekday(s)); }
  function isMonday(s) { return Boolean(cleanDate(s)) && weekday(s) === 0; }
  /** "Mon 26 Oct". */
  function dayLabel(s) { const d = new Date(dayMs(s)); return `${DAYS[weekday(s)]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; }
  function weekLabel(week) {
    const a = new Date(dayMs(week)); const b = new Date(dayMs(addDays(week, 6)));
    return a.getUTCMonth() === b.getUTCMonth()
      ? `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`
      : `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`;
  }

  const zoneCache = {};
  function zoneOk(z) {
    if (typeof z !== 'string' || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(z) || z.length > 40) return false;
    if (zoneCache[z] !== undefined) return Boolean(zoneCache[z]);
    try { zoneCache[z] = new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); } catch (e) { zoneCache[z] = false; }
    return Boolean(zoneCache[z]);
  }
  function cleanZone(z) { return zoneOk(z) ? z : 'UTC'; }
  /** Minutes east of UTC that `zone` reads at instant `ms`. */
  function offsetMin(zone, ms) {
    if (!zoneOk(zone)) return 0;
    const parts = {};
    for (const p of zoneCache[zone].formatToParts(new Date(ms))) parts[p.type] = p.value;
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
  }
  /** The instant a wall clock in `zone` reads `date` `min` minutes after
   *  midnight. A time the clocks skip (2:30 on the spring-forward night)
   *  lands just after the gap; a time they repeat takes the first. */
  function wallToUtc(date, min, zone) {
    const guess = dayMs(date) + min * 60000;
    let t = guess - offsetMin(zone, guess) * 60000;
    t = guess - offsetMin(zone, t) * 60000;
    const early = t - HOUR;
    if (early + offsetMin(zone, early) * 60000 === guess) return early;
    return t;
  }
  /** Today's date in `zone`, from an instant. */
  function todayIn(zone, ms) {
    const o = offsetMin(cleanZone(zone), ms);
    return isoOf(ms + o * 60000);
  }
  /** The week a manager plans: next Monday in the business's zone. */
  function nextWeekOf(today) { return addDays(mondayOf(today), 7); }

  /* ------------------------------------------------------------------ *
   * A team, its people and its weeks
   * ------------------------------------------------------------------ */

  function cleanHours(list) {
    const out = [];
    for (let d = 0; d < 7; d++) {
      const h = Array.isArray(list) ? list[d] : null;
      const open = h && cleanTime(h.open); const close = h && cleanTime(h.close);
      out.push(open && close ? { open, close } : null);
    }
    return out;
  }
  function cleanRoles(list) {
    const out = [];
    for (const r of Array.isArray(list) ? list.slice(0, 40) : []) {
      const c = cleanRole(r);
      if (c && !out.some((x) => fold(x) === fold(c)) && out.length < LIMITS.roles) out.push(c);
    }
    return out;
  }
  /** The team's settings, cleaned. */
  function cleanSettings(s, prev) {
    const p = prev || {};
    const b = s && typeof s === 'object' ? s : {};
    const pick = (k, f, dflt) => (b[k] !== undefined ? f(b[k]) : p[k] !== undefined ? p[k] : dflt);
    const rest = Number(pick('minRest', (v) => (LIMITS.minRest.includes(Number(v)) ? Number(v) : 10), 10));
    return {
      name: pick('name', (v) => clean(v, LIMITS.team) || p.name || 'Our team', 'Our team'),
      zone: pick('zone', cleanZone, 'UTC'),
      minRest: LIMITS.minRest.includes(rest) ? rest : 10,
      hours: pick('hours', cleanHours, cleanHours(null)),
      roles: pick('roles', (v) => { const r = cleanRoles(v); return r.length ? r : (p.roles || ['Team']); }, ['Team']),
      autoApprove: pick('autoApprove', (v) => v === true, false),
    };
  }
  /** A role as the team spells it, or null. */
  function roleIn(team, v) {
    const k = fold(v);
    return team.roles.find((r) => fold(r) === k) || null;
  }
  function cleanPersonFields(team, b, prev) {
    const p = prev || {};
    const o = b && typeof b === 'object' ? b : {};
    const roles = o.roles !== undefined ? (Array.isArray(o.roles) ? o.roles.map((r) => roleIn(team, r)).filter(Boolean).filter((r, i, a) => a.indexOf(r) === i) : []) : (p.roles || []);
    const max = o.maxHours !== undefined ? intIn(o.maxHours, 1, LIMITS.hours) : (p.maxHours !== undefined ? p.maxHours : null);
    let target = o.targetHours !== undefined ? intIn(o.targetHours, 1, LIMITS.hours) : (p.targetHours !== undefined ? p.targetHours : null);
    if (target !== null && max !== null && target > max) target = max;
    return { roles, maxHours: max, targetHours: target };
  }
  function cleanAvailDays(days) {
    const out = [];
    for (let d = 0; d < 7; d++) {
      const x = Array.isArray(days) ? days[d] : null;
      const s = x && STATES.includes(x.s) ? x.s : null;
      let from = s && s !== 'cant' ? cleanTime(x.from) : null;
      let to = s && s !== 'cant' ? cleanTime(x.to) : null;
      if (from && to && toMin(to) <= toMin(from)) { from = null; to = null; }
      out.push(s ? { s, from, to } : null);
    }
    return out;
  }

  const ID_ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
  /** Ids from a seed string, so the core needs no dice: the server hands a
   *  random seed in, the sample hands a fixed one. */
  function idFrom(prefix, seed, n) {
    let h = 2166136261;
    let out = '';
    const s = String(seed);
    for (let k = 0; out.length < n; k++) {
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) + k; h = Math.imul(h, 16777619) >>> 0; }
      out += ID_ALPHA[h % ID_ALPHA.length];
    }
    return prefix + out;
  }
  const SHIFT_ID = /^s[a-z0-9]{6,12}$/;
  const PID = /^p[a-z0-9]{6,12}$/;
  const SWAP_ID = /^w[a-z0-9]{6,12}$/;

  function cleanShift(team, x, id) {
    if (!x || typeof x !== 'object') return null;
    const day = intIn(x.day, 0, 6);
    const start = cleanTime(x.start); const end = cleanTime(x.end);
    const role = roleIn(team, x.role);
    if (day === null || !start || !end || !role || start === end) return null;
    const need = intIn(x.need, 1, LIMITS.need) || 1;
    const sid = SHIFT_ID.test(x.id) ? x.id : id;
    return { id: sid, day, start, end, role, need };
  }
  function emptyWeek() { return { shifts: [], assign: {}, avail: {}, published: false, publishedAt: null, swaps: [] }; }
  function newDoc(settings, now) {
    const at = new Date(now).toISOString();
    return { team: cleanSettings(settings), people: [], weeks: {}, log: [], createdAt: at, updatedAt: at, v: 1 };
  }
  function weekOf(doc, week, create) {
    if (!isMonday(week)) throw err(400, 'Pick a week that starts on a Monday.');
    if (!doc.weeks[week] && create) {
      doc.weeks[week] = emptyWeek();
      // Keep the newest weeks only.
      const keys = Object.keys(doc.weeks).sort();
      while (keys.length > LIMITS.weeks) delete doc.weeks[keys.shift()];
      if (!doc.weeks[week]) throw err(400, 'That week is too far back to change.');
    }
    return doc.weeks[week] || null;
  }
  function personOf(doc, pid) { return doc.people.find((p) => p.id === pid) || null; }
  function err(status, message) { return Object.assign(new Error(message), { status, expose: true }); }

  /* ------------------------------------------------------------------ *
   * Shift times and the rules
   * ------------------------------------------------------------------ */

  /** A shift's real start and end, its length in real hours, and whether it
   *  is an open, a close or a weekend shift. Overnight when end <= start. */
  function shiftTimes(team, week, s) {
    const date = addDays(week, s.day);
    const sMin = toMin(s.start); const eMin = toMin(s.end);
    const overnight = eMin <= sMin;
    const startMs = wallToUtc(date, sMin, team.zone);
    const endMs = wallToUtc(overnight ? addDays(date, 1) : date, eMin, team.zone);
    const h = team.hours && team.hours[s.day];
    const close = overnight || (h ? eMin >= toMin(h.close) - 30 : eMin >= 21 * 60);
    const open = !overnight && (h ? sMin <= toMin(h.open) + 30 : sMin <= 8 * 60);
    return { date, startMs, endMs, hours: Math.round((endMs - startMs) / 60000) / 60, overnight, close, open, weekend: s.day >= 5, sMin, eMin: overnight ? eMin + 1440 : eMin };
  }
  function shiftLabel(s) { return `${DAYS[s.day]} ${fmtTime(s.start)}–${fmtTime(s.end)} ${s.role}`; }
  const hrs = (h) => `${Math.round(h * 10) / 10} h`;

  /** Everything the rules need for one week, worked out once. */
  function context(doc, week) {
    const w = doc.weeks[week] || emptyWeek();
    const team = doc.team;
    const t = {};
    for (const s of w.shifts) t[s.id] = shiftTimes(team, week, s);
    const prevWeek = addDays(week, -7);
    const pw = doc.weeks[prevWeek];
    const prev = {}; // pid -> [{startMs, endMs, date}] from last week, for rest
    if (pw) {
      for (const s of pw.shifts) {
        const st = shiftTimes(team, prevWeek, s);
        for (const a of pw.assign[s.id] || []) (prev[a.pid] = prev[a.pid] || []).push({ startMs: st.startMs, endMs: st.endMs, date: st.date, label: shiftLabel(s) });
      }
    }
    return { doc, team, week, w, t, prev, history: history(doc, week) };
  }
  function availOf(w, pid, day) {
    const a = w.avail && w.avail[pid] && w.avail[pid].days ? w.avail[pid].days[day] : null;
    return a || { s: null, from: null, to: null };
  }
  function noCloses(w, pid) { return Boolean(w.avail && w.avail[pid] && w.avail[pid].noCloses); }
  /** pid -> the shift ids they hold this week, from an assign map. */
  function holdings(w, assign) {
    const out = {};
    for (const s of w.shifts) for (const a of (assign || w.assign)[s.id] || []) (out[a.pid] = out[a.pid] || []).push(s.id);
    return out;
  }
  function hoursOf(ctx, ids) { return ids.reduce((sum, id) => sum + (ctx.t[id] ? ctx.t[id].hours : 0), 0); }

  /** Why `pid` cannot take shift `sid`, given what they already hold
   *  (`held`, their other shift ids). Empty means they can. Each reason is
   *  {code, text}, the text written to stand after a name. */
  function blockers(ctx, sid, pid, held) {
    const p = personOf(ctx.doc, pid);
    const s = ctx.w.shifts.find((x) => x.id === sid);
    if (!p || !s) return [{ code: 'gone', text: 'is not on the team' }];
    const st = ctx.t[sid];
    const out = [];
    if (!p.roles.includes(s.role)) out.push({ code: 'role', text: `doesn’t do ${s.role}` });
    const a = availOf(ctx.w, pid, s.day);
    if (st.close && noCloses(ctx.w, pid)) out.push({ code: 'noclose', text: 'asked for no closes' });
    if (a.s === 'cant') out.push({ code: 'cant', text: `can’t ${DAYS[s.day]}` });
    else {
      if (a.from && st.sMin < toMin(a.from)) out.push({ code: 'window', text: `only from ${fmtTime(a.from)} ${DAYS[s.day]}` });
      if (a.to && st.eMin > toMin(a.to)) out.push({ code: 'window', text: `only until ${fmtTime(a.to)} ${DAYS[s.day]}` });
    }
    const mine = (held || []).filter((id) => id !== sid && ctx.t[id]);
    for (const id of mine) {
      const o = ctx.t[id];
      if (o.startMs < st.endMs && st.startMs < o.endMs) { out.push({ code: 'overlap', text: `is on ${shiftLabel(ctx.w.shifts.find((x) => x.id === id))}` }); break; }
    }
    const rest = ctx.team.minRest * HOUR;
    if (rest) {
      const others = mine.map((id) => ({ ...ctx.t[id], label: shiftLabel(ctx.w.shifts.find((x) => x.id === id)) })).concat(ctx.prev[pid] || []);
      for (const o of others) {
        if (o.date === st.date) continue; // same-day split shifts are not a close-then-open
        const gap = o.endMs <= st.startMs ? st.startMs - o.endMs : st.endMs <= o.startMs ? o.startMs - st.endMs : -1;
        if (gap >= 0 && gap < rest) {
          out.push({ code: 'rest', text: o.endMs <= st.startMs ? `needs ${ctx.team.minRest} h rest after ${o.label}` : `needs ${ctx.team.minRest} h rest before ${o.label}` });
          break;
        }
      }
    }
    if (p.maxHours !== null && p.maxHours !== undefined) {
      const total = hoursOf(ctx, mine) + st.hours;
      if (total > p.maxHours + 1e-9) out.push({ code: 'max', text: `would go past ${p.maxHours} h max (${hrs(total)})` });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * History: the four weeks fairness looks at
   * ------------------------------------------------------------------ */

  function weekStats(doc, week) {
    const w = doc.weeks[week];
    const out = {};
    for (const p of doc.people) out[p.id] = { hours: 0, shifts: 0, closes: 0, opens: 0, weekends: 0, preferNots: 0, target: p.targetHours, max: p.maxHours };
    if (!w) return out;
    for (const s of w.shifts) {
      const st = shiftTimes(doc.team, week, s);
      for (const a of w.assign[s.id] || []) {
        const r = out[a.pid];
        if (!r) continue;
        r.hours += st.hours; r.shifts += 1;
        if (st.close) r.closes += 1;
        if (st.open) r.opens += 1;
        if (st.weekend) r.weekends += 1;
        if (availOf(w, a.pid, s.day).s === 'prefer') r.preferNots += 1;
      }
    }
    for (const r of Object.values(out)) r.hours = Math.round(r.hours * 100) / 100;
    return out;
  }
  /** The (up to) three weeks before `week` that have anything assigned. */
  function pastWeeks(doc, week) {
    return Object.keys(doc.weeks).filter((k) => k < week && Object.values(doc.weeks[k].assign || {}).some((l) => l.length)).sort().slice(-3);
  }
  function history(doc, week) {
    const weeks = pastWeeks(doc, week);
    const out = {};
    for (const p of doc.people) out[p.id] = { weeks: 0, hours: 0, closes: 0, weekends: 0, preferNots: 0, under: 0 };
    for (const k of weeks) {
      const st = weekStats(doc, k);
      for (const [pid, r] of Object.entries(st)) {
        const h = out[pid];
        if (!h) continue;
        h.weeks += 1; h.hours += r.hours; h.closes += r.closes; h.weekends += r.weekends; h.preferNots += r.preferNots;
        if (r.target) h.under += Math.max(0, r.target - r.hours);
      }
    }
    return { weeks, people: out };
  }

  /* ------------------------------------------------------------------ *
   * Fill the gaps
   * ------------------------------------------------------------------ */

  /** How much we'd rather NOT give `pid` this shift (lower is better), and
   *  the plain-words reasons behind it. */
  function preference(ctx, sid, pid, held) {
    const p = personOf(ctx.doc, pid);
    const s = ctx.w.shifts.find((x) => x.id === sid);
    const st = ctx.t[sid];
    const h = ctx.history.people[pid] || { closes: 0, weekends: 0, preferNots: 0, under: 0, weeks: 0 };
    const mine = (held || []).filter((id) => id !== sid);
    const now = hoursOf(ctx, mine);
    const a = availOf(ctx.w, pid, s.day);
    let score = 0;
    const why = [];
    if (a.s === 'prefer') { score += 30 + 5 * h.preferNots; why.push(`said “prefer not” for ${DAYS[s.day]}`); }
    else if (a.s === 'can') why.push(`said they can ${DAYS[s.day]}`);
    else { score += 6; why.push('hasn’t marked availability yet'); }
    if (p.targetHours) {
      const after = now + st.hours;
      const need = (p.targetHours - now) / p.targetHours;
      score -= 14 * need + 0.4 * Math.max(0, p.targetHours - now);
      if (after > p.targetHours) score += 12 * (after - p.targetHours) / p.targetHours;
      score -= Math.min(6, h.under / Math.max(1, h.weeks) / 2); // short last month: a nudge up the list
      why.push(`${hrs(now)} → ${hrs(after)} of a ${p.targetHours} h target`);
    } else {
      score += now * 0.4;
      why.push(`${hrs(now)} so far this week`);
    }
    // Someone who can work many roles is worth saving for the shifts only
    // they can cover; a one-role person goes first for their one role.
    score += 2 * Math.max(0, p.roles.length - 1);
    const thisWeek = mine.map((id) => ctx.t[id]);
    if (st.close) {
      const c = thisWeek.filter((x) => x.close).length;
      score += 8 * c + 3 * h.closes;
      why.push(`${c ? `${ordinal(c + 1)} close this week` : 'first close this week'}, ${h.closes} in the last ${Math.max(1, h.weeks)} wk`);
    }
    if (st.weekend) {
      const c = thisWeek.filter((x) => x.weekend).length;
      score += 6 * c + 2 * h.weekends;
      why.push(`${c ? `${ordinal(c + 1)} weekend shift` : 'first weekend shift'} this week`);
    }
    return { score: Math.round(score * 1000) / 1000, why };
  }
  function ordinal(n) { return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`; }

  /** Every person, for one shift: can they take it, and how good a fit.
   *  `except` leaves one holder out (to explain them, or for a swap). */
  function candidates(doc, week, sid, opts) {
    const o = opts || {};
    const ctx = o.ctx || context(doc, week);
    const assign = o.assign || ctx.w.assign;
    const held = holdings(ctx.w, assign);
    const on = (assign[sid] || []).map((a) => a.pid).filter((p) => p !== o.except);
    const out = [];
    for (const p of doc.people) {
      const mine = (held[p.id] || []).filter((id) => id !== sid);
      const b = blockers(ctx, sid, p.id, mine);
      const pref = preference(ctx, sid, p.id, mine);
      out.push({ pid: p.id, name: p.name, on: on.includes(p.id), ok: !b.length && !on.includes(p.id), blockers: b, score: pref.score, why: pref.why, avail: availOf(ctx.w, p.id, ctx.w.shifts.find((x) => x.id === sid).day).s });
    }
    out.sort((x, y) => (x.ok === y.ok ? x.score - y.score || x.name.localeCompare(y.name) || x.pid.localeCompare(y.pid) : x.ok ? -1 : 1));
    return out;
  }

  /** Why a seat could not be filled, in one sentence a manager can act on:
   *  "Sun 7:30am–3:30pm Kitchen: nobody available who can do Kitchen -
   *  Jonah can’t Sun · Lena can’t Sun". */
  function gapReason(ctx, sid, list) {
    const s = ctx.w.shifts.find((x) => x.id === sid);
    const doers = list.filter((c) => !c.blockers.some((b) => b.code === 'role'));
    const head = `${shiftLabel(s)}: `;
    if (!doers.length) return { text: `${head}nobody on the team can do ${s.role}`, fix: `Add ${s.role} to someone’s roles, or change the shift’s role.` };
    const free = doers.filter((c) => !c.on);
    // The decisive reason first: someone who can't that day is just "can't".
    const decisive = (c) => { const hard = c.blockers.filter((b) => b.code === 'cant' || b.code === 'role'); return (hard.length ? hard : c.blockers).map((b) => b.text).join(', '); };
    const lines = free.map((c) => `${c.name} ${decisive(c)}`);
    const detail = lines.slice(0, 4).join(' · ') + (lines.length > 4 ? ` · and ${lines.length - 4} more` : '');
    const allCant = free.length && free.every((c) => c.blockers.some((b) => b.code === 'cant' || b.code === 'window' || b.code === 'noclose'));
    return {
      text: `${head}nobody available who can do ${s.role}${detail ? ` - ${detail}` : ''}`,
      fix: allCant ? 'Ask around, bring in cover, or shorten the shift.' : 'Raise someone’s max hours, move a shift, or bring in cover.',
    };
  }

  /** The solver. Keeps every seat already filled (by the manager, a swap or
   *  an earlier fill), then fills the rest: the seat with the fewest people
   *  who could take it goes first, to the candidate the rules like best
   *  (can over "prefer not", toward their target hours, closes and
   *  weekends spread across this week and the last three). Deterministic:
   *  the same team gives the same rota. Returns {assign, placed, gaps}. */
  function fill(doc, week) {
    const ctx = context(doc, week);
    const assign = {};
    for (const s of ctx.w.shifts) assign[s.id] = (ctx.w.assign[s.id] || []).slice(0, s.need).map((a) => ({ ...a }));
    const open = {};
    for (const s of ctx.w.shifts) open[s.id] = s.need - assign[s.id].length;
    const placed = [];
    const gaps = [];
    const order = ctx.w.shifts.slice().sort((a, b) => ctx.t[a.id].startMs - ctx.t[b.id].startMs || a.id.localeCompare(b.id));
    for (;;) {
      let pick = null;
      for (const s of order) {
        if (open[s.id] <= 0) continue;
        const list = candidates(doc, week, s.id, { ctx, assign });
        const n = list.filter((c) => c.ok).length;
        if (!pick || n < pick.n) pick = { s, n, list };
        if (n === 0) break;
      }
      if (!pick) break;
      if (pick.n === 0) {
        gaps.push({ shiftId: pick.s.id, seats: open[pick.s.id], ...gapReason(ctx, pick.s.id, pick.list) });
        open[pick.s.id] = 0;
        continue;
      }
      const best = pick.list[0];
      assign[pick.s.id].push({ pid: best.pid, by: 'fill' });
      open[pick.s.id] -= 1;
      placed.push({ shiftId: pick.s.id, pid: best.pid });
    }
    // Repair: a seat the greedy pass left open may be fillable by moving one
    // of its own placements - X is only blocked by hours, overlap or rest,
    // so hand one of X's filled shifts to Z, and X takes the gap.
    const moved = [];
    for (let gi = 0; gi < gaps.length; gi++) {
      const g = gaps[gi];
      let left = g.seats;
      for (let seat = 0; seat < g.seats; seat++) {
        if (!repairOne(doc, week, ctx, assign, g.shiftId, moved, placed)) break;
        left -= 1;
      }
      if (left === 0) { gaps.splice(gi, 1); gi -= 1; }
      else if (left !== g.seats) { g.seats = left; }
    }
    // Gap reasons are written against the final rota.
    for (const g of gaps) Object.assign(g, gapReason(ctx, g.shiftId, candidates(doc, week, g.shiftId, { ctx, assign })));
    return { assign, placed, gaps, moved };
  }
  function repairOne(doc, week, ctx, assign, gid, moved, placed) {
    const list = candidates(doc, week, gid, { ctx, assign });
    const soft = list.filter((c) => !c.on && c.blockers.length && c.blockers.every((b) => b.code === 'max' || b.code === 'overlap' || b.code === 'rest'));
    for (const x of soft) {
      const held = holdings(ctx.w, assign);
      const mine = (held[x.pid] || []).filter((id) => (assign[id] || []).some((a) => a.pid === x.pid && a.by === 'fill'));
      mine.sort((a, b) => ctx.t[a].startMs - ctx.t[b].startMs);
      for (const y of mine) {
        const rest = (held[x.pid] || []).filter((id) => id !== y);
        if (blockers(ctx, gid, x.pid, rest).length) continue;
        const trial = {};
        for (const [k, v] of Object.entries(assign)) trial[k] = k === y ? v.filter((a) => a.pid !== x.pid) : v;
        trial[gid] = (trial[gid] || []).concat([{ pid: x.pid, by: 'fill' }]);
        const zs = candidates(doc, week, y, { ctx, assign: trial }).filter((c) => c.ok && c.pid !== x.pid);
        if (!zs.length) continue;
        const z = zs[0];
        assign[y] = trial[y].concat([{ pid: z.pid, by: 'fill' }]);
        assign[gid] = trial[gid];
        const py = placed.find((q) => q.shiftId === y && q.pid === x.pid);
        if (py) py.pid = z.pid;
        placed.push({ shiftId: gid, pid: x.pid });
        moved.push({ shiftId: y, from: x.pid, to: z.pid, freed: gid });
        return true;
      }
    }
    return false;
  }

  /** One placement in words: why this person, and who else could have. */
  function explain(doc, week, sid, pid) {
    const ctx = context(doc, week);
    const s = ctx.w.shifts.find((x) => x.id === sid);
    if (!s) return null;
    const list = candidates(doc, week, sid, { ctx, except: pid });
    const me = list.find((c) => c.pid === pid);
    if (!me) return null;
    const others = list.filter((c) => c.ok && c.pid !== pid);
    const lines = [`Can do ${s.role}`].concat(me.why);
    let versus = null;
    if (me.blockers.length) versus = `Breaks a rule: ${me.name} ${me.blockers.map((b) => b.text).join(', ')}.`;
    else if (others.length) {
      const r = others[0];
      versus = me.score <= r.score ? `A better fit than ${r.name}, who ${differ(me, r)}.` : `${r.name} would fit a little better now (${r.why[r.why.length - 1]}).`;
    } else versus = 'Nobody else could take it.';
    return { shift: shiftLabel(s), name: me.name, lines, versus, others: others.map((c) => c.name), blocked: list.filter((c) => !c.ok && c.pid !== pid && !c.on).map((c) => ({ name: c.name, text: c.blockers.map((b) => b.text).join(', ') })) };
  }
  function differ(a, b) {
    if (a.avail !== b.avail && b.avail === 'prefer') return 'said “prefer not”';
    const pick = b.why.find((w, i) => w !== a.why[i] && !/^said|hasn’t/.test(w));
    return pick ? `is at ${pick}` : 'is a close second';
  }

  /** Live conflicts: every assigned seat that breaks a rule, in words. */
  function conflicts(doc, week) {
    const ctx = context(doc, week);
    const held = holdings(ctx.w);
    const out = [];
    for (const s of ctx.w.shifts) {
      for (const a of ctx.w.assign[s.id] || []) {
        const b = blockers(ctx, s.id, a.pid, (held[a.pid] || []).filter((id) => id !== s.id));
        if (b.length) out.push({ shiftId: s.id, pid: a.pid, name: (personOf(doc, a.pid) || {}).name || '?', codes: b.map((x) => x.code), text: b.map((x) => x.text).join(', ') });
      }
      if ((ctx.w.assign[s.id] || []).length > s.need) out.push({ shiftId: s.id, pid: null, name: '', codes: ['over'], text: `has ${(ctx.w.assign[s.id] || []).length} people for ${s.need} places` });
    }
    return out;
  }
  /** Seats still open this week. */
  function openSeats(doc, week) {
    const w = doc.weeks[week];
    if (!w) return [];
    return w.shifts.filter((s) => (w.assign[s.id] || []).length < s.need).map((s) => ({ shiftId: s.id, seats: s.need - (w.assign[s.id] || []).length }));
  }
  /** Gaps in words: open seats that nobody could take as the week stands
   *  (after a fill or on reload). A seat someone could still take is just
   *  open, not a gap. */
  function gaps(doc, week) {
    const ctx = context(doc, week);
    const out = [];
    for (const g of openSeats(doc, week)) {
      const list = candidates(doc, week, g.shiftId, { ctx });
      if (!list.some((c) => c.ok)) out.push({ ...g, ...gapReason(ctx, g.shiftId, list) });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Fairness
   * ------------------------------------------------------------------ */

  /** The fairness panel for a week: per person, the week and the four-week
   *  window; a 0-100 score with what moved it; who has been short-changed. */
  function fairness(doc, week) {
    const cur = weekStats(doc, week);
    const weeks = pastWeeks(doc, week).concat([week]);
    const sums = {};
    for (const p of doc.people) sums[p.id] = { weeks: 0, hours: 0, target: 0, closes: 0, weekends: 0, preferNots: 0, shifts: 0 };
    for (const k of weeks) {
      const st = k === week ? cur : weekStats(doc, k);
      for (const [pid, r] of Object.entries(st)) {
        const x = sums[pid];
        x.weeks += 1; x.hours += r.hours; x.closes += r.closes; x.weekends += r.weekends; x.preferNots += r.preferNots; x.shifts += r.shifts;
        if (r.target) x.target += r.target;
      }
    }
    const people = doc.people.map((p) => ({ id: p.id, name: p.name, target: p.targetHours, max: p.maxHours, week: cur[p.id], window: sums[p.id] }));
    const parts = [];
    let score = 100;
    const withT = people.filter((p) => p.target);
    if (withT.length) {
      const off = withT.reduce((sum, p) => sum + Math.min(1, Math.abs(p.week.hours - p.target) / p.target), 0) / withT.length;
      const pts = Math.round(off * 60);
      score -= pts;
      parts.push({ id: 'hours', label: 'Hours vs targets', pts, text: off < 0.05 ? 'Everyone within 5% of the hours they asked for' : `On average ${Math.round(off * 100)}% away from the hours people asked for` });
    }
    // Closes and weekends: each person's share over the four weeks, against
    // a fair share in proportion to the shifts they worked.
    const totalShifts = people.reduce((sum, p) => sum + p.window.shifts, 0);
    const share = (key) => {
      const total = people.reduce((sum, p) => sum + p.window[key], 0);
      const rows = people.map((p) => ({ p, fair: totalShifts ? total * p.window.shifts / totalShifts : 0 }));
      rows.forEach((r) => { r.over = r.p.window[key] - r.fair; });
      const dev = total ? rows.reduce((sum, r) => sum + Math.abs(r.over), 0) / total : 0;
      rows.sort((x, y) => y.over - x.over || x.p.name.localeCompare(y.p.name));
      return { total, dev, top: rows[0], rows };
    };
    const n = weeks.length;
    const label = (k) => (k === 'closes' ? 'closes' : 'weekend shifts');
    const fairParts = {};
    for (const key of ['closes', 'weekends']) {
      const sh = share(key);
      fairParts[key] = sh;
      const pts = Math.round(sh.dev * 25);
      score -= pts;
      const top = sh.top;
      parts.push({ id: key, label: key === 'closes' ? 'Closes' : 'Weekends', pts, text: !sh.total ? 'None this month' : top && top.over >= 1.5 ? `${top.p.name} has ${Math.round(top.over)} more ${label(key)} than a fair share over ${n} wk` : `Everyone within a shift of a fair share over ${n} wk` });
    }
    const pn = people.reduce((sum, p) => sum + p.week.preferNots, 0);
    const pPts = pn * 3;
    score -= pPts;
    parts.push({ id: 'prefer', label: '“Prefer not”s used', pts: pPts, text: pn ? `${pn} shift${pn === 1 ? '' : 's'} this week on a day someone asked to avoid` : 'None this week' });
    score = Math.max(0, Math.min(100, Math.round(score)));
    const band = score >= 80 ? { id: 'fair', label: 'Fair' } : score >= 60 ? { id: 'mostly', label: 'Mostly fair' } : { id: 'uneven', label: 'Uneven' };
    // Short-changed over the window: well under target, carrying well over a
    // fair share of closes or weekends, or given "prefer not" days anyway.
    const short = [];
    for (const p of people) {
      const w = p.window;
      const why = [];
      if (w.target && w.target - w.hours >= 0.15 * w.target) why.push(`${Math.round((w.target - w.hours) / n)} h a week under the ${p.target || Math.round(w.target / n)} h target`);
      for (const key of ['closes', 'weekends']) {
        const r = fairParts[key].rows.find((x) => x.p.id === p.id);
        if (r && r.over >= 3) why.push(`${w[key]} ${label(key)} in ${n} wk - ${Math.round(r.over)} over a fair share`);
      }
      if (w.preferNots >= 2) why.push(`${w.preferNots} “prefer not” days given anyway`);
      if (why.length) short.push({ id: p.id, name: p.name, why });
    }
    return { week, weeks, score, band, parts, people, short };
  }

  /* ------------------------------------------------------------------ *
   * Changes (the same rules for the sample on a phone and a real team)
   * ------------------------------------------------------------------ */

  function logIt(doc, now, text) {
    doc.log = (doc.log || []).concat([{ at: new Date(now).toISOString(), text: clean(text, 240) }]).slice(-LIMITS.log);
  }
  function touch(doc, now) { doc.v = (doc.v || 0) + 1; doc.updatedAt = new Date(now).toISOString(); return doc; }
  function nameTaken(doc, name, except) { const k = fold(name); const hit = doc.people.find((p) => p.id !== except && fold(p.name) === k); return hit ? hit.name : null; }
  function needWeek(doc, week) { return weekOf(doc, week, true); }
  /** A phone may only touch this week and the next four - never create a
   *  far-off week that would push the team's history out. */
  function staffWeek(doc, week, now) {
    const cur = mondayOf(todayIn(doc.team.zone, now));
    if (!isMonday(week) || week < cur || week > addDays(cur, 28)) throw err(400, 'Pick this week or one of the next four.');
    return weekOf(doc, week, true);
  }
  /** A manager plans from five weeks back to eight ahead. */
  function managerWeek(doc, week, now) {
    const cur = mondayOf(todayIn(doc.team.zone, now));
    if (!isMonday(week) || week < addDays(cur, -35) || week > addDays(cur, 56)) throw err(400, 'Pick a week from the last five or the next eight.');
    return weekOf(doc, week, true);
  }
  function seq(doc, now) { let n = 0; return (k) => idFrom(k, `${now}:${doc.v}:${doc.people.length}:${n++}`, 9); }
  function dropPersonFrom(w, pid) {
    for (const k of Object.keys(w.assign)) w.assign[k] = w.assign[k].filter((a) => a.pid !== pid);
    delete w.avail[pid];
    w.swaps = w.swaps.filter((x) => x.from !== pid);
    for (const x of w.swaps) if (x.to === pid) { x.to = null; x.status = 'open'; }
  }
  function addPerson(doc, fields, pid, now, opts) {
    const o = opts || {};
    if (doc.people.length >= LIMITS.people) throw err(409, `A team holds ${LIMITS.people} people at most.`);
    const name = firstName(fields && fields.name);
    if (!name) throw err(400, 'Add a first name.');
    const taken = nameTaken(doc, name);
    if (taken) throw err(409, `There’s already a ${taken} - add an initial (“${taken.split(' ')[0]} R.”).`);
    const f = cleanPersonFields(doc.team, fields || {}, null);
    const p = { id: pid, name, roles: f.roles, maxHours: f.maxHours, targetHours: f.targetHours, keyHash: o.keyHash || null, joinedAt: new Date(now).toISOString() };
    doc.people.push(p);
    return p;
  }
  /** Assign or unassign one seat. Rules are not enforced here - a manager
   *  may overrule them - but conflicts() flags every one, live. */
  function setSeat(doc, week, sid, pid, on, by) {
    const w = needWeek(doc, week);
    const s = w.shifts.find((x) => x.id === sid);
    if (!s) throw err(404, 'That shift isn’t in this week any more.');
    if (!personOf(doc, pid)) throw err(404, 'That person isn’t on the team.');
    const list = (w.assign[sid] || []).filter((a) => a.pid !== pid);
    if (on) {
      if (list.length >= s.need) throw err(409, `${shiftLabel(s)} already has ${s.need} - take someone off first.`);
      list.push({ pid, by: by || 'manager' });
    }
    w.assign[sid] = list;
    return s;
  }

  /**
   * A manager's change. `p` is the request body; `ids` hands in fresh ids
   * (the server's are random, the sample's fixed). Returns a short result
   * for the page (gaps after a fill, the new person's id).
   */
  function manage(doc, action, p, now, ids) {
    const b = p && typeof p === 'object' ? p : {};
    const id = ids || seq(doc, now);
    const nm = (pid) => (personOf(doc, pid) || {}).name || 'someone';
    const needWeek = (doc2, week) => managerWeek(doc2, week, now);
    let out = {};
    switch (action) {
      case 'settings': {
        const before = doc.team;
        doc.team = cleanSettings(b, before);
        // A role that went away leaves people's role lists and shifts.
        for (const person of doc.people) person.roles = person.roles.filter((r) => doc.team.roles.includes(r));
        for (const w of Object.values(doc.weeks)) {
          const gone = w.shifts.filter((s) => !doc.team.roles.includes(s.role)).map((s) => s.id);
          w.shifts = w.shifts.filter((s) => !gone.includes(s.id));
          for (const g of gone) delete w.assign[g];
        }
        logIt(doc, now, 'Changed the team settings');
        break;
      }
      case 'shift': {
        const w = needWeek(doc, b.week);
        const existing = SHIFT_ID.test(b.shift && b.shift.id) ? w.shifts.find((s) => s.id === b.shift.id) : null;
        const s = cleanShift(doc.team, { ...(b.shift || {}), id: existing ? existing.id : undefined }, existing ? existing.id : id('s'));
        if (!s) throw err(400, 'A shift needs a day, a start, an end and one of the team’s roles.');
        if (existing) {
          Object.assign(existing, s);
          w.assign[s.id] = (w.assign[s.id] || []).slice(0, s.need);
          logIt(doc, now, `Changed ${shiftLabel(s)}`);
        } else {
          if (w.shifts.length >= LIMITS.shifts) throw err(409, `A week holds ${LIMITS.shifts} shifts at most.`);
          w.shifts.push(s);
          w.assign[s.id] = [];
          logIt(doc, now, `Added ${shiftLabel(s)}${s.need > 1 ? ` × ${s.need}` : ''}`);
        }
        sortShifts(w);
        out = { shiftId: s.id };
        break;
      }
      case 'removeShift': {
        const w = needWeek(doc, b.week);
        const s = w.shifts.find((x) => x.id === b.shiftId);
        if (!s) throw err(404, 'That shift isn’t in this week any more.');
        w.shifts = w.shifts.filter((x) => x.id !== s.id);
        delete w.assign[s.id];
        w.swaps = w.swaps.filter((x) => x.shiftId !== s.id);
        logIt(doc, now, `Removed ${shiftLabel(s)}`);
        break;
      }
      case 'copyWeek': {
        const w = needWeek(doc, b.week);
        const from = cleanDate(b.from) && doc.weeks[b.from];
        if (!from || !from.shifts.length) throw err(404, 'There’s no earlier week with shifts to copy.');
        const keep = w.shifts.length;
        for (const s of from.shifts) {
          if (w.shifts.length >= LIMITS.shifts) break;
          if (w.shifts.some((x) => x.day === s.day && x.start === s.start && x.end === s.end && x.role === s.role)) continue;
          const ns = { ...s, id: id('s') };
          w.shifts.push(ns);
          w.assign[ns.id] = [];
        }
        sortShifts(w);
        logIt(doc, now, `Copied ${w.shifts.length - keep} shifts from the week of ${dayLabel(b.from)}`);
        out = { added: w.shifts.length - keep };
        break;
      }
      case 'template': {
        const w = needWeek(doc, b.week);
        const tpl = TEMPLATES[b.kind];
        if (!tpl) throw err(400, 'Pick one of the templates.');
        if (w.shifts.length) throw err(409, 'This week already has shifts. Clear them first, or copy a week instead.');
        doc.team = cleanSettings({ roles: Array.from(new Set(doc.team.roles.filter((r) => r !== 'Team').concat(tpl.roles))).slice(0, LIMITS.roles), hours: tpl.hours }, doc.team);
        for (const s of tpl.shifts) {
          const c = cleanShift(doc.team, s, id('s'));
          if (c) { w.shifts.push(c); w.assign[c.id] = []; }
        }
        sortShifts(w);
        logIt(doc, now, `Started the week from the ${tpl.label} template`);
        break;
      }
      case 'clearWeek': {
        const w = needWeek(doc, b.week);
        if (w.published) throw err(409, 'Unpublish the week before clearing it.');
        w.shifts = []; w.assign = {}; w.swaps = [];
        logIt(doc, now, `Cleared the week of ${dayLabel(b.week)}`);
        break;
      }
      case 'person': {
        const fields = b.person || {};
        const existing = PID.test(fields.id) ? personOf(doc, fields.id) : null;
        if (existing) {
          if (fields.name !== undefined) {
            const n = firstName(fields.name);
            if (!n) throw err(400, 'Add a first name.');
            const taken = nameTaken(doc, n, existing.id);
            if (taken) throw err(409, `There’s already a ${taken} - add an initial.`);
            existing.name = n;
          }
          Object.assign(existing, cleanPersonFields(doc.team, fields, existing));
          logIt(doc, now, `Updated ${existing.name}`);
          out = { pid: existing.id };
        } else {
          const np = addPerson(doc, fields, id('p'), now);
          logIt(doc, now, `Added ${np.name} to the team`);
          out = { pid: np.id };
        }
        break;
      }
      case 'removePerson': {
        const person = personOf(doc, b.pid);
        if (!person) throw err(404, 'That person isn’t on the team.');
        doc.people = doc.people.filter((x) => x.id !== person.id);
        for (const w of Object.values(doc.weeks)) dropPersonFrom(w, person.id);
        logIt(doc, now, `Removed ${person.name} from the team`);
        break;
      }
      case 'unlink': {
        const person = personOf(doc, b.pid);
        if (!person) throw err(404, 'That person isn’t on the team.');
        person.keyHash = null;
        logIt(doc, now, `Freed ${person.name}’s name for a new phone`);
        break;
      }
      case 'seat': {
        const s = setSeat(doc, b.week, b.shiftId, b.pid, b.on !== false, 'manager');
        logIt(doc, now, `${b.on !== false ? 'Put' : 'Took'} ${nm(b.pid)} ${b.on !== false ? 'on' : 'off'} ${shiftLabel(s)}`);
        break;
      }
      case 'fill': {
        const w = needWeek(doc, b.week);
        if (!w.shifts.length) throw err(409, 'Add the week’s shifts first.');
        const r = fill(doc, b.week);
        w.assign = r.assign;
        logIt(doc, now, `Filled the gaps: ${r.placed.length} placed${r.gaps.length ? `, ${r.gaps.reduce((s, g) => s + g.seats, 0)} still open` : ''}`);
        out = { placed: r.placed, gaps: r.gaps };
        break;
      }
      case 'clearFill': {
        const w = needWeek(doc, b.week);
        let n = 0;
        for (const k of Object.keys(w.assign)) { const before = w.assign[k].length; w.assign[k] = w.assign[k].filter((a) => a.by !== 'fill'); n += before - w.assign[k].length; }
        logIt(doc, now, `Cleared ${n} filled seats (your own picks kept)`);
        break;
      }
      case 'publish': {
        const w = needWeek(doc, b.week);
        if (!w.shifts.length) throw err(409, 'There’s nothing to publish yet.');
        w.published = true; w.publishedAt = new Date(now).toISOString();
        const open = openSeats(doc, b.week).reduce((s, g) => s + g.seats, 0);
        logIt(doc, now, `Published the week of ${dayLabel(b.week)}${open ? ` with ${open} open` : ''}`);
        break;
      }
      case 'unpublish': {
        const w = needWeek(doc, b.week);
        w.published = false;
        logIt(doc, now, `Unpublished the week of ${dayLabel(b.week)}`);
        break;
      }
      case 'avail': {
        // The manager marking someone's availability (they told you in person).
        const w = needWeek(doc, b.week);
        const person = personOf(doc, b.pid);
        if (!person) throw err(404, 'That person isn’t on the team.');
        w.avail[person.id] = { days: cleanAvailDays(b.days), note: clean(b.note, LIMITS.note), noCloses: b.noCloses === true, at: new Date(now).toISOString() };
        logIt(doc, now, `Marked ${person.name}’s availability`);
        break;
      }
      case 'availMany': {
        // A reviewed "Read their texts" proposal, applied on the manager's tap.
        const w = needWeek(doc, b.week);
        const marks = b.marks && typeof b.marks === 'object' ? b.marks : {};
        const names = [];
        for (const [pid, m] of Object.entries(marks).slice(0, LIMITS.people)) {
          const person = personOf(doc, pid);
          if (!person || !m) continue;
          const prev = (w.avail[pid] && w.avail[pid].days) || [];
          const next = cleanAvailDays(m.days);
          w.avail[pid] = { days: next.map((d, i) => d || prev[i] || null), note: clean(m.note, LIMITS.note) || (w.avail[pid] && w.avail[pid].note) || '', noCloses: m.noCloses === true || Boolean(w.avail[pid] && w.avail[pid].noCloses), at: new Date(now).toISOString() };
          if (m.maxHours !== undefined && intIn(m.maxHours, 1, LIMITS.hours)) Object.assign(person, cleanPersonFields(doc.team, { maxHours: m.maxHours }, person));
          names.push(person.name);
        }
        if (!names.length) throw err(400, 'Nothing to apply.');
        logIt(doc, now, `Applied availability from texts for ${names.join(', ')}`);
        out = { applied: names.length };
        break;
      }
      case 'swap': {
        const w = needWeek(doc, b.week);
        const x = w.swaps.find((y) => y.id === b.id);
        if (!x || x.status !== 'pending') throw err(404, 'That swap isn’t waiting for you.');
        const s = w.shifts.find((y) => y.id === x.shiftId);
        if (b.decision === 'approve') {
          const why = swapBlockers(doc, b.week, x, x.to);
          if (why.length) throw err(409, `${nm(x.to)} ${why.join(', ')} - it can’t be approved as it stands.`);
          doSwap(doc, b.week, x, now);
        } else if (b.decision === 'decline') {
          x.status = 'open'; x.to = null; x.at = new Date(now).toISOString();
          logIt(doc, now, `Declined the swap of ${shiftLabel(s)}; it’s up for grabs again`);
        } else throw err(400, 'Approve or decline.');
        break;
      }
      default:
        throw err(400, 'Unknown change.');
    }
    touch(doc, now);
    return out;
  }
  function sortShifts(w) {
    w.shifts.sort((a, b) => a.day - b.day || toMin(a.start) - toMin(b.start) || a.role.localeCompare(b.role) || a.id.localeCompare(b.id));
  }

  /* ------------------------------------------------------------------ *
   * Swaps
   * ------------------------------------------------------------------ */

  /** Why `pid` could not take swap `x`'s shift (the offerer's seat freed). */
  function swapBlockers(doc, week, x, pid) {
    const w = doc.weeks[week];
    if (!w) return ['the week is gone'];
    const assign = {};
    for (const [k, v] of Object.entries(w.assign)) assign[k] = k === x.shiftId ? v.filter((a) => a.pid !== x.from) : v;
    const ctx = context(doc, week);
    if ((w.assign[x.shiftId] || []).some((a) => a.pid === pid)) return ['is already on it'];
    const held = holdings(w, assign);
    return blockers(ctx, x.shiftId, pid, held[pid] || []).map((b) => b.text);
  }
  function doSwap(doc, week, x, now) {
    const w = doc.weeks[week];
    const s = w.shifts.find((y) => y.id === x.shiftId);
    w.assign[x.shiftId] = (w.assign[x.shiftId] || []).filter((a) => a.pid !== x.from).concat([{ pid: x.to, by: 'swap' }]);
    x.status = 'done'; x.at = new Date(now).toISOString();
    logIt(doc, now, `${(personOf(doc, x.from) || {}).name} → ${(personOf(doc, x.to) || {}).name}: ${shiftLabel(s)} (swap)`);
  }
  function shiftStarted(doc, week, s, now) { return shiftTimes(doc.team, week, s).startMs <= now; }

  /**
   * A staff member's change, on their own name only: availability, their
   * roles and hours, offering a shift, claiming one.
   */
  function staff(doc, pid, action, p, now, ids) {
    const b = p && typeof p === 'object' ? p : {};
    const me = personOf(doc, pid);
    if (!me) throw err(403, 'Pick your name first.');
    const id = ids || seq(doc, now);
    let out = {};
    const needWeek = (doc2, week) => staffWeek(doc2, week, now);
    switch (action) {
      case 'avail': {
        const w = needWeek(doc, b.week);
        w.avail[pid] = { days: cleanAvailDays(b.days), note: clean(b.note, LIMITS.note), noCloses: b.noCloses === true, at: new Date(now).toISOString() };
        logIt(doc, now, `${me.name} marked availability for the week of ${dayLabel(b.week)}`);
        break;
      }
      case 'profile': {
        Object.assign(me, cleanPersonFields(doc.team, { roles: b.roles, maxHours: b.maxHours, targetHours: b.targetHours }, me));
        logIt(doc, now, `${me.name} updated their roles and hours`);
        break;
      }
      case 'offer': {
        const w = needWeek(doc, b.week);
        if (!w.published) throw err(409, 'Swaps open once the week is published.');
        const s = w.shifts.find((y) => y.id === b.shiftId);
        if (!s || !(w.assign[s.id] || []).some((a) => a.pid === pid)) throw err(404, 'That isn’t one of your shifts.');
        if (shiftStarted(doc, b.week, s, now)) throw err(409, 'That shift has already started.');
        if (w.swaps.some((x) => x.shiftId === s.id && x.from === pid && (x.status === 'open' || x.status === 'pending'))) throw err(409, 'You’ve already offered that shift.');
        if (w.swaps.length >= LIMITS.swaps) w.swaps = w.swaps.filter((x) => x.status === 'open' || x.status === 'pending');
        if (w.swaps.length >= LIMITS.swaps) throw err(409, 'Too many swaps open this week.');
        const x = { id: id('w'), shiftId: s.id, from: pid, to: null, status: 'open', note: clean(b.note, LIMITS.note), at: new Date(now).toISOString() };
        w.swaps.push(x);
        logIt(doc, now, `${me.name} offered ${shiftLabel(s)} for swap`);
        out = { swapId: x.id };
        break;
      }
      case 'cancel': {
        const w = needWeek(doc, b.week);
        const x = w.swaps.find((y) => y.id === b.id && y.from === pid && (y.status === 'open' || y.status === 'pending'));
        if (!x) throw err(404, 'That swap isn’t open.');
        x.status = 'cancelled'; x.at = new Date(now).toISOString();
        logIt(doc, now, `${me.name} took back the swap offer`);
        break;
      }
      case 'claim': {
        const w = needWeek(doc, b.week);
        const x = w.swaps.find((y) => y.id === b.id);
        if (!x || x.status !== 'open' || x.from === pid) throw err(404, 'That shift isn’t up for grabs any more.');
        const s = w.shifts.find((y) => y.id === x.shiftId);
        if (shiftStarted(doc, b.week, s, now)) throw err(409, 'That shift has already started.');
        // Only someone the rules allow: the same check as Fill the gaps.
        const why = swapBlockers(doc, b.week, x, pid);
        if (why.length) throw err(409, `You can’t take this one - you ${why.join(', ').replace(/^is /, 'are ').replace(/^doesn’t/, 'don’t').replace(/^needs/, 'need').replace(/^would/, 'would')}.`);
        x.to = pid; x.at = new Date(now).toISOString();
        if (doc.team.autoApprove) { doSwap(doc, b.week, x, now); out = { approved: true }; }
        else { x.status = 'pending'; logIt(doc, now, `${me.name} claimed ${shiftLabel(s)} from ${(personOf(doc, x.from) || {}).name}; waiting for the manager`); out = { approved: false }; }
        break;
      }
      case 'unclaim': {
        const w = needWeek(doc, b.week);
        const x = w.swaps.find((y) => y.id === b.id && y.to === pid && y.status === 'pending');
        if (!x) throw err(404, 'You haven’t claimed that one.');
        x.status = 'open'; x.to = null; x.at = new Date(now).toISOString();
        logIt(doc, now, `${me.name} let go of a claimed swap`);
        break;
      }
      default:
        throw err(400, 'Unknown change.');
    }
    touch(doc, now);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * What each viewer sees
   * ------------------------------------------------------------------ */

  /** The manager sees everything but the phones' key hashes. */
  function managerView(doc) {
    const out = JSON.parse(JSON.stringify({ team: doc.team, weeks: doc.weeks, log: doc.log, v: doc.v, createdAt: doc.createdAt, updatedAt: doc.updatedAt }));
    out.people = doc.people.map((p) => ({ id: p.id, name: p.name, roles: p.roles, maxHours: p.maxHours, targetHours: p.targetHours, linked: Boolean(p.keyHash) }));
    return out;
  }
  /** A staff phone sees: the team's name, zone and roles, first names (to
   *  pick their own and to read the rota), PUBLISHED weeks' shifts and who
   *  is on them, their own availability and hours, swaps they made, could
   *  claim or claimed. Never anyone else's availability, notes or hours,
   *  never a draft, never the log, never a key or hash. */
  function staffView(doc, pid, nowMs) {
    const me = pid ? personOf(doc, pid) : null;
    const weeks = {};
    for (const [k, w] of Object.entries(doc.weeks)) {
      const mine = me && w.avail[me.id] ? w.avail[me.id] : null;
      const wk = { published: Boolean(w.published), avail: mine ? { days: mine.days, note: mine.note || '', noCloses: Boolean(mine.noCloses) } : null, shifts: [], swaps: [] };
      if (w.published) {
        wk.shifts = w.shifts.map((s) => ({ id: s.id, day: s.day, start: s.start, end: s.end, role: s.role, need: s.need, people: (w.assign[s.id] || []).map((a) => a.pid) }));
        if (me) {
          for (const x of w.swaps) {
            const s = w.shifts.find((y) => y.id === x.shiftId);
            if (!s) continue;
            const started = nowMs !== undefined && shiftStarted(doc, k, s, nowMs);
            const mineSwap = x.from === me.id || x.to === me.id;
            let canClaim = false;
            if (!mineSwap && x.status === 'open' && !started) canClaim = swapBlockers(doc, k, x, me.id).length === 0;
            if (mineSwap || canClaim) wk.swaps.push({ id: x.id, shiftId: x.shiftId, from: x.from, to: x.to, status: x.status, note: x.note || '', mine: x.from === me.id, claimedByMe: x.to === me.id, canClaim });
          }
        }
      }
      weeks[k] = wk;
    }
    return {
      team: { name: doc.team.name, zone: doc.team.zone, roles: doc.team.roles, minRest: doc.team.minRest, autoApprove: doc.team.autoApprove },
      people: doc.people.map((p) => ({ id: p.id, name: p.name, free: !p.keyHash })),
      me: me ? { id: me.id, name: me.name, roles: me.roles, maxHours: me.maxHours, targetHours: me.targetHours } : null,
      weeks,
      v: doc.v,
    };
  }

  /* ------------------------------------------------------------------ *
   * Calendar (.ics): one person's published shifts, with real UTC times
   * ------------------------------------------------------------------ */

  function icsText(v) { return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n'); }
  function utf8Len(ch) { const c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  function icsFold(line) {
    const out = []; let cur = ''; let bytes = 0;
    for (const ch of Array.from(line)) {
      const n = utf8Len(ch);
      if (bytes + n > 75) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch; bytes += n;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  /** The .ics for one person: every published shift they hold, each with
   *  a reminder an hour before. Times are UTC instants, so no VTIMEZONE is
   *  needed and a daylight-saving week lands right. */
  function buildIcs(doc, pid, nowMs) {
    const me = personOf(doc, pid);
    const from = mondayOf(todayIn(doc.team.zone, nowMs)); // this week on: a calendar is for what's coming
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rota//Shifts//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(`Shifts · ${doc.team.name}`)}`];
    for (const week of Object.keys(doc.weeks).sort()) {
      const w = doc.weeks[week];
      if (!w.published || !me || week < from) continue;
      for (const s of w.shifts) {
        if (!(w.assign[s.id] || []).some((a) => a.pid === pid)) continue;
        const t = shiftTimes(doc.team, week, s);
        const mates = (w.assign[s.id] || []).filter((a) => a.pid !== pid).map((a) => (personOf(doc, a.pid) || {}).name).filter(Boolean);
        lines.push('BEGIN:VEVENT', `UID:${s.id}-${week}@rota`, `DTSTAMP:${stamp(nowMs)}`, `DTSTART:${stamp(t.startMs)}`, `DTEND:${stamp(t.endMs)}`,
          `SUMMARY:${icsText(`${s.role} shift · ${doc.team.name}`)}`,
          `DESCRIPTION:${icsText(`${DAYS[s.day]} ${fmtTime(s.start)}–${fmtTime(s.end)} (${doc.team.zone}).${mates.length ? ` With ${mates.join(', ')}.` : ''} From Rota - swaps happen in the app.`)}`,
          'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`${s.role} shift in an hour`)}`, 'TRIGGER:-PT1H', 'END:VALARM', 'END:VEVENT');
      }
    }
    lines.push('END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ *
   * Templates and the sample cafe
   * ------------------------------------------------------------------ */

  const wk = (open, close) => ({ open, close });
  const TEMPLATES = {
    cafe: {
      label: 'Cafe', roles: ['Barista', 'Counter', 'Kitchen'],
      hours: [wk('07:00', '17:00'), wk('07:00', '17:00'), wk('07:00', '17:00'), wk('07:00', '17:00'), wk('07:00', '17:00'), wk('08:00', '17:00'), wk('08:00', '15:00')],
      shifts: [].concat(...[0, 1, 2, 3, 4].map((d) => [
        { day: d, start: '06:30', end: '14:30', role: 'Barista' }, { day: d, start: '10:00', end: '17:30', role: 'Barista' },
        { day: d, start: '07:00', end: '13:00', role: 'Counter' }, { day: d, start: '12:00', end: '17:30', role: 'Counter' },
        { day: d, start: '06:30', end: '14:30', role: 'Kitchen' }])).concat([
        { day: 5, start: '07:30', end: '15:30', role: 'Barista' }, { day: 5, start: '11:00', end: '17:30', role: 'Barista' },
        { day: 5, start: '08:00', end: '13:00', role: 'Counter' }, { day: 5, start: '12:00', end: '17:30', role: 'Counter' },
        { day: 5, start: '07:30', end: '15:30', role: 'Kitchen' },
        { day: 6, start: '07:30', end: '15:30', role: 'Barista' }, { day: 6, start: '08:00', end: '15:30', role: 'Counter' },
        { day: 6, start: '07:30', end: '15:30', role: 'Kitchen' }]),
    },
    bar: {
      label: 'Bar & restaurant', roles: ['Bar', 'Floor', 'Kitchen'],
      hours: [null, wk('16:00', '23:00'), wk('16:00', '23:00'), wk('16:00', '23:30'), wk('16:00', '01:00'), wk('12:00', '01:00'), wk('12:00', '22:00')],
      shifts: [].concat(...[1, 2, 3].map((d) => [
        { day: d, start: '15:30', end: '23:30', role: 'Bar' }, { day: d, start: '16:00', end: '23:00', role: 'Floor' }, { day: d, start: '15:00', end: '22:30', role: 'Kitchen' }])).concat(
        ...[4, 5].map((d) => [
          { day: d, start: '17:00', end: '01:30', role: 'Bar', need: 2 }, { day: d, start: d === 5 ? '11:30' : '15:30', end: d === 5 ? '18:00' : '23:00', role: 'Floor' },
          { day: d, start: '18:00', end: '01:00', role: 'Floor' }, { day: d, start: '15:00', end: '23:00', role: 'Kitchen' }]),
        [{ day: 6, start: '11:30', end: '22:30', role: 'Bar' }, { day: 6, start: '11:30', end: '18:00', role: 'Floor' }, { day: 6, start: '11:00', end: '21:00', role: 'Kitchen' }]),
    },
    shop: {
      label: 'Shop', roles: ['Till', 'Floor'],
      hours: [wk('09:00', '18:00'), wk('09:00', '18:00'), wk('09:00', '18:00'), wk('09:00', '20:00'), wk('09:00', '18:00'), wk('09:00', '18:00'), wk('11:00', '17:00')],
      shifts: [].concat(...[0, 1, 2, 3, 4, 5].map((d) => [
        { day: d, start: '08:45', end: '14:00', role: 'Till' }, { day: d, start: '13:30', end: d === 3 ? '20:15' : '18:15', role: 'Till' }, { day: d, start: '10:00', end: '16:00', role: 'Floor', need: d === 5 ? 2 : 1 }])).concat([
        { day: 6, start: '10:45', end: '17:15', role: 'Till' }, { day: 6, start: '11:00', end: '17:00', role: 'Floor' }]),
    },
    desk: {
      label: 'Front desk', roles: ['Front desk', 'Phones'],
      hours: [wk('08:00', '18:00'), wk('08:00', '18:00'), wk('08:00', '18:00'), wk('08:00', '18:00'), wk('08:00', '18:00'), wk('09:00', '13:00'), null],
      shifts: [].concat(...[0, 1, 2, 3, 4].map((d) => [
        { day: d, start: '07:45', end: '13:15', role: 'Front desk' }, { day: d, start: '12:45', end: '18:15', role: 'Front desk' }, { day: d, start: '09:00', end: '17:00', role: 'Phones' }])).concat([
        { day: 5, start: '08:45', end: '13:15', role: 'Front desk' }]),
    },
  };

  /**
   * The sample cafe: a made-up team of eight with next week's availability
   * already in, and three weeks of history done "the spreadsheet way" (first
   * name on the list who can) - so the fairness panel has something to say
   * and Fill the gaps has something to put right. Fixed ids: the same
   * sample on every phone.
   */
  function sample(today, zone) {
    const z = cleanZone(zone || 'America/New_York');
    const tpl = TEMPLATES.cafe;
    let n = 0;
    const ids = (k) => idFrom(k, `sample-${n++}`, 8);
    const doc = newDoc({ name: 'Fernhill Cafe (sample)', zone: z, minRest: 10, roles: tpl.roles, hours: tpl.hours, autoApprove: false }, 0);
    const P = [
      ['Mia', ['Barista', 'Counter'], 40, 38], ['Theo', ['Barista', 'Counter'], 36, 32], ['Priya', ['Barista', 'Counter'], 32, 28],
      ['Sam', ['Counter', 'Barista'], 30, 24], ['Lena', ['Kitchen', 'Counter'], 32, 28], ['Jonah', ['Kitchen'], 40, 36],
      ['Ava', ['Counter'], 20, 16], ['Kai', ['Barista', 'Counter'], 30, 24],
    ];
    for (const [name, roles, maxHours, targetHours] of P) addPerson(doc, { name, roles, maxHours, targetHours }, ids('p'), 0);
    const pid = (name) => doc.people.find((p) => p.name === name).id;
    const next = nextWeekOf(today);
    const c = (s, from, to) => ({ s, from: from || null, to: to || null });
    const AV = {
      Mia: [c('can'), c('can'), c('can'), c('can'), c('can'), c('prefer'), c('cant')],
      Theo: [c('can'), c('can'), c('can'), c('can'), c('can'), c('can'), c('prefer')],
      Priya: [c('can'), c('can'), c('can'), c('can'), c('cant'), c('can'), c('can')],
      Sam: [c('can'), c('cant'), c('can'), c('can'), c('can'), c('can', '12:00'), c('can')],
      Lena: [c('can'), c('can'), c('can'), c('can'), c('can'), c('can'), c('cant')],
      Jonah: [c('can'), c('can'), c('can'), c('can'), c('can'), c('can'), c('cant')],
      Ava: [c('cant'), c('cant'), c('cant'), c('prefer'), c('can'), c('can'), c('can')],
      Kai: [c('can', null, '14:00'), c('can', null, '14:00'), c('can', null, '14:00'), c('can', null, '14:00'), c('can', null, '14:00'), c('cant'), c('can')],
    };
    const NOTES = { Ava: 'Uni Mon-Wed', Kai: 'School run - done by 2pm weekdays', Sam: 'Sat after 12 only', Jonah: 'Sundays are family day' };
    for (let k = -3; k <= 0; k++) {
      const week = addDays(next, 7 * k);
      const w = weekOf(doc, week, true);
      for (const s of tpl.shifts) { const cs = cleanShift(doc.team, s, ids('s')); w.shifts.push(cs); w.assign[cs.id] = []; }
      sortShifts(w);
      for (const [name, days] of Object.entries(AV)) w.avail[pid(name)] = { days: cleanAvailDays(days), note: NOTES[name] || '', at: new Date(0).toISOString() };
      if (k < 0) {
        // The spreadsheet way: first on the list who can, no thought for fairness.
        const ctx = context(doc, week);
        for (const s of w.shifts) {
          for (let seat = 0; seat < s.need; seat++) {
            const held = holdings(w);
            const who = doc.people.find((p) => !(w.assign[s.id] || []).some((a) => a.pid === p.id) && !blockers(ctx, s.id, p.id, held[p.id] || []).length);
            if (who) w.assign[s.id].push({ pid: who.id, by: 'manager' });
          }
        }
        w.published = true; w.publishedAt = new Date(dayMs(week) - 3 * 86400000).toISOString();
      }
    }
    doc.log = [{ at: new Date(dayMs(today) + 9 * HOUR).toISOString(), text: 'Sample team loaded: 8 people, availability in for next week' }];
    doc.v = 1;
    return { doc, week: next };
  }

  return {
    LIMITS, DAYS, DAY_LONG, STATES, STATE_LABEL, TEMPLATES, SHIFT_ID, PID, SWAP_ID,
    clean, firstName, fold, cleanRole, cleanTime, cleanDate, toMin, fmtTime, addDays, weekday, mondayOf, isMonday, dayLabel, weekLabel,
    zoneOk, cleanZone, offsetMin, wallToUtc, todayIn, nextWeekOf,
    cleanSettings, cleanShift, cleanAvailDays, cleanPersonFields, roleIn, newDoc, emptyWeek, weekOf, personOf, idFrom,
    shiftTimes, shiftLabel, context, availOf, blockers, candidates, fill, explain, conflicts, gaps, openSeats, weekStats, history, fairness,
    manage, staff, swapBlockers, managerView, staffView, buildIcs, icsText, icsFold, sample, addPerson, err,
  };
}));
