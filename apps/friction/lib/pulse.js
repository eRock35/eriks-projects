// The pulse: what the scans heard most recently, and which problems are
// getting louder.
//
// Everything in here is pure - dates in, numbers out - so the maths the board
// draws arrows and Spike badges from is tested on its own, with a fixed "now",
// rather than through a server and a clock.
//
// A SIGHTING is one distinct complaint (one source item) that a scan filed
// under a problem. `seenCount` counts scan passes that touched a problem, and
// with one lens per day each problem is looked at about once a week - so
// seenCount per week is nearly always 0 or 1 and could never show a spike.
// Items per week can: a problem that normally draws one complaint and this
// week drew seven is exactly what the Spike badge is for.
//
// Weekly counts are stored as a small rollup on the signal (`weekly`, an
// array of {week, n}), written by the scan inside its own request. An ARRAY,
// not a map keyed by week: Firestore's merge-write deep-merges maps, so a
// pruned week would never actually leave a map field. An array is replaced
// whole, which is what pruning needs.

const WEEK_MS = 7 * 86400000;
const WEEKS_KEPT = 12;          // stored on the signal
const SERIES_WEEKS = 8;         // drawn as the sparkline
const BASELINE_WEEKS = 4;       // trailing weeks a spike is measured against
const SPIKE_RATIO = 3;          // this week >= 3x the trailing average ...
const SPIKE_FLOOR = 4;          // ... and at least this many sightings
const PCT_MIN_BASE = 3;         // below this, a percentage is noise: say "+N"
const PULSE_KEEP = 60;          // newest sightings kept for the ticker
const EXCERPT_MAX = 160;

const SOURCE_OF_PREFIX = { hn: 'hackernews', rd: 'reddit', se: 'stackex', gh: 'github', as: 'appstore' };

function toDate(v) {
  if (v instanceof Date) return v;
  const d = new Date(v == null ? NaN : v);
  return isNaN(d) ? null : d;
}

/** The Monday (UTC) that starts the week `when` falls in, as YYYY-MM-DD.
 *  UTC rather than Eastern: the scan runs at 06:15 ET, which is the same UTC
 *  day, so no scan ever straddles the boundary. */
function weekStart(when) {
  const d = toDate(when);
  if (!d) return null;
  const day = (d.getUTCDay() + 6) % 7;                 // Monday = 0
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return m.toISOString().slice(0, 10);
}

function addWeeks(week, n) {
  const d = new Date(week + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10);
}

function cleanWeekly(weekly) {
  if (!Array.isArray(weekly)) return null;
  return weekly
    .filter((w) => w && /^\d{4}-\d{2}-\d{2}$/.test(String(w.week)) && Number(w.n) > 0)
    .map((w) => ({ week: String(w.week), n: Math.floor(Number(w.n)) }));
}

/** A signal's weekly history. Rows written before the rollup existed have
 *  none, and the honest reconstruction is a lower bound: one sighting in the
 *  week it was first seen and one in the week it was last seen. Inventing a
 *  spread for the seenCount in between would draw a trend nobody measured. */
function weeklyOf(signal) {
  const own = cleanWeekly(signal && signal.weekly);
  if (own) return own;
  const out = [];
  const first = weekStart(signal && signal.firstSeenAt);
  const last = weekStart(signal && signal.lastSeenAt);
  if (first) out.push({ week: first, n: 1 });
  if (last && last !== first) out.push({ week: last, n: 1 });
  return out;
}

/** Add `n` sightings at `when`, keeping the newest WEEKS_KEPT weeks. */
function bumpWeekly(weekly, when, n, keep = WEEKS_KEPT) {
  const week = weekStart(when);
  const add = Math.max(0, Math.floor(Number(n) || 0));
  const rows = (cleanWeekly(weekly) || []).slice();
  if (week && add) {
    const hit = rows.find((w) => w.week === week);
    if (hit) hit.n += add; else rows.push({ week, n: add });
  }
  rows.sort((a, b) => a.week.localeCompare(b.week));
  return rows.slice(-keep);
}

/** Counts per week, oldest first, ending with the week `now` is in. Weeks
 *  with no sightings are zeros, not gaps. */
