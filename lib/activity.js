// "Live now": the home page's activity feed, GET /api/activity.
//
// A handful of lines about what is happening across the apps right now -
// "Hopscotch was opened 4 times in the last 15 min", "Receipt dropped in the
// lab", "Glowup took the lead in Keep votes", "Friction spotted a spike" -
// plus the lab's Keep/Kill standings for the Challenge banner. Public, so it
// is built to say nothing about any one person.
//
// PRIVACY IS THE DESIGN, not a filter bolted on after:
//   - App-level events and counts only. Nothing here ever sees a visitor id,
//     an IP, a user agent, a path, a referrer, an email, a city or a trip:
//     the only input from the view counter is an app key from its allowlist
//     (lib/views.js APPS), and the landing page itself is left out.
//   - A count below MIN_COUNT is not shown at all. "1 person opened Trip
//     Planner in the last 15 min" tells whoever sent them the link exactly
//     when they did; "4 times" tells nobody anything.
//   - Times leave this file only as buckets ("last 15 min", "3 h ago",
//     "yesterday"). No timestamp is in the response.
//   - The response is a fixed shape - items of {kind, icon, name, text, when,
//     href} - built field by field, never a spread of anything upstream sent.
//   - The private family vacation app is not tracked by the view counter and
//     is not named here. A last check drops any line that would name it, in
//     case an upstream ever did.
//
// Cost: the response is cached in memory for CACHE_MS, so any number of
// viewers polling every 30 s costs one build per 15 s per instance, and each
// source has its own, longer memory (the lab 60 s, Friction 5 min, today's
// counts 60 s). Everything is done inside the request that finds the cache
// stale, and awaited before the answer - this service is billed per request
// (cpuIdle), and there is no timer here, on purpose.
//
// Recent opens come from two places, and the larger wins (both are lower
// bounds, so the larger is the truer one):
//   - this instance's own beacons, in a per-minute ring (recordView), capped
//     at an hour. Lost when the instance stops - but Cloud Run stops an
//     instance only after a stretch with no requests, i.e. no beacons, so
//     what is lost was mostly empty anyway.
//   - the difference between two reads of today's Firestore counters (the
//     view counter's own daily documents - no new writes), which sees every
//     instance's beacons. Only snapshots INSIDE the window are used, so the
//     difference can undercount a window, never overcount it.
//
// The one thing written: the lab's current Keep leader and when it took the
// lead (activity/lab-leader), so "took the lead" survives a cold start and is
// not announced again by every new instance. One small document, rewritten
// only when the leader changes.

'use strict';

const { APPS } = require('./views');

const CACHE_MS = 15 * 1000;
const LAB_TTL_MS = 60 * 1000;
const LAB_RETRY_MS = 30 * 1000;
const LAB_KEEP_MS = 10 * 60 * 1000;       // a failed refresh keeps the last good answer this long
const FRICTION_TTL_MS = 5 * 60 * 1000;
const FRICTION_RETRY_MS = 60 * 1000;
const FRICTION_KEEP_MS = 30 * 60 * 1000;
const TODAY_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;
const LEADER_TIMEOUT_MS = 1500;           // the leader read/write runs after the sources, so shorter
const MAX_BODY_BYTES = 256 * 1024;
const MIN_COUNT = 2;                       // below this, a count is not shown
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RING_MINUTES = 60;
const SNAP_KEEP_MS = 70 * MIN;
const SNAP_MAX = 120;
const LEAD_NEWS_MS = 6 * HOUR;             // "took the lead" is news for this long
const DROP_NEWS_MS = 2 * DAY;              // a drop is news for this long
const MAX_ITEMS = 6;
const WINDOWS = [
  { ms: 15 * MIN, label: 'last 15 min', order: 1 },
  { ms: HOUR, label: 'last hour', order: 2 },
];

// Belt and braces. The view counter's allowlist already leaves this app out
// (test/views.js asserts it); this catches a lab entry or a Friction title
// that ever named it. Not a pattern for anything else.
const NEVER = /santa[\s_-]*rosa|rosa[\s_-]*beach|vacation[\s_-]*app/i;

