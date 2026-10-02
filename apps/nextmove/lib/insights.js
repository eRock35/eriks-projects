// The read side: Today, Companies, Comp and This week, shaped from BigQuery
// rows. Every read is one of the registered, parameterised, partition-pruned
// queries; the shaping is pure and shared by the web routes and the weekly
// job (which stores a digest snapshot for each person).

const { Q } = require('./queries');
const { P } = require('./bq');
const { normTitle } = require('./titles');
const { VERDICT_LABEL } = require('./fit');

const DAY = 864e5;
const THRESHOLD = Number(process.env.NEXTMOVE_COMP_MIN_ROWS || 10);
const EVENT_LABEL = { layoff: 'Layoffs', exec_change: 'Leadership change', acquisition: 'Acquisition', funding: 'Funding', earnings: 'Earnings', other: 'News' };

/** A fit row as the page draws it. */
function fitView(r) {
  const reasons = r.reasons && typeof r.reasons === 'object' ? r.reasons : {};
  return {
    postingId: r.posting_id,
    scoredAt: r.scored_at,
    score: r.score,
    verdict: r.verdict,
    verdictLabel: VERDICT_LABEL[r.verdict] || '',
    strengths: Array.isArray(reasons.strengths) ? reasons.strengths.slice(0, 5) : [],
    positioning: typeof reasons.positioning === 'string' ? reasons.positioning : '',
    gaps: Array.isArray(r.gaps) ? r.gaps.slice(0, 5) : [],
    company: r.company_name || '',
    companyKey: r.company_key || '',
    title: r.title || '',
    url: r.url || '',
    location: r.location || '',
    remote: Boolean(r.remote),
    payMin: r.pay_min_annual === null || r.pay_min_annual === undefined ? null : Number(r.pay_min_annual),
    payMax: r.pay_max_annual === null || r.pay_max_annual === undefined ? null : Number(r.pay_max_annual),
    payCurrency: r.pay_currency || null,
    source: r.source || '',
    costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd),
  };
}

async function fits(bq, userKey, sinceIso) {
  const rows = await bq.run(Q.FITS, { key: P.str(userKey), since: P.ts(sinceIso) });
  return rows.map(fitView);
}

function eventView(r) {
  return { id: r.event_id, companyKey: r.company_key, source: r.source, type: r.event_type, typeLabel: EVENT_LABEL[r.event_type] || 'News', headline: r.headline || '', url: r.url || '', at: r.published_at, form: r.sec_form || null };
}

