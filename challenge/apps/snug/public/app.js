/* Snug - the page. One file, no build step.
 *
 * EVERYTHING HAPPENS ON THIS PHONE. The home - a few chips about it (never
 * an address), when each job was last done, the breaker panel map, the
 * house facts and the appliances - is worked out by SnugCore and kept
 * through snug-store.js (IndexedDB, with a memory fallback). Photos of the
 * house facts and appliances are redrawn through a canvas and kept on this
 * phone only: never sent, never synced. The made-up example is never kept,
 * sent or synced.
 *
 * The requests this page makes: sign-in, the account's copy of the home
 * (signed in, to keep two phones in step), and the one optional "Read the
 * label", whose body - the photo shrunk on this phone, and nothing else -
 * is shown before it is sent.
 *
 * Every string a person typed, the server sent or a model wrote is escaped
 * before it is drawn, and no handler is written into markup: clicks and
 * changes are routed by data-act and data-* attributes from one listener
 * each (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.SnugCore;
  var D = window.SnugDemo;
  var RS = window.SnugStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var REDUCED = (function () { try { return matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return { matches: false }; } }());

  var real = RS.create(RS.idb('snug'));

  var state = {
    me: null, view: 'start', home: null, demo: false, demoHome: null, device: RS.cleanDevice({}), sync: RS.cleanSync({}), syncState: 'local', syncErr: '',
    tour: 0, q: '', setupDraft: null, setupMsg: '', cdraft: null, adraft: null, aunsure: [], adropped: [], aexample: false,
    photos: {}, label: null, mergeNote: null, paper: '', withLandlord: false, demoClock: 0,
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
  function say(msg) { var l = $('#live'); l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); }
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
  function shareText(title, text, done) {
    if (navigator.share) navigator.share({ title: title, text: text }).catch(function (er) { if (!er || er.name !== 'AbortError') copy(text, done); });
    else copy(text, done);
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
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Snug stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    reveal(where);
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function reveal(el) { try { el.scrollIntoView({ block: 'center', behavior: REDUCED.matches ? 'auto' : 'smooth' }); } catch (e) { /* old browsers */ } }
  function meteredError(err, box, retry, why) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount(why, retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    if (err.status === 413) return showError(new Error('That photo was too much to send. Try again - the page shrinks it first.'), box);
    showError(err, box);
  }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }

  /* ---------------- the clock and ids (the page's, never the core's) ---------------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today() { if (state.demo) return D.TODAY; var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function thisYear() { return Number(today().slice(0, 4)); }
  /** A time stamp for a change. The example's clock moves a second a change. */
  function stamp() { if (state.demo) { state.demoClock += 1000; return D.T + state.demoClock; } return Date.now(); }
  function rid(n) { var s = '', abc = 'abcdefghijklmnopqrstuvwxyz0123456789'; try { var a = new Uint8Array(n); crypto.getRandomValues(a); for (var i = 0; i < n; i++) s += abc[a[i] % 36]; } catch (e) { for (var j = 0; j < n; j++) s += abc[Math.floor(Math.random() * 36)]; } return s; }

  /* ---------------- the home: this phone's, and the example ---------------- */

  function home() { return state.demo ? state.demoHome : state.home; }
  function saveLocal() { real.putHome(state.home).catch(function () { /* still in this tab */ }); }
  function saveDevice() { if (!state.demo) real.putDevice(state.device).catch(function () { /* fine */ }); }
  function saveSync() { real.putSync(state.sync).catch(function () { /* fine */ }); }
  /** Keep a changed home: the example in memory only; a real one on this
   *  phone and, signed in, in the account. */
  function commit(next, quiet) {
    if (state.demo) state.demoHome = next;
    else { state.home = next; saveLocal(); pushSoon(); }
    if (!quiet) keepPlace(draw);
  }

  /* ---------------- two phones: the account copy ---------------- */

  var pushTimer = null;
  function bodyOf(h) { var b = C.cleanHome(h).home; delete b.updatedAt; return b; }
  function pushSoon() {
    if (!signedIn() || !state.me.sync || state.demo || !state.home) return;
    clearTimeout(pushTimer);
    state.syncState = 'syncing'; drawSync();
    pushTimer = setTimeout(function () { push(); }, 800);
  }
  function push(base) {
    if (!state.home || !signedIn() || state.demo) return Promise.resolve();
    return api('PUT', 'api/sync', { data: bodyOf(state.home), base: base !== undefined ? base : state.sync.base }).then(function (out) {
      state.sync = { base: out.updatedAt, at: stamp() }; saveSync();
      state.syncState = 'synced'; state.syncErr = ''; drawSync();
    }).catch(function (err) {
      var code = err.data && err.data.code;
      if (err.status === 409 && code === 'conflict' && err.data.data) return mergeIn(err.data.data, err.data.updatedAt);
      if (err.status === 409 && code === 'removed') { state.sync = { base: null, at: 0 }; saveSync(); state.syncState = 'removed'; drawSync(); return null; }
      state.syncState = 'error'; state.syncErr = err.message; drawSync();
      return null;
    });
  }
  function adopt(acc, at) {
    state.home = C.cleanHome(acc).home; delete state.home.updatedAt;
    state.sync = { base: at, at: stamp() }; saveLocal(); saveSync();
    state.syncState = 'synced'; drawSync();
    if (state.view === 'start') go('plan'); else keepPlace(draw);
  }
  /** The account's copy came back different: merge it into this phone's
   *  (each job's done dates together, everything else by its own time),
   *  keep the result here, and save it against the account's version. */
  function mergeIn(acc, at) {
    var local = state.home;
    if (!local) { adopt(acc, at); return null; }
    var m = C.merge(local, acc);
    var merged = m.home;
    var pulled = !C.same(merged, local);
    state.home = merged; saveLocal();
    if (pulled || m.notes.length) {
      var bits = [];
      if (C.canon(merged.jobs) !== C.canon(local.jobs)) bits.push('jobs done');
      if (C.canon(merged.circuits) !== C.canon(local.circuits) || C.canon(merged.panel) !== C.canon(local.panel)) bits.push('the breaker panel');
      if (C.canon(merged.facts) !== C.canon(local.facts) || C.canon(merged.appliances) !== C.canon(local.appliances)) bits.push('the house facts');
      if (C.canon(merged.profile) !== C.canon(local.profile)) bits.push('the home’s chips');
      state.mergeNote = { pulled: bits, notes: m.notes };
      if (state.view !== 'setup') keepPlace(draw);
      if (m.notes.length && $('#sheet').hidden) openMergeSheet();
    }
    if (C.same(merged, acc)) { state.sync = { base: at, at: stamp() }; saveSync(); state.syncState = 'synced'; drawSync(); return null; }
    return push(at);
  }
  function syncIn() {
    if (!signedIn() || !state.me.sync || state.demo) return Promise.resolve();
    return api('GET', 'api/sync').then(function (out) {
      if (!out.data) {
        if (!state.home) { state.syncState = 'synced'; drawSync(); return null; }
        if (state.sync.base === null) return push(null);
        state.sync = { base: null, at: 0 }; saveSync(); state.syncState = 'removed'; drawSync(); return null;
      }
      if (!state.home) { adopt(out.data, out.updatedAt); return null; }
      if (state.sync.base === out.updatedAt) { if (!C.same(state.home, out.data)) return push(); state.syncState = 'synced'; drawSync(); return null; }
      return mergeIn(out.data, out.updatedAt);
    }).catch(function () { state.syncState = 'error'; drawSync(); });
  }
  function syncLine() {
    if (state.demo) return '<span class="sync small muted">The example is never saved, sent or synced.</span>';
    if (!signedIn()) return '<span class="sync small muted">On this phone only · <button class="link-btn" type="button" data-act="signin">sign in to keep two phones in step</button></span>';
    if (state.me && !state.me.sync) return '<span class="sync small muted">Keeping it in the account is unavailable right now - it is on this phone.</span>';
    if (state.syncState === 'syncing') return '<span class="sync small muted">Saving to your account…</span>';
    if (state.syncState === 'removed') return '<span class="sync small warnline">Removed from your account on another phone - kept here. <button class="link-btn" type="button" data-act="resync">Keep it in the account again</button></span>';
    if (state.syncState === 'error') return '<span class="sync small err">Couldn’t reach your account' + (state.syncErr ? ': ' + esc(state.syncErr) : '') + ' <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="sync small okline">✓ In step with your account · photos stay on this phone</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }
  function mergeNoteHtml() {
    var m = state.mergeNote;
    if (!m || state.demo) return '';
    var lines = (m.pulled.length ? ['From your other phone: ' + C.list(m.pulled) + '.'] : []).concat(m.notes.slice(0, 4));
    return '<div class="merged" role="status"><b>Merged with your other phone</b> <button class="link-btn" type="button" data-act="mergeok">OK</button>' + (lines.length ? '<ul>' + lines.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
  }
  /** Two breakers in one space - flagged, never dropped. */
  function clashHtml() {
    var h = home(), cl = C.occupancy(h).clashes;
    return cl.map(function (c) {
      return '<div class="flag" role="alert"><p>' + esc('Two breakers are in space ' + c.n + ': ' + C.circuitName(h.circuits[c.a]) + ' and ' + C.circuitName(h.circuits[c.b]) + '. Move one?') + '</p><div class="btns">' +
        '<button class="btn small" type="button" data-act="editc" data-id="' + esc(c.b) + '">' + esc('Move ' + C.circuitName(h.circuits[c.b])) + '</button></div></div>';
    }).join('');
  }
  function openMergeSheet() {
    var m = state.mergeNote || { pulled: [], notes: [] };
    sheet('<h2>Merged with your other phone</h2>' +
      (m.pulled.length ? '<p>' + esc('From your other phone: ' + C.list(m.pulled) + '.') + '</p>' : '') +
      '<div class="stack">' + clashHtml() + '</div>' +
      '<p class="small muted">Nothing was dropped: the jobs done on either phone are all kept, and a breaker both phones put in one space stays until someone moves it.</p>' +
      '<div class="btns"><button class="btn" type="button" data-act="mergeok">OK</button><button class="btn ghost" type="button" data-act="tab" data-tab="panel">See the panel</button></div>');
  }

  /* ---------------- navigation ---------------- */

  var VIEWS = ['start', 'setup', 'plan', 'winter', 'panel', 'house', 'more'];
  /** Go to a view. A tour step's after-hook runs last, so a sheet it opens
   *  is not closed by the route change. */
  function go(view, after) {
    history.pushState(null, '', BASE + '#' + view);
    route(); scrollTo(0, 0);
    if (after) after();
  }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    var v = VIEWS.indexOf(h) >= 0 ? h : 'start';
    if (v !== 'start' && v !== 'setup' && !home()) v = 'start';
    if (v === 'setup' && !state.setupDraft) state.setupDraft = setupDraftOf(home());
    if (v === 'start' && home() && !state.demo && h === '') v = 'plan';
    state.view = v;
    draw();
  }
  var drawing = false;
  function draw() {
    if (drawing) { setTimeout(draw, 0); return; }
    drawing = true;
    try { drawNow(); } finally { drawing = false; }
  }
  function drawNow() {
    var main = $('#main'), tb = $('#tabbar'), h = home();
    tb.hidden = !h || state.view === 'start' || (state.view === 'setup' && !h);
    var tab = state.view === 'setup' ? 'more' : state.view;
    $$('#tabbar [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var v = state.view, html;
    if (v === 'setup') html = setupHtml();
    else if (v === 'plan') html = planHtml();
    else if (v === 'winter') html = winterHtml();
    else if (v === 'panel') html = panelHtml();
    else if (v === 'house') html = houseHtml();
    else if (v === 'more') html = moreHtml();
    else html = startHtml();
    main.innerHTML = html;
    document.body.classList.toggle('in-demo', state.demo);
    drawSync();
  }

  /* ---------------- the example and its tour ---------------- */

  var TOUR = [
    { view: 'plan', title: 'The plan', body: 'Thirty-six jobs this home needs, from a few chips about it. Three are overdue - the gutters, the furnace filter and the smoke alarm test - and the ring round the house says 33 of 36 are on time.', btn: 'Tick the furnace filter done', next: 'Next: why, how and how long' },
    { view: 'plan', title: 'Why, how and how long', body: 'Every job says why it matters, how to do it, how long it takes a first-timer and whether it is a pro’s job. A renter sees the landlord’s jobs marked, with a polite note ready to send.', btn: 'Open the gutters', next: 'Next: Winter-ready' },
    { view: 'winter', title: 'Winter-ready', body: 'The jobs that keep a home warm and dry through the cold, ticked once done since 1 August: 6 of 11 here. The hoses come off this week - it was put off with "Not now".', next: 'Next: the breaker panel' },
    { view: 'panel', title: 'The breaker panel, finally labelled', body: 'Every breaker in its space, two-pole ones spanning two. Two here were never labelled. Search for what is on a circuit, and print a label for the panel door.', btn: 'Find the dishwasher', next: 'Next: house facts' },
    { view: 'house', title: 'House facts - and Read the label', body: 'Where the water shutoff is, the filter size, every appliance. Photos stay on the phone. Read the label turns a photo of a rating plate into a draft to check - never a serial number, a price or a verdict.', btn: 'Read the example label', next: 'Set up my home' },
  ];
  function startDemo() {
    state.demo = true; state.demoHome = D.home(); state.demoClock = 0; state.tour = 1; state.mergeNote = null; state.setupDraft = null; state.q = ''; state.label = null;
    go('plan');
  }
  function leaveDemo() {
    state.demo = false; state.demoHome = null; state.tour = 0; state.setupDraft = null; state.q = '';
    if (!state.device.tour) { state.device.tour = true; saveDevice(); }
    go(state.home ? 'plan' : 'start');
  }
  function tourStep(n) {
    if (n > TOUR.length) { leaveDemo(); startSetup(); return; }
    state.tour = n;
    var s = TOUR[n - 1];
    if (n === 4) state.q = '';
    go(s.view);
  }
  function guideHtml(view) {
    if (!state.demo) return '';
    var n = state.tour, s = TOUR[n - 1];
    if (!s || s.view !== view) {
      return '<div class="guide" role="note"><div class="gt"><span class="gstep">Example · ' + esc(D.NAME) + '</span><span>Made up - every tap works, and nothing is kept.</span></div><button class="btn ghost small" type="button" data-act="tour" data-step="1">Take the tour</button></div>';
    }
    return '<div class="guide" role="note"><div class="gt"><span class="gstep">' + esc('Example · step ' + n + ' of ' + TOUR.length) + '</span><b>' + esc(s.title) + '</b><span>' + esc(s.body) + '</span></div>' +
      '<div class="btns">' + (s.btn ? '<button class="btn ghost" type="button" data-act="tourdo" data-step="' + esc(n) + '">' + esc(s.btn) + '</button>' : '') + '<button class="btn" type="button" data-act="' + (n === TOUR.length ? 'tourdone' : 'tour') + '" data-step="' + esc(n + 1) + '">' + esc(s.next) + '</button></div></div>';
  }
  function demoRibbon() {
    return state.demo ? '<p class="ribbon">' + esc(D.NOTICE) + ' <button class="link-btn" type="button" data-act="leavedemo">Leave the example</button></p>' : '';
  }
  function tourDo(n) {
    if (n === 1) { commit(C.markDone(home(), 'furnace-filter', today(), today(), stamp())); say('Furnace filter marked done.'); }
    if (n === 2) openJob('gutters');
    if (n === 4) { state.q = 'dishwasher'; keepPlace(draw); var f = $('.space.hit'); if (f) reveal(f); }
    if (n === 5) labelExample();
  }

  /* ---------------- first run ---------------- */

  function heroHouseHtml() {
    return '<svg class="hero-house" viewBox="0 0 300 240" aria-hidden="true">' +
      '<ellipse cx="150" cy="222" rx="130" ry="12" fill="rgba(0,0,0,.18)"/>' +
      '<path d="M50 112L150 34l100 78v106H50z" fill="#fff6f0"/>' +
      '<path d="M34 122L150 28l116 94" fill="none" stroke="#fff6f0" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<rect x="200" y="46" width="22" height="44" fill="#fff6f0"/>' +
      '<rect x="128" y="146" width="44" height="72" rx="6" fill="#8a3a3e"/><circle cx="164" cy="184" r="4" fill="#fff6f0"/>' +
      '<rect x="72" y="132" width="40" height="34" rx="4" fill="#4b5b55"/><rect x="188" y="132" width="40" height="34" rx="4" fill="#4b5b55"/>' +
      '<g transform="translate(206 150) rotate(6)"><rect x="0" y="0" width="74" height="84" rx="8" fill="#2a211d" stroke="#fff6f0" stroke-width="3"/>' +
      '<rect x="10" y="12" width="22" height="9" rx="2" fill="#fff6f0"/><rect x="42" y="12" width="22" height="9" rx="2" fill="#fff6f0"/>' +
      '<rect x="10" y="30" width="22" height="9" rx="2" fill="#fff6f0"/><rect x="42" y="30" width="22" height="9" rx="2" fill="#f0a3a5"/>' +
      '<rect x="10" y="48" width="22" height="9" rx="2" fill="#fff6f0"/><rect x="42" y="48" width="22" height="9" rx="2" fill="#fff6f0"/>' +
      '<text x="37" y="76" text-anchor="middle" font-size="10" font-weight="800" fill="#fff6f0" font-family="system-ui, sans-serif">LABELLED</text></g>' +
      '<g transform="translate(22 40)"><circle cx="24" cy="24" r="22" fill="#fff6f0"/><path d="M14 25l7 7 14-15" fill="none" stroke="#1d6b3a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></g></svg>';
  }
  function startHtml() {
    return '<div class="stack">' +
      '<section class="hero"><div class="copy"><div class="kicker"><span aria-hidden="true">🏡</span> For homeowners and renters</div>' +
      '<h1>The boring jobs that keep a home working, on time.</h1>' +
      '<p>And the breaker panel finally labelled. Tell Snug a few things about your home - never where it is - and get a plan of the jobs it needs, each with why, how, how long and whether it is a pro’s job. First-time buyers especially: nobody hands you this list.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="demo">Try the example</button><button class="btn big ghost" type="button" data-act="new">Set up my home</button></div>' +
      '<p class="caps">44 jobs, from smoke alarms to the gutters. Free, no sign-in.</p></div>' + heroHouseHtml() + '</section>' +
      '<section class="how4"><h2 class="vh">How it works</h2>' +
      '<div class="card"><h3>A few chips</h3><p class="small muted">Own or rent, house or apartment, how it is heated, a gas line, a sump pump. No address, no map, no location - ever.</p></div>' +
      '<div class="card"><h3>A plan that keeps up</h3><p class="small muted">Overdue, this week, this month - and a house-shaped ring that fills as you stay on time. Renters see the landlord’s jobs marked, with a polite note.</p></div>' +
      '<div class="card"><h3>Winter-ready</h3><p class="small muted">The hoses off, the furnace checked, the gutters clear - one checklist before the first freeze.</p></div>' +
      '<div class="card"><h3>The panel, labelled</h3><p class="small muted">Map every breaker, search it in the dark, print a label for the door - and keep the house facts and a house manual.</p></div>' +
      '</section>' +
      '<section class="card"><h2>The promise</h2><ul class="ticks"><li><b>No sign-in.</b> Everything works without an account.</li><li><b>Never where you live.</b> No address, no location, no map.</li><li><b>Photos stay on this phone.</b> Never sent, never synced.</li><li><b>No codes or passwords.</b> Snug refuses to keep them.</li><li><b>Works offline</b> once it has loaded.</li></ul><p class="small muted" style="margin:8px 0 0">Sign in only to keep two phones in step, or to have AI read an appliance’s rating plate.</p></section>' +
      '<p class="foot">A trial app in the <a href="../">Challenge Lab</a>. Snug gives no safety verdicts: when in doubt, call a pro.</p>' +
      '</div>';
  }

  /* ---------------- setup: the chips ---------------- */

  function setupDraftOf(h) { return { profile: h ? C.clone(h.profile) : C.defaultProfile(), isNew: !h }; }
  function startSetup() {
    state.demo = false; state.demoHome = null;
    state.setupDraft = setupDraftOf(state.home); state.setupMsg = '';
    go('setup');
  }
  function setupHtml() {
    var sd = state.setupDraft, p = sd.profile;
    var groups = Object.keys(C.CHIPS).map(function (k) {
      var g = C.CHIPS[k];
      return '<fieldset class="qgroup"><legend>' + esc(g.q) + '</legend><div class="chips" role="group">' + g.opts.map(function (o) {
        return '<button class="chip" type="button" data-act="chip" data-k="' + esc(k) + '" data-v="' + esc(o[0]) + '" aria-pressed="' + (p[k] === o[0]) + '">' + esc(o[1]) + '</button>';
      }).join('') + '</div></fieldset>';
    }).join('');
    var feats = '<fieldset class="qgroup"><legend>What does it have?</legend><div class="chips" role="group">' + C.FEATURES.map(function (f) {
      return '<button class="chip" type="button" data-act="feat" data-v="' + esc(f[0]) + '" aria-pressed="' + (p.has.indexOf(f[0]) >= 0) + '">' + esc(f[1]) + '</button>';
    }).join('') + '</div></fieldset>';
    var n = C.jobsFor(p).length;
    return '<div class="stack">' + demoRibbon() +
      '<section class="card"><h1>' + (sd.isNew ? 'Your home, in a few taps' : 'About your home') + '</h1>' +
      '<p class="muted">Snug never asks where your home is - no address, no map, no location. Just enough to know which jobs it needs.</p>' +
      '<label class="field" style="margin:0 0 16px"><span>A nickname for it</span><input class="input" data-sset="name" maxlength="40" value="' + esc(p.name) + '" autocomplete="off"><small>Like “Our place” or “The flat” - not the address.</small></label>' +
      groups + feats +
      '<label class="field" style="margin:0 0 16px"><span>When did you move in? (optional)</span><input class="input" type="date" data-sset="since" value="' + esc(p.since || '') + '" max="' + esc(today()) + '"><small>Only so the plan knows what has never been done here.</small></label>' +
      '<p class="note"><b>' + esc(plural(n, 'job') + ' for this home') + '</b>' + (p.tenure === 'rent' ? esc(landlordLine(p)) : '') + '</p>' +
      '<div id="setupErr">' + (state.setupMsg ? '<p class="err" role="alert">' + esc(state.setupMsg) + '</p>' : '') + '</div>' +
      '<div class="btns"><button class="btn big" type="button" data-act="savesetup">' + (sd.isNew ? 'Make my plan' : 'Save') + '</button>' + (sd.isNew ? '<button class="btn ghost" type="button" data-act="demo">See the example first</button>' : '<button class="btn ghost" type="button" data-act="tab" data-tab="more">Cancel</button>') + '</div>' +
      '</section></div>';
  }
  function landlordLine(p) {
    var n = C.jobsFor(p).filter(function (j) { return j.landlord; }).length;
    return ' - ' + n + (n === 1 ? ' is' : ' are') + ' your landlord’s, marked with a polite note.';
  }
  function saveSetup() {
    var sd = state.setupDraft, p = sd.profile;
    var why = C.refuse(p.name, C.LIMITS.name);
    if (why || !String(p.name).trim()) { state.setupMsg = 'The nickname: ' + (why || 'give it a name, like “Our place”.'); keepPlace(draw); return; }
    if (p.since && (!C.isIso(p.since) || p.since > today())) { state.setupMsg = 'The move-in date is a day in the past - or leave it empty.'; keepPlace(draw); return; }
    var t = stamp(), next;
    if (!state.home) next = C.newHome(C.cleanHome({ v: 1, profile: p, profileT: t, jobs: {}, panel: { spaces: 40, main: null, t: t }, circuits: {}, facts: {}, appliances: {} }).home.profile, t);
    else { next = C.clone(state.home); next.profile = C.cleanHome({ v: 1, profile: p, profileT: t }).home.profile; next.profileT = t; }
    state.setupDraft = null; state.setupMsg = '';
    commit(next, true);
    go('plan');
    toast(sd.isNew ? 'Your plan is ready.' : 'Saved.');
  }

  /* ---------------- the plan ---------------- */

  /** The on-time ring, drawn as the outline of a house: it fills as the
   *  jobs stay on time. */
  function ringSvg(r) {
    var path = 'M14 62L66 16l52 46v56H14z';
    return '<svg class="ring" viewBox="0 0 132 132" role="img" aria-label="' + esc(r.on + ' of ' + r.of + ' jobs on time') + '">' +
      '<path class="track" d="' + path + '" pathLength="100"/>' +
      '<path class="fill" d="' + path + '" pathLength="100" stroke-dasharray="' + esc(r.pct) + ' 100"/>' +
      '<rect class="door" x="56" y="88" width="20" height="30" rx="3"/>' +
      '<text x="66" y="76" text-anchor="middle" font-size="22">' + esc(r.pct + '%') + '</text></svg>';
  }
  function jobRowHtml(x, t) {
    var j = x.job, late = x.days < 0, justDone = x.last === t;
    return '<li class="job' + (late ? ' overdue' : '') + (justDone ? ' isdone' : '') + '">' +
      '<button class="jobopen" type="button" data-act="job" data-id="' + esc(j.id) + '"><b>' + esc(j.title) + '</b>' +
      '<span class="jobmeta"><span class="due' + (late ? ' late' : '') + '">' + esc(C.dueText(x.due, t)) + '</span><span>' + esc(C.minsText(j.mins)) + '</span>' +
      (x.landlord ? '<span class="tag ll">Landlord</span>' : j.pro === 'pro' ? '<span class="tag pro">Book a pro</span>' : j.pro === 'either' ? '<span class="tag">Yourself or a pro</span>' : '') + '</span></button>' +
      '<button class="donebtn" type="button" data-act="done" data-id="' + esc(j.id) + '" aria-label="' + esc('Mark “' + j.title + '” done today') + '">Done</button></li>';
  }
  function planHtml() {
    var h = home(), t = today(), pl = C.plan(h, t), b = C.buckets(pl), r = C.ring(pl);
    var skipped = C.jobsFor(h.profile).filter(function (j) { return h.jobs[j.id] && h.jobs[j.id].skip; });
    var section = function (key, title) {
      var rows = b[key];
      if (!rows.length) return key === 'overdue' ? '<section class="card bucket"><h2>Overdue <span class="n">none</span></h2><p class="okline">Nothing overdue. Nicely done.</p></section>' : '';
      return '<section class="card bucket"><h2>' + esc(title) + ' <span class="n">' + esc(rows.length) + '</span></h2><ul class="jobs">' + rows.map(function (x) { return jobRowHtml(x, t); }).join('') + '</ul></section>';
    };
    return '<div class="stack">' + demoRibbon() + guideHtml('plan') + mergeNoteHtml() +
      '<section class="card ringcard">' + ringSvg(r) + '<div><h1>' + esc(h.profile.name) + '</h1>' +
      '<p class="muted" style="margin:0">' + esc(r.on + ' of ' + plural(r.of, 'job') + ' on time') + (h.profile.tenure === 'rent' ? esc(' - your own; the landlord’s are marked') : '') + '</p>' +
      '<div class="counts">' + (b.overdue.length ? '<span class="count bad">' + esc(b.overdue.length + ' overdue') + '</span>' : '') + '<span class="count">' + esc(b.week.length + ' this week') + '</span><span class="count">' + esc(b.month.length + ' this month') + '</span></div>' +
      '<p class="small" style="margin:8px 0 0" data-sync>' + syncLine() + '</p></div></section>' +
      section('overdue', 'Overdue') + section('week', 'This week') + section('month', 'This month') +
      (b.later.length ? '<section class="card bucket"><details class="more"><summary>' + esc('Later - ' + plural(b.later.length, 'job')) + '</summary><ul class="jobs">' + b.later.map(function (x) { return jobRowHtml(x, t); }).join('') + '</ul></details></section>' : '') +
      (skipped.length ? '<section class="card"><details class="more"><summary>' + esc('Set aside - ' + plural(skipped.length, 'job')) + '</summary><ul class="jobs">' + skipped.map(function (j) {
        return '<li class="job"><span><b>' + esc(j.title) + '</b></span><button class="btn small ghost" type="button" data-act="unskip" data-id="' + esc(j.id) + '">Bring back</button></li>';
      }).join('') + '</ul></details></section>' : '') +
      '</div>';
  }
  function itemOf(id) { return C.plan(home(), today()).filter(function (x) { return x.job.id === id; })[0] || null; }
  function openJob(id) {
    var j = C.JOB[id];
    if (!j) return;
    var h = home(), t = today(), x = itemOf(id), rec = h.jobs[id] || { done: [] };
    var who = x && x.landlord;
    var note = who ? C.landlordNote(x, t) : '';
    sheet('<h2>' + esc(j.title) + '</h2>' +
      '<p class="facts3"><span>' + esc(C.AREAS[j.area]) + '</span><span>' + esc(C.cap1(C.everyText(j.every)) + (j.months ? ', in ' + C.monthsText(j.months) : '')) + '</span><span>' + esc('About ' + C.minsText(j.mins)) + '</span><span>' + esc(who ? 'Your landlord’s job' : C.PRO[j.pro]) + '</span></p>' +
      (x ? '<p><b class="' + (x.days < 0 ? 'due late' : '') + '">' + esc(C.dueText(x.due, t)) + '</b>' + esc(x.last ? ' · last done ' + C.dateLabel(x.last) : ' · not done here yet') + '</p>' : '<p class="muted">Set aside for this home.</p>') +
      '<h3>Why</h3><p>' + esc(j.why) + '</p><h3>How</h3><ol class="howlist">' + j.how.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      (j.pro === 'pro' && !who ? '<p class="small muted">A pro’s job: Snug says when, not who - ask neighbours or a local trade group for someone they trust.</p>' : '') +
      (who ? '<div class="llnote"><p style="margin:0 0 6px"><b>A polite note to your landlord</b></p><textarea class="input" readonly aria-label="The note" rows="5">' + esc(note) + '</textarea><div class="btns" style="margin-top:8px"><button class="btn small" type="button" data-act="llshare" data-id="' + esc(id) + '">Send it</button><button class="btn small ghost" type="button" data-act="llcopy" data-id="' + esc(id) + '">Copy</button></div><p class="small muted" style="margin:8px 0 0">When they have done it, mark it done here so the plan moves on.</p></div>' : '') +
      '<div class="btns" style="margin-top:14px"><button class="btn" type="button" data-act="donejob" data-id="' + esc(id) + '">Done today</button>' +
      '<label class="field" style="flex:1 1 160px"><span class="small">Or done on</span><input class="input" type="date" data-doneon="' + esc(id) + '" max="' + esc(t) + '"></label></div>' +
      (rec.done && rec.done.length ? '<p class="small muted" style="margin-top:10px">' + esc('Done here: ' + rec.done.slice(-4).map(C.dateLabel).join(', ')) + ' <button class="link-btn" type="button" data-act="undone" data-id="' + esc(id) + '">Take back the last one</button></p>' : '') +
      '<div class="btns" style="margin-top:6px">' + (x ? '<button class="btn small ghost" type="button" data-act="snooze" data-id="' + esc(id) + '">Not now - in a week</button>' : '') +
      ((h.jobs[id] && h.jobs[id].skip) ? '<button class="btn small ghost" type="button" data-act="unskip" data-id="' + esc(id) + '">Bring it back</button>' : '<button class="btn small ghost" type="button" data-act="skip" data-id="' + esc(id) + '">Not for this home</button>') + '</div>' +
      '<p class="small muted" style="margin-top:10px">Snug gives no safety verdicts. Anything that smells of gas, sparks, smokes or leaks fast: stop, and call a pro or the emergency line.</p>');
  }
  function doneJob(id, day) {
    var t = today();
    commit(C.markDone(home(), id, day || t, t, stamp()));
    say(C.JOB[id].title + ' marked done.');
    toast('Done - ' + C.JOB[id].title.charAt(0).toLowerCase() + C.JOB[id].title.slice(1) + '.');
  }

  /* ---------------- winter ---------------- */

  function winterHtml() {
    var h = home(), t = today(), w = C.winter(h, t);
    var pct = w.of ? Math.round(100 * w.ready / w.of) : 100;
    return '<div class="stack">' + demoRibbon() + guideHtml('winter') + mergeNoteHtml() +
      '<section class="card"><h1>Winter-ready</h1><p class="muted">' + esc(w.ready + ' of ' + w.of + ' done since ' + C.dateLabel(w.from) + '.') + '</p>' +
      '<div class="meter" role="img" aria-label="' + esc(pct + '% winter-ready') + '"><i style="width:' + esc(pct) + '%"></i></div>' +
      (w.of && w.ready === w.of ? '<p class="okline" style="margin-top:10px">Ready for the cold. Snug.</p>' : '') + '</section>' +
      '<section class="card"><ul class="wlist">' + w.rows.map(function (r) {
        var x = itemOf(r.job.id);
        return '<li class="job' + (r.ready ? ' isdone' : x && x.days < 0 ? ' overdue' : '') + '"><button class="jobopen" type="button" data-act="job" data-id="' + esc(r.job.id) + '"><b>' + esc((r.ready ? '✓ ' : '') + r.job.title) + '</b>' +
          '<span class="jobmeta">' + (r.ready ? '<span>' + esc('Done ' + C.dateLabel(r.last)) + '</span>' : x ? '<span class="due' + (x.days < 0 ? ' late' : '') + '">' + esc(C.dueText(x.due, t)) + '</span>' : '') + (r.landlord ? '<span class="tag ll">Landlord</span>' : '') + '</span></button>' +
          (r.ready ? '<span class="tag">Ready</span>' : '<button class="donebtn" type="button" data-act="done" data-id="' + esc(r.job.id) + '" aria-label="' + esc('Mark “' + r.job.title + '” done today') + '">Done</button>') + '</li>';
      }).join('') + '</ul></section></div>';
  }

  /* ---------------- the breaker panel ---------------- */

  function spaceHtml(cell, hits, clashSet) {
    var h = home();
    if (cell.kind === 'cont') return '';
    var col = cell.n % 2 ? 1 : 2, row = Math.ceil(cell.n / 2);
    var pos = ' style="grid-column:' + esc(col) + ';grid-row:' + esc(row) + (cell.kind === 'circuit' && cell.poles === 2 ? ' / span 2' : '') + '"';
    if (cell.kind === 'empty') return '<button class="space empty" type="button" data-act="space" data-n="' + esc(cell.n) + '"' + pos + '><span class="sn">' + esc(cell.n) + '</span><span class="sl"><b>Empty - add</b></span></button>';
    var c = h.circuits[cell.id];
    return '<button class="space' + (cell.blank ? ' blank' : '') + (hits[cell.id] ? ' hit' : '') + (clashSet[cell.n] ? ' clash' : '') + '" type="button" data-act="editc" data-id="' + esc(cell.id) + '"' + pos + ' aria-label="' + esc('Space ' + cell.n + (c.poles === 2 ? ' and ' + (cell.n + 2) : '') + ': ' + cell.label + ', ' + cell.amps + ' amps') + '">' +
      '<span class="sn">' + esc(cell.n) + '</span><span class="sl"><b>' + esc(cell.label) + '</b><small>' + esc(cell.amps + ' A' + (c.poles === 2 ? ' · two-pole' : '') + (c.note ? ' · ' + c.note : '')) + '</small></span></button>';
  }
  function panelHtml() {
    var h = home(), rows = C.panelRows(h), found = C.searchCircuits(h, state.q), hits = {}, un = C.unlabelled(h);
    found.forEach(function (c) { hits[c.id] = true; });
    var clashSet = {};
    C.occupancy(h).clashes.forEach(function (c) { clashSet[c.n] = true; });
    var cells = '';
    rows.forEach(function (row) { row.forEach(function (cell) { cells += spaceHtml(cell, hits, clashSet); }); });
    var spacesOpts = ''; for (var s = 2; s <= 60; s += 2) spacesOpts += '<option value="' + esc(s) + '"' + (s === h.panel.spaces ? ' selected' : '') + '>' + esc(s) + '</option>';
    var mainOpts = '<option value="">Not sure</option>' + C.MAIN_AMPS.map(function (a) { return '<option value="' + esc(a) + '"' + (a === h.panel.main ? ' selected' : '') + '>' + esc(a + ' A') + '</option>'; }).join('');
    return '<div class="stack">' + demoRibbon() + guideHtml('panel') + mergeNoteHtml() + clashHtml() +
      '<section class="card"><h1>The breaker panel</h1>' +
      (un ? '<p class="warnline">' + esc(plural(un, 'breaker is', 'breakers are') + ' not labelled yet.') + ' Flip one off and walk the house to see what went dark - then name it.</p>' : (C.liveCircuits(h).length ? '<p class="okline">Every breaker is labelled.</p>' : '<p class="muted">Open the panel door (never the cover behind it) and add each breaker by its space number - odd down the left, even down the right.</p>')) +
      '<label class="field"><span>Find a circuit</span><input class="input" id="pq" data-act-input="pq" type="search" value="' + esc(state.q) + '" placeholder="dishwasher, bath, 20" autocomplete="off"></label>' +
      (state.q ? (found.length ? '<ul class="found">' + found.map(function (c) { return '<li>' + esc('Space ' + c.n + (c.poles === 2 ? ' + ' + (c.n + 2) : '') + ' - ' + C.circuitName(c) + ', ' + c.amps + ' A') + '</li>'; }).join('') + '</ul>' : '<p class="muted" style="margin:8px 0 0">' + esc('Nothing on the panel matches “' + state.q + '”.') + '</p>') : '') +
      '</section>' +
      '<section class="panelbox"><div class="panelhead"><span>' + esc(h.panel.main ? 'Main ' + h.panel.main + ' A' : 'Main breaker') + '</span>' +
      '<span class="row"><label class="small">Spaces <select class="input" data-pset="spaces" style="width:auto;display:inline-block">' + spacesOpts + '</select></label><label class="small">Main <select class="input" data-pset="main" style="width:auto;display:inline-block">' + mainOpts + '</select></label></span></div>' +
      '<div class="spaces">' + cells + '</div></section>' +
      '<section class="card"><h2>A label for the panel door</h2><p class="small muted">Every space, number and name, to print and tape inside the door.</p><div class="btns"><div class="seg" role="group" aria-label="Paper">' + paperBtns() + '</div><button class="btn" type="button" data-act="printlabel">Print the door label</button></div></section>' +
      '</div>';
  }
  function paper() { return state.paper || state.device.paper || (/^en-US|^en-CA|^es-MX/.test(navigator.language || '') ? 'letter' : 'a4'); }
  function paperBtns() { var p = paper(); return [['letter', 'Letter'], ['a4', 'A4']].map(function (k) { return '<button type="button" data-act="paper" data-v="' + esc(k[0]) + '" aria-pressed="' + (p === k[0]) + '">' + esc(k[1]) + '</button>'; }).join(''); }
  function openCircuit(draft) {
    state.cdraft = draft;
    var c = draft, ampOpts = C.AMPS.map(function (a) { return '<option value="' + esc(a) + '"' + (a === c.amps ? ' selected' : '') + '>' + esc(a + ' A') + '</option>'; }).join('');
    var exists = Boolean(home().circuits[c.id] && !home().circuits[c.id].del);
    sheet('<h2>' + esc(exists ? 'Space ' + c.n + ': ' + C.circuitName(home().circuits[c.id]) : 'Add a breaker in space ' + c.n) + '</h2>' +
      '<div class="stack">' +
      '<label class="field"><span>What it runs</span><input class="input" data-cset="label" maxlength="40" value="' + esc(c.label) + '" placeholder="Kitchen counter - left" autocomplete="off"><small>Leave it empty if you do not know yet - it shows as “Not labelled yet”.</small></label>' +
      '<div class="pair"><label class="field"><span>Space</span><input class="input" type="number" inputmode="numeric" min="1" max="' + esc(home().panel.spaces) + '" data-cset="n" value="' + esc(c.n) + '"></label>' +
      '<label class="field"><span>Amps (on the handle)</span><select class="input" data-cset="amps">' + ampOpts + '</select></label></div>' +
      '<label class="check"><input type="checkbox" data-cset="poles"' + (c.poles === 2 ? ' checked' : '') + '> Two-pole (a double-width breaker, for a dryer, an oven or air conditioning)</label>' +
      '<label class="field"><span>A note (optional)</span><input class="input" data-cset="note" maxlength="80" value="' + esc(c.note) + '" placeholder="GFCI by the sink resets it" autocomplete="off"></label>' +
      '<div id="cErr"></div><div class="btns"><button class="btn" type="button" data-act="savec">Save</button>' + (exists ? '<button class="btn ghost danger" type="button" data-act="delc" data-id="' + esc(c.id) + '">Remove</button>' : '') + '</div></div>');
  }
  function saveCircuit() {
    var c = state.cdraft, h = home();
    var why = C.checkCircuit(h, c);
    if (why) { showError(new Error(why), $('#cErr')); return; }
    closeSheet(true);
    commit(C.putCircuit(h, c, stamp()));
    toast('Saved - space ' + c.n + '.');
  }
  function doorLabelHtml() {
    var h = home(), rows = C.panelRows(h);
    var cell = function (x) {
      if (x.kind === 'empty') return '<td class="dn">' + esc(x.n) + '</td><td class="pmuted">-</td>';
      if (x.kind === 'cont') return '<td class="dn">' + esc(x.n) + '</td><td class="pmuted">(two-pole, above)</td>';
      return '<td class="dn">' + esc(x.n) + '</td><td><b>' + esc(x.label) + '</b> ' + esc(x.amps + ' A') + (x.note ? '<br><span class="pmuted">' + esc(x.note) + '</span>' : '') + '</td>';
    };
    return '<div class="psheet"><h1>' + esc(h.profile.name + ' - breaker panel') + '</h1>' + (state.demo ? '<p class="pdemo">Made-up example</p>' : '') +
      '<p class="pmuted">' + esc((h.panel.main ? 'Main ' + h.panel.main + ' A. ' : '') + 'Odd spaces down the left, even down the right.') + '</p>' +
      '<table class="doorlabel"><tbody>' + rows.map(function (r) { return '<tr>' + cell(r[0]) + cell(r[1]) + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  function doPrint(html) {
    var p = $('#print');
    p.innerHTML = html;
    var st = document.getElementById('pagesize') || document.createElement('style');
    st.id = 'pagesize';
    st.textContent = '@page { size: ' + (paper() === 'a4' ? 'A4' : 'letter') + '; margin: 12mm; }';
    document.head.appendChild(st);
    try { window.print(); } catch (e) { /* no printer */ }
  }

  /* ---------------- house facts and appliances ---------------- */

  function photoHtml(ref) {
    var url = state.photos[ref];
    if (state.demo) return '';
    return (url ? '<img class="thumb" alt="Your photo, kept on this phone" src="' + esc(url) + '"><button class="link-btn small" type="button" data-act="delphoto" data-ref="' + esc(ref) + '">Remove the photo</button>' :
      '<label class="btn small ghost" style="position:relative;overflow:hidden;justify-self:start">Add a photo<input type="file" accept="image/*" data-photo="' + esc(ref) + '" style="position:absolute;inset:0;opacity:0;cursor:pointer" aria-label="Add a photo - it stays on this phone"></label>');
  }
  function houseHtml() {
    var h = home(), y = thisYear(), apps = C.liveAppliances(h);
    var facts = C.FACTS.filter(function (f) { return f[0] !== 'gas' || h.profile.gas === 'yes'; });
    return '<div class="stack">' + demoRibbon() + guideHtml('house') + mergeNoteHtml() +
      '<section class="card"><h1>House facts</h1><p class="small muted">Where things are, for you and for whoever is house-sitting. No codes or passwords - keep those in your phone’s password manager. Photos stay on this phone: never sent, never synced.</p>' +
      '<div class="facts">' + facts.map(function (f) {
        var v = h.facts[f[0]];
        return '<div class="fact"><h3>' + esc(f[1]) + '</h3>' + (v && v.text ? '<p>' + esc(v.text) + '</p>' : '<p class="muted small">' + esc(f[2]) + '</p>') +
          '<button class="btn small ghost" type="button" data-act="fact" data-k="' + esc(f[0]) + '" style="justify-self:start">' + (v && v.text ? 'Edit' : 'Add') + '</button>' + photoHtml(f[0]) + '</div>';
      }).join('') + '</div></section>' +
      '<section class="card"><div class="row spread"><h2 style="margin:0">Appliances</h2><div class="btns"><button class="btn small" type="button" data-act="label">📷 Read the label</button><button class="btn small ghost" type="button" data-act="addappl">Add one</button></div></div>' +
      '<p class="small muted">What it is, who made it, the model and the year - for the next repair call or the right filter. Never a serial number.</p>' +
      (apps.length ? '<div class="stack">' + apps.map(function (a) {
        return '<div class="appl"><div><b>' + esc(C.kindLabel(a.kind)) + '</b><div class="small">' + esc([a.maker, a.model].filter(Boolean).join(' ') || a.note) + '</div><div class="small muted">' + esc([a.year ? 'made ' + a.year + ', ' + C.ageText(a, y) : '', a.fuel !== 'unknown' ? C.fuelLabel(a.fuel) : '', a.size, a.filter ? 'filter: ' + a.filter : ''].filter(Boolean).join(' · ')) + '</div>' + photoHtml(a.id) + '</div>' +
          '<button class="btn small ghost" type="button" data-act="editappl" data-id="' + esc(a.id) + '">Edit</button></div>';
      }).join('') + '</div>' : '<p class="muted">None yet. Add the furnace, the water heater and the fridge first - they are the ones a repair call asks about.</p>') +
      '</section></div>';
  }
  function openFact(k) {
    var f = C.FACTS.filter(function (x) { return x[0] === k; })[0], v = home().facts[k];
    sheet('<h2>' + esc(f[1]) + '</h2><label class="field"><span>' + esc(f[2]) + '</span><textarea class="input" id="factText" maxlength="160" rows="4">' + esc(v ? v.text : '') + '</textarea><small>Plain words. No codes or passwords - Snug refuses them.</small></label>' +
      '<div id="fErr"></div><div class="btns" style="margin-top:10px"><button class="btn" type="button" data-act="savefact" data-k="' + esc(k) + '">Save</button></div>');
  }
  function blankAppliance() { return { id: 'a' + rid(9), kind: 'furnace', maker: '', model: '', year: null, fuel: 'unknown', size: '', filter: '', note: '', t: 0, del: false }; }
  function openAppliance(draft, unsure, dropped, example) {
    state.adraft = draft; state.aunsure = unsure || []; state.adropped = dropped || []; state.aexample = Boolean(example);
    var a = draft, u = function (f) { return state.aunsure.indexOf(f) >= 0 ? ' unsure' : ''; };
    var ut = function (f) { return state.aunsure.indexOf(f) >= 0 ? ' <span class="unsure-tag">Check this</span>' : ''; };
    var exists = Boolean(home().appliances[a.id] && !home().appliances[a.id].del);
    sheet('<h2>' + esc(exists ? C.kindLabel(a.kind) : (unsure ? 'Check the reading' : 'Add an appliance')) + '</h2>' +
      (unsure ? '<p class="ai-label">' + (example ? 'Made-up example - read in advance' : 'AI-read - check it against the plate') + '</p>' : '') +
      (state.adropped.length ? '<p class="small muted">' + esc('Left out by Snug’s checks: ' + C.list(state.adropped) + '. Snug keeps what the plate says - never a serial number, a price, a recall or a verdict.') + '</p>' : '') +
      '<div class="stack">' +
      '<div class="pair"><label class="field"><span>What it is' + ut('kind') + '</span><select class="input' + u('kind') + '" data-aset="kind">' + C.KINDS.map(function (k) { return '<option value="' + esc(k[0]) + '"' + (k[0] === a.kind ? ' selected' : '') + '>' + esc(k[1]) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Runs on' + ut('fuel') + '</span><select class="input' + u('fuel') + '" data-aset="fuel">' + C.FUELS.map(function (k) { return '<option value="' + esc(k[0]) + '"' + (k[0] === a.fuel ? ' selected' : '') + '>' + esc(k[1]) + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="pair"><label class="field"><span>Maker' + ut('maker') + '</span><input class="input' + u('maker') + '" data-aset="maker" maxlength="40" value="' + esc(a.maker) + '" autocomplete="off"></label>' +
      '<label class="field"><span>Model' + ut('model') + '</span><input class="input' + u('model') + '" data-aset="model" maxlength="40" value="' + esc(a.model) + '" autocomplete="off"></label></div>' +
      '<div class="pair"><label class="field"><span>Year made' + ut('year') + '</span><input class="input' + u('year') + '" data-aset="year" type="number" inputmode="numeric" min="1950" max="' + esc(thisYear()) + '" value="' + esc(a.year === null ? '' : a.year) + '"></label>' +
      '<label class="field"><span>Size or output' + ut('size') + '</span><input class="input' + u('size') + '" data-aset="size" maxlength="30" value="' + esc(a.size) + '" placeholder="50 gal, 80,000 BTU/h" autocomplete="off"></label></div>' +
      '<label class="field"><span>Filter it takes</span><input class="input" data-aset="filter" maxlength="30" value="' + esc(a.filter) + '" autocomplete="off"></label>' +
      '<label class="field"><span>A note</span><input class="input' + u('volts') + u('amps') + '" data-aset="note" maxlength="120" value="' + esc(a.note) + '" autocomplete="off"></label>' +
      '<div id="aErr"></div><div class="btns"><button class="btn" type="button" data-act="saveappl">Save</button>' + (exists ? '<button class="btn ghost danger" type="button" data-act="delappl" data-id="' + esc(a.id) + '">Remove</button>' : '') + '</div></div>');
  }
  function saveAppliance() {
    var a = state.adraft, why = C.checkAppliance(a, thisYear());
    if (why) { showError(new Error(why), $('#aErr')); return; }
    closeSheet(true);
    commit(C.putAppliance(home(), a, stamp()));
    toast('Saved - ' + C.kindLabel(a.kind).toLowerCase() + '.');
  }
  /** A photo redrawn through a canvas at `side` px as a JPEG - EXIF and
   *  location gone. */
  function shrink(file, side, maxBytes) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.addEventListener('load', function () {
        try {
          var k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
          var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          var g = cv.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
          var q = 0.85, url2 = cv.toDataURL('image/jpeg', q);
          while (url2.length > maxBytes && q > 0.35) { q -= 0.1; url2 = cv.toDataURL('image/jpeg', q); }
          URL.revokeObjectURL(url);
          resolve({ url: url2, w: w, h: h, kb: Math.round(url2.split(',')[1].length * 0.75 / 1024) });
        } catch (e) { reject(e); }
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That file could not be read as a photo.')); });
      img.src = url;
    });
  }

  /* ---------------- the AI: "Read the label" ---------------- */

  var WHY_AI = 'Reading a label uses a little AI credit, so it needs a free account (it comes with $2).';
  var SENT_LINE = 'What is sent: this photo, shrunk on your phone - and nothing else. Not your home, not your other appliances.';
  function labelBody(photo) { return { image: { type: 'image/jpeg', data: photo.url.split(',')[1] } }; }
  function openLabel() {
    var intro = '<h2>📷 Read the label</h2><p>Take a photo of the rating plate - the metal or sticker label inside a door or on the back. AI copies what it says into a draft you check. It never keeps the serial number, and never adds a price, a recall or a verdict.</p>';
    if (state.demo) {
      sheet(intro + '<p class="ai-label">Made-up example</p>' + D.plateSvg() +
        '<p class="small muted">A made-up dryer plate. Its reading was written in advance and goes through the same checks as a real one - nothing is sent.</p>' +
        '<div class="btns"><button class="btn" type="button" data-act="labelexample">See the example reading</button></div>');
      return;
    }
    if (!signedIn()) {
      sheet(intro + '<div class="note"><p style="margin:0">' + esc(WHY_AI) + ' One account works across every app on this site. Everything else in Snug stays free with no account.</p></div>' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="aijoin">Create a free account</button><button class="btn ghost" type="button" data-act="labeldemo">See the example first</button></div>');
      return;
    }
    var p = state.label;
    sheet(intro + '<label class="btn ghost" style="position:relative;overflow:hidden">' + (p ? 'Choose another photo' : 'Choose or take a photo') + '<input type="file" accept="image/*" capture="environment" data-labelfile="1" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label>' +
      (p ? '<p class="sentline"><b>' + esc(SENT_LINE) + '</b></p><img class="labelimg" alt="The photo that will be sent" src="' + esc(p.url) + '"><p class="small muted">' + esc('This exact JPEG: ' + p.w + ' x ' + p.h + ' px, ' + p.kb + ' KB. Read once and not kept.') + '</p>' +
        '<div id="labelErr"></div><div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="labelsend">Send and read it</button><span class="small muted">' + esc('About a cent' + (state.me.tier === 'paid' ? ' (member model)' : '') + '.') + '</span></div>' : '<p class="small muted">The photo is shrunk on this phone first - the location and camera details go - and you see exactly what is sent before you send it.</p>'));
  }
  function labelSend(btn) {
    var p = state.label;
    if (!p) return;
    var sent = labelBody(p);
    btn.disabled = true; btn.textContent = 'Reading…';
    api('POST', 'api/ai/label', sent).then(function (res) {
      loadMe();
      state.label = null;
      openAppliance(C.plateDraft(res.plate, 'a' + rid(9)), res.unsure.length ? res.unsure : ['kind'], res.dropped, false);
    }).catch(function (err) { btn.disabled = false; btn.textContent = 'Send and read it'; meteredError(err, $('#labelErr'), openLabel, WHY_AI); });
  }
  function labelExample() {
    var out = C.cleanAiLabel(D.LABEL_RAW, D.YEAR);
    openAppliance(C.plateDraft(out.plate, 'aexample1'), out.unsure, out.dropped, true);
  }

  /* ---------------- more: the manual, the calendar, the account ---------------- */

  function manualHtml() {
    var m = C.manual(home(), today(), thisYear());
    return '<div class="psheet"><h1>' + esc(m.name + ' - house manual') + '</h1>' + (state.demo ? '<p class="pdemo">Made-up example</p>' : '') +
      '<p class="pmuted">' + esc(m.chips.filter(Boolean).join(' · ')) + '</p>' +
      (m.facts.length ? '<h2>Where things are</h2><table><tbody>' + m.facts.map(function (f) { return '<tr><th>' + esc(f.label) + '</th><td>' + esc(f.text) + '</td></tr>'; }).join('') + '</tbody></table>' : '') +
      (m.appliances.length ? '<h2>Appliances</h2><table><thead><tr><th>What</th><th>Make and model</th><th>Made</th><th>Details</th></tr></thead><tbody>' + m.appliances.map(function (a) { return '<tr><td>' + esc(a.kind) + '</td><td>' + esc(a.what) + '</td><td>' + esc(a.year ? a.year + ' (' + a.age + ')' : '') + '</td><td>' + esc([a.fuel, a.size, a.filter ? 'filter ' + a.filter : '', a.note].filter(Boolean).join(' · ')) + '</td></tr>'; }).join('') + '</tbody></table>' : '') +
      (m.panel.circuits.length ? '<h2>' + esc('Breaker panel' + (m.panel.main ? ' - main ' + m.panel.main + ' A' : '')) + '</h2><table><thead><tr><th>Space</th><th>Runs</th><th>Amps</th></tr></thead><tbody>' + m.panel.circuits.map(function (c) { return '<tr><td>' + esc(c.n) + '</td><td>' + esc(c.label) + (c.note ? '<br><span class="pmuted">' + esc(c.note) + '</span>' : '') + '</td><td>' + esc(c.amps) + '</td></tr>'; }).join('') + '</tbody></table>' : '') +
      '<h2>The jobs</h2>' + m.jobs.map(function (g) { return '<h2>' + esc(g.area) + '</h2><table><thead><tr><th>Job</th><th>How often</th><th>Next</th><th>Last done</th><th>Who</th></tr></thead><tbody>' + g.rows.map(function (r) { return '<tr><td>' + esc(r.title) + '</td><td>' + esc(r.every) + '</td><td>' + esc(r.next) + '</td><td>' + esc(r.last) + '</td><td>' + esc(r.who) + '</td></tr>'; }).join('') + '</tbody></table>'; }).join('') +
      '<p class="pmuted">Made with Snug. No codes or passwords are in this manual.</p></div>';
  }
  function icsText() { return C.ics(home(), today(), state.demo ? D.T + state.demoClock : Date.now(), { landlord: state.withLandlord }); }
  function openIcs() {
    var text = icsText(), n = (text.match(/BEGIN:VEVENT/g) || []).length;
    if (state.demo) {
      sheet('<h2>The calendar file</h2><p>' + esc(plural(n, 'job') + ', each on its next date and repeating at its interval - all-day events, built on the phone.') + '</p><p class="small muted">In the example the calendar is shown, never downloaded.</p><pre class="ics">' + esc(text.split('\r\n').slice(0, 30).join('\n')) + '</pre>');
      return;
    }
    download('snug-home-jobs.ics', 'text/calendar', text);
    toast('Open the file to add ' + plural(n, 'job') + ' to your calendar.', 4200);
  }
  function moreHtml() {
    var h = home(), p = h.profile;
    return '<div class="stack">' + demoRibbon() + guideHtml('more') + mergeNoteHtml() +
      '<section class="card"><h1>' + esc(p.name) + '</h1><p class="muted">' + esc(Object.keys(C.CHIPS).map(function (k) { return C.chipLabel(k, p[k]); }).concat(p.has.map(C.featureLabel)).join(' · ')) + '</p>' +
      '<div class="btns"><button class="btn ghost" type="button" data-act="editsetup">Change the chips</button></div></section>' +
      '<section class="card"><h2>The house manual</h2><p class="small muted">Everything in one printout for a house-sitter, a new owner or the drawer by the panel: where things are, the appliances, the panel and the jobs. Never a code or a password.</p><div class="btns"><div class="seg" role="group" aria-label="Paper">' + paperBtns() + '</div><button class="btn" type="button" data-act="printmanual">Print the house manual</button></div></section>' +
      '<section class="card"><h2>Put the jobs in your calendar</h2><p class="small muted">A calendar file built on this phone: each job on its next date, repeating. Nothing is sent anywhere.</p>' +
      (p.tenure === 'rent' ? '<label class="check"><input type="checkbox" data-act-check="withll"' + (state.withLandlord ? ' checked' : '') + '> Include the landlord’s jobs</label>' : '') +
      '<div class="btns"><button class="btn" type="button" data-act="ics">Get the calendar file (.ics)</button></div></section>' +
      '<section class="card"><h2>Your account</h2><p class="small" data-sync>' + syncLine() + '</p>' +
      (signedIn() ? '<button class="btn ghost" type="button" data-act="account">Account and AI credit</button>' : '<p class="small muted">Free, and only for keeping two phones in step or reading a label. One account works across every app on this site.</p><button class="btn ghost" type="button" data-act="signin">Sign in or create one</button>') + '</section>' +
      (state.demo ? '' : '<section class="card"><h2>Start again</h2><p class="small muted">Removes the home and its photos from this phone. A copy in your account stays until you remove it there.</p><button class="btn ghost danger" type="button" data-act="wipe">Remove everything from this phone</button></section>') +
      '<p class="foot">A trial app in the <a href="../">Challenge Lab</a>. Snug gives no safety verdicts: when in doubt, call a pro.</p></div>';
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

  /* ---------------- the account (shared shape with the lab) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }
  var FREE_LINE = 'Snug is free with no account, and everything stays on this phone. A free account keeps two phones in step and adds reading an appliance’s rating plate with AI - it comes with $2 of AI credit, and one account works across every app on this site. Photos never go to the account.';
  function openAccount(reason, then) {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field" style="margin:10px 0"><span>Your email (for your account only)</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Reading a label costs about a cent. The plan, the panel, the facts and the manual are free and stay on this phone.</p><div id="billing"></div></div>' +
      '<p class="small" style="margin-top:14px" data-sync>' + syncLine() + '</p>' +
      '<button class="btn ghost block" id="forget" type="button" style="margin-top:6px">Remove my home from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this phone</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); keepPlace(draw); }); });
        $('#forget', root).addEventListener('click', function () {
          if (!confirm('Remove your home from the account? This phone keeps its copy.')) return;
          api('DELETE', 'api/sync').then(function () {
            state.sync = { base: null, at: 0 }; saveSync(); state.syncState = 'local';
            closeSheet(); toast('Removed from the account. This phone still has it.');
          }).catch(function (e) { showError(e); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Typing it in, the plan, the panel and everything else keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- wiring: one listener per kind of event ---------------- */

  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id'), v = el.getAttribute('data-v');
    var h = home();
    switch (act) {
      case 'home': e.preventDefault(); go(h ? 'plan' : 'start'); break;
      case 'tab': closeSheet(true); go(el.getAttribute('data-tab')); break;
      case 'demo': startDemo(); break;
      case 'new': startSetup(); break;
      case 'leavedemo': leaveDemo(); break;
      case 'tour': tourStep(Number(el.getAttribute('data-step'))); break;
      case 'tourdo': tourDo(Number(el.getAttribute('data-step'))); break;
      case 'tourdone': leaveDemo(); startSetup(); break;
      case 'closesheet': closeSheet(); break;
      case 'signin': openAccount(); break;
      case 'account': openAccountSheet(); break;
      case 'aijoin': openAccount(WHY_AI, openLabel); break;
      case 'mergeok': state.mergeNote = null; closeSheet(true); keepPlace(draw); break;
      case 'resync': state.sync = { base: null, at: 0 }; push(null); break;
      case 'retrysync': syncIn(); break;
      case 'chip': state.setupDraft.profile[el.getAttribute('data-k')] = v; state.setupMsg = ''; keepPlace(draw); break;
      case 'feat': (function () { var has = state.setupDraft.profile.has, i = has.indexOf(v); if (i >= 0) has.splice(i, 1); else has.push(v); keepPlace(draw); }()); break;
      case 'savesetup': saveSetup(); break;
      case 'editsetup': startSetup(); break;
      case 'job': openJob(id); break;
      case 'done': doneJob(id); break;
      case 'donejob': closeSheet(true); doneJob(id); break;
      case 'undone': (function () { var rec = h.jobs[id]; if (rec && rec.done.length) { commit(C.undoDone(h, id, rec.done[rec.done.length - 1], stamp())); openJob(id); } }()); break;
      case 'snooze': closeSheet(true); commit(C.snooze(h, id, C.addDays(today(), 7), stamp())); toast('Moved to ' + C.dayLabel(C.addDays(today(), 7)) + '.'); break;
      case 'skip': closeSheet(true); commit(C.setSkip(h, id, true, stamp())); toast('Set aside - find it under “Set aside” on the plan.'); break;
      case 'unskip': closeSheet(true); commit(C.setSkip(h, id, false, stamp())); break;
      case 'llshare': shareText('About the home', C.landlordNote(itemOf(id), today()), 'Copied - paste it into a message.'); break;
      case 'llcopy': copy(C.landlordNote(itemOf(id), today()), 'Copied - paste it into a message.'); break;
      case 'space': openCircuit({ id: 'c' + rid(9), n: Number(el.getAttribute('data-n')), poles: 1, amps: 15, label: '', note: '' }); break;
      case 'editc': (function () { var c = h.circuits[id]; if (c) openCircuit({ id: id, n: c.n, poles: c.poles, amps: c.amps, label: c.label, note: c.note }); }()); break;
      case 'savec': saveCircuit(); break;
      case 'delc': closeSheet(true); commit(C.removeCircuit(h, id, stamp())); toast('Removed.'); break;
      case 'paper': state.paper = v; if (!state.demo) { state.device.paper = v; saveDevice(); } keepPlace(draw); break;
      case 'printlabel': doPrint(doorLabelHtml()); break;
      case 'printmanual': doPrint(manualHtml()); break;
      case 'ics': openIcs(); break;
      case 'fact': openFact(el.getAttribute('data-k')); break;
      case 'savefact': (function () {
        var k = el.getAttribute('data-k'), text = $('#factText').value, why = C.refuse(text, C.LIMITS.fact);
        if (why) { showError(new Error(why), $('#fErr')); return; }
        closeSheet(true); commit(C.putFact(h, k, text, stamp())); toast('Saved.');
      }()); break;
      case 'addappl': openAppliance(blankAppliance()); break;
      case 'editappl': openAppliance(C.clone(h.appliances[id])); break;
      case 'saveappl': saveAppliance(); break;
      case 'delappl': closeSheet(true); commit(C.removeAppliance(h, id, stamp())); real.delPhoto(id).catch(function () { /* fine */ }); delete state.photos[id]; toast('Removed.'); break;
      case 'delphoto': (function () { var ref = el.getAttribute('data-ref'); real.delPhoto(ref).then(function () { delete state.photos[ref]; keepPlace(draw); }); }()); break;
      case 'label': openLabel(); break;
      case 'labeldemo': closeSheet(true); startDemo(); tourStep(5); break;
      case 'labelexample': labelExample(); break;
      case 'labelsend': labelSend(el); break;
      case 'wipe':
        if (!confirm('Remove the home and its photos from this phone?')) return;
        real.clearAll().then(function () { state.home = null; state.photos = {}; state.sync = RS.cleanSync({}); state.device = RS.cleanDevice({}); go('start'); toast('Removed from this phone.'); });
        break;
      default: break;
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var h = home();
    if (t.hasAttribute('data-doneon')) {
      var day = t.value, idd = t.getAttribute('data-doneon');
      if (!C.isIso(day) || day > today()) { toast('Pick a day up to today.'); return; }
      closeSheet(true); doneJob(idd, day); return;
    }
    if (t.getAttribute('data-sset') === 'since' && state.setupDraft) { state.setupDraft.profile.since = t.value || null; return; }
    if (t.hasAttribute('data-pset')) {
      var k = t.getAttribute('data-pset'), panel = C.clone(h.panel);
      if (k === 'spaces') {
        var s = Number(t.value), top = 0;
        C.liveCircuits(h).forEach(function (c) { top = Math.max(top, c.n + (c.poles === 2 ? 2 : 0)); });
        if (s < top) { toast('Space ' + top + ' has a breaker - move or remove it first.', 4200); keepPlace(draw); return; }
        panel.spaces = s;
      } else panel.main = t.value === '' ? null : Number(t.value);
      panel.t = stamp();
      var next = C.clone(h); next.panel = panel; commit(next); return;
    }
    if (t.hasAttribute('data-cset') && state.cdraft) {
      var f = t.getAttribute('data-cset');
      if (f === 'poles') state.cdraft.poles = t.checked ? 2 : 1;
      if (f === 'amps') state.cdraft.amps = Number(t.value);
      if (f === 'n') state.cdraft.n = Number(t.value);
      return;
    }
    if (t.hasAttribute('data-aset') && state.adraft) {
      var af = t.getAttribute('data-aset');
      if (af === 'kind' || af === 'fuel') state.adraft[af] = t.value;
      if (af === 'year') state.adraft.year = t.value === '' ? null : Number(t.value);
      return;
    }
    if (t.getAttribute('data-act-check') === 'withll') { state.withLandlord = t.checked; return; }
    if (t.hasAttribute('data-photo')) {
      var ref = t.getAttribute('data-photo'), file = t.files && t.files[0];
      t.value = '';
      if (!file) return;
      shrink(file, 1280, RS.PHOTO_MAX).then(function (p) { return real.putPhoto(ref, p.url).then(function () { state.photos[ref] = p.url; keepPlace(draw); toast('Kept on this phone only.'); }); })
        .catch(function (er) { toast(er.message || 'That photo could not be kept.', 4200); });
      return;
    }
    if (t.hasAttribute('data-labelfile')) {
      var lf = t.files && t.files[0];
      t.value = '';
      if (!lf) return;
      shrink(lf, C.LIMITS.aiImageSide, 2.6 * 1024 * 1024).then(function (p2) { state.label = p2; openLabel(); }).catch(function (er) { toast(er.message || 'That photo could not be read.'); });
    }
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-sset') === 'name' && state.setupDraft) state.setupDraft.profile.name = t.value;
    if (t.hasAttribute('data-cset') && state.cdraft) { var f = t.getAttribute('data-cset'); if (f === 'label' || f === 'note') state.cdraft[f] = t.value; }
    if (t.hasAttribute('data-aset') && state.adraft) { var af = t.getAttribute('data-aset'); if (['maker', 'model', 'size', 'filter', 'note'].indexOf(af) >= 0) state.adraft[af] = t.value; }
    if (t.getAttribute('data-act-input') === 'pq') {
      state.q = t.value;
      var pos = t.selectionStart;
      keepPlace(draw);
      var again = $('#pq'); if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (er) { /* fine */ } }
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
  });
  window.addEventListener('popstate', function () { route(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (!state.demo && home() && ['plan', 'winter'].indexOf(state.view) >= 0 && $('#sheet').hidden) keepPlace(draw);   // the day may have turned
    if (signedIn()) syncIn();
  });
  // Every minute while in front: re-ask the account (two phones in step).
  setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    if (signedIn()) syncIn();
  }, 60000);

  /* ---------------- start ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill) pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  drawTop();
  Promise.all([real.getHome(), real.getDevice(), real.getSync(), real.photoRefs()]).then(function (r) {
    state.home = r[0]; state.device = r[1]; state.sync = r[2];
    return Promise.all(r[3].map(function (ref) { return real.getPhoto(ref).then(function (url) { if (url) state.photos[ref] = url; }); }));
  }).catch(function () { /* fresh */ }).then(function () {
    var h = (location.hash || '').replace(/^#/, '');
    if (h && ['plan', 'winter', 'panel', 'house', 'more'].indexOf(h) < 0) history.replaceState(null, '', BASE);
    route();
    return loadMe();
  }).then(function () { if (signedIn()) syncIn(); });
}());
