// Scoring one person's postings: the free prefilter picks the top N, and one
// metered score_fit call per posting scores them. Used by the daily job for
// everyone, and by "Score my top matches now" on the web for one person.
//
// Charged to the person (their uid on the meter), stopped by their own
// remaining credit and by the run's ceilings, whichever comes first.

const fit = require('./fit');
const prefilter = require('./prefilter');

const TOP_N = { free: Number(process.env.NEXTMOVE_TOP_N_FREE || 5), paid: Number(process.env.NEXTMOVE_TOP_N_MEMBER || 20) };

const round6 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null);

function fitRow({ userKey, posting, f, model, cost, prefilterScore, now }) {
  return {
    user_key: userKey,
    posting_id: posting.posting_id,
    scored_at: now,
    score: f.score,
    model,
    verdict: f.verdict,
    reasons: { strengths: f.strengths, positioning: f.positioning },
    gaps: f.gaps,
    cost_usd: round6(cost),
    prefilter: prefilterScore,
    content_hash: posting.content_hash || null,
    company_key: posting.company_key,
    company_name: posting.company_name || null,
    title: posting.title || null,
    url: posting.url || null,
    location: posting.location || null,
    remote: Boolean(posting.remote),
    pay_min_annual: posting.pay_min_annual === undefined ? null : posting.pay_min_annual,
    pay_max_annual: posting.pay_max_annual === undefined ? null : posting.pay_max_annual,
    pay_currency: posting.pay_currency || null,
    source: posting.source || null,
  };
}

/**
 * @param o.client     a client metered to this person
 * @param o.plan       identity.planFor(account, MODELS)
 * @param o.remainingUsd what they may still spend (Infinity for own key / owner)
 * @param o.caps       spend.runCaps() tally, shared across the run
 * @param o.scored     Map posting_id -> content_hash already scored for them
 * @returns {rows, scored, failed, stopped, considered}
 */
async function scoreUser(o) {
  const { client, plan, profile, userKey, postings, caps, scored = new Map(), now = new Date().toISOString(), log = () => {} } = o;
  const n = o.n || (plan.tier === 'paid' ? TOP_N.paid : TOP_N.free);
  const watched = new Set(((profile && profile.watchlist) || []).map((w) => w.companyKey));
  const fresh = postings.filter((p) => !scored.has(p.posting_id) || scored.get(p.posting_id) !== (p.content_hash || null));
  const top = prefilter.rank(profile, fresh, { n, watched });
  const rows = [];
  let failed = 0;
  let stopped = null;
  let spent = 0;
  for (const t of top) {
    if (!caps.canSpend()) { stopped = 'run-cap'; break; }
    if (spent >= o.remainingUsd) { stopped = 'no-credit'; break; }
    let res;
    try {
      res = await client.messages.create(fit.request(plan.model, profile, t.posting), { timeout: 120000, maxRetries: 1 });
    } catch (err) {
      failed++;
      log({ at: 'score', status: err && err.status ? err.status : null });
      if (err && (err.status === 401 || err.status === 403)) { stopped = 'key-refused'; break; }
      continue;
    }
    const cost = caps.record(plan.model, res && res.usage);
    spent += cost;
    const f = fit.cleanFit(fit.pick(res, 'score_fit'), t.posting);
    if (!f) { failed++; continue; }
    rows.push(fitRow({ userKey, posting: t.posting, f, model: plan.model, cost, prefilterScore: t.score, now }));
  }
  return { rows, scored: rows.length, failed, stopped, considered: fresh.length, costUsd: round6(spent) };
}

module.exports = { scoreUser, fitRow, TOP_N, round6 };
