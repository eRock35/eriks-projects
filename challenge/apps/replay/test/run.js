// Pure rules first (reading JSON Lines, JSON and CSV, nested keys, shapes,
// the field guess, every check with planted cases, the hash chain checked
// with node:crypto against the core's own canonical form, the replay pack,
// the sample, the exports, settings and the AI helper's checks), then the
// demo, then hostile files, then the worker in a real worker thread (with
// SubtleCrypto - it must agree with node:crypto), then the page's own
// promises, then end to end against the memory store and the fake model:
//   REPLAY_MEMORY=1 REPLAY_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /replay, the way
// the lab mounts it, so the auth cookie, the budget gate and each route's
// parser order are exercised as deployed. Model calls are counted from the
// identity usage rows, and what reached "the model" is read from the fake's
// own log.
//
// Every lender, case id, business and number here is made up; addresses are
// built with AT so no file carries one.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const express = require('express');

if (process.env.REPLAY_MEMORY !== '1' || process.env.REPLAY_FAKE_AI !== '1') {
  console.error('run with REPLAY_MEMORY=1 REPLAY_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, ownerTag } = require('../server');
const C = require('../public/replay-core');
const D = require('../public/demo');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const ch = (n) => String.fromCharCode(n);
const RLO = ch(0x202E), ZWSP = ch(0x200B);

/* ---------------- helpers ---------------- */

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const digest = (s) => Promise.resolve(sha(s));
const engine = () => C.createEngine({ digest });
/** Load text, map it (the guess, or a map), analyze; the report and the engine. */
async function check(text, opts = {}) {
  const e = engine();
  const meta = e.load({ id: 'f', name: opts.name || 'log.jsonl', text });
  const map = Object.assign({}, meta.guess.map, opts.map || {});
  const rep = await e.analyze({ id: 'f', map, settings: Object.assign(C.defaults(), opts.settings || {}), changeLog: opts.changeLog || '' });
  return { e, meta, rep, map };
}
const keys = (rep) => rep.findings.map((f) => f.key);
const find = (rep, k) => rep.findings.find((f) => f.key === k);
const jsonl = (recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
/** A decision, complete under the default profile. */
function dec(i, extra) {
  return Object.assign({
    id: 'T-' + String(i + 1).padStart(4, '0'),
    ts: new Date(Date.UTC(2026, 9, 5, 9, 0, 0) + i * 600000).toISOString(),
    model: { id: 'scorer', version: '1.0' },
    prompt: { id: 'memo', version: 'p1' },
    params: { temperature: 0, seed: 7 },
    inputs_hash: sha('in' + i),
    decision: i % 4 === 0 ? 'decline' : 'approve',
    reasons: i % 4 === 0 ? ['R1'] : [],
  }, extra || {});
}
/** Records chained with the core's recipe (canonical, previous hash first). */
function chain(recs, opts = {}) {
  let prev = '0'.repeat(64);
  return recs.map((r) => {
    const rec = Object.assign({}, r, { prev_hash: prev });
    const body = opts.raw ? JSON.stringify(rec) : C.canon(rec);
    const h = sha((opts.noPrev ? '' : prev + '\n') + body);
    prev = h;
    if (opts.raw) return body.slice(0, -1) + ',"hash":"' + h + '"}';
    return Object.assign(rec, { hash: opts.b64 ? Buffer.from(h, 'hex').toString('base64') : opts.prefix ? 'sha256:' + h.toUpperCase() : h });
  });
}

/* ================================================================== *
 * Reading
 * ================================================================== */

test('reading: JSON Lines (blank lines, CRLF, unreadable and non-object lines named), a JSON array, records wrapped in an object, CSV with quotes and its delimiter sniffed, a byte-order mark, UTF-16, files that are not text', () => {
  let p = C.parseLog('{"a":1}\r\n\r\n{"a":2}\n{"a":\n[1]\n"x"\n');
  assert.deepStrictEqual([p.format, p.records.length, p.records[1].n, p.blank], ['jsonl', 2, 3, 1]);
  assert.deepStrictEqual(p.unreadable.map((u) => [u.n, /not valid JSON/.test(u.why) || /not an object/.test(u.why)]), [[4, true], [5, true], [6, true]]);
  assert.strictEqual(p.records[0].raw, '{"a":1}', 'the raw line is kept without its line ending');
  p = C.parseLog('[{"a":1},{"a":2},3]');
  assert.deepStrictEqual([p.format, p.records.length, p.unreadable[0].item], ['json', 2, 3]);
  p = C.parseLog('{\n  "exportedBy": "x",\n  "decisions": [{"a":1},{"a":2}]\n}');
  assert.deepStrictEqual([p.format, p.records.length, p.wrapped], ['json', 2, 'decisions']);
  p = C.parseLog('[{"a":1},');
  assert.ok(p.unreadable[0].why.includes('not valid JSON'));
  p = C.parseLog('id;when;why\r\nd1;2026-10-01;"R1;R2"\r\nd2;2026-10-02;R3\r\n');
  assert.deepStrictEqual([p.format, p.delim, p.records.length, p.records[0].obj.why], ['csv', ';', 2, 'R1;R2']);
  p = C.parseLog('a\tb\n1\t2\n');
  assert.strictEqual(p.delim, '\t');
  p = C.parseLog('id,id,note\nx,y,"a, ""quoted""\nline"\nz,w\n');
  assert.deepStrictEqual(p.headers, ['id', 'id (2)', 'note'], 'duplicate headers kept apart');
  assert.strictEqual(p.records[0].obj.note, 'a, "quoted"\nline');
  assert.ok(/a row of 2 cells under a header of 3/.test(p.unreadable[0].why), 'a ragged row is unreadable, not misaligned');
  const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{"a":1}\n')]);
  assert.strictEqual(engine().load({ id: 'x', name: 'b', bytes: bom }).records, 1);
  const u16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('{"a":1}\n', 'utf16le')]);
  const l16 = engine().load({ id: 'y', name: 'c', bytes: u16 });
  assert.deepStrictEqual([l16.encoding, l16.records], ['utf-16le', 1]);
  for (const [b, re] of [[Buffer.from('PK\u0003\u0004rest'), /spreadsheet workbook/], [Buffer.from('%PDF-1.7'), /PDF/], [Buffer.from([0x1F, 0x8B, 8, 0]), /gzip/], [Buffer.from([1, 0, 2, 0, 3]), /not a text file/], [Buffer.from('   \n'), /empty/]]) {
    assert.throws(() => engine().load({ id: 'z', name: 'z', bytes: b }), re);
  }
  assert.throws(() => engine().load({ id: 'z', name: 'z', bytes: Buffer.from('{"a":\n{"b":\n') }), /No record in that file could be read/);
});

test('nested keys become dot paths; a CSV header with a dot is found as it is; own properties only, so __proto__ in a file is just a key', () => {
  const o = JSON.parse('{"model":{"version":"2"},"a.b":1,"a":{"b":2},"__proto__":{"x":1}}');
  assert.deepStrictEqual([C.getPath(o, 'model.version'), C.getPath(o, 'a.b'), C.getPath(o, 'model.missing'), C.getPath(o, '__proto__.x'), C.getPath({}, 'constructor'), C.getPath({}, '__proto__')], ['2', 1, undefined, 1, undefined, undefined]);
  const d = C.discoverKeys(C.parseLog(jsonl([{ id: 'x', model: { id: 'm', version: '1' }, wide: Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['k' + i, i])), list: [{ a: 1 }] }])).records);
  const paths = d.keys.map((k) => k.path);
  assert.deepStrictEqual(paths, ['id', 'model', 'model.id', 'model.version', 'wide', 'list'], 'an object wider than 60 keys is one value (a map keyed by ids would otherwise turn every id into a key)');
  const csv = C.parseLog('decision.id,model.version\nd1,2\n');
  assert.strictEqual(C.getPath(csv.records[0].obj, 'model.version'), '2');
  assert.strictEqual(C.without(o, 'model.version').model.version, undefined);
  assert.strictEqual(o.model.version, '2', 'without() copies - the record itself is untouched');
  assert.ok(Object.prototype.hasOwnProperty.call(C.without(o, 'a.b'), '__proto__'), 'a __proto__ member survives the copy as a member');
  const many = C.discoverKeys(C.parseLog(jsonl(Array.from({ length: 3 }, (_, i) => Object.fromEntries(Array.from({ length: 50 }, (_, k) => ['k' + i + '_' + k, 1]))))).records);
  assert.ok(many.keys.length <= 150 && many.more === 0);
});

test('shapes come from a fixed list of codes with no digits; each describes values without holding one', () => {
  for (const k of C.SHAPE_KEYS) assert.ok(/^[a-z-]+$/.test(k), k);
  const recs = Array.from({ length: 30 }, (_, i) => ({ ts: '2026-10-0' + (1 + (i % 9)) + 'T10:00:00Z', at: 1790000000 + i, out: ['approve', 'decline', 'refer'][i % 3], h: sha('x' + i), v: ['2.4.0', '2.5.0'][i % 2], ok: i % 2 === 0, codes: ['R1', 'R2'], calls: [{ name: 'x' }], t: [0, 0.7][i % 2], who: ['u.alder', 'u.brook'][i % 2], note: 'a much longer sentence of plain words here', id: 'RVT-D-' + String(i).padStart(4, '0'), uuid: crypto.randomUUID ? crypto.randomUUID() : '6f1c2d3e-0000-4000-8000-00000000000' + (i % 10) }));
  const d = C.discoverKeys(C.parseLog(jsonl(recs)).records);
  const sh = (p) => d.keys.find((k) => k.path === p).shapes;
  assert.ok(sh('ts').includes('date-iso'));
  assert.ok(sh('at').includes('date-epoch'));
  assert.ok(sh('out').includes('outcome-words'));
  assert.ok(sh('h').includes('hash-hex') && sh('h').includes('every-different'));
  assert.ok(sh('v').includes('version-like') && sh('v').includes('few-values'));
  assert.ok(sh('id').includes('text-id') && !sh('id').includes('version-like'), 'an id is not a version');
  assert.ok(sh('ok').includes('yes-no'));
  assert.ok(sh('codes').includes('code-list'));
  assert.ok(sh('calls').includes('object-list'));
  assert.ok(sh('t').includes('number-small') || sh('t').includes('number-unit'));
  assert.ok(sh('who').includes('names'));
  assert.ok(sh('note').includes('text-long'));
  for (const k of d.keys) for (const s of k.shapes) assert.ok(C.SHAPES[s], s);
});

