/* Firstday - the page. One file, no build step. Every string that came from
 * outside this file (a typed name, a task, a welcome message, a check-in
 * answer, anything the server or a model sent) is escaped before it is
 * drawn, and no handler is written into markup: clicks are routed by
 * data-act attributes from one listener (the lab's CSP allows script from
 * this origin only). The rules - due dates, readiness, check-ins, the views
 * and the calendar file - are firstday-core.js, the same file the server
 * and the tests run.
 *
 * Who is looking:
 *   home     - the first run: "See a sample first week", "Start a plan", the
 *              plans this phone runs.
 *   manager  - the sample (kept on this phone) or a real plan (p/<CODE> on a
 *              phone that holds its key): the readiness meter, Plan, Links,
 *              Check-ins, Details.
 *   link     - l/<CODE>: the new hire's welcome page, or the buddy's or
 *              IT/admin's tasks. The sample previews each of them.
 *
 * On this phone (localStorage, every access wrapped): firstday-sample-v1 (the
 * sample plan), firstday-plans-v1 (the manager key for each plan this phone
 * runs).
 */
(function () {
  'use strict';

  var C = window.FirstdayCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_SAMPLE = 'firstday-sample-v1';
  var K_PLANS = 'firstday-plans-v1';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ROUTE = (function () {
    var m = /\/(p|l)\/([A-Za-z0-9-]{8,20})\/?$/.exec(location.pathname);
    return m ? { kind: m[1], code: m[2].toUpperCase().replace(/[^A-Z0-9]/g, '') } : null;
  }());
  var LOCAL_ZONE = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }());
  var TABS = [['plan', 'Plan'], ['links', 'Links'], ['checkins', 'Check-ins'], ['details', 'Details']];
  var ROLE_TITLE = { hire: 'New hire', buddy: 'Buddy', it: 'IT/admin' };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  var state = {
    me: null,          // the account, if any
    view: 'home',      // home | manager | link
    local: false,      // the sample, run on this phone
    code: null,        // a real plan's code (manager) or a role link's code
    key: null,         // the plan's manager key, on a phone that runs it
    doc: null,         // the sample's raw plan (local only)
    m: null,           // the manager's view
    links: null,       // a real plan's role-link codes
    lv: null,          // a role link's view
    preview: null,     // sample only: the role whose link we preview
    tab: 'plan',
    armed: null,       // a destructive tap waiting for its second
    tailor: null,      // the Tailor sheet
    cdAt: null,        // the instant day 1 starts, for the live countdown
    err: null,
  };
  var main = $('#main');

  /* ---------------- plumbing ---------------- */

  function api(method, path, body, headers) {
    var h = {};
    if (body) h['Content-Type'] = 'application/json';
    if (headers) for (var k in headers) h[k] = headers[k];
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin', headers: h,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.error) {
          var e = new Error(data.error || 'Something went wrong.');
          e.status = data.status || res.status; e.data = data;
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
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the link and copy it by hand.'); });
  }
  function share(title, text, url) {
    if (navigator.share) navigator.share({ title: title, text: text, url: url }).catch(function () { /* closed */ });
    else copy(url, 'Link copied - paste it in a message to them');
  }
  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function nowMs() { return Date.now(); }
  function myPlans() { var m = recall(K_PLANS); return m && typeof m === 'object' ? m : {}; }
  function rememberPlan(code, key, label) {
    var m = myPlans();
    m[code] = { key: key, name: C.clean(label, 80), at: nowMs() };
    var codes = Object.keys(m);
    if (codes.length > 16) delete m[codes[0]];
    keep(K_PLANS, m);
  }
  function forgetPlan(code) { var m = myPlans(); delete m[code]; keep(K_PLANS, m); }
  function keyFor(code) { var t = myPlans()[code]; return t && typeof t.key === 'string' && /^[A-Za-z0-9_-]{22}$/.test(t.key) ? t.key : null; }
  function linkUrl(code) { return location.origin + BASE + 'l/' + code; }
  function planLabel(p) { return [p.hire, p.role, p.business].filter(Boolean).join(' · '); }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }

  /* ---------------- names and dates ---------------- */

  function ownerName(p, o) {
    if (o === 'manager') return p.manager;
    if (o === 'buddy') return p.buddy || 'Buddy';
    if (o === 'hire') return p.hire;
    return 'IT/admin';
  }
  function ownChip(p, o) {
    var name = ownerName(p, o);
    var label = o === 'it' ? 'IT/admin' : name + ' · ' + C.OWNER_LABEL[o];
    return '<span class="own ' + esc(o) + '">' + esc(label) + '</span>';
  }
  function when(t, plan) {
    if (t.time) return '<span class="time">' + esc(C.fmtTime(t.time)) + '</span>';
    return esc(C.dayLabel(t.due)) + (t.due === plan.start ? ' (day 1)' : '');
  }
  function longStart(p) { return C.longDay(p.start); }

  /* ---------------- changes: the same rules, here or on the server ---------------- */

  function refreshLocal() { state.m = C.managerView(state.doc, nowMs()); }
  function saveSample() { if (state.local) keep(K_SAMPLE, state.doc); }
  /** A manager's change. The sample runs it here with the core and keeps the
   *  result on this phone; a real plan sends it to the server, which runs
   *  the same core inside a transaction. */
  function manage(action, payload) {
    var body = Object.assign({ action: action }, payload || {});
    if (state.local) {
      return new Promise(function (resolve) {
        var r = C.manage(state.doc, action, body, nowMs());
        saveSample(); refreshLocal();
        resolve(r);
      });
    }
    return api('POST', 'api/plans/' + state.code + '/manage', body, { 'X-Firstday-Key': state.key }).then(function (d) {
      state.m = d.plan; state.links = d.links;
      return d.result || {};
    });
  }
  /** A role link's change (or the sample's preview of one). */
  function linkAct(action, payload) {
    var body = Object.assign({ action: action }, payload || {});
    if (state.local) {
      return new Promise(function (resolve) {
        C.linkAct(state.doc, state.preview, action, body, nowMs(), { early: true });
        saveSample(); refreshLocal();
        state.lv = C.roleView(state.doc, state.preview, nowMs());
        resolve({});
      });
    }
    return api('POST', 'api/l/' + state.code + '/act', body).then(function (d) { state.lv = d.plan; return d.result || {}; });
  }

  /* ---------------- drawing ---------------- */

  function draw() {
    if (state.view === 'manager') drawManager();
    else if (state.view === 'link') drawLink();
    else drawHome();
    tickClock();
  }
  function go(view) { state.view = view; draw(); scrollTo(0, 0); try { main.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }

  /* ---------- home ---------- */

  function peek() {
    return '<div class="peek" aria-hidden="true"><p class="eyebrow">Sam starts Monday</p><h3>Ready for day 1?</h3>' +
      '<div class="meter behind"><span style="width:78%"></span></div><p class="ready-text">7 of 9 done - uniform not ordered, 3 days to go</p>' +
      '<ul><li><span class="chip ok">✓ Done</span> Paperwork sent</li><li><span class="chip ok">✓ Done</span> Team told, buddy briefed</li><li><span class="chip err">⚠ Overdue</span> Order the uniform</li><li><span class="chip">Fri</span> Plan a first-day break</li></ul></div>';
  }
  function drawHome() {
    var plans = myPlans();
    var codes = Object.keys(plans);
    var sample = recall(K_SAMPLE);
    main.innerHTML =
      '<div class="hero hero-grid"><div>' +
      '<p class="eyebrow">Onboarding for small businesses</p>' +
      '<h1>A new hire’s first week, planned in ten minutes - <em>and nobody forgets the laptop.</em></h1>' +
      '<p class="lede">Pick a template, add their name and start date, and get the whole first week: what to order and set up before day 1, day 1 hour by hour, days 2 to 5, and check-ins at 30, 60 and 90 days - each task with an owner and a date.</p>' +
      '<div class="hero-cta"><button class="btn big block" type="button" data-act="sample">👀 See a sample first week<span class="sub">A made-up cafe hire starting Monday, most of the prep done</span></button>' +
      '<div class="row"><button class="btn ghost" type="button" data-act="start">Start a plan</button>' + (sample ? '<button class="btn ghost" type="button" data-act="resume">Back to the sample</button>' : '') + '</div></div>' +
      '<div class="trust"><span>Free</span><span>No account for you or them</span><span>First names only</span></div>' +
      '</div>' + peek() + '</div>' +
      (codes.length ? '<section aria-labelledby="yoursH"><h2 id="yoursH">Plans on this phone</h2><p class="lede">The manager key is kept here - these open as manager only on this phone.</p><ul class="list">' + codes.map(function (c) {
        return '<li><a class="btn ghost block between" href="' + esc(BASE + 'p/' + c) + '"><span>' + esc(plans[c].name || 'Plan') + '</span><span aria-hidden="true">→</span></a></li>';
      }).join('') + '</ul></section>' : '') +
      '<section aria-labelledby="howH"><h2 id="howH">How it works</h2><ol class="how">' +
      '<li><b>Start from a template.</b> Front of house, office, trades, remote or part-time - every task has an owner and a date worked out from the start date, skipping weekends and your holidays.</li>' +
      '<li><b>Watch the meter.</b> “7 of 9 done - laptop not ordered, 3 days to go.” Anything overdue is called out.</li>' +
      '<li><b>Send three links.</b> The new hire gets a warm welcome page - where to go, when, who to ask for, what to bring, the week. The buddy and IT/admin each see only their own tasks.</li>' +
      '<li><b>Check in.</b> On day 5, 30, 60 and 90 the new hire answers three short questions on their link, and you see the answers.</li></ol></section>' +
      '<section aria-labelledby="whyH"><h2 id="whyH">Why the first week matters</h2><div class="why">' +
      '<div class="card"><h3>People decide early</h3><p>Whether they’ll stay is often settled in the first week. No laptop, no login and nobody expecting them says more than any welcome speech.</p></div>' +
      '<div class="card"><h3>Nobody owns it</h3><p>With no HR team, onboarding falls between the manager, whoever does IT and the team. Every task here has one owner and a date.</p></div>' +
      '<div class="card"><h3>Private by design</h3><p>First names and tasks only. Firstday refuses salaries, bank details and ID numbers - those stay in payroll.</p></div>' +
      '</div></section>' +
      '<section aria-labelledby="tplH"><h2 id="tplH">Built-in templates</h2><div class="tpls">' + Object.keys(C.TEMPLATES).map(function (k) {
        var t = C.TEMPLATES[k];
        return '<button type="button" class="tpl" data-act="start" data-id="' + k + '"><span class="e" aria-hidden="true">' + t.emoji + '</span><b>' + esc(t.label) + '</b><span class="small muted">' + esc(t.blurb) + '</span></button>';
      }).join('') + '</div></section>' +
      '<section aria-labelledby="aiH"><div class="card"><h2 id="aiH">✨ Tailor it to us</h2><p>Describe the role and your business in a few lines and get a plan written for it, in the same shape - for you to check before anything changes.</p><p class="small muted">' + (signedIn() ? 'Uses a cent or two of AI credit.' : 'Needs a free account. The templates and everything else are free with no account.') + '</p></div></section>' +
      '<p class="foot small muted">Firstday is a trial in the Challenge Lab. A plan is kept until 60 days after its last change, and always until 120 days after day 1. It isn’t legal or HR advice - right-to-work checks and paperwork rules where you are still apply.</p>';
  }

  /* ---------- manager ---------- */

  function headCard(m) {
    var p = m.plan, c = m.countdown;
    var big = c.before ? (c.toGo > 0 ? String(c.toGo) : 'Today') : 'Day ' + c.day;
    var small = c.before ? (c.toGo > 1 ? 'days to go' : c.toGo === 1 ? 'day to go' : 'at ' + C.fmtTime(p.arrive)) : (c.day <= 5 ? 'of the first week' : 'on the job');
    return '<div class="card"><p class="eyebrow">' + (state.local ? 'Sample plan · made up' : 'Onboarding plan') + '</p>' +
      '<h1>' + esc(p.hire) + ' starts ' + esc(longStart(p)) + '</h1>' +
      '<p class="muted" style="margin:4px 0 10px">' + esc(p.role) + (p.business ? ' at ' + esc(p.business) : '') + ' · ' + esc(C.PATTERN_LABEL[p.pattern]) + '</p>' +
      '<div class="who">' + ownChip(p, 'manager') + (p.buddy ? ownChip(p, 'buddy') : '') + '</div>' +
      '<div class="count" style="margin-top:12px"><span class="num">' + esc(big) + '</span><span class="muted">' + esc(small) + '</span></div>' +
      (c.before ? '<p class="small muted" style="margin:0" data-clock="short">' + esc(clockText()) + '</p>' : '') + '</div>';
  }
  function clockText() {
    if (!state.cdAt) return '';
    var ms = state.cdAt - nowMs();
    if (ms <= 0) return 'Day 1 has started.';
    var d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), mi = Math.floor((ms % 3600000) / 60000);
    return (d ? d + 'd ' : '') + h + 'h ' + mi + 'm until they arrive';
  }
  function readyCard(m) {
    var r = m.readiness;
    var level = r.level === 'ready' ? '<span class="chip ok">✓ Ready</span>' : r.level === 'behind' ? '<span class="chip err">⚠ Behind</span>' : '<span class="chip warn">On track</span>';
    var od = m.overdue;
    return '<div class="card" aria-labelledby="rdyH"><div class="row between ready-level"><h2 id="rdyH" style="margin:0">Ready for day 1?</h2>' + level + '</div>' +
      '<div class="meter' + (r.level === 'behind' ? ' behind' : '') + '" role="img" aria-label="' + esc(r.done + ' of ' + r.total + ' prep tasks done') + '"><span style="width:' + (REDUCED || state.meterSeen ? r.pct : 0) + '%" data-w="' + r.pct + '"></span></div>' +
      '<p class="ready-text">' + esc(r.text) + '</p>' +
      (od.length ? '<ul class="alerts" aria-label="Overdue">' + od.slice(0, 4).map(function (t) {
        return '<li><span aria-hidden="true">⚠</span><span>Overdue since ' + esc(C.dayLabel(t.due)) + ': ' + esc(t.title) + ' - ' + esc(ownerName(m.plan, t.owner)) + '</span></li>';
      }).join('') + (od.length > 4 ? '<li><span aria-hidden="true">⚠</span><span>and ' + esc(od.length - 4) + ' more</span></li>' : '') + '</ul>' : '') + '</div>';
  }
  function tabBar() {
    var open = state.m.checkins.filter(function (k) { return k.state === 'done'; }).length;
    return '<nav class="tabs" aria-label="Plan sections">' + TABS.map(function (t) {
      return '<button type="button" class="tab" data-act="tab" data-id="' + t[0] + '" aria-pressed="' + (state.tab === t[0]) + '">' + t[1] + (t[0] === 'checkins' && open ? ' <span class="chip ok">' + open + '</span>' : '') + '</button>';
    }).join('') + '</nav>';
  }
  function drawManager() {
    var m = state.m;
    state.cdAt = m.countdown.at;
    var html = '<div class="phead">' + headCard(m) + readyCard(m) + '</div>' +
      (state.local ? '<div class="note row between" style="margin-top:14px"><span class="small">This is a made-up sample. Tick things, preview the links, try a check-in - it stays on this phone.</span><button class="btn small" type="button" data-act="realfromsample">Use it for a real hire</button></div>' : '') +
      tabBar();
    if (state.tab === 'links') html += drawLinksTab();
    else if (state.tab === 'checkins') html += drawChecksTab();
    else if (state.tab === 'details') html += drawDetailsTab();
    else html += drawPlanTab();
    main.innerHTML = html;
    afterManager();
  }
  function afterManager() {
    var bar = $('.meter > span');
    if (bar && !REDUCED && !state.meterSeen) requestAnimationFrame(function () { requestAnimationFrame(function () { bar.style.width = bar.getAttribute('data-w') + '%'; }); });
    state.meterSeen = true;
    var f = $('#detForm');
    if (f) { f.addEventListener('submit', saveDetails); pillPick(f, 'pattern'); }
  }

  function taskRow(t, p, opts) {
    var o = opts || {};
    var who = o.hideOwner ? '' : ownChip(p, t.owner);
    var tick = o.canTick
      ? '<button type="button" class="tick" data-act="' + (o.tickAct || 'tick') + '" data-id="' + esc(t.id) + '" aria-pressed="' + Boolean(t.done) + '" aria-label="' + esc((t.done ? 'Done: ' : 'Mark done: ') + t.title) + '">' + (t.done ? '✓' : '') + '</button>'
      : '<span class="tick" aria-hidden="true" style="opacity:.55">' + (t.done ? '✓' : '·') + '</span>';
    var meta = '<span class="meta">' + who + '<span>' + when(t, p) + '</span>' + (t.done ? '<span class="chip ok">✓ Done</span>' : '') + (t.overdue ? '<span class="chip err">⚠ Overdue</span>' : '') + (t.checkin ? '<span class="chip">Check-in</span>' : '') + '</span>';
    var body = o.editable
      ? '<button type="button" class="trow" data-act="edittask" data-id="' + esc(t.id) + '" aria-label="' + esc('Edit: ' + t.title) + '"><span class="ttl">' + esc(t.title) + '</span>' + meta + '</button>'
      : '<div class="trow static"><span class="ttl">' + esc(t.title) + '</span>' + meta + '</div>';
    return '<li class="task' + (t.done ? ' done' : '') + (t.overdue ? ' late' : '') + '">' + tick + body + '</li>';
  }
  function drawPlanTab() {
    var m = state.m, p = m.plan;
    var html = '<div class="tools"><button class="btn small" type="button" data-act="tailor">✨ Tailor it to us</button><button class="btn small ghost" type="button" data-act="template">Change template</button><button class="btn small ghost" type="button" data-act="mics">📅 Calendar</button></div>';
    if (!p.where && !state.local) html += '<div class="note row between"><span class="small">The welcome page still needs <b>where to go</b> and what to bring.</span><button class="btn small ghost" type="button" data-act="tab" data-id="details">Fill it in</button></div>';
    C.SECTIONS.forEach(function (s) {
      var list = m.tasks.filter(function (t) { return t.phase === s[0]; });
      var done = list.filter(function (t) { return t.done; }).length;
      html += '<section class="sec" aria-labelledby="sec-' + s[0] + '"><h2 id="sec-' + s[0] + '">' + esc(s[1]) + ' <span class="small">' + done + ' of ' + list.length + ' done</span></h2>' +
        (list.length ? '<ul class="tasks">' + list.map(function (t) { return taskRow(t, p, { canTick: true, editable: true }); }).join('') + '</ul>' : '<p class="muted small">Nothing here yet.</p>') +
        '<button class="btn small ghost addt" type="button" data-act="addtask" data-id="' + s[0] + '">+ Add a task</button></section>';
    });
    return html;
  }

  var SHOWS = {
    hire: 'A welcome page: where to go, when, who to ask for, what to bring and your message; the first week’s schedule; their own to-dos; their check-ins.',
    buddy: 'Their own tasks and the start date. Not the prep list, not anyone else’s tasks, not the check-ins.',
    it: 'Their own tasks and the start date. Not the prep list, not anyone else’s tasks, not the check-ins.',
  };
  function drawLinksTab() {
    var p = state.m.plan;
    var html = '<p class="muted">One link each, no app and no account. A link shows first names and tasks - never pay, contact details or anyone’s ID.</p><div class="links">';
    C.ROLES.forEach(function (r) {
      var name = r === 'it' ? 'IT/admin' : ownerName(p, r);
      var mine = state.m.tasks.filter(function (t) { return t.owner === r; });
      var url = state.links && state.links[r] ? linkUrl(state.links[r]) : null;
      html += '<div class="card lcard"><h3><span class="own ' + r + '">' + esc(ROLE_TITLE[r]) + '</span>' + esc(name) + '</h3>' +
        '<p class="small muted" style="margin:0">' + esc(plural(mine.length, 'task')) + ' · ' + esc(plural(mine.filter(function (t) { return t.done; }).length, 'done', 'done')) + '</p>' +
        '<p class="small" style="margin-top:8px"><b>Shows:</b> ' + esc(SHOWS[r]) + '</p>' +
        (url ? '<p class="linkline">' + esc(url) + '</p>' : '') +
        '<div class="row">' + (url ? '<button class="btn small" type="button" data-act="sharelink" data-id="' + r + '">Share</button><button class="btn small ghost" type="button" data-act="copylink" data-id="' + r + '">Copy</button>' : '') +
        '<button class="btn small ghost" type="button" data-act="preview" data-id="' + r + '">👀 Preview</button>' +
        (url ? '<button class="btn small ghost" type="button" data-act="relink" data-id="' + r + '">New link</button>' : '') + '</div></div>';
    });
    html += '</div>';
    if (state.local) html += '<p class="note small">In a real plan each of these is a link you send. Here, Preview shows exactly what that person would see.</p>';
    else html += '<div class="card" style="margin-top:14px"><h3 style="margin-top:0">Open this plan on another device</h3><p class="small muted">The manager key lives on this phone. This link carries it - anyone with it can change the plan, so send it only to yourself.</p><button class="btn small ghost" type="button" data-act="mgrlink">Copy my manager link</button></div>';
    return html;
  }
  function moodLine(a) { return '<span class="moodline">' + C.MOOD_ICON[a.mood] + ' ' + esc(C.MOODS[a.mood]) + '</span>'; }
  function drawChecksTab() {
    var m = state.m;
    if (!m.checkins.length) return '<p class="muted">This plan has no check-ins. Add a task with a check-in from a template, or start from one.</p>';
    return '<p class="muted">On each day, ' + esc(m.plan.hire) + '’s link opens three short questions. Their answers appear here - kept only as long as the plan.</p><div class="checks">' + m.checkins.map(function (k) {
      var chip = k.state === 'done' ? '<span class="chip ok">✓ Answered</span>' : k.state === 'open' ? '<span class="chip warn">Open now</span>' : '<span class="chip">Opens ' + esc(C.dayLabel(k.due)) + '</span>';
      var a = k.answer;
      return '<div class="card ck"><h3><span>' + esc(k.label) + (k.state === 'upcoming' ? '' : ' <span class="small muted">' + esc(C.dayLabel(k.due)) + '</span>') + '</span>' + chip + '</h3>' +
        (a ? '<div class="answer"><p class="q">How’s it going?</p>' + moodLine(a) +
          '<p class="q">What’s still unclear?</p><p class="a">' + (a.unclear ? esc(a.unclear) : '<span class="muted">Nothing said.</span>') + '</p>' +
          '<p class="q">What would help?</p><p class="a">' + (a.help ? esc(a.help) : '<span class="muted">Nothing said.</span>') + '</p>' +
          '<p class="small muted" style="margin:6px 0 0">Sent ' + esc(C.dayLabel(a.at.slice(0, 10))) + '</p></div>'
          : '<p class="small muted" style="margin:0">' + (k.state === 'open' ? 'Waiting for ' + esc(m.plan.hire) + ' to answer on their link.' : 'Nothing to read yet.') + '</p>') + '</div>';
    }).join('') + '</div>';
  }
  function zoneOptions(cur) {
    var zs = [];
    try { zs = Intl.supportedValuesOf('timeZone'); } catch (e) { zs = [cur, 'UTC']; }
    if (zs.indexOf(cur) < 0) zs.unshift(cur);
    return zs.map(function (z) { return '<option' + (z === cur ? ' selected' : '') + '>' + esc(z) + '</option>'; }).join('');
  }
  function patternPills(cur) {
    return '<div class="pills" role="group" aria-label="Work pattern">' + C.PATTERNS.map(function (k) { return '<button type="button" class="pill" data-k="pattern" data-v="' + k + '" aria-pressed="' + (cur === k) + '">' + esc(C.PATTERN_LABEL[k]) + '</button>'; }).join('') + '</div>';
  }
  function drawDetailsTab() {
    var p = state.m.plan;
    var L = C.LIMITS;
    return '<div class="split"><form id="detForm" class="card"><h2>The new hire and the welcome page</h2>' +
      '<div class="two"><label class="field"><span>New hire’s first name</span><input class="input" name="hire" maxlength="' + L.name + '" value="' + esc(p.hire) + '" required></label>' +
      '<label class="field"><span>Role</span><input class="input" name="role" maxlength="' + L.role + '" value="' + esc(p.role) + '" required></label></div>' +
      '<div class="two"><label class="field"><span>Start date</span><input class="input" type="date" name="start" value="' + esc(p.start) + '" required></label>' +
      '<label class="field"><span>Arrive at</span><input class="input" type="time" name="arrive" value="' + esc(p.arrive) + '"></label></div>' +
      '<div class="two"><label class="field"><span>Manager</span><input class="input" name="manager" maxlength="' + L.name + '" value="' + esc(p.manager) + '" required></label>' +
      '<label class="field"><span>Buddy</span><input class="input" name="buddy" maxlength="' + L.name + '" value="' + esc(p.buddy) + '"></label></div>' +
      '<label class="field"><span>Business</span><input class="input" name="business" maxlength="' + L.business + '" value="' + esc(p.business) + '"></label>' +
      '<div class="field"><span class="lbl">Work pattern</span>' + patternPills(p.pattern) + '</div>' +
      '<label class="field"><span>Where to go on day 1</span><input class="input" name="where" maxlength="' + L.place + '" value="' + esc(p.where) + '" placeholder="e.g. The side door by the bike rack"><span class="hint">The business, never anyone’s home.</span></label>' +
      '<div class="two"><label class="field"><span>Ask for</span><input class="input" name="ask" maxlength="' + L.name + '" value="' + esc(p.ask) + '"></label>' +
      '<label class="field"><span>Time zone</span><select class="input" name="zone">' + zoneOptions(p.zone) + '</select></label></div>' +
      '<label class="field"><span>What to bring</span><input class="input" name="bring" maxlength="' + L.bring + '" value="' + esc(p.bring) + '"></label>' +
      '<label class="field"><span>Your welcome message</span><textarea class="input" name="welcome" maxlength="' + L.welcome + '" rows="5">' + esc(p.welcome) + '</textarea><span class="hint">Shown on their welcome page. Keep pay and personal details out - they’re refused.</span></label>' +
      '<label class="check"><input type="checkbox" name="workWeekends"' + (p.workWeekends ? ' checked' : '') + '> We work weekends (count Saturday and Sunday as working days)</label>' +
      '<div id="detErr"></div><button class="btn block" type="submit">Save</button></form>' +
      '<div><div class="card"><h2>Holidays</h2><p class="small muted">Due dates skip these, as well as weekends.</p>' +
      '<ul class="hols">' + p.holidays.map(function (d) { return '<li>' + esc(C.dayLabel(d)) + ' ' + esc(d.slice(0, 4)) + '<button type="button" class="x" data-act="delhol" data-id="' + esc(d) + '" aria-label="' + esc('Remove ' + C.dayLabel(d)) + '">×</button></li>'; }).join('') + '</ul>' +
      (p.holidays.length ? '' : '<p class="small muted">None yet.</p>') +
      '<div class="row"><label class="vh" for="holIn">Add a holiday</label><input class="input" id="holIn" type="date" style="flex:1;min-width:0"><button class="btn small" type="button" data-act="addhol">Add</button></div></div>' +
      '<div class="card"><h2>The next hire</h2><p class="small muted">Copy every task to a new plan - nothing ticked, no check-ins, new name and date.</p><button class="btn ghost block" type="button" data-act="copynext">Copy this plan for the next hire</button></div>' +
      '<div class="card danger"><h2>' + (state.local ? 'Start the sample over' : 'Delete this plan') + '</h2><p class="small muted">' + (state.local ? 'Puts the sample back as it was.' : 'Deletes the plan, its three links and any check-in answers, for everyone. It can’t be undone.') + '</p><button class="btn ghost" type="button" data-act="' + (state.local ? 'resetsample' : 'delplan') + '">' + (state.local ? 'Start over' : 'Delete the plan') + '</button></div></div></div>';
  }
  function saveDetails(e) {
    e.preventDefault();
    var f = e.target;
    var pat = $('[data-k="pattern"][aria-pressed="true"]', f);
    var plan = { hire: f.hire.value, role: f.role.value, start: f.start.value, arrive: f.arrive.value, manager: f.manager.value, buddy: f.buddy.value, business: f.business.value, where: f.where.value, ask: f.ask.value, zone: f.zone.value, bring: f.bring.value, welcome: f.welcome.value, workWeekends: f.workWeekends.checked, pattern: pat ? pat.getAttribute('data-v') : state.m.plan.pattern };
    manage('details', { plan: plan }).then(function () { draw(); toast('Saved - the links show it now.'); }).catch(function (err) { showError(err, $('#detErr')); });
  }

  /* ---------- a role link: the welcome page, the buddy's tasks ---------- */

  function previewBar(v) {
    if (!state.local) return '';
    var who = v.role === 'it' ? 'IT/admin' : ownerName(v.plan, v.role);
    return '<div class="previewbar" role="status"><span>👀 Previewing ' + esc(who) + '’s link</span><button type="button" class="link-btn" data-act="endpreview">Back to the plan</button></div>';
  }
  function clockCard(v) {
    var c = v.countdown;
    if (!c.before) return '<div class="card"><p class="eyebrow">You’re in</p><h2 style="margin:0">' + esc(c.label) + '</h2></div>';
    return '<div class="card"><p class="eyebrow">Day 1 countdown</p><div class="clock" data-clock="big"><div><b data-u="d">' + c.days + '</b><span>days</span></div><div><b data-u="h">' + c.hours + '</b><span>hours</span></div><div><b data-u="m">' + c.mins + '</b><span>minutes</span></div></div>' +
      '<p class="small muted" style="margin:6px 0 0">Until ' + esc(C.fmtTime(v.plan.arrive)) + ' on ' + esc(longStart(v.plan)) + ' (' + esc(v.plan.zone.replace(/_/g, ' ')) + ' time)</p></div>';
  }
  function drawLink() {
    var v = state.lv;
    if (!v) {
      main.innerHTML = '<div class="card"><h1>That link isn’t working</h1><p>' + esc(state.err || 'It may have been replaced or the plan finished.') + '</p><p class="small muted">Ask whoever sent it for the current link.</p><a class="btn ghost" href="' + esc(BASE) + '">What is Firstday?</a></div>';
      return;
    }
    state.cdAt = nowMs() + v.countdown.ms;
    if (v.role === 'hire') drawWelcome(v); else drawHelper(v);
  }
  /** A schedule line as the new hire reads it: "your buddy" becomes the
   *  buddy's name, and "with Mia" is added only when the title doesn't
   *  already say who. */
  function schedLine(t, p) {
    var title = p.buddy ? t.title.replace(/\b(your|the) buddy\b/gi, p.buddy) : t.title;
    var who = t.owner === 'hire' ? '' : ownerName(p, t.owner);
    var said = who && title.indexOf(who) >= 0;
    return esc(title) + (who && !said ? ' <span class="small muted">with ' + esc(who) + '</span>' : '');
  }
  function drawWelcome(v) {
    var p = v.plan, w = v.welcome;
    var mine = v.tasks;
    var day1 = v.schedule.filter(function (t) { return t.phase === 'day1'; });
    var week = v.schedule.filter(function (t) { return t.phase === 'week'; });
    var byDay = {};
    week.forEach(function (t) { (byDay[t.due] = byDay[t.due] || []).push(t); });
    var html = previewBar(v) +
      '<div class="welcome"><span class="wave" aria-hidden="true">👋</span><h1>Welcome, ' + esc(p.hire) + '!</h1>' +
      '<p class="lede">You start as <b>' + esc(p.role) + '</b>' + (p.business ? ' at <b>' + esc(p.business) + '</b>' : '') + ' on <b>' + esc(longStart(p)) + '</b>. Here’s everything for your first week.</p></div>' +
      '<div class="split"><div>' + clockCard(v) +
      '<div class="card"><h2>Your first day</h2><dl class="facts">' +
      (w.where ? '<div><span class="i" aria-hidden="true">📍</span><span><dt>Where</dt><dd>' + esc(w.where) + '</dd></span></div>' : (p.pattern === 'remote' ? '<div><span class="i" aria-hidden="true">💻</span><span><dt>Where</dt><dd>From home - the first call’s link comes from ' + esc(p.manager) + '</dd></span></div>' : '')) +
      '<div><span class="i" aria-hidden="true">🕘</span><span><dt>When</dt><dd>' + esc(C.fmtTime(p.arrive)) + ', ' + esc(longStart(p)) + '</dd></span></div>' +
      '<div><span class="i" aria-hidden="true">🙋</span><span><dt>Ask for</dt><dd>' + esc(w.ask || p.manager) + '</dd></span></div>' +
      (w.bring ? '<div><span class="i" aria-hidden="true">🎒</span><span><dt>Bring</dt><dd>' + esc(w.bring) + '</dd></span></div>' : '') +
      (p.buddy ? '<div><span class="i" aria-hidden="true">🤝</span><span><dt>Your buddy</dt><dd>' + esc(p.buddy) + ' - your go-to for any question, however small</dd></span></div>' : '') +
      '</dl>' + (w.message ? '<div class="letter"><p>' + esc(w.message) + '</p></div>' : '') + '</div>' +
      '<div class="card"><div class="row between"><h2 style="margin:0">Your to-dos</h2><span class="small muted">' + mine.filter(function (t) { return t.done; }).length + ' of ' + mine.length + ' done</span></div>' +
      (mine.length ? '<ul class="tasks" style="margin-top:10px">' + mine.map(function (t) { return taskRow(t, p, { canTick: true, tickAct: 'ltick', hideOwner: true }); }).join('') + '</ul>' : '<p class="muted">Nothing for you to do yet - just turn up.</p>') + '</div></div>' +
      '<div><div class="card"><div class="row between"><h2 style="margin:0">Your first week</h2><button class="btn small ghost" type="button" data-act="lics">📅 Add to calendar</button></div>' +
      (day1.length ? '<div class="daygrp"><h3>' + esc(longStart(p)) + ' · Day 1</h3><ol class="timeline">' + day1.map(function (t) {
        return '<li><span class="time">' + (t.time ? esc(C.fmtTime(t.time)) : '') + '</span><span>' + schedLine(t, p) + '</span></li>';
      }).join('') + '</ol></div>' : '') +
      Object.keys(byDay).sort().map(function (d) {
        return '<div class="daygrp"><h3>' + esc(C.longDay(d)) + '</h3><ul class="timeline dots">' + byDay[d].map(function (t) {
          return '<li><span class="time" aria-hidden="true">•</span><span>' + schedLine(t, p) + '</span></li>';
        }).join('') + '</ul></div>';
      }).join('') + '</div>' +
      (v.checkins.length ? '<div class="card"><h2>Check-ins</h2><p class="small muted">Three short questions so ' + esc(p.manager) + ' knows how it’s going. Only ' + esc(p.manager) + ' sees your answers.</p><ul class="list">' + v.checkins.map(function (k) {
        var btn = k.state === 'done' ? '<button class="btn small ghost" type="button" data-act="checkin" data-id="' + k.key + '">✓ Sent · edit</button>'
          : k.state === 'open' ? '<button class="btn small" type="button" data-act="checkin" data-id="' + k.key + '">Fill it in</button>'
            : (state.local ? '<button class="btn small ghost" type="button" data-act="checkin" data-id="' + k.key + '">Preview it</button>' : '<span class="chip">Opens ' + esc(C.dayLabel(k.due)) + '</span>');
        return '<li class="row between"><span><b>' + esc(k.label) + '</b> <span class="small muted">' + esc(C.dayLabel(k.due)) + '</span></span>' + btn + '</li>';
      }).join('') + '</ul></div>' : '') + '</div></div>' +
      '<p class="foot small muted center">Made with Firstday. This page shows first names and your plan only.</p>';
    main.innerHTML = html;
  }
  function drawHelper(v) {
    var p = v.plan;
    var role = v.role;
    var title = (role === 'buddy' ? ['You’re ', p.hire, '’s buddy'] : ['IT/admin for ', p.hire, '’s start']).join(''); // plain text, escaped where drawn
    var lede = role === 'buddy'
      ? [p.hire, ' starts as ', p.role, ' on ', longStart(p), ', arriving at ', C.fmtTime(p.arrive), '. Being a buddy means being the person they can ask anything - here’s what’s yours to do.'].join('')
      : [p.hire, ' starts as ', p.role, ' on ', longStart(p), '. Here’s what needs to be ready - tick each one off as you go, and ', p.manager, ' sees it.'].join('');
    var html = previewBar(v) + '<div class="welcome"><p class="eyebrow">' + esc(ROLE_TITLE[role]) + (p.business ? ' · ' + esc(p.business) : '') + '</p><h1>' + esc(title) + '</h1><p class="lede">' + esc(lede) + '</p></div>' +
      '<div class="split"><div>';
    var done = v.tasks.filter(function (t) { return t.done; }).length;
    html += '<div class="card"><div class="row between"><h2 style="margin:0">Your tasks</h2><span class="chip' + (done === v.tasks.length && v.tasks.length ? ' ok' : '') + '">' + done + ' of ' + v.tasks.length + ' done</span></div>';
    C.SECTIONS.forEach(function (s) {
      var list = v.tasks.filter(function (t) { return t.phase === s[0]; });
      if (!list.length) return;
      html += '<h3>' + esc(s[1]) + '</h3><ul class="tasks">' + list.map(function (t) { return taskRow(t, p, { canTick: true, tickAct: 'ltick', hideOwner: true }); }).join('') + '</ul>';
    });
    if (!v.tasks.length) html += '<p class="muted">Nothing for you on this plan yet.</p>';
    html += '</div></div><div>' + clockCard(v) + '<div class="card"><h2>Add them to your calendar</h2><p class="small muted">Each task on its day, with ' + esc(p.hire) + '’s start.</p><button class="btn ghost block" type="button" data-act="lics">📅 Add to calendar</button></div>' +
      '<div class="card"><h2>Who’s who</h2><div class="who">' + ownChip(p, 'hire') + ownChip(p, 'manager') + (p.buddy ? ownChip(p, 'buddy') : '') + '</div><p class="small muted" style="margin-top:10px">This link shows your tasks and first names only.</p></div></div></div>';
    main.innerHTML = html;
  }

  /* ---------------- the live countdown: worked out here, never polled ---------------- */

  function tickClock() {
    if (!state.cdAt) return;
    var ms = Math.max(0, state.cdAt - nowMs());
    var d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), mi = Math.floor((ms % 3600000) / 60000);
    var big = $('[data-clock="big"]');
    if (big) { $('[data-u="d"]', big).textContent = d; $('[data-u="h"]', big).textContent = h; $('[data-u="m"]', big).textContent = mi; }
    var small = $('[data-clock="short"]');
    if (small) small.textContent = clockText();
  }
  setInterval(tickClock, 20000);

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheet(html, after) {
    lastFocus = document.activeElement;
    var s = $('#sheet');
    s.innerHTML = '<div class="grab" aria-hidden="true"></div>';
    var inner = document.createElement('div');
    inner.className = 'sheet-in';
    inner.innerHTML = html;
    s.appendChild(inner);
    s.hidden = false; $('#sheetBack').hidden = false;
    document.body.classList.add('sheet-open');
    var h = $('h2', s);
    s.setAttribute('aria-label', h ? h.textContent : 'Dialog');
    if (after) after(inner);
    var f = $('[autofocus]', s) || $('.x', s) || s;
    try { f.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    state.tailor = null;
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  function head(title) { return '<div class="sheet-head"><h2>' + esc(title) + '</h2><button class="x" type="button" data-act="closesheet" aria-label="Close">×</button></div>'; }
  function pillPick(root, k, cb) {
    root.addEventListener('click', function (e) {
      var t = e.target.closest('[data-k="' + k + '"]');
      if (!t) return;
      $$('[data-k="' + k + '"]', root).forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); });
      if (cb) cb(t.getAttribute('data-v'));
    });
  }

  /* ---------- start a plan ---------- */

  function templateTiles(cur) {
    return '<div class="tpls" role="group" aria-label="Template">' + Object.keys(C.TEMPLATES).map(function (k) {
      var t = C.TEMPLATES[k];
      return '<button type="button" class="tpl" data-k="template" data-v="' + k + '" aria-pressed="' + (cur === k) + '"><span class="e" aria-hidden="true">' + t.emoji + '</span><b>' + esc(t.label) + '</b><span class="small muted">' + esc(t.blurb) + '</span></button>';
    }).join('') + '</div>';
  }
  /** `pre`: {template} from a tile, or {plan, tasks, title} to copy a plan. */
  function openStart(pre) {
    var o = pre || {};
    var p = o.plan || {};
    var f = { template: o.template || 'office', pattern: p.pattern || (o.template && C.TEMPLATES[o.template] ? C.TEMPLATES[o.template].pattern : 'onsite') };
    var L = C.LIMITS;
    var start = p.start || C.nextMonday(C.todayIn(LOCAL_ZONE, nowMs()));
    sheet(head(o.title || 'Start a plan') + '<form id="stForm">' +
      '<div class="two"><label class="field"><span>New hire’s first name</span><input class="input" name="hire" maxlength="' + L.name + '" required autofocus autocomplete="off" value="' + esc(o.tasks ? '' : (p.hire || '')) + '"></label>' +
      '<label class="field"><span>Role</span><input class="input" name="role" maxlength="' + L.role + '" required placeholder="e.g. Barista" value="' + esc(p.role || '') + '"></label></div>' +
      '<div class="two"><label class="field"><span>Start date</span><input class="input" type="date" name="start" required value="' + esc(start) + '"></label>' +
      '<label class="field"><span>Arrive at</span><input class="input" type="time" name="arrive" value="' + esc(p.arrive || '09:00') + '"></label></div>' +
      '<div class="two"><label class="field"><span>Manager (you)</span><input class="input" name="manager" maxlength="' + L.name + '" required value="' + esc(p.manager || '') + '"></label>' +
      '<label class="field"><span>Buddy</span><input class="input" name="buddy" maxlength="' + L.name + '" value="' + esc(p.buddy || '') + '"><span class="hint">A teammate they can ask anything.</span></label></div>' +
      '<label class="field"><span>Business</span><input class="input" name="business" maxlength="' + L.business + '" value="' + esc(p.business || '') + '" placeholder="e.g. Corner Cafe"></label>' +
      '<div class="field"><span class="lbl">Work pattern</span>' + patternPills(f.pattern) + '</div>' +
      (o.tasks ? '<p class="note small">Copies ' + esc(plural(o.tasks.length, 'task')) + ' - nothing ticked, no check-in answers.</p>' : '<div class="field"><span class="lbl">Template</span>' + templateTiles(f.template) + '</div>') +
      '<label class="field"><span>Time zone</span><select class="input" name="zone">' + zoneOptions(p.zone || LOCAL_ZONE) + '</select></label>' +
      '<div id="stErr"></div><button class="btn block" type="submit">Make the plan</button>' +
      '<p class="small muted">No account needed. This phone keeps the manager key; the links you send never open the plan itself. First names only - pay, bank and ID details are refused.</p></form>', function (root) {
      pillPick(root, 'template', function (v) { f.template = v; });
      pillPick(root, 'pattern', function (v) { f.pattern = v; });
      $('#stForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var t = e.target;
        var btn = $('button[type=submit]', t);
        btn.disabled = true;
        var body = { plan: { hire: t.hire.value, role: t.role.value, start: t.start.value, arrive: t.arrive.value, manager: t.manager.value, buddy: t.buddy.value, business: t.business.value, pattern: f.pattern, zone: t.zone.value, where: o.tasks ? (p.where || '') : '', ask: '', bring: o.tasks ? (p.bring || '') : '', workWeekends: Boolean(p.workWeekends), holidays: p.holidays || [] } };
        if (o.tasks) body.tasks = o.tasks; else body.template = f.template;
        api('POST', 'api/plans', body).then(function (d) {
          rememberPlan(d.code, d.key, planLabel(d.plan.plan));
          location.href = BASE + 'p/' + d.code;
        }).catch(function (err) { btn.disabled = false; showError(err, $('#stErr', root)); });
      });
    });
  }

  /* ---------- a task ---------- */

  var NEW_OFFSET = { before: -3, day1: 0, week: 1, later: 10 };
  function openTask(id, section) {
    var m = state.m, p = m.plan;
    var t = id ? m.tasks.filter(function (x) { return x.id === id; })[0] : null;
    if (id && !t) return;
    var f = { owner: t ? t.owner : 'manager' };
    var due = t ? t.due : C.dueOf(p, { offset: NEW_OFFSET[section] || 0, unit: 'bd' });
    sheet(head(t ? 'Edit task' : 'Add a task') + '<form id="tkForm">' +
      '<label class="field"><span>Task</span><input class="input" name="title" maxlength="' + C.LIMITS.title + '" required value="' + esc(t ? t.title : '') + '"' + (t ? '' : ' autofocus') + ' placeholder="e.g. Order the laptop"></label>' +
      '<div class="field"><span class="lbl">Owner</span><div class="pills" role="group" aria-label="Owner">' + C.OWNERS.map(function (o) {
        return '<button type="button" class="pill" data-k="owner" data-v="' + o + '" aria-pressed="' + (f.owner === o) + '">' + esc(o === 'it' ? 'IT/admin' : C.OWNER_LABEL[o] + ' (' + ownerName(p, o) + ')') + '</button>';
      }).join('') + '</div></div>' +
      '<div class="two"><label class="field"><span>Due</span><input class="input" type="date" name="due" required value="' + esc(due) + '"><span class="hint">Day 1 is ' + esc(C.dayLabel(p.start)) + '.</span></label>' +
      '<label class="field"><span>Time (day 1 only)</span><input class="input" type="time" name="time" value="' + esc(t && t.time ? t.time : '') + '"></label></div>' +
      '<div id="tkErr"></div><button class="btn block" type="submit">' + (t ? 'Save' : 'Add it') + '</button>' +
      (t ? '<div class="row" style="margin-top:10px"><button class="btn small ghost" type="button" data-act="movetask" data-id="' + esc(t.id) + '" data-dir="up">↑ Earlier</button><button class="btn small ghost" type="button" data-act="movetask" data-id="' + esc(t.id) + '" data-dir="down">↓ Later</button><button class="btn small ghost" type="button" data-act="deltask" data-id="' + esc(t.id) + '">Remove</button></div>' : '') +
      '</form>', function (root) {
      pillPick(root, 'owner', function (v) { f.owner = v; });
      $('#tkForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var fm = e.target;
        var d = C.cleanDate(fm.due.value);
        if (!d) { showError(new Error('Pick a date.'), $('#tkErr', root)); return; }
        var cd = t && t.unit === 'cd' && d > p.start && C.daysBetween(p.start, d) >= 5;
        var task = { title: fm.title.value, owner: f.owner, offset: cd ? C.daysBetween(p.start, d) : C.offsetFor(p, d), unit: cd ? 'cd' : 'bd', time: fm.time.value || null };
        var req = t ? manage('editTask', { id: t.id, task: task }) : manage('addTask', { task: task });
        req.then(function () { closeSheet(true); draw(); toast(t ? 'Saved.' : 'Added.'); }).catch(function (err) { showError(err, $('#tkErr', root)); });
      });
    });
  }

  function openTemplate() {
    var cur = state.m.template || 'office';
    var f = { template: cur };
    sheet(head('Change template') + '<p class="small muted">Replaces every task with the template’s, dated from ' + esc(C.dayLabel(state.m.plan.start)) + '. Ticks are cleared; check-in answers stay.</p>' + templateTiles(cur) +
      '<div id="tpErr"></div><button class="btn block" type="button" data-act="applytemplate" style="margin-top:12px">Use this template</button>', function (root) {
      pillPick(root, 'template', function (v) { f.template = v; state.pickTemplate = v; });
      state.pickTemplate = cur;
    });
  }

  /* ---------- the check-in (the new hire's) ---------- */

  function openCheckin(key) {
    var k = (state.lv.checkins || []).filter(function (x) { return x.key === key; })[0];
    if (!k) return;
    var a = k.answer || {};
    var f = { mood: a.mood || 0 };
    var p = state.lv.plan;
    sheet(head(k.label + ' check-in') + (k.state === 'upcoming' ? '<p class="note small">A preview - on a real link this opens on ' + esc(C.longDay(k.due)) + '.</p>' : '') +
      '<form id="ckForm"><div class="field"><span class="lbl">How’s it going?</span><div class="moods" role="group" aria-label="How it’s going">' + [1, 2, 3, 4, 5].map(function (n) {
        return '<button type="button" class="mood" data-k="mood" data-v="' + n + '" aria-pressed="' + (f.mood === n) + '"><span class="e" aria-hidden="true">' + C.MOOD_ICON[n] + '</span><span class="w">' + esc(C.MOODS[n]) + '</span></button>';
      }).join('') + '</div></div>' +
      '<label class="field"><span>What’s still unclear?</span><textarea class="input" name="unclear" rows="3" maxlength="' + C.LIMITS.answer + '" placeholder="Anything at all - a process, a tool, who to ask">' + esc(a.unclear || '') + '</textarea></label>' +
      '<label class="field"><span>What would help?</span><textarea class="input" name="help" rows="3" maxlength="' + C.LIMITS.answer + '" placeholder="More time with ' + esc(p.buddy || p.manager) + ', a checklist, a quieter shift…">' + esc(a.help || '') + '</textarea></label>' +
      '<div id="ckErr"></div><button class="btn block" type="submit">Send to ' + esc(p.manager) + '</button><p class="small muted center">Only ' + esc(p.manager) + ' sees this. Kept only as long as your plan.</p></form>', function (root) {
      pillPick(root, 'mood', function (v) { f.mood = Number(v); });
      $('#ckForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        linkAct('checkin', { key: key, mood: f.mood, unclear: e.target.unclear.value, help: e.target.help.value }).then(function () {
          closeSheet(true); draw(); toast(['Sent - thank you. ', p.manager, ' will see it.'].join('')); // textContent, not markup
        }).catch(function (err) { showError(err, $('#ckErr', root)); });
      });
    });
  }

  /* ---------- "Tailor it to us" (the one model call) ---------- */

  function openTailor() {
    if (!signedIn()) {
      sheet(head('Tailor it to us') + '<p>Describe the role and your business in a few lines - the tools, the shifts, what “good” looks like - and AI writes a first-week plan in the same shape, for you to check before anything changes.</p><p class="muted">It needs a free account (it uses AI credit, and a free account comes with $2 of it). The templates, the links, the meter and the check-ins all stay free with no account.</p>' +
        '<div class="row"><button class="btn" type="button" data-act="signup">Create a free account</button><button class="btn ghost" type="button" data-act="signin">Sign in</button></div>');
      return;
    }
    state.tailor = state.tailor || { about: '', busy: false, proposal: null };
    sheet('<div class="body"></div>', function (root) { drawTailor(root); });
  }
  function drawTailor(root) {
    var t = state.tailor;
    var b = $('.body', root);
    var p = state.m.plan;
    if (t.proposal) {
      var pr = t.proposal;
      b.innerHTML = head('Check before using it') + (pr.summary ? '<div class="psum">' + esc(pr.summary) + '</div>' : '') +
        '<p class="small muted">' + esc(plural(pr.tasks.length, 'task')) + (pr.dropped ? ' · ' + esc(plural(pr.dropped, 'suggestion')) + ' left out (they didn’t fit the rules)' : '') + '. Using it replaces the tasks on this plan; ticks are cleared.</p>' +
        C.SECTIONS.map(function (s) {
          var list = pr.tasks.filter(function (x) { return C.phaseOf(x) === s[0]; });
          if (!list.length) return '';
          return '<h3>' + esc(s[1]) + '</h3><ul class="proposal">' + list.map(function (x) {
            return '<li><span>' + (x.time ? '<span class="time">' + esc(C.fmtTime(x.time)) + '</span> ' : '') + esc(x.title) + '</span>' + ownChip(p, x.owner) + '</li>';
          }).join('') + '</ul>';
        }).join('') +
        '<div id="taErr"></div><div class="row"><button class="btn" type="button" data-act="usetailor">Use this plan</button><button class="btn ghost" type="button" data-act="tailorback">Change the description</button></div>';
      return;
    }
    b.innerHTML = head('Tailor it to us') + '<p class="small muted">A few lines about the role and the business. Only this text, the role and the work pattern are sent - no names. Nothing changes until you tap “Use this plan”.</p>' +
      '<form id="taForm"><label class="field"><span>The role and the business</span><textarea class="input" name="about" rows="6" maxlength="' + C.LIMITS.about + '" autofocus placeholder="e.g. A 12-person bike shop. They’ll do repairs on the workshop floor and cover the till on Saturdays. We use Lightspeed for the till and a paper job board.">' + esc(t.about) + '</textarea></label>' +
      '<div id="taErr"></div><button class="btn block" type="submit"' + (t.busy ? ' disabled' : '') + '>' + (t.busy ? 'Writing the plan…' : '✨ Tailor it') + '</button>' +
      '<p class="small muted center">' + (t.busy ? 'Usually under a minute.' : 'A cent or two of AI credit.') + '</p></form>';
    $('textarea', b).addEventListener('input', function (e) { t.about = e.target.value; });
    $('#taForm', b).addEventListener('submit', function (e) {
      e.preventDefault();
      t.busy = true; drawTailor(root);
      api('POST', 'api/tailor', { about: t.about, role: p.role, pattern: p.pattern, template: state.m.template || 'office' }).then(function (d) {
        t.busy = false; t.proposal = d.proposal;
        if (state.tailor === t) drawTailor(root);
      }).catch(function (err) {
        t.busy = false;
        if (state.tailor !== t) return;
        drawTailor(root);
        var where = $('#taErr', root);
        if (err.status === 401) return openAccount();
        if (err.status === 402) return openCredit(err.data);
        if (err.data && err.data.code === 'verify-email') return verifyNote(where, err);
        showError(err, where);
      });
    });
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. The templates work meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).addEventListener('click', function () {
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { toast('Sent - check your email.'); }, function () { toast('Could not send it. Try again in a minute.'); });
    });
  }

  /* ---------- the account ---------- */

  var FREE_LINE = 'Firstday works without an account - templates, the meter, the links and check-ins. A free account adds “Tailor it to us” with $2 of AI credit. One account works across every app on this site.';
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
          .then(function () { closeSheet(); toast('You’re in.'); return loadMe(); }).then(function () { if (then) then(); else draw(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { if (then) then(); else draw(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(head('Account') + '<p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row between"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">“Tailor it to us” costs a cent or two. Everything else in Firstday is free.</p><div id="billing"></div></div>' +
      '<p class="small muted">Your plans are kept by their links and this phone’s manager key, not by your account.</p>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); draw(); });
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
  function checkout(path, body) {
    body.returnTo = BASE;
    api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); });
  }
  function openCredit(data) {
    sheet(head('Out of AI credit') + '<p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Everything else in Firstday keeps working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });

  /* ---------------- loading ---------------- */

  function startSample(fresh) {
    var s = fresh ? null : recall(K_SAMPLE);
    if (s && s.plan && Array.isArray(s.tasks) && C.cleanDate(s.plan.start)) state.doc = s;
    else state.doc = C.sample(C.todayIn(LOCAL_ZONE, nowMs()), LOCAL_ZONE, nowMs());
    state.local = true; state.code = null; state.key = null; state.links = null; state.tab = 'plan'; state.preview = null; state.lv = null; state.meterSeen = false;
    saveSample(); refreshLocal();
    go('manager');
  }
  function loadPlan(quiet) {
    var since = quiet && state.m ? '?since=' + state.m.v : '';
    return api('GET', 'api/plans/' + state.code + since, null, { 'X-Firstday-Key': state.key }).then(function (d) {
      if (d.same) return;
      state.m = d.plan; state.links = d.links; state.view = 'manager';
      rememberPlan(state.code, state.key, planLabel(d.plan.plan));
      if (!quiet || $('#sheet').hidden) draw();
    }).catch(function (err) {
      if (quiet) return;
      if (err.status === 404) forgetPlan(state.code);
      state.err = err.status === 404 ? 'This plan opens as manager only on the phone that made it (or from its manager link) - or it has been deleted.' : err.message;
      state.lv = null; state.view = 'link'; draw();
    });
  }
  function loadLink(quiet) {
    var since = quiet && state.lv ? '?since=' + state.lv.v : '';
    return api('GET', 'api/l/' + state.code + since).then(function (d) {
      if (d.same) return;
      state.lv = d.plan; state.view = 'link';
      if (!quiet || $('#sheet').hidden) draw();
    }).catch(function (err) {
      if (quiet) return;
      state.err = err.message; state.lv = null; state.view = 'link'; draw();
    });
  }
  function refresh(quiet) { if (!ROUTE || state.local) return Promise.resolve(); return ROUTE.kind === 'p' ? loadPlan(quiet) : loadLink(quiet); }

  /* ---------------- one click listener ---------------- */

  function managerIcs() {
    var m = state.m;
    download('first-weeks-' + C.fold(m.plan.hire).replace(/ /g, '-') + '.ics', C.buildIcs({ plan: m.plan, tasks: m.tasks }, 'manager', nowMs()), 'text/calendar;charset=utf-8');
  }
  function goHome() {
    if (ROUTE) { location.href = BASE; return; }
    state.local = false; state.doc = null; state.m = null; state.preview = null; state.lv = null; state.cdAt = null; go('home');
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var a = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    if (['delplan', 'deltask', 'resetsample', 'relink'].indexOf(a) < 0) state.armed = null;
    var arm = function (key, label) { if (state.armed !== key) { state.armed = key; t.textContent = label; return false; } return true; };
    switch (a) {
      case 'home': if (t.tagName === 'A') e.preventDefault(); goHome(); break;
      case 'closesheet': closeSheet(); break;
      case 'sample': startSample(true); break;
      case 'resume': startSample(false); break;
      case 'start': openStart(id ? { template: id } : null); break;
      case 'realfromsample': openStart({ title: 'Use this plan for a real hire', plan: { role: state.m.plan.role, business: '', pattern: state.m.plan.pattern, arrive: state.m.plan.arrive }, tasks: C.copyTasks({ tasks: state.m.tasks }) }); break;
      case 'tab': state.tab = id; draw(); break;
      case 'tick': {
        var tk = state.m.tasks.filter(function (x) { return x.id === id; })[0];
        if (!tk) break;
        manage('tick', { id: id, done: !tk.done }).then(function () { draw(); say(tk.done ? 'Marked not done.' : 'Done: ' + tk.title); var el = $('[data-act="tick"][data-id="' + id + '"]'); if (el) el.focus({ preventScroll: true }); }).catch(function (err) { showError(err); });
        break;
      }
      case 'edittask': openTask(id); break;
      case 'addtask': openTask(null, id); break;
      case 'movetask': manage('moveTask', { id: id, dir: t.getAttribute('data-dir') }).then(function (r) { closeSheet(true); draw(); toast(r.moved === false ? 'It’s already at that end.' : 'Moved.'); }).catch(function (err) { showError(err); }); break;
      case 'deltask': if (!arm('deltask', 'Tap again to remove it')) break; manage('removeTask', { id: id }).then(function () { closeSheet(true); draw(); toast('Removed.'); }).catch(function (err) { showError(err); }); break;
      case 'template': openTemplate(); break;
      case 'applytemplate': manage('template', { template: state.pickTemplate }).then(function () { closeSheet(true); draw(); toast('Template applied.'); }).catch(function (err) { showError(err, $('#tpErr')); }); break;
      case 'mics': managerIcs(); break;
      case 'tailor': openTailor(); break;
      case 'tailorback': if (state.tailor) { state.tailor.proposal = null; drawTailor($('#sheet .sheet-in')); } break;
      case 'usetailor': if (state.tailor && state.tailor.proposal) manage('replaceTasks', { tasks: state.tailor.proposal.tasks }).then(function (r) { closeSheet(true); state.tab = 'plan'; draw(); toast('Using the tailored plan: ' + plural(r.count || 0, 'task') + '.'); }).catch(function (err) { showError(err, $('#taErr')); }); break;
      case 'signup': openAccount(null, function () { draw(); openTailor(); }); break;
      case 'signin': openAccount(null, function () { draw(); openTailor(); }, true); break;
      case 'addhol': {
        var v = C.cleanDate($('#holIn').value);
        if (!v) { toast('Pick a date first.'); break; }
        manage('holidays', { holidays: state.m.plan.holidays.concat([v]) }).then(function () { draw(); toast('Added - due dates skip it.'); }).catch(function (err) { showError(err); });
        break;
      }
      case 'delhol': manage('holidays', { holidays: state.m.plan.holidays.filter(function (d) { return d !== id; }) }).then(function () { draw(); }).catch(function (err) { showError(err); }); break;
      case 'copynext': openStart({ title: 'Copy for the next hire', plan: { role: state.m.plan.role, business: state.m.plan.business, manager: state.m.plan.manager, buddy: '', pattern: state.m.plan.pattern, zone: state.m.plan.zone, arrive: state.m.plan.arrive, where: state.m.plan.where, bring: state.m.plan.bring, workWeekends: state.m.plan.workWeekends, holidays: state.m.plan.holidays }, tasks: C.copyTasks({ tasks: state.m.tasks }) }); break;
      case 'resetsample': if (!arm('resetsample', 'Tap again to start over')) break; startSample(true); break;
      case 'delplan': if (!arm('delplan', 'Tap again to delete it for everyone')) break; api('DELETE', 'api/plans/' + state.code, null, { 'X-Firstday-Key': state.key }).then(function () { forgetPlan(state.code); location.href = BASE; }).catch(function (err) { showError(err); }); break;
      case 'sharelink': share('Your first week', C.ROLES.indexOf(id) >= 0 ? (id === 'hire' ? 'Everything for your first week' : ['Your tasks for ', state.m.plan.hire, '’s first week'].join('')) : '', linkUrl(state.links[id])); break;
      case 'copylink': copy(linkUrl(state.links[id]), 'Link copied'); break;
      case 'relink': if (!arm('relink:' + id, 'Tap again - the old link stops working')) break; manage('relink', { role: id }).then(function () { draw(); toast('New link made. The old one no longer works.'); }).catch(function (err) { showError(err); }); break;
      case 'mgrlink': copy(location.origin + BASE + 'p/' + state.code + '#k=' + state.key, 'Manager link copied - keep it to yourself'); break;
      case 'preview':
        if (state.local) { state.preview = id; state.lv = C.roleView(state.doc, id, nowMs()); go('link'); }
        else window.open(linkUrl(state.links[id]), '_blank', 'noopener');
        break;
      case 'endpreview': state.preview = null; state.lv = null; state.tab = 'links'; refreshLocal(); go('manager'); break;
      case 'ltick': {
        var lt = state.lv.tasks.filter(function (x) { return x.id === id; })[0];
        if (!lt) break;
        linkAct('tick', { id: id, done: !lt.done }).then(function () { draw(); say(lt.done ? 'Marked not done.' : 'Done: ' + lt.title); }).catch(function (err) { showError(err); });
        break;
      }
      case 'checkin': openCheckin(id); break;
      case 'lics':
        if (state.local) download(state.preview === 'hire' ? 'my-first-week.ics' : 'first-week-tasks.ics', C.buildIcs(state.doc, state.preview, nowMs()), 'text/calendar;charset=utf-8');
        else location.href = BASE + 'api/l/' + state.code + '/calendar.ics';
        break;
      default: break;
    }
  });

  /* ---------------- start ---------------- */

  if (ROUTE) {
    state.code = ROUTE.code;
    main.innerHTML = '<p class="muted">Loading…</p>';
    if (ROUTE.kind === 'p') {
      // A manager link for another device carries the key after #, which a
      // browser never sends to the server; keep it here and drop it from
      // the address bar.
      var hk = /^#k=([A-Za-z0-9_-]{22})$/.exec(location.hash);
      if (hk) { rememberPlan(state.code, hk[1], 'Plan'); try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ } }
      state.key = keyFor(state.code);
      if (!state.key) { state.err = 'This plan opens as manager only on the phone that made it, or from its manager link.'; state.view = 'link'; draw(); }
      else loadPlan(false);
    } else loadLink(false);
    setInterval(function () { if (document.visibilityState === 'visible' && $('#sheet').hidden && state.view !== 'home') refresh(true); }, 30000);
    loadMe();
  } else {
    draw();
    loadMe().then(function () { if (state.view === 'home') drawHome(); });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { tickClock(); if ($('#sheet').hidden) refresh(true); }
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* no offline copy, still works online */ });
  }
}());
