/* Pickup - the page. One file, no build step. Every string that came from
 * outside this file (a typed name, a pasted chat, a model's reading of one,
 * anything from the server) is escaped before it is drawn, and no handler is
 * written into markup: clicks are routed by data-act attributes from one
 * listener (the lab's CSP allows script from this origin only). The rules -
 * the waitlist, teams, standings, court money - are pickup-core.js, the same
 * file the server and the tests run.
 *
 * Where a group can live:
 *   example - Thursday Hoops (sample.js), the first thing to try. Every tap
 *             works, on this phone only; nothing is saved. Changing the
 *             group itself offers "Make it yours".
 *   local   - "Start a group": in localStorage on this device, no account,
 *             no server. The host runs it for everyone.
 *   online  - g/<id>: put online by a host with a free account; everyone
 *             else joined by code, link or QR with a name.
 *   join    - j/<code>.
 */
(function () {
  'use strict';

  var C = window.PickupCore;
  var S = window.PickupSample;
  var QR = window.PickupQR;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_LOCAL = 'pickup-group-v1';
  var K_LIST = 'pickup-groups-v1';
  var K_LAST = 'pickup-last-v1';
  var POLL_MS = 5000;
  var SHOT_PX = 2000;
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }());
  var GROUP_ID = (function () { var m = /\/g\/([A-Za-z0-9_-]{16})\/?$/.exec(location.pathname); return m ? m[1] : null; }());
  var JOIN_CODE = (function () { var m = /\/j\/([A-Za-z0-9-]{4,16})\/?$/.exec(location.pathname); return m ? m[1].toUpperCase().replace(/[^A-Z0-9]/g, '') : null; }());
  var TABS = [['game', null, 'Game'], ['teams', '👕', 'Teams'], ['season', '🏆', 'Season'], ['money', '💵', 'Money'], ['group', '👥', 'Group']];
  var ANS = { in: 'In', maybe: 'Maybe', out: 'Out' };
  var ANS_ICON = { in: '✓', maybe: '?', out: '✕' };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var plural = C.plural;

  var state = {
    me: null,          // the account, if any
    view: 'start',     // start | group | join
    kind: null,        // example | local | online
    tab: 'game',
    g: null,           // the group (online: the member's view of it)
    join: null,
    timer: null,
    sides: null,       // the teams tab's choice
    voter: null,       // who is voting, on a phone the host runs
    paste: null,       // {text, list, unread}
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
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
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  /** The phone's own share sheet - Pickup never sends anything itself. */
  function share(title, text) {
    if (navigator.share) navigator.share({ title: title, text: text }).catch(function () { /* closed */ });
    else copy(text, 'Copied - paste it in the group chat');
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function isExample() { return state.kind === 'example'; }
  function isLocal() { return state.kind === 'local'; }
  function isOnline() { return state.kind === 'online'; }
  function actor() {
    var g = state.g;
    if (isOnline()) return { mid: g.me, host: Boolean(g.host), online: true };
    var h = C.hostOf(g);
    return { mid: h ? h.id : null, host: true };
  }
  function cur() { return C.latest(state.g); }
  function today() { return C.localDate(Date.now(), state.g.tz); }
  function nm(game, id) { return C.nameOf(state.g, game, id); }
  function money(c) { return C.fmtMoney(c, state.g.cur); }
  function sport() { return C.sportOf(state.g); }
  function mapsUrl(place) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(place); }
  function joinLink() { return location.origin + BASE + 'j/' + state.g.code; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401 && isOnline() && !signedIn()) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. The free reader and everything else in Pickup still work meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  /** A metered call's failure, in the sheet it came from. */
  function meteredError(err, box, retry) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount('Reading a messy chat uses a cent or two of AI credit, so it needs a free account (it comes with $2). The free reader costs nothing.', retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }

  /* ---------------- groups remembered on this phone ---------------- */

  function rememberGroup(id, name, sp) {
    var list = (recall(K_LIST) || []).filter(function (c) { return c && c.id !== id; });
    list.unshift({ id: id, name: String(name || '').slice(0, 60), sport: sp });
    keep(K_LIST, list.slice(0, 20));
    keep(K_LAST, { id: id });
  }
  function forgetGroup(id) {
    keep(K_LIST, (recall(K_LIST) || []).filter(function (c) { return c && c.id !== id; }));
    var last = recall(K_LAST);
    if (last && last.id === id) keep(K_LAST, null);
  }

  /* ---------------- the group on this phone ---------------- */

  /** What this phone keeps, read defensively and cleaned by the same rules
   *  the server uses - it is this app's own data, but a phone can hold
   *  anything. */
  function readLocal() {
    var raw = recall(K_LOCAL);
    if (!raw || typeof raw !== 'object') return null;
    try {
      var g = C.cleanGroup(raw, { tz: raw.tz || TZ });
      var e = C.ensureGame(g, Date.now());
      C.applyPatch(g, e.patch);
      return g;
    } catch (err) { return null; }
  }
  function saveLocal() {
    if (!isLocal()) return;
    keep(K_LOCAL, state.g);
  }
  function openLocal() {
    var g = readLocal();
    if (!g) return false;
    state.kind = 'local'; state.view = 'group'; state.g = g;
    saveLocal();
    return true;
  }
  function openExample() {
    state.kind = 'example'; state.view = 'group'; state.g = S.state(Date.now(), TZ);
  }

  /* ---------------- the group online ---------------- */

  function setBundle(d) {
    state.kind = 'online'; state.view = 'group';
    state.g = d.group;
    rememberGroup(d.group.id, d.group.name, d.group.sport);
  }
  function loadOnline(quiet) {
    var q = state.g && isOnline() ? '?since=' + state.g.v : '';
    return api('GET', 'api/groups/' + GROUP_ID + q).then(function (d) {
      if (d.same) return;
      setBundle(d);
      if (!sheetOpen()) draw();
    }).catch(function (e) {
      if (e.status === 404) {
        forgetGroup(GROUP_ID);
        stopPolling();
        state.g = null;
        $('#main').innerHTML = '<section class="card center gone"><div class="big-emoji" aria-hidden="true">🏀</div><h1>This group isn’t here for you</h1><p class="muted">' +
          esc(e.message === 'No group here.' ? 'You may have left or been removed, the group was deleted, or this browser forgot you. If you have the link or code, join again - your seat is still yours to take.' : e.message) + '</p>' +
          (signedIn() ? '' : '<button class="btn" type="button" data-act="signin">Sign in</button> ') + '<a class="btn ghost" href="' + esc(BASE) + '#start">Back to the start</a></section>';
        return;
      }
      if (!quiet) showError(e);
    });
  }
  function stopPolling() { clearInterval(state.timer); state.timer = null; }
  function startPolling() {
    stopPolling();
    if (!isOnline() || document.hidden) return;
    state.timer = setInterval(function () { loadOnline(true); }, POLL_MS);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return stopPolling();
    if (isOnline() && state.g) { loadOnline(true); startPolling(); }
    else if (state.view === 'group' && state.g && !sheetOpen()) { refreshLocal(); draw(); }
  });
  function refreshLocal() {
    if (!state.g || isOnline()) return;
    var e = C.ensureGame(state.g, Date.now());
    if (e.patch) { C.applyPatch(state.g, e.patch); saveLocal(); }
  }

  /* ---------------- doing things ---------------- */

  var GROUP_OPS = { editMember: 1, addMembers: 1, removeMember: 1, editGroup: 1, lines: 1 };

  /** One action on the group: on this phone, through the core; online,
   *  through the server (which runs the same core in a transaction). */
  function run(op, a) {
    if (isExample() && GROUP_OPS[op]) { openMakeYours('That changes the group itself.'); return Promise.reject(Object.assign(new Error(''), { quiet: true })); }
    if (isOnline()) {
      var base = 'api/groups/' + GROUP_ID;
      var gp = base + '/games/' + a.gid;
      var p;
      if (op === 'rsvp') p = api('PUT', gp + '/rsvp/' + a.id, { a: a.a });
      else if (op === 'guest') p = api('POST', gp + '/guests', { name: a.name, skill: a.skill, by: a.by });
      else if (op === 'editGame') p = api('PATCH', gp, a.body);
      else if (op === 'done') p = api('POST', gp + '/done', {});
      else if (op === 'teams') p = api('POST', gp + '/teams', { sides: a.sides, n: a.n });
      else if (op === 'clearTeams') p = api('DELETE', gp + '/teams');
      else if (op === 'played') p = api('PUT', gp + '/played', { ids: a.ids });
      else if (op === 'match') p = api('POST', gp + '/matches', a.body);
      else if (op === 'unmatch') p = api('DELETE', gp + '/matches/' + a.rid);
      else if (op === 'vote') p = api('PUT', gp + '/vote', { cand: a.cand });
      else if (op === 'closeVotes') p = api('POST', gp + '/vote/close', {});
      else if (op === 'paid') p = api('PUT', gp + '/paid/' + a.pid, { paid: a.paid });
      else if (op === 'apply') p = api('POST', gp + '/rsvps', { answers: a.answers, add: a.add });
      else if (op === 'editMember') p = api('PATCH', base + '/members/' + a.mid, a.body);
      else if (op === 'addMembers') p = api('POST', base + '/members', { names: a.names });
      else if (op === 'removeMember') p = api('DELETE', base + '/members/' + a.mid);
      else if (op === 'editGroup') p = api('PATCH', base, a.body);
      else if (op === 'lines') p = api('PUT', base + '/lines', { lines: a.lines });
      return p.then(function (d) { if (d.left) return d; setBundle(d); return { msg: d.msg, status: d.status }; });
    }
    try {
      var g = state.g;
      var A = actor();
      var ctx = { now: Date.now(), actor: A };
      var r = null;
      var draft = C.copy(g);
      if (op === 'rsvp') r = C.rsvp(g, a.gid, a.id, a.a, ctx);
      else if (op === 'guest') r = C.addGuest(g, a.gid, { name: a.name, skill: a.skill, by: a.by }, ctx);
      else if (op === 'editGame') r = C.editGame(g, a.gid, a.body, ctx);
      else if (op === 'done') r = C.wrapUp(g, a.gid, ctx);
      else if (op === 'teams') r = C.makeTeams(g, a.gid, { sides: a.sides, n: a.n }, ctx);
      else if (op === 'clearTeams') r = C.clearTeams(g, a.gid, ctx);
      else if (op === 'played') r = C.setPlayed(g, a.gid, a.ids, ctx);
      else if (op === 'match') r = C.addMatch(g, a.gid, a.body, ctx);
      else if (op === 'unmatch') r = C.removeMatch(g, a.gid, a.rid, ctx);
      else if (op === 'vote') r = C.vote(g, a.gid, a.voter, a.cand, ctx);
      else if (op === 'closeVotes') r = C.closeVotes(g, a.gid, ctx);
      else if (op === 'paid') r = C.markPaid(g, a.gid, a.pid, a.paid, ctx);
      else if (op === 'apply') {
        var added = C.addMembers(draft, (a.add || []).map(function (x) { return x.name; }), ctx).members;
        draft.members = draft.members.concat(added);
        var answers = (a.answers || []).concat((a.add || []).map(function (x) {
          var m = added.filter(function (y) { return C.fold(y.name) === C.fold(C.cleanName(x.name)); })[0];
          return m ? { id: m.id, a: x.a, plus: x.plus } : null;
        }).filter(Boolean));
        r = C.rsvpMany(draft, a.gid, answers, ctx);
        C.applyPatch(draft, r.patch);
        state.g = draft;
        r = { patch: null, msg: (added.length ? 'Added ' + plural(added.length, 'new regular') + '. ' : '') + r.msg };
      } else if (op === 'editMember') { C.editMember(draft, a.mid, a.body, A); state.g = draft; r = { msg: 'Saved.' }; }
      else if (op === 'addMembers') { var am = C.addMembers(draft, a.names, ctx); draft.members = draft.members.concat(am.members); state.g = draft; r = { msg: am.msg }; }
      else if (op === 'removeMember') { C.removeMember(draft, a.mid, A); state.g = draft; r = { msg: 'Removed.' }; }
      else if (op === 'editGroup') { C.editGroup(draft, a.body, A, Date.now()); state.g = draft; r = { msg: 'Saved.' }; }
      else if (op === 'lines') { draft.lines = C.cleanLines(draft, a.lines); state.g = draft; r = { msg: 'Saved.' }; }
      if (r && r.patch) C.applyPatch(state.g, r.patch);
      refreshLocal();
      saveLocal();
      return Promise.resolve({ msg: r ? r.msg : '', status: r && r.status });
    } catch (e) { return Promise.reject(e); }
  }
  /** Run, redraw, say what happened. */
  function doRun(op, a, opts) {
    return run(op, a).then(function (r) {
      if (opts && opts.close) closeSheet(true);
      if (!r || r.left) return r;
      if (!sheetOpen() || (opts && opts.close)) draw();
      if (!(opts && opts.quiet) && r.msg) toast(r.msg);
      return r;
    }).catch(function (e) {
      if (e && e.quiet) throw e;
      showError(e, opts && opts.errBox);
      throw e;
    });
  }

  /* ---------------- routing ---------------- */

  function go(hash) { history.pushState(null, '', BASE + (hash ? '#' + hash : '')); route(); scrollTo(0, 0); }
  function tabName(t) { for (var i = 0; i < TABS.length; i++) if (TABS[i][0] === t) return t; return 'game'; }
  function tabHash(t) { return isExample() ? 'example/' + t : t; }
  function route() {
    stopPolling();
    closeSheet(true);
    if (GROUP_ID) {
      state.view = 'group';
      state.tab = tabName(location.hash.slice(1));
      if (!state.g) { $('#main').innerHTML = '<p class="busy">Loading the group…</p>'; loadOnline().then(startPolling); }
      else { draw(); startPolling(); }
      return;
    }
    var h = location.hash.slice(1);
    if (/^example(\/|$)/.test(h)) {
      if (!isExample()) openExample();
      state.tab = tabName(h.split('/')[1]);
      draw();
      return;
    }
    if (h && h !== 'start' && openLocal()) { state.tab = tabName(h); draw(); return; }
    state.view = 'start'; state.kind = null; state.g = null;
    draw();
  }
  window.addEventListener('popstate', route);

  /* ---------------- drawing ---------------- */

  function draw() {
    var main = $('#main');
    if (state.view === 'join') return drawJoin();
    if (state.view !== 'group' || !state.g) { main.innerHTML = startHtml(); loadMyGroups(); return; }
    var g = state.g;
    var html = '';
    if (isExample()) html += '<div class="strip"><p><b>This is an example.</b> Tap anything - In, Out, teams, scores, Paid. Nothing is saved.</p><button class="btn small light" type="button" data-act="startown">Start your own</button></div>';
    html += '<header class="ghead"><span class="gs" aria-hidden="true">' + esc(sport().emoji) + '</span><div class="gt"><h1>' + esc(g.name) + '</h1><p>' + esc(schedLine(g)) + '</p></div></header>';
    var game = cur();
    var dots = { money: C.money(g, Date.now()).owes.length, season: seasonDot() };
    html += '<nav class="tabbar dk-tabbar" aria-label="' + esc(g.name) + '"><div class="tabbar-inner"><a class="rail-brand" href="' + esc(BASE) + '#start"><span aria-hidden="true">' + esc(sport().emoji) + '</span>' + esc(g.name) + '</a>' + TABS.map(function (t) {
      var d = dots[t[0]];
      return '<button type="button" class="tab' + (state.tab === t[0] ? ' on' : '') + '" data-act="tab" data-tab="' + t[0] + '"' + (state.tab === t[0] ? ' aria-current="page"' : '') + '><span aria-hidden="true">' + esc(t[1] || sport().emoji) + '</span>' + t[2] + (d ? '<i class="dot" aria-label="' + (t[0] === 'money' ? d + ' owe' : 'vote open') + '">' + (t[0] === 'money' ? d : '!') + '</i>' : '') + '</button>';
    }).join('') + '</div></nav><div id="tabBody"></div>';
    main.innerHTML = html;
    void game;
    var body = $('#tabBody');
    if (state.tab === 'game') body.innerHTML = gameHtml();
    else if (state.tab === 'teams') body.innerHTML = teamsHtml();
    else if (state.tab === 'season') body.innerHTML = seasonHtml();
    else if (state.tab === 'money') body.innerHTML = moneyHtml();
    else body.innerHTML = groupHtml();
    body.innerHTML += footer();
    wireTab(body);
  }
  function schedLine(g) {
    var s = g.sched || {};
    var parts = [C.WEEKDAY_NAMES[s.wd] + 's ' + C.timeLabel(s.time)];
    if (s.place) parts.push(s.place);
    if (isOnline()) parts.push(plural(g.members.length, 'regular'));
    else if (isLocal()) parts.push('on this phone');
    return parts.join(' · ');
  }
  function seasonDot() {
    var pg = potwGame();
    if (!pg) return 0;
    var pw = C.potw(state.g, pg, Date.now(), actor().mid);
    if (!pw.open) return 0;
    var me = actor().mid;
    return isOnline() ? (pw.voters.indexOf(me) >= 0 && !pw.mine ? 1 : 0) : 0;
  }
  function footer() {
    return '<footer class="foot small muted"><p>Pickup never sends a message or moves money - it keeps the list. Sharing goes through your phone.</p><p>A free account is only needed to host a group online, or to have AI read a messy chat (it comes with $2 of credit).</p></footer>';
  }
  function wireTab(body) {
    var f = $('#scoreForm', body);
    if (f) f.addEventListener('submit', function (e) { e.preventDefault(); saveScore(f); });
    var am = $('#addRegs', body);
    if (am) am.addEventListener('submit', function (e) {
      e.preventDefault();
      var names = $('#regNames', body).value.split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!names.length) return;
      doRun('addMembers', { names: names }).catch(function () {});
    });
    var lf = $('#lineForm', body);
    if (lf) lf.addEventListener('submit', function (e) {
      e.preventDefault();
      var a = $('#lineA', body).value, b = $('#lineB', body).value, k = $('#lineK', body).value;
      if (!a || !b || a === b) return toast('Pick two different people.');
      doRun('lines', { lines: (state.g.lines || []).concat([{ a: a, b: b, k: k }]) }).catch(function () {});
    });
    var vs = $('#voterSel', body);
    if (vs) vs.addEventListener('change', function () { state.voter = vs.value; draw(); });
    var col = $('#collector', body);
    if (col) col.addEventListener('change', function () { doRun('editGroup', { body: { collector: col.value } }).catch(function () { draw(); }); });
    var qr = $('#qrSmall', body);
    if (qr && QR) qr.innerHTML = QR.svg(joinLink(), 'Join ' + state.g.name);
  }

  /* ---------------- start ---------------- */

  function startHtml() {
    var local = recall(K_LOCAL);
    return '<section class="hero"><div class="hero-art" aria-hidden="true"><span>🏀</span><span>⚽</span><span>🏐</span></div>' +
      '<h1>Who’s in, fair teams, and who owes for the court.</h1>' +
      '<p class="lede">For the weekly game you run out of a group chat. Everyone taps In, Maybe or Out - no app, no account. Pickup keeps the waitlist, makes even teams and keeps track of the court money.</p></section>' +
      '<div class="choices">' +
      '<button class="choice primary" type="button" data-act="example"><span class="ci" aria-hidden="true">👀</span><span class="ct"><b>See an example group</b><span>Thursday Hoops: 16 regulars, this week’s game, teams and the season so far</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      (local && local.name ? '<button class="choice" type="button" data-act="openlocal"><span class="ci" aria-hidden="true">' + esc((C.SPORT[local.sport] || C.SPORT.other).emoji) + '</span><span class="ct"><b>Open ' + esc(C.clean(local.name, 40)) + '</b><span>Your group on this phone</span></span><span class="chev" aria-hidden="true">›</span></button>'
        : '<button class="choice" type="button" data-act="newgroup"><span class="ci" aria-hidden="true">✨</span><span class="ct"><b>Start a group</b><span>On this phone in a minute - no account. Put it online when you like.</span></span><span class="chev" aria-hidden="true">›</span></button>') +
      '<button class="choice" type="button" data-act="joincode"><span class="ci" aria-hidden="true">🔑</span><span class="ct"><b>Join with a code</b><span>Six characters from whoever runs the game</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      '</div><section class="card" id="myGroups" hidden></section>' +
      '<section class="card"><div class="feats">' +
      '<div class="feat"><span class="fi" aria-hidden="true">🙋</span><div><b>In · Maybe · Out</b><span>A cap and a waitlist. When someone drops, the next one’s in - and everyone sees “Sam’s in - Jo dropped out”.</span></div></div>' +
      '<div class="feat"><span class="fi" aria-hidden="true">⚖️</span><div><b>Even teams in one tap</b><span>Balanced by skill (only the host sees the numbers), keepers spread, friends split or kept together, not last week’s teams again.</span></div></div>' +
      '<div class="feat"><span class="fi" aria-hidden="true">💵</span><div><b>Court money, no chasing</b><span>The cost split among who played, Paid ticks, and a reminder line ready to paste. No money moves through Pickup.</span></div></div>' +
      '</div></section>' + footer();
  }
  function loadMyGroups() {
    var box = $('#myGroups');
    if (!box) return;
    var local = recall(K_LIST) || [];
    var p = signedIn() ? api('GET', 'api/groups').then(function (r) { return r.groups; }).catch(function () { return []; }) : Promise.resolve([]);
    p.then(function (rows) {
      var seen = {};
      var all = rows.map(function (c) { seen[c.id] = 1; return c; }).concat(local.filter(function (c) { return c && !seen[c.id]; }));
      if (!all.length || !$('#myGroups')) return;
      box.innerHTML = '<h2>Your groups</h2><ul class="tlist">' + all.map(function (c) {
        return '<li><a href="' + esc(BASE + 'g/' + c.id) + '"><span aria-hidden="true">' + esc((C.SPORT[c.sport] || C.SPORT.other).emoji) + '</span><span class="tn"><b>' + esc(c.name) + '</b>' + (c.members ? '<span>' + esc(plural(c.members, 'regular')) + (c.host ? ' · you host' : '') + '</span>' : '') + '</span><span class="chev" aria-hidden="true">›</span></a></li>';
      }).join('') + '</ul>';
      box.hidden = false;
    });
  }

  /* ---------------- the game tab ---------------- */

  function countdown(ko, now) {
    var ms = ko - now;
    if (ms <= 0) { var ago = Math.round(-ms / 3600000); return ago < 1 ? 'Kicked off just now' : 'Kicked off ' + plural(ago, 'hour') + ' ago'; }
    var h = Math.floor(ms / 3600000);
    if (h < 1) return 'In ' + Math.max(1, Math.round(ms / 60000)) + ' min';
    if (h < 24) return 'In ' + h + 'h ' + Math.round((ms % 3600000) / 60000) + 'm';
    return 'In ' + plural(Math.round(h / 24), 'day');
  }
  function canFor(game, id) {
    var A = actor();
    if (A.host) return true;
    if (id === A.mid) return true;
    var x = game.guests && game.guests[id];
    return Boolean(x && x.by === A.mid);
  }
  function minis(game, id, sel, guest) {
    if (!canFor(game, id)) return '';
    if (guest) return '<span class="minis"><button type="button" class="mini out" data-act="rsvp" data-id="' + esc(id) + '" data-a="out" aria-label="Take ' + esc(nm(game, id)) + ' off the list">Remove</button></span>';
    return '<span class="minis" role="group" aria-label="' + esc(nm(game, id)) + '’s answer">' + ['in', 'maybe', 'out'].map(function (a) {
      return '<button type="button" class="mini ' + a + '" data-act="rsvp" data-id="' + esc(id) + '" data-a="' + a + '" aria-pressed="' + (sel === a) + '">' + ANS[a] + '</button>';
    }).join('') + '</span>';
  }
  function personRow(game, e, chip, sel, extra) {
    var A = actor();
    var guest = e.kind === 'x';
    var sub = guest ? C.guestLabel(state.g, e.x).replace(e.x.name + ' ', '').replace(/^\(|\)$/g, '') : '';
    var m = guest ? null : (e.m || C.memberOf(state.g, e.id));
    var posName = m && m.pos && state.g.usePos ? (sport().positions.filter(function (p) { return p.id === m.pos; })[0] || {}).short : '';
    return '<li class="prow"><span class="pe" aria-hidden="true">' + esc(guest ? '🎟️' : e.emoji || '🙂') + '</span><span class="pn"><b>' + esc(e.name) +
      (e.id === A.mid ? '<span class="you">You</span>' : '') + (m && m.host ? '<span class="pos">Host</span>' : '') + (posName ? '<span class="pos">' + esc(posName) + '</span>' : '') + '</b>' +
      (sub || chip || extra ? '<span>' + (chip || '') + esc(sub) + (extra || '') + '</span>' : '') + '</span>' + minis(game, e.id, sel, guest) + '</li>';
  }
  function gameHtml() {
    var g = state.g; var game = cur(); var now = Date.now(); var A = actor();
    var lu = C.lineup(g, game);
    var ko = C.kickoff(g, game);
    var started = now >= ko;
    var cost = game.cost;
    var html = '<section class="card gamecard"><p class="eyebrow">This week’s game</p>' +
      '<p class="when">' + esc(C.whenLabel(game.date, today())) + ' · ' + esc(C.timeLabel(game.time)) + (C.daysBetween(today(), game.date) > 1 ? ' <span class="muted small">' + esc(C.dateLabel(game.date)) + '</span>' : '') + '</p>' +
      '<p class="meta">' + (game.place ? '<span>📍 ' + esc(game.place) + ' · <a href="' + esc(mapsUrl(game.place)) + '" target="_blank" rel="noopener noreferrer">Directions ↗</a></span>' : '') +
      (cost ? '<span>💵 ' + esc(money(cost)) + ' court · about ' + esc(money(Math.ceil(cost / Math.max(1, Math.max(lu.in.length, Math.min(lu.cap, 2)))))) + ' each</span>' : '') +
      '<span>⏱ ' + esc(countdown(ko, now)) + '</span></p>' +
      '<p class="headline" aria-live="polite">' + esc(C.headline(lu)) + '<small>' + esc([lu.in.length + ' of ' + lu.cap + ' spots', lu.maybe.length ? lu.maybe.length + ' maybe' : '', lu.none.length ? lu.none.length + ' not answered yet' : ''].filter(Boolean).join(' · ')) + '</small></p>' +
      '<div class="meter" aria-hidden="true">' + Array.from({ length: lu.cap }, function (_, i) { return '<i class="' + (i < lu.in.length ? 'f' : '') + '"></i>'; }).join('') + lu.wait.map(function () { return '<i class="w"></i>'; }).join('') + '</div>';
    var logs = Object.keys(game.log || {}).map(function (k) { return game.log[k]; }).sort(function (a, b) { return b.t - a.t; }).slice(0, 2);
    html += logs.map(function (l) { return '<p class="logline"><span aria-hidden="true">🔁</span>' + esc(C.logText(l)) + '</p>'; }).join('');
    if (A.mid && C.memberOf(g, A.mid)) {
      var r = game.rsvps && game.rsvps[A.mid];
      var st = C.statusOf(lu, A.mid);
      var stText = st === 'in' ? '✓ You’re in.' : /^wait/.test(st) ? '⏳ You’re #' + st.slice(4) + ' on the waitlist - you move up if someone drops out.' : st === 'maybe' ? 'Marked maybe.' : st === 'out' ? 'You’re out this week.' : 'You haven’t answered yet.';
      html += '<div class="mine"><p>' + (isOnline() ? 'Are you in?' : 'Are you in, ' + esc(C.memberOf(g, A.mid).name) + '?') + '</p><div class="answer" role="group" aria-label="Your answer">' + ['in', 'maybe', 'out'].map(function (a) {
        return '<button type="button" class="ans ' + a + '" data-act="rsvp" data-id="' + esc(A.mid) + '" data-a="' + a + '" aria-pressed="' + Boolean(r && r.a === a) + '"><span aria-hidden="true">' + ANS_ICON[a] + '</span>' + ANS[a] + '</button>';
      }).join('') + '</div><p class="mystatus">' + esc(stText) + '</p></div>';
    }
    if (started) html += '<div class="kicked"><p>' + (game.teams ? 'Kicked off - add the scores and vote for Player of the Week.' : 'Kicked off - how did it go?') + '</p><button class="btn small light" type="button" data-act="tab" data-tab="season">Results</button>' + (A.host ? '<button class="btn small ghost-light" type="button" data-act="wrapup">Wrap up · open next week</button>' : '') + '</div>';
    html += '<div class="tools"><button type="button" class="tool wide" data-act="sharegame"><span class="ti" aria-hidden="true">📣</span>Share the game</button>' +
      (!started ? '<button type="button" class="tool" data-act="guest"><span class="ti" aria-hidden="true">🎟️</span>Bring a +1</button>' : '') +
      (A.host ? '<button type="button" class="tool" data-act="paste"><span class="ti" aria-hidden="true">📋</span>Paste the group chat</button><button type="button" class="tool" data-act="editgame"><span class="ti" aria-hidden="true">✏️</span>Edit this game</button>' : '') +
      (lu.in.length >= 4 ? '<button type="button" class="tool" data-act="tab" data-tab="teams"><span class="ti" aria-hidden="true">👕</span>' + (game.teams ? 'See the teams' : 'Make teams') + '</button>' : '') +
      '</div></section>';
    // The lists.
    html += '<div class="split">';
    html += '<section><div class="list-head"><h2>In · ' + lu.in.length + '/' + lu.cap + '</h2></div>' + (lu.in.length ? '<ul class="people">' + lu.in.map(function (e) { return personRow(game, e, '', e.kind === 'm' ? 'in' : null); }).join('') + '</ul>' : '<p class="empty">Nobody yet. Share the game and the first In lands here.</p>') + '</section>';
    html += '<section>';
    if (lu.wait.length) html += '<div class="list-head"><h2>Waitlist</h2><span class="small muted">first come, first in</span></div><ul class="people">' + lu.wait.map(function (e, i) { return personRow(game, e, '<span class="chip wait">Waitlist #' + (i + 1) + '</span> ', e.kind === 'm' ? 'in' : null); }).join('') + '</ul>';
    if (lu.maybe.length) html += '<div class="list-head"><h2>Maybe</h2></div><ul class="people">' + lu.maybe.map(function (e) { return personRow(game, e, '', 'maybe'); }).join('') + '</ul>';
    if (lu.none.length) html += '<div class="list-head"><h2>Not answered yet</h2>' + (started ? '' : '<span class="small muted">nudge them</span>') + '</div><ul class="people">' + lu.none.map(function (e) {
      return personRow(game, e, '', null, started ? '' : '<button type="button" class="link-btn nudge" data-act="nudge" data-id="' + esc(e.id) + '" aria-label="Nudge ' + esc(e.name) + '">Nudge ↗</button>');
    }).join('') + '</ul>';
    if (lu.out.length) html += '<details class="fold"><summary><h2>Out · ' + lu.out.length + '</h2></summary><ul class="people">' + lu.out.map(function (e) { return personRow(game, e, '', 'out'); }).join('') + '</ul></details>';
    html += '</section></div>';
    return html;
  }

  /* ---------------- teams ---------------- */

  function teamsHtml() {
    var g = state.g; var game = cur(); var A = actor();
    var lu = C.lineup(g, game);
    var n = lu.in.length;
    var suggest = C.suggestSides(n, g.perSide);
    var sides = state.sides || (game.teams ? game.teams.sides.length : suggest);
    var seg = '<div class="seg" role="radiogroup" aria-label="How many teams">' + [2, 3, 4].map(function (s) {
      var per = Math.floor(n / s);
      return '<button type="button" class="segb" role="radio" data-act="sides" data-v="' + s + '" aria-checked="' + (sides === s) + '"' + (n < s * 2 ? ' disabled' : '') + '>' + s + ' teams' + (n >= s * 2 ? ' of ' + per + (n % s ? '-' + (per + 1) : '') : '') + '</button>';
    }).join('') + '</div>';
    var html = '';
    if (!game.teams) {
      html += '<section class="card"><h2>Fair teams</h2><p>From the ' + plural(n, 'player') + ' who are in, balanced by skill' + (g.usePos && sport().positions.length ? ', with ' + esc(sport().positions[0].name.toLowerCase()) + 's spread out' : '') + ', keeping your split and together pairs, and not last week’s teams again where it can be helped.</p>';
      if (n < 4) html += '<p class="note">Teams need at least 4 in. ' + (n ? 'You’re at ' + n + '.' : '') + '</p>';
      else if (A.host) html += seg + '<button class="btn block big" type="button" data-act="maketeams">⚖️ Make teams</button><p class="small muted" style="margin-top:8px">Skill is each person’s own 1-5 (you can adjust anyone’s in Group). Only you see the numbers.</p>';
      else html += '<p class="note">The host makes the teams - they’ll show up here.</p>';
      return html + '</section>';
    }
    var t = game.teams;
    var sums = A.host && !isOnline() ? C.teamSums(g, game) : A.host ? hostSums(game) : null;
    html += '<section class="card"><div class="sec-head"><p class="gapline"><span aria-hidden="true">⚖️</span>' + esc(C.gapText(t.gap)) + '</p>' + (t.n ? '<span class="small muted">reshuffle ' + t.n + '</span>' : '') + '</div>';
    if (C.teamsStale(g, game)) html += '<p class="warn">⚠️ The line-up changed since these were made.' + (A.host ? ' <button class="link-btn" type="button" data-act="maketeams">Remake teams</button>' : '') + '</p>';
    if (t.broken) html += '<p class="warn">Couldn’t keep every split/together pair - ' + plural(t.broken, 'pair') + ' broken to keep it even.</p>';
    if (t.posOff) html += '<p class="warn">The ' + esc((sport().positions[0] || { name: 'position' }).name.toLowerCase()) + 's couldn’t be spread evenly this week.</p>';
    if (t.same) html += '<p class="warn">Same teams as last week - nothing else was as even.</p>';
    html += '<div class="teams">' + t.sides.map(function (ids, i) {
      var team = C.TEAMS[i];
      return '<div class="team"><h3><span class="bib" style="background:' + esc(team.hex) + '" aria-hidden="true"></span>' + esc(team.name) + (sums ? '<span class="sum" title="Skill total - only you see this">skill ' + sums[i] + '</span>' : '') + '</h3><ul>' + ids.map(function (id) {
        var m = C.memberOf(g, id);
        var posName = m && m.pos && g.usePos ? (sport().positions.filter(function (p) { return p.id === m.pos; })[0] || {}).short : '';
        return '<li><span aria-hidden="true">' + esc(m ? m.emoji : '🎟️') + '</span>' + esc(nm(game, id)) + (id === A.mid ? '<span class="you">You</span>' : '') + (posName ? '<span class="pos">' + esc(posName) + '</span>' : '') + '</li>';
      }).join('') + '</ul></div>';
    }).join('') + '</div>';
    if (t.sides.length >= 3) {
      var rot = C.rotation(t.sides.length, C.matchList(game));
      html += '<div class="note" style="margin-top:12px"><p class="eyebrow">Winner stays on · ' + C.STAY_MAX + ' games max</p><p class="rot">' + teamTag(rot.on[0]) + '<span class="vs">vs</span>' + teamTag(rot.on[1]) + '</p><p class="small muted" style="margin:0">Next up: ' + rot.queue.map(function (q) { return esc(C.TEAMS[q].name); }).join(', then ') + (rot.streak ? ' · ' + esc(C.TEAMS[rot.streak.team].name) + ' has won ' + plural(rot.streak.wins, 'in a row', 'in a row') : '') + '</p></div>';
    }
    html += '<div class="row" style="margin-top:12px"><button class="btn" type="button" data-act="shareteams">📣 Share the teams</button>' + (A.host ? '<button class="btn ghost" type="button" data-act="reshuffle">🔀 Reshuffle</button>' : '') + '</div>';
    if (A.host) html += '<details class="fold" style="margin-top:8px"><summary><span class="small"><b>More</b> - a different number of teams, or clear them</span></summary>' + seg + '<div class="row" style="margin-top:8px"><button class="btn ghost" type="button" data-act="maketeams">Make ' + sides + ' teams</button><button class="btn ghost danger" type="button" data-act="clearteams">Clear teams</button></div></details>';
    return html + '</section>';
  }
  function teamTag(i) { var tm = C.TEAMS[i]; return '<span class="chip plain"><span class="bib" style="background:' + esc(tm.hex) + ';width:14px;height:14px" aria-hidden="true"></span>' + esc(tm.name) + '</span>'; }
  /** Online, the host's view carries everyone's numbers, so the core can sum them. */
  function hostSums(game) { return C.teamSums(state.g, game); }

  /* ---------------- season ---------------- */

  function potwGame() {
    var g = state.g; var now = Date.now();
    var list = C.games(g).filter(function (x) { return C.started(g, x, now) && C.playedIds(g, x).length >= 2; });
    return list.length ? list[list.length - 1] : null;
  }
  function matchSummary(game) {
    var wins = {};
    var ms = C.matchList(game);
    ms.forEach(function (m) { if (m.w === 'a') wins[m.a] = (wins[m.a] || 0) + 1; else if (m.w === 'b') wins[m.b] = (wins[m.b] || 0) + 1; });
    if (!ms.length) return '';
    var ks = Object.keys(wins).sort(function (a, b) { return wins[b] - wins[a]; });
    if (!ks.length) return plural(ms.length, 'game') + ', all drawn';
    if (game.teams.sides.length === 2) {
      var a = wins[0] || 0, b = wins[1] || 0;
      return a === b ? 'Shared the spoils ' + a + '-' + b : C.TEAMS[a > b ? 0 : 1].name + ' won ' + Math.max(a, b) + '-' + Math.min(a, b);
    }
    return C.TEAMS[ks[0]].name + ' won the most (' + wins[ks[0]] + ')';
  }
  function seasonHtml() {
    var g = state.g; var game = cur(); var A = actor(); var now = Date.now();
    var html = '<div class="split">';
    // This week's results.
    html += '<section class="card"><h2>' + (C.started(g, game, now) ? 'Tonight’s results' : 'This week’s results') + '</h2>';
    if (!game.teams) html += '<p class="muted">Results go with the teams - make them on the Teams tab, then add each game’s score here.</p>';
    else if (!C.started(g, game, now) && !C.matchList(game).length) html += '<p class="muted">The teams are ready. Scores go in here once you’re playing - a score, or just who won.</p>';
    else {
      var ms = C.matchList(game);
      html += ms.length ? '<ul class="matches">' + ms.map(function (m) {
        var canDel = A.host || m.by === A.mid;
        var score = m.sa !== null && m.sa !== undefined ? '<span class="sc">' + m.sa + ' - ' + m.sb + '</span>' : '<span class="sc">' + (m.w === 'd' ? 'Draw' : 'Win') + '</span>';
        return '<li>' + teamTag(m.a) + score + teamTag(m.b) + '<span class="small muted" style="flex:1">' + (m.w === 'd' ? 'draw' : esc(C.TEAMS[m.w === 'a' ? m.a : m.b].name) + ' won') + '</span>' + (canDel ? '<button class="mini" type="button" data-act="unmatch" data-rid="' + esc(m.id) + '" aria-label="Remove this result">✕</button>' : '') + '</li>';
      }).join('') + '</ul>' : '<p class="muted small">No scores yet. Games to 11? Add each one as it finishes.</p>';
      var S2 = game.teams.sides.length;
      var on = C.rotation(S2, ms).on;
      html += '<form id="scoreForm" autocomplete="off"><input type="hidden" name="a" value="' + on[0] + '"><input type="hidden" name="b" value="' + on[1] + '">' +
        (S2 > 2 ? '<p class="small muted" style="margin:0 0 6px">Next up: ' + esc(C.TEAMS[on[0]].name) + ' vs ' + esc(C.TEAMS[on[1]].name) + '</p>' : '') +
        '<div class="scoreform"><label>' + esc(C.TEAMS[on[0]].name) + '<input class="input" name="sa" inputmode="numeric" pattern="[0-9]*" maxlength="3" aria-label="' + esc(C.TEAMS[on[0]].name) + ' score"></label><span class="dash">-</span><label>' + esc(C.TEAMS[on[1]].name) + '<input class="input" name="sb" inputmode="numeric" pattern="[0-9]*" maxlength="3" aria-label="' + esc(C.TEAMS[on[1]].name) + ' score"></label></div>' +
        '<button class="btn block" type="submit">Save score</button>' +
        '<p class="small muted" style="margin:12px 0 6px">No score kept? Just say who won:</p><div class="quick3"><button class="btn small ghost" type="button" data-act="quickwin" data-w="a">' + esc(C.TEAMS[on[0]].name) + ' won</button><button class="btn small ghost" type="button" data-act="quickwin" data-w="d">Draw</button><button class="btn small ghost" type="button" data-act="quickwin" data-w="b">' + esc(C.TEAMS[on[1]].name) + ' won</button></div><div id="scoreErr"></div></form>';
    }
    html += '</section>';
    // Player of the Week.
    var pg = potwGame();
    if (pg) {
      var pw = C.potw(g, pg, now, A.mid);
      html += '<section class="card potw"><p class="eyebrow">Player of the Week · ' + esc(C.dateLabel(pg.date)) + '</p>';
      if (pw.closed && pw.winners.length) {
        html += '<div class="trophy"><span class="tb" aria-hidden="true">🏅</span><div><b>' + esc(C.nameList(pw.winners.map(function (id) { return nm(pg, id); }))) + '</b><p class="muted small" style="margin:0">' + plural(pw.top, 'vote') + (pw.winners.length > 1 ? ' each - shared' : '') + ' · ' + plural(Object.keys(pw.tally).reduce(function (s, k) { return s + pw.tally[k]; }, 0), 'vote') + ' in all</p></div></div>';
      } else if (pw.closed) {
        html += '<p class="muted">Nobody voted that week.</p>';
      } else if (pw.open) {
        var voter = isOnline() ? A.mid : (state.voter && pw.voters.indexOf(state.voter) >= 0 ? state.voter : (pw.voters.filter(function (v) { return !(pg.votes && pg.votes[v]); })[0] || pw.voters[0]));
        var mine = isOnline() ? pw.mine : (pg.votes && pg.votes[voter]) || null;
        var closes = new Date(pw.closesAt);
        html += '<h2>Who stood out?</h2><p class="small muted">One vote each for the regulars who played. Secret until voting closes ' + esc(C.WEEKDAY_NAMES[(closes.getDay() + 6) % 7]) + ' - ' + pw.count + ' of ' + pw.voters.length + ' voted so far.</p>';
        if (!isOnline()) html += '<label class="field"><span>Voting as</span><select class="input" id="voterSel">' + pw.voters.map(function (v) { return '<option value="' + esc(v) + '"' + (v === voter ? ' selected' : '') + '>' + esc(nm(pg, v)) + (pg.votes && pg.votes[v] ? ' ✓' : '') + '</option>'; }).join('') + '</select></label>';
        if (pw.voters.indexOf(voter) >= 0) {
          html += '<div class="cands" role="group" aria-label="Your vote">' + pw.played.filter(function (id) { return id !== voter; }).map(function (id) {
            return '<button type="button" class="cand" data-act="vote" data-gid="' + esc(pg.id) + '" data-voter="' + esc(voter) + '" data-cand="' + esc(id) + '" aria-pressed="' + (mine === id) + '">' + esc(nm(pg, id)) + '</button>';
          }).join('') + '</div>';
        } else html += '<p class="note">Only the regulars who played that week vote.</p>';
        if (A.host) html += '<button class="btn ghost block" type="button" data-act="closevotes" data-gid="' + esc(pg.id) + '">Close voting and reveal</button>';
      } else html += '<p class="muted">Voting needs at least two regulars who played.</p>';
      html += '</section>';
    }
    // Standings.
    var st = C.standings(g, now);
    html += '<section class="card full"><div class="sec-head"><h2>The season</h2><span class="small muted">' + plural(st.games, 'week') + ' played · most wins first</span></div>';
    var rows = st.rows.filter(function (r) { return r.games > 0; });
    if (!rows.length) html += '<p class="muted">Standings start after the first game: wins, win %, streaks, who turns up, and Player of the Week.</p>';
    else html += '<ol class="table">' + rows.map(function (r, i) {
      var bits = [plural(r.games, 'game'), 'came ' + r.came + ' of the last ' + r.of];
      if (r.potw) bits.push('🏅×' + r.potw);
      var stx = C.streakText(r.streak);
      return '<li class="trow"><span class="rk">' + (i + 1) + '</span><span class="pe" aria-hidden="true">' + esc(r.emoji) + '</span><span class="tn"><b>' + esc(r.name) + (r.id === A.mid ? '<span class="you">You</span>' : '') + '</b><span>' + esc(bits.join(' · ')) + (stx ? ' · ' + esc(stx) : '') + '</span></span><span class="wl"><b>' + r.w + '-' + r.l + (r.d ? '-' + r.d : '') + '</b><span>' + (r.pct === null ? '-' : r.pct + '% won') + '</span></span></li>';
    }).join('') + '</ol><p class="small muted" style="margin-top:8px">Wins and losses count each game played, by whoever was on the team.</p>';
    html += '</section>';
    // Past weeks.
    var past = C.games(g).filter(function (x) { return C.started(g, x, now) && x !== game; }).reverse();
    if (past.length) {
      html += '<section class="card full"><h2>Past weeks</h2><ul class="weeks">' + past.map(function (x) {
        var pw2 = C.potw(g, x, now, null);
        return '<li><div class="wd">' + esc(C.dateLabel(x.date)) + '<span>' + plural(C.playedIds(g, x).length, 'player') + '</span></div><div class="small">' + esc(x.teams ? matchSummary(x) || 'No scores' : 'No teams') + (pw2.closed && pw2.winners.length ? ' · 🏅 ' + esc(C.nameList(pw2.winners.map(function (id) { return nm(x, id); }))) : '') + '</div></li>';
      }).join('') + '</ul></section>';
    }
    return html + '</div>';
  }
  function saveScore(f) {
    var game = cur();
    var body = { a: Number(f.a.value), b: Number(f.b.value), sa: f.sa.value.trim(), sb: f.sb.value.trim() };
    if (!body.sa || !body.sb) return showError(new Error('Add both scores - or tap who won.'), $('#scoreErr'));
    doRun('match', { gid: game.id, body: body }, { errBox: $('#scoreErr') }).then(function () { pop($('#scoreForm .btn'), '🏆'); }).catch(function () {});
  }

  /* ---------------- money ---------------- */

  function moneyHtml() {
    var g = state.g; var A = actor(); var now = Date.now();
    var m = C.money(g, now);
    var col = C.collectorOf(g);
    var game = cur();
    var html = '<section class="card"><h2>Court money</h2><p class="small muted">Pickup keeps the list - it never holds or moves money. Everyone pays ' + esc(col ? col.name : 'the host') + ' the way you always do.</p>';
    html += '<p class="owed">' + (m.outstanding ? esc(money(m.outstanding)) + ' <span class="small muted">still owed</span>' : 'Everyone’s paid up 🎉') + '</p>';
    if (m.owes.length) {
      html += '<ul class="oweslist">' + m.owes.map(function (o) {
        var mem = C.memberOf(g, o.id);
        var can = A.host || o.id === A.mid;
        return '<li><span class="pe" aria-hidden="true">' + esc(mem ? mem.emoji : '🙂') + '</span><span class="pn"><b>' + esc(mem ? mem.name : 'Someone') + (o.id === A.mid ? '<span class="you">You</span>' : '') + '</b><span>' + esc(o.games.map(function (x) { return C.shortDate(x.date); }).join(', ')) + '</span></span><span class="chip owe">Owes ' + esc(money(o.cents)) + '</span>' + (can ? '<button class="tick" type="button" data-act="paidall" data-pid="' + esc(o.id) + '">Mark paid</button>' : '') + '</li>';
      }).join('') + '</ul>';
      var txt = C.reminderText(g, m);
      html += '<p class="copybox">' + esc(txt) + '</p><div class="row"><button class="btn" type="button" data-act="sharemoney">📣 Share reminder</button><button class="btn ghost" type="button" data-act="copymoney">Copy</button></div>';
    }
    html += '</section>';
    if (game.cost && !C.started(g, game, now)) {
      var n = Math.max(2, C.lineup(g, game).in.length);
      html += '<section class="card"><p class="eyebrow">This week</p><p style="margin:0">' + esc(money(game.cost)) + ' for the court, split among whoever plays - about <b>' + esc(money(Math.ceil(game.cost / n))) + '</b> each with ' + n + '. It lands here at kickoff.</p></section>';
    }
    if (m.weeks.length) {
      html += '<section class="card"><h2>Week by week</h2>' + m.weeks.slice(0, 8).map(function (w, i) {
        var gm = state.g.games[w.id];
        return '<details class="fold"' + (i === 0 ? ' open' : '') + '><summary><span><b>' + esc(C.dateLabel(w.date)) + '</b> <span class="small muted">' + esc(money(w.cost)) + ' · ' + plural(w.players, 'player') + (w.owing ? ' · ' + esc(money(w.owing)) + ' owed' : ' · all paid') + '</span></span></summary>' +
          w.rows.map(function (r) {
            var mem = C.memberOf(g, r.id);
            var isCol = col && col.id === r.id;
            var can = !isCol && (A.host || r.id === A.mid);
            var guests = Object.keys(gm.guests || {}).filter(function (x) { return gm.guests[x].by === r.id && C.playedIds(g, gm).indexOf(x) >= 0; }).length;
            return '<div class="paidrow"><span class="pn">' + esc(mem ? mem.name : 'Someone') + (guests ? ' <span class="small muted">+ ' + plural(guests, 'guest') + '</span>' : '') + '</span><span class="small">' + esc(money(r.cents)) + '</span>' +
              (isCol ? '<span class="chip plain">Paid the court</span>' : '<button class="tick" type="button" data-act="paid" data-gid="' + esc(w.id) + '" data-pid="' + esc(r.id) + '" aria-pressed="' + r.paid + '"' + (can ? '' : ' disabled') + '>' + (r.paid ? 'Paid ✓' : can ? 'Mark paid' : 'Not yet') + '</button>') + '</div>';
          }).join('') + '</details>';
      }).join('') + '</section>';
    } else {
      html += '<section class="card"><p class="muted" style="margin:0">After the first game with a court cost, who owes what shows here - split among who actually played, to the cent.</p></section>';
    }
    if (A.host) {
      html += '<section class="card"><h2>Who paid the court?</h2><label class="field"><span class="vh">Who paid the court</span><select class="input" id="collector">' + g.members.map(function (mm) {
        return '<option value="' + esc(mm.id) + '"' + (col && col.id === mm.id ? ' selected' : '') + '>' + esc(mm.name) + '</option>';
      }).join('') + '</select></label><p class="small muted">Their share counts as paid. The court cost per game is in Edit this game, or the group’s schedule.</p></section>';
    }
    return html;
  }

  /* ---------------- group ---------------- */

  function skillPicker(sel, act, mid) {
    return '<div class="skills" role="radiogroup" aria-label="Skill">' + C.SKILLS.map(function (s) {
      return '<button type="button" class="skb" role="radio" data-act="' + act + '" data-mid="' + esc(mid || '') + '" data-v="' + s.n + '" aria-checked="' + (sel === s.n) + '"><b>' + s.n + '</b><span>' + esc(s.label) + '</span></button>';
    }).join('') + '</div>';
  }
  function groupHtml() {
    var g = state.g; var A = actor();
    var html = '<div class="split">';
    if (isOnline()) {
      html += '<section class="card"><h2>Invite the group</h2><div class="invgrid"><button class="qr" type="button" data-act="qrbig" aria-label="Show the QR code full screen" id="qrSmall"></button><div><p class="code">' + esc(g.display) + '</p><p class="small muted">Friends open the link or type the code - just their name, no app, no account.</p><div class="row"><button class="btn small" type="button" data-act="sharejoin">Share link</button><button class="btn small ghost" type="button" data-act="copyjoin">Copy</button></div></div></div></section>';
    } else if (isLocal()) {
      html += '<section class="card online-cta"><h2>Let everyone answer from their phone</h2><p>Right now ' + esc(g.name) + ' lives on this phone and you tap answers in for everyone. Put it online and each regular taps In or Out from a link - no app, no account. You’ll need a free account to host it.</p><button class="btn block" type="button" data-act="goonline">Put it online</button></section>';
    } else {
      html += '<section class="card online-cta"><h2>Run your own game like this</h2><p>Start a group on this phone in a minute, then put it online so everyone answers from a link.</p><button class="btn block" type="button" data-act="startown">Start your own group</button></section>';
    }
    var me = A.mid ? C.memberOf(g, A.mid) : null;
    if (me) {
      var pos = sport().positions;
      html += '<section class="card"><div class="sec-head"><h2>' + esc(me.emoji) + ' ' + esc(me.name) + (isOnline() ? '' : ' <span class="small muted">(you)</span>') + '</h2><button class="btn small ghost" type="button" data-act="editme">Name &amp; emoji</button></div>' +
        '<p style="margin:6px 0"><b>How good are you?</b> <span class="small muted">Only you and the host see this - it’s what makes the teams even.</span></p>' + skillPicker(me.skill || null, 'myskill', me.id) +
        (pos.length && g.usePos ? '<p style="margin:12px 0 6px"><b>Position</b></p><div class="seg" role="radiogroup" aria-label="Position"><button type="button" class="segb" role="radio" data-act="mypos" data-v="" aria-checked="' + !me.pos + '">Anywhere</button>' + pos.map(function (p) { return '<button type="button" class="segb" role="radio" data-act="mypos" data-v="' + esc(p.id) + '" aria-checked="' + (me.pos === p.id) + '">' + esc(p.name) + '</button>'; }).join('') + '</div>' : '') +
        '</section>';
    }
    html += '<section class="card full"><div class="sec-head"><h2>Regulars · ' + g.members.length + '</h2>' + (A.host ? '<span class="small muted">skill: theirs → yours</span>' : '') + '</div><ul class="people">' + g.members.map(function (m) {
      var bits = [];
      if (isOnline() && !m.joined && !m.host) bits.push('hasn’t opened the link yet');
      if (A.host && (m.skill || m.adj)) bits.push('skill ' + (m.skill || '-') + (m.adj ? ' → ' + m.adj : ''));
      var posName = m.pos && g.usePos ? (sport().positions.filter(function (p) { return p.id === m.pos; })[0] || {}).name : '';
      if (posName) bits.push(posName);
      return '<li class="prow"><span class="pe" aria-hidden="true">' + esc(m.emoji) + '</span><span class="pn"><b>' + esc(m.name) + (m.id === A.mid ? '<span class="you">You</span>' : '') + (m.host ? '<span class="pos">Host</span>' : '') + '</b>' + (bits.length ? '<span>' + esc(bits.join(' · ')) + '</span>' : '') + '</span>' +
        (A.host && m.id !== A.mid ? '<button class="mini" type="button" data-act="editmember" data-mid="' + esc(m.id) + '">Edit</button>' : '') + '</li>';
    }).join('') + '</ul>';
    if (A.host) html += '<form id="addRegs" class="field" style="margin-top:14px"><span>Add regulars</span><textarea class="input" id="regNames" rows="3" style="min-height:84px" placeholder="Names, one per line or with commas" maxlength="1200"></textarea><button class="btn ghost" type="submit">Add</button></form>';
    html += '</section>';
    if (A.host) {
      html += '<section class="card"><h2>The game</h2><p class="small muted" style="margin:0">' + esc(sport().name) + ' · ' + g.perSide + ' a side · ' + esc(schedLine(g)) + (g.sched.cost ? ' · ' + esc(money(g.sched.cost)) + ' a game' : '') + '</p><button class="btn ghost block" type="button" data-act="editgroup">Day, time, place, cap and cost</button></section>';
      var lines = g.lines || [];
      html += '<section class="card"><h2>Split up or keep together</h2><p class="small muted">Brothers who argue, a car share, the two best players. Only you see these.</p>' +
        (lines.length ? '<ul class="lines">' + lines.map(function (l, i) { return '<li><span>' + esc((C.memberOf(g, l.a) || {}).name) + (l.k === 'apart' ? ' ↔ apart from ' : ' + together with ') + esc((C.memberOf(g, l.b) || {}).name) + '</span><button class="mini" type="button" data-act="rmline" data-i="' + i + '" aria-label="Remove">✕</button></li>'; }).join('') + '</ul>' : '') +
        '<form id="lineForm" class="twocol" style="margin-top:8px"><select class="input" id="lineA" aria-label="First person">' + g.members.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>'; }).join('') + '</select><select class="input" id="lineB" aria-label="Second person">' + g.members.map(function (m, i) { return '<option value="' + esc(m.id) + '"' + (i === 1 ? ' selected' : '') + '>' + esc(m.name) + '</option>'; }).join('') + '</select><select class="input" id="lineK" aria-label="Apart or together"><option value="apart">Always apart</option><option value="together">Always together</option></select><button class="btn ghost" type="submit">Add</button></form></section>';
    }
    html += '<section class="card"><h2>' + (A.host ? 'Danger zone' : 'Leave') + '</h2>' + (isOnline() && A.host ? '<button class="btn ghost block" type="button" data-act="rotate">New code (old link stops working)</button>' : '') +
      (isOnline() && !A.host ? '<button class="btn ghost block danger" type="button" data-act="leave">Leave ' + esc(g.name) + '</button>' : '') +
      (A.host && !isExample() ? '<button class="btn ghost block danger" type="button" data-act="delgroup">' + (isLocal() ? 'Clear it from this phone' : 'Delete the group for everyone') + '</button>' : '') + (isExample() ? '<p class="muted small">It’s the example - nothing to delete.</p>' : '') + '</section>';
    return html + '</div>';
  }

  /* ---------------- sheets ---------------- */

  function sportGrid(sel) {
    return '<div class="sports" role="radiogroup" aria-label="Sport">' + C.SPORTS.map(function (s) {
      return '<button type="button" class="sport" role="radio" data-act="sport" data-v="' + s.id + '" aria-checked="' + (sel === s.id) + '"><span class="se" aria-hidden="true">' + s.emoji + '</span>' + esc(s.name) + '</button>';
    }).join('') + '</div>';
  }
  function emojiGrid(selected, taken) {
    return '<div class="emojis" role="radiogroup" aria-label="Emoji">' + C.EMOJI.map(function (e) {
      return '<button type="button" class="emo' + (taken && taken.indexOf(e) >= 0 && e !== selected ? ' taken' : '') + '" role="radio" data-act="emo" data-emo="' + e + '" aria-checked="' + (e === selected) + '">' + e + '</button>';
    }).join('') + '</div>';
  }
  function dayOptions(sel) { return C.WEEKDAY_NAMES.map(function (d, i) { return '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + d + 's</option>'; }).join(''); }
  function curOptions(sel) { return C.CURRENCIES.map(function (c) { return '<option value="' + c + '"' + (c === sel ? ' selected' : '') + '>' + c + '</option>'; }).join(''); }

  /** Start a group: name, sport (which sets the defaults), when, where, cap,
   *  cost, your name, and the regulars. Lives on this phone. */
  function openNewGroup() {
    var guessCur = /^Europe\/London/.test(TZ) ? 'GBP' : /^Europe\//.test(TZ) ? 'EUR' : /^Australia\//.test(TZ) ? 'AUD' : 'USD';
    var f = { sport: 'basketball' };
    sheet('<h2>Start a group</h2><p class="small muted">It lives on this phone - no account. Put it online later so everyone answers from a link.</p><form id="ngForm" autocomplete="off">' +
      '<div class="field"><span>Sport</span>' + sportGrid(f.sport) + '</div>' +
      '<label class="field"><span>Group name</span><input class="input" name="name" maxlength="40" placeholder="Thursday Hoops" required></label>' +
      '<div class="twocol"><label class="field"><span>Every</span><select class="input" name="wd">' + dayOptions((new Date().getDay() + 6) % 7) + '</select></label><label class="field"><span>At</span><input class="input" name="time" type="time" value="19:00" required></label></div>' +
      '<label class="field"><span>Where <span class="hint">(gives everyone a maps link)</span></span><input class="input" name="place" maxlength="80" placeholder="Riverside Rec Center"></label>' +
      '<div class="twocol"><label class="field"><span>Cap <span class="hint">(then a waitlist)</span></span><input class="input" name="cap" inputmode="numeric" value="10" maxlength="2"></label><label class="field"><span>Court cost <span class="hint">per game</span></span><input class="input" name="cost" inputmode="decimal" placeholder="60" maxlength="8"></label></div>' +
      '<label class="field"><span>Currency</span><select class="input" name="cur">' + curOptions(guessCur) + '</select></label>' +
      '<label class="field"><span>Your name</span><input class="input" name="me" maxlength="24" autocomplete="given-name" required></label>' +
      '<label class="field"><span>The regulars <span class="hint">(optional - names, one per line; add more any time)</span></span><textarea class="input" name="regs" rows="4" style="min-height:110px" maxlength="1200" placeholder="Sam&#10;Jo&#10;Mia"></textarea></label>' +
      '<div id="ngErr"></div><button class="btn block big" type="submit">Start the group</button></form>', function (root) {
      root.__pick = f;
      root.__sport = function () {
        var sp = C.SPORT[f.sport];
        var cap = $('[name=cap]', root);
        cap.value = sp.cap;
        var nmIn = $('[name=name]', root);
        nmIn.placeholder = { basketball: 'Thursday Hoops', football: 'Sunday Five-a-side', volleyball: 'Beach Volley Crew', pickleball: 'Pickleball Mornings', ultimate: 'Wednesday Ultimate', padel: 'Padel Club', other: 'The Weekly Game' }[f.sport];
      };
      $('#ngForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var x = e.target;
        try {
          var g = C.newGroup({ name: x.name.value, sport: f.sport, me: x.me.value, wd: Number(x.wd.value), time: x.time.value, place: x.place.value, cap: Number(x.cap.value) || undefined, cost: x.cost.value, cur: x.cur.value, regulars: x.regs.value }, { tz: TZ, now: Date.now() });
          keep(K_LOCAL, g);
          closeSheet(true);
          toast('Your group is ready. Share the game, or tap answers in.');
          go('game');
        } catch (err) { showError(err, $('#ngErr', root)); }
      });
    });
  }
  function openJoinCode() {
    var list = recall(K_LIST) || [];
    sheet('<h2>Join a group</h2><p class="small muted">Type the six characters under their QR code, or open the link they sent.</p><form id="codeForm"><input class="input code-in" name="code" maxlength="7" autocapitalize="characters" autocomplete="off" placeholder="ABC-123" aria-label="Code" style="text-transform:uppercase;letter-spacing:.1em;font-weight:800;text-align:center;font-size:1.3rem"><button class="btn block" type="submit">Find the group</button></form>' +
      (list.length ? '<h3>Groups on this phone</h3><ul class="tlist">' + list.map(function (c) { return '<li><a href="' + esc(BASE + 'g/' + c.id) + '"><b>' + esc(c.name) + '</b></a></li>'; }).join('') + '</ul>' : ''), function (root) {
      $('#codeForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var c = e.target.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (c.length !== 6) return toast('A code is six characters.');
        location.href = BASE + 'j/' + c;
      });
    });
  }
  function openMakeYours(reason) {
    var local = recall(K_LOCAL);
    sheet('<h2>Make it yours</h2><p class="muted">' + esc(reason || '') + ' Your own group takes a minute, with no account.</p>' +
      (local ? '<button type="button" class="btn block big" data-act="openlocal">Open ' + esc(C.clean(local.name, 40)) + '</button>' : '<button type="button" class="btn block big" data-act="newgroup">Start a group</button>') +
      '<button type="button" class="btn ghost block" data-act="joincode">Join with a code</button><button type="button" class="btn ghost block" data-act="closesheet">Keep looking around</button>');
  }
  function openGuest() {
    var g = state.g; var A = actor(); var game = cur();
    var f = { skill: null };
    sheet('<h2>Bring a +1</h2><p class="small muted">A guest takes a spot like anyone - first come, first served. If it’s full they wait on the list.</p><form id="gForm" autocomplete="off">' +
      (A.host ? '<label class="field"><span>Who’s bringing them?</span><select class="input" name="by">' + g.members.map(function (m) { return '<option value="' + esc(m.id) + '"' + (m.id === A.mid ? ' selected' : '') + '>' + esc(m.name) + '</option>'; }).join('') + '</select></label>' : '') +
      '<label class="field"><span>Their name</span><input class="input" name="name" maxlength="24" required></label>' +
      '<div class="field"><span>About how good? <span class="hint">(optional - for even teams; only the host sees it)</span></span>' + skillPicker(null, 'gskill') + '</div>' +
      '<div id="gErr"></div><button class="btn block big" type="submit">Add them</button></form>', function (root) {
      root.__pick = f;
      $('#gForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        doRun('guest', { gid: game.id, name: e.target.name.value, skill: f.skill, by: e.target.by ? e.target.by.value : undefined }, { errBox: $('#gErr', root), close: true }).catch(function () {});
      });
    });
  }
  function openEditGame() {
    var game = cur();
    sheet('<h2>This week’s game</h2><p class="small muted">Just this week. The usual day, time and cost are in Group.</p><form id="egForm" autocomplete="off">' +
      '<div class="twocol"><label class="field"><span>Date</span><input class="input" type="date" name="date" value="' + esc(game.date) + '"></label><label class="field"><span>Time</span><input class="input" type="time" name="time" value="' + esc(game.time) + '"></label></div>' +
      '<label class="field"><span>Where</span><input class="input" name="place" maxlength="80" value="' + esc(game.place) + '"></label>' +
      '<div class="twocol"><label class="field"><span>Cap</span><input class="input" name="cap" inputmode="numeric" maxlength="2" value="' + esc(game.cap) + '"></label><label class="field"><span>Court cost</span><input class="input" name="cost" inputmode="decimal" maxlength="8" value="' + esc(game.cost ? String(game.cost / 100) : '') + '"></label></div>' +
      '<div id="egErr"></div><button class="btn block big" type="submit">Save</button></form>', function (root) {
      $('#egForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var x = e.target;
        var cost = x.cost.value.trim() ? C.moneyIn(x.cost.value) : 0;
        if (cost === null) return showError(new Error('That cost doesn’t look right.'), $('#egErr', root));
        doRun('editGame', { gid: game.id, body: { date: x.date.value, time: x.time.value, place: x.place.value, cap: Number(x.cap.value), cost: cost } }, { errBox: $('#egErr', root), close: true }).catch(function () {});
      });
    });
  }
  function openEditGroup() {
    var g = state.g; var s = g.sched;
    var f = { sport: g.sport };
    sheet('<h2>The game, every week</h2><form id="grForm" autocomplete="off">' +
      '<label class="field"><span>Group name</span><input class="input" name="name" maxlength="40" value="' + esc(g.name) + '"></label>' +
      '<div class="field"><span>Sport</span>' + sportGrid(g.sport) + '</div>' +
      '<div class="twocol"><label class="field"><span>Every</span><select class="input" name="wd">' + dayOptions(s.wd) + '</select></label><label class="field"><span>At</span><input class="input" type="time" name="time" value="' + esc(s.time) + '"></label></div>' +
      '<label class="field"><span>Where</span><input class="input" name="place" maxlength="80" value="' + esc(s.place) + '"></label>' +
      '<div class="twocol"><label class="field"><span>Cap</span><input class="input" name="cap" inputmode="numeric" maxlength="2" value="' + esc(s.cap) + '"></label><label class="field"><span>Court cost</span><input class="input" name="cost" inputmode="decimal" maxlength="8" value="' + esc(s.cost ? String(s.cost / 100) : '') + '"></label></div>' +
      '<div class="twocol"><label class="field"><span>Players a side</span><input class="input" name="perSide" inputmode="numeric" maxlength="2" value="' + esc(g.perSide) + '"></label><label class="field"><span>Currency</span><select class="input" name="cur">' + curOptions(g.cur) + '</select></label></div>' +
      (C.sportOf(g).positions.length ? '<label class="pick"><input type="checkbox" name="usePos"' + (g.usePos ? ' checked' : '') + '><span class="gb"><b>Spread the ' + esc(C.sportOf(g).positions[0].name.toLowerCase()) + 's</b><span>Teams get one each where they can</span></span></label>' : '') +
      '<p class="small muted">Changes apply to this week’s game too if it hasn’t kicked off.</p><div id="grErr"></div><button class="btn block big" type="submit">Save</button></form>', function (root) {
      root.__pick = f;
      root.__sport = function () {};
      $('#grForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var x = e.target;
        var cost = x.cost.value.trim() ? C.moneyIn(x.cost.value) : 0;
        if (cost === null) return showError(new Error('That cost doesn’t look right.'), $('#grErr', root));
        var body = { name: x.name.value, sched: { wd: Number(x.wd.value), time: x.time.value, place: x.place.value, cap: Number(x.cap.value), cost: cost }, cur: x.cur.value, perSide: Number(x.perSide.value) };
        if (f.sport !== g.sport) body.sport = f.sport;
        if (x.usePos && f.sport === g.sport) body.usePos = x.usePos.checked;
        doRun('editGroup', { body: body }, { errBox: $('#grErr', root), close: true }).catch(function () {});
      });
    });
  }
  function nameSheet(title, lead, cta, initial, taken, then) {
    var pick = { emoji: initial.emoji };
    sheet('<h2>' + esc(title) + '</h2><p class="small muted">' + esc(lead) + '</p><form id="nmForm" autocomplete="off"><label class="field"><span>Name</span><input class="input" name="name" maxlength="24" value="' + esc(initial.name || '') + '" required></label>' +
      '<div class="field"><span>Pick an emoji</span>' + emojiGrid(pick.emoji, taken) + '</div><div id="nmErr"></div><button class="btn block big" type="submit">' + esc(cta) + '</button></form>', function (root) {
      root.__pick = pick;
      $('#nmForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        then({ name: e.target.name.value, emoji: pick.emoji }, $('#nmErr', root));
      });
    });
  }
  function openMember(mid) {
    var g = state.g; var m = C.memberOf(g, mid); if (!m) return;
    var f = { adj: m.adj || null, emoji: m.emoji };
    sheet('<h2>' + esc(m.emoji) + ' ' + esc(m.name) + '</h2><form id="mForm" autocomplete="off"><label class="field"><span>Name</span><input class="input" name="name" maxlength="24" value="' + esc(m.name) + '"></label>' +
      '<div class="field"><span>Your number for them <span class="hint">- they said ' + (m.skill || 'nothing yet') + '. Teams use yours; they never see it.</span></span>' + skillPicker(f.adj, 'adj', mid) + '<button type="button" class="link-btn" data-act="adjclear">Use theirs</button></div>' +
      (C.sportOf(g).positions.length && g.usePos ? '<label class="field"><span>Position</span><select class="input" name="pos"><option value="">Anywhere</option>' + C.sportOf(g).positions.map(function (p) { return '<option value="' + p.id + '"' + (m.pos === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select></label>' : '') +
      '<div id="mErr"></div><button class="btn block big" type="submit">Save</button><button class="btn ghost block danger" type="button" data-act="rmmember" data-mid="' + esc(mid) + '">Remove ' + esc(m.name) + ' from the group</button></form>', function (root) {
      root.__pick = f;
      $('#mForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var body = { name: e.target.name.value, adj: f.adj };
        if (e.target.pos) body.pos = e.target.pos.value;
        doRun('editMember', { mid: mid, body: body }, { errBox: $('#mErr', root), close: true }).catch(function () {});
      });
    });
  }

  /* ---------------- paste the group chat ---------------- */

  function openPaste() {
    var p = state.paste || (state.paste = { text: '', list: null, unread: [] });
    sheet('<h2>Paste the group chat</h2><p class="small muted">Copy the replies about this week’s game from WhatsApp or iMessage and paste them here. The free reader works right on this phone - nothing is sent anywhere. You check every answer before anything changes.</p>' +
      '<label class="field"><span class="vh">The group chat</span><textarea class="input" id="pText" maxlength="20000" placeholder="[08/10/2026, 18:42] Sam: I’m in&#10;Jo: can’t make it this week&#10;1. Mia&#10;2. Tom +1">' + esc(p.text) + '</textarea></label>' +
      '<button class="btn block" type="button" data-act="readfree">Read it - free</button>' +
      '<label class="btn ghost block filebtn" for="pShot">📷 Use a screenshot instead <span class="ai">AI</span></label><input type="file" id="pShot" accept="image/*" class="vh">' +
      '<div id="pErr"></div><div id="pOut"></div>', function (root) {
      $('#pText', root).addEventListener('input', function (e) { p.text = e.target.value; });
      $('#pShot', root).addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        if (!signedIn()) return aiSignedOut($('#pErr', root));
        $('#pErr', root).innerHTML = '<p class="busy">Reading the screenshot…</p>';
        shrink(file).then(function (photo) {
          return api('POST', 'api/replies/photo', { photo: photo, names: state.g.members.map(function (m) { return m.name; }) });
        }).then(function (r) { $('#pErr', root).innerHTML = ''; mergeReplies(r.replies, true); drawReview(root); })
          .catch(function (err) { meteredError(err, $('#pErr', root), openPaste); });
      });
      if (p.list) drawReview(root);
    });
  }
  function aiSignedOut(box) {
    box.innerHTML = '<div class="note"><p style="margin:0 0 8px"><b>The AI reader needs a free account.</b> It reads messy replies and screenshots for a cent or two, and a free account comes with $2 of credit. The free reader above costs nothing and never leaves this phone.</p><button class="btn small" type="button" data-act="signin-ai">Create a free account</button></div>';
  }
  function mergeReplies(replies, fromAi) {
    var p = state.paste;
    var matched = C.matchReplies(replies, state.g.members);
    var list = p.list || [];
    matched.forEach(function (r) {
      var k = r.id || 'new:' + C.fold(r.name);
      var at = -1;
      list.forEach(function (x, i) { if ((x.id || 'new:' + C.fold(x.name)) === k) at = i; });
      var row = { name: r.name, a: r.answer, plus: r.plusOnes, id: r.id, on: true, ai: Boolean(fromAi) };
      if (at >= 0) list[at] = row; else list.push(row);
    });
    p.list = list;
    if (fromAi) p.unread = [];
  }
  function drawReview(root) {
    var p = state.paste; var out = $('#pOut', root);
    if (!p.list) { out.innerHTML = ''; return; }
    var html = p.list.length ? '<h3>Found ' + plural(p.list.length, 'answer') + '</h3><p class="small muted" style="margin:0">Untick or change anything that’s wrong. Nothing changes until you press Apply.</p><ul class="picklist">' + p.list.map(function (r, i) {
      return '<li><label class="pick"><input type="checkbox" data-i="' + i + '"' + (r.on ? ' checked' : '') + '><span class="gb"><b>' + esc(r.id ? C.memberOf(state.g, r.id).name : r.name) + (r.plus ? ' +' + r.plus : '') + '</b><span>' + (r.id ? (C.fold(r.name) !== C.fold(C.memberOf(state.g, r.id).name) ? 'from “' + esc(r.name) + '”' : 'a regular') : 'new - added as a regular') + (r.ai ? ' · read by AI' : '') + '</span></span><select class="input" data-ans="' + i + '" aria-label="Answer">' + ['in', 'maybe', 'out'].map(function (a) { return '<option value="' + a + '"' + (r.a === a ? ' selected' : '') + '>' + ANS[a] + '</option>'; }).join('') + '</select></label></li>';
    }).join('') + '</ul>' : '<p class="note">No answers the free reader could be sure of.</p>';
    if (p.unread && p.unread.length) {
      html += '<details class="unread"><summary>' + plural(p.unread.length, 'line') + ' the free reader couldn’t be sure about</summary><ul>' + p.unread.slice(0, 30).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></details>' +
        '<button class="btn ghost block" type="button" data-act="readai">Ask the AI to read those <span class="ai">AI</span> <span class="small">about a cent</span></button>';
    }
    if (p.list.length) html += '<div id="apErr"></div><button class="btn block big" type="button" data-act="applypaste">Apply ' + plural(p.list.filter(function (r) { return r.on; }).length, 'answer') + '</button>';
    out.innerHTML = html;
    $$('input[type=checkbox][data-i]', out).forEach(function (c) { c.addEventListener('change', function () { p.list[Number(c.getAttribute('data-i'))].on = c.checked; drawReview(root); }); });
    $$('select[data-ans]', out).forEach(function (s) { s.addEventListener('change', function () { p.list[Number(s.getAttribute('data-ans'))].a = s.value; }); });
  }
  function readFree() {
    var root = $('#sheet');
    var p = state.paste;
    p.text = $('#pText', root).value;
    if (!p.text.trim()) return showError(new Error('Paste the replies first.'), $('#pErr', root));
    var r = C.parseChat(p.text);
    p.list = null;
    mergeReplies(r.replies, false);
    p.unread = r.unread;
    $('#pErr', root).innerHTML = '';
    drawReview(root);
    var h = $('#pOut h3', root) || $('#pOut', root);
    if (h && h.scrollIntoView) h.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
  }
  function readAi(btn) {
    var root = $('#sheet');
    var p = state.paste;
    if (!signedIn()) return aiSignedOut($('#pErr', root));
    btn.disabled = true;
    btn.textContent = 'Reading…';
    api('POST', 'api/replies/text', { text: p.unread.join('\n'), names: state.g.members.map(function (m) { return m.name; }) })
      .then(function (r) { mergeReplies(r.replies, true); drawReview(root); })
      .catch(function (err) { btn.disabled = false; btn.textContent = 'Ask the AI to read those'; meteredError(err, $('#pErr', root), openPaste); });
  }
  function applyPaste() {
    var p = state.paste; var game = cur();
    var on = p.list.filter(function (r) { return r.on; });
    var answers = on.filter(function (r) { return r.id; }).map(function (r) { return { id: r.id, a: r.a, plus: r.plus }; });
    var add = on.filter(function (r) { return !r.id; }).map(function (r) { return { name: r.name, a: r.a, plus: r.plus }; });
    doRun('apply', { gid: game.id, answers: answers, add: add }, { errBox: $('#apErr'), close: true }).then(function () { state.paste = null; }).catch(function () {});
  }
  /** A screenshot, shrunk on the phone so the long side of a tall chat stays
   *  readable, as JPEG. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener('load', function () {
        var k = Math.min(1, SHOT_PX / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve({ type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85) });
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That image could not be opened.')); });
      img.src = url;
    });
  }

  /* ---------------- going online, joining ---------------- */

  function goOnline() {
    if (!signedIn()) return openAccount('Hosting a group online needs a free account - it stays yours to run and delete. Everyone else joins with just their name.', goOnline);
    var g = state.g;
    sheet('<h2>Put ' + esc(g.name) + ' online</h2><ul class="feats" style="padding:0;list-style:none"><li class="feat"><span class="fi" aria-hidden="true">📲</span><div><b>Everyone answers from their own phone</b><span>A link, a QR code or a six-character code. Just a name - no app, no account.</span></div></li><li class="feat"><span class="fi" aria-hidden="true">🪑</span><div><b>Your regulars keep their place</b><span>When Sam opens the link he taps “that’s me”. The season and the court money come along.</span></div></li><li class="feat"><span class="fi" aria-hidden="true">🔒</span><div><b>Still yours</b><span>Only you make teams, change the game or see skill numbers. Delete it any time.</span></div></li></ul><div id="goErr"></div><button class="btn block big" type="button" id="goBtn">Put it online</button>', function (root) {
      $('#goBtn', root).addEventListener('click', function () {
        var btn = $('#goBtn', root); btn.disabled = true;
        api('POST', 'api/groups', { group: state.g, tz: state.g.tz || TZ }).then(function (d) {
          keep(K_LOCAL, null);
          rememberGroup(d.id, d.group.name, d.group.sport);
          location.href = BASE + 'g/' + d.id + '#group';
        }).catch(function (e) { btn.disabled = false; showError(e, $('#goErr', root)); });
      });
    });
  }
  function drawJoin() {
    var main = $('#main');
    var j = state.join;
    if (!j) { main.innerHTML = '<p class="busy">Looking up that code…</p>'; return; }
    if (j.error) {
      main.innerHTML = '<section class="card center gone"><div class="big-emoji" aria-hidden="true">🔑</div><h1>That code didn’t work</h1><p class="muted">' + esc(j.error) + '</p><button class="btn" type="button" data-act="joincode">Try another code</button> <a class="btn ghost" href="' + esc(BASE) + '#start">What is Pickup?</a></section>';
      return;
    }
    var sp = C.SPORT[j.sport] || C.SPORT.other;
    var s = j.sched || {};
    var gm = j.game;
    var head = gm ? (gm.waiting ? 'Full - ' + gm.waiting + ' waiting' : gm.in >= gm.cap ? 'Full · ' + gm.in + ' in' : gm.in + ' in · need ' + (gm.cap - gm.in) + ' more') : '';
    var html = '<section class="card center"><div class="big-emoji" aria-hidden="true">' + esc(sp.emoji) + '</div><p class="eyebrow">You’re invited</p><h1>' + esc(j.name) + '</h1><p class="muted">' + esc(sp.name + ' · ' + C.WEEKDAY_NAMES[s.wd] + 's ' + C.timeLabel(s.time) + (s.place ? ' · ' + s.place : '')) + '</p>' +
      (gm ? '<p class="note"><b>' + esc(C.whenLabel(gm.date, C.localDate(Date.now(), TZ))) + ' ' + esc(C.timeLabel(gm.time)) + ':</b> ' + esc(head) + '</p>' : '') + '</section>';
    if (j.full) html += '<section class="card"><p>This group is full - ' + j.members + ' regulars. Ask whoever runs it to make room.</p></section>';
    else {
      if (j.seats && j.seats.length) {
        html += '<section class="card"><h2>Which one is you?</h2><p class="small muted">The host already added you? Tap your name.</p><div class="cands">' + j.seats.map(function (seat) { return '<button type="button" class="cand" data-act="seat" data-seat="' + esc(seat.id) + '"><span aria-hidden="true">' + esc(seat.emoji) + '</span> ' + esc(seat.name) + '</button>'; }).join('') + '</div><div id="seatErr"></div></section>';
      }
      html += '<section class="card"><h2>' + (j.seats && j.seats.length ? 'Not on the list?' : 'Join the group') + '</h2><form id="joinForm" autocomplete="off"><label class="field"><span>Your name</span><input class="input" id="jName" maxlength="24" autocomplete="given-name" required></label>' +
        '<div class="field"><span>Pick an emoji</span>' + emojiGrid(j.pick, j.takenEmoji) + '</div>' +
        '<div class="field"><span>How good are you? <span class="hint">(optional - only you and the host see it; it makes teams even)</span></span>' + skillPicker(j.skill || null, 'jskill') + '</div>' +
        '<div id="jErr"></div><button class="btn block big" type="submit">Join ' + esc(j.name) + '</button></form><p class="small muted center" style="margin-top:10px">No app, no account - this phone remembers you.</p></section>';
    }
    main.innerHTML = html;
    var f = $('#joinForm');
    if (f) f.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('button[type=submit]', f); btn.disabled = true;
      api('POST', 'api/join/' + JOIN_CODE, { name: $('#jName').value, emoji: j.pick, skill: j.skill || undefined }).then(function (r) {
        location.href = BASE + 'g/' + r.groupId + '#game';
      }).catch(function (err) { btn.disabled = false; showError(err, $('#jErr')); });
    });
  }
  function loadJoin() {
    api('GET', 'api/join/' + JOIN_CODE).then(function (j) {
      if (j.already) { location.href = BASE + 'g/' + j.already + '#game'; return; }
      var free = C.EMOJI.filter(function (e) { return j.takenEmoji.indexOf(e) < 0; });
      j.pick = free[0] || C.EMOJI[0];
      state.join = j; draw();
    }).catch(function (e) { state.join = { error: e.message }; draw(); });
  }

  /* ---------------- account ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var lastFocus = null;
  function sheetOpen() { return !$('#sheet').hidden; }
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.__pick = null; s.__sport = null;
    s.hidden = false; back.hidden = false;
    document.body.classList.add('sheet-open');
    s.scrollTop = 0;
    if (onOpen) onOpen(s);
    // Focus the heading, not a field: on a phone a focused field throws up
    // the keyboard over the very thing being read.
    var f = s.querySelector('h2') || s.querySelector('button:not(.close)');
    if (f && f.tagName === 'H2') f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  var FREE_LINE = 'Nothing in Pickup needs an account except two things: hosting a group online, and having AI read a messy group chat - a free account comes with $2 of AI credit. One account works across every app on this site.';

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
        '<p class="small muted center" style="margin-top:12px">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      $('#swap', root).addEventListener('click', function () { mode = mode === 'register' ? 'login' : 'register'; draw2(root); });
      $('#authForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); afterSignIn(then); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { afterSignIn(then); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function afterSignIn(then) {
    if (then) return then();
    if (isOnline()) { state.g = null; loadOnline().then(startPolling); return; }
    if (state.view === 'join') return loadJoin();
    draw();
  }
  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Having AI read a chat costs a cent or two. Answers, teams, the season and court money are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); if (isOnline()) location.reload(); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The free reader, answers, teams, the season and court money keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- a little joy ---------------- */

  function pop(btn, emoji) {
    if (REDUCED || !btn || !btn.getBoundingClientRect) return;
    var r = btn.getBoundingClientRect();
    var p = document.createElement('div');
    p.className = 'pop'; p.style.left = (r.left + r.width / 2) + 'px'; p.style.top = (r.top + r.height / 2) + 'px';
    var out = '';
    for (var i = 0; i < 6; i++) { var a = (Math.PI * 2 * i) / 6; out += '<span style="--dx:' + Math.round(Math.cos(a) * 46) + 'px;--dy:' + Math.round(Math.sin(a) * 46 - 20) + 'px">' + esc(emoji) + '</span>'; }
    p.innerHTML = out;
    document.body.appendChild(p);
    setTimeout(function () { p.remove(); }, 900);
  }
  function showQr() {
    var o = document.createElement('div');
    o.className = 'qrfull';
    o.setAttribute('role', 'dialog'); o.setAttribute('aria-label', 'Join code');
    o.innerHTML = '<button class="btn ghost" type="button">Close</button><p style="font-weight:800;font-size:1.3rem;margin:0">' + esc(state.g.name) + '</p><div class="qrbox">' + QR.svg(joinLink(), 'Join ' + state.g.name) + '</div><p class="code" style="color:#111111">' + esc(state.g.display) + '</p><p style="margin:0;color:#333333">Scan to say you’re in - no app needed</p>';
    function close() { o.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    o.addEventListener('click', function (e) { if (e.target === o || e.target.tagName === 'BUTTON') close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(o);
  }
  function setRadio(t) {
    var group = t.closest('[role=radiogroup]');
    if (group) $$('[role=radio]', group).forEach(function (b) { b.setAttribute('aria-checked', String(b === t)); });
  }

  /* ---------------- one click listener ---------------- */

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    var sh = $('#sheet');
    var g = state.g;
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'tab': {
        state.tab = t.getAttribute('data-tab');
        closeSheet(true);
        history.pushState(null, '', location.pathname + '#' + tabHash(state.tab));
        draw(); scrollTo(0, 0);
        break;
      }
      case 'example': go('example'); break;
      case 'newgroup': openNewGroup(); break;
      case 'openlocal': closeSheet(true); go('game'); break;
      case 'joincode': openJoinCode(); break;
      case 'startown': openMakeYours(isExample() ? 'Like what you see?' : ''); break;
      case 'signin': openAccount(); break;
      case 'signin-ai': {
        var keepText = state.paste;
        openAccount('A free account comes with $2 of AI credit. Reading a chat costs about a cent.', function () { state.paste = keepText; openPaste(); });
        break;
      }
      case 'rsvp': {
        var a = t.getAttribute('data-a');
        var id = t.getAttribute('data-id');
        var game = C.latest(g);
        var curA = game.rsvps && game.rsvps[id] && game.rsvps[id].a;
        if (t.classList.contains('ans') && curA === a) break; // already that
        doRun('rsvp', { gid: game.id, id: id, a: a }).then(function (r) { if (a === 'in' && r && r.status === 'in' && id === actor().mid) pop($('.ans.in') || t, '🙌'); }).catch(function () {});
        break;
      }
      case 'sharegame': {
        var gm = C.latest(g);
        share(g.name, C.shareText(g, gm, isOnline() ? joinLink() : null));
        break;
      }
      case 'nudge': {
        var who = C.memberOf(g, t.getAttribute('data-id'));
        if (who) share(g.name, C.nudgeText(g, C.latest(g), who.name, isOnline() ? joinLink() : null));
        break;
      }
      case 'guest': openGuest(); break;
      case 'paste': openPaste(); break;
      case 'readfree': readFree(); break;
      case 'readai': readAi(t); break;
      case 'applypaste': applyPaste(); break;
      case 'editgame': openEditGame(); break;
      case 'wrapup':
        if (confirm('Wrap up this week? Next week’s game opens with everyone “not answered yet”.')) doRun('done', { gid: C.latest(g).id }).catch(function () {});
        break;
      case 'sides': setRadio(t); state.sides = Number(t.getAttribute('data-v')); break;
      case 'maketeams': {
        var gm2 = C.latest(g);
        var sides = state.sides || (gm2.teams ? gm2.teams.sides.length : C.suggestSides(C.lineup(g, gm2).in.length, g.perSide));
        if (C.matchList(gm2).length && !confirm('Remaking the teams clears tonight’s scores. Go ahead?')) break;
        doRun('teams', { gid: gm2.id, sides: sides, n: 0 }).then(function () { pop($('.gapline') || t, '⚖️'); }).catch(function () {});
        break;
      }
      case 'reshuffle': {
        var gm3 = C.latest(g);
        if (C.matchList(gm3).length && !confirm('Reshuffling clears tonight’s scores. Go ahead?')) break;
        doRun('teams', { gid: gm3.id, sides: gm3.teams.sides.length, n: (gm3.teams.n || 0) + 1 }).catch(function () {});
        break;
      }
      case 'clearteams':
        if (confirm('Clear the teams (and any scores)?')) doRun('clearTeams', { gid: C.latest(g).id }).catch(function () {});
        break;
      case 'shareteams': share(g.name, C.teamsText(g, C.latest(g))); break;
      case 'quickwin': {
        var f = $('#scoreForm');
        doRun('match', { gid: C.latest(g).id, body: { a: Number(f.a.value), b: Number(f.b.value), w: t.getAttribute('data-w') } }, { errBox: $('#scoreErr') }).catch(function () {});
        break;
      }
      case 'unmatch': doRun('unmatch', { gid: C.latest(g).id, rid: t.getAttribute('data-rid') }).catch(function () {}); break;
      case 'vote': {
        var mine = t.getAttribute('aria-pressed') === 'true';
        doRun('vote', { gid: t.getAttribute('data-gid'), voter: t.getAttribute('data-voter'), cand: mine ? null : t.getAttribute('data-cand') }).then(function () { if (!mine) pop(t, '🏅'); }).catch(function () {});
        break;
      }
      case 'closevotes': doRun('closeVotes', { gid: t.getAttribute('data-gid') }).then(function () { pop($('.trophy') || t, '🏅'); }).catch(function () {}); break;
      case 'paid': {
        var on = t.getAttribute('aria-pressed') !== 'true';
        doRun('paid', { gid: t.getAttribute('data-gid'), pid: t.getAttribute('data-pid'), paid: on }).catch(function () {});
        break;
      }
      case 'paidall': {
        var pid = t.getAttribute('data-pid');
        var row = C.money(g, Date.now()).owes.filter(function (o) { return o.id === pid; })[0];
        if (!row) break;
        row.games.reduce(function (p, x) { return p.then(function () { return run('paid', { gid: x.id, pid: pid, paid: true }); }); }, Promise.resolve())
          .then(function () { draw(); toast(C.memberOf(state.g, pid).name + ' is paid up. 🙌'); }).catch(function (err) { draw(); showError(err); });
        break;
      }
      case 'sharemoney': share(g.name, C.reminderText(g, C.money(g, Date.now()))); break;
      case 'copymoney': copy(C.reminderText(g, C.money(g, Date.now())), 'Reminder copied'); break;
      case 'myskill': setRadio(t); doRun('editMember', { mid: t.getAttribute('data-mid'), body: { skill: Number(t.getAttribute('data-v')) } }).catch(function () {}); break;
      case 'mypos': setRadio(t); doRun('editMember', { mid: actor().mid, body: { pos: t.getAttribute('data-v') } }).catch(function () {}); break;
      case 'editme': {
        var me = C.memberOf(g, actor().mid);
        if (!me) break;
        nameSheet('You', 'How the group sees you.', 'Save', me, g.members.filter(function (x) { return x.id !== me.id; }).map(function (x) { return x.emoji; }), function (body, errBox) {
          doRun('editMember', { mid: me.id, body: body }, { errBox: errBox, close: true }).catch(function () {});
        });
        break;
      }
      case 'editmember': openMember(t.getAttribute('data-mid')); break;
      case 'adj': setRadio(t); if (sh.__pick) sh.__pick.adj = Number(t.getAttribute('data-v')); break;
      case 'adjclear': if (sh.__pick) { sh.__pick.adj = null; $$('[data-act=adj]', sh).forEach(function (b) { b.setAttribute('aria-checked', 'false'); }); } break;
      case 'gskill': setRadio(t); if (sh.__pick) sh.__pick.skill = Number(t.getAttribute('data-v')); break;
      case 'jskill': setRadio(t); if (state.join) state.join.skill = Number(t.getAttribute('data-v')); break;
      case 'rmmember': {
        var mid = t.getAttribute('data-mid');
        var mm = C.memberOf(g, mid);
        if (mm && confirm('Remove ' + mm.name + ' from ' + g.name + '? Past games keep what they played.')) doRun('removeMember', { mid: mid }, { close: true }).catch(function () {});
        break;
      }
      case 'rmline': {
        var lines = (g.lines || []).slice();
        lines.splice(Number(t.getAttribute('data-i')), 1);
        doRun('lines', { lines: lines }).catch(function () {});
        break;
      }
      case 'editgroup': openEditGroup(); break;
      case 'sport': {
        setRadio(t);
        if (sh.__pick) sh.__pick.sport = t.getAttribute('data-v');
        if (sh.__sport) sh.__sport();
        break;
      }
      case 'emo': {
        setRadio(t);
        if (sh.contains(t) && sh.__pick) sh.__pick.emoji = t.getAttribute('data-emo');
        else if (state.join) state.join.pick = t.getAttribute('data-emo');
        break;
      }
      case 'seat': {
        $$('[data-act=seat]').forEach(function (b) { b.disabled = true; });
        api('POST', 'api/join/' + JOIN_CODE, { seat: t.getAttribute('data-seat'), skill: state.join && state.join.skill }).then(function (r) {
          location.href = BASE + 'g/' + r.groupId + '#game';
        }).catch(function (err) { $$('[data-act=seat]').forEach(function (b) { b.disabled = false; }); showError(err, $('#seatErr')); });
        break;
      }
      case 'goonline': goOnline(); break;
      case 'qrbig': showQr(); break;
      case 'sharejoin': {
        var link = joinLink();
        if (navigator.share) navigator.share({ title: g.name, text: 'Join ' + g.name + ' on Pickup - tap In or Out each week, no app needed:', url: link }).catch(function () { /* closed */ });
        else copy(link, 'Link copied');
        break;
      }
      case 'copyjoin': copy(joinLink(), 'Link copied'); break;
      case 'rotate':
        if (confirm('Make a new code? The old link and QR stop working; nobody already in is affected.')) api('POST', 'api/groups/' + GROUP_ID + '/code', {}).then(function (d) { setBundle(d); draw(); toast('New code ready'); }).catch(function (err) { showError(err); });
        break;
      case 'leave':
        if (!confirm('Leave ' + g.name + '? You can join again with the code.')) break;
        api('DELETE', 'api/groups/' + GROUP_ID + '/members/' + g.me).then(function () { forgetGroup(GROUP_ID); location.href = BASE + '#start'; }).catch(function (err) { showError(err); });
        break;
      case 'delgroup':
        if (isLocal()) {
          if (confirm('Clear ' + g.name + ' from this phone? Its season and money list are deleted. This can’t be undone.')) { keep(K_LOCAL, null); location.href = BASE + '#start'; }
        } else if (confirm('Delete ' + g.name + ' for everyone, with its whole season? This can’t be undone.')) {
          api('DELETE', 'api/groups/' + GROUP_ID).then(function () { forgetGroup(GROUP_ID); location.href = BASE + '#start'; }).catch(function (err) { showError(err); });
        }
        break;
      default: break;
    }
  });

  /* ---------------- start ---------------- */

  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });
  drawTop();
  if (JOIN_CODE) { state.view = 'join'; draw(); loadMe().then(loadJoin); }
  else {
    if (!GROUP_ID && !location.hash) {
      // The home-screen icon opens the last group this phone used.
      var last = recall(K_LAST);
      if (last && last.id && /^[A-Za-z0-9_-]{16}$/.test(last.id)) { location.replace(BASE + 'g/' + last.id + '#game'); return; }
    }
    route();
    loadMe().then(function () {
      if (state.view === 'start') loadMyGroups();
      if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
    });
  }
})();
