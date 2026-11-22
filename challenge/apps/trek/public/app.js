/* Trek - the page. One file, no build step.
 *
 * A TREK ON THIS PHONE NEVER LEAVES IT. The routes, the conversion, the
 * leaderboard, streaks, postcards, the trek history and the recap card are
 * worked out by TrekCore and kept through trek-store.js (localStorage, with
 * a memory fallback). The made-up example is never kept, sent or synced.
 *
 * The requests this page makes: a crew (start, join with a code and a first
 * name, log, take a log back, poll every 4 seconds while the page is
 * visible and the crew is on screen, next route, leave, remove, delete),
 * sign-in, and the account's copy of the trek history (signed in, to keep
 * two phones in step). No location, no GPS, no health data: people type
 * what they did.
 *
 * Every string a person typed or the server sent is escaped before it is
 * drawn, and no handler is written into markup: clicks are routed by
 * data-act from one listener (the lab's CSP allows script from this origin
 * only).
 */
(function () {
  'use strict';

  var C = window.TrekCore;
  var D = window.TrekDemo;
  var S = window.TrekStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var POLL_MS = 4000;

  var real = S.local();
  var state = {
    me: null, view: 'start', treks: {}, now: {}, prefs: S.cleanPrefs({}), sync: S.cleanSync({}), syncState: 'local', syncErr: '',
    crew: null,          // {id, view, offline, seenAt} for a live crew
    demo: null,          // {doc, treks, n} while the example runs
    tour: 0, trekId: null, busy: false, mergeNote: '',
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
  function day(ms) { try { return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return new Date(ms).toISOString().slice(0, 10); } }
  function clock(ms) { try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return new Date(ms).toISOString().slice(11, 16); } }
  /** This phone's own date - or the example's fixed Sunday. */
  function today() { return state.demo ? D.TODAY : C.localDay(Date.now(), new Date().getTimezoneOffset()); }
  function now() { return state.demo ? D.NOON : Date.now(); }
  function unit() { return state.prefs.unit; }
  function dist(m) { return C.dist(m, unit()); }
  function dayLabel(d) { var t = today(); if (d === t) return 'Today'; if (d === C.addDays(t, -1)) return 'Yesterday'; return C.weekday(d) + ' ' + Number(d.slice(8)); }

  /* ---------------- what is on the go ---------------- */

  function saveTreks() { real.putTreks(state.treks); pushSoon(); }
  function treks() { return state.demo ? state.demo.treks : state.treks; }
  function curTrek() { var id = state.now.trek; return !state.demo && id && state.treks[id] && !state.treks[id].del ? state.treks[id] : null; }
  function setNow(n) { state.now = S.cleanNow(n); real.putNow(state.now); }
  function soloFeed(t) {
    return Object.keys(t.logs).map(function (k) { var l = t.logs[k], m = 0; try { m = C.toTrail(l.kind, l.unit, l.amt); } catch (e) { m = 0; } return { id: k, p: l.p, day: l.day, kind: l.kind, unit: l.unit, amt: l.amt, m: m, at: l.t }; })
      .sort(function (a, b) { return b.at - a.at || (a.id < b.id ? 1 : -1); }).slice(0, C.LIMITS.feed);
  }
  /** The journey on screen: {kind: 'demo'|'crew'|'solo'|'loading', view, trek}. */
  function playing() {
    if (state.demo) { var v = C.crewView(state.demo.doc, D.YOU); return { kind: 'demo', view: v, trek: C.trekFromCrew(v, null, D.NOON) }; }
    if (state.now.crew && state.crew && state.crew.view) return { kind: 'crew', view: state.crew.view, trek: curTrek() };
    var t = curTrek();
    if (t && !state.now.crew) {
      return { kind: 'solo', trek: t, view: { title: t.title, route: t.route, players: t.players.map(function (p, i) { return { name: p.name, c: p.c, since: p.since, p: i, you: false }; }), days: C.trekDays(t), feed: soloFeed(t), past: [], you: -1, host: true } };
    }
    if (state.now.crew) return { kind: 'loading' };
    return null;
  }

  /* ---------------- the crew: polling ---------------- */

  var pollTimer = null;
  function wantPoll() { return Boolean(state.now.crew && !state.demo && document.visibilityState === 'visible' && (state.view === 'play' || state.view === 'start')); }
  function schedulePoll(ms) { clearTimeout(pollTimer); if (wantPoll()) pollTimer = setTimeout(poll, ms === undefined ? POLL_MS : ms); }
  function poll() {
    if (!wantPoll()) return;
    var g = state.crew || {};
    var since = g.view ? '?since=' + encodeURIComponent(g.view.v) : '';
    api('GET', 'api/c/' + encodeURIComponent(state.now.crew) + since).then(function (r) {
      var wasOff = g.offline;
      state.crew = state.crew || { id: state.now.crew };
      state.crew.offline = false; state.crew.seenAt = Date.now();
      if (r.crew) adoptView(r.crew);
      else if (wasOff) drawSoft();
      schedulePoll();
    }).catch(function (err) {
      if (err.status === 404) return crewGone();
      state.crew = state.crew || { id: state.now.crew };
      if (!state.crew.offline) { state.crew.offline = true; drawSoft(); }
      schedulePoll(POLL_MS * 2);
    });
  }
  /** A fresh view of the crew: drawn, and copied into this phone's history
   *  as it stands (so a crew that closes after a quiet month is still
   *  remembered). A new leg starts a new trek in the history. */
  function adoptView(v) {
    state.crew = state.crew || { id: state.now.crew };
    var prev = state.crew.view;
    state.crew.view = v;
    var tid = state.now.trek, before = state.treks[tid];
    if (before && !before.del && before.leg !== (v.past || []).length) {
      state.treks[tid] = C.endTrek(before, Date.now());
      tid = 'c' + rid(10); setNow({ trek: tid, crew: state.now.crew }); before = null;
    }
    state.treks[tid] = C.trekFromCrew(v, before && !before.del ? before : null, Date.now());
    saveTreks();
    if (prev && v.you < 0) return crewGone();
    if (prev) {
      v.feed.forEach(function (l) { if (!prev.feed.some(function (x) { return x.id === l.id; }) && v.players[l.p] && !v.players[l.p].you && l.at > (prev.feed[0] ? prev.feed[0].at : 0)) say(C.logText(v.players[l.p].name, l) + '.'); });
    }
    drawSoft();
  }
  function crewGone() {
    var tid = state.now.trek;
    if (state.treks[tid] && !state.treks[tid].del && !state.treks[tid].ended) { state.treks[tid] = C.endTrek(state.treks[tid], Date.now()); saveTreks(); }
    setNow({}); state.crew = null;
    toast('That crew has closed. What you saw is in your treks.', 4200);
    state.trekId = state.treks[tid] ? tid : null;
    go(state.trekId ? 'trek' : 'start');
  }
  function enterCrew(id, view) {
    var tid = 'c' + rid(10);
    setNow({ trek: tid, crew: id });
    state.crew = { id: id, view: null };
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
    return api('PUT', 'api/sync', { data: C.cleanTreks(state.treks).treks, base: base !== undefined ? base : state.sync.base }).then(function (out) {
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
  /** The account's copy came back different: merge it (each trek by its own
   *  time), keep the result here, and save it against the account's version. */
  function mergeIn(acc, at) {
    var m = C.mergeTreks(state.treks, C.cleanTreks(acc).treks);
    state.treks = m.treks; real.putTreks(state.treks);
    if (m.pulled) { state.mergeNote = 'From your other phone: ' + plural(m.pulled, 'trek') + '.'; if (state.view === 'treks' || state.view === 'start') keepPlace(draw); }
    if (C.same(state.treks, acc)) { state.sync = { base: at, at: Date.now() }; real.putSync(state.sync); state.syncState = 'synced'; drawSync(); return null; }
    return push(at);
  }
  function syncIn() {
    if (!signedIn() || !state.me.sync || state.demo) return Promise.resolve();
    return api('GET', 'api/sync').then(function (out) {
      if (!out.data) {
        if (!Object.keys(state.treks).length) { state.syncState = 'synced'; drawSync(); return null; }
        if (state.sync.base === null) return push(null);
        state.sync = { base: null, at: 0 }; real.putSync(state.sync); state.syncState = 'removed'; drawSync(); return null;
      }
      if (state.sync.base === out.updatedAt && C.same(state.treks, out.data)) { state.syncState = 'synced'; drawSync(); return null; }
      return mergeIn(out.data, out.updatedAt);
    }).catch(function () { state.syncState = 'error'; drawSync(); });
  }
  function syncLine() {
    if (state.demo) return '<span class="small muted">The example is never saved, sent or synced.</span>';
    if (!signedIn()) return '<span class="small muted">Treks stay on this phone · <button class="link-btn" type="button" data-act="signin">sign in to keep two phones in step</button></span>';
    if (state.me && !state.me.sync) return '<span class="small muted">Keeping treks in the account is unavailable right now - they are on this phone.</span>';
    if (state.syncState === 'syncing') return '<span class="small muted">Saving to your account…</span>';
    if (state.syncState === 'removed') return '<span class="small warnline">Removed from your account on another phone - kept here. <button class="link-btn" type="button" data-act="resync">Keep them in the account again</button></span>';
    if (state.syncState === 'error') return '<span class="small err">Couldn’t reach your account' + (state.syncErr ? ': ' + esc(state.syncErr) : '') + ' <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="small okline">✓ Treks in step with your account</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }

  /* ---------------- drawing pieces ---------------- */

  /** The route, drawn: the whole line dashed, the part walked solid, the
   *  checkpoints as dots (filled once reached) and the crew as one marker.
   *  Stylised from a few points in TrekCore - no map data. */
  /** The box a route is drawn in: its line and peaks with room round them,
   *  kept between a wide strip and a near square so no route is a sliver. */
  function routeBox(r) {
    var xs = r.pts.concat(r.peaks).map(function (p) { return p[0]; }), ys = r.pts.concat(r.peaks).map(function (p) { return p[1]; });
    var x0 = Math.min.apply(null, xs) - 70, x1 = Math.max.apply(null, xs) + 70, y0 = Math.min.apply(null, ys) - 110, y1 = Math.max.apply(null, ys) + 110;
    var w = x1 - x0, h = y1 - y0;
    if (h < w * 0.45) { y0 -= (w * 0.45 - h) / 2; h = w * 0.45; }
    if (h > w * 0.9) { x0 -= (h / 0.9 - w) / 2; w = h / 0.9; }
    return { x: Math.round(x0), y: Math.round(y0), w: Math.round(w), h: Math.round(h) };
  }
  /** The route, drawn: the whole line dashed, the part walked solid, the
   *  checkpoints as dots (filled once reached) and the crew as one marker.
   *  Stylised from a few points in TrekCore - no map data. */
  function routeSvg(routeId, frac, label, mini) {
    var r = C.routeOf(routeId), pts = r.pts, bx = routeBox(r), k = bx.w / 1000;
    var all = pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
    var at = C.pointAt(r, frac), done = pts.slice(0, at[2] + 1).concat([[at[0], at[1]]]).map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
    var peaks = r.peaks.map(function (p) { return '<path class="peak" d="M' + (p[0] - 34) + ' ' + (p[1] + 26) + 'L' + p[0] + ' ' + (p[1] - 26) + 'L' + (p[0] + 34) + ' ' + (p[1] + 26) + 'z"/>'; }).join('');
    var checks = mini ? '' : r.checkpoints.map(function (c) { var q = C.pointAt(r, c.f), on = frac >= c.f - 1e-9; return '<circle class="cp' + (on ? ' on' : '') + '" cx="' + q[0] + '" cy="' + q[1] + '" r="' + (c.f === 1 ? 15 : 11) + '"/>'; }).join('');
    var ends = mini ? '' : endLabel(pts[0], r.from, 'start', bx) + endLabel(pts[pts.length - 1], r.to, 'end', bx);
    return '<svg class="route' + (mini ? ' mini' : '') + '" viewBox="' + [bx.x, bx.y, bx.w, bx.h].join(' ') + '" role="img" aria-label="' + esc(label) + '">' +
      '<rect class="land" x="' + (bx.x + 4) + '" y="' + (bx.y + 4) + '" width="' + (bx.w - 8) + '" height="' + (bx.h - 8) + '" rx="' + Math.round(36 * k) + '"/>' + peaks +
      '<polyline class="path" points="' + all + '"/><polyline class="walked" points="' + done + '"/>' + checks + ends +
      '<circle class="crew" cx="' + at[0] + '" cy="' + at[1] + '" r="' + (mini ? 26 : 20) + '"/></svg>';
  }
  /** A start or end name, anchored inward so it never runs off the box. */
  function endLabel(p, text, which, bx) {
    var t = String(text).split(',')[0], left = p[0] < bx.x + bx.w / 2, fs = Math.round(bx.w * 0.034);
    // The start's name below the line, the end's above, so neither sits on the crew's marker at the ends.
    var below = which === 'start', y = below ? p[1] + fs * 2.3 : p[1] - fs * 1.2;
    return '<text class="endlbl" x="' + (left ? Math.max(bx.x + 16, p[0] - 30) : Math.min(bx.x + bx.w - 16, p[0] + 30)) + '" y="' + Math.round(y) + '" font-size="' + fs + '" text-anchor="' + (left ? 'start' : 'end') + '">' + esc(t) + '</text>';
  }
  function fromTo(r) { return [r.from, r.to].join(' to '); }
  function dot(c, name) { return '<span class="dot bg' + esc(c % C.COLORS.length) + '" aria-hidden="true">' + esc(C.initials(name)) + '</span>'; }
  function boardRows(rows, players, ended) {
    return '<ol class="score">' + rows.map(function (r) {
      var pl = players[r.p] || {};
      var crown = r.rank === 1 && r.pts > 0 ? '<span class="lead">' + (ended ? 'Top' : 'Leads') + '</span>' : '';
      var sub = plural(r.active, 'day') + ' out · ' + dist(r.m) + (r.streak > 0 ? ' · streak ' + plural(r.streak, 'week') : '') + (r.thisWeek >= C.GOAL_DAYS ? ' · week made' : r.thisWeek ? ' · ' + r.thisWeek + ' of ' + C.GOAL_DAYS + ' this week' : '');
      return '<li' + (pl.you ? ' class="you"' : '') + '><span class="rk">' + esc(r.rank) + '</span>' + dot(r.c, r.name) + '<span class="nm"><b>' + esc(r.name) + '</b>' + (pl.you ? ' <span class="muted small">(you)</span>' : '') + (r.left ? ' <span class="muted small">(left)</span>' : '') + crown + '<span class="sub small muted">' + esc(sub) + '</span></span><b class="pts">' + esc(r.pts) + '<span class="vh"> points</span></b></li>';
    }).join('') + '</ol>';
  }
  function progressLine(pr, routeId) {
    var r = C.routeOf(routeId);
    return '<p class="prog"><b>' + esc(dist(pr.m)) + '</b> of ' + esc(dist(pr.of)) + ' · ' + esc(Math.floor(pr.frac * 100)) + '%</p>' +
      '<div class="bar" role="progressbar" aria-label="Along the route" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + esc(Math.floor(pr.frac * 100)) + '"><span style="width:' + esc((pr.frac * 100).toFixed(1)) + '%"></span></div>' +
      '<p class="small muted">' + esc(pr.done ? 'Finished: ' + fromTo(r) + '!' : pr.next ? dist(pr.next.toGo) + ' to the next postcard: ' + pr.next.name : '') + '</p>';
  }
  function postcardsHtml(routeId, reached) {
    var r = C.routeOf(routeId);
    return '<div class="cards4">' + r.checkpoints.map(function (c) {
      var on = reached.indexOf(c.i) >= 0;
      return '<button type="button" class="pc' + (on ? ' on' : '') + '" data-act="postcard" data-i="' + c.i + '"' + (on ? '' : ' disabled') + ' aria-label="' + esc(on ? 'Postcard: ' + c.name : 'Postcard ' + (c.i + 1) + ', not reached yet') + '"><span class="pcn">' + esc(c.i + 1) + '</span><span class="pct">' + esc(on ? c.name : 'At ' + dist(c.at)) + '</span></button>';
    }).join('') + '</div>';
  }
  function feedHtml(pv) {
    var v = pv.view, feed = v.feed.slice(0, 12);
    if (!feed.length) return '<p class="muted">Nothing logged yet. The first walk moves everyone.</p>';
    return '<ul class="feed">' + feed.map(function (l) {
      var pl = v.players[l.p] || { name: 'Someone', c: 0 };
      var can = pv.kind === 'solo' || (pv.kind === 'demo' ? pl.you : (pl.you || v.host));
      return '<li>' + dot(pl.c, pl.name) + '<span class="ft"><span>' + esc(C.logText(pl.you ? 'You' : pl.name, l)) + '</span><span class="small muted">' + esc(dayLabel(l.day) + ' · +' + dist(l.m)) + '</span></span>' + (can ? '<button class="btn ghost small" type="button" data-act="unlog" data-id="' + esc(l.id) + '" aria-label="' + esc('Take back: ' + C.logText(pl.name, l)) + '">Undo</button>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  /* ---------------- navigation ---------------- */

  var VIEWS = ['start', 'play', 'treks', 'trek', 'more'];
  function go(view) { history.pushState(null, '', BASE + '#' + view); route(); scrollTo(0, 0); }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    var v = VIEWS.indexOf(h) >= 0 ? h : 'start';
    if (v === 'play' && !playing()) v = 'start';
    if (v === 'trek' && !(state.trekId && treks()[state.trekId] && !treks()[state.trekId].del)) v = 'treks';
    if (v === 'start' && h === '' && playing() && !state.demo) v = 'play';
    state.view = v;
    draw();
    schedulePoll(0);
  }
  var drawing = false;
  function draw() { if (drawing) { setTimeout(draw, 0); return; } drawing = true; try { drawNow(); } finally { drawing = false; } }
  function drawSoft() { if (state.view !== 'play' && state.view !== 'start') return; keepPlace(draw); }
  function drawNow() {
    var main = $('#main'), tb = $('#tabbar');
    var any = Boolean(playing()) || C.live(treks()).length > 0;
    tb.hidden = state.view === 'start' && !any;
    var tab = state.view === 'trek' ? 'treks' : state.view === 'start' ? (playing() ? '' : 'play') : state.view;
    $$('#tabbar [data-tab]').forEach(function (x) { if (x.getAttribute('data-tab') === tab) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
    var v = state.view, html;
    if (v === 'play') html = playHtml();
    else if (v === 'treks') html = treksHtml();
    else if (v === 'trek') html = trekHtml();
    else if (v === 'more') html = moreHtml();
    else html = startHtml();
    main.innerHTML = demoRibbon() + html;
    document.body.classList.toggle('in-demo', Boolean(state.demo));
    drawSync();
  }

  /* ---------------- the example and its tour ---------------- */

  var TOUR = [
    { view: 'play', title: 'One crew, one line on the map', body: 'Five coworkers joined the Lunch Loop with a code and a first name - no accounts. Every walk, run, ride and swim moves the whole crew along the Camino together.', next: 'Next: log a walk' },
    { view: 'play', title: 'Log what you did - the crew moves', body: 'Minutes or distance, walk, run, ride, swim or roll, turned into one fair trail distance. The crew is 1.9 km short of halfway.', btn: 'Log a 30-minute walk', next: 'Next: the leaderboard' },
    { view: 'play', title: 'Showing up beats distance', body: 'Points are 10 for every day out, 1 per km (up to 25 a day) and 15 for every week with 3 days out. Priya walks a little nearly every day and leads; Tomas rode furthest on weekends and is fourth.', next: 'Next: your treks' },
    { view: 'treks', title: 'Every trek remembered', body: 'Treks stay on this phone - crews and solo ones - with every route you have finished. Sign in and they follow you to a second phone.', next: 'Next: the recap card' },
    { view: 'play', title: 'Share the recap', body: 'Draw a card with the route, how far the crew has come and the leaderboard, and send it to the group chat - as a picture, never a link.', btn: 'Draw the recap card', next: 'Start our own crew' },
  ];
  function startDemo() {
    state.demo = { doc: D.crew(), treks: D.treks(), n: 0 };
    state.tour = 1;
    clearTimeout(pollTimer);
    go('play');
  }
  function leaveDemo(to) {
    state.demo = null; state.tour = 0;
    if (!state.prefs.tour) { state.prefs.tour = true; real.putPrefs(state.prefs); }
    go(to || (playing() ? 'play' : 'start'));
  }
  function tourStep(n) { if (n > TOUR.length) { leaveDemo('start'); return; } state.tour = n; go(TOUR[n - 1].view); }
  function tourDo(n) {
    if (n === 2) demoLog({ kind: 'walk', unit: 'min', amt: 30, day: D.TODAY });
    if (n === 5) openRecap(playing().trek, 'example');
  }
  function guideHtml(view) {
    if (!state.demo) return '';
    var n = state.tour, s = TOUR[n - 1];
    if (!s || s.view !== view) return '<div class="guide" role="note"><div class="gt"><span class="gstep">Example · ' + esc(D.NAME) + '</span><span>Made up - every tap works, and nothing is kept.</span></div><button class="btn ghost small" type="button" data-act="tour" data-step="1">Take the tour</button></div>';
    return '<div class="guide" role="note"><div class="gt"><span class="gstep">' + esc('Example · step ' + n + ' of ' + TOUR.length) + '</span><b>' + esc(s.title) + '</b><span>' + esc(s.body) + '</span></div>' +
      '<div class="btns">' + (s.btn ? '<button class="btn ghost" type="button" data-act="tourdo" data-step="' + n + '">' + esc(s.btn) + '</button>' : '') + '<button class="btn" type="button" data-act="' + (n === TOUR.length ? 'tourdone' : 'tour') + '" data-step="' + (n + 1) + '">' + esc(s.next) + '</button></div></div>';
  }
  function demoRibbon() { return state.demo ? '<p class="ribbon">' + esc(D.NOTICE) + ' <button class="link-btn" type="button" data-act="leavedemo">Leave the example</button></p>' : ''; }
  function demoLog(o) {
    state.demo.n += 1;
    var r = D.log(state.demo.doc, state.demo.n, o);
    state.demo.doc = r.doc;
    closeSheet(true);
    keepPlace(draw);
    afterLog(r.m, r.crossed, C.routeOf(r.doc.route));
  }
  function afterLog(m, crossed, r) {
    if (crossed && crossed.length) postcard(r.id, crossed[crossed.length - 1], true);
    else toast('+' + dist(m) + ' for the crew');
  }

  /* ---------------- first run ---------------- */

  function startHtml() {
    var p = playing(), list = C.live(state.treks);
    var back = p && !state.demo ? '<div class="note back"><b>' + esc(p.kind === 'solo' ? 'A trek is on' : 'Your crew is on the trail') + '</b><span class="small muted">' + esc(p.view ? p.view.title + ' · ' + C.routeOf(p.view.route).name : 'Loading…') + '</span><button class="btn" type="button" data-act="tab" data-tab="play">Back to the journey</button></div>' : '';
    var dv = C.crewView(D.crew(), D.YOU), dp = C.progress(dv.route, dv.days);
    return '<section class="hero"><div class="hero-text"><h1>A journey for your whole crew</h1><p>Every walk, run, ride and swim moves you all along a famous trail together. Pass checkpoints, collect postcards, and keep a streak going - showing up counts as much as distance.</p>' +
      '<div class="btns"><button class="btn big" type="button" data-act="newcrew">Start a crew</button><button class="btn big ghost onhero" type="button" data-act="joinsheet">Join with a code</button></div>' +
      '<p class="small herosub">Free, no sign-in, no location tracking. Friends, families, coworkers, walking groups.</p></div><div class="hero-map">' + routeSvg(dv.route, dp.frac, 'A drawn route with a crew halfway along it') + '</div></section>' +
      back +
      '<div class="cards">' +
      '<div class="card"><h2>Just me, on this phone</h2><p class="muted">Walk a route on your own - or with the family on one phone. Nothing leaves the phone and it works offline.</p><button class="btn ghost" type="button" data-act="newsolo">Start on this phone</button></div>' +
      '<div class="card"><h2>See how it plays</h2><p class="muted">A made-up crew of coworkers five weeks into the Camino, just short of halfway.</p><button class="btn ghost" type="button" data-act="demo">Try the example</button></div>' +
      '<div class="card"><h2>Fair for every way of moving</h2><p class="muted">A km walked or run is a trail km; a ride counts a third, a swim four times. Minutes work too.</p><button class="btn ghost" type="button" data-act="tab" data-tab="more">The whole rule</button></div>' +
      '</div>' + (list.length ? '<p class="center"><button class="btn ghost" type="button" data-act="tab" data-tab="treks">Your treks (' + list.length + ')</button></p>' : '') +
      '<p class="small muted center">No GPS, no health data, no accounts to play. You type what you did. Signing in only keeps your trek history on two phones.</p>';
  }

  /* ---------------- the journey ---------------- */

  function playHtml() {
    var p = playing();
    if (!p) return startHtml();
    if (p.kind === 'loading') return '<p class="muted center loading">Loading the crew…</p>';
    var v = p.view, r = C.routeOf(v.route), t = today();
    var pr = C.progress(v.route, v.days), rows = C.standings(v.players, v.days, t), crewWeeks = C.crewStreak(v.players, v.days, t);
    var isCrew = p.kind !== 'solo';
    var head = '<div class="playhead"><div><h1>' + esc(v.title) + '</h1><p class="small muted">' + esc(r.name + ' · ' + fromTo(r)) + '</p></div>' +
      (isCrew ? '<button class="btn ghost codebtn" type="button" data-act="invite" aria-label="' + esc('Invite: code ' + C.formatCode(v.code)) + '"><span class="small muted">Code</span> <b>' + esc(C.formatCode(v.code)) + '</b></button>' : '') + '</div>';
    var off = p.kind === 'crew' && state.crew.offline ? '<p class="note warnline" role="status">You’re offline - this is the crew as of ' + esc(clock(state.crew.seenAt || Date.now())) + '. Logging needs the network.</p>' : '';
    var canLog = !(p.kind === 'crew' && state.crew.offline);
    var controls = '<div class="row wrapbtns">' + (isCrew ? '<button class="btn ghost small" type="button" data-act="invite">Invite</button>' : '<button class="btn ghost small" type="button" data-act="addperson">Add someone</button>') + '<button class="btn ghost small" type="button" data-act="recap">Recap card</button>' +
      (p.kind !== 'solo' && v.host && (pr.done || !v.feed.length) ? '<button class="btn ghost small" type="button" data-act="nextroute">' + (pr.done ? 'Next route' : 'Change route') + '</button>' : '') +
      (p.kind === 'crew' ? (v.host ? '<button class="btn ghost small" type="button" data-act="members">Members</button><button class="btn ghost small" type="button" data-act="delcrew">Delete the crew</button>' : '<button class="btn ghost small" type="button" data-act="leavecrew">Leave</button>') : '') +
      (p.kind === 'solo' ? '<button class="btn ghost small" type="button" data-act="endtrek">End the trek</button>' : '') + '</div>';
    return guideHtml('play') + head + off +
      '<div class="dk-split playgrid"><div class="side">' +
      '<div class="card mapcard">' + routeSvg(v.route, pr.frac, r.name + ': ' + Math.floor(pr.frac * 100) + '% of the way') + progressLine(pr, v.route) +
      '<button class="btn big block" type="button" data-act="logsheet"' + (canLog ? '' : ' disabled') + '>+ Log a walk, run, ride or swim</button>' +
      (pr.done ? '<p class="okline center">🎉 The whole route, done together.</p>' : '') + '</div>' +
      '<div class="card"><h2>Postcards</h2><p class="small muted">' + esc(pr.reached.length + ' of ' + r.checkpoints.length + ' collected') + '</p>' + postcardsHtml(v.route, pr.reached) + '</div>' +
      '</div><div class="main">' +
      '<div class="card"><p class="headline" aria-live="polite">' + esc(C.headline(rows, false)) + '</p>' + boardRows(rows, v.players, false) +
      (v.players.length > 1 ? '<p class="small ' + (crewWeeks ? 'okline' : 'muted') + '">' + esc(crewWeeks ? 'Crew streak: ' + plural(crewWeeks, 'week') + ' with everyone out.' : 'Crew streak: a week with everyone out at least once starts one.') + '</p>' : '') + controls + '</div>' +
      '<div class="card"><h2>Latest</h2>' + feedHtml(p) + '</div>' +
      (v.past && v.past.length ? '<div class="card"><h2>Finished legs</h2><ul class="small">' + v.past.map(function (x) { return '<li>' + esc(C.routeOf(x.route).name + ' · ' + dist(x.m) + (x.finished ? ' · finished ' + C.dateText(x.finished) : '')) + '</li>'; }).join('') + '</ul></div>' : '') +
      '</div></div>';
  }

  /* ---------------- logging ---------------- */

  function dayOptions() { var t = today(), o = ''; for (var i = 0; i <= C.LIMITS.backDays; i++) { var d = C.addDays(t, -i); o += '<option value="' + d + '">' + esc(dayLabel(d)) + '</option>'; } return o; }
  function logSheet() {
    var p = playing(); if (!p) return;
    var k = state.prefs.kind;
    var kinds = C.KIND_IDS.map(function (id) { return '<label><input type="radio" name="kind" value="' + id + '"' + (id === k ? ' checked' : '') + '> ' + esc(C.KINDS[id].label) + '</label>'; }).join('');
    var units = [['min', 'Minutes'], ['km', 'km'], ['mi', 'Miles']].map(function (u, i) { return '<label><input type="radio" name="unit" value="' + u[0] + '"' + (i === 0 ? ' checked' : '') + '> ' + u[1] + '</label>'; }).join('');
    var who = p.kind === 'solo' && p.trek.players.length > 1 ? '<label class="field"><span>Who</span><select class="input" name="p">' + p.trek.players.map(function (pl, i) { return '<option value="' + i + '">' + esc(pl.name) + '</option>'; }).join('') + '</select></label>' : '';
    sheet('<h2>Log it</h2><form id="logForm"><fieldset class="field"><legend>What</legend><div class="seg" role="radiogroup">' + kinds + '</div></fieldset>' +
      '<fieldset class="field"><legend>How much</legend><div class="seg" role="radiogroup">' + units + '</div></fieldset>' +
      '<div class="amtrow"><label class="field"><span class="vh">Amount</span><input class="input amt" name="amt" inputmode="decimal" autocomplete="off" required placeholder="30" data-act-input="preview"></label>' +
      '<label class="field"><span class="vh">Day</span><select class="input" name="day">' + dayOptions() + '</select></label></div>' + who +
      '<p class="small muted" id="preview" aria-live="polite">Type minutes or a distance.</p><div id="logErr"></div><button class="btn block big" type="submit">Log it</button></form>', function (root) { var a = $('input[name=amt]', root); if (a) setTimeout(function () { try { a.focus({ preventScroll: true }); } catch (e) { /* fine */ } }, 60); });
  }
  function previewLog() {
    var f = $('#logForm'), out = $('#preview'); if (!f || !out) return;
    var kind = f.elements.kind.value, u = f.elements.unit.value, amt = f.elements.amt.value;
    if (!String(amt).trim()) { out.textContent = 'Type minutes or a distance.'; return; }
    var why = C.amountProblem(kind, u, amt);
    out.textContent = why || ('= ' + dist(C.toTrail(kind, u, amt)) + ' along the trail' + (C.toTrail(kind, u, amt) > C.CAP_M ? ' (a day counts up to ' + dist(C.CAP_M) + ')' : ''));
  }
  function submitLog(f) {
    var p = playing(); if (!p) return;
    var o = { kind: f.elements.kind.value, unit: f.elements.unit.value, amt: f.elements.amt.value, day: f.elements.day.value };
    var why = C.amountProblem(o.kind, o.unit, o.amt);
    if (why) return formErr('logErr', new Error(why));
    if (o.kind !== state.prefs.kind) { state.prefs.kind = o.kind; real.putPrefs(state.prefs); }
    if (p.kind === 'demo') return demoLog(o);
    if (p.kind === 'solo') {
      var id = state.now.trek, r;
      try { r = C.addLog(state.treks[id], 'l' + rid(9), { p: f.elements.p ? Number(f.elements.p.value) : 0, kind: o.kind, unit: o.unit, amt: o.amt, day: o.day }, Date.now(), today()); } catch (e) { return formErr('logErr', e); }
      state.treks[id] = r.trek; saveTreks(); closeSheet(true); drawSoft();
      afterLog(r.m, r.crossed, C.routeOf(r.trek.route));
      return;
    }
    if (state.busy) return;
    state.busy = true;
    var btn = $('button[type=submit]', f); if (btn) btn.disabled = true;
    api('POST', 'api/c/' + encodeURIComponent(state.now.crew) + '/logs', { kind: o.kind, unit: o.unit, amt: o.amt, day: o.day }).then(function (res) {
      state.busy = false; closeSheet(true);
      adoptView(res.crew);
      afterLog(res.m, res.crossed, C.routeOf(res.crew.route));
    }).catch(function (err) {
      state.busy = false; if (btn) btn.disabled = false;
      if (err.status === 404) { closeSheet(true); return crewGone(); }
      formErr('logErr', err);
    });
  }
  function unlog(lid) {
    var p = playing(); if (!p) return;
    if (p.kind === 'demo') { state.demo.doc = D.unlog(state.demo.doc, lid); keepPlace(draw); toast('Taken back.'); return; }
    if (p.kind === 'solo') { state.treks[state.now.trek] = C.removeLog(p.trek, lid, Date.now()); saveTreks(); drawSoft(); toast('Taken back.'); return; }
    if (!confirm('Take this log back? The crew moves back with it.')) return;
    api('DELETE', 'api/c/' + encodeURIComponent(state.now.crew) + '/logs/' + encodeURIComponent(lid)).then(function (r) { toast('Taken back.'); adoptView(r.crew); }).catch(function (e) { showError(e); });
  }
  /** A postcard: the checkpoint's name and its few lines, drawn as a card. */
  function postcard(routeId, i, fresh) {
    var r = C.routeOf(routeId), c = r.checkpoints[i];
    if (!c) return;
    sheet('<h2>' + esc(fresh ? 'A postcard from the trail!' : 'Postcard ' + (i + 1) + ' of ' + r.checkpoints.length) + '</h2>' +
      '<div class="postcard"><div class="stamp" aria-hidden="true">' + esc(i + 1) + '</div><p class="pcplace">' + esc(c.name) + '</p><p>' + esc(c.card) + '</p><p class="small pcfoot">' + esc(r.name + ' · ' + dist(c.at) + ' from ' + r.from) + '</p></div>' +
      (fresh ? '<p class="small muted center">' + esc(i === r.checkpoints.length - 1 ? 'The whole route - done together.' : 'Every postcard is kept under Postcards.') + '</p>' : ''));
  }

  /* ---------------- starting, joining, inviting ---------------- */

  function routePicker(sel) {
    return '<fieldset class="field"><legend>The route</legend><div class="routes">' + C.ROUTES.map(function (r) {
      return '<label class="rpick"><input type="radio" name="route" value="' + r.id + '"' + (r.id === sel ? ' checked' : '') + '><span><b>' + esc(r.name) + '</b> · ' + esc(dist(r.m)) + '<br><span class="small muted">' + esc(r.blurb) + '</span></span></label>';
    }).join('') + '</div></fieldset>';
  }
  function newCrewSheet() {
    sheet('<h2>Start a crew</h2><p class="small muted">Everyone joins on their own phone with a code and a first name - no accounts. A crew closes itself after 30 days with nobody logging.</p>' +
      '<form id="newCrewForm"><label class="field"><span>Your first name</span><input class="input" name="name" autocomplete="given-name" maxlength="20" required value="' + esc(state.prefs.name) + '"></label>' +
      '<label class="field"><span>The crew’s name (optional)</span><input class="input" name="title" maxlength="40" placeholder="The Lunch Loop"></label>' + routePicker('c2c') +
      '<div id="ncErr"></div><button class="btn block" type="submit">Start the crew</button></form>');
  }
  function newSoloSheet() {
    sheet('<h2>On this phone</h2><p class="small muted">Everything stays on this phone and works with no signal. Add the family if you like - each log asks who it was.</p>' +
      '<form id="newSoloForm"><label class="field"><span>Name it</span><input class="input" name="title" maxlength="40" placeholder="My trek"></label>' +
      '<label class="field"><span>Who’s walking? First names, with commas</span><input class="input" name="players" maxlength="300" placeholder="Mara, Dev" value="' + esc(state.prefs.name) + '"></label>' + routePicker('hadrian') +
      '<div id="nsErr"></div><button class="btn block" type="submit">Start</button></form>');
  }
  function joinSheet(code) {
    sheet('<h2>Join a crew</h2><p class="small muted">The code is under Invite on the phone of whoever started it.</p>' +
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
        $('#peek').textContent = r.already ? 'You’re already in “' + r.title + '”.' : '“' + r.title + '” on the ' + r.route + ', started by ' + r.by + ' · ' + plural(r.members, 'person', 'people') + (r.full ? ' - full' : '');
      }).catch(function (e) { if ($('#peek')) $('#peek').textContent = e.message; });
    }, 250);
  }
  function invite() {
    var p = playing(); if (!p || !p.view.code) return;
    var link = location.origin + BASE + '#join=' + C.normalizeCode(p.view.code);
    sheet('<h2>Invite the crew</h2><p class="muted">Everyone opens this page and taps Join with a code - or send them the link.</p><p class="bigcode" aria-label="' + esc('Code ' + p.view.code.split('').join(' ')) + '">' + esc(C.formatCode(p.view.code)) + '</p>' +
      (state.demo ? '<p class="small muted center">The example’s code joins nothing.</p>' : '<button class="btn block" type="button" data-act="sendlink" data-link="' + esc(link) + '">Send the link</button><p class="small muted center">The code travels after the # in the link, which is never sent to any server.</p>'));
  }
  function membersSheet() {
    var v = playing().view;
    sheet('<h2>Members</h2><ul class="plist">' + v.players.map(function (pl) {
      return '<li>' + dot(pl.c, pl.name) + '<span class="nm">' + esc(pl.name) + (pl.host ? ' <span class="small muted">(started it)</span>' : '') + (pl.left ? ' <span class="small muted">(left)</span>' : '') + '</span>' + (!pl.you && !state.demo ? '<button class="btn ghost small" type="button" data-act="kick" data-id="' + esc(pl.id) + '" data-name="' + esc(pl.name) + '">Remove</button>' : '') + '</li>';
    }).join('') + '</ul><p class="small muted">Removing someone takes their logs off the crew too.</p>');
  }
  function nextRouteSheet() {
    var p = playing(), done = C.progress(p.view.route, p.view.days).done;
    sheet('<h2>' + (done ? 'Where next?' : 'Change the route') + '</h2><p class="small muted">' + esc(done ? 'The finished route is kept as a leg. The next one starts from zero, with a fresh leaderboard.' : 'Nobody has logged yet, so the route can still change.') + '</p><form id="routeForm">' + routePicker(p.view.route) + '<div id="rtErr"></div><button class="btn block" type="submit">Go</button></form>');
  }

  /* ---------------- treks ---------------- */

  function treksHtml() {
    var list = C.live(treks()), life = C.lifetime(treks());
    return guideHtml('treks') + (state.mergeNote && !state.demo ? '<p class="note okline" role="status">' + esc(state.mergeNote) + ' <button class="link-btn" type="button" data-act="mergeok">OK</button></p>' : '') +
      '<h1>Your treks</h1>' +
      '<div class="dk-split"><div class="card"><h2>All told</h2><p class="big">' + esc(dist(life.m)) + '</p><p class="muted">' + esc('across ' + plural(life.treks, 'trek') + (life.done.length ? ' · finished: ' + life.done.map(function (id) { return C.routeOf(id).name; }).join(', ') : '')) + '</p><p class="small" data-sync></p></div>' +
      '<div>' + (list.length ? '<ul class="treks">' + list.map(function (t) {
        var s = C.summary(t, today()), on = !state.demo && state.now.trek === t.id && !t.ended;
        return '<li><button class="trow" type="button" data-act="opentrek" data-id="' + esc(t.id) + '">' + routeSvg(t.route, s.progress.frac, '', true) + '<span class="tt"><b>' + esc(t.title) + '</b><span class="small muted">' + esc(C.routeOf(t.route).name + ' · ' + Math.floor(s.progress.frac * 100) + '% · ' + (t.mode === 'crew' ? 'crew of ' + t.players.length : t.players.length > 1 ? plural(t.players.length, 'person', 'people') : 'solo')) + '</span><span class="small">' + esc(on ? 'On the go' : s.headline) + '</span></span></button></li>';
      }).join('') + '</ul>' : '<p class="muted">No treks yet. Start one - it is kept here.</p>') + '</div></div>';
  }
  function trekHtml() {
    var t = C.clone(treks()[state.trekId]); t.id = state.trekId;
    var s = C.summary(t, today()), r = C.routeOf(t.route);
    var on = !state.demo && state.now.trek === t.id && !t.ended;
    return '<p><button class="btn ghost small" type="button" data-act="tab" data-tab="treks">‹ All treks</button></p><h1>' + esc(t.title) + '</h1><p class="small muted">' + esc(r.name + ' · since ' + day(t.started) + (t.ended ? ' · ended ' + day(t.ended) : '')) + '</p>' +
      '<div class="dk-split"><div class="card mapcard">' + routeSvg(t.route, s.progress.frac, r.name + ': ' + Math.floor(s.progress.frac * 100) + '%') + progressLine(s.progress, t.route) + '</div>' +
      '<div class="card"><p class="headline">' + esc(s.headline) + '</p>' + boardRows(s.rows, t.players, Boolean(t.ended)) +
      '<div class="row wrapbtns">' + (on ? '<button class="btn small" type="button" data-act="tab" data-tab="play">Back to the journey</button>' : '') + '<button class="btn small" type="button" data-act="recap">Recap card</button>' + (state.demo ? '' : '<button class="btn ghost small" type="button" data-act="rename">Rename</button><button class="btn ghost small" type="button" data-act="deltrek">Remove</button>') + '</div></div>' +
      '<div class="card"><h2>Postcards</h2>' + postcardsHtml(t.route, s.progress.reached) + '</div></div>';
  }

  /* ---------------- the recap card (drawn here, shared as a file) ---------------- */

  function drawRecap(canvas, trek) {
    var d = C.recapData(trek, today(), unit()), r = C.routeOf(trek.route), W = 1080, H = 1350, x = canvas.getContext('2d');
    canvas.width = W; canvas.height = H;
    var g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#1b5e20'); g.addColorStop(1, '#174a96');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    var font = function (w, s) { return w + ' ' + s + 'px -apple-system, "Segoe UI", Roboto, sans-serif'; };
    var fit = function (t, m) { return C.fitText(t, m, function (s) { return x.measureText(s).width; }); };
    x.fillStyle = '#ffffff'; x.textBaseline = 'alphabetic';
    x.font = font(600, 32); x.fillText(fit('TREK · ' + d.date.toUpperCase(), W - 144), 72, 106);
    x.font = font(800, 70); x.fillText(fit(d.title, W - 144), 72, 190);
    x.font = font(500, 36); x.fillText(fit(d.route + ' · ' + d.from.split(',')[0] + ' to ' + d.to.split(',')[0], W - 144), 72, 246);
    // The route.
    var bx = routeBox(r), MW = W - 144, MH = 524, sc = Math.min(MW / bx.w, MH / bx.h), ox = 72 + (MW - bx.w * sc) / 2, oy = 290;
    x.fillStyle = 'rgba(255,255,255,0.10)'; x.beginPath(); if (x.roundRect) x.roundRect(72, oy, MW, MH, 28); else x.rect(72, oy, MW, MH); x.fill();
    var P = function (p) { return [ox + (p[0] - bx.x) * sc, oy + (MH - bx.h * sc) / 2 + (p[1] - bx.y) * sc]; };
    x.lineCap = 'round'; x.lineJoin = 'round';
    x.setLineDash([2, 18]); x.strokeStyle = 'rgba(255,255,255,0.75)'; x.lineWidth = 10; x.beginPath();
    r.pts.forEach(function (p, i) { var q = P(p); if (i) x.lineTo(q[0], q[1]); else x.moveTo(q[0], q[1]); }); x.stroke(); x.setLineDash([]);
    var at = C.pointAt(r, d.frac), walked = r.pts.slice(0, at[2] + 1).concat([[at[0], at[1]]]);
    x.strokeStyle = '#ffd54f'; x.lineWidth = 14; x.beginPath();
    walked.forEach(function (p, i) { var q = P(p); if (i) x.lineTo(q[0], q[1]); else x.moveTo(q[0], q[1]); }); x.stroke();
    r.checkpoints.forEach(function (c) { var q = P(C.pointAt(r, c.f)); x.beginPath(); x.arc(q[0], q[1], 11, 0, Math.PI * 2); x.fillStyle = d.reached.indexOf(c.i) >= 0 ? '#ffd54f' : 'rgba(255,255,255,0.35)'; x.fill(); });
    var m = P(at); x.beginPath(); x.arc(m[0], m[1], 22, 0, Math.PI * 2); x.fillStyle = '#ffffff'; x.fill(); x.lineWidth = 8; x.strokeStyle = '#1b5e20'; x.stroke();
    var y = oy + MH + 70;
    x.fillStyle = '#ffffff'; x.font = font(800, 46); x.fillText(fit(d.line, W - 144), 72, y);
    y += 46; x.font = font(500, 30); x.fillText(fit(d.sub, W - 144), 72, y);
    d.rows.forEach(function (row) {
      y += 62;
      x.fillStyle = C.COLORS[row.c % C.COLORS.length]; x.beginPath(); x.arc(102, y - 12, 26, 0, Math.PI * 2); x.fill(); x.strokeStyle = '#ffffff'; x.lineWidth = 3; x.stroke();
      x.fillStyle = '#ffffff'; x.font = font(700, 22); x.textAlign = 'center'; x.fillText(row.initials, 102, y - 4); x.textAlign = 'left';
      x.font = font(row.rank === 1 ? 800 : 500, 36); x.fillText(fit(row.rank + '. ' + row.name, 560), 148, y);
      x.textAlign = 'right'; x.fillText(row.pts + ' pts · ' + row.active + ' days', W - 72, y); x.textAlign = 'left';
    });
    if (d.more) { y += 44; x.font = font(500, 28); x.fillText(d.more, 148, y); }
    if (d.moment) { x.font = font(600, 32); x.fillText(fit(d.moment, W - 144), 72, H - 82); }
    x.font = font(500, 26); x.globalAlpha = 0.85; x.fillText(fit(location.host + BASE, W - 144), 72, H - 36); x.globalAlpha = 1;
  }
  var recapBlob = null;
  function openRecap(trek, why) {
    recapBlob = null;
    sheet('<h2>Recap card</h2><p class="small muted">Drawn on this phone. Shared as a picture - never a link, never uploaded.' + (why === 'example' ? ' (This one is the made-up example.)' : '') + '</p><canvas id="recap" class="recap" role="img" aria-label="' + esc('Recap card: ' + trek.title + '. ' + C.summary(trek, today()).headline) + '"></canvas>' +
      '<button class="btn block" type="button" data-act="sharecard">Share the card</button>', function (root) {
      var cv = $('#recap', root);
      try { drawRecap(cv, trek); cv.toBlob(function (b) { recapBlob = b; }, 'image/png'); } catch (e) { cv.replaceWith(document.createTextNode('This browser cannot draw the card.')); }
    });
    state.recapTitle = trek.title;
  }
  function shareCard() {
    if (!recapBlob) { toast('One moment - still drawing.'); return; }
    var name = 'trek-' + (C.norm(state.recapTitle || 'trek').replace(/ /g, '-') || 'trek') + '.png';
    var file = null;
    try { file = new File([recapBlob], name, { type: 'image/png' }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: state.recapTitle || 'Trek' }).catch(function (er) { if (!er || er.name !== 'AbortError') download(name); });
    } else download(name);
  }
  function download(name) {
    var url = URL.createObjectURL(recapBlob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Saved as a picture.');
  }

  /* ---------------- how it works ---------------- */

  function moreHtml() {
    var rows = C.KIND_IDS.map(function (id) {
      var k = C.KINDS[id], perKm = k.perKm === 1 ? '1 trail km' : k.perKm < 1 ? '1/3 trail km' : k.perKm + ' trail km';
      return '<tr><th scope="row">' + esc(k.label) + '</th><td>' + esc(perKm) + '</td><td>' + esc(dist(k.perMin * 30)) + '</td></tr>';
    }).join('');
    return '<h1>How it works</h1><div class="dk-split"><div class="card"><h2>One fair trail distance</h2><p class="muted">Walking and running cost about the same effort per kilometre (running is faster, not harder per km); cycling about a third; swimming about four times. A wheelchair push counts like a walk. Minutes count at an easy pace for each.</p>' +
      '<div class="tablewrap"><table class="conv"><thead><tr><th scope="col">Kind</th><th scope="col">1 km logged</th><th scope="col">30 minutes</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<fieldset class="field unitpick"><legend>Show distances in</legend><div class="seg" role="group"><button type="button" data-act="unit" data-v="km" aria-pressed="' + (unit() === 'km') + '">Kilometres</button><button type="button" data-act="unit" data-v="mi" aria-pressed="' + (unit() === 'mi') + '">Miles</button></div></fieldset></div>' +
      '<div><div class="card"><h2>Showing up counts</h2><ul class="small"><li>10 points for every day you get out at all.</li><li>1 point per trail km - up to ' + esc(dist(C.CAP_M)) + ' a day. The crew moves by the same capped distance, so one huge day cannot carry everyone.</li><li>15 points for every week (Monday to Sunday) with ' + C.GOAL_DAYS + ' or more days out - and those weeks in a row are your streak.</li><li>The crew streak counts weeks when everyone got out at least once.</li><li>Days are your own calendar days, wherever you are.</li></ul></div>' +
      '<div class="card"><h2>Your data</h2><p class="small muted">A trek on this phone stays on it. A crew holds only first names and what each person logged, and is deleted after 30 days with nobody logging. Your phone is recognised in a crew by a random key the server keeps only as a scrambled fingerprint for that crew. No location, no GPS, no health data, no email to play.</p><p class="small" data-sync></p>' +
      '<button class="btn ghost block" type="button" data-act="wipe">Remove every trek from this phone</button></div></div></div>';
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

  /* ---------------- the account (only for keeping treks on two phones) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }
  var FREE_LINE = 'Trek is free with no account, and you never need one to walk. A free account only keeps your trek history on two phones - and one account works across every app on this site.';
  function openAccount() {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2><p class="muted">' + esc(FREE_LINE) + '</p>' +
        '<form id="authForm"><label class="field"><span>Your email (for your account only)</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div><button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
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
      '<button class="btn ghost block" id="forget" type="button">Remove my treks from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button">Set up Face ID for this phone</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button">Sign out</button>', function (root) {
      $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); keepPlace(draw); }); });
      $('#forget', root).addEventListener('click', function () {
        if (!confirm('Remove your treks from the account? This phone keeps its copy.')) return;
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
  function crewCall(method, tail, ok) { api(method, 'api/c/' + encodeURIComponent(state.now.crew) + tail).then(ok).catch(function (er) { showError(er); }); }
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id'), p;
    switch (act) {
      case 'home': e.preventDefault(); go(playing() && !state.demo ? 'play' : 'start'); break;
      case 'tab': closeSheet(true); go(el.getAttribute('data-tab')); break;
      case 'demo': startDemo(); break;
      case 'leavedemo': leaveDemo(); break;
      case 'tour': tourStep(Number(el.getAttribute('data-step'))); break;
      case 'tourdo': tourDo(Number(el.getAttribute('data-step'))); break;
      case 'tourdone': leaveDemo('start'); newCrewSheet(); break;
      case 'closesheet': closeSheet(); break;
      case 'signin': openAccount(); break;
      case 'newcrew': if (state.demo) leaveDemo('start'); newCrewSheet(); break;
      case 'newsolo': newSoloSheet(); break;
      case 'joinsheet': joinSheet(''); break;
      case 'invite': invite(); break;
      case 'sendlink': (function () { var link = el.getAttribute('data-link'); if (navigator.share) navigator.share({ title: 'Join our crew', text: 'Join our crew on Trek: ', url: link }).catch(function () { /* fine */ }); else if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () { toast('Link copied.'); }); }()); break;
      case 'members': membersSheet(); break;
      case 'kick':
        if (!confirm('Remove ' + el.getAttribute('data-name') + '? Their logs come off the crew too.')) return;
        crewCall('DELETE', '/members/' + encodeURIComponent(id), function (r) { closeSheet(true); adoptView(r.crew); });
        break;
      case 'logsheet': logSheet(); break;
      case 'unlog': unlog(id); break;
      case 'postcard': p = playing(); postcard(state.view === 'trek' ? treks()[state.trekId].route : p.view.route, Number(el.getAttribute('data-i')), false); break;
      case 'addperson': sheet('<h2>Add someone</h2><form id="addForm"><label class="field"><span>First name</span><input class="input" name="name" maxlength="20" required></label><div id="apErr"></div><button class="btn block" type="submit">Add</button></form>'); break;
      case 'nextroute': if (state.demo) { toast('In a real crew, whoever started it picks the next route.'); return; } nextRouteSheet(); break;
      case 'endtrek':
        if (!confirm('End this trek? It goes into your treks, as far as you got.')) return;
        (function () { var tid = state.now.trek; state.treks[tid] = C.endTrek(state.treks[tid], Date.now()); saveTreks(); setNow({}); state.trekId = tid; go('trek'); }());
        break;
      case 'delcrew':
        if (state.demo) { toast('In a real crew, every phone keeps what it has seen.'); return; }
        if (!confirm('Delete the crew for everyone? Every phone keeps what it has seen in its treks.')) return;
        crewCall('DELETE', '', function () { var tid = state.now.trek; if (state.treks[tid]) { state.treks[tid] = C.endTrek(state.treks[tid], Date.now()); saveTreks(); } setNow({}); state.crew = null; state.trekId = tid; go(state.treks[tid] ? 'trek' : 'start'); });
        break;
      case 'leavecrew':
        if (!confirm('Leave this crew? Your distance stays with them, and the trek so far stays on this phone.')) return;
        crewCall('DELETE', '/me', function () { var tid = state.now.trek; if (state.treks[tid]) { state.treks[tid] = C.endTrek(state.treks[tid], Date.now()); saveTreks(); } setNow({}); state.crew = null; state.trekId = tid; go(state.treks[tid] ? 'trek' : 'start'); });
        break;
      case 'recap': p = state.view === 'trek' ? C.clone(treks()[state.trekId]) : (playing() || {}).trek; if (p) openRecap(p, state.demo ? 'example' : ''); break;
      case 'sharecard': shareCard(); break;
      case 'opentrek': state.trekId = id; go('trek'); break;
      case 'rename': sheet('<h2>Rename</h2><form id="renameForm"><label class="field"><span>Name</span><input class="input" name="title" maxlength="40" required value="' + esc(state.treks[state.trekId].title) + '"></label><div id="rnErr"></div><button class="btn block" type="submit">Save</button></form>'); break;
      case 'deltrek':
        if (!confirm('Remove this trek from this phone' + (signedIn() ? ' and your account' : '') + '?')) return;
        (function () { var tid = state.trekId; state.treks[tid] = { del: true, t: Date.now() }; saveTreks(); if (state.now.trek === tid && !state.now.crew) setNow({}); go('treks'); toast('Removed.'); }());
        break;
      case 'unit': state.prefs.unit = el.getAttribute('data-v') === 'mi' ? 'mi' : 'km'; real.putPrefs(state.prefs); keepPlace(draw); break;
      case 'mergeok': state.mergeNote = ''; keepPlace(draw); break;
      case 'resync': state.sync = { base: null, at: 0 }; push(null); break;
      case 'retrysync': syncIn(); break;
      case 'wipe':
        if (!confirm('Remove every trek from this phone? (A crew you are in carries on.)')) return;
        (function () { var keep = state.now.crew ? state.now : {}; real.clearAll(); state.treks = {}; state.sync = S.cleanSync({}); setNow(keep); go('start'); toast('Removed from this phone.'); }());
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
    if (id === 'newCrewForm') {
      var name = C.cleanName(f.elements.name.value), why = C.refuse(f.elements.title.value);
      if (!name) return formErr('ncErr', new Error('Type your first name - letters only.'));
      if (why) return formErr('ncErr', new Error(why));
      btn.disabled = true;
      api('POST', 'api/crews', { name: name, title: f.elements.title.value, route: f.elements.route.value }).then(function (r) { rememberName(name); closeSheet(true); enterCrew(r.id, r.crew); invite(); })
        .catch(function (er) { btn.disabled = false; formErr('ncErr', er); });
    } else if (id === 'newSoloForm') {
      var names = String(f.elements.players.value).split(/[,\n]+/).map(C.cleanName).filter(Boolean), w2 = C.refuse(f.elements.title.value);
      if (w2) return formErr('nsErr', new Error(w2));
      if (names.length > C.LIMITS.members) return formErr('nsErr', new Error('Up to ' + C.LIMITS.members + ' people.'));
      var tid = 't' + rid(10);
      state.treks[tid] = C.newTrek({ title: f.elements.title.value, players: names, route: f.elements.route.value }, Date.now(), today());
      if (names.length === 1) rememberName(names[0]);
      saveTreks(); setNow({ trek: tid }); closeSheet(true); go('play');
    } else if (id === 'joinForm') {
      var code = C.normalizeCode(f.elements.code.value), nm = C.cleanName(f.elements.name.value);
      if (!C.isCode(code)) return formErr('jErr', new Error('A code is six letters and numbers, like ' + C.formatCode('KXR7PD') + '.'));
      if (!nm) return formErr('jErr', new Error('Type your first name - letters only.'));
      btn.disabled = true;
      api('POST', 'api/join/' + code, { name: nm }).then(function (r) {
        rememberName(nm); closeSheet(true);
        if (state.demo) { state.demo = null; state.tour = 0; }
        if (state.now.crew === r.id) { go('play'); return; }
        enterCrew(r.id, null);
      }).catch(function (er) { btn.disabled = false; formErr('jErr', er); });
    } else if (id === 'logForm') {
      submitLog(f);
    } else if (id === 'routeForm') {
      btn.disabled = true;
      api('POST', 'api/c/' + encodeURIComponent(state.now.crew) + '/route', { route: f.elements.route.value }).then(function (r) { closeSheet(true); adoptView(r.crew); toast('On to the ' + C.routeOf(r.crew.route).name + '!'); })
        .catch(function (er) { btn.disabled = false; formErr('rtErr', er); });
    } else if (id === 'addForm') {
      try { state.treks[state.now.trek] = C.addPerson(curTrek(), f.elements.name.value, Date.now(), today()); } catch (er) { return formErr('apErr', er); }
      saveTreks(); closeSheet(true); drawSoft();
    } else if (id === 'renameForm') {
      try { state.treks[state.trekId] = C.renameTrek(state.treks[state.trekId], f.elements.title.value, Date.now()); } catch (er) { return formErr('rnErr', er); }
      saveTreks(); closeSheet(true); keepPlace(draw);
    }
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var a = t.getAttribute('data-act-input');
    if (a === 'peek') peek(t.value);
    if (a === 'preview') previewLog();
  });
  document.addEventListener('change', function (e) { if (e.target && e.target.form && e.target.form.id === 'logForm') previewLog(); });
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
  state.treks = real.getTreks(); state.now = real.getNow(); state.prefs = real.getPrefs(); state.sync = real.getSync();
  if (state.now.trek && !state.treks[state.now.trek] && !state.now.crew) setNow({});
  if (!real.persistent()) setTimeout(function () { toast('This browser is not keeping anything - treks last until the tab closes.', 5000); }, 600);
  var join = /^#join=([A-Za-z0-9-]{4,12})$/.exec(location.hash || '');
  if (join) history.replaceState(null, '', BASE);
  drawTop();
  route();
  if (state.now.crew) schedulePoll(0);
  if (join) joinSheet(C.normalizeCode(join[1]));
  loadMe().then(function () { if (signedIn()) syncIn(); });
}());
