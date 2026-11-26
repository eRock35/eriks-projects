/* Baste - the page. One file, no build step.
 *
 * The rules (the backward plan, the oven fitting, conflicts and fixes, what
 * runs late and what that pushes, time zones) are BasteCore's; what this
 * phone remembers goes through baste-store.js (localStorage, with a memory
 * fallback). The made-up example is changed by the same rules, in memory,
 * and is never kept or sent.
 *
 * The requests this page makes: a dinner (start, join with a code and a
 * first name, every change through one route, poll every 5 seconds while
 * the page is visible and a dinner is on screen, leave, remove, delete),
 * sign-in, the account's list of kept dinners, and - signed in, when the
 * person asks - one read of a recipe into a draft dish. No location, no
 * contacts, no camera stream, no notifications.
 *
 * Offline: sw.js keeps the page's own files and the store keeps the last
 * copy of the dinner, so the timeline and its countdowns open and keep
 * running with no signal. Changes need the network, and the page says so.
 *
 * Every string a person typed or the server sent is escaped before it is
 * drawn, no handler is written into markup (clicks are routed by data-act
 * from one listener - the lab's CSP allows script from this origin only),
 * and no style attribute is written.
 */
(function () {
  'use strict';

  var C = window.BasteCore;
  var D = window.BasteDemo;
  var S = window.BasteStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural, dur = C.dur;
  var POLL_MS = 5000;
  var TABS = S.TABS;
  var SAFETY = 'Every time here is an estimate for planning. Use a thermometer: poultry and stuffing are done at ' + C.SAFE + ' (USDA).';

  var real = S.local();
  var state = {
    me: null, view: 'home', g: null, demo: null,
    list: real.getList(), prefs: real.getPrefs(),
    offline: false, seenAt: 0, picks: null, memo: null,
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
    toastTimer = setTimeout(function () { t.remove(); }, ms || 3200);
  }
  function say(msg) { var l = $('#live'); l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); }
  function showError(err, where) {
    var msg = err && err.message ? err.message : 'Something went wrong.';
    if (err instanceof TypeError) msg = 'You look offline. The plan and its countdowns still work; changes need a signal.';
    if (where) { where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>'; } else toast(msg, 4500);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function now() { return state.demo ? D.NOW : Date.now(); }
  function phoneZone() { try { var z = Intl.DateTimeFormat().resolvedOptions().timeZone; return C.isZone(z) ? z : 'America/Chicago'; } catch (e) { return 'America/Chicago'; } }
  function savePrefs() { real.putPrefs(state.prefs); }
  function remember(g) {
    if (state.demo || !g) return;
    state.list = [{ id: g.id, title: g.title, eatLocal: g.eatLocal }].concat(state.list.filter(function (x) { return x.id !== g.id; }));
    real.putList(state.list); state.list = real.getList();
    real.putLast(g, Date.now());
  }
  function forgetLocal(id) {
    state.list = state.list.filter(function (x) { return x.id !== id; }); real.putList(state.list);
    if (state.prefs.cur === id) { state.prefs.cur = ''; savePrefs(); real.clearLast(); }
  }
  function member(mid) { return mid ? C.memberOf(state.g, mid) : null; }
  function dishById(id) { var d = null; state.g.dishes.forEach(function (x) { if (x.id === id) d = x; }); return d; }
  /** The plan for what is on screen, worked out once per draw. */
  function plan() {
    var t = now(), key = state.g.id + ':' + state.g.v + ':' + Math.floor(t / 1000);
    if (!state.memo || state.memo.key !== key) state.memo = { key: key, p: C.plan(state.g, t) };
    return state.memo.p;
  }
  function stepByKey(key) { var s = null; plan().steps.forEach(function (x) { if (x.key === key) s = x; }); return s; }
  function clk(ms) { return C.clockAt(ms, state.g.tz); }
  function whenLine(local) { return C.dayLong(local.slice(0, 10)) + ' · ' + C.clock(local.slice(11)); }

  /* ---------------- the dinner on screen ---------------- */

  var pollTimer = null;
  function wantPoll() { return Boolean(state.g && !state.demo && document.visibilityState === 'visible' && TABS.indexOf(state.view) >= 0); }
  function schedulePoll(ms) { clearTimeout(pollTimer); if (wantPoll()) pollTimer = setTimeout(poll, ms === undefined ? POLL_MS : ms); }
  function poll() {
    if (!wantPoll()) return;
    var id = state.g.id;
    api('GET', 'api/d/' + encodeURIComponent(id) + '?since=' + state.g.v).then(function (r) {
      if (!state.g || state.g.id !== id) return;
      var was = state.offline; state.offline = false; state.seenAt = Date.now();
      if (r.g) { adopt(r.g); redraw(); } else if (was) redraw();
      schedulePoll();
    }).catch(function (err) {
      if (err && err.status === 404) { gone(id); return; }
      if (!state.offline) { state.offline = true; redraw(); }
      schedulePoll(POLL_MS * 2);
    });
  }
  function adopt(g) { state.g = g; state.memo = null; remember(g); }
  function gone(id) {
    forgetLocal(id); state.g = null; closeSheet(true);
    toast('That dinner isn’t here any more.', 5000); go('home');
  }
  function enter(id, tab) {
    return api('GET', 'api/d/' + encodeURIComponent(id)).then(function (r) {
      state.demo = null; adopt(r.g); state.prefs.cur = id; savePrefs(); state.seenAt = Date.now(); state.offline = false;
      if (signedIn() && state.me.keep) api('POST', 'api/d/' + encodeURIComponent(id) + '/keep').catch(function () { /* the phone still has it */ });
      go(tab || state.prefs.tab || 'today');
    }).catch(function (err) {
      if (err && err.status === 404) { forgetLocal(id); toast(err.message, 5000); go('home'); return; }
      // No signal: the last copy this phone has, with its clock still running.
      var last = real.getLast();
      if (err instanceof TypeError && last && last.g.id === id) {
        state.demo = null; state.g = last.g; state.memo = null; state.offline = true; state.seenAt = last.at;
        state.view = tab || state.prefs.tab || 'today'; draw(); schedulePoll(POLL_MS * 2);
        return;
      }
      showError(err);
    });
  }
  /** One door for every change. In the example it runs the same rules here. */
  function act(action, done) {
    if (state.demo) {
      try {
        var id = 'd' + String(Object.keys(state.demo.dishes).length + 1) + 'demo' + String(state.demo.v);
        state.demo = C.patch(state.demo, C.act(state.demo, D.ME, action, { now: D.NOW, id: id, today: D.DAY }));
        state.g = C.view(state.demo, D.ME); state.memo = null;
        if (done) done({ id: id });
        redraw();
      } catch (e) { showError(e, $('#formErr')); }
      return;
    }
    api('POST', 'api/d/' + encodeURIComponent(state.g.id) + '/act', { action: action }).then(function (r) {
      state.offline = false; adopt(r.g); if (done) done(r); redraw(); schedulePoll();
    }).catch(function (err) {
      if (err && err.status === 404 && err.data && err.data.code === 'gone') { gone(state.g.id); return; }
      showError(err, $('#formErr'));
    });
  }

  /* ---------------- routing and drawing ---------------- */

  function go(view) { history.pushState(null, '', BASE + '#' + view); route(); scrollTo(0, 0); }
  function route() {
    var h = location.hash.replace(/^#/, '');
    var join = /^join=([A-Za-z0-9-]{4,12})$/.exec(h);
    if (join) { history.replaceState(null, '', BASE + '#home'); state.view = 'home'; draw(); joinSheet(C.normalizeCode(join[1])); return; }
    if (h === 'try') { startDemo(); return; }
    if (TABS.indexOf(h) >= 0 && state.g) { state.view = h; if (!state.demo) { state.prefs.tab = h; savePrefs(); } }
    else if (h === 'new') state.view = 'new';
    else state.view = 'home';
    draw(); schedulePoll();
  }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }
  /** Draw again where the reader is, and refresh an open step's sheet. */
  function redraw() {
    keepPlace(draw);
    var s = $('#sheet');
    if (!s.hidden && s.dataset.step) { if (stepByKey(s.dataset.step)) stepSheet(s.dataset.step); else closeSheet(); }
  }
  function draw() {
    var inG = TABS.indexOf(state.view) >= 0 && state.g;
    $('#tabbar').hidden = !inG; $('#topnav').hidden = !inG;
    var open = inG ? plan().conflicts.length : 0;
    $$('[data-tab]').forEach(function (b) {
      if (b.dataset.tab === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      var old = $('.badge', b); if (old) old.remove();
      if (b.dataset.tab === 'plan' && open && b.parentNode.id === 'tabbar') b.insertAdjacentHTML('beforeend', '<i class="badge" aria-label="' + open + ' to sort out">' + open + '</i>');
    });
    var m = $('#main');
    m.className = 'wrap' + (state.view === 'home' || state.view === 'helpers' || state.view === 'new' ? ' narrow' : '');
    m.innerHTML = !inG ? (state.view === 'new' ? newHtml() : homeHtml()) : state.view === 'plan' ? planHtml() : state.view === 'dishes' ? dishesHtml() : state.view === 'helpers' ? helpersHtml() : todayHtml();
    document.title = (inG ? state.g.title + ' · ' : '') + 'Baste';
    if (state.view === 'new') wireNew();
    tick();
  }
  function ribbon() {
    if (state.demo) return '<p class="ribbon">' + esc(D.NOTICE) + ' <button class="link-btn" type="button" data-act="leavedemo">Leave the example</button></p>';
    if (state.offline) return '<p class="ribbon" role="status">You’re offline - this is the plan as of ' + esc(C.clockAt(state.seenAt || Date.now(), phoneZone())) + ', and the countdowns keep running. Ticking a step or claiming a dish needs the network.</p>';
    return '';
  }
  function dot(m) { return '<span class="dot c' + (m.c % C.COLORS.length) + '" aria-hidden="true">' + esc(C.initials(m.name)) + '</span>'; }
  /** "12:34" under an hour, "2 h 5 min" beyond, "now", "8 min ago". */
  function countdown(ms, t) {
    var s = Math.round((ms - t) / 1000);
    if (s <= 0 && s > -60) return 'now';
    if (s < 0) return dur(Math.floor(-s / 60)) + ' ago';
    if (s < 3600) return Math.floor(s / 60) + ':' + String(s % 60 + 100).slice(1);
    return dur(Math.round(s / 60));
  }
  function cd(ms) { return '<span class="cd num" data-at="' + ms + '">' + esc(countdown(ms, now())) + '</span>'; }
  /** The countdowns move every second without a redraw. */
  function tick() { var t = now(); $$('.cd').forEach(function (el) { el.textContent = countdown(Number(el.dataset.at), t); }); }

  /* ---------------- home and setup ---------------- */

  function homeHtml() {
    var list = state.list.map(function (g) {
      return '<li><button class="item" type="button" data-act="open" data-id="' + esc(g.id) + '"><span class="grow"><span class="t">' + esc(g.title) + '</span><br><span class="s">' + (g.eatLocal ? esc(whenLine(g.eatLocal)) : '') + '</span></span><span class="tag">Open</span></button></li>';
    }).join('');
    return '<section class="hero"><h1>One oven, nine dishes, dinner at four.</h1>' +
      '<p class="lede">Say when you eat and what you’re making. Baste works the whole day backward - when each dish starts, goes in, comes out and rests - fits it to your oven, and puts the same live timeline on every phone in the kitchen.</p>' +
      '<div class="btn-row"><button class="btn" type="button" data-act="new">Plan a dinner</button><button class="btn ghost" type="button" data-act="join">Join with a code</button></div>' +
      '<p class="mt16 mb0"><button class="link-btn" type="button" data-act="demo">See a made-up Thanksgiving, mid-afternoon</button></p></section>' +
      (list ? '<section class="section"><div class="section-title"><h2>Your dinners</h2></div><ul class="list">' + list + '</ul></section>' : '') +
      '<section class="section"><h2>How it works</h2><ol class="steps">' +
      '<li><span class="n">1</span><span><b>Say when you eat</b> and pick the dishes - a turkey by weight, the sides, the pies, or your own. No account.</span></li>' +
      '<li><span class="n">2</span><span><b>Get the plan, worked backward.</b> Two dishes that need the oven at different temperatures at once are flagged, each with a fix to tap.</span></li>' +
      '<li><span class="n">3</span><span><b>Cook from “now” and “next”.</b> Tick each step; “running late” pushes everything that depends on it - dinner included, and it says so.</span></li>' +
      '<li><span class="n">4</span><span><b>Share one link.</b> Helpers see the same timeline, claim a dish or a step, and guests add what they’re bringing.</span></li></ol></section>' +
      '<section class="section"><p class="small muted">' + esc(SAFETY) + '</p><p class="small muted">Free, with no sign-in. Baste keeps first names and dishes - never a phone number or an email address from anyone at the table. Whoever started a dinner can delete it, and it is deleted by itself a week after the day. Once it has loaded, the plan opens without a signal; changes need one.</p></section>';
  }
  function zoneOptions(sel) {
    var seen = {}, list = [sel, phoneZone()].concat(C.COMMON_ZONES);
    try { if (Intl.supportedValuesOf) list = list.concat(Intl.supportedValuesOf('timeZone')); } catch (e) { /* the short list will do */ }
    return list.filter(function (z) { if (!C.isZone(z) || seen[z]) return false; seen[z] = 1; return true; }).map(function (z) {
      return '<option value="' + esc(z) + '"' + (z === sel ? ' selected' : '') + '>' + esc(z.replace(/_/g, ' ')) + '</option>';
    }).join('');
  }
  function localToday() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 101).slice(1) + '-' + String(d.getDate() + 100).slice(1); }
  function numOptions(lo, hi, sel) { var o = ''; for (var i = lo; i <= hi; i++) o += '<option' + (i === sel ? ' selected' : '') + '>' + i + '</option>'; return o; }
  function seg(name, opts, sel) {
    return '<div class="seg" role="group" data-seg="' + name + '">' + opts.map(function (o) { return '<button type="button" data-val="' + esc(o[0]) + '" aria-pressed="' + (o[0] === sel) + '">' + esc(o[1]) + '</button>'; }).join('') + '<input type="hidden" name="' + name + '" value="' + esc(sel) + '"></div>';
  }
  function wireSegs(root, onChange) {
    root.addEventListener('click', function (e) {
      var b = e.target.closest('.seg button'); if (!b) return;
      var box = b.parentNode;
      $$('button', box).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      $('input', box).value = b.dataset.val;
      if (onChange) onChange(box.dataset.seg, b.dataset.val);
    });
  }
  function detailFields(g, unit) {
    var day = g ? g.eatLocal.slice(0, 10) : localToday(), time = g ? g.eatLocal.slice(11) : '16:00';
    return '<div class="two"><label class="field"><span>The day</span><input class="input" type="date" name="day" value="' + esc(day) + '"></label>' +
      '<label class="field"><span>You eat at</span><input class="input" type="time" name="time" value="' + esc(time) + '"></label></div>' +
      '<label class="field"><span>Time zone of the kitchen</span><select class="input" name="tz">' + zoneOptions(g ? g.tz : phoneZone()) + '</select></label>' +
      '<div class="two"><div class="field"><span id="ovl">Ovens</span>' + seg('ovens', [['1', 'One'], ['2', 'Two'], ['3', 'Three']], String(g ? g.ovens : 1)) + '</div>' +
      '<label class="field"><span>Dishes that fit in one at once</span><select class="input" name="fit">' + numOptions(1, C.LIMITS.fit, g ? g.fit : 3) + '</select></label></div>' +
      '<p class="small muted hint">A turkey or a ham takes a whole oven by itself.</p>' +
      '<div class="field"><span>Temperatures in</span>' + seg('unit', [['F', '°F (and lb)'], ['C', '°C (and kg)']], unit) + '</div>';
  }
  var CLASSIC = ['turkey', 'stuffing', 'mashed', 'sweet', 'greenbean', 'rolls', 'gravy', 'cranberry', 'pumpkinpie'];
  function newHtml() {
    if (!state.picks) { state.picks = {}; CLASSIC.forEach(function (k) { state.picks[k] = 1; }); }
    var chips = C.PRESET_IDS.map(function (k) { return '<button class="pick" type="button" data-pick="' + k + '" aria-pressed="' + Boolean(state.picks[k]) + '">' + esc(C.PRESETS[k].name) + '</button>'; }).join('');
    return '<section class="g-head"><h1>Plan a dinner</h1><p class="sub">A minute, no account. You get the plan and a link for your helpers.</p></section>' +
      '<form id="newForm" class="mt24" novalidate>' +
      '<label class="field"><span>Your first name</span><input class="input" name="name" autocomplete="given-name" maxlength="20" value="' + esc(state.prefs.name) + '"></label>' +
      '<label class="field"><span>A name for it (optional)</span><input class="input" name="title" maxlength="40" placeholder="Thanksgiving dinner"></label>' +
      detailFields(null, 'F') +
      '<h2 class="mt24">What are you making?</h2><p class="muted small">Tap to add or drop. Times are ordinary starting points - change any of them, and add your own dishes, on the next screen.</p>' +
      '<div class="picks" id="picks">' + chips + '</div>' +
      '<div id="turkeyBox"' + (state.picks.turkey ? '' : ' hidden') + '><div class="two mt16"><label class="field"><span id="wlabel">Turkey weight (lb)</span><input class="input" name="weight" inputmode="decimal" maxlength="4" value="14"></label>' +
      '<label class="check"><input type="checkbox" name="stuffed"><span>Stuffed</span></label></div>' +
      '<p class="small muted" id="turkeyLine"></p></div>' +
      '<div id="formErr"></div><button class="btn block" type="submit">Make the plan</button></form>' +
      '<p class="small muted mt16">' + esc(SAFETY) + '</p>';
  }
  function turkeyLine(f) {
    var unit = f.unit.value, w = Number(f.weight.value), lb = unit === 'C' ? w * C.LB_PER_KG : w;
    if (!isFinite(lb) || lb < C.TURKEY_LB[0] - 0.05 || lb > C.TURKEY_LB[1] + 0.05) return 'The chart covers a whole turkey from 8 to 24 lb (3.6 to 10.9 kg).';
    return 'About ' + dur(C.turkeyMinutes(lb, f.stuffed.checked)) + ' at ' + C.tempText(325, unit) + (f.stuffed.checked ? ', stuffed' : ', unstuffed') + ' (USDA’s chart for a thawed bird). An estimate - it is done at ' + C.SAFE + ', by thermometer.';
  }
  function wireNew() {
    var f = $('#newForm'); if (!f) return;
    function sync() {
      $('#turkeyBox').hidden = !state.picks.turkey;
      $('#wlabel').textContent = 'Turkey weight (' + (f.unit.value === 'C' ? 'kg' : 'lb') + ')';
      $('#turkeyLine').textContent = turkeyLine(f);
    }
    wireSegs(f, function (name, val) {
      if (name !== 'unit') return;
      var w = Number(f.weight.value);
      if (isFinite(w) && w > 0) f.weight.value = String(val === 'C' ? Math.round(w / C.LB_PER_KG * 2) / 2 : Math.round(w * C.LB_PER_KG));
      sync();
    });
    $('#picks').addEventListener('click', function (e) {
      var b = e.target.closest('[data-pick]'); if (!b) return;
      var k = b.dataset.pick; if (state.picks[k]) delete state.picks[k]; else state.picks[k] = 1;
      b.setAttribute('aria-pressed', String(Boolean(state.picks[k]))); sync();
    });
    f.weight.addEventListener('input', sync); f.stuffed.addEventListener('change', sync);
    sync();
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = { name: f.name.value, title: f.title.value, eatLocal: f.day.value + 'T' + f.time.value, tz: f.tz.value, ovens: Number(f.ovens.value), fit: Number(f.fit.value), unit: f.unit.value };
      body.dishes = C.PRESET_IDS.filter(function (k) { return state.picks[k]; }).map(function (k) {
        var d = C.fromPreset(k); d.unit = 'F';
        if (k === 'turkey') { d.weight = Number(f.weight.value); d.wunit = f.unit.value === 'C' ? 'kg' : 'lb'; d.stuffed = f.stuffed.checked; }
        return d;
      });
      var btn = $('button[type=submit]', f); btn.disabled = true;
      api('POST', 'api/dinners', body).then(function (r) {
        state.prefs.name = C.cleanName(body.name); state.prefs.cur = r.id; savePrefs();
        state.demo = null; state.picks = null; adopt(r.g); state.seenAt = Date.now();
        if (signedIn() && state.me.keep) api('POST', 'api/d/' + encodeURIComponent(r.id) + '/keep').catch(function () { /* the phone still has it */ });
        go('plan'); toast('Here’s the plan. Send the link from Helpers.', 4500);
      }).catch(function (err) { btn.disabled = false; showError(err, $('#formErr')); });
    });
  }

  /* ---------------- today: now and next ---------------- */

  function headHtml() {
    var g = state.g, p = plan();
    return ribbon() + '<section class="g-head"><h1>' + esc(g.title) + '</h1><p class="sub">' + esc(whenLine(g.eatLocal)) + ' · ' + esc(C.zoneCity(g.tz)) + ' time' + (g.tz !== phoneZone() && !state.demo ? ' (not where this phone is)' : '') + '</p></section>' + movedHtml(p);
  }
  function movedHtml(p) {
    if (!p.moved) return '';
    var g = state.g, local = C.zoneLocal(p.serveAt, g.tz);
    return '<div class="card warn mt16" role="status"><b>' + esc('Dinner moves to ' + clk(p.serveAt)) + '</b><br>' + esc(dur(p.moved) + ' later than ' + clk(p.eatAt) + '. ' + p.why) +
      (g.host ? '<div class="btn-row mt8"><button class="btn small ghost" type="button" data-act="moveto" data-local="' + esc(local) + '">Set dinner to ' + esc(clk(p.serveAt)) + '</button></div>' : '') + '</div>';
  }
  function whoHtml(s) {
    var m = member(s.who);
    if (!m) return '';
    return '<span class="who">' + dot(m) + '<span>' + esc(m.me ? 'You' : m.name) + '</span></span>';
  }
  function timeCell(ms) { var c = clk(ms).split(' '); return '<span class="tm"><b>' + esc(c[0]) + '</b><small>' + esc(c[1]) + '</small></span>'; }
  /** A step as a row: the time, what to do, who has it. */
  function stepRow(s, big) {
    var t = C.stepText(s, state.g), late = s.overdue >= 3;
    var chip = s.done ? '<span class="chip s-done">Done</span>' : late ? '<span class="chip s-due">' + esc(dur(s.overdue)) + ' overdue</span>' : '';
    return '<button class="step-main" type="button" data-act="step" data-key="' + esc(s.key) + '">' + timeCell(s.at) +
      '<span class="tb"><span class="t">' + esc(t.title) + '</span><span class="s">' + esc(big ? t.sub : t.sub.split('. ')[0]) + '</span>' + whoHtml(s) + '</span>' + chip + '</button>';
  }
  function lateButtons(s) {
    var d = dishById(s.id);
    if (!d || d.ahead || s.kind === 'baste' || s.kind === 'warm' || s.kind === 'make') return '';
    return '<button class="btn small quiet" type="button" data-act="late" data-id="' + esc(s.id) + '" data-add="10">Late +10</button><button class="btn small quiet" type="button" data-act="late" data-id="' + esc(s.id) + '" data-add="20">+20</button>';
  }
  function todayHtml() {
    var g = state.g, p = plan(), t = now();
    if (!g.dishes.length) return headHtml() + '<p class="empty">No dishes yet. Add what you’re making and the day works itself out backward from ' + esc(clk(g.eatAt)) + '.</p><div class="btn-row"><button class="btn" type="button" data-act="add">Add a dish</button></div>';
    var open = p.steps.filter(function (s) { return !s.done; });
    var due = open.filter(function (s) { return s.at <= t + 60000; });
    var next = open.filter(function (s) { return s.at > t + 60000; });
    var doneN = p.steps.length - open.length;
    var html = headHtml() +
      '<div class="serve"><div><span class="lbl">Dinner</span><b class="num">' + esc(clk(p.serveAt)) + '</b></div><div class="r"><span class="lbl">' + (p.serveAt > t ? 'Sit down in' : 'Served') + '</span>' + cd(p.serveAt) + '</div></div>' +
      (p.conflicts.length ? '<p class="card warn mt16">' + esc(plural(p.conflicts.length, 'oven conflict')) + ' in the plan. <button class="link-btn" type="button" data-act="tab" data-tab="plan">See the fixes</button></p>' : '');
    html += '<section class="section"><div class="section-title"><h2>Now</h2><span class="muted small num">' + esc(clk(t)) + '</span></div>';
    if (due.length) {
      html += '<ul class="steplist">' + due.map(function (s) {
        return '<li class="step due">' + stepRow(s, true) + '<div class="step-acts"><button class="btn small" type="button" data-act="done" data-key="' + esc(s.key) + '">Done</button>' +
          (s.overdue >= 3 ? '<button class="btn small ghost" type="button" data-act="done" data-when="time" data-key="' + esc(s.key) + '">Did it on time</button>' : '') + lateButtons(s) +
          (!s.who ? '<button class="btn small ghost" type="button" data-act="claimstep" data-key="' + esc(s.key) + '">I’ll do it</button>' : '') + '</div></li>';
      }).join('') + '</ul>';
    } else if (open.length) html += '<p class="muted quietline">Nothing to do this minute.' + (p.cooking.length ? '' : ' Pour something.') + '</p>';
    else html += '<p class="muted quietline">Every step is ticked. Enjoy dinner.</p>';
    html += '</section>';
    if (p.cooking.length) {
      html += '<section class="section"><div class="section-title"><h2>Cooking</h2></div><ul class="list">' + p.cooking.map(function (d) {
        return '<li class="item"><span class="grow"><span class="t">' + esc(d.name) + '</span><br><span class="s">' + esc((d.method === 'oven' ? 'In the oven at ' + C.tempText(d.temp, g.unit) : 'On the stovetop') + ' · out at ' + clk(d.outAt)) + (d.late ? esc(' · ' + dur(d.late) + ' longer') : '') + '</span></span>' + cd(d.outAt) + '</li>';
      }).join('') + '</ul></section>';
    }
    if (next.length) {
      html += '<section class="section"><div class="section-title"><h2>Next</h2></div><ul class="steplist">' + next.slice(0, 5).map(function (s, i) {
        return '<li class="step">' + stepRow(s, false) + '<div class="step-acts">' + (i === 0 ? '<span class="upnext">' + cd(s.at) + '</span>' : '') +
          (!s.who ? '<button class="btn small ghost" type="button" data-act="claimstep" data-key="' + esc(s.key) + '">I’ll do it</button>' : '') + (i === 0 ? '<button class="btn small quiet" type="button" data-act="done" data-key="' + esc(s.key) + '">Done early</button>' : '') + '</div></li>';
      }).join('') + '</ul>' + (next.length > 5 ? '<p class="mt16"><button class="link-btn" type="button" data-act="tab" data-tab="plan">' + esc(plural(next.length - 5, 'more step')) + ' in the plan</button></p>' : '') + '</section>';
    }
    return html + '<p class="small muted mt24">' + esc(doneN + ' of ' + plural(p.steps.length, 'step') + ' done. ') + esc(SAFETY) + '</p>';
  }

  /* ---------------- the plan ---------------- */

  function ovenHtml(p) {
    var g = state.g, lanes = p.ovens.filter(function (l) { return l.length; });
    if (!lanes.length) return '';
    var t0 = Infinity, t1 = p.serveAt;
    p.ovens.forEach(function (l) { l.forEach(function (x) { if (x.from < t0) t0 = x.from; if (x.to > t1) t1 = x.to; }); });
    var span = Math.max(1, t1 - t0), W = 1000, H = 30, n = 0;
    var svg = '<svg class="lanes" viewBox="0 0 ' + W + ' ' + (p.ovens.length * (H + 6)) + '" preserveAspectRatio="none" aria-hidden="true">';
    var list = '';
    p.ovens.forEach(function (lane, o) {
      var rows = {};
      lane.forEach(function (x) {
        // Dishes in together sit side by side: the first free row.
        var row = 0; while (rows[row] && rows[row] > x.from) row++;
        rows[row] = x.to;
        var hgt = x.big ? H : Math.floor(H / Math.min(3, g.fit)) - 2;
        svg += '<rect class="seg-' + (n++ % 6) + '" x="' + Math.round((x.from - t0) / span * W) + '" y="' + (o * (H + 6) + (x.big ? 0 : (row % 3) * (hgt + 2))) + '" width="' + Math.max(4, Math.round((x.to - x.from) / span * W) - 3) + '" height="' + hgt + '" rx="4"></rect>';
      });
      if (!lane.length) return;
      list += (g.ovens > 1 ? '<li class="lane-h">Oven ' + (o + 1) + '</li>' : '') + lane.map(function (x) {
        return '<li class="item lane"><span class="tspan num">' + esc(clk(x.from) + ' – ' + clk(x.to)) + '</span><span class="grow"><span class="t">' + esc(x.name) + '</span> <span class="s">' + esc(C.tempText(x.temp, g.unit) + (x.est ? ' · estimate' : '')) + '</span></span></li>';
      }).join('');
    });
    return '<section class="section"><div class="section-title"><h2>' + (g.ovens > 1 ? 'The ovens' : 'The oven') + '</h2><span class="muted small">' + esc(clk(t0) + ' to ' + clk(t1)) + '</span></div>' + svg + '</svg><ul class="list">' + list + '</ul></section>';
  }
  function planHtml() {
    var g = state.g, p = plan();
    if (!g.dishes.length) return headHtml() + '<p class="empty">The plan appears as soon as there is a dish.</p><div class="btn-row"><button class="btn" type="button" data-act="add">Add a dish</button></div>';
    var html = headHtml();
    if (p.conflicts.length) {
      html += '<section class="section"><div class="section-title"><h2>' + esc(plural(p.conflicts.length, 'conflict')) + ' to sort out</h2></div>' + p.conflicts.map(function (c, i) {
        return '<div class="card conflict"><p class="ct"><span class="chip s-due">' + (c.kind === 'temp' ? 'Two temperatures' : 'Not enough room') + '</span></p><p>' + esc(c.text) + '</p>' +
          (c.fixes.length ? '<p class="small muted mb0">Pick a fix:</p>' + c.fixes.map(function (f, j) { return '<button class="fix" type="button" data-act="fix" data-c="' + i + '" data-f="' + j + '">' + esc(f.label) + '</button>'; }).join('')
            : '<p class="small muted mb0">No one-tap fix fits. Change a dish’s times, make one ahead, or add an oven under Helpers.</p>') + '</div>';
      }).join('') + '</section>';
    } else html += '<p class="okline mt16"><span class="chip s-ok">The oven works</span> <span class="muted small">Nothing needs it at two temperatures at once.</span></p>';
    html += ovenHtml(p);
    html += '<section class="section"><div class="section-title"><h2>The whole day</h2><span class="muted small">Worked back from ' + esc(clk(p.serveAt)) + '</span></div><ul class="steplist plain">' + p.steps.map(function (s) {
      return '<li class="step' + (s.done ? ' done' : '') + '">' + stepRow(s, false) + '</li>';
    }).join('') + '<li class="step dinner"><span class="step-main">' + timeCell(p.serveAt) + '<span class="tb"><span class="t">Dinner</span><span class="s">' + esc(p.moved ? dur(p.moved) + ' later than planned' : 'Everything lands here') + '</span></span></span></li></ul></section>';
    return html + '<div class="addbar"><button class="btn" type="button" data-act="add">Add a dish</button></div><p class="small muted mt24">' + esc(SAFETY) + ' A shared oven temperature changes cooking times; those are marked as estimates.</p>';
  }

  /* ---------------- dishes ---------------- */

  function dishState(d, pd) {
    if (!pd) return '';
    if (pd.ahead) return pd.state === 'made' ? '<span class="chip s-done">Made</span>' : '<span class="chip">Ahead</span>';
    var m = { cooking: ['s-way', 'Cooking'], resting: ['s-ok', 'Resting'], ready: ['s-done', 'Ready'], prepped: ['', 'Prepped'] }[pd.state];
    return (d.late ? '<span class="chip s-late">Late ' + esc(dur(d.late)) + '</span>' : '') + (m ? '<span class="chip ' + m[0] + '">' + m[1] + '</span>' : '');
  }
  function dishesHtml() {
    var g = state.g, p = plan();
    var rows = g.dishes.map(function (d) {
      var m = member(d.who), pd = p.dishes[d.id], fixes = C.fixLines(d, g.unit);
      var when = pd ? (pd.ahead ? 'ahead' : (d.method === 'none' || C.effective(d).method === 'none' ? 'ready ' + clk(pd.readyAt) : 'in ' + clk(pd.inAt) + ' · out ' + clk(pd.outAt))) : '';
      return '<li class="drow"><button class="item" type="button" data-act="dish" data-id="' + esc(d.id) + '"><span class="grow"><span class="t">' + esc(d.name) + '</span><br><span class="s">' + esc(C.dishLine(d, g.unit)) + '</span><br><span class="s num">' + esc(when) + (d.guest ? esc(' · brought by a guest' + (d.arrive ? ', arriving ' + C.clock(d.arrive) : '')) : '') + '</span>' +
        (fixes.length ? '<br><span class="s adj">Adjusted: ' + esc(fixes.join(' ')) + '</span>' : '') + '</span><span class="chips">' + dishState(d, pd) + '</span></button>' +
        '<div class="drow-acts">' + (m ? '<span class="who">' + dot(m) + '<span>' + esc(m.me ? 'You’ve got it' : m.name + ' has it') + '</span></span>' + (m.me ? '<button class="link-btn" type="button" data-act="claim" data-id="' + esc(d.id) + '" data-on="0">Let it go</button>' : '')
          : '<span class="muted small">Nobody yet</span><button class="btn small ghost" type="button" data-act="claim" data-id="' + esc(d.id) + '" data-on="1">I’ve got it</button>') + '</div></li>';
    }).join('');
    return headHtml() + '<section class="section"><div class="section-title"><h2>' + esc(plural(g.dishes.length, 'dish', 'dishes')) + '</h2></div>' +
      (rows ? '<ul class="list">' + rows + '</ul>' : '<p class="empty">No dishes yet.</p>') +
      '<div class="addbar"><button class="btn" type="button" data-act="add">Add a dish</button><button class="btn ghost" type="button" data-act="bring">I’m bringing a dish</button><button class="btn ghost" type="button" data-act="recipe">Fill from a recipe</button></div></section>';
  }

  /* ---------------- helpers ---------------- */

  function helpersHtml() {
    var g = state.g, p = plan();
    var people = g.members.filter(function (m) { return !m.left; }).map(function (m) {
      var has = g.dishes.filter(function (d) { return d.who === m.id; }).map(function (d) { return d.name; });
      var steps = p.steps.filter(function (s) { return s.claimed && s.who === m.id && !s.done; }).length;
      var line = (has.length ? C.listNames(has) : 'Nothing claimed yet') + (steps ? ' · ' + plural(steps, 'step') : '');
      return '<li class="item">' + dot(m) + '<span class="grow"><span class="t">' + esc(m.name) + (m.me ? ' <span class="tag">you</span>' : '') + (m.host ? ' <span class="tag">started it</span>' : '') + '</span><br><span class="s">' + esc(line) + '</span></span>' +
        (g.host && !m.me ? '<button class="link-btn" type="button" data-act="kick" data-id="' + esc(m.id) + '" data-name="' + esc(m.name) + '">Remove</button>' : '') + '</li>';
    }).join('');
    var free = g.dishes.filter(function (d) { return !d.who; }).map(function (d) { return d.name; });
    return headHtml() +
      '<section class="section"><div class="section-title"><h2>Bring in the helpers</h2></div><p class="muted">Anyone with the link or the code sees this same live timeline on their phone, with a first name and no account. They can claim a dish or a step, tick things done - and guests can add what they are bringing, so the oven plan counts it.</p>' +
      '<p class="code">' + esc(C.formatCode(g.code)) + '</p><div class="btn-row"><button class="btn" type="button" data-act="share">Send the link</button><button class="btn ghost" type="button" data-act="copycode">Copy the link</button></div></section>' +
      '<section class="section"><div class="section-title"><h2>Who’s got what</h2></div><ul class="list">' + people + '</ul>' +
      (free.length ? '<p class="small muted mt16">Still up for grabs: ' + esc(C.listNames(free)) + '.</p>' : '') + '</section>' +
      '<section class="section"><div class="section-title"><h2>This dinner</h2></div><p class="small muted">' + esc(plural(g.ovens, 'oven') + ', ' + plural(g.fit, 'dish', 'dishes') + ' at once in each, temperatures in °' + g.unit + '. Baste keeps first names and dishes only - no email address and no phone number from anyone. It is deleted for everyone a week after the day (' + C.dayLong(g.keptUntil) + '), or now if whoever started it deletes it.') + '</p>' +
      '<div class="btn-row">' + (g.host ? '<button class="btn ghost small" type="button" data-act="details">Change the time or the ovens</button><button class="btn danger small" type="button" data-act="delete">Delete this dinner</button>' : '<button class="btn danger small" type="button" data-act="leave">Leave this dinner</button>') + '</div></section>';
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen, stepKey) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    clearTimeout(toastTimer);
    $$('.toast').forEach(function (t) { t.remove(); });
    var again = !s.hidden && stepKey && s.dataset.step === stepKey, top = s.scrollTop;
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet">Close</button><div class="body">' + html + '</div>';
    if (stepKey) s.dataset.step = stepKey; else delete s.dataset.step;
    s.hidden = false; back.hidden = false; document.body.classList.add('sheet-open'); s.scrollTop = again ? top : 0;
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2'); if (f) f.setAttribute('tabindex', '-1');
    if (!again) setTimeout(function () { try { if (f && !s.contains(document.activeElement)) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    var s = $('#sheet');
    if (s.hidden) return;
    s.hidden = true; $('#sheetBack').hidden = true; s.innerHTML = ''; delete s.dataset.step;
    document.body.classList.remove('sheet-open');
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  function detailsSheet() {
    var g = state.g;
    sheet('<h2>The time and the ovens</h2><form id="detForm" novalidate><label class="field"><span>Name</span><input class="input" name="title" maxlength="40" value="' + esc(g.title) + '"></label>' + detailFields(g, g.unit) +
      '<div id="formErr"></div><button class="btn block" type="submit">Save</button></form>', function (root) {
      var f = $('#detForm', root); wireSegs(f);
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        act({ t: 'details', title: f.title.value, eatLocal: f.day.value + 'T' + f.time.value, tz: f.tz.value, ovens: Number(f.ovens.value), fit: Number(f.fit.value), unit: f.unit.value }, function () { closeSheet(); toast('Saved - the plan moved with it.'); });
      });
    });
  }
  function joinSheet(code) {
    sheet('<h2>Join a dinner</h2><form id="joinForm" novalidate><label class="field"><span>The code</span><input class="input" name="code" autocomplete="off" autocapitalize="characters" maxlength="9" placeholder="ABC-DEF" value="' + esc(code ? C.formatCode(code) : '') + '"></label>' +
      '<div id="peek"></div><label class="field"><span>Your first name</span><input class="input" name="name" autocomplete="given-name" maxlength="20" value="' + esc(state.prefs.name) + '"></label>' +
      '<div id="formErr"></div><button class="btn block" type="submit">Join</button></form>', function (root) {
      var f = $('#joinForm', root);
      function peek() {
        var c = C.normalizeCode(f.code.value);
        if (!C.isCode(c)) { $('#peek', root).innerHTML = ''; return; }
        api('GET', 'api/join/' + c).then(function (p) {
          if (p.already) { closeSheet(true); enter(p.already, 'today'); return; }
          $('#peek', root).innerHTML = '<div class="card mb16"><b>' + esc(p.title) + '</b><br><span class="small muted">' + esc(p.when) + ' · started by ' + esc(p.by) + ' · ' + plural(p.members, 'person', 'people') + ' in</span></div><p></p>';
        }).catch(function (err) { showError(err, $('#peek', root)); });
      }
      f.code.addEventListener('input', peek); peek();
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var c = C.normalizeCode(f.code.value);
        if (!C.isCode(c)) { showError(new Error('The code is six letters and numbers, like ABC-DEF.'), $('#formErr', root)); return; }
        api('POST', 'api/join/' + c, { name: f.name.value }).then(function (r) {
          state.prefs.name = C.cleanName(f.name.value) || state.prefs.name; savePrefs();
          closeSheet(true); return enter(r.id, 'today');
        }).catch(function (err) { showError(err, $('#formErr', root)); });
      });
    });
  }
  function link() { return location.origin + BASE + '#join=' + state.g.code; }
  function copy(text, ok) {
    function fallback() { var ta = document.createElement('textarea'); ta.value = text; ta.className = 'vh'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast(ok); } catch (e) { toast('Could not copy - select it by hand.'); } ta.remove(); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(ok); }, fallback); else fallback();
  }

  /* ---- a step: done, who has it, running late ---- */

  function stepSheet(key) {
    var s = stepByKey(key); if (!s) { closeSheet(); return; }
    var g = state.g, t = C.stepText(s, g), d = dishById(s.id), m = member(s.who), by = s.done ? member(s.done.by) : null;
    var canLate = d && !d.ahead && !s.done && s.kind !== 'baste' && s.kind !== 'warm' && s.kind !== 'make';
    sheet('<h2>' + esc(t.title) + '</h2><p class="when num"><b>' + esc(clk(s.at)) + '</b> ' + (s.done ? '<span class="chip s-done">Done' + (by ? ' by ' + esc(by.me ? 'you' : by.name) : '') + '</span>' : s.overdue >= 3 ? '<span class="chip s-due">' + esc(dur(s.overdue)) + ' overdue</span>' : '<span class="muted">' + cd(s.at) + '</span>') + '</p>' +
      '<p>' + esc(t.sub) + '</p>' + (d && d.note ? '<p class="small muted">Note: ' + esc(d.note) + '</p>' : '') +
      '<div class="btn-row">' + (s.done ? '<button class="btn ghost" type="button" data-act="undone" data-key="' + esc(key) + '">Not done after all</button>'
        : '<button class="btn" type="button" data-act="done" data-key="' + esc(key) + '">Done</button>' + (s.overdue >= 3 ? '<button class="btn ghost" type="button" data-act="done" data-when="time" data-key="' + esc(key) + '">Did it on time</button>' : '')) + '</div>' +
      '<h3>Who has it</h3><div class="btn-row">' + (m ? '<span class="who">' + dot(m) + '<span>' + esc(m.me ? 'You' : m.name) + (s.claimed ? '' : ' (the whole dish)') + '</span></span>' : '<span class="muted small">Nobody yet</span>') +
      (s.claimed && m && m.me ? '<button class="btn small ghost" type="button" data-act="claimstep" data-on="0" data-key="' + esc(key) + '">Let it go</button>' : (!m || !m.me ? '<button class="btn small ghost" type="button" data-act="claimstep" data-key="' + esc(key) + '">I’ll do it</button>' : '')) + '</div>' +
      (canLate ? '<h3>Running late?</h3><p class="small muted">Pushes this dish’s later steps, whatever waits for the oven after it, and - if it comes to that - dinner.' + (d.late ? ' Now ' + esc(dur(d.late)) + ' late.' : '') + '</p><div class="btn-row"><button class="btn small quiet" type="button" data-act="late" data-id="' + esc(s.id) + '" data-add="10">+10 min</button><button class="btn small quiet" type="button" data-act="late" data-id="' + esc(s.id) + '" data-add="20">+20 min</button>' +
        (d.late ? '<button class="btn small ghost" type="button" data-act="late" data-id="' + esc(s.id) + '" data-set="0">Back on time</button>' : '') + '</div>' : '') +
      '<div id="formErr"></div><p class="mt16 mb0"><button class="link-btn" type="button" data-act="dish" data-id="' + esc(s.id) + '">Open the ' + esc(C.lower(s.name)) + '</button></p>', null, key);
  }

  /* ---- a dish: pick, add, edit ---- */

  function pickSheet() {
    sheet('<h2>Add a dish</h2><p class="muted">Pick one to start from - every time can be changed - or add your own.</p><div class="picks">' +
      C.PRESET_IDS.map(function (k) { return '<button class="pick" type="button" data-act="preset" data-kind="' + k + '">' + esc(C.PRESETS[k].name) + '</button>'; }).join('') + '</div>' +
      '<button class="btn block" type="button" data-act="preset" data-kind="custom">Your own dish</button><button class="btn ghost block" type="button" data-act="recipe">Fill it in from a recipe</button>');
  }
  function dishSheet(id, start, banner) {
    var g = state.g, d = id ? dishById(id) : start;
    if (!d) return;
    var turkey = d.kind === 'turkey', unit = g.unit, kg = unit === 'C';
    var fixes = id ? C.fixLines(d, unit) : [];
    var w = d.weight ? (kg ? Math.round(d.weight / C.LB_PER_KG * 2) / 2 : Math.round(d.weight * 10) / 10) : 14;
    var tempShown = d.temp ? (start && start.unit ? C.tempNumber(d.temp, unit) : C.tempNumber(d.temp, unit)) : C.tempNumber(350, unit);
    function num(label, name, val, max) { return '<label class="field"><span>' + label + '</span><input class="input" name="' + name + '" inputmode="numeric" maxlength="' + String(max).length + '" value="' + esc(String(val)) + '"></label>'; }
    sheet('<h2>' + (id ? esc(d.name) : (d.guest ? 'A dish you’re bringing' : 'New dish')) + '</h2>' + (banner ? '<p class="ribbon">' + esc(banner) + '</p>' : '') +
      (fixes.length ? '<div class="card mb16"><b class="small">Adjusted by a fix</b><p class="small mb0">' + esc(fixes.join(' ')) + '</p><button class="link-btn" type="button" data-act="unfix" data-id="' + esc(id) + '">Undo the adjustments</button></div>' : '') +
      '<form id="dishForm" novalidate><label class="field"><span>Dish</span><input class="input" name="name" maxlength="40" value="' + esc(d.name) + '"' + (id || d.name ? '' : ' placeholder="Aunt Mei’s casserole"') + '></label>' +
      (turkey ? '<div class="two"><label class="field"><span>Weight (' + (kg ? 'kg' : 'lb') + ')</span><input class="input" name="weight" inputmode="decimal" maxlength="4" value="' + esc(String(w)) + '"></label><label class="check"><input type="checkbox" name="stuffed"' + (d.stuffed ? ' checked' : '') + '><span>Stuffed</span></label></div><p class="small muted" id="turkeyLine"></p>'
        : '<div class="field"><span>Where it cooks</span>' + seg('method', C.METHOD_IDS.map(function (k) { return [k, C.METHODS[k]]; }), d.method) + '</div>') +
      '<div class="two">' + num('Prep (min)', 'prep', d.prep, 240) + (turkey ? '' : '<span data-need="cook">' + num('Cook (min)', 'cook', d.cook || 30, 720) + '</span>') + '</div>' +
      '<div class="two">' + (turkey ? '' : '<span data-need="oven">' + num('Oven (°' + unit + ')', 'temp', tempShown, 999) + '</span>') + num('Rest before serving (min)', 'rest', d.rest, 180) + '</div>' +
      (turkey ? '' : '<label class="check" data-need="oven"><input type="checkbox" name="big"' + (d.big ? ' checked' : '') + '><span>Takes the whole oven</span></label>') +
      '<label class="check"><input type="checkbox" name="canAhead"' + (d.canAhead ? ' checked' : '') + '><span>Can be made ahead</span></label>' +
      '<div data-need="ahead"><label class="check"><input type="checkbox" name="ahead"' + (d.ahead ? ' checked' : '') + '><span>Making it ahead - off today’s oven plan</span></label>' +
      '<span data-need="aheadon">' + num('Warm it before dinner (min, 0 for none)', 'reheat', d.reheat, 60) + '</span></div>' +
      '<label class="check"><input type="checkbox" name="guest"' + (d.guest ? ' checked' : '') + '><span>A guest is bringing it</span></label>' +
      '<label class="field" data-need="guest"><span>It arrives at (leave empty if it’s here in time)</span><input class="input" type="time" name="arrive" value="' + esc(d.arrive || '') + '"></label>' +
      '<label class="field"><span>Note (optional)</span><input class="input" name="note" maxlength="140" value="' + esc(d.note || '') + '"></label>' +
      (C.safeLine(d) ? '<p class="small muted">' + esc(C.safeLine(d)) + '</p>' : '') +
      '<div id="formErr"></div><button class="btn block" type="submit">' + (id ? 'Save' : 'Add to the plan') + '</button>' +
      (id ? '<button class="btn danger block" type="button" data-act="remove" data-id="' + esc(id) + '">Take it off the plan</button>' : '') + '</form>', function (root) {
      var f = $('#dishForm', root);
      function sync() {
        var method = turkey ? 'oven' : f.method.value;
        var show = { cook: method !== 'none', oven: method === 'oven', ahead: f.canAhead.checked && !f.guest.checked, aheadon: f.ahead.checked, guest: f.guest.checked };
        $$('[data-need]', f).forEach(function (el) { el.hidden = !show[el.dataset.need]; });
        if (turkey) {
          var lb = Number(f.weight.value) * (kg ? C.LB_PER_KG : 1);
          $('#turkeyLine', f).textContent = isFinite(lb) && lb >= C.TURKEY_LB[0] - 0.05 && lb <= C.TURKEY_LB[1] + 0.05 ? 'About ' + dur(C.turkeyMinutes(lb, f.stuffed.checked)) + ' at ' + C.tempText(325, unit) + ' (USDA’s chart for a thawed bird) - an estimate.' : 'The chart covers a whole turkey from 8 to 24 lb (3.6 to 10.9 kg).';
        }
      }
      wireSegs(f, sync); f.addEventListener('change', sync); f.addEventListener('input', sync); sync();
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var dish = { kind: d.kind, name: f.name.value, method: turkey ? 'oven' : f.method.value, prep: f.prep.value, rest: f.rest.value, unit: unit, canAhead: f.canAhead.checked, ahead: f.ahead.checked && f.canAhead.checked, reheat: f.reheat.value, guest: f.guest.checked, arrive: f.arrive.value, note: f.note.value };
        if (turkey) { dish.weight = f.weight.value; dish.wunit = kg ? 'kg' : 'lb'; dish.stuffed = f.stuffed.checked; }
        else { dish.cook = f.cook.value; dish.temp = f.temp.value; dish.big = f.big.checked; }
        if (id) act({ t: 'edit', id: id, dish: dish }, function () { closeSheet(); toast('Saved - the plan moved with it.'); });
        else act({ t: 'add', dish: dish }, function () { closeSheet(); toast(dish.name + ' is on the plan.'); });
      });
    });
  }

  /* ---- fill from a recipe (signed in; the one model call) ---- */

  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) { reject(new Error('Choose a photo or screenshot (an image).')); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.addEventListener('load', function () {
        var k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        resolve({ type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85) });
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That image could not be opened. Try a screenshot.')); });
      img.src = url;
    });
  }
  var DRAFT_NOTE = 'Filled in from your recipe. Check every field - then add it.';
  function recipeSheet() {
    var g = state.g;
    if (state.demo) { dishSheet(null, C.cleanDraft({ name: 'Sausage and sage stuffing', method: 'oven', prep: 25, cook: 45, temp: 375, unit: 'F', rest: 10, canAhead: true }, g), DRAFT_NOTE); return; }
    if (!signedIn()) {
      sheet('<h2>Fill it in from a recipe</h2><p>Paste a recipe or add a photo of the card, and Baste fills in the prep, the cooking time, the oven temperature and the rest as a draft you check before it goes on the plan.</p><p class="muted">Reading it uses AI, which costs money to run - so this one step needs a free account. Everything else in Baste works without one, and typing a dish in takes half a minute.</p>' +
        '<button class="btn block" type="button" data-act="account">Create a free account or sign in</button><button class="btn ghost block" type="button" data-act="preset" data-kind="custom">Type it in instead</button>');
      return;
    }
    sheet('<h2>Fill it in from a recipe</h2><p class="muted">Paste the recipe, or add a photo or screenshot of it. It is read once and not kept; you check the draft before anything is saved.</p>' +
      '<form id="readForm" novalidate><label class="field"><span>Paste the recipe</span><textarea class="input" name="text" maxlength="8000" placeholder="Grandma’s stuffing…"></textarea></label>' +
      '<label class="field"><span>Or a photo or screenshot of it</span><input class="input" type="file" name="photo" accept="image/*"></label>' +
      '<div id="formErr"></div><button class="btn block" type="submit">Read it</button><button class="btn ghost block" type="button" data-act="preset" data-kind="custom">Type it in instead</button></form>', function (root) {
      $('#readForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f), file = f.photo.files && f.photo.files[0];
        var body = { unit: g.unit };
        if (!file && !f.text.value.trim()) { showError(new Error('Paste the recipe, or add a photo of it.'), $('#formErr', root)); return; }
        btn.disabled = true; btn.textContent = 'Reading…';
        (file ? shrink(file).then(function (p) { body.photo = p; }) : Promise.resolve(body.text = f.text.value)).then(function () { return api('POST', 'api/read', body); })
          .then(function (r) { dishSheet(null, r.draft, DRAFT_NOTE); })
          .catch(function (err) { btn.disabled = false; btn.textContent = 'Read it'; showError(err, $('#formErr', root)); });
      });
    });
  }

  /* ---------------- the example ---------------- */

  function startDemo() {
    closeSheet(true);
    state.demo = D.doc(); state.g = C.view(state.demo, D.ME); state.memo = null; state.view = 'today';
    history.replaceState(null, '', BASE + '#today'); draw(); scrollTo(0, 0);
  }
  function leaveDemo() {
    state.demo = null; state.g = null; state.memo = null; closeSheet(true);
    if (state.prefs.cur) { enter(state.prefs.cur); return; }
    go('home');
  }

  /* ---------------- the account (only for a second phone, and the one AI step) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }
  /** Signed in: keep this phone's dinners on the account, and bring the
   *  account's to this phone. */
  function syncMine() {
    if (!signedIn() || !state.me.keep) return Promise.resolve();
    var chain = Promise.resolve();
    state.list.forEach(function (g) { chain = chain.then(function () { return api('POST', 'api/d/' + encodeURIComponent(g.id) + '/keep').catch(function () { /* gone, or not ours */ }); }); });
    return chain.then(function () { return api('GET', 'api/mine'); }).then(function (r) {
      var have = {}; state.list.forEach(function (g) { have[g.id] = 1; });
      (r.list || []).forEach(function (g) { if (!have[g.id]) state.list.push(g); });
      real.putList(state.list); state.list = real.getList();
      if (state.view === 'home') keepPlace(draw);
    }).catch(function () { /* the phone's own list stands */ });
  }
  var FREE_LINE = 'Baste is free with no account. A free account does two things: your dinners open on your other phone, and you can fill a dish in from a recipe. One account works across every app on this site.';
  function openAccount() {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2><p class="muted">' + esc(FREE_LINE) + '</p>' +
        '<form id="authForm"><label class="field"><span>Your email (for your account only - never shown to anyone at the dinner)</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div><button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center mt16">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      function done() { closeSheet(); return loadMe().then(function () { toast('You’re in.'); return syncMine(); }).then(function () { keepPlace(draw); }); }
      $('#swap', root).addEventListener('click', function () { mode = mode === 'register' ? 'login' : 'register'; draw2(root); });
      $('#authForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(done).catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(done).catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('', draw2);
  }
  function openAccountSheet() {
    sheet('<h2>Account</h2><p class="small muted">' + esc(state.me.email) + '</p><p class="small">Your dinners are kept on this account, so they open on your other phone when you sign in there. Nobody at the dinner ever sees this address.</p>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button">Set up Face ID for this phone</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button">Sign out</button>', function (root) {
      $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); keepPlace(draw); }); });
      var pk = $('#pkEnrol', root);
      if (pk) pk.addEventListener('click', function () {
        var pw = prompt('Your password, to confirm it is you:');
        if (!pw) return;
        Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); }).catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
      });
    });
  }

  /* ---------------- wiring: one listener per kind of event ---------------- */

  function gCall(method, tail, ok) {
    if (state.demo) { toast('In the example that is switched off.'); return; }
    api(method, 'api/d/' + encodeURIComponent(state.g.id) + tail).then(ok).catch(function (er) { showError(er); });
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var a = el.dataset.act, id = el.dataset.id, key = el.dataset.key;
    if (a === 'home') { e.preventDefault(); closeSheet(true); if (state.demo) { state.demo = null; state.g = null; } go('home'); }
    else if (a === 'tab') { if (state.g) go(el.dataset.tab); }
    else if (a === 'closesheet') closeSheet();
    else if (a === 'account') { if (signedIn()) openAccountSheet(); else openAccount(); }
    else if (a === 'new') { if (state.demo) { state.demo = null; state.g = null; } go('new'); }
    else if (a === 'join') joinSheet('');
    else if (a === 'demo') startDemo();
    else if (a === 'leavedemo') leaveDemo();
    else if (a === 'open') enter(id);
    else if (a === 'add') pickSheet();
    else if (a === 'preset') dishSheet(null, C.fromPreset(el.dataset.kind));
    else if (a === 'bring') { var mine = C.fromPreset('custom'); mine.guest = true; mine.prep = 0; mine.cook = 20; mine.rest = 0; dishSheet(null, mine); }
    else if (a === 'recipe') recipeSheet();
    else if (a === 'dish') dishSheet(id);
    else if (a === 'step') stepSheet(key);
    else if (a === 'details') detailsSheet();
    else if (a === 'done') {
      var s = stepByKey(key), label = s ? C.stepText(s, state.g).title : '';
      act({ t: 'done', key: key, on: true, when: el.dataset.when === 'time' ? 'time' : 'now' }, function () { say(label + ': done'); if (!$('#sheet').hidden) closeSheet(); toast(label + ' - done.'); });
    }
    else if (a === 'undone') act({ t: 'done', key: key, on: false });
    else if (a === 'claimstep') act({ t: 'claimstep', key: key, on: el.dataset.on !== '0' }, function () { if (el.dataset.on !== '0') toast('It’s yours.'); });
    else if (a === 'claim') act({ t: 'claim', id: id, on: el.dataset.on !== '0' }, function () { var d = dishById(id); if (d && el.dataset.on !== '0') toast('You’ve got the ' + C.lower(d.name) + '.'); });
    else if (a === 'late') {
      act(el.dataset.set !== undefined ? { t: 'late', id: id, set: 0 } : { t: 'late', id: id, add: Number(el.dataset.add) }, function () {
        var p = plan(), d = dishById(id);
        toast(p.moved ? 'Dinner is now ' + clk(p.serveAt) + '.' : (d && d.late ? d.name + ': ' + dur(d.late) + ' late - dinner still holds.' : 'Back on time.'), 4500);
      });
    }
    else if (a === 'fix') { var c = plan().conflicts[Number(el.dataset.c)], f = c && c.fixes[Number(el.dataset.f)]; if (f) act({ t: 'fix', changes: f.changes }, function () { var left = plan().conflicts.length; toast(left ? 'Done. ' + plural(left, 'conflict') + ' left.' : 'Done - the oven works now.', 4500); }); }
    else if (a === 'unfix') act({ t: 'fix', changes: [{ id: id, k: 'clear' }] }, function () { closeSheet(); toast('Back to its own times.'); });
    else if (a === 'moveto') act({ t: 'details', title: state.g.title, eatLocal: el.dataset.local, tz: state.g.tz, ovens: state.g.ovens, fit: state.g.fit, unit: state.g.unit }, function () { toast('Dinner is at ' + clk(state.g.eatAt) + '.'); });
    else if (a === 'remove') { if (confirm('Take this dish off the plan for everyone?')) act({ t: 'del', id: id }, function () { closeSheet(); toast('Off the plan.'); }); }
    else if (a === 'share') {
      var text = 'Help with ' + state.g.title + ' - the whole plan, live, and what still needs doing:';
      if (navigator.share) navigator.share({ title: 'Baste - ' + state.g.title, text: text, url: link() }).catch(function () { /* cancelled */ }); else copy(text + ' ' + link(), 'Link copied - paste it in the family chat.');
    }
    else if (a === 'copycode') copy(link(), 'Link copied - paste it in the family chat.');
    else if (a === 'kick') { if (confirm('Remove ' + el.dataset.name + ' from this dinner? Their dishes stay on the plan.')) gCall('DELETE', '/members/' + encodeURIComponent(id), function (r) { adopt(r.g); redraw(); }); }
    else if (a === 'leave') { if (confirm('Leave this dinner? You can rejoin with the code.')) gCall('DELETE', '/me', function () { forgetLocal(state.g.id); state.g = null; go('home'); toast('You left.'); }); }
    else if (a === 'delete') { if (confirm('Delete this dinner for everyone? The plan and every dish on it are gone for good.')) gCall('DELETE', '', function () { forgetLocal(state.g.id); state.g = null; go('home'); toast('Deleted.'); }); }
  });
  window.addEventListener('popstate', function () { closeSheet(true); route(); });
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') schedulePoll(0); else clearTimeout(pollTimer); });
  // The countdowns move every second; what is "now" and what is "next"
  // moves with the clock, so the page is drawn again every 15 seconds
  // unless someone is in the middle of a sheet.
  setInterval(tick, 1000);
  setInterval(function () { if (state.g && !state.demo && document.visibilityState === 'visible' && $('#sheet').hidden && TABS.indexOf(state.view) >= 0) keepPlace(draw); }, 15000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* no offline copy; online it still works */ });

  /* ---------------- boot ---------------- */

  draw();
  loadMe().then(syncMine);
  var h0 = location.hash.replace(/^#/, '');
  if (/^join=/.test(h0) || h0 === 'try' || h0 === 'new') route();
  else if (state.prefs.cur && h0 !== 'home') enter(state.prefs.cur, TABS.indexOf(h0) >= 0 ? h0 : null);
  else route();
})();
