// Cross-app view tracking and trending, for every app on
// strongtechnicalconsulting.com.
//
// This lived in Spellbook until 2026-09-22, on the reasoning that the landing
// page was "a static, dependency-light Express server that must scale to
// zero" and giving it a database would make it a real backend. That was true
// once and had stopped being true: this service already carries a Firestore,
// an admin gate, the identity store, the uptime prober and a cron. The
// premise was stale, and the effect was that Erik's own numbers lived inside
// one of the apps they were counting.
//
// So it is here now, next to the admin panel that reads it. The beacon that
// feeds it is shared/beacon.js, carried by every app.
//
// WHAT MOVED WITH IT: nothing. The counters restart, because they were a day
// old and pointed at a database this service cannot read. Said out loud
// rather than quietly re-based.
//
// What is stored, and what deliberately is not:
//   stored      — app name, coarse path, referrer HOST, a random opaque
//                 visitor id in a first-party cookie, and counters.
//   NOT stored  — IP addresses, user agents, full referrer URLs, query
//                 strings, or anything tied to a signed-in identity.
// That is the whole privacy position: enough to count and rank, not enough to
// follow a person. Don't add an IP column "just for geo" without deciding that
// tradeoff out loud.
//
// PREVIEWS WERE COUNTED AS VIEWS, until the beacon of 2026-09-25. The landing
// page frames the apps as live phone previews, and every frame ran the
// beacon: each visitor who scrolled to the strip posted a view for Football,
// Trip Planner, DataViz, Hopscotch and Spellbook (and a unique, the first time
// that day - the frames share the landing page's visitor cookie). Friction's
// /preview page never carried the beacon. The beacon now stays silent when
// framed or on ?tour=, and beaconVerdict() below refuses a sender that says
// it is an embed. The server cannot recognise an OLD beacon's preview view -
// it posts the same body, referrer host and headers as a genuine tap through
// from the landing page - so each app's numbers are clean only from that
// app's first deploy carrying the new beacon.js.
//
// The stored counts were NOT rewritten; there is no way to tell which old
// views were frames. How long the inflation stays visible, counted from the
// LAST app's redeploy (daily buckets are UTC days):
//   views7 ("Most used this week", the Trending badge) - 7 days
//   views7Prev / trendPct - 14 days; in days 8-14 the previous week is still
//                           inflated, so trendPct reads as a steep fall that
//                           is an artifact, not a drop in use
//   views30 and the public 30-day spark - 30 days
//   the admin 90-day series - 90 days
//   totalViews, totalUniques, per-path counts - NEVER; they are running
//                           totals with no window, so anything drawn from
//                           them carries the preview era for good.

const crypto = require('crypto');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

/** This service's own database. createViews() takes a db for testability;
 *  this is what the server passes when it has none of its own to hand. */
function defaultDb() {
  return new Firestore({
    projectId: process.env.GOOGLE_CLOUD_PROJECT || 'metal-celerity-236019',
    databaseId: process.env.FIRESTORE_DATABASE_ID || 'eriks-projects',
  });
}

// The apps that may report views. An allowlist rather than free text so a
// stray or hostile beacon can't invent an app and pollute the charts.
//
// santa-rosa-beach-trip is deliberately ABSENT. It is private, holds family
// PII, and both its repo and DEPLOY.md say its hostname stays off public
// surfaces — this file is in a public repo, and a public /api/stats response
// naming it would undo that. Don't add it.
const APPS = {
  landing:   { label: 'Landing page', url: 'https://www.strongtechnicalconsulting.com', icon: '\u{1F3E0}' },
  football:  { label: 'College Football', url: 'https://footballapp.strongtechnicalconsulting.com', icon: '\u{1F3C8}' },
  hopscotch: { label: 'Hopscotch', url: 'https://beer.strongtechnicalconsulting.com', icon: '\u{1F37A}' },
  trip:      { label: 'Trip Planner', url: 'https://trip.strongtechnicalconsulting.com', icon: '✈️' },
  // The mapping for this one exists and is Ready with a certificate, same as
  // every other app here - an earlier note saying it did not was simply out
  // of date, and the landing page carried a *.run.app link because of it.
  spellbook: { label: 'Spellbook', url: 'https://spellbook.strongtechnicalconsulting.com', icon: '✨' },
  dataviz:   { label: 'DataViz', url: 'https://dataviz.strongtechnicalconsulting.com', icon: '\u{1F4CA}' },
  friction:  { label: 'Friction', url: 'https://friction.strongtechnicalconsulting.com', icon: '\u{1F9ED}' },
};