test('the field guess: the demo is placed exactly; an awkward nested export and a CSV are placed sensibly; nothing inside the inputs object is offered for another field; a shape alone gives an unsure guess', () => {
  const awkward = Array.from({ length: 40 }, (_, i) => ({
    evt: { uuid: '6f1c2d3e-aaaa-4bbb-8ccc-' + String(i).padStart(12, '0'), at: 1790000000 + i * 600 },
    subject: { applicant_ref: 'A-' + (100 + i) },
    engine: { name: 'fraudscreen', rev: 'v12', llm: { template: 'tmpl', template_sha: sha('t').slice(0, 12), sampling: { temp: 0, rng: 7 } } },
    result: { label: ['APPROVED', 'DENIED'][i % 2], p: 0.5, why: i % 2 ? ['R1'] : [] },
    features: { score: 640 + i, band: 'B', velocity: i % 3 },
    human: { analyst: 'k.ito', overrode: false, note: 'Called the applicant to confirm' },
    audit: { sha: sha('r' + i), parent: sha('r' + (i - 1)) },
  }));
  const g = C.guessFields(C.discoverKeys(C.parseLog(jsonl(awkward)).records).keys);
  const want = { id: 'evt.uuid', time: 'evt.at', case: 'subject.applicant_ref', outcome: 'result.label', model: 'engine.name', modelVersion: 'engine.rev', prompt: 'engine.llm.template', promptVersion: 'engine.llm.template_sha', temperature: 'engine.llm.sampling.temp', inputs: 'features', reasons: 'result.why', reviewer: 'human.analyst', override: 'human.overrode', overrideReason: 'human.note', prevHash: 'audit.parent', hash: 'audit.sha' };
  for (const [f, p] of Object.entries(want)) assert.strictEqual(g.map[f], p, f);
  assert.strictEqual(g.map.score, null, 'the bureau-like score inside the inputs is not the decision score');
  const csv = 'Decision ID,Timestamp (UTC),Applicant,Model Name,Model Ver,Prompt Ver,Temp,Outcome,Reason Codes,Score,Reviewer,Overridden,Override Note,Inputs SHA256\n' +
    Array.from({ length: 20 }, (_, i) => `LND-${1000 + i},2026-10-01T1${i % 10}:00:00Z,C${3000 + i},credit-scorer,3.0.${i % 2},p2,0,${i % 3 ? 'Approved' : 'Declined'},"R02;R09",0.${i + 10},${i % 2 ? 'jordan.k' : ''},${i % 2 ? 'N' : ''},,${sha('c' + i)}`).join('\n') + '\n';
  const gc = C.guessFields(C.discoverKeys(C.parseLog(csv).records).keys);
  for (const [f, p] of Object.entries({ id: 'Decision ID', time: 'Timestamp (UTC)', outcome: 'Outcome', modelVersion: 'Model Ver', promptVersion: 'Prompt Ver', temperature: 'Temp', reasons: 'Reason Codes', score: 'Score', reviewer: 'Reviewer', override: 'Overridden', inputsHash: 'Inputs SHA256' })) assert.strictEqual(gc.map[f], p, f);
  const bare = C.guessFields(C.discoverKeys(C.parseLog(jsonl(Array.from({ length: 12 }, (_, i) => ({ k1: '2026-10-0' + (1 + (i % 9)) + 'T10:00:00Z', k2: ['approve', 'decline'][i % 2] })))).records).keys);
  assert.deepStrictEqual([bare.map.time, bare.conf.time, bare.map.outcome, bare.conf.outcome], ['k1', 'unsure', 'k2', 'unsure']);
  assert.deepStrictEqual(C.cleanMap({ id: 'nope', time: 'k1', hash: 3 }, [{ path: 'k1' }]).time, 'k1');
  assert.strictEqual(C.cleanMap({ id: 'nope' }, [{ path: 'k1' }]).id, null, 'a mapping can only name a key the log has');
});

/* ================================================================== *
 * The checks
 * ================================================================== */

test('completeness against the must-record profile: a field the log lacks is critical; each missing part counted; the replayable share; inputs OR their hash; conditional rules', async () => {
  const recs = Array.from({ length: 20 }, (_, i) => dec(i));
  delete recs[2].model.version;
  delete recs[3].inputs_hash; recs[3].inputs = { a: 1 };
  delete recs[5].inputs_hash;
  recs[6].prompt = { id: 'memo' };
  let { rep } = await check(jsonl(recs));
  const inc = find(rep, 'incomplete');
  assert.deepStrictEqual(inc.extra.parts.map((p) => [p.field, p.count]).sort(), [['inputs', 1], ['modelVersion', 1], ['promptVersion', 1]], 'inputs OR inputs hash: record 4 had the snapshot');
  assert.deepStrictEqual(inc.refs.map((r) => r.id), ['T-0003', 'T-0006', 'T-0007']);
  assert.deepStrictEqual([rep.stats.replayable, rep.stats.records], [17, 20]);
  ({ rep } = await check(jsonl(recs), { settings: { required: ['id', 'time', 'outcome', 'case'] } }));
  const um = find(rep, 'unmapped');
  assert.deepStrictEqual([um.sev, um.extra.field, /case id/.test(um.title)], ['critical', 'case', true]);
  assert.ok(!find(rep, 'incomplete'), 'an unmapped field is reported once, not per record');
  assert.strictEqual(rep.stats.replayable, 0, 'and no record counts as replayable without it');
  const ov = Array.from({ length: 8 }, (_, i) => dec(i, { review: i < 3 ? { by: i ? 'u.ash' : null, override: true, why: i === 2 ? '' : 'docs' } : null }));
  ({ rep } = await check(jsonl(ov), { map: { reviewer: 'review.by', override: 'review.override', overrideReason: 'review.why' }, settings: { when: { reasonsIfAdverse: true, reviewerIfOverride: true, whyIfOverride: true } } }));
  assert.deepStrictEqual(find(rep, 'incomplete').extra.parts.map((p) => [p.field, p.count]).sort(), [['overrideReason', 1], ['reviewer', 1]]);
});

test('adverse outcomes: no reasons (empty or missing), more than the maximum, codes not on the list; adverse outcomes and outcome words are the team\u2019s; outcomes Replay cannot place are named', async () => {
  const recs = Array.from({ length: 12 }, (_, i) => dec(i));
  recs[0].reasons = [];
  delete recs[4].reasons;
  recs[8].reasons = ['R1', 'R2', 'R3', 'R4', 'R5'];
  recs[1].reasons = ['ZZ9'];
  recs[2].decision = 'flag'; recs[2].reasons = [];
  const codes = ['R1', 'R2', 'R3', 'R4', 'R5'].map((c) => ({ code: c, text: 'Reason ' + c.toLowerCase() }));
  let { rep } = await check(jsonl(recs), { settings: { codes } });
  assert.deepStrictEqual(find(rep, 'adverse-none').refs.map((r) => r.id), ['T-0001', 'T-0005']);
  assert.strictEqual(find(rep, 'adverse-none').sev, 'critical');
  assert.deepStrictEqual(find(rep, 'adverse-many').refs.map((r) => r.id), ['T-0009']);
  assert.deepStrictEqual(find(rep, 'adverse-unknown').extra.codes, [{ code: 'ZZ9', count: 1 }], 'a code on an approve is checked too - it still needs words');
  ({ rep } = await check(jsonl(recs), { settings: { codes, adverse: ['decline', 'flag'], maxReasons: 5 } }));
  assert.deepStrictEqual(find(rep, 'adverse-none').refs.map((r) => r.id), ['T-0001', 'T-0003', 'T-0005']);
  assert.ok(!find(rep, 'adverse-many'));
  ({ rep } = await check(jsonl(recs)));
  assert.ok(find(rep, 'codes-nolist') && !find(rep, 'adverse-unknown'), 'with no list, the page says to add one');
  const odd = Array.from({ length: 6 }, (_, i) => dec(i, { decision: i % 2 ? 'APRV' : 'DCLN', reasons: [] }));
  ({ rep } = await check(jsonl(odd), { map: { outcome: 'decision' } }));
  assert.deepStrictEqual(find(rep, 'outcome-unknown').extra.values.map((v) => v.value).sort(), ['APRV', 'DCLN']);
  ({ rep } = await check(jsonl(odd), { map: { outcome: 'decision' }, settings: { words: [{ word: 'aprv', outcome: 'approve' }, { word: 'dcln', outcome: 'decline' }] } }));
  assert.ok(!find(rep, 'outcome-unknown'));
  assert.strictEqual(find(rep, 'adverse-none').count, 3, 'the team\u2019s own word for decline makes it adverse');
  for (const [w, o] of [['Denied', 'decline'], ['MANUAL REVIEW', 'refer'], ['fraud hold', 'other'], ['HOLD', 'flag'], ['approved', 'approve']]) assert.strictEqual(C.outcomeOf(w), o, w);
});

test('determinism: temperature above 0 against a temperature-0 policy, a seed when one is required; the same inputs giving different outcomes - under the same versions (high), explained by a version change or an override (medium)', async () => {
  const recs = Array.from({ length: 20 }, (_, i) => dec(i, { params: { temperature: i === 3 || i === 7 ? 0.7 : 0, seed: i === 5 ? null : 7 } }));
  recs[10].inputs_hash = recs[11].inputs_hash; recs[10].decision = 'refer'; recs[10].reasons = ['R1'];
  let { rep } = await check(jsonl(recs));
  const t = find(rep, 'temperature');
  assert.deepStrictEqual([t.sev, t.refs.map((r) => r.id), /\(10%\)/.test(t.title)], ['high', ['T-0004', 'T-0008'], true]);
  assert.ok(!find(rep, 'seed'));
  const same = find(rep, 'same-inputs');
  assert.deepStrictEqual([same.sev, same.refs.map((r) => r.id).sort(), same.extra.groups[0].same], ['high', ['T-0011', 'T-0012'], true]);
  ({ rep } = await check(jsonl(recs), { settings: { determinism: { temperatureZero: false, seed: true } } }));
  assert.ok(!find(rep, 'temperature'));
  assert.deepStrictEqual(find(rep, 'seed').refs.map((r) => r.id), ['T-0006']);
  recs[10].model = { id: 'scorer', version: '1.1' };
  ({ rep } = await check(jsonl(recs)));
  assert.deepStrictEqual([find(rep, 'same-inputs').sev, find(rep, 'same-inputs').extra.groups[0].same], ['medium', false], 'a version change explains it');
  const snap = Array.from({ length: 6 }, (_, i) => { const r = dec(i, { inputs: { a: i % 3, b: 'x' }, decision: 'approve', reasons: [] }); delete r.inputs_hash; return r; });
  snap[3].decision = 'decline'; snap[3].reasons = ['R1'];
  ({ rep } = await check(jsonl(snap)));
  assert.deepStrictEqual(find(rep, 'same-inputs').refs.map((r) => r.id).sort(), ['T-0001', 'T-0004'], 'without a hash, the canonical snapshot is compared');
});

