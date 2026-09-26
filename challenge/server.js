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
    const apps = await Promise.all(lab.APPS.map(async (a) => {
      const [tally, mine] = await Promise.all([
        store.get('lab_votes', a.slug),
        vid ? store.get('lab_voters', `${a.slug}:${vid}`) : null,
      ]);
      const t = tally || {};
      const build = buildStats && buildStats.apps[a.slug];
      return { ...a, live: mounted.includes(a.slug), votes: { keep: t.keep || 0, kill: t.kill || 0 }, myVote: mine ? mine.v : null, ...(build ? { build } : {}) };
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ apps, now: new Date().toISOString(), ...(buildStats ? { buildTotals: { ...buildStats.totals, updated: buildStats.updated } } : {}) });
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
        keep, kill, votes, keepPct: votes ? Math.round((keep / votes) * 100) : null,
        score: wilsonLow(keep, votes), order: i,
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
    const tally = (await store.get('lab_votes', a.slug)) || {};
    res.json({ votes: { keep: Math.max(0, tally.keep || 0), kill: Math.max(0, tally.kill || 0) }, myVote: v });
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

module.exports = { host, mounted, standings, readBuildStats };