const VISITOR_COOKIE = 'sbvid';
const VISITOR_TTL_SECONDS = 60 * 60 * 24 * 400;
const SERIES_DAYS = 90;          // how much history the dashboard can draw
const PUBLIC_SERIES_DAYS = 30;   // what the landing page gets

// One instance can only be shouted at so fast. This is not a security control
// (a determined caller just waits); it stops an accidental render loop in a
// page from writing thousands of documents and running up a Firestore bill.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_PER_WINDOW = 40;
const recentHits = new Map(); // visitor id -> {count, windowStart}

// Cheap, deliberately incomplete bot screen. The goal is to keep obvious
// crawlers out of the counts, not to win an arms race.
const BOT_RE = /bot|crawl|spider|slurp|headless|preview|monitor|curl|wget|python-requests|facebookexternalhit|bingpreview|lighthouse/i;

function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function dayList(days) {
  const out = [];
  const today = Date.now();
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(isoDay(today - i * 86400000));
  }
  return out;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  });
  return out;
}

// The beacon is cross-site: the landing page at www. posts to spellbook. so
// the cookie needs SameSite=None, which in turn requires Secure. Partitioned
// keeps it working under Chrome's third-party cookie phase-out — it gives each
// top-level site its own copy, which is fine here because the count we care
// about is per-app anyway.
function setVisitorCookie(res, vid) {
  res.setHeader('Set-Cookie',
    `${VISITOR_COOKIE}=${vid}; Path=/; Max-Age=${VISITOR_TTL_SECONDS}; HttpOnly; Secure; SameSite=None; Partitioned`);
}

// Keep only the host. A full referrer URL can carry a search query or a
// session token in a path, and none of that is needed to answer "where did
// they come from".
// It takes either, deliberately. shared/beacon.js already reduces the
// referrer to a host before sending it, so `new URL()` alone would throw on
// every real beacon and quietly record no referrers at all — the symptom was
// "No external referrers yet" under every app while traffic was arriving.
// Older senders, and anything hand-rolled, may still post a full URL.
function referrerHost(ref) {
  if (!ref) return '';
  const raw = String(ref).trim();
  let h = '';
  try {
    h = new URL(raw).hostname;
  } catch (e) {
    // Not a URL. Accept it only if it actually looks like a hostname, so a
    // sentence or a path never becomes a row in the referrer table.
    h = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw) ? raw : '';
  }
  h = h.toLowerCase();
  return h.length > 100 ? '' : h;
}

// Firestore document ids cannot contain '/', and a path is mostly slashes.
function pathKey(p) {
  const clean = String(p || '/').split('?')[0].split('#')[0].slice(0, 120);
  return clean.replace(/[^A-Za-z0-9._~-]+/g, '_') || 'root';
}

// The beacon's own tour test, for a sender that posts a path WITH its query
// (the shared beacon sends location.pathname only, so it never matches).
const TOUR_RE = /[?&]tour(?:=|&|$)/;