function seriesOf(weekly, now = new Date(), weeks = SERIES_WEEKS) {
  const end = weekStart(now);
  const by = new Map((cleanWeekly(weekly) || []).map((w) => [w.week, w.n]));
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) out.push(by.get(addWeeks(end, -i)) || 0);
  return out;
}

/** This week against last week.
 *
 *  dir: 'up' | 'down' | 'flat' | 'none'. label is what the arrow says.
 *  Small numbers are where percentages lie: 1 -> 5 is "+400%" and means one
 *  thread. So from nothing it is "new" (or "back", for a problem first seen
 *  before last week), under PCT_MIN_BASE it is the plain difference, and only
 *  above that is it a percentage. */
function trend(series, { firstSeenAt, now = new Date() } = {}) {
  const s = Array.isArray(series) ? series : [];
  const cur = Number(s[s.length - 1] || 0);
  const prev = Number(s[s.length - 2] || 0);
  const base = { thisWeek: cur, lastWeek: prev, pct: null };
  if (!cur && !prev) return Object.assign(base, { dir: 'none', label: '' });
  if (cur === prev) return Object.assign(base, { dir: 'flat', label: 'steady' });
  if (!prev) {
    const fresh = weekStart(firstSeenAt) === weekStart(now) || !toDate(firstSeenAt);
    return Object.assign(base, { dir: 'up', label: fresh ? 'new' : 'back' });
  }
  const dir = cur > prev ? 'up' : 'down';
  if (prev < PCT_MIN_BASE) {
    const d = cur - prev;
    return Object.assign(base, { dir, label: (d > 0 ? '+' : '−') + Math.abs(d) });
  }
  const pct = Math.round(((cur - prev) / prev) * 100);
  return Object.assign(base, { dir, pct, label: (pct > 0 ? '+' : '−') + Math.abs(pct) + '%' });
}

/** Is this week a spike? Measured against the trailing BASELINE_WEEKS weeks
 *  (not counting this one). A baseline under one a week counts as one, so a
 *  problem that came from nothing reports a finite ratio - seven from nothing
 *  is "7x", not "Infinity" - and still needs the floor to count. */
function spikeOf(series, { ratio = SPIKE_RATIO, floor = SPIKE_FLOOR, weeks = BASELINE_WEEKS } = {}) {
  const s = Array.isArray(series) ? series : [];
  const cur = Number(s[s.length - 1] || 0);
  const trail = s.slice(Math.max(0, s.length - 1 - weeks), s.length - 1);
  while (trail.length < weeks) trail.unshift(0);
  const baseline = trail.reduce((a, b) => a + Number(b || 0), 0) / weeks;
  const r = cur / Math.max(baseline, 1);
  return {
    spiking: cur >= floor && r >= ratio,
    sightingsThisWeek: cur,
    baseline: Math.round(baseline * 100) / 100,
    ratio: Math.round(r * 10) / 10,
  };
}

/** Everything the board draws for one signal: series, trend and spike. */
function annotate(signal, now = new Date()) {
  const weekly = weeklyOf(signal);
  const series = seriesOf(weekly, now);
  const t = trend(series, { firstSeenAt: signal && signal.firstSeenAt, now });
  const sp = spikeOf(seriesOf(weekly, now, BASELINE_WEEKS + 1));
  return { series, trend: t, spike: sp };
}

/** One line on what this could be as an app, without a model. It is a
 *  prompt for a human (or the Challenge Lab's own idea step), not an answer,
 *  so it only has to point the right way: what kind of tool the problem's own
 *  words suggest, for whom, doing what. */
