/* Feedfix - the page. One file, no build step.
 *
 * NO STATEMENT EVER LEAVES THIS DEVICE. A file is read in a worker
 * (feedfix-worker.js) - or here when there is none - by FeedfixCore,
 * diagnosed there, fixed there, re-checked there, and saved as files this
 * browser writes. The requests this page makes: sign-in, the account's
 * settings (never a transaction), and the one optional AI call, whose
 * payload is the column names and their shape codes - shown in full before
 * it is sent.
 *
 * Browser storage is opt-in: "Keep my settings on this device" (off by
 * default, with Clear) keeps the settings and nothing else - never a file,
 * a row or an amount. Every access is wrapped in try/catch.
 *
 * Every string a file held, a person typed, the server sent or a model wrote
 * is escaped before it is drawn, and no handler is written into markup:
 * clicks are routed by data-act attributes from one listener (the lab's CSP
 * allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.FeedfixCore;
  var D = window.FeedfixDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var KEY = 'feedfix-v1';
  var SEV_MARK = { blocks: '✗', wrong: '!', info: 'i' };

  function recall() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function store(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function forget() { try { localStorage.removeItem(KEY); } catch (e) { /* nothing kept */ } }

  // A tag the browser reports but Intl refuses ("en-US@posix" in some
  // headless browsers) would make every date throw: fall back.
  var LOCALE = (function () { try { return Intl.getCanonicalLocales(navigator.language || 'en-US')[0] || 'en-US'; } catch (e) { return 'en-US'; } }());
  // Does this browser write 14/11 for 14 November? Then a target that takes
  // either order starts on day/month.
  var DAY_FIRST = (function () {
    try { var p = new Intl.DateTimeFormat(LOCALE).formatToParts(new Date(2026, 10, 14)); var t = p.map(function (x) { return x.type; }); return t.indexOf('day') < t.indexOf('month'); } catch (e) { return false; }
  }());
  function pad(n) { return ('0' + n).slice(-2); }
  function stamp() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  var state = {
    me: null, view: 'start',
    keep: false, device: { hint: false },
    settings: C.defaults(), syncBase: null, syncState: 'local', syncErr: '', conflictOpen: false,
    file: null, diag: null, fx: null, opts: null, open: {}, ai: {},
    busy: '', seq: 0, preview: 'fixed', fileNo: 0,
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

  /* ---------------- the engine: a worker, or this page ---------------- */

  var engine = (function () {
    var w = null, seq = 0, waits = {}, local = null;
    try {
      if (window.Worker) {
        w = new Worker('feedfix-worker.js');
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
    function here(op, data) {
      if (!local) local = C.createEngine();
      if (op === 'load' && data.file) {
        if (data.file.size > C.LIMITS.fileBytes) return Promise.reject(new Error('That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Download a shorter period from the bank.'));
        return data.file.arrayBuffer().then(function (buf) { return local.load({ id: data.id, name: data.name, bytes: new Uint8Array(buf), opts: data.opts }); });
      }
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

  /* ---------------- settings: on this device only if asked, and in the account ---------------- */

  var saveTimer = null;
  function saveSoon() { if (!state.keep) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
  function saveNow() {
    if (!state.keep) return;
    if (!store({ v: 1, keep: true, settings: state.settings, syncBase: state.syncBase, device: state.device })) toast('This browser would not keep it - your settings are still open here.', 4200);
  }
  var pushTimer = null;
  function settingsChanged() {
    state.settings.updatedAt = Date.now();
    saveSoon();
    pushSoon();
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
  function adopt(s) { state.settings = C.cleanSettings(s).settings; if (state.file && state.view !== 'start') draw(); }
  function openConflict(acc) {
    if (state.conflictOpen) return;
    state.conflictOpen = true;
    var mine = state.settings, a = C.cleanSettings(acc).settings;
    var desc = function (s) { return esc(plural(s.sources.length, 'named source')) + ', ' + esc(plural(s.words.length, 'summary word')) + ', default ' + esc(C.PROFILES[s.profile].name + ' ' + C.PROFILES[s.profile].shape); };
    sheet('<h2>Your settings changed on another device</h2><p class="muted">The copy in your account is newer than the one this device last saw.</p><div class="note"><p style="margin:0"><b>This device:</b> ' + desc(mine) + '</p><p style="margin:6px 0 0"><b>Your account:</b> ' + desc(a) + '</p></div>' +
      '<div class="btns" style="margin-top:12px"><button class="btn" type="button" id="cfMerge">Merge them</button><button class="btn ghost" type="button" id="cfTake">Use the account’s copy</button><button class="btn ghost" type="button" id="cfKeep">Keep this device’s</button></div><p class="small muted" style="margin-top:8px">Merging keeps every named source and summary word from both - this device’s wins where both name the same source.</p>', function (root) {
      var done = function (s, msg) { state.conflictOpen = false; closeSheet(); adopt(s); saveSoon(); toast(msg); };
      $('#cfMerge', root).addEventListener('click', function () { var m = C.mergeSettings(a, mine); done(m.settings, 'Merged' + (m.added ? ': ' + plural(m.added, 'item') + ' added from the other device.' : '.')); pushSettings(acc.updatedAt); });
      $('#cfTake', root).addEventListener('click', function () { done(a, 'Using the account’s copy.'); state.syncBase = acc.updatedAt; state.syncState = 'synced'; drawSync(); });
      $('#cfKeep', root).addEventListener('click', function () { done(mine, 'Keeping this device’s settings.'); pushSettings(acc.updatedAt); });
    });
  }
  function syncLine() {
    if (!signedIn()) return '<span class="sync muted small">Settings stay in this tab' + (state.keep ? ' and on this device' : '') + ' · <button class="link-btn" type="button" data-act="signin">sign in to keep them in your account</button> (never a transaction)</span>';
    if (state.me && !state.me.sync) return '<span class="sync muted small">Saving to the account is unavailable right now - your settings are on this device.</span>';
    if (state.syncState === 'syncing') return '<span class="sync muted small">Saving your settings to your account…</span>';
    if (state.syncState === 'error') return '<span class="sync small err">Couldn’t save to your account' + (state.syncErr ? ': ' + esc(state.syncErr) : '') + ' <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="sync small" style="color:var(--ok);font-weight:700">✓ Settings saved to your account - never a transaction</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }

  /** Remember the day/month answer (and a sign flip) for the file's source. */
  function rememberSource(patch) {
    var label = state.file && state.file.label;
    if (!label || C.looksLikeData(label)) return false;
    var s = state.settings;
    var cur = C.sourceFor(s, label) || { label: label };
    var next = { label: cur.label };
    if (cur.order) next.order = cur.order;
    if (cur.flip) next.flip = true;
    Object.keys(patch).forEach(function (k) { if (patch[k] === null || patch[k] === false) delete next[k]; else next[k] = patch[k]; });
    var rest = s.sources.filter(function (x) { return C.fold(x.label) !== C.fold(label); });
    if (next.order || next.flip) rest.push(next);
    if (rest.length > C.LIMITS.sources) rest.shift();
    s.sources = rest;
    settingsChanged();
    return true;
  }

  /* ---------------- loading a file and working it out ---------------- */

  function diagOpts() { var o = state.opts; return { order: o.order, map: o.map, flip: o.flip, words: state.settings.words, dayFirst: DAY_FIRST }; }
  function fixOpts() {
    var o = state.opts, d = diagOpts();
    d.profile = o.profile; d.dateFormat = o.dateFormat; d.undo = o.undo; d.dropDuplicates = o.dropDuplicates; d.leaveOut = o.leaveOut; d.account = o.account; d.currency = o.currency;
    return d;
  }
  function freshOpts(label, currency) {
    var s = state.settings, src = label ? C.sourceFor(s, label) : null;
    var profile = C.PROFILES[s.profile] ? s.profile : 'qbo3';
    return { order: src && src.order ? src.order : null, map: null, flip: Boolean(src && src.flip), undo: {}, dropDuplicates: false, leaveOut: {}, profile: profile, dateFormat: s.dateFormats[profile] || C.profileDates(profile, DAY_FIRST), account: {}, currency: currency || s.currency || '' };
  }
  function currency() { return (state.opts && state.opts.currency) || (state.diag && state.diag.currency) || 'USD'; }
  function money(c) { return C.money(c, currency()); }

  function begin(file, run) {
    var old = state.file;
    state.file = file;
    state.diag = null; state.fx = null; state.open = {}; state.ai = {}; state.preview = 'fixed';
    state.busy = 'Reading ' + file.name + '…';
    var seq = ++state.seq;
    if (state.view === 'start') draw(); else go('check');
    if (old && old.id !== file.id) engine.run('drop', { id: old.id });
    return run().then(function (d) {
      if (seq !== state.seq) return null;
      state.diag = d;
      if (!state.opts.currency && d.currency) state.opts.currency = d.currency;
      return refix(seq);
    }).then(function () {
      if (seq !== state.seq) return;
      state.busy = '';
      firstOpen();
      go('check');
      if (file.demo) { var h = $('.finding.hinted'); if (h) { h.classList.add('pulse'); } }
    }).catch(function (err) {
      if (seq !== state.seq) return;
      state.busy = ''; state.file = null; state.diag = null;
      go('start');
      toast(err.message || 'That file could not be read.', 6000);
    });
  }
  function firstOpen() {
    var d = state.diag;
    if (!d) return;
    var hint = hintFinding();
    d.findings.forEach(function (f, i) { if (hint ? f === hint : (i === 0 && f.sev !== 'info')) state.open[i] = true; });
  }
  function loadDemo(id) {
    var f = D.files().filter(function (x) { return x.id === id; })[0];
    if (!f) return;
    state.opts = freshOpts(f.label, f.currency);
    var file = { id: 'demo-' + f.id + '-' + (++state.fileNo), name: f.name, demo: f.id, bank: f.bank, label: f.label, hint: f.hint };
    begin(file, function () { return engine.run('load', { id: file.id, name: f.name, text: f.text, encoding: f.encoding, bom: f.bom, opts: diagOpts() }); });
  }
  function loadFile(fileObj) {
    if (!fileObj) return;
    if (fileObj.size > C.LIMITS.fileBytes) { toast('That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Download a shorter period from the bank.', 5000); return; }
    var label = C.labelFrom(fileObj.name);
    state.opts = freshOpts(label, '');
    var file = { id: 'own-' + (++state.fileNo), name: C.line(fileObj.name, 120) || 'statement', demo: null, label: label, size: fileObj.size };
    begin(file, function () { return engine.run('load', { id: file.id, name: file.name, file: fileObj, opts: diagOpts() }); });
  }
  /** Diagnose again (the order, the columns or the flip changed), then fix. */
  function rediagnose() {
    if (!state.file) return Promise.resolve();
    var seq = ++state.seq;
    return engine.run('diagnose', { id: state.file.id, opts: diagOpts() }).then(function (d) {
      if (seq !== state.seq) return null;
      state.diag = d;
      return refix(seq);
    }).then(function () { if (seq === state.seq) keepPlace(draw); }).catch(function (err) { toast(err.message, 5000); });
  }
  function refix(seq) {
    if (!state.file) return Promise.resolve();
    var mine = seq || ++state.seq;
    return engine.run('fix', { id: state.file.id, opts: fixOpts() }).then(function (r) {
      if (mine !== state.seq) return;
      state.fx = r;
      if (!seq) keepPlace(draw);
    }).catch(function (err) { toast(err.message, 5000); });
  }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }

  /* ---------------- routing ---------------- */

  function go(view) {
    history.pushState(null, '', BASE + '#' + view);
    route(); scrollTo(0, 0);
  }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    state.view = ['check', 'fix', 'export'].indexOf(h) >= 0 && (state.file) ? h : 'start';
    draw();
  }
  function draw() {
    var main = $('#main');
    var tb = $('#tabbar');
    tb.hidden = !state.file || state.view === 'start';
    $$('#tabbar [data-tab]').forEach(function (b) {
      if (b.getAttribute('data-tab') === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      var tab = b.getAttribute('data-tab'), span = $('span', b);
      if (tab === 'check') span.innerHTML = 'Diagnosis' + (state.diag && state.diag.verdict.blocks ? ' <i class="badge">' + esc(String(state.diag.verdict.blocks)) + '</i>' : '');
      if (tab === 'fix') span.innerHTML = 'Fix' + (state.fx && state.fx.ready ? ' <i class="badge okb">✓</i>' : '');
    });
    var html;
    if (state.busy) html = '<div class="card busy" role="status"><div class="spinner" aria-hidden="true"></div><p><b>' + esc(state.busy) + '</b></p><p class="small muted">Read on this device - nothing is uploaded.</p></div>';
    else if (state.view === 'start' || !state.diag) html = startHtml();
    else if (state.view === 'fix') html = fixHtml();
    else if (state.view === 'export') html = exportHtml();
    else html = checkHtml();
    main.innerHTML = html + footer();
    wire();
  }
  function footer() {
    return '<footer class="foot"><p>Feedfix reads statement files on this device; nothing is uploaded. Check your software’s current import guide - these are the common shapes.</p><p>A Challenge Lab app · <a href="../">more experiments</a></p></footer>';
  }

  /* ---------------- first run ---------------- */

  function startHtml() {
    var demos = D.files();
    return '<div class="stack">' +
      '<section class="hero">' +
        '<p class="kicker">🩹 The bank file doctor</p>' +
        '<h1>Your bank file imported zero rows? Find out why - and fix it.</h1>' +
        '<p>Importers turn a statement away for reasons you cannot see - a hidden byte at the start, semicolons, the bank’s name above the header, 03/04 dates, 1.234,56 amounts - and say only “0 transactions imported”. Feedfix names the exact problem and the line, then writes a clean file for QuickBooks Online, Xero or any importer - re-checked, with totals that prove nothing was lost.</p>' +
        '<div class="btns"><button class="btn big primary" type="button" data-act="demo" data-id="riverton">Try a broken file</button>' +
        '<label class="btn big ghost filepick">Check my file<input type="file" data-file accept=".csv,.tsv,.txt,.ofx,.qfx,.qif,.qbo,text/csv,text/plain,application/x-ofx"></label></div>' +
        '<p class="caps">Read on this device, never uploaded. CSV, TSV, TXT, OFX, QFX or QIF, up to 20 MB and 50,000 rows.</p>' +
        mockHtml() +
      '</section>' +
      '<section class="grid3 how" aria-label="How it works">' +
        '<div class="card"><span class="n">1</span><h2>Drop the bank’s file</h2><p>Any delimiter, any encoding, OFX 1 or 2, QFX or QIF. Feedfix works out what it is from what is inside, not the name.</p></div>' +
        '<div class="card"><span class="n">2</span><h2>See what is wrong, and where</h2><p>Every problem with its line, a before and after, and how bad it is: Blocks import, Will import wrong, Worth knowing.</p></div>' +
        '<div class="card"><span class="n">3</span><h2>Download the fix</h2><p>Pick your software. Every fix is listed with an Undo, the new file is checked again, and the totals must match.</p></div>' +
      '</section>' +
      '<section class="card"><div class="sec-head"><h2>Three broken files to try</h2><span class="small muted">Made-up banks, made-up money</span></div><div class="demos">' +
        demos.map(function (f) { return '<button class="card demo" type="button" data-act="demo" data-id="' + esc(f.id) + '"><b>' + esc(f.bank) + '</b><span class="fn">' + esc(f.name) + '</span><p>' + esc(f.blurb) + '</p></button>'; }).join('') +
      '</div></section>' +
      '<section class="dropzone" data-drop><p style="margin:0"><b>Or drop a statement file here</b></p><p class="small muted" style="margin:0">It is read in this browser. Not even its name leaves the device.</p><label class="btn ghost filepick">Choose a file<input type="file" data-file accept=".csv,.tsv,.txt,.ofx,.qfx,.qif,.qbo,text/csv,text/plain,application/x-ofx"></label></section>' +
      '<section class="card"><h2>What it catches</h2><ul class="chips">' + ['A byte-order mark', 'UTF-16 and Windows-1252', 'Garbled accents (Ã©)', 'Semicolons, tabs, pipes', 'Unclosed quotes', '1,250.00 split by a comma', 'Lines above the header', 'Totals and closing balances', 'Blank rows and page breaks', 'Day/month or month/day', 'Two-digit years', '1.234,56 and (84.12)', 'CR / DR and 84.12-', 'Debit and Credit columns', 'Signs the wrong way round', 'Duplicate rows', 'Duplicate or missing FITIDs', 'OFX headers strict readers refuse', 'A running balance that breaks'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>' +
      '<p class="privacy-line">🔒 <span><b>Nothing is uploaded.</b> The file is read, fixed and saved by this browser. A free account only keeps your settings - which target you use, which way round a bank writes its dates - never a transaction.</span></p>' +
    '</div>';
  }
  function mockHtml() {
    return '<div class="mock" aria-hidden="true"><div class="mh"><span>riverton-checking.csv</span><span class="mf">23 lines</span></div><ul>' +
      '<li><span class="mp mb">✗ Blocks</span><span>Separated by semicolons</span></li>' +
      '<li><span class="mp mb">✗ Blocks</span><span>3 lines above the header</span></li>' +
      '<li><span class="mp mb">✗ Blocks</span><span>A hidden byte-order mark</span></li>' +
      '<li><span class="mp mw">! Wrong</span><span>Amounts like 1.250,00</span></li>' +
      '<li><span class="mp mw">! Wrong</span><span>A closing-balance row</span></li>' +
      '</ul><div class="mok">✓ 19 rows · same totals as the original</div></div>';
  }

  /* ---------------- the diagnosis ---------------- */

  function demoStrip() {
    if (!state.file || !state.file.demo) return '';
    return '<div class="demo-strip"><p>🧪 A <b>made-up</b> file from ' + esc(state.file.bank) + '. Try the others, or your own.</p><div class="row"><div class="seg" role="group" aria-label="Demo files">' +
      D.files().map(function (f) { return '<button type="button" data-act="demo" data-id="' + esc(f.id) + '" aria-pressed="' + (f.id === state.file.demo ? 'true' : 'false') + '">' + esc(f.bank.split(' ')[f.bank.indexOf('of ') >= 0 ? 2 : 0]) + '</button>'; }).join('') +
      '</div><label class="btn small ghost filepick">My file<input type="file" data-file accept=".csv,.tsv,.txt,.ofx,.qfx,.qif,.qbo,text/csv,text/plain,application/x-ofx"></label></div></div>';
  }
  function spanWords(d) { return d < 14 ? plural(d + 1, 'day') : d < 70 ? plural(Math.round(d / 7), 'week') : plural(Math.round(d / 30.4), 'month'); }
  function periodText(t) { return t && t.first ? (t.first === t.last ? C.niceDay(t.first) : C.niceDay(t.first) + ' – ' + C.niceDay(t.last)) : ''; }
  function totalsLine(t) { return plural(t.rows, 'row') + ' · in ' + money(t.inCents) + ' · out ' + money(t.outCents); }
  function verdictHtml() {
    var d = state.diag, v = d.verdict;
    var cls = v.blocks ? '' : v.wrong ? ' v-wrong' : ' v-clean';
    var big = d.format === 'binary' || d.format === 'empty' ? 'This file cannot be imported as it is' : v.blocks ? (v.blocks === 1 ? 'One problem stops an import' : v.blocks + ' problems stop an import') : v.wrong ? (v.wrong === 1 ? 'It would import - with one thing wrong' : 'It would import - with ' + v.wrong + ' things wrong') : 'Nothing found that would stop or spoil an import';
    var why = v.blocks ? 'That is why an importer says “0 transactions imported”, or refuses the file. ' : '';
    return '<section class="card verdict' + cls + '"><p class="big">' + esc(big) + '</p>' +
      '<div class="counts">' + (v.blocks ? '<span class="cpill blocks">✗ ' + esc(String(v.blocks)) + ' block' + (v.blocks === 1 ? 's' : '') + ' import</span>' : '') + (v.wrong ? '<span class="cpill wrong">! ' + esc(String(v.wrong)) + ' will import wrong</span>' : '') + (v.info ? '<span class="cpill info">i ' + esc(String(v.info)) + ' worth knowing</span>' : '') + (!v.blocks && !v.wrong ? '<span class="cpill ok">✓ Ready to import</span>' : '') + '</div>' +
      '<p class="sub">' + esc(why) + (d.totals.rows ? esc(totalsLine(d.totals)) + (d.totals.first ? ' · ' + esc(periodText(d.totals)) : '') : 'No transactions found.') + '</p>' +
      (d.format === 'binary' || d.format === 'empty' ? '' : '<div class="btns"><button class="btn" type="button" data-act="tab" data-tab="fix">' + (v.blocks || v.wrong ? 'Fix it →' : 'Write it for my software →') + '</button></div>') + '</section>';
  }
  function fileCardHtml() {
    var d = state.diag, f = state.file;
    var bits = [C.formatLabel(d), plural(d.lineCount, 'line'), C.groups(d.bytes) + ' bytes'];
    return '<section class="card filestrip"><p class="lab">The file</p><p class="fname">' + esc(f.name) + '</p><p class="fmeta">' + esc(bits.join(' · ')) + '</p>' +
      (d.format !== 'binary' && d.format !== 'empty' ? '<div class="srcrow"><label class="field"><span>Which account is it?</span><input class="input" id="srcLabel" maxlength="' + esc(String(C.LIMITS.labelChars)) + '" value="' + esc(f.label || '') + '" placeholder="Riverton checking" autocomplete="off"><small>A name, no numbers - Feedfix remembers how this bank writes its dates.</small></label></div>' : '') +
      '</section>';
  }
  function hintFinding() {
    var d = state.diag, f = state.file;
    if (!d || !f || !f.demo || state.device.hint) return null;
    return d.findings.filter(function (x) { return x.key === f.hint; })[0] || d.findings.filter(function (x) { return x.sev === 'blocks'; })[0] || null;
  }
  function hintHtml() {
    var h = hintFinding();
    if (!h) return '';
    var n = state.diag.verdict.blocks;
    return '<div class="hint" role="note"><span class="ico">👉</span><div><p><b>Start here.</b> ' + esc(n > 1 ? 'Any one of the ' + n + ' red findings makes an importer turn this file away - the ringed one is the easiest to see. ' : 'The ringed finding is why an importer turns this file away. ') + 'Open it for the exact line, before and after. Then <b>Fix it</b> writes a clean file and checks it again.</p><div class="btns"><button class="btn small" type="button" data-act="tab" data-tab="fix">Show me the fix</button><button class="btn small ghost" type="button" data-act="hintoff">Got it</button></div></div></div>';
  }
  function questionHtml() {
    var q = (state.diag.questions || []).filter(function (x) { return x.key === 'order'; })[0];
    if (!q) return '';
    var reading = function (k) {
      var r = q[k], name = k === 'dmy' ? 'Day/month' : 'Month/day';
      var ex = q.examples.slice(0, 2).map(function (e) { return e.raw + ' = ' + C.niceDay(e[k]); }).join(' · ');
      var why = (r.inOrder ? 'Runs in order' : 'Jumps backwards ' + (r.inversions === 1 ? 'once' : r.inversions + ' times')) + ' · ' + C.niceDay(r.first) + ' to ' + C.niceDay(r.last) + ' (' + spanWords(r.spanDays) + ')';
      return '<button class="reading" type="button" data-act="order" data-v="' + esc(k) + '" aria-pressed="' + (q.chosen === k ? 'true' : 'false') + '">' + (q.suggestion === k ? '<span class="tag">Suggested</span>' : '') + '<b>' + esc(name) + '</b><span class="ex">' + esc(ex) + '</span><span class="why' + (r.inOrder ? ' good' : '') + '">' + esc(why) + '</span></button>';
    };
    var src = state.file.label && C.sourceFor(state.settings, state.file.label);
    return '<section class="card question' + (q.answered ? ' answered' : '') + '" id="orderQ"><h2>📅 Day/month or month/day?</h2><p class="muted" style="margin:0">Every date in this file has a day of 12 or under, so 03/04 could be 3 April or March 4 - and ' + esc(plural(q.count, 'date')) + ' would land in the wrong month read the wrong way. ' + (q.answered ? (src && src.order ? 'Remembered for “' + esc(src.label) + '”.' : 'You chose.') : (q.why === 'in order' ? 'One reading puts the statement in order; Feedfix is using it until you say.' : 'Choose which way round they are.')) + '</p>' +
      '<div class="readings">' + reading('mdy') + reading('dmy') + '</div></section>';
  }
  function lineChips(f) {
    if (f.every) return 'Every line';
    if (f.ok) return f.count > 1 ? esc(C.groups(f.count) + ' rows checked') : '';
    if (f.unit && !f.lines.length) return esc(plural(f.count, f.unit));
    if (!f.lines.length) return f.count > 1 ? esc(C.groups(f.count) + ' found') : '';
    return esc(C.linesWord(f.lines, f.more));
  }
  function findingHtml(f, i, hint) {
    var open = Boolean(state.open[i]);
    var sevCls = f.ok ? 'okf' : 'sev-' + f.sev;
    var pill = f.ok ? '<span class="sevpill ok">✓ Checked</span>' : '<span class="sevpill ' + esc(f.sev) + '">' + esc(SEV_MARK[f.sev]) + ' ' + esc(C.SEV_WORD[f.sev]) + '</span>';
    var fixed = f.fix && state.fx && state.fx.fixes ? state.fx.fixes.filter(function (x) { return x.key === f.fix; })[0] : null;
    var body = '';
    if (open) {
      body = '<div class="fbody" id="fb-' + i + '"><p>' + esc(f.detail) + '</p>' +
        (f.examples && f.examples.length ? '<div class="ba">' + f.examples.map(function (e) { return '<p class="ln">Line ' + esc(String(e.line)) + '</p><div class="bl before"><span>Before</span><pre>' + esc(e.before) + '</pre></div><div class="bl after"><span>After</span><pre>' + esc(e.after) + '</pre></div>'; }).join('') + '</div>' : '') +
        (f.lines.length + f.more > 6 ? '<p class="lines">' + esc('All ' + C.groups(f.lines.length + f.more) + ' lines: ' + f.lines.slice(0, 60).join(', ') + (f.lines.length + f.more > 60 ? ' …' : '')) + '</p>' : '') +
        (fixed ? '<p class="fixedline">' + (fixed.undone ? '↩ Fix undone - ' : '✓ Fixed in the output: ') + esc(fixed.label) + ' <button class="link-btn" type="button" data-act="tab" data-tab="fix">See the fix</button></p>' : '') +
        (f.question === 'columns' ? '<p><button class="btn small ghost" type="button" data-act="gocols">Check the columns</button></p>' : '') +
        '</div>';
    }
    return '<li class="finding ' + sevCls + (hint ? ' hinted' : '') + '" id="f-' + i + '"><button class="fhead" type="button" data-act="ftoggle" data-i="' + i + '" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="fb-' + i + '"><span class="ft">' + esc(f.title) + '</span><span class="chev" aria-hidden="true">' + (open ? '▾' : '▸') + '</span><span class="fl">' + pill + '<span>' + lineChips(f) + '</span></span></button>' + body + '</li>';
  }
  function findingsHtml() {
    var d = state.diag, hint = hintFinding();
    if (!d.findings.length) return '<section class="card"><p style="margin:0"><b>✓ Nothing to report.</b> The file reads cleanly.</p></section>';
    return '<section class="card"><div class="sec-head"><h2>What Feedfix found</h2><span class="small muted">' + esc(plural(d.findings.length, 'finding')) + ' · tap one for the line</span></div><ul class="findings">' +
      d.findings.map(function (f, i) { return findingHtml(f, i, f === hint); }).join('') + '</ul></section>';
  }
  function columnsHtml() {
    var c = state.diag.columns;
    if (!c) return '';
    var used = {};
    Object.keys(c.map).forEach(function (k) { if (c.map[k] >= 0) used[c.map[k]] = k; });
    var rows = c.headers.map(function (h, i) {
      var cur = used[i] || 'ignore';
      var sure = cur === 'ignore' ? 'none' : (state.ai[cur] ? 'ai' : c.sure[cur]);
      var sureWord = { sure: '✓ Recognised', likely: 'Likely', unsure: '? Check this', you: 'Your choice', ai: 'AI · ' + (state.ai[cur] || ''), none: 'Not used' }[sure] || '';
      var vals = c.sample.slice(0, 3).map(function (r) { return r[i] || ''; }).filter(Boolean);
      return '<li class="maprow"><div class="mh"><b>' + esc(h) + '</b><span class="sure sure-' + esc(sure) + '">' + esc(sureWord) + '</span></div>' +
        '<p class="mv">' + (vals.length ? esc(vals.join(' · ')) : '<span class="muted">(empty)</span>') + '</p>' +
        '<select class="input" data-col="' + i + '" aria-label="' + esc('What “' + h + '” holds') + '">' + C.FIELDS.map(function (k) { return '<option value="' + esc(k) + '"' + (cur === k ? ' selected' : '') + '>' + esc(C.FIELD_LABEL[k]) + '</option>'; }).join('') + '</select></li>';
    }).join('');
    return '<section class="card" id="colsCard"><div class="sec-head"><h2>Columns</h2><button class="btn small ghost" type="button" data-act="ai">✨ Help me read these columns</button></div>' +
      (c.problems.length ? '<p class="err" role="alert">' + esc(c.problems.join(' ')) + '</p>' : '<p class="small muted" style="margin:0 0 8px">' + esc(c.hasHeader ? 'Read from the header names and what the values look like. Change any you disagree with.' : 'This file has no header, so the columns were guessed from their values - check them.') + '</p>') +
      '<ul class="maplist">' + rows + '</ul></section>';
  }
  function originalHtml() {
    var d = state.diag;
    if (!d.preview || !d.preview.length) return '';
    var hot = {};
    d.findings.forEach(function (f) { if (f.sev === 'blocks' && !f.ok) f.lines.forEach(function (n) { hot[n] = 1; }); });
    return '<section class="card"><div class="sec-head"><h2>The file as it is</h2><span class="small muted">' + esc(d.lineCount > d.preview.length ? 'First ' + d.preview.length + ' of ' + C.groups(d.lineCount) + ' lines' : plural(d.lineCount, 'line')) + '</span></div><pre class="out" tabindex="0" aria-label="The first lines of the file">' +
      d.preview.map(function (l) { return '<span class="l' + (hot[l.line] ? ' hot' : '') + '" data-n="' + esc(String(l.line)) + '">' + esc(l.text || ' ') + '</span>'; }).join('') + '</pre><p class="small muted" style="margin:8px 0 0">Invisible characters are drawn as marks: ‹BOM›, ‹NUL›, ⇥ for a tab.</p></section>';
  }
  function checkHtml() {
    return '<div class="stack">' + demoStrip() + '<div class="split2"><div class="stack">' + verdictHtml() + questionHtml() + hintHtml() + findingsHtml() + '</div><div class="stack side">' + fileCardHtml() + columnsHtml() + originalHtml() + '</div></div></div>';
  }

  /* ---------------- the fix ---------------- */

  function targetsHtml() {
    return '<section class="card"><div class="sec-head"><h2>Which software is it for?</h2></div><div class="targets" role="radiogroup" aria-label="Target">' +
      C.PROFILE_KEYS.map(function (k) { var p = C.PROFILES[k]; return '<button class="target" type="button" role="radio" data-act="profile" data-k="' + esc(k) + '" aria-pressed="' + (state.opts.profile === k ? 'true' : 'false') + '" aria-checked="' + (state.opts.profile === k ? 'true' : 'false') + '"><span class="dot" aria-hidden="true"></span><b>' + esc(p.name) + '</b><span class="sh">' + esc(p.shape) + '</span></button>'; }).join('') +
      '</div><details class="why"><summary>What this target assumes</summary><p class="small" style="margin:0">' + esc(C.PROFILES[state.opts.profile].assumes) + '</p></details><p class="small muted" style="margin:6px 0 0">Check your software’s current import guide - these are the common shapes.</p></section>';
  }
  function optionsHtml() {
    var o = state.opts, P = C.PROFILES[o.profile];
    var parts = [];
    if (P.dates.length > 1) parts.push('<div class="field" style="grid-column:1/-1"><span>Dates in the file you download</span><div class="seg" role="group" aria-label="Date format">' + P.dates.map(function (k) { return '<button type="button" data-act="datefmt" data-v="' + esc(k) + '" aria-pressed="' + (o.dateFormat === k ? 'true' : 'false') + '">' + esc(C.DATE_FORMATS[k].label) + '</button>'; }).join('') + '</div><small>Match the date format your company file or organisation uses.</small></div>');
    parts.push('<label class="field"><span>Currency (for the totals' + (o.profile === 'ofx' ? ' and CURDEF' : '') + ')</span><select class="input" id="curSel">' + C.CURRENCIES.map(function (k) { return '<option value="' + esc(k) + '"' + (currency() === k ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join('') + '</select></label>');
    parts.push('<div class="field"><span>Signs</span><label class="check"><input type="checkbox" id="flipBox"' + (o.flip ? ' checked' : '') + '> Flip every sign</label><small>For a credit card statement where purchases are positive. Remembered for this account when it has a name.</small></div>');
    var acctHtml = '';
    if (o.profile === 'ofx') {
      var src = (state.diag.ofx && state.diag.ofx.acct) || {};
      acctHtml = '<div class="field" style="grid-column:1/-1"><span>The account, for the OFX file</span><div class="acctrow"><label class="field"><span class="small">Account number</span><input class="input" id="acctId" maxlength="22" inputmode="numeric" autocomplete="off" value="' + esc(o.account.acctId || src.ACCTID || '') + '" placeholder="Last digits are enough"></label><label class="field"><span class="small">Routing or sort code</span><input class="input" id="bankId" maxlength="9" inputmode="numeric" autocomplete="off" value="' + esc(o.account.bankId || src.BANKID || '') + '" placeholder="Optional"></label><label class="field"><span class="small">Account type</span><select class="input" id="acctType">' + ['CHECKING', 'SAVINGS', 'MONEYMRKT', 'CREDITLINE', 'CREDITCARD'].map(function (k) { var cur = o.account.acctType || (state.diag.ofx && state.diag.ofx.cc ? 'CREDITCARD' : (src.ACCTTYPE || 'CHECKING')); return '<option value="' + esc(k) + '"' + (cur === k ? ' selected' : '') + '>' + esc(k.charAt(0) + k.slice(1).toLowerCase()) + '</option>'; }).join('') + '</select></label></div><small>Stays on this device - it is written into the file you download, nowhere else.</small></div>';
    }
    return '<section class="card"><h2>Options</h2><div class="two-col">' + parts.join('') + acctHtml + '</div></section>';
  }
  function fixesHtml() {
    var fx = state.fx;
    if (!fx || !fx.fixes) return '';
    var unreadable = state.diag.findings.filter(function (f) { return f.fix === 'leaveOut'; });
    var lines = []; unreadable.forEach(function (f) { lines = lines.concat(f.lines); });
    var left = Object.keys(state.opts.leaveOut || {}).length;
    var items = fx.fixes.map(function (x) {
      var btn = x.required ? '<span class="req">' + esc(x.why ? x.why.charAt(0).toUpperCase() + x.why.slice(1) : 'Required') + '</span>' :
        x.key === 'duplicates' ? '<button class="btn small ghost" type="button" data-act="dups">' + (state.opts.dropDuplicates ? 'Keep them' : 'Leave out the copies') + '</button>' :
        x.key === 'flip' ? '<button class="btn small ghost" type="button" data-act="unflip">Undo</button>' :
        x.key === 'leaveOut' ? '<button class="btn small ghost" type="button" data-act="leaveout">Put them back</button>' :
        '<button class="btn small ghost" type="button" data-act="undo" data-k="' + esc(x.key) + '">' + (x.undone ? 'Redo' : 'Undo') + '</button>';
      return '<li class="' + (x.undone ? 'undone' : x.optional ? 'opt' : '') + '"><span class="fx">' + esc(x.label) + '</span>' + btn + '</li>';
    });
    if (lines.length && !left) items.push('<li class="opt"><span class="fx">' + esc(plural(lines.length, 'line') + ' cannot be read (' + C.linesWord(lines) + ') and ' + (lines.length === 1 ? 'is' : 'are') + ' written as they are') + '</span><button class="btn small ghost" type="button" data-act="leaveout">Leave ' + (lines.length === 1 ? 'it' : 'them') + ' out</button></li>');
    return '<section class="card"><div class="sec-head"><h2>Every fix</h2><span class="small muted">Undo any of them - the check below runs again</span></div><ul class="fixes">' + items.join('') + '</ul>' +
      (fx.shaped && fx.shaped.length ? '<p class="lab" style="margin-top:12px">Shaped for ' + esc(C.PROFILES[fx.profile].name) + '</p><ul class="shaped">' + fx.shaped.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' : '') + '</section>';
  }
  function proofHtml() {
    var fx = state.fx;
    if (!fx) return '';
    if (fx.ok === false) return '<section class="card proof bad"><p class="big">Nothing to write yet</p><p>' + esc(fx.problem) + '</p>' + (state.diag.columns ? '<button class="btn small" type="button" data-act="gocols">Choose the columns</button>' : '') + '</section>';
    var t = fx.totals, a = t.after, b = t.before;
    var tail = t.same ? (t.removedRows ? plural(t.removedRows, 'row') + ' fewer, left out on purpose' : 'same as the original') : 'NOT the same as the original';
    var row = function (name, x) { return '<tr><td>' + esc(name) + '</td><td>' + esc(C.groups(x.rows)) + '</td><td>' + esc(money(x.inCents)) + '</td><td>' + esc(money(x.outCents)) + '</td><td>' + esc(money(x.net)) + '</td></tr>'; };
    var sameDays = a.first === t.expected.first && a.last === t.expected.last;
    return '<section class="card proof' + (t.same ? '' : ' bad') + '" aria-live="polite"><p class="lab">Totals that prove it</p><p class="big">' + esc(totalsLine(a)) + ' · <span class="' + (t.same ? 'same' : 'diff') + '">' + esc(tail) + (t.same ? ' ✓' : '') + '</span></p>' +
      '<div class="totwrap"><table class="tot"><thead><tr><th></th><th>Rows</th><th>In</th><th>Out</th><th>Net</th></tr></thead><tbody>' + row('Original', b) + row('Fixed file', a) + '</tbody></table></div>' +
      '<p class="small" style="margin:0"><b>Dates:</b> ' + esc(periodText(a) || '-') + (sameDays ? ' <span class="okw">· the same in both ✓</span>' : ' <span class="err">· the original runs ' + esc(periodText(t.expected)) + '</span>') + '</p>' +
      (t.removedRows ? '<p class="small muted" style="margin:0">Left out on purpose: ' + esc(t.removed.map(function (r) { return 'line ' + r.line + ' (' + (r.why === 'duplicate' ? 'a duplicate' : 'unreadable') + (r.amount !== null ? ', ' + money(r.amount) : '') + ')'; }).join('; ')) + '.</p>' : '') +
      (!t.same ? '<p class="small" style="margin:0">The fixed file was read back and does not add up to the original - an undone fix usually explains it. The re-check says where.</p>' : '') + '</section>';
  }
  function recheckHtml() {
    var fx = state.fx;
    if (!fx || fx.ok === false) return '';
    var rc = fx.recheck;
    var list = rc.problems.map(function (p) { return '<li><b>' + esc(C.SEV_WORD[p.sev]) + ':</b> ' + esc(p.title) + (p.lines.length ? ' <span class="muted">- ' + esc(C.linesWord(p.lines)) + '</span>' : '') + '</li>'; })
      .concat(rc.conform.map(function (c) { return '<li>' + esc(c.title) + (c.lines.length ? ' <span class="muted">- ' + esc(C.linesWord(c.lines)) + '</span>' : '') + '</li>'; }));
    return '<section class="card recheck"><p class="lab">Re-check of the fixed file</p>' +
      (rc.clean ? '<p class="rc good">✓ Clean - read back as a new file, nothing would stop or spoil an import.</p>' : '<p class="rc bad">✗ Not clean yet</p><ul class="small" style="margin:0;padding-left:20px">' + list.join('') + '</ul>') +
      (rc.carried.length ? '<p class="small muted" style="margin:0">Still true of the data - a file fix cannot change it: ' + esc(rc.carried.map(function (c) { return c.title; }).join('; ')) + '.</p>' : '') + '</section>';
  }
  function downloadHtml() {
    var fx = state.fx;
    if (!fx || fx.ok === false) return '';
    return '<section class="card dl"><div class="btns"><button class="btn big block" type="button" data-act="dlfixed">' + (fx.ready ? '⬇ Download the fixed file' : '⬇ Download it anyway') + '</button></div><p class="fname">' + esc(fx.fileName) + ' · ' + esc(plural(fx.lineCount, 'line')) + '</p></section>';
  }
  function previewHtml() {
    var fx = state.fx;
    if (!fx || fx.ok === false) return '';
    var orig = state.preview === 'original';
    var lines = orig ? state.diag.preview : fx.preview;
    return '<section class="card"><div class="sec-head"><h2>Before and after</h2><div class="seg" role="group" aria-label="Which file"><button type="button" data-act="pv" data-v="original" aria-pressed="' + (orig ? 'true' : 'false') + '">Original</button><button type="button" data-act="pv" data-v="fixed" aria-pressed="' + (orig ? 'false' : 'true') + '">Fixed</button></div></div><pre class="out" tabindex="0" aria-label="' + (orig ? 'The original file' : 'The fixed file') + '">' +
      lines.map(function (l) { return '<span class="l" data-n="' + esc(String(l.line)) + '">' + esc(l.text || ' ') + '</span>'; }).join('') + '</pre><p class="small muted" style="margin:8px 0 0">' + esc(orig ? 'The first lines of the file as the bank wrote it.' : 'The first lines of the file Feedfix writes.') + '</p></section>';
  }
  /** On a phone the side column comes last: say the outcome and offer the
   *  file straight after the target, with the details further down. */
  function resultStripHtml() {
    var fx = state.fx;
    if (!fx || fx.ok === false) return '';
    var t = fx.totals;
    return '<section class="card result-strip' + (fx.ready ? '' : ' bad') + '" aria-live="polite"><p class="big">' + (fx.ready ? '✓ Clean, same totals' : '✗ Not clean yet') + '</p><p class="small muted">' + esc(totalsLine(t.after)) + (t.same ? (t.removedRows ? ' · ' + esc(plural(t.removedRows, 'row')) + ' left out on purpose' : ' · same as the original') : ' · not the same as the original') + '</p><div class="btns"><button class="btn" type="button" data-act="dlfixed">⬇ Download</button><button class="btn ghost" type="button" data-act="gocheck">See the proof</button></div></section>';
  }
  function fixHtml() {
    return '<div class="stack">' + demoStrip() + '<div class="split2"><div class="stack">' + targetsHtml() + resultStripHtml() + optionsHtml() + fixesHtml() + '</div><div class="stack side">' + proofHtml() + recheckHtml() + downloadHtml() + previewHtml() + '</div></div></div>';
  }

  /* ---------------- exports ---------------- */

  function reportText() { return C.report(state.diag, state.fx, stamp()); }
  function exportHtml() {
    var fx = state.fx, ok = fx && fx.ok !== false;
    var dups = (fx && fx.dups) || [];
    return '<div class="stack">' + demoStrip() + '<div class="grid3">' +
      '<section class="card excard"><h2>📄 The fixed file</h2><p class="muted">' + (ok ? esc(C.PROFILES[fx.profile].name + ' · ' + C.PROFILES[fx.profile].shape) : 'Choose the columns first.') + '</p>' + (ok ? '<p class="small dl"><span class="fname">' + esc(fx.fileName) + '</span></p><p class="small">' + esc(fx.ready ? '✓ Re-checked clean, totals match.' : 'Not clean yet - see Fix.') + '</p><div class="btns"><button class="btn" type="button" data-act="dlfixed">Download</button>' + (fx.profile !== 'ofx' ? '<button class="btn ghost" type="button" data-act="copyfixed">Copy</button>' : '') + '</div>' : '') + '</section>' +
      '<section class="card excard"><h2>🩺 The diagnosis report</h2><p class="muted">Markdown: every finding with its lines, every fix, the totals and the re-check. Payees and single amounts are left out - only counts and totals.</p><div class="btns"><button class="btn" type="button" data-act="dlreport">Download .md</button><button class="btn ghost" type="button" data-act="copyreport">Copy</button></div></section>' +
      '<section class="card excard"><h2>🔁 The duplicates list</h2><p class="muted">' + (dups.length ? esc(plural(dups.length, 'possible duplicate')) + ', each with the line it repeats - kept in the fixed file unless you chose to leave them out.' : 'No possible duplicates in this file.') + '</p>' + (dups.length ? '<div class="btns"><button class="btn" type="button" data-act="dldups">Download CSV</button></div>' : '') + '</section>' +
      '</div>' +
      '<section class="card"><div class="sec-head"><h2>The report</h2><span class="small muted">Made on this device</span></div><pre class="out wrapit" tabindex="0">' + esc(reportText()) + '</pre>' +
      (fx && fx.formulaCount ? '<p class="small muted" style="margin:8px 0 0">' + esc(plural(fx.formulaCount, 'text cell') + ' began with = + - or @ and got a leading apostrophe, so a spreadsheet opening the file does not run it as a formula. The report says so too.') + '</p>' : '') + '</section></div>';
  }

  /* ---------------- the AI column helper ---------------- */

  function openAi() {
    var c = state.diag && state.diag.columns;
    if (!c) return;
    var payload = C.columnsPayload(c.headers, c.shapes);
    var renamed = c.headers.filter(function (h, i) { return C.safeHeader(h, i) !== C.line(h, C.LIMITS.headerChars); }).length;
    sheet('<h2>✨ Help me read these columns</h2><p class="muted small">For when the guess is unsure. Only each column’s <b>name</b> and a few words about <b>what its values look like</b> are sent - worked out on this device, from a fixed list. Never a value: no date, no amount, no payee.</p>' +
      '<div class="tablewrap" tabindex="0" style="max-height:280px"><table class="sent"><thead><tr><th>#</th><th>Name, as sent</th><th>What the values look like</th></tr></thead><tbody>' +
      payload.columns.map(function (col, i) { return '<tr><td>' + esc(String(i + 1)) + '</td><td>' + esc(col.header) + '</td><td>' + esc(col.shape.map(function (k) { return C.SHAPES[k]; }).join('; ') || '-') + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      (renamed ? '<p class="small" style="margin:8px 0 0">' + esc(plural(renamed, 'name') + ' looked like a value (an @, a long number, a date or an amount) and ' + (renamed === 1 ? 'is' : 'are') + ' sent as “Column N”.') + '</p>' : '') +
      '<details class="why"><summary>Exactly what will be sent</summary><pre class="sent-pre" tabindex="0">' + esc(JSON.stringify(payload, null, 1)) + '</pre></details>' +
      '<div id="aiErr"></div><div class="btns" id="aiActs" style="margin-top:10px"></div>', function (root) {
      var acts = $('#aiActs', root);
      if (!signedIn()) {
        acts.innerHTML = '<p class="small muted" style="width:100%;margin:0">It uses about a cent of AI credit, so it needs a free account - which comes with $2 and works across every app on this site. Choosing the columns by hand is free.</p><button class="btn" type="button" id="aiSignin">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button>';
        $('#aiSignin', root).addEventListener('click', function () { openAccount('The column helper uses about a cent of AI credit; a free account comes with $2.', openAi); });
        return;
      }
      acts.innerHTML = '<button class="btn" type="button" id="aiSend">Send the names and shapes</button><span class="small muted">About a cent' + (state.me.tier === 'paid' ? ' (member model)' : '') + '. You still check the answer.</span>';
      $('#aiSend', root).addEventListener('click', function () {
        var b = $('#aiSend', root);
        b.disabled = true; b.textContent = 'Asking…';
        $('#aiErr', root).innerHTML = '';
        api('POST', 'api/ai/columns', payload).then(function (res) {
          var m = res.columns.map, conf = res.columns.confidence || {}, map = {};
          C.MAP_FIELDS.forEach(function (k) { map[k] = m[k] >= 0 && m[k] < c.headers.length ? m[k] : -1; });
          state.opts.map = map; state.ai = conf;
          closeSheet();
          var n = Object.keys(map).filter(function (k) { return map[k] >= 0; }).length;
          toast('The AI placed ' + plural(n, 'column') + ' - check them.', 4200);
          rediagnose().then(function () { var cc = $('#colsCard'); if (cc) cc.scrollIntoView({ block: 'start' }); });
          loadMe();
        }).catch(function (err) { b.disabled = false; b.textContent = 'Send the names and shapes'; meteredError(err, $('#aiErr', root), openAi, 'The column helper uses about a cent of AI credit, so it needs a free account (it comes with $2).'); });
      });
    });
  }

  /* ---------------- settings ---------------- */

  function keepHtml() {
    return '<label class="check"><input type="checkbox" id="keepBox"' + (state.keep ? ' checked' : '') + '> Keep my settings on this device</label><p class="small muted" style="margin:0">Off by default. When on, the settings above stay in this browser until you clear them. A statement, a row or an amount is never kept - not even with this on.</p>' + (state.keep ? '<button class="btn small danger" type="button" data-act="clearkept" style="margin-top:8px">Clear it from this device</button>' : '');
  }
  function openSettings() {
    var s = state.settings;
    sheet('<h2>Settings</h2><div class="form">' +
      '<label class="field"><span>Default target</span><select class="input" id="setProfile">' + C.PROFILE_KEYS.map(function (k) { return '<option value="' + esc(k) + '"' + (s.profile === k ? ' selected' : '') + '>' + esc(C.PROFILES[k].name + ' (' + C.PROFILES[k].shape + ')') + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Currency for totals</span><select class="input" id="setCur"><option value="">From the file (else USD)</option>' + C.CURRENCIES.map(function (k) { return '<option value="' + esc(k) + '"' + (s.currency === k ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join('') + '</select></label>' +
      '<div class="field"><span>Named accounts</span>' + (s.sources.length ? '<ul class="srclist">' + s.sources.map(function (x, i) { return '<li><span>' + esc(x.label) + ' = ' + esc([x.order === 'dmy' ? 'day/month' : x.order === 'mdy' ? 'month/day' : '', x.flip ? 'signs flipped' : ''].filter(Boolean).join(', ')) + '</span><button class="btn small ghost" type="button" data-rmsrc="' + i + '">Forget</button></li>'; }).join('') + '</ul>' : '<p class="small muted" style="margin:0">None yet. Answer “day/month or month/day?” for a named account and Feedfix remembers it.</p>') + '</div>' +
      '<label class="field"><span>More summary-row words, one a line</span><textarea class="input" id="setWords" rows="3" placeholder="saldo final" spellcheck="false">' + esc(s.words.join('\n')) + '</textarea><small>Rows that carry one of these are left out like a closing balance. Words only - no amounts or dates.</small></label>' +
      '<div data-sync>' + syncLine() + '</div>' +
      '<hr style="border:0;border-top:1px solid var(--line);width:100%">' + keepHtml() + '</div>', function (root) {
      $('#setProfile', root).addEventListener('change', function (e) { s.profile = C.PROFILES[e.target.value] ? e.target.value : 'qbo3'; settingsChanged(); });
      $('#setCur', root).addEventListener('change', function (e) { s.currency = C.CURRENCIES.indexOf(e.target.value) >= 0 ? e.target.value : ''; settingsChanged(); });
      $('#setWords', root).addEventListener('change', function (e) {
        var words = e.target.value.split(/\n+/).map(function (w) { return C.line(w, C.LIMITS.wordChars); }).filter(Boolean).slice(0, C.LIMITS.words);
        var chk = C.cleanSettings({ words: words }, true);
        if (chk.errors.length) { toast(chk.errors[0], 4200); return; }
        s.words = chk.settings.words; settingsChanged();
        if (state.file) rediagnose();
      });
      $$('[data-rmsrc]', root).forEach(function (b) { b.addEventListener('click', function () { s.sources.splice(+b.getAttribute('data-rmsrc'), 1); settingsChanged(); openSettings(); }); });
      var kb = $('#keepBox', root);
      kb.addEventListener('change', function () {
        state.keep = kb.checked;
        if (kb.checked) { saveNow(); toast('Kept on this device. Clear it any time.'); } else { forget(); toast('Nothing is kept on this device now.'); }
        openSettings();
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

  var FREE_LINE = 'Checking and fixing files is free with no account, and never leaves this device. A free account keeps your settings across devices and adds the AI column helper - it comes with $2 of AI credit, and one account works across every app on this site.';
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">The column helper costs about a cent. Checking, fixing and exporting are free and never leave this device.</p><div id="billing"></div></div>' +
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Checking, fixing, the column dropdowns and every export keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    $$('input[data-file]').forEach(function (inp) {
      inp.addEventListener('change', function (e) { var f = (e.target.files || [])[0]; e.target.value = ''; if (f) loadFile(f); });
    });
    $$('[data-drop]').forEach(function (z) {
      z.addEventListener('dragover', function (e) { e.preventDefault(); z.classList.add('over'); });
      z.addEventListener('dragleave', function () { z.classList.remove('over'); });
    });
    $$('select[data-col]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var col = +sel.getAttribute('data-col'), field = sel.value, c = state.diag.columns, map = {};
        C.MAP_FIELDS.forEach(function (k) { map[k] = c.map[k] === col ? -1 : c.map[k]; });
        if (field !== 'ignore') {
          map[field] = col;
          if (field === 'amount') { map.debit = -1; map.credit = -1; }
          if (field === 'debit' || field === 'credit') map.amount = -1;
        }
        state.opts.map = map;
        delete state.ai[field];
        rediagnose();
      });
    });
    var lab = $('#srcLabel');
    if (lab) lab.addEventListener('change', function () {
      var v = C.line(lab.value, C.LIMITS.labelChars);
      if (v && C.looksLikeData(v)) { toast('A name with no numbers, like “Riverton checking” - it is saved with your settings.', 4600); lab.value = state.file.label || ''; return; }
      state.file.label = v;
      var src = v ? C.sourceFor(state.settings, v) : null;
      if (src) { toast('Using what you told Feedfix about “' + src.label + '”.'); state.opts.order = src.order || state.opts.order; state.opts.flip = Boolean(src.flip); rediagnose(); }
      else if (v && (state.opts.order || state.opts.flip)) rememberSource({ order: state.opts.order || null, flip: state.opts.flip || null });
    });
    var cur = $('#curSel');
    if (cur) cur.addEventListener('change', function () { state.opts.currency = C.CURRENCIES.indexOf(cur.value) >= 0 ? cur.value : ''; refix(); });
    var flip = $('#flipBox');
    if (flip) flip.addEventListener('change', function () { state.opts.flip = flip.checked; rememberSource({ flip: flip.checked || null }); rediagnose(); });
    ['acctId', 'bankId', 'acctType'].forEach(function (k) {
      var el = $('#' + k);
      if (el) el.addEventListener('change', function () { state.opts.account[k] = C.line(el.value, 22); refix(); });
    });
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); go('start'); break;
      case 'tab': if (state.file) go(t.getAttribute('data-tab')); break;
      case 'demo': closeSheet(true); loadDemo(t.getAttribute('data-id')); break;
      case 'settings': openSettings(); break;
      case 'signin': openAccount(); break;
      case 'retrysync': pushSettings(); break;
      case 'ai': openAi(); break;
      case 'hintoff': state.device.hint = true; saveSoon(); keepPlace(draw); break;
      case 'ftoggle': { var i = +t.getAttribute('data-i'); state.open[i] = !state.open[i]; keepPlace(draw); var b = $('#f-' + i + ' .fhead'); if (b) try { b.focus({ preventScroll: true }); } catch (err) { /* ignore */ } break; }
      case 'gocheck': { var pr = $('.proof'); if (pr) pr.scrollIntoView({ block: 'start' }); break; }
      case 'gocols': { if (state.view !== 'check') go('check'); var cc = $('#colsCard'); if (cc) cc.scrollIntoView({ block: 'start' }); break; }
      case 'order': {
        var v = t.getAttribute('data-v');
        state.opts.order = v === 'dmy' ? 'dmy' : 'mdy';
        var kept = rememberSource({ order: state.opts.order });
        toast('Reading them as ' + (v === 'dmy' ? 'day/month' : 'month/day') + (kept ? ' - remembered for “' + state.file.label + '”.' : '.'));
        rediagnose();
        break;
      }
      case 'profile': {
        var k = t.getAttribute('data-k');
        if (!C.PROFILES[k]) break;
        state.opts.profile = k;
        state.opts.dateFormat = state.settings.dateFormats[k] || C.profileDates(k, DAY_FIRST);
        state.settings.profile = k; settingsChanged();
        refix();
        break;
      }
      case 'datefmt': { var f = t.getAttribute('data-v'); if (!C.DATE_FORMATS[f]) break; state.opts.dateFormat = f; state.settings.dateFormats[state.opts.profile] = f; settingsChanged(); refix(); break; }
      case 'undo': { var uk = t.getAttribute('data-k'); state.opts.undo[uk] = !state.opts.undo[uk]; if (!state.opts.undo[uk]) delete state.opts.undo[uk]; refix(); break; }
      case 'dups': state.opts.dropDuplicates = !state.opts.dropDuplicates; refix(); break;
      case 'unflip': state.opts.flip = false; rememberSource({ flip: null }); rediagnose(); break;
      case 'leaveout': {
        if (Object.keys(state.opts.leaveOut).length) state.opts.leaveOut = {};
        else state.diag.findings.forEach(function (fd) { if (fd.fix === 'leaveOut') fd.lines.forEach(function (n) { state.opts.leaveOut[n] = true; }); });
        refix();
        break;
      }
      case 'pv': state.preview = t.getAttribute('data-v') === 'original' ? 'original' : 'fixed'; keepPlace(draw); break;
      case 'dlfixed': if (state.fx && state.fx.bytes) { download(state.fx.fileName, state.fx.mime, state.fx.bytes); toast('Saved - made on this device.'); } break;
      case 'copyfixed': if (state.fx && state.fx.text) copy(state.fx.text, 'Copied the fixed file.'); break;
      case 'dlreport': download((state.fx && state.fx.fileName ? state.fx.fileName.replace(/\.[a-z]+$/, '') : 'feedfix') + '-report.md', 'text/markdown', reportText()); break;
      case 'copyreport': copy(reportText(), 'Copied the report.'); break;
      case 'dldups': if (state.fx) download((state.fx.fileName || 'feedfix').replace(/\.[a-z]+$/, '') + '-duplicates.csv', 'text/csv', C.duplicatesCsv(state.fx.dups)); break;
      case 'clearkept': forget(); state.keep = false; toast('Cleared from this device.'); openSettings(); break;
      default: break;
    }
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
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openAccountSheet();
  });
}());
