/* Chapter - the page. One file, no build step.
 *
 * A club lives on the lab's server under an opaque id and a join code; this
 * browser holds a member key (an HttpOnly cookie the page never sees). The
 * page draws whatever the server sends - ChapterCore.memberView, the same
 * function the made-up club is drawn with - and the server has already left
 * out the text of every note past this reader's bookmark.
 *
 * What this device keeps (localStorage, every access wrapped, and the page
 * works without it): the clubs it is in (ids and names), the last club it
 * saw (so the club opens offline, read-only), and the name and emoji last
 * used to join. Nothing else.
 *
 * The requests this page makes: the club and its writes; joining; moving a
 * seat to another phone; sign-in and, only if a signed-in member asks,
 * keeping clubs on the account; "Suggest discussion questions", whose
 * request is shown before it is sent; "Read it", which asks the server
 * whether a legal copy exists (and only after a tap puts the Internet
 * Archive's own reader in a frame - the book never passes through Chapter);
 * and the member's own library (an ISBN
 * looked up through the server, never by the page itself, and the books).
 * The camera, when a member scans a barcode, is read on the phone: only the
 * ISBN it finds is sent.
 *
 * Every string a member typed, the server answered or a model wrote is
 * escaped before it is drawn, and no handler is written into markup: clicks
 * are routed by data-act attributes from one listener (the lab's CSP allows
 * script from this origin only).
 */