const LAB_DEFAULT = 'https://challenge.strongtechnicalconsulting.com';
const FRICTION_DEFAULT = 'https://friction.strongtechnicalconsulting.com';
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ *
 * Pure helpers (exported for the tests)
 * ------------------------------------------------------------------ */

/** Plain text from untrusted input: no markup, no control characters, no
 *  addresses or handles, whitespace collapsed, cut to `max` characters (by
 *  code point, so an emoji is never split). */
function clean(v, max) {
  let s = String(v == null ? '' : v)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '…')
    .replace(/\bhttps?:\/\/\S+/gi, '…')
    .replace(/(^|\s)@[A-Za-z0-9_]{2,}/g, '$1…')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  if (chars.length > max) s = chars.slice(0, Math.max(1, max - 1)).join('').trimEnd() + '…';
  return s;
}

/** A coarse "when" for an event that happened `ms` ago. Never finer than
 *  fifteen minutes, so a line cannot be matched to one visit. */
function whenLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 15 * MIN) return 'last 15 min';
  if (ms < HOUR) return 'last hour';
  if (ms < DAY) return Math.floor(ms / HOUR) + ' h ago';
  if (ms < 2 * DAY) return 'yesterday';
  return Math.floor(ms / DAY) + ' days ago';
}

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(t));
}

/* ------------------------------------------------------------------ *
 * The feed
 * ------------------------------------------------------------------ */

