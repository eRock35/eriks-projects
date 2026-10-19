/* Drill - the page. One file, no build step. Every string that came from
 * outside this file (a typed name, a business description, a custom
 * scenario, anything from the server) is escaped before it is drawn, and no
 * handler is written into markup: clicks are routed by data-act attributes
 * from one listener (the lab's CSP allows script from this origin only).
 * The scenarios, the scoring and the report are drill-core.js, the same
 * file the server and the tests run.
 *
 * Views:
 *   home    - the first run: the 5-minute demo, the scenarios, "Make it
 *             about us", why and how.
 *   solo    - one person plays every role, on this phone only. The demo is
 *             a solo drill with a gentle 45-second clock per decision.
 *   room    - r/<CODE>: the lobby, the live drill (votes, the facilitator's
 *             lock and next), and the room's report.
 *   report  - the after-action report: score, areas, what went well, the
 *             three gaps, the action list, the timeline, and exports.
 *
 * On this phone (localStorage, every access wrapped): drill-profile-v1 (your
 * first name and role, for the next room), drill-host-v1 (the facilitator
 * key for rooms you opened), drill-history-v1 (your last reports),
 * drill-solo-v1 (a solo drill in progress).
 */
(function () {
  'use strict';

  var C = window.DrillCore;
  var QR = window.DrillQR;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_PROFILE = 'drill-profile-v1';
  var K_HOST = 'drill-host-v1';
  var K_HISTORY = 'drill-history-v1';
  var K_SOLO = 'drill-solo-v1';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ROOM_CODE = (function () { var m = /\/r\/([A-Za-z0-9-]{4,14})\/?$/.exec(location.pathname); return m ? m[1].toUpperCase().replace(/[^A-Z0-9]/g, '') : null; }());
  var DEMO_SECONDS = 45;
  var LETTERS = ['A', 'B', 'C', 'D'];

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function role(id) { return C.roleOf(id) || C.ROLES[0]; }
  function roleChip(id) { var r = role(id); return '<span aria-hidden="true">' + r.emoji + '</span> ' + esc(r.label); }

  var state = {
    me: null,          // the account, if any
    view: 'home',
    solo: null,        // {scn, decisions, current, picked, demo, left, late}
    report: null,      // {rep, scn, from}
    room: null,        // the room as the server last sent it
    roomErr: null,
    library: [],       // your custom scenarios (signed in)
    armed: null,       // a delete waiting for its second tap
    custom: null,      // the "Make it about us" sheet
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
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function share(title, text, url) {
    if (navigator.share) navigator.share({ title: title, text: text, url: url }).catch(function () { /* closed */ });
    else copy(url, 'Link copied - paste it in your team chat');
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
  function profile() { var p = recall(K_PROFILE) || {}; return { name: typeof p.name === 'string' ? C.cleanName(p.name) : '', role: C.ROLE_IDS.indexOf(p.role) >= 0 ? p.role : '' }; }
  function hostKeyFor(code) { var m = recall(K_HOST) || {}; var k = m[code]; return typeof k === 'string' && /^[A-Za-z0-9_-]{22}$/.test(k) ? k : null; }
  function rememberHost(code, key) {
    var m = recall(K_HOST) || {};
    m[code] = key;
    var codes = Object.keys(m);
    if (codes.length > 12) delete m[codes[0]];
    keep(K_HOST, m);
  }
  function roomLink(code) { return location.origin + BASE + 'r/' + code; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. The built-in scenarios work meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).addEventListener('click', function () {
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { toast('Sent - check your email.'); }, function () { toast('Could not send it. Try again in a minute.'); });
    });
  }

  /* ---------------- history (this phone only) ---------------- */

  function history() { var h = recall(K_HISTORY); return Array.isArray(h) ? h.filter(function (x) { return x && x.rep && x.rep.scenario; }).slice(0, 8) : []; }
  function saveHistory(id, rep) {
    var h = history().filter(function (x) { return x.id !== id; });
    h.unshift({ id: id, at: Date.now(), rep: rep });
    keep(K_HISTORY, h.slice(0, 8));
  }

  /* ---------------- drawing ---------------- */

  function stopTimers() { clearInterval(tick); tick = null; }
  var tick = null;
  function draw() {
    stopTimers();
    if (state.view === 'solo') drawSolo();
    else if (state.view === 'report') drawReport();
    else if (state.view === 'room') drawRoom();
    else drawHome();
  }
  function go(view) { state.view = view; draw(); scrollTo(0, 0); try { main.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }

  function scenarioCard(s, mine) {
    var count = s.injects.length;
    return '<article class="card scn"><div class="hd"><div class="emo" aria-hidden="true">' + esc(s.emoji) + '</div><div>' +
      '<h3>' + esc(s.title) + (mine ? ' <span class="tag">Yours</span>' : '') + '</h3>' +
      '<p class="meta">' + count + ' injects · about ' + esc(s.minutes) + ' min with a team</p></div></div>' +
      '<p class="b">' + esc(s.blurb) + '</p>' +
      '<div class="acts"><button class="btn small" type="button" data-act="newroom" data-id="' + esc(s.id) + '">Team drill</button>' +
      '<button class="btn small ghost" type="button" data-act="solo" data-id="' + esc(s.id) + '">Play solo</button>' +
      (mine ? '<button class="btn small ghost" type="button" data-act="dellib" data-id="' + esc(s.id) + '">Delete</button>' : '') + '</div></article>';
  }
  function peek() {
    var s = C.scenarioById('ransomware');
    var i = s.injects[0];
    var k = C.clock(s, i.at);
    return '<div class="peek" aria-hidden="true"><div class="peek-top"><span><span class="live-dot"></span> <b style="color:var(--signal)">' + esc(k.wall) + '</b></span><span class="small" style="color:var(--board-muted)">Lands on ' + roleChip(i.to) + '</span></div>' +
      '<p class="peek-q">' + esc(i.title) + ': every file on the shared drive now ends in .lockd.</p>' +
      '<div class="peek-c"><span><b>A</b> · Unplug the three PCs - but leave them on</span><span><b>B</b> · Shut everything down and restore</span><span><b>C</b> · Keep working while IT looks</span></div></div>';
  }
  function drawHome() {
    var builtins = C.SCENARIOS.filter(function (s) { return !s.demo; });
    var past = history();
    var demo = C.scenarioById(C.DEMO_ID);
    main.innerHTML =
      '<div class="hero hero-grid"><div>' +
      '<p class="eyebrow">Tabletop drills for small teams</p>' +
      '<h1>Rehearse the bad day <em>before it happens.</em></h1>' +
      '<p class="lede">Ransomware on a Monday. A leaked customer list. The payroll email that wasn’t from the CEO. Walk through it as a team, each on your own phone, and leave with the gaps, who fixes them, and a report you can hand your insurer.</p>' +
      '<div class="hero-cta"><button class="btn big block" type="button" data-act="demo">▶ Try a 5-minute drill<span class="sub">' + esc(demo.title) + ' · solo · no setup</span></button>' +
      '<div class="row"><button class="btn ghost" type="button" data-act="newroom">Run with my team</button><button class="btn ghost" type="button" data-act="joinsheet">Join with a code</button></div></div>' +
      '<div class="trust"><span>Free</span><span>No account to play or join</span><span>Nothing about your business needed</span></div>' +
      '</div>' + peek() + '</div>' +
      (past.length ? '<section aria-labelledby="pastH"><h2 id="pastH">Your past drills</h2><p class="lede">Kept on this phone only.</p><ul class="past">' + past.map(function (p) {
        return '<li><button class="btn ghost" type="button" data-act="past" data-id="' + esc(p.id) + '"><span>' + esc(p.rep.scenario.emoji) + ' ' + esc(p.rep.scenario.title) + ' <span class="muted small">· ' + esc(p.rep.date || '') + '</span></span><span class="band b-' + esc(p.rep.band.id) + '">' + esc(p.rep.score) + ' · ' + esc(p.rep.band.label) + '</span></button></li>';
      }).join('') + '</ul></section>' : '') +
      '<section aria-labelledby="scnH"><h2 id="scnH">Pick a bad day</h2><p class="lede">Each one is a story told in timed “injects”. Every inject lands on someone - IT, Finance, Comms - and the team has to decide what to do.</p>' +
      '<div class="scn-grid">' + builtins.map(function (s) { return scenarioCard(s, false); }).join('') +
      state.library.map(function (s) { return scenarioCard(s, true); }).join('') + '</div></section>' +
      '<section aria-labelledby="customH"><div class="card"><h2 id="customH">✨ Make it about us</h2><p>Describe your business in a few lines - what you sell, the tools you use (“Shopify, QuickBooks, Google Workspace, a chatbot on the site”) - and get a scenario built around them, checked so every branch ends and every choice has a consequence.</p>' +
      '<div class="row"><button class="btn" type="button" data-act="custom">Make it about us</button><span class="small muted">' + (signedIn() ? 'Uses a few cents of AI credit.' : 'Needs a free account. The built-in drills stay free.') + '</span></div></div></section>' +
      '<section aria-labelledby="whyH"><h2 id="whyH">Why rehearse</h2><div class="why">' +
      '<div class="card"><b>Most small businesses have no incident plan.</b><span class="muted">And the ones that do have never tried it out loud. The first time shouldn’t be the real time.</span></div>' +
      '<div class="card"><b>Insurers and auditors ask for it.</b><span class="muted">“Have you run a tabletop exercise?” is on cyber-insurance and audit questionnaires. This is one - with a report to show for it.</span></div>' +
      '<div class="card"><b>Consultants charge thousands.</b><span class="muted">For a facilitated half-day. Drill takes an hour of your team’s time, and costs nothing.</span></div>' +
      '</div></section>' +
      '<section aria-labelledby="howH"><h2 id="howH">How it works</h2><ol class="how">' +
      '<li><div><b>Open a room.</b> <span class="muted">Pick a scenario. You get a code and a QR - no account needed.</span></div></li>' +
      '<li><div><b>Everyone joins on their phone</b> <span class="muted">with a first name and a role: Owner, IT, Ops, Comms, Finance, Legal/HR.</span></div></li>' +
      '<li><div><b>Injects land on a role, the clock runs.</b> <span class="muted">Everyone votes; the facilitator locks the call and reads what happened.</span></div></li>' +
      '<li><div><b>Get the after-action report.</b> <span class="muted">A readiness score per area, the three gaps, an action list with owners, the timeline. Markdown or print.</span></div></li>' +
      '</ol></section>' +
      '<p class="foot">' + esc(C.NOT_ADVICE) + ' Solo drills and the demo never leave this phone; a room keeps first names, roles and decisions for ' + '48 hours.</p>';
  }

  /* ---------------- solo (and the demo) ---------------- */

  function scenarioFor(id) {
    var s = C.scenarioById(id);
    if (s) return s;
    for (var i = 0; i < state.library.length; i++) if (state.library[i].id === id) return state.library[i];
    return null;
  }
  function startSolo(scn, demo) {
    state.solo = { scn: scn, decisions: [], current: scn.injects[0].id, picked: null, demo: Boolean(demo), left: DEMO_SECONDS, late: false };
    saveSolo();
    go('solo');
    say(scn.title + '. ' + scn.injects[0].title);
  }
  function saveSolo() {
    var s = state.solo;
    if (!s) return keep(K_SOLO, null);
    keep(K_SOLO, { scenario: s.scn.custom ? s.scn : null, id: s.scn.id, decisions: s.decisions, demo: s.demo });
  }
  function resumeSolo() {
    var r = recall(K_SOLO);
    if (!r || typeof r !== 'object') return false;
    var scn = r.scenario ? C.cleanScenario(r.scenario).scenario : C.scenarioById(r.id);
    if (!scn) { keep(K_SOLO, null); return false; }
    var decisions = C.cleanDecisions(scn, r.decisions);
    if (C.finished(scn, decisions) || !decisions.length) { keep(K_SOLO, null); return false; }
    var last = decisions[decisions.length - 1];
    state.solo = { scn: scn, decisions: decisions, current: C.nextOf(scn, last.inject, last.choice), picked: null, demo: Boolean(r.demo), left: DEMO_SECONDS, late: false };
    return true;
  }
  function stepsHtml(done, now) {
    var out = '';
    for (var i = 0; i < done; i++) out += '<i class="done"></i>';
    if (now) out += '<i class="now"></i>';
    return '<span class="steps" aria-hidden="true">' + out + '</span>';
  }
  function boardHtml(k, inj, who, live) {
    return '<div class="board" id="board"><div class="clock">' + (live ? '<span class="live-dot" aria-hidden="true"></span>' : '') + '<span class="wall">' + esc(k.wall) + '</span><span class="since">' + esc(k.since) + '</span></div>' +
      '<div class="to">Lands on ' + roleChip(inj.to) + (who ? ' <span style="color:var(--board-muted);font-weight:600">· ' + esc(who) + '</span>' : '') + '</div>' +
      '<h2>' + esc(inj.title) + '</h2><p class="txt">' + esc(inj.text) + '</p>' +
      '<div id="timerSlot"></div></div>';
  }
  function testedHtml(oc) {
    return '<ul class="tested">' + oc.tested.map(function (t) {
      var cls = t.points === 2 ? 'b-ready' : t.points === 1 ? 'b-partly' : 'b-gap';
      var word = t.points === 2 ? '✓ Strong' : t.points === 1 ? '◐ Partly' : '✗ Missed';
      return '<li class="' + cls + '"><span>' + esc(t.label) + '</span><span class="pts">' + word + ' · ' + t.points + '/2</span></li>';
    }).join('') + '</ul>';
  }
  function resultHtml(oc, heading) {
    return '<div class="result" id="result" tabindex="-1"><h3>' + esc(heading || 'What happened') + '</h3><p class="then">' + esc(oc.then) + '</p>' +
      '<p class="small muted" style="margin:8px 0 0">What this tested:</p>' + testedHtml(oc) + '</div>';
  }
  function runningHtml(scn, decisions) {
    var sc = C.score(scn, decisions);
    var areas = sc.areas.filter(function (a) { return a.possible; });
    if (!areas.length) return '<p class="small muted">Scores appear here as you decide. Every choice is checked against a checklist: contain it, keep evidence, call the insurer, tell people, check the rules where you operate.</p>';
    return '<ul class="areas">' + areas.map(function (a) {
      return '<li><div class="top-line"><span class="lbl">' + esc(a.label) + '</span><span class="band b-' + esc(a.band.id) + '">' + a.pct + '% · ' + esc(a.band.label) + '</span></div><div class="meter"><i class="' + esc(a.band.id) + '" style="width:' + a.pct + '%"></i></div></li>';
    }).join('') + '</ul>';
  }
  function timelineHtml(items) {
    if (!items.length) return '<p class="small muted">Nothing decided yet.</p>';
    return '<ol class="timeline">' + items.map(function (t) {
      return '<li><p class="when">' + esc(t.wall) + ' · ' + esc(t.toLabel) + (t.by === 'timer' ? ' · clock ran out' : '') + (t.late ? ' · after the clock' : '') + '</p><p class="what">' + esc(t.title) + '</p><p class="did small">' + esc(t.choice) + '</p></li>';
    }).join('') + '</ol>';
  }
  function drawSolo() {
    var s = state.solo;
    var inj = C.injectOf(s.scn, s.current);
    var oc = s.picked ? C.outcome(inj, s.picked) : null;
    var rep = C.report(s.scn, s.decisions, { mode: 'solo' });
    main.innerHTML =
      '<div class="drill-head"><div><div class="t">' + esc(s.scn.emoji) + ' ' + esc(s.scn.title) + '</div><div class="small muted">' + (s.demo ? 'The 5-minute drill · ' : 'Solo · ') + 'decision ' + (s.decisions.length + (s.picked ? 0 : 1)) + '</div></div>' +
      '<div class="row">' + stepsHtml(s.decisions.length - (s.picked ? 1 : 0), true) + '<button class="btn small ghost no-print" type="button" data-act="quit">Quit</button></div></div>' +
      '<div class="dk-split dk-split-aside"><div>' +
      boardHtml(C.clock(s.scn, inj.at), inj, 'you’re playing every role', !s.picked) +
      '<div class="choices" role="group" aria-label="What do you do?">' + inj.choices.map(function (ch, n) {
        var cls = s.picked ? (ch.id === s.picked ? ' picked' : ' faded') : '';
        return '<button class="choice' + cls + '" type="button" data-act="pick" data-id="' + esc(ch.id) + '"' + (s.picked ? ' disabled' : '') + '><span class="k" aria-hidden="true">' + LETTERS[n] + '</span><span>' + esc(ch.text) + '</span></button>';
      }).join('') + '</div>' +
      (oc ? resultHtml(oc) + '<div class="next-row"><button class="btn big block" type="button" data-act="solonext" id="nextBtn">' + (oc.next === 'end' ? 'See the after-action report →' : 'Next inject →') + '</button></div>' : '') +
      '</div><aside class="side"><div class="card"><h2>Readiness so far</h2>' + runningHtml(s.scn, s.decisions) + '</div>' +
      '<div class="card"><h2>Timeline</h2>' + timelineHtml(rep.timeline) + '</div>' +
      (s.demo ? '<div class="card"><h2>Like it?</h2><p class="small muted">Run the full drills with your team - everyone on their own phone, the facilitator locks each call.</p><button class="btn small" type="button" data-act="newroom">Run a drill with my team</button></div>' : '') +
      '</aside></div>';
    if (s.demo && !s.picked) startDemoClock();
    if (oc) { var r = $('#result'); if (r) { try { r.focus({ preventScroll: true }); } catch (e) { /* ignore */ } r.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'nearest' }); } }
  }
  function startDemoClock() {
    var s = state.solo;
    var slot = $('#timerSlot');
    function paint() {
      if (!slot) return;
      var out = s.left <= 0;
      slot.innerHTML = '<div class="timer' + (out ? ' out' : '') + '"><div class="bar"><i style="width:' + Math.max(0, (100 * s.left) / DEMO_SECONDS) + '%"></i></div><div class="tl"><span>' + (out ? 'Time’s up - in a real one, the clock keeps running. Pick one.' : 'Decide in ' + s.left + 's') + '</span><span>' + (out ? '' : 'pressure clock') + '</span></div></div>';
    }
    paint();
    tick = setInterval(function () {
      if (state.view !== 'solo' || state.solo !== s || s.picked || document.hidden) return;
      if (s.left > 0) { s.left -= 1; if (s.left === 0) { s.late = true; say('Time’s up. Pick one.'); } paint(); }
    }, 1000);
  }
  function pick(id) {
    var s = state.solo;
    if (!s || s.picked) return;
    var inj = C.injectOf(s.scn, s.current);
    if (!C.choiceOf(inj, id)) return;
    s.picked = id;
    s.decisions.push({ inject: inj.id, choice: id, by: 'solo', late: s.late });
    saveSolo();
    draw();
    var oc = C.outcome(inj, id);
    say('What happened: ' + oc.then);
  }
  function soloNext() {
    var s = state.solo;
    var next = C.nextOf(s.scn, s.current, s.picked);
    if (next === 'end') {
      var rep = C.report(s.scn, s.decisions, { mode: 'solo', date: today() });
      saveHistory('solo-' + Date.now(), rep);
      keep(K_SOLO, null);
      state.report = { rep: rep, scn: s.scn, from: 'solo' };
      state.solo = null;
      go('report');
      say(['Readiness ', rep.score, ' out of 100. ', rep.band.label, '.'].join('')); // textContent, not markup
      return;
    }
    s.current = next; s.picked = null; s.left = DEMO_SECONDS; s.late = false;
    saveSolo();
    draw();
    var b = $('#board'); if (b) b.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
    say(C.injectOf(s.scn, next).title);
  }

  /* ---------------- the report ---------------- */

  function ringHtml(pct) {
    var c = 2 * Math.PI * 50;
    return '<div class="ring" role="img" aria-label="Readiness ' + pct + ' out of 100"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="bgc" cx="60" cy="60" r="50"></circle><circle class="fgc" id="ringFg" cx="60" cy="60" r="50" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (REDUCED ? (c * (1 - pct / 100)).toFixed(1) : c.toFixed(1)) + '"></circle></svg><div class="n" aria-hidden="true"><div><b id="ringN">' + (REDUCED ? pct : 0) + '</b><small>of 100</small></div></div></div>';
  }
  function reportBody(rep) {
    var sub = [rep.org ? esc(rep.org) : '', esc(rep.date), rep.mode === 'room' ? 'team drill' : 'solo drill', rep.complete ? '' : 'stopped early'].filter(Boolean).join(' · ');
    return '<div class="card"><div class="rep-head">' + ringHtml(rep.score) + '<div><p class="eyebrow">After-action report</p><h1 style="font-size:1.45rem">' + esc(rep.scenario.emoji) + ' ' + esc(rep.scenario.title) + '</h1>' +
      '<p class="small muted" style="margin:0 0 6px">' + sub + '</p><span class="band b-' + esc(rep.band.id) + '">' + esc(rep.band.label) + '</span></div></div></div>' +
      '<div class="dk-split"><div>' +
      '<section aria-labelledby="areasH"><h2 id="areasH">Readiness by area</h2><div class="card"><ul class="areas">' + rep.areas.map(function (a) {
        return '<li><div class="top-line"><span class="lbl">' + esc(a.label) + '</span><span class="band b-' + esc(a.band.id) + '">' + (a.pct === null ? 'Not tested here' : a.pct + '% · ' + esc(a.band.label)) + '</span></div>' +
          (a.pct === null ? '' : '<div class="meter"><i class="' + esc(a.band.id) + '" style="width:' + a.pct + '%"></i></div>') + '</li>';
      }).join('') + '</ul></div></section>' +
      '<section aria-labelledby="gapsH"><h2 id="gapsH">The three gaps to fix</h2>' + (rep.gaps.length ? '<ol class="gaps">' + rep.gaps.map(function (g) { return '<li><div><b>' + esc(g.label) + '</b>' + esc(g.fix) + '<br><span class="owner">Owner: ' + esc(g.ownerLabel) + '</span></div></li>'; }).join('') + '</ol>' : '<p>No gaps in this run. Try a harder scenario.</p>') + '</section>' +
      '<section aria-labelledby="wentH"><h2 id="wentH">What went well</h2><ul class="went">' + (rep.went.length ? rep.went.map(function (w) { return '<li><b>✓ ' + esc(w.label) + '</b>' + esc(w.text) + '</li>'; }).join('') : '<li>Nothing scored full marks this time. That is what a drill is for.</li>') + '</ul></section>' +
      (rep.people.length ? '<section aria-labelledby="whoH"><h2 id="whoH">Who took part</h2><p>' + rep.people.map(function (p) { return esc(p.name) + ' <span class="muted">(' + esc(p.role) + ')</span>'; }).join(', ') + '</p></section>' : '') +
      '</div><div>' +
      '<section aria-labelledby="actH"><h2 id="actH">Action list</h2><ul class="actions">' + rep.actions.map(function (a) { return '<li><span class="box" aria-hidden="true"></span><div>' + esc(a.text) + '<br><span class="owner">Owner: ' + esc(a.ownerLabel) + '</span></div></li>'; }).join('') + '</ul></section>' +
      '<section aria-labelledby="tlH"><h2 id="tlH">Timeline of decisions</h2><div class="card">' + timelineHtml(rep.timeline) + '</div></section>' +
      '</div></div>';
  }
  function exportHtml(rep) {
    return '<section class="no-print" aria-labelledby="expH"><h2 id="expH">Take it with you</h2><p class="lede">The thing to hand your insurer or auditor. Nothing about your business is needed - add a name if you like.</p>' +
      '<label class="field"><span>Business name on the report <span class="muted">(optional, stays on this phone)</span></span><input class="input" id="org" maxlength="' + C.LIMITS.org + '" autocomplete="organization" value="' + esc(rep.org || '') + '"></label>' +
      '<div class="export"><button class="btn small" type="button" data-act="md">Markdown file</button><button class="btn small" type="button" data-act="html">Printable page</button><button class="btn small ghost" type="button" data-act="print">Print / PDF</button><button class="btn small ghost" type="button" data-act="copymd">Copy Markdown</button></div></section>';
  }
  function drawReport() {
    var r = state.report;
    var rep = r.rep;
    var again = r.scn && !r.scn.demo;
    main.innerHTML = '<div class="row no-print" style="justify-content:space-between;margin-bottom:10px"><button class="link-btn" type="button" data-act="home">← All scenarios</button></div>' +
      reportBody(rep) + exportHtml(rep) +
      '<section class="no-print"><div class="row">' +
      (r.scn ? '<button class="btn" type="button" data-act="newroom" data-id="' + esc(r.scn.demo ? '' : r.scn.id) + '">' + (again ? 'Run it with my team' : 'Run a full drill with my team') + '</button><button class="btn ghost" type="button" data-act="replay">Play it again</button>' : '') +
      '<button class="btn ghost" type="button" data-act="home">Try another scenario</button></div></section>' +
      '<p class="foot">' + esc(C.NOT_ADVICE) + '</p>';
    bindOrg(rep);
    animateRing(rep.score);
  }
  function bindOrg(rep) {
    var o = $('#org');
    if (o) o.addEventListener('input', function () { rep.org = C.cleanOrg(o.value); });
  }
  function animateRing(pct) {
    if (REDUCED) return;
    var fg = $('#ringFg'), n = $('#ringN');
    if (!fg || !n) return;
    var c = 2 * Math.PI * 50;
    requestAnimationFrame(function () { fg.style.strokeDashoffset = (c * (1 - pct / 100)).toFixed(1); });
    var t0 = performance.now();
    (function step(t) {
      var k = Math.min(1, (t - t0) / 1000);
      n.textContent = String(Math.round(pct * (1 - Math.pow(1 - k, 3))));
      if (k < 1) requestAnimationFrame(step);
    }(t0));
  }
  function currentReport() { return state.report ? state.report.rep : (state.room && state.room.report) || null; }
  function fileName(rep, ext) { return 'after-action-' + C.slug(rep.scenario.title) + (rep.date ? '-' + rep.date : '') + '.' + ext; }

  /* ---------------- rooms ---------------- */

  function hostHeaders() { var k = state.room && hostKeyFor(state.room.code); return k ? { 'X-Drill-Key': k } : (ROOM_CODE && hostKeyFor(ROOM_CODE) ? { 'X-Drill-Key': hostKeyFor(ROOM_CODE) } : null); }
  var poll = null;
  var clockSkew = 0;
  function setRoom(r) {
    var before = state.room;
    state.room = r;
    clockSkew = Date.parse(r.now) - Date.now();
    if (r.phase === 'done' && r.report && (!before || before.phase !== 'done')) saveHistory('room-' + r.code, r.report);
    if (before && before.inject && r.inject && before.inject.id !== r.inject.id) say('New inject: ' + r.inject.title);
    if (before && before.phase === 'deciding' && r.phase === 'locked' && r.result) say('Locked: ' + r.result.text);
  }
  function loadRoom(quiet) {
    var v = state.room && state.room.code === ROOM_CODE ? state.room.v : null;
    return api('GET', 'api/rooms/' + ROOM_CODE + (v !== null && quiet ? '?since=' + v : ''), null, hostHeaders()).then(function (d) {
      state.roomErr = null;
      if (d.same) return;
      var joining = $('#joinForm');
      setRoom(d.room);
      if (joining && !d.room.me && !d.room.host) return;
      if (state.view === 'room') drawRoom();
    }).catch(function (e) {
      if (!quiet || e.status === 404) { state.roomErr = e; if (state.view === 'room') drawRoom(); }
    });
  }
  function startPolling() {
    clearInterval(poll);
    poll = setInterval(function () { if (!document.hidden && state.view === 'room' && state.room && state.room.phase !== 'done') loadRoom(true); }, 2500);
  }
  function hostAct(action, extra) {
    var body = { action: action };
    if (extra) for (var k in extra) body[k] = extra[k];
    return api('POST', 'api/rooms/' + state.room.code + '/host', body, hostHeaders()).then(function (d) { setRoom(d.room); drawRoom(); return d; })
      .catch(function (e) { showError(e); loadRoom(false); });
  }
  function personName(pid) {
    var p = (state.room.people || []).find(function (x) { return x.id === pid; });
    return p ? p.name : '';
  }
  function hostName() { var p = (state.room.people || []).find(function (x) { return x.host; }); return p ? p.name : 'the facilitator'; }
  function peopleHtml(r, canRemove) {
    var voted = {};
    Object.keys(r.votes || {}).forEach(function (k) { (r.votes[k] || []).forEach(function (pid) { voted[pid] = true; }); });
    return '<ul class="people">' + r.people.map(function (p) {
      return '<li><span class="who">' + esc(p.name) + (p.id === r.me ? ' <span class="muted small">(you)</span>' : '') + (p.host ? ' <span class="tag">Facilitator</span>' : '') + '</span>' +
        '<span class="row" style="gap:6px;flex-wrap:nowrap"><span class="role">' + roleChip(p.role) + (r.phase === 'deciding' ? (voted[p.id] ? ' · voted' : '') : '') + '</span>' +
        (canRemove && !p.host ? '<button class="btn small ghost x" type="button" data-act="remove" data-id="' + esc(p.id) + '" aria-label="Remove ' + esc(p.name) + '">×</button>' : '') + '</span></li>';
    }).join('') + '</ul>';
  }
  function rolePicker(selected) {
    return '<div class="roles" role="group" aria-label="Your role">' + C.ROLES.map(function (r) {
      return '<button class="role-btn" type="button" data-act="role" data-role="' + r.id + '" aria-pressed="' + (selected === r.id) + '"><span class="e" aria-hidden="true">' + r.emoji + '</span><b>' + esc(r.label) + '</b><small>' + esc(r.blurb) + '</small></button>';
    }).join('') + '</div>';
  }
  function timerPills(sec) {
    var labels = { 0: 'Facilitator’s tap', 60: '1 min', 120: '2 min', 180: '3 min', 300: '5 min' };
    return '<div class="pills" role="group" aria-label="Time to decide">' + [0, 60, 120, 180, 300].map(function (s) {
      return '<button class="pill" type="button" data-act="timer" data-sec="' + s + '" aria-pressed="' + (sec === s) + '">' + labels[s] + '</button>';
    }).join('') + '</div>';
  }
  function drawRoom() {
    var r = state.room;
    if (state.roomErr && !r) {
      main.innerHTML = '<div class="card" style="margin-top:20px"><h1>That drill isn’t here</h1><p class="muted">' + esc(state.roomErr.message) + '</p><div class="row"><button class="btn" type="button" data-act="joinsheet">Try another code</button><button class="btn ghost" type="button" data-act="home">Go to Drill</button></div></div>';
      return;
    }
    if (!r) { main.innerHTML = '<p class="muted" style="margin-top:20px">Opening the drill…</p>'; return; }
    if (!r.me && !r.host && r.phase !== 'done') return drawJoin(r);
    if (r.phase === 'lobby') return drawLobby(r);
    if (r.phase === 'done') return drawRoomReport(r);
    drawLive(r);
  }
  function drawJoin(r) {
    var p = profile();
    state.joinRole = state.joinRole || p.role || '';
    main.innerHTML = '<div class="card" style="margin-top:12px;max-width:620px"><p class="eyebrow">Joining drill ' + esc(r.display) + '</p><h1>' + esc(r.scenario.emoji) + ' ' + esc(r.scenario.title) + '</h1>' +
      '<p class="muted">' + esc(r.scenario.blurb) + '</p>' +
      '<form id="joinForm"><label class="field"><span>Your first name</span><input class="input" id="jName" maxlength="' + C.LIMITS.name + '" autocomplete="given-name" required value="' + esc(p.name) + '"></label>' +
      '<div class="field"><span class="lbl">The role you’ll play</span>' + rolePicker(state.joinRole) + '<span class="hint">Pick the closest. Small teams play two roles - that’s normal.</span></div>' +
      '<div id="joinErr"></div><button class="btn big block" type="submit">Join the drill</button></form>' +
      '<p class="small muted" style="margin-top:10px">No account, no app. The room keeps your first name and role for 48 hours.</p></div>';
    $('#joinForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('#jName').value;
      if (!state.joinRole) { $('#joinErr').innerHTML = '<p class="err" role="alert">Pick the role you’ll play.</p>'; return; }
      var btn = $('button[type=submit]', e.target); btn.disabled = true;
      api('POST', 'api/rooms/' + r.code + '/join', { name: name, role: state.joinRole }, hostHeaders()).then(function (d) {
        keep(K_PROFILE, { name: C.cleanName(name), role: state.joinRole });
        setRoom(d.room); drawRoom(); say('You’re in.');
      }).catch(function (err) { btn.disabled = false; showError(err, $('#joinErr')); });
    });
  }
  function drawLobby(r) {
    var link = roomLink(r.code);
    var me = r.people.find(function (p) { return p.id === r.me; });
    main.innerHTML = '<div class="drill-head"><div><div class="t">' + esc(r.scenario.emoji) + ' ' + esc(r.scenario.title) + '</div><div class="small muted">Waiting room · ' + r.people.length + ' joined</div></div></div>' +
      '<div class="dk-split dk-split-aside"><div>' +
      (r.host ? '<div class="card"><p class="eyebrow">Everyone joins with</p><div class="row" style="gap:18px;align-items:center"><button class="qr" type="button" data-act="qr" aria-label="Show the QR code full screen">' + QR.svg(link, 'QR code to join drill ' + r.display) + '</button><div><div class="code-big">' + esc(r.display) + '</div><p class="small muted" style="margin:0 0 8px">at ' + esc(location.host + BASE) + ' → Join a drill</p><div class="row"><button class="btn small" type="button" data-act="sharelink">Share the link</button><button class="btn small ghost" type="button" data-act="copylink">Copy link</button></div></div></div></div>' +
        '<div class="card"><h2>Time to decide</h2><p class="small muted">With a timer, the leading vote locks itself when time runs out - and if nobody voted, the team froze. Or lock each call yourself.</p>' + timerPills(r.timerSec) + '</div>' +
        '<div class="card"><h2>Ready?</h2><p class="small muted">You’re the facilitator: read each inject out loud, let the room argue for a minute, then lock the call. Your notes show what each choice leads to - don’t read them out.</p><button class="btn big block" type="button" data-act="start">Start the drill</button></div>'
        : '<div class="card"><p class="eyebrow">You’re in</p><h1>' + esc(me ? me.name : '') + ', playing ' + roleChip(me ? me.role : 'owner') + '</h1><p class="muted">Waiting for ' + esc(hostName()) + ' to start. Keep this open - the first inject appears here.</p><button class="btn small ghost" type="button" data-act="editme">Change my name or role</button></div>') +
      '</div><aside class="side"><div class="card"><h2>In the room</h2>' + peopleHtml(r, r.host) + '</div>' +
      (r.host ? '<div class="card"><button class="btn small ghost block" type="button" data-act="delroom">Delete this room</button></div>' : '') + '</aside></div>';
  }
  function timerHtml(r) {
    if (!r.deadline || r.phase !== 'deciding') return '';
    var left = Math.max(0, Math.round((Date.parse(r.deadline) - (Date.now() + clockSkew)) / 1000));
    var pct = r.timerSec ? Math.max(0, Math.min(100, (100 * left) / r.timerSec)) : 0;
    var mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
    return '<div class="timer' + (left <= 0 ? ' out' : '') + '"><div class="bar"><i style="width:' + pct + '%"></i></div><div class="tl"><span>' + (left > 0 ? mm + ':' + ss + ' to decide' : 'Time’s up - locking the leading vote') + '</span><span>' + (left > 0 ? 'then the leading vote locks' : '') + '</span></div></div>';
  }
  function drawLive(r) {
    var inj = r.inject;
    var myVote = null;
    Object.keys(r.votes || {}).forEach(function (k) { if ((r.votes[k] || []).indexOf(r.me) >= 0) myVote = k; });
    var locked = r.phase === 'locked';
    var counts = {};
    Object.keys(r.votes || {}).forEach(function (k) { counts[k] = (r.votes[k] || []).length; });
    var lead = null;
    inj.choices.forEach(function (ch) { if (counts[ch.id] && (!lead || counts[ch.id] > counts[lead])) lead = ch.id; });
    var who = (r.people.filter(function (p) { return p.role === inj.to; }).map(function (p) { return p.name; }).slice(0, 3).join(', ')) || 'nobody playing it - the room decides';
    main.innerHTML =
      '<div class="drill-head"><div><div class="t">' + esc(r.scenario.emoji) + ' ' + esc(r.scenario.title) + '</div><div class="small muted">Drill ' + esc(r.display) + ' · decision ' + r.step + '</div></div>' + stepsHtml(r.timeline.length - (locked ? 1 : 0), true) + '</div>' +
      '<div class="dk-split dk-split-aside"><div>' +
      boardHtml({ wall: inj.wall, since: inj.since }, inj, who, !locked) +
      '<div class="choices" role="group" aria-label="' + (locked ? 'The call' : 'Vote: what do you do?') + '">' + inj.choices.map(function (ch, n) {
        var names = (r.votes[ch.id] || []).map(personName).filter(Boolean);
        var picked = locked && r.result && r.result.choice === ch.id;
        var cls = locked ? (picked ? ' picked' : ' faded') : '';
        return '<div class="choice-wrap"><button class="choice' + cls + '" type="button" data-act="vote" data-id="' + esc(ch.id) + '" aria-pressed="' + (!locked && myVote === ch.id) + '"' + (locked || !r.me ? ' disabled' : '') + '><span class="k" aria-hidden="true">' + LETTERS[n] + '</span><span>' + esc(ch.text) +
          '<span class="vote-n">' + (names.length ? names.length + ' vote' + (names.length === 1 ? '' : 's') : 'No votes') + (lead === ch.id && !locked ? ' · leading' : '') + (!locked && myVote === ch.id ? ' · your vote' : '') + '</span>' +
          (names.length ? '<span class="votes">' + names.map(function (nm) { return '<span class="vote-chip">' + esc(nm) + '</span>'; }).join('') + '</span>' : '') + '</span></button>' +
          (r.host && !locked ? '<button class="btn small ghost host-lock" type="button" data-act="lock" data-id="' + esc(ch.id) + '">Lock ' + LETTERS[n] + ' as the call</button>' : '') + '</div>';
      }).join('') + '</div>' +
      (!locked && r.host ? '<div class="next-row"><button class="btn big block" type="button" data-act="lock">' + (lead ? 'Lock the leading vote (' + LETTERS[inj.choices.findIndex(function (c) { return c.id === lead; })] + ')' : 'Lock - nobody has voted yet') + '</button></div>' : '') +
      (!locked && !r.host ? '<p class="small muted" style="margin-top:12px">' + (myVote ? 'Your vote is in - tap another to change it. ' : 'Tap a choice to vote. ') + esc(hostName()) + ' locks the call.</p>' : '') +
      (locked && r.result ? resultHtml(r.result, 'Locked: what happened') + '<div class="next-row">' + (r.host ? '<button class="btn big block" type="button" data-act="next">' + (r.result.next === 'end' ? 'Finish and see the report →' : 'Next inject →') + '</button>' : '<p class="muted">Waiting for ' + esc(hostName()) + ' to move on…</p>') + '</div>' : '') +
      (r.host && r.guide ? '<details class="guide card"><summary>Facilitator notes (don’t read aloud)</summary><ul>' + r.guide.map(function (g, n) { return '<li><b>' + LETTERS[n] + '</b> scores ' + g.points + ' of ' + g.of + (g.end ? ' · ends the drill' : '') + ': ' + esc(g.then) + '</li>'; }).join('') + '</ul></details>' : '') +
      '</div><aside class="side">' +
      '<div class="card"><h2>In the room · ' + esc(r.display) + '</h2>' + peopleHtml(r, false) + (r.host ? '<p class="small muted" style="margin:12px 0 6px">Time to decide the next one</p>' + timerPills(r.timerSec) : '') + '</div>' +
      '<div class="card"><h2>Timeline</h2>' + timelineHtml(r.timeline) + '</div>' +
      (r.host ? '<div class="card"><button class="btn small ghost block" type="button" data-act="finish">End the drill now</button><p class="small muted" style="margin:6px 0 0">The report covers what was decided so far.</p></div>' : '') +
      '</aside></div>';
    var slot = $('#timerSlot');
    if (slot && r.deadline && !locked) {
      slot.innerHTML = timerHtml(r);
      var fired = false;
      tick = setInterval(function () {
        var s2 = $('#timerSlot');
        if (!s2 || state.room !== r) return;
        s2.innerHTML = timerHtml(r);
        if (!fired && Date.parse(r.deadline) <= Date.now() + clockSkew) { fired = true; setTimeout(function () { loadRoom(true); }, 600); }
      }, 1000);
    }
  }
  function drawRoomReport(r) {
    if (!r.report) { main.innerHTML = '<p>This drill has finished.</p>'; return; }
    state.roomRep = state.roomRep && state.roomRep.code === r.code ? state.roomRep : { code: r.code, rep: r.report };
    var rep = state.roomRep.rep;
    main.innerHTML = '<div class="row no-print" style="justify-content:space-between;margin-bottom:10px"><button class="link-btn" type="button" data-act="home">← Drill home</button><span class="small muted">Drill ' + esc(r.display) + '</span></div>' +
      reportBody(rep) + exportHtml(rep) +
      '<section class="no-print"><div class="row"><button class="btn ghost" type="button" data-act="home">Run another drill</button>' + (r.host ? '<button class="btn ghost" type="button" data-act="delroom">Delete this room</button>' : '') + '</div><p class="small muted" style="margin-top:8px">The room and this report are kept for 48 hours from when it opened. Download the report to keep it.</p></section>' +
      '<p class="foot">' + esc(C.NOT_ADVICE) + '</p>';
    bindOrg(rep);
    animateRing(rep.score);
  }
  function showQr() {
    var r = state.room;
    var o = document.createElement('div');
    o.className = 'qr-big'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', 'Join QR code');
    o.innerHTML = '<button type="button" class="btn small ghost" id="qrClose">Close</button><div class="qrbox">' + QR.svg(roomLink(r.code), 'QR code to join drill ' + r.display) + '</div><p class="code">' + esc(r.display) + '</p><p>Scan to join the drill.</p>';
    document.body.appendChild(o);
    var close = function () { o.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    $('#qrClose', o).addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    $('#qrClose', o).focus();
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheet(html, after) {
    lastFocus = document.activeElement;
    var s = $('#sheet');
    s.innerHTML = '<div class="grab" aria-hidden="true"></div>' + html;
    s.hidden = false; $('#sheetBack').hidden = false;
    document.body.classList.add('sheet-open');
    var h = $('h2', s);
    s.setAttribute('aria-label', h ? h.textContent : 'Dialog');
    if (after) after(s);
    var f = $('[autofocus]', s) || $('.x', s) || s;
    try { f.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    state.custom = null;
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  function head(title) { return '<div class="sheet-head"><h2>' + title + '</h2><button class="x" type="button" data-act="closesheet" aria-label="Close">×</button></div>'; }

  function openJoin() {
    sheet(head('Join a drill') + '<p class="muted">Type the code the facilitator is showing - six letters and numbers.</p>' +
      '<form id="codeForm"><label class="field"><span>Code</span><input class="input" id="code" autocomplete="off" autocapitalize="characters" inputmode="text" maxlength="9" placeholder="ABC-DEF" autofocus style="font-size:1.4rem;letter-spacing:.08em;font-weight:800"></label><div id="codeErr"></div><button class="btn block" type="submit">Join</button></form>', function (root) {
      $('#codeForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var c = $('#code', root).value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (c.length !== 6) { $('#codeErr', root).innerHTML = '<p class="err" role="alert">A code is six letters and numbers.</p>'; return; }
        location.href = BASE + 'r/' + c;
      });
    });
  }

  function openNewRoom(scenarioId) {
    var p = profile();
    var f = { scenario: scenarioId && scenarioFor(scenarioId) && !scenarioFor(scenarioId).demo ? scenarioId : 'ransomware', role: p.role || 'owner', timerSec: 120 };
    var all = C.SCENARIOS.filter(function (s) { return !s.demo; }).concat(state.library);
    function body(root) {
      $('.body', root).innerHTML = head('Run a drill with your team') +
        '<p class="muted">You’ll get a code and a QR. Everyone joins on their own phone - no app, no account.</p>' +
        '<form id="roomForm"><div class="field"><span class="lbl">Scenario</span><div class="pills" role="group" aria-label="Scenario">' + all.map(function (s) {
          return '<button class="pill" type="button" data-act="fscn" data-id="' + esc(s.id) + '" aria-pressed="' + (f.scenario === s.id) + '">' + esc(s.emoji) + ' ' + esc(s.title) + '</button>';
        }).join('') + '</div></div>' +
        '<label class="field"><span>Your first name</span><input class="input" id="rName" maxlength="' + C.LIMITS.name + '" autocomplete="given-name" required value="' + esc(p.name) + '"></label>' +
        '<div class="field"><span class="lbl">The role you’ll play (you’re also the facilitator)</span>' + rolePicker(f.role) + '</div>' +
        '<div class="field"><span class="lbl">Time to decide each inject</span>' + timerPills(f.timerSec) + '</div>' +
        '<div id="roomErr"></div><button class="btn big block" type="submit">Open the room</button></form>';
      $('#roomForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var name = $('#rName', root).value;
        var btn = $('button[type=submit]', e.target); btn.disabled = true;
        var s = scenarioFor(f.scenario);
        var payload = { name: name, role: f.role, timerSec: f.timerSec };
        if (s && s.custom) payload.custom = s.id; else payload.scenario = f.scenario;
        api('POST', 'api/rooms', payload).then(function (d) {
          rememberHost(d.code, d.key);
          keep(K_PROFILE, { name: C.cleanName(name), role: f.role });
          location.href = BASE + 'r/' + d.code;
        }).catch(function (err) { btn.disabled = false; showError(err, $('#roomErr', root)); });
      });
    }
    sheet('<div class="body"></div>', function (root) {
      body(root);
      root.addEventListener('click', function (e) {
        var t = e.target.closest('[data-act]');
        if (!t) return;
        var a = t.getAttribute('data-act');
        var nm = $('#rName', root) ? $('#rName', root).value : p.name;
        if (a === 'fscn') { f.scenario = t.getAttribute('data-id'); p.name = nm; body(root); }
        if (a === 'role') { f.role = t.getAttribute('data-role'); $$('.role-btn', root).forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); }); }
        if (a === 'timer') { f.timerSec = Number(t.getAttribute('data-sec')); $$('[data-act="timer"]', root).forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); }); }
      });
    });
  }

  function openEditMe() {
    var r = state.room;
    var me = r.people.find(function (p) { return p.id === r.me; });
    var pickRole = me.role;
    sheet(head('Your name and role') + '<form id="meForm"><label class="field"><span>First name</span><input class="input" id="mName" maxlength="' + C.LIMITS.name + '" value="' + esc(me.name) + '"></label><div class="field"><span class="lbl">Role</span>' + rolePicker(pickRole) + '</div><div id="meErr"></div><button class="btn block" type="submit">Save</button></form>', function (root) {
      root.addEventListener('click', function (e) {
        var t = e.target.closest('[data-act="role"]');
        if (!t) return;
        pickRole = t.getAttribute('data-role');
        $$('.role-btn', root).forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); });
      });
      $('#meForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var name = $('#mName', root).value;
        api('POST', 'api/rooms/' + r.code + '/me', { name: name, role: pickRole }, hostHeaders()).then(function (d) {
          keep(K_PROFILE, { name: C.cleanName(name), role: pickRole });
          setRoom(d.room); closeSheet(true); drawRoom();
        }).catch(function (err) { showError(err, $('#meErr', root)); });
      });
    });
  }

  /* ---------------- "Make it about us" (the one model call) ---------------- */

  var FOCUS_LABELS = { surprise: '🎲 Surprise me', ransomware: '🔒 Ransomware', data: '📇 Data leak', ai: '🤖 AI gone wrong', fraud: '💸 Payment fraud', outage: '🚀 Outage' };
  function openCustom() {
    if (!signedIn()) {
      sheet(head('✨ Make it about us') + '<p>A scenario written around your business - your tools, your customers, the people on your call - needs a <b>free account</b>, because it uses AI. You get $2 of AI credit; a scenario costs a few cents.</p>' +
        '<p class="small muted">The five built-in drills, solo play and rooms stay free with no account.</p>' +
        '<div class="row"><button class="btn" type="button" data-act="signup">Create a free account</button><button class="btn ghost" type="button" data-act="signin">Sign in</button></div>');
      return;
    }
    state.custom = state.custom || { about: '', tools: '', focus: 'surprise', busy: false, scenario: null };
    sheet('<div class="body"></div>', function (root) { drawCustom(root); });
  }
  function drawCustom(root) {
    var c = state.custom;
    var el = $('.body', root);
    if (c.scenario) {
      var s = c.scenario;
      el.innerHTML = head('Your scenario is ready') + '<h3 style="font-size:1.15rem">' + esc(s.emoji) + ' ' + esc(s.title) + '</h3><p class="muted">' + esc(s.blurb) + '</p>' +
        '<ul class="preview-list">' + s.injects.map(function (i) { var k = C.clock(s, i.at); return '<li><b>' + esc(k.wall) + '</b> · ' + roleChip(i.to) + ' · ' + esc(i.title) + '</li>'; }).join('') + '</ul>' +
        '<p class="small muted">Checked before it was offered: every branch ends, every choice has a consequence. Saved to your account.</p>' +
        '<div class="row"><button class="btn" type="button" data-act="newroom" data-id="' + esc(s.id) + '">Run with my team</button><button class="btn ghost" type="button" data-act="solo" data-id="' + esc(s.id) + '">Play solo</button></div>';
      return;
    }
    if (c.busy) {
      el.innerHTML = head('Writing your scenario…') + '<ol class="busy" id="busy"><li class="on">Reading your description</li><li>Writing the injects and the choices</li><li>Checking every branch ends</li><li>Saving it to your account</li></ol><p class="small muted">Usually under a minute. Keep this open.</p>';
      var n = 0;
      var t = setInterval(function () {
        var b = $('#busy');
        if (!b || !state.custom || !state.custom.busy) { clearInterval(t); return; }
        n = Math.min(3, n + 1);
        $$('li', b).forEach(function (li, i) { li.className = i <= n ? 'on' : ''; });
      }, 9000);
      return;
    }
    el.innerHTML = head('✨ Make it about us') +
      '<form id="customForm"><label class="field"><span>What does your business do?</span><textarea class="input" id="cAbout" maxlength="' + C.LIMITS.about + '" placeholder="We sell handmade candles online and at two markets. 9 people. A part-time bookkeeper, one person who looks after the website.">' + esc(c.about) + '</textarea><span class="hint">A few lines is plenty. No names, no customer details needed.</span></label>' +
      '<label class="field"><span>The tools you use <span class="muted">(optional)</span></span><input class="input" id="cTools" maxlength="' + C.LIMITS.tools + '" placeholder="Shopify, QuickBooks, Google Workspace, a chatbot on the site" value="' + esc(c.tools) + '"></label>' +
      '<div class="field"><span class="lbl">The bad day</span><div class="pills" role="group" aria-label="The bad day">' + Object.keys(FOCUS_LABELS).map(function (k) {
        return '<button class="pill" type="button" data-act="focus" data-id="' + k + '" aria-pressed="' + (c.focus === k) + '">' + FOCUS_LABELS[k] + '</button>';
      }).join('') + '</div></div>' +
      '<div id="customErr"></div><button class="btn big block" type="submit">Write my scenario</button>' +
      '<p class="small muted" style="margin-top:10px">Only these lines go to the AI, once; they are not stored. What comes back is checked, then saved to your account. A few cents of AI credit.</p></form>';
    $('#cAbout', root).addEventListener('input', function (e) { c.about = e.target.value; });
    $('#cTools', root).addEventListener('input', function (e) { c.tools = e.target.value; });
    $('#customForm', root).addEventListener('submit', function (e) { e.preventDefault(); writeCustom(root); });
  }
  function writeCustom(root) {
    var c = state.custom;
    c.busy = true; drawCustom(root);
    api('POST', 'api/custom', { about: c.about, tools: c.tools, focus: c.focus }).then(function (d) {
      if (state.custom !== c) return;
      c.busy = false; c.scenario = d.scenario;
      state.library = [d.scenario].concat(state.library.filter(function (s) { return s.id !== d.scenario.id; }));
      drawCustom(root);
      if (state.view === 'home') drawHome();
      say('Your scenario is ready: ' + d.scenario.title);
    }).catch(function (e) {
      if (state.custom !== c) return;
      c.busy = false; drawCustom(root);
      var where = $('#customErr', root);
      if (e.status === 401) return openAccount();
      if (e.status === 402) return openCredit(e.data);
      if (e.data && e.data.code === 'verify-email') return verifyNote(where, e);
      showError(e, where);
    });
  }
  function loadLibrary() {
    if (!signedIn()) { state.library = []; return Promise.resolve(); }
    return api('GET', 'api/library').then(function (d) { state.library = (d.scenarios || []).map(function (s) { return C.cleanScenario(s).scenario; }).filter(Boolean); })
      .catch(function () { state.library = []; });
  }

  /* ---------------- the account ---------------- */

  var FREE_LINE = 'Drill works without an account - every built-in scenario, solo and with a team. A free account adds “Make it about us”, a scenario written around your business, with $2 of AI credit. One account works across every app on this site.';
  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }
  function afterSignIn(then) {
    return loadMe().then(loadLibrary).then(function () { if (state.view === 'home') drawHome(); if (then) then(); });
  }
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
          .then(function () { closeSheet(); toast('You’re in.'); return afterSignIn(then); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return afterSignIn(then); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(head('Account') + '<p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><b>Your scenarios</b><p class="small muted" style="margin:4px 0 0">' + state.library.length + ' of ' + C.LIMITS.library + ' saved. They follow you to any phone you sign in on.</p></div>' +
      '<div class="note"><div class="row" style="justify-content:space-between"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">“Make it about us” costs a few cents. Built-in drills, solo play and rooms are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; state.library = []; drawTop(); draw(); });
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
    sheet(head('Out of AI credit') + '<p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The built-in drills, solo play and rooms keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });

  /* ---------------- one click listener ---------------- */

  function goHome() {
    if (ROOM_CODE) { location.href = BASE; return; }
    state.solo = null; state.report = null; go('home');
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var a = t.getAttribute('data-act');
    // The sheets that pick a scenario, a role or a timer handle those taps themselves.
    if (t.closest('#sheet') && ['fscn', 'role', 'timer'].indexOf(a) >= 0) return;
    var id = t.getAttribute('data-id');
    if (a !== 'dellib' && a !== 'delroom') state.armed = null;
    switch (a) {
      case 'home': if (t.tagName === 'A') e.preventDefault(); goHome(); break;
      case 'closesheet': closeSheet(); break;
      case 'demo': startSolo(C.scenarioById(C.DEMO_ID), true); break;
      case 'solo': { var s = scenarioFor(id); if (s) { closeSheet(true); startSolo(s, false); } break; }
      case 'replay': if (state.report && state.report.scn) startSolo(state.report.scn, Boolean(state.report.scn.demo)); break;
      case 'quit': keep(K_SOLO, null); state.solo = null; go('home'); break;
      case 'pick': pick(id); break;
      case 'solonext': soloNext(); break;
      case 'past': { var p = history().find(function (x) { return x.id === id; }); if (p) { state.report = { rep: p.rep, scn: C.scenarioById(p.rep.scenario.id) || null, from: 'history' }; go('report'); } break; }
      case 'newroom': closeSheet(true); openNewRoom(id); break;
      case 'joinsheet': openJoin(); break;
      case 'custom': openCustom(); break;
      case 'focus': if (state.custom) { state.custom.focus = id; $$('[data-act="focus"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); }); } break;
      case 'signup': openAccount(null, function () { openCustom(); }); break;
      case 'signin': openAccount(null, function () { openCustom(); }, true); break;
      case 'dellib': {
        if (state.armed !== 'dellib:' + id) { state.armed = 'dellib:' + id; t.textContent = 'Tap again to delete'; break; }
        api('DELETE', 'api/library/' + id).then(function () { state.library = state.library.filter(function (s2) { return s2.id !== id; }); drawHome(); toast('Deleted.'); }).catch(function (err) { showError(err); });
        break;
      }
      case 'md': { var r1 = currentReport(); if (r1) download(fileName(r1, 'md'), C.reportMarkdown(r1), 'text/markdown;charset=utf-8'); break; }
      case 'html': { var r2 = currentReport(); if (r2) download(fileName(r2, 'html'), C.reportHtml(r2), 'text/html;charset=utf-8'); break; }
      case 'copymd': { var r3 = currentReport(); if (r3) copy(C.reportMarkdown(r3), 'Markdown copied'); break; }
      case 'print': window.print(); break;
      // rooms
      case 'vote': {
        var r = state.room;
        if (!r || !r.me || r.phase !== 'deciding') break;
        var mine = (r.votes[id] || []).indexOf(r.me) >= 0;
        api('POST', 'api/rooms/' + r.code + '/vote', { choice: mine ? null : id }, hostHeaders()).then(function (d) { setRoom(d.room); drawRoom(); }).catch(function (err) { showError(err); loadRoom(false); });
        break;
      }
      case 'start': hostAct('start'); break;
      case 'lock': hostAct('lock', id ? { choice: id } : null); break;
      case 'next': hostAct('next'); break;
      case 'finish': hostAct('finish'); break;
      case 'timer': if (state.room && state.room.host) hostAct('timer', { sec: Number(t.getAttribute('data-sec')) }); break;
      case 'remove': hostAct('remove', { pid: id }); break;
      case 'role': state.joinRole = t.getAttribute('data-role'); $$('.role-btn').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); }); break;
      case 'editme': openEditMe(); break;
      case 'qr': showQr(); break;
      case 'copylink': copy(roomLink(state.room.code), 'Link copied'); break;
      case 'sharelink': share('Join our drill', ['Join our incident drill (', state.room.scenario.title, ') - code ', state.room.display, ':'].join(''), roomLink(state.room.code)); // plain text for the share sheet, not markup break;
      case 'delroom': {
        if (state.armed !== 'delroom') { state.armed = 'delroom'; t.textContent = 'Tap again to delete the room'; break; }
        api('DELETE', 'api/rooms/' + state.room.code, null, hostHeaders()).then(function () { location.href = BASE; }).catch(function (err) { showError(err); });
        break;
      }
      default: break;
    }
  });

  /* ---------------- start ---------------- */

  if (ROOM_CODE) {
    state.view = 'room';
    drawRoom();
    loadRoom(false).then(startPolling);
    loadMe();
  } else {
    if (resumeSolo()) { state.view = 'solo'; }
    draw();
    loadMe().then(loadLibrary).then(function () { if (state.view === 'home') drawHome(); });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.view === 'room' && ROOM_CODE) loadRoom(true);
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* no offline copy, still works online */ });
  }
}());
