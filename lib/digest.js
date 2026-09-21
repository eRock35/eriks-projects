// The weekly roundup.
//
// Nothing on this domain ever tells you anything. Friction scores a new
// problem at 06:15, a trip watch finds a price drop at 03:00, and both sit
// there until someone happens to open the app. For a fleet that mostly runs
// while you are asleep, that is the whole value going unclaimed.
//
// This is deliberately NOT a per-app mailer. It runs from the landing page,
// which already holds the Resend key and already reads every app's database
// the way lib/insights.js does - so adding a mail secret to Friction, to
// trip-planner, and to whatever comes next is avoided entirely. One email,
// once a week, covering everything that moved.
//
// Cadence is checked rather than scheduled: the notify cron already runs
// every 15 minutes, so this asks "has it been a week" and usually says no.
// That means no second Cloud Scheduler job - the same reasoning that keeps
// trip-planner down to one.

const { Firestore } = require('@google-cloud/firestore');

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'metal-celerity-236019';
const IDENTITY_DB = process.env.IDENTITY_DATABASE_ID || 'identity';
const CONTROL = 'control';
const DOC = 'weekly-digest';
const EVERY_MS = 6.5 * 24 * 3600 * 1000;   // a little under a week, so a fixed
                                           // send day does not drift later.
const WINDOW_DAYS = 7;

const clients = new Map();
function dbFor(id) {
  if (!clients.has(id)) clients.set(id, new Firestore({ projectId: PROJECT, databaseId: id }));
  return clients.get(id);
}

const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

/** Problems Friction found or re-scored this week, strongest first. */
async function friction() {
  const since = ago(WINDOW_DAYS);
  const snap = await dbFor('friction').collection('signals').get();
  const rows = snap.docs.map((d) => d.data()).filter((r) => (r.status || 'new') !== 'passed');
  const fresh = rows.filter((r) => (r.firstSeenAt || '') >= since);
  const returning = rows.filter((r) => (r.firstSeenAt || '') < since && (r.lastSeenAt || '') >= since && Number(r.seenCount || 1) > 1);
  const byScore = (a, b) => (b.score || 0) - (a.score || 0);
  return {
    fresh: fresh.sort(byScore).slice(0, 6),
    returning: returning.sort(byScore).slice(0, 6),
    total: rows.length,
  };
}

/** Watches that actually reported something different this week. */
async function watches() {
  const since = ago(WINDOW_DAYS);
  const db = dbFor('trip-planner');
  const trips = await db.collection('trips').get();
  const moved = [];
  for (const t of trips.docs) {
    const trip = t.data();
    if (trip.status === 'locked') continue;      // a booked trip is not being shopped for
    const ws = await t.ref.collection('watches').get();
    for (const w of ws.docs) {
      const d = w.data();
      if (!d.lastCheckedAt || d.lastCheckedAt < since || !d.lastResult) continue;
      // Only if the answer changed - a watch that says the same thing every
      // day is not news, and reporting it every week teaches you to skim.
      const history = Array.isArray(d.history) ? d.history : [];
      const previous = history.length > 1 ? history[history.length - 2].result : null;
      if (previous && previous === d.lastResult) continue;
      moved.push({ trip: trip.name || 'Untitled trip', label: d.label, result: d.lastResult });
    }
  }
  return moved.slice(0, 8);
}

async function gather() {
  const [f, w] = await Promise.all([friction().catch(() => null), watches().catch(() => [])]);
  const count = (f ? f.fresh.length + f.returning.length : 0) + w.length;
  return { friction: f, watches: w, count };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function compose(found, origin) {
  const text = [];
  const html = [`<div style="font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1c1e;max-width:34em">`];
  html.push('<p style="margin:0 0 18px;color:#6e6e73">What moved this week.</p>');

  const f = found.friction;
  if (f && (f.fresh.length || f.returning.length)) {
    const row = (s) => `<li style="margin:0 0 10px"><b>${esc(s.title)}</b> &middot; <span style="color:#6e6e73">${esc(s.score)} &middot; seen ${esc(s.seenCount || 1)}&times;</span><br><span style="color:#6e6e73">${esc(s.summary || '')}</span></li>`;
    if (f.fresh.length) {
      text.push('NEW PROBLEMS', ...f.fresh.map((s) => `  ${s.score}  ${s.title}`));
      html.push(`<h3 style="font-size:15px;margin:0 0 8px">New this week</h3><ul style="margin:0 0 20px;padding-left:18px">${f.fresh.map(row).join('')}</ul>`);
    }
    if (f.returning.length) {
      text.push('', 'CAME BACK', ...f.returning.map((s) => `  ${s.score}  ${s.title} (seen ${s.seenCount}x)`));
      html.push(`<h3 style="font-size:15px;margin:0 0 8px">Came back</h3><ul style="margin:0 0 20px;padding-left:18px">${f.returning.map(row).join('')}</ul>`);
    }
  }

  if (found.watches.length) {
    text.push('', 'WATCHES THAT CHANGED', ...found.watches.map((w) => `  ${w.trip} - ${w.label}: ${w.result}`));
    html.push(`<h3 style="font-size:15px;margin:0 0 8px">Watches that changed</h3><ul style="margin:0 0 20px;padding-left:18px">` +
      found.watches.map((w) => `<li style="margin:0 0 10px"><b>${esc(w.label)}</b> <span style="color:#6e6e73">&middot; ${esc(w.trip)}</span><br><span style="color:#6e6e73">${esc(w.result)}</span></li>`).join('') + '</ul>');
  }

  html.push(`<p style="margin:20px 0 0"><a href="${origin}/admin" style="color:#2a78d6">Open the dashboard</a></p></div>`);
  const parts = [];
  if (f && f.fresh.length) parts.push(`${f.fresh.length} new`);
  if (f && f.returning.length) parts.push(`${f.returning.length} recurring`);
  if (found.watches.length) parts.push(`${found.watches.length} price change${found.watches.length > 1 ? 's' : ''}`);
  return { subject: `This week: ${parts.join(', ')}`, text: text.join('\n'), html: html.join('') };
}

/** Send if a week has passed and there is anything to say. */
async function runIfDue({ origin, to, force = false } = {}) {
  const ref = dbFor(IDENTITY_DB).collection(CONTROL).doc(DOC);
  const prev = (await ref.get().catch(() => null))?.data?.() || {};
  const last = prev.lastSentAt ? Date.parse(prev.lastSentAt) : 0;
  if (!force && Date.now() - last < EVERY_MS) {
    return { sent: false, reason: 'not due', nextDueAt: new Date(last + EVERY_MS).toISOString() };
  }
  const found = await gather();
  if (!found.count) {
    // Quiet week. Move the clock anyway so a dead week does not make next
    // week's digest fire the moment something appears.
    await ref.set({ lastSentAt: new Date().toISOString(), lastResult: 'nothing to report' }, { merge: true }).catch(() => {});
    return { sent: false, reason: 'nothing to report' };
  }
  return { due: true, found };
}

module.exports = { gather, compose, runIfDue, WINDOW_DAYS, EVERY_MS };
