#!/usr/bin/env node
// The daily run's door into Erik's ideas inbox.
//
// A Claude Code session cannot reach strongtechnicalconsulting.com (the
// sandbox's egress allows *.googleapis.com and not much else), so this reads
// and writes the `inbox` collection straight through the Firestore REST API,
// with the deploy token the session already mints for shipping.
//
//   node scripts/inbox.js list [--status new|seen|doing|done|parked|all] [--json]
//   node scripts/inbox.js note <id> [--status seen|doing|done|parked] [--note "what I did / what I need"]
//
// `note` changes only status, claudeNote and updatedAt - never the text,
// which is what Erik said. Validation is lib/inbox.js's, the same rules the
// site applies.
//
// Environment:
//   GCP_TOKEN_FILE          default /tmp/gcpdeploy/token
//   GOOGLE_CLOUD_PROJECT    default metal-celerity-236019
//   INBOX_DATABASE_ID       default eriks-projects (the landing service's
//                           FIRESTORE_DATABASE_ID)

const fs = require('fs');
const path = require('path');
const inbox = require(path.join(__dirname, '..', 'lib', 'inbox.js'));

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'metal-celerity-236019';
const DATABASE = process.env.INBOX_DATABASE_ID || 'eriks-projects';
const tokenFile = () => process.env.GCP_TOKEN_FILE || '/tmp/gcpdeploy/token';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents`;

/* ---------- Firestore's typed JSON ---------- */

function fromValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(fromValue);
  if ('mapValue' in v) return fromFields((v.mapValue && v.mapValue.fields) || {});
  return null;
}

function fromFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fromValue(v);
  return out;
}

function fromDocument(doc) {
  const id = String(doc.name || '').split('/').pop();
  return inbox.publicItem({ id, ...fromFields(doc.fields) });
}

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}

/* ---------- requests ---------- */

function token() {
  try {
    const t = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (t) return t;
  } catch (e) { /* reported below */ }
  throw new Error(`No access token at ${tokenFile()}. Mint one first (DEPLOY.md, "Bootstrap").`);
}

async function call(method, url, body, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) {
    // runQuery reports errors as a one-element array; everything else as an object.
    const e = Array.isArray(data) ? data[0] : data;
    const why = (e && e.error && e.error.message) || text.slice(0, 200);
    const err = new Error(`Firestore ${res.status}: ${why}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Newest first. A status filter is an equality query sorted here, the same
 *  as the site, so no composite index is needed. */
async function list({ status = 'new', limit = inbox.LIST_LIMIT } = {}, fetchImpl) {
  const s = inbox.normaliseStatus(status);
  const query = { from: [{ collectionId: inbox.COLLECTION }], limit: s ? 1000 : limit };
  if (s) {
    query.where = { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: s } } };
  } else {
    query.orderBy = [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }];
  }
  const rows = await call('POST', `${BASE}:runQuery`, { structuredQuery: query }, fetchImpl);
  return (rows || [])
    .filter((r) => r && r.document)
    .map((r) => fromDocument(r.document))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, limit);
}

async function note(id, { status, note: text } = {}, fetchImpl) {
  const key = String(id || '');
  if (!/^[a-z0-9]{8,40}$/.test(key)) throw new Error('That is not an inbox id.');
  const fields = {};
  if (status !== undefined) {
    const s = inbox.normaliseStatus(status);
    if (!s) throw new Error(`--status must be one of: ${inbox.STATUSES.join(', ')}`);
    fields.status = s;
  }
  if (text !== undefined) fields.claudeNote = inbox.cleanText(text, inbox.MAX_NOTE);
  if (!Object.keys(fields).length) throw new Error('Give --status and/or --note.');
  fields.updatedAt = new Date().toISOString();
  const mask = Object.keys(fields).map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  // currentDocument.exists=true: a typo in the id is an error, not a new
  // half-empty document.
  const url = `${BASE}/${inbox.COLLECTION}/${encodeURIComponent(key)}?${mask}&currentDocument.exists=true`;
  const body = { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toValue(v)])) };
  const doc = await call('PATCH', url, body, fetchImpl);
  return fromDocument(doc);
}

/* ---------- the command line ---------- */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

function show(item) {
  const lines = [`${item.id}  [${item.status}] ${item.kind} · ${item.source} · ${item.createdAt}`];
  lines.push(...item.text.split('\n').map((l) => `    ${l}`));
  if (item.tags.length) lines.push(`    tags: ${item.tags.map((t) => `#${t}`).join(' ')}`);
  if (item.claudeNote) lines.push(`    claude: ${item.claudeNote.replace(/\n/g, ' ')}`);
  return lines.join('\n');
}

const USAGE = `usage:
  node scripts/inbox.js list [--status new|seen|doing|done|parked|all] [--json]
  node scripts/inbox.js note <id> [--status seen|doing|done|parked] [--note "..."] [--json]`;

async function main(argv) {
  const args = parseArgs(argv);
  const [cmd, id] = args._;
  if (cmd === 'list') {
    const items = await list({ status: typeof args.status === 'string' ? args.status : 'new' });
    if (args.json) return console.log(JSON.stringify(items, null, 2));
    const asked = typeof args.status === 'string' ? args.status : 'new';
    if (!items.length) return console.log(asked === 'all' ? 'The inbox is empty.' : `Nothing marked ${asked} in the inbox.`);
    return console.log(items.map(show).join('\n\n'));
  }
  if (cmd === 'note') {
    const item = await note(id, {
      status: typeof args.status === 'string' ? args.status : undefined,
      note: typeof args.note === 'string' ? args.note : undefined,
    });
    return console.log(args.json ? JSON.stringify(item, null, 2) : show(item));
  }
  console.error(USAGE);
  process.exitCode = 2;
  return undefined;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { list, note, fromDocument, fromFields, toValue, parseArgs, BASE };
