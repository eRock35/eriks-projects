// What the admin dashboard reads.
//
// Four questions, four sources:
//
//   Who is using this?   -> identity/users
//   What happened?       -> identity/events  (the audit log)
//   What is it costing?  -> identity/usage   (one priced row per model call)
//   Is anything broken?  -> each app's own control document
//
// The health check deliberately reads each app's OWN "when did I last do my
// job" document rather than asking Cloud Scheduler whether a job fired. A job
// that fires and then errors reports success to Scheduler; the control doc only
// moves when the work actually finished. That distinction is the whole point -
// the football board sat 15 hours stale while its scheduler jobs looked fine,
// because nothing was scheduled on a Sunday at all.
//
// Every query here is capped. This runs on a scale-to-zero service and a
// dashboard that reads an unbounded collection is a bill waiting to happen.

const { Firestore } = require('@google-cloud/firestore');

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'metal-celerity-236019';
const IDENTITY_DB = process.env.IDENTITY_DATABASE_ID || 'identity';

const MAX_EVENTS = 1000;
const MAX_USAGE = 2000;
const MAX_USERS = 500;

// Each app, the database it owns, and the document that proves it is alive.
// `stale` is how many hours without movement is worth flagging - it comes from
// the app's own cadence, so a weekly job is not reported as broken every day.
const APPS = [
  { key: 'football', label: 'College Football', db: 'college-football-app', doc: 'control/status', field: 'lastRunAt', staleHours: 26, note: 'batched research run' },
  { key: 'trip', label: 'Trip Planner', db: 'trip-planner', doc: 'control/watch-cron', field: 'lastRunAt', staleHours: 3, note: 'hourly watch sweep' },
  { key: 'friction', label: 'Friction', db: 'friction', doc: 'control/last-run', field: 'finishedAt', staleHours: 9, note: 'scan every 4h' },
  { key: 'dataviz', label: 'DataViz', db: 'dataviz', doc: null, note: 'no scheduled work' },
  { key: 'landing', label: 'Landing & blog', db: 'eriks-projects', doc: null, note: 'no scheduled work' },
];

const clients = new Map();
function dbFor(databaseId) {
  if (!clients.has(databaseId)) {
    clients.set(databaseId, new Firestore({ projectId: PROJECT, databaseId }));
  }
  return clients.get(databaseId);
}

const identity = () => dbFor(IDENTITY_DB);

const dayOf = (iso) => String(iso || '').slice(0, 10);

/** An ISO day string for each of the last n days, oldest first. */
function lastDays(n) {
  const out = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) out.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  return out;
}

