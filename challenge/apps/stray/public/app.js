/* Stray - the page. One file, no build step.
 *
 * EVERY PAYMENT AND ACCOUNT STAYS ON THIS DEVICE. The two files are read in
 * a worker (stray-worker.js) - or here when there is none - by StrayCore,
 * matched there, decided here, and exported as files this browser saves.
 * Nothing about a payment is ever sent anywhere. The requests this page
 * makes: sign-in, the account's settings (header names and preferences
 * only), and the two optional AI calls, whose payloads are shown in full
 * before they are sent - a situation code, or header names and shape codes.
 *
 * Browser storage is opt-in for anything from a file: "Keep this session on
 * this device" (off by default, with Clear). Settings and this device's own
 * preferences (initials, phone line, a dismissed hint) hold no payment data
 * and are remembered here. Every access is wrapped in try/catch.
 *
 * Every string a file held, a person typed, the server sent or a model wrote
 * is escaped before it is drawn, and no handler is written into markup:
 * clicks are routed by data-act attributes from one listener (the lab's CSP
 * allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.StrayCore;
  var D = window.StrayDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural, money = C.money;
  var VW = C.VERDICT_WORD, VI = C.VERDICT_ICON;
  var K_SETTINGS = 'stray-settings-v1', K_DEVICE = 'stray-device-v1', K_SESSION = 'stray-session-v1';
  var KINDS = ['payments', 'accounts'];

  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function clock(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

  var device = recall(K_DEVICE) || {};
  var state = {
    me: null,
    view: 'start',
    today: today(),
    settings: C.cleanSettings(recall(K_SETTINGS) || {}).settings,
    device: { initials: C.line(device.initials, C.LIMITS.initialsChars), phone: C.line(device.phone, 40), keep: device.keep === true, hint: device.hint === true, syncBase: typeof device.syncBase === 'number' ? device.syncBase : null },
    syncState: 'local',
    demo: false,
    files: { payments: null, accounts: null },
    paste: { payments: false, accounts: false },
    loaded: false,
    payments: [], accounts: [], results: [], byId: {}, resById: {}, skippedP: [], skippedA: [],
    decisions: {}, notes: {}, rejected: {},
    pending: null,          // decisions kept from a session too big to keep whole, waiting for the same files
    filter: 'open', age: null, sort: 'file', shown: 50,
    sel: null, detail: false,
    busy: null,
    fileErr: { payments: '', accounts: '' },
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
  function download(name, type, text) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function isWide() { return matchMedia('(min-width: 1000px)').matches; }
  function saveDevice() { keep(K_DEVICE, state.device); }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Matching stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
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
    var w = null, seq = 0, waits = {}, local = null, onProgress = null;
    try {
      if (window.Worker) {
        w = new Worker('stray-worker.js');
        w.addEventListener('message', function (e) {
          var m = e.data || {};
          var p = waits[m.id];
          if (!p) return;
          if (m.progress) { if (p.progress) p.progress(m.progress.done, m.progress.total); return; }
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
    function here(op, data, progress) {
      if (!local) local = C.createEngine();
      if (op === 'parse' && data.file) {
        if (data.file.size > C.LIMITS.fileBytes) return Promise.reject(new Error('That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Export fewer rows, or split it.'));
        return data.file.text().then(function (text) { return local.parse({ kind: data.kind, name: data.file.name, text: text }); });
      }
      return new Promise(function (resolve, reject) { setTimeout(function () { try { resolve(local[op](data, progress)); } catch (err) { reject(err); } }, 0); });
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
      inWorker: function () { return Boolean(w); },
    };
  }());

  /* ---------------- settings: on this device, and in the account ---------------- */

  var pushTimer = null;
  function saveSettings(rematch) {
    state.settings.updatedAt = Date.now();
    keep(K_SETTINGS, state.settings);
    if (signedIn() && state.me.sync) {
      clearTimeout(pushTimer);
      state.syncState = 'syncing'; drawSync();
      pushTimer = setTimeout(function () { pushSettings(0); }, 600);
    }
    if (rematch && state.loaded) relink();
  }
  function setBase(b) { state.device.syncBase = b; saveDevice(); }
  function pushSettings(tries) {
    if (!signedIn()) return Promise.resolve();
    return api('PUT', 'api/settings', { settings: state.settings, base: state.device.syncBase }).then(function (r) {
      state.settings = C.cleanSettings(r.settings).settings; keep(K_SETTINGS, state.settings); setBase(r.settings.updatedAt);
      state.syncState = 'synced'; drawSync();
    }).catch(function (err) {
      if (err.status === 409 && err.data && err.data.settings && tries < 2) {
        state.settings = C.mergeSettings(err.data.settings, state.settings);
        setBase(err.data.settings.updatedAt);
        return pushSettings(tries + 1);
      }
      state.syncState = 'error'; drawSync();
    });
  }
  function syncIn() {
    if (!signedIn() || !state.me.sync) return Promise.resolve();
    state.syncState = 'syncing'; drawSync();
    return api('GET', 'api/settings').then(function (r) {
      if (!r.settings) { setBase(null); return state.settings.updatedAt ? pushSettings(0) : (state.syncState = 'synced', drawSync()); }
      var before = JSON.stringify(Object.assign({}, state.settings, { updatedAt: 0 }));
      var merged = state.settings.updatedAt ? C.mergeSettings(r.settings, state.settings) : C.cleanSettings(r.settings).settings;
      setBase(r.settings.updatedAt);
      var changed = JSON.stringify(Object.assign({}, merged, { updatedAt: 0 })) !== JSON.stringify(Object.assign({}, C.cleanSettings(r.settings).settings, { updatedAt: 0 }));
      state.settings = merged; keep(K_SETTINGS, state.settings);
      var matching = before !== JSON.stringify(Object.assign({}, merged, { updatedAt: 0 }));
      if (matching && state.loaded) relink();
      if (changed) return pushSettings(0);
      state.syncState = 'synced'; drawSync();
      return null;
    }).catch(function () { state.syncState = 'error'; drawSync(); });
  }
  function syncLine() {
    if (!signedIn()) return '<span class="sync muted small">Settings are kept on this device · <button class="link-btn" type="button" data-act="signin-sync">sign in to keep them in your account</button></span>';
    if (state.me && !state.me.sync) return '<span class="sync muted small">Settings are kept on this device (saving to the account is unavailable right now)</span>';
    if (state.syncState === 'syncing') return '<span class="sync muted small">Saving settings…</span>';
    if (state.syncState === 'error') return '<span class="sync small err">Couldn’t save settings to your account - they are on this device. <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="sync small" style="color:var(--match);font-weight:700">✓ Settings saved to your account - never a payment, name or amount</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }

  /* ---------------- the session: only if asked ---------------- */

  function stripAccount(a) { var o = {}; Object.keys(a).forEach(function (k) { if (k !== 'key') o[k] = a[k]; }); return o; }
  /** Returns 'whole', 'decisions' (too big to keep the files) or 'failed'. */
  function saveSession() {
    if (!state.device.keep || !state.loaded) return '';
    var small = { v: 1, demo: state.demo, today: state.today, names: KINDS.map(function (k) { return state.files[k] ? state.files[k].name : ''; }), decisions: state.decisions, notes: state.notes, rejected: state.rejected, savedAt: Date.now() };
    if (state.demo) return keep(K_SESSION, small) ? 'whole' : 'failed';
    var whole = Object.assign({ payments: state.payments, accounts: state.accounts.map(stripAccount) }, small);
    if (keep(K_SESSION, whole)) return 'whole';
    if (keep(K_SESSION, small)) { if (!state.toldBig) { state.toldBig = true; toast('These files are too big to keep whole on this device - your decisions and notes are kept, and come back when you load the same files.', 6000); } return 'decisions'; }
    toast('This browser would not keep the session - it is still open here.', 4200);
    return 'failed';
  }
  function clearSession() { keep(K_SESSION, null); state.pending = null; }

  /* ---------------- routing ---------------- */

  function go(hash) {
    history.pushState(null, '', BASE + '#' + hash);
    route(); scrollTo(0, 0);
  }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    var m;
    state.detail = false;
    if ((m = /^p\/(.+)$/.exec(h)) && state.loaded) {
      var id = decodeURIComponent(m[1]);
      if (state.byId[id]) {
        state.sel = id; state.detail = true; state.view = 'queue';
        // A link to one payment always shows it, whatever the filter was.
        if (!ordered().some(function (p) { return p.id === id; })) { state.filter = 'all'; state.age = null; }
        return draw();
      }
    }
    if (h === 'files') state.view = 'files';
    else if ((h === 'queue' || h === 'export') && state.loaded) state.view = h;
    else if (h === 'queue' || h === 'export') state.view = 'files';
    else state.view = 'start';
    draw();
  }
  window.addEventListener('popstate', route);
  matchMedia('(min-width: 1000px)').addEventListener('change', function () { if (state.view === 'queue') draw(); });

  function draw() {
    closeSheet(true);
    var main = $('#main');
    var showTabs = state.view !== 'start' && (state.loaded || state.view === 'files');
    $('#tabbar').hidden = !showTabs;
    $$('#tabbar [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var html;
    if (state.view === 'files') html = filesHtml();
    else if (state.view === 'queue') html = queueHtml();
    else if (state.view === 'export') html = exportHtml();
    else html = startHtml();
    main.innerHTML = html;
    wire();
    $$('.bar > i[data-w]').forEach(function (b) { b.style.width = (state.lastPct || 0) + '%'; });
    requestAnimationFrame(function () { $$('.bar > i[data-w]').forEach(function (b) { b.style.width = b.getAttribute('data-w') + '%'; state.lastPct = +b.getAttribute('data-w'); }); });
  }

  function footer() {
    return '<footer class="foot"><p>Stray proposes; a person accepts every posting. Payments and accounts never leave this device.</p><p>A Challenge Lab trial · <a href="../">more experiments</a></p></footer>';
  }
  function vpill(v, word) { return '<span class="vp vp-' + esc(v) + '"><span aria-hidden="true">' + (VI[v] || '•') + '</span>' + esc(word || VW[v] || v) + '</span>'; }
  function payerOf(p) { return p.payer || 'an unnamed payer'; }
  function nameOf(i) { var a = state.accounts[i]; return a ? C.titleCase(a.borrower) : ''; }
  function acctOf(i) { return state.accounts[i]; }

  /* ---------------- first run ---------------- */

  function mockHtml() {
    return '<div class="mock" aria-hidden="true"><div class="mh"><b>$533.18 from OKAFOR WM</b><span class="mv">✓ Match</span></div><div class="mto">Goes to 107264 · William Okafor</div><ul>' +
      '<li><span class="m-ok">✓</span><span>Name matches with a nickname: <mark>Wm</mark> is short for William</span></li>' +
      '<li><span class="m-ok">✓</span><span>Amount is the scheduled payment, $533.18</span></li>' +
      '<li><span class="m-ok">✓</span><span>Received on the due day (the 24th)</span></li>' +
      '<li><span class="m-no">·</span><span>No account number given, and none in the memo</span></li></ul></div>';
  }
  function startHtml() {
    var h = '<section class="hero">' + mockHtml() +
      '<p class="kicker"><span aria-hidden="true">🧭</span> Suspense, sorted</p>' +
      '<h1>Every stray payment home to the right account.</h1>' +
      '<p>Stray reads your suspense list against your account list and shows where each payment belongs - and the reason it belongs there.</p>' +
      '<div class="btns"><button class="btn primary big" type="button" data-act="demo">Try the demo</button><button class="btn ghost big" type="button" data-act="own">Use my own files</button></div>' +
      '<p class="small" style="margin:10px 0 0;color:#dbe8ef">Your own files: a suspense list and an account list, as CSV or TSV - <a href="#cols" style="color:#ffd8a8">the columns it looks for</a>.</p>' +
      (state.pending ? '<p class="small" style="margin-top:12px;color:#ffd8a8">Your decisions on ' + esc(plural(Object.keys(state.pending.decisions || {}).length, 'payment')) + ' are kept on this device - load the same files to pick up where you left off.</p>' : '') +
      (state.loaded ? '<p style="margin-top:12px"><button class="btn small ghost" type="button" data-act="tab" data-tab="queue">Back to the work queue</button></p>' : '') +
      '<div class="trust"><span class="ico" aria-hidden="true">🔒</span><div><b>Nothing leaves this device.</b> Payments, names and account numbers are read here and never uploaded - not to this site, not to an AI.</div></div></section>';
    h += '<div class="grid3 how" style="margin-top:14px">' +
      [['📥', 'Two files in', 'Your suspense list and your account list, as CSV or TSV - any columns, any order. Stray guesses which column is which; you check the guess.'],
       ['🔎', 'Every payment, scored', 'Account numbers a digit off or swapped, the number in the memo, nicknames and initials, co-borrowers, the amount, the due day - each with the reason.'],
       ['✅', 'You decide, then export', 'Accept, pick another or set aside for research - one key each on a desktop. Then a posting file for your servicing system, a research list and the day’s summary.']].map(function (s, i) {
        return '<div class="card"><div class="n" aria-hidden="true">' + (i + 1) + '</div><h2><span aria-hidden="true">' + s[0] + '</span> ' + esc(s[1]) + '</h2><p>' + esc(s[2]) + '</p></div>';
      }).join('') + '</div>';
    h += '<section class="card" style="margin-top:14px"><p class="lab">What it notices</p><ul class="chips">' +
      ['🔢 Two digits swapped', '1️⃣ One digit wrong', '0️⃣ Leading zeros and dashes', '📝 The number hiding in the memo', '👤 OKAFOR WM = William Okafor', '👥 The co-borrower paying', '📆 Two months at once', '🏁 A payoff', '🏠 One check for two household loans', '🏢 A business paying for its owner', '⚖️ Two possible accounts, told apart', '🧾 An invoice number, for receivables'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>';
    h += '<section class="card" style="margin-top:14px" id="cols" tabindex="-1"><p class="lab">The columns it looks for</p><div class="cols">' +
      KINDS.map(function (k) {
        return '<div><b>' + (k === 'payments' ? 'The suspense list' : 'The account list') + '</b><ul class="small">' + C.FIELDS[k].map(function (f) { return '<li>' + esc(f.label) + (f.need ? ' <span class="muted">(needed)</span>' : '') + '</li>'; }).join('') + '</ul></div>';
      }).join('') + '</div><p class="small muted" style="margin:10px 0 0">Any header names, in any order. Dates and amounts in the usual export formats - $1,234.56, 1234.56, 1.234,56; 10/05/2026, 2026-10-05, Oct 5, 2026.</p></section>';
    h += '<div class="privacy-line"><span aria-hidden="true">🤝</span><div><b>Rules, not a robot.</b> Stray only proposes. A person accepts every posting, sees exactly which signals hit and which didn’t, and can always pick another account.</div></div>';
    return h + footer();
  }

  /* ---------------- the demo, and your own files ---------------- */

  function resetData() {
    state.loaded = false; state.payments = []; state.accounts = []; state.results = []; state.byId = {}; state.resById = {};
    state.decisions = {}; state.notes = {}; state.rejected = {}; state.skippedP = []; state.skippedA = [];
    state.sel = null; state.filter = 'open'; state.age = null; state.shown = 50; state.demo = false;
    state.files = { payments: null, accounts: null };
  }
  function adopt(out) {
    state.payments = out.payments; state.accounts = out.accounts; state.results = out.results;
    state.skippedP = out.skippedP || []; state.skippedA = out.skippedA || [];
    state.byId = {}; state.resById = {};
    state.payments.forEach(function (p) { state.byId[p.id] = p; });
    state.results.forEach(function (r) { state.resById[r.id] = r; });
    state.loaded = true;
  }
  function startDemo(kept) {
    resetData();
    state.busy = { label: 'Opening the made-up example…', done: 0, total: 0 };
    var f = D.files(state.today);
    var got = {};
    Promise.all(KINDS.map(function (k) {
      return engine.run('parse', { kind: k, text: f[k].text, name: f[k].name }).then(function (out) { got[k] = fileState(out); });
    })).then(function () {
      state.files = got;
      return engine.run('prepare', { payMap: got.payments.map, accMap: got.accounts.map, settings: state.settings, rejected: (kept && kept.rejected) || {} });
    }).then(function (out) {
      adopt(out);
      state.demo = true;
      if (kept) { state.decisions = kept.decisions || {}; state.notes = kept.notes || {}; state.rejected = kept.rejected || {}; }
      state.busy = null;
      state.sel = firstOpen();
      saveSession();
      if (kept && /^#(queue|export|files|p\/)/.test(location.hash)) route(); else go('queue');
    }).catch(function (err) { state.busy = null; toast(err.message, 5000); });
  }
  function fileState(out) {
    var preset = C.applyPreset(out.kind, out.headers, state.settings.presets);
    var sure = {};
    C.fieldKeys(out.kind).forEach(function (k) { sure[k] = preset ? (preset[k] >= 0 ? 'saved' : 'none') : (out.guess.map[k] >= 0 ? out.guess.sure[k] : 'none'); });
    return { kind: out.kind, name: out.name, headers: out.headers, sample: out.sample, guess: out.guess, stats: out.stats, layout: out.layout, map: preset || Object.assign({}, out.guess.map), sure: sure, preset: Boolean(preset) };
  }
  function readFile(kind, file) {
    state.fileErr[kind] = '';
    if (!file) return;
    if (file.size > C.LIMITS.fileBytes) { state.fileErr[kind] = 'That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Export fewer rows, or split it.'; draw(); return; }
    state.busy = { label: 'Reading ' + file.name + '…', done: 0, total: 0, kind: kind };
    draw();
    engine.run('parse', { kind: kind, file: file }).then(function (out) { took(kind, out); }).catch(function (err) { state.busy = null; state.fileErr[kind] = err.message; draw(); });
  }
  function readText(kind, text) {
    state.fileErr[kind] = '';
    if (!C.line(text, 10)) { state.fileErr[kind] = 'Paste the rows first - with the header line.'; draw(); return; }
    if (text.length > C.LIMITS.fileBytes) { state.fileErr[kind] = 'That is too much to paste - choose the file instead.'; draw(); return; }
    state.busy = { label: 'Reading what you pasted…', done: 0, total: 0, kind: kind };
    draw();
    engine.run('parse', { kind: kind, text: text, name: kind === 'payments' ? 'Pasted suspense list' : 'Pasted account list' }).then(function (out) { took(kind, out); }).catch(function (err) { state.busy = null; state.fileErr[kind] = err.message; draw(); });
  }
  function took(kind, out) {
    state.busy = null;
    if (out.stats.empty || !out.headers.length) { state.fileErr[kind] = 'That file has no rows Stray could read.'; draw(); return; }
    if (state.loaded) {
      // Decisions wait for the next match: the same payment IDs get them back.
      state.pending = { decisions: state.decisions, notes: state.notes, rejected: {}, names: KINDS.map(function (k) { return state.files[k] ? state.files[k].name : ''; }) };
      var keepFiles = state.files; resetData(); state.files = keepFiles;
    }
    state.files[kind] = fileState(out);
    state.paste[kind] = false;
    draw();
    var el = $('#file-' + kind); if (el) el.scrollIntoView({ block: 'start' });
  }
  function matchNow() {
    var f = state.files;
    if (!f.payments || !f.accounts) return;
    var problems = C.mappingProblems('payments', f.payments.map).concat(C.mappingProblems('accounts', f.accounts.map));
    if (problems.length) { toast(problems[0], 4200); return; }
    state.busy = { label: 'Matching…', done: 0, total: f.payments.stats.kept };
    draw();
    var pending = state.pending || (state.loaded ? { decisions: state.decisions, notes: state.notes, rejected: state.rejected } : null);
    engine.run('prepare', { payMap: f.payments.map, accMap: f.accounts.map, settings: state.settings, rejected: (pending && pending.rejected) || {} }, function (done, total) {
      state.busy = { label: 'Matching…', done: done, total: total };
      var pb = $('#busyBar'); if (pb) pb.style.width = Math.round(done / Math.max(1, total) * 100) + '%';
      var pl = $('#busyLine'); if (pl) pl.textContent = 'Matching… ' + done.toLocaleString() + ' of ' + total.toLocaleString();
    }).then(function (out) {
      adopt(out);
      state.demo = false;
      var n = 0;
      if (pending) {
        Object.keys(pending.decisions || {}).forEach(function (id) { if (state.byId[id]) { state.decisions[id] = pending.decisions[id]; n++; } });
        Object.keys(pending.notes || {}).forEach(function (id) { if (state.byId[id]) state.notes[id] = pending.notes[id]; });
        state.rejected = pending.rejected || {};
        state.pending = null;
      }
      state.busy = null;
      state.sel = firstOpen();
      state.toldBig = Boolean(n);
      saveSession();
      go('queue');
      if (n) toast('Picked up ' + plural(n, 'decision') + ' you made on these payments.', 4200);
    }).catch(function (err) { state.busy = null; toast(err.message, 5000); draw(); });
  }
  function relink() {
    var sel = state.sel;
    engine.run('relink', { settings: state.settings, rejected: state.rejected }).then(function (out) {
      state.results = out.results; state.resById = {};
      state.results.forEach(function (r) { state.resById[r.id] = r; });
      state.sel = sel;
      if (state.view === 'queue' || state.view === 'export') draw();
      toast('Matched again with the new settings.');
    }).catch(function (err) { toast(err.message, 4200); });
  }

  /* ---------------- the files view ---------------- */

  function statNotes(f) {
    var s = f.stats, out = [];
    if (f.preset) out.push('Used your saved layout for these headers.');
    if (!s.header) out.push('No header row - the columns are numbered. Choose what each one is below.');
    if (s.preamble) out.push('Skipped ' + plural(s.preamble, 'line') + ' above the header (a report title?).');
    if (s.truncated) out.push('Read the first ' + s.kept.toLocaleString() + ' ' + (f.kind === 'payments' ? 'payments' : 'accounts') + '; ' + s.truncated.toLocaleString() + ' more ' + (s.truncated === 1 ? 'was' : 'were') + ' left out. Split the file to do the rest.');
    if (s.ragged) out.push(plural(s.ragged, 'row') + ' had more or fewer cells than the header - padded or cut to fit.');
    if (s.invisible) out.push('Removed ' + plural(s.invisible, 'invisible character') + ' (control, zero-width or text-direction characters).');
    if (s.cut) out.push(plural(s.cut, 'cell') + ' longer than ' + C.LIMITS.cell + ' characters ' + (s.cut === 1 ? 'was' : 'were') + ' cut short.');
    if (s.wide) out.push('Only the first ' + C.LIMITS.columns + ' columns are read; ' + s.wide + ' more were left out.');
    if (s.openQuote) out.push('A quote mark was never closed - the end of the file may have been read as one cell.');
    return out;
  }
  function colLetter(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  var SURE_WORD = { sure: '✓ Sure', likely: 'Likely', unsure: '? Check this', none: 'Not used', you: '✓ You chose', saved: '✓ Saved layout', ai: '✨ AI’s pick' };
  function fileCard(kind) {
    var f = state.files[kind];
    var title = kind === 'payments' ? '1 · The suspense list' : '2 · The account list';
    var sub = kind === 'payments' ? 'The payments you can’t yet apply.' : 'Your loan or customer accounts - everything a payment could belong to.';
    var h = '<section class="card stack" id="file-' + kind + '"><div class="sec-head"><h2>' + esc(title) + '</h2>' + (f ? '<span class="small muted">' + esc(sub) + '</span>' : '') + '</div>';
    var busyHere = state.busy && state.busy.kind === kind;
    if (!f) {
      h += '<p class="muted" style="margin:0">' + esc(sub) + '</p>';
      if (busyHere) return h + busyHtml() + '</section>';
      h += '<div class="drop" data-drop="' + kind + '"><p style="margin:0"><b>Drop a CSV or TSV file here</b>, or</p><div class="btns"><label class="btn filepick">Choose a file<input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" data-file="' + kind + '"></label><button class="btn ghost" type="button" data-act="pastetoggle" data-k="' + kind + '">' + (state.paste[kind] ? 'Hide the paste box' : 'Paste it instead') + '</button></div>';
      if (state.paste[kind]) h += '<label class="field" style="width:100%"><span>Paste the rows, with the header line</span><textarea class="input code" rows="6" id="paste-' + kind + '" spellcheck="false" autocapitalize="off"></textarea></label><button class="btn small" type="button" data-act="pasteread" data-k="' + kind + '">Read it</button>';
      h += '<p class="small muted" style="margin:0">Expected: ' + esc(C.FIELDS[kind].map(function (x) { return x.label.toLowerCase(); }).join(', ')) + '. Comma, semicolon, tab or pipe separated; quotes and a header line as any export writes them.</p></div>';
      if (state.fileErr[kind]) h += '<p class="err" role="alert">' + esc(state.fileErr[kind]) + '</p>';
      return h + '</section>';
    }
    h += '<div class="fileline"><div><b>📄 ' + esc(f.name) + '</b><div class="small muted">' + esc(f.stats.kept.toLocaleString()) + ' ' + (kind === 'payments' ? 'payments' : 'accounts') + ' · ' + esc(f.stats.delimiter || 'comma') + '-separated · ' + esc(plural(f.headers.length, 'column')) + '</div></div>' +
      (f.demo || state.demo ? '<span class="vp vp-done">Made-up example</span>' : '<div class="btns"><label class="btn small ghost filepick">Replace<input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" data-file="' + kind + '"></label><button class="btn small ghost" type="button" data-act="rmfile" data-k="' + kind + '">Remove</button></div>') + '</div>';
    var notes = statNotes(f);
    if (notes.length) h += '<ul class="notes">' + notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
    if (state.fileErr[kind]) h += '<p class="err" role="alert">' + esc(state.fileErr[kind]) + '</p>';
    h += '<p class="lab" style="margin:4px 0 0">Which column is which</p>';
    var allSure = C.mappingProblems(kind, f.map).length === 0 && C.fieldKeys(kind).every(function (k) { return f.map[k] < 0 || ['sure', 'saved', 'you'].indexOf(f.sure[k]) >= 0; });
    if (allSure && !f.open) {
      var mapped = C.FIELDS[kind].filter(function (fd) { return f.map[fd.key] >= 0; }), unused = C.FIELDS[kind].filter(function (fd) { return f.map[fd.key] < 0; });
      h += '<div class="mapsum"><p style="margin:0"><b>✓ ' + (f.preset ? 'Your saved layout fits this file' : 'Every column recognised') + '</b></p><ul class="mapchips">' + mapped.map(function (fd) { return '<li><span class="muted">' + esc(fd.label) + '</span> <b>' + esc(colLetter(f.map[fd.key]) + ' · ' + f.headers[f.map[fd.key]]) + '</b></li>'; }).join('') + '</ul>' +
        (unused.length ? '<p class="small muted" style="margin:0">Not in this file: ' + esc(unused.map(function (fd) { return fd.label.toLowerCase(); }).join(', ')) + '.</p>' : '') +
        '<button class="btn small ghost" type="button" data-act="mapopen" data-k="' + kind + '">Check or change the columns</button></div>';
    } else {
    if (f.guess.unsure && !f.preset) h += '<p class="small" style="margin:0;color:var(--check);font-weight:700">Stray isn’t sure about some of these - check the ones marked “? Check this”.</p>';
    h += '<div class="maprows">' + C.FIELDS[kind].map(function (fd) {
      var cur = f.map[fd.key];
      var opts = '<option value="-1"' + (cur < 0 ? ' selected' : '') + '>— not in this file —</option>' + f.headers.map(function (hd, i) { return '<option value="' + i + '"' + (cur === i ? ' selected' : '') + '>' + esc(colLetter(i) + ' · ' + hd) + '</option>'; }).join('');
      var s = cur < 0 ? 'none' : (f.sure[fd.key] || 'unsure');
      var cls = s === 'you' || s === 'saved' || s === 'ai' ? 'sure' : s;
      return '<div class="maprow"><div class="fl"><b>' + esc(fd.label) + (fd.need ? '<span class="need">needed</span>' : '') + '</b><small>' + esc(fd.hint) + '</small></div>' +
        '<label class="vh" for="map-' + kind + '-' + fd.key + '">' + esc(fd.label) + '</label><select class="input" id="map-' + kind + '-' + fd.key + '" data-map="' + kind + '" data-field="' + fd.key + '">' + opts + '</select>' +
        '<span class="sure sure-' + esc(cls) + '">' + esc(SURE_WORD[s] || s) + '</span></div>';
    }).join('') + '</div>';
    }
    var used = {};
    Object.keys(f.map).forEach(function (k) { if (f.map[k] >= 0) used[f.map[k]] = C.fieldOf(kind, k).label; });
    h += '<details class="why"' + (f.guess.unsure ? ' open' : '') + '><summary>Preview the first rows</summary><div class="tablewrap" tabindex="0"><table class="prev"><thead><tr>' + f.headers.map(function (hd, i) { return '<th><span class="fchip' + (used[i] ? '' : ' off') + '">' + esc(used[i] || 'not used') + '</span>' + esc(colLetter(i) + ' · ' + hd) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      f.sample.slice(0, 6).map(function (r) { return '<tr>' + f.headers.map(function (_, i) { return '<td title="' + esc(r[i] || '') + '">' + esc(r[i] || '') + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div></details>';
    h += '<div class="btns"><button class="btn small ai" type="button" data-act="mapai" data-k="' + kind + '">✨ Help me map these columns</button><button class="btn small ghost" type="button" data-act="savelayout" data-k="' + kind + '">Remember this layout</button></div>';
    h += '<p class="small muted" style="margin:0">The helper is sent only the column headers and their shapes - never a value. A remembered layout keeps header names only.</p>';
    return h + '</section>';
  }
  function busyHtml() {
    var b = state.busy;
    var pct = b.total ? Math.round(b.done / b.total * 100) : 0;
    return '<div class="progress" role="status"><p id="busyLine" style="margin:0;font-weight:700">' + esc(b.label) + '</p><div class="bar"><i id="busyBar" style="width:' + (b.total ? pct : 35) + '%"></i></div><p class="small muted" style="margin:0">On this device' + (engine.inWorker() ? ', in the background' : '') + ' - nothing is uploaded.</p></div>';
  }
  function filesHtml() {
    var h = '';
    if (state.demo) h += '<div class="sample-strip" role="note"><p><b>Made-up example:</b> ' + esc(D.NAME) + ' - every name and number invented. These are the two files it was read from.</p><div class="btns"><button class="btn small" type="button" data-act="own">Use my own files instead</button></div></div>';
    else h += '<div class="sec-head"><h1>Your two files</h1><span class="small muted">🔒 Read on this device - nothing is uploaded</span></div>';
    if (state.pending) h += '<div class="note" style="margin-bottom:14px"><p style="margin:0">Your decisions on <b>' + esc(plural(Object.keys(state.pending.decisions || {}).length, 'payment')) + '</b> from ' + esc((state.pending.names || []).filter(Boolean).join(' and ') || 'your last session') + ' are kept on this device. Load the same files and they come back.</p><button class="link-btn" type="button" data-act="clearsession">Forget them</button></div>';
    h += '<div class="grid2">' + fileCard('payments') + fileCard('accounts') + '</div>';
    var f = state.files;
    h += '<section class="card stack" style="margin-top:14px">';
    if (state.busy && !state.busy.kind) h += busyHtml();
    else if (!f.payments || !f.accounts) h += '<p style="margin:0" class="muted">Load both files, check the columns, then match.</p><div class="btns"><button class="btn big" type="button" disabled>Match payments</button></div>' +
      '<p class="small muted" style="margin:0">Want to see the shape first? Download the made-up example’s <button class="link-btn" type="button" data-act="dlsample" data-k="payments">suspense list</button> and <button class="link-btn" type="button" data-act="dlsample" data-k="accounts">account list</button>.</p>';
    else {
      var probs = C.mappingProblems('payments', f.payments.map).map(function (x) { return 'Suspense list: ' + x; }).concat(C.mappingProblems('accounts', f.accounts.map).map(function (x) { return 'Account list: ' + x; }));
      if (probs.length) h += '<ul class="notes" style="color:var(--none)">' + probs.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
      h += '<div class="btns"><button class="btn big" type="button" data-act="match"' + (probs.length ? ' disabled' : '') + '>Match ' + esc(plural(f.payments.stats.kept, 'payment')) + ' against ' + esc(plural(f.accounts.stats.kept, 'account')) + '</button>' + (state.loaded ? '<button class="btn big ghost" type="button" data-act="tab" data-tab="queue">Back to the queue</button>' : '') + '</div>';
      h += '<p class="small muted" style="margin:0">Matching again keeps what you already decided, by payment ID.</p>';
    }
    h += '</section>';
    return h + footer();
  }

  /* ---------------- the queue ---------------- */

  function decOf(id) { return state.decisions[id] || null; }
  function isOut(id) { return C.isOut(decOf(id)); }
  function inFilter(p) {
    var r = state.resById[p.id], d = decOf(p.id);
    if (state.age) { var b = C.bucketOf(C.ageOf(p, state.today)); if (b !== state.age || C.isOut(d)) return false; }
    switch (state.filter) {
      case 'open': return !d;
      case 'all': return true;
      case 'decided': return Boolean(d);
      default: return r && r.verdict === state.filter;
    }
  }
  function ordered() {
    var list = state.payments.filter(inFilter);
    if (state.sort === 'oldest') list = list.slice().sort(function (a, b) { return (C.ageOf(b, state.today) || 0) - (C.ageOf(a, state.today) || 0); });
    else if (state.sort === 'largest') list = list.slice().sort(function (a, b) { return b.cents - a.cents; });
    return list;
  }
  function firstOpen() { var l = state.payments.filter(function (p) { return !decOf(p.id); }); return l.length ? l[0].id : (state.payments[0] && state.payments[0].id) || null; }
  function counts() {
    var c = { open: 0, all: state.payments.length, decided: 0 };
    C.VERDICTS.forEach(function (v) { c[v] = 0; });
    state.payments.forEach(function (p) { var r = state.resById[p.id]; if (r) c[r.verdict]++; if (decOf(p.id)) c.decided++; else c.open++; });
    return c;
  }
  function meterHtml() {
    var m = C.meter(state.payments, state.decisions);
    var ag = C.ageing(state.payments, state.decisions, state.today, state.settings.ageLimitDays);
    var oldestKey = ag.oldest ? C.bucketOf(ag.oldest.days) : null;
    var allDone = m.n && m.done + m.held === m.n;
    var h = '<section class="card meter" aria-label="Progress">';
    h += '<p class="big num">' + esc(money(m.out)) + ' <span>of ' + esc(money(m.total)) + ' out of suspense</span></p>';
    h += '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + m.pct + '" aria-label="Dollars out of suspense"><i data-w="' + m.pct + '"></i></div>';
    h += '<p class="small" style="margin:0"><b>' + m.done + ' of ' + esc(plural(m.n, 'payment')) + '</b> posted' + (m.held ? ' · ' + m.held + ' held for research' : '') + ' · ' + esc(String(m.pct)) + '% of the dollars</p>';
    h += '<div class="ageing" role="group" aria-label="Days in suspense, still open">' + ag.buckets.map(function (b) {
      var on = state.age === b.key;
      return '<button class="age' + (b.key === oldestKey ? ' oldest' : '') + '" type="button" data-act="age" data-a="' + b.key + '" aria-pressed="' + on + '"><span>' + esc(b.label) + '</span><b class="num">' + b.count + '</b><span class="num">' + esc(money(b.cents)) + '</span>' + (b.key === oldestKey ? '<em>Oldest is here</em>' : '') + '</button>';
    }).join('') + '</div>';
    if (ag.oldest) h += '<p class="oldline">Oldest still open: <span class="hot">' + esc(plural(ag.oldest.days, 'day')) + '</span> - ' + esc(money(ag.oldest.cents)) + ' from ' + esc(ag.oldest.payer || 'an unnamed payer') + ' <button class="link-btn" type="button" data-act="sel" data-id="' + esc(ag.oldest.id) + '">Open it</button>' +
      (ag.over ? ' · <span class="over">' + esc(plural(ag.over, 'payment')) + ' past your ' + esc(String(ag.limit)) + '-day limit</span>' : ' · nothing past your ' + esc(String(ag.limit)) + '-day limit') + ' <button class="link-btn" type="button" data-act="settings">Change</button></p>';
    if (ag.undated) h += '<p class="small muted" style="margin:4px 0 0">' + esc(plural(ag.undated, 'payment')) + ' had no date the file could give.</p>';
    if (allDone) h += '<div class="decided-bar" style="margin-top:6px"><p>🎉 Every payment has a decision. ' + esc(money(m.out)) + ' comes out of suspense.</p><button class="btn small" type="button" data-act="tab" data-tab="export">Export the posting file</button></div>';
    return h + '</section>';
  }
  function filtersHtml() {
    var c = counts();
    var items = [['open', 'Open'], ['all', 'All']].concat(C.VERDICTS.map(function (v) { return [v, VI[v] + ' ' + VW[v]]; })).concat([['decided', 'Decided']]);
    var h = '<div class="filters" role="group" aria-label="Show">' + items.map(function (x) { return '<button type="button" data-act="filter" data-f="' + x[0] + '" aria-pressed="' + (state.filter === x[0]) + '">' + esc(x[1]) + ' <span class="n">' + c[x[0]] + '</span></button>'; }).join('') + '</div>';
    h += '<div class="row spread" style="margin-top:2px"><div class="legend" aria-hidden="true"><span><kbd>J</kbd> <kbd>K</kbd> next · previous</span><span><kbd>A</kbd> accept</span><span><kbd>X</kbd> not this</span><span><kbd>P</kbd> pick another</span><span><kbd>N</kbd> note</span></div>' +
      '<label class="row small" style="gap:6px"><span class="muted">Order</span><select class="input" id="sortSel" style="width:auto;min-height:44px;padding:6px 10px"><option value="file"' + (state.sort === 'file' ? ' selected' : '') + '>As in the file</option><option value="oldest"' + (state.sort === 'oldest' ? ' selected' : '') + '>Oldest first</option><option value="largest"' + (state.sort === 'largest' ? ' selected' : '') + '>Largest first</option></select></label></div>';
    if (state.age) h += '<p class="small" style="margin:6px 0 0">Showing open payments ' + esc(C.AGE_BUCKETS.filter(function (b) { return b.key === state.age; })[0].label) + ' in suspense. <button class="link-btn" type="button" data-act="age" data-a="' + esc(state.age) + '">Show every age</button></p>';
    return h;
  }
  function rowHtml(p) {
    var r = state.resById[p.id], d = decOf(p.id), v = r ? r.verdict : 'none';
    var days = C.ageOf(p, state.today);
    var to;
    if (d && C.isOut(d)) to = '✓ ' + (d.kind === 'split' ? 'Split across ' + d.parts.length + ' accounts' : 'Posted to ' + d.parts[0].account);
    else if (d) to = '⏸ Held for research';
    else if (v === 'split' && r.split) to = '÷ ' + r.split.parts.map(function (x) { return acctOf(x.i).number; }).join(' + ');
    else if (v === 'two') to = '⇄ ' + r.candidates.slice(0, 2).map(function (c) { return acctOf(c.i).number; }).join(' or ');
    else if (v === 'none') to = 'No account fits';
    else to = '→ ' + acctOf(r.candidates[0].i).number + ' ' + nameOf(r.candidates[0].i);
    var over = days !== null && days > state.settings.ageLimitDays;
    return '<li><button class="qrow e-' + v + (d ? ' decided' : '') + '" type="button" data-act="sel" data-id="' + esc(p.id) + '"' + (state.sel === p.id && isWide() ? ' aria-current="true"' : '') + '>' +
      '<span class="ic vp-' + (d ? 'done' : v) + '" aria-hidden="true">' + (d ? (C.isOut(d) ? '✓' : '⏸') : VI[v]) + '</span>' +
      '<span class="who">' + esc(p.payer || 'No name') + '<span class="vh"> - ' + esc(VW[v]) + '</span></span>' +
      '<span class="amt">' + esc(money(p.cents)) + '</span>' +
      '<span class="to">' + esc(to) + (days !== null ? ' · ' + (over ? '<span style="color:var(--hot);font-weight:800">' + days + ' days</span>' : days + (days === 1 ? ' day' : ' days')) : '') + '</span></button></li>';
  }
  function queueHtml() {
    if (!state.loaded) return filesHtml();
    var list = ordered();
    if (state.detail && !isWide()) return detailHtml(list);
    var h = '';
    if (state.demo) h += '<div class="sample-strip" role="note"><p><b>Made-up example:</b> ' + esc(D.NAME) + ' - an invented auto-loan book. Every name and number is made up.</p><div class="btns"><button class="btn small" type="button" data-act="own">Use my own files</button><button class="btn small ghost" type="button" data-act="tab" data-tab="files">See the files</button></div></div>';
    h += meterHtml();
    h += '<div style="margin:14px 0 10px">' + filtersHtml() + '</div>';
    if (!list.length) {
      h += '<div class="card empty-q"><p style="font-size:1.6rem;margin:0" aria-hidden="true">🎉</p><p><b>' + (state.filter === 'open' ? 'Nothing open here.' : 'Nothing in this view.') + '</b></p><button class="btn small ghost" type="button" data-act="filter" data-f="all">Show every payment</button></div>';
      return h + keepLine() + footer();
    }
    if (isWide()) {
      if (!state.sel || list.every(function (p) { return p.id !== state.sel; })) state.sel = list[0].id;
      var idx = list.map(function (p) { return p.id; }).indexOf(state.sel);
      if (idx >= state.shown) state.shown = idx + 10;
    }
    h += '<div class="qwrap"><div><ul class="qlist" aria-label="Payments">' + list.slice(0, state.shown).map(rowHtml).join('') + '</ul>' +
      (list.length > state.shown ? '<button class="btn ghost block more" type="button" data-act="more">Show ' + Math.min(50, list.length - state.shown) + ' more of ' + list.length + '</button>' : '') + '</div>';
    if (isWide()) h += '<div class="detail" id="detail">' + cardHtml(state.byId[state.sel]) + '</div>';
    h += '</div>';
    return h + keepLine() + footer();
  }
  function keepLine() {
    return '<section class="card" style="margin-top:14px"><label class="check"><input type="checkbox" id="keepBox"' + (state.device.keep ? ' checked' : '') + '> Keep this session on this device</label><p class="small muted" style="margin:0">Off by default. When on, the payments, accounts, your decisions and notes are saved in this browser only, so a reload keeps your place. Nothing is sent anywhere either way.' + (state.device.keep ? ' <button class="link-btn" type="button" data-act="clearsession">Clear it from this device</button>' : '') + '</p></section>';
  }
  function detailHtml(list) {
    var ids = list.map(function (p) { return p.id; });
    var i = ids.indexOf(state.sel);
    var all = state.payments.map(function (p) { return p.id; });
    var pos = i >= 0 ? (i + 1) + ' of ' + ids.length : (all.indexOf(state.sel) + 1) + ' of ' + all.length;
    var h = '<div class="backbar"><button class="btn small ghost" type="button" data-act="back">‹ Queue</button><span class="small muted">' + esc(pos) + '</span><div class="btns"><button class="btn small ghost" type="button" data-act="prev" aria-label="Previous payment">‹</button><button class="btn small ghost" type="button" data-act="next" aria-label="Next payment">›</button></div></div>';
    return h + cardHtml(state.byId[state.sel]) + footer();
  }

  /* ---------------- a payment card ---------------- */

  function digitsOf(s) { return String(s || '').replace(/\D/g, '').replace(/^0+(?=\d)/, ''); }
  /** The given and on-file account numbers with the differing digits marked,
   *  when they differ by a digit or a swap; otherwise as written. */
  function markNumbers(given, file) {
    var a = digitsOf(given), b = digitsOf(file);
    if (!given) return ['<span class="none-v">none given</span>', '<span class="k">' + esc(file) + '</span>'];
    if (a && a.length === b.length && a !== b) {
      var diff = 0; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
      if (diff <= 2) {
        var m = function (x, y) { var o = ''; for (var j = 0; j < x.length; j++) o += x[j] === y[j] ? esc(x[j]) : '<mark>' + esc(x[j]) + '</mark>'; return o; };
        return ['<span class="k">' + m(a, b) + '</span>' + (a !== given ? ' <span class="small muted">(' + esc(given) + ')</span>' : ''), '<span class="k">' + m(b, a) + '</span>'];
      }
    }
    return ['<span class="k">' + esc(given) + '</span>', '<span class="k">' + esc(file) + '</span>'];
  }
  function amountCell(a, sig) {
    var parts = [];
    var w = function (label, cents, kinds) { if (cents === null || cents === undefined) return; var on = kinds.indexOf(sig) >= 0; parts.push((on ? '<b>' : '') + esc(label) + ' ' + esc(money(cents)) + (on ? '</b>' : '')); };
    w('Payment', a.payment, ['payment', 'lateFee', 'multiple']);
    w('Past due', a.pastDue, ['pastDue']);
    w('Payoff', a.payoff, ['payoff']);
    return parts.join('<br>') || '<span class="none-v">no amounts on file</span>';
  }
  function cmpTable(p, i, cand) {
    var a = acctOf(i);
    var nums = markNumbers(p.account, a.number);
    var memoHit = cand && cand.acct === 'memo';
    var co = cand && cand.name && cand.name.co;
    var rows = [
      ['Account number', memoHit ? '<span class="none-v">in the memo</span>' : nums[0], nums[1]],
      ['Name', p.payer ? esc(p.payer) : '<span class="none-v">no name</span>', (co ? '' : '<b>') + esc(a.borrower) + (co ? '' : '</b>') + (a.coborrower ? '<br>' + (co ? '<b>' : '<span class="muted">') + esc(a.coborrower) + ' (co-borrower)' + (co ? '</b>' : '</span>') : '')],
      ['Amount', '<b class="num">' + esc(money(p.cents)) + '</b>', amountCell(a, cand && cand.amount)],
      ['Received / due', p.date ? esc(C.niceDay(p.date)) : '<span class="none-v">no date</span>', a.dueDay ? 'Due the ' + esc(C.ordinal(a.dueDay)) : '<span class="none-v">no due day</span>'],
      ['Memo / status', p.memo ? esc(p.memo) : '<span class="none-v">no memo</span>', a.status ? esc(a.status) : '<span class="none-v">no status</span>'],
    ];
    return '<div class="cmpwrap" tabindex="0"><table class="cmp"><thead><tr><th scope="col"><span class="vh">Field</span></th><th scope="col">The payment</th><th scope="col">Account ' + esc(a.number) + '</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr><th scope="row">' + esc(r[0]) + '</th><td>' + r[1] + '</td><td>' + r[2] + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }
  function reasonsHtml(cand, why) {
    var h = '<ul class="reasons">';
    (why || []).forEach(function (w) { h += '<li class="flag"><span class="mk" aria-hidden="true">!</span><span><span class="vh">Check: </span>' + esc(w) + '</span></li>'; });
    cand.hits.forEach(function (x) { h += '<li class="hit"><span class="mk" aria-hidden="true">✓</span><span><span class="vh">Hit: </span>' + esc(x.text) + '</span></li>'; });
    cand.misses.forEach(function (x) { h += '<li class="miss"><span class="mk" aria-hidden="true">·</span><span><span class="vh">No: </span>' + esc(x.text) + '</span></li>'; });
    return h + '</ul>';
  }
  function kindsWords(c) {
    var k = c.kinds.map(function (x) { return x === 'account' ? 'account number' : x; });
    if (!k.length) return 'little ties them';
    return (k.length > 1 ? k.slice(0, -1).join(', ') + ' and ' + k[k.length - 1] : k[0]) + (k.length > 1 ? ' agree' : ' agrees');
  }
  function scoreLine(c, second) {
    var T = C.THRESHOLDS;
    return '<div class="scorerow"><p class="score">Score <b>' + c.score + '</b>' + (second ? ' · next best ' + second.score : '') + ' · a Match needs ' + T.match + '+, ' + T.kinds + ' kinds of evidence and a ' + T.lead + '-point lead.</p><button class="link-btn small" type="button" data-act="scoring">How Stray scores</button></div>';
  }
  function candMini(c, p, label) {
    var a = acctOf(c.i);
    return '<div class="cand"><p class="lab" style="margin:0">' + esc(label) + '</p><h3><span class="k">' + esc(a.number) + '</span> · ' + esc(nameOf(c.i)) + '</h3><p class="small muted" style="margin:0">' + esc(a.payment ? 'Payment ' + money(a.payment) : 'No payment on file') + (a.pastDue ? ' · past due ' + money(a.pastDue) : '') + (a.coborrower ? ' · co-borrower ' + C.titleCase(a.coborrower) : '') + ' · score ' + c.score + '</p>' + reasonsHtml({ hits: c.hits, misses: c.misses.slice(0, 2) }) +
      '<button class="btn small" type="button" data-act="acceptc" data-i="' + c.i + '" data-id="' + esc(p.id) + '">Accept ' + esc(a.number) + '</button></div>';
  }
  function headline(p, r) {
    var c = r.candidates[0];
    switch (r.verdict) {
      case 'match': return 'Goes to <b>' + esc(acctOf(c.i).number + ' · ' + nameOf(c.i)) + '</b> - ' + esc(kindsWords(c)) + '.';
      case 'check': return 'Probably <b>' + esc(acctOf(c.i).number + ' · ' + nameOf(c.i)) + '</b> - needs a human eye.';
      case 'split': return 'One payment, <b>' + r.split.parts.length + ' accounts</b>: ' + r.split.parts.map(function (x) { return esc(acctOf(x.i).number + ' ' + nameOf(x.i) + ' ' + money(x.cents)); }).join(' + ') + '.';
      case 'two': return 'Two possible: <b>' + esc(acctOf(r.candidates[0].i).number + ' ' + nameOf(r.candidates[0].i)) + '</b> or <b>' + esc(acctOf(r.candidates[1].i).number + ' ' + nameOf(r.candidates[1].i)) + '</b>.';
      default: return 'No account fits well enough to propose. ' + (r.candidates.length ? 'The closest is ' + esc(acctOf(c.i).number + ' ' + nameOf(c.i)) + ' (score ' + c.score + ').' : 'Research it, or ask the payer.');
    }
  }
  function decidedBar(p, d) {
    var who = d.by ? ' by ' + esc(d.by) : '';
    var when = d.at ? ' · ' + esc(clock(d.at)) : '';
    if (d.kind === 'hold') return '<div class="decided-bar hold" role="status"><p>⏸ Held for research' + who + when + '</p><button class="btn small" type="button" data-act="undo" data-id="' + esc(p.id) + '">Undo</button></div>';
    var what = d.kind === 'split' ? 'Split: ' + d.parts.map(function (x) { return x.account + ' ' + money(x.cents); }).join(' + ') : 'Posted to ' + d.parts[0].account + (d.manual ? ' (picked by hand)' : '');
    return '<div class="decided-bar" role="status"><p>✓ ' + esc(what) + who + when + '</p><button class="btn small" type="button" data-act="undo" data-id="' + esc(p.id) + '">Undo</button></div>';
  }
  function cardHtml(p) {
    if (!p) return '';
    var r = state.resById[p.id], d = decOf(p.id), v = r.verdict;
    var c = r.candidates[0], second = r.candidates[1];
    var days = C.ageOf(p, state.today);
    var over = days !== null && days > state.settings.ageLimitDays;
    var h = '<article class="card pcard e-' + v + '" id="card" aria-label="' + esc(money(p.cents) + ' from ' + payerOf(p)) + '">';
    h += '<header class="phead"><div class="tags">' + vpill(v) + (days !== null ? '<span class="small muted">' + esc(plural(days, 'day')) + ' in suspense</span>' : '') + (over ? '<span class="over">Past your ' + esc(String(state.settings.ageLimitDays)) + '-day limit</span>' : '') + '</div>' +
      '<h2 class="num">' + esc(money(p.cents)) + ' <small>from ' + esc(payerOf(p)) + '</small></h2>' +
      '<p class="meta">' + esc([p.id, p.method ? 'by ' + p.method : '', p.date ? 'received ' + C.niceDay(p.date) : (p.rawDate ? 'received “' + p.rawDate + '”' : ''), 'line ' + p.line].filter(Boolean).join(' · ')) + '</p></header>';
    if (!state.device.hint && !d) h += '<div class="hint" role="note"><span class="ico" aria-hidden="true">👇</span><p><b>The reasons are the point.</b> Each ✓ is a signal that hit, each · one that didn’t, and ! is why it needs a look. Nothing posts until you press Accept.</p><button class="btn small ghost" type="button" data-act="hintoff">Got it</button></div>';
    if (d) h += decidedBar(p, d);
    h += '<p class="headline">' + headline(p, r) + '</p>';
    if (v === 'match' || v === 'check') {
      h += cmpTable(p, c.i, c);
      h += '<div><p class="lab">Why</p>' + reasonsHtml(c, v === 'check' ? r.why : null) + '</div>' + scoreLine(c, second);
    } else if (v === 'split') {
      var total = 0;
      h += '<div class="cmpwrap" tabindex="0"><table class="splitt"><thead><tr><th scope="col">Account</th><th scope="col">Borrower</th><th scope="col" class="r sch">Scheduled</th><th scope="col" class="r">Posts</th></tr></thead><tbody>' +
        r.split.parts.map(function (x) { total += x.cents; var a = acctOf(x.i); return '<tr><td class="k">' + esc(a.number) + '</td><td>' + esc(nameOf(x.i)) + '</td><td class="r sch">' + esc(money(a.payment)) + '</td><td class="r"><b>' + esc(money(x.cents)) + '</b></td></tr>'; }).join('') +
        '</tbody><tfoot><tr><td colspan="2">Total <span class="muted small">- the payment was ' + esc(money(p.cents)) + '</span></td><td class="sch"></td><td class="r">' + esc(money(total)) + '</td></tr></tfoot></table></div>';
      h += '<div><p class="lab">Why</p><ul class="reasons">' + r.split.hits.map(function (x) { return '<li class="hit"><span class="mk" aria-hidden="true">✓</span><span>' + esc(x) + '</span></li>'; }).join('') +
        '<li class="miss"><span class="mk" aria-hidden="true">·</span><span>' + esc('Payer: ' + payerOf(p) + (p.memo ? ' · memo “' + p.memo + '”' : '')) + '</span></li></ul></div>';
      h += '<details class="why"><summary>Each account on its own</summary><div class="duo">' + r.split.parts.map(function (x) { var cc = r.candidates.filter(function (k) { return k.i === x.i; })[0]; return cc ? '<div class="cand"><h3><span class="k">' + esc(acctOf(x.i).number) + '</span> · ' + esc(nameOf(x.i)) + '</h3>' + reasonsHtml(cc) + '</div>' : ''; }).join('') + '</div></details>';
    } else if (v === 'two') {
      h += '<div class="duo">' + candMini(r.candidates[0], p, 'One') + candMini(r.candidates[1], p, 'The other') + '</div>';
      h += '<div><p class="lab">What tells them apart</p><ul class="apart">' + r.apart.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    } else {
      h += '<div><p class="lab">What was tried</p><ul class="tried">' + r.tried.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
      if (r.candidates.length) h += '<details class="why"><summary>The closest ' + (r.candidates.length === 1 ? 'account' : plural(r.candidates.length, 'account')) + ', for what it’s worth</summary><ul class="picklist">' + r.candidates.map(function (k) { return pickItem(p, k, true); }).join('') + '</ul></details>';
    }
    var ruledLines = v !== 'none' ? r.tried.filter(function (x) { return /ruled out/.test(x); }) : [];
    if (ruledLines.length) h += '<p class="small muted" style="margin:0">' + esc(ruledLines.join(' · ')) + '</p>';
    if (state.rejected[p.id]) h += '<p class="small" style="margin:0">You ruled something out here. <button class="link-btn" type="button" data-act="unreject" data-id="' + esc(p.id) + '">Put it back</button></p>';
    if (state.notes[p.id]) h += '<div><p class="lab">Research note</p><div class="notebox">' + esc(state.notes[p.id]) + '</div></div>';
    // actions: the main ones stick to the bottom of a phone screen, in one row
    var main = '', extra = '';
    var kb = function (k) { return ' <kbd aria-hidden="true">' + k + '</kbd>'; };
    var pid = ' data-id="' + esc(p.id) + '"';
    if (!d) {
      if (v === 'match' || v === 'check') main += '<button class="btn grow" type="button" data-act="accept"' + pid + '>Accept ' + esc(acctOf(c.i).number) + kb('A') + '</button>';
      if (v === 'split') main += '<button class="btn grow" type="button" data-act="accept"' + pid + '>Accept the split' + kb('A') + '</button>';
      main += '<button class="btn ' + (v === 'none' ? 'grow' : 'ghost') + '" type="button" data-act="pick"' + pid + '>' + (v === 'none' ? 'Pick an account' : '<span>Pick<span class="hide-sm"> another</span></span>') + kb('P') + '</button>';
      if (v === 'match' || v === 'check') main += '<button class="btn ghost" type="button" data-act="notthis"' + pid + '>Not this' + kb('X') + '</button>';
      if (v === 'split') main += '<button class="btn ghost" type="button" data-act="notthis"' + pid + '>Not a split' + kb('X') + '</button>';
      if (v === 'two') main += '<button class="btn ghost" type="button" data-act="notthis"' + pid + '>Neither' + kb('X') + '</button>';
      if (v === 'none') main += '<button class="btn ghost" type="button" data-act="note"' + pid + '>Hold' + kb('N') + '</button>';
      else extra += '<button class="btn ghost" type="button" data-act="note"' + pid + '>Note' + kb('N') + '</button>';
    } else extra += '<button class="btn ghost" type="button" data-act="note"' + pid + '>' + (state.notes[p.id] ? 'Edit the note' : 'Add a note') + '</button>';
    if (v !== 'match') extra += '<button class="btn ai" type="button" data-act="letter"' + pid + '>✨ Draft the “which account?” letter</button>';
    // Both rows sit directly in the card, so the sticky one can ride the
    // whole height of the card on a phone.
    h += (main ? '<div class="acts stickacts">' + main + '</div>' : '') + (extra ? '<div class="acts acts-extra">' + extra + '</div>' : '');
    return h + '</article>';
  }

  /* ---------------- deciding ---------------- */

  function summaryOf(c, prefix) {
    return C.line((prefix ? prefix + ': ' : '') + c.hits.filter(function (x) { return x.k !== 'timing'; }).map(function (x) { return x.text; }).join('; '), 300);
  }
  function record(p, dec) {
    dec.by = state.device.initials || '';
    dec.at = new Date().toISOString();
    dec.verdict = state.resById[p.id].verdict;
    state.decisions[p.id] = dec;
    saveSession();
  }
  function advance(fromId, msg) {
    var list = ordered().map(function (p) { return p.id; });
    var all = state.payments.map(function (p) { return p.id; });
    var at = all.indexOf(fromId), next = null;
    for (var k = 1; k <= all.length && !next; k++) { var id = all[(at + k) % all.length]; if (!decOf(id) && list.indexOf(id) >= 0) next = id; }
    if (msg) toast(msg);
    if (!next) { state.sel = fromId; if (state.detail && !isWide()) { go('queue'); return; } draw(); return; }
    state.sel = next;
    if (state.detail && !isWide()) { history.replaceState(null, '', BASE + '#p/' + encodeURIComponent(next)); route(); scrollTo(0, 0); return; }
    draw();
    focusSel();
  }
  function focusSel() {
    var b = $('.qrow[aria-current="true"]');
    if (b) { try { b.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } }
  }
  function acceptTop(p) {
    var r = state.resById[p.id];
    if (decOf(p.id)) return;
    if (r.verdict === 'match' || r.verdict === 'check') {
      var c = r.candidates[0];
      record(p, { kind: 'post', parts: [{ account: acctOf(c.i).number, cents: p.cents }], reason: summaryOf(c, r.verdict === 'check' ? 'Checked and accepted' : 'Match') });
      advance(p.id, 'Posted ' + money(p.cents) + ' to ' + acctOf(c.i).number + '.');
    } else if (r.verdict === 'split') {
      record(p, { kind: 'split', parts: r.split.parts.map(function (x) { return { account: acctOf(x.i).number, cents: x.cents }; }), reason: C.line('Split: ' + r.split.hits.join('; '), 300) });
      advance(p.id, 'Split across ' + plural(r.split.parts.length, 'account') + '.');
    } else if (r.verdict === 'two') toast('Two possible - choose one of them, or pick another.');
    else openPick(p.id);
  }
  function acceptCand(p, i) {
    var r = state.resById[p.id];
    var c = r.candidates.filter(function (k) { return k.i === i; })[0];
    if (!c || decOf(p.id)) return;
    record(p, { kind: 'post', parts: [{ account: acctOf(i).number, cents: p.cents }], reason: summaryOf(c, 'Chosen of two') });
    advance(p.id, 'Posted ' + money(p.cents) + ' to ' + acctOf(i).number + '.');
  }
  function rematch(p, msg) {
    var rj = state.rejected[p.id] || {};
    return engine.run('rematch', { pid: p.id, exclude: rj.accts || {}, noSplit: Boolean(rj.split) }).then(function (r) {
      state.resById[p.id] = r;
      state.results = state.results.map(function (x) { return x.id === p.id ? r : x; });
      saveSession();
      draw();
      if (msg) toast(msg + ' Now: ' + VW[r.verdict] + '.');
    }).catch(function (err) { toast(err.message, 4200); });
  }
  function notThis(p) {
    var r = state.resById[p.id];
    if (decOf(p.id)) return;
    var rj = state.rejected[p.id] = state.rejected[p.id] || { accts: {} };
    if (r.verdict === 'split') { rj.split = true; return rematch(p, 'No split.'); }
    if (r.verdict === 'two') { rj.accts[r.candidates[0].i] = true; rj.accts[r.candidates[1].i] = true; return rematch(p, 'Ruled out both.'); }
    if (r.verdict === 'match' || r.verdict === 'check') { rj.accts[r.candidates[0].i] = true; return rematch(p, 'Ruled out ' + acctOf(r.candidates[0].i).number + '.'); }
    return null;
  }
  function select(id) {
    if (!state.byId[id]) return;
    state.sel = id;
    if (!isWide()) { go('p/' + encodeURIComponent(id)); return; }
    if (state.view !== 'queue') { go('queue'); return; }
    var list = ordered();
    if (!list.some(function (p) { return p.id === id; })) { state.filter = 'all'; state.age = null; }
    draw();
    focusSel();
  }
  function step(dir) {
    var list = ordered().map(function (p) { return p.id; });
    if (!list.length) return;
    var i = list.indexOf(state.sel);
    var n = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + dir));
    state.sel = list[n];
    if (state.detail && !isWide()) { history.replaceState(null, '', BASE + '#p/' + encodeURIComponent(list[n])); route(); return; }
    draw(); focusSel();
  }

  /* ---------------- pick another, and split it yourself ---------------- */

  function pickItem(p, c, readOnly) {
    var a = acctOf(c.i);
    return '<li><div class="ph"><b><span class="k">' + esc(a.number) + '</span> · ' + esc(nameOf(c.i)) + '</b><span class="small muted">score ' + c.score + '</span></div>' +
      '<ul>' + c.hits.map(function (x) { return '<li>✓ ' + esc(x.text) + '</li>'; }).join('') + c.misses.slice(0, 2).map(function (x) { return '<li class="muted">· ' + esc(x.text) + '</li>'; }).join('') + '</ul>' +
      (readOnly ? '' : '<div class="btns"><button class="btn small" type="button" data-pk="post" data-i="' + c.i + '">Post here</button><button class="btn small ghost" type="button" data-pk="split" data-i="' + c.i + '">Add to a split</button></div>') + '</li>';
  }
  function openPick(id) {
    var p = state.byId[id], r = state.resById[id];
    if (!p || decOf(id)) return;
    var tray = [];
    var found = {};
    sheet('<div id="pkBody"><h2>Pick the account for ' + esc(money(p.cents)) + '</h2><p class="muted small">From ' + esc(payerOf(p)) + (p.memo ? ' · memo “' + esc(p.memo) + '”' : '') + (p.account ? ' · account given ' + esc(p.account) : '') + '</p>' +
      '<label class="field"><span>Find an account by number or name</span><input class="input" id="pkQ" type="search" autocomplete="off" spellcheck="false" placeholder="104425, or Okafor"></label><div id="pkRes" aria-live="polite"></div>' +
      (r.candidates.length ? '<p class="lab" style="margin-top:14px">Stray’s candidates</p><ul class="picklist" id="pkCands">' + r.candidates.map(function (c) { found[c.i] = c; return pickItem(p, c); }).join('') + '</ul>' : '<p class="small muted" style="margin-top:12px">Stray found no candidates - search above.</p>') +
      '<div id="pkTray"></div></div>', function (sheetEl) {
      var root = $('#pkBody', sheetEl);
      var q = $('#pkQ', root), res = $('#pkRes', root), t = null;
      function drawTray() {
        var box = $('#pkTray', root);
        if (!tray.length) { box.innerHTML = ''; return; }
        var sum = tray.reduce(function (n, x) { return n + (x.cents || 0); }, 0);
        box.innerHTML = '<div class="tray" style="margin-top:14px"><p class="lab" style="margin:0">Your split</p>' + tray.map(function (x, k) {
          return '<div class="trow"><span><span class="k">' + esc(acctOf(x.i).number) + '</span> · ' + esc(nameOf(x.i)) + '</span><input class="input num" inputmode="decimal" data-tr="' + k + '" value="' + esc(C.plainMoney(x.cents || 0)) + '" aria-label="Amount for ' + esc(acctOf(x.i).number) + '"><button class="btn small ghost" type="button" data-trx="' + k + '" aria-label="Remove">✕</button></div>';
        }).join('') + '<p style="margin:0" id="trSum"></p><button class="btn" type="button" id="trPost">Post the split</button></div>';
        function sumLine() {
          var s = tray.reduce(function (n, x) { return n + (x.cents || 0); }, 0), left = p.cents - s;
          $('#trSum', root).innerHTML = 'Total <b>' + esc(money(s)) + '</b> of ' + esc(money(p.cents)) + (left ? ' - <b style="color:var(--none)">' + esc(money(Math.abs(left))) + (left > 0 ? ' left to place' : ' too much') + '</b>' : ' ✓');
          $('#trPost', root).disabled = left !== 0 || tray.length < 2;
        }
        $$('[data-tr]', box).forEach(function (inp) { inp.addEventListener('input', function () { var m = C.readMoney(inp.value); tray[+inp.getAttribute('data-tr')].cents = m && !m.negative ? m.cents : 0; sumLine(); }); });
        $$('[data-trx]', box).forEach(function (b) { b.addEventListener('click', function () { tray.splice(+b.getAttribute('data-trx'), 1); drawTray(); }); });
        $('#trPost', root).addEventListener('click', function () {
          record(p, { kind: 'split', manual: true, parts: tray.map(function (x) { return { account: acctOf(x.i).number, cents: x.cents }; }), reason: C.line('Split by hand: ' + tray.map(function (x) { return acctOf(x.i).number + ' ' + C.plainMoney(x.cents); }).join(' + '), 300) });
          closeSheet(); advance(p.id, 'Split across ' + plural(tray.length, 'account') + '.');
        });
        sumLine();
        void sum;
      }
      root.addEventListener('click', function (e) {
        var b = e.target.closest('[data-pk]');
        if (!b) return;
        var i = +b.getAttribute('data-i'), c = found[i];
        if (b.getAttribute('data-pk') === 'post') {
          record(p, { kind: 'post', manual: true, parts: [{ account: acctOf(i).number, cents: p.cents }], reason: summaryOf(c || { hits: [] }, 'Picked by hand') || 'Picked by hand' });
          closeSheet(); advance(p.id, 'Posted ' + money(p.cents) + ' to ' + acctOf(i).number + '.');
        } else if (!tray.some(function (x) { return x.i === i; }) && tray.length < C.LIMITS.splitMax) {
          var left = p.cents - tray.reduce(function (n, x) { return n + x.cents; }, 0);
          tray.push({ i: i, cents: Math.max(0, Math.min(left, acctOf(i).payment || left)) });
          drawTray();
          $('#pkTray', root).scrollIntoView({ block: 'nearest' });
        }
      });
      q.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () {
          var s = q.value;
          if (!C.line(s, 60)) { res.innerHTML = ''; return; }
          engine.run('search', { q: s }).then(function (hits) {
            if (q.value !== s) return null;
            if (!hits.length) { res.innerHTML = '<p class="small muted">No account matches “' + esc(s) + '”.</p>'; return null; }
            return Promise.all(hits.slice(0, 12).map(function (i) { return found[i] ? Promise.resolve(found[i]) : engine.run('explain', { pid: p.id, i: i }); })).then(function (cs) {
              if (q.value !== s) return;
              cs.forEach(function (c) { found[c.i] = c; });
              res.innerHTML = '<ul class="picklist" style="margin-top:8px">' + cs.map(function (c) { return pickItem(p, c); }).join('') + '</ul>';
            });
          }).catch(function (err) { res.innerHTML = '<p class="err">' + esc(err.message) + '</p>'; });
        }, 180);
      });
      setTimeout(function () { try { q.focus(); } catch (e) { /* ignore */ } }, 60);
    });
  }

  /* ---------------- notes and research ---------------- */

  function openNote(id) {
    var p = state.byId[id];
    if (!p) return;
    var d = decOf(id);
    sheet('<h2>Research note</h2><p class="muted small">' + esc(money(p.cents) + ' from ' + payerOf(p)) + '. Kept on this device with the session, and in the research list you export.</p>' +
      '<label class="field"><span>Note</span><textarea class="input" id="noteTxt" rows="4" maxlength="' + C.LIMITS.noteChars + '" placeholder="Called the payer, left a message. Check image shows loan 1044…">' + esc(state.notes[id] || '') + '</textarea></label>' +
      '<div class="btns" style="margin-top:10px"><button class="btn" type="button" id="noteSave">Save note</button>' + (d ? '' : '<button class="btn ghost" type="button" id="noteHold">Save and hold for research</button>') + (state.notes[id] ? '<button class="btn danger" type="button" id="noteDel">Remove the note</button>' : '') + '</div>', function (root) {
      var ta = $('#noteTxt', root);
      setTimeout(function () { try { ta.focus(); } catch (e) { /* ignore */ } }, 60);
      function save() { var v = C.para(ta.value, C.LIMITS.noteChars); if (v) state.notes[id] = v; else delete state.notes[id]; saveSession(); }
      $('#noteSave', root).addEventListener('click', function () { save(); closeSheet(); draw(); toast('Note saved.'); });
      var hold = $('#noteHold', root);
      if (hold) hold.addEventListener('click', function () { save(); record(p, { kind: 'hold', parts: [], reason: C.line('Held for research' + (state.notes[id] ? ': ' + state.notes[id] : ''), 300) }); closeSheet(); advance(id, 'Held for research.'); });
      var del = $('#noteDel', root);
      if (del) del.addEventListener('click', function () { delete state.notes[id]; saveSession(); closeSheet(); draw(); });
    });
  }

  /* ---------------- exports ---------------- */

  function fname(kind, ext) { return 'stray-' + kind + '-' + state.today + ext; }
  function exportHtml() {
    var rows = C.postingRows(state.payments, state.accounts, state.decisions);
    var research = C.researchRows(state.payments, state.results, state.decisions, state.notes, state.today);
    var m = C.meter(state.payments, state.decisions);
    var h = '';
    if (state.demo) h += '<div class="sample-strip" role="note"><p><b>Made-up example:</b> exports of an invented credit union’s list - safe to download and look at.</p></div>';
    h += '<div class="sec-head"><h1>Export</h1><span class="small muted">🔒 Made on this device · cells starting = + - @ get a \' so a spreadsheet never runs them</span></div><div class="stack">';
    h += '<section class="card stack"><div class="sec-head"><h2>📤 The posting file</h2><span class="small muted">' + esc(plural(rows.length - 1, 'line')) + ' · ' + esc(money(m.out)) + '</span></div>';
    if (rows.length > 1) {
      h += '<p class="small muted" style="margin:0">One line per account a payment goes to - a split is one line per account. Import it into your servicing system the way you import any posting batch.</p>';
      h += '<pre class="out" tabindex="0">' + esc(C.toCsv(rows.slice(0, 12))) + (rows.length > 12 ? '… ' + esc(String(rows.length - 12)) + ' more lines' : '') + '</pre>';
      h += '<div class="btns"><button class="btn" type="button" data-act="dlpost">Download the posting file (CSV)</button></div>';
      if (!state.device.initials) h += '<p class="small muted" style="margin:0">The decided_by column is blank - add your initials in <button class="link-btn" type="button" data-act="settings">Settings</button> and every decision from then on carries them.</p>';
    } else h += '<p class="muted" style="margin:0">Nothing accepted yet. Accept a payment in the queue and it lands here.</p><div class="btns"><button class="btn small ghost" type="button" data-act="tab" data-tab="queue">Go to the queue</button></div>';
    h += '</section>';
    h += '<section class="card stack"><div class="sec-head"><h2>🔍 The research list</h2><span class="small muted">' + esc(plural(research.length - 1, 'payment')) + ' still in suspense</span></div>';
    h += '<p class="small muted" style="margin:0">Every payment not posted, with Stray’s verdict, the best candidate, what was tried and your note - for the person who calls payers.</p>';
    h += research.length > 1 ? '<div class="btns"><button class="btn ghost" type="button" data-act="dlresearch">Download the research list (CSV)</button></div>' : '<p style="margin:0">✓ Nothing left in suspense.</p>';
    h += '</section>';
    h += '<section class="card stack"><div class="sec-head"><h2>🗒️ The day’s summary</h2></div><pre class="out wrapit" tabindex="0" id="sumText">' + esc(summaryText()) + '</pre><div class="btns"><button class="btn ghost" type="button" data-act="copysum">Copy it</button><button class="btn ghost" type="button" data-act="dlsum">Download (.txt)</button></div></section>';
    if (state.skippedP.length || state.skippedA.length) {
      h += '<section class="card"><h2>Rows the files had that were left out</h2><ul class="notes">' + state.skippedP.slice(0, 20).map(function (s) { return '<li>' + esc('Suspense list, line ' + s.line + ': ' + s.why) + '</li>'; }).join('') + state.skippedA.slice(0, 20).map(function (s) { return '<li>' + esc('Account list, line ' + s.line + ': ' + s.why) + '</li>'; }).join('') + '</ul>' +
        (state.skippedP.length + state.skippedA.length > 40 ? '<p class="small muted">…and ' + (state.skippedP.length + state.skippedA.length - 40) + ' more.</p>' : '') + '</section>';
    }
    return h + '</div>' + footer();
  }
  function summaryText() {
    return C.daySummary({ payments: state.payments, results: state.results, decisions: state.decisions, today: state.today, limit: state.settings.ageLimitDays, title: state.demo ? D.NAME + ' (made-up example)' : '' });
  }

  /* ---------------- the AI helpers ---------------- */

  var SIT_WORD = { 'no-match': 'We can’t match it to any account', 'two-possible': 'It could be one of two accounts', 'split-confirm': 'It seems to cover more than one account', 'business-for-owner': 'A business paid - for its owner’s loan?' };
  function openLetter(id) {
    var p = state.byId[id], r = state.resById[id];
    if (!p) return;
    var body = { situation: C.situationFor(r.verdict, r), tone: 'friendly' };
    function payloadText() { return JSON.stringify(body); }
    sheet('<h2>✨ The “which account is this for?” letter</h2><p class="muted small">For ' + esc(money(p.cents) + ' from ' + payerOf(p)) + '. Choose the situation; the AI writes the letter and an email with placeholders, and this page fills them in.</p>' +
      '<div id="lSetup"><div class="field"><span>The situation</span><div class="seg" role="group" aria-label="Situation">' + Object.keys(C.SITUATIONS).map(function (k) { return '<button type="button" data-sit="' + k + '" aria-pressed="' + (body.situation === k) + '">' + esc(SIT_WORD[k]) + '</button>'; }).join('') + '</div></div>' +
      '<div class="field" style="margin-top:10px"><span>Tone</span><div class="seg" role="group" aria-label="Tone"><button type="button" data-tone="friendly" aria-pressed="true">Friendly</button><button type="button" data-tone="formal" aria-pressed="false">Formal</button></div></div>' +
      '<div class="note" style="margin-top:12px"><p style="margin:0"><b>Exactly what is sent:</b> <code id="lPay">' + esc(payloadText()) + '</code></p><p class="small muted" style="margin:6px 0 0">Nothing else - no amount (not even rounded), no name, no date, no reference, no account number. The letter comes back with {payer_name}, {amount}, {date_received}, {reference} and {phone}, filled in here, on this device.</p></div>' +
      '<label class="field" style="margin-top:10px"><span>Your phone line for payment questions</span><input class="input" id="lPhone" maxlength="40" value="' + esc(state.device.phone) + '" placeholder="(555) 010-4400" inputmode="tel" autocomplete="off"><small>Kept on this device only. Never sent.</small></label></div>' +
      '<div id="lErr"></div><div class="btns" id="lActs" style="margin-top:10px"></div><div id="lOut"></div>', function (root) {
      function drawActs() {
        var acts = $('#lActs', root);
        if (!signedIn()) {
          acts.innerHTML = '<p class="small muted" style="width:100%;margin:0">A letter uses about a cent of AI credit, so it needs a free account (it comes with $2). Matching, deciding and exporting stay free with no account.</p><button class="btn" type="button" id="lSignin">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button>';
          $('#lSignin', root).addEventListener('click', function () { openAccount('A letter uses about a cent of AI credit; a free account comes with $2.', function () { openLetter(id); }); });
        } else {
          acts.innerHTML = '<button class="btn ai" type="button" id="lSend">Draft the letter</button><span class="small muted">About a cent of AI credit.</span>';
          $('#lSend', root).addEventListener('click', send);
        }
      }
      function send() {
        var b = $('#lSend', root);
        b.disabled = true; b.textContent = 'Drafting…';
        api('POST', 'api/ai/letter', body).then(function (res) {
          var L = res.letter;
          var vals = C.letterValues(p, $('#lPhone', root).value);
          $('#lSetup', root).hidden = true;
          $('#lActs', root).innerHTML = '<p class="small muted" style="margin:0;width:100%">Drafted for: ' + esc(SIT_WORD[body.situation]) + ' · ' + esc(body.tone) + '.</p><button class="btn ghost small" type="button" id="lAgain">Draft another</button>';
          $('#lAgain', root).addEventListener('click', function () { $('#lOut', root).innerHTML = ''; $('#lSetup', root).hidden = false; drawActs(); });
          $('#lOut', root).innerHTML = '<div class="seg" role="group" aria-label="Version" style="margin-top:14px"><button type="button" data-ver="letter" aria-pressed="true">Letter</button><button type="button" data-ver="email" aria-pressed="false">Email</button></div>' +
            '<label class="field" style="margin-top:10px"><span>Subject</span><input class="input" id="lSubj"></label><label class="field" style="margin-top:10px"><span id="lLbl">Letter</span><textarea class="input letterbox" id="lText" rows="12"></textarea></label>' +
            '<div class="btns" style="margin-top:10px"><button class="btn" type="button" id="lCopy">Copy</button></div>' +
            '<p class="small muted">Filled in on this device: {payer_name} → ' + esc(vals.payer_name) + ', {amount} → ' + esc(vals.amount) + ', {date_received} → ' + esc(vals.date_received || '[date received]') + ', {reference} → ' + esc(vals.reference) + ', {phone} → ' + esc(vals.phone || '[phone]') + '. Drafted by an AI model - read it before you send it.' + (L.removed ? ' ' + esc(plural(L.removed, 'link or unknown placeholder')) + ' removed.' : '') + '</p>';
          var ver = 'letter';
          function fill() { $('#lSubj', root).value = C.fillLetter(L.subject, vals); $('#lText', root).value = C.fillLetter(L[ver], vals); $('#lLbl', root).textContent = ver === 'letter' ? 'Letter' : 'Email'; }
          $$('[data-ver]', root).forEach(function (x) { x.addEventListener('click', function () { ver = x.getAttribute('data-ver'); $$('[data-ver]', root).forEach(function (y) { y.setAttribute('aria-pressed', String(y === x)); }); fill(); }); });
          $('#lCopy', root).addEventListener('click', function () { copy((ver === 'email' ? 'Subject: ' + $('#lSubj', root).value + '\n\n' : '') + $('#lText', root).value, 'Copied - read it over before sending.'); });
          fill();
          loadMe();
        }).catch(function (err) { b.disabled = false; b.textContent = 'Draft the letter'; meteredError(err, $('#lErr', root), function () { openLetter(id); }, 'A letter uses about a cent of AI credit, so it needs a free account (it comes with $2).'); });
      }
      $$('[data-sit]', root).forEach(function (x) { x.addEventListener('click', function () { body.situation = x.getAttribute('data-sit'); $$('[data-sit]', root).forEach(function (y) { y.setAttribute('aria-pressed', String(y === x)); }); $('#lPay', root).textContent = payloadText(); }); });
      $$('[data-tone]', root).forEach(function (x) { x.addEventListener('click', function () { body.tone = x.getAttribute('data-tone'); $$('[data-tone]', root).forEach(function (y) { y.setAttribute('aria-pressed', String(y === x)); }); $('#lPay', root).textContent = payloadText(); }); });
      $('#lPhone', root).addEventListener('change', function () { state.device.phone = C.line($('#lPhone', root).value, 40); saveDevice(); });
      drawActs();
    });
  }

  function openMapAi(kind) {
    var f = state.files[kind];
    if (!f) return;
    var payload = C.columnsPayload(kind, f.headers, f.guess.shapes);
    var renamed = f.headers.filter(function (h, i) { return C.safeHeader(h, i) !== C.line(h, C.LIMITS.headerChars); }).length;
    sheet('<h2>✨ Help me map these columns</h2><p class="muted small">Only your column headers and their shapes - never a value. The shapes were worked out on this device from the values, in words from a fixed list.</p>' +
      '<div class="tablewrap" tabindex="0" style="max-height:280px"><table class="sent"><thead><tr><th>#</th><th>Header, as sent</th><th>What the values look like</th></tr></thead><tbody>' +
      payload.columns.map(function (c, i) { return '<tr><td>' + (i + 1) + '</td><td>' + esc(c.header) + '</td><td>' + esc(c.shape.map(function (k) { return C.SHAPES[k]; }).join('; ') || '-') + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      (renamed ? '<p class="small" style="margin:8px 0 0">' + esc(plural(renamed, 'header')) + ' looked like a value (an @, a long number, an amount or a date) and ' + (renamed === 1 ? 'is' : 'are') + ' sent as “Column N” instead.</p>' : '') +
      '<details class="why"><summary>Exactly what will be sent</summary><pre class="sent-pre" tabindex="0">' + esc(JSON.stringify(payload, null, 1)) + '</pre></details>' +
      '<div id="mErr"></div><div class="btns" id="mActs" style="margin-top:10px"></div><div id="mOut"></div>', function (root) {
      var acts = $('#mActs', root);
      if (!signedIn()) {
        acts.innerHTML = '<p class="small muted" style="width:100%;margin:0">The helper uses about a cent of AI credit, so it needs a free account (it comes with $2). Choosing the columns by hand is free.</p><button class="btn" type="button" id="mSignin">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button>';
        $('#mSignin', root).addEventListener('click', function () { openAccount('The column helper uses about a cent of AI credit; a free account comes with $2.', function () { openMapAi(kind); }); });
        return;
      }
      acts.innerHTML = '<button class="btn ai" type="button" id="mSend">Ask for a mapping</button><span class="small muted">About a cent of AI credit. You still check it before matching.</span>';
      $('#mSend', root).addEventListener('click', function () {
        var b = $('#mSend', root);
        b.disabled = true; b.textContent = 'Asking…';
        api('POST', 'api/ai/columns', payload).then(function (res) {
          var m = res.columns.map, n = 0;
          C.fieldKeys(kind).forEach(function (k) { if (m[k] >= 0 && m[k] < f.headers.length) { f.map[k] = m[k]; f.sure[k] = 'ai'; n++; } else if (m[k] === -1 && f.sure[k] === 'unsure') { f.map[k] = -1; f.sure[k] = 'none'; } });
          f.guess.unsure = false; f.open = true;
          closeSheet(); draw();
          toast('The AI placed ' + plural(n, 'field') + ' - check them, then match.', 4200);
          loadMe();
        }).catch(function (err) { b.disabled = false; b.textContent = 'Ask for a mapping'; meteredError(err, $('#mErr', root), function () { openMapAi(kind); }, 'The column helper uses about a cent of AI credit, so it needs a free account (it comes with $2).'); });
      });
    });
  }

  /* ---------------- settings ---------------- */

  function openScoring() {
    var P = C.POINTS, T = C.THRESHOLDS;
    var rows = [['The account number given, exactly', P.acctExact], ['...once leading zeros, spaces, dashes or a prefix are ignored', P.acctNorm], ['An account number found in the memo', P.acctMemo], ['An open invoice number in the memo (receivables)', P.invoiceMemo], ['Two adjacent digits swapped', P.acctSwap], ['One digit wrong', P.acctOneOff],
      ['The same name, in any order', P.nameExact], ['A nickname or abbreviation (Bill, Wm, Liz)', P.nameNick], ['An initial and the surname', P.nameInitial], ['The surname one letter off', P.nameSpelling], ['A business named for the borrower', P.nameBusiness], ['The surname alone', P.nameSurname],
      ['The scheduled payment', P.amtPayment], ['The payoff', P.amtPayoff], ['The amount past due', P.amtPastDue], ['The payment plus the late fee', P.amtLateFee], ['Exactly 2 or 3 payments', P.amtMultiple], ['Received within ' + C.TIMING_DAYS + ' days of the due day', P.timing],
      ['The number given belongs to another account', P.conflict], ['The account is closed or paid off', P.closed]];
    sheet('<h2>How Stray scores</h2><p class="muted small">Each candidate gets its best account-number signal, its best name signal and its best amount signal, plus a little for timing. The numbers are round on purpose, so you can add them up.</p>' +
      '<div class="tablewrap" tabindex="0" style="max-height:none"><table class="sent"><tbody>' + rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td class="num" style="text-align:right;white-space:nowrap"><b>' + (r[1] > 0 ? '+' : '') + r[1] + '</b></td></tr>'; }).join('') + '</tbody></table></div>' +
      '<ul class="notes" style="margin-top:12px"><li><b>Match</b>: ' + T.match + '+ points, at least ' + T.kinds + ' kinds of evidence (number, name, amount) and a ' + T.lead + '-point lead over the next account - and nothing that needs a look.</li><li><b>Split</b>: no single match, and 2 to ' + C.LIMITS.splitMax + ' accounts sharing the payer’s name whose scheduled payments add up to it exactly.</li><li><b>Two possible</b>: two accounts both at ' + T.likely + '+ and less than ' + T.lead + ' apart.</li><li><b>Check</b>: one account at ' + T.likely + '+ that is not a clean match - a digit off with a different amount, a business paying, a number belonging to someone else.</li><li><b>No match</b>: nothing at ' + T.likely + '+. The card says what was tried.</li></ul>' +
      '<p class="small muted">Stray never posts anything. These rules only decide what it proposes and how it explains it.</p>');
  }
  function openSettings() {
    var s = state.settings;
    var nick = s.nicknames.map(function (p) { return p[0] + ' = ' + p[1]; }).join('\n');
    sheet('<h2>Settings</h2><div class="form">' +
      '<div class="two-col"><label class="field"><span>Late fee</span><input class="input num" id="sFee" inputmode="decimal" value="' + esc(C.plainMoney(s.lateFeeCents)) + '"><small>A payment of “payment + this” is recognised. 0 to switch it off.</small></label>' +
      '<label class="field"><span>Ageing limit (days)</span><input class="input num" id="sAge" inputmode="numeric" value="' + esc(String(s.ageLimitDays)) + '"><small>Your policy’s limit for how long a payment may sit in suspense. Older ones are flagged.</small></label></div>' +
      '<label class="field"><span>Extra nicknames, one pair a line</span><textarea class="input" id="sNick" rows="3" placeholder="peggy = margaret" spellcheck="false">' + esc(nick) + '</textarea><small>Stray already knows ' + C.NICKNAME_GROUPS.length + ' groups of names (Bill = William, Liz = Elizabeth, Wm = William…). Letters only.</small></label>' +
      '<div class="two-col"><label class="field"><span>Prefixes on your account numbers</span><input class="input" id="sPre" value="' + esc(s.acctPrefixes.join(', ')) + '" placeholder="AL, AUTO" spellcheck="false" autocapitalize="characters"><small>Ignored when comparing (“AL-104425” = 104425). LN, LOAN and ACCT always are.</small></label>' +
      '<label class="field"><span>Digits in an account number</span><div class="row"><input class="input num" id="sMin" inputmode="numeric" value="' + s.acctDigits[0] + '" style="width:80px" aria-label="Fewest digits"> to <input class="input num" id="sMax" inputmode="numeric" value="' + s.acctDigits[1] + '" style="width:80px" aria-label="Most digits"></div><small>How long a number in a memo must be to be read as an account number.</small></label></div>' +
      '<div data-sync>' + syncLine() + '</div>' +
      '<hr style="border:0;border-top:1px solid var(--line);width:100%"><p class="lab" style="margin:0">On this device only</p>' +
      '<div class="two-col"><label class="field"><span>Your initials</span><input class="input" id="sInit" maxlength="' + C.LIMITS.initialsChars + '" value="' + esc(state.device.initials) + '" autocomplete="off"><small>Written as “decided_by” in the posting file.</small></label>' +
      '<label class="field"><span>Phone line for letters</span><input class="input" id="sPhone" maxlength="40" value="' + esc(state.device.phone) + '" inputmode="tel" autocomplete="off"><small>Fills {phone} in a drafted letter. Never sent.</small></label></div>' +
      '<label class="check"><input type="checkbox" id="sKeep"' + (state.device.keep ? ' checked' : '') + '> Keep this session on this device</label><p class="small muted" style="margin:-8px 0 0">Off by default. Payments, accounts, decisions and notes are saved in this browser only when this is on. <button class="link-btn" type="button" id="sClear">Clear the session from this device</button></p>' +
      (s.presets.length ? '<div><p class="lab" style="margin:6px 0">Remembered layouts</p><ul class="picklist">' + s.presets.map(function (p, i) { return '<li><div class="ph"><span>' + esc((p.kind === 'payments' ? 'Suspense list: ' : 'Account list: ') + p.headers.slice(0, 5).join(', ') + (p.headers.length > 5 ? '…' : '')) + '</span><button class="btn small ghost" type="button" data-rmp="' + i + '">Forget</button></div></li>'; }).join('') + '</ul></div>' : '') +
      '<div id="sErr"></div><div class="btns"><button class="btn" type="button" id="sSave">Save settings</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div>' +
      '<p class="small muted" style="margin:0">Settings hold no payment, account, name or amount - only these preferences and header names.</p></div>', function (root) {
      $$('[data-rmp]', root).forEach(function (b) { b.addEventListener('click', function () { state.settings.presets.splice(+b.getAttribute('data-rmp'), 1); saveSettings(false); openSettings(); toast('Layout forgotten.'); }); });
      $('#sClear', root).addEventListener('click', function () { clearSession(); toast('Cleared from this device.'); });
      $('#sSave', root).addEventListener('click', function () {
        var errs = [];
        var fee = C.readMoney($('#sFee', root).value || '0');
        var nicks = $('#sNick', root).value.split(/\n+/).map(function (l) { return l.split(/\s*[=,:]\s*|\s+/).filter(Boolean); }).filter(function (x) { return x.length; });
        var raw = {
          lateFeeCents: fee && !fee.negative ? fee.cents : -1,
          ageLimitDays: parseInt($('#sAge', root).value, 10),
          nicknames: nicks,
          acctPrefixes: $('#sPre', root).value.split(/[\s,;]+/).filter(Boolean),
          acctDigits: [parseInt($('#sMin', root).value, 10), parseInt($('#sMax', root).value, 10)],
          presets: state.settings.presets,
        };
        var cl = C.cleanSettings(raw, true);
        errs = cl.errors;
        if (errs.length) { $('#sErr', root).innerHTML = '<p class="err" role="alert">' + esc(errs[0]) + '</p>'; return; }
        var matching = ['lateFeeCents', 'nicknames', 'acctPrefixes', 'acctDigits'].some(function (k) { return JSON.stringify(cl.settings[k]) !== JSON.stringify(state.settings[k]); });
        cl.settings.updatedAt = state.settings.updatedAt;
        state.settings = cl.settings;
        state.device.initials = C.line($('#sInit', root).value, C.LIMITS.initialsChars);
        state.device.phone = C.line($('#sPhone', root).value, 40);
        var wasKeep = state.device.keep;
        state.device.keep = $('#sKeep', root).checked;
        saveDevice();
        if (wasKeep && !state.device.keep) clearSession();
        saveSettings(matching);
        if (!wasKeep && state.device.keep) saveSession();
        closeSheet();
        if (!matching) draw();
        toast('Settings saved.');
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
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }

  var FREE_LINE = 'Matching, deciding and every export are free with no account, and never leave this device. A free account keeps your settings across devices and adds the two AI helpers - it comes with $2 of AI credit, and one account works across every app on this site.';
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">A letter or a column mapping costs about a cent. Matching, deciding and exports are free and never leave this device.</p><div id="billing"></div></div>' +
      '<p class="small" style="margin-top:14px" data-sync>' + syncLine() + '</p>' +
      '<button class="btn ghost block" id="forget" type="button" style="margin-top:6px">Remove my settings from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); draw(); }); });
        $('#forget', root).addEventListener('click', function () {
          if (!confirm('Remove your settings from the account? This device keeps its copy.')) return;
          api('DELETE', 'api/settings').then(function () { setBase(null); closeSheet(); toast('Removed from the account. This device still has them.'); state.syncState = 'local'; }).catch(function (e) { showError(e); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Matching, deciding and exports keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    $$('input[data-file]').forEach(function (inp) {
      inp.addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; var k = inp.getAttribute('data-file'); e.target.value = ''; if (f) readFile(k, f); });
    });
    $$('[data-drop]').forEach(function (z) {
      z.addEventListener('dragover', function (e) { e.preventDefault(); z.classList.add('over'); });
      z.addEventListener('dragleave', function () { z.classList.remove('over'); });
      z.addEventListener('drop', function (e) { e.preventDefault(); z.classList.remove('over'); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(z.getAttribute('data-drop'), f); });
    });
    $$('select[data-map]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var kind = sel.getAttribute('data-map'), field = sel.getAttribute('data-field'), f = state.files[kind];
        var v = parseInt(sel.value, 10);
        if (v >= 0) Object.keys(f.map).forEach(function (k) { if (k !== field && f.map[k] === v) { f.map[k] = -1; f.sure[k] = 'none'; } });
        f.map[field] = v; f.sure[field] = v >= 0 ? 'you' : 'none';
        var y = scrollY;
        draw();
        scrollTo(0, y);
        var again = $('#map-' + kind + '-' + field); if (again) try { again.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      });
    });
    var sortSel = $('#sortSel');
    if (sortSel) sortSel.addEventListener('change', function () { state.sort = sortSel.value; draw(); });
    var kb = $('#keepBox');
    if (kb) kb.addEventListener('change', function () {
      state.device.keep = kb.checked; saveDevice();
      if (kb.checked) { state.toldBig = false; var how = saveSession(); if (how === 'whole') toast('Kept on this device. Clear it any time.'); } else { clearSession(); toast('Nothing from these files is kept on this device now.'); }
      draw();
    });
  }

  function startOwn() { resetData(); state.paste = { payments: false, accounts: false }; go('files'); }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    var p = id ? state.byId[id] : null;
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); go('start'); break;
      case 'tab': go(t.getAttribute('data-tab')); break;
      case 'demo': startDemo(); break;
      case 'own': startOwn(); break;
      case 'settings': openSettings(); break;
      case 'scoring': openScoring(); break;
      case 'pastetoggle': { var k = t.getAttribute('data-k'); state.paste[k] = !state.paste[k]; draw(); var ta = $('#paste-' + k); if (ta) ta.focus(); break; }
      case 'pasteread': { var k2 = t.getAttribute('data-k'); var box = $('#paste-' + k2); readText(k2, box ? box.value : ''); break; }
      case 'rmfile': state.files[t.getAttribute('data-k')] = null; engine.run('drop', { kind: t.getAttribute('data-k') }); draw(); break;
      case 'mapai': openMapAi(t.getAttribute('data-k')); break;
      case 'mapopen': state.files[t.getAttribute('data-k')].open = true; draw(); var sel1 = $('#file-' + t.getAttribute('data-k') + ' select'); if (sel1) sel1.focus(); break;
      case 'dlsample': { var sf = D.files(state.today)[t.getAttribute('data-k')]; download(sf.name, 'text/csv', sf.text); break; }
      case 'savelayout': {
        var f = state.files[t.getAttribute('data-k')];
        var pr = C.presetFrom(f.kind, f.headers, f.map);
        if (pr.headers.some(function (h) { return !C.headerOk(h); })) { toast('A header in this file looks like a value (an @, a long number, an amount or a date), so the layout can’t be remembered.', 5000); break; }
        var cl = C.cleanSettings({ presets: state.settings.presets.concat([pr]) }, true);
        if (cl.errors.length) { toast(cl.errors[0], 5000); break; }
        state.settings.presets = cl.settings.presets.slice(-C.LIMITS.presets);
        saveSettings(false);
        toast(signedIn() ? 'Layout remembered in your account - header names only.' : 'Layout remembered on this device - header names only.');
        break;
      }
      case 'match': matchNow(); break;
      case 'filter': state.filter = t.getAttribute('data-f'); state.shown = 50; draw(); break;
      case 'age': state.age = state.age === t.getAttribute('data-a') ? null : t.getAttribute('data-a'); if (state.age && state.filter === 'decided') state.filter = 'open'; state.shown = 50; draw(); break;
      case 'more': state.shown += 50; draw(); break;
      case 'sel': select(id); break;
      case 'back': go('queue'); break;
      case 'prev': step(-1); break;
      case 'next': step(1); break;
      case 'accept': if (p) acceptTop(p); break;
      case 'acceptc': if (p) acceptCand(p, +t.getAttribute('data-i')); break;
      case 'notthis': if (p) notThis(p); break;
      case 'unreject': if (p) { delete state.rejected[p.id]; rematch(p, 'Put back.'); } break;
      case 'pick': openPick(id); break;
      case 'note': openNote(id); break;
      case 'undo': if (p) { delete state.decisions[p.id]; saveSession(); draw(); toast('Undone - it is open again.'); } break;
      case 'hintoff': state.device.hint = true; saveDevice(); draw(); break;
      case 'letter': openLetter(id); break;
      case 'dlpost': download(fname('posting', '.csv'), 'text/csv', C.toCsv(C.postingRows(state.payments, state.accounts, state.decisions))); toast('Downloaded - made on this device.'); break;
      case 'dlresearch': download(fname('research', '.csv'), 'text/csv', C.toCsv(C.researchRows(state.payments, state.results, state.decisions, state.notes, state.today))); break;
      case 'dlsum': download(fname('summary', '.txt'), 'text/plain', summaryText()); break;
      case 'copysum': copy(summaryText(), 'Summary copied.'); break;
      case 'clearsession': clearSession(); state.device.keep = false; saveDevice(); draw(); toast('Cleared from this device.'); break;
      case 'signin-sync': openAccount(); break;
      case 'retrysync': pushSettings(0); break;
      default: break;
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) { closeSheet(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || !$('#sheet').hidden || state.view !== 'queue' || !state.loaded) return;
    var tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
    var p = state.byId[state.sel];
    var k = e.key.toLowerCase();
    if (k === 'j') { e.preventDefault(); step(1); }
    else if (k === 'k') { e.preventDefault(); step(-1); }
    else if (!p) return;
    else if (k === 'a') { e.preventDefault(); acceptTop(p); }
    else if (k === 'x') { e.preventDefault(); notThis(p); }
    else if (k === 'p') { e.preventDefault(); openPick(p.id); }
    else if (k === 'n') { e.preventDefault(); openNote(p.id); }
  });

  /* ---------------- start ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill) pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  drawTop();

  // A kept session comes back only if this device was asked to keep it.
  var kept = state.device.keep ? recall(K_SESSION) : null;
  if (kept && kept.v === 1 && kept.demo) startDemo(kept);
  else if (kept && kept.v === 1 && Array.isArray(kept.payments) && Array.isArray(kept.accounts)) {
    engine.run('restore', { payments: kept.payments, accounts: kept.accounts, settings: state.settings, rejected: kept.rejected || {} }).then(function (out) {
      adopt(out);
      state.decisions = kept.decisions || {}; state.notes = kept.notes || {}; state.rejected = kept.rejected || {};
      state.files = { payments: null, accounts: null };
      state.sel = firstOpen();
      route();
      toast('Picked up where you left off - kept on this device.', 3600);
    }).catch(function () { route(); });
  } else {
    if (kept && kept.v === 1 && kept.decisions) state.pending = { decisions: kept.decisions, notes: kept.notes, rejected: kept.rejected, names: kept.names };
    route();
  }
  loadMe().then(function () {
    if (signedIn()) syncIn();
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openAccountSheet();
  });
}());
