// The BigQuery tables, in one place. `bq/schema.json` is generated from this
// (`node jobs/run.js schema > bq/schema.json`) and the test suite fails if
// the two disagree, so the file the parent uses to create tables by hand and
// the definitions `jobs/run.js setup` creates them from cannot drift.
//
// Columns beyond the original brief, each for a reason:
//   postings.location_state      comp by state needs a state, and "location"
//                                 is free text ("Atlanta, GA or Remote").
//   postings.pay_min_annual/max  every comparison is annual; computing it in
//                                 every query would repeat the period rules.
//   comp_public.wage_p25/p75,    BLS OEWS publishes percentiles per occupation
//     employment                  and area, not individual wages.
//   comp_public.seniority        the grade, so a comp read can stay on one rung.
//   fits.* (title ... pay)       the posting as it was scored, denormalised so
//                                 Today is ONE partition-pruned read of `fits`
//                                 and never a join that scans `postings`.
//   fits.content_hash            a posting re-scored only when its text changed.
//   company_events.source        'websearch' too, for the weekly sweep's news.

const F = (name, type, mode = 'NULLABLE', description) => ({ name, type, mode, ...(description ? { description } : {}) });

const TABLES = {
  postings: {
    description: 'Job postings from public career boards (Greenhouse, Lever, Ashby) and the weekly web-search sweep. One row per posting; MERGEd daily.',
    timePartitioning: { type: 'DAY', field: 'first_seen' },
    clustering: { fields: ['company_key'] },
    fields: [
      F('posting_id', 'STRING', 'REQUIRED', 'sha256 of source + board + the board\'s own id (hex, 32)'),
      F('source', 'STRING', 'REQUIRED', 'greenhouse | lever | ashby | websearch'),
      F('company_key', 'STRING', 'REQUIRED', '<provider>:<board token>, or name:<slug> when there is no public board'),
      F('company_name', 'STRING'),
      F('title', 'STRING'),
      F('title_norm', 'STRING', 'NULLABLE', 'the role with grade words removed (lib/titles.js)'),
      F('seniority', 'STRING', 'NULLABLE', 'intern | entry | mid | senior | staff | manager | director | vp | c_level'),
      F('department', 'STRING'),
      F('location', 'STRING'),
      F('location_state', 'STRING', 'NULLABLE', 'US state code when the location names one'),
      F('remote', 'BOOL'),
      F('url', 'STRING'),
      F('posted_at', 'TIMESTAMP'),
      F('first_seen', 'TIMESTAMP', 'REQUIRED'),
      F('last_seen', 'TIMESTAMP'),
      F('closed_at', 'TIMESTAMP', 'NULLABLE', 'set when a fetched board no longer lists it'),
      F('pay_min', 'NUMERIC'),
      F('pay_max', 'NUMERIC'),
      F('pay_currency', 'STRING'),
      F('pay_period', 'STRING', 'NULLABLE', 'hour | week | month | year'),
      F('pay_min_annual', 'NUMERIC'),
      F('pay_max_annual', 'NUMERIC'),
      F('pay_source', 'STRING', 'NULLABLE', 'posted (parsed from the text) | ashby_comp | lever_salary | null'),
      F('description_text', 'STRING', 'NULLABLE', 'plain text, truncated to 20,000 characters'),
      F('content_hash', 'STRING'),
    ],
  },
  comp_public: {
    description: 'Public compensation: DOL LCA (H-1B) disclosure data, one row per certified case; BLS OEWS, one row per occupation and area.',
    rangePartitioning: { field: 'year', range: { start: '2015', end: '2041', interval: '1' } },
    clustering: { fields: ['source', 'title_norm', 'worksite_state'] },
    fields: [
      F('source', 'STRING', 'REQUIRED', 'h1b_lca | bls_oews'),
      F('year', 'INTEGER', 'REQUIRED', 'fiscal year (LCA) or reference year (OEWS)'),
      F('quarter', 'INTEGER'),
      F('employer', 'STRING'),
      F('job_title', 'STRING'),
      F('title_norm', 'STRING'),
      F('seniority', 'STRING'),
      F('soc_code', 'STRING'),
      F('wage_annual', 'NUMERIC', 'NULLABLE', 'LCA: the offered wage (from), annualised. OEWS: the median.'),
      F('wage_p25', 'NUMERIC', 'NULLABLE', 'OEWS only'),
      F('wage_p75', 'NUMERIC', 'NULLABLE', 'OEWS only'),
      F('employment', 'INTEGER', 'NULLABLE', 'OEWS only'),
      F('worksite_city', 'STRING'),
      F('worksite_state', 'STRING'),
      F('case_status', 'STRING'),
    ],
  },
  company_events: {
    description: 'Company news and filings: SEC 8-Ks, GDELT news, and news the weekly sweep found.',
    timePartitioning: { type: 'DAY', field: 'published_at' },
    clustering: { fields: ['company_key'] },
    fields: [
      F('event_id', 'STRING', 'REQUIRED', 'sha256 of the source and its own id (accession number, URL)'),
      F('company_key', 'STRING', 'REQUIRED'),
      F('source', 'STRING', 'REQUIRED', 'sec | gdelt | websearch'),
      F('event_type', 'STRING', 'REQUIRED', 'layoff | exec_change | acquisition | funding | earnings | other'),
      F('headline', 'STRING'),
      F('url', 'STRING'),
      F('published_at', 'TIMESTAMP', 'REQUIRED'),
      F('sec_form', 'STRING'),
      F('sec_items', 'STRING', 'REPEATED'),
    ],
  },
  fits: {
    description: 'Fit scores. user_key is an HMAC of the account id - never the id, an email or a name.',
    timePartitioning: { type: 'DAY', field: 'scored_at' },
    clustering: { fields: ['user_key'] },
    fields: [
      F('user_key', 'STRING', 'REQUIRED', 'HMAC-SHA256 of the uid under a key derived from IDENTITY_SESSION_SECRET'),
      F('posting_id', 'STRING', 'REQUIRED'),
      F('scored_at', 'TIMESTAMP', 'REQUIRED'),
      F('score', 'INTEGER', 'REQUIRED', '0-100'),
      F('model', 'STRING'),
      F('verdict', 'STRING', 'NULLABLE', 'strong | worth_a_look | stretch | skip'),
      F('reasons', 'JSON', 'NULLABLE', '{strengths: [{point, quote}], positioning}'),
      F('gaps', 'JSON', 'NULLABLE', '[string]'),
      F('cost_usd', 'NUMERIC'),
      F('prefilter', 'NUMERIC', 'NULLABLE', 'the free prefilter score that put it in the top N'),
      F('content_hash', 'STRING'),
      F('company_key', 'STRING'),
      F('company_name', 'STRING'),
      F('title', 'STRING'),
      F('url', 'STRING'),
      F('location', 'STRING'),
      F('remote', 'BOOL'),
      F('pay_min_annual', 'NUMERIC'),
      F('pay_max_annual', 'NUMERIC'),
      F('pay_currency', 'STRING'),
      F('source', 'STRING'),
    ],
  },
  runs: {
    description: 'One row per job run.',
    timePartitioning: { type: 'DAY', field: 'started_at' },
    fields: [
      F('run_id', 'STRING', 'REQUIRED'),
      F('job', 'STRING', 'REQUIRED'),
      F('started_at', 'TIMESTAMP', 'REQUIRED'),
      F('finished_at', 'TIMESTAMP'),
      F('counts', 'JSON'),
      F('errors', 'JSON'),
    ],
  },
};

/** The tables.insert body for one table. */
function tableResource(project, dataset, name) {
  const t = TABLES[name];
  return {
    tableReference: { projectId: project, datasetId: dataset, tableId: name },
    description: t.description,
    schema: { fields: t.fields },
    ...(t.timePartitioning ? { timePartitioning: t.timePartitioning } : {}),
    ...(t.rangePartitioning ? { rangePartitioning: t.rangePartitioning } : {}),
    ...(t.clustering ? { clustering: t.clustering } : {}),
  };
}

/** What bq/schema.json holds: every table's resource, without project ids. */
function schemaJson() {
  const out = {};
  for (const name of Object.keys(TABLES)) {
    const r = tableResource('PROJECT', 'nextmove', name);
    delete r.tableReference;
    out[name] = r;
  }
  return out;
}

module.exports = { TABLES, tableResource, schemaJson };