async function readCollection(db, name, { limit, orderBy, since }) {
  try {
    let q = db.collection(name);
    if (since) q = q.where('at', '>=', since);
    if (orderBy) q = q.orderBy(orderBy, 'desc');
    q = q.limit(limit);
    const snap = await q.get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    // A missing collection is not an error - it is a system nobody has used
    // yet, and the dashboard should say "nothing yet" rather than 500.
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Who
 * ------------------------------------------------------------------ */

async function users() {
  const rows = await readCollection(identity(), 'users', { limit: MAX_USERS });
  const now = Date.now();
  const active7 = rows.filter((u) => u.lastSeenAt && now - Date.parse(u.lastSeenAt) < 7 * 86400000).length;
  return {
    total: rows.length,
    active7,
    // Never send a password record to a browser, even the admin's.
    list: rows
      .map((u) => ({
        email: u.email || null,
        createdAt: u.createdAt || null,
        lastSeenAt: u.lastSeenAt || null,
        createdBy: u.createdBy || null,
        disabled: Boolean(u.disabled),
      }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
    byDay: countByDay(rows.map((u) => u.createdAt), 30),
  };
}

function countByDay(timestamps, days) {
  const buckets = Object.fromEntries(lastDays(days).map((d) => [d, 0]));
  timestamps.forEach((t) => {
    const d = dayOf(t);
    if (d in buckets) buckets[d] += 1;
  });
  return Object.entries(buckets).map(([day, count]) => ({ day, count }));
}

/* ------------------------------------------------------------------ *
 * What happened
 * ------------------------------------------------------------------ */

async function activity(days = 14) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await readCollection(identity(), 'events', { limit: MAX_EVENTS, orderBy: 'at', since });
  const byKind = {};
  const byApp = {};
  rows.forEach((e) => {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    byApp[e.app] = (byApp[e.app] || 0) + 1;
  });
  return {
    total: rows.length,
    // Failed sign-ins are the row worth surfacing on its own: a handful is
    // someone fat-fingering a password, a spike is someone guessing.
    failures: rows.filter((e) => e.ok === false).length,
    byDay: countByDay(rows.map((e) => e.at), days),
    byKind: Object.entries(byKind).map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    byApp: Object.entries(byApp).map(([app, count]) => ({ app, count })).sort((a, b) => b.count - a.count),
    recent: rows.slice(0, 60).map((e) => ({
      at: e.at, app: e.app, kind: e.kind, email: e.email, ok: e.ok !== false, detail: e.detail || null,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * What it costs
 * ------------------------------------------------------------------ */

async function cost(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await readCollection(identity(), 'usage', { limit: MAX_USAGE, orderBy: 'at', since });

  const byApp = {};
  const byModel = {};
  let total = 0;
  let unpriced = 0;
  rows.forEach((u) => {
    const c = typeof u.costUsd === 'number' ? u.costUsd : null;
    if (c === null) { unpriced += 1; return; }
    total += c;
    byApp[u.app] = (byApp[u.app] || 0) + c;
    byModel[u.model] = (byModel[u.model] || 0) + c;
  });

  const byDayMap = Object.fromEntries(lastDays(days).map((d) => [d, 0]));
  rows.forEach((u) => {
    const d = dayOf(u.at);
    if (d in byDayMap && typeof u.costUsd === 'number') byDayMap[d] += u.costUsd;
  });

  return {
    days,
    total,
    calls: rows.length,
    // A model with no published price lands here instead of being counted as
    // free. A silent zero would make a new model look like it costs nothing.
    unpriced,
    byApp: Object.entries(byApp).map(([app, usd]) => ({ app, usd })).sort((a, b) => b.usd - a.usd),
    byModel: Object.entries(byModel).map(([model, usd]) => ({ model, usd })).sort((a, b) => b.usd - a.usd),
    byDay: Object.entries(byDayMap).map(([day, usd]) => ({ day, usd })),
  };
}

/* ------------------------------------------------------------------ *
 * Is anything broken
 * ------------------------------------------------------------------ */

async function health() {
  const out = [];
  for (const app of APPS) {
    if (!app.doc) {
      out.push({ key: app.key, label: app.label, state: 'none', note: app.note, lastRunAt: null, ageHours: null });
      continue;
    }
    const [collection, id] = app.doc.split('/');
    let lastRunAt = null;
    let state = 'unknown';
    try {
      const snap = await dbFor(app.db).collection(collection).doc(id).get();
      if (snap.exists) {
        const data = snap.data();
        lastRunAt = data[app.field] || data.lastRunAt || data.finishedAt || null;
      }
      if (!lastRunAt) {
        state = 'unknown';
      } else {
        const ageHours = (Date.now() - Date.parse(lastRunAt)) / 3600000;
        // Two bands, not three: late enough to look at, or late enough that
        // something is actually wrong. A single threshold would either cry
        // wolf or stay silent through a real outage.
        state = ageHours > app.staleHours * 2 ? 'critical' : ageHours > app.staleHours ? 'warning' : 'good';
      }
    } catch (err) {
      state = 'unreachable';
    }
    out.push({
      key: app.key,
      label: app.label,
      state,
      note: app.note,
      lastRunAt,
      ageHours: lastRunAt ? Math.round(((Date.now() - Date.parse(lastRunAt)) / 3600000) * 10) / 10 : null,
      staleHours: app.staleHours,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */

async function all() {
  const [u, a, c, h] = await Promise.all([users(), activity(), cost(), health()]);
  return { users: u, activity: a, cost: c, health: h, generatedAt: new Date().toISOString() };
}

module.exports = { all, users, activity, cost, health, APPS, lastDays };
