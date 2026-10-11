// Pure rules first, then end to end against the memory identity store and
// the fake model:
//   LANES_MEMORY=1 LANES_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /lanes, the way
// the lab mounts it, so the auth cookie, the budget gate and the metered
// route's parser order are exercised as deployed. Model calls are counted
// from the identity's usage rows - the same rows that bill a real account -
// and what reached "the model" is read from the fake client's own log.
//
// Every diff here is SYNTHETIC, written by hand in git's real shapes (or
// produced by running the gather command against a throwaway repo made
// here). Never copy a real repo's diff into this suite.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.LANES_MEMORY !== '1' || process.env.LANES_FAKE_AI !== '1') {
  console.error('run with LANES_MEMORY=1 LANES_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, fakeCalls } = require('../server');
const C = require('../public/lanes-core');
const D = require('../public/demo');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- helpers ---------------- */

const H = (os_, minus, ns, plus) => [`@@ -${os_}${minus.length === 1 ? '' : ',' + minus.length} +${ns}${plus.length === 1 ? '' : ',' + plus.length} @@`, ...minus.map((l) => '-' + l), ...plus.map((l) => '+' + l)];
const mod = (p, ...hunks) => [`diff --git a/${p} b/${p}`, 'index 1111111..2222222 100644', `--- a/${p}`, `+++ b/${p}`, ...hunks.flat()];
const add = (p, lines) => [`diff --git a/${p} b/${p}`, 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', `+++ b/${p}`, ...H(0, [], 1, lines)];
const del = (p, lines) => [`diff --git a/${p} b/${p}`, 'deleted file mode 100644', 'index 4444444..0000000', '--- a/' + p, '+++ /dev/null', ...H(1, lines, 0, [])];
function gather(branches, opts = {}) {
  const out = [`#lanes v1 base=${opts.base || 'main'}`, '#lanes files', ...(opts.files || ['src/a.ts', 'package.json'])];
  for (const b of branches) {
    out.push(`#lanes branch ${b.name}`, '#lanes log', ...(b.log || [`abc1234\t${b.author || 'Agent'}\t2026-10-09T10:00:00+00:00\tWork on ${b.name}`]), '#lanes diff', ...(b.diff || []).flat());
  }
  if (!opts.noEnd) out.push('#lanes end');
  return out.join(opts.crlf ? '\r\n' : '\n') + '\n';
}
const check = (branches, opts) => C.analyse(C.parseInput(gather(branches, opts)));
const run = (i, chg, h = 1, addN = 1) => ({ i, chg, h, add: addN });

/* ---------------- reading the gather file ---------------- */

test('the gather file: several branches, logs, renames, binary, deleted and new files, mode changes, an empty branch', () => {
  const text = gather([
    { name: 'agent/one', author: 'Claude Code', log: ['aaaaaaa\tClaude Code\t2026-10-09T10:00:00+00:00\tFirst', 'bbbbbbb\tClaude Code\t2026-10-09T11:00:00+00:00\tSecond'], diff: [
      mod('src/a.ts', H(10, ['old'], 10, ['new', 'newer'])),
      ['diff --git a/old/name.ts b/new/name.ts', 'similarity index 92%', 'rename from old/name.ts', 'rename to new/name.ts', 'index 5555555..6666666 100644', '--- a/old/name.ts', '+++ b/new/name.ts', ...H(3, ['x'], 3, ['y'])],
      ['diff --git a/img/logo.png b/img/logo.png', 'index 7777777..8888888 100644', 'Binary files a/img/logo.png and b/img/logo.png differ'],
      ['diff --git a/img/new.png b/img/new.png', 'new file mode 100644', 'index 0000000..9999999', 'Binary files /dev/null and b/img/new.png differ'],
      del('src/gone.ts', ['a', 'b']),
      add('src/fresh.ts', ['export function freshThing() {}']),
      ['diff --git a/bin/run b/bin/run', 'old mode 100644', 'new mode 100755'],
      ['diff --git a/moved.md b/docs/moved.md', 'similarity index 100%', 'rename from moved.md', 'rename to docs/moved.md'],
    ] },
    { name: 'agent/empty', diff: [] },
  ]);
  const r = C.parseInput(text);
  assert.strictEqual(r.kind, 'gather');
  assert.strictEqual(r.base, 'main');
  assert.deepStrictEqual(r.files, ['src/a.ts', 'package.json']);
  assert.deepStrictEqual(r.branches.map((b) => b.name), ['agent/one', 'agent/empty']);
  const one = r.branches[0];
  assert.deepStrictEqual(one.authors, ['Claude Code']);
  assert.strictEqual(one.commits.length, 2);
  const by = Object.fromEntries(one.changes.map((c) => [c.path, c]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['bin/run', 'docs/moved.md', 'img/logo.png', 'img/new.png', 'new/name.ts', 'src/a.ts', 'src/fresh.ts', 'src/gone.ts']);
  assert.deepStrictEqual([by['src/a.ts'].status, by['src/a.ts'].adds, by['src/a.ts'].dels], ['M', 2, 1]);
  assert.deepStrictEqual(by['src/a.ts'].runs.map((x) => [x.i, x.chg, x.add]), [[9, 1, 2]], 'a replacement of base line 10, in git merge form');
  assert.deepStrictEqual([by['new/name.ts'].status, by['new/name.ts'].oldPath], ['R', 'old/name.ts']);
  assert.deepStrictEqual([by['docs/moved.md'].status, by['docs/moved.md'].oldPath, by['docs/moved.md'].runs.length], ['R', 'moved.md', 0]);
  assert.deepStrictEqual([by['img/logo.png'].binary, by['img/logo.png'].status], [true, 'M']);
  assert.deepStrictEqual([by['img/new.png'].binary, by['img/new.png'].status], [true, 'A']);
  assert.deepStrictEqual([by['src/gone.ts'].status, by['src/gone.ts'].dels, by['src/gone.ts'].oldPath], ['D', 2, 'src/gone.ts']);
  assert.deepStrictEqual([by['src/fresh.ts'].status, by['src/fresh.ts'].defs.map((d) => d.name)], ['A', ['freshThing']]);
  assert.strictEqual(by['bin/run'].status, 'M');
  assert.deepStrictEqual(r.branches[1].changes, [], 'a branch with no commits ahead is empty, not an error');
  assert.deepStrictEqual(r.warnings, []);
  const ck = C.analyse(r);
  assert.strictEqual(ck.branches[1].state, 'empty');
  assert.match(ck.verdict.headline, /1 with no changes yet/);
  assert.strictEqual(ck.order.steps[ck.order.steps.length - 1].action, 'skip');
});

test('CRLF, a BOM, chunk boundaries anywhere, and a file cut off before its end marker all read the same', () => {
  const branches = [{ name: 'agent/x', diff: [mod('src/a.ts', H(5, ['a', 'b'], 5, ['c']))] }, { name: 'agent/y', diff: [mod('src/a.ts', H(6, ['b'], 6, ['d']))] }];
  const lf = gather(branches);
  const crlf = '\uFEFF' + gather(branches, { crlf: true });
  const a = JSON.stringify(C.parseInput(lf).branches);
  assert.strictEqual(JSON.stringify(C.parseInput(crlf).branches), a, 'CRLF and a BOM change nothing');
  for (const size of [1, 2, 3, 7, 64]) {
    const p = C.createGatherParser();
    for (let i = 0; i < crlf.length; i += size) p.push(crlf.slice(i, i + size));
    assert.strictEqual(JSON.stringify(p.end().branches), a, `chunks of ${size}`);
  }
  const cut = C.parseInput(gather(branches, { noEnd: true }));
  assert.strictEqual(cut.branches.length, 2);
  assert.ok(cut.warnings.some((w) => /cut off/.test(w)), 'says it may have been cut off');
});

test('malformed sections are counted and skipped, never thrown: bad hunks, bad log lines, unknown markers, junk before the header', () => {
  const text = [
    'some junk the shell printed', '#lanes v1 base=develop', '#lanes files', 'src/a.ts', '"src/caf\\303\\251.ts"', '', '#lanes nonsense here',
    '#lanes branch agent/bad', '#lanes log', 'not a commit line', 'deadbee\tBot\t2026-10-09T10:00:00Z\tok', '#lanes diff',
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,3 @@', '-one', '+uno', // hunk ends early
    'diff --git a/src/b.ts b/src/b.ts', '--- a/src/b.ts', '+++ b/src/b.ts', '@@ garbage @@', '-x', '+y',
    '#lanes branch agent/good', '#lanes diff', ...mod('src/c.ts', H(2, ['x'], 2, ['y'])),
    '#lanes end',
  ].join('\n');
  const r = C.parseInput(text);
  assert.strictEqual(r.kind, 'gather');
  assert.strictEqual(r.base, 'develop');
  assert.deepStrictEqual(r.files, ['src/a.ts', 'src/café.ts'], 'git-quoted paths are unquoted');
  assert.deepStrictEqual(r.branches.map((b) => b.name), ['agent/bad', 'agent/good']);
  assert.strictEqual(r.branches[0].commits.length, 1);
  assert.ok(r.warnings.some((w) => /commit line/.test(w)) && r.warnings.some((w) => /marker/.test(w)) && r.warnings.some((w) => /hunk/.test(w)), r.warnings.join(' | '));
  assert.strictEqual(r.branches[1].changes[0].path, 'src/c.ts', 'a good branch after a bad one is read in full');
  assert.doesNotThrow(() => C.analyse(r));
});

test('a content line that looks like a header ("--- x", "+++ y") inside a hunk is content, by the hunk counts', () => {
  const r = C.parseDiff([...mod('notes.md', H(4, ['-- old rule', '++ odd'], 4, ['-- new rule', '++ odder', '--- even this']))].join('\n'));
  assert.strictEqual(r.files.length, 1);
  assert.deepStrictEqual([r.files[0].adds, r.files[0].dels], [3, 2]);
  assert.strictEqual(r.malformed, 0);
});

test('a quote or a space inside a path does not turn an edit into a rename', () => {
  const p = 'src/we"ird \'name\'.ts';
  const r = C.parseDiff([`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, ...H(3, ['a'], 3, ['b'])].join('\n'));
  assert.deepStrictEqual([r.files[0].status, r.files[0].path, r.files[0].oldPath], ['M', p, p]);
  const q = C.parseDiff(['diff --git a/x y.ts b/x y.ts', 'old mode 100644', 'new mode 100755'].join('\n'));
  assert.deepStrictEqual([q.files[0].status, q.files[0].path], ['M', 'x y.ts'], 'no ---/+++: the symmetric header split');
});

test('other inputs: one pasted diff (git or plain, with context lines), a plain ls-files list, and nothing at all', () => {
  const plain = ['--- src/x.ts\t2026-10-09 10:00:00', '+++ src/x.ts\t2026-10-09 11:00:00', '@@ -10,7 +10,7 @@', ' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g'].join('\n');
  const r = C.parseInput(plain);
  assert.strictEqual(r.kind, 'diff');
  assert.strictEqual(r.diff.files[0].path, 'src/x.ts');
  assert.deepStrictEqual(r.diff.files[0].runs.map((x) => [x.i, x.chg]), [[12, 1]], 'context lines are walked: the change is base line 13');
  const b = C.branchFromDiff('agent/pasted', plain);
  assert.deepStrictEqual([b.name, b.changes.length], ['agent/pasted', 1]);
  const ls = C.parseInput('src/a.ts\r\nsrc/b.ts\n\n./src/c.ts\nsrc/a.ts\n');
  assert.deepStrictEqual([ls.kind, ls.files], ['files', ['src/a.ts', 'src/b.ts', 'src/c.ts']]);
  assert.strictEqual(C.parseInput('   \n').kind, 'empty');
});

test('the real command, run against a throwaway git repo, writes a file the parser reads (renames, binary, deletes, CRLF)', () => {
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (git.status !== 0) { console.log('       (git not installed here - skipped)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-git-'));
  const sh = (cmd) => { const r = spawnSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid', GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid', HOME: dir } }); assert.strictEqual(r.status, 0, cmd + '\n' + r.stderr); return r.stdout; };
  try {
    sh('git init -q -b main . && git config commit.gpgsign false');
    fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'db'));
    fs.writeFileSync(path.join(dir, 'src/db.ts'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'src/old.ts'), 'export const x = 1;\n'.repeat(20));
    fs.writeFileSync(path.join(dir, 'src/crlf.txt'), 'a\r\nb\r\nc\r\n');
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
    fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "name": "t",\n  "version": "1.0.0"\n}\n');
    sh('git add -A && git commit -qm base');
    sh('git switch -qc agent/a');
    fs.writeFileSync(path.join(dir, 'src/db.ts'), fs.readFileSync(path.join(dir, 'src/db.ts'), 'utf8').replace('line 10\n', 'line ten\n'));
    fs.writeFileSync(path.join(dir, 'db/0002_a.sql'), 'select 1;\n');
    fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
    fs.writeFileSync(path.join(dir, 'src/crlf.txt'), 'a\r\nB\r\nc\r\n');
    sh('git mv src/old.ts src/renamed.ts && git rm -q gone.txt && git add -A && git commit -qm "a: work"');
    sh('git switch -q main && git switch -qc agent/b');
    fs.writeFileSync(path.join(dir, 'src/db.ts'), fs.readFileSync(path.join(dir, 'src/db.ts'), 'utf8').replace('line 11\n', 'line eleven\n'));
    fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'db/0002_b.sql'), 'select 2;\n');
    sh('git add -A && git commit -qm "b: work"');
    sh('git switch -q main && git branch agent/nothing');
    const cmd = C.gatherCommand({ base: 'main', pattern: 'agent/*' }).command;
    sh(cmd);
    const r = C.parseInput(fs.readFileSync(path.join(dir, 'lanes.txt'), 'utf8'));
    assert.strictEqual(r.kind, 'gather');
    assert.deepStrictEqual(r.branches.map((b) => b.name).sort(), ['agent/a', 'agent/b', 'agent/nothing']);
    const a = r.branches.find((b) => b.name === 'agent/a');
    const by = Object.fromEntries(a.changes.map((c) => [c.path, c]));
    assert.deepStrictEqual([by['src/renamed.ts'].status, by['src/renamed.ts'].oldPath], ['R', 'src/old.ts']);
    assert.deepStrictEqual([by['logo.png'].binary, by['logo.png'].status], [true, 'A']);
    assert.strictEqual(by['gone.txt'].status, 'D');
    assert.strictEqual(by['src/crlf.txt'].adds, 1);
    assert.deepStrictEqual(a.authors, ['Test Agent']);
    assert.ok(r.files.includes('src/db.ts') && r.files.includes('package.json'));
    const ck = C.analyse(r);
    const db = ck.collisions.find((c) => c.path === 'src/db.ts');
    assert.strictEqual(db.worst, 'adjacent', 'lines 10 and 11: touching, which git reports as a conflict');
    assert.ok(ck.shared.some((s) => s.kind === 'migration'), 'two 0002_ migrations');
    assert.strictEqual(ck.branches.find((b) => b.name === 'agent/nothing').state, 'empty');
    // and git agrees: merging both really conflicts on src/db.ts
    sh('git switch -qc trial agent/a');
    const m = spawnSync('sh', ['-c', 'git merge --no-edit agent/b'], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
    assert.notStrictEqual(m.status, 0, 'git really calls touching lines a conflict');
    assert.match(m.stdout + m.stderr, /CONFLICT \(content\): Merge conflict in src\/db\.ts/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the shell commands: POSIX sh and PowerShell, both present, read git only, and never touch the network', () => {
  const sh = C.gatherCommand({ base: 'main', pattern: 'agent/*' }).command;
  const ps = C.gatherCommand({ base: 'main', pattern: 'agent/*', shell: 'ps' }).command;
  const list = C.gatherCommand({ base: 'develop', mode: 'list', branches: 'agent/a, agent/b' }).command;
  for (const c of [sh, ps, list]) {
    for (const part of ['ls-files', '--unified=0', '--no-color', '#lanes files', '#lanes branch', '#lanes log', '#lanes diff', '#lanes end', 'for-each-ref', 'lanes.txt']) if (c !== list || part !== 'for-each-ref') assert.ok(c.includes(part), `${part} in ${c.slice(0, 40)}`);
    assert.ok(!/curl|wget|https?:|Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b|Invoke-Expression|\biex\b|\beval\b|\bssh\b|\bscp\b|\bnc\b|git (push|fetch|pull|clone|remote)|\|\s*(sh|bash|zsh)\b|base64|\bsudo\b|\brm\b/.test(c), `no network or execution: ${c}`);
  }
  assert.ok(sh.endsWith('> lanes.txt') && /Out-File -Encoding utf8 lanes\.txt$/.test(ps));
  assert.ok(list.includes("'agent/a' 'agent/b'") && list.includes("B='develop'"));
  // Hostile input never reaches the shell.
  for (const bad of [{ base: 'main; rm -rf ~' }, { base: '$(id)' }, { pattern: "x'; touch y" }, { mode: 'list', branches: 'ok `id`' }, { base: '-x' }, { base: 'a..b' }, { out: '../x' }]) assert.ok(C.gatherCommand(bad).error, JSON.stringify(bad));
});

/* ---------------- collisions ---------------- */

test('hunk ranges: overlapping, touching (adjacent), disjoint, identical, and pure additions at the same line', () => {
  const R = C.runRelation;
  assert.strictEqual(R(run(39, 6), run(43, 8)), 'overlap', 'lines 40-45 vs 44-51');
  assert.strictEqual(R(run(9, 1), run(10, 1)), 'adjacent', 'line 10 vs line 11: touching');
  assert.strictEqual(R(run(9, 1), run(11, 1)), null, 'line 10 vs line 12: one untouched line between - clean');
  assert.strictEqual(R(run(10, 0), run(10, 0, 2)), 'overlap', 'two insertions at the same spot');
  assert.strictEqual(R(run(10, 0, 5), run(10, 0, 5)), 'same', 'the identical insertion on both: git merges it');
  assert.strictEqual(R(run(10, 0), run(11, 0)), null, 'insertions after line 10 and after line 11: clean');
  assert.strictEqual(R(run(10, 0), run(10, 1)), 'adjacent', 'an insertion right before a changed line');
  assert.strictEqual(R(run(10, 0), run(9, 1)), 'adjacent', 'an insertion right after a changed line');
  assert.strictEqual(R(run(12, 0), run(9, 5)), 'overlap', 'an insertion inside a replaced block');
  assert.strictEqual(R(run(3, 0), run(16, 1)), null);
  assert.strictEqual(C.runLabel(run(39, 6)), 'lines 40–45');
  assert.strictEqual(C.runLabel(run(16, 0)), 'adds after line 16');
  assert.strictEqual(C.runLabel(run(0, 0)), 'adds at the top');
});

test('file pairs: both add, delete vs edit, binary on both, rename vs edit, rename two ways, the same change twice', () => {
  const ck = check([
    { name: 'x', diff: [add('new.ts', ['a']), del('old.ts', ['q']), mod('logo.png'), mod('same.ts', H(5, ['a'], 5, ['b'])), ['diff --git a/r.ts b/r1.ts', 'rename from r.ts', 'rename to r1.ts'], ['diff --git a/e.ts b/e2.ts', 'rename from e.ts', 'rename to e2.ts']] },
    { name: 'y', diff: [add('new.ts', ['b']), mod('old.ts', H(1, ['q'], 1, ['Q'])), mod('same.ts', H(5, ['a'], 5, ['b'])), ['diff --git a/r.ts b/r2.ts', 'rename from r.ts', 'rename to r2.ts'], mod('e.ts', H(2, ['m'], 2, ['n']))] },
  ]);
  // make logo.png binary on both sides
  const k = (p) => ck.collisions.find((c) => c.path === p);
  assert.strictEqual(k('new.ts').worst, 'both-added');
  assert.strictEqual(k('old.ts').worst, 'delete-modify');
  assert.strictEqual(k('same.ts').worst, 'same');
  assert.strictEqual(k('same.ts').conflict, false);
  assert.strictEqual(k('r.ts').worst, 'rename-rename');
  assert.strictEqual(k('e.ts').worst, 'rename', 'renamed on one side, edited on the other: git usually follows it');
  assert.strictEqual(k('e.ts').conflict, false);
  const bin = check([
    { name: 'x', diff: [['diff --git a/a.png b/a.png', 'Binary files a/a.png and b/a.png differ']] },
    { name: 'y', diff: [['diff --git a/a.png b/a.png', 'Binary files a/a.png and b/a.png differ']] },
  ]);
  assert.strictEqual(bin.collisions[0].worst, 'binary');
});

test('the matrix counts shared and conflicting files per pair; the verdict names clean branches, colliders and files', () => {
  const ck = check([
    { name: 'a', diff: [mod('f1.ts', H(10, ['x'], 10, ['y'])), mod('f2.ts', H(1, ['x'], 1, ['y']))] },
    { name: 'b', diff: [mod('f1.ts', H(10, ['x'], 10, ['z'])), mod('f2.ts', H(50, ['x'], 50, ['y']))] },
    { name: 'c', diff: [mod('f3.ts', H(1, ['x'], 1, ['y']))] },
  ]);
  assert.deepStrictEqual(ck.matrix[0][1], { shared: 2, conflicts: 1 });
  assert.deepStrictEqual(ck.matrix[1][0], { shared: 2, conflicts: 1 });
  assert.deepStrictEqual(ck.matrix[0][2], { shared: 0, conflicts: 0 });
  assert.strictEqual(ck.verdict.headline, '1 branch merges clean · 2 collide on 1 file');
  assert.strictEqual(ck.verdict.tone, 'collide');
  assert.deepStrictEqual(ck.branches.map((b) => b.state), ['collides', 'collides', 'clean']);
  const calm = check([{ name: 'a', diff: [mod('f1.ts', H(1, ['x'], 1, ['y']))] }, { name: 'b', diff: [mod('f2.ts', H(1, ['x'], 1, ['y']))] }]);
  assert.deepStrictEqual([calm.verdict.headline, calm.verdict.tone], ['2 branches merge clean', 'clean']);
});

/* ---------------- shared state ---------------- */

test('lockfiles: every common one is recognised, flagged as a clash on two branches, with its regenerate command', () => {
  for (const [lock, cmd] of [['package-lock.json', 'npm install'], ['yarn.lock', 'yarn install'], ['pnpm-lock.yaml', 'pnpm install'], ['Gemfile.lock', 'bundle install'], ['poetry.lock', 'poetry lock --no-update'], ['Cargo.lock', 'cargo update --workspace'], ['go.sum', 'go mod tidy'], ['uv.lock', 'uv lock'], ['composer.lock', 'composer update --lock']]) {
    assert.strictEqual(C.hotspotKind(lock), 'lockfile', lock);
    assert.strictEqual(C.hotspotKind('services/api/' + lock), 'lockfile', 'nested ' + lock);
    const ck = check([{ name: 'a', diff: [mod(lock, H(5, ['x'], 5, ['y']))] }, { name: 'b', diff: [mod(lock, H(900, ['x'], 900, ['y']))] }]);
    const s = ck.shared.find((x) => x.kind === 'lockfile');
    assert.ok(s && s.severity === 'clash', lock);
    assert.ok(s.fix.includes(cmd), `${lock}: ${s.fix}`);
    assert.strictEqual(ck.verdict.colliding, 2, `${lock}: two branches on one lockfile collide even on different lines`);
  }
  const one = check([{ name: 'a', diff: [mod('yarn.lock', H(5, ['x'], 5, ['y']))] }, { name: 'b', diff: [mod('src/x.ts', H(5, ['x'], 5, ['y']))] }]);
  assert.strictEqual(one.shared.find((x) => x.kind === 'lockfile').severity, 'info', 'one branch on a lockfile is a note');
});

test('manifests: dependencies added on both sides, the same dependency to two versions, and version bumps of one field', () => {
  const ck = check([
    { name: 'a', diff: [mod('package.json', H(3, ['  "version": "1.8.0",'], 3, ['  "version": "1.9.0",']), H(22, [], 23, ['    "jose": "^5.9.6",']), H(30, ['    "zod": "^3.22.0",'], 31, ['    "zod": "^3.23.8",']))] },
    { name: 'b', diff: [mod('package.json', H(3, ['  "version": "1.8.0",'], 3, ['  "version": "1.8.1",']), H(25, [], 26, ['    "stripe": "^17.3.1",']), H(30, ['    "zod": "^3.22.0",'], 31, ['    "zod": "^3.24.1",']))] },
  ]);
  const deps = ck.shared.find((s) => s.kind === 'deps');
  assert.strictEqual(deps.severity, 'clash', 'zod to two versions');
  assert.match(deps.detail, /zod/);
  assert.ok(deps.each.some((e) => /adds jose/.test(e.text)) && deps.each.some((e) => /adds stripe/.test(e.text)));
  const ver = ck.shared.find((s) => s.kind === 'version');
  assert.ok(ver && ver.severity === 'clash');
  assert.deepStrictEqual(ver.each.map((e) => e.text), ['1.8.0 → 1.9.0', '1.8.0 → 1.8.1']);
  assert.ok(!ck.shared.some((s) => s.kind === 'manifest'), 'the generic manifest note gives way to the specific ones');
  // other ecosystems
  assert.deepStrictEqual(C.depOf('requirements.txt', 'django==5.1.2'), { name: 'django', ver: '==5.1.2' });
  assert.deepStrictEqual(C.depOf('Gemfile', "gem 'rails', '~> 7.2'"), { name: 'rails', ver: '~> 7.2' });
  assert.deepStrictEqual(C.depOf('go.mod', '\tgithub.com/stretchr/testify v1.9.0'), { name: 'github.com/stretchr/testify', ver: 'v1.9.0' });
  assert.deepStrictEqual(C.depOf('Cargo.toml', 'serde = { version = "1.0", features = ["derive"] }'), { name: 'serde', ver: '1.0' });
  assert.strictEqual(C.depOf('package.json', '    "build": "vite build",'), null, 'a script is not a dependency');
  assert.strictEqual(C.versionOf('pyproject.toml', 'version = "0.4.1"'), '0.4.1');
  assert.strictEqual(C.versionOf('VERSION', '2.0.0'), '2.0.0');
  const same = check([{ name: 'a', diff: [mod('pyproject.toml', H(3, ['version = "0.4.0"'], 3, ['version = "0.5.0"']))] }, { name: 'b', diff: [mod('pyproject.toml', H(3, ['version = "0.4.0"'], 3, ['version = "0.5.0"']))] }]);
  assert.match(same.shared.find((s) => s.kind === 'version').detail, /Both claim version 0\.5\.0/);
  assert.strictEqual(same.collisions[0].worst, 'same', 'and the identical line itself merges');
});

test('migrations: each naming scheme recognised, a clash found per scheme, different numbers and other folders left alone', () => {
  const cases = [
    ['sql', 'db/migrations/0042_add_sessions.sql', 'db/migrations/0042_add_invoices.sql', 'db/migrations/0043_other.sql'],
    ['django', 'billing/migrations/0007_invoice.py', 'billing/migrations/0007_refund.py', 'auth/migrations/0007_token.py'],
    ['rails', 'db/migrate/20261009120000_add_sessions.rb', 'db/migrate/20261009120000_add_invoices.rb', 'db/migrate/20261009120001_other.rb'],
    ['prisma', 'prisma/migrations/20261009120000_sessions/migration.sql', 'prisma/migrations/20261009120000_invoices/migration.sql', 'prisma/migrations/20261009130000_x/migration.sql'],
    ['timestamp', 'migrations/20261009120000_sessions.js', 'migrations/20261009120000_invoices.js', 'migrations/20261009120001_x.js'],
    ['timestamp', 'src/migrations/1728475200000-Sessions.ts', 'src/migrations/1728475200000-Invoices.ts', 'src/migrations/1728475200001-X.ts'],
    ['flyway', 'src/main/resources/db/migration/V42__sessions.sql', 'src/main/resources/db/migration/V42__invoices.sql', 'src/main/resources/db/migration/V43__x.sql'],
    ['sql', 'migrations/000042_sessions.up.sql', 'migrations/000042_invoices.up.sql', 'migrations/000043_x.up.sql'],
  ];
  for (const [scheme, a, b, other] of cases) {
    assert.strictEqual(C.migrationOf(a).scheme, scheme, a);
    assert.strictEqual(C.hotspotKind(a), 'migration', a);
    const clash = check([{ name: 'x', diff: [add(a, ['x'])] }, { name: 'y', diff: [add(b, ['y'])] }]);
    const m = clash.shared.filter((s) => s.kind === 'migration');
    assert.strictEqual(m.length, 1, `${scheme}: ${a} vs ${b}`);
    assert.strictEqual(clash.verdict.migrationClashes, 1);
    const fine = check([{ name: 'x', diff: [add(a, ['x'])] }, { name: 'y', diff: [add(other, ['y'])] }]);
    assert.strictEqual(fine.shared.filter((s) => s.kind === 'migration').length, 0, `${scheme}: ${a} vs ${other} is fine`);
  }
  assert.strictEqual(C.migrationOf('db/migrations/0042_x.sql').key, C.migrationOf('db/migrations/42_y.sql').key, '0042 and 42 are one number');
  // alembic: two heads from one parent
  const al = (p, rev) => add(p, [`revision = '${p.slice(-8, -3)}'`, `down_revision = '${rev}'`]);
  const heads = check([{ name: 'x', diff: [al('alembic/versions/aaaa1111.py', 'base0000')] }, { name: 'y', diff: [al('alembic/versions/bbbb2222.py', 'base0000')] }]);
  assert.match(heads.shared.find((s) => s.kind === 'migration').detail, /two heads/);
  const chain = check([{ name: 'x', diff: [al('alembic/versions/aaaa1111.py', 'base0000')] }, { name: 'y', diff: [al('alembic/versions/bbbb2222.py', 'other000')] }]);
  assert.strictEqual(chain.shared.filter((s) => s.kind === 'migration').length, 0);
  assert.strictEqual(C.migrationOf('src/lib/2024_report.ts'), null, 'a numbered file that is not a migration');
  assert.strictEqual(C.migrationOf('db/migrations/__init__.py'), null);
});

test('generated files (by path and by a marker in the diff), CI config, agent instructions, changelogs, schema and registries', () => {
  for (const p of ['dist/app.js', 'src/api/__generated__/client.ts', 'proto/user.pb.go', 'models/user_pb2.py', 'lib/x.g.dart', 'web/app.min.js', 'src/__snapshots__/a.snap']) assert.strictEqual(C.hotspotKind(p), 'generated', p);
  const mark = check([{ name: 'a', diff: [mod('src/schema.ts', H(1, ['// @generated by openapi-typescript. DO NOT EDIT.'], 1, ['// @generated by openapi-typescript. DO NOT EDIT. v2']))] }, { name: 'b', diff: [] }]);
  assert.ok(mark.shared.some((s) => s.kind === 'generated' && s.paths[0] === 'src/schema.ts'), 'a "generated" marker in the diff');
  const plain = check([{ name: 'a', diff: [mod('src/handwritten.ts', H(1, ['a'], 1, ['b']))] }]);
  assert.ok(!plain.shared.some((s) => s.kind === 'generated'));
  for (const p of ['.github/workflows/ci.yml', '.gitlab-ci.yml', '.circleci/config.yml', 'Jenkinsfile']) assert.strictEqual(C.hotspotKind(p), 'ci', p);
  for (const p of ['CLAUDE.md', 'packages/web/CLAUDE.md', 'AGENTS.md', '.cursorrules', '.cursor/rules/style.mdc', '.github/copilot-instructions.md', 'GEMINI.md']) assert.strictEqual(C.hotspotKind(p), 'agent', p);
  for (const p of ['CHANGELOG.md', 'docs/CHANGES.md', 'HISTORY.rst']) assert.strictEqual(C.hotspotKind(p), 'changelog', p);
  for (const p of ['db/schema.rb', 'prisma/schema.prisma']) assert.strictEqual(C.hotspotKind(p), 'schema', p);
  for (const p of ['src/routes/index.ts', 'app/urls.py', 'config/routes.rb']) assert.strictEqual(C.hotspotKind(p), 'registry', p);
  assert.strictEqual(C.hotspotKind('src/components/Button.tsx'), null);
  const two = (p) => check([{ name: 'a', diff: [mod(p, H(1, ['x'], 1, ['y']))] }, { name: 'b', diff: [mod(p, H(40, ['x'], 40, ['y']))] }]);
  for (const [p, kind] of [['CLAUDE.md', 'agent'], ['.github/workflows/ci.yml', 'ci'], ['CHANGELOG.md', 'changelog'], ['db/schema.rb', 'schema']]) {
    const s = two(p).shared.find((x) => x.kind === kind);
    assert.ok(s && s.severity === 'warn' && s.branches.length === 2, `${p} edited by two`);
  }
  const single = check([{ name: 'a', diff: [mod('CHANGELOG.md', H(1, ['x'], 1, ['y']))] }, { name: 'b', diff: [] }]);
  assert.ok(!single.shared.some((s) => s.kind === 'changelog'), 'a changelog edited by one branch is fine');
});

/* ---------------- duplicate work ---------------- */

test('duplicates: the same helper added on two branches in different files, look-alike new files - and no false alarms', () => {
  const ck = check([
    { name: 'a', diff: [add('src/features/search/useDebounce.ts', ['export function debounce(fn, ms) {', '}']), add('src/billing/stripe.ts', ['export const stripeClient = new Stripe(key);'])] },
    { name: 'b', diff: [add('src/lib/debounce.ts', ['export const debounce = (fn, wait = 200) => {', '};']), add('app/helpers.py', ['def format_money(cents):', '    pass'])] },
    { name: 'c', diff: [add('tools/money.py', ['def format_money(c):', '    return c']), mod('src/x.ts', H(4, ['export function render(a) {'], 4, ['export function render(a, b) {']))] },
    { name: 'd', diff: [mod('src/y.ts', H(4, ['function render(a) {'], 4, ['function render(a, b) {'])), add('tests/debounce.test.ts', ['function debounce() {}']), add('src/z.ts', ['export function setup() {}', 'const handler = () => {}'])] },
  ]);
  const names = ck.dupes.symbols.map((s) => s.name).sort();
  assert.deepStrictEqual(names, ['debounce', 'format_money']);
  const deb = ck.dupes.symbols.find((s) => s.name === 'debounce');
  assert.deepStrictEqual(deb.defs.map((d) => [ck.branches[d.bi].name, d.path, d.line]), [['a', 'src/features/search/useDebounce.ts', 1], ['b', 'src/lib/debounce.ts', 1]]);
  assert.strictEqual(deb.samePath, false);
  assert.deepStrictEqual(ck.dupes.files.map((f) => [f.a.path, f.b.path, f.why]), [['src/features/search/useDebounce.ts', 'src/lib/debounce.ts', 'similar name']]);
  // Negative: a modified signature is not a new definition, test files and stop-word names do not count.
  const neg = check([
    { name: 'a', diff: [mod('src/x.ts', H(4, ['export function render(a) {'], 4, ['export function render(a, b) {'])), add('src/index.ts', ['export function setup() {}']), add('tests/util.test.ts', ['function makeUser() {}'])] },
    { name: 'b', diff: [mod('src/x.ts', H(40, ['export function render(a) {'], 40, ['export function render(a, c) {'])), add('lib/index.ts', ['export function setup() {}']), add('tests/other.test.ts', ['function makeUser() {}'])] },
  ]);
  assert.deepStrictEqual(neg.dupes, { symbols: [], files: [] });
  for (const [line, name] of [['export async function createInvoice(id: string) {', 'createInvoice'], ['def verify_token(self, t):', 'verify_token'], ['func (s *Server) HandleLogin(w http.ResponseWriter) {', 'HandleLogin'], ['pub fn parse_config(s: &str) -> Config {', 'parse_config'], ['class InvoiceService:', 'InvoiceService'], ['export interface BillingPlan {', 'BillingPlan'], ['const useCart = () => {', 'useCart'], ['let x = 5;', null], ['export default function () {', null]]) assert.strictEqual(C.definedName(line), name, line);
});

/* ---------------- merge order ---------------- */

test('merge order: clean branches first (smallest first), the fewest branches rebase, and each resolves once', () => {
  const ck = check([
    { name: 'hub', diff: [mod('a.ts', H(10, ['x'], 10, ['y'])), mod('b.ts', H(10, ['x'], 10, ['y']))] },
    { name: 'left', diff: [mod('a.ts', H(10, ['x', 'y', 'z'], 10, ['p', 'q', 'r', 's']))] },
    { name: 'right', diff: [mod('b.ts', H(10, ['x', 'y'], 10, ['p', 'q', 'r']))] },
    { name: 'tidy-big', diff: [mod('c.ts', H(1, ['a', 'b', 'c', 'd'], 1, ['e', 'f', 'g']))] },
    { name: 'tidy', diff: [mod('d.ts', H(1, ['a'], 1, ['b']))] },
  ]);
  assert.deepStrictEqual(ck.order.steps.map((s) => [s.name, s.action]), [['tidy', 'merge'], ['tidy-big', 'merge'], ['left', 'merge'], ['right', 'merge'], ['hub', 'rebase']]);
  assert.deepStrictEqual(ck.order.resolvers.map((i) => ck.branches[i].name), ['hub'], 'hub collides with both: it rebases once');
  const last = ck.order.steps[4];
  assert.deepStrictEqual(last.resolve.map((r) => [r.path, r.with]), [['a.ts', 'left'], ['b.ts', 'right']]);
  assert.ok(last.commands[0] === 'git switch hub' && last.commands[1] === 'git rebase main' && last.commands.includes('git push --force-with-lease'));
  assert.match(last.why, /rebase it once/);
  // two branches on one file: the smaller change is the one redone
  const pair = check([{ name: 'small', diff: [mod('a.ts', H(10, ['x'], 10, ['y']))] }, { name: 'large', diff: [mod('a.ts', H(9, ['w', 'x', 'y', 'z'], 9, ['1', '2', '3', '4', '5']))] }]);
  assert.deepStrictEqual(pair.order.steps.map((s) => [s.name, s.action]), [['large', 'merge'], ['small', 'rebase']]);
});

test('merge order: a branch stacked on another goes after it; migration clashes get a renumber command; lockfiles a regenerate', () => {
  const ck = check([
    { name: 'child', log: ['aaaaaaa\tA\t2026-10-09T10:00:00Z\tbase work', 'bbbbbbb\tA\t2026-10-09T11:00:00Z\tchild work'], diff: [mod('a.ts', H(10, ['x'], 10, ['y'])), add('db/migrations/0007_child.sql', ['x']), mod('yarn.lock', H(3, ['a'], 3, ['b']))] },
    { name: 'parent', log: ['aaaaaaa\tA\t2026-10-09T10:00:00Z\tbase work'], diff: [mod('a.ts', H(10, ['x'], 10, ['z', 'zz', 'zzz'])), add('db/migrations/0007_parent.sql', ['x', 'y']), mod('yarn.lock', H(3, ['a'], 3, ['c']))] },
  ], { files: ['db/migrations/0005_a.sql', 'db/migrations/0006_b.sql', 'yarn.lock'] });
  assert.deepStrictEqual(ck.order.deps[0], [1], 'every commit of parent is in child');
  assert.deepStrictEqual(ck.order.steps.map((s) => s.name), ['parent', 'child']);
  const c = ck.order.steps[1];
  assert.ok(c.commands.includes('git mv db/migrations/0007_child.sql db/migrations/0008_child.sql'), c.commands.join('\n'));
  assert.ok(c.commands.some((x) => x.startsWith('yarn install && git commit')), 'regenerate the lockfile once at the end');
  assert.ok(c.commands.some((x) => /git checkout --ours yarn\.lock/.test(x)), 'take main\u2019s lockfile during the rebase');
  assert.deepStrictEqual(c.renames, [{ from: 'db/migrations/0007_child.sql', to: 'db/migrations/0008_child.sql', after: ['parent'] }]);
  // a branch name that is not shell-safe is quoted in every command
  const odd = check([{ name: "feat/it's", diff: [mod('a.ts', H(1, ['x'], 1, ['y']))] }, { name: 'b', diff: [mod('a.ts', H(1, ['x'], 1, ['z', 'q']))] }]);
  assert.ok(odd.order.steps.every((s) => s.commands.every((cmd) => !cmd.includes("feat/it's") || cmd.includes("'feat/it'\\''s'"))), 'single-quoted with the quote escaped');
});

/* ---------------- the example ---------------- */

test('the example exhibits exactly the planted issues, and agent/docs is completely clean', () => {
  const r = C.parseInput(D.gather());
  assert.strictEqual(r.kind, 'gather');
  assert.deepStrictEqual(r.warnings, []);
  assert.ok(r.files.length >= 115 && r.files.length <= 130, `~120 files: ${r.files.length}`);
  assert.deepStrictEqual(r.branches.map((b) => b.name), ['agent/auth', 'agent/billing', 'agent/search', 'agent/ui-polish', 'agent/docs']);
  const ck = C.analyse(r);
  assert.strictEqual(ck.verdict.headline, '2 branches merge clean · 3 collide on 4 files · 1 migration number clash');
  assert.strictEqual(ck.verdict.sub, '1 lockfile changed on several branches · 1 version bump clash · 1 helper written twice · 1 generated file edited by hand');
  const nm = (i) => ck.branches[i].name;
  const cols = ck.collisions.map((c) => [c.path, c.worst, c.pairs.map((p) => `${nm(p.a)}×${nm(p.b)}:${p.kind}`).join(',')]);
  assert.deepStrictEqual(cols, [
    ['src/lib/db.ts', 'overlap', 'agent/auth×agent/billing:overlap'],
    ['package-lock.json', 'overlap', 'agent/auth×agent/billing:overlap'],
    ['package.json', 'overlap', 'agent/auth×agent/billing:overlap'],
    ['src/routes/index.ts', 'adjacent', 'agent/auth×agent/billing:clean,agent/auth×agent/search:clean,agent/billing×agent/search:adjacent'],
  ]);
  const db = ck.collisions[0].pairs[0].spots[0];
  assert.deepStrictEqual([C.runLabel(db.a), C.runLabel(db.b)], ['lines 40–45', 'lines 44–51'], 'the same lines of src/lib/db.ts');
  assert.deepStrictEqual(ck.shared.map((s) => [s.kind, s.severity, s.paths.join(','), s.branches.map(nm).join(',')]), [
    ['lockfile', 'clash', 'package-lock.json', 'agent/auth,agent/billing'],
    ['migration', 'clash', 'db/migrations/0042_add_sessions.sql,db/migrations/0042_add_invoices.sql', 'agent/auth,agent/billing'],
    ['version', 'clash', 'package.json', 'agent/auth,agent/billing'],
    ['registry', 'warn', 'src/routes/index.ts', 'agent/auth,agent/billing,agent/search'],
    ['deps', 'warn', 'package.json', 'agent/auth,agent/billing'],
    ['generated', 'warn', 'src/api/__generated__/client.ts', 'agent/search'],
  ]);
  assert.deepStrictEqual(ck.dupes.symbols.map((s) => [s.name, s.branches.map(nm).join(',')]), [['debounce', 'agent/search,agent/ui-polish']]);
  assert.deepStrictEqual(ck.dupes.files.map((f) => [f.a.path, f.b.path]), [['src/features/search/useDebounce.ts', 'src/lib/debounce.ts']]);
  assert.deepStrictEqual(ck.branches.map((b) => b.state), ['collides', 'collides', 'collides', 'check', 'clean']);
  const docs = 4;
  assert.ok(ck.collisions.every((c) => !c.branches.includes(docs)) && ck.shared.every((s) => !s.branches.includes(docs)) && ck.dupes.symbols.every((s) => !s.branches.includes(docs)) && ck.dupes.files.every((f) => f.a.bi !== docs && f.b.bi !== docs), 'agent/docs touches nothing anyone else does');
  assert.deepStrictEqual(ck.order.steps.map((s) => `${s.name}:${s.action}`), ['agent/docs:merge', 'agent/ui-polish:merge', 'agent/auth:merge', 'agent/search:merge', 'agent/billing:rebase']);
  const billing = ck.order.steps[4];
  assert.ok(billing.commands.includes('git mv db/migrations/0042_add_invoices.sql db/migrations/0043_add_invoices.sql'));
  assert.ok(billing.commands.some((c) => c.startsWith('npm install && git commit')));
  assert.ok(ck.order.steps[3].notes.some((n) => /debounce is already in from agent\/ui-polish/.test(n)), 'search is told to use ui-polish\u2019s helper');
  assert.strictEqual(D.gather(), D.gather(), 'deterministic');
});

/* ---------------- globs and the plan ---------------- */

test('globs: ** * ? classes, braces, folders, patterns with no slash, negation, and bad patterns', () => {
  const F = ['src/a.ts', 'src/b.tsx', 'src/lib/c.ts', 'src/lib/deep/d.ts', 'lib/e.ts', 'package.json', 'apps/web/package.json', 'docs/x.md', 'src/lib2/f.ts'];
  const m = (g) => F.filter((f) => C.compileGlob(g).re.test(f));
  assert.deepStrictEqual(m('src/**'), ['src/a.ts', 'src/b.tsx', 'src/lib/c.ts', 'src/lib/deep/d.ts', 'src/lib2/f.ts']);
  assert.deepStrictEqual(m('src/*'), ['src/a.ts', 'src/b.tsx', 'src/lib/c.ts', 'src/lib/deep/d.ts', 'src/lib2/f.ts'], 'src/* names folders too, and a folder means everything under it');
  assert.deepStrictEqual(m('src/*.ts'), ['src/a.ts']);
  assert.deepStrictEqual(m('src/**/*.ts'), ['src/a.ts', 'src/lib/c.ts', 'src/lib/deep/d.ts', 'src/lib2/f.ts'], '** matches zero folders too');
  assert.deepStrictEqual(m('src/?.ts'), ['src/a.ts']);
  assert.deepStrictEqual(m('src/[ab].ts*'), ['src/a.ts', 'src/b.tsx']);
  assert.deepStrictEqual(m('src/{a.ts,lib/c.ts}'), ['src/a.ts', 'src/lib/c.ts']);
  assert.deepStrictEqual(m('src/lib'), ['src/lib/c.ts', 'src/lib/deep/d.ts'], 'a folder name owns what is under it, not src/lib2');
  assert.deepStrictEqual(m('src/lib/'), ['src/lib/c.ts', 'src/lib/deep/d.ts']);
  assert.deepStrictEqual(m('package.json'), ['package.json', 'apps/web/package.json'], 'no slash: at any depth');
  assert.deepStrictEqual(m('/package.json'), ['package.json'], 'a leading slash anchors it');
  assert.deepStrictEqual(m('*.md'), ['docs/x.md']);
  assert.deepStrictEqual(Array.from(C.matchMask(['src/**', '!src/lib/**'], F)).map((x, i) => (x ? F[i] : null)).filter(Boolean), ['src/a.ts', 'src/b.tsx', 'src/lib2/f.ts'], '! takes files back out');
  assert.deepStrictEqual(Array.from(C.matchMask(['!src/**'], F)).filter(Boolean), [], 'a negation alone owns nothing');
  for (const bad of ['', '   ', '../etc/passwd', 'src/../x', 'x'.repeat(300)]) assert.ok(C.compileGlob(bad).error, JSON.stringify(bad.slice(0, 20)));
  assert.strictEqual(C.globCount('src/lib/**', F).count, 2);
});

test('the plan: overlaps between lanes, hotspots with rules no lane owns, reserved migration numbers, files nobody owns', () => {
  const ck = C.checkPlan(D.plan(), D.files());
  assert.deepStrictEqual(ck.overlaps.map((o) => [ck.plan.lanes[o.a].name, ck.plan.lanes[o.b].name, o.count, o.examples]), [['search', 'ui-polish', 1, ['src/components/Header.tsx']]]);
  const ui = ck.lanes[3];
  assert.strictEqual(ui.owned, 15, 'components minus ProductList, plus styles');
  assert.ok(ui.globs.find((g) => g.glob === '!src/components/ProductList.tsx').neg);
  const kinds = ck.hotspots.map((h) => `${h.kind}:${h.label}`);
  assert.deepStrictEqual(kinds, ['lockfile:package-lock.json', 'manifest:package.json', 'migration:db/migrations/NNNN_*', 'agent:CLAUDE.md', 'generated:src/api/__generated__/', 'ci:.github/workflows/ci.yml', 'ci:.github/workflows/deploy.yml', 'registry:src/routes/index.ts', 'changelog:CHANGELOG.md']);
  assert.match(ck.hotspots[0].rule, /Only the lead touches package-lock\.json/);
  assert.deepStrictEqual(ck.reserve.byLane, { auth: [{ dir: 'db/migrations', number: '0042', scheme: 'sql' }], billing: [{ dir: 'db/migrations', number: '0043', scheme: 'sql' }], search: [], 'ui-polish': [] });
  assert.strictEqual(ck.lanes[0].globs.find((g) => g.glob === 'src/auth/**').fresh, true, 'a new folder is "new", not an error');
  assert.ok(ck.unowned > 0);
  // a lane that owns everything reaches the hotspots, which stay out of its owned count
  const greedy = C.checkPlan({ lanes: [{ name: 'all', task: 'x', owns: ['**'] }] }, D.files());
  assert.ok(greedy.hotspots.every((h) => h.ownedBy.includes(0)));
  assert.strictEqual(greedy.lanes[0].owned + greedy.lanes[0].hotOwned, D.files().length);
  // a custom rule replaces the default in the check and the brief
  const custom = C.checkPlan(Object.assign(D.plan(), { rules: { 'lockfile|package-lock.json': 'Priya alone runs npm install.' } }), D.files());
  assert.strictEqual(custom.hotspots[0].rule, 'Priya alone runs npm install.');
  assert.ok(C.brief(custom, 0).includes('Priya alone runs npm install.'));
  // explicit migration counts
  const p = D.plan(); p.lanes[2].migrations = 2; p.lanes[0].migrations = 0;
  assert.deepStrictEqual(C.reserveMigrations(C.cleanPlan(p), D.files()).byLane, { auth: [], billing: [{ dir: 'db/migrations', number: '0042', scheme: 'sql' }], search: [{ dir: 'db/migrations', number: '0043', scheme: 'sql' }, { dir: 'db/migrations', number: '0044', scheme: 'sql' }], 'ui-polish': [] });
});

test('lane names and the plan cleaner: tasks become slugs, names stay unique, junk is dropped', () => {
  assert.strictEqual(C.laneName('Add invoices and Stripe billing'), 'invoices-stripe');
  assert.strictEqual(C.laneName('Sign-in with magic links'), 'sign-in-magic');
  assert.strictEqual(C.laneName('Fix the', ['lane']), 'lane-2');
  const p = C.cleanPlan({ lanes: [{ name: 'A B', task: 'x', owns: ['src/**', '../no', 7] }, { name: 'a-b', task: 'y' }, null], base: 'main; rm', prefix: '$(x)/', repo: '../up', rules: { k: '<b>rule</b>' } });
  assert.deepStrictEqual(p.lanes.map((l) => l.name), ['a-b', 'a-b-2']);
  assert.deepStrictEqual(p.lanes[0].owns, ['src/**', '7'], 'invalid patterns dropped');
  assert.deepStrictEqual([p.base, p.prefix, p.repo], ['main', 'lane/', 'app']);
  const t = C.tasksToLanes(['one task', 'two task'], [{ name: 'kept', task: 'one task', owns: ['a/**'], readOnly: [] }]);
  assert.deepStrictEqual(t.map((l) => [l.name, l.owns]), [['kept', ['a/**']], ['two-task', []]], 'a lane whose task did not change keeps its paths');
});

test('briefs: the task, owned and read-only paths, other lanes, hotspot rules, migration numbers and the worktree command', () => {
  const ck = C.checkPlan(D.plan(), D.files());
  const b = C.brief(ck, 1);
  for (const s of ['# Lane: billing', '**Branch:** `agent/billing` from `main`', 'git worktree add -b agent/billing ../shopfront-billing main', 'Invoices and Stripe billing',
    '- `src/billing/**` (new)', '- `src/lib/money.ts` (1 file)', '- `src/lib/**`', 'lane auth (working on it right now)', '`package-lock.json`: Only the lead touches package-lock.json',
    'Use number `0043` in `db/migrations/` and no other', 'Priya (the lead) merges in order']) assert.ok(b.includes(s), `brief lacks: ${s}\n${b}`);
  const none = C.brief(ck, 2);
  assert.ok(none.includes('This lane has no migration number'));
  const all = C.allBriefs(D.plan(), D.files());
  assert.ok(all.startsWith('# Lanes: 4 agents in parallel'));
  assert.strictEqual((all.match(/^# Lane: /gm) || []).length, 4);
  assert.ok(all.includes('search and ui-polish (1 file)'), 'the overlap is warned about at the top');
  assert.strictEqual((all.match(/git worktree add -b/g) || []).length, 8, 'once in the setup block, once per brief');
});

/* ---------------- hostile strings ---------------- */

const EVIL = '<img src=x onerror=alert(1)>\u202Eevil\u0007`|*[link](javascript:alert(1))';
test('hostile paths, branch names, commit messages and diff lines: stripped of control and bidi, escaped for HTML and Markdown', () => {
  const text = gather([{ name: `agent/${EVIL}`, log: [`abcdef1\t${EVIL}\t2026-10-09T10:00:00Z\t${EVIL}${'x'.repeat(5000)}`], diff: [add(`src/${EVIL}.ts`, [`export function evilThing() { return "${EVIL}" }`, 'y'.repeat(20000)])] }, { name: 'b', diff: [add(`src/${EVIL}.ts`, ['z'])] }], { files: [`src/${EVIL}.ts`] });
  const r = C.parseInput(text);
  const b = r.branches[0];
  assert.ok(!/[\u202E\u0007]/.test(b.name + b.commits[0].subject + b.commits[0].author + b.changes[0].path + r.files[0]), 'no bidi or control characters kept');
  assert.ok(b.commits[0].subject.length <= 160, 'commit subjects are bounded');
  assert.ok(b.changes[0].hunks[0].lines.every((l) => l[1].length <= C.LIMITS.lineShow + 1), 'very long lines are cut for display');
  const html = C.esc(b.name + b.changes[0].path + b.changes[0].hunks[0].lines[0][1]);
  assert.ok(!/<img|<\/?script/i.test(html) && html.includes('&lt;img'));
  const ck = C.analyse(r);
  const md = C.toMarkdown(ck);
  const prose = md.replace(/\\`/g, '').replace(/^\s*(`{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '').replace(/(`+)[\s\S]*?\1/g, '');
  assert.ok(!/<img/i.test(prose) && !/\]\(javascript:/.test(prose), 'no markup or link outside code spans and code blocks:\n' + prose);
  assert.ok(!/[\u202E\u0007]/.test(md + C.toJson(ck)));
  assert.ok(!md.includes('evilThing') && !C.toJson(ck).includes('evilThing') && !md.includes('yyyyyyyy'), 'exports carry no line of code');
  assert.doesNotThrow(() => JSON.parse(C.toJson(ck)));
  assert.strictEqual(C.mdCode('a`b'), '`` a`b ``');
  const plan = C.cleanPlan({ lanes: [{ name: EVIL, task: EVIL, owns: [`src/${EVIL}/**`] }] });
  const brief = C.brief(C.checkPlan(plan, r.files), 0);
  assert.ok(!/[\u202E\u0007]/.test(brief));
  assert.ok(!/^#+ .*<img/m.test(brief) && !/^\s*[-*] \[link\]/m.test(brief));
});

/* ---------------- static checks ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface in both themes; marks 3:1', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2', 'code-bg']) for (const fg of ['text', 'muted', 'link']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2']) assert.ok(ratio(t.err, t[bg]) >= 4.5, `${name} err on ${bg}`);
    assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, `${name} accent-ink on accent: ${ratio(t['accent-ink'], t.accent).toFixed(2)}`);
    for (const [fg, bg] of [['good', 'good-bg'], ['warn', 'warn-bg'], ['err', 'err-bg'], ['text', 'good-bg'], ['text', 'err-bg'], ['text', 'warn-bg'], ['text', 'accent-soft'], ['link', 'accent-soft'], ['muted', 'card2']]) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['add-bg', 'del-bg', 'hl-bg']) { assert.ok(ratio(t.text, t[bg]) >= 4.5, `${name} code on ${bg}: ${ratio(t.text, t[bg]).toFixed(2)}`); assert.ok(ratio(t.muted, t[bg]) >= 4.5 || bg === 'hl-bg', `${name} line numbers on ${bg}`); }
    assert.ok(ratio(t['strip-ink'], t.strip) >= 4.5 && ratio(t['strip-muted'], t.strip) >= 4.5 && ratio(t['strip-btn-ink'], t['strip-btn']) >= 4.5, `${name} the strip`);
    assert.ok(ratio(t.bg, t.text) >= 4.5, `${name} toast (inverted)`);
    assert.ok(ratio(t.card, t.err) >= 4.5, `${name} a tab badge`);
    for (let i = 0; i < 8; i++) assert.ok(ratio(t[`l${i}`], t.card) >= 3, `${name} lane colour ${i} as a mark: ${ratio(t[`l${i}`], t.card).toFixed(2)}`);
  }
  // The hero and its buttons are fixed colours.
  for (const [fg, bg] of [['#ffffff', '#111827'], ['#ffffff', '#0b3b36'], ['#dbe4ee', '#15202b'], ['#dbe4ee', '#0b3b36'], ['#fcd34d', '#111827'], ['#1f1500', '#fcd34d'], ['#f1f5f9', '#15202b']]) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  assert.ok(/\.btn \{[^}]*min-height: 44px/.test(css) && /\.x \{[^}]*min-width: 44px; min-height: 44px/.test(css) && /\.cell \{[^}]*min-height: 44px/.test(css), '44px tap targets');
  assert.ok(/\.diff \{[^}]*overflow-x: auto/.test(css) && /\.tbox \{[^}]*overflow-x: auto/.test(css) && /\.cmd pre \{[^}]*overflow-x: auto/.test(css), 'code and tables scroll in their own box');
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
  assert.deepStrictEqual([...new Set(calls)].sort(), ['api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me', 'api/split'], 'the page asks for nothing else - no route takes a diff');
  assert.ok(/api\('POST', 'api\/split', payload\)/.test(js) && /var payload = C\.splitPayload\(tasks, state\.files\)/.test(js), 'the split sends the payload it showed, built from tasks and paths');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js), 'no email address in the page');
  for (const f of ['public/lanes-core.js', 'public/demo.js']) assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} touches no network or storage`);
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/setInterval|setTimeout/.test(server), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js', 'public/lanes-core.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|payload|sent|raw|paths|tasks)/.test(src), `${f} logs a body`);
  }
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod_, env] of [['./lib/store', { LANES_MEMORY: '1' }], ['./lib/fakeai', { LANES_FAKE_AI: '1' }], ['./server', { LANES_FAKE_AI: '1', LANES_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod_)})`], { cwd: ROOT, env: { ...process.env, LANES_MEMORY: '', LANES_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod_} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const prefix = spawnSync(process.execPath, ['-e', 'console.log(require("./lib/store").PREFIX)'], { cwd: ROOT, env: { ...process.env, LANES_COLLECTION_PREFIX: 'lanes_' }, encoding: 'utf8' });
  assert.strictEqual(prefix.stdout.trim(), 'lanes_', 'the lab\u2019s prefix is read, for anything ever stored');
});

/* ---------------- the model payload ---------------- */

test('the split payload is tasks and paths only - no diff content - and past 5,000 paths becomes folder counts', () => {
  const parsed = C.parseInput(D.gather());
  const p = C.splitPayload(D.tasks(), parsed.files);
  assert.deepStrictEqual(Object.keys(p).sort(), ['dirs', 'paths', 'tasks', 'total']);
  assert.strictEqual(p.paths.length, parsed.files.length);
  const s = JSON.stringify(p);
  for (const m of ['@@', 'withSessionTx', 'CREATE TABLE', 'jose', 'agent/auth', 'Claude Code', 'magic-link sign-in', 'diff --git']) assert.ok(!s.includes(m), `${m} would be sent`);
  const big = Array.from({ length: 12000 }, (_, i) => `pkg${i % 40}/src/mod${i % 300}/file${i}.ts`).concat(['package.json', 'pnpm-lock.yaml', 'CLAUDE.md']);
  const q = C.splitPayload(['Do a thing'], big);
  assert.ok(q.paths.length <= C.LIMITS.aiPaths && q.dirs.length > 0 && q.dirs.length <= C.LIMITS.aiDirs);
  assert.ok(q.paths.includes('pnpm-lock.yaml') && q.paths.includes('CLAUDE.md'), 'shared files by name');
  assert.strictEqual(q.total, big.length);
  assert.ok(q.dirs.every((d) => typeof d.dir === 'string' && Number.isInteger(d.files)));
});

test('the proposal is cleaned: patterns must match the tree (or be one new folder inside a real one), names slugged, text stripped', () => {
  const files = D.files();
  const prop = C.cleanProposal({
    lanes: [
      { name: '<b>Billing</b>\u202E', task: '<script>x</script>Do billing', owns: ['src/billing/**', 'src/lib/money.ts', 'lib/nonexistent/deep/**', 'nowhere/**', '../../etc', 5], readOnly: ['src/lib/**', 'made/up.ts'], notes: '<i>n</i>' },
      { name: 'billing', task: 'Second', owns: ['src/components/**'], readOnly: [], notes: '' },
      { name: '', task: '', owns: ['ghost/**'], readOnly: [] },
    ],
    hotspots: [{ path: 'package-lock.json', rule: '<b>Only</b> the lead.' }, { path: 'imaginary.lock', rule: 'x' }, 'junk'],
  }, files);
  assert.deepStrictEqual(prop.lanes.map((l) => l.name), ['billing', 'billing-2']);
  assert.deepStrictEqual(prop.lanes[0].owns, ['src/billing/**', 'src/lib/money.ts']);
  assert.deepStrictEqual(prop.lanes[0].readOnly, ['src/lib/**']);
  assert.strictEqual(prop.lanes[0].task, 'xDo billing');
  assert.deepStrictEqual(prop.hotspots, [{ path: 'package-lock.json', rule: 'Only the lead.' }]);
  assert.deepStrictEqual(prop.dropped.map((d) => d.glob).sort(), ['../../etc', 'ghost/**', 'lib/nonexistent/deep/**', 'made/up.ts', 'nowhere/**']);
  assert.strictEqual(C.cleanProposal({ lanes: [] }, files), null);
  assert.strictEqual(C.cleanProposal('nope', files), null);
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
const demoPayload = () => C.splitPayload(D.tasks(), D.files());
const BIG = { tasks: ['x'], paths: ['p/' + 'x'.repeat(600 * 1024)] };

test('signed out: the page works with zero model calls; the split route answers 401 before reading any body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.ok(meta.lockfiles.includes('package-lock.json') && meta.limits.aiPaths === 5000);
  for (const f of ['lanes-core.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/split', demoPayload())).status, 401);
  assert.strictEqual((await anon('POST', '/api/split', BIG)).status, 401, 'the gate answers before the parser, so not 413');
  for (const p of ['/api/upload', '/api/diff', '/api/check', '/api/gather', '/api/plan']) assert.strictEqual((await anon('POST', p, { diff: 'x' })).status, 404, `${p}: there is no route for a diff`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered route: requireUser, requireBudget, requireDailyCap, THEN its parser; one model client call in the server', () => {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/api/split' && l.route.methods.post);
  assert.deepStrictEqual(layer.route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one metered call, nowhere else');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(src, /express\.json\(\{ limit: '512kb' \}\)/);
});

test('split: input checked before any spend, one metered call, only tasks and paths reach the model, every pattern checked', async () => {
  const ana = await register('ana.lead@example.com');
  const calls = await modelCalls();
  assert.strictEqual((await ana('POST', '/api/split', {})).status, 400);
  assert.strictEqual((await ana('POST', '/api/split', { tasks: [], paths: ['a.ts'] })).status, 400);
  assert.strictEqual((await ana('POST', '/api/split', { tasks: ['x'], paths: [] })).status, 400);
  assert.strictEqual((await ana('POST', '/api/split', BIG)).status, 413, 'over the 512 KB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const sent = demoPayload();
  sent.diff = 'diff --git a/x b/x\n+PRIVATE_CODE_MARKER';
  sent.branches = [{ name: 'agent/secret', hunks: ['+SECRET_TOKEN=abc'] }];
  sent.contents = { 'src/lib/db.ts': 'FILE_CONTENTS_MARKER' };
  sent.paths = sent.paths.concat(['line\nbreak.ts', 'x'.repeat(400), '+  const PASSWORD = 1']);
  sent.dirs = [{ dir: 'src', files: 'many' }, { dir: '../up', files: 3 }];
  const n0 = fakeCalls.length;
  const r = await ana('POST', '/api/split', sent);
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  assert.strictEqual(fakeCalls.length, n0 + 1);
  const req = fakeCalls[fakeCalls.length - 1];
  assert.strictEqual(req.model, 'claude-haiku-4-5', 'a free account runs Haiku');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'propose_lanes' });
  const body = JSON.stringify(req.messages);
  for (const m of ['PRIVATE_CODE_MARKER', 'SECRET_TOKEN', 'FILE_CONTENTS_MARKER', 'agent/secret', 'diff --git', '@@', 'line\\nbreak', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', '../up']) assert.ok(!body.includes(m), `${m} reached the model`);
  assert.ok(body.includes('src/lib/db.ts') && body.includes('Invoices and Stripe billing'), 'the tasks and paths do');
  assert.deepStrictEqual(r.data.sent.tasks, D.tasks());
  assert.strictEqual(r.data.sent.paths, D.files().length + 1, 'the paths kept (a path-shaped "+  const PASSWORD = 1" is just a name and is all the server can see)');
  // every owned pattern fits the tree
  const files = D.files();
  for (const l of r.data.proposal.lanes) for (const g of l.owns.concat(l.readOnly)) assert.ok(C.globCount(g, files).count > 0 || C.isFreshPath(g, C.knownDirs(files)), `${g} does not fit the tree`);
  assert.ok(r.data.proposal.dropped.some((d) => d.glob === 'nowhere/at/all/**'), 'a made-up folder is dropped and reported');
  assert.ok(r.data.proposal.hotspots.some((h) => h.path === 'package-lock.json'));
  // hostile and failing answers
  const withTask = (t) => ({ tasks: [t], paths: D.files() });
  const inj = await ana('POST', '/api/split', withTask('INJECT please'));
  assert.strictEqual(inj.status, 200);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi reaches the page');
  assert.ok(inj.data.proposal.lanes.length <= 12 && !JSON.stringify(inj.data.proposal.lanes).includes('etc/passwd'));
  const blank = await ana('POST', '/api/split', withTask('BLANK'));
  assert.deepStrictEqual([blank.status, /no lanes that fit/.test(blank.data.error)], [422, true]);
  assert.match((await ana('POST', '/api/split', withTask('MAXTOKENS'))).data.error, /ran long/);
  const up = await ana('POST', '/api/split', withTask('UPSTREAM401'));
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await ana('POST', '/api/split', withTask('UPSTREAM529'));
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('an unconfirmed free account gets the verify-email 403 before any model call or big body; out of credit is a 402, not a 413', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/split', demoPayload());
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/lanes/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
    assert.strictEqual((await eve('POST', '/api/split', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/split', demoPayload())).status, 402);
  assert.strictEqual((await cal('POST', '/api/split', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
});

test('nothing is stored server-side: no task, path, proposal or answer - only the shared account and its usage rows', async () => {
  const dump = identityStore._dump();
  for (const m of ['src/lib/db.ts', 'Invoices and Stripe billing', 'propose_lanes', 'package-lock.json', 'PRIVATE_CODE_MARKER', 'billing']) assert.ok(!dump.includes(m), `${m} was stored`);
  const cols = JSON.parse(dump).map(([p]) => p).sort();
  assert.ok(cols.every((c) => ['users', 'usage', 'events', 'control'].some((k) => c.toLowerCase().includes(k.toLowerCase()))), `only account collections: ${cols.join(', ')}`);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/require\('\.\/lib\/store'\)\.store|store\.(set|merge|add|transact)\(/.test(src), 'the server has no app store to write to');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/lanes', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/lanes`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
