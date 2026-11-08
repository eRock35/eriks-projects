// Lab Pulse (2026-11-08): challenge.strongtechnicalconsulting.com/pulse.
//
// One read-only page for how the lab and the five iPhone apps are doing. No
// model call, no sign-in, nothing stored. Two sources:
//
//  - pulse.json, written every three hours by .github/workflows/pulse.yml
//    (mobile/scripts/pulse.py) to this repo's `pulse-data` branch: the
//    iPhone builds, TestFlight and CI. It comes from a git branch, so it is
//    UNTRUSTED here: fetched inside the request (billed per request: no
//    timer), at most MAX_BYTES, TIMEOUT_MS, then validated field by field -
//    known keys only, enums, bounded patterns, github.com Actions URLs only.
//    A bad field is dropped and the rest kept; a document with no readable
//    schema or date is treated as missing. Cached in memory for TTL_MS.
//  - what this server knows itself at request time: lab.js (every drop),
//    which apps actually mounted in this instance, build-stats.json.
//
// The page never shows a per-app test result: CI (ci.yml) runs the landing's
// suites, not the lab's, so the one CI line is the repo's, and says so.

const PULSE_URL = 'https://raw.githubusercontent.com/eRock35/eriks-projects/pulse-data/pulse.json';
const TTL_MS = 5 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;
const TIMEOUT_MS = 3000;
const MAX_BYTES = 256 * 1024;
const STALE_MINUTES = 9 * 60; // three missed three-hourly runs

// The iPhone apps, in ios.yml's order. Names and bundle IDs come from here,
// never from the data: a row whose bundle ID does not match is dropped.
const IPHONE_APPS = [
  { slug: 'trip', name: 'Trip Planner' },
  { slug: 'hopscotch', name: 'Hopscotch' },
  { slug: 'flight', name: 'Flight' },
  { slug: 'insidejoke', name: 'Inside Joke' },
  { slug: 'football', name: 'Football' },
].map((a) => ({ ...a, bundleId: `com.strongtechnicalconsulting.${a.slug}` }));

const LINKS = {
  workflow: 'https://github.com/eRock35/eriks-projects/actions/workflows/ios.yml',
  developer: 'https://developer.apple.com/account',
  testflight: 'https://appstoreconnect.apple.com/',
};
const AGREEMENT_TEXT = "Accept the updated Apple Developer Program License Agreement at developer.apple.com (Account Holder), then re-run 'iPhone apps to TestFlight'.";

/* ---------------- validation: every field, strictly ---------------- */

