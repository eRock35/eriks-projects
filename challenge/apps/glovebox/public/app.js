/* Glovebox - the page. One file, no build step.
 *
 * EVERYTHING LIVES ON THIS PHONE. The garage is kept in localStorage
 * (glovebox-garage-v1) and every rule - the plan, the driving pace, the
 * board, the costs, the history report and its link, the calendar file - is
 * GloveboxCore, run here. Receipt photos are shrunk and kept in this
 * browser's IndexedDB. The warning-light finder is a catalogue in the page
 * (GloveboxLights) and makes no request. The only requests this page makes
 * are the account's and the one AI call ("Read my dashboard" / "Read a
 * receipt"), which sends one shrunk photo, signed in, and only when the
 * person taps Read it.
 *
 * Every string that was typed (a nickname, a shop, a note), imported, or came
 * back from the server is escaped before it is drawn, and no handler is
 * written into markup: clicks are routed by data-act attributes from one
 * listener (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.GloveboxCore;
  var L = window.GloveboxLights;
  var D = window.GloveboxDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_HOME = 'glovebox-garage-v1';
  var esc = C.esc, plural = C.plural;
  var TZ = (function () { try { return C.cleanTz(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) { return 'UTC'; } })();
  var LOCALE = (navigator.languages && navigator.languages[0]) || navigator.language || 'en-US';
  var TABS = [['next', '🔧', 'Next'], ['log', '🧾', 'Log'], ['lights', '⚠️', 'Lights'], ['report', '📄', 'History'], ['more', '⚙️', 'More']];
  var PHOTO_PX = 1600, RECEIPT_PX = 1400;
  var GROUP_ICON = { red: '🛑', amber: '⚠️', info: 'ℹ️' };
  var LIT = { red: 'lit-red', amber: 'lit-amber', green: 'lit-green', blue: 'lit-blue' };
  var BAND_SUB = { overdue: 'Past the miles or the date - book these in', soon: 'Within about a month', coming: 'In the next few months' };

  var state = {
    me: null,
    view: 'start',          // start | app
    tab: 'next',            // next | log | lights | report | more | add | plan | light
    source: null,           // demo | mine
    mine: null,             // {cars}
    demo: null,
    settings: null,
    carId: null,
    lights: { group: null, q: '', id: null },
    report: { costs: false, notes: false, link: null, linkFor: null, dropped: 0 },
    add: null,
    day: null,
    storageWarned: false,
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
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  var toastTimer = null;
  function toast(msg, ms, buttons) {
    $$('.toast').forEach(function (t) { t.remove(); });
    clearTimeout(toastTimer);
    var t = document.createElement('div');
    t.className = 'toast' + (buttons && buttons.length ? '' : ' plain'); t.setAttribute('role', 'status');
    var m = document.createElement('span'); m.className = 'tmsg'; m.textContent = msg; t.appendChild(m);
    (buttons || []).forEach(function (b) {
      var x = document.createElement('button');
      x.type = 'button'; x.className = 'btn small light'; x.textContent = b.label;
      x.addEventListener('click', function () { t.remove(); b.run(); });
      t.appendChild(x);
    });
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, ms || (buttons && buttons.length ? 8000 : 2800));
  }
  function copyText(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the link and copy it by hand.'); });
  }
  function download(name, type, text) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  /** "48,200" or "48 200" -> 48200; anything else -> null. */
  function parseNum(v) {
    var s = String(v == null ? '' : v).trim().replace(/[\s,]/g, '');
    if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /* ---------------- the garage ---------------- */

  function today() { return C.localDate(Date.now(), TZ); }
  function isDemo() { return state.source === 'demo'; }
  function home() { return isDemo() ? state.demo : state.mine; }
  function cars() { var h = home(); return h ? h.cars : []; }
  function car() { var cs = cars(); return cs.filter(function (c) { return c.id === state.carId; })[0] || cs[0] || null; }
  function units() { return state.settings.units; }
  function cur() { return state.settings.currency; }
  function region() { return state.settings.region; }
  function ctx() { return { today: today(), units: units(), region: region(), currency: cur() }; }
  function sp(t) { return C.spell(t, region()); }
  function money(n, c) { return C.money(n, c || cur(), LOCALE); }
  /** A total for a stat tile: no pennies once it's over 100. */
  function bigMoney(n) { var s0 = money(Math.abs(n) >= 100 ? Math.round(n) : n); return Math.abs(n) >= 100 ? s0.replace(/[.,]\d{2}(?=\D*$)/, '') : s0; }
  function dist(km, o) { return C.dist(km, units(), o); }
  function uWord() { return units() === 'mi' ? 'miles' : 'km'; }

  function loadMine() {
    var raw = recall(K_HOME);
    state.settings = C.cleanSettings(raw && raw.settings, LOCALE);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cars)) return null;
    var c = { today: today(), currency: state.settings.currency };
    var list = raw.cars.map(function (x) { return C.cleanCar(x, c); }).filter(Boolean).slice(0, C.LIMITS.cars);
    if (C.isCarId(raw.carId)) state.carId = raw.carId;
    return { cars: list };
  }
  function persist() {
    var s = state.settings;
    var ok = keep(K_HOME, { v: 1, settings: { units: s.units, unitsAuto: s.unitsAuto, currency: s.currency, curAuto: s.curAuto }, cars: state.mine ? state.mine.cars : [], carId: isDemo() ? null : state.carId });
    if (!ok && !state.storageWarned) {
      state.storageWarned = true;
      toast('This browser won’t let Glovebox save (private browsing?). Changes last until the tab closes - export a file to keep them.', 6000);
    }
  }
  function ensureMine() {
    if (!state.mine) state.mine = { cars: [] };
    return state.mine;
  }
  function openDemo() {
    state.demo = D.build(today(), cur());
    state.source = 'demo';
    state.carId = state.demo.cars[0].id;
    resetReport();
    go('next');
  }
  function openMine() {
    ensureMine();
    state.source = 'mine';
    var cs = state.mine.cars;
    if (!cs.some(function (c) { return c.id === state.carId; })) state.carId = cs.length ? cs[0].id : null;
    resetReport();
    if (!cs.length) { state.add = null; go('add'); } else go('next');
  }
  function replaceCar(nc) {
    var h = home();
    h.cars = h.cars.map(function (c) { return c.id === nc.id ? nc : c; });
  }
  function resetReport() { state.report.link = null; state.report.linkFor = null; state.report.dropped = 0; }

  /* ---------------- actions, with undo ---------------- */

  function doAct(kind, opts, after) {
    var c = car();
    if (!c) return null;
    var r;
    try { r = C.act(c, kind, ctx(), opts); } catch (e) { return e; }
    replaceCar(r.car);
    if (!isDemo()) persist();
    resetReport();
    draw();
    var token = r.token;
    toast(r.msg, 8000, [{ label: 'Undo', run: function () { undoAct(token, after); } }]);
    return r;
  }
  function undoAct(token, after) {
    var c = cars().filter(function (x) { return x.id === token.id; })[0];
    if (!c) return;
    try { replaceCar(C.undo(c, token)); } catch (e) { toast(e.message); return; }
    if (!isDemo()) persist();
    if (after) after();
    resetReport();
    draw(); toast('Undone.');
  }

  /* ---------------- routing ---------------- */

  function go(tab, id) {
    if (tab === 'start') { state.view = 'start'; history.pushState(null, '', BASE + '#start'); draw(); scrollTo(0, 0); return; }
    state.view = 'app'; state.tab = tab;
    if (tab === 'light') state.lights.id = id;
    history.pushState(null, '', BASE + '#' + (tab === 'light' ? 'light/' + id : tab === 'lights' && state.lights.group ? 'lights/' + state.lights.group : tab));
    draw(); scrollTo(0, 0);
    var m = $('#main'); if (m && tab !== 'add') try { m.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function route() {
    var h = (location.hash || '').replace(/^#/, '');
    if (h === 'example') { history.replaceState(null, '', BASE + '#next'); openDemo(); return; }
    if (!state.source && state.mine && state.mine.cars.length) state.source = 'mine';
    var lm = /^light\/([a-z0-9-]{2,30})$/.exec(h);
    if (lm && L.light(lm[1])) { if (!state.source) { state.source = 'mine'; ensureMine(); } state.view = 'app'; state.tab = 'light'; state.lights.id = lm[1]; return draw(); }
    var gm = /^lights(?:\/(red|amber|info))?$/.exec(h);
    if (gm) { if (!state.source) { state.source = 'mine'; ensureMine(); } state.view = 'app'; state.tab = 'lights'; state.lights.group = gm[1] || null; return draw(); }
    if (h === 'add') { if (!state.source) { state.source = 'mine'; ensureMine(); } state.view = 'app'; state.tab = 'add'; return draw(); }
    if (state.source && (h === 'plan' || TABS.some(function (t) { return t[0] === h; }))) { state.view = 'app'; state.tab = h; return draw(); }
    if (h === 'start' || !state.source) { state.view = 'start'; return draw(); }
    state.view = 'app'; state.tab = 'next'; draw();
  }
  window.addEventListener('popstate', route);

  function draw() {
    closeSheet(true);
    var main = $('#main');
    document.body.classList.toggle('has-tabs', state.view === 'app');
    document.body.classList.toggle('no-tabs', state.view !== 'app');
    if (state.view !== 'app') { main.innerHTML = startHtml() + footer(); return; }
    var c = car();
    var overdue = c ? C.board(c, today()).overdue.length : 0;
    var tabOn = state.tab === 'light' ? 'lights' : state.tab === 'plan' || state.tab === 'add' ? (state.tab === 'add' ? 'next' : 'more') : state.tab;
    var html = '<nav class="tabbar dk-tabbar" aria-label="Sections"><div class="tabbar-inner"><a class="rail-brand" href="./#start" data-act="home"><span aria-hidden="true">🧤</span>Glovebox</a>' + TABS.map(function (t) {
      var on = t[0] === tabOn;
      return '<a class="tab' + (on ? ' on' : '') + '" href="#' + t[0] + '" data-act="tab" data-tab="' + t[0] + '"' + (on ? ' aria-current="page"' : '') + '><span aria-hidden="true">' + t[1] + '</span>' + t[2] +
        (t[0] === 'next' && overdue ? '<em class="badge" aria-label="' + overdue + ' overdue">' + overdue + '</em>' : '') + '</a>';
    }).join('') + '</div></nav>';
    if (isDemo() && state.tab !== 'lights' && state.tab !== 'light') html += '<div class="strip"><p><b>The example garage.</b> Tap away - nothing here is saved.</p><button class="btn small light" type="button" data-act="mine">Start my own</button></div>';
    var body = state.tab === 'next' ? nextHtml() : state.tab === 'log' ? logHtml() : state.tab === 'lights' ? lightsHtml() : state.tab === 'light' ? lightHtml() :
      state.tab === 'report' ? reportHtml() : state.tab === 'add' ? addHtml() : state.tab === 'plan' ? planHtml() : moreHtml();
    main.innerHTML = html + body + footer();
    wire();
  }
  function footer() {
    return '<footer class="foot small muted"><p>Your car’s records live on this phone - no account, nothing uploaded. Intervals and light meanings are guidance, not a diagnosis: your owner’s manual wins.</p><p>Part of the <a href="../">Challenge Lab</a>.</p></footer>';
  }
  function wire() {
    var q = $('#lightq');
    if (q) q.addEventListener('input', function () { state.lights.q = q.value; var r = $('#lightResults'); if (r) r.innerHTML = searchResults(); });
    if (state.tab === 'log') drawThumbs();
  }

  /* ---------------- first run ---------------- */

  function litSvg(id, colour) { var l = L.light(id); return '<span class="lit ' + LIT[colour || l.colour] + '">' + L.svg(l) + '</span>'; }
  function startHtml() {
    var have = state.mine && state.mine.cars.length;
    return '<section class="hero"><div class="cluster" aria-hidden="true">' + litSvg('check-engine') + litSvg('oil-pressure') + litSvg('tpms') +
      '<span class="gauge"><b>OIL</b>in 3 wks</span></div>' +
      '<h1>Know what your car needs next.</h1>' +
      '<p class="lede">Glovebox keeps your car’s service plan and history on your phone, tells you what’s due - by miles or months, whichever comes first - and what that light on the dashboard means.</p></section>' +
      '<div class="choices">' +
      (have ? '<button class="choice primary" type="button" data-act="mine"><span class="ci" aria-hidden="true">🚗</span><span class="ct"><b>My garage</b><span>' + esc(plural(state.mine.cars.length, 'car')) + ' on this phone</span></span><span class="chev" aria-hidden="true">›</span></button>' : '') +
      '<button class="choice' + (have ? '' : ' primary') + '" type="button" data-act="example"><span class="ci" aria-hidden="true">🚙</span><span class="ct"><b>See an example garage</b><span>A family SUV with three years of history - one thing overdue - and an old hatchback</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      (have ? '' : '<button class="choice" type="button" data-act="addcar"><span class="ci" aria-hidden="true">➕</span><span class="ct"><b>Add my car</b><span>On this phone. No account, nothing uploaded.</span></span><span class="chev" aria-hidden="true">›</span></button>') +
      '<button class="choice" type="button" data-act="lights"><span class="ci" aria-hidden="true">⚠️</span><span class="ct"><b>What’s this warning light?</b><span>Pick the colour, then the shape - 42 lights explained, free</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      '</div>' +
      '<section class="card"><h2>How it works</h2><ol class="steps">' +
      '<li><span class="sn">1</span><span><b>Tell it about your car.</b> Make, model, fuel and what the odometer says. Glovebox builds a plan - oil, ' + esc(sp('tyres')) + ', brakes, filters, battery, renewals - and skips what doesn’t apply (no oil changes on an EV).</span></li>' +
      '<li><span class="sn">2</span><span><b>Open it now and then.</b> Overdue, due soon, coming up, all good - worked out from how far you actually drive. Tap <b>Done</b> after a service and it starts the clock again.</span></li>' +
      '<li><span class="sn">3</span><span><b>Selling it?</b> One link gives the buyer a tidy service history - dates, mileage, work done - and nothing is stored on a server.</span></li>' +
      '</ol></section>';
  }

  /* ---------------- the car switcher ---------------- */

  function carsBar() {
    var cs = cars();
    if (!cs.length) return '';
    var c = car();
    return '<div class="cars noprint" role="group" aria-label="Your cars">' + cs.map(function (x) {
      return '<button class="carchip" type="button" data-act="car" data-id="' + esc(x.id) + '" aria-pressed="' + (x.id === c.id) + '"><span aria-hidden="true">' + (x.fuel === 'ev' ? '🔌' : '🚗') + '</span><span class="cn">' + esc(C.carName(x)) + '</span></button>';
    }).join('') + (isDemo() ? '' : '<button class="carchip add" type="button" data-act="addcar">+ Add a car</button>') + '</div>';
  }

  /* ---------------- Next ---------------- */

  function emptyHtml() {
    return '<div class="card empty"><div class="big" aria-hidden="true">🚗</div><p><b>No car yet.</b></p><p class="muted small">Add yours - it takes a minute - and Glovebox works out what’s due.</p><button class="btn" type="button" data-act="addcar">Add my car</button> <button class="btn ghost" type="button" data-act="example">See the example</button></div>';
  }
  function odoHtml(c, b) {
    var pc = b.pace;
    if (!pc.latest) return '<div class="odo"><b>-</b><span>no reading yet</span></div>';
    var est = pc.est;
    var label = pc.age === 0 ? 'read today' : pc.age > 0 ? 'estimated · read ' + C.agoWords(pc.age) : '';
    return '<div class="odo" aria-label="Odometer about ' + esc(dist(est)) + '"><b>' + (pc.age > 0 ? '≈ ' : '') + esc(dist(est)) + '</b><span>' + esc(label) + '</span></div>';
  }
  function nextHtml() {
    var c = car();
    if (!c) return emptyHtml();
    var t = today(), u = units();
    var b = C.board(c, t);
    var pc = b.pace;
    var head = '<section class="card"><div class="carhead"><div class="cm"><h1>' + esc(C.carName(c)) + '</h1><p class="sub">' + esc([c.nick ? C.carTitle(c) : '', C.fuelWord(c.fuel, region())].filter(Boolean).join(' · ')) + '</p></div>' + odoHtml(c, b) + '</div>' +
      '<p class="paceline">' + esc(C.paceText(pc, u)) + (pc.lower ? ' · ' + esc(plural(pc.lower, 'reading')) + ' lower than an earlier one set aside' : '') + '</p>' +
      (pc.stale && pc.latest ? '<div class="warnbox"><span aria-hidden="true">🕒</span><span>The last odometer reading was ' + esc(C.agoWords(pc.age)) + '. Update it so the due dates stay right.</span><button class="btn small" type="button" data-act="reading">Update mileage</button></div>'
        : '<div class="btns"><button class="btn small ghost" type="button" data-act="reading">Update mileage</button><button class="btn small ghost" type="button" data-act="logsvc">+ Log a service</button></div>') +
      '</section>';
    head += '<section class="card"><p class="headline">' + esc(C.headline(c, t, u, region())) + '</p><div class="bchips">' + C.BANDS.map(function (bd) {
      var n = b[bd.id].length;
      return n ? '<a class="bchip b-' + bd.id + '" href="#band-' + bd.id + '" data-act="jump" data-band="' + bd.id + '"><span aria-hidden="true">' + bd.icon + '</span><b>' + n + '</b> ' + esc(bd.label.toLowerCase()) + '</a>' : '';
    }).join('') + '</div></section>';
    if (c.belt === 'unsure' && c.fuel !== 'ev') {
      head += '<section class="card ask"><h2>⚙️ Timing belt or chain?</h2><p class="small muted">If it has a belt, it’s replaced on a schedule (often every 100,000 km / 60,000 miles or 5-7 years) - and one that snaps can wreck the engine. Your manual or any garage can tell you which it has.</p><div class="btns"><button class="btn small" type="button" data-act="belt" data-v="belt">It has a belt</button><button class="btn small ghost" type="button" data-act="belt" data-v="chain">It has a chain</button></div></section>';
    }
    var bands = ['overdue', 'soon', 'coming'].map(function (id) { return bandHtml(c, id, b[id]); }).join('');
    var other = b.overdue.length + b.soon.length + b.coming.length;
    if (b.good.length) bands += '<details class="band b-good" id="band-good"' + (other ? '' : ' open') + '><summary class="bhead"><span class="btag"><span aria-hidden="true">✅</span>All good · ' + b.good.length + '</span><span class="small fold-show">Show ›</span><span class="small fold-hide">Hide</span></summary><ul class="ilist">' +
      b.good.map(function (st) { return '<li>' + compactRow(st) + '</li>'; }).join('') + '</ul></details>';
    if (b.none.length) bands += '<section class="card"><h2>🗓️ Renewals with no date yet</h2><p class="small muted">Give Glovebox the dates and they join the board (and your calendar file).</p><ul class="ilist">' + b.none.map(function (st) {
      return '<li><button class="irow-compact" type="button" data-act="setdate" data-item="' + st.item.id + '"><span class="ie" aria-hidden="true">' + esc(st.item.emoji) + '</span><span class="ib"><span class="iname">' + esc(sp(st.item.name)) + '</span><span class="imeta">Tap to add the date</span></span><span class="chev" aria-hidden="true">›</span></button></li>';
    }).join('') + '</ul></section>';
    bands += '<p class="manual"><span aria-hidden="true">📘</span><span><b>Your manual wins.</b> These are generic intervals - <button class="link-btn" type="button" data-act="tab" data-tab="plan" style="padding:0;min-height:0">change any of them</button> to match your owner’s manual or how you drive.</span></p>';
    return '<div class="boardgrid"><div>' + carsBar() + head + bands + '</div><aside class="side">' + sideCards(c) + '</aside></div>';
  }
  function bandHtml(c, id, list) {
    if (!list.length) return '';
    var bd = C.BANDS.filter(function (x) { return x.id === id; })[0];
    return '<section class="band b-' + id + '" id="band-' + id + '"><div class="bhead"><h2 class="btag"><span aria-hidden="true">' + bd.icon + '</span>' + esc(bd.label) + ' · ' + list.length + '</h2><span class="small">' + esc(BAND_SUB[id]) + '</span></div><ul class="ilist">' +
      list.map(function (st) { return '<li>' + itemCard(c, st) + '</li>'; }).join('') + '</ul></section>';
  }
  function lastLine(st) {
    var t = today();
    if (!st.last) return '';
    if (st.item.kind === 'date') return st.last.from === 'log' ? 'Last done ' + C.dateLabel(st.last.d, t) : '';
    if (st.last.from === 'log') return 'Last done ' + C.dateLabel(st.last.d, t) + (st.last.km !== null ? ' at ' + dist(st.last.km) : '');
    if (st.last.how === 'known') return 'From your last service, ' + C.dateLabel(st.last.d, t);
    if (st.last.how === 'new') return 'Counting from when the car was new to you';
    return '';
  }
  function itemCard(c, st) {
    var it = st.item, t = today();
    var meta = lastLine(st);
    var rule = C.dueRule(st, units(), t);
    return '<div class="icard b-' + st.band + '"><div class="irow"><span class="ie" aria-hidden="true">' + esc(it.emoji) + '</span><div class="ib"><span class="iname">' + esc(sp(it.name)) + '</span><span class="idue">' + esc(C.dueText(st, units(), t)) + '</span>' +
      (meta ? '<span class="imeta">' + esc(meta) + '</span>' : '') +
      (st.unknown ? '<span class="imeta"><span class="norec">No record</span> counted from when you added the car</span>' : '') + '</div></div>' +
      (rule ? '<p class="rule">' + esc(rule) + '</p>' : '') +
      '<div class="iacts"><button class="pa done" type="button" data-act="done" data-item="' + it.id + '"><span aria-hidden="true">✓</span>' + (it.kind === 'date' ? 'Renewed' : 'Done') + '</button>' +
      '<button class="pa icon" type="button" data-act="itemmore" data-item="' + it.id + '" aria-label="More about ' + esc(sp(it.name)) + '">⋯</button></div></div>';
  }
  function compactRow(st) {
    var it = st.item;
    return '<button class="irow-compact" type="button" data-act="itemmore" data-item="' + it.id + '"><span class="ie" aria-hidden="true">' + esc(it.emoji) + '</span><span class="ib"><span class="iname">' + esc(sp(it.name)) + '</span><span class="imeta">' + esc(C.dueText(st, units(), today())) + (st.unknown ? ' · no record' : '') + '</span></span><span class="chev" aria-hidden="true">›</span></button>';
  }
  function sideCards(c) {
    var k = C.costs(c, today(), cur());
    var costCard = !k.count ? '<section class="card"><h2>💸 What it’s cost</h2><p class="small muted">Add a cost when you log a service and Glovebox keeps the totals - this year, all time, and per ' + (units() === 'mi' ? 'mile' : 'km') + '.</p><button class="btn small ghost" type="button" data-act="logsvc">Log a service</button></section>' : '';
    return costCard + (k.count ? '<section class="card"><h2>💸 What it’s cost</h2><div class="stats"><div class="stat"><b>' + esc(bigMoney(k.year)) + '</b><span>this year</span></div><div class="stat"><b>' + esc(bigMoney(k.all)) + '</b><span>all logged</span></div><div class="stat"><b>' + (k.perKm ? esc(money(units() === 'mi' ? k.perKm * C.KM_PER_MI : k.perKm)) : '-') + '</b><span>per ' + (units() === 'mi' ? 'mile' : 'km') + '</span></div></div><div class="btns"><button class="btn small ghost" type="button" data-act="tab" data-tab="log">The service log</button></div></section>' : '') +
      '<section class="card"><h2>⚠️ A light just came on?</h2><p class="small muted">Pick its colour, then its shape. Red means stop safely.</p><button class="btn small" type="button" data-act="tab" data-tab="lights">Look it up</button></section>' +
      '<section class="card"><h2>🤝 Selling it?</h2><p class="small muted">Hand the buyer a tidy service history in one link.</p><button class="btn small ghost" type="button" data-act="tab" data-tab="report">Make the history</button></section>';
  }

  /* ---------------- sheets for an item, a reading, a service ---------------- */

  function itemSheet(id) {
    var c = car(); var it = C.item(id);
    if (!c || !it) return;
    var st = C.statusOf(c, it, today());
    var iv = st.iv;
    var every = it.kind === 'date' ? 'Every ' + plural(iv.months || 12, 'month') : 'Every ' + [iv.km ? dist(iv.km, { step: 100 }) : '', iv.months ? plural(iv.months, 'month') : ''].filter(Boolean).join(' or ') + (iv.km && iv.months ? ', whichever comes first' : '');
    var html = '<h2>' + esc(it.emoji) + ' ' + esc(sp(it.name)) + '</h2>' +
      (st.band !== 'off' && st.band !== 'none' ? '<p><b>' + esc(C.dueText(st, units(), today())) + '</b></p>' : '') +
      '<p class="small">' + esc(sp(it.why)) + '</p>' +
      '<div class="note"><div class="row spread"><span><b>' + esc(every) + '</b>' + (iv.custom ? ' <span class="small muted">(your setting)</span>' : '') + '</span><button class="btn small ghost" type="button" data-act="planitem" data-item="' + id + '">Change</button></div><p class="small muted" style="margin:6px 0 0">A generic interval - your owner’s manual wins.</p></div>' +
      '<ul class="menu">' +
      (it.kind === 'date' ? '<li><button type="button" data-act="setdate" data-item="' + id + '"><span class="mi" aria-hidden="true">🗓️</span><span>Set the date it’s due<small>From the renewal letter or your insurer</small></span></button></li>' : '') +
      '<li><button type="button" data-act="done" data-item="' + id + '"><span class="mi" aria-hidden="true">✓</span><span>' + (it.kind === 'date' ? 'Renewed - log it' : 'Done - log it') + '<small>With the date, mileage and cost</small></span></button></li>' +
      '<li><button type="button" data-act="donepast" data-item="' + id + '"><span class="mi" aria-hidden="true">🕰️</span><span>It was done earlier<small>Tell Glovebox when it was last done</small></span></button></li>' +
      '<li><button type="button" data-act="trackoff" data-item="' + id + '"><span class="mi" aria-hidden="true">🚫</span><span>Stop tracking this<small>You can turn it back on in the plan</small></span></button></li>' +
      '</ul>';
    sheet(html);
  }
  function readingSheet(prefill) {
    var c = car(); if (!c) return;
    var pc = C.paceOf(c, today());
    sheet('<h2>🧭 Update mileage</h2><p class="small muted">What does the odometer say? ' + (pc.latest ? 'Last reading: ' + esc(dist(pc.latest.km)) + ' on ' + esc(C.dateLabel(pc.latest.d, today())) + '.' : '') + ' A reading every few weeks keeps the mileage-based dates right.</p>' +
      '<form id="rdForm"><label class="field"><span>Odometer</span><span class="unitwrap"><input class="input" name="km" inputmode="decimal" autocomplete="off" required placeholder="' + (pc.latest ? esc(C.num(C.fromKm(pc.est, units()))) : '') + '" value="' + (prefill ? esc(prefill) : '') + '"><span class="u">' + esc(units()) + '</span></span></label>' +
      '<label class="field"><span>Date</span><input class="input" type="date" name="d" value="' + today() + '" max="' + today() + '"></label><div id="rdErr" aria-live="polite"></div><button class="btn block" type="submit">Save the reading</button></form>', function (root) {
      var force = false;
      $('#rdForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var v = parseNum(e.target.km.value);
        if (v === null) { $('#rdErr', root).innerHTML = '<p class="err" role="alert">Type the number on the odometer - digits only.</p>'; return; }
        var r = doAct('reading', { km: C.toKm(v, units()), d: e.target.d.value, force: force });
        if (r instanceof Error) {
          if (r.code === 'lower' || r.code === 'jump') {
            force = true;
            $('#rdErr', root).innerHTML = '<p class="warnbox"><span aria-hidden="true">⚠️</span><span>' + esc(r.message) + '</span></p>';
            $('button[type=submit]', root).textContent = 'Save it anyway';
          } else $('#rdErr', root).innerHTML = '<p class="err" role="alert">' + esc(r.message) + '</p>';
        }
      });
    });
  }
  function setDateSheet(id) {
    var c = car(); var it = C.item(id);
    if (!c || !it) return;
    var cur0 = c.dates[id] || '';
    sheet('<h2>' + esc(it.emoji) + ' ' + esc(sp(it.name)) + '</h2><p class="small muted">' + esc(sp(it.why)) + '</p><form id="sdForm"><label class="field"><span>Next due</span><input class="input" type="date" name="d" value="' + esc(cur0) + '" required></label><div id="sdErr"></div><button class="btn block" type="submit">Save the date</button>' +
      (cur0 ? '<div class="btns"><button class="link-btn danger" type="button" id="sdClear">Clear the date</button></div>' : '') + '</form>', function (root) {
      $('#sdForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var r = doAct('setdate', { id: id, d: e.target.d.value });
        if (r instanceof Error) $('#sdErr', root).innerHTML = '<p class="err" role="alert">' + esc(r.message) + '</p>';
      });
      var cl = $('#sdClear', root);
      if (cl) cl.addEventListener('click', function () { doAct('setdate', { id: id, d: null }); });
    });
  }

  /** The log form - for "Done", for "It was done earlier", for a fresh entry,
   *  and for what the AI read off a receipt. Nothing is saved until Add. */
  function logSheet(pre) {
    var c = car(); if (!c) return;
    var p = pre || {};
    var t = today();
    var all = C.ITEMS.filter(function (it) { return C.applies(c, it); });
    var pick = p.items || [];
    var kmTxt = p.km != null ? C.num(C.fromKm(p.km, units())) : '';
    var pc = C.paceOf(c, t);
    var photo = p.photo || null;
    var html = '<h2>' + esc(p.title || '🧾 Log a service') + '</h2>' + (p.intro ? '<p class="small muted">' + esc(p.intro) + '</p>' : '') +
      (p.photo || p.past ? '' : '<p class="small"><button class="link-btn" type="button" data-act="read" data-kind="receipt" style="padding:0;min-height:0">✨ Snap the receipt and let AI fill this in</button></p>') +
      '<form id="logForm"><div class="two"><label class="field"><span>Date</span><input class="input" type="date" name="d" value="' + esc(p.d || (p.past ? '' : t)) + '" max="' + t + '" required></label>' +
      '<label class="field"><span>Odometer then <small>optional</small></span><span class="unitwrap"><input class="input" name="km" inputmode="decimal" autocomplete="off" value="' + esc(kmTxt) + '" placeholder="' + (pc.latest && !p.past ? '≈ ' + esc(C.num(C.fromKm(pc.est, units()))) : '') + '"><span class="u">' + esc(units()) + '</span></span></label></div>' +
      '<fieldset class="field"><legend>What was done</legend><div class="checks">' + all.map(function (it) {
        return '<label class="check"><input type="checkbox" name="items" value="' + it.id + '"' + (pick.indexOf(it.id) >= 0 ? ' checked' : '') + '><span aria-hidden="true">' + esc(it.emoji) + '</span>' + esc(sp(it.short)) + '</label>';
      }).join('') + '</div></fieldset>' +
      '<label class="field"><span>Anything else <small>optional</small></span><input class="input" name="other" maxlength="' + C.LIMITS.other + '" value="' + esc(p.other || '') + '" placeholder="Front brake pads, a new headlight bulb…"></label>' +
      '<div class="two"><label class="field"><span>Cost <small>' + esc(p.cur && p.cur !== cur() ? p.cur : cur()) + ', optional</small></span><input class="input" name="cost" inputmode="decimal" autocomplete="off" value="' + (p.cost != null ? esc(String(p.cost)) : '') + '"></label>' +
      '<label class="field"><span>Shop <small>optional</small></span><input class="input" name="shop" maxlength="' + C.LIMITS.shop + '" value="' + esc(p.shop || '') + '" autocomplete="organization"></label></div>' +
      '<label class="field"><span>Note <small>optional</small></span><textarea class="input" name="note" maxlength="' + C.LIMITS.note + '" placeholder="Anything worth remembering">' + esc(p.note || '') + '</textarea></label>' +
      (isDemo() ? '' : (photo ? '<label class="toggle"><input type="checkbox" name="keepPhoto" checked> Keep the receipt photo on this phone (never uploaded)</label>'
        : '<label class="btn small ghost" style="cursor:pointer">📎 Add a receipt photo<input class="vh" type="file" accept="image/*" id="logPhoto"></label> <span class="small muted" id="logPhotoNote">Stays on this phone.</span>')) +
      (p.curNote ? '<p class="warnbox"><span aria-hidden="true">💱</span><span>' + esc(p.curNote) + '</span></p>' : '') +
      '<div id="logErr" aria-live="polite"></div><button class="btn block" type="submit">Add to the log</button></form>';
    sheet(html, function (root) {
      var f = $('#logPhoto', root);
      if (f) f.addEventListener('change', function () {
        var file = f.files && f.files[0];
        if (!file) return;
        shrink(file, RECEIPT_PX, 0.8).then(function (blob) { photo = blob; $('#logPhotoNote', root).textContent = 'Photo added - it stays on this phone.'; })
          .catch(function () { $('#logPhotoNote', root).textContent = 'That photo couldn’t be read.'; });
      });
      $('#logForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var fm = e.target;
        var items = $$('input[name=items]:checked', fm).map(function (x) { return x.value; });
        var kmRaw = fm.km.value.trim(); var km = parseNum(kmRaw);
        var costRaw = fm.cost.value.trim(); var cost = parseNum(costRaw);
        var err = $('#logErr', root);
        if (kmRaw && km === null) { err.innerHTML = '<p class="err" role="alert">The odometer should be a number - digits only.</p>'; return; }
        if (costRaw && cost === null) { err.innerHTML = '<p class="err" role="alert">The cost should be a number, like 89.50.</p>'; return; }
        var keepIt = photo && (!fm.keepPhoto || fm.keepPhoto.checked) && !isDemo();
        var savedSid = null;
        var r = doAct('service', { d: fm.d.value, km: km === null ? null : C.toKm(km, units()), items: items, other: fm.other.value, cost: cost, cur: p.cur && C.CURRENCIES.indexOf(p.cur) >= 0 ? p.cur : cur(), shop: fm.shop.value, note: fm.note.value, photo: Boolean(keepIt) }, function () { if (savedSid) receipts.del(savedSid).catch(function () { /* nothing kept */ }); });
        if (r instanceof Error) { err.innerHTML = '<p class="err" role="alert">' + esc(r.message) + '</p>'; return; }
        if (r && keepIt) {
          var sid = r.car.lastSvc;
          savedSid = sid;
          receipts.put({ id: sid, car: r.car.id, blob: photo, at: Date.now() }).then(function () { if (state.tab === 'log') drawThumbs(); }).catch(function () { toast('The entry is saved, but this browser wouldn’t keep the photo.', 4000); });
        }
      });
    });
  }

  /* ---------------- receipt photos, kept in this browser ---------------- */

  var receipts = (function () {
    var dbp = null;
    function req2p(r) { return new Promise(function (res, rej) { r.addEventListener('success', function () { res(r.result); }); r.addEventListener('error', function () { rej(r.error); }); }); }
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (res, rej) {
        try {
          var r = indexedDB.open('glovebox-receipts', 1);
          r.addEventListener('upgradeneeded', function () { var s = r.result.createObjectStore('receipts', { keyPath: 'id' }); s.createIndex('car', 'car'); });
          r.addEventListener('success', function () { res(r.result); });
          r.addEventListener('error', function () { rej(r.error); });
          r.addEventListener('blocked', function () { rej(new Error('blocked')); });
        } catch (e) { rej(e); }
      });
      dbp.catch(function () { dbp = null; });
      return dbp;
    }
    function store(mode) { return open().then(function (db) { return db.transaction('receipts', mode).objectStore('receipts'); }); }
    return {
      put: function (rec) { return store('readwrite').then(function (s) { return req2p(s.put(rec)); }); },
      get: function (id) { return store('readonly').then(function (s) { return req2p(s.get(id)); }); },
      list: function (carId) { return store('readonly').then(function (s) { return req2p(s.index('car').getAll(carId)); }); },
      del: function (id) { return store('readwrite').then(function (s) { return req2p(s.delete(id)); }); },
      clear: function () { return store('readwrite').then(function (s) { return req2p(s.clear()); }); },
    };
  }());
  var thumbUrls = [];
  function drawThumbs() {
    thumbUrls.forEach(function (u) { URL.revokeObjectURL(u); }); thumbUrls = [];
    if (isDemo()) return;
    $$('[data-thumb]').forEach(function (el) {
      var id = el.getAttribute('data-thumb');
      receipts.get(id).then(function (r) {
        if (!r || !r.blob) { el.innerHTML = '<span class="small muted">Photo not on this phone</span>'; return; }
        var u = URL.createObjectURL(r.blob); thumbUrls.push(u);
        el.innerHTML = '<button class="thumbbtn" type="button" data-act="receipt" data-sid="' + esc(id) + '" aria-label="Open the receipt photo"><img class="thumb" src="' + esc(u) + '" alt=""></button>';
      }).catch(function () { el.innerHTML = ''; });
    });
  }
  function openReceipt(sid) {
    receipts.get(sid).then(function (r) {
      if (!r || !r.blob) return;
      var u = URL.createObjectURL(r.blob);
      sheet('<h2>🧾 Receipt</h2><img class="preview" style="max-height:70vh" src="' + esc(u) + '" alt="The receipt photo"><p class="small muted">Kept on this phone only - never uploaded, and left out of the history you share.</p><div class="btns"><button class="btn ghost danger" type="button" id="delRc">Delete the photo</button></div>', function (root) {
        $('#delRc', root).addEventListener('click', function () {
          receipts.del(sid).then(function () {
            var c = car();
            var nc = JSON.parse(JSON.stringify(c));
            nc.services.forEach(function (s) { if (s.id === sid) s.photo = false; });
            replaceCar(nc); persist(); closeSheet(); draw(); toast('Photo deleted.');
          });
        });
      });
    }).catch(function () { toast('This browser won’t open the photo.'); });
  }

  /* ---------------- Log ---------------- */

  function logHtml() {
    var c = car();
    if (!c) return emptyHtml();
    var t = today();
    var k = C.costs(c, t, cur());
    var per = k.perKm ? money(units() === 'mi' ? k.perKm * C.KM_PER_MI : k.perKm) : '-';
    var html = carsBar() + '<div class="sec-head"><h1>Service log</h1><div class="row"><button class="btn small" type="button" data-act="logsvc">+ Log a service</button><button class="btn small ghost" type="button" data-act="read" data-kind="receipt">✨ Read a receipt</button></div></div>';
    html += '<section class="card"><div class="stats"><div class="stat"><b>' + esc(bigMoney(k.year)) + '</b><span>this year · ' + esc(plural(k.yearCount, 'entry', 'entries')) + '</span></div><div class="stat"><b>' + esc(bigMoney(k.all)) + '</b><span>all logged</span></div><div class="stat"><b>' + esc(per) + '</b><span>per ' + (units() === 'mi' ? 'mile' : 'km') + '</span></div></div>' +
      '<p class="small muted" style="margin:10px 0 0">' + (k.perKm ? 'Per ' + (units() === 'mi' ? 'mile' : 'km') + ' over the ' + esc(dist(k.distance, { step: 100 })) + ' your readings cover since the first cost.' : 'Cost per ' + (units() === 'mi' ? 'mile' : 'km') + ' appears once costs and a few readings are logged.') +
      (k.other ? ' ' + esc(plural(k.other, 'entry', 'entries')) + ' in another currency not added in.' : '') + '</p></section>';
    if (!c.services.length) return html + '<div class="card empty"><div class="big" aria-hidden="true">🧾</div><p><b>Nothing logged yet.</b></p><p class="muted small">Add the last oil change or service you remember - even roughly - and the board gets sharper. Snap an old receipt and AI fills it in.</p><button class="btn" type="button" data-act="logsvc">Log a service</button></div>';
    var byYear = {};
    c.services.slice().reverse().forEach(function (s) { (byYear[s.d.slice(0, 4)] = byYear[s.d.slice(0, 4)] || []).push(s); });
    Object.keys(byYear).sort().reverse().forEach(function (y) {
      var list = byYear[y];
      var sum = list.reduce(function (n, s) { return n + (s.cost !== null && s.cur === cur() ? s.cost : 0); }, 0);
      html += '<div class="yearhead">' + esc(y) + '<span>' + esc(plural(list.length, 'entry', 'entries')) + (sum ? ' · ' + esc(money(sum)) : '') + '</span></div><ol class="timeline">' + list.map(function (s) {
        var names = s.items.map(function (id) { var it = C.item(id); return '<span class="itag">' + esc(it.emoji) + ' ' + esc(sp(it.short)) + '</span>'; });
        if (s.other) names.push('<span class="itag">🔧 ' + esc(s.other) + '</span>');
        return '<li class="entry"><div class="ew"><b>' + esc(C.dateLabel(s.d, y + '-01-01')) + '</b><span>' + (s.km !== null ? esc(dist(s.km)) : 'no mileage') + '</span></div><div class="eb"><div class="tagrow">' + names.join('') + '</div>' +
          (s.shop ? '<p class="muted">' + esc(s.shop) + '</p>' : '') + (s.note ? '<p>' + esc(s.note) + '</p>' : '') + (s.photo ? '<div data-thumb="' + esc(s.id) + '"></div>' : '') + '</div>' +
          '<div class="row" style="flex-direction:column;align-items:flex-end;gap:2px">' + (s.cost !== null ? '<span class="ec">' + esc(money(s.cost, s.cur)) + '</span>' : '') + '<button class="pa icon" type="button" data-act="svcmore" data-sid="' + esc(s.id) + '" aria-label="More for this entry">⋯</button></div></li>';
      }).join('') + '</ol>';
    });
    return html;
  }
  function svcSheet(sid) {
    var c = car(); var s = c && c.services.filter(function (x) { return x.id === sid; })[0];
    if (!s) return;
    sheet('<h2>🧾 ' + esc(C.dateLabel(s.d, today())) + '</h2><p>' + esc(s.items.map(function (id) { return sp(C.item(id).name); }).concat(s.other ? [s.other] : []).join(' · ')) + '</p>' +
      '<ul class="menu"><li><button type="button" class="danger" id="svcDel"><span class="mi" aria-hidden="true">🗑️</span><span>Delete this entry<small>' + (s.photo ? 'And its receipt photo. ' : '') + 'You can undo it straight after.</small></span></button></li></ul>', function (root) {
      $('#svcDel', root).addEventListener('click', function () {
        var had = s.photo;
        var r = doAct('delsvc', { sid: sid });
        if (r && !(r instanceof Error) && had && !isDemo()) {
          // The photo goes only when the toast's Undo can no longer bring the
          // entry back - a photo deleted under an undone entry is gone for good.
          setTimeout(function () {
            var still = cars().some(function (x) { return x.services.some(function (y) { return y.id === sid; }); });
            if (!still) receipts.del(sid).catch(function () { /* nothing kept */ });
          }, 9000);
        }
      });
    });
  }

  /* ---------------- Lights ---------------- */

  function groupInfo(g) { return L.GROUPS.filter(function (x) { return x.id === g; })[0]; }
  function tile(l) {
    return '<button class="ltile" type="button" data-act="light" data-id="' + l.id + '"><span class="lt ' + LIT[l.colour] + '">' + L.svg(l) + '</span>' + esc(sp(l.name)) + '</button>';
  }
  function searchResults() {
    var q = state.lights.q;
    if (!q.trim()) return '';
    var r = L.find(q, 10);
    if (!r.length) return '<p class="muted" style="margin-top:10px">Nothing called that. Try the colour instead, or a shape: “engine”, “oil can”, “exclamation”.</p>';
    return '<ul class="lresult">' + r.map(function (l) {
      var g = groupInfo(l.group);
      return '<li><button class="lres" type="button" data-act="light" data-id="' + l.id + '"><span class="lt ' + LIT[l.colour] + '">' + L.svg(l) + '</span><span class="rb"><b>' + esc(sp(l.name)) + '</b><span>' + esc(C.Lights.COLOURS[l.colour].word + ' · ' + g.means) + '</span></span><span class="chev" aria-hidden="true">›</span></button></li>';
    }).join('') + '</ul>';
  }
  function lightsHtml() {
    var g = state.lights.group;
    if (!g) {
      var sample = { red: 'oil-pressure', amber: 'check-engine', info: 'high-beam' };
      return '<div class="sec-head"><h1>What’s this warning light?</h1></div><p class="muted">Start with its colour - that says how urgent it is - then pick the shape.</p>' +
        '<div class="colours">' + L.GROUPS.map(function (gr) {
          var l = L.light(sample[gr.id]);
          return '<button class="colour" type="button" data-act="lgroup" data-g="' + gr.id + '"><span class="sw ' + LIT[l.colour] + '">' + L.svg(l) + '</span><span class="ct"><b>' + esc(gr.label) + '</b><span class="gchip g-' + gr.id + '" style="align-self:flex-start;margin:4px 0"><span aria-hidden="true">' + GROUP_ICON[gr.id] + '</span>' + esc(gr.means) + '</span><span class="cnt">' + esc(L.inGroup(gr.id).length + ' lights') + '</span></span><span class="chev" aria-hidden="true">›</span></button>';
        }).join('') + '</div>' +
        '<div class="searchbox"><span class="sicon" aria-hidden="true">🔎</span><label class="vh" for="lightq">Search the lights</label><input class="input" id="lightq" type="search" autocomplete="off" placeholder="Or search: oil, battery, ' + esc(sp('tyre')) + ', engine…" value="' + esc(state.lights.q) + '"></div><div id="lightResults">' + searchResults() + '</div>' +
        '<section class="card"><h2>📷 Can’t tell which it is?</h2><p class="small muted">Snap the dashboard with the engine on. AI spots the lit symbols (and the odometer) - and Glovebox shows its own advice for each, never the AI’s. About a cent of credit; a free account comes with $2.</p><button class="btn" type="button" data-act="read" data-kind="dash">Snap my dashboard</button></section>' +
        disclaimer();
    }
    var gi = groupInfo(g);
    return '<p class="back"><button class="link-btn" type="button" data-act="lgroup" data-g="">‹ All colours</button></p><div class="sec-head"><h1>' + esc(gi.label) + ' lights</h1><span class="gchip g-' + g + '"><span aria-hidden="true">' + GROUP_ICON[g] + '</span>' + esc(gi.means) + '</span></div>' +
      '<p class="' + (g === 'red' ? 'stopbox g-red' : 'muted') + '">' + (g === 'red' ? '<span aria-hidden="true">🛑</span>' : '') + '<span>' + esc(gi.line) + '</span></p>' +
      '<div class="lgrid">' + L.inGroup(g).map(tile).join('') + '</div>' + disclaimer();
  }
  function disclaimer() {
    return '<p class="disclaim">Guidance, not a diagnosis. Symbols and colours vary between makes - check your owner’s manual. If in doubt, stop somewhere safe and call for help. Glovebox never tells you a warning is safe to ignore.</p>';
  }
  function lightHtml() {
    var l = L.light(state.lights.id);
    if (!l) return '<div class="card empty"><p>That light isn’t in the list.</p><button class="btn" type="button" data-act="tab" data-tab="lights">All the lights</button></div>';
    var gi = groupInfo(l.group);
    var colourWord = C.Lights.COLOURS[l.colour].word;
    var html = '<p class="back"><button class="link-btn" type="button" data-act="lgroup" data-g="' + l.group + '">‹ ' + esc(gi.label) + ' lights</button></p>' +
      '<div class="lhero"><span class="lt ' + LIT[l.colour] + '">' + L.svg(l) + '</span><div class="lm"><span class="gchip g-' + l.group + '"><span aria-hidden="true">' + GROUP_ICON[l.group] + '</span>' + esc(colourWord + ' · ' + gi.means) + '</span><h1>' + esc(sp(l.name)) + '</h1>' +
      (l.fuel ? '<p class="small muted" style="margin:2px 0 0">' + esc(l.fuel.map(function (f) { return L.FUEL_WORDS[f]; }).join(', ')) + '</p>' : '') + '</div></div>';
    html += '<div class="stopbox g-' + l.group + '"><span aria-hidden="true">' + GROUP_ICON[l.group] + '</span><p>' + esc(l.urgency) + (l.group === 'red' ? '<br><span class="small" style="font-weight:600">Don’t drive on until you know what it is. If you’re unsure or unsafe, call for roadside help.</span>' : '') + '</p></div>';
    var means = '<section class="card"><h2>What it means</h2><p>' + esc(sp(l.means)) + '</p>' + (l.flashing ? '<p class="warnbox"><span aria-hidden="true">💡</span><span><b>If it’s flashing:</b> ' + esc(l.flashing) + '</span></p>' : '') +
      '<h3>Typical cause</h3><p class="small">' + esc(sp(l.cause)) + '</p></section>';
    // What to do comes first: someone reading this may be at the roadside.
    html += '<div class="twocol"><div><section class="card"><h2>Do this now</h2><ol class="steps2">' + l.now.map(function (s) { return '<li>' + esc(sp(s)) + '</li>'; }).join('') + '</ol></section>' +
      '<section class="card"><h2>Don’t</h2><ul class="donts">' + l.dont.map(function (s) { return '<li><span aria-hidden="true">✋</span><span>' + esc(sp(s)) + '</span></li>'; }).join('') + '</ul></section></div>' + means + '</div>';
    html += disclaimer();
    return html;
  }

  /* ---------------- History report ---------------- */

  function reportHtml() {
    var c = car();
    if (!c) return emptyHtml();
    var t = today();
    var rp = state.report;
    var packed = C.packReport(c, { today: t, units: units(), costs: rp.costs, notes: rp.notes });
    var clean = C.cleanReport(JSON.parse(JSON.stringify(packed)));
    var html = carsBar() + '<div class="sec-head noprint"><h1>Service history</h1></div>' +
      '<section class="card noprint"><p>Selling or handing it over? Give the next owner a tidy history - dates, mileage and work done - as a link they can open on any phone, or print it.</p>' +
      '<label class="toggle"><input type="checkbox" data-opt="costs"' + (rp.costs ? ' checked' : '') + '> Show what each service cost</label>' +
      '<label class="toggle"><input type="checkbox" data-opt="notes"' + (rp.notes ? ' checked' : '') + '> Include your notes</label>' +
      '<div class="btns"><button class="btn" type="button" data-act="mklink"' + (clean ? '' : ' disabled') + '>Make a share link</button><button class="btn ghost" type="button" data-act="print"' + (clean ? '' : ' disabled') + '>Print or save as PDF</button></div>' +
      '<div id="repLink">' + (rp.link && rp.linkFor === c.id ? linkHtml(rp.link, rp.dropped) : '') + '</div>' +
      '<p class="small muted" style="margin:12px 0 0">🔒 The history travels inside the link itself - nothing is stored on a server. Receipt photos stay on your phone and are never included.</p></section>';
    if (!clean) return html + '<div class="card empty"><div class="big" aria-hidden="true">📄</div><p><b>Nothing to show a buyer yet.</b></p><p class="muted small">Log a service or two first - even old ones from receipts in the glovebox.</p><button class="btn" type="button" data-act="logsvc">Log a service</button></div>';
    html += '<p class="eyebrow noprint" style="margin-top:18px">What the buyer sees</p><article class="report print-me">' + C.reportHtml(clean, { units: units(), region: region() }) + '</article>';
    return html;
  }
  function linkHtml(url, dropped) {
    return '<p class="linkbox" id="linkText">' + esc(url) + '</p>' + (dropped ? '<p class="small muted">The oldest ' + esc(plural(dropped, 'entry', 'entries')) + ' didn’t fit in one link and were left off - print a PDF for the full history.</p>' : '') +
      '<div class="btns">' + (navigator.share ? '<button class="btn small" type="button" data-act="sharelink">Share</button>' : '') +
      '<button class="btn small ghost" type="button" data-act="copylink">Copy</button><a class="btn small ghost" href="' + esc(url) + '" target="_blank" rel="noopener">Open the buyer’s view</a></div>';
  }
  function makeLink() {
    var c = car(); if (!c) return;
    var btn = $('[data-act=mklink]');
    if (btn) { btn.disabled = true; btn.textContent = 'Making the link…'; }
    var packed = C.packReport(c, { today: today(), units: units(), costs: state.report.costs, notes: state.report.notes });
    C.encodeReport(packed).then(function (r) {
      if (!r) throw new Error('too long');
      state.report.link = location.origin + BASE + 'history#' + r.frag;
      state.report.linkFor = c.id;
      state.report.dropped = r.dropped;
      var box = $('#repLink'); if (box) box.innerHTML = linkHtml(state.report.link, r.dropped);
      if (btn) { btn.disabled = false; btn.textContent = 'Make a new link'; }
    }).catch(function () { if (btn) { btn.disabled = false; btn.textContent = 'Make a share link'; } toast('Could not make the link in this browser - print a PDF instead.'); });
  }

  /* ---------------- add a car ---------------- */

  function addForm() {
    if (!state.add) state.add = { fuel: 'petrol', belt: 'unsure', last: 'unsure' };
    return state.add;
  }
  function segHtml(name, options, value) {
    return '<div class="seg" role="radiogroup" data-seg="' + name + '">' + options.map(function (o) {
      var on = String(o[0]) === String(value);
      return '<button type="button" class="segb" role="radio" aria-checked="' + on + '" data-act="seg" data-k="' + name + '" data-v="' + esc(o[0]) + '">' + o[1] + (o[2] ? '<small>' + esc(o[2]) + '</small>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function fuelOpts() { return C.FUELS.map(function (f) { return [f, esc(C.fuelWord(f, region()))]; }); }
  var MAKES = ['Audi', 'BMW', 'Chevrolet', 'Citroën', 'Dacia', 'Fiat', 'Ford', 'Honda', 'Hyundai', 'Jeep', 'Kia', 'Land Rover', 'Lexus', 'Mazda', 'Mercedes-Benz', 'MINI', 'Mitsubishi', 'Nissan', 'Peugeot', 'Renault', 'Ram', 'Subaru', 'Suzuki', 'Skoda', 'Tesla', 'Toyota', 'Vauxhall', 'Volkswagen', 'Volvo'];
  function addHtml() {
    var f = addForm();
    var t = today();
    var yr = Number(t.slice(0, 4));
    return '<p class="back"><button class="link-btn" type="button" data-act="addcancel">‹ ' + (cars().length && !isDemo() ? 'Back to the garage' : 'Back') + '</button></p><h1>Add your car</h1><p class="muted">Two minutes, on this phone only. Glovebox builds a maintenance plan from it - you can change any of it later.</p>' +
      '<form id="addForm" class="card" autocomplete="off">' +
      '<div class="three"><label class="field"><span>Make</span><input class="input" name="make" list="makes" maxlength="' + C.LIMITS.make + '" value="' + esc(f.make || '') + '" placeholder="Toyota"></label>' +
      '<label class="field"><span>Model</span><input class="input" name="model" maxlength="' + C.LIMITS.model + '" value="' + esc(f.model || '') + '" placeholder="Corolla"></label>' +
      '<label class="field"><span>Year</span><input class="input" name="year" inputmode="numeric" maxlength="4" value="' + esc(f.year || '') + '" placeholder="' + (yr - 6) + '"></label></div>' +
      '<datalist id="makes">' + MAKES.map(function (m) { return '<option value="' + esc(m) + '">'; }).join('') + '</datalist>' +
      '<fieldset class="field"><legend>Fuel</legend>' + segHtml('fuel', fuelOpts(), f.fuel) + '</fieldset>' +
      '<label class="field"><span>What the odometer says now</span><span class="unitwrap"><input class="input" name="km" inputmode="decimal" required value="' + esc(f.km || '') + '" placeholder="e.g. ' + (units() === 'mi' ? '48,200' : '77,500') + '"><span class="u">' + esc(units()) + '</span></span><small>Wrong unit? Switch miles / km in More.</small></label>' +
      '<label class="field"><span>A nickname <small>optional</small></span><input class="input" name="nick" maxlength="' + C.LIMITS.nick + '" value="' + esc(f.nick || '') + '" placeholder="The family car, Bluebell…"></label>' +
      (f.fuel === 'ev' ? '' : '<fieldset class="field"><legend>Timing belt or chain?</legend>' + segHtml('belt', [['belt', 'Belt', 'replaced on a schedule'], ['chain', 'Chain', 'usually lasts'], ['unsure', 'Not sure', 'ask me later']], f.belt) + '</fieldset>') +
      '<fieldset class="field"><legend>Its last service</legend>' + segHtml('last', [['known', 'I know when'], ['new', 'It’s new', 'or just serviced'], ['unsure', 'Not sure']], f.last) + '</fieldset>' +
      (f.last === 'known' ? '<div class="two"><label class="field"><span>Date (roughly is fine)</span><input class="input" type="date" name="lastD" max="' + t + '" value="' + esc(f.lastD || '') + '"></label><label class="field"><span>Odometer then <small>optional</small></span><span class="unitwrap"><input class="input" name="lastKm" inputmode="decimal" value="' + esc(f.lastKm || '') + '"><span class="u">' + esc(units()) + '</span></span></label></div><p class="small muted" style="margin-top:-6px">It covers the routine jobs - oil, rotation, filters, the brake check. Log the bigger ones (' + esc(sp('tyres')) + ', timing belt) on their own if you know them.</p>' : '') +
      (f.last === 'unsure' ? '<p class="small muted" style="margin-top:-6px">No problem - Glovebox counts from today and marks those items “No record”. Add old receipts any time.</p>' : '') +
      '<details class="more-fields"><summary>Renewal dates <span class="small muted" style="margin-left:6px">optional</span></summary><div class="three">' +
      ['inspection', 'registration', 'insurance'].map(function (id) { var it = C.item(id); return '<label class="field"><span>' + esc(it.short) + ' due</span><input class="input" type="date" name="d_' + id + '" value="' + esc((f.dates && f.dates[id]) || '') + '"></label>'; }).join('') + '</div></details>' +
      '<div id="addErr" aria-live="polite"></div><button class="btn block" type="submit">Add to my garage</button></form>';
  }
  function readAddForm(fm) {
    var f = addForm();
    ['make', 'model', 'year', 'km', 'nick', 'lastD', 'lastKm'].forEach(function (k) { if (fm[k]) f[k] = fm[k].value; });
    f.dates = {};
    ['inspection', 'registration', 'insurance'].forEach(function (id) { var x = fm['d_' + id]; if (x && x.value) f.dates[id] = x.value; });
    return f;
  }
  function submitAdd(fm) {
    var f = readAddForm(fm);
    var err = $('#addErr');
    var km = parseNum(f.km);
    if (km === null) { err.innerHTML = '<p class="err" role="alert">Type what the odometer says - digits only. It’s how Glovebox works out what’s due.</p>'; fm.km.focus(); return; }
    var lastKm = parseNum(f.lastKm);
    var year = parseNum(f.year);
    var c = C.newCar({ nick: f.nick, make: f.make, model: f.model, year: year === null ? null : Math.round(year), fuel: f.fuel, belt: f.belt, km: C.toKm(km, units()),
      last: f.last, lastD: f.lastD, lastKm: lastKm === null ? null : C.toKm(lastKm, units()), dates: f.dates }, { today: today(), currency: cur() });
    if (!c) { err.innerHTML = '<p class="err" role="alert">Give it a make, a model or a nickname.</p>'; return; }
    if (isDemo()) state.source = 'mine';
    var h = ensureMine();
    if (h.cars.length >= C.LIMITS.cars) { err.innerHTML = '<p class="err" role="alert">That’s ' + C.LIMITS.cars + ' cars - the most one phone keeps.</p>'; return; }
    h.cars.push(c);
    state.source = 'mine';
    state.carId = c.id;
    state.add = null;
    resetReport();
    persist();
    go('next');
    toast(C.carName(c) + ' is in the garage. Here’s what’s next.', 5000);
  }

  /* ---------------- the plan ---------------- */

  function planHtml() {
    var c = car();
    if (!c) return emptyHtml();
    var mine = C.ITEMS.filter(function (it) { return C.applies(c, it); });
    var not = C.ITEMS.filter(function (it) { return !C.applies(c, it); });
    var html = '<p class="back"><button class="link-btn" type="button" data-act="tab" data-tab="more">‹ More</button></p><h1>' + esc(C.carName(c)) + '’s plan</h1>' +
      '<p class="manual"><span aria-hidden="true">📘</span><span><b>Your manual wins.</b> These are cautious generic intervals for a ' + esc(C.fuelWord(c.fuel, region()).toLowerCase()) + ' car. Change any to match your owner’s manual - many give a shorter “severe service” interval for short trips, towing or dusty roads.</span></p><ul class="ilist">';
    html += mine.map(function (it) {
      var iv = C.intervalOf(c, it);
      var every = iv.off ? 'Not tracked' : it.kind === 'date' ? 'Every ' + plural(iv.months || 12, 'month') + (c.dates[it.id] ? ' · next ' + C.dateLabel(c.dates[it.id], today()) : ' · no date yet') : 'Every ' + [iv.km ? dist(iv.km, { step: 100 }) : '', iv.months ? plural(iv.months, 'month') : ''].filter(Boolean).join(' or ');
      return '<li><button class="irow-compact" type="button" data-act="planitem" data-item="' + it.id + '"><span class="ie" aria-hidden="true">' + esc(it.emoji) + '</span><span class="ib"><span class="iname">' + esc(sp(it.name)) + '</span><span class="imeta">' + esc(every) + (iv.custom ? ' · your setting' : '') + '</span></span><span class="chev" aria-hidden="true">›</span></button></li>';
    }).join('') + '</ul>';
    if (not.length) html += '<p class="small muted" style="margin-top:14px">Not on this car: ' + esc(not.map(function (it) { return sp(it.short) + (it.belt && c.fuel !== 'ev' ? (c.belt === 'chain' ? ' (it has a chain)' : ' (belt or chain not known yet)') : ''); }).join(', ')) + '.' +
      (c.fuel !== 'ev' && c.belt !== 'belt' ? ' <button class="link-btn" type="button" data-act="editcar" style="padding:0;min-height:0">Change belt / chain</button>' : '') + '</p>';
    return html;
  }
  function planSheet(id) {
    var c = car(); var it = C.item(id);
    if (!c || !it) return;
    var iv = C.intervalOf(c, it);
    var gen = [iv.baseKm ? dist(iv.baseKm, { step: 100 }) : '', iv.baseMonths ? plural(iv.baseMonths, 'month') : ''].filter(Boolean).join(' or ');
    sheet('<h2>' + esc(it.emoji) + ' ' + esc(sp(it.name)) + '</h2><p class="small muted">Generic: every ' + esc(gen) + '. ' + esc(sp(it.why)) + '</p><form id="planForm">' +
      (it.kind === 'date' ? '' : '<label class="field"><span>Every <small>' + esc(uWord()) + ' - leave empty for time only</small></span><span class="unitwrap"><input class="input" name="km" inputmode="decimal" value="' + (iv.km ? esc(C.num(Math.round(C.fromKm(iv.km, units()) / 100) * 100)) : '') + '"><span class="u">' + esc(units()) + '</span></span></label>') +
      '<label class="field"><span>Or every <small>months' + (it.kind === 'date' ? '' : ' - leave empty for distance only') + '</small></span><input class="input" name="months" inputmode="numeric" value="' + (iv.months ? esc(String(iv.months)) : '') + '"></label>' +
      '<label class="toggle"><input type="checkbox" name="off"' + (iv.off ? ' checked' : '') + '> Don’t track this on this car</label>' +
      '<div id="plErr" aria-live="polite"></div><button class="btn block" type="submit">Save</button>' +
      (iv.custom || iv.off ? '<div class="btns"><button class="link-btn" type="button" id="plReset">Back to the generic interval</button></div>' : '') + '</form>', function (root) {
      $('#planForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var fm = e.target;
        var km = fm.km ? parseNum(fm.km.value) : null;
        var mo = parseNum(fm.months.value);
        var opts = { id: id, off: fm.off.checked };
        if (fm.km) opts.km = km === null ? null : Math.round(C.toKm(km, units()));
        opts.months = mo === null ? null : Math.round(mo);
        var bad = (fm.km && fm.km.value.trim() && km === null) || (fm.months.value.trim() && mo === null);
        if (bad) { $('#plErr', root).innerHTML = '<p class="err" role="alert">Numbers only, please.</p>'; return; }
        if (!opts.off && opts.km === null && opts.months === null) { $('#plErr', root).innerHTML = '<p class="err" role="alert">Give a distance, a number of months, or both.</p>'; return; }
        if (opts.km !== null && opts.km !== undefined && (opts.km < 500 || opts.km > 500000)) { $('#plErr', root).innerHTML = '<p class="err" role="alert">Between ' + esc(dist(500)) + ' and ' + esc(dist(500000)) + ', please.</p>'; return; }
        if (opts.months !== null && (opts.months < 1 || opts.months > 240)) { $('#plErr', root).innerHTML = '<p class="err" role="alert">Between 1 and 240 months, please.</p>'; return; }
        var r = doAct('plan', opts);
        if (r instanceof Error) $('#plErr', root).innerHTML = '<p class="err" role="alert">' + esc(r.message) + '</p>';
      });
      var rs = $('#plReset', root);
      if (rs) rs.addEventListener('click', function () { doAct('plan', { id: id, reset: true }); });
    });
  }
  function editSheet() {
    var c = car(); if (!c) return;
    var f = { fuel: c.fuel, belt: c.belt };
    sheet('<h2>✏️ ' + esc(C.carName(c)) + '</h2><form id="edForm"><label class="field"><span>Nickname</span><input class="input" name="nick" maxlength="' + C.LIMITS.nick + '" value="' + esc(c.nick) + '"></label>' +
      '<div class="three"><label class="field"><span>Make</span><input class="input" name="make" maxlength="' + C.LIMITS.make + '" value="' + esc(c.make) + '"></label><label class="field"><span>Model</span><input class="input" name="model" maxlength="' + C.LIMITS.model + '" value="' + esc(c.model) + '"></label><label class="field"><span>Year</span><input class="input" name="year" inputmode="numeric" maxlength="4" value="' + (c.year || '') + '"></label></div>' +
      '<fieldset class="field"><legend>Fuel</legend>' + segHtml('fuel', fuelOpts(), f.fuel) + '</fieldset>' +
      '<fieldset class="field"><legend>Timing belt or chain?</legend>' + segHtml('belt', [['belt', 'Belt'], ['chain', 'Chain'], ['unsure', 'Not sure']], f.belt) + '</fieldset>' +
      '<div id="edErr"></div><button class="btn block" type="submit">Save</button></form>', function (root) {
      root.addEventListener('click', function (e) { var b = e.target.closest('[data-act=seg]'); if (b && root.contains(b)) { e.stopPropagation(); segPick(b, f); } });
      $('#edForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var fm = e.target; var y = parseNum(fm.year.value);
        var r = doAct('edit', { nick: fm.nick.value, make: fm.make.value, model: fm.model.value, year: y === null ? null : Math.round(y), fuel: f.fuel, belt: f.belt });
        if (r instanceof Error) $('#edErr', root).innerHTML = '<p class="err" role="alert">' + esc(r.message) + '</p>';
      });
    });
  }
  function segPick(btn, form) {
    var group = btn.closest('.seg');
    var k = btn.getAttribute('data-k'), v = btn.getAttribute('data-v');
    $$('.segb', group).forEach(function (b) { b.setAttribute('aria-checked', String(b === btn)); });
    form[k] = v;
  }

  /* ---------------- More ---------------- */

  function moreHtml() {
    var s = state.settings;
    var c = car();
    var uval = s.unitsAuto ? 'auto' : s.units;
    var html = '<h1>More</h1>';
    html += '<section class="card"><h2>📏 Units and money</h2><fieldset class="field"><legend>Distance</legend>' + segHtml('units', [['auto', 'Automatic', C.unitsFor(s.region) === 'mi' ? 'miles here' : 'km here'], ['mi', 'Miles'], ['km', 'Kilometres']], uval) + '</fieldset>' +
      '<label class="field"><span>Currency</span><select class="input" id="curSel"><option value="auto"' + (s.curAuto ? ' selected' : '') + '>Automatic (' + esc(C.currencyFor(s.region)) + ')</option>' + C.CURRENCIES.map(function (x) { return '<option value="' + x + '"' + (!s.curAuto && s.currency === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></label>' +
      '<p class="small muted">Everything is kept in kilometres underneath, so switching never changes a number.</p></section>';
    if (c) {
      html += '<section class="card"><h2>🚗 ' + esc(C.carName(c)) + '</h2><div class="btns"><button class="btn ghost" type="button" data-act="tab" data-tab="plan">Its maintenance plan</button><button class="btn ghost" type="button" data-act="editcar">Edit the car</button></div>' +
        (isDemo() ? '' : '<div class="btns"><button class="link-btn danger" type="button" data-act="delcar">Remove ' + esc(C.carName(c)) + ' from this phone</button></div>') + '</section>';
      html += '<section class="card"><h2>📅 Due dates in your calendar</h2><p class="small muted">Glovebox can’t send reminders - but your calendar can. This makes a calendar file of everything due in the next year, mileage ones at their projected dates. It’s a snapshot: download it again after a service.</p><button class="btn" type="button" data-act="ics">Add due dates to my calendar</button></section>';
    }
    html += '<section class="card"><h2>✨ Read a photo with AI</h2><p class="small muted">Snap the dashboard (which lights, and the odometer) or a receipt (date, mileage, work and cost - you check it before it’s saved). About a cent of AI credit; a free account comes with $2. The photo is read once and never stored.</p><div class="btns"><button class="btn" type="button" data-act="read" data-kind="dash">Read my dashboard</button><button class="btn ghost" type="button" data-act="read" data-kind="receipt">Read a receipt</button></div></section>';
    html += '<section class="card"><h2>📦 Moving phones</h2><p class="small muted">Your garage lives on this phone only. Export it to a file and import it on the new one. Receipt photos stay behind - they’re kept in this browser, not in the file.</p><div class="btns"><button class="btn ghost" type="button" data-act="export"' + (state.mine && state.mine.cars.length ? '' : ' disabled') + '>Export my garage</button><label class="btn ghost" style="cursor:pointer">Import a file<input class="vh" type="file" accept="application/json,.json" data-file="import"></label></div></section>';
    html += '<section class="card"><h2>👤 Account</h2>' + (signedIn() ? '<p class="small muted">Signed in as ' + esc(state.me.email) + '. Only reading photos uses it.</p><button class="btn ghost" type="button" data-act="account">Account and credit</button>' : '<p class="small muted">Nothing in Glovebox needs an account except reading a photo with AI. One free account works across every app on this site.</p><button class="btn ghost" type="button" data-act="signin">Sign in or create one</button>') + '</section>';
    html += '<section class="card"><h2>🔒 Your data</h2><p class="small muted">Cars, services, readings and receipts stay on this phone. The server stores nothing about your car - the AI photo read is the only time a photo leaves the phone, and it isn’t kept.</p>' +
      (isDemo() ? '<button class="btn ghost" type="button" data-act="mine">Leave the example</button>' : (state.mine && state.mine.cars.length ? '<button class="link-btn danger" type="button" data-act="wipe">Delete everything from this phone</button>' : '')) + '</section>';
    return html;
  }
  function setUnits(v) {
    var s = state.settings;
    if (v === 'auto') { s.unitsAuto = true; s.units = C.unitsFor(s.region); } else if (C.UNITS.indexOf(v) >= 0) { s.unitsAuto = false; s.units = v; }
    persist(); resetReport(); draw(); toast('Distances in ' + (s.units === 'mi' ? 'miles' : 'kilometres') + '.');
  }
  function setCurrency(v) {
    var s = state.settings;
    if (v === 'auto') { s.curAuto = true; s.currency = C.currencyFor(s.region); } else if (C.CURRENCIES.indexOf(v) >= 0) { s.curAuto = false; s.currency = v; }
    if (isDemo()) state.demo = D.build(today(), s.currency);
    persist(); draw(); toast('Costs in ' + s.currency + '. Entries logged in another currency keep theirs.');
  }
  function importFile(file) {
    if (!file) return;
    if (file.size > C.LIMITS.importBytes) { toast('That file is too big to be a Glovebox export.'); return; }
    var r = new FileReader();
    r.addEventListener('load', function () {
      var res;
      try { res = C.importGarage(String(r.result), { today: today(), locale: LOCALE, currency: cur() }); } catch (e) { toast(e.message, 4500); return; }
      if (!res.cars.length) { toast('No cars in that file.'); return; }
      sheet('<h2>Import ' + esc(plural(res.cars.length, 'car')) + '?</h2><p class="muted">' + esc(res.cars.map(C.carName).join(', ')) + '.</p>' + (res.dropped ? '<p class="small muted">' + esc(plural(res.dropped, 'entry', 'entries')) + ' couldn’t be read and will be skipped.</p>' : '') +
        '<p class="small">This replaces the garage on this phone' + (state.mine && state.mine.cars.length ? ' (' + esc(plural(state.mine.cars.length, 'car')) + ')' : '') + '.</p><div class="btns"><button class="btn" type="button" id="impGo">Import</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div>', function (root) {
        $('#impGo', root).addEventListener('click', function () {
          state.mine = { cars: res.cars };
          state.settings = Object.assign({}, state.settings, { units: res.settings.units, unitsAuto: res.settings.unitsAuto, currency: res.settings.currency, curAuto: res.settings.curAuto });
          state.source = 'mine'; state.carId = res.cars[0].id;
          persist(); closeSheet(); go('next'); toast('Imported ' + plural(res.cars.length, 'car') + '.');
        });
      });
    });
    r.readAsText(file);
  }

  /* ---------------- photos: shrink on the phone ---------------- */

  function shrink(file, px, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener('load', function () {
        var s = Math.min(1, px / Math.max(img.naturalWidth, img.naturalHeight));
        var cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.naturalWidth * s)); cv.height = Math.max(1, Math.round(img.naturalHeight * s));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error('That photo could not be read.')); }, 'image/jpeg', quality || 0.85);
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be opened.')); });
      img.src = url;
    });
  }
  function blobToBase64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.addEventListener('load', function () { res(String(r.result).split(',')[1] || ''); });
      r.addEventListener('error', function () { rej(r.error); });
      r.readAsDataURL(blob);
    });
  }

  /* ---------------- the one AI call ---------------- */

  var READ = {
    dash: { title: '📷 Read my dashboard', what: 'Snap the dashboard with the engine on, so the lights show. AI spots the lit symbols and the odometer.', hint: 'The whole instrument panel, in focus, without glare.', btn: 'Read the dashboard' },
    receipt: { title: '✨ Read a receipt', what: 'Snap a service receipt or invoice. AI reads the date, mileage, work and cost into a log entry - you check it before anything is saved.', hint: 'The whole receipt, flat, in good light.', btn: 'Read the receipt' },
  };
  function openRead(kind) {
    var k = READ[kind] ? kind : 'dash';
    var R = READ[k];
    if (!signedIn()) {
      sheet('<h2>' + R.title + '</h2><p>' + esc(R.what) + '</p>' +
        '<div class="note"><p><b>It uses about a cent of AI credit, so it needs a free account</b> (it comes with $2).' + (k === 'dash' ? ' The warning-light finder is free and needs nothing - pick the colour, then the shape.' : ' Typing an entry in is free and needs nothing.') + '</p><p class="small muted" style="margin:0">The photo is shrunk on your phone, read once, and never stored.</p></div>' +
        '<div class="btns"><button class="btn" type="button" id="rdSign">Create a free account</button>' + (k === 'dash' ? '<button class="btn ghost" type="button" data-act="tab" data-tab="lights">Use the free finder</button>' : '<button class="btn ghost" type="button" data-act="closesheet">Not now</button>') + '</div>', function (root) {
        $('#rdSign', root).addEventListener('click', function () { openAccount('A free account comes with $2 of AI credit - about 100 photo reads. Nothing else in Glovebox needs one.', function () { openRead(k); }); });
      });
      return;
    }
    var look = { url: null };
    sheet('<h2>' + R.title + '</h2><p class="small muted">' + esc(R.hint) + ' Shrunk on your phone, read once by the AI, never stored.</p>' +
      '<label class="btn block" style="cursor:pointer">📷 Take or choose a photo<input class="vh" type="file" accept="image/*" id="rdFile"></label><div id="rdPrev"></div><div id="rdErr"></div><div id="rdOut"></div>', function (root) {
      $('#rdFile', root).addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        $('#rdErr', root).innerHTML = ''; $('#rdOut', root).innerHTML = '';
        shrink(f, PHOTO_PX, 0.85).then(function (blob) {
          if (look.url) URL.revokeObjectURL(look.url);
          look.url = URL.createObjectURL(blob);
          $('#rdPrev', root).innerHTML = '<img class="preview" src="' + esc(look.url) + '" alt="Your photo"><div class="btns"><button class="btn" type="button" id="rdSend">' + esc(R.btn) + '</button></div><p class="small muted">About a cent of AI credit.</p>';
          $('#rdSend', root).addEventListener('click', function (ev) {
            var btn = ev.currentTarget;
            btn.disabled = true; btn.textContent = 'Reading…';
            blobToBase64(blob).then(function (data) {
              return api('POST', 'api/read', { kind: k, photo: { type: 'image/jpeg', data: data }, today: today() });
            }).then(function (r) {
              btn.hidden = true;
              loadMe();
              if (k === 'dash') dashResult($('#rdOut', root), C.cleanDash(r.result));
              else receiptResult(C.cleanReceipt(r.result, { today: today() }), blob);
            }).catch(function (err) { btn.disabled = false; btn.textContent = R.btn; meteredError(err, $('#rdErr', root), function () { openRead(k); }); });
          });
        }).catch(function (err) { showError(err, $('#rdErr', root)); });
      });
    });
  }
  function dashResult(box, r) {
    var c = car();
    var html = '<section class="card" style="margin:12px 0 0"><p class="eyebrow">What the AI spotted</p>';
    if (!r.lights.length) html += '<p>No lit warning lights spotted. If you can see one, pick it by colour in the finder - and if it’s red, stop safely.</p>';
    else html += '<ul class="found">' + r.lights.map(function (x) {
      var l = x.id ? L.light(x.id) : null;
      var gi = groupInfo(x.group);
      var icon = l ? '<span class="lt ' + LIT[x.colour === 'red' ? 'red' : l.colour] + '">' + L.svg(l) + '</span>' : '<span class="lt" aria-hidden="true">?</span>';
      return '<li>' + icon + '<div class="fb"><span class="gchip g-' + x.group + '"><span aria-hidden="true">' + GROUP_ICON[x.group] + '</span>' + esc(gi.means) + '</span>' +
        (l ? '<p><b>' + esc(sp(l.name)) + '</b>' + (x.colour !== 'unknown' ? ' <span class="small muted">· seen ' + esc(x.colour) + '</span>' : '') + '</p><p>' + esc(sp(l.now[0])) + '</p><p><button class="link-btn" type="button" data-act="light" data-id="' + l.id + '" style="padding:0;min-height:0">What it means and what to do ›</button></p>'
          : '<p><b>' + esc(x.description || 'A symbol Glovebox can’t match') + '</b></p><p class="small">Glovebox can’t match this one - look it up in your owner’s manual. ' + esc(x.group === 'red' ? 'Treat it as red: find a safe place and stop.' : gi.line) + '</p>') + '</div></li>';
    }).join('') + '</ul>';
    if (r.notes) html += '<p class="small muted">AI’s note: ' + esc(r.notes) + '</p>';
    if (r.odometer && c) {
      var u = r.odometer.unit || units();
      var km = C.toKm(r.odometer.value, u);
      html += '<div class="note"><div class="row spread"><span>Odometer: <b>' + esc(C.dist(km, units())) + '</b>' + (r.odometer.unit ? '' : ' <span class="small muted">(assuming ' + esc(u === 'mi' ? 'miles' : 'km') + ')</span>') + '</span><button class="btn small" type="button" id="useOdo">Save as today’s reading</button></div></div>';
    }
    html += '<p class="small muted">The advice comes from Glovebox’s own list, not the AI. Guidance, not a diagnosis - your owner’s manual wins, and a red light always means stop safely.</p></section>';
    box.innerHTML = html;
    var b = $('#useOdo', box);
    if (b) b.addEventListener('click', function () {
      var res = doAct('reading', { km: C.toKm(r.odometer.value, r.odometer.unit || units()) });
      if (res instanceof Error) readingSheet(C.num(r.odometer.value));
    });
  }
  function receiptResult(r, blob) {
    var c = car();
    if (!c) { toast('Add your car first, then read the receipt into its log.'); return; }
    var items = []; var others = [];
    r.items.forEach(function (x) { if (x.item && C.applies(c, C.item(x.item))) { if (items.indexOf(x.item) < 0) items.push(x.item); } else if (x.description) others.push(x.description); });
    var sum = r.items.reduce(function (n, x) { return n + (x.cost || 0); }, 0);
    var cost = r.total !== null ? r.total : (sum ? Math.round(sum * 100) / 100 : null);
    var km = null;
    if (r.mileage) km = C.toKm(r.mileage.value, r.mileage.unit || units());
    var rcur = r.currency || cur();
    logSheet({
      title: '✨ From the receipt', intro: 'Check it against the receipt - fix anything the AI got wrong. Nothing is saved until you tap Add.',
      d: r.date || '', km: km, items: items, other: C.clean(others.join(', '), C.LIMITS.other), cost: cost, shop: r.shop, cur: rcur, photo: blob,
      curNote: rcur !== cur() ? 'The receipt is in ' + rcur + '. It’s kept in ' + rcur + ' and left out of your ' + cur() + ' totals.' : '',
    });
  }

  /* ---------------- sheets and the account ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    $$('.toast').forEach(function (t) { t.remove(); });
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false;
    document.body.classList.add('sheet-open');
    s.scrollTop = 0;
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2');
    if (f) f.setAttribute('tabindex', '-1');
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

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Glovebox stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function meteredError(err, box, retry) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount('Reading a photo uses about a cent of AI credit, so it needs a free account (it comes with $2).', retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }
  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var FREE_LINE = 'Nothing in Glovebox needs an account except reading a photo with AI - a free account comes with $2 of AI credit, and one account works across every app on this site.';
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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); if (state.tab === 'more') draw(); if (then) then(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { if (then) then(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Reading a photo costs about a cent. Everything else in Glovebox is free and needs no account.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); if (state.tab === 'more') draw(); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Everything else - the board, the light finder, the log, the history link - keeps working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- one click listener ---------------- */

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.closest('#sheet') && el.getAttribute('data-act') === 'seg') return; // sheets handle their own
    var act = el.getAttribute('data-act');
    var item = el.getAttribute('data-item');
    if (el.tagName === 'A' && act !== 'jump') e.preventDefault();
    switch (act) {
      case 'home': go('start'); break;
      case 'tab': closeSheet(true); if (el.getAttribute('data-tab') === 'lights') { state.lights.group = null; } go(el.getAttribute('data-tab')); break;
      case 'example': openDemo(); break;
      case 'mine': openMine(); break;
      case 'addcar': if (!state.source || isDemo()) { state.source = 'mine'; ensureMine(); } state.add = null; go('add'); break;
      case 'addcancel': state.add = null; if (cars().length) go('next'); else go('start'); break;
      case 'lights': if (!state.source) { state.source = 'mine'; ensureMine(); } state.lights.group = null; go('lights'); break;
      case 'car': state.carId = el.getAttribute('data-id'); resetReport(); if (!isDemo()) persist(); draw(); break;
      case 'jump': {
        e.preventDefault();
        var tgt = $('#band-' + el.getAttribute('data-band'));
        if (tgt) { if (tgt.tagName === 'DETAILS') tgt.open = true; tgt.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        break;
      }
      case 'reading': readingSheet(); break;
      case 'logsvc': logSheet(); break;
      case 'done': {
        var it = C.item(item);
        if (it && it.kind === 'date') logSheet({ items: [item], title: '✓ ' + sp(it.name) + ' renewed' });
        else if (it) logSheet({ items: [item], title: '✓ ' + sp(it.name) + ' done' });
        break;
      }
      case 'donepast': { var it2 = C.item(item); if (it2) logSheet({ items: [item], past: true, title: '🕰️ When was it last done?', intro: 'Roughly is fine - from a receipt, the service book or the sticker on the windscreen.' }); break; }
      case 'itemmore': itemSheet(item); break;
      case 'setdate': setDateSheet(item); break;
      case 'planitem': planSheet(item); break;
      case 'trackoff': doAct('plan', { id: item, off: true }); break;
      case 'belt': doAct('belt', { belt: el.getAttribute('data-v') }); break;
      case 'svcmore': svcSheet(el.getAttribute('data-sid')); break;
      case 'receipt': openReceipt(el.getAttribute('data-sid')); break;
      case 'lgroup': closeSheet(true); state.lights.group = el.getAttribute('data-g') || null; go('lights'); break;
      case 'light': closeSheet(true); go('light', el.getAttribute('data-id')); break;
      case 'read': openRead(el.getAttribute('data-kind')); break;
      case 'closesheet': closeSheet(); break;
      case 'seg': {
        var k = el.getAttribute('data-k'), v = el.getAttribute('data-v');
        if (k === 'units') { setUnits(v); break; }
        if (state.tab === 'add') {
          var fm = $('#addForm'); if (fm) readAddForm(fm);
          var f = addForm(); f[k] = v;
          if (k === 'fuel' || k === 'last') { draw(); break; }
          segPick(el, f);
        }
        break;
      }
      case 'mklink': makeLink(); break;
      case 'copylink': copyText(state.report.link, 'Link copied - send it to the buyer'); break;
      case 'sharelink': {
        var c0 = car();
        navigator.share({ title: 'Service history', text: 'The service history for my ' + (c0 ? C.carTitle(c0) || C.carName(c0) : 'car') + ' - every service, with dates and mileage.', url: state.report.link }).catch(function () { /* cancelled */ });
        break;
      }
      case 'print': document.body.classList.add('printing-report'); window.print(); setTimeout(function () { document.body.classList.remove('printing-report'); }, 500); break;
      case 'ics': {
        var r = C.icsFor(cars(), { today: today(), units: units(), region: region(), now: Date.now() });
        if (!r.events) { toast('Nothing due in the next year.'); break; }
        download('glovebox-due-dates.ics', 'text/calendar', r.text);
        toast(plural(r.events, 'due date') + ' in the file - open it to add them to your calendar.', 4500);
        break;
      }
      case 'export': if (state.mine) download('glovebox-garage-' + today() + '.json', 'application/json', C.exportGarage({ settings: state.settings, cars: state.mine.cars })); break;
      case 'editcar': editSheet(); break;
      case 'delcar': {
        var c1 = car(); if (!c1) break;
        sheet('<h2>Remove ' + esc(C.carName(c1)) + '?</h2><p class="muted">Its plan, ' + esc(plural(c1.services.length, 'log entry', 'log entries')) + ' and readings leave this phone. Export a file first if you might want them.</p><div class="btns"><button class="btn" type="button" id="delGo">Remove it</button><button class="btn ghost" type="button" data-act="closesheet">Keep it</button></div>', function (root) {
          $('#delGo', root).addEventListener('click', function () {
            var before = state.mine.cars.slice();
            state.mine.cars = state.mine.cars.filter(function (x) { return x.id !== c1.id; });
            state.carId = state.mine.cars.length ? state.mine.cars[0].id : null;
            persist(); closeSheet(); resetReport();
            if (state.mine.cars.length) go('next'); else go('start');
            var undone = false;
            toast(C.carName(c1) + ' removed.', 8000, [{ label: 'Undo', run: function () { undone = true; state.mine.cars = before; state.source = 'mine'; state.carId = c1.id; persist(); go('next'); } }]);
            setTimeout(function () { if (!undone) receipts.list(c1.id).then(function (rows) { (rows || []).forEach(function (x) { receipts.del(x.id); }); }).catch(function () { /* nothing kept */ }); }, 9000);
          });
        });
        break;
      }
      case 'account': openSettings(); break;
      case 'signin': openAccount(); break;
      case 'wipe':
        sheet('<h2>Delete everything?</h2><p class="muted">Removes ' + esc(plural(cars().length, 'car')) + ', every log entry, reading and receipt photo from this phone. This can’t be undone - export a file first if you might want them back.</p><div class="btns"><button class="btn" type="button" id="wipeGo">Delete it all</button><button class="btn ghost" type="button" data-act="closesheet">Keep it</button></div>', function (root) {
          $('#wipeGo', root).addEventListener('click', function () {
            state.mine = null; keep(K_HOME, null); receipts.clear().catch(function () { /* nothing kept */ });
            state.source = null; state.carId = null; closeSheet(); go('start'); toast('Deleted from this phone.');
          });
        });
        break;
      default: break;
    }
  });
  document.addEventListener('submit', function (e) {
    if (e.target.id === 'addForm') { e.preventDefault(); submitAdd(e.target); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.getAttribute && t.getAttribute('data-file') === 'import') { importFile(t.files && t.files[0]); t.value = ''; return; }
    if (t.id === 'curSel') { setCurrency(t.value); return; }
    var opt = t.getAttribute && t.getAttribute('data-opt');
    if (opt === 'costs' || opt === 'notes') { state.report[opt] = t.checked; resetReport(); draw(); }
  });

  /* ---------------- a new day ---------------- */

  // "Today" is the phone's. When the date turns while the page is open (or
  // it comes back from the background on a new day), the board redraws -
  // and the example is rebuilt around the new today.
  function checkDay() {
    var t = today();
    if (t === state.day) return;
    state.day = t;
    if (isDemo()) state.demo = D.build(t, cur());
    if (state.view === 'app' && $('#sheet').hidden && state.tab !== 'add') draw();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) checkDay(); });
  setInterval(function () { if (!document.hidden) checkDay(); }, 60000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* no offline copy, still works online */ });
  }

  /* ---------------- start ---------------- */

  state.mine = loadMine();
  state.day = today();
  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });
  drawTop();
  route();
  loadMe().then(function () {
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
  });
}());
