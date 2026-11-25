/* Arrivals - the page. One file, no build step.
 *
 * The rules (time zones, the board, who needs a ride, clashes, runs that
 * could be one) are ArrivalsCore's; what this phone remembers goes through
 * arrivals-store.js (localStorage, with a memory fallback). The made-up
 * example is changed by the same rules, in memory, and is never kept or sent.
 *
 * The requests this page makes: a gathering (start, join with a code and a
 * first name, every change through one route, poll every 5 seconds while
 * the page is visible and a gathering is on screen, leave, remove, delete),
 * sign-in, the account's list of kept gatherings, and - signed in, when
 * the person asks - one read of a booking confirmation into a draft. No
 * location, no contacts, no flight-status feed: people say where they are.
 *
 * Every string a person typed or the server sent is escaped before it is
 * drawn, no handler is written into markup (clicks are routed by data-act
 * from one listener - the lab's CSP allows script from this origin only),
 * and no style attribute is written.
 */
(function () {
  'use strict';

  var C = window.ArrivalsCore;
  var D = window.ArrivalsDemo;
  var S = window.ArrivalsStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var POLL_MS = 5000;
  var TABS = ['board', 'pickups', 'group'];

  var real = S.local();
  var state = {
    me: null, view: 'home', g: null, demo: null,
    list: real.getList(), prefs: real.getPrefs(),
    offline: false, seenAt: 0, briefDay: '', openTrip: null, fresh: null,
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
    if (err instanceof TypeError) msg = 'You look offline. Try again when you have a signal.';
    if (where) { where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>'; } else toast(msg, 4500);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function now() { return state.demo ? D.NOW : Date.now(); }
  function phoneZone() { try { var z = Intl.DateTimeFormat().resolvedOptions().timeZone; return C.isZone(z) ? z : 'America/Chicago'; } catch (e) { return 'America/Chicago'; } }
  function savePrefs() { real.putPrefs(state.prefs); }
  function remember(g) {
    if (state.demo || !g) return;
    state.list = [{ id: g.id, title: g.title, place: g.place, from: g.from, to: g.to }].concat(state.list.filter(function (x) { return x.id !== g.id; }));
    real.putList(state.list); state.list = real.getList();
  }
  function forgetLocal(id) {
    state.list = state.list.filter(function (x) { return x.id !== id; }); real.putList(state.list);
    if (state.prefs.cur === id) { state.prefs.cur = ''; savePrefs(); }
  }
  function memberName(mid) { var m = C.memberOf(state.g, mid); return m ? m.name : ''; }
  function tripById(id) { var t = null; state.g.trips.forEach(function (x) { if (x.id === id) t = x; }); return t; }

  /* ---------------- the gathering on screen ---------------- */

  var pollTimer = null;
  function wantPoll() { return Boolean(state.g && !state.demo && document.visibilityState === 'visible' && TABS.indexOf(state.view) >= 0); }
  function schedulePoll(ms) { clearTimeout(pollTimer); if (wantPoll()) pollTimer = setTimeout(poll, ms === undefined ? POLL_MS : ms); }
  function poll() {
    if (!wantPoll()) return;
    var id = state.g.id;
    api('GET', 'api/g/' + encodeURIComponent(id) + '?since=' + state.g.v).then(function (r) {
      if (!state.g || state.g.id !== id) return;
      var was = state.offline; state.offline = false; state.seenAt = Date.now();
      if (r.g) { adopt(r.g); drawSoft(); } else if (was) drawSoft();
      schedulePoll();
    }).catch(function (err) {
      if (err && err.status === 404) { gone(id); return; }
      if (!state.offline) { state.offline = true; drawSoft(); }
      schedulePoll(POLL_MS * 2);
    });
  }
  function adopt(g) { state.g = g; remember(g); }
  function gone(id) {
    forgetLocal(id); state.g = null; closeSheet(true);
    toast('That gathering isn’t here any more.', 5000); go('home');
  }
  function enter(id, tab) {
    return api('GET', 'api/g/' + encodeURIComponent(id)).then(function (r) {
      state.demo = null; adopt(r.g); state.prefs.cur = id; savePrefs(); state.seenAt = Date.now(); state.offline = false;
      if (signedIn() && state.me.keep) api('POST', 'api/g/' + encodeURIComponent(id) + '/keep').catch(function () { /* the phone still has it */ });
      go(tab || state.prefs.tab || 'board');
    }).catch(function (err) {
      if (err && err.status === 404) { forgetLocal(id); toast(err.message, 5000); go('home'); return; }
      showError(err);
    });
  }
  /** One door for every change. In the example it runs the same rules here. */
  function act(action, done) {
    if (state.demo) {
      try {
        var id = 't' + String(Object.keys(state.demo.trips).length + 1) + 'demo' + String(state.demo.v);
        state.demo = C.patch(state.demo, C.act(state.demo, D.ME, action, { now: D.NOW, id: id, today: '2026-11-25' }));
        state.g = C.view(state.demo, D.ME);
        if (done) done({ id: id });
        afterChange();
      } catch (e) { showError(e, $('#formErr')); }
      return;
    }
    api('POST', 'api/g/' + encodeURIComponent(state.g.id) + '/act', { action: action }).then(function (r) {
      adopt(r.g); if (done) done(r); afterChange(); schedulePoll();
    }).catch(function (err) {
      if (err && err.status === 404 && err.data && err.data.code === 'gone') { gone(state.g.id); return; }
      showError(err, $('#formErr'));
    });
  }
  function afterChange() {
    drawSoft();
    if (state.openTrip && !$('#sheet').hidden) { if (tripById(state.openTrip)) tripSheet(state.openTrip, true); else closeSheet(); }
  }

  /* ---------------- routing and drawing ---------------- */

  function go(view) { history.pushState(null, '', BASE + '#' + view); route(); scrollTo(0, 0); }
  function route() {
    var h = location.hash.replace(/^#/, '');
    var join = /^join=([A-Za-z0-9-]{4,12})$/.exec(h);
    if (join) { history.replaceState(null, '', BASE + '#home'); state.view = 'home'; draw(); joinSheet(C.normalizeCode(join[1])); return; }
    if (h === 'try') { startDemo(); return; }
    if (TABS.indexOf(h) >= 0 && state.g) { state.view = h; if (!state.demo) { state.prefs.tab = h; savePrefs(); } }
    else state.view = 'home';
    draw(); schedulePoll();
  }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }
  function drawSoft() { keepPlace(draw); }
  function draw() {
    var inG = TABS.indexOf(state.view) >= 0 && state.g;
    $('#tabbar').hidden = !inG; $('#topnav').hidden = !inG;
    var open = inG ? C.issues(state.g, now()).length : 0;
    $$('[data-tab]').forEach(function (b) {
      if (b.dataset.tab === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      var old = $('.badge', b); if (old) old.remove();
      if (b.dataset.tab === 'pickups' && open && b.parentNode.id === 'tabbar') b.insertAdjacentHTML('beforeend', '<i class="badge" aria-label="' + open + ' to sort out">' + open + '</i>');
    });
    var m = $('#main');
    m.className = 'wrap' + (state.view === 'home' || state.view === 'group' ? ' narrow' : '');
    m.innerHTML = state.view === 'board' ? boardHtml() : state.view === 'pickups' ? pickupsHtml() : state.view === 'group' ? groupHtml() : homeHtml();
    document.title = (inG ? state.g.title + ' · ' : '') + 'Arrivals';
    state.fresh = null;
  }
  function ribbon() {
    if (state.demo) return '<p class="ribbon">' + esc(D.NOTICE) + ' <button class="link-btn" type="button" data-act="leavedemo">Leave the example</button></p>';
    if (state.offline) return '<p class="ribbon" role="status">You’re offline - this is the board as of ' + esc(C.clockAt(state.seenAt, phoneZone())) + '. Changes need the network.</p>';
    return '';
  }
  function dot(m) { return '<span class="dot c' + (m.c % C.COLORS.length) + '" aria-hidden="true">' + esc(C.initials(m.name)) + '</span>'; }

  /* ---------------- home ---------------- */

  function homeHtml() {
    var list = state.list.map(function (g) {
      return '<li><button class="item" type="button" data-act="open" data-id="' + esc(g.id) + '"><span class="grow"><span class="t">' + esc(g.title) + '</span><br><span class="s">' + esc(g.place) + (g.from ? ' · ' + esc(C.dateRange(g.from, g.to || g.from)) : '') + '</span></span><span class="tag">Open</span></button></li>';
    }).join('');
    return '<section class="hero"><h1>Who lands when, and who’s picking them up.</h1>' +
      '<p class="lede">One arrivals board for the whole family, on every phone. Flights, trains and long drives, who is delayed, who still needs a ride - without the group chat.</p>' +
      '<div class="btn-row"><button class="btn" type="button" data-act="start">Start a gathering</button><button class="btn ghost" type="button" data-act="join">Join with a code</button></div>' +
      '<p class="mt16 mb0"><button class="link-btn" type="button" data-act="demo">See a made-up family’s board</button></p></section>' +
      (list ? '<section class="section"><div class="section-title"><h2>Your gatherings</h2></div><ul class="list">' + list + '</ul></section>' : '') +
      '<section class="section"><h2>How it works</h2><ol class="steps">' +
      '<li><span class="n">1</span><span><b>Name the gathering</b> - “Mom’s house”, the dates. No account.</span></li>' +
      '<li><span class="n">2</span><span><b>Share one link.</b> Everyone adds their own flight, train or drive - or one person adds them all.</span></li>' +
      '<li><span class="n">3</span><span><b>Watch the board.</b> One tap says “on the way”, “delayed 40 min”, “landed”, “here”.</span></li>' +
      '<li><span class="n">4</span><span><b>Sort the pickups.</b> Claim a run, see who still needs a ride and which pickups could be one trip.</span></li></ol></section>' +
      '<section class="section"><p class="small muted">Free, with no sign-in. Arrivals keeps first names and travel details - never a phone number or an email address from anyone in the family. Whoever started a gathering can delete it, and it is deleted by itself two weeks after its last day. There is no flight tracker behind this: the times are what your family typed.</p></section>';
  }

  /* ---------------- the board ---------------- */

  function rowHtml(r, acts) {
    var t = r.t, cl = r.clock.split(' ');
    var l2 = [C.tripLine(t), t.hub].filter(Boolean).join(' · ');
    var x = C.extras(t);
    var chip = r.due ? '<span class="chip s-due">Due - no update</span>' : '<span class="chip s-' + r.state + '">' + esc(r.label) + '</span>';
    var near = !C.done(t) && C.expected(t) - now() < 18 * 3600000 && now() - C.expected(t) < 12 * 3600000;
    return '<li class="trow' + (C.done(t) ? ' done' : '') + (state.fresh === t.id ? ' fresh' : '') + '">' +
      '<button class="trow-main" type="button" data-act="trip" data-id="' + esc(t.id) + '">' +
      '<span class="tm"><b>' + esc(cl[0]) + '</b><small>' + esc(cl[1]) + '</small>' + (r.was ? '<s><span class="vh">was </span>' + esc(r.was) + '</s>' : '') + '</span>' +
      '<span class="tb"><span class="who">' + esc(t.who) + '</span><span class="l2">' + esc(l2) + (x ? ' · ' + esc(x) : '') + (r.there ? ' · ' + esc(r.there) + ' there' : '') + '</span>' +
      '<span class="l3 r-' + r.ride.k + '">' + esc(r.ride.text) + '</span></span>' + chip + '</button>' +
      (acts && near && r.next ? '<div class="trow-acts"><button class="btn small quiet" type="button" data-act="step" data-id="' + esc(t.id) + '" data-status="' + r.next.status + '">' + esc(r.next.label) + '</button>' +
        (t.status !== 'landed' ? '<button class="btn small ghost" type="button" data-act="late" data-id="' + esc(t.id) + '">Late +20</button>' : '') + '</div>' : '') + '</li>';
  }
  function daysHtml(groups, b) {
    return groups.map(function (g) {
      var same = g.label === C.dayLong(g.day);
      return '<div class="day-h"><h2>' + esc(g.label) + '</h2>' + (same ? '' : '<span>' + esc(C.dayLong(g.day)) + '</span>') + '</div><ul>' + g.rows.map(function (r) { return rowHtml(r, true); }).join('') + '</ul>';
    }).join('');
  }
  function headHtml(extra) {
    var g = state.g;
    return ribbon() + '<div class="g-head"><h1>' + esc(g.title) + '</h1><p class="sub">' + esc(g.place === g.title ? '' : g.place + ' · ') + esc(C.dateRange(g.from, g.to)) + (extra ? ' · ' + esc(extra) : '') + '</p></div>';
  }
  function boardHtml() {
    var g = state.g, b = C.board(g, now()), c = b.counts;
    var away = C.offsetMin(now(), phoneZone()) !== C.offsetMin(now(), g.tz);
    var open = C.issues(g, now());
    var html = headHtml('') +
      '<div class="counts"><div><b>' + c.coming + '</b><span>coming</span></div><div><b>' + c.here + '</b><span>here</span></div>' +
      (c.delayed ? '<div class="w"><b>' + c.delayed + '</b><span>delayed</span></div>' : '') +
      (c.noRide ? '<div class="w"><b>' + c.noRide + '</b><span>' + (c.noRide === 1 ? 'needs' : 'need') + ' a ride</span></div>' : '') + '</div>' +
      '<div class="addbar"><button class="btn" type="button" data-act="add">Add an arrival</button><button class="btn ghost" type="button" data-act="invite">Invite</button></div>';
    if (open.length) html += '<div class="card warn mt24"><b>' + plural(open.length, 'thing') + ' to sort out.</b> ' + esc(C.issueText(g, open[0])) + ' <button class="link-btn" type="button" data-act="tab" data-tab="pickups">See pickups</button></div>';
    if (!g.trips.length) return html + '<p class="empty">Nobody is on the board yet. Add your own arrival, then send the link - everyone adds theirs.</p>';
    html += '<p class="small muted mt24 mb0">All times are ' + esc(b.zone) + (away ? ' - where ' + esc(g.place) + ' is, not where this phone is' : '') + '.</p>';
    html += daysHtml(b.days, b);
    if (b.out.length) html += '<div class="section"><div class="section-title"><h2>Heading home</h2><span class="small muted">leaving times</span></div>' + daysHtml(b.out, b) + '</div>';
    return html;
  }

  /* ---------------- pickups ---------------- */

  function runHtml(r) {
    return '<li class="run"><span class="tm"><b>' + esc(r.clock) + '</b><small>' + esc(C.dayLabel(r.day, C.zoneDay(now(), state.g.tz))) + '</small></span><span><span class="who">' + esc(r.hub || 'Pickup') + '</span>' +
      '<span class="small muted"> · ' + plural(r.people, 'person', 'people') + (r.bags ? ' · ' + plural(r.bags, 'bag') : '') + (r.seat ? ' · car seat' : '') + '</span><ul>' +
      r.trips.map(function (t) { return '<li><button class="link-btn" type="button" data-act="trip" data-id="' + esc(t.id) + '">' + esc(t.who) + '</button> <span class="muted">' + (t.dir === 'out' ? 'drop off for ' : '') + esc(C.tripLine(t)) + (t.note ? ' · ' + esc(t.note) : '') + '</span></li>'; }).join('') + '</ul></span></li>';
  }
  function pickupsHtml() {
    var g = state.g, n = now(), html = headHtml('Pickups');
    var open = C.issues(g, n), combos = C.combos(g, n);
    var clashes = open.filter(function (i) { return i.kind !== 'noride'; }), need = open.filter(function (i) { return i.kind === 'noride'; });
    clashes.forEach(function (i) { html += '<div class="card warn mt16"><b>' + (i.kind === 'clash' ? 'Clash.' : 'Two places, one hour.') + '</b> ' + esc(C.issueText(g, i)) + '</div>'; });
    html += '<section class="section"><div class="section-title"><h2>Needs a ride</h2><span class="small muted">' + (need.length ? need.length + ' open' : '') + '</span></div>';
    if (!need.length) html += '<p class="muted">Everyone who needs a ride has one.</p>';
    else html += '<ul class="list">' + need.map(function (i) {
      var t = i.a;
      return '<li class="need"><span class="grow"><b>' + esc(t.who) + '</b><br><span class="small muted">' + esc(C.clockAt(C.meetAt(t), g.tz)) + ' ' + esc(C.dayLabel(C.zoneDay(C.meetAt(t), g.tz), C.zoneDay(n, g.tz))) + ' · ' + esc(t.hub || C.MODES[t.mode].label) + (t.dir === 'out' ? ' · drop-off' : '') + (C.extras(t) ? ' · ' + esc(C.extras(t)) : '') + '</span></span>' +
        '<button class="btn small" type="button" data-act="claim" data-id="' + esc(t.id) + '">' + (t.dir === 'out' ? 'I’ll drive them' : 'I’ll get them') + '</button></li>';
    }).join('') + '</ul>';
    html += '</section>';
    if (combos.length) {
      html += '<section class="section"><div class="section-title"><h2>Could be one run</h2></div>' + combos.map(function (c) {
        var d = c.driver ? C.memberOf(g, c.driver) : null, ids = c.trips.map(function (t) { return t.id; }).join(',');
        return '<div class="card"><p>' + esc(C.comboText(g, c, C.zoneDay(n, g.tz))) + '</p><div class="btn-row"><button class="btn small" type="button" data-act="combine" data-ids="' + esc(ids) + '" data-mid="' + esc(d && !d.me ? d.id : '') + '">' + esc(d && !d.me ? d.name + ' takes ' + (c.trips.length === 2 ? 'both' : 'them all') : 'I’ll take ' + (c.trips.length === 2 ? 'both' : 'them all')) + '</button></div></div>';
      }).join('') + '</section>';
    }
    var mine = C.runs(g, g.me, n), others = C.drivers(g, n).filter(function (d) { return !d.m.me; });
    html += '<section class="section"><div class="section-title"><h2>Your runs</h2></div>' + (mine.length ? '<ul class="list">' + mine.map(runHtml).join('') + '</ul>' : '<p class="muted">You’re not down to drive anyone. Tap “I’ll get them” on a ride above and it lands here.</p>') + '</section>';
    others.forEach(function (d) { html += '<section class="section"><div class="section-title"><h2>' + esc(d.m.name) + '’s runs</h2></div><ul class="list">' + d.runs.map(runHtml).join('') + '</ul></section>'; });
    html += '<p class="small muted mt24">A run is rides at the same place within ' + C.COMBINE_MIN + ' minutes. For a trip home, the time is when to be there: ' + C.MODES.flight.lead + ' minutes before a flight, ' + C.MODES.train.lead + ' before a train or bus.</p>';
    return html;
  }

  /* ---------------- the group ---------------- */

  function briefDays() {
    var g = state.g, days = {}, out = [];
    g.trips.forEach(function (t) { days[C.zoneDay(C.expected(t), g.tz)] = 1; });
    Object.keys(days).sort().forEach(function (d) { out.push(d); });
    return out;
  }
  function groupHtml() {
    var g = state.g, today = C.zoneDay(now(), g.tz), days = briefDays();
    var day = days.indexOf(state.briefDay) >= 0 ? state.briefDay : (days.indexOf(C.addDays(today, 1)) >= 0 ? C.addDays(today, 1) : days.indexOf(today) >= 0 ? today : days[0]);
    var live = g.members.filter(function (m) { return !m.left; });
    var html = headHtml('Group') +
      '<section class="section"><h2>Invite the family</h2><p class="muted">Anyone with the link or the code joins with a first name - no account, no app to install.</p>' +
      '<p class="code" aria-label="The code">' + esc(C.formatCode(g.code)) + '</p><div class="btn-row"><button class="btn" type="button" data-act="share">Send the link</button><button class="btn ghost" type="button" data-act="copycode">Copy the link</button></div></section>' +
      '<section class="section"><div class="section-title"><h2>People</h2><span class="small muted">' + live.length + ' in</span></div><ul class="list">' + live.map(function (m) {
        return '<li class="item">' + dot(m) + '<span class="grow"><span class="t">' + esc(m.name) + (m.me ? ' <span class="tag">you</span>' : '') + '</span>' + (m.host ? '<br><span class="s">Started this gathering</span>' : '') + '</span>' +
          (g.host && !m.me ? '<button class="btn small ghost" type="button" data-act="kick" data-id="' + esc(m.id) + '" data-name="' + esc(m.name) + '">Remove</button>' : '') + '</li>';
      }).join('') + '</ul></section>';
    if (day) {
      html += '<section class="section"><div class="section-title"><h2>The day’s plan</h2></div><label class="field"><span>Which day</span><select class="input" id="briefDay">' + days.map(function (d) { return '<option value="' + d + '"' + (d === day ? ' selected' : '') + '>' + esc(C.dayLabel(d, today)) + (C.dayLabel(d, today) === C.dayLong(d) ? '' : ' - ' + esc(C.dayLong(d))) + '</option>'; }).join('') + '</select></label>' +
        '<div class="card"><pre class="brief" id="briefText">' + esc(C.briefing(g, day, now())) + '</pre></div><div class="btn-row mt16"><button class="btn ghost" type="button" data-act="copybrief">Copy it for the group chat</button></div></section>';
    }
    html += '<section class="section"><h2>This gathering</h2><p class="muted">' + esc(g.place) + ' · ' + esc(C.dateRange(g.from, g.to)) + ' · ' + esc(C.zoneCity(g.tz)) + ' time. It is deleted by itself on ' + esc(C.dayLong(g.keptUntil)) + ', two weeks after its last day.</p>' +
      (state.demo ? '' : '<p class="small muted">' + (signedIn() ? 'Kept on your account, so it opens on your other phone when you sign in there.' : 'It lives on this phone’s browser. <button class="link-btn" type="button" data-act="account">Sign in (free)</button> to open it on another phone too.') + '</p>') +
      '<div class="btn-row">' + (g.host ? '<button class="btn ghost" type="button" data-act="details">Change the name or dates</button><button class="btn danger" type="button" data-act="delete">Delete this gathering</button>' : '<button class="btn danger" type="button" data-act="leave">Leave this gathering</button>') +
      '<button class="btn ghost" type="button" data-act="home">All gatherings</button></div></section>' +
      '<section class="section"><p class="small muted">Arrivals keeps first names and travel details only - no phone numbers, no email addresses, no location. Times are what your family typed; nothing here tracks a flight.</p></section>';
    return html;
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    clearTimeout(toastTimer);
    $$('.toast').forEach(function (t) { t.remove(); });
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet">Close</button><div class="body">' + html + '</div>';
    s.hidden = false; back.hidden = false; document.body.classList.add('sheet-open'); s.scrollTop = 0;
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2'); if (f) f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f && !s.contains(document.activeElement)) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    state.openTrip = null;
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  function zoneOptions(sel) {
    var seen = {}, list = [sel, phoneZone()].concat(C.COMMON_ZONES);
    try { if (Intl.supportedValuesOf) list = list.concat(Intl.supportedValuesOf('timeZone')); } catch (e) { /* the short list will do */ }
    return list.filter(function (z) { if (!C.isZone(z) || seen[z]) return false; seen[z] = 1; return true; }).map(function (z) {
      return '<option value="' + esc(z) + '"' + (z === sel ? ' selected' : '') + '>' + esc(z.replace(/_/g, ' ')) + '</option>';
    }).join('');
  }
  function localToday() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 101).slice(1) + '-' + String(d.getDate() + 100).slice(1); }

  function startSheet(edit) {
    var g = edit ? state.g : null, t = localToday();
    sheet('<h2>' + (edit ? 'Change the details' : 'Start a gathering') + '</h2>' + (edit ? '' : '<p class="muted">Ten seconds, no account. You get a link to send.</p>') +
      '<form id="startForm" novalidate>' +
      (edit ? '' : '<label class="field"><span>Your first name</span><input class="input" name="name" autocomplete="given-name" maxlength="20" value="' + esc(state.prefs.name) + '"></label>') +
      '<label class="field"><span>Where is everyone headed?</span><input class="input" name="place" maxlength="40" placeholder="Mom’s house" value="' + esc(g ? g.place : '') + '"></label>' +
      '<label class="field"><span>A name for it (optional)</span><input class="input" name="title" maxlength="40" placeholder="Thanksgiving at Mom’s" value="' + esc(g && g.title !== g.place ? g.title : '') + '"></label>' +
      '<div class="two"><label class="field"><span>First day</span><input class="input" type="date" name="from" value="' + esc(g ? g.from : t) + '"></label>' +
      '<label class="field"><span>Last day</span><input class="input" type="date" name="to" value="' + esc(g ? g.to : C.addDays(t, 4)) + '"></label></div>' +
      '<label class="field"><span>Time zone there</span><select class="input" name="tz">' + zoneOptions(g ? g.tz : phoneZone()) + '</select></label>' +
      '<div id="formErr"></div><button class="btn block" type="submit">' + (edit ? 'Save' : 'Start it') + '</button></form>', function (root) {
      $('#startForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, body = { place: f.place.value, title: f.title.value, from: f.from.value, to: f.to.value, tz: f.tz.value };
        if (edit) { act(Object.assign({ t: 'details' }, body), function () { closeSheet(); toast('Saved.'); }); return; }
        body.name = f.name.value;
        var btn = $('button[type=submit]', f); btn.disabled = true;
        api('POST', 'api/gatherings', body).then(function (r) {
          state.prefs.name = C.cleanName(body.name); state.prefs.cur = r.id; savePrefs();
          state.demo = null; adopt(r.g); closeSheet(true);
          if (signedIn() && state.me.keep) api('POST', 'api/g/' + encodeURIComponent(r.id) + '/keep').catch(function () { /* the phone still has it */ });
          go('board'); inviteSheet(true);
        }).catch(function (err) { btn.disabled = false; showError(err, $('#formErr', root)); });
      });
    });
  }
  function joinSheet(code) {
    sheet('<h2>Join a gathering</h2><form id="joinForm" novalidate><label class="field"><span>The code</span><input class="input" name="code" autocomplete="off" autocapitalize="characters" maxlength="9" placeholder="ABC-DEF" value="' + esc(code ? C.formatCode(code) : '') + '"></label>' +
      '<div id="peek"></div><label class="field"><span>Your first name</span><input class="input" name="name" autocomplete="given-name" maxlength="20" value="' + esc(state.prefs.name) + '"></label>' +
      '<div id="formErr"></div><button class="btn block" type="submit">Join</button></form>', function (root) {
      var f = $('#joinForm', root);
      function peek() {
        var c = C.normalizeCode(f.code.value);
        if (!C.isCode(c)) { $('#peek', root).innerHTML = ''; return; }
        api('GET', 'api/join/' + c).then(function (p) {
          if (p.already) { closeSheet(true); enter(p.already, 'board'); return; }
          $('#peek', root).innerHTML = '<div class="card mb16"><b>' + esc(p.title) + '</b><br><span class="small muted">' + esc(p.place) + ' · ' + esc(p.dates) + ' · started by ' + esc(p.by) + ' · ' + plural(p.members, 'person', 'people') + ' in</span></div><p></p>';
        }).catch(function (err) { showError(err, $('#peek', root)); });
      }
      f.code.addEventListener('input', peek); peek();
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var c = C.normalizeCode(f.code.value);
        if (!C.isCode(c)) { showError(new Error('The code is six letters and numbers, like ABC-DEF.'), $('#formErr', root)); return; }
        api('POST', 'api/join/' + c, { name: f.name.value }).then(function (r) {
          state.prefs.name = C.cleanName(f.name.value) || state.prefs.name; savePrefs();
          closeSheet(true); return enter(r.id, 'board');
        }).catch(function (err) { showError(err, $('#formErr', root)); });
      });
    });
  }
  function link() { return location.origin + BASE + '#join=' + state.g.code; }
  function inviteSheet(fresh) {
    sheet('<h2>' + (fresh ? 'It’s ready. Now send the link.' : 'Invite the family') + '</h2><p class="muted">Anyone with the link or the code joins with a first name - no account.</p><p class="code">' + esc(C.formatCode(state.g.code)) + '</p>' +
      '<button class="btn block" type="button" data-act="share">Send the link</button><button class="btn ghost block" type="button" data-act="copycode">Copy the link</button>' + (fresh ? '<button class="btn ghost block" type="button" data-act="add">Add my own arrival first</button>' : ''));
  }
  function copy(text, ok) {
    function fallback() { var ta = document.createElement('textarea'); ta.value = text; ta.className = 'vh'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast(ok); } catch (e) { toast('Could not copy - select it by hand.'); } ta.remove(); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(ok); }, fallback); else fallback();
  }

  /* ---- a trip: add or edit ---- */

  function dayOptions(sel) {
    var g = state.g, o = '', today = C.zoneDay(now(), g.tz);
    for (var d = C.addDays(g.from, -C.LIMITS.slackDays); d <= C.addDays(g.to, C.LIMITS.slackDays); d = C.addDays(d, 1)) {
      var lab = C.dayLabel(d, today);
      o += '<option value="' + d + '"' + (d === sel ? ' selected' : '') + '>' + esc(lab === C.dayLong(d) ? lab : lab + ' - ' + C.dayLong(d)) + '</option>';
    }
    return o;
  }
  function numOptions(lo, hi, sel) { var o = ''; for (var i = lo; i <= hi; i++) o += '<option' + (i === sel ? ' selected' : '') + '>' + i + '</option>'; return o; }
  function seg(name, opts, sel) {
    return '<div class="seg" role="group" data-seg="' + name + '">' + opts.map(function (o) { return '<button type="button" data-act="seg" data-val="' + o[0] + '" aria-pressed="' + (o[0] === sel) + '">' + esc(o[1]) + '</button>'; }).join('') + '</div>';
  }
  function editSheet(id, draft) {
    var g = state.g, old = id ? tripById(id) : null, t = old || draft || {};
    var today = C.zoneDay(now(), g.tz), inRange = today >= g.from && today <= g.to;
    var f0 = { dir: t.dir === 'out' ? 'out' : 'in', mode: C.isMode(t.mode) ? t.mode : 'flight' };
    var local = C.isLocal(t.local) ? t.local : '';
    var me = C.memberOf(g, g.me);
    state.openTrip = null;
    sheet('<h2>' + (old ? 'Edit ' + esc(old.who) : 'Add an arrival') + '</h2>' +
      (draft ? '<p class="ribbon" role="status">Filled in from your confirmation. Check every field - then save.</p>' : '') +
      (!old && !draft ? '<button class="btn quiet block mb16" type="button" data-act="confirm">Fill it in from a confirmation</button><p></p>' : '') +
      '<form id="tripForm" novalidate>' + seg('dir', [['in', 'Arriving'], ['out', 'Heading home']], f0.dir) +
      '<label class="field"><span>Who</span><input class="input" name="who" maxlength="40" list="whoList" placeholder="Ana + the kids" value="' + esc(t.who !== undefined ? t.who : (me ? me.name : '')) + '"><datalist id="whoList">' + g.members.map(function (m) { return '<option value="' + esc(m.name) + '">'; }).join('') + '</datalist></label>' +
      seg('mode', C.MODE_IDS.map(function (m) { return [m, C.MODES[m].label]; }), f0.mode) +
      '<label class="field"><span id="fromLabel">Coming from</span><input class="input" name="from" maxlength="40" placeholder="Denver" value="' + esc(t.from || '') + '"></label>' +
      '<div id="notCar"><div class="three"><label class="field"><span>Airline or operator</span><input class="input" name="carrier" maxlength="24" placeholder="UA" value="' + esc(t.carrier || '') + '"></label>' +
      '<label class="field"><span>Number</span><input class="input" name="number" maxlength="8" autocapitalize="characters" placeholder="1482" value="' + esc(t.number || '') + '"></label></div>' +
      '<label class="field"><span id="hubLabel">Airport</span><input class="input" name="hub" maxlength="40" value="' + esc(t.hub || '') + '"></label></div>' +
      '<div class="two"><label class="field"><span id="dayLabel">Day</span><select class="input" name="day">' + dayOptions(local ? local.slice(0, 10) : (f0.dir === 'out' ? g.to : (inRange ? today : g.from))) + '</select></label>' +
      '<label class="field"><span id="timeLabel">Lands at</span><input class="input" type="time" name="time" value="' + esc(local ? local.slice(11) : '') + '"></label></div>' +
      '<label class="field"><span>That time is in</span><select class="input" name="tz">' + zoneOptions(C.isZone(t.tz) ? t.tz : g.tz) + '</select></label>' +
      '<div class="two"><label class="field"><span>People</span><select class="input" name="party">' + numOptions(1, C.LIMITS.party, t.party || 1) + '</select></label>' +
      '<label class="field"><span>Checked bags</span><select class="input" name="bags">' + numOptions(0, C.LIMITS.bags, t.bags || 0) + '</select></label></div>' +
      '<label class="check"><input type="checkbox" name="seat"' + (t.seat ? ' checked' : '') + '><span>Needs a car seat</span></label>' +
      (old ? '' : '<label class="check" id="ownRow"><input type="checkbox" name="own"><span>Making their own way (rideshare, taxi, rental)</span></label>') +
      '<label class="field"><span>Notes for the driver (optional)</span><input class="input" name="note" maxlength="140" placeholder="Door 3, lower level" value="' + esc(t.note || '') + '"></label>' +
      '<div id="formErr"></div><button class="btn block" type="submit">' + (old ? 'Save' : 'Put it on the board') + '</button></form>', function (root) {
      var f = $('#tripForm', root);
      function paint() {
        var m = C.MODES[f0.mode], out = f0.dir === 'out', car = f0.mode === 'car';
        $('#notCar', root).hidden = car;
        if ($('#ownRow', root)) $('#ownRow', root).hidden = car;
        $('#fromLabel', root).textContent = out ? 'Going to' : 'Coming from';
        $('#hubLabel', root).textContent = (m.hub || 'Airport') + (out ? ' they leave from' : ' they arrive at');
        f.hub.placeholder = m.hubHint;
        $('#timeLabel', root).textContent = out ? 'Leaves at' : (car ? 'Rolls in about' : f0.mode === 'flight' ? 'Lands at' : 'Pulls in at');
        $$('[data-seg]', root).forEach(function (s) { $$('button', s).forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.val === f0[s.dataset.seg])); }); });
        if (!old) $('h2', root).textContent = out ? 'Add a trip home' : 'Add an arrival';
      }
      root.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act="seg"]'); if (!b || !f.contains(b)) return;
        f0[b.parentNode.dataset.seg] = b.dataset.val; paint();
      });
      paint();
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!f.time.value) { showError(new Error('Pick the time - a rough one is fine, it can be changed.'), $('#formErr', root)); return; }
        var trip = { dir: f0.dir, mode: f0.mode, who: f.who.value, from: f.from.value, carrier: f.carrier.value, number: f.number.value, hub: f.hub.value, local: f.day.value + 'T' + f.time.value.slice(0, 5), tz: f.tz.value, party: Number(f.party.value), bags: Number(f.bags.value), seat: f.seat.checked, own: Boolean(f.own && f.own.checked), note: f.note.value };
        act(old ? { t: 'edit', id: id, trip: trip } : { t: 'add', trip: trip }, function (r) {
          state.fresh = old ? id : r.id; closeSheet(true); toast(old ? 'Saved.' : 'On the board.'); say(trip.who + ' is on the board.');
          if (state.view !== 'board') go('board');
        });
      });
    });
  }

  /* ---- a trip: where they are, how late, who is driving ---- */

  var STATUS_LABEL = { sched: 'Scheduled', way: 'On the way', landed: 'Landed', here: 'Here', left: 'Left' };
  function tripSheet(id, keepScroll) {
    var g = state.g, t = tripById(id); if (!t) return;
    var y = keepScroll ? $('#sheet').scrollTop : 0;
    var ex = C.expected(t), r = C.rideLine(g, t), d = C.driverOf(g, t), today = C.zoneDay(now(), g.tz);
    var others = g.members.filter(function (m) { return !m.left && !m.me; });
    var html = '<h2>' + esc(t.who) + '</h2><p><span class="chip s-' + C.stateOf(t) + '">' + esc(C.stateLabel(t)) + '</span></p>' +
      '<p><b class="num">' + esc(C.clockAt(ex, g.tz)) + '</b> ' + esc(C.dayLabel(C.zoneDay(ex, g.tz), today)) + (t.delay ? ' <span class="muted">(was ' + esc(C.clockAt(t.at, g.tz)) + ')</span>' : '') +
      (t.tz !== g.tz && C.offsetMin(ex, t.tz) !== C.offsetMin(ex, g.tz) ? '<br><span class="small muted">' + esc(C.clockAt(ex, t.tz) + ' ' + C.zoneAbbr(ex, t.tz)) + ' where it was typed; shown here in ' + esc(C.zoneCity(g.tz)) + ' time.</span>' : '') + '<br>' +
      '<span class="muted">' + esc([t.dir === 'out' ? 'Heading home' : 'Arriving', C.tripLine(t), t.hub, C.extras(t)].filter(Boolean).join(' · ')) + '</span>' + (t.note ? '<br><span class="muted">“' + esc(t.note) + '”</span>' : '') + '</p>' +
      '<h3>Where are they?</h3><div class="seg">' + C.statuses(t).map(function (s) { return '<button type="button" data-act="status" data-id="' + esc(id) + '" data-status="' + s + '" aria-pressed="' + (t.status === s) + '">' + esc(s === 'landed' && t.mode !== 'flight' ? 'Arrived' : STATUS_LABEL[s]) + '</button>'; }).join('') + '</div>';
    if (!C.done(t) && t.status !== 'landed') {
      html += '<h3>Running late?</h3><div class="btn-row">' + [20, 40, 60].map(function (n) { return '<button class="btn small quiet" type="button" data-act="delay" data-id="' + esc(id) + '" data-add="' + n + '">+' + (n === 60 ? '1 hour' : n + ' min') + '</button>'; }).join('') +
        (t.delay ? '<button class="btn small ghost" type="button" data-act="delay" data-id="' + esc(id) + '" data-set="0">Back on time</button>' : '') + '</div>';
    }
    if (t.mode !== 'car') {
      html += '<h3>' + (t.dir === 'out' ? 'Who’s driving them there?' : 'Who’s picking them up?') + '</h3><p class="' + (r.k === 'none' && !C.done(t) ? 'err' : '') + '">' + esc(r.text) + '.</p><div class="btn-row">' +
        (d && d.me ? '<button class="btn small ghost" type="button" data-act="ride" data-id="' + esc(id) + '" data-k="none">I can’t after all</button>' : '<button class="btn small" type="button" data-act="ride" data-id="' + esc(id) + '" data-k="driver">' + (t.dir === 'out' ? 'I’ll drive them' : 'I’ll get them') + '</button>') +
        (t.ride.k === 'own' ? '<button class="btn small ghost" type="button" data-act="ride" data-id="' + esc(id) + '" data-k="none">Needs a ride after all</button>' : '<button class="btn small ghost" type="button" data-act="ride" data-id="' + esc(id) + '" data-k="own">Own way</button>') + '</div>' +
        (others.length ? '<label class="field mt16"><span>Or someone else is driving</span><select class="input" id="driverPick" data-id="' + esc(id) + '"><option value="">Pick a driver</option>' + others.map(function (m) { return '<option value="' + esc(m.id) + '"' + (d && d.id === m.id ? ' selected' : '') + '>' + esc(m.name) + '</option>'; }).join('') + '</select></label>' : '');
    }
    html += '<div id="formErr"></div><h3>This trip</h3><div class="btn-row"><button class="btn small ghost" type="button" data-act="edit" data-id="' + esc(id) + '">Edit the details</button><button class="btn small danger" type="button" data-act="remove" data-id="' + esc(id) + '">Take it off the board</button></div>';
    sheet(html); state.openTrip = id;
    if (keepScroll) $('#sheet').scrollTop = y;
  }

  /* ---- fill from a confirmation (signed in; the one model call) ---- */

  function draftLine(d) {
    var g = state.g;
    return (d.dir === 'out' ? 'Trip home' : 'Arrival') + ': ' + [d.who, C.carrierLine(d) || C.MODES[d.mode].label, d.hub, d.local ? C.dayLong(d.local.slice(0, 10)) + ' ' + C.clock(d.local.slice(11)) : ''].filter(Boolean).join(' · ') + (d.tz !== g.tz ? ' (' + C.zoneCity(d.tz) + ' time)' : '');
  }
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) { reject(new Error('Choose a screenshot or photo (an image).')); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        resolve({ type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85) });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That image could not be opened. Try a screenshot.')); };
      img.src = url;
    });
  }
  function gotDrafts(drafts) {
    if (drafts.length === 1) { editSheet(null, drafts[0]); return; }
    sheet('<h2>Found ' + drafts.length + ' trips</h2><p class="muted">Pick one to check and save; come back for the next.</p><ul class="list">' + drafts.map(function (d, i) { return '<li><button class="item" type="button" data-draft="' + i + '"><span class="grow t">' + esc(draftLine(d)) + '</span><span class="tag">Use</span></button></li>'; }).join('') + '</ul>', function (root) {
      root.addEventListener('click', function (e) { var b = e.target.closest('[data-draft]'); if (b) editSheet(null, drafts[Number(b.dataset.draft)]); });
    });
  }
  function confirmSheet() {
    var g = state.g;
    if (state.demo) { gotDrafts([C.cleanDraft({ dir: 'in', who: 'Carmen', mode: 'flight', from: 'Miami', carrier: 'AA', number: '1127', hub: 'ORD', local: '2026-11-26T12:40', party: 1 }, g)]); return; }
    if (!signedIn()) {
      sheet('<h2>Fill it in from a confirmation</h2><p>Paste a booking email or add a screenshot, and Arrivals fills in the flight, the airport and the time as a draft you check before saving.</p><p class="muted">Reading it uses AI, which costs money to run - so this one step needs a free account. Everything else in Arrivals works without one, and typing a trip in takes about a minute.</p>' +
        '<button class="btn block" type="button" data-act="account">Create a free account or sign in</button><button class="btn ghost block" type="button" data-act="add">Type it in instead</button>');
      return;
    }
    sheet('<h2>Fill it in from a confirmation</h2><p class="muted">Paste the booking email, or add a screenshot. It is read once and not kept; you check the draft before anything is saved.</p>' +
      '<form id="readForm" novalidate><label class="field"><span>Paste the confirmation</span><textarea class="input" name="text" maxlength="6000" placeholder="Your trip confirmation…"></textarea></label>' +
      '<label class="field"><span>Or a screenshot or photo of it</span><input class="input" type="file" name="photo" accept="image/*"></label>' +
      '<div id="formErr"></div><button class="btn block" type="submit">Read it</button><button class="btn ghost block" type="button" data-act="add">Type it in instead</button></form>', function (root) {
      $('#readForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f), file = f.photo.files && f.photo.files[0];
        var body = { place: g.place, from: g.from, to: g.to, tz: g.tz };
        if (!file && !f.text.value.trim()) { showError(new Error('Paste the confirmation, or add a screenshot of it.'), $('#formErr', root)); return; }
        btn.disabled = true; btn.textContent = 'Reading…';
        (file ? shrink(file).then(function (p) { body.photo = p; }) : Promise.resolve(body.text = f.text.value)).then(function () { return api('POST', 'api/read', body); })
          .then(function (r) { gotDrafts(r.drafts); })
          .catch(function (err) { btn.disabled = false; btn.textContent = 'Read it'; showError(err, $('#formErr', root)); });
      });
    });
  }

  /* ---------------- the example ---------------- */

  function startDemo() {
    closeSheet(true);
    state.demo = D.doc(); state.g = C.view(state.demo, D.ME); state.view = 'board';
    history.replaceState(null, '', BASE + '#board'); draw(); scrollTo(0, 0);
  }
  function leaveDemo() {
    state.demo = null; state.g = null; closeSheet(true);
    if (state.prefs.cur) { enter(state.prefs.cur); return; }
    go('home');
  }

  /* ---------------- the account (only for a second phone, and the one AI step) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }
  /** Signed in: keep this phone's gatherings on the account, and bring the
   *  account's to this phone. */
  function syncMine() {
    if (!signedIn() || !state.me.keep) return Promise.resolve();
    var chain = Promise.resolve();
    state.list.forEach(function (g) { chain = chain.then(function () { return api('POST', 'api/g/' + encodeURIComponent(g.id) + '/keep').catch(function () { /* gone, or not ours */ }); }); });
    return chain.then(function () { return api('GET', 'api/mine'); }).then(function (r) {
      var have = {}; state.list.forEach(function (g) { have[g.id] = 1; });
      (r.list || []).forEach(function (g) { if (!have[g.id]) state.list.push(g); });
      real.putList(state.list); state.list = real.getList();
      if (state.view === 'home') drawSoft();
    }).catch(function () { /* the phone's own list stands */ });
  }
  var FREE_LINE = 'Arrivals is free with no account. A free account does two things: your gatherings open on your other phone, and you can fill a trip in from a booking confirmation. One account works across every app on this site.';
  function openAccount() {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2><p class="muted">' + esc(FREE_LINE) + '</p>' +
        '<form id="authForm"><label class="field"><span>Your email (for your account only - never shown to the family)</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div><button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center mt16">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      function done() { closeSheet(); return loadMe().then(function () { toast('You’re in.'); return syncMine(); }).then(function () { drawSoft(); }); }
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
    sheet('<h2>Account</h2><p class="small muted">' + esc(state.me.email) + '</p><p class="small">Your gatherings are kept on this account, so they open on your other phone when you sign in there. The family never sees this address.</p>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button">Set up Face ID for this phone</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button">Sign out</button>', function (root) {
      $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); drawSoft(); }); });
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
    api(method, 'api/g/' + encodeURIComponent(state.g.id) + tail).then(ok).catch(function (er) { showError(er); });
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var a = el.dataset.act, id = el.dataset.id;
    if (a === 'home') { e.preventDefault(); closeSheet(true); if (state.demo) { state.demo = null; state.g = null; } go('home'); }
    else if (a === 'tab') { if (state.g) go(el.dataset.tab); }
    else if (a === 'closesheet') closeSheet();
    else if (a === 'account') { if (signedIn()) openAccountSheet(); else openAccount(); }
    else if (a === 'start') startSheet(false);
    else if (a === 'join') joinSheet('');
    else if (a === 'demo') startDemo();
    else if (a === 'leavedemo') leaveDemo();
    else if (a === 'open') enter(id);
    else if (a === 'add') editSheet(null, null);
    else if (a === 'confirm') confirmSheet();
    else if (a === 'trip') tripSheet(id);
    else if (a === 'edit') editSheet(id, null);
    else if (a === 'invite') inviteSheet(false);
    else if (a === 'details') startSheet(true);
    else if (a === 'step' || a === 'status') { state.fresh = id; act({ t: 'status', id: id, status: el.dataset.status }, function () { var t = tripById(id); if (t) say(t.who + ': ' + C.stateLabel(t)); }); }
    else if (a === 'late') { state.fresh = id; act({ t: 'delay', id: id, add: 20 }, function () { var t = tripById(id); if (t) toast(t.who + ': ' + C.stateLabel(t).toLowerCase() + '.'); }); }
    else if (a === 'delay') { state.fresh = id; act(el.dataset.set !== undefined ? { t: 'delay', id: id, set: 0 } : { t: 'delay', id: id, add: Number(el.dataset.add) }); }
    else if (a === 'ride' || a === 'claim') { act({ t: 'ride', id: id, k: a === 'claim' ? 'driver' : el.dataset.k }, function () { if (a === 'claim') toast('It’s yours - see Your runs.'); }); }
    else if (a === 'combine') { var ride = { t: 'ride', ids: el.dataset.ids.split(','), k: 'driver' }; if (el.dataset.mid) ride.mid = el.dataset.mid; act(ride, function () { toast('One run it is.'); }); }
    else if (a === 'remove') { if (confirm('Take this trip off the board for everyone?')) act({ t: 'del', id: id }, function () { closeSheet(); toast('Off the board.'); }); }
    else if (a === 'share') {
      var text = 'Add your arrival for ' + state.g.title + ' - who lands when, and who’s picking them up:';
      if (navigator.share) navigator.share({ title: 'Arrivals - ' + state.g.title, text: text, url: link() }).catch(function () { /* cancelled */ }); else copy(text + ' ' + link(), 'Link copied - paste it in the family chat.');
    }
    else if (a === 'copycode') copy(link(), 'Link copied - paste it in the family chat.');
    else if (a === 'copybrief') copy($('#briefText').textContent, 'Copied.');
    else if (a === 'kick') { if (confirm('Remove ' + el.dataset.name + ' from this gathering? Their trips stay on the board.')) gCall('DELETE', '/members/' + encodeURIComponent(id), function (r) { adopt(r.g); drawSoft(); }); }
    else if (a === 'leave') { if (confirm('Leave this gathering? You can rejoin with the code.')) gCall('DELETE', '/me', function () { forgetLocal(state.g.id); state.g = null; go('home'); toast('You left.'); }); }
    else if (a === 'delete') { if (confirm('Delete this gathering for everyone? The board and every trip on it are gone for good.')) gCall('DELETE', '', function () { forgetLocal(state.g.id); state.g = null; go('home'); toast('Deleted.'); }); }
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'driverPick' && e.target.value) act({ t: 'ride', id: e.target.dataset.id, k: 'driver', mid: e.target.value });
    if (e.target.id === 'briefDay') { state.briefDay = e.target.value; drawSoft(); }
  });
  window.addEventListener('popstate', function () { closeSheet(true); route(); });
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') schedulePoll(0); else clearTimeout(pollTimer); });
  // The board's "due" flags and day labels move with the clock.
  setInterval(function () { if (state.g && !state.demo && document.visibilityState === 'visible' && $('#sheet').hidden && TABS.indexOf(state.view) >= 0) drawSoft(); }, 60000);

  /* ---------------- boot ---------------- */

  draw();
  loadMe().then(syncMine);
  var h0 = location.hash.replace(/^#/, '');
  if (/^join=/.test(h0) || h0 === 'try') route();
  else if (state.prefs.cur && h0 !== 'home') enter(state.prefs.cur, TABS.indexOf(h0) >= 0 ? h0 : null);
  else route();
})();
