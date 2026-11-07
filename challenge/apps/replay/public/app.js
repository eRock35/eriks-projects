/* Replay - the page. One file, no build step.
 *
 * NO DECISION LOG EVER LEAVES THIS DEVICE. A log is read in a worker
 * (replay-worker.js) - or here when there is none - by ReplayCore, checked
 * there, hashed there with SubtleCrypto, and every pack, sample and report
 * is saved as a file this browser writes. The requests this page makes:
 * sign-in, the account's settings (never a decision), and the one optional
 * AI call, whose payload is the key names and their shape codes - shown in
 * full before it is sent.
 *
 * Browser storage is opt-in: "Keep my settings on this device" (off by
 * default, with Clear) keeps the settings and nothing else - never a log, a
 * record, a case id or a change log. Every access is wrapped in try/catch.
 *
 * Every string a log held, a person typed, the server sent or a model wrote
 * is escaped before it is drawn, and no handler is written into markup:
 * clicks are routed by data-act attributes from one listener (the lab's CSP
 * allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.ReplayCore;
  var D = window.ReplayDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural, groups = C.groups;
  var KEY = 'replay-v1';

  function recall() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function store(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function forget() { try { localStorage.removeItem(KEY); } catch (e) { /* nothing kept */ } }

  // A tag the browser reports but Intl refuses ("en-US@posix" in some
  // headless browsers) would make every date throw: fall back.
  var LOCALE = (function () { try { return Intl.getCanonicalLocales(navigator.language || 'en-US')[0] || 'en-US'; } catch (e) { return 'en-US'; } }());
  function stamp() {
    var d = new Date();
    try { return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(d); } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  var SEED_WORDS = ['cedar', 'harbor', 'maple', 'quartz', 'river', 'falcon', 'meadow', 'copper', 'linden', 'aspen', 'orchid', 'pebble', 'willow', 'summit', 'juniper', 'canyon'];
  function newSeed() {
    var a = new Uint32Array(2);
    try { crypto.getRandomValues(a); } catch (e) { a[0] = 7; a[1] = 42; }
    return SEED_WORDS[a[0] % SEED_WORDS.length] + '-' + (10 + (a[1] % 90));
  }
  var GROUPS = [
    { name: 'The decision', fields: ['id', 'time', 'case', 'outcome', 'score'] },
    { name: 'Model and prompt', fields: ['model', 'modelVersion', 'prompt', 'promptVersion', 'temperature', 'seed'] },
    { name: 'What went in', fields: ['inputs', 'inputsHash', 'tools'] },
    { name: 'Reasons and people', fields: ['reasons', 'rules', 'reviewer', 'override', 'overrideReason'] },
    { name: 'Proof', fields: ['prevHash', 'hash'] },
  ];
  var SEV_P = { critical: 'critical-p', high: 'high-p', medium: 'medium-p', low: 'low-p', info: 'info-p' };

  var state = {
    me: null, view: 'start',
    keep: false, device: { hint: false },
    settings: C.defaults(), syncBase: null, syncState: 'local', syncErr: '', conflictOpen: false,
    file: null, map: null, conf: {}, ranMap: '', report: null, open: {}, all: {},
    pack: null, packI: null, packOpts: { mask: true, inputs: true }, findQ: '', found: null,
    smp: { n: 25, seed: '', by: ['outcome', 'modelVersion'] }, sampleOut: null,
    changeLog: '', showCase: false, exportMask: true,
    busy: '', seq: 0, fileNo: 0, day: null,
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
  function download(name, type, data) {
    var blob = new Blob([data], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else here stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function meteredError(err, box, retry, why) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount(why, retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }
  function caseText(c) { return state.showCase ? C.line(c, 120) : C.mask(c); }
  /** A record's time, short: "16 Oct 14:20" in the log's own clock. */
  function timeShort(raw) {
    var t = C.parseTime(raw);
    return t ? C.shortDay(t.ms, t.off || 0) + ' ' + C.clockText(t.ms, t.off || 0) : C.visible(raw || '-', 32);
  }
  function where(r) { return r.n ? 'line ' + groups(r.n) : r.item ? 'item ' + groups(r.item) : r.i >= 0 ? 'record ' + groups(r.i + 1) : ''; }

  /* ---------------- the engine: a worker, or this page ---------------- */

  var engine = (function () {
    var w = null, seq = 0, waits = {}, local = null;
    try {
      if (window.Worker) {
        w = new Worker('replay-worker.js');
        w.addEventListener('message', function (e) {
          var m = e.data || {};
          var p = waits[m.id];
          if (!p) return;
          if (m.progress) { if (p.progress) p.progress(m.progress); return; }
          delete waits[m.id];
          if (m.ok) p.resolve(m.out); else p.reject(new Error(m.error));
        });
        w.addEventListener('error', function (e) {
          if (e && e.preventDefault) e.preventDefault();
          var all = waits; waits = {};
          Object.keys(all).forEach(function (k) { all[k].reject(new Error('The reader stopped. Reload the page and try again.')); });
        });
      }
    } catch (e) { w = null; }
    var enc = new TextEncoder();
    function digest(text) {
      if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('This page cannot hash here - open it at its https address.'));
      return crypto.subtle.digest('SHA-256', enc.encode(text)).then(C.hex);
    }
    function here(op, data, progress) {
      if (!local) local = C.createEngine({ digest: digest });
      if (op === 'load' && data.file) {
        if (data.file.size > C.LIMITS.fileBytes) return Promise.reject(new Error('That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Check a shorter period - a month at a time.'));
        return data.file.arrayBuffer().then(function (buf) { return local.load({ id: data.id, name: data.name, bytes: new Uint8Array(buf) }); });
      }
      if (op === 'load' && data.demo) return D.build(digest).then(function (d) { return local.load({ id: data.id, name: d.name, text: d.text }); });
      if (op === 'analyze') return local.analyze(data, progress);
      return new Promise(function (resolve, reject) { setTimeout(function () { try { resolve(local[op](data)); } catch (err) { reject(err); } }, 0); });
    }
    return {
      run: function (op, data, progress) {
        if (!w) return here(op, data || {}, progress);
        return new Promise(function (resolve, reject) {
          var id = ++seq;
          waits[id] = { resolve: resolve, reject: reject, progress: progress };
          w.postMessage({ id: id, op: op, data: data || {} });
        });
      },
    };
  }());

  /* ---------------- settings: on this device only if asked, and in the account ---------------- */

  var saveTimer = null;
  function saveSoon() { if (!state.keep) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
  function saveNow() {
    if (!state.keep) return;
    if (!store({ v: 1, keep: true, settings: state.settings, syncBase: state.syncBase, device: state.device })) toast('This browser would not keep it - your settings are still open here.', 4200);
  }
  var pushTimer = null, rerunTimer = null;
  function settingsChanged() {
    state.settings.updatedAt = Date.now();
    saveSoon();
    pushSoon();
    if (state.report) { clearTimeout(rerunTimer); rerunTimer = setTimeout(function () { runChecks(true); }, 350); }
  }
  function pushSoon() {
    if (!signedIn() || !state.me.sync) return;
    clearTimeout(pushTimer);
    state.syncState = 'syncing'; drawSync();
    pushTimer = setTimeout(function () { pushSettings(); }, 700);
  }
  function settingsBody() { var b = C.cleanSettings(state.settings).settings; delete b.updatedAt; return b; }
  function pushSettings(base) {
    if (!signedIn()) return Promise.resolve();
    return api('PUT', 'api/settings', { settings: settingsBody(), base: base !== undefined ? base : state.syncBase }).then(function (out) {
      state.syncBase = out.settings.updatedAt; state.syncState = 'synced'; state.syncErr = ''; saveSoon(); drawSync();
    }).catch(function (err) {
      if (err.status === 409 && err.data && err.data.settings) return openConflict(err.data.settings);
      state.syncState = 'error'; state.syncErr = err.message; drawSync();
    });
  }
  function pristine(s) { var a = C.cleanSettings(s).settings, b = C.defaults(); delete a.updatedAt; return JSON.stringify(a) === JSON.stringify(b); }
  function same(a, b) { var x = C.cleanSettings(a).settings, y = C.cleanSettings(b).settings; delete x.updatedAt; delete y.updatedAt; return JSON.stringify(x) === JSON.stringify(y); }
  function syncIn() {
    if (!signedIn() || !state.me.sync) return Promise.resolve();
    return api('GET', 'api/settings').then(function (out) {
      var acc = out.settings;
      if (!acc) { state.syncBase = null; if (!pristine(state.settings)) return pushSettings(null); state.syncState = 'synced'; drawSync(); return null; }
      if (pristine(state.settings)) { adopt(acc); state.syncBase = acc.updatedAt; state.syncState = 'synced'; drawSync(); saveSoon(); return null; }
      if (state.syncBase === acc.updatedAt) return pushSettings();
      if (same(acc, state.settings)) { state.syncBase = acc.updatedAt; state.syncState = 'synced'; drawSync(); return null; }
      return openConflict(acc);
    }).catch(function () { state.syncState = 'error'; drawSync(); });
  }
  function adopt(s) {
    state.settings = C.cleanSettings(s).settings;
    if (state.report) runChecks(true); else if (state.view !== 'start') draw();
  }
  function openConflict(acc) {
    if (state.conflictOpen) return;
    state.conflictOpen = true;
    var mine = state.settings, a = C.cleanSettings(acc).settings;
    var desc = function (s) { return esc(plural(s.codes.length, 'reason code')) + ', ' + esc(plural(s.presets.length, 'field preset')) + ', ' + esc(plural(s.words.length, 'outcome word')) + ', ' + esc(plural(s.required.length, 'must-record field')); };
    sheet('<h2>Your settings changed on another device</h2><p class="muted">The copy in your account is newer than the one this device last saw.</p><div class="note"><p style="margin:0"><b>This device:</b> ' + desc(mine) + '</p><p style="margin:6px 0 0"><b>Your account:</b> ' + desc(a) + '</p></div>' +
      '<div class="btns" style="margin-top:12px"><button class="btn" type="button" id="cfMerge">Merge them</button><button class="btn ghost" type="button" id="cfTake">Use the account’s copy</button><button class="btn ghost" type="button" id="cfKeep">Keep this device’s</button></div><p class="small muted" style="margin-top:8px">Merging keeps every reason code, outcome word and field preset from both - this device’s wins where both name the same one.</p>', function (root) {
      var done = function (s, msg) { state.conflictOpen = false; closeSheet(); adopt(s); saveSoon(); toast(msg); };
      $('#cfMerge', root).addEventListener('click', function () { var m = C.mergeSettings(a, mine); done(m.settings, 'Merged' + (m.added ? ': ' + plural(m.added, 'item') + ' added from the other device.' : '.')); pushSettings(acc.updatedAt); });
      $('#cfTake', root).addEventListener('click', function () { done(a, 'Using the account’s copy.'); state.syncBase = acc.updatedAt; state.syncState = 'synced'; drawSync(); });
      $('#cfKeep', root).addEventListener('click', function () { done(mine, 'Keeping this device’s settings.'); pushSettings(acc.updatedAt); });
    });
  }
  function syncLine() {
    if (!signedIn()) return '<span class="sync muted small">Settings stay in this tab' + (state.keep ? ' and on this device' : '') + ' · <button class="link-btn" type="button" data-act="signin">sign in to keep them in your account</button> (never a decision)</span>';
    if (state.me && !state.me.sync) return '<span class="sync muted small">Saving to the account is unavailable right now - your settings are on this device.</span>';
    if (state.syncState === 'syncing') return '<span class="sync muted small">Saving your settings to your account…</span>';
    if (state.syncState === 'error') return '<span class="sync small err">Couldn’t save to your account' + (state.syncErr ? ': ' + esc(state.syncErr) : '') + ' <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="sync small" style="color:var(--ok);font-weight:700">✓ Settings saved to your account - never a decision</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }
  /** The settings a check runs with: the demo always uses its own codes. */
  function runSettings() {
    var s = C.cleanSettings(state.settings).settings;
    if (state.file && state.file.demo) s.codes = D.CODES.map(function (c) { return { code: c.code, text: c.text }; });
    return s;
  }

  /* ---------------- loading a log, the fields, the checks ---------------- */

  function begin(file, run, after) {
    var old = state.file;
    state.file = file; state.report = null; state.map = null; state.conf = {}; state.ranMap = ''; state.open = {}; state.all = {};
    state.pack = null; state.packI = null; state.sampleOut = null; state.found = null; state.findQ = ''; state.day = null;
    state.busy = 'Reading ' + file.name + '…';
    var seq = ++state.seq;
    if (state.view === 'start') draw(); else go('report');
    if (old && old.id !== file.id) engine.run('drop', { id: old.id });
    return run().then(function (meta) {
      if (seq !== state.seq) return null;
      Object.keys(meta).forEach(function (k) { if (k !== 'id' && k !== 'name') file[k] = meta[k]; });
      state.map = {};
      C.FIELDS.forEach(function (f) { state.map[f] = meta.guess.map[f] || null; if (meta.guess.map[f]) state.conf[f] = meta.guess.conf[f]; });
      return after(meta, seq);
    }).catch(function (err) {
      if (seq !== state.seq) return;
      state.busy = ''; state.file = null;
      go('start');
      toast(err.message || 'That file could not be read.', 6000);
    });
  }
  function loadDemo() {
    var file = { id: 'demo-' + (++state.fileNo), name: D.FILE, demo: true };
    state.changeLog = D.CHANGE_LOG;
    begin(file, function () { return engine.run('load', { id: file.id, demo: true }); }, function () {
      return runChecks(false).then(function () {
        state.open = {};
        var h = hintFinding();
        if (h) state.open[h.key] = true;
        go('report');
        if (h && !state.device.hint) { var el = $('#f-' + h.key); if (el) el.classList.add('pulse'); }
      });
    });
  }
  function loadFile(fileObj) {
    if (!fileObj) return;
    if (fileObj.size > C.LIMITS.fileBytes) { toast('That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Check a shorter period - a month at a time.', 5000); return; }
    var file = { id: 'own-' + (++state.fileNo), name: C.line(fileObj.name, 120) || 'decision log', demo: false, size: fileObj.size };
    state.changeLog = '';
    begin(file, function () { return engine.run('load', { id: file.id, name: file.name, file: fileObj }); }, function (meta) {
      var p = C.presetFor(state.settings, meta.keys);
      if (p) {
        Object.keys(p.map).forEach(function (f) { if (meta.keys.some(function (k) { return k.path === p.map[f]; })) { state.map[f] = p.map[f]; state.conf[f] = 'preset'; } });
        file.preset = p.name;
      }
      state.busy = '';
      go('fields');
      toast('Read ' + plural(meta.records, 'record') + ' on this device. Check the fields, then run the checks.', 4200);
    });
  }
  function runChecks(keepView) {
    if (!state.file || !state.map) return Promise.resolve();
    var seq = ++state.seq;
    var n = state.file.records;
    state.busy = 'Checking ' + plural(n, 'decision') + '…';
    if (!keepView || !state.report) draw(); else drawBusyLine();
    return engine.run('analyze', { id: state.file.id, map: state.map, settings: runSettings(), changeLog: state.changeLog }, function (p) {
      if (seq !== state.seq) return;
      var b = $('#busyText');
      var t = 'Hashing ' + groups(p.done) + ' of ' + plural(p.total, 'record') + '…';
      if (b) b.textContent = t; else state.busy = t;
    }).then(function (rep) {
      if (seq !== state.seq) return;
      state.report = rep; state.ranMap = JSON.stringify(state.map); state.busy = '';
      if (state.packI !== null) refreshPack();
      if (state.view === 'sample' || state.sampleOut) drawSample(true);
      // a background re-run must not redraw a form someone is typing in
      if (state.view !== 'settings' || !keepView) keepPlace(draw);
    }).catch(function (err) {
      if (seq !== state.seq) return;
      state.busy = ''; draw();
      toast(err.message || 'The checks stopped.', 6000);
    });
  }
  function drawBusyLine() { if (state.view !== 'settings') toast('Checking again…', 1200); }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }
  function hintFinding() { return state.report ? state.report.findings.filter(function (f) { return f.key === 'chain-changed'; })[0] || null : null; }

  function openPack(i) {
    if (!state.report) return;
    state.packI = i;
    refreshPack().then(function () { go('replay'); });
  }
  function refreshPack() {
    return engine.run('pack', { id: state.file.id, i: state.packI }).then(function (p) { state.pack = p; if (state.view === 'replay') keepPlace(draw); }).catch(function (err) { toast(err.message, 4200); });
  }
  function drawSample(quiet) {
    if (!state.report) return Promise.resolve();
    if (!state.smp.seed) state.smp.seed = newSeed();
    return engine.run('sample', { id: state.file.id, n: state.smp.n, seed: state.smp.seed, by: state.smp.by }).then(function (s) { state.sampleOut = s; if (!quiet && state.view === 'sample') keepPlace(draw); }).catch(function (err) { toast(err.message, 4200); });
  }

  /* ---------------- routing ---------------- */

  var VIEWS = ['report', 'fields', 'replay', 'sample', 'export', 'settings'];
  function go(view) {
    history.pushState(null, '', BASE + '#' + view);
    route(); scrollTo(0, 0);
  }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    if (h === 'settings') state.view = 'settings';
    else state.view = VIEWS.indexOf(h) >= 0 && state.file ? h : 'start';
    if (state.view === 'sample' && state.report && !state.sampleOut) { drawSample(true).then(function () { if (state.view === 'sample') draw(); }); }
    draw();
  }
  function draw() {
    var main = $('#main');
    var tb = $('#tabbar');
    tb.hidden = !state.file || state.view === 'start';
    $$('#tabbar [data-tab]').forEach(function (b) {
      if (b.getAttribute('data-tab') === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      var tab = b.getAttribute('data-tab'), span = $('span', b);
      var crit = state.report ? state.report.counts.critical : 0;
      if (tab === 'report') span.innerHTML = 'Report' + (crit ? ' <i class="badge">' + esc(String(crit)) + '</i>' : '');
    });
    var sb = $('#settingsBtn');
    if (sb) { if (state.view === 'settings') sb.setAttribute('aria-current', 'page'); else sb.removeAttribute('aria-current'); }
    var html;
    if (state.busy) html = '<div class="card busy" role="status"><div class="spinner" aria-hidden="true"></div><p><b id="busyText">' + esc(state.busy) + '</b></p><p class="small muted">On this device - nothing is uploaded.</p></div>';
    else if (state.view === 'settings') html = settingsHtml();
    else if (state.view === 'start' || !state.file) html = startHtml();
    else if (state.view === 'fields') html = fieldsHtml();
    else if (!state.report) html = notYetHtml();
    else if (state.view === 'replay') html = replayHtml();
    else if (state.view === 'sample') html = sampleHtml();
    else if (state.view === 'export') html = exportHtml();
    else html = reportHtml();
    main.innerHTML = html + footer();
    wire();
  }
  function footer() {
    return '<footer class="foot"><p>Replay reads decision logs on this device; nothing is uploaded. A starting checklist, not legal advice.</p><p>A Challenge Lab app · <a href="../">more experiments</a></p></footer>';
  }
  function notYetHtml() {
    return '<section class="card"><h2>Run the checks first</h2><p class="muted">Check the fields Replay found in ' + esc(state.file.name) + ', then run the checks - the report, the replay packs and the sample come from them.</p><div class="btns"><button class="btn" type="button" data-act="tab" data-tab="fields">Check the fields →</button></div></section>';
  }

  /* ---------------- first run ---------------- */

  function startHtml() {
    return '<div class="stack">' +
      '<section class="hero">' +
        '<p class="kicker">📼 Decision records you can defend</p>' +
        '<h1>Every automated decision, recorded well enough to replay - and explain.</h1>' +
        '<p>When an examiner, an auditor or a customer asks “why was this declined?”, Replay shows what your log can prove - record by record - and builds the one-page answer for any single decision.</p>' +
        '<div class="btns"><button class="btn big primary" type="button" data-act="demo">Try the demo</button>' +
        '<label class="btn big ghost filepick">Check my log<input type="file" data-file accept=".jsonl,.ndjson,.json,.csv,.txt,.log,application/json,text/csv,text/plain"></label></div>' +
        '<p class="caps">Read on this device, never uploaded. JSON Lines, a JSON array or CSV - up to 20 MB and 100,000 decisions.</p>' +
        mockHtml() +
      '</section>' +
      '<button class="card demo-card" type="button" data-act="demo"><span class="ico" aria-hidden="true">🏦</span><b>' + esc(D.LENDER) + ' · October 2026</b><p>' + esc(D.blurb) + ' Made up from end to end.</p></button>' +
      '<section class="grid3 how" aria-label="How it works">' +
        '<div class="card"><span class="n">1</span><h2>Drop the decision log</h2><p>JSON Lines, a JSON array or CSV, nested keys and all. Replay guesses which key is the model version, the inputs, the reasons - you confirm.</p></div>' +
        '<div class="card"><span class="n">2</span><h2>See what it cannot prove</h2><p>Missing versions and inputs, declines with no reasons, temperature above 0, unlogged prompt changes, a broken hash chain, overrides with nobody’s name - with the exact records.</p></div>' +
        '<div class="card"><span class="n">3</span><h2>Answer for one decision</h2><p>A one-page replay pack for any decision: what went in, which model and prompt, the reasons in words, who overrode it and the hash proof. Plus a reproducible review sample.</p></div>' +
      '</section>' +
      '<section class="dropzone" data-drop><p style="margin:0"><b>Or drop a decision log here</b></p><p class="small muted" style="margin:0">It is read in this browser. Not even its name leaves the device.</p><label class="btn ghost filepick">Choose a file<input type="file" data-file accept=".jsonl,.ndjson,.json,.csv,.txt,.log,application/json,text/csv,text/plain"></label></section>' +
      '<section class="card"><h2>What it checks</h2><ul class="chips">' + ['Model id and version on every record', 'Prompt version or hash', 'Inputs or their hash', 'Declines with no reasons', 'Reason codes nobody can explain', 'More reasons than your policy allows', 'Temperature above 0, no seed', 'Same inputs, different outcomes', 'Prompt and model changes vs your change log', 'A SHA-256 hash chain, link by link', 'Edited, missing and reordered records', 'Duplicate ids and numbering gaps', 'Out-of-order times', 'Overrides with no reviewer or reason', 'Override rates by reviewer', 'Logging outages at busy times'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>' +
      '<p class="privacy-line">🔒 <span><b>Nothing is uploaded.</b> Decision logs hold customer data, so the file is read, checked, hashed and exported by this browser. A free account only keeps your checking settings - the must-record profile, your reason codes, key-name presets - never a decision. A starting checklist, not legal advice.</span></p>' +
    '</div>';
  }
  function mockHtml() {
    return '<div class="mock" aria-hidden="true"><div class="mh"><span>riverton-decisions.jsonl</span><span class="mf">400 decisions</span></div><ul>' +
      '<li><span class="mp mc">✗ Critical</span><span>One record changed after it was written</span></li>' +
      '<li><span class="mp mc">✗ Critical</span><span>11 declines with no reasons</span></li>' +
      '<li><span class="mp mhh">! High</span><span>Prompt 3.2 has no change-log entry</span></li>' +
      '<li><span class="mp mhh">! High</span><span>12 calls at temperature 0.7</span></li>' +
      '<li><span class="mp mhh">! High</span><span>4 overrides with no reviewer</span></li>' +
      '</ul><div class="mok">✓ 399 of 400 hashes verified</div></div>';
  }

  /* ---------------- the fields ---------------- */

  /** The fields the profile asks for on every decision (the ones that apply
   *  only to adverse outcomes or overrides are not "required - not found"
   *  when the log simply has none). */
  function requiredSet() {
    var req = {};
    runSettings().required.forEach(function (f) { if (f !== 'inputs') req[f] = 1; });
    return req;
  }
  function badge(f) {
    var c = state.conf[f], mapped = Boolean(state.map[f]);
    var req = requiredSet();
    var needInputs = runSettings().required.indexOf('inputs') >= 0 && !state.map.inputs && !state.map.inputsHash && (f === 'inputs' || f === 'inputsHash');
    if (!mapped) return (req[f] || needInputs) ? '<span class="sure sure-need">Required - not found</span>' : '<span class="sure sure-none">Not in this log</span>';
    if (c === 'sure') return '<span class="sure sure-sure">✓ Sure</span>';
    if (c === 'likely') return '<span class="sure sure-likely">Likely</span>';
    if (c === 'unsure') return '<span class="sure sure-unsure">Unsure - check it</span>';
    if (c === 'preset') return '<span class="sure sure-preset">From your preset</span>';
    if (c === 'you') return '<span class="sure sure-you">You chose</span>';
    if (c && c.indexOf('ai-') === 0) return '<span class="sure sure-ai">✨ AI · ' + esc(c.slice(3)) + '</span>';
    return '<span class="sure sure-likely">Chosen</span>';
  }
  function keyOf(path) { return state.file && state.file.keys ? state.file.keys.filter(function (k) { return k.path === path; })[0] || null : null; }
  function mapRowHtml(f) {
    var k = state.map[f] ? keyOf(state.map[f]) : null;
    var req = requiredSet();
    var need = !state.map[f] && (req[f] || (runSettings().required.indexOf('inputs') >= 0 && !state.map.inputs && !state.map.inputsHash && (f === 'inputs' || f === 'inputsHash')));
    var opts = '<option value="">- not in this log -</option>' + state.file.keys.map(function (x) {
      return '<option value="' + esc(x.path) + '"' + (x.path === state.map[f] ? ' selected' : '') + '>' + esc(C.visible(x.path, 70) + (x.share < 0.995 ? ' (' + C.pct(x.n, state.file.records) + ')' : '')) + '</option>';
    }).join('');
    var looks = k ? k.shapes.map(function (s) { return C.SHAPES[s]; }).join('; ') : '';
    return '<li class="maprow' + (need ? ' need' : '') + '"><div class="mh"><b>' + esc(C.FIELD_LABEL[f]) + '</b>' + badge(f) + '</div>' +
      '<p class="mv">' + (k ? 'e.g. <code>' + esc(k.samples.join('  ·  ') || '-') + '</code> · ' + esc(looks) : esc(C.FIELD_HELP[f])) + '</p>' +
      '<select class="input" data-field="' + esc(f) + '" aria-label="' + esc('Which key is the ' + C.FIELD_LABEL[f].toLowerCase()) + '">' + opts + '</select></li>';
  }
  function fileStripHtml() {
    var f = state.file;
    var fmt = { jsonl: 'JSON Lines', json: 'JSON' + (f.wrapped ? ' (records under “' + f.wrapped + '”)' : ''), csv: 'CSV (' + ({ ',': 'commas', ';': 'semicolons', '\t': 'tabs', '|': 'pipes' }[f.delim] || 'commas') + ')' }[f.format] || f.format;
    var bits = [fmt, plural(f.records, 'record'), plural(f.keys.length, 'key')];
    if (f.unreadable) bits.push(plural(f.unreadable, 'unreadable line'));
    if (f.badBytes) bits.push(plural(f.badBytes, 'character') + ' that were not UTF-8');
    if (f.truncated) bits.push(groups(f.truncated) + ' more not read');
    return '<section class="card filestrip"><p class="lab">The log</p><p class="fname">' + esc(f.name) + '</p><p class="fmeta">' + esc(bits.join(' · ')) + '</p></section>';
  }
  function fieldsHtml() {
    var f = state.file;
    var placed = C.FIELDS.filter(function (x) { return state.map[x]; }).length;
    var unsure = C.FIELDS.filter(function (x) { return state.map[x] && state.conf[x] === 'unsure'; }).length;
    var req = requiredSet();
    var missingReq = Object.keys(req).filter(function (x) { return !state.map[x]; }).length + (runSettings().required.indexOf('inputs') >= 0 && !state.map.inputs && !state.map.inputsHash ? 1 : 0);
    var changed = state.report && state.ranMap !== JSON.stringify(state.map);
    return '<div class="stack">' + (f.demo ? demoStrip() : '') + fileStripHtml() +
      '<section class="card"><div class="sec-head"><h1>Check the fields</h1><span class="small muted">' + esc(placed + ' of ' + C.FIELDS.length + ' placed' + (unsure ? ' · ' + unsure + ' unsure' : '')) + '</span></div>' +
      '<p class="muted">Replay guessed which key holds each field from the key names and what the values look like - the examples come from your file and stay on this device. Check them, especially any marked unsure, then run the checks.</p>' +
      '<div class="btns no-print" style="margin-bottom:10px"><button class="btn small ghost" type="button" data-act="ai">✨ Help me map these fields</button><button class="btn small ghost" type="button" data-act="preset">Save as a preset</button></div>' +
      (f.preset ? '<p class="small okw" style="color:var(--ok);font-weight:700">✓ Using your preset “' + esc(f.preset) + '”</p>' : '') +
      (missingReq ? '<p class="small" style="color:var(--high);font-weight:700">' + esc(plural(missingReq, 'field') + ' your must-record profile asks for ' + (missingReq === 1 ? 'is' : 'are') + ' not in this log - the report will say so.') + '</p>' : '') +
      '<div class="fgroups">' + GROUPS.map(function (g) { return '<div class="fgroup"><h3>' + esc(g.name) + '</h3><ul class="maplist">' + g.fields.map(mapRowHtml).join('') + '</ul></div>'; }).join('') + '</div></section>' +
      '<section class="card"><details class="why"><summary>Every key in this file (' + esc(String(f.keys.length)) + (f.moreKeys ? ', and ' + esc(String(f.moreKeys)) + ' more not listed' : '') + ')</summary><div class="tablewrap" tabindex="0"><table class="plain"><thead><tr><th>Key</th><th class="r">Present</th><th>Looks like</th><th>e.g.</th></tr></thead><tbody>' +
      f.keys.map(function (k) { return '<tr><td><code>' + esc(C.visible(k.path, 80)) + '</code></td><td class="r">' + esc(C.pct(k.n, f.records)) + '</td><td>' + esc(k.shapes.map(function (s) { return C.SHAPES[s]; }).join('; ')) + '</td><td><code>' + esc(k.samples.join('  ·  ')) + '</code></td></tr>'; }).join('') +
      '</tbody></table></div></details></section>' +
      '<div class="sticky-acts no-print"><span class="small muted">' + esc(changed ? 'Fields changed since the last run.' : f.demo ? 'The demo’s fields are already confirmed.' : 'Nothing runs until you say so.') + '</span>' +
      '<button class="btn" type="button" data-act="run">' + (state.report ? 'Run the checks again →' : 'These look right - run the checks →') + '</button></div>' +
    '</div>';
  }

  /* ---------------- the report ---------------- */

  function demoStrip() {
    return '<div class="demo-strip"><p>🧪 A <b>made-up</b> log from ' + esc(D.LENDER) + ' - every case id, business, number and reviewer is invented.</p><label class="btn small ghost filepick">Check my log<input type="file" data-file accept=".jsonl,.ndjson,.json,.csv,.txt,.log,application/json,text/csv,text/plain"></label></div>';
  }
  function verdictHtml() {
    var r = state.report, st = r.stats, c = r.counts, ch = r.chain;
    var total = r.findings.filter(function (f) { return f.sev !== 'info'; }).length;
    var cls = c.critical ? '' : c.high ? ' v-high' : ' v-ok';
    var big = !total ? 'Nothing found that this profile flags' : plural(total, 'finding') + (c.critical ? ' - ' + c.critical + ' critical' : c.high ? ' - ' + c.high + ' high' : '');
    var adv = r.findings.filter(function (f) { return f.key === 'adverse-none'; })[0];
    var bad = ch && ch.mapped ? ch.changed + ch.unlinked : 0;
    var chainV = !ch || !ch.mapped ? 'None' : ch.scheme === false ? '?' : bad ? groups(bad) + ' broken' : 'All';
    var chainS = !ch || !ch.mapped ? 'no hashes - nothing proves it was not edited' : ch.scheme === false ? 'the recipe differs - see Settings' : groups(ch.verified) + ' of ' + groups(ch.hashed) + ' hashes verified' + (ch.changed ? ' · ' + groups(ch.changed) + ' changed after writing' : '') + (ch.unlinked ? ' · ' + groups(ch.unlinked) + ' out of the chain' : '');
    return '<section class="card verdict' + cls + '"><p class="big">' + esc(big) + '</p>' +
      '<div class="counts">' + C.SEV.filter(function (s) { return c[s]; }).map(function (s) { return '<span class="cpill ' + SEV_P[s] + '">' + esc(C.SEV_MARK[s] + ' ' + c[s] + ' ' + C.SEV_WORD[s].toLowerCase()) + '</span>'; }).join('') + (!total ? '<span class="cpill ok-p">✓ Clean against this profile</span>' : '') + '</div>' +
      '<div class="kpis">' +
        '<div class="kpi"><span class="k">Fully replayable</span><span class="v">' + esc(C.pct(st.replayable, st.records)) + '</span><span class="s">' + esc(groups(st.replayable) + ' of ' + groups(st.records)) + '</span><div class="meter" aria-hidden="true"><i style="width:' + esc(String(Math.round(st.share * 100))) + '%"></i></div></div>' +
        '<div class="kpi"><span class="k">Hash chain</span><span class="v">' + esc(chainV) + '</span><span class="s">' + esc(chainS) + '</span></div>' +
        '<div class="kpi"><span class="k">Decisions</span><span class="v">' + esc(groups(st.records)) + '</span><span class="s">' + esc(st.period || 'no readable times') + '</span></div>' +
        '<div class="kpi"><span class="k">Adverse, no reasons</span><span class="v">' + esc(String(adv ? adv.count : 0)) + '</span><span class="s">' + esc('of ' + plural(st.adverse, 'adverse outcome')) + '</span></div>' +
      '</div>' +
      '<div class="btns no-print"><button class="btn" type="button" data-act="tab" data-tab="replay">Open a replay pack →</button><button class="btn ghost" type="button" data-act="tab" data-tab="sample">Draw a review sample</button><button class="btn ghost" type="button" data-act="tab" data-tab="export">Export the findings</button></div></section>';
  }
  function hintHtml() {
    var h = hintFinding();
    if (!h || !state.file.demo || state.device.hint) return '';
    var first = h.refs[0];
    return '<div class="hint no-print" role="note"><span class="ico" aria-hidden="true">👉</span><div><p><b>Start here.</b> Someone changed ' + esc(first.id) + ' after it was written - a decline that now reads approve - and the hash chain gives it away. The finding below names the first broken link; the replay pack shows what can and cannot be proven about it.</p>' +
      '<div class="btns"><button class="btn small" type="button" data-act="pack" data-i="' + esc(String(first.i)) + '">Open its replay pack</button><button class="btn small ghost" type="button" data-act="hintoff">Got it</button></div></div></div>';
  }
  function staleHtml() {
    if (!state.report || state.ranMap === JSON.stringify(state.map)) return '';
    return '<div class="stale no-print"><p class="small"><b>The fields changed</b> since these checks ran.</p><button class="btn small" type="button" data-act="run">Run them again</button></div>';
  }
  function recsHtml(f) {
    if (!f.refs.length) return '';
    var showAll = state.all[f.key];
    var list = showAll ? f.refs : f.refs.slice(0, 12);
    if (f.key === 'unreadable') {
      return '<div class="tablewrap" tabindex="0"><table class="recs"><thead><tr><th>Line</th><th>Why</th></tr></thead><tbody>' + list.map(function (r) { return '<tr><td>' + esc(r.n ? groups(r.n) : r.item ? 'item ' + groups(r.item) : '-') + '</td><td>' + esc(r.why) + '</td></tr>'; }).join('') + '</tbody></table></div>' + moreHtml(f, list.length);
    }
    return '<div class="tablewrap" tabindex="0"><table class="recs"><thead><tr><th>Decision</th><th>Time</th><th>Case</th><th>Outcome</th><th><span class="sr">Replay pack</span></th></tr></thead><tbody>' +
      list.map(function (r) { return '<tr><td class="id">' + esc(C.visible(r.id || '-', 40)) + '<small>' + esc(where(r)) + '</small></td><td>' + esc(timeShort(r.time)) + '</td><td>' + esc(caseText(r.case) || '-') + '</td><td>' + esc(C.OUTCOME_WORD[r.outcome] || C.visible(r.outcome || '-', 20)) + '</td><td><button class="btn small ghost" type="button" data-act="pack" data-i="' + esc(String(r.i)) + '">Open</button></td></tr>'; }).join('') +
      '</tbody></table></div>' + moreHtml(f, list.length);
  }
  function moreHtml(f, shown) {
    var rest = f.count - shown;
    if (rest <= 0) return '';
    var canShow = f.refs.length - shown;
    return '<p class="more">' + (canShow > 0 ? '<button class="link-btn" type="button" data-act="showall" data-k="' + esc(f.key) + '">Show ' + esc(String(canShow)) + ' more</button> · ' : '') + esc(groups(f.count) + ' in all - every one is in the flagged-records CSV on Export.') + '</p>';
  }
  function proofHtml(x) {
    return '<div class="proofbox"><div class="pr"><span>In the log</span><span class="hashtxt">' + esc(x.stored) + '</span></div><div class="pr bad"><span>Replay computed</span><span class="hashtxt">' + esc(x.computed) + '</span></div><div class="pr"><span>Previous hash</span><span class="hashtxt">' + esc(x.prev || '(none)') + '</span></div></div>';
  }
  function snippetHtml(open) {
    return '<details class="why"' + (open ? ' open' : '') + '><summary>How the hashes are checked - and how to add them</summary><p class="small">Each record’s hash is SHA-256 over the previous record’s hash, a line feed, then the record without its own hash - as <b>canonical JSON</b> (keys sorted at every level, no spaces, strings and numbers as JSON writes them) or, if you choose it in Settings, as <b>the raw line</b> with the hash member removed. Replay checks every record against its own hash, and every previous-hash against the record above it. A writer that matches, in Node (shown here, nothing runs):</p><pre class="out" tabindex="0">' + esc(C.HASH_SNIPPET) + '</pre></details>';
  }
  function extraHtml(f) {
    var x = f.extra;
    if (f.key === 'chain-changed' && x) return proofHtml(x) + '<div class="btns"><button class="btn small" type="button" data-act="pack" data-i="' + esc(String(x.first.i)) + '">Open its replay pack</button></div>';
    if (f.key === 'chain-none' || f.key === 'chain-scheme') return snippetHtml(f.key === 'chain-none') + (f.key === 'chain-scheme' ? '<div class="btns"><button class="btn small ghost" type="button" data-act="tab" data-tab="settings">Change the recipe in Settings</button></div>' : '');
    if (f.key === 'gap' && x) return x.gaps.slice(0, 3).map(function (g) { return hoursHtml(g); }).join('');
    if ((f.key === 'drift-unlogged' || f.key === 'drift-nolog' || f.key === 'drift-early') && state.report.drift.length) return '<div class="btns"><button class="btn small ghost" type="button" data-act="goto" data-to="versions">See the version history and the change log →</button></div>';
    if (f.key === 'same-inputs' && x) {
      return '<div class="tablewrap" tabindex="0"><table class="recs"><thead><tr><th>Decision</th><th>Outcome</th><th>Model</th><th>Prompt</th><th><span class="sr">Replay pack</span></th></tr></thead><tbody>' + x.groups.slice(0, 6).map(function (g, gi) {
        return g.refs.map(function (r, k) { return '<tr' + (k === 0 && gi > 0 ? ' style="border-top:2px solid var(--line)"' : '') + '><td class="id">' + esc(r.id || where(r)) + '</td><td>' + esc(C.OUTCOME_WORD[r.outcome] || r.outcome || '-') + '</td><td>' + esc(g.versions[k][0] || '-') + '</td><td>' + esc(g.versions[k][1] || '-') + '</td><td><button class="btn small ghost" type="button" data-act="pack" data-i="' + esc(String(r.i)) + '">Open</button></td></tr>'; }).join('');
      }).join('') + '</tbody></table></div>';
    }
    if ((f.key === 'override-noreviewer' || f.key === 'override-noreason' || f.key === 'override-rate') && state.report.overrides) return '<div class="btns"><button class="btn small ghost" type="button" data-act="goto" data-to="overrides">See overrides by reviewer →</button></div>';
    if (f.key === 'adverse-unknown' || f.key === 'outcome-unknown' || f.key === 'codes-nolist') return '<div class="btns"><button class="btn small ghost" type="button" data-act="tab" data-tab="settings">Edit the lists in Settings</button></div>';
    if (f.key === 'unmapped') return '<div class="btns"><button class="btn small ghost" type="button" data-act="tab" data-tab="fields">Check the fields</button></div>';
    return '';
  }
  function findingHtml(f, hint) {
    var open = Boolean(state.open[f.key]);
    var count = f.key === 'unreadable' ? plural(f.count, 'line') : f.count ? plural(f.count, 'record') : '';
    return '<li class="finding sev-' + esc(f.sev) + (hint ? ' hinted' : '') + '" id="f-' + esc(f.key) + '">' +
      '<button class="fhead" type="button" data-act="ftoggle" data-k="' + esc(f.key) + '" aria-expanded="' + (open ? 'true' : 'false') + '"><span class="ft">' + esc(f.title) + '</span><span class="chev" aria-hidden="true">' + (open ? '▾' : '▸') + '</span>' +
      '<span class="fl"><span class="sevpill ' + SEV_P[f.sev] + '">' + esc(C.SEV_MARK[f.sev] + ' ' + C.SEV_WORD[f.sev]) + '</span>' + (count ? '<span>' + esc(count) + '</span>' : '') + '</span></button>' +
      (open ? '<div class="fbody"><p>' + esc(f.detail) + '</p>' + extraHtml(f) + recsHtml(f) + '</div>' : '') + '</li>';
  }
  function findingsHtml() {
    var F = state.report.findings, h = state.file.demo && !state.device.hint ? hintFinding() : null;
    if (!F.length) return '<section class="card"><h2>Findings</h2><p class="muted">Nothing found against this profile. Tighten it in Settings - for example require a seed, or the case id - and the checks run again.</p></section>';
    return '<section class="card"><div class="sec-head"><h2>Findings, most serious first</h2><span class="small muted"><button class="link-btn" type="button" data-act="showcase">' + (state.showCase ? 'Mask case ids' : 'Show case ids') + '</button></span></div><ul class="findings">' + F.map(function (f) { return findingHtml(f, h && f === h); }).join('') + '</ul></section>';
  }

  /* ---------------- charts (numbers in words beside each) ---------------- */

  function volumeHtml() {
    var days = state.report.days;
    if (!days || days.length < 2) return '';
    var max = Math.max.apply(null, days.map(function (d) { return d.count; })) || 1;
    var gapDays = {};
    (state.report.gaps || []).forEach(function (g) { gapDays[g.day] = g; });
    var off = state.report.stats.off;
    var label = function (d) { var p = d.day.split('-'); return C.shortDay(Date.UTC(+p[0], +p[1] - 1, +p[2]), 0); };
    var bars = days.map(function (d) {
      var g = gapDays[d.day];
      var t = label(d) + ': ' + plural(d.count, 'decision') + (g ? ' - nothing logged ' + C.clockText(g.a, off) + '–' + C.clockText(g.b, off) : '');
      return '<div class="d' + (g ? ' flagged' : '') + (state.day === d.day ? ' on' : '') + '" data-day="' + esc(d.day) + '" data-read="' + esc(t) + '" title="' + esc(t) + '"><i style="height:' + esc(String(Math.round(d.count / max * 82))) + '%"></i></div>';
    }).join('');
    var sel = state.day ? days.filter(function (d) { return d.day === state.day; })[0] : null;
    var g0 = sel ? gapDays[sel.day] : null;
    var read = sel ? label(sel) + ': ' + plural(sel.count, 'decision') + (g0 ? ' - nothing logged ' + C.clockText(g0.a, off) + '–' + C.clockText(g0.b, off) : '') : (Object.keys(gapDays).length ? plural(Object.keys(gapDays).length, 'day') + ' with a quiet stretch at a busy time (marked !).' : 'Point at a day, or pick one below.');
    var optsHtml = '<option value="">Pick a day…</option>' + days.map(function (d) { var g = gapDays[d.day]; return '<option value="' + esc(d.day) + '"' + (state.day === d.day ? ' selected' : '') + '>' + esc(label(d) + ' - ' + plural(d.count, 'decision') + (g ? ' (quiet stretch)' : '')) + '</option>'; }).join('');
    return '<section class="card chart" id="volume"><div class="sec-head"><h2>Decisions per day</h2><span class="small muted">' + esc('peak ' + max + ' a day') + '</span></div><div class="vol" role="img" aria-label="' + esc('Decisions per day, ' + label(days[0]) + ' to ' + label(days[days.length - 1]) + ', peak ' + max + '. ' + read) + '">' + bars + '</div><div class="axis" aria-hidden="true"><span>' + esc(label(days[0])) + '</span><span>' + esc(label(days[Math.floor(days.length / 2)])) + '</span><span>' + esc(label(days[days.length - 1])) + '</span></div><p class="readout" id="dayReadout" aria-live="polite">' + esc(read) + '</p><label class="field"><span class="sr">Show one day</span><select class="input" id="daySel">' + optsHtml + '</select></label></section>';
  }
  function hoursHtml(g) {
    var days = state.report.days, day = days.filter(function (d) { return d.day === g.day; })[0];
    if (!day) return '';
    var weekday = day.dow !== 0 && day.dow !== 6;
    var like = days.filter(function (d) { return d.day !== g.day && (d.dow !== 0 && d.dow !== 6) === weekday && d.count; });
    var usual = new Array(24).fill(0);
    like.forEach(function (d) { d.hours.forEach(function (v, h) { usual[h] += v / like.length; }); });
    var off = g.off, ga = C.wall(g.a, off), gb = C.wall(g.b, off);
    var from = Math.max(0, Math.min(6, ga.h) - 0), to = Math.min(23, Math.max(19, gb.h));
    var hrs = [];
    for (var h = from; h <= to; h++) hrs.push(h);
    var max = Math.max.apply(null, hrs.map(function (h) { return Math.max(day.hours[h], usual[h]); })) || 1;
    var inGap = function (h) { return (h > ga.h || (h === ga.h && ga.mi < 45)) && (h < gb.h || (h === gb.h && gb.mi > 15)); };
    return '<div class="chart"><h3 class="small">' + esc(g.whenText + ' - hour by hour') + '</h3><div class="hours" role="img" aria-label="' + esc('Decisions per hour that day against a usual ' + (weekday ? 'weekday' : 'weekend day')) + '">' +
      hrs.map(function (hh) { return '<div class="h' + (inGap(hh) ? ' gap' : '') + '" title="' + esc(('0' + hh).slice(-2) + ':00 - ' + day.hours[hh] + ' that day, about ' + (Math.round(usual[hh] * 10) / 10) + ' usually') + '"><i style="height:' + esc(String(Math.round(day.hours[hh] / max * 100))) + '%"></i><b style="bottom:' + esc(String(Math.round(usual[hh] / max * 100))) + '%"></b></div>'; }).join('') +
      '</div><div class="axis" aria-hidden="true"><span>' + esc(('0' + from).slice(-2) + ':00') + '</span><span>12:00</span><span>' + esc(('0' + to).slice(-2) + ':00') + '</span></div><ul class="legend"><li><span class="sw s1"></span>That day</li><li><span class="sw line"></span>A usual ' + (weekday ? 'weekday' : 'weekend day') + '</li><li><span class="sw gapsw"></span>Nothing logged</li></ul></div>';
  }
  function versionsHtml() {
    var r = state.report;
    var kinds = r.drift;
    var parsed = r.changeLog;
    var body = '';
    if (!kinds.length) body = '<p class="muted small">This log has no model or prompt version field, so there is no history to draw. Map one on the Fields tab.</p>';
    else {
      var lo = r.stats.first, hi = r.stats.last, span = Math.max(1, hi - lo);
      body = '<div class="timeline">' + kinds.map(function (k) {
        var order = k.versions.map(function (v) { return v.label; });
        var slot = function (label) { var i = order.indexOf(label); return i >= 0 && i < 3 ? 's' + (i + 1) : 's0'; };
        var segs = k.runs.map(function (run, idx) {
          var next = k.runs[idx + 1];
          var a = (run.from - lo) / span * 100, b = ((next ? next.from : hi) - lo) / span * 100;
          return '<span class="seg2 ' + slot(run.label) + '" style="left:' + esc(a.toFixed(2)) + '%;width:' + esc(Math.max(0.4, b - a).toFixed(2)) + '%" title="' + esc(run.label + ': ' + plural(run.count, 'decision')) + '"></span>';
        }).join('');
        var changes = k.changes.length ? (k.mixed ? 'Versions ran side by side - ' + plural(k.changes.length, 'switch', 'switches') + '.' : k.changes.map(function (c) { return c.from + ' → ' + c.to + ' on ' + C.dayText(c.at, c.off); }).join(' · ')) : 'One version all period.';
        return '<div class="tl-row"><span class="tl-lab">' + esc(k.kind === 'model' ? 'Model version' : 'Prompt version') + '</span><div class="track" role="img" aria-label="' + esc((k.kind === 'model' ? 'Model' : 'Prompt') + ' versions over time: ' + changes) + '">' + segs + '</div><p class="small muted" style="margin:0">' + esc(changes) + '</p>' +
          '<ul class="vlist">' + k.versions.map(function (v, i) {
            var stHtml = v.entry ? '<span class="st ok-p">✓ ' + esc('approved ' + v.entry.day) + '</span>' : v.entry === null ? '<span class="st high-p">! no change-log entry</span>' : '';
            return '<li><span class="sw ' + (i < 3 ? 's' + (i + 1) : 's0') + '"></span><span class="vv">' + esc(v.label) + '</span>' + stHtml + '<span class="vm">' + esc(plural(v.count, 'decision') + ' · ' + C.spanText(v.first, v.last, v.off || 0) + (v.entry && v.entry.approver ? ' · ' + v.entry.approver : '')) + '</span></li>';
          }).join('') + '</ul></div>';
      }).join('') + '</div>';
    }
    return '<section class="card" id="versions"><div class="sec-head"><h2>Versions and the change log</h2></div>' + body +
      '<label class="field" style="margin-top:12px"><span>Your change log - one change a line</span><textarea class="input mono" id="changeLog" rows="4" spellcheck="false" placeholder="2026-10-21, riverton-underwriter 2.5.0, Model Risk Committee">' + esc(state.changeLog) + '</textarea><small>Date, version, approver. Read on this device and never stored - not even with your settings.</small></label>' +
      (parsed && parsed.errors.length ? '<p class="small err">' + esc(parsed.errors.slice(0, 3).join(' ')) + '</p>' : '') +
      '<div class="btns" style="margin-top:8px"><button class="btn small" type="button" data-act="checklog">Check against it</button>' + (parsed ? '<span class="small muted">' + esc(plural(parsed.entries, 'entry', 'entries') + ' read') + '</span>' : '') + '</div></section>';
  }
  function overridesHtml() {
    var o = state.report.overrides;
    if (!o) return '';
    var rowsHtml = o.byReviewer.map(function (x) {
      var rate = x.reviewed ? x.overrides / x.reviewed : 0;
      return '<tr><td>' + (x.none ? '<b style="color:var(--high)">! ' + esc(x.who) + '</b>' : esc(x.who)) + '</td><td class="r">' + esc(groups(x.overrides) + ' of ' + groups(x.reviewed)) + '</td><td class="r">' + esc(C.pct(x.overrides, x.reviewed)) + '<span class="inlinebar" aria-hidden="true"><i style="width:' + esc(String(Math.round(rate * 100))) + '%"></i></span></td></tr>';
    }).join('');
    var outHtml = o.byOutcome.map(function (x) { return '<tr><td>' + esc(x.outcome) + '</td><td class="r">' + esc(groups(x.reviewed)) + '</td><td class="r">' + esc(groups(x.overrides)) + '</td></tr>'; }).join('');
    return '<section class="card" id="overrides"><div class="sec-head"><h2>Overrides</h2><span class="small muted">' + esc(plural(o.total, 'override') + ' in ' + plural(o.reviewed, 'reviewed decision')) + '</span></div>' +
      (o.byReviewer.length ? '<div class="tablewrap" tabindex="0"><table class="plain"><thead><tr><th>Reviewer</th><th class="r">Overrode</th><th class="r">Rate</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
      '<h3 class="small" style="margin:12px 0 6px">By final outcome</h3><div class="tablewrap" tabindex="0"><table class="plain"><thead><tr><th>Final outcome</th><th class="r">Reviewed</th><th class="r">Overridden</th></tr></thead><tbody>' + outHtml + '</tbody></table></div>' : '<p class="muted small">No decision in this log was reviewed by a person.</p>') + '</section>';
  }
  function reportHtml() {
    return '<div class="stack">' + (state.file.demo ? demoStrip() : '') + staleHtml() +
      '<div class="split2"><div class="stack">' + verdictHtml() + hintHtml() + findingsHtml() + '</div><aside class="side stack" aria-label="The log at a glance">' + volumeHtml() + versionsHtml() + overridesHtml() + '</aside></div></div>';
  }

  /* ---------------- the replay pack ---------------- */

  function pickerHtml() {
    var F = state.report.findings.filter(function (f) { return f.refs.length && f.key !== 'unreadable'; });
    var resultsHtml;
    if (state.found) {
      resultsHtml = state.found.length ? '<ul class="results">' + state.found.map(function (r) { return pickHtml(r); }).join('') + '</ul>' : '<p class="small muted">Nothing matches. Search by decision id, case id or line number.</p>';
    } else {
      resultsHtml = F.length ? F.slice(0, 6).map(function (f) { return '<p class="lab" style="margin:10px 0 6px">' + esc(C.SEV_MARK[f.sev] + ' ' + f.title) + '</p><ul class="results">' + f.refs.slice(0, 3).map(function (r) { return pickHtml(r); }).join('') + '</ul>'; }).join('') : '<p class="small muted">No finding names a record - search for any decision.</p>';
    }
    return '<section class="card picker no-print"><h2>Pick a decision</h2><label class="field"><span>Find by decision id, case id or line</span><input class="input" id="findQ" type="search" autocomplete="off" spellcheck="false" placeholder="RVT-D-0212" value="' + esc(state.findQ) + '"></label>' + resultsHtml + '</section>';
  }
  function pickHtml(r) {
    return '<li><button type="button" data-act="pack" data-i="' + esc(String(r.i)) + '"' + (state.packI === r.i ? ' aria-current="true"' : '') + '><span class="rid">' + esc(C.visible(r.id || where(r), 40)) + '</span><span class="small">' + esc(C.OUTCOME_WORD[r.outcome] || C.visible(r.outcome || '', 16)) + '</span><span class="rm">' + esc([where(r), r.time ? timeShort(r.time) : '', caseText(r.case)].filter(Boolean).join(' · ')) + '</span></button></li>';
  }
  function kv(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + esc(v === null || v === undefined || v === '' ? '-' : String(v)) + '</dd>'; }
  function packHtml() {
    var p = state.pack;
    if (!p) return '<section class="card"><h2>Replay pack</h2><p class="muted">Pick a decision - or open one from any finding - and Replay lays out everything needed to answer for it on one page: what went in, which model and prompt, the reasons in words, who reviewed it, and the hash proof.</p></section>';
    var o = state.packOpts;
    var c = p.chain;
    var proofP = !c ? '<span class="cpill low-p">- Not hashed</span>' : c.status === 'ok' && c.scheme ? '<span class="cpill ok-p">✓ Hash verified</span>' : c.status === 'changed' && c.scheme ? '<span class="cpill critical-p">✗ Changed after it was written</span>' : '<span class="cpill low-p">- ' + esc(C.chainWords(c)) + '</span>';
    var caseShown = o.mask ? C.mask(p.case) : p.case;
    var reasonsHtml = p.reasons.length ? '<ul class="reasons">' + p.reasons.map(function (x) { return '<li><code>' + esc(x.code) + '</code><span>' + (x.text ? esc(x.text) : '<span style="color:var(--high);font-weight:700">! not on your reason-code list</span>') + '</span></li>'; }).join('') + '</ul>' : p.adverse ? '<p class="small" style="color:var(--critical);font-weight:700">✗ None recorded - for an adverse outcome.</p>' : '<p class="small muted">None recorded.</p>';
    var toolsHtml = p.tools && p.tools.length ? '<ul class="reasons">' + p.tools.slice(0, 20).map(function (t) { return '<li><span>•</span><span>' + esc(C.toolLine(t)) + '</span></li>'; }).join('') + '</ul>' : '<p class="small muted">None recorded.</p>';
    var inputsHtml = p.inputs !== null && p.inputs !== '' ? '<details class="why" open><summary>Inputs snapshot</summary><pre class="out" tabindex="0">' + esc(C.pretty(p.inputs, 20000)) + '</pre></details>' : '<p class="small muted">No inputs snapshot in the record.</p>';
    return '<article class="card pack" id="packCard"><div class="pack-head"><p class="lab">Replay pack</p><p class="pid">' + esc(C.visible(p.id || p.where, 60)) + '</p><p class="pm">' + esc([p.when ? p.when + ' (' + p.zone + ')' : 'no time', p.case ? 'case ' + caseShown : 'no case id', p.where].join(' · ')) + '</p>' +
      '<div class="counts"><span class="cpill ' + (p.adverse ? 'critical-p' : p.outcome === 'approve' ? 'ok-p' : 'info-p') + '">' + esc(p.outcomeWord || 'No outcome') + (p.score !== null && p.score !== '' ? esc(' · score ' + p.score) : '') + '</span>' + (p.replayable ? '<span class="cpill ok-p">✓ Replayable</span>' : '<span class="cpill high-p">! ' + esc(plural(p.missing.length, 'gap')) + ' to replay</span>') + proofP + '</div></div>' +
      '<div class="answer"><p class="lab">The answer, in words</p>' + (c && c.status === 'changed' && c.scheme ? '<p style="color:var(--critical);font-weight:700;margin-bottom:6px">✗ Careful: this record was changed after it was written, so what it says now - including this answer - is unproven.</p>' : '') + '<p>' + esc(p.answer || 'The record has no outcome.') + '</p><p class="small muted" style="margin-top:6px">A starting point for the answer to “why?”, not legal advice.</p></div>' +
      '<div class="missing' + (p.missing.length ? '' : ' none') + '"><h3>' + (p.missing.length ? 'What is missing to replay this' : '✓ Nothing missing to replay this') + '</h3>' + (p.missing.length ? '<ul>' + p.missing.map(function (m) { return '<li>' + esc(m.why) + '</li>'; }).join('') + '</ul>' : '<p class="small muted" style="margin:0">Every field your profile asks for is here, the call was deterministic' + (c ? ' and the hash checks out' : '') + '.</p>') + '</div>' +
      '<div class="pgrid">' +
        '<section class="psec"><h3>Proof</h3><p style="margin:0;font-weight:700">' + esc(C.chainWords(c)) + '</p>' + (c && c.linked ? '<p class="small muted" style="margin:0">' + esc(C.linkWords(c)) + '</p>' : '') + (c ? '<p class="small muted" style="margin:0">In the log</p><p class="hashtxt" style="margin:0">' + esc(c.stored || '(none)') + '</p>' + (c.computed && c.computed !== c.stored ? '<p class="small muted" style="margin:0">Replay computed</p><p class="hashtxt" style="margin:0;color:var(--critical)">' + esc(c.computed) + '</p>' : '') + '<p class="small muted" style="margin:0">Previous hash</p><p class="hashtxt" style="margin:0">' + esc(c.prev || '(none)') + '</p><p class="small muted" style="margin:0">' + esc('SHA-256 · ' + C.RECIPES[c.recipe] + (c.prevInInput ? ', previous hash first' : '')) + '</p>' : '') + '</section>' +
        '<section class="psec"><h3>Model and prompt</h3><dl class="kv">' + kv('Model', p.model) + kv('Model version', p.modelVersion) + kv('Prompt', p.prompt) + kv('Prompt version', p.promptVersion) + kv('Temperature', p.temperature) + kv('Seed', p.seed) + '</dl></section>' +
        '<section class="psec"><h3>Reasons</h3>' + reasonsHtml + (p.rules.length ? '<p class="small muted" style="margin:6px 0 0">' + esc('Policy rules applied: ' + p.rules.join(', ')) + '</p>' : '') + '</section>' +
        '<section class="psec"><h3>People</h3>' + (p.reviewer || p.override !== null ? '<dl class="kv">' + kv('Reviewer', p.reviewer || (p.override === true ? 'not recorded' : '')) + kv('Overridden', p.override === true ? 'Yes' : p.override === false ? 'No' : '') + kv('Why', p.overrideReason) + '</dl>' : '<p class="small muted" style="margin:0">No review recorded - the model’s decision stood.</p>') + '</section>' +
        '<section class="psec" style="grid-column:1/-1"><h3>What went in</h3><p class="small muted" style="margin:0">Inputs hash</p><p class="hashtxt" style="margin:0">' + esc(p.inputsHash || '(not recorded)') + '</p><p class="small muted" style="margin:4px 0 0">Tool calls</p>' + toolsHtml + inputsHtml + '</section>' +
      '</div>' +
      '<div class="note no-print"><label class="check"><input type="checkbox" id="packMask"' + (o.mask ? ' checked' : '') + '> Mask the case id</label><label class="check"><input type="checkbox" id="packInputs"' + (o.inputs ? ' checked' : '') + '> Include the inputs snapshot (customer data)</label>' +
      '<div class="btns"><button class="btn" type="button" data-act="dlpackmd">Download .md</button><button class="btn ghost" type="button" data-act="dlpackjson">Download .json</button><button class="btn ghost" type="button" data-act="copypack">Copy</button><button class="btn ghost" type="button" data-act="print">Print</button></div></div></article>';
  }
  function replayHtml() {
    return '<div class="stack">' + (state.file.demo ? demoStrip() : '') + '<div class="split2 packsplit' + (state.pack ? '' : ' nopack') + '"><div class="stack">' + packHtml() + '</div><aside class="side stack no-print">' + pickerHtml() + '</aside></div></div>';
  }

  /* ---------------- sampling ---------------- */

  function sampleHtml() {
    var s = state.sampleOut, o = state.smp;
    var byHtml = Object.keys(C.STRATA).map(function (k) { return '<label class="check"><input type="checkbox" data-by="' + esc(k) + '"' + (o.by.indexOf(k) >= 0 ? ' checked' : '') + '> ' + esc(C.STRATA[k]) + '</label>'; }).join('');
    var resHtml = '';
    if (s) {
      resHtml = '<section class="card"><div class="sec-head"><h2>' + esc(plural(s.n, 'decision') + ' for review') + '</h2><span class="small muted">' + esc('seed “' + s.seed + '” · from ' + groups(s.population)) + '</span></div>' +
        '<div class="tablewrap" tabindex="0" style="max-height:220px"><table class="plain"><thead><tr><th>Group</th><th class="r">Decisions</th><th class="r">In the sample</th></tr></thead><tbody>' + s.strata.map(function (g) { return '<tr><td>' + esc(g.key) + '</td><td class="r">' + esc(groups(g.population)) + '</td><td class="r">' + esc(String(g.take)) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
        '<div class="tablewrap" tabindex="0" style="margin-top:12px"><table class="recs"><thead><tr><th>Decision</th><th>Time</th><th>Case</th><th>Group</th><th><span class="sr">Replay pack</span></th></tr></thead><tbody>' + s.picks.map(function (r) { return '<tr><td class="id">' + esc(C.visible(r.id || where(r), 40)) + '</td><td>' + esc(timeShort(r.time)) + '</td><td>' + esc(caseText(r.case) || '-') + '</td><td>' + esc(r.stratum) + '</td><td><button class="btn small ghost" type="button" data-act="pack" data-i="' + esc(String(r.i)) + '">Open</button></td></tr>'; }).join('') + '</tbody></table></div>' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="dlsample">Download the ids (CSV)</button><span class="small muted">Case ids are masked in the file.</span></div></section>';
    }
    return '<div class="stack">' + (state.file.demo ? demoStrip() : '') +
      '<section class="card"><h1>A sample to review</h1><p class="muted">A reproducible sample for a second line of defence or an auditor: stratified so every outcome and version is in it, drawn from a seed you can write down. The same log, seed and choices give the same sample on any device.</p>' +
      '<div class="ctl"><label class="field"><span>How many</span><input class="input" id="smpN" type="number" min="1" max="' + esc(String(C.LIMITS.sample)) + '" value="' + esc(String(o.n)) + '" inputmode="numeric"></label><label class="field"><span>Seed</span><input class="input" id="smpSeed" type="text" maxlength="40" value="' + esc(o.seed) + '" autocomplete="off" spellcheck="false"></label><button class="btn ghost" type="button" data-act="newseed">New seed</button></div>' +
      '<div class="field" style="margin-top:10px"><span>Spread it across</span><div class="checks three">' + byHtml + '</div></div></section>' + resHtml + '</div>';
  }

  /* ---------------- exports ---------------- */

  function reportText() { return C.reportMarkdown(state.report, { mask: state.exportMask, stamp: stamp(), name: state.file.name }); }
  function baseName() { return (state.file.name || 'decision-log').replace(/\.[a-z0-9]{1,6}$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'decision-log'; }
  function exportHtml() {
    var p = state.pack;
    return '<div class="stack">' + (state.file.demo ? demoStrip() : '') + '<div class="grid3">' +
      '<section class="card excard"><h2>🧾 The findings report</h2><p class="muted">Markdown: every finding with its records, the version history, overrides by reviewer, and how it was checked.</p><label class="check"><input type="checkbox" id="exMask"' + (state.exportMask ? ' checked' : '') + '> Mask case ids</label><div class="btns"><button class="btn" type="button" data-act="dlreport">Download .md</button><button class="btn ghost" type="button" data-act="copyreport">Copy</button></div></section>' +
      '<section class="card excard"><h2>🚩 Flagged records</h2><p class="muted">A CSV of every record behind every finding - for engineering to fix, or for the review file. Formula-safe; case ids masked as above.</p><div class="btns"><button class="btn" type="button" data-act="dlflagged">Download CSV</button></div></section>' +
      '<section class="card excard"><h2>📼 Replay pack</h2><p class="muted">' + (p ? esc('For ' + (p.id || p.where) + '. ') : 'Open a decision on the Replay tab first. ') + 'Markdown or JSON, with the case id masked unless you untick it there.</p><div class="btns">' + (p ? '<button class="btn" type="button" data-act="dlpackmd">Download .md</button><button class="btn ghost" type="button" data-act="dlpackjson">.json</button>' : '<button class="btn ghost" type="button" data-act="tab" data-tab="replay">Pick a decision</button>') + '</div></section>' +
      '</div>' +
      '<section class="card excard"><h2>🎲 The review sample</h2><p class="muted">' + (state.sampleOut ? esc(plural(state.sampleOut.n, 'decision') + ', seed “' + state.sampleOut.seed + '”.') : 'Draw one on the Sample tab.') + '</p><div class="btns">' + (state.sampleOut ? '<button class="btn" type="button" data-act="dlsample">Download CSV</button>' : '<button class="btn ghost" type="button" data-act="tab" data-tab="sample">Draw a sample</button>') + '</div></section>' +
      '<section class="card"><div class="sec-head"><h2>The report</h2><span class="small muted">Made on this device</span></div><pre class="out wrapit" tabindex="0">' + esc(reportText()) + '</pre></section></div>';
  }

  /* ---------------- settings ---------------- */

  function keepHtml() {
    return '<label class="check"><input type="checkbox" id="keepBox"' + (state.keep ? ' checked' : '') + '> Keep my settings on this device</label><p class="small muted" style="margin:0">Off by default. When on, these settings stay in this browser until you clear them. A log, a record, a case id or a change log is never kept - not even with this on.</p>' + (state.keep ? '<button class="btn small danger" type="button" data-act="clearkept" style="margin-top:8px">Clear it from this device</button>' : '');
  }
  function settingsHtml() {
    var s = state.settings;
    var req = C.REQUIRABLE.map(function (f) { return '<label class="check"><input type="checkbox" data-req="' + esc(f) + '"' + (s.required.indexOf(f) >= 0 ? ' checked' : '') + '> ' + esc(C.REQ_LABEL[f]) + '</label>'; }).join('');
    var when = [['reasonsIfAdverse', 'Reasons on every adverse outcome'], ['reviewerIfOverride', 'A reviewer on every override'], ['whyIfOverride', 'A reason on every override']].map(function (w) { return '<label class="check"><input type="checkbox" data-when="' + esc(w[0]) + '"' + (s.when[w[0]] ? ' checked' : '') + '> ' + esc(w[1]) + '</label>'; }).join('');
    var adv = C.OUTCOMES.map(function (o) { return '<label class="check"><input type="checkbox" data-adv="' + esc(o) + '"' + (s.adverse.indexOf(o) >= 0 ? ' checked' : '') + '> ' + esc(C.OUTCOME_WORD[o]) + '</label>'; }).join('');
    var maxOpts = []; for (var i = 1; i <= C.LIMITS.maxReasons; i++) maxOpts.push('<option value="' + i + '"' + (s.maxReasons === i ? ' selected' : '') + '>' + i + '</option>');
    var words = s.words.map(function (w) { return w.word + ' = ' + w.outcome; }).join('\n');
    var presetsHtml = s.presets.length ? '<ul class="srclist">' + s.presets.map(function (p, k) { return '<li><span><b>' + esc(p.name) + '</b> <span class="small muted">' + esc(plural(Object.keys(p.map).length, 'field')) + '</span></span><button class="btn small ghost" type="button" data-rmpreset="' + k + '">Forget</button></li>'; }).join('') + '</ul>' : '<p class="small muted" style="margin:0">None yet. On the Fields tab, “Save as a preset” keeps the key names you chose, and a log with the same keys picks them up next time.</p>';
    var demoNote = state.file && state.file.demo ? '<p class="small" style="color:var(--info);font-weight:700;margin:0">' + esc('The demo always checks against its own list of ' + D.CODES.length + ' codes. This box is yours, for your own logs.') + '</p>' : '';
    return '<div class="stack"><section class="card"><h1>Settings</h1><p class="muted">What Replay checks your log against. Changes re-run the checks at once. Signed in, they follow your account - preferences only, never a decision.</p><div data-sync>' + syncLine() + '</div></section>' +
      '<div class="setgrid">' +
      '<section class="card form"><h2>Must record</h2><p class="small muted" style="margin:0">Every decision must carry these, or it cannot be replayed.</p><div class="checks">' + req + '</div><h3 class="small" style="margin:6px 0 0">And when it applies</h3><div class="checks">' + when + '</div></section>' +
      '<section class="card form"><h2>Adverse outcomes</h2><p class="small muted" style="margin:0">Outcomes that need reasons a person can be told.</p><div class="checks">' + adv + '</div><label class="field"><span>The most reasons to give</span><select class="input" id="setMax">' + maxOpts.join('') + '</select><small>More than this on an adverse outcome is flagged. Check your own policy.</small></label>' +
      '<h3 class="small" style="margin:6px 0 0">Determinism</h3><label class="check"><input type="checkbox" id="detTemp"' + (s.determinism.temperatureZero ? ' checked' : '') + '> Decision calls run at temperature 0</label><label class="check"><input type="checkbox" id="detSeed"' + (s.determinism.seed ? ' checked' : '') + '> Every call records a seed</label></section>' +
      '<section class="card form"><h2>Reason codes</h2>' + demoNote + '<label class="field"><span>One a line: code, then the plain words a customer would read</span><textarea class="input mono" id="setCodes" rows="8" spellcheck="false" placeholder="R02, Cash flow does not cover the requested payment">' + esc(C.codesText(s.codes)) + '</textarea><small id="codesCount">' + esc(plural(s.codes.length, 'code') + ' · codes are letters and digits (R02, AA-17); the words must not hold an id, an address, a hash or a date.') + '</small></label><div id="codesErr"></div><div class="btns"><button class="btn small ghost" type="button" data-act="democodes">Use the demo’s list</button></div></section>' +
      '<section class="card form"><h2>Outcome words</h2><label class="field"><span>Words your log uses, one a line: word = approve, decline, refer or flag</span><textarea class="input mono" id="setWords" rows="4" spellcheck="false" placeholder="aprv = approve">' + esc(words) + '</textarea><small>Replay already knows the usual ones - approved, denied, manual review, fraud hold…</small></label><div id="wordsErr"></div></section>' +
      '<section class="card form"><h2>The hash recipe</h2><label class="radio"><input type="radio" name="canon" value="canonical"' + (s.canon === 'canonical' ? ' checked' : '') + '><span><b>Canonical JSON</b><small>The record without its hash, keys sorted at every level, no spaces. Survives re-serialising.</small></span></label><label class="radio"><input type="radio" name="canon" value="raw"' + (s.canon === 'raw' ? ' checked' : '') + '><span><b>The raw line</b><small>The line exactly as written, with the hash member (or CSV cell) removed. For writers that hash the text they write.</small></span></label><label class="check"><input type="checkbox" id="prevIn"' + (s.prevInInput ? ' checked' : '') + '> The previous hash and a line feed come first</label>' + snippetHtml(false) + '</section>' +
      '<section class="card form"><h2>Field presets</h2>' + presetsHtml + '<hr style="border:0;border-top:1px solid var(--line);width:100%">' + keepHtml() + '</section>' +
      '</div>' + (state.file ? '<div class="btns"><button class="btn" type="button" data-act="tab" data-tab="' + (state.report ? 'report' : 'fields') + '">← Back to ' + (state.report ? 'the report' : 'the fields') + '</button></div>' : '') + '</div>';
  }

  /* ---------------- the AI field helper ---------------- */

  function openAi() {
    if (!state.file) return;
    var keys = state.file.keys;
    var payload = C.keysPayload(keys);
    var renamed = payload.keys.filter(function (k, i) { return k.path !== keys[i].path; }).length;
    sheet('<h2>✨ Help me map these fields</h2><p class="muted small">For when the guess is unsure. Only each key’s <b>name</b> and a few words about <b>what its values look like</b> are sent - worked out on this device, from a fixed list. Never a value: no case id, no input, no score, no hash, no reviewer.</p>' +
      '<div class="tablewrap" tabindex="0" style="max-height:280px"><table class="sent"><thead><tr><th>#</th><th>Key, as sent</th><th>What the values look like</th></tr></thead><tbody>' +
      payload.keys.map(function (k, i) { return '<tr><td>' + esc(String(i + 1)) + '</td><td><code>' + esc(k.path) + '</code></td><td>' + esc(k.shape.map(function (c) { return C.SHAPES[c]; }).join('; ') || '-') + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      (keys.length > payload.keys.length ? '<p class="small" style="margin:8px 0 0">' + esc('The first ' + payload.keys.length + ' of ' + keys.length + ' keys are sent.') + '</p>' : '') +
      (renamed ? '<p class="small" style="margin:8px 0 0">' + esc(plural(renamed, 'key name') + ' looked like a value (an @, a long number, a hash or a date) and ' + (renamed === 1 ? 'is' : 'are') + ' sent as “key N”.') + '</p>' : '') +
      '<details class="why"><summary>Exactly what will be sent</summary><pre class="sent-pre" tabindex="0">' + esc(JSON.stringify(payload, null, 1)) + '</pre></details>' +
      '<div id="aiErr"></div><div class="btns" id="aiActs" style="margin-top:10px"></div>', function (root) {
      var acts = $('#aiActs', root);
      if (!signedIn()) {
        acts.innerHTML = '<p class="small muted" style="width:100%;margin:0">It uses about a cent of AI credit, so it needs a free account - which comes with $2 and works across every app on this site. Choosing the fields by hand is free.</p><button class="btn" type="button" id="aiSignin">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button>';
        $('#aiSignin', root).addEventListener('click', function () { openAccount('The field helper uses about a cent of AI credit; a free account comes with $2.', openAi); });
        return;
      }
      acts.innerHTML = '<button class="btn" type="button" id="aiSend">Send the key names and shapes</button><span class="small muted">About a cent' + (state.me.tier === 'paid' ? ' (member model)' : '') + '. You still check the answer.</span>';
      $('#aiSend', root).addEventListener('click', function () {
        var b = $('#aiSend', root);
        b.disabled = true; b.textContent = 'Asking…';
        $('#aiErr', root).innerHTML = '';
        api('POST', 'api/ai/fields', payload).then(function (res) {
          var m = res.fields.map, conf = res.fields.confidence || {}, n = 0, placed = {};
          C.FIELDS.forEach(function (f) { var i = m[f]; if (i >= 0 && i < keys.length) placed[f] = keys[i].path; });
          // a key the AI placed is taken away from any other field first - one key, one field
          var taken = Object.keys(placed).map(function (f) { return placed[f]; });
          C.FIELDS.forEach(function (f) { if (!placed[f] && state.map[f] && taken.indexOf(state.map[f]) >= 0) { state.map[f] = null; delete state.conf[f]; } });
          Object.keys(placed).forEach(function (f) { state.map[f] = placed[f]; state.conf[f] = 'ai-' + (conf[f] || 'low'); n++; });
          closeSheet();
          toast('The AI placed ' + plural(n, 'field') + ' - check them.', 4200);
          go('fields');
          loadMe();
        }).catch(function (err) { b.disabled = false; b.textContent = 'Send the key names and shapes'; meteredError(err, $('#aiErr', root), openAi, 'The field helper uses about a cent of AI credit, so it needs a free account (it comes with $2).'); });
      });
    });
  }
  function openPreset() {
    if (!state.file) return;
    var map = {}, skipped = 0;
    C.FIELDS.forEach(function (f) { var p = state.map[f]; if (!p) return; if (C.pathOk(p)) map[f] = p; else skipped++; });
    sheet('<h2>Save these fields as a preset</h2><p class="muted small">Keeps the key NAMES you chose - never a value - so the next log with the same keys is mapped at once. ' + (signedIn() ? 'It follows your account.' : 'Sign in and it follows your account too.') + '</p>' +
      '<label class="field"><span>Name</span><input class="input" id="presetName" maxlength="' + esc(String(C.LIMITS.presetName)) + '" placeholder="Underwriting log" autocomplete="off"></label>' +
      (skipped ? '<p class="small">' + esc(plural(skipped, 'key name') + ' looked like a value and will not be saved.') + '</p>' : '') +
      '<div id="presetErr"></div><div class="btns" style="margin-top:10px"><button class="btn" type="button" id="presetSave">Save the preset</button></div>', function (root) {
      $('#presetSave', root).addEventListener('click', function () {
        var name = C.line($('#presetName', root).value, C.LIMITS.presetName);
        var chk = C.cleanSettings({ presets: [{ name: name, map: map }] }, true);
        if (chk.errors.length) { $('#presetErr', root).innerHTML = '<p class="err">' + esc(chk.errors[0]) + '</p>'; return; }
        var s = state.settings;
        s.presets = s.presets.filter(function (p) { return C.fold(p.name) !== C.fold(name); });
        s.presets.push(chk.settings.presets[0]);
        if (s.presets.length > C.LIMITS.presets) s.presets.shift();
        state.file.preset = name;
        settingsChanged();
        closeSheet();
        toast('Saved “' + name + '”.');
        if (state.view === 'fields') keepPlace(draw);
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
    // The shared "confirm your email" banner sits above everything at the top
    // of the page; keep the sheet (and its Close button) clear of it.
    var vb = document.getElementById('stc-verify-banner'), off = vb ? Math.max(0, vb.getBoundingClientRect().bottom) : 0;
    s.style.maxHeight = off ? 'calc(100vh - ' + Math.round((matchMedia('(min-width: 720px)').matches ? 2 : 1) * (off + 8)) + 'px)' : '';
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2'); if (f) f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f && !s.contains(document.activeElement)) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    state.conflictOpen = false;
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }

  var FREE_LINE = 'Checking logs is free with no account, and never leaves this device. A free account keeps your settings across devices and adds the AI field helper - it comes with $2 of AI credit, and one account works across every app on this site.';
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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); return syncIn(); }).then(function () { if (then) then(); else draw(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { return syncIn(); }).then(function () { if (then) then(); else draw(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openAccountSheet() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">The field helper costs about a cent. Checking, hashing, packs, samples and exports are free and never leave this device.</p><div id="billing"></div></div>' +
      '<p class="small" style="margin-top:14px" data-sync>' + syncLine() + '</p>' +
      '<button class="btn ghost block" id="forget" type="button" style="margin-top:6px">Remove my settings from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); draw(); }); });
        $('#forget', root).addEventListener('click', function () {
          if (!confirm('Remove your settings from the account? This device keeps its copy.')) return;
          api('DELETE', 'api/settings').then(function () { state.syncBase = null; closeSheet(); toast('Removed from the account. This device still has them.'); state.syncState = 'local'; }).catch(function (e) { showError(e); });
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
  function checkout(path, body) { body.returnTo = BASE; api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); }); }
  function openCredit(data) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Checking logs, choosing fields by hand, packs, samples and every export keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- wiring ---------------- */

  var findTimer = null;
  function wire() {
    $$('input[data-file]').forEach(function (inp) {
      inp.addEventListener('change', function (e) { var f = (e.target.files || [])[0]; e.target.value = ''; if (f) loadFile(f); });
    });
    $$('[data-drop]').forEach(function (z) {
      z.addEventListener('dragover', function (e) { e.preventDefault(); z.classList.add('over'); });
      z.addEventListener('dragleave', function () { z.classList.remove('over'); });
    });
    $$('select[data-field]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var f = sel.getAttribute('data-field'), v = sel.value || null;
        if (v) C.FIELDS.forEach(function (g) { if (g !== f && state.map[g] === v) { state.map[g] = null; delete state.conf[g]; } });
        state.map[f] = v;
        if (v) state.conf[f] = 'you'; else delete state.conf[f];
        keepPlace(draw);
      });
    });
    var fq = $('#findQ');
    if (fq) fq.addEventListener('input', function () {
      state.findQ = fq.value;
      clearTimeout(findTimer);
      findTimer = setTimeout(function () {
        if (!C.line(state.findQ, 80)) { state.found = null; keepPlace(draw); refocus('#findQ'); return; }
        engine.run('find', { id: state.file.id, q: state.findQ }).then(function (list) { state.found = list; keepPlace(draw); refocus('#findQ'); });
      }, 220);
    });
    var pm = $('#packMask'), pi = $('#packInputs'), em = $('#exMask');
    if (pm) pm.addEventListener('change', function () { state.packOpts.mask = pm.checked; keepPlace(draw); });
    if (pi) pi.addEventListener('change', function () { state.packOpts.inputs = pi.checked; });
    if (em) em.addEventListener('change', function () { state.exportMask = em.checked; keepPlace(draw); });
    var dsel = $('#daySel');
    if (dsel) dsel.addEventListener('change', function () { state.day = dsel.value || null; keepPlace(draw); });
    var cl = $('#changeLog');
    if (cl) cl.addEventListener('change', function () { state.changeLog = cl.value.slice(0, 20000); });
    var sn = $('#smpN'), ss = $('#smpSeed');
    if (sn) sn.addEventListener('change', function () { var n = Math.max(1, Math.min(C.LIMITS.sample, Math.floor(Number(sn.value) || 25))); state.smp.n = n; drawSample(); });
    if (ss) ss.addEventListener('change', function () { state.smp.seed = C.line(ss.value, 40) || newSeed(); drawSample(); });
    $$('[data-by]').forEach(function (b) {
      b.addEventListener('change', function () {
        var k = b.getAttribute('data-by');
        state.smp.by = Object.keys(C.STRATA).filter(function (x) { return x === k ? b.checked : state.smp.by.indexOf(x) >= 0; });
        drawSample();
      });
    });
    wireSettings();
  }
  function refocus(sel) { var el = $(sel); if (el) { try { el.focus({ preventScroll: true }); var n = el.value.length; el.setSelectionRange(n, n); } catch (e) { /* ignore */ } } }
  function wireSettings() {
    var s = state.settings;
    $$('[data-req]').forEach(function (b) { b.addEventListener('change', function () { var f = b.getAttribute('data-req'); s.required = C.REQUIRABLE.filter(function (x) { return x === f ? b.checked : s.required.indexOf(x) >= 0; }); settingsChanged(); }); });
    $$('[data-when]').forEach(function (b) { b.addEventListener('change', function () { s.when[b.getAttribute('data-when')] = b.checked; settingsChanged(); }); });
    $$('[data-adv]').forEach(function (b) { b.addEventListener('change', function () { var o = b.getAttribute('data-adv'); s.adverse = C.OUTCOMES.filter(function (x) { return x === o ? b.checked : s.adverse.indexOf(x) >= 0; }); settingsChanged(); }); });
    var mx = $('#setMax'); if (mx) mx.addEventListener('change', function () { s.maxReasons = Math.max(1, Math.min(C.LIMITS.maxReasons, Number(mx.value) || 4)); settingsChanged(); });
    var dt = $('#detTemp'); if (dt) dt.addEventListener('change', function () { s.determinism.temperatureZero = dt.checked; settingsChanged(); });
    var ds = $('#detSeed'); if (ds) ds.addEventListener('change', function () { s.determinism.seed = ds.checked; settingsChanged(); });
    var pv = $('#prevIn'); if (pv) pv.addEventListener('change', function () { s.prevInInput = pv.checked; settingsChanged(); });
    $$('input[name=canon]').forEach(function (r) { r.addEventListener('change', function () { if (r.checked && C.RECIPES[r.value]) { s.canon = r.value; settingsChanged(); } }); });
    var cd = $('#setCodes');
    if (cd) cd.addEventListener('change', function () {
      var out = C.parseCodes(cd.value);
      $('#codesErr').innerHTML = out.errors.length ? '<p class="small err">' + esc(out.errors.slice(0, 3).join(' ')) + '</p>' : '';
      if (out.errors.length) return;
      s.codes = out.codes; settingsChanged(); toast(plural(out.codes.length, 'reason code') + ' saved.');
      var cc = $('#codesCount'); if (cc) cc.textContent = plural(s.codes.length, 'code') + ' · codes are letters and digits (R02, AA-17); the words must not hold an id, an address, a hash or a date.';
    });
    var wd = $('#setWords');
    if (wd) wd.addEventListener('change', function () {
      var list = [], errs = [];
      wd.value.split(/\r?\n/).forEach(function (l, k) {
        if (!l.trim()) return;
        var m = /^(.+?)\s*(?:=|,|:|→|->)\s*(approve|decline|refer|flag)\s*$/i.exec(l.trim());
        if (!m) { errs.push('Line ' + (k + 1) + ': write it as word = approve, decline, refer or flag.'); return; }
        list.push({ word: m[1], outcome: m[2].toLowerCase() });
      });
      var chk = C.cleanSettings({ words: list }, true);
      if (!errs.length && chk.errors.length) errs.push(chk.errors[0]);
      $('#wordsErr').innerHTML = errs.length ? '<p class="small err">' + esc(errs.slice(0, 3).join(' ')) + '</p>' : '';
      if (errs.length) return;
      s.words = chk.settings.words; settingsChanged();
    });
    $$('[data-rmpreset]').forEach(function (b) { b.addEventListener('click', function () { s.presets.splice(+b.getAttribute('data-rmpreset'), 1); settingsChanged(); keepPlace(draw); }); });
    var kb = $('#keepBox');
    if (kb) kb.addEventListener('change', function () {
      state.keep = kb.checked;
      if (kb.checked) { saveNow(); toast('Kept on this device. Clear it any time.'); } else { forget(); toast('Nothing is kept on this device now.'); }
      keepPlace(draw);
    });
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); go('start'); break;
      case 'tab': { var tab = t.getAttribute('data-tab'); if (tab === 'settings' || state.file) go(tab); break; }
      case 'demo': closeSheet(true); loadDemo(); break;
      case 'signin': openAccount(); break;
      case 'retrysync': pushSettings(); break;
      case 'ai': openAi(); break;
      case 'preset': openPreset(); break;
      case 'run': state.open = {}; runChecks(false).then(function () { if (state.report) go('report'); }); break;
      case 'hintoff': state.device.hint = true; saveSoon(); keepPlace(draw); break;
      case 'ftoggle': { var k = t.getAttribute('data-k'); state.open[k] = !state.open[k]; keepPlace(draw); var b = $('#f-' + k + ' .fhead'); if (b) try { b.focus({ preventScroll: true }); } catch (err) { /* ignore */ } break; }
      case 'showall': state.all[t.getAttribute('data-k')] = true; keepPlace(draw); break;
      case 'showcase': state.showCase = !state.showCase; keepPlace(draw); break;
      case 'goto': { var el = $('#' + t.getAttribute('data-to')); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); break; }
      case 'checklog': { var cl = $('#changeLog'); if (cl) state.changeLog = cl.value.slice(0, 20000); runChecks(true); break; }
      case 'pack': { var i = Number(t.getAttribute('data-i')); if (i >= 0) openPack(i); break; }
      case 'newseed': state.smp.seed = newSeed(); drawSample(); break;
      case 'dlpackmd': if (state.pack) { download(baseName() + '-' + (state.pack.id || 'record').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) + '-replay.md', 'text/markdown', C.packMarkdown(state.pack, state.packOpts)); toast('Saved - made on this device.'); } break;
      case 'dlpackjson': if (state.pack) { download(baseName() + '-' + (state.pack.id || 'record').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) + '-replay.json', 'application/json', C.packJson(state.pack, state.packOpts)); toast('Saved - made on this device.'); } break;
      case 'copypack': if (state.pack) copy(C.packMarkdown(state.pack, state.packOpts), 'Copied the replay pack.'); break;
      case 'print': window.print(); break;
      case 'dlreport': download(baseName() + '-replay-findings.md', 'text/markdown', reportText()); toast('Saved - made on this device.'); break;
      case 'copyreport': copy(reportText(), 'Copied the report.'); break;
      case 'dlflagged': engine.run('flagged', { id: state.file.id, mask: state.exportMask }).then(function (csv) { download(baseName() + '-flagged.csv', 'text/csv', csv); toast('Saved - made on this device.'); }).catch(function (err) { toast(err.message, 4200); }); break;
      case 'dlsample': if (state.sampleOut) { download(baseName() + '-sample-' + state.sampleOut.seed.replace(/[^A-Za-z0-9-]+/g, '') + '.csv', 'text/csv', C.sampleCsv(state.sampleOut, { mask: true })); toast('Saved - made on this device.'); } break;
      case 'democodes': state.settings.codes = D.CODES.map(function (c) { return { code: c.code, text: c.text }; }); settingsChanged(); keepPlace(draw); toast('The demo’s reason codes are in your list now.'); break;
      case 'clearkept': forget(); state.keep = false; toast('Cleared from this device.'); keepPlace(draw); break;
      default: break;
    }
  });
  document.addEventListener('mouseover', function (e) {
    var t = e.target.closest && e.target.closest('.vol [data-read]');
    if (!t) return;
    var ro = $('#dayReadout');
    if (ro) ro.textContent = t.getAttribute('data-read');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) { closeSheet(); }
  });
  window.addEventListener('popstate', route);

  // Drop a file anywhere on the page.
  var dragDepth = 0;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
  document.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; dragDepth++; $('#dropcover').hidden = false; });
  document.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropcover').hidden = true; });
  document.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('#dropcover').hidden = true;
    $$('[data-drop]').forEach(function (z) { z.classList.remove('over'); });
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  /* ---------------- start ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill) pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  drawTop();

  // Settings come back only if this device was asked to keep them.
  var kept = recall();
  if (kept && kept.v === 1 && kept.keep === true) {
    state.keep = true;
    state.settings = C.cleanSettings(kept.settings).settings;
    state.syncBase = typeof kept.syncBase === 'number' ? kept.syncBase : null;
    state.device = { hint: Boolean(kept.device && kept.device.hint === true) };
  }
  route();
  loadMe().then(function () {
    if (signedIn()) syncIn();
  });
}());