async function events(bq, companyKeys, sinceIso) {
  if (!companyKeys.length) return [];
  // One story often arrives twice (GDELT and the sweep, two outlets): keep
  // the first of each headline per company.
  const seen = new Set();
  return (await bq.run(Q.EVENTS, { companies: P.strs(companyKeys), since: P.ts(sinceIso) })).map(eventView).filter((e) => {
    const k = `${e.companyKey}|${e.headline.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const stat = (r) => ({ n: Number(r.n || 0), p25: r.p25 === null ? null : Math.round(Number(r.p25)), p50: r.p50 === null ? null : Math.round(Number(r.p50)), p75: r.p75 === null ? null : Math.round(Number(r.p75)), enough: Number(r.n || 0) >= THRESHOLD });

/** Comp for one target title, from the three sources, each labelled with its sample size. */
async function comp(bq, title, now = new Date().toISOString()) {
  const n = normTitle(title);
  if (!n.title_norm) return null;
  const t = Date.parse(now);
  const fromYear = new Date(t).getUTCFullYear() - 3;
  const [posted, h1b, soc] = await Promise.all([
    bq.run(Q.COMP_POSTED, { title: P.str(n.title_norm), since: P.ts(new Date(t - 365 * DAY).toISOString()), recent: P.ts(new Date(t - 30 * DAY).toISOString()) }),
    bq.run(Q.COMP_H1B, { title: P.str(n.title_norm), fromYear: P.int(fromYear) }),
    bq.run(Q.TOP_SOC, { title: P.str(n.title_norm), fromYear: P.int(fromYear) }),
  ]);
  const dim = (rows, d) => rows.filter((r) => r.dim === d);
  const out = {
    title,
    titleNorm: n.title_norm,
    threshold: THRESHOLD,
    posted: {
      all: stat(dim(posted, 'all')[0] || { n: 0, p25: null, p50: null, p75: null }),
      byState: dim(posted, 'state').map((r) => ({ state: r.k, ...stat(r) })).sort((a, b) => b.n - a.n).slice(0, 12),
      byQuarter: dim(posted, 'quarter').map((r) => ({ quarter: r.k, ...stat(r) })).sort((a, b) => String(a.quarter).localeCompare(String(b.quarter))),
      recent: stat(dim(posted, 'window').find((r) => r.k === 'recent') || { n: 0, p25: null, p50: null, p75: null }),
      prior: stat(dim(posted, 'window').find((r) => r.k === 'prior') || { n: 0, p25: null, p50: null, p75: null }),
    },
    h1b: {
      all: stat(dim(h1b, 'all')[0] || { n: 0, p25: null, p50: null, p75: null }),
      byState: dim(h1b, 'state').filter((r) => r.k).map((r) => ({ state: r.k, ...stat(r) })).sort((a, b) => b.n - a.n).slice(0, 12),
      byCity: dim(h1b, 'city').filter((r) => r.k).map((r) => ({ city: r.k, state: r.k2 || '', ...stat(r) })).sort((a, b) => b.n - a.n).slice(0, 10),
      byYear: dim(h1b, 'year').map((r) => ({ year: Number(r.k), ...stat(r) })).sort((a, b) => a.year - b.year),
    },
    oews: null,
  };
  if (soc[0] && soc[0].soc_code) {
    const rows = await bq.run(Q.OEWS, { soc: P.str(soc[0].soc_code), fromYear: P.int(fromYear) });
    const year = rows.length ? Math.max(...rows.map((r) => r.year)) : null;
    const latest = rows.filter((r) => r.year === year);
    const nat = latest.find((r) => !r.worksite_state);
    const r0 = (r) => (r === null || r === undefined ? null : Math.round(Number(r)));
    out.oews = latest.length ? {
      soc: soc[0].soc_code,
      occupation: (nat || latest[0]).job_title,
      year,
      national: nat ? { p25: r0(nat.wage_p25), p50: r0(nat.wage_annual), p75: r0(nat.wage_p75), employment: nat.employment } : null,
      byState: latest.filter((r) => r.worksite_state).map((r) => ({ state: r.worksite_state, p25: r0(r.wage_p25), p50: r0(r.wage_annual), p75: r0(r.wage_p75), employment: r.employment })),
    } : null;
  }
  return out;
}

/** The week's digest: top fits, company events, comp moves. Pure. */
function digest({ fitsThisWeek, eventsThisWeek, comps, now = new Date().toISOString(), weekKey }) {
  const top = fitsThisWeek.slice().sort((a, b) => b.score - a.score).slice(0, 5);
  const strong = fitsThisWeek.filter((f) => f.verdict === 'strong').length;
  const worth = fitsThisWeek.filter((f) => f.verdict === 'worth_a_look').length;
  const moves = [];
  for (const c of comps || []) {
    if (!c) continue;
    const { recent, prior } = c.posted;
    if (recent.n >= Math.max(3, Math.floor(THRESHOLD / 2)) && prior.n >= THRESHOLD && recent.p50 && prior.p50) {
      const pct = Math.round(((recent.p50 - prior.p50) / prior.p50) * 1000) / 10;
      moves.push({ title: c.title, recent: recent.p50, prior: prior.p50, pct, nRecent: recent.n, nPrior: prior.n });
    }
  }
  const byType = {};
  for (const e of eventsThisWeek) byType[e.type] = (byType[e.type] || 0) + 1;
  const cost = fitsThisWeek.reduce((a, f) => a + (Number(f.costUsd) || 0), 0);
  return {
    weekKey,
    builtAt: now,
    counts: { fits: fitsThisWeek.length, strong, worthALook: worth, events: eventsThisWeek.length, byType },
    topFits: top,
    events: eventsThisWeek.slice(0, 12),
    compMoves: moves,
    costUsd: Math.round(cost * 10000) / 10000,
  };
}

/** Monday (UTC) of the week `iso` falls in, as YYYY-MM-DD. */
function weekKey(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

/** Build one person's digest from BigQuery. */
async function buildDigest(bq, { userKey, watchlist, targets, now = new Date().toISOString() }) {
  const t = Date.parse(now);
  const since = new Date(t - 7 * DAY).toISOString();
  const [f, e, c] = await Promise.all([
    fits(bq, userKey, since),
    events(bq, (watchlist || []).map((w) => w.companyKey), since),
    Promise.all(((targets && targets.titles) || []).slice(0, 3).map((title) => comp(bq, title, now).catch(() => null))),
  ]);
  return digest({ fitsThisWeek: f, eventsThisWeek: e, comps: c, now, weekKey: weekKey(now) });
}

module.exports = { fitView, fits, events, eventView, comp, digest, buildDigest, weekKey, THRESHOLD, EVENT_LABEL };
