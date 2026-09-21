// Is each app actually answering?
//
// insights.health() asks a different question - "did your scheduled work run
// recently" - by reading each app's own control document. That catches a dead
// cron but not a dead app: a service that 500s on every request still has a
// perfectly recent control doc from before it broke. And nothing emailed, so
// the answer only existed if someone opened the dashboard.
//
// This probes the public URL. It runs from Cloud Run, which can reach the
// other services (a laptop behind the egress proxy cannot), on the same
// 15-minute cron that already sends the admin digest.
//
// Two consecutive failures before it says anything. One is usually a cold
// start on a service scaled to zero, and an alert that cries wolf gets muted,
// which is worse than no alert.

const { Firestore } = require('@google-cloud/firestore');

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'metal-celerity-236019';
const IDENTITY_DB = process.env.IDENTITY_DATABASE_ID || 'identity';
const CONTROL = 'control';
const DOC = 'uptime';
const TIMEOUT_MS = 12000;
const FAILURES_BEFORE_ALERT = 2;

// Santa Rosa is deliberately not on a custom domain (see its CLAUDE.md), so
// it is probed at its run.app hostname like everything else. Using run.app
// throughout also means a DNS or mapping problem shows up as what it is
// rather than as every app being down at once.
//
// /api/health, not /healthz: Cloud Run's edge swallows the latter in
// production. Probing it reported all seven apps down while every one of
// them was serving perfectly.
const TARGETS = [
  { key: 'football',   label: 'College Football', url: 'https://college-football-app-u4h4ftn3fa-uc.a.run.app/api/health' },
  { key: 'trip',       label: 'Trip Planner',     url: 'https://trip-planner-u4h4ftn3fa-uc.a.run.app/api/health' },
  { key: 'dataviz',    label: 'DataViz',          url: 'https://dataviz-u4h4ftn3fa-uc.a.run.app/api/health' },
  { key: 'friction',   label: 'Friction',         url: 'https://friction-u4h4ftn3fa-uc.a.run.app/api/health' },
  { key: 'hopscotch',  label: 'Hopscotch',        url: 'https://hopscotch-u4h4ftn3fa-uc.a.run.app/api/health' },
  { key: 'santarosa',  label: 'Santa Rosa',       url: 'https://santa-rosa-host.invalid/api/health' },
  { key: 'landing',    label: 'Landing & blog',   url: 'https://landing-page-u4h4ftn3fa-uc.a.run.app/api/health' },
];

let db = null;
const store = () => (db || (db = new Firestore({ projectId: PROJECT, databaseId: IDENTITY_DB })));

async function probe(t) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(t.url, { signal: ctl.signal, redirect: 'manual' });
    // A redirect to /login is a healthy gated app, not a failure.
    const ok = res.ok || (res.status >= 300 && res.status < 400);
    // Keep a little of the body on failure. "HTTP 404" on its own does not say
    // whether the app is broken, the path is wrong, or something in front of
    // it answered instead - and that is exactly what you need at 2am.
    let body = '';
    if (!ok) body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160);
    return { ...t, ok, status: res.status, ms: Date.now() - started, ...(body ? { body } : {}) };
  } catch (err) {
    return { ...t, ok: false, status: 0, ms: Date.now() - started, error: String(err.name === 'AbortError' ? 'timed out' : err.message).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe everything, update the streaks, and say what changed since last tick. */
async function check() {
  const results = await Promise.all(TARGETS.map(probe));
  const ref = store().collection(CONTROL).doc(DOC);
  const prev = (await ref.get().catch(() => null))?.data?.() || {};
  const state = prev.apps || {};

  const nowDown = [];
  const recovered = [];
  const next = {};

  for (const r of results) {
    const was = state[r.key] || { fails: 0, alerted: false };
    const fails = r.ok ? 0 : was.fails + 1;
    let alerted = was.alerted;

    if (!r.ok && fails >= FAILURES_BEFORE_ALERT && !was.alerted) {
      nowDown.push(r);
      alerted = true;
    }
    if (r.ok && was.alerted) {
      recovered.push(r);
      alerted = false;
    }
    next[r.key] = { fails, alerted, lastStatus: r.status, lastMs: r.ms, lastCheckedAt: new Date().toISOString(), ...(r.error ? { lastError: r.error } : {}), ...(r.body ? { lastBody: r.body } : {}) };
  }

  await ref.set({ apps: next, lastRunAt: new Date().toISOString() }, { merge: true }).catch(() => {});
  return { results, nowDown, recovered };
}

/** The email body, when there is something to say. Null when there isn't. */
function compose({ nowDown, recovered }) {
  if (!nowDown.length && !recovered.length) return null;
  const lines = [];
  const html = [];
  if (nowDown.length) {
    lines.push('NOT ANSWERING', ...nowDown.map((r) => `  ${r.label} - ${r.error || 'HTTP ' + r.status}${r.body ? ' :: ' + r.body : ''}`));
    html.push('<h3 style="margin:0 0 6px">Not answering</h3><ul style="margin:0 0 16px;padding-left:18px">' +
      nowDown.map((r) => `<li><b>${r.label}</b> &mdash; ${r.error || 'HTTP ' + r.status}</li>`).join('') + '</ul>');
  }
  if (recovered.length) {
    lines.push('BACK UP', ...recovered.map((r) => `  ${r.label} (${r.ms}ms)`));
    html.push('<h3 style="margin:0 0 6px">Back up</h3><ul style="margin:0;padding-left:18px">' +
      recovered.map((r) => `<li><b>${r.label}</b> &mdash; answering again in ${r.ms}ms</li>`).join('') + '</ul>');
  }
  const subject = nowDown.length
    ? `${nowDown.length} app${nowDown.length > 1 ? 's are' : ' is'} not answering`
    : `${recovered.length} app${recovered.length > 1 ? 's are' : ' is'} back up`;
  return { subject, text: lines.join('\n'), html: html.join('') };
}

module.exports = { check, compose, TARGETS, FAILURES_BEFORE_ALERT };