(function () {
  'use strict';

  var C = window.ChapterCore;
  var QR = window.ChapterQR;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  // A tag the browser reports but Intl refuses ("en-US@posix" in some
  // headless browsers) would make every date throw: fall back.
  var LOCALE = (function () { try { return Intl.getCanonicalLocales(navigator.language || 'en-US')[0] || 'en-US'; } catch (e) { return 'en-US'; } }());
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } }());
  var K_CLUBS = 'chapter-clubs-v1', K_LAST = 'chapter-last-v1', K_ME = 'chapter-me-v1';
  var BMC = ['#e9c6ef', '#f6d3b0', '#c9e4d6', '#cfe0f5', '#f5cfd9', '#e4dcc0', '#d6d0f0', '#f3e3a6', '#c7e8ea', '#f1d5c2'];

  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function now() { return Date.now(); }
  function rand(n) { var a = new Uint32Array(1); try { crypto.getRandomValues(a); } catch (e) { a[0] = Math.floor(Math.random() * 4294967296); } return a[0] % n; }

  /* ---------------- what this device keeps ---------------- */

  function myClubs() {
    var l = recall(K_CLUBS);
    return Array.isArray(l) ? l.filter(function (c) { return c && /^[A-Za-z0-9_-]{16}$/.test(c.id); }).slice(0, 40) : [];
  }
  function rememberClub(v) {
    var l = myClubs().filter(function (c) { return c.id !== v.id; });
    var me = v.board.rows.filter(function (r) { return r.you; })[0];
    l.unshift({ id: v.id, name: C.plain(v.name, 48), book: C.plain(v.book.title, 100), emoji: C.cleanEmoji(me && me.emoji), at: now() });
    keep(K_CLUBS, l.slice(0, 40));
    keep(K_LAST, { id: v.id, at: now(), club: v });
  }
  function forgetClub(id) {
    keep(K_CLUBS, myClubs().filter(function (c) { return c.id !== id; }));
    var last = recall(K_LAST);
    if (last && last.id === id) keep(K_LAST, null);
  }
  var meDefaults = recall(K_ME) || {};

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    var headers = { 'X-Today': today(), 'X-Locale': LOCALE };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin', headers: headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok || d.error) { var e = new Error(d.error || 'Something went wrong.'); e.status = res.status; e.data = d; throw e; }
        return d;
      });
    }, function () { var e = new Error('You’re offline - that needs the internet.'); e.status = 0; e.offline = true; throw e; });
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
    if (navigator.share) return navigator.share({ title: title, text: text, url: url }).catch(function (e) { if (!e || e.name !== 'AbortError') copy(text + ' ' + url, 'Copied - paste it into your group chat.'); });
    copy(text + ' ' + url, 'Copied - paste it into your group chat.');
    return Promise.resolve();
  }
  function slug(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'book'; }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function stars(n) {
    var out = '<span class="stars" aria-hidden="true">';
    for (var i = 1; i <= 5; i++) out += n >= i - 0.25 ? '<span>★</span>' : '<span class="off">☆</span>';
    return out + '</span>';
  }

  /* One icon set: 24px, a 1.5px line, drawn by stylesheet (stroke, no fill). */
  var ICONS = {
    chat: 'M5 5.5h14v9.5h-8.2L6.5 19v-4H5z',
    calendar: 'M4.5 6.5h15v13h-15zM4.5 10.5h15M8.5 4v4M15.5 4v4',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    book: 'M12 7c-2-1.4-4.8-1.9-7.5-1.5v12.5c2.7-.4 5.5.1 7.5 1.5 2-1.4 4.8-1.9 7.5-1.5V5.5C16.800 5.1 14 5.600 12 7zM12 7v12.5',
    bag: 'M6.500 8.500h11l-.9 11H7.400zM9 8.500V7a3 3 0 016 0v1.500',
    lock: 'M7 11h10v8.500H7zM9 11V8.500a3 3 0 016 0V11',
    people: 'M3.500 19c0-3 2.300-5 5.500-5s5.500 2 5.500 5M9 11a3.250 3.250 0 100-6.500A3.250 3.250 0 009 11zM18 8.500v6M15 11.500h6',
    chevron: 'M9.500 6l6 6-6 6',
    plus: 'M12 5.500v13M5.500 12h13',
    pin: 'M12 20.500s6-5.400 6-10a6 6 0 10-12 0c0 4.600 6 10 6 10zM12 12.500a2 2 0 100-4 2 2 0 000 4z',
    flag: 'M6 20.500v-16M6 5h11l-2 3.500 2 3.500H6',
    video: 'M4.500 7.500h10v9h-10zM14.500 10.500l5-2.500v8l-5-2.500',
  };
  function ic(name) { return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICONS[name] + '"/></svg>'; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" data-u="margin-top-0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Chapter stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
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

  /* ---------------- state ---------------- */

  var state = {
    me: null, view: 'home', tab: 'board', clubId: '', club: null,
    demo: null, offline: false, offlineAt: 0,
    seen: null, reveal: {}, partied: {},
    filter: 'all', compose: { kind: 'note', text: '', at: null },
    joinPreview: null, joinCode: '', joinEmoji: null,
    start: { emoji: null },
    card: { url: null, blob: null, bid: '' },
    ai: null, accountClubs: null, pendingDraw: false, picker: '',
    library: null, libraryErr: '', scan: null,
    chapter: 'all', replyTo: '', replyText: '',
  };
  // The made-up club's book is public domain: its "Read it" opens this scan
  // at the Internet Archive (checked like any answer from the server).
  var DEMO_READ = { kind: 'read', ia: 'bwb_KS-179-237', work: '/works/OL66554W', title: 'Pride and Prejudice', author: 'Jane Austen', year: 1900 };
  /** A note, a reply or a meeting note this reader has been sent, by id. */
  function findNote(v, id) {
    var hit = null;
    function look(n) { if (n.id === id) hit = n; (n.replies || []).forEach(look); }
    (v.notes || []).forEach(look);
    (v.meetings || []).forEach(function (m) { (m.notes || []).forEach(look); });
    return hit;
  }
  function demoView() {
    var v = C.memberView(state.demo.club, state.demo.notes, state.demo.you, { today: today(), locale: LOCALE });
    v.demo = true; v.kept = false; v.account = false;
    return v;
  }
  function V() { return state.demo ? demoView() : state.club; }
  function isDemo() { return Boolean(state.demo); }
  function myRow(v) { return v.board.rows.filter(function (r) { return r.you; })[0] || null; }
  function myPos(v) { var r = myRow(v); return r ? (r.done ? v.book.total : r.pos) : 0; }

  /** A write to the club: in the made-up club, the core's own function run
   *  here on the copy in memory (nothing is saved); in a real one, the
   *  server runs the same function and answers with the new view. */
  function write(method, path, body, demoFn) {
    if (state.demo) {
      try {
        var r = demoFn(state.demo.club, state.demo.you);
        if (r && r.patch) state.demo.club = C.applyPatch(state.demo.club, r.patch);
        state.demo.club.v = (state.demo.club.v || 0) + 1;
        return Promise.resolve({ club: demoView(), msg: (r && r.msg) || '' });
      } catch (e) { return Promise.reject(e); }
    }
    return api(method, 'api/c/' + encodeURIComponent(state.clubId) + path, body).then(function (d) { if (d.club) setClub(d.club); return d; });
  }
  function setClub(v) {
    state.club = v; state.offline = false;
    rememberClub(v);
  }

  /* ---------------- routing (all in the #fragment, which never leaves the phone) ---------------- */

  var TABS = ['board', 'notes', 'meet', 'next', 'shelf'];
  function parse() {
    var h = decodeURIComponent(location.hash.replace(/^#/, ''));
    var m;
    if ((m = /^join(?:=(.*))?$/.exec(h))) return { view: 'join', arg: m[1] || '' };
    if ((m = /^move=(.+)$/.exec(h))) return { view: 'move', arg: m[1] };
    if (h === 'start') return { view: 'start' };
    if (h === 'library') return { view: 'library' };
    if ((m = /^try(?:\/(\w+))?$/.exec(h))) return { view: 'try', tab: m[1] };
    if ((m = /^c\/([A-Za-z0-9_-]{16})(?:\/(\w+))?$/.exec(h))) return { view: 'club', arg: m[1], tab: m[2] };
    return { view: 'home' };
  }
  function go(hash) {
    if (location.hash.replace(/^#/, '') === hash) route();
    else location.hash = hash;
  }
  function clubHash(tab) { return (isDemo() ? 'try' : 'c/' + state.clubId) + (tab && tab !== 'board' ? '/' + tab : ''); }
  function route() {
    var r = parse();
    closeSheet(true);
    state.tab = TABS.indexOf(r.tab) >= 0 ? r.tab : 'board';
    if (r.view === 'try') {
      if (!state.demo) { state.demo = C.demo(today()); state.seen = null; }
      state.view = 'club'; state.clubId = ''; draw(); return;
    }
    state.demo = null;
    if (r.view === 'club') {
      var same = state.clubId === r.arg && state.club && state.club.id === r.arg;
      state.view = 'club'; state.clubId = r.arg;
      if (!same) { state.club = null; state.seen = null; state.compose = { kind: 'note', text: '', at: null }; state.chapter = 'all'; state.replyTo = ''; state.replyText = ''; }
      draw();
      loadClub(!same);
      return;
    }
    state.view = r.view; state.clubId = ''; state.club = null;
    if (r.view === 'join') { state.joinCode = C.normalizeCode(r.arg); state.joinPreview = null; draw(); if (C.isCode(state.joinCode)) lookUp(state.joinCode); return; }
    if (r.view === 'move') { draw(); claimMove(r.arg); return; }
    if (r.view === 'library') { state.libraryErr = ''; draw(); loadLibrary(); return; }
    draw();
    if (r.view === 'home' && signedIn()) loadAccountClubs();
  }
  window.addEventListener('hashchange', function () { route(); arrive(); });
  /** The page rises in when the view changes - only then, and only where the
   *  stylesheet allows motion. */
  function arrive() {
    var m = $('#main');
    m.classList.remove('enter');
    void m.offsetWidth;
    m.classList.add('enter');
  }

  /* ---------------- loading a club ---------------- */

  function loadClub(fresh) {
    var id = state.clubId;
    var since = !fresh && state.club && state.club.id === id && state.lastDay === today() ? '?since=' + state.club.v : '';
    return api('GET', 'api/c/' + encodeURIComponent(id) + since).then(function (d) {
      if (state.clubId !== id || isDemo()) return;
      state.lastDay = today();
      if (d.same) { if (state.offline) { state.offline = false; draw(); } return; }
      var before = state.club;
      setClub(d.club);
      noticeUnlocks(before, d.club, false);
      softDraw();
    }).catch(function (e) {
      if (state.clubId !== id) return;
      if (e.offline) {
        var last = recall(K_LAST);
        if (last && last.id === id && last.club && !state.club) { state.club = last.club; state.offline = true; state.offlineAt = last.at; draw(); return; }
        if (state.club) { if (!state.offline) { state.offline = true; state.offlineAt = now(); draw(); } return; }
      }
      if (e.status === 404) { forgetClub(id); state.club = null; state.gone = e.message; draw(); return; }
      if (!state.club) { state.gone = e.message; draw(); }
    });
  }
  /** Redraw unless someone is typing in the page; then wait until they stop. */
  function softDraw() {
    var a = document.activeElement;
    if (a && $('#main').contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { state.pendingDraw = true; return; }
    draw();
  }
  $('#main').addEventListener('focusout', function () { setTimeout(function () { if (state.pendingDraw) { state.pendingDraw = false; softDraw(); } }, 50); });

  /** Notes that became readable because MY bookmark moved get a small
   *  reveal, once. */
  function noticeUnlocks(before, after, mine) {
    if (!after) return;
    var ids = after.notes.map(function (n) { return n.id; });
    if (!before || before.id !== after.id) { state.seen = ids; return; }
    var prev = state.seen || before.notes.map(function (n) { return n.id; });
    var fresh = ids.filter(function (id) { return prev.indexOf(id) < 0; });
    state.seen = ids;
    if (!mine || !fresh.length) return;
    fresh.forEach(function (id) { state.reveal[id] = true; });
    if (state.tab === 'notes') state.scrollReveal = true;
    toast('🔓 ' + plural(fresh.length, 'note') + ' unlocked', 4200, state.tab === 'notes' ? null : { label: 'Read', fn: function () { state.scrollReveal = true; go(clubHash('notes')); } });
    say(plural(fresh.length, 'note') + ' unlocked.');
  }

  /* ---------------- drawing ---------------- */

  function draw() {
    var main = $('#main');
    var tb = $('#tabbar');
    var inClub = state.view === 'club' && (isDemo() || state.club);
    tb.hidden = !inClub;
    if (state.view === 'home') main.innerHTML = myClubs().length || (state.accountClubs && state.accountClubs.length) ? viewHome() : viewFirst();
    else if (state.view === 'start') main.innerHTML = viewStart();
    else if (state.view === 'library') main.innerHTML = viewLibrary();
    else if (state.view === 'join') main.innerHTML = viewJoin();
    else if (state.view === 'move') main.innerHTML = '<div class="card center"><div data-u="font-size-2rem">📲</div><h1>Moving your seat to this phone…</h1><p class="muted">One moment.</p></div>';
    else if (state.view === 'club') main.innerHTML = inClub ? viewClub() : state.gone ? viewGone() : '<div class="card center"><p class="muted">Opening the club…</p></div>';
    $$('#tabbar [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === state.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var lb = $('#lockBadge');
    if (inClub) { var v = V(); lb.hidden = !v.locked.total; lb.textContent = v.locked.total ? String(v.locked.total) : ''; } else lb.hidden = true;
    after();
  }
  /** Sizes and colours worked out per reader (how far along the book, a
   *  bookmark's colour) are set through the style object, never written
   *  into markup as a style attribute - so the page carries no inline style. */
  var DYN = [['data-w', 'width', '%'], ['data-l', 'left', '%'], ['data-b', 'bottom', 'px'], ['data-h', 'height', 'px']];
  function dyn(root) {
    DYN.forEach(function (d) {
      $$('[' + d[0] + ']', root).forEach(function (el) { var n = Number(el.getAttribute(d[0])); if (isFinite(n)) el.style[d[1]] = Math.max(0, n) + d[2]; });
    });
    $$('[data-c]', root).forEach(function (el) { var c = el.getAttribute('data-c'); if (/^#[0-9a-f]{6}$/i.test(c)) el.style.setProperty('--bmc', c); });
    $$('[data-bg]', root).forEach(function (el) { var c = el.getAttribute('data-bg'); if (/^#[0-9a-f]{6}$/i.test(c)) el.style.background = c; });
  }
  function after() {
    dyn($('#main'));
    if (state.view === 'start') bindStart();
    if (state.view === 'library') bindLibrary();
    if (state.view === 'join') bindJoin();
    if (state.view === 'club' && (isDemo() || state.club)) bindClub();
    var rv = $$('.nt.reveal');
    rv.forEach(function (el) { el.addEventListener('animationend', function () { el.classList.remove('reveal'); }); });
    if (rv.length && state.scrollReveal) { state.scrollReveal = false; try { rv[rv.length - 1].scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } catch (e) { /* ignore */ } }
    Object.keys(state.reveal).forEach(function (id) { if ($('[data-nt="' + id + '"]')) delete state.reveal[id]; });
  }

  /* ---- the first run ---- */

  function mockBoard() {
    var rows = [['🦊', 100], ['🦉', 49], ['🐙', 34], ['🌻', 29.5, true], ['🐢', 24.6], ['🐝', 14.8]];
    return '<div class="mock" aria-hidden="true"><div class="mtop"><small>The Quillfeather Readers · 6 readers</small><b>Pride and Prejudice</b></div>' +
      '<div class="mtrack">' + spineHtml(rows.map(function (r, i) { return { pct: r[1], emoji: r[0], you: Boolean(r[2]), color: BMC[i] }; }), { pct: 68.9, label: 'Thu · ch 42' }, 29.5, 'Start', 'ch 61') + '</div>' +
      '<div class="mline">Maya is 3 chapters ahead of you</div>' +
      '<div class="mline lock">4 notes waiting past chapter 18</div>' +
      '<div class="mline warn">Read 4 chapters a day to reach chapter 42 by Thu</div></div>';
  }
  function viewFirst() {
    return '<section class="hero"><h1>Read together.</h1>' +
      '<p class="lead">A book club that keeps up - and never spoils the ending.</p>' +
      '<div class="cta"><button class="btn big" type="button" data-act="startform">Start a club</button><button class="btn big soft" type="button" data-act="joinform">Join with a code</button></div>' +
      '<p class="hero-more"><button class="link-btn" type="button" data-act="try">Try the example club</button><button class="link-btn" type="button" data-act="library">Keep my own library</button></p>' +
      '</section>' + mockBoard() +
      '<section class="band"><h2>Every club has the same three problems</h2><div class="grid three">' +
      '<div class="problem"><span class="q">“Who’s read how far?”</span><p class="muted small">Half the club is on chapter 30, someone hasn’t started, and the meeting is Thursday.</p><span class="a">A board of bookmarks: who’s where, and how much a day gets you there.</span></div>' +
      '<div class="problem"><span class="q">The spoiler in the group chat</span><p class="muted small">The fast reader can’t help it, and the twist is gone for everyone else.</p><span class="a">Threads by chapter - locked until you’ve read that far.</span></div>' +
      '<div class="problem"><span class="q">The endless “what next?” thread</span><p class="muted small">Forty messages, three polls and nobody sure what won.</p><span class="a">Nominate, tap every book you’d read - a clear winner, and the tie-break shown.</span></div>' +
      '</div></section>' +
      '<section class="band"><h2>How it works</h2><ol class="how">' +
      '<li><div><b>Start a club</b> with the book and how many chapters it has.<br><span class="muted small">Chapters are the same in every edition; pages are not.</span></div></li>' +
      '<li><div><b>Share the code</b> in your group chat. Friends join with a first name and an emoji - no account, no app.</div></li>' +
      '<li><div><b>Move your bookmark</b> as you read. Threads unlock as you catch up, and the board shows the meeting as the finish line.</div></li></ol></section>' +
      '<section class="band"><h2>Also in every club</h2><div class="grid two feats">' +
      '<div class="feat">' + ic('calendar') + '<b>Meetups</b><span class="muted small">Date, place or call link, RSVPs, meeting notes, and one tap into your calendar.</span></div>' +
      '<div class="feat">' + ic('chat') + '<b>Discussion questions</b><span class="muted small">Members add their own, by chapter, under the same spoiler rule. Signed in, AI can suggest a few.</span></div>' +
      '<div class="feat">' + ic('book') + '<b>Read it, or buy it</b><span class="muted small">A free public-domain copy opens right here when one exists; otherwise, where to borrow or buy.</span></div>' +
      '<div class="feat">' + ic('check') + '<b>The vote and the shelf</b><span class="muted small">Pick the next book together; every book you finish keeps its stars and the club average.</span></div>' +
      '</div><p class="small muted center fine">The club is kept on the lab’s server under a code; this phone holds your key. A club nobody opens for 120 days is deleted. Signing in is optional.</p></section>';
  }

  function viewHome() {
    var local = myClubs();
    var seen = {};
    var rows = local.map(function (c) { seen[c.id] = true; return clubRow(c.id, c.emoji, c.name, c.book); });
    (state.accountClubs || []).forEach(function (c) { if (!seen[c.id]) rows.push(clubRow(c.id, c.emoji, c.name, c.book + ' · on your account')); });
    return '<div class="sec-head"><h1>Your clubs</h1></div>' + rows.join('') +
      '<div class="row" data-u="margin-top-14px"><button class="btn" type="button" data-act="startform">Start a club</button><button class="btn ghost" type="button" data-act="joinform">Join with a code</button><button class="btn ghost" type="button" data-act="try">Try the example</button></div>' +
      '<button class="crow" type="button" data-act="library" data-u="margin-top-18px"><span class="tile">📚</span><span><b>My library</b><small>Every book you own - scan the barcode to add one. Only you see it.</small></span><span aria-hidden="true">›</span></button>' +
      (signedIn() || !(state.me && state.me.account) ? '' : '<p class="small muted" data-u="margin-top-14px">Using another phone or a laptop too? <button class="link-btn" type="button" data-act="signin">Sign in (free)</button> and keep your clubs on your account - optional.</p>');
  }
  function clubRow(id, emoji, name, sub) {
    return '<button class="crow" type="button" data-act="openclub" data-id="' + esc(id) + '"><span class="tile">' + esc(C.cleanEmoji(emoji)) + '</span><span><b>' + esc(name) + '</b><small>' + esc(sub) + '</small></span><span aria-hidden="true">›</span></button>';
  }
  function viewGone() {
    return '<div class="card center"><div data-u="font-size-2rem">📕</div><h1>Not here</h1><p class="muted">' + esc(state.gone) + '</p><button class="btn" type="button" data-act="home">Back</button></div>';
  }

  /* ---- start and join ---- */

  function emojiPicker(sel, taken) {
    return '<div class="emojis" role="group" aria-label="Pick an emoji">' + C.EMOJI.map(function (e) {
      var t = taken && taken.indexOf(e) >= 0;
      return '<button type="button" data-emo="' + esc(e) + '" aria-pressed="' + (e === sel ? 'true' : 'false') + '"' + (t ? ' class="taken" aria-label="' + esc(e) + ', someone has it"' : '') + '>' + esc(e) + '</button>';
    }).join('') + '</div>';
  }
  function bindEmoji(root, set) {
    $$('[data-emo]', root).forEach(function (b) {
      b.addEventListener('click', function () {
        set(b.getAttribute('data-emo'));
        $$('[data-emo]', root).forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      });
    });
  }
  function viewStart() {
    var e = state.start.emoji || C.cleanEmoji(meDefaults.emoji);
    return '<div class="sec-head"><h1>Start a club</h1><button class="btn small ghost" type="button" data-act="home">Cancel</button></div>' +
      '<form class="card fields" id="startForm" autocomplete="off">' +
      '<label class="field"><span>Club name</span><input class="input" name="name" maxlength="48" required placeholder="Tuesday Readers"></label>' +
      '<label class="field"><span>Your first name</span><input class="input" name="you" maxlength="24" required value="' + esc(meDefaults.name || '') + '" autocomplete="given-name"></label>' +
      '<div class="field"><span>Your emoji</span>' + emojiPicker(e) + '</div>' +
      '<div class="sheet-sec" data-u="margin-top-4px"><p class="lab">The first book</p></div>' +
      '<label class="field"><span>Title</span><input class="input" name="title" maxlength="100" required></label>' +
      '<label class="field"><span>Author</span><input class="input" name="author" maxlength="60"></label>' +
      '<div class="fields two"><label class="field"><span>Chapters</span><input class="input" name="chapters" inputmode="numeric" pattern="[0-9]*" maxlength="3"></label>' +
      '<label class="field"><span>Pages <small class="hint">(only if no chapters)</small></span><input class="input" name="pages" inputmode="numeric" pattern="[0-9]*" maxlength="4"></label></div>' +
      '<p class="small muted" data-u="margin-0">Chapters are best: they’re the same in every edition, so notes unlock at the same place for everyone. Pages only work if everyone has the same edition.</p>' +
      '<div id="startErr"></div><button class="btn big block" type="submit">Start the club</button>' +
      '<p class="small muted center" data-u="margin-0">No account needed. You’ll be the host and get a code to share.</p></form>';
  }
  function bindStart() {
    var f = $('#startForm');
    bindEmoji(f, function (e) { state.start.emoji = e; });
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var btn = $('button[type=submit]', f);
      btn.disabled = true;
      var emoji = state.start.emoji || C.cleanEmoji(meDefaults.emoji);
      var body = { name: f.name.value, you: { name: f.you.value, emoji: emoji }, book: { title: f.title.value, author: f.author.value, chapters: f.chapters.value.trim() || null, pages: f.pages.value.trim() || null }, tz: TZ };
      api('POST', 'api/clubs', body).then(function (d) {
        meDefaults = { name: C.cleanName(f.you.value), emoji: emoji }; keep(K_ME, meDefaults);
        setClub(d.club); state.clubId = d.id; state.seen = [];
        go('c/' + d.id);
        setTimeout(function () { openClubSheet(true); }, 60);
      }).catch(function (e) { btn.disabled = false; showError(e, $('#startErr')); });
    });
  }
  function viewJoin() {
    var p = state.joinPreview;
    var code = C.formatCode(state.joinCode);
    var head = '<div class="sec-head"><h1>Join a club</h1><button class="btn small ghost" type="button" data-act="home">Cancel</button></div>';
    if (!p) {
      return head + '<form class="card fields" id="codeForm" autocomplete="off"><label class="field"><span>The club’s code</span><input class="input code" name="code" maxlength="9" required value="' + esc(code) + '" placeholder="ABC-DEF" autocapitalize="characters" spellcheck="false"></label>' +
        '<p class="small muted" data-u="margin-0">Six letters and numbers, from whoever invited you - on their Club page. Or open the link they sent.</p><div id="joinErr"></div><button class="btn big block" type="submit">Find the club</button></form>';
    }
    var e = state.joinEmoji || C.cleanEmoji(meDefaults.emoji);
    if (p.taken && p.taken.indexOf(e) >= 0 && !state.joinEmoji) e = C.EMOJI.filter(function (x) { return p.taken.indexOf(x) < 0; })[0] || e;
    state.joinEmoji = e;
    return head + '<div class="card"><p class="lab">You’re joining</p><h2 data-u="margin-0">' + esc(p.name) + '</h2><p class="muted" data-u="margin-4px-0-0">Reading <b>' + esc(p.book.title) + '</b>' + (p.book.author ? ' by ' + esc(p.book.author) : '') + ' · ' + esc(plural(p.members, 'reader')) + '</p></div>' +
      (p.full ? '<div class="card" data-u="margin-top-12px"><p class="err">This club is full (' + esc(C.LIMITS.members) + ' readers). Ask the host to make room.</p></div>' :
        '<form class="card fields" id="joinForm" data-u="margin-top-12px" autocomplete="off"><label class="field"><span>Your first name</span><input class="input" name="you" maxlength="24" required value="' + esc(meDefaults.name || '') + '" autocomplete="given-name"></label>' +
        '<div class="field"><span>Your emoji</span>' + emojiPicker(e, p.taken) + '</div><div id="joinErr"></div><button class="btn big block" type="submit">Join ' + esc(p.name) + '</button>' +
        '<p class="small muted center" data-u="margin-0">No account. This phone keeps a key so it can open the club again.</p></form>');
  }
  function lookUp(code) {
    api('GET', 'api/join/' + encodeURIComponent(code)).then(function (p) {
      if (p.already) { go('c/' + p.already); return; }
      state.joinPreview = p; state.joinEmoji = null; draw();
    }).catch(function (e) { state.joinPreview = null; draw(); showError(e, $('#joinErr')); });
  }
  function bindJoin() {
    var cf = $('#codeForm');
    if (cf) {
      cf.code.addEventListener('input', function () { var c = C.normalizeCode(cf.code.value); var f = C.formatCode(c); if (c.length === 6 && cf.code.value !== f) cf.code.value = f; });
      cf.addEventListener('submit', function (ev) { ev.preventDefault(); state.joinCode = C.normalizeCode(cf.code.value); if (!C.isCode(state.joinCode)) { showError(new Error('A code is six letters and numbers, like ABC-DEF.'), $('#joinErr')); return; } lookUp(state.joinCode); });
    }
    var jf = $('#joinForm');
    if (jf) {
      bindEmoji(jf, function (e) { state.joinEmoji = e; });
      jf.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var btn = $('button[type=submit]', jf); btn.disabled = true;
        api('POST', 'api/join/' + encodeURIComponent(state.joinCode), { name: jf.you.value, emoji: state.joinEmoji }).then(function (d) {
          meDefaults = { name: C.cleanName(jf.you.value), emoji: state.joinEmoji }; keep(K_ME, meDefaults);
          toast(d.isNew ? 'You’re in. Set your bookmark to where you are.' : 'You’re already in this club.', 3600);
          go('c/' + d.id);
        }).catch(function (e) { btn.disabled = false; showError(e, $('#joinErr')); });
      });
    }
  }
  function claimMove(token) {
    api('POST', 'api/move', { token: token }).then(function (d) {
      history.replaceState(null, '', BASE + '#c/' + d.id);
      toast('This phone has your seat now.', 3600);
      route();
    }).catch(function (e) {
      $('#main').innerHTML = '<div class="card center"><div data-u="font-size-2rem">⏳</div><h1>That link didn’t work</h1><p class="muted">' + esc(e.message) + '</p><button class="btn" type="button" data-act="home">OK</button></div>';
      history.replaceState(null, '', BASE);
    });
  }

  /* ---- a club ---- */

  function clubHead(v) {
    var demoBar = isDemo() ? '<div class="ribbon"><span>The made-up club - every tap works, nothing is saved.</span><span class="row"><button class="btn small" type="button" data-act="startform">Start my own</button><button class="btn small ghost" type="button" data-act="tryleave">Leave</button></span></div>' : '';
    var off = state.offline ? '<div class="offline-bar" role="status">You’re offline - this is the club as of ' + esc(new Date(state.offlineAt || now()).toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' })) + '. Moving your bookmark, notes and votes need the internet.</div>' : '';
    return demoBar + off + '<header class="pagehead"><div class="ph-main"><p class="eyebrow">' + esc(v.name) + '</p><h1>' + esc(v.book.title) + '</h1>' + (v.book.author ? '<p class="muted by">by ' + esc(v.book.author) + '</p>' : '') + '</div>' +
      '<button class="btn small ghost" type="button" data-act="clubsheet">' + ic('people') + '<span>Club</span></button></header>';
  }
  function viewClub() {
    var v = V();
    var body = state.tab === 'notes' ? viewNotes(v) : state.tab === 'meet' ? viewMeet(v) : state.tab === 'next' ? viewNext(v) : state.tab === 'shelf' ? viewShelf(v) : viewBoard(v);
    return clubHead(v) + body;
  }

  /* -- the board -- */

  /** Bookmarks along the book, each standing on a stem from the edge.
   *  One that would overlap the one before stands taller (the next lane). */
  function spineHtml(marks, finish, you, startLabel, endLabel) {
    var sorted = marks.slice().sort(function (a, b) { return a.pct - b.pct || (a.you ? 1 : -1); });
    var lanes = [];
    sorted.forEach(function (m) {
      var lane = 0;
      while (lanes[lane] !== undefined && m.pct - lanes[lane] < 10) lane++;
      lanes[lane] = m.pct; m.lane = lane;
    });
    var n = Math.max(1, lanes.length), H = 40, TOP = finish ? 30 : 6;
    var clamp = function (x) { return Math.max(0, Math.min(100, x)); };
    var pin = you === null || you === undefined ? null : clamp(you);
    return '<div class="spine-wrap" aria-hidden="true"><div class="spine-lanes" data-h="' + (TOP + (n - 1) * H + 40) + '">' +
      (finish ? '<span class="flag' + (finish.pct > 80 ? ' near-end' : finish.pct < 20 ? ' near-start' : '') + '" data-l="' + clamp(finish.pct) + '"><span>' + esc(finish.label) + '</span></span>' : '') +
      sorted.map(function (m) {
        return '<span class="bm' + (m.you ? ' you' : '') + '" data-l="' + clamp(m.pct) + '" data-b="' + (m.lane * H) + '" data-c="' + esc(m.color) + '"><span class="rib">' + esc(m.emoji) + '</span><span class="stem" data-h="' + (m.lane * H + 6) + '"></span></span>';
      }).join('') + '</div>' +
      '<div class="spine"><div class="fill" data-w="' + (pin === null ? 0 : pin) + '"></div></div>' +
      '<div class="spine-ends"><span' + (pin !== null && pin < 16 ? ' data-u="visibility-hidden"' : '') + '>' + esc(startLabel) + '</span>' + (pin !== null ? '<span class="you-pin" data-l="' + pin + '">You</span>' : '') + '<span' + (pin !== null && pin > 84 ? ' data-u="visibility-hidden"' : '') + '>' + esc(endLabel) + '</span></div></div>';
  }
  function colorOf(v, id) { var i = v.members.map(function (m) { return m.id; }).indexOf(id); return BMC[(i < 0 ? 0 : i) % BMC.length]; }
  function viewBoard(v) {
    var B = v.board, book = v.book, me = myRow(v);
    var finish = B.finish ? { pct: B.finish.pct, label: B.finish.label.charAt(0).toUpperCase() + B.finish.label.slice(1) + ' · ' + C.atShort(book, B.finish.at) } : null;
    var marks = B.rows.map(function (r) { return { pct: r.pct, emoji: r.emoji, you: r.you, color: colorOf(v, r.id) }; });
    var party = '';
    if (B.allDone) {
      var first = !state.partied[v.id + book.id];
      state.partied[v.id + book.id] = true;
      party = '<div class="party">' + (first ? '<div class="confetti" aria-hidden="true">🎉📚🎉</div>' : '') + '<h2>Everyone has finished ' + esc(book.title) + '</h2><p>' + (book.avg ? 'The club average so far: ' + esc(book.avg.toFixed(1)) + '★ from ' + esc(plural(book.rated, 'rating')) + '.' : 'Rate it, then pick what’s next.') + '</p>' +
        '<div class="row" data-u="justify-content-center"><button class="btn" type="button" data-act="tab" data-tab="next">Vote for the next book</button><button class="btn soft" type="button" data-act="card" data-id="' + esc(book.id) + '">Share card</button></div></div>';
    }
    var pos = me ? (me.done ? book.total : me.pos) : 0;
    var where = me ? '<section class="card mark"><p class="eyebrow">Your bookmark</p><div class="big">' + (me.done ? 'Finished' : me.pos ? esc(cap(C.atLabel(book, me.pos))) : 'Not started') + '</div>' +
      '<p class="of">' + (me.done ? 'All of ' + esc(book.title) : 'of ' + esc(C.units(book, book.total)) + (me.pos && me.alt ? ' · ' + esc(C.altShort(book, me.alt)) + ' in your copy' : '')) + '</p>' +
      '<div class="meter" aria-hidden="true"><i data-w="' + (me.done ? 100 : me.pct) + '"></i></div>' +
      '<div class="actions"><button class="btn" type="button" data-act="progress">Update my page</button>' + (me.done ? '' : '<button class="btn soft" type="button" data-act="plus1">+1 ' + esc(C.unitWord(book, 1)) + '</button><button class="btn ghost" type="button" data-act="finished">I’ve finished</button>') + '</div>' +
      (me.done ? '<div class="myrate"><p class="eyebrow">Your rating</p>' + rateHtml(book.id, book.myRating) + '</div>' : '') + '</section>' : '';
    var nudge = B.nudge ? '<p class="nudge ' + esc(B.nudge.kind) + '" role="status">' + esc(B.nudge.line) + '</p>' : '';
    // The things a reader comes here to do, each one tap away.
    // (Both lines arrive here already escaped by the caller.)
    function task(act, attrs, icon, titleHtml, subHtml) {
      return '<button class="task" type="button" data-act="' + act + '"' + attrs + '>' + ic(icon) + '<span class="t-main"><b>' + titleHtml + '</b><small>' + subHtml + '</small></span>' + ic('chevron') + '</button>';
    }
    var here = v.notes.filter(function (n) { return n.at === pos; }).length;
    var talk = task('chapternow', '', 'chat', pos ? esc(cap(C.atLabel(book, pos))) + ' discussion' : 'Discussion',
      pos ? (here ? esc(plural(here, 'thread')) + ' here · read or reply' : 'No threads here yet · start a thread') + (v.locked.total ? ' · ' + esc(v.locked.total) + ' locked ahead' : '') : 'Set your bookmark to open the threads');
    var meet = v.meetings.filter(function (m) { return !m.past; })[0];
    var meetRow = meet ? '<div class="task-group">' + task('tab', ' data-tab="meet"', 'calendar', 'Next meetup · ' + esc(cap(C.dayLabel(meet.date, today(), LOCALE))) + (meet.time ? ', ' + esc(C.timeLabel(meet.time, LOCALE)) : ''),
      esc(meet.place || (meet.link ? 'Video call' : 'Meeting')) + ' · read to ' + esc(C.atLabel(book, meet.target)) + ' · ' + esc(meet.rsvps.yes.length) + ' going') +
      '<div class="rsvp-line"><span class="eyebrow">RSVP</span><div class="rsvp" role="group" aria-label="RSVP">' + ['yes', 'maybe', 'no'].map(function (a) {
        return '<button type="button" data-act="rsvp" data-id="' + esc(meet.id) + '" data-a="' + a + '" aria-pressed="' + (meet.mine === a ? 'true' : 'false') + '">' + { yes: 'Going', maybe: 'Maybe', no: 'Can’t' }[a] + '</button>';
      }).join('') + '</div></div></div>' :
      (v.host ? task('meetform', '', 'calendar', 'Plan a meetup', 'It becomes the finish line on the board.') : '');
    var vt = v.vote, won = vt.closed ? vt.noms.filter(function (n) { return n.id === vt.closed.winner; })[0] : null;
    var voteRow = task('tab', ' data-tab="next"', 'check', 'Vote for the next book',
      vt.closed ? 'The vote is in' + (won ? ': ' + esc(won.title) : '') : vt.noms.length ? esc(vt.voted) + ' of ' + esc(vt.of) + ' have voted' + (vt.mine.length ? ' · you’ve voted' : '') : 'Nothing nominated yet · add a book');
    var readRow = task('read', '', 'book', 'Read it', 'Free here when a public-domain copy exists');
    var buyRow = task('buy', '', 'bag', 'Buy this book', 'Opens a store’s own page in a new tab');
    var locked = v.locked.total ? task('tab', ' data-tab="notes"', 'lock', esc(C.lockedLine(v.locked, book)), 'They unlock as you read on.') : '';
    var tasks = '<nav class="card tasks" aria-label="In this club">' + talk + meetRow + voteRow + readRow + buyRow + locked + '</nav>';
    var list = B.rows.map(function (r) {
      var alt = !r.done && r.pos && r.alt ? '<small>' + esc(C.altShort(book, r.alt)) + '</small>' : '';
      return '<div class="mrow' + (r.you ? ' you' : '') + '"><span class="av">' + esc(r.emoji) + '</span><div data-u="min-width-0"><span class="nm">' + esc(r.name) + '</span>' + (r.host ? ' <span class="pill t-host">Host</span>' : '') +
        '<span class="ln">' + esc(r.short) + (r.moved && r.pos ? ' · moved ' + esc(r.moved) : '') + '</span><div class="bar"><i data-w="' + r.pct + '"></i></div></div><span class="at">' + (r.done ? '✓ Done' : esc(C.atShort(book, r.pos))) + alt + '</span></div>';
    }).join('');
    // Where's everyone, at a glance (older saved views have none: skip it).
    var G = B.glance, glance = '';
    if (G && B.rows.length > 1) {
      var chips = [[G.finished, '', 'finished'], [G.ahead, '', 'ahead of you'], [G.same, '', 'with you'], [G.behind, '', 'behind you'], [G.notStarted, '', 'not started']]
        .filter(function (c) { return c[0]; }).map(function (c) { return '<span><b>' + esc(c[0]) + '</b> ' + c[2] + '</span>'; }).join('');
      glance = '<div class="glance">' + chips + '</div>' + (G.line ? '<p class="small muted" data-u="margin-6px-0-0">' + esc(G.line) + '</p>' : '');
    }
    var summary = B.finish ? plural(B.ready, 'reader') + ' of ' + B.rows.length + ' ready for ' + C.atShort(book, B.finish.at) : plural(B.finished, 'reader') + ' of ' + B.rows.length + ' finished';
    return '<div class="grid split home">' +
      '<div class="stack">' + party + where + nudge + tasks + '</div>' +
      '<div class="stack"><section class="card"><div class="sec-head"><h2>Who’s where</h2><span class="small muted">' + esc(summary) + '</span></div>' +
      (B.headline ? '<p class="headline">' + esc(B.headline) + '</p>' : '') + glance +
      spineHtml(marks, finish, me ? me.pct : null, 'Start', C.atShort(book, book.total)) + '<div class="readers">' + list + '</div></section>' + inviteMini(v) + '</div></div>';
  }
  /** Read it (free, where a legal copy exists) and buy it (a store's own page). */
  function bookCard() {
    return '<div class="card"><p class="eyebrow">The book</p><div class="row"><button class="btn soft" type="button" data-act="read">Read it</button><button class="btn ghost" type="button" data-act="buy">Buy this book</button></div>' +
      '<p class="small muted">Free to read here when a public-domain copy exists. Otherwise: where to borrow or buy it.</p></div>';
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function inviteMini(v) {
    if (isDemo()) return '<div class="card"><p class="lab">Invite</p><p class="small muted" data-u="margin-0">A real club has a code like <b>' + esc(v.display) + '</b> and a link to drop in the group chat. Friends join with a first name - no account.</p></div>';
    return v.members.length < 3 ? '<div class="card"><p class="lab">Invite the club</p><div class="code-big">' + esc(v.display) + '</div><button class="btn block" type="button" data-act="invite">Share the invite</button></div>' : '';
  }
  function rateHtml(bid, mine) {
    var out = '<span class="rate" role="group" aria-label="Your rating">';
    for (var i = 1; i <= 5; i++) out += '<button type="button" class="' + (mine >= i ? 'on' : '') + '" data-act="rate" data-id="' + esc(bid) + '" data-n="' + i + '" aria-label="' + i + (i === 1 ? ' star' : ' stars') + '" aria-pressed="' + (mine === i ? 'true' : 'false') + '">' + (mine >= i ? '★' : '☆') + '</button>';
    return out + '</span>';
  }

  /* -- notes -- */

  function reactsHtml(n) {
    var open = state.picker === n.id;
    var counts = {};
    n.reactions.forEach(function (x) { counts[x[0]] = x[1]; });
    return C.REACTIONS.filter(function (e) { return open || counts[e] || n.mine === e; }).map(function (e) {
      var c = counts[e] || 0;
      return '<button type="button" data-act="react" data-id="' + esc(n.id) + '" data-e="' + esc(e) + '" aria-pressed="' + (n.mine === e ? 'true' : 'false') + '" aria-label="' + esc(e) + (c ? ', ' + c : '') + '">' + esc(e) + (c ? '<span class="n">' + esc(c) + '</span>' : '') + '</button>';
    }).join('') + (open ? '' : '<button type="button" class="add" data-act="picker" data-id="' + esc(n.id) + '" aria-label="Add a reaction">🙂+</button>');
  }
  /** A note's thread: its replies (sent only with a note this reader can
   *  see) and the box to add one. */
  function threadHtml(n) {
    var rs = n.replies || [];
    var list = rs.map(function (r) {
      return '<div class="rp" data-nt="' + esc(r.id) + '"><div class="hd"><span class="e" aria-hidden="true">' + esc(r.emoji) + '</span><span>' + esc(r.own ? r.name + ' (you)' : r.name) + '</span></div><p class="tx">' + esc(r.text) + '</p>' +
        '<div class="ft"><div class="reacts">' + reactsHtml(r) + '</div>' + (r.canRemove ? '<button class="link-btn" type="button" data-act="delnote" data-id="' + esc(r.id) + '">' + (r.own ? 'Delete' : 'Remove') + '</button>' : '') + '</div></div>';
    }).join('');
    var box = state.replyTo === n.id
      ? '<form class="reply-form" data-re="' + esc(n.id) + '"><label class="field"><span class="vh">Your reply</span><textarea class="input" maxlength="' + C.LIMITS.reply + '" placeholder="Reply - seen by the same readers as the note">' + esc(state.replyText) + '</textarea></label><div class="rerr"></div><div class="row"><button class="btn small" type="submit">Reply</button><button class="btn small ghost" type="button" data-act="replycancel">Cancel</button></div></form>'
      : '<button class="link-btn" type="button" data-act="reply" data-id="' + esc(n.id) + '">' + (rs.length ? 'Reply' : 'Start a thread') + '</button>';
    return '<div class="thread">' + (rs.length ? '<p class="th-count">' + esc(plural(rs.length, 'reply', 'replies')) + '</p>' : '') + list + box + '</div>';
  }
  function noteHtml(n, book, v, grouped) {
    var reacts = reactsHtml(n);
    return '<article class="nt' + (n.kind === 'question' ? ' q' : '') + (state.reveal[n.id] ? ' reveal' : '') + '" data-nt="' + esc(n.id) + '"><div class="hd"><span class="e" aria-hidden="true">' + esc(n.emoji) + '</span><span>' + esc(n.own ? n.name + ' (you)' : n.name) + '</span>' +
      (n.kind === 'question' ? '<span class="pill t-q">Question</span>' : '') + (n.ai ? '<span class="pill t-lock">AI-written - check before the meeting</span>' : '') + (grouped ? '' : '<small>· ' + esc(C.atShort(book, n.at)) + '</small>') + '</div>' +
      '<p class="tx">' + esc(n.text) + '</p><div class="ft"><div class="reacts">' + reacts + '</div>' + (n.canRemove ? '<button class="link-btn" type="button" data-act="delnote" data-id="' + esc(n.id) + '">' + (n.own ? 'Delete' : 'Remove') + '</button>' : '') + '</div>' + threadHtml(n) + '</article>';
  }
  function notesList(list, book, v, empty) {
    if (!list.length) return '<div class="card center muted">' + esc(empty) + '</div>';
    var out = '', last = null;
    list.forEach(function (n) {
      if (n.at !== last) { var inCh = list.filter(function (x) { return x.at === n.at; }); out += '<p class="ch-head">' + esc(cap(C.atLabel(book, n.at))) + ' · ' + esc(plural(inCh.length, 'thread')) + '</p>'; last = n.at; }
      out += noteHtml(n, book, v, true);
    });
    return out;
  }
  function lockedHtml(v) {
    var L = v.locked, book = v.book;
    if (!L.total) return '';
    return '<div class="locked" role="status"><b>' + ic('lock') + '<span>' + esc(C.lockedLine(L, book)) + '</span></b><span class="chips">' + L.chapters.map(function (c) { return '<span>' + esc(C.atShort(book, c[0])) + ' · ' + esc(c[1]) + '</span>'; }).join('') + '</span>' +
      '<span class="small">Only readers who have reached each one can see it - nobody’s text is sent to this phone until you get there.</span><button class="btn small" type="button" data-act="progress" data-u="justify-self-start">I’ve read further</button></div>';
  }
  function viewNotes(v) {
    var book = v.book, pos = myPos(v), cm = state.compose;
    var chs = [];
    v.notes.forEach(function (n) { if (chs.indexOf(n.at) < 0) chs.push(n.at); });
    chs.sort(function (a, b) { return b - a; });
    if (state.chapter !== 'all' && chs.indexOf(state.chapter) < 0) state.chapter = 'all';
    var list = v.notes.filter(function (n) { return (state.filter === 'all' || n.kind === state.filter) && (state.chapter === 'all' || n.at === state.chapter); });
    var jump = chs.length > 1 ? '<label class="field jump"><span class="vh">Jump to a ' + (book.unit === 'ch' ? 'chapter' : 'page') + '</span><select class="input" id="chJump"><option value="all">Every ' + (book.unit === 'ch' ? 'chapter' : 'page') + ' you’ve reached</option>' +
      chs.map(function (c) { var k = v.notes.filter(function (n) { return n.at === c; }).length; return '<option value="' + c + '"' + (state.chapter === c ? ' selected' : '') + '>' + esc(cap(C.atLabel(book, c))) + ' · ' + esc(plural(k, 'thread')) + '</option>'; }).join('') + '</select></label>' : '';
    var max = cm.kind === 'question' ? C.LIMITS.question : C.LIMITS.note;
    var at = cm.at && cm.at <= Math.max(pos, 1) ? cm.at : Math.max(pos, 1);
    var chooser = book.unit === 'ch'
      ? '<select class="input" id="cAt" aria-label="Which chapter it is about">' + Array.from({ length: Math.max(pos, 1) }, function (_, i) { return '<option value="' + (i + 1) + '"' + (i + 1 === at ? ' selected' : '') + '>Chapter ' + (i + 1) + '</option>'; }).reverse().join('') + '</select>'
      : '<input class="input" id="cAt" type="number" min="1" max="' + Math.max(pos, 1) + '" value="' + at + '" inputmode="numeric" aria-label="Which page it is about">';
    var compose = pos ? '<form class="card compose" id="compose"><div class="seg" role="group" aria-label="What kind"><button type="button" data-kind="note" aria-pressed="' + (cm.kind === 'note') + '">Note</button><button type="button" data-kind="question" aria-pressed="' + (cm.kind === 'question') + '">Question</button></div>' +
      '<label class="field"><span class="vh">Your ' + (cm.kind === 'question' ? 'question' : 'note') + '</span><textarea class="input" id="cText" maxlength="' + max + '" placeholder="' + (cm.kind === 'question' ? 'What should the club talk about?' : 'A reaction, a thought - no need to quote the book') + '">' + esc(cm.text) + '</textarea></label>' +
      '<div class="row spread"><label class="field" data-u="flex-1-1-180px"><span class="small">About</span>' + chooser + '</label><span class="count" id="cCount">' + Array.from(cm.text).length + ' / ' + max + '</span></div>' +
      '<p class="small muted" data-u="margin-0">Only readers who have reached ' + esc(C.atLabel(book, at)) + ' will see it.</p><div id="cErr"></div>' +
      '<div class="row"><button class="btn" type="submit">Post</button>' + (cm.kind === 'question' ? '<button class="btn ghost ai" type="button" data-act="ai">Suggest questions</button>' : '') + '</div></form>'
      : '<div class="card"><p data-u="margin-0-0-8px"><b>Set your bookmark first.</b></p><p class="small muted">Notes are tagged with the chapter they’re about. Tell the club where you are, and every note up to there opens.</p><button class="btn" type="button" data-act="progress">Set my bookmark</button></div>';
    var seg = '<div class="seg" role="group" aria-label="Show" data-u="margin-4px-0-2px">' + [['all', 'Everything'], ['note', 'Notes'], ['question', 'Questions']].map(function (x) { return '<button type="button" data-filter="' + x[0] + '" aria-pressed="' + (state.filter === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>';
    return '<div class="grid split"><div class="stack">' + seg + jump + notesList(list, book, v, pos || isDemo() ? 'Nothing here yet - be the first.' : 'Nothing you can see yet. Set your bookmark to open the notes up to where you are.') + '</div>' +
      '<div class="stack first-on-phone">' + lockedHtml(v) + compose + '</div></div>';
  }

  /* -- meetups -- */

  function meetingCard(m, v, big) {
    var book = v.book;
    var when = big ? C.longDay(m.date, LOCALE) : cap(C.dayLabel(m.date, today(), LOCALE)) + (m.time ? ' · ' + C.timeLabel(m.time, LOCALE) : '');
    var tzNote = m.time && v.tz && TZ && v.tz !== TZ ? '<p class="small muted" data-u="margin-0">Club time (' + esc(v.tz.replace(/_/g, ' ')) + '). Adding it to your calendar puts it at the right time where you are.</p>' : '';
    var rs = ['yes', 'maybe', 'no'].map(function (a) {
      var label = { yes: 'Going', maybe: 'Maybe', no: 'Can’t' }[a];
      return '<button type="button" data-act="rsvp" data-id="' + esc(m.id) + '" data-a="' + a + '" aria-pressed="' + (m.mine === a ? 'true' : 'false') + '">' + label + '<small>' + esc(m.rsvps[a].length) + '</small></button>';
    }).join('');
    var who = ['yes', 'maybe', 'no'].filter(function (a) { return m.rsvps[a].length; }).map(function (a) { return '<b>' + { yes: 'Going', maybe: 'Maybe', no: 'Can’t make it' }[a] + ':</b> ' + esc(C.nameList(m.rsvps[a])); }).join(' · ');
    return '<div class="card stack"><div><p class="lab" data-u="margin-0">' + (m.past ? 'Past meetup' : big ? 'Next meetup' : 'Meetup') + '</p><div class="meet-big">' + esc(when) + '</div>' + (big && m.time ? '<div class="meet-time">' + esc(C.timeLabel(m.time, LOCALE)) + '</div>' : '') + '</div>' + tzNote +
      (m.place ? '<div class="meet-line">' + ic('pin') + '<span>' + esc(m.place) + '</span> <a href="' + esc(C.mapLink(m.place)) + '" target="_blank" rel="noopener noreferrer">Map</a></div>' : '') +
      (m.link ? '<div class="meet-line">' + ic('video') + '<a href="' + esc(m.link) + '" target="_blank" rel="noopener noreferrer">Join the call</a></div>' : '') +
      '<div class="meet-line">' + ic('flag') + '<span>Read to <b>' + esc(C.atLabel(book, m.target)) + '</b>' + (m.target >= book.total ? ' (the end)' : '') + '</span></div>' +
      (m.past ? '' : '<p class="eyebrow rsvp-lab">RSVP</p><div class="rsvp" role="group" aria-label="RSVP">' + rs + '</div>') + (who ? '<p class="who-list" data-u="margin-0">' + who + '</p>' : '') + meetingNotesHtml(m, v) +
      '<div class="row">' + (m.past ? '' : '<button class="btn small ghost" type="button" data-act="ics" data-id="' + esc(m.id) + '">Add to calendar</button>') +
      (v.host ? '<button class="btn small ghost" type="button" data-act="meetedit" data-id="' + esc(m.id) + '">Edit</button><button class="link-btn danger" type="button" data-act="meetdel" data-id="' + esc(m.id) + '">Remove</button>' : '') + '</div></div>';
  }
  /** What was discussed and decided at a meeting. Each note is tagged with a
   *  chapter, so this reader is sent only the ones they have reached - the
   *  rest are a count. */
  function meetingNotesHtml(m, v) {
    var book = v.book, notes = m.notes || [], L = m.lockedNotes || { total: 0, chapters: [] };
    var rows = notes.map(function (n) {
      return '<div class="mn' + (n.decision ? ' dec' : '') + '" data-nt="' + esc(n.id) + '">' + (n.decision ? '<span class="pill t-ok">✓ Decided</span>' : '<span class="pill t-host">Discussed</span>') +
        '<p class="tx">' + esc(n.text) + '</p><small>' + esc(n.own ? 'You' : n.name) + ' · ' + esc(C.atShort(book, n.at)) + (n.canRemove ? ' · <button class="link-btn" type="button" data-act="delnote" data-id="' + esc(n.id) + '">' + (n.own ? 'Delete' : 'Remove') + '</button>' : '') + '</small></div>';
    }).join('');
    var locked = L.total ? '<p class="mn-lock">' + ic('lock') + '<span>' + esc(plural(L.total, 'meeting note')) + ' waiting past ' + esc(myPos(v) ? C.atLabel(book, myPos(v)) : 'the start') + '</span><span class="chips">' + L.chapters.map(function (c) { return '<span>' + esc(C.atShort(book, c[0])) + ' · ' + esc(c[1]) + '</span>'; }).join('') + '</span></p>' : '';
    return '<div class="mnotes"><p class="lab" data-u="margin-0">Meeting notes</p>' + (rows || locked ? rows + locked : '<p class="small muted" data-u="margin-0">' + (m.past ? 'Nothing written down yet.' : 'What you talk about and decide goes here - during the meeting or after.') + '</p>') +
      '<button class="btn small soft" type="button" data-act="mnote" data-id="' + esc(m.id) + '" data-u="justify-self-start">Add a meeting note</button></div>';
  }
  function openMeetingNote(id) {
    var v = V(), book = v.book, pos = myPos(v);
    var m = v.meetings.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    if (!pos) { sheet('<h2>Add a meeting note</h2><p>Set your bookmark first - a meeting note is tagged with a chapter you have read, so it stays hidden from anyone who hasn’t got there.</p><button class="btn" type="button" data-act="progress">Set my bookmark</button>'); return; }
    var def = Math.min(pos, m.target || pos);
    var chooser = book.unit === 'ch'
      ? '<select class="input" name="at">' + Array.from({ length: pos }, function (_, i) { return '<option value="' + (i + 1) + '"' + (i + 1 === def ? ' selected' : '') + '>Chapter ' + (i + 1) + '</option>'; }).reverse().join('') + '</select>'
      : '<input class="input" name="at" type="number" min="1" max="' + pos + '" value="' + def + '" inputmode="numeric">';
    sheet('<h2>Add a meeting note</h2><p class="small muted">' + esc(cap(C.dayLabel(m.date, today(), LOCALE))) + ' - what the club talked about, or something you decided.</p>' +
      '<form id="mnForm" class="fields"><label class="field"><span>The note</span><textarea class="input" name="text" maxlength="' + C.LIMITS.note + '" placeholder="We argued about the letter. Next time: read to chapter 30."></textarea></label>' +
      '<label class="check"><input type="checkbox" name="decision"> ✓ This is a decision</label>' +
      '<label class="field"><span>It gives away the book up to</span>' + chooser + '</label>' +
      '<p class="small muted" data-u="margin-0">Only readers who have reached that ' + (book.unit === 'ch' ? 'chapter' : 'page') + ' will see it - like any note. For plans that spoil nothing, pick an early one.</p>' +
      '<div id="mnErr"></div><button class="btn big block" type="submit">Add it</button></form>',
    function (root) {
      var f = $('#mnForm', root);
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var btn = $('button[type=submit]', f); btn.disabled = true;
        postNote({ meet: id, text: f.text.value, at: Number(f.at.value), decision: f.decision.checked })
          .then(function () { closeSheet(true); draw(); toast('Added to the meeting.'); }).catch(function (e) { btn.disabled = false; showError(e, $('#mnErr', root)); });
      });
    });
  }
  function viewMeet(v) {
    var up = v.meetings.filter(function (m) { return !m.past; }), past = v.meetings.filter(function (m) { return m.past; });
    var target = up[0] ? up[0].target : v.book.total;
    var qs = v.notes.filter(function (n) { return n.kind === 'question' && n.at <= target; });
    var left = up.length ? meetingCard(up[0], v, true) + up.slice(1).map(function (m) { return meetingCard(m, v, false); }).join('') :
      '<div class="card center"><div data-u="font-size-2rem">📅</div><h2>No meeting planned</h2><p class="muted">' + (v.host ? 'Pick a day, a place or a call link, and how far to read. It becomes the finish line on the board.' : 'The host plans meetings. When one is set, it shows here and on the board.') + '</p></div>';
    return '<div class="grid split"><div class="stack">' + (v.host ? '<button class="btn" type="button" data-act="meetform" data-u="justify-self-start">Plan a meeting</button>' : '') + left +
      (past.length ? '<details class="more"><summary>Past meetings (' + past.length + ')</summary><div class="stack">' + past.map(function (m) { return meetingCard(m, v, false); }).join('') + '</div></details>' : '') + '</div>' +
      '<div class="stack"><div class="card"><div class="sec-head"><h2>Questions for the meeting</h2><button class="btn small ghost ai" type="button" data-act="ai">Suggest</button></div>' +
      (qs.length ? qs.map(function (n) { return '<div class="aiq"><p>' + esc(n.text) + '<br><small>' + esc(n.name) + ' · ' + esc(C.atShort(v.book, n.at)) + (n.ai ? ' · AI-written' : '') + '</small></p></div>'; }).join('') : '<p class="muted small" data-u="margin-0">None yet that you can see. Add one from Notes - pick “Question”.</p>') +
      '<button class="btn small soft" type="button" data-act="askq" data-u="margin-top-10px">Add a question</button></div></div></div>';
  }

  /* -- what's next -- */

  function viewNext(v) {
    var vt = v.vote;
    var head;
    if (vt.closed) {
      var w = vt.noms.filter(function (n) { return n.id === vt.closed.winner; })[0];
      var max = Math.max.apply(null, vt.noms.map(function (n) { return n.votes || 0; }).concat([1]));
      head = '<div class="winner"><p class="eyebrow">The vote is in</p><h2>' + esc(w ? w.title : 'The winner') + '</h2><p data-u="margin-0-0-12px">' + esc(vt.closed.line) + '</p>' +
        (v.host ? '<div class="row"><button class="btn" type="button" data-act="startnext">Start ' + esc(w ? w.title : 'it') + '</button><button class="btn soft" type="button" data-act="reopen">Re-open the vote</button></div>' : '<p class="small" data-u="margin-0">The host starts the next book when the club is ready.</p>') + '</div>' +
        '<div class="card">' + vt.noms.slice().sort(function (a, b) { return (b.votes || 0) - (a.votes || 0); }).map(function (n) {
          return '<div data-u="padding-8px-0"><div class="row spread"><b>' + esc(n.title) + '</b><span class="num">' + esc(plural(n.votes || 0, 'vote')) + '</span></div><div class="vbar"><i data-w="' + Math.round(((n.votes || 0) / max) * 100) + '"></i></div></div>';
        }).join('') + '</div>';
      return '<div class="grid split"><div class="stack">' + head + '</div><div class="stack">' + nextSide(v) + '</div></div>';
    }
    var noms = vt.noms.length ? vt.noms.map(function (n) {
      var on = vt.mine.indexOf(n.id) >= 0;
      return '<div class="nom"><div data-u="min-width-0"><span class="t">' + esc(n.title) + '</span><span class="s">' + (n.author ? 'by ' + esc(n.author) + ' · ' : '') + 'nominated by ' + esc(n.mine ? 'you' : n.by) + (n.chapters ? ' · ' + esc(n.chapters) + ' chapters' : '') + '</span>' + (n.why ? '<span class="why">“' + esc(n.why) + '”</span>' : '') +
        (n.mine ? '<button class="link-btn small" type="button" data-act="unnom" data-id="' + esc(n.id) + '">Take it off</button>' : v.host ? '<button class="link-btn small" type="button" data-act="unnom" data-id="' + esc(n.id) + '">Remove</button>' : '') + '</div>' +
        '<button class="approve" type="button" data-act="approve" data-id="' + esc(n.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + (on ? '✓ I’d read it' : 'I’d read it') + '</button></div>';
    }).join('') : '<p class="muted" data-u="margin-0">Nothing nominated yet. What should the club read next?</p>';
    head = '<div class="card"><div class="sec-head"><h2>Vote for the next book</h2><span class="small muted">' + esc(vt.voted) + ' of ' + esc(vt.of) + ' have voted</span></div>' +
      '<p class="small muted">Tap every book you’d happily read. The most taps wins; a tie goes to the book nominated first. Counts stay hidden until the host closes the vote, so nobody follows the crowd.</p>' + noms +
      (v.host && vt.noms.length ? '<button class="btn block" type="button" data-act="closevote" data-u="margin-top-12px"' + (vt.voted ? '' : ' disabled') + '>Close the vote and see the winner</button>' : '') + '</div>';
    return '<div class="grid split"><div class="stack">' + head + nominateForm(v) + '</div><div class="stack">' + nextSide(v) + '</div></div>';
  }
  function nominateForm(v) {
    var mine = v.vote.noms.filter(function (n) { return n.mine; }).length;
    if (mine >= C.LIMITS.nomsPerMember) return '<div class="card"><p class="small muted" data-u="margin-0">You’ve nominated ' + C.LIMITS.nomsPerMember + '. Take one off to add another.</p></div>';
    if (v.vote.noms.length >= C.LIMITS.noms) return '';
    return '<button class="btn soft block" type="button" data-act="nominate">Nominate a book</button>';
  }
  function openNominate() {
    sheet('<h2>Nominate a book</h2><p class="small muted">Everyone taps every book they’d happily read. You can put up ' + C.LIMITS.nomsPerMember + '.</p><form class="fields" id="nomForm" autocomplete="off">' +
      '<label class="field"><span>Title</span><input class="input" name="title" maxlength="100" required></label>' +
      '<label class="field"><span>Author</span><input class="input" name="author" maxlength="60"></label>' +
      '<label class="field"><span>Why this one? <small class="hint">(one line)</small></span><input class="input" name="why" maxlength="120"></label>' +
      '<label class="field"><span>Chapters <small class="hint">(if you know)</small></span><input class="input" name="chapters" inputmode="numeric" maxlength="3"></label>' +
      '<div id="nomErr"></div><button class="btn big block" type="submit">Add to the vote</button></form>',
    function (root) {
      var nf = $('#nomForm', root);
      nf.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var btn = $('button[type=submit]', nf); btn.disabled = true;
        var body = { title: nf.title.value, author: nf.author.value, why: nf.why.value, chapters: nf.chapters.value.trim() ? Number(nf.chapters.value) : null };
        write('POST', '/noms', body, function (club, you) { return C.nominate(club, you, body, C.newId('n', rand), now()); })
          .then(function () { closeSheet(true); draw(); toast('Added to the vote.'); }).catch(function (e) { btn.disabled = false; showError(e, $('#nomErr', root)); });
      });
    });
  }
  function nextSide(v) {
    return v.host ? '<div class="card"><p class="lab">Host</p><p class="small muted">Skipping the vote? Start any book - this one goes to the shelf with its ratings.</p><button class="btn small ghost" type="button" data-act="startother">Start a different book</button></div>' : '';
  }

  /* -- the shelf -- */

  function viewShelf(v) {
    var book = v.book, me = myRow(v);
    var cur = '<div class="card"><p class="lab">Reading now</p><div class="book"><span class="spineart" aria-hidden="true">' + esc(Array.from(book.title)[0] || '?') + '</span><div data-u="min-width-0"><div class="t">' + esc(book.title) + '</div><div class="s">' + (book.author ? 'by ' + esc(book.author) + ' · ' : '') + esc(plural(v.board.finished, 'reader')) + ' finished</div>' +
      (book.avg ? '<div>' + stars(book.avg) + ' <span class="avg">' + esc(book.avg.toFixed(1)) + '★</span> <span class="small muted">' + esc(plural(book.rated, 'rating')) + ' so far</span></div>' : '') +
      (me && me.done ? '<div><span class="small muted">Your rating</span> ' + rateHtml(book.id, book.myRating) + '</div>' : '<p class="small muted" data-u="margin-4px-0-0">Rate it when you finish.</p>') + '</div></div></div>';
    var past = v.shelf.length ? '<div class="card"><h2>The shelf</h2>' + v.shelf.map(function (s) {
      return '<div class="book"><span class="spineart" aria-hidden="true">' + esc(Array.from(s.title)[0] || '?') + '</span><div data-u="min-width-0"><div class="t">' + esc(s.title) + '</div><div class="s">' + (s.author ? 'by ' + esc(s.author) + ' · ' : '') + (s.finished ? 'finished ' + esc(C.shortDay(s.finished, LOCALE)) : '') + '</div>' +
        '<div>' + (s.avg ? stars(s.avg) + ' <span class="avg">' + esc(s.avg.toFixed(1)) + '★ avg</span> <span class="small muted">from ' + esc(plural(s.rated, 'rating')) + '</span>' : '<span class="small muted">No ratings yet</span>') + '</div>' +
        (s.ratings.length ? '<div class="ratings">' + s.ratings.map(function (r) { return '<span>' + esc(r.emoji) + ' ' + esc(r.you ? 'You' : r.name) + ' ' + esc(r.stars) + '★</span>'; }).join('') + '</div>' : '') +
        '<div><span class="small muted">Your rating</span> ' + rateHtml(s.id, s.myRating) + '</div>' +
        '<div class="row"><button class="btn small ghost" type="button" data-act="shelfnotes" data-id="' + esc(s.id) + '">Notes</button><button class="btn small ghost" type="button" data-act="card" data-id="' + esc(s.id) + '">Share card</button></div></div></div>';
    }).join('') + '</div>' : '<div class="card center"><div data-u="font-size-2rem">📚</div><h2>The shelf is empty - for now</h2><p class="muted">When the club moves on to the next book, this one lands here with everyone’s stars and the club average.</p></div>';
    return '<div class="grid split"><div class="stack">' + past + '</div><div class="stack first-on-phone">' + cur + bookCard() + cardBox() + '</div></div>';
  }
  function cardBox() {
    var K = state.card;
    if (!K.url) return '';
    return '<div class="card"><p class="lab">Share card</p><img class="share-img" src="' + esc(K.url) + '" alt="The share card"><div class="row" data-u="margin-top-10px-justify-content-center"><button class="btn" type="button" data-act="cardshare">' + (canShareFiles() ? 'Share it' : 'Download it') + '</button></div><p class="small muted center" data-u="margin-6px-0-0">Drawn on this phone. Never uploaded.</p></div>';
  }

  /* ---------------- binding the club views ---------------- */

  function bindClub() {
    var cf = $('#compose');
    if (cf) {
      var t = $('#cText', cf), at = $('#cAt', cf);
      t.addEventListener('input', function () { state.compose.text = t.value; var max = state.compose.kind === 'question' ? C.LIMITS.question : C.LIMITS.note; $('#cCount').textContent = Array.from(t.value).length + ' / ' + max; });
      at.addEventListener('change', function () { state.compose.at = Number(at.value) || null; draw(); });
      $$('[data-kind]', cf).forEach(function (b) { b.addEventListener('click', function () { state.compose.kind = b.getAttribute('data-kind'); state.compose.text = t.value; draw(); var x = $('#cText'); if (x) x.focus(); }); });
      cf.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var btn = $('button[type=submit]', cf); btn.disabled = true;
        var body = { kind: state.compose.kind, text: t.value, at: Number(at.value) };
        postNote(body).then(function () { state.compose.text = ''; draw(); toast(body.kind === 'question' ? 'Question added.' : 'Posted.'); })
          .catch(function (e) { btn.disabled = false; showError(e, $('#cErr')); });
      });
    }
    $$('[data-filter]').forEach(function (b) { b.addEventListener('click', function () { state.filter = b.getAttribute('data-filter'); draw(); }); });
    var jump = $('#chJump');
    if (jump) jump.addEventListener('change', function () { state.chapter = jump.value === 'all' ? 'all' : Number(jump.value); draw(); });
    $$('.reply-form').forEach(function (rf) {
      var ta = $('textarea', rf);
      ta.addEventListener('input', function () { state.replyText = ta.value; });
      rf.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var btn = $('button[type=submit]', rf); btn.disabled = true;
        postNote({ re: rf.getAttribute('data-re'), text: ta.value }).then(function () { state.replyTo = ''; state.replyText = ''; draw(); toast('Replied.'); })
          .catch(function (e) { btn.disabled = false; showError(e, $('.rerr', rf)); });
      });
    });
  }
  function postNote(body) {
    if (isDemo()) {
      try {
        var o = { now: now() };
        if (body.re) o.parent = state.demo.notes.filter(function (x) { return x.id === body.re; })[0] || { re: 'gone' };
        if (body.meet) { var dm = state.demo.club.meetings[body.meet]; if (!dm) throw C.fail(404, 'That meeting isn’t planned any more.'); o.meeting = { id: body.meet, date: dm.date }; }
        var n = C.newNote(state.demo.club, state.demo.you, body, o);
        n.id = C.newId('n', rand, 15);
        state.demo.notes.push(n);
        return Promise.resolve();
      } catch (e) { return Promise.reject(e); }
    }
    return api('POST', 'api/c/' + encodeURIComponent(state.clubId) + '/notes', body).then(function (d) { setClub(d.club); state.seen = (state.seen || []).concat([d.id]); });
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    stopScan();
    if (s.hidden) lastFocus = document.activeElement;
    s.classList.remove('tall');
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false; document.body.classList.add('sheet-open'); s.scrollTop = 0;
    // The shared "confirm your email" banner sits above everything at the top
    // of the page; keep the sheet (and its Close button) clear of it.
    var vb = document.getElementById('stc-verify-banner'), off = vb ? Math.max(0, vb.getBoundingClientRect().bottom) : 0;
    s.style.maxHeight = off ? 'calc(100vh - ' + Math.round((matchMedia('(min-width: 900px)').matches ? 2 : 1) * (off + 8)) + 'px)' : '';
    if (onOpen) onOpen(s);
    dyn(s);
    var f = s.querySelector('h2'); if (f) f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f && !s.contains(document.activeElement)) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    stopScan();
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = ''; $('#sheet').classList.remove('tall');
    document.body.classList.remove('sheet-open');
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  /* -- where am I -- */

  function openProgress() {
    var v = V(), book = v.book, me = myRow(v);
    var val = me ? (me.done ? book.total : me.pos) : 0;
    function unlocks(p) { return v.locked.chapters.reduce(function (n, c) { return n + (c[0] <= p ? c[1] : 0); }, 0); }
    sheet('<h2>Where are you in ' + esc(book.title) + '?</h2><p class="small muted">Say the last ' + (book.unit === 'ch' ? 'chapter' : 'page') + ' you’ve finished. Notes up to there open; nothing past it.</p>' +
      '<div class="stepper"><button type="button" id="pMinus" aria-label="One less">−</button><output id="pOut" aria-live="polite">' + val + '</output><button type="button" id="pPlus" aria-label="One more">+</button></div>' +
      '<p class="center muted" id="pWord" data-u="margin-4px-0-0"></p><input class="slide" type="range" id="pSlide" min="0" max="' + book.total + '" value="' + val + '" aria-label="Your place in the book">' +
      '<p class="center" id="pUnlock" data-u="font-weight-800-min-height-1-5em-margin-6px-0"></p>' +
      '<label class="field"><span>' + (book.unit === 'ch' ? 'Page in your copy' : 'Chapter') + ' <small class="hint">(optional - shown beside your bookmark)</small></span><input class="input" id="pAlt" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="' + esc(me && me.alt ? me.alt : '') + '"></label>' +
      '<p class="small muted" data-u="margin-6px-0-0">' + (book.unit === 'ch' ? 'Notes unlock by chapter, because pages differ between editions. The page is only for the board.' : 'Notes unlock by page. The chapter is only for the board.') + '</p><div id="pErr"></div>' +
      '<div class="row"><button class="btn big" type="button" id="pSave" data-u="flex-1-1-160px">Save</button><button class="btn big ghost" type="button" id="pDone" data-u="flex-1-1-160px">I’ve finished</button></div>',
    function (root) {
      var cur = val;
      function show() {
        $('#pOut', root).textContent = String(cur);
        $('#pSlide', root).value = String(cur);
        $('#pWord', root).textContent = cur === 0 ? 'Not started' : cur >= book.total ? 'The end - finished' : C.atLabel(book, cur) + ' of ' + book.total;
        var u = unlocks(cur);
        $('#pUnlock', root).textContent = u ? '🔓 Saving unlocks ' + plural(u, 'note') : '';
      }
      show();
      $('#pMinus', root).addEventListener('click', function () { cur = Math.max(0, cur - 1); show(); });
      $('#pPlus', root).addEventListener('click', function () { cur = Math.min(book.total, cur + 1); show(); });
      $('#pSlide', root).addEventListener('input', function () { cur = Number($('#pSlide', root).value) || 0; show(); });
      $('#pSave', root).addEventListener('click', function () { var a = $('#pAlt', root).value.trim(); saveProgress({ pos: cur, alt: a ? Number(a) : null }, $('#pErr', root)); });
      $('#pDone', root).addEventListener('click', function () { saveProgress({ done: true }, $('#pErr', root)); });
    });
  }
  function saveProgress(body, box, keepSheet) {
    var before = V();
    return write('PUT', '/progress', body, function (club, you) { return C.setProgress(club, you, body, now()); }).then(function (d) {
      if (!keepSheet) closeSheet(true);
      var after = d.club;
      noticeUnlocks(before, after, true);
      var me = myRow(after);
      if (me && me.done && !(myRow(before) || {}).done) toast('Finished! 🎉 Rate it on the board, then see what’s next.', 4200);
      if (keepSheet) { var rb = $('#rdBm'); if (rb) rb.textContent = bookmarkWord(after); softDraw(); return; }
      draw();
    }).catch(function (e) { if (box) showError(e, box); else showError(e); });
  }

  /* -- the club sheet: invite, members, this phone, account -- */

  function joinLink(v) { return location.origin + BASE + '#join=' + v.code; }
  function openClubSheet(fresh) {
    var v = V();
    var me = myRow(v) || {};
    var members = v.members.map(function (m) {
      var acts = v.host && !m.you && !isDemo() ? '<span class="acts"><button class="btn small ghost" type="button" data-act="makehost" data-id="' + esc(m.id) + '">Make host</button><button class="btn small ghost danger" type="button" data-act="kick" data-id="' + esc(m.id) + '">Remove</button></span>' : '';
      return '<div class="lrow"><span>' + esc(m.emoji) + ' <b>' + esc(m.name) + '</b>' + (m.you ? ' <span class="small muted">(you)</span>' : '') + (m.host ? ' <span class="pill t-host">Host</span>' : '') + '</span>' + acts + '</div>';
    }).join('');
    var acct = '';
    if (!isDemo() && v.account) {
      acct = '<div class="sheet-sec"><p class="lab">Your other devices</p>' + (!signedIn()
        ? '<p class="small muted">Optional: sign in (free) and keep this club on your account, so it opens on your laptop or a new phone too. The club stores a code made from your account - never your email.</p><button class="btn small ghost" type="button" data-act="signin">Sign in</button>'
        : v.kept ? '<p class="small">✓ Kept on your account - it opens wherever you’re signed in.</p><button class="btn small ghost" type="button" data-act="unkeep">Stop keeping it</button>'
          : '<p class="small muted">Keep this club on your account so it opens wherever you’re signed in. Only the club and your seat are stored with it - never your email in the club.</p><button class="btn small" type="button" data-act="keep">Keep on my account</button>') + '</div>';
    }
    sheet('<h2>' + esc(v.name) + '</h2>' + (fresh ? '<p class="ok-line" data-u="margin-0-0-8px"><span class="pill t-ok">Your club is ready</span> Share the code - friends join with a first name, no account.</p>' : '') +
      '<p class="lab" data-u="margin-top-8px">Invite</p><div class="code-big" aria-label="Join code ' + esc(v.display.split('').join(' ')) + '">' + esc(v.display) + '</div>' +
      '<div class="row" data-u="justify-content-center"><button class="btn" type="button" data-act="invite">Share the invite</button><button class="btn ghost" type="button" data-act="copyjoin">Copy link</button><button class="btn ghost" type="button" data-act="qr">QR code</button></div><div id="qrSlot"></div>' +
      (v.host && !isDemo() ? '<p class="small muted center" data-u="margin-6px-0-0">Code shared too widely? <button class="link-btn" type="button" data-act="newcode">Make a new code</button></p>' : '') +
      '<div class="sheet-sec"><p class="lab">Readers (' + v.members.length + ' of ' + C.LIMITS.members + ')</p>' + members + '</div>' +
      '<div class="sheet-sec"><p class="lab">You</p><form id="meForm" class="fields"><label class="field"><span>Your name in this club</span><input class="input" name="name" maxlength="24" value="' + esc(me.name || '') + '"></label>' + emojiPicker(me.emoji) + '<div id="meErr"></div><button class="btn small" type="submit" data-u="justify-self-start">Save</button></form></div>' +
      (isDemo() ? '' : '<div class="sheet-sec"><p class="lab">This phone</p><p class="small muted">Got a new phone? Make a one-time link and open it there. It works once, for ' + C.LIMITS.moveMinutes + ' minutes, and this phone stops opening the club when the new one takes your seat.</p><button class="btn small ghost" type="button" data-act="move">Move to another phone</button><div id="moveSlot"></div></div>') +
      acct +
      (v.host ? '<div class="sheet-sec"><p class="lab">Host</p><div class="row"><button class="btn small ghost" type="button" data-act="editbook">Edit the book</button>' + (isDemo() ? '' : '<button class="btn small ghost danger" type="button" data-act="delclub">Delete the club</button>') + '</div><p class="small muted" data-u="margin-8px-0-0">Hand hosting to someone with “Make host” next to their name.</p></div>' : '') +
      (isDemo() ? '' : '<div class="sheet-sec"><button class="btn small ghost danger" type="button" data-act="leave">Leave club</button><p class="small muted" data-u="margin-6px-0-0">Leaving removes your notes, questions, bookmark, votes, RSVPs, reactions and ratings.</p></div>'),
    function (root) {
      var emo = me.emoji;
      bindEmoji($('#meForm', root), function (e) { emo = e; });
      $('#meForm', root).addEventListener('submit', function (ev) {
        ev.preventDefault();
        var body = { name: ev.target.name.value, emoji: emo };
        write('PATCH', '/me', body, function (club, you) { return C.rename(club, you, body); }).then(function () { draw(); toast('Saved.'); }).catch(function (e) { showError(e, $('#meErr', root)); });
      });
    });
  }
  function openQr(slot, link, label) {
    if (!QR) return;
    slot.innerHTML = '<div class="qrbox">' + QR.svg(link, label) + '</div>';
  }

  /* -- meetings -- */

  function openMeetingForm(id) {
    var v = V(), book = v.book;
    var m = id ? v.meetings.filter(function (x) { return x.id === id; })[0] : null;
    var t = today();
    sheet('<h2>' + (m ? 'Edit the meeting' : 'Plan a meeting') + '</h2><form id="meetForm" class="fields" autocomplete="off">' +
      '<div class="fields two"><label class="field"><span>Day</span><input class="input" type="date" name="date" min="' + t + '" required value="' + esc(m ? m.date : '') + '"></label>' +
      '<label class="field"><span>Time</span><input class="input" type="time" name="time" value="' + esc(m ? m.time : '19:00') + '"></label></div>' +
      '<label class="field"><span>Where <small class="hint">(optional)</small></span><input class="input" name="place" maxlength="80" value="' + esc(m ? m.place : '') + '" placeholder="Sam’s kitchen, the library, a café"></label>' +
      '<label class="field"><span>Video call link <small class="hint">(optional, https)</small></span><input class="input" name="link" type="url" maxlength="300" value="' + esc(m ? m.link : '') + '" placeholder="https://"></label>' +
      '<label class="field"><span>Read to ' + (book.unit === 'ch' ? 'chapter' : 'page') + ' <small class="hint">(empty = the whole book)</small></span><input class="input" name="upTo" inputmode="numeric" maxlength="4" value="' + esc(m && m.upTo ? m.upTo : '') + '"></label>' +
      '<div id="mErr"></div><button class="btn big block" type="submit">' + (m ? 'Save' : 'Plan it') + '</button></form>',
    function (root) {
      $('#meetForm', root).addEventListener('submit', function (ev) {
        ev.preventDefault();
        var f = ev.target;
        var body = { date: f.date.value, time: f.time.value, place: f.place.value, link: f.link.value.trim(), upTo: f.upTo.value.trim() ? Number(f.upTo.value) : null };
        var p = m ? write('PATCH', '/meetings/' + encodeURIComponent(m.id), body, function (club) { return C.editMeeting(club, m.id, body, today()); })
          : write('POST', '/meetings', body, function (club, you) { return C.addMeeting(club, you, body, C.newId('t', rand), { now: now(), today: today() }); });
        p.then(function () { closeSheet(true); draw(); toast(m ? 'Saved.' : 'Planned - it’s the finish line on the board now.', 3600); }).catch(function (e) { showError(e, $('#mErr', root)); });
      });
    });
  }
  function icsFor(id) {
    var v = V();
    var m = v.meetings.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    var club = { id: v.id, name: v.name, tz: v.tz, book: { title: v.book.title, author: v.book.author, chapters: v.book.chapters, pages: v.book.pages } };
    download('chapter-' + slug(v.book.title) + '-' + m.date + '.ics', 'text/calendar', C.meetingIcs(club, m, { nowMs: now(), viewerTz: TZ }));
    toast('Open the file to add it to your calendar.', 3600);
  }

  /* -- the next book -- */

  function bookFields(b) {
    b = b || {};
    return '<label class="field"><span>Title</span><input class="input" name="title" maxlength="100" required value="' + esc(b.title || '') + '"></label>' +
      '<label class="field"><span>Author</span><input class="input" name="author" maxlength="60" value="' + esc(b.author || '') + '"></label>' +
      '<div class="fields two"><label class="field"><span>Chapters</span><input class="input" name="chapters" inputmode="numeric" maxlength="3" value="' + esc(b.chapters || '') + '"></label>' +
      '<label class="field"><span>Pages <small class="hint">(only if no chapters)</small></span><input class="input" name="pages" inputmode="numeric" maxlength="4" value="' + esc(b.pages || '') + '"></label></div>' +
      '<label class="field"><span>ISBN <small class="hint">(optional - makes “Buy this book” open the exact edition)</small></span><input class="input" name="isbn" maxlength="24" spellcheck="false" value="' + esc(b.isbn || '') + '"></label>';
  }
  function readBook(f) { return { title: f.title.value, author: f.author.value, chapters: f.chapters.value.trim() ? Number(f.chapters.value) : null, pages: f.pages.value.trim() ? Number(f.pages.value) : null, isbn: f.isbn.value.trim() }; }

  /* -- reading and buying: a legal copy to read here, or links out -- */

  function bookmarkWord(v) { var me = myRow(v), book = v.book; return !me ? '' : me.done ? 'Finished' : me.pos ? cap(C.atLabel(book, me.pos)) : 'Not started'; }
  function outLinks(list) {
    return list.map(function (l) {
      return '<a class="crow out" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer"><span class="tile" aria-hidden="true">' + ic(/^(library|gutenberg|standard|openlibrary)$/.test(l.id) ? 'book' : 'bag') + '</span><span><b>' + esc(l.name) + '</b><small>' + esc(l.note) + '</small></span><span aria-hidden="true">↗</span></a>';
    }).join('');
  }
  function openBuy() {
    var v = V(), book = v.book;
    var stores = (v.stores && v.stores.length ? v.stores : C.buyLinks(book, null)).filter(function (l) { return /^https:\/\//.test(l.url); });
    var paid = stores.some(function (l) { return l.affiliate; });
    sheet('<h2>Buy ' + esc(book.title) + '</h2><p class="small muted">Each one opens the store’s own page in a new tab. Nothing is bought, paid for or tracked inside Chapter.</p>' + outLinks(stores) +
      (paid ? '<p class="small muted" data-u="margin-top-12px">Some of these are affiliate links: if you buy, the store may pay Chapter a small commission, at no cost to you.</p>' : '') +
      (book.isbn ? '' : '<p class="small muted" data-u="margin-top-12px">These search by title and author' + (v.host ? ' - add the ISBN under Club → Edit the book to open the exact edition.' : '.') + '</p>'));
  }
  function openRead() {
    var v = V(), book = v.book;
    sheet('<h2>Read ' + esc(book.title) + '</h2><div id="rdSlot"><p class="muted">Looking for a copy you can read for free…</p></div>' +
      '<div class="sheet-sec"><p class="lab">Other places to find it</p>' + outLinks(C.readLinks(book)) +
      '<div class="row" data-u="margin-top-12px"><button class="btn small ghost" type="button" data-act="buy">Buy this book</button></div>' +
      '<p class="small muted" data-u="margin-top-10px">Chapter never copies a book’s text. It only opens a copy where reading it is legal - or points you to one.</p></div>',
    function (root) {
      var id = state.clubId;
      (isDemo() ? Promise.resolve({ read: DEMO_READ }) : api('GET', 'api/c/' + encodeURIComponent(id) + '/read')).then(function (d) {
        var slot = $('#rdSlot', root);
        if (!slot || (!isDemo() && state.clubId !== id)) return;
        var r = C.cleanRead(d.read);
        var what = '“' + esc(r.title || book.title) + '”' + (r.author ? ' by ' + esc(r.author) : '') + (r.year ? ' (' + esc(r.year) + ' edition)' : '');
        if (r.kind === 'read') {
          state.reading = r;
          slot.innerHTML = '<div class="note"><p data-u="margin-0-0-6px"><span class="pill t-ok">Free to read</span></p><p data-u="margin-0-0-10px">' + what + ' - a scan anyone may read in full at the Internet Archive.</p>' +
            '<div class="row"><button class="btn" type="button" data-act="readhere">Open the reader here</button><a class="btn ghost" href="' + esc(C.readerPage(r.ia)) + '" target="_blank" rel="noopener noreferrer">Open in a new tab ↗</a></div>' +
            '<p class="small muted" data-u="margin-10px-0-0">The reader loads from archive.org when you tap, straight to this phone. It may be a different edition from yours, so go by chapter, not page.</p></div>';
        } else if (r.kind === 'borrow') {
          slot.innerHTML = '<div class="note"><p data-u="margin-0-0-6px"><span class="pill t-q">Free to borrow</span></p><p data-u="margin-0-0-10px">' + what + ' can be borrowed from Open Library with a free Internet Archive account. It’s under copyright, so it can’t be opened here.</p>' +
            '<a class="btn" href="' + esc(C.workUrl(r.work)) + '" target="_blank" rel="noopener noreferrer">Borrow at Open Library ↗</a></div>';
        } else {
          slot.innerHTML = '<div class="note"><p data-u="margin-0">' + (r.reason === 'unavailable' ? 'The lookup isn’t answering right now.' : 'No free copy to read was found - most books still under copyright have none.') + ' Try the places below, a library, or buy it.</p></div>';
        }
      }).catch(function (e) { var slot = $('#rdSlot', root); if (slot) showError(e, slot); });
    });
  }
  /** The Internet Archive's own reader, in a frame, after a tap. The book
   *  goes from the Archive to this phone; nothing of it passes through
   *  Chapter. */
  function openReader() {
    var v = V(), r = state.reading, src = r ? C.readerUrl(r.ia) : '';
    if (!src) return;
    var me = myRow(v);
    sheet('<h2>' + esc(v.book.title) + '</h2><div class="reader-bar"><span class="small">Your bookmark: <b id="rdBm">' + esc(bookmarkWord(v)) + '</b></span>' +
      (me && !me.done ? '<button class="btn small soft" type="button" data-act="readplus">+1 ' + esc(C.unitWord(v.book, 1)) + '</button>' : '') +
      '<a class="btn small ghost" href="' + esc(C.readerPage(r.ia)) + '" target="_blank" rel="noopener noreferrer">New tab ↗</a></div>' +
      '<iframe class="reader-frame" src="' + esc(src) + '" title="' + esc(v.book.title) + ' - the Internet Archive’s reader" referrerpolicy="no-referrer" allowfullscreen sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>' +
      '<p class="small muted" data-u="margin-8px-0-0">Shown by the Internet Archive (archive.org). Tap +1 as you finish each ' + esc(C.unitWord(v.book, 1)) + ' and the club’s notes open as you go.</p>');
    $('#sheet').classList.add('tall');
  }
  function openStartNext(other) {
    var v = V();
    var w = !other && v.vote.closed ? v.vote.noms.filter(function (n) { return n.id === v.vote.closed.winner; })[0] : null;
    sheet('<h2>' + (w ? 'Start ' + esc(w.title) : 'Start a different book') + '</h2><p class="small muted">' + esc(v.book.title) + ' goes to the shelf with its ratings, and everyone’s bookmark goes back to the start. Notes on it stay readable from the shelf, by the same spoiler rule.</p>' +
      '<form id="nextForm" class="fields" autocomplete="off">' + bookFields(w || {}) + '<div id="nErr"></div><button class="btn big block" type="submit">Start reading</button></form>',
    function (root) {
      $('#nextForm', root).addEventListener('submit', function (ev) {
        ev.preventDefault();
        var body = { book: readBook(ev.target) };
        write('POST', '/next', body, function (club) { return C.startNext(club, body, { today: today(), bookId: C.newId('b', rand) }); })
          .then(function (d) { closeSheet(true); state.seen = []; go(clubHash('board')); toast(d.msg || 'Started.', 4200); }).catch(function (e) { showError(e, $('#nErr', root)); });
      });
    });
  }
  function openEditBook() {
    var v = V();
    sheet('<h2>Edit the book</h2><p class="small muted">Fix a typo or the chapter count. Bookmarks past a shorter count read as the end.</p><form id="bookForm" class="fields" autocomplete="off">' + bookFields(v.book) + '<div id="bErr"></div><button class="btn block" type="submit">Save</button></form>',
      function (root) {
        $('#bookForm', root).addEventListener('submit', function (ev) {
          ev.preventDefault();
          var body = readBook(ev.target);
          write('PATCH', '/book', body, function (club) { return C.editBook(club, body); }).then(function () { closeSheet(true); draw(); toast('Saved.'); }).catch(function (e) { showError(e, $('#bErr', root)); });
        });
      });
  }
  function openShelfNotes(bid) {
    var p = isDemo() ? Promise.resolve(C.shelfNotes(state.demo.club, bid, state.demo.notes, state.demo.you)) : api('GET', 'api/c/' + encodeURIComponent(state.clubId) + '/shelf/' + encodeURIComponent(bid) + '/notes');
    p.then(function (d) {
      sheet('<h2>Notes on ' + esc(d.book.title) + '</h2>' + (d.locked.total ? '<p class="small muted">🔒 ' + esc(plural(d.locked.total, 'note')) + ' past where you got to stay locked.</p>' : '') +
        (d.notes.length ? d.notes.map(function (n) {
          return '<div class="nt' + (n.kind === 'question' ? ' q' : '') + '"><div class="hd"><span class="e" aria-hidden="true">' + esc(n.emoji) + '</span><span>' + esc(n.name) + '</span>' +
            (n.kind === 'minutes' ? '<span class="pill ' + (n.decision ? 't-ok' : 't-host') + '">' + (n.decision ? '✓ Decided' : 'Meeting') + (n.meetDate ? ' · ' + esc(C.shortDay(n.meetDate, LOCALE)) : '') + '</span>' : '') +
            '<small>· ' + esc(C.atShort(d.book, n.at)) + '</small></div><p class="tx">' + esc(n.text) + '</p>' +
            ((n.replies || []).length ? '<div class="thread">' + n.replies.map(function (r) { return '<div class="rp"><div class="hd"><span class="e" aria-hidden="true">' + esc(r.emoji) + '</span><span>' + esc(r.name) + '</span></div><p class="tx">' + esc(r.text) + '</p></div>'; }).join('') + '</div>' : '') + '</div>';
        }).join('') : '<p class="muted">No notes were left on this one.</p>'));
    }).catch(function (e) { showError(e); });
  }

  /* -- AI: suggest discussion questions (signed in, metered) -- */

  function openAi() {
    var v = V(), book = v.book, pos = myPos(v);
    if (isDemo()) {
      sheet('<h2>Suggest discussion questions</h2><p>In a real club, a signed-in member can ask AI for up to six questions for the chapters they’ve read. The made-up club can’t - start your own to try it.</p><p class="small muted">Free accounts come with $2 of AI credit. A suggestion costs about a cent.</p><button class="btn" type="button" data-act="startform">Start my own club</button>');
      return;
    }
    if (!signedIn()) {
      sheet('<h2>Suggest discussion questions</h2><p>AI can suggest up to six questions for the chapters you’ve read. It needs a free account - which comes with $2 of AI credit, about a cent a suggestion.</p><p class="small muted">Everything else in Chapter stays free with no account.</p><button class="btn" type="button" data-act="signin-ai">Create a free account</button> <button class="link-btn" type="button" data-act="signin-ai-login">I have one</button>');
      return;
    }
    if (!pos) { sheet('<h2>Suggest discussion questions</h2><p>Set your bookmark first - questions only go up to where you are, so they can’t spoil it for you.</p><button class="btn" type="button" data-act="progress">Set my bookmark</button>'); return; }
    var r = state.ai && state.ai.clubId === v.id ? state.ai : { clubId: v.id, from: 1, to: pos, result: null, added: {} };
    if (r.to > pos) r.to = pos;
    state.ai = r;
    function opts(sel, max) { var o = ''; for (var i = 1; i <= max; i++) o += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + i + '</option>'; return o; }
    var pick = book.unit === 'ch' && pos <= 400
      ? '<div class="fields two"><label class="field"><span>From chapter</span><select class="input" id="aFrom">' + opts(r.from, pos) + '</select></label><label class="field"><span>To chapter</span><select class="input" id="aTo">' + opts(r.to, pos) + '</select></label></div>'
      : '<div class="fields two"><label class="field"><span>From page</span><input class="input" id="aFrom" type="number" min="1" max="' + pos + '" value="' + r.from + '"></label><label class="field"><span>To page</span><input class="input" id="aTo" type="number" min="1" max="' + pos + '" value="' + r.to + '"></label></div>';
    sheet('<h2>Suggest discussion questions</h2><p class="small muted">Up to ' + esc(C.atLabel(book, pos)) + ' - where you are - so nothing can spoil it for you.</p>' + pick +
      '<div class="sent" id="aSent"></div><div id="aErr"></div><button class="btn block ai" type="button" id="aGo" data-u="margin-top-10px">Suggest questions</button><div id="aOut"></div>',
    function (root) {
      function sent() { $('#aSent', root).innerHTML = '<b>What is sent:</b> “' + esc(book.title) + '”' + (book.author ? ' by ' + esc(book.author) : '') + ', ' + esc(book.unit === 'ch' ? 'chapters ' : 'pages ') + esc(r.from) + '-' + esc(r.to) + '. <b>Nothing else</b> - no names, no notes, nothing anyone in the club wrote.'; }
      function read() { r.from = Number($('#aFrom', root).value) || 1; r.to = Number($('#aTo', root).value) || pos; sent(); }
      sent(); drawAi(root);
      $('#aFrom', root).addEventListener('change', read); $('#aTo', root).addEventListener('change', read);
      $('#aGo', root).addEventListener('click', function () {
        read();
        var btn = $('#aGo', root); btn.disabled = true; btn.textContent = 'Thinking…';
        api('POST', 'api/ai/questions', { club: v.id, from: r.from, to: r.to }).then(function (d) {
          btn.disabled = false; btn.textContent = 'Suggest again';
          r.result = d; r.added = {}; drawAi(root);
        }).catch(function (e) { btn.disabled = false; btn.textContent = 'Suggest questions'; meteredError(e, $('#aErr', root), function () { openAi(); }, 'Sign in to ask for suggestions.'); });
      });
    });
  }
  function drawAi(root) {
    var r = state.ai, out = $('#aOut', root), book = V().book;
    if (!r || !r.result) { out.innerHTML = ''; return; }
    out.innerHTML = '<div class="sheet-sec"><p><span class="pill t-lock">AI-written - check before the meeting</span></p>' +
      (r.result.knowsBook ? '' : '<p class="note small">The AI doesn’t know this book well, so these are general questions for any reader of these chapters.</p>') +
      r.result.questions.map(function (q, i) {
        return '<div class="aiq"><p>' + esc(q.text) + '<br><small>' + esc(C.atShort(book, q.at)) + '</small></p>' + (r.added[i] ? '<span class="pill t-ok">Added</span>' : '<button class="btn small soft" type="button" data-addq="' + i + '">Add</button>') + '</div>';
      }).join('') + '<p class="small muted" data-u="margin-top-8px">Only the ones you add are saved, as your questions, tagged by chapter like any other.</p></div>';
    $$('[data-addq]', out).forEach(function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-addq')), q = r.result.questions[i];
        b.disabled = true;
        postNote({ kind: 'question', text: q.text, at: q.at, ai: true }).then(function () { r.added[i] = true; drawAi(root); draw(); }).catch(function (e) { b.disabled = false; showError(e, $('#aErr', root)); });
      });
    });
  }

  /* -- the share card: drawn here, never uploaded, two taps -- */

  function canShareFiles() {
    try { return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [new File(['x'], 'x.png', { type: 'image/png' })] })); } catch (e) { return false; }
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function fit(g, s, max) { s = String(s); if (g.measureText(s).width <= max) return s; var cps = Array.from(s); while (cps.length > 1 && g.measureText(cps.join('') + '…').width > max) cps.pop(); return cps.join('') + '…'; }
  /** Up to `lines` lines of `s`, the last cut with an ellipsis. */
  function wrap(g, s, max, lines) {
    var words = String(s).split(/\s+/), out = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var t = cur ? cur + ' ' + words[i] : words[i];
      if (g.measureText(t).width <= max || !cur) cur = t; else { out.push(cur); cur = words[i]; }
      if (out.length === lines) break;
    }
    if (out.length < lines && cur) out.push(cur);
    if (out.length === lines && (out.join(' ').length < String(s).length)) out[lines - 1] = fit(g, out[lines - 1] + ' …', max).replace(/ …$/, '…');
    return out.map(function (l) { return fit(g, l, max); });
  }
  /** A star as a drawn shape (no font glyph), filled to `frac`. */
  function star(g, cx, cy, r, frac, on, off) {
    function path() { g.beginPath(); for (var i = 0; i < 10; i++) { var a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r; g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } g.closePath(); }
    g.fillStyle = off; path(); g.fill();
    if (frac > 0) { g.save(); g.beginPath(); g.rect(cx - r, cy - r, r * 2 * Math.min(1, frac), r * 2); g.clip(); g.fillStyle = on; path(); g.fill(); g.restore(); }
  }
  function drawCard(bid) {
    var d = C.cardData(V(), bid);
    if (!d) return Promise.reject(new Error('That book isn’t on the shelf.'));
    var cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1350;
    var g = cv.getContext('2d');
    var grad = g.createLinearGradient(0, 0, 1080, 1350); grad.addColorStop(0, '#5b2a6e'); grad.addColorStop(1, '#7a4a1c');
    g.fillStyle = grad; g.fillRect(0, 0, 1080, 1350);
    var F = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    // The header's mark: a bookmark ribbon on a white tile.
    g.fillStyle = '#ffffff'; roundRect(g, 84, 84, 96, 96, 26); g.fill();
    g.fillStyle = '#5b2a6e'; g.beginPath(); g.moveTo(108, 102); g.lineTo(156, 102); g.lineTo(156, 162); g.lineTo(132, 144); g.lineTo(108, 162); g.closePath(); g.fill();
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff'; g.font = '800 50px ' + F; g.fillText('Chapter', 206, 116);
    g.fillStyle = '#f6e9f7'; g.font = '700 32px ' + F; g.fillText(fit(g, d.club, 780), 206, 160);
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#f6e9f7'; g.font = '800 56px ' + F; g.fillText('Our club finished', 84, 360);
    g.fillStyle = '#ffffff'; g.font = '900 100px ' + F;
    var tl = wrap(g, d.title, 912, 3), y = 480;
    tl.forEach(function (l) { g.fillText(l, 84, y); y += 112; });
    if (d.author) { g.fillStyle = '#f6e9f7'; g.font = '700 44px ' + F; g.fillText(fit(g, 'by ' + d.author, 912), 84, y - 30); y += 50; }
    // The rating: the club's average, big, with five drawn stars beside it.
    y = Math.max(y + 30, 700);
    g.fillStyle = 'rgba(255,255,255,.14)'; roundRect(g, 84, y, 912, 236, 36); g.fill();
    if (d.avg) {
      g.fillStyle = '#ffffff'; g.font = '900 150px ' + F;
      var num = d.avg.toFixed(1), nw = g.measureText(num).width;
      g.fillText(num, 124, y + 168);
      var sx = 124 + nw + 64;
      for (var i = 0; i < 5; i++) star(g, sx + i * 80, y + 92, 32, Math.max(0, Math.min(1, d.avg - i)), '#ffd66b', 'rgba(255,255,255,.28)');
      g.fillStyle = '#f6e9f7'; g.font = '800 34px ' + F; g.fillText(fit(g, 'club average', 996 - 40 - sx + 32), sx - 32, y + 170);
      g.fillStyle = '#f6e9f7'; g.font = '700 30px ' + F; g.fillText(fit(g, 'from ' + plural(d.rated, 'rating') + ' · ' + plural(d.members, 'reader'), 840), 124, y + 214);
    } else {
      g.fillStyle = '#ffffff'; g.font = '900 64px ' + F; g.fillText(fit(g, plural(d.members, 'reader') + ', one book', 840), 124, y + 120);
      g.fillStyle = '#f6e9f7'; g.font = '700 36px ' + F; g.fillText('No spoilers along the way.', 124, y + 186);
    }
    // A shelf of spines - shapes only - with this book standing out.
    var base = 1206, x = 84, k = 0, hs = [128, 150, 112, 140, 120, 150, 104, 136, 146, 118, 132];
    var letter = (Array.from(d.title)[0] || '').toUpperCase();
    while (x < 960) {
      var w = 46 + ((k * 17) % 22), h = hs[k % hs.length], hero = k === 4;
      if (hero) { w = 78; h = 156; }
      g.fillStyle = hero ? '#ffffff' : 'rgba(255,255,255,' + (0.12 + ((k * 7) % 5) * 0.035) + ')';
      roundRect(g, x, base - h, Math.min(w, 996 - x), h, 8); g.fill();
      if (hero) {
        g.fillStyle = '#5b2a6e'; g.fillRect(x + 12, base - h + 18, w - 24, 6); g.fillRect(x + 12, base - 30, w - 24, 6);
        g.font = '900 44px ' + F; g.textAlign = 'center'; g.fillText(letter, x + w / 2, base - h / 2 + 16); g.textAlign = 'left';
      }
      x += w + 10; k++;
    }
    g.fillStyle = 'rgba(255,255,255,.55)'; roundRect(g, 72, base, 936, 12, 6); g.fill();
    g.fillStyle = '#f6e9f7'; g.font = '700 30px ' + F; g.fillText('Read together with Chapter · ' + fit(g, location.host + BASE.replace(/\/$/, ''), 520), 84, 1296);
    return new Promise(function (resolve) { cv.toBlob(function (b) { resolve(b); }, 'image/png'); }).then(function (blob) {
      if (!blob) throw new Error('This browser couldn’t draw the image.');
      var K = state.card;
      if (K.url) URL.revokeObjectURL(K.url);
      K.blob = blob; K.url = URL.createObjectURL(blob); K.bid = bid; K.title = d.title;
      return K;
    });
  }
  function openCard(bid) {
    sheet('<h2>Share card</h2><p class="small muted">Drawn on this phone - the club name, the book and the average. No names, no notes. Never uploaded.</p><div id="cardSlot"><p class="muted">Drawing…</p></div>', function (root) {
      drawCard(bid).then(function (K) {
        $('#cardSlot', root).innerHTML = '<img class="share-img" src="' + esc(K.url) + '" alt="Our club finished ' + esc(K.title) + '"><button class="btn block" type="button" data-act="cardshare" data-u="margin-top-12px">' + (canShareFiles() ? 'Share it' : 'Download it') + '</button>';
      }).catch(function (e) { showError(e, $('#cardSlot', root)); });
    });
  }
  function shareCard() {
    var K = state.card; if (!K.blob) return;
    var name = 'chapter-' + slug(K.title) + '.png';
    var file = new File([K.blob], name, { type: 'image/png' });
    if (canShareFiles()) navigator.share({ files: [file], title: 'Our club finished ' + K.title }).catch(function (e) { if (!e || e.name !== 'AbortError') download(name, 'image/png', K.blob); });
    else download(name, 'image/png', K.blob);
  }

  /* ---------------- the account (optional) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = state.me || { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }
  function loadAccountClubs() {
    if (!signedIn()) return;
    api('GET', 'api/account/clubs').then(function (d) { state.accountClubs = d.clubs; if (state.view === 'home') draw(); }).catch(function () { /* optional */ });
  }

  var FREE_LINE = 'Chapter is free with no account. A free account is optional: it keeps your clubs on your account so they open on your other devices, and lets you ask AI for discussion questions - it comes with $2 of AI credit, and one account works across every app on this site.';
  function openAccount(reason, then, start) {
    var mode = start === 'login' ? 'login' : 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field" data-u="margin-10px-0"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field" data-u="margin-10px-0"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button" data-u="margin-top-10px">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center" data-u="margin-top-12px">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
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
    loadAccountClubs();
    if (state.view === 'club' && !isDemo()) loadClub(true);
    if (state.view === 'library') loadLibrary();
    if (then) then(); else draw();
  }
  function openAccountSheet() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" data-u="margin-6px-0-0">A set of suggested questions costs about a cent. Everything else is free.</p><div id="billing"></div></div>' +
      '<p class="small muted" data-u="margin-top-12px">Clubs you keep on your account open wherever you’re signed in. Keep one from its Club page.</p>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" data-u="margin-top-10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" data-u="margin-top-10px">Sign out</button>',
    function (root) {
      drawBilling($('#billing', root));
      $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout', {}).then(function () { closeSheet(); state.me = { signedIn: false, account: state.me.account }; state.accountClubs = null; drawTop(); if (state.view === 'club' && !isDemo()) loadClub(true); draw(); }); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((d && d.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Writing your own questions, notes, the board and everything else keep working, free.</p><div id="billing"></div>' +
      (d && d.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(d.topUpUrl) + '">Top up</a></p>' : ''),
    function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- clicks ---------------- */

  /* ---------------- my library (per person, across clubs; nobody else sees it) ---------------- */

  var LB = window.ChapterLibrary;
  function loadLibrary() {
    return api('GET', 'api/library').then(function (d) { state.library = d.library; if (state.view === 'library') draw(); })
      .catch(function (e) { state.libraryErr = e.message; if (state.view === 'library') draw(); });
  }
  function setLibrary(lb) { state.library = lb; if (state.view === 'library') draw(); }
  function coverHtml(b) {
    var letter = esc((Array.from(b.title || '?')[0] || '?').toUpperCase());
    return '<span class="lcover" aria-hidden="true">' + (b.cover ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '') + '<span>' + letter + '</span></span>';
  }
  function tagChips(b) {
    return LB.tagLabels(b).map(function (t) { return '<span class="pill ' + (t === 'Signed' ? 't-signed' : 't-special') + '">' + (t === 'Signed' ? '✍️ ' : '✨ ') + esc(t) + '</span>'; }).join('');
  }
  function bookLine(b) {
    var bits = [];
    if (b.author) bits.push(esc(b.author));
    if (b.pages) bits.push(esc(b.pages) + ' pages');
    return bits.join(' · ');
  }
  function viewLibrary() {
    var head = '<div class="sec-head"><h1>My library</h1><button class="btn small ghost" type="button" data-act="home">Your clubs</button></div>';
    var lb = state.library;
    if (!lb) return head + '<div class="card center"><p class="muted">' + esc(state.libraryErr || 'Opening your library…') + '</p></div>';
    var add = '<div class="card lib-add"><p class="lab">Add a book</p><div class="row">' +
      '<button class="btn" type="button" data-act="libscan">📷 Scan the barcode</button>' +
      '<button class="btn ghost" type="button" data-act="libisbn">Type the ISBN</button>' +
      '<button class="btn ghost" type="button" data-act="libmanual">Add it by hand</button></div>' +
      '<p class="small muted" data-u="margin-10px-0-0">Title, author, cover and pages come from Open Library. Only you see your library - not your clubs, not anyone else.</p></div>';
    var where = lb.where === 'account'
      ? '<p class="small muted">On your account - it opens on any device you sign in on.</p>' + (lb.phone ? '<div class="note row" data-u="justify-content-space-between"><span class="small"><b>' + esc(plural(lb.phone, 'book')) + '</b> on this phone aren’t on your account yet.</span><button class="btn small" type="button" data-act="libkeep">Move them to my account</button></div>' : '')
      : (lb.account && !signedIn() ? '<p class="small muted">On this phone. <button class="link-btn" type="button" data-act="signin">Sign in (free)</button> to keep it on your account and see it on your other devices.</p>' : '<p class="small muted">On this phone.</p>');
    var c = lb.counts;
    var sum = c.total ? '<p class="lab" data-u="margin-top-16px">' + esc(plural(c.total, 'book')) + (c.special ? ' · ' + esc(plural(c.special, 'special edition')) : '') + (c.signed ? ' · ' + esc(c.signed) + ' signed' : '') + '</p>' : '';
    var list = c.total ? '<div class="lbooks">' + lb.books.map(function (b) {
      return '<button class="lbook" type="button" data-act="libbook" data-id="' + esc(b.id) + '">' + coverHtml(b) +
        '<span class="lmeta"><b>' + esc(b.title) + '</b><small>' + bookLine(b) + '</small>' +
        (b.special || b.signed ? '<span class="ltags">' + tagChips(b) + '</span>' : '') +
        (b.note ? '<small class="lnote">' + esc(b.note) + '</small>' : '') + '</span><span aria-hidden="true">›</span></button>';
    }).join('') + '</div>' : '<div class="card center" data-u="margin-top-14px"><div data-u="font-size-2rem">📚</div><p class="muted">Nothing here yet. Scan the barcode on the back of a book to add it.</p></div>';
    var foot = c.total ? '<p class="small muted center" data-u="margin-top-18px"><button class="link-btn" type="button" data-act="libdelete">Delete my whole library</button></p>' : '';
    return head + add + where + sum + list + foot;
  }
  function bindLibrary() {
    $$('.lcover img').forEach(function (img) { img.addEventListener('error', function () { img.remove(); }); });
  }

  /* -- edition tags: the same three fields wherever a book is added or edited -- */

  function tagFields(t) {
    var on = Boolean(t && (t.special || t.signed));
    return '<fieldset class="tagset"><legend class="lab">This copy</legend>' +
      '<label class="check"><input type="checkbox" name="special"' + (t && t.special ? ' checked' : '') + '> ✨ Special edition</label>' +
      '<label class="check"><input type="checkbox" name="signed"' + (t && t.signed ? ' checked' : '') + '> ✍️ Signed</label>' +
      '<label class="field tagnote"' + (on ? '' : ' hidden') + '><span>About this edition <small class="hint">(optional)</small></span><input class="input" name="note" maxlength="200" placeholder="Folio Society, slipcase · Signed at the launch" value="' + esc((t && t.note) || '') + '"></label></fieldset>';
  }
  function bindTagFields(f) {
    var sync = function () { $('.tagnote', f).hidden = !(f.special.checked || f.signed.checked); };
    f.special.addEventListener('change', sync); f.signed.addEventListener('change', sync);
  }
  function readTags(f) { return { special: f.special.checked, signed: f.signed.checked, note: f.note.value }; }

  /* -- adding: by ISBN (typed or scanned), confirmed, or by hand -- */

  function openIsbn(prefill, why) {
    sheet('<h2>Type the ISBN</h2>' + (why ? '<p class="note small" role="alert">' + esc(why) + '</p>' : '') +
      '<form class="fields" id="isbnForm" autocomplete="off"><label class="field"><span>ISBN <small class="hint">(10 or 13 digits, above the barcode)</small></span><input class="input" name="isbn" inputmode="text" autocapitalize="characters" spellcheck="false" enterkeyhint="search" maxlength="24" placeholder="978-0141439518" value="' + esc(prefill || '') + '"></label>' +
      '<div id="isbnErr"></div><button class="btn block" type="submit">Look it up</button></form>' +
      '<div class="row" data-u="margin-top-12px"><button class="btn small ghost" type="button" data-act="libscan">📷 Scan instead</button><button class="btn small ghost" type="button" data-act="libmanual">Add it by hand</button></div>', function (root) {
      var f = $('#isbnForm', root);
      setTimeout(function () { try { f.isbn.focus(); } catch (e) { /* ignore */ } }, 60);
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var isbn = LB.toIsbn13(f.isbn.value);
        if (!isbn) { $('#isbnErr').innerHTML = '<p class="err" role="alert">' + esc(LB.isbnProblem(f.isbn.value)) + '</p>'; return; }
        lookupIsbn(isbn, $('button[type=submit]', f), $('#isbnErr'));
      });
    });
  }
  function lookupIsbn(isbn, btn, errBox) {
    if (btn) { btn.disabled = true; btn.textContent = 'Looking it up…'; }
    return api('GET', 'api/isbn/' + encodeURIComponent(isbn)).then(function (d) {
      if (d.found) return openConfirm(d);
      openManual(d.book, d.reason === 'unavailable'
        ? 'Open Library isn’t answering right now, so fill it in yourself - the ISBN is kept.'
        : 'Open Library doesn’t know ' + LB.showIsbn(d.isbn) + '. Fill it in yourself - the ISBN is kept.', d.have);
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Look it up'; }
      if (e.offline || e.status === 429) return openManual({ isbn: isbn }, e.message);
      showError(e, errBox);
    });
  }
  function haveLine(n) { return n ? '<p class="note small">You already have ' + esc(n === 1 ? 'a copy' : n + ' copies') + ' of this edition - adding it again keeps both.</p>' : ''; }
  function openConfirm(d) {
    var b = d.book;
    sheet('<h2>Add this book?</h2>' + haveLine(d.have) +
      '<div class="lfound">' + coverHtml(b) + '<div><b>' + esc(b.title) + '</b><p class="small muted" data-u="margin-4px-0">' + (bookLine(b) || 'No author listed') + '</p><p class="small muted" data-u="margin-0">ISBN ' + esc(LB.showIsbn(b.isbn)) + ' · from Open Library</p></div></div>' +
      '<form class="fields" id="confirmForm">' + tagFields(null) + '<div id="confirmErr"></div>' +
      '<button class="btn block" type="submit">Add to my library</button></form>' +
      '<p class="small center" data-u="margin-top-10px"><button class="link-btn" type="button" id="notRight">Not right? Edit the details</button></p>', function (root) {
      var f = $('#confirmForm', root);
      bindLibrary(); bindTagFields(f);
      $('#notRight', root).addEventListener('click', function () { openManual(b, null, d.have); });
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var t = readTags(f);
        addBook({ isbn: b.isbn, title: b.title, author: b.author, pages: b.pages, cover: b.cover, source: 'openlibrary', special: t.special, signed: t.signed, note: t.note }, $('button[type=submit]', f), $('#confirmErr'));
      });
    });
  }
  function openManual(pre, why, have) {
    var p = pre || {};
    sheet('<h2>Add a book by hand</h2>' + (why ? '<p class="note small" role="status">' + esc(why) + '</p>' : '') + haveLine(have) +
      '<form class="fields" id="manualForm" autocomplete="off">' +
      '<label class="field"><span>Title</span><input class="input" name="title" maxlength="140" required value="' + esc(p.title || '') + '"></label>' +
      '<label class="field"><span>Author</span><input class="input" name="author" maxlength="120" value="' + esc(p.author || '') + '"></label>' +
      '<div class="fields two"><label class="field"><span>Pages</span><input class="input" name="pages" inputmode="numeric" pattern="[0-9]*" maxlength="5" value="' + esc(p.pages || '') + '"></label>' +
      '<label class="field"><span>ISBN <small class="hint">(optional)</small></span><input class="input" name="isbn" maxlength="24" spellcheck="false" value="' + esc(p.isbn ? LB.showIsbn(p.isbn) : '') + '"></label></div>' +
      tagFields(null) + '<div id="manualErr"></div><button class="btn block" type="submit">Add to my library</button></form>', function (root) {
      var f = $('#manualForm', root);
      bindTagFields(f);
      setTimeout(function () { try { (f.title.value ? f.author : f.title).focus(); } catch (e) { /* ignore */ } }, 60);
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var t = readTags(f);
        // A cover only stays when the ISBN is still the one it was found for.
        var keepCover = p.cover && LB.toIsbn13(f.isbn.value) === p.isbn;
        addBook({ isbn: f.isbn.value, title: f.title.value, author: f.author.value, pages: f.pages.value.trim() || null, cover: keepCover ? p.cover : '', source: 'manual', special: t.special, signed: t.signed, note: t.note }, $('button[type=submit]', f), $('#manualErr'));
      });
    });
  }
  function addBook(body, btn, errBox) {
    btn.disabled = true;
    api('POST', 'api/library/books', body).then(function (d) {
      closeSheet(true); setLibrary(d.library);
      if (state.view !== 'library') go('library');
      toast('Added to your library.', 2800, { label: 'Scan another', fn: function () { openScan(); } });
    }).catch(function (e) { btn.disabled = false; showError(e, errBox); });
  }

  /* -- one book: its tags, or remove it -- */

  function openBook(id) {
    var b = state.library && state.library.books.filter(function (x) { return x.id === id; })[0];
    if (!b) return;
    sheet('<h2>' + esc(b.title) + '</h2><div class="lfound">' + coverHtml(b) + '<div><p class="small muted" data-u="margin-0-0-4px">' + (bookLine(b) || 'No author listed') + '</p>' +
      (b.isbn ? '<p class="small muted" data-u="margin-0">ISBN ' + esc(LB.showIsbn(b.isbn)) + '</p>' : '') + '</div></div>' +
      '<form class="fields" id="tagForm">' + tagFields(b) + '<div id="tagErr"></div><button class="btn block" type="submit">Save</button></form>' +
      '<p class="small center" data-u="margin-top-12px"><button class="link-btn" type="button" id="libRemove">Remove from my library</button></p>', function (root) {
      var f = $('#tagForm', root);
      bindLibrary(); bindTagFields(f);
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var btn = $('button[type=submit]', f); btn.disabled = true;
        api('PATCH', 'api/library/books/' + encodeURIComponent(id), readTags(f)).then(function (d) { closeSheet(); setLibrary(d.library); toast('Saved.'); })
          .catch(function (e) { btn.disabled = false; showError(e, $('#tagErr')); });
      });
      $('#libRemove', root).addEventListener('click', function () {
        if (!confirm('Remove ' + b.title + ' from your library?')) return;
        api('DELETE', 'api/library/books/' + encodeURIComponent(id)).then(function (d) { closeSheet(); setLibrary(d.library); toast('Removed.'); }).catch(function (e) { showError(e); });
      });
    });
  }

  /* -- scanning the barcode with the camera --
   * The back camera only, no microphone, switched off the moment the sheet
   * closes or a book is read. Frames never leave the phone: they are read
   * here (BarcodeDetector where the browser has one, ChapterLibrary's own
   * EAN-13 reader where it does not - iPhone Safari), and only the ISBN is
   * looked up. A refused or missing camera offers the typed ISBN instead. */

  function stopScan() {
    var s = state.scan;
    if (!s) return;
    state.scan = null;
    clearTimeout(s.timer);
    if (s.stream) s.stream.getTracks().forEach(function (t) { t.stop(); });
  }
  function openScan() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
      return openIsbn('', 'This browser can’t use the camera here. Type the ISBN instead - it’s printed above the barcode on the back.');
    }
    sheet('<h2>Scan the barcode</h2><p class="small muted">Point your camera at the barcode on the back cover - the one with 978 or 979 under it. Hold it level and fill the box.</p>' +
      '<div class="scan"><video id="scanVideo" playsinline muted autoplay></video><div class="scan-aim" aria-hidden="true"></div></div>' +
      '<p class="small" id="scanMsg" role="status">Starting the camera…</p>' +
      '<div class="row"><button class="btn small ghost" type="button" data-act="libisbn">Type the ISBN instead</button></div>', function (root) {
      var video = $('#scanVideo', root), msg = $('#scanMsg', root);
      var me = { stream: null, timer: 0, last: '', hits: 0, detector: null };
      state.scan = me;
      var detect = ('BarcodeDetector' in window && window.BarcodeDetector.getSupportedFormats)
        ? window.BarcodeDetector.getSupportedFormats().then(function (f) { return f.indexOf('ean_13') >= 0 ? new window.BarcodeDetector({ formats: ['ean_13'] }) : null; }).catch(function () { return null; })
        : Promise.resolve(null);
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then(function (stream) {
        if (state.scan !== me) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        me.stream = stream;
        video.srcObject = stream;
        var p = video.play(); if (p && p.catch) p.catch(function () { /* autoplay is muted */ });
        msg.textContent = 'Looking for a barcode…';
        return detect.then(function (d) { me.detector = d; tick(); });
      }).catch(function (err) {
        if (state.scan !== me) return;
        stopScan();
        var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError' || err.name === 'PermissionDeniedError');
        openIsbn('', denied
          ? 'Camera access was denied. Type the ISBN instead - it’s printed above the barcode. (To scan next time, allow the camera for this site in your browser’s settings.)'
          : 'No camera could be opened here. Type the ISBN instead - it’s printed above the barcode.');
      });
      var canvas = document.createElement('canvas'), g = canvas.getContext('2d', { willReadFrequently: true });
      function found(code) {
        if (!LB.isbn13Ok(code)) { msg.textContent = 'That barcode isn’t a book’s - look for the one starting 978 or 979.'; me.last = ''; me.hits = 0; return false; }
        // Twice in a row (or on two lines of one frame) before it counts.
        me.hits = code === me.last ? me.hits + 1 : 1; me.last = code;
        if (me.hits < 2) return false;
        stopScan();
        try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) { /* ignore */ }
        msg.textContent = 'Found ' + LB.showIsbn(code) + ' - looking it up…';
        lookupIsbn(code, null, msg);
        return true;
      }
      function tick() {
        if (state.scan !== me) return;
        if (video.readyState >= 2 && video.videoWidth) {
          var w = Math.min(960, video.videoWidth), h = Math.round(w * video.videoHeight / video.videoWidth);
          canvas.width = w; canvas.height = h;
          g.drawImage(video, 0, 0, w, h);
          if (me.detector) {
            me.detector.detect(canvas).then(function (codes) {
              var c = codes && codes[0] && String(codes[0].rawValue || '');
              if (!(c && found(c)) && state.scan === me) me.timer = setTimeout(tick, 160);
            }).catch(function () { me.detector = null; if (state.scan === me) me.timer = setTimeout(tick, 160); });
            return;
          }
          var img = g.getImageData(0, 0, w, h);
          var r = window.ChapterLibrary.decodeFrame(LB.toGray(img.data, w, h), w, h);
          if (r && r.votes >= 2) { me.last = r.code; me.hits = 1; }
          if (r && found(r.code)) return;
        }
        me.timer = setTimeout(tick, 180);
      }
    });
  }

  function confirmDemo(what) { toast(what + ' is for a real club - start your own to try it.', 3600, { label: 'Start', fn: function () { go('start'); } }); }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    var v = state.view === 'club' && (isDemo() || state.club) ? V() : null;
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'library': closeSheet(true); state.demo = null; go('library'); break;
      case 'libscan': openScan(); break;
      case 'libisbn': openIsbn('', null); break;
      case 'libmanual': openManual(null, null, 0); break;
      case 'libbook': openBook(id); break;
      case 'libkeep':
        api('POST', 'api/library/keep', {}).then(function (d) { setLibrary(d.library); toast(d.moved ? 'Moved ' + plural(d.moved, 'book') + ' to your account.' : 'Nothing to move.'); }).catch(function (err) { showError(err); });
        break;
      case 'libdelete':
        if (!confirm('Delete your whole library? Every book and its notes go. This can’t be undone.')) break;
        api('DELETE', 'api/library').then(function (d) { setLibrary(d.library); toast('Your library is deleted.'); }).catch(function (err) { showError(err); });
        break;
      case 'home': e.preventDefault(); closeSheet(true); state.demo = null; go(''); break;
      case 'tab': closeSheet(true); go(clubHash(t.getAttribute('data-tab'))); break;
      case 'try': closeSheet(true); state.demo = null; go('try'); break;
      case 'tryleave': state.demo = null; go(''); toast('That was the made-up club - nothing was saved.'); break;
      case 'startform': closeSheet(true); state.demo = null; go('start'); break;
      case 'joinform': closeSheet(true); go('join'); break;
      case 'openclub': go('c/' + id); break;
      case 'clubsheet': openClubSheet(false); break;
      case 'progress': openProgress(); break;
      case 'plus1': if (v) { var me = myRow(v); saveProgress(Object.assign({ pos: Math.min(v.book.total, (me ? me.pos : 0) + 1) }, me && me.alt ? { alt: null } : {})); } break;
      case 'readplus': if (v) { var rme = myRow(v); saveProgress(Object.assign({ pos: Math.min(v.book.total, (rme ? rme.pos : 0) + 1) }, rme && rme.alt ? { alt: null } : {}), null, true); } break;
      case 'finished': saveProgress({ done: true }); break;
      case 'chapternow': if (v) {
        var cp = myPos(v);
        state.chapter = cp && v.notes.some(function (x) { return x.at === cp; }) ? cp : 'all';
        state.filter = 'all'; state.compose.at = cp || null;
        go(clubHash('notes'));
      } break;
      case 'read': if (v) openRead(); break;
      case 'readhere': if (v) openReader(); break;
      case 'buy': if (v) openBuy(); break;
      case 'mnote': if (v) openMeetingNote(id); break;
      case 'reply': state.replyTo = id; state.replyText = ''; draw(); setTimeout(function () { var x = $('.reply-form textarea'); if (x) x.focus(); }, 40); break;
      case 'replycancel': state.replyTo = ''; state.replyText = ''; draw(); break;
      case 'rate': {
        var n = Number(t.getAttribute('data-n'));
        var mineR = id === v.book.id ? v.book.myRating : ((v.shelf.filter(function (s) { return s.id === id; })[0] || {}).myRating);
        var stars2 = mineR === n ? null : n;
        var body = { book: id, stars: stars2 };
        write('PUT', '/rating', body, function (club, you) { return C.rate(club, you, id, stars2); }).then(function () { draw(); say(stars2 ? stars2 + ' stars saved.' : 'Rating cleared.'); }).catch(function (err) { showError(err); });
        break;
      }
      case 'react': {
        var emo = t.getAttribute('data-e');
        var note = findNote(v, id);
        var next = note && note.mine === emo ? null : emo;
        state.picker = '';
        if (isDemo()) {
          var dn = state.demo.notes.filter(function (x) { return x.id === id; })[0];
          if (dn) { var rr = C.react(dn, state.demo.you, next); var nn = C.applyPatch(dn, rr.patch); Object.keys(dn).forEach(function (k) { delete dn[k]; }); Object.assign(dn, nn); }
          draw(); break;
        }
        api('PUT', 'api/c/' + encodeURIComponent(state.clubId) + '/notes/' + encodeURIComponent(id) + '/react', { emoji: next }).then(function (d) { setClub(d.club); softDraw(); }).catch(function (err) { showError(err); });
        break;
      }
      case 'delnote': {
        var nt = findNote(v, id);
        if (!nt || !confirm(nt.own ? 'Delete your ' + (nt.kind === 'reply' ? 'reply' : 'note') + '?' : 'Remove this for everyone?' + ((nt.replies || []).length ? ' Its replies go too.' : ''))) break;
        if (isDemo()) { state.demo.notes = state.demo.notes.filter(function (x) { return x.id !== id && x.re !== id; }); draw(); toast('Removed.'); break; }
        api('DELETE', 'api/c/' + encodeURIComponent(state.clubId) + '/notes/' + encodeURIComponent(id)).then(function (d) { setClub(d.club); draw(); toast('Removed.'); }).catch(function (err) { showError(err); });
        break;
      }
      case 'picker': state.picker = id; draw(); break;
      case 'nominate': openNominate(); break;
      case 'askq': state.compose.kind = 'question'; go(clubHash('notes')); setTimeout(function () { var x = $('#cText'); if (x) x.focus(); }, 80); break;
      case 'ai': openAi(); break;
      case 'signin-ai': openAccount('Create a free account to ask for suggested questions. It comes with $2 of AI credit.', function () { openAi(); }); break;
      case 'signin-ai-login': openAccount('Sign in to ask for suggested questions.', function () { openAi(); }, 'login'); break;
      case 'rsvp': {
        var a = t.getAttribute('data-a');
        var m = v.meetings.filter(function (x) { return x.id === id; })[0];
        var ans = m && m.mine === a ? null : a;
        write('PUT', '/meetings/' + encodeURIComponent(id) + '/rsvp', { a: ans }, function (club, you) { return C.rsvp(club, you, id, ans); }).then(function () { draw(); }).catch(function (err) { showError(err); });
        break;
      }
      case 'ics': icsFor(id); break;
      case 'meetform': openMeetingForm(null); break;
      case 'meetedit': openMeetingForm(id); break;
      case 'meetdel':
        if (!confirm('Remove this meeting? Its meeting notes go too.')) break;
        write('DELETE', '/meetings/' + encodeURIComponent(id), undefined, function (club) { state.demo.notes = state.demo.notes.filter(function (x) { return x.meet !== id; }); var p = C.patch(); p.del.push('meetings.' + id); return { patch: p }; }).then(function () { draw(); toast('Removed.'); }).catch(function (err) { showError(err); });
        break;
      case 'approve': {
        var picks = v.vote.mine.slice();
        var at = picks.indexOf(id);
        if (at >= 0) picks.splice(at, 1); else picks.push(id);
        write('PUT', '/ballot', { picks: picks }, function (club, you) { return C.approve(club, you, picks); }).then(function () { draw(); say(at >= 0 ? 'Vote taken back.' : 'Voted.'); }).catch(function (err) { showError(err); });
        break;
      }
      case 'unnom':
        if (!confirm('Take this book off the list?')) break;
        write('DELETE', '/noms/' + encodeURIComponent(id), undefined, function (club, you) { return C.unnominate(club, you, id); }).then(function () { draw(); }).catch(function (err) { showError(err); });
        break;
      case 'closevote':
        if (!confirm('Close the vote and show everyone the winner?')) break;
        write('POST', '/vote/close', {}, function (club) { return C.closeVote(club, now()); }).then(function (d) { draw(); toast(d.msg || 'The vote is closed.', 4600); }).catch(function (err) { showError(err); });
        break;
      case 'reopen': write('POST', '/vote/reopen', {}, function () { return C.reopenVote(); }).then(function () { draw(); }).catch(function (err) { showError(err); }); break;
      case 'startnext': openStartNext(false); break;
      case 'startother': openStartNext(true); break;
      case 'editbook': openEditBook(); break;
      case 'shelfnotes': openShelfNotes(id); break;
      case 'card': openCard(id); break;
      case 'cardshare': shareCard(); break;
      case 'invite': shareText('Join ' + v.name + ' on Chapter', 'Join our book club “' + v.name + '” - we’re reading ' + v.book.title + '. Code ' + v.display + ':', isDemo() ? location.origin + BASE : joinLink(v)); break;
      case 'copyjoin': copy(isDemo() ? location.origin + BASE : joinLink(v), 'Link copied.'); break;
      case 'qr': openQr($('#qrSlot'), isDemo() ? location.origin + BASE : joinLink(v), 'Join ' + v.name); break;
      case 'newcode':
        if (!confirm('Make a new code? The old code and link stop working at once. Members already in are not affected.')) break;
        write('POST', '/code', {}).then(function (d) { openClubSheet(false); toast(d.msg || 'New code.'); }).catch(function (err) { showError(err); });
        break;
      case 'move':
        if (isDemo()) { confirmDemo('Moving to another phone'); break; }
        api('POST', 'api/c/' + encodeURIComponent(state.clubId) + '/move', {}).then(function (d) {
          var link = location.origin + BASE + '#move=' + d.token;
          var slot = $('#moveSlot');
          slot.innerHTML = '<p class="small" data-u="margin-10px-0-6px"><b>Open this on the new phone</b> (works once, for ' + esc(d.minutes) + ' minutes):</p><div class="linkbox">' + esc(link) + '</div><div class="row" data-u="margin-top-8px"><button class="btn small" type="button" id="mvCopy">Copy</button></div><div id="mvQr"></div>';
          $('#mvCopy').addEventListener('click', function () { copy(link, 'Copied. Send it to yourself, not the group.'); });
          openQr($('#mvQr'), link, 'Move my seat');
        }).catch(function (err) { showError(err); });
        break;
      case 'keep':
        api('PUT', 'api/account/clubs/' + encodeURIComponent(state.clubId), {}).then(function (d) { setClub(d.club); openClubSheet(false); toast('Kept on your account.'); }).catch(function (err) { showError(err); });
        break;
      case 'unkeep':
        api('DELETE', 'api/account/clubs/' + encodeURIComponent(state.clubId)).then(function (d) { if (d.club) setClub(d.club); openClubSheet(false); toast('No longer on your account. It stays on this phone.'); }).catch(function (err) { showError(err); });
        break;
      case 'signin': openAccount(null, function () { if ($('#sheet').hidden && state.view === 'club') draw(); }); break;
      case 'makehost': {
        var who = v.members.filter(function (x) { return x.id === id; })[0];
        if (!who || !confirm('Make ' + who.name + ' the host? You’ll be a reader like everyone else.')) break;
        write('POST', '/host', { to: id }).then(function (d) { openClubSheet(false); toast(d.msg || 'Done.'); }).catch(function (err) { showError(err); });
        break;
      }
      case 'kick': {
        var k = v.members.filter(function (x) { return x.id === id; })[0];
        if (!k || !confirm('Remove ' + k.name + ' from the club? Their notes, votes and ratings go too.')) break;
        write('DELETE', '/members/' + encodeURIComponent(id)).then(function () { openClubSheet(false); toast('Removed.'); }).catch(function (err) { showError(err); });
        break;
      }
      case 'leave':
        if (!confirm(v.members.length <= 1 ? 'You’re the only reader - leaving deletes the club. Leave?' : 'Leave ' + v.name + '? Your notes, questions, bookmark, votes and ratings are removed.')) break;
        api('DELETE', 'api/c/' + encodeURIComponent(state.clubId) + '/me').then(function () { forgetClub(state.clubId); closeSheet(true); go(''); toast('You’ve left the club.'); }).catch(function (err) { showError(err); });
        break;
      case 'delclub':
        if (!confirm('Delete ' + v.name + ' for everyone? Every note, vote and rating goes. This can’t be undone.')) break;
        api('DELETE', 'api/c/' + encodeURIComponent(state.clubId)).then(function () { forgetClub(state.clubId); closeSheet(true); go(''); toast('Deleted.'); }).catch(function (err) { showError(err); });
        break;
      default: break;
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  /* ---------------- start, and keeping up ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill) pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  // Two phones, one club: ask again when the app comes back to the
  // foreground, and every 10 seconds while a club is on screen (one read
  // when nothing moved).
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && state.view === 'club' && !isDemo() && state.clubId) loadClub(false); });
  setInterval(function () { if (document.visibilityState === 'visible' && state.view === 'club' && !isDemo() && state.clubId) loadClub(false); }, 10000);
  drawTop();
  route();
  loadMe().then(function () {
    if (state.view === 'home') { draw(); loadAccountClubs(); }
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openAccountSheet();
  });
}());
