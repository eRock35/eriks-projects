/* Booth's rules - everything that needs no model, in one file that runs in the
 * browser AND on the server (server.js requires it).
 *
 *   validateLead(raw)      one lead, checked and cleaned: bounded lengths, an
 *                          email that is an email, a phone with 7-15 digits,
 *                          a temperature, no markup. The capture form checks
 *                          it live; the server checks what it saves.
 *   clock(lead, now)       the follow-up clock: hot goes cold after 48 hours,
 *                          warm after 5 days, cold after 14. "Going cold",
 *                          "went cold", or done.
 *   findDuplicate / merge  the same person twice (by email or phone) at one
 *                          event, and folding the second capture into the first.
 *   applyStatus            sent / replied / booked / won / lost, with the
 *                          timestamps that make the scorecard honest.
 *   leaderboard, scorecard streaks, badges, points, and the show's ROI.
 *   template, mailto       free follow-up templates per temperature. The app
 *                          sends no email itself - there is no mail service.
 *
 * One implementation on purpose: the page ticks the clocks and draws the
 * scorecard with the same arithmetic the server uses to answer, so a lead
 * cannot be "going cold" on one and "fine" on the other.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoothRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HOUR = 3600000;
  var DAY = 24 * HOUR;

  /* ---------------- vocabulary ---------------- */

  // How long each temperature has before it goes cold. Hot is the one that
  // matters: after two days a hot lead has usually heard from someone else.
  var TEMPS = [
    { key: 'hot', emoji: '🔥', label: 'Hot', hours: 48, blurb: 'Ready to talk', window: '48 hours' },
    { key: 'warm', emoji: '🌤', label: 'Warm', hours: 120, blurb: 'Interested, not urgent', window: '5 days' },
    { key: 'cold', emoji: '🧊', label: 'Cold', hours: 336, blurb: 'Just browsing', window: '14 days' },
  ];
  var TEMP_KEYS = TEMPS.map(function (t) { return t.key; });

  var NEXT_STEPS = [
    { key: 'call', emoji: '📞', label: 'Call' },
    { key: 'demo', emoji: '🖥️', label: 'Demo' },
    { key: 'quote', emoji: '🧾', label: 'Quote' },
    { key: 'info', emoji: '📨', label: 'Send info' },
  ];
  var NEXT_KEYS = NEXT_STEPS.map(function (n) { return n.key; });

  // In order. Lost sits outside the ladder: it closes a lead from any rung.
  var STATUSES = [
    { key: 'new', label: 'To follow up', emoji: '⏳', stamp: null },
    { key: 'sent', label: 'Followed up', emoji: '📤', stamp: 'sentAt' },
    { key: 'replied', label: 'Replied', emoji: '💬', stamp: 'repliedAt' },
    { key: 'booked', label: 'Meeting booked', emoji: '📅', stamp: 'bookedAt' },
    { key: 'won', label: 'Won', emoji: '🏆', stamp: 'wonAt' },
    { key: 'lost', label: 'Lost', emoji: '🪦', stamp: 'lostAt' },
  ];
  var STATUS_KEYS = STATUSES.map(function (s) { return s.key; });
  var LADDER = ['new', 'sent', 'replied', 'booked', 'won'];

  var TONES = [
    { key: 'friendly', label: 'Friendly' },
    { key: 'direct', label: 'Straight to the point' },
    { key: 'warm', label: 'Warm and chatty' },
    { key: 'formal', label: 'Formal' },
  ];
  var TONE_KEYS = TONES.map(function (t) { return t.key; });

  var DEFAULT_CHIPS = ['Demo', 'Pricing', 'Samples', 'Wholesale', 'Partner'];

  var LIMITS = {
    name: 80, company: 80, title: 80, email: 120, phone: 30, note: 400,
    chips: 12, chip: 24, value: 10000000,
    eventName: 60, place: 80, boothCost: 1000000, eventDays: 14,
    personName: 30, signoff: 80,
    subject: 120, body: 2000,
  };

  var POINTS = { lead: 10, hot: 5, onTime: 10, late: 3, reply: 5, meeting: 10, won: 25 };

  var BADGES = [
    { key: 'first', emoji: '🎯', label: 'First lead', detail: 'Captured a lead.' },
    { key: 'ten', emoji: '🔟', label: 'Double digits', detail: 'Ten leads at one show.' },
    { key: 'hothand', emoji: '🔥', label: 'Hot hand', detail: 'Three hot leads in a row.' },
    { key: 'quick', emoji: '⚡', label: 'Quick draw', detail: 'Followed up within an hour of the chat.' },
    { key: 'nocold', emoji: '🛡️', label: 'Nothing went cold', detail: 'Five or more leads, every one followed up in time.' },
    { key: 'closer', emoji: '🏆', label: 'Closer', detail: 'Won a deal from the show.' },
    { key: 'rainmaker', emoji: '💰', label: 'Rainmaker', detail: 'Won more than the booth cost, alone.' },
  ];

  // Join codes: 8 characters from 32 that cannot be misread (no 0/O, 1/I).
  // 32^8 is about 1.1 trillion, so a guess is hopeless even before the server
  // limits how many a person may make. Pop Quiz's format, on purpose.
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var CODE_LEN = 8;
  var CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

  function tempInfo(k) { for (var i = 0; i < TEMPS.length; i++) if (TEMPS[i].key === k) return TEMPS[i]; return TEMPS[1]; }
  function nextInfo(k) { for (var i = 0; i < NEXT_STEPS.length; i++) if (NEXT_STEPS[i].key === k) return NEXT_STEPS[i]; return null; }
  function statusInfo(k) { for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].key === k) return STATUSES[i]; return STATUSES[0]; }
  function badgeInfo(k) { for (var i = 0; i < BADGES.length; i++) if (BADGES[i].key === k) return BADGES[i]; return null; }
  var TEMP_RANK = { hot: 3, warm: 2, cold: 1 };
  function hotter(a, b) { return (TEMP_RANK[a] || 0) >= (TEMP_RANK[b] || 0) ? a : b; }

  /* ---------------- text ---------------- */

  /** One line: tags stripped, then any stray angle bracket, control
   *  characters and runs of whitespace. Everything here ends up in a page. */
  function clean(v, max) {
    return String(v == null ? '' : v)
      .replace(/<(script|style)\b[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[<>]/g, '')
      .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max || 200);
  }

  /** Several lines: the same, newlines kept (one blank line at most), and
   *  markdown emphasis dropped - an email client would show the asterisks. */
  function cleanText(v, max) {
    return String(v == null ? '' : v)
      .replace(/\r\n?/g, '\n')
      .replace(/<(script|style)\b[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[<>]/g, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, ' ')
      .split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); }).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, max || 2000);
  }

  /* ---------------- contacts ---------------- */

  var EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
  function isEmail(v) { var s = String(v || ''); return s.length <= LIMITS.email && EMAIL_RE.test(s) && s.indexOf('..') < 0; }
  function normEmail(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

  var PHONE_RE = /^\+?[\d\s().-]{6,24}(\s*(x|ext\.?)\s*\d{1,6})?$/i;
  function phoneDigits(v) { return String(v == null ? '' : v).replace(/\s*(x|ext\.?)\s*\d{1,6}\s*$/i, '').replace(/\D/g, ''); }
  function isPhone(v) {
    var s = String(v || '').trim();
    var d = phoneDigits(s);
    return s.length <= LIMITS.phone && PHONE_RE.test(s) && d.length >= 7 && d.length <= 15;
  }
  /** The key two captures of one number share: digits only, a leading US 1
   *  dropped, so "+1 (404) 555-0142" and "404.555.0142" are the same phone. */
  function phoneKey(v) {
    var d = phoneDigits(v);
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length >= 7 ? d : '';
  }

  function firstName(name) {
    var n = clean(name, LIMITS.name).split(' ')[0] || '';
    return /^[A-Za-zÀ-ɏ'’-]{1,30}$/.test(n) ? n : '';
  }

  function toNumber(v) {
    if (v == null || v === '') return null;
    var n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }

  /**
   * One lead, from the capture form, an edit or a card reading. All or
   * nothing: the first problem is the error. `chips` is the event's list, so
   * a lead only carries interests the owner defined.
   *
   * @returns { lead } or { error, field }
   */
  function validateLead(raw, opts) {
    raw = raw || {};
    opts = opts || {};
    var out = {
      name: clean(raw.name, LIMITS.name),
      company: clean(raw.company, LIMITS.company),
      title: clean(raw.title, LIMITS.title),
      email: normEmail(clean(raw.email, LIMITS.email + 10)),
      phone: clean(raw.phone, LIMITS.phone + 10),
      temp: raw.temp,
      next: raw.next == null ? '' : String(raw.next),
      note: cleanText(raw.note, LIMITS.note),
      chips: [],
    };
    if (!out.name && !out.company && !out.email && !out.phone) return { error: 'Add a name, a company, an email or a phone.', field: 'name' };
    if (out.email && !isEmail(out.email)) return { error: 'That email doesn’t look right.', field: 'email' };
    if (out.phone && !isPhone(out.phone)) return { error: 'That phone number doesn’t look right (7 to 15 digits).', field: 'phone' };
    if (TEMP_KEYS.indexOf(out.temp) < 0) return { error: 'Pick hot, warm or cold.', field: 'temp' };
    if (out.next && NEXT_KEYS.indexOf(out.next) < 0) return { error: 'Pick a next step.', field: 'next' };
    var allowed = (opts.chips || []).map(function (c) { return String(c).toLowerCase(); });
    var seen = {};
    (Array.isArray(raw.chips) ? raw.chips : []).forEach(function (c) {
      var t = clean(c, LIMITS.chip);
      var k = t.toLowerCase();
      if (!t || seen[k] || allowed.indexOf(k) < 0 || out.chips.length >= LIMITS.chips) return;
      seen[k] = true;
      out.chips.push(opts.chips[allowed.indexOf(k)]);
    });
    if (raw.value !== undefined) {
      var v = toNumber(raw.value);
      if (v !== null && (Number.isNaN(v) || v < 0 || v > LIMITS.value)) return { error: 'Deal value is a number of dollars.', field: 'value' };
      out.value = v === null ? null : Math.round(v);
    }
    return { lead: out };
  }

  /* ---------------- dedupe ---------------- */

  /** The lead this one repeats, by email first, then phone. */
  function findDuplicate(leads, cand, exceptId) {
    var e = normEmail(cand.email);
    var p = phoneKey(cand.phone);
    if (!e && !p) return null;
    for (var i = 0; i < (leads || []).length; i++) {
      var l = leads[i];
      if (!l || l.id === exceptId) continue;
      if (e && normEmail(l.email) === e) return { lead: l, by: 'email' };
    }
    for (var j = 0; j < (leads || []).length; j++) {
      var m = leads[j];
      if (!m || m.id === exceptId) continue;
      if (p && phoneKey(m.phone) === p) return { lead: m, by: 'phone' };
    }
    return null;
  }

  /**
   * Fold a second capture of the same person into the first: gaps filled,
   * interests added, the hotter temperature kept, both notes kept. Nothing
   * already recorded is overwritten - the first rep's words stay theirs.
   */
  function mergePatch(existing, incoming, byName) {
    var patch = {};
    ['name', 'company', 'title', 'email', 'phone', 'next'].forEach(function (k) {
      if (!existing[k] && incoming[k]) patch[k] = incoming[k];
    });
    var chips = (existing.chips || []).slice();
    (incoming.chips || []).forEach(function (c) { if (chips.indexOf(c) < 0 && chips.length < LIMITS.chips) chips.push(c); });
    if (chips.length !== (existing.chips || []).length) patch.chips = chips;
    var t = hotter(existing.temp, incoming.temp);
    if (t !== existing.temp) patch.temp = t;
    var n = clean(incoming.note, LIMITS.note);
    if (n && String(existing.note || '').indexOf(n) < 0) {
      patch.note = cleanText((existing.note ? existing.note + '\n' : '') + (byName ? byName + ': ' : '') + n, LIMITS.note);
    }
    return patch;
  }

  /* ---------------- status ---------------- */

  /**
   * Move a lead to a status. Climbing the ladder stamps every rung it passes
   * that has no stamp yet (a reply implies a follow-up went out); stepping
   * back clears the rungs above. Lost closes it from anywhere.
   *
   * @returns the fields to write
   */
  function applyStatus(lead, status, at, by, value) {
    if (STATUS_KEYS.indexOf(status) < 0) return null;
    var patch = { status: status };
    if (status === 'lost') {
      patch.lostAt = lead.lostAt || at;
      patch.wonAt = null;
    } else {
      var idx = LADDER.indexOf(status);
      LADDER.forEach(function (k, i) {
        var stamp = statusInfo(k).stamp;
        if (!stamp) return;
        if (i <= idx) { if (!lead[stamp]) patch[stamp] = at; }
        else if (lead[stamp]) patch[stamp] = null;
      });
      patch.lostAt = null;
      if (idx >= 1 && !lead.sentAt) patch.sentBy = by || null;
      if (idx === 0) patch.sentBy = null;
    }
    if (value !== undefined) patch.value = value;
    return patch;
  }

  /* ---------------- the follow-up clock ---------------- */

  function ms(iso) { var t = Date.parse(iso); return Number.isFinite(t) ? t : null; }

  /**
   * Where a lead's follow-up stands, at `now` (ms).
   *   closed   won or lost
   *   done     followed up (onTime says whether before the window closed)
   *   fresh    plenty of time
   *   cooling  under a quarter of its window, or under 12 hours, left
   *   cold     the window has passed with no follow-up
   */
  function clock(lead, now) {
    var t = tempInfo(lead.temp);
    var start = ms(lead.capturedAt) || now;
    var windowMs = t.hours * HOUR;
    var due = start + windowMs;
    var base = { dueAt: new Date(due).toISOString(), windowMs: windowMs, hours: t.hours };
    var sent = ms(lead.sentAt);
    if (sent) {
      return assign(base, { state: 'done', onTime: sent <= due, tookMs: Math.max(0, sent - start), leftMs: 0, pct: 0, closed: Boolean(lead.wonAt || lead.lostAt) });
    }
    if (lead.wonAt || lead.lostAt) return assign(base, { state: 'closed', leftMs: 0, pct: 0 });
    var left = due - now;
    if (left <= 0) return assign(base, { state: 'cold', leftMs: left, overMs: -left, pct: 0 });
    var pct = Math.max(0, Math.min(1, left / windowMs));
    var cooling = pct <= 0.25 || left <= 12 * HOUR;
    return assign(base, { state: cooling ? 'cooling' : 'fresh', leftMs: left, pct: pct });
  }

  function assign(a, b) { var o = {}; var k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }

  /** "2d 4h", "5h 12m", "12m", "under a minute". */
  function duration(msv) {
    var m = Math.floor(Math.abs(msv) / 60000);
    if (m < 1) return 'under a minute';
    var d = Math.floor(m / 1440); var h = Math.floor((m % 1440) / 60); var mm = m % 60;
    if (d) return d + 'd' + (h ? ' ' + h + 'h' : '');
    if (h) return h + 'h' + (mm ? ' ' + mm + 'm' : '');
    return mm + 'm';
  }

  /** One line for a lead's clock. */
  function clockLabel(c) {
    if (c.state === 'closed') return 'Closed';
    if (c.state === 'done') return c.onTime ? 'Followed up in ' + duration(c.tookMs) : 'Followed up late (' + duration(c.tookMs) + ')';
    if (c.state === 'cold') return 'Went cold ' + duration(c.overMs) + ' ago';
    return 'Goes cold in ' + duration(c.leftMs);
  }

  /** Leads with no follow-up, the ones about to go cold first. Went-cold
   *  leads stay on it - late beats never. */
  function goingCold(leads, now, limit) {
    var rows = [];
    (leads || []).forEach(function (l) {
      var c = clock(l, now);
      if (c.state === 'fresh' || c.state === 'cooling' || c.state === 'cold') rows.push({ lead: l, clock: c });
    });
    rows.sort(function (a, b) {
      var ca = a.clock.state === 'cold' ? 1 : 0; var cb = b.clock.state === 'cold' ? 1 : 0;
      if (ca !== cb) return ca - cb; // still-savable first
      if (!ca) return a.clock.leftMs - b.clock.leftMs || (TEMP_RANK[b.lead.temp] - TEMP_RANK[a.lead.temp]);
      return a.clock.overMs - b.clock.overMs;
    });
    return limit ? rows.slice(0, limit) : rows;
  }

  /* ---------------- leaderboard ---------------- */

  function byTime(a, b) { return String(a.capturedAt).localeCompare(String(b.capturedAt)); }

  /** Current and best run of hot captures, in capture order. */
  function hotStreak(leads) {
    var cur = 0; var best = 0;
    leads.slice().sort(byTime).forEach(function (l) {
      if (l.temp === 'hot') { cur++; if (cur > best) best = cur; } else cur = 0;
    });
    return { current: cur, best: best };
  }

  /**
   * One row per member: what they captured, how they followed up, points,
   * the hot streak and badges. Capturing is credited to whoever captured;
   * the follow-up and what came of it to whoever sent it (or the capturer,
   * when nobody recorded who).
   *
   * @param members [{uid, name, role}]
   */
  function leaderboard(members, leads, now, opts) {
    opts = opts || {};
    var rows = (members || []).map(function (m) {
      var mine = (leads || []).filter(function (l) { return l.capturedBy === m.uid; });
      var mineFollow = (leads || []).filter(function (l) { return (l.sentBy || l.capturedBy) === m.uid; });
      var r = { uid: m.uid, name: m.name, role: m.role, captured: mine.length, hot: 0, warm: 0, cold: 0, followUps: 0, onTime: 0, late: 0, replies: 0, meetings: 0, won: 0, wonValue: 0, wentCold: 0, points: 0, quick: false };
      mine.forEach(function (l) {
        r[l.temp] = (r[l.temp] || 0) + 1;
        var c = clock(l, now);
        if (c.state === 'cold') r.wentCold++;
      });
      mineFollow.forEach(function (l) {
        var c = clock(l, now);
        if (c.state === 'done') {
          r.followUps++;
          if (c.onTime) r.onTime++; else { r.late++; }
          if (c.tookMs <= HOUR) r.quick = true;
        }
        if (l.repliedAt) r.replies++;
        if (l.bookedAt) r.meetings++;
        if (l.wonAt) { r.won++; r.wonValue += Number(l.value) || 0; }
      });
      var st = hotStreak(mine);
      r.streak = st.current;
      r.bestStreak = st.best;
      r.points = r.captured * POINTS.lead + r.hot * POINTS.hot + r.onTime * POINTS.onTime + r.late * POINTS.late +
        r.replies * POINTS.reply + r.meetings * POINTS.meeting + r.won * POINTS.won;
      var allInTime = mine.every(function (l) { var c = clock(l, now); return c.state === 'done' && c.onTime; });
      var badges = [];
      if (r.captured >= 1) badges.push('first');
      if (r.captured >= 10) badges.push('ten');
      if (st.best >= 3) badges.push('hothand');
      if (r.quick) badges.push('quick');
      if (r.captured >= 5 && allInTime) badges.push('nocold');
      if (r.won >= 1) badges.push('closer');
      if (opts.boothCost > 0 && r.wonValue >= opts.boothCost) badges.push('rainmaker');
      r.badges = badges;
      delete r.quick;
      return r;
    });
    rows.sort(function (a, b) { return b.points - a.points || b.captured - a.captured || String(a.name).localeCompare(String(b.name)); });
    var rank = 0; var prev = null;
    rows.forEach(function (r, i) { if (prev === null || r.points !== prev) rank = i + 1; prev = r.points; r.rank = rank; });
    return rows;
  }

  /* ---------------- the show scorecard ---------------- */

  function dayOf(iso) { return String(iso || '').slice(0, 10); }
  function pct(n, d) { return d ? Math.round(n / d * 100) : 0; }

  /**
   * The whole show in numbers. Everything is counted from the leads on each
   * call - nothing here is a stored total that could drift.
   */
  function scorecard(event, leads, now) {
    leads = leads || [];
    var cost = Number(event && event.boothCost) || 0;
    var s = {
      leads: leads.length,
      temps: { hot: 0, warm: 0, cold: 0 },
      followedUp: 0, within48: 0, onTime: 0, wentCold: 0, coolingNow: 0,
      replies: 0, meetings: 0, won: 0, lost: 0,
      wonValue: 0, pipelineValue: 0, openWithValue: 0,
      boothCost: cost,
    };
    var chips = {}; var next = {}; var days = {};
    leads.forEach(function (l) {
      s.temps[l.temp] = (s.temps[l.temp] || 0) + 1;
      var c = clock(l, now);
      if (c.state === 'done') {
        s.followedUp++;
        if (c.tookMs <= 48 * HOUR) s.within48++;
        if (c.onTime) s.onTime++;
      }
      if (c.state === 'cold') s.wentCold++;
      if (c.state === 'cooling') s.coolingNow++;
      if (l.repliedAt) s.replies++;
      if (l.bookedAt) s.meetings++;
      if (l.wonAt) { s.won++; s.wonValue += Number(l.value) || 0; }
      else if (l.lostAt) s.lost++;
      else if (Number(l.value) > 0) { s.pipelineValue += Number(l.value); s.openWithValue++; }
      (l.chips || []).forEach(function (ch) { chips[ch] = (chips[ch] || 0) + 1; });
      if (l.next) next[l.next] = (next[l.next] || 0) + 1;
      var d = dayOf(l.capturedAt);
      if (d) days[d] = (days[d] || 0) + 1;
    });
    s.within48Rate = pct(s.within48, s.leads);
    s.onTimeRate = pct(s.onTime, s.leads);
    s.replyRate = pct(s.replies, s.followedUp);
    s.costPerLead = cost && s.leads ? Math.round(cost / s.leads * 100) / 100 : null;
    s.costPerMeeting = cost && s.meetings ? Math.round(cost / s.meetings) : null;
    s.roi = cost ? Math.round((s.wonValue - cost) / cost * 100) : null;
    s.coverage = cost ? Math.round((s.wonValue + s.pipelineValue) / cost * 10) / 10 : null;
    s.funnel = [
      { key: 'captured', label: 'Captured', n: s.leads },
      { key: 'followed', label: 'Followed up', n: s.followedUp },
      { key: 'replied', label: 'Replied', n: s.replies },
      { key: 'meetings', label: 'Meetings', n: s.meetings },
      { key: 'won', label: 'Won', n: s.won },
    ];
    s.chips = Object.keys(chips).map(function (k) { return { chip: k, n: chips[k] }; }).sort(function (a, b) { return b.n - a.n || a.chip.localeCompare(b.chip); });
    s.next = NEXT_KEYS.filter(function (k) { return next[k]; }).map(function (k) { return { key: k, label: nextInfo(k).label, n: next[k] }; });
    s.days = Object.keys(days).sort().map(function (d) { return { day: d, n: days[d] }; });
    s.verdict = verdict(s);
    return s;
  }

  function money(n) {
    var v = Math.round(Number(n) || 0);
    return '$' + String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** One sentence on whether the booth paid for itself, and what to do. */
  function verdict(s) {
    if (!s.leads) return { key: 'empty', emoji: '🎪', text: 'No leads yet. The scorecard fills in as the team captures.' };
    if (s.boothCost && s.wonValue >= s.boothCost) {
      return { key: 'paid', emoji: '🎉', text: 'The booth paid for itself ' + (Math.round(s.wonValue / s.boothCost * 10) / 10) + '× over - ' + money(s.wonValue) + ' won on a ' + money(s.boothCost) + ' booth.' };
    }
    if (s.boothCost && s.wonValue + s.pipelineValue >= s.boothCost) {
      return { key: 'pipeline', emoji: '📈', text: 'The pipeline covers the booth ' + s.coverage + '×. Now close it: ' + money(s.boothCost - s.wonValue) + ' more won and it has paid for itself.' };
    }
    if (s.wentCold) return { key: 'cold', emoji: '🧊', text: s.wentCold + ' lead' + (s.wentCold === 1 ? '' : 's') + ' went cold without a follow-up. Send those today - late still beats never.' };
    if (!s.boothCost) return { key: 'nocost', emoji: '🧾', text: 'Add what the booth cost to see whether the show paid off.' };
    return { key: 'early', emoji: '⏳', text: 'Not paying off yet - follow up fast, log replies and deal values as they land.' };
  }

  /* ---------------- follow-up templates (free, no model) ---------------- */

  function listJoin(a) {
    if (!a.length) return '';
    if (a.length === 1) return a[0];
    return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  }

  var NEXT_LINE = {
    hot: {
      call: 'Would a quick call this week work? Send me a time that suits you and I’ll ring you then.',
      demo: 'I’d love to set up the demo we talked about - what does your week look like?',
      quote: 'I’ll put a quote together. Can you confirm the details I should price?',
      info: 'I’m putting together the information you asked for - tell me if anything else would help.',
      '': 'What would be a good next step on your side?',
    },
    warm: {
      call: 'No rush - whenever it suits, I’m happy to jump on a short call.',
      demo: 'Whenever the timing is right, I’d be glad to walk you through a demo.',
      quote: 'When you’re ready, I can put a quote together - just say the word.',
      info: 'I’m happy to send more information whenever it would help.',
      '': 'Whenever the timing is right, I’m here.',
    },
    cold: {
      call: 'If a call is ever useful, just reply and we’ll find a time.',
      demo: 'If you ever want a look, reply and I’ll set up a demo.',
      quote: 'If a quote would ever help, reply and I’ll put one together.',
      info: 'If more information would ever help, just reply.',
      '': 'If it’s ever useful, just reply - I’d be glad to help.',
    },
  };

  /**
   * A follow-up from what was captured, and nothing else: first name, the
   * show, the interests ticked and the next step. The note is the rep's own,
   * not the customer's, so it is never quoted.
   */
  function template(lead, event, rep) {
    var t = TEMPS.some(function (x) { return x.key === lead.temp; }) ? lead.temp : 'warm';
    var first = firstName(lead.name);
    var show = clean(event && event.name, LIMITS.eventName) || 'the show';
    var chips = (lead.chips || []).map(function (c) { return String(c).toLowerCase(); });
    var sign = clean((rep && (rep.signoff || rep.name)) || '', LIMITS.signoff);
    var subject = t === 'hot' ? 'Great to meet you at ' + show : t === 'warm' ? 'Good to meet you at ' + show : 'Thanks for stopping by at ' + show;
    var opener = t === 'hot'
      ? 'Thanks for stopping by our booth at ' + show + ' - it was great to talk.'
      : t === 'warm'
        ? 'Thanks for coming by our booth at ' + show + '.'
        : 'Thanks for visiting our booth at ' + show + '.';
    var interest = chips.length ? ' You asked about ' + listJoin(chips) + '.' : '';
    var line = NEXT_LINE[t][lead.next && NEXT_LINE[t][lead.next] ? lead.next : ''];
    var body = 'Hi ' + (first || 'there') + ',\n\n' + opener + interest + '\n\n' + line + '\n\n' + (t === 'cold' ? 'All the best,' : 'Thanks,') + (sign ? '\n' + sign : '');
    return { subject: subject.slice(0, LIMITS.subject), body: body.slice(0, LIMITS.body) };
  }

  /** A mailto: link the rep's own mail app opens. Booth sends nothing. */
  function mailto(email, subject, body) {
    var e = normEmail(email);
    if (!isEmail(e)) return '';
    return 'mailto:' + e + '?subject=' + encodeURIComponent(subject || '') + '&body=' + encodeURIComponent(body || '');
  }

  /* ---------------- days and codes ---------------- */

  function isoDay(v) {
    var s = String(v || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    var d = new Date(s + 'T12:00:00Z');
    return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
  }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / DAY); }

  function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16); }
  function isCode(v) { return CODE_RE.test(String(v || '')); }
  function formatCode(v) { var s = normalizeCode(v); return s.length === CODE_LEN ? s.slice(0, 4) + '-' + s.slice(4) : s; }

  return {
    HOUR: HOUR, DAY: DAY,
    TEMPS: TEMPS, TEMP_KEYS: TEMP_KEYS, NEXT_STEPS: NEXT_STEPS, NEXT_KEYS: NEXT_KEYS, STATUSES: STATUSES, STATUS_KEYS: STATUS_KEYS,
    TONES: TONES, TONE_KEYS: TONE_KEYS, DEFAULT_CHIPS: DEFAULT_CHIPS, LIMITS: LIMITS, POINTS: POINTS, BADGES: BADGES,
    CODE_ALPHABET: CODE_ALPHABET, CODE_LEN: CODE_LEN,
    tempInfo: tempInfo, nextInfo: nextInfo, statusInfo: statusInfo, badgeInfo: badgeInfo, hotter: hotter,
    clean: clean, cleanText: cleanText,
    isEmail: isEmail, normEmail: normEmail, isPhone: isPhone, phoneKey: phoneKey, firstName: firstName, toNumber: toNumber,
    validateLead: validateLead, findDuplicate: findDuplicate, mergePatch: mergePatch, applyStatus: applyStatus,
    clock: clock, duration: duration, clockLabel: clockLabel, goingCold: goingCold,
    hotStreak: hotStreak, leaderboard: leaderboard, scorecard: scorecard, verdict: verdict, money: money,
    template: template, mailto: mailto,
    isoDay: isoDay, daysBetween: daysBetween, normalizeCode: normalizeCode, isCode: isCode, formatCode: formatCode,
  };
});
