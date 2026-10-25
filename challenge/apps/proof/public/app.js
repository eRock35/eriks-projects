/* Proof - the page. One file, no build step.
 *
 * A RUN IS READ HERE AND NOWHERE ELSE. A dropped transcript or pasted
 * terminal output is read in this browser, in a Web Worker
 * (parse-worker.js); the claims, the receipts, the patterns, the score and
 * the report are ProofCore's, worked out on the device; nothing about the run
 * is sent. The only request that carries any of it is "Second opinion on the
 * outcome", which sends ProofCore.opinionPayload - shown in full, with a
 * warning and a confirmation box, before anything leaves.
 *
 * Every string that came from the run (a command, a path, an output line, a
 * message) or from the server is escaped before it is drawn, and no handler
 * is written into markup: clicks are routed by data-act attributes from one
 * listener (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.ProofCore;
  var D = window.ProofDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc;
  var plural = C.plural;
  var VW = C.VERDICT_WORD, VI = C.VERDICT_ICON;
  var K_DRAFT = 'proof-criteria-v1';

  var state = {
    me: null,
    view: 'start',        // start | reading | report
    run: null,            // ProofCore.parseRun(...) - in this tab only
    A: null,              // ProofCore.analyze(...)
    goal: '', criteria: '',
    demo: null,           // 'confident' | 'honest' | null
    open: {},             // claim / criterion id -> expanded
    steps: {},            // step number -> expanded
    filter: 'all',        // all | changes | checks | commands | errors | messages
    shown: 120,           // timeline rows drawn
    editing: false,
    opinion: null,        // the second opinion (this tab only)
    showPaste: false,
    phase: '',
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.error) { var e = new Error(data.error || 'Something went wrong.'); e.status = res.status; e.data = data; throw e; }
        return data;
      });
    });
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  var toastTimer = null;
  function toast(msg, ms) {
    $$('.toast').forEach(function (t) { t.remove(); });
    clearTimeout(toastTimer);
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, ms || 2600);
  }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function download(name, type, text) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  /** Escaped, with `code` in a sentence drawn as code. */
  function rich(s) { return esc(s).replace(/`([^`]{1,300})`/g, '<code>$1</code>'); }
  function vpill(v, word) { return '<span class="vp vp-' + esc(v) + '"><span aria-hidden="true">' + (VI[v] || (v === 'no-evidence' ? '?' : '•')) + '</span>' + esc(word || VW[v] || v) + '</span>'; }
  function sevPill(s) { return '<span class="sev sev-' + esc(s) + '"><span aria-hidden="true">' + (s === 'high' ? '▲' : s === 'medium' ? '◆' : '●') + '</span>' + (s === 'high' ? 'High' : s === 'medium' ? 'Medium' : 'Low') + '</span>'; }
  function stepBtn(n) { return '<button class="sref" type="button" data-act="gostep" data-n="' + Number(n) + '">Step ' + Number(n) + '</button>'; }
  function stepsText(refs) { return refs && refs.length ? (refs.length === 1 ? 'step ' : 'steps ') + refs.join(', ') : ''; }
  function refsOf(c) { var r = []; (c.evidence || []).forEach(function (e) { if (r.indexOf(e.n) === -1) r.push(e.n); }); return r; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. The report stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function meteredError(err, box, retry) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount('A second opinion uses a cent or two of AI credit, so it needs a free account (it comes with $2).', retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }

  /* ---------------- routing ---------------- */

  function go(where) {
    if (where === 'report' && state.run) state.view = 'report';
    else state.view = 'start';
    history.pushState(null, '', BASE + '#' + where);
    draw(); scrollTo(0, 0);
  }
  function route() {
    var h = (location.hash || '').replace(/^#/, '');
    if (h === 'confident' || h === 'honest') return runDemo(h);
    if (h === 'report' && state.run) { state.view = 'report'; return draw(); }
    state.view = 'start'; draw();
  }
  window.addEventListener('popstate', route);

  function draw() {
    closeSheet(true);
    var main = $('#main');
    if (state.view === 'reading') { main.innerHTML = readingHtml(); return; }
    if (state.view === 'report' && state.run && state.A) { main.innerHTML = reportHtml(); return; }
    main.innerHTML = startHtml(); wireStart();
  }

  /* ---------------- first run ---------------- */

  function startHtml() {
    var html = '<section class="hero">' +
      '<div class="receipt" aria-hidden="true"><b>Claims vs receipts</b>' +
        '“All 40 tests pass”<br><span class="r-none">? No evidence</span><br>' +
        '“No lint errors”<br><span class="r-bad">✗ Contradicted</span><br>' +
        '“Committed to fix/rounding”<br><span class="r-ok">✓ Backed</span></div>' +
      '<p class="kicker"><span aria-hidden="true">🕵️</span> Claims, checked against receipts</p>' +
      '<h1>Did the agent actually do it?</h1>' +
      '<p>Your agent says “Done! All tests pass.” Proof reads the run itself - every command, its output and exit code, every file it touched - and checks each claim in that summary against those receipts.</p>' +
      '<div class="btns"><button class="btn primary big" type="button" data-act="demo" data-id="confident">See a confident one</button><button class="btn ghost big" type="button" data-act="pickfile">Check your own run</button></div>' +
      '<div class="trust"><span class="ico" aria-hidden="true">🔒</span><div><b>Nothing leaves your device for the check.</b> The run is read here, in your browser. The optional AI second opinion sends only the snippets you see and confirm - never the whole run.</div></div></section>';

    html += '<section class="card" style="margin-top:14px"><p class="lab">Try a made-up run, one tap each</p><div class="demos">' +
      '<button class="demo d-bad" type="button" data-act="demo" data-id="confident"><span class="tag">Made-up example</span><b>✗ The confident one</b><span>Says all 40 tests pass and the bug is fixed. See what it actually did.</span></button>' +
      '<button class="demo d-good" type="button" data-act="demo" data-id="honest"><span class="tag">Made-up example</span><b>✓ The honest one</b><span>Every claim has a receipt - and it says what it didn’t do.</span></button>' +
      '</div></section>';

    html += '<section class="card" style="margin-top:14px"><div class="drop" id="drop" role="button" tabindex="0" aria-label="Drop a run, or choose a file">' +
      '<span class="ico" aria-hidden="true">📥</span><h2>Drop a run</h2>' +
      '<p class="muted" style="margin:0">…or tap to choose a file. It is read on your device.</p>' +
      '<div class="kinds"><code>.jsonl</code><code>.json</code><code>.txt</code><code>.log</code></div>' +
      '<div class="btns" style="justify-content:center"><label class="btn small ghost filepick">Choose a file<input type="file" id="pickFile" accept=".jsonl,.json,.txt,.log,.md,application/json,text/plain"></label>' +
      '<button class="btn small ghost" type="button" data-act="togglepaste" aria-expanded="' + state.showPaste + '">Paste output instead</button></div></div>' +
      (state.showPaste ? '<div class="paste"><label class="field"><span>Terminal output or log</span><textarea class="input code" id="pasteLog" rows="8" placeholder="$ npm test&#10;Tests: 40 passed, 40 total&#10;…"></textarea></label>' +
        '<label class="field"><span>The agent’s final message <span class="muted small">(leave empty if it is at the end of the output)</span></span><textarea class="input" id="pasteSummary" rows="4" placeholder="Done! All tests pass and I opened PR #12."></textarea></label>' +
        '<div class="btns"><button class="btn" type="button" data-act="checkpaste">Check it</button></div></div>' : '') +
      '<details class="why" style="margin-top:10px"><summary>Where do I find a run?</summary><ul class="notes small">' +
        '<li><b>Claude Code</b>: <code>~/.claude/projects/&lt;project&gt;/&lt;session&gt;.jsonl</code> - the newest file is the latest session.</li>' +
        '<li><b>Codex CLI</b>: <code>~/.codex/sessions/…/rollout-*.jsonl</code>.</li>' +
        '<li><b>Your own agent</b>: its messages as JSON (Anthropic or OpenAI shape, tool calls included), or one JSON object per line per tool call - <code>{"tool", "input", "output", "exit_code"}</code>.</li>' +
        '<li><b>Anything else</b>: paste the terminal output with its <code>$</code> prompts, and the agent’s final message.</li></ul></details></section>';

    html += '<div class="grid3 how" style="margin-top:14px">' +
      ['📥::Drop the run::A Claude Code or Codex transcript, a messages export, a tool log, or pasted terminal text. Read in your browser, in a worker - never uploaded.',
       '🧾::Claims vs receipts::Every claim in the summary - tests pass, bug fixed, 3 files changed, PR opened - matched to the steps that back it or contradict it, line by line.',
       '✅::What to check::A trust score with its reasons and the three things to look at before you merge. Copy it into the PR as a comment.'].map(function (s, i) {
        var p = s.split('::');
        return '<div class="card"><div class="n" aria-hidden="true">' + (i + 1) + '</div><h2><span aria-hidden="true">' + p[0] + '</span> ' + esc(p[1]) + '</h2><p>' + esc(p[2]) + '</p></div>';
      }).join('') + '</div>';

    html += '<section class="card" style="margin-top:14px"><p class="lab">What it catches</p><ul class="chips">' +
      ['🧪 Tests never re-run after the last edit', '⏭️ A failing test skipped, focused or deleted', '🫥 Errors swallowed: || true, an empty catch', '📁 Files changed outside the scope', '🔢 “40 tests” when 12 ran', '🎭 Mocking the thing under test', '🎯 A hard-coded expected value', '🔗 A PR or deploy that never happened'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>';

    html += '<div class="privacy-line"><span aria-hidden="true">👀</span><div><b>Rules, not a judge.</b> Proof reads what the run recorded. It can say a claim has no receipt, or that the receipt says otherwise; it cannot say the code is right. Read the diff too.</div></div>';
    html += footer();
    return html;
  }
  function wireStart() {
    var drop = $('#drop');
    if (drop) {
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
      drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(f); });
      drop.addEventListener('click', function (e) { if (e.target === drop || (e.target.closest && e.target.closest('.ico, h2')) ) $('#pickFile').click(); });
      drop.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target === drop) { e.preventDefault(); $('#pickFile').click(); } });
    }
    var pf = $('#pickFile'); if (pf) pf.addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) readFile(f); e.target.value = ''; });
  }

  /* ---------------- reading ---------------- */

  function readFile(file) {
    if (file.size > C.LIMITS.inputBytes) { toast('That file is over ' + C.fmtBytes(C.LIMITS.inputBytes) + '. Drop one session’s transcript.', 4600); return; }
    state.demo = null;
    startReading(file.name);
    file.arrayBuffer().then(function (buf) { post({ op: 'file', name: file.name, bytes: buf }, [buf]); }, function () { readError('That file could not be opened.'); });
  }
  function runDemo(which) {
    var d = which === 'honest' ? D.honest() : D.confident();
    state.demo = d.id;
    state.criteria = d.criteria;
    startReading(d.name);
    post({ op: 'text', name: d.name, text: d.text });
  }

  var worker = null, reqId = 0, curReq = 0;
  function startWorker() {
    try {
      worker = new Worker('parse-worker.js');
      worker.onmessage = onWorker;
      worker.onerror = function () { readError('The reader stopped unexpectedly. Try a smaller file.'); };
    } catch (e) { worker = null; }
  }
  function post(msg, transfer) {
    if (!worker) startWorker();
    curReq = ++reqId; msg.id = curReq;
    if (!worker) { readInMain(msg); return; }
    try { worker.postMessage(msg, transfer || []); } catch (e) { readInMain(msg); }
  }
  function onWorker(ev) {
    var m = ev.data || {};
    if (m.id && m.id !== curReq) return;
    if (m.op === 'progress') { var p = $('#readPhase'); if (p) p.textContent = m.phase === 'parse' ? 'Matching claims to receipts…' : 'Reading…'; return; }
    if (m.op === 'run') { onRun(m.run); return; }
    if (m.op === 'error') { readError(m.message); return; }
  }
  // If the worker cannot start (rare), pasted text and the demos still read on the main thread.
  function readInMain(msg) {
    try {
      if (msg.op === 'text') { var run = C.parseRun(msg.text, { name: msg.name, summary: msg.summary }); if (run.error) readError(run.error); else onRun(run); return; }
      readError('This browser could not start the reader. Paste the output instead.');
    } catch (e) { readError(String(e && e.message || e)); }
  }
  function startReading(name) { state.view = 'reading'; state.phase = name || ''; draw(); scrollTo(0, 0); }
  function readingHtml() {
    return '<section class="card reading" aria-live="polite"><div class="spin" aria-hidden="true"></div>' +
      '<h2 style="margin:0">' + (state.phase ? esc(state.phase) : 'Reading the run') + '</h2>' +
      '<p class="muted" id="readPhase" style="margin:0">Reading…</p><p class="small muted" style="margin:0">On your device. Nothing is uploaded.</p></section>';
  }
  function readError(msg) {
    state.view = 'start';
    $('#main').innerHTML = '<section class="card"><p class="err" role="alert">' + esc(msg || 'That could not be read.') + '</p><button class="btn ghost" type="button" data-act="home">Back</button></section>' + startHtml();
    wireStart();
  }
  function onRun(run) {
    state.run = run;
    state.goal = run.goal || '';
    if (!state.demo) { var d = recall(K_DRAFT); state.criteria = d && typeof d.text === 'string' ? d.text : ''; }
    state.open = {}; state.steps = {}; state.filter = 'all'; state.shown = 120; state.opinion = null; state.editing = false;
    analyze();
    state.view = 'report';
    history.replaceState(null, '', BASE + '#report');
    draw(); scrollTo(0, 0);
  }
  function analyze() { state.A = C.analyze(state.run, { goal: state.goal, criteria: state.criteria }); }

  /* ---------------- the report ---------------- */

  function reportHtml() {
    var A = state.A, r = state.run;
    var html = verdictHtml(A, r);
    // A phone reads it top to bottom: what to check, the claims, the criteria,
    // the patterns. Above 1100px the claims sit under what to check on the
    // left, and the goal, criteria and patterns beside them.
    html += '<div class="dk-split dk-split-aside" style="margin-top:14px"><div class="stack">' + checkHtml(A) + claimsHtml(A, r) + errorsHtml(A) + saidHtml(A) + '</div>' +
      '<div class="stack">' + goalHtml(A) + patternsHtml(A) + '</div></div>';
    html += '<div class="stack" style="margin-top:14px">' + timelineHtml(r) + readHtml(r) + '</div>';
    html += '<div class="btns" style="margin-top:14px;justify-content:center"><button class="btn ghost" type="button" data-act="home">Check another run</button></div>';
    html += footer();
    return html;
  }
  function verdictHtml(A, r) {
    var v = A.verdict;
    var icon = v.band === 'good' ? '✓' : v.band === 'check' ? '◆' : '✗';
    var changed = A.changed.length;
    var meta = [r.name || 'Your run', r.formatWord, plural(r.steps.length, 'step'), plural(changed, 'file') + ' changed'];
    if (r.stats && r.stats.ms) meta.push(C.fmtMs(r.stats.ms));
    var total = v.total || 1;
    var mix = v.total ? '<div class="mix" aria-hidden="true">' + C.VERDICTS.map(function (k) { return v.counts[k] ? '<span class="m-' + k + '" style="width:' + (100 * v.counts[k] / total).toFixed(1) + '%"></span>' : ''; }).join('') + '</div>' : '';
    var tally = v.total ? '<ul class="tally" aria-label="Claims by verdict">' + C.VERDICTS.filter(function (k) { return v.counts[k]; }).map(function (k) { return '<li>' + vpill(k, v.counts[k] + ' ' + VW[k]) + '</li>'; }).join('') + '</ul>' : '';
    var h = '<section class="card verdict b-' + esc(v.band) + '" id="verdict"><div class="vtop">' +
      '<div class="ring" style="--p:' + Number(v.score) + '" role="img" aria-label="Trust score ' + Number(v.score) + ' out of 100"><span><span><b>' + Number(v.score) + '</b><small>of 100</small></span></span></div>' +
      '<span class="vbadge"><span aria-hidden="true">' + icon + '</span>' + esc(v.bandWord) + '</span>' +
      '<h1>' + esc(v.outcome).replace(/ - /, '\u00a0- ') + '</h1>' +
      '<p class="meta">' + meta.map(esc).join(' · ') + '</p></div>' + mix + tally +
      (v.reasons.length ? '<details class="why"><summary>Why ' + Number(v.score) + '?</summary><ul class="reasons">' + v.reasons.map(function (x) {
        return '<li><span class="pts">−' + Number(x.pts) + '</span><span>' + esc(x.text) + (x.refs && x.refs.length ? ' <span class="muted small">(' + esc(stepsText(x.refs)) + ')</span>' : '') + '</span></li>';
      }).join('') + '</ul><p class="small muted" style="margin:8px 0 0">The score starts at 100, and each reason takes its share of what is left. ' + esc(v.bandSub) + '</p></details>' : '<p class="small muted" style="margin:0">' + esc(v.bandSub) + '</p>') +
      '<div class="btns">' +
        '<button class="btn ai small" type="button" data-act="opinion"><span aria-hidden="true">✨</span> Second opinion from AI</button>' +
        '<button class="btn ghost small" type="button" data-act="copymd">Copy as PR comment</button>' +
        '<button class="btn ghost small" type="button" data-act="exports">More exports</button></div>';
    var jump = [['claims', 'Claims', A.claims.length], ['goal', 'Criteria', A.criteria.length], ['patterns', 'Patterns', A.findings.length], ['timeline', 'Timeline', r.steps.length]];
    h += '<ul class="jump" aria-label="Jump to">' + jump.map(function (j) { return '<li><a href="#' + j[0] + '" data-act="jump" data-to="' + j[0] + '">' + esc(j[1]) + ' <span class="num">' + j[2] + '</span></a></li>'; }).join('') + '</ul>';
    return h + '</section>';
  }
  function checkHtml(A) {
    var list = A.verdict.checks;
    return '<section class="card" id="tocheck"><div class="sec-head"><h2><span aria-hidden="true">🔍</span> What to check before merging</h2></div>' +
      (list.length ? '<ol class="tocheck">' + list.map(function (c) {
        return '<li><div><b>' + rich(c.title) + '</b><p>' + rich(c.detail) + '</p>' + (c.refs && c.refs.length ? '<div class="row" style="margin-top:6px">' + c.refs.map(stepBtn).join('') + '</div>' : '') + '</div></li>';
      }).join('') + '</ol>' : '<p class="muted" style="margin:0">Nothing stands out. Read the diff anyway.</p>') + '</section>';
  }
  function goalHtml(A) {
    var h = '<section class="card" id="goal"><div class="sec-head"><h2><span aria-hidden="true">🎯</span> The goal and what “done” means</h2>' + (state.editing ? '' : '<button class="btn small ghost" type="button" data-act="editgoal">Edit</button>') + '</div>';
    if (state.editing) {
      h += '<div class="stack"><label class="field"><span>The intended outcome</span><textarea class="input" id="goalBox" rows="3" placeholder="Fix the rounding bug in invoice totals.">' + esc(state.goal) + '</textarea></label>' +
        '<label class="field"><span>Acceptance criteria, one per line</span><textarea class="input" id="critBox" rows="5" placeholder="unit tests pass&#10;no changes outside src/billing&#10;PR opened">' + esc(state.criteria) + '</textarea></label>' +
        suggHtml() + '<div class="btns"><button class="btn" type="button" data-act="savegoal">Check again</button><button class="btn ghost" type="button" data-act="canceledit">Cancel</button></div></div>';
      return h + '</section>';
    }
    h += A.goal ? '<p class="lab">Goal' + (state.run && state.goal === state.run.goal && state.goal ? ' <span class="small" style="text-transform:none;letter-spacing:0;font-weight:600">- from the run’s first message</span>' : '') + '</p><p class="goal-text">' + rich(A.goal) + '</p>' : '<p class="muted">No goal yet: the run has no first message from a person. Add one with Edit.</p>';
    h += '<p class="lab" style="margin-top:14px">Acceptance criteria</p>';
    if (!A.criteria.length) h += '<p class="muted small" style="margin:0 0 8px">None yet. Tap one to add it, or write your own with Edit - Proof checks each against the run.</p>' + suggHtml();
    else h += '<ul class="clist">' + A.criteria.map(function (c) { return itemHtml(c, true); }).join('') + '</ul>';
    if (state.opinion) h += opinionHtml(state.opinion);
    return h + '</section>';
  }
  function suggHtml() {
    var have = state.criteria.toLowerCase();
    var top = (state.A ? state.A.changed : []).map(function (p) { return p.path.split('/')[0]; }).filter(function (x) { return x && x.indexOf('.') === -1; });
    var common = top.length && top.every(function (x) { return x === top[0]; }) ? top[0] + '/' : null;
    var list = ['unit tests pass', 'lint is clean', 'no type errors', 'no skipped tests', common ? 'no changes outside ' + common : null, 'PR opened', 'migration applied'].filter(function (x) { return x && have.indexOf(x) === -1; });
    return '<ul class="sugg" aria-label="Add a criterion">' + list.map(function (s) { return '<li><button type="button" data-act="addcrit" data-text="' + esc(s) + '">+ ' + esc(s) + '</button></li>'; }).join('') + '</ul>';
  }
  function itemHtml(c, isCrit) {
    var open = state.open[c.id];
    var v = c.manual ? 'manual' : c.verdict;
    var refs = refsOf(c);
    var h = '<li class="citem e-' + esc(v) + '" id="it-' + esc(c.id) + '"><button class="copen" type="button" data-act="openitem" data-id="' + esc(c.id) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="cq">' + (isCrit ? esc(c.text) : '“' + rich(c.quote) + '”') + '</span>' + vpill(v, c.manual ? 'Check by hand' : null) +
      '<span class="cwhy">' + rich(c.why) + '</span>' +
      '<span class="cmeta"><span>' + esc(c.kindWord) + '</span>' + (c.hedged ? '<span class="hedge">hedged</span>' : '') + (refs.length ? '<span>Receipts: ' + esc(stepsText(refs)) + '</span>' : '') + '<span class="chev" aria-hidden="true">' + (open ? '▾' : '▸') + '</span></span></button>';
    if (open) {
      h += '<div class="cbody">' + (!isCrit && c.text.replace(/[.!\s]+$/, '') !== c.quote.replace(/[.!\s]+$/, '') ? '<p class="said">' + rich(c.text) + '</p>' : '') +
        (c.evidence.length ? c.evidence.map(evHtml).join('') : '<p class="small muted" style="margin:0">' + (c.verdict === 'none' ? 'No step in the run speaks to this - that is the finding.' : 'No single step to point at.') + '</p>') + '</div>';
    }
    return h + '</li>';
  }
  var TONE_WORD = { 'for': 'backs it', against: 'against it', info: 'context' };
  function evHtml(e) {
    return '<div class="ev t-' + esc(e.tone) + '"><div class="evh">' + stepBtn(e.n) + '<span>' + esc(TONE_WORD[e.tone] || '') + '</span></div><pre>' + e.lines.map(esc).join('\n') + '</pre></div>';
  }
  function claimsHtml(A, r) {
    var finalN = r.final.length ? r.final[r.final.length - 1] : null;
    var lead = A.claims.length
      ? 'Read from the agent’s final message' + (finalN ? ' (' + stepsText(r.final) + ')' : '') + ': ' + plural(A.sentences, 'sentence') + ', ' + plural(A.claims.length, 'claim') + ' Proof can check. Tap one for its receipts.'
      : (r.finalText ? 'The final message makes no claim Proof knows how to check (tests, fixes, files, lint, types, builds, commits, pushes, PRs, deploys, migrations, coverage).' : 'The run has no final message from the agent, so there is nothing to check its claims against.');
    var h = '<section class="card" id="claims"><div class="sec-head"><h2><span aria-hidden="true">🧾</span> Claims vs receipts</h2></div><p class="small muted">' + esc(lead) + '</p>';
    if (A.claims.length) h += '<ul class="clist">' + A.claims.map(function (c) { return itemHtml(c, false); }).join('') + '</ul>';
    return h + '</section>';
  }
  function patternsHtml(A) {
    var h = '<section class="card" id="patterns"><div class="sec-head"><h2><span aria-hidden="true">🚩</span> Patterns worth a look</h2><span class="small muted">' + plural(A.findings.length, 'found', 'found') + '</span></div>';
    if (!A.findings.length) return h + '<p class="muted" style="margin:0">Nothing the run added skips, weakens or hides a test, swallows an error, or skips a hook. Only what the run changed is read - patterns already in the code are not counted.</p></section>';
    h += '<p class="small muted">Only what this run added counts. A pattern that was already in the code is not listed.</p><ul class="plist">' + A.findings.map(function (f) {
      return '<li class="pitem s-' + esc(f.sev) + '"><div class="ph">' + sevPill(f.sev) + '<span class="pt">' + rich(f.title) + '</span></div>' +
        (f.lines.length ? '<pre>' + f.lines.map(esc).join('\n') + '</pre>' : '') +
        '<p>' + rich(f.why) + '</p><p class="fix">' + rich(f.fix) + '</p><div class="row">' + stepBtn(f.n) + (f.path ? '<code>' + esc(f.path) + '</code>' : '') + '</div></li>';
    }).join('') + '</ul></section>';
    return h;
  }
  function errorsHtml(A) {
    if (!A.errors.length) return '';
    return '<section class="card" id="errors"><div class="sec-head"><h2><span aria-hidden="true">⚠️</span> Errors it kept going after</h2></div><p class="small muted">Each of these failed, and nothing later in the run fixed or re-ran it. A failed search or file read is looking around, and is not listed.</p><ul class="plist">' +
      A.errors.map(function (e) { return '<li class="pitem s-' + esc(e.sev) + '"><div class="ph">' + stepBtn(e.n) + '<span class="pt mono">' + esc(e.label) + '</span></div>' + (e.line ? '<pre>' + esc(e.line) + '</pre>' : '') + '</li>'; }).join('') + '</ul></section>';
  }
  function saidHtml(A) {
    if (!A.admissions.length) return '';
    return '<section class="card" id="said"><div class="sec-head"><h2><span aria-hidden="true">🗣️</span> What it says it didn’t do</h2></div><p class="small muted">Said plainly in its summary. No points off for honesty - but follow these up.</p>' +
      A.admissions.map(function (a) { return '<p class="said">' + rich(a) + '</p>'; }).join('') + '</section>';
  }

  /* ---------------- the timeline ---------------- */

  var ACT_ICON = { test: '🧪', lint: '🧹', types: '🔤', build: '🏗️', edit: '✏️', write: '📄', delete: '🗑️', read: '👁️', search: '🔎', run: '▶️', commit: '📌', push: '⬆️', pr: '🔀', deploy: '🚀', migrate: '🗄️', web: '🌐', task: '🤖', install: '📦', other: '⚙️' };
  var ACT_NAME = { test: 'Tests', lint: 'Lint', types: 'Type check', build: 'Build', edit: 'Edit', write: 'Write', delete: 'Delete', read: 'Read', search: 'Search', run: 'Command', commit: 'Commit', push: 'Push', pr: 'Pull request', deploy: 'Deploy', migrate: 'Migration', web: 'Web', task: 'Subagent', install: 'Install', other: 'Tool' };
  function stepMatches(s, f) {
    if (f === 'all') return true;
    if (f === 'messages') return s.kind !== 'tool';
    if (s.kind !== 'tool') return false;
    if (f === 'changes') return Boolean(s.changes && s.changes.length && s.ok !== false);
    if (f === 'checks') return Boolean(s.checks && s.checks.length);
    if (f === 'commands') return Boolean(s.cmd);
    if (f === 'errors') return s.ok === false;
    return true;
  }
  function checkOk(s) {
    var ch = state.A.checksRun.filter(function (k) { return k.n === s.n; });
    if (!ch.length) return null;
    if (ch.some(function (k) { return k.ok === false; })) return { ok: false, short: ch.map(function (k) { return k.short; }).join('; '), hidden: ch.some(function (k) { return k.hidden; }) };
    return { ok: ch.every(function (k) { return k.ok === true; }) ? true : null, short: ch.map(function (k) { return k.short; }).join('; ') };
  }
  function statusHtml(s) {
    if (s.kind !== 'tool') return s.final ? '<span class="st st-unk">final</span>' : '';
    var ck = checkOk(s);
    if (ck && ck.ok === false) return '<span class="st ' + (s.ok === true ? 'st-warn' : 'st-err') + '">' + (ck.hidden ? '✗ hidden' : '✗ failed') + '</span>';
    if (s.ok === false) return '<span class="st st-err">✗ error</span>';
    if (s.ok === true) return '<span class="st st-ok">✓ ok</span>';
    return '<span class="st st-unk">' + (s.probeMiss ? 'no match' : '–') + '</span>';
  }
  function timelineHtml(r) {
    var counts = { all: r.steps.length };
    ['changes', 'checks', 'commands', 'errors', 'messages'].forEach(function (f) { counts[f] = r.steps.filter(function (s) { return stepMatches(s, f); }).length; });
    var list = r.steps.filter(function (s) { return stepMatches(s, state.filter); });
    var h = '<section class="card" id="timeline"><div class="sec-head"><h2><span aria-hidden="true">🕑</span> Timeline</h2><span class="small muted">' + plural(r.steps.length, 'step') + (r.stats && r.stats.errors ? ', ' + plural(r.stats.errors, 'error') : '') + '</span></div>' +
      '<ul class="filters" role="group" aria-label="Show steps">' + [['all', 'All'], ['changes', 'Changes'], ['checks', 'Checks'], ['commands', 'Commands'], ['errors', 'Errors'], ['messages', 'Messages']].filter(function (f) { return f[0] === 'all' || counts[f[0]]; }).map(function (f) {
        return '<li><button type="button" data-act="filter" data-f="' + f[0] + '" aria-pressed="' + (state.filter === f[0]) + '">' + esc(f[1]) + ' <span class="num">' + counts[f[0]] + '</span></button></li>';
      }).join('') + '</ul>';
    if (!list.length) return h + '<p class="muted" style="margin:0">No steps in that group.</p></section>';
    h += '<ol class="tl">' + list.slice(0, state.shown).map(stepHtml).join('') + '</ol>';
    if (list.length > state.shown) h += '<div class="btns" style="margin-top:10px"><button class="btn ghost small" type="button" data-act="more">Show ' + Math.min(200, list.length - state.shown) + ' more of ' + (list.length - state.shown) + '</button></div>';
    return h + '</section>';
  }
  function stepHtml(s) {
    var open = state.steps[s.n];
    var icon = s.kind === 'say' ? '💬' : s.kind === 'user' ? '🙋' : (ACT_ICON[s.act] || '⚙️');
    var label = s.kind === 'tool' ? s.label : C.clip(C.firstLine(s.text, 200), 200);
    var who = s.kind === 'say' ? 'Agent' : s.kind === 'user' ? 'Person' : (ACT_NAME[s.act] || 'Tool');
    var h = '<li class="titem k-' + esc(s.kind) + '" id="step-' + s.n + '"><button class="topen" type="button" data-act="openstep" data-n="' + s.n + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="tn">' + s.n + '</span><span class="ti" aria-hidden="true">' + icon + '</span>' +
      '<span class="tlab' + (s.cmd ? ' mono' : '') + '"><span class="vh">' + esc(who) + ': </span>' + esc(label) + (s.side ? ' <small>(subagent)</small>' : '') + '</span>' +
      '<span class="tst">' + statusHtml(s) + (s.ms ? '<span>' + esc(C.fmtMs(s.ms)) + '</span>' : '') + '</span></button>';
    if (open) h += '<div class="tbody">' + stepBody(s) + '</div>';
    return h + '</li>';
  }
  function diffHtml(c) {
    var rows = [];
    String(c.removed || '').split('\n').filter(function (l) { return l.trim(); }).slice(0, 30).forEach(function (l) { rows.push('<div class="d">- ' + esc(C.markInvisible(l)) + '</div>'); });
    String(c.added || '').split('\n').filter(function (l) { return l.trim(); }).slice(0, 40).forEach(function (l) { rows.push('<div class="a">+ ' + esc(C.markInvisible(l)) + '</div>'); });
    return rows.length ? '<div class="diff" role="region" aria-label="Changes to ' + esc(c.path) + '" tabindex="0">' + rows.join('') + '</div>' : '';
  }
  function stepBody(s) {
    if (s.kind !== 'tool') return '<p class="lab">' + (s.kind === 'say' ? (s.final ? 'The agent’s final message' : 'The agent said') : 'The person said') + '</p><p class="msg">' + esc(C.markInvisible(s.text)) + '</p>';
    var tags = [ACT_NAME[s.act] || s.act, s.tool];
    if (s.subset) tags.push('only: ' + s.subset);
    (s.flags || []).forEach(function (f) { tags.push({ 'or-true': '|| true', quiet: 'output hidden', 'set+e': 'set +e', 'pass-no-tests': '--passWithNoTests', 'no-verify': '--no-verify', 'force-push': 'force push', 'update-snapshots': 'snapshots rewritten' }[f.kind] || f.kind); });
    if (s.exit !== null && s.exit !== undefined) tags.push('exit ' + s.exit);
    if (s.ms) tags.push(C.fmtMs(s.ms));
    var h = '<div class="tags">' + tags.filter(Boolean).map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div>';
    if (s.cmd) h += '<pre class="out" tabindex="0">' + esc(C.markInvisible(s.cmd)) + '</pre>';
    (s.changes || []).forEach(function (c) { h += '<p class="small" style="margin:0"><b>' + esc((C.ACT_WORD[c.kind] || 'Changed') + ' ' + (c.path || 'files Proof cannot see')) + '</b>' + (c.via === 'shell' ? ' <span class="muted">by a shell command</span>' : '') + (s.ok === false ? ' <span class="muted">- it failed, so nothing changed</span>' : '') + '</p>' + diffHtml(c); });
    var ck = checkOk(s);
    if (ck) h += '<p class="small" style="margin:0"><b>Result:</b> ' + esc(ck.short) + (ck.hidden ? ' - and <code>|| true</code> hid the failure' : '') + '</p>';
    if (s.err) h += '<p class="small err" style="margin:0">' + esc(s.err) + '</p>';
    if (s.out !== undefined && String(s.out).trim()) {
      h += '<p class="lab" style="margin:4px 0 0">Output' + (s.outCut ? ' <span class="small" style="text-transform:none;letter-spacing:0;font-weight:600">- ' + esc(C.fmtInt(s.outLen)) + ' characters; the start and the end are kept</span>' : '') + '</p><pre class="out" tabindex="0">' + esc(C.markInvisible(s.out)) + '</pre>';
    } else if (s.out === undefined) h += '<p class="small muted" style="margin:0">No result was recorded for this call.</p>';
    if (s.folded) h += '<p class="small muted" style="margin:0">Claude Code’s terminal folded part of this output.</p>';
    return h;
  }
  function readHtml(r) {
    var sk = Object.keys(r.skipped || {});
    var h = '<section class="card" id="read"><details class="why"><summary>What Proof read - ' + esc(r.formatWord) + ', ' + plural(r.steps.length, 'step') + (sk.length ? ', ' + plural(sk.reduce(function (t, k) { return t + r.skipped[k]; }, 0), 'entry', 'entries') + ' skipped' : '') + '</summary><div class="stack" style="margin-top:8px">';
    h += '<p class="small" style="margin:0">' + esc(plural(r.stats ? r.stats.tools : 0, 'tool call')) + ', ' + esc(plural(r.stats ? r.stats.says : 0, 'message')) + ' from the agent, ' + esc(plural(r.stats ? r.stats.users : 0, 'message')) + ' from the person' + (r.stats && r.stats.side ? ', ' + esc(plural(r.stats.side, 'step')) + ' by subagents' : '') + '.</p>';
    if (sk.length) h += '<div><p class="lab">Not read, and why</p><ul class="skipbox">' + sk.map(function (k) { return '<li>' + esc(C.SKIP_WORD[k] || k) + ': <b>' + C.fmtInt(r.skipped[k]) + '</b></li>'; }).join('') + '</ul></div>';
    if (r.notes && r.notes.length) h += '<div class="note"><ul class="notes small">' + r.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></div>';
    h += '<p class="small muted" style="margin:0">Limits: ' + esc(C.fmtBytes(C.LIMITS.inputBytes)) + ' a file, ' + esc(C.fmtInt(C.LIMITS.lines)) + ' lines, ' + esc(C.fmtInt(C.LIMITS.steps)) + ' steps; each output keeps its first ' + esc(C.fmtInt(C.LIMITS.outHead)) + ' and last ' + esc(C.fmtInt(C.LIMITS.outTail)) + ' characters (summaries are at the end, and are read before anything is cut).</p>';
    return h + '</div></details></section>';
  }
  function footer() {
    return '<footer class="foot"><p>🔒 The run is read on this device and never uploaded. The AI second opinion sends only the snippets you confirm.</p><p>Proof checks claims against the run’s own receipts. It cannot tell you the code is right - read the diff too.</p></footer>';
  }

  function redraw(id) {
    var el = $('#' + id);
    if (!el || !state.A) return;
    var html = id === 'claims' ? claimsHtml(state.A, state.run) : id === 'goal' ? goalHtml(state.A) : id === 'timeline' ? timelineHtml(state.run) : id === 'tocheck' ? checkHtml(state.A) : id === 'verdict' ? verdictHtml(state.A, state.run) : null;
    if (html === null) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    el.replaceWith(tmp.firstChild);
  }
  function recheck() {
    analyze();
    state.open = {};
    if (!state.demo) keep(K_DRAFT, state.criteria.trim() ? { text: state.criteria.slice(0, 2400) } : null);
    var y = scrollY;
    $('#main').innerHTML = reportHtml();
    scrollTo(0, y);
  }

  function openExports() {
    var sum = C.summaryText(state.A, state.run);
    sheet('<h2>Export or copy the report</h2><p class="muted">Everything here is made on this device from the report you see. Nothing is uploaded.</p>' +
      '<p class="lab">One-paragraph summary</p><p class="note" style="overflow-wrap:anywhere">' + esc(sum) + '</p>' +
      '<div class="btns"><button class="btn small" type="button" data-act="copysum">Copy summary</button><button class="btn ghost small" type="button" data-act="copymd">Copy as PR comment (Markdown)</button><button class="btn ghost small" type="button" data-act="md">Download .md</button><button class="btn ghost small" type="button" data-act="json">Download .json</button></div>' +
      '<p class="small muted" style="margin-top:12px">The Markdown is a PR comment: the outcome, the trust score, what to check, every claim with its verdict and steps, the criteria and the patterns. The JSON has the same with the evidence lines, for a script or a CI step.</p>');
  }

  /* ---------------- the second opinion ---------------- */

  function opinionHtml(op) {
    return '<div class="opinion" role="region" aria-label="AI second opinion" style="margin-top:14px"><p class="lab" style="margin:0"><span aria-hidden="true">✨</span> Second opinion (AI)</p>' +
      (op.overall ? '<p class="ov">' + esc(op.overall) + '</p>' : '') +
      op.criteria.map(function (c) {
        return '<div class="oitem"><div class="oh">' + vpill(c.verdict, C.OP_WORD[c.verdict]) + '<span>' + esc(c.n + '. ' + c.text) + '</span></div><p>' + esc(c.why) + '</p>' +
          (c.whatToCheck ? '<p class="small"><b>Check:</b> ' + esc(c.whatToCheck) + '</p>' : '') +
          (c.evidenceRefs.length ? '<div class="row">' + c.evidenceRefs.map(stepBtn).join('') + '</div>' : '') + '</div>';
      }).join('') +
      '<p class="small muted" style="margin:0">AI’s read of the snippets it was shown - not the whole run. ' + (op.droppedRefs ? esc(plural(op.droppedRefs, 'reference')) + ' to steps it was never shown ' + (op.droppedRefs === 1 ? 'was' : 'were') + ' dropped. ' : '') + 'Check it against the receipts.</p></div>';
  }
  function openOpinion() {
    var p = C.opinionPayload(state.A, state.run);
    var shown = JSON.stringify(p, null, 2);
    var lead = '<p>AI reads the goal, ' + (state.A.criteria.length ? 'your ' + plural(state.A.criteria.length, 'criterion', 'criteria') : 'the goal as the one criterion') + ', the agent’s claims and ' + plural(p.snippets.length, 'short snippet') + ' of the run, and gives its own verdict on each criterion, with the steps that decide it.</p>' +
      '<div class="warnbox" role="note"><span aria-hidden="true">⚠️</span><div><b>This sends the text below to an AI provider (Anthropic).</b> ' + esc(plural(p.snippets.length, 'snippet')) + ' of at most ' + C.LIMITS.opinionLines + ' lines each, the claims and the criteria - never the whole run. Nothing is stored. Don’t send a run with secrets in its output.</div></div>';
    if (!p.criteria.length) { toast('Add a goal or a criterion first - Edit, under the goal.', 4200); return; }
    if (!signedIn()) {
      sheet('<h2>✨ Second opinion on the outcome</h2>' + lead + '<p class="small muted" style="margin:12px 0 6px"><b>Exactly what would be sent:</b></p><pre class="sent-pre" tabindex="0">' + esc(shown) + '</pre>' +
        '<p class="small muted" style="margin-top:12px">It uses a cent or two of AI credit, so it needs a free account (it comes with $2). The report, the timeline and the exports stay free, with no account.</p>' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="signin-opinion">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button></div>');
      return;
    }
    sheet('<h2>✨ Second opinion on the outcome</h2><div id="opLead">' + lead + '</div><details class="why" id="sentBox"><summary><b id="sentLabel">Exactly what will be sent (' + esc(plural(p.snippets.length, 'snippet')) + ')</b></summary><pre class="sent-pre" tabindex="0">' + esc(shown) + '</pre></details>' +
      '<div id="opErr"></div><div id="opActs"><label class="confirm"><input type="checkbox" id="opOk"> I have looked at what will be sent, and it can go to an AI provider.</label>' +
      '<div class="btns" style="margin-top:10px"><button class="btn" type="button" id="opSend" disabled>Send for a second opinion</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div><p class="small muted" style="margin-top:8px">A cent or two of AI credit.</p></div><div id="opOut"></div>', function (root) {
      var ok = $('#opOk', root), send = $('#opSend', root);
      ok.addEventListener('change', function () { send.disabled = !ok.checked; });
      send.addEventListener('click', function () {
        if (!ok.checked) return;
        send.disabled = true; send.textContent = 'Asking…';
        api('POST', 'api/opinion', p).then(function (r) {
          var op = C.cleanJudgement(r.opinion, p);
          if (!op) throw Object.assign(new Error('That answer had nothing usable in it. Try again.'), { status: 422 });
          op.droppedRefs = (op.droppedRefs || 0) + (r.opinion && r.opinion.droppedRefs || 0);
          state.opinion = op;
          $('#opActs', root).hidden = true; $('#opLead', root).hidden = true;
          $('#sentLabel', root).textContent = 'What was sent';
          $('#opOut', root).innerHTML = opinionHtml(op) + '<div class="btns" style="margin-top:12px"><button class="btn ghost" type="button" data-act="closesheet">Done</button></div>';
          redraw('goal'); loadMe();
        }).catch(function (err) { send.disabled = !ok.checked; send.textContent = 'Send for a second opinion'; meteredError(err, $('#opErr', root), function () { openOpinion(); }); });
      });
    });
  }

  /* ---------------- sheets and the account (shared shape with the lab) ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false; document.body.classList.add('sheet-open'); s.scrollTop = 0;
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2'); if (f) f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var FREE_LINE = 'Nothing in Proof needs an account except the AI second opinion - a free account comes with $2 of AI credit, and one account works across every app on this site.';
  function openAccount(reason, then) {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field" style="margin:10px 0"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field" style="margin:10px 0"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button" style="margin-top:10px">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center" style="margin-top:12px">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      $('#swap', root).addEventListener('click', function () { mode = mode === 'register' ? 'login' : 'register'; draw2(root); });
      $('#authForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); if (then) then(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { if (then) then(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">A second opinion costs a cent or two. The report, the timeline and the exports are free and need no account.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); }); });
        var pk = $('#pkEnrol', root);
        if (pk) pk.addEventListener('click', function () {
          var pw = prompt('Your password, to confirm it is you:');
          if (!pw) return;
          Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); }).catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
        });
      });
  }
  function drawBilling(el) {
    api('GET', 'api/auth/billing').then(function (b) {
      if (b.elsewhere) { el.innerHTML = '<a class="btn small ghost" href="' + esc(b.elsewhere) + '">Add credit</a>'; return; }
      if (!b.available) { el.innerHTML = ''; return; }
      if (!b.member) {
        el.innerHTML = '<button class="btn small" type="button" id="joinM">Become a member · $' + esc(b.monthlyUsd) + '/mo</button><p class="small muted">Membership covers every app on this site, runs the better model and lets you add credit.</p>';
        $('#joinM', el).addEventListener('click', function () { checkout('api/auth/billing/membership', {}); });
        return;
      }
      el.innerHTML = '<div class="row">' + (b.topUps || []).map(function (t) { return '<button class="btn small ghost" type="button" data-usd="' + esc(t.usd) + '">' + esc(t.label) + '</button>'; }).join('') + '</div>';
      $$('[data-usd]', el).forEach(function (btn) { btn.addEventListener('click', function () { checkout('api/auth/billing/credit', { usd: Number(btn.getAttribute('data-usd')) }); }); });
    }).catch(function () { el.innerHTML = ''; });
  }
  function checkout(path, body) { body.returnTo = BASE; api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); }); }
  function openCredit(data) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The report, the timeline and the exports keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- one click listener ---------------- */

  function fname(ext) { return 'proof-' + today() + ext; }
  function goStep(n) {
    if (!state.run) return;
    var s = state.run.steps.filter(function (x) { return x.n === n; })[0];
    if (!s) return;
    closeSheet(true);
    if (!stepMatches(s, state.filter)) state.filter = 'all';
    var list = state.run.steps.filter(function (x) { return stepMatches(x, state.filter); });
    var idx = list.indexOf(s);
    if (idx >= state.shown) state.shown = idx + 20;
    state.steps[n] = true;
    redraw('timeline');
    var li = $('#step-' + n);
    if (li) { li.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); li.classList.add('flash'); setTimeout(function () { li.classList.remove('flash'); }, 1600); var b = $('.topen', li); if (b) try { b.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); state.run = null; state.A = null; state.demo = null; go('start'); break;
      case 'demo': { var id = t.getAttribute('data-id') === 'honest' ? 'honest' : 'confident'; history.pushState(null, '', BASE + '#' + id); runDemo(id); break; }
      case 'pickfile': { var el = $('#pickFile'); if (el) el.click(); break; }
      case 'togglepaste': state.showPaste = !state.showPaste; draw(); if (state.showPaste) { var ta0 = $('#pasteLog'); if (ta0) ta0.focus(); } break;
      case 'checkpaste': {
        var log = ($('#pasteLog') || {}).value || '', sum = ($('#pasteSummary') || {}).value || '';
        if (!log.trim() && !sum.trim()) { toast('Paste the output first.'); break; }
        state.demo = null; startReading('Pasted output'); post({ op: 'text', name: 'Pasted output', text: log, summary: sum }); break;
      }
      case 'jump': { e.preventDefault(); var to = $('#' + t.getAttribute('data-to')); if (to) to.scrollIntoView({ block: 'start' }); break; }
      case 'openitem': { var iid = t.getAttribute('data-id'); state.open[iid] = !state.open[iid]; redraw(iid.charAt(0) === 'k' ? 'goal' : 'claims'); var b2 = $('#it-' + iid + ' .copen'); if (b2) try { b2.focus({ preventScroll: true }); } catch (x) { /* ignore */ } break; }
      case 'openstep': { var n = Number(t.getAttribute('data-n')); state.steps[n] = !state.steps[n]; redraw('timeline'); var b3 = $('#step-' + n + ' .topen'); if (b3) try { b3.focus({ preventScroll: true }); } catch (x) { /* ignore */ } break; }
      case 'gostep': goStep(Number(t.getAttribute('data-n'))); break;
      case 'filter': state.filter = t.getAttribute('data-f'); state.shown = 120; redraw('timeline'); break;
      case 'more': state.shown += 200; redraw('timeline'); break;
      case 'editgoal': state.editing = true; redraw('goal'); var gb = $('#critBox'); if (gb) gb.focus(); break;
      case 'canceledit': state.editing = false; redraw('goal'); break;
      case 'savegoal': state.goal = ($('#goalBox') || {}).value || ''; state.criteria = ($('#critBox') || {}).value || ''; state.editing = false; state.opinion = null; recheck(); toast('Checked again.'); break;
      case 'addcrit': {
        var line = t.getAttribute('data-text') || '';
        if (state.editing) { var cb = $('#critBox'); if (cb) { cb.value = (cb.value.trim() ? cb.value.replace(/\s+$/, '') + '\n' : '') + line; cb.focus(); } t.closest('li').remove(); break; }
        state.criteria = (state.criteria.trim() ? state.criteria.replace(/\s+$/, '') + '\n' : '') + line; state.opinion = null; recheck(); break;
      }
      case 'opinion': openOpinion(); break;
      case 'signin-opinion': openAccount('A second opinion uses a cent or two of AI credit; a free account comes with $2.', function () { openOpinion(); }); break;
      case 'copymd': copy(C.toMarkdown(state.A, state.run, today()), 'Copied as Markdown - paste it into the PR.'); break;
      case 'exports': openExports(); break;
      case 'copysum': copy(C.summaryText(state.A, state.run), 'Summary copied'); break;
      case 'md': download(fname('.md'), 'text/markdown', C.toMarkdown(state.A, state.run, today())); break;
      case 'json': download(fname('.json'), 'application/json', C.toJson(state.A, state.run)); break;
      default: break;
    }
  });

  /* ---------------- start ---------------- */

  function markOffline() { var p = $('#offlinePill'); if (p) p.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  startWorker();
  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });
  drawTop();
  route();
  loadMe().then(function () { if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings(); });
}());
