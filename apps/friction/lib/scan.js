// One scan run: read, score, merge.
//
// The merge is the point of running this daily rather than once. A problem
// that shows up again next week is a different thing from one that showed up
// once, and only a tool with memory can tell them apart. So a problem seen
// again does not create a second row - it raises the recurrence count on the
// existing one and adds its new evidence. What rises to the top over a month
// is what genuinely keeps hurting, not whatever was loudest this morning.

const db = require('./db');
const sources = require('./sources');
const score = require('./score');
const pulse = require('./pulse');

const EVIDENCE_CAP = 12;
const STATUSES = ['new', 'digging', 'building', 'passed'];

function nowIso() { return new Date().toISOString(); }

// An item id carries its origin, so a signal can be traced back to the
// licences its evidence came under without storing the items themselves.
const ID_PREFIX = { hn: 'hackernews', rd: 'reddit', se: 'stackex', gh: 'github', as: 'appstore' };

function sourcesOf(evidence) {
  const set = new Set();
  for (const e of evidence || []) {
    const src = ID_PREFIX[String(e.itemId || '').split(':')[0]];
    if (src) set.add(src);
  }
  return [...set].sort();
}

/** A signal may only be shown to anyone other than the owner when EVERY
 *  source behind it may be used commercially. One Reddit quote makes the
 *  whole row private, because that is the quote a subscriber would be paying
 *  to read. See SOURCE_META in sources.js for what each licence allows. */
function publicSafe(srcs) {
  return srcs.length > 0 && srcs.every(sources.commercialSafe);
}

async function loadLenses() {
  const saved = await db.list('lenses');
  const byId = new Map(saved.map((l) => [l.id, l]));

  for (const def of sources.DEFAULT_LENSES) {
    const existing = byId.get(def.id);

    // Seed each missing default individually rather than only when the
    // collection is empty: a lens added in a later release would otherwise
    // stay invisible forever just because some other lens already existed.
    if (!existing) {
      const doc = Object.assign({}, def, { seedVersion: sources.SEED_VERSION });
      await db.set('lenses', def.id, doc);
      byId.set(def.id, doc);
      continue;
    }

    // Refresh the machine-tuned fields when the code's seed moves ahead of
    // what is on file, and leave alone the two fields Erik controls. A query
    // fixed in code has to reach the rows that were seeded with the broken
    // one; a lens he switched off has to stay off.
    if (Number(existing.seedVersion || 1) < sources.SEED_VERSION) {
      const patch = { hn: def.hn, se: def.se || [], gh: def.gh || [], apps: def.apps || [], label: def.label, seedVersion: sources.SEED_VERSION };
      await db.merge('lenses', def.id, patch);
      byId.set(def.id, Object.assign({}, existing, patch));
    }
  }

  return [...byId.values()];
}

/** Fold one freshly-scored problem into whatever is already on the board.
 *
 *  Also returns the SIGHTINGS it recorded - one per distinct source item - for
 *  the pulse ticker, and keeps the signal's weekly rollup (`weekly`, see
 *  lib/pulse.js) that trend arrows and spikes are read from. `itemsById` is
 *  optional and only lends each sighting a link back to its source. */
async function upsertSignal(lens, problem, runId, itemsById) {
  const id = `${lens.id}:${problem.slug}`;
  const existing = await db.get('signals', id);
  const when = nowIso();

  const srcs = sourcesOf(problem.evidence);
  const sightings = pulse.sightingsFrom({
    signalId: id, title: (existing && existing.title) || problem.title, lensId: lens.id, lensLabel: lens.label,
    evidence: problem.evidence, when, itemsById,
  });
  const n = Math.max(1, sightings.length);

  if (!existing) {
    const doc = {
      sources: srcs,
      publicSafe: publicSafe(srcs),
      lensId: lens.id,
      lensLabel: lens.label,
      slug: problem.slug,
      title: problem.title,
      summary: problem.summary,
      who: problem.who,
      existingTools: problem.existingTools,
      angle: problem.angle,
      scores: problem.scores,
      score: problem.score,
      peakScore: problem.score,
      evidence: problem.evidence.slice(0, EVIDENCE_CAP),
      seenCount: 1,
      status: 'new',
      notes: '',
      firstSeenAt: when,
      lastSeenAt: when,
      lastRunId: runId,
      weekly: pulse.bumpWeekly([], when, n),
    };
    await db.set('signals', id, doc);
    return { id, created: true, doc, sightings };
  }

  // Never clobber a decision Erik already made about this row.
  const seen = new Set((existing.evidence || []).map((e) => e.quote));
  const merged = (existing.evidence || []).concat(
    problem.evidence.filter((e) => !seen.has(e.quote))
  ).slice(-EVIDENCE_CAP);

  const mergedSources = sourcesOf(merged);
  const patch = {
    sources: mergedSources,
    publicSafe: publicSafe(mergedSources),
    summary: problem.summary,
    existingTools: problem.existingTools,
    angle: problem.angle,
    scores: problem.scores,
    score: problem.score,
    peakScore: Math.max(Number(existing.peakScore || 0), problem.score),
    evidence: merged,
    seenCount: Number(existing.seenCount || 1) + 1,
    lastSeenAt: when,
    lastRunId: runId,
    // A row from before the rollup starts from its reconstructed history
    // (first and last seen), not from nothing.
    weekly: pulse.bumpWeekly(pulse.weeklyOf(existing), when, n),
  };
  await db.merge('signals', id, patch);
  return { id, created: false, doc: Object.assign({}, existing, patch), sightings };
}

