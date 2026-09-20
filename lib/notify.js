// Email Erik when something needs him.
//
// WHY THIS IS A SCHEDULED JOB AND NOT AN INLINE SEND
//
// The obvious thing is to send from wherever the event happens - a line in
// identity's register handler, another in trip-planner's ai-access route.
// That would mean mounting RESEND_API_KEY on all five services, and it would
// put a third-party HTTP call in the middle of a user's sign-up: if Resend is
// slow, registration is slow, and if Resend is down, a failed send has to be
// swallowed somewhere it can be forgotten.
//
// Instead one job on this service reads what already happened - identity's
// audit log and each app's own records - and sends one message. The key lives
// in one place, nothing user-facing waits on mail, and a send that fails is
// retried on the next tick because the watermark only advances on success.
//
// WHAT COUNTS AS "NEEDS HIM"
//
// Only things a person is waiting on, or would want to know within the hour:
// a new account, an AI-access request, a password-reset request, and a burst
// of failed sign-ins. Not his own admin actions - he just did those - and not
// ordinary sign-ins, which would make the mail worthless within a week.
//
// Martin Quarles waited over an hour for an AI approval on 2026-09-20 because
// nothing told anyone the request existed. That is the case this exists for.

const { Firestore } = require('@google-cloud/firestore');
const email = require('./email');

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'metal-celerity-236019';
const IDENTITY_DB = process.env.IDENTITY_DATABASE_ID || 'identity';
const CONTROL = 'control';
const WATERMARK = 'notify';

// A burst worth hearing about. One or two is someone mistyping; this many
// against one address between ticks is worth a look.
const FAILED_SIGNIN_ALERT = 5;

// Events from identity's audit log that are worth a message on their own.
const NOTABLE = {
  register: 'New account',
  'password.admin-reset': 'Admin issued a temporary password',
};