const CONCLUSIONS = ['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'stale', 'startup_failure', 'in_progress', 'unknown'];
const EVENTS = ['schedule', 'workflow_dispatch', 'push', 'pull_request', 'workflow_run', 'unknown'];
const FAILURES = ['agreement', 'auth', 'certificate-limit', 'secrets', 'other'];
const ASC_REASONS = ['agreement', 'auth', 'error', 'unset'];
const PROCESSING = ['PROCESSING', 'FAILED', 'INVALID', 'VALID', 'UNKNOWN'];
const EXTERNAL = ['PROCESSING', 'PROCESSING_EXCEPTION', 'MISSING_EXPORT_COMPLIANCE', 'READY_FOR_BETA_TESTING', 'IN_BETA_TESTING', 'EXPIRED', 'READY_FOR_BETA_SUBMISSION', 'IN_EXPORT_COMPLIANCE_REVIEW', 'WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW', 'BETA_REJECTED', 'BETA_APPROVED', 'UNKNOWN'];
const INTERNAL = ['PROCESSING', 'PROCESSING_EXCEPTION', 'MISSING_EXPORT_COMPLIANCE', 'READY_FOR_BETA_TESTING', 'IN_BETA_TESTING', 'EXPIRED', 'IN_EXPORT_COMPLIANCE_REVIEW', 'UNKNOWN'];

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RUN_URL_RE = /^https:\/\/github\.com\/eRock35\/eriks-projects\/actions\/runs\/\d{1,20}(?:\/job\/\d{1,20})?$/;
const STEP_RE = /^[A-Za-z0-9][A-Za-z0-9 ,.'()&+/-]{0,79}$/;
const VERSION_RE = /^\d{1,3}(?:\.\d{1,3}){1,2}$/;
// Six digits at most: an App Store Connect id (ten) can never pass as one.
const BUILD_NO_RE = /^\d{1,6}(?:\.\d{1,3})?$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function makeChecker() {
  const rejected = [];
  const reject = (path) => { if (rejected.length < 200) rejected.push(path); return null; };
  // Read `keys` from `obj`; anything else on it is reported and dropped.
  const pick = (obj, keys, path) => {
    if (!isObj(obj)) return reject(path);
    for (const k of Object.keys(obj)) if (!keys.includes(k)) reject(`${path}.${k.slice(0, 40)}`);
    return obj;
  };
  const field = (obj, k, path, test) => {
    const v = own(obj, k) ? obj[k] : undefined;
    if (v === null) return null;
    if (v === undefined) return null;
    return test(v) ? v : reject(`${path}.${k}`);
  };
  return { rejected, reject, pick, field };
}

const t = {
  iso: (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v))
    && Date.parse(v) >= Date.UTC(2020, 0, 1) && Date.parse(v) <= Date.UTC(2100, 0, 1),
  int: (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi,
  oneOf: (list) => (v) => typeof v === 'string' && list.includes(v),
  bool: (v) => typeof v === 'boolean',
  re: (re, max) => (v) => typeof v === 'string' && v.length <= max && re.test(v),
  url: (v) => {
    if (typeof v !== 'string' || v.length > 120 || !RUN_URL_RE.test(v)) return false;
    try { const u = new URL(v); return u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password && !u.port; } catch { return false; }
  },
};

function vRunRef(c, r, path, extra = {}) {
  if (!c.pick(r, ['run', 'conclusion', 'at', 'url', ...Object.keys(extra)], path)) return null;
  if (!t.int(1, 1e7)(r.run)) return c.reject(`${path}.run`);
  const out = { run: r.run, at: c.field(r, 'at', path, t.iso), url: c.field(r, 'url', path, t.url) };
  if (own(r, 'conclusion')) out.conclusion = c.field(r, 'conclusion', path, t.oneOf(CONCLUSIONS)) || 'unknown';
  for (const [k, test] of Object.entries(extra)) out[k] = c.field(r, k, path, test);
  return out;
}

function vBuild(c, b, path) {
  if (!c.pick(b, ['version', 'number', 'processingState', 'uploadedAt', 'expiresAt', 'expired', 'daysToExpiry', 'external', 'internal'], path)) return null;
  return {
    version: c.field(b, 'version', path, t.re(VERSION_RE, 11)),
    number: c.field(b, 'number', path, t.re(BUILD_NO_RE, 10)),
    processingState: c.field(b, 'processingState', path, t.oneOf(PROCESSING)),
    uploadedAt: c.field(b, 'uploadedAt', path, t.iso),
    expiresAt: c.field(b, 'expiresAt', path, t.iso),
    expired: c.field(b, 'expired', path, t.bool) === true,
    external: c.field(b, 'external', path, t.oneOf(EXTERNAL)),
    internal: c.field(b, 'internal', path, t.oneOf(INTERNAL)),
  };
}

function vAsc(c, a, path, top) {
  if (!isObj(a) || typeof a.ok !== 'boolean') return c.reject(path);
  if (!a.ok) {
    c.pick(a, ['ok', 'reason'], path);
    const reason = c.field(a, 'reason', path, t.oneOf(ASC_REASONS));
    return { ok: false, reason: reason || 'error' };
  }
  if (top) { c.pick(a, ['ok'], path); return { ok: true }; }
  c.pick(a, ['ok', 'found', 'build'], path);
  const found = c.field(a, 'found', path, t.bool);
  if (found === null) return c.reject(`${path}.found`);
  return { ok: true, found, build: a.build == null ? null : vBuild(c, a.build, `${path}.build`) };
}

/** Pure: parsed pulse.json -> {doc|null, rejected: [paths]}. Never throws. */
function validate(raw) {
  const c = makeChecker();
  if (!c.pick(raw, ['schema', 'generatedAt', 'github', 'asc', 'iphone', 'ci'], 'doc')) return { doc: null, rejected: c.rejected };
  if (raw.schema !== 1) { c.reject('doc.schema'); return { doc: null, rejected: c.rejected }; }
  const generatedAt = c.field(raw, 'generatedAt', 'doc', t.iso);
  if (!generatedAt) return { doc: null, rejected: c.rejected.concat('doc.generatedAt') };

  const doc = { generatedAt, github: null, asc: null, iphone: { lastRun: null, apps: [] }, ci: null };
  if (c.pick(raw.github, ['ok'], 'github')) doc.github = { ok: c.field(raw.github, 'ok', 'github', t.bool) === true };
  doc.asc = raw.asc === undefined ? null : vAsc(c, raw.asc, 'asc', true);

  const ip = c.pick(raw.iphone, ['lastRun', 'nextScheduled', 'apps'], 'iphone');
  if (ip) {
    c.field(ip, 'nextScheduled', 'iphone', t.iso); // checked; the host works out its own
    if (ip.lastRun != null && c.pick(ip.lastRun, ['number', 'event', 'conclusion', 'at', 'url', 'checkOnly'], 'iphone.lastRun')) {
      const lr = ip.lastRun;
      const number = c.field(lr, 'number', 'iphone.lastRun', t.int(1, 1e7));
      if (number !== null) {
        doc.iphone.lastRun = {
          number,
          event: c.field(lr, 'event', 'iphone.lastRun', t.oneOf(EVENTS)) || 'unknown',
          conclusion: c.field(lr, 'conclusion', 'iphone.lastRun', t.oneOf(CONCLUSIONS)) || 'unknown',
          at: c.field(lr, 'at', 'iphone.lastRun', t.iso),
          url: c.field(lr, 'url', 'iphone.lastRun', t.url),
          checkOnly: c.field(lr, 'checkOnly', 'iphone.lastRun', t.bool) === true,
        };
      }
    }
    const list = Array.isArray(ip.apps) ? ip.apps.slice(0, 10) : (c.reject('iphone.apps') || []);
    const seen = new Set();
    list.forEach((a, i) => {
      const path = `iphone.apps[${i}]`;
      if (!c.pick(a, ['slug', 'bundleId', 'latest', 'lastUpload', 'asc', 'expiresBeforeNextBuild'], path)) return;
      const known = IPHONE_APPS.find((x) => x.slug === a.slug);
      if (!known || seen.has(known.slug) || a.bundleId !== known.bundleId) { c.reject(`${path}.slug`); return; }
      seen.add(known.slug);
      doc.iphone.apps.push({
        slug: known.slug,
        latest: a.latest == null ? null : vRunRef(c, a.latest, `${path}.latest`, {
          failedStep: t.re(STEP_RE, 80), failure: t.oneOf(FAILURES), stoppedInPlan: t.bool,
        }),
        lastUpload: a.lastUpload == null ? null : vRunRef(c, a.lastUpload, `${path}.lastUpload`),
        asc: a.asc === undefined ? null : vAsc(c, a.asc, `${path}.asc`, false),
      });
    });
  }

  if (raw.ci != null && c.pick(raw.ci, ['workflow', 'branch', 'run', 'conclusion', 'at', 'url', 'jobs'], 'ci')) {
    const ci = raw.ci;
    const run = c.field(ci, 'run', 'ci', t.int(1, 1e7));
    if (ci.workflow === 'ci.yml' && ci.branch === 'main' && run !== null) {
      const jobs = Array.isArray(ci.jobs) ? ci.jobs.slice(0, 20) : [];
      doc.ci = {
        run,
        conclusion: c.field(ci, 'conclusion', 'ci', t.oneOf(CONCLUSIONS)) || 'unknown',
        at: c.field(ci, 'at', 'ci', t.iso),
        url: c.field(ci, 'url', 'ci', t.url),
        jobs: jobs.map((j, i) => {
          const path = `ci.jobs[${i}]`;
          if (!c.pick(j, ['name', 'conclusion', 'failedStep'], path)) return null;
          const name = c.field(j, 'name', path, t.re(STEP_RE, 80));
          if (!name) return c.reject(`${path}.name`);
          return { name, conclusion: c.field(j, 'conclusion', path, t.oneOf(CONCLUSIONS)) || 'unknown', failedStep: c.field(j, 'failedStep', path, t.re(STEP_RE, 80)) };
        }).filter(Boolean),
      };
    } else c.reject('ci');
  }
  return { doc, rejected: c.rejected };
}

/* ---------------- the source: fetched in the request, cached ---------------- */

async function readCapped(res, max) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) return null;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return Buffer.byteLength(text) > max ? null : text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { await reader.cancel(); } catch { /* gone */ } return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The pulse.json source. `fetch` and `now` are injectable for tests. */
function source({ fetch, url = PULSE_URL, ttlMs = TTL_MS, failTtlMs = FAIL_TTL_MS, timeoutMs = TIMEOUT_MS, now = () => Date.now() } = {}) {
  let cache = null;
  let inflight = null;
  let lastGood = null;
  let fetches = 0;

  async function load() {
    fetches++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'error', headers: { Accept: 'application/json' } });
      if (res.status === 404) return { status: 'missing' };
      if (!res.ok) return { status: 'unreachable' };
      const text = await readCapped(res, MAX_BYTES);
      if (text === null) return { status: 'invalid' };
      let raw;
      try { raw = JSON.parse(text); } catch { return { status: 'invalid' }; }
      const { doc, rejected } = validate(raw);
      if (!doc) return { status: 'invalid', rejected: rejected.length };
      return { status: 'ok', doc, rejected: rejected.length };
    } catch {
      return { status: ctrl.signal.aborted ? 'timeout' : 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async get() {
      if (cache && now() < cache.until) return cache.value;
      if (!inflight) {
        inflight = load().then((value) => {
          if (value.status === 'ok') lastGood = value;
          // A failed refresh keeps showing the last good file (its date
          // says how old it is) rather than blanking the page.
          const shown = value.status === 'ok' || !lastGood ? value : { ...lastGood, refreshFailed: value.status };
          cache = { until: now() + (value.status === 'ok' ? ttlMs : failTtlMs), value: shown };
          return shown;
        }).finally(() => { inflight = null; });
      }
      return inflight;
    },
    clear() { cache = null; lastGood = null; },
    get fetches() { return fetches; },
  };
}

