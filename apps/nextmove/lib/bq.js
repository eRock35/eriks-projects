// BigQuery, over its REST API - and an in-memory stand-in for tests and dev.
//
// No client library: the four calls this app makes (query, a load job, a
// table create, a table delete) are plain JSON over HTTPS, and the token
// comes from the Cloud Run metadata server like every other Google call this
// project makes without a key file. One dependency fewer in an image that
// already carries Firestore's.
//
// Two rules hold for EVERY query, real or fake:
//   1. It is a registered query (lib/queries.js): fixed SQL text with named
//      @parameters. Nothing a person typed is ever spliced into SQL - the only
//      substitution is {{table}} -> `project.dataset.table`, from env vars
//      checked against a strict pattern at startup.
//   2. It carries maximumBytesBilled. A query that would scan more is refused
//      by BigQuery before it runs, and costs nothing. The fake throws when it
//      is missing, so a test fails if a call site forgets.
//
// NEXTMOVE_MEMORY=1 selects the fake. It is refused on Cloud Run (K_SERVICE
// for a service, CLOUD_RUN_JOB for a job): a deployment that kept its data in
// a process that ends would look fine and keep nothing.

const crypto = require('crypto');
const { TABLES, tableResource } = require('./schema');

const MEMORY = process.env.NEXTMOVE_MEMORY === '1';
if (MEMORY && (process.env.K_SERVICE || process.env.CLOUD_RUN_JOB)) {
  throw new Error('NEXTMOVE_MEMORY=1 is for local use only and is refused on Cloud Run.');
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const API = 'https://bigquery.googleapis.com/bigquery/v2';
const UPLOAD = 'https://bigquery.googleapis.com/upload/bigquery/v2';
const DEFAULT_MAX_BYTES = Number(process.env.NEXTMOVE_BQ_MAX_BYTES || 2e9);

/* ------------------------------------------------------------------ *
 * Parameters
 * ------------------------------------------------------------------ */

const P = {
  str: (v) => ({ type: 'STRING', value: v === null || v === undefined ? null : String(v) }),
  int: (v) => ({ type: 'INT64', value: v === null || v === undefined ? null : Math.trunc(Number(v)) }),
  num: (v) => ({ type: 'FLOAT64', value: v === null || v === undefined ? null : Number(v) }),
  bool: (v) => ({ type: 'BOOL', value: v === null || v === undefined ? null : Boolean(v) }),
  ts: (v) => ({ type: 'TIMESTAMP', value: v === null || v === undefined ? null : new Date(v).toISOString() }),
  strs: (a) => ({ type: 'ARRAY', arrayType: 'STRING', value: (a || []).map(String) }),
};

function tsLiteral(iso) {
  // BigQuery's canonical TIMESTAMP text; ISO with a T also parses, but this
  // form is the one the docs promise.
  return iso.replace('T', ' ').replace('Z', '+00:00');
}

function toRestParam(name, p) {
  if (!p || typeof p !== 'object' || !p.type) throw new Error(`parameter @${name} is not typed (use bq.P)`);
  if (p.type === 'ARRAY') {
    return { name, parameterType: { type: 'ARRAY', arrayType: { type: p.arrayType } }, parameterValue: { arrayValues: p.value.map((v) => ({ value: String(v) })) } };
  }
  const v = p.value === null ? null : p.type === 'TIMESTAMP' ? tsLiteral(p.value) : String(p.value);
  return { name, parameterType: { type: p.type }, parameterValue: v === null ? {} : { value: v } };
}

/* ------------------------------------------------------------------ *
 * Rows coming back
 * ------------------------------------------------------------------ */

function convert(field, cell) {
  if (cell === null || cell === undefined) return null;
  if (field.mode === 'REPEATED') return (Array.isArray(cell) ? cell : []).map((c) => convert({ ...field, mode: 'NULLABLE' }, c && typeof c === 'object' && 'v' in c ? c.v : c));
  if (field.type === 'RECORD' || field.type === 'STRUCT') {
    const out = {};
    (field.fields || []).forEach((f, i) => { out[f.name] = convert(f, cell.f && cell.f[i] ? cell.f[i].v : null); });
    return out;
  }
  switch (field.type) {
    case 'INTEGER': case 'INT64': case 'FLOAT': case 'FLOAT64': case 'NUMERIC': case 'BIGNUMERIC': return Number(cell);
    case 'BOOLEAN': case 'BOOL': return cell === true || cell === 'true';
    case 'TIMESTAMP': {
      // With formatOptions.useInt64Timestamp, microseconds since the epoch.
      const n = Number(cell);
      return Number.isFinite(n) ? new Date(n / 1000).toISOString() : String(cell);
    }
    case 'JSON': try { return JSON.parse(cell); } catch (e) { return null; }
    default: return cell;
  }
}

function rowsFrom(schema, rows) {
  const fields = (schema && schema.fields) || [];
  return (rows || []).map((r) => {
    const o = {};
    fields.forEach((f, i) => { o[f.name] = convert(f, r.f[i] ? r.f[i].v : null); });
    return o;
  });
}

/* ------------------------------------------------------------------ *
 * The real client
 * ------------------------------------------------------------------ */

async function metadataToken(fetchImpl) {
  const res = await fetchImpl('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata token: ${res.status}`);
  const j = await res.json();
  return { token: j.access_token, until: Date.now() + (Number(j.expires_in || 300) - 60) * 1000 };
}

function bqError(status, message, body) {
  return Object.assign(new Error(message), { status, bq: true, reason: body && body.error && body.error.errors && body.error.errors[0] ? body.error.errors[0].reason : null });
}

function realClient(opts) {
  const fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a));
  const { project, dataset, location } = opts;
  let tok = null;
  async function token() {
    if (process.env.NEXTMOVE_BQ_TOKEN) return process.env.NEXTMOVE_BQ_TOKEN;
    if (!tok || Date.now() > tok.until) tok = await metadataToken(fetchImpl);
    return tok.token;
  }
  async function call(method, url, body, extraHeaders) {
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(extraHeaders || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch (e) { json = null; }
    if (!res.ok) throw bqError(res.status, `BigQuery ${method} ${res.status}: ${json && json.error ? String(json.error.message).slice(0, 300) : text.slice(0, 200)}`, json);
    return { json, headers: res.headers };
  }
  const tableRef = (t) => `${API}/projects/${project}/datasets/${dataset}/tables/${t}`;
  const sqlFor = (q) => q.sql.replace(/\{\{([a-z_0-9]+)\}\}/g, (_m, t) => `\`${project}.${dataset}.${t}\``);

  async function run(q, params = {}, o = {}) {
    const maxBytes = o.maxBytes || q.maxBytes || DEFAULT_MAX_BYTES;
    const body = {
      query: sqlFor(q),
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: Object.entries(params).map(([k, v]) => toRestParam(k, v)),
      maximumBytesBilled: String(Math.floor(maxBytes)),
      location,
      timeoutMs: 20000,
      formatOptions: { useInt64Timestamp: true },
      ...(o.dryRun ? { dryRun: true } : {}),
      labels: { app: 'nextmove', query: q.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 60) },
    };
    let { json } = await call('POST', `${API}/projects/${project}/queries`, body);
    if (o.dryRun) return { bytes: Number(json.totalBytesProcessed || 0) };
    const jobId = json.jobReference && json.jobReference.jobId;
    let tries = 0;
    while (!json.jobComplete) {
      if (++tries > 90) throw bqError(504, `BigQuery query ${q.name} did not finish`);
      ({ json } = await call('GET', `${API}/projects/${project}/queries/${jobId}?location=${location}&timeoutMs=10000&formatOptions.useInt64Timestamp=true`));
    }
    let rows = rowsFrom(json.schema, json.rows);
    let page = json.pageToken;
    while (page && rows.length < (o.maxRows || 50000)) {
      const r = await call('GET', `${API}/projects/${project}/queries/${jobId}?location=${location}&pageToken=${encodeURIComponent(page)}&formatOptions.useInt64Timestamp=true`);
      rows = rows.concat(rowsFrom(r.json.schema || json.schema, r.json.rows));
      page = r.json.pageToken;
    }
    rows.affected = json.numDmlAffectedRows !== undefined ? Number(json.numDmlAffectedRows) : null;
    rows.bytesBilled = Number(json.totalBytesBilled || 0);
    return rows;
  }

  async function waitJob(jobId) {
    for (let i = 0; i < 360; i++) {
      const { json } = await call('GET', `${API}/projects/${project}/jobs/${jobId}?location=${location}`);
      if (json.status && json.status.state === 'DONE') {
        if (json.status.errorResult) throw bqError(400, `load ${jobId}: ${String(json.status.errorResult.message).slice(0, 300)}${json.status.errors ? ' | ' + json.status.errors.slice(0, 3).map((e) => e.message).join(' | ').slice(0, 400) : ''}`);
        return json;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw bqError(504, `load ${jobId} did not finish`);
  }

  /** NDJSON load job (resumable upload). Free; no streaming buffer, so DML works on the rows at once. */
  async function load(table, rows, o = {}) {
    if (!NAME_RE.test(table)) throw new Error('bad table name');
    if (!rows.length) return { rows: 0 };
    const schemaTable = o.schemaOf || table;
    const jobId = `nextmove_load_${table}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const config = {
      configuration: {
        load: {
          destinationTable: { projectId: project, datasetId: dataset, tableId: table },
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          writeDisposition: o.write === 'truncate' ? 'WRITE_TRUNCATE' : 'WRITE_APPEND',
          createDisposition: 'CREATE_NEVER',
          schema: { fields: TABLES[schemaTable].fields },
          ignoreUnknownValues: false,
        },
        labels: { app: 'nextmove' },
      },
      jobReference: { projectId: project, location, jobId },
    };
    const start = await call('POST', `${UPLOAD}/projects/${project}/jobs?uploadType=resumable`, config);
    const where = start.headers.get('location');
    if (!where) throw bqError(502, 'BigQuery gave no upload URL');
    const data = rows.map((r) => JSON.stringify(r)).join('\n');
    const put = await fetchImpl(where, { method: 'PUT', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/octet-stream' }, body: data });
    if (!put.ok) throw bqError(put.status, `BigQuery upload ${put.status}: ${(await put.text()).slice(0, 200)}`);
    await waitJob(jobId);
    return { rows: rows.length };
  }

  async function tableExists(name) {
    try { await call('GET', tableRef(name)); return true; } catch (e) { if (e.status === 404) return false; throw e; }
  }

  async function createTable(name, o = {}) {
    const body = tableResource(project, dataset, o.schemaOf || name);
    body.tableReference.tableId = name;
    if (o.expiresInMs) body.expirationTime = String(Date.now() + o.expiresInMs);
    if (o.plain) { delete body.timePartitioning; delete body.rangePartitioning; delete body.clustering; }
    try { await call('POST', `${API}/projects/${project}/datasets/${dataset}/tables`, body); } catch (e) { if (e.status !== 409) throw e; }
  }

  async function dropTable(name) {
    if (!NAME_RE.test(name)) throw new Error('bad table name');
    try { await call('DELETE', tableRef(name)); } catch (e) { if (e.status !== 404) throw e; }
  }

  async function ensureTables() {
    const made = [];
    for (const name of Object.keys(TABLES)) {
      if (!(await tableExists(name))) { await createTable(name); made.push(name); }
    }
    return made;
  }

  return { kind: 'bigquery', run, load, createTable, dropTable, tableExists, ensureTables, sqlFor };
}

/* ------------------------------------------------------------------ *
 * The fake
 * ------------------------------------------------------------------ */

function memoryClient() {
  const tables = new Map();
  const calls = [];
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const table = (name) => {
    if (!tables.has(name)) throw Object.assign(new Error(`fake BigQuery: no table ${name}`), { status: 404 });
    return tables.get(name);
  };
  function coerce(name, r) {
    // What a load job would refuse, the fake refuses: an unknown column, a
    // REQUIRED one missing, a NUMERIC with more than nine decimals.
    const schema = TABLES[name] ? TABLES[name].fields : null;
    if (!schema) return r;
    const known = new Set(schema.map((f) => f.name));
    for (const k of Object.keys(r)) if (!known.has(k)) throw new Error(`fake BigQuery: ${name} has no column ${k}`);
    const out = {};
    for (const f of schema) {
      let v = r[f.name];
      if (v === undefined) v = null;
      if (v === null && f.mode === 'REQUIRED') throw new Error(`fake BigQuery: ${name}.${f.name} is required`);
      if (v !== null && f.type === 'NUMERIC') {
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`fake BigQuery: ${name}.${f.name} is not a number`);
        const dec = String(v).split('.')[1];
        if (dec && dec.length > 9 && !/e/.test(String(v))) throw new Error(`fake BigQuery: ${name}.${f.name} has more than 9 decimals`);
      }
      if (v !== null && f.type === 'TIMESTAMP') v = new Date(v).toISOString();
      if (f.mode === 'REPEATED' && v === null) v = [];
      out[f.name] = v;
    }
    return out;
  }
  return {
    kind: 'memory',
    async run(q, params = {}, o = {}) {
      const maxBytes = o.maxBytes || q.maxBytes || DEFAULT_MAX_BYTES;
      if (!(maxBytes > 0)) throw new Error(`fake BigQuery: ${q.name} has no maximumBytesBilled`);
      for (const [k, v] of Object.entries(params)) if (!v || !v.type) throw new Error(`fake BigQuery: @${k} is not typed`);
      for (const m of q.sql.matchAll(/@([a-zA-Z_]+)/g)) if (!(m[1] in params)) throw new Error(`fake BigQuery: ${q.name} uses @${m[1]} but it was not passed`);
      calls.push({ kind: 'query', name: q.name, params: clone(params), maxBytes });
      const flat = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.value]));
      const out = await q.fake({ table, tables, coerce, clone }, flat);
      const rows = clone(Array.isArray(out) ? out : (out && out.rows) || []);
      rows.affected = out && out.affected !== undefined ? out.affected : null;
      return rows;
    },
    async load(name, rows, o = {}) {
      calls.push({ kind: 'load', table: name, rows: clone(rows), write: o.write || 'append' });
      const t = table(name);
      const schemaName = o.schemaOf || name;
      const add = rows.map((r) => coerce(schemaName, clone(r)));
      if (o.write === 'truncate') t.length = 0;
      t.push(...add);
      return { rows: rows.length };
    },
    async createTable(name) { if (!tables.has(name)) tables.set(name, []); calls.push({ kind: 'create', table: name }); },
    async dropTable(name) { tables.delete(name); calls.push({ kind: 'drop', table: name }); },
    async tableExists(name) { return tables.has(name); },
    async ensureTables() {
      const made = [];
      for (const name of Object.keys(TABLES)) if (!tables.has(name)) { tables.set(name, []); made.push(name); }
      return made;
    },
    sqlFor: (q) => q.sql,
    /** Tests only. */
    _tables: tables,
    _calls: calls,
    _dump() { return JSON.stringify([...tables.entries()]) + JSON.stringify(calls); },
    _reset() { tables.clear(); calls.length = 0; },
  };
}

/* ------------------------------------------------------------------ *
 * Which one
 * ------------------------------------------------------------------ */

let shared = null;
function client(opts = {}) {
  if (opts.memory !== undefined ? opts.memory : MEMORY) {
    if (!opts.fresh && shared) return shared;
    const c = memoryClient();
    if (!opts.fresh) shared = c;
    return c;
  }
  const project = opts.project || process.env.GOOGLE_CLOUD_PROJECT || 'metal-celerity-236019';
  const dataset = opts.dataset || process.env.NEXTMOVE_BQ_DATASET || 'nextmove';
  const location = opts.location || process.env.NEXTMOVE_BQ_LOCATION || 'us-central1';
  if (!NAME_RE.test(project) || !/^[a-zA-Z0-9_]{1,64}$/.test(dataset) || !/^[a-z0-9-]{2,30}$/.test(location)) throw new Error('bad BigQuery project, dataset or location');
  if (!opts.fresh && shared) return shared;
  const c = realClient({ project, dataset, location, fetch: opts.fetch });
  if (!opts.fresh) shared = c;
  return c;
}

module.exports = { client, P, MEMORY, rowsFrom, toRestParam, realClient, memoryClient, DEFAULT_MAX_BYTES };
