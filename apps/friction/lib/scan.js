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

const EVIDENCE_CAP = 12;
const STATUSES = ['new', 'digging', 'building', 'passed'];

function nowIso() { return new Date().toISOString(); }

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
      const patch = { hn: def.hn, label: def.label, seedVersion: sources.SEED_VERSION };
      await db.merge('lenses', def.id, patch);
      byId.set(def.id, Object.assign({}, existing, patch));
    }
  }

  return [...byId.values()];
}

/** Fold one freshly-scored problem into whatever is already on the board. */
async function upsertSignal(lens, problem, runId) {
  const id = `${lens.id}:${problem.slug}`;
  const existing = await db.get('signals', id);
  const when = nowIso();

  if (!existing) {
    const doc = {
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
    };
    await db.set('signals', id, doc);
    return { id, created: true, doc };
  }

  // Never clobber a decision Erik already made about this row.
  const seen = new Set((existing.evidence || []).map((e) => e.quote));
  const merged = (existing.evidence || []).concat(
    problem.evidence.filter((e) => !seen.has(e.quote))
  ).slice(-EVIDENCE_CAP);

  const patch = {
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
  };
  await db.merge('signals', id, patch);
  return { id, created: false, doc: Object.assign({}, existing, patch) };
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
      for (const problem of scored.problems) {
        const r = await upsertSignal(lens, problem, runId);
        if (r.created) created++; else updated++;
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

  summary.finishedAt = nowIso();
  summary.ok = summary.errors.length === 0;
  await db.set('runs', runId, summary);
  await db.set('control', 'last-run', summary);
  return summary;
}

module.exports = { runScan, loadLenses, upsertSignal, pickNext, STATUSES, EVIDENCE_CAP };