/* ---------------- the view: what the page draws ---------------- */

/** ios.yml's schedule, '23 9 1 * *': the next 1st of a month at 09:23 UTC. */
function nextScheduledBuild(now) {
  const d = new Date(now);
  let next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 9, 23));
  if (next <= d) next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 9, 23));
  return next;
}

const day = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayYear = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function daysLeft(expiresAt, now) {
  return Math.floor((Date.parse(expiresAt) - now) / 864e5);
}
function expiryWords(n) {
  if (n < 0) return null;
  if (n === 0) return 'expires today';
  return `expires in ${n} day${n === 1 ? '' : 's'}`;
}

const BETA_WORDS = {
  IN_BETA_TESTING: ['In beta testing', 'ok'],
  BETA_APPROVED: ['Approved for beta testing', 'ok'],
  READY_FOR_BETA_TESTING: ['Ready for beta testing', 'ok'],
  WAITING_FOR_BETA_REVIEW: ['Waiting for beta review', 'warn'],
  IN_BETA_REVIEW: ['In beta review', 'warn'],
  READY_FOR_BETA_SUBMISSION: ['Internal testing only, not sent for beta review', 'warn'],
  MISSING_EXPORT_COMPLIANCE: ['Waiting on export compliance', 'warn'],
  IN_EXPORT_COMPLIANCE_REVIEW: ['In export compliance review', 'warn'],
  PROCESSING: ['Processing', 'warn'],
  PROCESSING_EXCEPTION: ['Processing failed at Apple', 'bad'],
  BETA_REJECTED: ['Rejected in beta review', 'bad'],
  EXPIRED: ['Expired', 'bad'],
};
const ASC_WORDS = {
  agreement: 'App Store Connect: agreement not accepted',
  auth: 'App Store Connect refused the key',
  unset: 'App Store Connect not checked',
  error: 'App Store Connect did not answer',
};

