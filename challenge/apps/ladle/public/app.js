/* Ladle - the page. One file, no build step.
 *
 * EVERYTHING HAPPENS ON THIS PHONE. The recipe box - each recipe's name,
 * whose it is, how many it serves, its ingredients, steps and notes - and
 * the shopping list are worked out by LadleCore and kept through
 * ladle-store.js (IndexedDB, with a memory fallback). Photos of the cards
 * are redrawn through a canvas (location and camera details gone) and kept
 * on this phone only: never synced. The made-up example is never kept,
 * sent or synced.
 *
 * The requests this page makes: sign-in, the account's copy of the box
 * (signed in, to keep two phones in step), and the one optional "Type it
 * up", whose body - the card's photos shrunk on this phone, and nothing
 * else - is shown before it is sent.
 *
 * Every string a person typed, the server sent or a model wrote is escaped
 * before it is drawn, and no handler is written into markup: clicks and
 * changes are routed by data-act and data-* attributes from one listener
 * each (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.LadleCore;
  var D = window.LadleDemo;
  var RS = window.LadleStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var REDUCED = (function () { try { return matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return { matches: false }; } }());

  var real = RS.create(RS.idb('ladle'));

  var state = {
    me: null, view: 'start', box: null, demo: false, demoBox: null, device: RS.cleanDevice({}), sync: RS.cleanSync({}), syncState: 'local', syncErr: '',
    tour: 0, q: '', rid: null, scale: {}, draft: null, photos: {}, cook: null, timers: [], mergeNote: null, demoClock: 0, wake: null, wakeState: '',
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
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Ladle stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
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
    if (err.status === 413) return showError(new Error('Those photos were too much to send. Try again - the page shrinks them first.'), box);
    showError(err, box);
  }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }

  /* ---------------- the clock and ids (the page's, never the core's) ---------------- */

  /** A time stamp for a change. The example's clock moves a second a change. */
  function stamp() { if (state.demo) { state.demoClock += 1000; return D.T + state.demoClock; } return Date.now(); }
  function rid(n) { var s = '', abc = 'abcdefghijklmnopqrstuvwxyz0123456789'; try { var a = new Uint8Array(n); crypto.getRandomValues(a); for (var i = 0; i < n; i++) s += abc[a[i] % 36]; } catch (e) { for (var j = 0; j < n; j++) s += abc[Math.floor(Math.random() * 36)]; } return s; }

  /* ---------------- the box: this phone's, and the example ---------------- */

  function box() { return state.demo ? state.demoBox : state.box; }
  function recipe(id) { var b = box(), r = b && b.recipes[id]; if (!r || r.del) return null; var x = C.clone(r); x.id = id; return x; }
  function units() { return state.device.units; }
  function saveLocal() { real.putBox(state.box).catch(function () { /* still in this tab */ }); }
  function saveDevice() { if (!state.demo) real.putDevice(state.device).catch(function () { /* fine */ }); }
  function saveSync() { real.putSync(state.sync).catch(function () { /* fine */ }); }
  /** Keep a changed box: the example in memory only; a real one on this
   *  phone and, signed in, in the account. */
  function commit(next, quiet) {
    if (state.demo) state.demoBox = next;
    else { state.box = next; saveLocal(); pushSoon(); }
    if (!quiet) keepPlace(draw);
  }
  function ensureBox() { if (!state.demo && !state.box) { state.box = C.newBox(stamp()); } return box(); }

  /* ---------------- two phones: the account copy ---------------- */

  var pushTimer = null;
  function bodyOf(b) { return C.cleanBox(b).box; }
  function pushSoon() {
    if (!signedIn() || !state.me.sync || state.demo || !state.box) return;
    clearTimeout(pushTimer);
    state.syncState = 'syncing'; drawSync();
    pushTimer = setTimeout(function () { push(); }, 800);
  }
  function push(base) {
    if (!state.box || !signedIn() || state.demo) return Promise.resolve();
    return api('PUT', 'api/sync', { data: bodyOf(state.box), base: base !== undefined ? base : state.sync.base }).then(function (out) {
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
    state.box = C.cleanBox(acc).box;
    state.sync = { base: at, at: stamp() }; saveLocal(); saveSync();
    state.syncState = 'synced'; drawSync();
    if (state.view === 'start') go('box'); else keepPlace(draw);
  }
  /** The account's copy came back different: merge it into this phone's
   *  (each recipe, list line and tick by its own time; a recipe both phones
   *  changed keeps both), keep the result here, and save it against the
   *  account's version. */
  function mergeIn(acc, at) {
    var local = state.box;
    if (!local) { adopt(acc, at); return null; }
    var m = C.merge(local, acc, state.sync.at && state.sync.base ? state.sync.base : 0, C.copyIdOf);
    var merged = m.box;
    var pulled = !C.same(merged, local);
    state.box = merged; saveLocal();
    if (pulled || m.notes.length) {
      var bits = [];
      if (C.canon(merged.recipes) !== C.canon(local.recipes)) bits.push('recipes');
      if (C.canon(merged.shop) !== C.canon(local.shop)) bits.push('the shopping list');
      state.mergeNote = { pulled: bits, notes: m.notes };
      if (state.view !== 'edit' && state.view !== 'cook') keepPlace(draw);
    }
    if (C.same(merged, acc)) { state.sync = { base: at, at: stamp() }; saveSync(); state.syncState = 'synced'; drawSync(); return null; }
    return push(at);
  }
  function syncIn() {
    if (!signedIn() || !state.me.sync || state.demo) return Promise.resolve();
    return api('GET', 'api/sync').then(function (out) {
      if (!out.data) {
        if (!state.box) { state.syncState = 'synced'; drawSync(); return null; }
        if (state.sync.base === null) return push(null);
        state.sync = { base: null, at: 0 }; saveSync(); state.syncState = 'removed'; drawSync(); return null;
      }
      if (!state.box) { adopt(out.data, out.updatedAt); return null; }
      if (state.sync.base === out.updatedAt) { if (!C.same(state.box, out.data)) return push(); state.syncState = 'synced'; drawSync(); return null; }
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
    return '<span class="sync small okline">✓ In step with your account · card photos stay on this phone</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }
  function mergeNoteHtml() {
    var m = state.mergeNote;
    if (!m || state.demo) return '';
    var lines = (m.pulled.length ? ['From your other phone: ' + C.list(m.pulled) + '.'] : []).concat(m.notes.slice(0, 4));
    return '<div class="merged" role="status"><b>Merged with your other phone</b> <button class="link-btn" type="button" data-act="mergeok">OK</button>' + (lines.length ? '<ul>' + lines.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
  }

  /* ---------------- navigation ---------------- */

  var VIEWS = ['start', 'box', 'recipe', 'edit', 'add', 'shop', 'cook', 'more'];
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
    if (v === 'add') { if (!state.draft || !state.draft.isNew) state.draft = newDraft(); v = 'edit'; }
    if ((v === 'recipe' || v === 'cook') && !(state.rid && recipe(state.rid))) v = box() ? 'box' : 'start';
    if (v === 'edit' && !state.draft) v = box() ? 'box' : 'start';
    if (['box', 'shop', 'more'].indexOf(v) >= 0 && !box()) v = 'start';
    if (v === 'start' && box() && !state.demo && h === '') v = 'box';
    if (v !== 'cook') leaveCook();
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
    var main = $('#main'), tb = $('#tabbar'), b = box();
    tb.hidden = state.view === 'start' || state.view === 'cook' || (!b && state.view !== 'edit');
    var tab = state.view === 'recipe' ? 'box' : state.view === 'edit' ? (state.draft && state.draft.isNew ? 'add' : 'box') : state.view;
    $$('#tabbar [data-tab]').forEach(function (x) { if (x.getAttribute('data-tab') === tab) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
    var v = state.view, html;
    if (v === 'box') html = boxHtml();
    else if (v === 'recipe') html = recipeHtml();
    else if (v === 'edit') html = editHtml();
    else if (v === 'shop') html = shopHtml();
    else if (v === 'cook') html = cookHtml();
    else if (v === 'more') html = moreHtml();
    else html = startHtml();
    main.innerHTML = html;
    document.body.classList.toggle('in-demo', state.demo);
    document.body.classList.toggle('in-cook', v === 'cook');
    drawSync();
  }

  /* ---------------- the example and its tour ---------------- */

  var TOUR = [
    { view: 'box', title: 'The recipe box', body: 'Six family recipes, typed up from fading index cards - Nana Dot’s pumpkin pie, her cornbread dressing, Aunt Lou’s sweet potatoes. Search by a name, a person or what is in it.', btn: 'Open the pumpkin pie', next: 'Next: scale it' },
    { view: 'recipe', title: 'Scale it, in real fractions', body: 'The card serves 8 and Thursday is 16. Double it and ¾ cup sugar becomes 1 ½ cups and ½ tsp salt 1 tsp - and a doubled 2 tbsp is said as ¼ cup, the way a cook would. US cups or metric, one tap.', btn: 'Make it serve 16', next: 'Next: one shopping list' },
    { view: 'shop', title: 'One list for the whole dinner', body: 'Two pies, the dressing and the sweet potatoes on one list: 8 eggs from three cards, 1 cup of butter, 2 cups of sugar - added up exactly and sorted by aisle. Tick as you go, or send it to whoever is shopping.', btn: 'Tick the eggs', next: 'Next: cook mode' },
    { view: 'cook', title: 'Cook mode', body: 'One big step at a time, the screen kept awake where the phone allows, and a timer on every step that says how long - 15 minutes, then 40.', btn: 'Start the 15 min timer', next: 'Next: save a card' },
    { view: 'edit', title: 'Save a card before it fades', body: 'Photograph a card - the photo stays on this phone, location gone. AI can type it up for you to check beside the card; it never reads a name off it, and drops anything the card does not say.', btn: 'Type up the example card', next: 'Save my first recipe' },
  ];
  function startDemo() {
    state.demo = true; state.demoBox = D.box(); state.demoClock = 0; state.tour = 1; state.mergeNote = null; state.q = ''; state.scale = {}; state.draft = null; state.rid = null;
    go('box');
  }
  function leaveDemo() {
    state.demo = false; state.demoBox = null; state.tour = 0; state.q = ''; state.scale = {}; state.draft = null; state.rid = null; stopAllTimers();
    if (!state.device.tour) { state.device.tour = true; saveDevice(); }
    go(state.box ? 'box' : 'start');
  }
  function tourStep(n) {
    if (n > TOUR.length) { leaveDemo(); go('add'); return; }
    state.tour = n;
    var s = TOUR[n - 1];
    if (n === 2 || n === 4) state.rid = 'rpumpkin1';
    if (n === 4) { state.cook = { rid: 'rpumpkin1', i: 4 }; enterCook(); }
    if (n === 5) { state.draft = newDraft(); }
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
    if (n === 1) { state.rid = 'rpumpkin1'; go('recipe'); state.tour = 2; keepPlace(draw); }
    if (n === 2) { state.scale.rpumpkin1 = C.Q(2); keepPlace(draw); say('Doubled: serves 16.'); }
    if (n === 3) { commit(C.tick(box(), 'egg|n:', true, stamp())); say('Eggs ticked.'); }
    if (n === 4) { startTimer(15, 'Step 5: 15 min'); }
    if (n === 5) typeExample();
  }

  /* ---------------- first run ---------------- */

  function heroCardHtml() {
    return '<div class="hero-art" aria-hidden="true">' + D.cardSvg() + '</div>';
  }
  function startHtml() {
    var has = Boolean(state.box);
    return '<div class="stack">' +
      '<section class="hero"><div><p class="kicker">🥄 Thanksgiving is Thursday</p><h1>Save the family recipes before the cards fade.</h1>' +
      '<p>Photograph Nana’s index card and type it up - or let AI type it up for you to check beside the card. Then scale it with real fractions, switch to metric, make one shopping list from every dish, cook with big steps and timers, and print a fresh card for the cousins.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="demo">Try the example</button>' +
      (has ? '<button class="btn big ghost" type="button" data-act="tab" data-tab="box">My recipes</button>' : '<button class="btn big ghost" type="button" data-act="tab" data-tab="add">Add my first card</button>') + '</div>' +
      '<p class="caps">Free · no sign-in · works offline · card photos stay on your phone</p></div>' + heroCardHtml() + '</section>' +
      '<section class="card"><h2>How it works</h2><div class="how4">' +
      '<div><h3>Save the card</h3><p>Type it, or photograph it and have it typed up. The photo stays on this phone, with its location stripped.</p></div>' +
      '<div><h3>Scale it</h3><p>Serves 8, cooking for 14? Real fractions - 1 ¾ cups, not 1.75 - and 4 tbsp said as ¼ cup.</p></div>' +
      '<div><h3>Shop once</h3><p>Pick the dishes; Ladle adds up the eggs and the butter across every card and sorts the list by aisle.</p></div>' +
      '<div><h3>Cook from it</h3><p>Big steps, the screen kept awake, timers from the words on the card. Then print a fresh card.</p></div>' +
      '</div></section>' +
      '<section class="card"><ul class="ticks"><li>No account needed - everything works signed out, on this phone.</li><li>Sign in (free) to keep two phones in step; the card photos never leave the phone.</li><li>AI never reads a name off a card and never adds calories, allergy or health claims.</li></ul></section>' +
      '<p class="foot">Ladle is a trial in the Challenge Lab.</p></div>';
  }

  /* ---------------- the box ---------------- */

  function scaleOf(id) { return state.scale[id] || C.Q(1); }
  function boxHtml() {
    var b = box(), rs = C.search(b, state.q), all = C.liveRecipes(b);
    var rows = rs.map(function (r) {
      var on = b.shop.plan[r.id] && b.shop.plan[r.id].on;
      return '<li><button class="rrow" type="button" data-act="open" data-id="' + esc(r.id) + '"><span class="rt"><b>' + esc(r.title) + '</b><span class="rmeta">' +
        esc([C.whose(r), r.serves ? 'serves ' + r.serves : '', plural(r.ingredients.length, 'ingredient')].filter(Boolean).join(' · ')) + '</span></span>' +
        (on ? '<span class="tag on">On the list</span>' : '') + (state.photos[r.id + '-1'] ? '<span class="tag">Card photo</span>' : '') + '</button></li>';
    }).join('');
    return '<div class="stack">' + demoRibbon() + guideHtml('box') + mergeNoteHtml() +
      '<section class="card"><div class="row spread"><h1>' + esc(state.demo ? D.NAME : 'My recipes') + '</h1><button class="btn" type="button" data-act="tab" data-tab="add">+ Add a card</button></div>' +
      '<p class="small" data-sync>' + syncLine() + '</p>' +
      (all.length ? '<label class="field"><span class="vh">Search the recipes</span><input class="input" id="rq" type="search" data-act-input="rq" placeholder="Search - pie, Nana, pecans" value="' + esc(state.q) + '" autocomplete="off"></label>' : '') +
      '</section>' +
      (all.length ? (rows ? '<ul class="rlist">' + rows + '</ul>' : '<p class="muted">' + esc('Nothing matches “' + state.q + '”.') + '</p>') :
        '<section class="card empty"><h2>No recipes yet</h2><p>Start with the card you would hate to lose. Type it in, or photograph it - the photo stays on this phone.</p><div class="btns"><button class="btn" type="button" data-act="tab" data-tab="add">Add a card</button><button class="btn ghost" type="button" data-act="demo">See the example</button></div></section>') +
      '</div>';
  }

  /* ---------------- one recipe ---------------- */

  var UNIT_MODES = [['written', 'As written'], ['us', 'US cups'], ['metric', 'Metric']];
  function unitSeg() { return '<div class="seg" role="group" aria-label="Units">' + UNIT_MODES.map(function (m) { return '<button type="button" data-act="units" data-v="' + esc(m[0]) + '" aria-pressed="' + (units() === m[0]) + '">' + esc(m[1]) + '</button>'; }).join('') + '</div>'; }
  function scaleHtml(r) {
    var k = scaleOf(r.id);
    if (r.serves) {
      var want = Math.round(C.qnum(k) * r.serves * 100) / 100;
      return '<div class="scaler"><span class="lab">Serves</span><div class="stepper"><button class="btn ghost" type="button" data-act="serves" data-v="-1" aria-label="Serve fewer">−</button><output class="num big" aria-live="polite">' + esc(want) + '</output><button class="btn ghost" type="button" data-act="serves" data-v="1" aria-label="Serve more">+</button></div>' +
        (C.qeq(k, C.Q(1)) ? '<span class="small muted">' + esc('As the card says') + '</span>' : '<button class="link-btn" type="button" data-act="scale1">' + esc('Back to ' + r.serves) + '</button>') + '</div>';
    }
    return '<div class="scaler"><span class="lab">Make</span><div class="seg" role="group" aria-label="How much">' + [[1, 2], [1, 1], [3, 2], [2, 1], [3, 1]].map(function (q) {
      var qq = C.Q(q[0], q[1]);
      return '<button type="button" data-act="mult" data-v="' + esc(q[0] + '/' + q[1]) + '" aria-pressed="' + C.qeq(qq, k) + '">' + esc(C.fracText(qq) + '×') + '</button>';
    }).join('') + '</div></div>';
  }
  function ingredientsHtml(r, k) {
    var any = false;
    var li = r.ingredients.map(function (i) {
      var s = C.scaleIngredient(i, k, units());
      if (s.about) any = true;
      return '<li><span class="amt">' + (s.amount ? esc((s.about ? '~' : '') + s.amount) : '') + '</span><span class="what">' + esc(s.item) + '</span></li>';
    }).join('');
    return '<ul class="ings">' + li + '</ul>' + (any ? '<p class="small muted">~ about: the nearest amount a measuring spoon or cup can hold.</p>' : '');
  }
  function photosHtml(r) {
    var urls = [1, 2].map(function (s) { return state.photos[r.id + '-' + s]; }).filter(Boolean);
    if (state.demo) return '';
    if (urls.length) return '<div class="cardphotos">' + urls.map(function (u, i) { return '<button class="photobtn" type="button" data-act="viewphoto" data-ref="' + esc(r.id + '-' + (i + 1)) + '"><img class="thumb" alt="' + esc((i ? 'The back' : 'The front') + ' of the card') + '" src="' + esc(u) + '"></button>'; }).join('') + '</div>';
    if (r.photos) return '<p class="small muted">The card’s photo is on the phone that took it - photos never sync.</p>';
    return '';
  }
  function recipeHtml() {
    var r = recipe(state.rid), b = box(), k = scaleOf(r.id), mode = units();
    var on = b.shop.plan[r.id] && b.shop.plan[r.id].on;
    var steps = r.steps.map(function (s, i) {
      var t = C.timers(s);
      return '<li><span>' + esc(C.withTemps(s, mode)) + '</span>' + (t.length ? ' <span class="tlist">' + t.map(function (x) { return '<button class="chip small" type="button" data-act="timer" data-mins="' + esc(x.mins) + '" data-label="' + esc('Step ' + (i + 1) + ': ' + x.label) + '">⏱ ' + esc(x.label) + '</button>'; }).join('') + '</span>' : '') + '</li>';
    }).join('');
    return '<div class="stack">' + demoRibbon() + guideHtml('recipe') +
      '<p><button class="link-btn" type="button" data-act="tab" data-tab="box">‹ All recipes</button></p>' +
      '<div class="two"><section class="card recipe"><h1>' + esc(r.title) + '</h1>' + (r.from ? '<p class="from">' + esc(C.whose(r)) + '</p>' : '') +
      scaleHtml(r) + '<div class="unitrow">' + unitSeg() + '</div>' +
      '<h2>Ingredients</h2>' + ingredientsHtml(r, k) +
      (C.qeq(k, C.Q(1)) ? '' : '<p class="note small">Amounts written inside the steps are as the card says - scale those in your head.</p>') +
      '<h2>Method</h2><ol class="steps">' + steps + '</ol>' +
      (r.notes ? '<h2>Notes</h2><p class="notes">' + esc(r.notes) + '</p>' : '') + '</section>' +
      '<aside class="stack"><section class="card actions"><button class="btn big block" type="button" data-act="cook">🍳 Cook it</button>' +
      '<button class="btn ghost block" type="button" data-act="plan" data-id="' + esc(r.id) + '" aria-pressed="' + Boolean(on) + '">' + (on ? '✓ On the shopping list' : 'Add to the shopping list') + '</button>' +
      '<button class="btn ghost block" type="button" data-act="printcard">Print a fresh card</button>' +
      '<div class="btns"><button class="btn ghost small" type="button" data-act="edit" data-id="' + esc(r.id) + '">Edit</button><button class="btn danger small" type="button" data-act="remove" data-id="' + esc(r.id) + '">Remove</button></div></section>' +
      photosHtml(r) + '</aside></div></div>';
  }

  /* ---------------- cook mode ---------------- */

  function cookHtml() {
    var c = state.cook, r = recipe(c.rid), k = scaleOf(r.id), n = r.steps.length;
    var i = Math.max(0, Math.min(c.i, Math.max(0, n - 1)));
    var s = n ? C.withTemps(r.steps[i], units()) : 'This recipe has no steps yet.';
    var t = n ? C.timers(r.steps[i]) : [];
    return '<div class="cook">' + (state.demo ? demoRibbon() + guideHtml('cook') : '') +
      '<div class="cookhead"><button class="btn ghost" type="button" data-act="endcook">‹ Done cooking</button><b class="cooktitle">' + esc(r.title) + '</b></div>' +
      '<p class="wake small" id="wakeLine">' + esc(wakeText()) + '</p>' +
      '<div id="timerStrip">' + timersHtml() + '</div>' +
      '<section class="cookstep" aria-live="polite"><p class="gstep">' + esc(n ? 'Step ' + (i + 1) + ' of ' + n : 'No steps') + '</p><p class="bigstep">' + esc(s) + '</p>' +
      (t.length ? '<div class="btns">' + t.map(function (x) { return '<button class="btn" type="button" data-act="timer" data-mins="' + esc(x.mins) + '" data-label="' + esc('Step ' + (i + 1) + ': ' + x.label) + '">⏱ Start ' + esc(x.label) + '</button>'; }).join('') + '</div>' : '') + '</section>' +
      '<div class="cooknav"><button class="btn big ghost" type="button" data-act="step" data-v="-1"' + (i === 0 ? ' disabled' : '') + '>‹ Back</button><button class="btn big" type="button" data-act="step" data-v="1"' + (i >= n - 1 ? ' disabled' : '') + '>Next ›</button></div>' +
      '<details class="more card"><summary>Ingredients' + esc(C.qeq(k, C.Q(1)) ? '' : ' (scaled)') + '</summary>' + ingredientsHtml(r, k) + '</details></div>';
  }
  function wakeText() {
    if (state.wakeState === 'on') return '☀ The screen stays on while you cook.';
    if (state.wakeState === 'no') return 'This browser can’t keep the screen awake - tap it now and then.';
    return '';
  }
  function enterCook() {
    if (!('wakeLock' in navigator)) { state.wakeState = 'no'; return; }
    navigator.wakeLock.request('screen').then(function (w) {
      state.wake = w; state.wakeState = 'on';
      w.addEventListener('release', function () { if (state.wake === w) { state.wake = null; } });
      var l = $('#wakeLine'); if (l) l.textContent = wakeText();
    }).catch(function () { state.wakeState = 'no'; var l = $('#wakeLine'); if (l) l.textContent = wakeText(); });
  }
  function leaveCook() {
    if (state.wake) { try { state.wake.release(); } catch (e) { /* gone */ } state.wake = null; }
    state.wakeState = '';
  }

  /* ---------------- timers: in this tab, by their end time ---------------- */

  var tickTimer = null;
  function startTimer(mins, label) {
    state.timers.push({ id: rid(6), label: label, end: Date.now() + mins * 60000, total: mins * 60, done: false, paused: null });
    ensureTicking(); drawTimers();
    say('Timer started: ' + label);
  }
  function ensureTicking() { if (!tickTimer) tickTimer = setInterval(tickTimers, 1000); }
  function stopAllTimers() { state.timers = []; clearInterval(tickTimer); tickTimer = null; }
  function left(t) { return t.paused !== null ? t.paused : (t.end - Date.now()) / 1000; }
  function tickTimers() {
    var live = false;
    state.timers.forEach(function (t) {
      if (t.done || t.paused !== null) return;
      if (left(t) <= 0) { t.done = true; ring(t); } else live = true;
    });
    $$('[data-tleft]').forEach(function (el) { var t = state.timers.filter(function (x) { return x.id === el.getAttribute('data-tleft'); })[0]; if (t) el.textContent = t.done ? 'Done!' : C.clockText(left(t)); });
    if (!live && !state.timers.some(function (t) { return t.paused !== null; })) { clearInterval(tickTimer); tickTimer = null; }
  }
  function ring(t) {
    toast('⏱ ' + t.label + ' - done!', 8000);
    say(t.label + ' - done.');
    try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch (e) { /* fine */ }
    try {
      var AC = window.AudioContext || window.webkitAudioContext, ac = new AC();
      [0, 0.35, 0.7].forEach(function (at) { var o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 880; o.connect(g); g.connect(ac.destination); g.gain.setValueAtTime(0.25, ac.currentTime + at); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + at + 0.3); o.start(ac.currentTime + at); o.stop(ac.currentTime + at + 0.32); });
    } catch (e) { /* no sound here */ }
    drawTimers();
  }
  function timersHtml() {
    if (!state.timers.length) return '';
    return '<ul class="timers">' + state.timers.map(function (t) {
      return '<li class="timer' + (t.done ? ' rang' : '') + '"><span class="tl">' + esc(t.label) + '</span><b class="num" data-tleft="' + esc(t.id) + '">' + esc(t.done ? 'Done!' : C.clockText(left(t))) + '</b>' +
        (t.done ? '' : '<button class="btn small ghost" type="button" data-act="tpause" data-id="' + esc(t.id) + '">' + (t.paused !== null ? 'Go on' : 'Pause') + '</button>') +
        '<button class="btn small ghost x" type="button" data-act="tstop" data-id="' + esc(t.id) + '" aria-label="' + esc('Clear ' + t.label) + '">×</button></li>';
    }).join('') + '</ul>';
  }
  function drawTimers() { var s = $('#timerStrip'); if (s) s.innerHTML = timersHtml(); else if (state.view === 'recipe') keepPlace(draw); }

  /* ---------------- the editor: a new card, or one to change ---------------- */

  function newDraft() { return { id: 'r' + rid(9), isNew: true, fields: { title: '', from: '', serves: '', ingredients: '', steps: '', notes: '', photos: 0 }, photos: {}, unclear: null, dropped: [], example: false, msg: '' }; }
  function draftOf(id) {
    var r = recipe(id);
    var d = { id: id, isNew: false, fields: C.fieldsOf(r), photos: {}, unclear: null, dropped: [], example: false, msg: '' };
    [1, 2].forEach(function (s) { if (state.photos[id + '-' + s]) d.photos[s] = state.photos[id + '-' + s]; });
    return d;
  }
  function cardPane(d) {
    if (d.example) return '<div class="cardpane"><p class="ai-label">Made-up example card</p>' + D.cardSvg() + '</div>';
    var sides = [1, 2].map(function (s) {
      var u = d.photos[s];
      return '<div class="side">' + (u ? '<img class="cardimg" alt="' + esc((s === 1 ? 'The front' : 'The back') + ' of the card') + '" src="' + esc(u) + '"><button class="btn small ghost" type="button" data-act="dropside" data-v="' + esc(s) + '">Remove this photo</button>' :
        '<label class="btn ghost filebtn">' + (s === 1 ? '📷 Photograph the card' : '📷 Add the back') + '<input type="file" accept="image/*" capture="environment" data-cardphoto="' + esc(s) + '"></label>') + '</div>';
    }).filter(function (x, i) { return i === 0 || d.photos[1]; }).join('');
    return '<div class="cardpane">' + sides + '<p class="small muted">Photos are redrawn on this phone (location and camera details gone) and stay here - never synced.</p>' +
      (d.photos[1] ? '<button class="btn block" type="button" data-act="typeup">✨ Type it up with AI</button>' : '') + '</div>';
  }
  function editHtml() {
    var d = state.draft, f = d.fields;
    var unclear = d.unclear && (d.unclear.ingredients.length || d.unclear.steps.length || d.unclear.unsure.length);
    var ingLines = f.ingredients.split('\n'), stepLines = f.steps.split('\n');
    return '<div class="stack">' + demoRibbon() + guideHtml('edit') +
      '<section class="card"><h1>' + esc(d.isNew ? 'Add a card' : 'Edit the recipe') + '</h1><p class="muted small">Type it as the card says - “1 1/2 c. flour”, “2 T butter”, “1 t salt” all read right. One ingredient a line, one step a line.</p></section>' +
      (d.dropped.length || unclear ? '<section class="note checkme" role="status"><b>Check it against the card</b>' +
        (unclear ? '<ul>' + d.unclear.ingredients.map(function (i) { return '<li>' + esc('Ingredient ' + (i + 1) + ' was hard to read: “' + (ingLines[i] || '') + '”') + '</li>'; }).join('') + d.unclear.steps.map(function (i) { return '<li>' + esc('Step ' + (i + 1) + ' was hard to read: “' + (stepLines[i] || '') + '”') + '</li>'; }).join('') + d.unclear.unsure.map(function (u) { return '<li>' + esc('Not sure of the ' + u + '.') + '</li>'; }).join('') + '</ul>' : '') +
        (d.dropped.length ? '<p class="small">' + esc('Left out by Ladle’s checks: ' + d.dropped.join(', ') + '.') + '</p>' : '') + '</section>' : '') +
      '<div class="editgrid">' + cardPane(d) +
      '<section class="card form"><label class="field"><span>Name</span><input class="input" data-f="title" value="' + esc(f.title) + '" maxlength="' + esc(C.LIMITS.title) + '" placeholder="Pumpkin pie" autocomplete="off"></label>' +
      '<div class="pair"><label class="field"><span>Whose recipe</span><input class="input" data-f="from" value="' + esc(f.from) + '" maxlength="' + esc(C.LIMITS.from) + '" placeholder="Nana, Aunt Lou…" autocomplete="off"></label>' +
      '<label class="field"><span>Serves or makes</span><input class="input" data-f="serves" type="number" inputmode="numeric" min="1" max="' + esc(C.LIMITS.serves) + '" value="' + esc(f.serves) + '"></label></div>' +
      '<label class="field"><span>Ingredients</span><textarea class="input tall" data-f="ingredients" rows="9" placeholder="3/4 c. sugar&#10;1 t cinnamon&#10;2 eggs">' + esc(f.ingredients) + '</textarea></label>' +
      '<div id="readback">' + readbackHtml(f.ingredients) + '</div>' +
      '<label class="field"><span>Method</span><textarea class="input tall" data-f="steps" rows="8" placeholder="Heat the oven to 425°F.&#10;Mix the sugar and spices.">' + esc(f.steps) + '</textarea></label>' +
      '<label class="field"><span>Notes</span><textarea class="input" data-f="notes" rows="3" placeholder="Nana always made two.">' + esc(f.notes) + '</textarea></label>' +
      '<div id="eErr"></div><div class="btns"><button class="btn" type="button" data-act="savedraft">' + (d.isNew ? 'Save to my recipes' : 'Save changes') + '</button><button class="btn ghost" type="button" data-act="canceldraft">Cancel</button></div></section></div></div>';
  }
  /** How Ladle read the ingredient lines - so a misread shows before Save. */
  function readbackHtml(text) {
    var ls = String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).slice(0, 60);
    if (!ls.length) return '';
    return '<details class="more readback"><summary>' + esc('How Ladle reads them (' + ls.length + ')') + '</summary><ul class="ings">' + ls.map(function (l) {
      var i = C.parseIngredient(l);
      return '<li><span class="amt">' + esc([C.amountText(i.q, i.q2), i.unit ? C.unitText(i.unit, i.q2 || i.q) : ''].filter(Boolean).join(' ') || '-') + '</span><span class="what">' + esc(i.item) + '</span></li>';
    }).join('') + '</ul></details>';
  }
  function saveDraft() {
    var d = state.draft;
    var f = C.clone(d.fields); f.photos = d.photos[1] ? (d.photos[2] ? 2 : 1) : 0;
    var made = C.recipeFrom(f, stamp());
    if (made.errors.length) { showError(new Error(made.errors[0]), $('#eErr')); return; }
    ensureBox();
    var id = d.id;
    if (!state.demo) {
      [1, 2].forEach(function (s) {
        var ref = id + '-' + s;
        if (d.photos[s] && d.photos[s] !== state.photos[ref]) real.putPhoto(ref, d.photos[s]).then(function () { state.photos[ref] = d.photos[s]; }, function (er) { toast(er.message, 4200); });
        if (!d.photos[s] && state.photos[ref]) { real.delPhoto(ref).catch(function () { /* fine */ }); delete state.photos[ref]; }
      });
    }
    state.draft = null; state.rid = id;
    commit(C.putRecipe(box(), id, made.recipe), true);
    toast(d.isNew ? 'Saved - ' + made.recipe.title + '.' : 'Saved.');
    go('recipe');
  }

  /* ---------------- photos: redrawn on this phone ---------------- */

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
          if (url2.length > maxBytes) { reject(new Error('That photo is too detailed to keep - try one a little further away.')); return; }
          resolve({ url: url2, w: w, h: h, kb: Math.round(url2.split(',')[1].length * 0.75 / 1024) });
        } catch (e) { reject(e); }
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That file could not be read as a photo.')); });
      img.src = url;
    });
  }

  /* ---------------- the AI: "Type it up" ---------------- */

  var WHY_AI = 'Typing up a card uses a little AI credit, so it needs a free account (it comes with $2).';
  var SENT_LINE = 'What is sent: the card’s photos, shrunk on your phone - and nothing else. Not your other recipes, not whose card it is.';
  function cardBody(photos) { return { images: [1, 2].filter(function (s) { return photos[s]; }).map(function (s) { return { type: 'image/jpeg', data: photos[s].split(',')[1] }; }) }; }
  function openTypeUp() {
    var intro = '<h2>✨ Type it up</h2><p>AI copies what the card says into the form for you to check beside the photo. It never reads a name off the card, and drops anything a card does not say - calories, allergy claims, links.</p>';
    if (state.demo) {
      sheet(intro + '<p class="ai-label">Made-up example</p>' + D.cardSvg() + '<p class="small muted">Its reading was written in advance and goes through the same checks as a real one - nothing is sent.</p><div class="btns"><button class="btn" type="button" data-act="typeexample">Type up the example</button></div>');
      return;
    }
    if (!signedIn()) {
      sheet(intro + '<div class="note"><p style="margin:0">' + esc(WHY_AI) + ' One account works across every app on this site. Everything else in Ladle stays free with no account.</p></div>' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="aijoin">Create a free account</button><button class="btn ghost" type="button" data-act="typedemo">See the example first</button></div>');
      return;
    }
    var d = state.draft, sent = cardBody(d.photos);
    sheet(intro + '<p class="sentline"><b>' + esc(SENT_LINE) + '</b></p><div class="sentimgs">' + [1, 2].filter(function (s) { return d.photos[s]; }).map(function (s) { return '<img class="labelimg" alt="The photo that will be sent" src="' + esc(d.photos[s]) + '">'; }).join('') + '</div>' +
      '<p class="small muted">' + esc(plural(sent.images.length, 'photo') + ', exactly as shown. Read once and not kept.') + '</p>' +
      '<div id="typeErr"></div><div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="typesend">Send and type it up</button><span class="small muted">' + esc('About a cent or two' + (state.me.tier === 'paid' ? ' (member model)' : '') + '.') + '</span></div>');
  }
  function typeSend(btn) {
    var d = state.draft;
    if (!d || !d.photos[1]) return;
    var sent = cardBody(d.photos);
    btn.disabled = true; btn.textContent = 'Reading the card…';
    api('POST', 'api/ai/card', sent).then(function (res) {
      loadMe();
      fillDraft(res, false);
      closeSheet(true); keepPlace(draw);
      toast('Typed up - check it against the card.');
    }).catch(function (err) { btn.disabled = false; btn.textContent = 'Send and type it up'; meteredError(err, $('#typeErr'), openTypeUp, WHY_AI); });
  }
  function fillDraft(res, example) {
    var d = state.draft;
    var keep = d.fields.from;
    d.fields = C.draftFields(res.draft, keep);
    d.fields.photos = 0;
    d.unclear = { ingredients: res.unclear.ingredients, steps: res.unclear.steps, unsure: res.unsure };
    d.dropped = res.dropped; d.example = example;
  }
  function typeExample() {
    if (!state.draft) state.draft = newDraft();
    var out = C.cleanAiCard(D.CARD_RAW);
    state.draft.example = true;
    fillDraft(out, true);
    closeSheet(true); keepPlace(draw);
  }

  /* ---------------- the shopping list ---------------- */

  function shopHtml() {
    var b = box(), sh = C.shopping(b, units());
    var planned = C.liveRecipes(b).filter(function (r) { return b.shop.plan[r.id] && b.shop.plan[r.id].on; });
    var off = C.liveRecipes(b).filter(function (r) { return !(b.shop.plan[r.id] && b.shop.plan[r.id].on); });
    var groups = sh.groups.map(function (g) {
      return '<section class="card aisle"><h2>' + esc(g.name) + '</h2><ul class="shop">' + g.rows.map(function (r) {
        return '<li><button class="srow" type="button" data-act="tick" data-key="' + esc(r.key) + '" aria-pressed="' + r.on + '"><span class="box" aria-hidden="true">' + (r.on ? '✓' : '') + '</span><span class="st"><span><b>' + esc(r.amount ? (r.about ? '~' : '') + r.amount : '') + '</b> ' + esc(r.name) + (r.plus ? ' <span class="muted">' + esc('and a little more') + '</span>' : '') + '</span>' +
          (r.from.length > 1 ? '<small>' + esc('For ' + C.list(r.from)) + '</small>' : '') + '</span></button>' +
          (r.extra ? '<button class="btn small ghost x" type="button" data-act="delextra" data-id="' + esc(r.id) + '" aria-label="' + esc('Remove ' + r.name) + '">×</button>' : '') + '</li>';
      }).join('') + '</ul></section>';
    }).join('');
    return '<div class="stack">' + demoRibbon() + guideHtml('shop') +
      '<section class="card"><div class="row spread"><h1>Shopping</h1>' + (sh.of ? '<span class="count">' + esc(sh.left + ' of ' + sh.of + ' left') + '</span>' : '') + '</div>' +
      (planned.length ? '<ul class="planned">' + planned.map(function (r) {
        var k = b.shop.plan[r.id].k;
        return '<li><b>' + esc(r.title) + '</b><span class="small muted">' + esc(r.serves ? 'serves ' + Math.round(C.qnum(k) * r.serves * 100) / 100 : C.fracText(k) + '×') + '</span><button class="btn small ghost" type="button" data-act="unplan" data-id="' + esc(r.id) + '">Take off</button></li>';
      }).join('') + '</ul>' : '<p class="muted">Nothing on the list yet. Add a recipe from its page - at the size you will cook it - or pick one here.</p>') +
      (off.length ? '<label class="field"><span>Add a recipe</span><select class="input" data-act-change="planpick"><option value="">Choose…</option>' + off.map(function (r) { return '<option value="' + esc(r.id) + '">' + esc(r.title) + '</option>'; }).join('') + '</select></label>' : '') +
      '<div class="unitrow">' + unitSeg() + '</div></section>' +
      groups +
      '<section class="card"><form id="extraForm" class="row"><label class="field grow"><span>Something else</span><input class="input" id="extraText" maxlength="' + esc(C.LIMITS.extra) + '" placeholder="Coffee, foil, candles" autocomplete="off"></label><button class="btn" type="submit">Add</button></form><div id="xErr"></div></section>' +
      (sh.of ? '<div class="btns"><button class="btn" type="button" data-act="sharelist">Send the list</button><button class="btn ghost" type="button" data-act="clearlist">Start a new list</button></div>' : '') +
      '</div>';
  }

  /* ---------------- print a fresh card ---------------- */

  function cardPrintHtml(r) {
    var c = C.card(r, scaleOf(r.id), units());
    return '<div class="psheet pcard">' + (state.demo ? '<p class="pdemo">Made-up example</p>' : '') +
      '<h1>' + esc(c.title) + '</h1><p class="pfrom">' + esc([c.from ? 'From the kitchen of ' + c.from : '', c.serves ? 'Serves ' + c.serves : ''].filter(Boolean).join(' · ')) + '</p>' +
      '<ul class="ping">' + c.ingredients.map(function (i) { return '<li><b>' + esc(i.amount) + '</b> ' + esc(i.item) + '</li>'; }).join('') + '</ul>' +
      '<ol class="psteps">' + c.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      (c.notes ? '<p class="pnotes">' + esc(c.notes) + '</p>' : '') + '</div>';
  }
  function openPrint() {
    var r = recipe(state.rid);
    sheet('<h2>Print a fresh card</h2><p>' + esc(r.title + (C.qeq(scaleOf(r.id), C.Q(1)) ? '' : ', at the size on screen') + ' - in the units on screen.') + '</p>' +
      '<div class="seg" role="group" aria-label="Card size">' + [['4x6', '4 x 6 index card'], ['page', 'A full page']].map(function (s) { return '<button type="button" data-act="cardsize" data-v="' + esc(s[0]) + '" aria-pressed="' + (state.device.size === s[0]) + '">' + esc(s[1]) + '</button>'; }).join('') + '</div>' +
      '<div class="btns" style="margin-top:14px"><button class="btn" type="button" data-act="doprint">Print</button></div>');
  }
  function doPrint() {
    var r = recipe(state.rid);
    $('#print').innerHTML = cardPrintHtml(r);
    var st = document.getElementById('pagesize');
    if (!st) { st = document.createElement('style'); st.id = 'pagesize'; document.head.appendChild(st); }
    st.textContent = state.device.size === '4x6' ? '@page { size: 6in 4in; margin: 0.25in; } .pcard { font-size: 9pt; }' : '@page { margin: 0.6in; }';
    closeSheet(true);
    setTimeout(function () { window.print(); }, 60);
  }

  /* ---------------- more ---------------- */

  function moreHtml() {
    var n = C.liveRecipes(box()).length;
    return '<div class="stack">' + demoRibbon() + guideHtml('more') +
      '<section class="card"><h1>' + esc(state.demo ? D.NAME : 'My recipe box') + '</h1><p class="muted">' + esc(plural(n, 'recipe') + ' · ' + Object.keys(state.photos).length + ' card photos on this phone') + '</p><p class="small" data-sync>' + syncLine() + '</p></section>' +
      '<section class="card"><h2>Units</h2><p class="small muted">How amounts show everywhere: as the card says, in US cups and spoons, or metric. Oven temperatures get the other scale beside them.</p>' + unitSeg() + '</section>' +
      '<section class="card"><h2>What Ladle keeps</h2><ul class="ticks"><li>Your recipes and list stay on this phone; signed in, the words (never the photos) are kept in your account to reach your other phone.</li><li>Card photos are redrawn on this phone, so their location and camera details are gone.</li><li>Typing up a card sends that card’s photos and nothing else. No model ever reads a name off a card or adds calories, allergy or health claims.</li><li>No email address, phone number or link is ever kept in a recipe.</li></ul></section>' +
      (state.demo ? '<button class="btn ghost block" type="button" data-act="leavedemo">Leave the example</button>' :
        '<section class="card"><h2>This phone</h2><button class="btn ghost block" type="button" data-act="' + (signedIn() ? 'account' : 'signin') + '">' + (signedIn() ? 'Account' : 'Sign in to keep two phones in step') + '</button><button class="btn danger block" type="button" data-act="wipe" style="margin-top:10px">Remove everything from this phone</button></section>') +
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
  var FREE_LINE = 'Ladle is free with no account, and everything stays on this phone. A free account keeps two phones in step and adds typing up a card with AI - it comes with $2 of AI credit, and one account works across every app on this site. Card photos never go to the account.';
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
    var leftUsd = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(leftUsd) + '</span></div><p class="small muted" style="margin:6px 0 0">Typing up a card costs about a cent or two. The box, scaling, the list and cook mode are free and stay on this phone.</p><div id="billing"></div></div>' +
      '<p class="small" style="margin-top:14px" data-sync>' + syncLine() + '</p>' +
      '<button class="btn ghost block" id="forget" type="button" style="margin-top:6px">Remove my recipes from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this phone</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); keepPlace(draw); }); });
        $('#forget', root).addEventListener('click', function () {
          if (!confirm('Remove your recipes from the account? This phone keeps its copy.')) return;
          api('DELETE', 'api/sync').then(function () {
            state.sync = { base: null, at: 0 }; saveSync(); state.syncState = 'local';
            closeSheet(); toast('Removed from the account. This phone still has them.');
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Typing it in yourself, scaling, the list and everything else keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- wiring: one listener per kind of event ---------------- */

  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id'), v = el.getAttribute('data-v');
    var b = box();
    switch (act) {
      case 'home': e.preventDefault(); go(b ? 'box' : 'start'); break;
      case 'tab': closeSheet(true); go(el.getAttribute('data-tab')); break;
      case 'demo': startDemo(); break;
      case 'leavedemo': leaveDemo(); break;
      case 'tour': tourStep(Number(el.getAttribute('data-step'))); break;
      case 'tourdo': tourDo(Number(el.getAttribute('data-step'))); break;
      case 'tourdone': leaveDemo(); go('add'); break;
      case 'closesheet': closeSheet(); break;
      case 'signin': openAccount(); break;
      case 'account': openAccountSheet(); break;
      case 'aijoin': openAccount(WHY_AI, openTypeUp); break;
      case 'mergeok': state.mergeNote = null; keepPlace(draw); break;
      case 'resync': state.sync = { base: null, at: 0 }; push(null); break;
      case 'retrysync': syncIn(); break;
      case 'open': state.rid = id; go('recipe'); break;
      case 'units': state.device.units = v; saveDevice(); keepPlace(draw); break;
      case 'serves': (function () { var r = recipe(state.rid), want = Math.round(C.qnum(scaleOf(r.id)) * r.serves) + Number(v); want = Math.max(1, Math.min(C.LIMITS.serves * 4, want)); state.scale[r.id] = C.factor(r.serves, want); keepPlace(draw); }()); break;
      case 'scale1': delete state.scale[state.rid]; keepPlace(draw); break;
      case 'mult': (function () { var p = v.split('/'); state.scale[state.rid] = C.Q(Number(p[0]), Number(p[1])); keepPlace(draw); }()); break;
      case 'plan': (function () { var on = b.shop.plan[id] && b.shop.plan[id].on; commit(C.planRecipe(b, id, !on, scaleOf(id), stamp())); toast(on ? 'Taken off the list.' : 'On the shopping list.'); }()); break;
      case 'unplan': commit(C.planRecipe(b, id, false, b.shop.plan[id].k, stamp())); break;
      case 'cook': state.cook = { rid: state.rid, i: 0 }; go('cook'); enterCook(); break;
      case 'endcook': go('recipe'); break;
      case 'step': state.cook.i += Number(v); keepPlace(draw); break;
      case 'timer': startTimer(Number(el.getAttribute('data-mins')), el.getAttribute('data-label')); break;
      case 'tpause': (function () { var t = state.timers.filter(function (x) { return x.id === id; })[0]; if (!t) return; if (t.paused !== null) { t.end = Date.now() + t.paused * 1000; t.paused = null; } else t.paused = left(t); ensureTicking(); drawTimers(); }()); break;
      case 'tstop': state.timers = state.timers.filter(function (x) { return x.id !== id; }); drawTimers(); break;
      case 'printcard': openPrint(); break;
      case 'cardsize': state.device.size = v; saveDevice(); openPrint(); break;
      case 'doprint': doPrint(); break;
      case 'edit': state.draft = draftOf(id); go('edit'); break;
      case 'remove': (function () {
        var r = recipe(id);
        if (!confirm('Remove “' + r.title + '”' + (state.demo ? '' : ' and its card photos from this phone') + '?')) return;
        if (!state.demo) [1, 2].forEach(function (s) { real.delPhoto(id + '-' + s).catch(function () { /* fine */ }); delete state.photos[id + '-' + s]; });
        commit(C.removeRecipe(b, id, stamp()), true); go('box'); toast('Removed.');
      }()); break;
      case 'savedraft': saveDraft(); break;
      case 'canceldraft': (function () { var d = state.draft; state.draft = null; if (d && !d.isNew) { state.rid = d.id; go('recipe'); } else go(box() ? 'box' : 'start'); }()); break;
      case 'dropside': (function () { var s = Number(v); delete state.draft.photos[s]; if (s === 1 && state.draft.photos[2]) { state.draft.photos[1] = state.draft.photos[2]; delete state.draft.photos[2]; } keepPlace(draw); }()); break;
      case 'typeup': openTypeUp(); break;
      case 'typesend': typeSend(el); break;
      case 'typeexample': typeExample(); break;
      case 'typedemo': closeSheet(true); startDemo(); tourStep(5); break;
      case 'viewphoto': (function () { var u = state.photos[el.getAttribute('data-ref')]; if (u) sheet('<h2>The card</h2><img class="bigphoto" alt="The card, as photographed" src="' + esc(u) + '">'); }()); break;
      case 'tick': (function () { var k = el.getAttribute('data-key'), on = b.shop.ticks[k] && b.shop.ticks[k].on; commit(C.tick(b, k, !on, stamp())); }()); break;
      case 'delextra': commit(C.removeExtra(b, id, stamp())); break;
      case 'sharelist': shareText('Shopping list', C.shoppingText(C.shopping(b, units()), state.demo ? 'Shopping list (made-up example)' : 'Shopping list'), 'Copied - paste it into a message.'); break;
      case 'clearlist': if (confirm('Start a new list? Every recipe comes off it and every tick is cleared.')) commit(C.clearList(b, stamp())); break;
      case 'wipe':
        if (!confirm('Remove every recipe and card photo from this phone?')) return;
        real.clearAll().then(function () { state.box = null; state.photos = {}; state.sync = RS.cleanSync({}); state.device = RS.cleanDevice({}); go('start'); toast('Removed from this phone.'); });
        break;
      default: break;
    }
  });
  document.addEventListener('submit', function (e) {
    if (e.target && e.target.id === 'extraForm') {
      e.preventDefault();
      var text = $('#extraText').value.trim(), why = C.refuse(text, C.LIMITS.extra);
      if (!text) return;
      if (why) { showError(new Error(why), $('#xErr')); return; }
      commit(C.addExtra(box(), 'x' + rid(9), text, stamp()));
      var again = $('#extraText'); if (again) again.focus();
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-act-change') === 'planpick' && t.value) { var b = box(); commit(C.planRecipe(b, t.value, true, scaleOf(t.value), stamp())); return; }
    if (t.hasAttribute('data-cardphoto') && state.draft) {
      var side = Number(t.getAttribute('data-cardphoto')), file = t.files && t.files[0];
      t.value = '';
      if (!file) return;
      shrink(file, C.LIMITS.aiImageSide, RS.PHOTO_MAX).then(function (p) { state.draft.photos[side] = p.url; state.draft.example = false; keepPlace(draw); toast('Kept on this phone only.'); })
        .catch(function (er) { toast(er.message || 'That photo could not be kept.', 4200); });
    }
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.hasAttribute('data-f') && state.draft) {
      state.draft.fields[t.getAttribute('data-f')] = t.value;
      if (t.getAttribute('data-f') === 'ingredients') { var rb = $('#readback'), open = rb && rb.querySelector('details[open]'); if (rb) { rb.innerHTML = readbackHtml(t.value); if (open) { var dd = rb.querySelector('details'); if (dd) dd.open = true; } } }
    }
    if (t.getAttribute('data-act-input') === 'rq') {
      state.q = t.value;
      var pos = t.selectionStart;
      keepPlace(draw);
      var again = $('#rq'); if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (er) { /* fine */ } }
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
    if (state.view === 'cook' && $('#sheet').hidden && !/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) {
      if (e.key === 'ArrowRight') { var n = $('[data-act="step"][data-v="1"]'); if (n && !n.disabled) n.click(); }
      if (e.key === 'ArrowLeft') { var p = $('[data-act="step"][data-v="-1"]'); if (p && !p.disabled) p.click(); }
    }
  });
  window.addEventListener('popstate', function () { route(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (state.view === 'cook' && !state.wake) enterCook();   // the lock is let go when the page hides
    tickTimers();
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
  Promise.all([real.getBox(), real.getDevice(), real.getSync(), real.photoRefs()]).then(function (r) {
    state.box = r[0]; state.device = r[1]; state.sync = r[2];
    return Promise.all(r[3].map(function (ref) { return real.getPhoto(ref).then(function (url) { if (url) state.photos[ref] = url; }); }));
  }).catch(function () { /* fresh */ }).then(function () {
    var h = (location.hash || '').replace(/^#/, '');
    if (h && ['box', 'shop', 'more', 'add'].indexOf(h) < 0) history.replaceState(null, '', BASE);
    route();
    return loadMe();
  }).then(function () { if (signedIn()) syncIn(); });
}());
