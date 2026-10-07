/* Burnrate - the example team. A made-up week for three people, generated
 * deterministically (a seeded random number generator, dated from an anchor
 * day) as Claude Code JSONL lines in the real shape - streamed responses
 * written as several lines sharing one message id, tool calls and their
 * results, subagent files, a compaction - so the example runs through the
 * very same reader and finder as a real folder. Every name, path and
 * command here is invented; nothing came from a real transcript.
 *
 * The week is written to show every finding: a cold cache after a pause,
 * a file read again and again, giant test logs, a session left to bloat,
 * a failing command retried, Opus subagents doing small lookups, and
 * parallel subagents searching the same things - beside sessions that are
 * tidy (compacted, cheap subagents), so not everything is a problem.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BurnDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN = 60000;
  var SEC = 1000;

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var PEOPLE = [
    { name: 'Maya', home: '/home/maya/code', dir: '-home-maya-code-' },
    { name: 'Dev', home: '/Users/dev/src', dir: '-Users-dev-src-' },
    { name: 'Sam', home: '/home/sam', dir: '-home-sam-' },
  ];

  var FILES = {
    'api-refactor': ['src/api/routes.ts', 'src/api/handlers/orders.ts', 'src/api/handlers/users.ts', 'src/db/schema.ts', 'src/db/migrations/0042_orders.sql', 'test/api/orders.test.ts', 'src/lib/validate.ts', 'package.json'],
    'billing-ui': ['src/billing/invoice.tsx', 'src/billing/InvoiceTable.tsx', 'src/billing/totals.ts', 'src/hooks/useInvoices.ts', 'src/billing/invoice.test.tsx', 'package.json', 'src/styles/billing.css'],
    infra: ['terraform/main.tf', 'terraform/variables.tf', 'terraform/modules/db/main.tf', 'scripts/deploy.sh', '.github/workflows/deploy.yml', 'README.md'],
    'deploy-scripts': ['scripts/release.ts', 'scripts/lib/git.ts', 'scripts/lib/semver.ts', 'package.json', 'CHANGELOG.md'],
  };
  var CMDS = {
    'api-refactor': ['npm test -- orders', 'git status', 'git diff --stat', 'npx tsc --noEmit', 'npm run lint'],
    'billing-ui': ['pnpm vitest run src/billing', 'git status', 'pnpm tsc --noEmit', 'git diff'],
    infra: ['terraform fmt -check', 'terraform validate', 'git status', 'tflint'],
    'deploy-scripts': ['npm test', 'git log --oneline -5', 'node scripts/release.ts --dry-run'],
  };

  function hex(r, n) { var s = ''; for (var i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(r() * 16)]; return s; }
  function uuid(r) { return hex(r, 8) + '-' + hex(r, 4) + '-4' + hex(r, 3) + '-a' + hex(r, 3) + '-' + hex(r, 12); }
  function filler(n) {
    var unit = 'example output line for the Burnrate demo. ';
    var s = '';
    while (s.length < n) s += unit;
    return s.slice(0, n);
  }

  /** One transcript thread (a main session, or a subagent) being written. */
  function Thread(gen, o) {
    this.gen = gen; this.r = gen.r;
    this.sid = o.sid; this.agent = o.agent || ''; this.cwd = o.cwd; this.model = o.model;
    this.t = o.start; this.lastT = null;
    this.ctx = 0; this.pending = o.system || 19000 + Math.floor(this.r() * 3000);
    this.lines = [];
    this.project = o.project;
  }
  Thread.prototype.base = function (type) {
    var o = { type: type, sessionId: this.sid, cwd: this.cwd, isSidechain: Boolean(this.agent), timestamp: new Date(this.t).toISOString(), uuid: uuid(this.r), version: '2.1.0' };
    if (this.agent) o.agentId = this.agent;
    return o;
  };
  /** One API response with one tool call and its result. */
  Thread.prototype.turn = function (o) {
    var r = this.r;
    this.t += o.gap !== undefined ? o.gap : (6 + Math.floor(r() * 40)) * SEC;
    var cold = this.lastT === null || this.t - this.lastT > 5 * MIN;
    var write = cold ? this.ctx + this.pending : this.pending;
    var read = cold ? 0 : this.ctx;
    this.ctx += this.pending;
    var out = o.out || 120 + Math.floor(r() * 700);
    var id = 'msg_demo_' + (++this.gen.n).toString(36) + hex(r, 6);
    var usage = {
      input_tokens: 2 + Math.floor(r() * 9), cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: out,
      cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 }, service_tier: 'standard',
    };
    var model = o.model || this.model;
    var msg = function (content, u) { return { model: model, id: id, type: 'message', role: 'assistant', content: content, stop_reason: o.tool ? 'tool_use' : 'end_turn', usage: u }; };
    // The streamed shape: one line per content block, the same id, the usage
    // repeated - the first line sometimes with a smaller output count.
    var early = Object.assign({}, usage, { output_tokens: r() < 0.3 ? Math.floor(out / 3) : out });
    var a1 = this.base('assistant'); a1.message = msg([{ type: 'thinking', thinking: '', signature: 'sig' }], early); a1.requestId = 'req_' + id;
    this.lines.push(JSON.stringify(a1));
    var resChars = 0;
    if (o.tool) {
      var tid = 'toolu_demo_' + this.gen.n.toString(36) + hex(r, 6);
      var a2 = this.base('assistant'); a2.message = msg([{ type: 'tool_use', id: tid, name: o.tool, input: o.input || {} }], usage); a2.requestId = 'req_' + id;
      this.lines.push(JSON.stringify(a2));
      resChars = o.chars !== undefined ? o.chars : 600 + Math.floor(r() * 5000);
      var u = this.base('user');
      var tAt = this.t + (o.runMs || (2 + Math.floor(r() * 10)) * SEC);
      u.timestamp = new Date(tAt).toISOString();
      u.message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: filler(resChars), is_error: Boolean(o.err) }] };
      this.lines.push(JSON.stringify(u));
      this.t = tAt;
    } else {
      var a3 = this.base('assistant'); a3.message = msg([{ type: 'text', text: 'Done - example reply.' }], usage); a3.requestId = 'req_' + id;
      this.lines.push(JSON.stringify(a3));
    }
    // Context grows by what the result added. Ordinary results are drawn
    // small (to keep the example light) with their real-sized growth given
    // as `grow`; the results the findings look at carry their full size.
    this.pending = out + (o.grow !== undefined ? o.grow : Math.ceil(resChars / 4)) + 30;
    this.lastT = this.t;
    return id;
  };
  Thread.prototype.pause = function (min) { this.t += min * MIN; };
  Thread.prototype.compact = function () {
    this.t += 40 * SEC;
    var s = this.base('system'); s.subtype = 'compact_boundary'; s.content = 'Conversation compacted'; s.compactMetadata = { trigger: 'manual', preTokens: this.ctx };
    this.lines.push(JSON.stringify(s));
    this.ctx = 0;
    this.pending = 19000 + 9000 + Math.floor(this.r() * 3000);
    this.lastT = null; // the next turn writes the new, smaller context
  };
  Thread.prototype.prompt = function () {
    var u = this.base('user');
    u.message = { role: 'user', content: 'An example request from the demo.' };
    this.lines.push(JSON.stringify(u));
  };

  /** Ordinary work: reads, edits, a test run, a search. */
  Thread.prototype.work = function (n, opts) {
    opts = opts || {};
    var r = this.r;
    var files = FILES[this.project] || FILES.infra;
    var cmds = CMDS[this.project] || CMDS.infra;
    for (var i = 0; i < n; i++) {
      var x = r();
      var f = files[Math.floor(r() * files.length)];
      var path = this.cwd + '/' + f;
      var size = opts.big ? 4000 + Math.floor(r() * 9000) : undefined;
      if (opts.look) {
        if (x < 0.55) this.turn({ tool: 'Read', input: { file_path: path, offset: 1 + i * 40, limit: 120 }, chars: 900 + Math.floor(r() * 2200), out: 90 + Math.floor(r() * 300) });
        else if (x < 0.85) this.turn({ tool: 'Grep', input: { pattern: ['TODO', 'export function', 'import .* from', 'version'][i % 4], path: this.cwd, output_mode: 'content' }, chars: 700 + Math.floor(r() * 1500), out: 80 + Math.floor(r() * 250) });
        else this.turn({ tool: 'Glob', input: { pattern: '**/*.' + ['ts', 'md', 'json'][i % 3] }, chars: 300, out: 70 + Math.floor(r() * 200) });
        continue;
      }
      var small = 200 + Math.floor(r() * 600);
      var grow = size ? undefined : 200 + Math.floor(r() * 1200);
      if (x < 0.34) this.turn({ tool: 'Read', input: { file_path: path, offset: 1 + i * 37, limit: 200 }, chars: size || small, grow: grow });
      else if (x < 0.6) this.turn({ tool: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' }, chars: 200, grow: 120, out: 300 + Math.floor(r() * 900) });
      else if (x < 0.82) this.turn({ tool: 'Bash', input: { command: cmds[Math.floor(r() * cmds.length)] }, chars: size || small, grow: grow });
      else if (x < 0.94) this.turn({ tool: 'Grep', input: { pattern: 'export ' + ['function', 'const', 'type'][i % 3], path: this.cwd + '/src' }, chars: size || small, grow: grow });
      else this.turn({ out: 200 + Math.floor(r() * 600) });
    }
  };
  /** The same whole file, read again without editing it. */
  Thread.prototype.reread = function (file, times, between) {
    for (var i = 0; i < times; i++) {
      this.turn({ tool: 'Read', input: { file_path: this.cwd + '/' + file }, chars: 26000 + Math.floor(this.r() * 4000) });
      if (between) this.work(between, { look: true }); // looking around, not editing it
    }
  };

  function generate(anchorDay) {
    var day0 = Date.parse(String(anchorDay || '2026-10-06') + 'T00:00:00Z');
    if (!isFinite(day0)) day0 = Date.parse('2026-10-06T00:00:00Z');
    var g = { r: rng(0xb0a7), n: 0 };
    var files = [];
    function at(dayOffset, h, m) { return day0 + dayOffset * 86400000 + (h * 60 + (m || 0)) * MIN; }
    function session(pi, project, model, start, fn, opts) {
      var p = PEOPLE[pi];
      var sid = uuid(g.r);
      var th = new Thread(g, { sid: sid, cwd: p.home + '/' + project, model: model, start: start, project: project });
      th.prompt();
      fn(th, function (agents) {
        // Spawn subagents from the main thread: one Agent call, then each
        // subagent writes its own file under <session>/subagents/.
        var startAt = th.t + 5 * SEC;
        var call = th.turn({ tool: 'Agent', input: { description: 'Explore in parallel', subagent_type: 'general-purpose', prompt: 'example' }, chars: 3000, runMs: 4 * MIN, out: 400 });
        agents.forEach(function (a, i) {
          var sub = new Thread(g, { sid: sid, agent: 'a' + hex(g.r, 16), cwd: th.cwd, model: a.model, start: startAt + i * 3 * SEC, project: project, system: 9000 });
          sub.prompt();
          a.fn(sub);
          files.push({ person: pi, path: p.dir + project + '/' + sid + '/subagents/agent-' + sub.agent + '.jsonl', lines: sub.lines });
        });
        return call;
      });
      files.push({ person: pi, path: p.dir + project + '/' + sid + '.jsonl', lines: th.lines });
      return th;
    }
    var OPUS = 'claude-opus-5-5';
    var SONNET = 'claude-sonnet-5-5';
    var HAIKU = 'claude-haiku-4-5-20251001';

    // A tidy session: compacted every ~80 turns, before it gets heavy.
    function day(t, n) { var left = Math.round(n * 1.8); while (left > 0) { var k = Math.min(80, left); t.work(k); left -= k; if (left > 0) t.compact(); } }

    // ---- Maya: api-refactor on Opus 5.5 - the long-session habits ----
    session(0, 'api-refactor', OPUS, at(-6, 13, 10), function (t) {
      t.work(110); t.pause(7); t.work(40);
      t.reread('src/api/routes.ts', 6, 5); t.work(40);
    });
    session(0, 'api-refactor', OPUS, at(-6, 18, 30), function (t) { day(t, 120); });
    session(0, 'api-refactor', OPUS, at(-5, 12, 40), function (t) {
      t.work(300, { big: true }); // never compacted: context bloat
    });
    session(0, 'api-refactor', OPUS, at(-4, 13, 15), function (t, spawn) {
      day(t, 100);
      var review = function (sub) { sub.work(20, { look: true }); sub.work(40, { big: true }); sub.turn({ out: 1200 }); };
      spawn([{ model: SONNET, fn: review }, { model: SONNET, fn: review }]);
      t.pause(8); t.work(60);
    });
    session(0, 'api-refactor', OPUS, at(-3, 14, 5), function (t) { day(t, 150); });
    session(0, 'api-refactor', OPUS, at(-2, 13, 0), function (t) { t.work(160); t.reread('src/db/schema.ts', 4, 8); t.work(40); });
    session(0, 'api-refactor', OPUS, at(-1, 13, 30), function (t) {
      t.work(120, { big: true }); t.pause(12); t.work(60); t.pause(18); t.work(50);
    });
    session(0, 'api-refactor', OPUS, at(0, 15, 0), function (t) { day(t, 110); });

    // ---- Dev: billing-ui on Opus 5.5, with subagents and test logs ----
    session(1, 'billing-ui', OPUS, at(-6, 15, 20), function (t, spawn) {
      t.work(60);
      var brief = function (sub) {
        var c = sub.cwd;
        sub.turn({ tool: 'Grep', input: { pattern: 'invoiceTotal', path: c + '/src' }, chars: 6000, out: 180 });
        sub.turn({ tool: 'Read', input: { file_path: c + '/package.json' }, chars: 5200, out: 120 });
        sub.turn({ tool: 'Read', input: { file_path: c + '/src/billing/invoice.tsx' }, chars: 24000, out: 210 });
        sub.turn({ tool: 'Glob', input: { pattern: '**/*.test.tsx' }, chars: 2200, out: 90 });
        sub.turn({ tool: 'Read', input: { file_path: c + '/src/billing/totals.ts' }, chars: 14000, out: 160 });
        sub.turn({ tool: 'Grep', input: { pattern: 'formatCurrency', path: c + '/src' }, chars: 4800, out: 140 });
        sub.work(26, { look: true }); sub.work(30, { big: true });
        sub.turn({ out: 900 });
      };
      spawn([{ model: OPUS, fn: brief }, { model: OPUS, fn: brief }, { model: OPUS, fn: brief }]);
      t.work(50);
      t.turn({ tool: 'Bash', input: { command: 'pnpm vitest run --reporter=verbose' }, chars: 190000, out: 260 });
      t.work(60);
      t.turn({ tool: 'Bash', input: { command: 'cat pnpm-lock.yaml' }, chars: 150000, out: 140 });
      t.work(60);
    });
    session(1, 'billing-ui', OPUS, at(-5, 14, 0), function (t) { day(t, 130); });
    session(1, 'billing-ui', OPUS, at(-4, 13, 0), function (t) {
      t.work(80); t.reread('src/billing/InvoiceTable.tsx', 5, 6);
      t.turn({ tool: 'Bash', input: { command: 'pnpm vitest run --reporter=verbose' }, chars: 175000, out: 240 });
      t.work(50); t.compact(); t.work(60);
    });
    session(1, 'billing-ui', OPUS, at(-3, 15, 30), function (t, spawn) {
      t.work(70);
      var brief = function (sub) {
        var c = sub.cwd;
        sub.turn({ tool: 'Grep', input: { pattern: 'useInvoices', path: c + '/src' }, chars: 5000, out: 150 });
        sub.turn({ tool: 'Read', input: { file_path: c + '/src/hooks/useInvoices.ts' }, chars: 12000, out: 170 });
        sub.work(24, { look: true }); sub.work(30, { big: true });
        sub.turn({ out: 800 });
      };
      spawn([{ model: OPUS, fn: brief }, { model: OPUS, fn: brief }]);
      t.work(30); t.compact(); t.work(60);
    });
    session(1, 'billing-ui', OPUS, at(-2, 14, 30), function (t, spawn) {
      t.work(70);
      var explore = function (sub) { sub.work(40, { look: true }); sub.work(20, { big: true }); sub.turn({ out: 700 }); };
      spawn([{ model: HAIKU, fn: explore }, { model: HAIKU, fn: explore }]); // cheap explorers: the right shape
      t.work(20); t.compact(); t.work(70);
    });
    session(1, 'billing-ui', OPUS, at(-1, 12, 50), function (t) { day(t, 120); t.turn({ tool: 'Bash', input: { command: 'pnpm vitest run --reporter=verbose' }, chars: 168000, out: 230 }); t.work(50); });
    session(1, 'billing-ui', OPUS, at(0, 13, 45), function (t) { t.work(70); t.pause(9); t.work(30); t.compact(); t.work(50); });

    // ---- Sam: infra on Sonnet 5.5, a release script on Opus ----
    session(2, 'infra', SONNET, at(-6, 14, 0), function (t) { day(t, 120); });
    session(2, 'infra', SONNET, at(-5, 16, 0), function (t) {
      t.work(50);
      for (var i = 0; i < 6; i++) t.turn({ tool: 'Bash', input: { command: 'terraform plan -out=tfplan -var-file=staging.tfvars' }, chars: 3800, err: true, out: 260 });
      t.work(80);
    });
    session(2, 'infra', SONNET, at(-4, 15, 10), function (t) { t.work(80); t.pause(25); t.work(40); t.compact(); t.work(70); });
    session(2, 'infra', SONNET, at(-3, 13, 40), function (t) { day(t, 130); });
    session(2, 'infra', SONNET, at(-2, 13, 20), function (t) { day(t, 110); });
    session(2, 'deploy-scripts', OPUS, at(-1, 16, 40), function (t) {
      t.work(40, { look: true }); t.work(14); t.work(36, { look: true });
      for (var i = 0; i < 5; i++) t.turn({ tool: 'Bash', input: { command: 'npm run lint -- --max-warnings=0' }, chars: 2600, err: true, out: 300 });
      t.work(30);
    });
    session(2, 'infra', SONNET, at(0, 14, 15), function (t) { day(t, 70); });

    var people = PEOPLE.map(function (p, i) {
      return { name: p.name, files: files.filter(function (f) { return f.person === i; }).map(function (f) { return { path: f.path, lines: f.lines }; }) };
    });
    return { anchor: new Date(day0).toISOString().slice(0, 10), people: people };
  }

  /** Feed the example straight into a collector. */
  function feed(collector, anchorDay) {
    var d = generate(anchorDay);
    var bytes = 0;
    d.people.forEach(function (p) {
      var who = collector.person(p.name);
      p.files.forEach(function (f) {
        var fh = collector.file('~/.claude/projects/' + f.path, who);
        f.lines.forEach(function (l) { bytes += l.length + 1; fh.line(l); });
        fh.bytes(f.lines.reduce(function (s, l) { return s + l.length + 1; }, 0));
      });
    });
    return { anchor: d.anchor, bytes: bytes };
  }

  return { generate: generate, feed: feed, PEOPLE: PEOPLE.map(function (p) { return p.name; }) };
}));
