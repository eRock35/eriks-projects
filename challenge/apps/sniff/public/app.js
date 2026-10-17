/* Sniff - the page. One file, no build step.
 *
 * CODE IS READ HERE AND NOWHERE ELSE. A dropped folder, a .zip/.crx/.tgz or
 * pasted code is read in this browser, in a Web Worker (scan-worker.js);
 * the rules, the data map, the findings, the destinations and the report are
 * SniffCore's, worked out on the device; nothing about the code is sent. The
 * only requests that carry code are "Explain this finding" and "Second
 * opinion", which send SniffCore's snippet payloads - shown in full, with a
 * warning and a confirmation box, before anything leaves.
 *
 * Every string that came from scanned code (a path, a line, a URL) or from
 * the server is escaped before it is drawn, and no handler is written into
 * markup: clicks are routed by data-act attributes from one listener (the
 * lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.SniffCore;
  var D = window.SniffDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_FINE = 'sniff-fine-v1';
  var esc = C.esc;
  var plural = C.plural;
  var fmtInt = C.fmtInt;
  var fmtBytes = C.fmtBytes;
  var SEV_ICON = C.SEV_ICON;
  var SEV_WORD = C.SEV_WORD;
  var CAT_WORD = C.CAT_WORD;

  var state = {
    me: null,
    view: 'start',       // start | scanning | report
    report: null,        // SniffCore.scan(...) - in memory only
    fine: {},            // finding id -> looked at, per scan fingerprint (localStorage)
    filter: 'all',       // all | high | medium | low | info | flow
    open: {},            // finding id -> expanded
    opinions: {},        // finding id -> model answer (this tab only)
    review: null,        // whole-scan opinion (this tab only)
    texts: null,         // path -> file text, for building model payloads (this tab only)
    progress: { done: 0, total: 0, phase: '' },
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
  function pill(sev, word) { return '<span class="pill r-' + sev + '"><span aria-hidden="true">' + SEV_ICON[sev] + '</span>' + esc(word || SEV_WORD[sev]) + '</span>'; }
  function rich(s) { return esc(s).replace(/`([^`]{1,300})`/g, '<code>$1</code>'); }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. The scan and the report stay free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function meteredError(err, box, retry) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount('Asking AI uses about a cent of AI credit, so it needs a free account (it comes with $2).', retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }

  /* ---------------- "looked at - fine", per scan ---------------- */

  function loadFine() {
    state.fine = {};
    if (!state.report) return;
    var all = recall(K_FINE);
    var mine = all && all.scans && all.scans[state.report.fingerprint];
    if (mine && mine.ids && typeof mine.ids === 'object') {
      var known = {};
      state.report.findings.forEach(function (f) { known[f.id] = 1; });
      Object.keys(mine.ids).forEach(function (id) { if (known[id]) state.fine[id] = 1; });
    }
  }
  function saveFine() {
    if (!state.report) return;
    var all = recall(K_FINE);
    if (!all || typeof all !== 'object' || !all.scans) all = { v: 1, scans: {} };
    var n = Object.keys(state.fine).length;
    if (n) all.scans[state.report.fingerprint] = { at: Date.now(), ids: state.fine };
    else delete all.scans[state.report.fingerprint];
    var keys = Object.keys(all.scans).sort(function (x, y) { return (all.scans[y].at || 0) - (all.scans[x].at || 0); });
    keys.slice(30).forEach(function (k) { delete all.scans[k]; });
    keep(K_FINE, all);
  }

  /* ---------------- routing ---------------- */

  function go(where) {
    if (where === 'report' && state.report) state.view = 'report';
    else state.view = 'start';
    history.pushState(null, '', BASE + '#' + where);
    draw(); scrollTo(0, 0);
  }
  function route() {
    var h = (location.hash || '').replace(/^#/, '');
    if (h === 'sample') return runDemo('weather');
    if (h === 'clean') return runDemo('tidy');
    if (h === 'report' && state.report) { state.view = 'report'; return draw(); }
    state.view = 'start'; draw();
  }
  window.addEventListener('popstate', route);

  function draw() {
    closeSheet(true);
    var main = $('#main');
    document.body.classList.toggle('has-tabs', false);
    if (state.view === 'scanning') { main.innerHTML = scanningHtml(); return; }
    if (state.view === 'report' && state.report) { main.innerHTML = reportHtml(); return; }
    main.innerHTML = startHtml(); wireStart();
  }

  /* ---------------- first run ---------------- */

  function startHtml() {
    var html = '<section class="hero"><div class="stack" aria-hidden="true">' +
      ['#ff7eb0:92%', '#b9a5ff:70%', '#9cc3ff:52%', '#8f86b8:100%', '#8f86b8:86%', '#8f86b8:96%', '#8f86b8:64%', '#8f86b8:88%'].map(function (s) { var p = s.split(':'); return '<span style="background:' + p[0] + ';width:' + p[1] + '"></span>'; }).join('') + '</div>' +
      '<p class="kicker"><span aria-hidden="true">🐽</span> Vet it before you run it</p>' +
      '<h1>See where an app could send your data — before you install it.</h1>' +
      '<p>A browser extension, an npm or PyPI package, a repo, an AI-built tool from one person. Drop it here and Sniff reads it on your device — nothing is uploaded — and shows what it reads, where it could send it, and what it does to hide.</p>' +
      '<div class="btns"><button class="btn primary big" type="button" data-act="trysample">Try a sample</button><button class="btn ghost big" type="button" data-act="pickfolder-hero">Scan your own</button></div>' +
      '<div class="trust"><span class="ico" aria-hidden="true">🔒</span><div><b>Nothing leaves your device for the scan.</b> The code is read here, in your browser. The two optional AI buttons send only the few lines you pick and confirm — never the whole thing.</div></div></section>';

    html += '<section class="card" style="margin-top:14px"><div class="drop big" id="drop" role="button" tabindex="0" aria-label="Drop a folder or an archive, or choose files">' +
      '<span class="ico" aria-hidden="true">📥</span><h2>Drop a folder or an archive</h2>' +
      '<p class="muted" style="margin:0">…or tap to choose. Read on your device.</p>' +
      '<div class="kinds"><code>folder</code><code>.zip</code><code>.crx</code><code>.tgz / .tar.gz</code></div>' +
      '<div class="sample-row"><label class="btn small ghost filepick">Choose a folder<input type="file" id="pickFolder" webkitdirectory directory multiple></label>' +
      '<label class="btn small ghost filepick">Choose a file<input type="file" id="pickFile" accept=".zip,.crx,.xpi,.tgz,.gz,.tar,.js,.mjs,.cjs,.ts,.py,.sh,.ps1,.json"></label>' +
      '<button class="btn small ghost" type="button" data-act="togglepaste">Paste code</button></div>' +
      (state.showPaste ? '<div style="width:100%;margin-top:8px"><textarea class="input code" id="pasteCode" rows="7" placeholder="Paste a script, a manifest.json, a package.json…"></textarea><div class="btns" style="margin-top:8px"><button class="btn small" type="button" data-act="scanpaste">Scan it</button></div></div>' : '') +
      '</div>' +
      '<div class="sample-row" style="margin-top:12px"><button class="btn small" type="button" data-act="trysample">▲ Try the "Weather Pal" sample</button><button class="btn small ghost" type="button" data-act="tryclean">✓ Try a clean one</button></div>' +
      '<p class="small muted center" style="margin:8px 0 0">The samples are made up, and labelled so. The suspicious bits point nowhere real.</p>' +
      '</section>';

    html += '<div class="how">' +
      ['📥::Drop it in::A folder, a .zip or .crx extension, an npm .tgz, or pasted code. Read in your browser, in a worker — never uploaded.',
       '🗺️::See the data map::What the code can read (cookies, keys, env, clipboard) joined to where it could send each one, risky destinations first.',
       '🔎::Read the findings::Every source, sink, hidden blob, install-time script and extension permission, in plain words, with file and line. Mark the ones you have checked.'].map(function (s, i) {
        var p = s.split('::');
        return '<div class="card"><div class="n" aria-hidden="true">' + (i + 1) + '</div><h2><span aria-hidden="true">' + p[0] + '</span> ' + esc(p[1]) + '</h2><p>' + esc(p[2]) + '</p></div>';
      }).join('') + '</div>';

    html += '<div class="grid2" style="margin-top:14px"><section class="card"><p class="lab">It looks for things worth stealing</p><ul class="chips">' +
      ['🍪 Cookies & sessions', '🔑 Env vars & API keys', '📋 The clipboard', '⌨️ Keystrokes', '🗂️ ~/.ssh, ~/.aws, .npmrc, .env', '🌐 Browser passwords', '👛 Crypto wallets', '🕑 Browsing history'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>' +
      '<section class="card"><p class="lab">…and the ways out, and the tricks</p><ul class="chips">' +
      ['📡 fetch, sockets, curl', '📨 A Discord/Telegram webhook', '🫥 A raw IP or a tunnel', '🧩 base64 / eval / packed code', '⏰ Runs only after a date', '📦 postinstall scripts', '🧱 <all_urls> on every page', '🐍 subprocess, requests, urllib'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section></div>';

    html += '<div class="privacy-line" style="max-width:none"><span aria-hidden="true">👀</span><div><b>Static reading, not proof.</b> Sniff reads the code; it does not run it. It finds what the code <em>could</em> do. Code that builds its calls while it runs can hide from any reader — so read what it flags, and read the rest too.</div></div>';
    html += footer();
    return html;
  }
  function wireStart() {
    var drop = $('#drop');
    if (drop) {
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { if (ev === 'drop') return; drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); handleDrop(e.dataTransfer); });
      drop.addEventListener('click', function (e) { if (e.target === drop || (e.target.classList && e.target.classList.contains('ico')) || e.target.tagName === 'H2') $('#pickFolder').click(); });
      drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#pickFolder').click(); } });
    }
    var pf = $('#pickFolder'); if (pf) pf.addEventListener('change', function (e) { filesFromInput(e.target.files); e.target.value = ''; });
    var pfi = $('#pickFile'); if (pfi) pfi.addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) oneFile(f); e.target.value = ''; });
  }

  /* ---------------- reading what was dropped ---------------- */

  var ARCHIVE_RE = /\.(zip|crx|xpi|whl|jar|tgz|gz|tar)$/i;
  function oneFile(file) {
    if (ARCHIVE_RE.test(file.name) || file.size > 2 * 1024 * 1024) { archive(file); return; }
    file.arrayBuffer().then(function (buf) { filesToWorker([{ path: file.name, bytes: buf }], file.name); });
  }
  function archive(file) {
    if (file.size > C.LIMITS.inputBytes) { toast('That file is over ' + fmtBytes(C.LIMITS.inputBytes) + '. Unpack it and drop the folder.', 4600); return; }
    startScan();
    file.arrayBuffer().then(function (buf) { post({ op: 'archive', name: file.name, bytes: buf }, [buf]); });
  }
  function filesFromInput(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    if (files.length === 1 && ARCHIVE_RE.test(files[0].name)) { oneFile(files[0]); return; }
    readAll(files.map(function (f) { return { file: f, path: f.webkitRelativePath || f.name }; }), files[0] && files[0].webkitRelativePath ? files[0].webkitRelativePath.split('/')[0] : '');
  }
  function handleDrop(dt) {
    if (!dt) return;
    var items = dt.items ? Array.prototype.slice.call(dt.items) : [];
    var entries = items.map(function (it) { return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; }).filter(Boolean);
    if (entries.length) {
      if (entries.length === 1 && entries[0].isFile && ARCHIVE_RE.test(entries[0].name)) { entries[0].file(function (f) { oneFile(f); }); return; }
      startScan();
      var out = [], name = entries.length === 1 && entries[0].isDirectory ? entries[0].name : '';
      walkEntries(entries, '', out).then(function () {
        if (!out.length) { showScanError('Nothing readable was in there.'); return; }
        readAll(out, name);
      });
      return;
    }
    var fs = dt.files ? Array.prototype.slice.call(dt.files) : [];
    if (fs.length === 1) { oneFile(fs[0]); return; }
    if (fs.length) readAll(fs.map(function (f) { return { file: f, path: f.name }; }), '');
  }
  function walkEntries(entries, prefix, out) {
    return entries.reduce(function (p, entry) {
      return p.then(function () {
        if (out.length >= C.LIMITS.entries) return;
        if (entry.isFile) return new Promise(function (res) { entry.file(function (f) { out.push({ file: f, path: prefix + entry.name }); res(); }, res); });
        if (entry.isDirectory) {
          if (C.skipDir(entry.name)) return;
          var rd = entry.createReader();
          return new Promise(function (res) {
            var kids = [];
            (function more() { rd.readEntries(function (batch) { if (!batch.length) { walkEntries(kids, prefix + entry.name + '/', out).then(res); return; } kids = kids.concat(Array.prototype.slice.call(batch)); more(); }, res); }());
          });
        }
      });
    }, Promise.resolve());
  }
  function readAll(items, name) {
    if (!items.length) return;
    if (state.view !== 'scanning') startScan();
    items = items.slice(0, C.LIMITS.entries);
    var files = [], i = 0;
    (function next() {
      if (i >= items.length) { filesToWorker(files, name); return; }
      var it = items[i++];
      setProgress(i, items.length, 'read');
      if (it.file.size > C.LIMITS.fileBytes * 2) { files.push({ path: it.path, bytes: new ArrayBuffer(0) }); return next(); }
      it.file.arrayBuffer().then(function (buf) { files.push({ path: it.path, bytes: buf }); next(); }, function () { next(); });
    }());
  }
  function filesToWorker(files, name) {
    if (!files.length) { showScanError('No files to read.'); return; }
    if (state.view !== 'scanning') startScan();
    var transfer = files.map(function (f) { return f.bytes; });
    post({ op: 'files', files: files, name: name }, transfer);
  }

  function runDemo(which) {
    state.view = 'start';
    var d = which === 'tidy' ? D.tidy() : D.weather();
    startScan(d.name);
    post({ op: 'demo', which: which, name: d.name, entries: d.entries });
  }

  /* ---------------- the worker ---------------- */

  var worker = null, reqId = 0, curReq = 0;
  function startWorker() {
    try {
      worker = new Worker('scan-worker.js');
      worker.onmessage = onWorker;
      worker.onerror = function () { showScanError('The scanner stopped unexpectedly. Try a smaller drop.'); };
    } catch (e) { worker = null; }
  }
  function post(msg, transfer) {
    if (!worker) startWorker();
    if (!worker) { scanInMain(msg); return; }
    curReq = ++reqId; msg.id = curReq;
    try { worker.postMessage(msg, transfer || []); } catch (e) { scanInMain(msg); }
  }
  function onWorker(ev) {
    var m = ev.data || {};
    if (m.id && m.id !== curReq) return;
    if (m.op === 'progress') { setProgress(m.done, m.total, m.phase); return; }
    if (m.op === 'report') { onReport(m.report, m.texts); return; }
    if (m.op === 'error') { showScanError(m.message); return; }
  }
  // If the worker cannot start (rare), paste still works on the main thread.
  function scanInMain(msg) {
    try {
      if (msg.op === 'paste') { var pf = C.pastedFile(msg.text); var rpt = C.scan([pf], { name: 'Pasted code', source: 'paste' }); var tx = {}; tx[pf.path] = pf.text; onReport(rpt, tx); return; }
      showScanError('This browser could not start the scanner. Paste the code instead.');
    } catch (e) { showScanError(String(e && e.message || e)); }
  }

  function startScan(name) { state.view = 'scanning'; state.progress = { done: 0, total: 0, phase: 'read', name: name || '' }; draw(); scrollTo(0, 0); }
  function setProgress(done, total, phase) {
    state.progress.done = done; state.progress.total = total; state.progress.phase = phase;
    var el = $('#scanProg'); if (!el) return;
    var pct = total ? Math.round(100 * done / total) : 0;
    $('#scanPhase', el).textContent = phase === 'unpack' ? 'Unpacking…' : phase === 'rules' ? 'Reading the code…' : 'Reading files…' + (total ? ' ' + done + ' of ' + total : '');
    var bar = $('#scanBar', el); if (bar) bar.style.width = (phase === 'rules' ? 100 : pct) + '%';
  }
  function scanningHtml() {
    return '<section class="card scanning" id="scanProg" aria-live="polite"><div class="spin" aria-hidden="true"></div>' +
      '<h2 style="margin:0">' + (state.progress.name ? esc(state.progress.name) : 'Reading it on your device') + '</h2>' +
      '<p class="muted" id="scanPhase" style="margin:0">Reading files…</p>' +
      '<div class="pbar" style="width:min(320px,80vw)"><span id="scanBar" style="width:5%"></span></div>' +
      '<p class="small muted" style="margin:0">Nothing is being uploaded.</p></section>';
  }
  function showScanError(msg) {
    state.view = 'start';
    var main = $('#main');
    main.innerHTML = '<section class="card"><p class="err" role="alert">' + esc(msg || 'That could not be read.') + '</p><button class="btn ghost" type="button" data-act="home">Back</button></section>' + startHtml();
    wireStart();
  }

  function onReport(report, texts) {
    state.report = report;
    state.texts = texts || {};
    if (report.source === 'demo') buildDemoTexts(report);
    state.filter = 'all'; state.open = {}; state.opinions = {}; state.review = null;
    loadFine();
    state.view = 'report';
    history.replaceState(null, '', BASE + '#report');
    draw(); scrollTo(0, 0);
  }
  // The file texts, kept in this tab only, so a payload can be built for the
  // two AI buttons. For a demo they are in SniffDemo; otherwise the worker
  // already read them, but to keep memory down we re-read on demand from the
  // report is not possible, so we snapshot the small files we may need.
  function buildDemoTexts(report) {
    var all = D.WEATHER.concat(D.TIDY);
    var root = report.root;
    all.forEach(function (e) { var p = C.normPath(e.path); if (root && p.indexOf(root + '/') === 0) p = p.slice(root.length + 1); state.texts[p] = e.text; });
  }
  function getText(path) { return state.texts && Object.prototype.hasOwnProperty.call(state.texts, path) ? state.texts[path] : null; }

  /* ---------------- the report ---------------- */

  function visibleFindings() {
    var f = state.report.findings;
    if (state.filter === 'all') return f;
    if (state.filter === 'flow') return f.filter(function (x) { return x.cat === 'flow'; });
    return f.filter(function (x) { return x.sev === state.filter; });
  }
  function reportHtml() {
    var r = state.report;
    var v = C.verdict(r, state.fine);
    var html = verdictHtml(r, v);
    html += mapHtml(r);
    html += filtersHtml(r, v);
    html += findingsHtml(r);
    html += destsHtml(r);
    html += permsHtml(r);
    html += filesHtml(r);
    html += footer();
    return html;
  }
  function verdictHtml(r, v) {
    var cls = v.level === 'high' ? 'v-high' : v.level === 'medium' ? 'v-medium' : v.level === 'clear' ? 'v-clear' : 'v-low';
    var badge = v.level === 'high' ? '▲ Look before you install' : v.level === 'medium' ? '◆ Worth a look' : v.level === 'clear' ? '✓ Nothing reaches out' : '● Nothing stands out';
    var h = '<section class="card verdict ' + cls + '"><span class="vbadge">' + esc(badge) + '</span>' +
      '<h1>' + esc(v.title) + '</h1>' + (v.sub ? '<p class="vsub">' + esc(v.sub) + '</p>' : '') +
      '<p class="muted small" style="margin:0">' + esc(r.name || 'Scanned code') + (r.kind === 'extension' ? ' · browser extension' + (r.mv ? ' (MV' + r.mv + ')' : '') : r.kind === 'npm' ? ' · npm package' : r.kind === 'python' ? ' · Python package' : '') + ' · ' + plural(r.files.length, 'file') + ' read, ' + fmtInt(r.lines) + ' lines' + (v.fine ? ' · ' + v.fine + ' marked looked-at' : '') + '</p>' +
      '<div class="btns" style="margin-top:4px">' +
        (r.findings.length ? '<button class="btn ai small" type="button" data-act="review"><span aria-hidden="true">✨</span> Second opinion from AI</button>' : '') +
        '<button class="btn ghost small" type="button" data-act="md">Export report (.md)</button>' +
        '<button class="btn ghost small" type="button" data-act="json">.json</button>' +
        '<button class="btn ghost small" type="button" data-act="home">Scan another</button></div>';
    if (state.review) h += opinionHtml(state.review, null);
    h += '</section>';
    return h;
  }
  function mapHtml(r) {
    var rows = r.map.rows;
    if (!rows.length) {
      if (!r.reachesOut) return '<section class="card"><div class="sec-head"><h2>🗺️ Data map</h2></div><p class="muted" style="margin:0">Sniff found no code that sends anything out. Nothing to map — which rules out the obvious, not the clever. Read it anyway.</p></section>';
      return '<section class="card"><div class="sec-head"><h2>🗺️ Data map</h2></div><p class="muted" style="margin:0">It talks to the internet, but Sniff did not read any sensitive source as flowing to it. The reads and the ways out are below; check they do not meet in a way static reading missed.</p>' +
        mapCols(r) + '</section>';
    }
    var h = '<section class="card"><div class="sec-head"><h2>🗺️ Where your data could go</h2><span class="small muted">' + plural(rows.length, 'path') + '</span></div>' +
      '<p class="muted small" style="margin:-2px 0 10px">A source joined to a way out. That the two meet is read from the code, not watched happening.</p><div class="map">';
    h += rows.map(function (row) {
      var cls = row.sev === 'high' ? 'e-high' : row.sev === 'medium' ? 'e-medium' : 'e-low';
      return '<button class="maprow ' + cls + '" type="button" data-act="openfinding" data-id="' + esc(row.id) + '">' +
        '<span class="node"><b>' + rich(row.what) + '</b><small>' + esc(row.from) + '</small></span>' +
        '<span class="arrow"><i aria-hidden="true">→</i><span>sends to</span></span>' +
        '<span class="node to"><b>' + rich(row.label) + '</b><small>' + esc(row.at) + '</small></span></button>';
    }).join('') + '</div>' + mapCols(r) + '</section>';
    return h;
  }
  function mapCols(r) {
    var reads = r.map.reads, ways = r.map.ways;
    if (!reads.length && !ways.length) return '';
    return '<div class="mapcols" style="margin-top:12px">' +
      (reads.length ? '<div class="card"><p class="lab">It can read</p><ul class="taglist">' + reads.map(function (x) { return '<li>' + rich(x) + '</li>'; }).join('') + '</ul></div>' : '') +
      (ways.length ? '<div class="card"><p class="lab">Ways out it has</p><ul class="taglist">' + ways.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '') + '</div>';
  }
  function filtersHtml(r, v) {
    var o = v.open;
    var items = [['all', 'All', r.findings.length, '']];
    ['high', 'medium', 'low', 'info'].forEach(function (s) { if (r.counts[s]) items.push([s, SEV_WORD[s], r.counts[s], s]); });
    if (r.flows) items.push(['flow', 'Flows', r.flows, 'flow']);
    return '<div class="card" style="padding:12px 14px"><ul class="tallies" role="group" aria-label="Filter findings">' + items.map(function (it) {
      return '<li><button type="button" data-act="filter" data-f="' + it[0] + '" aria-pressed="' + (state.filter === it[0]) + '">' + (it[3] ? '<span class="dot s-' + it[3] + '" aria-hidden="true"></span>' : '') + esc(it[1]) + ' <span class="num">' + it[2] + '</span></button></li>';
    }).join('') + '</ul></div>';
  }
  function findingsHtml(r) {
    var list = visibleFindings();
    if (!list.length) return '<section class="card center"><p class="muted" style="margin:0">Nothing in that group.</p></section>';
    return '<ul class="flist" style="margin-top:14px">' + list.map(findingRow).join('') + '</ul>';
  }
  function findingRow(f) {
    var open = state.open[f.id], fine = state.fine[f.id];
    var edge = f.sev === 'high' ? 'e-high' : f.sev === 'medium' ? 'e-medium' : f.sev === 'low' ? 'e-low' : 'e-info';
    var where = f.file + (f.line ? ':' + f.line : '') + (f.count > 1 ? ' +' + (f.count - 1) : '');
    var h = '<li class="fitem ' + edge + (fine ? ' done' : '') + '" id="fi-' + esc(f.id) + '"><div class="fhead">' +
      '<label class="tick" title="Looked at - fine"><input type="checkbox" data-fine="' + esc(f.id) + '"' + (fine ? ' checked' : '') + ' aria-label="Mark looked at and fine"></label>' +
      '<button class="fopen" type="button" data-act="openfinding" data-id="' + esc(f.id) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="ftitle">' + rich(f.title) + '</span>' + pill(f.sev) +
      '<span class="fmeta"><span>' + esc(CAT_WORD[f.cat] || f.cat) + '</span><span class="mono">' + esc(where) + '</span>' + (fine ? '<span class="small">✓ looked at</span>' : '') + '</span>' +
      '<span class="chev" aria-hidden="true">' + (open ? '▾' : '▸') + '</span></button></div>';
    if (open) h += '<div class="fbody">' + findingBody(f) + '</div>';
    return h + '</li>';
  }
  function findingBody(f) {
    var h = '<p class="finding-why">' + rich(f.why || '') + '</p>';
    if (f.decoded) h += '<div class="decoded"><b>Decoded, it reads</b><pre class="snippet" style="white-space:pre-wrap">' + esc(f.decoded) + '</pre></div>';
    if (f.cat === 'flow') {
      h += '<ul class="where">' + [['Reads', f.source], ['via', f.handoff], ['Sends', f.sink]].filter(function (p) { return p[1]; }).map(function (p) {
        return '<li>' + esc(p[0]) + ' <b>' + esc((p[1].file || '') + (p[1].line ? ':' + p[1].line : '')) + '</b></li>';
      }).join('') + '</ul>';
      [f.source, f.sink].forEach(function (l) { if (l && l.snippet) h += '<pre class="snippet">' + esc(l.snippet) + '</pre>'; });
    } else {
      if (f.snippet) h += '<pre class="snippet">' + esc(f.snippet) + '</pre>';
      if (f.lines && f.lines.length > 1) h += '<ul class="where">' + f.lines.slice(0, 20).map(function (l) { return '<li>' + esc(f.file + ':' + l) + '</li>'; }).join('') + (f.count > f.lines.length ? '<li class="muted">+' + (f.count - f.lines.length) + ' more</li>' : '') + '</ul>';
    }
    if (f.partOf) h += '<p class="part-note">This is one end of a flow above — it is counted there, not twice.</p>';
    if (state.opinions[f.id]) h += opinionHtml(state.opinions[f.id], f.id);
    h += '<div class="btns" style="margin-top:10px">' +
      '<button class="btn ai small" type="button" data-act="explain" data-id="' + esc(f.id) + '"><span aria-hidden="true">✨</span> ' + (state.opinions[f.id] ? 'Ask AI again' : 'Explain with AI') + '</button>' +
      '<button class="btn ghost small" type="button" data-act="fine" data-id="' + esc(f.id) + '">' + (state.fine[f.id] ? 'Un-mark' : 'Looked at — fine') + '</button></div>';
    return h;
  }
  function destsHtml(r) {
    if (!r.destinations.length) return '';
    return '<section class="card"><div class="sec-head"><h2>🌐 Destinations</h2><span class="small muted">' + plural(r.destinations.length, 'host') + '</span></div>' +
      '<div class="dests-wrap"><table class="dests"><thead><tr><th>Host</th><th>What it is</th><th>Where</th></tr></thead><tbody>' +
      r.destinations.map(function (d) {
        return '<tr class="d-' + d.tag + '"><td class="host">' + esc(d.host || d.url) + (d.hidden ? ' <span class="pill r-high" style="font-size:.7rem">hidden</span>' : '') + '</td>' +
          '<td><span class="pill t-' + d.tag + '">' + esc(C.TAG_WORD[d.tag]) + '</span>' + (d.sent ? ' <span class="small">data sent</span>' : '') + (d.dep ? ' <span class="small muted">dependency</span>' : '') + '<div class="small muted" style="margin-top:2px">' + esc(d.why) + '</div></td>' +
          '<td class="refs">' + d.refs.slice(0, 4).map(function (x) { return esc(x.file + ':' + x.line); }).join('<br>') + (d.count > 4 ? '<br>+' + (d.count - 4) : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      // Below 640px the table becomes one stacked card per host (CSS picks).
      '<ul class="dest-cards">' + r.destinations.map(function (d) {
        return '<li class="dcard d-' + d.tag + '"><div class="dhost">' + esc(d.host || d.url) + '</div>' +
          '<div class="dtags"><span class="pill t-' + d.tag + '">' + esc(C.TAG_WORD[d.tag]) + '</span>' + (d.hidden ? '<span class="pill r-high">hidden</span>' : '') + (d.sent ? '<span class="small">data sent</span>' : '') + (d.dep ? '<span class="small muted">dependency</span>' : '') + '</div>' +
          '<p class="dwhy">' + esc(d.why) + '</p>' +
          '<p class="dwhere">' + d.refs.slice(0, 4).map(function (x) { return '<code>' + esc(x.file + ':' + x.line) + '</code>'; }).join(' ') + (d.count > 4 ? ' <span class="muted">+' + (d.count - 4) + '</span>' : '') + '</p></li>';
      }).join('') + '</ul></section>';
  }
  function permsHtml(r) {
    if (!r.permissions.length) return '';
    return '<section class="card"><div class="sec-head"><h2>🧩 What the extension asks for</h2></div><ul class="taglist">' +
      r.permissions.map(function (p) { return '<li>' + pill(p.sev === 'info' ? 'info' : p.sev) + '<span><code>' + esc(p.name) + '</code> — ' + esc(p.words) + (p.optional ? ' <span class="small muted">(optional)</span>' : '') + '</span></li>'; }).join('') + '</ul></section>';
  }
  function filesHtml(r) {
    var tagged = r.files.filter(function (f) { return f.install || f.background || f.content; });
    var sk = Object.keys(r.skippedCounts || {});
    var h = '<section class="card"><details><summary style="cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:700">' + plural(r.files.length, 'file') + ' read' + (sk.length ? ', ' + plural(sk.reduce(function (t, k) { return t + r.skippedCounts[k]; }, 0), 'skipped', 'skipped') : '') + ' — what Sniff looked at</summary><div style="margin-top:10px">';
    if (tagged.length) {
      h += '<p class="lab">Files that run on their own</p><ul class="files-list">' + tagged.map(function (f) {
        var tags = [f.install ? 'runs at install' : '', f.background ? 'background' : '', f.content ? 'every page' : ''].filter(Boolean);
        return '<li><span class="fp">' + esc(f.path) + '</span><span class="tagn">' + esc(tags.join(' · ')) + '</span></li>';
      }).join('') + '</ul>';
    }
    h += '<p class="lab" style="margin-top:12px">Read (' + r.files.length + ')</p><ul class="files-list">' + r.files.slice(0, 200).map(function (f) {
      return '<li><span class="fp">' + esc(f.path) + (f.cut ? ' <span class="small muted">(cut)</span>' : '') + '</span><span class="small muted">' + esc(C.LANG_WORD[f.lang] || f.lang) + ' · ' + fmtBytes(f.bytes) + '</span></li>';
    }).join('') + '</ul>' + (r.files.length > 200 ? '<p class="small muted">…and ' + (r.files.length - 200) + ' more.</p>' : '');
    if (sk.length) h += '<p class="lab" style="margin-top:12px">Not read, and why</p><ul class="skipbox">' + sk.map(function (k) { return '<li>' + esc(C.REASON_WORDS[k] || k) + ': <b>' + r.skippedCounts[k] + '</b></li>'; }).join('') + '</ul>';
    if (r.notes && r.notes.length) h += '<div class="note" style="margin-top:12px"><ul style="margin:0;padding-left:20px">' + r.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></div>';
    h += '</div></details></section>';
    return h;
  }
  function footer() {
    return '<footer class="foot"><p>🔒 Code is read on this device and never uploaded. The two AI buttons send only the lines you confirm.</p><p>Static reading finds what code <em>could</em> do — it is a strong first look, not a guarantee.</p></footer>';
  }
  function opinionHtml(op, id) {
    return '<div class="opinion" role="region" aria-label="AI opinion"><div class="verd ' + op.verdict + '"><span aria-hidden="true">✨</span>' + esc(C.VERDICT_WORD[op.verdict]) + ' <span class="small muted" style="font-weight:600">· confidence ' + esc(op.confidence) + '</span></div>' +
      '<p style="margin:0">' + esc(op.why) + '</p>' +
      (op.whatToCheck.length ? '<div><p class="lab">What to check</p><ul>' + op.whatToCheck.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '') +
      '<p class="small muted" style="margin:0">AI’s read of the snippets it was shown — not the whole program. Check it against the code.</p></div>';
  }

  /* ---------------- the two AI calls ---------------- */

  function payloadFor(id) {
    var f = state.report.findings.filter(function (x) { return x.id === id; })[0];
    if (!f) return null;
    return C.explainPayload(f, getText);
  }
  function openExplain(id) {
    var f = state.report.findings.filter(function (x) { return x.id === id; })[0];
    if (!f) return;
    var p = payloadFor(id);
    if (!p || p.error) { toast((p && p.error) || 'That finding’s code is not in memory — scan it again.', 4200); return; }
    var shown = JSON.stringify(p, null, 2);
    var n = p.snippets.reduce(function (t, s) { return t + s.lines.length; }, 0);
    var lead = '<p>AI reads the lines around this finding and tells you whether it is a real problem, and what to check.</p>' +
      '<div class="warnbox" role="note"><span aria-hidden="true">⚠️</span><div><b>This sends the code below to an AI provider (Anthropic).</b> ' + esc(plural(n, 'line')) + ' from ' + esc(plural(p.snippets.length, 'file')) + ' — exactly what is shown, and nothing else from the scan. Nothing is stored. Don’t send code you may not share.</div></div>';
    if (!signedIn()) {
      sheet('<h2>✨ Explain this finding</h2>' + lead + '<p class="small muted" style="margin:12px 0 6px"><b>Exactly what would be sent:</b></p><pre class="sent-pre">' + esc(shown) + '</pre>' +
        '<p class="small muted" style="margin-top:12px">It uses about a cent of AI credit, so it needs a free account (it comes with $2). The scan, the map and the report stay free, with no account.</p>' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="signin-explain" data-id="' + esc(id) + '">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button></div>');
      return;
    }
    sheet('<h2>✨ Explain this finding</h2><div id="exLead">' + lead + '</div><details open id="sentBox"><summary style="min-height:44px;cursor:pointer;font-weight:700"><b id="sentLabel">Exactly what will be sent</b></summary><pre class="sent-pre">' + esc(shown) + '</pre></details>' +
      '<div id="exErr"></div><div id="exActs"><label class="confirm"><input type="checkbox" id="exOk"> I understand this sends this code to an AI provider.</label>' +
      '<div class="btns" style="margin-top:10px"><button class="btn" type="button" id="exSend" disabled>Send and explain</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div><p class="small muted" style="margin-top:8px">About a cent of AI credit.</p></div><div id="exOut"></div>', function (root) {
      var ok = $('#exOk', root), send = $('#exSend', root);
      ok.addEventListener('change', function () { send.disabled = !ok.checked; });
      send.addEventListener('click', function () {
        if (!ok.checked) return;
        send.disabled = true; send.textContent = 'Asking…';
        api('POST', 'api/explain', p).then(function (r) {
          var op = C.cleanOpinion(r.opinion);
          if (!op) throw Object.assign(new Error('That answer had nothing usable in it. Try again.'), { status: 422 });
          state.opinions[id] = op; state.open[id] = true;
          $('#exActs', root).hidden = true; $('#exLead', root).hidden = true;
          $('#sentBox', root).open = false; $('#sentLabel', root).textContent = 'What was sent';
          $('#exOut', root).innerHTML = opinionHtml(op, id) + '<div class="btns" style="margin-top:12px"><button class="btn ghost" type="button" data-act="closesheet">Done</button></div>';
          redrawReport(); loadMe();
        }).catch(function (err) { send.disabled = !ok.checked; send.textContent = 'Send and explain'; meteredError(err, $('#exErr', root), function () { openExplain(id); }); });
      });
    });
  }
  function openReview() {
    var p = C.reviewPayload(state.report, getText);
    var shown = JSON.stringify(p, null, 2);
    var lead = '<p>AI reads the whole scan — the findings, the permissions, the destinations — and up to ' + C.LIMITS.reviewSnippets + ' short snippets around the findings that matter, and gives one overall read.</p>' +
      '<div class="warnbox" role="note"><span aria-hidden="true">⚠️</span><div><b>This sends the summary and snippets below to an AI provider (Anthropic).</b> ' + esc(plural(p.snippets.length, 'snippet')) + ', the findings and the host list — never whole files. Nothing is stored.</div></div>';
    if (!signedIn()) {
      sheet('<h2>✨ Second opinion</h2>' + lead + '<p class="small muted" style="margin:12px 0 6px"><b>Exactly what would be sent:</b></p><pre class="sent-pre">' + esc(shown) + '</pre>' +
        '<p class="small muted" style="margin-top:12px">It uses a cent or two of AI credit, so it needs a free account (it comes with $2). The scan and the report stay free.</p>' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="signin-review">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button></div>');
      return;
    }
    sheet('<h2>✨ Second opinion on the scan</h2><div id="rvLead">' + lead + '</div><details id="sentBox"><summary style="min-height:44px;cursor:pointer;font-weight:700"><b id="sentLabel">Exactly what will be sent (' + plural(p.snippets.length, 'snippet') + ')</b></summary><pre class="sent-pre">' + esc(shown) + '</pre></details>' +
      '<div id="rvErr"></div><div id="rvActs"><label class="confirm"><input type="checkbox" id="rvOk"> I understand this sends the summary and snippets to an AI provider.</label>' +
      '<div class="btns" style="margin-top:10px"><button class="btn" type="button" id="rvSend" disabled>Send for a second opinion</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div></div><div id="rvOut"></div>', function (root) {
      var ok = $('#rvOk', root), send = $('#rvSend', root);
      ok.addEventListener('change', function () { send.disabled = !ok.checked; });
      send.addEventListener('click', function () {
        if (!ok.checked) return;
        send.disabled = true; send.textContent = 'Asking…';
        api('POST', 'api/review', p).then(function (r) {
          var op = C.cleanOpinion(r.opinion);
          if (!op) throw Object.assign(new Error('That answer had nothing usable in it. Try again.'), { status: 422 });
          state.review = op;
          $('#rvActs', root).hidden = true; $('#rvLead', root).hidden = true;
          $('#rvOut', root).innerHTML = opinionHtml(op, null) + '<div class="btns" style="margin-top:12px"><button class="btn ghost" type="button" data-act="closesheet">Done</button></div>';
          redrawReport(); loadMe();
        }).catch(function (err) { send.disabled = !ok.checked; send.textContent = 'Send for a second opinion'; meteredError(err, $('#rvErr', root), function () { openReview(); }); });
      });
    });
  }

  function redrawReport() { if (state.view === 'report') { $('#main').innerHTML = reportHtml(); } }

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

  var FREE_LINE = 'Nothing in Sniff needs an account except the two AI buttons — a free account comes with $2 of AI credit, and one account works across every app on this site.';
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">The two AI buttons cost about a cent each. The scan, the map and the report are free and need no account.</p><div id="billing"></div></div>' +
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The scan, the map and the report keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- one click listener ---------------- */

  function fname(ext) { return 'sniff-' + today() + ext; }
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.hasAttribute && t.hasAttribute('data-fine') && state.report) { toggleFine(t.getAttribute('data-fine'), t.checked); }
  });
  function toggleFine(id, on) {
    if (on) state.fine[id] = 1; else delete state.fine[id];
    saveFine();
    var li = $('#fi-' + cssEsc(id)); if (li) li.classList.toggle('done', on);
    var vb = $('.verdict'); if (vb) { var h = document.createElement('div'); h.innerHTML = verdictHtml(state.report, C.verdict(state.report, state.fine)); vb.replaceWith(h.firstChild); }
    var fb = $('#fi-' + cssEsc(id) + ' .fbody'); if (fb) fb.innerHTML = findingBody(state.report.findings.filter(function (x) { return x.id === id; })[0]);
  }
  function cssEsc(s) { return String(s).replace(/[^\w-]/g, '\\$&'); }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); state.report = null; go('start'); break;
      case 'trysample': history.pushState(null, '', BASE + '#sample'); runDemo('weather'); break;
      case 'tryclean': history.pushState(null, '', BASE + '#clean'); runDemo('tidy'); break;
      case 'pickfolder-hero': { var el = $('#pickFolder'); if (el) el.click(); else { go('start'); setTimeout(function () { var e2 = $('#pickFolder'); if (e2) e2.click(); }, 60); } break; }
      case 'togglepaste': state.showPaste = !state.showPaste; draw(); if (state.showPaste) { var ta0 = $('#pasteCode'); if (ta0) ta0.focus(); } break;
      case 'scanpaste': { var ta = $('#pasteCode'); if (ta && ta.value.trim()) { state.view = 'start'; startScan('Pasted code'); post({ op: 'paste', text: ta.value }); } else toast('Paste some code first.'); break; }
      case 'filter': state.filter = t.getAttribute('data-f'); redrawReport(); break;
      case 'openfinding': { var id = t.getAttribute('data-id'); state.open[id] = !state.open[id]; var fi = state.report.findings.filter(function (x) { return x.id === id; })[0]; if (fi && state.filter !== 'all' && state.filter !== fi.sev && !(state.filter === 'flow' && fi.cat === 'flow')) state.filter = 'all'; redrawReport(); var li = $('#fi-' + cssEsc(id)); if (li && state.open[id]) li.scrollIntoView({ block: 'nearest' }); break; }
      case 'fine': { var fid = t.getAttribute('data-id'); toggleFine(fid, !state.fine[fid]); break; }
      case 'explain': openExplain(t.getAttribute('data-id')); break;
      case 'review': openReview(); break;
      case 'signin-explain': { var sid = t.getAttribute('data-id'); openAccount('Asking AI about a finding uses about a cent of AI credit; a free account comes with $2.', function () { openExplain(sid); }); break; }
      case 'signin-review': openAccount('A second opinion uses a cent or two of AI credit; a free account comes with $2.', function () { openReview(); }); break;
      case 'md': download(fname('.md'), 'text/markdown', C.toMarkdown(state.report, state.fine, today())); break;
      case 'json': download(fname('.json'), 'application/json', C.toJson(state.report, state.fine)); break;
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
