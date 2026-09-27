// The challenge lab: challenge.strongtechnicalconsulting.com
//
// One Cloud Run service that serves a landing page at / and every trial app
// at /<slug>/. Why one service rather than one per app: a new app then needs
// no new infrastructure at all - no service, no database, no runtime account,
// no IAM change for Erik to make - it is a folder and a registry entry. An app
// that earns it graduates to its own subdomain and service (CLAUDE.md).
//
// Each app is an ordinary Express app exported from apps/<slug>/server.js and
// mounted as a sub-app. Before it is required, the host sets
// <SLUG>_COLLECTION_PREFIX so its data lands in `<slug>_*` collections of the
// shared `challenge` database - apps never see each other's collections by
// name, and graduating one is a copy of its prefix.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const lab = require('./lab');

const PORT = process.env.PORT || 8080;
const MEMORY = process.env.LAB_MEMORY === '1';
if (MEMORY && process.env.K_SERVICE) throw new Error('LAB_MEMORY=1 is for local use only.');

const host = express();
host.set('trust proxy', 1);
host.disable('x-powered-by');

/* ---------------- mount the apps ---------------- */

const mounted = [];
for (const a of lab.APPS) {
  if (a.status !== 'testing') continue;
  const dir = path.join(__dirname, 'apps', a.slug);
  if (!fs.existsSync(path.join(dir, 'server.js'))) {
    console.warn(`[lab] ${a.slug}: no apps/${a.slug}/server.js, not mounted`);
    continue;
  }
  const KEY = a.slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (process.env[`${KEY}_COLLECTION_PREFIX`] === undefined) process.env[`${KEY}_COLLECTION_PREFIX`] = `${a.slug}_`;
  if (MEMORY) {
    process.env[`${KEY}_MEMORY`] = '1';
    process.env[`${KEY}_FAKE_AI`] = '1';
  }
  try {
    const sub = require(path.join(dir, 'server.js')).app;
    // A relative asset link only resolves under the trailing slash.
    // Express matches /spar and /spar/ alike, so check the raw path or this
    // redirects /spar/ to itself forever.
    host.use((req, res, next) => {
      const [p, q = ''] = req.originalUrl.split(/\?(.*)/s);
      if (p !== `/${a.slug}`) return next();
      res.redirect(301, `/${a.slug}/${q ? `?${q}` : ''}`);
    });
    host.use(`/${a.slug}`, sub);
    mounted.push(a.slug);
  } catch (err) {
    // One broken app must never take the lab down with it.
    console.error(`[lab] ${a.slug} failed to load:`, err.message);
  }
}
console.log(`[lab] mounted: ${mounted.join(', ') || 'none'}`);

/* ---------------- the lab's own data: votes and notes ---------------- */

const store = (() => {
  if (MEMORY) {
    const m = new Map();
    return {
      async get(c, id) { return m.get(`${c}/${id}`) || null; },
      async set(c, id, v) { m.set(`${c}/${id}`, v); },
      async bump(c, id, d) { const cur = m.get(`${c}/${id}`) || {}; for (const [k, v] of Object.entries(d)) cur[k] = (cur[k] || 0) + v; m.set(`${c}/${id}`, cur); },
      async add(c, v) { m.set(`${c}/${Date.now()}${Math.random()}`, v); },
      async merge(c, id, unions) {
        const cur = { ...(m.get(`${c}/${id}`) || {}) };
        for (const [k, vals] of Object.entries(unions)) cur[k] = [...new Set([...(Array.isArray(cur[k]) ? cur[k] : []), ...vals])];
        m.set(`${c}/${id}`, cur);
      },
    };
  }
  const { Firestore, FieldValue } = require('@google-cloud/firestore');
  const db = new Firestore({
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    databaseId: process.env.FIRESTORE_DATABASE_ID || 'challenge',
    ignoreUndefinedProperties: true,
  });
  return {
    async get(c, id) { const s = await db.collection(c).doc(id).get(); return s.exists ? s.data() : null; },
    async set(c, id, v) { await db.collection(c).doc(id).set(v); },
    async bump(c, id, d) {
      const patch = {};
      for (const [k, v] of Object.entries(d)) patch[k] = FieldValue.increment(v);
      await db.collection(c).doc(id).set(patch, { merge: true });
    },
    async add(c, v) { await db.collection(c).add(v); },
    // Set-union into array fields, so two votes at once cannot drop a day.
    async merge(c, id, unions) {
      const patch = {};
      for (const [k, vals] of Object.entries(unions)) if (vals.length) patch[k] = FieldValue.arrayUnion(...vals);
      if (Object.keys(patch).length) await db.collection(c).doc(id).set(patch, { merge: true });
    },
  };
})();