/** Which lens is most overdue. One lens per run keeps a single invocation
 *  inside its request timeout; the schedule below brings every lens around
 *  once a day, and spreads both the load and the reading over the day. */
function pickNext(lenses) {
  const sorted = lenses.slice().sort(function (a, b) {
    return String(a.lastScannedAt || '').localeCompare(String(b.lastScannedAt || ''));
  });
  return sorted[0] || null;
}

/** A pass over one lens, or every lens when scope is 'all'. */
async function runScan({ trigger = 'manual', sinceDays = 14, scope = 'next' } = {}) {
  const runId = `run-${Date.now()}`;
  const startedAt = nowIso();
  const redditEnabled = process.env.ENABLE_REDDIT !== 'false';

  const enabled = (await loadLenses()).filter((l) => l.enabled !== false);
  let lenses;
  if (scope === 'all') lenses = enabled;
  else if (scope && scope !== 'next') lenses = enabled.filter((l) => l.id === scope);
  else { const one = pickNext(enabled); lenses = one ? [one] : []; }

  const summary = { runId, trigger, scope, startedAt, lenses: [], created: 0, updated: 0, examined: 0, errors: [] };
  const heard = [];

  for (const lens of lenses) {
    const { items, errors, probes } = await sources.harvest(lens, { sinceDays, redditEnabled });
    summary.errors.push(...errors);

    // Anything read on an earlier run is not news. This is what keeps a daily
    // job cheap: the same front page tomorrow costs nothing to skip.
    const seen = await db.seenSet(lens.id);
    const fresh = items.filter((i) => !seen.has(i.id));

    let created = 0, updated = 0;
    let scored = { problems: [], errors: [], examined: 0, skipped: 0 };
    if (fresh.length) {
      scored = await score.scoreItems(fresh, lens.label);
      summary.errors.push(...scored.errors);
      const itemsById = new Map(fresh.map((i) => [i.id, i]));
      for (const problem of scored.problems) {
        const r = await upsertSignal(lens, problem, runId, itemsById);
        if (r.created) created++; else updated++;
        heard.push(...(r.sightings || []));
      }
      await db.saveSeen(lens.id, [...seen, ...fresh.map((i) => i.id)]);
    }

    summary.lenses.push({
      id: lens.id, label: lens.label,
      found: items.length, fresh: fresh.length, examined: scored.examined,
      skipped: scored.skipped, problems: scored.problems.length, created, updated,
      probes: probes || [],
    });
    summary.created += created;
    summary.updated += updated;
    summary.examined += scored.examined;
    await db.merge('lenses', lens.id, { lastScannedAt: nowIso() });
  }

  // The ticker's feed: one small document, rewritten once per run, inside
  // this request. Nothing polls a source or recomputes this between scans.
  if (heard.length) {
    const prev = await db.get('control', 'pulse');
    await db.set('control', 'pulse', {
      items: pulse.mergePulse(prev && prev.items, heard),
      updatedAt: nowIso(),
    });
  }
  summary.sightings = heard.length;

  summary.finishedAt = nowIso();
  summary.ok = summary.errors.length === 0;
  await db.set('runs', runId, summary);
  await db.set('control', 'last-run', summary);
  return summary;
}

module.exports = { runScan, loadLenses, upsertSignal, pickNext, sourcesOf, publicSafe, STATUSES, EVIDENCE_CAP };
