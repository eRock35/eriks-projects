/* Triage - the page. One file, no build step.
 *
 * DIFFS ARE READ HERE AND NOWHERE ELSE. A pasted or dropped diff is parsed
 * by TriageCore in this browser; the sorting, the risk order, the plan, the
 * split and the report are worked out here; nothing about the diff is sent.
 * The one request that carries code is "Explain this change", and it sends
 * TriageCore.explainPayload - one hunk the reviewer picked - shown in full,
 * with a warning and a confirmation box, before it is sent.
 *
 * Every string that came from a diff (a path, a line, a hunk header) or from
 * the server is escaped before it is drawn, and no handler is written into
 * markup: clicks are routed by data-act attributes from one listener (the
 * lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.TriageCore;
  var D = window.TriageDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_TICKS = 'triage-reviewed-v1';
  var K_CMD = 'triage-cmd-v1';
  var TABS = [['plan', '🧭', 'Plan', 'Review plan'], ['skim', '🧹', 'Skim', 'Skim list'], ['split', '✂️', 'Split', 'Split it'], ['report', '📝', 'Report', 'Report']];
  var esc = C.esc;
  var plural = C.plural;
  var fmtInt = C.fmtInt;
  var RISK = C.RISK;

  var state = {
    me: null,
    view: 'start',       // start | load | dash
    tab: 'plan',
    source: null,        // demo | file | paste
    sourceName: '',
    hash: '',
    a: null,             // TriageCore.analyse(...) - in memory only
    split: null,
    open: {},            // file index -> open in the plan
    done: {},            // path -> ticked as reviewed (this browser only)
    explained: {},       // "file:hunk" -> the model's answer (this tab only)
    cmd: { base: 'main', head: 'HEAD', shell: 'sh' },
    refs: { base: 'main', pr: '' },
    showPaste: false,
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.error) {
          var e = new Error(data.error || 'Something went wrong.');
          e.status = res.status; e.data = data;
          throw e;
        }
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
  function pill(risk, word) { return '<span class="pill r-' + risk + '"><span aria-hidden="true">' + RISK[risk].icon + '</span>' + esc(word || RISK[risk].word) + '</span>'; }
  function levelName(l) { return l === 3 ? 'high' : l === 2 ? 'medium' : 'low'; }
  /** Text with `code` spans, escaped. */
  function rich(s) { return esc(s).replace(/`([^`]{1,300})`/g, '<code>$1</code>'); }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. The plan, the checks and the split stay free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function meteredError(err, box, retry) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount('Explaining a change with AI uses about a cent of AI credit, so it needs a free account (it comes with $2).', retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }

  /* ---------------- reviewed ticks: this browser only, per diff ---------------- */

  function loadTicks() {
    state.done = {};
    var all = recall(K_TICKS);
    var mine = all && all.diffs && all.diffs[state.hash];
    if (mine && mine.done && typeof mine.done === 'object') {
      var known = {};
      state.a.files.forEach(function (f) { known[f.path] = 1; });
      Object.keys(mine.done).forEach(function (p) { if (known[p]) state.done[p] = 1; });
    }
  }
  function saveTicks() {
    var all = recall(K_TICKS);
    if (!all || typeof all !== 'object' || !all.diffs || typeof all.diffs !== 'object') all = { v: 1, diffs: {} };
    var n = Object.keys(state.done).length;
    if (n) all.diffs[state.hash] = { at: Date.now(), done: state.done };
    else delete all.diffs[state.hash];
    // Keep the twenty most recent diffs.
    var keys = Object.keys(all.diffs).sort(function (x, y) { return (all.diffs[y].at || 0) - (all.diffs[x].at || 0); });
    keys.slice(20).forEach(function (k) { delete all.diffs[k]; });
    keep(K_TICKS, all);
  }
  function setDone(path, on) {
    if (on) state.done[path] = 1; else delete state.done[path];
    saveTicks();
  }

  /* ---------------- routing ---------------- */

  function isTab(h) { return TABS.some(function (t) { return t[0] === h; }); }
  function go(where) {
    if (isTab(where)) { state.view = 'dash'; state.tab = where; }
    else if (where === 'triage') state.view = 'load';
    else state.view = 'start';
    history.pushState(null, '', BASE + '#' + (where === 'start' ? 'start' : where));
    draw(); scrollTo(0, 0);
  }
  function route() {
    var h = (location.hash || '').replace(/^#/, '');
    if (h === 'example') return openDemo(true);
    if (h === 'triage') { state.view = 'load'; draw(); return scrollTo(0, 0); }
    if (isTab(h)) {
      if (!state.a) return openDemo(true, h);
      state.view = 'dash'; state.tab = h; return draw();
    }
    state.view = 'start'; draw(); scrollTo(0, 0);
  }
  window.addEventListener('popstate', route);

  function draw() {
    closeSheet(true);
    var main = $('#main');
    document.body.classList.toggle('has-tabs', state.view === 'dash');
    if (state.view === 'load') { main.innerHTML = loadHtml(); wireLoad(); return; }
    if (state.view !== 'dash' || !state.a) { main.innerHTML = startHtml(); return; }
    var a = state.a;
    var badges = { plan: a.totals.high, skim: 0, split: 0, report: 0 };
    var html = stripHtml();
    html += '<nav class="tabbar dk-tabbar" aria-label="Triage"><div class="tabbar-inner"><a class="rail-brand" href="./#start" data-act="home"><span aria-hidden="true">🩺</span>Triage</a>' + TABS.map(function (t) {
      var n = badges[t[0]];
      return '<a class="tab' + (t[0] === state.tab ? ' on' : '') + '" href="#' + t[0] + '" data-act="tab" data-tab="' + t[0] + '"' + (t[0] === state.tab ? ' aria-current="page"' : '') + '><span class="i" aria-hidden="true">' + t[1] + '</span><span class="short">' + t[2] + '</span><span class="long">' + t[3] + '</span>' + (n ? '<span class="tab-badge" aria-label="' + n + ' high risk">' + n + '</span>' : '') + '</a>';
    }).join('') + '</div></nav>';
    html += '<div id="tab"></div>' + footer();
    main.innerHTML = html;
    drawTab();
  }
  function drawTab() {
    var el = $('#tab');
    if (!el) return;
    if (state.tab === 'skim') el.innerHTML = skimHtml();
    else if (state.tab === 'split') { el.innerHTML = splitHtml(); wireSplit(); }
    else if (state.tab === 'report') el.innerHTML = reportHtml();
    else el.innerHTML = planHtml();
  }
  function footer() {
    return '<footer class="foot"><p>🔒 Diffs are read on this device and never uploaded. Only a hunk you choose to have explained is sent - after you have seen it.</p><p>"Mechanical" means the same code by the rules shown, not "safe": run each group’s check.</p></footer>';
  }

  /* ---------------- first run ---------------- */

  function startHtml() {
    var html = '<section class="hero"><div class="stack" aria-hidden="true">' +
      ['#ff6b81:92%', '#ffb35c:70%', '#9cc3ff:52%', '#7c8597:100%', '#7c8597:86%', '#7c8597:96%', '#7c8597:64%', '#7c8597:88%'].map(function (s) { var p = s.split(':'); return '<span style="background:' + p[0] + ';width:' + p[1] + '"></span>'; }).join('') + '</div>' +
      '<div class="kicker"><span aria-hidden="true">🩺</span>For reviewers of AI-written pull requests</div>' +
      '<h1>Review the giant AI-written PR in the order that matters.</h1>' +
      '<p>A 3,000-line pull request from a coding agent, again. Somewhere among the renames, the reformatting, the snapshots and the lockfile is the change that matters. Triage finds it, puts it first, and tells you exactly how to skim the rest with a clear conscience.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="example">See an example PR</button><button class="btn big ghost" type="button" data-act="gotriage">Triage my PR</button></div>' +
      '<div class="trust"><span class="ico" aria-hidden="true">🔒</span><span><b>Read on this device. Nothing is uploaded.</b> A diff is your code, so Triage reads it in this browser and never sends it anywhere. No account needed.</span></div></section>';
    html += '<div class="how">' +
      '<section class="card"><span class="n" aria-hidden="true">1</span><h2>Drop in the diff</h2><p>Copy one git command, or paste the PR’s <code>.diff</code> from GitHub. It stays in this tab.</p></section>' +
      '<section class="card"><span class="n" aria-hidden="true">2</span><h2>Noise and signal, sorted</h2><p>Every file and hunk is called mechanical or meaningful - and what is meaningful is ranked by what it touches.</p></section>' +
      '<section class="card"><span class="n" aria-hidden="true">3</span><h2>A plan you can finish</h2><p>Read these first, then these. Skim the rest with the one check that makes it safe. Or ask for it split.</p></section></div>';
    html += '<div class="grid2" style="margin-top:14px">' +
      '<section class="card"><h2>Set aside, with a check for each</h2><ul class="chips">' +
      ['🚚 Renames and moved folders', '🧹 Whitespace and formatting', '🔀 Reordered imports', '🏷️ A rename across the whole PR', '🔒 Lockfile churn', '📸 Snapshot updates', '⚙️ Generated code', '📦 Vendored and minified files'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>' +
      '<section class="card"><h2>Put first, with what to look for</h2><ul class="chips">' +
      ['▲ Permission and sign-in checks', '▲ Database migrations', '▲ Routes with no test', '▲ Secrets and hidden characters', '▲ eval, shell and raw HTML', '◆ Config defaults and flags', '◆ New dependencies', '◆ Swallowed errors and new network calls'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section></div>';
    html += '<section class="card"><h2>Then, if it is too big to review honestly</h2><p class="muted lede">Triage proposes a stack of smaller PRs - mechanical changes first, then dependencies, migrations, permissions and each area of the code with its tests - with the git commands to cut it, a polite comment asking the author (or the agent) to split it, and a few lines for your <code>CLAUDE.md</code> or <code>AGENTS.md</code> so the next PR arrives reviewable.</p>' +
      '<div class="btns"><button class="btn" type="button" data-act="example">See it on the example</button><button class="btn ghost" type="button" data-act="gotriage">Triage my PR</button></div></section>' + footer();
    return html;
  }

  /* ---------------- the example ---------------- */

  function openDemo(replace, tab) {
    setDiff(D.text(), 'demo', D.title);
    state.view = 'dash'; state.tab = tab || 'plan';
    if (replace) history.replaceState(null, '', BASE + '#' + state.tab); else history.pushState(null, '', BASE + '#' + state.tab);
    draw(); scrollTo(0, 0);
  }
  function setDiff(text, source, name) {
    var parsed = C.parseDiff(text);
    state.a = C.analyse(parsed);
    state.source = source; state.sourceName = name;
    state.hash = C.hashText(text);
    state.open = {}; state.explained = {};
    state.refs = { base: source === 'demo' ? D.base : (state.cmd.base || 'main'), pr: source === 'demo' ? D.branch : (state.cmd.head && state.cmd.head !== 'HEAD' ? state.cmd.head : '') };
    state.split = null;
    loadTicks();
    // Open the first thing to read, so the plan starts where the reviewer should.
    var first = state.a.order[0];
    if (first !== undefined && state.a.files[first].risk !== 'skim') state.open[first] = true;
  }

  /* ---------------- triage my PR ---------------- */

  function cmdFor() { return C.gatherCommand({ base: state.cmd.base, head: state.cmd.head, shell: state.cmd.shell }); }
  function loadHtml() {
    var c = state.cmd, cmd = cmdFor();
    var html = '<section class="card stepcard"><button class="link-btn" type="button" data-act="home">← Back</button><h1 style="margin:2px 0 8px">Triage your PR</h1>' +
      '<p class="muted lede">Two steps. The diff is read in this browser and goes nowhere else.</p>' +
      '<h2><span class="k">1</span>Get the diff</h2>' +
      '<p class="small muted">Run this on your machine, in the repo, with the PR’s branch fetched. It writes <code>triage.diff</code>: the PR’s changes against the base, with git’s rename detection, and a summary at the top so a cut-off file is noticed.</p>' +
      '<div class="fields"><label class="field"><span>Base branch</span><input class="input code" id="cBase" value="' + esc(c.base) + '" autocomplete="off" spellcheck="false" maxlength="120"></label>' +
      '<label class="field"><span>PR branch</span><input class="input code" id="cHead" value="' + esc(c.head) + '" autocomplete="off" spellcheck="false" maxlength="120"></label>' +
      '<div class="field"><span>Shell</span><div class="seg" role="group" aria-label="Shell"><button class="segb" type="button" data-act="cshell" data-v="sh" aria-pressed="' + (c.shell === 'sh') + '">macOS / Linux</button><button class="segb" type="button" data-act="cshell" data-v="ps" aria-pressed="' + (c.shell === 'ps') + '">PowerShell</button></div></div></div>' +
      '<div class="cmd wrapcmd"><pre id="cmdText" aria-label="The command">' + esc(cmd.command || '') + '</pre><button class="btn ghost" type="button" data-act="copycmd">Copy</button></div>' +
      '<p class="err" id="cmdErr" role="alert"' + (cmd.error ? '' : ' hidden') + '>' + esc(cmd.error || '') + '</p>' +
      '<details class="more"><summary>What it runs</summary><ul class="whatitdoes"><li><code>git diff --stat -M</code>: the list of files and line counts, so Triage can tell if the file was cut off.</li><li><code>git diff -M</code>: every change from where your branch left the base (the three dots), with renames detected.</li><li>Reads git only. No network, nothing downloaded, nothing else on your machine touched.</li></ul></details>' +
      '<p class="small muted" style="margin-top:6px"><b>On GitHub instead?</b> Add <code>.diff</code> to the pull request’s address (<code>…/pull/123.diff</code>), save the page as a file and drop it below - or copy it and paste it.</p></section>';
    html += '<section class="card stepcard"><h2><span class="k">2</span>Drop it here</h2>' +
      '<div class="drop" id="drop"><span class="ico" aria-hidden="true">📄</span><b>Drop triage.diff here</b><span class="small muted">or a .diff / .patch file</span>' +
      '<div class="btns"><label class="btn filepick">Choose a file<input type="file" id="pickFile" accept=".diff,.patch,.txt,text/plain,text/x-diff,text/x-patch" aria-label="Choose a diff file"></label>' +
      '<button class="btn ghost" type="button" data-act="togglepaste">' + (state.showPaste ? 'Hide the paste box' : 'Paste it instead') + '</button></div></div>' +
      (state.showPaste ? '<label class="field" style="margin-top:12px"><span>Paste the diff</span><textarea class="input code" id="pasteDiff" rows="10" spellcheck="false" placeholder="diff --git a/src/app.ts b/src/app.ts"></textarea></label><div class="btns" style="margin-top:10px"><button class="btn" type="button" data-act="triagepaste">Triage it</button></div>' : '') +
      '<div id="loadState" aria-live="polite" style="margin-top:10px"></div>' +
      '<p class="small muted" style="margin:10px 0 0">🔒 Read in this browser. Nothing is uploaded - not the diff, not the file names.</p></section>' + footer();
    return html;
  }
  function wireLoad() {
    var upd = function () {
      var b = $('#cBase'), h = $('#cHead');
      if (b) state.cmd.base = b.value.trim();
      if (h) state.cmd.head = h.value.trim();
      var r = cmdFor();
      $('#cmdText').textContent = r.command || '';
      var e = $('#cmdErr'); e.hidden = !r.error; e.textContent = r.error || '';
      if (!r.error) keep(K_CMD, state.cmd);
    };
    ['#cBase', '#cHead'].forEach(function (s) { var el = $(s); if (el) el.addEventListener('input', upd); });
    var drop = $('#drop');
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(f); });
    $('#pickFile').addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) readFile(f); e.target.value = ''; });
  }
  function decode(buf) {
    var b = new Uint8Array(buf);
    try {
      if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b);
      if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b);
      return new TextDecoder('utf-8').decode(b);
    } catch (e) { return null; }
  }
  function readFile(file) {
    var box = $('#loadState');
    if (file.size > C.LIMITS.bytes) { box.innerHTML = '<p class="err" role="alert">That file is ' + Math.round(file.size / 1048576) + ' MB; Triage reads up to ' + Math.round(C.LIMITS.bytes / 1048576) + ' MB.</p>'; return; }
    box.innerHTML = '<p class="muted">Reading ' + esc(C.clean(file.name, 80)) + ' (' + (file.size / 1048576).toFixed(1) + ' MB) on this device…</p>';
    file.arrayBuffer().then(function (buf) {
      var text = decode(buf);
      if (text === null) { box.innerHTML = '<p class="err" role="alert">That file could not be read as text.</p>'; return; }
      takeText(text, 'file', C.clean(file.name, 80), box);
    }, function () { box.innerHTML = '<p class="err" role="alert">That file could not be read.</p>'; });
  }
  function takeText(text, source, name, box) {
    var parsed;
    try { parsed = C.parseDiff(text); } catch (e) { box.innerHTML = '<p class="err" role="alert">That could not be read as a diff.</p>'; return; }
    if (parsed.empty) {
      box.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">No file changes found in that.</p><p class="small muted" style="margin:0">A diff has lines like <code>diff --git a/… b/…</code>, <code>--- a/…</code> and <code>@@ -12,7 +12,9 @@</code>. If the command printed nothing, the branch may have no changes against the base - or the base name is wrong.</p></div>';
      return;
    }
    setDiff(text, source, name);
    go('plan');
  }

  /* ---------------- the dashboard ---------------- */

  function stripHtml() {
    var a = state.a;
    var who = state.source === 'demo'
      ? '<p><b>Example:</b> “' + esc(D.title) + '” <span class="sub">· <code>' + esc(D.branch) + '</code> → <code>' + esc(D.base) + '</code> · written by ' + esc(D.author) + ' · made up</span></p>'
      : '<p><b>' + esc(state.sourceName || 'Your diff') + '</b> <span class="sub">· ' + esc(plural(a.totals.files, 'file')) + ' · +' + fmtInt(a.totals.adds) + ' / -' + fmtInt(a.totals.dels) + ' · read on this device</span></p>';
    return '<div class="strip">' + who + '<div class="btns">' +
      (state.source === 'demo' ? '<button class="btn small light" type="button" data-act="gotriage">Triage my PR</button>' : '<button class="btn small ghost" type="button" data-act="gotriage">Load another</button>') + '</div></div>';
  }
  function progress() {
    var a = state.a, closeN = 0, closeDone = 0, skimN = 0, skimDone = 0;
    a.files.forEach(function (f) {
      if (f.risk === 'skim') { skimN++; if (state.done[f.path]) skimDone++; } else { closeN++; if (state.done[f.path]) closeDone++; }
    });
    return { closeN: closeN, closeDone: closeDone, skimN: skimN, skimDone: skimDone, all: a.files.length, done: closeDone + skimDone };
  }
  function progressHtml() {
    var p = progress();
    var pct = p.all ? Math.round(100 * p.done / p.all) : 0;
    return '<div class="progress" id="progress"><div class="row spread"><b>' + (p.done === p.all && p.all ? '✓ Every file reviewed or checked' : 'Your progress') + '</b><span class="small muted">' + esc(p.closeDone + ' of ' + p.closeN + ' to read · ' + p.skimDone + ' of ' + p.skimN + ' skim files checked') + '</span></div>' +
      '<div class="pbar" role="progressbar" aria-label="Files reviewed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div>' +
      '<div class="row spread"><span class="small muted">Ticks are kept in this browser only, for this diff.</span>' + (p.done ? '<button class="link-btn small" type="button" data-act="clearticks">Clear ticks</button>' : '') + '</div></div>';
  }
  function verdictHtml() {
    var a = state.a, t = a.totals, v = a.verdict, est = a.estimate;
    var seg = function (cls, n) { return n ? '<span class="' + cls + '" style="width:' + (100 * n / Math.max(1, t.lines)).toFixed(2) + '%"></span>' : ''; };
    var tone = t.high ? pill('high', 'Read carefully: ' + plural(t.high, 'high-risk file')) : t.medium ? pill('medium', 'Some risk: ' + plural(t.medium, 'file') + ' to check') : t.close + t.low ? pill('low', 'Low risk') : pill('skim', 'Mechanical only');
    var html = '<section class="card verdict"><div>' + tone + '</div><h1>' + esc(v.headline) + '</h1><p class="vsub">' + esc(v.sub) + '</p>' +
      '<div class="mix" aria-hidden="true">' + seg('m-close', t.close) + seg('m-low', t.low) + seg('m-mech', t.mech) + '</div>' +
      '<ul class="legend"><li><i class="m-close"></i><span><b>' + fmtInt(t.close) + '</b> to read closely (high and medium risk)</span></li><li><i class="m-low"></i><span><b>' + fmtInt(t.low) + '</b> low-risk, read quickly</span></li><li><i class="m-mech"></i><span><b>' + fmtInt(t.mech) + '</b> mechanical, skim with checks</span></li></ul>' +
      '<dl class="stats"><div><dt>Review time</dt><dd>~' + esc(C.fmtMinutes(est.minutes)) + '</dd></div><div><dt>High-risk files alone</dt><dd>~' + esc(C.fmtMinutes(est.highOnly || 0)) + '</dd></div>' +
      '<div><dt>Files to read</dt><dd>' + fmtInt(t.high + t.medium + t.lowFiles) + ' <small>of ' + fmtInt(t.files) + '</small></dd></div><div><dt>Skim groups</dt><dd>' + fmtInt(a.skim.length) + ' <small>' + esc(plural(t.skimFiles, 'file')) + '</small></dd></div></dl>' +
      '<details class="more"><summary>How the time is estimated</summary><ul>' + est.assumptions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '<li>' + esc('This PR: high ' + est.parts.high + ' min, medium ' + est.parts.medium + ' min, low ' + est.parts.low + ' min, skim checks ' + est.parts.skim + ' min.') + '</li></ul></details>' +
      progressHtml() + '</section>';
    if (a.warnings.length) html += '<div class="note" role="note" style="margin-top:14px"><b>Read with notes</b><ul style="margin:6px 0 0;padding-left:20px">' + a.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>';
    return html;
  }

  /* ---------------- the plan ---------------- */

  function planHtml() {
    var a = state.a;
    var html = verdictHtml();
    var by = { high: [], medium: [], low: [] };
    a.order.forEach(function (i) { var f = a.files[i]; if (by[f.risk]) by[f.risk].push(f); });
    var n = 0;
    [['high', 'Read these first', 'Each one touches something where a mistake is expensive. Open it for why, and what to look for.'], ['medium', 'Then these', 'Worth a careful read, with a short list of what to check.'], ['low', 'Read quickly', 'Real changes, but nothing risky was found in them.']].forEach(function (s) {
      var fs = by[s[0]];
      if (!fs.length) return;
      n++;
      var lines = fs.reduce(function (t, f) { return t + f.meanLines; }, 0);
      html += '<section class="sec"><div class="sec-head"><h2>' + n + ' · ' + esc(s[1]) + ' ' + pill(s[0]) + '</h2><span class="small muted">' + esc(plural(fs.length, 'file') + ' · ' + plural(lines, 'line') + ' to read') + '</span></div><p class="small muted" style="margin:0">' + esc(s[2]) + '</p>' +
        '<ul class="flist">' + fs.map(fileRow).join('') + '</ul></section>';
    });
    if (a.skim.length) {
      n++;
      html += '<section class="sec"><div class="sec-head"><h2>' + n + ' · Skim with checks ' + pill('skim') + '</h2><span class="small muted">' + esc(plural(a.totals.skimFiles, 'file') + ' · ' + plural(a.totals.mech - a.totals.mixedLines, 'line')) + '</span></div>' +
        '<div class="card"><ul class="chips" style="margin:0 0 12px">' + a.skim.map(function (g) { return '<li><span aria-hidden="true">' + g.icon + '</span>' + esc(g.title + ' · ' + g.files.length) + '</li>'; }).join('') + '</ul>' +
        '<p class="small muted">Each group comes with the one check that makes skimming it safe.</p><button class="btn" type="button" data-act="tab" data-tab="skim">Open the skim list →</button></div></section>';
    }
    if (!a.files.length) html += '<section class="card"><p>No changes.</p></section>';
    return html;
  }
  function reasonLine(f) {
    if (f.mech) return '<span class="fwhy">' + esc(C.SKIM[f.mech].title) + '</span>';
    var r = f.reasons.slice(0, 2).map(function (x) { return x.text; });
    if (!r.length) return '<span class="fwhy muted">Nothing risky found - a quick read.</span>';
    return '<span class="fwhy">' + esc(r.join(' · ')) + (f.reasons.length > 2 ? ' <span class="muted">+' + (f.reasons.length - 2) + ' more</span>' : '') + '</span>';
  }
  function statusWord(f) {
    if (f.status === 'A') return 'new file';
    if (f.status === 'D') return 'deleted';
    if (f.status === 'R') return 'renamed' + (f.similarity !== null && f.similarity < 100 ? ' (' + f.similarity + '% similar)' : '');
    if (f.status === 'C') return 'copied';
    return '';
  }
  function fileRow(f) {
    var open = Boolean(state.open[f.i]), done = Boolean(state.done[f.path]);
    var meta = [];
    var sw = statusWord(f); if (sw) meta.push(sw);
    if (f.binary) meta.push('binary');
    meta.push(f.mech ? plural(f.lines, 'line') : (plural(f.meanLines, 'line') + ' to read' + (f.mechLines ? ', ' + fmtInt(f.mechLines) + ' mechanical' : '')));
    if (f.mixed) meta.push('mixed: some hunks are only formatting');
    return '<li class="fitem e-' + f.risk + (done ? ' done' : '') + '" id="f' + f.i + '"><div class="fhead">' +
      '<label class="tick"><input type="checkbox" data-tick="' + f.i + '"' + (done ? ' checked' : '') + ' aria-label="' + esc('Reviewed ' + f.path) + '"></label>' +
      '<button class="fopen" type="button" data-act="file" data-i="' + f.i + '" aria-expanded="' + open + '"><span class="fpath">' + esc(f.path) + (f.status === 'R' && f.oldPath !== f.path ? ' <span class="from">← ' + esc(f.oldPath) + '</span>' : '') + '</span><span class="chev" aria-hidden="true">' + (open ? '▾' : '▸') + '</span>' +
      '<span class="fmeta">' + pill(f.risk) + '<span>' + esc(meta.join(' · ')) + '</span>' + (done ? '<span>✓ reviewed</span>' : '') + '</span>' + reasonLine(f) + '</button></div>' +
      (open ? '<div class="fbody">' + fileBody(f) + '</div>' : '') + '</li>';
  }
  function hitsOf(f) {
    var m = {};
    f.reasons.forEach(function (r) { r.hits.forEach(function (h) { (m[h.h + ':' + h.i] = m[h.h + ':' + h.i] || []).push(r.text); }); });
    return m;
  }
  function fileBody(f) {
    var html = '';
    if (f.reasons.length) {
      html += '<div><p class="lab">Why it is here</p><ul class="reasons">' + f.reasons.map(function (r) {
        var lv = levelName(r.level);
        return '<li>' + pill(lv) + '<span><b>' + esc(r.text) + '</b>' + (r.hits.length ? ' <span class="muted small">(' + esc(plural(r.hits.length, 'line')) + ' marked below)</span>' : '') + '</span>' + (r.detail.length ? '<span class="rd">' + r.detail.map(esc).join(' · ') + '</span>' : '') + '</li>';
      }).join('') + '</ul></div>';
    } else if (f.mech) {
      html += '<div class="check"><b>' + esc(C.SKIM[f.mech].title) + '.</b><p>' + esc(C.SKIM[f.mech].why) + '</p></div>';
    }
    if (f.look && f.look.length) html += '<div><p class="lab">What to look for</p><ul class="look">' + f.look.map(function (l) { return '<li><span>' + rich(l) + '</span></li>'; }).join('') + '</ul></div>';
    if (!f.mech) {
      var meaningfulHunks = f.hunks.filter(function (h) { return !h.mech; }).length;
      var all = C.explainPayload(f, null);
      if (meaningfulHunks > 1 && !all.error) html += '<div class="btns"><button class="btn ai small" type="button" data-act="explain" data-f="' + f.i + '" data-h="all">✨ Explain the whole file</button></div>';
    }
    if (f.binary) html += '<p class="small muted">A binary file: there are no lines to show.</p>';
    else if (!f.hunks.length) html += '<p class="small muted">' + esc(f.status === 'R' ? 'Renamed with nothing inside changed.' : f.status === 'C' ? 'Copied with nothing changed.' : 'No line changes (the file mode or name changed).') + '</p>';
    else {
      html += '<ul class="dlegend" aria-hidden="true"><li><i class="add"></i>added</li><li><i class="del"></i>removed</li><li><i class="hit"></i>a line that put it on this list</li><li><i class="same"></i>≈ · only reformatted</li></ul>';
      var hits = hitsOf(f);
      html += f.hunks.map(function (h, hi) { return hunkHtml(f, h, hi, hits); }).join('');
    }
    html += '<div class="btns"><button class="btn small' + (state.done[f.path] ? ' ghost' : '') + '" type="button" data-act="markdone" data-i="' + f.i + '">' + (state.done[f.path] ? 'Mark as not reviewed' : '✓ Mark as reviewed') + '</button></div>';
    return html;
  }
  function hunkHtml(f, h, hi, hits) {
    var mech = h.mech;
    var label = mech ? pill('skim', mech.label || 'Mechanical') : pill(f.risk === 'skim' ? 'low' : f.risk, 'Read closely');
    var head = '<span class="tw"><b>Hunk ' + (hi + 1) + ' of ' + f.hunks.length + '</b><span class="mono muted">@@ -' + h.os + ',' + h.oc + ' +' + h.ns + ',' + h.nc + ' @@</span></span>' + label;
    var body = '<div class="diff" role="region" tabindex="0" aria-label="' + esc('Hunk ' + (hi + 1) + ' of ' + f.path) + '">';
    var on = h.os, nn = h.ns, shown = 0, hitN = 0, sameN = 0;
    for (var k = 0; k < h.lines.length; k++) {
      var l = h.lines[k], c = l[0];
      var no = c === '-' ? on : nn;
      if (c !== '+') on++;
      if (c !== '-') nn++;
      if (shown >= C.LIMITS.showPerHunk) continue;
      shown++;
      var hit = hits[hi + ':' + k];
      var same = c !== ' ' && h.same && h.same[k];
      if (same) sameN++;
      if (hit && !same) hitN++;
      var txt = l[1];
      var long = txt.length > C.LIMITS.lineShow;
      if (long) txt = txt.slice(0, C.LIMITS.lineShow);
      if (same) hit = null;
      body += '<span class="ln' + (same ? ' same' : c === '+' ? ' add' : c === '-' ? ' del' : '') + (hit ? ' hit' : '') + '"' + (hit ? ' title="' + esc(hit.join('; ')) + '"' : same ? ' title="Only formatting changed on this line"' : '') + '><span class="no">' + no + '</span><span class="sg">' + (c === ' ' ? ' ' : same ? (c === '+' ? '≈' : '·') : c === '+' ? '+' : '−') + '</span><span class="tx">' + esc(C.markInvisible(txt)) + (long ? '<span class="muted"> … (' + fmtInt(l[1].length) + ' characters)</span>' : '') + '</span>' + (hit ? '<span class="vh"> - flagged: ' + esc(hit.join('; ')) + '</span>' : '') + '</span>';
    }
    if (h.lines.length > shown) body += '<span class="more">' + esc(plural(h.lines.length - shown, 'more line')) + ' not shown here.</span>';
    if (h.cut) body += '<span class="more">' + esc(h.dropped ? 'Part of this hunk was not kept in memory (the diff is very large); its lines are still counted.' : 'A line here was very long and was cut for memory, so this hunk is never called mechanical.') + '</span>';
    body += '</div>';
    var acts = '';
    if (!mech) {
      var key = f.i + ':' + hi, ex = state.explained[key];
      acts = '<div class="hacts" id="ex-' + f.i + '-' + hi + '">' + (ex ? explainedHtml(ex) : '<button class="btn ai small" type="button" data-act="explain" data-f="' + f.i + '" data-h="' + hi + '">✨ Explain this change</button><span class="small muted" style="align-self:center">' + esc([hitN ? plural(hitN, 'line') + ' flagged' : '', sameN ? plural(sameN / 2, 'line pair') + ' only reformatted (≈, quieted)' : ''].filter(Boolean).join(' · ') || 'Uses AI on this hunk only - after you see it') + '</span>') + '</div>';
    }
    return '<details class="hunk"' + (mech ? '' : ' open') + '><summary>' + head + '</summary>' + body + acts + '</details>';
  }

  /* ---------------- skim ---------------- */

  function skimHtml() {
    var a = state.a;
    if (!a.skim.length) return '<section class="card empty"><h2>Nothing to skim</h2><p class="muted">Every file in this diff carries a real change. The plan has them in order.</p></section>';
    var html = '<section class="card"><h2>Skim with checks</h2><p class="muted lede">' + esc(plural(a.totals.skimFiles, 'file') + ' and ' + plural(a.totals.mech - a.totals.mixedLines, 'line') + ' are mechanical. Skimming is only safe because of a check - so each group says what was verified on this device, and what to run to confirm it. Tick a file once its group’s check passes.') + '</p>';
    if (a.renames.length || a.moves.length) {
      html += '<div class="note"><b>Found across the PR</b><ul style="margin:6px 0 0;padding-left:20px">' +
        a.renames.map(function (r) { return '<li>The name <code>' + esc(r.from) + '</code> → <code>' + esc(r.to) + '</code>, on ' + esc(plural(r.lines, 'line') + ' in ' + plural(r.files, 'file')) + ', every line otherwise identical.</li>'; }).join('') +
        movesSummary(a).map(function (m) { return '<li>Moved <code>' + esc(m.from) + '/</code> → <code>' + esc(m.to) + '/</code> (' + esc(plural(m.n, 'file')) + ').</li>'; }).join('') + '</ul></div>';
    }
    if (a.totals.mixedLines) html += '<p class="small muted" style="margin:10px 0 0">' + esc(plural(a.totals.mixedLines, 'more mechanical line') + ' sit inside files that also carry real changes; they are marked hunk by hunk in the plan.') + '</p>';
    html += '</section>';
    a.skim.forEach(function (g) {
      var files = g.files.map(function (i) { return a.files[i]; });
      var chk = C.skimCheck(g.key, files, { base: state.refs.base, head: state.refs.pr || 'HEAD' }, a.renames);
      var doneN = files.filter(function (f) { return state.done[f.path]; }).length;
      html += '<section class="card group" id="g-' + g.key + '"><div class="gh"><h2><span aria-hidden="true">' + g.icon + '</span>' + esc(g.title) + '</h2><span class="small muted">' + esc(plural(files.length, 'file') + ' · ' + plural(g.lines, 'line') + (doneN ? ' · ' + doneN + ' checked' : '')) + '</span></div>' +
        '<p class="muted" style="margin:0">' + esc(g.why) + '</p>' +
        '<div class="check"><b>The check that makes it safe</b><p>' + esc(chk.check) + '</p></div>' +
        (chk.cmd.length ? '<div class="cmd"><pre aria-label="' + esc('Check for ' + g.title) + '">' + esc(chk.cmd.join('\n')) + '</pre><button class="btn ghost" type="button" data-act="copycheck" data-g="' + esc(g.key) + '">Copy</button></div>' : '') +
        '<ul class="slist">' + files.map(function (f) {
          var sub = f.status === 'R' ? 'from ' + f.oldPath : (f.mechKinds && f.mechKinds.length > 1 ? f.mechKinds.map(function (k) { return C.MECH_LABEL[k]; }).join(' + ') : plural(f.lines, 'line'));
          return '<li><label class="tick"><input type="checkbox" data-tick="' + f.i + '"' + (state.done[f.path] ? ' checked' : '') + ' aria-label="' + esc('Checked ' + f.path) + '"></label><span class="sp"><button class="open" type="button" data-act="fileview" data-i="' + f.i + '">' + esc(f.path) + '</button><small>' + esc(sub) + '</small></span></li>';
        }).join('') + '</ul>' +
        '<div class="btns"><button class="btn small ghost" type="button" data-act="tickgroup" data-g="' + esc(g.key) + '">' + (doneN === files.length ? 'Untick all' : 'Check passed: tick all ' + files.length) + '</button></div></section>';
    });
    return html;
  }
  function movesSummary(a) {
    var m = {};
    a.moves.forEach(function (x) { var k = C.dirname(x.from) + '\u0000' + C.dirname(x.to); if (C.dirname(x.from) !== C.dirname(x.to)) m[k] = (m[k] || 0) + 1; });
    return Object.keys(m).map(function (k) { var p = k.split('\u0000'); return { from: p[0] || '.', to: p[1] || '.', n: m[k] }; }).filter(function (x) { return x.n > 1; });
  }

  /* ---------------- split ---------------- */

  function splitData() {
    state.split = C.splitPlan(state.a, { base: state.refs.base, pr: state.refs.pr });
    return state.split;
  }
  function splitHtml() {
    var a = state.a, sp = splitData(), gs = sp.groups;
    var html = '<section class="card"><h2>Split it into ' + esc(plural(gs.length, 'stacked PR')) + '</h2><p class="muted lede">' +
      esc(gs.length < 2 ? 'This PR is already one concern; splitting would not make it easier to review.' : 'Mechanical changes first, so they can be approved on their checks alone and every later PR shrinks. Then one concern per PR, each based on the one before, with tests travelling with their code.') + '</p>' +
      '<ol class="stack-list">' + gs.map(function (g) {
        var mech = g.key === 'mechanical';
        return '<li><span class="n' + (mech ? ' mech' : '') + '" aria-hidden="true">' + g.n + '</span><div class="sb"><h3>' + esc(g.title) + ' ' + pill(g.top) + '</h3>' +
          '<span class="small muted">' + esc(plural(g.files.length, 'file') + ' · ' + plural(g.lines, 'line') + (mech ? ' · no behaviour change' : ' · ' + plural(g.meanLines, 'line') + ' to read')) + ' · branch <code>' + esc(g.branch) + '</code></span>' +
          '<p style="margin:0">' + esc(g.why) + (g.mixed ? ' ' + esc(plural(g.mixed, 'file') + ' here also carry formatting changes; ask for those to move to part 1.') : '') + '</p>' +
          '<details><summary>' + esc('The ' + plural(g.files.length, 'file')) + '</summary><ul class="files">' + g.files.map(function (i) { var f = a.files[i]; return '<li>' + esc(f.path) + (f.status === 'R' ? ' <span class="muted">(from ' + esc(f.oldPath) + ')</span>' : '') + '</li>'; }).join('') + '</ul></details></div></li>';
      }).join('') + '</ol></section>';
    html += '<section class="card"><h2>The commands</h2><p class="small muted">Run on the PR branch with a clean working tree. Each part is restored from the PR as it stands, so nothing is retyped; the last line checks that the stack adds up to the original exactly.</p>' +
      '<div class="fields"><label class="field"><span>Base branch</span><input class="input code" id="sBase" value="' + esc(state.refs.base) + '" autocomplete="off" spellcheck="false" maxlength="120"></label><label class="field"><span>PR branch (optional)</span><input class="input code" id="sPr" value="' + esc(state.refs.pr) + '" placeholder="the current commit" autocomplete="off" spellcheck="false" maxlength="120"></label></div>' +
      '<p class="err" id="sErr" role="alert" hidden></p>' +
      '<div class="cmd"><pre id="splitCmd" aria-label="Commands to split the PR">' + esc(sp.commands.join('\n')) + '</pre><button class="btn ghost" type="button" data-act="copysplit">Copy</button></div></section>';
    html += '<div class="grid2" style="margin-top:14px"><section class="card"><h2>Ask for it to be split</h2><p class="small muted">A comment for the PR - to its author, or the agent that wrote it. Paths and counts only.</p><pre class="prebox" aria-label="Comment for the PR">' + esc(sp.comment) + '</pre><div class="btns" style="margin-top:10px"><button class="btn" type="button" data-act="copycomment">Copy the comment</button></div></section>' +
      '<section class="card"><h2>Rules for your agents</h2><p class="small muted">Paste into <code>CLAUDE.md</code>, <code>AGENTS.md</code> or your agent’s instructions so the next PR arrives reviewable.</p><pre class="prebox" aria-label="Rules for agents">' + esc(sp.rules) + '</pre><div class="btns" style="margin-top:10px"><button class="btn" type="button" data-act="copyrules">Copy the rules</button><button class="btn ghost" type="button" data-act="dlrules">Download .md</button></div></section></div>';
    return html;
  }
  var REF_OK = /^[A-Za-z0-9._/@+-]{0,120}$/;
  function wireSplit() {
    var upd = function () {
      var b = $('#sBase').value.trim(), p = $('#sPr').value.trim();
      var bad = !b || !REF_OK.test(b) || !REF_OK.test(p) || /\.\./.test(b + p) || b.charAt(0) === '-' || p.charAt(0) === '-';
      var e = $('#sErr'); e.hidden = !bad; e.textContent = bad ? 'Branch names can only use letters, numbers and . _ / @ + -' : '';
      if (bad) return;
      state.refs.base = b; state.refs.pr = p;
      $('#splitCmd').textContent = splitData().commands.join('\n');
    };
    $('#sBase').addEventListener('input', upd);
    $('#sPr').addEventListener('input', upd);
  }

  /* ---------------- report ---------------- */

  function refs() { return { base: state.refs.base, head: state.refs.pr || 'HEAD' }; }
  function reportHtml() {
    var md = C.toMarkdown(state.a, state.done, refs());
    return '<section class="card"><div class="sec-head"><h2>The review summary</h2><span class="small muted">Markdown, for the PR or the ticket</span></div>' +
      '<p class="small muted">The risk map, what was skimmed and why that was safe, and what was checked - with your ticks. <b>Paths, counts and reasons only: never a line of the code.</b></p>' +
      '<div class="btns" style="margin-bottom:12px"><button class="btn" type="button" data-act="copymd">Copy as Markdown</button><button class="btn ghost" type="button" data-act="md">Download .md</button><button class="btn ghost" type="button" data-act="json">Download .json</button></div>' +
      '<pre class="prebox" aria-label="Review summary">' + esc(md) + '</pre></section>';
  }

  /* ---------------- explain this change (the one model call) ---------------- */

  function explainedHtml(ex) {
    return '<div class="explained" role="region" aria-label="AI explanation"><b>✨ What this change does</b><p style="margin:0">' + esc(ex.summary) + '</p>' +
      (ex.risks.length ? '<div><p class="lab">Could go wrong</p><ul>' + ex.risks.map(function (r) { return '<li>' + esc(r.risk) + (r.line_hint ? ' <code>' + esc(r.line_hint) + '</code>' : '') + '</li>'; }).join('') + '</ul></div>' : '') +
      (ex.questions_for_author.length ? '<div><p class="lab">Ask the author</p><ul>' + ex.questions_for_author.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul></div>' : '') +
      (ex.tests_to_add.length ? '<div><p class="lab">Tests to add</p><ul>' + ex.tests_to_add.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul></div>' : '') +
      '<p class="small muted" style="margin:0">Written by AI from this hunk alone - it has not seen the rest of the code. Check it against the diff.</p></div>';
  }
  function explainComment(ex, path) {
    var o = ['**About this change in ' + C.mdCode(path) + '**', '', C.mdText(ex.summary)];
    if (ex.questions_for_author.length) { o.push('', 'Questions:'); ex.questions_for_author.forEach(function (q) { o.push('- ' + C.mdText(q)); }); }
    if (ex.tests_to_add.length) { o.push('', 'Tests I would like to see:'); ex.tests_to_add.forEach(function (q) { o.push('- ' + C.mdText(q)); }); }
    return o.join('\n') + '\n';
  }
  function openExplain(fi, hk) {
    var f = state.a.files[fi];
    if (!f) return;
    var hi = hk === 'all' ? null : +hk;
    var p = C.explainPayload(f, hi);
    if (p.error) { toast(p.error, 4200); return; }
    var body = { path: p.path, lines: p.lines };
    var shown = JSON.stringify(body, null, 2);
    var key = fi + ':' + (hi === null ? 'all' : hi);
    var lead = '<p>AI reads ' + (hi === null ? 'this file’s changes' : 'this one hunk') + ' and tells you what it does, what could go wrong, what to ask the author and what tests would catch it.</p>' +
      '<div class="warnbox" role="note"><span aria-hidden="true">⚠️</span><div><b>This sends the code below to an AI provider (Anthropic).</b> ' + esc(plural(p.lines.length, 'diff line')) + ' of <code>' + esc(p.path) + '</code> - exactly what is shown, and nothing else from the diff or your repo. Nothing is stored. Don’t send code you are not allowed to share.</div></div>';
    var payload = '<p class="small muted" style="margin:12px 0 6px"><b>Exactly what would be sent:</b></p><pre class="sent" aria-label="What would be sent">' + esc(shown) + '</pre>';
    if (!signedIn()) {
      sheet('<h2>✨ Explain this change</h2>' + lead + payload +
        '<p class="small muted" style="margin-top:12px">It uses about a cent of AI credit, so it needs a free account (it comes with $2). The plan, the checks, the split and the report stay free, with no account.</p>' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="signin-explain" data-f="' + fi + '" data-h="' + esc(String(hk)) + '">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button></div>');
      return;
    }
    sheet('<h2>✨ Explain this change</h2><div id="exLead">' + lead + '</div><details open id="sentBox"><summary class="row" style="min-height:44px;cursor:pointer"><b id="sentLabel">Exactly what will be sent</b></summary><pre class="sent">' + esc(shown) + '</pre></details>' +
      '<div id="exErr"></div><div id="exActs"><label class="confirm"><input type="checkbox" id="exOk"> I understand this sends this code to an AI provider.</label>' +
      '<div class="btns" style="margin-top:10px"><button class="btn" type="button" id="exSend" disabled>Send and explain</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div><p class="small muted" style="margin-top:8px">About a cent of AI credit.</p></div><div id="exOut"></div>', function (root) {
      var ok = $('#exOk', root), send = $('#exSend', root);
      ok.addEventListener('change', function () { send.disabled = !ok.checked; });
      send.addEventListener('click', function () {
        if (!ok.checked) return;
        send.disabled = true; send.textContent = 'Explaining…';
        api('POST', 'api/explain', body).then(function (r) {
          var ex = C.cleanExplanation(r.explanation);
          if (!ex) throw Object.assign(new Error('That answer had nothing usable in it. Try again.'), { status: 422 });
          state.explained[key] = ex;
          $('#exActs', root).hidden = true; $('#exLead', root).hidden = true;
          $('#sentBox', root).open = false; $('#sentLabel', root).textContent = 'What was sent';
          $('#exOut', root).innerHTML = explainedHtml(ex) + '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="copyexplain" data-k="' + esc(key) + '">Copy as a review comment</button><button class="btn ghost" type="button" data-act="closesheet">Done</button></div>';
          var slot = hi === null ? null : $('#ex-' + fi + '-' + hi);
          if (slot) slot.innerHTML = explainedHtml(ex);
          loadMe();
        }).catch(function (err) { send.disabled = !ok.checked; send.textContent = 'Send and explain'; meteredError(err, $('#exErr', root), function () { openExplain(fi, hk); }); });
      });
    });
  }

  /* ---------------- sheets and the account ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false;
    document.body.classList.add('sheet-open');
    s.scrollTop = 0;
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2');
    if (f) f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
  });
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });
  function openFileView(fi) {
    var f = state.a.files[fi];
    if (!f) return;
    sheet('<h2 class="mono" style="font-size:1.05rem">' + esc(f.path) + '</h2><div class="row" style="margin-bottom:10px">' + pill(f.risk) + '<span class="small muted">' + esc([statusWord(f), plural(f.lines, 'line')].filter(Boolean).join(' · ')) + '</span></div><div class="fbody" style="border:0;padding:0">' + fileBody(f) + '</div>');
  }

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var FREE_LINE = 'Nothing in Triage needs an account except "Explain this change", the one AI feature - a free account comes with $2 of AI credit, and one account works across every app on this site.';
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Explaining a change with AI costs about a cent. The plan, the checks, the split and the report are free and need no account.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); });
        });
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
  function checkout(path, body) {
    body.returnTo = BASE;
    api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); });
  }
  function openCredit(data) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The plan, the checks, the split and the report keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- one click listener ---------------- */

  function fname(ext) { return 'triage-' + today() + ext; }
  function redrawFile(i) {
    var li = $('#f' + i);
    var f = state.a.files[i];
    if (!li || !f) return drawTab();
    var tmp = document.createElement('ul');
    tmp.innerHTML = fileRow(f);
    li.replaceWith(tmp.firstChild);
  }
  function refreshProgress() { var p = $('#progress'); if (p) { var t = document.createElement('div'); t.innerHTML = progressHtml(); p.replaceWith(t.firstChild); } }
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-tick') || !state.a) return;
    var f = state.a.files[+t.getAttribute('data-tick')];
    if (!f) return;
    setDone(f.path, t.checked);
    var li = t.closest('.fitem');
    if (li) li.classList.toggle('done', t.checked);
    refreshProgress();
  });
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    var i = +t.getAttribute('data-i');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); go('start'); break;
      case 'example': history.pushState(null, '', BASE + '#example'); openDemo(true); break;
      case 'gotriage': go('triage'); break;
      case 'tab': e.preventDefault(); go(t.getAttribute('data-tab')); break;
      case 'cshell': state.cmd.shell = t.getAttribute('data-v'); keep(K_CMD, state.cmd); draw(); break;
      case 'copycmd': { var r = cmdFor(); if (r.command) copy(r.command, 'Command copied - run it in your repo'); else toast(r.error); break; }
      case 'togglepaste': state.showPaste = !state.showPaste; draw(); if (state.showPaste) { var ta0 = $('#pasteDiff'); if (ta0) ta0.focus(); } break;
      case 'triagepaste': { var ta = $('#pasteDiff'); if (ta && ta.value.trim()) takeText(ta.value, 'paste', 'Pasted diff', $('#loadState')); else toast('Paste a diff first.'); break; }
      case 'file': state.open[i] = !state.open[i]; redrawFile(i); { var again = $('#f' + i + ' .fopen'); if (again) again.focus({ preventScroll: true }); } break;
      case 'fileview': openFileView(i); break;
      case 'markdone': { var f = state.a.files[i]; setDone(f.path, !state.done[f.path]); if (state.done[f.path]) state.open[i] = false; if ($('#sheet').hidden) { redrawFile(i); refreshProgress(); } else { closeSheet(); drawTab(); } if (state.done[f.path]) toast('Marked as reviewed'); break; }
      case 'tickgroup': {
        var g = state.a.skim.filter(function (x) { return x.key === t.getAttribute('data-g'); })[0];
        if (!g) break;
        var all = g.files.every(function (k) { return state.done[state.a.files[k].path]; });
        g.files.forEach(function (k) { var p = state.a.files[k].path; if (all) delete state.done[p]; else state.done[p] = 1; });
        saveTicks(); drawTab(); toast(all ? 'Unticked' : 'Ticked - the check passed');
        break;
      }
      case 'clearticks': state.done = {}; saveTicks(); drawTab(); toast('Ticks cleared from this browser'); break;
      case 'copycheck': { var gg = state.a.skim.filter(function (x) { return x.key === t.getAttribute('data-g'); })[0]; if (gg) copy(C.skimCheck(gg.key, gg.files.map(function (k) { return state.a.files[k]; }), refs(), state.a.renames).cmd.join('\n'), 'Check copied'); break; }
      case 'copysplit': copy((state.split || splitData()).commands.join('\n'), 'Commands copied'); break;
      case 'copycomment': copy((state.split || splitData()).comment, 'Comment copied - paste it on the PR'); break;
      case 'copyrules': copy(C.AGENT_RULES, 'Rules copied'); break;
      case 'dlrules': download('reviewable-prs.md', 'text/markdown', C.AGENT_RULES); break;
      case 'copymd': copy(C.toMarkdown(state.a, state.done, refs()), 'Markdown copied'); break;
      case 'md': download(fname('.md'), 'text/markdown', C.toMarkdown(state.a, state.done, refs())); break;
      case 'json': download(fname('.json'), 'application/json', C.toJson(state.a, state.done, refs())); break;
      case 'explain': openExplain(+t.getAttribute('data-f'), t.getAttribute('data-h')); break;
      case 'signin-explain': { var fi = +t.getAttribute('data-f'), hk = t.getAttribute('data-h'); openAccount('Explaining a change uses about a cent of AI credit; a free account comes with $2.', function () { openExplain(fi, hk); }); break; }
      case 'copyexplain': { var k = t.getAttribute('data-k'), ex = state.explained[k]; if (ex) copy(explainComment(ex, state.a.files[+k.split(':')[0]].path), 'Copied as a review comment'); break; }
      default: break;
    }
  });

  /* ---------------- start ---------------- */

  (function () { var c = recall(K_CMD); if (c && typeof c === 'object') { ['base', 'head'].forEach(function (k) { if (typeof c[k] === 'string') state.cmd[k] = c[k].slice(0, 120); }); if (c.shell === 'ps' || c.shell === 'sh') state.cmd.shell = c.shell; } }());
  if (/Windows/.test(navigator.userAgent || '') && !recall(K_CMD)) state.cmd.shell = 'ps';
  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });
  drawTop();
  route();
  loadMe().then(function () {
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
  });
}());