test('version drift against a pasted change log: versions and when they changed; a version with no entry; one used before its approval; an entry with no approver; no change log is said plainly', async () => {
  const recs = Array.from({ length: 30 }, (_, i) => dec(i, { model: { id: 'scorer', version: i < 10 ? '1.0' : '1.1' }, prompt: { id: 'memo', version: i < 20 ? 'p1' : 'p2' } }));
  let { rep } = await check(jsonl(recs));
  assert.deepStrictEqual(rep.drift.map((k) => [k.kind, k.versions.map((v) => v.label + ':' + v.count), k.changes.length]), [['model', ['1.0:10', '1.1:20'], 1], ['prompt', ['p1:20', 'p2:10'], 1]]);
  assert.strictEqual(find(rep, 'drift-nolog').sev, 'info');
  const log = '2026-09-30, scorer 1.0, Model Risk Committee\n2026-10-06, scorer 1.1, Model Risk Committee\n2026-09-30, memo p1,\nnot a line\n2026-13-40, x, y';
  ({ rep } = await check(jsonl(recs), { changeLog: log }));
  const un = find(rep, 'drift-unlogged');
  assert.deepStrictEqual([un.sev, un.extra.versions.map((v) => v.label)], ['high', ['p2']]);
  assert.match(un.detail, /Prompt version p2 first decided on Mon 5 Oct 2026, in T-0021/);
  const early = find(rep, 'drift-early');
  assert.match(early.detail, /Model version 1\.1 first decided on Mon 5 Oct 2026, but the change log approves it on 2026-10-06/);
  assert.strictEqual(find(rep, 'drift-noapprover').detail, 'Lines 3 of the change log name no approver.');
  assert.deepStrictEqual(rep.changeLog, { entries: 3, errors: ['Line 4: write it as date, version, approver.', 'Line 5: the date is not one Replay can read - use 2026-10-21.'] });
  assert.ok(C.versionMatches('sb-credit-memo 3.1', '3.1') && !C.versionMatches('sb-credit-memo 3.1', '3.2') && !C.versionMatches('model 13.1', '3.1') && C.versionMatches('v2.5.0', '2.5.0'));
  const ab = Array.from({ length: 20 }, (_, i) => dec(i, { model: { id: 'scorer', version: i % 2 ? 'A' : 'B' } }));
  ({ rep } = await check(jsonl(ab)));
  assert.strictEqual(rep.drift[0].mixed, true, 'two versions side by side (a canary) is told apart from a change');
});