const KINDS = [
  [/reconcil|match(ing)? up|sync|out of sync|duplicate|dedup|merge/i, 'a reconciliation tool'],
  [/by hand|manual|spreadsheet|excel|copy[- ]?(and[- ])?past|re-?key|data entry/i, 'an automation'],
  [/alert|notif|\bmiss(ed|es|ing)?\b|\blate\b|deadline|expir|forget|remind/i, 'an alerting tool'],
  [/track|visib|can't see|cannot see|no view|dashboard|report|audit|status/i, 'a tracker'],
  [/approv|sign-?off|handoff|hand-off|onboard|offboard|workflow|queue/i, 'a workflow tool'],
  [/search|find|lookup|look up|discover/i, 'a search tool'],
  [/cost|bill|invoice|pric|spend|budget|expens/i, 'a cost tool'],
  [/migrat|export|import|convert|\bformats?\b/i, 'a converter'],
];

function oneLine(s, max) {
  // Complaints arrive with markup in them (GitHub issue bodies carry <b>,
  // <code>...). The page escapes them anyway; stripping them here keeps the
  // excerpt readable instead of showing the tags as text.
  const t = String(s == null ? '' : s).replace(/<\/?[a-z][^<>]*>/gi, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).replace(/[\s,;:.-]+\S*$/, '') + '…' : t;
}

function appHint(signal) {
  const title = oneLine(signal && signal.title, 90);
  const text = [title, signal && signal.summary].join(' ');
  let kind = 'a focused tool';
  for (const [re, k] of KINDS) if (re.test(text)) { kind = k; break; }
  const who = oneLine(signal && signal.who, 60).replace(/[.]+$/, '');
  // Lower-case the first letter to run on from "that takes on", but not an
  // acronym's: "LLMs making..." must not become "lLMs making...".
  const lead = (t) => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);
  const what = title ? lead(title) : 'this problem';
  return oneLine('Could be an app: ' + kind + (who ? ' for ' + lead(who) : '')
    + ' that takes on “' + what.replace(/[.]+$/, '') + '”', 200);
}

/** Pulse entries for one upsert: one per distinct source item. */
function sightingsFrom({ signalId, title, lensId, lensLabel, evidence, when, itemsById }) {
  const out = [];
  const seen = new Set();
  for (const e of evidence || []) {
    const itemId = String((e && e.itemId) || '');
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    const item = (itemsById && itemsById.get && itemsById.get(itemId)) || null;
    const url = item && /^https:\/\//.test(String(item.permalink || item.url || '')) ? String(item.permalink || item.url) : '';
    out.push({
      at: when,
      signalId,
      title: oneLine(title, 120),
      lensId: lensId || '',
      lensLabel: lensLabel || '',
      itemId,
      source: SOURCE_OF_PREFIX[itemId.split(':')[0]] || 'other',
      excerpt: oneLine(e.quote, EXCERPT_MAX),
      url,
    });
  }
  return out;
}

/** New entries in front, newest first, capped. */
function mergePulse(existing, fresh, keep = PULSE_KEEP) {
  const all = (fresh || []).concat(Array.isArray(existing) ? existing : []);
  all.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return all.slice(0, keep);
}

/** Before the first scan that writes the pulse, the board still has a
 *  history: each problem's newest quote was added when it was last seen. */
function fallbackPulse(signals, keep = 20) {
  const out = [];
  const sorted = (signals || [])
    .filter((s) => s && s.lastSeenAt)
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    .slice(0, keep);
  for (const s of sorted) {
    const ev = (s.evidence || [])[(s.evidence || []).length - 1];
    const one = ev ? sightingsFrom({ signalId: s.id, title: s.title, lensId: s.lensId, lensLabel: s.lensLabel,
      evidence: [ev], when: s.lastSeenAt })[0] : null;
    out.push(one || {
      at: s.lastSeenAt, signalId: s.id, title: oneLine(s.title, 120), lensId: s.lensId || '', lensLabel: s.lensLabel || '',
      itemId: '', source: (Array.isArray(s.sources) && s.sources[0]) || 'other', excerpt: '', url: '',
    });
  }
  return out;
}

module.exports = {
  weekStart, addWeeks, weeklyOf, bumpWeekly, seriesOf, trend, spikeOf, annotate, appHint,
  sightingsFrom, mergePulse, fallbackPulse,
  WEEKS_KEPT, SERIES_WEEKS, BASELINE_WEEKS, SPIKE_RATIO, SPIKE_FLOOR, PCT_MIN_BASE, PULSE_KEEP, EXCERPT_MAX, WEEK_MS,
};
