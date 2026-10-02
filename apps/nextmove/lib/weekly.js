// The weekly job: the web-search sweep for each eligible person, then a
// digest snapshot for everyone with a profile.
//
// The sweep finds roles the career-board feeds missed and company news; its
// postings land in BigQuery as source 'websearch' (scored by the next daily
// run, like any other new posting) and its news as company events. One call
// per person, charged to them (route nextmove-sweep), skipped when they have
// no credit or are an unconfirmed free user, members on Sonnet and the free
// tier on Haiku (identity.planFor). The run is capped in calls and dollars.
//
// The digest needs no model: it is this week's fits, events and comp moves,
// stored at users/<uid>/digests/<week> for the page (and, one day, a mail).

const sweep = require('./sweep');
const { Q } = require('./queries');
const { P } = require('./bq');
const { keyFor } = require('./userkey');
const spend = require('./spend');
const insights = require('./insights');
const { normName } = require('./sec');
const { companyKeyFor } = require('./boards');
const { watched, storeEvents, pool, runId } = require('./daily');

async function run(o) {
  const { ctx } = o;
  const env = o.env || process.env;
  const now = o.now || new Date().toISOString();
  const id = o.runId || runId(now);
  const store = ctx.store;
  const bq = ctx.bqClient();
  const errors = [];
  const counts = { users: 0, swept: 0, skipped: {}, postings: 0, events: 0, dropped: 0, digests: 0, calls: 0, costUsd: 0 };
  const note = (where, err) => errors.push({ where: String(where).slice(0, 80), error: String((err && err.message) || err).slice(0, 200), status: err && err.status ? err.status : null });

  await bq.ensureTables();
  const { users } = await watched(store);
  const onboarded = users.filter((u) => u.profile.onboarded);
  counts.users = onboarded.length;
  const caps = spend.runCaps(env, { calls: 300, usd: 15 });
  const maxSweeps = Number(env.NEXTMOVE_MAX_SWEEPS_PER_RUN || 100);
  const urlsThisRun = new Set();

  await pool(onboarded, Number(env.NEXTMOVE_SWEEP_CONCURRENCY || 3), async (u) => {
    const skip = (why) => { counts.skipped[why] = (counts.skipped[why] || 0) + 1; };
    if (counts.swept >= maxSweeps || !caps.canSpend()) return skip('run-cap');
    const elig = await spend.eligible(ctx.identity, ctx.identityStore, u.uid, ctx.MODELS);
    if (elig.skip) return skip(elig.skip);
    counts.swept++;
    const byName = new Map(u.profile.watchlist.map((w) => [normName(w.name), w.companyKey]));
    const companyKeyOf = (name) => byName.get(normName(name)) || companyKeyFor(null, name);
    try {
      const client = await ctx.spendingClient(elig.account, 'nextmove-sweep');
      const { raw, responses } = await sweep.run(client, elig.plan, u.profile, u.profile.watchlist, []);
      for (const r of responses) caps.record(elig.plan.model, r && r.usage);
      const finds = sweep.cleanFinds(raw, { companyKeyOf, now: Date.parse(now) });
      counts.dropped += finds.dropped;
      const fresh = finds.postings.filter((p) => !urlsThisRun.has(p.url));
      for (const p of fresh) urlsThisRun.add(p.url);
      if (fresh.length) {
        const seen = new Set((await bq.run(Q.URLS_SEEN, { urls: P.strs(fresh.map((p) => p.url)) })).map((r) => r.url));
        const add = fresh.filter((p) => !seen.has(p.url));
        counts.dropped += fresh.length - add.length;
        if (add.length) { await bq.load('postings', add); counts.postings += add.length; }
      }
      counts.events += await storeEvents(bq, finds.events);
    } catch (err) { note('sweep', err); }
    return null;
  });
  counts.calls = caps.calls;
  counts.costUsd = caps.usd;

  // Digests for everyone with a profile, credit or not: no model call.
  for (const u of onboarded) {
    try {
      const d = await insights.buildDigest(bq, { userKey: keyFor(u.uid), watchlist: u.profile.watchlist, targets: u.profile.targets, now });
      await store.set(`users/${u.uid}/digests`, d.weekKey, d);
      counts.digests++;
    } catch (err) { note('digest', err); }
  }
  return { runId: id, counts, errors };
}

module.exports = { run };
