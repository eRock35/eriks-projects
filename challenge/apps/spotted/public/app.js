/* Spotted - the page. One file, no build step.
 *
 * A TRIP ON THIS PHONE NEVER LEAVES IT. The board, scoring, the drawn map,
 * pass-the-phone players, the trip history and the recap card are worked
 * out by SpottedCore and kept through spotted-store.js (localStorage, with
 * a memory fallback). The made-up example is never kept, sent or synced.
 *
 * The requests this page makes: a car game (start, join with a code and a
 * first name, spot a plate, poll every 3 seconds while the page is visible
 * and the game is on screen, take back, leave, end), sign-in, and the
 * account's copy of the trip history (signed in, to keep two phones in
 * step). No photo is ever taken or sent - of anyone's car or anything else.
 *
 * Every string a person typed or the server sent is escaped before it is
 * drawn, and no handler is written into markup: clicks are routed by
 * data-act from one listener (the lab's CSP allows script from this origin
 * only).
 */
(function () {
  'use strict';

  var C = window.SpottedCore;
  var D = window.SpottedDemo;
  var S = window.SpottedStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var POLL_MS = 3000;

  var real = S.local();
  var state = {
    me: null, view: 'start', trips: {}, now: {}, prefs: S.cleanPrefs({}), sync: S.cleanSync({}), syncState: 'local', syncErr: '',
    game: null,          // {id, view, offline, seenAt} for a live car game
    demo: null,          // {doc} while the example runs
    tour: 0, q: '', sort: 'az', tripId: null, busy: {}, mergeNote: '',
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    if (!body && method === 'POST') body = {};
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
  function showError(err, where) {
    var msg = (err && err.message) || 'Something went wrong.';
    if (err && err.status === 0) msg = 'You’re offline. Try again when there’s signal.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }
  function rid(n) { var s = '', abc = 'abcdefghijkmnpqrstuvwxyz23456789'; try { var a = new Uint8Array(n); crypto.getRandomValues(a); for (var i = 0; i < n; i++) s += abc[a[i] % 32]; } catch (e) { for (var j = 0; j < n; j++) s += abc[Math.floor(Math.random() * 32)]; } return s; }
  function clock(ms) { try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return new Date(ms).toISOString().slice(11, 16); } }
  function day(ms) { try { return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return C.dateText(ms); } }
  function demoNow() { return D.T + 2 * 60 * 60000; }
  function now() { return state.demo ? demoNow() : Date.now(); }

  /* ---------------- what is being played ---------------- */

  function saveTrips() { real.putTrips(state.trips); pushSoon(); }
  function trips() { return state.demo ? state.demo.trips : state.trips; }
  function curTrip() { var id = state.now.trip; return !state.demo && id && state.trips[id] && !state.trips[id].del ? state.trips[id] : null; }
  function setNow(n) { state.now = S.cleanNow(n); real.putNow(state.now); }
  /** The thing on the Play tab: {kind: 'demo'|'game'|'trip', view, trip}. */
  function playing() {
    if (state.demo) { var v = C.gameView(state.demo.doc, D.YOU); return { kind: 'demo', view: v, trip: C.tripFromGame(v, null, D.T) }; }
    if (state.now.game && state.game && state.game.view) return { kind: 'game', view: state.game.view, trip: curTrip() };
    var t = curTrip();
    if (t && !state.now.game) {
      var s = C.summary(t);
      return { kind: 'trip', trip: t, view: { title: t.title, scoring: t.scoring, ended: Boolean(t.ended), players: t.players.map(function (p, i) { return { name: p.name, c: p.c, p: i, you: false }; }), spots: t.spots, rows: s.rows, headline: s.headline, total: { count: s.count, pts: s.pts, of: s.of } } };
    }
    if (state.now.game) return { kind: 'loading' };
    return null;
  }

  /* ---------------- the car game: polling ---------------- */

  var pollTimer = null;
  function wantPoll() { return Boolean(state.now.game && !state.demo && document.visibilityState === 'visible' && (state.view === 'play' || state.view === 'start')); }
  function schedulePoll(ms) { clearTimeout(pollTimer); if (wantPoll()) pollTimer = setTimeout(poll, ms === undefined ? POLL_MS : ms); }
  function poll() {
    if (!wantPoll()) return;
    var g = state.game || {};
    var since = g.view ? '?since=' + encodeURIComponent(g.view.v) : '';
    api('GET', 'api/g/' + encodeURIComponent(state.now.game) + since).then(function (r) {
      var wasOff = g.offline;
      state.game = state.game || { id: state.now.game };
      state.game.offline = false; state.game.seenAt = Date.now();
      if (r.game) adoptView(r.game);
      else if (wasOff) drawSoft();
      schedulePoll();
    }).catch(function (err) {
      if (err.status === 404) return gameGone();
      state.game = state.game || { id: state.now.game };
      if (!state.game.offline) { state.game.offline = true; drawSoft(); }
      schedulePoll(POLL_MS * 2);
    });
  }
  /** A fresh view of the game: drawn, and copied into this phone's history
   *  as it stands (so a game that closes after a quiet day is still here). */
  function adoptView(v) {
    state.game = state.game || { id: state.now.game };
    var prev = state.game.view;
    state.game.view = v;
    var tid = state.now.trip, before = state.trips[tid];
    state.trips[tid] = C.tripFromGame(v, before && !before.del ? before : null, Date.now());
    saveTrips();
    if (v.ended) {
      setNow({});
      state.game = null; state.tripId = tid;
      toast('The game is over. ' + v.headline, 4200);
      go('trip');
      return;
    }
    if (prev && v.you < 0) return gameGone();
    if (prev) {
      // Someone else's plate landing: say it for screen readers.
      Object.keys(v.spots).forEach(function (c) { if (!prev.spots[c] && v.players[v.spots[c].p] && !v.players[v.spots[c].p].you) say(v.players[v.spots[c].p].name + ' spotted ' + C.stateOf(c).n + '.'); });
    }
    drawSoft();
  }
  function gameGone() {
    var tid = state.now.trip;
    if (state.trips[tid] && !state.trips[tid].del && !state.trips[tid].ended) { state.trips[tid] = C.endTrip(state.trips[tid], Date.now()); saveTrips(); }
    setNow({}); state.game = null;
    toast('That car game has closed. What you saw is in your trips.', 4200);
    state.tripId = state.trips[tid] ? tid : null;
    go(state.tripId ? 'trip' : 'start');
  }
  function enterGame(id, view) {
    var tid = 'g' + rid(10);
    setNow({ trip: tid, game: id });
    state.game = { id: id, view: null };
    if (view) adoptView(view);
    go('play');
    schedulePoll(0);
  }

  /* ---------------- two phones: the account copy of the history ---------------- */

  var pushTimer = null;
  function pushSoon() {
    if (!signedIn() || !state.me.sync || state.demo) return;
    clearTimeout(pushTimer);
    state.syncState = 'syncing'; drawSync();
    pushTimer = setTimeout(function () { push(); }, 1200);
  }
  function push(base) {
    if (!signedIn() || state.demo) return Promise.resolve();
    return api('PUT', 'api/sync', { data: C.cleanTrips(state.trips).trips, base: base !== undefined ? base : state.sync.base }).then(function (out) {
      state.sync = { base: out.updatedAt, at: Date.now() }; real.putSync(state.sync);
      state.syncState = 'synced'; state.syncErr = ''; drawSync();
    }).catch(function (err) {
      var code = err.data && err.data.code;
      if (err.status === 409 && code === 'conflict' && err.data.data) return mergeIn(err.data.data, err.data.updatedAt);
      if (err.status === 409 && code === 'removed') { state.sync = { base: null, at: 0 }; real.putSync(state.sync); state.syncState = 'removed'; drawSync(); return null; }
      state.syncState = 'error'; state.syncErr = err.message; drawSync();
      return null;
    });
  }
  /** The account's copy came back different: merge it (each trip by its own
   *  time), keep the result here, and save it against the account's version. */
  function mergeIn(acc, at) {
    var m = C.mergeTrips(state.trips, C.cleanTrips(acc).trips);
    state.trips = m.trips; real.putTrips(state.trips);
    if (m.pulled) { state.mergeNote = 'From your other phone: ' + plural(m.pulled, 'trip') + '.'; if (state.view === 'trips' || state.view === 'start') keepPlace(draw); }
    if (C.same(state.trips, acc)) { state.sync = { base: at, at: Date.now() }; real.putSync(state.sync); state.syncState = 'synced'; drawSync(); return null; }
    return push(at);
  }
  function syncIn() {
    if (!signedIn() || !state.me.sync || state.demo) return Promise.resolve();
    return api('GET', 'api/sync').then(function (out) {
      if (!out.data) {
        if (!Object.keys(state.trips).length) { state.syncState = 'synced'; drawSync(); return null; }
        if (state.sync.base === null) return push(null);
        state.sync = { base: null, at: 0 }; real.putSync(state.sync); state.syncState = 'removed'; drawSync(); return null;
      }
      if (state.sync.base === out.updatedAt && C.same(state.trips, out.data)) { state.syncState = 'synced'; drawSync(); return null; }
      return mergeIn(out.data, out.updatedAt);
    }).catch(function () { state.syncState = 'error'; drawSync(); });
  }
  function syncLine() {
    if (state.demo) return '<span class="small muted">The example is never saved, sent or synced.</span>';
    if (!signedIn()) return '<span class="small muted">Trips stay on this phone · <button class="link-btn" type="button" data-act="signin">sign in to keep two phones in step</button></span>';
    if (state.me && !state.me.sync) return '<span class="small muted">Keeping trips in the account is unavailable right now - they are on this phone.</span>';
    if (state.syncState === 'syncing') return '<span class="small muted">Saving to your account…</span>';
    if (state.syncState === 'removed') return '<span class="small warnline">Removed from your account on another phone - kept here. <button class="link-btn" type="button" data-act="resync">Keep them in the account again</button></span>';
    if (state.syncState === 'error') return '<span class="small err">Couldn’t reach your account' + (state.syncErr ? ': ' + esc(state.syncErr) : '') + ' <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="small okline">✓ Trips in step with your account</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }

  /* ---------------- drawing pieces ---------------- */

  /** The drawn map: one rounded tile per state (a tile map, near where each
   *  state sits). `fill(code)` returns a colour index, 'seen', or null. */
  function mapSvg(fill, label, small) {
    var size = 44, pad = 3, w = C.MAP_COLS * size, h = C.MAP_ROWS * size;
    var tiles = C.STATES.map(function (s) {
      var f = fill(s.c), x = s.x * size + pad, y = s.y * size + pad, k = size - pad * 2;
      var cls = f === null || f === undefined ? 'tile' : f === 'seen' ? 'tile seen' : 'tile on p' + f;
      return '<g class="' + cls + '"><rect x="' + x + '" y="' + y + '" width="' + k + '" height="' + k + '" rx="7"/>' + (small ? '' : '<text x="' + (x + k / 2) + '" y="' + (y + k / 2 + 5) + '" text-anchor="middle">' + s.c + '</text>') + '</g>';
    }).join('');
    return '<svg class="map' + (small ? ' mini' : '') + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + '">' + tiles + '</svg>';
  }
  function fillFrom(players, spots) { return function (c) { var s = spots[c]; return s && players[s.p] ? players[s.p].c : null; }; }
  function dot(c, name) { return '<span class="dot bg' + esc(c) + '" aria-hidden="true">' + esc(C.initials(name)) + '</span>'; }
  function boardRows(rows, players, ended) {
    return '<ol class="score">' + rows.map(function (r) {
      var pl = players[r.p] || {};
      var crown = r.rank === 1 && r.pts > 0 ? '<span class="lead">' + (ended ? 'Wins' : 'Leads') + '</span>' : '';
      return '<li' + (pl.you ? ' class="you"' : '') + '><span class="rk">' + esc(r.rank) + '</span>' + dot(r.c, r.name) + '<span class="nm">' + esc(r.name) + (pl.you ? ' <span class="muted small">(you)</span>' : '') + (r.left ? ' <span class="muted small">(left)</span>' : '') + crown + '</span><span class="ct small muted">' + esc(plural(r.count, 'plate')) + '</span><b class="pts">' + esc(r.pts) + '</b></li>';
    }).join('') + '</ol>';
  }
  function sortedStates(spots) {
    var q = C.norm(state.q), list = C.STATES.slice();
    if (q) list = list.filter(function (s) { return C.norm(s.n).indexOf(q) === 0 || C.norm(s.n).indexOf(' ' + q) >= 0 || s.c.toLowerCase() === q; });
    if (state.sort === 'left') list = list.filter(function (s) { return !spots[s.c]; });
    list.sort(state.sort === 'rare' ? function (a, b) { return b.tier - a.tier || (a.n < b.n ? -1 : 1); } : function (a, b) { return a.n < b.n ? -1 : 1; });
    return list;
  }
  function plateGrid(pv, canTap) {
    var spots = pv.view.spots, players = pv.view.players, scoring = pv.view.scoring;
    var list = sortedStates(spots);
    var seg = '<div class="seg" role="group" aria-label="Order">' + [['az', 'A–Z'], ['rare', 'Rarest first'], ['left', 'Still to find']].map(function (o) { return '<button type="button" data-act="sort" data-v="' + o[0] + '"' + (state.sort === o[0] ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' + o[1] + '</button>'; }).join('') + '</div>';
    var search = '<label class="field search"><span class="vh">Find a state</span><input class="input" id="q" type="search" placeholder="Find a state - type Ohio or OH" autocomplete="off" value="' + esc(state.q) + '" data-act-input="q"></label>';
    var cells = list.map(function (s) {
      var got = spots[s.c], who = got ? players[got.p] : null, tier = C.TIERS[s.tier], pts = C.pointsFor(s.c, scoring);
      var label = s.n + ', ' + tier.name.toLowerCase() + ', ' + plural(pts, 'point') + (who ? ', spotted by ' + (who.you ? 'you' : who.name) : '');
      return '<button type="button" class="plate t' + s.tier + (got ? ' got' : '') + (who && who.you ? ' mine' : '') + (state.busy[s.c] ? ' busy' : '') + '" data-act="plate" data-st="' + s.c + '" aria-label="' + esc(label) + '"' + (canTap ? '' : ' disabled') + '>' +
        '<span class="pc">' + s.c + '</span><span class="pn">' + esc(s.n) + '</span><span class="pp">+' + pts + '</span>' +
        (who ? '<span class="pw">' + dot(who.c, who.name) + '<span>' + esc(who.you ? 'You' : who.name) + '</span></span>' : '<span class="pw muted">' + esc(tier.name) + '</span>') + '</button>';
    }).join('');
    return '<section class="board" aria-label="The board">' + search + seg + (list.length ? '<div class="plates">' + cells + '</div>' : '<p class="muted center">' + (state.sort === 'left' && !state.q ? 'Every plate is spotted - the whole board!' : 'No state matches that.') + '</p>') + '</section>';
  }

  /* ---------------- navigation ---------------- */

  var VIEWS = ['start', 'play', 'trips', 'trip', 'more'];
  function go(view) {
    history.pushState(null, '', BASE + '#' + view);
    route(); scrollTo(0, 0);
  }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    var v = VIEWS.indexOf(h) >= 0 ? h : 'start';
    if (v === 'play' && !playing()) v = 'start';
    if (v === 'trip' && !(state.tripId && trips()[state.tripId] && !trips()[state.tripId].del)) v = 'trips';
    if (v === 'start' && h === '' && playing() && !state.demo) v = 'play';
    state.view = v;
    draw();
    schedulePoll(0);
  }
  var drawing = false;
  function draw() {
    if (drawing) { setTimeout(draw, 0); return; }
    drawing = true;
    try { drawNow(); } finally { drawing = false; }
  }
  /** Redraw without losing the place or the search box's focus. */
  function drawSoft() {
    if (state.view !== 'play' && state.view !== 'start') return;
    var a = document.activeElement, focusQ = a && a.id === 'q', pos = focusQ ? a.selectionStart : 0;
    keepPlace(draw);
    if (focusQ) { var q = $('#q'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (e) { /* fine */ } } }
  }
  function drawNow() {
    var main = $('#main'), tb = $('#tabbar');
    var any = Boolean(playing()) || C.live(trips()).length > 0;
    tb.hidden = state.view === 'start' && !any;
    var tab = state.view === 'trip' ? 'trips' : state.view === 'start' ? (playing() ? '' : 'play') : state.view;
    $$('#tabbar [data-tab]').forEach(function (x) { if (x.getAttribute('data-tab') === tab) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
    var v = state.view, html;
    if (v === 'play') html = playHtml();
    else if (v === 'trips') html = tripsHtml();
    else if (v === 'trip') html = tripHtml();
    else if (v === 'more') html = moreHtml();
    else html = startHtml();
    main.innerHTML = demoRibbon() + html;
    document.body.classList.toggle('in-demo', Boolean(state.demo));
    drawSync();
  }

  /* ---------------- the example and its tour ---------------- */

  var TOUR = [
    { view: 'play', title: 'Every phone in the car, one board', body: 'Four phones joined this game with a code and a first name - no accounts. The map fills in with each person’s colour as plates are spotted, and the scoreboard keeps up live.', next: 'Next: spot a plate' },
    { view: 'play', title: 'First tap wins - and rare plates pay', body: 'A Vermont plate is Rare, worth 5. Big states are 1, middling ones 2 or 3; Alaska and Hawaii are Rare because nobody drives from there. Tap it before anyone else does.', btn: 'Tap Vermont', next: 'Next: too slow' },
    { view: 'play', title: 'Too slow!', body: 'An Ohio plate goes by and two phones tap it. The server takes the first tap to arrive, and the second phone hears who beat it - never two winners.', btn: 'Tap Ohio', next: 'Next: your trips' },
    { view: 'trips', title: 'Every trip remembered', body: 'Trips stay on this phone, with a map of every plate you have ever seen across all of them. Sign in and they follow you to a second phone.', next: 'Next: the recap card' },
    { view: 'play', title: 'Share the recap', body: 'At the end of the drive, draw a card with the map, the scores and the best moment, and send it to the family chat - as a picture, never a link.', btn: 'Draw the recap card', next: 'Start our own game' },
  ];
  function startDemo() {
    state.demo = { doc: D.game(), trips: D.trips() };
    state.tour = 1; state.q = ''; state.sort = 'az';
    clearTimeout(pollTimer);
    go('play');
  }
  function leaveDemo(to) {
    state.demo = null; state.tour = 0; state.q = '';
    if (!state.prefs.tour) { state.prefs.tour = true; real.putPrefs(state.prefs); }
    go(to || (playing() ? 'play' : 'start'));
  }
  function tourStep(n) {
    if (n > TOUR.length) { leaveDemo('start'); return; }
    state.tour = n;
    go(TOUR[n - 1].view);
  }
  function tourDo(n) {
    if (n === 2) demoTap('VT');
    if (n === 3) demoTap('OH');
    if (n === 5) openRecap(playing().trip, 'example');
  }
  function guideHtml(view) {
    if (!state.demo) return '';
    var n = state.tour, s = TOUR[n - 1];
    if (!s || s.view !== view) return '<div class="guide" role="note"><div class="gt"><span class="gstep">Example · ' + esc(D.NAME) + '</span><span>Made up - every tap works, and nothing is kept.</span></div><button class="btn ghost small" type="button" data-act="tour" data-step="1">Take the tour</button></div>';
    return '<div class="guide" role="note"><div class="gt"><span class="gstep">' + esc('Example · step ' + n + ' of ' + TOUR.length) + '</span><b>' + esc(s.title) + '</b><span>' + esc(s.body) + '</span></div>' +
      '<div class="btns">' + (s.btn ? '<button class="btn ghost" type="button" data-act="tourdo" data-step="' + n + '">' + esc(s.btn) + '</button>' : '') + '<button class="btn" type="button" data-act="' + (n === TOUR.length ? 'tourdone' : 'tour') + '" data-step="' + (n + 1) + '">' + esc(s.next) + '</button></div></div>';
  }
  function demoRibbon() { return state.demo ? '<p class="ribbon">' + esc(D.NOTICE) + ' <button class="link-btn" type="button" data-act="leavedemo">Leave the example</button></p>' : ''; }
  function demoTap(code) {
    var r = D.tap(state.demo.doc, code, demoNow());
    state.demo.doc = r.doc;
    var st = C.stateOf(code);
    if (r.taken === 'you') toast('You already have ' + st.n + '.');
    else if (r.taken) toast(r.taken + ' spotted ' + st.n + ' first.', 3600);
    else toast('+' + C.pointsFor(code, 'rarity') + ' · ' + st.n + ' is yours!');
    keepPlace(draw);
  }

  /* ---------------- first run ---------------- */

  function heroMap() { var g = D.game(), v = C.gameView(g, D.YOU); return mapSvg(fillFrom(v.players, v.spots), 'A drawn map of the states, half filled in by four players'); }
  function startHtml() {
    var p = playing(), list = C.live(state.trips);
    var back = p && !state.demo ? '<div class="note back"><b>' + esc(p.kind === 'game' || p.kind === 'loading' ? 'A car game is on' : 'A trip is on') + '</b><span class="small muted">' + esc(p.view ? p.view.title + ' · ' + p.view.total.count + ' of 51 plates' : 'Loading…') + '</span><button class="btn" type="button" data-act="tab" data-tab="play">Back to the board</button></div>' : '';
    return '<section class="hero"><div class="hero-text"><h1>The license plate game for the whole car</h1><p>Every phone playing - first to spot a plate scores it, and rarer plates score more. A drawn map fills in as you go.</p>' +
      '<div class="btns"><button class="btn big" type="button" data-act="newgame">Start a car game</button><button class="btn big ghost onhero" type="button" data-act="joinsheet">Join with a code</button></div>' +
      '<p class="small herosub">Free, no sign-in. Thanksgiving week is the year’s biggest drive - make it a game.</p></div><div class="hero-map">' + heroMap() + '</div></section>' +
      back +
      '<div class="cards">' +
      '<div class="card"><h2>One phone, the whole car</h2><p class="muted">No signal, or only one phone? Play a trip on this phone - pass it round and tap who spotted each plate. Works offline.</p><button class="btn ghost" type="button" data-act="newtrip">Play on this phone</button></div>' +
      '<div class="card"><h2>See how it plays</h2><p class="muted">A made-up family on the drive to Gran’s: four phones, a live scoreboard and a race for Ohio.</p><button class="btn ghost" type="button" data-act="demo">Try the example</button></div>' +
      '<div class="card"><h2>How plates score</h2><p class="muted">' + tierLine() + '</p><button class="btn ghost" type="button" data-act="tab" data-tab="more">The whole rule</button></div>' +
      '</div>' + (list.length ? '<p class="center"><button class="btn ghost" type="button" data-act="tab" data-tab="trips">Your trips (' + list.length + ')</button></p>' : '') +
      '<p class="small muted center">No photos, no location, no accounts to play. Signing in only keeps your trip history on two phones.</p>';
  }
  function tierLine() {
    var count = [0, 0, 0, 0, 0]; C.STATES.forEach(function (s) { count[s.tier]++; });
    return C.TIERS.slice(1).map(function (t) { return t.name + ' ' + t.pts + (t.pts === 1 ? ' point' : ' points') + ' (' + count[t.id] + ')'; }).join(' · ') + '.';
  }

  /* ---------------- the board ---------------- */

  function playHtml() {
    var p = playing();
    if (!p) return startHtml();
    if (p.kind === 'loading') return '<p class="muted center" style="margin-top:40px">Loading the car game…</p>';
    var v = p.view, isGame = p.kind === 'game' || p.kind === 'demo';
    var head = '<div class="playhead"><div><h1>' + esc(v.title) + '</h1><p class="small muted">' + esc(v.total.count + ' of ' + v.total.of + ' plates · ' + plural(v.total.pts, 'point') + (v.scoring === 'flat' ? ' · every plate 1 point' : ' · rarer plates score more')) + '</p></div>' +
      (isGame ? '<button class="btn ghost codebtn" type="button" data-act="invite" aria-label="' + esc('Invite: code ' + C.formatCode(v.code)) + '"><span class="small muted">Code</span> <b>' + esc(C.formatCode(v.code)) + '</b></button>' : '') + '</div>';
    var off = p.kind === 'game' && state.game.offline ? '<p class="note warnline" role="status">You’re offline - this is the board as of ' + esc(clock(state.game.seenAt || Date.now())) + '. Taps need the network.</p>' : '';
    var canTap = !v.ended && !(p.kind === 'game' && state.game.offline);
    var controls;
    if (p.kind === 'trip') controls = '<div class="row wrapbtns"><button class="btn ghost small" type="button" data-act="addplayer">Add a player</button><button class="btn ghost small" type="button" data-act="recap">Recap card</button><button class="btn ghost small" type="button" data-act="endtrip">End the trip</button></div>';
    else controls = '<div class="row wrapbtns"><button class="btn ghost small" type="button" data-act="invite">Invite</button><button class="btn ghost small" type="button" data-act="recap">Recap card</button>' + (v.host ? '<button class="btn ghost small" type="button" data-act="players">Players</button><button class="btn ghost small" type="button" data-act="endgame">End the game</button>' : '<button class="btn ghost small" type="button" data-act="leavegame">Leave</button>') + '</div>';
    return guideHtml('play') + head + off +
      '<div class="dk-split playgrid"><div class="side">' +
      '<div class="card"><p class="headline" aria-live="polite">' + esc(v.headline) + '</p>' + boardRows(v.rows, v.players, v.ended) + controls + '</div>' +
      '<div class="card mapcard">' + mapSvg(fillFrom(v.players, v.spots), v.total.count + ' of 51 plates spotted, each in the colour of whoever spotted it') + '<p class="small muted center">' + esc(v.total.count ? 'Each tile in the colour of whoever spotted it.' : 'The map fills in as plates are spotted.') + '</p></div>' +
      '</div><div class="main">' + plateGrid(p, canTap) + '</div></div>';
  }

  /** A tap on a plate. Not spotted: spot it (a car game asks the server - the
   *  first tap to arrive wins). Spotted: who, and take it back if allowed. */
  function tapPlate(code) {
    var p = playing(); if (!p) return;
    var got = p.view.spots[code];
    if (got) return plateSheet(p, code);
    if (p.kind === 'demo') return demoTap(code);
    if (p.kind === 'trip') {
      if (p.trip.players.length === 1) return soloSpot(code, 0);
      return whoSheet(code);
    }
    if (state.busy[code]) return;
    state.busy[code] = true; drawSoft();
    api('POST', 'api/g/' + encodeURIComponent(state.now.game) + '/spots', { state: code }).then(function (r) {
      delete state.busy[code];
      toast('+' + r.pts + ' · ' + C.stateOf(code).n + ' is yours!');
      adoptView(r.game);
    }).catch(function (err) {
      delete state.busy[code];
      if (err.data && err.data.game) { toast(err.message, 3600); adoptView(err.data.game); return; }
      if (err.status === 404) return gameGone();
      showError(err); drawSoft();
    });
  }
  function soloSpot(code, p) {
    var id = state.now.trip;
    try { state.trips[id] = C.spot(state.trips[id], code, p, Date.now()); } catch (e) { showError(e); return; }
    saveTrips(); closeSheet(true);
    var t = state.trips[id];
    toast('+' + C.pointsFor(code, t.scoring) + ' · ' + C.stateOf(code).n + (t.players.length > 1 ? ' for ' + t.players[p].name : '') + '!');
    drawSoft();
  }
  function whoSheet(code) {
    var t = curTrip(), st = C.stateOf(code);
    sheet('<h2>Who spotted ' + esc(st.n) + '?</h2><p class="small muted">' + esc(C.TIERS[st.tier].name + ' · ' + plural(C.pointsFor(code, t.scoring), 'point')) + '</p><div class="who">' +
      t.players.map(function (pl, i) { return '<button class="btn ghost whobtn" type="button" data-act="who" data-st="' + code + '" data-p="' + i + '">' + dot(pl.c, pl.name) + '<span>' + esc(pl.name) + '</span></button>'; }).join('') + '</div>');
  }
  function plateSheet(p, code) {
    var v = p.view, s = v.spots[code], pl = v.players[s.p] || {}, st = C.stateOf(code);
    var canUndo = false;
    if (p.kind === 'trip') canUndo = !v.ended;
    else if (p.kind === 'demo') canUndo = pl.you;
    else canUndo = !v.ended && (v.host || (pl.you && Date.now() - s.t <= C.LIMITS.undoMinutes * 60000));
    sheet('<h2>' + esc(st.n) + '</h2><p>' + dot(pl.c, pl.name) + ' Spotted by <b>' + esc(pl.you ? 'you' : pl.name) + '</b>' + (s.t ? ' at ' + esc(clock(s.t)) : '') + ' · ' + esc(plural(C.pointsFor(code, v.scoring), 'point')) + '</p>' +
      '<p class="small muted">' + esc(C.TIERS[st.tier].name + ' plate.') + '</p>' +
      (canUndo ? '<button class="btn ghost block" type="button" data-act="unspot" data-st="' + code + '">' + (p.kind !== 'trip' && v.host && !pl.you ? 'Take it off the board' : 'Take it back - a mis-tap') + '</button>' : (p.kind === 'game' && !v.ended ? '<p class="small muted">Only whoever started the game can take it off the board' + (pl.you ? ' now - your own tap could be taken back for ' + C.LIMITS.undoMinutes + ' minutes' : '') + '.</p>' : '')));
  }
  function unspot(code) {
    var p = playing(); if (!p) return;
    closeSheet(true);
    if (p.kind === 'demo') { state.demo.doc = D.untap(state.demo.doc, code); keepPlace(draw); return; }
    if (p.kind === 'trip') { state.trips[state.now.trip] = C.unspot(p.trip, code, Date.now()); saveTrips(); drawSoft(); toast('Taken back.'); return; }
    api('DELETE', 'api/g/' + encodeURIComponent(state.now.game) + '/spots/' + encodeURIComponent(code)).then(function (r) { toast('Taken back.'); adoptView(r.game); }).catch(function (e) { showError(e); });
  }

  /* ---------------- starting, joining, inviting ---------------- */

  var SCORING_SEG = '<fieldset class="field"><legend>Scoring</legend><div class="seg" role="radiogroup"><label><input type="radio" name="scoring" value="rarity" checked> Rarer plates score more</label><label><input type="radio" name="scoring" value="flat"> Every plate 1 point</label></div></fieldset>';
  function newGameSheet() {
    sheet('<h2>Start a car game</h2><p class="small muted">Everyone in the car joins on their own phone with a code and a first name - no accounts, nothing to install. The game closes itself after a day with no new plates.</p>' +
      '<form id="newGameForm"><label class="field"><span>Your first name</span><input class="input" name="name" autocomplete="given-name" maxlength="20" required value="' + esc(state.prefs.name) + '"></label>' +
      '<label class="field"><span>The trip (optional)</span><input class="input" name="title" maxlength="40" placeholder="Over the river to Gran’s"></label>' + SCORING_SEG +
      '<div id="ngErr"></div><button class="btn block" type="submit">Start the game</button></form>');
  }
  function newTripSheet() {
    sheet('<h2>Play on this phone</h2><p class="small muted">Everything stays on this phone and works with no signal. Add everyone in the car and pass the phone - each plate asks who spotted it.</p>' +
      '<form id="newTripForm"><label class="field"><span>The trip</span><input class="input" name="title" maxlength="40" placeholder="Road trip"></label>' +
      '<label class="field"><span>Who’s playing? First names, with commas</span><input class="input" name="players" maxlength="200" placeholder="Junie, Theo, Rosa" value="' + esc(state.prefs.name) + '"></label>' + SCORING_SEG +
      '<div id="ntErr"></div><button class="btn block" type="submit">Start the trip</button></form>');
  }
  function joinSheet(code) {
    sheet('<h2>Join a car game</h2><p class="small muted">The code is at the top of the screen of whoever started it.</p>' +
      '<form id="joinForm"><label class="field"><span>Code</span><input class="input code" name="code" autocomplete="off" autocapitalize="characters" maxlength="8" required value="' + esc(code ? C.formatCode(code) : '') + '" data-act-input="peek"></label><div id="peek" class="small muted" aria-live="polite"></div>' +
      '<label class="field"><span>Your first name</span><input class="input" name="name" autocomplete="given-name" maxlength="20" required value="' + esc(state.prefs.name) + '"></label>' +
      '<div id="jErr"></div><button class="btn block" type="submit">Join</button></form>', function () { if (code) peek(code); });
  }
  var peekTimer = null;
  function peek(raw) {
    var code = C.normalizeCode(raw), out = $('#peek');
    clearTimeout(peekTimer);
    if (!out) return;
    if (!C.isCode(code)) { out.textContent = ''; return; }
    peekTimer = setTimeout(function () {
      api('GET', 'api/join/' + code).then(function (r) {
        if (!$('#peek')) return;
        $('#peek').textContent = r.ended ? 'That game is over.' : r.already ? 'You’re already in “' + r.title + '”.' : '“' + r.title + '”, started by ' + r.by + ' · ' + plural(r.players, 'player') + (r.full ? ' - full' : '');
      }).catch(function (e) { if ($('#peek')) $('#peek').textContent = e.message; });
    }, 250);
  }
  function invite() {
    var p = playing(); if (!p || !p.view.code) return;
    var link = location.origin + BASE + '#join=' + C.normalizeCode(p.view.code);
    sheet('<h2>Invite the car</h2><p class="muted">Everyone opens this page and taps Join with a code - or send them the link.</p><p class="bigcode" aria-label="' + esc('Code ' + p.view.code.split('').join(' ')) + '">' + esc(C.formatCode(p.view.code)) + '</p>' +
      (state.demo ? '<p class="small muted center">The example’s code joins nothing.</p>' : '<button class="btn block" type="button" data-act="sendlink" data-link="' + esc(link) + '">Send the link</button><p class="small muted center">The code travels after the # in the link, which is never sent to any server.</p>'));
  }
  function playersSheet() {
    var v = playing().view;
    sheet('<h2>Players</h2><ul class="plist">' + v.players.map(function (pl) {
      return '<li>' + dot(pl.c, pl.name) + '<span class="nm">' + esc(pl.name) + (pl.host ? ' <span class="small muted">(started it)</span>' : '') + (pl.left ? ' <span class="small muted">(left)</span>' : '') + '</span>' + (!pl.you && !state.demo ? '<button class="btn ghost small" type="button" data-act="kick" data-id="' + esc(pl.id) + '" data-name="' + esc(pl.name) + '">Remove</button>' : '') + '</li>';
    }).join('') + '</ul><p class="small muted">Removing someone opens their plates again - for a phone from the other car.</p>');
  }

  /* ---------------- trips ---------------- */

  function tripsHtml() {
    var list = C.live(trips()), life = C.lifetime(trips());
    return guideHtml('trips') + (state.mergeNote && !state.demo ? '<p class="note okline" role="status">' + esc(state.mergeNote) + ' <button class="link-btn" type="button" data-act="mergeok">OK</button></p>' : '') +
      '<h1>Your trips</h1>' +
      '<div class="dk-split"><div class="card"><h2>Every plate you’ve seen</h2><p class="muted">' + esc(life.count + ' of 51 across ' + plural(life.trips, 'trip')) + (life.count && life.missing.length && life.missing.length <= 8 ? ' · still to find: ' + esc(life.missing.map(function (c) { return C.stateOf(c).n; }).join(', ')) : '') + '</p>' +
      mapSvg(function (c) { return life.seen[c] ? 'seen' : null; }, life.count + ' of 51 plates seen across every trip') + '</div>' +
      '<div>' + (list.length ? '<ul class="trips">' + list.map(function (t) {
        var s = C.summary(t), on = !state.demo && state.now.trip === t.id && !t.ended;
        return '<li><button class="trow" type="button" data-act="opentrip" data-id="' + esc(t.id) + '">' + mapSvg(fillFrom(t.players, t.spots), '', true) + '<span class="tt"><b>' + esc(t.title) + '</b><span class="small muted">' + esc(day(t.started) + ' · ' + s.count + ' of 51 · ' + (t.players.length > 1 ? plural(t.players.length, 'player') : 'solo')) + '</span><span class="small">' + esc(on ? 'Playing now' : s.headline) + '</span></span></button></li>';
      }).join('') + '</ul>' : '<p class="muted">No trips yet. Start one - it is kept here when it ends.</p>') + '<p class="small" data-sync></p></div></div>';
  }
  function tripHtml() {
    var t = C.clone(trips()[state.tripId]); t.id = state.tripId;
    var s = C.summary(t), hl = C.highlights(t);
    var on = !state.demo && state.now.trip === t.id && !t.ended;
    return '<p><button class="btn ghost small" type="button" data-act="tab" data-tab="trips">‹ All trips</button></p><h1>' + esc(t.title) + '</h1><p class="small muted">' + esc(day(t.started) + ' · ' + s.count + ' of 51 plates · ' + plural(s.pts, 'point') + (t.scoring === 'flat' ? ' (every plate 1 point)' : '')) + '</p>' +
      '<div class="dk-split"><div class="card"><p class="headline">' + esc(s.headline) + '</p>' + boardRows(s.rows, t.players, Boolean(t.ended)) +
      (hl.length ? '<ul class="moments">' + hl.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="row wrapbtns">' + (on ? '<button class="btn small" type="button" data-act="tab" data-tab="play">Back to the board</button>' : '') + '<button class="btn small" type="button" data-act="recap">Recap card</button>' + (state.demo ? '' : '<button class="btn ghost small" type="button" data-act="rename">Rename</button><button class="btn ghost small" type="button" data-act="deltrip">Remove</button>') + '</div></div>' +
      '<div class="card">' + mapSvg(fillFrom(t.players, t.spots), s.count + ' of 51 plates on this trip') + '</div></div>';
  }

  /* ---------------- the recap card (drawn here, shared as a file) ---------------- */

  function drawRecap(canvas, trip) {
    var d = C.recapData(trip), W = 1080, H = 1350, x = canvas.getContext('2d');
    canvas.width = W; canvas.height = H;
    var g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#8f3209'); g.addColorStop(1, '#2a2f78');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    var font = function (w, s) { return w + ' ' + s + 'px -apple-system, "Segoe UI", Roboto, sans-serif'; };
    var fit = function (t, m) { return C.fitText(t, m, function (s) { return x.measureText(s).width; }); };
    x.fillStyle = '#ffffff'; x.textBaseline = 'alphabetic';
    x.font = font(600, 34); x.fillText('SPOTTED · ' + d.date.toUpperCase(), 72, 110);
    x.font = font(800, 72); x.fillText(fit(d.title, W - 144), 72, 196);
    x.font = font(500, 38); x.fillText(fit(d.headline, W - 144), 72, 258);
    // The map.
    var tile = 68, gap = 6, mx = (W - C.MAP_COLS * tile) / 2, my = 300;
    C.STATES.forEach(function (s) {
      var px = mx + s.x * tile + gap / 2, py = my + s.y * tile + gap / 2, k = tile - gap, on = Object.prototype.hasOwnProperty.call(d.spots, s.c);
      x.fillStyle = on ? C.COLORS[d.spots[s.c]] : 'rgba(255,255,255,0.16)';
      x.beginPath(); if (x.roundRect) x.roundRect(px, py, k, k, 12); else x.rect(px, py, k, k); x.fill();
      if (on) { x.strokeStyle = '#ffffff'; x.lineWidth = 3; x.stroke(); }
      x.fillStyle = on ? '#ffffff' : 'rgba(255,255,255,0.72)'; x.font = font(700, 22); x.textAlign = 'center'; x.fillText(s.c, px + k / 2, py + k / 2 + 8); x.textAlign = 'left';
    });
    var y = my + C.MAP_ROWS * tile + 50;
    x.font = font(600, 34); x.fillText(fit(d.line, W - 144), 72, y); y += 30;
    d.rows.forEach(function (r) {
      y += 60;
      x.fillStyle = C.COLORS[r.c]; x.beginPath(); x.arc(102, y - 12, 28, 0, Math.PI * 2); x.fill(); x.strokeStyle = '#ffffff'; x.lineWidth = 3; x.stroke();
      x.fillStyle = '#ffffff'; x.font = font(700, 24); x.textAlign = 'center'; x.fillText(r.initials, 102, y - 3); x.textAlign = 'left';
      x.font = font(r.rank === 1 ? 800 : 500, 38); x.fillText(fit(r.rank + '. ' + r.name, 620), 150, y);
      x.textAlign = 'right'; x.fillText(r.pts + ' pts · ' + r.count, W - 72, y); x.textAlign = 'left';
    });
    if (d.more) { y += 46; x.font = font(500, 30); x.fillText(d.more, 150, y); }
    if (d.moment) { x.font = font(500, 32); x.fillText(fit(d.moment, W - 144), 72, H - 92); }
    x.font = font(500, 28); x.globalAlpha = 0.85; x.fillText(fit(location.host + BASE, W - 144), 72, H - 44); x.globalAlpha = 1;
  }
  var recapBlob = null;
  function openRecap(trip, why) {
    recapBlob = null;
    sheet('<h2>Recap card</h2><p class="small muted">Drawn on this phone. Shared as a picture - never a link, never uploaded.' + (why === 'example' ? ' (This one is the made-up example.)' : '') + '</p><canvas id="recap" class="recap" role="img" aria-label="' + esc('Recap card: ' + trip.title + '. ' + C.summary(trip).headline) + '"></canvas>' +
      '<button class="btn block" type="button" data-act="sharecard">Share the card</button>', function (root) {
      var cv = $('#recap', root);
      try { drawRecap(cv, trip); cv.toBlob(function (b) { recapBlob = b; }, 'image/png'); } catch (e) { cv.replaceWith(document.createTextNode('This browser cannot draw the card.')); }
    });
    state.recapTitle = trip.title;
  }
  function shareCard() {
    if (!recapBlob) { toast('One moment - still drawing.'); return; }
    var name = 'spotted-' + (C.norm(state.recapTitle || 'trip').replace(/ /g, '-') || 'trip') + '.png';
    var file = null;
    try { file = new File([recapBlob], name, { type: 'image/png' }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: state.recapTitle || 'Spotted' }).catch(function (er) { if (!er || er.name !== 'AbortError') download(name); });
    } else download(name);
  }
  function download(name) {
    var url = URL.createObjectURL(recapBlob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Saved as a picture.');
  }

  /* ---------------- more ---------------- */

  function moreHtml() {
    var rows = C.TIERS.slice(1).map(function (t) {
      var st = C.STATES.filter(function (s) { return s.tier === t.id; }).map(function (s) { return s.n; }).sort();
      return '<li><b>' + esc(t.name + ' · ' + plural(t.pts, 'point')) + '</b><span class="small muted">' + esc(st.join(', ')) + '</span></li>';
    }).join('');
    return '<h1>How it works</h1><div class="dk-split"><div class="card"><h2>Rarer plates score more</h2><p class="muted">How often a plate turns up on an ordinary road trip follows how many cars a state has, which follows how many people live there. So the tiers are cut by population - the 14 biggest states are Everywhere, the smallest are Rare - with one exception: Alaska and Hawaii are Rare whatever their size, because nobody drives onto the mainland from either. A rough, fixed rule, not live data. The game’s starter can make every plate 1 point instead.</p><ul class="tiers">' + rows + '</ul></div>' +
      '<div><div class="card"><h2>Fair play</h2><ul class="small"><li>The first tap to reach the server scores a plate. The other phone hears who beat it.</li><li>A mis-tap can be taken back by its spotter for ' + C.LIMITS.undoMinutes + ' minutes; whoever started the game can take any plate off the board.</li><li>Plates only - no photos of anyone’s car, ever.</li></ul></div>' +
      '<div class="card"><h2>Your data</h2><p class="small muted">A trip on this phone stays on it. A car game holds only first names and which plates each person spotted, and is deleted a day after the last new plate. Your phone is recognised in a game by a random key the server keeps only as a scrambled fingerprint for that game. No location, no photos, no email to play.</p><p class="small" data-sync></p>' +
      '<button class="btn ghost block" type="button" data-act="wipe">Remove every trip from this phone</button></div></div></div>';
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    clearTimeout(toastTimer);
    $$('.toast').forEach(function (t) { t.remove(); });
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button><div class="body">' + html + '</div>';
    s.hidden = false; back.hidden = false; document.body.classList.add('sheet-open'); s.scrollTop = 0;
    var vb = document.getElementById('stc-verify-banner'), off = vb ? Math.max(0, vb.getBoundingClientRect().bottom) : 0;
    s.style.maxHeight = off ? 'calc(100vh - ' + Math.round(off + 8) + 'px)' : '';
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

  /* ---------------- the account (only for keeping trips on two phones) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }
  var FREE_LINE = 'Spotted is free with no account, and you never need one to play. A free account only keeps your trip history on two phones - and one account works across every app on this site.';
  function openAccount() {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2><p class="muted">' + esc(FREE_LINE) + '</p>' +
        '<form id="authForm"><label class="field"><span>Your email (for your account only)</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div><button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button" style="margin-top:10px">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center" style="margin-top:12px">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      $('#swap', root).addEventListener('click', function () { mode = mode === 'register' ? 'login' : 'register'; draw2(root); });
      $('#authForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); return syncIn(); }).then(function () { keepPlace(draw); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { return syncIn(); }).then(function () { keepPlace(draw); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('', draw2);
  }
  function openAccountSheet() {
    sheet('<h2>Account</h2><p class="small muted">' + esc(state.me.email) + '</p><p class="small" data-sync>' + syncLine() + '</p>' +
      '<button class="btn ghost block" id="forget" type="button">Remove my trips from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this phone</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>', function (root) {
      $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); keepPlace(draw); }); });
      $('#forget', root).addEventListener('click', function () {
        if (!confirm('Remove your trips from the account? This phone keeps its copy.')) return;
        api('DELETE', 'api/sync').then(function () { state.sync = { base: null, at: 0 }; real.putSync(state.sync); state.syncState = 'local'; closeSheet(); toast('Removed from the account. This phone still has them.'); }).catch(function (e) { showError(e); });
      });
      var pk = $('#pkEnrol', root);
      if (pk) pk.addEventListener('click', function () {
        var pw = prompt('Your password, to confirm it is you:');
        if (!pw) return;
        Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); }).catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
      });
    });
  }

  /* ---------------- wiring: one listener per kind of event ---------------- */

  function rememberName(n) { if (n && n !== state.prefs.name) { state.prefs.name = n; real.putPrefs(state.prefs); } }
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), st = el.getAttribute('data-st'), id = el.getAttribute('data-id');
    var p;
    switch (act) {
      case 'home': e.preventDefault(); go(playing() && !state.demo ? 'play' : 'start'); break;
      case 'tab': closeSheet(true); go(el.getAttribute('data-tab')); break;
      case 'demo': startDemo(); break;
      case 'leavedemo': leaveDemo(); break;
      case 'tour': tourStep(Number(el.getAttribute('data-step'))); break;
      case 'tourdo': tourDo(Number(el.getAttribute('data-step'))); break;
      case 'tourdone': leaveDemo('start'); newGameSheet(); break;
      case 'closesheet': closeSheet(); break;
      case 'signin': openAccount(); break;
      case 'newgame': if (state.demo) leaveDemo('start'); newGameSheet(); break;
      case 'newtrip': newTripSheet(); break;
      case 'joinsheet': joinSheet(''); break;
      case 'invite': invite(); break;
      case 'sendlink': (function () { var link = el.getAttribute('data-link'); if (navigator.share) navigator.share({ title: 'Join our car game', text: 'Join our license plate game: ', url: link }).catch(function () { /* fine */ }); else if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () { toast('Link copied.'); }); }()); break;
      case 'players': playersSheet(); break;
      case 'kick': (function () {
        if (!confirm('Remove ' + el.getAttribute('data-name') + '? Their plates open up again.')) return;
        api('DELETE', 'api/g/' + encodeURIComponent(state.now.game) + '/players/' + encodeURIComponent(id)).then(function (r) { closeSheet(true); adoptView(r.game); }).catch(function (er) { showError(er); });
      }()); break;
      case 'sort': state.sort = el.getAttribute('data-v'); drawSoft(); break;
      case 'plate': tapPlate(st); break;
      case 'who': soloSpot(st, Number(el.getAttribute('data-p'))); break;
      case 'unspot': unspot(st); break;
      case 'addplayer': sheet('<h2>Add a player</h2><form id="addForm"><label class="field"><span>First name</span><input class="input" name="name" maxlength="20" required></label><div id="apErr"></div><button class="btn block" type="submit">Add</button></form>'); break;
      case 'endtrip': (function () {
        if (!confirm('End this trip? The scores become final and it goes into your trips.')) return;
        var tid = state.now.trip; state.trips[tid] = C.endTrip(state.trips[tid], Date.now()); saveTrips(); setNow({}); state.tripId = tid; go('trip');
      }()); break;
      case 'endgame': (function () {
        if (state.demo) { toast('In a real game, every phone keeps the final scores.'); return; }
        if (!confirm('End the game for everyone? The scores become final and every phone keeps it in its trips.')) return;
        api('POST', 'api/g/' + encodeURIComponent(state.now.game) + '/end').then(function (r) { adoptView(r.game); }).catch(function (er) { showError(er); });
      }()); break;
      case 'leavegame': (function () {
        if (!confirm('Leave this game? Your plates stay on the board, and the trip so far stays on this phone.')) return;
        api('DELETE', 'api/g/' + encodeURIComponent(state.now.game) + '/me').then(function () { var tid = state.now.trip; if (state.trips[tid]) { state.trips[tid] = C.endTrip(state.trips[tid], Date.now()); saveTrips(); } setNow({}); state.game = null; state.tripId = tid; go(state.trips[tid] ? 'trip' : 'start'); }).catch(function (er) { showError(er); });
      }()); break;
      case 'recap': p = state.view === 'trip' ? (function () { var t = C.clone(trips()[state.tripId]); return t; }()) : (playing() || {}).trip; if (p) openRecap(p, state.demo ? 'example' : ''); break;
      case 'sharecard': shareCard(); break;
      case 'opentrip': state.tripId = id; go('trip'); break;
      case 'rename': sheet('<h2>Rename the trip</h2><form id="renameForm"><label class="field"><span>The trip</span><input class="input" name="title" maxlength="40" required value="' + esc(state.trips[state.tripId].title) + '"></label><div id="rnErr"></div><button class="btn block" type="submit">Save</button></form>'); break;
      case 'deltrip': (function () {
        if (!confirm('Remove this trip from this phone' + (signedIn() ? ' and your account' : '') + '?')) return;
        var tid = state.tripId; state.trips[tid] = { del: true, t: Date.now() }; saveTrips(); if (state.now.trip === tid) setNow({}); go('trips'); toast('Removed.');
      }()); break;
      case 'mergeok': state.mergeNote = ''; keepPlace(draw); break;
      case 'resync': state.sync = { base: null, at: 0 }; push(null); break;
      case 'retrysync': syncIn(); break;
      case 'wipe':
        if (!confirm('Remove every trip from this phone? (A car game you are in carries on.)')) return;
        var keep = state.now.game ? state.now : {};
        real.clearAll(); state.trips = {}; state.sync = S.cleanSync({}); setNow(keep); go('start'); toast('Removed from this phone.');
        break;
      default: break;
    }
  });
  function formErr(id, err) { var w = $('#' + id); if (w) showError(err, w); }
  document.addEventListener('submit', function (e) {
    var f = e.target, id = f && f.id;
    if (!id) return;
    e.preventDefault();
    var btn = $('button[type=submit]', f);
    if (id === 'newGameForm') {
      var name = C.cleanName(f.elements.name.value), why = C.refuse(f.elements.title.value);
      if (!name) return formErr('ngErr', new Error('Type your first name - letters only.'));
      if (why) return formErr('ngErr', new Error(why));
      btn.disabled = true;
      api('POST', 'api/games', { name: name, title: f.elements.title.value, scoring: f.elements.scoring.value }).then(function (r) { rememberName(name); closeSheet(true); enterGame(r.id, r.game); invite(); })
        .catch(function (er) { btn.disabled = false; formErr('ngErr', er); });
    } else if (id === 'newTripForm') {
      var names = String(f.elements.players.value).split(/[,\n]+/).map(C.cleanName).filter(Boolean), w2 = C.refuse(f.elements.title.value);
      if (w2) return formErr('ntErr', new Error(w2));
      if (names.length > C.LIMITS.players) return formErr('ntErr', new Error('Up to ' + C.LIMITS.players + ' players.'));
      var tid = 't' + rid(10);
      state.trips[tid] = C.newTrip({ title: f.elements.title.value, players: names, scoring: f.elements.scoring.value }, Date.now());
      if (names.length === 1) rememberName(names[0]);
      saveTrips(); setNow({ trip: tid }); closeSheet(true); go('play');
    } else if (id === 'joinForm') {
      var code = C.normalizeCode(f.elements.code.value), nm = C.cleanName(f.elements.name.value);
      if (!C.isCode(code)) return formErr('jErr', new Error('A code is six letters and numbers, like ' + C.formatCode('KXR7PD') + '.'));
      if (!nm) return formErr('jErr', new Error('Type your first name - letters only.'));
      btn.disabled = true;
      api('POST', 'api/join/' + code, { name: nm }).then(function (r) {
        rememberName(nm); closeSheet(true);
        if (state.demo) { state.demo = null; state.tour = 0; }
        if (state.now.game === r.id) { go('play'); return; }
        enterGame(r.id, null);
      }).catch(function (er) { btn.disabled = false; formErr('jErr', er); });
    } else if (id === 'addForm') {
      try { state.trips[state.now.trip] = C.addPlayer(curTrip(), f.elements.name.value, Date.now()); } catch (er) { return formErr('apErr', er); }
      saveTrips(); closeSheet(true); drawSoft();
    } else if (id === 'renameForm') {
      try { state.trips[state.tripId] = C.renameTrip(state.trips[state.tripId], f.elements.title.value, Date.now()); } catch (er) { return formErr('rnErr', er); }
      saveTrips(); closeSheet(true); keepPlace(draw);
    } else if (id === 'authForm') { /* its own listener */ }
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var a = t.getAttribute('data-act-input');
    if (a === 'q') { state.q = t.value; drawSoft(); }
    if (a === 'peek') peek(t.value);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  window.addEventListener('popstate', function () { route(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') { clearTimeout(pollTimer); return; }
    schedulePoll(0);
    if (signedIn()) syncIn();
  });
  window.addEventListener('online', function () { schedulePoll(0); });

  /* ---------------- start ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill) pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  state.trips = real.getTrips(); state.now = real.getNow(); state.prefs = real.getPrefs(); state.sync = real.getSync();
  if (state.now.trip && !state.trips[state.now.trip]) setNow(state.now.game ? { trip: state.now.trip, game: state.now.game } : {});
  if (!real.persistent()) setTimeout(function () { toast('This browser is not keeping anything - trips last until the tab closes.', 5000); }, 600);
  var join = /^#join=([A-Za-z0-9-]{4,12})$/.exec(location.hash || '');
  if (join) history.replaceState(null, '', BASE);
  drawTop();
  route();
  if (state.now.game) schedulePoll(0);
  if (join) joinSheet(C.normalizeCode(join[1]));
  loadMe().then(function () { if (signedIn()) syncIn(); });
}());