// An opaque random visitor id, first-party, so a vote can be changed but not
// stuffed from one browser. No IP, no user agent, nothing tied to an account.
const VID = 'lab_vid';
/** The visitor id the request carried, or null. Never mints one. */
function visitorId(req) {
  const m = /(?:^|;\s*)lab_vid=([A-Za-z0-9_-]{16,40})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function visitor(req, res) {
  const known = visitorId(req);
  if (known) return known;
  const id = crypto.randomBytes(16).toString('base64url');
  res.append('Set-Cookie', `${VID}=${id}; Path=/; Max-Age=${60 * 60 * 24 * 400}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return id;
}

/* ---------------- build stats: what each app cost to make ---------------- */

// build-stats.json is written by scripts/token-ledger.py --stats from the
// builder agents' transcripts (TOKENS.md, CLAUDE.md). Read once at startup:
// it only changes with a deploy. Missing or malformed, the lab simply serves
// no `build` fields and the page draws no stats; it never stops the lab.
const BUILD_STATS_FILE = process.env.BUILD_STATS_FILE || path.join(__dirname, 'build-stats.json');
const COUNT = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
/** Pure: the file's parsed JSON -> {apps: {slug: row}, totals, updated} or null. */
function readBuildStats(raw) {
  if (!raw || typeof raw !== 'object' || !raw.apps || typeof raw.apps !== 'object' || Array.isArray(raw.apps)) return null;
  const apps = {};
  for (const [slug, r] of Object.entries(raw.apps)) {
    if (!/^[a-z0-9-]{1,40}$/.test(slug) || !r || typeof r !== 'object') continue;
    const row = {
      in: COUNT(r.in), cached: COUNT(r.cached), out: COUNT(r.out),
      agents: COUNT(r.agents), agentMs: COUNT(r.agentMs), wallMs: COUNT(r.wallMs),
      exact: r.exact === true,
      note: typeof r.note === 'string' ? r.note.replace(/[<>]/g, '').slice(0, 300) : '',
    };
    if (row.in === null || row.out === null) continue;
    apps[slug] = row;
  }
  const rows = Object.values(apps);
  if (!rows.length) return null;
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  const knownIn = rows.filter((r) => r.cached !== null).reduce((n, r) => n + r.in, 0);
  const totals = {
    in: sum('in'), cached: sum('cached'), out: sum('out'), agents: sum('agents'),
    agentMs: sum('agentMs'), wallMs: sum('wallMs'), apps: rows.length,
    estimated: rows.filter((r) => !r.exact).length,
    cachedShare: knownIn ? Math.round((sum('cached') / knownIn) * 1e4) / 1e4 : null,
  };
  const updated = typeof raw.updated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.updated) ? raw.updated : null;
  return { apps, totals, updated };
}
const buildStats = (() => {
  try { return readBuildStats(JSON.parse(fs.readFileSync(BUILD_STATS_FILE, 'utf8'))); } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[lab] build-stats.json unreadable:', err.message);
    return null;
  }
})();

/* ---------------- the crowd reveal and the voting streak ---------------- */

// A split is shown only to someone who has voted on that app, and only with
// MIN_SPLIT votes behind it. Before the first tap the page says how many
// voted, never which way: the crowd must not steer the first vote. The
// public leaderboard carries no split either (2026-09-27): rank, votes and
// the leader's name only, so this is the only way to see a keep %.
const MIN_SPLIT = 5;
/** Pure: a tally and this visitor's vote -> {votes: {total}, split|null}. */
function reveal(tally, myVote) {
  const t = tally || {};
  const keep = Math.max(0, Math.floor(Number(t.keep) || 0));
  const kill = Math.max(0, Math.floor(Number(t.kill) || 0));
  const total = keep + kill;
  const split = (myVote === 'keep' || myVote === 'kill') && total >= MIN_SPLIT
    ? { keep, kill, keepPct: Math.round((keep / total) * 100) }
    : null;
  return { votes: { total }, split, splitAt: MIN_SPLIT };
}

// The streak: consecutive DROP days on which this browser voted on that
// day's drop while it was the newest one. "Newest" is read from the
// registry this instance is running, not the clock: a drop is today's from
// the deploy that ships it until the deploy that ships the next, whatever
// time zone the voter is in. A day with no drop (a missed routine) is not a
// drop day, so it neither counts nor breaks a streak. Stored per lab_vid in
// lab_streaks/<vid> as {days: [drop dates], earned: [badge ids]} - dates of
// drops, never a time, an IP or anything about the device. Computed inside
// the request, nothing scheduled.
const BADGES = [
  { id: 'first', label: 'First vote', hint: 'Vote keep or kill on any drop.' },
  { id: 'streak3', label: '3-day streak', hint: 'Vote on the new drop three drop days running.' },
  { id: 'streak7', label: '7-day streak', hint: 'Vote on the new drop seven drop days running.' },
  { id: 'fullweek', label: 'Full week', hint: 'Vote on every drop from the past seven days.' },
  { id: 'contrarian', label: 'Contrarian', hint: 'Side with under 35% of at least 5 votes.' },
];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Pure: every drop date in the registry, newest first. */
function dropDays(apps) {
  return [...new Set(apps.map((a) => a.dropped).filter((d) => DAY_RE.test(d || '')))].sort().reverse();
}
/** Pure: the drops of the seven days ending at the newest drop date. */
function weekDrops(apps) {
  const [newest] = dropDays(apps);
  if (!newest) return [];
  const from = new Date(Date.parse(`${newest}T00:00:00Z`) - 6 * 864e5).toISOString().slice(0, 10);
  return apps.filter((a) => a.status !== 'retired' && a.dropped >= from && a.dropped <= newest);
}
/** Pure: credited drop dates + the registry -> {current, best, pending}. */
function streakOf(days, apps) {
  const D = dropDays(apps);
  const S = new Set((Array.isArray(days) ? days : []).filter((d) => typeof d === 'string'));
  if (!D.length) return { current: 0, best: 0, pending: false };
  // Not yet voted on today's drop: yesterday's streak is still alive.
  const pending = !S.has(D[0]);
  let current = 0;
  for (let i = pending ? 1 : 0; i < D.length && S.has(D[i]); i++) current++;
  let best = 0, run = 0;
  for (const d of [...D].reverse()) { run = S.has(d) ? run + 1 : 0; best = Math.max(best, run); }
  // pending: a streak is alive and waits on today's vote.
  return { current, best, pending: pending && current > 0 };
}
/** Pure: the stored record, the registry and this browser's votes -> `me`. */
function progress(rec, apps, myVotes) {
  const r = rec || {};
  const st = streakOf(r.days, apps);
  const earned = new Set(Array.isArray(r.earned) ? r.earned : []);
  const week = weekDrops(apps);
  if (st.best >= 3) earned.add('streak3');
  if (st.best >= 7) earned.add('streak7');
  if (week.length >= 2 && week.every((a) => myVotes[a.slug])) earned.add('fullweek');
  const open = apps.filter((a) => a.status !== 'retired');
  const [newest] = dropDays(apps);
  return {
    streak: st.current, best: st.best, pending: st.pending,
    voted: open.filter((a) => myVotes[a.slug]).length, of: open.length,
    today: apps.filter((a) => a.dropped === newest && a.status === 'testing').map((a) => a.slug),
    badges: BADGES.map((b) => ({ ...b, earned: earned.has(b.id) })),
  };
}

const lj = express.json({ limit: '8kb' });

host.get('/api/health', (_req, res) => res.json({ ok: true, apps: mounted }));
host.get('/healthz', (_req, res) => res.json({ ok: true }));

// The main site's /challenge page draws the live drops from here.
const SITE_ORIGINS = new Set(['https://www.strongtechnicalconsulting.com', 'https://strongtechnicalconsulting.com']);

host.get('/api/lab', async (req, res) => {
  try {
    const origin = req.get('origin');
    if (origin && SITE_ORIGINS.has(origin)) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); }
    // Two readers. The landing page's banner reads this cross-origin on every
    // home-page view, with no cookie (credentials: 'omit'), so it is never
    // handed an id. The lab's own page reads it same-origin (a same-origin GET
    // carries no Origin header) and is handed one here, before anything can
    // be tapped: otherwise two votes cast before the first reply would each
    // mint an id, the second cookie would replace the first, and one browser
    // would hold two votes. The reads run together rather than one after
    // another: the list grows by an app a day.
    const sameOrigin = !origin || req.get('sec-fetch-site') === 'same-origin';
    const vid = sameOrigin ? visitor(req, res) : visitorId(req);
    const [apps, rec] = await Promise.all([
      Promise.all(lab.APPS.map(async (a) => {
        const [tally, mine] = await Promise.all([
          store.get('lab_votes', a.slug),
          vid ? store.get('lab_voters', `${a.slug}:${vid}`) : null,
        ]);
        const myVote = mine && (mine.v === 'keep' || mine.v === 'kill') ? mine.v : null;
        const build = buildStats && buildStats.apps[a.slug];
        return { ...a, live: mounted.includes(a.slug), ...reveal(tally, myVote), myVote, ...(build ? { build } : {}) };
      })),
      vid ? store.get('lab_streaks', vid) : null,
    ]);
    const myVotes = Object.fromEntries(apps.map((a) => [a.slug, a.myVote]));
    res.set('Cache-Control', 'no-store');
    res.json({
      apps, now: new Date().toISOString(),
      ...(vid ? { me: progress(rec, lab.APPS, myVotes) } : {}),
      ...(buildStats ? { buildTotals: { ...buildStats.totals, updated: buildStats.updated } } : {}),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the lab.' });
  }
});

/* ---------------- the leaderboard ---------------- */

// Keep/Kill standings, for the lab's own page and for the main site (the home
// page's Challenge banner and its "Live now" feed, and the /challenge teaser).
//
// Ranked on the lower bound of a 95% Wilson interval on the keep share, not
// on the raw percentage: one "keep" is 100% and would outrank 40 keeps out of
// 45. Ties go to more votes, then to the newer drop. A LEADER is named only
// when it has MIN_LEAD_VOTES or more and is strictly ahead of second place;
// otherwise `leader` is null and nobody is said to lead.
//
// Counts only: no visitor ids, no notes, and it never mints the vote cookie
// (it reads nothing per visitor), whoever asks. Retired apps are left out.
//
// No split (2026-09-27, Erik): the keep and kill counts and keep % stay on
// the server. The ordering uses them; the answer carries only the rank, the
// total votes and which app leads. A keep % is shown only through /api/lab's
// per-browser reveal, to someone who has voted on that app, with 5+ votes.
const MIN_LEAD_VOTES = 2;
function wilsonLow(keep, n) {
  if (!n) return 0;
  const z = 1.96, p = keep / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}
/** Pure: the registry plus a tally per slug -> the ranked standings. */
function standings(apps, tallies) {
  const rows = apps
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.status !== 'retired')
    .map(({ a, i }) => {
      const t = (tallies && tallies[a.slug]) || {};
      const keep = Math.max(0, Math.floor(Number(t.keep) || 0));
      const kill = Math.max(0, Math.floor(Number(t.kill) || 0));
      const votes = keep + kill;
      return {
        slug: a.slug, name: a.name, emoji: a.emoji, color: a.color, color2: a.color2,
        drop: i + 1, dropped: a.dropped, status: a.status, live: mounted.includes(a.slug),
        votes, score: wilsonLow(keep, votes), order: i,
      };
    })
    .sort((x, y) => y.score - x.score || y.votes - x.votes || y.order - x.order);
  rows.forEach((r, i) => { r.rank = i + 1; });
  const [first, second] = rows;
  const leader = first && first.votes >= MIN_LEAD_VOTES && first.score > 0 && (!second || first.score > second.score) ? first.slug : null;
  return {
    apps: rows.map(({ score, order, ...r }) => r),
    leader,
    rule: 'wilson-lower-bound',
    minLeadVotes: MIN_LEAD_VOTES,
  };
}

// Fifteen seconds of memory, so every home-page poll across the internet is
// at most one read per app per 15 s. A vote on this instance clears it.
const BOARD_MS = 15 * 1000;
let boardCache = { at: 0, body: null };

host.get('/api/lab/leaderboard', async (req, res) => {
  try {
    const origin = req.get('origin');
    if (origin && SITE_ORIGINS.has(origin)) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); }
    if (!boardCache.body || Date.now() - boardCache.at > BOARD_MS) {
      const tallies = {};
      await Promise.all(lab.APPS.map(async (a) => { tallies[a.slug] = (await store.get('lab_votes', a.slug)) || {}; }));
      boardCache = { at: Date.now(), body: standings(lab.APPS, tallies) };
    }
    res.set('Cache-Control', 'public, max-age=15');
    res.json(boardCache.body);
  } catch (err) {
    console.error(err);
    res.set('Cache-Control', 'no-store');
    res.status(500).json({ error: 'Could not load the leaderboard.' });
  }
});

host.post('/api/lab/:slug/vote', lj, async (req, res) => {
  try {
    const a = lab.get(req.params.slug);
    if (!a) return res.status(404).json({ error: 'No such app.' });
    const v = (req.body || {}).v;
    if (!['keep', 'kill', null].includes(v)) return res.status(400).json({ error: 'Vote keep or kill.' });
    const vid = visitor(req, res);
    const key = `${a.slug}:${vid}`;
    const prev = await store.get('lab_voters', key);
    const d = {};
    if (prev && prev.v) d[prev.v] = -1;
    if (v) d[v] = (d[v] || 0) + 1;
    if (Object.keys(d).length) { await store.bump('lab_votes', a.slug, d); boardCache = { at: 0, body: null }; }
    await store.set('lab_voters', key, { v, at: new Date().toISOString() });
    const [tally, before] = await Promise.all([store.get('lab_votes', a.slug), store.get('lab_streaks', vid)]);
    const shown = reveal(tally, v);
    // This browser's other votes, for the badges: only this week's drops are
    // read (a handful), not every drop the lab has ever had.
    const week = weekDrops(lab.APPS);
    const myVotes = { [a.slug]: v };
    await Promise.all(week.filter((w) => w.slug !== a.slug).map(async (w) => {
      const m = await store.get('lab_voters', `${w.slug}:${vid}`);
      myVotes[w.slug] = m && (m.v === 'keep' || m.v === 'kill') ? m.v : null;
    }));
    const was = progress(before, lab.APPS, { ...myVotes, [a.slug]: prev && (prev.v === 'keep' || prev.v === 'kill') ? prev.v : null });
    const add = { days: [], earned: [] };
    if (v) {
      add.earned.push('first');
      if (a.dropped === dropDays(lab.APPS)[0]) add.days.push(a.dropped);
      if (shown.split && (v === 'keep' ? shown.split.keepPct : 100 - shown.split.keepPct) < 35) add.earned.push('contrarian');
      if (week.length >= 2 && week.every((w) => myVotes[w.slug])) add.earned.push('fullweek');
    }
    const r = before || {};
    const rec = {
      days: [...new Set([...(Array.isArray(r.days) ? r.days : []), ...add.days])],
      earned: [...new Set([...(Array.isArray(r.earned) ? r.earned : []), ...add.earned])],
    };
    if (add.days.some((d) => !(r.days || []).includes(d)) || add.earned.some((e) => !(r.earned || []).includes(e))) {
      await store.merge('lab_streaks', vid, add);
    }
    const me = progress(rec, lab.APPS, myVotes);
    const had = new Set(was.badges.filter((b) => b.earned).map((b) => b.id));
    // voted/of counted over this week only here; the page counts every drop itself.
    delete me.voted; delete me.of;
    res.json({ ...shown, myVote: v, me, newBadges: me.badges.filter((b) => b.earned && !had.has(b.id)).map((b) => b.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not record that.' });
  }
});

// Feedback goes to Erik, not to the page: it is never displayed, so there is
// nothing to moderate and nothing for a stranger to deface.
host.post('/api/lab/:slug/note', lj, async (req, res) => {
  try {
    const a = lab.get(req.params.slug);
    if (!a) return res.status(404).json({ error: 'No such app.' });
    const text = String((req.body || {}).text || '').replace(/[<>]/g, '').trim().slice(0, 600);
    if (text.length < 3) return res.status(400).json({ error: 'Say a little more.' });
    await store.add('lab_notes', { slug: a.slug, text, vid: visitor(req, res), at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send that.' });
  }
});

host.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  next();
});
host.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
host.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
host.use((_req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  host.listen(PORT, () => console.log(`[lab] listening on ${PORT}${MEMORY ? ' (memory)' : ''}`));
}

module.exports = { host, mounted, store, standings, readBuildStats, reveal, streakOf, progress, dropDays, weekDrops, BADGES, MIN_SPLIT };
