// Pure rules first, then end to end against the memory identity store and
// the fake model:
//   BURNRATE_MEMORY=1 BURNRATE_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /burnrate, the way
// the lab mounts it, so the auth cookie, the budget gate and the metered
// route's parser order are exercised as deployed. Model calls are counted
// from the identity's usage rows - the same rows that bill a real account -
// and what reached "the model" is read from the fake client's own log.
//
// The fixtures in test/fixtures are SYNTHETIC: written by hand in Claude
// Code's real shape. Never copy a real transcript into this repo.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.BURNRATE_MEMORY !== '1' || process.env.BURNRATE_FAKE_AI !== '1') {
  console.error('run with BURNRATE_MEMORY=1 BURNRATE_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, fakeCalls } = require('../server');
const C = require('../public/burn-core');
const D = require('../public/demo');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'projects');
const SHOP = path.join(FIX, '-Users-test-code-shop');
const SID = '11111111-2222-4333-8444-555555555555';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- helpers ---------------- */

function readInto(col, file, who) {
  const fh = col.file(path.relative(FIX, file), who);
  fh.text(fs.readFileSync(file, 'utf8'));
}
function shopDataset() {
  const col = C.createCollector();
  readInto(col, path.join(SHOP, `${SID}.jsonl`), 'Tess');
  readInto(col, path.join(SHOP, SID, 'subagents', 'agent-aagent0001.jsonl'), 'Tess');
  return col.finish();
}

/** A synthetic thread, as JSONL lines, from a compact script. */
function script(opts) {
  const o = Object.assign({ sid: 'sess-1', model: 'claude-opus-5-5', agent: '', cwd: '/w/proj', start: Date.parse('2026-10-05T09:00:00Z') }, opts);
  let t = o.start;
  let n = 0;
  const lines = [];
  const base = (type) => {
    const x = { type, sessionId: o.sid, cwd: o.cwd, isSidechain: Boolean(o.agent), timestamp: new Date(t).toISOString() };
    if (o.agent) x.agentId = o.agent;
    return x;
  };
  return {
    lines,
    /** {gap ms, model, inp, w5, w1, cr, out, tool, input, chars, err, fast} */
    turn(p) {
      t += p.gap === undefined ? 20000 : p.gap;
      const id = `${o.sid}-${o.agent || 'm'}-${++n}`;
      const u = { input_tokens: p.inp || 0, cache_creation_input_tokens: (p.w5 || 0) + (p.w1 || 0), cache_read_input_tokens: p.cr || 0, output_tokens: p.out === undefined ? 100 : p.out, cache_creation: { ephemeral_5m_input_tokens: p.w5 || 0, ephemeral_1h_input_tokens: p.w1 || 0 } };
      if (p.fast) u.speed = 'fast';
      const a = base('assistant');
      const content = p.tool ? [{ type: 'tool_use', id: `tu-${id}`, name: p.tool, input: p.input || {} }] : [{ type: 'text', text: 'ok' }];
      a.message = { model: p.model || o.model, id, content, usage: u };
      lines.push(JSON.stringify(a));
      if (p.tool) {
        const r = base('user');
        r.message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: 'r'.repeat(p.chars || 100), is_error: Boolean(p.err) }] };
        lines.push(JSON.stringify(r));
      }
      return id;
    },
    pause(ms) { t += ms; },
    compact() { t += 1000; const s = base('system'); s.subtype = 'compact_boundary'; lines.push(JSON.stringify(s)); },
  };
}
function analyseScripts(scripts, extra) {
  const col = C.createCollector();
  scripts.forEach((s, i) => {
    const fh = col.file(s.file || `p/sess-${i}.jsonl`, s.who || 'Me');
    s.lines.forEach((l) => fh.line(l));
  });
  return C.analyse(col.finish(), null, Object.assign({ tz: 'UTC' }, extra || {}));
}
const kinds = (a) => a.findings.map((f) => f.id).sort();
const find = (a, id) => a.findings.find((f) => f.id === id);
const MIN = 60000;

/* ---------------- reading transcripts ---------------- */

test('a real-shaped session: streamed lines deduped, malformed and synthetic lines skipped and counted, subagent file labelled', () => {
  const ds = shopDataset();
  assert.strictEqual(ds.stats.responses, 5, 'three main responses and two subagent ones');
  assert.strictEqual(ds.stats.duplicates, 2, 'msg_A was written as three lines: two are repeats');
  assert.strictEqual(ds.stats.malformed, 1);
  assert.strictEqual(ds.stats.synthetic, 1);
  assert.strictEqual(ds.stats.subFiles, 1);
  const main = ds.threads.find((t) => !t.sub);
  const sub = ds.threads.find((t) => t.sub);
  assert.strictEqual(main.project, 'shop', 'the project is the cwd’s basename');
  assert.strictEqual(sub.agent, 'aagent0001');
  assert.strictEqual(main.turns.length, 3);
  const a = main.turns[0];
  assert.deepStrictEqual([a.inp, a.w5, a.w1, a.cr, a.out], [5, 20000, 0, 0, 400], 'one response, counted once, with the largest output count of its lines');
  assert.strictEqual(a.tools.length, 1);
  assert.deepStrictEqual([a.tools[0].name, a.tools[0].label, a.tools[0].chars > 4000, a.tools[0].err], ['Read', 'cart.ts', true, false]);
  const b = main.turns[1];
  assert.deepStrictEqual([b.w5, b.w1], [1000, 0], 'no 5m/1h split (older versions): all of it is 5-minute');
  assert.strictEqual(b.tools[0].err, true, 'the failed command is marked');
  assert.ok(b.tools[0].label.length <= 60 && !b.tools[0].label.includes('LONGTAIL_MARKER'), 'a command keeps its first 60 characters only');
  assert.deepStrictEqual(main.compactions.length, 1, 'the compaction is seen');
  assert.strictEqual(main.turns[2].tools[0].chars, 'src/cart.ts:12: checkout()'.length, 'array tool_result content is measured');
});