const clients = new Map();
function dbFor(id) {
  if (!clients.has(id)) clients.set(id, new Firestore({ projectId: PROJECT, databaseId: id }));
  return clients.get(id);
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function watermark() {
  try {
    const doc = await dbFor(IDENTITY_DB).collection(CONTROL).doc(WATERMARK).get();
    return doc.exists ? doc.data() : {};
  } catch (e) {
    return {};
  }
}

/**
 * Everything new since the last successful send.
 *
 * Two shapes of thing, handled differently:
 *   - EVENTS already happened, so a timestamp watermark is enough.
 *   - PENDING STATES (an unanswered request) persist until acted on, so a
 *     timestamp would re-send them every tick forever. Those are keyed
 *     individually by the timestamp of the request we already reported, so a
 *     second request from the same person does notify again.
 */
async function gather() {
  const mark = await watermark();
  const since = mark.lastEventAt || new Date(Date.now() - 86400000).toISOString();
  const notified = mark.notified && typeof mark.notified === 'object' ? mark.notified : {};

  const out = { signups: [], requests: [], resets: [], failures: [], since, notified: { ...notified } };
  let newestEvent = since;

  // --- identity's audit log -------------------------------------------
  try {
    const snap = await dbFor(IDENTITY_DB).collection('events')
      .where('at', '>', since).orderBy('at', 'asc').limit(500).get();
    const failedBy = {};
    snap.docs.forEach((d) => {
      const e = d.data();
      if (e.at > newestEvent) newestEvent = e.at;
      if (NOTABLE[e.kind]) out.signups.push({ kind: NOTABLE[e.kind], email: e.email, app: e.app, at: e.at });
      if (e.kind === 'login.failed') failedBy[e.email || 'unknown'] = (failedBy[e.email || 'unknown'] || 0) + 1;
    });
    Object.entries(failedBy)
      .filter(([, n]) => n >= FAILED_SIGNIN_ALERT)
      .forEach(([addr, n]) => out.failures.push({ email: addr, count: n }));
  } catch (e) { /* a missing collection is "nothing yet", not an error */ }

  // --- asks made through the shared account (friction, dataviz, ...) ----
  try {
    const snap = await dbFor(IDENTITY_DB).collection('users').limit(500).get();
    snap.docs.forEach((d) => {
      const u = d.data();
      const reqs = u.requests && typeof u.requests === 'object' ? u.requests : {};
      Object.entries(reqs).forEach(([appKey, r]) => {
        if (!r || r.state === 'denied' || !r.at) return;
        // Already granted? Then the ask is stale and not worth a mention.
        if (u.access && u.access[appKey]) return;
        const key = `req:${d.id}:${appKey}`;
        if (notified[key] === r.at) return;
        out.requests.push({ email: u.email, at: r.at, note: r.note || '', uid: d.id, app: appKey });
        out.notified[key] = r.at;
      });
    });
  } catch (e) { /* nothing yet */ }

  // --- trip-planner's own workflows ------------------------------------
  try {
    const snap = await dbFor('trip-planner').collection('users').limit(500).get();
    snap.docs.forEach((d) => {
      const u = d.data();
      if (u.aiAccess === 'pending' && u.aiRequestedAt && notified['ai:' + d.id] !== u.aiRequestedAt) {
        out.requests.push({ email: u.email, at: u.aiRequestedAt, note: u.aiNote || '', uid: d.id });
        out.notified['ai:' + d.id] = u.aiRequestedAt;
      }
      if (u.resetRequestedAt && notified['reset:' + d.id] !== u.resetRequestedAt) {
        out.resets.push({ email: u.email, at: u.resetRequestedAt, uid: d.id });
        out.notified['reset:' + d.id] = u.resetRequestedAt;
      }
    });
  } catch (e) { /* same */ }

  out.lastEventAt = newestEvent;
  out.count = out.signups.length + out.requests.length + out.resets.length + out.failures.length;
  return out;
}

function compose(found, origin) {
  // /admin IS the overview now; /admin/insights only 301s there.
  const dash = `${origin}/admin`;
  const lines = [];
  const html = [];

  const section = (title, items, render) => {
    if (!items.length) return;
    lines.push('', title.toUpperCase());
    html.push(`<h3 style="font:600 15px -apple-system,sans-serif;margin:18px 0 6px">${esc(title)}</h3><ul style="margin:0;padding-left:18px">`);
    items.forEach((i) => {
      const t = render(i);
      lines.push('  - ' + t.text);
      html.push(`<li style="font:14px/1.5 -apple-system,sans-serif;margin:3px 0">${t.html}</li>`);
    });
    html.push('</ul>');
  };

  const asked = (r) => r.app ? `access to ${r.app}` : 'AI access on Trip Planner';
  section('Waiting on you', found.requests, (r) => ({
    text: `${r.email} asked for ${asked(r)} (${String(r.at).slice(0, 16).replace('T', ' ')})${r.note ? ` — "${r.note}"` : ''}`,
    html: `<b>${esc(r.email)}</b> asked for ${esc(asked(r))}${r.note ? ` — <i>${esc(r.note)}</i>` : ''}`,
  }));
  section('Password resets requested', found.resets, (r) => ({
    text: `${r.email} (${String(r.at).slice(0, 16).replace('T', ' ')})`,
    html: `<b>${esc(r.email)}</b> asked for a password reset`,
  }));
  section('New accounts', found.signups, (s) => ({
    text: `${s.email || '(unknown)'} — ${s.kind} via ${s.app}`,
    html: `<b>${esc(s.email || '(unknown)')}</b> — ${esc(s.kind)} via ${esc(s.app)}`,
  }));
  section('Failed sign-ins', found.failures, (f) => ({
    text: `${f.email}: ${f.count} failed attempts`,
    html: `<b>${esc(f.email)}</b>: ${f.count} failed attempts`,
  }));

  // The subject should say what it is without being opened.
  const bits = [];
  if (found.requests.length) bits.push(`${found.requests.length} waiting`);
  if (found.signups.length) bits.push(`${found.signups.length} new`);
  if (found.resets.length) bits.push(`${found.resets.length} reset`);
  if (found.failures.length) bits.push('failed sign-ins');
  const subject = `Apps: ${bits.join(', ')}`;

  return {
    subject,
    text: `${lines.join('\n').trim()}\n\nDashboard: ${dash}\n`,
    html: `<div style="max-width:32em">${html.join('')}` +
      `<p style="font:14px -apple-system,sans-serif;margin:20px 0 0"><a href="${esc(dash)}">Open the dashboard</a></p></div>`,
  };
}

/**
 * @param origin  this site's public origin, for the dashboard link
 * @param to      where to send; defaults to ADMIN_EMAIL
 */
async function run({ origin, to } = {}) {
  const target = to || process.env.ADMIN_EMAIL || '';
  const found = await gather();

  if (!found.count) {
    // Nothing to say. Still move the event watermark so a quiet hour does not
    // make the next tick re-read the same events.
    await dbFor(IDENTITY_DB).collection(CONTROL).doc(WATERMARK).set(
      { lastEventAt: found.lastEventAt, lastRunAt: new Date().toISOString() }, { merge: true },
    );
    return { sent: false, reason: 'nothing new', ...counts(found) };
  }
  if (!email.enabled() || !target) {
    return { sent: false, reason: email.enabled() ? 'no ADMIN_EMAIL set' : 'Resend is not configured', ...counts(found) };
  }

  const mail = compose(found, origin || process.env.SITE_ORIGIN || 'https://strongtechnicalconsulting.com');
  await email.sendOne({ to: target, subject: mail.subject, html: mail.html, text: mail.text });

  // Only now. If the send throws, the watermark stays put and the next tick
  // reports the same things rather than losing them.
  await dbFor(IDENTITY_DB).collection(CONTROL).doc(WATERMARK).set({
    lastEventAt: found.lastEventAt,
    notified: found.notified,
    lastRunAt: new Date().toISOString(),
    lastSubject: mail.subject,
  }, { merge: true });

  return { sent: true, to: target, subject: mail.subject, ...counts(found) };
}

function counts(f) {
  return { signups: f.signups.length, requests: f.requests.length, resets: f.resets.length, failures: f.failures.length };
}

module.exports = { run, gather, compose, FAILED_SIGNIN_ALERT };
