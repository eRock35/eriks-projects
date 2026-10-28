/* Tada - the page. One file, no build step.
 *
 * EVERYTHING LIVES ON THIS DEVICE. The children, their routines, today's
 * taps, the stickers, the clocks-change plan and this device's own sound
 * and read-aloud choices are kept in localStorage (every access wrapped).
 * Nothing is sent anywhere unless the parent signs in: then the family
 * syncs to their account (whole-document saves with a version, and a
 * "use theirs / keep mine" choice when another device saved first), each
 * tap is sent as one key, and two optional AI helpers can be asked, with
 * what is sent shown first and every child's name replaced by "my child".
 *
 * Every string a person typed, the server sent or a model wrote is escaped
 * before it is drawn, and no handler is written into markup: clicks are
 * routed by data-act attributes from one listener (the lab's CSP allows
 * script from this origin only). Kid mode has no links in it at all.
 */
(function () {
  'use strict';

  var C = window.TadaCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var K_FAMILY = 'tada-family-v1', K_PROGRESS = 'tada-progress-v1', K_SYNC = 'tada-sync-v1', K_PREFS = 'tada-prefs-v1';

  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; } }());
  var H12 = (function () {
    try { var o = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions(); return o.hourCycle ? /h1[12]/.test(o.hourCycle) : o.hour12 !== false; } catch (e) { return true; }
  }());
  var RM = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function nowMin() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function fmt(min) { return C.fmtTime(min, H12); }
  function uid() { return (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).slice(-12); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  /* ---------------- state ---------------- */

  var savedFamily = recall(K_FAMILY);
  var prefs = Object.assign({ sound: true, readAloud: false, child: null }, recall(K_PREFS) || {});
  var sync = Object.assign({ base: null, dirty: false, queue: [] }, recall(K_SYNC) || {});
  if (!Array.isArray(sync.queue)) sync.queue = [];
  var state = {
    family: savedFamily ? C.cleanFamily(savedFamily) : null,
    progress: C.cleanProgress(recall(K_PROGRESS), today()),
    me: null,
    view: 'start',
    setup: null,
    edit: null,          // {childId, r (a copy), isNew}
    kid: null,           // kid mode, when open
    openTicks: {},
    syncState: 'local',  // local | syncing | synced | error | conflict
    conflict: null,
  };
  if (state.family && !state.family.children.length) state.family = null;

  function children() { return state.family ? state.family.children : []; }
  function childById(id) { return children().filter(function (c) { return c.id === id; })[0] || null; }
  function routineOf(child, id) { return child ? child.routines.filter(function (r) { return r.id === id; })[0] || null : null; }
  function colorOf(child) { return (C.COLORS.filter(function (x) { return x.id === child.color; })[0] || C.COLORS[0]).hex; }
  function nameOf(child) { return child.name || (children().length > 1 ? 'Child ' + (children().indexOf(child) + 1) : 'Your child'); }
  function plan() { return state.family ? state.family.settings.plan : null; }
  function shiftOf(r, day) { return C.shiftFor(plan(), day || today(), r.kind); }
  function timesOf(r, day) { return C.timesFor(r, shiftOf(r, day)); }
  function activeChild() {
    var c = childById(prefs.child) || children()[0] || null;
    return c;
  }
  function setActive(id) { prefs.child = id; keep(K_PREFS, prefs); }

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
  function toast(msg, opts) {
    $$('.toast').forEach(function (t) { t.remove(); });
    clearTimeout(toastTimer);
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status');
    var span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
    if (opts && opts.undo) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Undo';
      b.addEventListener('click', function () { t.remove(); opts.undo(); });
      t.appendChild(b);
    }
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, (opts && opts.ms) || (opts && opts.undo ? 7000 : 2800));
  }
  function say(msg) { var l = $('#live'); if (l) { l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); } }
  function download(name, type, text) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'routine'; }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function canSync() { return signedIn() && state.me.sync && Boolean(state.family); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, { ms: 4200 });
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Templates and the editor stay free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
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
    if (err.data && err.data.code === 'verify-email') verifyNote(box, err);
    else showError(err, box);
    scrollIntoSheet(box);
  }

  /* ---------------- the family on this device, and in the account ---------------- */

  var pushTimer = null;
  function saveFamily() {
    if (!state.family) { keep(K_FAMILY, null); return; }
    state.family.updatedAt = Date.now();
    keep(K_FAMILY, state.family);
    sync.dirty = true; keep(K_SYNC, sync);
    if (canSync()) {
      clearTimeout(pushTimer);
      state.syncState = 'syncing'; drawSync();
      pushTimer = setTimeout(pushFamily, 700);
    }
  }
  function keepProgress() { keep(K_PROGRESS, state.progress); }
  function pushFamily() {
    if (!canSync() || state.conflict) return Promise.resolve();
    return api('PUT', 'api/family', { family: state.family, base: sync.base }).then(function (r) {
      sync.base = r.version; sync.dirty = false; keep(K_SYNC, sync);
      state.syncState = 'synced'; drawSync();
    }).catch(function (err) {
      if (err.status === 409 && err.data && err.data.family) {
        state.conflict = { family: C.cleanFamily(err.data.family), version: err.data.version };
        state.syncState = 'conflict'; drawSync();
        if (!state.kid) openConflict();
        return;
      }
      state.syncState = 'error'; drawSync();
    });
  }
  function adopt(family, version) {
    state.family = family && family.children.length ? family : state.family;
    sync.base = version; sync.dirty = false; keep(K_SYNC, sync);
    keep(K_FAMILY, state.family);
    state.syncState = 'synced';
  }
  function same(a, b) { return JSON.stringify(Object.assign({}, a, { updatedAt: 0 })) === JSON.stringify(Object.assign({}, b, { updatedAt: 0 })); }
  /** On sign-in and when the app comes back: bring the two copies together. */
  function syncIn() {
    if (!signedIn() || !state.me.sync) return Promise.resolve();
    state.syncState = 'syncing'; drawSync();
    return api('GET', 'api/family').then(function (r) {
      var server = r.family && r.family.children.length ? C.cleanFamily(r.family) : null;
      var local = state.family;
      if (!server) {
        if (local) { sync.base = null; return pushFamily(); }
        state.syncState = 'synced'; drawSync(); return null;
      }
      if (!local) { adopt(server, r.version); route(); return null; }
      if (same(local, server)) { sync.base = r.version; sync.dirty = false; keep(K_SYNC, sync); state.syncState = 'synced'; drawSync(); return null; }
      if (!sync.dirty) { adopt(server, r.version); if (!state.kid && state.view !== 'edit') draw(); else drawSync(); return null; }
      if (sync.base === r.version) return pushFamily();
      state.conflict = { family: server, version: r.version };
      state.syncState = 'conflict'; drawSync();
      if (!state.kid) openConflict();
      return null;
    }).then(pullProgress).then(flushTaps).catch(function () { state.syncState = 'error'; drawSync(); });
  }
  function openConflict() {
    var cf = state.conflict;
    if (!cf) return;
    var count = function (f) {
      var n = 0; f.children.forEach(function (c) { n += c.routines.length; });
      return f.children.map(function (c, i) { return c.name || 'Child ' + (i + 1); }).join(', ') + ' · ' + plural(n, 'routine'); // plain text, escaped whole
    };
    var when = cf.family.updatedAt ? new Date(cf.family.updatedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    sheet('<h2>Changed on another device</h2><p class="muted">Your family was saved on another device after this one last synced. Which one should both keep?</p>' +
      '<div class="note"><b>On your account</b><p class="small" style="margin:4px 0 0">' + esc(count(cf.family)) + (when ? ' · saved ' + esc(when) : '') + '</p></div>' +
      '<div class="note" style="margin-top:8px"><b>On this device</b><p class="small" style="margin:4px 0 0">' + esc(count(state.family)) + '</p></div>' +
      '<div class="row" style="margin-top:14px"><button class="btn" type="button" data-act="usetheirs">Use the account’s</button><button class="btn ghost" type="button" data-act="keepmine">Keep this device’s</button></div>' +
      '<p class="small muted">Today’s ticks and stickers are kept either way - they never clash.</p>');
  }

  /* ---- taps: each one a key of its own ---- */

  // Every tap is queued, signed in or not, so signing in later sends the
  // last two weeks' ticks along with the family.
  function queueTap(t) {
    sync.queue.push(t);
    if (sync.queue.length > 600) sync.queue = sync.queue.slice(-600);
    keep(K_SYNC, sync);
    flushTaps();
  }
  var flushing = false;
  function flushTaps() {
    if (flushing || !signedIn() || !state.me.sync || !sync.queue.length) return Promise.resolve();
    flushing = true;
    var td = today();
    var lo = C.addDays(td, -(C.LIMITS.progressDays - 1));
    sync.queue = sync.queue.filter(function (t) { return t.day >= lo && t.day <= C.addDays(td, 1); });
    var batch = sync.queue.slice(0, C.LIMITS.tapsPerRequest);
    if (!batch.length) { flushing = false; keep(K_SYNC, sync); return Promise.resolve(); }
    return api('POST', 'api/progress', { today: td, taps: batch }).then(function () {
      sync.queue = sync.queue.slice(batch.length); keep(K_SYNC, sync);
      flushing = false;
      if (sync.queue.length) return flushTaps();
      return null;
    }).catch(function (err) {
      flushing = false;
      if (err.status === 400) { sync.queue = sync.queue.slice(batch.length); keep(K_SYNC, sync); }
    });
  }
  function pullProgress() {
    if (!signedIn() || !state.me.sync) return Promise.resolve();
    return api('GET', 'api/progress?today=' + today()).then(function (r) {
      var before = JSON.stringify(state.progress);
      state.progress = C.cleanProgress(C.mergeProgress(state.progress, r.progress), today());
      keepProgress();
      if (JSON.stringify(state.progress) !== before) {
        if (state.kid) drawKid(); else if (state.view === 'today' || state.view === 'stickers') draw();
      }
    }).catch(function () { /* stays local */ });
  }
  function tap(childId, routineId, stepId, done) {
    var t = { day: today(), c: childId, r: routineId, s: stepId, v: (done ? 1 : -1) * Date.now() };
    C.applyTap(state.progress, t);
    keepProgress();
    queueTap(t);
    var child = childById(childId), r = routineOf(child, routineId);
    if (done && r && C.doneIds(state.progress, t.day, childId, routineId).size >= r.steps.length && !C.isFinished(state.progress, t.day, childId, routineId)) {
      var f = { day: t.day, c: childId, r: routineId, fin: Date.now() };
      C.applyTap(state.progress, f);
      keepProgress();
      queueTap(f);
      return true;
    }
    return false;
  }

  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }
  function syncLine() {
    if (!state.family) return '';
    if (!signedIn()) return 'Saved on this device · <button class="link-btn" type="button" data-act="signin-sync">sign in to share it with the family tablet</button>';
    if (state.me && !state.me.sync) return 'Saved on this device (sync is unavailable right now)';
    if (state.syncState === 'syncing') return 'Syncing…';
    if (state.syncState === 'conflict') return 'Changed on another device · <button class="link-btn" type="button" data-act="conflict">choose which to keep</button>';
    if (state.syncState === 'error') return 'Couldn’t sync - saved on this device. <button class="link-btn" type="button" data-act="retrysync">Try again</button>';
    return '✓ Synced to your account';
  }

  /* ---------------- the clocks change ---------------- */

  var changeCache = { at: 0, v: null };
  function change() {
    if (!TZ) return null;
    var now = Date.now();
    if (now - changeCache.at < 60000) return changeCache.v;
    var v = null;
    try { v = C.nextChange(now, TZ, 60); } catch (e) { v = null; }
    changeCache = { at: now, v: v };
    return v;
  }
  function expirePlan() {
    var p = plan();
    if (p && today() >= p.day) { state.family.settings.plan = null; saveFamily(); }
  }
  function hasTimed() { return children().some(function (c) { return c.routines.some(function (r) { return r.kind === 'bedtime' || r.kind === 'morning'; }); }); }
  function changeWords(ch) {
    var back = ch.delta < 0;
    var mins = Math.abs(ch.delta);
    return {
      title: 'Clocks go ' + (back ? 'back' : 'forward') + ' ' + C.niceDay(ch.day),
      when: 'At ' + fmt(ch.wallFrom) + ' they ' + (back ? 'go back' : 'jump') + ' to ' + fmt(ch.wallTo) + (mins !== 60 ? ' (' + mins + ' minutes)' : '') + '.',
      way: back ? 'later' : 'earlier',
    };
  }
  function clocksCard() {
    if (!state.family || !hasTimed()) return '';
    var p = plan();
    var td = today();
    if (p) {
      var hit = p.days.filter(function (d) { return d.day === td; })[0];
      var first = p.days[0];
      var lines = [];
      children().forEach(function (c) {
        c.routines.forEach(function (r) {
          if (r.kind !== 'bedtime' || !C.runsOn(r, td)) return;
          lines.push(esc(nameOf(c)) + ': lights out ' + esc(fmt(timesOf(r, td).doneBy)));
        });
      });
      return '<section class="card clocks" aria-labelledby="clkH"><h2 id="clkH"><span class="emo" aria-hidden="true">🕑</span> Easing into the clock change</h2>' +
        (hit ? '<p><b>Today: ' + Math.abs(hit.shift) + ' minutes ' + (hit.shift > 0 ? 'later' : 'earlier') + '.</b> ' + (lines.length ? lines.join(' · ') : '') + '</p>'
          : '<p>Starts ' + esc(C.niceDay(first.day)) + ': ' + Math.abs(first.shift) + ' minutes ' + (first.shift > 0 ? 'later' : 'earlier') + ', then ' + Math.abs(p.days[1] ? p.days[1].shift - first.shift : 15) + ' more each day.</p>') +
        '<p class="small muted">' + (p.mornings ? 'Bedtime and mornings move by themselves' : 'Bedtime moves by itself; mornings stay put') + '. From ' + esc(C.niceDay(p.day)) + ' it is back to the usual times on the new clock.</p>' +
        '<div class="row"><button class="btn small ghost" type="button" data-act="showplan">See the days</button><button class="btn small ghost" type="button" data-act="undoplan">Undo the plan</button></div></section>';
    }
    var ch = change();
    if (!ch || state.family.settings.planDismissed === ch.at) return '';
    var offer = C.clockPlan(ch, td);
    if (!offer) return '';
    var w = changeWords(ch);
    return '<section class="card clocks" aria-labelledby="clkH"><h2 id="clkH"><span class="emo" aria-hidden="true">🕑</span> ' + esc(w.title) + '. Ease bedtime over ' + plural(offer.days.length, 'day') + '?</h2>' +
      '<p>' + esc(w.when) + ' Young children’s sleep is thrown by it. Move lights-out ' + Math.abs(offer.days[0].shift) + ' minutes ' + w.way + ' each night from ' + esc(C.niceDay(offer.days[0].day)) + ', and on ' + esc(C.niceDay(ch.day)) + ' the usual time will feel normal.</p>' +
      '<div class="row"><button class="btn small night" type="button" data-act="planoffer">See the plan</button><button class="btn small ghost" type="button" data-act="plannotnow">Not now</button></div></section>';
  }
  /** The plan, a day per row: who goes to bed when, and (if they move)
   *  when they leave. Compact enough to read on a phone. */
  function planList(p, ch) {
    var rows = p.days.map(function (d) {
      var night = [], morning = [];
      children().forEach(function (c) {
        c.routines.forEach(function (r) {
          if (!C.runsOn(r, d.day)) return;
          var sh = C.shiftFor(p, d.day, r.kind);
          if (!sh) return;
          var t = C.timesFor(r, sh);
          (r.kind === 'bedtime' ? night : morning).push(esc(nameOf(c)) + ' ' + esc(fmt(t.doneBy)));
        });
      });
      return '<li><div class="row spread"><b>' + esc(C.niceDay(d.day)) + '</b><span class="pill">' + (d.shift > 0 ? '+' : '−') + Math.abs(d.shift) + ' min</span></div>' +
        (night.length ? '<span><span class="emo" aria-hidden="true">🌙</span> Lights out: ' + night.join(' · ') + '</span>' : '') +
        (morning.length ? '<span><span class="emo" aria-hidden="true">🌞</span> Out the door: ' + morning.join(' · ') + '</span>' : '') + '</li>';
    }).join('');
    return '<ol class="plan-days">' + rows + '<li><div class="row spread"><b>' + esc(C.niceDay(p.day)) + '</b><span class="pill ok">New clock</span></div><span>Back to the usual times.</span></li></ol>';
  }
  function openPlan(offer, ch) {
    var draftPlan = clone(offer);
    function body(root) {
      var w = changeWords(ch);
      $('.body', root).innerHTML = '<h2>' + esc(w.title) + '</h2><p class="muted">' + esc(w.when) + ' Lights-out moves ' + Math.abs(draftPlan.days[0].shift) + ' minutes ' + w.way + ' each day, so the new clock’s usual time feels normal on ' + esc(C.niceDay(ch.day)) + '. Tada changes the times by itself on these days, and you can undo it any time.</p>' +
        '<button class="switch" type="button" role="switch" aria-checked="' + (draftPlan.mornings ? 'true' : 'false') + '" data-act="planmornings"><span><b>Move mornings too</b><span class="small muted">Wake-up and out-the-door shift the same way. Leave it off on school days - the bus won’t wait.</span></span><span class="knob" aria-hidden="true"></span></button>' +
        '<div class="row" style="margin:14px 0"><button class="btn night" type="button" data-act="planuse">Use this plan</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button></div>' +
        '<p class="lab">Day by day</p>' + planList(draftPlan, ch);
    }
    planDraft = { plan: draftPlan, change: ch, redraw: body };
    sheet('<div class="body"></div>', body);
  }
  var planDraft = null;

  /* ---------------- routing ---------------- */

  function go(hash) {
    history.pushState(null, '', BASE + '#' + hash);
    route(); scrollTo(0, 0);
  }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    var m;
    if (!state.family) {
      if (h === 'setup') { if (!state.setup) state.setup = newSetup(); state.view = 'setup'; }
      else state.view = 'start';
      return draw();
    }
    if (h === 'routines' || h === 'stickers' || h === 'today') state.view = h;
    else if ((m = /^edit\/([a-z0-9]+)\/([a-z0-9]+)$/.exec(h))) {
      var c = childById(m[1]), r = routineOf(c, m[2]);
      if (state.edit && state.edit.childId === m[1] && state.edit.r.id === m[2]) state.view = 'edit';
      else if (r) { state.edit = { childId: c.id, r: clone(r), isNew: false }; state.view = 'edit'; }
      else state.view = 'routines';
    } else state.view = 'today';
    draw();
  }
  window.addEventListener('popstate', function () {
    if (state.kid) { history.pushState(null, '', location.href); return; }
    route();
  });

  function draw() {
    closeSheet(true);
    var main = $('#main');
    var tab = state.view === 'edit' ? 'routines' : state.view;
    var showTabs = Boolean(state.family) && state.view !== 'setup' && state.view !== 'start';
    $('#tabbar').hidden = !showTabs;
    $$('#tabbar [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var html;
    if (state.view === 'setup') html = setupHtml();
    else if (state.view === 'today') html = todayHtml();
    else if (state.view === 'routines') html = routinesHtml();
    else if (state.view === 'edit') html = editHtml();
    else if (state.view === 'stickers') html = stickersHtml();
    else html = startHtml();
    main.innerHTML = html;
    wire();
  }

  /* ---------------- the first screen ---------------- */

  function stars(n) {
    var out = '';
    for (var i = 0; i < n; i++) out += '<i style="left:' + (62 + (i * 37) % 36) + '%;top:' + (3 + (i * 53) % 30) + '%"></i>';
    return out;
  }
  function startHtml() {
    var ch = change();
    return '<section class="hero" aria-labelledby="heroH"><div class="sky" aria-hidden="true">' + stars(14) + '</div><div class="hero-grid"><div>' +
      '<h1 id="heroH">Tada <span class="emo" aria-hidden="true">🎉</span></h1>' +
      '<p class="lead">Routines your kids tap through - out the door on time, into bed without the battle.</p>' +
      '<p class="soft">For children about 3 to 10. One step at a time, a big Done! button, a sticker at the end - and the start time worked out for you.</p>' +
      '<div class="row" style="margin:16px 0 10px"><button class="btn big cta" type="button" data-act="setup">Set up in a minute</button><button class="btn big ghost" type="button" data-act="demo">▶ Try it</button></div>' +
      '<p class="small soft" style="margin:0">Free, no account, works offline. Everything stays on this device.</p>' +
      '</div><div class="mock" aria-hidden="true"><div class="dots"><i class="on"></i><i class="on"></i><i></i><i></i><i></i></div><span class="big-emo emo">🪥</span><b>Brush your teeth</b><span class="mock-time">About 2 minutes</span><span class="mock-done">Done!</span></div></div></section>' +
      '<section class="how grid three" aria-label="How it works">' +
      '<div class="card"><span class="emo" aria-hidden="true">👆</span><h3>One step at a time</h3><p class="muted" style="margin:0">Big pictures and one big Done! button, so pre-readers can do it on their own. Read-aloud if you want it. A sticker at the end.</p></div>' +
      '<div class="card"><span class="emo" aria-hidden="true">⏰</span><h3>“Start by 7:05 PM”</h3><p class="muted" style="margin:0">Tell Tada when lights go out or when you leave. It works the start time back from the steps, and shows if anyone’s running behind.</p></div>' +
      '<div class="card"><span class="emo" aria-hidden="true">🕑</span><h3>Clocks change? Eased.</h3><p class="muted" style="margin:0">Before the clocks go back or forward, Tada moves bedtime 15 minutes a day, so nobody’s thrown by the new time.</p></div>' +
      '</section>' +
      (ch ? '<section class="card teaser"><p style="margin:0"><b>' + esc(changeWords(ch).title) + '.</b> ' + esc(changeWords(ch).when) + ' Set up a bedtime and Tada will offer to ease it over the days before.</p></section>' : '') +
      '<section class="card teaser"><h2>Also in Tada</h2><ul class="muted" style="margin:0;padding-left:20px"><li>Up to four children, each with their own routines - side by side on a tablet</li><li>A sticker book and a gentle streak - no racing a brother or sister</li><li>A fridge chart to print, and “Start bedtime” in your calendar</li><li>Sign in (free) to share it all between your phone and the family tablet</li></ul></section>';
  }

  /* ---------------- setup: three short steps ---------------- */

  function newSetup() { return { step: 1, morning: false, bedtime: true, name: '', band: 'middle', avatar: '🦊', out: '08:00', lights: '20:00', lightsSet: false }; }
  function setupHtml() {
    var s = state.setup || (state.setup = newSetup());
    var bar = '<div class="steps-bar" aria-hidden="true">' + [1, 2, 3, 4].map(function (i) { return '<i' + (i <= s.step ? ' class="on"' : '') + '></i>'; }).join('') + '</div>';
    var head = '<p class="lab">' + (s.step < 4 ? 'Step ' + s.step + ' of 3' : 'Ready') + '</p>';
    var nav = function (next, nextLabel) {
      return '<div class="setup-nav"><button class="btn ghost" type="button" data-act="su-back">‹ Back</button>' +
        (s.step < 4 ? '<button class="link-btn" type="button" data-act="su-skip">Skip - use the usual</button>' : '') +
        (next ? '<button class="btn big go" type="button" data-act="' + next + '">' + nextLabel + '</button>' : '') + '</div>';
    };
    var body = '';
    if (s.step === 1) {
      var k = s.morning && s.bedtime ? 'both' : s.morning ? 'morning' : 'bedtime';
      body = '<h1>Which routine first?</h1><p class="muted">You can add the other one, or a bath night, any time.</p><div class="choices three" role="group" aria-label="Routine">' +
        [['morning', '🌞', 'Morning', 'Out the door on time'], ['bedtime', '🌙', 'Bedtime', 'Into bed without the battle'], ['both', '🌞🌙', 'Both', 'A morning and a bedtime']].map(function (x) {
          return '<button class="choice" type="button" data-act="su-kind" data-k="' + x[0] + '" aria-pressed="' + (k === x[0]) + '"><span class="emo' + (x[0] === 'both' ? ' pair' : '') + '" aria-hidden="true">' + x[1] + '</span><b>' + x[2] + '</b><span>' + x[3] + '</span></button>';
        }).join('') + '</div>' + nav('su-next', 'Next');
    } else if (s.step === 2) {
      body = '<h1>Who’s it for?</h1>' +
        '<label class="field"><span>First name or nickname <span class="hint">- optional, stays on this device</span></span><input class="input" id="suName" maxlength="24" autocomplete="off" autocapitalize="words" value="' + esc(s.name) + '"></label>' +
        '<p class="field" style="margin-bottom:4px"><span>Age</span></p><div class="seg" role="group" aria-label="Age">' + C.BANDS.map(function (b) { return '<button type="button" data-act="su-band" data-b="' + b.id + '" aria-pressed="' + (s.band === b.id) + '">' + b.label + '</button>'; }).join('') + '</div>' +
        '<p class="small muted" style="margin-top:6px">The ready-made steps change with age: potty and story time for the littlest, packing their own bag for the biggest.</p>' +
        '<p class="field" style="margin-bottom:4px"><span>Pick an animal</span></p><div class="avatars" role="group" aria-label="Animal">' + C.AVATARS.map(function (a, i) { return '<button type="button" class="emo" data-act="su-avatar" data-a="' + a + '" aria-pressed="' + (s.avatar === a) + '" aria-label="' + C.AVATAR_NAMES[i] + '">' + a + '</button>'; }).join('') + '</div>' +
        nav('su-next', 'Next');
    } else if (s.step === 3) {
      if (!s.lightsSet) s.lights = C.template('bedtime').doneBy[s.band];
      body = '<h1>When does it need to be done?</h1><p class="muted">Tada works the start time back from this.</p>' +
        (s.morning ? '<label class="field"><span>🌞 Out the door by</span><input class="input" type="time" id="suOut" value="' + esc(s.out) + '"></label>' : '') +
        (s.bedtime ? '<label class="field"><span>🌙 Lights out by</span><input class="input" type="time" id="suLights" value="' + esc(s.lights) + '"></label>' : '') +
        nav('su-next', 'Show me');
    } else {
      var made = setupRoutines(s, function () { return 'preview'; });
      body = '<h1>' + (s.name ? 'Here’s ' + esc(s.name) + '’s ' : 'Here’s a ') + (made.length > 1 ? 'morning and bedtime' : made[0].kind === 'morning' ? 'morning' : 'bedtime') + '</h1>' +
        '<p class="muted">Ready-made for ages ' + esc(C.BANDS.filter(function (b) { return b.id === s.band; })[0].label) + '. Change any step later - names, pictures, minutes, order, days.</p>' +
        made.map(function (r) {
          var t = C.timesFor(r, 0);
          return '<div class="card" style="margin-top:12px"><div class="row spread"><h2 style="margin:0"><span class="emo" aria-hidden="true">' + r.emoji + '</span> ' + esc(r.name) + '</h2><span class="small muted">' + esc(C.fmtDays(r.days)) + '</span></div>' +
            '<div class="startby' + (r.kind === 'bedtime' ? ' night' : '') + '"><b>Start by ' + esc(fmt(t.start)) + '</b><span>' + esc(C.DONE_BY_SHORT[r.kind]) + ' ' + esc(fmt(t.doneBy)) + ' · ' + plural(C.totalMinutes(r), 'minute') + ' of steps</span></div>' +
            '<ul class="preview">' + r.steps.map(function (st) { return '<li><span class="emo" aria-hidden="true">' + st.emoji + '</span><span>' + esc(st.name) + '</span><span class="mins">' + st.minutes + ' min</span></li>'; }).join('') + '</ul></div>';
        }).join('') +
        '<div class="setup-nav"><button class="btn ghost" type="button" data-act="su-back">‹ Back</button><button class="btn ghost" type="button" data-act="su-edit">Change the steps</button><button class="btn big go" type="button" data-act="su-done">Looks good - let’s go</button></div>';
    }
    return '<section class="setup card">' + bar + head + body + '</section>';
  }
  function setupRoutines(s, ids) {
    var out = [];
    if (s.morning) out.push(C.fromTemplate('school-morning', s.band, ids, { doneBy: s.out, today: today() }));
    if (s.bedtime) out.push(C.fromTemplate('bedtime', s.band, ids, { doneBy: s.lightsSet ? s.lights : C.template('bedtime').doneBy[s.band], today: today() }));
    return out;
  }
  function readSetup() {
    var s = state.setup; if (!s) return;
    var n = $('#suName'); if (n) s.name = C.line(n.value, C.LIMITS.childName);
    var o = $('#suOut'); if (o && C.toMin(o.value) !== null) s.out = o.value;
    var l = $('#suLights'); if (l && C.toMin(l.value) !== null) { if (l.value !== s.lights) s.lightsSet = true; s.lights = l.value; }
  }
  function finishSetup(thenEdit) {
    var s = state.setup;
    var child = { id: uid(), name: s.name, avatar: s.avatar, color: 'sun', band: s.band, routines: setupRoutines(s, uid) };
    state.family = C.cleanFamily({ children: [child], settings: {} });
    state.setup = null;
    setActive(child.id);
    saveFamily();
    if (thenEdit) go('edit/' + child.id + '/' + child.routines[0].id);
    else { go('today'); toast('All set. Tap ▶ Kid mode when it’s time.'); }
  }

  /* ---------------- today ---------------- */

  function todayHtml() {
    var td = today(), list = children();
    var single = list.length === 1;
    return '<div class="sec-head"><h1>Today</h1><span class="muted">' + esc(C.niceDay(td)) + '</span></div>' +
      clocksCard() +
      '<div class="kid-actions"><button class="btn big" type="button" data-act="kidpick">▶ Kid mode</button>' +
      (list.length > 1 ? '<button class="btn big ghost wide-only" type="button" data-act="side">Side by side</button>' : '') + '</div>' +
      '<div class="children">' + list.map(function (c) { return childCard(c, td); }).join('') +
      (list.length < C.LIMITS.children ? '<button class="add-child" type="button" data-act="addchild"><span class="emo" aria-hidden="true" style="font-size:1.6rem">＋</span>Add ' + (single ? 'another' : 'a') + ' child</button>' : '') + '</div>' +
      '<p class="small muted" data-sync style="margin-top:14px">' + syncLine() + '</p>';
  }
  /** Today's routines in the order a parent needs them: the one due now or
   *  next first, then the finished ones, then the ones whose time has gone. */
  function todaysOrdered(c, td) {
    var nm = nowMin();
    var rank = function (r) {
      if (C.isFinished(state.progress, td, c.id, r.id)) return 1;
      return nm > timesOf(r, td).doneBy + 90 ? 2 : 0;
    };
    return C.todays(c, td).map(function (r, i) { return { r: r, k: rank(r) * 100 + i }; }).sort(function (a, b) { return a.k - b.k; }).map(function (x) { return x.r; });
  }
  function childCard(c, td) {
    var rs = todaysOrdered(c, td);
    return '<article class="card" style="--c:' + colorOf(c) + '"><div class="child-head"><span class="avatar emo" aria-hidden="true">' + c.avatar + '</span><h2>' + esc(nameOf(c)) + '</h2><span class="band">' + esc(bandLabel(c.band)) + '</span></div>' +
      (rs.length ? rs.map(function (r) { return rtRow(c, r, td); }).join('')
        : '<p class="muted">Nothing on today.</p><button class="btn small ghost" type="button" data-act="routinesfor" data-c="' + c.id + '">Add a routine</button>') +
      '</article>';
  }
  function bandLabel(b) { return 'Ages ' + (C.BANDS.filter(function (x) { return x.id === b; })[0] || C.BANDS[1]).label; }
  function rtRow(c, r, td) {
    var done = C.doneIds(state.progress, td, c.id, r.id);
    var sh = shiftOf(r, td);
    var st = C.status(r, done, nowMin(), sh, H12);
    var key = c.id + '_' + r.id;
    var fin = C.isFinished(state.progress, td, c.id, r.id);
    var pct = Math.round(100 * st.done / Math.max(1, st.total));
    var open = Boolean(state.openTicks[key]);
    return '<div class="rt"><div class="rt-head"><span class="emo" aria-hidden="true">' + r.emoji + '</span><div><h3>' + esc(r.name) + '</h3>' +
      '<p class="small muted">Start by ' + esc(fmt(st.start)) + ' · ' + esc(C.DONE_BY_SHORT[r.kind]) + ' ' + esc(fmt(st.doneBy)) + '</p>' +
      (sh ? '<span class="pill">🕑 ' + Math.abs(sh) + ' min ' + (sh > 0 ? 'later' : 'earlier') + ' today</span>' : '') + '</div></div>' +
      '<div class="meter" role="progressbar" aria-label="' + esc(r.name) + ' steps done" aria-valuemin="0" aria-valuemax="' + st.total + '" aria-valuenow="' + st.done + '"><span style="width:' + pct + '%"></span></div>' +
      '<p class="status ' + st.state + '">' + esc(st.line) + (fin ? ' - <span class="emo">' + C.stickerFor(c.id, td, r.id) + '</span> sticker earned' : '') + '</p>' +
      '<div class="row">' + (fin ? '' : '<button class="btn small' + (st.state === 'past' ? ' ghost' : '') + '" type="button" data-act="kidgo" data-c="' + c.id + '" data-r="' + r.id + '">▶ Start</button>') +
      '<button class="btn small ghost" type="button" data-act="ticks" data-c="' + c.id + '" data-r="' + r.id + '" aria-expanded="' + open + '">' + (open ? 'Hide steps' : 'Tick steps') + '</button></div>' +
      (open ? '<ul class="ticks" aria-label="' + esc(r.name) + ' steps">' + r.steps.map(function (s) {
        var on = done.has(s.id);
        return '<li><button type="button" data-act="tick" data-c="' + c.id + '" data-r="' + r.id + '" data-s="' + s.id + '" aria-pressed="' + on + '"><span class="emo" aria-hidden="true">' + s.emoji + '</span><span>' + esc(s.name) + '</span><span class="box" aria-hidden="true">' + (on ? '✓' : '') + '</span></button></li>';
      }).join('') + '</ul>' : '') + '</div>';
  }

  /* ---------------- routines ---------------- */

  function kidTabs(active, act) {
    if (children().length < 2) return '';
    return '<div class="kidtabs" role="tablist" aria-label="Children">' + children().map(function (c) {
      return '<button type="button" role="tab" data-act="' + act + '" data-c="' + c.id + '" aria-selected="' + (c.id === active.id) + '"><span class="emo" aria-hidden="true">' + c.avatar + '</span><span>' + esc(nameOf(c)) + '</span></button>';
    }).join('') + '</div>';
  }
  function routinesHtml() {
    var c = activeChild();
    if (!c) return '';
    var full = c.routines.length >= C.LIMITS.routinesPerChild;
    return '<div class="sec-head"><h1>Routines</h1></div>' + kidTabs(c, 'pickchild') +
      '<div class="card" style="--c:' + colorOf(c) + ';margin-bottom:14px"><div class="child-head" style="margin:0"><span class="avatar emo" aria-hidden="true">' + c.avatar + '</span><div><h2>' + esc(nameOf(c)) + '</h2><span class="band">' + esc(bandLabel(c.band)) + '</span></div>' +
      '<button class="btn small ghost" type="button" data-act="editchild" data-c="' + c.id + '" style="margin-left:auto">Edit</button></div></div>' +
      (c.routines.length ? '<ul class="rt-list">' + c.routines.map(function (r) {
        var t = C.timesFor(r, 0);
        return '<li class="card rt-card"><button class="rt-open" type="button" data-act="edit" data-c="' + c.id + '" data-r="' + r.id + '"><span class="emo" aria-hidden="true">' + r.emoji + '</span><span><b>' + esc(r.name) + '</b><span class="small muted">' + esc(C.fmtDays(r.days)) + ' · ' + esc(C.DONE_BY_SHORT[r.kind]) + ' ' + esc(fmt(t.doneBy)) + ' · start by ' + esc(fmt(t.start)) + ' · ' + plural(r.steps.length, 'step') + ', ' + C.totalMinutes(r) + ' min</span></span><span class="chev" aria-hidden="true">›</span></button>' +
          '<div class="row"><button class="btn small ghost" type="button" data-act="print" data-c="' + c.id + '" data-r="' + r.id + '">🖨 Print the chart</button><button class="btn small ghost" type="button" data-act="ics" data-c="' + c.id + '" data-r="' + r.id + '" aria-describedby="ics-' + r.id + '">📅 Add to my calendar</button></div>' +
          '<p class="small muted" id="ics-' + r.id + '" style="margin:0">Calendar: “' + esc(C.startWord(r)) + '” at ' + esc(fmt(t.start)) + ', ' + esc(daysPhrase(r.days)) + '.</p></li>';
      }).join('') + '</ul>' : '<p class="muted">No routines yet.</p>') +
      '<div class="row" style="margin-top:14px"><button class="btn" type="button" data-act="newroutine" data-c="' + c.id + '"' + (full ? ' disabled' : '') + '>＋ New routine</button><button class="btn ghost ai" type="button" data-act="aibuild" data-c="' + c.id + '"' + (full ? ' disabled' : '') + '>Build from a sentence</button></div>' +
      (full ? '<p class="small muted">' + C.LIMITS.routinesPerChild + ' routines is the most for one child.</p>' : '') +
      (children().length < C.LIMITS.children ? '<p style="margin-top:18px"><button class="btn ghost" type="button" data-act="addchild">＋ Add a child</button></p>' : '') +
      '<p class="small muted" data-sync style="margin-top:14px">' + syncLine() + '</p>';
  }

  /* ---------------- the editor ---------------- */

  function editHtml() {
    var e = state.edit, r = e.r, c = childById(e.childId);
    var t = C.timesFor(r, 0);
    return '<div class="sec-head"><div class="row"><button class="btn small ghost" type="button" data-act="canceledit">‹ Routines</button><h1>' + (e.isNew ? 'New routine' : 'Edit routine') + '</h1></div><span class="muted">For ' + esc(nameOf(c)) + '</span></div>' +
      '<div class="edit-grid"><div class="edit-side"><div class="card">' +
      '<label class="field"><span>Name</span><input class="input" id="eName" maxlength="40" value="' + esc(r.name) + '"></label>' +
      '<p class="field" style="margin-bottom:4px"><span>Kind</span></p><div class="seg" role="group" aria-label="Kind">' + [['morning', '🌞 Morning'], ['bedtime', '🌙 Bedtime'], ['other', '⭐ Other']].map(function (k) { return '<button type="button" data-act="ekind" data-k="' + k[0] + '" aria-pressed="' + (r.kind === k[0]) + '">' + k[1] + '</button>'; }).join('') + '</div>' +
      '<label class="field"><span id="eDoneL">' + esc(C.DONE_BY_WORD[r.kind]) + '</span><input class="input" type="time" id="eDone" value="' + esc(r.doneBy) + '"></label>' +
      '<fieldset class="days"><legend>Days</legend>' + C.WEEK.map(function (d) { return '<button type="button" data-act="eday" data-d="' + d + '" aria-pressed="' + (r.days.indexOf(d) >= 0) + '" aria-label="' + C.DAY_LONG[d] + '">' + C.DAY_SHORT[d].charAt(0) + '</button>'; }).join('') + '</fieldset>' +
      '<div class="startby' + (r.kind === 'bedtime' ? ' night' : '') + '" id="eStart" aria-live="polite">' + startByHtml(r, t) + '</div>' +
      '</div>' + editActions(e) + '</div><div class="card"><div class="row spread"><h2 style="margin:0">Steps</h2><span class="small muted">Drag ⋮⋮ or use the arrows to reorder</span></div>' +
      '<ol class="step-list" id="steps">' + stepsHtml(r) + '</ol>' +
      '<div class="row" style="margin-top:10px"><button class="btn ghost" type="button" data-act="addstep"' + (r.steps.length >= C.LIMITS.steps ? ' disabled' : '') + '>＋ Add a step</button></div>' +
      '</div></div>';
  }
  function editActions(e) {
    return '<div class="edit-actions dk-composer"><button class="btn" type="button" data-act="saveedit">' + (e.isNew ? 'Add this routine' : 'Save') + '</button><button class="btn ghost" type="button" data-act="canceledit">Cancel</button>' +
      (e.isNew ? '' : '<button class="btn ghost" type="button" data-act="delroutine">Delete</button>') + '</div>';
  }
  function startByHtml(r, t) { return '<b>Start by ' + esc(fmt(t.start)) + '</b><span>' + plural(C.totalMinutes(r), 'minute') + ' of steps · ' + esc(C.DONE_BY_SHORT[r.kind]) + ' ' + esc(fmt(t.doneBy)) + '</span>'; }
  function stepsHtml(r) {
    return r.steps.map(function (s, i) {
      return '<li class="step" data-sid="' + s.id + '"><button class="handle" type="button" aria-label="Drag to reorder ' + esc(s.name) + '">⋮⋮</button>' +
        '<button class="emoji-btn emo" type="button" data-act="pickemoji" data-i="' + i + '" aria-label="Picture: ' + esc(C.emojiLabel(s.emoji) || 'star') + '. Change it">' + s.emoji + '</button>' +
        '<input class="input sname" data-i="' + i + '" maxlength="40" value="' + esc(s.name) + '" aria-label="Step ' + (i + 1) + ' name">' +
        '<div class="tools"><div class="stepper"><button type="button" data-act="minus" data-i="' + i + '" aria-label="One minute less for ' + esc(s.name) + '"' + (s.minutes <= 1 ? ' disabled' : '') + '>−</button><output aria-live="polite">' + s.minutes + ' min</output><button type="button" data-act="plus" data-i="' + i + '" aria-label="One minute more for ' + esc(s.name) + '"' + (s.minutes >= 30 ? ' disabled' : '') + '>+</button></div>' +
        '<button class="tb" type="button" data-act="up" data-i="' + i + '" aria-label="Move ' + esc(s.name) + ' up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button class="tb" type="button" data-act="down" data-i="' + i + '" aria-label="Move ' + esc(s.name) + ' down"' + (i === r.steps.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button class="tb ai wide-tool" type="button" data-act="game" data-i="' + i + '" aria-label="Make ' + esc(s.name) + ' a game">✨</button>' +
        '<button class="tb wide-tool" type="button" data-act="rmstep" data-i="' + i + '" aria-label="Remove ' + esc(s.name) + '"' + (r.steps.length <= 1 ? ' disabled' : '') + '>✕</button>' +
        '<button class="tb narrow-tool" type="button" data-act="stepmenu" data-i="' + i + '" aria-label="More for ' + esc(s.name) + '">⋯</button></div>' +
        (s.game ? '<p class="game">🎲 ' + esc(s.game) + ' <button class="link-btn" type="button" data-act="rmgame" data-i="' + i + '">remove</button></p>' : '') + '</li>';
    }).join('');
  }
  function redrawSteps(focusSel) {
    var r = state.edit.r;
    $('#steps').innerHTML = stepsHtml(r);
    $('#eStart').innerHTML = startByHtml(r, C.timesFor(r, 0));
    var add = $('[data-act="addstep"]'); if (add) add.disabled = r.steps.length >= C.LIMITS.steps;
    if (focusSel) { var f = $(focusSel); if (f) try { f.focus({ preventScroll: true }); } catch (x) { /* ignore */ } }
  }
  function saveEdit() {
    var e = state.edit, c = childById(e.childId);
    var r = C.cleanRoutine(Object.assign({}, e.r, { steps: e.r.steps.filter(function (s) { return C.line(s.name, 40); }) }));
    if (!r) { toast('Give at least one step a name.'); return; }
    if (!r.since) r.since = today();
    var i = c.routines.map(function (x) { return x.id; }).indexOf(r.id);
    if (i >= 0) c.routines[i] = r; else c.routines.push(r);
    state.edit = null;
    saveFamily();
    go('routines');
    toast(e.isNew ? 'Added ' + r.name + '.' : 'Saved.');
  }

  /* ---------------- stickers ---------------- */

  function stickersHtml() {
    var c = activeChild();
    if (!c) return '';
    var book = C.stickerBook(c, state.progress), st = C.streaks(c, state.progress, today());
    var nm = nameOf(c);
    var words = st.current ? 'Nice and steady. Stickers are for showing a grown-up - not for racing anyone.'
      : st.total ? 'A fresh start - every finished routine counts, and a missed one is just yesterday.' : 'Every finished routine adds a sticker here. Tap ▶ Kid mode on the Today tab to earn the first one.';
    return '<div class="sec-head"><h1>Stickers</h1></div>' + kidTabs(c, 'pickchild') +
      '<section class="card"><div class="child-head" style="--c:' + colorOf(c) + '"><span class="avatar emo" aria-hidden="true">' + c.avatar + '</span><h2>' + esc(nm) + '’s sticker book</h2></div>' +
      '<div class="streak"><div><b>' + st.current + '</b><span>in a row now</span></div><div><b>' + st.best + '</b><span>best run</span></div><div><b>' + st.total + '</b><span>' + (st.total === 1 ? 'sticker' : 'stickers') + '</span></div></div>' +
      '<p class="muted small" style="margin-top:10px">' + esc(words) + ' A run counts each routine on the days it’s on.</p>' +
      (book.length ? '<ul class="book">' + book.slice(0, 200).map(function (b) {
        return '<li><span class="emo" role="img" aria-label="' + esc(b.routineName) + ', ' + esc(C.niceDay(b.day)) + '">' + b.sticker + '</span><span>' + esc(C.shortDay(b.day)) + '</span></li>';
      }).join('') + '</ul>' : '') + '</section>';
  }

  /* ---------------- wiring inputs (no redraw while typing) ---------------- */

  function wire() {
    var n = $('#eName');
    if (n) n.addEventListener('input', function () { state.edit.r.name = n.value; });
    var d = $('#eDone');
    if (d) d.addEventListener('input', function () { if (C.toMin(d.value) !== null) { state.edit.r.doneBy = d.value; $('#eStart').innerHTML = startByHtml(state.edit.r, C.timesFor(state.edit.r, 0)); } });
    $$('.sname').forEach(function (inp) {
      inp.addEventListener('input', function () { var i = Number(inp.getAttribute('data-i')); state.edit.r.steps[i].name = inp.value; });
      // A new step's picture follows its name until one is picked by hand.
      inp.addEventListener('change', function () {
        var i = Number(inp.getAttribute('data-i')), st = state.edit.r.steps[i];
        if (!st || !st.name || st.emojiChosen || st.emoji !== '⭐') return;
        st.emoji = C.emojiFor(st.name);
        var b = $('[data-act="pickemoji"][data-i="' + i + '"]');
        if (b) { b.textContent = st.emoji; b.setAttribute('aria-label', 'Picture: ' + (C.emojiLabel(st.emoji) || 'star') + '. Change it'); }
      });
    });
    var sn = $('#suName');
    if (sn) sn.addEventListener('input', function () { state.setup.name = C.line(sn.value, C.LIMITS.childName); });
    var sl = $('#suLights');
    if (sl) sl.addEventListener('input', function () { if (C.toMin(sl.value) !== null) { state.setup.lights = sl.value; state.setup.lightsSet = true; } });
    var so = $('#suOut');
    if (so) so.addEventListener('input', function () { if (C.toMin(so.value) !== null) state.setup.out = so.value; });
  }

  /* ---------------- drag to reorder ---------------- */

  var drag = null;
  document.addEventListener('pointerdown', function (e) {
    var h = e.target.closest && e.target.closest('.step .handle');
    if (!h || !state.edit) return;
    var row = h.closest('.step');
    drag = { row: row, list: row.parentNode, id: e.pointerId, from: $$('.step', row.parentNode).indexOf(row) };
    row.classList.add('dragging');
    try { h.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    e.preventDefault();
  });
  document.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var y = e.clientY, prev = drag.row.previousElementSibling, next = drag.row.nextElementSibling;
    if (prev && y < prev.getBoundingClientRect().top + prev.offsetHeight / 2) drag.list.insertBefore(drag.row, prev);
    else if (next && y > next.getBoundingClientRect().top + next.offsetHeight / 2) drag.list.insertBefore(next, drag.row);
  });
  function dragEnd(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    var order = $$('.step', drag.list).map(function (li) { return li.getAttribute('data-sid'); });
    var to = order.indexOf(drag.row.getAttribute('data-sid'));
    drag.row.classList.remove('dragging');
    var by = {};
    state.edit.r.steps.forEach(function (s) { by[s.id] = s; });
    state.edit.r.steps = order.map(function (id) { return by[id]; }).filter(Boolean);
    var moved = to !== drag.from;
    drag = null;
    redrawSteps();
    if (moved) say('Moved to step ' + (to + 1) + '.');
  }
  document.addEventListener('pointerup', dragEnd);
  // The drag handle answers the arrow keys too.
  document.addEventListener('keydown', function (e) {
    var h = e.target.closest && e.target.closest('.step .handle');
    if (!h || !state.edit || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    var steps = state.edit.r.steps, id = h.closest('.step').getAttribute('data-sid');
    var i = steps.map(function (x) { return x.id; }).indexOf(id), j = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (j < 0 || j >= steps.length) return;
    steps.splice(j, 0, steps.splice(i, 1)[0]);
    redrawSteps('.step[data-sid="' + id + '"] .handle');
    say('Moved to step ' + (j + 1) + '.');
  });
  document.addEventListener('pointercancel', dragEnd);

  /* ---------------- kid mode ---------------- */

  var kidTick = null, wake = null, actx = null, hold = null, swallowUntil = 0;
  function openKid(o) {
    state.kid = { mode: o.mode, childId: o.childId || null, routineId: o.routineId || null, demo: Boolean(o.demo), demoDone: {}, stepAt: {}, gate: null, hint: false, sticker: null, last: null };
    if (o.demo) { state.kid.demoRoutine = C.demoRoutine(); state.kid.routineId = 'demo'; }
    closeSheet(true);
    document.body.classList.add('kid-on');
    $('#kid').hidden = false;
    history.pushState(null, '', location.href);
    drawKid();
    clearInterval(kidTick);
    kidTick = setInterval(tickKid, 1000);
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (w) { wake = w; }, function () { /* fine */ }); } catch (e) { /* fine */ }
    setTimeout(function () { var b = $('#kid .k-done') || $('#kid .k-pick button:not([disabled])'); if (b) try { b.focus({ preventScroll: true }); } catch (x) { /* ignore */ } }, 60);
  }
  function closeKid() {
    var wasDemo = state.kid && state.kid.demo;
    clearInterval(kidTick); kidTick = null;
    try { if (wake) wake.release(); } catch (e) { /* fine */ }
    wake = null;
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) { /* fine */ }
    state.kid = null;
    $('#kid').hidden = true; $('#kid').innerHTML = '';
    document.body.classList.remove('kid-on');
    if (state.conflict) openConflict();
    if (wasDemo && !state.family) { state.view = 'start'; draw(); return; }
    draw();
  }
  function kidRoutine(k) {
    if (k.demo) return k.demoRoutine;
    return routineOf(childById(k.childId), k.routineId);
  }
  function kidDone(k, childId, r) {
    if (k.demo) { var s = new Set(); Object.keys(k.demoDone).forEach(function (id) { if (k.demoDone[id]) s.add(id); }); return s; }
    return C.doneIds(state.progress, today(), childId, r.id);
  }
  function dots(r, done, cur) {
    return '<div class="k-dots" role="img" aria-label="' + done.size + ' of ' + r.steps.length + ' done">' + r.steps.map(function (s) { return '<i class="' + (done.has(s.id) ? 'on' : (cur && s.id === cur.id ? 'now' : '')) + '"></i>'; }).join('') + '</div>';
  }
  var EXIT = '<button class="k-exit" type="button" id="kExit" aria-label="Leave kid mode. Grown-ups: press and hold for 2 seconds."><svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22"/></svg><span aria-hidden="true">✕</span></button>';
  function hintHtml(k) {
    if (k.gate) {
      return '<div class="k-gate" role="dialog" aria-modal="true" aria-labelledby="gateH"><div><h2 id="gateH" class="k-h" style="font-size:1.5rem;margin:0">Grown-ups only</h2><p style="font-size:1.3rem;font-weight:800;margin:10px 0 0">What is ' + k.gate.a + ' + ' + k.gate.b + '?</p>' +
        (k.gate.wrong ? '<p role="alert" style="margin:6px 0 0;font-weight:700">Not quite - try again.</p>' : '') +
        '<div class="opts">' + k.gate.opts.map(function (n) { return '<button type="button" data-act="k-gateans" data-n="' + n + '">' + n + '</button>'; }).join('') + '</div>' +
        '<button class="cancel" type="button" data-act="k-gateno">Back to the routine</button></div></div>';
    }
    if (k.hint) return '<div class="k-hint" role="status"><p>Grown-ups: press and hold ✕ for 2 seconds to leave.</p><button type="button" data-act="k-gate">Or answer a grown-up question</button></div>';
    return '';
  }
  function drawKid() {
    var k = state.kid;
    if (!k) return;
    var el = $('#kid');
    var html = '';
    var night = false;
    if (k.mode === 'pick') {
      var td = today(), nm = nowMin();
      night = nm >= 15 * 60 || nm < 5 * 60;
      html = '<div class="k-top"><span></span>' + EXIT + hintHtml(k) + '</div><div class="k-main"><h2 class="k-h">Whose turn?</h2><div class="k-pick">' + children().map(function (c) {
        var r = C.currentRoutine(c, td, nm, state.progress, plan());
        var line = r ? r.emoji + ' ' + r.name + ' · ' + C.doneIds(state.progress, td, c.id, r.id).size + ' of ' + r.steps.length : 'All done today 🎉'; // plain text, escaped whole
        return '<button type="button" data-act="k-who" data-c="' + c.id + '" style="--c:' + colorOf(c) + '"' + (r ? '' : ' disabled') + '><span class="emo" aria-hidden="true">' + c.avatar + '</span><b>' + esc(nameOf(c)) + '</b><span>' + esc(line) + '</span></button>';
      }).join('') + '</div></div>';
    } else if (k.mode === 'side') {
      var td2 = today(), nm2 = nowMin();
      var cols = children();
      night = nm2 >= 15 * 60 || nm2 < 5 * 60;
      html = '<div class="k-top"><span class="k-clock" id="kClock">' + esc(fmt(nm2)) + '</span>' + EXIT + hintHtml(k) + '</div><div class="k-side" style="--n:' + cols.length + '">' + cols.map(function (c) {
        var fin = C.todays(c, td2).filter(function (x) { return C.isFinished(state.progress, td2, c.id, x.id); });
        var r = C.currentRoutine(c, td2, nm2, state.progress, plan());
        var head = '<span class="k-who"><span class="emo" aria-hidden="true">' + c.avatar + '</span><span>' + esc(nameOf(c)) + '</span></span>';
        if (!r) {
          var last = fin[fin.length - 1];
          return '<section class="k-col" style="--c:' + colorOf(c) + '" aria-label="' + esc(nameOf(c)) + '">' + head + '<div class="k-col-main">' + (last ? '<span class="k-sticker emo" role="img" aria-label="Sticker">' + C.stickerFor(c.id, td2, last.id) + '</span><p class="k-name">All done!</p>' : '<p class="k-name">Nothing now</p>') + '</div></section>';
        }
        var done = C.doneIds(state.progress, td2, c.id, r.id), s = C.nextStep(r, done);
        return '<section class="k-col" style="--c:' + colorOf(c) + '" aria-label="' + esc(nameOf(c)) + '">' + head + '<p class="k-time">' + esc(r.name) + '</p>' + dots(r, done, s) +
          '<div class="k-col-main"><span class="k-emoji emo" role="img" aria-label="' + esc(C.emojiLabel(s.emoji)) + '" data-pop="' + c.id + '">' + s.emoji + '</span><p class="k-name">' + esc(s.name) + '</p>' +
          '<button class="k-done" type="button" data-act="k-done" data-c="' + c.id + '" data-r="' + r.id + '" data-s="' + s.id + '">Done!</button></div></section>';
      }).join('') + '</div>';
    } else if (k.mode === 'done') {
      var r2 = kidRoutine(k);
      var c2 = childById(k.childId);
      night = r2 && r2.kind === 'bedtime';
      var total = !k.demo && c2 ? C.stickerBook(c2, state.progress).length : 0;
      var more = !k.demo && children().some(function (x) { return C.currentRoutine(x, today(), nowMin(), state.progress, plan()); });
      html = '<div class="k-top"><span></span>' + EXIT + hintHtml(k) + '</div><div class="k-main k-finish">' + confetti() +
        '<span class="k-sticker emo" role="img" aria-label="A sticker">' + (k.sticker || '🌟') + '</span>' +
        '<h2>Tada! You did it!</h2><p>' + (k.demo ? 'That’s how it feels. Every routine ends with a sticker.' : 'You earned a sticker. Show a grown-up!') + '</p>' +
        (total ? '<p class="small" style="font-size:1rem">' + plural(total, 'sticker') + ' in the book</p>' : '') +
        (k.demo ? '<button class="k-done" type="button" data-act="k-setup">Set up our own</button><div class="k-sub"><button type="button" data-act="k-leavedemo">Back to the start</button></div>'
          : '<button class="k-done" type="button" data-act="' + (more && children().length > 1 ? 'k-pickmode' : 'k-again') + '">' + (more && children().length > 1 ? 'Whose turn next?' : 'All done!') + '</button>') + '</div>';
    } else {
      var c3 = k.demo ? null : childById(k.childId);
      var r3 = kidRoutine(k);
      if (!r3 || (!k.demo && !c3)) { k.mode = 'pick'; return drawKid(); }
      var done3 = kidDone(k, c3 && c3.id, r3);
      var s3 = C.nextStep(r3, done3);
      if (!s3) { k.mode = 'done'; k.sticker = k.demo ? '🦄' : C.stickerFor(c3.id, today(), r3.id); return drawKid(); }
      night = r3.kind === 'bedtime';
      if (!k.stepAt[s3.id]) k.stepAt[s3.id] = Date.now();
      var who = c3 ? '<button class="k-who" type="button" data-act="k-pickmode"' + (children().length > 1 ? '' : ' disabled') + ' aria-label="' + esc(nameOf(c3)) + (children().length > 1 ? ' - change whose turn' : '') + '"><span class="emo" aria-hidden="true">' + c3.avatar + '</span><span>' + esc(nameOf(c3)) + '</span></button>' : '<span class="k-who"><span class="emo" aria-hidden="true">⭐</span><span>Try it</span></span>';
      html = '<div class="k-top">' + who + dots(r3, done3, s3) + EXIT + hintHtml(k) + '</div>' +
        '<div class="k-main"><div class="k-ring" id="kRing"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="track" cx="60" cy="60" r="54"/><circle class="prog" id="kProg" cx="60" cy="60" r="54" stroke-dasharray="339.29" stroke-dashoffset="339.29"/></svg>' +
        '<span class="k-emoji emo" id="kEmoji" role="img" aria-label="' + esc(C.emojiLabel(s3.emoji)) + '">' + s3.emoji + '</span></div>' +
        '<h2 class="k-name" id="kName">' + esc(s3.name) + '</h2><p class="k-time" id="kTime"></p>' +
        (s3.game ? '<p class="k-game">🎲 ' + esc(s3.game) + '</p>' : '') +
        '<button class="k-done" type="button" data-act="k-done" data-c="' + (c3 ? c3.id : '') + '" data-r="' + r3.id + '" data-s="' + s3.id + '">Done!</button>' +
        '<div class="k-sub">' + (done3.size ? '<button type="button" data-act="k-undo">◀ Back a step</button>' : '') + (prefs.readAloud && window.speechSynthesis ? '<button type="button" data-act="k-say">🔊 Say it</button>' : '') + '</div></div>';
      if (k.last !== s3.id) { k.last = s3.id; speak(C.sayFor(s3)); say(s3.name); }
    }
    el.className = 'kid' + (night ? ' night' : '');
    el.innerHTML = html;
    tickKid();
  }
  function confetti() {
    if (RM.matches) return '';
    var cols = ['#f59e0b', '#ec4899', '#22c55e', '#3b82f6', '#a855f7', '#ef4444'];
    var out = '<div class="confetti" aria-hidden="true">';
    for (var i = 0; i < 36; i++) out += '<i style="left:' + ((i * 29) % 100) + '%;background:' + cols[i % cols.length] + ';animation-delay:' + ((i % 9) * 0.12).toFixed(2) + 's"></i>';
    return out + '</div>';
  }
  function tickKid() {
    var k = state.kid;
    var clock = $('#kClock'); if (clock) clock.textContent = fmt(nowMin());
    if (!k || k.mode !== 'step') return;
    var r = kidRoutine(k), c = k.demo ? null : childById(k.childId);
    if (!r) return;
    var s = C.nextStep(r, kidDone(k, c && c.id, r));
    if (!s) return;
    var spent = (Date.now() - (k.stepAt[s.id] || Date.now())) / 1000;
    var total = s.minutes * 60;
    var left = total - spent;
    var prog = $('#kProg'), ring = $('#kRing'), t = $('#kTime');
    if (!prog || !t) return;
    prog.setAttribute('stroke-dashoffset', String(339.29 * Math.max(0, 1 - spent / total)));
    prog.style.opacity = spent / total < 0.015 ? '0' : '1';
    if (left <= 0) { ring.classList.add('over'); t.textContent = 'Take your time'; }
    else { ring.classList.remove('over'); t.textContent = left > 90 ? 'About ' + Math.ceil(left / 60) + ' minutes' : left > 50 ? 'About a minute' : 'Almost there'; }
  }
  function chime(big) {
    if (!prefs.sound) return;
    try {
      var A = window.AudioContext || window.webkitAudioContext;
      if (!A) return;
      actx = actx || new A();
      if (actx.state === 'suspended') actx.resume();
      var notes = big ? [523.25, 659.25, 783.99, 1046.5] : [659.25, 987.77];
      notes.forEach(function (f, i) {
        var o = actx.createOscillator(), g = actx.createGain(), t0 = actx.currentTime + i * 0.13;
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.11, t0 + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.7);
        o.connect(g); g.connect(actx.destination); o.start(t0); o.stop(t0 + 0.75);
      });
    } catch (e) { /* no sound is fine */ }
  }
  function speak(text) {
    if (!prefs.readAloud || !text || !window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
    try { speechSynthesis.cancel(); var u = new SpeechSynthesisUtterance(text); u.rate = 0.92; u.pitch = 1.1; speechSynthesis.speak(u); } catch (e) { /* fine */ }
  }
  var CHEERS = ['Great job!', 'Nice one!', 'You did it!', 'Super!', 'Brilliant!', 'Way to go!'];
  function kidStepDone(btn) {
    var k = state.kid;
    var cId = btn.getAttribute('data-c'), rId = btn.getAttribute('data-r'), sId = btn.getAttribute('data-s');
    btn.disabled = true;
    var finished = false;
    if (k.demo) {
      k.demoDone[sId] = true;
      finished = !C.nextStep(k.demoRoutine, kidDone(k, null, k.demoRoutine));
    } else {
      finished = tap(cId, rId, sId, true);
    }
    chime(finished);
    var em = k.mode === 'side' ? $('[data-pop="' + cId + '"]') : $('#kEmoji');
    if (em) em.classList.add('pop');
    if (!RM.matches && k.mode === 'step') {
      var cheer = document.createElement('div');
      cheer.className = 'cheer'; cheer.setAttribute('aria-hidden', 'true'); cheer.textContent = CHEERS[Math.floor(Math.random() * CHEERS.length)];
      var main = $('#kid .k-main'); if (main) main.appendChild(cheer);
    }
    setTimeout(function () {
      if (!state.kid) return;
      if (finished && k.mode !== 'side') { k.mode = 'done'; k.sticker = k.demo ? '🦄' : C.stickerFor(cId, today(), rId); speak('Tada! You did it!'); say('Tada! You did it! You earned a sticker.'); }
      drawKid();
      var d = $('#kid .k-done'); if (d) try { d.focus({ preventScroll: true }); } catch (x) { /* ignore */ }
    }, RM.matches ? 250 : 750);
  }
  function kidUndo() {
    var k = state.kid, r = kidRoutine(k), c = k.demo ? null : childById(k.childId);
    var done = kidDone(k, c && c.id, r);
    var last = null;
    r.steps.forEach(function (s) { if (done.has(s.id)) last = s; });
    if (!last) return;
    if (k.demo) k.demoDone[last.id] = false;
    else tap(c.id, r.id, last.id, false);
    k.stepAt[last.id] = Date.now();
    k.last = null;
    drawKid();
  }
  function newGate() {
    var a = 2 + Math.floor(Math.random() * 7), b = 2 + Math.floor(Math.random() * 7), sum = a + b;
    var opts = [sum];
    while (opts.length < 4) { var x = sum + Math.floor(Math.random() * 7) - 3; if (x > 1 && opts.indexOf(x) < 0) opts.push(x); }
    opts.sort(function () { return Math.random() - 0.5; });
    return { a: a, b: b, sum: sum, opts: opts, wrong: false };
  }
  // Press and hold the corner ✕ for two seconds: a small child taps, a
  // grown-up holds. Enter or Space held down works the same way, and a
  // plain tap (which is what a screen reader sends) offers a grown-up
  // question instead.
  function holdStart() {
    if (hold || !state.kid) return;
    var b = $('#kExit'); if (!b) return;
    b.classList.add('holding');
    // The finger that held is still down: its click must not land on
    // whatever is under it once kid mode is gone.
    hold = setTimeout(function () { hold = null; swallowUntil = Date.now() + 600; closeKid(); }, 2000);
  }
  function holdEnd() {
    if (!hold) return;
    clearTimeout(hold); hold = null;
    var b = $('#kExit'); if (b) b.classList.remove('holding');
  }
  var kidEl = $('#kid');
  kidEl.addEventListener('pointerdown', function (e) { if (e.target.closest('#kExit')) { e.preventDefault(); holdStart(); } });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { kidEl.addEventListener(ev, function (e) { if (e.type !== 'pointerleave' || e.target.closest('#kExit')) holdEnd(); }); });
  kidEl.addEventListener('contextmenu', function (e) { if (e.target.closest('#kExit')) e.preventDefault(); });
  kidEl.addEventListener('keydown', function (e) {
    if (e.target.closest && e.target.closest('#kExit') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (!e.repeat) holdStart(); }
  });
  kidEl.addEventListener('keyup', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var short = Boolean(hold);
    holdEnd();
    if (short && state.kid && e.target.closest && e.target.closest('#kExit')) { state.kid.hint = !state.kid.hint; drawKid(); var x = $('#kExit'); if (x) x.focus(); }
  });
  document.addEventListener('click', function (e) { if (Date.now() < swallowUntil) { e.preventDefault(); e.stopPropagation(); } }, true);

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    $$('.toast').forEach(function (x) { x.remove(); });
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false; document.body.classList.add('sheet-open'); s.scrollTop = 0;
    // The shared "confirm your email" banner sits above everything at the top
    // of the page; keep the sheet (and its Close button) clear of it.
    var vb = document.getElementById('stc-verify-banner'), off = vb ? Math.max(0, vb.getBoundingClientRect().bottom) : 0;
    s.style.maxHeight = off ? 'calc(100vh - ' + Math.round((matchMedia('(min-width: 900px)').matches ? 2 : 1) * (off + 8)) + 'px)' : '';
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2'); if (f) f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function scrollIntoSheet(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'start', behavior: RM.matches ? 'auto' : 'smooth' }); } catch (e) { /* fine */ }
    var h = el.querySelector('h3, p, li'); if (h) { h.setAttribute('tabindex', '-1'); try { h.focus({ preventScroll: true }); } catch (e) { /* fine */ } }
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    planDraft = null; aiState = null;
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  function openSettings() {
    sheet('<h2>Settings</h2><p class="small muted">On this device.</p>' +
      '<button class="switch" type="button" role="switch" data-act="pref" data-k="sound" aria-checked="' + prefs.sound + '"><span><b>Sounds</b><span class="small muted">A soft chime for each Done! - never a buzzer.</span></span><span class="knob" aria-hidden="true"></span></button>' +
      '<button class="switch" type="button" role="switch" data-act="pref" data-k="readAloud" aria-checked="' + prefs.readAloud + '"><span><b>Read each step aloud</b><span class="small muted">' + (window.speechSynthesis ? '“Time to brush your teeth!” - for children who don’t read yet.' : 'This browser can’t read aloud.') + '</span></span><span class="knob" aria-hidden="true"></span></button>' +
      (window.speechSynthesis ? '<p style="margin-top:10px"><button class="btn small ghost" type="button" data-act="testvoice">🔊 Hear it</button></p>' : '') +
      '<h3 style="margin-top:18px">Kid mode</h3><p class="small muted">Kid mode fills the screen with one step at a time. To leave it, a grown-up presses and holds the ✕ in the corner for 2 seconds (or answers a sum). On a tablet, turn on Guided Access (iPad) or screen pinning (Android) too, so little hands stay in Tada.</p>' +
      '<h3 style="margin-top:18px">Your account</h3><p class="small"' + (signedIn() ? ' data-sync>' + (state.family ? syncLine() : '') : '>Everything is saved on this device only.') + '</p>' +
      (signedIn() ? '<button class="btn ghost block" type="button" data-act="account">Account and AI credit</button>' : '<button class="btn ghost block" type="button" data-act="signin-sync">Sign in to sync (free)</button>') +
      (state.family ? '<button class="btn ghost block" type="button" data-act="wipe" style="margin-top:18px">Clear everything on this device</button>' : ''));
  }

  var FREE_LINE = 'Routines, kid mode, stickers, the clocks plan, printing and the calendar are free with no account. A free account shares your family between your phone and the family tablet, and adds the AI helpers - it comes with $2 of AI credit, and one account works across every app on this site.';
  function openAccount(reason, then) {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button" style="margin-top:10px">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center" style="margin-top:12px">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>' +
        '<p class="small muted">Children’s names travel to your account only so your own devices can show them. They are never sent to an AI.</p>';
      $('#swap', root).addEventListener('click', function () { mode = mode === 'register' ? 'login' : 'register'; draw2(root); });
      $('#authForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); return syncIn(); }).then(function () { if (then) then(); else if (!state.kid) draw(); })
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">A routine from a sentence or three game ideas cost a cent or two. Everything else in Tada is free and needs no account.</p><div id="billing"></div></div>' +
      '<p class="small" data-sync style="margin-top:14px">' + syncLine() + '</p>' +
      (state.family ? '<button class="btn ghost block" id="forget" type="button" style="margin-top:6px">Remove the family from my account</button>' : '') +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; state.syncState = 'local'; drawTop(); draw(); }); });
        var fg = $('#forget', root);
        if (fg) fg.addEventListener('click', function () {
          if (!confirm('Remove the family from your account? This device keeps its copy; other devices stop syncing.')) return;
          api('DELETE', 'api/family').then(function () { sync.base = null; sync.queue = []; keep(K_SYNC, sync); closeSheet(); toast('Removed from the account. This device still has it.'); state.syncState = 'local'; draw(); }).catch(function (e) { showError(e); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Routines, kid mode and everything else keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }
  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }

  /* ---- a child: add or edit ---- */

  function openChild(id) {
    var c = id ? clone(childById(id)) : { id: uid(), name: '', avatar: C.AVATARS[(children().length + 1) % C.AVATARS.length], color: C.COLORS[children().length % C.COLORS.length].id, band: 'middle', routines: [] };
    var adding = !id;
    var start = { kind: 'bedtime', lights: null, out: '08:00' };
    function body(root) {
      if (start.lights === null) start.lights = C.template('bedtime').doneBy[c.band];
      $('.body', root).innerHTML = '<h2>' + (adding ? 'Add a child' : 'Edit ' + esc(nameOf(childById(id)))) + '</h2>' +
        '<label class="field"><span>First name or nickname <span class="hint">- optional</span></span><input class="input" id="cName" maxlength="24" autocomplete="off" value="' + esc(c.name) + '"></label>' +
        '<p class="field" style="margin-bottom:4px"><span>Age</span></p><div class="seg" role="group" aria-label="Age">' + C.BANDS.map(function (b) { return '<button type="button" data-act="c-band" data-b="' + b.id + '" aria-pressed="' + (c.band === b.id) + '">' + b.label + '</button>'; }).join('') + '</div>' +
        '<p class="field" style="margin-bottom:4px"><span>Animal</span></p><div class="avatars" role="group" aria-label="Animal">' + C.AVATARS.map(function (a, i) { return '<button type="button" class="emo" data-act="c-avatar" data-a="' + a + '" aria-pressed="' + (c.avatar === a) + '" aria-label="' + C.AVATAR_NAMES[i] + '">' + a + '</button>'; }).join('') + '</div>' +
        '<p class="field" style="margin-bottom:4px"><span>Colour</span></p><div class="colors" role="group" aria-label="Colour">' + C.COLORS.map(function (x) { return '<button type="button" data-act="c-color" data-k="' + x.id + '" aria-pressed="' + (c.color === x.id) + '" style="background:' + x.hex + '">' + esc(x.label) + '</button>'; }).join('') + '</div>' +
        (adding ? '<p class="field" style="margin-bottom:4px"><span>Start with</span></p><div class="seg" role="group" aria-label="Start with">' + [['morning', '🌞 Morning'], ['bedtime', '🌙 Bedtime'], ['both', 'Both']].map(function (k) { return '<button type="button" data-act="c-kind" data-k="' + k[0] + '" aria-pressed="' + (start.kind === k[0]) + '">' + k[1] + '</button>'; }).join('') + '</div>' +
          (start.kind !== 'bedtime' ? '<label class="field"><span>🌞 Out the door by</span><input class="input" type="time" id="cOut" value="' + esc(start.out) + '"></label>' : '') +
          (start.kind !== 'morning' ? '<label class="field"><span>🌙 Lights out by</span><input class="input" type="time" id="cLights" value="' + esc(start.lights) + '"></label>' : '') : '') +
        '<div id="cErr"></div><div class="row" style="margin-top:14px"><button class="btn" type="button" data-act="c-save">' + (adding ? 'Add' : 'Save') + '</button>' + (adding ? '' : '<button class="btn ghost" type="button" data-act="c-remove">Remove this child</button>') + '</div>';
      var n = $('#cName', root); n.addEventListener('input', function () { c.name = n.value; });
      var o = $('#cOut', root); if (o) o.addEventListener('input', function () { if (C.toMin(o.value) !== null) start.out = o.value; });
      var l = $('#cLights', root); if (l) l.addEventListener('input', function () { if (C.toMin(l.value) !== null) start.lights = l.value; });
    }
    childDraft = { c: c, adding: adding, start: start, redraw: body };
    sheet('<div class="body"></div>', body);
  }
  var childDraft = null;
  function saveChild() {
    var d = childDraft, c = d.c;
    c.name = C.line(c.name, C.LIMITS.childName);
    if (d.adding) {
      var s = { morning: d.start.kind !== 'bedtime', bedtime: d.start.kind !== 'morning', band: c.band, out: d.start.out, lights: d.start.lights, lightsSet: true };
      c.routines = setupRoutines(s, uid);
      state.family.children.push(c);
    } else {
      var i = children().map(function (x) { return x.id; }).indexOf(c.id);
      var cur = state.family.children[i];
      state.family.children[i] = Object.assign({}, cur, { name: c.name, avatar: c.avatar, color: c.color, band: c.band });
    }
    state.family = C.cleanFamily(state.family);
    setActive(c.id);
    saveFamily();
    childDraft = null;
    closeSheet(true);
    draw();
    toast(d.adding ? 'Added ' + nameOf(childById(c.id)) + '.' : 'Saved.');
  }

  /* ---- new routine: a template, blank, or from a sentence ---- */

  function openNewRoutine(childId) {
    var c = childById(childId);
    sheet('<h2>New routine for ' + esc(nameOf(c)) + '</h2><p class="muted">Start from a ready-made one for ages ' + esc(bandLabel(c.band).replace('Ages ', '')) + ', then change anything.</p><div class="tpl-list">' +
      C.TEMPLATES.map(function (t) {
        var steps = t.steps[c.band], mins = steps.reduce(function (n, s) { return n + s[2]; }, 0);
        return '<button class="choice" type="button" data-act="tpl" data-t="' + t.id + '" data-c="' + c.id + '"><span class="emo" aria-hidden="true">' + t.emoji + '</span><b>' + esc(t.name) + '</b><span>' + esc(t.blurb) + ' ' + steps.length + ' steps, ' + mins + ' min · ' + esc(C.fmtDays(t.days)) + '</span></button>';
      }).join('') +
      '<button class="choice" type="button" data-act="tpl" data-t="" data-c="' + c.id + '"><span class="emo" aria-hidden="true">📝</span><b>Blank</b><span>Write every step yourself.</span></button>' +
      '<button class="choice" type="button" data-act="aibuild" data-c="' + c.id + '"><span class="emo" aria-hidden="true">✨</span><b>Build from a sentence</b><span>“6, school bus at 8:10, slow eater, needs reminders for shoes and bag” - a cent or two of AI credit.</span></button></div>');
  }
  function newFromTemplate(childId, tid) {
    var c = childById(childId);
    var r = tid ? C.fromTemplate(tid, c.band, uid, { today: today() }) : { id: uid(), kind: 'other', name: 'New routine', emoji: '⭐', doneBy: '17:00', days: [1, 2, 3, 4, 5], steps: [{ id: uid(), emoji: '⭐', name: '', minutes: 5 }], template: null, since: today() };
    state.edit = { childId: c.id, r: r, isNew: true };
    closeSheet(true);
    go('edit/' + c.id + '/' + r.id);
  }

  /* ---- the emoji picker ---- */

  function openEmoji(i) {
    var s = state.edit.r.steps[i];
    sheet('<h2>Pick a picture</h2><p class="muted">For “' + esc(s.name || 'this step') + '”.</p><div class="emoji-grid">' + C.EMOJI.map(function (x) {
      return '<button type="button" class="emo" data-act="setemoji" data-i="' + i + '" data-e="' + esc(x.e) + '" aria-label="' + esc(x.label) + '" aria-pressed="' + (x.e === s.emoji) + '">' + x.e + '</button>';
    }).join('') + '</div>');
  }

  /* ---- the AI helpers (signed in, metered) ---- */

  var aiState = null;
  function familyNameList() { return children().map(function (c) { return c.name; }).filter(Boolean); }
  function openAiBuild(childId) {
    var c = childById(childId);
    aiState = { kind: 'routine', childId: c.id, k: 'morning', doneBy: '08:00', sentence: '' };
    function body(root) {
      var a = aiState;
      var brief = C.routineBrief({ sentence: a.sentence || 'x x x', kind: a.k, band: c.band, doneBy: a.doneBy }, familyNameList());
      var shown = a.sentence.trim() ? brief.sentence : '(what you write, with names taken out)';
      $('.body', root).innerHTML = '<h2>✨ Build a routine from a sentence</h2><p class="muted">Say how ' + esc(c.name ? c.name + '’s' : 'your child’s') + ' mornings or evenings go and what usually goes wrong. Tada proposes the steps; nothing is saved until you choose.</p>' +
        '<div class="seg" role="group" aria-label="Kind">' + [['morning', '🌞 Morning'], ['bedtime', '🌙 Bedtime'], ['other', '⭐ Other']].map(function (k) { return '<button type="button" data-act="ai-kind" data-k="' + k[0] + '" aria-pressed="' + (a.k === k[0]) + '">' + k[1] + '</button>'; }).join('') + '</div>' +
        '<label class="field"><span>' + esc(C.DONE_BY_WORD[a.k]) + '</span><input class="input" type="time" id="aiDone" value="' + esc(a.doneBy) + '"></label>' +
        '<label class="field"><span>In a sentence</span><textarea class="input" id="aiText" maxlength="300" placeholder="6, school bus at 8:10, slow eater, needs reminders for shoes and bag">' + esc(a.sentence) + '</textarea></label>' +
        '<p class="lab">What is sent</p><pre class="sent-pre" id="aiSent" tabindex="0">' + esc(sentText(shown, c, a)) + '</pre>' +
        '<p class="small muted">Names are replaced with “my child” on this device, and again by the server.</p>' +
        '<div id="aiErr"></div><div id="aiOut"></div><div class="row" id="aiActs"></div>';
      var t = $('#aiText', root), d = $('#aiDone', root);
      var upd = function () {
        a.sentence = t.value; if (C.toMin(d.value) !== null) a.doneBy = d.value;
        var b2 = C.routineBrief({ sentence: a.sentence || 'x x x', kind: a.k, band: c.band, doneBy: a.doneBy }, familyNameList());
        $('#aiSent', root).textContent = sentText(a.sentence.trim() && b2 ? b2.sentence : '(what you write, with names taken out)', c, a);
      };
      t.addEventListener('input', upd); d.addEventListener('input', upd);
      var acts = $('#aiActs', root);
      if (!signedIn()) {
        acts.innerHTML = '<div class="note"><p style="margin:0 0 8px">Building a routine uses a cent or two of AI credit, so it needs a free account (it comes with $2). The ready-made routines and the editor are free.</p><button class="btn" type="button" data-act="signin-ai">Create a free account</button></div>';
      } else {
        acts.innerHTML = '<button class="btn ai" type="button" id="aiGo">Build it</button><span class="small muted">A cent or two of AI credit.</span>';
        $('#aiGo', root).addEventListener('click', function () { sendBuild(root, c); });
      }
    }
    aiState.redraw = body;
    sheet('<div class="body"></div>', body);
  }
  function sentText(shown, c, a) {
    return 'A ' + (a.k === 'other' ? '' : a.k + ' ') + 'routine for a child aged ' + bandLabel(c.band).replace('Ages ', '').replace('-', ' to ') + '.\n' + C.DONE_BY_WORD[a.k] + ' ' + fmt(C.toMin(a.doneBy)) + '.\n“' + shown + '”'; // plain text, escaped whole
  }
  function sendBuild(root, c) {
    var a = aiState, go2 = $('#aiGo', root);
    var safe = C.stripNames(C.line(a.sentence, C.LIMITS.sentence), familyNameList()).text;
    if (safe.length < 3) { $('#aiErr', root).innerHTML = '<p class="err" role="alert">Write a sentence first.</p>'; return; }
    go2.disabled = true; go2.textContent = 'Building…';
    $('#aiErr', root).innerHTML = '';
    api('POST', 'api/ai/routine', { sentence: safe, kind: a.k, band: c.band, doneBy: a.doneBy }).then(function (r) {
      var p = r.proposal;
      var draft = { id: uid(), kind: p.kind, name: p.name, emoji: C.ROUTINE_ICON[p.kind], doneBy: a.doneBy, days: p.kind === 'morning' ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6], steps: p.steps.map(function (s) { return { id: uid(), emoji: s.emoji, name: s.name, minutes: s.minutes }; }), template: null, since: today() };
      var t = C.timesFor(draft, 0);
      $('#aiActs', root).innerHTML = '';
      $('#aiOut', root).innerHTML = '<div class="card" style="margin-top:12px"><p class="lab">Proposed</p><h3>' + esc(p.name) + '</h3>' +
        '<div class="startby' + (p.kind === 'bedtime' ? ' night' : '') + '"><b>Start by ' + esc(fmt(t.start)) + '</b><span>' + plural(C.totalMinutes(draft), 'minute') + ' of steps</span></div>' +
        '<ul class="preview">' + p.steps.map(function (s) { return '<li><span class="emo" aria-hidden="true">' + s.emoji + '</span><span>' + esc(s.name) + '</span><span class="mins">' + s.minutes + ' min</span></li>'; }).join('') + '</ul>' +
        (p.tip ? '<p class="small muted">' + esc(p.tip) + '</p>' : '') +
        (r.stripped ? '<p class="small muted">' + plural(r.stripped, 'word') + ' that looked like a name ' + (r.stripped === 1 ? 'was' : 'were') + ' left out.</p>' : '') +
        '<div class="row"><button class="btn" type="button" id="aiUse">Use this routine</button><button class="btn ghost" type="button" data-act="closesheet">Discard</button></div><p class="small muted">Suggested by an AI model - read it over and change anything.</p></div>';
      scrollIntoSheet($('#aiOut', root));
      $('#aiUse', root).addEventListener('click', function () {
        state.edit = { childId: c.id, r: draft, isNew: true };
        closeSheet(true);
        go('edit/' + c.id + '/' + draft.id);
        toast('Here it is - change anything, then add it.');
      });
      loadMe();
    }).catch(function (err) { go2.disabled = false; go2.textContent = 'Build it'; meteredError(err, $('#aiErr', root), function () { openAiBuild(c.id); }, 'Building a routine uses a cent or two of AI credit, so it needs a free account (it comes with $2).'); });
  }
  function openGame(i) {
    var e = state.edit, s = e.r.steps[i], c = childById(e.childId);
    if (!C.line(s.name, 40)) { toast('Give the step a name first.'); return; }
    var safeName = C.stripNames(C.line(s.name, 40), familyNameList()).text;
    function body(root) {
      $('.body', root).innerHTML = '<h2>✨ Make it a game</h2><p class="muted">Three playful ideas to read out for <b>' + esc(s.emoji) + ' ' + esc(s.name) + '</b>. Keep one on the step if you like it.</p>' +
        '<p class="lab">What is sent</p><pre class="sent-pre" tabindex="0">' + esc('One step of a ' + (e.r.kind === 'other' ? '' : e.r.kind + ' ') + 'routine for a child aged ' + bandLabel(c.band).replace('Ages ', '').replace('-', ' to ') + ':\n' + s.emoji + ' ' + safeName + ' (' + s.minutes + ' min)') + '</pre>' + // plain text, escaped whole
        '<div id="gErr"></div><ul class="ideas" id="gOut"></ul><div class="row" id="gActs"></div>';
      var acts = $('#gActs', root);
      if (!signedIn()) {
        acts.innerHTML = '<div class="note"><p style="margin:0 0 8px">Game ideas use a cent or two of AI credit, so they need a free account (it comes with $2).</p><button class="btn" type="button" data-act="signin-game" data-i="' + i + '">Create a free account</button></div>';
        return;
      }
      acts.innerHTML = '<button class="btn ai" type="button" id="gGo">Get 3 ideas</button>';
      var b = $('#gGo', root);
      b.addEventListener('click', function () {
        b.disabled = true; b.textContent = 'Thinking…';
        api('POST', 'api/ai/game', { step: { name: safeName, emoji: s.emoji, minutes: s.minutes }, band: c.band, kind: e.r.kind }).then(function (r) {
          acts.innerHTML = '<button class="btn ghost" type="button" id="gAgain">Three more</button>';
          $('#gAgain', root).addEventListener('click', function () { body(root); $('#gGo', root).click(); });
          $('#gOut', root).innerHTML = r.ideas.map(function (t, j) { return '<li><p>' + esc(t) + '</p><div><button class="btn small ghost" type="button" data-act="keepidea" data-i="' + i + '" data-j="' + j + '">Keep on this step</button></div></li>'; }).join('');
          gameIdeas = r.ideas;
          scrollIntoSheet($('#gOut', root));
          loadMe();
        }).catch(function (err) { b.disabled = false; b.textContent = 'Get 3 ideas'; meteredError(err, $('#gErr', root), function () { openGame(i); }, 'Game ideas use a cent or two of AI credit, so they need a free account (it comes with $2).'); });
      });
    }
    sheet('<div class="body"></div>', body);
  }
  var gameIdeas = [];

  /* ---------------- print and calendar ---------------- */

  function printChart(childId, routineId) {
    var c = childById(childId), r = routineOf(c, routineId);
    if (!r) return;
    var t = C.timesFor(r, 0);
    var n = r.steps.length;
    var size = n <= 8 ? ' roomy' : n <= 11 ? '' : n <= 15 ? ' compact' : ' tight';
    $('#print').innerHTML = '<div class="chart' + size + '"><header><span class="emo">' + r.emoji + '</span><div><h1>' + esc(r.name) + '</h1>' +
      (c.name ? '<p class="for">' + esc(c.name) + '</p>' : '') +
      '<p class="when">' + esc(C.DONE_BY_WORD[r.kind]) + ' ' + esc(fmt(t.doneBy)) + ' · start by ' + esc(fmt(t.start)) + ' · ' + esc(C.fmtDays(r.days)) + '</p></div><span class="p-avatar emo">' + c.avatar + '</span></header>' +
      '<table><thead><tr><th class="p-step" scope="col">Step</th><th class="p-min" scope="col">Min</th>' + C.WEEK.map(function (d) { return '<th scope="col">' + C.DAY_SHORT[d] + '</th>'; }).join('') + '</tr></thead><tbody>' +
      r.steps.map(function (s) { return '<tr><td class="p-step"><span class="emo">' + s.emoji + '</span>' + esc(s.name) + '</td><td class="p-min">' + s.minutes + '</td>' + C.WEEK.map(function (d) { return '<td class="' + (r.days.indexOf(d) >= 0 ? '' : 'off') + '"><span class="box"></span></td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody><tfoot><tr><td class="p-step"><span class="emo">⭐</span>All done!</td><td></td>' + C.WEEK.map(function (d) { return '<td>' + (r.days.indexOf(d) >= 0 ? '<span class="star"></span>' : '') + '</td>'; }).join('') + '</tr></tfoot></table>' +
      '<footer><span>Tick each step when it’s done. Put a sticker in the star.</span><span>Tada 🎉</span></footer></div>';
    setTimeout(function () { try { window.print(); } catch (e) { /* the page still holds the chart */ } }, 50);
  }
  function daysPhrase(days) {
    var dd = C.fmtDays(days);
    return dd === 'Every day' ? 'every day' : dd === 'Weekdays' ? 'on weekdays' : dd === 'Weekends' ? 'at weekends' : 'on ' + dd;
  }
  function addToCalendar(childId, routineId) {
    var c = childById(childId), r = routineOf(c, routineId);
    if (!r) return;
    var text = C.buildIcs({ id: c.id, name: c.name }, r, { today: today(), nowMs: Date.now(), h12: H12 });
    download('tada-' + slug(C.startWord(r)) + (c.name ? '-' + slug(c.name) : '') + '.ics', 'text/calendar', text);
    toast('Open the file to add “' + C.startWord(r) + '” ' + daysPhrase(r.days) + ' at ' + fmt(C.timesFor(r, 0).start) + '.', { ms: 5000 });
  }

  /* ---------------- one click listener ---------------- */

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act'), cId = t.getAttribute('data-c'), rId = t.getAttribute('data-r'), i = Number(t.getAttribute('data-i'));
    var s = state.setup, ed = state.edit;
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); go(state.family ? 'today' : 'start'); break;
      case 'tab': state.edit = null; go(t.getAttribute('data-tab')); break;
      case 'settings': openSettings(); break;
      case 'account': if (signedIn()) openAccountSheet(); else openAccount(); break;
      case 'pref': { var key = t.getAttribute('data-k'); prefs[key] = !prefs[key]; keep(K_PREFS, prefs); t.setAttribute('aria-checked', String(prefs[key])); if (key === 'readAloud' && prefs[key]) speak('Time to brush your teeth!'); break; }
      case 'testvoice': { var was = prefs.readAloud; prefs.readAloud = true; speak('Time to brush your teeth!'); prefs.readAloud = was; break; }
      case 'wipe':
        if (!confirm('Clear every child, routine, sticker and setting on this device? Your account copy (if any) is not touched.')) break;
        keep(K_FAMILY, null); keep(K_PROGRESS, null); keep(K_SYNC, null);
        state.family = null; state.progress = C.emptyProgress(); sync = { base: null, dirty: false, queue: [] };
        closeSheet(true); go('start'); toast('Cleared.'); break;
      case 'signin-sync': openAccount('A free account keeps your family on every device you sign in on - your phone and the family tablet - and today’s ticks follow along.'); break;
      case 'signin-ai': { var aiChild = aiState && aiState.childId; openAccount('Building a routine uses a cent or two of AI credit; a free account comes with $2.', function () { draw(); if (aiChild && childById(aiChild)) openAiBuild(aiChild); }); break; }
      case 'signin-game': openAccount('Game ideas use a cent or two of AI credit; a free account comes with $2.', function () { draw(); openGame(i); }); break;
      case 'retrysync': syncIn(); break;
      case 'conflict': openConflict(); break;
      case 'usetheirs': if (state.conflict) { adopt(state.conflict.family, state.conflict.version); state.conflict = null; closeSheet(true); route(); toast('Using the account’s copy.'); } break;
      case 'keepmine': if (state.conflict) { sync.base = state.conflict.version; keep(K_SYNC, sync); state.conflict = null; closeSheet(true); pushFamily().then(function () { toast('Kept this device’s - the others will follow.'); }); } break;

      // first run
      case 'setup': state.setup = newSetup(); go('setup'); break;
      case 'demo': openKid({ mode: 'step', demo: true }); break;
      case 'su-kind': { var k = t.getAttribute('data-k'); s.morning = k !== 'bedtime'; s.bedtime = k !== 'morning'; draw(); break; }
      case 'su-band': readSetup(); s.band = t.getAttribute('data-b'); draw(); break;
      case 'su-avatar': readSetup(); s.avatar = t.getAttribute('data-a'); draw(); break;
      case 'su-next': readSetup(); s.step = Math.min(4, s.step + 1); draw(); scrollTo(0, 0); var h1 = $('.setup h1'); if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); } break;
      case 'su-back': readSetup(); if (s.step <= 1) go('start'); else { s.step--; draw(); } break;
      case 'su-skip': readSetup(); s.step = 4; draw(); break;
      case 'su-done': finishSetup(false); break;
      case 'su-edit': finishSetup(true); break;

      // today
      case 'kidpick': {
        var list = children();
        if (list.length === 1) { var r1 = C.currentRoutine(list[0], today(), nowMin(), state.progress, plan()); if (r1) { openKid({ mode: 'step', childId: list[0].id, routineId: r1.id }); break; } }
        openKid({ mode: 'pick' }); break;
      }
      case 'side': openKid({ mode: 'side' }); break;
      case 'kidgo': openKid({ mode: 'step', childId: cId, routineId: rId }); break;
      case 'ticks': { var key2 = cId + '_' + rId; state.openTicks[key2] = !state.openTicks[key2]; draw(); var again = $('[data-act="ticks"][data-c="' + cId + '"][data-r="' + rId + '"]'); if (again) again.focus({ preventScroll: true }); break; }
      case 'tick': {
        var on = t.getAttribute('aria-pressed') !== 'true';
        var fin = tap(cId, rId, t.getAttribute('data-s'), on);
        draw();
        var back = $('[data-act="tick"][data-s="' + t.getAttribute('data-s') + '"][data-r="' + rId + '"]'); if (back) back.focus({ preventScroll: true });
        if (fin) { chime(true); toast('Finished - a sticker for the book!'); }
        break;
      }
      case 'addchild': openChild(null); break;
      case 'routinesfor': setActive(cId); go('routines'); break;
      case 'planoffer': { var ch = change(); var offer = ch && C.clockPlan(ch, today()); if (offer) openPlan(offer, ch); break; }
      case 'planmornings': if (planDraft) { planDraft.plan.mornings = !planDraft.plan.mornings; planDraft.redraw($('#sheet')); } break;
      case 'planuse': if (planDraft) { var prev = state.family.settings.plan; state.family.settings.plan = C.cleanPlan(planDraft.plan); saveFamily(); closeSheet(true); draw(); toast('Plan on - the times move by themselves.', { undo: function () { state.family.settings.plan = prev; saveFamily(); draw(); } }); } break;
      case 'plannotnow': { var ch2 = change(); if (ch2) { state.family.settings.planDismissed = ch2.at; saveFamily(); draw(); toast('OK - not this time.', { undo: function () { state.family.settings.planDismissed = 0; saveFamily(); draw(); } }); } break; }
      case 'showplan': { var p = plan(); if (p) sheet('<h2>The clocks plan</h2><p class="muted">' + (p.mornings ? 'Bedtime and mornings move by themselves on these days.' : 'Bedtime moves by itself on these days; mornings stay put.') + '</p>' + planList(p) + '<button class="btn ghost" type="button" data-act="undoplan" style="margin-top:12px">Undo the plan</button>'); break; }
      case 'undoplan': { var old = state.family.settings.plan; state.family.settings.plan = null; saveFamily(); closeSheet(true); draw(); toast('Plan off - usual times again.', { undo: function () { state.family.settings.plan = old; saveFamily(); draw(); } }); break; }

      // routines
      case 'pickchild': setActive(cId); draw(); var tb = $('[data-act="pickchild"][data-c="' + cId + '"]'); if (tb) tb.focus({ preventScroll: true }); break;
      case 'editchild': openChild(cId); break;
      case 'c-band': if (childDraft) { childDraft.c.band = t.getAttribute('data-b'); childDraft.start.lights = C.template('bedtime').doneBy[childDraft.c.band]; childDraft.redraw($('#sheet')); } break;
      case 'c-avatar': if (childDraft) { childDraft.c.avatar = t.getAttribute('data-a'); childDraft.redraw($('#sheet')); } break;
      case 'c-color': if (childDraft) { childDraft.c.color = t.getAttribute('data-k'); childDraft.redraw($('#sheet')); } break;
      case 'c-kind': if (childDraft) { childDraft.start.kind = t.getAttribute('data-k'); childDraft.redraw($('#sheet')); } break;
      case 'c-save': if (childDraft) saveChild(); break;
      case 'c-remove': {
        if (!childDraft) break;
        var who = nameOf(childById(childDraft.c.id));
        if (!confirm('Remove ' + who + ' and their routines from this device' + (signedIn() ? ' and your account' : '') + '? Their stickers go too.')) break;
        state.family.children = children().filter(function (x) { return x.id !== childDraft.c.id; });
        childDraft = null; closeSheet(true);
        if (!state.family.children.length) { state.family = null; keep(K_FAMILY, null); go('start'); break; }
        saveFamily(); setActive(children()[0].id); draw(); toast('Removed ' + who + '.'); break;
      }
      case 'newroutine': openNewRoutine(cId); break;
      case 'tpl': newFromTemplate(cId, t.getAttribute('data-t')); break;
      case 'aibuild': openAiBuild(cId || activeChild().id); break;
      case 'ai-kind': if (aiState) { aiState.k = t.getAttribute('data-k'); aiState.doneBy = aiState.k === 'bedtime' ? C.template('bedtime').doneBy[childById(aiState.childId).band] : aiState.k === 'morning' ? '08:00' : '17:00'; aiState.redraw($('#sheet')); } break;
      case 'edit': state.edit = null; go('edit/' + cId + '/' + rId); break;
      case 'print': printChart(cId, rId); break;
      case 'ics': addToCalendar(cId, rId); break;

      // the editor
      case 'ekind': ed.r.kind = t.getAttribute('data-k'); if (ed.isNew && ed.r.template === null && ed.r.emoji === '⭐') ed.r.emoji = C.ROUTINE_ICON[ed.r.kind]; draw(); break;
      case 'eday': { var d = Number(t.getAttribute('data-d')), j = ed.r.days.indexOf(d); if (j >= 0) { if (ed.r.days.length > 1) ed.r.days.splice(j, 1); else { toast('A routine needs at least one day.'); break; } } else ed.r.days.push(d); t.setAttribute('aria-pressed', String(ed.r.days.indexOf(d) >= 0)); break; }
      case 'addstep': ed.r.steps.push({ id: uid(), emoji: '⭐', name: '', minutes: 3 }); redrawSteps('.step:last-child .sname'); break;
      case 'rmstep': if (ed.r.steps.length > 1) { closeSheet(true); var gone = ed.r.steps.splice(i, 1)[0]; redrawSteps(); toast('Removed ' + (gone.name || 'the step') + '.', { undo: function () { ed.r.steps.splice(i, 0, gone); redrawSteps(); } }); } break;
      case 'minus': ed.r.steps[i].minutes = Math.max(1, ed.r.steps[i].minutes - 1); redrawSteps('[data-act="minus"][data-i="' + i + '"]'); break;
      case 'plus': ed.r.steps[i].minutes = Math.min(30, ed.r.steps[i].minutes + 1); redrawSteps('[data-act="plus"][data-i="' + i + '"]'); break;
      case 'up': if (i > 0) { var a1 = ed.r.steps.splice(i, 1)[0]; ed.r.steps.splice(i - 1, 0, a1); redrawSteps('[data-act="up"][data-i="' + Math.max(1, i - 1) + '"]'); say('Moved to step ' + i + '.'); } break;
      case 'down': if (i < ed.r.steps.length - 1) { var b1 = ed.r.steps.splice(i, 1)[0]; ed.r.steps.splice(i + 1, 0, b1); redrawSteps('[data-act="down"][data-i="' + Math.min(ed.r.steps.length - 2, i + 1) + '"]'); say('Moved to step ' + (i + 2) + '.'); } break;
      case 'pickemoji': openEmoji(i); break;
      case 'stepmenu': {
        var sm = ed.r.steps[i];
        sheet('<h2><span class="emo" aria-hidden="true">' + sm.emoji + '</span> ' + esc(sm.name || 'This step') + '</h2><div class="tpl-list">' +
          '<button class="choice" type="button" data-act="game" data-i="' + i + '"><span class="emo" aria-hidden="true">✨</span><b>Make it a game</b><span>Three playful ideas to read out - a cent or two of AI credit.</span></button>' +
          '<button class="choice" type="button" data-act="rmstep" data-i="' + i + '"' + (ed.r.steps.length <= 1 ? ' disabled' : '') + '><span class="emo" aria-hidden="true">✕</span><b>Remove this step</b><span>' + (ed.r.steps.length <= 1 ? 'A routine needs at least one step.' : 'You can undo it straight after.') + '</span></button></div>');
        break;
      }
      case 'setemoji': ed.r.steps[i].emoji = t.getAttribute('data-e'); ed.r.steps[i].emojiChosen = true; closeSheet(true); redrawSteps('[data-act="pickemoji"][data-i="' + i + '"]'); break;
      case 'game': openGame(i); break;
      case 'keepidea': ed.r.steps[i].game = gameIdeas[Number(t.getAttribute('data-j'))] || ''; closeSheet(true); redrawSteps(); toast('Kept - it shows on the step in kid mode. Save to keep it.'); break;
      case 'rmgame': delete ed.r.steps[i].game; redrawSteps(); break;
      case 'saveedit': saveEdit(); break;
      case 'canceledit': state.edit = null; go('routines'); break;
      case 'delroutine': {
        var c0 = childById(ed.childId);
        if (!confirm('Delete ' + (ed.r.name || 'this routine') + '? Its stickers stay in the book.')) break;
        var removed = routineOf(c0, ed.r.id), at = c0.routines.indexOf(removed);
        c0.routines = c0.routines.filter(function (x) { return x.id !== ed.r.id; });
        state.edit = null; saveFamily(); go('routines');
        toast('Deleted.', { undo: function () { c0.routines.splice(at, 0, removed); saveFamily(); draw(); } });
        break;
      }

      // kid mode
      case 'k-done': kidStepDone(t); break;
      case 'k-undo': kidUndo(); break;
      case 'k-say': { var kk = state.kid, rr = kidRoutine(kk), cc = kk.demo ? null : childById(kk.childId); var st0 = rr && C.nextStep(rr, kidDone(kk, cc && cc.id, rr)); if (st0) speak(C.sayFor(st0)); break; }
      case 'k-who': state.kid.mode = 'step'; state.kid.childId = cId; state.kid.routineId = (C.currentRoutine(childById(cId), today(), nowMin(), state.progress, plan()) || {}).id; state.kid.last = null; drawKid(); break;
      case 'k-pickmode': state.kid.mode = 'pick'; state.kid.hint = false; drawKid(); break;
      case 'k-again': state.kid.mode = 'pick'; drawKid(); break;
      case 'k-setup': closeKid(); state.setup = newSetup(); go('setup'); break;
      case 'k-leavedemo': if (state.kid && state.kid.demo) closeKid(); break;
      case 'k-gate': state.kid.gate = newGate(); state.kid.hint = false; drawKid(); var o1 = $('#kid .k-gate .opts button'); if (o1) o1.focus(); break;
      case 'k-gateans': if (Number(t.getAttribute('data-n')) === state.kid.gate.sum) closeKid(); else { state.kid.gate = newGate(); state.kid.gate.wrong = true; drawKid(); } break;
      case 'k-gateno': state.kid.gate = null; drawKid(); break;
      default: break;
    }
  });
  // A tap (not a hold) on the corner ✕: say how to leave, quietly.
  kidEl.addEventListener('click', function (e) {
    if (!e.target.closest('#kExit') || !state.kid) return;
    if (hold) return;
    state.kid.hint = !state.kid.hint; drawKid();
  });

  /* ---------------- keeping it current ---------------- */

  /** A selector that finds the same control after a redraw (ids are [a-z0-9]). */
  function focusKey(el) {
    if (!el || !el.getAttribute || !el.getAttribute('data-act')) return null;
    return '[data-act="' + el.getAttribute('data-act') + '"]' + ['data-c', 'data-r', 'data-s', 'data-i', 'data-tab'].map(function (k) { var v = el.getAttribute(k); return v !== null && /^[a-z0-9]*$/.test(v) ? '[' + k + '="' + v + '"]' : ''; }).join('');
  }

  var lastMinute = -1;
  setInterval(function () {
    if (document.hidden) return;
    var m = nowMin();
    if (m === lastMinute) return;
    lastMinute = m;
    if (state.family && !state.kid && state.view === 'today' && $('#sheet').hidden && !(document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName))) {
      expirePlan();
      var y = window.scrollY, f = focusKey(document.activeElement);
      draw(); scrollTo(0, y);
      var back = f && $(f); if (back) try { back.focus({ preventScroll: true }); } catch (x) { /* ignore */ }
    }
  }, 5000);
  var lastPull = 0;
  setInterval(function () {
    if (document.hidden || !signedIn() || !state.family) return;
    if (state.kid || state.view === 'today' || state.view === 'stickers') { if (Date.now() - lastPull > 19000) { lastPull = Date.now(); pullProgress(); flushTaps(); } }
  }, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && signedIn()) syncIn(); });
  window.addEventListener('online', function () { if (signedIn()) { flushTaps(); if (sync.dirty) pushFamily(); } });

  /* ---------------- start ---------------- */

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(function () { var p = $('#offlinePill'); if (p) p.hidden = false; }).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  if (state.family) expirePlan();
  drawTop();
  route();
  loadMe().then(function () {
    if (signedIn()) syncIn();
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openAccountSheet();
  });
}());