test('the same response in two files (or two folders) counts once; a repeat line never adds tokens', () => {
  const col = C.createCollector();
  const file = path.join(SHOP, `${SID}.jsonl`);
  readInto(col, file, 'Tess');
  readInto(col, file, 'Tess');
  const ds = col.finish();
  assert.strictEqual(ds.stats.responses, 3);
  const once = C.analyse(shopDataset(), null, { tz: 'UTC' });
  const twice = C.analyse(ds, null, { tz: 'UTC' });
  assert.strictEqual(twice.totals.output, once.totals.output - 150, 'the same three main responses, nothing doubled (less the subagent)');
  const s = script({});
  s.turn({ w5: 1000, out: 50 });
  const dup = [s.lines[0], s.lines[0], s.lines[0].replace('"output_tokens":50', '"output_tokens":70')];
  const c2 = C.createCollector();
  const fh = c2.file('p/x.jsonl', 'Me');
  dup.forEach((l) => fh.line(l));
  const t = c2.finish().threads[0].turns;
  assert.deepStrictEqual([t.length, t[0].out, t[0].w5], [1, 70, 1000], 'streamed chunks: one turn, the final output count');
});

test('streaming a file in chunks gives the same answer as reading it whole; CRLF and a last line with no newline are read', () => {
  const text = fs.readFileSync(path.join(SHOP, `${SID}.jsonl`), 'utf8').replace(/\n/g, '\r\n').replace(/\r\n$/, '');
  const col = C.createCollector();
  const fh = col.file('p/a.jsonl', 'Me');
  let buf = '';
  for (let i = 0; i < text.length; i += 37) buf = C.splitLines(buf + text.slice(i, i + 37), fh.line);
  if (buf) fh.line(buf);
  const a = C.analyse(col.finish(), null, { tz: 'UTC' });
  const whole = C.createCollector();
  whole.file('p/a.jsonl', 'Me').text(text);
  const b = C.analyse(whole.finish(), null, { tz: 'UTC' });
  assert.strictEqual(a.totals.units, b.totals.units);
  assert.strictEqual(a.stats.malformed, 1);
});

test('nothing but numbers and short labels is kept: no message text, no thinking, no file contents, no full command', () => {
  const ds = shopDataset();
  const json = JSON.stringify(ds);
  for (const m of ['MESSAGE_TEXT_MARKER', 'THINKING_MARKER', 'PRIVATE_CODE_MARKER', 'LONGTAIL_MARKER', 'Please refactor']) assert.ok(!json.includes(m), m);
  assert.ok(!/xxxxxxxxxx/.test(json) && !/yyyyyyyyyy/.test(json), 'no tool output');
});