/** Pure: one app's TestFlight state in words, and a tone for its colour. */
function testflightWords(asc, now) {
  if (!asc) return { text: 'No TestFlight data', tone: 'muted' };
  if (!asc.ok) return { text: ASC_WORDS[asc.reason] || ASC_WORDS.error, tone: asc.reason === 'unset' ? 'muted' : 'bad' };
  if (!asc.found) return { text: 'Not in App Store Connect yet', tone: 'muted' };
  const b = asc.build;
  if (!b) return { text: 'No build uploaded yet', tone: 'muted' };
  if (b.processingState === 'PROCESSING') return { text: 'Processing', tone: 'warn' };
  if (b.processingState === 'FAILED' || b.processingState === 'INVALID') return { text: 'Apple rejected the upload', tone: 'bad' };
  const left = b.expiresAt ? daysLeft(b.expiresAt, now) : null;
  if (b.expired || b.external === 'EXPIRED' || (left !== null && left < 0)) {
    return { text: b.expiresAt ? `Expired ${dayYear(b.expiresAt)}` : 'Expired', tone: 'bad' };
  }
  const [words, tone] = BETA_WORDS[b.external] || ['Uploaded', 'muted'];
  const exp = left !== null ? expiryWords(left) : null;
  return { text: exp ? `${words} · ${exp}` : words, tone: tone === 'ok' && left !== null && left <= 14 ? 'warn' : tone };
}