test('the hash chain: SHA-256 (node:crypto here) over the previous hash, a line feed and the canonical record - every record verified; an edit, a removal and a swap each named, with the first broken link', async () => {
  const base = Array.from({ length: 30 }, (_, i) => dec(i));
  const good = chain(base);
  let { rep } = await check(jsonl(good));
  assert.deepStrictEqual([rep.chain.hashed, rep.chain.verified, rep.chain.changed, rep.chain.unlinked], [30, 30, 0, 0]);
  assert.ok(!keys(rep).some((k) => /^chain/.test(k)));
  // the recipe, recomputed by hand for one record
  const r5 = good[5];
  const { hash: h5, ...body } = r5;
  assert.strictEqual(sha(r5.prev_hash + '\n' + C.canon(body)), h5);
  assert.strictEqual(C.canon({ b: 1, a: [1, 'x', { d: null, c: true }], é: 2, n: -0, u: undefined }), '{"a":[1,"x",{"c":true,"d":null}],"b":1,"n":0,"é":2}', 'keys sorted, no spaces, undefined left out, -0 as 0');
  // an edit after writing
  const edited = good.map((r) => Object.assign({}, r));
  edited[11] = Object.assign({}, edited[11], { decision: 'refer' });
  ({ rep } = await check(jsonl(edited)));
  const c = find(rep, 'chain-changed');
  assert.deepStrictEqual([c.sev, c.count, c.extra.first.id, c.extra.stored, c.extra.computed === c.extra.stored], ['critical', 1, 'T-0012', good[11].hash, false]);
  assert.match(c.detail, /The first broken link is T-0012 \(line 12\).*11 records before it check out, and the chain picks up again at the next record/);
  // a record removed
  const removed = good.filter((_, i) => i !== 7);
  ({ rep } = await check(jsonl(removed)));
  const u = find(rep, 'chain-unlinked');
  assert.deepStrictEqual([u.count, u.extra.first.id, u.extra.kinds], [1, 'T-0009', { missing: 1, reordered: 0 }]);
  assert.ok(!find(rep, 'chain-changed'), 'every remaining record is still what was written');
  // two swapped
  const swapped = good.slice(); [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  ({ rep } = await check(jsonl(swapped)));
  assert.strictEqual(find(rep, 'chain-unlinked').extra.kinds.reordered >= 1, true);
  // no hash on some, one in a form Replay cannot read, base64 and sha256: prefixed forms read
  const partial = good.map((r) => Object.assign({}, r));
  delete partial[20].hash; partial[21].hash = 'not-a-hash';
  ({ rep } = await check(jsonl(partial)));
  assert.deepStrictEqual([find(rep, 'chain-partial').count, find(rep, 'chain-format').count], [1, 1]);
  for (const opt of [{ b64: true }, { prefix: true }]) {
    const alt = chain(base, opt);
    ({ rep } = await check(jsonl(alt)));
    assert.strictEqual(rep.chain.verified, 30, JSON.stringify(opt));
  }
});

test('the hash chain, other recipes: the raw line (with the hash member cut out as text), no previous hash in the input, a recipe that does not match (never called tampering), a nested hash with the raw recipe, CSV raw cells, a JSON array', async () => {
  const base = Array.from({ length: 12 }, (_, i) => dec(i));
  const rawLines = chain(base, { raw: true });
  let { rep } = await check(rawLines.join('\n') + '\n', { settings: { canon: 'raw' } });
  assert.strictEqual(rep.chain.verified, 12, 'the raw-line recipe verifies a writer that hashed the text it wrote');
  ({ rep } = await check(rawLines.join('\n') + '\n'));
  const sch = find(rep, 'chain-scheme');
  assert.deepStrictEqual([sch.sev, /That is almost never tampering/.test(sch.detail), rep.chain.scheme], ['high', true, false]);
  assert.ok(!find(rep, 'chain-changed'), 'a recipe mismatch is not reported as twelve edits');
  const noPrev = chain(base, { noPrev: true });
  ({ rep } = await check(jsonl(noPrev), { settings: { prevInInput: false } }));
  assert.strictEqual(rep.chain.verified, 12);
  assert.strictEqual(C.removeMember('{"a":1, "hash":"x"}', 'hash'), '{"a":1}');
  assert.strictEqual(C.removeMember('{"hash":"x", "a":1}', 'hash'), '{"a":1}');
  assert.strictEqual(C.removeMember('{"hash":"x"}', 'hash'), '{}');
  assert.strictEqual(C.removeMember('{"a":{"hash":1},"b":"h,\\"x","hash":"z","c":[1,{"hash":2}]}', 'hash'), '{"a":{"hash":1},"b":"h,\\"x","c":[1,{"hash":2}]}', 'only the top-level member, never one inside a string or a nested object');
  assert.strictEqual(C.removeMember('{"a":1}', 'hash'), null);
  const nested = Array.from({ length: 6 }, (_, i) => dec(i, { audit: { hash: sha('n' + i) } }));
  ({ rep } = await check(jsonl(nested), { map: { hash: 'audit.hash' }, settings: { canon: 'raw' } }));
  assert.match(find(rep, 'chain-scheme').title, /cannot be checked with the raw-line recipe/);
  // CSV, raw: the line without the hash cell
  let prev = '0'.repeat(64);
  const rows = ['id,ts,decision,prev_hash,hash'];
  for (let i = 0; i < 6; i++) { const line = `C-${i},2026-10-01T1${i}:00:00Z,approve,${prev}`; const h = sha(prev + '\n' + line); rows.push(line + ',' + h); prev = h; }
  ({ rep } = await check(rows.join('\n') + '\n', { name: 'x.csv', settings: { canon: 'raw' } }));
  assert.strictEqual(rep.chain.verified, 6, 'a CSV row, raw, without its hash cell');
  assert.strictEqual(C.removeCell('a,"b,c",d', ['x', 'y', 'z'], 'y', ','), 'a,d');
  // a JSON array: no lines, so canonical, said so
  const arr = JSON.stringify(chain(base));
  ({ rep } = await check(arr, { settings: { canon: 'raw' } }));
  assert.deepStrictEqual([rep.chain.verified, /no lines/.test(rep.chain.note)], [12, true]);
  // no hashes at all: said plainly, with the recipe to add them
  ({ rep } = await check(jsonl(base)));
  assert.match(find(rep, 'chain-none').detail, /How to add one is under/);
});

test('the snippet on the page is a real writer: records it writes verify with Replay\u2019s recipe', async () => {
  const sandbox = { require, Buffer, out: [] };
  vm.runInNewContext(C.HASH_SNIPPET + '\nfor (let i = 0; i < 5; i++) out.push(writeDecision({ id: "S" + i, decision: "approve", nested: { b: 2, a: 1 } }));', sandbox);
  const { rep } = await check(sandbox.out.join(''), { map: { id: 'id', hash: 'hash', prevHash: 'prev_hash' } });
  assert.deepStrictEqual([rep.chain.hashed, rep.chain.verified], [5, 5]);
});

test('gaps, duplicates and order: numbered ids with numbers missing, one id on two records, records dated before the one above; a newest-first file is not out of order', async () => {
  const recs = Array.from({ length: 40 }, (_, i) => dec(i)).filter((_, i) => i !== 12 && i !== 13);
  recs.push(Object.assign({}, recs[5]));
  recs[20] = Object.assign({}, recs[20], { ts: '2026-10-05T08:00:00.000Z' });
  const { rep } = await check(jsonl(recs));
  const g = find(rep, 'seq-gap');
  assert.deepStrictEqual([g.sev, g.extra.ranges, /T-0013–T-0014/.test(g.detail)], ['high', [[13, 14]], true]);
  assert.deepStrictEqual(find(rep, 'dup-id').refs.map((r) => r.id), ['T-0006', 'T-0006']);
  assert.ok(find(rep, 'order').refs.some((r) => r.id === 'T-0023'));
  const rev = Array.from({ length: 30 }, (_, i) => dec(i)).reverse();
  const r2 = (await check(jsonl(rev))).rep;
  assert.ok(!find(r2, 'order'), 'a whole file newest first is a choice, not a problem');
  const random = Array.from({ length: 30 }, (_, i) => dec(i, { id: 'X' + (i * 7919 % 100000) }));
  assert.ok(!find((await check(jsonl(random))).rep, 'seq-gap'), 'ids that are not a dense sequence are not read as one');
});

test('overrides: by reviewer and by outcome; an override with no reviewer, with no reason (or no field for one); a reviewer overriding far more than the rest', async () => {
  // 40 reviewed, 10 each: u.ash overrides 5, the others 1 each; one override nobody owns, one with no reason
  const who = ['u.ash', 'u.birch', 'u.cedar', 'u.dale'], seen = { 'u.ash': 0, 'u.birch': 0, 'u.cedar': 0, 'u.dale': 0 };
  const recs = Array.from({ length: 80 }, (_, i) => {
    if (i % 2 === 0) return dec(i, { review: null });
    const by = who[(i >> 1) % 4], n = seen[by]++;
    const override = by === 'u.ash' ? n < 5 : n === 0;
    return dec(i, { review: { by, override, why: override ? 'docs' : '' } });
  });
  recs[79].review = { by: null, override: true, why: 'docs' };
  recs[3].review.why = '';
  const { rep } = await check(jsonl(recs), { map: { reviewer: 'review.by', override: 'review.override', overrideReason: 'review.why' } });
  assert.deepStrictEqual(find(rep, 'override-noreviewer').refs.map((r) => r.id), ['T-0080']);
  assert.deepStrictEqual(find(rep, 'override-noreason').refs.map((r) => r.id), ['T-0004']);
  const o = rep.overrides;
  assert.deepStrictEqual([o.total, o.byReviewer[0].who, o.byReviewer[0].overrides], [9, 'u.ash', 5]);
  assert.ok(o.byReviewer.some((x) => x.none && x.overrides === 1), 'the overrides nobody owns are a row of their own');
  assert.ok(find(rep, 'override-rate') && /^u\.ash overrode 5 of 10 \(50%\), against 21% for everyone/.test(find(rep, 'override-rate').detail), find(rep, 'override-rate') && find(rep, 'override-rate').detail);
  const r2 = (await check(jsonl(recs), { map: { reviewer: 'review.by', override: 'review.override', overrideReason: null } })).rep;
  assert.match(find(r2, 'override-noreason').detail, /no field for why/);
});

test('time gaps: a quiet stretch at a normally busy hour is found with how many were expected; nights, weekends and short logs are not flagged', async () => {
  const recs = [];
  let i = 0;
  for (let day = 1; day <= 30; day++) {
    const dow = new Date(Date.UTC(2026, 9, day)).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (let m = 8 * 60 + 10; m < 18 * 60; m += 30) {
      if (day === 14 && m >= 11 * 60 && m < 14 * 60) continue;
      recs.push(dec(i++, { ts: new Date(Date.UTC(2026, 9, day, Math.floor(m / 60) + 5, m % 60)).toISOString().replace('.000Z', '-00:00').replace(/T(\d\d)/, (x, h) => 'T' + String(+h - 5).padStart(2, '0')).replace('-00:00', '-05:00') }));
    }
  }
  const { rep } = await check(jsonl(recs));
  const g = find(rep, 'gap');
  assert.strictEqual(g.extra.gaps.length, 1, 'one stretch, and no night or weekend');
  assert.deepStrictEqual([g.extra.gaps[0].day, g.extra.gaps[0].whenText, g.extra.gaps[0].expected >= 5], ['2026-10-14', 'Wed 14 Oct 2026, 10:40–14:10', true]);
  assert.match(g.detail, /\(UTC−05:00\)/);
  assert.ok(rep.days.length >= 29 && rep.days.find((d) => d.day === '2026-10-14').count < rep.days.find((d) => d.day === '2026-10-13').count);
  const short = (await check(jsonl(recs.slice(0, 30)))).rep;
  assert.ok(!find(short, 'gap'), 'too little history to know what busy looks like');
  const batch = recs.map((r) => Object.assign({}, r, { ts: r.ts.slice(0, 11) + '02:00:00-05:00' }));
  const b = (await check(jsonl(batch))).rep;
  assert.deepStrictEqual([find(b, 'gap'), b.batched], [undefined, true], 'a log written in nightly batches is quiet between them by design');
});

/* ================================================================== *
 * The replay pack, the sample, the exports
 * ================================================================== */

test('the replay pack: what went in, the versions, the reasons in words (and a code nobody can explain), who reviewed, the chain proof, and what is missing to replay it', async () => {
  const recs = Array.from({ length: 12 }, (_, i) => dec(i, { case_id: 'APP-' + (1000 + i), inputs: { business: { industry: 'Bakery' }, amount: 50000 }, tool_calls: [{ name: 'bureau_pull', status: 'ok', ms: 380 }], review: i === 4 ? { reviewer: 'u.ash', override: true, reason: 'Owner letter on file' } : null }));
  recs[8].reasons = ['R1', 'Q7'];
  recs[8].params.temperature = 0.4;
  const chained = chain(recs);
  chained[8] = Object.assign({}, chained[8], { note: 'added later' });
  const codes = [{ code: 'R1', text: 'Cash flow does not cover the payment' }];
  const { e, rep } = await check(jsonl(chained), { settings: { codes } });
  const p = e.pack({ id: 'f', i: 8 });
  assert.deepStrictEqual([p.id, p.outcome, p.adverse, p.modelVersion, p.promptVersion, p.temperature, p.case], ['T-0009', 'decline', true, '1.0', 'p1', 0.4, 'APP-1008']);
  assert.deepStrictEqual(p.reasons, [{ code: 'R1', text: 'Cash flow does not cover the payment', known: true }, { code: 'Q7', text: '', known: false }]);
  assert.deepStrictEqual(p.missing.map((m) => m.field), ['temperature', 'reasons', 'hash']);
  assert.match(p.missing[0].why, /temperature 0\.4/);
  assert.deepStrictEqual([p.chain.status, p.chain.linked, p.replayable], ['changed', 'ok', false]);
  assert.match(p.answer, /^Declined on Mon 5 Oct 2026 by scorer 1\.0\. The reasons recorded: Cash flow does not cover the payment; Q7\.$/);
  const ok = e.pack({ id: 'f', i: 4 });
  assert.deepStrictEqual([ok.missing, ok.replayable, ok.chain.status, ok.reviewer, ok.override], [[], true, 'ok', 'u.ash', true]);
  assert.match(ok.answer, /A person overrode the model \(u\.ash\): Owner letter on file\./);
  const md = C.packMarkdown(p, {});
  assert.ok(md.includes('A•••08') && !md.includes('APP-1008'), 'the case id is masked by default');
  assert.ok(md.includes('Cash flow does not cover the payment') && md.includes('(not on the reason-code list)') && md.includes('"industry": "Bakery"') && md.includes('## What is missing to replay this'));
  assert.ok(md.includes('Hash Replay computed: `' + p.chain.computed + '`'));
  assert.ok(!C.packMarkdown(p, { inputs: false }).includes('Bakery') && C.packMarkdown(p, { mask: false }).includes('APP-1008'));
  const js = JSON.parse(C.packJson(p, {}));
  assert.deepStrictEqual([js.decision.case, js.decision.caseMasked, js.proof.verified, js.inputs.snapshot.amount, js.missingToReplay.length], ['A•••08', true, false, 50000, 3]);
  assert.strictEqual(JSON.parse(C.packJson(p, { inputs: false })).inputs.snapshot, undefined);
  assert.ok(rep.findings.length);
  assert.deepStrictEqual(e.find({ id: 'f', q: 'app-1003' }).map((r) => r.id), ['T-0004']);
  assert.deepStrictEqual(e.find({ id: 'f', q: '0005' }).map((r) => r.id), ['T-0005']);
  assert.deepStrictEqual(e.find({ id: 'f', q: '' }), []);
});

test('the sample: the same seed gives the same sample, a new seed another; every outcome and version is in it when there is room; proportional otherwise; the CSV is masked and formula-safe', async () => {
  const recs = Array.from({ length: 200 }, (_, i) => dec(i, { case_id: i === 0 ? '=HYPERLINK("x")' : 'CASE-' + i, model: { id: 'scorer', version: i < 150 ? '1.0' : '1.1' }, decision: ['approve', 'approve', 'approve', 'decline', 'refer'][i % 5], reasons: ['R1'] }));
  const { e } = await check(jsonl(recs));
  const a = e.sample({ id: 'f', n: 20, seed: 'cedar-41', by: ['outcome', 'modelVersion'] });
  const b = e.sample({ id: 'f', n: 20, seed: 'cedar-41', by: ['outcome', 'modelVersion'] });
  const c = e.sample({ id: 'f', n: 20, seed: 'maple-12', by: ['outcome', 'modelVersion'] });
  assert.deepStrictEqual(a.picks.map((p) => p.id), b.picks.map((p) => p.id));
  assert.notDeepStrictEqual(a.picks.map((p) => p.id), c.picks.map((p) => p.id));
  assert.strictEqual(a.n, 20);
  assert.deepStrictEqual(a.strata.map((s) => s.key), ['Approve · 1.0', 'Approve · 1.1', 'Decline · 1.0', 'Decline · 1.1', 'Refer · 1.0', 'Refer · 1.1']);
  assert.ok(a.strata.every((s) => s.take >= 1), 'every group is in it');
  assert.strictEqual(a.strata.find((s) => s.key === 'Approve · 1.0').take, 9, 'and the rest is proportional');
  assert.strictEqual(new Set(a.picks.map((p) => p.id)).size, 20, 'no decision twice');
  assert.strictEqual(e.sample({ id: 'f', n: 999, seed: 'x' }).n, 200);
  const csv = C.sampleCsv(e.sample({ id: 'f', n: 200, seed: 'x' }), {});
  assert.ok(csv.startsWith('# Replay sample: seed x, 200 of 200, by outcome and modelVersion\r\ndecision_id,case_id,time,outcome,model_version,prompt_version,stratum,line\r\n'));
  assert.ok(!/CASE-1\d\d,/.test(csv) && !csv.includes('HYPERLINK("x")'), 'case ids masked');
  const unmasked = C.sampleCsv(e.sample({ id: 'f', n: 200, seed: 'x' }), { mask: false });
  assert.ok(unmasked.includes('"\'=HYPERLINK(""x"")"'), 'a cell that would run as a formula gets an apostrophe');
});

test('exports: the findings report is Markdown-escaped and masks case ids by default; the flagged-records CSV lists every record behind every finding, formula-safe', async () => {
  const recs = Array.from({ length: 10 }, (_, i) => dec(i, { case_id: i === 0 ? '@SUM(A1)' : 'APP-' + (5000 + i), id: i === 0 ? '=cmd|calc' : 'T-' + i }));
  recs[0].reasons = []; recs[4].reasons = [];
  recs[2].id = 'T-<b>2</b>|x';
  recs[2].reasons = ['R1'];
  const { e, rep } = await check(jsonl(recs));
  const md = C.reportMarkdown(rep, { name: 'my_log*.jsonl', stamp: 'today' });
  assert.ok(md.startsWith('# Replay findings: my\\_log\\*.jsonl\n'));
  assert.ok(md.includes('A starting checklist, not legal advice.'));
  assert.ok(!/APP-500\d/.test(md) && md.includes('A•••04'), 'masked');
  assert.ok(C.reportMarkdown(rep, { mask: false }).includes('APP-5004'));
  assert.ok(!/<b>/.test(md), 'markup escaped');
  const csv = e.flagged({ id: 'f' });
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines[0], 'severity,finding,decision_id,case_id,time,outcome,line');
  assert.ok(lines.some((l) => l.startsWith('Critical,2 adverse outcomes with no reasons,\'=cmd|calc,')), 'a formula-looking id is defused');
  assert.ok(!csv.includes('@SUM'), 'and the case id is masked');
  assert.strictEqual(C.csvCell('a,b'), '"a,b"');
  assert.strictEqual(C.formulaSafe('+1'), "'+1");
  assert.strictEqual(C.mdEsc('# a|b'), '\\# a\\|b');
});

