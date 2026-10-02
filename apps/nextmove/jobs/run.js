#!/usr/bin/env node
// The Cloud Run JOB entrypoints - same image as the web service.
//
//   node jobs/run.js daily          boards, postings MERGE, filings and news, scoring
//   node jobs/run.js weekly         the web-search sweep, then each person's digest
//   node jobs/run.js comp-refresh   DOL LCA (H-1B) and BLS OEWS into comp_public
//   node jobs/run.js setup          create any missing BigQuery tables, and stop
//   node jobs/run.js check-sql      dry-run every registered query (free) - a deploy check
//   node jobs/run.js schema         print bq/schema.json
//
// Every step is awaited. The process ends with ONE line of JSON on stdout
// ({job, runId, ok, counts, errors, ms}) and exits non-zero when the job
// failed outright (BigQuery or Firestore unreachable, a bug). A board, a
// filing or one person failing is counted in `errors` and the run goes on.

const ctx = require('../lib/context');
const http = require('../lib/http');
const { P } = require('../lib/bq');
const { ALL } = require('../lib/queries');
const { schemaJson } = require('../lib/schema');

function clients(env = process.env) {
  return {
    boards: http.create({ concurrency: 4, hostGapMs: 400, timeoutMs: 30000 }),
    // SEC fair access: well under ten a second, with the operator's contact.
    sec: http.create({ concurrency: 2, hostGapMs: 150, timeoutMs: 30000, userAgent: env.SEC_USER_AGENT || undefined }),
    // GDELT asks for one request every five seconds.
    gdelt: http.create({ concurrency: 1, hostGapMs: Number(env.NEXTMOVE_GDELT_GAP_MS || 5500), timeoutMs: 20000 }),
  };
}

/** Sample parameters for the dry run: right types, harmless values. */
function sampleParams(q) {
  const out = {};
  const now = new Date().toISOString();
  for (const m of q.sql.matchAll(/@([a-zA-Z_]+)/g)) {
    const k = m[1];
    if (out[k]) continue;
    if (['companies', 'urls', 'keys', 'ids'].includes(k)) out[k] = P.strs(['x']);
    else if (['since', 'recent', 'now'].includes(k)) out[k] = P.ts(now);
    else if (['fromYear', 'year', 'quarter'].includes(k)) out[k] = P.int(2024);
    else out[k] = P.str('x');
  }
  return out;
}

async function record(job, out, started, ok) {
  const finished = new Date().toISOString();
  const row = { run_id: out.runId || `${job}-${Date.now()}`, job, started_at: started, finished_at: finished, counts: out.counts || {}, errors: (out.errors || []).slice(0, 50) };
  try { await ctx.bqClient().load('runs', [row]); } catch (e) { /* the summary line below still says it */ }
  const doc = { job, runId: row.run_id, startedAt: started, finishedAt: finished, ok, counts: row.counts, errorCount: (out.errors || []).length, firstErrors: row.errors.slice(0, 5) };
  try {
    await ctx.store.set('control', `last-${job}`, doc);
    if (job === 'daily') await ctx.store.set('control', 'last-run', doc);
  } catch (e) { /* same */ }
}

async function main(job, opts = {}) {
  const started = new Date().toISOString();
  const t0 = Date.now();
  const env = opts.env || process.env;
  let out = { counts: {}, errors: [] };
  let ok = true;
  try {
    if (job === 'schema') { process.stdout.write(`${JSON.stringify(schemaJson(), null, 2)}\n`); return 0; }
    if (job === 'setup') {
      out = { counts: { created: await ctx.bqClient().ensureTables() }, errors: [] };
    } else if (job === 'check-sql') {
      const bq = ctx.bqClient();
      const results = {};
      const { Q } = require('../lib/queries');
      // The two statements that read a per-run stage table get a throwaway one.
      await bq.createTable('postings_stage_checksql', { schemaOf: 'postings', expiresInMs: 36e5, plain: true });
      await bq.createTable('comp_stage_checksql', { schemaOf: 'comp_public', expiresInMs: 36e5, plain: true });
      try {
        // A transaction script is checked statement by statement.
        const asStatements = (q) => (!/BEGIN TRANSACTION/.test(q.sql) ? [q] : q.sql.split(';').map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)/.test(s))
          .map((sql, i) => ({ ...q, name: `${q.name}_${i + 1}`, sql })));
        for (const q of [...ALL, Q.mergePostings('postings_stage_checksql'), ...asStatements(Q.replaceComp('comp_stage_checksql'))]) {
          try { results[q.name] = bq.kind === 'memory' ? 'memory' : (await bq.run(q, sampleParams(q), { dryRun: true })).bytes; } catch (e) { results[q.name] = `ERROR ${String(e.message).slice(0, 200)}`; ok = false; }
        }
      } finally {
        await bq.dropTable('postings_stage_checksql').catch(() => {});
        await bq.dropTable('comp_stage_checksql').catch(() => {});
      }
      out = { counts: results, errors: [] };
    } else if (job === 'daily') {
      out = await require('../lib/daily').run({ ctx, http: opts.http || clients(env), env, now: opts.now });
    } else if (job === 'weekly') {
      out = await require('../lib/weekly').run({ ctx, env, now: opts.now });
    } else if (job === 'comp-refresh') {
      out = await require('../lib/comprefresh').run({ ctx, env, now: opts.now, fetch: opts.fetch });
    } else {
      throw new Error(`unknown job "${job}" - daily | weekly | comp-refresh | setup | check-sql | schema`);
    }
  } catch (err) {
    ok = false;
    out.errors = (out.errors || []).concat([{ where: 'fatal', error: String((err && err.message) || err).slice(0, 300), status: err && err.status ? err.status : null }]);
    if (err && err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
  }
  if (job !== 'schema' && job !== 'check-sql' && job !== 'setup') await record(job, out, started, ok);
  const line = { job, runId: out.runId || null, ok, counts: out.counts, errors: (out.errors || []).length, firstError: (out.errors || [])[0] || null, ms: Date.now() - t0 };
  if (!opts.quiet) console.log(JSON.stringify(line));
  return ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv[2] || '').then((code) => process.exit(code), (err) => {
    console.log(JSON.stringify({ job: process.argv[2] || null, ok: false, errors: 1, firstError: { where: 'fatal', error: String(err && err.message).slice(0, 300) } }));
    process.exit(1);
  });
}

module.exports = { main, clients, sampleParams };
