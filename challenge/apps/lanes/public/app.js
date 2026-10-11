/* Lanes - the page. One file, no build step.
 *
 * DIFFS ARE READ HERE AND NOWHERE ELSE. The gather file (or a pasted diff)
 * is parsed by LanesCore in this browser; the check, the plan and the
 * briefs are worked out here; nothing about a diff is ever sent. The one
 * request that carries anything about the repo is "Split this into lanes
 * for me", and it sends LanesCore.splitPayload - tasks and file paths only -
 * shown to the person in full before it is sent.
 *
 * Every string that came from a repo (a path, a branch name, a commit
 * message, a diff line) or from the server is escaped before it is drawn,
 * and no handler is written into markup: clicks are routed by data-act
 * attributes from one listener (the lab's CSP allows script from this
 * origin only).
 */
(function () {
  'use strict';

  var C = window.LanesCore;
  var D = window.LanesDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_PLAN = 'lanes-plan-v1';
  var K_CMD = 'lanes-cmd-v1';
  var TABS = [['verdict', '🚦', 'Verdict', 'Verdict'], ['collisions', '💥', 'Files', 'Collisions'], ['shared', '🔒', 'Shared', 'Shared state'], ['dupes', '👯', 'Twins', 'Duplicate work'], ['order', '🧭', 'Order', 'Merge order']];
  var esc = C.esc;
  var plural = C.plural;
  var fmtInt = C.fmtInt;
  var LANE_COLORS = 8;

  var state = {
    me: null,
    view: 'start',      // start | gather | dash | plan
    tab: 'verdict',
    source: null,       // demo | file | paste
    sourceName: '',
    parsed: null,       // the parsed gather file - in memory only
    check: null,        // LanesCore.analyse(parsed)
    open: {},           // collision paths opened
    filter: { conflicts: false, a: -1, b: -1, branch: -1 },
    files: [],          // the repo's paths, for planning
    filesFrom: '',      // 'lanes.txt' | 'pasted list' | 'the example' | 'saved'
    tree: null,
    plan: null,         // LanesCore.cleanPlan shape
    planDemo: false,
    planCk: null,
    picker: null,       // {li, kind, dir}
    pastes: [{ name: '', text: '' }, { name: '', text: '' }],
    cmd: { base: 'main', mode: 'pattern', pattern: 'agent/*', branches: '', shell: 'sh' },
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
  function lc(i) { return 'style="--lc:var(--l' + (i % LANE_COLORS) + ')"'; }
  /** Text with `code` spans, escaped. */
  function rich(s) { return esc(s).replace(/`([^`]{1,300})`/g, '<code>$1</code>'); }
  function bname(i) { var b = state.check && state.check.branches[i]; return b ? b.name : '?'; }
  function bchip(i) { return '<span class="chip" ' + lc(i) + '><span class="dot" aria-hidden="true"></span>' + esc(bname(i)) + '</span>'; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Planning lanes by hand stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function meteredError(err, box, retry) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount('Splitting the work with AI uses a cent or two of AI credit, so it needs a free account (it comes with $2).', retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }

  /* ---------------- routing ---------------- */

  function isTab(h) { return TABS.some(function (t) { return t[0] === h; }); }
  function go(where) {
    if (isTab(where)) { state.view = 'dash'; state.tab = where; }
    else if (where === 'check') state.view = 'gather';
    else if (where === 'plan') { state.view = 'plan'; ensurePlan(); }
    else state.view = 'start';
    history.pushState(null, '', BASE + '#' + (where === 'start' ? 'start' : where));
    draw(); scrollTo(0, 0);
  }
  function route() {
    var h = (location.hash || '').replace(/^#/, '');
    if (h === 'example') return openDemo(true);
    if (h === 'plan-example') return openPlanDemo(true);
    if (h === 'check') { state.view = 'gather'; return draw(); }
    if (h === 'plan') { state.view = 'plan'; ensurePlan(); return draw(); }
    if (isTab(h)) {
      if (!state.check) return openDemo(true, h);
      state.view = 'dash'; state.tab = h; return draw();
    }
    state.view = 'start'; draw();
  }
  window.addEventListener('popstate', route);

  function draw() {
    closeSheet(true);
    var main = $('#main');
    document.body.classList.toggle('has-tabs', state.view === 'dash');
    if (state.view === 'gather') { main.innerHTML = gatherHtml(); wireGather(); return; }
    if (state.view === 'plan') { main.innerHTML = planHtml(); wirePlan(); return; }
    if (state.view !== 'dash' || !state.check) { main.innerHTML = startHtml(); return; }
    var ck = state.check;
    var badges = { collisions: ck.collisions.filter(function (c) { return c.conflict; }).length, shared: ck.shared.filter(function (s) { return s.severity === 'clash'; }).length, dupes: ck.dupes.symbols.length + ck.dupes.files.length };
    var html = stripHtml();
    html += '<nav class="tabbar dk-tabbar" aria-label="Check"><div class="tabbar-inner"><a class="rail-brand" href="./#start" data-act="home"><span aria-hidden="true">🚦</span>Lanes</a>' + TABS.map(function (t) {
      var n = badges[t[0]];
      return '<a class="tab' + (t[0] === state.tab ? ' on' : '') + '" href="#' + t[0] + '" data-act="tab" data-tab="' + t[0] + '"' + (t[0] === state.tab ? ' aria-current="page"' : '') + '><span class="i" aria-hidden="true">' + t[1] + '</span><span class="short">' + t[2] + '</span><span class="long">' + t[3] + '</span>' + (n ? '<span class="tab-badge" aria-label="' + n + ' to look at">' + n + '</span>' : '') + '</a>';
    }).join('') + '</div></nav>';
    html += '<div id="tab"></div>' + footer();
    main.innerHTML = html;
    drawTab();
  }
  function drawTab() {
    var el = $('#tab');
    if (!el) return;
    if (state.tab === 'collisions') el.innerHTML = collisionsHtml();
    else if (state.tab === 'shared') el.innerHTML = sharedHtml();
    else if (state.tab === 'dupes') el.innerHTML = dupesHtml();
    else if (state.tab === 'order') el.innerHTML = orderHtml();
    else el.innerHTML = verdictHtml();
  }

  function footer() {
    return '<footer class="foot"><p>🔒 Diffs and file lists are read on this device and never uploaded.</p><p>Findings are worked out from the diffs alone: they say what will collide, not whether the code is right.</p></footer>';
  }

  /* ---------------- first run ---------------- */

  function savedPlan() {
    var s = recall(K_PLAN);
    if (!s || typeof s !== 'object') return null;
    var p = C.cleanPlan(s.plan);
    if (!p || !p.lanes.length) return null;
    var files = (Array.isArray(s.files) ? s.files : []).map(C.cleanPath).filter(Boolean).slice(0, C.LIMITS.files);
    return { plan: p, files: files, savedAt: Number(s.savedAt) || 0 };
  }
  function startHtml() {
    var last = savedPlan();
    var html = '<section class="hero"><div class="kicker"><span aria-hidden="true">🚦</span>For teams running coding agents in parallel</div>' +
      '<h1>Run coding agents in parallel without them stepping on each other.</h1>' +
      '<p>Two agents rewriting the same file. Both bumping the lockfile. Two migrations numbered 0042. The same helper written twice. Lanes checks your branches before you merge - and plans lanes so it does not happen next time.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="example">See an example</button><button class="btn big ghost" type="button" data-act="gocheck">Check my branches</button><button class="btn big ghost" type="button" data-act="goplan">Plan the lanes</button></div>' +
      '<div class="trust"><span class="ico" aria-hidden="true">🔒</span><span><b>Read on this device. Nothing is uploaded.</b> Diffs contain your code, so Lanes reads them in this browser and never sends them anywhere. No account needed.</span></div></section>';
    html += '<div class="modes">' +
      '<section class="card mode"><span class="ico" aria-hidden="true">🔍</span><h2>Check the branches</h2><p class="muted">Agents already running? Copy one command, run it in your repo, drop in the file it writes. Before you merge, see:</p>' +
      '<ul><li>Files changed on two branches - and whether the lines collide</li><li>Lockfiles, migrations, versions and other shared state</li><li>The same helper written twice</li><li>The merge order that needs the fewest rebases, with the commands</li></ul>' +
      '<div class="btns"><button class="btn" type="button" data-act="gocheck">Check my branches</button><button class="btn ghost" type="button" data-act="example">See the example check</button></div></section>' +
      '<section class="card mode"><span class="ico" aria-hidden="true">🛣️</span><h2>Plan the lanes</h2><p class="muted">About to start? Give every agent its own lane before anyone writes a line:</p>' +
      '<ul><li>Each task and the paths it owns, picked from your real file tree</li><li>Overlaps flagged before they become conflicts</li><li>Rules for shared files, and migration numbers reserved per lane</li><li>A brief per agent, with its <code>git worktree</code> command</li></ul>' +
      '<div class="btns"><button class="btn" type="button" data-act="goplan">Plan the lanes</button><button class="btn ghost" type="button" data-act="planexample">See an example plan</button></div></section></div>';
    if (last) {
      html += '<section class="card"><div class="sec-head"><h2>Your last plan</h2><span class="small muted">saved on this device</span></div>' +
        '<p>' + esc(plural(last.plan.lanes.length, 'lane')) + ': ' + last.plan.lanes.map(function (l) { return '<code>' + esc(l.name) + '</code>'; }).join(' ') + (last.files.length ? ' · ' + esc(plural(last.files.length, 'file')) + ' in the tree' : '') + '</p>' +
        '<div class="btns"><button class="btn" type="button" data-act="openplan">Open it</button><button class="btn ghost" type="button" data-act="clearplan">Clear it</button></div><p class="small muted" style="margin-top:8px">Tasks, lanes and file paths only - never a diff.</p></section>';
    }
    html += '<section class="card"><h2>What it catches</h2><ul class="catches">' +
      ['💥 The same lines changed twice', '🤏 Touching lines (git calls those conflicts too)', '🔒 Lockfiles rewritten on two branches', '🗄️ Two migrations with one number', '🏷️ Two version bumps', '📦 Dependencies added on both sides', '⚙️ Generated files edited by hand', '📜 CLAUDE.md / AGENTS.md edited by several agents', '👯 The same helper written twice', '🧭 The merge order with fewest rebases'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>' + footer();
    return html;
  }

  /* ---------------- the example ---------------- */

  function openDemo(replace, tab) {
    var parsed = C.parseInput(D.gather());
    setCheck(parsed, 'demo', 'the example');
    state.files = parsed.files; state.filesFrom = 'the example'; state.tree = null;
    state.view = 'dash'; state.tab = tab || 'verdict';
    if (replace) history.replaceState(null, '', BASE + '#' + state.tab); else history.pushState(null, '', BASE + '#' + state.tab);
    draw(); scrollTo(0, 0);
  }
  function setCheck(parsed, source, name) {
    state.parsed = parsed;
    state.check = C.analyse(parsed);
    state.source = source; state.sourceName = name;
    state.open = {};
    state.filter = { conflicts: false, a: -1, b: -1, branch: -1 };
    var first = state.check.collisions.filter(function (c) { return c.conflict; })[0];
    if (first) state.open[first.path] = true;
  }
  function openPlanDemo(replace) {
    state.plan = C.cleanPlan(D.plan());
    state.files = D.files(); state.filesFrom = 'the example'; state.tree = null;
    state.planDemo = true;
    state.view = 'plan';
    if (replace) history.replaceState(null, '', BASE + '#plan'); else history.pushState(null, '', BASE + '#plan');
    draw(); scrollTo(0, 0);
  }

  /* ---------------- gather: one command, one file ---------------- */

  function cmdFor(shell) {
    var c = state.cmd;
    return C.gatherCommand({ base: c.base, mode: c.mode, pattern: c.pattern, branches: c.branches, shell: shell || c.shell });
  }
  function gatherHtml() {
    var c = state.cmd, cmd = cmdFor();
    var html = '<section class="card"><button class="link-btn" type="button" data-act="home">← Back</button><h1 style="margin:2px 0 8px">Check your branches</h1>' +
      '<p class="muted lede">Two steps: run one command in your repo, then drop the file it writes here. Lanes reads every branch’s changes against your base branch and shows what will collide before you merge.</p>' +
      '<div class="note" role="note"><b>🔒 Read on this device. Nothing is uploaded.</b> <span class="muted">Diffs contain your code. The file is read here, in this browser, and kept only while this tab is open.</span></div></section>';
    html += '<section class="card stepcard"><h2><span class="k">1</span>Copy one command</h2><p class="muted">Run it in your repo’s folder. It only reads git, and writes one text file: <code>lanes.txt</code>.</p>' +
      '<div class="form-row">' +
      '<label class="field"><span>Base branch</span><input class="input code" id="cBase" value="' + esc(c.base) + '" autocomplete="off" spellcheck="false" maxlength="120"></label>' +
      '<div class="field"><span>Which branches</span><div class="seg" role="radiogroup" aria-label="Which branches"><button class="segb" type="button" data-act="cmode" data-v="pattern" role="radio" aria-pressed="' + (c.mode === 'pattern') + '" aria-checked="' + (c.mode === 'pattern') + '">Matching a pattern</button><button class="segb" type="button" data-act="cmode" data-v="list" role="radio" aria-pressed="' + (c.mode === 'list') + '" aria-checked="' + (c.mode === 'list') + '">These names</button></div></div>' +
      (c.mode === 'list'
        ? '<label class="field"><span>Branch names (spaces between)</span><input class="input code" id="cList" value="' + esc(c.branches) + '" placeholder="agent/auth agent/billing" autocomplete="off" spellcheck="false" maxlength="2000"></label>'
        : '<label class="field"><span>Pattern</span><input class="input code" id="cPat" value="' + esc(c.pattern) + '" placeholder="agent/*" autocomplete="off" spellcheck="false" maxlength="120"></label>') +
      '</div>' +
      '<div class="row" style="margin:6px 0 10px"><span class="small muted">Shell:</span><div class="seg" role="radiogroup" aria-label="Shell"><button class="segb" type="button" data-act="cshell" data-v="sh" role="radio" aria-pressed="' + (c.shell === 'sh') + '" aria-checked="' + (c.shell === 'sh') + '">macOS / Linux / Git Bash</button><button class="segb" type="button" data-act="cshell" data-v="ps" role="radio" aria-pressed="' + (c.shell === 'ps') + '" aria-checked="' + (c.shell === 'ps') + '">Windows PowerShell</button></div></div>' +
      '<div class="cmd"><pre id="cmdText" aria-label="The command">' + esc(cmd.command || cmd.error) + '</pre><button class="btn ghost" type="button" data-act="copycmd0">Copy</button></div>' +
      '<p class="err" id="cmdErr" role="alert"' + (cmd.error ? '' : ' hidden') + '>' + esc(cmd.error || '') + '</p>' +
      '<details class="more"><summary>What it does, line by line</summary><ol class="whatitdoes">' +
      '<li><code>git ls-files</code>: the list of files in your repo (paths only), for planning and for knowing what is shared.</li>' +
      '<li>For each branch ' + (c.mode === 'list' ? 'you named' : 'matching the pattern (local, or <code>origin/…</code> if you write that)') + ': <code>git log ' + esc(c.base) + '..branch</code> - each commit’s short id, author, date and subject.</li>' +
      '<li>Then <code>git diff --unified=0 ' + esc(c.base) + '...branch</code>: only the changed lines and their line numbers, against the point the branch started from.</li>' +
      '<li>Everything goes into <code>lanes.txt</code>, between <code>#lanes</code> marker lines.</li></ol>' +
      '<p class="small muted">No network, nothing downloaded, nothing run from anywhere else, and nothing in your repo changes. Remote branches: run <code>git fetch</code> first and use a pattern like <code>origin/agent/*</code>.</p></details></section>';
    html += '<section class="card stepcard"><h2><span class="k">2</span>Drop <code>lanes.txt</code> here</h2>' +
      '<div class="drop" id="drop"><span class="ico" aria-hidden="true">📄</span><b>Drop the file here</b><span class="small muted">or choose it - it is read on this device</span>' +
      '<div class="btns" style="justify-content:center"><label class="btn filepick">Choose lanes.txt<input type="file" id="pickFile" accept=".txt,.diff,.patch,text/plain" aria-label="Choose lanes.txt"></label>' +
      '<button class="btn ghost" type="button" data-act="togglepaste">' + (state.showPaste ? 'Hide the paste box' : 'Paste it instead') + '</button></div></div>' +
      (state.showPaste ? '<label class="field" style="margin-top:12px"><span>Paste the contents of lanes.txt</span><textarea class="input code" id="pasteAll" rows="8" spellcheck="false" placeholder="#lanes v1 base=main"></textarea></label><div class="btns" style="margin-top:10px"><button class="btn" type="button" data-act="checkpaste">Check it</button></div>' : '') +
      '<div id="loadState" aria-live="polite"></div></section>';
    html += '<details class="card"><summary class="row" style="min-height:44px;cursor:pointer"><b>No terminal handy? Paste one diff per branch</b></summary>' +
      '<p class="muted" style="margin-top:8px">Any unified diff works - <code>git diff main...agent/x</code>, a PR’s <code>.diff</code> download, or a patch. With context lines it still works; <code>--unified=0</code> is just smaller.</p><div class="pastes">' +
      state.pastes.map(function (p, i) {
        return '<div class="paste"><label class="field"><span>Branch name</span><input class="input code" data-paste-name="' + i + '" value="' + esc(p.name) + '" placeholder="agent/branch-' + (i + 1) + '" maxlength="120" autocomplete="off" spellcheck="false"></label>' +
          '<label class="field"><span>Its diff</span><textarea class="input code" data-paste-text="' + i + '" rows="6" spellcheck="false" placeholder="diff --git a/src/app.ts b/src/app.ts">' + esc(p.text) + '</textarea></label></div>';
      }).join('') + '</div><div class="btns" style="margin-top:12px"><button class="btn ghost" type="button" data-act="addpaste">+ Another branch</button><button class="btn" type="button" data-act="checkpastes">Check these branches</button></div><div id="pasteState" aria-live="polite"></div></details>';
    return html + footer();
  }
  function wireGather() {
    var upd = function () {
      var b = $('#cBase'), p = $('#cPat'), l = $('#cList');
      if (b) state.cmd.base = b.value.trim();
      if (p) state.cmd.pattern = p.value.trim();
      if (l) state.cmd.branches = l.value.trim();
      var r = cmdFor();
      $('#cmdText').textContent = r.command || '';
      var e = $('#cmdErr'); e.hidden = !r.error; e.textContent = r.error || '';
      if (!r.error) keep(K_CMD, state.cmd);
    };
    ['#cBase', '#cPat', '#cList'].forEach(function (s) { var el = $(s); if (el) el.addEventListener('input', upd); });
    var drop = $('#drop');
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(f, '#loadState'); });
    $('#pickFile').addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) readFile(f, '#loadState'); e.target.value = ''; });
    $$('[data-paste-name]').forEach(function (el) { el.addEventListener('input', function () { state.pastes[+el.getAttribute('data-paste-name')].name = el.value; }); });
    $$('[data-paste-text]').forEach(function (el) { el.addEventListener('input', function () { state.pastes[+el.getAttribute('data-paste-text')].text = el.value; }); });
  }
  function readFile(file, where, then) {
    var box = $(where);
    if (file.size > C.LIMITS.bytes) { box.innerHTML = '<p class="err" role="alert">That file is ' + Math.round(file.size / 1048576) + ' MB; Lanes reads up to ' + Math.round(C.LIMITS.bytes / 1048576) + ' MB. Check fewer branches at once.</p>'; return; }
    box.innerHTML = '<p class="muted">Reading ' + esc(C.clean(file.name, 80)) + ' (' + (file.size / 1048576).toFixed(1) + ' MB) on this device…</p>';
    file.text().then(function (text) { (then || takeText)(text, C.clean(file.name, 80), box); }, function () { box.innerHTML = '<p class="err" role="alert">That file could not be read.</p>'; });
  }
  function takeText(text, name, box) {
    var r;
    try { r = C.parseInput(text); } catch (e) { box.innerHTML = '<p class="err" role="alert">That file could not be read as text.</p>'; return; }
    if (r.kind === 'empty') { box.innerHTML = '<p class="err" role="alert">That file is empty.</p>'; return; }
    if (r.kind === 'files') {
      box.innerHTML = '<div class="note"><p><b>That is a list of ' + esc(plural(r.files.length, 'file')) + ', not a gather file.</b> To check branches, run the command above. To plan lanes, a file list is all you need.</p><button class="btn small" type="button" data-act="planwithfiles">Plan lanes with these files</button></div>';
      state.pendingFiles = r.files;
      return;
    }
    if (r.kind === 'diff') {
      var slot = state.pastes.filter(function (p) { return !p.text.trim(); })[0];
      if (!slot) { slot = { name: '', text: '' }; state.pastes.push(slot); }
      slot.text = text.length > 4e6 ? '' : text;
      box.innerHTML = '<div class="note"><p><b>That is one diff (' + esc(plural(r.diff.files.length, 'file')) + ').</b> Give its branch a name below, add the others, and check them together.</p></div>';
      var d = $('details.card'); if (d) { d.open = true; }
      if (slot.text) { var t = $('[data-paste-text="' + state.pastes.indexOf(slot) + '"]'); if (t) t.value = slot.text; else draw(); }
      return;
    }
    if (!r.branches.length) {
      box.innerHTML = '<div class="note"><p class="err" style="margin-top:0">No branches in that file.</p><p class="small muted">The pattern matched nothing. Try <code>git branch --list \'agent/*\'</code> to see what it would pick, or name the branches instead.' + (r.files.length ? ' Its ' + esc(plural(r.files.length, 'file')) + ' can still be used to plan lanes.' : '') + '</p>' + (r.files.length ? '<button class="btn small" type="button" data-act="planwithfiles">Plan lanes with these files</button>' : '') + '</div>';
      state.pendingFiles = r.files;
      return;
    }
    setCheck(r, 'file', name || 'lanes.txt');
    if (r.files.length) { state.files = r.files; state.filesFrom = name || 'lanes.txt'; state.tree = null; }
    go('verdict');
  }
  function checkPastes() {
    var box = $('#pasteState');
    var used = state.pastes.filter(function (p) { return p.text.trim(); });
    if (!used.length) { box.innerHTML = '<p class="err" role="alert">Paste at least one branch’s diff.</p>'; return; }
    var names = [];
    var branches = used.slice(0, C.LIMITS.pasteBranches).map(function (p, i) {
      var name = C.cleanBranch(p.name) || 'branch-' + (i + 1);
      while (names.indexOf(name) !== -1) name += '-2';
      names.push(name);
      return C.branchFromDiff(name, p.text);
    });
    var empty = branches.filter(function (b) { return !b.changes.length; });
    if (empty.length === branches.length) { box.innerHTML = '<p class="err" role="alert">No file changes found in ' + (branches.length === 1 ? 'that' : 'those') + '. A diff starts with lines like <code>diff --git a/… b/…</code> or <code>--- a/…</code>.</p>'; return; }
    var parsed = { kind: 'gather', base: state.cmd.base || 'main', files: state.files || [], branches: branches, warnings: empty.length ? [plural(empty.length, 'pasted diff') + ' had no file changes.'] : [] };
    setCheck(parsed, 'paste', 'pasted diffs');
    go('verdict');
  }

  /* ---------------- the check ---------------- */

  function stripHtml() {
    var ck = state.check, p = state.parsed;
    var what = state.source === 'demo' ? '<b>Example:</b> shopfront, a made-up web shop · ' : '<b>' + esc(state.sourceName) + '</b> · ';
    var html = '<div class="strip"><div><p>' + what + esc(plural(ck.branches.length, 'branch', 'branches')) + ' against <code>' + esc(ck.base) + '</code>' + (ck.fileCount ? ' · ' + esc(plural(ck.fileCount, 'file')) + ' in the tree' : '') + '</p>' +
      '<p class="sub small">Read on this device. Nothing was uploaded.</p></div><div class="btns">' +
      (state.source === 'demo' ? '<button class="btn small light" type="button" data-act="gocheck">Check my branches</button>' : '<button class="btn small ghost" type="button" data-act="gocheck">Load another</button>') +
      (state.files.length ? '<button class="btn small ghost" type="button" data-act="planfromcheck">Plan lanes for this repo</button>' : '') + '</div></div>';
    if (p && p.warnings && p.warnings.length) html += '<div class="note" role="note" style="margin-bottom:14px"><b>Read with notes:</b><ul style="margin:6px 0 0;padding-left:20px">' + p.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>';
    return html;
  }
  var TONES = { collide: ['tone-collide', '🔴', 'Collisions ahead'], check: ['tone-check', '🟡', 'Merges, with things to check'], clean: ['tone-clean', '🟢', 'Clear to merge'], none: ['tone-none', '⚪', 'Nothing to check'] };
  function stateLabel(b) {
    if (b.state === 'collides') return '<span class="pill sev-conflict">✕ Collides with ' + esc(b.collidesWith.map(bname).join(', ')) + '</span>';
    if (b.state === 'check') return '<span class="pill sev-touch">! Merges clean - see notes</span>';
    if (b.state === 'empty') return '<span class="pill sev-note">No changes yet</span>';
    return '<span class="pill sev-clean">✓ Merges clean</span>';
  }
  function shortNames() {
    var names = state.check.branches.map(function (b) { return b.name; });
    var pre = names.length > 1 ? names.reduce(function (a, n) { var i = 0; while (i < a.length && a[i] === n[i]) i++; return a.slice(0, i); }) : '';
    pre = pre.slice(0, pre.lastIndexOf('/') + 1);
    return { pre: pre, names: names.map(function (n) { return n.slice(pre.length) || n; }) };
  }
  function verdictHtml() {
    var ck = state.check, v = ck.verdict, t = TONES[v.tone];
    var rebases = ck.order.steps.filter(function (s) { return s.action === 'rebase'; }).length;
    var html = '<section class="card verdict"><span class="tone ' + t[0] + '"><span aria-hidden="true">' + t[1] + '</span>' + t[2] + '</span>' +
      '<h1>' + esc(v.headline) + '</h1>' + (v.sub ? '<p class="vsub">' + esc(v.sub) + '</p>' : '') +
      '<div class="btns" style="margin-top:6px">' + (ck.branches.length ? '<button class="btn" type="button" data-act="tab" data-tab="order">Merge order: ' + esc(plural(ck.order.steps.length, 'step')) + (rebases ? ', ' + esc(plural(rebases, 'rebase')) : '') + ' →</button>' : '') +
      (v.conflictFiles ? '<button class="btn ghost" type="button" data-act="tab" data-tab="collisions">See the ' + esc(plural(v.conflictFiles, 'conflict')) + '</button>' : '') + '</div></section>';
    html += '<section class="card"><div class="sec-head"><h2>Branches</h2><span class="small muted">' + esc(plural(ck.branches.length, 'branch', 'branches')) + ' against ' + esc(ck.base) + '</span></div><div class="branches">' +
      ck.branches.map(function (b, i) {
        return '<div class="bcard" ' + lc(i) + '><div class="bname">' + esc(b.name) + '</div>' +
          '<div class="bmeta">' + (b.authors.length ? 'by ' + esc(b.authors.slice(0, 3).join(', ')) + ' · ' : '') + (b.commits ? esc(plural(b.commits, 'commit')) + ' · ' : '') + esc(plural(b.files, 'file')) + ' · <span class="num">+' + fmtInt(b.adds) + ' −' + fmtInt(b.dels) + '</span></div>' +
          stateLabel(b) +
          (b.subjects.length ? '<ul class="subj">' + b.subjects.slice(0, 2).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' : '') +
          (b.state === 'collides' ? '<button class="link-btn small" type="button" data-act="branchcols" data-i="' + i + '" style="justify-self:start">Its collisions →</button>' : '') + '</div>';
      }).join('') + '</div></section>';
    if (ck.branches.length > 1) {
      var sn = shortNames();
      html += '<section class="card"><div class="sec-head"><h2>Who collides with whom</h2><span class="small muted">files both branches change' + (sn.pre ? ' · names without <code>' + esc(sn.pre) + '</code>' : '') + '</span></div><div class="tbox"><table class="matrix"><thead><tr><th scope="col"><span class="vh">Branch</span></th>' +
        sn.names.map(function (n, j) { return '<th scope="col"><span class="row" style="justify-content:center;gap:6px;flex-wrap:nowrap"><span class="dot" ' + lc(j) + ' aria-hidden="true"></span>' + esc(n) + '</span></th>'; }).join('') + '</tr></thead><tbody>' +
        ck.matrix.map(function (row, i) {
          return '<tr><th scope="row" class="rowh"><span class="row" style="gap:6px;flex-wrap:nowrap"><span class="dot" ' + lc(i) + ' aria-hidden="true"></span>' + esc(sn.names[i]) + '</span></th>' + row.map(function (cell, j) {
            if (i === j) return '<td class="self"><span class="vh">same branch</span>—</td>';
            if (cell.conflicts) return '<td><button class="cell c-conflict" type="button" data-act="pair" data-a="' + i + '" data-b="' + j + '" aria-label="' + esc(bname(i) + ' and ' + bname(j) + ': ' + cell.conflicts + ' conflicting, ' + cell.shared + ' shared') + '">✕ ' + cell.conflicts + '<small>conflict' + (cell.conflicts === 1 ? '' : 's') + '</small></button></td>';
            if (cell.shared) return '<td><button class="cell c-clean" type="button" data-act="pair" data-a="' + i + '" data-b="' + j + '" aria-label="' + esc(bname(i) + ' and ' + bname(j) + ': ' + cell.shared + ' shared, merges clean') + '">✓ ' + cell.shared + '<small>clean</small></button></td>';
            return '<td><span class="cell c-none" aria-label="nothing shared">·</span></td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody></table></div>' +
        '<ul class="legend" style="margin-top:10px"><li><span class="pill sev-conflict">✕ n</span> files that will conflict</li><li><span class="pill sev-clean">✓ n</span> files both change on different lines</li><li>· nothing in common</li></ul>' +
        '<p class="small muted" style="margin:8px 0 0">Shared state (lockfiles, migration numbers, versions) is on the Shared tab and counts in the merge order too.</p></section>';
    }
    html += reportCard();
    return html;
  }
  function reportCard() {
    return '<section class="card"><div class="sec-head"><h2>Share the result</h2><span class="small muted">for a PR, an issue or the team chat</span></div>' +
      '<div class="btns"><button class="btn" type="button" data-act="copymd">Copy as Markdown</button><button class="btn ghost" type="button" data-act="md">Download .md</button><button class="btn ghost" type="button" data-act="json">Download .json</button></div>' +
      '<p class="small muted" style="margin:10px 0 0">Paths, line numbers, branch names and commands only - never a line of your code. Made on this device.</p></section>';
  }

  var SEV = { overlap: ['sev-conflict', '✕', 'Conflict'], 'both-added': ['sev-conflict', '✕', 'Conflict'], 'delete-modify': ['sev-conflict', '✕', 'Conflict'], binary: ['sev-conflict', '✕', 'Conflict'], 'rename-rename': ['sev-conflict', '✕', 'Conflict'], adjacent: ['sev-touch', '!', 'Touching lines'], rename: ['sev-clean', '✓', 'Rename'], clean: ['sev-clean', '✓', 'Clean'], same: ['sev-clean', '✓', 'Same change'] };
  function sevPill(kind, long) { var s = SEV[kind] || SEV.clean; return '<span class="pill ' + s[0] + '"><span aria-hidden="true">' + s[1] + '</span>' + esc(long ? C.PAIR_TEXT[kind] : s[2]) + '</span>'; }
  function collisionsHtml() {
    var ck = state.check, f = state.filter;
    var list = ck.collisions.filter(function (c) {
      if (f.conflicts && !c.conflict) return false;
      if (f.a !== -1) return c.pairs.some(function (p) { return (p.a === f.a && p.b === f.b) || (p.a === f.b && p.b === f.a); });
      if (f.branch !== -1) return c.branches.indexOf(f.branch) !== -1;
      return true;
    });
    var nConf = ck.collisions.filter(function (c) { return c.conflict; }).length;
    var html = '<section class="card"><div class="sec-head"><h2>Collisions</h2><span class="small muted">' + esc(plural(ck.collisions.length, 'file')) + ' changed on more than one branch · ' + esc(plural(nConf, 'conflict')) + '</span></div>' +
      '<p class="muted lede">For each file, every pair of branches that changes it, and whether git will be able to merge them: the same lines, lines that touch (git calls those conflicts too) or different lines. Line numbers are in <code>' + esc(ck.base) + '</code>’s version of the file.</p>' +
      '<div class="filters"><button class="segb" type="button" data-act="cfilter" data-v="all" aria-pressed="' + (!f.conflicts && f.a === -1 && f.branch === -1) + '">All ' + ck.collisions.length + '</button><button class="segb" type="button" data-act="cfilter" data-v="conflicts" aria-pressed="' + f.conflicts + '">Conflicts only ' + nConf + '</button>' +
      (f.a !== -1 ? '<button class="segb" type="button" data-act="cfilter" data-v="all" aria-pressed="true">' + esc(bname(f.a)) + ' × ' + esc(bname(f.b)) + ' ✕</button>' : '') +
      (f.branch !== -1 ? '<button class="segb" type="button" data-act="cfilter" data-v="all" aria-pressed="true">' + esc(bname(f.branch)) + ' ✕</button>' : '') + '</div>';
    if (!ck.collisions.length) return html + '<div class="empty-state"><div class="ico" aria-hidden="true">🟢</div><p><b>No file is changed on more than one branch.</b></p><p class="muted">Shared state can still clash - see the Shared tab.</p></div></section>';
    if (!list.length) return html + '<p class="muted">Nothing matches that filter.</p></section>';
    html += '<ul class="clist">' + list.map(function (c) {
      var open = Boolean(state.open[c.path]);
      var idx = ck.collisions.indexOf(c);
      return '<li class="citem"><button class="chead" type="button" data-act="col" data-i="' + idx + '" aria-expanded="' + open + '"><span class="cpath">' + esc(c.path) + '</span><span class="chev" aria-hidden="true">' + (open ? '▾' : '▸') + '</span>' +
        '<span class="cmeta">' + sevPill(c.worst) + c.branches.map(bchip).join('') + (c.kind ? '<span class="pill sev-note">' + esc(C.KIND_INFO[c.kind].title) + '</span>' : '') + '</span></button>' +
        (open ? '<div class="cbody">' + colBody(c) + '</div>' : '') + '</li>';
    }).join('') + '</ul>';
    return html + '<ul class="legend" style="margin-top:12px"><li><i class="del"></i>removed on that branch</li><li><i class="add"></i>added on that branch</li><li><i class="hit"></i>the change that collides</li></ul></section>';
  }
  function changeOf(bi, c) {
    var b = state.check.raw[bi];
    return b.changes.filter(function (x) { return (x.status === 'A' ? x.path : x.oldPath) === c.path; })[0];
  }
  function colBody(c) {
    var f = state.filter;
    var pairs = c.pairs.filter(function (p) { return f.a === -1 || (p.a === f.a && p.b === f.b) || (p.a === f.b && p.b === f.a); });
    return pairs.map(function (p) {
      var x = changeOf(p.a, c), y = changeOf(p.b, c);
      var spotsA = p.spots.map(function (s) { return s.a; }), spotsB = p.spots.map(function (s) { return s.b; });
      var where = p.spots.slice(0, 4).map(function (s) { return '<li><b>' + esc(bname(p.a)) + '</b> ' + esc(C.runLabel(s.a)) + ' · <b>' + esc(bname(p.b)) + '</b> ' + esc(C.runLabel(s.b)) + '</li>'; }).join('');
      return '<div class="pair"><div class="pair-head">' + bchip(p.a) + '<span aria-hidden="true">×</span>' + bchip(p.b) + sevPill(p.kind, true) + '</div>' +
        (where ? '<ul style="margin:0;padding-left:20px" class="small">' + where + (p.spots.length > 4 ? '<li class="muted">and ' + (p.spots.length - 4) + ' more</li>' : '') + '</ul>' : '') +
        '<div class="sides">' + sideHtml(p.a, x, spotsA, c) + sideHtml(p.b, y, spotsB, c) + '</div></div>';
    }).join('');
  }
  function sideHtml(bi, ch, spots, c) {
    if (!ch) return '';
    var st = { A: 'new file', D: 'deleted', R: 'renamed to ' + ch.path, M: '' }[ch.status] || '';
    var head = '<div class="side-head"><span class="row" style="gap:6px"><span class="dot" ' + lc(bi) + ' aria-hidden="true"></span><b>' + esc(bname(bi)) + '</b></span><span class="muted num">' + (st ? esc(st) + ' · ' : '') + '+' + fmtInt(ch.adds) + ' −' + fmtInt(ch.dels) + '</span></div>';
    if (ch.binary) return '<div class="side">' + head + '<p class="small muted" style="margin:10px">A binary file - no lines to show.</p></div>';
    if (!ch.hunks.length) return '<div class="side">' + head + '<p class="small muted" style="margin:10px">No line changes (a rename or a mode change).</p></div>';
    var hitStarts = {}; spots.forEach(function (r) { hitStarts[r.i] = 1; });
    // Show the hunks that hold a colliding change first; else the first three.
    var hunks = ch.hunks.map(function (h) { return { h: h, hit: hunkHits(h, hitStarts) }; });
    var shown = hunks.filter(function (x) { return x.hit; });
    if (!shown.length) shown = hunks.slice(0, 3);
    shown = shown.slice(0, 6);
    var out = shown.map(function (x) { return hunkHtml(x.h, hitStarts); }).join('');
    var hidden = ch.hunkCount - shown.length;
    return '<div class="side">' + head + '<div class="diff" role="region" tabindex="0" aria-label="' + esc(bname(bi) + ': changes to ' + c.path) + '">' + out + (hidden > 0 ? '<span class="more">' + esc(plural(hidden, 'other change')) + ' in this file not shown</span>' : '') + '</div></div>';
  }
  function hunkHits(h, hitStarts) {
    var old = h.oc === 0 ? h.os + 1 : h.os, inRun = false, found = false;
    h.lines.forEach(function (l) {
      if (l[0] === ' ') { inRun = false; old++; return; }
      if (!inRun) { inRun = true; if (hitStarts[old - 1]) found = true; }
      if (l[0] === '-') old++;
    });
    return found;
  }
  function hunkHtml(h, hitStarts) {
    var old = h.oc === 0 ? h.os + 1 : h.os, nw = h.nc === 0 ? h.ns + 1 : h.ns, inRun = false, hit = false;
    var rows = h.lines.map(function (l) {
      var t = l[0], no;
      if (t === ' ') { inRun = false; hit = false; no = old; old++; nw++; }
      else {
        if (!inRun) { inRun = true; hit = Boolean(hitStarts[old - 1]); }
        if (t === '-') { no = old; old++; } else { no = nw; nw++; }
      }
      var cls = t === '+' ? 'add' : t === '-' ? 'del' : '';
      return '<span class="ln ' + cls + (hit && t !== ' ' ? ' hit' : '') + '"><span class="no">' + no + '</span><span class="sg" aria-hidden="true">' + (t === ' ' ? '' : esc(t)) + '</span><span class="tx">' + (t === '+' ? '<span class="vh">added: </span>' : t === '-' ? '<span class="vh">removed: </span>' : '') + esc(l[1]) + '</span></span>';
    }).join('');
    return '<span class="hh">' + esc('@@ -' + h.os + (h.oc !== 1 ? ',' + h.oc : '') + ' +' + h.ns + (h.nc !== 1 ? ',' + h.nc : '') + ' @@') + '</span>' + rows + (h.more ? '<span class="more">' + esc(plural(h.more, 'more line')) + ' not kept</span>' : '');
  }

  var SHARED_SEV = { clash: ['sev-conflict', '✕', 'Clash'], warn: ['sev-touch', '!', 'Check'], info: ['sev-note', 'i', 'Note'] };
  function sharedHtml() {
    var ck = state.check;
    var html = '<section class="card"><div class="sec-head"><h2>Shared state</h2><span class="small muted">' + esc(plural(ck.shared.length, 'item')) + '</span></div>' +
      '<p class="muted lede">Things every branch reaches for: lockfiles, migrations, versions, dependencies, generated files, CI and agent instructions. Some clash even when the lines do not.</p>';
    if (!ck.shared.length) return html + '<div class="empty-state"><div class="ico" aria-hidden="true">🟢</div><p><b>No shared state is changed by more than one branch.</b></p></div></section>';
    html += '<div class="items">' + ck.shared.map(function (s) {
      var sv = SHARED_SEV[s.severity];
      return '<article class="item card" style="box-shadow:none"><div class="ihead"><h3><span aria-hidden="true">' + s.icon + '</span>' + esc(s.title) + '</h3><span class="pill ' + sv[0] + '"><span aria-hidden="true">' + sv[1] + '</span>' + sv[2] + '</span></div>' +
        '<div class="paths">' + s.paths.map(function (p) { return '<code>' + esc(p) + '</code>'; }).join('') + '</div>' +
        '<div class="paths">' + s.branches.map(bchip).join('') + '</div>' +
        '<p style="margin:0">' + esc(s.detail) + '</p>' +
        (s.each ? '<ul class="each">' + s.each.map(function (e) { return '<li><b>' + esc(bname(e.bi)) + '</b>: ' + esc(e.text) + '</li>'; }).join('') + '</ul>' : '') +
        '<div class="fix"><b>Fix</b><p>' + rich(s.fix) + '</p></div></article>';
    }).join('') + '</div></section>';
    return html;
  }
  function dupesHtml() {
    var ck = state.check, d = ck.dupes;
    var html = '<section class="card"><div class="sec-head"><h2>Duplicate work</h2><span class="small muted">' + esc(plural(d.symbols.length, 'helper')) + ' · ' + esc(plural(d.files.length, 'look-alike file')) + '</span></div>' +
      '<p class="muted lede">Two agents solving the same small problem twice merges cleanly - which is exactly why nobody notices. Found from the names of functions, classes and exported constants each branch adds, and from new files with the same or a similar name.</p>';
    if (!d.symbols.length && !d.files.length) return html + '<div class="empty-state"><div class="ico" aria-hidden="true">🟢</div><p><b>Nothing looks written twice.</b></p><p class="muted">No definition is added on two branches, and no two new files share a name.</p></div></section>';
    if (d.symbols.length) {
      html += '<h3 style="margin-top:6px">Same helper, written twice</h3><div class="items">' + d.symbols.map(function (s) {
        return '<article class="item card" style="box-shadow:none"><div class="ihead"><h3><span aria-hidden="true">👯</span><code>' + esc(s.name) + '</code></h3><span class="pill sev-touch">! ' + esc(plural(s.branches.length, 'branch', 'branches')) + '</span></div>' +
          '<ul class="defs">' + s.defs.map(function (x) { return '<li>' + bchip(x.bi) + '<code>' + esc(x.path) + (x.line ? ':' + x.line : '') + '</code></li>'; }).join('') + '</ul>' +
          '<div class="fix"><b>Fix</b><p>Keep one - the one in the branch that merges first - and have the other import it. ' + (s.samePath ? 'Both add it to the same file, so it will also conflict there.' : 'They are in different files, so git will not warn you.') + '</p></div></article>';
      }).join('') + '</div>';
    }
    if (d.files.length) {
      html += '<h3 style="margin-top:18px">Look-alike new files</h3><div class="items">' + d.files.map(function (f) {
        return '<article class="item card" style="box-shadow:none"><div class="ihead"><h3>' + esc(f.why === 'same name' ? 'Same name' : 'Similar name') + '</h3></div><ul class="defs"><li>' + bchip(f.a.bi) + '<code>' + esc(f.a.path) + '</code></li><li>' + bchip(f.b.bi) + '<code>' + esc(f.b.path) + '</code></li></ul></article>';
      }).join('') + '</div>';
    }
    return html + '</section>';
  }
  function stepList(s, ck) {
    var items = s.resolve.map(function (r) { return '<li><code>' + esc(r.path) + '</code> with <b>' + esc(r.with) + '</b>: ' + esc(r.text) + '</li>'; });
    if (s.locks && s.locks.length) items.push('<li>Lockfile: take ' + esc(ck.base) + '\u2019s ' + s.locks.map(function (p) { return '<code>' + esc(p) + '</code>'; }).join(', ') + ' during the rebase, then regenerate it once at the end.</li>');
    (s.renames || []).forEach(function (r) { items.push('<li>Migration: renumber <code>' + esc(C.basename(r.from)) + '</code> to <code>' + esc(C.basename(r.to)) + '</code>.</li>'); });
    s.notes.forEach(function (n) { items.push('<li>' + esc(n) + '</li>'); });
    return items.length ? '<ul>' + items.join('') + '</ul>' : '';
  }
  function orderHtml() {
    var ck = state.check, steps = ck.order.steps;
    var rebases = steps.filter(function (s) { return s.action === 'rebase'; }).length;
    var html = '<section class="card"><div class="sec-head"><h2>Merge order</h2><span class="small muted">' + esc(plural(steps.length, 'step')) + ' · ' + (rebases ? esc(plural(rebases, 'branch', 'branches')) + ' to rebase' : 'no rebases') + '</span></div>' +
      '<p class="muted lede">' + (rebases ? 'In this order only ' + esc(plural(rebases, 'branch', 'branches')) + ' ' + (rebases === 1 ? 'needs' : 'need') + ' a rebase, and each resolves its conflicts once. Clean branches go first.' : 'Nothing collides: merge in any order. Smallest first keeps reviews quick.') + ' Merging pull requests instead? Merge them in this order; the rebase steps are what the later ones need.</p>' +
      '<ol class="steps">' + steps.map(function (s, i) {
        var label = s.action === 'rebase' ? 'Rebase, then merge' : s.action === 'skip' ? 'Nothing to merge' : 'Merge';
        return '<li class="step ' + s.action + '"><span class="n" aria-hidden="true">' + (i + 1) + '</span><div class="sbody"><h3><span class="vh">Step ' + (i + 1) + ': </span>' + bchip(s.branch) + '<span class="pill ' + (s.action === 'rebase' ? 'sev-touch' : s.action === 'skip' ? 'sev-note' : 'sev-clean') + '">' + label + '</span></h3>' +
          '<p style="margin:0">' + esc(s.why) + '</p>' +
          stepList(s, ck) +
          (s.commands.length ? '<div class="cmd"><pre aria-label="' + esc('Commands for step ' + (i + 1)) + '">' + esc(s.commands.join('\n')) + '</pre><button class="btn ghost" type="button" data-act="copystep" data-i="' + i + '">Copy</button></div>' : '') +
          '</div></li>';
      }).join('') + '</ol>' +
      '<div class="btns" style="margin-top:14px"><button class="btn ghost" type="button" data-act="copyall">Copy every command</button></div>' +
      '<p class="small muted" style="margin:10px 0 0">The order puts clean branches first, then lets the fewest branches do the rebasing (the smaller change to a shared file is the one redone). A branch built on another goes after it. Read each command before you run it.</p></section>';
    return html + reportCard();
  }

  /* ---------------- planning ---------------- */

  function ensurePlan() {
    if (state.plan) return;
    var s = savedPlan();
    if (s) { state.plan = s.plan; if (!state.files.length && s.files.length) { state.files = s.files; state.filesFrom = 'saved'; state.tree = null; } state.planDemo = false; return; }
    state.plan = C.cleanPlan({ tasks: [], lanes: [], base: state.cmd.base || 'main' });
    state.planDemo = false;
  }
  function savePlan() {
    if (state.planDemo || !state.plan) return;
    var files = state.filesFrom === 'the example' ? [] : state.files.slice(0, 20000);
    if (!keep(K_PLAN, { v: 1, plan: state.plan, files: files, savedAt: Date.now() })) keep(K_PLAN, { v: 1, plan: state.plan, files: [], savedAt: Date.now() });
  }
  function recheck() { state.planCk = C.checkPlan(state.plan, state.files); return state.planCk; }
  function planHtml() {
    var p = state.plan, ck = recheck();
    var html = '<section class="card"><button class="link-btn" type="button" data-act="home">← Back</button>' +
      '<div class="sec-head" style="margin-top:2px"><h1 style="margin:0">Plan the lanes</h1>' + (state.planDemo ? '<span class="pill sev-note">Example - not saved</span>' : (p.lanes.length ? '<span class="small muted">saved on this device as you go</span>' : '')) + '</div>' +
      '<p class="muted lede">One lane per agent: a task, the paths it owns, what it may only read, and the rules for files everyone shares. Lanes checks that no two lanes own the same file, then writes each agent a brief to paste into its first message.</p>' +
      '<div class="btns">' + (!state.planDemo ? '<button class="btn ghost" type="button" data-act="planexample">See an example plan</button>' : '<button class="btn ghost" type="button" data-act="planmine">Start my own plan</button>') +
      '<button class="btn ai" type="button" data-act="split">✨ Split this into lanes for me</button>' + (!state.planDemo && p.lanes.length ? '<button class="btn ghost" type="button" data-act="clearplan">Clear the plan</button>' : '') + '</div></section>';
    // tasks and files
    html += '<div class="grid two"><section class="card stepcard"><h2><span class="k">1</span>The tasks</h2><label class="field"><span>One per line - one line becomes one lane</span><textarea class="input" id="tasks" rows="6" placeholder="Add invoices and Stripe billing&#10;Search the product list&#10;Polish the empty states">' + esc(p.tasks.join('\n')) + '</textarea></label>' +
      '<div class="btns" style="margin-top:10px"><button class="btn" type="button" data-act="mklanes">' + (p.lanes.length ? 'Update the lanes' : 'Make the lanes') + '</button></div></section>';
    html += '<section class="card stepcard"><h2><span class="k">2</span>Your repo’s files</h2>' +
      (state.files.length ? '<p><b>' + esc(plural(state.files.length, 'file')) + '</b> from ' + esc(state.filesFrom || 'your list') + '.</p>' : '<p class="muted">So patterns can be checked against the real tree. Paths only - no file contents.</p>') +
      '<div class="cmd"><pre>git ls-files &gt; files.txt</pre><button class="btn ghost" type="button" data-act="copyls">Copy</button></div>' +
      '<div class="btns" style="margin-top:10px"><label class="btn ghost filepick">' + (state.files.length ? 'Load another list' : 'Choose files.txt or lanes.txt') + '<input type="file" id="pickList" accept=".txt,text/plain" aria-label="Choose a file list"></label><button class="btn ghost" type="button" data-act="pastelist">Paste the list</button></div>' +
      '<div id="listState" aria-live="polite"></div></section></div>';
    html += '<details class="card more"><summary>Branch, folder and lead names</summary><div class="settings">' +
      '<label class="field"><span>Base branch</span><input class="input code" data-set="base" value="' + esc(p.base) + '" maxlength="120" autocomplete="off" spellcheck="false"></label>' +
      '<label class="field"><span>Branch prefix</span><input class="input code" data-set="prefix" value="' + esc(p.prefix) + '" maxlength="30" autocomplete="off" spellcheck="false"></label>' +
      '<label class="field"><span>Repo folder name</span><input class="input code" data-set="repo" value="' + esc(p.repo) + '" maxlength="60" autocomplete="off" spellcheck="false"></label>' +
      '<label class="field"><span>Who merges</span><input class="input" data-set="lead" value="' + esc(p.lead) + '" maxlength="40" autocomplete="off"></label></div>' +
      '<p class="small muted" style="margin:8px 0 0">Worktrees go next to your repo: <code>../' + esc(p.repo) + '-&lt;lane&gt;</code>, on branch <code>' + esc(p.prefix) + '&lt;lane&gt;</code>.</p></details>';
    html += '<div id="planLanes">' + lanesHtml(ck) + '</div><div id="planChecks">' + checksHtml(ck) + '</div><div id="planBriefs">' + briefsHtml(ck) + '</div>';
    return html + footer();
  }
  function lanesHtml(ck) {
    var p = state.plan;
    if (!p.lanes.length) return '<section class="card empty-state"><div class="ico" aria-hidden="true">🛣️</div><p><b>No lanes yet.</b></p><p class="muted">Write the tasks above and press <b>Make the lanes</b>, or let AI split them for you.</p></section>';
    return '<section class="card"><div class="sec-head"><h2>3 · The lanes</h2><span class="small muted">' + esc(plural(p.lanes.length, 'lane')) + '</span></div><div class="lanes">' + p.lanes.map(function (l, i) {
      var info = ck.lanes[i];
      var globChip = function (g, kind, gi) {
        var bad = !g.neg && !g.count && kind === 'owns';
        var count = g.error ? esc(g.error) : g.neg ? 'except ' + plural(g.count, 'file') : g.count ? plural(g.count, 'file') : (g.fresh ? 'new' : 'no files yet');
        return '<span class="glob' + (bad && !g.fresh ? ' bad' : '') + (g.neg ? ' neg' : '') + '"><span class="gt">' + esc(g.glob) + '</span><span class="gc">' + esc(count) + '</span><button class="x" type="button" data-act="rmglob" data-li="' + i + '" data-kind="' + kind + '" data-gi="' + gi + '" aria-label="' + esc('Remove ' + g.glob) + '">×</button></span>';
      };
      var res = ck.reserve.byLane[l.name] || [];
      return '<article class="card lane" ' + lc(i) + '><div class="lhead"><span class="dot" aria-hidden="true"></span><input class="input code lname" data-lane-name="' + i + '" value="' + esc(l.name) + '" aria-label="Lane name" maxlength="30" autocomplete="off" spellcheck="false"><button class="x" type="button" data-act="rmlane" data-li="' + i + '" aria-label="' + esc('Remove lane ' + l.name) + '">×</button></div>' +
        '<p class="ltask">' + esc(l.task || 'No task') + '</p>' +
        '<div><span class="lab">Owns</span> <span class="small muted">' + esc(plural(info.owned, 'file')) + (info.hotOwned ? ' (+ ' + esc(plural(info.hotOwned, 'shared file')) + ' it must leave alone)' : '') + '</span></div>' +
        '<div class="globs">' + info.globs.map(function (g, gi) { return globChip(g, 'owns', gi); }).join('') + '<button class="btn small ghost" type="button" data-act="picker" data-li="' + i + '" data-kind="owns">+ Paths it owns</button></div>' +
        '<div><span class="lab">Read-only</span></div>' +
        '<div class="globs">' + info.readOnly.map(function (g, gi) { return globChip({ glob: g.glob, count: g.count, error: g.error, fresh: false, neg: false }, 'readOnly', gi); }).join('') + '<button class="btn small ghost" type="button" data-act="picker" data-li="' + i + '" data-kind="readOnly">+ Read-only</button></div>' +
        (ck.reserve.dirs.length ? '<label class="row small"><span class="lab">Migrations</span><select class="input" style="width:auto;min-height:44px" data-mig="' + i + '" aria-label="Migration numbers for ' + esc(l.name) + '">' +
          [['', 'Auto'], ['0', 'None'], ['1', '1 number'], ['2', '2 numbers'], ['3', '3 numbers']].map(function (o) { return '<option value="' + o[0] + '"' + (String(l.migrations === null ? '' : l.migrations) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
          '<span class="muted">' + (res.length ? res.map(function (r) { return '<code>' + esc(r.number) + '</code>'; }).join(' ') : 'none reserved') + '</span></label>' : '') +
        '<div class="btns"><button class="btn small" type="button" data-act="brief" data-li="' + i + '">Its brief</button></div></article>';
    }).join('') + '</div><div class="btns" style="margin-top:12px"><button class="btn ghost" type="button" data-act="addlane">+ Add a lane</button></div></section>';
  }
  function checksHtml(ck) {
    var p = state.plan;
    if (!p.lanes.length) return '';
    var html = '<section class="card"><div class="sec-head"><h2>4 · The check</h2><span class="small muted">against ' + esc(plural(ck.files, 'file')) + '</span></div><div class="checks">';
    if (!ck.files) html += '<div class="check"><span aria-hidden="true">📄</span><div><b>Load the file list to check the lanes.</b><p class="muted">Without it, Lanes cannot tell what a pattern covers.</p></div></div>';
    else if (!ck.overlaps.length) html += '<div class="check ok"><span aria-hidden="true">✓</span><div><b>No two lanes own the same file.</b></div></div>';
    ck.overlaps.forEach(function (o) {
      var a = p.lanes[o.a].name, b = p.lanes[o.b].name;
      html += '<div class="check bad"><span aria-hidden="true">✕</span><div><b>' + esc(a) + ' and ' + esc(b) + ' both own ' + esc(plural(o.count, 'file')) + '</b><p>' + o.examples.map(function (f) { return '<code>' + esc(f) + '</code>'; }).join(' ') + (o.count > o.examples.length ? ' …' : '') + '</p><p class="small" style="color:var(--text)">Give it to one lane - remove it from the other, or add <code>!' + esc(o.examples[0]) + '</code> to the other’s paths.</p></div></div>';
    });
    var empty = ck.lanes.filter(function (l) { return l.empty; });
    if (empty.length) html += '<div class="check"><span aria-hidden="true">!</span><div><b>' + esc(empty.map(function (l) { return l.name; }).join(', ')) + (empty.length === 1 ? ' owns' : ' own') + ' nothing yet.</b><p class="muted">Its brief will say to ask before editing any file.</p></div></div>';
    if (ck.files) html += '<div class="check"><span aria-hidden="true">i</span><div><b>' + esc(plural(ck.unowned, 'file')) + ' belong to no lane.</b><p class="muted">Every brief treats them as read-only.</p></div></div>';
    html += '</div>';
    if (ck.hotspots.length) {
      html += '<h3 style="margin-top:16px">Shared files: no lane owns them alone</h3><p class="small muted">Each brief carries these rules. Edit a rule and every brief changes.</p>' +
        ck.hotspots.map(function (h) {
          return '<div class="hot"><div class="hhead"><span aria-hidden="true">' + C.KIND_INFO[h.kind].icon + '</span><code>' + esc(h.label) + '</code><span class="pill sev-note">' + esc(C.KIND_INFO[h.kind].title) + (h.files > 1 ? ' · ' + esc(plural(h.files, 'file')) : '') + '</span></div>' +
            (h.ownedBy.length ? '<p class="warnline">! Inside ' + esc(h.ownedBy.map(function (i) { return p.lanes[i].name; }).join(' and ')) + '’s paths - its brief still says to leave it alone.</p>' : '') +
            '<textarea class="input rule" rows="2" data-rule="' + esc(h.key) + '" maxlength="' + C.LIMITS.ruleLen + '" aria-label="' + esc('Rule for ' + h.label) + '">' + esc(h.rule) + '</textarea></div>';
        }).join('');
    }
    if (ck.reserve.dirs.length) {
      html += '<h3 style="margin-top:16px">Migration numbers</h3>' + ck.reserve.dirs.map(function (d) {
        var taken = [];
        Object.keys(ck.reserve.byLane).forEach(function (n) { ck.reserve.byLane[n].forEach(function (r) { if (r.dir === d.dir) taken.push('<b>' + esc(n) + '</b> <code>' + esc(r.number) + '</code>'); }); });
        return '<p><code>' + esc((d.dir || '.') + '/') + '</code> has ' + esc(plural(d.count, 'migration')) + ', the last numbered ' + esc(String(d.max)) + '. ' + (taken.length ? 'Reserved: ' + taken.join(' · ') + '.' : 'No lane needs one yet.') + '</p>';
      }).join('') + '<p class="small muted">"Auto" reserves one number for a lane whose task mentions the database (tables, sessions, invoices…). Change it on the lane.</p>';
    }
    return html + '</section>';
  }
  function briefsHtml(ck) {
    var p = state.plan;
    if (!p.lanes.length) return '';
    return '<section class="card"><div class="sec-head"><h2>5 · The briefs</h2><span class="small muted">paste one into each agent’s first message</span></div>' +
      '<p class="muted lede">Each brief has the task, the paths it owns and must not touch, the rules for shared files, its migration numbers, and its <code>git worktree</code> command.</p>' +
      '<div class="cmd"><pre>' + esc(p.lanes.map(function (l) { return C.worktreeCmd(p, l); }).join('\n')) + '</pre><button class="btn ghost" type="button" data-act="copywt">Copy</button></div>' +
      '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="copybriefs">Copy all briefs</button><button class="btn ghost" type="button" data-act="dlbriefs">Download briefs.md</button></div>' +
      '<div class="branches" style="margin-top:12px">' + p.lanes.map(function (l, i) { return '<button class="bcard" type="button" data-act="brief" data-li="' + i + '" ' + lc(i) + ' style="text-align:left;justify-items:start;cursor:pointer;font:inherit;color:inherit"><span class="bname">' + esc(p.prefix + l.name) + '</span><span class="bmeta">' + esc(l.task || 'No task') + '</span><span class="link-btn" style="min-height:0">Open the brief →</span></button>'; }).join('') + '</div></section>';
  }
  function redrawPlan(all) {
    var ck = recheck();
    if (all) { draw(); return; }
    var a = $('#planLanes'), b = $('#planChecks'), c = $('#planBriefs');
    if (a) a.innerHTML = lanesHtml(ck);
    if (b) b.innerHTML = checksHtml(ck);
    if (c) c.innerHTML = briefsHtml(ck);
    savePlan();
  }
  function wirePlan() {
    var pl = $('#pickList');
    if (pl) pl.addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) readFile(f, '#listState', takeList); e.target.value = ''; });
    $$('[data-set]').forEach(function (el) {
      el.addEventListener('change', function () {
        var k = el.getAttribute('data-set'), next = Object.assign({}, state.plan); next[k] = el.value.trim();
        var cleaned = C.cleanPlan(next);
        if (cleaned[k] !== next[k] && k !== 'lead') toast('That name can only use letters, numbers and . _ / -');
        state.plan = cleaned; redrawPlan(true);
      });
    });
  }
  function planChange(e) {
    var t = e.target;
    if (state.view !== 'plan' || !t || !t.getAttribute) return;
    if (t.hasAttribute('data-lane-name')) {
      var i = +t.getAttribute('data-lane-name'), v = C.slugName(t.value);
      var lanes = state.plan.lanes.slice();
      if (!v || lanes.some(function (l, j) { return j !== i && l.name === v; })) { toast(v ? 'Another lane has that name.' : 'A lane needs a name.'); t.value = lanes[i].name; return; }
      var old = lanes[i].name; lanes[i] = Object.assign({}, lanes[i], { name: v });
      state.plan = C.cleanPlan(Object.assign({}, state.plan, { lanes: lanes }));
      if (old !== v) redrawPlan();
      return;
    }
    if (t.hasAttribute('data-rule')) {
      var key = t.getAttribute('data-rule'), rules = Object.assign({}, state.plan.rules);
      var txt = C.clean(t.value, C.LIMITS.ruleLen).trim();
      if (txt) rules[key] = txt; else delete rules[key];
      state.plan = C.cleanPlan(Object.assign({}, state.plan, { rules: rules }));
      var ck = recheck(); var c = $('#planBriefs'); if (c) c.innerHTML = briefsHtml(ck); savePlan();
      toast('Rule saved - every brief has it');
      return;
    }
    if (t.hasAttribute('data-mig')) {
      var li = +t.getAttribute('data-mig'), ls = state.plan.lanes.slice();
      ls[li] = Object.assign({}, ls[li], { migrations: t.value === '' ? null : Number(t.value) });
      state.plan = C.cleanPlan(Object.assign({}, state.plan, { lanes: ls }));
      redrawPlan();
    }
  }
  function takeList(text, name, box) {
    var r;
    try { r = C.parseInput(text); } catch (e) { box.innerHTML = '<p class="err" role="alert">That file could not be read.</p>'; return; }
    var files = r.kind === 'gather' || r.kind === 'files' ? r.files : [];
    if (!files.length) { box.innerHTML = '<p class="err" role="alert">No file paths in that. Run <code>git ls-files &gt; files.txt</code> in your repo and choose files.txt.</p>'; return; }
    useFiles(files, name);
  }
  function useFiles(files, name) {
    state.files = files; state.filesFrom = name; state.tree = null;
    if (state.planDemo) { state.planDemo = false; state.plan = C.cleanPlan({ tasks: [], lanes: [] }); }
    savePlan();
    toast(plural(files.length, 'file') + ' loaded');
    redrawPlan(true);
  }
  function makeLanes() {
    var el = $('#tasks');
    var tasks = el.value.split(/\r?\n/).map(function (t) { return C.clean(t, C.LIMITS.taskLen).trim(); }).filter(Boolean);
    if (!tasks.length) { toast('Write at least one task, one per line.'); el.focus(); return; }
    if (tasks.length > C.LIMITS.tasks) { toast('Up to ' + C.LIMITS.tasks + ' tasks - the first ' + C.LIMITS.tasks + ' were kept.'); tasks = tasks.slice(0, C.LIMITS.tasks); }
    if (state.planDemo) { state.planDemo = false; if (state.filesFrom === 'the example') toast('Your own plan now - load your file list next.'); }
    state.plan = C.cleanPlan(Object.assign({}, state.plan, { tasks: tasks, lanes: C.tasksToLanes(tasks, state.plan.lanes) }));
    redrawPlan(true);
  }
  function changeGlobs(li, kind, fn) {
    var lanes = state.plan.lanes.slice();
    var l = Object.assign({}, lanes[li]);
    l[kind] = fn(l[kind].slice());
    lanes[li] = l;
    if (state.planDemo) state.planDemo = false;
    state.plan = C.cleanPlan(Object.assign({}, state.plan, { lanes: lanes }));
  }

  /* ---- the picker ---- */

  function tree() { if (!state.tree) state.tree = C.buildTree(state.files); return state.tree; }
  function openPicker(li, kind) {
    if (!state.files.length) { toast('Load your file list first - then pick from the real tree.'); var el = $('#listState'); if (el) el.scrollIntoView({ block: 'center' }); }
    state.picker = { li: li, kind: kind, dir: '' };
    sheet('<div id="pick"></div>', drawPicker);
  }
  function ownersByDir() {
    var files = state.files, dirs = Object.create(null);
    state.plan.lanes.forEach(function (l, li) {
      var m = C.matchMask(l.owns, files);
      for (var i = 0; i < files.length; i++) if (m[i]) {
        var d = C.dirname(files[i]);
        while (true) { var k = d + '|' + li; dirs[k] = (dirs[k] || 0) + 1; if (!d) break; d = C.dirname(d); }
        dirs['f|' + files[i] + '|' + li] = 1;
      }
    });
    return dirs;
  }
  function drawPicker(root) {
    var pk = state.picker, l = state.plan.lanes[pk.li];
    if (!l) { closeSheet(); return; }
    var t = tree(), node = t[pk.dir] || t[''];
    var owners = ownersByDir();
    var takenBy = function (key, count) {
      var by = [];
      state.plan.lanes.forEach(function (o, oi) { if (oi !== pk.li && owners[key + '|' + oi]) by.push(oi); });
      var mine = owners[key + '|' + pk.li] ? '<span class="taken mine">✓ in this lane' + (count ? ' ' + owners[key + '|' + pk.li] + '/' + count : '') + '</span>' : '';
      return mine + (by.length ? '<span class="taken">' + by.map(function (oi) { return '<span class="dot" ' + lc(oi) + ' aria-hidden="true"></span>' + esc(state.plan.lanes[oi].name) + (count ? ' ' + owners[key + '|' + oi] + '/' + count : ''); }).join(' ') + '</span>' : '');
    };
    var crumbs = ['<button type="button" data-act="pdir" data-dir="">' + esc(state.plan.repo) + '</button>'];
    if (pk.dir) { var acc = ''; pk.dir.split('/').forEach(function (part) { acc = acc ? acc + '/' + part : part; crumbs.push('<span aria-hidden="true">/</span><button type="button" data-act="pdir" data-dir="' + esc(acc) + '">' + esc(part) + '</button>'); }); }
    var verb = pk.kind === 'owns' ? 'Own' : 'Read';
    var html = '<h2>' + (pk.kind === 'owns' ? 'Paths <code>' + esc(l.name) + '</code> owns' : 'Paths <code>' + esc(l.name) + '</code> may read') + '</h2>' +
      '<p class="small muted">Tap a folder to open it; <b>+ ' + verb + '</b> adds the folder (<code>folder/**</code>) or the file. Or type a pattern: <code>*</code> stays in one folder, <code>**</code> crosses folders, <code>!</code> in front takes files back out.</p>' +
      '<div class="patrow"><input class="input code" id="pat" placeholder="src/billing/**" aria-label="A path pattern" autocomplete="off" spellcheck="false" maxlength="' + C.LIMITS.globLen + '"><button class="btn" type="button" data-act="addpat">Add</button></div>' +
      '<p class="small muted" id="patInfo" aria-live="polite" style="min-height:1.5em;margin:6px 0 0"></p>' +
      (state.files.length ? '<nav class="crumbs" aria-label="Folder">' + crumbs.join('') + '</nav><ul class="tree">' +
        node.dirs.map(function (d) {
          var nd = t[d];
          return '<li><button class="open" type="button" data-act="pdir" data-dir="' + esc(d) + '"><span aria-hidden="true">📁</span><span class="nm">' + esc(C.basename(d)) + '/</span><span class="ct">' + esc(plural(nd.count, 'file')) + '</span>' + takenBy(d, nd.count) + '</button><button class="btn small ghost add" type="button" data-act="addpath" data-path="' + esc(d + '/**') + '">+ ' + verb + '</button></li>';
        }).join('') +
        node.files.slice(0, 400).map(function (f) {
          return '<li><span class="open" style="cursor:default"><span aria-hidden="true">📄</span><span class="nm">' + esc(C.basename(f)) + '</span>' + takenBy('f|' + f, 0) + '</span><button class="btn small ghost add" type="button" data-act="addpath" data-path="' + esc(f) + '">+ ' + verb + '</button></li>';
        }).join('') + (node.files.length > 400 ? '<li><span class="open muted">' + esc(plural(node.files.length - 400, 'more file')) + ' - type a pattern for them</span></li>' : '') +
        (!node.dirs.length && !node.files.length ? '<li><span class="open muted">Empty</span></li>' : '') + '</ul>' : '<p class="note">No file list loaded, so there is no tree to pick from. Patterns still work: they will be checked when you load the list.</p>') +
      '<div class="btns" style="margin-top:14px"><button class="btn ghost" type="button" data-act="closesheet">Done</button></div>';
    root.querySelector('#pick').innerHTML = html;
    var inp = root.querySelector('#pat');
    inp.addEventListener('input', function () { patInfo(inp.value); });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addPattern(inp.value); } });
  }
  function patInfo(v) {
    var el = $('#patInfo'); if (!el) return;
    v = v.trim();
    if (!v) { el.textContent = ''; return; }
    var c = C.globCount(v, state.files);
    if (c.error) { el.innerHTML = '<span class="err">' + esc(c.error) + '</span>'; return; }
    if (!c.count) { el.textContent = C.isFreshPath(v, C.knownDirs(state.files), true) ? 'No files yet - fine for a new folder or file.' : 'No files match.'; return; }
    el.innerHTML = '<b>' + esc(plural(c.count, 'file')) + '</b>: ' + c.examples.map(function (x) { return '<code>' + esc(x) + '</code>'; }).join(' ') + (c.count > c.examples.length ? ' …' : '');
  }
  function addPattern(v) {
    var pk = state.picker;
    v = String(v || '').trim();
    if (!v) return;
    var c = C.compileGlob(v);
    if (c.error) { toast(c.error); return; }
    var lane = state.plan.lanes[pk.li];
    if (lane[pk.kind].indexOf(v) !== -1) { toast('Already there'); return; }
    if (lane[pk.kind].length >= C.LIMITS.globs) { toast('Up to ' + C.LIMITS.globs + ' patterns a lane.'); return; }
    changeGlobs(pk.li, pk.kind, function (a) { a.push(v); return a; });
    var n = C.globCount(v, state.files).count;
    toast('Added ' + v + (n ? ' (' + plural(n, 'file') + ')' : ''));
    redrawPlan();
    var s = $('#sheet'); if (s && !s.hidden && $('#pick', s)) drawPicker(s);
  }

  /* ---- briefs and the AI split ---- */

  function openBrief(li) {
    var md = C.brief(state.planCk || recheck(), li);
    var l = state.plan.lanes[li];
    sheet('<h2>Brief for <code>' + esc(l.name) + '</code></h2><p class="small muted">Paste it into the agent’s first message (or save it as the worktree’s CLAUDE.local.md / AGENTS.md).</p><pre class="brief-pre">' + esc(md) + '</pre><div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="copybrief" data-li="' + li + '">Copy the brief</button><button class="btn ghost" type="button" data-act="closesheet">Done</button></div>');
  }
  function currentTasks() {
    var el = $('#tasks');
    var t = el ? el.value.split(/\r?\n/).map(function (x) { return C.clean(x, C.LIMITS.taskLen).trim(); }).filter(Boolean) : state.plan.tasks;
    return t.slice(0, C.LIMITS.tasks);
  }
  function openSplit() {
    var tasks = currentTasks();
    if (!tasks.length) { toast('Write the tasks first, one per line.'); var el = $('#tasks'); if (el) el.focus(); return; }
    if (!state.files.length) { toast('Load your file list first, so the lanes fit your real tree.'); return; }
    var payload = C.splitPayload(tasks, state.files);
    var what = '<p>It is sent <b>' + esc(plural(payload.tasks.length, 'task')) + '</b> and <b>' + esc(plural(payload.paths.length, 'file path')) + '</b>' + (payload.dirs.length ? ', plus <b>' + esc(plural(payload.dirs.length, 'folder')) + '</b> with file counts (your tree has ' + esc(fmtInt(payload.total)) + ' files, more than the ' + fmtInt(C.LIMITS.aiPaths) + ' sent by name)' : '') + '. <b>Never a diff, and never a file’s contents.</b></p>';
    if (!signedIn()) {
      sheet('<h2>✨ Split this into lanes for me</h2><p>AI reads your tasks and your repo’s file paths and proposes lanes that do not overlap, with rules for the shared files. You check and edit it before anything is used.</p>' +
        '<div class="note">' + what + '<p class="small muted" style="margin:0">It uses a cent or two of AI credit, so it needs a free account (it comes with $2). Planning by hand, the check and the briefs stay free, with no account.</p></div>' +
        '<details style="margin-top:10px"><summary class="row" style="min-height:44px;cursor:pointer"><b>See exactly what would be sent</b></summary><pre class="sent">' + esc(JSON.stringify(previewPayload(payload), null, 2)) + '</pre></details>' +
        '<div class="btns" style="margin-top:14px"><button class="btn" type="button" data-act="signin-split">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button></div>');
      return;
    }
    sheet('<h2>✨ Split this into lanes for me</h2><div id="spLead">' + what + '<p class="small muted">This is <b>exactly</b> what will be sent:</p></div><details open id="sentBox"><summary class="row" style="min-height:44px;cursor:pointer"><b id="sentLabel">What will be sent</b></summary><pre class="sent">' + esc(JSON.stringify(payload, null, 2)) + '</pre></details>' +
      '<div id="spErr"></div><div id="spActs"><div class="btns" style="margin-top:12px"><button class="btn" type="button" id="spSend">Send and split</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div><p class="small muted" style="margin-top:8px">A cent or two of AI credit. Nothing is stored.</p></div><div id="spOut"></div>', function (root) {
      $('#spSend', root).addEventListener('click', function (e) {
        var btn = e.currentTarget;
        btn.disabled = true; btn.textContent = 'Splitting…';
        api('POST', 'api/split', payload).then(function (r) {
          var prop = C.cleanProposal(r.proposal, state.files);
          if (!prop) throw Object.assign(new Error('That answer had no lanes that fit your repo. Try again, or draw the lanes yourself.'), { status: 422 });
          state.proposal = prop;
          $('#spActs', root).hidden = true;
          $('#sentBox', root).open = false; $('#sentLabel', root).textContent = 'What was sent'; $('#spLead', root).hidden = true;
          $('#spOut', root).innerHTML = proposalHtml(prop);
          loadMe();
        }).catch(function (err) { btn.disabled = false; btn.textContent = 'Send and split'; meteredError(err, $('#spErr', root), openSplit); });
      });
    });
  }
  function previewPayload(p) {
    return { tasks: p.tasks, paths: p.paths.slice(0, 40).concat(p.paths.length > 40 ? ['… and ' + fmtInt(p.paths.length - 40) + ' more paths, exactly as listed in your tree'] : []), dirs: p.dirs.slice(0, 20), total: p.total };
  }
  function proposalHtml(prop) {
    var plan = Object.assign({}, state.plan, { lanes: prop.lanes, tasks: prop.lanes.map(function (l) { return l.task; }) });
    var ck = C.checkPlan(plan, state.files);
    return '<div class="proposal"><h3 style="margin:0">The proposal</h3>' +
      (ck.overlaps.length ? '<div class="check bad"><span aria-hidden="true">✕</span><div><b>' + esc(plural(ck.overlaps.length, 'overlap')) + ' between lanes</b><p>' + ck.overlaps.map(function (o) { return esc(prop.lanes[o.a].name + ' / ' + prop.lanes[o.b].name + ': ' + plural(o.count, 'file')); }).join(' · ') + '. Fix them after you use it.</p></div></div>' : '<div class="check ok"><span aria-hidden="true">✓</span><div><b>No two lanes own the same file.</b></div></div>') +
      prop.lanes.map(function (l, i) {
        return '<div class="plane" ' + lc(i) + '><b class="mono">' + esc(l.name) + '</b><span class="muted">' + esc(l.task) + '</span>' +
          '<div class="globs">' + l.owns.map(function (g) { var c = C.globCount(g, state.files); return '<span class="chip">' + esc(g) + ' · ' + esc(c.count ? plural(c.count, 'file') : 'new') + '</span>'; }).join('') + '</div>' +
          (l.readOnly.length ? '<div class="small muted">Reads: ' + l.readOnly.map(function (g) { return '<code>' + esc(g) + '</code>'; }).join(' ') + '</div>' : '') +
          (l.notes ? '<p class="small" style="margin:0">' + esc(l.notes) + '</p>' : '') + '</div>';
      }).join('') +
      (prop.hotspots.length ? '<div class="note"><b>Shared-file rules</b><ul style="margin:6px 0 0;padding-left:20px">' + prop.hotspots.map(function (h) { return '<li><code>' + esc(h.path) + '</code>: ' + esc(h.rule) + '</li>'; }).join('') + '</ul></div>' : '') +
      (prop.dropped.length ? '<p class="small muted">Left out because they did not fit your tree: ' + prop.dropped.slice(0, 8).map(function (d) { return '<code>' + esc(d.glob) + '</code>'; }).join(' ') + (prop.dropped.length > 8 ? ' …' : '') + '</p>' : '') +
      '<p class="small muted">Written by AI from your paths. Every pattern was checked against your tree; read it before you use it.</p>' +
      '<div class="btns"><button class="btn" type="button" data-act="usesplit">Use this split</button><button class="btn ghost" type="button" data-act="closesheet">Discard</button></div><p class="small muted" style="margin:0">Using it replaces the lanes on this page. Your tasks, file list and rules stay.</p></div>';
  }
  function useSplit() {
    var prop = state.proposal;
    if (!prop) return;
    var rules = {};
    var hs = C.hotspots(state.files);
    prop.hotspots.forEach(function (h) {
      var c = C.compileGlob(h.path);
      var g = hs.filter(function (x) { return x.label === h.path || x.glob === h.path || (c.re && x.files.some(function (f) { return c.re.test(f); })); })[0];
      if (g) rules[g.key] = h.rule;
    });
    state.planDemo = false;
    state.plan = C.cleanPlan(Object.assign({}, state.plan, { lanes: prop.lanes, tasks: prop.lanes.map(function (l) { return l.task; }), rules: Object.assign({}, state.plan.rules, rules) }));
    state.proposal = null;
    savePlan();
    closeSheet();
    redrawPlan(true);
    toast('Lanes replaced - edit anything you like');
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
    state.picker = null;
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
  });
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var FREE_LINE = 'Nothing in Lanes needs an account except "Split this into lanes for me", the one AI feature - a free account comes with $2 of AI credit, and one account works across every app on this site.';
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Splitting the work with AI costs a cent or two. The check, the plan and the briefs are free and need no account.</p><div id="billing"></div></div>' +
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The check, planning by hand and the briefs keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- one click listener ---------------- */

  function stepCommands(i) { return state.check.order.steps[i].commands.join('\n'); }
  function fname(ext) { return 'lanes-' + today() + ext; }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    var li = +t.getAttribute('data-li');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); go('start'); break;
      case 'example': history.pushState(null, '', BASE + '#example'); openDemo(true); break;
      case 'gocheck': go('check'); break;
      case 'goplan': go('plan'); break;
      case 'planexample': openPlanDemo(); break;
      case 'planmine': state.plan = C.cleanPlan({ tasks: [], lanes: [] }); state.planDemo = false; if (state.filesFrom === 'the example') { state.files = []; state.filesFrom = ''; state.tree = null; } redrawPlan(true); break;
      case 'openplan': state.plan = null; ensurePlan(); go('plan'); break;
      case 'clearplan': keep(K_PLAN, null); toast('Cleared from this device'); if (state.view === 'plan') { state.plan = C.cleanPlan({ tasks: [], lanes: [] }); state.planDemo = false; draw(); } else { state.plan = null; draw(); } break;
      case 'tab': e.preventDefault(); go(t.getAttribute('data-tab')); break;
      case 'cmode': state.cmd.mode = t.getAttribute('data-v'); draw(); break;
      case 'cshell': state.cmd.shell = t.getAttribute('data-v'); keep(K_CMD, state.cmd); draw(); break;
      case 'copycmd0': { var r = cmdFor(); if (r.command) copy(r.command, 'Command copied - run it in your repo'); else toast(r.error); break; }
      case 'togglepaste': state.showPaste = !state.showPaste; draw(); break;
      case 'checkpaste': { var ta = $('#pasteAll'); if (ta && ta.value.trim()) takeText(ta.value, 'pasted lanes.txt', $('#loadState')); break; }
      case 'addpaste': if (state.pastes.length < C.LIMITS.pasteBranches) { state.pastes.push({ name: '', text: '' }); draw(); var d = $('details.card'); if (d) d.open = true; } break;
      case 'checkpastes': checkPastes(); break;
      case 'planwithfiles': if (state.pendingFiles) { state.files = state.pendingFiles; state.filesFrom = 'your list'; state.tree = null; state.pendingFiles = null; state.plan = null; ensurePlan(); if (state.planDemo) state.plan = C.cleanPlan({ tasks: [], lanes: [] }); state.planDemo = false; go('plan'); } break;
      case 'planfromcheck': state.plan = null; ensurePlan(); if (state.source === 'demo' && !state.plan.lanes.length) { openPlanDemo(); break; } go('plan'); break;
      case 'branchcols': state.filter = { conflicts: false, a: -1, b: -1, branch: +t.getAttribute('data-i') }; go('collisions'); break;
      case 'pair': state.filter = { conflicts: false, a: +t.getAttribute('data-a'), b: +t.getAttribute('data-b'), branch: -1 }; state.open = {}; state.check.collisions.forEach(function (c) { if (c.pairs.some(function (p) { return (p.a === state.filter.a && p.b === state.filter.b) || (p.a === state.filter.b && p.b === state.filter.a); })) state.open[c.path] = true; }); go('collisions'); break;
      case 'cfilter': { var v = t.getAttribute('data-v'); state.filter = { conflicts: v === 'conflicts' ? !state.filter.conflicts : false, a: -1, b: -1, branch: -1 }; drawTab(); break; }
      case 'col': { var ci = t.getAttribute('data-i'), c = state.check.collisions[+ci]; if (c) { state.open[c.path] = !state.open[c.path]; drawTab(); var again = $('.chead[data-i="' + ci + '"]'); if (again) again.focus({ preventScroll: true }); } break; }
      case 'copystep': copy(stepCommands(+t.getAttribute('data-i')), 'Commands copied'); break;
      case 'copyall': copy(state.check.order.steps.map(function (s, i) { return s.commands.length ? '# ' + (i + 1) + '. ' + s.name + '\n' + s.commands.join('\n') : ''; }).filter(Boolean).join('\n\n'), 'Every command copied'); break;
      case 'copymd': copy(C.toMarkdown(state.check), 'Markdown copied'); break;
      case 'md': download(fname('.md'), 'text/markdown', C.toMarkdown(state.check)); break;
      case 'json': download(fname('.json'), 'application/json', C.toJson(state.check)); break;
      case 'mklanes': makeLanes(); break;
      case 'copyls': copy('git ls-files > files.txt', 'Copied - run it in your repo'); break;
      case 'pastelist':
        sheet('<h2>Paste your file list</h2><p class="small muted">The output of <code>git ls-files</code>, one path per line. Paths only - it stays on this device.</p><textarea class="input code" id="listPaste" rows="10" spellcheck="false"></textarea><div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="takelist">Use these paths</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div>');
        break;
      case 'takelist': { var lp = $('#listPaste'); var rr = C.parseInput(lp ? lp.value : ''); var fs = rr.kind === 'files' || rr.kind === 'gather' ? rr.files : []; if (!fs.length) { toast('No paths in that.'); break; } closeSheet(); useFiles(fs, 'your pasted list'); break; }
      case 'addlane': { if (state.plan.lanes.length >= C.LIMITS.lanes) { toast('Up to ' + C.LIMITS.lanes + ' lanes.'); break; } var ls = state.plan.lanes.concat([{ name: C.laneName('lane', state.plan.lanes.map(function (l) { return l.name; })), task: '', owns: [], readOnly: [], notes: '', migrations: null }]); state.planDemo = false; state.plan = C.cleanPlan(Object.assign({}, state.plan, { lanes: ls })); redrawPlan(); break; }
      case 'rmlane': { var lsr = state.plan.lanes.slice(); var gone = lsr.splice(li, 1)[0]; state.planDemo = false; state.plan = C.cleanPlan(Object.assign({}, state.plan, { lanes: lsr, tasks: state.plan.tasks.filter(function (x) { return x !== gone.task; }) })); redrawPlan(true); toast('Removed lane ' + gone.name); break; }
      case 'rmglob': { var kind = t.getAttribute('data-kind'), gi = +t.getAttribute('data-gi'); changeGlobs(li, kind, function (a) { a.splice(gi, 1); return a; }); redrawPlan(); break; }
      case 'picker': openPicker(li, t.getAttribute('data-kind')); break;
      case 'pdir': if (state.picker) { state.picker.dir = t.getAttribute('data-dir'); drawPicker($('#sheet')); $('#sheet').scrollTop = 0; } break;
      case 'addpath': addPattern(t.getAttribute('data-path')); break;
      case 'addpat': { var pi = $('#pat'); if (pi) { addPattern(pi.value); } break; }
      case 'brief': openBrief(li); break;
      case 'copybrief': copy(C.brief(state.planCk || recheck(), li), 'Brief copied - paste it into the agent'); break;
      case 'copybriefs': copy(C.allBriefs(state.plan, state.files), 'All briefs copied'); break;
      case 'dlbriefs': download('lanes-briefs-' + today() + '.md', 'text/markdown', C.allBriefs(state.plan, state.files)); break;
      case 'copywt': copy(state.plan.lanes.map(function (l) { return C.worktreeCmd(state.plan, l); }).join('\n'), 'Worktree commands copied'); break;
      case 'split': openSplit(); break;
      case 'signin-split': openAccount('Splitting the work uses a cent or two of AI credit; a free account comes with $2.', openSplit); break;
      case 'usesplit': useSplit(); break;
      default: break;
    }
  });

  /* ---------------- start ---------------- */

  (function () { var c = recall(K_CMD); if (c && typeof c === 'object') { ['base', 'pattern', 'branches'].forEach(function (k) { if (typeof c[k] === 'string') state.cmd[k] = c[k].slice(0, 2000); }); if (c.mode === 'list' || c.mode === 'pattern') state.cmd.mode = c.mode; if (c.shell === 'ps' || c.shell === 'sh') state.cmd.shell = c.shell; } }());
  if (/Windows/.test(navigator.userAgent || '') && !recall(K_CMD)) state.cmd.shell = 'ps';
  document.addEventListener('change', planChange);
  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });
  drawTop();
  route();
  loadMe().then(function () {
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
  });
}());
