/* Muster - the page. One file, no build step.
 *
 * NO SSN, DATE OF BIRTH OR NAME EVER LEAVES THIS DEVICE, AND NONE IS EVER
 * SAVED. A portfolio export is read in a worker (muster-worker.js) - or here
 * when there is none - by MusterCore, and the borrowers stay in that
 * worker's memory until the page closes. The request file is built there and
 * saved as a file this browser writes. What Muster keeps on this device goes
 * through muster-store.js and MusterCore's guards: settings, the batch
 * record (customer record id -> loan id and what a decision needs), the
 * results' statuses and dates, and the audit log - never a borrower.
 *
 * The requests this page makes: sign-in, the account's settings (layouts and
 * preferences, never a borrower), and the one optional AI letter, whose
 * payload - a decision code, a loan type, dates and amounts - is shown in
 * full before it is sent.
 *
 * Every string a file held, a person typed, the server sent or a model wrote
 * is escaped before it is drawn, and no handler is written into markup:
 * clicks and changes are routed by data-act and data-* attributes from one
 * listener each (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.MusterCore;
  var D = window.MusterDemo;
  var MS = window.MusterStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural, groups = C.groups, money = C.money, nice = C.niceDay;

  // A tag the browser reports but Intl refuses ("en-US@posix" in some
  // headless browsers) would make every date throw: fall back.
  var LOCALE = (function () { try { return Intl.getCanonicalLocales(navigator.language || 'en-US')[0] || 'en-US'; } catch (e) { return 'en-US'; } }());
  function pad2(n) { return ('0' + n).slice(-2); }
  /** Today, in this device's own day. */
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function nowIso() { return new Date().toISOString(); }
  function stamp(iso) {
    var d = iso ? new Date(iso) : new Date();
    try { return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(d); } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  var IDCHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function newBatchId() {
    var a = new Uint32Array(5);
    try { crypto.getRandomValues(a); } catch (e) { for (var i = 0; i < 5; i++) a[i] = (Date.now() >> (i * 3)) + i * 7; }
    return Array.prototype.map.call(a, function (x) { return IDCHARS.charAt(x % IDCHARS.length); }).join('');
  }

  var real = MS.create(MS.idb('muster'));
  var demoStore = MS.create(MS.memory());

  var state = {
    me: null, view: 'start',
    settings: C.defaults(), syncBase: null, syncState: 'local', syncErr: '', conflictOpen: false,
    device: { initials: '', hint: false, results: false },
    batches: [], demo: false,
    pf: null, chk: null, built: null, pendingId: '', statusDate: '', showSsn: false, showMap: false, recheck: null,
    batch: null, results: null, audit: [], chain: null, match: null, decisions: null, work: null,
    res: null, filter: 'todo', open: {}, showNone: false, exportMask: true,
    letter: { crid: '', tone: 'warm', text: '', edited: false, person: null, source: 'template' },
    busy: '', seq: 0,
  };
  function db() { return state.demo ? demoStore : real; }

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
    if (where) { where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>'; reveal(where); }
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else here stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    reveal(where);
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  /** An error inside a tall sheet scrolls into view - on a phone it would land below the fold. */
  function reveal(el) { try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* old browsers */ } }
  function meteredError(err, box, retry, why) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount(why, retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }

  /* ---------------- the reader: a worker, or this page ---------------- */

  var enc = new TextEncoder();
  function digest(text) {
    if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('This page cannot hash here - open it at its https address.'));
    return crypto.subtle.digest('SHA-256', enc.encode(text)).then(C.hex);
  }
  var engine = (function () {
    var w = null, seq = 0, waits = {}, local = null;
    try {
      if (window.Worker) {
        w = new Worker('muster-worker.js');
        w.addEventListener('message', function (e) {
          var m = e.data || {};
          var p = waits[m.id];
          if (!p) return;
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
    var BIG = 'That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Export fewer loans at a time - 250,000 is the most one file can hold.';
    function here(op, data) {
      if (!local) local = C.createEngine({ digest: digest });
      if ((op === 'loadPortfolio' || op === 'loadResults') && data.file) {
        if (data.file.size > C.LIMITS.fileBytes) return Promise.reject(new Error(BIG));
        return data.file.text().then(function (text) { return local[op]({ text: text, name: data.name || data.file.name, mode: data.mode }); });
      }
      if (op === 'loadPortfolio' && data.demo) return Promise.resolve(local.loadPortfolio({ text: D.portfolio(data.today), name: D.FILE, demo: true }));
      return new Promise(function (resolve, reject) { setTimeout(function () { try { resolve(local[op](data)); } catch (err) { reject(err); } }, 0); });
    }
    return {
      run: function (op, data) {
        if (!w) return here(op, data || {});
        return new Promise(function (resolve, reject) {
          var id = ++seq;
          waits[id] = { resolve: resolve, reject: reject };
          w.postMessage({ id: id, op: op, data: data || {} });
        });
      },
    };
  }());

  /* ---------------- settings: on this device, and in the account ---------------- */

  var pushTimer = null;
  function settingsChanged() {
    state.settings.updatedAt = Date.now();
    real.putSettings(state.settings).catch(function () { /* still in this tab */ });
    pushSoon();
  }
  function deviceChanged() { real.putDevice(state.device).catch(function () { /* still in this tab */ }); }
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
      state.syncBase = out.settings.updatedAt; state.syncState = 'synced'; state.syncErr = ''; saveSyncBase(); drawSync();
    }).catch(function (err) {
      if (err.status === 409 && err.data && err.data.settings) return openConflict(err.data.settings);
      state.syncState = 'error'; state.syncErr = err.message; drawSync();
    });
  }
  function saveSyncBase() { var s = C.cleanSettings(state.settings).settings; s.updatedAt = state.settings.updatedAt; real.putSettings(s).catch(function () { /* fine */ }); real.putSyncBase(state.syncBase).catch(function () { /* fine */ }); }
  function pristine(s) { var a = C.cleanSettings(s).settings, b = C.defaults(); delete a.updatedAt; delete b.updatedAt; return JSON.stringify(a) === JSON.stringify(b); }
  function same(a, b) { var x = C.cleanSettings(a).settings, y = C.cleanSettings(b).settings; delete x.updatedAt; delete y.updatedAt; return JSON.stringify(x) === JSON.stringify(y); }
  function syncIn() {
    if (!signedIn() || !state.me.sync) return Promise.resolve();
    return api('GET', 'api/settings').then(function (out) {
      var acc = out.settings;
      if (!acc) { state.syncBase = null; if (!pristine(state.settings)) return pushSettings(null); state.syncState = 'synced'; drawSync(); return null; }
      if (pristine(state.settings)) { adopt(acc); state.syncBase = acc.updatedAt; state.syncState = 'synced'; saveSyncBase(); drawSync(); return null; }
      if (state.syncBase === acc.updatedAt) return pushSettings();
      if (same(acc, state.settings)) { state.syncBase = acc.updatedAt; state.syncState = 'synced'; saveSyncBase(); drawSync(); return null; }
      return openConflict(acc);
    }).catch(function () { state.syncState = 'error'; drawSync(); });
  }
  function adopt(s) {
    state.settings = C.cleanSettings(s).settings;
    real.putSettings(state.settings).catch(function () { /* fine */ });
    recompute();
    if (state.view !== 'start') keepPlace(draw);
  }
  function openConflict(acc) {
    if (state.conflictOpen) return;
    state.conflictOpen = true;
    var mine = state.settings, a = C.cleanSettings(acc).settings;
    var desc = function (s) { return esc((C.isDefaultLayout(s.layout) ? 'default request layout' : 'an edited request layout') + ', ' + plural(s.presets.length, 'column preset') + ', ' + (s.policy === 'notice' ? 'wait for notice' : 'apply on a match') + ', ' + (s.cridMode === 'short' ? 'short codes' : 'loan ids as record ids')); };
    sheet('<h2>Your settings changed on another device</h2><p class="muted">The copy in your account is newer than the one this device last saw.</p><div class="note"><p style="margin:0"><b>This device:</b> ' + desc(mine) + '</p><p style="margin:6px 0 0"><b>Your account:</b> ' + desc(a) + '</p></div>' +
      '<div class="btns" style="margin-top:12px"><button class="btn" type="button" id="cfMerge">Merge them</button><button class="btn ghost" type="button" id="cfTake">Use the account’s copy</button><button class="btn ghost" type="button" id="cfKeep">Keep this device’s</button></div><p class="small muted" style="margin-top:8px">Merging keeps every column preset from both; the newer copy wins everything else.</p>', function (root) {
      var done = function (s, msg) { state.conflictOpen = false; closeSheet(); adopt(s); toast(msg); };
      $('#cfMerge', root).addEventListener('click', function () { var m = C.mergeSettings(a, mine); done(m.settings, 'Merged' + (m.added ? ': ' + plural(m.added, 'preset') + ' added from the other copy.' : '.')); pushSettings(acc.updatedAt); });
      $('#cfTake', root).addEventListener('click', function () { done(a, 'Using the account’s copy.'); state.syncBase = acc.updatedAt; state.syncState = 'synced'; saveSyncBase(); drawSync(); });
      $('#cfKeep', root).addEventListener('click', function () { done(mine, 'Keeping this device’s settings.'); pushSettings(acc.updatedAt); });
    });
  }
  function syncLine() {
    if (!signedIn()) return '<span class="sync muted small">Settings stay on this device · <button class="link-btn" type="button" data-act="signin">sign in to keep them in your account</button> (layouts and preferences - never a borrower)</span>';
    if (state.me && !state.me.sync) return '<span class="sync muted small">Saving to the account is unavailable right now - your settings are on this device.</span>';
    if (state.syncState === 'syncing') return '<span class="sync muted small">Saving your settings to your account…</span>';
    if (state.syncState === 'error') return '<span class="sync small err">Couldn’t save to your account' + (state.syncErr ? ': ' + esc(state.syncErr) : '') + ' <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="sync small" style="color:var(--ok);font-weight:700">✓ Settings saved to your account - never a borrower</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }

  /* ---------------- 1. the portfolio ---------------- */

  function resetBuild() {
    state.pf = null; state.chk = null; state.built = null; state.showMap = false;
    state.pendingId = newBatchId(); state.statusDate = today();
  }
  function begin(label, run, after) {
    var seq = ++state.seq;
    state.busy = label;
    draw();
    return run().then(function (out) {
      if (seq !== state.seq) return null;
      state.busy = '';
      return after(out);
    }).catch(function (err) {
      if (seq !== state.seq) return;
      state.busy = '';
      draw();
      toast(err.message || 'That file could not be read.', 6000);
    });
  }
  function closeBatch() { state.batch = null; state.results = null; state.audit = []; state.chain = null; state.match = null; state.decisions = null; state.work = null; state.res = null; state.open = {}; state.letter = { crid: '', tone: 'warm', text: '', edited: false, person: null, source: 'template' }; }
  function loadDemo() {
    state.demo = true; resetBuild(); closeBatch(); state.recheck = null; state.pendingId = D.BATCH;
    demoStore.clearAll();
    return begin('Opening the example…', function () { return engine.run('loadPortfolio', { demo: true, today: today() }); }, afterPortfolio);
  }
  function loadFile(fileObj) {
    if (!fileObj) return;
    if (fileObj.size > C.LIMITS.fileBytes) { toast('That file is over 25 MB. Export fewer loans at a time - 250,000 is the most one file can hold.', 6000); return; }
    var wasDemo = state.demo;
    state.demo = false; resetBuild();
    if (wasDemo) closeBatch();
    return begin('Reading ' + C.line(fileObj.name, 80) + ' on this device…', function () { return engine.run('loadPortfolio', { file: fileObj, name: C.line(fileObj.name, 120) }); }, afterPortfolio);
  }
  function afterPortfolio(meta) {
    var pf = { name: meta.name, demo: meta.demo, headers: meta.headers, sample: meta.sample, stats: meta.stats, map: meta.guess.map, conf: meta.guess.conf, order: '', fraction: null, typeMap: {}, q: null, preset: '' };
    var p = C.applyPreset(meta.headers, state.settings.presets);
    if (p) { Object.keys(p.map).forEach(function (k) { C.PKEYS.forEach(function (g) { if (g !== k && pf.map[g] === p.map[k]) { pf.map[g] = null; delete pf.conf[g]; } }); pf.map[k] = p.map[k]; pf.conf[k] = 'preset'; }); pf.preset = p.name; }
    state.pf = pf;
    return refreshQuestions().then(function () {
      go('portfolio');
      if (!meta.demo) toast('Read ' + plural(meta.stats.kept, 'loan') + ' on this device. Check the columns, then run the row checks.', 4200);
    });
  }
  function refreshQuestions() {
    return engine.run('questions', { map: state.pf.map }).then(function (q) {
      state.pf.q = q;
      if (q.fraction && state.pf.fraction === null) state.pf.fraction = true;
      q.types.forEach(function (t) { if (!state.pf.typeMap[t.key]) state.pf.typeMap[t.key] = t.type; });
    });
  }
  function checkOpts() { return { layout: state.settings.layout, statusDate: state.statusDate, cridMode: state.settings.cridMode, batchId: state.pendingId }; }
  function runRowChecks() {
    var pf = state.pf;
    var probs = C.mappingProblems(pf.map);
    if (probs.length) { toast(probs[0], 4200); return; }
    if (pf.q && pf.q.dates && !pf.order) { toast('Answer the date question first.', 4200); return; }
    var x = checkOpts();
    x.map = pf.map; x.order = pf.order; x.fraction = Boolean(pf.fraction); x.typeMap = pf.typeMap;
    begin('Checking ' + plural(pf.stats.kept, 'loan') + '…', function () { return engine.run('prepare', x); }, function (c) {
      state.chk = c; state.built = null;
      go('checks');
    });
  }
  function recheckRows() {
    if (!state.chk) return Promise.resolve();
    return engine.run('checks', checkOpts()).then(function (c) { state.chk = c; keepPlace(draw); }).catch(function (e) { toast(e.message); });
  }

  /* ---------------- 2. the request file and the batch ---------------- */

  function buildFile() {
    var lp = C.layoutProblems(state.settings.layout);
    if (lp.length) { toast(lp[0], 5000); return; }
    var t = today();
    if (!C.isDay(state.statusDate)) { toast('Choose the status date.'); return; }
    if (state.statusDate > t) { toast('The status date cannot be in the future.'); return; }
    var replaced = state.built && !state.built.hasResults ? state.built.batch.id : '';
    var id = state.demo ? D.BATCH : newBatchId();
    var x = { layout: state.settings.layout, statusDate: state.statusDate, today: t, batchId: id, createdAt: nowIso(), lineEnding: state.settings.lineEnding, split: state.settings.split, cridMode: state.settings.cridMode };
    if (state.recheck) x.only = state.recheck.only;
    begin('Building the request file…', function () { return engine.run('build', x); }, function (out) {
      if (!out.batch.count) { toast('No record passed its checks, so there is nothing to send.', 5000); draw(); return null; }
      return (replaced && replaced !== out.batch.id ? db().delBatch(replaced) : Promise.resolve()).then(function () {
        return db().putBatch(out.batch);
      }).then(function (saved) {
        state.built = { files: out.files, preview: out.preview, allExact: out.allExact, lineLength: out.lineLength, batch: saved, hasResults: false, recheck: Boolean(state.recheck) };
        state.chk = { groups: out.groups, counts: out.counts };
        state.pendingId = id;
        closeBatch();
        state.batch = saved;
        return db().appendAudit(saved.id, { kind: 'batch', at: nowIso(), by: state.device.initials, value: { records: saved.count, files: saved.files } }, digest);
      }).then(function () { return refreshBatches(); }).then(function () {
        return db().getAudit(state.batch.id).then(function (a) { state.audit = a; });
      }).then(function () {
        state.recheck = null;
        keepPlace(draw);
        toast(state.demo ? 'Built the example file - never saved.' : (replaced ? 'Built - it replaces batch ' + replaced + '.' : 'Built and saved as batch ' + state.batch.id + ' - no SSN, date of birth or name in it.'), 4200);
      }).catch(function (e) { toast(e.message, 7000); draw(); });
    });
  }
  function refreshBatches() { return real.listBatches().then(function (l) { state.batches = l; }).catch(function () { state.batches = []; }); }
  function openBatch(id, view) {
    var dbx = state.demo && id === D.BATCH ? demoStore : real;
    if (dbx === real && state.demo) { state.demo = false; }
    return Promise.all([dbx.getBatch(id), dbx.getResults(id), dbx.getAudit(id)]).then(function (r) {
      if (!r[0]) { toast('That batch is not on this device any more.'); return; }
      closeBatch();
      state.batch = r[0]; state.results = r[1]; state.audit = r[2];
      recompute();
      verifyChain();
      go(view || (state.results ? 'decisions' : 'results'));
    }).catch(function (e) { toast(e.message, 5000); });
  }

  /* ---------------- 3. results ---------------- */

  function pretendResults() {
    if (!state.batch || !state.demo) return;
    var text = D.results(state.batch, today());
    return begin('Making up the example’s results…', function () { return engine.run('loadResults', { text: text, name: D.RESULTS_FILE }); }, afterResults);
  }
  function loadResultsFile(fileObj) {
    if (!fileObj) return;
    if (!state.batch) { toast('Open the batch these results are for first.'); return; }
    if (fileObj.size > C.LIMITS.fileBytes) { toast('That file is over 25 MB.', 5000); return; }
    return begin('Reading ' + C.line(fileObj.name, 80) + ' on this device…', function () { return engine.run('loadResults', { file: fileObj, name: C.line(fileObj.name, 120) }); }, afterResults);
  }
  function afterResults(meta) {
    var r = { mode: meta.mode, name: meta.name, total: meta.total };
    if (meta.mode === 'csv') {
      r.headers = meta.headers; r.map = meta.guess; r.ignored = meta.ignored; r.sample = meta.sample;
      var preset = (state.settings.presets || []).filter(function (p) { return p.kind === 'results'; }).map(function (p) {
        var lower = meta.headers.map(function (h) { return h.toLowerCase(); }), map = {}, hit = 0;
        Object.keys(p.map).forEach(function (k) { var i = lower.indexOf(String(p.map[k]).toLowerCase()); if (i >= 0) { map[k] = i; hit++; } });
        return { p: p, map: map, hit: hit, n: Object.keys(p.map).length };
      }).filter(function (x) { return x.n && x.hit / x.n >= 0.8; })[0];
      if (preset) { Object.keys(preset.map).forEach(function (k) { r.map[k] = preset.map[k]; }); r.preset = preset.p.name; }
    } else {
      r.lines = meta.lines; r.width = meta.width; r.skip = meta.skip; r.raw = null;
      r.spans = (state.settings.resultsSpans || []).filter(function (s) { return s.start <= meta.width; }).map(function (s) { return { field: s.field, start: s.start, len: s.len }; });
      r.sel = null; r.selField = 'crid';
    }
    state.res = r;
    go('results');
  }
  function readResults() {
    var r = state.res;
    if (!r) return;
    var x = r.mode === 'csv' ? { map: r.map } : { spans: r.spans, skip: r.skip };
    var probs = r.mode === 'csv' ? C.resultProblems(r.map) : C.spanProblems(r.spans, r.width);
    if (probs.length) { toast(probs[0], 4200); return; }
    begin('Matching ' + plural(r.total, 'line') + ' to batch ' + state.batch.id + '…', function () { return engine.run('readResults', x); }, function (out) {
      return db().listBatches().then(function (list) {
        return Promise.all(list.filter(function (b) { return b.id !== state.batch.id; }).slice(0, 12).map(function (b) { return db().getBatch(b.id); }));
      }).then(function (others) {
        var here = C.matchResults(out.results, [state.batch], state.batch.id);
        var best = others.filter(Boolean).map(function (b) { return C.matchResults(out.results, [b], b.id); }).sort(function (a, b) { return b.matched.length - a.matched.length; })[0];
        if (best && best.matched.length > here.matched.length * 2 && best.matched.length > out.results.length / 2) {
          toast('These results belong to batch ' + best.batchId + ' - opening it.', 5000);
          return openBatch(best.batchId, 'results').then(function () { return saveResults(out.results, r); });
        }
        return saveResults(out.results, r);
      });
    });
  }
  function saveResults(list, r) {
    var at = nowIso(), id = state.batch.id;
    if (r.mode === 'fixed') { state.settings.resultsSpans = r.spans; settingsChanged(); }
    return db().putResults(id, list, at, r.name).then(function () { return db().getResults(id); }).then(function (res) {
      state.results = res;
      recompute();
      var m = state.match;
      return db().appendAudit(id, { kind: 'results', at: at, by: state.device.initials, value: { matched: m.matched.length, unmatched: m.unmatchedCount, missing: m.missing.length, policy: state.settings.policy } }, digest).then(function () {
        var todo = state.decisions.filter(function (d) { return C.TODO[d.code]; });
        var p = Promise.resolve();
        todo.forEach(function (d) { p = p.then(function () { return db().appendAudit(id, { kind: 'decision', at: at, crid: d.crid, by: state.device.initials, value: { code: d.code, owed: d.est ? d.est.owed : 0, monthly: d.est ? d.est.monthly : 0, capStart: d.capStart, capEnd: d.capEnd } }, digest); }); });
        return p;
      });
    }).then(function () { return db().getAudit(id); }).then(function (a) {
      state.audit = a; state.work = C.workFrom(a); state.res = null;
      if (state.built) state.built.hasResults = true;
      verifyChain();
      state.filter = 'todo';
      go('decisions');
      var t = C.totals(state.batch, state.decisions);
      toast('Matched ' + plural(state.match.matched.length, 'line') + '. ' + plural(t.eligible, 'case') + ' eligible' + (t.todo > t.eligible ? ', ' + groups(t.todo) + ' need a person in all' : '') + '.', 3200);
    }).catch(function (e) { toast(e.message, 6000); draw(); });
  }
  /** Decisions are worked out on read: the batch, its results, today and the policy. */
  function recompute() {
    if (!state.batch || !state.results) { state.match = null; state.decisions = null; state.work = state.audit ? C.workFrom(state.audit) : null; return; }
    state.match = C.matchResults(state.results.results, [state.batch], state.batch.id);
    state.decisions = C.decideAll(state.batch, state.match, { policy: state.settings.policy, today: today() });
    state.work = C.workFrom(state.audit);
  }
  function decisionOf(crid) { return state.decisions ? state.decisions.filter(function (d) { return d.crid === crid; })[0] || null : null; }

  /* ---------------- 4. the worklist and its audit log ---------------- */

  function log(fields) {
    if (!state.batch) return Promise.resolve();
    var id = state.batch.id;
    fields.at = nowIso();
    if (fields.by === undefined) fields.by = state.device.initials;
    return db().appendAudit(id, fields, digest).then(function () { return db().getAudit(id); }).then(function (a) {
      state.audit = a; state.work = C.workFrom(a);
      verifyChain(true);
      keepPlace(draw);
    }).catch(function (e) { toast(e.message, 5000); });
  }
  function logStep(crid, field, value) { return log({ kind: 'step', crid: crid, field: field, value: value }); }
  function logNote(crid, text) {
    return engine.run('scrub', { text: text }).then(function (s) {
      if (s.removed) toast('Took out ' + plural(s.removed, 'thing') + ' that looked like borrower data - notes never hold an SSN, a date of birth or a name.', 5200);
      return log({ kind: 'note', crid: crid, value: s.text });
    });
  }
  var verifying = 0;
  function verifyChain(quiet) {
    var mine = ++verifying;
    return C.verifyAudit(state.audit || [], digest).then(function (r) {
      if (mine !== verifying) return;
      state.chain = r;
      if (!quiet && (state.view === 'work' || state.view === 'pack')) keepPlace(draw);
      else $$('[data-chain]').forEach(function (el) { el.innerHTML = chainHtml(); });
    }).catch(function (e) { state.chain = { ok: false, n: (state.audit || []).length, broken: { why: e.message } }; });
  }

  /* ---------------- routing ---------------- */

  var VIEWS = ['portfolio', 'checks', 'file', 'results', 'decisions', 'work', 'pack', 'settings'];
  var TAB_OF = { portfolio: 'portfolio', checks: 'portfolio', file: 'portfolio', results: 'results', decisions: 'decisions', work: 'work', pack: 'pack', settings: 'settings' };
  function go(view) {
    history.pushState(null, '', BASE + '#' + view);
    route(); scrollTo(0, 0);
  }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    var v = VIEWS.indexOf(h) >= 0 ? h : 'start';
    if ((v === 'portfolio' || v === 'checks') && !state.pf) v = state.batch ? 'file' : 'start';
    if (v === 'checks' && !state.chk) v = 'portfolio';
    if (v === 'file' && !state.chk && !state.built) v = state.pf ? 'portfolio' : 'start';
    if ((v === 'results' || v === 'decisions' || v === 'work' || v === 'pack') && !state.batch) v = 'start';
    state.view = v;
    draw();
  }
  function hasWork() { return Boolean(state.pf || state.batch); }
  function draw() {
    var main = $('#main');
    var tb = $('#tabbar');
    tb.hidden = !hasWork() || state.view === 'start';
    var t = state.decisions ? C.totals(state.batch, state.decisions) : null;
    $$('#tabbar [data-tab]').forEach(function (b) {
      var tab = b.getAttribute('data-tab');
      if (TAB_OF[state.view] === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      var span = $('span', b);
      if (tab === 'decisions') span.innerHTML = 'Decisions' + (t && t.eligible ? ' <i class="badge">' + esc(String(t.eligible)) + '</i>' : '');
      if (tab === 'work') { var left = state.decisions ? C.worklist(state.decisions, state.work).filter(function (w) { return !w.c.done; }).length : 0; span.innerHTML = 'Worklist' + (left ? ' <i class="badge">' + esc(String(left)) + '</i>' : ''); }
    });
    var sb = $('#settingsBtn');
    if (sb) { if (state.view === 'settings') sb.setAttribute('aria-current', 'page'); else sb.removeAttribute('aria-current'); }
    var html;
    if (state.busy) html = '<div class="card busy" role="status"><div class="spinner" aria-hidden="true"></div><p><b id="busyText">' + esc(state.busy) + '</b></p><p class="small muted">On this device - nothing is uploaded.</p></div>';
    else if (state.view === 'settings') html = settingsHtml();
    else if (state.view === 'portfolio') html = portfolioHtml();
    else if (state.view === 'checks') html = checksHtml();
    else if (state.view === 'file') html = fileHtml();
    else if (state.view === 'results') html = resultsHtml();
    else if (state.view === 'decisions') html = decisionsHtml();
    else if (state.view === 'work') html = workHtml();
    else if (state.view === 'pack') html = packHtml();
    else html = startHtml();
    main.innerHTML = html + footer();
    afterDraw();
  }
  function footer() {
    return '<footer class="foot"><p>Muster reads portfolios on this device; SSNs, dates of birth and names never leave it and are never saved. ' + esc(C.NOT_ADVICE) + '</p><p>A Challenge Lab app · <a href="../">more experiments</a></p></footer>';
  }

  /* ---------------- first run ---------------- */

  function startHtml() {
    var saved = state.batches.filter(function (b) { return !b.demo; });
    return '<div class="stack">' +
      '<section class="hero">' +
        '<p class="kicker">🎖️ SCRA servicemember checks</p>' +
        '<h1>Find the servicemembers in your loan book - and apply the 6% cap with the paper trail.</h1>' +
        '<p>Muster turns a portfolio export into DMDC’s fixed-width multiple-record request file, reads the results back against each loan, decides who is owed the 6% cap and estimates what - with a worklist and a hash-chained audit log an examiner can follow.</p>' +
        '<div class="btns"><button class="btn big primary" type="button" data-act="demo">Try the example</button>' +
        '<label class="btn big ghost filepick">Check my portfolio<input type="file" data-file="portfolio" accept=".csv,.tsv,.txt,text/csv,text/plain"></label></div>' +
        '<p class="caps">Read on this device. SSNs never leave it and are never saved. CSV or TSV - up to 25 MB and 250,000 loans.</p>' +
        mockHtml() +
      '</section>' +
      (saved.length ? '<section class="card"><div class="sec-head"><h2>Results back from DMDC?</h2><span class="small muted">Saved on this device - no SSN, date of birth or name in them</span></div><ul class="batchlist">' + saved.slice(0, 6).map(batchRowHtml).join('') + '</ul></section>' : '') +
      '<button class="card demo-card" type="button" data-act="demo"><span class="ico" aria-hidden="true">🏦</span><b>' + esc(D.LENDER) + '</b><p>' + esc(D.blurb) + ' Made up from end to end - every SSN is in the never-issued 900-999 area.</p></button>' +
      '<section class="grid4 how" aria-label="How it works">' +
        '<div class="card"><span class="n">1</span><h2>Drop the export</h2><p>Loan ids, borrowers and co-borrowers (SSN, date of birth, names), rates, balances, loan types. Muster guesses each column; you confirm.</p></div>' +
        '<div class="card"><span class="n">2</span><h2>Catch the rows that fail</h2><p>SSNs that were never issued, missing dates of birth, names cut to fit or folded to plain letters - with the exact rows.</p></div>' +
        '<div class="card"><span class="n">3</span><h2>Build the request file</h2><p>Fixed width, 119 characters a line, one record per borrower per loan, with a ruler to check every position against DMDC’s guide.</p></div>' +
        '<div class="card"><span class="n">4</span><h2>Decide, apply, prove it</h2><p>Results matched back to loans, each case decided with the rule it rests on, the 6% math, a worklist and an exam pack.</p></div>' +
      '</section>' +
      '<section class="dropzone" data-drop><p style="margin:0"><b>Or drop a portfolio export here</b></p><p class="small muted" style="margin:0">It is read in this browser. Not a byte of it is uploaded.</p><label class="btn ghost filepick">Choose a file<input type="file" data-file="portfolio" accept=".csv,.tsv,.txt,text/csv,text/plain"></label></section>' +
      '<section class="card"><h2>What it does</h2><ul class="chips">' + ['Column guessing with a confirm step', 'Co-borrowers checked too', 'Never-issued SSNs caught', 'Names folded and cut to fit', 'DMDC fixed-width request file', 'Editable layout, checked for overlaps', 'CSV or fixed-width results', 'A ruler to map any results layout', 'Eligible, check policy, watch', 'Mortgages: the one-year tail', 'Released in 367 days', 'Taken out during service', 'Fees counted as interest', 'The 6% math in cents', 'A worklist with steps', 'SHA-256-chained audit log', 'Exam pack: CSV, summary, log', 'Borrower letters'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>' +
      '<p class="privacy-line">🔒 <span><b>Nothing is uploaded.</b> The inputs are SSNs and dates of birth, so Muster reads them in this browser, keeps them in memory only while the page is open, and saves only the batch record - which customer record id is which loan - and your worklist. A free account keeps your layouts and preferences, never a borrower. ' + esc(C.NOT_ADVICE) + '</span></p>' +
    '</div>';
  }
  function mockHtml() {
    return '<div class="mock" aria-hidden="true"><div class="mh"><span>Decisions · status date 9 Nov</span><span class="mf">68 records</span></div><ul>' +
      '<li><span class="mp mok">✓ Eligible</span><span>Mortgage 7.125% · tail to Jul 2027</span><b>$3,089</b></li>' +
      '<li><span class="mp mok">✓ Eligible</span><span>Card 24.99% + fees</span><b>$199</b></li>' +
      '<li><span class="mp mpol">? Check policy</span><span>Auto 7.49% · during service</span><b></b></li>' +
      '<li><span class="mp mw">◷ Watch</span><span>Call-up on 24 Dec</span><b></b></li>' +
      '</ul><div class="mt">90111100119951031FARROWBY            DELPHINE</div></div>';
  }
  function batchRowHtml(b) {
    return '<li><div><div class="bn">Batch ' + esc(b.id) + ' · status date ' + esc(nice(b.statusDate)) + '</div><div class="bm">' + esc(plural(b.count, 'record') + ' on ' + plural(b.loans, 'loan') + ' · built ' + stamp(b.createdAt)) + '</div></div><button class="btn small" type="button" data-act="openbatch" data-id="' + esc(b.id) + '">Open</button></li>';
  }

  /* ---------------- the build: three steps ---------------- */

  function stepsBar(cur) {
    var items = [['portfolio', 'Columns', Boolean(state.pf)], ['checks', 'Row checks', Boolean(state.chk)], ['file', 'Request file', Boolean(state.chk || state.built)]];
    return '<ol class="steps" aria-label="Build the request file">' + items.map(function (it, i) {
      return '<li><button type="button" data-act="tab" data-tab="' + it[0] + '"' + (it[0] === cur ? ' aria-current="step"' : '') + (it[2] ? '' : ' disabled') + '><span class="n">' + (i + 1) + '</span>' + esc(it[1]) + '</button></li>';
    }).join('') + '</ol>';
  }
  function demoStrip(text) {
    if (!state.demo) return '';
    return '<div class="demo-strip"><p>🏦 <b>Example</b> · ' + esc(D.LENDER) + ' - made up. ' + esc(text) + '</p><button class="btn small ghost" type="button" data-act="leavedemo">Use my own file</button></div>';
  }
  function recheckStrip() {
    if (!state.recheck) return '';
    return '<div class="demo-strip"><p>↻ <b>Re-check file</b> for ' + esc(plural(state.recheck.only.length, 'borrower')) + ' from batch ' + esc(state.recheck.from) + '. Confirm the columns and build it - only those records go in.</p><button class="btn small ghost" type="button" data-act="cancelrecheck">Cancel</button></div>';
  }
  function fileStripHtml() {
    var s = state.pf.stats;
    var notes = [];
    if (s.preamble) notes.push(plural(s.preamble, 'title line') + ' above the header skipped');
    if (!s.header) notes.push('no header row - columns are numbered');
    if (s.truncated) notes.push(groups(s.truncated) + ' rows past 250,000 not read');
    if (s.ragged) notes.push(plural(s.ragged, 'row') + ' with a different number of cells');
    if (s.invisible) notes.push(plural(s.invisible, 'invisible character') + ' removed');
    if (s.cut) notes.push(plural(s.cut, 'cell') + ' cut at 300 characters');
    if (s.openQuote) notes.push('a quote that never closes');
    if (s.wide) notes.push(plural(s.wide, 'column') + ' past 80 ignored');
    return '<section class="card filestrip"><p class="fname">' + esc(state.pf.name) + '</p><p class="fmeta">' + esc(plural(s.kept, 'loan') + ' · ' + (s.delimiter || 'comma') + '-separated · read on this device' + (state.pf.preset ? ' · preset “' + state.pf.preset + '”' : '')) + '</p>' + (notes.length ? '<p class="fmeta">' + esc(notes.join(' · ')) + '</p>' : '') + '</section>';
  }
  var MAP_GROUPS = [
    { name: 'The loan', keys: ['loan', 'type', 'orig', 'rate', 'bal', 'pay', 'fees', 'applied'] },
    { name: 'Borrower 1', keys: ['b1Ssn', 'b1Dob', 'b1Last', 'b1First', 'b1Middle', 'b1Full'] },
    { name: 'Borrower 2 (co-borrower) - optional', keys: ['b2Ssn', 'b2Dob', 'b2Last', 'b2First', 'b2Middle', 'b2Full'] },
  ];
  function confBadge(k) {
    var pf = state.pf, f = C.pfield(k), c = pf.conf[k], placed = pf.map[k] !== null && pf.map[k] !== undefined;
    if (!placed) return f.need ? '<span class="sure sure-need">Needed</span>' : '<span class="sure sure-none">Not found</span>';
    if (c === 'sure') return '<span class="sure sure-sure">✓ Sure</span>';
    if (c === 'likely') return '<span class="sure sure-likely">Likely</span>';
    if (c === 'you') return '<span class="sure sure-you">Your pick</span>';
    if (c === 'preset') return '<span class="sure sure-preset">From your preset</span>';
    return '<span class="sure sure-unsure">? Check this</span>';
  }
  function exampleOf(i) {
    if (i === null || i === undefined) return '';
    var vals = state.pf.sample.map(function (r) { return r[i]; }).filter(Boolean).slice(0, 3);
    return vals.length ? 'e.g. ' + vals.map(function (v) { return C.clip(v, 28); }).join(' · ') : 'blank in the first rows';
  }
  function mapRowHtml(k) {
    var pf = state.pf, f = C.pfield(k), i = pf.map[k];
    var need = f.need && (i === null || i === undefined);
    return '<li class="maprow' + (need ? ' need' : '') + '"><div class="mh"><b>' + esc(f.label) + '</b>' + confBadge(k) + '</div>' +
      '<p class="mv">' + (i === null || i === undefined ? '' : 'Column “' + esc(pf.headers[i]) + '” · ') + esc(exampleOf(i)) + '</p>' +
      '<select class="input" data-pmap="' + esc(k) + '" aria-label="' + esc(f.label) + '"><option value="">- not in this file -</option>' + pf.headers.map(function (h, j) { return '<option value="' + j + '"' + (j === i ? ' selected' : '') + '>' + esc(h) + '</option>'; }).join('') + '</select></li>';
  }
  function questionsHtml() {
    var q = state.pf.q, out = '';
    if (!q) return '';
    if (q.dates) {
      out += '<section class="question"><h3>Which way round are the dates?</h3><p class="small muted">Every date in this file reads both ways, so Muster asks once. It is used for dates of birth and origination dates.</p>' +
        '<label class="radio"><input type="radio" name="dord" data-q="order" value="mdy"' + (state.pf.order === 'mdy' ? ' checked' : '') + '><span><b>Month first: ' + esc(q.dates.raw) + ' is ' + esc(nice(q.dates.mdy)) + '</b><small>The US way</small></span></label>' +
        '<label class="radio"><input type="radio" name="dord" data-q="order" value="dmy"' + (state.pf.order === 'dmy' ? ' checked' : '') + '><span><b>Day first: ' + esc(q.dates.raw) + ' is ' + esc(nice(q.dates.dmy)) + '</b><small>Most of the world</small></span></label></section>';
    }
    if (q.fraction) {
      out += '<section class="question"><h3>Are the rates fractions?</h3><p class="small muted">Every rate in the file is 1 or less.</p>' +
        '<label class="radio"><input type="radio" name="frac" data-q="fraction" value="yes"' + (state.pf.fraction ? ' checked' : '') + '><span><b>Yes: ' + esc(q.fraction.example) + ' means ' + esc(q.fraction.asFraction) + '</b><small>A rate written as 0.0949</small></span></label>' +
        '<label class="radio"><input type="radio" name="frac" data-q="fraction" value="no"' + (!state.pf.fraction ? ' checked' : '') + '><span><b>No: ' + esc(q.fraction.example) + ' means ' + esc(q.fraction.asPercent) + '</b><small>Already a percentage</small></span></label></section>';
    }
    return out;
  }
  function typesHtml() {
    var q = state.pf.q;
    if (!q || !q.types.length) return '';
    return '<section class="card"><div class="sec-head"><h2>Loan types</h2><span class="small muted">Guessed from the values - a mortgage gets the one-year tail</span></div>' +
      '<div class="tablewrap" tabindex="0"><table class="plain"><thead><tr><th>In the file</th><th class="r">Loans</th><th>Muster reads it as</th></tr></thead><tbody>' +
      q.types.map(function (t) {
        return '<tr><td>' + esc(t.raw) + (t.sure ? '' : ' <span class="sure sure-unsure">? Check this</span>') + '</td><td class="r">' + esc(groups(t.n)) + '</td><td><select class="input" data-ptype="' + esc(t.key) + '" aria-label="Loan type for ' + esc(t.raw) + '">' + C.LOAN_TYPES.map(function (x) { return '<option value="' + esc(x) + '"' + (state.pf.typeMap[t.key] === x ? ' selected' : '') + '>' + esc(C.TYPE_WORD[x]) + '</option>'; }).join('') + '</select></td></tr>';
      }).join('') + '</tbody></table></div>' +
      (q.types.some(function (t) { return !t.sure && t.type === 'mortgage'; }) ? '<p class="small muted" style="margin:8px 0 0">A home-equity line is read as a mortgage here (secured by the home). Whether it counts as “a mortgage, trust deed or other security in the nature of a mortgage” is your policy’s call - change it if it does not.</p>' : '') +
      '</section>';
  }
  function portfolioHtml() {
    var pf = state.pf;
    var placed = C.PKEYS.filter(function (k) { return pf.map[k] !== null && pf.map[k] !== undefined; });
    var allSure = placed.length && placed.every(function (k) { return pf.conf[k] === 'sure' || pf.conf[k] === 'preset'; }) && !C.mappingProblems(pf.map).length;
    var probs = C.mappingProblems(pf.map);
    var mapping = allSure && !state.showMap
      ? '<section class="card"><p class="okline">✓ Every column recognised - ' + esc(plural(placed.length, 'field')) + (placed.some(function (k) { return /^b2/.test(k); }) ? ', co-borrowers included' : '') + '.</p>' + MAP_GROUPS.map(function (g) { var ks = g.keys.filter(function (k) { return placed.indexOf(k) >= 0; }); return ks.length ? '<p class="small muted" style="margin:6px 0 0"><b>' + esc(g.name.replace(/ - optional$/, '')) + ':</b> ' + esc(ks.map(function (k) { return C.pfield(k).label.replace(/^Borrower \d( \(co-borrower\))? /, '').replace(/ \(.*\)$/, ''); }).join(', ')) + '</p>' : ''; }).join('') + '<div class="btns" style="margin-top:10px"><button class="btn small ghost" type="button" data-act="showmap">Check or change</button></div></section>'
      : '<section class="card"><div class="sec-head"><h2>Which column is which?</h2><span class="small muted">Guessed from the header names and what the values look like</span></div><div class="fgroups">' +
        MAP_GROUPS.map(function (g) { return '<div class="fgroup"><h3>' + esc(g.name) + '</h3><ul class="maplist">' + g.keys.map(mapRowHtml).join('') + '</ul></div>'; }).join('') +
        '</div><div class="btns" style="margin-top:12px"><button class="btn small ghost" type="button" data-act="preset">Save these columns as a preset</button><span class="small muted">Keeps the header names only - never a value.</span></div></section>';
    return '<div class="stack">' + stepsBar('portfolio') + recheckStrip() +
      demoStrip('Step 1 of 5: the columns. Every one was recognised, co-borrowers included.') +
      fileStripHtml() + questionsHtml() + mapping + typesHtml() +
      '<div class="sticky-acts"><span class="small muted">' + (probs.length ? esc(probs[0]) : esc('Next: check every row before anything goes in the file.')) + '</span><button class="btn" type="button" data-act="runchecks"' + (probs.length ? ' disabled' : '') + '>Run the row checks →</button></div>' +
    '</div>';
  }

  /* ---------------- row checks ---------------- */

  var SEV_WORD = { block: 'Left out', warn: 'Included - worth a look', info: 'Fine' };
  var SEV_PILL = { block: 'p-block', warn: 'p-warn', info: 'p-info' };
  function groupHtml(g) {
    var open = state.open['g-' + g.key] === undefined ? (g.sev !== 'info' && g.count <= 50) : state.open['g-' + g.key];
    var hasBA = g.rows.some(function (r) { return r.before !== undefined; });
    return '<li class="group sev-' + g.sev + '"><button class="ghead" type="button" data-act="toggle" data-key="g-' + esc(g.key) + '" aria-expanded="' + (open ? 'true' : 'false') + '"><span class="gt">' + esc(g.title) + '</span><span class="chev" aria-hidden="true">' + (open ? '▾' : '▸') + '</span><span class="gl"><span class="pill ' + SEV_PILL[g.sev] + '">' + esc(SEV_WORD[g.sev]) + '</span><span>' + esc(plural(g.count, 'record')) + '</span></span></button>' +
      (open ? '<div class="gbody"><p>' + esc(g.sentence) + '</p><div class="tablewrap" tabindex="0"><table class="plain"><thead><tr><th class="r">Line</th><th>Loan</th><th>Borrower</th>' + (hasBA ? '<th>Field</th><th>Before</th><th>After</th>' : '<th>What</th>') + '</tr></thead><tbody>' +
        g.rows.map(function (r) { return '<tr><td class="r">' + esc(groups(r.line)) + '</td><td>' + esc(r.loan || '(none)') + '</td><td>B' + esc(String(r.b)) + '</td>' + (hasBA ? '<td>' + esc(r.field || '') + '</td><td class="mono">' + esc(r.before || '') + '</td><td class="mono">' + esc(r.after || '') + '</td>' : '<td>' + esc(r.detail || '') + '</td>') + '</tr>'; }).join('') +
        '</tbody></table></div>' + (g.count > g.rows.length ? '<p class="more">' + esc('The first ' + groups(g.rows.length) + ' of ' + groups(g.count) + ' are listed.') + '</p>' : '') + '</div>' : '') + '</li>';
  }
  function checksHtml() {
    var c = state.chk.counts;
    var gs = state.chk.groups;
    var blocks = c.left;
    return '<div class="stack">' + stepsBar('checks') + recheckStrip() +
      demoStrip('Step 2 of 5: three rows need a look - two are left out of the file, and one long name is folded to plain letters and cut to fit.') +
      '<section class="kpis four">' +
        '<div class="kpi"><span class="k">Loans</span><span class="v">' + esc(groups(c.loans)) + '</span></div>' +
        '<div class="kpi"><span class="k">Borrowers</span><span class="v">' + esc(groups(c.borrowers)) + '</span><span class="s">' + esc(plural(c.coBorrowers, 'co-borrower')) + '</span></div>' +
        '<div class="kpi hi"><span class="k">In the file</span><span class="v">' + esc(groups(c.ok)) + '</span><span class="s">one record per borrower per loan</span></div>' +
        '<div class="kpi"><span class="k">Left out</span><span class="v">' + esc(groups(c.left)) + '</span><span class="s">' + esc(c.left ? 'listed below, with why' : 'none') + '</span></div>' +
      '</section>' +
      (gs.length ? '<section class="card"><div class="sec-head"><h2>Row checks</h2><span class="small muted">SSNs show only their last four digits here</span></div><ul class="groups">' + gs.map(groupHtml).join('') + '</ul></section>'
        : '<section class="card"><p class="okline">✓ Every row passed: every SSN has 9 digits and could have been issued, every borrower has a date of birth and a last name, and every name fits.</p></section>') +
      '<div class="sticky-acts"><span class="small muted">' + esc(blocks ? plural(blocks, 'record') + ' left out - fix them in your system and add them to a re-check file.' : 'Next: the request file, with a ruler to check every position.') + '</span><button class="btn" type="button" data-act="tab" data-tab="file"' + (c.ok ? '' : ' disabled') + '>Build the request file →</button></div>' +
    '</div>';
  }

  /* ---------------- the request file ---------------- */

  function layoutTableHtml(where) {
    var lay = state.settings.layout, probs = C.layoutProblems(lay);
    var bad = {};
    probs.forEach(function (p) { C.LAYOUT_FIELDS.forEach(function (k) { if (p.indexOf(C.LAYOUT_LABEL[k]) === 0) bad[k] = 1; }); });
    var rowsHtml = C.LAYOUT_FIELDS.map(function (k) {
      var f = lay.fields[k];
      return '<tr' + (bad[k] ? ' class="bad"' : '') + '><td class="f"><span class="sw b-' + k + '" aria-hidden="true"></span>' + esc(C.LAYOUT_LABEL[k]) + '</td>' +
        '<td><input class="input num4" type="number" min="1" max="1000" inputmode="numeric" data-lay="' + k + '" data-part="start" value="' + esc(String(f.start)) + '" aria-label="' + esc(C.LAYOUT_LABEL[k]) + ' starts at"></td>' +
        '<td><input class="input num4" type="number" min="1" max="1000" inputmode="numeric" data-lay="' + k + '" data-part="len" value="' + esc(String(f.len)) + '" aria-label="' + esc(C.LAYOUT_LABEL[k]) + ' length"></td>' +
        '<td class="r">' + esc(String(Number(f.start) + Number(f.len) - 1)) + '</td><td>' + esc(C.LAYOUT_NOTE[k]) + '</td></tr>';
    }).join('');
    return '<section class="card" id="layout-' + esc(where) + '"><div class="sec-head"><h2>Request layout - DMDC SCRA multiple record request</h2>' + (C.isDefaultLayout(lay) ? '<span class="pill p-info">Muster’s default</span>' : '<span class="pill p-warn">Edited</span>') + '</div>' +
      '<p class="small">Check these positions against the current DMDC SCRA User Guide (“Format of the Request File”) before your first upload. DMDC checks every file it receives, so a wrong layout is refused rather than misread.</p>' +
      '<div class="tablewrap tall" tabindex="0"><table class="plain layout"><thead><tr><th>Field</th><th>Starts at</th><th>Length</th><th class="r">Ends at</th><th>Holds</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
      '<div class="row" style="margin-top:10px"><label class="field" style="max-width:200px"><span>Line length</span><input class="input num4" type="number" min="20" max="1000" inputmode="numeric" data-lay="lineLength" value="' + esc(String(lay.lineLength)) + '"></label><p class="small muted" style="margin:0;max-width:52ch">Spaces pad every field on the right; an empty optional field is all spaces. Dates are YYYYMMDD.</p></div>' +
      (probs.length ? '<div class="note" role="alert" style="margin-top:10px">' + probs.map(function (p) { return '<p class="err" style="margin:0 0 4px">' + esc(p) + '</p>'; }).join('') + '</div>' : '') +
      '<div class="btns" style="margin-top:10px"><button class="btn small ghost" type="button" data-act="resetlayout"' + (C.isDefaultLayout(lay) ? ' disabled' : '') + '>Reset to default</button><span class="small muted">' + (signedIn() ? 'Saved on this device and in your account.' : 'Saved on this device.') + '</span></div></section>';
  }
  /** A fixed-width block: ruler, lines and coloured bands behind each field. */
  function fwHtml(lines, spans, opts) {
    opts = opts || {};
    var width = opts.width || lines.reduce(function (m, l) { return Math.max(m, l.length); }, 0);
    var rl = C.rulerLines(width);
    var bands = spans.map(function (s) { return '<i class="band b-' + esc(s.k) + '" style="left:' + (s.start - 1) + 'ch;width:' + s.len + 'ch" title="' + esc(s.label + ': positions ' + s.start + '-' + (s.start + s.len - 1)) + '"></i>'; }).join('');
    return '<div class="fw" tabindex="0" role="region" aria-label="' + esc(opts.label || 'Preview') + '"><div class="fw-in">' +
      '<div class="rlwrap" aria-hidden="true"><span class="rl">' + esc(rl[0]) + '</span><span class="rl">' + esc(rl[1]) + '</span></div>' +
      lines.map(function (l) { return '<span class="ln">' + bands + '<span class="t">' + esc(l) + '</span></span>'; }).join('') +
      '</div></div>';
  }
  /** The preview's lines, SSNs and dates of birth hidden unless asked. */
  function previewLines() {
    var lines = state.built.preview, lay = C.cleanLayout(state.settings.layout);
    if (state.showSsn) return lines;
    var cover = function (l, f) { return l.slice(0, f.start - 1) + l.substr(f.start - 1, f.len).replace(/\S/g, '•') + l.slice(f.start - 1 + f.len); };
    return lines.map(function (l) { return cover(cover(l, lay.fields.ssn), lay.fields.dob); });
  }
  function fileHtml() {
    var s = state.settings, b = state.built, t = today();
    var stale = b && !b.hasResults && (b.stale || (!b.recheck && b.batch.statusDate !== state.statusDate));
    var opts = '<section class="card"><div class="sec-head"><h2>The file</h2><span class="small muted">One record per borrower per loan that passed its checks</span></div><div class="formgrid">' +
      '<label class="field"><span>Active duty status date</span><input class="input" type="date" data-set="statusDate" max="' + esc(t) + '" value="' + esc(state.statusDate) + '"><small>The day DMDC checks. It cannot be in the future.</small></label>' +
      '<div class="field"><span>Customer record ID</span>' +
        '<label class="radio"><input type="radio" name="crid" data-set="cridMode" value="loan"' + (s.cridMode !== 'short' ? ' checked' : '') + '><span><b>The loan id, cleaned, plus B1 / B2</b><small>Only A-Z and 0-9 are kept - LCU-40112 becomes LCU40112B1</small></span></label>' +
        '<label class="radio"><input type="radio" name="crid" data-set="cridMode" value="short"' + (s.cridMode === 'short' ? ' checked' : '') + '><span><b>A short code from Muster</b><small>For servicers who do not send loan numbers - the batch record maps it back</small></span></label></div>' +
      '<div class="field"><span>Line endings</span><div class="seg" role="group" aria-label="Line endings"><button type="button" data-act="set" data-key="lineEnding" data-val="crlf" aria-pressed="' + (s.lineEnding !== 'lf') + '">CRLF (Windows)</button><button type="button" data-act="set" data-key="lineEnding" data-val="lf" aria-pressed="' + (s.lineEnding === 'lf') + '">LF</button></div><small>UTF-8 with no byte-order mark. Every line ends with the line ending, the last one too.</small></div>' +
      '<label class="field"><span>Records per file</span><select class="input" data-set="split">' + [0, 1000, 5000, 10000, 25000, 50000].map(function (n) { return '<option value="' + n + '"' + (Number(s.split) === n ? ' selected' : '') + '>' + (n ? 'Split every ' + groups(n) : 'One file') + '</option>'; }).join('') + '</select><small>Split a big batch if your process needs smaller files.</small></label>' +
      '</div></section>';
    var built = '';
    if (b) {
      var shown = previewLines();
      built = '<section class="card"><div class="sec-head"><h2>' + esc(plural(b.batch.count, 'record')) + ' ready</h2><span class="small muted">Batch ' + esc(b.batch.id) + ' · status date ' + esc(nice(b.batch.statusDate)) + '</span></div>' +
        (b.allExact ? '<p class="okline">✓ Every line is exactly ' + esc(String(b.lineLength)) + ' characters</p>' : '<p class="err">Some lines are not ' + esc(String(b.lineLength)) + ' characters - check the layout.</p>') +
        '<ul class="batchlist" style="margin-top:10px">' + b.files.map(function (f, i) { return '<li><div><div class="bn anywhere">' + esc(f.name) + '</div><div class="bm">' + esc(plural(f.records, 'record') + ' · ' + (b.batch.lineEnding === 'lf' ? 'LF' : 'CRLF') + ' · SHA-256 ' + f.sha256.slice(0, 16) + '…') + '</div></div><button class="btn small" type="button" data-act="dlfile" data-i="' + i + '">Download</button></li>'; }).join('') + '</ul>' +
        '<h3 style="margin:14px 0 6px">Preview with a ruler</h3><ul class="legend">' + C.layoutSpans(s.layout).map(function (x) { return '<li><span class="sw b-' + x.k + '" aria-hidden="true"></span>' + esc(x.label + ' ' + x.start + '-' + (x.start + x.len - 1)) + '</li>'; }).join('') + '</ul>' +
        fwHtml(shown, C.layoutSpans(s.layout), { width: b.lineLength, label: 'The first lines of the request file' }) +
        '<label class="check"><input type="checkbox" data-set="showSsn"' + (state.showSsn ? ' checked' : '') + '>Show SSNs and dates of birth in the preview</label>' +
        '<p class="quiet">' + (state.demo ? 'The example is never saved.' : 'Saved as batch ' + esc(b.batch.id) + ' on this device: which customer record id is which loan, and what a decision needs. It holds no SSN, date of birth or name - those stay in this page’s memory and are gone when it closes.') + '</p></section>';
    }
    var next = b ? (state.demo
      ? '<div class="sticky-acts"><span class="small muted">In real life you upload the file at DMDC’s SCRA website and its results come back later.</span><button class="btn" type="button" data-act="pretend">Pretend DMDC answered →</button></div>'
      : '<div class="sticky-acts"><span class="small muted">Upload it at DMDC’s SCRA website. When the results come back - often a day later - open Results.</span><button class="btn" type="button" data-act="tab" data-tab="results">Results →</button></div>')
      : '<div class="sticky-acts"><span class="small muted">' + esc(state.chk ? plural(state.chk.counts.ok, 'record') + ' will go in.' : '') + '</span><button class="btn" type="button" data-act="build">Build the request file</button></div>';
    return '<div class="stack">' + stepsBar('file') + recheckStrip() +
      demoStrip('Step 3 of 5: the fixed-width request file - every line 119 characters, the fields coloured on a ruler.') +
      (state.demo ? '<div class="example-banner" role="note">⚠️ <p><b>EXAMPLE - do not upload this file.</b> Its name starts EXAMPLE-, every SSN in it is in the 900-999 area that is never issued, and every person is made up.</p></div>' : '') +
      (stale ? '<div class="note"><p style="margin:0">The options changed since this file was built. <button class="link-btn" type="button" data-act="build">Build it again</button></p></div>' : '') +
      built + opts + layoutTableHtml('file') + next + '</div>';
  }

  /* ---------------- results ---------------- */

  function batchStrip() {
    var b = state.batch;
    if (!b) return '';
    var r = state.results;
    return '<section class="card filestrip"><p class="fname">Batch ' + esc(b.id) + (b.demo ? ' · example' : '') + '</p><p class="fmeta">' + esc(plural(b.count, 'record') + ' on ' + plural(b.loans, 'loan') + ' · status date ' + nice(b.statusDate) + (r ? ' · results from ' + (r.file || 'a file') + ', read ' + stamp(r.at) : ' · waiting for results')) + '</p></section>';
  }
  var RES_GROUPS = [
    { name: 'Which record', keys: ['crid', 'statusDate'] },
    { name: 'On active duty', keys: ['active', 'adStart', 'adEnd'] },
    { name: 'Left active duty within 367 days', keys: ['left', 'leftStart', 'leftEnd'] },
    { name: 'Future call-up', keys: ['future', 'futureStart'] },
    { name: 'Other', keys: ['component', 'match'] },
  ];
  function rfield(k) { return C.RFIELDS.filter(function (f) { return f.key === k; })[0]; }
  function resMapRowHtml(k) {
    var r = state.res, f = rfield(k), i = r.map[k];
    var vals = i === null || i === undefined ? [] : r.sample.map(function (row) { return row[i]; }).filter(Boolean).slice(0, 3);
    return '<li class="maprow' + (f.need && (i === null || i === undefined) ? ' need' : '') + '"><div class="mh"><b>' + esc(f.label) + '</b>' + (i === null || i === undefined ? (f.need ? '<span class="sure sure-need">Needed</span>' : '<span class="sure sure-none">Not found</span>') : '<span class="sure sure-sure">✓ Found</span>') + '</div>' +
      '<p class="mv">' + (i === null || i === undefined ? '' : 'Column “' + esc(r.headers[i]) + '” · ') + esc(vals.length ? 'e.g. ' + vals.join(' · ') : '') + '</p>' +
      '<select class="input" data-rmap="' + esc(k) + '" aria-label="' + esc(f.label) + '"><option value="">- not in this file -</option>' + r.headers.map(function (h, j) { return r.ignored.indexOf(j) >= 0 ? '' : '<option value="' + j + '"' + (j === i ? ' selected' : '') + '>' + esc(h) + '</option>'; }).join('') + '</select></li>';
  }
  function csvMapperHtml() {
    var r = state.res;
    var ign = r.ignored.map(function (i) { return r.headers[i]; });
    return '<section class="card filestrip"><p class="fname">' + esc(r.name) + '</p><p class="fmeta">' + esc(plural(r.total, 'line') + ' · a CSV with headers · read on this device' + (r.preset ? ' · preset “' + r.preset + '”' : '')) + '</p>' + (state.demo ? '<p class="fmeta"><b>Example results (made-up layout for this demo).</b> Muster does not know the layout of DMDC’s real results file, so it guesses columns by their header names and asks you to confirm.</p>' : '') + '</section>' +
      (ign.length ? '<p class="privacy-line">🔒 <span><b>Ignored and never kept:</b> ' + esc(ign.join(', ')) + '. Muster reads only statuses, dates and the customer record id from a results file.</span></p>' : '') +
      '<section class="card"><div class="sec-head"><h2>Which column is which?</h2><span class="small muted">Yes/No, Y/N, True/False and 1/0 all read; dates as YYYYMMDD, YYYY-MM-DD or MM/DD/YYYY</span></div><div class="fgroups">' +
      RES_GROUPS.map(function (g) { return '<div class="fgroup"><h3>' + esc(g.name) + '</h3><ul class="maplist">' + g.keys.map(resMapRowHtml).join('') + '</ul></div>'; }).join('') +
      '</div><div class="btns" style="margin-top:12px"><button class="btn small ghost" type="button" data-act="rpreset">Save these columns as a preset</button></div></section>';
  }
  function fixedMapperHtml() {
    var r = state.res;
    var lines = state.showSsn && r.raw ? r.raw : r.lines;
    var width = r.width;
    var sel = r.sel;
    var spans = r.spans.map(function (s) { return { k: s.field === 'crid' ? 'crid' : ['adStart', 'leftStart', 'futureStart'].indexOf(s.field) >= 0 ? 'first' : ['adEnd', 'leftEnd', 'statusDate'].indexOf(s.field) >= 0 ? 'status' : ['active', 'left', 'future'].indexOf(s.field) >= 0 ? 'last' : 'middle', label: rfield(s.field).label, start: s.start, len: s.len }; });
    var all = spans.concat(sel ? [{ k: 'sel', label: 'Your selection', start: Math.min(sel.a, sel.b), len: Math.abs(sel.b - sel.a) + 1 }] : []);
    var mapped = {};
    r.spans.forEach(function (s) { for (var i = s.start; i < s.start + s.len; i++) mapped[i] = 1; });
    var cells = '';
    for (var p = 1; p <= width; p++) {
      var on = sel && p >= Math.min(sel.a, sel.b) && p <= Math.max(sel.a, sel.b);
      cells += '<span class="rc' + (on ? ' on' : '') + (mapped[p] ? ' mapped' : '') + '" data-pos="' + p + '"><span>' + (p % 10 === 0 ? (p / 10) % 10 : '·') + '</span><span>' + (p % 10) + '</span></span>';
    }
    var bands = all.map(function (s) { return '<i class="band b-' + esc(s.k) + '" style="left:' + (s.start - 1) + 'ch;width:' + s.len + 'ch" title="' + esc(s.label + ': ' + s.start + '-' + (s.start + s.len - 1)) + '"></i>'; }).join('');
    var a = sel ? Math.min(sel.a, sel.b) : '', len = sel ? Math.abs(sel.b - sel.a) + 1 : '';
    var used = {};
    r.spans.forEach(function (s) { used[s.field] = 1; });
    var probs = C.spanProblems(r.spans, width);
    return '<section class="card filestrip"><p class="fname">' + esc(r.name) + '</p><p class="fmeta">' + esc(plural(r.total, 'line') + ' · fixed width, ' + width + ' characters at most · read on this device') + '</p></section>' +
      '<section class="card"><div class="sec-head"><h2>Mark where each field sits</h2><span class="small muted">Saved as “My results layout”</span></div>' +
      '<p class="small">Drag across the ruler (or tap the first position, then the last), pick what that span holds and add it. Or type the start and length. Only the fields you mark are read - anything else on the line, an SSN or a name included, is ignored and never kept.</p>' +
      '<div class="fw" tabindex="0" role="region" aria-label="The first lines of the results file under a ruler"><div class="fw-in"><div class="ruler" data-ruler aria-label="Positions 1 to ' + width + '">' + cells + '</div>' +
      lines.map(function (l, i) { return '<span class="ln' + (i < r.skip ? ' muted' : '') + '">' + bands + '<span class="t">' + esc(l) + '</span></span>'; }).join('') + '</div></div>' +
      '<label class="check"><input type="checkbox" data-set="showSsn"' + (state.showSsn ? ' checked' : '') + '>Show numbers of 9 or more digits (hidden by default, in case the file repeats SSNs)</label>' +
      '<div class="selbar">' +
        '<label class="field"><span>Start</span><input class="input num4" type="number" min="1" max="' + width + '" data-sel="a" value="' + esc(String(a)) + '"></label>' +
        '<label class="field"><span>Length</span><input class="input num4" type="number" min="1" max="400" data-sel="len" value="' + esc(String(len)) + '"></label>' +
        '<label class="field"><span>This span holds</span><select class="input" data-sel="field">' + C.RFIELDS.map(function (f) { return '<option value="' + esc(f.key) + '"' + (r.selField === f.key ? ' selected' : '') + (used[f.key] ? ' disabled' : '') + '>' + esc(f.label + (used[f.key] ? ' (marked)' : '')) + '</option>'; }).join('') + '</select></label>' +
        '<button class="btn" type="button" data-act="addspan"' + (sel ? '' : ' disabled') + '>Add</button></div>' +
      '<p class="small muted" style="margin:8px 0 0">' + (sel ? esc('Positions ' + a + '-' + (a + len - 1) + ' (' + plural(len, 'character') + ').') : 'Nothing selected yet.') + '</p>' +
      (r.spans.length ? '<h3 style="margin:14px 0 6px">Marked</h3><ul class="spanlist">' + r.spans.slice().sort(function (x, y) { return x.start - y.start; }).map(function (s) { return '<li><span><b>' + esc(rfield(s.field).label) + '</b> · positions ' + esc(s.start + '-' + (s.start + s.len - 1)) + '</span><button class="btn small ghost" type="button" data-act="rmspan" data-field="' + esc(s.field) + '">Remove</button></li>'; }).join('') + '</ul>' : '') +
      '<label class="field" style="max-width:260px;margin-top:12px"><span>Header lines to skip</span><input class="input num4" type="number" min="0" max="5" data-set="skip" value="' + esc(String(r.skip)) + '"></label>' +
      (probs.length && r.spans.length ? '<p class="err">' + esc(probs[0]) + '</p>' : '') +
      '</section>';
  }
  function resultsHtml() {
    var b = state.batch, r = state.res, m = state.match;
    var head = '<div class="stack">' + demoStrip(r ? 'Step 4 of 5: the results. Every column was recognised - confirm and match them.' : 'Step 4 of 5: DMDC’s answer. Make one up for the example.') + batchStrip();
    if (r) {
      var probs = r.mode === 'csv' ? C.resultProblems(r.map) : C.spanProblems(r.spans, r.width);
      return head + (r.mode === 'csv' ? csvMapperHtml() : fixedMapperHtml()) +
        '<div class="sticky-acts"><span class="small muted">' + esc(probs.length ? probs[0] : 'Each line is matched back to batch ' + b.id + ' by its customer record id.') + '</span><span class="btns"><button class="btn ghost" type="button" data-act="dropres">Cancel</button><button class="btn" type="button" data-act="readres"' + (probs.length ? ' disabled' : '') + '>Match and decide →</button></span></div></div>';
    }
    var other = state.batches.filter(function (x) { return !x.demo && x.id !== b.id; });
    var done = '';
    if (state.results && m) {
      done = '<section class="card"><div class="sec-head"><h2>Read and matched</h2><span class="small muted">' + esc(stamp(state.results.at)) + '</span></div>' +
        '<section class="kpis four"><div class="kpi hi"><span class="k">Matched</span><span class="v">' + esc(groups(m.matched.length)) + '</span><span class="s">of ' + esc(plural(b.count, 'record')) + '</span></div><div class="kpi"><span class="k">Lines not in the batch</span><span class="v">' + esc(groups(m.unmatchedCount)) + '</span></div><div class="kpi"><span class="k">Records with no line</span><span class="v">' + esc(groups(m.missing.length)) + '</span><span class="s">' + esc(m.missing.length ? 'decided “Check by hand”' : 'none') + '</span></div><div class="kpi"><span class="k">Repeated lines</span><span class="v">' + esc(groups(m.duplicates)) + '</span><span class="s">the first one counts</span></div></section>' +
        (m.unmatched.length ? '<h3 style="margin:12px 0 6px">Lines that match no record in this batch</h3><div class="tablewrap" tabindex="0"><table class="plain"><thead><tr><th class="r">Line</th><th>Customer record id</th></tr></thead><tbody>' + m.unmatched.slice(0, 200).map(function (u) { return '<tr><td class="r">' + esc(groups(u.line)) + '</td><td class="mono">' + esc(u.crid || '(blank)') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '') +
        (m.missing.length ? '<h3 style="margin:12px 0 6px">Records with no line in the file</h3><p class="small mono anywhere">' + esc(m.missing.slice(0, 60).join(' · ') + (m.missing.length > 60 ? ' …' : '')) + '</p>' : '') +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="tab" data-tab="decisions">See the decisions →</button></div></section>';
    }
    return head + done +
      (state.demo && !state.results ? '<section class="card"><h2>Pretend DMDC answered</h2><p>Muster makes up a results file for the example’s 68 records - <b>Example results (made-up layout for this demo)</b> - and reads it the way it reads yours.</p><div class="btns"><button class="btn big" type="button" data-act="pretend">Pretend DMDC answered</button></div></section>' : '') +
      '<section class="dropzone" data-drop="results"><p style="margin:0"><b>' + (state.results ? 'Read another results file for batch ' + esc(b.id) : 'Drop the results file for batch ' + esc(b.id)) + '</b></p><p class="small muted" style="margin:0">A CSV with headers, or a fixed-width file you map with a ruler. Any SSN, date-of-birth or name column is ignored and never kept.</p><label class="btn ghost filepick">Choose the results file<input type="file" data-file="results" accept=".csv,.tsv,.txt,.dat,text/csv,text/plain"></label></section>' +
      (other.length ? '<section class="card"><h2>Other batches on this device</h2><ul class="batchlist">' + other.slice(0, 8).map(batchRowHtml).join('') + '</ul></section>' : '') +
      '</div>';
  }

  /* ---------------- decisions ---------------- */

  var PILL = { eligible: 'p-eligible', notice: 'p-notice', policy: 'p-policy', hand: 'p-hand', applied: 'p-applied', watch: 'p-watch', under: 'p-under', none: 'p-none' };
  function pill(code) { return '<span class="pill ' + PILL[code] + '">' + esc(C.DECISION_MARK[code] + ' ' + C.DECISION_WORD[code]) + '</span>'; }
  function hintCase() { var l = state.decisions ? C.sortDecisions(state.decisions).filter(function (d) { return d.code === 'eligible'; }) : []; return l[0] || null; }
  function timelineHtml(d) {
    var t = today();
    var pts = [d.orig, d.S || d.Rs, d.E, d.R, d.capStart, d.capEnd, d.C, t].filter(C.isDay);
    if (pts.length < 2) return '';
    var lo = pts.reduce(function (a, b) { return a < b ? a : b; }), hi = pts.reduce(function (a, b) { return a > b ? a : b; });
    var span = Math.max(1, C.daysBetween(lo, hi));
    if (d.open) span = Math.round(span * 1.12);
    var at = function (iso) { return (100 * C.daysBetween(lo, iso) / span).toFixed(2) + '%'; };
    var out = '<div class="timeline" aria-hidden="true"><span class="track"></span>';
    if (d.capStart) { var end = d.capEnd || null; out += '<span class="cap' + (end ? '' : ' open') + '" style="left:' + at(d.capStart) + ';width:' + (end ? (100 * C.daysBetween(d.capStart, end) / span).toFixed(2) + '%' : 'calc(100% - ' + at(d.capStart) + ')') + '"></span>'; }
    var ticks = [[d.orig, 'Opened'], [d.S || d.Rs, 'Service'], [t, 'Today'], [d.R || null, 'Left'], [d.capEnd && d.capEnd !== d.R ? d.capEnd : null, 'Cap ends'], [d.C, 'Call-up']].filter(function (x) { return C.isDay(x[0]); });
    // Labels take up to three rows, spaced by how wide the track really is (about 70px a label).
    var main = $('#main'), trackPx = Math.max(240, (main ? main.clientWidth : 800) - 70);
    var gap = Math.max(9, Math.min(45, 7000 / trackPx));
    var rows = [-99, -99, -99];
    ticks.sort(function (a, b) { return a[0] < b[0] ? -1 : 1; }).forEach(function (x) {
      var pct = 100 * C.daysBetween(lo, x[0]) / span;
      var edge = pct < 6 ? ' start' : pct > 94 ? ' end' : '';
      var r = 0;
      while (r < 2 && pct - rows[r] < gap) r++;
      rows[r] = pct;
      out += '<span class="tick' + (x[1] === 'Today' ? ' today' : '') + '" style="left:' + at(x[0]) + '"></span><span class="tl' + edge + (r ? ' r' + r : '') + '" style="left:' + at(x[0]) + '">' + esc(x[1]) + '</span>';
    });
    return out + '</div>';
  }
  function datesHtml(d) {
    var rows = [];
    if (d.orig) rows.push(['Loan opened', nice(d.orig)]);
    if (d.S && !d.R) rows.push(['On active duty since', nice(d.S)]);
    if (d.E && !d.R) rows.push(['Service ends', nice(d.E)]);
    if (d.R) rows.push(['Service', nice(d.Rs || d.S) + ' to ' + nice(d.R)]);
    if (d.capStart) rows.push(['The 6% cap', nice(d.capStart) + ' to ' + (d.capEnd ? nice(d.capEnd) : 'no end yet') + (d.type === 'mortgage' && (d.E || d.R) ? ' (one year after service, a mortgage)' : '')]);
    if (d.askBy) rows.push(['Notice and orders by', nice(d.askBy)]);
    if (d.C) rows.push(['Future call-up', nice(d.C)]);
    if (d.component) rows.push(['Component', d.component]);
    return rows.length ? '<dl class="dates">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>' : '';
  }
  function caseHtml(d, hinted) {
    var open = state.open['c-' + d.crid] || hinted;
    var meta = 'B' + d.b + ' · ' + C.TYPE_WORD[d.type] + (d.rateU !== null ? ' · ' + C.rateText(d.rateU) : '') + (d.bal !== null ? ' · ' + money(d.bal) : '') + ' · ' + d.crid;
    var body = '';
    if (open) {
      body = '<div class="cbody"><p>' + esc(d.sentence) + '</p>' +
        d.notes.map(function (n) { return '<p class="notes">' + esc(n) + '</p>'; }).join('') +
        timelineHtml(d) + datesHtml(d) +
        (d.est ? '<div class="mathbox"><p class="lab">The 6% math - an estimate</p>' + d.est.math.map(function (m) { return '<p' + (/^Owed so far/.test(m) ? ' class="total"' : '') + '>' + esc(m) + '</p>'; }).join('') + '<p class="small muted">' + esc(C.ESTIMATE) + ' It uses today’s balance for the whole period and UTC day counts.</p></div>' : '') +
        (d.rules.length ? '<div><p class="lab">The rules it rests on (' + esc(C.CITATION) + ')</p><ul class="rules">' + d.rules.map(function (k) { return '<li>' + esc(C.RULES[k]) + '</li>'; }).join('') + '</ul></div>' : '') +
        '<div class="btns">' + (C.TODO[d.code] ? '<button class="btn small" type="button" data-act="towork" data-crid="' + esc(d.crid) + '">Open in the worklist</button>' : '') + (C.LETTER_CODES[d.code] ? '<button class="btn small ghost" type="button" data-act="letterfor" data-crid="' + esc(d.crid) + '">Write the letter</button>' : '') + '</div></div>';
    }
    return '<li class="case c-' + d.code + (hinted ? ' hinted' : '') + '" id="c-' + esc(d.crid) + '"><button class="chead" type="button" data-act="toggle" data-key="c-' + esc(d.crid) + '" aria-expanded="' + (open ? 'true' : 'false') + '"><span class="ct">' + pill(d.code) + '<b>' + esc(d.loan) + '</b></span><span class="amt">' + (d.est && (d.code === 'eligible' || d.code === 'notice') ? 'est. ' + esc(money(d.est.owed)) : '') + '</span><span class="cm">' + esc(meta) + '</span></button>' + body + '</li>';
  }
  function decisionsHtml() {
    if (!state.decisions) return '<div class="stack">' + batchStrip() + '<section class="card"><h2>No results yet</h2><p class="muted">Read the results file for batch ' + esc(state.batch.id) + ' and every case is decided here.</p><div class="btns"><button class="btn" type="button" data-act="tab" data-tab="results">Results →</button></div></section></div>';
    var t = C.totals(state.batch, state.decisions);
    var sorted = C.sortDecisions(state.decisions);
    var hint = !state.device.hint || state.demo ? hintCase() : null;
    var f = state.filter;
    var list = sorted.filter(function (d) { return f === 'all' ? true : f === 'todo' ? C.TODO[d.code] : d.code === f; });
    var none = f === 'todo' ? sorted.filter(function (d) { return !C.TODO[d.code]; }) : [];
    var chips = [['todo', 'Need a person', t.todo]].concat(C.DECISIONS.filter(function (k) { return t.by[k]; }).map(function (k) { return [k, C.DECISION_WORD[k], t.by[k]]; })).concat([['all', 'All', t.records]]);
    return '<div class="stack">' + demoStrip('Step 5 of 5: every record decided, with the rule it rests on and the 6% math.') + batchStrip() +
      '<section class="kpis">' +
        '<div class="kpi"><span class="k">Records checked</span><span class="v">' + esc(groups(t.records)) + '</span><span class="s">' + esc('on ' + plural(t.loans, 'loan')) + '</span></div>' +
        '<div class="kpi"><span class="k">On active duty</span><span class="v">' + esc(groups(t.active)) + '</span><span class="s">' + esc(groups(t.released) + ' left in 367 days · ' + groups(t.watch) + ' call-up') + '</span></div>' +
        '<div class="kpi hi"><span class="k">Eligible</span><span class="v">' + esc(groups(t.eligible)) + '</span><span class="s">' + esc(t.notice ? groups(t.notice) + ' awaiting notice' : 'for the 6% cap') + '</span></div>' +
        '<div class="kpi"><span class="k">Est. owed so far</span><span class="v">' + esc(money(t.owed)) + '</span><span class="s">interest above 6%</span></div>' +
        '<div class="kpi"><span class="k">Est. monthly drop</span><span class="v">' + esc(money(t.monthly)) + '</span><span class="s">while capped</span></div>' +
      '</section>' +
      '<section class="card"><div class="sec-head"><h2>Your policy</h2><span class="small muted">Changes the decisions at once, and is logged</span></div>' +
        '<label class="radio"><input type="radio" name="policy" data-set="policy" value="proactive"' + (state.settings.policy !== 'notice' ? ' checked' : '') + '><span><b>Apply on a DMDC match without waiting for the borrower’s request</b><small>Proactive: eligible loans are capped now</small></span></label>' +
        '<label class="radio"><input type="radio" name="policy" data-set="policy" value="notice"' + (state.settings.policy === 'notice' ? ' checked' : '') + '><span><b>Wait for written notice and orders</b><small>Eligible loans become “Tell the borrower - awaiting notice”</small></span></label></section>' +
      (hint ? '<div class="hint" role="note"><span class="ico" aria-hidden="true">👉</span><div><p><b>Start here.</b> ' + esc(hint.loan + ' is the biggest eligible case: ' + C.TYPE_NOUN[hint.type] + ' at ' + C.rateText(hint.rateU) + ', est. ' + money(hint.est.owed) + ' owed.') + ' It is open below with the rule it rests on, the cap’s dates and the 6% math, line by line.</p><div class="btns"><button class="btn small" type="button" data-act="towork" data-crid="' + esc(hint.crid) + '">Work it in the worklist</button><button class="btn small ghost" type="button" data-act="hintok">Got it</button></div></div></div>' : '') +
      '<div class="filters" role="group" aria-label="Show">' + chips.map(function (c) { return '<button type="button" data-act="filter" data-f="' + esc(c[0]) + '" aria-pressed="' + (f === c[0]) + '">' + esc(c[1]) + ' <b>' + esc(groups(c[2])) + '</b></button>'; }).join('') + '</div>' +
      (list.length ? '<ul class="cases">' + list.slice(0, 400).map(function (d) { return caseHtml(d, hint && d.crid === hint.crid); }).join('') + '</ul>' : '<section class="card"><p class="muted">Nothing here.</p></section>') +
      (list.length > 400 ? '<p class="more">' + esc('The first 400 of ' + groups(list.length) + ' are shown; every one is in the exam pack CSV.') + '</p>' : '') +
      (none.length ? '<section class="card"><button class="link-btn" type="button" data-act="filter" data-f="all">' + esc('Show the ' + plural(none.length, 'record') + ' that need nothing') + '</button><span class="small muted"> - not on active duty, not released in 367 days, no call-up, or already at 6% or under.</span></section>' : '') +
      '<p class="quiet">' + esc(C.ESTIMATE + ' ' + C.NOT_ADVICE) + '</p></div>';
  }

  /* ---------------- the worklist ---------------- */

  function stepRowHtml(d, c, s) {
    var val = c[s.key];
    var on = s.key === 'done' ? c.done : Boolean(val);
    var dateIn = s.date ? '<label class="stepdate"><span class="sr">' + esc(s.label) + ' on</span><input class="input" type="date" data-step="' + s.key + '" data-crid="' + esc(d.crid) + '" data-part="date" value="' + esc(val || '') + '" max="' + esc(today()) + '"></label>' : '';
    var amt = s.amount ? '<label class="stepamt"><span class="sr">Amount</span><input class="input" type="text" inputmode="decimal" data-step="refund" data-crid="' + esc(d.crid) + '" data-part="amount" placeholder="' + esc(d.est ? C.plainMoney(d.est.owed) : '0.00') + '" value="' + esc(c.refundCents === null || c.refundCents === undefined ? '' : C.plainMoney(c.refundCents)) + '"></label>' : '';
    var note = s.key === 'rate' && d.R && d.type !== 'mortgage' ? ' <small class="muted">(service has ended - only the back interest)</small>' : s.key === 'refund' && d.est ? ' <small class="muted">est. ' + esc(money(d.est.owed)) + '</small>' : '';
    return '<li' + (on ? ' class="done"' : '') + '><label class="check"><input type="checkbox" data-step="' + s.key + '" data-crid="' + esc(d.crid) + '" data-part="on"' + (on ? ' checked' : '') + '>' + esc(s.label) + note + '</label>' + dateIn + amt + '</li>';
  }
  var STEP_WORD = { rate: 'rate', refund: 'refund', letter: 'letter', done: 'mark done', outcome: 'decide the outcome' };
  function workCardHtml(w, i, list) {
    var d = w.d, c = w.c;
    var started = Boolean(c.rate || c.refund || c.letter || c.outcome || c.note || c.done);
    var firstOpen = list ? list.filter(function (x) { return !x.c.done; })[0] : null;
    var open = state.open['w-' + d.crid] !== undefined ? state.open['w-' + d.crid] : (started && !c.done) || (firstOpen && firstOpen.d.crid === d.crid);
    if (!c.done && !open) return '<li class="case c-' + d.code + '" id="w-' + esc(d.crid) + '"><button class="chead" type="button" data-act="toggle" data-key="w-' + esc(d.crid) + '" aria-expanded="false"><span class="ct">' + pill(d.code) + '<b>' + esc(d.loan) + '</b></span><span class="amt">' + (d.est && d.est.owed ? 'est. ' + esc(money(d.est.owed)) : '') + '</span><span class="cm">' + esc('B' + d.b + ' · ' + C.TYPE_WORD[d.type] + (d.rateU !== null ? ' · ' + C.rateText(d.rateU) : '') + ' · next: ' + w.left.map(function (k) { return STEP_WORD[k] || k; }).join(', ')) + ' ▸</span></button></li>';
    var needsOutcome = (d.code === 'policy' || d.code === 'hand');
    var steps = d.code === 'watch' || d.code === 'applied' ? C.STEPS.filter(function (s) { return s.key === 'done'; }) : C.STEPS;
    var showSteps = !needsOutcome || c.outcome === 'apply';
    var lead = d.code === 'watch' ? 'Check again ' + (d.C ? 'on ' + nice(d.C) : 'when the orders start') + ' - it is on the re-check list.' : d.code === 'applied' ? 'Confirm the dates against the orders, then mark it done.' : d.code === 'notice' ? 'Send the letter inviting notice and orders; apply the cap when they arrive.' : d.code === 'hand' ? 'Look this borrower up by hand on DMDC’s SCRA website, then decide.' : d.code === 'policy' ? 'The statute does not require this one - decide under your policy.' : 'Reduce the rate, credit what is owed, send the letter.';
    if (c.done && !state.open['w-' + d.crid]) return '<li class="case c-' + d.code + '" id="w-' + esc(d.crid) + '"><button class="chead" type="button" data-act="toggle" data-key="w-' + esc(d.crid) + '" aria-expanded="false"><span class="ct">' + pill(d.code) + '<b>' + esc(d.loan) + '</b><span class="pill p-ok">✓ Done</span></span><span class="amt">' + (c.refundCents ? esc(money(c.refundCents)) + ' credited' : '') + '</span><span class="cm">' + esc('B' + d.b + ' · ' + C.TYPE_WORD[d.type] + (c.rate ? ' · rate reduced ' + nice(c.rate) : '') + (c.letter ? ' · letter ' + nice(c.letter) : '') + (c.by ? ' · by ' + c.by : '')) + '</span></button></li>';
    return '<li class="case c-' + d.code + '" id="w-' + esc(d.crid) + '"><div class="chead" style="cursor:default"><span class="ct">' + pill(d.code) + '<b>' + esc(d.loan) + '</b>' + (c.done ? '<span class="pill p-ok">Done</span>' : '') + '</span><span class="amt">' + (d.est && d.est.owed ? 'est. ' + esc(money(d.est.owed)) : '') + '</span><span class="cm">' + esc('B' + d.b + ' · ' + C.TYPE_WORD[d.type] + (d.rateU !== null ? ' · ' + C.rateText(d.rateU) : '') + ' · ' + lead) + '</span></div>' +
      '<div class="cbody">' +
      (needsOutcome ? '<label class="field"><span>Outcome</span><select class="input" data-outcome="' + esc(d.crid) + '"><option value="">Choose…</option>' + Object.keys(C.OUTCOMES).map(function (k) { return '<option value="' + k + '"' + (c.outcome === k ? ' selected' : '') + '>' + esc(C.OUTCOMES[k]) + '</option>'; }).join('') + '</select></label>' : '') +
      (showSteps ? '<ul class="steplist">' + steps.map(function (s) { return stepRowHtml(d, c, s); }).join('') + '</ul>' : (c.outcome === 'skip' ? '<ul class="steplist">' + stepRowHtml(d, c, C.STEPS[3]) + '</ul>' : '')) +
      '<div class="formgrid"><label class="field"><span>Note</span><textarea class="input" rows="2" maxlength="' + C.LIMITS.noteChars + '" data-note="' + esc(d.crid) + '" placeholder="What was done, and why - never an SSN, a date of birth or a name">' + esc(c.note) + '</textarea></label>' +
      '<label class="field"><span>Decided by</span><input class="input" type="text" maxlength="' + C.LIMITS.initialsChars + '" autocomplete="off" data-by="' + esc(d.crid) + '" placeholder="Initials" value="' + esc(c.by || state.device.initials) + '"><small>' + esc(c.changed ? 'Last change ' + stamp(c.changed) : 'Every change goes in the audit log') + '</small></label></div>' +
      '<div class="btns"><button class="btn small ghost" type="button" data-act="seecase" data-crid="' + esc(d.crid) + '">The decision and the math</button>' + (C.LETTER_CODES[d.code] ? '<button class="btn small ghost" type="button" data-act="letterfor" data-crid="' + esc(d.crid) + '">Write the letter</button>' : '') + '</div>' +
      '</div></li>';
  }
  function chainHtml() {
    var ch = state.chain;
    if (!ch) return '<div class="verified" style="background:var(--card2);color:var(--muted)">Checking the chain…</div>';
    if (ch.ok) return '<div class="verified" role="status">✓ Log verified - ' + esc(plural(ch.n, 'event')) + ', each SHA-256-chained to the one before</div>';
    return '<div class="verified bad" role="alert">✗ Broken: ' + esc(ch.broken && ch.broken.why) + ' The ' + esc(plural(ch.verified || 0, 'event')) + ' before it check out.</div>';
  }
  function eventsHtml(limit) {
    var evs = (state.audit || []).slice().reverse().slice(0, limit || 30);
    return '<ul class="events">' + evs.map(function (e) { return '<li><span class="seq">#' + esc(String(e.seq)) + '</span><span class="ed">' + esc(C.describeEvent(e)) + ' · ' + esc(stamp(e.at)) + '</span><span class="eh">' + esc(e.hash.slice(0, 24) + '… ← ' + e.prev.slice(0, 12) + '…') + '</span></li>'; }).join('') + '</ul>';
  }
  function workHtml() {
    if (!state.decisions) return decisionsHtml();
    var list = C.worklist(state.decisions, state.work);
    var done = list.filter(function (w) { return w.c.done; }).length;
    var rc = C.recheckList(state.decisions);
    return '<div class="stack">' + demoStrip('The worklist: tick each step as it happens - every change is appended to a SHA-256-chained audit log.') + batchStrip() +
      '<section class="card"><div class="sec-head"><h2>' + esc(plural(list.length, 'case')) + ' need a person</h2><span class="small muted">' + esc(groups(done) + ' done') + '</span></div><div class="progress" aria-hidden="true"><i style="width:' + (list.length ? Math.round(100 * done / list.length) : 0) + '%"></i></div>' +
      '<label class="field" style="max-width:280px;margin-top:12px"><span>Your initials</span><input class="input" type="text" maxlength="' + C.LIMITS.initialsChars + '" autocomplete="off" data-set="initials" value="' + esc(state.device.initials) + '" placeholder="e.g. EM"><small>Kept on this device; every change carries them.</small></label></section>' +
      (list.length ? '<ul class="cases">' + list.map(function (w, i) { return workCardHtml(w, i, list); }).join('') + '</ul>' : '<section class="card"><p class="okline">✓ Nothing needs a person in this batch.</p></section>') +
      '<section class="card"><div class="sec-head"><h2>Audit log</h2><span class="small muted">Append-only · nothing in it is an SSN, a date of birth or a name</span></div><div data-chain>' + chainHtml() + '</div>' + eventsHtml(30) +
        '<div class="btns" style="margin-top:10px"><button class="btn small ghost" type="button" data-act="dlaudit">Download the audit log (JSON)</button><button class="btn small ghost" type="button" data-act="verify">Check the chain again</button></div></section>' +
      '<section class="card"><div class="sec-head"><h2>Re-check list</h2><span class="small muted">Future call-ups, recent releases and open-ended caps</span></div>' +
        (rc.length ? '<div class="tablewrap" tabindex="0"><table class="plain"><thead><tr><th>Loan</th><th>Borrower</th><th>Why</th></tr></thead><tbody>' + rc.map(function (x) { return '<tr><td>' + esc(x.loan) + '</td><td>B' + esc(String(x.b)) + '</td><td>' + esc(x.why) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
          '<p class="small muted" style="margin:8px 0">A re-check file needs the portfolio export again - Muster never saved the SSNs.</p><div class="btns"><button class="btn small" type="button" data-act="recheck">Build a re-check file</button></div>' : '<p class="muted" style="margin:0">Nothing to check again.</p>') +
      '</section></div>';
  }

  /* ---------------- the exam pack and the letter ---------------- */

  function letterCases() { return state.decisions ? C.sortDecisions(state.decisions).filter(function (d) { return C.LETTER_CODES[d.code]; }) : []; }
  function letterPeople(d) {
    var L = state.settings.letter, p = state.letter.person;
    return { borrower_name: p && p.borrower_name, loan_number: d.loan, servicer_name: L.servicer || (state.demo ? D.LENDER : ''), contact_line: L.contact || (state.demo ? D.CONTACT : '') };
  }
  function fillTemplate(d) { return C.fillLetter(state.settings.letter.template, C.letterFacts(d, today()), letterPeople(d)); }
  function pickLetter(crid) {
    var d = decisionOf(crid) || letterCases()[0];
    if (!d) return Promise.resolve();
    state.letter.crid = d.crid; state.letter.edited = false; state.letter.source = 'template'; state.letter.person = null;
    return engine.run('person', { loan: d.loan, b: d.b }).then(function (p) { state.letter.person = p; }, function () { state.letter.person = null; }).then(function () {
      state.letter.text = fillTemplate(d).text;
    });
  }
  function summaryHtml() {
    var t = C.totals(state.batch, state.decisions);
    var cases = (state.work && state.work.cases) || {};
    var applied = state.decisions.filter(function (d) { var c = cases[d.crid]; return c && c.rate; }).length;
    var med = C.medianToRate(state.work || {});
    return '<p class="anywhere">' + esc('Checked ' + plural(t.records, 'borrower') + ' on ' + plural(t.loans, 'loan') + ' on ' + nice(state.batch.statusDate) + '. ' + plural(t.active, 'was', 'were') + ' on active duty, ' + groups(t.released) + ' left active duty in the 367 days before it and ' + groups(t.watch) + ' had a future call-up. ' + plural(t.eligible, 'case') + ' eligible, est. ' + money(t.owed) + ' owed so far and ' + money(t.monthly) + ' a month off payments. ' + groups(applied) + ' applied (rate reduced)' + (med !== null ? ', median ' + plural(med, 'day') + ' from match to rate change' : '') + '.') + '</p>' +
      '<div class="tablewrap" tabindex="0"><table class="plain"><thead><tr><th>Decision</th><th class="r">Cases</th></tr></thead><tbody>' + C.DECISIONS.filter(function (k) { return t.by[k]; }).map(function (k) { return '<tr><td>' + pill(k) + '</td><td class="r">' + esc(groups(t.by[k])) + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }
  function packHtml() {
    if (!state.decisions) return decisionsHtml();
    var lc = letterCases();
    if (lc.length && !state.letter.crid) { pickLetter(lc[0].crid).then(function () { if (state.view === 'pack') keepPlace(draw); }); }
    var d = decisionOf(state.letter.crid);
    var L = state.settings.letter;
    var letter = lc.length ? '<section class="card" id="letter"><div class="sec-head"><h2>Borrower letter</h2><span class="small muted">Free - a plain template filled on this device</span></div>' +
      '<div class="formgrid"><label class="field"><span>For</span><select class="input" data-letter="crid">' + lc.map(function (x) { return '<option value="' + esc(x.crid) + '"' + (d && x.crid === d.crid ? ' selected' : '') + '>' + esc(x.loan + ' · B' + x.b + ' · ' + C.DECISION_WORD[x.code]) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Servicer name</span><input class="input" type="text" maxlength="' + C.LIMITS.servicerChars + '" data-letterset="servicer" value="' + esc(L.servicer) + '" placeholder="' + esc(state.demo ? D.LENDER : 'Your institution') + '"></label>' +
      '<label class="field"><span>Contact line</span><input class="input" type="text" maxlength="' + C.LIMITS.contactChars + '" data-letterset="contact" value="' + esc(L.contact) + '" placeholder="' + esc(state.demo ? D.CONTACT : 'Member Services, the phone number, the hours') + '"><small>A phone number or a desk, not an email address (settings never hold an @).</small></label>' +
      '<div class="field"><span>Name and loan number</span><p class="small muted" style="margin:0">' + (state.letter.person ? '✓ Filled from the portfolio still open in this page - never saved.' : 'Loan number from the batch. The name stays a placeholder: the portfolio is not open in this page (load it again to fill it).') + '</p></div></div>' +
      '<label class="field" style="margin-top:12px"><span>The letter' + (state.letter.source === 'ai' ? ' - AI draft, filled on this device' : '') + '</span><textarea class="input letterbox" data-letter="text" rows="16">' + esc(state.letter.text) + '</textarea></label>' +
      '<div class="btns" style="margin-top:10px"><button class="btn" type="button" data-act="printletter">Print</button><button class="btn ghost" type="button" data-act="copyletter">Copy</button><button class="btn ghost" type="button" data-act="refill">Fill from the template again</button><button class="btn ghost" type="button" data-act="ailetter">✨ Draft it in plain words</button></div>' +
      '<p class="quiet" style="margin-top:8px">The template is in Settings. ' + esc(C.NOT_ADVICE) + '</p></section>' : '';
    return '<div class="stack">' + demoStrip('The exam pack: everything an examiner asks for, made on this device.') + batchStrip() +
      '<section class="card"><div class="sec-head"><h2>Summary</h2><div data-chain>' + chainHtml() + '</div></div>' + summaryHtml() +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="dlsummary">Download the summary (Markdown)</button><button class="btn ghost" type="button" data-act="copysummary">Copy</button></div></section>' +
      '<section class="grid4" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))">' +
        '<div class="card excard"><h2>Every loan and result</h2><p class="small muted">One row per loan per result - the decision, the rule, the dates, the estimate and every step. Formula-safe CSV.</p><label class="check"><input type="checkbox" data-set="exportMask"' + (state.exportMask ? ' checked' : '') + '>Mask loan ids (••••0112)</label><button class="btn" type="button" data-act="dlcsv">Download the CSV</button></div>' +
        '<div class="card excard"><h2>The audit log</h2><p class="small muted">Every event with its SHA-256 and the hash it points back to, and how to check them.</p><button class="btn" type="button" data-act="dlaudit">Download the log (JSON)</button></div>' +
        '<div class="card excard"><h2>The batch record</h2><p class="small muted">To carry this batch to another device: the record, the results and the log. No SSN, date of birth or name.</p><button class="btn" type="button" data-act="dlbatch">Download the batch</button></div>' +
      '</section>' + letter +
      '<p class="quiet">' + esc(C.ESTIMATE + ' ' + C.NOT_ADVICE) + '</p></div>';
  }

  /* ---------------- settings ---------------- */

  function settingsHtml() {
    var s = state.settings;
    var rp = s.presets;
    return '<div class="stack"><section class="card"><h1 style="font-size:1.5rem">Settings</h1><p class="small" data-sync>' + syncLine() + '</p></section>' +
      '<section class="card"><h2>Policy</h2>' +
        '<label class="radio"><input type="radio" name="spolicy" data-set="policy" value="proactive"' + (s.policy !== 'notice' ? ' checked' : '') + '><span><b>Apply on a DMDC match without waiting for the borrower’s request</b><small>The default</small></span></label>' +
        '<label class="radio"><input type="radio" name="spolicy" data-set="policy" value="notice"' + (s.policy === 'notice' ? ' checked' : '') + '><span><b>Wait for written notice and orders</b><small>Eligible loans show “Tell the borrower - awaiting notice”</small></span></label></section>' +
      '<section class="card"><h2>The request file</h2><div class="formgrid">' +
        '<div class="field"><span>Customer record ID</span><label class="radio"><input type="radio" name="scrid" data-set="cridMode" value="loan"' + (s.cridMode !== 'short' ? ' checked' : '') + '><span><b>The loan id, cleaned, plus B1 / B2</b></span></label><label class="radio"><input type="radio" name="scrid" data-set="cridMode" value="short"' + (s.cridMode === 'short' ? ' checked' : '') + '><span><b>A short code from Muster</b><small>No loan numbers in the file</small></span></label></div>' +
        '<div class="field"><span>Line endings</span><div class="seg" role="group" aria-label="Line endings"><button type="button" data-act="set" data-key="lineEnding" data-val="crlf" aria-pressed="' + (s.lineEnding !== 'lf') + '">CRLF</button><button type="button" data-act="set" data-key="lineEnding" data-val="lf" aria-pressed="' + (s.lineEnding === 'lf') + '">LF</button></div></div>' +
        '<label class="field"><span>Records per file</span><select class="input" data-set="split">' + [0, 1000, 5000, 10000, 25000, 50000].map(function (n) { return '<option value="' + n + '"' + (Number(s.split) === n ? ' selected' : '') + '>' + (n ? 'Split every ' + groups(n) : 'One file') + '</option>'; }).join('') + '</select></label></div></section>' +
      layoutTableHtml('settings') +
      '<section class="card"><h2>My results layout</h2>' + (s.resultsSpans.length ? '<ul class="spanlist">' + s.resultsSpans.map(function (x) { return '<li><span><b>' + esc(rfield(x.field).label) + '</b> · positions ' + esc(x.start + '-' + (x.start + x.len - 1)) + '</span></li>'; }).join('') + '</ul><div class="btns" style="margin-top:10px"><button class="btn small ghost" type="button" data-act="clearspans">Clear it</button></div>' : '<p class="muted" style="margin:0">None yet - it is saved the first time you map a fixed-width results file with the ruler.</p>') + '</section>' +
      '<section class="card"><h2>Column presets</h2>' + (rp.length ? '<ul class="spanlist">' + rp.map(function (p, i) { return '<li><span><b>' + esc(p.name) + '</b> · ' + esc((p.kind === 'portfolio' ? 'portfolio' : 'results') + ' · ' + plural(Object.keys(p.map).length, 'column')) + '</span><button class="btn small ghost" type="button" data-act="rmpreset" data-i="' + i + '">Remove</button></li>'; }).join('') + '</ul>' : '<p class="muted" style="margin:0">None yet. A preset keeps the header names a team’s export uses - never a value - so the next file maps at once.</p>') + '</section>' +
      '<section class="card"><h2>The borrower letter</h2><div class="formgrid">' +
        '<label class="field"><span>Servicer name</span><input class="input" type="text" maxlength="' + C.LIMITS.servicerChars + '" data-letterset="servicer" value="' + esc(s.letter.servicer) + '"></label>' +
        '<label class="field"><span>Contact line</span><input class="input" type="text" maxlength="' + C.LIMITS.contactChars + '" data-letterset="contact" value="' + esc(s.letter.contact) + '"><small>No email address - settings never hold an @.</small></label></div>' +
        '<label class="field" style="margin-top:12px"><span>Template</span><textarea class="input mono" rows="14" maxlength="' + C.LIMITS.templateChars + '" data-letterset="template">' + esc(s.letter.template) + '</textarea><small>Filled on the device: ' + esc(C.PEOPLE_PLACEHOLDERS.concat(C.FACT_PLACEHOLDERS).map(function (p) { return '{{' + p + '}}'; }).join(' ')) + '</small></label>' +
        '<div class="btns" style="margin-top:10px"><button class="btn small ghost" type="button" data-act="resettemplate">Reset the template</button></div></section>' +
      '<section class="card"><h2>On this device</h2><p class="small muted">' + esc(real.persistent() ? 'Batches, results and audit logs are kept in this browser’s storage - never an SSN, a date of birth or a name.' : 'This browser will not keep anything (a private window?) - download each batch to keep it.') + '</p>' +
        (state.batches.filter(function (b) { return !b.demo; }).length ? '<ul class="batchlist">' + state.batches.filter(function (b) { return !b.demo; }).map(function (b) { return '<li><div><div class="bn">Batch ' + esc(b.id) + ' · ' + esc(nice(b.statusDate)) + '</div><div class="bm">' + esc(plural(b.count, 'record') + ' · built ' + stamp(b.createdAt)) + '</div></div><span class="btns"><button class="btn small ghost" type="button" data-act="openbatch" data-id="' + esc(b.id) + '">Open</button><button class="btn small danger" type="button" data-act="delbatch" data-id="' + esc(b.id) + '">Delete</button></span></li>'; }).join('') + '</ul>' : '<p class="muted">No saved batches.</p>') +
        '<div class="btns" style="margin-top:10px"><label class="btn small ghost filepick">Load a batch file<input type="file" data-file="batch" accept=".json,application/json"></label><button class="btn small danger" type="button" data-act="clearall">Clear everything Muster keeps here</button></div></section>' +
      '</div>';
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    clearTimeout(toastTimer);
    $$('.toast').forEach(function (t) { t.remove(); });
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

  function openPreset(kind) {
    var map = {}, skipped = 0;
    if (kind === 'portfolio') { map = C.presetFrom(state.pf.headers, state.pf.map); skipped = C.PKEYS.filter(function (k) { return state.pf.map[k] !== null && state.pf.map[k] !== undefined; }).length - Object.keys(map).length; }
    else C.RKEYS.forEach(function (k) { var i = state.res.map[k]; if (i === null || i === undefined) return; if (C.headerOk(state.res.headers[i])) map[k] = state.res.headers[i]; else skipped++; });
    sheet('<h2>Save these columns as a preset</h2><p class="muted small">Keeps the header NAMES - never a value - so the next file with the same headers is mapped at once. ' + (signedIn() ? 'It follows your account.' : 'Sign in and it follows your account too.') + '</p>' +
      '<label class="field"><span>Name</span><input class="input" id="presetName" maxlength="40" placeholder="' + (kind === 'portfolio' ? 'Core loan export' : 'DMDC results') + '" autocomplete="off"></label>' +
      (skipped ? '<p class="small">' + esc(plural(skipped, 'header') + ' looked like a value and will not be saved.') + '</p>' : '') +
      '<div id="presetErr"></div><div class="btns" style="margin-top:10px"><button class="btn" type="button" id="presetSave">Save the preset</button></div>', function (root) {
      $('#presetSave', root).addEventListener('click', function () {
        var name = C.line($('#presetName', root).value, 40);
        var chk = C.cleanSettings({ presets: [{ name: name, kind: kind, map: map }] }, true);
        if (chk.errors.length || !name) { $('#presetErr', root).innerHTML = '<p class="err">' + esc(chk.errors[0] || 'Give it a name.') + '</p>'; return; }
        var s = state.settings;
        s.presets = s.presets.filter(function (p) { return !(p.kind === kind && p.name.toLowerCase() === name.toLowerCase()); });
        s.presets.push(chk.settings.presets[0]);
        if (s.presets.length > C.LIMITS.presets) s.presets.shift();
        settingsChanged();
        closeSheet();
        toast('Saved “' + name + '”.');
      });
    });
  }
  function openAiLetter() {
    var d = decisionOf(state.letter.crid);
    if (!d) return;
    var tone = state.letter.tone;
    var payload = C.letterPayload(d, tone);
    sheet('<h2>✨ Draft the letter in plain words</h2><p class="muted small">For ' + esc(d.loan + ' (' + C.DECISION_WORD[d.code] + ')') + '. Only the decision code, the loan type, the tone, the dates and the estimated amounts are sent - <b>never a name, a loan id, an SSN, a date of birth or anything you typed</b>. The draft comes back with placeholders, and this device fills them.</p>' +
      '<div class="field" style="margin:10px 0"><span>Tone</span><div class="seg" role="group" aria-label="Tone">' + Object.keys(C.TONES).map(function (k) { return '<button type="button" data-tone="' + k + '" aria-pressed="' + (k === tone) + '">' + esc(C.TONES[k]) + '</button>'; }).join('') + '</div></div>' +
      '<p class="lab">Exactly what will be sent</p><pre class="sent-pre" tabindex="0" id="aiSent">' + esc(JSON.stringify(payload, null, 1)) + '</pre>' +
      '<p class="small muted" style="margin:8px 0 0">Muster refuses the draft if it leaves out a placeholder, adds a web address or an email, uses a number or a date that was not sent, or names any law but the Servicemembers Civil Relief Act.</p>' +
      '<div id="aiErr"></div><div class="btns" id="aiActs" style="margin-top:10px"></div>', function (root) {
      $$('[data-tone]', root).forEach(function (b) { b.addEventListener('click', function () { state.letter.tone = b.getAttribute('data-tone'); openAiLetter(); }); });
      var acts = $('#aiActs', root);
      if (!signedIn()) {
        acts.innerHTML = '<p class="small muted" style="width:100%;margin:0">It uses about a cent of AI credit, so it needs a free account - which comes with $2 and works across every app on this site. The template letter is free.</p><button class="btn" type="button" id="aiSignin">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button>';
        $('#aiSignin', root).addEventListener('click', function () { openAccount('The letter helper uses about a cent of AI credit; a free account comes with $2.', openAiLetter); });
        return;
      }
      acts.innerHTML = '<button class="btn" type="button" id="aiSend">Send these facts</button><span class="small muted">About a cent' + (state.me.tier === 'paid' ? ' (member model)' : '') + '. You read and edit the draft before it goes anywhere.</span>';
      $('#aiSend', root).addEventListener('click', function () {
        var b = $('#aiSend', root);
        b.disabled = true; b.textContent = 'Drafting…';
        $('#aiErr', root).innerHTML = '';
        api('POST', 'api/ai/letter', payload).then(function (res) {
          var filled = C.fillLetter((res.subject ? 'Subject: ' + res.subject + '\n\n' : '') + res.letter, C.letterFacts(d, today()), letterPeople(d));
          state.letter.text = filled.text; state.letter.source = 'ai'; state.letter.edited = false;
          closeSheet();
          if (state.view !== 'pack') go('pack'); else keepPlace(draw);
          toast('Drafted - read it before you send it.', 3600);
          loadMe();
        }).catch(function (err) { b.disabled = false; b.textContent = 'Send these facts'; meteredError(err, $('#aiErr', root), openAiLetter, 'The letter helper uses about a cent of AI credit, so it needs a free account (it comes with $2).'); });
      });
    });
  }
  function openRecheck() {
    var rc = C.recheckList(state.decisions || []);
    if (!rc.length) return;
    state.recheck = { from: state.batch.id, only: rc.map(function (x) { return { loan: x.loan, b: x.b }; }) };
    engine.run('has').then(function (h) {
      if (h.portfolio && (h.demo === state.demo)) { state.chk = state.chk || null; state.built = null; state.statusDate = today(); if (!state.chk) return runRowChecks(); go('file'); return null; }
      sheet('<h2>Build a re-check file</h2><p>' + esc(plural(rc.length, 'borrower')) + ' from batch ' + esc(state.batch.id) + '. The file needs their SSNs and dates of birth, and Muster never saved them - <b>drop the same portfolio export again</b>. Only those borrowers go in the new file.</p><label class="btn filepick">Choose the portfolio export<input type="file" data-file="portfolio" accept=".csv,.tsv,.txt,text/csv,text/plain"></label>');
      return null;
    });
  }

  /* ---------------- the account (shared shape with the lab) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }
  var FREE_LINE = 'Checking a portfolio is free with no account, and nothing leaves this device. A free account keeps your layouts and preferences across devices and adds the AI letter helper - it comes with $2 of AI credit, and one account works across every app on this site.';
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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); return syncIn(); }).then(function () { if (then) then(); else keepPlace(draw); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { return syncIn(); }).then(function () { if (then) then(); else keepPlace(draw); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openAccountSheet() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">The letter helper costs about a cent. Reading portfolios, the request file, results, decisions, the worklist and the exam pack are free and never leave this device.</p><div id="billing"></div></div>' +
      '<p class="small" style="margin-top:14px" data-sync>' + syncLine() + '</p>' +
      '<button class="btn ghost block" id="forget" type="button" style="margin-top:6px">Remove my settings from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); keepPlace(draw); }); });
        $('#forget', root).addEventListener('click', function () {
          if (!confirm('Remove your settings from the account? This device keeps its copy.')) return;
          api('DELETE', 'api/settings').then(function () { state.syncBase = null; real.putSyncBase(null); closeSheet(); toast('Removed from the account. This device still has them.'); state.syncState = 'local'; }).catch(function (e) { showError(e); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The template letter, the request file, decisions, the worklist and every export keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }
  function openRules() {
    sheet('<h2>The rules Muster applies</h2><p class="small muted">From ' + esc(C.CITATION) + ', and nothing beyond them. ' + esc(C.NOT_ADVICE) + '</p><ul class="rules">' + Object.keys(C.RULES).map(function (k) { return '<li>' + esc(C.RULES[k]) + '</li>'; }).join('') + '</ul>');
  }

  /* ---------------- exports ---------------- */

  function baseName() { return (state.demo ? 'EXAMPLE-' : '') + 'muster-' + state.batch.id + '-' + C.compact(state.batch.statusDate); }
  function exportBatch() {
    var out = { app: 'muster', kind: 'batch', batch: state.batch, results: state.results ? state.results : null, audit: state.audit };
    download(baseName() + '-batch.json', 'application/json', JSON.stringify(out) + '\n');
    toast('Saved - no SSN, date of birth or name in it.');
  }
  function importBatch(fileObj) {
    if (!fileObj || fileObj.size > C.LIMITS.fileBytes) { toast('That is not a Muster batch file.'); return; }
    fileObj.text().then(function (t) {
      var j = JSON.parse(t);
      if (!j || j.app !== 'muster' || j.kind !== 'batch' || !j.batch) throw new Error('That is not a Muster batch file.');
      return engine.run('guard', { batch: j.batch }).then(function (safe) {
        if (safe.demo) throw new Error('That is the example - it is never saved.');
        var audit = Array.isArray(j.audit) ? j.audit.map(function (e) { return C.safeEvent(e); }) : [];
        return C.verifyAudit(audit, digest).then(function (ch) {
          if (!ch.ok) throw new Error('Its audit log does not verify (' + ch.broken.why + ') - not loaded.');
          return real.putBatch(safe).then(function () {
            return j.results && Array.isArray(j.results.results) ? real.putResults(safe.id, j.results.results, j.results.at, j.results.file) : null;
          }).then(function () { return real.restoreAudit(safe.id, audit, digest); }).then(function () { return refreshBatches(); }).then(function () { toast('Loaded batch ' + safe.id + '.'); return openBatch(safe.id); });
        });
      });
    }).catch(function (e) { toast(e.message || 'That is not a Muster batch file.', 5000); });
  }

  /* ---------------- wiring: one listener per kind of event ---------------- */

  function afterDraw() {
    var h = state.view === 'decisions' ? $('.case.hinted') : null;
    if (h && !state.hintPulsed) { state.hintPulsed = true; h.classList.add('pulse'); }
  }
  function markBuiltStale() { if (state.built && !state.built.hasResults) state.built.stale = true; }
  function layoutChanged() { settingsChanged(); markBuiltStale(); if (state.chk && !C.layoutProblems(state.settings.layout).length) recheckRows(); else keepPlace(draw); }

  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var crid = el.getAttribute('data-crid');
    switch (act) {
      case 'home': e.preventDefault(); go('start'); break;
      case 'tab': go(el.getAttribute('data-tab')); break;
      case 'demo': loadDemo(); break;
      case 'leavedemo': state.demo = false; resetBuild(); closeBatch(); state.recheck = null; go('start'); break;
      case 'cancelrecheck': state.recheck = null; keepPlace(draw); break;
      case 'showmap': state.showMap = true; keepPlace(draw); break;
      case 'preset': openPreset('portfolio'); break;
      case 'rpreset': openPreset('results'); break;
      case 'runchecks': runRowChecks(); break;
      case 'toggle': { var k = el.getAttribute('data-key'); state.open[k] = el.getAttribute('aria-expanded') !== 'true'; keepPlace(draw); break; }
      case 'set': state.settings[el.getAttribute('data-key')] = el.getAttribute('data-val'); settingsChanged(); markBuiltStale(); keepPlace(draw); break;
      case 'resetlayout': state.settings.layout = JSON.parse(JSON.stringify(C.DEFAULT_LAYOUT)); layoutChanged(); toast('Back to Muster’s default layout.'); break;
      case 'build': buildFile(); break;
      case 'dlfile': { var f = state.built && state.built.files[Number(el.getAttribute('data-i'))]; if (f) { download(f.name, 'text/plain', f.text); toast(state.demo ? 'Saved the EXAMPLE file - do not upload it.' : 'Saved - made on this device.', 3600); } break; }
      case 'pretend': if (state.view !== 'results') { go('results'); } pretendResults(); break;
      case 'openbatch': openBatch(el.getAttribute('data-id')); break;
      case 'dropres': state.res = null; keepPlace(draw); break;
      case 'readres': readResults(); break;
      case 'addspan': {
        var r = state.res; if (!r || !r.sel) break;
        var a = Math.min(r.sel.a, r.sel.b), n = Math.abs(r.sel.b - r.sel.a) + 1;
        var next = r.spans.filter(function (s) { return s.field !== r.selField; }).concat([{ field: r.selField, start: a, len: n }]);
        var p = C.spanProblems(next, r.width);
        if (p.length && !/Mark the customer record id/.test(p[0])) { toast(p[0], 4200); break; }
        r.spans = next; r.sel = null;
        var free = C.RKEYS.filter(function (k2) { return !r.spans.some(function (s) { return s.field === k2; }); });
        r.selField = free[0] || 'crid';
        keepPlace(draw); break;
      }
      case 'rmspan': state.res.spans = state.res.spans.filter(function (s) { return s.field !== el.getAttribute('data-field'); }); keepPlace(draw); break;
      case 'filter': state.filter = el.getAttribute('data-f'); keepPlace(draw); break;
      case 'hintok': state.device.hint = true; if (!state.demo) deviceChanged(); keepPlace(draw); break;
      case 'towork': state.open['w-' + crid] = true; go('work'); setTimeout(function () { var w = document.getElementById('w-' + crid); if (w) w.scrollIntoView({ block: 'start' }); }, 30); break;
      case 'seecase': state.filter = 'all'; state.open['c-' + crid] = true; go('decisions'); setTimeout(function () { var c = document.getElementById('c-' + crid); if (c) c.scrollIntoView({ block: 'start' }); }, 30); break;
      case 'letterfor': pickLetter(crid).then(function () { go('pack'); setTimeout(function () { var l = document.getElementById('letter'); if (l) l.scrollIntoView({ block: 'start' }); }, 30); }); break;
      case 'refill': { var d0 = decisionOf(state.letter.crid); if (d0) { state.letter.text = fillTemplate(d0).text; state.letter.source = 'template'; keepPlace(draw); } break; }
      case 'ailetter': openAiLetter(); break;
      case 'printletter': {
        var lp = $('#letterPrint'); lp.textContent = state.letter.text; lp.setAttribute('aria-hidden', 'false');
        document.body.classList.add('print-letter');
        window.print();
        setTimeout(function () { document.body.classList.remove('print-letter'); lp.setAttribute('aria-hidden', 'true'); }, 500);
        break;
      }
      case 'copyletter': copy(state.letter.text, 'Copied the letter.'); break;
      case 'dlsummary': download(baseName() + '-summary.md', 'text/markdown', C.summaryMarkdown(state.batch, state.decisions, state.work, state.chain, { mask: state.exportMask })); toast('Saved - made on this device.'); break;
      case 'copysummary': copy(C.summaryMarkdown(state.batch, state.decisions, state.work, state.chain, { mask: state.exportMask }), 'Copied the summary.'); break;
      case 'dlcsv': download(baseName() + '-cases.csv', 'text/csv', C.examCsv(state.batch, state.decisions, state.work, { mask: state.exportMask })); toast('Saved - made on this device.'); break;
      case 'dlaudit': download(baseName() + '-audit-log.json', 'application/json', C.auditJson(state.batch, state.audit, state.chain)); toast('Saved - made on this device.'); break;
      case 'dlbatch': exportBatch(); break;
      case 'verify': state.chain = null; keepPlace(draw); verifyChain(); break;
      case 'recheck': openRecheck(); break;
      case 'rules': openRules(); break;
      case 'clearspans': state.settings.resultsSpans = []; settingsChanged(); keepPlace(draw); break;
      case 'rmpreset': state.settings.presets.splice(Number(el.getAttribute('data-i')), 1); settingsChanged(); keepPlace(draw); break;
      case 'resettemplate': state.settings.letter.template = C.DEFAULT_TEMPLATE; settingsChanged(); keepPlace(draw); toast('The template is back to Muster’s.'); break;
      case 'delbatch': {
        var id = el.getAttribute('data-id');
        if (!confirm('Delete batch ' + id + ' from this device - its record, results and audit log? Download it first if you need it.')) break;
        real.delBatch(id).then(refreshBatches).then(function () { if (state.batch && state.batch.id === id) closeBatch(); keepPlace(draw); toast('Deleted.'); });
        break;
      }
      case 'clearall':
        if (!confirm('Clear everything Muster keeps on this device - every batch, result and audit log, and your settings here?')) break;
        real.clearAll().then(function () { state.batches = []; if (!state.demo) closeBatch(); state.settings = C.defaults(); state.device = { initials: '', hint: false, results: false }; keepPlace(draw); toast('Cleared from this device.'); });
        break;
      case 'signin': openAccount(); break;
      case 'retrysync': pushSettings(); break;
      case 'closesheet': closeSheet(); break;
      default: break;
    }
  });

  function numberOr(v, d) { var n = Number(v); return Number.isFinite(n) ? n : d; }
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.matches('input[data-file]')) {
      var f = (t.files || [])[0]; var kind = t.getAttribute('data-file'); t.value = '';
      if (!f) return;
      closeSheet(true);
      if (kind === 'results') loadResultsFile(f); else if (kind === 'batch') importBatch(f); else loadFile(f);
      return;
    }
    if (t.hasAttribute('data-pmap')) {
      var k = t.getAttribute('data-pmap'), v = t.value === '' ? null : Number(t.value);
      if (v !== null) C.PKEYS.forEach(function (g) { if (g !== k && state.pf.map[g] === v) { state.pf.map[g] = null; delete state.pf.conf[g]; } });
      state.pf.map[k] = v; if (v === null) delete state.pf.conf[k]; else state.pf.conf[k] = 'you';
      state.chk = null; state.built = null;
      refreshQuestions().then(function () { keepPlace(draw); });
      return;
    }
    if (t.hasAttribute('data-ptype')) { state.pf.typeMap[t.getAttribute('data-ptype')] = t.value; state.chk = null; state.built = null; return; }
    if (t.hasAttribute('data-q')) { var q = t.getAttribute('data-q'); if (q === 'order') state.pf.order = t.value; else state.pf.fraction = t.value === 'yes'; state.chk = null; state.built = null; keepPlace(draw); return; }
    if (t.hasAttribute('data-rmap')) {
      var rk = t.getAttribute('data-rmap'), rv = t.value === '' ? null : Number(t.value);
      if (rv !== null) C.RKEYS.forEach(function (g) { if (g !== rk && state.res.map[g] === rv) state.res.map[g] = null; });
      state.res.map[rk] = rv; keepPlace(draw); return;
    }
    if (t.hasAttribute('data-lay')) {
      var which = t.getAttribute('data-lay'), lay = state.settings.layout;
      if (which === 'lineLength') lay.lineLength = numberOr(t.value, lay.lineLength);
      else lay.fields[which][t.getAttribute('data-part')] = numberOr(t.value, lay.fields[which][t.getAttribute('data-part')]);
      layoutChanged();
      return;
    }
    if (t.hasAttribute('data-sel')) {
      var r = state.res, part = t.getAttribute('data-sel');
      if (part === 'field') { r.selField = t.value; return; }
      var a = part === 'a' ? Math.floor(numberOr(t.value, 1)) : (r.sel ? Math.min(r.sel.a, r.sel.b) : 1);
      var len = part === 'len' ? Math.floor(numberOr(t.value, 1)) : (r.sel ? Math.abs(r.sel.b - r.sel.a) + 1 : 1);
      a = Math.max(1, Math.min(r.width, a)); len = Math.max(1, Math.min(400, len));
      r.sel = { a: a, b: Math.min(r.width, a + len - 1) };
      keepPlace(draw); return;
    }
    if (t.hasAttribute('data-step')) {
      var c = t.getAttribute('data-crid'), step = t.getAttribute('data-step'), what = t.getAttribute('data-part');
      var cur = (state.work && state.work.cases[c]) || {};
      if (step === 'done') { logStep(c, 'done', t.checked); return; }
      var row = t.closest('li');
      var dateEl = row && $('input[data-part="date"]', row), amtEl = row && $('input[data-part="amount"]', row);
      var on = what === 'on' ? t.checked : true;
      var date = on ? ((dateEl && C.isDay(dateEl.value) ? dateEl.value : '') || today()) : null;
      if (what === 'date' && !C.isDay(t.value)) date = null;
      if (step === 'refund') {
        var d = decisionOf(c), cents = amtEl && amtEl.value.trim() ? C.moneyCents(amtEl.value) : (cur.refundCents !== null && cur.refundCents !== undefined ? cur.refundCents : (d && d.est ? d.est.owed : 0));
        if (amtEl && amtEl.value.trim() && cents === null) { toast('That amount could not be read - write it like 241.43.'); return; }
        logStep(c, 'refund', date ? { date: date, cents: cents } : null);
      } else logStep(c, step, date);
      return;
    }
    if (t.hasAttribute('data-outcome')) { logStep(t.getAttribute('data-outcome'), 'outcome', t.value); return; }
    if (t.hasAttribute('data-note')) { logNote(t.getAttribute('data-note'), t.value); return; }
    if (t.hasAttribute('data-by')) { var by = C.initials(t.value); state.device.initials = by; if (!state.demo) deviceChanged(); log({ kind: 'step', crid: t.getAttribute('data-by'), field: 'by', value: by, by: by }); return; }
    if (t.hasAttribute('data-letter')) {
      if (t.getAttribute('data-letter') === 'crid') pickLetter(t.value).then(function () { keepPlace(draw); });
      return;
    }
    if (t.hasAttribute('data-letterset')) {
      var key = t.getAttribute('data-letterset');
      state.settings.letter[key] = key === 'template' ? C.para(t.value, C.LIMITS.templateChars) : C.line(t.value, key === 'servicer' ? C.LIMITS.servicerChars : C.LIMITS.contactChars);
      if (/@/.test(state.settings.letter[key])) { toast('Settings never hold an @ - use a phone number or a desk name.', 4200); state.settings.letter[key] = state.settings.letter[key].replace(/\S*@\S*/g, '').trim(); }
      settingsChanged();
      var d1 = decisionOf(state.letter.crid);
      if (d1 && state.letter.source === 'template' && !state.letter.edited) state.letter.text = fillTemplate(d1).text;
      if (state.view === 'pack') keepPlace(draw);
      return;
    }
    if (t.hasAttribute('data-set')) {
      var s = t.getAttribute('data-set');
      if (s === 'statusDate') { state.statusDate = C.isDay(t.value) && t.value <= today() ? t.value : today(); if (t.value > today()) toast('The status date cannot be in the future.'); keepPlace(draw); return; }
      if (s === 'cridMode') { state.settings.cridMode = t.value === 'short' ? 'short' : 'loan'; settingsChanged(); markBuiltStale(); if (state.chk) recheckRows(); else keepPlace(draw); return; }
      if (s === 'split') { state.settings.split = Number(t.value) || 0; settingsChanged(); markBuiltStale(); keepPlace(draw); return; }
      if (s === 'policy') {
        state.settings.policy = t.value === 'notice' ? 'notice' : 'proactive'; settingsChanged(); recompute();
        if (state.batch && state.results) log({ kind: 'policy', value: state.settings.policy }); else keepPlace(draw);
        return;
      }
      if (s === 'showSsn') {
        state.showSsn = t.checked;
        if (state.res && state.res.mode === 'fixed' && t.checked && !state.res.raw) { engine.run('rawLines').then(function (l) { state.res.raw = l; keepPlace(draw); }); return; }
        keepPlace(draw); return;
      }
      if (s === 'skip') { state.res.skip = Math.max(0, Math.min(5, Math.floor(numberOr(t.value, 0)))); keepPlace(draw); return; }
      if (s === 'exportMask') { state.exportMask = t.checked; return; }
      if (s === 'initials') { state.device.initials = C.initials(t.value); if (!state.demo) deviceChanged(); return; }
    }
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-letter') === 'text') { state.letter.text = t.value; state.letter.edited = true; }
  });

  // The results ruler: drag across it, or tap the first position and then the last.
  var drag = null;
  function posAt(x, y) { var el = document.elementFromPoint(x, y); var c = el && el.closest && el.closest('.rc'); return c ? Number(c.getAttribute('data-pos')) : null; }
  function paintSel() {
    var r = state.res; if (!r) return;
    var a = r.sel ? Math.min(r.sel.a, r.sel.b) : 0, b = r.sel ? Math.max(r.sel.a, r.sel.b) : -1;
    $$('.ruler .rc').forEach(function (c) { var p = Number(c.getAttribute('data-pos')); c.classList.toggle('on', p >= a && p <= b); });
  }
  document.addEventListener('pointerdown', function (e) {
    var c = e.target.closest && e.target.closest('.ruler .rc');
    if (!c || !state.res) return;
    e.preventDefault();
    var p = Number(c.getAttribute('data-pos'));
    var r = state.res;
    if (r.sel && r.sel.tap && r.sel.a === r.sel.b && p !== r.sel.a) { r.sel = { a: r.sel.a, b: p }; drag = null; keepPlace(draw); return; }
    r.sel = { a: p, b: p, tap: true };
    drag = { id: e.pointerId, moved: false };
    paintSel();
  });
  document.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id || !state.res) return;
    // Near the edge of the box, scroll it along, so a phone can mark a span wider than the screen.
    var box = $('.fw:has(.ruler)');
    if (box) { var r = box.getBoundingClientRect(); if (e.clientX > r.right - 28) box.scrollLeft += 14; else if (e.clientX < r.left + 28) box.scrollLeft -= 14; }
    var p = posAt(e.clientX, e.clientY);
    if (p && p !== state.res.sel.b) { state.res.sel.b = p; state.res.sel.tap = false; drag.moved = true; paintSel(); }
  });
  document.addEventListener('pointerup', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    keepPlace(draw);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) { closeSheet(); }
  });
  window.addEventListener('popstate', route);

  // Drop a file anywhere on the page: results on the results step, a portfolio anywhere else.
  var dragDepth = 0;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
  document.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; dragDepth++; $('#dropcover').hidden = false; });
  document.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropcover').hidden = true; });
  document.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('#dropcover').hidden = true;
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (state.view === 'results' && state.batch) loadResultsFile(f);
    else if (/\.json$/i.test(f.name)) importBatch(f);
    else loadFile(f);
  });

  /* ---------------- start ---------------- */

  function markOffline() { var pill2 = $('#offlinePill'); if (pill2) pill2.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  drawTop();
  state.pendingId = newBatchId(); state.statusDate = today();
  Promise.all([real.getSettings(), real.getDevice(), real.getSyncBase(), refreshBatches()]).then(function (r) {
    if (r[0]) state.settings = r[0];
    if (r[1]) state.device = r[1];
    state.syncBase = r[2];
  }).catch(function () { /* fresh */ }).then(function () {
    route();
    return loadMe();
  }).then(function () { if (signedIn()) syncIn(); });
}());