/* ================================================================== *
 * The demo
 * ================================================================== */

test('the demo: 400 made-up decisions, hash-chained, producing exactly the planted findings - and nothing else', async () => {
  const d = await D.build(digest);
  const d2 = await D.build(digest);
  assert.strictEqual(d.text, d2.text, 'the same on every run');
  const e = engine();
  const meta = e.load({ id: 'demo', name: d.name, text: d.text });
  assert.strictEqual(meta.records, 400);
  assert.deepStrictEqual(meta.guess.map, Object.assign(Object.fromEntries(C.FIELDS.map((f) => [f, null])), D.MAP), 'every field guessed right');
  const rep = await e.analyze({ id: 'demo', map: D.MAP, settings: D.settings(), changeLog: D.CHANGE_LOG });
  assert.deepStrictEqual(keys(rep).sort(), D.PLANTED.slice().sort());
  const f = (k) => find(rep, k);
  assert.deepStrictEqual([f('chain-changed').count, f('chain-changed').extra.first.id], [1, 'RVT-D-0212']);
  assert.deepStrictEqual([rep.chain.hashed, rep.chain.verified], [400, 399]);
  assert.strictEqual(f('adverse-none').count, 11);
  assert.deepStrictEqual(f('drift-unlogged').extra.versions.map((v) => [v.kind, v.label]), [['prompt', '3.2']]);
  assert.match(f('drift-unlogged').detail, /first decided on Wed 14 Oct 2026/);
  assert.deepStrictEqual([f('temperature').count, /\(3%\)/.test(f('temperature').title)], [12, true]);
  assert.strictEqual(f('override-noreviewer').count, 4);
  assert.deepStrictEqual([f('same-inputs').sev, f('same-inputs').refs.map((r) => r.id)], ['high', ['RVT-D-0318', 'RVT-D-0352']]);
  const gap = f('gap').extra.gaps;
  assert.deepStrictEqual([gap.length, gap[0].whenText, gap[0].minutes >= 115 && gap[0].minutes <= 130], [1, 'Tue 20 Oct 2026, 10:03–12:05', true]);
  assert.deepStrictEqual(f('incomplete').extra.parts.map((p) => [p.field, p.count]), [['reasons', 11], ['reviewer', 4]]);
  assert.deepStrictEqual([rep.stats.records, rep.stats.replayable, rep.stats.period], [400, 373, '1 Oct – 30 Oct 2026']);
  const pl = d.planted;
  const all = [pl.hot, [pl.edited], pl.twins, pl.bare, pl.faceless];
  const flat = [].concat(...all);
  assert.strictEqual(new Set(flat).size, flat.length, 'the planted sets do not overlap, so each number means one thing');
  const p = e.pack({ id: 'demo', i: pl.edited });
  assert.deepStrictEqual([p.outcome, p.chain.status, p.reasons.map((r) => r.code)], ['approve', 'changed', ['R02', 'R09']], 'the edit: a decline that now reads approve');
  const bare = e.pack({ id: 'demo', i: pl.bare[0] });
  assert.match(bare.answer, /The log records no reasons for it\./);
});

