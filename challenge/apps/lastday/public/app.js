/* Lastday - the page. One file, no build step.
 *
 * NO PERSON EVER LEAVES THIS DEVICE. The identity provider's export and the
 * app exports are read in a worker (lastday-worker.js) - or here when there
 * is none - by LastdayCore, judged there, shown here, and exported as files
 * this browser saves. Leaver checklists and pasted requests stay here too.
 * The requests this page makes: sign-in, the account's system list and
 * settings (never a person), and the one optional AI call, whose payload is
 * the request MASKED on this device - shown in full before it is sent.
 *
 * Browser storage is opt-in: "Keep this on this device" (off by default,
 * with Clear). Every access is wrapped in try/catch.
 *
 * Every string a file held, a person typed, the server sent or a model wrote
 * is escaped before it is drawn, and no handler is written into markup:
 * clicks are routed by data-act attributes from one listener (the lab's CSP
 * allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.LastdayCore;
  var D = window.LastdayDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var KEY = 'lastday-v1';
  var VW = C.VERDICT_WORD, VI = C.VERDICT_ICON;

  function recall() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function store(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function forget() { try { localStorage.removeItem(KEY); } catch (e) { /* nothing kept */ } }

  function pad(n) { return ('0' + n).slice(-2); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function now() { var d = new Date(); return { day: today(), time: pad(d.getHours()) + ':' + pad(d.getMinutes()) }; }
  function stamp() { var n = now(); return n.day + 'T' + n.time; }
  // Does this browser write 14/11 for 14 November? Then 11/12 in a request
  // is read day first.
  var DAY_FIRST = (function () {
    try { var p = new Intl.DateTimeFormat(undefined).formatToParts(new Date(2026, 10, 14)); var t = p.map(function (x) { return x.type; }); return t.indexOf('day') < t.indexOf('month'); } catch (e) { return false; }
  }());
  function year() { return state.today.slice(0, 4); }
  function shortDay(iso) { return C.shortDay(iso, year()); }
  function dayLabel(iso) { return C.dayLabel(iso, year()); }
  function whenDone(at) { if (!at) return ''; var d = at.slice(0, 10), t = at.slice(11, 16); return (d === state.today ? 'today' : shortDay(d)) + (C.isTime(t) ? ', ' + C.clockLabel(t) : ''); }
  function newId() { return 'lv-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function blankWs() { return { inventory: C.defaults(), files: { idp: null, apps: [] }, result: null, leavers: [] }; }

  var state = {
    me: null, view: 'start', today: today(),
    keep: false, device: { initials: '', hint: false },
    ws: 'own', W: { own: blankWs(), demo: null },
    filter: 'issues', appFilter: '', shown: 120, rows: [],
    syncBase: null, syncState: 'local', syncErr: '', conflictOpen: false,
    current: null, draft: null, busy: '', paste: false, seq: 0, exportId: '',
  };
  function W() { return state.W[state.ws]; }
  function inv() { return W().inventory; }
  function settings() { return inv().settings; }
  function idpLabel() { return C.idpName(settings().idp); }
  function demo() { return state.ws === 'demo'; }

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
  function fileSafe(s) { return C.fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'leaver'; }

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
        w = new Worker('lastday-worker.js');
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
      if (op === 'parse' && data.file) {
        if (data.file.size > C.LIMITS.fileBytes) return Promise.reject(new Error('That file is over ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB. Export fewer columns, or split it.'));
        return data.file.text().then(function (text) { return local.parse({ id: data.id, role: data.role, name: data.file.name, n: data.n, text: text }); });
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

  /* ---------------- keeping it on this device: only if asked ---------------- */

  var saveTimer = null;
  function saveSoon() { if (!state.keep) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
  function slimResult(r) { return r ? { summary: r.summary, people: r.people, apps: r.apps, findings: r.findings, ok: r.ok.slice(0, 500), okTotal: r.okTotal, users: r.users, domains: r.domains, names: [], skipped: [], idpSkipped: [], statusCounts: r.statusCounts, idp: r.idp } : null; }
  function saveNow() {
    if (!state.keep) return;
    var own = state.W.own;
    var data = { v: 1, keep: true, device: state.device, syncBase: state.syncBase, ws: state.ws, own: { inventory: own.inventory, leavers: own.leavers, result: slimResult(own.result) }, demo: state.W.demo ? { leavers: state.W.demo.leavers } : null };
    if (store(data)) return;
    data.own.result = null;
    if (store(data)) { if (!state.toldBig) { state.toldBig = true; toast('The findings are too big to keep on this device - your systems and checklists are kept.', 5000); } return; }
    toast('This browser would not keep it - everything is still open here.', 4200);
  }
  function clearKept() { forget(); }

  /* ---------------- the system list: on this device, and in the account ---------------- */

  var pushTimer = null;
  function inventoryChanged(reanalyse) {
    inv().updatedAt = Date.now();
    saveSoon();
    pushSoon();
    if (reanalyse && W().result && W().files.idp) runAnalysis();
  }
  function pushSoon() {
    if (!signedIn() || !state.me.sync || demo()) return;
    clearTimeout(pushTimer);
    state.syncState = 'syncing'; drawSync();
    pushTimer = setTimeout(function () { pushInv(); }, 700);
  }
  function pushInv(base) {
    if (!signedIn()) return Promise.resolve();
    var own = state.W.own.inventory;
    var body = C.cleanInventory(own).inventory;
    delete body.updatedAt;
    return api('PUT', 'api/inventory', { inventory: body, base: base !== undefined ? base : state.syncBase }).then(function (out) {
      state.syncBase = out.inventory.updatedAt; state.syncState = 'synced'; state.syncErr = ''; saveSoon(); drawSync();
    }).catch(function (err) {
      if (err.status === 409 && err.data && err.data.inventory) return openConflict(err.data.inventory);
      state.syncState = 'error'; state.syncErr = err.message; drawSync();
    });
  }
  function pristine(i) { var a = C.cleanInventory(i).inventory, b = C.defaults(); delete a.updatedAt; delete b.updatedAt; return JSON.stringify(a) === JSON.stringify(b); }
  function same(a, b) { var x = C.cleanInventory(a).inventory, y = C.cleanInventory(b).inventory; x.updatedAt = 0; y.updatedAt = 0; return JSON.stringify(x) === JSON.stringify(y); }
  function syncIn() {
    if (!signedIn() || !state.me.sync) return Promise.resolve();
    return api('GET', 'api/inventory').then(function (out) {
      var acc = out.inventory, own = state.W.own;
      if (!acc) { state.syncBase = null; if (!pristine(own.inventory)) return pushInv(null); state.syncState = 'synced'; drawSync(); return null; }
      if (pristine(own.inventory)) { own.inventory = C.cleanInventory(acc).inventory; state.syncBase = acc.updatedAt; state.syncState = 'synced'; drawSync(); saveSoon(); if (!demo() && (state.view === 'systems' || state.view === 'find')) draw(); return null; }
      if (state.syncBase === acc.updatedAt) return pushInv();
      if (same(acc, own.inventory)) { state.syncBase = acc.updatedAt; state.syncState = 'synced'; drawSync(); return null; }
      return openConflict(acc);
    }).catch(function () { state.syncState = 'error'; drawSync(); });
  }
  function openConflict(acc) {
    if (state.conflictOpen) return;
    state.conflictOpen = true;
    var own = state.W.own.inventory, a = C.cleanInventory(acc).inventory;
    var desc = function (i) { return esc(plural(i.systems.length, 'system')) + ', ' + esc(plural(i.settings.domains.length, 'domain')) + ', dormant after ' + esc(i.settings.dormantDays) + ' days'; };
    sheet('<h2>Your systems changed on another device</h2><p class="muted">The copy in your account is newer than the one this device last saw.</p><div class="note"><p style="margin:0"><b>This device:</b> ' + desc(own) + '</p><p style="margin:6px 0 0"><b>Your account:</b> ' + desc(a) + '</p></div>' +
      '<div class="btns" style="margin-top:12px"><button class="btn" type="button" id="cfMerge">Merge them</button><button class="btn ghost" type="button" id="cfTake">Use the account’s copy</button><button class="btn ghost" type="button" id="cfKeep">Keep this device’s</button></div><p class="small muted" style="margin-top:8px">Merging keeps every system from both (this device’s wins where both have one of the same name) and both lists of domains and patterns.</p>', function (root) {
      var done = function (i, msg) { state.conflictOpen = false; closeSheet(); state.W.own.inventory = i; saveSoon(); if (!demo()) draw(); toast(msg); };
      $('#cfMerge', root).addEventListener('click', function () { var m = C.mergeInventory(a, own); done(m.inventory, 'Merged' + (m.added ? ': ' + plural(m.added, 'system') + ' added from the other device.' : '.')); pushInv(acc.updatedAt); });
      $('#cfTake', root).addEventListener('click', function () { done(a, 'Using the account’s copy.'); state.syncBase = acc.updatedAt; state.syncState = 'synced'; drawSync(); });
      $('#cfKeep', root).addEventListener('click', function () { done(own, 'Keeping this device’s systems.'); pushInv(acc.updatedAt); });
    });
  }
  function syncLine() {
    if (demo()) return '<span class="sync muted small">The demo’s systems stay on this device. <button class="link-btn" type="button" data-act="own">Your own</button> can follow your account.</span>';
    if (!signedIn()) return '<span class="sync muted small">Kept in this tab' + (state.keep ? ' and on this device' : '') + ' · <button class="link-btn" type="button" data-act="signin">sign in to keep your systems in your account</button> (never people)</span>';
    if (state.me && !state.me.sync) return '<span class="sync muted small">Saving to the account is unavailable right now - your systems are on this device.</span>';
    if (state.syncState === 'syncing') return '<span class="sync muted small">Saving your systems to your account…</span>';
    if (state.syncState === 'error') return '<span class="sync small err">Couldn’t save to your account' + (state.syncErr ? ': ' + esc(state.syncErr) : '') + ' <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="sync small" style="color:var(--ok);font-weight:700">✓ Systems and settings saved to your account - never a person</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }

  /* ---------------- routing ---------------- */

  function go(hash) {
    history.pushState(null, '', BASE + '#' + hash);
    route(); scrollTo(0, 0);
  }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    var m;
    if ((m = /^leaver\/([a-z0-9-]{1,40})$/.exec(h)) && leaverById(m[1])) { state.view = 'leaver'; state.current = m[1]; return draw(); }
    if (['find', 'files', 'people', 'leavers', 'new', 'systems', 'export'].indexOf(h) >= 0) state.view = h;
    else state.view = 'start';
    if (state.view === 'find' && !W().result) state.view = 'files';
    draw();
  }
  window.addEventListener('popstate', route);

  var TAB_OF = { find: 'find', files: 'find', people: 'people', leavers: 'leavers', leaver: 'leavers', 'new': 'leavers', systems: 'systems', export: 'export' };
  function draw() {
    closeSheet(true);
    var main = $('#main');
    $('#tabbar').hidden = state.view === 'start';
    $$('#tabbar [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === TAB_OF[state.view]) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var html;
    switch (state.view) {
      case 'files': html = filesHtml(); break;
      case 'find': html = findHtml(); break;
      case 'people': html = peopleHtml(); break;
      case 'leavers': html = leaversHtml(); break;
      case 'new': html = newHtml(); break;
      case 'leaver': html = leaverHtml(); break;
      case 'systems': html = systemsHtml(); break;
      case 'export': html = exportHtml(); break;
      default: html = startHtml();
    }
    main.innerHTML = html;
    wire();
    requestAnimationFrame(function () { $$('.bar > i[data-w]').forEach(function (b) { b.style.width = b.getAttribute('data-w') + '%'; }); });
  }

  function footer() {
    return '<footer class="foot"><p>Lastday finds and lists; a person removes every account and ticks every step. Exports and checklists never leave this device.</p><p>A Challenge Lab trial · <a href="../">more experiments</a></p></footer>';
  }
  function demoStrip() {
    if (!demo()) return '';
    return '<div class="demo-strip"><p><b>Demo:</b> Harbor &amp; Pine Dental, a made-up practice<span class="hide-sm"> with 14 staff and four apps</span>.</p><button class="link-btn" type="button" data-act="own">Use my own exports</button></div>';
  }
  function vpill(v, critical) {
    var p = '<span class="vp vp-' + esc(v) + '"><span aria-hidden="true">' + esc(VI[v] || '•') + '</span>' + esc(verdictWord(v)) + '</span>';
    return critical ? '<span class="vp vp-crit"><span aria-hidden="true">!!</span>Critical</span> ' + p : p;
  }
  function verdictWord(v) { return v === 'suspended' ? 'Suspended in ' + idpLabel().replace(/^the /, '') : VW[v] || v; }
  function edge(r) { return r.critical ? 'e-crit' : 'e-' + r.verdict; }
  function lastActive(r) { return r.lastActive ? shortDay(r.lastActive) + (r.idleDays ? ' · ' + r.idleDays + 'd ago' : ' · today') : r.never ? 'never' : '-'; }
  function personKey(r) { return r.user ? 'u:' + r.user.key : r.key ? 'e:' + r.key : 'n:' + C.nameKey(r.name); }

  /* ---------------- first run ---------------- */

  function mockHtml() {
    return '<div class="mock" aria-hidden="true"><div class="mh"><b>Jordan Reyes</b><span class="mcrit">!! Critical</span></div><div class="mto">Suspended in the identity provider 94 days ago</div><ul>' +
      '<li><span class="m-x">✗</span><span>Accounting - still <b>Company admin</b></span></li>' +
      '<li><span class="m-x">✗</span><span>File share - active, 7.9 GB</span></li>' +
      '<li><span class="m-x">✗</span><span>Video meetings - licensed</span></li>' +
      '<li><span class="m-o">–</span><span>Team chat - already off</span></li></ul></div>';
  }
  function startHtml() {
    var h = '<div class="stack">';
    h += '<section class="hero">' + mockHtml() + '<p class="kicker">For IT managers, MSPs and office managers</p><h1>When someone leaves, every account leaves with them.</h1>' +
      '<p>Disabling someone in the identity provider doesn’t reach apps that aren’t on single sign-on, doesn’t end live sessions or API tokens, and doesn’t give the licence back. Leavers keep access for months - and nobody can prove otherwise.</p>' +
      '<p>Lastday finds the accounts left behind, and turns a leaver request into a checklist with evidence. On this device, free.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="demo">Try the demo</button><button class="btn big ghost" type="button" data-act="own">Use my own exports</button></div>' +
      '<div class="trust"><span class="ico" aria-hidden="true">🔒</span><span><b>Read on this device, never uploaded.</b> User lists stay in this browser. No account needed - and nothing is kept after you close the tab unless you ask.</span></div></section>';
    h += '<div class="grid3 how">' + [
      ['Load the exports', 'Your identity provider’s user list, and each app’s - Lastday guesses the columns and shows you its guess.'],
      ['See every orphan', 'Accounts with no active person behind them, admins first: “7 orphaned accounts in 4 apps · 2 are admins”.'],
      ['Close it out', 'Paste the leaver email. Get a timed checklist - before, at the moment, within 24 hours, within 30 days - with evidence for every tick.'],
    ].map(function (s, i) { return '<section class="card"><span class="n" aria-hidden="true">' + (i + 1) + '</span><h2>' + esc(s[0]) + '</h2><p>' + esc(s[1]) + '</p></section>'; }).join('') + '</div>';
    h += '<div class="grid2"><section class="card"><h2>Where to find each export</h2><ul class="where">' +
      '<li><span class="ico" aria-hidden="true">🪪</span><span><b>Your identity provider</b><span class="small muted">Its user list exported as CSV - Okta, Microsoft Entra ID, Google Workspace, JumpCloud or any other. Status and last sign-in help when it has them.</span></span></li>' +
      '<li><span class="ico" aria-hidden="true">🧩</span><span><b>Each app</b><span class="small muted">Its member or user list as CSV, usually under the admin or billing settings - email, name, role and last active are what Lastday looks for.</span></span></li>' +
      '<li><span class="ico" aria-hidden="true">📋</span><span><b>No export button?</b><span class="small muted">Copy the user table from the admin page and paste it in - tabs and commas both work.</span></span></li></ul></section>' +
      '<section class="card"><h2>Got a leaver request already?</h2><p class="muted">Paste the email or ticket - “Sam’s last day is Friday, keep their mailbox for the manager” - and Lastday reads it into the leaver’s details, asks about what is missing, and builds the checklist.</p><button class="btn ghost" type="button" data-act="newleaver">Paste a request</button>' +
      '<p class="small muted" style="margin:12px 0 0">What it catches: accounts with no active person behind them, people suspended in the identity provider but active in an app, outside addresses, shared and service logins, and licences nobody has used in months.</p></section></div>';
    return h + footer() + '</div>';
  }

  /* ---------------- files ---------------- */

  function fileState(out, label) {
    var f = { id: out.id, role: out.role, name: out.name, headers: out.headers, sample: out.sample, guess: out.guess, stats: out.stats, map: {}, sure: {}, open: false, appName: label || out.appName || 'App', idp: out.idp };
    C.fieldKeys(out.role).forEach(function (k) { f.map[k] = out.guess.map[k]; f.sure[k] = out.guess.map[k] >= 0 ? out.guess.sure[k] : 'none'; });
    return f;
  }
  function readFile(role, file) {
    if (role === 'app' && W().files.apps.length >= C.LIMITS.apps) { toast('Up to ' + C.LIMITS.apps + ' app exports at once. Remove one first.', 4200); return Promise.resolve(); }
    var id = (role === 'idp' ? 'o-idp-' : 'o-app-') + (++state.seq);
    state.busy = 'Reading ' + file.name + '…'; draw();
    return engine.run('parse', { id: id, role: role, file: file, name: file.name, n: W().files.apps.length + 1 }).then(function (out) { took(out); })
      .catch(function (err) { state.busy = ''; draw(); toast(err.message, 5000); });
  }
  function readText(role, text, name) {
    if (!C.line(text, 10)) { toast('Paste the table first.'); return; }
    if (role === 'app' && W().files.apps.length >= C.LIMITS.apps) { toast('Up to ' + C.LIMITS.apps + ' app exports at once.', 4200); return; }
    var id = (role === 'idp' ? 'o-idp-' : 'o-app-') + (++state.seq);
    engine.run('parse', { id: id, role: role, text: text, name: name, n: W().files.apps.length + 1 }).then(function (out) { state.paste = false; took(out); })
      .catch(function (err) { toast(err.message, 5000); });
  }
  function took(out) {
    state.busy = '';
    var w = W();
    if (out.stats.empty) { toast('That file is empty.', 4000); draw(); return; }
    var f = fileState(out);
    if (out.role === 'idp') {
      if (w.files.idp) engine.run('drop', { id: w.files.idp.id });
      w.files.idp = f;
      if (settings().idp === 'other' && out.idp && out.idp !== 'other') { settings().idp = out.idp; inventoryChanged(false); }
    } else w.files.apps.push(f);
    draw();
    var el = $('#file-' + f.id); if (el) el.scrollIntoView({ block: 'nearest' });
  }
  function allProblems() {
    var f = W().files, out = [];
    if (!f.idp) out.push('Load the identity provider’s export.');
    else C.mappingProblems('idp', f.idp.map).forEach(function (x) { out.push('Identity provider: ' + x); });
    if (!f.apps.length) out.push('Load at least one app’s user export.');
    f.apps.forEach(function (a) { C.mappingProblems('app', a.map).forEach(function (x) { out.push(a.appName + ': ' + x); }); });
    return out;
  }
  function runAnalysis() {
    var w = W(), f = w.files;
    if (allProblems().length) { toast(allProblems()[0], 4200); return Promise.resolve(); }
    state.busy = 'Finding the orphans…'; if (state.view === 'files') draw();
    var data = { ws: state.ws, idp: { id: f.idp.id, map: f.idp.map }, apps: f.apps.map(function (a) { return { id: a.id, name: a.appName, map: a.map }; }), settings: settings(), today: state.today, idpKind: settings().idp };
    return engine.run('analyse', data).then(function (r) {
      state.busy = ''; w.result = r; state.filter = 'issues'; state.appFilter = ''; state.shown = 120;
      saveSoon();
      if (state.view === 'files' || state.view === 'find') { if (state.view === 'files') go('find'); else draw(); } else if (state.view !== 'start') draw();
    }).catch(function (err) { state.busy = ''; toast(err.message, 5000); draw(); });
  }

  function colLetter(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function statNotes(f) {
    var s = f.stats, n = [];
    if (!s.header) n.push('No header line - the columns are numbered. Check each one below.');
    if (s.preamble) n.push(plural(s.preamble, 'line') + ' above the header skipped.');
    if (s.truncated) n.push('Only the first ' + C.groups(s.kept) + ' of ' + C.groups(s.total) + ' rows were read (the limit is ' + C.groups(C.LIMITS.rows) + ' a file).');
    if (s.ragged) n.push(plural(s.ragged, 'row') + ' had a different number of cells - padded or cut.');
    if (s.invisible) n.push(plural(s.invisible, 'invisible or direction-changing character') + ' removed.');
    if (s.cut) n.push(plural(s.cut, 'cell') + ' longer than ' + C.LIMITS.cell + ' characters cut.');
    if (s.wide) n.push(plural(s.wide, 'column') + ' past the ' + C.LIMITS.columns + '-column limit left out.');
    if (s.openQuote) n.push('A quote was never closed - the end of the file may be one long cell.');
    return n;
  }
  function fileCard(f) {
    var role = f.role;
    var h = '<div class="appfile" id="file-' + esc(f.id) + '"><div class="fileline"><b>📄 ' + esc(f.name) + '</b><span class="small muted">' + esc(C.groups(f.stats.kept)) + ' rows · ' + esc(f.stats.delimiter) + ' separated</span><button class="btn small ghost" type="button" data-act="rmfile" data-id="' + esc(f.id) + '">Remove</button></div>';
    if (role === 'app') h += '<label class="field"><span>App name</span><input class="input" data-appname="' + esc(f.id) + '" value="' + esc(f.appName) + '" maxlength="40" autocomplete="off"></label>';
    else h += '<label class="field"><span>Identity provider</span><select class="input" data-idpkind="1">' + Object.keys(C.IDPS).map(function (k) { return '<option value="' + esc(k) + '"' + (settings().idp === k ? ' selected' : '') + '>' + esc(k === 'other' ? 'Another one' : C.IDPS[k]) + '</option>'; }).join('') + '</select><small>Only for the words: “suspended in Okta since Aug 1”.</small></label>';
    var notes = statNotes(f);
    if (notes.length) h += '<ul class="notes">' + notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
    var allSure = C.mappingProblems(role, f.map).length === 0 && C.fieldKeys(role).every(function (k) { return f.map[k] < 0 || ['sure', 'you'].indexOf(f.sure[k]) >= 0; });
    if (allSure && !f.open) {
      var mapped = C.FIELDS[role].filter(function (fd) { return f.map[fd.key] >= 0; });
      h += '<div class="mapsum"><p style="margin:0"><b>✓ Every column recognised</b></p><ul class="mapchips">' + mapped.map(function (fd) { return '<li><span class="muted">' + esc(fd.label) + '</span> <b>' + esc(colLetter(f.map[fd.key]) + ' · ' + f.headers[f.map[fd.key]]) + '</b></li>'; }).join('') + '</ul><button class="btn small ghost" type="button" data-act="mapopen" data-id="' + esc(f.id) + '">Check or change</button></div>';
    } else {
      h += '<p class="small muted" style="margin:0">' + (f.guess.unsure ? '<b>Check these.</b> ' : '') + 'Lastday’s guess, from the header names and what the values look like. Change any that are wrong.</p><div class="maprows">' + C.FIELDS[role].map(function (fd) {
        var cur = f.map[fd.key], sure = f.sure[fd.key];
        var opts = '<option value="-1"' + (cur < 0 ? ' selected' : '') + '>— not in this file —</option>' + f.headers.map(function (hd, i) { return '<option value="' + i + '"' + (cur === i ? ' selected' : '') + '>' + esc(colLetter(i) + ' · ' + hd) + '</option>'; }).join('');
        var tag = cur < 0 ? '<span class="sure sure-none">Not used</span>' : sure === 'sure' ? '<span class="sure sure-sure">✓ Recognised</span>' : sure === 'you' ? '<span class="sure sure-sure">✓ Your choice</span>' : sure === 'likely' ? '<span class="sure sure-likely">Likely</span>' : '<span class="sure sure-unsure">? Check this</span>';
        return '<div class="maprow"><label class="fl" for="map-' + esc(f.id + '-' + fd.key) + '"><b>' + esc(fd.label) + '</b>' + (fd.need ? '<span class="need">needed</span>' : '') + '<small>' + esc(fd.hint || '') + '</small></label><select class="input" id="map-' + esc(f.id + '-' + fd.key) + '" data-map="' + esc(f.id) + '" data-field="' + esc(fd.key) + '">' + opts + '</select>' + tag + '</div>';
      }).join('') + '</div>';
      var probs = C.mappingProblems(role, f.map);
      if (probs.length) h += '<ul class="notes" style="color:var(--orphan)">' + probs.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    }
    var used = {};
    Object.keys(f.map).forEach(function (k) { if (f.map[k] >= 0) used[f.map[k]] = C.fieldOf(role, k).label; });
    h += '<details class="why"><summary>Preview the first rows</summary><div class="tablewrap" tabindex="0"><table class="prev"><thead><tr>' + f.headers.map(function (hd, i) { return '<th><span class="fchip' + (used[i] ? '' : ' off') + '">' + esc(used[i] || 'not used') + '</span>' + esc(colLetter(i) + ' · ' + hd) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      f.sample.map(function (r) { return '<tr>' + f.headers.map(function (_, i) { return '<td title="' + esc(r[i] || '') + '">' + esc(r[i] || '') + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div></details>';
    return h + '</div>';
  }
  function dropZone(role, multiple) {
    var what = role === 'idp' ? 'the identity provider’s export' : (W().files.apps.length ? 'another app’s export' : 'an app’s user export');
    return '<div class="drop" data-drop="' + role + '"><p style="margin:0"><b>Drop ' + esc(what) + ' here</b> <span class="muted">- CSV or tab separated</span></p>' +
      '<div class="btns"><span class="btn filepick">Choose file' + (multiple ? 's' : '') + '<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" data-file="' + role + '"' + (multiple ? ' multiple' : '') + ' aria-label="Choose ' + esc(what) + '"></span>' +
      '<button class="btn ghost" type="button" data-act="pastetoggle" data-role="' + role + '">Paste it instead</button></div>' +
      (state.paste === role ? '<label class="field" style="width:100%"><span>Paste the table</span><textarea class="input code" id="paste-' + role + '" rows="6" spellcheck="false"></textarea></label><button class="btn small" type="button" data-act="pasteread" data-role="' + role + '">Read it</button>' : '') + '</div>';
  }
  function filesHtml() {
    var w = W(), f = w.files;
    var h = '<div class="stack">' + demoStrip();
    h += '<section class="card"><div class="sec-head"><h1>Your exports</h1>' + (w.result ? '<button class="btn small ghost" type="button" data-act="tab" data-tab="find">Back to the findings</button>' : '') + '</div>' +
      '<p class="privacy-line"><span aria-hidden="true">🔒</span><span><b>Read on this device, never uploaded.</b> Up to ' + C.LIMITS.apps + ' apps, ' + C.groups(C.LIMITS.rows) + ' rows and ' + Math.round(C.LIMITS.fileBytes / 1048576) + ' MB a file. Nothing is kept after you close the tab unless you ask.</span></p></section>';
    if (state.busy) h += '<section class="card" role="status"><p style="margin:0"><b>' + esc(state.busy) + '</b></p><div class="bar" style="margin-top:8px"><i data-w="60"></i></div></section>';
    h += '<section class="card stack"><div><h2>1 · Your identity provider</h2><p class="small muted" style="margin:0">Its user export as CSV - Okta, Microsoft Entra ID, Google Workspace, JumpCloud or any other. A status column (active, suspended) and last sign-in make the findings sharper.</p></div>' + (f.idp ? fileCard(f.idp) : dropZone('idp', false)) + '</section>';
    h += '<section class="card stack"><div><h2>2 · Your apps</h2><p class="small muted" style="margin:0">Each app’s user or member list as CSV, from its admin settings - one file per app. Email, name, role and last active are what Lastday looks for.</p></div>' + f.apps.map(fileCard).join('') + (f.apps.length < C.LIMITS.apps ? dropZone('app', true) : '') + '</section>';
    var cd = w.result ? w.result.domains : null;
    h += '<section class="card"><h2>3 · Your company</h2><p class="small" style="margin:0 0 8px">' + (settings().domains.length ? 'Addresses at <b>' + esc(settings().domains.join(', ')) + '</b> are yours - the first is the main one, the rest are aliases of it.' : cd && cd.list.length ? 'Read from the export: <b>' + esc(cd.list.join(', ')) + '</b>. Anything else counts as external.' : 'Your domains are read from the identity provider’s export. Add aliases (example.com = example.co.uk) so they count as the same person.') + ' Dormant means ' + esc(settings().dormantDays) + ' days without activity.</p><button class="btn small ghost" type="button" data-act="settings">Domains, shared accounts and dormant days</button></section>';
    var probs = allProblems();
    h += '<div class="stack"><button class="btn big" type="button" data-act="analyse"' + (probs.length || state.busy ? ' disabled' : '') + '>' + (w.result ? 'Find them again' : 'Find the orphans') + '</button>' + (probs.length ? '<ul class="notes">' + probs.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
    return h + footer() + '</div>';
  }

  /* ---------------- the findings ---------------- */

  var TILES = [['critical', 'Critical', 'crit'], ['orphan', 'Orphans', 'orphan'], ['suspended', 'Suspended in IdP', 'suspended'], ['external', 'External', 'external'], ['shared', 'Shared / service', 'shared'], ['dormant', 'Dormant', 'dormant'], ['off', 'Already off', 'off'], ['ok', 'OK', 'ok']];
  function allRows(r) { return r.findings.concat(r.ok); }
  function filtered(r) {
    var rows = state.filter === 'ok' ? r.ok : state.filter === 'all' ? allRows(r) : r.findings;
    return rows.filter(function (x) {
      if (state.appFilter && x.app !== state.appFilter) return false;
      if (state.filter === 'issues') return x.verdict !== 'off';
      if (state.filter === 'critical') return x.critical;
      if (state.filter === 'all' || state.filter === 'ok') return true;
      return x.verdict === state.filter;
    });
  }
  function summaryHtml(r) {
    var s = r.summary, c = s.counts;
    var big = s.orphaned ? esc(plural(s.orphaned, 'orphaned account')) + ' in ' + esc(plural(s.apps, 'app')) : 'No orphaned accounts ✓';
    var sub = [];
    if (s.orphaned) sub.push(s.admins ? '<span class="crit">' + esc(plural(s.admins, 'is an admin', 'are admins')) + '</span>' : 'none are admins');
    if (s.oldest !== null) sub.push('oldest leaver: ' + esc(plural(s.oldest, 'day')) + (s.oldestName ? ' (' + esc(s.oldestName) + ')' : ''));
    if (!s.orphaned) sub.push(esc(plural(c.total, 'account')) + ' checked in ' + esc(plural(r.apps.length, 'app')));
    var counts = { critical: c.critical };
    C.VERDICTS.forEach(function (v) { counts[v] = c[v]; });
    var h = '<section class="card summary"><p class="lab">' + esc(C.cap1(idpLabel().replace(/^the /, ''))) + ' · ' + esc(plural(r.users, 'person', 'people')) + ' · ' + esc(plural(r.apps.length, 'app')) + ' · ' + esc(plural(c.total, 'account')) + '</p><p class="big">' + big + '</p><p class="sub">' + sub.join(' · ') + '</p>';
    h += '<div class="tiles" role="group" aria-label="Show only">' + TILES.map(function (t) {
      return '<button type="button" class="tile e-' + t[2] + (counts[t[0]] ? '' : ' zero') + '" data-act="filter" data-f="' + t[0] + '" aria-pressed="' + (state.filter === t[0]) + '"><b>' + esc(counts[t[0]]) + '</b><span>' + esc(t[0] === 'suspended' ? 'Suspended in ' + idpLabel().replace(/^the /, '') : t[1]) + '</span></button>';
    }).join('') + '</div>';
    h += '<div class="btns"><button class="btn small" type="button" data-act="tab" data-tab="people">By person</button><button class="btn small ghost" type="button" data-act="files">' + (demo() ? 'See the demo files' : 'Change files') + '</button><button class="btn small ghost" type="button" data-act="dlfind">Download findings (CSV)</button></div></section>';
    return h;
  }
  function filterLine(r, rows) {
    var label = state.filter === 'issues' ? 'Accounts that need action' : state.filter === 'all' ? 'Every account' : state.filter === 'critical' ? 'Critical: admins with no active person behind them' : state.filter === 'ok' ? 'Accounts that are fine' : verdictWord(state.filter);
    var h = '<div class="sec-head"><h2>' + esc(label) + ' <span class="muted">(' + esc(rows.length) + ')</span></h2>' + (state.filter !== 'issues' ? '<button class="link-btn" type="button" data-act="filter" data-f="issues">Show what needs action</button>' : '<button class="link-btn" type="button" data-act="filter" data-f="all">Show every account</button>') + '</div>';
    if (r.apps.length > 1) h += '<div class="filters" role="group" aria-label="App">' + [{ id: '', name: 'All apps' }].concat(r.apps).map(function (a) {
      var n = a.id ? r.findings.filter(function (x) { return x.app === a.id && x.verdict !== 'off'; }).length : r.findings.filter(function (x) { return x.verdict !== 'off'; }).length;
      return '<button type="button" data-act="appf" data-app="' + esc(a.id) + '" aria-pressed="' + (state.appFilter === a.id) + '">' + esc(a.name) + ' <span class="n">' + esc(n) + '</span></button>';
    }).join('') + '</div>';
    if (state.filter === 'ok' && r.okTotal > r.ok.length) h += '<p class="small muted">Showing the first ' + esc(C.groups(r.ok.length)) + ' of ' + esc(C.groups(r.okTotal)) + ' OK accounts - every finding is shown in full.</p>';
    return h;
  }
  function hintHtml(r) {
    if (!demo() || state.device.hint) return '';
    var top = r.findings.filter(function (x) { return x.critical; })[0];
    if (!top) return '';
    var gone = top.user ? (top.user.status === 'suspended' ? 'was suspended' : 'was deprovisioned') + ' in ' + idpLabel() + (top.leftDays !== null ? ' ' + plural(top.leftDays, 'day') + ' ago' : '') : 'is not in ' + idpLabel() + ' at all';
    return '<div class="hint" role="note"><span class="ico" aria-hidden="true">👉</span><div><p><b>Start here.</b> ' + esc(top.name || top.email) + ' ' + esc(gone) + ' - and is still ' + esc(top.role ? 'a ' + top.role : 'an admin') + ' in ' + esc(top.appName) + '. An admin left behind can add users and change bank details, and nothing alerts anyone.</p><div class="btns"><button class="btn small" type="button" data-act="person" data-k="' + esc(personKey(top)) + '">See everything of theirs</button></div></div><button class="link-btn" type="button" data-act="hintoff">Got it</button></div>';
  }
  function findHtml() {
    var r = W().result;
    var rows = filtered(r);
    state.rows = rows;
    var shown = rows.slice(0, state.shown);
    var h = '<div class="stack">' + demoStrip() + summaryHtml(r) + hintHtml(r) + '<section class="stack">' + filterLine(r, rows);
    if (!rows.length) h += '<div class="card empty"><p><b>Nothing here.</b></p><p class="muted small">' + (state.filter === 'issues' ? 'Every account has an active person behind it.' : 'Try another filter.') + '</p></div>';
    else {
      var pulse = demo() && !state.device.hint;
      h += '<ul class="flist phone">' + shown.map(function (x, i) {
        return '<li><button type="button" class="frow ' + edge(x) + (pulse && i === 0 && x.critical ? ' pulse' : '') + '" data-act="row" data-i="' + i + '"><span class="tags">' + vpill(x.verdict, x.critical) + '</span><span class="who">' + esc(x.name || x.email) + '</span><span class="small muted">' + esc(x.appName) + '</span><span class="acct">' + (x.name ? esc(x.email) + ' · ' : '') + (x.role ? esc(x.role) + ' · ' : '') + 'last active ' + esc(lastActive(x)) + '</span><span class="why">' + esc(x.why) + (x.how ? ' <span class="muted">(' + esc(x.how) + ')</span>' : '') + '</span></button></li>';
      }).join('') + '</ul>';
      h += '<div class="ftable-wrap" tabindex="0"><table class="ftable"><thead><tr><th>Finding</th><th>Person</th><th>App and role</th><th>Last active</th><th>Why</th></tr></thead><tbody>' + shown.map(function (x, i) {
        return '<tr class="' + edge(x) + '" data-act="row" data-i="' + i + '"><td><span class="pills">' + vpill(x.verdict, x.critical) + '</span></td><td><button type="button" class="rowbtn" data-act="row" data-i="' + i + '"><span class="who">' + esc(x.name || x.email) + '</span>' + (x.name ? '<span class="sub">' + esc(x.email) + '</span>' : '') + '</button></td><td><span class="who">' + esc(x.appName) + '</span><span class="sub">' + esc(x.role || 'no role given') + '</span></td><td class="nowrap">' + esc(lastActive(x)) + '</td><td class="why">' + esc(x.why) + (x.how ? '<span class="sub">' + esc(x.how) + '</span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
      if (rows.length > shown.length) h += '<button class="btn ghost more" type="button" data-act="more">Show ' + esc(Math.min(120, rows.length - shown.length)) + ' more of ' + esc(rows.length - shown.length) + '</button>';
    }
    h += '</section>';
    if (r.skipped.length || r.idpSkipped.length) h += '<details class="why card"><summary>Rows the files had that were left out (' + esc(r.skipped.length + r.idpSkipped.length) + ')</summary><ul class="notes">' + r.idpSkipped.map(function (s) { return '<li>' + esc('Identity provider, line ' + s.line + ': ' + s.why) + '</li>'; }).join('') + r.skipped.map(function (s) { return '<li>' + esc(s.app + ', line ' + s.line + ': ' + s.why) + '</li>'; }).join('') + '</ul></details>';
    return h + footer() + '</div>';
  }

  /** Every account of one person, from the rows this page holds. */
  function accountsOf(key) { var r = W().result; return r ? allRows(r).filter(function (x) { return personKey(x) === key; }) : []; }
  function openPerson(key) {
    var r = W().result;
    var accts = accountsOf(key);
    if (!accts.length) return;
    var p = r.people.filter(function (x) { return x.key === key; })[0];
    var first = accts[0], u = first.user;
    var name = (p && p.name) || first.name || first.email;
    var state1 = !u ? 'Not in ' + idpLabel() : C.cap1(u.status) + ' in ' + idpLabel() + (u.changed ? ' since ' + C.niceDay(u.changed) : '') + (u.lastLogin ? ' · last signed in ' + C.niceDay(u.lastLogin) : '');
    var leaver = accts.some(function (x) { return C.isOrphaned(x.verdict); });
    sheet('<h2>' + esc(name) + '</h2><p class="small muted anywhere">' + esc(u ? u.email : first.email) + ' · ' + esc(state1) + '</p>' +
      '<ul class="accts">' + accts.map(function (x) {
        return '<li class="' + edge(x) + '"><div class="ah"><b>' + esc(x.appName) + '</b>' + vpill(x.verdict, x.critical) + '</div><span class="small">' + esc(x.email) + (x.role ? ' · ' + esc(x.role) : '') + ' · last active ' + esc(lastActive(x)) + '</span><span class="small">' + esc(x.why) + '</span>' + (x.how ? '<span class="small muted">' + esc(C.cap1(x.how)) + '</span>' : '') + '</li>';
      }).join('') + '</ul>' +
      '<div class="btns" style="margin-top:14px">' + (leaver || (p && p.group === 'leaver') ? '<button class="btn" type="button" id="pMake">Make a leaver checklist</button>' : '') + '<button class="btn ghost" type="button" id="pCopy">Copy as text</button></div>', function (root) {
      var mk = $('#pMake', root);
      if (mk) mk.addEventListener('click', function () { closeSheet(true); leaverFromPerson(name, u ? u.email : first.email, u && u.changed); });
      $('#pCopy', root).addEventListener('click', function () { copy((p ? p.line : name) + '\n' + accts.map(function (x) { return '- ' + x.appName + ': ' + verdictWord(x.verdict) + (x.role ? ' (' + x.role + ')' : '') + ' - ' + x.why; }).join('\n'), 'Copied.'); });
    });
  }

  /* ---------------- people ---------------- */

  function peopleHtml() {
    var r = W().result;
    var h = '<div class="stack">' + demoStrip();
    if (!r) return h + '<section class="card empty"><h1>People</h1><p class="muted">Load your exports first - this lists everyone who still has an account somewhere they should not.</p><button class="btn" type="button" data-act="tab" data-tab="find">Load the exports</button></section>' + footer() + '</div>';
    var groups = [['leaver', 'Left, still holding access', 'No active person in ' + idpLabel() + ' - and still signed up here. Admins first.'], ['external', 'Outside accounts', 'Another domain: a guest, contractor or outside firm. Check they still need it.'], ['dormant', 'Dormant', 'Active in ' + idpLabel() + ', but no activity here in ' + settings().dormantDays + ' days or more - a licence to reclaim.']];
    h += '<section class="card"><h1>People</h1><p class="muted" style="margin:0">' + esc(C.summaryLine(r.summary)) + '.</p></section>';
    groups.forEach(function (g) {
      var ps = r.people.filter(function (p) { return p.group === g[0]; });
      if (!ps.length) return;
      h += '<section class="stack"><div><h2 style="margin:0">' + esc(g[1]) + ' <span class="muted">(' + esc(ps.length) + ')</span></h2><p class="small muted" style="margin:2px 0 0">' + esc(g[2]) + '</p></div><div class="grid2">' + ps.map(function (p) {
        var rest = p.line.indexOf(': ') > 0 ? p.line.slice(p.line.indexOf(': ') + 2) : p.line;
        return '<section class="card pcard ' + (p.critical ? 'e-crit' : 'e-' + p.worst) + '"><div class="row spread"><h3>' + esc(p.name || p.email) + '</h3>' + (p.critical ? '<span class="vp vp-crit"><span aria-hidden="true">!!</span>Critical</span>' : '') + '</div><p class="pline">' + esc(C.cap1(rest)) + '</p><p class="pmeta">' + esc(p.email) + (p.leftDays !== null ? ' · gone ' + esc(plural(p.leftDays, 'day')) : '') + '</p>' +
          '<ul class="appchips">' + p.accounts.filter(function (a) { return g[0] === 'leaver' || a.verdict === p.worst; }).map(function (a) { return '<li class="' + (a.verdict === 'off' ? 'offc' : C.elevated(a.level) && C.isOrphaned(a.verdict) ? 'hot' : '') + '">' + esc(a.appName) + (a.verdict === 'off' ? ' · already off' : a.role ? ' · ' + esc(a.role) : '') + '</li>'; }).join('') + '</ul>' +
          '<div class="btns">' + (g[0] === 'leaver' ? '<button class="btn small" type="button" data-act="mkperson" data-k="' + esc(p.key) + '">Leaver checklist</button>' : '') + '<button class="btn small ghost" type="button" data-act="person" data-k="' + esc(p.key) + '">Details</button></div></section>';
      }).join('') + '</div></section>';
    });
    // Shared accounts by address: reception@ in three apps is one password story.
    var shared = [], byAddr = {};
    r.findings.forEach(function (x) { if (x.verdict !== 'shared') return; var k = x.key || x.email; if (!byAddr[k]) { byAddr[k] = { email: x.email, why: x.sharedWhy, apps: [] }; shared.push(byAddr[k]); } byAddr[k].apps.push(x.appName + (x.role ? ' (' + x.role + ')' : '')); });
    if (shared.length) h += '<section class="stack"><div><h2 style="margin:0">Shared and service accounts <span class="muted">(' + esc(shared.length) + ')</span></h2><p class="small muted" style="margin:2px 0 0">Nobody leaves from these - but anyone who leaves may know the password. Rotate it when they go.</p></div><section class="card"><ul class="accts">' + shared.map(function (x) {
      return '<li class="e-shared"><div class="ah"><b>' + esc(x.email) + '</b><span class="small muted">' + esc(x.apps.join(', ')) + '</span></div><span class="small">' + esc(C.cap1(x.why)) + '.</span></li>';
    }).join('') + '</ul></section></section>';
    if (!r.people.length && !shared.length) h += '<section class="card empty"><p><b>Nobody to chase.</b></p><p class="muted small">Every account has an active person behind it.</p></section>';
    return h + footer() + '</div>';
  }

  /* ---------------- leavers ---------------- */

  function leaverById(id) { var l = W().leavers; for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  function loadedApps() { return W().result ? W().result.apps.map(function (a) { return a.name; }) : []; }
  /** The accounts the finder saw for this leaver: from the worker's last
   *  run when the files are loaded, else from the rows this page holds. */
  function foundFor(lv) {
    var r = W().result;
    if (!r) return Promise.resolve([]);
    var local = C.accountsFor(allRows(r), lv.email, lv.name, C.aliasMap(r.domains.list));
    if (!W().files.idp) return Promise.resolve(local);
    return engine.run('lookup', { ws: state.ws, email: lv.email, name: lv.name }).then(function (x) { return x && x.length ? x : local; }, function () { return local; });
  }
  function build(lv) {
    return foundFor(lv).then(function (found) {
      var fresh = C.buildChecklist(lv, inv(), found, loadedApps());
      lv.tasks = C.mergeTasks(lv.tasks, fresh);
      lv.foundApps = found.map(function (x) { return x.appName; }).filter(function (a, i, s) { return s.indexOf(a) === i; });
      lv.checkedApps = loadedApps();
      return lv;
    });
  }
  function addLeaver(lv) {
    lv.id = newId(); lv.createdAt = stamp(); lv.demo = demo();
    return build(lv).then(function () {
      W().leavers.unshift(lv);
      if (W().leavers.length > C.LIMITS.leavers) W().leavers.length = C.LIMITS.leavers;
      saveSoon();
      go('leaver/' + lv.id);
    });
  }
  function leaverFromPerson(name, email, since) {
    var lv = C.cleanLeaver({ name: name, email: email, lastDay: since || '', involuntary: null });
    lv.notes = since ? 'Already gone: ' + C.niceDay(since) + '.' : '';
    return addLeaver(lv).then(function () { if (since) toast('They left on ' + C.niceDay(since) + ' - every step is overdue. Work down the list.', 5200); });
  }
  function kindPill(lv) { return lv.involuntary === true ? '<span class="kind invol">Involuntary - revoke at notice</span>' : lv.involuntary === false ? '<span class="kind vol">Resignation</span>' : '<span class="kind unknown">? Voluntary or not - not said</span>'; }
  function lastDayText(lv) {
    if (!lv.lastDay) return 'not set';
    return dayLabel(lv.lastDay) + ' · ' + (lv.lastTime ? C.clockLabel(lv.lastTime) : C.clockLabel(lv.involuntary ? '09:00' : '17:00') + ' (assumed - set the time)');
  }
  function leaversHtml() {
    var ls = W().leavers, n = now();
    var h = '<div class="stack">' + demoStrip() + '<section class="card"><div class="sec-head"><h1>Leavers</h1><button class="btn" type="button" data-act="newleaver">New leaver</button></div><p class="muted" style="margin:0">A checklist per person leaving, from your systems: what to do before the last day, at the moment they go, within 24 hours and within 30 days - each with who did it, when, and the evidence.</p></section>';
    if (!ls.length) {
      h += '<section class="card empty"><p><b>No leavers yet.</b></p><p class="muted">Paste the email or ticket that says someone is leaving - or start one from a person the orphan finder found.</p><div class="btns" style="justify-content:center"><button class="btn" type="button" data-act="newleaver">Paste a request</button>' + (demo() ? '<button class="btn ghost" type="button" data-act="sample" data-s="plain">Try Dana’s email about Sam</button>' : '') + '</div></section>';
    } else {
      h += '<div class="grid2">' + ls.map(function (lv) {
        var p = C.progress(lv.tasks, n);
        return '<button type="button" class="card lcard" data-act="openleaver" data-id="' + esc(lv.id) + '"><span class="row spread"><h3>' + esc(lv.name || 'Someone leaving') + '</h3>' + kindPill(lv) + '</span><p>Last day ' + esc(lastDayText(lv)) + '</p><span class="bar" style="display:block"><i data-w="' + esc(p.pct) + '"></i></span><p><b style="color:var(--text)">' + esc(p.done) + ' of ' + esc(p.total) + ' done</b> · ' + esc(p.open) + ' open' + (p.overdue ? ' · <span class="overdue">' + esc(p.overdue) + ' overdue</span>' : '') + '</p></button>';
      }).join('') + '</div>';
    }
    return h + footer() + '</div>';
  }

  function factsHtml(lv) {
    var mail = lv.mailbox ? C.MAILBOX[lv.mailbox] + (lv.mailTo ? ' · ' + lv.mailTo : '') : (lv.mailTo ? lv.mailTo : 'not decided');
    var rows = [['Address', lv.email || 'not given'], ['Last day', lastDayText(lv)], ['Files to', lv.filesTo || 'not decided'], ['Mail', mail], ['Manager', lv.manager || 'not given'], ['Collect', lv.hardware.length ? lv.hardware.join(', ') : 'not listed']];
    if (lv.requestedBy) rows.push(['Asked by', lv.requestedBy]);
    return '<ul class="facts">' + rows.map(function (x) { return '<li><b>' + esc(x[0]) + '</b><span>' + esc(x[1]) + '</span></li>'; }).join('') + '</ul>';
  }
  function taskHtml(t, lv, n) {
    var late = C.isOverdue(t, n);
    var due = t.due ? (t.due.time ? dayLabel(t.due.day) + ', ' + C.clockLabel(t.due.time) : 'by ' + dayLabel(t.due.day)) : 'no date yet';
    return '<li class="task' + (t.done ? ' done' : '') + (late ? ' late' : '') + '" id="t-' + esc(t.id.replace(/[^a-z0-9-]/g, '-')) + '"><button class="tick" type="button" data-act="tick" data-t="' + esc(t.id) + '" aria-pressed="' + (t.done ? 'true' : 'false') + '" aria-label="' + esc((t.done ? 'Done: ' : 'Mark done: ') + (t.system ? t.system + ' - ' : '') + t.title) + '">' + (t.done ? '✓' : '') + '</button>' +
      '<button class="tbody" type="button" data-act="task" data-t="' + esc(t.id) + '"><span class="tt">' + esc(t.title) + '</span>' +
      '<span class="tm">' + (t.system ? '<span class="sys">' + esc(t.system) + (t.sso ? ' · SSO' : '') + '</span>' : '<span class="sys">General</span>') + '<span class="muted">' + esc(C.OWNERS[t.owner] || t.owner) + '</span><span class="muted">· ' + esc(due) + '</span>' + (late ? '<span class="overdue">Overdue</span>' : '') + '</span>' +
      '<span class="td">' + esc(t.detail) + '</span>' + (t.found ? '<span class="found">🔎 ' + esc(t.found) + '</span>' : '') + (t.added ? '<span class="td">Not in your system list - added because the export shows an account.</span>' : '') + (t.notFound && !t.done ? '<span class="nf">' + esc(t.notFound) + '</span>' : '') +
      (t.done ? '<span class="doneby">✓ Done' + (t.by ? ' by ' + esc(t.by) : '') + (t.at ? ' · ' + esc(whenDone(t.at)) : '') + '</span>' : '') +
      (t.evidence ? '<span class="evid"><b>Evidence:</b> ' + esc(t.evidence) + '</span>' : t.done ? '<span class="small muted">Tap to add evidence</span>' : '') + '</button></li>';
  }
  function leaverHtml() {
    var lv = leaverById(state.current), n = now();
    if (!lv) return leaversHtml();
    var p = C.progress(lv.tasks, n), inv1 = lv.involuntary === true;
    var wide = matchMedia('(min-width: 1000px)').matches;
    var h = '<div class="stack">' + demoStrip() + '<div><button class="btn small ghost" type="button" data-act="tab" data-tab="leavers">← All leavers</button></div><div class="lwrap"><aside class="lside stack"><section class="card lhead"><p class="lab" style="margin:0">Leaver checklist</p><h1>' + esc(lv.name || 'Someone leaving') + '</h1><div class="row">' + kindPill(lv) + '<span class="small" style="font-weight:700">Last day ' + esc(lastDayText(lv)) + '</span></div>' +
      '<details class="why facts-box"' + (wide ? ' open' : '') + '><summary>Details: address, files, mail, what to collect</summary>' + factsHtml(lv) + '</details>' +
      '<div class="prog"><p>' + esc(p.done) + ' of ' + esc(p.total) + ' done · ' + esc(p.open) + ' still open' + (p.overdue ? ' · <span class="overdue">' + esc(p.overdue) + ' overdue</span>' : '') + '</p><div class="bar"><i data-w="' + esc(p.pct) + '"></i></div>' + (p.next ? '<p class="small muted" style="font-weight:600">Next: ' + esc(p.next.system ? p.next.system + ' - ' : '') + esc(p.next.title.charAt(0).toLowerCase() + p.next.title.slice(1)) + '</p>' : '') + (p.done ? '<p class="small muted" style="font-weight:600">' + esc(plural(p.evidence, 'step')) + ' with evidence</p>' : '') + '</div>' +
      (lv.foundApps && lv.foundApps.length ? '<p class="small" style="margin:0">🔎 The orphan finder saw them in <b>' + esc(lv.foundApps.join(', ')) + '</b> - those steps say what it found.</p>' : lv.checkedApps && lv.checkedApps.length ? '<p class="small muted" style="margin:0">Not found in the ' + esc(lv.checkedApps.join(', ')) + ' exports.</p>' : '<p class="small muted" style="margin:0">Load your exports in Orphans and rebuild, to see which apps they are really in.</p>') +
      (lv.notes ? '<p class="small" style="margin:0">' + esc(lv.notes) + '</p>' : '') +
      '<div class="btns"><button class="btn small ghost" type="button" data-act="editleaver">Edit details</button><button class="btn small ghost" type="button" data-act="rebuild">Rebuild from systems</button><button class="btn small ghost" type="button" data-act="exportleaver">Export</button><button class="btn small danger" type="button" data-act="delleaver">Delete</button></div></section>' +
      (!inv().systems.length ? '<section class="card"><p class="small" style="margin:0"><b>Only the general steps so far.</b> Add your systems - single sign-on or not, what to do, who does it - and each one gets its own steps here.</p><button class="btn small ghost" type="button" data-act="tab" data-tab="systems" style="margin-top:8px">Add your systems</button></section>' : '') +
      '</aside><div class="stack">';
    C.PHASES.forEach(function (ph) {
      var ts = lv.tasks.filter(function (t) { return t.phase === ph; });
      if (!ts.length) return;
      var d = ts[0].due, dn = ts.filter(function (t) { return t.done; }).length;
      h += '<section class="card phase"><h2>' + esc(C.phaseWord(ph, inv1)) + ' <small>' + (d ? esc(d.time ? dayLabel(d.day) + ', ' + C.clockLabel(d.time) : 'by ' + dayLabel(d.day)) + ' · ' : '') + esc(dn + ' of ' + ts.length + ' done') + '</small></h2><ul class="tasks">' + ts.map(function (t) { return taskHtml(t, lv, n); }).join('') + '</ul></section>';
    });
    return h + '</div></div>' + footer() + '</div>';
  }
  function taskById(lv, id) { for (var i = 0; i < lv.tasks.length; i++) if (lv.tasks[i].id === id) return lv.tasks[i]; return null; }
  function tick(id) {
    var lv = leaverById(state.current), t = lv && taskById(lv, id);
    if (!t) return;
    if (!t.done && !state.device.initials) return openTask(id, true);
    if (t.done) { t.done = false; t.by = ''; t.at = ''; } else { t.done = true; t.by = state.device.initials; t.at = stamp(); }
    saveSoon();
    var y = scrollY; draw(); scrollTo(0, y);
    var again = $('#t-' + id.replace(/[^a-z0-9-]/g, '-') + ' .tick'); if (again) try { again.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    if (t.done) { var p = C.progress(lv.tasks, now()); toast(p.open ? 'Done. ' + plural(p.open, 'step') + ' still open.' : 'All done - every step ticked.'); }
  }
  function openTask(id, ticking) {
    var lv = leaverById(state.current), t = lv && taskById(lv, id);
    if (!t) return;
    var at = t.at || stamp();
    sheet('<h2>' + esc(t.title) + '</h2><p class="small muted">' + esc((t.system || 'General') + ' · ' + (C.OWNERS[t.owner] || t.owner) + ' · ' + C.phaseWord(t.phase, lv.involuntary === true)) + '</p><p>' + esc(t.detail) + '</p>' + (t.found ? '<p class="found">🔎 ' + esc(t.found) + '</p>' : '') +
      '<form class="form" id="taskForm"><label class="check"><input type="checkbox" id="tDone"' + (t.done || ticking ? ' checked' : '') + '> Done</label>' +
      '<div class="two-col"><label class="field"><span>Done by</span><input class="input" id="tBy" maxlength="' + C.LIMITS.byChars + '" value="' + esc(t.by || state.device.initials) + '" placeholder="Your initials" autocomplete="off"><small>Remembered on this device for the next tick.</small></label>' +
      '<label class="field"><span>When</span><input class="input" id="tAt" type="datetime-local" value="' + esc(at.slice(0, 16)) + '"></label></div>' +
      '<label class="field"><span>Evidence</span><input class="input" id="tEv" maxlength="' + C.LIMITS.evidenceChars + '" value="' + esc(t.evidence) + '" placeholder="screenshot in ticket 4821" autocomplete="off"><small>Typed, never uploaded: a ticket number, where the screenshot is, who confirmed it.</small></label>' +
      '<div class="btns"><button class="btn" type="submit">Save</button>' + (t.notFound && !t.done ? '<button class="btn ghost" type="button" id="tNf">Done: not in the export</button>' : '') + '</div></form>', function (root) {
      var nf = $('#tNf', root);
      if (nf) nf.addEventListener('click', function () { $('#tDone', root).checked = true; $('#tEv', root).value = C.line(t.notFound.replace(/ - if they.*$/, '') + ' (' + C.niceDay(state.today) + ').', C.LIMITS.evidenceChars); var b = $('#tBy', root); if (!b.value) b.focus(); else $('#taskForm', root).requestSubmit(); });
      $('#taskForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var by = C.line($('#tBy', root).value, C.LIMITS.byChars);
        if (by) { state.device.initials = by; }
        t.done = $('#tDone', root).checked;
        t.by = t.done ? by : '';
        var a = $('#tAt', root).value;
        t.at = t.done ? (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(a) ? a.slice(0, 16) : stamp()) : '';
        t.evidence = C.line($('#tEv', root).value, C.LIMITS.evidenceChars);
        saveSoon(); closeSheet(true);
        var y = scrollY; draw(); scrollTo(0, y);
        toast(t.done ? (t.evidence ? 'Done, with evidence.' : 'Done.') : 'Saved.');
      });
      setTimeout(function () { var f = t.done || ticking ? (state.device.initials ? $('#tEv', root) : $('#tBy', root)) : null; if (f) try { f.focus(); } catch (e) { /* ignore */ } }, 60);
    });
  }

  /* ---------------- the request reader ---------------- */

  var FIELD_LABEL = { name: 'Who is leaving', email: 'Their sign-in address', lastDay: 'Last day', lastTime: 'Access ends at', involuntary: 'Voluntary or not', manager: 'Their manager', filesTo: 'Files go to', mailbox: 'Their mailbox', mailTo: 'Mail goes to', hardware: 'To collect' };
  var FIELD_ORDER = ['name', 'email', 'lastDay', 'lastTime', 'involuntary', 'manager', 'filesTo', 'mailbox', 'mailTo', 'hardware'];
  function knownNames() { var r = W().result; return r && r.names ? r.names : []; }
  function readRequest(text) {
    var parsed = C.parseRequest(text, { today: state.today, time: now().time, dayFirst: DAY_FIRST, names: knownNames() });
    var lv = C.leaverFrom(parsed);
    // The cleaned text (no bidi or zero-width characters) is what is shown again.
    state.draft = { text: parsed.text, parsed: parsed, values: lv, notes: {}, from: lv.from, ai: {} };
    Object.keys(parsed.fields).forEach(function (k) { if (parsed.fields[k].note) state.draft.notes[k] = parsed.fields[k].note; });
  }
  function draftQuestions() {
    var d = state.draft, v = d.values, f = {};
    FIELD_ORDER.forEach(function (k) { var x = v[k]; if ((k === 'involuntary' && x !== null) || (k === 'hardware' && x.length) || (k !== 'involuntary' && k !== 'hardware' && x)) f[k] = { value: x }; });
    if (v.mailbox) f.mailbox = { value: v.mailbox };
    return C.questionsFor(f, state.today);
  }
  function srcHtml(k) {
    var d = state.draft, from = d.from[k], note = d.notes[k];
    if (!from && !note) return '';
    return '<p class="src">' + (from ? 'from <q>' + esc(from) + '</q>' : '') + (note ? '<span class="nt">' + esc(note) + '</span>' : '') + '</p>';
  }
  function pfield(k, inner) {
    var v = state.draft.values[k];
    var empty = k === 'involuntary' ? v === null : k === 'hardware' ? !v.length : !v;
    return '<div class="pfield' + (empty ? ' missing' : '') + '"><div class="ph"><span>' + esc(FIELD_LABEL[k]) + '</span>' + (state.draft.ai[k] ? '<span class="sure sure-likely">✨ AI - check</span>' : empty ? '<span class="sure sure-unsure">? Not in the request</span>' : '<span class="sure sure-sure">✓ Read</span>') + '</div>' + inner + srcHtml(k) + '</div>';
  }
  function fieldsHtml() {
    var v = state.draft.values;
    var txt = function (k, ph) { return '<input class="input" data-dv="' + k + '" value="' + esc(v[k]) + '" maxlength="' + C.LIMITS.fieldChars + '" placeholder="' + esc(ph || '') + '" autocomplete="off">'; };
    var h = '<div class="fieldgrid">';
    h += pfield('name', txt('name', 'First and last name'));
    h += pfield('email', '<input class="input" data-dv="email" type="email" value="' + esc(v.email) + '" maxlength="120" placeholder="name' + String.fromCharCode(64) + 'company.com" autocomplete="off">');
    h += pfield('lastDay', '<input class="input" data-dv="lastDay" type="date" value="' + esc(v.lastDay) + '">' + (v.lastDay ? '<span class="small muted">' + esc(dayLabel(v.lastDay)) + '</span>' : ''));
    h += pfield('lastTime', '<input class="input" data-dv="lastTime" type="time" value="' + esc(v.lastTime) + '">' + (!v.lastTime ? '<span class="small muted">Until you set it: ' + esc(v.involuntary ? '9:00 AM, before they arrive' : '5:00 PM, the end of the day') + '</span>' : ''));
    h += pfield('involuntary', '<div class="seg" role="group" aria-label="Voluntary or not"><button type="button" data-act="dinv" data-v="0" aria-pressed="' + (v.involuntary === false) + '">Resignation</button><button type="button" data-act="dinv" data-v="1" aria-pressed="' + (v.involuntary === true) + '">Involuntary</button></div>' + (v.involuntary === true ? '<span class="small muted">Access goes at the moment of notice, not at the end of the day.</span>' : ''));
    h += pfield('manager', txt('manager', 'Name or role'));
    h += pfield('filesTo', txt('filesTo', 'Name or role'));
    h += pfield('mailbox', '<select class="input" data-dv="mailbox"><option value="">— not decided —</option>' + Object.keys(C.MAILBOX).map(function (k) { return '<option value="' + k + '"' + (v.mailbox === k ? ' selected' : '') + '>' + esc(C.MAILBOX[k]) + '</option>'; }).join('') + '</select>');
    h += pfield('mailTo', txt('mailTo', 'Name or role'));
    h += pfield('hardware', '<div class="hwchips" role="group" aria-label="To collect">' + C.HARDWARE.map(function (x) { var on = v.hardware.indexOf(x) >= 0; return '<button type="button" data-act="dhw" data-v="' + esc(x) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + (on ? '<span aria-hidden="true">✓ </span>' : '') + esc(x) + '</button>'; }).join('') + '</div>');
    return h + '</div>';
  }
  function newHtml() {
    var d = state.draft;
    var h = '<div class="stack">' + demoStrip() + '<section class="card stack"><div class="sec-head"><h1>New leaver</h1><button class="btn small ghost" type="button" data-act="tab" data-tab="leavers">All leavers</button></div>' +
      '<p class="muted" style="margin:0">Paste the email or ticket. Lastday reads who is leaving, their address, the last day, who takes over their files and mail, and what to collect - and asks about the rest. Each answer shows the words it came from. Read on this device.</p>' +
      (demo() ? '<div class="btns"><button class="btn small ghost" type="button" data-act="sample" data-s="plain">Dana’s email about Sam</button><button class="btn small ghost" type="button" data-act="sample" data-s="messy">A messier one</button></div>' : '') +
      '<label class="field"><span>The request</span><textarea class="input tall" id="reqText" maxlength="' + C.LIMITS.pasteChars + '" placeholder="Sam’s last day is Friday - please keep their mailbox for the manager and give their files to Hana.">' + esc(d ? d.text : '') + '</textarea></label>' +
      '<div class="btns"><button class="btn" type="button" data-act="readreq">Read it</button><button class="btn ghost" type="button" data-act="aireq">✨ Read a messy one with AI</button><button class="btn ghost" type="button" data-act="byhand">Fill it in by hand</button></div></section>';
    if (d) {
      var qs = draftQuestions();
      var found = FIELD_ORDER.length - qs.filter(function (q) { return FIELD_ORDER.indexOf(q.field) >= 0; }).length;
      h += '<section class="card stack" id="whatItSays"><div class="sec-head"><h2>What it says</h2><span class="small muted">' + esc(found + ' of ' + FIELD_ORDER.length + ' answered') + '</span></div>';
      if (qs.length) h += '<div><p class="lab">Still to answer (' + esc(qs.length) + ')</p><ul class="qs">' + qs.map(function (q) { return '<li><span><b aria-hidden="true">? </b>' + esc(q.text) + '</span></li>'; }).join('') + '</ul></div>';
      h += fieldsHtml();
      h += '<div class="btns"><button class="btn big" type="button" data-act="makeleaver">Make the checklist</button></div><p class="small muted" style="margin:0">Unanswered questions can wait: the checklist says what is not decided, and you can edit the details any time.</p></section>';
    }
    return h + footer() + '</div>';
  }
  function readDraftInputs() {
    var d = state.draft;
    if (!d) return;
    $$('[data-dv]').forEach(function (el) {
      var k = el.getAttribute('data-dv');
      d.values[k] = k === 'lastDay' ? (C.isDay(el.value) ? el.value : '') : k === 'lastTime' ? (C.isTime(el.value) ? el.value : '') : k === 'mailbox' ? (C.MAILBOX[el.value] ? el.value : '') : C.line(el.value, k === 'email' ? 120 : C.LIMITS.fieldChars);
    });
  }

  /* The AI reader: masked on this device, shown before the tap. */
  function nameCandidates(masked, extra) {
    var seen = {}, out = [];
    var stop = /^(Hi|Hello|Hey|Dear|Please|Thanks|Thank|The|Our|Their|They|This|That|These|Also|And|But|So|If|Can|Could|Would|Will|Should|Subject|From|To|Cc|Sent|Date|Re|Fwd|Team|All|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|HR|IT|MSP|SSO|OK|PS|Leaver|Offboarding|Urgent|Note|Regards|Best|Cheers|Kind|Sincerely|Quick|Not|No|Yes|Office|Manager|Front|Desk|I|We|You|It|Its)$/;
    var doms = (settings().domains.length ? settings().domains : (W().result ? W().result.domains.list : [])).map(function (d) { return C.fold(d); });
    var company = function (w) { return w.split(' ').some(function (x) { var f = C.fold(x); return f.length >= 3 && doms.some(function (d) { return d.indexOf(f) >= 0; }); }); };
    masked.replace(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?\b/g, function (m) {
      if (seen[m] || stop.test(m.split(' ')[0]) || extra.indexOf(m) >= 0 || company(m) || out.length >= 10) return m;
      seen[m] = 1; out.push(m); return m;
    });
    return out;
  }
  function tokHtml(s) {
    return esc(s).replace(/\[(email|phone|person|link|number|word)(\d{1,3})\]/g, '<span class="tok">[$1$2]</span>');
  }
  function openAi() {
    readDraftInputs();
    var ta = $('#reqText');
    var text = C.para(ta ? ta.value : (state.draft ? state.draft.text : ''), C.LIMITS.pasteChars);
    if (!text) { toast('Paste the request first.'); if (ta) ta.focus(); return; }
    var parsed = C.parseRequest(text, { today: state.today, time: now().time, dayFirst: DAY_FIRST, names: knownNames() });
    var people = parsed.people.slice();
    // Known first names standing alone ("ask Maya") are people too.
    knownNames().forEach(function (n) { var f = n.split(' ')[0]; if (f.length >= 3 && new RegExp('\\b' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(text) && people.indexOf(n) < 0 && knownNames().filter(function (x) { return x.split(' ')[0] === f; }).length === 1) people.push(f); });
    var extra = [];
    function render(root) {
      var m = C.maskRequest(text, people, extra);
      var counts = m.counts, bits = [];
      if (counts.person) bits.push(plural(counts.person, 'name')); if (counts.email) bits.push(plural(counts.email, 'address', 'addresses')); if (counts.phone) bits.push(plural(counts.phone, 'phone number')); if (counts.link) bits.push(plural(counts.link, 'link')); if (counts.number) bits.push(plural(counts.number, 'long number')); if (counts.word) bits.push(plural(counts.word, 'word'));
      var cands = nameCandidates(m.text, extra);
      var b = $('#aiBody', root);
      b.innerHTML = '<p class="lab">What would be sent' + (bits.length ? ' - hidden: ' + esc(bits.join(', ')) : '') + '</p><pre class="masked">' + tokHtml(m.text) + '</pre>' + (m.cut ? '<p class="small muted">Only the first ' + esc(C.groups(C.LIMITS.aiChars)) + ' characters are sent.</p>' : '') +
        (cands.length ? '<p class="small" style="margin:10px 0 6px"><b>Hide more?</b> These look like names:</p><div class="hwchips">' + cands.map(function (c) { return '<button type="button" data-hide="' + esc(c) + '">Hide “' + esc(c) + '”</button>'; }).join('') + '</div>' : '') +
        '<div class="row" style="margin-top:10px"><label class="field" style="flex:1 1 220px"><span>Hide another word</span><input class="input" id="aiWord" maxlength="60" autocomplete="off"></label><button class="btn small ghost" type="button" id="aiHide" style="align-self:end">Hide it</button></div>';
      $$('[data-hide]', b).forEach(function (x) { x.addEventListener('click', function () { extra.push(x.getAttribute('data-hide')); render(root); }); });
      $('#aiHide', b).addEventListener('click', function () { var w = C.line($('#aiWord', b).value, 60); if (w.length >= 2) { extra.push(w); render(root); } });
      return m;
    }
    sheet('<h2>✨ Read a messy request</h2><p class="muted small">For when the reader on this page leaves too many questions. The request is <b>masked on this device first</b>: every name it found becomes [person1], every address [email1], every phone number [phone1]. Only what is shown below is sent - and the answer is unmasked here, as a proposal you check.</p><div id="aiBody"></div><div id="aiErr"></div><div class="btns" id="aiActs" style="margin-top:12px"></div><div id="aiOut"></div>', function (root) {
      var m = render(root);
      var acts = $('#aiActs', root);
      if (!signedIn()) {
        acts.innerHTML = '<p class="small muted" style="margin:0 0 8px;flex-basis:100%">It uses about a cent of AI credit, so it needs a free account - which comes with $2, and works across every app on this site.</p><button class="btn" type="button" id="aiSignin">Create a free account</button>';
        $('#aiSignin', root).addEventListener('click', function () { openAccount('Reading a request uses about a cent of AI credit; a free account comes with $2.', openAi); });
        return;
      }
      acts.innerHTML = '<button class="btn" type="button" id="aiSend">Send the masked text</button><span class="small muted">About a cent' + (state.me.tier === 'paid' ? ' (member model)' : '') + '</span>';
      $('#aiSend', root).addEventListener('click', function () {
        m = render(root);
        var btn = $('#aiSend', root);
        btn.disabled = true; btn.textContent = 'Reading…';
        $('#aiErr', root).innerHTML = '';
        api('POST', 'api/ai/request', { text: m.text, today: state.today, dayFirst: DAY_FIRST }).then(function (res) {
          btn.disabled = false; btn.textContent = 'Read it again';
          showProposal(root, res, m.map, text);
        }).catch(function (err) {
          btn.disabled = false; btn.textContent = 'Send the masked text';
          meteredError(err, $('#aiErr', root), openAi, 'Reading a request uses about a cent of AI credit, so it needs a free account (it comes with $2).');
        });
      });
    });
  }
  function showProposal(root, res, map, text) {
    var fields = {};
    Object.keys(res.fields || {}).forEach(function (k) {
      if (FIELD_ORDER.indexOf(k) < 0) return;
      var x = res.fields[k], v = x.value;
      if (typeof v === 'string') v = C.line(C.unmask(v, map), k === 'email' ? 120 : C.LIMITS.fieldChars);
      fields[k] = { value: v, from: C.line(C.unmask(x.from, map), C.LIMITS.fromChars) };
    });
    var qs = (res.questions || []).map(function (q) { return C.line(C.unmask(q, map), C.LIMITS.fromChars); });
    var show = function (k, v) { return k === 'involuntary' ? (v ? 'Involuntary' : 'Resignation') : k === 'hardware' ? v.join(', ') : k === 'lastDay' ? dayLabel(v) : k === 'lastTime' ? C.clockLabel(v) : k === 'mailbox' ? C.MAILBOX[v] : v; };
    var keys = FIELD_ORDER.filter(function (k) { return fields[k]; });
    $('#aiOut', root).innerHTML = '<div class="note" style="margin-top:12px"><p class="lab">AI-read - check each one</p>' + (keys.length ? '<ul class="prop">' + keys.map(function (k) { return '<li><b>' + esc(FIELD_LABEL[k]) + ':</b> ' + esc(show(k, fields[k].value)) + (fields[k].from ? ' <span class="small muted">- from “' + esc(fields[k].from) + '”</span>' : '') + '</li>'; }).join('') + '</ul>' : '<p class="small">It found no fields it could vouch for.</p>') +
      (qs.length ? '<p class="lab" style="margin-top:10px">It asks</p><ul class="prop">' + qs.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>' : '') +
      (res.dropped ? '<p class="small muted">' + esc(plural(res.dropped, 'answer')) + ' that did not pass the checks were left out.</p>' : '') +
      (keys.length ? '<div class="btns" style="margin-top:10px"><button class="btn" type="button" id="aiUse">Use these</button></div>' : '') + '</div>';
    var use = $('#aiUse', root);
    if (use) use.addEventListener('click', function () {
      if (!state.draft || state.draft.text !== text) readRequest(text);
      var d = state.draft;
      keys.forEach(function (k) {
        var v = fields[k].value;
        d.values[k] = k === 'hardware' ? v.slice() : v;
        d.from[k] = fields[k].from; d.notes[k] = 'read by AI - check'; d.ai[k] = true;
      });
      closeSheet(true); draw();
      toast(plural(keys.length, 'field') + ' filled in by AI - check each one.');
    });
  }

  function makeLeaver() {
    readDraftInputs();
    var v = state.draft.values;
    var lv = C.cleanLeaver(v);
    lv.from = state.draft.from;
    return addLeaver(lv).then(function () { state.draft = null; });
  }
  function openEditLeaver() {
    var lv = leaverById(state.current);
    if (!lv) return;
    state.draft = { text: '', parsed: null, values: C.cleanLeaver(lv), notes: {}, from: lv.from || {}, ai: {} };
    state.editing = true;
    sheet('<h2>' + esc(lv.name || 'The leaver') + '</h2><div class="form"><div id="edFields">' + fieldsHtml() + '</div><div class="btns"><button class="btn" type="button" id="edSave">Save and update the steps</button></div><p class="small muted" style="margin:0">Ticks, names and evidence stay with their steps.</p></div>', function (root) {
      wireDraft(root);
      $('#edSave', root).addEventListener('click', function () {
        readDraftInputs();
        var v = state.draft.values;
        ['name', 'email', 'lastDay', 'lastTime', 'involuntary', 'manager', 'filesTo', 'mailbox', 'mailTo', 'hardware'].forEach(function (k) { lv[k] = v[k]; });
        var clean = C.cleanLeaver(lv); Object.keys(clean).forEach(function (k) { if (k !== 'id' && k !== 'tasks' && k !== 'createdAt' && k !== 'demo' && k !== 'from') lv[k] = clean[k]; });
        state.draft = null; state.editing = false;
        build(lv).then(function () { saveSoon(); closeSheet(true); draw(); toast('Updated - every tick kept.'); });
      });
    });
  }
  function wireDraft(root) {
    $$('[data-dv]', root).forEach(function (el) {
      el.addEventListener('change', function () {
        readDraftInputs();
        // A picked date or time shows its day name, or the default it replaced.
        var k = el.getAttribute('data-dv');
        if (k === 'lastDay' || k === 'lastTime') redrawDraft();
      });
    });
  }

  /* ---------------- systems ---------------- */

  function systemsHtml() {
    var i = inv(), s = i.settings;
    var h = '<div class="stack">' + demoStrip() + '<section class="card"><div class="sec-head"><h1>Your systems</h1><span data-sync>' + syncLine() + '</span></div><p class="muted" style="margin:0">Each system: does it sign in through single sign-on, what has to happen when someone leaves, and which role does it. Every leaver checklist is built from this list - it holds systems, never people.</p>' +
      (!i.systems.length ? '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="starter">Start from a typical small-business list</button><button class="btn ghost" type="button" data-act="sysadd">Add one system</button></div>' : '') + '</section>';
    if (i.systems.length) {
      h += '<div class="sysgrid">' + i.systems.map(function (sys, n) {
        return '<section class="card syscard"><div class="sh"><label class="field"><span>System</span><input class="input" data-sysname="' + n + '" value="' + esc(sys.name) + '" maxlength="' + C.LIMITS.systemChars + '" autocomplete="off"></label><button class="btn small danger" type="button" data-act="sysdel" data-i="' + n + '" aria-label="Remove ' + esc(sys.name) + '">Remove</button></div>' +
          '<div class="row"><span class="small" style="font-weight:700">Sign-in</span><div class="seg" role="group" aria-label="Single sign-on"><button type="button" data-act="sso" data-i="' + n + '" data-v="1" aria-pressed="' + (sys.sso ? 'true' : 'false') + '">Single sign-on</button><button type="button" data-act="sso" data-i="' + n + '" data-v="0" aria-pressed="' + (sys.sso ? 'false' : 'true') + '">Its own logins</button></div></div>' +
          '<div><p class="lab">When someone leaves</p><div class="stepchips" role="group" aria-label="Steps">' + C.STEP_KEYS.map(function (k) { var on = sys.steps.indexOf(k) >= 0; return '<button type="button" data-act="step" data-i="' + n + '" data-k="' + k + '" aria-pressed="' + (on ? 'true' : 'false') + '" title="' + esc(C.STEPS[k].label) + '">' + (on ? '<span aria-hidden="true">✓ </span>' : '') + esc(C.STEPS[k].short) + '</button>'; }).join('') + '</div></div>' +
          '<label class="field"><span>Who does it</span><select class="input" data-sysowner="' + n + '">' + C.OWNER_KEYS.map(function (k) { return '<option value="' + k + '"' + (sys.owner === k ? ' selected' : '') + '>' + esc(C.OWNERS[k]) + '</option>'; }).join('') + '</select><small>A role, never a person - so the list can be shared and synced.</small></label></section>';
      }).join('') + '</div><div class="btns"><button class="btn ghost" type="button" data-act="sysadd"' + (i.systems.length >= C.LIMITS.systems ? ' disabled' : '') + '>Add a system</button></div>';
    }
    h += '<section class="card"><div class="sec-head"><h2>Settings</h2><button class="btn small ghost" type="button" data-act="settings">Change</button></div><ul class="facts"><li><b>Identity provider</b>' + esc(s.idp === 'other' ? 'not named' : C.IDPS[s.idp]) + '</li><li><b>Company domains</b>' + esc(s.domains.length ? s.domains.join(', ') : 'read from the export') + '</li><li><b>Dormant after</b>' + esc(s.dormantDays + ' days') + '</li><li><b>Shared-account patterns</b>' + esc(plural(s.patterns.length, 'pattern')) + '</li></ul></section>';
    return h + footer() + '</div>';
  }
  function openSettings() {
    var s = settings();
    sheet('<h2>Settings</h2><form class="form" id="setForm">' +
      '<label class="field"><span>Identity provider</span><select class="input" id="sIdp">' + Object.keys(C.IDPS).map(function (k) { return '<option value="' + k + '"' + (s.idp === k ? ' selected' : '') + '>' + esc(k === 'other' ? 'Another one' : C.IDPS[k]) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Company domains, one a line</span><textarea class="input code" id="sDom" rows="3" spellcheck="false" placeholder="example.com">' + esc(s.domains.join('\n')) + '</textarea><small>The first is the main one; the rest are aliases of it (example.com = example.co.uk). Empty: read from the identity provider’s export. Anything else counts as external.</small></label>' +
      '<label class="field"><span>Dormant after (days without activity)</span><input class="input" id="sDorm" type="number" min="' + C.LIMITS.dormantMin + '" max="' + C.LIMITS.dormantMax + '" value="' + esc(s.dormantDays) + '"></label>' +
      '<label class="field"><span>Shared and service accounts</span><textarea class="input code" id="sPat" rows="6" spellcheck="false">' + esc(s.patterns.join('\n')) + '</textarea><small>One a line. A word matches the part before the @ (or one piece of it, for words of four letters or more); * matches anything - svc-*, *-bot.</small></label>' +
      '<div id="sErr"></div><div class="btns"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" id="sReset">Default patterns</button></div><p class="small muted" style="margin:0">Settings hold no person - only these preferences.</p></form>', function (root) {
      $('#sReset', root).addEventListener('click', function () { $('#sPat', root).value = C.DEFAULT_PATTERNS.join('\n'); });
      $('#setForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var lines = function (id) { return $(id, root).value.split(/[\n,]+/).map(function (x) { return x.trim(); }).filter(Boolean); };
        var next = JSON.parse(JSON.stringify(inv()));
        next.settings = { idp: $('#sIdp', root).value, domains: lines('#sDom'), dormantDays: Number($('#sDorm', root).value), patterns: lines('#sPat') };
        var cl = C.cleanInventory(next, true);
        if (cl.errors.length) { $('#sErr', root).innerHTML = '<p class="err" role="alert">' + esc(cl.errors[0]) + '</p>'; return; }
        W().inventory = cl.inventory;
        closeSheet(true);
        inventoryChanged(true);
        draw();
        toast(W().result ? 'Saved - finding them again.' : 'Saved.');
      });
    });
  }
  function sysChanged() { inventoryChanged(false); }

  /* ---------------- export ---------------- */

  function exportHtml() {
    var w = W(), r = w.result, ls = w.leavers;
    if (!state.exportId || !leaverById(state.exportId)) state.exportId = ls[0] ? ls[0].id : '';
    var lv = leaverById(state.exportId);
    var h = '<div class="stack">' + demoStrip() + '<section class="card"><h1>Export</h1><p class="muted" style="margin:0">Everything is made on this device and saved by this browser. CSV cells that a spreadsheet would run as a formula are made safe.</p></section>';
    h += '<section class="card"><h2>The orphan findings</h2>' + (r ? '<p class="small muted">Every account and its finding: app, address, name, verdict, critical, role, last active, status in ' + esc(idpLabel()) + ', days since they left, how it matched and why. ' + esc(C.groups(r.findings.length)) + ' findings' + (r.okTotal ? ' and ' + esc(C.groups(Math.min(r.ok.length, r.okTotal))) + ' OK accounts' : '') + '.</p><div class="btns"><button class="btn small" type="button" data-act="dlfind">Download CSV</button></div>' : '<p class="small muted">Load your exports in Orphans first.</p><button class="btn small ghost" type="button" data-act="tab" data-tab="find">Load the exports</button>') + '</section>';
    h += '<section class="card stack"><h2>A leaver’s checklist</h2>';
    if (!lv) h += '<p class="small muted" style="margin:0">No checklists yet.</p><div><button class="btn small ghost" type="button" data-act="newleaver">New leaver</button></div>';
    else {
      if (ls.length > 1) h += '<label class="field"><span>Leaver</span><select class="input" id="expSel">' + ls.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === lv.id ? ' selected' : '') + '>' + esc((x.name || 'Someone leaving') + (x.lastDay ? ' - ' + shortDay(x.lastDay) : '')) + '</option>'; }).join('') + '</select></label>';
      h += '<div><p class="lab">For the ticket</p><p class="small muted">Markdown: the details, then every step by phase with [x] or [ ], who did it, when, and the evidence. Paste it into the ticket.</p><div class="btns"><button class="btn small" type="button" data-act="copymd">Copy Markdown</button><button class="btn small ghost" type="button" data-act="dlmd">Download .md</button></div><details class="why"><summary>Preview</summary><pre class="out wrapit">' + esc(C.checklistMarkdown(lv, now())) + '</pre></details></div>';
      h += '<div><p class="lab">For a PSA or ticketing tool</p><p class="small muted">JSON in one documented shape (<code>lastday.checklist.v1</code>): the leaver, the progress, and one task per step with its phase, due time, system, action, owner role, status, who, when and evidence - ready to map onto tasks or ticket notes. Or the same as a CSV.</p><div class="btns"><button class="btn small" type="button" data-act="dljson">Download JSON</button><button class="btn small ghost" type="button" data-act="dlcsv">Download CSV</button></div><details class="why"><summary>Preview the JSON</summary><pre class="out">' + esc(JSON.stringify(C.checklistJson(lv, now()), null, 2).slice(0, 4000)) + '</pre></details></div>';
    }
    h += '</section>';
    h += '<section class="card"><h2>On this device</h2>' + keepHtml() + '</section>';
    return h + footer() + '</div>';
  }
  function keepHtml() {
    return '<label class="check"><input type="checkbox" id="keepBox"' + (state.keep ? ' checked' : '') + '> Keep this on this device</label><p class="small muted" style="margin:0">Off by default. When on, your systems, checklists and the last findings stay in this browser until you clear them - names and addresses included, so only on a device you trust. Nothing is ever sent anywhere.</p>' + (state.keep ? '<button class="btn small danger" type="button" data-act="clearkept" style="margin-top:8px">Clear it from this device</button>' : '');
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
    state.conflictOpen = false; state.editing = false;
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }

  var FREE_LINE = 'The orphan finder, checklists, the request reader and every export are free with no account, and never leave this device. A free account keeps your system list across devices and adds the AI request reader - it comes with $2 of AI credit, and one account works across every app on this site.';
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Reading a messy request costs about a cent. The orphan finder, checklists and exports are free and never leave this device.</p><div id="billing"></div></div>' +
      '<p class="small" style="margin-top:14px" data-sync>' + syncLine() + '</p>' +
      '<button class="btn ghost block" id="forget" type="button" style="margin-top:6px">Remove my systems from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); draw(); }); });
        $('#forget', root).addEventListener('click', function () {
          if (!confirm('Remove your systems and settings from the account? This device keeps its copy.')) return;
          api('DELETE', 'api/inventory').then(function () { state.syncBase = null; closeSheet(); toast('Removed from the account. This device still has them.'); state.syncState = 'local'; }).catch(function (e) { showError(e); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The orphan finder, checklists, the request reader on this page and exports keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- the demo and the own workspace ---------------- */

  function startDemo(quiet) {
    state.ws = 'demo';
    var keptLeavers = state.W.demo ? state.W.demo.leavers : (state.keptDemo || []);
    state.W.demo = blankWs();
    var w = state.W.demo;
    w.leavers = keptLeavers;
    w.inventory = C.cleanInventory(D.inventory()).inventory;
    var ex = D.exportsFor(state.today);
    state.busy = 'Reading the demo files…';
    var files = [{ id: 'd-idp', role: 'idp', f: ex.idp }].concat(ex.apps.map(function (a, i) { return { id: 'd-app-' + i, role: 'app', f: a }; }));
    return Promise.all(files.map(function (x, i) { return engine.run('parse', { id: x.id, role: x.role, text: x.f.text, name: x.f.name, n: i }).then(function (out) { return fileState(out, x.f.label); }); })).then(function (fs) {
      w.files.idp = fs[0]; w.files.apps = fs.slice(1);
      var data = { ws: 'demo', idp: { id: w.files.idp.id, map: w.files.idp.map }, apps: w.files.apps.map(function (a) { return { id: a.id, name: a.appName, map: a.map }; }), settings: w.inventory.settings, today: state.today, idpKind: w.inventory.settings.idp };
      return engine.run('analyse', data);
    }).then(function (r) {
      state.busy = ''; w.result = r; state.filter = 'issues'; state.appFilter = ''; state.shown = 120;
      saveSoon();
      if (!quiet) go('find'); else route();
    }).catch(function (err) { state.busy = ''; toast(err.message, 5000); });
  }
  function startOwn() {
    state.ws = 'own';
    saveSoon();
    go(state.W.own.result ? 'find' : 'files');
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    $$('input[data-file]').forEach(function (inp) {
      inp.addEventListener('change', function (e) {
        var list = Array.prototype.slice.call(e.target.files || []), role = inp.getAttribute('data-file');
        e.target.value = '';
        list.slice(0, role === 'idp' ? 1 : C.LIMITS.apps).reduce(function (p, f) { return p.then(function () { return readFile(role, f); }); }, Promise.resolve());
      });
    });
    $$('[data-drop]').forEach(function (z) {
      z.addEventListener('dragover', function (e) { e.preventDefault(); z.classList.add('over'); });
      z.addEventListener('dragleave', function () { z.classList.remove('over'); });
      z.addEventListener('drop', function (e) {
        e.preventDefault(); z.classList.remove('over');
        var role = z.getAttribute('data-drop'), list = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
        list.slice(0, role === 'idp' ? 1 : C.LIMITS.apps).reduce(function (p, f) { return p.then(function () { return readFile(role, f); }); }, Promise.resolve());
      });
    });
    $$('select[data-map]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var id = sel.getAttribute('data-map'), field = sel.getAttribute('data-field'), f = fileById(id);
        if (!f) return;
        var v = parseInt(sel.value, 10);
        if (v >= 0) Object.keys(f.map).forEach(function (k) { if (k !== field && f.map[k] === v) { f.map[k] = -1; f.sure[k] = 'none'; } });
        f.map[field] = v; f.sure[field] = v >= 0 ? 'you' : 'none'; f.open = true;
        var y = scrollY; draw(); scrollTo(0, y);
        var again = $('#map-' + id + '-' + field); if (again) try { again.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      });
    });
    $$('input[data-appname]').forEach(function (inp) { inp.addEventListener('change', function () { var f = fileById(inp.getAttribute('data-appname')); if (f) f.appName = C.line(inp.value, 40) || f.appName; }); });
    var ik = $('select[data-idpkind]');
    if (ik) ik.addEventListener('change', function () { settings().idp = C.IDPS[ik.value] ? ik.value : 'other'; inventoryChanged(false); });
    $$('input[data-sysname]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var n = +inp.getAttribute('data-sysname'), sys = inv().systems[n], v = C.line(inp.value, C.LIMITS.systemChars);
        if (!sys) return;
        var test = C.cleanInventory({ systems: [{ name: v, steps: [], owner: 'it' }] }, true);
        if (!v || test.errors.length) { toast(test.errors[0] || 'A system needs a name.', 4200); inp.value = sys.name; return; }
        if (inv().systems.some(function (x, i) { return i !== n && C.fold(x.name) === C.fold(v); })) { toast('There is already a system called that.'); inp.value = sys.name; return; }
        sys.name = v; sysChanged();
      });
    });
    $$('select[data-sysowner]').forEach(function (sel) { sel.addEventListener('change', function () { var sys = inv().systems[+sel.getAttribute('data-sysowner')]; if (sys && C.OWNERS[sel.value]) { sys.owner = sel.value; sysChanged(); } }); });
    var kb = $('#keepBox');
    if (kb) kb.addEventListener('change', function () {
      state.keep = kb.checked;
      if (kb.checked) { state.toldBig = false; saveNow(); toast('Kept on this device. Clear it any time.'); } else { clearKept(); toast('Nothing is kept on this device now.'); }
      draw();
    });
    var es = $('#expSel');
    if (es) es.addEventListener('change', function () { state.exportId = es.value; draw(); });
    wireDraft(document);
  }
  function fileById(id) { var f = W().files; if (f.idp && f.idp.id === id) return f.idp; for (var i = 0; i < f.apps.length; i++) if (f.apps[i].id === id) return f.apps[i]; return null; }
  function currentLeaver() { return leaverById(state.current); }
  function exportLeaver() { return leaverById(state.exportId) || currentLeaver(); }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); go('start'); break;
      case 'tab': go(t.getAttribute('data-tab')); break;
      case 'demo': startDemo(); break;
      case 'own': closeSheet(true); startOwn(); break;
      case 'files': go('files'); break;
      case 'settings': openSettings(); break;
      case 'signin': openAccount(); break;
      case 'retrysync': pushInv(); break;
      case 'pastetoggle': { var r = t.getAttribute('data-role'); state.paste = state.paste === r ? false : r; draw(); var ta = $('#paste-' + r); if (ta) ta.focus(); break; }
      case 'pasteread': { var r2 = t.getAttribute('data-role'); var box = $('#paste-' + r2); readText(r2, box ? box.value : '', r2 === 'idp' ? 'Pasted identity provider list' : 'Pasted app list'); break; }
      case 'rmfile': {
        var id = t.getAttribute('data-id'), f = W().files;
        engine.run('drop', { id: id });
        if (f.idp && f.idp.id === id) f.idp = null; else f.apps = f.apps.filter(function (a) { return a.id !== id; });
        draw(); break;
      }
      case 'mapopen': { var fo = fileById(t.getAttribute('data-id')); if (fo) { fo.open = true; draw(); } break; }
      case 'analyse': runAnalysis(); break;
      case 'filter': { var fv = t.getAttribute('data-f'); state.filter = state.filter === fv && fv !== 'issues' ? 'issues' : fv; state.shown = 120; draw(); break; }
      case 'appf': state.appFilter = t.getAttribute('data-app'); state.shown = 120; draw(); break;
      case 'more': state.shown += 120; draw(); break;
      case 'row': { var row = state.rows[+t.getAttribute('data-i')]; if (row) { if (demo() && row.critical) { state.device.hint = true; saveSoon(); } openPerson(personKey(row)); } break; }
      case 'person': if (t.closest('.hint')) { state.device.hint = true; saveSoon(); } openPerson(t.getAttribute('data-k')); break;
      case 'hintoff': state.device.hint = true; saveSoon(); draw(); break;
      case 'mkperson': {
        var p = (W().result.people || []).filter(function (x) { return x.key === t.getAttribute('data-k'); })[0];
        if (p) leaverFromPerson(p.name, p.user ? p.user.email : p.email, p.user && p.user.changed);
        break;
      }
      case 'newleaver': state.draft = null; go('new'); break;
      case 'sample': {
        var text = t.getAttribute('data-s') === 'messy' ? D.messyRequest() : D.request();
        if (state.view !== 'new') { state.draft = null; go('new'); }
        var tx = $('#reqText'); if (tx) tx.value = text;
        if (t.getAttribute('data-s') !== 'messy') { readRequest(text); draw(); var sec = $('#whatItSays'); if (sec) sec.scrollIntoView({ block: 'start' }); }
        else toast('A messy one: try Read it, then the AI reader.', 3600);
        break;
      }
      case 'readreq': { var ta2 = $('#reqText'), val = ta2 ? ta2.value : ''; if (!C.line(val, 10)) { toast('Paste the request first.'); if (ta2) ta2.focus(); break; } readRequest(val); draw(); var s2 = $('#whatItSays'); if (s2) s2.scrollIntoView({ block: 'start' }); break; }
      case 'byhand': { var ta3 = $('#reqText'); state.draft = { text: ta3 ? ta3.value : '', parsed: null, values: C.cleanLeaver({}), notes: {}, from: {}, ai: {} }; draw(); break; }
      case 'aireq': openAi(); break;
      case 'dinv': readDraftInputs(); state.draft.values.involuntary = t.getAttribute('data-v') === '1'; state.draft.ai.involuntary = false; redrawDraft(); break;
      case 'dhw': { readDraftInputs(); var hw = state.draft.values.hardware, v2 = t.getAttribute('data-v'), at = hw.indexOf(v2); if (at >= 0) hw.splice(at, 1); else hw.push(v2); redrawDraft(); break; }
      case 'makeleaver': makeLeaver(); break;
      case 'openleaver': go('leaver/' + t.getAttribute('data-id')); break;
      case 'tick': tick(t.getAttribute('data-t')); break;
      case 'task': openTask(t.getAttribute('data-t'), false); break;
      case 'editleaver': openEditLeaver(); break;
      case 'rebuild': { var lv = currentLeaver(); if (lv) build(lv).then(function () { saveSoon(); draw(); toast('Rebuilt from your systems - every tick kept.'); }); break; }
      case 'exportleaver': state.exportId = state.current; go('export'); break;
      case 'delleaver': { var lv2 = currentLeaver(); if (lv2 && confirm('Delete the checklist for ' + (lv2.name || 'this leaver') + '? Its ticks and evidence go with it.')) { W().leavers = W().leavers.filter(function (x) { return x.id !== lv2.id; }); saveSoon(); go('leavers'); } break; }
      case 'starter': inv().systems = C.cleanInventory({ systems: C.starterSystems() }).inventory.systems; sysChanged(); draw(); toast('A starting list - rename, add and remove to match yours.'); break;
      case 'sysadd': {
        var n = 1, names = inv().systems.map(function (x) { return C.fold(x.name); });
        while (names.indexOf('new system ' + n) >= 0) n++;
        inv().systems.push({ id: 'sys-' + Date.now().toString(36), name: 'New system ' + n, sso: false, steps: ['disable', 'sessions'], owner: 'it' });
        sysChanged(); draw();
        var last = $$('input[data-sysname]').pop(); if (last) { last.focus(); last.select(); }
        break;
      }
      case 'sysdel': { var i = +t.getAttribute('data-i'); inv().systems.splice(i, 1); sysChanged(); draw(); break; }
      case 'sso': { var sy = inv().systems[+t.getAttribute('data-i')]; if (sy) { sy.sso = t.getAttribute('data-v') === '1'; sysChanged(); draw(); } break; }
      case 'step': { var sy2 = inv().systems[+t.getAttribute('data-i')], k = t.getAttribute('data-k'); if (sy2 && C.STEPS[k]) { var j = sy2.steps.indexOf(k); if (j >= 0) sy2.steps.splice(j, 1); else sy2.steps.push(k); sysChanged(); var y = scrollY; draw(); scrollTo(0, y); } break; }
      case 'dlfind': { var res = W().result; if (!res) break; download('lastday-findings-' + state.today + '.csv', 'text/csv', C.toCsv(C.findingsRows(allRows(res), settings().idp))); toast('Downloaded - made on this device.'); break; }
      case 'copymd': { var l1 = exportLeaver(); if (l1) copy(C.checklistMarkdown(l1, now()), 'Copied - paste it into the ticket.'); break; }
      case 'dlmd': { var l2 = exportLeaver(); if (l2) download('lastday-' + fileSafe(l2.name) + '.md', 'text/markdown', C.checklistMarkdown(l2, now())); break; }
      case 'dljson': { var l3 = exportLeaver(); if (l3) download('lastday-' + fileSafe(l3.name) + '.json', 'application/json', JSON.stringify(C.checklistJson(l3, now()), null, 2) + '\n'); break; }
      case 'dlcsv': { var l4 = exportLeaver(); if (l4) download('lastday-' + fileSafe(l4.name) + '.csv', 'text/csv', C.toCsv(C.checklistRows(l4))); break; }
      case 'clearkept': clearKept(); state.keep = false; draw(); toast('Cleared from this device.'); break;
      default: break;
    }
  });
  /** The draft's fields drawn again - in the edit sheet when it is open,
   *  else the page - keeping the place on screen. */
  function redrawDraft() {
    var box = state.editing && !$('#sheet').hidden ? $('#edFields') : null;
    if (box) { var st = $('#sheet').scrollTop; box.innerHTML = fieldsHtml(); wireDraft(box); $('#sheet').scrollTop = st; return; }
    var y = scrollY; draw(); scrollTo(0, y);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) { closeSheet(); }
  });

  /* ---------------- start ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill) pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  drawTop();

  // Something comes back only if this device was asked to keep it.
  var kept = recall();
  if (kept && kept.v === 1 && kept.keep === true) {
    state.keep = true;
    var dv = kept.device || {};
    state.device = { initials: C.line(dv.initials, C.LIMITS.byChars), hint: dv.hint === true };
    state.syncBase = typeof kept.syncBase === 'number' ? kept.syncBase : null;
    var own = kept.own || {};
    state.W.own.inventory = C.cleanInventory(own.inventory).inventory;
    state.W.own.leavers = (Array.isArray(own.leavers) ? own.leavers : []).slice(0, C.LIMITS.leavers).map(function (l) { var c = C.cleanLeaver(l); c.foundApps = Array.isArray(l.foundApps) ? l.foundApps.map(function (x) { return C.line(x, 40); }).slice(0, 20) : []; c.checkedApps = Array.isArray(l.checkedApps) ? l.checkedApps.map(function (x) { return C.line(x, 40); }).slice(0, 20) : []; return c; });
    var r0 = own.result;
    if (r0 && r0.summary && Array.isArray(r0.findings) && Array.isArray(r0.ok) && Array.isArray(r0.people) && Array.isArray(r0.apps) && r0.domains && Array.isArray(r0.domains.list)) { r0.names = []; r0.skipped = []; r0.idpSkipped = []; state.W.own.result = r0; }
    state.keptDemo = kept.demo && Array.isArray(kept.demo.leavers) ? kept.demo.leavers.slice(0, C.LIMITS.leavers).map(C.cleanLeaver) : [];
    if (kept.ws === 'demo') startDemo(true); else route();
  } else route();
  loadMe().then(function () {
    if (signedIn()) syncIn();
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openAccountSheet();
  });
}());
