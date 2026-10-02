// Every BigQuery statement this app runs, each beside its in-memory twin.
//
// Fixed SQL, named @parameters, {{table}} for the only substitution. The fake
// implements the same semantics in JavaScript, so the tests exercise what the
// SQL means; `node jobs/run.js check-sql` dry-runs every statement here
// against the real dataset (free) so the SQL itself is checked too.
//
// Bytes: every read is either partition-pruned (first_seen, scored_at,
// published_at, year) or clustered and narrow (company_key, user_key,
// title_norm), and every call carries maximumBytesBilled (bq.js).

const GB = 1e9;

function quantiles(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, p25: null, p50: null, p75: null };
  const at = (p) => v[Math.round(p * (v.length - 1))];
  return { n: v.length, p25: at(0.25), p50: at(0.5), p75: at(0.75) };
}
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const quarterOf = (iso) => { const d = new Date(iso); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`; };

const Q = {};

/** Postings already known for these companies (open or closed), for the diff. */
Q.EXISTING = {
  name: 'existing_postings',
  sql: `SELECT posting_id, content_hash, first_seen, closed_at
FROM {{postings}}
WHERE company_key IN UNNEST(@companies) AND source != 'websearch'`,
  fake: ({ table }, p) => table('postings').filter((r) => p.companies.includes(r.company_key) && r.source !== 'websearch')
    .map((r) => ({ posting_id: r.posting_id, content_hash: r.content_hash, first_seen: r.first_seen, closed_at: r.closed_at })),
};

/** The daily upsert. A posting seen again: last_seen moves (and its fields,
 *  when its text changed); a closed one that reappears is open again; one a
 *  fetched board no longer lists gets closed_at. Only boards fetched in this
 *  run (@companies) can close anything - a board that failed to load closes
 *  nothing. */
Q.mergePostings = (stage) => {
  if (!/^postings_stage_[a-z0-9]{6,40}$/.test(stage)) throw new Error('bad stage table');
  return {
    name: 'merge_postings',
    maxBytes: Number(process.env.NEXTMOVE_BQ_MERGE_MAX_BYTES || 50 * GB),
    sql: `MERGE {{postings}} T
USING {{${stage}}} S
ON T.posting_id = S.posting_id
WHEN MATCHED AND T.content_hash = S.content_hash THEN
  UPDATE SET last_seen = S.last_seen, closed_at = NULL
WHEN MATCHED THEN
  UPDATE SET company_name = S.company_name, title = S.title, title_norm = S.title_norm, seniority = S.seniority,
    department = S.department, location = S.location, location_state = S.location_state, remote = S.remote,
    url = S.url, posted_at = S.posted_at, last_seen = S.last_seen, closed_at = NULL,
    pay_min = S.pay_min, pay_max = S.pay_max, pay_currency = S.pay_currency, pay_period = S.pay_period,
    pay_min_annual = S.pay_min_annual, pay_max_annual = S.pay_max_annual, pay_source = S.pay_source,
    description_text = S.description_text, content_hash = S.content_hash
WHEN NOT MATCHED BY TARGET THEN
  INSERT ROW
WHEN NOT MATCHED BY SOURCE AND T.company_key IN UNNEST(@companies) AND T.closed_at IS NULL AND T.source != 'websearch' THEN
  UPDATE SET closed_at = @now`,
    fake: ({ table }, p) => {
      const T = table('postings');
      const S = table(stage);
      const byId = new Map(T.map((r) => [r.posting_id, r]));
      const inSource = new Set();
      let affected = 0;
      const seenSource = new Set();
      for (const s of S) {
        if (seenSource.has(s.posting_id)) throw new Error('fake BigQuery: MERGE would match one target row twice');
        seenSource.add(s.posting_id);
        inSource.add(s.posting_id);
        const t = byId.get(s.posting_id);
        if (t && t.content_hash === s.content_hash) { t.last_seen = s.last_seen; t.closed_at = null; affected++; }
        else if (t) { const keep = { posting_id: t.posting_id, source: t.source, company_key: t.company_key, first_seen: t.first_seen }; Object.assign(t, s, keep, { closed_at: null }); affected++; }
        else { T.push({ ...s }); affected++; }
      }
      for (const t of T) {
        if (!inSource.has(t.posting_id) && p.companies.includes(t.company_key) && t.closed_at === null && t.source !== 'websearch') { t.closed_at = new Date(p.now).toISOString(); affected++; }
      }
      return { rows: [], affected };
    },
  };
};

/** The weekly sweep's postings that a daily run should score. */
Q.RECENT_WEBSEARCH = {
  name: 'recent_websearch',
  sql: `SELECT posting_id, source, company_key, company_name, title, title_norm, seniority, location, location_state, remote,
  url, pay_min_annual, pay_max_annual, pay_currency, description_text, content_hash, first_seen
FROM {{postings}}
WHERE source = 'websearch' AND first_seen >= @since AND closed_at IS NULL
LIMIT 3000`,
  fake: ({ table }, p) => table('postings').filter((r) => r.source === 'websearch' && ms(r.first_seen) >= ms(p.since) && r.closed_at === null).slice(0, 3000),
};

/** Which of these URLs we already hold - the sweep never files a posting twice. */
Q.URLS_SEEN = {
  name: 'urls_seen',
  sql: `SELECT DISTINCT url FROM {{postings}} WHERE url IN UNNEST(@urls)`,
  fake: ({ table }, p) => [...new Set(table('postings').filter((r) => p.urls.includes(r.url)).map((r) => r.url))].map((url) => ({ url })),
};

/** What was scored recently for these users, so nothing is paid for twice. */
Q.SCORED = {
  name: 'scored_recently',
  sql: `SELECT user_key, posting_id, content_hash
FROM {{fits}}
WHERE scored_at >= @since AND user_key IN UNNEST(@keys)`,
  fake: ({ table }, p) => table('fits').filter((r) => ms(r.scored_at) >= ms(p.since) && p.keys.includes(r.user_key))
    .map((r) => ({ user_key: r.user_key, posting_id: r.posting_id, content_hash: r.content_hash })),
};

/** One person's fits since a date, newest score per posting. */
Q.FITS = {
  name: 'fits_for_user',
  sql: `SELECT posting_id, scored_at, score, model, verdict, reasons, gaps, cost_usd, company_key, company_name, title, url,
  location, remote, pay_min_annual, pay_max_annual, pay_currency, source
FROM {{fits}}
WHERE user_key = @key AND scored_at >= @since
QUALIFY ROW_NUMBER() OVER (PARTITION BY posting_id ORDER BY scored_at DESC) = 1
ORDER BY score DESC, scored_at DESC
LIMIT 300`,
  fake: ({ table }, p) => {
    const mine = table('fits').filter((r) => r.user_key === p.key && ms(r.scored_at) >= ms(p.since));
    const latest = new Map();
    for (const r of mine) { const h = latest.get(r.posting_id); if (!h || ms(r.scored_at) > ms(h.scored_at)) latest.set(r.posting_id, r); }
    return [...latest.values()].sort((a, b) => b.score - a.score || ms(b.scored_at) - ms(a.scored_at)).slice(0, 300)
      .map(({ user_key, prefilter, content_hash, ...rest }) => rest); // eslint-disable-line no-unused-vars
  },
};

/** Delete-account: every fit row under this key. */
Q.DELETE_FITS = {
  name: 'delete_user_fits',
  maxBytes: 20 * GB,
  sql: `DELETE FROM {{fits}} WHERE user_key = @key`,
  fake: ({ table }, p) => {
    const t = table('fits');
    const before = t.length;
    const keep = t.filter((r) => r.user_key !== p.key);
    t.length = 0;
    t.push(...keep);
    return { rows: [], affected: before - keep.length };
  },
};

/** Recent events for a set of companies. */
Q.EVENTS = {
  name: 'company_events',
  sql: `SELECT event_id, company_key, source, event_type, headline, url, published_at, sec_form
FROM {{company_events}}
WHERE company_key IN UNNEST(@companies) AND published_at >= @since
ORDER BY published_at DESC
LIMIT 400`,
  fake: ({ table }, p) => table('company_events').filter((r) => p.companies.includes(r.company_key) && ms(r.published_at) >= ms(p.since))
    .sort((a, b) => ms(b.published_at) - ms(a.published_at)).slice(0, 400)
    .map(({ sec_items, ...rest }) => rest), // eslint-disable-line no-unused-vars
};

/** Which of these event ids are stored already. */
Q.EVENT_IDS = {
  name: 'event_ids_seen',
  sql: `SELECT event_id FROM {{company_events}} WHERE event_id IN UNNEST(@ids) AND published_at >= @since`,
  fake: ({ table }, p) => table('company_events').filter((r) => p.ids.includes(r.event_id) && ms(r.published_at) >= ms(p.since)).map((r) => ({ event_id: r.event_id })),
};

/** Posted pay for one role: overall, by state, by quarter, and recent vs prior. USD only. */
Q.COMP_POSTED = {
  name: 'comp_posted',
  sql: `WITH base AS (
  SELECT IFNULL(location_state, IF(remote, 'REMOTE', 'OTHER')) AS state, first_seen,
    (IFNULL(pay_min_annual, pay_max_annual) + IFNULL(pay_max_annual, pay_min_annual)) / 2 AS mid
  FROM {{postings}}
  WHERE title_norm = @title AND pay_currency = 'USD' AND first_seen >= @since
    AND (pay_min_annual IS NOT NULL OR pay_max_annual IS NOT NULL)
)
SELECT 'all' AS dim, '' AS k, COUNT(*) AS n, APPROX_QUANTILES(mid, 4)[OFFSET(1)] AS p25, APPROX_QUANTILES(mid, 4)[OFFSET(2)] AS p50, APPROX_QUANTILES(mid, 4)[OFFSET(3)] AS p75 FROM base
UNION ALL
SELECT 'state', state, COUNT(*), APPROX_QUANTILES(mid, 4)[OFFSET(1)], APPROX_QUANTILES(mid, 4)[OFFSET(2)], APPROX_QUANTILES(mid, 4)[OFFSET(3)] FROM base GROUP BY state
UNION ALL
SELECT 'quarter', FORMAT_TIMESTAMP('%Y-Q%Q', first_seen), COUNT(*), APPROX_QUANTILES(mid, 4)[OFFSET(1)], APPROX_QUANTILES(mid, 4)[OFFSET(2)], APPROX_QUANTILES(mid, 4)[OFFSET(3)] FROM base GROUP BY 2
UNION ALL
SELECT 'window', IF(first_seen >= @recent, 'recent', 'prior'), COUNT(*), APPROX_QUANTILES(mid, 4)[OFFSET(1)], APPROX_QUANTILES(mid, 4)[OFFSET(2)], APPROX_QUANTILES(mid, 4)[OFFSET(3)] FROM base GROUP BY 2`,
  fake: ({ table }, p) => {
    const base = table('postings').filter((r) => r.title_norm === p.title && r.pay_currency === 'USD' && ms(r.first_seen) >= ms(p.since) && (r.pay_min_annual !== null || r.pay_max_annual !== null))
      .map((r) => {
        const lo = r.pay_min_annual !== null ? r.pay_min_annual : r.pay_max_annual;
        const hi = r.pay_max_annual !== null ? r.pay_max_annual : r.pay_min_annual;
        return { state: r.location_state || (r.remote ? 'REMOTE' : 'OTHER'), first_seen: r.first_seen, mid: (lo + hi) / 2 };
      });
    const group = (dim, keyOf) => {
      const m = new Map();
      for (const b of base) { const k = keyOf(b); if (!m.has(k)) m.set(k, []); m.get(k).push(b.mid); }
      return [...m.entries()].map(([k, v]) => ({ dim, k, ...quantiles(v) }));
    };
    return [{ dim: 'all', k: '', ...quantiles(base.map((b) => b.mid)) }, ...group('state', (b) => b.state), ...group('quarter', (b) => quarterOf(b.first_seen)), ...group('window', (b) => (ms(b.first_seen) >= ms(p.recent) ? 'recent' : 'prior'))];
  },
};

/** H-1B (LCA) wages for one role: overall, by state, by city, by year. */
Q.COMP_H1B = {
  name: 'comp_h1b',
  sql: `WITH base AS (
  SELECT year, worksite_state, worksite_city, wage_annual
  FROM {{comp_public}}
  WHERE source = 'h1b_lca' AND title_norm = @title AND year >= @fromYear AND wage_annual IS NOT NULL
)
SELECT 'all' AS dim, '' AS k, '' AS k2, COUNT(*) AS n, APPROX_QUANTILES(wage_annual, 4)[OFFSET(1)] AS p25, APPROX_QUANTILES(wage_annual, 4)[OFFSET(2)] AS p50, APPROX_QUANTILES(wage_annual, 4)[OFFSET(3)] AS p75 FROM base
UNION ALL
SELECT 'state', worksite_state, '', COUNT(*), APPROX_QUANTILES(wage_annual, 4)[OFFSET(1)], APPROX_QUANTILES(wage_annual, 4)[OFFSET(2)], APPROX_QUANTILES(wage_annual, 4)[OFFSET(3)] FROM base GROUP BY worksite_state
UNION ALL
SELECT 'city', worksite_city, worksite_state, COUNT(*), APPROX_QUANTILES(wage_annual, 4)[OFFSET(1)], APPROX_QUANTILES(wage_annual, 4)[OFFSET(2)], APPROX_QUANTILES(wage_annual, 4)[OFFSET(3)] FROM base GROUP BY worksite_city, worksite_state
UNION ALL
SELECT 'year', CAST(year AS STRING), '', COUNT(*), APPROX_QUANTILES(wage_annual, 4)[OFFSET(1)], APPROX_QUANTILES(wage_annual, 4)[OFFSET(2)], APPROX_QUANTILES(wage_annual, 4)[OFFSET(3)] FROM base GROUP BY year`,
  fake: ({ table }, p) => {
    const base = table('comp_public').filter((r) => r.source === 'h1b_lca' && r.title_norm === p.title && r.year >= p.fromYear && r.wage_annual !== null);
    const group = (dim, keyOf, k2Of) => {
      const m = new Map();
      for (const b of base) { const k = `${keyOf(b)}\u0001${k2Of ? k2Of(b) : ''}`; if (!m.has(k)) m.set(k, []); m.get(k).push(b.wage_annual); }
      return [...m.entries()].map(([k, v]) => ({ dim, k: k.split('\u0001')[0] || null, k2: k.split('\u0001')[1] || '', ...quantiles(v) }));
    };
    return [{ dim: 'all', k: '', k2: '', ...quantiles(base.map((b) => b.wage_annual)) }, ...group('state', (b) => b.worksite_state), ...group('city', (b) => b.worksite_city, (b) => b.worksite_state), ...group('year', (b) => String(b.year))];
  },
};

/** The SOC code H-1B filings use most for this role - the key into OEWS. */
Q.TOP_SOC = {
  name: 'comp_top_soc',
  sql: `SELECT soc_code, COUNT(*) AS n
FROM {{comp_public}}
WHERE source = 'h1b_lca' AND title_norm = @title AND year >= @fromYear AND soc_code IS NOT NULL
GROUP BY soc_code ORDER BY n DESC LIMIT 1`,
  fake: ({ table }, p) => {
    const m = new Map();
    for (const r of table('comp_public')) if (r.source === 'h1b_lca' && r.title_norm === p.title && r.year >= p.fromYear && r.soc_code) m.set(r.soc_code, (m.get(r.soc_code) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1).map(([soc_code, n]) => ({ soc_code, n }));
  },
};

/** BLS OEWS for one occupation: national and by state. */
Q.OEWS = {
  name: 'comp_oews',
  sql: `SELECT year, soc_code, job_title, worksite_state, wage_annual, wage_p25, wage_p75, employment
FROM {{comp_public}}
WHERE source = 'bls_oews' AND soc_code = @soc AND year >= @fromYear
ORDER BY year DESC
LIMIT 200`,
  fake: ({ table }, p) => table('comp_public').filter((r) => r.source === 'bls_oews' && r.soc_code === p.soc && r.year >= p.fromYear)
    .sort((a, b) => b.year - a.year).slice(0, 200)
    .map((r) => ({ year: r.year, soc_code: r.soc_code, job_title: r.job_title, worksite_state: r.worksite_state, wage_annual: r.wage_annual, wage_p25: r.wage_p25, wage_p75: r.wage_p75, employment: r.employment })),
};

/** Replace one file's worth of public comp, atomically, from a stage table. */
Q.replaceComp = (stage) => {
  if (!/^comp_stage_[a-z0-9]{6,40}$/.test(stage)) throw new Error('bad stage table');
  return {
    name: 'replace_comp',
    maxBytes: Number(process.env.NEXTMOVE_BQ_COMP_MAX_BYTES || 50 * GB),
    sql: `BEGIN TRANSACTION;
DELETE FROM {{comp_public}} WHERE source = @source AND year = @year AND IFNULL(quarter, -1) = IFNULL(@quarter, -1);
INSERT INTO {{comp_public}} SELECT * FROM {{${stage}}};
COMMIT TRANSACTION;`,
    fake: ({ table }, p) => {
      const t = table('comp_public');
      const keep = t.filter((r) => !(r.source === p.source && r.year === p.year && (r.quarter === null ? -1 : r.quarter) === (p.quarter === null ? -1 : p.quarter)));
      const add = table(stage).map((r) => ({ ...r }));
      t.length = 0;
      t.push(...keep, ...add);
      return { rows: [], affected: add.length };
    },
  };
};

const ALL = [Q.EXISTING, Q.RECENT_WEBSEARCH, Q.URLS_SEEN, Q.SCORED, Q.FITS, Q.DELETE_FITS, Q.EVENTS, Q.EVENT_IDS, Q.COMP_POSTED, Q.COMP_H1B, Q.TOP_SOC, Q.OEWS];

module.exports = { Q, ALL, quantiles, quarterOf, GB };