function result(conclusion) {
  if (conclusion === 'success') return 'ok';
  if (conclusion === 'in_progress') return 'running';
  if (['failure', 'timed_out', 'startup_failure'].includes(conclusion)) return 'bad';
  return 'other';
}

const FAILURE_WORDS = {
  agreement: 'Apple agreement not accepted',
  auth: 'App Store Connect refused the key',
  'certificate-limit': 'Apple certificate limit reached',
  secrets: 'a secret is missing',
  other: null,
};

/** Pure: the validated data + what this host knows -> the page's JSON. */
function view({ got, apps, mounted, buildStats, now }) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const doc = got && got.status === 'ok' ? got.doc : null;
  const next = nextScheduledBuild(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const ageMinutes = doc ? Math.max(0, Math.round((at - Date.parse(doc.generatedAt)) / 6e4)) : null;
  const ascOk = !!(doc && doc.asc && doc.asc.ok);

  const rows = IPHONE_APPS.map((a) => {
    const d = doc ? doc.iphone.apps.find((x) => x.slug === a.slug) : null;
    const latest = d && d.latest ? {
      result: result(d.latest.conclusion),
      run: d.latest.run, at: d.latest.at, url: d.latest.url,
      failedStep: d.latest.failedStep || null,
      why: (d.latest.failure && FAILURE_WORDS[d.latest.failure]) || null,
      stoppedInPlan: d.latest.stoppedInPlan === true,
    } : null;
    const asc = d ? d.asc : null;
    const b = asc && asc.ok && asc.build ? asc.build : null;
    const expiresAt = b && b.expiresAt ? b.expiresAt : null;
    return {
      slug: a.slug, name: a.name,
      latest,
      build: b ? { version: b.version, number: b.number, uploadedAt: b.uploadedAt } : null,
      testflight: doc ? testflightWords(asc, at) : { text: 'Unknown right now', tone: 'muted' },
      expiresAt,
      expiresBeforeNextBuild: !!(expiresAt && Date.parse(expiresAt) < Date.parse(next)),
      lastUpload: d && d.lastUpload ? { run: d.lastUpload.run, at: d.lastUpload.at, url: d.lastUpload.url } : null,
      agreement: !!((asc && asc.ok === false && asc.reason === 'agreement') || (d && d.latest && d.latest.failure === 'agreement')),
    };
  });

  const banners = [];
  if ((doc && doc.asc && doc.asc.ok === false && doc.asc.reason === 'agreement') || rows.some((r) => r.agreement)) {
    banners.push({ kind: 'agreement', text: AGREEMENT_TEXT, links: [{ text: 'developer.apple.com', href: LINKS.developer }, { text: 'iPhone apps to TestFlight', href: LINKS.workflow }] });
  }
  const listOf = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);
  const gone = rows.filter((r) => r.expiresAt && Date.parse(r.expiresAt) <= at);
  const soon = rows.filter((r) => r.expiresBeforeNextBuild && Date.parse(r.expiresAt) > at);
  if (gone.length || soon.length) {
    const said = [];
    if (gone.length) said.push(`The newest TestFlight build of ${listOf(gone.map((r) => r.name))} has expired.`);
    if (soon.length) {
      const first = soon.map((r) => r.expiresAt).sort()[0];
      said.push(`The newest TestFlight build of ${listOf(soon.map((r) => r.name))} expires on ${day(first)}, before the next scheduled build on ${day(next)}.`);
    }
    said.push(`Run 'iPhone apps to TestFlight' ${soon.length && !gone.length ? 'before then' : 'to send a new one'}.`);
    banners.push({ kind: 'expiry', text: said.join(' '), links: [{ text: 'iPhone apps to TestFlight', href: LINKS.workflow }] });
  }

  const stats = (buildStats && buildStats.apps) || {};
  const live = new Set(mounted);
  const labApps = apps.map((a, i) => {
    const b = stats[a.slug];
    const home = a.status === 'graduated' && typeof a.home === 'string' && /^https:\/\/[a-z0-9-]+\.strongtechnicalconsulting\.com\/?$/.test(a.home) ? a.home : null;
    return {
      drop: i + 1, slug: a.slug, name: a.name, emoji: a.emoji, dropped: a.dropped, status: a.status,
      color: HEX_RE.test(a.color || '') ? a.color : null, color2: HEX_RE.test(a.color2 || '') ? a.color2 : null,
      mounted: live.has(a.slug),
      href: a.status === 'testing' && live.has(a.slug) ? `/${a.slug}/` : home,
      build: b ? { in: b.in, out: b.out, agents: b.agents, agentMs: b.agentMs, exact: b.exact === true } : null,
    };
  });

  const ci = doc && doc.ci ? { result: result(doc.ci.conclusion), conclusion: doc.ci.conclusion, run: doc.ci.run, at: doc.ci.at, url: doc.ci.url, jobs: doc.ci.jobs } : null;

  return {
    servedAt: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: {
      ok: !!doc,
      status: got ? got.status : 'missing',
      refreshFailed: got && got.refreshFailed ? got.refreshFailed : null,
      generatedAt: doc ? doc.generatedAt : null,
      ageMinutes,
      stale: ageMinutes !== null && ageMinutes > STALE_MINUTES,
      github: doc && doc.github ? doc.github.ok : null,
      appStoreConnect: doc ? (ascOk ? 'ok' : (doc.asc && doc.asc.reason) || 'error') : null,
      rejected: got && got.rejected ? got.rejected : 0,
    },
    banners,
    iphone: {
      nextScheduled: next,
      lastRun: doc && doc.iphone.lastRun ? { ...doc.iphone.lastRun, result: result(doc.iphone.lastRun.conclusion) } : null,
      apps: rows.map(({ agreement, ...r }) => r),
      links: LINKS,
    },
    ci,
    lab: {
      apps: labApps,
      counts: {
        total: labApps.length,
        testing: labApps.filter((a) => a.status === 'testing').length,
        mounted: labApps.filter((a) => a.mounted).length,
        graduated: labApps.filter((a) => a.status === 'graduated').length,
        retired: labApps.filter((a) => a.status === 'retired').length,
      },
      buildTotals: buildStats ? { in: buildStats.totals.in, out: buildStats.totals.out, agents: buildStats.totals.agents, agentMs: buildStats.totals.agentMs, estimated: buildStats.totals.estimated } : null,
    },
  };
}

module.exports = { PULSE_URL, TTL_MS, TIMEOUT_MS, MAX_BYTES, IPHONE_APPS, AGREEMENT_TEXT, LINKS, validate, source, view, testflightWords, nextScheduledBuild };