function createActivity(opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const fetchImpl = o.fetch || (typeof fetch === 'function' ? fetch : null);
  const LAB = String(o.labUrl || process.env.LAB_URL || LAB_DEFAULT).replace(/\/+$/, '');
  const FRICTION = String(o.frictionUrl || process.env.FRICTION_URL || FRICTION_DEFAULT).replace(/\/+$/, '');
  const todayCounts = typeof o.todayCounts === 'function' ? o.todayCounts : null;
  const leaderStore = o.leaderStore || null;
  const log = o.log || ((...a) => console.error(...a));

  // The apps whose opens may be reported: the counter's allowlist minus the
  // landing page (every visitor starts there, so it would lead every line).
  const APP_KEYS = Object.keys(APPS).filter((k) => k !== 'landing');
  const isApp = (k) => APP_KEYS.includes(k);

  // Where a line about an app opens. Friction's signed-in board is a sign-in
  // page to everyone else, so it opens the public preview, as its card does.
  const appHref = (k) => (k === 'friction' ? FRICTION_DEFAULT + '/preview' : APPS[k].url);

  /* ---- this instance's beacons: a per-minute ring, an hour long ---- */
  const ring = new Map(); // minute index -> { app: count }
  function prune(nowMs) {
    const oldest = Math.floor(nowMs / MIN) - RING_MINUTES;
    for (const k of ring.keys()) if (k <= oldest) ring.delete(k);
  }
  function recordView(app) {
    if (!isApp(app)) return;
    const t = now();
    const m = Math.floor(t / MIN);
    const slot = ring.get(m) || {};
    slot[app] = (slot[app] || 0) + 1;
    ring.set(m, slot);
    if (ring.size > RING_MINUTES + 1) prune(t);
  }
  function ringCount(app, windowMs, nowMs) {
    const from = Math.floor((nowMs - windowMs) / MIN);
    let n = 0;
    for (const [m, slot] of ring) if (m > from && slot[app]) n += slot[app];
    return n;
  }

  /* ---- today's counters, and the snapshots that turn them into windows ---- */
  const today = { at: 0, value: null };
  const snaps = []; // { at, day, apps: { app: views } }
  async function readToday(t) {
    if (!todayCounts) return null;
    if (today.value && t - today.at < TODAY_TTL_MS) return today.value;
    today.at = t; // a failure is not retried on every request either
    try {
      const v = await withTimeout(Promise.resolve(todayCounts()), FETCH_TIMEOUT_MS);
      if (!v || typeof v !== 'object' || !v.apps || typeof v.apps !== 'object') throw new Error('bad shape');
      const apps = {};
      for (const k of APP_KEYS) {
        const a = v.apps[k] || {};
        apps[k] = { views: Math.max(0, Math.floor(Number(a.views) || 0)), uniques: Math.max(0, Math.floor(Number(a.uniques) || 0)) };
      }
      today.value = { day: ISO_DAY.test(v.day) ? v.day : null, apps };
      snaps.push({ at: t, day: today.value.day, apps: Object.fromEntries(APP_KEYS.map((k) => [k, apps[k].views])) });
      while (snaps.length > SNAP_MAX || (snaps.length && t - snaps[0].at > SNAP_KEEP_MS)) snaps.shift();
    } catch (err) {
      log('activity: today counts', err && err.message);
      today.value = null;
    }
    return today.value;
  }
  function deltaCount(app, windowMs, nowMs, cur) {
    if (!cur || !cur.day) return 0;
    const first = snaps.find((s) => s.day === cur.day && nowMs - s.at <= windowMs);
    if (!first) return 0;
    return Math.max(0, cur.apps[app].views - (first.apps[app] || 0));
  }

  /* ---- upstream JSON, bounded and time-limited ---- */
  async function getJson(url) {
    if (!fetchImpl) throw new Error('no fetch');
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = setTimeout(() => { if (ctl) ctl.abort(); }, FETCH_TIMEOUT_MS);
    try {
      const r = await withTimeout(fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'strongtechnicalconsulting-activity/1' },
        signal: ctl ? ctl.signal : undefined,
        redirect: 'error',
      }), FETCH_TIMEOUT_MS + 100);
      if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
      const text = await withTimeout(Promise.resolve(r.text()), FETCH_TIMEOUT_MS);
      if (String(text).length > MAX_BODY_BYTES) throw new Error('too large');
      return JSON.parse(text);
    } finally {
      clearTimeout(t);
    }
  }

  /** A source with its own memory: fresh for ttl, and after a failure the
   *  last good value is kept for `keep` and not asked again for `retry`. */
  function source(name, ttl, retry, keep, load) {
    const s = { good: null, goodAt: 0, triedAt: 0 };
    return async function get(t) {
      const fresh = s.good !== null && t - s.goodAt < ttl;
      const resting = t - s.triedAt < retry && s.triedAt > s.goodAt;
      if (fresh || resting) return s.good !== null && t - s.goodAt < keep ? s.good : null;
      s.triedAt = t;
      try {
        s.good = await load(t);
        s.goodAt = t;
        return s.good;
      } catch (err) {
        log('activity: ' + name, err && err.message);
        return s.good !== null && t - s.goodAt < keep ? s.good : null;
      }
    };
  }

  /* ---- the lab: standings and drops, from its /api/lab/leaderboard ---- */
  const lab = source('lab', LAB_TTL_MS, LAB_RETRY_MS, LAB_KEEP_MS, async () => normalizeBoard(await getJson(LAB + '/api/lab/leaderboard')));

  function normalizeBoard(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.apps)) throw new Error('bad shape');
    const apps = [];
    for (const a of d.apps.slice(0, 100)) {
      if (!a || typeof a !== 'object' || !SLUG.test(String(a.slug || ''))) continue;
      const name = clean(a.name, 40);
      if (!name || NEVER.test(name) || NEVER.test(a.slug)) continue;
      const keep = Math.max(0, Math.floor(Number(a.keep) || 0));
      const kill = Math.max(0, Math.floor(Number(a.kill) || 0));
      const votes = keep + kill;
      apps.push({
        slug: a.slug,
        name,
        emoji: clean(a.emoji, 4) || '🧪',
        c1: HEX.test(a.color) ? a.color : null,
        c2: HEX.test(a.color2) ? a.color2 : null,
        dropped: ISO_DAY.test(a.dropped) ? a.dropped : null,
        drop: Number.isInteger(a.drop) && a.drop > 0 ? a.drop : 0,
        live: a.live === true,
        status: ['testing', 'graduated', 'retired'].includes(a.status) ? a.status : 'testing',
        keep,
        kill,
        votes,
        keepPct: votes ? Math.round((keep / votes) * 100) : null,
        rank: Number.isFinite(Number(a.rank)) ? Math.floor(Number(a.rank)) : null,
      });
    }
    const leader = SLUG.test(String(d.leader || '')) && apps.some((a) => a.slug === d.leader) ? d.leader : null;
    return { apps, leader };
  }

  /* ---- who led the Keep votes last, and since when ---- */
  const lead = { loaded: false, slug: null, since: 0 };
  async function noteLeader(slug, t) {
    if (!lead.loaded) {
      lead.loaded = true;
      if (leaderStore) {
        try {
          const v = await withTimeout(Promise.resolve(leaderStore.get()), LEADER_TIMEOUT_MS);
          if (v && SLUG.test(String(v.slug || ''))) {
            lead.slug = v.slug;
            const since = Date.parse(v.since);
            lead.since = Number.isFinite(since) ? since : 0;
          }
        } catch (err) { log('activity: leader read', err && err.message); }
      }
      // Nothing remembered: this is the first sighting, not a change, so it
      // is recorded without being announced.
      if (!lead.slug && slug) {
        lead.slug = slug; lead.since = 0;
        await saveLeader();
        return;
      }
    }
    if (slug && slug !== lead.slug) {
      lead.slug = slug; lead.since = t;
      await saveLeader();
    }
  }
  async function saveLeader() {
    if (!leaderStore) return;
    try {
      await withTimeout(Promise.resolve(leaderStore.set({ slug: lead.slug, since: lead.since ? new Date(lead.since).toISOString() : null })), LEADER_TIMEOUT_MS);
    } catch (err) { log('activity: leader write', err && err.message); }
  }

  /* ---- Friction: problems spiking this week (optional, untrusted) ---- */
  const friction = source('friction', FRICTION_TTL_MS, FRICTION_RETRY_MS, FRICTION_KEEP_MS, async () => {
    const d = await getJson(FRICTION + '/api/spikes');
    const list = Array.isArray(d) ? d : (d && Array.isArray(d.spikes) ? d.spikes : null);
    if (!list) throw new Error('bad shape');
    const out = [];
    for (const s of list.slice(0, 50)) {
      if (!s || typeof s !== 'object') continue;
      const title = clean(s.title, 70);
      if (title.length < 4 || NEVER.test(title)) continue;
      const ratio = Number(s.ratio);
      const id = String(s.id || '');
      out.push({
        title,
        ratio: Number.isFinite(ratio) && ratio > 1 && ratio < 1000 ? Math.round(ratio * 10) / 10 : null,
        href: FRICTION_DEFAULT + '/preview' + (/^[A-Za-z0-9:_.-]{1,120}$/.test(id) ? '#' + encodeURIComponent(id) : ''),
      });
    }
    out.sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
    return out;
  });

  /* ---- assembling the lines ---- */
  function item(kind, icon, name, text, when, href, sortAge) {
    return { kind, icon, name, text, when, href, sortAge };
  }

  async function build() {
    const t = now();
    prune(t);
    const [cur, board, spikes] = await Promise.all([readToday(t), lab(t), friction(t)]);
    const items = [];

    // Recent opens: the narrowest window that has something worth saying.
    const recent = new Set();
    for (const k of APP_KEYS) {
      for (const w of WINDOWS) {
        const n = Math.max(ringCount(k, w.ms, t), deltaCount(k, w.ms, t, cur));
        if (n >= MIN_COUNT) {
          items.push(item('opens', APPS[k].icon, APPS[k].label, 'opened ' + n + ' times', w.label, appHref(k), w.ms / 3 + (1000 - Math.min(n, 999))));
          recent.add(k);
          break;
        }
      }
    }

    // The lab: a new leader, the leader, and the newest drops.
    if (board) {
      await noteLeader(board.leader, t);
      const L = board.leader ? board.apps.find((a) => a.slug === board.leader) : null;
      if (L && L.votes >= MIN_COUNT) {
        const fresh = lead.slug === L.slug && lead.since && t - lead.since < LEAD_NEWS_MS;
        items.push(fresh
          ? item('lead', L.emoji, L.name, 'took the lead in Keep votes', whenLabel(t - lead.since), LAB + '/', t - lead.since)
          : item('lead', L.emoji, L.name, 'leads the Keep votes · ' + L.keepPct + '% keep of ' + plural(L.votes, 'vote', 'votes'), 'now', LAB + '/', 3 * HOUR));
      }
      const drops = board.apps
        .filter((a) => a.dropped && a.status !== 'retired' && (a.live || a.status === 'graduated'))
        .map((a) => ({ a, at: Date.parse(a.dropped + 'T09:00:00Z') }))
        .filter((x) => Number.isFinite(x.at) && x.at <= t && t - x.at < DROP_NEWS_MS)
        // Newest first; drops on the same day by drop number, newest first.
        .sort((x, y) => y.at - x.at || y.a.drop - x.a.drop)
        .slice(0, 2);
      for (const { a, at } of drops) {
        items.push(item('drop', a.emoji, a.name, 'dropped in the lab', whenLabel(t - at), LAB + '/' + a.slug + '/', t - at));
      }
    }

    // Friction: the strongest spike this week, one line.
    if (spikes && spikes.length) {
      const s = spikes[0];
      items.push(item('spike', '\u{1F9ED}', 'Friction', 'spotted a spike: ' + s.title + (s.ratio ? ' (×' + s.ratio + ')' : ''), 'this week', s.href, 20 * HOUR));
    }

    // Today, for the apps with nothing more recent to say: people, not
    // opens, because the counter knows its uniques per day.
    if (cur) {
      APP_KEYS
        .filter((k) => !recent.has(k) && cur.apps[k].uniques >= MIN_COUNT)
        .sort((a, b) => cur.apps[b].uniques - cur.apps[a].uniques)
        .slice(0, 2)
        .forEach((k, i) => {
          items.push(item('today', APPS[k].icon, APPS[k].label, 'opened by ' + cur.apps[k].uniques + ' people', 'today', appHref(k), 12 * HOUR + i));
        });
    }

    const lines = items
      .filter((x) => !NEVER.test(x.name + ' ' + x.text))
      .sort((a, b) => a.sortAge - b.sortAge)
      .slice(0, MAX_ITEMS)
      .map(({ kind, icon, name, text, when, href }) => ({ kind, icon, name, text, when, href }));

    return {
      items: lines,
      board: board ? publicBoard(board) : null,
    };
  }

  /** The standings the page draws: a fixed shape, nothing passed through. */
  function publicBoard(b) {
    const apps = b.apps
      .filter((a) => a.status !== 'retired')
      .slice()
      .sort((x, y) => (x.rank == null ? 1e9 : x.rank) - (y.rank == null ? 1e9 : y.rank))
      .map((a, i) => ({
        slug: a.slug, name: a.name, emoji: a.emoji, c1: a.c1, c2: a.c2,
        keep: a.keep, kill: a.kill, votes: a.votes, keepPct: a.keepPct, rank: i + 1,
        href: LAB + '/' + a.slug + '/',
      }));
    return { apps, leader: b.leader, anyVotes: apps.some((a) => a.votes > 0) };
  }

  /* ---- the cache, and the route ---- */
  const cache = { at: 0, body: null };
  let inflight = null;
  async function snapshot() {
    const t = now();
    if (cache.body && t - cache.at < CACHE_MS) return cache.body;
    if (!inflight) {
      inflight = build()
        .then((body) => { cache.body = body; cache.at = now(); return body; })
        .catch((err) => { log('activity: build', err && err.message); return cache.body || { items: [], board: null }; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  async function handler(req, res) {
    try {
      const body = await snapshot();
      res.set('Cache-Control', 'public, max-age=15');
      res.json(body);
    } catch (err) {
      // Never an error the page has to explain: an empty feed hides itself.
      res.set('Cache-Control', 'no-store');
      res.json({ items: [], board: null });
    }
  }

  function mount(app) {
    app.get('/api/activity', handler);
  }

  return { mount, handler, snapshot, recordView, _state: { ring, snaps, lead, cache } };
}

/** activity/lab-leader in this service's own database: the lab's current
 *  Keep leader and when it took the lead. */
function firestoreLeaderStore(db) {
  const ref = () => db.collection('activity').doc('lab-leader');
  return {
    async get() { const s = await ref().get(); return s.exists ? s.data() : null; },
    async set(v) { await ref().set({ slug: v.slug || null, since: v.since || null }); },
  };
}

module.exports = { createActivity, firestoreLeaderStore, clean, whenLabel, MIN_COUNT, CACHE_MS };
