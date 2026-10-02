// The quarterly comp-refresh job: public pay data into comp_public.
//
//   LCA (H-1B) disclosure files from the Department of Labor's OFLC
//   performance-data page - LCA_URLS, comma-separated, because the file names
//   change every quarter ("LCA_Disclosure_Data_FY2026_Q1.xlsx"). Each file
//   replaces its own (fiscal year, quarter) rows.
//
//   BLS OEWS national and state files - OEWS_URLS, comma-separated, each a
//   .zip holding an .xlsx (oesm24nat.zip, oesm24st.zip) or an .xlsx. Each
//   replaces its reference year's rows. Optional: unset, it is skipped.
//
// Each file is downloaded to the job's disk (on Cloud Run that is memory, so
// the job runs with 4 GiB), read row by row (lib/xlsx.js), filtered and
// mapped (lib/lca.js), loaded into a stage table in NDJSON chunks, then
// swapped in with one transaction (DELETE that period + INSERT the stage), so
// a half-loaded file is never visible.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');
const xlsx = require('./xlsx');
const lca = require('./lca');
const { Q } = require('./queries');
const { P } = require('./bq');
const { runId } = require('./daily');

const MAX_DOWNLOAD = Number(process.env.NEXTMOVE_MAX_DOWNLOAD_BYTES || 1.5e9);
const CHUNK = 20000;

function urls(v) {
  return String(v || '').split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^https:\/\//.test(s));
}

async function download(url, toFile, { userAgent, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: '*/*' }, redirect: 'follow' });
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} answered ${res.status} for ${path.basename(new URL(url).pathname)}`), { status: res.status });
  let size = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => { size += c.length; if (size > MAX_DOWNLOAD) body.destroy(new Error('download larger than NEXTMOVE_MAX_DOWNLOAD_BYTES')); });
  await pipeline(body, fs.createWriteStream(toFile));
  return { file: toFile, bytes: size };
}

/** Map every record of a file through `toRow`, loading in chunks into `stage`. */
async function stageRows(bq, file, stage, toRow, { append = false } = {}) {
  if (!append) await bq.createTable(stage, { schemaOf: 'comp_public', expiresInMs: 864e5, plain: true });
  let batch = [];
  let read = 0;
  let kept = 0;
  let first = !append;
  const flush = async () => {
    if (!batch.length) return;
    await bq.load(stage, batch, { schemaOf: 'comp_public', write: first ? 'truncate' : 'append' });
    first = false;
    batch = [];
  };
  for await (const rec of xlsx.records(xlsx.rowsOf(file))) {
    read++;
    const row = toRow(rec);
    if (!row) continue;
    kept++;
    batch.push(row);
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  return { read, kept };
}

async function swapIn(bq, stage, source, year, quarter) {
  await bq.run(Q.replaceComp(stage), { source: P.str(source), year: P.int(year), quarter: P.int(quarter) });
}

async function run(o) {
  const { ctx } = o;
  const env = o.env || process.env;
  const now = o.now || new Date().toISOString();
  const id = o.runId || runId(now);
  const bq = ctx.bqClient();
  const fetchImpl = o.fetch || globalThis.fetch;
  const ua = String(env.SEC_USER_AGENT || '').trim() || 'NextMove/1.0 (+https://strongtechnicalconsulting.com)';
  const errors = [];
  const counts = { files: 0, lcaRows: 0, oewsRows: 0, read: 0 };
  const note = (where, err) => errors.push({ where: String(where).slice(0, 120), error: String((err && err.message) || err).slice(0, 200), status: err && err.status ? err.status : null });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextmove-comp-'));
  await bq.ensureTables();
  try {
    for (const url of urls(env.LCA_URLS)) {
      const name = path.basename(new URL(url).pathname);
      const period = lca.lcaPeriod(name);
      if (!period) { note(name, new Error('no FYyyyy_Qn in the file name')); continue; }
      const file = path.join(dir, `lca-${crypto.randomBytes(4).toString('hex')}${path.extname(name) || '.xlsx'}`);
      const stage = `comp_stage_${id}${crypto.randomBytes(2).toString('hex')}`;
      try {
        await download(url, file, { userAgent: ua, fetchImpl });
        const r = await stageRows(bq, file, stage, (rec) => lca.lcaRow(rec, period));
        await swapIn(bq, stage, 'h1b_lca', period.year, period.quarter);
        counts.files++; counts.lcaRows += r.kept; counts.read += r.read;
      } catch (err) { note(name, err); } finally {
        fs.rmSync(file, { force: true });
        await bq.dropTable(stage).catch(() => {});
      }
    }
    // OEWS: the national and the state file of one year go into ONE stage
    // and are swapped in together - swapping each alone would let the second
    // file's DELETE remove the first's rows.
    const byYear = new Map();
    for (const url of urls(env.OEWS_URLS)) {
      const name = path.basename(new URL(url).pathname);
      const year = lca.oewsYear(name);
      if (!year) { note(name, new Error('no reference year in the file name')); continue; }
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push({ url, name });
    }
    for (const [year, files] of byYear) {
      const stage = `comp_stage_${id}${crypto.randomBytes(2).toString('hex')}`;
      let staged = 0;
      try {
        for (const { url, name } of files) {
          const file = path.join(dir, `oews-${crypto.randomBytes(4).toString('hex')}${path.extname(name)}`);
          let sheet = file;
          try {
            await download(url, file, { userAgent: env.BLS_USER_AGENT || ua, fetchImpl });
            if (/\.zip$/i.test(name)) {
              const zip = xlsx.openZip(file);
              const inner = [...zip.entries.keys()].find((n) => /\.xlsx$/i.test(n) && !/field_descriptions/i.test(n));
              if (!inner) throw new Error('no .xlsx inside the zip');
              sheet = path.join(dir, `oews-inner-${crypto.randomBytes(4).toString('hex')}.xlsx`);
              await xlsx.extractEntry(zip, inner, sheet);
            }
            const r = await stageRows(bq, sheet, stage, (rec) => lca.oewsRow(rec, year), { append: staged > 0 });
            staged++;
            counts.files++; counts.oewsRows += r.kept; counts.read += r.read;
          } finally {
            fs.rmSync(file, { force: true });
            if (sheet !== file) fs.rmSync(sheet, { force: true });
          }
        }
        // Only a year whose every file loaded replaces what is stored.
        if (staged === files.length) await swapIn(bq, stage, 'bls_oews', year, null);
      } catch (err) { note(`oews ${year}`, err); } finally {
        await bq.dropTable(stage).catch(() => {});
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!urls(env.LCA_URLS).length) counts.lcaSkipped = 'LCA_URLS is not set';
  if (!urls(env.OEWS_URLS).length) counts.oewsSkipped = 'OEWS_URLS is not set';
  return { runId: id, counts, errors };
}

module.exports = { run, download, stageRows, urls };
