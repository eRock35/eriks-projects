// The free prefilter: which postings are worth a model's time for this
// person. Deterministic, explainable, no model call - so it can run over
// every posting every day and the person only pays for the top few.
//
//   rank(profile, postings, {n, watched}) -> [{posting, score, parts}] best first
//
// Out of 100:
//   title      45  how alike the role is to their best target title
//   seniority  20  rungs apart on the ladder (lib/titles.js)
//   place      15  remote they accept, or a location they named
//   pay        10  posted pay reaches their floor (no pay posted is neutral)
//   keywords   10  their skills and keywords found in the description
// A watched company adds 5. Hard misses take points off: remote-only and the
// posting is on site; posted pay entirely below 85% of the floor.

const { normTitle, titleSimilarity, LADDER } = require('./titles');

const MIN_SCORE = Number(process.env.NEXTMOVE_PREFILTER_MIN || 40);

function tokens(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9+#.]+/).filter(Boolean);
}

/** The person's targets in the shape the scorer uses, computed once per run. */
function prepare(profile) {
  const t = (profile && profile.targets) || {};
  const b = (profile && profile.background) || {};
  const titles = (t.titles || []).map((x) => normTitle(x)).filter((x) => x.core);
  const words = new Set();
  for (const k of [].concat(b.skills || [], b.keywords || [], t.keywords || [])) {
    const w = String(k || '').toLowerCase().trim();
    if (w.length >= 2 && w.length <= 40) words.add(w);
  }
  const places = (t.locations || []).map((l) => String(l || '').toLowerCase().split(',')[0].trim()).filter((x) => x.length >= 2);
  const states = (t.locations || []).map((l) => (String(l).match(/,\s*([A-Z]{2})\b/) || [])[1]).filter(Boolean);
  return {
    titles,
    seniority: t.seniority && t.seniority in LADDER ? t.seniority : null,
    remote: ['remote_only', 'remote_ok', 'onsite_only'].includes(t.remote) ? t.remote : 'remote_ok',
    places,
    states,
    floor: Number.isFinite(Number(t.compFloor)) && Number(t.compFloor) > 0 ? Number(t.compFloor) : null,
    keywords: [...words].slice(0, 60),
  };
}

function keywordHits(text, keywords) {
  if (!keywords.length) return [];
  const low = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `;
  const hits = [];
  for (const k of keywords) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(low)) hits.push(k);
    if (hits.length >= 12) break;
  }
  return hits;
}

/** One posting against one person: {score, parts, titleSim}. */
function scoreOne(prep, p, { watched = false } = {}) {
  const n = normTitle(p.title);
  let titleSim = 0;
  let bestTarget = null;
  for (const t of prep.titles) {
    const s = titleSimilarity(t, n);
    if (s > titleSim) { titleSim = s; bestTarget = t; }
  }
  const parts = {};
  parts.title = Math.round(45 * titleSim);

  const theirs = p.seniority || n.seniority;
  const want = prep.seniority || (bestTarget && bestTarget.seniority) || null;
  if (want && theirs && theirs in LADDER) {
    const d = Math.abs(LADDER[want] - LADDER[theirs]);
    parts.seniority = Math.round(20 * Math.max(0, 1 - d / 3));
  } else parts.seniority = 10;

  const loc = String(p.location || '').toLowerCase();
  const inPlace = prep.places.some((pl) => loc.includes(pl)) || (p.location_state && prep.states.includes(p.location_state));
  if (prep.remote === 'remote_only') parts.place = p.remote ? 15 : -20;
  else if (prep.remote === 'onsite_only') parts.place = inPlace ? 15 : p.remote ? 4 : 0;
  else parts.place = p.remote || inPlace ? 15 : prep.places.length ? 3 : 8;

  const hi = p.pay_max_annual !== null && p.pay_max_annual !== undefined ? Number(p.pay_max_annual) : (p.pay_min_annual !== null && p.pay_min_annual !== undefined ? Number(p.pay_min_annual) : null);
  if (!prep.floor || hi === null || (p.pay_currency && p.pay_currency !== 'USD')) parts.pay = 5;
  else if (hi >= prep.floor) parts.pay = 10;
  else if (hi < prep.floor * 0.85) parts.pay = -15;
  else parts.pay = 0;

  const hits = keywordHits(`${p.title} ${p.description_text || ''}`, prep.keywords);
  parts.keywords = prep.keywords.length ? Math.round(10 * Math.min(1, hits.length / Math.min(5, prep.keywords.length))) : 5;
  parts.watched = watched ? 5 : 0;

  const score = Math.max(0, Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0)));
  return { score, parts, titleSim, hits };
}

/**
 * The top `n` postings for this person, best first, above the floor score.
 * A posting at a watched company is eligible at any title similarity; one
 * elsewhere must look like one of their target titles (similarity >= 0.5).
 */
function rank(profile, postings, { n = 5, watched = new Set(), min = MIN_SCORE } = {}) {
  const prep = prepare(profile);
  if (!prep.titles.length) return [];
  const out = [];
  for (const p of postings) {
    const w = watched.has(p.company_key);
    const r = scoreOne(prep, p, { watched: w });
    if (!w && r.titleSim < 0.5) continue;
    if (r.score < min) continue;
    out.push({ posting: p, score: r.score, parts: r.parts, hits: r.hits });
  }
  // Ties go to the newer posting, then to the id, so a run is repeatable.
  out.sort((a, b) => b.score - a.score || String(b.posting.posted_at || '').localeCompare(String(a.posting.posted_at || '')) || String(a.posting.posting_id).localeCompare(String(b.posting.posting_id)));
  return out.slice(0, n);
}

module.exports = { prepare, scoreOne, rank, keywordHits, MIN_SCORE };
