/* Pencil - the page. One file, no build step.
 *
 * EVERY GAME STAYS ON THIS PHONE unless its scorer shows the table: games in
 * progress and finished, the people at the table, groups and the history in
 * localStorage; every engine, the stats, the CSV and the recap card are
 * worked out here by PencilCore. Every storage access is wrapped in
 * try/catch, and the page works - in memory - when storage is unavailable.
 *
 * The requests this page makes: sign-in; showing a table (the game as text:
 * names, emoji and numbers) and everything a shared table does; and "Read
 * a paper score sheet", whose payload (the one photo) is shown before it is
 * sent.
 *
 * Every string a person typed, a file held, the server answered or a model
 * wrote is escaped before it is drawn, and no handler is written into
 * markup: clicks are routed by data-act attributes from one listener (the
 * lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.PencilCore;
  var QR = window.PencilQR;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var ORIGIN = location.origin;
  var esc = C.esc, plural = C.plural;
  // A tag the browser reports but Intl refuses ("en-US@posix" in some
  // headless browsers) would make every date throw: fall back.
  var LOCALE = (function () { try { return Intl.getCanonicalLocales(navigator.language || 'en-US')[0] || 'en-US'; } catch (e) { return 'en-US'; } }());
  var K_GAMES = 'pencil-games-v1', K_BOOK = 'pencil-book-v1', K_PREFS = 'pencil-prefs-v1';

  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  function now() { return Date.now(); }
  function rand(n) { var a = new Uint32Array(1); try { crypto.getRandomValues(a); } catch (e) { a[0] = Math.floor(Math.random() * 4294967296); } return a[0] % n; }
  function o() { return { now: now(), rand: rand }; }
  function dayOf(iso) {
    var d = new Date(iso);
    if (!isFinite(d)) return '';
    try { return d.toLocaleDateString(LOCALE, { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) { return d.toISOString().slice(0, 10); }
  }
  function timeOf(isoOrMs) {
    var d = new Date(isoOrMs);
    if (!isFinite(d)) return '';
    try {
      var same = new Date().toDateString() === d.toDateString();
      return same ? d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(LOCALE, { weekday: 'short', month: 'short', day: 'numeric' });
    } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  function ago(iso) {
    var ms = now() - Date.parse(iso);
    if (!isFinite(ms)) return '';
    var d = Math.round(ms / 86400000);
    if (d <= 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 7) return d + ' days ago';
    if (d < 60) return Math.round(d / 7) + (Math.round(d / 7) === 1 ? ' week ago' : ' weeks ago');
    return dayOf(iso);
  }

  /* ---------------- what this phone keeps ---------------- */

  function loadGames() {
    var raw = recall(K_GAMES) || {};
    var seen = {};
    var list = (Array.isArray(raw.games) ? raw.games : []).map(function (g) { return C.cleanGame(g, { now: now() }); })
      .filter(function (g) { if (!g || seen[g.id]) return false; seen[g.id] = 1; return true; });
    var current = list.some(function (g) { return g.id === raw.current; }) ? raw.current : null;
    return { list: list, current: current };
  }
  function loadBook() {
    var raw = recall(K_BOOK) || {};
    return { people: C.cleanPeople(raw.people), groups: C.cleanGroups(raw.groups), history: C.cleanHistory(raw.history) };
  }
  var games = loadGames();
  var book = loadBook();
  var prefs = recall(K_PREFS) || {};
  if (typeof prefs.me !== 'string') prefs.me = '';
  function savePrefs() { keep(K_PREFS, prefs); }
  var storageOk = true;
  function warnStorage(ok) { if (!ok && storageOk) { storageOk = false; toast('This browser isn’t keeping things right now - your games will be gone when the page closes.', 5200); } }
  /** Finished games are kept whole only so far back; the history keeps
   *  every one as a summary. Undo steps go with a game once it is old. */
  function trimGames() {
    var playing = games.list.filter(function (g) { return g.status !== 'done'; });
    var done = games.list.filter(function (g) { return g.status === 'done'; }).sort(function (a, b) { return a.finishedAt < b.finishedAt ? 1 : -1; });
    done.slice(3).forEach(function (g) { g.past = []; g.future = []; });
    games.list = playing.slice(0, C.LIMITS.live + 4).concat(done.slice(0, C.LIMITS.fullGames));
  }
  function saveGames() { if (state.trying) return; trimGames(); warnStorage(keep(K_GAMES, { v: 1, games: games.list, current: games.current })); }
  function saveBook() { if (state.trying) return; warnStorage(keep(K_BOOK, { v: 1, people: book.people, groups: book.groups, history: book.history })); }

  var state = {
    me: null, view: '', arg: '',
    trying: false, demo: null,
    setup: null, dice: [], group: '', h2h: { a: '', b: '' },
    offline: false, join: null, recap: null, ai: null, kp: null,
    celebrated: {}, pushing: {}, pushAgain: {}, unsent: {}, histMore: false,
  };
  /** The games, people and history on screen: the made-up night while
   *  trying it, this phone's otherwise. */
  function list() { return state.trying ? state.demo.games : games.list; }
  function bk() { return state.trying ? state.demo : book; }
  function gameById(id) { return list().filter(function (g) { return g.id === id; })[0] || null; }
  function cur() {
    if (state.view === 'game') return gameById(state.arg);
    return gameById(state.trying ? state.demo.current : games.current);
  }
  function watching(g) { return Boolean(g && g.shared && g.shared.role === 'watcher'); }
  function canScore(g) { return Boolean(g) && !watching(g); }
  /** A game changed: kept, made current, its history row brought in line,
   *  and - when its table is shown - sent to the server. */
  function putGame(g, opts) {
    var l = list();
    var i = l.findIndex(function (x) { return x.id === g.id; });
    if (i >= 0) l[i] = g; else l.unshift(g);
    if (state.trying) state.demo.current = g.id; else games.current = g.id;
    syncHistory(g);
    saveGames();
    if (!(opts && opts.quiet) && g.shared && g.shared.role === 'scorer') pushShared(g.id);
  }
  function dropGame(id) {
    if (state.trying) { state.demo.games = state.demo.games.filter(function (g) { return g.id !== id; }); return; }
    games.list = games.list.filter(function (g) { return g.id !== id; });
    if (games.current === id) games.current = null;
    saveGames();
  }
  /** A finished game is in the history once; undo its finish and it leaves
   *  again. A watched game's people are matched to this phone's by name. */
  function syncHistory(g) {
    var b = bk();
    var had = b.history.some(function (h) { return h.id === g.id; });
    if (g.status !== 'done') { if (had) { b.history = b.history.filter(function (h) { return h.id !== g.id; }); saveBook(); } return; }
    var sum = C.summarize(g);
    if (g.foreign) {
      b.history = b.history.filter(function (h) { return h.id !== g.id; });
      var m = C.mergeImport(b, { history: [sum] }, o());
      b.people = m.people; b.history = m.history;
    } else {
      b.history = b.history.filter(function (h) { return h.id !== g.id; }).concat([sum]);
      b.history.sort(function (x, y) { return x.at < y.at ? -1 : 1; });
      if (b.history.length > C.LIMITS.history) b.history = b.history.slice(-C.LIMITS.history);
    }
    saveBook();
  }
  /** People at a new game move to the front of "recent". */
  function touchPeople(players) {
    var b = bk(), t = now();
    players.forEach(function (p, i) {
      var have = b.people.filter(function (x) { return x.id === p.id; })[0];
      if (have) { have.name = p.name; have.emoji = p.emoji; have.at = t - i; }
      else if (b.people.length < C.LIMITS.people) b.people.push({ id: p.id, name: p.name, emoji: p.emoji, at: t - i });
    });
    saveBook();
  }

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    var headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin', headers: headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      state.offline = false;
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok || d.error) { var e = new Error(d.error || 'Something went wrong.'); e.status = res.status; e.data = d; throw e; }
        return d;
      });
    }, function () { state.offline = true; var e = new Error('You’re offline - that needs the internet.'); e.status = 0; e.offline = true; e.data = {}; throw e; });
  }
  var toastTimer = null;
  function toast(msg, ms, action) {
    $$('.toast').forEach(function (t) { t.remove(); });
    clearTimeout(toastTimer);
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status');
    var span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
    if (action) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = action.label;
      b.addEventListener('click', function () { t.remove(); action.fn(); });
      t.appendChild(b);
    }
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, ms || 2800);
  }
  function say(msg) { var l = $('#live'); if (l) { l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); } }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied.'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function download(name, type, content) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function shareText(title, text, url) {
    if (navigator.share) return navigator.share({ title: title, text: text, url: url }).catch(function (e) { if (!e || e.name !== 'AbortError') copy(text + ' ' + url, 'Copied - paste it to the table.'); });
    copy(text + ' ' + url, 'Copied - paste it to the table.');
    return Promise.resolve();
  }
  function slug(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'game'; }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function reducedMotion() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Pencil stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
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
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }

  /* ---------------- routing ---------------- */

  function route() {
    var h = C.parseHash(location.hash);
    state.view = h.view; state.arg = h.id || h.game || '';
    if (h.view === 'join') { state.join = { code: h.code || '', info: null }; if (h.code) lookupJoin(); }
    if (h.view === 'setup') startSetup(h.game);
    if (h.view === 'game' && !gameById(h.id)) { state.view = ''; state.arg = ''; }
    if (h.view === 'game') { if (state.trying) state.demo.current = h.id; else { games.current = h.id; saveGames(); } }
    draw();
  }
  function go(hash) {
    var want = hash ? '#' + hash : '';
    if (location.hash === want || (!hash && !location.hash)) route();
    else if (!hash) { history.pushState(null, '', location.pathname + location.search); route(); }
    else location.hash = hash;
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);

  function hasAnything() { return games.list.length > 0 || book.history.length > 0; }
  function draw() {
    var main = $('#main');
    var g = cur();
    var tabs = $('#tabbar');
    var first = !state.trying && !hasAnything() && (state.view === '' || state.view === 'games');
    tabs.hidden = first;
    var tab = state.view === 'game' ? 'score' : state.view === 'table' ? 'table' : state.view === 'more' || state.view === 'join' ? 'more' : 'games';
    $$('[data-act="tab"]', tabs).forEach(function (b) { if (b.getAttribute('data-tab') === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var scoreGame = gameById(state.trying ? state.demo.current : games.current);
    $('#tabScore').hidden = !scoreGame;
    $('#liveBadge').hidden = !(scoreGame && scoreGame.shared);
    var pill = $('#gamePill');
    pill.hidden = !(g && state.view === 'game');
    document.body.classList.toggle('has-pill', !pill.hidden);
    if (!pill.hidden) $('#gamePillName').textContent = (C.infoOf(g) ? C.infoOf(g).emoji + ' ' : '') + g.name;
    var html;
    if (first) html = viewFirst();
    else if (state.view === 'new') html = viewNew();
    else if (state.view === 'setup' && state.setup) html = viewSetup();
    else if (state.view === 'game' && g) html = viewGame(g);
    else if (state.view === 'table') html = viewTable();
    else if (state.view === 'more') html = viewMore();
    else if (state.view === 'join') html = viewJoin();
    else html = viewGames();
    main.innerHTML = (state.trying ? ribbon() : '') + html;
    after();
  }
  function after() {
    if (state.view === 'setup') bindSetup();
    if (state.view === 'game') bindGame(cur());
    if (state.view === 'join') bindJoin();
    if (state.view === 'table') bindTable();
    if (state.view === 'more') bindMore();
    var sb = $('.sbox[data-end]');
    if (sb) sb.scrollLeft = sb.scrollWidth;
  }
  function ribbon() {
    return '<div class="ribbon" role="note"><span>The Larkfield-Osei game night is made up - tap anything, nothing is saved.</span><div class="row"><button class="btn small" type="button" data-act="tryown">Start my own</button><button class="btn small ghost" type="button" data-act="tryleave">Leave</button></div></div>';
  }

  /* ---------------- the first run ---------------- */

  function mockSheet() {
    var cols = [['\u{1F98A}', 'Priya'], ['\u{1F43B}', 'Marcus'], ['\u{1F33B}', 'Noor'], ['\u{1F680}', 'Kai']];
    var rows = [[3, 13, 6, 4], [0, 26, 26, 26], [8, 2, 16, 0], [1, 5, 3, 17], [13, 4, 2, 7]];
    var tot = [25, 50, 53, 54];
    return '<div class="pad" aria-hidden="true"><span class="crown">\u{1F451} Priya leads</span><span class="sum">26 ✓</span><table><thead><tr><th></th>' + cols.map(function (c) { return '<th><span class="e">' + c[0] + '</span>' + c[1] + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r, i) { return '<tr><td class="r">H' + (i + 1) + '</td>' + r.map(function (v, k) { return '<td' + (i === 1 ? ' class="moon"' : '') + '>' + (i === 1 && k === 0 ? '\u{1F319}' : v) + '</td>'; }).join('') + '</tr>'; }).join('') +
      '<tr class="tot"><td class="r"></td>' + tot.map(function (v) { return '<td>' + v + '</td>'; }).join('') + '</tr></tbody></table><span class="stub"></span></div>';
  }
  function viewFirst() {
    return '<section class="hero"><div class="hero-grid"><div>' +
      '<h1>Keep score at game night.</h1>' +
      '<p>Every game, every round, and who’s ahead all year. Pencil knows how each game is scored, does the maths nobody wants to argue about, and remembers who won last time.</p>' +
      '<div class="cta"><button class="btn big white" type="button" data-act="try">Try a game night</button>' +
      '<div class="row"><button class="btn line" type="button" data-act="new">Start a game</button><button class="btn line" type="button" data-act="joinnew">Join a table</button></div></div>' +
      '<p class="gamesline">Hearts · Five dice · Rummy · Bowling · Darts 501 · Cribbage · Mini golf · Euchre · Card golf · Word game · any game you make up</p>' +
      '</div>' + mockSheet() + '</div></section>' +
      '<section class="card" style="margin-top:16px"><h2>How it works</h2><ol class="how">' +
      '<li><div><b>Pick the game, add the players</b><p class="muted small" style="margin:0">Recent players are one tap away, each with an emoji.</p></div></li>' +
      '<li><div><b>Tap a box, tap the number</b><p class="muted small" style="margin:0">A big keypad, the leader crowned, the dealer moved round. Hearts checks each hand adds to 26; darts calls the bust; bowling counts the strike bonus.</p></div></li>' +
      '<li><div><b>The winner, called - and remembered</b><p class="muted small" style="margin:0">A recap card to send the group, and a table of wins, streaks and records across every game night.</p></div></li></ol></section>' +
      '<div class="grid three" style="margin-top:14px">' +
      '<section class="card feat"><span class="ic" aria-hidden="true">\u{1F4F1}</span><h3>Show the table</h3><p class="muted small">Everyone watches the scores land on their own phone - a six-letter code, no accounts. Hand the pencil to someone else whenever you like.</p></section>' +
      '<section class="card feat"><span class="ic" aria-hidden="true">\u{1F3C6}</span><h3>Bragging rights</h3><p class="muted small">Wins, win rate and streaks for every game, head to head between any two players, and “Next to beat: Marcus’s 287 in Bowling”.</p></section>' +
      '<section class="card feat"><span class="ic" aria-hidden="true">\u{1F4DD}</span><h3>Kept it on paper?</h3><p class="muted small">Snap the score sheet and AI copies it in for you to check (with a free account). Everything else is free, needs no sign-in, and stays on this phone.</p></section>' +
      '</div>';
  }
  function startTry() {
    state.demo = C.sampleNight({ now: now() });
    state.demo.current = state.demo.games[0].id;
    state.trying = true;
    state.group = '';
    go('g/' + state.demo.games[0].id);
  }
  function leaveTry() { state.trying = false; state.demo = null; }

  /* ---------------- games ---------------- */

  function faces(g) { return g.sides.map(function (s) { return s.emoji; }).join(''); }
  function gameRow(g) {
    var info = C.infoOf(g);
    var pill = watching(g) ? '<span class="pill p-live">Watching</span>' : g.shared ? '<span class="pill p-live">Shown live</span>' : g.status === 'done' ? '<span class="pill p-done">Finished</span>' : '<span class="pill p-play">Playing</span>';
    return '<button class="grow" type="button" data-act="open" data-id="' + esc(g.id) + '"><span class="ge" aria-hidden="true">' + esc(info.emoji) + '</span><span><b>' + esc(g.name) + '</b><small>' + esc(C.gameLine(g)) + '</small><small class="faces" aria-label="' + esc(C.listNames(g.sides.map(function (s) { return s.name; }))) + '">' + esc(faces(g)) + '</small></span>' + pill + '</button>';
  }
  function viewGames() {
    var l = list();
    var playing = l.filter(function (g) { return g.status !== 'done'; });
    var done = l.filter(function (g) { return g.status === 'done'; }).sort(function (a, b) { return a.finishedAt < b.finishedAt ? 1 : -1; });
    var st = C.stats(bk().history, {});
    var nexts = st.byGame.filter(function (x) { return x.next; }).slice(0, 2);
    var out = '<div class="sec-head"><h1>' + (state.trying ? 'Tonight’s games' : 'Games') + '</h1><div class="row"><button class="btn" type="button" data-act="new">+ Start a game</button></div></div>';
    out += '<div class="grid split">';
    out += '<div class="stack">';
    if (playing.length) out += '<section class="card stack"><h2>Playing now</h2><div class="glist">' + playing.map(gameRow).join('') + '</div></section>';
    else out += '<section class="card stack center"><p style="font-size:2rem;margin:0" aria-hidden="true">\u{1F3B2}</p><p><b>Nothing on the table.</b> Start a game - it takes ten seconds.</p><button class="btn big" type="button" data-act="new">Start a game</button></section>';
    if (done.length) out += '<section class="card stack"><h2>Finished</h2><div class="glist">' + done.slice(0, 8).map(gameRow).join('') + '</div></section>';
    out += '</div><div class="stack">';
    if (nexts.length) out += '<section class="card stack"><h2>Bragging rights</h2>' + nexts.map(function (x) { return '<p class="story" style="margin:0">' + esc(x.emoji + ' ' + x.next) + '</p>'; }).join('') + '<button class="btn ghost" type="button" data-act="tab" data-tab="table">See our table</button></section>';
    out += '<section class="card stack"><h2>Someone else keeping score?</h2><p class="muted small" style="margin:0">Watch their table live with the six-letter code on their screen.</p><button class="btn ghost" type="button" data-act="joinnew">Join a table</button></section>';
    if (!state.trying) out += '<section class="card stack"><h2>Kept it on paper?</h2><p class="muted small" style="margin:0">Snap the sheet and AI copies the names and scores into a new game, for you to check.</p><button class="btn ghost ai" type="button" data-act="ainew"> Read a paper sheet</button></section>';
    out += '</div></div>';
    return out;
  }
  function viewNew() {
    return '<div class="sec-head"><h1>Pick the game</h1><button class="btn small ghost" type="button" data-act="home">Cancel</button></div>' +
      '<div class="gpick">' + C.GAMES.map(function (x) { return '<button type="button" data-act="pick" data-g="' + esc(x.id) + '"><span class="ge" aria-hidden="true">' + esc(x.emoji) + '</span><b>' + esc(x.name) + '</b><small>' + esc(x.blurb) + '</small></button>'; }).join('') + '</div>';
  }

  /* ---------------- setting up ---------------- */

  function nextEmoji(taken) { for (var i = 0; i < C.EMOJI.length; i++) if (taken.indexOf(C.EMOJI[i]) < 0) return C.EMOJI[i]; return C.EMOJI[taken.length % C.EMOJI.length]; }
  function startSetup(gid, from) {
    var info = C.gameInfo(gid);
    if (!info) return;
    if (state.setup && state.setup.game === gid && !from) return;
    var s = { game: gid, players: [], settings: C.defaultSettings(info.kind, info.preset || ''), name: '', dealer: 0, group: '', err: '' };
    if (from) {
      s.players = [];
      from.sides.forEach(function (side) { side.people.forEach(function (p) { s.players.push({ id: p.id, name: p.name, emoji: p.emoji }); }); });
      if (from.kind === 'any' && from.settings.teams) { var a = from.sides[0].people, b = from.sides[1] ? from.sides[1].people : []; s.players = []; for (var i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) s.players.push(a[i]); if (b[i]) s.players.push(b[i]); } }
      s.settings = C.clone(from.settings);
      s.name = from.kind === 'any' && from.preset === 'custom' ? from.name : '';
      s.group = from.group || '';
      s.dealer = (from.dealer + 1) % Math.max(1, s.players.length);
    }
    state.setup = s;
  }
  function teamGame(s, info) { return (info.kind === 'any' && s.settings.teams) || (info.kind === 'cribbage' && s.settings.teams); }
  function settingsHtml(s, info) {
    var st = s.settings, out = '';
    var seg = function (key, val, cur2, words) { return '<button type="button" data-set="' + esc(key) + '" data-v="' + esc(String(val)) + '" aria-pressed="' + (String(cur2) === String(val)) + '">' + esc(words) + '</button>'; };
    var num = function (key, val, label, min, max) { return '<label class="field"><span>' + esc(label) + '</span><input class="input n" type="number" inputmode="numeric" data-num="' + esc(key) + '" min="' + min + '" max="' + max + '" value="' + esc(String(val)) + '"></label>'; };
    if (info.kind === 'any') {
      if (info.preset === 'custom' || !info.preset) out += '<label class="field"><span>What are you playing?</span><input class="input" id="sName" maxlength="' + C.LIMITS.gameName + '" value="' + esc(s.name) + '" placeholder="Spades, Canasta night, Charades…"></label>';
      out += '<div class="field"><span>Who wins?</span><div class="seg">' + seg('win', 'high', st.win, 'Highest score') + seg('win', 'low', st.win, 'Lowest score') + '</div></div>';
      out += '<div class="field"><span>The game ends</span><div class="seg">' + seg('end', 'target', st.end, 'At a score') + seg('end', 'rounds', st.end, 'After rounds') + seg('end', 'open', st.end, 'When we stop') + '</div></div>';
      if (st.end === 'target') out += num('target', st.target, st.win === 'low' ? 'Ends when anyone reaches' : 'First to', -99999, 99999);
      if (st.end === 'rounds') out += num('rounds', st.rounds, 'Rounds', 1, C.LIMITS.rounds);
      out += '<label class="check"><input type="checkbox" data-flag="dealer"' + (st.dealer ? ' checked' : '') + '> Mark the dealer and move it round</label>';
      if (info.preset === 'custom' || !info.preset) out += '<label class="check"><input type="checkbox" data-flag="teams"' + (st.teams ? ' checked' : '') + '> Play in teams (partners sit opposite)</label>';
      out += '<div class="field"><span>A late player starts at</span><div class="seg">' + seg('late', 'trail', st.late, 'Last place’s score') + seg('late', 'zero', st.late, 'Zero') + '</div></div>';
    } else if (info.kind === 'hearts') {
      out += num('endAt', st.endAt, 'The game ends when anyone reaches', 25, 500);
      out += '<div class="field"><span>Shooting the moon</span><div class="seg">' + seg('moon', 'add', st.moon, '+26 to everyone else') + seg('moon', 'subtract', st.moon, '−26 for the shooter') + '</div></div>';
      out += '<div class="field"><span>A tie for lowest</span><div class="seg">' + seg('tie', 'keep', st.tie, 'Keep playing') + seg('tie', 'share', st.tie, 'Share the win') + '</div></div>';
      out += '<div class="field"><span>A late player starts at</span><div class="seg">' + seg('late', 'trail', st.late, 'Last place’s score') + seg('late', 'zero', st.late, 'Zero') + '</div></div>';
    } else if (info.kind === 'dice') {
      out += '<label class="check"><input type="checkbox" data-flag="extra"' + (st.extra ? ' checked' : '') + '> Extra five of a kind: +100 each (after a 50)</label>';
    } else if (info.kind === 'darts') {
      out += '<div class="field"><span>Start from</span><div class="seg">' + seg('start', 501, st.start, '501') + seg('start', 301, st.start, '301') + seg('start', 701, st.start, '701') + '</div></div>';
      out += '<label class="check"><input type="checkbox" data-flag="doubleOut"' + (st.doubleOut ? ' checked' : '') + '> Finish on a double</label>';
    } else if (info.kind === 'cribbage') {
      out += '<label class="check"><input type="checkbox" data-flag="teams"' + (st.teams ? ' checked' : '') + '> Two teams of two</label>';
      out += '<p class="hint" style="margin:0">To 121. Skunks are called at the end: under 91, and a double under 61.</p>';
    } else if (info.kind === 'golf') {
      out += '<div class="field"><span>Holes</span><div class="seg">' + seg('holes', 9, st.holes, '9') + seg('holes', 18, st.holes, '18') + '</div></div>';
      out += num('max', st.max, 'Most strokes on one hole', 2, 12);
      out += '<p class="hint" style="margin:0">Add par for each hole on the score sheet, if the course shows it.</p>';
    } else out += '<p class="muted small" style="margin:0">Ten frames, strikes and spares worked out for you.</p>';
    return out;
  }
  function viewSetup() {
    var s = state.setup, info = C.gameInfo(s.game), b = bk();
    var chosen = {};
    s.players.forEach(function (p) { chosen[p.id] = 1; });
    var recent = C.recentPeople(b.people, 16).filter(function (p) { return !chosen[p.id]; });
    var team = teamGame(s, info);
    var max = team ? (info.kind === 'cribbage' || info.preset === 'euchre' ? 4 : 12) : info.max;
    var out = '<div class="sec-head"><h1><span class="emo" aria-hidden="true">' + esc(info.emoji) + '</span> ' + esc(info.name) + '</h1><button class="btn small ghost" type="button" data-act="new">Another game</button></div>';
    out += '<div class="grid split"><div class="stack">';
    out += '<section class="card stack"><div class="sec-head" style="margin:0"><h2>Who’s playing?</h2><span class="muted small">' + (team ? (info.preset === 'euchre' || info.kind === 'cribbage' ? '4 players, 2 teams' : 'Teams') : info.min === info.max ? info.min + ' players' : info.min + '–' + Math.min(info.max, 12) + ' players') + '</span></div>';
    out += '<div class="plist" id="plist">' + (s.players.length ? s.players.map(function (p, i) {
      return '<div class="prow"><button class="emobtn" type="button" data-act="pemoji" data-i="' + i + '" aria-label="Change ' + esc(p.name) + '’s emoji">' + esc(p.emoji) + '</button><span><b>' + esc(p.name) + '</b>' + (team ? '<small>Team ' + (i % 2 + 1) + '</small>' : '') + '</span><span class="acts"><button class="iconbtn" type="button" data-act="pup" data-i="' + i + '" aria-label="Move ' + esc(p.name) + ' up"' + (i ? '' : ' disabled') + '>↑</button><button class="iconbtn" type="button" data-act="pdown" data-i="' + i + '" aria-label="Move ' + esc(p.name) + ' down"' + (i < s.players.length - 1 ? '' : ' disabled') + '>↓</button><button class="iconbtn" type="button" data-act="prm" data-i="' + i + '" aria-label="Take ' + esc(p.name) + ' out">×</button></span></div>';
    }).join('') : '<p class="muted small" style="margin:0">Nobody yet - tap a name below or type one.</p>') + '</div>';
    if (s.players.length < max) {
      out += '<form class="addrow" id="addP" autocomplete="off"><label class="vh" for="pName">First name</label><input class="input" id="pName" maxlength="' + C.LIMITS.name + '" placeholder="Add a player - first name" enterkeyhint="done"><button class="btn" type="submit">Add</button></form>';
      if (recent.length) out += '<div class="field"><span class="small">Recent players</span><div class="chips">' + recent.map(function (p) { return '<button class="pchip" type="button" data-act="padd" data-pid="' + esc(p.id) + '"><span class="emo" aria-hidden="true">' + esc(p.emoji) + '</span>' + esc(p.name) + '</button>'; }).join('') + '</div></div>';
      if (b.groups.length) out += '<div class="chips">' + b.groups.map(function (gr) { return '<button class="chip" type="button" data-act="pgroup" data-gid="' + esc(gr.id) + '">+ ' + esc(gr.name) + '</button>'; }).join('') + '</div>';
    }
    if (team && s.players.length >= 2) {
      out += '<div class="teams">' + [0, 1].map(function (t) { var ps = s.players.filter(function (p, i) { return i % 2 === t; }); return '<div class="tm"><b>Team ' + (t + 1) + '</b><span class="small">' + esc(C.listNames(ps.map(function (p) { return p.name; }))) + '</span></div>'; }).join('') + '</div><p class="hint" style="margin:0">Partners sit opposite: 1st and 3rd against 2nd and 4th. Move players to change the teams.</p>';
    }
    out += '</section></div><div class="stack">';
    var custom = info.kind === 'any' && (!info.preset || info.preset === 'custom');
    out += '<section class="card stack"><details class="more"' + (custom || s.rulesOpen ? ' open' : '') + ' id="rulesBox"><summary>Rules: ' + esc(rulesLine({ kind: info.kind, settings: s.settings })) + '</summary><div class="stack" style="margin-top:10px">' + settingsHtml(s, info) + '</div></details></section>';
    var usesDealer = info.kind === 'hearts' || info.kind === 'cribbage' || (info.kind === 'any' && s.settings.dealer);
    if (usesDealer && s.players.length) out += '<section class="card stack"><label class="field"><span>Who deals first?</span><select class="input" id="sDealer">' + s.players.map(function (p, i) { return '<option value="' + i + '"' + (i === s.dealer ? ' selected' : '') + '>' + esc(p.emoji + ' ' + p.name) + '</option>'; }).join('') + '</select></label></section>';
    if (b.groups.length) out += '<section class="card stack"><label class="field"><span>Count it for</span><select class="input" id="sGroup"><option value="">Just this phone’s history</option>' + b.groups.map(function (gr) { return '<option value="' + esc(gr.id) + '"' + (s.group === gr.id ? ' selected' : '') + '>' + esc(gr.name) + '</option>'; }).join('') + '</select><span class="hint">Our table can show one group’s games on their own.</span></label></section>';
    out += '<div id="sErr">' + (s.err ? '<p class="err" role="alert">' + esc(s.err) + '</p>' : '') + '</div>';
    out += '<button class="btn big block" type="button" data-act="startgame">Start ' + esc(info.name) + '</button>';
    out += '</div></div>';
    return out;
  }
  function setupPerson(name) {
    var s = state.setup, b = bk();
    var clean = C.cleanName(name);
    if (!clean) { s.err = 'A first name needs a letter in it.'; return false; }
    if (s.players.some(function (p) { return C.norm(p.name) === C.norm(clean); })) { s.err = clean + ' is already playing.'; return false; }
    var have = b.people.filter(function (p) { return C.norm(p.name) === C.norm(clean); })[0];
    var p = have ? { id: have.id, name: have.name, emoji: have.emoji } : { id: C.freshId(rand, 'p', b.people.map(function (x) { return x.id; }), 8), name: clean, emoji: nextEmoji(s.players.map(function (x) { return x.emoji; })) };
    if (s.players.some(function (x) { return x.emoji === p.emoji; })) p.emoji = nextEmoji(s.players.map(function (x) { return x.emoji; }));
    s.players.push(p); s.err = '';
    return true;
  }
  function bindSetup() {
    var s = state.setup;
    var f = $('#addP');
    if (f) f.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = $('#pName').value;
      if (!v.trim()) return;
      setupPerson(v); draw();
      var n = $('#pName'); if (n) try { n.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    });
    var nm = $('#sName'); if (nm) nm.addEventListener('input', function () { s.name = nm.value; });
    var dl = $('#sDealer'); if (dl) dl.addEventListener('change', function () { s.dealer = Number(dl.value) || 0; });
    var rb = $('#rulesBox'); if (rb) rb.addEventListener('toggle', function () { s.rulesOpen = rb.open; });
    var gr = $('#sGroup'); if (gr) gr.addEventListener('change', function () { s.group = gr.value; });
    $$('[data-set]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-set'), v = b.getAttribute('data-v');
        s.settings[k] = /^\d+$/.test(v) ? Number(v) : v;
        draw();
      });
    });
    $$('[data-flag]').forEach(function (b) { b.addEventListener('change', function () { s.settings[b.getAttribute('data-flag')] = b.checked; draw(); }); });
    $$('[data-num]').forEach(function (b) { b.addEventListener('change', function () { var n = parseInt(b.value, 10); if (isFinite(n)) s.settings[b.getAttribute('data-num')] = n; }); });
  }
  function startGame() {
    var s = state.setup, info = C.gameInfo(s.game);
    var nmIn = $('#pName');
    if (nmIn && nmIn.value.trim()) setupPerson(nmIn.value);
    try {
      var g = C.newGame({ game: s.game, players: s.players, settings: s.settings, name: s.name, dealer: s.dealer, group: s.group }, o());
      touchPeople(s.players);
      putGame(g);
      state.setup = null;
      go('g/' + g.id);
      say(info.name + ' started.');
    } catch (err) { s.err = err.message; draw(); var e = $('#sErr'); if (e) e.scrollIntoView({ block: 'center' }); }
  }
  function openEmoji(i) {
    var p = state.setup.players[i]; if (!p) return;
    sheet('<h2>' + esc(p.name) + '’s emoji</h2><div class="emogrid">' + C.EMOJI.map(function (e) { return '<button type="button" data-act="setemoji" data-i="' + i + '" data-e="' + esc(e) + '" aria-pressed="' + (p.emoji === e) + '">' + esc(e) + '</button>'; }).join('') + '</div>');
  }

  /* ---------------- keeping score ---------------- */

  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function fmt(n) { return n < 0 ? '−' + Math.abs(n) : String(n); }
  function placeLine(g, r, side) {
    var row = r.rows.filter(function (x) { return x.side.id === side.id; })[0];
    if (!row || !C.started(g)) return g.kind === 'darts' ? 'to go' : '';
    var lead = r.rows[0];
    var bits = [];
    if (row.place === 1) bits.push(r.over ? (r.tie ? '\u{1F451} Tied first' : '\u{1F451} Winner') : '\u{1F451} ' + (r.leaders.length > 1 ? 'Shares the lead' : 'Leads'));
    else bits.push(ordinal(row.place) + ' · ' + Math.abs(row.total - lead.total) + (g.kind === 'darts' ? ' more left' : ' behind'));
    if (g.kind === 'any' && g.settings.end === 'target' && !r.over) { var to = g.settings.target - row.total; if (g.settings.target > 0 && to > 0) bits.push(to + ' to ' + g.settings.target); }
    if (g.kind === 'hearts' && !r.over) bits.push((g.settings.endAt - row.total) + ' to ' + g.settings.endAt);
    if (g.kind === 'golf') { var d = C.toPar(g, side.id); if (d !== null) bits.push(C.parLine(d) + ' to par'); }
    if (g.kind === 'cribbage' && !r.over) bits.push((C.cribBoard(g).to - row.total) + ' to go');
    if (g.kind === 'bowling') { var rl = g.data.rolls[side.id] || []; if (C.bowlNext(rl)) bits.push('can reach ' + C.bowlMax(rl)); }
    return bits.join(' · ');
  }
  function whoCell(g, r, side, extra) {
    var total = r.totals[side.id];
    return '<div class="who"><span class="emo" aria-hidden="true">' + esc(side.emoji) + '</span><b>' + esc(side.name) + '</b></div>' +
      '<span class="tot num">' + esc(g.kind === 'darts' ? String(total) : fmt(total)) + '</span>' + (extra || '') + '<small>' + esc(placeLine(g, r, side)) + '</small>';
  }
  function rowClass(r, side, turnSid) { return (r.leaders.indexOf(side.id) >= 0 && r.rows.length > 1 ? 'lead ' : '') + (turnSid === side.id ? 'turn' : ''); }
  function initial(name) { return Array.from(String(name || '?'))[0].toUpperCase(); }
  function dealerHere(g, rIdx) { var d = C.dealerFor(g, rIdx); return d ? d.person : null; }

  function head(g, r) {
    var info = C.infoOf(g), ed = canScore(g);
    var pill = watching(g) ? '<span class="pill p-live">Watching</span>' : r.over ? '<span class="pill p-done">Finished</span>' : '<span class="pill p-play">Playing</span>';
    var out = '<section class="card gamehead"><div class="title"><span class="emo" aria-hidden="true">' + esc(info.emoji) + '</span><h1>' + esc(g.name) + '</h1>' + pill + '</div>';
    out += '<p class="statusline" style="margin:0" aria-live="polite">' + (r.leaders.length && C.started(g) ? '<span class="crown" aria-hidden="true">\u{1F451}</span>' : '') + esc(r.wait || r.line) + (r.extra ? ' ' + esc(r.extra) : '') + '</p>';
    if (r.wait) out += '<p class="warnline" style="margin:0">' + esc(r.wait) + '</p>';
    if (C.usesDealer(g) && !r.over) {
      var n = g.kind === 'any' ? g.data.rounds.length : g.data.hands.length;
      var d = dealerHere(g, n);
      if (d) out += '<p class="dealline" style="margin:0">\u{1F0A0} ' + esc(d.name) + ' deals ' + (g.kind === 'any' ? 'round ' : 'hand ') + (n + 1) + (g.kind === 'hearts' ? ' · ' + esc(C.passFor(g, n)) : '') + (g.kind === 'cribbage' ? ' · the crib is ' + esc(C.sideOf(g, C.dealerFor(g, n).side).name) + '’s' : '') + '</p>';
    }
    var nx = C.nextUp(g);
    if (nx && !r.over) out += '<p class="dealline" style="margin:0">Up next: <b>' + esc(C.sideOf(g, nx.sid).name) + '</b></p>';
    out += '<div class="toolbar">';
    var w = g.shared ? (g.shared.members || []).filter(function (m) { return m.role === 'watcher'; }).length : 0;
    if (ed) {
      out += '<button class="tb" type="button" data-act="undo"' + (C.canUndo(g) ? '' : ' disabled') + '><span aria-hidden="true">\u21B6</span>Undo</button>';
      out += '<button class="tb" type="button" data-act="redo"' + (C.canRedo(g) ? '' : ' disabled') + '><span aria-hidden="true">\u21B7</span>Redo</button>';
      out += '<button class="tb" type="button" data-act="' + (g.shared ? 'invite' : 'share') + '"><span aria-hidden="true">\u{1F4E1}</span>' + (g.shared ? 'Live \u00B7 ' + w : 'Show') + '</button>';
      out += '<button class="tb" type="button" data-act="players"><span aria-hidden="true">\u{1F465}</span>Players</button>';
    }
    out += '<button class="tb" type="button" data-act="gamemenu" aria-label="More for this game"><span aria-hidden="true">\u22EF</span>More</button>';
    out += '</div></section>';
    return out;
  }
  function liveBar(g) {
    var sc = (g.shared.members || []).filter(function (m) { return m.role === 'scorer'; })[0];
    if (state.offline) return '<p class="offline-bar" role="status">You’re offline - this is the table as of ' + esc(timeOf(g.shared.at || now())) + '. Live updates need the network.</p>';
    return '<div class="livebar" role="status"><span><span class="dot" aria-hidden="true"></span>Live - ' + esc(sc ? sc.name : 'someone') + ' keeps score · updated ' + esc(timeOf(g.shared.at || now())) + '</span><button class="btn small ghost" type="button" data-act="leave">Leave</button></div>';
  }
  function sharedBar(g) {
    if (state.offline || state.unsent[g.id]) return '<p class="offline-bar" role="status">You’re offline - the scores are saved here and go to the table when the internet is back.</p>';
    var w = (g.shared.members || []).filter(function (m) { return m.role === 'watcher'; });
    return '<div class="livebar" role="status"><span><span class="dot" aria-hidden="true"></span>Shown live · code <b>' + esc(C.formatCode(g.shared.code)) + '</b> · ' + (w.length ? esc(C.listNames(w.map(function (m) { return m.name; }))) + ' watching' : 'nobody watching yet') + '</span><button class="btn small ghost" type="button" data-act="invite">Invite</button></div>';
  }
  function winPanel(g, r) {
    var hl = C.highlights(g);
    var medal = function (p) { return p === 1 ? '\u{1F947}' : p === 2 ? '\u{1F948}' : p === 3 ? '\u{1F949}' : String(p); };
    return '<section class="win" aria-labelledby="winT"><div class="trophy" aria-hidden="true">\u{1F3C6}</div><h2 id="winT">' + esc(r.line) + '</h2>' + (r.extra ? '<p>' + esc(r.extra) + '</p>' : '') +
      '<div class="podium">' + r.rows.map(function (row) {
        return '<div class="pl' + (row.place === 1 ? ' first' : '') + '"><span aria-hidden="true">' + medal(row.place) + '</span><span class="emo" aria-hidden="true">' + esc(row.side.emoji) + '</span><span>' + esc(row.side.name) + '</span><b class="t">' + esc(g.kind === 'darts' ? (row.total === 0 ? 'Out' : row.total + ' left') : fmt(row.total)) + '</b></div>';
      }).join('') + '</div>' +
      (hl.length ? '<ul class="hl" style="text-align:left">' + hl.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="row" style="justify-content:center;margin-top:14px"><button class="btn white" type="button" data-act="recap">\u{1F5BC} Recap card</button>' + (canScore(g) ? '<button class="btn line" type="button" data-act="rematch">Rematch</button>' : '') + '<button class="btn line" type="button" data-act="tab" data-tab="table">Our table</button></div></section>';
  }
  function viewGame(g) {
    var r = C.result(g);
    var out = '';
    if (watching(g)) out += liveBar(g);
    else if (g.shared) out += sharedBar(g);
    if (r.over) out += winPanel(g, r);
    out += '<div class="stack" style="margin-top:' + (r.over ? '14px' : '0') + '">' + head(g, r);
    var ed = canScore(g);
    if (g.kind === 'any') out += anyBody(g, r, ed);
    else if (g.kind === 'hearts') out += heartsBody(g, r, ed);
    else if (g.kind === 'cribbage') out += cribBody(g, r, ed);
    else if (g.kind === 'golf') out += golfBody(g, r, ed);
    else if (g.kind === 'dice') out += diceBody(g, r, ed);
    else if (g.kind === 'bowling') out += bowlBody(g, r, ed);
    else if (g.kind === 'darts') out += dartsBody(g, r, ed);
    out += '</div>';
    return out;
  }

  /* Any game: players down the side (held still), rounds across. */
  function anyBody(g, r, ed) {
    var rounds = g.data.rounds, n = rounds.length, add = ed && !r.over && n < C.LIMITS.rounds;
    var out = '<div class="sbox" data-end="1" role="region" aria-label="Score sheet" tabindex="0"><table class="sgrid"><thead><tr><th class="nm" scope="col">' + plural(n, 'round') + '</th>';
    rounds.forEach(function (row, i) {
      var d = g.settings.dealer ? dealerHere(g, i) : null;
      out += '<th scope="col">' + (ed ? '<button class="link-btn" type="button" data-act="roundmenu" data-r="' + i + '" style="min-height:32px;text-decoration:none" aria-label="Round ' + (i + 1) + (row.note ? ': ' + esc(row.note) : '') + '">' + (i + 1) + '</button>' : (i + 1)) + (d ? '<small>' + esc(initial(d.name)) + ' deals</small>' : '') + (row.note ? '<small>✎ note</small>' : '') + '</th>';
    });
    if (add) out += '<th scope="col">' + (n + 1) + '<small>next</small></th>';
    out += '</tr></thead><tbody>';
    g.sides.forEach(function (side) {
      out += '<tr class="' + rowClass(r, side, '') + '"><th class="nm" scope="row">' + whoCell(g, r, side) + '</th>';
      rounds.forEach(function (row, i) {
        if (!C.inRound(side, i)) { out += '<td><span class="cell out" style="display:grid;place-items:center">–</span></td>'; return; }
        var v = row.s[side.id];
        var has = Number.isInteger(v);
        out += '<td>' + (ed ? '<button class="cell' + (has ? (v < 0 ? ' neg' : '') : ' empty') + '" type="button" data-act="cell" data-r="' + i + '" data-sid="' + esc(side.id) + '" aria-label="' + esc(side.name + ', round ' + (i + 1) + ': ' + (has ? v : 'empty')) + '">' + (has ? esc(fmt(v)) : '·') + '</button>' : '<span class="cell' + (has ? '' : ' empty') + '" style="display:grid;place-items:center">' + (has ? esc(fmt(v)) : '·') + '</span>') + '</td>';
      });
      if (add) out += '<td><button class="cell new" type="button" data-act="cell" data-r="' + n + '" data-sid="' + esc(side.id) + '" aria-label="' + esc(side.name + ', round ' + (n + 1)) + '">+</button></td>';
      out += '</tr>';
    });
    out += '</tbody></table></div>';
    if (add) out += '<button class="btn big block" type="button" data-act="cell" data-r="' + (rounds.length && !C.roundDone(g, rounds, n - 1) ? n - 1 : n) + '" data-sid="' + esc(firstBlank(g)) + '">' + (rounds.length && !C.roundDone(g, rounds, n - 1) ? 'Finish round ' + n : 'Score round ' + (n + 1)) + '</button>';
    if (ed && C.SHEET_KINDS.indexOf(g.kind) >= 0 && !r.over) out += aiNudge(g);
    return out;
  }
  function firstBlank(g) {
    var rounds = g.data.rounds, n = rounds.length;
    var r = n && !C.roundDone(g, rounds, n - 1) ? n - 1 : n;
    var row = rounds[r];
    var s = g.sides.filter(function (x) { return C.inRound(x, r) && (!row || !Number.isInteger(row.s[x.id])); })[0];
    return (s || g.sides[0]).id;
  }
  function aiNudge(g) {
    return '<p class="muted small" style="margin:0">Kept some rounds on paper? <button class="link-btn" type="button" data-act="ainow">Read the sheet in</button></p>';
  }

  /* Hearts: a hand at a time, the 26 checked, the moon in one tap. */
  function heartsBody(g, r, ed) {
    var hands = g.data.hands, n = hands.length;
    var out = '<div class="sbox" data-end="1" role="region" aria-label="Score sheet" tabindex="0"><table class="sgrid"><thead><tr><th class="nm" scope="col">' + plural(n, 'hand') + '</th>';
    hands.forEach(function (h, i) { out += '<th scope="col">' + (i + 1) + '<small>' + esc(C.passFor(g, i).replace('Keep your cards', 'Keep').replace('Pass ', '')) + '</small>' + (h.note ? '<small>✎</small>' : '') + '</th>'; });
    out += '</tr></thead><tbody>';
    g.sides.forEach(function (side) {
      out += '<tr class="' + rowClass(r, side, '') + '"><th class="nm" scope="row">' + whoCell(g, r, side, C.moonsOf(g, side.id) ? ' <span class="pill p-lead">\u{1F319} ' + C.moonsOf(g, side.id) + '</span>' : '') + '</th>';
      hands.forEach(function (h, i) {
        var v = h.s[side.id], has = Number.isInteger(v);
        var label = !C.inRound(side, i) ? '–' : h.moon === side.id ? '\u{1F319}' : has ? fmt(v) : '·';
        out += '<td' + (h.moon ? ' class="moonc"' : '') + '>' + (ed && C.inRound(side, i) ? '<button class="cell" type="button" data-act="hand" data-r="' + i + '" aria-label="' + esc('Hand ' + (i + 1) + ', ' + side.name + ': ' + (h.moon === side.id ? 'shot the moon' : (has ? v : 'empty'))) + '">' + esc(label) + '</button>' : '<span class="cell" style="display:grid;place-items:center">' + esc(label) + '</span>') + '</td>';
      });
      out += '</tr>';
    });
    out += '</tbody></table></div>';
    if (ed && !r.over) {
      out += '<div class="bigrow"><button class="btn big" type="button" data-act="hand">+ Hand ' + (n + 1) + '</button><button class="btn big moonbtn" type="button" data-act="moon">\u{1F319} Shot the moon</button></div>';
      out += '<p class="muted small" style="margin:0">Each hand’s points add up to 26 - Pencil checks. The game ends when someone reaches ' + g.settings.endAt + '; lowest wins. ' + aiNudge(g).replace(/^<p class="muted small" style="margin:0">|<\/p>$/g, '') + '</p>';
    }
    return out;
  }

  /* Cribbage: the board drawn, each hand as pegging, hands and the crib. */
  var PEG_COLOURS = ['#f4b73a', '#f1f5f9', '#ff9aa5'];
  function pegSvg(g) {
    var b = C.cribBoard(g), to = b.to, streets = 4, n = g.sides.length;
    var laneH = 15, gap = 14, W = 372;
    var H = streets * (n * laneH + gap) + 30;
    var x = function (j) { return 20 + j * 10.6 + Math.floor(j / 5) * 4.6; };
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('Peg board: ' + g.sides.map(function (s) { return s.name + ' on ' + b.totals[s.id]; }).join(', ') + ', to ' + to) + '">';
    for (var st = 0; st < streets; st++) {
      var y0 = 8 + st * (n * laneH + gap);
      out += '<text x="4" y="' + (y0 + n * laneH / 2 + 3) + '" font-size="8" font-weight="700" fill="#f6efe3" font-family="system-ui, sans-serif" transform="rotate(-90 4 ' + (y0 + n * laneH / 2) + ')" text-anchor="middle">' + (st * 30 + 1) + '-' + (st * 30 + 30) + '</text>';
      for (var k = 0; k < n; k++) {
        var y = y0 + k * laneH + laneH / 2;
        out += '<rect x="14" y="' + (y - 6.5) + '" width="' + (W - 28) + '" height="13" rx="6.5" fill="' + (k % 2 ? '#5a3a1c' : '#7a5230') + '"/>';
        for (var j = 0; j < 30; j++) out += '<circle cx="' + x(j).toFixed(1) + '" cy="' + y + '" r="2.4" fill="#2b1a0c"/>';
      }
    }
    var gy = H - 14;
    out += '<circle cx="' + (W / 2) + '" cy="' + gy + '" r="7" fill="#2b1a0c" stroke="#a87a4c" stroke-width="2"/><text x="' + (W / 2 + 12) + '" y="' + (gy + 3) + '" font-size="9" font-weight="800" fill="#f6efe3" font-family="system-ui, sans-serif">' + to + '</text>';
    var pos = function (p, k) {
      if (p >= to) return { x: W / 2, y: gy };
      var st2 = Math.floor((p - 1) / 30), j2 = (p - 1) % 30;
      return { x: x(j2), y: 8 + st2 * (n * laneH + gap) + k * laneH + laneH / 2 };
    };
    g.sides.forEach(function (s, k) {
      var c = PEG_COLOURS[k % PEG_COLOURS.length];
      var back = b.prev[s.id], front = b.totals[s.id];
      if (back > 0 && back < front) { var pb = pos(back, k); out += '<circle cx="' + pb.x.toFixed(1) + '" cy="' + pb.y + '" r="4.4" fill="none" stroke="' + c + '" stroke-width="2.2"/>'; }
      if (front > 0) { var pf = pos(front, k); out += '<circle cx="' + pf.x.toFixed(1) + '" cy="' + pf.y + '" r="5.6" fill="' + c + '" stroke="#1b1d1a" stroke-width="1.2"/>'; }
    });
    return out + '</svg>';
  }
  function cribBody(g, r, ed) {
    var hands = g.data.hands, n = hands.length, b = C.cribBoard(g);
    var out = '<section class="card stack"><div class="pegs">' + pegSvg(g) + '</div><div class="row small" style="gap:6px 14px">' + g.sides.map(function (s, k) { return '<span><span aria-hidden="true" style="display:inline-block;width:12px;height:12px;border-radius:50%;border:1px solid #1b1d1a;background:' + PEG_COLOURS[k % 3] + ';vertical-align:-1px"></span> ' + esc(s.name) + ' <b>' + b.totals[s.id] + '</b></span>'; }).join('') + '<span class="muted">Filled peg: now · ring: the peg behind</span></div></section>';
    out += '<div class="sbox" data-end="1" role="region" aria-label="Hands" tabindex="0"><table class="sgrid"><thead><tr><th class="nm" scope="col">' + plural(n, 'hand') + '</th>';
    hands.forEach(function (h, i) { var d = C.dealerFor(g, i); out += '<th scope="col">' + (i + 1) + '<small>' + esc(initial(d.person.name)) + '’s crib</small></th>'; });
    out += '</tr></thead><tbody>';
    g.sides.forEach(function (side) {
      out += '<tr class="' + rowClass(r, side, '') + '"><th class="nm" scope="row">' + whoCell(g, r, side) + '</th>';
      hands.forEach(function (h, i) {
        var d = C.dealerFor(g, i), mine = d.side === side.id;
        var v = (h.peg[side.id] || 0) + (h.hand[side.id] || 0) + (mine ? h.crib || 0 : 0);
        out += '<td><span class="cell" style="display:grid;place-items:center" title="' + esc('Pegging ' + (h.peg[side.id] || 0) + ', hand ' + (h.hand[side.id] || 0) + (mine ? ', crib ' + (h.crib || 0) : '')) + '">' + v + '</span></td>';
      });
      out += '</tr>';
    });
    out += '</tbody></table></div>';
    if (ed && !r.over) out += '<button class="btn big block" type="button" data-act="cribhand">+ Hand ' + (n + 1) + '</button>';
    return out;
  }

  /* Mini golf: holes across, par on top, strokes 1 to the limit. */
  function golfBody(g, r, ed) {
    var holes = g.data.holes;
    var out = '<div class="sbox" role="region" aria-label="Score card" tabindex="0"><table class="sgrid"><thead><tr><th class="nm" scope="col">Hole</th>';
    holes.forEach(function (h, i) { out += '<th scope="col">' + (i + 1) + '</th>'; });
    out += '</tr><tr><th class="nm" scope="row">Par</th>';
    holes.forEach(function (h, i) { out += '<th>' + (ed ? '<button class="cell' + (h.par ? '' : ' empty') + '" type="button" data-act="par" data-r="' + i + '" style="min-height:40px;height:40px;font-size:.95rem" aria-label="Par for hole ' + (i + 1) + ': ' + (h.par || 'not set') + '">' + (h.par || '–') + '</button>' : (h.par || '–')) + '</th>'; });
    out += '</tr></thead><tbody>';
    g.sides.forEach(function (side) {
      out += '<tr class="' + rowClass(r, side, '') + '"><th class="nm" scope="row">' + whoCell(g, r, side) + '</th>';
      holes.forEach(function (h, i) {
        var v = h.s[side.id], has = Number.isInteger(v);
        var txt = has ? (v === 1 ? '1★' : String(v)) : '·';
        out += '<td>' + (ed ? '<button class="cell' + (has ? '' : ' empty') + '" type="button" data-act="stroke" data-r="' + i + '" data-sid="' + esc(side.id) + '" aria-label="' + esc(side.name + ', hole ' + (i + 1) + ': ' + (has ? plural(v, 'stroke') : 'empty')) + '">' + esc(txt) + '</button>' : '<span class="cell" style="display:grid;place-items:center">' + esc(txt) + '</span>') + '</td>';
      });
      out += '</tr>';
    });
    out += '</tbody></table></div>';
    if (ed && !r.over) { var nh = nextHole(g); if (nh) out += '<button class="btn big block" type="button" data-act="stroke" data-r="' + nh.r + '" data-sid="' + esc(nh.sid) + '">Score hole ' + (nh.r + 1) + '</button>'; }
    out += '<p class="muted small" style="margin:0">Most strokes on a hole: ' + g.settings.max + '. ★ is a hole in one.</p>';
    return out;
  }
  function nextHole(g) {
    for (var i = 0; i < g.data.holes.length; i++) for (var k = 0; k < g.sides.length; k++) if (!Number.isInteger(g.data.holes[i].s[g.sides[k].id])) return { r: i, sid: g.sides[k].id };
    return null;
  }

  /* Five dice: tap the dice, the sheet shows what each box would score. */
  function dieSvg(n) {
    var P = { 1: [[50, 50]], 2: [[28, 28], [72, 72]], 3: [[26, 26], [50, 50], [74, 74]], 4: [[28, 28], [72, 28], [28, 72], [72, 72]], 5: [[26, 26], [74, 26], [50, 50], [26, 74], [74, 74]], 6: [[28, 24], [72, 24], [28, 50], [72, 50], [28, 76], [72, 76]] };
    return '<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="6" y="6" width="88" height="88" rx="18" fill="#ffffff" stroke="#1b1d1a" stroke-width="5"/>' + (P[n] || []).map(function (p) { return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="9" fill="' + (n === 1 ? '#a3222f' : '#1b1d1a') + '"/>'; }).join('') + '</svg>';
  }
  function diceFor(g) {
    if (state.diceFor && C.sideOf(g, state.diceFor) && C.diceSums(g.data.sheets[state.diceFor]).filled < C.BOXES.length) return state.diceFor;
    var nx = C.nextUp(g);
    return nx ? nx.sid : g.sides[0].id;
  }
  function diceBody(g, r, ed) {
    var sid = diceFor(g), dice = state.dice || [], full = dice.length === 5;
    var out = '';
    if (ed && !r.over) {
      var side = C.sideOf(g, sid), sh = g.data.sheets[sid];
      out += '<section class="card dicepad" aria-labelledby="dpT"><div class="sec-head" style="margin:0"><h2 id="dpT">' + esc(side.emoji + ' ' + C.possessive(side.name)) + ' turn</h2><span class="muted small">' + (C.diceSums(sh).filled + 1) + ' of 13</span></div>';
      if (g.sides.length > 1) out += '<div class="chips scroll" role="group" aria-label="Scoring for">' + g.sides.map(function (s) { return '<button class="chip" type="button" data-act="dicefor" data-sid="' + esc(s.id) + '" aria-pressed="' + (s.id === sid) + '"><span aria-hidden="true">' + esc(s.emoji) + '</span>' + esc(s.name) + '</button>'; }).join('') + '</div>';
      out += '<div class="hand" role="group" aria-label="The five dice">' + [0, 1, 2, 3, 4].map(function (i) { return dice[i] ? '<button type="button" data-act="dieout" data-i="' + i + '" aria-label="Take out a ' + dice[i] + '">' + dieSvg(dice[i]) + '</button>' : '<button type="button" class="blank" disabled aria-label="No die yet">' + (i + 1) + '</button>'; }).join('') + '</div>';
      out += '<div class="faces6" role="group" aria-label="Add a die">' + [1, 2, 3, 4, 5, 6].map(function (n) { return '<button type="button" data-act="die" data-n="' + n + '" aria-label="Add a ' + n + '"' + (full ? ' disabled' : '') + '>' + dieSvg(n) + '</button>'; }).join('') + '</div>';
      out += '<p class="small" style="margin:0"><b>Upper ' + C.diceSums(sh).upper + '</b> \u00B7 ' + esc(C.diceSums(sh).bonusLine) + '</p>';
      out += '<div class="row spread"><span class="small muted">' + (full ? 'Now tap a box on the sheet - it shows what each would score.' + (C.isJoker(dice, sh) ? ' Five of a kind again: a joker' + (g.settings.extra && sh.b.five === 50 ? ', +100 bonus' : '') + '.' : '') : 'Tap the five dice you kept - or tap any box to type a score.') + '</span>' + (dice.length ? '<button class="btn small ghost" type="button" data-act="diceclear">Clear dice</button>' : '') + '</div></section>';
    }
    out += '<div class="sbox" role="region" aria-label="Five dice sheet" tabindex="0"><table class="sgrid dsheet"><thead><tr><th class="nm" scope="col">Box</th>' + g.sides.map(function (s) { return '<th scope="col"' + (s.id === sid && !r.over ? ' style="color:var(--link)"' : '') + '><span class="emo" aria-hidden="true">' + esc(s.emoji) + '</span><br>' + esc(s.name) + '</th>'; }).join('') + '</tr></thead><tbody>';
    var sumRow = function (headHtml, fn, cls) { return '<tr class="sub"><th class="nm" scope="row">' + headHtml + '</th>' + g.sides.map(function (s) { return '<td class="' + (cls || '') + '">' + fn(s, C.diceSums(g.data.sheets[s.id])) + '</td>'; }).join('') + '</tr>'; };
    C.BOXES.forEach(function (bx, bi) {
      out += '<tr><th class="nm bx" scope="row"><b>' + esc(bx.label) + '</b><small>' + esc(bx.face ? 'Count the ' + bx.label.toLowerCase() : bx.hint) + '</small></th>';
      g.sides.forEach(function (s) {
        var sh2 = g.data.sheets[s.id], v = sh2.b[bx.id];
        if (Number.isInteger(v)) { out += '<td><button class="cell" type="button" data-act="boxfilled" data-sid="' + esc(s.id) + '" data-box="' + bx.id + '" aria-label="' + esc(s.name + ', ' + bx.label + ': ' + v) + '"' + (ed ? '' : ' disabled') + '>' + v + '</button></td>'; return; }
        if (!ed || r.over) { out += '<td><span class="cell empty" style="display:grid;place-items:center">·</span></td>'; return; }
        if (full && s.id === sid) {
          var p = C.diceScore(bx.id, dice, sh2);
          out += '<td><button class="cell ' + (p ? 'preview' : 'zero-prev') + '" type="button" data-act="box" data-sid="' + esc(s.id) + '" data-box="' + bx.id + '" aria-label="' + esc('Score ' + p + ' in ' + bx.label + ' for ' + s.name) + '">' + p + '</button></td>';
        } else out += '<td><button class="cell empty" type="button" data-act="box" data-sid="' + esc(s.id) + '" data-box="' + bx.id + '" aria-label="' + esc(s.name + ', ' + bx.label + ': empty - type a score') + '">·</button></td>';
      });
      out += '</tr>';
      if (bi === 5) {
        out += sumRow('Upper total', function (s, m) { return m.upper; });
        out += sumRow('Bonus <small style="font-weight:600">63+ = 35</small>', function (s, m) { return m.bonus ? '+35' : '<small style="font-weight:700">' + (m.bonusLine === 'No bonus this game' ? 'none' : m.toBonus + ' to go') + '</small>'; });
      }
    });
    if (g.settings.extra) out += sumRow('Bonus 100s', function (s, m) { var sh3 = g.data.sheets[s.id]; return (sh3.x ? '+' + sh3.x * 100 : '–') + (ed && !r.over && sh3.b.five === 50 ? ' <button class="btn small soft" type="button" data-act="extra" data-sid="' + esc(s.id) + '" style="min-height:36px;padding:0 8px">+100</button>' : ''); });
    out += sumRow('Total', function (s, m) { return '<b style="font-size:1.2rem">' + m.total + '</b>'; });
    out += '</tbody></table></div>';
    return out;
  }

  /* Bowling: ten frames, the keypad offers only the pins still standing. */
  function bowlFor(g) {
    if (state.bowlFor && C.sideOf(g, state.bowlFor) && C.bowlNext(g.data.rolls[state.bowlFor] || [])) return state.bowlFor;
    var nx = C.nextUp(g);
    return nx ? nx.sid : null;
  }
  function bowlBody(g, r, ed) {
    var sid = bowlFor(g);
    var out = '';
    out += '<div class="sbox" role="region" aria-label="Frames" tabindex="0"><table class="sgrid frames"><thead><tr><th class="nm" scope="col">Bowler</th>';
    for (var f = 1; f <= 10; f++) out += '<th scope="col">' + f + '</th>';
    out += '</tr></thead><tbody>';
    g.sides.forEach(function (side) {
      var fr = C.bowlFrames(g.data.rolls[side.id] || []), nx2 = C.bowlNext(g.data.rolls[side.id] || []);
      out += '<tr class="' + rowClass(r, side, sid) + '"><th class="nm" scope="row">' + whoCell(g, r, side) + '</th>';
      for (var k = 0; k < 10; k++) {
        var x = fr.frames[k];
        var curF = nx2 && nx2.frame === k + 1 && side.id === sid;
        var slots = k === 9 ? 3 : 2;
        var marks = x ? x.marks.slice() : [];
        if (k < 9 && marks.length === 1 && marks[0] === 'X') marks = ['', 'X'];
        while (marks.length < slots) marks.push('');
        out += '<td class="fr' + (curF ? ' cur' : '') + '"><div class="fbox" aria-label="' + esc('Frame ' + (k + 1) + (x ? ': ' + x.marks.join(' ') + (x.score !== null ? ', ' + x.score : '') : '')) + '"><div class="marks">' + marks.map(function (m) { return '<span>' + esc(m) + '</span>'; }).join('') + '</div><div class="run' + (x && x.score === null ? ' wait' : '') + '">' + (x ? (x.score === null ? '…' : x.score) : '') + '</div></div></td>';
      }
      out += '</tr>';
    });
    out += '</tbody></table></div>';
    if (ed && !r.over && sid) {
      var side = C.sideOf(g, sid), rl = g.data.rolls[sid] || [], nx = C.bowlNext(rl);
      out += '<section class="card stack" aria-labelledby="bpT"><div class="sec-head" style="margin:0"><h2 id="bpT">' + esc(side.emoji + ' ' + side.name) + ' · frame ' + nx.frame + ', ball ' + nx.ball + '</h2><span class="muted small">' + plural(nx.max, 'pin') + ' standing</span></div>';
      if (g.sides.length > 1) out += '<div class="chips scroll" role="group" aria-label="Bowling now">' + g.sides.filter(function (s) { return C.bowlNext(g.data.rolls[s.id] || []); }).map(function (s) { return '<button class="chip" type="button" data-act="bowlfor" data-sid="' + esc(s.id) + '" aria-pressed="' + (s.id === sid) + '"><span aria-hidden="true">' + esc(s.emoji) + '</span>' + esc(s.name) + '</button>'; }).join('') + '</div>';
      out += '<div class="pins" role="group" aria-label="Pins knocked down">';
      if (nx.strike) out += '<button class="mark" type="button" data-act="pins" data-n="10" aria-label="Strike">X</button>';
      if (nx.spare) out += '<button class="mark" type="button" data-act="pins" data-n="' + nx.max + '" aria-label="Spare">/</button>';
      for (var p = 0; p < nx.max; p++) out += '<button type="button" data-act="pins" data-n="' + p + '" aria-label="' + plural(p, 'pin') + '">' + (p === 0 ? '–' : p) + '</button>';
      out += '</div><p class="muted small" style="margin:0">X is a strike, / a spare, – a miss. Only the pins still standing are offered.</p></section>';
    }
    return out;
  }

  /* Darts: count down, busts called, a checkout shown from 170 down. */
  function dartsFor(g) {
    if (state.dartsFor && C.sideOf(g, state.dartsFor)) return state.dartsFor;
    var nx = C.nextUp(g);
    return nx ? nx.sid : g.sides[0].id;
  }
  function coLine(left, dbl) {
    var c = left <= 180 ? C.checkout(left, dbl) : null;
    return c ? '<div class="checkout"><b>Checkout</b>' + c.map(function (d) { return '<span>' + esc(d) + '</span>'; }).join('') + '</div>' : (dbl && left <= 170 && left > 1 ? '<div class="checkout"><b>No three-dart finish from ' + left + '</b></div>' : '');
  }
  function dartsBody(g, r, ed) {
    var sid = dartsFor(g), dbl = g.settings.doubleOut;
    var out = '<div class="dcards">' + g.sides.map(function (s) {
      var left = C.dartsLeft(g, s.id), t = g.data.turns[s.id] || [], avg = C.dartsAverage(g, s.id);
      return '<div class="dcard' + (s.id === sid && !r.over ? ' turn' : '') + '"><div class="who"><span class="emo" aria-hidden="true">' + esc(s.emoji) + '</span><b>' + esc(s.name) + '</b>' + (r.leaders.indexOf(s.id) >= 0 && C.started(g) && g.sides.length > 1 ? '<span class="crownb" aria-label="leads">\u{1F451}</span>' : '') + '</div><div class="left" aria-label="' + left + ' left">' + left + '</div><small>' + (avg === null ? 'No darts yet' : 'avg ' + avg + ' a turn · ' + plural(t.length, 'turn')) + '</small>' +
        (t.length ? '<div class="last">' + t.slice(-5).map(function (x) { return '<span class="' + (x.b ? 'bust' : '') + '">' + (x.b ? 'bust ' : '') + x.s + '</span>'; }).join('') + '</div>' : '') +
        (!r.over && s.id === sid ? coLine(left, dbl) : '') + '</div>';
    }).join('') + '</div>';
    if (ed && !r.over) {
      var side = C.sideOf(g, sid), left = C.dartsLeft(g, sid), typed = state.dartIn || '';
      out += '<section class="card stack" aria-labelledby="dtT"><div class="sec-head" style="margin:0"><h2 id="dtT">' + esc(side.emoji + ' ' + C.possessive(side.name)) + ' turn · ' + left + ' left</h2></div>';
      if (g.sides.length > 1) out += '<div class="chips scroll" role="group" aria-label="Throwing now">' + g.sides.map(function (s) { return '<button class="chip" type="button" data-act="dartsfor" data-sid="' + esc(s.id) + '" aria-pressed="' + (s.id === sid) + '"><span aria-hidden="true">' + esc(s.emoji) + '</span>' + esc(s.name) + '</button>'; }).join('') + '</div>';
      if (state.dartAsk) {
        out += '<div class="note"><p style="margin:0 0 8px"><b>' + esc(state.dartAsk) + ' checks out ' + left + '.</b> Was the last dart a double' + (left === 50 || left <= 40 ? '' : ' (or the bull)') + '?</p><div class="bigrow"><button class="btn big" type="button" data-act="ddouble" data-yes="1">Yes - game shot</button><button class="btn big ghost" type="button" data-act="ddouble" data-yes="">No - bust</button></div></div>';
      } else {
        out += '<div class="kp-show"><b aria-live="polite">' + esc(typed || '—') + '</b><small>score this turn<br>0 to 180</small></div>';
        out += '<div class="kp-quick">' + [26, 41, 45, 60, 81, 85, 100, 140, 180].map(function (q) { return '<button type="button" data-act="dq" data-n="' + q + '">' + q + '</button>'; }).join('') + (left <= 180 ? '<button type="button" data-act="dq" data-n="' + left + '">' + left + ' out</button>' : '') + '</div>';
        out += '<div class="kp">' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (d) { return '<button type="button" data-act="dk" data-k="' + d + '">' + d + '</button>'; }).join('') + '<button class="fn" type="button" data-act="dk" data-k="c" aria-label="Clear">C</button><button type="button" data-act="dk" data-k="0">0</button><button class="fn" type="button" data-act="dk" data-k="b" aria-label="Delete">⌫</button></div>';
        out += '<button class="btn big block" type="button" data-act="dscore"' + (typed === '' ? ' disabled' : '') + '>Score ' + esc(typed || 'it') + '</button>';
      }
      out += '<p class="muted small" style="margin:0">' + (dbl ? 'Finish on a double. Going below zero, to 1, or to zero without a double is a bust - the turn scores nothing.' : 'Any dart can finish. Going below zero is a bust.') + '</p></section>';
    }
    return out;
  }

  /** After a game is drawn: a long sheet scrolls to where the play is. */
  function bindGame(g) {
    if (!g) return;
    if (g.kind === 'golf') {
      var nh = nextHole(g), box = $('.sbox');
      var cell = nh && box ? $('[data-act="stroke"][data-r="' + nh.r + '"]', box) : null;
      if (cell) box.scrollLeft = Math.max(0, cell.closest('td').offsetLeft - 200);
    }
    if (g.kind === 'dice') {
      var pv = $('.dsheet .cell.preview, .dsheet .cell.zero-prev'), box3 = $('.sbox');
      if (pv && box3) box3.scrollLeft = Math.max(0, pv.closest('td').offsetLeft - 130);
    }
    if (g.kind === 'bowling') {
      var cur3 = $('.fr.cur'), box2 = $('.sbox');
      if (cur3 && box2) box2.scrollLeft = Math.max(0, cur3.offsetLeft - 220);
    }
  }

  /* ---------------- changing a game ---------------- */

  /** Every change goes through the core's change(): undo-able, and the
   *  game settles (finishes) by its own rules. */
  function act(g, fn, msg) {
    if (!canScore(g)) { toast('Only whoever holds the pencil keeps score.'); return null; }
    var was = g.status;
    try {
      var res = C.change(g, fn, o());
      if (res.game !== g) {
        putGame(res.game);
        if (was !== 'done' && res.game.status === 'done') celebrate(res.game);
      }
      draw();
      if (msg) say(msg);
      return res;
    } catch (err) { showError(err); return null; }
  }
  function celebrate(g) {
    state.celebrated[g.id] = true;
    var r = C.result(g);
    say(r.line);
    if (reducedMotion()) return;
    var box = $('#confetti');
    if (!box) return;
    box.innerHTML = '';
    var cols = ['#0f5f48', '#a3222f', '#f4b73a', '#2563eb', '#ffffff', '#16a34a'];
    for (var i = 0; i < 70; i++) {
      var p = document.createElement('i');
      p.style.left = (rand(1000) / 10) + '%';
      p.style.background = cols[i % cols.length];
      p.style.animationDelay = (rand(900) / 1000) + 's';
      p.style.transform = 'rotate(' + rand(360) + 'deg)';
      box.appendChild(p);
    }
    setTimeout(function () { box.innerHTML = ''; }, 4600);
  }

  /* The keypad: a big display, the game's quick numbers, digits, +/-. */
  function openKeypad(spec) {
    state.kp = { spec: spec, s: spec.value === null || spec.value === undefined ? '' : String(spec.value) };
    sheet('<div class="body"></div>', drawKeypad);
  }
  function kpValue() {
    var s = state.kp.s;
    if (s === '' || s === '-') return null;
    return Number(s);
  }
  function drawKeypad(root) {
    var k = state.kp, sp = k.spec, body = $('.body', root);
    var shown = k.s === '' ? '—' : k.s.replace('-', '−');
    if (sp.strokes) {
      body.innerHTML = '<h2>' + esc(sp.title) + '</h2>' + (sp.sub ? '<p class="muted small">' + esc(sp.sub) + '</p>' : '') +
        '<div class="strokes">' + sp.strokes.map(function (n) { return '<button type="button" data-kq="' + n + '"' + (String(n) === k.s ? ' aria-pressed="true" style="border-color:var(--accent)"' : '') + '>' + n + (sp.par ? '<small>' + esc(C.parLine(n - sp.par) === 'E' ? 'par' : C.parLine(n - sp.par)) + '</small>' : '') + '</button>'; }).join('') + '</div>' +
        '<div id="kpErr"></div><div class="row" style="margin-top:10px"><button class="btn ghost" type="button" data-kk="none">Clear</button>' + (sp.next ? '<span class="small muted">Next: ' + esc(sp.next.label) + '</span>' : '') + '</div>';
    } else {
      body.innerHTML = '<h2>' + esc(sp.title) + '</h2>' + (sp.sub ? '<p class="muted small" style="margin:0">' + esc(sp.sub) + '</p>' : '') +
        '<div class="kp-show"><b id="kpv" aria-live="polite">' + esc(shown) + '</b><small>' + esc(sp.hint || '') + '</small></div>' +
        (sp.quick && sp.quick.length ? '<div class="kp-quick" role="group" aria-label="Quick numbers">' + sp.quick.map(function (q) { return '<button type="button" data-kq="' + q + '">' + esc(fmt(q)) + '</button>'; }).join('') + '</div>' : '') +
        (sp.only ? '' : '<div class="kp">' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (d) { return '<button type="button" data-kk="' + d + '">' + d + '</button>'; }).join('') +
          (sp.neg ? '<button class="fn" type="button" data-kk="neg" aria-label="Plus or minus">±</button>' : '<button class="fn" type="button" data-kk="clear" aria-label="Clear">C</button>') +
          '<button type="button" data-kk="0">0</button><button class="fn" type="button" data-kk="back" aria-label="Delete">⌫</button></div>') +
        '<div id="kpErr"></div><div class="kp-acts"><button class="btn ghost big" type="button" data-kk="none">' + (sp.clearLabel || 'Clear') + '</button><button class="btn big" type="button" data-kk="save">' + (sp.next ? 'Save · ' + esc(sp.next.label) + ' →' : 'Save') + '</button></div>' +
        (sp.next ? '<p class="center" style="margin:6px 0 0"><button class="link-btn" type="button" data-kk="saveonly">Save and close</button></p>' : '');
    }
    $$('[data-kq]', body).forEach(function (b) { b.addEventListener('click', function () { k.s = b.getAttribute('data-kq'); kpSave(true); }); });
    $$('[data-kk]', body).forEach(function (b) { b.addEventListener('click', function () { kpKey(b.getAttribute('data-kk')); }); });
  }
  function kpKey(key) {
    var k = state.kp; if (!k) return;
    if (/^\d$/.test(key)) { var neg = k.s.charAt(0) === '-'; var digits = (neg ? k.s.slice(1) : k.s) + key; digits = digits.replace(/^0+(?=\d)/, ''); if (digits.length > 5) return; k.s = (neg ? '-' : '') + digits; }
    else if (key === 'back') k.s = k.s.slice(0, -1);
    else if (key === 'clear') k.s = '';
    else if (key === 'neg') k.s = k.s.charAt(0) === '-' ? k.s.slice(1) : '-' + k.s;
    else if (key === 'none') { k.s = ''; return kpSave(false, true); }
    else if (key === 'save') return kpSave(true);
    else if (key === 'saveonly') return kpSave(false);
    var v = $('#kpv'); if (v) v.textContent = k.s === '' ? '—' : k.s.replace('-', '−');
  }
  function kpSave(andNext, clearing) {
    var k = state.kp, sp = k.spec, v = kpValue();
    if (v === null && !clearing && k.s !== '') return;
    if (v === null && !clearing && !sp.allowEmpty) { closeSheet(); state.kp = null; return; }
    var err = sp.check ? sp.check(v) : '';
    if (err) { var e = $('#kpErr'); if (e) e.innerHTML = '<p class="err" role="alert">' + esc(err) + '</p>'; return; }
    var ok = sp.save(v);
    if (ok === false) return;
    if (andNext && sp.next && v !== null) { var nx = sp.next; state.kp = null; nx.open(); return; }
    state.kp = null;
    closeSheet(true);
  }
  document.addEventListener('keydown', function (e) {
    if (!state.kp || $('#sheet').hidden) return;
    if (/^\d$/.test(e.key)) { e.preventDefault(); kpKey(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); kpKey('back'); }
    else if (e.key === '-' && state.kp.spec.neg) { e.preventDefault(); kpKey('neg'); }
    else if (e.key === 'Enter') { e.preventDefault(); kpSave(true); }
  });
  /** Saving a keypad goes through act(); a refusal stays on the keypad. */
  function kpAct(g, fn) {
    var live = gameById(g.id) || g;
    try { C.change(live, fn, o()); } catch (err) { var e = $('#kpErr'); if (e) e.innerHTML = '<p class="err" role="alert">' + esc(err.message) + '</p>'; return false; }
    act(live, fn);
    return true;
  }

  function openCell(g, r, sid) {
    var side = C.sideOf(g, sid); if (!side) return;
    var row = g.data.rounds[r];
    var val = row && Number.isInteger(row.s[sid]) ? row.s[sid] : null;
    var order = g.sides.filter(function (s) { return C.inRound(s, r); });
    var i = order.findIndex(function (s) { return s.id === sid; });
    var nextSide = i >= 0 && i < order.length - 1 ? order[i + 1] : null;
    var d = g.settings.dealer ? dealerHere(g, r) : null;
    openKeypad({
      title: side.emoji + ' ' + side.name + ' · round ' + (r + 1),
      sub: (d ? d.name + ' deals. ' : '') + (g.settings.fillZero ? 'The other team gets 0 for this hand.' : ''),
      hint: 'total now ' + fmt(C.totals(gameById(g.id))[sid]),
      value: val, neg: true, quick: g.settings.quick, clearLabel: 'Empty',
      save: function (v) { return kpAct(g, function (x) { C.setCell(x, r, sid, v); }); },
      allowEmpty: true,
      next: nextSide ? { label: 'next: ' + nextSide.name, open: function () { openCell(gameById(g.id), r, nextSide.id); } } : null,
    });
  }
  function openStroke(g, hole, sid) {
    var side = C.sideOf(g, sid); if (!side) return;
    var h = g.data.holes[hole];
    var strokes = []; for (var n = 1; n <= g.settings.max; n++) strokes.push(n);
    var i = g.sides.findIndex(function (s) { return s.id === sid; });
    var nxt = i < g.sides.length - 1 ? { r: hole, sid: g.sides[i + 1].id } : (hole + 1 < g.data.holes.length ? { r: hole + 1, sid: g.sides[0].id } : null);
    openKeypad({
      title: side.emoji + ' ' + side.name + ' · hole ' + (hole + 1),
      sub: (h.par ? 'Par ' + h.par + '. ' : '') + 'A ball still out after ' + g.settings.max + ' strokes scores ' + g.settings.max + '.',
      value: Number.isInteger(h.s[sid]) ? h.s[sid] : null, strokes: strokes, par: h.par, allowEmpty: true,
      save: function (v) { return kpAct(g, function (x) { C.setStroke(x, hole, sid, v); }); },
      next: nxt ? { label: (nxt.r === hole ? C.sideOf(g, nxt.sid).name : 'hole ' + (nxt.r + 1)), open: function () { var live = gameById(g.id); if (live && !C.result(live).over) openStroke(live, nxt.r, nxt.sid); } } : null,
    });
  }
  function openPar(g, hole) {
    var strokes = []; for (var n = 1; n <= 6; n++) strokes.push(n);
    openKeypad({ title: 'Par for hole ' + (hole + 1), sub: 'Par is what the course says a hole should take.', value: g.data.holes[hole].par, strokes: strokes, allowEmpty: true,
      save: function (v) { return kpAct(g, function (x) { C.setPar(x, hole, v); }); },
      next: hole + 1 < g.data.holes.length ? { label: 'hole ' + (hole + 2), open: function () { openPar(gameById(g.id), hole + 1); } } : null });
  }
  function openRoundMenu(g, r) {
    var row = g.data.rounds[r]; if (!row) return;
    sheet('<h2>Round ' + (r + 1) + '</h2><form id="rnForm" class="stack"><label class="field"><span>A note for this round</span><input class="input" id="rnNote" maxlength="' + C.LIMITS.note + '" value="' + esc(row.note) + '" placeholder="Misdeal, Kai’s big comeback…"></label><div class="row"><button class="btn" type="submit">Save note</button><button class="btn danger" type="button" id="rnClear">Empty this round</button></div></form>', function (root) {
      $('#rnForm', root).addEventListener('submit', function (e) { e.preventDefault(); var t = $('#rnNote', root).value; closeSheet(true); act(gameById(g.id), function (x) { C.setNote(x, r, t); }, 'Note saved.'); });
      $('#rnClear', root).addEventListener('click', function () { closeSheet(true); act(gameById(g.id), function (x) { if (!x.data.rounds[r]) return; x.data.rounds[r].s = {}; C.setCell(x, r, x.sides[0].id, null); }, 'Round emptied.'); });
    });
  }

  /* Hearts: one sheet per hand. */
  function openHeartsHand(g, r) {
    var editing = Number.isInteger(r) && g.data.hands[r];
    var idx = editing ? r : g.data.hands.length;
    var d = dealerHere(g, idx);
    var h = editing ? g.data.hands[r] : { s: {}, moon: '', note: '' };
    var sides = g.sides.filter(function (s) { return C.inRound(s, idx); });
    sheet('<h2>Hand ' + (idx + 1) + '</h2><p class="muted small" style="margin:0">' + esc((d ? d.name + ' deals. ' : '') + C.passFor(g, idx) + '.') + '</p>' +
      '<div class="field" style="margin:12px 0"><span>\u{1F319} Did anyone shoot the moon?</span><div class="moonrow">' + sides.map(function (s) { return '<button class="moonbtn" type="button" data-moonsid="' + esc(s.id) + '">' + esc(s.emoji + ' ' + s.name) + '</button>'; }).join('') + '</div><span class="hint">' + (g.settings.moon === 'subtract' ? 'The shooter takes 26 off; everyone else scores 0.' : 'The shooter scores 0; everyone else takes 26.') + '</span></div>' +
      '<form id="hForm"><div>' + sides.map(function (s) { var v = h.s[s.id]; return '<label class="hrow"><span class="who"><span class="emo" aria-hidden="true">' + esc(s.emoji) + '</span><b>' + esc(s.name) + '</b></span><input class="input" type="number" inputmode="numeric" min="0" max="26" data-hp="' + esc(s.id) + '" value="' + (Number.isInteger(v) && !h.moon ? v : '') + '" aria-label="' + esc(s.name + '’s points') + '"></label>'; }).join('') + '</div>' +
      '<p class="sumline" id="hSum" role="status"></p>' +
      '<label class="field"><span>Note (optional)</span><input class="input" id="hNote" maxlength="' + C.LIMITS.note + '" value="' + esc(h.note || '') + '"></label>' +
      '<div id="hErr"></div><button class="btn big block" type="submit" style="margin-top:10px">' + (editing ? 'Save hand ' + (idx + 1) : 'Add hand ' + (idx + 1)) + '</button></form>', function (root) {
      var inputs = $$('[data-hp]', root);
      var sum = function () { var t = 0, any = false; inputs.forEach(function (i) { var v = parseInt(i.value, 10); if (isFinite(v)) { t += v; any = true; } }); var el = $('#hSum', root); el.textContent = any ? (t === 26 ? 'Adds up to 26 ✓' : 'Adds up to ' + t + ' - a hand is 26') : 'A hand’s points add up to 26.'; el.className = 'sumline ' + (t === 26 ? 'ok' : any ? 'off' : ''); };
      inputs.forEach(function (i, k) { i.addEventListener('input', sum); i.addEventListener('keydown', function (e) { if (e.key === 'Enter' && k < inputs.length - 1) { e.preventDefault(); inputs[k + 1].focus(); } }); });
      sum();
      $$('[data-moonsid]', root).forEach(function (b) { b.addEventListener('click', function () { var sid = b.getAttribute('data-moonsid'); closeSheet(true); saveHand(g, editing ? r : null, { moon: sid }); }); });
      $('#hForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var s = {};
        inputs.forEach(function (i) { s[i.getAttribute('data-hp')] = i.value.trim() === '' ? 0 : Number(i.value); });
        var input = { s: s, note: $('#hNote', root).value };
        try { C.heartsHand(gameById(g.id), input); } catch (err) { showError(err, $('#hErr', root)); return; }
        closeSheet(true);
        saveHand(g, editing ? r : null, input);
      });
      setTimeout(function () { try { if (inputs[0] && !editing) inputs[0].focus({ preventScroll: true }); } catch (err) { /* ignore */ } }, 60);
    });
  }
  function saveHand(g, r, input) {
    var res = act(gameById(g.id), function (x) { return r === null ? C.addHand(x, input) : C.editHand(x, r, input); });
    if (!res) return;
    var h = res.out;
    if (input.moon) toast('\u{1F319} ' + C.sideOf(g, input.moon).name + ' shot the moon!', 3200);
    else if (h && !h.ok) toast(C.heartsCheckLine(h.sum), 5200);
  }
  function openMoon(g) {
    var sides = g.sides.filter(function (s) { return C.inRound(s, g.data.hands.length); });
    sheet('<h2>\u{1F319} Who shot the moon?</h2><p class="muted small">Hand ' + (g.data.hands.length + 1) + '. ' + (g.settings.moon === 'subtract' ? 'They take 26 off; everyone else scores 0.' : 'They score 0; everyone else takes 26.') + '</p><div class="stack">' + sides.map(function (s) { return '<button class="btn big ghost block" type="button" data-act="moonby" data-sid="' + esc(s.id) + '">' + esc(s.emoji + ' ' + s.name) + '</button>'; }).join('') + '</div>');
  }

  /* Cribbage: one sheet per hand. */
  function openCribHand(g) {
    var idx = g.data.hands.length, d = C.dealerFor(g, idx), dealer = C.sideOf(g, d.side);
    sheet('<h2>Hand ' + (idx + 1) + '</h2><p class="muted small" style="margin:0">' + esc(d.person.name) + ' deals - the crib is ' + esc(C.possessive(dealer.name)) + '. Counted in order: pegging, the hands from the dealer’s left, then the crib - the first to ' + C.cribBoard(g).to + ' wins on the spot.</p>' +
      '<form id="cForm"><div class="hrow three" style="margin-top:10px"><span></span><b class="small center">Pegging</b><b class="small center">Hand</b></div>' + g.sides.map(function (s) { return '<div class="hrow three"><span class="who"><span class="emo" aria-hidden="true">' + esc(s.emoji) + '</span><b>' + esc(s.name) + '</b></span><input class="input" type="number" inputmode="numeric" min="0" max="61" data-cp="' + esc(s.id) + '" aria-label="' + esc(s.name + ' pegging') + '"><input class="input" type="number" inputmode="numeric" min="0" max="29" data-ch="' + esc(s.id) + '" aria-label="' + esc(s.name + ' hand') + '"></div>'; }).join('') +
      '<div class="hrow"><span class="who"><b>' + esc(C.possessive(dealer.name)) + ' crib</b></span><input class="input" type="number" inputmode="numeric" min="0" max="29" id="cCrib" aria-label="The crib"></div>' +
      '<p class="hint">No hand of five cards counts 19, 25, 26 or 27.</p><div id="cErr"></div><button class="btn big block" type="submit">Add hand ' + (idx + 1) + '</button></form>', function (root) {
      $('#cForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var peg = {}, hand = {};
        $$('[data-cp]', root).forEach(function (i) { peg[i.getAttribute('data-cp')] = i.value.trim() === '' ? 0 : Number(i.value); });
        $$('[data-ch]', root).forEach(function (i) { hand[i.getAttribute('data-ch')] = i.value.trim() === '' ? 0 : Number(i.value); });
        var input = { peg: peg, hand: hand, crib: $('#cCrib', root).value.trim() === '' ? 0 : Number($('#cCrib', root).value) };
        try { C.cribHand(gameById(g.id), input); } catch (err) { showError(err, $('#cErr', root)); return; }
        closeSheet(true);
        act(gameById(g.id), function (x) { C.addCribHand(x, input); }, 'Hand ' + (idx + 1) + ' added.');
      });
    });
  }

  /* Five dice: a box, from the dice or typed. */
  function scoreBox(g, sid, box) {
    var sh = g.data.sheets[sid], dice = state.dice || [];
    if (Number.isInteger(sh.b[box])) return;
    // Five dice in hand score in whichever player's box is tapped.
    if (dice.length === 5) {
      var res = act(g, function (x) { return C.diceSet(x, sid, box, null, dice); });
      if (res) { state.dice = []; state.diceFor = null; var o2 = res.out; toast(C.sideOf(g, sid).name + ': ' + o2.score + ' in ' + C.boxInfo(box).label + (o2.bonus ? ' - and +100!' : ''), 2600); draw(); }
      return;
    }
    var info = C.boxInfo(box), allowed = [];
    for (var n = 0; n <= 50; n++) if (C.dicePossible(box, n)) allowed.push(n);
    var side = C.sideOf(g, sid);
    openKeypad({
      title: side.emoji + ' ' + side.name + ' · ' + info.label, sub: C.possibleLine(box), hint: '',
      value: null, quick: allowed.length <= 8 ? allowed : null, only: allowed.length <= 8,
      check: function (v) { return v === null || C.dicePossible(box, v) ? '' : C.possibleLine(box); },
      save: function (v) { if (v === null) return true; var ok = kpAct(g, function (x) { C.diceSet(x, sid, box, v); }); if (ok) { state.diceFor = null; } return ok; },
    });
  }

  /* Darts: a turn's total. */
  function dartsScore(g, sid, score, onDouble) {
    var left = C.dartsLeft(g, sid);
    var c = C.dartsCheck(left, score, g.settings.doubleOut, onDouble);
    if (c.error) { toast(c.error, 3600); return; }
    if (c.ask) { state.dartAsk = C.sideOf(g, sid).name; state.dartPending = score; draw(); return; }
    state.dartAsk = null; state.dartPending = null; state.dartIn = ''; state.dartsFor = null;
    act(g, function (x) { C.dartsTurn(x, sid, score, onDouble); });
    if (c.bust) toast(c.why, 3600);
  }

  /* ---------------- players, rules and the game's menu ---------------- */

  function openPlayers(g) {
    var b = bk(), used = {};
    g.sides.forEach(function (s) { s.people.forEach(function (p) { used[p.id] = 1; used['n' + C.norm(p.name)] = 1; }); });
    var recent = C.recentPeople(b.people, 12).filter(function (p) { return !used[p.id] && !used['n' + C.norm(p.name)]; });
    var canAdd = g.kind !== 'cribbage' && !(g.kind === 'any' && g.settings.teams) && g.sides.length < C.maxSides(g) && !C.result(g).over;
    var seats = C.seatsOf(g);
    var n = g.kind === 'any' ? g.data.rounds.length : g.data.hands ? g.data.hands.length : 0;
    var cur2 = C.usesDealer(g) ? C.dealerFor(g, n) : null;
    sheet('<h2>Players</h2><div>' + g.sides.map(function (s, i) {
      return '<div class="prow"><span class="emo" style="font-size:1.6rem;text-align:center" aria-hidden="true">' + esc(s.emoji) + '</span><span><b>' + esc(s.name) + '</b>' + (s.from ? '<small>Joined at round ' + (s.from + 1) + (s.start ? ', starting on ' + fmt(s.start) : '') + '</small>' : '') + '</span><span class="acts"><button class="iconbtn" type="button" data-act="srename" data-sid="' + esc(s.id) + '" aria-label="Rename ' + esc(s.name) + '">✎</button><button class="iconbtn" type="button" data-act="sup" data-sid="' + esc(s.id) + '" aria-label="Move ' + esc(s.name) + ' up"' + (i ? '' : ' disabled') + '>↑</button><button class="iconbtn" type="button" data-act="sdown" data-sid="' + esc(s.id) + '" aria-label="Move ' + esc(s.name) + ' down"' + (i < g.sides.length - 1 ? '' : ' disabled') + '>↓</button><button class="iconbtn" type="button" data-act="sdrop" data-sid="' + esc(s.id) + '" aria-label="Take ' + esc(s.name) + ' out">×</button></span></div>';
    }).join('') + '</div>' +
      (cur2 ? '<div class="sheet-sec"><label class="field"><span>Who deals next?</span><select class="input" id="plDealer">' + seats.map(function (st, i) { return '<option value="' + i + '"' + (st.person.id === cur2.person.id ? ' selected' : '') + '>' + esc(st.person.emoji + ' ' + st.person.name) + '</option>'; }).join('') + '</select><span class="hint">The deal then moves one seat each round.</span></label></div>' : '') +
      (canAdd ? '<div class="sheet-sec"><h3>Someone arrived late?</h3><p class="small muted">' + (g.kind === 'any' || g.kind === 'hearts' ? 'They sit out the rounds already played and start on ' + (g.settings.late === 'zero' ? 'zero' : 'last place’s score') + ' (a rule you set when starting).' : 'They get a fresh ' + (g.kind === 'dice' ? 'sheet' : g.kind === 'bowling' ? 'ten frames' : g.kind === 'darts' ? 'start of ' + g.settings.start : 'card') + '.') + '</p><form class="addrow" id="lateF"><input class="input" id="lateName" maxlength="' + C.LIMITS.name + '" placeholder="First name"><button class="btn" type="submit">Add</button></form>' +
        (recent.length ? '<div class="chips" style="margin-top:8px">' + recent.map(function (p) { return '<button class="pchip" type="button" data-act="late" data-pid="' + esc(p.id) + '"><span aria-hidden="true">' + esc(p.emoji) + '</span>' + esc(p.name) + '</button>'; }).join('') + '</div>' : '') + '<div id="lateErr"></div></div>' : ''), function (root) {
      var dl = $('#plDealer', root);
      if (dl) dl.addEventListener('change', function () { act(gameById(g.id), function (x) { C.setDealer(x, Number(dl.value)); }, 'Dealer changed.'); openPlayers(gameById(g.id)); });
      var f = $('#lateF', root);
      if (f) f.addEventListener('submit', function (e) { e.preventDefault(); addLate(g, $('#lateName', root).value, null, $('#lateErr', root)); });
    });
  }
  function addLate(g, name, person, errBox) {
    var b = bk();
    var p = person;
    if (!p) {
      var clean = C.cleanName(name);
      if (!clean) { if (errBox) errBox.innerHTML = '<p class="err">Type a first name.</p>'; return; }
      var have = b.people.filter(function (x) { return C.norm(x.name) === C.norm(clean); })[0];
      p = have ? { id: have.id, name: have.name, emoji: have.emoji } : { id: C.freshId(rand, 'p', b.people.map(function (x) { return x.id; }), 8), name: clean, emoji: nextEmoji(g.sides.map(function (s) { return s.emoji; })) };
    }
    var live = gameById(g.id);
    try { C.change(live, function (x) { C.addSide(x, p, o()); }, o()); } catch (err) { if (errBox) showError(err, errBox); else showError(err); return; }
    touchPeople([p]);
    act(live, function (x) { C.addSide(x, p, o()); }, p.name + ' joined.');
    closeSheet(true);
    toast(p.name + ' joined the game.');
  }
  function rulesLine(g) {
    var s = g.settings;
    if (g.kind === 'any') return (s.win === 'low' ? 'Lowest wins' : 'Highest wins') + ' · ' + (s.end === 'target' ? 'ends at ' + s.target : s.end === 'rounds' ? plural(s.rounds, 'round') : 'ends when you finish it') + (s.teams ? ' · teams' : '') + (s.dealer ? ' · dealer moves round' : '');
    if (g.kind === 'hearts') return 'Ends at ' + s.endAt + ' · lowest wins · moon: ' + (s.moon === 'add' ? '+26 to everyone else' : '−26 for the shooter') + ' · a tie for lowest: ' + (s.tie === 'keep' ? 'keep playing' : 'shared');
    if (g.kind === 'dice') return 'Upper bonus 35 at 63 · ' + (s.extra ? 'extra five of a kind +100' : 'no extra bonus');
    if (g.kind === 'darts') return s.start + ' · ' + (s.doubleOut ? 'finish on a double' : 'any finish');
    if (g.kind === 'cribbage') return 'To ' + s.to + ' · skunk under 91, double under 61';
    if (g.kind === 'golf') return s.holes + ' holes · at most ' + s.max + ' strokes a hole';
    return 'Ten frames · 300 is perfect';
  }
  function openGameMenu(g) {
    var r = C.result(g), ed = canScore(g);
    sheet('<h2>' + esc(g.name) + '</h2><p class="small muted">' + esc(rulesLine(g)) + '</p><div class="stack">' +
      (C.started(g) ? '<button class="btn ghost block" type="button" data-act="recap">\u{1F5BC} Recap card</button>' : '') +
      (ed && !r.over && C.started(g) ? '<button class="btn ghost block" type="button" data-act="finish">\u{1F3C1} Finish now - the scores as they stand</button>' : '') +
      (ed && C.SHEET_KINDS.indexOf(g.kind) >= 0 && !r.over && !state.trying ? '<button class="btn ghost block ai" type="button" data-act="ainow"> Read a paper score sheet in</button>' : '') +
      (ed ? '<button class="btn ghost block" type="button" data-act="rematch">Rematch - same players</button>' : '') +
      (watching(g) ? '<button class="btn ghost block" type="button" data-act="leave">Leave this table</button>' : '<button class="btn danger block" type="button" data-act="delgame">Delete this game</button>') +
      '</div><p class="tiny muted" style="margin-top:12px">Started ' + esc(dayOf(g.createdAt)) + (g.finishedAt ? ' · finished ' + esc(timeOf(g.finishedAt)) : '') + '.</p>');
  }

  /* ---------------- showing the table ---------------- */

  function openShare(g) {
    if (state.trying) {
      sheet('<h2>\u{1F4E1} Show the table</h2><p>Everyone at the table watches the scores land on their own phone - a six-letter code, no accounts, no app.</p><p class="note">The made-up night can’t be shown. Start your own game to try it with real phones.</p><button class="btn" type="button" data-act="tryown">Start my own game</button>');
      return;
    }
    sheet('<h2>\u{1F4E1} Show the table</h2><p>Everyone at the table watches the scores land on their own phone - live, with a six-letter code. No accounts, no app. Only you keep score, and you can hand the pencil to someone else at any time.</p>' +
      '<div class="sent"><b>What goes to the table:</b> this game - its name, the players’ first names and emoji, and the scores. Nothing else: not your history, not your other games. It is deleted a day after the last score.</div>' +
      '<form id="shF" style="margin-top:12px"><label class="field"><span>Your first name, so they know who keeps score</span><input class="input" id="shName" maxlength="' + C.LIMITS.name + '" value="' + esc(prefs.me) + '" autocomplete="given-name"></label><div id="shErr"></div><button class="btn big block" type="submit" style="margin-top:10px">Show it</button></form>', function (root) {
      $('#shF', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var name = C.cleanName($('#shName', root).value);
        if (!name) { $('#shErr', root).innerHTML = '<p class="err">Type your first name.</p>'; return; }
        var btn = $('button[type=submit]', root); btn.disabled = true;
        var live = gameById(g.id);
        api('POST', 'api/tables', { game: C.shareGame(live), you: { name: name } }).then(function (r) {
          prefs.me = name; savePrefs();
          var now2 = gameById(g.id);
          now2.shared = { id: r.id, role: 'scorer', code: r.table.code, v: r.table.v, mv: r.table.mv || 0, at: now(), members: r.table.members };
          putGame(now2, { quiet: true });
          draw(); openInvite(now2);
        }).catch(function (err) { btn.disabled = false; showError(err, $('#shErr', root)); });
      });
    });
  }
  function openInvite(g) {
    var link = C.joinUrl(ORIGIN, BASE, g.shared.code);
    var watchers = (g.shared.members || []).filter(function (m) { return m.role === 'watcher'; });
    sheet('<h2>\u{1F4E1} The table is live</h2><p class="small muted">On another phone: scan this, or open Pencil and join with the code.</p><div class="code-big" aria-label="Code ' + esc(g.shared.code.split('').join(' ')) + '">' + esc(C.formatCode(g.shared.code)) + '</div><div class="qrbox">' + QR.svg(link, 'Join the table') + '</div>' +
      '<button class="btn block" type="button" data-act="sharelink">Send the link</button>' +
      '<div class="sheet-sec"><h3>Watching · ' + watchers.length + ' of ' + C.LIMITS.watchers + '</h3>' + (watchers.length ? watchers.map(function (m) { return '<div class="mrow"><span><b>' + esc(m.name) + '</b><small>watching</small></span><span class="row" style="gap:6px"><button class="btn small" type="button" data-act="pencil" data-mid="' + esc(m.id) + '">✏️ Hand the pencil</button><button class="btn small danger" type="button" data-act="rmwatch" data-mid="' + esc(m.id) + '" aria-label="Remove ' + esc(m.name) + '">Remove</button></span></div>'; }).join('') : '<p class="muted small">Nobody yet. Their names appear here as they join.</p>') + '</div>' +
      '<div class="sheet-sec"><button class="btn danger block" type="button" data-act="unshare">Stop sharing</button><p class="tiny muted">The game stays on this phone. Watchers can no longer open it.</p></div>');
  }
  /** A table as the server sends it, onto this phone: its game (kept under
   *  the scorer's game id, so the pencil can go back and forth) and who is
   *  at it. */
  function takeTable(t, msg) {
    var have = games.list.filter(function (x) { return x.id === (t.game && t.game.id); })[0];
    var g = C.cleanGame(t.game, { now: now() });
    if (!g) return null;
    var wasRole = have && have.shared ? have.shared.role : '';
    g.shared = { id: t.id, role: t.role, code: t.code || '', v: t.v, mv: t.mv || 0, at: now(), members: t.members };
    g.foreign = have ? Boolean(have.foreign) : true;
    g.group = have ? have.group : '';
    g.past = []; g.future = [];
    putGame(g, { quiet: true });
    if (wasRole && wasRole !== t.role) {
      var sc = (t.members || []).filter(function (m) { return m.role === 'scorer'; })[0];
      toast(t.role === 'scorer' ? '✏️ You have the pencil now - you keep score.' : (sc ? sc.name : 'Someone else') + ' has the pencil now.', 4200);
    } else if (msg) toast(msg, 4200);
    return g;
  }
  function sharedGone(g) {
    var live = gameById(g.id); if (!live || !live.shared) return;
    if (live.shared.role === 'scorer') { delete live.shared; putGame(live, { quiet: true }); toast('Sharing ended - the game is still on this phone.', 4200); }
    else { dropGame(live.id); toast('That table closed. Finished games stay in Our table.', 4200); if (state.view === 'game' && state.arg === live.id) go(''); }
    draw();
  }
  function pushShared(id) {
    if (state.trying) return;
    if (state.pushing[id]) { state.pushAgain[id] = true; return; }
    var g = gameById(id);
    if (!g || !g.shared || g.shared.role !== 'scorer') return;
    state.pushing[id] = true;
    api('PUT', 'api/t/' + g.shared.id + '/game', { game: C.shareGame(g), v: g.shared.v }).then(function (r) {
      var live = gameById(id); if (live && live.shared) { live.shared.v = r.v; live.shared.at = now(); saveGames(); }
      delete state.unsent[id];
    }).catch(function (err) {
      if (err.offline) { state.unsent[id] = true; return; }
      if (err.status === 409 && err.data && err.data.table) { delete state.unsent[id]; takeTable(err.data.table, 'The table changed on another phone - this is the latest.'); draw(); return; }
      if (err.status === 403 && err.data && err.data.code === 'not-scorer') { delete state.unsent[id]; refreshShared(gameById(id)).then(draw); return; }
      if (err.status === 404) { delete state.unsent[id]; sharedGone(g); return; }
      state.unsent[id] = true;
      toast(err.message, 4200);
    }).then(function () {
      state.pushing[id] = false;
      if (state.pushAgain[id]) { state.pushAgain[id] = false; pushShared(id); }
    });
  }
  var refreshing = null;
  function refreshShared(g) {
    if (!g || !g.shared || state.trying) return Promise.resolve(false);
    if (refreshing) return refreshing;
    var sh = g.shared;
    refreshing = api('GET', 'api/t/' + sh.id + '?since=' + sh.v + '&m=' + (sh.mv || 0)).then(function (r) {
      var live = gameById(g.id); if (!live || !live.shared) return false;
      live.shared.at = now();
      if (r.same) { saveGames(); return state.offline; }
      var t = r.table;
      if (t.v === live.shared.v && t.role === live.shared.role) { live.shared.members = t.members; live.shared.mv = t.mv || 0; if (t.code) live.shared.code = t.code; saveGames(); return true; }
      takeTable(t);
      return true;
    }).catch(function (err) {
      if (err.status === 404) { sharedGone(g); return true; }
      return Boolean(err.offline);
    }).then(function (x) { refreshing = null; return x; });
    return refreshing;
  }

  /* ---------------- joining a table ---------------- */

  function viewJoin() {
    var j = state.join || { code: '', info: null };
    if (!j.info) {
      return '<section class="card stack" style="max-width:520px;margin:0 auto"><h1>Join a table</h1><p class="muted">Watch someone’s game live on this phone. Ask them for the six-letter code on their screen.</p>' +
        '<form id="jCode" class="stack"><label class="field"><span>Code</span><input class="input code" name="code" maxlength="8" autocomplete="off" autocapitalize="characters" value="' + esc(j.code ? C.formatCode(j.code) : '') + '" placeholder="ABC-234"></label><div id="jErr">' + (j.err ? '<p class="err" role="alert">' + esc(j.err) + '</p>' : '') + '</div><button class="btn big" type="submit">Find the table</button></form></section>';
    }
    var i = j.info;
    return '<section class="card stack" style="max-width:520px;margin:0 auto"><p class="lab">A table is waiting</p><h1>' + esc(i.name) + '</h1><p class="muted">' + esc((i.by ? i.by + ' keeps score' : 'Someone keeps score') + ' · ' + plural(i.players, 'player') + ' · ' + plural(i.watchers, 'watcher')) + '</p>' +
      (i.full ? '<p class="err">This table has all the watchers it can take.</p>' : '<form id="jName" class="stack"><label class="field"><span>Your first name</span><input class="input" name="name" maxlength="' + C.LIMITS.name + '" value="' + esc(prefs.me) + '" autocomplete="given-name"></label><p class="hint" style="margin:0">They see your first name. No account, no email - this phone is remembered for this table.</p><div id="jErr"></div><button class="btn big" type="submit">Watch the table</button></form>') +
      '<button class="btn ghost" type="button" data-act="joinnew">Another code</button></section>';
  }
  function lookupJoin() {
    var j = state.join;
    if (!j || !C.isCode(j.code)) return;
    api('GET', 'api/join/' + j.code).then(function (info) {
      if (info.already) return enterTable(info.already).then(function () { toast('You’re already at this table.'); });
      j.info = info; j.err = ''; draw();
    }).catch(function (err) { j.err = err.message; j.info = null; draw(); });
  }
  function bindJoin() {
    var cf = $('#jCode');
    if (cf) {
      cf.addEventListener('submit', function (e) { e.preventDefault(); state.join.code = C.normalizeCode(cf.code.value); if (!C.isCode(state.join.code)) { $('#jErr').innerHTML = '<p class="err" role="alert">A code is six letters and numbers, like ABC-234.</p>'; return; } lookupJoin(); });
      setTimeout(function () { try { if (!cf.code.value) cf.code.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
    }
    var jf = $('#jName');
    if (jf) jf.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = C.cleanName(jf.name.value);
      if (!name) { $('#jErr').innerHTML = '<p class="err" role="alert">Type your first name.</p>'; return; }
      var btn = $('button[type=submit]', jf); btn.disabled = true;
      prefs.me = name; savePrefs();
      api('POST', 'api/join/' + state.join.code, { name: name }).then(function (r) { return enterTable(r.id); })
        .then(function () { toast('You’re watching. Scores appear as they land.', 4200); })
        .catch(function (err) { btn.disabled = false; showError(err, $('#jErr')); });
    });
  }
  function enterTable(tid) {
    if (state.trying) leaveTry();
    return api('GET', 'api/t/' + tid).then(function (r) {
      var g = takeTable(r.table);
      state.join = null;
      if (g) go('g/' + g.id);
    });
  }

  /* ---------------- the recap card ---------------- */

  function canShareFiles() {
    try { return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [new File(['x'], 'x.png', { type: 'image/png' })] })); } catch (e) { return false; }
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  var SEAT_COLOURS = ['#f4b73a', '#7fd6b3', '#ff9aa5', '#a5b4fc', '#fde68a', '#f9a8d4', '#93c5fd', '#86efac', '#fdba74', '#c4b5fd', '#67e8f9', '#fca5a5'];
  /** The recap card: 1080 x 1350, drawn here. Names, scores and the best
   *  moment - never uploaded, never a link. Names are drawn as initials in
   *  a circle, not emoji: not every phone's canvas has an emoji font. */
  function drawRecap(g) {
    var d = C.recapData(g, dayOf(g.finishedAt || g.updatedAt));
    var cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1350;
    var c = cv.getContext('2d');
    var grad = c.createLinearGradient(0, 0, 1080, 1350); grad.addColorStop(0, '#0f5f48'); grad.addColorStop(1, '#8f1d2a');
    c.fillStyle = grad; c.fillRect(0, 0, 1080, 1350);
    // Ruled lines, like the pad.
    c.strokeStyle = 'rgba(255,255,255,.07)'; c.lineWidth = 2;
    for (var y0 = 300; y0 < 1300; y0 += 64) { c.beginPath(); c.moveTo(0, y0); c.lineTo(1080, y0); c.stroke(); }
    var F = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    var m = function (font) { c.font = font; return function (s) { return c.measureText(s).width; }; };
    // The mark: a pencil on a white tile.
    c.fillStyle = '#ffffff'; roundRect(c, 84, 80, 96, 96, 26); c.fill();
    c.save(); c.translate(132, 128); c.rotate(-Math.PI / 4);
    c.fillStyle = '#f4b73a'; c.fillRect(-34, -10, 54, 20); c.fillStyle = '#e98a95'; c.fillRect(20, -10, 14, 20);
    c.fillStyle = '#f2d9b0'; c.beginPath(); c.moveTo(-34, -10); c.lineTo(-50, 0); c.lineTo(-34, 10); c.closePath(); c.fill();
    c.fillStyle = '#1b1d1a'; c.beginPath(); c.moveTo(-44, -3.5); c.lineTo(-50, 0); c.lineTo(-44, 3.5); c.closePath(); c.fill();
    c.restore();
    c.textBaseline = 'middle'; c.fillStyle = '#ffffff';
    c.fillText(C.fitText(m('900 60px ' + F), d.title, 760), 206, 116);
    c.fillStyle = '#f6efe3'; c.fillText(C.fitText(m('700 32px ' + F), (d.date ? d.date + ' · ' : '') + 'game night', 760), 206, 164);
    c.textBaseline = 'alphabetic';
    var lines = C.wrapText(m('900 64px ' + F), d.headline, 912, 2);
    c.fillStyle = '#ffffff';
    lines.forEach(function (l, i) { c.fillText(l, 84, 290 + i * 76); });
    var y = 290 + lines.length * 76 + 14;
    if (d.extra) { c.fillStyle = '#f6efe3'; c.fillText(C.fitText(m('700 34px ' + F), d.extra, 912), 84, y); y += 50; }
    y += 10;
    var n = d.rows.length;
    var rowH = n <= 4 ? 124 : n <= 6 ? 100 : 80;
    var big = n <= 4 ? 52 : n <= 6 ? 44 : 38, circ = n <= 4 ? 30 : 25;
    var hlLines = d.highlight ? C.wrapText(m('800 38px ' + F), '\u2605 ' + d.highlight, 852, 2) : [];
    // The rows, the line and the moment sit in the middle of what is left.
    var blockH = n * rowH + (d.more ? 50 : 0) + (d.stats ? 64 : 0) + (hlLines.length ? 16 + 44 + hlLines.length * 48 : 0);
    if (y + blockH < 1220) y += Math.round((1220 - y - blockH) / 2);
    d.rows.forEach(function (row, i) {
      c.fillStyle = row.win ? 'rgba(255,255,255,.24)' : 'rgba(255,255,255,.12)';
      roundRect(c, 84, y, 912, rowH - 16, 26); c.fill();
      var cy = y + (rowH - 16) / 2;
      c.fillStyle = row.place === 1 ? '#f4b73a' : row.place === 2 ? '#e5e7eb' : row.place === 3 ? '#e0a370' : 'rgba(255,255,255,.3)';
      c.beginPath(); c.arc(84 + 22 + circ, cy, circ, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#1b1d1a'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = '900 ' + Math.round(circ * 1.05) + 'px ' + F; c.fillText(String(row.place), 84 + 22 + circ, cy + 1);
      var cx2 = 84 + 22 + circ * 3 + 14;
      c.fillStyle = SEAT_COLOURS[i % SEAT_COLOURS.length]; c.beginPath(); c.arc(cx2, cy, circ + 2, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#1b1d1a'; c.font = '900 ' + Math.round(circ * 1.05) + 'px ' + F; c.fillText(initial(row.name), cx2, cy + 1);
      c.textAlign = 'left'; c.fillStyle = '#ffffff';
      var tw = m('900 ' + (big + 4) + 'px ' + F)(row.total);
      var nx = cx2 + circ + 26;
      c.font = '800 ' + big + 'px ' + F; c.fillText(C.fitText(m('800 ' + big + 'px ' + F), row.name + (row.win ? '  \u2605' : ''), 966 - nx - tw - 30), nx, cy + 1);
      c.textAlign = 'right'; c.font = '900 ' + (big + 4) + 'px ' + F; c.fillText(row.total, 966, cy + 1);
      if (row.sub) { c.font = '700 24px ' + F; c.fillStyle = '#f6efe3'; c.fillText(row.sub, 966 - tw - 18, cy + 4); }
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      y += rowH;
    });
    if (d.more) { c.fillStyle = '#f6efe3'; c.font = '700 30px ' + F; c.fillText('+' + d.more + ' more', 84, y + 24); y += 50; }
    if (d.stats) { c.fillStyle = '#f6efe3'; c.font = '700 32px ' + F; c.fillText(C.fitText(m('700 32px ' + F), d.stats, 912), 84, y + 30); y += 64; }
    if (d.highlight) {
      var hl = hlLines;
      var hy = Math.min(y + 16, 1210 - hl.length * 48);
      c.fillStyle = '#fff3d1'; roundRect(c, 84, hy, 912, 44 + hl.length * 48, 26); c.fill();
      c.fillStyle = '#6b4a00'; c.font = '800 38px ' + F;
      hl.forEach(function (l, i) { c.fillText(l, 114, hy + 60 + i * 48); });
    }
    c.fillStyle = '#f6efe3'; c.font = '700 28px ' + F;
    c.fillText(C.fitText(m('700 28px ' + F), d.foot + ' · ' + location.host + BASE.replace(/\/$/, ''), 912), 84, 1296);
    return new Promise(function (resolve) { cv.toBlob(function (b) { resolve(b); }, 'image/png'); });
  }
  function openRecap(g) {
    state.recap = { id: g.id, blob: null, url: null };
    sheet('<h2>\u{1F5BC} Recap card</h2><p class="small muted">A picture of the result for the group chat - drawn on this phone, never uploaded, never a link.</p><div id="rcOut"></div><div class="row" style="margin-top:10px"><button class="btn" type="button" id="rcDraw">Make the card</button><button class="btn" type="button" id="rcShare" hidden>' + (canShareFiles() ? 'Share it' : 'Download it') + '</button></div>', function (root) {
      $('#rcDraw', root).addEventListener('click', function () {
        var live = gameById(g.id); if (!live) return;
        drawRecap(live).then(function (blob) {
          if (!blob) throw new Error('This browser couldn’t draw the card.');
          if (state.recap.url) URL.revokeObjectURL(state.recap.url);
          state.recap.blob = blob; state.recap.url = URL.createObjectURL(blob);
          var r = C.result(live);
          $('#rcOut', root).innerHTML = '<img class="recap-img" alt="' + esc('Recap card: ' + live.name + '. ' + r.line) + '" src="' + esc(state.recap.url) + '">';
          $('#rcDraw', root).textContent = 'Draw it again';
          $('#rcShare', root).hidden = false;
          say(canShareFiles() ? 'Drawn - tap Share it.' : 'Drawn - tap Download it.');
        }).catch(function (err) { showError(err, $('#rcOut', root)); });
      });
      $('#rcShare', root).addEventListener('click', function () {
        var rc = state.recap; if (!rc || !rc.blob) return;
        var live = gameById(rc.id);
        var name = 'pencil-' + slug(live ? live.name : 'game') + '-' + String((live && (live.finishedAt || live.updatedAt)) || '').slice(0, 10) + '.png';
        var file = new File([rc.blob], name, { type: 'image/png' });
        if (canShareFiles()) navigator.share({ files: [file], title: live ? live.name : 'Game night' }).catch(function (e) { if (!e || e.name !== 'AbortError') download(name, 'image/png', rc.blob); });
        else download(name, 'image/png', rc.blob);
      });
    });
  }

  /* ---------------- our table: wins, streaks, records ---------------- */

  function personName(id) { var p = bk().people.filter(function (x) { return x.id === id; })[0]; return p ? p.name : ''; }
  function viewTable() {
    var b = bk(), st = C.stats(b.history, { group: state.group });
    var out = '<div class="sec-head"><h1>Our table</h1><span class="muted">' + plural(st.games, 'game') + ' played</span></div>';
    if (b.groups.length) out += '<div class="chips scroll" role="group" aria-label="Whose games" style="margin-bottom:12px"><button class="chip" type="button" data-act="group" data-gid="" aria-pressed="' + (!state.group) + '">Everyone</button>' + b.groups.map(function (gr) { return '<button class="chip" type="button" data-act="group" data-gid="' + esc(gr.id) + '" aria-pressed="' + (state.group === gr.id) + '">' + esc(gr.name) + '</button>'; }).join('') + '</div>';
    if (!st.games) {
      return out + '<section class="card empty center stack"><p style="font-size:2.2rem;margin:0" aria-hidden="true">\u{1F3C6}</p><p><b>No finished games yet.</b> Finish one and the table starts keeping wins, streaks and records - and who to beat next time.</p><div class="row" style="justify-content:center"><button class="btn" type="button" data-act="new">Start a game</button>' + (state.trying ? '' : '<button class="btn ghost" type="button" data-act="try">See a made-up table</button>') + '</div></section>' + exportCard(b);
    }
    var stories = [];
    st.byGame.forEach(function (gm) { gm.rows.forEach(function (r) { if (r.streak >= 2) stories.push({ w: r.streak, t: '\u{1F525} ' + r.name + ' has won ' + r.streak + ' ' + gm.name + ' games in a row' }); }); });
    st.byGame.forEach(function (gm) { if (gm.next) stories.push({ w: 1.5, t: gm.emoji + ' ' + gm.next }); });
    stories.sort(function (a, c) { return c.w - a.w; });
    out += '<div class="grid split"><div class="stack">';
    if (stories.length) out += '<section class="card stack" aria-labelledby="stT"><h2 id="stT">The stories</h2>' + stories.slice(0, 4).map(function (s) { return '<p class="story" style="margin:0">' + esc(s.t) + '</p>'; }).join('') + '</section>';
    out += '<section class="card" aria-labelledby="lbT"><div class="sec-head"><h2 id="lbT">Leaderboard</h2><span class="muted small">Most wins first</span></div><div class="lb">' + st.overall.map(function (r, i) {
      return '<div class="lbr"><span class="rk">' + (i + 1) + '</span><span class="emo" aria-hidden="true">' + esc(r.emoji) + '</span><span><b>' + esc(r.name) + '</b><small>' + r.wins + ' of ' + plural(r.played, 'game') + (r.streak >= 2 ? ' · <span class="streak">\u{1F525} ' + r.streak + ' in a row</span>' : '') + '</small><span class="meter" aria-hidden="true"><i style="width:' + r.rate + '%"></i></span></span><span class="w">' + r.rate + '%<small>won</small></span></div>';
    }).join('') + '</div></section>';
    var gameCard = function (gm) {
      return '<section class="card" aria-label="' + esc(gm.name) + '"><div class="sec-head"><h3 style="margin:0"><span aria-hidden="true">' + esc(gm.emoji) + '</span> ' + esc(gm.name) + '</h3><span class="muted small">' + plural(gm.played, 'game') + '</span></div><div class="lb">' + gm.rows.slice(0, 4).map(function (r, i) {
        return '<div class="lbr"><span class="rk">' + (i + 1) + '</span><span class="emo" aria-hidden="true">' + esc(r.emoji) + '</span><span><b>' + esc(r.name) + '</b><small>' + r.wins + ' of ' + r.played + (r.streak >= 2 ? ' · <span class="streak">\u{1F525} ' + r.streak + '</span>' : '') + '</small></span><span class="w">' + r.rate + '%</span></div>';
      }).join('') + '</div>' + (gm.record ? '<p class="small" style="margin:8px 0 0"><b>Record:</b> ' + esc(gm.record.label.replace(/^Best /, 'best ') + ' - ' + gm.record.name + ', ' + gm.record.value) + '</p>' : '') + '</section>';
    };
    out += '<div class="grid two">' + st.byGame.slice(0, 4).map(gameCard).join('') + '</div>';
    if (st.byGame.length > 4) out += '<details class="more card"><summary>' + plural(st.byGame.length - 4, 'more game') + ': ' + esc(st.byGame.slice(4).map(function (gm) { return gm.name; }).join(', ')) + '</summary><div class="grid two" style="margin-top:10px">' + st.byGame.slice(4).map(gameCard).join('') + '</div></details>';
    out += '</div><div class="stack">';
    // Head to head.
    var people = [];
    st.overall.forEach(function (r) { people.push({ id: r.id, name: r.name, emoji: r.emoji }); });
    var a = state.h2h.a && people.some(function (p) { return p.id === state.h2h.a; }) ? state.h2h.a : (people[0] && people[0].id) || '';
    var c2 = state.h2h.b && state.h2h.b !== a && people.some(function (p) { return p.id === state.h2h.b; }) ? state.h2h.b : (people.filter(function (p) { return p.id !== a; })[0] || {}).id || '';
    if (people.length >= 2) {
      var hs = b.history.filter(function (h) { return !state.group || h.group === state.group; });
      var h2 = C.headToHead(hs, a, c2);
      var an = (people.filter(function (p) { return p.id === a; })[0] || {}).name || '', bn = (people.filter(function (p) { return p.id === c2; })[0] || {}).name || '';
      var opt = function (sel, other) { return people.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === sel ? ' selected' : '') + (p.id === other ? ' disabled' : '') + '>' + esc(p.emoji + ' ' + p.name) + '</option>'; }).join(''); };
      out += '<section class="card stack" aria-labelledby="hhT"><h2 id="hhT">Head to head</h2><div class="fields two"><label class="field"><span>One</span><select class="input" id="h2a">' + opt(a, c2) + '</select></label><label class="field"><span>The other</span><select class="input" id="h2b">' + opt(c2, a) + '</select></label></div>' +
        '<div class="h2h"><div class="score">' + esc(C.h2hLine(h2, an, bn)) + '</div><p class="small muted" style="margin:0">' + (h2.games ? plural(h2.games, 'game') + ' on opposite sides · finishing ahead counts' : 'They haven’t played against each other yet.') + '</p></div>' +
        (h2.byGame.length ? '<div>' + h2.byGame.map(function (x) { return '<div class="rec"><span class="ge" aria-hidden="true">' + esc(x.emoji) + '</span><span><b>' + esc(x.name) + '</b><small>' + esc(an + ' ' + x.a + ' – ' + x.b + ' ' + bn + (x.ties ? ' · ' + plural(x.ties, 'tie') : '')) + '</small></span></div>'; }).join('') + '</div>' : '') + '</section>';
    }
    var recs = st.byGame.filter(function (gm) { return gm.record; });
    if (recs.length) out += '<section class="card" aria-labelledby="rcT"><h2 id="rcT">Records</h2>' + recs.map(function (gm) { return '<div class="rec"><span class="ge" aria-hidden="true">' + esc(gm.emoji) + '</span><span><b>' + esc(gm.record.label) + ': ' + esc(String(gm.record.value)) + '</b><small>' + esc(gm.record.emoji + ' ' + gm.record.name + ' · ' + ago(gm.record.at)) + '</small><small>' + esc(gm.next) + '</small></span></div>'; }).join('') + '</section>';
    var hist = b.history.filter(function (h) { return !state.group || h.group === state.group; }).slice().reverse();
    out += '<section class="card" aria-labelledby="hsT"><h2 id="hsT">Every game</h2>' + hist.slice(0, state.histMore ? 400 : 12).map(function (h) {
      var win = h.sides.filter(function (s) { return s.place === 1; });
      var line = h.tie ? 'Tie: ' + C.listNames(win.map(function (s) { return s.name; })) : (win[0] ? win[0].name + ' won' + (h.sides.length > 1 && h.kind !== 'darts' ? ' · ' + win[0].total : '') : '');
      var full = gameById(h.id);
      return '<div class="hist"><span class="ge" aria-hidden="true">' + esc(h.emoji) + '</span><span><b>' + esc(h.name) + ' · ' + esc(line) + '</b><small>' + esc(ago(h.at) + ' · ' + h.sides.map(function (s) { return s.name; }).join(', ')) + '</small>' + (h.highlight ? '<small>★ ' + esc(h.highlight) + '</small>' : '') + '</span>' + (full ? '<button class="btn small ghost" type="button" data-act="open" data-id="' + esc(full.id) + '">Open</button>' : '<span></span>') + '</div>';
    }).join('') + (hist.length > 12 && !state.histMore ? '<button class="btn ghost block" type="button" data-act="histmore" style="margin-top:8px">Show all ' + hist.length + '</button>' : '') + '</section>';
    out += exportCard(b);
    out += '</div></div>';
    return out;
  }
  function exportCard(b) {
    return '<section class="card stack" aria-labelledby="exT"><h2 id="exT">Keep a copy</h2><p class="small muted" style="margin:0">Your history as a spreadsheet (CSV) or a file Pencil reads back (JSON) - made on this phone. Import adds games another phone exported; a game already here is skipped.</p><div class="row"><button class="btn small ghost" type="button" data-act="csvout"' + (b.history.length ? '' : ' disabled') + '>Download CSV</button><button class="btn small ghost" type="button" data-act="jsonout"' + (b.history.length ? '' : ' disabled') + '>Download JSON</button><label class="btn small ghost" style="position:relative;overflow:hidden">Import a file<input class="vh" id="impFile" type="file" accept=".csv,.json,text/csv,application/json"></label></div></section>';
  }
  function bindTable() {
    var a = $('#h2a'), b2 = $('#h2b');
    if (a) a.addEventListener('change', function () { state.h2h.a = a.value; state.h2h.b = b2.value; draw(); });
    if (b2) b2.addEventListener('change', function () { state.h2h.a = a.value; state.h2h.b = b2.value; draw(); });
    bindImport();
  }
  function bindImport() {
    var f = $('#impFile');
    if (!f) return;
    f.addEventListener('change', function (e) {
      var file = e.target.files[0]; if (!file) return;
      if (state.trying) { toast('Start your own table to import games.'); return; }
      if (file.size > 4 * 1024 * 1024) { toast('That file is too big to be a Pencil history.'); return; }
      file.text().then(function (text) {
        var incoming;
        if (/^\s*\{/.test(text)) {
          try { incoming = JSON.parse(text); } catch (err) { toast('That JSON file could not be read.'); return; }
          if (!incoming || incoming.app !== 'pencil') { toast('That isn’t a file Pencil made.'); return; }
        } else {
          var r = C.historyFromCsv(text);
          if (r.error) { toast(r.error, 5000); return; }
          incoming = { history: r.history };
        }
        var m = C.mergeImport(book, incoming, o());
        book.people = m.people; book.groups = m.groups; book.history = m.history;
        saveBook(); draw();
        toast(plural(m.added, 'game') + ' added' + (m.skipped ? ', ' + m.skipped + ' skipped (already here, or unreadable)' : '') + '.', 4800);
      });
    });
  }

  /* ---------------- more ---------------- */

  function viewMore() {
    var b = bk();
    var out = '<div class="sec-head"><h1>More</h1></div><div class="grid two"><div class="stack">';
    out += '<section class="card stack"><h2>Join a table</h2><p class="small muted" style="margin:0">Watch someone else’s game live, with the code on their screen.</p><button class="btn" type="button" data-act="joinnew">Enter a code</button></section>';
    out += '<section class="card stack" aria-labelledby="grT"><h2 id="grT">Groups</h2><p class="small muted" style="margin:0">“Family”, “Thursday crew” - start a game with a group in one tap, and see a group’s own leaderboard.</p>' +
      b.groups.map(function (gr) {
        return '<div class="note stack"><div class="row spread"><b>' + esc(gr.name) + '</b><span class="row" style="gap:4px"><button class="btn small ghost" type="button" data-act="grename" data-gid="' + esc(gr.id) + '">Rename</button><button class="btn small danger" type="button" data-act="gdel" data-gid="' + esc(gr.id) + '">Delete</button></span></div><div class="chips">' +
          b.people.map(function (p) { var on = gr.people.indexOf(p.id) >= 0; return '<button class="pchip" type="button" data-act="gtoggle" data-gid="' + esc(gr.id) + '" data-pid="' + esc(p.id) + '" aria-pressed="' + on + '"><span aria-hidden="true">' + esc(p.emoji) + '</span>' + esc(p.name) + '</button>'; }).join('') + '</div></div>';
      }).join('') +
      (b.groups.length < C.LIMITS.groups ? '<form class="addrow" id="grNew"><input class="input" id="grName" maxlength="' + C.LIMITS.groupName + '" placeholder="New group - Family, Book club…"><button class="btn" type="submit">Add</button></form>' : '') + '</section>';
    out += '</div><div class="stack">';
    out += '<section class="card stack" aria-labelledby="ppT"><h2 id="ppT">People</h2>' + (b.people.length ? '<div>' + C.recentPeople(b.people, 200).map(function (p) { return '<div class="prow"><button class="emobtn" type="button" data-act="pplemoji" data-pid="' + esc(p.id) + '" aria-label="Change ' + esc(p.name) + '’s emoji">' + esc(p.emoji) + '</button><span><b>' + esc(p.name) + '</b></span><span class="acts"><button class="iconbtn" type="button" data-act="pplrename" data-pid="' + esc(p.id) + '" aria-label="Rename ' + esc(p.name) + '">✎</button><button class="iconbtn" type="button" data-act="pplforget" data-pid="' + esc(p.id) + '" aria-label="Forget ' + esc(p.name) + '">×</button></span></div>'; }).join('') + '</div>' : '<p class="muted small" style="margin:0">Players you add to a game appear here.</p>') + '</section>';
    out += exportCard(b);
    out += '<section class="card stack"><h2>On this phone</h2><p class="small muted" style="margin:0">Games, people, groups and the history are kept in this browser - no account, nothing on a server - unless you show a table, which sends that one game and is deleted a day after its last score. A free account adds one thing: reading a paper score sheet with AI.</p>' +
      (state.trying ? '' : '<div class="row"><button class="btn small ghost" type="button" data-act="try">See the made-up game night</button><button class="btn small danger" type="button" data-act="wipe">Erase everything here</button></div>') + '</section>';
    out += '</div></div>';
    return out;
  }
  function bindMore() {
    var f = $('#grNew');
    if (f) f.addEventListener('submit', function (e) {
      e.preventDefault();
      var g = C.cleanGroup({ name: $('#grName').value, people: [] });
      if (!g) { toast('A group needs a name.'); return; }
      var b = bk();
      if (b.groups.some(function (x) { return C.norm(x.name) === C.norm(g.name); })) { toast('There is already a group called ' + g.name + '.'); return; }
      b.groups.push({ id: C.freshId(rand, 'r', b.groups.map(function (x) { return x.id; }), 8), name: g.name, people: [] });
      saveBook(); draw();
    });
    bindImport();
  }

  /* ---------------- "Read a paper score sheet" ---------------- */

  function redraw(img, max, q) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, s = Math.min(1, max / Math.max(w, h));
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * s)); cv.height = Math.max(1, Math.round(h * s));
    var c = cv.getContext('2d');
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, cv.width, cv.height);
    c.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', q);
  }
  function loadImg(src) { return new Promise(function (r) { var im = new Image(); im.addEventListener('load', function () { r(im); }); im.addEventListener('error', function () { r(null); }); im.src = src; }); }
  /** The sheet's photo, redrawn here at 1600 px through a canvas, which
   *  drops its EXIF - location included - before anything is sent. */
  function prepPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('That isn’t a photo.'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener('load', function () {
        try { var full = redraw(img, 1600, 0.82), thumb = redraw(img, 240, 0.72); URL.revokeObjectURL(url); resolve({ full: full, thumb: thumb }); } catch (e) { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); }
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); });
      img.src = url;
    });
  }
  function sendable(full) {
    var max = C.LIMITS.aiImageBytes * 4 / 3;
    var b64 = full.replace(/^data:image\/jpeg;base64,/, '');
    if (b64.length <= max) return Promise.resolve(b64);
    return loadImg(full).then(function (im) {
      var steps = [[1600, 0.7], [1400, 0.66], [1200, 0.62]];
      for (var i = 0; i < steps.length; i++) { var d = redraw(im, steps[i][0], steps[i][1]).replace(/^data:image\/jpeg;base64,/, ''); if (d.length <= max) return d; }
      throw new Error('That photo is too large to send. Try another.');
    });
  }
  var SENT_LINE = '<b>What is sent:</b> this one photo, shrunk on this phone with its location removed. Nothing else - not this game, the players’ names or your history.';
  function openAi(target) {
    state.ai = { target: target, photo: null, proposal: null, win: 'high' };
    sheet('<div class="body"></div>', drawAi);
  }
  function drawAi(root) {
    var b = $('.body', root), a = state.ai;
    var intro = '<h2>\u{1F4DD} Read a paper score sheet</h2><p>Take a photo of the sheet and AI copies out the names across the top and each round’s scores - up to 12 players and 60 rounds. You check every number and match the columns to players before anything is added.</p>';
    var sent = '<div class="sent">' + (a.photo ? '<img alt="" src="' + esc(a.photo.thumb) + '">' : '') + SENT_LINE + '<span style="display:block;clear:both"></span></div>';
    if (state.trying) { b.innerHTML = intro + '<p class="note">This reads a real sheet of your own. Start your own game to try it.</p><button class="btn" type="button" data-act="tryown">Start my own</button>'; return; }
    if (!signedIn()) {
      b.innerHTML = intro + sent + '<p class="note" style="margin-top:12px">This needs a free account - it comes with $2 of AI credit, and one sheet costs about a cent. Scoring, the table, the stats and the recap card stay free with no account.</p><div class="row" style="margin-top:12px"><button class="btn" type="button" id="aiJoin">Create a free account</button><button class="btn ghost" type="button" id="aiIn">Sign in</button></div>';
      $('#aiJoin', root).addEventListener('click', function () { openAccount('Create a free account to read paper score sheets.', function () { openAi(a.target); }); });
      $('#aiIn', root).addEventListener('click', function () { openAccount('Sign in to read paper score sheets.', function () { openAi(a.target); }, 'login'); });
      return;
    }
    if (a.proposal) return drawProposal(root);
    b.innerHTML = intro + '<div class="field" style="margin:8px 0 12px"><span>A photo of the sheet, from straight above</span><label class="btn ghost" style="position:relative;overflow:hidden">' + (a.photo ? '\u{1F4F7} Another photo' : '\u{1F4F7} Take or choose a photo') + '<input class="vh" id="aiFile" type="file" accept="image/*" capture="environment"></label></div>' + sent +
      '<div id="aiOut" style="margin-top:12px"></div><div class="row" style="margin-top:12px"><button class="btn ai" type="button" id="aiGo"' + (a.photo ? '' : ' disabled') + '> Read it</button><span class="tiny muted">About a cent of AI credit.</span></div>';
    var out = $('#aiOut', root), goB = $('#aiGo', root);
    $('#aiFile', root).addEventListener('change', function (e) {
      var file = e.target.files[0]; if (!file) return;
      prepPhoto(file).then(function (p) { a.photo = p; drawAi(root); }).catch(function (err) { showError(err, out); });
    });
    goB.addEventListener('click', function () {
      if (!a.photo) return;
      goB.disabled = true; goB.textContent = 'Reading…';
      out.innerHTML = '<p class="muted" role="status">Reading the sheet…</p>';
      sendable(a.photo.full).then(function (b64) {
        return api('POST', 'api/ai/sheet', { image: { type: 'image/jpeg', data: b64 } });
      }).then(function (res) {
        a.proposal = res.proposal; drawAi(root); loadMe();
      }).catch(function (err) {
        goB.disabled = false; goB.textContent = ' Read it';
        meteredError(err, out, function () { openAi(a.target); }, 'Sign in to read paper score sheets.');
      });
    });
  }
  function drawProposal(root) {
    var b = $('.body', root), a = state.ai, p = a.proposal;
    var g = a.target === 'new' ? null : gameById(a.target);
    var conf = function (c) { return '<span class="pill ' + (c === 'high' ? 'p-done' : c === 'medium' ? 'p-play' : 'p-lead') + '">' + esc(c) + '</span>'; };
    var map = p.players.map(function (pl, i) {
      if (!g) return '';
      var hit = g.sides.filter(function (s) { return pl.name && C.norm(s.name) === C.norm(pl.name); })[0];
      return hit ? hit.id : (g.sides[i] && !p.players.some(function (q) { return q.name && C.norm(q.name) === C.norm(g.sides[i].name); }) ? g.sides[i].id : '');
    });
    var head = p.players.map(function (pl, i) {
      if (!g) return '<th><input class="input" data-pname="' + i + '" maxlength="' + C.LIMITS.name + '" value="' + esc(pl.name) + '" aria-label="Name in column ' + (i + 1) + '" style="width:112px;text-align:left"><div>' + conf(pl.confidence) + '</div></th>';
      return '<th><select class="input" data-pmap="' + i + '" aria-label="Column ' + (i + 1) + (pl.name ? ' (' + esc(pl.name) + ')' : '') + ' is">' + '<option value="">Leave out</option>' + g.sides.map(function (s) { return '<option value="' + esc(s.id) + '"' + (map[i] === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select><div class="small">' + (pl.name ? esc('“' + pl.name + '” ') : '') + conf(pl.confidence) + '</div></th>';
    }).join('');
    b.innerHTML = '<h2>Check it, then add</h2><p class="small muted">AI-written - check every number against the paper. Nothing is added until you tap Add.</p>' +
      (p.note ? '<p class="note small">' + esc(p.note) + '</p>' : '') +
      '<div class="pgrid"><table><thead><tr><th></th>' + head + '</tr></thead><tbody>' + p.rows.map(function (row, r) { return '<tr><td class="rn">' + (r + 1) + '</td>' + row.map(function (v, i) { return '<td><input class="input" type="number" inputmode="numeric" data-pv="' + r + '-' + i + '" value="' + (v === null ? '' : v) + '" aria-label="Row ' + (r + 1) + ', column ' + (i + 1) + '"></td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>' +
      (!g ? '<div class="field" style="margin-top:12px"><span>Who wins?</span><div class="seg"><button type="button" data-pwin="high" aria-pressed="' + (a.win === 'high') + '">Highest score</button><button type="button" data-pwin="low" aria-pressed="' + (a.win === 'low') + '">Lowest score</button></div></div>' : '') +
      '<div id="ppErr"></div><div class="row" style="margin-top:12px"><button class="btn" type="button" id="ppAdd">' + (g ? 'Add ' + plural(p.rows.length, g.kind === 'golf' ? 'hole' : g.kind === 'hearts' ? 'hand' : g.kind === 'darts' ? 'row of turns' : 'round', g.kind === 'darts' ? 'rows of turns' : null) : 'Start the game with ' + plural(p.rows.length, 'round')) + '</button><button class="btn ghost" type="button" id="ppBack">Another photo</button></div>';
    $$('[data-pwin]', root).forEach(function (x) { x.addEventListener('click', function () { a.win = x.getAttribute('data-pwin'); $$('[data-pwin]', root).forEach(function (y) { y.setAttribute('aria-pressed', String(y === x)); }); }); });
    $('#ppBack', root).addEventListener('click', function () { a.proposal = null; a.photo = null; drawAi(root); });
    $('#ppAdd', root).addEventListener('click', function () {
      var rows = p.rows.map(function (row, r) { return row.map(function (v, i) { var x = $('[data-pv="' + r + '-' + i + '"]', root).value.trim(); return x === '' ? null : Number(x); }); });
      if (rows.some(function (row) { return row.some(function (v) { return v !== null && (!Number.isInteger(v) || v < C.LIMITS.aiMin || v > C.LIMITS.aiMax); }); })) { $('#ppErr', root).innerHTML = '<p class="err">Every score is a whole number.</p>'; return; }
      var prop = { players: p.players, rows: rows };
      if (g) {
        var mapping = p.players.map(function (pl, i) { return $('[data-pmap="' + i + '"]', root).value; });
        var live = gameById(g.id);
        try { C.change(live, function (x) { C.applySheet(x, prop, mapping); }, o()); } catch (err) { showError(err, $('#ppErr', root)); return; }
        closeSheet(true);
        act(live, function (x) { C.applySheet(x, prop, mapping); });
        toast(plural(rows.length, 'row') + ' added from the sheet.', 3200);
        return;
      }
      // A new game from the sheet: its names become players.
      var names = p.players.map(function (pl, i) { return C.cleanName($('[data-pname="' + i + '"]', root).value); });
      var players = [], cols = [], bkk = bk();
      names.forEach(function (n, i) {
        if (!n || players.some(function (x) { return C.norm(x.name) === C.norm(n); })) return;
        var have = bkk.people.filter(function (x) { return C.norm(x.name) === C.norm(n); })[0];
        players.push(have ? { id: have.id, name: have.name, emoji: have.emoji } : { id: C.freshId(rand, 'p', bkk.people.map(function (x) { return x.id; }).concat(players.map(function (x) { return x.id; })), 8), name: n, emoji: nextEmoji(players.map(function (x) { return x.emoji; })) });
        cols.push(i);
      });
      if (!players.length) { $('#ppErr', root).innerHTML = '<p class="err">Give at least one column a name.</p>'; return; }
      try {
        var ng = C.newGame({ game: 'any', players: players, settings: { win: a.win, end: 'open' }, name: 'From a paper sheet' }, o());
        var mapping2 = p.players.map(function (pl, i) { var k = cols.indexOf(i); return k >= 0 ? ng.sides[k].id : ''; });
        var res = C.change(ng, function (x) { C.applySheet(x, prop, mapping2); }, o());
        touchPeople(players);
        putGame(res.game);
        closeSheet(true);
        go('g/' + res.game.id);
        toast('Started with ' + plural(rows.length, 'round') + ' from the sheet. Rename the game under More.', 4200);
      } catch (err) { showError(err, $('#ppErr', root)); }
    });
  }

  /* ---------------- sheets and the account ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false; document.body.classList.add('sheet-open'); s.scrollTop = 0;
    // The shared "confirm your email" banner sits above everything at the top
    // of the page; keep the sheet (and its Close button) clear of it.
    var vb = document.getElementById('stc-verify-banner'), off = vb ? Math.max(0, vb.getBoundingClientRect().bottom) : 0;
    s.style.maxHeight = off ? 'calc(100vh - ' + Math.round((matchMedia('(min-width: 900px)').matches ? 2 : 1) * (off + 8)) + 'px)' : '';
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2'); if (f) f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f && !s.contains(document.activeElement)) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    state.kp = null;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });
  function openGames() {
    var l = list();
    sheet('<h2>Your games</h2>' + (l.length ? '<div class="glist">' + l.slice(0, 20).map(gameRow).join('') + '</div>' : '<p class="muted">None yet.</p>') + '<div class="row" style="margin-top:12px"><button class="btn small" type="button" data-act="new">+ Start a game</button><button class="btn small ghost" type="button" data-act="joinnew">Join a table</button></div>');
  }

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = state.me || { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var FREE_LINE = 'Pencil is free with no account, and your games stay on this phone. A free account adds one thing: reading a paper score sheet with AI - it comes with $2 of AI credit, and one account works across every app on this site.';
  function openAccount(reason, then, start) {
    var mode = start === 'login' ? 'login' : 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field" style="margin:10px 0"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field" style="margin:10px 0"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); if (then) then(); else draw(); })
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
  function openAccountSheet() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Reading a score sheet costs about a cent. Everything else is free.</p><div id="billing"></div></div>' +
      '<p class="small muted" style="margin-top:12px">Your games are not in your account - they stay on this phone, and on a shared table only while you show one.</p>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); draw(); }); });
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
  function openCredit(d) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((d && d.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Typing the scores, the table and the stats keep working, free.</p><div id="billing"></div>' +
      (d && d.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(d.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- clicks ---------------- */

  function promptName(label, was, max) {
    var v = prompt(label, was);
    if (v === null) return null;
    return v;
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act2 = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    var g = cur();
    var sid = t.getAttribute('data-sid'), ri = Number(t.getAttribute('data-r'));
    switch (act2) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); closeSheet(true); go(''); break;
      case 'tab': {
        closeSheet(true);
        var tb = t.getAttribute('data-tab');
        if (tb === 'score') { var sg = gameById(state.trying ? state.demo.current : games.current); go(sg ? 'g/' + sg.id : ''); }
        else go(tb === 'games' ? '' : tb);
        break;
      }
      case 'games': openGames(); break;
      case 'try': closeSheet(true); startTry(); break;
      case 'tryleave': leaveTry(); go(''); toast('That was the made-up game night - nothing was saved.'); break;
      case 'tryown': closeSheet(true); leaveTry(); go('new'); break;
      case 'new': closeSheet(true); go('new'); break;
      case 'pick': state.setup = null; go('new/' + t.getAttribute('data-g')); break;
      case 'joinnew': closeSheet(true); state.join = { code: '', info: null }; go('join'); break;
      case 'open': closeSheet(true); go('g/' + id); break;
      // setting up
      case 'padd': { var pp = bk().people.filter(function (x) { return x.id === t.getAttribute('data-pid'); })[0]; if (pp && state.setup) { if (state.setup.players.some(function (x) { return x.emoji === pp.emoji; })) state.setup.players.push({ id: pp.id, name: pp.name, emoji: nextEmoji(state.setup.players.map(function (x) { return x.emoji; })) }); else state.setup.players.push({ id: pp.id, name: pp.name, emoji: pp.emoji }); draw(); } break; }
      case 'pgroup': {
        var gr = bk().groups.filter(function (x) { return x.id === t.getAttribute('data-gid'); })[0];
        if (gr && state.setup) { gr.people.forEach(function (pid) { var p2 = bk().people.filter(function (x) { return x.id === pid; })[0]; if (p2 && !state.setup.players.some(function (x) { return x.id === p2.id; })) state.setup.players.push({ id: p2.id, name: p2.name, emoji: state.setup.players.some(function (x) { return x.emoji === p2.emoji; }) ? nextEmoji(state.setup.players.map(function (x) { return x.emoji; })) : p2.emoji }); }); state.setup.group = gr.id; draw(); }
        break;
      }
      case 'prm': state.setup.players.splice(Number(t.getAttribute('data-i')), 1); draw(); break;
      case 'pup': case 'pdown': { var i = Number(t.getAttribute('data-i')), j = i + (act2 === 'pup' ? -1 : 1), pl = state.setup.players; if (pl[i] && pl[j]) { var tmp = pl[i]; pl[i] = pl[j]; pl[j] = tmp; } draw(); break; }
      case 'pemoji': openEmoji(Number(t.getAttribute('data-i'))); break;
      case 'setemoji': { var k = Number(t.getAttribute('data-i')), em = C.cleanEmoji(t.getAttribute('data-e')); if (state.setup && state.setup.players[k]) { state.setup.players[k].emoji = em; } closeSheet(true); draw(); break; }
      case 'startgame': startGame(); break;
      // scoring
      case 'undo': if (g && canScore(g)) { var u = C.undo(g, o()); putGame(u); draw(); say('Undone.'); } break;
      case 'redo': if (g && canScore(g)) { var rd = C.redo(g, o()); putGame(rd); draw(); say('Redone.'); } break;
      case 'cell': if (g) openCell(g, ri, sid); break;
      case 'roundmenu': if (g) openRoundMenu(g, ri); break;
      case 'hand': if (g) openHeartsHand(g, isFinite(ri) && t.hasAttribute('data-r') ? ri : null); break;
      case 'moon': if (g) openMoon(g); break;
      case 'moonby': closeSheet(true); if (g) saveHand(g, null, { moon: sid }); break;
      case 'cribhand': if (g) openCribHand(g); break;
      case 'stroke': if (g) openStroke(g, ri, sid); break;
      case 'par': if (g) openPar(g, ri); break;
      case 'die': if (state.dice.length < 5) { state.dice.push(Number(t.getAttribute('data-n'))); draw(); } break;
      case 'dieout': state.dice.splice(Number(t.getAttribute('data-i')), 1); draw(); break;
      case 'diceclear': state.dice = []; draw(); break;
      case 'dicefor': state.diceFor = sid; draw(); break;
      case 'box': if (g) scoreBox(g, sid, t.getAttribute('data-box')); break;
      case 'boxfilled': toast('That box is filled. Undo to change it.'); break;
      case 'extra': if (g) act(g, function (x) { C.diceExtra(x, sid); }, '+100 bonus.'); break;
      case 'bowlfor': state.bowlFor = sid; draw(); break;
      case 'pins': if (g) { var bs = bowlFor(g); var n = Number(t.getAttribute('data-n')); act(g, function (x) { x.data.rolls[bs] = C.bowlAdd(x.data.rolls[bs] || [], n); }); var nx = C.bowlNext((gameById(g.id).data.rolls[bs]) || []); if (!nx || nx.ball === 1) state.bowlFor = null; draw(); } break;
      case 'dartsfor': state.dartsFor = sid; state.dartIn = ''; state.dartAsk = null; draw(); break;
      case 'dk': { var key = t.getAttribute('data-k'), s = state.dartIn || ''; if (key === 'b') s = s.slice(0, -1); else if (key === 'c') s = ''; else if (s.length < 3) s = (s + key).replace(/^0+(?=\d)/, ''); state.dartIn = s; draw(); break; }
      case 'dq': if (g) dartsScore(g, dartsFor(g), Number(t.getAttribute('data-n'))); break;
      case 'dscore': if (g && state.dartIn !== '') dartsScore(g, dartsFor(g), Number(state.dartIn)); break;
      case 'ddouble': if (g) dartsScore(g, dartsFor(g), state.dartPending, t.getAttribute('data-yes') === '1'); break;
      // the game
      case 'players': if (g) openPlayers(g); break;
      case 'late': { var lp = bk().people.filter(function (x) { return x.id === t.getAttribute('data-pid'); })[0]; if (g && lp) addLate(g, '', { id: lp.id, name: lp.name, emoji: lp.emoji }, null); break; }
      case 'srename': { var sd = g && C.sideOf(g, sid); if (!sd) break; var nn = promptName('Rename ' + sd.name + ':', sd.name); if (nn === null) break; act(g, function (x) { C.renameSide(x, sid, nn); }); openPlayers(gameById(g.id)); break; }
      case 'sup': case 'sdown': if (g) { act(g, function (x) { C.moveSide(x, sid, act2 === 'sup' ? -1 : 1); }); openPlayers(gameById(g.id)); } break;
      case 'sdrop': if (g) { var sd2 = C.sideOf(g, sid); if (sd2 && confirm('Take ' + sd2.name + ' out of this game?')) { act(g, function (x) { C.dropSide(x, sid); }); openPlayers(gameById(g.id)); } } break;
      case 'gamemenu': if (g) openGameMenu(g); break;
      case 'finish': if (g && confirm('Finish ' + g.name + ' now? The scores as they stand decide it. Undo brings it back.')) { closeSheet(true); act(g, function (x) { C.endNow(x); }); } break;
      case 'rematch': if (g) { closeSheet(true); var info = C.infoOf(g); startSetup(info.id, g); go('new/' + info.id); } break;
      case 'recap': if (g) openRecap(g); break;
      case 'delgame':
        if (!g || !confirm('Delete ' + g.name + ' from this phone?' + (g.shared ? ' Sharing stops too.' : '') + ' A finished game stays in Our table.')) break;
        closeSheet(true);
        (g.shared && g.shared.role === 'scorer' && !state.trying ? api('DELETE', 'api/t/' + g.shared.id).catch(function () { /* already gone */ }) : Promise.resolve()).then(function () { var keepHist = g.status === 'done'; dropGame(g.id); if (!keepHist) syncHistory({ id: g.id, status: 'playing' }); go(''); toast('Deleted.'); });
        break;
      case 'ainow': closeSheet(true); if (g) openAi(g.id); break;
      case 'ainew': openAi('new'); break;
      // the table
      case 'share': if (g) openShare(g); break;
      case 'invite': if (g && g.shared) openInvite(g); break;
      case 'sharelink': if (g && g.shared) shareText('Watch ' + g.name, 'Watch our ' + g.name + ' scores live on Pencil - code ' + C.formatCode(g.shared.code) + ':', C.joinUrl(ORIGIN, BASE, g.shared.code)); break;
      case 'pencil': {
        if (!g || !g.shared) break;
        var who = (g.shared.members || []).filter(function (m) { return m.id === t.getAttribute('data-mid'); })[0];
        if (!who || !confirm('Hand the pencil to ' + who.name + '? They keep score from now on, and this phone watches.')) break;
        api('POST', 'api/t/' + g.shared.id + '/pencil', { to: who.id }).then(function (r) { closeSheet(true); takeTable(r.table); draw(); toast(who.name + ' has the pencil now.', 4200); }).catch(function (err) { showError(err); });
        break;
      }
      case 'rmwatch': {
        if (!g || !g.shared || !confirm('Remove them? They can’t open this table any more.')) break;
        api('DELETE', 'api/t/' + g.shared.id + '/members/' + t.getAttribute('data-mid')).then(function (r) { var live = gameById(g.id); live.shared.members = r.table.members; live.shared.mv = r.table.mv || 0; saveGames(); openInvite(live); draw(); }).catch(function (err) { showError(err); });
        break;
      }
      case 'unshare':
        if (!g || !g.shared || !confirm('Stop sharing? Watchers can no longer open it. The game stays on this phone.')) break;
        api('DELETE', 'api/t/' + g.shared.id).catch(function (err) { if (err.status !== 404) throw err; }).then(function () { var live = gameById(g.id); delete live.shared; putGame(live, { quiet: true }); closeSheet(true); draw(); toast('Sharing stopped. The game is still here.'); }).catch(function (err) { showError(err); });
        break;
      case 'leave':
        if (!g || !g.shared || !confirm('Stop watching ' + g.name + '?')) break;
        closeSheet(true);
        api('DELETE', 'api/t/' + g.shared.id + '/me').catch(function () { /* gone already */ }).then(function () { dropGame(g.id); go(''); toast('You left the table.'); });
        break;
      // our table and more
      case 'group': state.group = t.getAttribute('data-gid') || ''; draw(); break;
      case 'histmore': state.histMore = true; draw(); break;
      case 'csvout': download('pencil-history.csv', 'text/csv', C.historyCsv(bk().history)); toast('Downloaded - made on this phone.'); break;
      case 'jsonout': download('pencil-history.json', 'application/json', C.exportJson(bk())); toast('Downloaded - made on this phone.'); break;
      case 'gtoggle': {
        var b2 = bk(), gg = b2.groups.filter(function (x) { return x.id === t.getAttribute('data-gid'); })[0], pid = t.getAttribute('data-pid');
        if (!gg) break;
        gg.people = gg.people.indexOf(pid) >= 0 ? gg.people.filter(function (x) { return x !== pid; }) : gg.people.concat([pid]);
        saveBook(); draw(); break;
      }
      case 'grename': { var b3 = bk(), g3 = b3.groups.filter(function (x) { return x.id === t.getAttribute('data-gid'); })[0]; if (!g3) break; var gn = promptName('Rename ' + g3.name + ':', g3.name); var cg = gn === null ? null : C.cleanGroup({ name: gn }); if (cg) { g3.name = cg.name; saveBook(); draw(); } break; }
      case 'gdel': { var b4 = bk(), g4 = b4.groups.filter(function (x) { return x.id === t.getAttribute('data-gid'); })[0]; if (g4 && confirm('Delete the group ' + g4.name + '? Its games stay in the history.')) { b4.groups = b4.groups.filter(function (x) { return x.id !== g4.id; }); if (state.group === g4.id) state.group = ''; saveBook(); draw(); } break; }
      case 'pplrename': {
        var b5 = bk(), p5 = b5.people.filter(function (x) { return x.id === t.getAttribute('data-pid'); })[0]; if (!p5) break;
        var pn = promptName('Rename ' + p5.name + ':', p5.name); if (pn === null) break;
        var cn = C.cleanName(pn);
        if (!cn) { toast('A name needs a letter in it.'); break; }
        if (b5.people.some(function (x) { return x.id !== p5.id && C.norm(x.name) === C.norm(cn); })) { toast(cn + ' is already in your people.'); break; }
        p5.name = cn;
        b5.history.forEach(function (h) { h.sides.forEach(function (s) { s.people.forEach(function (q) { if (q.id === p5.id) q.name = cn; }); if (s.people.length === 1 && s.people[0].id === p5.id) s.name = cn; }); });
        saveBook(); draw(); break;
      }
      case 'pplemoji': {
        var p6 = bk().people.filter(function (x) { return x.id === t.getAttribute('data-pid'); })[0]; if (!p6) break;
        sheet('<h2>' + esc(p6.name) + '’s emoji</h2><div class="emogrid">' + C.EMOJI.map(function (x) { return '<button type="button" data-act="setpplemoji" data-pid="' + esc(p6.id) + '" data-e="' + esc(x) + '" aria-pressed="' + (p6.emoji === x) + '">' + esc(x) + '</button>'; }).join('') + '</div>');
        break;
      }
      case 'setpplemoji': { var p7 = bk().people.filter(function (x) { return x.id === t.getAttribute('data-pid'); })[0]; if (p7) { p7.emoji = C.cleanEmoji(t.getAttribute('data-e')); saveBook(); } closeSheet(true); draw(); break; }
      case 'pplforget': {
        var b8 = bk(), p8 = b8.people.filter(function (x) { return x.id === t.getAttribute('data-pid'); })[0];
        if (!p8 || !confirm('Forget ' + p8.name + '? They leave your recent players and groups. Games they played stay in the history.')) break;
        b8.people = b8.people.filter(function (x) { return x.id !== p8.id; });
        b8.groups.forEach(function (gr2) { gr2.people = gr2.people.filter(function (x) { return x !== p8.id; }); });
        saveBook(); draw(); break;
      }
      case 'wipe':
        if (!confirm('Erase every game, person, group and the whole history from this phone? This can’t be undone.')) break;
        games = { list: [], current: null }; book = { people: [], groups: [], history: [] };
        keep(K_GAMES, null); keep(K_BOOK, null);
        go(''); toast('Erased.');
        break;
      default: break;
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  /* ---------------- start ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill) pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  // A shown table: every few seconds while it is on screen and the page is
  // visible (one read when nothing moved), and when the app comes back. A
  // redraw waits while someone is typing or a sheet is open.
  function busyTyping() { var a = document.activeElement; return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); }
  function poll() {
    var g = cur();
    if (state.view !== 'game' || !g || !g.shared || state.trying || document.visibilityState !== 'visible') return;
    if (state.unsent[g.id]) { pushShared(g.id); return; }
    var wasOffline = state.offline;
    refreshShared(g).then(function (changed) { if ((changed || wasOffline !== state.offline) && $('#sheet').hidden && !busyTyping()) draw(); });
  }
  setInterval(poll, 4000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') poll(); });
  window.addEventListener('online', function () { state.offline = false; poll(); });
  window.addEventListener('offline', function () { state.offline = true; if (cur() && cur().shared) draw(); });
  drawTop();
  route();
  poll();
  loadMe().then(function () {
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openAccountSheet();
  });
}());
