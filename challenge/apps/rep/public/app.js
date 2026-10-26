/* Rep - the page. One file, no build step. Every string that came from
 * outside this file (a typed workout or exercise name, a note, an imported
 * file, a model's plan, anything from the server) is escaped before it is
 * drawn, and no handler is written into markup: clicks are routed by
 * data-act attributes from one listener (the lab's CSP allows script from
 * this origin only). The rules - units, "beat last time", PRs, the streak,
 * the rest timer's sums, the plate calculator, import and export - are
 * rep-core.js, the same file the server and the tests run.
 *
 * Views (tabs): today (up next, beat last time, this week, recent PRs),
 * history, progress (a chart per lift, sets per muscle group, the calendar),
 * routines (yours, the starters, "Plan my next 4 weeks"). A workout under
 * way takes the whole screen: the exercises and their sets above, the set
 * console and the rest timer pinned to the bottom, under the thumb.
 *
 * Where things live: the log in localStorage (rep-log-v1), the workout under
 * way in rep-active-v1 (so a reload or a locked phone loses nothing - the
 * rest timer is a start time, not a countdown), the settings in
 * rep-settings-v1, the tab in rep-tab-v1. Signed in, the log is also kept in
 * the account.
 */
(function () {
  'use strict';

  var R = window.RepCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_LOG = 'rep-log-v1';
  var K_ACTIVE = 'rep-active-v1';
  var K_SET = 'rep-settings-v1';
  var K_TAB = 'rep-tab-v1';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TABS = ['today', 'history', 'progress', 'routines'];
  var GUESS_UNIT = /^en-(US|LR|MM)\b/i.test(navigator.language || '') ? 'lb' : 'kg';
  var TITLE = document.title;
  var SAFETY = 'General training information, not medical advice. Warm up, use safety bars or a spotter for heavy sets, and stop if something hurts.';
  var PLATE_COLOURS = {
    kg: { 25: '#d42a2a', 20: '#2456d6', 15: '#f2c230', 10: '#2f9e4f', 5: '#f1f2f4', 2.5: '#d42a2a', 2: '#2456d6', 1.25: '#a7afbd', 1: '#2f9e4f', 0.5: '#f1f2f4', 0.25: '#a7afbd' },
    lb: { 55: '#d42a2a', 45: '#2456d6', 35: '#f2c230', 25: '#2f9e4f', 15: '#f2c230', 10: '#f1f2f4', 5: '#d42a2a', 2.5: '#2f9e4f', 1.25: '#a7afbd' },
  };
  var PLATE_H = {
    kg: { 25: 140, 20: 140, 15: 120, 10: 100, 5: 72, 2.5: 58, 2: 54, 1.25: 46, 1: 42, 0.5: 36, 0.25: 30 },
    lb: { 55: 140, 45: 140, 35: 122, 25: 102, 15: 86, 10: 74, 5: 60, 2.5: 48, 1.25: 40 },
  };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function today() { return R.localDay(new Date()); }
  function now() { return Date.now(); }
  function newId(p) { var a = new Uint8Array(10); crypto.getRandomValues(a); return p + Array.prototype.map.call(a, function (x) { return (x % 36).toString(36); }).join(''); }
  var plural = R.plural;

  var state = {
    me: null,
    workouts: [],
    routines: [],
    custom: {},
    settings: R.defaultSettings(GUESS_UNIT),
    active: null,      // the workout under way
    inWorkout: false,  // showing it (false: minimised, it keeps going)
    con: { w: '', r: '', rpe: null, warm: false },
    tab: 'today',
    lift: null,        // the lift on the Progress chart
    metric: 'e1rm',
    weekView: null,    // sets per muscle: 'this' or 'last'
    plates: null,      // the plate calculator sheet
    ai: null,          // the plan sheet
    editor: null,      // the routine editor
    armed: null,       // a delete waiting for its second tap
    importing: null,
    browse: false,     // looking at the starters before logging anything
  };
  var main = $('#main');

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    var h = {};
    if (body) h['Content-Type'] = 'application/json';
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin', headers: h,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.error) {
          var e = new Error(data.error || 'Something went wrong.');
          e.status = res.status; e.data = data;
          throw e;
        }
        return data;
      });
    });
  }
  var toastTimer = null;
  function toast(msg, ms) {
    $$('.toast').forEach(function (old) { old.remove(); });
    clearTimeout(toastTimer);
    if (!msg) return;
    var t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, ms || Math.min(6000, 2400 + msg.length * 30));
  }
  function say(msg) { var l = $('#live'); if (l) { l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); } }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: the page still works */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function syncOn() { return signedIn() && state.me.sync !== false; }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function U() { return state.settings.unit; }
  function exOf(id) { return R.exerciseOf(id, state.custom) || { id: id, name: 'Unknown exercise', group: 'other', kind: 'machine', rest: 90 }; }
  function num(kg) { return R.fmtNum(R.shown(kg, U())); }
  function fw(kg) { return R.fmtW(kg, U()); }
  function hasSample() { return state.workouts.some(function (w) { return w.sample; }); }
  function real() { return state.workouts.filter(function (w) { return !w.sample; }); }
  function setWords(s, ex) {
    if (s.w === null || s.w === undefined) return '? × ' + s.r;
    if (ex.kind === 'bodyweight') return (s.w > 0.004 ? '+' + num(s.w) + ' × ' : '') + plural(s.r, 'rep');
    return num(s.w) + ' × ' + s.r;
  }
  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Your log, routines and the starters work meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).addEventListener('click', function () {
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { toast('Sent - check your email.'); }, function () { toast('Could not send it. Try again in a minute.'); });
    });
  }
  /** A file for the phone to keep: an export. Nothing is uploaded. */
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function confetti() {
    if (REDUCED) return;
    var box = document.createElement('div');
    box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
    var colours = ['#d42a2a', '#2456d6', '#f2c230', '#2f9e4f', '#f1f2f4', '#ffd166'];
    for (var i = 0; i < 44; i++) {
      var p = document.createElement('i');
      if (i % 3 === 0) p.className = 'sq';
      p.style.left = (Math.random() * 100) + 'vw';
      p.style.background = colours[i % colours.length];
      p.style.animationDelay = (Math.random() * 0.6) + 's';
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 3600);
  }

  /* ---------------- this phone's log ---------------- */

  function loadLocal() {
    var raw = recall(K_LOG) || {};
    var custom = {};
    (Array.isArray(raw.exercises) ? raw.exercises : []).forEach(function (x) { var e = R.cleanExercise(x); if (e) custom[e.id] = e; });
    state.custom = custom;
    state.workouts = (Array.isArray(raw.workouts) ? raw.workouts : []).map(function (w) { return R.cleanWorkout(w, { custom: custom, keepSample: true }); }).filter(Boolean).sort(R.byTime).slice(-R.LIMITS.workouts);
    state.routines = (Array.isArray(raw.routines) ? raw.routines : []).map(function (r) { return R.cleanRoutine(r, custom); }).filter(Boolean);
    state.settings = R.cleanSettings(recall(K_SET), GUESS_UNIT);
    var a = recall(K_ACTIVE);
    state.active = a ? R.cleanWorkout(a, { custom: custom, active: true, keepSample: true }) : null;
    state.inWorkout = Boolean(state.active);
    var tab = recall(K_TAB);
    if (TABS.indexOf(tab) >= 0) state.tab = tab;
  }
  function saveLocal() {
    keep(K_LOG, { v: 1, workouts: state.workouts, routines: state.routines, exercises: Object.keys(state.custom).map(function (k) { return state.custom[k]; }) });
  }
  function saveActive() { keep(K_ACTIVE, state.active); }
  function saveSettings() { keep(K_SET, state.settings); }
  function syncFail(e) { if (e && e.status === 401) return; toast((e && e.message) || 'Could not save to your account - it is still on this phone.'); }
  function pushWorkout(w) { if (!syncOn() || w.sample) return; api('PUT', 'api/workouts/' + w.id, { workout: R.toSaved(w), today: today() }).catch(syncFail); }
  function dropWorkout(w) { if (!syncOn() || w.sample) return; api('DELETE', 'api/workouts/' + encodeURIComponent(w.id) + '?day=' + w.day).catch(syncFail); }
  function pushRoutine(r) { if (!syncOn()) return; api('PUT', 'api/routines/' + r.id, { routine: r }).catch(syncFail); }
  function dropRoutine(id) { if (!syncOn()) return; api('DELETE', 'api/routines/' + encodeURIComponent(id)).catch(syncFail); }
  function pushExercise(e) { if (!syncOn()) return; api('PUT', 'api/exercises/' + e.id, { exercise: e }).catch(syncFail); }
  /** Signed in: bring this phone's log into the account (newer copy wins),
   *  in batches, then show what the account holds. */
  function syncIn(announce) {
    if (!syncOn()) return Promise.resolve();
    var mine = real().map(R.toSaved);
    var batches = [];
    for (var i = 0; i < mine.length; i += R.LIMITS.mergeBatch) batches.push(mine.slice(i, i + R.LIMITS.mergeBatch));
    if (!batches.length) batches.push([]);
    var custom = Object.keys(state.custom).map(function (k) { return state.custom[k]; });
    var step = function (k) {
      var body = { workouts: batches[k], today: today(), read: k === batches.length - 1 };
      if (k === 0) { body.exercises = custom; body.routines = state.routines; }
      return api('POST', 'api/log/merge', body).then(function (r) { return k === batches.length - 1 ? r : step(k + 1); });
    };
    return step(0).then(function (r) {
      var cust = {};
      (r.exercises || []).forEach(function (x) { var e = R.cleanExercise(x); if (e) cust[e.id] = e; });
      Object.keys(state.custom).forEach(function (k) { if (!cust[k]) cust[k] = state.custom[k]; });
      state.custom = cust;
      var server = (r.workouts || []).map(function (w) { return R.cleanWorkout(w, { custom: cust }); }).filter(Boolean);
      var samples = server.length ? [] : state.workouts.filter(function (w) { return w.sample; });
      state.workouts = samples.concat(server).sort(R.byTime);
      state.routines = (r.routines || []).map(function (x) { return R.cleanRoutine(x, cust); }).filter(Boolean);
      saveLocal();
      if (announce) toast(server.length ? 'Your log now follows you to any phone you sign in on.' : 'Signed in. Workouts you log now follow you to your other phones.');
      if (!state.inWorkout && $('#sheet').hidden) draw();
    }).catch(function (e) { if (e.status !== 401) toast(e.message); });
  }

  /* ---------------- small drawing helpers ---------------- */

  var KIND_CHIP = { up: ['up', 'Add weight'], reps: ['up', 'Add a rep'], repeat: ['info', 'Repeat'], stay: ['stay', 'Stay'], deload: ['deload', 'Deload'], first: ['info', 'New'] };
  function chip(sug) { var c = KIND_CHIP[sug.kind] || KIND_CHIP.first; return '<span class="chip ' + c[0] + '">' + esc(c[1]) + '</span>'; }
  function suggestFor(exId, workouts) {
    var ex = exOf(exId);
    return R.suggest(R.sessionsOf(workouts || state.workouts, exId, ex), ex, U());
  }
  function head(title) { return '<div class="grab" aria-hidden="true"></div><div class="sheet-head"><h2 id="sheetTitle">' + esc(title) + '</h2><button class="x" type="button" data-act="closesheet" aria-label="Close">×</button></div>'; }
  function upNext() {
    var pinned = state.settings.upNext && R.routineById(state.settings.upNext, state.routines);
    return pinned || R.nextUp(state.workouts, state.routines);
  }
  function ctx() { return { workouts: state.workouts, custom: state.custom, settings: state.settings, today: today(), nowMs: now(), id: newId }; }
  function minutes(w) { return w.endedAt ? Math.max(1, Math.round((w.endedAt - w.startedAt) / 60000)) : null; }
  function bestLine(e) {
    var ex = exOf(e.ex);
    var ws = R.working(e.sets);
    if (!ws.length) return '';
    var s = R.summarize({ day: '', startedAt: 0, id: '' }, ws, e.goal, ex);
    if (ex.kind === 'bodyweight' && s.topW < 0.01) return R.scheme(s) + ' reps';
    return R.scheme(s) + ' at ' + fw(s.topW);
  }

  /* ---------------- the views ---------------- */

  function draw() {
    var working = Boolean(state.active && state.inWorkout);
    document.body.classList.toggle('in-workout', working);
    if (working) { $('#tabbar').hidden = true; drawWorkout(); return; }
    document.title = TITLE;
    var any = state.workouts.length > 0 || Boolean(state.active) || state.routines.length > 0 || state.browse;
    $('#tabbar').hidden = !any;
    $$('#tabbar [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === state.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (!any) { main.innerHTML = firstRun(); return; }
    var html = sampleStrip() + resumeBar();
    if (state.tab === 'history') html += historyView();
    else if (state.tab === 'progress') html += progressView();
    else if (state.tab === 'routines') html += routinesView();
    else html += todayView();
    html += '<p class="safety">' + esc(SAFETY) + '</p>';
    main.innerHTML = html;
    if (state.tab === 'progress') {
      bindChart(main);
      var on = $('.lift-pick [aria-pressed="true"]');
      if (on && on.parentNode.scrollWidth > on.parentNode.clientWidth) on.parentNode.scrollLeft = Math.max(0, on.offsetLeft - on.parentNode.offsetLeft - 16);
    }
  }

  function unitPills() {
    return '<div class="units" role="group" aria-label="Units"><span>I lift in</span>' + ['kg', 'lb'].map(function (u) { return '<button class="pill" type="button" data-act="unit" data-u="' + u + '" aria-pressed="' + (U() === u) + '">' + u + '</button>'; }).join('') + '</div>';
  }
  function firstRun() {
    var u = U();
    var W = u === 'kg' ? ['55', '57.5'] : ['120', '125'];
    return '<section class="first">' +
      '<div><div class="hero">' +
      '<p class="eyebrow">Strength log</p>' +
      '<h1>Lift, log, <em>beat last time.</em></h1>' +
      '<p class="lede">Last time’s sets beside every set, so you always know what to put on the bar. Log a set in two taps, rest on a timer that survives a locked screen, load plates without maths, and see every PR the moment it happens.</p></div>' +
      unitPills() +
      '<div class="choices">' +
      '<button class="choice primary" type="button" data-act="sample"><span class="ci" aria-hidden="true">📈</span><span class="ct"><b>Try a sample month</b><span>Four weeks of a made-up lifter: a PR to beat, a stalled lift, real charts. Nothing is saved anywhere.</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      '<button class="choice" type="button" data-act="startempty"><span class="ci" aria-hidden="true">🏋️</span><span class="ct"><b>Start a workout</b><span>Add exercises as you go. Your first set is two taps away.</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      '<button class="choice" type="button" data-act="starters"><span class="ci" aria-hidden="true">📋</span><span class="ct"><b>Pick a starter routine</b><span>Beginner full body, Push / Pull / Legs or 5x5 - general templates to start from.</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      '</div>' +
      '<div class="promise"><span class="ic" aria-hidden="true">🔒</span><div><b>On your phone, and it works offline.</b><p>No account, no ads, nothing uploaded - a gym basement with no signal is fine. Sign in only to sync your log to another phone. AI planning is optional and never gets your name or notes.</p></div></div>' +
      '</div>' +
      '<div><div class="mock" aria-hidden="true"><span class="mock-flag">🏆 New PR</span>' +
      '<div class="mock-head"><b>Bench press · Set 2 of 3</b><span>last time ' + W[0] + ' × 5</span></div>' +
      '<div class="mock-row"><div class="mock-step">−</div><div class="mv">' + W[1] + ' <small>' + u + '</small></div><div class="mock-step">+</div></div>' +
      '<div class="mock-row"><div class="mock-step">−</div><div class="mv">5 <small>reps</small></div><div class="mock-step">+</div></div>' +
      '<div class="mock-go">Log set ✓</div>' +
      '<div class="mock-rest"><span>Rest · then set 3</span><b>2:47</b></div></div>' +
      '<h2 class="how-title">How it works</h2><ol class="how">' +
      '<li><span class="n" aria-hidden="true">🎯</span><div><b>See the number to beat</b><p>Every set shows what you did last time, greyed beside it, and each lift says what to try: “all reps done - try ' + W[1] + ' ' + u + '”, “missed reps - stay”, or after a third miss, “deload”.</p></div></li>' +
      '<li><span class="n" aria-hidden="true">👍</span><div><b>Log with one thumb</b><p>Big steppers, “same as last set” in one tap, an RPE if you track it. The rest timer starts by itself and buzzes at zero.</p></div></li>' +
      '<li><span class="n" aria-hidden="true">🧮</span><div><b>Load the bar without maths</b><p>The plate calculator says what goes on each side - and the nearest weight below and above when yours can’t be made exactly.</p></div></li>' +
      '<li><span class="n" aria-hidden="true">🏆</span><div><b>Watch it add up</b><p>PRs as they happen, an estimated 1RM chart for every lift, sets per muscle each week, and a streak of weeks you hit your goal.</p></div></li>' +
      '</ol></div></section>' +
      '<p class="safety">' + esc(SAFETY) + '</p>';
  }

  function sampleStrip() {
    if (!hasSample()) return '';
    return '<div class="strip" role="note"><p><b>🧪 A sample month.</b> A made-up lifter’s workouts to play with - nothing is saved anywhere. Workouts you log while it is here belong to the sample.</p>' +
      '<div class="row"><button class="btn small" type="button" data-act="mine">Start my own</button><button class="btn small ghost" type="button" data-act="clearsample">Clear the sample</button></div></div>';
  }
  function resumeBar() {
    var a = state.active;
    if (!a) return '';
    var done = 0; a.entries.forEach(function (e) { e.sets.forEach(function (s) { if (s.done) done++; }); });
    return '<div class="resume"><div><b>' + esc(a.name) + '</b><div class="small"><span data-elapsed>' + R.fmtClock((now() - a.startedAt) / 1000) + '</span> · ' + plural(done, 'set') + ' logged</div></div><button class="btn small" type="button" data-act="resume">Resume</button></div>';
  }

  function todayView() {
    var t = today();
    var up = upNext();
    var html = '<div class="today-grid"><div>';
    if (up && !state.active) {
      var c = ctx();
      var items = up.exercises.map(function (it) {
        var d = R.draftEntry(it, c);
        if (!d) return '';
        var ex = exOf(it.ex);
        var w = d.sets[0] ? d.sets[0].w : null;
        var load = ex.kind === 'bodyweight' ? (w > 0.004 ? '+' + fw(w) : 'bodyweight') : (w !== null ? fw(w) : 'pick a weight');
        return '<li><span>' + esc(ex.name) + '</span><span class="num">' + d.goal.sets + 'x' + d.goal.reps + ' · ' + esc(load) + '</span></li>';
      }).join('');
      html += '<section class="upnext"><p class="eyebrow">Up next' + (up.program ? ' · ' + esc(up.program) : '') + '</p><h2>' + esc(up.name) + '</h2><ul>' + items + '</ul>' +
        '<div class="row"><button class="btn big" type="button" data-act="start" data-id="' + esc(up.id) + '">Start ' + esc(up.name) + '</button><button class="btn ghost" type="button" data-act="startpick">Something else</button></div></section>';
    } else if (!state.active) {
      html += '<section class="upnext"><p class="eyebrow">Ready when you are</p><h2>Start a workout</h2><p>Add exercises as you go, or start from a routine.</p>' +
        '<div class="row"><button class="btn big" type="button" data-act="startempty">Start an empty workout</button><button class="btn ghost" type="button" data-act="startpick">From a routine</button></div></section>';
    }
    // Beat last time
    var lifts = up ? up.exercises.map(function (it) { return it.ex; }) : R.liftsOf(state.workouts, state.custom).slice(0, 5);
    var rows = lifts.filter(function (id, i, a) { return a.indexOf(id) === i; }).map(function (id) {
      var s = suggestFor(id);
      if (!s) return '';
      return '<li>' + chip(s) + '<div class="what"><b>' + esc(exOf(id).name) + '</b><span>' + esc(s.text) + '</span></div></li>';
    }).join('');
    if (rows) html += '<section class="card"><div class="sec"><h2>Beat last time</h2><span class="ct">' + (up ? esc(up.name) : 'your recent lifts') + '</span></div><ul class="sug">' + rows + '</ul></section>';
    html += '</div><div>';
    // This week
    var st = R.streak(state.workouts, t, state.settings.perWeek);
    var mon = R.weekStart(t);
    var dots = '';
    for (var i = 0; i < 7; i++) {
      var d = R.addDays(mon, i);
      var n = state.workouts.filter(function (w) { return w.day === d; }).length;
      dots += '<div class="wday' + (n ? ' on' : '') + (d === t ? ' today' : '') + (d > t ? ' fut' : '') + '"><span>' + R.WEEKDAYS[R.weekday(d)] + '</span><b>' + (n ? '✓' : d === t ? '•' : '') + '</b><span class="vh">' + (n ? 'trained' : d > t ? 'to come' : d === t ? 'today' : 'rest') + '</span></div>';
    }
    var streakLine = st.current ? '🔥 ' + plural(st.current, 'week') + ' in a row at ' + st.goal + '+ a week' : 'Hit ' + st.goal + ' workouts this week to start a streak';
    var weekLine = st.pending ? (st.left === st.goal ? st.goal + ' to go this week' : st.left + ' more this week' + (st.current ? ' keeps it going' : '')) : 'Week done - nice work';
    html += '<section class="card"><div class="sec" style="margin-top:0"><h2>This week</h2><span class="ct">' + st.thisWeek + ' of ' + st.goal + ' workouts</span></div>' +
      '<div class="week">' + dots + '</div>' +
      '<p style="margin:12px 0 0"><b>' + esc(streakLine) + '</b></p><p class="small muted" style="margin:2px 0 0">' + esc(weekLine) + (st.best > st.current ? ' · best ' + plural(st.best, 'week') : '') + '</p></section>';
    // Recent PRs
    var prs = recentPrs(14).slice(0, 4);
    if (prs.length) {
      html += '<section class="card"><div class="sec" style="margin-top:0"><h2>Recent PRs</h2><span class="ct">last 2 weeks</span></div><ul class="prs">' + prs.map(function (p) {
        return '<li><span class="tro" aria-hidden="true">🏆</span><div><b>' + esc(p.name) + ' · ' + esc(p.pr.title) + '</b><small>' + esc(p.pr.text) + ' · ' + esc(R.fmtWhen(p.day, t)) + '</small></div></li>';
      }).join('') + '</ul></section>';
    }
    html += '<section class="card"><h2>Tools</h2><div class="row"><button class="btn ghost" type="button" data-act="plates">🧮 Plate calculator</button><button class="btn ghost" type="button" data-act="plan">✨ Plan my next 4 weeks</button></div></section>';
    html += '</div></div>';
    return html;
  }
  /** One PR per lift (the best kind) from the workouts of the last N days. */
  function recentPrs(days) {
    var since = R.addDays(today(), -days);
    var out = [];
    var rank = { weight: 0, e1rm: 1, reps: 2, volume: 3 };
    R.liftsOf(state.workouts, state.custom).forEach(function (id) {
      var tl = R.timeline(state.workouts, id, state.custom, U());
      for (var i = tl.length - 1; i >= 0 && tl[i].day >= since; i--) {
        if (!tl[i].prs.length) continue;
        var best = tl[i].prs.slice().sort(function (a, b) { return rank[a.type] - rank[b.type]; })[0];
        out.push({ ex: id, name: exOf(id).name, day: tl[i].day, pr: best });
        break;
      }
    });
    return out.sort(function (a, b) { return a.day < b.day ? 1 : a.day > b.day ? -1 : 0; });
  }

  function historyView() {
    var t = today();
    var list = state.workouts.slice().sort(R.byTime).reverse();
    var thisWeek = R.weekStart(t);
    var html = '<div class="page-title"><h1>History</h1><span class="muted">' + plural(list.length, 'workout') + '</span></div>';
    var lastKey = null;
    list.slice(0, 120).forEach(function (w) {
      var k = R.weekStart(w.day);
      if (k !== lastKey) {
        lastKey = k;
        var label = k === thisWeek ? 'This week' : k === R.addDays(thisWeek, -7) ? 'Last week' : R.fmtDay(k, t) + ' – ' + R.fmtDay(R.addDays(k, 6), t);
        html += '<div class="week-head">' + esc(label) + '</div>';
      }
      var sets = 0; w.entries.forEach(function (e) { sets += R.working(e.sets).length; });
      var prs = R.workoutPrs(state.workouts, w, state.custom, U());
      var m = minutes(w);
      html += '<button class="wk" type="button" data-act="wo" data-id="' + esc(w.id) + '"><div class="wk-top"><b>' + esc(w.name) + '</b><span>' + esc(R.fmtWhen(w.day, t)) + (m ? ' · ' + m + ' min' : '') + ' · ' + plural(sets, 'set') + '</span></div>' +
        '<ul class="wk-lines">' + w.entries.slice(0, 6).map(function (e) { return '<li><span>' + esc(exOf(e.ex).name) + '</span><span class="num">' + esc(bestLine(e)) + '</span></li>'; }).join('') + '</ul>' +
        (prs.length ? '<span class="chip pr">🏆 ' + (prs.length === 1 ? 'A PR' : prs.length + ' PRs') + '</span>' : '') + (w.sample ? ' <span class="chip">Sample</span>' : '') + '</button>';
    });
    if (list.length > 120) html += '<p class="small muted center">Showing the latest 120. Export from Settings to see them all.</p>';
    return html;
  }

  /* ---------------- progress ---------------- */

  var lastChart = { pts: [], lift: null };
  var charts = typeof WeakMap === 'function' ? new WeakMap() : null;
  function metricsFor(ex) {
    return ex.kind === 'bodyweight' ? [['reps', 'Best set'], ['total', 'Total reps']] : [['e1rm', 'Estimated 1RM'], ['top', 'Heaviest set'], ['volume', 'Volume']];
  }
  function progressView() {
    var t = today();
    var lifts = R.liftsOf(state.workouts, state.custom);
    if (lifts.indexOf(state.lift) < 0) state.lift = lifts[0] || null;
    var st = R.streak(state.workouts, t, state.settings.perWeek);
    var month = state.workouts.filter(function (w) { return w.day > R.addDays(t, -28) && w.day <= t; });
    var weeks = R.groupWeeks(state.workouts, state.custom, t, 5);
    var setsThis = 0; Object.keys(weeks[4].sets).forEach(function (g) { setsThis += weeks[4].sets[g]; });
    var prCount = 0;
    lifts.forEach(function (id) { R.timeline(state.workouts, id, state.custom, U()).forEach(function (s) { if (s.day > R.addDays(t, -28) && s.prs.length) prCount++; }); });
    var html = '<div class="page-title"><h1>Progress</h1></div>';
    html += '<div class="tiles" style="margin-bottom:14px"><div class="tile"><b>' + month.length + '</b><span>Workouts, last 4 weeks</span></div><div class="tile"><b>' + st.current + '</b><span>Week streak</span></div><div class="tile"><b>' + setsThis + '</b><span>Sets this week</span></div><div class="tile"><b>' + prCount + '</b><span>PRs, last 4 weeks</span></div></div>';
    html += '<div class="prog-grid"><div>';
    if (state.lift) {
      var ex = exOf(state.lift);
      var ms = metricsFor(ex);
      if (!ms.some(function (m) { return m[0] === state.metric; })) state.metric = ms[0][0];
      html += '<section class="card"><div class="lift-pick" role="group" aria-label="Lift">' + lifts.map(function (id) { return '<button class="pill" type="button" data-act="lift" data-id="' + esc(id) + '" aria-pressed="' + (id === state.lift) + '">' + esc(exOf(id).name) + '</button>'; }).join('') + '</div>' +
        '<div class="sec" style="margin-top:8px"><h2>' + esc(ex.name) + '</h2><button class="link-btn small" type="button" data-act="exinfo" data-id="' + esc(ex.id) + '">History</button></div>' +
        '<div class="metric" role="group" aria-label="What to chart">' + ms.map(function (m) { return '<button class="pill" type="button" data-act="metric" data-m="' + m[0] + '" aria-pressed="' + (m[0] === state.metric) + '">' + esc(m[1]) + '</button>'; }).join('') + '</div>' +
        liftChart(state.lift, state.metric) + recordsHtml(state.lift) + '</section>';
    } else {
      html += '<section class="card"><h2>Charts</h2><p class="muted">Log a workout and every lift gets a chart here.</p></section>';
    }
    html += '</div><div>' + groupsCard(weeks) + calendarCard() + '</div></div>';
    return html;
  }
  function liftChart(id, metric) {
    var ex = exOf(id);
    var u = U();
    var tl = R.timeline(state.workouts, id, state.custom, u);
    var pts = [];
    tl.forEach(function (s) {
      var y = metric === 'e1rm' ? (s.e1rm ? R.fromKg(s.e1rm, u) : null) : metric === 'top' ? R.fromKg(s.topW, u) : metric === 'volume' ? R.fromKg(s.volume, u) : metric === 'reps' ? s.maxReps : s.volume;
      if (y === null) return;
      var kinds = { e1rm: ['e1rm'], top: ['weight'], volume: ['volume'], reps: ['reps', 'weight'], total: ['volume'] }[metric] || [];
      pts.push({ x: R.dayMs(s.day), y: Math.round(y * 10) / 10, s: s, pr: s.prs.some(function (p) { return kinds.indexOf(p.type) >= 0; }) });
    });
    lastChart = { pts: pts, lift: id };
    var unitLabel = metric === 'reps' || metric === 'total' ? 'reps' : u;
    var caption = { e1rm: 'Best estimated 1RM each session, ' + u, top: 'Heaviest set each session, ' + u, volume: 'Volume each session (weight × reps), ' + u, reps: 'Most reps in a set each session', total: 'Total reps each session' }[metric];
    return '<p class="chart-cap">' + esc(caption) + ' · <span class="pr-key" aria-hidden="true"></span> a PR</p>' + chartSvg(pts, unitLabel) + '<div class="readout" aria-live="polite">' + readout(lastChart, pts.length - 1) + '</div>';
  }
  /** The chart's own width in CSS pixels, so its 12px labels are 12px. */
  function chartWidth() {
    var vw = document.documentElement.clientWidth || 390;
    var open = !$('#sheet').hidden;
    var avail = open ? Math.min(vw, 640) - 64 : vw >= 1100 ? Math.min(vw - 232, 1180) * 0.58 - 100 : vw >= 900 ? Math.min(vw - 232, 1180) - 100 : Math.min(vw, 720) - 64;
    return Math.round(Math.max(280, Math.min(680, avail)));
  }
  function niceStep(range, n) {
    var raw = range / n;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  }
  function chartSvg(pts, unitLabel) {
    if (!pts.length) return '<p class="muted" style="margin-top:12px">Nothing to chart yet for this one.</p>';
    var W = chartWidth(), H = W < 480 ? 220 : 240, L = 46, Rr = 16, T = 22, B = 30;
    lastChart.W = W;
    var ys = pts.map(function (p) { return p.y; });
    var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
    if (hi - lo < 1) { hi += 2; lo -= 2; }
    var pad = (hi - lo) * 0.15; lo = Math.max(0, lo - pad); hi += pad;
    var step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    var x0 = pts[0].x, x1 = pts[pts.length - 1].x;
    if (x1 === x0) { x0 -= 3 * R.DAY_MS; x1 += 3 * R.DAY_MS; }
    var sx = function (x) { return L + (x - x0) / (x1 - x0) * (W - L - Rr); };
    var sy = function (y) { return T + (1 - (y - lo) / (hi - lo)) * (H - T - B); };
    var g = '<g class="grid axis">';
    for (var v = lo; v <= hi + step / 1000; v += step) {
      var y = sy(v).toFixed(1);
      g += '<line x1="' + L + '" x2="' + (W - Rr) + '" y1="' + y + '" y2="' + y + '"></line><text x="' + (L - 8) + '" y="' + (Number(y) + 4) + '" text-anchor="end">' + esc(R.fmtNum(Math.round(v * 10) / 10)) + '</text>';
    }
    var t = today();
    g += '<text x="' + L + '" y="' + (H - 8) + '" text-anchor="start">' + esc(R.fmtDay(pts[0].s.day, t)) + '</text>';
    if (pts.length > 1) g += '<text x="' + (W - Rr) + '" y="' + (H - 8) + '" text-anchor="end">' + esc(R.fmtDay(pts[pts.length - 1].s.day, t)) + '</text>';
    g += '</g>';
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + sx(p.x).toFixed(1) + ' ' + sy(p.y).toFixed(1); }).join(' ');
    var area = line + ' L' + sx(pts[pts.length - 1].x).toFixed(1) + ' ' + sy(lo).toFixed(1) + ' L' + sx(pts[0].x).toFixed(1) + ' ' + sy(lo).toFixed(1) + ' Z';
    var lastPr = -1;
    pts.forEach(function (p, i) { p.sxv = sx(p.x); if (p.pr) lastPr = i; });
    var wrapStart = '<div class="chart">';
    var dots = pts.map(function (p, i) {
      var cx = sx(p.x).toFixed(1), cy = sy(p.y).toFixed(1);
      var pr = p.pr;
      return '<circle class="hit" cx="' + cx + '" cy="' + cy + '" r="18" data-act="pt" data-i="' + i + '" tabindex="0" role="button" aria-label="' + esc(R.fmtDay(p.s.day, t) + ': ' + R.fmtNum(p.y) + ' ' + unitLabel + (pr ? ', PR' : '')) + '"></circle>' +
        '<circle class="pt' + (pr ? ' pr' : '') + '" data-pt="' + i + '" cx="' + cx + '" cy="' + cy + '" r="' + (pr ? 6 : 4.5) + '"></circle>';
    }).join('');
    var prMark = lastPr >= 0 ? '<text class="lab" x="' + sx(pts[lastPr].x).toFixed(1) + '" y="' + (sy(pts[lastPr].y) - 12).toFixed(1) + '" text-anchor="' + (lastPr === pts.length - 1 && pts.length > 1 ? 'end' : 'middle') + '">PR</text>' : '';
    return wrapStart + '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(pts.length + ' sessions charted; the readout below shows each one') + '">' + g +
      '<path class="area" d="' + area + '"></path><path class="ln" d="' + line + '"></path>' +
      '<line class="cross" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" visibility="hidden"></line>' + prMark + dots + '</svg></div>';
  }
  function readout(c, i) {
    var p = c.pts[i];
    if (!p) return '';
    var s = p.s, ex = exOf(c.lift);
    var bits = [];
    if (ex.kind === 'bodyweight' && s.topW < 0.01) bits.push(R.scheme(s) + ' reps');
    else bits.push(R.scheme(s) + ' at ' + (ex.kind === 'bodyweight' ? '+' : '') + fw(s.topW));
    if (s.e1rm) bits.push('est. 1RM ' + R.fmtE(s.e1rm, U()));
    if (ex.kind !== 'bodyweight') bits.push(R.fmtBig(R.shown(s.volume, U())) + ' ' + U() + ' moved');
    return '<b>' + esc(R.fmtDay(s.day, today())) + '</b> · ' + esc(bits.join(' · ')) + (s.prs.length ? '<div style="margin-top:6px">' + s.prs.map(function (x) { return '<span class="chip pr">🏆 ' + esc(x.title) + '</span>'; }).join(' ') + '</div>' : '');
  }
  /** The readout under a chart follows the pointer (snapped to the nearest
   *  session), a tap, or keyboard focus on a point. */
  function showPoint(wrap, i) {
    var c = wrap && charts && charts.get(wrap);
    var p = c && c.pts[i];
    if (!p) return;
    var ro = wrap.nextElementSibling; if (ro && ro.classList.contains('readout')) ro.innerHTML = readout(c, i);
    $$('.pt.on', wrap).forEach(function (x) { x.classList.remove('on'); });
    var dot = $('[data-pt="' + i + '"]', wrap); if (dot) dot.classList.add('on');
    var x = $('.cross', wrap); if (x) { x.setAttribute('x1', p.sxv.toFixed(1)); x.setAttribute('x2', p.sxv.toFixed(1)); x.setAttribute('visibility', 'visible'); }
  }
  function bindChart(root) {
    var wrap = $('.chart', root);
    var svg = wrap && $('svg', wrap);
    if (!svg || !charts) return;
    var c = lastChart;
    charts.set(wrap, c);
    svg.addEventListener('pointermove', function (e) {
      var r = svg.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width * (c.W || 640);
      var best = 0;
      c.pts.forEach(function (p, i) { if (Math.abs(p.sxv - x) < Math.abs(c.pts[best].sxv - x)) best = i; });
      showPoint(wrap, best);
    });
    $$('.hit', wrap).forEach(function (h) { h.addEventListener('focus', function () { showPoint(wrap, Number(h.getAttribute('data-i'))); }); });
  }
  function recordsHtml(id) {
    var ex = exOf(id);
    var sessions = R.sessionsOf(state.workouts, id, ex);
    if (!sessions.length) return '';
    var rec = R.recordsOf(sessions, ex);
    var s = R.suggest(sessions, ex, U());
    var tiles = ex.kind === 'bodyweight'
      ? [['Best set', plural(Math.max.apply(null, sessions.map(function (x) { return x.maxReps; })), 'rep')], ['Most reps in a session', R.fmtBig(rec.vol)], ['Sessions', sessions.length], ['Last time', R.scheme(sessions[sessions.length - 1])]]
      : [['Best est. 1RM', rec.e1rm ? R.fmtE(rec.e1rm, U()) : '-'], ['Heaviest', fw(rec.w)], ['Most volume', R.fmtBig(R.shown(rec.vol, U())) + ' ' + U()], ['Sessions', sessions.length]];
    return '<div class="recs">' + tiles.map(function (x) { return '<div class="tile"><b style="font-size:1.15rem">' + esc(x[1]) + '</b><span>' + esc(x[0]) + '</span></div>'; }).join('') + '</div>' +
      (s ? '<div class="beat" style="margin-top:12px">' + chip(s) + '<span>' + esc(s.text) + '</span></div>' : '');
  }
  function groupsCard(weeks) {
    var thisW = weeks[4], lastW = weeks[3];
    var view = state.weekView || (Object.keys(thisW.sets).length ? 'this' : 'last');
    var cur = view === 'this' ? thisW : lastW;
    var prior = view === 'this' ? weeks.slice(0, 4) : weeks.slice(0, 3);
    var groups = R.GROUPS.filter(function (g) { return weeks.some(function (w) { return w.sets[g.id]; }); });
    if (!groups.length) return '';
    var avg = {};
    groups.forEach(function (g) { avg[g.id] = Math.round(prior.reduce(function (n, w) { return n + (w.sets[g.id] || 0); }, 0) / prior.length * 10) / 10; });
    var max = Math.max.apply(null, groups.map(function (g) { return Math.max(cur.sets[g.id] || 0, avg[g.id]); })) || 1;
    return '<section class="card"><div class="sec" style="margin-top:0"><h2>Sets per muscle</h2><div class="metric" role="group" aria-label="Which week">' +
      [['this', 'This week'], ['last', 'Last week']].map(function (o) { return '<button class="pill" type="button" data-act="weekview" data-v="' + o[0] + '" aria-pressed="' + (view === o[0]) + '">' + o[1] + '</button>'; }).join('') + '</div></div>' +
      '<ul class="bars">' + groups.map(function (g) {
        var n = cur.sets[g.id] || 0;
        return '<li><span>' + esc(g.label) + '</span><span class="track" aria-hidden="true"><span class="fill" style="width:' + (n / max * 100).toFixed(1) + '%"></span><span class="avg" style="left:calc(' + (avg[g.id] / max * 100).toFixed(1) + '% - 1px)"></span></span><span class="v"><b>' + n + '</b> · avg ' + R.fmtNum(avg[g.id]) + '</span></li>';
      }).join('') + '</ul><div class="legend"><span><i class="f"></i>' + (view === 'this' ? 'This week so far' : 'Last week') + '</span><span><i class="a"></i>Weekly average, the ' + prior.length + ' weeks before</span></div>' +
      '<p class="small muted" style="margin:8px 0 0">Working sets, warm-ups left out. Many lifters aim for roughly 10-20 hard sets a muscle a week.</p></section>';
  }
  function calendarCard() {
    var t = today();
    var cols = R.calendar(state.workouts, t, 12);
    var total = 0; cols.forEach(function (c) { c.days.forEach(function (d) { if (!d.future) total += d.n; }); });
    var html = '<section class="card"><div class="sec" style="margin-top:0"><h2>Consistency</h2><span class="ct">last 12 weeks</span></div>' +
      '<div class="cal" role="img" aria-label="' + esc(plural(total, 'workout') + ' in the last 12 weeks') + '">';
    for (var j = 0; j < 7; j++) {
      html += '<span class="dl">' + (j % 2 === 0 ? R.WEEKDAYS[(j + 1) % 7].charAt(0) : '') + '</span>';
      cols.forEach(function (c) { var d = c.days[j]; html += '<span class="d' + (d.future ? ' fut' : d.n > 1 ? ' two' : d.n ? ' on' : '') + (d.today ? ' today' : '') + '"></span>'; });
    }
    var st = R.streak(state.workouts, t, state.settings.perWeek);
    return html + '</div><div class="cal-legend"><span><i class="on"></i>Trained</span><span><i></i>Rest day</span><span>' + plural(total, 'workout') + ' · best streak ' + plural(st.best, 'week') + '</span></div></section>';
  }

  /* ---------------- routines ---------------- */

  function routineCard(r, mine) {
    var lines = r.exercises.map(function (x) {
      var load = x.pct ? x.pct + '% 1RM' : (typeof x.w === 'number' && x.w > 0 ? fw(x.w) : '');
      return '<li><span>' + esc(exOf(x.ex).name) + '</span><span class="num">' + x.sets + 'x' + x.reps + (load ? ' · ' + esc(load) : '') + '</span></li>';
    }).join('');
    return '<div class="routine"><div class="routine-top"><b>' + esc(r.name) + '</b>' + (r.from === 'ai' ? '<span class="tag">AI plan</span>' : '') + '</div><ul>' + lines + '</ul><div class="row">' +
      '<button class="btn small" type="button" data-act="start" data-id="' + esc(r.id) + '">Start</button>' +
      (mine ? '<button class="btn small ghost" type="button" data-act="editroutine" data-id="' + esc(r.id) + '">Edit</button><button class="btn small danger" type="button" data-act="delroutine" data-id="' + esc(r.id) + '">Delete</button>'
        : '<button class="btn small ghost" type="button" data-act="copyroutine" data-id="' + esc(r.id) + '">Copy to mine</button>') + '</div></div>';
  }
  function routinesView() {
    var html = '<div class="page-title"><h1>Routines</h1><button class="btn small" type="button" data-act="newroutine">+ New routine</button></div>';
    html += '<section class="planbox"><h2>✨ Plan my next 4 weeks</h2><p class="muted">Pick a goal, your days and your equipment; AI builds four weeks around your recent numbers. Nothing is saved until you tap. Needs a free account - everything else is free.</p><button class="btn" type="button" data-act="plan">Plan my next 4 weeks</button></section>';
    var programs = {};
    var order = [];
    state.routines.forEach(function (r) { var k = r.program || ''; if (!programs[k]) { programs[k] = []; order.push(k); } programs[k].push(r); });
    if (state.routines.length) {
      html += '<div class="sec"><h2>Mine</h2><span class="ct">' + plural(state.routines.length, 'routine') + '</span></div>';
      order.forEach(function (k) {
        var list = programs[k].slice().sort(function (a, b) { return ((a.week || 0) - (b.week || 0)) || ((a.order || 0) - (b.order || 0)); });
        if (k) html += '<div class="prog"><div class="prog-head"><h3>' + esc(k) + '</h3><button class="link-btn small" type="button" data-act="delprogram" data-p="' + esc(k) + '">Delete all ' + list.length + '</button></div></div>';
        html += '<div class="rgrid">' + list.map(function (r) { return routineCard(r, true); }).join('') + '</div>';
      });
    }
    html += '<div class="sec" id="starters"><h2>Starter routines</h2><span class="ct">general templates, not advice</span></div><p class="small muted">Start lighter than you think, add weight only when every rep is clean, and leave a rep or two in the tank.</p>';
    R.STARTERS.forEach(function (p) {
      html += '<div class="prog"><div class="prog-head"><h3>' + esc(p.name) + '</h3><span class="tag">' + p.perWeek + ' days a week</span></div><p class="small muted" style="margin:4px 0 8px">' + esc(p.blurb) + '</p><div class="rgrid">' +
        R.STARTER_ROUTINES.filter(function (r) { return r.program === p.name; }).map(function (r) { return routineCard(r, false); }).join('') + '</div></div>';
    });
    return html;
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheet(html, bind) {
    var s = $('#sheet');
    var wasOpen = !s.hidden;
    var keepId = wasOpen && document.activeElement && s.contains(document.activeElement) ? document.activeElement.id : '';
    if (!wasOpen) lastFocus = document.activeElement;
    s.innerHTML = html;
    s.hidden = false; $('#sheetBack').hidden = false;
    document.body.classList.add('sheet-open');
    var h = $('#sheetTitle', s);
    s.setAttribute('aria-labelledby', 'sheetTitle');
    if (bind) bind(s);
    if (h) h.setAttribute('tabindex', '-1');
    if (wasOpen) { var again = keepId && document.getElementById(keepId); if (again) again.focus({ preventScroll: true }); return; }
    setTimeout(function () { var f = $('[autofocus]', s) || h; if (f) f.focus(); }, 30);
  }
  function closeSheet(noFocus) {
    var s = $('#sheet');
    if (s.hidden) return;
    s.hidden = true; s.innerHTML = ''; $('#sheetBack').hidden = true;
    document.body.classList.remove('sheet-open');
    state.plates = null; state.editor = null; state.armed = null; state.importing = null;
    if (state.ai) state.ai.open = false;
    if (!noFocus && lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) { /* gone */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('#party').hidden) { closeParty(); return; }
    if (!$('#sheet').hidden) closeSheet();
  });

  /** Pick an exercise: recent first, then the library by muscle, then yours. */
  function openPicker(title, onPick) {
    var q = '';
    function list() {
      var f = R.fold(q);
      var match = function (e) { return !f || R.fold(e.name).indexOf(f) >= 0; };
      var mine = Object.keys(state.custom).map(function (k) { return state.custom[k]; });
      var recent = R.liftsOf(state.workouts, state.custom).slice(0, 6).map(exOf).filter(match);
      var html = '';
      var btn = function (e) { return '<button class="ex-btn" type="button" data-pick="' + esc(e.id) + '">' + esc(e.name) + '<span>' + esc((R.KINDS.filter(function (k) { return k.id === e.kind; })[0] || {}).label || '') + (e.custom ? ' · yours' : '') + '</span></button>'; };
      if (recent.length && !f) html += '<div class="ex-group">Recent</div>' + recent.map(btn).join('');
      R.GROUPS.forEach(function (g) {
        var items = R.LIBRARY.concat(mine).filter(function (e) { return e.group === g.id && match(e); });
        if (items.length) html += '<div class="ex-group">' + esc(g.label) + '</div>' + items.map(btn).join('');
      });
      if (!html) html = '<p class="muted">Nothing called that yet.</p>';
      return html + '<button class="btn ghost block" type="button" id="mkCustom" style="margin-top:12px">+ Make a custom exercise' + (q.trim() ? ': “' + esc(q.trim().slice(0, 40)) + '”' : '') + '</button>';
    }
    sheet(head(title) + '<div class="search"><input class="input" id="exQ" type="search" placeholder="Search 43 exercises and yours" aria-label="Search exercises" autocomplete="off"></div><div id="exList">' + list() + '</div>', function (root) {
      var box = $('#exList', root);
      var bindList = function () {
        $$('[data-pick]', box).forEach(function (b) { b.addEventListener('click', function () { var id = b.getAttribute('data-pick'); closeSheet(true); onPick(id); }); });
        $('#mkCustom', box).addEventListener('click', function () { openCustom(q.trim(), onPick); });
      };
      $('#exQ', root).addEventListener('input', function (e) { q = e.target.value; box.innerHTML = list(); bindList(); });
      bindList();
    });
  }
  function openCustom(name, onPick) {
    var kind = R.guessKind(name || ''), group = R.guessGroup(name || '');
    sheet(head('A custom exercise') + '<form id="cxForm"><label class="field"><span>Name</span><input class="input" id="cxName" maxlength="' + R.LIMITS.name + '" value="' + esc(name || '') + '" required autofocus></label>' +
      '<div class="field"><span>Equipment</span><div class="pills" role="group" aria-label="Equipment">' + R.KINDS.map(function (k) { return '<button class="pill" type="button" data-k="' + k.id + '" aria-pressed="' + (k.id === kind) + '">' + esc(k.label) + '</button>'; }).join('') + '</div></div>' +
      '<label class="field"><span>Muscle group</span><select class="input" id="cxGroup">' + R.GROUPS.map(function (g) { return '<option value="' + g.id + '"' + (g.id === group ? ' selected' : '') + '>' + esc(g.label) + '</option>'; }).join('') + '</select></label>' +
      '<div id="cxErr"></div><button class="btn big block" type="submit">Add it</button></form>', function (root) {
      $$('[data-k]', root).forEach(function (b) { b.addEventListener('click', function () { kind = b.getAttribute('data-k'); $$('[data-k]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); }); });
      $('#cxForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        if (Object.keys(state.custom).length >= R.LIMITS.exercises) { $('#cxErr', root).innerHTML = '<p class="err">You have ' + R.LIMITS.exercises + ' custom exercises - that is the most Rep keeps.</p>'; return; }
        var ex = R.cleanExercise({ id: newId('c'), name: $('#cxName', root).value, kind: kind, group: $('#cxGroup', root).value, updatedAt: now() });
        if (!ex) { $('#cxErr', root).innerHTML = '<p class="err" role="alert">Give it a name.</p>'; return; }
        ex.updatedAt = now();
        state.custom[ex.id] = ex; saveLocal(); pushExercise(ex);
        closeSheet(true); onPick(ex.id);
      });
    });
  }

  /* ---------------- starting and the workout ---------------- */

  function start(routine) {
    if (state.active) { state.inWorkout = true; draw(); toast('Finish or discard the workout under way first.'); return; }
    var w = R.draftWorkout(routine, ctx());
    if (hasSample()) w.sample = true;
    state.active = w;
    state.inWorkout = true;
    pickCurrent(true);
    saveActive();
    closeSheet(true);
    draw(); scrollTo(0, 0);
    startTicker();
    if (!routine) setTimeout(function () { addExercise(); }, 60);
  }
  function openStartPick() {
    var mine = state.routines.slice(0, 30);
    var html = head('Start from a routine') + '<button class="btn ghost block" type="button" data-act="startempty">Start an empty workout</button>';
    if (mine.length) html += '<div class="ex-group">Mine</div>' + mine.map(function (r) { return '<button class="ex-btn" type="button" data-act="start" data-id="' + esc(r.id) + '">' + esc(r.name) + '<span>' + plural(r.exercises.length, 'exercise') + '</span></button>'; }).join('');
    R.STARTERS.forEach(function (p) {
      html += '<div class="ex-group">' + esc(p.name) + '</div>' + R.STARTER_ROUTINES.filter(function (r) { return r.program === p.name; }).map(function (r) { return '<button class="ex-btn" type="button" data-act="start" data-id="' + esc(r.id) + '">' + esc(r.name) + '<span>' + plural(r.exercises.length, 'exercise') + '</span></button>'; }).join('');
    });
    sheet(html);
  }
  function addExercise() {
    openPicker('Add an exercise', function (id) {
      var a = state.active;
      if (!a) return;
      if (a.entries.length >= R.LIMITS.entries) { toast('A workout holds up to ' + R.LIMITS.entries + ' exercises.'); return; }
      var hist = state.workouts.filter(function (w) { return w.id !== a.id; });
      var e = R.draftEntry({ ex: id }, { workouts: hist, custom: state.custom, settings: state.settings, today: today(), nowMs: now(), id: newId });
      if (!e) return;
      a.entries.push(e);
      a.cur = { e: a.entries.length - 1, s: 0 };
      fillConsole();
      saveActive(); draw();
      scrollToCur();
    });
  }
  function hist() { var a = state.active; return state.workouts.filter(function (w) { return !a || w.id !== a.id; }); }
  /** The set to log next: the first not yet done, from the current exercise on. */
  function pickCurrent(fill) {
    var a = state.active;
    if (!a) return;
    var n = a.entries.length;
    var startE = Math.min(a.cur.e || 0, Math.max(0, n - 1));
    for (var k = 0; k < n; k++) {
      var ei = (startE + k) % n;
      var si = a.entries[ei].sets.findIndex(function (s) { return !s.done; });
      if (si >= 0) { a.cur = { e: ei, s: si }; if (fill) fillConsole(); return; }
    }
    a.cur = { e: startE, s: -1 };
    if (fill) fillConsole();
  }
  /** The console shows the current set: its own numbers if it has them, else
   *  the set before it, else "beat last time". */
  function fillConsole() {
    var a = state.active;
    var e = a && a.entries[a.cur.e];
    var s = e && e.sets[a.cur.s];
    if (!s) { state.con = { w: '', r: '', rpe: null, warm: false }; return; }
    var w = s.w;
    if (w === null || w === undefined) {
      var prev = e.sets.slice(0, a.cur.s).reverse().find(function (x) { return x.done; });
      if (prev) w = prev.w;
    }
    state.con = { w: w === null || w === undefined ? '' : num(w), r: String(s.r), rpe: s.done ? s.rpe : null, warm: s.warm };
  }
  function doneCount() { var n = 0; state.active.entries.forEach(function (e) { e.sets.forEach(function (s) { if (s.done) n++; }); }); return n; }
  function excCard(e, ei) {
    var a = state.active;
    var ex = exOf(e.ex);
    var past = hist();
    var sug = R.suggest(R.sessionsOf(past, e.ex, ex), ex, U());
    var last = R.lastSets(past, e.ex, ex);
    var wi = 0;
    var rows = e.sets.map(function (s, si) {
      var lastTxt = '—';
      if (!s.warm) { var l = last[wi]; wi++; if (l) lastTxt = setWords(l, ex); }
      var on = a.cur.e === ei && a.cur.s === si;
      var nowTxt = s.done ? setWords(s, ex) + (s.rpe ? ' @' + R.fmtNum(s.rpe) : '') : (s.w === null ? 'pick × ' + s.r : setWords(s, ex));
      return '<li><button class="set' + (s.done ? ' done' : '') + (on ? ' on' : '') + '" type="button" data-act="sel" data-e="' + ei + '" data-s="' + si + '" aria-label="' + esc('Set ' + (si + 1) + (s.warm ? ' (warm-up)' : '') + ': ' + (s.done ? 'done, ' + nowTxt : 'planned, ' + nowTxt) + '. Last time ' + lastTxt) + '"' + (on ? ' aria-current="step"' : '') + '>' +
        '<span class="n' + (s.warm ? ' w' : '') + '">' + (s.warm ? 'W' : si + 1) + '</span><span class="last">' + esc(lastTxt) + '</span><span class="now' + (s.done ? '' : ' plan') + '">' + esc(nowTxt) + '</span><span class="ok" aria-hidden="true">' + (s.done ? '✓' : '') + '</span></button></li>';
    }).join('');
    var isCur = a.cur.e === ei;
    return '<section class="exc' + (isCur ? ' cur' : '') + '" id="exc' + ei + '"><div class="exc-head"><div class="t"><b>' + esc(ex.name) + '</b><span>' + esc(((R.KINDS.filter(function (k) { return k.id === ex.kind; })[0] || {}).label || '') + ' · rest ' + R.fmtClock(e.rest || R.restOf(ex, state.settings))) + (e.goal ? ' · ' + e.goal.sets + 'x' + e.goal.reps : '') + (e.pct ? ' · ' + e.pct + '% 1RM' : '') + '</span></div>' +
      '<div class="exc-tools">' + (ex.kind === 'barbell' ? '<button class="btn small ghost" type="button" data-act="plates" data-e="' + ei + '" aria-label="Plates for ' + esc(ex.name) + '">Plates</button>' : '') + '<button class="btn small ghost" type="button" data-act="exmenu" data-e="' + ei + '" aria-label="More for ' + esc(ex.name) + '">⋯</button></div></div>' +
      (sug ? '<div class="beat">' + chip(sug) + '<span>' + esc(sug.text) + '</span></div>' : '') +
      '<div class="set-head" aria-hidden="true"><span>Set</span><span>Last time</span><span>Today</span><span></span></div><ul class="sets">' + rows + '</ul>' +
      '<div class="exc-foot"><button class="btn small ghost" type="button" data-act="addset" data-e="' + ei + '">+ Add set</button><button class="btn small ghost" type="button" data-act="addwarm" data-e="' + ei + '">+ Warm-up</button></div></section>';
  }
  function restHtml() {
    var a = state.active;
    var t = a && a.rest;
    if (!t) return '';
    var left = R.restLeft(t.start, t.secs, now());
    var e = a.entries[a.cur.e];
    var next = !e || a.cur.s < 0 ? 'your next set' : e.ex === t.ex ? 'set ' + (a.cur.s + 1) : exOf(e.ex).name;
    if (left === 0) {
      return '<div class="rest done" id="rest" role="timer"><div><div class="lbl">Rest’s up - ' + esc(next) + '</div><div class="clock">Go</div></div><div class="ctl"><button type="button" data-act="restskip">Dismiss</button></div></div>';
    }
    return '<div class="rest" id="rest" role="timer" aria-label="Rest timer"><div><div class="lbl">Rest · then ' + esc(next) + '</div><div class="clock" id="restClock">' + R.fmtClock(left) + '</div></div>' +
      '<div class="ctl"><button type="button" data-act="rest-" aria-label="15 seconds less">−15</button><button type="button" data-act="rest+" aria-label="15 seconds more">+15</button><button type="button" data-act="restskip">Skip</button></div><div class="bar" aria-hidden="true"><i id="restBar" style="width:' + (R.restDone(t.start, t.secs, now()) * 100).toFixed(1) + '%"></i></div></div>';
  }
  function consoleHtml() {
    var a = state.active;
    var e = a.entries[a.cur.e];
    var s = e && e.sets[a.cur.s];
    if (!a.entries.length) {
      return '<div class="con-done"><p>Add your first exercise to start.</p><button class="btn big block go" type="button" data-act="addex" style="background:var(--con-go);color:var(--con-go-ink)">+ Add an exercise</button></div>';
    }
    if (!s) {
      var ce = e || a.entries[a.entries.length - 1];
      return '<div class="con-done"><p><b style="color:var(--con-ink)">Every planned set is logged.</b> Add a set, another exercise, or finish.</p><div class="row"><button class="btn ghost" type="button" data-act="addset" data-e="' + a.entries.indexOf(ce) + '">+ Set of ' + esc(exOf(ce.ex).name) + '</button><button class="btn ghost" type="button" data-act="addex">+ Exercise</button><button class="btn go" type="button" data-act="finish" style="background:var(--con-go);color:var(--con-go-ink)">Finish</button></div></div>';
    }
    var ex = exOf(e.ex);
    var last = R.lastSets(hist(), e.ex, ex);
    var wi = e.sets.slice(0, a.cur.s).filter(function (x) { return !x.warm; }).length;
    var l = s.warm ? null : last[wi];
    var prevDone = e.sets.slice(0, a.cur.s).concat(e.sets.slice(a.cur.s + 1)).filter(function (x) { return x.done; }).length > 0;
    var bw = ex.kind === 'bodyweight';
    var c = state.con;
    var rpes = [null, 6, 7, 7.5, 8, 8.5, 9, 9.5, 10];
    return '<div class="con-head"><b>' + esc(ex.name) + ' · ' + (s.warm ? 'Warm-up' : 'Set ' + (a.cur.s + 1) + ' of ' + e.sets.length) + '</b><span>' + (l ? 'last time ' + esc(setWords(l, ex)) : s.done ? 'logged - edit it' : 'new') + '</span></div>' +
      '<div class="con-row"><button class="step" type="button" data-act="w-" aria-label="Less weight">−</button><label class="con-val"><span class="vh">' + (bw ? 'Added weight' : 'Weight') + ' in ' + U() + '</span><input id="cw" inputmode="decimal" autocomplete="off" value="' + esc(c.w) + '" placeholder="' + (bw ? '0' : '—') + '"><span class="u" aria-hidden="true">' + (bw ? '+' + U() : U()) + '</span></label><button class="step" type="button" data-act="w+" aria-label="More weight">+</button></div>' +
      '<div class="con-row"><button class="step" type="button" data-act="r-" aria-label="One rep fewer">−</button><label class="con-val"><span class="vh">Reps</span><input id="cr" inputmode="numeric" autocomplete="off" value="' + esc(c.r) + '"><span class="u" aria-hidden="true">reps</span></label><button class="step" type="button" data-act="r+" aria-label="One more rep">+</button></div>' +
      '<div class="con-extra" role="group" aria-label="RPE and warm-up"><span class="lbl">RPE</span>' + rpes.map(function (v) { return '<button type="button" data-act="rpe" data-v="' + (v === null ? '' : v) + '" aria-pressed="' + (c.rpe === v) + '"' + (v === null ? ' aria-label="No RPE"' : '') + '>' + (v === null ? '–' : R.fmtNum(v)) + '</button>'; }).join('') +
      '<button type="button" data-act="warm" aria-pressed="' + Boolean(c.warm) + '">Warm-up</button></div>' +
      '<div class="con-go">' + (s.done
        ? '<button class="btn same" type="button" data-act="delset">Delete set</button><button class="btn go" type="button" data-act="log">Update set ✓</button>'
        : '<button class="btn same" type="button" data-act="same"' + (prevDone ? '' : ' disabled') + '>Same as last</button><button class="btn go" type="button" data-act="log">Log set ✓</button>') + '</div>';
  }
  function drawWorkout() {
    var a = state.active;
    var editing = state.workouts.some(function (w) { return w.id === a.id; });
    var html = '<div class="wk-head"><button class="btn small ghost icon-btn" type="button" data-act="minimize" aria-label="Back to the app - the workout keeps going"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
      '<div class="t"><b>' + esc(a.name) + (editing ? ' (editing)' : '') + '</b><span><span data-elapsed>' + R.fmtClock((now() - a.startedAt) / 1000) + '</span> · ' + plural(doneCount(), 'set') + '</span></div>' +
      '<button class="btn small" type="button" data-act="finish">' + (editing ? 'Save' : 'Finish') + '</button></div>';
    html += '<div class="wk-grid"><div class="wk-body" id="wkBody">' + (a.sample ? '<p class="small muted">🧪 Part of the sample month - cleared with it.</p>' : '') +
      a.entries.map(excCard).join('') +
      '<button class="btn ghost block big" type="button" data-act="addex">+ Add an exercise</button>' +
      '<div class="row" style="justify-content:center;margin-top:14px"><button class="link-btn" type="button" data-act="discard">' + (editing ? 'Stop editing (keep the saved copy)' : 'Discard this workout') + '</button></div>' +
      '<p class="safety">' + esc(SAFETY) + '</p></div>' +
      '<div class="wk-side" id="wkSide"><div id="restSlot">' + restHtml() + '</div>' + consoleHtml() + '</div></div>';
    main.innerHTML = html;
    bindConsole();
    fitBody();
    tick();
  }
  /** On a phone the console is pinned over the bottom of the page: leave
   *  room for it so the last set is never hidden under it. */
  function fitBody() {
    var side = $('#wkSide'), body = $('#wkBody');
    if (!side || !body) return;
    var fixed = getComputedStyle(side).position === 'fixed';
    body.style.paddingBottom = fixed ? (side.offsetHeight + 20) + 'px' : '';
  }
  function bindConsole() {
    var w = $('#cw'), r = $('#cr');
    if (w) w.addEventListener('input', function () { state.con.w = w.value; });
    if (r) r.addEventListener('input', function () { state.con.r = r.value; });
  }
  function scrollToCur() {
    var a = state.active;
    if (!a) return;
    setTimeout(function () {
      var row = $('#exc' + a.cur.e + ' .set.on') || $('#exc' + a.cur.e);
      if (!row) return;
      var side = $('#wkSide');
      var fixed = side && getComputedStyle(side).position === 'fixed';
      var r = row.getBoundingClientRect();
      var room = fixed ? innerHeight - side.offsetHeight : innerHeight;
      if (r.top < 80 || r.bottom > room - 12) scrollTo({ top: Math.max(0, scrollY + r.top - Math.min(140, room / 3)), behavior: REDUCED ? 'auto' : 'smooth' });
    }, 30);
  }
  function stepWeight(dir) {
    var u = U();
    var cur = R.parseNum(state.con.w);
    var step = R.stepOf(u);
    var a = state.active, e = a.entries[a.cur.e];
    var ex = e ? exOf(e.ex) : null;
    if (cur === null) cur = 0;
    var next = dir > 0 ? R.roundTo(Math.floor(cur / step + 1e-6) * step + step, step) : R.roundTo(Math.ceil(cur / step - 1e-6) * step - step, step);
    if (next < 0) next = 0;
    if (ex && ex.kind === 'barbell' && dir < 0 && next < state.settings.bar[u] && cur > state.settings.bar[u]) next = state.settings.bar[u];
    state.con.w = R.fmtNum(next);
    var i = $('#cw'); if (i) i.value = state.con.w;
  }
  function stepReps(dir) {
    var cur = R.intIn(String(state.con.r).trim(), 0, R.LIMITS.reps);
    var next = Math.max(0, Math.min(R.LIMITS.reps, (cur === null ? 0 : cur) + dir));
    state.con.r = String(next);
    var i = $('#cr'); if (i) i.value = state.con.r;
  }
  function logSet(same) {
    var a = state.active;
    var e = a && a.entries[a.cur.e];
    var s = e && e.sets[a.cur.s];
    if (!s) return;
    var ex = exOf(e.ex);
    var u = U();
    var w, r, rpe, warm;
    if (same) {
      var prev = e.sets.filter(function (x) { return x.done && x !== s; }).sort(function (x, y) { return (y.at || 0) - (x.at || 0); })[0];
      if (!prev) return;
      w = prev.w; r = prev.r; rpe = prev.rpe; warm = prev.warm;
    } else {
      w = String(state.con.w).trim() === '' && ex.kind === 'bodyweight' ? 0 : R.parseWeight(state.con.w, u);
      if (w === null) { toast('Type the weight - a number like 82.5.'); var iw = $('#cw'); if (iw) iw.focus(); return; }
      r = R.intIn(String(state.con.r).trim(), 0, R.LIMITS.reps);
      if (r === null) { toast('How many reps? A whole number.'); var ir = $('#cr'); if (ir) ir.focus(); return; }
      rpe = state.con.rpe; warm = state.con.warm;
    }
    var editing = s.done;
    var rec = R.recordsOf(R.sessionsOf(hist(), e.ex, ex), ex);
    a.entries.forEach(function (x) { if (x.ex === e.ex) x.sets.forEach(function (y) { if (y.done && y !== s) R.addToRecords(rec, y, ex); }); });
    s.w = w; s.r = r; s.rpe = rpe; s.warm = Boolean(warm); s.done = true; s.at = s.at || now();
    // Planned sets after this one, still blank, take this weight.
    e.sets.forEach(function (x, i) { if (i > a.cur.s && !x.done && (x.w === null || x.w === undefined) && !x.warm) x.w = w; });
    var prs = editing ? [] : R.setPrs(rec, s, ex, u);
    if (!editing && state.settings.autoRest) startRest(e, ex, s);
    if (!editing) { pickCurrent(true); }
    else fillConsole();
    saveActive();
    draw();
    scrollToCur();
    if (prs.length) celebrate('New PR!', ex.name + ' · ' + (ex.kind === 'bodyweight' ? setWords(s, ex) : fw(s.w) + ' × ' + s.r), prs);
    else say((editing ? 'Updated: ' : 'Logged: ') + setWords(s, ex));
  }
  function deleteSet() {
    var a = state.active, e = a.entries[a.cur.e];
    if (!e) return;
    e.sets.splice(a.cur.s, 1);
    if (!e.sets.length) e.sets.push({ w: null, r: (e.goal && e.goal.reps) || 5, rpe: null, warm: false, done: false });
    pickCurrent(true); saveActive(); draw(); toast('Set deleted.');
  }
  function addSet(ei, warmUp) {
    var a = state.active, e = a.entries[ei];
    if (!e) return;
    if (e.sets.length >= R.LIMITS.sets) { toast('An exercise holds up to ' + R.LIMITS.sets + ' sets.'); return; }
    var ex = exOf(e.ex);
    var src = e.sets.slice().reverse().find(function (x) { return !x.warm; }) || e.sets[e.sets.length - 1];
    var w = src ? src.w : null;
    if (warmUp) {
      var first = e.sets.find(function (x) { return !x.warm && x.w; });
      var base = first ? R.shown(first.w, U()) : null;
      var ww = base ? R.roundTo(base * 0.5, R.stepOf(U())) : null;
      if (ex.kind === 'barbell' && ww !== null && ww < state.settings.bar[U()]) ww = state.settings.bar[U()];
      var at = e.sets.findIndex(function (x) { return !x.warm; });
      e.sets.splice(at < 0 ? 0 : at, 0, { w: ww === null ? null : R.toKg(ww, U()), r: 5, rpe: null, warm: true, done: false });
      a.cur = { e: ei, s: at < 0 ? 0 : at };
    } else {
      e.sets.push({ w: w, r: src ? src.r : 5, rpe: null, warm: false, done: false });
      a.cur = { e: ei, s: e.sets.length - 1 };
    }
    fillConsole(); saveActive(); draw(); scrollToCur();
  }

  /* ---------------- the rest timer ---------------- */

  var actx = null;
  /** The audio context has to be made inside a tap, or the browser keeps it
   *  silent. Made on the tap that logs a set. */
  function wakeAudio() {
    if (!state.settings.sound) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!actx && AC) actx = new AC();
      if (actx && actx.state === 'suspended') actx.resume();
    } catch (e) { actx = null; }
  }
  function beep() {
    if (!state.settings.sound || !actx) return;
    try {
      [0, 0.28, 0.56].forEach(function (t, i) {
        var o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = i === 2 ? 1175 : 880;
        g.gain.setValueAtTime(0.0001, actx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.3, actx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + t + 0.22);
        o.connect(g); g.connect(actx.destination);
        o.start(actx.currentTime + t); o.stop(actx.currentTime + t + 0.25);
      });
    } catch (e) { /* no sound - the screen still says so */ }
  }
  function startRest(e, ex, s) {
    var secs = e.rest || R.restOf(ex, state.settings);
    if (s && s.warm) secs = Math.min(secs, 60);
    state.active.rest = { start: now(), secs: secs, ex: e.ex, alerted: false };
    wakeAudio();
    startTicker();
  }
  function restDone() {
    if (state.settings.vibrate && navigator.vibrate) try { navigator.vibrate([250, 120, 250, 120, 250]); } catch (e) { /* not on this phone */ }
    beep();
    say('Rest’s up.');
  }
  var ticker = null;
  function startTicker() { if (!ticker) ticker = setInterval(tick, 250); }
  function stopTicker() { clearInterval(ticker); ticker = null; document.title = TITLE; }
  function tick() {
    var a = state.active;
    if (!a) { stopTicker(); return; }
    var el = R.fmtClock((now() - a.startedAt) / 1000);
    $$('[data-elapsed]').forEach(function (x) { if (x.textContent !== el) x.textContent = el; });
    var t = a.rest;
    if (!t) { if (state.inWorkout) document.title = el + ' · Rep'; return; }
    var left = R.restLeft(t.start, t.secs, now());
    var clock = $('#restClock');
    if (clock) clock.textContent = R.fmtClock(left);
    var bar = $('#restBar');
    if (bar) bar.style.width = (R.restDone(t.start, t.secs, now()) * 100).toFixed(1) + '%';
    document.title = left ? R.fmtClock(left) + ' rest · Rep' : 'Rest’s up · Rep';
    if (left === 0 && !t.alerted) {
      t.alerted = true;
      saveActive();
      restDone();
      var slot = $('#restSlot'); if (slot) { slot.innerHTML = restHtml(); fitBody(); }
    }
  }
  function adjustRest(delta) {
    var a = state.active;
    if (!a || !a.rest) return;
    var t = R.restAdjust(a.rest, delta, now());
    a.rest = t.ended ? null : t;
    if (a.rest) a.rest.alerted = false;
    saveActive();
    var slot = $('#restSlot'); if (slot) { slot.innerHTML = restHtml(); fitBody(); }
    tick();
  }

  /* ---------------- finishing ---------------- */

  function openFinish() {
    var a = state.active;
    var w = R.finish(a, now());
    var editing = state.workouts.some(function (x) { return x.id === a.id; });
    if (!w) {
      sheet(head('Nothing logged yet') + '<p class="muted">Log at least one set to save a workout.</p><button class="btn big block" type="button" data-act="closesheet">Keep going</button><button class="btn danger block" type="button" data-act="discard" style="margin-top:10px">Discard this workout</button>');
      return;
    }
    var others = state.workouts.filter(function (x) { return x.id !== a.id; });
    var prs = R.workoutPrs(others, w, state.custom, U());
    var sets = 0, vol = 0;
    w.entries.forEach(function (e) { R.working(e.sets).forEach(function (s) { sets++; vol += s.w * s.r; }); });
    var html = head(editing ? 'Save your changes' : 'Finish workout') +
      '<div class="tiles"><div class="tile"><b>' + minutes(w) + '</b><span>' + (minutes(w) === 1 ? 'minute' : 'minutes') + '</span></div><div class="tile"><b>' + sets + '</b><span>working sets</span></div><div class="tile"><b>' + R.fmtBig(R.shown(vol, U())) + '</b><span>' + U() + ' moved</span></div><div class="tile"><b>' + prs.length + '</b><span>' + (prs.length === 1 ? 'lift' : 'lifts') + ' with a PR</span></div></div>' +
      (prs.length ? '<ul class="prs" style="margin-top:12px">' + prs.map(function (p) { return p.prs.map(function (x) { return '<li><span class="tro" aria-hidden="true">🏆</span><div><b>' + esc(p.name) + ' · ' + esc(x.title) + '</b><small>' + esc(x.text) + '</small></div></li>'; }).join(''); }).join('') + '</ul>' : '') +
      '<form id="finForm"><label class="field"><span>Name</span><input class="input" id="finName" maxlength="' + R.LIMITS.name + '" value="' + esc(a.name) + '"></label>' +
      '<label class="field"><span>A note for yourself (optional)</span><input class="input" id="finNote" maxlength="' + R.LIMITS.note + '" value="' + esc(a.note || '') + '" placeholder="Felt strong; left knee a bit stiff"><span class="hint">Stays in your log. Never sent to AI.</span></label>' +
      (!a.routineId && !editing ? '<label class="check"><input type="checkbox" id="finRoutine"> Save it as a routine too</label>' : '') +
      '<button class="btn big block" type="submit">' + (editing ? 'Save changes' : 'Save workout') + '</button></form>' +
      '<button class="btn ghost block" type="button" data-act="closesheet" style="margin-top:10px">Keep going</button>';
    sheet(html, function (root) {
      $('#finForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        a.name = $('#finName', root).value; a.note = $('#finNote', root).value;
        var asRoutine = $('#finRoutine', root) && $('#finRoutine', root).checked;
        saveWorkout(asRoutine, prs);
      });
    });
  }
  function saveWorkout(asRoutine, prs) {
    var a = state.active;
    var raw = R.finish(a, now());
    var w = raw && R.cleanWorkout(raw, { custom: state.custom });
    if (!w) return;
    if (a.sample) w.sample = true;
    var editing = state.workouts.some(function (x) { return x.id === w.id; });
    var old = state.workouts.find(function (x) { return x.id === w.id; });
    if (editing) w.endedAt = old.endedAt || w.endedAt;
    state.workouts = state.workouts.filter(function (x) { return x.id !== w.id; }).concat([w]).sort(R.byTime);
    if (asRoutine) {
      var r = R.cleanRoutine(R.routineFromWorkout(w, newId('r'), now()), state.custom);
      if (r) { state.routines.push(r); pushRoutine(r); }
    }
    // What comes next, now that this one is done (a workout from no routine
    // leaves a chosen plan where it was).
    if (w.routineId) {
      delete state.settings.upNext;
      var next = R.nextUp(state.workouts, state.routines);
      if (next) state.settings.upNext = next.id;
      saveSettings();
    }
    saveLocal(); pushWorkout(w);
    state.active = null; state.inWorkout = false; saveActive(); stopTicker();
    state.tab = editing ? 'history' : 'today';
    closeSheet(true); draw(); scrollTo(0, 0);
    if (!editing && prs && prs.length) {
      celebrate(prs.length === 1 ? 'A new PR' : 'New PRs today', w.name + ' · ' + (prs.length === 1 ? 'one lift' : prs.length + ' lifts') + ' beat their best', [].concat.apply([], prs.map(function (p) { return p.prs.map(function (x) { return { title: p.name + ' · ' + x.title, text: x.text }; }); })), 'Done');
    } else toast(editing ? 'Saved.' : 'Saved. Nice work.');
  }
  function discard() {
    if (state.armed !== 'discard') { state.armed = 'discard'; toast('Tap again to discard it.'); return; }
    state.active = null; state.inWorkout = false; state.armed = null; saveActive(); stopTicker();
    closeSheet(true); draw(); toast('Discarded.');
  }

  /* ---------------- the celebration ---------------- */

  function celebrate(title, what, prs, button) {
    var p = $('#party');
    p.innerHTML = '<div class="party-card" role="dialog" aria-modal="true" aria-labelledby="partyT"><div class="tro" aria-hidden="true">🏆</div><h2 id="partyT">' + esc(title) + '</h2><p class="what">' + esc(what) + '</p><ul>' +
      prs.slice(0, 6).map(function (x) { return '<li><b>' + esc(x.title) + '</b>' + esc(x.text) + '</li>'; }).join('') + '</ul><button class="btn big block" type="button" data-act="partyok" id="partyOk">' + esc(button || 'Keep going') + '</button></div>';
    p.hidden = false;
    say(title + ' ' + what);
    setTimeout(function () { var b = $('#partyOk'); if (b) b.focus(); }, 30);
    confetti();
  }
  function closeParty() { var p = $('#party'); p.hidden = true; p.innerHTML = ''; }
  $('#party').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeParty(); });

  /* ---------------- the plate calculator ---------------- */

  function openPlates(kg, label, fromConsole) {
    var u = U();
    var t = kg === null || kg === undefined ? (u === 'kg' ? 60 : 135) : R.shown(kg, u);
    state.plates = { target: t, label: label || '', edit: false, fromConsole: Boolean(fromConsole) };
    drawPlates();
  }
  function plateRow(list, u) {
    var hs = PLATE_H[u], cs = PLATE_COLOURS[u];
    return '<div class="platebar" aria-hidden="true"><span class="shaft"></span><span class="collar"></span>' + list.map(function (s) {
      return '<span class="plt" style="height:' + (hs[s] || 40) + 'px;background:' + (cs[s] || '#999') + ';width:' + (s >= (u === 'kg' ? 10 : 25) ? 18 : 12) + 'px"></span>';
    }).join('') + '<span class="end"></span></div>';
  }
  function plateChips(list, u) {
    if (!list.length) return '<p class="center muted">Just the bar.</p>';
    var counts = {};
    list.forEach(function (s) { counts[s] = (counts[s] || 0) + 1; });
    return '<div class="plate-list">' + Object.keys(counts).sort(function (a, b) { return b - a; }).map(function (s) { return '<span class="plate-chip"><i style="background:' + (PLATE_COLOURS[u][s] || '#999') + '"></i>' + (counts[s] > 1 ? counts[s] + ' × ' : '') + R.fmtNum(Number(s)) + '</span>'; }).join('') + '</div>';
  }
  function drawPlates() {
    var p = state.plates;
    var u = U();
    var bar = state.settings.bar[u];
    var counts = state.settings.plates[u];
    var res = R.plateMath(p.target, bar, counts, u);
    var html = head('Plate calculator') + (p.label ? '<p class="muted" style="margin:0 0 4px">' + esc(p.label) + '</p>' : '') +
      '<div class="big-target"><button class="step" type="button" id="ptMinus" aria-label="Less">−</button><label class="pt-val"><span class="vh">Target weight in ' + u + '</span><input id="ptTarget" inputmode="decimal" value="' + esc(R.fmtNum(p.target)) + '"><span class="u" aria-hidden="true">' + u + '</span></label><button class="step" type="button" id="ptPlus" aria-label="More">+</button></div>' +
      '<div class="row" role="group" aria-label="Bar" style="justify-content:center">' + R.BARS[u].map(function (b) { return '<button class="pill" type="button" data-bar="' + b + '" aria-pressed="' + (b === bar) + '">' + b + ' ' + u + ' bar</button>'; }).join('') +
      (R.BARS[u].indexOf(bar) < 0 ? '<button class="pill" type="button" aria-pressed="true">' + R.fmtNum(bar) + ' ' + u + ' bar</button>' : '') + '</div>';
    if (res.exact) {
      var side = res.perSide.reduce(function (n, x) { return n + x; }, 0);
      html += '<h3 class="center" style="margin-top:14px">Each side: ' + esc(R.platesText(res.perSide)) + (res.perSide.length ? ' ' + u : '') + '</h3><p class="center small muted" style="margin:0">' + esc(R.fmtNum(bar) + ' ' + u + ' bar + ' + R.fmtNum(side) + ' ' + u + ' a side = ' + R.fmtNum(res.total) + ' ' + u) + '</p>' + plateRow(res.perSide, u) + plateChips(res.perSide, u);
    } else if (res.why === 'under') {
      html += '<p class="note center" role="status">That is less than the empty bar (' + esc(R.fmtNum(bar) + ' ' + u) + ').</p>';
    } else {
      html += '<p class="note" role="status">' + (res.why === 'heavy' ? 'Your plates don’t add up to ' + esc(R.fmtNum(p.target) + ' ' + u) + '. The most they make is below.' : esc(R.fmtNum(p.target) + ' ' + u) + ' can’t be made exactly with your plates. Nearest:') + '</p>' +
        '<div class="near">' + [['below', res.below], ['above', res.above]].map(function (x) {
          if (!x[1]) return '<span></span>';
          return '<button class="btn ghost" type="button" data-near="' + x[1].total + '">' + esc(R.fmtNum(x[1].total) + ' ' + u) + '<small>' + x[0] + ' · ' + esc(R.platesText(x[1].perSide)) + ' a side</small></button>';
        }).join('') + '</div>';
      var show = res.below || res.above;
      if (show) html += plateRow(show.perSide, u);
    }
    if (p.fromConsole && state.active && res.exact) html += '<button class="btn big block" type="button" id="ptUse" style="margin-top:8px">Use ' + esc(R.fmtNum(res.total) + ' ' + u) + ' for this set</button>';
    html += '<button class="btn ghost block" type="button" id="ptEdit" style="margin-top:10px">' + (p.edit ? 'Done editing plates' : 'My plates and bar') + '</button>';
    if (p.edit) {
      html += '<p class="small muted" style="margin-top:12px">Pairs of each plate you have (one for each side). Saved on this phone.</p><div class="counts">' + R.PLATES[u].map(function (s) {
        var n = counts[String(s)] || 0;
        return '<div class="count"><button type="button" data-cnt="' + s + '" data-d="-1" aria-label="One pair fewer of ' + s + '">−</button><span>' + R.fmtNum(s) + ' ' + u + '<br>' + n + ' pair' + (n === 1 ? '' : 's') + '</span><button type="button" data-cnt="' + s + '" data-d="1" aria-label="One pair more of ' + s + '">+</button></div>';
      }).join('') + '</div><label class="field"><span>Another bar weight (' + u + ')</span><input class="input" id="ptBar" inputmode="decimal" value="' + esc(R.fmtNum(bar)) + '"></label>';
    }
    sheet(html, function (root) {
      var inp = $('#ptTarget', root);
      var set = function (v) { p.target = Math.max(0, Math.min(u === 'kg' ? 500 : 1100, v)); drawPlates(); };
      $('#ptMinus', root).addEventListener('click', function () { set(R.roundTo(p.target - R.stepOf(u), R.stepOf(u) / 2)); });
      $('#ptPlus', root).addEventListener('click', function () { set(R.roundTo(p.target + R.stepOf(u), R.stepOf(u) / 2)); });
      inp.addEventListener('change', function () { var n = R.parseNum(inp.value); if (n !== null) set(n); else inp.value = R.fmtNum(p.target); });
      $$('[data-bar]', root).forEach(function (b) { b.addEventListener('click', function () { state.settings.bar[u] = Number(b.getAttribute('data-bar')); saveSettings(); drawPlates(); }); });
      $$('[data-near]', root).forEach(function (b) { b.addEventListener('click', function () { set(Number(b.getAttribute('data-near'))); }); });
      $('#ptEdit', root).addEventListener('click', function () { p.edit = !p.edit; drawPlates(); });
      $$('[data-cnt]', root).forEach(function (b) {
        b.addEventListener('click', function () {
          var k = b.getAttribute('data-cnt');
          var n = Math.max(0, Math.min(20, (counts[k] || 0) + Number(b.getAttribute('data-d'))));
          if (n) counts[k] = n; else delete counts[k];
          saveSettings(); drawPlates();
        });
      });
      var pb = $('#ptBar', root);
      if (pb) pb.addEventListener('change', function () { state.settings.bar[u] = R.cleanBar(pb.value, u); saveSettings(); drawPlates(); });
      var use = $('#ptUse', root);
      if (use) use.addEventListener('click', function () { state.con.w = R.fmtNum(res.total); closeSheet(true); draw(); });
    });
  }

  /* ---------------- one exercise: its menu, its history ---------------- */

  function openExMenu(ei) {
    var a = state.active, e = a.entries[ei];
    if (!e) return;
    var ex = exOf(e.ex);
    var rest = e.rest || R.restOf(ex, state.settings);
    sheet(head(ex.name) +
      '<div class="field"><span>Rest between sets</span><div class="big-target"><button class="step" type="button" id="rsMinus" aria-label="15 seconds less">−</button><input id="rsVal" readonly value="' + R.fmtClock(rest) + '" aria-label="Rest"><button class="step" type="button" id="rsPlus" aria-label="15 seconds more">+</button></div><span class="hint">Remembered for ' + esc(ex.name) + ' from now on.</span></div>' +
      '<div class="row"><button class="btn ghost" type="button" id="mvUp"' + (ei === 0 ? ' disabled' : '') + '>Move up</button><button class="btn ghost" type="button" id="mvDown"' + (ei === a.entries.length - 1 ? ' disabled' : '') + '>Move down</button><button class="btn ghost" type="button" data-act="exinfo" data-id="' + esc(e.ex) + '">History and chart</button></div>' +
      '<button class="btn danger block" type="button" id="rmEx" style="margin-top:14px">Remove from this workout</button>', function (root) {
      var setRest = function (d) {
        rest = Math.max(R.LIMITS.restMin, Math.min(R.LIMITS.restMax, rest + d));
        e.rest = rest; state.settings.rest[ex.id] = rest; saveSettings(); saveActive();
        $('#rsVal', root).value = R.fmtClock(rest);
      };
      $('#rsMinus', root).addEventListener('click', function () { setRest(-15); });
      $('#rsPlus', root).addEventListener('click', function () { setRest(15); });
      var move = function (d) { var j = ei + d; var t = a.entries[j]; a.entries[j] = e; a.entries[ei] = t; if (a.cur.e === ei) a.cur.e = j; else if (a.cur.e === j) a.cur.e = ei; saveActive(); closeSheet(true); draw(); };
      $('#mvUp', root).addEventListener('click', function () { move(-1); });
      $('#mvDown', root).addEventListener('click', function () { move(1); });
      var armed = false;
      $('#rmEx', root).addEventListener('click', function () {
        if (!armed) { armed = true; this.textContent = e.sets.some(function (s) { return s.done; }) ? 'Tap again - its logged sets go too' : 'Tap again to remove'; return; }
        a.entries.splice(ei, 1);
        a.cur = { e: Math.max(0, Math.min(ei, a.entries.length - 1)), s: 0 };
        pickCurrent(true); saveActive(); closeSheet(true); draw();
      });
    });
  }
  function openExInfo(id) {
    var ex = exOf(id);
    var keepLift = state.lift, keepMetric = state.metric;
    state.lift = id;
    state.metric = ex.kind === 'bodyweight' ? 'reps' : 'e1rm';
    var tl = R.timeline(state.workouts, id, state.custom, U());
    var t = today();
    var rows = tl.slice(-12).reverse().map(function (s) {
      return '<tr><td>' + esc(R.fmtDay(s.day, t)) + '</td><td>' + esc(s.sets.map(function (x) { return setWords(x, ex); }).join(', ')) + '</td><td>' + (s.prs.length ? '🏆' : '') + '</td></tr>';
    }).join('');
    sheet(head(ex.name) + '<p class="muted" style="margin:0">' + esc(((R.KINDS.filter(function (k) { return k.id === ex.kind; })[0] || {}).label || '') + ' · ' + ((R.GROUPS.filter(function (g) { return g.id === ex.group; })[0] || {}).label || '')) + '</p>' +
      liftChart(id, state.metric) + recordsHtml(id) +
      (rows ? '<div class="detail-ex"><table><thead><tr><th>Day</th><th>Sets</th><th><span class="vh">PR</span></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '') +
      (ex.kind === 'barbell' ? '<button class="btn ghost block" type="button" id="infoPlates">🧮 Plates for the next weight</button>' : ''), function (root) {
      bindChart(root);
      var b = $('#infoPlates', root);
      if (b) b.addEventListener('click', function () { var s = suggestFor(id); openPlates(s && s.w, ex.name + (s && s.w ? ' · next: ' + fw(s.w) : ''), false); });
    });
    state.lift = keepLift || id; state.metric = keepMetric;
  }

  /* ---------------- a past workout ---------------- */

  function openWorkout(id) {
    var w = state.workouts.find(function (x) { return x.id === id; });
    if (!w) return;
    var t = today();
    var prs = R.workoutPrs(state.workouts, w, state.custom, U());
    var m = minutes(w);
    var html = head(w.name) + '<p class="muted" style="margin:0">' + esc(R.fmtWhen(w.day, t) + (R.fmtWhen(w.day, t) !== R.fmtDay(w.day, t) ? ', ' + R.fmtDay(w.day, t) : '')) + (m ? ' · ' + m + ' min' : '') + (w.sample ? ' · sample' : '') + '</p>' +
      (w.note ? '<p class="note">' + esc(w.note) + '</p>' : '') +
      (prs.length ? '<ul class="prs" style="margin-top:12px">' + prs.map(function (p) { return p.prs.map(function (x) { return '<li><span class="tro" aria-hidden="true">🏆</span><div><b>' + esc(p.name) + ' · ' + esc(x.title) + '</b><small>' + esc(x.text) + '</small></div></li>'; }).join(''); }).join('') + '</ul>' : '') +
      w.entries.map(function (e) {
        var ex = exOf(e.ex);
        return '<div class="detail-ex"><h3>' + esc(ex.name) + '</h3><table><thead><tr><th>Set</th><th>' + (ex.kind === 'bodyweight' ? 'Added' : 'Weight') + '</th><th>Reps</th><th>RPE</th></tr></thead><tbody>' + e.sets.map(function (s, i) {
          return '<tr><td>' + (s.warm ? 'W' : i + 1) + '</td><td>' + esc(ex.kind === 'bodyweight' && s.w < 0.004 ? '-' : fw(s.w)) + '</td><td>' + s.r + '</td><td>' + (s.rpe ? R.fmtNum(s.rpe) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      }).join('') +
      '<div class="row" style="margin-top:12px"><button class="btn" type="button" data-act="repeat" data-id="' + esc(w.id) + '">Do it again</button><button class="btn ghost" type="button" data-act="editwo" data-id="' + esc(w.id) + '">Edit sets</button><button class="btn ghost" type="button" data-act="asroutine" data-id="' + esc(w.id) + '">Save as routine</button></div>' +
      '<button class="btn danger block" type="button" data-act="delwo" data-id="' + esc(w.id) + '" style="margin-top:12px">Delete this workout</button>';
    sheet(html);
  }

  /* ---------------- the routine editor ---------------- */

  function openEditor(r) {
    state.editor = r ? JSON.parse(JSON.stringify(r)) : { id: newId('r'), name: '', program: null, week: null, order: 0, from: 'me', exercises: [], fresh: true };
    drawEditor();
  }
  function drawEditor() {
    var r = state.editor;
    var opts = function (lo, hi, v) { var o = ''; for (var i = lo; i <= hi; i++) o += '<option' + (i === v ? ' selected' : '') + '>' + i + '</option>'; return o; };
    sheet(head(r.fresh ? 'New routine' : 'Edit routine') + '<form id="edForm"><label class="field"><span>Name</span><input class="input" id="edName" maxlength="' + R.LIMITS.name + '" value="' + esc(r.name) + '" placeholder="Upper A" required></label>' +
      (r.exercises.length ? r.exercises.map(function (x, i) {
        return '<div class="note"><div class="row" style="justify-content:space-between"><b>' + esc(exOf(x.ex).name) + '</b><button class="link-btn small" type="button" data-rm="' + i + '">Remove</button></div><div class="two"><label class="field" style="margin:4px 0"><span>Sets</span><select class="input" data-sets="' + i + '">' + opts(1, 10, x.sets) + '</select></label><label class="field" style="margin:4px 0"><span>Reps</span><select class="input" data-reps="' + i + '">' + opts(1, 30, x.reps) + '</select></label></div></div>';
      }).join('') : '<p class="muted">No exercises yet.</p>') +
      '<button class="btn ghost block" type="button" id="edAdd">+ Add an exercise</button><div id="edErr"></div>' +
      '<button class="btn big block" type="submit" style="margin-top:12px">Save routine</button></form>', function (root) {
      $('#edName', root).addEventListener('input', function (e) { r.name = e.target.value; });
      $$('[data-sets]', root).forEach(function (s) { s.addEventListener('change', function () { r.exercises[Number(s.getAttribute('data-sets'))].sets = Number(s.value); }); });
      $$('[data-reps]', root).forEach(function (s) { s.addEventListener('change', function () { r.exercises[Number(s.getAttribute('data-reps'))].reps = Number(s.value); }); });
      $$('[data-rm]', root).forEach(function (b) { b.addEventListener('click', function () { r.exercises.splice(Number(b.getAttribute('data-rm')), 1); drawEditor(); }); });
      $('#edAdd', root).addEventListener('click', function () {
        if (r.exercises.length >= R.LIMITS.routineItems) { $('#edErr', root).innerHTML = '<p class="err">A routine holds up to ' + R.LIMITS.routineItems + ' exercises.</p>'; return; }
        var keepR = r;
        openPicker('Add to ' + (r.name || 'the routine'), function (id) { var ex = exOf(id); keepR.exercises.push({ ex: id, sets: 3, reps: ex.kind === 'barbell' ? 5 : 10, rest: null, pct: null, w: null }); state.editor = keepR; drawEditor(); });
      });
      $('#edForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        r.updatedAt = now();
        var clean = R.cleanRoutine(r, state.custom);
        if (!clean) { $('#edErr', root).innerHTML = '<p class="err" role="alert">A routine needs a name and at least one exercise.</p>'; return; }
        var i = state.routines.findIndex(function (x) { return x.id === clean.id; });
        if (i < 0 && state.routines.length >= R.LIMITS.routines) { $('#edErr', root).innerHTML = '<p class="err">You can keep up to ' + R.LIMITS.routines + ' routines.</p>'; return; }
        if (i >= 0) state.routines[i] = clean; else state.routines.push(clean);
        saveLocal(); pushRoutine(clean); closeSheet(true); state.tab = 'routines'; draw(); toast('Routine saved.');
      });
    });
  }
  function copyStarter(id) {
    var src = R.routineById(id, []);
    if (!src) return;
    var r = R.cleanRoutine({ id: newId('r'), name: src.name, program: src.program, order: src.order, from: 'me', exercises: src.exercises, updatedAt: now() }, state.custom);
    if (!r) return;
    state.routines.push(r); saveLocal(); pushRoutine(r); draw(); toast(src.name + ' is in your routines - edit it however you like.');
  }

  /* ---------------- "Plan my next 4 weeks" (the one model call) ---------------- */

  function openPlan() {
    if (!state.ai) state.ai = { goal: 'strength', days: 3, equipment: ['barbell', 'dumbbell', 'bodyweight'], plan: null, busy: false };
    state.ai.open = true;
    drawPlan();
  }
  function briefNow() { var a = state.ai; return R.planBrief(state.workouts, state.custom, today(), U(), { goal: a.goal, days: a.days, equipment: a.equipment }); }
  function sentLine(b) {
    var parts = ['Goal: ' + b.goal, b.days + ' days a week', b.equipment.join(', ') || 'no equipment picked', b.unit];
    var lifts = b.lifts.slice(0, 6).map(function (l) { var n = R.matchExercise(l.ex) ? exOf(l.ex).name : l.ex; return n + (l.e1rm ? ' (e1RM ' + R.fmtNum(Math.round(l.e1rm * 10) / 10) + ')' : l.best.r ? ' (best ' + l.best.r + ' reps)' : ''); });
    return parts.join(' · ') + (b.lifts.length ? ' · ' + plural(b.lifts.length, 'lift') + ': ' + lifts.join(', ') + (b.lifts.length > 6 ? ' and ' + (b.lifts.length - 6) + ' more' : '') : ' · no history yet') + '. Never your name, your notes or your dates.';
  }
  function loadText(it, wk) {
    var p = it.weeks[wk];
    var u = U();
    if (p.pct) {
      var id = it.ex || null;
      var best = id ? R.bestE1rm(R.sessionsOf(state.workouts, id, exOf(id)), R.addDays(today(), -56)) : null;
      return p.pct + '%' + (best ? ' ≈ ' + R.fmtNum(R.roundTo(R.shown(best, u) * p.pct / 100, R.stepOf(u))) + ' ' + u : ' of 1RM');
    }
    if (p.w !== null && p.w > 0) return fw(p.w);
    return '';
  }
  function drawPlan() {
    var a = state.ai;
    var html = head('Plan my next 4 weeks');
    if (a.plan) {
      var pl = a.plan;
      var wkOn = a.week || 0;
      html += (pl.summary ? '<p>' + esc(pl.summary) + '</p>' : '') + '<div class="weeks" role="group" aria-label="Week">' + [0, 1, 2, 3].map(function (wk) { return '<button class="pill" type="button" data-act="aiweek" data-v="' + wk + '" aria-pressed="' + (wk === wkOn) + '">Week ' + (wk + 1) + '</button>'; }).join('') + '</div>' + [wkOn].map(function (wk) {
        return '<div class="plan-week">' + (wk === 3 ? '<p class="small muted" style="margin:0 0 8px">A lighter week, to recover before the next block.</p>' : '') + pl.days.map(function (d) {
          return '<div class="plan-day"><b>' + esc(d.name) + '</b><ul>' + d.exercises.map(function (it) {
            var name = it.ex ? exOf(it.ex).name : it.custom;
            var p = it.weeks[wk];
            var load = loadText(it, wk);
            return '<li><span>' + esc(name) + (it.custom ? ' <span class="tag">custom</span>' : '') + '</span><span>' + p.sets + 'x' + p.reps + (load ? ' · ' + esc(load) : '') + '</span></li>';
          }).join('') + '</ul></div>';
        }).join('') + '</div>';
      }).join('') +
        '<button class="btn big block" type="button" data-act="plansave">Save as ' + plural(pl.days.length * 4, 'routine') + '</button>' +
        '<div class="row" style="margin-top:10px"><button class="btn ghost" type="button" data-act="planagain">Change and plan again</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button></div>' +
        '<p class="small muted" style="margin-top:10px">A general template made by AI from your numbers - not advice. Adjust any weight that feels wrong, and stop if something hurts.</p>';
      sheet(html);
      return;
    }
    var b = briefNow();
    html += '<p class="muted" style="margin-top:0">AI builds four weeks around your recent numbers: three building weeks and a lighter fourth. You see it first; it is saved as routines only if you tap.</p>' +
      '<div class="field"><span>Goal</span><div class="pills" role="group" aria-label="Goal">' + R.GOALS.map(function (g) { return '<button class="pill" type="button" data-act="aigoal" data-v="' + g.id + '" aria-pressed="' + (a.goal === g.id) + '">' + esc(g.label) + ' <span class="small" style="font-weight:600">· ' + esc(g.hint) + '</span></button>'; }).join('') + '</div></div>' +
      '<div class="field"><span>Days a week</span><div class="pills" role="group" aria-label="Days a week">' + [2, 3, 4, 5, 6].map(function (n) { return '<button class="pill" type="button" data-act="aidays" data-v="' + n + '" aria-pressed="' + (a.days === n) + '">' + n + '</button>'; }).join('') + '</div></div>' +
      '<div class="field"><span>Equipment you have</span><div class="pills" role="group" aria-label="Equipment">' + R.KINDS.map(function (k) { return '<button class="pill" type="button" data-act="aieq" data-v="' + k.id + '" aria-pressed="' + (a.equipment.indexOf(k.id) >= 0) + '">' + esc(k.label) + '</button>'; }).join('') + '</div></div>' +
      '<div class="field"><span>What is sent</span><div class="sent">' + esc(sentLine(b)) + '</div></div><div id="aiErr"></div>';
    if (signedIn()) {
      html += '<button class="btn big block" type="button" data-act="doplan"' + (a.busy || !a.equipment.length ? ' disabled' : '') + '>' + (a.busy ? 'Planning… this takes about 20 seconds' : 'Plan my 4 weeks') + '</button><p class="small muted center" style="margin-top:8px">About two cents of AI credit.</p>';
    } else {
      html += '<div class="note"><b>This one needs a free account.</b><p class="small muted" style="margin:4px 0 10px">AI costs money to run, so planning is for signed-in accounts (with $2 of free credit). Logging, the timer, plates, PRs, charts, routines and the starters stay free without one.</p><div class="row"><button class="btn" type="button" data-act="signup">Create a free account</button><button class="btn ghost" type="button" data-act="signin">Sign in</button></div></div>';
    }
    sheet(html);
  }
  function doPlan() {
    var a = state.ai;
    if (a.busy) return;
    a.busy = true; drawPlan();
    api('POST', 'api/plan', briefNow()).then(function (r) {
      a.busy = false; a.plan = r.plan; a.week = 0;
      if (a.open) drawPlan();
    }).catch(function (e) {
      a.busy = false;
      if (!a.open) return;
      drawPlan();
      var where = $('#aiErr');
      if (e.status === 403 && e.data && e.data.code === 'verify-email') verifyNote(where, e);
      else showError(e, where);
    });
  }
  function savePlan() {
    var a = state.ai;
    if (!a || !a.plan) return;
    var out = R.planRoutines(a.plan, { custom: state.custom, id: newId, nowMs: now(), label: 'My 4-week plan · ' + R.fmtDay(today(), today()) });
    if (state.routines.length + out.routines.length > R.LIMITS.routines) { toast('That would be more than ' + R.LIMITS.routines + ' routines. Delete an older plan first.'); return; }
    Object.keys(out.custom).forEach(function (k) { state.custom[k] = out.custom[k]; pushExercise(out.custom[k]); });
    var clean = out.routines.map(function (r) { return R.cleanRoutine(r, state.custom); }).filter(Boolean);
    clean.forEach(function (r) { state.routines.push(r); pushRoutine(r); });
    if (clean.length) state.settings.upNext = clean[0].id;
    saveSettings(); saveLocal();
    state.ai = null; closeSheet(true); state.tab = 'today'; draw(); scrollTo(0, 0);
    toast('Saved ' + plural(clean.length, 'routine') + '. ' + (clean[0] ? clean[0].name + ' is up next.' : ''));
  }

  /* ---------------- settings, export, import ---------------- */

  function openSettings() {
    var s = state.settings;
    var tog = function (k, label) { return '<label class="check"><input type="checkbox" data-tog="' + k + '"' + (s[k] ? ' checked' : '') + '> ' + esc(label) + '</label>'; };
    sheet(head('Settings') +
      '<div class="field"><span>Units</span><div class="pills" role="group" aria-label="Units">' + ['kg', 'lb'].map(function (u) { return '<button class="pill" type="button" data-act="unit" data-u="' + u + '" aria-pressed="' + (s.unit === u) + '">' + u + '</button>'; }).join('') + '</div><span class="hint">Everything is kept exactly and shown in your choice - switch any time.</span></div>' +
      '<div class="field"><span>Workouts a week for the streak</span><div class="pills" role="group" aria-label="Workouts a week">' + [1, 2, 3, 4, 5, 6].map(function (n) { return '<button class="pill" type="button" data-pw="' + n + '" aria-pressed="' + (s.perWeek === n) + '">' + n + '</button>'; }).join('') + '</div></div>' +
      '<div class="field"><span>Rest timer</span>' + tog('autoRest', 'Start it after every set') + tog('sound', 'Beep at zero') + tog('vibrate', 'Vibrate at zero (where the phone allows)') + '</div>' +
      '<button class="btn ghost block" type="button" data-act="plates">🧮 Plates and bar</button>' +
      '<h3>Your data</h3><p class="small muted">Everything is on this phone' + (syncOn() ? ' and in your account' : '') + '. Take a copy any time, or bring in a CSV from another app (Date, Exercise, Weight, Reps).</p>' +
      '<div class="row"><button class="btn ghost" type="button" data-act="exportjson">Export JSON</button><button class="btn ghost" type="button" data-act="exportcsv">Export CSV</button><button class="btn ghost" type="button" id="impBtn">Import a file</button></div>' +
      '<input type="file" id="impFile" accept=".json,.csv,application/json,text/csv" hidden><div id="impOut"></div>' +
      '<button class="btn danger block" type="button" data-act="wipe" style="margin-top:16px">Clear everything on this phone</button>' +
      '<p class="small muted" style="margin-top:8px">Settings stay on this phone.' + (signedIn() ? ' Clearing this phone leaves your account’s copy alone.' : '') + '</p>', function (root) {
      $$('[data-tog]', root).forEach(function (c) { c.addEventListener('change', function () { s[c.getAttribute('data-tog')] = c.checked; saveSettings(); }); });
      $$('[data-pw]', root).forEach(function (b) { b.addEventListener('click', function () { s.perWeek = Number(b.getAttribute('data-pw')); saveSettings(); $$('[data-pw]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); draw(); }); });
      var file = $('#impFile', root);
      $('#impBtn', root).addEventListener('click', function () { file.click(); });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (!f) return;
        if (f.size > R.LIMITS.importBytes) { $('#impOut', root).innerHTML = '<p class="err" role="alert">That file is too big to bring in (2 MB at most).</p>'; return; }
        var rd = new FileReader();
        rd.addEventListener('load', function () { previewImport(String(rd.result || ''), f.name, $('#impOut', root)); });
        rd.readAsText(f);
      });
    });
  }
  function previewImport(text, name, where) {
    var got;
    try {
      got = /\.csv$/i.test(name) || !/^\s*\{/.test(text) ? R.importCsv(text, { unit: U(), today: today(), custom: state.custom }) : R.importJson(text, { today: today(), custom: state.custom });
    } catch (e) { where.innerHTML = '<p class="err" role="alert">' + esc(e.message) + '</p>'; return; }
    state.importing = got;
    var nCustom = Object.keys(got.custom).length;
    where.innerHTML = '<div class="note" role="status"><b>Found ' + plural(got.workouts.length, 'workout') + (got.routines.length ? ', ' + plural(got.routines.length, 'routine') : '') + (nCustom ? ' and ' + plural(nCustom, 'custom exercise') : '') + '.</b>' + (got.skipped ? '<p class="small muted" style="margin:4px 0 0">' + plural(got.skipped, 'row') + ' could not be read and will be left out.</p>' : '') +
      '<p class="small muted" style="margin:4px 0 8px">Workouts you already have are kept unless the file’s copy is newer.' + (hasSample() ? ' The sample month will be cleared.' : '') + '</p><button class="btn" type="button" id="impGo">Bring them in</button></div>';
    $('#impGo', where).addEventListener('click', function () { doImport(); });
  }
  function doImport() {
    var got = state.importing;
    if (!got) return;
    Object.keys(got.custom).forEach(function (k) { if (!state.custom[k] && Object.keys(state.custom).length < R.LIMITS.exercises) state.custom[k] = got.custom[k]; });
    state.workouts = R.mergeById(real(), got.workouts.filter(function (w) { return w.entries.every(function (e) { return R.knownId(e.ex, state.custom); }); })).sort(R.byTime).slice(-R.LIMITS.workouts);
    state.routines = R.mergeById(state.routines, got.routines).slice(0, R.LIMITS.routines);
    saveLocal();
    var n = got.workouts.length;
    state.importing = null;
    closeSheet(true); draw();
    toast('Brought in ' + plural(n, 'workout') + '.');
    if (syncOn()) syncIn(false);
  }

  /* ---------------- the account ---------------- */

  var FREE_LINE = 'Rep works without an account. A free account keeps your log on all your phones and unlocks “Plan my next 4 weeks”, with $2 of AI credit. One account works across every app on this site.';
  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }
  function openAccount(reason, then, login) {
    var mode = login ? 'login' : 'register';
    function draw2(root) {
      $('.body', root).innerHTML = head(mode === 'register' ? 'Create a free account' : 'Welcome back') +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
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
          .then(function () { closeSheet(true); return loadMe(); }).then(function () { toast('You’re in.'); syncIn(true); if (then) then(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(true); return loadMe(); }).then(function () { syncIn(true); if (then) then(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openAccountSheet() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(head('Account') + '<p class="small muted" style="overflow-wrap:anywhere">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><b>Your log</b><p class="small muted" style="margin:4px 0 0">' + (syncOn() ? 'Kept in your account, so it follows you to any phone you sign in on.' : 'Syncing isn’t available right now - your log is safe on this phone.') + '</p></div>' +
      '<div class="note"><div class="row" style="justify-content:space-between"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">“Plan my next 4 weeks” costs about two cents. Everything else in Rep is free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>' +
      '<button class="btn danger block" id="forget" type="button" style="margin-top:10px">Delete my log from the account</button>' +
      '<p class="small muted" style="margin-top:8px">Signing out, or deleting the account’s copy, keeps this phone’s copy of your log.</p>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); draw(); });
        });
        var armed = false;
        $('#forget', root).addEventListener('click', function () {
          if (!armed) { armed = true; this.textContent = 'Tap again - the account’s copy goes, this phone keeps its own'; return; }
          api('DELETE', 'api/log').then(function () { closeSheet(); toast('Deleted from your account. This phone still has it.'); }).catch(function (e) { showError(e); });
        });
        var pk = $('#pkEnrol', root);
        if (pk) pk.addEventListener('click', function () {
          var pw = prompt('Your password for this site, to confirm it is you:');
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
  function checkout(path, body) {
    body.returnTo = BASE;
    api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); });
  }
  function openCredit(data) {
    sheet(head('Out of AI credit') + '<p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Your log, the timer, plates, PRs, charts and routines keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });

  /* ---------------- one click listener ---------------- */

  function setTab(tab) {
    if (TABS.indexOf(tab) < 0) return;
    state.tab = tab; keep(K_TAB, tab);
    closeSheet(true); draw(); scrollTo(0, 0);
    var m = $('#main'); if (m) m.focus({ preventScroll: true });
  }
  function setUnit(u) {
    if (u !== 'kg' && u !== 'lb') return;
    state.settings.unit = u; saveSettings();
    if (state.active) fillConsole();
    var onSettings = !$('#sheet').hidden && $('#sheetTitle') && $('#sheetTitle').textContent === 'Settings';
    draw();
    if (onSettings) openSettings();
  }
  // Holding a stepper repeats it.
  var hold = null, held = false;
  function stopHold() { clearTimeout(hold && hold.t); clearInterval(hold && hold.i); hold = null; }
  document.addEventListener('pointerdown', function (e) {
    var b = e.target.closest && e.target.closest('.step[data-act]');
    if (!b) return;
    held = false;
    var act = b.getAttribute('data-act');
    var fn = act === 'w+' ? function () { stepWeight(1); } : act === 'w-' ? function () { stepWeight(-1); } : act === 'r+' ? function () { stepReps(1); } : act === 'r-' ? function () { stepReps(-1); } : null;
    if (!fn) return;
    stopHold();
    hold = { t: setTimeout(function () { held = true; fn(); hold.i = setInterval(fn, 110); }, 420) };
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { document.addEventListener(ev, function () { stopHold(); }); });

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var a = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    if (a !== 'delwo' && a !== 'wipe' && a !== 'delroutine' && a !== 'discard' && a !== 'delprogram') state.armed = null;
    var act = state.active;
    switch (a) {
      case 'home': e.preventDefault(); if (state.active) { state.inWorkout = false; } setTab('today'); break;
      case 'closesheet': closeSheet(); break;
      case 'tab': setTab(t.getAttribute('data-tab')); break;
      case 'unit': setUnit(t.getAttribute('data-u')); break;
      case 'sample': {
        var smp = R.sample(today(), now(), U()).workouts;
        state.workouts = smp.concat(real()).sort(R.byTime);
        delete state.settings.upNext; saveSettings();
        state.tab = 'today'; saveLocal(); draw(); scrollTo(0, 0);
        toast('🧪 A made-up month to play with. Nothing is saved anywhere.');
        break;
      }
      case 'clearsample':
        state.workouts = real();
        if (state.active && state.active.sample) { state.active = null; state.inWorkout = false; saveActive(); stopTicker(); }
        delete state.settings.upNext; saveSettings();
        saveLocal(); draw(); scrollTo(0, 0); toast('Sample cleared.');
        break;
      case 'mine':
        state.workouts = real();
        if (state.active && state.active.sample) { state.active = null; state.inWorkout = false; saveActive(); stopTicker(); }
        delete state.settings.upNext; saveSettings();
        saveLocal(); draw(); scrollTo(0, 0);
        if (!state.workouts.length && !state.routines.length) toast('Fresh start. Start a workout or pick a starter routine.');
        break;
      case 'starters': state.browse = true; setTab('routines'); setTimeout(function () { var s = $('#starters'); if (s) s.scrollIntoView({ block: 'start' }); }, 40); break;
      case 'startempty': start(null); break;
      case 'start': { var rt = R.routineById(id, state.routines); if (rt) start(rt); break; }
      case 'startpick': openStartPick(); break;
      case 'resume': state.inWorkout = true; draw(); scrollToCur(); break;
      case 'minimize': state.inWorkout = false; draw(); scrollTo(0, 0); break;
      case 'finish': openFinish(); break;
      case 'discard': discard(); break;
      case 'addex': addExercise(); break;
      case 'sel': {
        act.cur = { e: Number(t.getAttribute('data-e')), s: Number(t.getAttribute('data-s')) };
        fillConsole(); saveActive(); draw();
        var inp = $('#cw'); if (inp && matchMedia('(hover: hover)').matches) inp.focus();
        break;
      }
      case 'w+': if (!held) stepWeight(1); held = false; break;
      case 'w-': if (!held) stepWeight(-1); held = false; break;
      case 'r+': if (!held) stepReps(1); held = false; break;
      case 'r-': if (!held) stepReps(-1); held = false; break;
      case 'rpe': { var v = t.getAttribute('data-v'); state.con.rpe = v === '' ? null : Number(v); $$('[data-act="rpe"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); }); break; }
      case 'warm': state.con.warm = !state.con.warm; t.setAttribute('aria-pressed', String(state.con.warm)); break;
      case 'log': logSet(false); break;
      case 'same': logSet(true); break;
      case 'delset': deleteSet(); break;
      case 'addset': addSet(Number(t.getAttribute('data-e')), false); break;
      case 'addwarm': addSet(Number(t.getAttribute('data-e')), true); break;
      case 'rest-': adjustRest(-15); break;
      case 'rest+': adjustRest(15); break;
      case 'restskip': if (act) { act.rest = null; saveActive(); var slot = $('#restSlot'); if (slot) { slot.innerHTML = ''; fitBody(); } tick(); } break;
      case 'plates': {
        if (t.hasAttribute('data-e') && act) {
          var pe = act.entries[Number(t.getAttribute('data-e'))];
          var cur = act.cur.e === Number(t.getAttribute('data-e')) ? R.parseWeight(state.con.w, U()) : null;
          var ps = pe && (pe.sets.find(function (x) { return !x.done && x.w; }) || pe.sets[pe.sets.length - 1]);
          if (act.cur.e !== Number(t.getAttribute('data-e'))) { act.cur = { e: Number(t.getAttribute('data-e')), s: Math.max(0, pe.sets.findIndex(function (x) { return !x.done; })) }; fillConsole(); draw(); }
          openPlates(cur !== null ? cur : ps && ps.w, exOf(pe.ex).name, true);
        } else openPlates(null, '', false);
        break;
      }
      case 'exmenu': openExMenu(Number(t.getAttribute('data-e'))); break;
      case 'exinfo': openExInfo(id); break;
      case 'partyok': closeParty(); break;
      // views
      case 'lift': state.lift = id; draw(); break;
      case 'metric': state.metric = t.getAttribute('data-m'); draw(); break;
      case 'weekview': state.weekView = t.getAttribute('data-v'); draw(); break;
      case 'pt': showPoint(t.closest('.chart'), Number(t.getAttribute('data-i'))); break;
      case 'wo': openWorkout(id); break;
      case 'repeat': {
        var src = state.workouts.find(function (w) { return w.id === id; });
        if (!src) break;
        var asR = R.routineFromWorkout(src, 'repeat-' + src.id.slice(0, 30), now());
        asR.name = src.name; asR.program = null;
        start(asR);
        if (state.active) { state.active.routineId = src.routineId; state.active.program = src.program; saveActive(); }
        break;
      }
      case 'editwo': {
        if (state.active) { toast('Finish or discard the workout under way first.'); break; }
        var ew = state.workouts.find(function (w) { return w.id === id; });
        if (!ew) break;
        var cp = JSON.parse(JSON.stringify(ew));
        cp.entries.forEach(function (x) { x.sets.forEach(function (s) { s.done = true; }); });
        cp.rest = null; cp.cur = { e: 0, s: 0 };
        state.active = R.cleanWorkout(cp, { custom: state.custom, active: true, keepSample: true });
        state.inWorkout = true; fillConsole(); saveActive(); closeSheet(true); draw(); startTicker();
        break;
      }
      case 'asroutine': {
        var aw = state.workouts.find(function (w) { return w.id === id; });
        var nr = aw && R.cleanRoutine(R.routineFromWorkout(aw, newId('r'), now()), state.custom);
        if (!nr) break;
        state.routines.push(nr); saveLocal(); pushRoutine(nr); closeSheet(true); toast('Saved as a routine: ' + nr.name + '.');
        break;
      }
      case 'delwo': {
        if (state.armed !== 'delwo:' + id) { state.armed = 'delwo:' + id; t.textContent = 'Tap again to delete'; break; }
        var dw = state.workouts.find(function (w) { return w.id === id; });
        state.workouts = state.workouts.filter(function (w) { return w.id !== id; });
        saveLocal(); if (dw) dropWorkout(dw); closeSheet(true); draw(); toast('Deleted.');
        break;
      }
      case 'newroutine': openEditor(null); break;
      case 'editroutine': { var er = state.routines.find(function (r) { return r.id === id; }); if (er) openEditor(er); break; }
      case 'copyroutine': copyStarter(id); break;
      case 'delroutine': {
        if (state.armed !== 'delr:' + id) { state.armed = 'delr:' + id; t.textContent = 'Tap again'; break; }
        state.routines = state.routines.filter(function (r) { return r.id !== id; });
        if (state.settings.upNext === id) { delete state.settings.upNext; saveSettings(); }
        saveLocal(); dropRoutine(id); draw(); toast('Routine deleted.');
        break;
      }
      case 'delprogram': {
        var pg = t.getAttribute('data-p');
        if (state.armed !== 'delp:' + pg) { state.armed = 'delp:' + pg; t.textContent = 'Tap again to delete them'; break; }
        var gone = state.routines.filter(function (r) { return r.program === pg; });
        state.routines = state.routines.filter(function (r) { return r.program !== pg; });
        gone.forEach(function (r) { dropRoutine(r.id); if (state.settings.upNext === r.id) delete state.settings.upNext; });
        saveSettings(); saveLocal(); draw(); toast('Deleted ' + plural(gone.length, 'routine') + '.');
        break;
      }
      // the plan
      case 'plan': openPlan(); break;
      case 'aigoal': state.ai.goal = t.getAttribute('data-v'); drawPlan(); break;
      case 'aidays': state.ai.days = Number(t.getAttribute('data-v')); drawPlan(); break;
      case 'aieq': { var q = t.getAttribute('data-v'), eq = state.ai.equipment; var k = eq.indexOf(q); if (k >= 0) eq.splice(k, 1); else eq.push(q); drawPlan(); break; }
      case 'doplan': doPlan(); break;
      case 'plansave': savePlan(); break;
      case 'planagain': state.ai.plan = null; state.ai.week = 0; drawPlan(); break;
      case 'aiweek': state.ai.week = Number(t.getAttribute('data-v')); drawPlan(); break;
      case 'signup': openAccount(null, function () { openPlan(); }); break;
      case 'signin': openAccount(null, function () { openPlan(); }, true); break;
      // settings
      case 'settings': openSettings(); break;
      case 'exportjson': download('rep-log-' + today() + '.json', R.exportJson({ workouts: state.workouts, routines: state.routines, custom: state.custom }, U()), 'application/json'); break;
      case 'exportcsv': download('rep-sets-' + today() + '.csv', R.exportCsv(state.workouts, state.custom, U()), 'text/csv'); break;
      case 'wipe': {
        if (state.armed !== 'wipe') { state.armed = 'wipe'; t.textContent = 'Tap again to clear this phone'; break; }
        state.workouts = []; state.routines = []; state.custom = {}; state.active = null; state.inWorkout = false; stopTicker();
        delete state.settings.upNext; saveSettings(); saveLocal(); saveActive(); closeSheet(true); draw(); toast('Cleared from this phone.');
        break;
      }
      default: break;
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.target.id === 'cw' || e.target.id === 'cr')) { e.preventDefault(); logSet(false); }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('hit')) { e.preventDefault(); showPoint(e.target.closest('.chart'), Number(e.target.getAttribute('data-i'))); }
  });

  /* ---------------- start ---------------- */

  loadLocal();
  if (state.active) { pickCurrent(false); fillConsole(); startTicker(); }
  draw();
  loadMe().then(function () { return syncOn() ? syncIn(false) : null; });
  // The day can turn, and a rest can end, while the phone is locked: work it
  // out again from the clock when the page comes back.
  var lastDay = today();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    tick();
    if (today() !== lastDay) { lastDay = today(); if ($('#sheet').hidden && !state.inWorkout) draw(); }
  });
  window.addEventListener('resize', function () { if (state.inWorkout) fitBody(); });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* no offline copy, still works online */ });
  }
}());
