/* Rota - the page. One file, no build step. Every string that came from
 * outside this file (a typed name, a role, a note, anything the server or a
 * model sent) is escaped before it is drawn, and no handler is written into
 * markup: clicks are routed by data-act attributes from one listener (the
 * lab's CSP allows script from this origin only). The rules - the solver,
 * fairness, swaps, the calendar file - are rota-core.js, the same file the
 * server and the tests run.
 *
 * Who is looking:
 *   home     - the first run: "Try a sample cafe", "Set up my team", the
 *              teams this phone runs.
 *   manager  - the sample (kept on this phone) or a real team (t/<CODE> on
 *              the phone that holds its key): Week, Team, Fairness, Swaps &
 *              log, Settings.
 *   staff    - t/<CODE> on anyone else's phone: pick your name, mark your
 *              availability, see your shifts, add them to a calendar, offer
 *              and claim swaps. The sample can preview this as any person.
 *
 * On this phone (localStorage, every access wrapped): rota-sample-v1 (the
 * sample team), rota-teams-v1 (the manager key for each team this phone
 * runs).
 */
(function () {
  'use strict';

  var C = window.RotaCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_SAMPLE = 'rota-sample-v1';
  var K_TEAMS = 'rota-teams-v1';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TEAM_CODE = (function () { var m = /\/t\/([A-Za-z0-9-]{8,20})\/?$/.exec(location.pathname); return m ? m[1].toUpperCase().replace(/[^A-Z0-9]/g, '') : null; }());
  var LOCAL_ZONE = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }());
  var STATE_ICON = { can: '✓', prefer: '~', cant: '✕' };
  var TABS = [['week', 'Week'], ['team', 'Team'], ['fair', 'Fairness'], ['swaps', 'Swaps'], ['settings', 'Settings']];

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /** A person's colour: by their place on the team, spread round the wheel
   *  evenly round the wheel, so eight people get eight clearly different dots. */
  function hue(id) {
    var list = (state.doc && state.doc.people) || (state.staff && state.staff.people) || [];
    var i = -1;
    for (var k = 0; k < list.length; k++) if (list[k].id === id) i = k;
    if (i < 0) { var h = 0; for (var j = 0; j < id.length; j++) h = (h * 31 + id.charCodeAt(j)) % 360; return h; }
    return Math.round((200 + i * (list.length <= 12 ? 360 / list.length : 137.508)) % 360);
  }
  function cap(t) { t = String(t || ''); return t.charAt(0).toUpperCase() + t.slice(1); }
  function dot(id) { return '<span class="pdot" aria-hidden="true" style="--h:' + hue(String(id)) + '"></span>'; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  var state = {
    me: null,          // the account, if any
    view: 'home',      // home | manager | staff
    local: false,      // the manager is driving the sample on this phone
    code: null,        // a real team's code
    key: null,         // its manager key, on the phone that runs it
    doc: null,         // the manager's view of the team (or the sample doc)
    staff: null,       // a staff phone's view
    preview: null,     // sample only: the person whose phone we preview
    week: null,
    tab: 'week',
    day: 0,            // the day shown at phone width
    lastFill: null,    // {placed, gaps, moved, before} from the last tap
    fresh: {},         // seats just placed, for the reveal
    armed: null,       // a delete waiting for its second tap
    staffWeek: null,
    draft: null,       // availability being edited on a staff phone
    texts: null,       // the Read their texts sheet
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
  function teamLink(code) { return location.origin + BASE + 't/' + code; }
  function myTeams() { var m = recall(K_TEAMS); return m && typeof m === 'object' ? m : {}; }
  function rememberTeam(code, key, name) {
    var m = myTeams();
    m[code] = { key: key, name: C.clean(name, C.LIMITS.team), at: Date.now() };
    var codes = Object.keys(m);
    if (codes.length > 12) delete m[codes[0]];
    keep(K_TEAMS, m);
  }
  function forgetTeam(code) { var m = myTeams(); delete m[code]; keep(K_TEAMS, m); }
  function keyFor(code) { var t = myTeams()[code]; return t && typeof t.key === 'string' && /^[A-Za-z0-9_-]{22}$/.test(t.key) ? t.key : null; }
  function nowMs() { return Date.now(); }
  function zone() { return state.doc ? state.doc.team.zone : (state.staff ? state.staff.team.zone : LOCAL_ZONE); }
  function today() { return C.todayIn(zone(), nowMs()); }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }

  /* ---------------- changes: the same rules, here or on the server ---------------- */

  /** A manager's change. The sample runs it here with the core and keeps the
   *  result on this phone; a real team sends it to the server, which runs
   *  the same core inside a transaction. */
  function manage(action, payload) {
    var body = Object.assign({ action: action }, payload || {});
    if (state.local) {
      return new Promise(function (resolve) {
        var result = C.manage(state.doc, action, body, nowMs());
        saveSample();
        resolve(result);
      });
    }
    return api('POST', 'api/teams/' + state.code + '/manage', body, { 'X-Rota-Key': state.key }).then(function (d) {
      state.doc = d.team;
      return d.result || {};
    });
  }
  /** A staff phone's change (or the sample's preview of one). */
  function staffAct(action, payload) {
    var body = Object.assign({ action: action }, payload || {});
    if (state.local) {
      return new Promise(function (resolve) {
        var result = C.staff(state.doc, state.preview, action, body, nowMs());
        saveSample();
        state.staff = C.staffView(state.doc, state.preview, nowMs());
        resolve(result);
      });
    }
    return api('POST', 'api/teams/' + state.code + '/staff', body).then(function (d) { state.staff = d.team; return d.result || {}; });
  }
  function saveSample() { if (state.local) keep(K_SAMPLE, { doc: state.doc, week: state.week }); }
  function week() { return state.doc && state.doc.weeks[state.week] ? state.doc.weeks[state.week] : C.emptyWeek(); }

  /* ---------------- drawing ---------------- */

  var poll = null;
  function draw() {
    if (state.view === 'manager') drawManager();
    else if (state.view === 'staff') drawStaff();
    else drawHome();
  }
  function go(view) { state.view = view; draw(); scrollTo(0, 0); try { main.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }

  /* ---------- home ---------- */

  function peekGrid() {
    var rows = [['Mon', 'Mia', 'Theo', 'Jonah'], ['Tue', 'Priya', 'Kai', 'Lena'], ['Wed', 'Theo', 'Sam', 'Jonah'], ['Thu', 'Mia', 'Ava', 'Lena'], ['Fri', 'Sam', 'Ava', null]];
    return '<div class="peek" aria-hidden="true"><div class="peek-head"><b>Next week</b><span class="chip ok">✓ 32 of 33 filled</span></div>' +
      rows.map(function (r) {
        return '<div class="peek-row"><span class="pd">' + r[0] + '</span>' + r.slice(1).map(function (n) {
          var idx = ['Mia', 'Theo', 'Priya', 'Sam', 'Lena', 'Jonah', 'Ava', 'Kai'].indexOf(n);
          return n ? '<span class="seat on"><span class="pdot" style="--h:' + Math.round((200 + idx * 45) % 360) + '"></span>' + n + '</span>' : '<span class="seat gap">Open</span>';
        }).join('') + '</div>';
      }).join('') +
      '<p class="peek-why">“Sam: said they can Fri, 16 → 24 h of a 24 h target, fewest closes this month.”</p></div>';
  }
  function drawHome() {
    var teams = myTeams();
    var codes = Object.keys(teams);
    var sample = recall(K_SAMPLE);
    main.innerHTML =
      '<div class="hero hero-grid"><div>' +
      '<p class="eyebrow">Staff rotas for small hourly teams</p>' +
      '<h1>Next week’s shifts, <em>fair and filled.</em></h1>' +
      '<p class="lede">Your team marks availability from one link. Fill the gaps builds the week - respecting every “can’t”, every role, rest between a close and an open, and everyone’s hours - and tells you why it put each person where it did. Swaps happen in the app, not the group chat.</p>' +
      '<div class="hero-cta"><button class="btn big block" type="button" data-act="sample">☕ Try a sample cafe<span class="sub">8 people, availability already in · one tap to fill</span></button>' +
      '<div class="row"><button class="btn ghost" type="button" data-act="setup">Set up my team</button>' + (sample ? '<button class="btn ghost" type="button" data-act="resume">Back to the sample</button>' : '') + '</div></div>' +
      '<div class="trust"><span>Free</span><span>No account for you or your staff</span><span>First names only</span></div>' +
      '</div>' + peekGrid() + '</div>' +
      (codes.length ? '<section aria-labelledby="yoursH"><h2 id="yoursH">Teams you run</h2><p class="lede">Kept on this phone - the link opens as manager only here.</p><ul class="list">' + codes.map(function (c) {
        return '<li><a class="btn ghost block between" href="' + esc(BASE + 't/' + c) + '"><span>' + esc(teams[c].name || 'Team') + '</span><span aria-hidden="true">→</span></a></li>';
      }).join('') + '</ul></section>' : '') +
      '<section aria-labelledby="howH"><h2 id="howH">How it works</h2><ol class="how">' +
      '<li><b>Set up the week.</b> The shifts you need - day, start, end, role, how many - from a template or last week.</li>' +
      '<li><b>Send one link.</b> Each person opens it on their phone, taps their name and marks next week: can, prefer not, can’t, with hours if they have them.</li>' +
      '<li><b>Fill the gaps.</b> One tap places everyone it can, explains every choice, and tells you honestly what it couldn’t fill and why.</li>' +
      '<li><b>Publish.</b> Everyone sees their shifts, adds them to their calendar, and swaps with whoever the rules allow - you approve, or let it auto-approve.</li></ol></section>' +
      '<section aria-labelledby="whyH"><h2 id="whyH">Why it’s fair, and how you can tell</h2><div class="why">' +
      '<div class="card"><h3>The rules never bend</h3><p>Nobody is put on a day they can’t do, a role they don’t do, two shifts at once, a close then an open with less than 10 hours between, or past their max hours.</p></div>' +
      '<div class="card"><h3>The month, not just the week</h3><p>Closes and weekends are spread across the last four weeks, and people who’ve been short on hours move toward their target.</p></div>' +
      '<div class="card"><h3>Every choice in words</h3><p>Tap any name: why them, who else could have, and who couldn’t and why. The fairness panel shows who’s been short-changed.</p></div>' +
      '</div></section>' +
      '<section aria-labelledby="aiH"><div class="card"><h2 id="aiH">📱 Read their texts</h2><p>Paste the messages your staff already sent - “can’t do Tue, Sat after 4 only”, “any day but no closes” - and get their availability marked for you to check and apply.</p><p class="small muted">' + (signedIn() ? 'Uses a cent or two of AI credit.' : 'Needs a free account. Everything else in Rota is free with no account.') + '</p></div></section>' +
      '<p class="foot small muted">Rota is a trial in the Challenge Lab. Teams are kept for 90 days after their last change. Nothing here checks employment law - minimum breaks and hours rules where you are still apply.</p>';
  }

  /* ---------- manager ---------- */

  function stats(doc, wk) {
    var w = doc.weeks[wk] || C.emptyWeek();
    var seats = 0, filled = 0;
    w.shifts.forEach(function (s) { seats += s.need; filled += Math.min(s.need, (w.assign[s.id] || []).length); });
    return { shifts: w.shifts.length, seats: seats, filled: filled, open: seats - filled };
  }
  function weekBar() {
    var w = week();
    var t = today();
    var cur = C.mondayOf(t);
    var tag = state.week === cur ? 'This week' : state.week === C.addDays(cur, 7) ? 'Next week' : state.week < cur ? 'Past week' : 'Ahead';
    return '<div class="weekbar"><button class="btn small ghost icon" type="button" data-act="wprev" aria-label="Previous week">‹</button>' +
      '<div class="wk"><b>' + esc(C.weekLabel(state.week)) + '</b><span class="small muted">' + tag + ' · ' + (w.published ? '<span class="chip ok">✓ Published</span>' : '<span class="chip">Draft</span>') + '</span></div>' +
      '<button class="btn small ghost icon" type="button" data-act="wnext" aria-label="Next week">›</button></div>';
  }
  function tabBar() {
    var pending = 0;
    var w = week();
    w.swaps.forEach(function (x) { if (x.status === 'pending') pending++; });
    return '<nav class="tabs" aria-label="Rota sections">' + TABS.map(function (t) {
      return '<button type="button" class="tab" data-act="tab" data-id="' + t[0] + '" aria-pressed="' + (state.tab === t[0]) + '">' + t[1] + (t[0] === 'swaps' && pending ? ' <span class="badge">' + pending + '</span>' : '') + '</button>';
    }).join('') + '</nav>';
  }
  function drawManager() {
    if (!state.doc) { main.innerHTML = '<p class="muted">Loading the team…</p>'; return; }
    var doc = state.doc;
    var head = '<div class="mhead"><div><p class="eyebrow">' + (state.local ? 'Sample team · kept on this phone' : 'Your team') + '</p><h1 class="tname">' + esc(doc.team.name) + '</h1></div>' +
      (state.local ? '<div class="row"><button class="btn small ghost" type="button" data-act="setup">Set up my own team</button></div>' : '<div class="row"><button class="btn small" type="button" data-act="sharelink">Share team link</button></div>') + '</div>';
    var body = '';
    if (state.tab === 'week') body = drawWeek();
    else if (state.tab === 'team') body = drawTeam();
    else if (state.tab === 'fair') body = drawFair();
    else if (state.tab === 'swaps') body = drawSwaps();
    else body = drawSettings();
    main.innerHTML = head + weekBar() + tabBar() + '<div class="tabbody">' + body + '</div>';
    afterManager();
  }
  function afterManager() {
    var f = $('#setForm');
    if (f) f.addEventListener('submit', saveSettings);
    if (!REDUCED) {
      $$('.seat.fresh').forEach(function (el, i) { el.style.animationDelay = Math.min(i * 14, 500) + 'ms'; });
    }
    state.fresh = {};
  }

  function seatHtml(s, a, conflicts, w) {
    var p = C.personOf(state.doc, a.pid);
    var name = p ? p.name : '?';
    var bad = conflicts.filter(function (c) { return c.shiftId === s.id && c.pid === a.pid; })[0];
    var pref = C.availOf(w, a.pid, s.day).s === 'prefer';
    var fresh = state.fresh[s.id + ':' + a.pid];
    return '<button type="button" class="seat on' + (bad ? ' bad' : '') + (fresh ? ' fresh' : '') + '" data-act="seat" data-id="' + esc(s.id) + '" data-pid="' + esc(a.pid) + '" aria-label="' + esc(name + ', ' + C.shiftLabel(s) + (bad ? ', breaks a rule: ' + bad.text : '') + '. Why them?') + '">' +
      dot(a.pid) + '<span class="nm">' + esc(name) + '</span>' +
      (a.by === 'swap' ? '<span class="tag">swap</span>' : '') +
      (pref ? '<span class="tag soft">prefer not</span>' : '') +
      (bad ? '<span class="warn">⚠ ' + esc(bad.text) + '</span>' : '') + '</button>';
  }
  function shiftCard(s, w, conflicts, gapIds) {
    var t = C.shiftTimes(state.doc.team, state.week, s);
    var list = w.assign[s.id] || [];
    var open = s.need - list.length;
    var seats = list.map(function (a) { return seatHtml(s, a, conflicts, w); }).join('');
    for (var i = 0; i < open; i++) seats += '<button type="button" class="seat gap' + (gapIds[s.id] ? ' flagged' : '') + '" data-act="open" data-id="' + esc(s.id) + '" aria-label="' + esc('Open seat, ' + C.shiftLabel(s) + '. Pick someone') + '">+ Open seat</button>';
    var tags = (t.close ? '<span class="kind">Close</span>' : '') + (t.open ? '<span class="kind">Open</span>' : '');
    return '<article class="shift' + (open > 0 ? ' short' : '') + '"><button type="button" class="sh-head" data-act="editshift" data-id="' + esc(s.id) + '" aria-label="' + esc('Edit ' + C.shiftLabel(s)) + '">' +
      '<span class="time">' + esc(C.fmtTime(s.start)) + '–' + esc(C.fmtTime(s.end)) + '</span><span class="role">' + esc(s.role) + (s.need > 1 ? ' × ' + s.need : '') + '</span>' + tags +
      (Math.abs(t.hours - ((C.toMin(s.end) - C.toMin(s.start) + 1440) % 1440 || 1440) / 60) > 0.01 ? '<span class="kind dst">' + esc(t.hours) + ' real h (clocks change)</span>' : '') +
      '</button><div class="seats">' + seats + '</div></article>';
  }
  function drawWeek() {
    var doc = state.doc;
    var w = week();
    var st = stats(doc, state.week);
    var conflicts = C.conflicts(doc, state.week);
    var gl = st.open ? C.gaps(doc, state.week) : [];
    var gapIds = {};
    gl.forEach(function (g) { gapIds[g.shiftId] = true; });
    var fair = st.filled ? C.fairness(doc, state.week) : null;
    if (!w.shifts.length) {
      return '<div class="card empty"><h2>No shifts yet for this week</h2><p>Start from a template, copy an earlier week, or add shifts one at a time.</p>' +
        '<div class="row">' + Object.keys(C.TEMPLATES).map(function (k) { return '<button class="btn small ghost" type="button" data-act="template" data-id="' + k + '">' + esc(C.TEMPLATES[k].label) + '</button>'; }).join('') + '</div>' +
        (prevWeekWithShifts() ? '<p style="margin-top:12px"><button class="btn small" type="button" data-act="copyweek">Copy shifts from ' + esc(C.weekLabel(prevWeekWithShifts())) + '</button></p>' : '') +
        '<p><button class="btn small ghost" type="button" data-act="addshift" data-id="0">+ Add a shift</button></p></div>';
    }
    var lf = state.lastFill && state.lastFill.week === state.week ? state.lastFill : null;
    var html = '';
    if (state.local && !st.filled && !lf) { // the sample's first screen
      html += '<div class="coach card"><p class="eyebrow">Sample cafe</p><h2>Everyone’s availability is in. The week is empty.</h2><p>' + plural(st.shifts, 'shift') + ', ' + plural(st.seats, 'seat') + ' to fill across ' + plural(doc.people.length, 'person', 'people') + '. Ava has uni Monday to Wednesday, Kai is done by 2pm on weekdays, Sam can only do Saturday after noon, and neither cook works Sundays.</p>' +
        '<button class="btn big block" type="button" data-act="fill">✨ Fill the gaps<span class="sub">Every placement explained, every gap said out loud</span></button></div>';
    }
    var coach = state.local && !st.filled && !lf;
    html += '<div class="actions-bar">' + (coach ? '' : '<button class="btn" type="button" data-act="fill">✨ Fill the gaps</button>') +
      (w.published ? '<button class="btn ghost" type="button" data-act="unpublish">Unpublish</button>' : '<button class="btn ghost" type="button" data-act="publish">Publish the week</button>') +
      '<button class="btn ghost" type="button" data-act="weekmore">More…</button></div>';
    html += '<div class="summary" role="status">' +
      '<span><b>' + st.filled + '</b> of ' + st.seats + ' seats filled</span>' +
      '<span class="' + (st.open ? 'warnc' : '') + '"><b>' + st.open + '</b> open</span>' +
      '<span class="' + (conflicts.length ? 'warnc' : '') + '"><b>' + conflicts.length + '</b> rule ' + (conflicts.length === 1 ? 'break' : 'breaks') + '</span>' +
      (fair ? '<button type="button" class="link-btn" data-act="tab" data-id="fair">Fairness <b>' + fair.score + '</b> · ' + esc(fair.band.label) + '</button>' : '') + '</div>';
    if (lf) {
      html += '<div class="result card" role="status"><h2>' + (lf.gaps.length ? 'Filled ' + lf.placed.length + ' seats - ' + plural(lf.gaps.reduce(function (s, g) { return s + g.seats; }, 0), 'gap') + ' it couldn’t fill' : (lf.placed.length ? 'Filled all ' + lf.placed.length + ' open seats' : 'Nothing left to fill')) + '</h2>' +
        (lf.before !== null && fair ? '<p class="delta"><span class="small muted">Fairness over four weeks</span><span class="big"><b>' + lf.before + '</b> <span aria-hidden="true">→</span><span class="vh">to</span> <b>' + fair.score + '</b></span><button class="btn small ghost" type="button" data-act="tab" data-id="fair">See why</button></p>' : '') +
        (lf.moved && lf.moved.length ? '<p class="small muted">To fill everything it could, it moved ' + lf.moved.map(function (m) { var s = shiftById(m.shiftId); return esc((C.personOf(doc, m.from) || {}).name) + '’s ' + esc(s ? C.shiftLabel(s) : 'shift') + ' to ' + esc((C.personOf(doc, m.to) || {}).name); }).join('; ') + '.</p>' : '') +
        '<p class="small muted">Tap any name to see why it chose them.</p></div>';
    }
    if (gl.length) {
      html += '<section class="gaps card" aria-labelledby="gapsH"><h2 id="gapsH">' + (gl.length === 1 ? 'The gap, honestly' : 'The gaps, honestly') + '</h2><ul>' + gl.map(function (g) {
        return '<li><p><b>' + esc(g.text.split(': ')[0]) + '</b>' + (g.seats > 1 ? ' (' + g.seats + ' seats)' : '') + ': ' + esc(g.text.split(': ').slice(1).join(': ')) + '</p><p class="small muted">' + esc(g.fix) + '</p></li>';
      }).join('') + '</ul></section>';
    }
    if (conflicts.length) {
      html += '<section class="conf card" aria-labelledby="confH"><h2 id="confH">Breaks a rule</h2><ul>' + conflicts.map(function (c) {
        var s = shiftById(c.shiftId);
        return '<li>⚠ <b>' + esc(c.name) + '</b> on ' + esc(s ? C.shiftLabel(s) : '') + ': ' + esc(c.text) + '</li>';
      }).join('') + '</ul><p class="small muted">You can overrule a rule - it stays flagged here until it’s fixed.</p></section>';
    }
    // The day strip (phone width) and the week grid.
    var flags = [0, 0, 0, 0, 0, 0, 0];
    gl.forEach(function (g) { var s = shiftById(g.shiftId); if (s) flags[s.day] = 1; });
    conflicts.forEach(function (c) { var s = shiftById(c.shiftId); if (s) flags[s.day] = 1; });
    html += '<div class="daybar" role="group" aria-label="Day">' + C.DAYS.map(function (d, i) {
      var date = C.addDays(state.week, i);
      return '<button type="button" class="dayb" data-act="day" data-id="' + i + '" aria-pressed="' + (state.day === i) + '"><span>' + d + '</span><b>' + Number(date.slice(8, 10)) + '</b>' + (flags[i] ? '<span class="flag" aria-label="needs a look">!</span>' : '') + '</button>';
    }).join('') + '</div>';
    html += '<div class="grid">' + C.DAYS.map(function (d, i) {
      var shifts = w.shifts.filter(function (s) { return s.day === i; });
      var h = state.doc.team.hours[i];
      return '<section class="day' + (state.day === i ? ' sel' : '') + '" aria-label="' + esc(C.DAY_LONG[i]) + '"><h3>' + esc(C.dayLabel(C.addDays(state.week, i))) + '<span class="small muted">' + (h ? esc(C.fmtTime(h.open)) + '–' + esc(C.fmtTime(h.close)) : 'Closed') + '</span></h3>' +
        (shifts.length ? shifts.map(function (s) { return shiftCard(s, w, conflicts, gapIds); }).join('') : '<p class="small muted none">No shifts</p>') +
        '<button type="button" class="addsh" data-act="addshift" data-id="' + i + '">+ Add shift</button></section>';
    }).join('') + '</div>';
    return html;
  }
  function shiftById(id) { return week().shifts.filter(function (s) { return s.id === id; })[0] || null; }
  function prevWeekWithShifts() {
    var ks = Object.keys(state.doc.weeks).filter(function (k) { return k < state.week && state.doc.weeks[k].shifts.length; }).sort();
    return ks.length ? ks[ks.length - 1] : null;
  }

  function availCells(av) {
    return '<span class="avcells">' + C.DAYS.map(function (d, i) {
      var a = av && av.days ? av.days[i] : null;
      var s = a ? a.s : null;
      var hrs = a && (a.from || a.to) ? (a.from ? C.fmtTime(a.from) : '') + '–' + (a.to ? C.fmtTime(a.to) : '') : '';
      return '<span class="avc ' + (s || 'none') + '" title="' + esc(d + ': ' + (s ? C.STATE_LABEL[s] : 'not marked') + (hrs ? ' ' + hrs : '')) + '"><span class="d">' + d.slice(0, 2) + '</span><span class="v">' + (s ? STATE_ICON[s] : '·') + '</span>' + (hrs ? '<span class="hh">' + esc(hrs) + '</span>' : '') + '</span>';
    }).join('') + '</span>';
  }
  function drawTeam() {
    var doc = state.doc;
    var w = week();
    var stw = C.weekStats(doc, state.week);
    var marked = doc.people.filter(function (p) { return w.avail[p.id]; }).length;
    var html = '';
    if (state.local) {
      html += '<div class="card linkcard"><h2>Your team’s link</h2><p>For a real team, you share one link in the group chat. Each person taps it, picks their name and marks their week - no app, no account. In the sample, see it from a staff phone:</p><div class="row">' +
        doc.people.slice(0, 3).map(function (p) { return '<button class="btn small ghost" type="button" data-act="preview" data-id="' + esc(p.id) + '">📱 ' + esc(p.name) + '’s phone</button>'; }).join('') + '</div></div>';
    } else {
      html += '<div class="card linkcard"><h2>Your team’s link</h2><p>Share it in the group chat. Each person taps it, picks their name or adds it, and marks their week - no app, no account. It shows first names only.</p><p class="linkline"><code>' + esc(teamLink(state.code)) + '</code></p><div class="row"><button class="btn small" type="button" data-act="sharelink">Share</button><button class="btn small ghost" type="button" data-act="copylink">Copy link</button></div><p class="small muted">Opened on this phone, the link is you as manager. Anyone with it can see the published rota and first names - share it with your team only.</p></div>';
    }
    html += '<div class="row between teamhead"><h2>' + plural(doc.people.length, 'person', 'people') + ' · ' + marked + ' marked ' + esc(C.weekLabel(state.week)) + '</h2><div class="row"><button class="btn small" type="button" data-act="texts">📱 Read their texts</button><button class="btn small ghost" type="button" data-act="addperson">+ Add person</button></div></div>';
    html += '<ul class="people">' + doc.people.map(function (p) {
      var av = w.avail[p.id];
      var r = stw[p.id] || { hours: 0 };
      return '<li class="card person"><button type="button" class="pbtn" data-act="person" data-id="' + esc(p.id) + '" aria-label="' + esc('Edit ' + p.name) + '"><span class="pname">' + dot(p.id) + '<b>' + esc(p.name) + '</b>' + (state.local ? '' : (p.linked ? '<span class="tag">on their phone</span>' : '<span class="tag soft">not joined yet</span>')) + '</span>' +
        '<span class="small muted">' + esc(p.roles.join(', ') || 'No roles yet') + ' · ' + esc(r.hours) + ' h this week' + (p.targetHours ? ' of ' + p.targetHours + ' target' : '') + (p.maxHours ? ' · max ' + p.maxHours : '') + '</span>' +
        availCells(av) + (av && av.noCloses ? '<span class="small">No closes, please</span>' : '') + (av && av.note ? '<span class="small muted note-q">“' + esc(av.note) + '”</span>' : (!av ? '<span class="small muted">Hasn’t marked this week</span>' : '')) + '</button></li>';
    }).join('') + '</ul>';
    return html;
  }

  function bar(v, max, target) {
    var m = Math.max(max || 0, target || 0, v, 1);
    return '<span class="hbar" aria-hidden="true"><span class="fill" style="width:' + Math.min(100, v / m * 100).toFixed(1) + '%"></span>' + (target ? '<span class="tgt" style="left:' + Math.min(100, target / m * 100).toFixed(1) + '%"></span>' : '') + '</span>';
  }
  function drawFair() {
    var doc = state.doc;
    var f = C.fairness(doc, state.week);
    var st = stats(doc, state.week);
    var html = '<div class="fairtop">' +
      '<div class="card scorecard"><div class="ring" role="img" aria-label="' + esc('Fairness ' + f.score + ' out of 100, ' + f.band.label) + '"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="50" class="bgc"/><circle cx="60" cy="60" r="50" class="fgc b-' + esc(f.band.id) + '" style="stroke-dasharray:' + (f.score * 3.1416).toFixed(1) + ' 400"/></svg><span class="num">' + f.score + '</span></div>' +
      '<div><p class="eyebrow">Fairness, last ' + f.weeks.length + ' weeks</p><h2 class="band b-' + esc(f.band.id) + '">' + esc(f.band.label) + '</h2><p class="small muted">' + (st.filled ? 'Judged over this week and the ' + plural(f.weeks.length - 1, 'week') + ' before it. One week can only make up part of an unfair month.' : 'Nothing is placed this week yet - this is the last few weeks on their own.') + '</p></div></div>' +
      '<ul class="parts card">' + f.parts.map(function (p) { return '<li><span><b>' + esc(p.label) + '</b><span class="small muted">' + esc(p.text) + '</span></span><span class="pts' + (p.pts ? ' neg' : '') + '">' + (p.pts ? '−' + p.pts : '✓') + '</span></li>'; }).join('') + '</ul></div>';
    html += '<section class="card short" aria-labelledby="shortH"><h2 id="shortH">Short-changed over the last ' + f.weeks.length + ' weeks</h2>' +
      (f.short.length ? '<ul>' + f.short.map(function (s) { return '<li>' + dot(s.id) + '<b>' + esc(s.name) + '</b>: ' + s.why.map(esc).join('; ') + '</li>'; }).join('') + '</ul><p class="small muted">Fill the gaps already leans toward these people for hours, and away from them for closes and weekends.</p>' : '<p>Nobody - hours, closes and weekends are evenly shared.</p>') + '</section>';
    html += '<div class="tablewrap"><table class="ftable"><caption class="vh">Hours, closes, weekends and prefer-not days per person</caption><thead><tr><th scope="col">Person</th><th scope="col">Hours this week</th><th scope="col">Closes</th><th scope="col">Weekends</th><th scope="col">Prefer-nots</th></tr></thead><tbody>' +
      f.people.map(function (p) {
        var wk = p.week, wd = p.window;
        var off = p.target ? Math.round((wk.hours - p.target) * 10) / 10 : null;
        return '<tr><th scope="row">' + dot(p.id) + esc(p.name) + '</th><td><span class="hrow">' + bar(wk.hours, p.max, p.target) + '<span><b>' + esc(wk.hours) + '</b>' + (p.target ? ' / ' + p.target + ' h' : ' h') + (off !== null && Math.abs(off) >= 1 ? ' <span class="small ' + (off < 0 ? 'under' : 'over') + '">(' + (off > 0 ? '+' : '') + off + ')</span>' : '') + '</span></span></td>' +
          '<td><b>' + wk.closes + '</b> <span class="small muted">· ' + wd.closes + ' in ' + wd.weeks + ' wk</span></td><td><b>' + wk.weekends + '</b> <span class="small muted">· ' + wd.weekends + ' in ' + wd.weeks + ' wk</span></td><td>' + (wk.preferNots ? '<b>' + wk.preferNots + '</b>' : '0') + '</td></tr>';
      }).join('') + '</tbody></table></div><p class="small muted">The bar is hours this week; the mark is the person’s target.</p>';
    return html;
  }

  function drawSwaps() {
    var doc = state.doc;
    var w = week();
    var nm = function (pid) { return esc((C.personOf(doc, pid) || {}).name || 'someone'); };
    var pending = w.swaps.filter(function (x) { return x.status === 'pending'; });
    var open = w.swaps.filter(function (x) { return x.status === 'open'; });
    var html = '<div class="card"><div class="row between"><div><h2>Swaps</h2><p class="small muted">Staff offer a shift from their phone; only teammates the rules allow can claim it.</p></div>' +
      '<button type="button" class="toggle" data-act="autoapprove" aria-pressed="' + Boolean(doc.team.autoApprove) + '"><span class="knob" aria-hidden="true"></span>Auto-approve when no rule breaks</button></div>';
    html += pending.length ? '<ul class="swaplist">' + pending.map(function (x) {
      var s = shiftById(x.shiftId);
      return '<li><p><b>' + nm(x.to) + '</b> wants ' + nm(x.from) + '’s ' + esc(s ? C.shiftLabel(s) : 'shift') + '</p><div class="row"><button class="btn small" type="button" data-act="approve" data-id="' + esc(x.id) + '">Approve</button><button class="btn small ghost" type="button" data-act="decline" data-id="' + esc(x.id) + '">Decline</button></div></li>';
    }).join('') + '</ul>' : '<p class="muted">Nothing waiting for you this week.</p>';
    if (open.length) html += '<h3>Up for grabs</h3><ul class="swaplist">' + open.map(function (x) { var s = shiftById(x.shiftId); return '<li>' + nm(x.from) + ' offered ' + esc(s ? C.shiftLabel(s) : 'a shift') + (x.note ? ' <span class="small muted">“' + esc(x.note) + '”</span>' : '') + '</li>'; }).join('') + '</ul>';
    if (state.local) html += '<p class="small muted">In the sample, publish the week, then open a staff phone from the Team tab to offer and claim a swap.</p>';
    html += '</div><section class="card" aria-labelledby="logH"><h2 id="logH">Change log</h2><ol class="log">' + (doc.log || []).slice().reverse().slice(0, 80).map(function (l) {
      return '<li><span class="small muted">' + esc(new Date(l.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })) + '</span> ' + esc(l.text) + '</li>';
    }).join('') + '</ol></section>';
    return html;
  }

  function zoneOptions(cur) {
    var zs = [];
    try { zs = Intl.supportedValuesOf('timeZone'); } catch (e) { zs = [cur, 'UTC']; }
    if (zs.indexOf(cur) < 0) zs.unshift(cur);
    return zs.map(function (z) { return '<option' + (z === cur ? ' selected' : '') + '>' + esc(z) + '</option>'; }).join('');
  }
  function drawSettings() {
    var t = state.doc.team;
    return '<form id="setForm" class="card"><h2>Settings</h2>' +
      '<label class="field"><span>Business name</span><input class="input" name="name" maxlength="' + C.LIMITS.team + '" value="' + esc(t.name) + '"></label>' +
      '<label class="field"><span>Time zone</span><select class="input" name="zone">' + zoneOptions(t.zone) + '</select><span class="hint">Shift times are in this zone, and a shift across a clock change counts its real hours.</span></label>' +
      '<label class="field"><span>Rest between a close and the next day’s shift</span><select class="input" name="minRest">' + C.LIMITS.minRest.map(function (h) { return '<option value="' + h + '"' + (h === t.minRest ? ' selected' : '') + '>' + (h ? h + ' hours' : 'No minimum') + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Roles (stations), comma separated</span><input class="input" name="roles" value="' + esc(t.roles.join(', ')) + '"><span class="hint">Up to ' + C.LIMITS.roles + '. Removing a role removes its shifts.</span></label>' +
      '<fieldset class="field hours"><legend class="lbl">Opening hours</legend><p class="hint">A shift ending within 30 minutes of closing counts as a close.</p>' + C.DAYS.map(function (d, i) {
        var h = t.hours[i];
        return '<div class="hrow2"><span class="d">' + d + '</span><input class="input" type="time" name="open' + i + '" value="' + (h ? h.open : '') + '" aria-label="' + d + ' opens"><span aria-hidden="true">–</span><input class="input" type="time" name="close' + i + '" value="' + (h ? h.close : '') + '" aria-label="' + d + ' closes"></div>';
      }).join('') + '<p class="hint">Leave a day blank if you’re closed.</p></fieldset>' +
      '<div id="setErr"></div><button class="btn block" type="submit">Save settings</button></form>' +
      '<div class="card danger"><h2>' + (state.local ? 'Start the sample over' : 'Delete this team') + '</h2><p class="small muted">' + (state.local ? 'Puts the sample back as it was: the empty week and everyone’s availability.' : 'Deletes the team, its weeks and its link for everyone. It can’t be undone.') + '</p><button class="btn ghost" type="button" data-act="' + (state.local ? 'resetsample' : 'delteam') + '">' + (state.local ? 'Start over' : 'Delete the team') + '</button></div>';
  }
  function saveSettings(e) {
    e.preventDefault();
    var f = e.target;
    var hours = C.DAYS.map(function (d, i) { var o = f['open' + i].value, c = f['close' + i].value; return o && c ? { open: o, close: c } : null; });
    manage('settings', { name: f.name.value, zone: f.zone.value, minRest: Number(f.minRest.value), roles: f.roles.value.split(',').map(function (r) { return r.trim(); }).filter(Boolean), hours: hours, autoApprove: state.doc.team.autoApprove })
      .then(function () { toast('Saved.'); draw(); }).catch(function (err) { showError(err, $('#setErr')); });
  }

  /* ---------- sheets ---------- */

  var lastFocus = null;
  function sheet(html, after) {
    lastFocus = document.activeElement;
    var s = $('#sheet');
    // A fresh container each time, so listeners a sheet adds die with it.
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
    state.texts = null;
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  function head(title) { return '<div class="sheet-head"><h2>' + esc(title) + '</h2><button class="x" type="button" data-act="closesheet" aria-label="Close">×</button></div>'; }

  /** An open seat: who could take it, and who couldn't and why. */
  function openPick(sid, pidOn) {
    var s = shiftById(sid);
    if (!s) return;
    var list = C.candidates(state.doc, state.week, sid, { except: pidOn || undefined });
    var ok = list.filter(function (c) { return c.ok && c.pid !== pidOn; });
    var no = list.filter(function (c) { return !c.ok && !c.on && c.pid !== pidOn; });
    var ex = pidOn ? C.explain(state.doc, state.week, sid, pidOn) : null;
    var html = head(C.shiftLabel(s));
    if (ex) {
      html += '<div class="explain"><p class="eyebrow">Why ' + esc(ex.name) + '</p><ul>' + ex.lines.map(function (l) { return '<li>' + esc(cap(l)) + '</li>'; }).join('') + '</ul><p class="vs">' + esc(ex.versus) + '</p>' +
        '<button class="btn small ghost" type="button" data-act="unseat" data-id="' + esc(sid) + '" data-pid="' + esc(pidOn) + '">Take ' + esc(ex.name) + ' off</button></div>' + (ok.length ? '<h3>Or swap in</h3>' : '');
    } else {
      html += '<p class="muted">' + (ok.length ? 'Best fit first. Every name here keeps every rule.' : 'Nobody can take this without breaking a rule.') + '</p>';
    }
    html += '<ul class="cands">' + ok.map(function (c) {
      return '<li><button class="cand" type="button" data-act="put" data-id="' + esc(sid) + '" data-pid="' + esc(c.pid) + '"' + (pidOn ? ' data-swap="' + esc(pidOn) + '"' : '') + '>' + dot(c.pid) + '<span><b>' + esc(c.name) + '</b><span class="small muted">' + esc(cap(c.why.join(' · '))) + '</span></span><span class="go" aria-hidden="true">+</span></button></li>';
    }).join('') + '</ul>';
    if (no.length) html += '<details class="blocked"><summary>' + plural(no.length, 'person', 'people') + ' can’t, and why</summary><ul>' + no.map(function (c) {
      return '<li><span>' + dot(c.pid) + '<b>' + esc(c.name) + '</b> ' + esc(c.blockers.map(function (b) { return b.text; }).join(', ')) + '</span><button class="btn small ghost" type="button" data-act="put" data-id="' + esc(sid) + '" data-pid="' + esc(c.pid) + '"' + (pidOn ? ' data-swap="' + esc(pidOn) + '"' : '') + '>Put on anyway</button></li>';
    }).join('') + '</ul></details>';
    sheet(html);
  }
  function putOn(sid, pid, swapOut) {
    var p = swapOut ? manage('seat', { week: state.week, shiftId: sid, pid: swapOut, on: false }) : Promise.resolve();
    p.then(function () { return manage('seat', { week: state.week, shiftId: sid, pid: pid, on: true }); })
      .then(function () { closeSheet(true); state.fresh[sid + ':' + pid] = 1; draw(); })
      .catch(function (err) { showError(err); });
  }

  function openShift(day, sid) {
    var s = sid ? shiftById(sid) : null;
    var roles = state.doc.team.roles;
    var f = s ? { day: s.day, start: s.start, end: s.end, role: s.role, need: s.need } : { day: Number(day) || 0, start: '09:00', end: '17:00', role: roles[0], need: 1 };
    sheet(head(s ? 'Edit shift' : 'Add a shift') + '<form id="shForm">' +
      '<div class="field"><span class="lbl">Day</span><div class="pills" role="group" aria-label="Day">' + C.DAYS.map(function (d, i) { return '<button type="button" class="pill" data-k="day" data-v="' + i + '" aria-pressed="' + (f.day === i) + '">' + d + '</button>'; }).join('') + '</div></div>' +
      '<div class="two"><label class="field"><span>Starts</span><input class="input" type="time" name="start" value="' + esc(f.start) + '" required></label><label class="field"><span>Ends</span><input class="input" type="time" name="end" value="' + esc(f.end) + '" required><span class="hint">Earlier than the start = ends the next day.</span></label></div>' +
      '<div class="field"><span class="lbl">Role</span><div class="pills" role="group" aria-label="Role">' + roles.map(function (r) { return '<button type="button" class="pill" data-k="role" data-v="' + esc(r) + '" aria-pressed="' + (f.role === r) + '">' + esc(r) + '</button>'; }).join('') + '</div></div>' +
      '<label class="field"><span>How many people</span><input class="input" type="number" name="need" min="1" max="' + C.LIMITS.need + '" value="' + f.need + '"></label>' +
      '<div id="shErr"></div><button class="btn block" type="submit">' + (s ? 'Save shift' : 'Add shift') + '</button>' +
      (s ? '<button class="btn ghost block" type="button" data-act="delshift" data-id="' + esc(s.id) + '" style="margin-top:10px">Remove this shift</button>' : '') + '</form>', function (root) {
      root.addEventListener('click', function (e) {
        var t = e.target.closest('[data-k]');
        if (!t) return;
        f[t.getAttribute('data-k')] = t.getAttribute('data-k') === 'day' ? Number(t.getAttribute('data-v')) : t.getAttribute('data-v');
        $$('[data-k="' + t.getAttribute('data-k') + '"]', root).forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); });
      });
      $('#shForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var shift = { day: f.day, start: e.target.start.value, end: e.target.end.value, role: f.role, need: Number(e.target.need.value) };
        if (s) shift.id = s.id;
        manage('shift', { week: state.week, shift: shift }).then(function () { closeSheet(true); state.day = f.day; draw(); }).catch(function (err) { showError(err, $('#shErr', root)); });
      });
    });
  }

  function availEditor(av, roles) {
    var days = (av && av.days) || [null, null, null, null, null, null, null];
    return '<div class="avedit" role="group" aria-label="Availability by day">' + C.DAYS.map(function (d, i) {
      var a = days[i];
      var s = a ? a.s : null;
      return '<div class="avday ' + (s || 'none') + '"><button type="button" class="avtap" data-act="cycle" data-id="' + i + '" aria-label="' + esc(C.DAY_LONG[i] + ': ' + (s ? C.STATE_LABEL[s] : 'not marked') + '. Tap to change') + '"><span class="d">' + d + '</span><span class="v">' + (s ? STATE_ICON[s] + ' ' + C.STATE_LABEL[s] : 'Tap to mark') + '</span></button>' +
        (s && s !== 'cant' && !(a && (a.from || a.to)) && !(av.open && av.open[i]) ? '<button type="button" class="hours-add" data-act="addhours" data-id="' + i + '" aria-label="' + esc('Add hours for ' + C.DAY_LONG[i]) + '">+ Add hours</button>' : '') +
        (s && s !== 'cant' && ((a && (a.from || a.to)) || (av.open && av.open[i])) ? '<div class="avh"><label><span class="vh">' + d + ' from</span><input class="input" type="time" data-h="from" data-id="' + i + '" value="' + esc((a && a.from) || '') + '"></label><span aria-hidden="true">–</span><label><span class="vh">' + d + ' until</span><input class="input" type="time" data-h="to" data-id="' + i + '" value="' + esc((a && a.to) || '') + '"></label></div>' : '') + '</div>';
    }).join('') + '</div><p class="small muted">Tap a day: Can → Prefer not → Can’t. Add hours only if you have them (“after 4pm” = from 16:00).</p>';
  }
  function bindAvail(root, draft, redraw) {
    root.addEventListener('click', function (e) {
      var hb = e.target.closest('[data-act="addhours"]');
      if (hb) {
        e.stopPropagation();
        draft.open = draft.open || {};
        draft.open[hb.getAttribute('data-id')] = true;
        redraw();
        var inp = $('input[data-h="from"][data-id="' + hb.getAttribute('data-id') + '"]', root);
        if (inp) inp.focus();
        return;
      }
      var t = e.target.closest('[data-act="cycle"]');
      if (!t) return;
      e.stopPropagation();
      var i = Number(t.getAttribute('data-id'));
      var cur = draft.days[i] ? draft.days[i].s : null;
      var next = cur === null ? 'can' : cur === 'can' ? 'prefer' : cur === 'prefer' ? 'cant' : null;
      draft.days[i] = next ? { s: next, from: next === 'cant' ? null : (draft.days[i] && draft.days[i].from) || null, to: next === 'cant' ? null : (draft.days[i] && draft.days[i].to) || null } : null;
      redraw();
      var again = $('[data-act="cycle"][data-id="' + i + '"]', root);
      if (again) again.focus();
    }, true);
    root.addEventListener('change', function (e) {
      var t = e.target;
      if (t.getAttribute('data-h')) { var i = Number(t.getAttribute('data-id')); if (draft.days[i]) draft.days[i][t.getAttribute('data-h')] = t.value || null; }
      if (t.name === 'noCloses') draft.noCloses = t.checked;
    });
    root.addEventListener('input', function (e) { if (e.target.name === 'note') draft.note = e.target.value; });
  }

  function openPerson(pid) {
    var doc = state.doc;
    var p = pid ? C.personOf(doc, pid) : null;
    var w = week();
    var av = p ? w.avail[p.id] : null;
    var draft = { days: ((av && av.days) || [null, null, null, null, null, null, null]).map(function (d) { return d ? { s: d.s, from: d.from, to: d.to } : null; }), noCloses: Boolean(av && av.noCloses), note: (av && av.note) || '', roles: p ? p.roles.slice() : [] };
    function body() {
      return head(p ? p.name : 'Add a person') + '<form id="pForm">' +
        '<label class="field"><span>First name</span><input class="input" name="name" maxlength="40" value="' + esc(p ? p.name : '') + '" autocomplete="off" ' + (p ? '' : 'autofocus') + '><span class="hint">First name and an initial at most - the team link shows names.</span></label>' +
        '<div class="field"><span class="lbl">Roles they can work</span><div class="pills" role="group" aria-label="Roles">' + doc.team.roles.map(function (r) { return '<button type="button" class="pill" data-k="role" data-v="' + esc(r) + '" aria-pressed="' + (draft.roles.indexOf(r) >= 0) + '">' + esc(r) + '</button>'; }).join('') + '</div></div>' +
        '<div class="two"><label class="field"><span>Target hours / week</span><input class="input" type="number" name="target" min="1" max="' + C.LIMITS.hours + '" value="' + (p && p.targetHours ? p.targetHours : '') + '"></label><label class="field"><span>Max hours / week</span><input class="input" type="number" name="max" min="1" max="' + C.LIMITS.hours + '" value="' + (p && p.maxHours ? p.maxHours : '') + '"></label></div>' +
        (p ? '<h3>Availability, ' + esc(C.weekLabel(state.week)) + '</h3><p class="small muted">Normally they mark this from the team link. Mark it here if they told you in person.</p>' + availEditor(draft, doc.team.roles) +
          '<label class="check"><input type="checkbox" name="noCloses"' + (draft.noCloses ? ' checked' : '') + '> No closing shifts this week</label>' +
          '<label class="field"><span>Note</span><input class="input" name="note" maxlength="' + C.LIMITS.note + '" value="' + esc(draft.note) + '"></label>' : '') +
        '<div id="pErr"></div><button class="btn block" type="submit">' + (p ? 'Save' : 'Add to the team') + '</button>' +
        (p ? '<div class="row" style="margin-top:10px">' + (!state.local && p.linked ? '<button class="btn small ghost" type="button" data-act="unlink" data-id="' + esc(p.id) + '">Free their name for a new phone</button>' : '') + '<button class="btn small ghost" type="button" data-act="delperson" data-id="' + esc(p.id) + '">Remove from the team</button></div>' : '') + '</form>';
    }
    sheet(body(), function (root) {
      function redraw() {
        var ed = $('.avedit', root);
        if (ed) { var tmp = document.createElement('div'); tmp.innerHTML = availEditor(draft); ed.parentNode.replaceChild(tmp.firstChild, ed); }
      }
      bindAvail(root, draft, redraw);
      root.addEventListener('click', function (e) {
        var t = e.target.closest('[data-k="role"]');
        if (!t) return;
        var r = t.getAttribute('data-v');
        var i = draft.roles.indexOf(r);
        if (i >= 0) draft.roles.splice(i, 1); else draft.roles.push(r);
        t.setAttribute('aria-pressed', String(i < 0));
      });
      $('#pForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target;
        var person = { name: f.name.value, roles: draft.roles, targetHours: f.target.value ? Number(f.target.value) : null, maxHours: f.max.value ? Number(f.max.value) : null };
        if (p) person.id = p.id;
        manage('person', { person: person }).then(function () {
          if (!p) return null;
          return manage('avail', { week: state.week, pid: p.id, days: draft.days, noCloses: draft.noCloses, note: draft.note });
        }).then(function () { closeSheet(true); draw(); toast(p ? 'Saved.' : 'Added.'); }).catch(function (err) { showError(err, $('#pErr', root)); });
      });
    });
  }

  function openWeekMore() {
    var prev = prevWeekWithShifts();
    sheet(head('This week') + '<div class="stack">' +
      '<button class="btn ghost block" type="button" data-act="clearfill">Clear what Fill placed<span class="sub">Your own picks and swaps stay</span></button>' +
      (prev ? '<button class="btn ghost block" type="button" data-act="copyweek">Copy shifts from ' + esc(C.weekLabel(prev)) + '</button>' : '') +
      '<button class="btn ghost block" type="button" data-act="addshift" data-id="' + state.day + '">+ Add a shift</button>' +
      (week().published ? '' : '<button class="btn ghost block" type="button" data-act="clearweek">Clear this week’s shifts</button>') + '</div>');
  }

  /* ---------- Read their texts (the one model call) ---------- */

  var TEXTS_EXAMPLE = 'Theo: can\'t do Tue, Sat after 4 only\nPriya: any day but no closes\nAva: rather not Sunday, max 18 hours';
  function openTexts() {
    if (!signedIn()) {
      sheet(head('Read their texts') + '<p>Paste the availability messages your team sent - “can’t do Tue, Sat after 4 only”, “any day but no closes” - and AI marks them for you to check before anything changes.</p><p class="muted">It needs a free account (it uses AI credit, and a free account comes with $2 of it). Everything else in Rota - the sample, your team, Fill the gaps, swaps - stays free with no account.</p>' +
        '<div class="row"><button class="btn" type="button" data-act="signup">Create a free account</button><button class="btn ghost" type="button" data-act="signin">Sign in</button></div>');
      return;
    }
    state.texts = state.texts || { text: '', busy: false, proposal: null, picked: {} };
    sheet('<div class="body"></div>', function (root) { drawTexts(root); });
  }
  function drawTexts(root) {
    var t = state.texts;
    var b = $('.body', root);
    var doc = state.doc;
    if (t.proposal) {
      var p = t.proposal;
      b.innerHTML = head('Check before applying') + '<p class="small muted">Week of ' + esc(C.weekLabel(state.week)) + '. Untick anyone you don’t want changed. Days not mentioned keep what they had.</p><ul class="proposal">' + p.people.map(function (x, i) {
        var person = doc.people.filter(function (q) { return C.fold(q.name) === C.fold(x.name); })[0];
        return '<li class="card"><label class="check"><input type="checkbox" data-pick="' + i + '"' + (t.picked[i] !== false ? ' checked' : '') + (person ? '' : ' disabled') + '> <b>' + esc(x.name) + '</b></label>' + availCells({ days: x.days }) +
          (x.noCloses ? '<span class="small">No closes</span>' : '') + (x.maxHours ? '<span class="small">Max ' + esc(x.maxHours) + ' h</span>' : '') + (x.note ? '<span class="small muted note-q">' + esc(x.note) + '</span>' : '') + '</li>';
      }).join('') + '</ul>' +
        (p.unclear && p.unclear.length ? '<div class="note"><b>Couldn’t place</b><ul class="small">' + p.unclear.map(function (u) { return '<li>' + esc(u) + '</li>'; }).join('') + '</ul></div>' : '') +
        '<div id="txErr"></div><div class="row"><button class="btn" type="button" data-act="applytexts">Apply</button><button class="btn ghost" type="button" data-act="textsback">Edit the messages</button></div>';
      $$('[data-pick]', b).forEach(function (cb) { cb.addEventListener('change', function () { t.picked[cb.getAttribute('data-pick')] = cb.checked; }); });
      return;
    }
    b.innerHTML = head('Read their texts') + '<p class="small muted">Paste what people sent you about ' + esc(C.weekLabel(state.week)) + ', one message a line, starting with their name. Only the messages and your team’s first names are sent; nothing changes until you tap Apply.</p>' +
      '<form id="txForm"><label class="field"><span class="vh">Messages</span><textarea class="input" name="text" rows="7" maxlength="' + C.LIMITS.text + '" placeholder="' + esc(TEXTS_EXAMPLE) + '" autofocus>' + esc(t.text) + '</textarea></label>' +
      '<div id="txErr"></div><button class="btn block" type="submit"' + (t.busy ? ' disabled' : '') + '>' + (t.busy ? 'Reading…' : 'Read them') + '</button>' +
      '<p class="small muted center">' + (t.busy ? 'Matching each message to a name and a day.' : 'A cent or two of AI credit.') + '</p></form>';
    $('textarea', b).addEventListener('input', function (e) { t.text = e.target.value; });
    $('#txForm', b).addEventListener('submit', function (e) {
      e.preventDefault();
      t.busy = true; drawTexts(root);
      api('POST', 'api/read-texts', { text: t.text, names: doc.people.map(function (q) { return q.name; }), week: state.week }).then(function (d) {
        t.busy = false; t.proposal = d.proposal; t.picked = {};
        if (state.texts === t) drawTexts(root);
      }).catch(function (err) {
        t.busy = false;
        if (state.texts !== t) return;
        drawTexts(root);
        var where = $('#txErr', root);
        if (err.status === 401) return openAccount();
        if (err.status === 402) return openCredit(err.data);
        if (err.data && err.data.code === 'verify-email') return verifyNote(where, err);
        showError(err, where);
      });
    });
  }
  function applyTexts() {
    var t = state.texts;
    if (!t || !t.proposal) return;
    var marks = {};
    t.proposal.people.forEach(function (x, i) {
      if (t.picked[i] === false) return;
      var person = state.doc.people.filter(function (q) { return C.fold(q.name) === C.fold(x.name); })[0];
      if (person) marks[person.id] = { days: x.days, noCloses: x.noCloses, maxHours: x.maxHours || undefined, note: x.note };
    });
    manage('availMany', { week: state.week, marks: marks }).then(function (r) { closeSheet(true); state.tab = 'team'; draw(); toast('Applied for ' + plural(r.applied || 0, 'person', 'people') + '.'); })
      .catch(function (err) { showError(err, $('#txErr')); });
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Marking availability by hand works meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).addEventListener('click', function () {
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { toast('Sent - check your email.'); }, function () { toast('Could not send it. Try again in a minute.'); });
    });
  }

  /* ---------- set up a team ---------- */

  function openSetup() {
    var f = { template: 'cafe' };
    sheet(head('Set up your team') + '<form id="suForm"><label class="field"><span>Business or site name</span><input class="input" name="name" maxlength="' + C.LIMITS.team + '" required autofocus placeholder="e.g. Corner Cafe, Main St"></label>' +
      '<div class="field"><span class="lbl">Start from</span><div class="pills" role="group" aria-label="Template">' + Object.keys(C.TEMPLATES).map(function (k) { return '<button type="button" class="pill" data-k="template" data-v="' + k + '" aria-pressed="' + (f.template === k) + '">' + esc(C.TEMPLATES[k].label) + '</button>'; }).join('') + '<button type="button" class="pill" data-k="template" data-v="" aria-pressed="false">Blank</button></div><span class="hint">Shifts for next week you can change - nothing is fixed.</span></div>' +
      '<label class="field"><span>Time zone</span><select class="input" name="zone">' + zoneOptions(LOCAL_ZONE) + '</select></label>' +
      '<div id="suErr"></div><button class="btn block" type="submit">Create the team</button><p class="small muted">No account needed. This phone keeps the manager key; the team link you share lets staff in, never the manager controls. Teams are kept for 90 days after their last change.</p></form>', function (root) {
      root.addEventListener('click', function (e) {
        var t = e.target.closest('[data-k]');
        if (!t) return;
        f.template = t.getAttribute('data-v');
        $$('[data-k="template"]', root).forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); });
      });
      $('#suForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var btn = $('button[type=submit]', e.target);
        btn.disabled = true;
        var body = { name: e.target.name.value, zone: e.target.zone.value };
        if (f.template) body.template = f.template;
        api('POST', 'api/teams', body).then(function (d) {
          rememberTeam(d.code, d.key, d.team.team.name);
          location.href = BASE + 't/' + d.code;
        }).catch(function (err) { btn.disabled = false; showError(err, $('#suErr', root)); });
      });
    });
  }

  /* ---------- staff ---------- */

  function drawStaff() {
    var v = state.staff;
    if (!v) { main.innerHTML = state.err ? '<div class="card"><h1>That link didn’t work</h1><p>' + esc(state.err) + '</p><a class="btn" href="./">Go to Rota</a></div>' : '<p class="muted">Loading your team…</p>'; return; }
    var html = state.local ? '<div class="previewbar" role="status">📱 Previewing ' + esc(v.me ? v.me.name : 'a staff') + '’s phone · <button type="button" class="link-btn" data-act="endpreview">Back to manager</button></div>' : '';
    if (!v.me) {
      var free = v.people.filter(function (p) { return p.free; });
      html += '<div class="card"><p class="eyebrow">' + esc(v.team.name) + '</p><h1>Who are you?</h1><p class="muted">Tap your name. This phone remembers it - no account, no password.</p>' +
        (free.length ? '<ul class="names">' + free.map(function (p) { return '<li><button class="btn ghost block" type="button" data-act="claim-name" data-id="' + esc(p.id) + '">' + dot(p.id) + esc(p.name) + '</button></li>'; }).join('') + '</ul>' : '') +
        '<form id="addMe" class="addme"><label class="field"><span>Not on the list? Your first name</span><input class="input" name="name" maxlength="40" autocomplete="given-name"></label><div id="joinErr"></div><button class="btn block" type="submit">Add me</button></form>' +
        '<p class="small muted">Your manager sees your availability. Your teammates see first names on the published rota - never your availability or hours.</p></div>';
      main.innerHTML = html;
      $('#addMe').addEventListener('submit', function (e) { e.preventDefault(); join({ name: e.target.name.value }); });
      return;
    }
    var me = v.me;
    var names = {};
    v.people.forEach(function (p) { names[p.id] = p.name; });
    var cur = C.mondayOf(today());
    var weeks = Object.keys(v.weeks).filter(function (k) { return k >= cur && v.weeks[k].published; }).sort();
    html += '<div class="shead"><p class="eyebrow">' + esc(v.team.name) + '</p><h1>Hi ' + esc(me.name) + '</h1></div>';
    // Your shifts
    var mine = [];
    var nowT = nowMs();
    weeks.forEach(function (k) { v.weeks[k].shifts.forEach(function (s) { if (s.people.indexOf(me.id) >= 0 && C.shiftTimes(v.team, k, s).endMs > nowT) mine.push({ week: k, s: s }); }); });
    html += '<section class="card" aria-labelledby="myH"><div class="row between"><h2 id="myH">Your shifts</h2>' + (mine.length ? '<button class="btn small ghost" type="button" data-act="ics">📅 Add to calendar</button>' : '') + '</div>';
    if (!mine.length) html += '<p class="muted">' + (weeks.length ? 'No shifts for you on the published rota.' : 'Nothing published yet - your manager will publish the week here.') + '</p>';
    else html += '<ul class="myshifts">' + mine.map(function (m, n) {
      var s = m.s;
      var wkv = v.weeks[m.week];
      var swap = wkv.swaps.filter(function (x) { return x.shiftId === s.id && x.mine && (x.status === 'open' || x.status === 'pending'); })[0];
      var mates = s.people.filter(function (p) { return p !== me.id; }).map(function (p) { return names[p]; }).filter(Boolean);
      var wkHead = (n === 0 || mine[n - 1].week !== m.week) ? '<li class="wkh"><span class="eyebrow">' + (m.week === cur ? 'This week' : m.week === C.addDays(cur, 7) ? 'Next week' : esc(C.weekLabel(m.week))) + '</span></li>' : '';
      return wkHead + '<li><div><b>' + esc(C.dayLabel(C.addDays(m.week, s.day))) + '</b> · ' + esc(C.fmtTime(s.start)) + '–' + esc(C.fmtTime(s.end)) + '<span class="small muted"> · ' + esc(s.role) + (mates.length ? ' · with ' + esc(mates.join(', ')) : '') + '</span></div>' +
        (swap ? '<div class="row"><span class="chip">' + (swap.status === 'pending' ? '⏳ ' + esc(names[swap.to] || 'Someone') + ' claimed it - waiting for your manager' : '🔁 Up for swap') + '</span>' + (swap.status === 'open' ? '<button class="btn small ghost" type="button" data-act="cancelswap" data-id="' + esc(swap.id) + '" data-week="' + esc(m.week) + '">Take it back</button>' : '') + '</div>' :
          '<div><button class="btn small ghost" type="button" data-act="offer" data-id="' + esc(s.id) + '" data-week="' + esc(m.week) + '">Offer for swap</button></div>') + '</li>';
    }).join('') + '</ul>';
    html += '</section>';
    // Up for grabs
    var grabs = [];
    weeks.forEach(function (k) { v.weeks[k].swaps.forEach(function (x) { if (x.canClaim || (x.claimedByMe && x.status === 'pending')) grabs.push({ week: k, x: x }); }); });
    html += '<section class="card" aria-labelledby="grabH"><h2 id="grabH">Up for grabs</h2>' + (grabs.length ? '<ul class="myshifts">' + grabs.map(function (g) {
      var s = v.weeks[g.week].shifts.filter(function (y) { return y.id === g.x.shiftId; })[0];
      return '<li><div><b>' + esc(C.dayLabel(C.addDays(g.week, s.day))) + '</b> · ' + esc(C.fmtTime(s.start)) + '–' + esc(C.fmtTime(s.end)) + '<span class="small muted"> · ' + esc(s.role) + ' · from ' + esc(names[g.x.from] || 'a teammate') + '</span>' + (g.x.note ? '<span class="small muted note-q"> “' + esc(g.x.note) + '”</span>' : '') + '</div>' +
        (g.x.claimedByMe ? '<div class="row"><span class="chip">⏳ Yours if your manager approves</span><button class="btn small ghost" type="button" data-act="unclaim" data-id="' + esc(g.x.id) + '" data-week="' + esc(g.week) + '">Let it go</button></div>' : '<button class="btn small" type="button" data-act="claimswap" data-id="' + esc(g.x.id) + '" data-week="' + esc(g.week) + '">I’ll take it</button>') + '</li>';
    }).join('') + '</ul>' : '<p class="muted">Nothing you can take right now. Only shifts that fit your availability, roles, rest and hours show up here.</p>') + '</section>';
    // Availability
    var choices = [0, 1, 2, 3].map(function (n) { return C.addDays(cur, 7 * n); });
    if (!state.staffWeek || choices.indexOf(state.staffWeek) < 0) state.staffWeek = choices[1];
    var sw = v.weeks[state.staffWeek] || {};
    if (!state.draft || state.draft.week !== state.staffWeek) {
      var av = sw.avail;
      state.draft = { week: state.staffWeek, days: ((av && av.days) || [null, null, null, null, null, null, null]).map(function (d) { return d ? { s: d.s, from: d.from, to: d.to } : null; }), noCloses: Boolean(av && av.noCloses), note: (av && av.note) || '', saved: Boolean(av) };
    }
    html += '<section class="card" aria-labelledby="avH" id="avSec"><h2 id="avH">Your availability</h2><div class="pills" role="group" aria-label="Week">' + choices.map(function (k) {
      return '<button type="button" class="pill" data-act="sweek" data-id="' + k + '" aria-pressed="' + (k === state.staffWeek) + '">' + esc(C.weekLabel(k)) + '</button>';
    }).join('') + '</div>' + (state.draft.saved ? '<p class="small ok-t">✓ Your manager has this week’s marks.</p>' : '<p class="small muted">Not sent yet for this week.</p>') +
      availEditor(state.draft) +
      '<label class="check"><input type="checkbox" name="noCloses"' + (state.draft.noCloses ? ' checked' : '') + '> No closing shifts this week</label>' +
      '<label class="field"><span>Anything else? (optional)</span><input class="input" name="note" maxlength="' + C.LIMITS.note + '" value="' + esc(state.draft.note) + '" placeholder="e.g. dentist Thu morning"></label>' +
      '<div class="row"><button class="btn" type="button" data-act="saveavail">Send to my manager</button>' + (prevAvail(v) ? '<button class="btn ghost" type="button" data-act="sameaslast">Same as last week</button>' : '') + '</div></section>';
    // Roles and hours
    html += '<section class="card" aria-labelledby="rhH"><h2 id="rhH">Roles and hours</h2><div class="field"><span class="lbl">Roles you can work</span><div class="pills" role="group" aria-label="Roles">' + v.team.roles.map(function (r) {
      return '<button type="button" class="pill" data-act="myrole" data-id="' + esc(r) + '" aria-pressed="' + (me.roles.indexOf(r) >= 0) + '">' + esc(r) + '</button>';
    }).join('') + '</div></div><div class="two"><label class="field"><span>Hours I’d like</span><input class="input" type="number" id="myTarget" min="1" max="' + C.LIMITS.hours + '" value="' + (me.targetHours || '') + '"></label><label class="field"><span>Never more than</span><input class="input" type="number" id="myMax" min="1" max="' + C.LIMITS.hours + '" value="' + (me.maxHours || '') + '"></label></div>' +
      '<button class="btn ghost" type="button" data-act="saveprofile">Save</button></section>';
    if (!state.local) html += '<p class="center"><button class="link-btn" type="button" data-act="notme">Not ' + esc(me.name) + '? Let go of this name on this phone</button></p>';
    main.innerHTML = html;
    var sec = $('#avSec');
    bindAvail(sec, state.draft, function () {
      var ed = $('.avedit', sec);
      var tmp = document.createElement('div'); tmp.innerHTML = availEditor(state.draft);
      ed.parentNode.replaceChild(tmp.firstChild, ed);
    });
  }
  function prevAvail(v) {
    var k = C.addDays(state.staffWeek, -7);
    return v.weeks[k] && v.weeks[k].avail ? v.weeks[k].avail : null;
  }
  function join(body) {
    if (state.local) {
      state.preview = body.pid; state.staff = C.staffView(state.doc, state.preview, nowMs()); drawStaff(); return;
    }
    api('POST', 'api/teams/' + state.code + '/join', body).then(function (d) { state.staff = d.team; state.draft = null; drawStaff(); scrollTo(0, 0); })
      .catch(function (err) { showError(err, $('#joinErr')); });
  }

  /* ---------- the account ---------- */

  var FREE_LINE = 'Rota works without an account - the sample, your team, Fill the gaps, swaps. A free account adds “Read their texts” with $2 of AI credit. One account works across every app on this site.';
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
      '<div class="note"><div class="row between"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">“Read their texts” costs a cent or two. Everything else in Rota is free.</p><div id="billing"></div></div>' +
      '<p class="small muted">Your teams are kept by their link and this phone’s manager key, not by your account.</p>' +
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
    sheet(head('Out of AI credit') + '<p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Everything else in Rota keeps working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });

  /* ---------------- loading ---------------- */

  function startSample(fresh) {
    var s = fresh ? null : recall(K_SAMPLE);
    if (s && s.doc && s.doc.team && s.doc.weeks && C.isMonday(s.week)) { state.doc = s.doc; state.week = s.week; }
    else { var made = C.sample(C.todayIn(LOCAL_ZONE, nowMs()), LOCAL_ZONE); state.doc = made.doc; state.week = made.week; }
    state.local = true; state.code = null; state.key = null; state.tab = 'week'; state.day = 0; state.lastFill = null; state.preview = null;
    saveSample();
    go('manager');
  }
  function loadTeam(quiet) {
    var since = quiet && state.doc ? '?since=' + state.doc.v : (quiet && state.staff ? '?since=' + state.staff.v : '');
    return api('GET', 'api/teams/' + TEAM_CODE + since, null, state.key ? { 'X-Rota-Key': state.key } : null).then(function (d) {
      if (d.same) return;
      if (d.role === 'manager') {
        state.doc = d.team; state.view = 'manager';
        if (!state.week || !state.doc.weeks) state.week = C.nextWeekOf(today());
        rememberTeam(TEAM_CODE, state.key, d.team.team.name);
      } else { state.staff = d.team; state.view = 'staff'; }
      if (!quiet || $('#sheet').hidden) draw();
    }).catch(function (err) {
      if (quiet) return;
      if (err.status === 404 && state.key) forgetTeam(TEAM_CODE);
      state.err = err.message; state.view = 'staff'; state.staff = null; draw();
    });
  }
  function startPolling() {
    clearInterval(poll);
    poll = setInterval(function () { if (document.visibilityState === 'visible' && $('#sheet').hidden) loadTeam(true); }, 30000);
  }

  /* ---------------- one click listener ---------------- */

  function doFill() {
    var before = null;
    var past = Object.keys(state.doc.weeks).filter(function (k) { return k < state.week && Object.keys(state.doc.weeks[k].assign).some(function (s) { return state.doc.weeks[k].assign[s].length; }); }).sort();
    if (past.length) before = C.fairness(state.doc, past[past.length - 1]).score;
    manage('fill', { week: state.week }).then(function (r) {
      state.lastFill = { week: state.week, placed: r.placed || [], gaps: r.gaps || [], moved: r.moved || [], before: before };
      (r.placed || []).forEach(function (p) { state.fresh[p.shiftId + ':' + p.pid] = 1; });
      var g = (r.gaps || []).reduce(function (s, x) { return s + x.seats; }, 0);
      if (r.gaps && r.gaps.length) { var s = shiftById(r.gaps[0].shiftId); if (s) state.day = s.day; }
      draw();
      say('Filled ' + (r.placed || []).length + ' seats' + (g ? ', ' + g + ' still open' : '') + '.');
      var res = $('.result');
      if (res && !REDUCED) res.scrollIntoView({ block: 'nearest' });
    }).catch(function (err) { showError(err); });
  }
  function goHome() {
    if (TEAM_CODE) { location.href = BASE; return; }
    state.local = false; state.doc = null; state.preview = null; state.staff = null; go('home');
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var a = t.getAttribute('data-act');
    if (['cycle', 'addhours'].indexOf(a) >= 0) return; // the availability editor handles its own taps
    var id = t.getAttribute('data-id');
    var wk = t.getAttribute('data-week');
    if (a !== 'delteam' && a !== 'delperson' && a !== 'resetsample' && a !== 'delshift' && a !== 'clearweek') state.armed = null;
    var arm = function (key, label) { if (state.armed !== key) { state.armed = key; t.textContent = label; return false; } return true; };
    switch (a) {
      case 'home': if (t.tagName === 'A') e.preventDefault(); goHome(); break;
      case 'closesheet': closeSheet(); break;
      case 'sample': startSample(true); break;
      case 'resume': startSample(false); break;
      case 'setup': openSetup(); break;
      case 'tab': state.tab = id; draw(); break;
      case 'day': state.day = Number(id); $$('.dayb').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); }); $$('.grid .day').forEach(function (d, i) { d.classList.toggle('sel', i === state.day); }); break;
      case 'wprev': state.week = C.addDays(state.week, -7); state.lastFill = null; draw(); break;
      case 'wnext': state.week = C.addDays(state.week, 7); state.lastFill = null; draw(); break;
      case 'fill': closeSheet(true); doFill(); break;
      case 'publish': manage('publish', { week: state.week }).then(function () { draw(); toast(state.local ? 'Published. Open a staff phone from the Team tab to see it.' : 'Published - everyone sees their shifts at the team link.'); }).catch(function (err) { showError(err); }); break;
      case 'unpublish': manage('unpublish', { week: state.week }).then(function () { draw(); toast('Back to draft.'); }).catch(function (err) { showError(err); }); break;
      case 'weekmore': openWeekMore(); break;
      case 'clearfill': manage('clearFill', { week: state.week }).then(function () { closeSheet(true); state.lastFill = null; draw(); }).catch(function (err) { showError(err); }); break;
      case 'clearweek': if (!arm('clearweek', 'Tap again to clear every shift')) break; manage('clearWeek', { week: state.week }).then(function () { closeSheet(true); state.lastFill = null; draw(); }).catch(function (err) { showError(err); }); break;
      case 'copyweek': manage('copyWeek', { week: state.week, from: prevWeekWithShifts() }).then(function (r) { closeSheet(true); draw(); toast('Copied ' + plural(r.added || 0, 'shift') + '.'); }).catch(function (err) { showError(err); }); break;
      case 'template': manage('template', { week: state.week, kind: id }).then(function () { draw(); }).catch(function (err) { showError(err); }); break;
      case 'addshift': closeSheet(true); openShift(id); break;
      case 'editshift': openShift(null, id); break;
      case 'delshift': if (!arm('delshift', 'Tap again to remove it')) break; manage('removeShift', { week: state.week, shiftId: id }).then(function () { closeSheet(true); draw(); }).catch(function (err) { showError(err); }); break;
      case 'open': openPick(id, null); break;
      case 'seat': openPick(id, t.getAttribute('data-pid')); break;
      case 'put': putOn(id, t.getAttribute('data-pid'), t.getAttribute('data-swap')); break;
      case 'unseat': manage('seat', { week: state.week, shiftId: id, pid: t.getAttribute('data-pid'), on: false }).then(function () { closeSheet(true); draw(); }).catch(function (err) { showError(err); }); break;
      case 'person': openPerson(id); break;
      case 'addperson': openPerson(null); break;
      case 'delperson': if (!arm('delperson', 'Tap again to remove them')) break; manage('removePerson', { pid: id }).then(function () { closeSheet(true); draw(); }).catch(function (err) { showError(err); }); break;
      case 'unlink': manage('unlink', { pid: id }).then(function () { closeSheet(true); draw(); toast('Their name is free for a new phone.'); }).catch(function (err) { showError(err); }); break;
      case 'texts': openTexts(); break;
      case 'applytexts': applyTexts(); break;
      case 'textsback': if (state.texts) { state.texts.proposal = null; drawTexts($('#sheet .sheet-in')); } break;
      case 'signup': openAccount(null, function () { draw(); openTexts(); }); break;
      case 'signin': openAccount(null, function () { draw(); openTexts(); }, true); break;
      case 'approve': case 'decline': manage('swap', { week: state.week, id: id, decision: a }).then(function () { draw(); toast(a === 'approve' ? 'Approved - the rota is updated.' : 'Declined - it’s up for grabs again.'); }).catch(function (err) { showError(err); draw(); }); break;
      case 'autoapprove': manage('settings', { autoApprove: !state.doc.team.autoApprove }).then(function () { draw(); }).catch(function (err) { showError(err); }); break;
      case 'sharelink': share('Our rota', ['Mark your availability and see your shifts for ', state.doc.team.name, ':'].join(''), teamLink(state.code)); break; // plain text for the share sheet, not markup
      case 'copylink': copy(teamLink(state.code), 'Link copied'); break;
      case 'resetsample': if (!arm('resetsample', 'Tap again to start over')) break; startSample(true); break;
      case 'delteam': if (!arm('delteam', 'Tap again to delete it for everyone')) break; api('DELETE', 'api/teams/' + state.code, null, { 'X-Rota-Key': state.key }).then(function () { forgetTeam(state.code); location.href = BASE; }).catch(function (err) { showError(err); }); break;
      case 'preview': state.preview = id; state.staff = C.staffView(state.doc, id, nowMs()); state.draft = null; state.staffWeek = null; go('staff'); break;
      case 'endpreview': state.preview = null; state.staff = null; state.draft = null; state.tab = 'team'; go('manager'); break;
      // staff phone
      case 'claim-name': join({ pid: id }); break;
      case 'notme': api('POST', 'api/teams/' + state.code + '/leave', {}).then(function (d) { state.staff = d.team; state.draft = null; drawStaff(); }).catch(function (err) { showError(err); }); break;
      case 'sweek': state.staffWeek = id; state.draft = null; drawStaff(); break;
      case 'saveavail': {
        var d = state.draft;
        staffAct('avail', { week: d.week, days: d.days, noCloses: d.noCloses, note: d.note }).then(function () { state.draft = null; drawStaff(); toast('Sent. Your manager sees it now.'); }).catch(function (err) { showError(err); });
        break;
      }
      case 'sameaslast': { var pa = prevAvail(state.staff); if (pa) { state.draft.days = pa.days.map(function (x) { return x ? { s: x.s, from: x.from, to: x.to } : null; }); state.draft.noCloses = Boolean(pa.noCloses); drawStaff(); toast('Copied - check it, then send.'); } break; }
      case 'myrole': t.setAttribute('aria-pressed', String(t.getAttribute('aria-pressed') !== 'true')); break;
      case 'saveprofile': {
        var roles = $$('[data-act="myrole"]').filter(function (b) { return b.getAttribute('aria-pressed') === 'true'; }).map(function (b) { return b.getAttribute('data-id'); });
        var tg = $('#myTarget').value, mx = $('#myMax').value;
        staffAct('profile', { roles: roles, targetHours: tg ? Number(tg) : null, maxHours: mx ? Number(mx) : null }).then(function () { drawStaff(); toast('Saved.'); }).catch(function (err) { showError(err); });
        break;
      }
      case 'offer': staffAct('offer', { week: wk, shiftId: id }).then(function () { drawStaff(); toast('Offered. Teammates who can take it will see it.'); }).catch(function (err) { showError(err); }); break;
      case 'cancelswap': staffAct('cancel', { week: wk, id: id }).then(function () { drawStaff(); }).catch(function (err) { showError(err); }); break;
      case 'claimswap': staffAct('claim', { week: wk, id: id }).then(function (r) { drawStaff(); toast(r.approved ? 'It’s yours - the rota is updated.' : 'Claimed - waiting for your manager to approve.'); }).catch(function (err) { showError(err); }); break;
      case 'unclaim': staffAct('unclaim', { week: wk, id: id }).then(function () { drawStaff(); }).catch(function (err) { showError(err); }); break;
      case 'ics': {
        if (state.local) download('my-shifts.ics', C.buildIcs(state.doc, state.preview, nowMs()), 'text/calendar;charset=utf-8');
        else location.href = BASE + 'api/teams/' + state.code + '/calendar.ics';
        break;
      }
      default: break;
    }
  });

  /* ---------------- start ---------------- */

  if (TEAM_CODE) {
    state.code = TEAM_CODE;
    state.key = keyFor(TEAM_CODE);
    main.innerHTML = '<p class="muted">Loading the team…</p>';
    loadTeam(false).then(startPolling);
    loadMe();
  } else {
    draw();
    loadMe().then(function () { if (state.view === 'home') drawHome(); });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && TEAM_CODE && $('#sheet').hidden) loadTeam(true);
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* no offline copy, still works online */ });
  }
}());
