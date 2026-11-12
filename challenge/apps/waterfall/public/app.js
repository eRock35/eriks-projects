/* Waterfall - the page. One file, no build step.
 *
 * NO BILLING LINE EVER LEAVES THIS DEVICE, AND NONE IS EVER SAVED. A billing
 * export is read in a worker (waterfall-worker.js) - or here when there is
 * none - by WaterfallCore, and its lines stay in that worker's memory until
 * the page closes. The schedule, the waterfall, the roll-forward, the
 * journal, the tie-out and every export are made there and handed to the
 * page to draw or to save as a file this browser writes. What Waterfall
 * keeps on this device goes through waterfall-store.js and WaterfallCore's
 * guards: settings (presets, rules by product name, account names) and a
 * few flags - never a customer, an invoice, an amount or a date. The
 * figures typed into the tie-out are never stored either.
 *
 * The requests this page makes: sign-in, the account's settings (never a
 * customer), and the one optional AI suggestion, whose payload - product
 * descriptions and their shapes - is shown in full before it is sent.
 *
 * Every string a file held, a person typed, the server sent or a model wrote
 * is escaped before it is drawn, and no handler is written into markup:
 * clicks and changes are routed by data-act and data-* attributes from one
 * listener each (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.WaterfallCore;
  var D = window.WaterfallDemo;
  var WS = window.WaterfallStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural, groups = C.groups;

  // A tag the browser reports but Intl refuses ("en-US@posix" in some
  // headless browsers) would make every date throw: fall back.
  var LOCALE = (function () { try { return Intl.getCanonicalLocales(navigator.language || 'en-US')[0] || 'en-US'; } catch (e) { return 'en-US'; } }());
  function stamp(d) {
    try { return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(d || new Date()); } catch (e) { return (d || new Date()).toISOString().slice(0, 16).replace('T', ' '); }
  }

  var real = WS.create(WS.idb('waterfall'));

  var state = {
    me: null, view: 'start',
    settings: C.defaults(), syncBase: null, syncState: 'local', syncErr: '', conflictOpen: false,
    device: { hint: false, rulesHint: false, home: '' },
    demo: false, busy: '', seq: 0,
    file: null, map: null, conf: {}, answers: {}, q: null, problems: [],
    prep: null, demoRules: [], sched: null, ccy: '', selMonth: '',
    tie: blankTie(), cust: { q: '', list: null, ci: null, detail: null, month: '', ccy: '' },
    close: { month: '', memo: '' }, open: {}, exact: false, showChecks: false,
  };
  function blankTie() { return { month: '', ccy: '', kind: 'billings', dash: '', lrev: '', ldef: '', fx: {}, reading: null, ledgerPick: null, deferredPick: null, result: null, err: '', ran: false }; }

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
  function money(v, c) { return C.money(v, c || state.ccy || 'USD'); }
  /** $12.3k for a crowded cell; the exact figure goes in its title. */
  function compact(v, c) {
    var u = Math.pow(10, C.decimalsOf(c)), a = Math.abs(v) / u, sign = v < 0 ? '-' : '';
    var sym = ({ USD: '$', EUR: '€', GBP: '£', JPY: '¥' })[c] || '';
    var s = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'm' : a >= 1e4 ? Math.round(a / 1e3) + 'k' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'k' : String(Math.round(a));
    return sign + (sym || c + ' ') + s;
  }
  /** "70,155.66" or "$70,155.66" typed into a box -> minor units, or null. */
  function typedMoney(s, ccy) { var d = C.readDecimal(s); return d ? C.toMinor(d, ccy, 'major') : null; }

  /* ---------------- the reader: a worker, or this page ---------------- */

  var engine = (function () {
    var w = null, seq = 0, waits = {}, local = null;
    try {
      if (window.Worker) {
        w = new Worker('waterfall-worker.js');
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
    var BIG = 'That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Export a shorter date range - 250,000 lines is the most one file can hold.';
    function here(op, data) {
      if (!local) local = C.createEngine();
      if (op === 'load' && data.file) {
        if (data.file.size > C.LIMITS.fileBytes) return Promise.reject(new Error(BIG));
        return data.file.text().then(function (text) { return local.load({ text: text, name: data.name || data.file.name, presets: data.presets }); });
      }
      if (op === 'load' && data.demo) return Promise.resolve(local.load({ text: D.csv(), name: D.FILE, demo: true }));
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
    if (state.prep && !state.demo) refreshSchedule();
    else if (state.view !== 'start') keepPlace(draw);
  }
  function settingsSummary(s) { return plural(s.rules.length, 'product rule') + ', ' + plural(s.presets.length, 'column preset') + ', ' + (s.periodEnd ? 'period ends ' + s.periodEnd : 'period end from the file') + ', names ' + (s.mask ? 'masked' : 'shown') + ' in exports'; }
  function openConflict(acc) {
    if (state.conflictOpen) return;
    state.conflictOpen = true;
    var mine = state.settings, a = C.cleanSettings(acc).settings;
    sheet('<h2>Your settings changed on another device</h2><p class="muted">The copy in your account is newer than the one this device last saw.</p><div class="note"><p style="margin:0"><b>This device:</b> ' + esc(settingsSummary(mine)) + '</p><p style="margin:6px 0 0"><b>Your account:</b> ' + esc(settingsSummary(a)) + '</p></div>' +
      '<div class="btns" style="margin-top:12px"><button class="btn" type="button" id="cfMerge">Merge them</button><button class="btn ghost" type="button" id="cfTake">Use the account’s copy</button><button class="btn ghost" type="button" id="cfKeep">Keep this device’s</button></div><p class="small muted" style="margin-top:8px">Merging keeps every product rule and preset from both; the account’s copy wins where both have the same product.</p>', function (root) {
      var done = function (s, msg) { state.conflictOpen = false; closeSheet(); adopt(s); toast(msg); };
      $('#cfMerge', root).addEventListener('click', function () { done(C.mergeSettings(mine, a), 'Merged.'); pushSettings(acc.updatedAt); });
      $('#cfTake', root).addEventListener('click', function () { done(a, 'Using the account’s copy.'); state.syncBase = acc.updatedAt; state.syncState = 'synced'; saveSyncBase(); drawSync(); });
      $('#cfKeep', root).addEventListener('click', function () { done(mine, 'Keeping this device’s settings.'); pushSettings(acc.updatedAt); });
    });
  }
  function syncLine() {
    if (!signedIn()) return '<span class="sync muted small">Settings stay on this device · <button class="link-btn" type="button" data-act="signin">sign in to keep them in your account</button> (presets, rules by product name, account names - never a customer)</span>';
    if (state.me && !state.me.sync) return '<span class="sync muted small">Saving to the account is unavailable right now - your settings are on this device.</span>';
    if (state.syncState === 'syncing') return '<span class="sync muted small">Saving your settings to your account…</span>';
    if (state.syncState === 'error') return '<span class="sync small err">Couldn’t save to your account' + (state.syncErr ? ': ' + esc(state.syncErr) : '') + ' <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="sync small" style="color:var(--ok);font-weight:700">✓ Settings saved to your account - never a customer</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }

  /* ---------------- rules in effect ---------------- */

  /** The example keeps its own rules (never saved); a real file uses the
   *  settings' rules table. */
  function rulesArr() { return state.demo ? state.demoRules : state.settings.rules; }
  function ruleFor(key) {
    var x = rulesArr().filter(function (r) { return r.d === key; })[0];
    return x ? { rule: x.r, months: x.n || 12 } : { rule: 'period' };
  }
  function setRule(key, r, n) {
    var list = rulesArr().filter(function (x) { return x.d !== key; });
    if (r !== 'period') list.push(r === 'months' ? { d: key, r: 'months', n: Math.max(1, Math.min(60, Math.floor(n) || 12)) } : { d: key, r: r });
    var chk = C.cleanSettings({ rules: list }, true);
    if (chk.errors.length) { toast(chk.errors[0], 4200); return false; }
    if (state.demo) state.demoRules = chk.settings.rules;
    else { state.settings.rules = chk.settings.rules; settingsChanged(); }
    return true;
  }

  /* ---------------- the flow: load, columns, lines, schedule ---------------- */

  function resetAll() {
    state.file = null; state.map = null; state.conf = {}; state.answers = {}; state.q = null; state.problems = [];
    state.prep = null; state.sched = null; state.ccy = ''; state.selMonth = '';
    state.tie = blankTie(); state.cust = { q: '', list: null, ci: null, detail: null, month: '', ccy: '' }; state.close = { month: '', memo: '' }; state.open = {};
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
  function loadDemo() {
    state.demo = true; resetAll();
    state.demoRules = C.cleanSettings({ rules: D.RULES }).settings.rules;
    return begin('Opening the example…', function () { return engine.run('load', { demo: true }); }, afterLoad);
  }
  function loadFile(fileObj) {
    if (!fileObj) return;
    if (fileObj.size > C.LIMITS.fileBytes) { toast('That file is over 25 MB. Export a shorter date range - 250,000 lines is the most one file can hold.', 6000); return; }
    state.demo = false; resetAll();
    return begin('Reading ' + C.line(fileObj.name, 80) + ' on this device…', function () { return engine.run('load', { file: fileObj, name: C.line(fileObj.name, 120), presets: state.settings.presets }); }, afterLoad);
  }
  function answersFrom(q, prev) {
    var a = prev || {};
    return {
      order: a.order || (q.order.decided || q.order.suggestion),
      units: a.units || (q.units ? q.units.suggestion : 'major'),
      periodEnd: a.periodEnd || (q.periodEnd ? (q.periodEnd.none && state.settings.periodEnd ? state.settings.periodEnd : q.periodEnd.suggestion) : 'exclusive'),
      discount: a.discount || (q.discount ? q.discount.suggestion : 'before'),
      tax: a.tax || (q.tax ? q.tax.suggestion : 'excluded'),
      currency: a.currency || (q.currency ? q.currency.suggestion : 'USD'),
    };
  }
  function afterLoad(meta) {
    state.file = meta; state.map = meta.map; state.conf = meta.preset ? {} : meta.conf;
    if (meta.preset) C.FKEYS.forEach(function (k) { if (meta.map[k] !== null) state.conf[k] = 'preset'; });
    state.q = meta.questions; state.problems = meta.problems;
    state.answers = answersFrom(meta.questions, null);
    go('columns');
    if (!meta.demo) toast('Read ' + plural(meta.kept, 'line') + ' on this device. Check the columns, then read the lines.', 4200);
  }
  function refreshQuestions() {
    return engine.run('questions', { map: state.map, answers: state.answers }).then(function (r) {
      state.q = r.questions; state.problems = r.problems;
      state.answers = answersFrom(r.questions, state.answers);
      keepPlace(draw);
    }).catch(function (e) { toast(e.message); });
  }
  function readLines() {
    if (state.problems.length) { toast(state.problems[0], 4200); return; }
    return begin('Reading ' + plural(state.file.kept, 'line') + ' on this device…', function () { return engine.run('prepare', { map: state.map, answers: state.answers }); }, function (prep) {
      state.prep = prep;
      if (!state.demo && state.answers.periodEnd !== state.settings.periodEnd && state.q && state.q.periodEnd) { state.settings.periodEnd = state.answers.periodEnd; settingsChanged(); }
      return refreshSchedule(true).then(function () { go('rules'); });
    });
  }
  function homeCcy() {
    var cs = state.sched ? state.sched.currencies : [];
    if (state.device.home && cs.indexOf(state.device.home) >= 0) return state.device.home;
    return cs[0] || 'USD';
  }
  /** The last month the file covers in full: the last invoice's month if it
   *  fell on the month's last day, else the month before. */
  function lastClosedMonth() {
    var p = state.prep;
    if (!p || !p.last) return '';
    var day = C.dayFromIso(p.last), mi = C.monthOfDay(day);
    return C.monthKey(C.monthEnd(mi) === day ? mi : mi - 1);
  }
  var schedTimer = null;
  function refreshSchedule(now) {
    clearTimeout(schedTimer);
    var run = function () {
      return engine.run('schedule', { rules: rulesArr(), accounts: state.settings.accounts }).then(function (s) {
        state.sched = s;
        if (!state.ccy || s.currencies.indexOf(state.ccy) < 0) state.ccy = homeCcy();
        if (!state.selMonth) state.selMonth = lastClosedMonth();
        if (!state.tie.month) {
          state.tie.month = state.demo ? D.RECON.month : lastClosedMonth();
          state.tie.ccy = state.demo ? D.RECON.ccy : homeCcy();
        }
        if (!state.close.month) state.close.month = state.tie.month;
        if (!state.cust.month) state.cust.month = state.tie.month;
        var after = [];
        if (state.tie.ran) after.push(runTie(true));
        if (state.cust.ci !== null) after.push(openCustomer(state.cust.ci, true));
        state.close.memo = '';
        return Promise.all(after).then(function () { if (!now && state.view !== 'start') keepPlace(draw); });
      }).catch(function (e) { toast(e.message, 5000); });
    };
    if (now) return run();
    return new Promise(function (resolve) { schedTimer = setTimeout(function () { run().then(resolve); }, 200); });
  }

  /* ---------------- navigation ---------------- */

  var VIEWS = ['start', 'columns', 'rules', 'schedule', 'waterfall', 'tieout', 'customers', 'close', 'settings'];
  function go(view) {
    history.pushState(null, '', BASE + '#' + view);
    route(); scrollTo(0, 0);
  }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    var v = VIEWS.indexOf(h) >= 0 ? h : 'start';
    if (v === 'columns' && !state.file) v = 'start';
    if (['rules', 'schedule', 'waterfall', 'tieout', 'customers', 'close'].indexOf(v) >= 0 && !(state.prep && state.sched)) v = state.file ? 'columns' : 'start';
    state.view = v;
    if (v === 'tieout' && state.demo && !state.tie.ran) { demoTie(); return; }
    if (v === 'customers' && !state.cust.list) { loadCustomers(); }
    draw();
  }
  function draw() {
    var main = $('#main');
    var tb = $('#tabbar');
    tb.hidden = !(state.prep && state.sched) || state.view === 'start';
    $$('#tabbar [data-tab]').forEach(function (b) {
      if (b.getAttribute('data-tab') === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    var sb = $('#settingsBtn');
    if (sb) { if (state.view === 'settings') sb.setAttribute('aria-current', 'page'); else sb.removeAttribute('aria-current'); }
    var html;
    if (state.busy) html = '<div class="card busy" role="status"><div class="spinner" aria-hidden="true"></div><p><b>' + esc(state.busy) + '</b></p><p class="small muted">On this device - nothing is uploaded.</p></div>';
    else if (state.view === 'settings') html = settingsHtml();
    else if (state.view === 'columns') html = columnsHtml();
    else if (state.view === 'rules') html = rulesHtml();
    else if (state.view === 'schedule') html = scheduleHtml();
    else if (state.view === 'waterfall') html = waterfallHtml();
    else if (state.view === 'tieout') html = tieHtml();
    else if (state.view === 'customers') html = customersHtml();
    else if (state.view === 'close') html = closeHtml();
    else html = startHtml();
    main.innerHTML = html;
    drawSync();
    afterDraw();
  }
  function afterDraw() {
    if (state.view === 'waterfall') {
      var box = $('.tri'), rowsTb = $$('.tri tbody tr:not(.tot)'), last = rowsTb.length ? $('td.diag', rowsTb[rowsTb.length - 1]) : null;
      if (box && last) { box.scrollLeft = Math.max(0, last.offsetLeft + last.offsetWidth - box.clientWidth + 140); box.scrollTop = box.scrollHeight; }
    }
    var h = state.view === 'tieout' ? $('details.bucket.hinted') : null;
    if (h && !state.hintPulsed) { state.hintPulsed = true; h.classList.add('pulse'); }
  }

  /* ---------------- the example's guide ---------------- */

  function guideHtml(step, title, body, act, label) {
    if (!state.demo) return '';
    return '<div class="guide" role="note"><div class="gt"><span class="step">' + esc('Example · ' + D.COMPANY + (step ? ' · step ' + step + ' of 4' : '')) + '</span><b>' + esc(title) + '</b><span>' + esc(body) + '</span></div>' +
      (act ? '<button class="btn" type="button" data-act="' + esc(act) + '">' + esc(label) + '</button>' : '') + '</div>';
  }
  function demoNote() {
    return state.demo ? '<p class="small muted" style="margin:0">This is a made-up company and made-up customers. <button class="link-btn" type="button" data-act="leavedemo">Leave the example</button></p>' : '';
  }

  /* ---------------- first run ---------------- */

  function mockHtml() {
    var rows = [['Aug', ['1.4k', '1.1k', '', '']], ['Sep', ['', '1.6k', '1.2k', '']], ['Oct', ['', '', '1.9k', '1.5k']]];
    return '<div class="mock" aria-hidden="true"><div class="mh"><span>Waterfall · USD</span><span class="mf">billed ↓ · revenue →</span></div><table><thead><tr><th></th><th>Aug</th><th>Sep</th><th>Oct</th><th>Nov</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr><th>' + r[0] + '</th>' + r[1].map(function (v, i) { return '<td class="' + (v ? 'c' + (1 + ((i + rows.indexOf(r)) % 3)) : '') + '">' + v + '</td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody></table><div class="mh" style="margin-top:8px"><span>Dashboard vs revenue, Oct</span><span class="mf">✓ to the cent</span></div><table><tbody><tr><th style="text-align:left">Annual plans billed in Oct</th><td>+$26.5k</td></tr><tr><th style="text-align:left">Usage billed in arrears</th><td>+$3.3k</td></tr><tr><th style="text-align:left">Void invoice counted</th><td>+$599</td></tr></tbody></table></div>';
  }
  function startHtml() {
    return '<div class="stack">' +
      '<section class="hero"><div class="copy"><div class="kicker"><span aria-hidden="true">🌊</span> Revenue recognition, on your device</div>' +
      '<h1>Billings in, revenue out.</h1>' +
      '<p>Your billing dashboard shows MRR and cash; your books need recognised and deferred revenue. Waterfall splits every invoice line across the months it is earned, and shows line by line why the two never tie at month end.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="demo">Try the demo</button>' +
      '<label class="btn big ghost filepick">Load my billing export<input type="file" data-file="export" accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"></label></div>' +
      '<p class="caps">CSV or TSV - a Stripe invoice line-item export, or any billing system’s - up to 25 MB and 250,000 lines.<span class="stays">Read on this device, never uploaded.</span></p></div>' + mockHtml() + '</section>' +
      '<section class="grid3 how">' +
      '<div class="card"><h3>Load and confirm</h3><p class="small muted" style="margin:0">Waterfall guesses every column - invoice, customer, amount, discount, tax, currency, service period, line type, status - and asks once about anything that reads two ways, like whether a period ends on its last day or the next period’s first.</p></div>' +
      '<div class="card"><h3>Choose a rule per product</h3><p class="small muted" style="margin:0">Over the service period by day, on the invoice date, over N months, or exclude. Void invoices are left out, uncollectible ones listed apart, tax is never revenue - and every line’s months add up to it exactly, to the cent.</p></div>' +
      '<div class="card"><h3>Schedule, waterfall, tie-out</h3><p class="small muted" style="margin:0">Recognised revenue by month, the waterfall triangle, the deferred revenue roll-forward, journal entries, a customer drill-down, and the buckets that explain why your dashboard and your ledger disagree.</p></div>' +
      '</section>' +
      '<section class="card"><h2>What stays on this device</h2><p class="muted" style="margin:0">Billing exports carry customer names and amounts, so Waterfall reads them in this browser and never sends them anywhere - not the file, not a line, not a figure you type. A free account keeps only your settings: column presets by header name, the rules table by product name and your account names. ' + esc(C.NOT_POLICY) + '</p></section>' +
      '<p class="foot">A trial app in the <a href="../">Challenge Lab</a>. Subscription revenue is commonly recognised over the service period; Waterfall does the arithmetic for the rule you choose.</p>' +
      '</div>';
  }

  /* ---------------- 1. columns ---------------- */

  var CONF_PILL = { sure: '<span class="pill ok">✓ recognised</span>', likely: '<span class="pill info">likely</span>', unsure: '<span class="pill warn">a guess</span>', preset: '<span class="pill ok">✓ your preset</span>' };
  function sampleOf(i) { var s = state.file.sample; for (var r = 0; r < s.length; r++) if (s[r][i]) return s[r][i]; return ''; }
  function mapItemHtml(f) {
    var cur = state.map[f.key], hdr = state.file.headers;
    var opts = '<option value="">- not in this file -</option>' + hdr.map(function (h, i) { var ex = C.clip(sampleOf(i), 28); return '<option value="' + i + '"' + (cur === i ? ' selected' : '') + '>' + esc(h + (ex ? ' - e.g. ' + ex : '')) + '</option>'; }).join('');
    var pill = cur !== null && cur !== undefined ? (CONF_PILL[state.conf[f.key]] || '<span class="pill">chosen</span>') : (f.need ? '<span class="pill bad">needed</span>' : '');
    return '<label class="mapitem"><span class="mh"><span>' + esc(f.label) + (f.need ? '' : f.want ? ' <span class="req">helps</span>' : ' <span class="req">optional</span>') + '</span>' + pill + '</span>' +
      '<select class="input" data-map="' + esc(f.key) + '">' + opts + '</select></label>';
  }
  function radio(name, val, cur, title, sub) {
    return '<label class="radio"><input type="radio" name="' + esc(name) + '" value="' + esc(val) + '" data-ans="' + esc(name) + '"' + (cur === val ? ' checked' : '') + '><span><b>' + esc(title) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span></label>';
  }
  function questionsHtml() {
    var q = state.q || {}, a = state.answers, out = [];
    if (q.periodEnd) {
      var pe = q.periodEnd, ex = pe.examples.exclusive[0], inc = pe.examples.inclusive[0];
      var ev = pe.none ? 'No line shows either way - check one invoice by hand.' :
        (pe.exclusive ? plural(pe.exclusive, 'period') + ' of ' + groups(pe.lines) + ' end on the day of the month they start' : '') +
        (pe.chainExclusive ? (pe.exclusive ? ', and ' : '') + plural(pe.chainExclusive, 'period') + ' end exactly where the same customer’s next one starts' : '') +
        (pe.inclusive || pe.chainInclusive ? (pe.exclusive || pe.chainExclusive ? '; ' : '') + plural(pe.inclusive + pe.chainInclusive, 'period') + ' end the day before (or at 23:59)' : '') + '.';
      var exSub = ex ? ex.start + ' to ' + ex.end + ' is service through the day before ' + ex.end : '1 Sep to 1 Oct is service through 30 Sep';
      var incSub = inc ? inc.start + ' to ' + inc.end + ' is service through ' + inc.end : '1 Sep to 30 Sep is service through 30 Sep';
      out.push('<div class="q"><h3>How does a service period end?</h3><p class="evid">' + esc(ev) + (pe.suggestion === 'exclusive' && !pe.none ? ' That is how Stripe writes it: the end is the first day of the next period.' : '') + '</p>' +
        radio('periodEnd', 'exclusive', a.periodEnd, 'On the next period’s first day (exclusive)', exSub) +
        radio('periodEnd', 'inclusive', a.periodEnd, 'On its own last day (inclusive)', incSub) + '</div>');
    }
    if (q.order && q.order.ask && q.order.example) {
      var e = q.order.example;
      out.push('<div class="q"><h3>' + esc(e.raw) + ' - which day is it?</h3><p class="evid">Every date in the file reads both ways, so Waterfall asks once.</p>' +
        radio('order', 'mdy', a.order, e.mdy, 'Month first (MM/DD/YYYY)') + radio('order', 'dmy', a.order, e.dmy, 'Day first (DD/MM/YYYY)') + '</div>');
    }
    if (q.units) {
      out.push('<div class="q"><h3>Amounts like ' + esc(q.units.example.raw) + ' - dollars or cents?</h3><p class="evid">' + esc(q.units.why) + '</p>' +
        radio('units', 'major', a.units, q.units.example.major, 'The amounts are in dollars (or euros...)') + radio('units', 'minor', a.units, q.units.example.minor, 'The amounts are in cents') + '</div>');
    }
    if (q.discount) {
      out.push('<div class="q"><h3>Is the amount before or after its discount?</h3><p class="evid">' + esc(q.discount.why) + '</p>' +
        radio('discount', 'before', a.discount, 'Before - take the discount off', 'Revenue = amount - discount') + radio('discount', 'after', a.discount, 'After - the amount is already net', 'The discount column is shown for the tie-out only') + '</div>');
    }
    if (q.tax) {
      out.push('<div class="q"><h3>Does the amount include tax?</h3><p class="evid">' + esc(q.tax.why) + ' Tax is never revenue either way.</p>' +
        radio('tax', 'excluded', a.tax, 'No - tax sits beside it', 'Revenue = amount') + radio('tax', 'included', a.tax, 'Yes - take the tax out', 'Revenue = amount - tax') + '</div>');
    }
    if (q.currency) {
      var list = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'NZD', 'SEK', 'INR'];
      if (list.indexOf(a.currency) < 0) list.unshift(a.currency);
      out.push('<div class="q"><h3>' + (q.currency.blanks ? 'Lines with no currency' : 'Which currency?') + '</h3><p class="evid">' + esc(q.currency.why) + '</p><label class="field"><span>Currency</span><select class="input" data-ans="currency">' + list.map(function (c) { return '<option' + (c === a.currency ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></label></div>');
    }
    if (!out.length) return '<p class="muted" style="margin:0">Nothing to ask - every date and amount reads one way.</p>';
    return out.join('');
  }
  function fileNotesHtml(f) {
    var n = [];
    if (f.truncated) n.push(plural(f.truncated, 'line') + ' past the first ' + groups(C.LIMITS.rows) + ' were not read - export a shorter date range.');
    if (f.preamble) n.push(plural(f.preamble, 'line') + ' above the header were skipped.');
    if (!f.header) n.push('The first line looks like data, so columns are numbered.');
    if (f.ragged) n.push(plural(f.ragged, 'line') + ' had a different number of fields; missing ones read as empty.');
    if (f.invisible) n.push(plural(f.invisible, 'invisible character') + ' (control, zero-width or direction characters) were removed.');
    if (f.cut) n.push(plural(f.cut, 'cell') + ' over ' + C.LIMITS.cell + ' characters were cut.');
    if (f.wide) n.push(plural(f.wide, 'column') + ' past the first ' + C.LIMITS.columns + ' were left out.');
    if (f.openQuote) n.push('A quote was never closed; the rest of the file was read as one cell.');
    return n.length ? '<div class="note"><p class="lab">About this file</p><ul class="small" style="margin:0;padding-left:18px">' + n.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '';
  }
  function columnsHtml() {
    var f = state.file;
    var mapped = C.FKEYS.filter(function (k) { return state.map[k] !== null && state.map[k] !== undefined; });
    var sure = mapped.filter(function (k) { return state.conf[k] === 'sure' || state.conf[k] === 'preset'; }).length;
    var head = state.file.headers.map(function (h, i) { var tag = C.FKEYS.filter(function (k) { return state.map[k] === i; })[0]; return '<th><span class="fieldtag">' + esc(tag ? C.field(tag).label : 'not used') + '</span>' + esc(h) + '</th>'; }).join('');
    var body = f.sample.map(function (r) { return '<tr>' + r.map(function (v) { return '<td>' + esc(C.clip(v, 60)) + '</td>'; }).join('') + '</tr>'; }).join('');
    return '<div class="stack">' +
      '<div class="sec-head"><div><p class="lab">Columns</p><h1 class="anywhere">' + esc(f.name) + '</h1><p class="small muted" style="margin:0">' + esc(plural(f.kept, 'line') + ' · ' + (f.delimiterName || 'comma') + '-separated · ' + plural(mapped.length, 'column') + ' placed' + (f.preset ? ' from your preset “' + f.preset + '”' : '')) + '</p></div>' +
      '<div class="btns"><label class="btn small ghost filepick">Choose another file<input type="file" data-file="export" accept=".csv,.tsv,.txt,text/csv,text/plain"></label></div></div>' +
      guideHtml(1, 'Every column recognised: ' + sure + ' of ' + mapped.length + '.', 'Brightwell’s export writes a period’s end the way Stripe does - the first day of the next period - and Waterfall found that in the file. Nothing to change here.', 'read', 'Read the lines →') +
      demoNote() + fileNotesHtml(f) +
      '<div class="split2"><section class="card"><div class="sec-head"><h2>Which column is which</h2><button class="btn small ghost" type="button" data-act="preset">Save as a preset</button></div><div class="maplist">' + C.FIELDS.map(mapItemHtml).join('') + '</div></section>' +
      '<div class="stack"><section class="card"><h2>A few questions</h2>' + questionsHtml() + '</section>' +
      '<section class="card">' + (state.problems.length ? '<ul class="small err" style="margin:0 0 10px;padding-left:18px">' + state.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '<p class="okline" style="margin-bottom:10px">✓ Ready to read every line</p>') +
      '<button class="btn block big" type="button" data-act="read"' + (state.problems.length ? ' disabled' : '') + '>Read ' + esc(plural(f.kept, 'line')) + ' →</button><p class="small muted" style="margin:8px 0 0">On this device. Nothing is uploaded.</p></section></div></div>' +
      '<section class="card"><h2>The first lines</h2><div class="tablewrap"><table class="t"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div></section>' +
      '</div>';
  }
  function openPreset() {
    var map = C.presetFrom(state.file.headers, state.map);
    var skipped = C.FKEYS.filter(function (k) { return state.map[k] !== null && state.map[k] !== undefined; }).length - Object.keys(map).length;
    sheet('<h2>Save these columns as a preset</h2><p class="muted small">Keeps the header NAMES - never a value - so the next export with the same headers is mapped at once. ' + (signedIn() ? 'It follows your account.' : 'Sign in and it follows your account too.') + '</p>' +
      '<label class="field"><span>Name</span><input class="input" id="presetName" maxlength="40" placeholder="Monthly billing export" autocomplete="off"></label>' +
      (skipped ? '<p class="small">' + esc(plural(skipped, 'header') + ' looked like a value and will not be saved.') + '</p>' : '') +
      '<div id="presetErr"></div><div class="btns" style="margin-top:10px"><button class="btn" type="button" id="presetSave">Save the preset</button></div>', function (root) {
      $('#presetSave', root).addEventListener('click', function () {
        var name = C.line($('#presetName', root).value, 40);
        var chk = C.cleanSettings({ presets: [{ name: name, map: map }] }, true);
        if (chk.errors.length || !name || !chk.settings.presets.length) { $('#presetErr', root).innerHTML = '<p class="err">' + esc(chk.errors[0] || 'Give it a name.') + '</p>'; return; }
        var s = state.settings;
        s.presets = s.presets.filter(function (p) { return p.name.toLowerCase() !== name.toLowerCase(); });
        s.presets.push(chk.settings.presets[0]);
        if (s.presets.length > C.LIMITS.presets) s.presets.shift();
        settingsChanged();
        closeSheet();
        toast('Saved “' + name + '”.');
      });
    });
  }

  /* ---------------- 2. rules ---------------- */

  function totalsHtml(t) { return Object.keys(t).map(function (k) { return esc(money(t[k], k)); }).join(' · '); }
  function checksHtml(p) {
    var rows = C.CHECK_ORDER.filter(function (k) { return p.checks[k].n; });
    var st = p.counts.status;
    var parts = [];
    parts.push('<li><span class="tick">✓</span><span>' + esc(plural(p.counts.lines, 'line') + ' read, ' + plural(p.counts.customers, 'customer') + ', ' + Object.keys(p.counts.ccy).join(' and ') + ', invoices ' + C.niceDay(C.dayFromIso(p.first)) + ' to ' + C.niceDay(C.dayFromIso(p.last))) + '</span></li>');
    parts.push('<li>' + (p.leftOut ? '<span class="cross">!</span><span>' + esc(plural(p.leftOut, 'line') + ' left out - Waterfall could not read them (listed below)') + '</span>' : '<span class="tick">✓</span><span>No line left out</span>') + '</li>');
    if (st.void) parts.push('<li><span class="pill">Void</span><span>' + esc(plural(st.void, 'line') + ' on void invoices - not revenue, left out of the schedule') + '</span></li>');
    if (st.draft) parts.push('<li><span class="pill">Draft</span><span>' + esc(plural(st.draft, 'line') + ' on draft invoices - not issued yet, left out') + '</span></li>');
    if (st.uncollectible) parts.push('<li><span class="pill warn">Uncollectible</span><span>' + esc(plural(st.uncollectible, 'line') + ' on uncollectible invoices - kept in revenue and listed apart: a write-off is not less revenue') + '</span></li>');
    var detail = rows.length ? '<details style="margin-top:8px"' + (state.showChecks ? ' open' : '') + '><summary class="link-btn" style="display:inline-flex;align-items:center">See every row check</summary><ul class="checks">' + rows.map(function (k) {
      var x = p.checks[k];
      return '<li><span class="pill ' + (C.CHECKS[k].out ? 'bad' : 'warn') + '">' + (C.CHECKS[k].out ? 'left out' : 'kept') + '</span><span>' + esc(C.CHECKS[k].label + ': ' + plural(x.n, 'line') + ' - file line' + (x.rows.length > 1 ? 's ' : ' ') + x.rows.slice(0, 20).join(', ') + (x.n > 20 ? ' and ' + groups(x.n - 20) + ' more' : '')) + '</span></li>';
    }).join('') + '</ul></details>' : '';
    return '<section class="card"><h2>What was read</h2><ul class="checks">' + parts.join('') + '</ul>' + detail + '</section>';
  }
  var RULE_SHORT = { period: 'Over the service period, by day', invoice: 'On the invoice date', months: 'Over N months from invoicing', exclude: 'Exclude - not revenue' };
  function ruleRowHtml(pr, i) {
    var r = ruleFor(pr.key);
    var sel = '<select class="input" data-rule="' + i + '" aria-label="Rule for ' + esc(pr.key) + '">' + C.RULES.map(function (k) { return '<option value="' + k + '"' + (r.rule === k ? ' selected' : '') + '>' + esc(RULE_SHORT[k]) + '</option>'; }).join('') + '</select>';
    var months = r.rule === 'months' ? '<label class="row" style="gap:6px"><input class="input n2" type="number" min="1" max="60" step="1" inputmode="numeric" data-months="' + i + '" value="' + esc(r.months) + '" aria-label="Months"><span class="small">months</span></label>' : '';
    var fall = r.rule === 'period' && pr.periodShare < 100 ? '<span class="small muted">' + (pr.periodShare ? esc(groups(pr.n - Math.round(pr.n * pr.periodShare / 100))) + ' with no period' : 'no period') + ': on the invoice date</span>' : '';
    return '<div class="rule-row' + (r.rule !== 'period' ? ' changed' : '') + '"><div><div class="pn">' + esc(pr.key) + '</div><div class="typechips">' + pr.types.map(function (t) { return '<span class="pill">' + esc(C.TYPE_WORD[t]) + '</span>'; }).join('') + '</div></div>' +
      '<div class="ps">' + esc(plural(pr.n, 'line') + ' · ' + pr.periodShare + '% with a period · ' + C.LEN_WORD[pr.len]) + '<br>' + totalsHtml(pr.totals) + '</div>' +
      '<div class="pc">' + sel + months + fall + '</div></div>';
  }
  function rulesHtml() {
    var p = state.prep;
    var changed = p.products.filter(function (x) { return ruleFor(x.key).rule !== 'period'; }).length;
    return '<div class="stack">' +
      '<div class="sec-head"><div><p class="lab">Rules</p><h1>How each product is recognised</h1><p class="small muted" style="margin:0">' + esc(state.file.name + ' · ' + plural(p.products.length, 'product')) + '</p></div><div class="btns"><button class="btn small ghost" type="button" data-act="tocolumns">Change columns</button></div></div>' +
      guideHtml(2, plural(p.products.length, 'product') + ', one rule each.', 'Brightwell’s accountant spreads onboarding fees over 12 months - set below. Everything else follows its own service period, by day; a credit or fee with no period lands on its invoice date.', 'toschedule', 'See the schedule →') +
      demoNote() + checksHtml(p) +
      '<section class="card"><div class="sec-head"><h2>Rules by product</h2><button class="btn small ghost" type="button" data-act="ai">✨ Suggest rules for my products</button></div>' +
      '<p class="small" style="margin:0 0 4px">Every product starts on <b>over its service period, by day</b> (a line with no period: on its invoice date). Negative lines - credits and proration credits - follow the same rule over their own period. ' + esc(C.SETUP_LINE) + '</p>' +
      '<p class="small muted">' + esc(C.NOT_POLICY) + (changed ? ' ' + plural(changed, 'product') + ' changed from the default.' : '') + (state.demo ? ' The example’s rules are never saved.' : signedIn() ? ' Rules follow your account by product name.' : ' Rules are kept on this device by product name.') + '</p>' +
      '<div class="rules">' + p.products.map(ruleRowHtml).join('') + '</div>' +
      '<div class="btns" style="margin-top:14px"><button class="btn big" type="button" data-act="toschedule">See the schedule →</button></div></section>' +
      '</div>';
  }

  /* ---------------- 3. the schedule ---------------- */

  function ccySegHtml() {
    var cs = state.sched.currencies;
    if (cs.length < 2) return '';
    return '<div class="row"><div class="seg" role="group" aria-label="Currency">' + cs.map(function (k) { return '<button type="button" data-act="ccy" data-ccy="' + esc(k) + '" aria-pressed="' + (k === state.ccy) + '">' + esc(k) + '</button>'; }).join('') + '</div><span class="small muted">' + esc(C.NO_FX) + '</span></div>';
  }
  function cur() { return state.sched.by[state.ccy]; }
  function lastBilledMi() { var p = state.prep; return p && p.last ? C.monthOfDay(C.dayFromIso(p.last)) : null; }
  function niceTicks(lo, hi) {
    var span = hi - lo || 1, step = Math.pow(10, Math.floor(Math.log10(span / 4)));
    [1, 2, 2.5, 5, 10].some(function (m) { if (span / (step * m) <= 5) { step = step * m; return true; } return false; });
    var out = [];
    for (var v = Math.floor(lo / step) * step; v < Math.ceil(hi / step) * step + step / 2; v += step) out.push(v);
    return out;
  }
  /** Recognised revenue by month as bars; what was billed as diamonds; months
   *  after the last invoice in the file hatched - revenue still to come from
   *  what was billed. Drawn here as SVG, no library. */
  function scheduleChart(c, opts) {
    opts = opts || {};
    var n = c.n, bw = 30, pl = 64, pr = 12, pt = 14, pb = 38, H = opts.h || 240, W = Math.max(600, pl + pr + n * bw);
    var u = Math.pow(10, C.decimalsOf(c.ccy));
    var all = c.rec.concat(c.billed), mx = Math.max.apply(null, all.concat([0])) / u, mn = Math.min.apply(null, all.concat([0])) / u;
    if (mx === mn) mx = mn + 1;
    var ticks = niceTicks(mn, mx), top = Math.max(mx * 1.08, ticks[ticks.length - 1]), bot = Math.min(mn < 0 ? mn * 1.08 : 0, ticks[0]);
    var y = function (v) { return pt + (H - pt - pb) * (top - v / u) / (top - bot); };
    var lastB = opts.lastBilled, selKey = opts.sel, out = [];
    out.push('<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.label || 'Recognised revenue by month') + '"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--card)"/><rect width="3" height="6" fill="var(--bar-sched)"/></pattern></defs>');
    ticks.forEach(function (t) { var yy = y(t * u); out.push('<line class="ax" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + yy + '" y2="' + yy + '"/><text x="' + (pl - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + esc(compact(Math.round(t * u), c.ccy)) + '</text>'); });
    var every = Math.max(1, Math.ceil(n / 14));
    for (var i = 0; i < n; i++) {
      var mi = c.m0 + i, x = pl + i * bw, key = c.months[i];
      if (key === selKey) out.push('<rect class="sel" x="' + x + '" y="' + pt + '" width="' + bw + '" height="' + (H - pt - pb) + '"/>');
      var v = c.rec[i], y0 = y(0), y1 = y(v);
      var future = lastB !== null && lastB !== undefined && mi > lastB;
      out.push('<rect class="' + (future ? 'sched' : 'rec') + '" x="' + (x + 5) + '" y="' + Math.min(y0, y1) + '" width="' + (bw - 10) + '" height="' + Math.max(1, Math.abs(y1 - y0)) + '" data-act="selmonth" data-m="' + esc(key) + '"><title>' + esc(C.monthLong(mi) + ': recognised ' + money(v, c.ccy) + ', billed ' + money(c.billed[i], c.ccy) + (future ? ' (scheduled - already billed, still to be earned)' : '')) + '</title></rect>');
      if (c.billed[i]) { var by = y(c.billed[i]), cx = x + bw / 2; out.push('<path class="billed" d="M' + cx + ' ' + (by - 6) + 'L' + (cx + 6) + ' ' + by + 'L' + cx + ' ' + (by + 6) + 'L' + (cx - 6) + ' ' + by + 'Z"><title>' + esc(C.monthLong(mi) + ': billed ' + money(c.billed[i], c.ccy)) + '</title></path>'); }
      if (i % every === 0 || mi % 12 === 0) out.push('<text x="' + (x + bw / 2) + '" y="' + (H - pb + 15) + '" text-anchor="middle">' + esc(C.monthLabel(mi).slice(0, 3)) + '</text>' + (mi % 12 === 0 || i === 0 ? '<text x="' + (x + bw / 2) + '" y="' + (H - pb + 29) + '" text-anchor="middle">' + esc(String(Math.floor(mi / 12))) + '</text>' : ''));
    }
    out.push('<line class="ax" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(0) + '" y2="' + y(0) + '" style="stroke:var(--muted)"/></svg>');
    return '<div class="chart">' + out.join('') + '</div><ul class="legend"><li><span class="sw rec"></span>Recognised in the month</li><li><span class="sw sched"></span>Scheduled - billed already, earned after the export</li><li><span class="sw billed"></span>Billed in the month</li></ul>';
  }
  function scheduleHtml() {
    var c = cur(), mk = state.selMonth && c.months.indexOf(state.selMonth) >= 0 ? state.selMonth : c.months[c.n - 1];
    var i = c.months.indexOf(mk), r = c.roll[i], mi = c.m0 + i;
    var monthSel = '<label class="row" style="gap:8px"><span class="small"><b>Month</b></span><select class="input" style="width:auto" data-sel="month">' + c.months.map(function (k, j) { return '<option value="' + esc(k) + '"' + (k === mk ? ' selected' : '') + '>' + esc(C.monthLong(c.m0 + j)) + '</option>'; }).join('') + '</select></label>';
    var lb = lastBilledMi();
    var rollRows = c.roll.map(function (x, j) {
      var ok = x.ok && (j === 0 ? x.opening === 0 : x.opening === c.roll[j - 1].closing);
      return '<tr' + (x.key === mk ? ' style="outline:2px solid var(--accent);outline-offset:-2px"' : '') + '><td>' + esc(C.monthLabel(x.mi)) + (lb !== null && x.mi > lb ? ' <span class="small muted">sched.</span>' : '') + '</td><td class="r">' + esc(money(x.opening, c.ccy)) + '</td><td class="r">' + esc(money(x.billed, c.ccy)) + '</td><td class="r">' + esc(money(x.rec, c.ccy)) + '</td><td class="r"><b>' + esc(money(x.closing, c.ccy)) + '</b></td><td class="r">' + esc(money(x.ahead, c.ccy)) + '</td><td class="r">' + esc(x.unbilled ? money(x.unbilled, c.ccy) : '-') + '</td><td>' + (ok ? '<span class="tick" title="Opening is last month’s closing, and closing = billed ahead less earned ahead of billing">✓</span>' : '<span class="cross">!</span>') + '</td></tr>';
    }).join('');
    var chk = c.checks;
    return '<div class="stack">' +
      '<div class="sec-head"><div><p class="lab">Schedule · ' + esc(state.ccy) + '</p><h1>Recognised revenue by month</h1></div>' + monthSel + '</div>' +
      guideHtml(3, C.monthLong(mi) + ': ' + money(c.billed[i], c.ccy) + ' billed, ' + money(c.rec[i], c.ccy) + ' recognised.', 'Deferred revenue at ' + C.niceDay(C.monthEnd(mi)) + ' is ' + money(r.closing, c.ccy) + '. Each month’s closing is the next month’s opening - checked on every row below.', 'totieout', 'Why October doesn’t tie →') +
      ccySegHtml() +
      '<div class="tiles"><div class="tile"><div class="tl">Billed in ' + esc(C.monthLabel(mi)) + '</div><div class="tv">' + esc(money(c.billed[i], c.ccy)) + '</div><div class="ts">' + esc(plural(c.billRows[i], 'line')) + '</div></div>' +
      '<div class="tile"><div class="tl">Recognised in ' + esc(C.monthLabel(mi)) + '</div><div class="tv">' + esc(money(c.rec[i], c.ccy)) + '</div><div class="ts">revenue for the month</div></div>' +
      '<div class="tile"><div class="tl">Deferred revenue, ' + esc(C.niceDay(C.monthEnd(mi))) + '</div><div class="tv">' + esc(money(r.closing, c.ccy)) + '</div><div class="ts">' + esc(r.unbilled ? money(r.ahead, c.ccy) + ' billed ahead, ' + money(r.unbilled, c.ccy) + ' earned before billing' : 'billed, not yet earned') + '</div></div>' +
      '<div class="tile"><div class="tl">All lines in ' + esc(state.ccy) + '</div><div class="tv">' + esc(money(c.totals.billed, c.ccy)) + '</div><div class="ts">' + esc(plural(c.totals.lines, 'revenue line') + ', ' + C.monthLabel(c.m0) + ' to ' + C.monthLabel(c.m0 + c.n - 1)) + '</div></div></div>' +
      '<section class="card"><div class="sec-head"><h2>Recognised and billed</h2><span class="small muted">Tap a bar to pick its month</span></div>' + scheduleChart(c, { sel: mk, lastBilled: lb }) + '</section>' +
      '<section class="card"><div class="sec-head"><h2>Deferred revenue roll-forward</h2><button class="btn small ghost" type="button" data-act="exp" data-kind="roll">Download CSV</button></div>' +
      '<ul class="checks" style="margin:0 0 10px">' +
      '<li>' + (chk.continuity ? '<span class="tick">✓</span>' : '<span class="cross">!</span>') + '<span>Each month’s closing is the next month’s opening: opening + billed - recognised = closing</span></li>' +
      '<li>' + (chk.grand ? '<span class="tick">✓</span>' : '<span class="cross">!</span>') + '<span>' + esc('Everything billed less everything recognised is the closing balance: ' + money(c.totals.billed, c.ccy) + ' - ' + money(c.totals.rec, c.ccy) + ' = ' + money(c.totals.closing, c.ccy) + ' at ' + C.monthLabel(c.m0 + c.n - 1)) + '</span></li>' +
      '<li>' + (chk.rows && chk.split ? '<span class="tick">✓</span>' : '<span class="cross">!</span>') + '<span>Every line’s months add up to exactly its amount, and each closing splits into billed ahead and earned before billing</span></li></ul>' +
      '<div class="tablewrap tall"><table class="t"><thead><tr><th>Month</th><th class="r">Opening</th><th class="r">+ Billed</th><th class="r">- Recognised</th><th class="r">= Closing</th><th class="r">Billed ahead</th><th class="r">- Earned before billing</th><th><span class="sr">Check</span></th></tr></thead><tbody>' + rollRows + '</tbody></table></div>' +
      '<p class="small muted" style="margin:8px 0 0">Waterfall starts from the lines in this file: a plan billed before the export’s first invoice is not in the opening balance. “Earned before billing” is usage in arrears - earned in a month, invoiced after it.</p></section>' +
      '</div>';
  }

  /* ---------------- the waterfall triangle ---------------- */

  function waterfallHtml() {
    var c = cur(), rows = [], mx = 0;
    for (var b = 0; b < c.n; b++) { if (c.billRows[b] || c.billed[b]) rows.push(b); for (var m = 0; m < c.n; m++) if (Math.abs(c.matrix[b][m]) > mx) mx = Math.abs(c.matrix[b][m]); }
    function cls(v) { var r = Math.abs(v) / (mx || 1); return r >= 0.5 ? 'h5' : r >= 0.25 ? 'h4' : r >= 0.1 ? 'h3' : r >= 0.03 ? 'h2' : 'h1'; }
    function fmt(v) { return state.exact ? money(v, c.ccy) : compact(v, c.ccy); }
    var head = '<tr><th scope="col">Billed ↓ · Revenue →</th>' + c.months.map(function (k, j) { return '<th scope="col">' + esc(C.monthLabel(c.m0 + j)) + '</th>'; }).join('') + '<th scope="col">Billed</th></tr>';
    var body = rows.map(function (b2) {
      return '<tr><th scope="row">' + esc(C.monthLabel(c.m0 + b2)) + '</th>' + c.matrix[b2].map(function (v, m2) {
        if (!v) return '<td class="empty' + (m2 === b2 ? ' diag' : '') + '"></td>';
        return '<td class="' + cls(v) + (m2 === b2 ? ' diag' : '') + (v < 0 ? ' neg' : '') + '" title="' + esc('Billed ' + C.monthLabel(c.m0 + b2) + ', revenue in ' + C.monthLabel(c.m0 + m2) + ': ' + money(v, c.ccy)) + '">' + esc(fmt(v)) + '</td>';
      }).join('') + '<td class="tot">' + esc(fmt(c.rowTotals[b2])) + '</td></tr>';
    }).join('');
    var foot = '<tr class="tot"><th scope="row">Recognised</th>' + c.colTotals.map(function (v) { return '<td>' + esc(v ? fmt(v) : '') + '</td>'; }).join('') + '<td>' + esc(fmt(c.totals.billed)) + '</td></tr>';
    return '<div class="stack">' +
      '<div class="sec-head"><div><p class="lab">Waterfall · ' + esc(state.ccy) + '</p><h1>Billed in one month, earned across many</h1></div><div class="btns"><label class="check small"><input type="checkbox" data-set="exact"' + (state.exact ? ' checked' : '') + '> Exact amounts</label><button class="btn small ghost" type="button" data-act="exp" data-kind="waterfall">Download CSV</button></div></div>' +
      ccySegHtml() +
      '<p class="muted" style="margin:0">Each row is the month lines were billed; each column the month they are revenue. A monthly plan billed on the 1st sits on the outlined diagonal; one billed mid-month spills one column right; an annual plan runs right for twelve months; usage billed in arrears sits left of the diagonal.</p>' +
      '<div class="heatkey" aria-hidden="true"><span>Smaller</span><i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i><i style="background:var(--heat-5)"></i><span>Larger</span><span>· italic = a negative amount</span></div>' +
      '<div class="tri" tabindex="0" role="region" aria-label="The waterfall: billing months by revenue months"><table><thead>' + head + '</thead><tbody>' + body + foot + '</tbody></table></div>' +
      '<ul class="checks"><li>' + (c.checks.rows ? '<span class="tick">✓</span>' : '<span class="cross">!</span>') + '<span>' + esc('Every row adds up to what was billed that month - ' + money(c.totals.billed, c.ccy) + ' in all') + '</span></li>' +
      '<li>' + (c.checks.cols ? '<span class="tick">✓</span>' : '<span class="cross">!</span>') + '<span>' + esc('Every column adds up to that month’s recognised revenue - ' + money(c.totals.rec, c.ccy) + ' in all') + '</span></li></ul>' +
      '</div>';
  }

  /* ---------------- 4. the tie-out ---------------- */

  function typedText(cents, ccy) { return C.money(cents, ccy).replace(/^-?[^\d-]*/, function (m) { return m.charAt(0) === '-' ? '-' : ''; }); }
  function demoTie() {
    var R = D.RECON, t = state.tie;
    t.month = R.month; t.ccy = R.ccy; t.kind = R.kind;
    t.dash = typedText(R.dashboard, R.ccy); t.lrev = typedText(R.ledgerRevenue, R.ccy); t.ldef = typedText(R.ledgerDeferred, R.ccy);
    t.fx = JSON.parse(JSON.stringify(R.fx)); t.reading = null; t.ledgerPick = null; t.deferredPick = null;
    state.hintPulsed = false;
    return runTie();
  }
  function runTie(quiet) {
    var t = state.tie, ccy = t.ccy || homeCcy();
    t.err = '';
    var parse = function (s, what) { if (!C.str(s).trim()) return null; var v = typedMoney(s, ccy); if (v === null) throw new Error('“' + C.line(s, 30) + '” is not an amount Waterfall can read (' + what + ').'); return v; };
    var dash, lrev, ldef, rates = {};
    try {
      dash = parse(t.dash, 'the dashboard'); lrev = parse(t.lrev, 'ledger revenue'); ldef = parse(t.ldef, 'ledger deferred revenue');
      Object.keys(t.fx).forEach(function (k) { if (!C.str(t.fx[k]).trim()) return; var u = C.readRate(t.fx[k]); if (!u) throw new Error('“' + C.line(t.fx[k], 20) + '” is not a rate - type it like 1.08.'); rates[k] = u; });
    } catch (e) { t.err = e.message; if (!quiet) keepPlace(draw); return Promise.resolve(); }
    if (dash === null && lrev === null && ldef === null) { t.err = 'Type at least one figure - the dashboard’s, or the ledger’s revenue or deferred balance.'; if (!quiet) keepPlace(draw); return Promise.resolve(); }
    return engine.run('reconcile', { month: t.month, ccy: ccy, dashboard: dash === null ? null : { kind: t.kind, cents: dash }, ledger: { revenue: lrev, deferred: ldef }, fx: rates, reading: t.reading, ledgerPick: t.ledgerPick, deferredPick: t.deferredPick }).then(function (r) {
      t.result = r; t.ran = true;
      if (!quiet) keepPlace(draw);
    }).catch(function (e) { t.err = e.message; if (!quiet) keepPlace(draw); });
  }
  /** The gap as a bridge: Waterfall's figure, each bucket stepping up or
   *  down, the figure typed in. HTML bars, so it reads at any width; every
   *  step carries its sign and amount, never colour alone. */
  function bridgeChart(x, ccy, startLabel, endLabel) {
    var items = [{ label: startLabel, v: x.ours, kind: 'base' }];
    x.buckets.forEach(function (b) { if (b.cents) items.push({ label: b.label, v: b.cents, kind: b.kind === 'residual' ? 'resid' : b.cents > 0 ? 'up' : 'down' }); });
    items.push({ label: endLabel, v: x.typed, kind: 'typed' });
    var run = 0, lo = 0, hi = 0;
    items.forEach(function (it) {
      if (it.kind === 'base' || it.kind === 'typed') { it.from = 0; it.to = it.v; if (it.kind === 'base') run = it.v; }
      else { it.from = run; it.to = run + it.v; run = it.to; }
      lo = Math.min(lo, it.from, it.to); hi = Math.max(hi, it.from, it.to);
    });
    var pct = function (v) { return 100 * (v - lo) / ((hi - lo) || 1); };
    return '<div class="bridge" role="img" aria-label="' + esc('From ' + startLabel + ' (' + money(x.ours, ccy) + ') to ' + endLabel + ' (' + money(x.typed, ccy) + '), bucket by bucket') + '">' + items.map(function (it) {
      var left = pct(Math.min(it.from, it.to)), width = Math.max(0.6, pct(Math.max(it.from, it.to)) - left);
      var sign = it.kind === 'base' || it.kind === 'typed' ? '' : it.v > 0 ? '+' : '';
      return '<div class="br ' + it.kind + '" aria-hidden="true"><span class="bl">' + esc(it.label) + '</span><span class="bv">' + esc(sign + money(it.v, ccy)) + '</span><span class="track"><i style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%"></i></span></div>';
    }).join('') + '</div>';
  }
  function linesTableHtml(lines, ccy, valueLabel) {
    if (!lines.length) return '';
    return '<div class="tablewrap" style="max-height:420px"><table class="t"><thead><tr><th>Customer</th>' + (valueLabel ? '<th class="r">' + esc(valueLabel) + '</th>' : '') + '<th class="r">Line amount</th><th>Invoice date</th><th>Description</th><th>Type</th><th>Service</th><th>Invoice</th></tr></thead><tbody>' +
      lines.map(function (l) {
        return '<tr><td class="wrap">' + esc(l.cust) + '</td>' + (valueLabel ? '<td class="r"><b>' + esc(l.v === null ? '' : C.money(l.v, l.ccy)) + '</b></td>' : '') + '<td class="r">' + esc(C.money(l.amt, l.ccy)) + '</td><td>' + esc(l.bill) + '</td><td class="wrap">' + esc(l.desc || l.prod) + '</td><td>' + esc(C.TYPE_WORD[l.type] + (l.st !== 'billed' ? ' · ' + C.STATUS_WORD[l.st] : '')) + '</td><td>' + esc(l.start ? l.start + ' - ' + l.last : 'none') + '</td><td>' + esc(l.inv || '-') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function bucketHtml(sec, b, ccy, hinted) {
    var key = 'b-' + sec + '-' + b.key, open = state.open[key] !== undefined ? state.open[key] : hinted;
    var sign = b.cents > 0 ? '+' : '';
    return '<details class="bucket' + (hinted ? ' hinted' : '') + (b.kind === 'residual' ? ' resid' : '') + '" data-open="' + esc(key) + '"' + (open ? ' open' : '') + '><summary>' +
      '<span class="bl">' + (hinted ? '<span class="hint">Start here</span> ' : '') + esc(b.label) + (b.n ? ' <span class="bn">' + esc(plural(b.n, 'line')) + '</span>' : '') + '</span><span class="bv">' + esc(sign + money(b.cents, ccy)) + '</span>' +
      '<span class="bs">' + esc(b.sentence) + '</span></summary><div class="bbody">' +
      (b.lines.length ? linesTableHtml(b.lines, ccy, 'In this bucket') + (b.n > b.lines.length ? '<p class="small muted" style="margin:6px 0 0">' + esc('The ' + b.lines.length + ' biggest of ' + groups(b.n) + ' lines.') + '</p>' : '') : '<p class="small muted" style="margin:0">' + (b.kind === 'residual' ? 'No line in the file accounts for this.' : 'A total, not a list of lines.') + '</p>') +
      (hinted && !state.demo ? '<div class="btns" style="margin-top:10px"><button class="btn small ghost" type="button" data-act="hintok">Got it</button></div>' : '') +
      '</div></details>';
  }
  var READINGS = [['disc', 'Shows amounts before discounts'], ['tax', 'Counts tax'], ['void', 'Counts void invoices'], ['uncoll', 'Leaves out uncollectible invoices']];
  function readingHtml(x) {
    var ks = x.kind === 'mrr' ? READINGS.filter(function (r) { return r[0] === 'disc' || r[0] === 'uncoll'; }) : READINGS;
    return '<div class="note" style="margin:10px 0"><p class="lab">How your dashboard counts</p><div class="readings">' + ks.map(function (r) {
      return '<label class="check small"><input type="checkbox" data-read="' + r[0] + '"' + (x.reading[r[0]] ? ' checked' : '') + '> ' + esc(r[1]) + '</label>';
    }).join('') + '</div><p class="small muted" style="margin:4px 0 0">' + (x.auto ? '✓ Waterfall tried every reading and kept the smallest one that ties to the cent.' : state.tie.reading ? 'Set by hand. <button class="link-btn" type="button" data-act="autoread">Find the reading that ties</button>' : 'No reading ties to the cent - tick what your dashboard does, or check the residual.') + '</p></div>';
  }
  function candHtml(sec, x, ccy) {
    if (!x.candidates.length) return '';
    return '<div class="note" style="margin:10px 0"><p class="lab">What could explain it</p>' + x.candidates.map(function (c) {
      return '<label class="cand"><input type="checkbox" data-cand="' + esc(sec) + '" value="' + esc(c.key) + '"' + (c.chosen ? ' checked' : '') + '><span class="small">' + esc(c.label) + '</span><span class="cv small">' + esc((c.cents > 0 ? '+' : '') + money(c.cents, ccy)) + '</span></label>';
    }).join('') + '<p class="small muted" style="margin:4px 0 0">' + (x.auto ? '✓ The smallest set that ties to the cent is ticked.' : (sec === 'rev' ? state.tie.ledgerPick : state.tie.deferredPick) ? 'Set by hand. <button class="link-btn" type="button" data-act="autopick" data-sec="' + esc(sec) + '">Find the set that ties</button>' : 'No set of these ties to the cent - tick the ones that apply, and the rest is the residual.') + '</p></div>';
  }
  function sectionHtml(sec, title, x, ccy, ourLabel, typedLabel, extra) {
    var hintKey = sec === 'dash' && (state.demo || !state.device.hint) ? x.biggest : null;
    return '<section class="card"><div class="sec-head"><h2>' + esc(title) + '</h2>' + (x.ties ? '<span class="pill ok">✓ Explained to the cent</span>' : '<span class="pill warn">' + esc(money(x.residual, ccy)) + ' not explained</span>') + '</div>' +
      '<div class="gaphead"><span>' + esc(typedLabel) + ': <b class="num">' + esc(money(x.typed, ccy)) + '</b></span><span>' + esc(ourLabel) + ': <b class="num">' + esc(money(x.ours, ccy)) + '</b></span><span>Gap <span class="gv">' + esc((x.gap > 0 ? '+' : '') + money(x.gap, ccy)) + '</span></span></div>' +
      bridgeChart(x, ccy, ourLabel, typedLabel) + (extra || '') +
      '<div class="buckets">' + x.buckets.map(function (b) { return bucketHtml(sec, b, ccy, b.key === hintKey && b.cents !== 0); }).join('') + '</div>' +
      '<p class="small muted" style="margin:10px 0 0">' + esc('The buckets add up to the gap exactly: ' + money(x.sum, ccy) + '.') + '</p></section>';
  }
  function tieHtml() {
    var t = state.tie, s = state.sched, ccy = t.ccy || homeCcy(), c = s.by[ccy] || cur();
    var lb = lastBilledMi(), months = c.months.filter(function (k, j) { return lb === null || c.m0 + j <= lb; });
    var others = s.currencies.filter(function (k) { return k !== ccy; });
    var r = t.result, mi = C.monthFromKey(t.month);
    var inputs = '<section class="card"><div class="formrow">' +
      '<label class="field"><span>Month</span><select class="input" data-tie="month">' + months.map(function (k) { return '<option value="' + esc(k) + '"' + (k === t.month ? ' selected' : '') + '>' + esc(C.monthLong(C.monthFromKey(k))) + '</option>'; }).join('') + '</select></label>' +
      (s.currencies.length > 1 ? '<label class="field"><span>Currency of the figures</span><select class="input" data-tie="ccy">' + s.currencies.map(function (k) { return '<option' + (k === ccy ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join('') + '</select></label>' : '<div></div>') +
      '<div class="field"><span>Your dashboard shows</span><div class="seg" role="group" aria-label="Dashboard figure">' + Object.keys(C.KINDS).map(function (k) { return '<button type="button" data-act="kind" data-kind="' + k + '" aria-pressed="' + (t.kind === k) + '">' + esc(k === 'mrr' ? 'MRR at month end' : 'Billings') + '</button>'; }).join('') + '</div></div>' +
      '<label class="field"><span>Billing dashboard: ' + esc(t.kind === 'mrr' ? 'MRR at month end' : 'billings for the month') + '</span><input class="input money" inputmode="decimal" autocomplete="off" data-tie="dash" value="' + esc(t.dash) + '" placeholder="e.g. 70,155.66"></label>' +
      '<label class="field"><span>Ledger: revenue for the month</span><input class="input money" inputmode="decimal" autocomplete="off" data-tie="lrev" value="' + esc(t.lrev) + '" placeholder="from your income statement"></label>' +
      '<label class="field"><span>Ledger: deferred revenue at month end</span><input class="input money" inputmode="decimal" autocomplete="off" data-tie="ldef" value="' + esc(t.ldef) + '" placeholder="from your balance sheet"></label>' +
      others.map(function (k) { return '<label class="field"><span>' + esc('1 ' + k + ' = ? ' + ccy + ' (the rate your dashboard and ledger use)') + '</span><input class="input money" inputmode="decimal" autocomplete="off" data-fx="' + esc(k) + '" value="' + esc(t.fx[k] || '') + '" placeholder="e.g. 1.08"></label>'; }).join('') +
      '</div>' + (t.err ? '<p class="err" role="alert">' + esc(t.err) + '</p>' : '') +
      '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="tie">Explain the gaps</button><span class="small muted">The figures you type stay in this tab - never saved, never sent.</span></div></section>';
    var res = '';
    if (r) {
      var ml = r.monthLabel;
      if (r.dashboard) res += sectionHtml('dash', 'Dashboard vs revenue - ' + ml, r.dashboard, r.ccy, 'Waterfall’s ' + C.monthLabel(mi) + ' revenue', r.dashboard.kind === 'mrr' ? 'Dashboard MRR' : 'Dashboard billings', readingHtml(r.dashboard));
      if (r.ledgerRevenue) res += sectionHtml('rev', 'Ledger revenue - ' + ml, r.ledgerRevenue, r.ccy, 'Waterfall’s revenue', 'Ledger revenue', candHtml('rev', r.ledgerRevenue, r.ccy));
      if (r.ledgerDeferred) res += sectionHtml('def', 'Ledger deferred revenue - ' + C.niceDay(C.monthEnd(mi)), r.ledgerDeferred, r.ccy, 'Waterfall’s deferred', 'Ledger deferred', candHtml('def', r.ledgerDeferred, r.ccy));
      if (r.others.length && !Object.keys(r.rates).length) res += '<p class="small muted">' + esc('Your file also has ' + r.others.join(', ') + ' lines. Type the rate your dashboard uses to bring them in - Waterfall keeps each currency in its own schedule otherwise.') + '</p>';
    }
    var g = state.demo && r && r.dashboard ? guideHtml(4, 'The dashboard said ' + money(r.dashboard.typed, r.ccy) + ' for October; the ledger ' + money(r.ledgerRevenue.typed, r.ccy) + ' of revenue and ' + money(r.ledgerDeferred.typed, r.ccy) + ' deferred.', 'Every cent of all three gaps is explained below. Start with the biggest bucket: three annual plans billed in October.', 'tocustomers', 'Next: a customer →') : '';
    return '<div class="stack">' +
      '<div class="sec-head"><div><p class="lab">Tie out · ' + esc(ccy) + '</p><h1>Why the dashboard and the ledger disagree</h1></div><button class="btn small ghost" type="button" data-act="tomemo">Close memo for this month</button></div>' +
      g + inputs + res + '</div>';
  }

  /* ---------------- customers ---------------- */

  function loadCustomers() {
    return engine.run('customers', { q: state.cust.q }).then(function (l) {
      state.cust.list = l;
      if (state.view === 'customers') keepPlace(draw);
    }).catch(function (e) { toast(e.message); });
  }
  function openCustomer(ci, quiet) {
    return engine.run('customer', { ci: ci }).then(function (d) {
      state.cust.ci = d ? ci : null; state.cust.detail = d;
      if (d && (!state.cust.ccy || d.currencies.indexOf(state.cust.ccy) < 0)) state.cust.ccy = d.currencies[0];
      if (!quiet) { keepPlace(draw); if (matchMedia('(max-width: 1039px)').matches) setTimeout(function () { var el = document.getElementById('custDetail'); if (el) el.scrollIntoView({ block: 'start' }); }, 30); }
    }).catch(function (e) { toast(e.message); });
  }
  function custDetailHtml(d) {
    if (!d) return '<section class="card"><h2>Pick a customer</h2><p class="muted" style="margin:0">Their lines, the rule each follows, how each splits across months, and their deferred revenue at any month end.</p></section>';
    var k = state.cust.ccy, b = d.by[k];
    var m0 = C.monthFromKey(b.months[0]), c = { ccy: k, n: b.months.length, m0: m0, months: b.months, rec: b.rec, billed: b.billed };
    var mk = b.months.indexOf(state.cust.month) >= 0 ? state.cust.month : b.months[b.months.length - 1];
    var i = b.months.indexOf(mk);
    var lines = d.lines.map(function (l) {
      var parts = l.parts.slice(0, 4).map(function (p) { return C.monthLabel(C.monthFromKey(p[0])) + ' ' + C.money(p[1], l.ccy); }).join(' · ') + (l.parts.length > 4 ? ' · … ' + plural(l.parts.length - 4, 'more month') : '');
      return '<tr><td>' + esc(l.inv || '-') + '</td><td>' + esc(l.bill) + '</td><td class="wrap">' + esc(l.desc || l.prod) + '</td><td>' + esc(C.TYPE_WORD[l.type] + (l.st !== 'billed' ? ' · ' + C.STATUS_WORD[l.st] : '')) + '</td><td class="r">' + esc(C.money(l.amt, l.ccy)) + '</td><td>' + esc(l.start ? l.start + ' - ' + l.last + ' (' + l.days + ' days)' : 'none') + '</td><td class="wrap wide">' + esc(l.rule) + '<br><span class="small muted">' + esc(parts) + '</span></td></tr>';
    }).join('');
    return '<section class="card" id="custDetail"><div class="sec-head"><div><h2 class="anywhere">' + esc(d.name) + '</h2><p class="small muted" style="margin:0">' + esc((d.id && d.id !== d.name ? d.id + ' · ' : '') + plural(d.n, 'line')) + '</p></div>' +
      (d.currencies.length > 1 ? '<div class="seg" role="group" aria-label="Currency">' + d.currencies.map(function (x) { return '<button type="button" data-act="custccy" data-ccy="' + esc(x) + '" aria-pressed="' + (x === k) + '">' + esc(x) + '</button>'; }).join('') + '</div>' : '') + '</div>' +
      '<div class="tiles" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div class="tile"><div class="tl">Deferred at</div><select class="input" data-sel="custmonth" aria-label="Month end">' + b.months.map(function (x) { return '<option value="' + esc(x) + '"' + (x === mk ? ' selected' : '') + '>' + esc(C.niceDay(C.monthEnd(C.monthFromKey(x)))) + '</option>'; }).join('') + '</select><div class="tv" style="margin-top:6px">' + esc(C.money(b.closing[i], k)) + '</div></div>' +
      '<div class="tile"><div class="tl">' + esc('In ' + C.monthLabel(m0 + i)) + '</div><div class="tv">' + esc(C.money(b.rec[i], k)) + '</div><div class="ts">' + esc('recognised; ' + C.money(b.billed[i], k) + ' billed. ' + C.money(b.totals.billed, k) + ' billed in all.') + '</div></div></div>' +
      scheduleChart(c, { sel: mk, lastBilled: lastBilledMi(), h: 200, label: 'Revenue by month for this customer' }) +
      '<h3 style="margin-top:14px">Lines</h3><div class="tablewrap" style="max-height:480px"><table class="t"><thead><tr><th>Invoice</th><th>Date</th><th>Description</th><th>Type</th><th class="r">Amount</th><th>Service</th><th>Rule and split</th></tr></thead><tbody>' + lines + '</tbody></table></div>' +
      (d.n > d.lines.length ? '<p class="small muted">' + esc('The first ' + d.lines.length + ' of ' + groups(d.n) + ' lines.') + '</p>' : '') + '</section>';
  }
  function customersHtml() {
    var l = state.cust.list;
    var rows = l ? l.shown.map(function (c) {
      return '<button type="button" class="custrow" data-act="cust" data-ci="' + c.ci + '"' + (c.ci === state.cust.ci ? ' aria-current="true"' : '') + '><span><span class="cn">' + esc(c.name) + '</span><br><span class="cm">' + esc((c.id && c.id !== c.name ? c.id + ' · ' : '') + plural(c.n, 'line')) + '</span></span><span class="cb">' + totalsHtml(c.billed) + '</span></button>';
    }).join('') : '<p class="muted">Loading…</p>';
    return '<div class="stack">' +
      '<div class="sec-head"><div><p class="lab">Customers</p><h1>One customer, line by line</h1></div></div>' +
      (state.demo ? guideHtml(0, 'Pick a customer to see their schedule.', 'Quorvane Robotics renewed a Business annual plan on 7 Oct 2026: $5,990.00 billed, 25 days of it October revenue, the rest deferred and earned through 6 Oct 2027.', 'toclose', 'Last: the journal and memo →') : '') +
      '<div class="split-cust"><section class="card"><label class="field"><span>Find a customer</span><input class="input" type="search" data-search="cust" value="' + esc(state.cust.q) + '" placeholder="Name or id" autocomplete="off"></label>' +
      '<p class="small muted" style="margin:8px 0">' + esc(l ? plural(l.matched, 'customer') + (l.matched > l.shown.length ? ', the ' + l.shown.length + ' biggest shown' : '') + ' · by amount billed' : '') + '</p>' +
      '<div class="custlist" style="max-height:70vh;overflow:auto">' + rows + '</div></section>' + custDetailHtml(state.cust.detail) + '</div></div>';
  }

  /* ---------------- close: the journal, the exports, the memo ---------------- */

  function journalHtml(month) {
    var s = state.sched, out = [];
    s.currencies.forEach(function (k) {
      var j = s.by[k].journal.filter(function (x) { return x.key === month; })[0];
      if (!j) return;
      out.push('<div class="je"><h3>' + esc(k + ' · ' + C.niceDay(C.dayFromIso(j.date))) + ' ' + (j.balanced ? '<span class="pill ok">✓ Debits = credits</span>' : '<span class="pill bad">Does not balance</span>') + '</h3>' + j.entries.map(function (e) {
        return '<div class="tablewrap"><table class="t"><thead><tr><th>' + esc(e.name) + '</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead><tbody>' + e.rows.map(function (r) { return '<tr><td>' + esc(r.account) + '</td><td class="r">' + esc(r.dr ? C.money(r.dr, k) : '') + '</td><td class="r">' + esc(r.cr ? C.money(r.cr, k) : '') + '</td></tr>'; }).join('') + '</tbody></table></div>';
      }).join('') + '<p class="small muted" style="margin:0">' + esc('Total ' + C.money(j.dr, k) + ' debit, ' + C.money(j.cr, k) + ' credit.') + '</p></div>');
    });
    return out.length ? out.join('') : '<p class="muted">No entries this month.</p>';
  }
  function accountsHtml() {
    var a = state.settings.accounts;
    return '<div class="formrow" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">' + C.ACCOUNT_KEYS.map(function (k) {
      return '<label class="field"><span>' + esc({ ar: 'Receivable', deferred: 'Deferred revenue', revenue: 'Revenue', tax: 'Tax payable' }[k]) + '</span><input class="input" maxlength="' + C.LIMITS.accountChars + '" data-acct="' + k + '" value="' + esc(a[k]) + '"></label>';
    }).join('') + '</div>';
  }
  function closeHtml() {
    var s = state.sched, c = cur(), lb = lastBilledMi();
    var months = c.months.filter(function (k, j) { return lb === null || c.m0 + j <= lb; });
    var m = state.close.month && months.indexOf(state.close.month) >= 0 ? state.close.month : months[months.length - 1];
    var ml = C.monthLong(C.monthFromKey(m));
    var mask = state.settings.mask;
    var exp = function (kind, title, sub) { return '<div class="exp"><b>' + esc(title) + '</b><p>' + esc(sub) + '</p><div class="btns"><button class="btn small" type="button" data-act="exp" data-kind="' + kind + '">Download</button></div></div>'; };
    return '<div class="stack">' +
      '<div class="sec-head"><div><p class="lab">Close</p><h1>Journal entries and the close pack</h1></div><label class="row" style="gap:8px"><span class="small"><b>Month</b></span><select class="input" style="width:auto" data-sel="closemonth">' + months.map(function (k) { return '<option value="' + esc(k) + '"' + (k === m ? ' selected' : '') + '>' + esc(C.monthLong(C.monthFromKey(k))) + '</option>'; }).join('') + '</select></label></div>' +
      demoNote() +
      '<div class="split2"><section class="card"><h2>' + esc('Journal entries - ' + ml) + '</h2><p class="small muted">Billing: receivable against deferred revenue - or straight to revenue for a line recognised on its invoice date - and tax payable. Recognition: deferred revenue to revenue for the month’s share. ' + esc(C.NO_FX) + '</p>' + journalHtml(m) + '</section>' +
      '<div class="stack"><section class="card"><h2>Account names</h2><p class="small muted">Used in the journal and its CSV. ' + (signedIn() ? 'They follow your account.' : 'Kept on this device.') + '</p>' + accountsHtml() + '</section>' +
      '</div></div><section class="card"><h2>Exports</h2><label class="check small"><input type="checkbox" data-set="mask"' + (mask ? ' checked' : '') + '> Mask customer names (Customer 0001…)</label><div class="exports">' +
      exp('journal-month', 'Journal - ' + ml, 'A generic journal CSV: date, journal, account, debit, credit.') +
      exp('journal', 'Journal - every month', 'Every billing and recognition entry in the file.') +
      exp('schedule', 'The schedule, line by line', 'Every revenue line with its rule and its share of each month.') +
      exp('waterfall', 'The waterfall - ' + state.ccy, 'Billing month by recognition month, with totals.') +
      exp('roll', 'The roll-forward - ' + state.ccy, 'Opening, billed, recognised, closing for every month.') +
      '</div><p class="small muted" style="margin:8px 0 0">Made on this device. A cell that starts like a formula gets a leading quote, so no spreadsheet runs it.</p></section>' +
      '<section class="card"><div class="sec-head"><h2>' + esc('Close memo - ' + ml) + '</h2><div class="btns"><button class="btn small" type="button" data-act="memo">' + (state.close.memo ? 'Refresh' : 'Write the memo') + '</button>' + (state.close.memo ? '<button class="btn small ghost" type="button" data-act="dlmemo">Download .md</button><button class="btn small ghost" type="button" data-act="copymemo">Copy</button>' : '') + '</div></div>' +
      '<p class="small muted">One page in Markdown: the month’s totals, the roll-forward, ' + (state.tie.ran ? 'the tie-out buckets, ' : '') + 'the rules used and what was left out. Customer names ' + (mask ? 'masked' : 'shown') + '.</p>' +
      (state.close.memo ? '<p class="small muted">' + esc('Written ' + state.close.at + ' on this device.') + '</p><pre class="out" tabindex="0">' + esc(state.close.memo) + '</pre>' : '') + '</section>' +
      '</div>';
  }
  function exportNow(kind) {
    var t = state.tie;
    var x = { kind: kind === 'journal-month' ? 'journal' : kind, ccy: state.ccy, mask: state.settings.mask, accounts: state.settings.accounts, month: kind === 'journal-month' || kind === 'memo' ? (state.close.month || state.tie.month) : '' };
    if (kind === 'memo' && t.result) x.recon = { month: x.month, ccy: t.result.ccy, dashboard: t.result.dashboard ? { kind: t.result.dashboard.kind, cents: t.result.dashboard.typed } : null, ledger: { revenue: t.result.ledgerRevenue ? t.result.ledgerRevenue.typed : null, deferred: t.result.ledgerDeferred ? t.result.ledgerDeferred.typed : null }, fx: t.result.rates, reading: t.reading, ledgerPick: t.ledgerPick, deferredPick: t.deferredPick };
    if (kind === 'memo' && x.recon && x.recon.month !== t.result.month) x.recon = null;
    return engine.run('exportFile', x);
  }

  /* ---------------- settings ---------------- */

  function settingsHtml() {
    var s = state.settings;
    return '<div class="stack"><div class="sec-head"><div><p class="lab">Settings</p><h1>What Waterfall keeps</h1></div></div>' +
      '<p data-sync style="margin:0"></p>' +
      '<div class="grid2"><section class="card"><h2>Rules by product</h2>' + (s.rules.length ? '<ul class="checks">' + s.rules.map(function (r, i) { return '<li style="justify-content:space-between"><span><b>' + esc(r.d) + '</b> · ' + esc(C.ruleText(r.r === 'months' ? { rule: 'months', months: r.n } : { rule: r.r })) + '</span><button class="btn small ghost" type="button" data-act="rmrule" data-i="' + i + '">Remove</button></li>'; }).join('') + '</ul><div class="btns" style="margin-top:8px"><button class="btn small danger" type="button" data-act="clearrules">Clear every rule</button></div>' : '<p class="muted" style="margin:0">None yet - every product follows its service period, by day. Rules you choose are kept here by product name, never by customer.</p>') + '</section>' +
      '<section class="card"><h2>Column presets</h2>' + (s.presets.length ? '<ul class="checks">' + s.presets.map(function (p, i) { return '<li style="justify-content:space-between"><span><b>' + esc(p.name) + '</b> · ' + esc(plural(Object.keys(p.map).length, 'column')) + '</span><button class="btn small ghost" type="button" data-act="rmpreset" data-i="' + i + '">Remove</button></li>'; }).join('') + '</ul>' : '<p class="muted" style="margin:0">None yet. A preset keeps the header names an export uses - never a value - so the next file maps at once.</p>') + '</section>' +
      '<section class="card"><h2>Journal account names</h2>' + accountsHtml() + '</section>' +
      '<section class="card"><h2>Defaults</h2><p class="small"><b>When a file shows no evidence, a period’s end is</b></p>' +
      radio('periodEndDefault', '', s.periodEnd, 'Ask me each time', '') + radio('periodEndDefault', 'exclusive', s.periodEnd, 'The next period’s first day (exclusive)', 'The way Stripe writes it') + radio('periodEndDefault', 'inclusive', s.periodEnd, 'Its own last day (inclusive)', '') +
      '<label class="check small"><input type="checkbox" data-set="mask"' + (s.mask ? ' checked' : '') + '> Mask customer names in exports</label></section>' +
      '<section class="card"><h2>On this device</h2><p class="small muted">' + esc(real.persistent() ? 'Settings and two small flags are kept in this browser’s storage - never a customer, an invoice, an amount or a date. A billing export is read in memory and gone when the page closes.' : 'This browser will not keep anything (a private window?) - your settings last until the tab closes.') + '</p><div class="btns"><button class="btn small danger" type="button" data-act="clearall">Clear everything Waterfall keeps here</button></div></section></div>' +
      '<p class="small muted">' + esc(C.NOT_POLICY) + '</p></div>';
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

  /* ---------------- the AI: "Suggest rules for my products" ---------------- */

  var WHY_AI = 'Suggesting rules uses about a cent of AI credit, so it needs a free account (it comes with $2).';
  /** The body as JSON, one product a line - the same object api() sends. */
  function sentText(body) { return '{"products": [\n' + body.products.map(function (p) { return '  ' + JSON.stringify(p); }).join(',\n') + '\n]}'; }
  function openAi() {
    engine.run('aiPayload').then(function (pl) {
      var body = { products: pl.products };
      sheet('<h2>✨ Suggest rules for my products</h2><p class="muted small">Only the product descriptions are sent - ' + esc(plural(pl.products.length, 'description')) + ', each cut to 120 characters, with the share of its lines that have a service period, the line types seen and the usual period length, worked out on this device. <b>Never a customer, an invoice id, an amount or a date.</b> You read every suggestion and choose which to apply.</p>' +
        (pl.held ? '<p class="small note">' + esc(plural(pl.held, 'description') + ' held back - each names a customer or an invoice from your file, or is past the first 200.') + '</p>' : '') +
        '<p class="lab">Exactly what will be sent</p><pre class="sent-pre" tabindex="0" id="aiSent">' + esc(sentText(body)) + '</pre>' +
        '<p class="small muted" style="margin:8px 0 0">' + esc(C.NOT_POLICY) + ' The answer can only use the rules on the list; anything else is dropped.</p>' +
        '<div id="aiErr"></div><div class="btns" id="aiActs" style="margin-top:10px"></div>', function (root) {
        var acts = $('#aiActs', root);
        if (!pl.products.length) { acts.innerHTML = '<p class="small muted">Nothing to send - every description names a customer or an invoice.</p>'; return; }
        if (!signedIn()) {
          acts.innerHTML = '<p class="small muted" style="width:100%;margin:0">It uses about a cent of AI credit, so it needs a free account - which comes with $2 and works across every app on this site. Choosing rules by hand is free.</p><button class="btn" type="button" id="aiSignin">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button>';
          $('#aiSignin', root).addEventListener('click', function () { openAccount(WHY_AI, openAi); });
          return;
        }
        acts.innerHTML = '<button class="btn" type="button" id="aiSend">Send these descriptions</button><span class="small muted">About a cent' + (state.me.tier === 'paid' ? ' (member model)' : '') + '.</span>';
        $('#aiSend', root).addEventListener('click', function () {
          var b = $('#aiSend', root);
          b.disabled = true; b.textContent = 'Asking…';
          $('#aiErr', root).innerHTML = '';
          api('POST', 'api/ai/rules', body).then(function (res) {
            loadMe();
            showSuggestions(res, pl);
          }).catch(function (err) { b.disabled = false; b.textContent = 'Send these descriptions'; meteredError(err, $('#aiErr', root), openAi, WHY_AI); });
        });
      });
    }).catch(function (e) { toast(e.message); });
  }
  function showSuggestions(res, pl) {
    var list = res.suggestions.map(function (s) {
      var key = pl.keys[s.n - 1], now = ruleFor(key);
      var same = s.rule === now.rule && (s.rule !== 'months' || s.months === now.months);
      return { s: s, key: key, now: now, same: same, can: s.rule !== 'unsure' && !same };
    });
    var n = list.filter(function (x) { return x.can; }).length;
    sheet('<h2>Suggested rules</h2><p class="small muted">' + esc(plural(list.length, 'suggestion') + (res.dropped ? ' (' + plural(res.dropped, 'answer') + ' did not fit the list and were dropped)' : '') + '. Tick the ones to apply - ' + C.NOT_POLICY) + '</p><div class="sugg">' +
      list.map(function (x, i) {
        var rt = x.s.rule === 'unsure' ? 'Unsure - choose by hand' : C.ruleText(x.s.rule === 'months' ? { rule: 'months', months: x.s.months } : { rule: x.s.rule });
        return '<div class="sg"><input type="checkbox" id="sg' + i + '" data-sg="' + i + '"' + (x.can ? ' checked' : ' disabled') + '><label for="sg' + i + '"><span class="sd">' + esc(x.key) + '</span><span class="sr2"><b>' + esc(rt) + '</b>' + (x.same ? ' <span class="pill ok">already set</span>' : '<span class="sy"> - now ' + esc(C.ruleText(x.now).toLowerCase()) + '</span>') + '</span><span class="sy">' + esc(x.s.reason) + '</span></label></div>';
      }).join('') + '</div><div class="btns" style="margin-top:12px"><button class="btn" type="button" id="sgApply"' + (n ? '' : ' disabled') + '>Apply the ticked ones</button><button class="btn ghost" type="button" data-act="closesheet">Keep mine</button></div>', function (root) {
      $('#sgApply', root).addEventListener('click', function () {
        var done = 0;
        $$('[data-sg]', root).forEach(function (cb) {
          var x = list[Number(cb.getAttribute('data-sg'))];
          if (cb.checked && x && x.can && setRule(x.key, x.s.rule, x.s.months)) done++;
        });
        closeSheet();
        toast(done ? 'Applied ' + plural(done, 'rule') + '. The schedule is redrawn.' : 'Nothing changed.');
        if (done) refreshSchedule(); else keepPlace(draw);
      });
    });
  }

  /* ---------------- the account (shared shape with the lab) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }
  var FREE_LINE = 'Waterfall is free with no account, and nothing leaves this device. A free account keeps your presets, rules and account names across devices and adds rule suggestions - it comes with $2 of AI credit, and one account works across every app on this site.';
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Rule suggestions cost about a cent. Reading exports, the schedule, the waterfall, the tie-out, the journal and every export are free and never leave this device.</p><div id="billing"></div></div>' +
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Choosing rules by hand, the schedule, the waterfall, the tie-out and every export keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- wiring: one listener per kind of event ---------------- */

  function saveExport(kind) {
    exportNow(kind).then(function (f) { download(f.name, f.type, f.text); toast(state.demo ? 'Saved the EXAMPLE file - made on this device.' : 'Saved - made on this device.', 3200); }).catch(function (e) { toast(e.message); });
  }
  function writeMemo(then) {
    return exportNow('memo').then(function (f) { state.close.memo = f.text; state.close.memoName = f.name; state.close.at = stamp(); keepPlace(draw); if (then) then(f); }).catch(function (e) { toast(e.message); });
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    switch (act) {
      case 'home': e.preventDefault(); go('start'); break;
      case 'tab': go(el.getAttribute('data-tab')); break;
      case 'settings': go('settings'); break;
      case 'demo': loadDemo(); break;
      case 'leavedemo': state.demo = false; resetAll(); engine.run('drop'); go('start'); break;
      case 'read': readLines(); break;
      case 'preset': openPreset(); break;
      case 'tocolumns': go('columns'); break;
      case 'toschedule': go('schedule'); break;
      case 'totieout': go('tieout'); break;
      case 'tocustomers': go('customers'); if (state.demo && state.cust.ci === null) { var q = state.cust.list && state.cust.list.shown.filter(function (c) { return c.name === 'Quorvane Robotics'; })[0]; if (q) openCustomer(q.ci); else loadCustomers().then(function () { var q2 = state.cust.list.shown.filter(function (c) { return c.name === 'Quorvane Robotics'; })[0]; if (q2) openCustomer(q2.ci); }); } break;
      case 'tomemo': state.close.month = state.tie.month; go('close'); writeMemo(); break;
      case 'toclose': go('close'); break;
      case 'ccy': state.ccy = el.getAttribute('data-ccy'); state.device.home = state.ccy; if (!state.demo) deviceChanged(); keepPlace(draw); break;
      case 'selmonth': state.selMonth = el.getAttribute('data-m'); keepPlace(draw); break;
      case 'ai': openAi(); break;
      case 'kind': state.tie.kind = el.getAttribute('data-kind') === 'mrr' ? 'mrr' : 'billings'; state.tie.reading = null; if (state.tie.ran) runTie(); else keepPlace(draw); break;
      case 'tie': state.tie.reading = null; state.tie.ledgerPick = null; state.tie.deferredPick = null; state.hintPulsed = false; runTie(); break;
      case 'autoread': state.tie.reading = null; runTie(); break;
      case 'autopick': if (el.getAttribute('data-sec') === 'rev') state.tie.ledgerPick = null; else state.tie.deferredPick = null; runTie(); break;
      case 'hintok': state.device.hint = true; if (!state.demo) deviceChanged(); keepPlace(draw); break;
      case 'cust': openCustomer(Number(el.getAttribute('data-ci'))); break;
      case 'custccy': state.cust.ccy = el.getAttribute('data-ccy'); keepPlace(draw); break;
      case 'exp': saveExport(el.getAttribute('data-kind')); break;
      case 'memo': writeMemo(); break;
      case 'dlmemo': if (state.close.memo) { download(state.close.memoName || 'waterfall-close-memo.md', 'text/markdown', state.close.memo); toast('Saved - made on this device.'); } break;
      case 'copymemo': if (state.close.memo) copy(state.close.memo, 'Copied the memo.'); break;
      case 'rmrule': state.settings.rules.splice(Number(el.getAttribute('data-i')), 1); settingsChanged(); if (state.prep && !state.demo) refreshSchedule(); else keepPlace(draw); break;
      case 'clearrules': if (confirm('Clear every rule? Every product goes back to its service period, by day.')) { state.settings.rules = []; settingsChanged(); if (state.prep && !state.demo) refreshSchedule(); else keepPlace(draw); } break;
      case 'rmpreset': state.settings.presets.splice(Number(el.getAttribute('data-i')), 1); settingsChanged(); keepPlace(draw); break;
      case 'clearall': if (confirm('Clear everything Waterfall keeps on this device? Your account copy is untouched.')) { real.clearAll().then(function () { state.settings = C.defaults(); state.device = WS.cleanDevice({}); state.syncBase = null; toast('Cleared.'); keepPlace(draw); }); } break;
      case 'signin': openAccount(); break;
      case 'retrysync': pushSettings(); break;
      case 'closesheet': closeSheet(); break;
      default: break;
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.hasAttribute('data-file')) { var f = t.files && t.files[0]; t.value = ''; if (f) loadFile(f); return; }
    if (t.hasAttribute('data-map')) {
      var k = t.getAttribute('data-map'), v = t.value === '' ? null : Number(t.value);
      C.FKEYS.forEach(function (g) { if (g !== k && v !== null && state.map[g] === v) { state.map[g] = null; delete state.conf[g]; } });
      state.map[k] = v; state.conf[k] = v === null ? undefined : 'chosen';
      refreshQuestions();
      return;
    }
    if (t.hasAttribute('data-ans')) {
      var a = t.getAttribute('data-ans');
      if (a === 'periodEndDefault') { state.settings.periodEnd = t.value; settingsChanged(); return; }
      state.answers[a] = t.value;
      if (a === 'order') refreshQuestions(); else keepPlace(draw);
      return;
    }
    if (t.hasAttribute('data-rule') || t.hasAttribute('data-months')) {
      var pr = state.prep.products[Number(t.getAttribute(t.hasAttribute('data-rule') ? 'data-rule' : 'data-months'))];
      if (!pr) return;
      var now = ruleFor(pr.key);
      var ok = t.hasAttribute('data-rule') ? setRule(pr.key, t.value, now.months || 12) : setRule(pr.key, 'months', Number(t.value));
      if (ok) refreshSchedule(); else keepPlace(draw);
      return;
    }
    if (t.hasAttribute('data-sel')) {
      var s = t.getAttribute('data-sel');
      if (s === 'month') state.selMonth = t.value;
      if (s === 'closemonth') { state.close.month = t.value; state.close.memo = ''; }
      if (s === 'custmonth') state.cust.month = t.value;
      keepPlace(draw);
      return;
    }
    if (t.hasAttribute('data-tie')) {
      var f2 = t.getAttribute('data-tie');
      state.tie[f2] = t.value;
      if (f2 === 'month' || f2 === 'ccy') { state.tie.reading = null; state.tie.ledgerPick = null; state.tie.deferredPick = null; if (state.tie.ran) runTie(); else keepPlace(draw); }
      return;
    }
    if (t.hasAttribute('data-fx')) { state.tie.fx[t.getAttribute('data-fx')] = t.value; return; }
    if (t.hasAttribute('data-read')) {
      var r = state.tie.result && state.tie.result.dashboard;
      var cur2 = r ? Object.assign({}, r.reading) : {};
      cur2[t.getAttribute('data-read')] = t.checked;
      state.tie.reading = cur2; runTie();
      return;
    }
    if (t.hasAttribute('data-cand')) {
      var sec = t.getAttribute('data-cand');
      var picked = $$('[data-cand="' + sec + '"]').filter(function (x) { return x.checked; }).map(function (x) { return x.value; });
      if (sec === 'rev') state.tie.ledgerPick = picked; else state.tie.deferredPick = picked;
      runTie();
      return;
    }
    if (t.hasAttribute('data-acct')) {
      var acc = Object.assign({}, state.settings.accounts);
      acc[t.getAttribute('data-acct')] = t.value;
      var chk = C.cleanSettings({ accounts: acc }, true);
      if (chk.errors.length || !C.line(t.value, 60)) { toast(chk.errors[0] || 'An account needs a name.', 4200); keepPlace(draw); return; }
      state.settings.accounts = chk.settings.accounts; settingsChanged();
      if (state.prep) refreshSchedule(); else keepPlace(draw);
      return;
    }
    if (t.hasAttribute('data-set')) {
      var st = t.getAttribute('data-set');
      if (st === 'exact') { state.exact = t.checked; keepPlace(draw); return; }
      if (st === 'mask') { state.settings.mask = t.checked; settingsChanged(); state.close.memo = ''; keepPlace(draw); return; }
    }
  });
  var searchTimer = null;
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-search') === 'cust') {
      state.cust.q = t.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        engine.run('customers', { q: state.cust.q }).then(function (l) {
          state.cust.list = l;
          var box = $('.custlist');
          var keep = document.activeElement === t;
          keepPlace(draw);
          var s2 = $('[data-search="cust"]');
          if (keep && s2) { s2.focus(); try { s2.setSelectionRange(s2.value.length, s2.value.length); } catch (x) { /* fine */ } }
          return box;
        });
      }, 160);
      return;
    }
    if (t.hasAttribute('data-tie')) { state.tie[t.getAttribute('data-tie')] = t.value; return; }
    if (t.hasAttribute('data-fx')) { state.tie.fx[t.getAttribute('data-fx')] = t.value; }
  });
  document.addEventListener('toggle', function (e) {
    var d = e.target;
    if (d && d.getAttribute && d.hasAttribute('data-open')) state.open[d.getAttribute('data-open')] = d.open;
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) { closeSheet(); }
    if (e.key === 'Enter' && e.target && e.target.getAttribute && (e.target.hasAttribute('data-tie') || e.target.hasAttribute('data-fx')) && e.target.tagName === 'INPUT') { e.preventDefault(); runTie(); }
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
  Promise.all([real.getSettings(), real.getDevice(), real.getSyncBase()]).then(function (r) {
    if (r[0]) state.settings = r[0];
    if (r[1]) state.device = r[1];
    state.syncBase = r[2];
  }).catch(function () { /* fresh */ }).then(function () {
    if (location.hash && location.hash !== '#start' && location.hash !== '#settings') history.replaceState(null, '', BASE);
    route();
    return loadMe();
  }).then(function () { if (signedIn()) syncIn(); });
}());