// Explicit only. A sender that says it is embedded is taken at its word; one
// that does not say is counted, because a genuine tap through from the landing
// page and a framed preview arrive with the same referrer host and there is no
// header that tells them apart (Sec-Fetch-Dest is "empty" for any fetch).
function flagged(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * Whether one beacon body counts, and if not, why. Pure, so the rules can be
 * tested without a database: { count: true, app } or { count: false, why }.
 */
function beaconVerdict(body, userAgent) {
  const b = body && typeof body === 'object' ? body : {};
  const app = String(b.app || '').toLowerCase();
  // Own keys only: APPS['constructor'] and APPS['__proto__'] come off the
  // prototype and are truthy.
  if (!Object.prototype.hasOwnProperty.call(APPS, app)) return { count: false, why: 'unknown-app' };
  if (BOT_RE.test(userAgent || '')) return { count: false, why: 'bot' };
  if (flagged(b.embed)) return { count: false, why: 'embed' };
  if (TOUR_RE.test(String(b.path || ''))) return { count: false, why: 'tour' };
  return { count: true, app };
}

function rateLimited(vid) {
  const now = Date.now();
  const seen = recentHits.get(vid);
  if (!seen || now - seen.windowStart > RATE_WINDOW_MS) {
    recentHits.set(vid, { count: 1, windowStart: now });
    // Bounded so a long-lived instance can't grow this map without limit.
    if (recentHits.size > 5000) recentHits.clear();
    return false;
  }
  seen.count += 1;
  return seen.count > RATE_MAX_PER_WINDOW;
}

/**
 * Hacker-News-shaped decay. Views alone would let a months-old app that once
 * went round a group chat sit at the top forever; dividing by age makes
 * "trending" mean recent, which is what the word means to a reader.
 */
function trendScore(weight, ageHours) {
  return weight / Math.pow(Math.max(ageHours, 0) + 2, 1.5);
}

function createViews(opts) {
  const o = opts || {};
  const db = o.db || defaultDb();
  const requireAdmin = o.requireAdmin;
  const requireLogin = o.requireLogin || ((req, res, next) => next());
  // Told the app key of every view that counted, and nothing else - no
  // visitor, path or referrer. lib/activity.js uses it for "opened N times in
  // the last 15 min". It must never throw into the beacon.
  const onView = typeof o.onView === 'function' ? o.onView : null;
  const appDoc = (app) => db.collection('views').doc(app);

  // --- write path ----------------------------------------------------------
  async function record(app, path, ref, vid) {
    const day = isoDay(Date.now());
    const dailyRef = appDoc(app).collection('daily').doc(day);

    // A visitor is "unique for today" the first time their id is written under
    // today's date. create() fails if it already exists, which is the cheapest
    // available test-and-set — no read needed on the common repeat-view path.
    let isNewToday = false;
    try {
      await dailyRef.collection('visitors').doc(vid).create({ at: new Date().toISOString() });
      isNewToday = true;
    } catch (e) {
      if (!e || e.code !== 6) throw e; // 6 = ALREADY_EXISTS, the expected case
    }

    const writes = [
      appDoc(app).set({
        app,
        label: APPS[app].label,
        totalViews: FieldValue.increment(1),
        totalUniques: FieldValue.increment(isNewToday ? 1 : 0),
        lastSeenAt: new Date().toISOString(),
      }, { merge: true }),
      dailyRef.set({
        date: day,
        views: FieldValue.increment(1),
        uniques: FieldValue.increment(isNewToday ? 1 : 0),
      }, { merge: true }),
      appDoc(app).collection('paths').doc(pathKey(path)).set({
        path: String(path || '/').slice(0, 120),
        views: FieldValue.increment(1),
      }, { merge: true }),
    ];

    const host = referrerHost(ref);
    // Self-referrals are noise — every in-app navigation would otherwise show
    // the app as its own top traffic source.
    if (host && !host.endsWith('strongtechnicalconsulting.com')) {
      writes.push(appDoc(app).collection('refs').doc(pathKey(host)).set({
        host, hits: FieldValue.increment(1),
      }, { merge: true }));
    }

    await Promise.all(writes);
    return { isNewToday };
  }

  // --- read path -----------------------------------------------------------
  async function seriesFor(app, days) {
    const wanted = dayList(days);
    const snap = await appDoc(app).collection('daily')
      .where('date', '>=', wanted[0]).get();
    const byDay = new Map();
    snap.docs.forEach((d) => byDay.set(d.id, d.data()));
    return wanted.map((date) => {
      const d = byDay.get(date) || {};
      return { date, views: d.views || 0, uniques: d.uniques || 0 };
    });
  }

  /** Today's (UTC) views and uniques per app, from the daily documents the
   *  beacon already writes. One batched read. For the home page's activity
   *  feed, which shows only counts of two or more. */
  async function today() {
    const day = isoDay(Date.now());
    const names = Object.keys(APPS);
    const snaps = await db.getAll(...names.map((a) => appDoc(a).collection('daily').doc(day)));
    const apps = {};
    names.forEach((a, i) => {
      const d = snaps[i] && snaps[i].exists ? (snaps[i].data() || {}) : {};
      apps[a] = { views: d.views || 0, uniques: d.uniques || 0 };
    });
    return { day, apps };
  }

  function summarize(series) {
    const n = series.length;
    const sum = (from, to) => series.slice(from, to).reduce((a, b) => a + b.views, 0);
    const last7 = sum(n - 7, n);
    const prev7 = sum(n - 14, n - 7);
    return {
      views7: last7,
      views7Prev: prev7,
      views30: sum(Math.max(0, n - 30), n),
      // No previous window means no comparison to make. null renders as "new",
      // which is honest; 0 or Infinity would both be lies.
      trendPct: prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 100) : null,
    };
  }

  async function overview(days) {
    const names = Object.keys(APPS);
    const totals = await db.getAll(...names.map((a) => appDoc(a)));
    const rows = await Promise.all(names.map(async (app, i) => {
      const series = await seriesFor(app, days);
      const t = totals[i].exists ? totals[i].data() : {};
      // Ranked on the newest week, with trendPct carrying the direction. No
      // decay term here: unlike a prompt, an app does not age out of the list -
      // there are five of them and all five always belong on the chart.
      const s = summarize(series);
      return {
        app,
        label: APPS[app].label,
        icon: APPS[app].icon,
        url: APPS[app].url,
        totalViews: t.totalViews || 0,
        totalUniques: t.totalUniques || 0,
        lastSeenAt: t.lastSeenAt || null,
        series,
        ...s,
      };
    }));
    rows.sort((a, b) => b.views7 - a.views7 || b.totalViews - a.totalViews);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  function mount(app) {
    // The beacon is called from other origins, so it needs CORS — and
    // credentials:'include' on the caller's side means the allowed origin must
    // be echoed exactly, never '*'.
    const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?strongtechnicalconsulting\.com$/;
    function cors(req, res, next) {
      const origin = req.get('Origin');
      if (origin && ALLOWED_ORIGIN.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') return res.status(204).end();
      return next();
    }

    app.options('/api/beacon', cors, (req, res) => res.status(204).end());
    app.post('/api/beacon', cors, async (req, res) => {
      // Always 204, whatever happened. A beacon that reports errors teaches a
      // caller how to probe the allowlist, and a page must never be slowed or
      // broken by its own analytics failing.
      try {
        // Refused before the visitor cookie is set: a request that is not a
        // view should not mint a visitor either.
        const verdict = beaconVerdict(req.body, req.get('User-Agent'));
        if (!verdict.count) return res.status(204).end();
        const name = verdict.app;

        let vid = parseCookies(req)[VISITOR_COOKIE];
        if (!vid || !/^[a-f0-9]{24}$/.test(vid)) {
          vid = crypto.randomBytes(12).toString('hex');
          setVisitorCookie(res, vid);
        }
        if (rateLimited(vid)) return res.status(204).end();

        await record(name, (req.body && req.body.path) || '/', (req.body && req.body.ref) || '', vid);
        if (onView) { try { onView(name); } catch (e) { /* the count is what matters */ } }
        return res.status(204).end();
      } catch (err) {
        console.error('POST /api/beacon', err);
        return res.status(204).end();
      }
    });

    // Public because the landing page consumes it to rank its own cards, and
    // because view counts on Erik's own hobby projects are not a secret. It
    // returns counts and shape only — no visitor ids, no referrers, no paths.
    // If that ever stops feeling right, this is the one route to gate.
    app.get('/api/stats/public', cors, async (req, res) => {
      try {
        const rows = await overview(PUBLIC_SERIES_DAYS);
        res.set('Cache-Control', 'public, max-age=300');
        res.json({
          days: PUBLIC_SERIES_DAYS,
          apps: rows.map((r) => ({
            app: r.app, label: r.label, icon: r.icon, url: r.url, rank: r.rank,
            totalViews: r.totalViews, views7: r.views7, views30: r.views30,
            trendPct: r.trendPct,
            spark: r.series.map((d) => d.views),
          })),
        });
      } catch (err) {
        console.error('GET /api/stats/public', err);
        res.status(500).json({ error: 'Could not load stats.' });
      }
    });

    // The full picture: uniques, per-path and referrer breakdowns, 90 days.
    // requireAdmin 404s for everyone else, same as the other apps.
    app.get('/api/admin/stats', requireLogin, requireAdmin, async (req, res) => {
      try {
        const rows = await overview(SERIES_DAYS);
        const detail = await Promise.all(rows.map(async (r) => {
          const [paths, refs] = await Promise.all([
            appDoc(r.app).collection('paths').orderBy('views', 'desc').limit(10).get(),
            appDoc(r.app).collection('refs').orderBy('hits', 'desc').limit(10).get(),
          ]);
          return {
            ...r,
            topPaths: paths.docs.map((d) => d.data()),
            topRefs: refs.docs.map((d) => d.data()),
          };
        }));
        res.json({ days: SERIES_DAYS, apps: detail });
      } catch (err) {
        console.error('GET /api/admin/stats', err);
        res.status(500).json({ error: 'Could not load stats.' });
      }
    });
  }

  return { mount, overview, today, trendScore, APPS };
}

module.exports = { createViews, trendScore, beaconVerdict, APPS, defaultDb };
