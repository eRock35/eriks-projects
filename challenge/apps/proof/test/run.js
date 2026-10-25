// Pure rules first (every parser, claim extraction, every verdict, the
// patterns, ordering, honesty, bounds, escaping), then the page's own
// promises, then end to end against the memory identity store and the fake
// model:
//   PROOF_MEMORY=1 PROOF_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /proof, the way the
// lab mounts it, so the auth cookie, the budget gate and the metered route's
// parser order are exercised as deployed. Model calls are counted from the
// identity's usage rows, and what reached "the model" is read from the fake
// client's own log.
//
// Every run here is SYNTHETIC - the built-in demos, or small fixtures written
// by hand in the shapes the real tools write. Nothing is a real project.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.PROOF_MEMORY !== '1' || process.env.PROOF_FAKE_AI !== '1') {
  console.error('run with PROOF_MEMORY=1 PROOF_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, fakeCalls } = require('../server');
const C = require('../public/proof-core');
const D = require('../public/demo');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- helpers: runs written as a tool-call log ---------------- */

const T = {
  bash: (command, output = '', exit = 0) => ({ type: 'tool_call', tool: 'bash', input: { command }, output, exit_code: exit }),
  edit: (p, oldStr, newStr, ok = true) => ({ type: 'tool_call', tool: 'edit_file', input: { path: p, old_str: oldStr, new_str: newStr }, output: ok ? 'edited' : 'old_str not found in file', ok }),
  write: (p, content) => ({ type: 'tool_call', tool: 'write_file', input: { path: p, content }, output: 'written', ok: true }),
  read: (p, content) => ({ type: 'tool_call', tool: 'read_file', input: { path: p }, output: content, ok: true }),
  say: (content) => ({ role: 'assistant', content }),
  user: (content) => ({ role: 'user', content }),
};
const jest = (passed, failed = 0, skipped = 0) => `> app@1.0.0 test\n> jest\n\nTests:       ${[failed ? `${failed} failed` : '', skipped ? `${skipped} skipped` : '', `${passed} passed`].filter(Boolean).join(', ')}, ${passed + failed + skipped} total\nTime:        1.2 s`;
const mk = (...items) => C.parseRun(items.map((o) => JSON.stringify(o)).join('\n'));
const check = (items, opts) => C.analyze(mk(...items), opts || {});
const claim = (A, kind) => A.claims.find((c) => c.kind === kind);
const crit = (A, i) => A.criteria[i];
const rules = (A) => A.findings.map((f) => f.rule);
const demo = (which) => { const d = D[which](); const run = C.parseRun(d.text, { name: d.name }); return { d, run, A: C.analyze(run, { criteria: d.criteria }) }; };

/* ---------------- the demos ---------------- */

test('"The confident one": 1 of 7 backed, tests never re-run after the last edit, and every planted problem found', () => {
  const { run, A } = demo('confident');
  assert.strictEqual(run.format, 'claude-jsonl');
  assert.strictEqual(A.verdict.outcome, '1 of 7 claims backed - tests were never re-run after the last edit');
  assert.ok(A.verdict.score < 30 && A.verdict.band === 'bad', 'score ' + A.verdict.score);
  const by = Object.fromEntries(A.claims.map((c) => [c.kind, c.verdict]));
  assert.deepStrictEqual(by, { fixed: 'partly', tests: 'none', lint: 'contradicted', files: 'contradicted', verified: 'partly', commit: 'backed', pr: 'none' });
  assert.ok(claim(A, 'tests').stale && /step 10/.test(claim(A, 'tests').why) && /step 13/.test(claim(A, 'tests').why));
  assert.match(claim(A, 'lint').why, /\|\| true` hid the failure/);
  assert.match(claim(A, 'files').why, /4 files, not 2/);
  assert.match(claim(A, 'pr').why, /never pushed/);
  assert.deepStrictEqual(A.criteria.map((c) => [c.kind, c.verdict]), [['tests', 'none'], ['scope', 'contradicted'], ['noskip', 'contradicted'], ['pr', 'none']]);
  assert.match(crit(A, 1).why, /src\/shared\/format\.ts/);
  assert.deepStrictEqual(rules(A).sort(), ['no-verify', 'or-true', 'skip-test', 'swallow-code'].sort(), rules(A).join(','));
  assert.deepStrictEqual(A.errors.map((e) => e.n), [14], 'the type error it walked past - the failed test runs it later re-ran are not listed');
  assert.deepStrictEqual(A.verdict.checks.map((c) => c.title), ['Run the whole test suite yourself', 'Un-skip the test: `applies discount before tax`', 'Check the changes outside the scope']);
  assert.ok(run.skipped.summary === 1 && run.skipped.bookkeeping === 1 && run.skipped.thinking === 1, JSON.stringify(run.skipped));
});

test('"The honest one": every claim backed, every criterion met, nothing flagged, and its admission is kept', () => {
  const { A } = demo('honest');
  assert.ok(A.claims.length >= 8 && A.claims.every((c) => c.verdict === 'backed'), A.claims.map((c) => c.kind + ':' + c.verdict + ':' + c.why).join('\n'));
  assert.ok(A.criteria.every((c) => c.verdict === 'backed'));
  assert.deepStrictEqual(A.findings, []);
  assert.deepStrictEqual(A.errors, [], 'the failing test run it then fixed is addressed, the grep with no match is not an error');
  assert.strictEqual(A.verdict.score, 100);
  assert.match(A.verdict.outcome, /^\d+ of \d+ claims backed - every claim has a receipt$/);
  assert.ok(A.admissions.some((a) => /README/.test(a)));
  assert.ok(A.verdict.checks.some((c) => /didn.t do/.test(c.title)));
  assert.strictEqual(claim(A, 'pr').verdict, 'backed');
  assert.match(claim(A, 'tests').why, /44 passed/);
});

/* ---------------- every parser, on hand-written fixtures in real shapes ---------------- */

test('Claude Code .jsonl: meta, bookkeeping, thinking and sidechain kept apart; exit codes, durations, cwd-relative paths', () => {
  const cwd = '/home/u/proj';
  const L = [
    { type: 'summary', summary: 'x', leafUuid: 'l' },
    { type: 'user', isMeta: true, message: { role: 'user', content: '<command-name>/clear</command-name>' }, uuid: 'a0', sessionId: 's', cwd, timestamp: '2026-10-24T10:00:00.000Z' },
    { type: 'user', message: { role: 'user', content: 'Make the slug helper handle unicode' }, uuid: 'a1', sessionId: 's', cwd, timestamp: '2026-10-24T10:00:01.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npx vitest run' } }] }, uuid: 'a2', sessionId: 's', cwd, timestamp: '2026-10-24T10:00:02.000Z' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Exit code 1\n FAIL  test/slug.test.ts > slug > keeps accents\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 11 passed (12)', is_error: true }] }, uuid: 'a3', sessionId: 's', cwd, timestamp: '2026-10-24T10:00:06.500Z', toolUseResult: { stdout: '', stderr: '' } },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent notes' }] }, uuid: 'a4', sessionId: 's', cwd, timestamp: '2026-10-24T10:00:07.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: `${cwd}/src/slug.ts`, old_string: "  return s.replace(/[^a-z]/g, '-');", new_string: "  return s.normalize('NFKD').replace(/[^a-z0-9]/gi, '-');" } }] }, uuid: 'a5', sessionId: 's', cwd, timestamp: '2026-10-24T10:00:08.000Z' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'The file has been updated.', is_error: false }] }, uuid: 'a6', sessionId: 's', cwd, timestamp: '2026-10-24T10:00:08.200Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npx vitest run' } }] }, uuid: 'a7', sessionId: 's', cwd, timestamp: '2026-10-24T10:00:09.000Z' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: ' Test Files  3 passed (3)\n      Tests  12 passed (12)', is_error: false }] }, uuid: 'a8', sessionId: 's', cwd, timestamp: '2026-10-24T10:00:13.000Z' },
    { type: 'file-history-snapshot', messageId: 'm', snapshot: {} },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed `src/slug.ts` - all 12 tests pass.' }] }, uuid: 'a9', sessionId: 's', cwd, timestamp: '2026-10-24T10:00:14.000Z' },
  ];
  const run = C.parseRun(L.map((o) => JSON.stringify(o)).join('\n') + '\nnot json at all\n');
  assert.strictEqual(run.format, 'claude-jsonl');
  assert.strictEqual(run.goal, 'Make the slug helper handle unicode', 'the goal skips the /clear command');
  assert.deepStrictEqual(run.skipped, { summary: 1, meta: 1, thinking: 1, bookkeeping: 1, 'not-json': 1 });
  const tools = run.steps.filter((s) => s.kind === 'tool');
  assert.deepStrictEqual(tools.map((s) => [s.act, s.ok, s.exit]), [['test', false, 1], ['edit', true, null], ['test', true, null]]);
  assert.strictEqual(tools[0].ms, 4500, 'duration from the call to its result');
  assert.strictEqual(tools[1].path, 'src/slug.ts', 'paths relative to the session\u2019s cwd');
  assert.ok(run.steps.some((s) => s.side), 'a sidechain step is kept and marked');
  assert.match(run.finalText, /all 12 tests pass/);
  const A = C.analyze(run);
  assert.strictEqual(claim(A, 'tests').verdict, 'backed');
  assert.strictEqual(claim(A, 'fixed').verdict, 'backed');
  assert.deepStrictEqual(tools[0].result.test.failed, 1);
});

test('Claude Code terminal, pasted: prompts, ⏺ messages, Bash(...) with ⎿ output, Update(...) diffs, folded output noted', () => {
  const t = ['> fix the failing invoice test', '', '⏺ I will run the tests first.', '', '⏺ Bash(npm test)', '  ⎿  > billing@1.0.0 test', '     Tests:       1 failed, 9 passed, 10 total', '     Exit code 1', '',
    '⏺ Update(src/billing/invoice.ts)', '  ⎿  Updated src/billing/invoice.ts with 1 addition and 1 removal', '        3 -    return Math.floor(x * 100) / 100;', '        3 +    return Math.round(x * 100) / 100;', '',
    '⏺ Bash(npm test)', '  ⎿  Tests:       10 passed, 10 total', '     … +12 lines (ctrl+r to expand)', '', '⏺ All 10 tests pass now and I fixed the rounding in src/billing/invoice.ts.'].join('\n');
  const run = C.parseRun(t);
  assert.strictEqual(run.format, 'claude-terminal');
  assert.strictEqual(run.goal, 'fix the failing invoice test');
  assert.deepStrictEqual(run.steps.map((s) => s.kind + ':' + (s.act || '')), ['user:', 'say:', 'tool:test', 'tool:edit', 'tool:test', 'say:']);
  assert.match(run.steps[3].changes[0].added, /Math\.round/);
  assert.match(run.steps[3].changes[0].removed, /Math\.floor/);
  assert.strictEqual(run.steps[2].ok, false);
  assert.ok(run.notes.some((n) => /folds long output/.test(n)));
  const A = C.analyze(run);
  assert.deepStrictEqual(A.claims.map((c) => c.kind + ':' + c.verdict), ['tests:backed', 'fixed:backed']);
});

test('Anthropic messages JSON: text_editor and bash tools, tool_result errors, a swallowed except in written code', () => {
  const msgs = { system: 'You are an agent.', messages: [
    { role: 'user', content: 'Add retries to fetch_user' },
    { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'str_replace_based_edit_tool', input: { command: 'str_replace', path: 'src/user.py', old_str: '    return get(url)', new_str: '    for _ in range(3):\n        try:\n            return get(url)\n        except Exception:\n            pass' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'The file src/user.py has been edited.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'bash', input: { command: 'python -m pytest -q' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: '....F\n1 failed, 4 passed in 0.31s', is_error: true }] },
    { role: 'assistant', content: 'Done - retries added and all tests pass.' },
  ] };
  const run = C.parseRun(JSON.stringify(msgs));
  assert.strictEqual(run.format, 'anthropic');
  assert.strictEqual(run.skipped.system, 1);
  assert.deepStrictEqual(run.steps.filter((s) => s.kind === 'tool').map((s) => [s.act, s.ok]), [['edit', true], ['test', false]]);
  assert.strictEqual(run.steps.find((s) => s.act === 'test').subset, null, '`python -m pytest` is the whole suite, not a filter');
  const A = C.analyze(run);
  assert.strictEqual(claim(A, 'tests').verdict, 'contradicted');
  assert.deepStrictEqual(rules(A), ['swallow-code']);
});

test('OpenAI chat messages: tool_calls with JSON arguments, a tool reply carrying stdout and exit_code', () => {
  const oa = { messages: [
    { role: 'system', content: 'agent' }, { role: 'user', content: 'Make the build pass' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_shell', arguments: JSON.stringify({ command: 'npm run build' }) } }] },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ stdout: 'ERROR in src/app.ts\nTS2304: Cannot find name foo', stderr: '', exit_code: 1 }) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/app.ts', content: 'export const foo = 1;\n' }) } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'ok' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'run_shell', arguments: JSON.stringify({ command: 'npm run build' }) } }] },
    { role: 'tool', tool_call_id: 'c3', content: JSON.stringify({ stdout: 'webpack 5.90.0 compiled successfully in 812 ms', exit_code: 0 }) },
    { role: 'assistant', content: 'The build passes now.' },
  ] };
  const run = C.parseRun(JSON.stringify(oa));
  assert.strictEqual(run.format, 'openai');
  assert.deepStrictEqual(run.steps.filter((s) => s.kind === 'tool').map((s) => [s.act, s.exit]), [['build', 1], ['write', null], ['build', 0]]);
  const A = C.analyze(run);
  assert.strictEqual(claim(A, 'build').verdict, 'backed');
  assert.deepStrictEqual(A.errors, [], 'the failed build was re-run and passed');
});

test('OpenAI Responses items (JSON) and a Codex session (.jsonl): shell arrays, apply_patch, exit codes and wall time', () => {
  const items = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the tokenizer' }] },
    { type: 'reasoning', summary: [] },
    { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: '*** Begin Patch\n*** Update File: src/tok.py\n@@\n-    return None\n+    return tokens\n*** Add File: tests/test_tok.py\n+def test_split():\n+    assert split("a b") == ["a", "b"]\n*** End Patch' },
    { type: 'custom_tool_call_output', call_id: 'p1', output: 'Done!' },
    { type: 'function_call', name: 'shell', call_id: 's1', arguments: JSON.stringify({ command: ['bash', '-lc', 'pytest -q'] }) },
    { type: 'function_call_output', call_id: 's1', output: JSON.stringify({ output: '3 passed in 0.12s\n', metadata: { exit_code: 0, duration_seconds: 0.9 } }) },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed the tokenizer and added 1 test; all 3 tests pass.' }] },
  ];
  const r1 = C.parseRun(JSON.stringify(items));
  assert.strictEqual(r1.format, 'responses');
  const patch = r1.steps.find((s) => s.tool === 'apply_patch');
  assert.deepStrictEqual(patch.changes.map((c) => [c.path, c.kind]), [['src/tok.py', 'edit'], ['tests/test_tok.py', 'write']]);
  const t = r1.steps.find((s) => s.act === 'test');
  assert.deepStrictEqual([t.exit, t.ms, t.result.test.passed], [0, 900, 3]);
  const A1 = C.analyze(r1);
  assert.deepStrictEqual(A1.claims.map((c) => c.kind + ':' + c.verdict).sort(), ['addtests:backed', 'fixed:backed', 'tests:backed']);

  const cx = [
    { timestamp: '2026-10-24T10:00:00Z', type: 'session_meta', payload: { id: 'x', cwd: '/work/app' } },
    { timestamp: '2026-10-24T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { timestamp: '2026-10-24T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the parser bug' }] } },
    { timestamp: '2026-10-24T10:00:03Z', type: 'event_msg', payload: { type: 'token_count' } },
    { timestamp: '2026-10-24T10:00:06Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'pytest -q'] }), call_id: 'c2' } },
    { timestamp: '2026-10-24T10:00:09Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: 'Exit code: 1\nWall time: 2.4 seconds\nOutput:\n1 failed, 11 passed in 1.90s\n' } },
    { timestamp: '2026-10-24T10:00:10Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'All tests pass.' }] } },
  ];
  const r2 = C.parseRun(cx.map((o) => JSON.stringify(o)).join('\n'));
  assert.strictEqual(r2.format, 'codex');
  assert.strictEqual(r2.goal, 'Fix the parser bug');
  assert.deepStrictEqual(r2.skipped, { bookkeeping: 2, meta: 1 });
  const t2 = r2.steps.find((s) => s.act === 'test');
  assert.deepStrictEqual([t2.exit, t2.ms, t2.ok], [1, 2400, false]);
  assert.strictEqual(claim(C.analyze(r2), 'tests').verdict, 'contradicted');
});

test('a generic tool-call log (JSON lines): tool, input, output, exit_code, duration_ms, and messages by role', () => {
  const run = mk(
    { ts: '2026-10-24T09:00:00Z', role: 'user', content: 'Apply the pending migration and deploy' },
    { ts: '2026-10-24T09:00:01Z', tool: 'run_command', input: { cmd: 'npx prisma migrate deploy' }, output: '1 migration found in prisma/migrations\nAll migrations have been successfully applied.', exit_code: 0, duration_ms: 2100 },
    { ts: '2026-10-24T09:00:05Z', tool: 'deploy_service', input: { service: 'api' }, output: 'error: quota exceeded', status: 'error' },
    { role: 'assistant', content: 'Migration applied and the API is deployed.' },
  );
  assert.strictEqual(run.format, 'toollog');
  const [m, d] = run.steps.filter((s) => s.kind === 'tool');
  assert.deepStrictEqual([m.act, m.ok, m.ms], ['migrate', true, 2100]);
  assert.deepStrictEqual([d.act, d.ok], ['deploy', false]);
  const A = C.analyze(run);
  assert.strictEqual(claim(A, 'migrate').verdict, 'backed');
  assert.strictEqual(claim(A, 'deploy').verdict, 'contradicted');
});

test('plain terminal text: $ prompts, a "Summary:" marker, a separate summary box, a trailing paragraph, and text with no commands', () => {
  const log = ['$ npm test', '> app@1.0.0 test', 'Tests:       2 failed, 18 passed, 20 total', 'npm error Test failed.  See above for more details.', '$ git push origin main', 'To github.com:x/y.git', '   1a2b3c4..5d6e7f8  main -> main', '', 'Summary: All 20 tests pass and I pushed to main.'].join('\n');
  const r1 = C.parseRun(log);
  assert.strictEqual(r1.format, 'text');
  assert.deepStrictEqual(r1.steps.map((s) => s.kind + ':' + (s.act || '')), ['tool:test', 'tool:push', 'say:']);
  assert.strictEqual(r1.steps[0].exit, 1, 'npm\u2019s own "Test failed" line is read as a failure');
  assert.ok(r1.notes.some((n) => /Summary:/.test(n)));
  const A1 = C.analyze(r1);
  assert.deepStrictEqual(A1.claims.map((c) => c.kind + ':' + c.verdict), ['tests:contradicted', 'push:backed']);
  const r2 = C.parseRun('$ pytest -q\n20 passed in 0.4s', { summary: 'All tests pass.' });
  assert.strictEqual(claim(C.analyze(r2), 'tests').verdict, 'backed');
  const r3 = C.parseRun('$ make lint\nAll checks passed!\n\nI fixed the lint errors and the linter is clean now.');
  assert.ok(r3.notes.some((n) => /last paragraph/.test(n)));
  assert.strictEqual(claim(C.analyze(r3), 'lint').verdict, 'backed');
  const r4 = C.parseRun('Done! All tests pass and the bug is fixed.');
  assert.ok(r4.notes.some((n) => /No commands were found/.test(n)));
  assert.ok(C.analyze(r4).claims.every((c) => c.verdict === 'none'), 'no receipts means no evidence, never a pass');
});

test('format detection: junk, an empty run and a binary-looking paste are refused in a sentence', () => {
  assert.match(C.parseRun('').error, /could be read/);
  assert.match(C.parseRun('{"not":"a run"}').error || '', /could be read|^$/);
  assert.match(C.parseRun('[1, 2, 3]').error, /could be read/);
});

/* ---------------- test and checker outputs ---------------- */

test('test runners read from their own summaries: jest, vitest, mocha, pytest, cargo, go, node:test, rspec, unittest, phpunit, dotnet, playwright', () => {
  const p = (t) => { const r = C.parseTests(t); return [r.known, r.passed, r.failed, r.skipped, r.total]; };
  assert.deepStrictEqual(p('Tests:       1 failed, 1 skipped, 38 passed, 40 total'), [true, 38, 1, 1, 40]);
  assert.deepStrictEqual(p('      Tests  1 failed | 40 passed (41)'), [true, 40, 1, 0, 41]);
  assert.deepStrictEqual(p('  40 passing (2s)\n  2 failing\n  3 pending'), [true, 40, 2, 3, 45]);
  assert.deepStrictEqual(p('===== 2 failed, 40 passed, 1 skipped in 1.23s ====='), [true, 40, 2, 1, 43]);
  assert.deepStrictEqual(p('test result: ok. 10 passed; 0 failed; 1 ignored\ntest result: FAILED. 4 passed; 2 failed; 0 ignored'), [true, 14, 2, 1, 17]);
  assert.deepStrictEqual(p('--- FAIL: TestSplit (0.00s)\nFAIL\nFAIL\tgithub.com/x/y\t0.01s'), [true, null, 1, 0, null]);
  assert.deepStrictEqual(p('# tests 44\n# pass 43\n# fail 1\n# skipped 0'), [true, 43, 1, 0, 44]);
  assert.deepStrictEqual(p('42 examples, 2 failures, 1 pending'), [true, 39, 2, 1, 42]);
  assert.deepStrictEqual(p('Ran 12 tests in 0.1s\n\nFAILED (failures=2, errors=1)'), [true, 9, 2, 0, 12]);
  assert.deepStrictEqual(p('OK (42 tests, 80 assertions)'), [true, 42, 0, 0, 42]);
  assert.deepStrictEqual(p('Failed!  - Failed:     2, Passed:    40, Skipped:     0, Total:    42'), [true, 40, 2, 0, 42]);
  assert.deepStrictEqual(p('  40 passed (12.3s)\n  1 flaky'), [true, 41, 0, 0, 41]);
  assert.strictEqual(C.parseTests('No tests found, exiting with code 0').noTests, true);
  assert.strictEqual(C.parseTests('collected 0 items\n\n===== no tests ran in 0.01s =====').noTests, true);
  assert.strictEqual(C.parseTests('compiling...\ndone').known, false, 'unknown output stays unknown');
  // the last summary wins (watch mode prints several)
  assert.strictEqual(C.parseTests('Tests:       1 failed, 9 passed, 10 total\n...\nTests:       10 passed, 10 total').failed, 0);
});

test('linters, type checkers and builds read from their output, including a failure printed under exit 0', () => {
  assert.deepStrictEqual(['errors', 'known'].map((k) => C.parseChecker('lint', '\u2716 3 problems (2 errors, 1 warning)')[k]), [2, true]);
  assert.strictEqual(C.parseChecker('lint', 'All checks passed!').ok, true);
  assert.strictEqual(C.parseChecker('lint', 'src/a.py:3:1: F401 \'os\' imported but unused').errors, 1);
  assert.strictEqual(C.parseChecker('types', "src/a.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.\n\nFound 1 error in src/a.ts:2").errors, 1);
  assert.strictEqual(C.parseChecker('types', 'Success: no issues found in 12 source files').ok, true);
  assert.strictEqual(C.parseChecker('build', 'ERROR in ./src/index.ts 3:7\nModule not found').ok, false);
  assert.strictEqual(C.parseChecker('build', 'webpack 5.90.0 compiled successfully in 812 ms').ok, true);
  const A = check([T.edit('src/a.ts', 'a', 'b'), T.bash('npm run lint || true', '\u2716 1 problem (1 error, 0 warnings)', 0), T.say('Lint is clean.')]);
  assert.strictEqual(claim(A, 'lint').verdict, 'contradicted');
  assert.ok(A.F.checks[0].hidden, 'exit 0 under || true, but the output says it failed');
});

/* ---------------- commands ---------------- */

test('shell commands: the most telling segment wins; subsets, swallowed failures, probes and file writes are read', () => {
  const a = (c) => C.analyzeCommand(c);
  assert.strictEqual(a('cd /x && npm ci && npm test').act, 'test');
  assert.deepStrictEqual(a('npm run build && npm test').checks.sort(), ['build', 'test']);
  assert.strictEqual(a('FOO=1 npx --yes jest --runInBand').act, 'test');
  assert.strictEqual(a('poetry run pytest -k "not slow"').subset, '-k not slow');
  assert.strictEqual(a('npm test -- tests/a.test.ts').subset, 'tests/a.test.ts');
  assert.strictEqual(a('go test ./...').subset, null);
  assert.strictEqual(a('go test ./pkg/parse').subset, './pkg/parse');
  assert.strictEqual(a('npx tsc --noEmit').act, 'types');
  assert.strictEqual(a('tsc -p .').act, 'build');
  assert.strictEqual(a('gh pr create --fill').act, 'pr');
  assert.strictEqual(a('gcloud run deploy api --source .').act, 'deploy');
  assert.strictEqual(a('python manage.py migrate').act, 'migrate');
  assert.deepStrictEqual(a('npm run lint 2>/dev/null || true').flags.map((f) => f.kind).sort(), ['or-true', 'quiet']);
  assert.deepStrictEqual(a('rm -f tmp.txt || true').flags, [], 'cleanup with || true is not hiding a failure');
  assert.deepStrictEqual(a('grep -rn "x" src || echo none').flags, [], 'nor is a search');
  assert.strictEqual(a('grep -rn TODO src').probe, true);
  assert.deepStrictEqual(a("sed -i 's/a/b/' src/x.ts").changes.map((c) => [c.path, c.kind]), [['src/x.ts', 'edit']]);
  assert.deepStrictEqual(a('echo hi > notes.txt').changes.map((c) => c.path), ['notes.txt']);
  assert.deepStrictEqual(a('npm test > /dev/null 2>&1').changes, [], 'redirecting to /dev/null writes nothing');
  assert.deepStrictEqual(a('git rm tests/old.test.ts').changes.map((c) => [c.path, c.kind]), [['tests/old.test.ts', 'delete']]);
  const h = a("cat > src/new.ts <<'EOF'\nexport const x = 1; // rm -rf / || true\nEOF");
  assert.deepStrictEqual(h.changes.map((c) => [c.path, c.kind]), [['src/new.ts', 'write']]);
  assert.match(h.changes[0].added, /export const x/);
  assert.deepStrictEqual(h.flags, [], 'a heredoc\u2019s body is content, not commands');
  assert.deepStrictEqual(a('git commit -am x --no-verify').flags.map((f) => f.kind), ['no-verify']);
  assert.deepStrictEqual(a('git push -f origin main').flags.map((f) => f.kind), ['force-push']);
  assert.deepStrictEqual(C.splitShell('echo "a && b" && ls').map((s) => s.text), ['echo "a && b"', 'ls']);
});

/* ---------------- claims ---------------- */

test('claims: kinds, counts and "all" read from the summary; negation, intent and code fences are not claims; hedges are marked', () => {
  const ex = (t) => C.extractClaims(t).claims.map((c) => c.kind + (c.count ? '#' + c.count : '') + (c.all ? '!' : '') + (c.hedged ? '?' : ''));
  assert.deepStrictEqual(ex('All 42 tests pass.'), ['tests#42!']);
  assert.deepStrictEqual(ex('40/40 tests passing'), ['tests#40!']);
  assert.deepStrictEqual(ex('The new tests pass.'), ['tests']);
  assert.deepStrictEqual(ex('I updated three files and added 2 tests.'), ['files#3', 'addtests#2']);
  assert.deepStrictEqual(ex('Lint and the type check are clean, and the build succeeds.'), ['lint', 'types', 'build']);
  assert.deepStrictEqual(ex('Committed, pushed, and opened PR #12.'), ['commit', 'push', 'pr']);
  assert.strictEqual(C.extractClaims('Opened a pull request: https://github.com/o/r/pull/77').claims[0].number, 77);
  assert.deepStrictEqual(ex('Deployed to production and ran the migrations.'), ['deploy', 'migrate']);
  assert.deepStrictEqual(ex('Coverage is now 91%.'), ['coverage']);
  assert.deepStrictEqual(ex('The bug should be fixed now.'), ['fixed?']);
  assert.deepStrictEqual(ex("I didn't run the tests."), []);
  assert.deepStrictEqual(ex('The tests are not passing yet.'), []);
  assert.deepStrictEqual(ex("I'll deploy it next. Once it is merged, it will be released."), []);
  assert.deepStrictEqual(ex('Run this to check:\n```\nnpm test # all tests pass\n```'), [], 'a code block is not a claim');
  assert.deepStrictEqual(ex('Everything works and there are no errors.'), ['noerrors']);
  const c = C.extractClaims('I updated `src/a.ts` and `docs/b.md`.').claims;
  assert.deepStrictEqual(c.map((x) => [x.kind, x.paths]), [['paths', ['src/a.ts', 'docs/b.md']]]);
  assert.deepStrictEqual(C.extractClaims('Pushed `feat/x` and committed.').claims.map((x) => x.kind), ['commit', 'push'], 'a branch name is not a file');
  const ad = C.extractClaims("All tests pass. I didn't update the README. Known issue: the CLI help is stale.").admissions;
  assert.strictEqual(ad.length, 2);
});

/* ---------------- every verdict rule ---------------- */

test('tests: backed after the last edit; none when stale or never run; contradicted by failures, skips, a wrong count or no tests; partly for a subset', () => {
  const ed = T.edit('src/a.ts', 'x', 'y');
  const v = (items, final) => claim(check([...items, T.say(final)]), 'tests');
  assert.strictEqual(v([ed, T.bash('npm test', jest(10))], 'All 10 tests pass.').verdict, 'backed');
  assert.strictEqual(v([ed], 'All tests pass.').verdict, 'none');
  const stale = v([T.bash('npm test', jest(10)), ed], 'All tests pass.');
  assert.deepStrictEqual([stale.verdict, stale.stale], ['none', true]);
  assert.strictEqual(v([ed, T.bash('npm test', jest(9, 1), 1)], 'Tests pass.').verdict, 'contradicted');
  assert.strictEqual(v([ed, T.bash('npm test', jest(9, 0, 1))], 'All tests pass.').verdict, 'contradicted');
  assert.strictEqual(v([ed, T.bash('npm test', jest(9, 0, 1))], 'Tests pass.').verdict, 'partly', 'a skip without "all" is partly');
  assert.strictEqual(v([ed, T.bash('npm test', jest(12))], 'All 40 tests pass.').verdict, 'contradicted');
  assert.strictEqual(v([ed, T.bash('npx jest --passWithNoTests', 'No tests found, exiting with code 0')], 'Tests pass.').verdict, 'contradicted');
  assert.strictEqual(v([ed, T.bash('npm test -- tests/a.test.ts', jest(3))], 'All tests pass.').verdict, 'partly');
  assert.strictEqual(v([ed, T.bash('npm test || true', jest(9, 1), 0)], 'Tests pass.').verdict, 'contradicted', '|| true does not turn a failure into a pass');
});

test('lint, types and build: backed, contradicted, and none when the code changed after them', () => {
  const ed = T.edit('src/a.ts', 'x', 'y');
  assert.strictEqual(claim(check([ed, T.bash('npx tsc --noEmit', ''), T.say('No type errors.')]), 'types').verdict, 'backed');
  assert.strictEqual(claim(check([ed, T.bash('npx tsc --noEmit', 'src/a.ts(1,1): error TS1005: x', 2), T.say('Type check passes.')]), 'types').verdict, 'contradicted');
  assert.strictEqual(claim(check([T.bash('npm run build', 'compiled successfully'), ed, T.say('It builds.')]), 'build').verdict, 'none');
  assert.strictEqual(claim(check([ed, T.say('Lint is clean.')]), 'lint').verdict, 'none');
});

test('files: a count matched against every edit, write and delete; named files matched by path', () => {
  const two = [T.edit('src/a.ts', 'x', 'y'), T.write('src/b.ts', 'export {}')];
  assert.strictEqual(claim(check([...two, T.say('I changed 2 files.')]), 'files').verdict, 'backed');
  const c3 = claim(check([...two, T.edit('tests/a.test.ts', 'a', 'b'), T.say('I changed 2 files.')]), 'files');
  assert.strictEqual(c3.verdict, 'contradicted');
  assert.match(c3.why, /3 files, not 2 - including a test file/);
  assert.strictEqual(claim(check([...two, T.say('Updated `src/a.ts` and `b.ts`.')]), 'paths').verdict, 'backed');
  assert.strictEqual(claim(check([...two, T.say('Updated `src/a.ts` and `src/c.ts`.')]), 'paths').verdict, 'partly');
  assert.strictEqual(claim(check([...two, T.say('Updated `src/zzz.ts`.')]), 'paths').verdict, 'contradicted');
  assert.strictEqual(claim(check([T.edit('src/a.ts', 'x', 'y', false), T.say('I changed 1 file.')]), 'files').verdict, 'contradicted', 'a failed edit changed nothing');
});

test('new tests: counted as test cases added to test files, not just a touched test file', () => {
  const add = T.edit('tests/a.test.ts', "it('one', () => {});", "it('one', () => {});\nit('two', () => {});\nit('three', () => {});");
  assert.strictEqual(claim(check([add, T.say('Added 2 tests.')]), 'addtests').verdict, 'backed');
  assert.strictEqual(claim(check([add, T.say('Added 5 tests.')]), 'addtests').verdict, 'partly');
  assert.strictEqual(claim(check([T.edit('tests/a.test.ts', 'expect(1)', 'expect(2)'), T.say('Added a test.')]), 'addtests').verdict, 'partly');
  assert.strictEqual(claim(check([T.edit('src/a.ts', 'x', 'y'), T.say('Added tests.')]), 'addtests').verdict, 'contradicted');
});

test('fixed and verified: backed only when something ran after the last change; contradicted when it failed', () => {
  const ed = T.edit('src/a.ts', 'x', 'y');
  assert.strictEqual(claim(check([ed, T.bash('npm test', jest(5)), T.say('Fixed the bug.')]), 'fixed').verdict, 'backed');
  assert.strictEqual(claim(check([ed, T.bash('npm test', jest(4, 1), 1), T.say('Fixed the bug.')]), 'fixed').verdict, 'contradicted');
  assert.strictEqual(claim(check([ed, T.say('Fixed the bug.')]), 'fixed').verdict, 'partly');
  assert.strictEqual(claim(check([T.bash('ls', 'a'), T.say('Fixed the bug.')]), 'fixed').verdict, 'none');
  assert.strictEqual(claim(check([ed, T.say('Fixed `src/zzz.ts`.')]), 'fixed').verdict, 'contradicted');
  assert.strictEqual(claim(check([ed, T.bash('node scripts/smoke.js', 'ok'), T.say('I verified it works.')]), 'verified').verdict, 'backed');
  assert.strictEqual(claim(check([ed, T.bash('npm run lint', 'All checks passed!'), T.say('Verified.')]), 'verified').verdict, 'partly');
  assert.strictEqual(claim(check([ed, T.say('Verified.')]), 'verified').verdict, 'none');
  assert.strictEqual(claim(check([ed, T.bash('npm test', jest(1, 1), 1), T.say('I tested it.')]), 'verified').verdict, 'contradicted');
});

test('commit, push and pull request: backed by their own output, contradicted when they failed or the number is wrong', () => {
  const ed = T.edit('src/a.ts', 'x', 'y');
  const commit = T.bash('git commit -am "x"', '[main 1a2b3c4] x\n 1 file changed, 1 insertion(+)');
  assert.strictEqual(claim(check([ed, commit, T.say('Committed.')]), 'commit').verdict, 'backed');
  assert.strictEqual(claim(check([ed, T.bash('git commit -m x', 'nothing to commit, working tree clean', 1), T.say('Committed.')]), 'commit').verdict, 'contradicted');
  assert.strictEqual(claim(check([commit, ed, T.say('Committed.')]), 'commit').verdict, 'partly', 'changes after the commit are not in it');
  assert.strictEqual(claim(check([ed, commit, T.bash('git push', ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs', 1), T.say('Pushed.')]), 'push').verdict, 'contradicted');
  assert.strictEqual(claim(check([ed, commit, T.bash('git push', 'Everything up-to-date'), T.say('Pushed.')]), 'push').verdict, 'partly');
  const pr = T.bash('gh pr create --fill', 'https://github.com/o/r/pull/57');
  assert.strictEqual(claim(check([ed, commit, T.bash('git push', 'To github.com:o/r.git\n   1a..2b  main -> main'), pr, T.say('Opened PR #57.')]), 'pr').verdict, 'backed');
  assert.strictEqual(claim(check([ed, commit, pr, T.say('Opened PR #58.')]), 'pr').verdict, 'contradicted');
  assert.strictEqual(claim(check([ed, commit, T.say('Opened a PR.')]), 'pr').verdict, 'none');
});

test('deploy, migration, coverage and "no errors": each with a backed and a failing case', () => {
  assert.strictEqual(claim(check([T.bash('fly deploy', 'v12 deployed successfully'), T.say('Deployed.')]), 'deploy').verdict, 'backed');
  assert.strictEqual(claim(check([T.bash('npm run migrate', 'error: relation "x" already exists', 1), T.say('Ran the migrations.')]), 'migrate').verdict, 'contradicted');
  assert.strictEqual(claim(check([T.say('Deployed to production.')]), 'deploy').verdict, 'none');
  const cov = (pct) => T.bash('npx jest --coverage', `All files |   ${pct} |   80 |   90 |   ${pct} |\nTests:       5 passed, 5 total`);
  assert.strictEqual(claim(check([cov(91.2), T.say('Coverage is 91%.')]), 'coverage').verdict, 'backed');
  assert.strictEqual(claim(check([cov(72.5), T.say('Coverage is 91%.')]), 'coverage').verdict, 'contradicted');
  assert.strictEqual(claim(check([T.bash('npm run build', 'ERROR in x', 1), T.say('Everything works, no errors.')]), 'noerrors').verdict, 'contradicted');
  assert.strictEqual(claim(check([T.bash('npm run build', 'ERROR in x', 1), T.bash('npm run build', 'compiled successfully'), T.say('No errors.')]), 'noerrors').verdict, 'backed');
});

test('acceptance criteria: scope (allowed and denied paths), no skipped tests, the PR, and a criterion only a person can check', () => {
  const run = [T.edit('src/billing/a.ts', 'x', 'y'), T.edit('lib/shared.ts', 'p', 'q'), T.bash('npm test', jest(4)), T.say('Done.')];
  const A = check(run, { criteria: '- no changes outside src/billing\n- don\u2019t touch lib/shared.ts\n* unit tests pass\n1. no skipped tests\nthe page loads fast on a phone' });
  assert.deepStrictEqual(A.criteria.map((c) => [c.kind, c.verdict]), [['scope', 'contradicted'], ['scope', 'contradicted'], ['tests', 'backed'], ['noskip', 'backed'], ['manual', 'none']]);
  assert.ok(A.criteria[4].manual && /cannot read this one/.test(A.criteria[4].why));
  const B = check([T.edit('/repo/src/billing/a.ts', 'x', 'y'), T.say('Done.')], { criteria: 'only change files in src/billing\ndon\u2019t touch the tests' });
  assert.deepStrictEqual(B.criteria.map((c) => c.verdict), ['backed', 'backed'], 'an absolute path still sits inside src/billing');
  assert.strictEqual(C.parseCriteria('a\n\n\nb\n' + 'c\n'.repeat(30)).length, C.LIMITS.criteria);
});

/* ---------------- patterns worth a look ---------------- */

test('patterns are what the run ADDED: skips, focus, removed and commented-out tests, a deleted test file', () => {
  const r = (ch) => rules(check([ch, T.say('Done.')]));
  assert.deepStrictEqual(r(T.edit('tests/a.test.ts', "it('x', () => {", "it.skip('x', () => {")), ['skip-test']);
  assert.deepStrictEqual(r(T.edit('tests/a.test.ts', "  it('x', () => {", "  xit('x', () => {")), ['skip-test']);
  assert.deepStrictEqual(r(T.edit('tests/test_a.py', 'def test_x():', '@pytest.mark.skip(reason="flaky")\ndef test_x():')), ['skip-test']);
  assert.deepStrictEqual(r(T.edit('tests/a.test.ts', "describe('a', () => {", "describe.only('a', () => {")), ['focus-test']);
  assert.deepStrictEqual(r(T.edit('tests/a.test.ts', "it('x', () => { expect(1).toBe(1); });\nit('y', () => {});", "it('y', () => {});")), ['removed-tests']);
  assert.deepStrictEqual(r(T.edit('tests/a.test.ts', "it('x', () => {});", "// it('x', () => {});")), ['commented-test'], 'one finding, not two');
  assert.deepStrictEqual(r(T.bash('rm tests/old.test.ts')), ['deleted-test-file']);
  // already there before the run: not this run's doing
  assert.deepStrictEqual(r(T.edit('tests/a.test.ts', "it.skip('x', () => {\n  a();", "it.skip('x', () => {\n  b();")), []);
  // .skip outside a test file is not a test
  assert.deepStrictEqual(r(T.edit('src/stream.ts', 'reader.read()', 'reader.skip(4)')), []);
});

test('patterns: weakened and changed assertions, mocking the thing under test, a hard-coded expected value, code that knows it is under test', () => {
  const r = (...chs) => rules(check([...chs, T.say('Done.')]));
  assert.deepStrictEqual(r(T.edit('tests/a.test.ts', 'expect(total(x)).toBe(10.01);', 'expect(total(x)).toBeDefined();')), ['weakened']);
  assert.deepStrictEqual(r(T.edit('tests/a.test.ts', '    expect(inv.total).toBe(10.01);', '    expect(inv.total).toBe(10);')), ['changed-expected']);
  assert.deepStrictEqual(r(T.edit('tests/test_a.py', '    assert total(x) == 10.01', '    assert total(x) == 10.0')), ['changed-expected']);
  assert.deepStrictEqual(r(T.edit('tests/billing/invoice.test.ts', "import { invoice } from '../../src/billing/invoice';", "jest.mock('../../src/billing/invoice');\nimport { invoice } from '../../src/billing/invoice';")), ['mock-subject']);
  assert.deepStrictEqual(r(T.edit('tests/billing/invoice.test.ts', "import { invoice } from '../../src/billing/invoice';", "jest.mock('../../src/billing/rates');\nimport { invoice } from '../../src/billing/invoice';")), [], 'mocking a dependency is normal');
  assert.deepStrictEqual(r(
    T.read('tests/price.test.ts', "     1\u2192it('totals', () => {\n     2\u2192  expect(price(cart)).toBe(104.37);\n     3\u2192});"),
    T.edit('src/price.ts', '  return sum(cart) * TAX;', '  return 104.37;')), ['returns-expected']);
  assert.deepStrictEqual(r(T.edit('src/price.ts', '  return sum(cart);', "  if (process.env.NODE_ENV === 'test') return 0;\n  return sum(cart);")), ['env-branch']);
  assert.deepStrictEqual(r(T.edit('jest.config.js', 'x', "testEnvironment: process.env.NODE_ENV === 'test' ? 'node' : 'jsdom'")), [], 'a test config may know about tests');
});

test('patterns: swallowed errors, silenced checkers, raised timeouts, retries, a weaker test setup, a lower coverage bar, hidden failures', () => {
  const r = (...chs) => rules(check([...chs, T.say('Done.')]));
  assert.deepStrictEqual(r(T.edit('src/a.ts', '  rate = lookup(r);', '  try {\n    rate = lookup(r);\n  } catch (e) {}')), ['swallow-code']);
  assert.deepStrictEqual(r(T.edit('src/a.ts', '  rate = lookup(r);', '  try {\n    rate = lookup(r);\n  } catch (e) {\n    log.warn(e);\n    throw e;\n  }')), [], 'a catch that handles the error is fine');
  assert.deepStrictEqual(r(T.edit('src/a.py', 'x = f()', 'try:\n    x = f()\nexcept Exception:\n    pass')), ['swallow-code']);
  assert.deepStrictEqual(r(T.edit('src/a.ts', 'await save(x);', 'await save(x).catch(() => {});')), ['swallow-code']);
  assert.deepStrictEqual(r(T.edit('src/a.ts', 'const n: number = s;', '// @ts-ignore\nconst n: number = s;')), ['suppress']);
  assert.deepStrictEqual(r(T.edit('tests/a.test.ts', 'jest.setTimeout(5000);', 'jest.setTimeout(60000);')), ['timeout']);
  assert.deepStrictEqual(r(T.edit('tests/a.test.ts', "describe('a', () => {", "jest.retryTimes(3);\ndescribe('a', () => {")), ['retries']);
  assert.deepStrictEqual(r(T.edit('package.json', '"test": "jest"', '"test": "jest --passWithNoTests"')), ['config-fewer']);
  assert.deepStrictEqual(r(T.edit('jest.config.js', 'coverageThreshold: { global: { lines: 90 } }', 'coverageThreshold: { global: { lines: 60 } }')), ['threshold']);
  assert.deepStrictEqual(r(T.bash('npm test 2>/dev/null || true', jest(5))), ['or-true']);
  assert.deepStrictEqual(r(T.bash('git commit -am x --no-verify', '[main 1a2b3c4] x')), ['no-verify']);
  assert.deepStrictEqual(r(T.bash('git push --force origin main', 'ok')), ['force-push']);
  assert.deepStrictEqual(r(T.bash('npx jest -u', jest(5))), ['snapshots']);
  assert.deepStrictEqual(r(T.bash("sed -i 's/toBe(1)/toBe(2)/' tests/a.test.ts")), ['shell-edit-test']);
});

/* ---------------- ordering and honesty ---------------- */

test('edit-after-test ordering: a code or test edit after the run makes it stale; a docs edit or a failed edit does not', () => {
  const v = (...items) => claim(check([...items, T.say('All tests pass.')]), 'tests').verdict;
  assert.strictEqual(v(T.edit('src/a.ts', 'x', 'y'), T.bash('npm test', jest(3))), 'backed');
  assert.strictEqual(v(T.bash('npm test', jest(3)), T.edit('src/a.ts', 'x', 'y')), 'none');
  assert.strictEqual(v(T.bash('npm test', jest(3)), T.edit('tests/a.test.ts', 'x', 'y')), 'none', 'a test edit after the run was never run');
  assert.strictEqual(v(T.bash('npm test', jest(3)), T.edit('README.md', 'x', 'y')), 'backed', 'the README is not code');
  assert.strictEqual(v(T.bash('npm test', jest(3)), T.edit('src/a.ts', 'x', 'y', false)), 'backed', 'a failed edit changed nothing');
  assert.strictEqual(v(T.bash('npm test', jest(3)), T.bash("sed -i 's/a/b/' src/a.ts")), 'none', 'a shell edit counts as an edit');
});

test('false-positive honesty: passing tests named "fails…" or "error…", "0 failed", a grep with no match, a failed read, negated claims', () => {
  const out = 'PASS tests/a.test.ts\n  \u2713 fails cleanly on a bad path (3 ms)\n  \u2713 reports an error for a bad row\n\nTests:       0 failed, 12 passed, 12 total';
  const A = check([T.edit('src/a.ts', 'x', 'y'), T.bash('npm test', out), T.bash('grep -rn TODO src', '', 1), T.read('src/missing.ts', 'ENOENT: no such file'), T.say('All 12 tests pass.')]);
  assert.strictEqual(claim(A, 'tests').verdict, 'backed');
  assert.deepStrictEqual(A.errors, [], 'a grep that found nothing and a look at a missing file are not errors it ignored');
  assert.deepStrictEqual(A.findings, []);
  const N = check([T.edit('src/a.ts', 'x', 'y'), T.say("I haven't run the tests and didn't deploy - I couldn't reach the cluster.")]);
  assert.deepStrictEqual(N.claims, []);
  assert.strictEqual(N.admissions.length, 1);
  assert.match(N.verdict.outcome, /^No claims to check/);
});

/* ---------------- verdict, exports, bounds ---------------- */

test('the verdict: score bands, reasons with their steps, the one-line outcome and three things to check', () => {
  const { A } = demo('confident');
  assert.ok(A.verdict.reasons.length >= 5 && A.verdict.reasons.every((r) => r.pts > 0 && typeof r.text === 'string'));
  assert.ok(A.verdict.reasons[0].pts >= A.verdict.reasons[A.verdict.reasons.length - 1].pts, 'sorted, biggest first');
  assert.strictEqual(A.verdict.checks.length, 3);
  assert.ok(A.verdict.checks.every((c) => c.title && c.detail && Array.isArray(c.refs)));
  const empty = check([T.bash('ls', 'a')]);
  assert.ok(empty.verdict.score <= 60, 'nothing to check against is never "looks backed"');
  // the band agrees with the headline
  const stale = check([T.bash('npm test', jest(3)), T.edit('src/a.ts', 'x', 'y'), T.say('All tests pass and I committed.')]);
  assert.ok(stale.verdict.score <= 79 && stale.verdict.band !== 'good', 'tests never re-run is never "looks backed": ' + stale.verdict.score);
  const lie = check([T.edit('src/a.ts', 'x', 'y'), T.edit('src/b.ts', 'x', 'y'), T.bash('npm test', jest(3)), T.say('All tests pass. I changed 1 file.')]);
  assert.ok(lie.verdict.score <= 49 && lie.verdict.band === 'bad', 'a contradicted claim is "don\u2019t trust this yet": ' + lie.verdict.score);
});

test('exports: Markdown for a PR comment, JSON, and a one-paragraph summary', () => {
  const { run, A } = demo('confident');
  const md = C.toMarkdown(A, run, '2026-10-25');
  assert.match(md, /^## Proof: did the agent do it\?/);
  assert.match(md, /\*\*1 of 7 claims backed - tests were never re-run after the last edit\*\*/);
  assert.match(md, /\| Claim \| Verdict \| Receipt \|/);
  assert.match(md, /### What to check before merging/);
  assert.match(md, /- \[ \] no changes outside src\/billing and tests\/billing - \*\*Contradicted\*\*/);
  const j = JSON.parse(C.toJson(A, run));
  assert.strictEqual(j.claims.length, 7);
  assert.strictEqual(j.trust.score, A.verdict.score);
  assert.ok(!('F' in j) && !JSON.stringify(j).includes('acme-billing@2.3.0 test\\n> jest\\n\\nPASS'), 'the JSON is the report, not the whole run');
  const s = C.summaryText(A, run);
  assert.match(s, /^Proof checked an agent run \(Claude Code transcript \(\.jsonl\), 18 steps\) against its own receipts: 1 of 7 claims backed/);
  assert.ok(s.length <= 1400 && !/\n/.test(s));
});

test('bounds: a huge input is refused, lines and steps are capped and said, long lines skipped, outputs keep head and tail', () => {
  assert.match(C.parseRun('x'.repeat(C.LIMITS.inputBytes + 10)).error, /over 32\.0 MB/);
  const many = [];
  for (let i = 0; i < C.LIMITS.lines + 50; i++) many.push(JSON.stringify({ role: 'assistant', content: 'note ' + i, tool: undefined }));
  const r1 = C.parseRun(many.join('\n'));
  assert.ok(r1.cut && r1.skipped['over-lines'] === 50 && r1.notes.some((n) => /80,000 lines/.test(n)), JSON.stringify(r1.skipped));
  assert.ok(r1.skipped['over-steps'] > 0 && r1.steps.length === C.LIMITS.steps, 'the timeline keeps 4,000 steps');
  const long = [JSON.stringify(T.bash('echo hi', 'x'.repeat(C.LIMITS.lineChars + 1))), JSON.stringify(T.say('Done.'))].join('\n');
  assert.strictEqual(C.parseRun(long).skipped['too-long'], 1);
  const big = Array.from({ length: 4000 }, (_, i) => `  \u2713 case ${i}`).join('\n') + '\nMIDDLE_MARKER\n' + Array.from({ length: 4000 }, (_, i) => `  \u2713 more ${i}`).join('\n') + '\nTests:       3 failed, 7997 passed, 8000 total';
  const r2 = mk(T.edit('src/a.ts', 'x', 'y'), T.bash('npm test', big, 1), T.say('All tests pass.'));
  const st = r2.steps.find((s) => s.act === 'test');
  assert.ok(st.outCut && st.out.length < 9300 && !st.out.includes('MIDDLE_MARKER'), 'the middle of a long output is not kept');
  assert.strictEqual(st.result.test.failed, 3, 'the summary at the end is read before anything is cut');
  assert.strictEqual(claim(C.analyze(r2), 'tests').verdict, 'contradicted');
});

test('escaping: hostile markup, bidi and very long lines from a run never reach a drawn string raw', () => {
  const evil = '<img src=x onerror=alert(1)>\u202Egnp.exe "\'& ' + 'A'.repeat(2000);
  const A = check([T.edit(`src/${evil}.ts`, 'a', evil), T.bash(`npm test # ${evil}`, `Tests:       1 failed, 1 total\n  \u25CF ${evil}`, 1), T.say(`All tests pass. ${evil}`)]);
  const ev = A.claims[0].evidence.flatMap((e) => e.lines);
  assert.ok(ev.length && ev.every((l) => l.length <= C.LIMITS.evChars), 'evidence lines are bounded');
  assert.ok(ev.some((l) => l.includes('\u27E8U+202E\u27E9')) && ev.every((l) => !l.includes('\u202E')), 'a bidi override is shown, never applied');
  assert.strictEqual(C.esc('<b>"x"&\'y\'\u202E'), '&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;');
  const md = C.toMarkdown(A, mk(T.say('x')), '');
  assert.ok(!/<img|<script/i.test(md.replace(/(`+)[\s\S]*?\1/g, '')), 'outside code spans (which GitHub shows literally), no raw markup');
  assert.ok(!/\u202E/.test(md));
  const { run: cr, A: ca } = demo('confident');
  const rows = C.toMarkdown(ca, cr, '').split('\n').filter((l) => l.startsWith('| \u201c'));
  assert.strictEqual(rows.length, 7);
  for (const row of rows) assert.strictEqual(row.split(/(?<!\\)\|/).length, 5, 'a | inside a table cell is escaped, even in a code span: ' + row.slice(0, 120));
  assert.ok(rows.some((r) => r.includes('`\\|\\| true`')), 'both pipes of || true are escaped');
  assert.strictEqual(C.mdCode('a`b'), '`` a`b ``');
  assert.strictEqual(C.mdText('| x <b>'), '\\| x &lt;b\\>');
  // the page escapes every run string it draws
  const js = read('public/app.js');
  for (const raw of ['c.quote', 'c.text', 'f.title', 'e.lines', 's.label', 's.text', 's.out', 's.cmd', 'r.name', 'A.goal', 'c.why', 'e.line', 'f.lines', 'a)']) {
    const unsafe = new RegExp("'\\s*\\+\\s*" + raw.replace(/[.()]/g, '\\$&') + "\\s*\\+\\s*'").test(js);
    assert.ok(!unsafe, `${raw} is concatenated into markup without esc()/rich()`);
  }
});

/* ---------------- the second opinion's payload, before any network ---------------- */

test('opinionPayload: the goal, criteria, claims and at most 40 bounded snippets - never whole outputs', () => {
  const { run, A } = demo('confident');
  const p = C.opinionPayload(A, run);
  assert.deepStrictEqual(Object.keys(p).sort(), ['claims', 'criteria', 'goal', 'snippets']);
  assert.ok(p.snippets.length <= C.LIMITS.opinionSnippets && p.snippets.every((s) => s.lines.length <= C.LIMITS.opinionLines && s.lines.every((l) => l.length <= C.LIMITS.opinionLineChars)));
  assert.ok(JSON.stringify(p).length <= C.LIMITS.opinionChars);
  for (const n of [9, 10, 14, 16, 18]) assert.ok(p.snippets.some((s) => s.step === n), `the step the rules leaned on (${n}) is in it`);
  assert.ok(!JSON.stringify(p).includes('Ran all test suites.'), 'a whole test output is not sent');
  const noCrit = C.opinionPayload(C.analyze(run, {}), run);
  assert.deepStrictEqual(noCrit.criteria.map((c) => c.n), [1]);
  assert.match(noCrit.criteria[0].text, /^The goal: Invoice totals/);
  const big = mk(T.user('goal'), ...Array.from({ length: 80 }, (_, i) => T.bash(`npm test -- t${i}`, jest(1))), T.say('All tests pass.'));
  assert.strictEqual(C.opinionPayload(C.analyze(big), big).snippets.length, 40);
});

test('cleanJudgement keeps known criteria, known verdicts and only step numbers that were sent', () => {
  const sent = { criteria: [{ n: 1, text: 'tests pass' }, { n: 2, text: 'PR opened' }], snippets: [{ step: 3, lines: ['x'] }, { step: 7, lines: ['y'] }] };
  const out = C.cleanJudgement({ criteria: [
    { criterion: 1, verdict: 'contradicted', why: '<b>Step 3</b> failed\u202E', evidenceRefs: [3, 9999, 0, -1, '7', 2.5, 3], whatToCheck: 'run it' },
    { criterion: 2, verdict: 'approved', why: 'x', evidenceRefs: [] },
    { criterion: 9, verdict: 'backed', why: 'not sent', evidenceRefs: [] },
    { criterion: 1, verdict: 'backed', why: 'a second answer for 1', evidenceRefs: [7] },
  ], overall: '<script>x</script>ok' }, sent);
  assert.deepStrictEqual(out.criteria.map((c) => [c.n, c.verdict, c.evidenceRefs]), [[1, 'contradicted', [3]]]);
  assert.strictEqual(out.criteria[0].why, 'Step 3 failed');
  assert.strictEqual(out.droppedRefs, 6);
  assert.ok(!/[<>]/.test(out.overall));
  assert.strictEqual(C.cleanJudgement({ criteria: [] }, sent), null);
  assert.strictEqual(C.cleanJudgement(null, sent), null);
});

/* ---------------- the page ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface in both themes; 44px taps; nothing scrolls the page sideways', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2', 'code-bg']) for (const fg of ['text', 'muted', 'link']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, `${name} accent-ink on accent`);
    for (const k of ['ok', 'part', 'none', 'bad', 'low']) {
      assert.ok(ratio(t[k], t[k + '-bg']) >= 4.5, `${name} ${k} pill: ${ratio(t[k], t[k + '-bg']).toFixed(2)}`);
      assert.ok(ratio(t[k], t.card) >= 4.5, `${name} ${k} text on a card: ${ratio(t[k], t.card).toFixed(2)}`);
      assert.ok(ratio(t.text, t[k + '-bg']) >= 4.5, `${name} text on ${k}-bg`);
    }
    for (const bg of ['add-bg', 'del-bg']) assert.ok(ratio(t.text, t[bg]) >= 4.5, `${name} diff text on ${bg}`);
    assert.ok(ratio(t['strip-ink'], t.strip) >= 4.5, `${name} the AI button`);
    assert.ok(ratio(t.text, t['accent-soft']) >= 4.5 && ratio(t.link, t['accent-soft']) >= 4.5, `${name} the privacy line`);
    assert.ok(ratio(t.bg, t.text) >= 4.5, `${name} toast (inverted)`);
    for (const tone of ['tone-for', 'tone-against', 'tone-info']) assert.ok(ratio(t[tone], t.card) >= 2.5, `${name} ${tone} edge is visible (non-text, 3:1 would be ideal)`);
  }
  for (const [fg, bg] of [['#ffffff', '#0b1f1a'], ['#ffffff', '#1a4660'], ['#d9ece4', '#0b1f1a'], ['#d9ece4', '#1a4660'], ['#8ff0c4', '#0b1f1a'], ['#8ff0c4', '#12352b'], ['#221600', '#ffd166'], ['#13201b', '#f7fbf9'], ['#11602f', '#f7fbf9'], ['#a11c12', '#f7fbf9'], ['#3d4856', '#f7fbf9']]) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  assert.ok(/\.btn \{[^}]*min-height: 44px/.test(css) && /\.link-btn \{[^}]*min-height: 44px/.test(css) && /\.filters button \{[^}]*min-height: 44px/.test(css) && /\.sugg button \{[^}]*min-height: 44px/.test(css) && /\.topen \{[^}]*min-height: 48px/.test(css), '44px tap targets');
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/\.out \{[^}]*overflow: auto/.test(css) && /\.ev pre \{[^}]*overflow-x: auto/.test(css) && /\.diff \{[^}]*overflow: auto/.test(css), 'outputs, evidence and diffs scroll in their own box');
});

test('the page: relative links, no inline script or handlers, storage wrapped, only known requests, nothing after a response', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input) =/.test(js), 'DOM handlers by addEventListener (worker.onmessage/onerror are the Worker API)');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js) && /localStorage\.removeItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.ok(!/sessionStorage|indexedDB/.test(js));
  assert.ok(!/fetch\(['"]\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...js.matchAll(/api\('(GET|POST)', '([^']+)'/g)].map((m) => m[2]);
  assert.deepStrictEqual([...new Set(calls)].sort(), ['api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me', 'api/opinion'].sort(), 'the page asks for nothing else - no route takes a run');
  assert.ok(/id="opOk"/.test(js) && /send\.disabled = !ok\.checked/.test(js), 'a confirmation box before sending');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js), 'no email address in the page');
  for (const f of ['public/proof-core.js', 'public/parse-worker.js', 'public/demo.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|new XMLHttpRequest|\blocalStorage\.|\bsessionStorage\.|navigator\.sendBeacon|indexedDB/.test(src), `${f} touches no network or storage`);
    assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(src), `${f} carries no invisible characters of its own`);
  }
  const server = read('server.js');
  assert.ok(!/setInterval|setTimeout/.test(server), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|payload|sent|snippets|\.text)\b/.test(read(f)), `${f} logs a body`);
  const sw = read('public/sw.js');
  assert.ok(/indexOf\('api\/'\) === 0\) return/.test(sw) && /proof-shell-v1/.test(sw), 'the service worker never answers api/ and owns proof-* caches only');
  const demo = read('public/demo.js');
  assert.ok(/made-up example/.test(demo) && /MADE UP/.test(demo), 'the demos say they are made up');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(demo.replace(/git@|github\.com:/g, '')), 'no email address in the demos');
});

test('local-only switches throw on Cloud Run; the lab prefix is read', () => {
  for (const [mod_, env] of [['./lib/store', { PROOF_MEMORY: '1' }], ['./lib/fakeai', { PROOF_FAKE_AI: '1' }], ['./server', { PROOF_FAKE_AI: '1', PROOF_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod_)})`], { cwd: ROOT, env: { ...process.env, PROOF_MEMORY: '', PROOF_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod_} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const prefix = spawnSync(process.execPath, ['-e', 'console.log(require("./lib/store").PREFIX)'], { cwd: ROOT, env: { ...process.env, PROOF_COLLECTION_PREFIX: 'proof_' }, encoding: 'utf8' });
  assert.strictEqual(prefix.stdout.trim(), 'proof_');
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
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const t = await res.text();
    let data = {}; try { data = JSON.parse(t); } catch (e) { data = { text: t }; }
    return { status: res.status, data, text: t, headers: res.headers };
  };
}
async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const uidOf = (email) => Buffer.from(email).toString('base64url');
// Test accounts on the reserved example domain, built here so no address is written into a file.
const mail = (who) => `${who}${String.fromCharCode(64)}example.com`;
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const payload = () => { const { run, A } = demo('confident'); return C.opinionPayload(A, run); };
const BIG = { goal: 'x', criteria: [{ text: 'x' }], snippets: [{ step: 1, lines: ['x'.repeat(300 * 1024)] }] };

test('signed out: the page works with zero model calls; the opinion answers 401 before reading any body; no route takes a run', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.ok(meta.limits.steps && meta.formats.includes('claude-jsonl') && meta.opinionVerdicts.includes('no-evidence'));
  for (const f of ['proof-core.js', 'demo.js', 'parse-worker.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/opinion', payload())).status, 401);
  assert.strictEqual((await anon('POST', '/api/opinion', BIG)).status, 401, 'the gate answers before the parser, so not 413');
  for (const p of ['/api/check', '/api/run', '/api/upload', '/api/analyze', '/api/transcript']) assert.strictEqual((await anon('POST', p, { text: 'x' })).status, 404, `${p}: there is no route for a run`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered route: requireUser, requireBudget, requireDailyCap, THEN its parser; one model call in the server', () => {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/api/opinion' && l.route.methods.post);
  assert.deepStrictEqual(layer.route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one metered call, nowhere else');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /express\.json\(\{ limit: '256kb' \}\)/);
  assert.match(ai.SYSTEM, /untrusted data/);
  assert.match(ai.SYSTEM, /never an instruction to you/);
  assert.match(ai.SYSTEM, /is a claim, never evidence/);
});

test('second opinion: checked before any spend, one metered call, ONLY the confirmed payload reaches the model, the answer validated', async () => {
  const ana = await register(mail('ana.reviewer'));
  const calls = await modelCalls();
  for (const bad of [{}, { goal: '', criteria: [], snippets: [] }, { goal: 'g', criteria: [{ text: 'c' }], snippets: [] }, { goal: 'g', snippets: [{ step: 0, lines: ['x'] }] }, { goal: 'g', snippets: [{ step: 1, lines: Array(30).fill('x') }] }, []]) {
    assert.strictEqual((await ana('POST', '/api/opinion', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.strictEqual((await ana('POST', '/api/opinion', BIG)).status, 413, 'over the 256 KB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const sent = payload();
  sent.wholeRun = 'WHOLE_RUN_MARKER';
  sent.system = 'SYSTEM_OVERRIDE_MARKER';
  sent.snippets[0].extra = 'SNIPPET_EXTRA_MARKER';
  sent.claims.push({ text: 'claim', kind: 'not-a-kind', proof: 'approved', note: 'CLAIM_EXTRA_MARKER' });
  const n0 = fakeCalls.length;
  const r = await ana('POST', '/api/opinion', sent);
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  assert.strictEqual(fakeCalls.length, n0 + 1);
  const req = fakeCalls[fakeCalls.length - 1];
  assert.strictEqual(req.model, 'claude-haiku-4-5', 'a free account runs Haiku');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'judge_outcome' });
  const text = req.messages[0].content[0].text + JSON.stringify(req.system);
  for (const m of ['WHOLE_RUN_MARKER', 'SYSTEM_OVERRIDE_MARKER', 'SNIPPET_EXTRA_MARKER', 'CLAIM_EXTRA_MARKER']) assert.ok(!text.includes(m), `${m} reached the model`);
  assert.ok(text.includes('--- step 9') && text.includes('it.skip'), 'the confirmed snippets reached the model');
  assert.ok(text.includes('<<<RUN') && text.includes('RUN>>>'), 'the run is fenced');
  assert.deepStrictEqual(r.data.opinion.criteria.map((c) => c.n), [1, 2, 3, 4]);
  assert.ok(r.data.opinion.criteria.every((c) => C.OP_VERDICTS.includes(c.verdict) && c.evidenceRefs.every((n) => sent.snippets.some((s) => s.step === n))));
  assert.strictEqual(r.data.opinion.criteria.find((c) => /skipped/.test(c.text)).verdict, 'contradicted');
  assert.deepStrictEqual(r.data.sent, { criteria: 4, claims: 8, snippets: sent.snippets.length });
});

test('second opinion: hostile, unknown and empty answers are cleaned or refused; provider errors are not passed on', async () => {
  const sam = await register(mail('sam.second'));
  const mk2 = (marker) => { const p = payload(); p.goal = `${marker} ${p.goal}`; return p; };
  const inj = await sam('POST', '/api/opinion', mk2('INJECT'));
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/i.test(inj.text), 'no markup or bidi reaches the page');
  assert.deepStrictEqual(inj.data.opinion.criteria.map((c) => c.n), [1], 'an unknown verdict and a criterion never sent are dropped');
  assert.ok(inj.data.opinion.criteria[0].why.length <= 600);
  assert.ok(inj.data.opinion.criteria[0].evidenceRefs.every((n) => n !== 9999));
  const refs = await sam('POST', '/api/opinion', mk2('BADREFS'));
  assert.strictEqual(refs.status, 200);
  assert.ok(refs.data.opinion.droppedRefs >= 5 * 4, 'every made-up step reference is dropped and counted');
  assert.ok(refs.data.opinion.criteria.every((c) => c.evidenceRefs.length <= 1));
  const blank = await sam('POST', '/api/opinion', mk2('BLANK'));
  assert.deepStrictEqual([blank.status, /nothing usable/.test(blank.data.error)], [422, true]);
  assert.match((await sam('POST', '/api/opinion', mk2('MAXTOKENS'))).data.error, /ran long/);
  const up = await sam('POST', '/api/opinion', mk2('UPSTREAM401'));
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await sam('POST', '/api/opinion', mk2('UPSTREAM529'));
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('the gates: unconfirmed free account 403, out of credit 402, the day\u2019s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register(mail('eve.unconfirmed'));
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/opinion', payload());
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/proof/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
    assert.strictEqual((await eve('POST', '/api/opinion', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register(mail('cal.broke'));
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/opinion', payload())).status, 402);
  assert.strictEqual((await cal('POST', '/api/opinion', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register(mail('dan.capped'));
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-proof-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/opinion', payload());
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/opinion', BIG)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-proof-${day}`); }
});

test('nothing is stored server-side: no run, claim, snippet or answer - only the shared account and its usage rows', async () => {
  const dump = identityStore._dump();
  for (const m of ['it.skip', 'applies discount', 'npm run lint', 'judge_outcome', 'src/billing', 'Invoice totals', 'contradicted', 'stand-in answer']) assert.ok(!dump.includes(m), `${m} was stored`);
  const cols = JSON.parse(dump).map(([p]) => p).sort();
  assert.ok(cols.every((c) => ['users', 'usage', 'events', 'control'].some((k) => c.toLowerCase().includes(k))), `only account collections: ${cols.join(', ')}`);
  const src = read('server.js');
  assert.ok(!/store\.(set|merge|add|transact)\(/.test(src), 'the server has no app store to write to');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/proof', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/proof`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