test('files: subagent transcripts are recognised by their folder; a folder name stands in for a missing cwd', () => {
  assert.strictEqual(C.fileInfo('projects/-Users-a-b/1234abcd-1111-2222-3333-444455556666/subagents/agent-x.jsonl').sub, true);
  assert.strictEqual(C.fileInfo('projects/-Users-a-b/abc.jsonl').sub, false);
  const col = C.createCollector();
  col.file('-Users-maya-code-api-refactor/s.jsonl', 'Me').line(JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-10-05T10:00:00Z', message: { model: 'claude-opus-5-5', id: 'm1', usage: { input_tokens: 1, output_tokens: 1 } } }));
  assert.strictEqual(col.finish().threads[0].project, 'api-refactor');
});

test('limits: too many people or files is a plain refusal, not a crash', () => {
  const col = C.createCollector();
  for (let i = 0; i < C.LIMITS.people; i++) col.person(`P${i}`);
  assert.throws(() => col.person('One more'), /Up to 12 people/);
  assert.strictEqual(col.person('P3'), 3, 'a known name is the same person');
});

/* ---------------- pricing ---------------- */

test('pricing to the cent: each token kind at its list price, dated ids, fast mode, unknown models', () => {
  const s = script({});
  s.turn({ inp: 1e6, w5: 1e6, w1: 1e6, cr: 1e6, out: 1e6 });
  let a = analyseScripts([s]);
  assert.strictEqual(a.totals.usd, 37.2, 'Opus 5.5: $4 + $5 + $8 + $0.20 + $20');
  assert.strictEqual(a.totals.units, 3720000000);
  const h = script({ model: 'claude-haiku-4-5-20251001' });
  h.turn({ inp: 333333, cr: 333333, out: 333333 });
  a = analyseScripts([h]);
  assert.strictEqual(a.totals.units, 333333 * 100 + 333333 * 10 + 333333 * 500, 'exact integer units');
  assert.strictEqual(a.totals.usd, 2.03, '$1.999998 rounds to the cent');
  assert.strictEqual(C.rowFor('claude-opus-5-5', C.DEFAULT_PRICES).id, 'claude-opus-5-5');
  assert.strictEqual(C.rowFor('claude-opus-5', C.DEFAULT_PRICES).id, 'claude-opus-5', 'opus-5-5 is never priced as opus-5, nor the reverse');
  assert.strictEqual(C.rowFor('claude-opus-5-5[1m]', C.DEFAULT_PRICES).id, 'claude-opus-5-5');
  assert.strictEqual(C.rowFor('us.anthropic.claude-sonnet-5-5-v1:0', C.DEFAULT_PRICES).id, 'claude-sonnet-5-5');
  assert.strictEqual(C.rowFor('claude-opus-5-5-extra', C.DEFAULT_PRICES), null, 'only a date stamp may follow an id');
  const f = script({});
  f.turn({ inp: 1e6, out: 1e6, fast: true });
  assert.strictEqual(analyseScripts([f]).totals.usd, 48, 'fast mode on Opus 5.5 is 2x ($8 + $40)');
  const u = script({ model: 'claude-future-9' });
  u.turn({ inp: 1e6, out: 1e6 });
  a = analyseScripts([u]);
  assert.strictEqual(a.totals.usd, 0);
  assert.deepStrictEqual(a.unpriced.map((x) => [x.model, x.turns]), [['claude-future-9', 1]], 'an unknown model is reported, not guessed');
  // Many small turns add up exactly.
  const many = script({ model: 'claude-sonnet-5-5' });
  for (let i = 0; i < 1000; i++) many.turn({ inp: 1, cr: 7, out: 3 });
  a = analyseScripts([many]);
  assert.strictEqual(a.totals.units, 1000 * (1 * 200 + 7 * 20 + 3 * 1000));
  assert.strictEqual(a.totals.usd, 0.03);
});

test('the price table: dated, labelled list prices, every row sane, edits cleaned and applied', () => {
  assert.strictEqual(C.PRICES_AS_OF, '2026-09-25');
  assert.match(C.PRICE_NOTE, /list prices/i);
  for (const r of C.DEFAULT_PRICES) {
    assert.ok(r.write5m === r.input * 1.25 && r.write1h === r.input * 2, `${r.id}: cache writes 1.25x / 2x`);
    assert.ok(r.read < r.input && r.output > r.input, r.id);
  }
  const o55 = C.DEFAULT_PRICES.find((r) => r.id === 'claude-opus-5-5');
  assert.deepStrictEqual([o55.input, o55.output, o55.write5m, o55.write1h, o55.read], [4, 20, 5, 8, 0.2]);
  const h45 = C.DEFAULT_PRICES.find((r) => r.id === 'claude-haiku-4-5');
  assert.deepStrictEqual([h45.input, h45.output, h45.read], [1, 5, 0.1]);
  const edited = C.cleanPrices([{ id: 'claude-opus-5-5', name: '<b>Opus</b>', input: 1.005, output: 2, write5m: 3, write1h: 4, read: 0.1 }, { id: 'BAD ID!', input: 1, output: 1, write5m: 1, write1h: 1, read: 1 }, { id: 'claude-x', input: -1, output: 1, write5m: 1, write1h: 1, read: 1 }]);
  assert.strictEqual(edited.length, 1);
  assert.strictEqual(edited[0].input, 1.01, 'rounded to the cent');
  const s = script({});
  s.turn({ inp: 1e6, out: 0 });
  const a = C.analyse((() => { const c = C.createCollector(); const fh = c.file('p/x.jsonl', 'Me'); s.lines.forEach((l) => fh.line(l)); return c.finish(); })(), edited, { tz: 'UTC' });
  assert.strictEqual(a.totals.usd, 1.01);
  assert.strictEqual(a.prices.edited, true);
  assert.strictEqual(analyseScripts([s]).prices.edited, false);
  assert.strictEqual(C.cleanPrices('nope').length, C.DEFAULT_PRICES.length, 'junk falls back to the list');
});

test('breakdowns: by day in the viewer’s time zone, by model, by project, subagents apart, a projected month', () => {
  const a = C.analyse(shopDataset(), null, { tz: 'UTC' });
  assert.strictEqual(a.byDay.length, 1);
  assert.deepStrictEqual(a.byModel.map((m) => m.name).sort(), ['Haiku 4.5', 'Opus 5.5', 'Sonnet 5.5']);
  assert.strictEqual(a.byProject[0].name, 'shop');
  assert.ok(a.totals.subUsd > 0 && a.totals.subUsd < a.totals.usd);
  assert.ok(Math.abs(a.totals.subUsd + a.totals.mainUsd - a.totals.usd) <= 0.011, 'main and subagents add up (each rounded to the cent)');
  assert.strictEqual(a.sessions.length, 1, 'the subagent rolls into its session');
  assert.strictEqual(a.sessions[0].agents.length, 1);
  assert.strictEqual(a.totals.monthUsd, C.usd(a.totals.units * 30));
  // 23:30 UTC is the next day in Tokyo.
  const s = script({ start: Date.parse('2026-10-05T23:30:00Z') });
  s.turn({ inp: 10, gap: 0 });
  assert.strictEqual(analyseScripts([s], { tz: 'Asia/Tokyo' }).byDay[0].day, '2026-10-06');
  assert.strictEqual(analyseScripts([s], { tz: 'UTC' }).byDay[0].day, '2026-10-05');
});

/* ---------------- the waste finder ---------------- */

test('cache went cold: a long pause before a big rewrite is found and priced; a short pause, a small rewrite or a compaction is not', () => {
  const s = script({});
  s.turn({ w5: 180000, out: 200 });
  s.pause(7 * MIN);
  s.turn({ w5: 182000, cr: 0, out: 200 });
  const a = analyseScripts([s]);
  const f = find(a, 'cold');
  assert.ok(f, 'found');
  assert.strictEqual(f.tokens, 180000, 'the context that was cached before the pause');
  assert.strictEqual(f.units, 180000 * (500 - 20), 'written at $5/M instead of read at $0.20/M');
  assert.match(f.headline, /You paused 7 min in ‘proj’; 180K tokens of context were written again \(\$0\.86\)/);
  const short = script({}); short.turn({ w5: 180000 }); short.pause(3 * MIN); short.turn({ w5: 180000 });
  assert.ok(!find(analyseScripts([short]), 'cold'), 'under 5 minutes');
  const small = script({}); small.turn({ w5: 5000 }); small.pause(9 * MIN); small.turn({ w5: 5100 });
  assert.ok(!find(analyseScripts([small]), 'cold'), 'a small context');
  const comp = script({}); comp.turn({ w5: 180000 }); comp.pause(8 * MIN); comp.compact(); comp.turn({ w5: 30000 });
  assert.ok(!find(analyseScripts([comp]), 'cold'), 'a compaction rewrites on purpose');
  const hour = script({}); hour.turn({ w1: 180000 }); hour.pause(20 * MIN); hour.turn({ cr: 180000, w1: 200 });
  assert.ok(!find(analyseScripts([hour]), 'cold'), '1-hour caching survives a 20 minute pause');
});

test('re-reading: the same file read 3+ times unchanged is found; reads after an edit, or of another range, are not', () => {
  const s = script({});
  for (let i = 0; i < 4; i++) { s.turn({ tool: 'Read', input: { file_path: '/w/proj/src/routes.ts' }, chars: 20000, cr: 50000 }); s.turn({ cr: 50000 }); }
  const f = find(analyseScripts([s]), 'reread');
  assert.ok(f);
  assert.strictEqual(f.tokens, 3 * 5000, 'three repeats of 5,000 tokens');
  assert.match(f.headline, /routes\.ts was read 4 times/);
  const ed = script({});
  for (let i = 0; i < 4; i++) { ed.turn({ tool: 'Read', input: { file_path: '/w/proj/a.ts' }, chars: 20000 }); ed.turn({ tool: 'Edit', input: { file_path: '/w/proj/a.ts' } }); }
  assert.ok(!find(analyseScripts([ed]), 'reread'), 'edited between reads');
  const rg = script({});
  for (let i = 0; i < 5; i++) rg.turn({ tool: 'Read', input: { file_path: '/w/proj/a.ts', offset: i * 100, limit: 100 }, chars: 4000 });
  assert.ok(!find(analyseScripts([rg]), 'reread'), 'different ranges');
  const two = script({});
  for (let i = 0; i < 2; i++) two.turn({ tool: 'Read', input: { file_path: '/w/proj/a.ts' }, chars: 20000 });
  assert.ok(!find(analyseScripts([two]), 'reread'), 'twice is not a pattern');
});

test('giant tool output: one result over 40K characters is priced as carried for the rest of the session; a big one under it is not', () => {
  const s = script({});
  s.turn({ tool: 'Bash', input: { command: 'npm test -- --verbose' }, chars: 200000 });
  for (let i = 0; i < 10; i++) s.turn({ cr: 100000 });
  const f = find(analyseScripts([s]), 'giant');
  assert.ok(f);
  assert.strictEqual(f.tokens, 50000 - 2000);
  assert.strictEqual(f.units, 48000 * (500 + 10 * 20), 'one cache write, then a read on each of the 10 later turns');
  assert.match(f.headline, /`npm test -- --verbose` returned 50K tokens .* carried for 10 more turns .*tail or grep -c/);
  const ok = script({}); ok.turn({ tool: 'Bash', input: { command: 'ls' }, chars: 39000 }); ok.turn({});
  assert.ok(!find(analyseScripts([ok]), 'giant'));
  const cut = script({}); cut.turn({ tool: 'Bash', input: { command: 'cat big' }, chars: 200000 }); cut.turn({}); cut.compact(); for (let i = 0; i < 10; i++) cut.turn({});
  assert.strictEqual(find(analyseScripts([cut]), 'giant').units, 48000 * (500 + 1 * 20), 'a compaction ends the carrying');
});

test('context bloat: turns after a session passes 150K without compacting; a compaction ends it; a session under it is clean', () => {
  const s = script({});
  [100000, 160000, 200000, 250000].forEach((c) => s.turn({ cr: c, out: 50 }));
  const f = find(analyseScripts([s]), 'bloat');
  assert.ok(f);
  assert.strictEqual(f.tokens, 50000 + 100000, 'the two turns after the crossing, above the line');
  assert.strictEqual(f.units, 50000 * 20 + 100000 * 20, 'at the cache-read rate those turns paid');
  assert.match(f.headline, /ran 2 turns above 150K tokens of context, peaking at 250K/);
  const c = script({});
  [100000, 160000].forEach((x) => c.turn({ cr: x })); c.compact(); [30000, 60000].forEach((x) => c.turn({ w5: x }));
  assert.ok(!find(analyseScripts([c]), 'bloat'), 'compacted right after crossing');
  const lean = script({}); [50000, 90000, 140000].forEach((x) => lean.turn({ cr: x }));
  assert.ok(!find(analyseScripts([lean]), 'bloat'));
});

test('loops: the same failing call 3+ times is found with every retry’s turn priced; two failures, or three successes, are not', () => {
  const s = script({});
  const cmd = { command: 'terraform plan -out=tfplan' };
  for (let i = 0; i < 4; i++) s.turn({ tool: 'Bash', input: cmd, err: true, cr: 1e6, out: 0 });
  const f = find(analyseScripts([s]), 'loop');
  assert.ok(f);
  assert.strictEqual(f.units, 3 * 1e6 * 20, 'three retries at $0.20 each');
  assert.match(f.headline, /`terraform plan -out=tfplan` failed the same way 4 times .* the 3 retries cost \$0\.60/);
  const two = script({}); for (let i = 0; i < 2; i++) two.turn({ tool: 'Bash', input: cmd, err: true, cr: 1e6 });
  assert.ok(!find(analyseScripts([two]), 'loop'));
  const okk = script({}); for (let i = 0; i < 3; i++) okk.turn({ tool: 'Bash', input: cmd, err: false, cr: 1e6 });
  assert.ok(!find(analyseScripts([okk]), 'loop'));
  const diff = script({}); for (let i = 0; i < 3; i++) diff.turn({ tool: 'Bash', input: { command: `make ${i}` }, err: true, cr: 1e6 });
  assert.ok(!find(analyseScripts([diff]), 'loop'), 'three different commands');
});

test('big model for small turns: Opus turns that only read or search, re-priced at Sonnet 5.5 as an upper bound; Sonnet, or real work, is not', () => {
  const s = script({});
  for (let i = 0; i < 10; i++) s.turn({ tool: 'Grep', input: { pattern: `p${i}` }, cr: 1e6, out: 100 });
  const f = find(analyseScripts([s]), 'model');
  assert.ok(f);
  assert.strictEqual(f.units, 10 * ((1e6 * 20 + 100 * 2000) - (1e6 * 20 + 100 * 1000)), 'the output price difference (cache reads cost the same)');
  assert.match(f.headline, /could have done them for up to/);
  const son = script({ model: 'claude-sonnet-5-5' }); for (let i = 0; i < 10; i++) son.turn({ tool: 'Grep', input: { pattern: `p${i}` }, cr: 1e6 });
  assert.ok(!find(analyseScripts([son]), 'model'));
  const work = script({}); for (let i = 0; i < 10; i++) work.turn({ tool: 'Edit', input: { file_path: `/w/f${i}` }, cr: 1e6, out: 2000 });
  assert.ok(!find(analyseScripts([work]), 'model'));
});

test('duplicate subagent work: two subagents of one session running the same search is found; one subagent, or two sessions, is not', () => {
  const mk = (sid, agent) => {
    const s = script({ sid, agent });
    s.turn({ tool: 'Grep', input: { pattern: 'invoiceTotal', path: '/w/proj/src' }, chars: 8000 });
    s.turn({ tool: 'Read', input: { file_path: '/w/proj/package.json' }, chars: 4000 });
    s.turn({});
    s.file = `p/${sid}/subagents/agent-${agent}.jsonl`;
    return s;
  };
  const f = find(analyseScripts([mk('s1', 'a1'), mk('s1', 'a2')]), 'dupagent');
  assert.ok(f);
  assert.strictEqual(f.tokens, 2000 + 1000);
  assert.match(f.headline, /2 subagents in ‘proj’ ran 2 reads and searches another one had already run/);
  assert.ok(!find(analyseScripts([mk('s1', 'a1')]), 'dupagent'));
  assert.ok(!find(analyseScripts([mk('s1', 'a1'), mk('s2', 'a2')]), 'dupagent'), 'different sessions');
});

test('findings rank by dollars; a tool result counts toward one finding only; the avoidable share is capped and stated', () => {
  const s = script({});
  for (let i = 0; i < 3; i++) { s.turn({ tool: 'Read', input: { file_path: '/w/proj/huge.json' }, chars: 200000 }); s.turn({}); }
  const a = analyseScripts([s]);
  const ids = kinds(a);
  assert.ok(ids.includes('reread'), 'the repeats are re-reads');
  assert.strictEqual(find(a, 'giant').count, 1, 'only the first read is giant output: the repeats are not counted twice');
  for (let i = 1; i < a.findings.length; i++) assert.ok(a.findings[i - 1].units >= a.findings[i].units);
  assert.ok(a.totals.avoidPct <= 95);
  assert.ok(C.METHOD.length >= 8 && C.METHOD.join(' ').includes('estimate'));
});

/* ---------------- the example team ---------------- */

test('the example team is deterministic, three people, and shows every finding', () => {
  const g1 = D.generate('2026-10-06');
  const g2 = D.generate('2026-10-06');
  assert.strictEqual(JSON.stringify(g1), JSON.stringify(g2), 'same anchor, same lines');
  assert.deepStrictEqual(g1.people.map((p) => p.name), ['Maya', 'Dev', 'Sam']);
  assert.ok(g1.people.every((p) => p.files.some((f) => /subagents\//.test(f.path))) === false, 'not everyone uses subagents');
  const col = C.createCollector();
  D.feed(col, '2026-10-06');
  const ds = col.finish();
  assert.ok(ds.stats.duplicates > 1000, 'the example is written in the streamed shape, so the dedupe runs on it');
  const a = C.analyse(ds, null, { tz: 'UTC' });
  assert.deepStrictEqual(kinds(a), C.KIND_IDS.slice().sort(), 'every finding');
  assert.ok(a.totals.avoidPct >= 15 && a.totals.avoidPct <= 40, `a believable share: ${a.totals.avoidPct}%`);
  assert.ok(a.totals.subUsd > 0 && a.totals.subUsd < a.totals.usd / 4);
  assert.strictEqual(a.people.length, 3);
  assert.ok(a.people.every((p) => p.top), 'each person has a top finding');
  assert.strictEqual(a.byDay.length, 7);
  const again = C.analyse((() => { const c = C.createCollector(); D.feed(c, '2026-10-06'); return c.finish(); })(), null, { tz: 'UTC' });
  assert.strictEqual(again.totals.units, a.totals.units);
  const t0 = Date.now(); const c3 = C.createCollector(); D.feed(c3, '2026-10-06'); C.analyse(c3.finish(), null, { tz: 'UTC' });
  assert.ok(Date.now() - t0 < 4000, 'built and analysed in a few seconds at most');
});

/* ---------------- the team ---------------- */

test('team merge: several people’s folders, each under a name; totals add up; per-person days and top findings', () => {
  const m = script({ sid: 'm1' }); m.turn({ inp: 1e6 }); m.who = 'Maya';
  const d = script({ sid: 'd1' }); d.turn({ inp: 2e6 }); d.who = 'Dev';
  const shared = script({ sid: 'm1' }); shared.turn({ inp: 1e6 }); shared.who = 'Dev'; // the same response, copied into Dev's folder
  const a = analyseScripts([m, d, shared]);
  assert.deepStrictEqual(a.people.map((p) => [p.name, p.usd]), [['Maya', 4], ['Dev', 8]], 'a response seen twice counts once, for whoever had it first');
  assert.strictEqual(a.totals.usd, 12);
  assert.deepStrictEqual(a.byDay[0].people, [4, 8]);
  assert.strictEqual(a.sessions.length, 2);
});

/* ---------------- exports ---------------- */

test('CSV: quoted when it must be, quotes doubled, formula-looking cells defused; one row per session', () => {
  assert.strictEqual(C.csvField('plain'), 'plain');
  assert.strictEqual(C.csvField('a,b'), '"a,b"');
  assert.strictEqual(C.csvField('say "hi"'), '"say ""hi"""');
  assert.strictEqual(C.csvField('line\nbreak'), '"line\nbreak"');
  assert.strictEqual(C.csvField('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.strictEqual(C.csvField('-12.5'), '-12.5', 'a negative number stays a number');
  assert.strictEqual(C.csvField('+cmd'), "'+cmd");
  const a = C.analyse(shopDataset(), null, { tz: 'UTC' });
  const csv = C.sessionsCsv(a);
  const rows = csv.trim().split('\r\n');
  assert.strictEqual(rows.length, 2);
  assert.match(rows[0], /^session,person,project,start_utc/);
  assert.ok(rows[1].includes(',Tess,shop,'));
  const hostile = analyseScripts([(() => { const s = script({ cwd: '/w/=evil,"proj"' }); s.turn({ inp: 10 }); return s; })()]);
  assert.ok(C.sessionsCsv(hostile).includes('"\'=evil,""proj"""'));
  assert.match(C.findingsCsv(C.analyse(shopDataset(), null, { tz: 'UTC' })), /^finding,person,project,session,when_utc,what,tokens,estimate_usd,detail\r\n/);
});

test('Markdown: totals, findings with fixes, breakdowns and the method; transcript strings cannot become markup or links', () => {
  const col = C.createCollector();
  D.feed(col, '2026-10-06');
  const a = C.analyse(col.finish(), null, { tz: 'UTC' });
  const md = C.toMarkdown(a);
  assert.match(md, /^# Burnrate/);
  assert.match(md, /Looks avoidable:\*\* about \d+%/);
  assert.match(md, /## What to fix first/);
  assert.match(md, /## How this was worked out/);
  assert.match(md, /list prices as of 2026-09-25/);
  const ev = readHostile();
  const md2 = C.toMarkdown(ev);
  const outsideCode = md2.replace(/`[^`\n]*`/g, '');
  assert.ok(!/<img|<script/.test(outsideCode), 'angle brackets outside code spans are entities');
  assert.ok(/&lt;img/.test(outsideCode), '...shown as text');
  assert.ok(!/\u202e/.test(md2));
});

/* ---------------- hostile strings ---------------- */

function readHostile() {
  const col = C.createCollector();
  readInto(col, path.join(FIX, '-tmp-evil', '99999999-8888-4777-8666-555555555555.jsonl'), '<b>Eve</b>\u202e');
  return C.analyse(col.finish(), null, { tz: 'UTC' });
}
test('hostile paths, commands and names: invisible characters stripped, markup kept as text for the page to escape', () => {
  const a = readHostile();
  const json = JSON.stringify(a);
  assert.ok(!/[\u202e\u0007]/.test(json), 'no bidi override or control character survives');
  assert.ok(a.findings.length >= 2, 'the re-read and the loop are still found');
  assert.ok(a.people[0].wasteUsd <= a.people[0].usd && a.sessions.every((x) => x.wasteUsd <= x.usd), 'what looks avoidable never exceeds what was spent');
  assert.strictEqual(a.people[0].name, '<b>Eve</b>', 'a name is cleaned, not trusted');
  const label = find(a, 'loop').instances[0].label;
  assert.ok(label.includes('<img'), 'kept as text...');
  assert.strictEqual(C.esc(label).includes('<'), false, '...and escaped by the one esc() the page uses');
  assert.strictEqual(C.esc('<a href="x" onclick=\'y\'>&'), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
});

/* ---------------- what "Write our fixes" sends ---------------- */

test('the fixes summary: numbers, tool names and file basenames - no path, no command, no message text, no code', () => {
  for (const a of [C.analyse(shopDataset(), null, { tz: 'UTC' }), readHostile(), (() => { const c = C.createCollector(); D.feed(c, '2026-10-06'); return C.analyse(c.finish(), null, { tz: 'UTC' }); })()]) {
    const s = C.fixesSummary(a);
    const json = JSON.stringify(s);
    for (const m of ['MESSAGE_TEXT_MARKER', 'PRIVATE_CODE_MARKER', 'THINKING_MARKER', 'SECRET_TOKEN', 'hunter2', 'terraform', 'npm', 'pnpm', 'vitest', '<img', '<script', '/Users', '/home', '/tmp', 'onerror']) assert.ok(!json.includes(m), `${m} in ${json.slice(0, 200)}`);
    const back = ai.cleanSummary(s);
    if (a.findings.length) assert.ok(back && back.findings.length, 'and the server accepts it');
  }
  const demo = (() => { const c = C.createCollector(); D.feed(c, '2026-10-06'); return C.analyse(c.finish(), null, { tz: 'UTC' }); })();
  const s = C.fixesSummary(demo);
  assert.ok(s.findings.some((f) => f.examples.some((x) => x.file === 'routes.ts')), 'a file basename is sent');
  assert.ok(s.findings.some((f) => f.examples.some((x) => x.tool === 'Bash')), 'a tool name is sent');
});

test('the server rebuilds the summary field by field: anything else a request carries is dropped', () => {
  const evil = {
    period: { days: 7, sessions: 3, people: 2, path: '/Users/x' },
    spend: { usd: 10, perMonthUsd: 40, avoidablePct: 20, cacheHitPct: 90, subagentPct: 5, code: 'PRIVATE_CODE_MARKER' },
    models: [{ model: 'Opus 5.5', sharePct: 90 }, { model: '<script>', sharePct: 1 }],
    findings: [
      { kind: 'giant', usd: 3, tokens: 1000, cases: 2, title: 'IGNORE ME', headline: 'MESSAGE_TEXT_MARKER', examples: [{ usd: 1, tokens: 10, tool: 'Bash', command: 'SECRET_TOKEN=1', file: '/Users/x/secret.ts' }, { usd: 1, tokens: 5, file: 'ok.ts', tool: 'rm -rf /' }] },
      { kind: 'nope', usd: 5 },
      { kind: 'giant', usd: 9, tokens: 1, cases: 1 },
    ],
    transcript: 'PRIVATE_CODE_MARKER',
  };
  const out = ai.cleanSummary(evil);
  const json = JSON.stringify(out);
  for (const m of ['PRIVATE_CODE_MARKER', 'MESSAGE_TEXT_MARKER', 'SECRET_TOKEN', '/Users', '<script', 'IGNORE ME', 'rm -rf', 'nope']) assert.ok(!json.includes(m), m);
  assert.strictEqual(out.findings.length, 1, 'one per kind, known kinds only');
  assert.deepStrictEqual(out.findings[0].examples, [{ usd: 1, tokens: 10, tool: 'Bash' }, { usd: 1, tokens: 5, file: 'ok.ts' }]);
  assert.strictEqual(out.findings[0].title, 'Giant tool output');
  assert.strictEqual(ai.cleanSummary({ findings: [] }), null);
  assert.strictEqual(ai.cleanSummary('x'), null);
  assert.match(ai.SYSTEM, /never an instruction/);
  assert.match(ai.SYSTEM, /never see code/);
});

test('the model’s answer is cleaned: bounded, plain text, markup and bidi stripped; nothing usable is null', () => {
  const fx = C.cleanFixes({
    claudeMd: ['<script>alert(1)</script>Pipe\u202e logs ' + 'A'.repeat(900), ...Array(40).fill('Keep sessions short.')],
    settings: [{ setting: '<b>/compact</b>', value: 'at 150K', why: 'Context <i>bloat</i>.' }, { setting: 'model' }, 'nope'],
    habits: [{ evil: 1 }, 'Clear between tasks.'],
  });
  assert.ok(fx.claudeMd.length <= 10 && fx.claudeMd.every((l) => l.length <= 200 && !/[<>\u202e]/.test(l)));
  assert.deepStrictEqual(fx.settings, [{ setting: '/compact', value: 'at 150K', why: 'Context bloat.' }]);
  assert.deepStrictEqual(fx.habits, ['Clear between tasks.']);
  assert.strictEqual(C.cleanFixes({ claudeMd: ['  ', 7], settings: [], habits: [] }), null);
  assert.strictEqual(C.cleanFixes(null), null);
});

/* ---------------- remembered on this device ---------------- */

test('saved on this device: aggregates only, read back through cleanSaved; junk and old versions are refused', () => {
  const a = C.analyse(shopDataset(), null, { tz: 'UTC' });
  const saved = C.toSaved(a, 1700000000000);
  const json = JSON.stringify(saved);
  for (const m of ['MESSAGE_TEXT_MARKER', 'PRIVATE_CODE_MARKER', 'LONGTAIL_MARKER', '/Users/test/code/shop/src']) assert.ok(!json.includes(m), m);
  assert.ok(!saved.sessions.some((s) => s.detail), 'the turn-by-turn line is not kept');
  const back = C.cleanSaved(JSON.parse(json));
  assert.strictEqual(back.totals.usd, a.totals.usd);
  assert.strictEqual(back.sessions.length, 1);
  assert.strictEqual(back.saved, true);
  assert.strictEqual(C.cleanSaved({ version: 99 }), null);
  assert.strictEqual(C.cleanSaved('x'), null);
  const tampered = JSON.parse(json);
  tampered.findings[0] = Object.assign({}, tampered.findings[0] || {}, { id: 'cold', headline: '<img src=x>\u202e', instances: [{ label: 'x\u202e', usd: 'NaN' }] });
  tampered.people[0].name = '\u202eEvil';
  const t2 = C.cleanSaved(tampered);
  assert.ok(!/\u202e/.test(JSON.stringify(t2)));
  assert.strictEqual(t2.findings[0].instances[0].usd, 0);
});

/* ---------------- static checks ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface in both themes; chart marks 3:1', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2']) for (const fg of ['text', 'muted', 'link', 'err']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    assert.ok(ratio(t.text, t['accent-soft']) >= 4.5 && ratio(t.link, t['accent-soft']) >= 4.5, `${name} on the avoidable box`);
    assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, `${name} accent-ink on accent: ${ratio(t['accent-ink'], t.accent).toFixed(2)}`);
    assert.ok(ratio(t.good, t['good-bg']) >= 4.5 && ratio(t.text, t['good-bg']) >= 4.5, `${name} the fix box`);
    assert.ok(ratio(t['strip-ink'], t.strip) >= 4.5 && ratio(t['strip-muted'], t.strip) >= 4.5 && ratio(t['strip-btn-ink'], t['strip-btn']) >= 4.5, `${name} the source strip`);
    assert.ok(ratio(t.text, t['code-bg']) >= 4.5, `${name} code`);
    assert.ok(ratio(t.bg, t.text) >= 4.5, `${name} toast and tooltip (inverted)`);
    for (const s of ['s1', 's2', 'cold', 'accent']) assert.ok(ratio(t[s], t.card) >= 3, `${name} ${s} mark on a card: ${ratio(t[s], t.card).toFixed(2)}`);
  }
  // The hero, the summary card and the theme colour are fixed colours.
  for (const [fg, bg] of [['#ffffff', '#1f1b2e'], ['#e9e2f2', '#3b1d18'], ['#e9e2f2', '#7a2a0c'], ['#fed7aa', '#1f1b2e'], ['#2a1205', '#fdba74'], ['#ffffff', '#7a2a0c'], ['#cfc9e8', '#3b1d18']]) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, only known requests, nothing runs after a response', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error) =/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...js.matchAll(/api\('(GET|POST)', '([^']+)'/g)].map((m) => m[2]);
  assert.deepStrictEqual([...new Set(calls)].sort(), ['api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/fixes', 'api/me'], 'the page asks for nothing else - no route takes a transcript');
  assert.ok(/api\('POST', 'api\/fixes', \{ summary: summary \}\)/.test(js), 'the fixes call sends the summary it showed, and only that');
  assert.ok(/'api\/auth\/' \+ \(mode === 'register'/.test(js), 'sign-in posts the form');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js), 'no email address in the page');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/setInterval|setTimeout/.test(server), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js', 'public/burn-core.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|summary|raw|line)/.test(src), `${f} logs a body`);
  }
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod, env] of [['./lib/store', { BURNRATE_MEMORY: '1' }], ['./lib/fakeai', { BURNRATE_FAKE_AI: '1' }], ['./server', { BURNRATE_FAKE_AI: '1', BURNRATE_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, BURNRATE_MEMORY: '', BURNRATE_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

/* ---------------- over HTTP ---------------- */

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
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) { data = { text }; }
    return { status: res.status, data, text, headers: res.headers };
  };
}
async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const demoSummary = () => { const c = C.createCollector(); D.feed(c, '2026-10-06'); return C.fixesSummary(C.analyse(c.finish(), null, { tz: 'UTC' })); };
const BIG = { summary: { pad: 'x'.repeat(70 * 1024) } };

test('signed out: the page works with zero model calls; the fixes route answers 401 before reading any body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.strictEqual(meta.prices.asOf, '2026-09-25');
  assert.strictEqual(meta.prices.rows.length, C.DEFAULT_PRICES.length);
  for (const f of ['burn-core.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/fixes', { summary: demoSummary() })).status, 401);
  assert.strictEqual((await anon('POST', '/api/fixes', BIG)).status, 401, 'the gate answers before the parser, so not 413');
  for (const p of ['/api/upload', '/api/transcripts', '/api/analyse', '/api/sessions']) assert.strictEqual((await anon('POST', p, { lines: ['x'] })).status, 404, `${p}: there is no route for a transcript`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered route: requireUser, requireBudget, requireDailyCap, THEN its parser; one model client call in the server', () => {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/api/fixes' && l.route.methods.post);
  assert.deepStrictEqual(layer.route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one metered call, nowhere else');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
});

test('write our fixes: input checked before any spend, one metered call, only the summary reaches the model, the answer cleaned', async () => {
  const ana = await register('ana.lead@example.com');
  const calls = await modelCalls();
  assert.strictEqual((await ana('POST', '/api/fixes', {})).status, 400);
  assert.strictEqual((await ana('POST', '/api/fixes', { summary: { findings: [] } })).status, 400);
  assert.strictEqual((await ana('POST', '/api/fixes', BIG)).status, 413, 'over the 64 KB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const sent = demoSummary();
  sent.transcript = 'PRIVATE_CODE_MARKER';
  sent.findings[0].headline = 'MESSAGE_TEXT_MARKER';
  sent.findings[0].examples.push({ usd: 1, tokens: 1, command: 'SECRET_TOKEN=x npm test', file: '/Users/ana/secret/path.ts' });
  const n0 = fakeCalls.length;
  const r = await ana('POST', '/api/fixes', { summary: sent });
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(r.data.fixes.claudeMd.length >= 1 && r.data.fixes.settings.length >= 1 && r.data.fixes.habits.length >= 1);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  assert.strictEqual(fakeCalls.length, n0 + 1);
  const req = fakeCalls[fakeCalls.length - 1];
  assert.strictEqual(req.model, 'claude-haiku-4-5', 'a free account runs Haiku');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'propose_fixes' });
  const body = JSON.stringify(req.messages);
  for (const m of ['PRIVATE_CODE_MARKER', 'MESSAGE_TEXT_MARKER', 'SECRET_TOKEN', 'npm test', '/Users', 'transcript', 'headline']) assert.ok(!body.includes(m), `${m} reached the model`);
  assert.ok(body.includes('routes.ts'), 'a file basename does');
  assert.strictEqual(JSON.stringify(r.data.sent), JSON.stringify(ai.cleanSummary(sent)), 'the answer says exactly what was sent');
  // Hostile and failing answers.
  const withFile = (name) => { const s = demoSummary(); s.findings[0].examples = [{ usd: 1, tokens: 1, file: name }]; return { summary: s }; };
  const inj = await ana('POST', '/api/fixes', withFile('INJECT.ts'));
  assert.strictEqual(inj.status, 200);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi reaches the page');
  assert.ok(inj.data.fixes.claudeMd.length <= 10);
  const blank = await ana('POST', '/api/fixes', withFile('BLANK.ts'));
  assert.deepStrictEqual([blank.status, /nothing usable/.test(blank.data.error)], [422, true]);
  assert.match((await ana('POST', '/api/fixes', withFile('MAXTOKENS.ts'))).data.error, /ran long/);
  const up = await ana('POST', '/api/fixes', withFile('UPSTREAM401.ts'));
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await ana('POST', '/api/fixes', withFile('UPSTREAM529.ts'));
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('an unconfirmed free account gets the verify-email 403 before any model call or big body; out of credit is a 402, not a 413', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/fixes', { summary: demoSummary() });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/burnrate/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/fixes', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/fixes', { summary: demoSummary() })).status, 402);
  assert.strictEqual((await cal('POST', '/api/fixes', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
});

test('nothing is stored server-side: no summary, no finding, no answer - only the shared account and its usage rows', async () => {
  const dump = identityStore._dump();
  for (const m of ['routes.ts', 'propose_fixes', 'claudeMd', 'Context bloat', 'Pipe long command output', 'PRIVATE_CODE_MARKER']) assert.ok(!dump.includes(m), `${m} was stored`);
  const cols = JSON.parse(dump).map(([p]) => p).sort();
  assert.ok(cols.every((c) => ['users', 'usage', 'events', 'control'].some((k) => c.toLowerCase().includes(k.toLowerCase()))), `only account collections: ${cols.join(', ')}`);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/require\('\.\/lib\/store'\)\.store|store\.(set|merge|add|transact)\(/.test(src), 'the server has no app store to write to');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/burnrate', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/burnrate`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
