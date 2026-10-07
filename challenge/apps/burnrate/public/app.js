/* Burnrate - the page. One file, no build step.
 *
 * TRANSCRIPTS ARE READ HERE AND NOWHERE ELSE. Files are streamed line by
 * line through BurnCore's collector; only numbers and short labels are
 * kept; nothing about them is ever sent. The one request that carries
 * anything about an analysis is "Write our fixes", and it sends
 * BurnCore.fixesSummary - shown to the person in full before it is sent.
 *
 * Every string that came from a transcript (a path, a command, a project
 * name) or from the server is escaped before it is drawn, and no handler is
 * written into markup: clicks are routed by data-act attributes from one
 * listener (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.BurnCore;
  var D = window.BurnDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_LAST = 'burnrate-last-v1';
  var K_PRICES = 'burnrate-prices-v1';
  var K_SEAT = 'burnrate-seat-v1';
  var K_NAME = 'burnrate-name-v1';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }());
  var TABS = [['overview', '📊', 'Overview'], ['waste', '🔥', 'Waste'], ['sessions', '🧵', 'Sessions'], ['team', '👥', 'Team'], ['report', '📤', 'Report']];
  var esc = C.esc;
  var fmtUsd = C.fmtUsd;
  var fmtTok = C.fmtTok;
  var plural = C.plural;

  var state = {
    me: null,
    view: 'start',       // start | load | dash
    tab: 'overview',
    source: null,        // demo | files | saved
    collector: null,     // the live collector while files are being added
    ds: null,            // the dataset (threads of turns) - in memory only
    a: null,             // the analysis
    prices: null,
    sort: 'cost',
    showAll: false,
    loading: null,       // {files, done, bytes, total, cancel}
    loadedPeople: [],    // [{name, files, responses}]
    card: null,          // the drawn summary card: {blob, url}
    fixes: null,
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
    var blob = text instanceof Blob ? text : new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function prices() { return state.prices || C.DEFAULT_PRICES; }
  function personName(i) { var p = state.a && state.a.people[i]; return p ? p.name : 'Someone'; }
  function dayShort(day) {
    var d = new Date(day + 'T12:00:00Z');
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] + ' ' + d.getUTCDate();
  }
  function when(ms) {
    if (!ms) return '';
    try { return new Intl.DateTimeFormat(undefined, { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); } catch (e) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
  }
  function whenShort(ms) {
    if (!ms) return '';
    try { return new Intl.DateTimeFormat(undefined, { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); } catch (e) { return new Date(ms).toISOString().slice(5, 16).replace('T', ' '); }
  }
  function rangeText(a) {
    if (!a.range.from) return 'no dated turns';
    var f = C.dateLabel(a.range.from, TZ), t = C.dateLabel(a.range.to, TZ);
    return f === t ? f : f.replace(/, \d{4}$/, '') + ' – ' + t;
  }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Every finding and its fix stay free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function meteredError(err, box, retry) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount('Writing the fixes uses about a cent of AI credit, so it needs a free account (it comes with $2).', retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }

  /* ---------------- analysis ---------------- */

  function analyse() {
    state.a = C.analyse(state.ds, prices(), { tz: TZ });
    state.a.demo = state.source === 'demo';
    state.card = null;
  }
  function saveLast() {
    if (state.source !== 'files' || !state.a) return;
    var s = C.toSaved(state.a);
    if (!keep(K_LAST, s)) { s.sessions = s.sessions.slice(0, 60); keep(K_LAST, s); }
  }
  function openDemo() {
    var col = C.createCollector();
    var y = C.addDays(C.localDay(Date.now(), TZ), -1);
    D.feed(col, y);
    state.ds = col.finish();
    state.collector = null;
    state.source = 'demo';
    state.loadedPeople = [];
    analyse();
    state.view = 'dash';
    go('overview');
  }
  function openSaved() {
    var s = C.cleanSaved(recall(K_LAST));
    if (!s) { keep(K_LAST, null); toast('That analysis could not be read back. Load the files again.'); draw(); return; }
    state.a = s; state.ds = null; state.source = 'saved'; state.view = 'dash';
    go('overview');
  }

  /* ---------------- routing ---------------- */

  function go(tab) {
    if (tab === 'start' || tab === 'load') { state.view = tab; history.pushState(null, '', BASE + '#' + tab); draw(); scrollTo(0, 0); return; }
    state.view = 'dash'; state.tab = tab;
    history.pushState(null, '', BASE + '#' + tab);
    draw(); scrollTo(0, 0);
  }
  function route() {
    var h = (location.hash || '').replace(/^#/, '');
    if (h === 'example') return openDemo();
    if (h === 'load') { state.view = 'load'; return draw(); }
    if (TABS.some(function (t) { return t[0] === h; })) {
      if (!state.a) {
        var s = C.cleanSaved(recall(K_LAST));
        if (s) { state.a = s; state.source = 'saved'; } else { state.view = 'start'; return draw(); }
      }
      state.view = 'dash'; state.tab = h; return draw();
    }
    state.view = 'start'; draw();
  }
  window.addEventListener('popstate', route);

  function draw() {
    closeSheet(true);
    var main = $('#main');
    document.body.classList.toggle('has-tabs', state.view === 'dash');
    if (state.view === 'load') { main.innerHTML = loadHtml(); wireLoad(); return; }
    if (state.view !== 'dash' || !state.a) { main.innerHTML = startHtml(); return; }
    var html = stripHtml();
    html += '<nav class="tabbar dk-tabbar" aria-label="Analysis"><div class="tabbar-inner"><a class="rail-brand" href="./#start" data-act="home"><span aria-hidden="true">🔥</span>Burnrate</a>' + TABS.map(function (t) {
      return '<a class="tab' + (t[0] === state.tab ? ' on' : '') + '" href="#' + t[0] + '" data-act="tab" data-tab="' + t[0] + '"' + (t[0] === state.tab ? ' aria-current="page"' : '') + '><span aria-hidden="true">' + t[1] + '</span>' + t[2] + '</a>';
    }).join('') + '</div></nav>';
    html += '<div id="tab"></div>' + footer();
    main.innerHTML = html;
    drawTab();
  }
  function drawTab() {
    var el = $('#tab');
    if (!el) return;
    if (state.tab === 'waste') el.innerHTML = wasteHtml();
    else if (state.tab === 'sessions') el.innerHTML = sessionsHtml();
    else if (state.tab === 'team') el.innerHTML = teamHtml();
    else if (state.tab === 'report') el.innerHTML = reportHtml();
    else el.innerHTML = overviewHtml();
    drawCharts();
    if (state.tab === 'team') wireTeam();
  }

  function footer() {
    return '<footer class="foot"><p>🔒 Transcripts are read on this device and never uploaded.</p><p>Every dollar is an estimate at <button class="link-btn" type="button" data-act="prices">list prices as of ' + esc(C.dateLabel(Date.parse(C.PRICES_AS_OF + 'T12:00:00Z'), 'UTC')) + (state.a && state.a.prices.edited ? ' (edited)' : '') + '</button>.</p></footer>';
  }

  /* ---------------- first run ---------------- */

  function startHtml() {
    var last = C.cleanSaved(recall(K_LAST));
    var html = '<section class="hero"><div class="kicker"><span aria-hidden="true">🔥</span>For anyone paying for Claude Code</div>' +
      '<h1>See where your coding agent’s tokens go - and cut the waste.</h1>' +
      '<p>Burnrate reads your Claude Code session files, prices every turn, and finds the habits that burn money: caches gone cold, files read again and again, giant test logs, sessions left to bloat. Each one with dollars attached and a fix you can paste.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="example">See an example team</button><button class="btn big ghost" type="button" data-act="load">Analyse my sessions</button></div>' +
      '<div class="trust"><span class="ico" aria-hidden="true">🔒</span><span><b>Read on this device. Nothing is uploaded.</b> Transcripts contain your code, so they never leave this browser. No account needed.</span></div></section>';
    if (last) {
      html += '<section class="card"><div class="sec-head"><h2>Your last analysis</h2><span class="small muted">saved ' + esc(when(last.savedAt)) + ' on this device</span></div>' +
        '<p><b class="num">' + esc(fmtUsd(last.totals.usd)) + '</b> across ' + esc(plural(last.totals.sessions, 'session')) + ' (' + esc(rangeText(last)) + '), about <b>' + esc(last.totals.avoidPct) + '%</b> avoidable.</p>' +
        '<div class="btns"><button class="btn" type="button" data-act="openlast">Open it</button><button class="btn ghost" type="button" data-act="clearlast">Clear it</button></div><p class="small muted" style="margin-top:8px">Numbers only - no transcript is kept.</p></section>';
    }
    html += '<section class="card"><h2>What it finds</h2><p class="muted">Seven patterns, each priced at list prices and ranked by dollars, each with a concrete fix.</p><ul class="kinds">' +
      C.KIND_IDS.map(function (k) { return '<li><span aria-hidden="true">' + C.KINDS[k].icon + '</span>' + esc(C.KINDS[k].title) + '</li>'; }).join('') + '</ul>' +
      '<div class="points">' +
      '<div class="point"><span class="ico" aria-hidden="true">📊</span><div><b>The bill, explained</b><p class="small muted">By day, project, model, session and person. Subagents apart from the main thread. A projected month.</p></div></div>' +
      '<div class="point"><span class="ico" aria-hidden="true">👥</span><div><b>The whole team</b><p class="small muted">Load each person’s folder under their name and compare. Add what you pay a seat.</p></div></div>' +
      '<div class="point"><span class="ico" aria-hidden="true">📤</span><div><b>Share the report</b><p class="small muted">Markdown, CSV and a summary card for the team channel. Made on this device.</p></div></div>' +
      '</div></section>' + footer();
    return html;
  }

  /* ---------------- loading files ---------------- */

  function loadHtml() {
    var people = state.loadedPeople;
    var next = people.length ? '' : (recall(K_NAME) || 'Me');
    var html = '<section class="card"><button class="link-btn" type="button" data-act="' + (state.a && state.view === 'load' && state.loadedPeople.length ? 'showdash' : 'home') + '">← Back</button><h1 style="margin:2px 0 10px">' + (people.length ? 'Add a teammate' : 'Analyse my sessions') + '</h1>' +
      '<div class="note" role="note"><b>🔒 Read on this device. Nothing is uploaded.</b> <span class="muted">Files are read here, line by line; only token counts and short labels (a tool name, a file name, the start of a command) are kept. Close the tab and they are gone.</span></div>' +
      '<label class="field"><span>Whose sessions are these?</span><input class="input" id="who" maxlength="' + C.LIMITS.personName + '" autocomplete="off" value="' + esc(next) + '" placeholder="A name, e.g. Maya"></label>' +
      '<div class="drop" id="drop"><span class="ico" aria-hidden="true">📂</span><b>Drop the projects folder here</b><span class="small muted">or one project’s folder, or some .jsonl files</span>' +
      '<div class="btns" style="justify-content:center"><label class="btn filepick">Choose a folder<input type="file" id="pickDir" webkitdirectory directory multiple aria-label="Choose a folder"></label>' +
      '<label class="btn ghost filepick">Choose files<input type="file" id="pickFiles" accept=".jsonl,application/x-ndjson,application/json,text/plain" multiple aria-label="Choose .jsonl files"></label></div></div>' +
      '<div id="loadState" aria-live="polite"></div>' +
      helpHtml() + '</section>';
    if (people.length) {
      html += '<section class="card"><h2>Loaded so far</h2><ul class="loaded">' + people.map(function (p) {
        return '<li><b>' + esc(p.name) + '</b><span class="muted num">' + esc(plural(p.files, 'file')) + ' · ' + esc(plural(p.responses, 'response')) + '</span></li>';
      }).join('') + '</ul><div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="showdash">Show the dashboard</button></div></section>';
    }
    return html + footer();
  }
  function helpHtml() {
    return '<details class="note" style="margin-top:14px"><summary><b>Where are my transcripts?</b></summary>' +
      '<p style="margin-top:10px">Claude Code usually keeps one <code>.jsonl</code> file per session, in a folder per project:</p>' +
      '<div class="paths">' +
      '<div class="os"><b>macOS and Linux</b><code>~/.claude/projects/</code><span class="small muted">On a Mac, in Finder press ⌘⇧G and paste the path (⌘⇧. shows hidden folders). On Linux, Ctrl+H shows hidden folders in the file picker.</span></div>' +
      '<div class="os"><b>Windows</b><code>%USERPROFILE%\\.claude\\projects\\</code><span class="small muted">Paste it into File Explorer’s address bar.</span></div>' +
      '</div>' +
      '<p style="margin-top:10px">Each project folder is named after its path (like <code>-Users-maya-code-api</code>). Subagent transcripts usually sit beside their session in <code>&lt;session&gt;/subagents/</code>; pick the whole projects folder and they come along, labelled as subagent spend.</p>' +
      '<p class="small muted">Older sessions may have been cleaned up by Claude Code; it keeps about a month by default. Files from another tool are skipped.</p></details>';
  }

  function wireLoad() {
    var drop = $('#drop');
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      var items = e.dataTransfer && e.dataTransfer.items ? Array.prototype.slice.call(e.dataTransfer.items) : [];
      var entries = items.map(function (it) { return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; }).filter(Boolean);
      if (entries.length) collectEntries(entries).then(readFiles);
      else readFiles(Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []).map(function (f) { return { file: f, path: f.name }; }));
    });
    $('#pickDir').addEventListener('change', function (e) { readFiles(Array.prototype.slice.call(e.target.files || []).map(function (f) { return { file: f, path: f.webkitRelativePath || f.name }; })); });
    $('#pickFiles').addEventListener('change', function (e) { readFiles(Array.prototype.slice.call(e.target.files || []).map(function (f) { return { file: f, path: f.name }; })); });
  }
  /** A dropped folder, walked (readEntries hands entries over in batches). */
  function collectEntries(entries) {
    var out = [];
    function walk(entry) {
      if (out.length > C.LIMITS.files * 2) return Promise.resolve();
      if (entry.isFile) return new Promise(function (res) { entry.file(function (f) { out.push({ file: f, path: entry.fullPath || f.name }); res(); }, function () { res(); }); });
      if (!entry.isDirectory) return Promise.resolve();
      var reader = entry.createReader();
      return new Promise(function (res) {
        var all = [];
        (function more() {
          reader.readEntries(function (batch) {
            if (!batch.length) return Promise.all(all.map(walk)).then(function () { res(); });
            all = all.concat(Array.prototype.slice.call(batch));
            more();
          }, function () { res(); });
        }());
      });
    }
    return Promise.all(entries.map(walk)).then(function () { return out; });
  }

  function readFiles(list) {
    var box = $('#loadState');
    var files = list.filter(function (x) { return /\.jsonl$/i.test(x.path); });
    var skipped = list.length - files.length;
    if (!files.length) { box.innerHTML = '<p class="err" role="alert">No .jsonl files there' + (skipped ? ' (' + esc(plural(skipped, 'other file')) + ' skipped)' : '') + '. Pick the <code>~/.claude/projects</code> folder or a project inside it.</p>'; return; }
    var total = files.reduce(function (s, x) { return s + x.file.size; }, 0);
    if (files.length > C.LIMITS.files) { box.innerHTML = '<p class="err" role="alert">That is ' + files.length + ' files; Burnrate reads up to ' + C.LIMITS.files + ' at once. Pick one project folder, or a shorter stretch of time.</p>'; return; }
    if (total > C.LIMITS.bytes) { box.innerHTML = '<p class="err" role="alert">That is more than 2 GB of transcripts. Pick one project folder at a time.</p>'; return; }
    var who = C.clean($('#who').value, C.LIMITS.personName) || ('Person ' + (state.loadedPeople.length + 1));
    if (!state.loadedPeople.length) keep(K_NAME, who);
    if (state.loadedPeople.some(function (p) { return p.name === who; })) { box.innerHTML = '<p class="err" role="alert">' + esc(who) + ' is already loaded. Give this folder another name.</p>'; return; }
    if (!state.collector || state.source !== 'files') { state.collector = C.createCollector(); state.loadedPeople = []; }
    var col = state.collector;
    var before = col.finish().stats;
    var pi;
    try { pi = col.person(who); } catch (e) { box.innerHTML = '<p class="err" role="alert">' + esc(e.message) + '</p>'; return; }
    var ld = state.loading = { done: 0, bytes: 0, total: total, cancelled: false };
    box.innerHTML = '<div class="stack" style="margin-top:14px"><p><b id="ldText">Reading…</b></p><div class="progress" role="progressbar" aria-label="Reading files" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="ldBar"></span></div><p class="small muted" id="ldSub"></p><button class="btn small ghost" type="button" id="ldCancel">Cancel</button></div>';
    $('#ldCancel').addEventListener('click', function () { ld.cancelled = true; });
    var last = 0;
    function progress(force) {
      var now = Date.now();
      if (!force && now - last < 120) return;
      last = now;
      var p = total ? Math.min(100, Math.round((ld.bytes / total) * 100)) : 100;
      var bar = $('#ldBar'); if (bar) { bar.style.width = p + '%'; bar.parentNode.setAttribute('aria-valuenow', String(p)); }
      var t = $('#ldText'); if (t) t.textContent = 'Reading ' + Math.min(ld.done + 1, files.length) + ' of ' + files.length + ' files · ' + (ld.bytes / 1048576).toFixed(1) + ' of ' + (total / 1048576).toFixed(1) + ' MB';
      var s = $('#ldSub'); if (s) s.textContent = C.plural(col.stats.lines, 'line') + ' read';
    }
    var i = 0;
    (function nextFile() {
      if (ld.cancelled) { state.loading = null; box.innerHTML = '<p class="muted">Stopped. Nothing was kept from those files.</p>'; state.collector = state.loadedPeople.length ? state.collector : null; return; }
      if (i >= files.length) return finished();
      var x = files[i++];
      var fh;
      try { fh = col.file(x.path, pi); } catch (e) { state.loading = null; box.innerHTML = '<p class="err" role="alert">' + esc(e.message) + '</p>'; return; }
      readStream(x.file, fh, function (n) { ld.bytes += n; progress(); }).then(function () { ld.done++; fh.bytes(x.file.size); progress(); setTimeout(nextFile, 0); }, function () { ld.done++; setTimeout(nextFile, 0); });
    }());
    function finished() {
      progress(true);
      state.loading = null;
      var ds = col.finish();
      var got = ds.stats.responses - before.responses;
      var bad = ds.stats.malformed - before.malformed + (ds.stats.tooLong - before.tooLong);
      if (!got) {
        box.innerHTML = '<p class="err" role="alert">No Claude Code turns with token counts in ' + esc(plural(files.length, 'file')) + '.</p><p class="small muted">' + (bad ? esc(plural(bad, 'line')) + ' could not be read. ' : '') + 'Pick the files under <code>~/.claude/projects</code>.</p>';
        return;
      }
      state.loadedPeople.push({ name: who, files: files.length, responses: got });
      state.ds = ds; state.source = 'files';
      analyse(); saveLast();
      var note = (bad ? ' ' + plural(bad, 'line') + ' could not be read and ' + (bad === 1 ? 'was' : 'were') + ' skipped.' : '') + (skipped ? ' ' + plural(skipped, 'non-transcript file') + ' ignored.' : '');
      toast('Read ' + plural(files.length, 'file') + ' for ' + who + '.' + note, 4200);
      state.view = 'dash';
      go(state.loadedPeople.length > 1 ? 'team' : 'overview');
    }
  }
  /** One file, streamed: decoded in chunks and split into lines, so a
   *  300 MB transcript is never held in memory at once. */
  function readStream(file, fh, onBytes) {
    if (file.stream && window.TextDecoderStream) {
      var reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
      var buf = '';
      var pump = function () {
        return reader.read().then(function (r) {
          if (r.done) { if (buf) fh.line(buf); return; }
          onBytes(r.value.length);
          buf = C.splitLines(buf + r.value, fh.line);
          if (state.loading && state.loading.cancelled) { reader.cancel(); return; }
          return pump();
        });
      };
      return pump();
    }
    return file.text().then(function (t) { onBytes(t.length); fh.text(t); });
  }

  /* ---------------- the dashboard ---------------- */

  function stripHtml() {
    var a = state.a;
    if (state.source === 'demo') {
      return '<div class="strip"><p><b>An example team</b> <span class="sub">· Maya, Dev and Sam · ' + esc(rangeText(a)) + ' · made up, generated on this device</span></p><button class="btn small light" type="button" data-act="load">Analyse my sessions →</button></div>';
    }
    var who = a.people.map(function (p) { return p.name; }).join(', ');
    return '<div class="strip"><p><b>' + esc(who) + '</b> <span class="sub">· ' + esc(rangeText(a)) + ' · ' + esc(plural(a.totals.sessions, 'session')) + (state.source === 'saved' ? ' · saved ' + esc(when(a.savedAt)) : '') + '</span></p>' +
      '<div class="btns">' + (state.source === 'files' ? '<button class="btn small light" type="button" data-act="addperson">+ Add a teammate</button>' : '<button class="btn small light" type="button" data-act="load">Load files</button>') + '</div></div>';
  }

  function overviewHtml() {
    var a = state.a, t = a.totals;
    var days = a.range.days;
    var html = '<div class="grid two">';
    html += '<section class="card headline-card"><div><div class="big num">' + esc(fmtUsd(t.usd)) + '</div><div class="big-sub">spent in ' + esc(plural(days, 'day')) + ' at list prices · <b class="num">' + esc(fmtUsd(t.monthUsd, { whole: true })) + '</b> a month at this pace</div></div>' +
      '<div class="avoid"><div class="row spread"><span>About <b class="pct num">' + esc(t.avoidPct) + '%</b> looks avoidable</span><b class="num">' + esc(fmtUsd(t.avoidUsd)) + '</b></div>' +
      '<div class="meter" role="img" aria-label="' + esc(t.avoidPct) + '% of spend looks avoidable"><span style="width:' + Math.max(1, t.avoidPct) + '%"></span></div>' +
      '<button class="btn" type="button" data-act="tab" data-tab="waste">See the waste and the fixes →</button></div></section>';
    html += '<section class="card"><div class="kpis">' +
      kpi('Tokens in', fmtTok(t.tokensIn), fmtTok(t.read) + ' from cache') +
      kpi('Tokens out', fmtTok(t.tokensOut), plural(t.turns, 'response')) +
      kpi('Cache hit rate', t.cacheHit + '%', 'of input tokens') +
      kpi('Subagents', C.pct(t.subUsd, t.usd) + '%', fmtUsd(t.subUsd) + ' of spend') +
      '</div><h3 style="margin-top:16px">Main thread vs subagents</h3>' +
      '<div class="split" role="img" aria-label="Main thread ' + esc(fmtUsd(t.mainUsd)) + ', subagents ' + esc(fmtUsd(t.subUsd)) + '"><i class="s1" style="width:' + Math.max(0, 100 - C.pct(t.subUsd, t.usd)) + '%"></i><i class="s2" style="width:' + C.pct(t.subUsd, t.usd) + '%"></i></div>' +
      '<ul class="legend"><li><i class="s1"></i>Main ' + esc(fmtUsd(t.mainUsd)) + '</li><li><i class="s2"></i>Subagents ' + esc(fmtUsd(t.subUsd)) + '</li></ul></section>';
    html += '</div>';
    html += '<section class="card"><div class="sec-head"><h2>By day</h2><span class="small muted">' + esc(fmtUsd(t.perDayUsd)) + ' a day on average</span></div><div class="chart" id="dayChart" data-chart="days"></div>' +
      '<ul class="legend"><li><i class="s1"></i>Main sessions</li><li><i class="s2"></i>Subagents</li></ul></section>';
    if (a.findings.length) {
      html += '<section class="card"><div class="sec-head"><h2>Biggest waste</h2><button class="link-btn" type="button" data-act="tab" data-tab="waste">All ' + a.findings.length + ' →</button></div><ol class="bars" style="list-style:none">' +
        a.findings.slice(0, 3).map(function (f) {
          return '<li><div class="lab"><span><span aria-hidden="true">' + f.icon + '</span> ' + esc(f.title) + '</span><b class="num">' + esc(fmtUsd(f.usd)) + '</b></div><div class="track"><i style="width:' + barW(f.usd, a.findings[0].usd) + '%;background:var(--accent)"></i></div><span class="small muted" style="overflow-wrap:anywhere">' + esc(f.headline) + '</span></li>';
        }).join('') + '</ol></section>';
    }
    html += '<div class="grid two"><section class="card"><h2>By model</h2>' + barsHtml(a.byModel.map(function (m) { return { name: m.name, usd: m.usd, sub: plural(m.turns, 'turn') }; })) +
      (a.unpriced.length ? '<p class="small err" style="margin-top:10px">' + esc(plural(a.unpriced.reduce(function (s, u) { return s + u.turns; }, 0), 'turn')) + ' on a model not in the price table (' + esc(a.unpriced.map(function (u) { return u.model; }).join(', ')) + ') count as $0. <button class="link-btn" type="button" data-act="prices">Add its price</button></p>' : '') + '</section>' +
      '<section class="card"><h2>By project</h2>' + barsHtml(a.byProject.slice(0, 8).map(function (p) { return { name: p.name, usd: p.usd, sub: plural(p.sessions, 'session') }; })) + '</section></div>';
    if (a.stats && (a.stats.malformed || a.stats.tooLong)) html += '<p class="small muted" style="margin-top:12px">' + esc(plural((a.stats.malformed || 0) + (a.stats.tooLong || 0), 'line')) + ' could not be read and were skipped.</p>';
    return html;
  }
  function kpi(label, value, sub) { return '<div class="kpi"><span>' + esc(label) + '</span><b>' + esc(value) + '</b><small>' + esc(sub) + '</small></div>'; }
  function barW(v, max) { return max > 0 ? Math.max(1.5, Math.round((v / max) * 100)) : 0; }
  function barsHtml(rows) {
    if (!rows.length) return '<p class="muted">Nothing yet.</p>';
    var max = rows[0].usd;
    return '<ul class="bars">' + rows.map(function (r) {
      return '<li><div class="lab"><span>' + esc(r.name) + ' <span class="small muted">' + esc(r.sub || '') + '</span></span><b class="num">' + esc(fmtUsd(r.usd)) + '</b></div><div class="track" aria-hidden="true"><i style="width:' + barW(r.usd, max) + '%"></i></div></li>';
    }).join('') + '</ul>';
  }

  /* ---------------- waste ---------------- */

  function wasteHtml() {
    var a = state.a, t = a.totals;
    var html = '<section class="card"><div class="sec-head"><h1 style="margin:0;font-size:1.5rem">About ' + esc(t.avoidPct) + '% looks avoidable</h1><b class="num" style="font-size:1.4rem">' + esc(fmtUsd(t.avoidUsd)) + '</b></div>' +
      '<p class="muted">Of ' + esc(fmtUsd(t.usd)) + ' over ' + esc(plural(a.range.days, 'day')) + ', ranked by dollars. Every figure is an estimate at list prices.</p>' +
      '<details class="note"><summary><b>How this is worked out</b></summary><ul class="small" style="padding-left:18px;margin:10px 0 0">' + C.METHOD.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul></details></section>';
    html += '<section class="card"><div class="row spread"><div style="flex:1;min-width:220px"><h2 style="margin:0">✨ Write our fixes</h2><p class="small muted" style="margin:4px 0 0">AI turns these findings into CLAUDE.md lines, settings and habits. It is sent the numbers only - you see exactly what first.</p></div><button class="btn" type="button" data-act="fixes">Write our fixes</button></div>' +
      (state.fixes ? '<div id="fixOut">' + fixesHtml(state.fixes) + '</div>' : '') + '</section>';
    if (!a.findings.length) return html + '<section class="card"><h2>Nothing stood out</h2><p class="muted">No pattern crossed its threshold. That is a good sign.</p></section>';
    a.findings.forEach(function (f, i) { html += findingHtml(f, i); });
    return html;
  }
  function findingHtml(f, i) {
    var a = state.a;
    var share = C.pct(f.usd, a.totals.usd);
    var html = '<article class="card finding" id="f-' + f.id + '"><div class="f-top"><span class="f-ico" aria-hidden="true">' + f.icon + '</span><h3><span class="rank">#' + (i + 1) + '</span>' + esc(f.title) + '</h3>' +
      '<div class="f-usd"><b class="num">' + esc(fmtUsd(f.usd)) + '</b><span>estimate</span></div>' +
      '<div class="f-body"><p class="f-head">' + esc(f.headline) + '</p><p class="small muted" style="margin:4px 0 0">' + esc(plural(f.count, 'case')) + ' · ' + esc(fmtTok(f.tokens)) + ' tokens · ' + (share < 1 ? 'under 1' : share) + '% of spend</p></div></div>' +
      '<div class="fix"><b>The fix</b><p>' + esc(f.fix) + '</p>' +
      (f.snippet ? '<div class="snippet"><code>' + esc(f.snippet) + '</code><button class="btn small ghost" type="button" data-act="copysnip" data-k="' + esc(f.id) + '" aria-label="Copy the CLAUDE.md line">Copy</button></div><p class="small muted" style="margin-top:6px">A line for your CLAUDE.md.</p>' : '') + '</div>' +
      '<details class="cases"><summary>' + esc(plural(f.count, 'case')) + (f.instances.length < f.count ? ' (top ' + f.instances.length + ')' : '') + '</summary><div class="tbox"><table class="wide"><thead><tr><th>When</th>' + (a.people.length > 1 ? '<th>Who</th>' : '') + '<th>Project</th><th>What</th><th class="r">Tokens</th><th class="r">Estimate</th></tr></thead><tbody>' +
      f.instances.map(function (x) {
        return '<tr class="go" data-act="session" data-s="' + esc(x.session) + '" tabindex="0"><td class="nw">' + esc(whenShort(x.t)) + '</td>' + (a.people.length > 1 ? '<td>' + esc(personName(x.person)) + '</td>' : '') + '<td class="nw">' + esc(x.project) + '</td><td><span class="what">' + esc(x.label) + '</span></td><td class="r num">' + esc(fmtTok(x.tokens)) + '</td><td class="r num">' + esc(fmtUsd(x.usd)) + '</td></tr>';
      }).join('') + '</tbody></table></div><p class="small muted" style="padding:8px 16px 12px;margin:0">Tap a row to open its session.</p></details></article>';
    return html;
  }

  /* ---------------- sessions ---------------- */

  var SORTS = [['cost', 'Cost'], ['newest', 'Newest'], ['peak', 'Peak context'], ['waste', 'Waste'], ['turns', 'Turns']];
  function sortedSessions() {
    var list = state.a.sessions.slice();
    var by = {
      cost: function (x, y) { return y.units - x.units; },
      newest: function (x, y) { return y.start - x.start; },
      peak: function (x, y) { return y.peak - x.peak; },
      waste: function (x, y) { return y.wasteUsd - x.wasteUsd; },
      turns: function (x, y) { return y.turns - x.turns; },
    }[state.sort] || function () { return 0; };
    return list.sort(by);
  }
  function sessionsHtml() {
    var a = state.a;
    var list = sortedSessions();
    var shown = state.showAll ? list : list.slice(0, 60);
    var html = '<section class="card"><div class="sec-head"><h2>' + esc(plural(list.length, 'session')) + '</h2><span class="small muted">the line is each session’s context size, turn by turn</span></div>' +
      '<div class="seg" role="group" aria-label="Sort sessions">' + SORTS.map(function (s) { return '<button type="button" class="segb" data-act="sort" data-v="' + s[0] + '" aria-pressed="' + (state.sort === s[0]) + '">' + s[1] + '</button>'; }).join('') + '</div></section>';
    html += '<div class="shead" aria-hidden="true"><span>Session</span><span>Context</span><span>Cost</span><span>Looks avoidable</span></div>';
    html += '<ul class="slist" style="margin-top:12px">' + shown.map(function (s) {
      var sub = s.subUsd > 0 ? ' · subagents ' + fmtUsd(s.subUsd) : '';
      return '<li><button type="button" class="srow" data-act="session" data-s="' + esc(s.key) + '">' +
        '<span class="s-name">' + esc(s.project) + '</span><span class="s-usd num">' + esc(fmtUsd(s.usd)) + '</span>' +
        '<span class="s-meta">' + esc(when(s.start)) + (a.people.length > 1 ? ' · ' + esc(personName(s.person)) : '') + ' · ' + esc(plural(s.turns, 'turn')) + ' · peak ' + esc(fmtTok(s.peak)) + esc(sub) + '</span>' +
        '<span class="s-spark">' + spark(s.spark, 120, 30) + '</span>' +
        (s.wasteUsd > 0 ? '<span class="s-waste">' + esc(fmtUsd(s.wasteUsd)) + '<span class="dk-hide"> looks</span> avoidable</span>' : '<span class="s-waste muted" style="color:var(--muted)">nothing stood out</span>') +
        '</button></li>';
    }).join('') + '</ul>';
    if (!state.showAll && list.length > shown.length) html += '<div class="btns" style="margin-top:12px"><button class="btn ghost" type="button" data-act="showall">Show all ' + list.length + '</button></div>';
    return html;
  }
  function spark(pts, w, h) {
    if (!pts || pts.length < 2) return '<svg class="spark" width="' + w + '" height="' + h + '" aria-hidden="true"></svg>';
    var max = Math.max(C.T.bloatTokens * 1.1, Math.max.apply(null, pts.map(function (p) { return p[1]; })));
    var xs = function (i) { return (i / (pts.length - 1)) * (w - 2) + 1; };
    var ys = function (v) { return h - 2 - (v / max) * (h - 4); };
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + xs(i).toFixed(1) + ' ' + ys(p[1]).toFixed(1); }).join('');
    var ty = ys(C.T.bloatTokens).toFixed(1);
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><line class="st" x1="0" x2="' + w + '" y1="' + ty + '" y2="' + ty + '"/><path class="sa" d="' + line + 'L' + xs(pts.length - 1).toFixed(1) + ' ' + h + 'L1 ' + h + 'Z"/><path class="sl" d="' + line + '"/></svg>';
  }

  function openSession(key) {
    var a = state.a;
    var s = a.sessions.filter(function (x) { return x.key === key; })[0];
    if (!s) return;
    var inst = [];
    a.findings.forEach(function (f) { f.instances.forEach(function (x) { if (x.session === key) inst.push({ f: f, x: x }); }); });
    inst.sort(function (p, q) { return q.x.usd - p.x.usd; });
    var html = '<h2>' + esc(s.project) + '</h2><p class="muted" style="margin-top:-4px">' + esc(when(s.start)) + (a.people.length > 1 ? ' · ' + esc(personName(s.person)) : '') + ' · ' + esc(s.models.join(', ')) + '</p>' +
      '<div class="kpis">' + kpi('Cost', fmtUsd(s.usd), 'estimate') + kpi('Turns', String(s.turns), s.subTurns ? s.subTurns + ' in subagents' : 'main thread') + kpi('Peak context', fmtTok(s.peak), 'tokens') + kpi('Looks avoidable', fmtUsd(s.wasteUsd), C.pct(s.wasteUsd, s.usd) + '% of it') + '</div>' +
      '<h3 style="margin-top:16px">Context size, turn by turn</h3><div class="chart" id="ctxChart"></div>' +
      '<ul class="legend"><li><i class="s1"></i>Context (tokens)</li><li><i class="dash"></i>' + esc(fmtTok(C.T.bloatTokens)) + ' line</li>' + (s.compactions.length ? '<li><i class="cmp"></i>Compacted</li>' : '') + (s.cold.length ? '<li><i class="cold"></i>Cache went cold</li>' : '') + '</ul>' +
      (s.detail ? '' : '<p class="small muted">Saved analyses keep a coarser line. Load the files again for every turn.</p>');
    if (inst.length) {
      html += '<h3 style="margin-top:16px">In this session</h3><ul class="bars">' + inst.slice(0, 12).map(function (p) {
        return '<li><div class="lab"><span><span aria-hidden="true">' + p.f.icon + '</span> ' + esc(p.f.title) + '</span><b class="num">' + esc(fmtUsd(p.x.usd)) + '</b></div><span class="small" style="overflow-wrap:anywhere">' + esc(p.x.headline) + '</span></li>';
      }).join('') + '</ul>';
    } else html += '<p class="muted" style="margin-top:14px">Nothing stood out in this session.</p>';
    if (s.agents.length) {
      html += '<h3 style="margin-top:16px">' + esc(plural(s.agents.length, 'subagent')) + ' · ' + esc(fmtUsd(s.subUsd)) + '</h3><div class="tbox"><table><thead><tr><th>Subagent</th><th>Model</th><th class="r">Turns</th><th class="r">Cost</th></tr></thead><tbody>' +
        s.agents.map(function (g, i) { return '<tr><td>#' + (i + 1) + ' <span class="small muted mono">' + esc(g.id.slice(0, 8)) + '</span></td><td>' + esc(g.model) + '</td><td class="r num">' + g.turns + '</td><td class="r num">' + esc(fmtUsd(g.usd)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    }
    html += '<details class="note" style="margin-top:16px"><summary><b>Tokens</b></summary><div class="tbox"><table><tbody>' +
      '<tr><td>Fresh input</td><td class="r num">' + esc(fmtTok(s.inp)) + '</td></tr><tr><td>Written to cache</td><td class="r num">' + esc(fmtTok(s.write)) + '</td></tr><tr><td>Read from cache</td><td class="r num">' + esc(fmtTok(s.read)) + '</td></tr><tr><td>Output</td><td class="r num">' + esc(fmtTok(s.out)) + '</td></tr></tbody></table></div></details>';
    sheet(html, function (root) { drawCtx($('#ctxChart', root), s); });
  }

  /* ---------------- team ---------------- */

  function teamHtml() {
    var a = state.a;
    var seat = Number(recall(K_SEAT)) || 0;
    var days = a.range.days;
    var html = '<section class="card"><div class="sec-head"><h2>' + esc(plural(a.people.length, 'person', 'people')) + '</h2>' + (state.source === 'files' ? '<button class="btn small" type="button" data-act="addperson">+ Add a teammate’s folder</button>' : '') + '</div>' +
      (a.people.length < 2 ? '<p class="muted">Load each person’s <code>~/.claude/projects</code> folder under their name to compare. Names stay in this browser.</p>' : '<p class="muted">Each person’s spend by day, and the one habit that costs them most.</p>') +
      '<label class="field"><span>What do you pay per seat, a month?</span><span class="row"><span class="money"><input class="input num" id="seat" inputmode="decimal" value="' + (seat ? esc(seat) : '') + '" placeholder="e.g. 100" aria-label="Seat price in dollars a month"></span><span class="small muted">kept in this browser</span></span></label>' +
      '<p id="seatLine" class="note" ' + (seat ? '' : 'hidden') + '>' + seatLine(seat) + '</p></section>';
    var maxDay = 0;
    a.byDay.forEach(function (d) { d.people.forEach(function (v) { if (v > maxDay) maxDay = v; }); });
    html += '<div class="grid two">' + a.people.map(function (p, i) {
      var month = days ? p.usd / days * 30 : 0;
      return '<section class="card person"><div class="p-head"><h3>' + esc(p.name) + '</h3><b class="num" style="font-size:1.3rem">' + esc(fmtUsd(p.usd)) + '</b></div>' +
        '<p class="small muted" style="margin:0">' + esc(plural(p.sessions, 'session')) + ' · about ' + esc(fmtUsd(month, { whole: true })) + ' a month · ' + esc(fmtUsd(p.wasteUsd)) + ' looks avoidable</p>' +
        '<div class="chart" data-chart="person" data-p="' + i + '" data-max="' + maxDay + '"></div>' +
        (p.top ? '<p class="p-top"><span aria-hidden="true">' + p.top.icon + '</span> <b>' + esc(p.top.title) + '</b> · ' + esc(fmtUsd(p.top.usd)) + '<br><span class="muted">' + esc(p.top.headline) + '</span></p>' : '<p class="p-top muted">Nothing stood out.</p>') + '</section>';
    }).join('') + '</div>';
    return html;
  }
  function seatLine(seat) {
    var a = state.a;
    if (!seat) return '';
    var days = a.range.days || 1;
    var per = a.people.length ? a.totals.usd / a.people.length / days * 30 : 0;
    return 'At list prices this usage is worth about <b class="num">' + esc(fmtUsd(per, { whole: true })) + '</b> a month per person; you pay <b class="num">' + esc(fmtUsd(seat, { whole: true })) + '</b> a seat' + (per > seat ? ' - the seat is the better deal at this pace.' : ' - at this pace, metered API use would cost less than the seat.') + ' <span class="muted">An estimate from ' + esc(plural(days, 'day')) + '.</span>';
  }
  function wireTeam() {
    var inp = $('#seat');
    if (!inp) return;
    inp.addEventListener('input', function () {
      var v = Math.max(0, Math.min(100000, Number(String(inp.value).replace(/[^0-9.]/g, '')) || 0));
      keep(K_SEAT, v || null);
      var line = $('#seatLine');
      line.hidden = !v; line.innerHTML = seatLine(v);
    });
  }

  /* ---------------- report ---------------- */

  function reportHtml() {
    var a = state.a;
    var saved = C.cleanSaved(recall(K_LAST));
    var html = '<section class="card"><h2>Share the report</h2><p class="muted">Made on this device. Paths stay out; file names, project names and the start of a command can appear, so look before you share.</p>' +
      '<div class="btns"><button class="btn" type="button" data-act="md">Download Markdown</button><button class="btn ghost" type="button" data-act="copymd">Copy Markdown</button><button class="btn ghost" type="button" data-act="csv">Sessions CSV</button><button class="btn ghost" type="button" data-act="fcsv">Findings CSV</button></div></section>';
    html += '<section class="card"><div class="sec-head"><h2>Summary card</h2><span class="small muted">1200 × 630 PNG</span></div>' +
      (state.card ? '<img class="cardprev" src="' + esc(state.card.url) + '" alt="Summary card: ' + esc(fmtUsd(a.totals.usd)) + ', about ' + esc(a.totals.avoidPct) + '% avoidable">' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="sharecard">Share the card</button><button class="btn ghost" type="button" data-act="savecard">Save PNG</button></div><p class="small muted" style="margin-top:8px">Drawn on this device; nothing is uploaded.</p>'
        : '<p class="muted">The total, the avoidable share and the top three findings, for the team channel.</p><button class="btn" type="button" data-act="makecard">Make the card</button>') + '</section>';
    html += '<section class="card"><h2>Prices</h2><p class="muted">' + esc(C.PRICE_NOTE) + '</p>' + (a.prices.edited ? '<p><b>You edited the prices on this device.</b></p>' : '') + '<button class="btn ghost" type="button" data-act="prices">See or edit the prices</button></section>';
    html += '<section class="card"><h2>Remembered on this device</h2>' + (saved ? '<p>The last analysis of your own files: <b class="num">' + esc(fmtUsd(saved.totals.usd)) + '</b>, ' + esc(rangeText(saved)) + '. Numbers and short labels only, never a transcript, and only in this browser.</p><button class="btn ghost" type="button" data-act="clearlast">Clear it</button>' : '<p class="muted">Nothing. When you analyse your own files, the totals and findings (never a transcript) are kept here so you can come back to them. The example is never saved.</p>') + '</section>';
    return html;
  }
  function filename(ext) { return 'burnrate-' + C.localDay(Date.now(), TZ) + ext; }

  /** The summary card: drawn on a canvas, on this device. Two taps to
   *  share: the first draws it and shows it; Share is a fresh tap, because
   *  iOS refuses a share sheet without one. */
  function makeCard() {
    var a = state.a, t = a.totals;
    var W = 1200, H = 630;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');
    var bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#1f1b2e'); bg.addColorStop(0.65, '#3b1d18'); bg.addColorStop(1, '#7a2a0c');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    var font = function (w, s) { return w + ' ' + s + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'; };
    var fit = function (text, max) { var s = String(text); while (s.length > 1 && g.measureText(s).width > max) s = s.slice(0, -2) + '…'; return s; };
    g.fillStyle = '#fed7aa'; g.font = font('800', 26); g.fillText('BURNRATE · WHERE THE AGENT TOKENS WENT', 64, 82);
    g.fillStyle = '#ffffff'; g.font = font('850', 96); g.fillText(fmtUsd(t.usd), 60, 196);
    var w1 = g.measureText(fmtUsd(t.usd)).width;
    g.fillStyle = '#e9e2f2'; g.font = font('600', 30);
    g.fillText(fit('in ' + plural(a.range.days, 'day') + ' · ' + plural(a.people.length, 'person', 'people') + ' · ' + fmtUsd(t.monthUsd, { whole: true }) + '/month at this pace', W - 120 - w1), 84 + w1, 192);
    // the avoidable meter
    g.fillStyle = 'rgba(255,255,255,.14)'; roundRect(g, 64, 236, W - 128, 26, 13); g.fill();
    g.fillStyle = '#fb923c'; roundRect(g, 64, 236, Math.max(26, (W - 128) * t.avoidPct / 100), 26, 13); g.fill();
    g.fillStyle = '#ffffff'; g.font = font('800', 36); g.fillText('About ' + t.avoidPct + '% looks avoidable (' + fmtUsd(t.avoidUsd) + ')', 64, 316);
    var y = 380;
    var max = a.findings.length ? a.findings[0].usd : 1;
    a.findings.slice(0, 3).forEach(function (f, i) {
      g.fillStyle = '#ffffff'; g.font = font('700', 30);
      g.fillText((i + 1) + '. ' + fit(f.title, 560), 64, y);
      g.fillStyle = 'rgba(255,255,255,.14)'; roundRect(g, 660, y - 22, 360, 22, 11); g.fill();
      g.fillStyle = '#93c5fd'; roundRect(g, 660, y - 22, Math.max(22, 360 * f.usd / max), 22, 11); g.fill();
      g.fillStyle = '#ffffff'; g.font = font('800', 30); g.textAlign = 'right'; g.fillText(fmtUsd(f.usd), W - 64, y); g.textAlign = 'left';
      y += 62;
    });
    if (!a.findings.length) { g.fillStyle = '#ffffff'; g.font = font('700', 32); g.fillText('Nothing stood out. Tidy sessions.', 64, y); }
    g.fillStyle = '#cfc9e8'; g.font = font('500', 22);
    g.fillText(fit('Estimates at list prices as of ' + C.PRICES_AS_OF + '. Read on the device; no transcript left it.' + (state.source === 'demo' ? ' Example data.' : ''), W - 128), 64, H - 44);
    cv.toBlob(function (blob) {
      if (!blob) return toast('The card could not be drawn here.');
      if (state.card) URL.revokeObjectURL(state.card.url);
      state.card = { blob: blob, url: URL.createObjectURL(blob) };
      drawTab();
    }, 'image/png');
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function shareCard() {
    if (!state.card) return;
    var file = null;
    try { file = new File([state.card.blob], filename('.png'), { type: 'image/png' }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Burnrate', text: 'Where our coding agent’s tokens went' }).catch(function () { /* closed */ });
    } else download(filename('.png'), 'image/png', state.card.blob);
  }

  /* ---------------- the one model call ---------------- */

  function fixesHtml(fx) {
    var md = fx.claudeMd.map(function (l) { return '- ' + l; }).join('\n');
    return '<div class="fixcard"><div class="row spread"><b>For your CLAUDE.md</b><button class="btn small ghost" type="button" data-act="copyfixmd">Copy</button></div><pre class="mono" style="white-space:pre-wrap;margin:8px 0 0">' + esc(md) + '</pre></div>' +
      (fx.settings.length ? '<div class="fixcard"><b>Commands and settings</b><ul>' + fx.settings.map(function (s) { return '<li><code>' + esc(s.setting) + '</code> → <code>' + esc(s.value) + '</code><br><span class="small muted">' + esc(s.why) + '</span></li>'; }).join('') + '</ul></div>' : '') +
      (fx.habits.length ? '<div class="fixcard"><b>Habits</b><ul>' + fx.habits.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul></div>' : '') +
      '<p class="small muted" style="margin-top:8px">Written by AI from the numbers - check a setting before you rely on it.</p>';
  }
  function openFixes() {
    var a = state.a;
    if (!a.findings.length) { toast('No findings to write fixes for.'); return; }
    if (!signedIn()) {
      sheet('<h2>✨ Write our fixes</h2><p>AI reads the findings and writes short CLAUDE.md rules, the commands and settings to use, and habits for the team.</p>' +
        '<div class="note"><p><b>It is sent the numbers only:</b> dollars, token counts, tool names and file names. Never code, a path, a command or anything anyone typed.</p><p class="small muted" style="margin:0">It uses about a cent of AI credit, so it needs a free account (it comes with $2). Every finding and its fix on this page stay free, with no account.</p></div>' +
        '<div class="btns" style="margin-top:14px"><button class="btn" type="button" data-act="signin-fixes">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button></div>');
      return;
    }
    var summary = C.fixesSummary(a);
    sheet('<h2>✨ Write our fixes</h2><p id="fxLead">This is <b>exactly</b> what will be sent - numbers, tool names and file names, no code, no paths, no commands, no conversation:</p><details open id="sentBox"><summary><b id="sentLabel">What will be sent</b></summary><pre id="sendPre">' + esc(JSON.stringify(summary, null, 2)) + '</pre></details>' +
      '<div id="fxErr"></div><div class="btns"><button class="btn" type="button" id="fxSend">Send and write the fixes</button><button class="btn ghost" type="button" data-act="closesheet" id="fxCancel">Cancel</button></div><p class="small muted" style="margin-top:8px">About a cent of AI credit. Nothing is stored.</p><div id="fxOut"></div>', function (root) {
      $('#fxSend', root).addEventListener('click', function (e) {
        var btn = e.currentTarget;
        btn.disabled = true; btn.textContent = 'Writing…';
        api('POST', 'api/fixes', { summary: summary }).then(function (r) {
          var fx = C.cleanFixes(r.fixes);
          if (!fx) throw Object.assign(new Error('That answer had nothing usable in it. Try again.'), { status: 422 });
          state.fixes = fx;
          btn.hidden = true;
          $('#sentBox', root).open = false;
          $('#sentLabel', root).textContent = 'What was sent';
          $('#fxLead', root).hidden = true;
          $('#fxCancel', root).textContent = 'Done';
          $('#fxOut', root).innerHTML = fixesHtml(fx);
          if (state.tab === 'waste') drawTab();
          loadMe();
        }).catch(function (err) { btn.disabled = false; btn.textContent = 'Send and write the fixes'; meteredError(err, $('#fxErr', root), openFixes); });
      });
    });
  }

  /* ---------------- prices ---------------- */

  function openPrices() {
    var rows = C.cleanPrices(prices());
    var html = '<h2>Prices</h2><p class="muted">' + esc(C.PRICE_NOTE) + '</p><p class="small muted">Change a price and every number recalculates. Edits stay in this browser. Add a row for a model that is missing (use its id, like <code>claude-sonnet-5-5</code>).</p>' +
      '<form id="pForm"><div class="tbox price-table"><table><thead><tr><th>Model</th><th class="r">Input</th><th class="r">Output</th><th class="r">Cache write 5m</th><th class="r">Cache write 1h</th><th class="r">Cache read</th></tr></thead><tbody>' +
      rows.map(function (r, i) {
        return '<tr><td><b>' + esc(r.name) + '</b><br><span class="small muted mono">' + esc(r.id) + '</span></td>' + C.PRICE_FIELDS.map(function (f) { return '<td class="r"><input inputmode="decimal" data-row="' + i + '" data-f="' + f + '" value="' + esc(r[f]) + '" aria-label="' + esc(r.name + ' ' + f) + '"></td>'; }).join('') + '</tr>';
      }).join('') + '<tr><td><input class="input" id="newId" placeholder="model id" style="min-width:150px" aria-label="New model id"></td>' + C.PRICE_FIELDS.map(function (f) { return '<td class="r"><input inputmode="decimal" data-new="' + f + '" aria-label="New model ' + f + '"></td>'; }).join('') + '</tr>' +
      '</tbody></table></div><div id="pErr"></div><div class="btns" style="margin-top:12px"><button class="btn" type="submit">Recalculate</button><button class="btn ghost" type="button" data-act="resetprices">Back to list prices</button></div></form>' +
      (state.source === 'saved' ? '<p class="small muted" style="margin-top:8px">A saved analysis keeps its totals; load the files again to re-price them.</p>' : '');
    sheet(html, function (root) {
      $('#pForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var next = rows.map(function (r) { return Object.assign({}, r); });
        $$('input[data-row]', root).forEach(function (inp) { next[Number(inp.getAttribute('data-row'))][inp.getAttribute('data-f')] = Number(inp.value); });
        var id = C.clean($('#newId', root).value, 60).toLowerCase();
        if (id) {
          var nr = { id: id, name: id.replace(/^claude-/, ''), tier: /opus|fable|mythos/.test(id) ? 'top' : /haiku/.test(id) ? 'small' : 'mid' };
          $$('input[data-new]', root).forEach(function (inp) { nr[inp.getAttribute('data-new')] = Number(inp.value); });
          next.push(nr);
        }
        var bad = next.some(function (r) { return C.PRICE_FIELDS.some(function (f) { var n = Number(r[f]); return !isFinite(n) || n < 0 || n > 1000; }); });
        if (bad) { $('#pErr', root).innerHTML = '<p class="err" role="alert">Prices are dollars per million tokens, from 0 to 1000.</p>'; return; }
        state.prices = C.cleanPrices(next);
        keep(K_PRICES, state.prices);
        if (state.ds) { analyse(); if (state.source === 'files') saveLast(); }
        closeSheet(); draw(); toast('Recalculated at your prices');
      });
    });
  }

  /* ---------------- charts (SVG, drawn at the box's real width) ---------------- */

  function drawCharts() {
    $$('[data-chart]').forEach(function (el) {
      var kind = el.getAttribute('data-chart');
      if (kind === 'days') drawDays(el, state.a.byDay, null);
      else if (kind === 'person') drawDays(el, state.a.byDay, Number(el.getAttribute('data-p')), Number(el.getAttribute('data-max')));
    });
  }
  function tipOn(el) {
    var tip = document.createElement('div');
    tip.className = 'tip'; tip.hidden = true;
    el.appendChild(tip);
    el.addEventListener('mousemove', function (e) {
      var b = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!b) { tip.hidden = true; return; }
      var r = el.getBoundingClientRect();
      tip.textContent = b.getAttribute('data-tip');
      tip.style.left = Math.min(r.width - 60, Math.max(60, e.clientX - r.left)) + 'px';
      tip.style.top = (e.clientY - r.top - 6) + 'px';
      tip.hidden = false;
    });
    el.addEventListener('mouseleave', function () { tip.hidden = true; });
  }
  /** Daily spend: main sessions (slot 1) under subagents (slot 2), a 2px
   *  gap between them, rounded data ends, a value over each bar. One person
   *  (a small multiple) draws their own total in slot 1. */
  function drawDays(el, days, person, sharedMax) {
    var W = Math.max(260, el.clientWidth || 320);
    var small = person !== null && person !== undefined;
    var H = small ? 120 : 220;
    var padB = 26, padT = 22, padL = 4, padR = 4;
    var vals = days.map(function (d) { return small ? { main: d.people[person] || 0, sub: 0 } : { main: Math.max(0, d.usd - d.subUsd), sub: d.subUsd }; });
    var max = small && sharedMax ? sharedMax : Math.max.apply(null, vals.map(function (v) { return v.main + v.sub; }).concat([0.01]));
    var n = days.length;
    var slot = (W - padL - padR) / n;
    var bw = Math.max(4, Math.min(56, slot * 0.62));
    var ih = H - padB - padT;
    var showEvery = Math.ceil(n / Math.floor(W / 46));
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc((small ? personName(person) + '’s spend' : 'Spend') + ' by day: ' + days.map(function (d, i) { return dayShort(d.day) + ' ' + fmtUsd(vals[i].main + vals[i].sub); }).join(', ')) + '">';
    out += '<line class="grid-l" x1="0" x2="' + W + '" y1="' + (H - padB + 0.5) + '" y2="' + (H - padB + 0.5) + '"/>';
    days.forEach(function (d, i) {
      var x = padL + i * slot + (slot - bw) / 2;
      var v = vals[i];
      var hm = (v.main / max) * ih, hs = (v.sub / max) * ih;
      var base = H - padB;
      var tip = dayShort(d.day) + ': ' + fmtUsd(v.main + v.sub) + (small ? '' : (v.sub ? ' (subagents ' + fmtUsd(v.sub) + ')' : ''));
      out += '<g class="bar" data-tip="' + esc(tip) + '"><rect class="hit" x="' + (padL + i * slot) + '" y="' + padT + '" width="' + slot + '" height="' + ih + '"/>';
      if (hm > 0) out += barPath('s1', x, base - hm, bw, hm, hs < 1);
      if (hs >= 1) out += barPath('s2', x, base - hm - hs - (hm > 0 ? 2 : 0), bw, hs, true);
      out += '</g>';
      var total = v.main + v.sub;
      if (total > 0 && (n <= 14 || i % showEvery === 0)) out += '<text class="val" x="' + (x + bw / 2) + '" y="' + (base - hm - hs - 6) + '" text-anchor="middle">' + esc(compactUsd(total)) + '</text>';
      if (i % showEvery === 0) out += '<text x="' + (x + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(n > 14 ? dayShort(d.day).split(' ')[1] : dayShort(d.day)) + '</text>';
    });
    el.innerHTML = out + '</svg>';
    tipOn(el);
  }
  function compactUsd(v) { return v >= 100 ? '$' + Math.round(v) : v >= 10 ? '$' + v.toFixed(0) : '$' + v.toFixed(2); }
  /** A bar rounded 4px at its data end only. */
  function barPath(cls, x, y, w, h, roundTop) {
    var r = roundTop ? Math.min(4, h, w / 2) : 0;
    return '<path class="' + cls + '" d="M' + x + ' ' + (y + h) + 'V' + (y + r) + (r ? 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y : '') + 'H' + (x + w - r) + (r ? 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + r) : '') + 'V' + (y + h) + 'Z"/>';
  }
  /** One session's context over time: the line, the bloat threshold,
   *  compactions and the turns where the cache went cold. */
  function drawCtx(el, s) {
    var pts = s.detail || s.spark || [];
    var W = Math.max(260, el.clientWidth || 320), H = 210;
    if (pts.length < 2) { el.innerHTML = '<p class="muted">Too few turns to draw.</p>'; return; }
    var padL = 44, padR = 10, padT = 12, padB = 26;
    var t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    var span = Math.max(1, t1 - t0);
    var max = Math.max(C.T.bloatTokens * 1.15, Math.max.apply(null, pts.map(function (p) { return p[1]; })) * 1.05);
    var X = function (t) { return padL + ((t - t0) / span) * (W - padL - padR); };
    var Y = function (v) { return padT + (1 - v / max) * (H - padT - padB); };
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join('');
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc('Context grew to ' + fmtTok(s.peak) + ' tokens over ' + s.turns + ' turns' + (s.compactions.length ? ', compacted ' + s.compactions.length + ' times' : '') + (s.cold.length ? ', the cache went cold ' + s.cold.length + ' times' : '')) + '">';
    [0, 0.5, 1].forEach(function (f) { var v = max * f; out += '<line class="grid-l" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '"/><text x="' + (padL - 6) + '" y="' + (Y(v) + 4).toFixed(1) + '" text-anchor="end">' + esc(fmtTok(v)) + '</text>'; });
    out += '<path class="area" d="' + line + 'L' + X(t1).toFixed(1) + ' ' + Y(0).toFixed(1) + 'L' + X(t0).toFixed(1) + ' ' + Y(0).toFixed(1) + 'Z"/><path class="line" d="' + line + '"/>';
    var ty = Y(C.T.bloatTokens).toFixed(1);
    out += '<line class="thresh" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + ty + '" y2="' + ty + '"/>';
    s.compactions.forEach(function (t) { if (t >= t0 && t <= t1) out += '<line class="compact" x1="' + X(t).toFixed(1) + '" x2="' + X(t).toFixed(1) + '" y1="' + padT + '" y2="' + (H - padB) + '"><title>Compacted ' + esc(when(t)) + '</title></line>'; });
    s.cold.forEach(function (t) {
      if (t < t0 || t > t1) return;
      var v = 0;
      for (var i = 0; i < pts.length; i++) { if (pts[i][0] <= t) v = pts[i][1]; else break; }
      out += '<circle class="coldm" cx="' + X(t).toFixed(1) + '" cy="' + Y(v).toFixed(1) + '" r="6"><title>Cache went cold ' + esc(when(t)) + '</title></circle>';
    });
    out += '<text x="' + padL + '" y="' + (H - 6) + '">' + esc(when(t0)) + '</text><text x="' + (W - padR) + '" y="' + (H - 6) + '" text-anchor="end">' + esc(new Date(t1).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: TZ })) + '</text>';
    el.innerHTML = out + '</svg>';
  }
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (state.view === 'dash') drawCharts(); }, 150);
  });

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
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches && e.target.matches('tr[data-act]')) { e.preventDefault(); e.target.click(); }
  });
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var FREE_LINE = 'Nothing in Burnrate needs an account except "Write our fixes", the one AI feature - a free account comes with $2 of AI credit, and one account works across every app on this site.';
  function openAccount(reason, then) {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Writing the fixes costs about a cent. Reading files, the dashboard, the findings and the report are free and need no account.</p><div id="billing"></div></div>' +
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Every finding, its fix and the report keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- one click listener ---------------- */

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); go('start'); break;
      case 'example': history.pushState(null, '', BASE + '#example'); openDemo(); break;
      case 'load': go('load'); break;
      case 'addperson': go('load'); break;
      case 'showdash': go(state.loadedPeople.length > 1 ? 'team' : 'overview'); break;
      case 'openlast': openSaved(); break;
      case 'clearlast': keep(K_LAST, null); toast('Cleared from this device'); if (state.source === 'saved') { state.a = null; state.source = null; go('start'); } else draw(); break;
      case 'tab': e.preventDefault(); go(t.getAttribute('data-tab')); break;
      case 'sort': state.sort = t.getAttribute('data-v'); state.showAll = false; drawTab(); break;
      case 'showall': state.showAll = true; drawTab(); break;
      case 'session': openSession(t.getAttribute('data-s')); break;
      case 'copysnip': copy(C.KINDS[t.getAttribute('data-k')].snippet, 'Copied the line for CLAUDE.md'); break;
      case 'prices': openPrices(); break;
      case 'resetprices': state.prices = null; keep(K_PRICES, null); if (state.ds) { analyse(); if (state.source === 'files') saveLast(); } closeSheet(); draw(); toast('Back to list prices'); break;
      case 'fixes': openFixes(); break;
      case 'signin-fixes': openAccount('Writing the fixes uses about a cent of AI credit; a free account comes with $2.', openFixes); break;
      case 'copyfixmd': copy(state.fixes.claudeMd.map(function (l) { return '- ' + l; }).join('\n'), 'Copied for CLAUDE.md'); break;
      case 'md': download(filename('.md'), 'text/markdown', C.toMarkdown(state.a, { fixes: state.fixes })); break;
      case 'copymd': copy(C.toMarkdown(state.a, { fixes: state.fixes }), 'Markdown copied'); break;
      case 'csv': download(filename('-sessions.csv'), 'text/csv', C.sessionsCsv(state.a)); break;
      case 'fcsv': download(filename('-findings.csv'), 'text/csv', C.findingsCsv(state.a)); break;
      case 'makecard': makeCard(); break;
      case 'sharecard': shareCard(); break;
      case 'savecard': if (state.card) download(filename('.png'), 'image/png', state.card.blob); break;
      default: break;
    }
  });

  /* ---------------- start ---------------- */

  state.prices = (function () { var p = recall(K_PRICES); return p ? C.cleanPrices(p) : null; }());
  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });
  drawTop();
  route();
  loadMe().then(function () {
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
  });
}());