test('the demo is unmistakably made up: a made-up lender, pseudonymous case ids, no real lender, bureau, fintech or model maker; said so in the file and on the page', () => {
  const src = read('public/demo.js');
  assert.match(src, /a MADE-UP lender/);
  assert.strictEqual(D.LENDER, 'Riverton Small Business Lending');
  const all = src + read('public/app.js') + read('public/index.html');
  const real = ['Chase', 'Wells Fargo', 'Bank of America', 'Citibank', 'Citi', 'Capital One', 'American Express', 'Amex', 'Discover', 'Goldman', 'Marcus', 'Morgan Stanley', 'PNC', 'Truist', 'US Bank', 'TD Bank', 'HSBC', 'Barclays', 'Lloyds', 'NatWest', 'Santander', 'Monzo', 'Revolut', 'Starling', 'Kabbage', 'OnDeck', 'Funding Circle', 'Lendio', 'BlueVine', 'Fundbox', 'Square', 'PayPal', 'Brex', 'Ramp', 'Mercury', 'Upstart', 'LendingClub', 'SoFi', 'Affirm', 'Klarna', 'Afterpay', 'Zest', 'FICO', 'Experian', 'Equifax', 'TransUnion', 'Plaid', 'Socure', 'Feedzai', 'Featurespace', 'Riskified', 'Signifyd', 'Kount', 'OpenAI', 'Anthropic', 'Claude', 'GPT', 'Gemini', 'Navy Federal', 'Schwab', 'Fidelity', 'Fifth Third', 'KeyBank', 'Huntington', 'Citizens Bank', 'Santander'];
  for (const r of real) assert.ok(!new RegExp('\\b' + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(all), `a real name: ${r}`);
  assert.ok(read('public/app.js').includes('A <b>made-up</b> log from') && read('public/app.js').includes('Made up from end to end.'));
  assert.ok(D.REVIEWERS.every((r) => /^u\.[a-z]+$/.test(r)), 'reviewers are handles, not names');
});

/* ================================================================== *
 * Settings and the AI helper
 * ================================================================== */

test('settings: preferences only - unknown fields, oversize lists and anything that looks like a record (an address, an id, a hash, an amount, a date, markup, invisible characters) are refused; merge keeps both sides\u2019 codes, words and presets', () => {
  const good = { version: 1, required: ['id', 'time', 'outcome', 'case'], when: { reasonsIfAdverse: true, reviewerIfOverride: false, whyIfOverride: true }, adverse: ['decline', 'flag'], maxReasons: 3, codes: [{ code: 'R02', text: 'Cash flow does not cover the payment' }, { code: 'AA-17', text: 'Too many recent applications' }], words: [{ word: 'aprv', outcome: 'approve' }], determinism: { temperatureZero: true, seed: true }, canon: 'raw', prevInInput: false, presets: [{ name: 'Underwriting log', map: { id: 'decision_id', modelVersion: 'model.version', reviewer: 'Reviewed By' } }] };
  const ok = C.cleanSettings(good, true);
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual(ok.settings.required, ['id', 'time', 'case', 'outcome'], 'kept in the fixed order');
  const bad = [
    { rows: [] }, { log: 'x' }, { required: ['id', 'nope'] }, { adverse: ['maybe'] }, { maxReasons: 11 }, { maxReasons: 2.5 }, { canon: 'xml' },
    { codes: [{ code: 'R02', text: 'Customer x' + AT + 'y.example' }] }, { codes: [{ code: 'R02', text: 'Account 4417 8821 0099' }] }, { codes: [{ code: 'R002345', text: 'x' }] }, { codes: [{ code: 'R02', text: 'see ' + sha('x') }] }, { codes: [{ code: 'R02', text: 'paid $950.00' }] }, { codes: [{ code: 'R02', text: 'on 2026-10-01' }] }, { codes: [{ code: 'R02', text: '<b>x</b>' }] }, { codes: [{ code: 'R02', text: 'a' + RLO + 'b' }] }, { codes: [{ code: 'R02', text: 'x', caseId: 'APP-7Q3K' }] }, { codes: [{ code: 'has space', text: 'x' }] },
    { words: [{ word: 'APP-73821', outcome: 'approve' }] }, { words: [{ word: 'x', outcome: 'maybe' }] },
    { presets: [{ name: 'Log', map: { id: 'cases.48213.id' } }] }, { presets: [{ name: 'Log', map: { id: 'ingest.' + sha('k').slice(0, 20) } }] }, { presets: [{ name: 'Log', map: { id: 'by.' + AT + 'x' } }] }, { presets: [{ name: 'Log', map: { nope: 'id' } }] }, { presets: [{ name: 'Log 2026-10-01', map: { id: 'id' } }] }, { presets: [{ name: 'Log', map: { id: 'id' }, records: [] }] },
    { determinism: { temperatureZero: 'yes' } }, { when: { always: true } },
  ];
  for (const b of bad) assert.ok(C.cleanSettings(Object.assign({}, good, b), true).errors.length, JSON.stringify(b).slice(0, 100));
  assert.ok(C.looksLikeData('id ' + 'deadbeef1234') && !C.looksLikeData('Model Risk Committee') && !C.looksLikeData('R02'));
  const merged = C.mergeSettings({ codes: [{ code: 'R02', text: 'Account words' }, { code: 'R09', text: 'Debt' }], presets: [{ name: 'A', map: { id: 'id' } }], words: [{ word: 'dcln', outcome: 'decline' }] }, { codes: [{ code: 'r02', text: 'Device words' }], presets: [{ name: 'B', map: { id: 'uuid' } }] });
  assert.deepStrictEqual([merged.settings.codes.map((c) => c.code + ':' + c.text), merged.settings.presets.map((p) => p.name), merged.settings.words.length, merged.added], [['r02:Device words', 'R09:Debt'], ['B', 'A'], 1, 3]);
  const parsed = C.parseCodes('R02, Cash flow\nR09\tDebt high\nF01 - Identity not matched\nbad code here, x\n\nR10: Owner guarantee');
  assert.deepStrictEqual(parsed.codes.map((c) => c.code), ['R02', 'R09', 'F01', 'bad', 'R10']);
  assert.strictEqual(parsed.errors.length, 0, 'a first word is a code: "bad" with "code here, x" as its words');
  assert.ok(C.parseCodes('R02, Customer 0012345678').errors.length);
  const pre = C.presetFor({ presets: [{ name: 'U', map: { id: 'decision_id', time: 'ts', outcome: 'decision', case: 'case_id', hash: 'hash' } }] }, [{ path: 'decision_id' }, { path: 'ts' }, { path: 'decision' }, { path: 'case_id' }]);
  assert.strictEqual(pre.name, 'U', 'four of five key names present is enough');
});

test('the AI request: key names and shape codes only; a key that looks like a value is sent as "key N" by the page and refused by the server; the answer is checked', () => {
  const keys = [{ path: 'decision_id', shapes: ['text-id', 'every-different'] }, { path: 'ingest.2026-10-14', shapes: ['yes-no'] }, { path: 'cases.APP-48213', shapes: ['object'] }, { path: 'by.sam' + AT + 'x.example', shapes: [] }, { path: 'h.' + sha('z').slice(0, 20), shapes: [] }, { path: 'review.override', shapes: ['yes-no', 'not-a-shape'] }];
  const pay = C.keysPayload(keys);
  assert.deepStrictEqual(pay.keys.map((k) => k.path), ['decision_id', 'key 2', 'key 3', 'key 4', 'key 5', 'review.override']);
  assert.deepStrictEqual(pay.keys[5].shape, ['yes-no'], 'only codes from the list');
  assert.ok(!JSON.stringify(pay).match(/48213|2026|example|deadbeef/));
  assert.deepStrictEqual(C.keysRequest(pay).req, pay);
  for (const [body, code] of [[{}, 'bad-keys'], [{ keys: [], x: 1 }, 'unknown-field'], [{ keys: [] }, 'bad-keys'], [{ keys: [{ path: 'x', shape: [], sample: '1' }] }, 'unknown-field'], [{ keys: [{ path: 'a.' + AT, shape: [] }] }, 'value-in-key'], [{ keys: [{ path: 'case 48213', shape: [] }] }, 'value-in-key'], [{ keys: [{ path: 'h ' + sha('q').slice(0, 16), shape: [] }] }, 'value-in-key'], [{ keys: [{ path: 'id', shape: ['APP-1234'] }] }, 'unknown-shape'], [{ keys: [{ path: 'id', shape: [] }], values: [1] }, 'unknown-field'], [{ keys: [{ path: '<b>', shape: [] }] }, 'value-in-key'], [{ keys: Array.from({ length: 121 }, () => ({ path: 'a', shape: [] })) }, 'bad-keys']]) {
    assert.strictEqual(C.keysRequest(body).code, code, JSON.stringify(body).slice(0, 60));
  }
  assert.strictEqual(C.keysRequest({ keys: [{ path: 'ref 1234', shape: [] }] }).req.keys[0].path, 'ref 1234', 'four digits pass the server (the page is stricter)');
  assert.strictEqual(C.safeKey('ref 1234', 0), 'key 1');
  const req = { keys: [{ path: 'a', shape: [] }, { path: 'b', shape: [] }, { path: 'c', shape: [] }] };
  const out = C.cleanMapping({ mapping: [{ key: 1, field: 'id', confidence: 'high' }, { key: 1, field: 'time', confidence: 'high' }, { key: 2, field: 'id', confidence: 'high' }, { key: 9, field: 'hash', confidence: 'high' }, { key: 3, field: 'nope', confidence: 'high' }, { key: 2, field: 'time', confidence: 'certain' }, null], note: '<b>see</b> https://x.example now' }, req);
  assert.deepStrictEqual([out.map.id, out.map.time, out.confidence.time, out.dropped, out.note], [0, 1, 'low', 5, 'see now']);
  assert.strictEqual(C.cleanMapping({ mapping: [] }, req), null);
});

/* ================================================================== *
 * Hostile input
 * ================================================================== */

test('hostile files: markup and bidi in keys and values, __proto__, malformed lines, a 2 MB value, a key per record, 100,000 records and the cap past it, a file over 20 MB - read, capped, escaped, and quick', async () => {
  const recs = Array.from({ length: 40 }, (_, i) => ({ ['<img src=x onerror=alert(1)>']: 1, id: 'd' + i + (i === 3 ? '<script>x</script>' : '') + (i === 4 ? RLO + 'evil' : ''), ['reason' + ZWSP + 'codes']: ['"><svg onload=1>'], time: '2026-10-0' + (1 + (i % 9)) + 'T10:00:00Z', decision: 'decline', ['k' + i]: i }));
  const text = jsonl(recs).replace('\n', '\n{"broken": \n[1,2]\n') + JSON.stringify(JSON.parse('{"__proto__":{"polluted":1},"id":"p"}')) + '\n';
  const { e, meta, rep } = await check(text);
  assert.strictEqual(({}).polluted, undefined, 'nothing reached a prototype');
  assert.strictEqual(meta.unreadable, 2);
  const k = meta.keys.find((x) => x.path.includes('reason'));
  assert.ok(k.samples.join('').length && !meta.keys.some((x) => C.visible(x.path).includes(RLO)));
  assert.ok(C.visible('a' + RLO + 'b' + ZWSP).includes('‹RLO›') && C.visible('a' + ZWSP).includes('‹ZWSP›'));
  assert.ok(C.esc('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;');
  const p = e.pack({ id: 'f', i: 3 });
  assert.ok(p.id.includes('<script>'), 'the pack carries the raw id - the page escapes it on render');
  assert.ok(!C.packMarkdown(p, {}).includes('<script>'), 'the Markdown escapes it');
  assert.ok(rep.findings.every((f) => typeof f.title === 'string'));
  const huge = jsonl([{ id: 'x', note: 'y'.repeat(2 * 1024 * 1024) }, { id: 'z', note: 'q' }]);
  const h = await check(huge);
  assert.ok(h.meta.keys.find((x) => x.path === 'note').samples[0].length < 60, 'a 2 MB value is cut for display');
  const t0 = Date.now();
  const many = Array.from({ length: 100500 }, (_, i) => '{"id":"S' + i + '","t":"2026-01-01T00:00:00Z","out":"approve"}').join('\n');
  const m = engine().load({ id: 'm', name: 'many', text: many });
  assert.deepStrictEqual([m.records, m.truncated], [100000, 500]);
  assert.ok(Date.now() - t0 < 6000, 'quick: ' + (Date.now() - t0) + ' ms');
  assert.throws(() => engine().load({ id: 'big', name: 'big', bytes: new Uint8Array(C.LIMITS.fileBytes + 1) }), /over 20 MB/);
  const perKey = jsonl(Array.from({ length: 600 }, (_, i) => ({ id: 'a', ['day_' + i]: 1 })));
  assert.ok(engine().load({ id: 'k', name: 'k', text: perKey }).keys.length <= C.LIMITS.keys, 'key paths are capped');
});

/* ================================================================== *
 * The worker, in a real worker thread, with SubtleCrypto
 * ================================================================== */

function spawnWorker() {
  const w = new Worker(`
    const { parentPort } = require('worker_threads'); const fs = require('fs'); const vm = require('vm'); const path = require('path');
    const dir = ${JSON.stringify(PUB)};
    global.self = global; global.module = undefined; global.exports = undefined;
    global.importScripts = (...f) => f.forEach((x) => vm.runInThisContext(fs.readFileSync(path.join(dir, x), 'utf8'), { filename: x }));
    global.postMessage = (m) => parentPort.postMessage(m);
    global.addEventListener = (t, fn) => { if (t === 'message') parentPort.on('message', (data) => fn({ data })); };
    vm.runInThisContext(fs.readFileSync(path.join(dir, 'replay-worker.js'), 'utf8'), { filename: 'replay-worker.js' });
  `, { eval: true });
  let seq = 0;
  const waits = {};
  const progress = [];
  w.on('message', (m) => { const p = waits[m.id]; if (!p) return; if (m.progress) { progress.push(m.progress); return; } delete waits[m.id]; if (m.ok) p.resolve(m.out); else p.reject(new Error(m.error)); });
  return { progress, call: (op, data) => new Promise((resolve, reject) => { const id = ++seq; waits[id] = { resolve, reject }; w.postMessage({ id, op, data }); }), stop: () => w.terminate() };
}

test('the worker reads a File itself and checks it with SubtleCrypto - the same verdicts as node:crypto; builds the demo; reports progress; refuses a file over 20 MB before reading it', async () => {
  const w = spawnWorker();
  try {
    const good = chain(Array.from({ length: 20 }, (_, i) => dec(i)));
    good[7] = Object.assign({}, good[7], { decision: 'decline' });
    const meta = await w.call('load', { id: 'a', name: 'x.jsonl', file: new File([jsonl(good)], 'x.jsonl') });
    assert.strictEqual(meta.records, 20);
    const rep = await w.call('analyze', { id: 'a', map: meta.guess.map, settings: C.defaults() });
    assert.deepStrictEqual([rep.chain.verified, find(rep, 'chain-changed').extra.first.id], [19, 'T-0008'], 'SubtleCrypto and node:crypto agree on every hash');
    assert.ok(w.progress.length && w.progress[w.progress.length - 1].done === 20);
    const demo = await w.call('load', { id: 'd', demo: true });
    const dr = await w.call('analyze', { id: 'd', map: D.MAP, settings: D.settings(), changeLog: D.CHANGE_LOG });
    assert.strictEqual(demo.records, 400);
    assert.deepStrictEqual(dr.findings.map((f) => f.key).sort(), D.PLANTED.slice().sort());
    const p = await w.call('pack', { id: 'd', i: 211 });
    assert.strictEqual(p.chain.status, 'changed');
    assert.strictEqual((await w.call('sample', { id: 'd', n: 10, seed: 's' })).n, 10);
    assert.ok((await w.call('flagged', { id: 'd' })).startsWith('severity,finding,'));
    assert.strictEqual(await w.call('drop', { id: 'a' }), true);
    await assert.rejects(w.call('analyze', { id: 'a', map: {} }), /not loaded/);
    await assert.rejects(w.call('load', { id: 'x', file: new File([new Uint8Array(C.LIMITS.fileBytes + 1)], 'huge.jsonl') }), /over 20 MB/);
    await assert.rejects(w.call('nope', {}), /Unknown step/);
    assert.ok(!dr.findings.some((f) => 'all' in f), 'the full index lists stay in the worker');
  } finally { w.stop(); }
});

/* ================================================================== *
 * The page's promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes; the hero, the mock and the lab card too; marks 3:1; 44px targets; nothing scrolls the page sideways', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  assert.deepStrictEqual(Object.keys(dark).sort(), Object.keys(light).sort(), 'every token has a dark value');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'code-bg', 'bar-bg']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    ok('accent-ink', 'accent'); for (const fg of ['text', 'link', 'muted']) ok(fg, 'accent-soft');
    for (const k of ['critical', 'high', 'medium', 'low', 'info', 'ok']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); ok('muted', `${k}-bg`); ok(k, 'card'); ok(k, 'card2'); }
    for (const k of ['tone-critical', 'tone-high', 'tone-medium', 'tone-low', 'tone-info', 'tone-ok', 'accent', 'series-1', 'series-2']) ok(k, 'card', 3);
    ok('text', 'card2'); ok('text', 'bg');
  }
  // series-3 (aqua) sits under 3:1 on the light card: every chart labels it in words (legend and list), the relief rule
  assert.ok(ratio(dark['series-3'], dark.card) >= 3);
  for (const bg of ['#111a2b', '#1e293b', '#0b4f75']) for (const fg of ['#ffffff', '#e3f1fa', '#bfe3f7']) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  for (const [fg, bg] of [['#0b2236', '#bfe3f7'], ['#111827', '#fbfcfd'], ['#4a5568', '#fbfcfd'], ['#a3122f', '#fde7eb'], ['#8a3b00', '#fdebd9'], ['#166534', '#dcf5e3']]) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}`);
  const lab = require('../../../lab').get('replay');
  assert.ok(lab && ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const sel of ['.btn', '.link-btn', '.seg button', '.input, textarea.input, select.input', '.check', '.fhead', '.radio']) assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: (4[4-9]|5\\d|60)px').test(css), `${sel}: 44px`);
  assert.ok(/\.results button \{[^}]*min-height: 44px/.test(css) && /details\.why > summary \{[^}]*min-height: 44px/.test(css) && /\.tabbar button \{[^}]*min-height: 60px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/\.tablewrap \{[^}]*overflow: auto/.test(css) && /\.out \{[^}]*overflow: auto/.test(css) && /\.sent-pre \{[^}]*overflow: auto/.test(css) && /\.hashtxt \{[^}]*word-break: break-all/.test(css), 'tables, hashes and code scroll or wrap in their own box');
  assert.ok(!/class="d[^"]*" data-act=/.test(read('public/app.js')), 'the day bars are not tap targets (a picker under the chart is)');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped and opt-in (settings only), no clock, dice or network in the core, every log, typed and model string escaped', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js) && /localStorage\.removeItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/sessionStorage|indexedDB|document\.cookie/.test(js));
  assert.match(js, /function saveSoon\(\) \{ if \(!state\.keep\) return;/, 'nothing is stored unless this device said yes');
  assert.match(js, /store\(\{ v: 1, keep: true, settings: state\.settings, syncBase: state\.syncBase, device: state\.device \}\)/, 'and then only the settings - never a log');
  assert.match(js, /keep: false/);
  assert.match(js, /Intl\.getCanonicalLocales\(navigator\.language \|\| 'en-US'\)\[0\] \|\| 'en-US'; \} catch \(e\) \{ return 'en-US'; \}/, 'a locale Intl refuses (en-US@posix) falls back to en-US');
  assert.ok(!/eval\(|new Function|setTimeout\(['"]/.test(js + read('public/replay-core.js') + read('public/replay-worker.js') + read('public/demo.js')), 'no eval of any kind');
  assert.match(js, /new Worker\('replay-worker\.js'\)/, 'the worker is a same-origin file - the CSP allows it');
  assert.match(js, /crypto\.subtle\.digest\('SHA-256', enc\.encode\(text\)\)/, 'SHA-256 by SubtleCrypto on the page');
  assert.match(read('public/replay-worker.js'), /self\.crypto\.subtle\.digest\('SHA-256', enc\.encode\(text\)\)/, 'and in the worker');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/fields', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me', 'api/settings'].sort(), 'the page asks for nothing else - no route takes a log');
  assert.match(js, /api\('POST', 'api\/ai\/fields', payload\)/, 'the AI call sends the payload shown, and nothing else');
  assert.match(js, /var payload = C\.keysPayload\(keys\);/);
  assert.match(js, /api\('PUT', 'api\/settings', \{ settings: settingsBody\(\), base:/, 'sync sends the settings and a base, nothing else');
  assert.ok(!/changeLog/.test(js.match(/function settingsBody\(\)[^\n]*/)[0]) && !/changeLog/.test(js.match(/store\(\{ v: 1[^\n]*/)[0]), 'the change log is never synced or kept');
  const files = ['public/index.html', 'public/app.js', 'public/replay-core.js', 'public/demo.js', 'public/replay-worker.js', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/store.js', 'CLAUDE.md', 'test/run.js'];
  for (const f of files) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  for (const f of ['public/replay-core.js', 'public/demo.js', 'public/replay-worker.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon|indexedDB|WebSocket/.test(src), `${f} touches no network or storage`);
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(src), `${f} has no dice and no clock`);
  }
  const coreCode = read('public/replay-core.js').replace(/var HASH_SNIPPET = \[[\s\S]*?\]\.join\('\\n'\);/, '').replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');
  assert.ok(coreCode.length > 50000 && !/crypto\./.test(coreCode), 'the core never hashes by itself - SHA-256 is handed in (the snippet is text on the page)');
  // Every interpolation of something a log, a person, the server or a model wrote goes through esc().
  const strip = (src) => { let out = ''; let i = 0; const re = /\besc\(/g; let m; while ((m = re.exec(src))) { if (m.index < i) continue; out += src.slice(i, m.index) + 'SAFE'; let depth = 0, j = m.index + m[0].length - 1; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; re.lastIndex = i; } return out + src.slice(i); };
  const risky = strip(js).split('\n').filter((l) => /</.test(l) && !/toast\(|confirm\(|prompt\(|copy\(|download\(|textContent/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(?!SAFE\b|i\b|k\b|String\b)([a-zA-Z_$][\w$]*(?:\.[\w$]+|\[[^\]]+\])*)\s*\+/g);
  const allowed = (r) => /\+\s*(?:(?:[a-zA-Z]*Html|html|bars|segs|body|opts|req|when|adv|demoNote|proofP|cls)\b|SEV_P\[[^\]]+\])/.test(r);
  const bad = (risky || []).filter((r) => !allowed(r));
  assert.deepStrictEqual(bad, [], `unescaped: ${bad}`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbrief\b|\bsettings\b|\bkeys\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /replay-shell-v1/.test(sw) && ['replay-core.js', 'replay-worker.js', 'demo.js', 'app.js'].every((f) => sw.includes(`'${f}'`)) && /k\.indexOf\('replay-'\) === 0/.test(sw), 'the service worker never answers api/ and only clears its own caches');
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
  assert.match(js, /A starting checklist, not legal advice\./);
  assert.ok(!/\b(Regulation [A-Z]|ECOA|FCRA|SR 11-7|GDPR|EU AI Act|CFPB|OCC)\b/.test(js + read('public/replay-core.js') + read('public/index.html')), 'regulations named only generically');
});

test('the copy: no invisible characters in any source file, no key- or token-shaped strings', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name === 'node_modules' ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const invisible = new RegExp('[' + [[0, 8], [11, 12], [14, 31], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF]].map(([a, b]) => '\\u' + a.toString(16).padStart(4, '0') + '-\\u' + b.toString(16).padStart(4, '0')).join('') + ']');
  for (const f of walk(ROOT).filter((x) => /\.(js|css|html|md|json|svg|webmanifest)$/.test(x) && !/package-lock/.test(x))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!invisible.test(src), `${path.relative(ROOT, f)} carries an invisible character`);
    if (!/lib\/(identity|stripe|byok|webauthn)/.test(f)) assert.ok(!/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bsk-ant-[A-Za-z0-9-]{10,}/.test(src), `${path.relative(ROOT, f)} carries a key-shaped string`);
  }
});

test('local-only switches throw on Cloud Run; the lab prefix is read; the store holds one kind of document, read by its id', () => {
  for (const [mod, env] of [['./lib/store', { REPLAY_MEMORY: '1' }], ['./lib/fakeai', { REPLAY_FAKE_AI: '1' }], ['./server', { REPLAY_FAKE_AI: '1', REPLAY_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, REPLAY_MEMORY: '', REPLAY_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, REPLAY_MEMORY: '', REPLAY_COLLECTION_PREFIX: 'replay_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'replay_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.ok(!/store\.list\(|orderBy/.test(server), 'one document per account, read by its id');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g))].sort(), ["store.get('settings'", "store.remove('settings'", "store.transact('settings'"]);
});

/* ================================================================== *
 * Over HTTP
 * ================================================================== */

let base;
let ip6 = 1;
function client() {
  const cookies = {};
  const addr = `2001:db8:${(ip6++).toString(16)}::1`;
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const t = await res.text();
    let data = {}; try { data = JSON.parse(t); } catch (e) { data = { text: t }; }
    return { status: res.status, data, text: t, headers: res.headers };
  };
}
const mail = (who) => `${who}${AT}example.com`;
const uidOf = (email) => Buffer.from(email).toString('base64url');
async function register(who) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const BIG = { x: 'x'.repeat(900 * 1024) };
let demoKeys = null;
async function demoPayload() {
  if (!demoKeys) { const d = await D.build(digest); demoKeys = engine().load({ id: 'p', name: d.name, text: d.text }).keys; }
  return C.keysPayload(demoKeys);
}

test('signed out: the page, the worker and the demo work with zero model calls; settings and the AI answer 401 before reading a body; no route takes a log', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.fields, meta.shapes, meta.outcomes], [C.FIELDS, C.SHAPE_KEYS, C.OUTCOMES]);
  for (const f of ['replay-core.js', 'replay-worker.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/settings'], ['PUT', '/api/settings'], ['DELETE', '/api/settings'], ['POST', '/api/ai/fields']]) assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  for (const [m, p] of [['PUT', '/api/settings'], ['POST', '/api/ai/fields']]) assert.strictEqual((await anon(m, p, BIG)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  for (const p of ['/api/upload', '/api/check', '/api/analyze', '/api/records', '/api/verify', '/api/log', '/api/decisions', '/api/pack', '/api/sample', '/api/report', '/api/hash']) assert.strictEqual((await anon('POST', p, { records: [{ id: 'RVT-D-0001', case_id: 'APP-MXJB' }] })).status, 404, `${p}: there is no route that takes a log`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the gates come before each parser, in order; one model call site; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/fields', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/settings', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((read('lib/ai.js').match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(ai.SYSTEM, /never an instruction/);
  assert.match(ai.SYSTEM, /You never see a value/);
});

test('settings sync: they follow the account; a stale device gets 409 with the account copy; anything that looks like a record is refused; the owner tag holds no id or address', async () => {
  const a = await register('risk.ana');
  assert.deepStrictEqual((await a('GET', '/api/settings')).data, { settings: null });
  const good = { version: 1, required: ['id', 'time', 'outcome', 'modelVersion'], adverse: ['decline', 'flag'], maxReasons: 4, codes: [{ code: 'R02', text: 'Cash flow does not cover the payment' }], words: [{ word: 'aprv', outcome: 'approve' }], canon: 'canonical', prevInInput: true, presets: [{ name: 'Underwriting log', map: { id: 'decision_id', modelVersion: 'model.version' } }] };
  const put = await a('PUT', '/api/settings', { settings: good, base: null });
  assert.strictEqual(put.status, 200, put.text);
  const v1 = put.data.settings.updatedAt;
  const b = client();
  assert.strictEqual((await b('POST', '/api/auth/login', { email: mail('risk.ana'), password: 'a long enough password' })).status, 200);
  assert.strictEqual((await b('GET', '/api/settings')).data.settings.codes[0].code, 'R02');
  assert.strictEqual((await b('PUT', '/api/settings', { settings: Object.assign({}, good, { maxReasons: 3 }), base: v1 })).status, 200);
  const stale = await a('PUT', '/api/settings', { settings: good, base: v1 });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.data.settings.maxReasons, 3, 'the 409 carries the account copy to merge with');
  assert.strictEqual((await a('PUT', '/api/settings', { settings: good, base: null })).status, 409, 'a device that never synced cannot overwrite');
  const cur = (await a('GET', '/api/settings')).data.settings.updatedAt;
  for (const bad of [
    { settings: Object.assign({}, good, { records: [{ id: 'RVT-D-0001', case_id: 'APP-MXJB' }] }), base: cur },
    { settings: Object.assign({}, good, { codes: [{ code: 'R02', text: 'Applicant 00048213' }] }), base: cur },
    { settings: Object.assign({}, good, { codes: [{ code: 'R02', text: 'hash ' + sha('x') }] }), base: cur },
    { settings: Object.assign({}, good, { codes: [{ code: 'R02', text: 'mail ana' + AT + 'x.example' }] }), base: cur },
    { settings: Object.assign({}, good, { codes: [{ code: 'R02', text: 'x', case: 'APP-MXJB' }] }), base: cur },
    { settings: Object.assign({}, good, { presets: [{ name: 'U', map: { case: 'cases.APP-48213' } }] }), base: cur },
    { settings: Object.assign({}, good, { changeLog: '2026-10-21, 2.5.0, Model Risk Committee' }), base: cur },
    { settings: good, base: cur, log: '{"id":1}' },
    { settings: 'nope', base: cur },
  ]) {
    const r = await a('PUT', '/api/settings', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 120) + ' ' + r.text);
  }
  assert.strictEqual((await a('GET', '/api/settings')).data.settings.updatedAt, cur, 'nothing was saved');
  const dump = store._dump();
  assert.ok(!dump.includes('risk.ana') && !dump.includes(uidOf(mail('risk.ana'))), 'filed under an HMAC, never the account id or address');
  assert.ok(!/APP-MXJB|00048213|RVT-D-0001|Model Risk Committee/.test(dump), 'nothing from a refused body');
  assert.ok(dump.includes(ownerTag(uidOf(mail('risk.ana')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const doc = Object.values(JSON.parse(dump).find(([p]) => p === 'settings')[1]).map(([, d]) => d)[0];
  assert.deepStrictEqual(Object.keys(doc).sort(), ['owner', 'settings', 'updatedAt'], 'the document is the tag, the settings and a time');
  assert.deepStrictEqual(Object.keys(doc.settings).sort(), ['adverse', 'canon', 'codes', 'determinism', 'maxReasons', 'presets', 'prevInInput', 'required', 'version', 'when', 'words']);
  const other = await register('kim.other');
  assert.deepStrictEqual((await other('GET', '/api/settings')).data, { settings: null }, 'another account sees nothing of it');
  assert.strictEqual((await a('DELETE', '/api/settings')).status, 200);
  assert.deepStrictEqual((await b('GET', '/api/settings')).data, { settings: null });
});

test('help me map these fields over HTTP: key names and shapes only; a value in the request is refused with no model call; the model saw no value; its answer is checked', async () => {
  const ana = await register('ana.fields');
  const calls = await modelCalls();
  for (const bad of [{}, { keys: [{ path: 'case.' + AT + 'x', shape: [] }] }, { keys: [{ path: 'cases.APP-48213', shape: [] }] }, { keys: [{ path: 'h.' + sha('a').slice(0, 20), shape: [] }] }, { keys: [{ path: 'id', shape: ['RVT-D-0001'] }] }, { keys: [{ path: 'id', shape: [], sample: ['RVT-D-0001'] }] }, { keys: [{ path: 'id', shape: [] }], records: [] }, []]) {
    const r = await ana('POST', '/api/ai/fields', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 80) + ' ' + r.text);
  }
  assert.strictEqual((await ana('POST', '/api/ai/fields', { keys: [{ path: 'case 12345', shape: [] }] })).data.code, 'value-in-key');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const n0 = fakeClient.calls.length;
  const payload = await demoPayload();
  const r = await ana('POST', '/api/ai/fields', payload);
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const sent = fakeClient.calls[n0];
  assert.strictEqual(sent.model, 'claude-haiku-4-5');
  assert.deepStrictEqual(sent.tool_choice, { type: 'tool', name: 'map_fields' });
  const userText = sent.messages[0].content[0].text;
  assert.match(userText, /<<<KEYS\n1\. "decision_id" - short codes of letters and digits; every value different\n[\s\S]*\nKEYS>>>/, 'the names are fenced as untrusted');
  const d = await D.build(digest);
  const first = JSON.parse(d.text.split('\n')[0]);
  for (const v of [first.decision_id, first.case_id, first.hash, first.inputs_hash, first.inputs.business.industry, 'u.alder', 'riverton-underwriter', 'Riverton', '2026-10-01']) assert.ok(!JSON.stringify(sent).includes(v), `the model saw ${v}`);
  const keysSent = payload.keys.map((k) => k.path);
  const fields = r.data.fields;
  const placed = Object.fromEntries(Object.entries(fields.map).filter(([, i]) => i >= 0).map(([f, i]) => [f, keysSent[i]]));
  for (const f of ['id', 'time', 'outcome', 'modelVersion', 'promptVersion', 'temperature', 'inputsHash', 'reasons', 'prevHash', 'hash', 'reviewer', 'override']) assert.strictEqual(placed[f], D.MAP[f], f);
  assert.ok(!store._dump().includes('tool_calls'), 'nothing stored');
  fakeClient.mode = 'inject';
  const inj = await ana('POST', '/api/ai/fields', payload);
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<b>|<img|onerror|evil|hunter2|password|\u202e/i.test(inj.text), inj.text.slice(0, 400));
  assert.deepStrictEqual([inj.data.fields.map.id, inj.data.fields.map.time, inj.data.fields.map.case, inj.data.fields.confidence.time], [0, 1, -1, 'low'], 'one key each, real keys only, a confidence from the list');
  assert.ok(inj.data.fields.dropped >= 6);
  fakeClient.mode = 'blank';
  assert.strictEqual((await ana('POST', '/api/ai/fields', payload)).status, 422);
  fakeClient.mode = 'maxtokens';
  assert.match((await ana('POST', '/api/ai/fields', payload)).data.error, /ran long/);
  fakeClient.mode = 'upstream401';
  const up = await ana('POST', '/api/ai/fields', payload);
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await ana('POST', '/api/ai/fields', payload);
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('the gates: unconfirmed free account 403, out of credit 402, the day\u2019s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  const body = { keys: [{ path: 'ts', shape: ['date-iso'] }] };
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/ai/fields', body);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/replay/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
    assert.strictEqual((await eve('POST', '/api/ai/fields', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/fields', body)).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/fields', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-replay-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/fields', body);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/fields', BIG)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-replay-${day}`); }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/replay', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/replay`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
