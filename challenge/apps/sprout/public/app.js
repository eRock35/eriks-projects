/* Sprout - the page. One file, no build step.
 *
 * EVERYTHING LIVES ON THIS PHONE. The jungle is kept in localStorage
 * (sprout-home-v1) and every rule - the board, the learning, the seasons,
 * the streaks, the sitter's plan, the calendar file - is SproutCore, run
 * here. Diary photos are shrunk and kept in this browser's IndexedDB. The
 * only requests this page makes are the account's and the one AI call
 * ("What plant is this? / What's wrong with it?"), which sends one shrunk
 * photo, signed in, and only when the person taps Send.
 *
 * Every string that was typed (a nickname, a note), imported, or came back
 * from the server is escaped before it is drawn, and no handler is written
 * into markup: clicks are routed by data-act attributes from one listener
 * (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.SproutCore;
  var D = window.SproutDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_HOME = 'sprout-home-v1';
  var esc = C.esc, plural = C.plural;
  var TZ = (function () { try { return C.cleanTz(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) { return 'UTC'; } })();
  var TABS = [['today', '💧', 'Today'], ['plants', '🪴', 'Plants'], ['add', '+', 'Add'], ['away', '🧳', 'Away'], ['more', '⚙️', 'More']];
  var PHOTO_PX = 1600, DIARY_PX = 1200;
  var BAND_WORDS = { thirsty: 'Thirsty today', check: 'Check soil', soon: 'Coming up', happy: 'Happy' };
  var CONF_WORDS = { high: 'Pretty sure', medium: 'Probably', low: 'A guess' };
  var URG_WORDS = { fine: 'Looks fine', soon: 'Act this week', now: 'Act today' };
  var EV = {
    water: ['💧', 'Watered'], notyet: ['✋', 'Not yet - soil still damp'], fine: ['👍', 'Was fine after a late drink'], mist: ['💦', 'Misted'],
    fert: ['🌱', 'Fed'], snooze: ['😴', 'Snoozed a day'], repot: ['🪴', 'Repotted'], move: ['🚚', 'Moved'], note: ['📝', 'Note'],
  };
  // A little personality: what a plant might say, picked by the day so it
  // changes daily but not on every redraw.
  var QUIPS = {
    thirsty: ['Could murder a glass of water.', 'Parched, frankly.', 'Is it drink o’clock? It’s drink o’clock.', 'Running on fumes over here.', 'A splash would be lovely, thanks.'],
    check: ['Poke my soil - am I dry yet?', 'Might be thirsty. Might not. Check?', 'Finger test, please.'],
    soon: ['Fine for now, thanks.', 'Pencil me in.', 'All good - see you soon.'],
    happy: ['Living my best leaf.', 'Hydrated and thriving.', 'Photosynthesising peacefully.', 'Don’t mind me, just growing.'],
    overwatered: ['Still swimming from last time.', 'Please, no more. I’m drowning in kindness.'],
    repotted: ['New pot, who dis?', 'Settling in. Go easy on the water.'],
    light: ['Could I get a better seat?', 'Bit of a lighting situation here.'],
  };

  var state = {
    me: null,
    view: 'start',          // start | app
    tab: 'today',           // today | plants | add | away | more | plant
    plantId: null,
    source: null,           // demo | mine
    mine: null,             // {settings, plants}
    demo: null,
    add: { step: 'pick', q: '', form: null, nickN: 0 },
    away: { start: null, end: null, note: '', link: null },
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
    toastTimer = setTimeout(function () { t.remove(); }, ms || (buttons && buttons.length ? 7000 : 2800));
  }
  function copyText(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function download(name, type, text) {
    var blob = text instanceof Blob ? text : new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }

  /* ---------------- the jungle ---------------- */

  function today() { return C.localDate(Date.now(), TZ); }
  function isDemo() { return state.source === 'demo'; }
  function home() { return isDemo() ? state.demo : state.mine; }
  function plants() { var h = home(); return h ? h.plants : []; }
  function hemi() { var h = home(); return h && h.settings ? h.settings.hemi : C.hemisphereOf(TZ); }
  function settings() { var h = home(); return (h && h.settings) || C.cleanSettings(null, TZ); }
  function findPlant(id) { return plants().filter(function (p) { return p.id === id; })[0] || null; }
  function nameOf(p) { return p.nick || C.plantName(p); }
  function ctx() { return { today: today(), hemi: hemi() }; }

  function loadMine() {
    var raw = recall(K_HOME);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.plants)) return null;
    var c = { today: today() };
    return { settings: C.cleanSettings(raw.settings, TZ), plants: raw.plants.map(function (p) { return C.cleanPlant(p, c); }).filter(Boolean).slice(0, C.LIMITS.plants) };
  }
  function persist() {
    if (isDemo() || !state.mine) return;
    if (!keep(K_HOME, { v: 1, settings: state.mine.settings, plants: state.mine.plants }) && !state.storageWarned) {
      state.storageWarned = true;
      toast('This browser won’t let Sprout save (private browsing?). Changes last until the tab closes - export a file to keep them.', 6000);
    }
  }
  function ensureMine() {
    if (!state.mine) state.mine = { settings: C.cleanSettings(null, TZ), plants: [] };
    return state.mine;
  }
  function openDemo() {
    state.demo = D.build(today(), C.hemisphereOf(TZ));
    state.source = 'demo';
    go('today');
  }
  function openMine() {
    ensureMine();
    state.source = 'mine';
    if (!state.mine.plants.length) { state.add = { step: 'pick', q: '', form: null, nickN: 0 }; go('add'); } else go('today');
  }
  function replacePlant(np) {
    var h = home();
    h.plants = h.plants.map(function (p) { return p.id === np.id ? np : p; });
  }
  function quip(kind, p) {
    var list = QUIPS[kind] || QUIPS.happy;
    return list[C.hash32(p.id + today()) % list.length];
  }
  function quipFor(p, s) {
    var f = s.flags.map(function (x) { return x.k; });
    if (f.indexOf('overwatered') >= 0) return quip('overwatered', p);
    if (f.indexOf('repotted') >= 0) return quip('repotted', p);
    if (s.band === 'happy' && f.indexOf('light') >= 0) return quip('light', p);
    return quip(s.band, p);
  }

  /* ---------------- actions, with undo ---------------- */

  function doAct(id, kind, opts, from) {
    var p = findPlant(id);
    if (!p) return;
    var r;
    try { r = C.act(p, kind, ctx(), opts); } catch (e) { toast(e.message); return; }
    replacePlant(r.plant);
    persist();
    draw();
    if (kind === 'water' && from) splash(from);
    var buttons = [];
    if (kind === 'water' && r.event.late >= 1) buttons.push({ label: 'It was fine', run: function () { doAct(id, 'fine'); } });
    buttons.push({ label: 'Undo', run: function () { undoLast(id, r.event.id); } });
    var msg = kind === 'water' && r.event.late >= 1 ? 'Watered ' + nameOf(r.plant) + ', ' + plural(r.event.late, 'day') + ' late. Was it fine anyway?' : r.msg;
    toast(msg, 8000, buttons);
  }
  function undoLast(id, eid) {
    var p = findPlant(id);
    if (!p) return;
    try { replacePlant(C.undo(p, eid)); } catch (e) { toast(e.message); return; }
    persist(); draw(); toast('Undone.');
  }
  function splash(btn) {
    var r = btn.getBoundingClientRect();
    var d = document.createElement('div');
    d.className = 'drop'; d.style.left = (r.left + r.width / 2) + 'px'; d.style.top = (r.top + r.height / 2) + 'px';
    for (var i = 0; i < 4; i++) {
      var s = document.createElement('span'); s.textContent = '💧';
      s.style.setProperty('--dx', ((i - 1.5) * 18) + 'px'); s.style.animationDelay = (i * 60) + 'ms';
      d.appendChild(s);
    }
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 1300);
  }

  /* ---------------- routing ---------------- */

  function go(tab, id) {
    if (tab === 'start') { state.view = 'start'; history.pushState(null, '', BASE + '#start'); draw(); scrollTo(0, 0); return; }
    state.view = 'app'; state.tab = tab; state.plantId = id || null;
    history.pushState(null, '', BASE + '#' + tab + (id ? '/' + id : ''));
    draw(); scrollTo(0, 0);
    var m = $('#main'); if (m && tab !== 'add') try { m.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function route() {
    var h = (location.hash || '').replace(/^#/, '');
    if (h === 'example') { history.replaceState(null, '', BASE + '#today'); openDemo(); return; }
    if (!state.source && state.mine && state.mine.plants.length) state.source = 'mine';
    var m = /^plant\/(p[a-z0-9]{6,12})$/.exec(h);
    if (m && state.source && findPlant(m[1])) { state.view = 'app'; state.tab = 'plant'; state.plantId = m[1]; return draw(); }
    if (h === 'add') {
      if (!state.source) { state.source = 'mine'; ensureMine(); }
      state.view = 'app'; state.tab = 'add'; return draw();
    }
    if (state.source && TABS.some(function (t) { return t[0] === h; })) { state.view = 'app'; state.tab = h; return draw(); }
    if (h === 'start' || !state.source) { state.view = 'start'; return draw(); }
    state.view = 'app'; state.tab = 'today'; draw();
  }
  window.addEventListener('popstate', route);

  function draw() {
    closeSheet(true);
    var main = $('#main');
    document.body.classList.toggle('has-tabs', state.view === 'app');
    document.body.classList.toggle('no-tabs', state.view !== 'app');
    if (state.view !== 'app') { main.innerHTML = startHtml() + footer(); return; }
    var thirsty = C.board(plants(), today(), hemi()).thirsty.length;
    var tabOn = state.tab === 'plant' ? 'plants' : state.tab;
    var html = '<nav class="tabbar dk-tabbar" aria-label="Sections"><div class="tabbar-inner"><a class="rail-brand" href="./#start" data-act="home"><span aria-hidden="true">🌱</span>Sprout</a>' + TABS.map(function (t) {
      var on = t[0] === tabOn;
      return '<a class="tab' + (t[0] === 'add' ? ' add' : '') + (on ? ' on' : '') + '" href="#' + t[0] + '" data-act="tab" data-tab="' + t[0] + '"' + (on ? ' aria-current="page"' : '') + '><span aria-hidden="true">' + t[1] + '</span>' + t[2] +
        (t[0] === 'today' && thirsty ? '<em class="badge" aria-label="' + thirsty + ' thirsty">' + thirsty + '</em>' : '') + '</a>';
    }).join('') + '</div></nav>';
    if (isDemo()) html += '<div class="strip"><p><b>The example jungle.</b> Tap away - nothing here is saved.</p><button class="btn small light" type="button" data-act="mine">Start my own</button></div>';
    var body = state.tab === 'today' ? todayHtml() : state.tab === 'plants' ? plantsHtml() : state.tab === 'add' ? addHtml() : state.tab === 'away' ? awayHtml() : state.tab === 'more' ? moreHtml() : plantHtml();
    main.innerHTML = html + body + footer();
    wire();
  }
  function footer() {
    return '<footer class="foot small muted"><p>Your plants live on this phone - no account, nothing uploaded. Care times are guidance, not gospel: every home is different, which is why Sprout learns.</p><p>Part of the <a href="../">Challenge Lab</a>.</p></footer>';
  }
  function wire() {
    var q = $('#addq');
    if (q) {
      q.addEventListener('input', function () { state.add.q = q.value; var r = $('#addResults'); if (r) r.innerHTML = resultsHtml(); });
      if (state.tab === 'add' && state.add.step === 'pick') setTimeout(function () { try { q.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 30);
    }
    if (state.tab === 'plant') drawDiary();
  }

  /* ---------------- first run ---------------- */

  function startHtml() {
    var have = state.mine && state.mine.plants.length;
    return '<section class="hero"><div class="pots" aria-hidden="true"><span class="pot happy">🌵<em class="tag">Happy</em></span><span class="pot thirsty">🪴<em class="tag">Thirsty</em></span><span class="pot happy">🌿<em class="tag">Happy</em></span></div>' +
      '<h1>Know which plants need you today.</h1>' +
      '<p class="lede">Sprout learns how thirsty each of your plants really is - the drowned ones and the forgotten ones - and hands the lot to a plant-sitter in one link when you go away.</p></section>' +
      '<div class="choices">' +
      (have ? '<button class="choice primary" type="button" data-act="mine"><span class="ci" aria-hidden="true">💧</span><span class="ct"><b>My plants</b><span>' + esc(plural(state.mine.plants.length, 'plant')) + ' on this phone</span></span><span class="chev" aria-hidden="true">›</span></button>' : '') +
      '<button class="choice' + (have ? '' : ' primary') + '" type="button" data-act="example"><span class="ci" aria-hidden="true">🌿</span><span class="ct"><b>See an example jungle</b><span>Fourteen plants with real watering histories - some thirsty right now</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      (have ? '' : '<button class="choice" type="button" data-act="mine"><span class="ci" aria-hidden="true">🪴</span><span class="ct"><b>Add my plants</b><span>On this phone. No account, nothing uploaded.</span></span><span class="chev" aria-hidden="true">›</span></button>') +
      '<button class="choice" type="button" data-act="look"><span class="ci" aria-hidden="true">📷</span><span class="ct"><b>What plant is this?</b><span>Snap it - AI names it and spots what’s wrong (free account)</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      '</div>' +
      '<section class="card"><h2>How it works</h2><ol class="steps">' +
      '<li><span class="sn">1</span><span><b>Tell it what you’ve got.</b> Pick from 89 common houseplants and herbs, say where it sits and when you last watered. Sprout warns you if the spot is wrong (“a calathea in direct sun will crisp”).</span></li>' +
      '<li><span class="sn">2</span><span><b>Open it each morning.</b> Thirsty today, check the soil, coming up, happy. Tap <b>Water</b>, or <b>Not yet</b> if the soil’s still damp - and Sprout learns that plant’s real pace, longer in winter.</span></li>' +
      '<li><span class="sn">3</span><span><b>Going away?</b> One link gives your sitter a day-by-day list they can tick off - no app, no account, and the plan never touches a server.</span></li>' +
      '</ol></section>';
  }

  /* ---------------- Today ---------------- */

  function greet() {
    var hr = new Date().getHours();
    var n = settings().name;
    var part = hr < 5 ? 'Up late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    var season = C.seasonName(today(), hemi());
    return part + (n ? ', ' + n : '') + ' · ' + C.dateLabel(today(), today()) + (season ? ' · ' + season : '');
  }
  function todayHtml() {
    var ps = plants(), t = today(), h = hemi();
    if (!ps.length) return emptyHtml();
    var b = C.board(ps, t, h);
    var first = b.thirsty[0] || b.check[0];
    var head = '<section class="card headcard"><p class="greet">' + esc(greet()) + '</p><p class="headline">' + esc(C.headline(ps, t, h)) + '</p>' +
      '<div class="bchips">' + C.BANDS.map(function (bd) {
        var n = b[bd.id].length;
        return n ? '<a class="bchip b-' + bd.id + '" href="#band-' + bd.id + '" data-act="jump" data-band="' + bd.id + '"><span aria-hidden="true">' + bd.icon + '</span><b>' + n + '</b> ' + esc(bd.label.toLowerCase()) + '</a>' : '';
      }).join('') + '</div>' +
      (first ? '<p class="small muted" style="margin:10px 0 0"><i>' + esc(nameOf(first.plant)) + ' says: “' + esc(quipFor(first.plant, first.s)) + '”</i></p>' : '<p class="small muted" style="margin:10px 0 0">😌 Nobody needs you today. Go on, have a cup of tea - Sprout will say when someone’s thirsty.</p>') + '</section>';
    var bands = ['thirsty', 'check', 'soon'].map(function (id) { return bandHtml(id, b[id]); }).join('');
    var anyOther = b.thirsty.length + b.check.length + b.soon.length;
    bands += b.happy.length ? '<details class="band b-happy" id="band-happy"' + (anyOther ? '' : ' open') + '><summary class="bhead"><span class="btag"><span aria-hidden="true">😌</span>Happy · ' + b.happy.length + '</span><span class="small fold-show">Show ›</span><span class="small fold-hide">Hide</span></summary><ul class="plist">' +
      b.happy.map(function (x) { return '<li>' + compactRow(x.plant, x.s) + '</li>'; }).join('') + '</ul></details>' : '';

    var side = '<aside class="side">' + sideCards(b) + '</aside>';
    return '<div class="boardgrid"><div>' + head + bands + '</div>' + side + '</div>';
  }
  function sideCards(b) {
    var season = C.seasonName(today(), hemi());
    var f = season ? C.seasonFactor('foliage', today(), hemi()) : 1;
    var streaks = plants().map(function (p) { return { p: p, st: C.streakOf(p, today(), hemi()) }; }).filter(function (x) { return x.st.current >= 3; }).sort(function (a, c) { return c.st.current - a.st.current; });
    return '<section class="card"><h2>🔥 On-time streaks</h2>' + (streaks.length ? '<ul class="plist">' + streaks.slice(0, 4).map(function (x) {
      return '<li><button class="prow-compact" type="button" data-act="open" data-id="' + esc(x.p.id) + '"><span class="pe" aria-hidden="true">' + esc(C.plantEmoji(x.p)) + '</span><span class="pb"><span class="pname">' + esc(nameOf(x.p)) + '</span><span class="pmeta">' + esc(plural(x.st.current, 'drink')) + ' on time in a row</span></span>' + (x.st.atRisk ? '<span class="dchip b-thirsty">At risk</span>' : '') + '</button></li>';
    }).join('') + '</ul>' : '<p class="small muted">Water on the day (or a day after) to start a streak.</p>') + '</section>' +
      '<section class="card"><h2>' + (season === 'winter' ? '❄️' : season === 'summer' ? '☀️' : season === 'spring' ? '🌷' : season === 'autumn' ? '🍂' : '🌴') + ' ' + (season ? 'It’s ' + esc(season) : 'No seasons') + '</h2><p class="small muted">' +
      (!season ? 'Seasons are off - every interval stays as learned.' : f > 1.05 ? 'Plants grow slower and drink less now: Sprout spaces drinks out by about ' + Math.round((f - 1) * 100) + '% (more for succulents).' : 'Growing season: drinks at their usual pace, and a feed every few weeks.') +
      ' <button class="link-btn" type="button" data-act="tab" data-tab="more">Change</button></p></section>' +
      '<section class="card"><h2>🧳 Going away?</h2><p class="small muted">Make your plant-sitter a day-by-day care sheet in one link.</p><button class="btn small" type="button" data-act="tab" data-tab="away">Plan it</button></section>';
  }
  function emptyHtml() {
    return '<div class="card empty"><div class="big" aria-hidden="true">🪴</div><p><b>No plants yet.</b></p><p class="muted small">Add the first one - it takes ten seconds - and Sprout starts keeping track.</p><button class="btn" type="button" data-act="tab" data-tab="add">Add a plant</button> <button class="btn ghost" type="button" data-act="example">See the example</button></div>';
  }
  function bandHtml(id, list) {
    if (!list.length) return '';
    var bd = C.BANDS.filter(function (x) { return x.id === id; })[0];
    var sub = id === 'thirsty' ? 'Water these today' : id === 'check' ? 'Feel the soil first - water if dry' : 'In the next few days';
    return '<section class="band b-' + id + '" id="band-' + id + '"><div class="bhead"><h2 class="btag"><span aria-hidden="true">' + bd.icon + '</span>' + esc(bd.label) + ' · ' + list.length + '</h2><span class="small">' + sub + '</span></div><ul class="plist">' +
      list.map(function (x) { return '<li>' + cardHtml(x.plant, x.s) + '</li>'; }).join('') + '</ul></section>';
  }
  function metaLine(p) {
    var r = C.room(p.room);
    return C.plantName(p) + ' · ' + r.label;
  }
  function flagsHtml(s) {
    if (!s.flags.length) return '';
    var icon = { overwatered: '🌊', repotted: '🪴', feed: '🌱', light: '☀️' };
    return '<ul class="flags">' + s.flags.map(function (f) { return '<li class="flag ' + esc(f.k) + '"><span class="fi" aria-hidden="true">' + (icon[f.k] || 'ℹ️') + '</span><span>' + esc(f.text) + '</span></li>'; }).join('') + '</ul>';
  }
  function cardHtml(p, s) {
    var c = C.catalogue(p.cat);
    var id = esc(p.id);
    var acts = '<button class="pa water" type="button" data-act="water" data-id="' + id + '"><span aria-hidden="true">💧</span>Water</button>';
    if (s.band !== 'soon') acts += '<button class="pa notyet" type="button" data-act="notyet" data-id="' + id + '" title="The soil is still damp"><span aria-hidden="true">✋</span>Not yet</button>';
    if (c && c.humidity === 'high') acts += '<button class="pa icon" type="button" data-act="mist" data-id="' + id + '" aria-label="Mist ' + esc(nameOf(p)) + '" title="Mist">💦</button>';
    acts += '<button class="pa icon" type="button" data-act="more" data-id="' + id + '" aria-label="More for ' + esc(nameOf(p)) + '" title="More">⋯</button>';
    var soil = s.band === 'check' && c ? '<p class="soilhint"><b>' + esc(C.SOIL[c.soil].short) + ':</b> ' + esc(C.SOIL[c.soil].check) + '</p>' : '';
    return '<div class="pcard b-' + s.band + '"><div class="prow"><button class="pe" type="button" data-act="open" data-id="' + id + '" aria-label="Open ' + esc(nameOf(p)) + '">' + esc(C.plantEmoji(p)) + '</button>' +
      '<button class="pb" type="button" data-act="open" data-id="' + id + '"><span class="pname">' + esc(nameOf(p)) + '</span><span class="pmeta">' + esc(metaLine(p)) + '</span></button>' +
      '<span class="dchip">' + esc(s.chip) + '</span></div>' + soil + flagsHtml(s) + '<div class="pacts">' + acts + '</div></div>';
  }
  function compactRow(p, s) {
    var st = s.streak.current >= 3 ? '<span class="streakchip" title="On-time streak">🔥 ' + s.streak.current + '</span>' : '';
    return '<button class="prow-compact" type="button" data-act="open" data-id="' + esc(p.id) + '"><span class="pe" aria-hidden="true">' + esc(C.plantEmoji(p)) + '</span><span class="pb"><span class="pname">' + esc(nameOf(p)) + '</span><span class="pmeta">' + esc(metaLine(p) + ' · ' + s.chip) + '</span></span>' + st +
      (s.flags.some(function (f) { return f.k === 'overwatered' || f.k === 'light'; }) ? '<span class="dchip b-check" title="Needs a look">!</span>' : '') + '<span class="chev" aria-hidden="true">›</span></button>';
  }

  /* ---------------- Plants ---------------- */

  function plantsHtml() {
    var ps = plants(), t = today(), h = hemi();
    if (!ps.length) return '<h1>Your jungle</h1>' + emptyHtml();
    var rooms = C.ROOMS.filter(function (r) { return ps.some(function (p) { return p.room === r.id; }); });
    return '<div class="sec-head"><h1 style="margin:0">' + (isDemo() ? 'The example jungle' : 'Your jungle') + '</h1><button class="btn small" type="button" data-act="tab" data-tab="add">+ Add a plant</button></div>' +
      '<p class="muted">' + esc(plural(ps.length, 'plant')) + ' in ' + esc(plural(rooms.length, 'room')) + '. Tap one for its care card, history and diary.</p>' +
      rooms.map(function (r) {
        var list = ps.filter(function (p) { return p.room === r.id; }).sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });
        return '<h2 class="roomhead"><span aria-hidden="true">' + r.emoji + '</span>' + esc(r.label) + ' <span class="small">' + list.length + '</span></h2><ul class="plist cols">' +
          list.map(function (p) { return '<li>' + compactRow(p, C.status(p, t, h)) + '</li>'; }).join('') + '</ul>';
      }).join('');
  }

  /* ---------------- a plant ---------------- */

  function plantHtml() {
    var p = findPlant(state.plantId);
    if (!p) return '<div class="card empty"><p>That plant isn’t here any more.</p><button class="btn" type="button" data-act="tab" data-tab="plants">Back to the jungle</button></div>';
    var t = today(), h = hemi();
    var s = C.status(p, t, h);
    var c = C.catalogue(p.cat);
    var id = esc(p.id);
    var nm = esc(nameOf(p));
    var nextBig = s.band === 'thirsty' ? (s.days < 0 ? plural(-s.days, 'day') + ' late' : 'Today') : s.band === 'check' ? (s.days <= 0 ? 'Feel the soil today' : 'Tomorrow - maybe sooner') : s.last === t ? 'Watered today' : C.whenLabel(s.due, t);
    var html = '<p class="back"><button class="link-btn" type="button" data-act="tab" data-tab="plants">‹ The jungle</button></p>' +
      '<div class="phead"><span class="pe" aria-hidden="true">' + esc(C.plantEmoji(p)) + '</span><div><h1>' + nm + '</h1><p class="muted" style="margin:0">' + esc(metaLine(p)) + '</p></div></div>' +
      '<p class="small muted"><i>' + nm + ' says: “' + esc(quipFor(p, s)) + '”</i></p>';
    html += '<div class="twocol"><div>';
    html += '<section class="card b-' + s.band + '"><div class="next"><div><p class="eyebrow">Next drink</p><p class="big" style="margin:0">' + esc(nextBig) + '</p><p class="small muted" style="margin:0">' + esc(BAND_WORDS[s.band]) + ' · every ' + esc(plural(s.every, 'day')) + ' right now' + (s.last ? ' · last ' + esc(C.whenLabel(s.last, t)) : '') + '</p></div>' +
      '<div class="row"><button class="pa water" type="button" data-act="water" data-id="' + id + '"><span aria-hidden="true">💧</span>Water</button><button class="pa notyet" type="button" data-act="notyet" data-id="' + id + '"><span aria-hidden="true">✋</span>Not yet</button><button class="pa icon" type="button" data-act="more" data-id="' + id + '" aria-label="More">⋯</button></div></div>' + flagsHtml(s) + '</section>';
    var drinks = p.events.filter(function (e) { return e.k === 'water' && !e.est; }).length;
    html += '<section class="card"><h2>How ' + nm + ' is doing</h2><div class="stats"><div class="stat"><b>' + (s.streak.current ? '🔥 ' + s.streak.current : '0') + '</b><span>on time in a row' + (s.streak.atRisk ? ' - at risk' : '') + '</span></div><div class="stat"><b>' + s.streak.best + '</b><span>best streak</span></div><div class="stat"><b>' + drinks + '</b><span>' + (drinks === 1 ? 'drink' : 'drinks') + ' logged</span></div></div>' +
      '<p style="margin:12px 0 0">' + esc(C.learnedLine(p, t, h)) + '</p></section>';
    html += careHtml(p, c);
    html += '</div><div>';
    html += '<section class="card"><h2>Things that happen</h2><div class="btns" style="margin-top:4px">' +
      '<button class="btn small ghost" type="button" data-act="repot" data-id="' + id + '">🪴 Repotted</button>' +
      '<button class="btn small ghost" type="button" data-act="move" data-id="' + id + '">🚚 Moved rooms</button>' +
      '<button class="btn small ghost" type="button" data-act="note" data-id="' + id + '">📝 Add a note</button>' +
      '<button class="btn small ghost" type="button" data-act="edit" data-id="' + id + '">✏️ Edit</button></div>' +
      '<div class="btns"><button class="btn small" type="button" data-act="look" data-id="' + id + '">✨ What’s wrong with it?</button></div><p class="small muted" style="margin:6px 0 0">AI looks at one photo - about a cent of credit, free account.</p></section>';
    html += '<section class="card"><div class="row spread"><h2 style="margin:0">Photo diary</h2>' + (isDemo() ? '' : '<label class="btn small ghost" style="cursor:pointer">📷 Add a photo<input class="vh" type="file" accept="image/*" data-file="diary" data-id="' + id + '"></label>') + '</div>' +
      '<div id="diary"><p class="small muted">' + (isDemo() ? 'Photos are for your own plants - they stay on your phone, shrunk, and are never uploaded.' : 'Loading…') + '</p></div></section>';
    html += '<section class="card"><h2>History</h2>' + timelineHtml(p) + '</section>';
    html += '</div></div>';
    return html;
  }
  function careHtml(p, c) {
    if (!c) {
      return '<section class="card"><h2>Care card</h2><p class="muted">' + esc(p.custom ? p.custom.name : 'This plant') + ' isn’t in Sprout’s catalogue, so it starts at every ' + esc(plural(C.baseDays(p), 'day')) + ' and learns from there. Feel the soil before each drink.</p><p class="small muted">Pets: not in Sprout’s list - check the ASPCA plant list if a pet might nibble it.</p></section>';
    }
    var spot = C.LIGHTS[p.light];
    var warn = C.lightWarning(c, p.light, p.nick);
    var pets = C.PETS[c.pets];
    return '<section class="card"><h2>' + esc(c.emoji) + ' ' + esc(c.name) + ' care card</h2><div class="facts">' +
      '<div class="fact"><b>Light it likes</b><span>' + esc(C.LIGHTS[c.light.ideal].label) + '</span></div>' +
      '<div class="fact"><b>Where it sits</b><span>' + esc(spot.label) + (warn ? ' ⚠️' : ' ✓') + '</span></div>' +
      (warn ? '<div class="fact wide"><span class="small">' + esc(warn.text) + '</span></div>' : '') +
      '<div class="fact"><b>Water</b><span>' + esc(C.SOIL[c.soil].short) + '</span></div>' +
      '<div class="fact"><b>Humidity</b><span>' + esc(C.HUMIDITY[c.humidity]) + '</span></div>' +
      '<div class="fact wide"><b>Before every drink</b><span>' + esc(C.SOIL[c.soil].check) + '</span></div>' +
      '<div class="fact wide"><b>How much</b><span>' + esc(C.amountFor(p.pot, p.drain, c)) + '</span></div>' +
      '<div class="fact wide ' + esc(c.pets) + '"><b>Pets</b><span>' + esc(pets.line) + '</span></div>' +
      '<div class="fact wide"><b>Tip</b><span>' + esc(c.tip) + '</span></div>' +
      '<div class="fact wide"><b>The classic mistake</b><span>' + esc(c.mistake) + '</span></div>' +
      '</div><p class="small muted" style="margin:10px 0 0">Guidance, not gospel: every home is different, which is why Sprout learns ' + esc(nameOf(p)) + '’s own pace.</p></section>';
  }
  function timelineHtml(p) {
    var t = today();
    var evs = p.events.slice().reverse();
    if (!evs.length) return '<p class="small muted">Nothing yet. Water, “Not yet”, notes and repots show up here.</p>';
    var shown = evs.slice(0, 40);
    return '<ul class="timeline">' + shown.map(function (e) {
      var m = EV[e.k] || ['•', e.k];
      var label = m[1];
      if (e.k === 'water' && e.est) label = 'Watered (roughly - from when it was added)';
      else if (e.k === 'water' && e.late) label = 'Watered, ' + plural(e.late, 'day') + ' late';
      return '<li><span class="ti" aria-hidden="true">' + m[0] + '</span><span class="tb"><b>' + esc(label) + '</b>' + (e.note ? '<br><span class="small">' + esc(e.note) + '</span>' : '') + '</span><span class="tw">' + esc(C.whenLabel(e.d, t)) + '</span></li>';
    }).join('') + '</ul>' + (evs.length > shown.length ? '<p class="small muted">And ' + (evs.length - shown.length) + ' older.</p>' : '');
  }

  /* ---------------- the photo diary (IndexedDB, this browser only) ---------------- */

  var idb = (function () {
    var dbp = null;
    function req2p(r) { return new Promise(function (res, rej) { r.addEventListener('success', function () { res(r.result); }); r.addEventListener('error', function () { rej(r.error); }); }); }
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (res, rej) {
        try {
          var r = indexedDB.open('sprout-diary', 1);
          r.addEventListener('upgradeneeded', function () { var s = r.result.createObjectStore('photos', { keyPath: 'id' }); s.createIndex('plant', 'plant'); });
          r.addEventListener('success', function () { res(r.result); });
          r.addEventListener('error', function () { rej(r.error); });
          r.addEventListener('blocked', function () { rej(new Error('blocked')); });
        } catch (e) { rej(e); }
      });
      dbp.catch(function () { dbp = null; });
      return dbp;
    }
    function store(mode) { return open().then(function (db) { return db.transaction('photos', mode).objectStore('photos'); }); }
    return {
      put: function (rec) { return store('readwrite').then(function (s) { return req2p(s.put(rec)); }); },
      list: function (plant) { return store('readonly').then(function (s) { return req2p(s.index('plant').getAll(plant)); }); },
      get: function (id) { return store('readonly').then(function (s) { return req2p(s.get(id)); }); },
      del: function (id) { return store('readwrite').then(function (s) { return req2p(s.delete(id)); }); },
      clear: function () { return store('readwrite').then(function (s) { return req2p(s.clear()); }); },
    };
  }());
  var diaryUrls = [];
  function drawDiary() {
    var box = $('#diary');
    if (!box || isDemo()) return;
    var id = state.plantId;
    diaryUrls.forEach(function (u) { URL.revokeObjectURL(u); }); diaryUrls = [];
    idb.list(id).then(function (rows) {
      if (state.plantId !== id || !$('#diary')) return;
      rows = (rows || []).sort(function (a, b) { return a.at < b.at ? 1 : -1; });
      if (!rows.length) { box.innerHTML = '<p class="small muted">No photos yet. Add one now and then - in a few months you’ll see how much it’s grown. Photos stay on this phone, shrunk, and are never uploaded.</p>'; return; }
      box.innerHTML = '<div class="diary">' + rows.map(function (r) {
        var u = URL.createObjectURL(r.blob); diaryUrls.push(u);
        return '<button type="button" data-act="photo" data-pid="' + esc(r.id) + '" aria-label="Photo from ' + esc(C.dateLabel(r.date, today())) + '"><img src="' + esc(u) + '" alt=""><span class="dd">' + esc(C.dateLabel(r.date, today())) + '</span></button>';
      }).join('') + '</div><p class="small muted">On this phone only - not in exports, never uploaded.</p>';
    }).catch(function () { box.innerHTML = '<p class="small muted">This browser won’t keep photos (private browsing, or storage is off). Everything else still works.</p>'; });
  }
  function addDiaryPhoto(plantId, blob, note) {
    var rec = { id: 'ph' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), plant: plantId, date: today(), at: Date.now(), blob: blob, note: C.clean(note || '', 300) };
    return idb.put(rec);
  }
  function openPhoto(pid) {
    idb.get(pid).then(function (r) {
      if (!r) return;
      var u = URL.createObjectURL(r.blob);
      sheet('<h2>' + esc(C.dateLabel(r.date, today())) + '</h2><img class="photo-full" src="' + esc(u) + '" alt="A diary photo">' + (r.note ? '<p class="note small">' + esc(r.note) + '</p>' : '') +
        '<div class="btns"><button class="btn ghost danger" type="button" id="delPhoto">Delete this photo</button></div>', function (root) {
        $('#delPhoto', root).addEventListener('click', function () { idb.del(pid).then(function () { closeSheet(); drawDiary(); toast('Photo deleted.'); }); });
      });
    });
  }

  /** A photo shrunk on this phone: redrawn through a canvas (which also drops
   *  its location data) as a JPEG no bigger than `px` on its long side. */
  function shrink(file, px, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener('load', function () {
        var k = Math.min(1, px / Math.max(img.naturalWidth, img.naturalHeight));
        var cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.naturalWidth * k)); cv.height = Math.max(1, Math.round(img.naturalHeight * k));
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

  /* ---------------- sheets for one plant ---------------- */

  function moreSheet(id) {
    var p = findPlant(id); if (!p) return;
    var s = C.status(p, today(), hemi());
    var feed = s.flags.some(function (f) { return f.k === 'feed'; });
    sheet('<h2>' + esc(C.plantEmoji(p)) + ' ' + esc(nameOf(p)) + '</h2><ul class="menu">' +
      '<li><button type="button" data-act="mist" data-id="' + esc(id) + '"><span class="mi" aria-hidden="true">💦</span><span>Misted<small>For the humidity lovers - no change to watering</small></span></button></li>' +
      '<li><button type="button" data-act="fert" data-id="' + esc(id) + '"><span class="mi" aria-hidden="true">🌱</span><span>Fed it' + (feed ? ' · due' : '') + '<small>Houseplant feed, half strength, in the growing season</small></span></button></li>' +
      '<li><button type="button" data-act="snooze" data-id="' + esc(id) + '"><span class="mi" aria-hidden="true">😴</span><span>Snooze until tomorrow<small>Ask again tomorrow - no learning</small></span></button></li>' +
      '<li><button type="button" data-act="note" data-id="' + esc(id) + '"><span class="mi" aria-hidden="true">📝</span><span>Add a note</span></button></li>' +
      '<li><button type="button" data-act="open" data-id="' + esc(id) + '"><span class="mi" aria-hidden="true">›</span><span>Open ' + esc(nameOf(p)) + '’s page<small>Care card, history, photo diary</small></span></button></li>' +
      '</ul>');
  }
  function noteSheet(id) {
    var p = findPlant(id); if (!p) return;
    sheet('<h2>📝 A note on ' + esc(nameOf(p)) + '</h2><form id="noteForm"><label class="field"><span>Note</span><textarea class="input" name="note" maxlength="' + C.LIMITS.note + '" placeholder="New leaf! Turned it towards the window." required></textarea></label><button class="btn block" type="submit">Add the note</button></form>', function (root) {
      $('#noteForm', root).addEventListener('submit', function (e) { e.preventDefault(); var v = e.target.note.value; closeSheet(true); doAct(id, 'note', { note: v }); });
    });
  }
  function segHtml(name, options, value) {
    return '<div class="seg" role="radiogroup" data-seg="' + name + '">' + options.map(function (o) {
      var on = String(o[0]) === String(value);
      return '<button type="button" class="segb" role="radio" aria-checked="' + on + '" data-act="seg" data-k="' + name + '" data-v="' + esc(o[0]) + '">' + o[1] + (o[2] ? '<small>' + esc(o[2]) + '</small>' : '') + '</button>';
    }).join('') + '</div>';
  }
  var ROOM_OPTS = function () { return C.ROOMS.map(function (r) { return [r.id, '<span aria-hidden="true">' + r.emoji + '</span> ' + esc(r.label)]; }); };
  var LIGHT_OPTS = function () { return C.LIGHTS.map(function (l) { return [l.id, esc(l.label), l.hint]; }); };
  var POT_OPTS = function () { return [['s', 'Small', 'up to 12 cm'], ['m', 'Medium', '13-20 cm'], ['l', 'Large', 'over 20 cm']]; };
  /** The segmented control: update the form, flip aria-checked in place. */
  function segPick(btn, form) {
    var k = btn.getAttribute('data-k'), v = btn.getAttribute('data-v');
    var group = btn.closest('.seg');
    $$('.segb', group).forEach(function (b) { b.setAttribute('aria-checked', String(b === btn)); });
    if (k === 'light') v = Number(v);
    if (k === 'drain') v = v === '1';
    form[k] = v;
    return k;
  }
  function moveSheet(id) {
    var p = findPlant(id); if (!p) return;
    var f = { room: p.room, light: p.light };
    sheet('<h2>🚚 Where is ' + esc(nameOf(p)) + ' now?</h2><fieldset class="field"><legend>Room</legend>' + segHtml('room', ROOM_OPTS(), f.room) + '</fieldset><fieldset class="field"><legend>Light where it sits</legend>' + segHtml('light', LIGHT_OPTS(), f.light).replace('class="seg"', 'class="seg lights"') + '</fieldset><div id="mvWarn" aria-live="polite"></div><button class="btn block" type="button" id="mvGo">Save the move</button>', function (root) {
      function warn() { var w = C.lightWarning(C.catalogue(p.cat), f.light, p.nick); $('#mvWarn', root).innerHTML = w ? '<p class="warnbox"><span aria-hidden="true">⚠️</span><span>' + esc(w.text) + '</span></p>' : ''; }
      warn();
      root.addEventListener('click', function (e) { var b = e.target.closest('[data-act=seg]'); if (b && root.contains(b)) { e.stopPropagation(); segPick(b, f); warn(); } });
      $('#mvGo', root).addEventListener('click', function () { closeSheet(true); doAct(id, 'move', { room: f.room, light: f.light }); });
    });
  }
  function repotSheet(id) {
    var p = findPlant(id); if (!p) return;
    var f = { pot: p.pot };
    sheet('<h2>🪴 Repotted ' + esc(nameOf(p)) + '</h2><p class="small muted">Sprout will hold off the feed for a month and remind you to water lightly while the roots settle.</p><fieldset class="field"><legend>New pot size</legend>' + segHtml('pot', POT_OPTS(), f.pot) + '</fieldset><label class="field"><span>Note (optional)</span><input class="input" id="rpNote" maxlength="' + C.LIMITS.note + '" placeholder="Up a size, fresh compost"></label><button class="btn block" type="button" id="rpGo">Save</button>', function (root) {
      root.addEventListener('click', function (e) { var b = e.target.closest('[data-act=seg]'); if (b && root.contains(b)) { e.stopPropagation(); segPick(b, f); } });
      $('#rpGo', root).addEventListener('click', function () { var n = $('#rpNote', root).value; closeSheet(true); doAct(id, 'repot', { pot: f.pot, note: n }); });
    });
  }
  function editSheet(id) {
    var p = findPlant(id); if (!p) return;
    var f = { pot: p.pot, drain: p.drain };
    sheet('<h2>✏️ Edit ' + esc(nameOf(p)) + '</h2><label class="field"><span>Nickname</span><input class="input" id="edNick" maxlength="' + C.LIMITS.nick + '" value="' + esc(p.nick) + '"></label>' +
      '<fieldset class="field"><legend>Pot</legend>' + segHtml('pot', POT_OPTS(), f.pot) + '</fieldset><fieldset class="field"><legend>Drainage hole</legend>' + segHtml('drain', [['1', 'Yes, it drains'], ['0', 'No hole']], f.drain ? '1' : '0') + '</fieldset>' +
      '<button class="btn block" type="button" id="edGo">Save</button><div class="btns"><button class="link-btn danger" type="button" id="edDel">Remove ' + esc(nameOf(p)) + ' from the jungle' + (isDemo() ? '' : ' (and its diary photos)') + '</button></div>', function (root) {
      root.addEventListener('click', function (e) { var b = e.target.closest('[data-act=seg]'); if (b && root.contains(b)) { e.stopPropagation(); segPick(b, f); } });
      $('#edGo', root).addEventListener('click', function () {
        var np = C.cleanPlant(Object.assign({}, p, { nick: $('#edNick', root).value, pot: f.pot, drain: f.drain }), { today: today() });
        replacePlant(np); persist(); closeSheet(); draw(); toast('Saved.');
      });
      $('#edDel', root).addEventListener('click', function () {
        var h = home(); var before = h.plants.slice();
        h.plants = h.plants.filter(function (x) { return x.id !== id; });
        if (!isDemo()) idb.list(id).then(function (rows) { (rows || []).forEach(function (r) { idb.del(r.id); }); }).catch(function () { /* nothing kept */ });
        persist(); closeSheet(); go('plants');
        toast(nameOf(p) + ' removed.', 8000, [{ label: 'Undo', run: function () { home().plants = before; persist(); draw(); } }]);
      });
    });
  }

  /* ---------------- Add ---------------- */

  function newForm(catId, custom) {
    var taken = plants().map(function (p) { return p.nick; });
    var c = C.catalogue(catId);
    return { cat: c ? c.id : null, custom: custom || null, nick: C.suggestNick(c ? c.id : null, taken, state.add.nickN), room: 'living', light: c ? c.light.ideal : 1, pot: 'm', drain: true, lastWatered: 'few' };
  }
  function addHtml() {
    var a = state.add;
    var demoNote = isDemo() ? '<p class="guide"><span aria-hidden="true">💡</span><span>You’re looking at the example jungle. A plant you add here starts <b>your own</b> jungle on this phone.</span></p>' : '';
    if (a.step === 'form' && a.form) return demoNote + formHtml(a.form);
    if (a.step === 'custom') return demoNote + customHtml();
    var first = !isDemo() && !plants().length;
    return demoNote + '<h1>' + (first ? 'Add your first plant' : 'Add a plant') + '</h1>' + (first ? '<p class="muted">Start with whichever one worries you most. You can add the rest any time.</p>' : '') +
      '<div class="searchbox"><span class="sicon" aria-hidden="true">🔎</span><label class="vh" for="addq">Search the catalogue</label><input class="input" id="addq" type="search" autocomplete="off" placeholder="Monstera, snake plant, basil…" value="' + esc(a.q) + '"></div>' +
      '<div id="addResults">' + resultsHtml() + '</div>' +
      '<div class="btns"><button class="btn small ghost" type="button" data-act="custom">Not in the list? Add it by name</button><button class="btn small ghost" type="button" data-act="look">✨ Not sure what it is? Ask AI</button></div>';
  }
  function resultsHtml() {
    var q = state.add.q;
    if (!C.clean(q, 40)) {
      return '<h2 class="sec-head" style="margin-top:18px">Popular</h2><div class="grid">' + C.search('', 24).map(function (c) {
        return '<button class="tile" type="button" data-act="pick" data-cat="' + esc(c.id) + '"><span class="te" aria-hidden="true">' + esc(c.emoji) + '</span>' + esc(c.name) + '</button>';
      }).join('') + '</div>';
    }
    var r = C.search(q, 12);
    if (!r.length) return '<p class="muted" style="margin-top:12px">Nothing called that in the catalogue. <button class="link-btn" type="button" data-act="custom">Add “' + esc(C.clean(q, 40)) + '” by name</button></p>';
    return '<ul class="results">' + r.map(function (c) {
      return '<li><button class="res" type="button" data-act="pick" data-cat="' + esc(c.id) + '"><span class="pe" aria-hidden="true">' + esc(c.emoji) + '</span><span class="rb"><b>' + esc(c.name) + '</b><span>' + esc(C.LIGHTS[c.light.ideal].label) + ' · water when ' + esc(C.SOIL[c.soil].short.toLowerCase()) + ' · ' + esc(C.PETS[c.pets].short) + '</span></span><span class="plus" aria-hidden="true">+</span></button></li>';
    }).join('') + '</ul>';
  }
  function lightNote(f) {
    var c = C.catalogue(f.cat);
    if (!c) return '';
    var w = C.lightWarning(c, f.light, f.nick);
    return w ? '<p class="warnbox"><span aria-hidden="true">⚠️</span><span>' + esc(w.text) + '</span></p>' : '<p class="okbox">✓ Good spot for a ' + esc(c.name.toLowerCase()) + '.</p>';
  }
  function formHtml(f) {
    var c = C.catalogue(f.cat);
    var name = c ? c.name : f.custom.name;
    var emoji = c ? c.emoji : f.custom.emoji;
    return '<div class="picked"><span class="pe" aria-hidden="true">' + esc(emoji) + '</span><div style="flex:1;min-width:0"><p class="eyebrow">Adding</p><h1 style="margin:0">' + esc(name) + '</h1></div><button class="btn small ghost" type="button" data-act="addback">Change</button></div>' +
      (c ? '<p class="small muted">' + esc(c.tip) + '</p>' : '') +
      '<form id="addForm">' +
      '<label class="field"><span>Nickname</span><span class="nickrow"><input class="input" id="nick" maxlength="' + C.LIMITS.nick + '" value="' + esc(f.nick) + '" autocomplete="off"><button class="btn ghost" type="button" data-act="dice" aria-label="Suggest another name">🎲</button></span></label>' +
      '<fieldset class="field"><legend>Room</legend>' + segHtml('room', ROOM_OPTS(), f.room) + '</fieldset>' +
      '<fieldset class="field"><legend>Light where it sits</legend>' + segHtml('light', LIGHT_OPTS(), f.light).replace('class="seg"', 'class="seg lights"') + '<div id="lightWarn" aria-live="polite">' + lightNote(f) + '</div></fieldset>' +
      '<fieldset class="field"><legend>Pot</legend>' + segHtml('pot', POT_OPTS(), f.pot) + '</fieldset>' +
      '<fieldset class="field"><legend>Drainage hole in the pot?</legend>' + segHtml('drain', [['1', 'Yes'], ['0', 'No hole']], f.drain ? '1' : '0') + '</fieldset>' +
      '<fieldset class="field"><legend>Last watered</legend>' + segHtml('lastWatered', [['today', 'Today'], ['few', 'A few days ago'], ['week', 'A week or more'], ['unknown', 'Not sure']], f.lastWatered) + '</fieldset>' +
      '<button class="btn block big" type="submit">Add ' + esc(f.nick || name) + ' to the jungle</button></form>';
  }
  function customHtml() {
    var f = state.add.custom || { name: C.clean(state.add.q, 40), emoji: '🪴', pace: 'average' };
    state.add.custom = f;
    var EMO = ['🪴', '🌿', '🌱', '🍃', '🌵', '🌸', '🌺', '🌼', '🌳', '🌴', '🍀', '🌾'];
    return '<p class="back"><button class="link-btn" type="button" data-act="addback">‹ Back to the catalogue</button></p><h1>Add it by name</h1><p class="muted">Sprout doesn’t have care notes for it, so it starts from how thirsty you think it is and learns from your “Not yet”s.</p>' +
      '<form id="customForm"><label class="field"><span>What is it?</span><input class="input" id="cName" maxlength="40" value="' + esc(f.name) + '" placeholder="Pink polka dot begonia" required></label>' +
      '<fieldset class="field"><legend>Pick an emoji</legend>' + segHtml('emoji', EMO.map(function (e) { return [e, e]; }), f.emoji) + '</fieldset>' +
      '<fieldset class="field"><legend>How thirsty?</legend>' + segHtml('pace', [['thirsty', 'Thirsty', 'every ~4 days'], ['average', 'Average', 'about weekly'], ['tough', 'Tough', 'every ~2 weeks']], f.pace) + '</fieldset>' +
      '<button class="btn block" type="submit">Next</button></form>';
  }

  /* ---------------- Away: the plant-sitter link ---------------- */

  function awayDefaults() {
    var a = state.away, t = today();
    if (!a.start || a.start < t) a.start = C.addDays(t, 1);
    if (!a.end || a.end < a.start) a.end = C.addDays(a.start, 6);
    return a;
  }
  function plan() {
    var a = awayDefaults();
    return C.sitPlan(plants(), { today: today(), hemi: hemi(), start: a.start, end: a.end, from: settings().name, note: a.note });
  }
  function awayHtml() {
    var a = awayDefaults(), t = today();
    if (!plants().length) return '<h1>Going away?</h1>' + emptyHtml();
    var html = '<h1>Going away? 🧳</h1><p class="muted">Sprout builds a care sheet for whoever waters your plants: which ones, on which day, how much, and which to leave alone. One link - no app or account for them.</p>';
    html += '<div class="twocol"><div><section class="card"><h2>Your trip</h2><div class="dates"><label class="field"><span>Leaving</span><input class="input" type="date" id="awStart" data-change="away" min="' + esc(t) + '" value="' + esc(a.start) + '"></label><label class="field"><span>Back</span><input class="input" type="date" id="awEnd" data-change="away" min="' + esc(t) + '" value="' + esc(a.end) + '"></label></div>' +
      '<label class="field"><span>Your name, so they know whose plants</span><input class="input" id="awName" data-change="name" maxlength="' + C.LIMITS.sitFrom + '" value="' + esc(settings().name) + '" placeholder="Sam"></label>' +
      '<label class="field"><span>A note for them (optional)</span><textarea class="input" id="awNote" data-change="awaynote" maxlength="' + C.LIMITS.sitHomeNote + '" placeholder="The watering can lives under the sink. Spare key’s with Ana at number 12.">' + esc(a.note) + '</textarea></label>' +
      '<p class="small muted">Up to ' + C.LIMITS.sitDays + ' days and ' + C.LIMITS.sitPlants + ' plants in one link.</p></section></div><div id="awPreview">' + awayPreview() + '</div></div>';
    return html;
  }
  function awayPreview() {
    var pl = plan(), t = today();
    var sit = C.cleanSit(pl.sit);
    if (!sit) return '';
    var dd = C.sitDays(sit);
    var drinks = dd.days.reduce(function (n, d) { return n + d.plants.length; }, 0);
    var busy = dd.days.filter(function (d) { return d.plants.length; });
    var html = '<section class="card"><h2>The plan</h2>';
    if (pl.cut) html += '<p class="warnbox">One link covers ' + C.LIMITS.sitDays + ' days at most - the plan stops on ' + esc(C.dateLabel(pl.end, t)) + '.</p>';
    if (pl.left) html += '<p class="warnbox">' + esc(plural(pl.left, 'plant')) + ' didn’t fit - a link carries ' + C.LIMITS.sitPlants + ' at most.</p>';
    if (pl.before.length) html += '<h3>Before you go</h3><ul class="daylist">' + pl.before.map(function (b) { return '<li><span class="dl">' + esc(C.plantEmoji(b.plant) + ' ' + nameOf(b.plant)) + '</span><span class="dn">' + esc(b.dates.map(function (d) { return C.whenLabel(d, t); }).join(', ')) + '</span></li>'; }).join('') + '</ul>';
    html += '<h3>While you’re away</h3><p>' + esc(plural(drinks, 'drink')) + ' over ' + esc(plural(busy.length, 'day')) + ' for your sitter' + (dd.leave.length ? '; ' + esc(plural(dd.leave.length, 'plant')) + ' need nothing at all.' : '.') + '</p>';
    html += busy.length ? '<ul class="daylist">' + busy.slice(0, 14).map(function (d) { return '<li><span class="dl">' + esc(C.dateLabel(d.date, t)) + '</span><span class="dn">' + esc(C.nameList(d.plants.map(function (x) { return x.p.nick; }))) + '</span></li>'; }).join('') + '</ul>' + (busy.length > 14 ? '<p class="small muted">…and ' + (busy.length - 14) + ' more days.</p>' : '') : '<p class="okbox">Nothing needs water while you’re away - no sitter needed.</p>';
    if (dd.leave.length) html += '<p class="small muted" style="margin-top:10px">Leave alone: ' + esc(C.nameList(dd.leave.map(function (x) { return x.p.nick; }))) + '.</p>';
    html += '<div class="btns"><button class="btn" type="button" data-act="mklink">Make the sitter link</button></div><div id="awLink">' + (state.away.link ? linkHtml(state.away.link) : '') + '</div>';
    html += '<p class="small muted" style="margin-top:12px">🔒 The whole plan travels inside the link, after the “#”. Browsers never send that part to a server, so Sprout never sees or stores it. Anyone with the link can read it - send it to your sitter only.</p></section>';
    return html;
  }
  function linkHtml(url) {
    return '<p class="linkbox" id="linkText">' + esc(url) + '</p><div class="btns">' + (navigator.share ? '<button class="btn small" type="button" data-act="sharelink">Share</button>' : '') +
      '<button class="btn small ghost" type="button" data-act="copylink">Copy</button><a class="btn small ghost" href="' + esc(url) + '" target="_blank" rel="noopener">Open the sitter’s view</a></div><p class="small muted">The sitter’s view has a Print button for the fridge door.</p>';
  }
  function makeLink() {
    var pl = plan();
    var btn = $('[data-act=mklink]');
    if (btn) { btn.disabled = true; btn.textContent = 'Packing it up…'; }
    C.encodeSit(pl.sit).then(function (frag) {
      var url = location.origin + BASE + 'sit#' + frag;
      state.away.link = url;
      var box = $('#awLink'); if (box) box.innerHTML = linkHtml(url);
      if (btn) { btn.disabled = false; btn.textContent = 'Make it again'; }
    }).catch(function () { if (btn) { btn.disabled = false; btn.textContent = 'Make the sitter link'; } toast('Could not make the link in this browser.'); });
  }

  /* ---------------- More ---------------- */

  function moreHtml() {
    var s = settings();
    var hemiVal = s.hemiAuto ? 'auto' : s.hemi;
    var guess = C.hemisphereOf(TZ);
    var season = C.seasonName(today(), hemi());
    var html = '<h1>More</h1><div class="twocol"><div>';
    html += '<section class="card"><h2>🌍 Seasons</h2><p class="small muted">Plants drink less in winter. Sprout spaces drinks out from autumn and brings them back in spring - for your half of the world.</p>' +
      segHtml('hemi', [['auto', 'Automatic', (guess === 'south' ? 'Southern' : 'Northern') + ', from your time zone'], ['north', 'Northern'], ['south', 'Southern'], ['off', 'No seasons', 'tropics']], hemiVal) +
      '<p class="small" style="margin:10px 0 0">' + (season ? 'It’s ' + esc(season) + ' for your plants right now.' : 'Seasons are off: intervals stay as learned all year.') + '</p></section>';
    html += '<section class="card"><h2>📅 Watering days in your calendar</h2><p class="small muted">Sprout can’t send reminders - but your calendar can. This makes a calendar file of the next four weeks of watering days, on this phone. Re-download after big changes: it’s a snapshot, not a live feed.</p><button class="btn" type="button" data-act="ics">Add watering days to my calendar</button></section>';
    html += '<section class="card"><h2>✨ What plant is this?</h2><p class="small muted">Snap a plant (yours, a friend’s, one at the garden centre): AI names it and spots what’s wrong. Pet safety comes from Sprout’s own list, never the AI. About a cent of AI credit; a free account comes with $2.</p><button class="btn" type="button" data-act="look">Look at a photo</button></section>';
    html += '</div><div>';
    html += '<section class="card"><h2>📦 Moving phones</h2><p class="small muted">Your jungle lives on this phone only. Export it to a file and import it on the new one. Diary photos stay behind - they’re kept in this browser, not in the file.</p><div class="btns"><button class="btn ghost" type="button" data-act="export"' + (plants().length ? '' : ' disabled') + '>Export my plants</button><label class="btn ghost" style="cursor:pointer">Import a file<input class="vh" type="file" accept="application/json,.json" data-file="import"></label></div></section>';
    html += '<section class="card"><h2>👤 Account</h2>' + (signedIn() ? '<p class="small muted">Signed in as ' + esc(state.me.email) + '. Only the AI photo look uses it.</p><button class="btn ghost" type="button" data-act="account">Account and credit</button>' : '<p class="small muted">Nothing in Sprout needs an account except the AI photo look. One free account works across every app on this site.</p><button class="btn ghost" type="button" data-act="signin">Sign in or create one</button>') + '</section>';
    html += '<section class="card"><h2>🔒 Where your plants live</h2><p class="small muted">On this phone: the list in this browser’s storage, diary photos in its photo store. Nothing about your plants is sent to Sprout’s server - except a photo you choose to show the AI, which is read once and never kept. Sitter links carry their plan after the “#”, which never reaches a server.</p>' +
      (isDemo() ? '<button class="btn ghost" type="button" data-act="mine">Leave the example</button>' : (plants().length ? '<button class="link-btn danger" type="button" data-act="wipe">Delete all my plants from this phone</button>' : '')) + '</section>';
    html += '</div></div>';
    return html;
  }
  function setHemi(v) {
    var h = home(); if (!h) { ensureMine(); h = state.mine; }
    h.settings = v === 'auto' ? { hemi: C.hemisphereOf(TZ), hemiAuto: true, name: h.settings.name } : { hemi: v, hemiAuto: false, name: h.settings.name };
    persist(); draw();
    toast(v === 'off' ? 'Seasons off.' : 'Seasons: ' + (h.settings.hemi === 'south' ? 'southern' : 'northern') + ' hemisphere.');
  }
  function importFile(file) {
    if (!file) return;
    if (file.size > C.LIMITS.importBytes) { toast('That file is too big to be a Sprout export.', 4000); return; }
    var r = new FileReader();
    r.addEventListener('load', function () {
      var got;
      try { got = C.importHome(String(r.result), { today: today(), tz: TZ }); } catch (e) { toast(e.message || 'That file isn’t a Sprout export.', 4500); return; }
      var have = state.mine ? state.mine.plants.length : 0;
      sheet('<h2>Import ' + esc(plural(got.plants.length, 'plant')) + '?</h2><p class="muted">' + (have ? 'This replaces the ' + esc(plural(have, 'plant')) + ' on this phone.' : 'They’ll become your jungle on this phone.') + (got.dropped ? ' ' + esc(plural(got.dropped, 'entry')) + ' in the file couldn’t be read and will be skipped.' : '') + '</p>' +
        '<div class="btns"><button class="btn" type="button" id="impGo">Import</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div>', function (root) {
        $('#impGo', root).addEventListener('click', function () {
          state.mine = { settings: got.settings, plants: got.plants };
          state.source = 'mine'; persist(); closeSheet(); go('today'); toast('Imported ' + plural(got.plants.length, 'plant') + '.');
        });
      });
    });
    r.readAsText(file);
  }

  /* ---------------- the one AI call ---------------- */

  function openLook(plantId) {
    var p = plantId ? findPlant(plantId) : null;
    var title = p ? '✨ What’s wrong with ' + esc(nameOf(p)) + '?' : '✨ What plant is this?';
    if (!signedIn()) {
      sheet('<h2>' + title + '</h2><p>Take a photo and AI names the plant, says how sure it is, and spots what looks wrong - with the likely cause and a fix.</p>' +
        '<div class="note"><p><b>It uses about a cent of AI credit, so it needs a free account</b> (it comes with $2). Everything else in Sprout is free and needs no account.</p><p class="small muted" style="margin:0">The photo is shrunk on your phone, read once, and never stored.</p></div>' +
        '<div class="btns"><button class="btn" type="button" id="lkSign">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button></div>', function (root) {
        $('#lkSign', root).addEventListener('click', function () { openAccount('A free account comes with $2 of AI credit - about 200 photo looks. Nothing else in Sprout needs one.', function () { openLook(plantId); }); });
      });
      return;
    }
    var look = { blob: null, url: null };
    sheet('<h2>' + title + '</h2><p class="small muted">Fill the photo with the plant, in daylight. ' + (p ? 'Show the leaves that worry you.' : '') + ' Shrunk on your phone, read once by the AI, never stored.</p>' +
      '<label class="btn block" style="cursor:pointer">📷 Take or choose a photo<input class="vh" type="file" accept="image/*" id="lkFile"></label><div id="lkPrev"></div><div id="lkErr"></div><div id="lkOut"></div>', function (root) {
      $('#lkFile', root).addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        $('#lkErr', root).innerHTML = ''; $('#lkOut', root).innerHTML = '';
        shrink(f, PHOTO_PX, 0.85).then(function (blob) {
          if (look.url) URL.revokeObjectURL(look.url);
          look.blob = blob; look.url = URL.createObjectURL(blob);
          $('#lkPrev', root).innerHTML = '<img class="preview" src="' + esc(look.url) + '" alt="Your photo"><div class="btns"><button class="btn" type="button" id="lkSend">Look at it</button></div><p class="small muted">About a cent of AI credit.</p>';
          $('#lkSend', root).addEventListener('click', function (ev) {
            var btn = ev.currentTarget;
            btn.disabled = true; btn.textContent = 'Looking…';
            blobToBase64(blob).then(function (data) {
              return api('POST', 'api/look', { photo: { type: 'image/jpeg', data: data }, hint: p ? p.cat : null });
            }).then(function (r) {
              btn.hidden = true;
              lookResult($('#lkOut', root), C.cleanLook(r.result), p, blob);
              loadMe();
            }).catch(function (err) { btn.disabled = false; btn.textContent = 'Look at it'; meteredError(err, $('#lkErr', root), function () { openLook(plantId); }); });
          });
        }).catch(function (err) { showError(err, $('#lkErr', root)); });
      });
    });
  }
  function lookResult(box, r, p, blob) {
    var c = C.catalogue(r.identification.catalogueId);
    var idf = r.identification;
    var html = '<section class="card" style="margin:12px 0 0"><p class="eyebrow">AI’s best guess <span class="conf">' + esc(CONF_WORDS[idf.confidence]) + '</span></p><h3 style="margin:2px 0 6px">' + (c ? esc(c.emoji) + ' ' : '') + esc(idf.name || 'Not sure') + '</h3>';
    if (c) html += '<p class="small">' + esc(C.LIGHTS[c.light.ideal].label) + ' · water when ' + esc(C.SOIL[c.soil].short.toLowerCase()) + ' · every ' + esc(plural(c.water, 'day')) + ' or so</p>';
    html += '<p class="small"><b>Pets:</b> ' + (c ? esc(C.PETS[c.pets].line) : 'Not in Sprout’s list - check the ASPCA plant list before a pet nibbles it.') + ' <span class="muted">(From Sprout’s list, not the AI.)</span></p>';
    html += '<p><span class="urg ' + esc(r.health.urgency) + '">' + esc(URG_WORDS[r.health.urgency]) + '</span></p>';
    if (r.health.issues.length) html += '<ul class="issues">' + r.health.issues.map(function (i) { return '<li><b>' + esc(i.issue) + '</b>' + (i.likely_cause ? '<br><span class="small"><b>Cause:</b> ' + esc(i.likely_cause) + '</span>' : '') + (i.fix ? '<br><span class="small"><b>Fix:</b> ' + esc(i.fix) + '</span>' : '') + '</li>'; }).join('') + '</ul>';
    else html += '<p class="small">Nothing obviously wrong in this photo.</p>';
    if (r.note) html += '<p class="small">' + esc(r.note) + '</p>';
    html += '<p class="small muted">AI’s read of one photo - guidance, not gospel.</p><div class="btns">';
    if (p && !isDemo()) html += '<button class="btn" type="button" id="lkDiary">Save to ' + esc(nameOf(p)) + '’s diary</button>';
    if (!p || (c && c.id !== p.cat)) html += '<button class="btn' + (p ? ' ghost' : '') + '" type="button" id="lkAdd"' + (c || idf.name ? '' : ' disabled') + '>Add as a new plant</button>';
    html += '</div></section>';
    box.innerHTML = html;
    var dBtn = $('#lkDiary', box);
    if (dBtn) dBtn.addEventListener('click', function () {
      var summary = 'AI look: ' + (idf.name || 'unsure') + ' (' + CONF_WORDS[idf.confidence].toLowerCase() + ') - ' + (r.health.issues.length ? r.health.issues.map(function (i) { return i.issue; }).join('; ') : 'looks fine');
      dBtn.disabled = true;
      addDiaryPhoto(p.id, blob, summary).catch(function () { /* the note still goes in */ }).then(function () {
        closeSheet(true); doAct(p.id, 'note', { note: summary });
      });
    });
    var aBtn = $('#lkAdd', box);
    if (aBtn) aBtn.addEventListener('click', function () {
      closeSheet(true);
      if (isDemo()) { state.source = 'mine'; ensureMine(); }
      state.add = { step: 'form', q: '', form: null, nickN: 0 };
      state.add.form = c ? newForm(c.id) : newForm(null, { name: C.cleanText(idf.name, 40) || 'New plant', emoji: '🪴', water: 7 });
      go('add');
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
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Sprout stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function meteredError(err, box, retry) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount('Looking at a photo uses about a cent of AI credit, so it needs a free account (it comes with $2).', retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }
  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var FREE_LINE = 'Nothing in Sprout needs an account except the AI photo look - a free account comes with $2 of AI credit, and one account works across every app on this site.';
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">A photo look costs about a cent. Everything else in Sprout is free and needs no account.</p><div id="billing"></div></div>' +
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Everything else - the board, the sitter link, the calendar - keeps working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- one click listener ---------------- */

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.closest('#sheet') && el.getAttribute('data-act') === 'seg') return; // sheets handle their own
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id');
    if (el.tagName === 'A' && act !== 'jump') e.preventDefault();
    switch (act) {
      case 'home': go('start'); break;
      case 'tab':
        if (el.getAttribute('data-tab') === 'add') state.add = { step: 'pick', q: '', form: null, nickN: 0 };
        go(el.getAttribute('data-tab'));
        break;
      case 'example': openDemo(); break;
      case 'mine': state.source = 'mine'; openMine(); break;
      case 'jump': {
        e.preventDefault();
        var t = $('#band-' + el.getAttribute('data-band'));
        if (t) { if (t.tagName === 'DETAILS') t.open = true; t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        break;
      }
      case 'open': closeSheet(true); go('plant', id); break;
      case 'water': case 'notyet': case 'mist': case 'fert': case 'snooze': closeSheet(true); doAct(id, act, null, act === 'water' ? el : null); break;
      case 'more': moreSheet(id); break;
      case 'note': noteSheet(id); break;
      case 'move': moveSheet(id); break;
      case 'repot': repotSheet(id); break;
      case 'edit': editSheet(id); break;
      case 'photo': openPhoto(el.getAttribute('data-pid')); break;
      case 'look': openLook(id); break;
      case 'closesheet': closeSheet(); break;
      case 'pick':
        state.add.step = 'form'; state.add.form = newForm(el.getAttribute('data-cat'));
        draw(); scrollTo(0, 0); break;
      case 'custom':
        state.add.step = 'custom'; state.add.custom = null; draw(); scrollTo(0, 0); break;
      case 'addback': state.add.step = 'pick'; state.add.form = null; draw(); break;
      case 'dice': {
        var f = state.add.form; state.add.nickN++;
        f.nick = C.suggestNick(f.cat, plants().map(function (p) { return p.nick; }), state.add.nickN);
        var n = $('#nick'); if (n) n.value = f.nick;
        var sb = $('#addForm button[type=submit]'); if (sb) sb.textContent = 'Add ' + f.nick + ' to the jungle';
        break;
      }
      case 'seg': {
        var k = el.getAttribute('data-k');
        if (k === 'hemi') { setHemi(el.getAttribute('data-v')); break; }
        var form = state.add.step === 'custom' ? state.add.custom : state.add.form;
        if (!form) break;
        segPick(el, form);
        if (k === 'light') { var w = $('#lightWarn'); if (w) w.innerHTML = lightNote(form); }
        break;
      }
      case 'mklink': makeLink(); break;
      case 'copylink': copyText(state.away.link, 'Link copied - send it to your sitter'); break;
      case 'sharelink':
        navigator.share({ title: 'Plant-sitting', text: 'Here’s the care sheet for my plants - tick them off as you go 🌿', url: state.away.link }).catch(function () { /* cancelled */ });
        break;
      case 'ics': {
        var r = C.icsFor(plants(), { today: today(), hemi: hemi(), now: Date.now() });
        if (!r.days) { toast('Nothing to water in the next four weeks.'); break; }
        download('sprout-watering.ics', 'text/calendar', r.text);
        toast(plural(r.days, 'watering day') + ' in the file - open it to add them to your calendar.', 4500);
        break;
      }
      case 'export': download('sprout-plants-' + today() + '.json', 'application/json', C.exportHome(home())); break;
      case 'account': openSettings(); break;
      case 'signin': openAccount(); break;
      case 'wipe':
        sheet('<h2>Delete all your plants?</h2><p class="muted">Removes ' + esc(plural(plants().length, 'plant')) + ', their history and diary photos from this phone. This can’t be undone - export a file first if you might want them back.</p><div class="btns"><button class="btn" type="button" id="wipeGo">Delete them</button><button class="btn ghost" type="button" data-act="closesheet">Keep them</button></div>', function (root) {
          $('#wipeGo', root).addEventListener('click', function () {
            state.mine = null; keep(K_HOME, null); idb.clear().catch(function () { /* nothing kept */ });
            state.source = null; closeSheet(); go('start'); toast('Deleted from this phone.');
          });
        });
        break;
      default: break;
    }
  });
  document.addEventListener('submit', function (e) {
    if (e.target.id === 'addForm') {
      e.preventDefault();
      var f = state.add.form;
      f.nick = $('#nick').value;
      if (isDemo()) state.source = 'mine';
      var h = ensureMine();
      if (h.plants.length >= C.LIMITS.plants) { toast('That’s ' + C.LIMITS.plants + ' plants - the most one phone keeps.'); return; }
      var p = C.newPlant(f, { today: today() });
      if (!p) { toast('Give it a name first.'); return; }
      h.plants.push(p);
      state.source = 'mine';
      persist();
      state.add = { step: 'pick', q: '', form: null, nickN: 0 };
      go('today');
      toast(nameOf(p) + ' joined the jungle! 🌱', 7000, [{ label: 'Add another', run: function () { go('add'); } }]);
    } else if (e.target.id === 'customForm') {
      e.preventDefault();
      var cf = state.add.custom;
      cf.name = $('#cName').value;
      var name = C.cleanText(cf.name, 40);
      if (!name) { toast('What is it called?'); return; }
      state.add.form = newForm(null, { name: name, emoji: cf.emoji || '🪴', water: C.CUSTOM_PACE[cf.pace] || 7 });
      state.add.step = 'form'; draw(); scrollTo(0, 0);
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    var fileKind = t.getAttribute && t.getAttribute('data-file');
    if (fileKind === 'import') { importFile(t.files && t.files[0]); t.value = ''; return; }
    if (fileKind === 'diary') {
      var file = t.files && t.files[0]; var pid = t.getAttribute('data-id'); t.value = '';
      if (!file) return;
      shrink(file, DIARY_PX, 0.82).then(function (blob) { return addDiaryPhoto(pid, blob, ''); })
        .then(function () { drawDiary(); toast('Photo added to the diary. It stays on this phone.'); })
        .catch(function () { toast('That photo couldn’t be kept in this browser.', 4000); });
      return;
    }
    var c = t.getAttribute && t.getAttribute('data-change');
    if (c === 'away') {
      var a = state.away;
      var s = $('#awStart').value, en = $('#awEnd').value;
      if (C.isDate(s)) a.start = s;
      if (C.isDate(en)) a.end = en;
      if (a.end < a.start) { a.end = a.start; $('#awEnd').value = a.end; }
      a.link = null;
      var pv = $('#awPreview'); if (pv) pv.innerHTML = awayPreview();
    } else if (c === 'name') {
      var hm = home() || ensureMine();
      hm.settings.name = C.cleanText(t.value, C.LIMITS.sitFrom);
      persist(); state.away.link = null;
      var pv2 = $('#awPreview'); if (pv2) pv2.innerHTML = awayPreview();
    } else if (c === 'awaynote') {
      state.away.note = C.clean(t.value, C.LIMITS.sitHomeNote); state.away.link = null;
      var pv3 = $('#awPreview'); if (pv3) pv3.innerHTML = awayPreview();
    }
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'nick' && state.add.form) {
      state.add.form.nick = e.target.value;
      var sb = $('#addForm button[type=submit]'); if (sb) sb.textContent = 'Add ' + (C.cleanText(e.target.value, C.LIMITS.nick) || 'it') + ' to the jungle';
    }
    if (e.target.id === 'cName' && state.add.custom) state.add.custom.name = e.target.value;
  });

  /* ---------------- a new day ---------------- */

  // "Today" is the phone's. When the date turns while the page is open (or
  // it comes back from the background on a new day), the board redraws -
  // and the example is rebuilt around the new today.
  function checkDay() {
    var t = today();
    if (t === state.day) return;
    state.day = t;
    if (isDemo()) state.demo = D.build(t, state.demo ? state.demo.settings.hemi : C.hemisphereOf(TZ));
    if (state.view === 'app' && $('#sheet').hidden && state.tab !== 'add' && state.tab !== 'away') draw();
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
