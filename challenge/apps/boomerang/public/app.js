/* Boomerang - the page. One file, no build step. Every string that came
 * from outside this file (a typed item, a friend's name, a note, a model's
 * message, anything from the server) is escaped before it is drawn, and no
 * handler is written into markup: clicks are routed by data-act attributes
 * from one listener (the lab's CSP allows script from this origin only).
 * The rules - dates, the shelf, the stats, the handshake, the nudges - are
 * boomerang-core.js, the same file the server and the tests run.
 *
 * Views:
 *   shelf    - the empty state (first run), or the shelf: stats, tabs,
 *              Overdue / Due soon / Out now / Back home.
 *   h/<tok>  - a receipt link, as the friend (or the sender) sees it.
 *   preview  - the same page for a sample loan, worked out on this phone.
 *
 * Where things live: the shelf in localStorage (boomerang-shelf-v1), photos
 * in IndexedDB on this phone only, the sender's first name in
 * boomerang-name-v1, the chosen tab in boomerang-tab-v1. Signed in, the
 * shelf (never the photos) is also kept in the account.
 */
(function () {
  'use strict';

  var C = window.BoomerangCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_SHELF = 'boomerang-shelf-v1';
  var K_NAME = 'boomerang-name-v1';
  var K_TAB = 'boomerang-tab-v1';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var HS_TOKEN = (function () { var m = /\/h\/([A-Za-z0-9_-]{22})\/?$/.exec(location.pathname); return m ? m[1] : null; }());
  var AS_FRIEND = /(?:^|[?&])as=friend(?:&|$)/.test(location.search);
  var CONFETTI = ['#0f6b66', '#f59a4a', '#e8742b', '#62d6c6', '#f2c14e', '#d9467a'];

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function today() { return C.localDay(new Date()); }
  function rand(n) { var a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
  function dayOf(iso) { return iso ? C.localDay(new Date(iso)) : ''; }
  function fmt(day) { return C.fmtDay(day, today()); }
  var plural = C.plural;

  var state = {
    me: null,          // the account, if any
    view: 'shelf',     // shelf | hs
    loans: [],
    tab: 'all',        // all | lent | borrowed
    photos: {},        // loan id -> data URL, read from IndexedDB
    hs: null,          // {token, v, preview, loanId, err}
    hsCache: {},       // token -> the receipt as last read
    form: null,        // the add / edit form
    nudge: null,       // the nudge sheet
    armed: null,       // a delete waiting for its second tap
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
  function say(msg) { var l = $('#live'); if (l) { l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); } }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  /** The phone's own share sheet - Boomerang never sends anything itself. */
  function share(title, text, url) {
    if (navigator.share) navigator.share(url ? { title: title, text: text, url: url } : { title: title, text: text }).catch(function () { /* closed */ });
    else copy(url ? text + ' ' + url : text, 'Copied - paste it in your chat');
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function syncOn() { return signedIn() && state.me.sync !== false; }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function myName() { var n = recall(K_NAME); return typeof n === 'string' ? C.cleanName(n) : ''; }
  function loanById(id) { for (var i = 0; i < state.loans.length; i++) if (state.loans[i].id === id) return state.loans[i]; return null; }
  function hasSample() { return state.loans.some(function (l) { return l.sample; }); }
  function receiptLink(token) { return location.origin + BASE + 'h/' + token; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. The ready-made messages work meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).addEventListener('click', function () {
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { toast('Sent - check your email.'); }, function () { toast('Could not send it. Try again in a minute.'); });
    });
  }

  /* ---------------- this phone's shelf ---------------- */

  function loadLocal() {
    var raw = recall(K_SHELF);
    var list = raw && Array.isArray(raw.loans) ? raw.loans : [];
    var t = today();
    state.loans = list.map(function (l) { try { return C.cleanLoan(l, t); } catch (e) { return null; } }).filter(Boolean).slice(0, C.LIMITS.loans);
    var tab = recall(K_TAB);
    if (tab === 'lent' || tab === 'borrowed' || tab === 'all') state.tab = tab;
  }
  function saveLocal() { keep(K_SHELF, { v: 1, loans: state.loans }); }
  function touch(l) { l.updatedAt = Date.now(); }
  function syncFail(e) { if (e && e.status === 401) return; toast((e && e.message) || 'Could not save to your account - it is still on this phone.'); }
  function pushLoan(l) { if (!syncOn() || l.sample) return; api('PUT', 'api/shelf/' + l.id, { loan: C.toSaved(l), today: today() }).catch(syncFail); }
  function dropLoan(id) { if (!syncOn() || /^sample/.test(id)) return; api('DELETE', 'api/shelf/' + id).catch(syncFail); }
  /** Signed in: bring this phone's loans into the account (newer copy wins),
   *  then show what the account holds. Photos stay where they were taken. */
  function syncIn(announce) {
    if (!syncOn()) return Promise.resolve();
    var mine = state.loans.filter(function (l) { return !l.sample; });
    return api('POST', 'api/shelf/merge', { loans: mine.map(C.toSaved), today: today() }).then(function (r) {
      var withPhoto = {};
      state.loans.forEach(function (l) { if (l.photo) withPhoto[l.id] = true; });
      var t = today();
      var server = (r.loans || []).map(function (l) { return C.cleanLoan(l, t); }).filter(Boolean);
      server.forEach(function (l) { if (withPhoto[l.id]) l.photo = true; });
      var samples = server.length ? [] : state.loans.filter(function (l) { return l.sample; });
      state.loans = samples.concat(server);
      saveLocal();
      if (announce) toast(server.length ? 'Your shelf now follows you to any phone you sign in on.' : 'Signed in. Anything you add now follows you to your other phones.');
      if (state.view === 'shelf') draw();
      refreshShares();
    }).catch(function (e) { if (e.status !== 401) toast(e.message); });
  }

  /* ---------------- photos: on this phone only ---------------- */

  var dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve) {
      try {
        var r = indexedDB.open('boomerang', 1);
        r.addEventListener('upgradeneeded', function () { try { r.result.createObjectStore('photos'); } catch (e) { /* exists */ } });
        r.addEventListener('success', function () { resolve(r.result); });
        r.addEventListener('error', function () { resolve(null); });
        r.addEventListener('blocked', function () { resolve(null); });
      } catch (e) { resolve(null); }
    });
    return dbP;
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      if (!d) return null;
      return new Promise(function (resolve) {
        try {
          var tx = d.transaction('photos', mode);
          var req = fn(tx.objectStore('photos'));
          tx.addEventListener('complete', function () { resolve(req && req.result !== undefined ? req.result : null); });
          tx.addEventListener('error', function () { resolve(null); });
          tx.addEventListener('abort', function () { resolve(null); });
        } catch (e) { resolve(null); }
      });
    });
  }
  function photoGet(id) {
    if (state.photos[id]) return Promise.resolve(state.photos[id]);
    return idb('readonly', function (s) { return s.get(id); }).then(function (v) { if (typeof v === 'string' && /^data:image\/jpeg;base64,/.test(v)) state.photos[id] = v; return state.photos[id] || null; });
  }
  function photoPut(id, url) { state.photos[id] = url; return idb('readwrite', function (s) { return s.put(url, id); }); }
  function photoDel(id) { delete state.photos[id]; return idb('readwrite', function (s) { return s.delete(id); }); }
  /** A small thumbnail, redrawn through a canvas (which drops the photo's
   *  EXIF, location included). Never uploaded. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('That isn’t a photo.'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener('load', function () {
        var max = 360, w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
        var cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(w * s)); cv.height = Math.max(1, Math.round(h * s));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL('image/jpeg', 0.78));
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); });
      img.src = url;
    });
  }
  function loadPhotos() {
    var want = state.loans.filter(function (l) { return l.photo && !state.photos[l.id]; });
    if (!want.length) return;
    Promise.all(want.map(function (l) { return photoGet(l.id); })).then(function () { if (state.view === 'shelf' && $('#sheet').hidden) draw(); });
  }
  function tileFor(l) {
    if (l.photo && state.photos[l.id]) return '<div class="tile"><img src="' + esc(state.photos[l.id]) + '" alt=""></div>';
    return '<div class="tile" aria-hidden="true">' + esc(l.emoji) + '</div>';
  }

  /* ---------------- receipts: keeping each loan's state fresh ---------------- */

  function hsHeaders(l) { return l.share && l.share.key ? { 'X-Boomerang-Key': l.share.key } : null; }
  /** Read a loan's receipt and fold its state back into the loan: a receipt
   *  closed on the other phone marks the loan back home. */
  function readShare(l) {
    if (!l.share || l.sample) return Promise.resolve(null);
    return api('GET', 'api/h/' + l.share.token, null, hsHeaders(l)).then(function (r) {
      state.hsCache[l.share.token] = r.h;
      var changed = false;
      if (l.share.state !== r.h.state) { l.share.state = r.h.state; changed = true; }
      if (r.h.state === 'closed' && !l.back) {
        l.back = dayOf(r.h.steps.closed) || today();
        changed = true;
        toast((l.dir === 'lent' ? 'Your ' : '') + l.item + ' is back home - ' + (l.dir === 'lent' ? l.who + ' brought it back.' : l.who + ' says so.'));
      }
      if (changed) { touch(l); saveLocal(); pushLoan(l); }
      return r.h;
    }).catch(function (e) {
      if (e.status === 404) { l.share = null; touch(l); saveLocal(); pushLoan(l); }
      return null;
    });
  }
  var refreshing = false;
  function refreshShares() {
    if (refreshing) return;
    var list = state.loans.filter(function (l) { return l.share && !l.sample && (!l.back || l.share.state !== 'closed'); }).slice(0, 20);
    if (!list.length) return;
    refreshing = true;
    list.reduce(function (p, l) { return p.then(function () { return readShare(l); }); }, Promise.resolve())
      .then(function () { refreshing = false; if (state.view === 'shelf' && $('#sheet').hidden) draw(); }, function () { refreshing = false; });
  }

  /* ---------------- routing ---------------- */

  function route() {
    if (HS_TOKEN) { state.view = 'hs'; return loadHs(HS_TOKEN); }
    state.view = 'shelf';
    draw();
  }
  function draw() {
    document.body.classList.toggle('is-hs', state.view === 'hs');
    var hasLoans = state.loans.length > 0;
    $('#fab').hidden = !(state.view === 'shelf' && hasLoans);
    $('#topAdd').hidden = !(state.view === 'shelf' && hasLoans);
    if (state.view === 'hs') return drawHs();
    if (!hasLoans) return drawEmpty();
    drawShelf();
  }

  /* ---------------- the first run ---------------- */

  function choice(act, cls, icon, title, sub) {
    return '<button class="choice ' + cls + '" type="button" data-act="' + act + '"><span class="ci" aria-hidden="true">' + icon + '</span><span class="ct"><b>' + title + '</b><span>' + sub + '</span></span><span class="chev" aria-hidden="true">›</span></button>';
  }
  function drawEmpty() {
    main.innerHTML = '<div class="first">' +
      '<section class="hero">' +
      '<div class="arc" aria-hidden="true"><svg viewBox="0 0 260 140"><path class="path" d="M18 112 Q130 -46 242 112"/></svg><span class="thing t1">🏠</span><span class="thing t2">🏡</span><span class="boom">🪃</span></div>' +
      '<h1>Lend it. <em>Get it back.</em></h1>' +
      '<p class="lede">Who has your drill? Boomerang remembers what you lent and borrowed, sends a receipt your friend confirms in one tap, and writes the “can I have it back?” message for you.</p>' +
      '<div class="choices">' +
      choice('sample', 'primary', '🧪', 'Try a sample shelf', 'A drill gone 94 days, a book due tomorrow, Mum’s casserole dish') +
      choice('add-lent', '', '📤', 'I lent something', 'What, who and when - about ten seconds') +
      choice('add-borrowed', '', '📥', 'I borrowed something', 'So it goes back before anyone has to ask') +
      '</div>' +
      '<p class="privacy">Free, and no account. Your shelf stays on this phone - sign in only if you want it on your other phones too.</p>' +
      '</section>' +
      '<section aria-labelledby="howT"><h2 class="how-title" id="howT">How it works</h2><ol class="how">' +
      '<li><span class="n" aria-hidden="true">📝</span><div><b>Jot it down</b><p>“Cordless drill, Sam, back by Nov 1.” The emoji picks itself; a photo stays on your phone.</p></div></li>' +
      '<li><span class="n" aria-hidden="true">🤝</span><div><b>Send them a receipt</b><p>One link. They tap “Got it” - no app, no account - so you both agree who has what.</p></div></li>' +
      '<li><span class="n" aria-hidden="true">💬</span><div><b>Nudge without the awkward</b><p>Slide from Polite to Legal-ish and get a message ready to paste.</p></div></li>' +
      '<li><span class="n" aria-hidden="true">🪃</span><div><b>It came back!</b><p>Tap It’s back for a small celebration - and find out who your most reliable borrower is.</p></div></li>' +
      '</ol></section></div>';
  }

  /* ---------------- the shelf ---------------- */

  function statsHtml() {
    var s = C.stats(state.loans, today());
    var h = '<section class="stats" aria-label="Your shelf in numbers"><div class="count-row">' +
      '<div class="count"><b>' + s.lentOut + '</b><span>lent out</span></div>' +
      '<div class="count"><b>' + s.borrowedOut + '</b><span>borrowed</span></div>' +
      '<div class="count' + (s.overdue ? ' late' : '') + '"><b>' + s.overdue + '</b><span>overdue</span></div></div>';
    if (s.oldest) h += '<div class="holiday"><span class="e" aria-hidden="true">' + esc(s.oldest.emoji) + '</span><p>' + esc(s.oldest.line) + '<small>The longest one out · with ' + esc(s.oldest.who) + '</small></p></div>';
    var r = s.returns;
    h += '<div class="facts">' +
      '<div class="fact"><div class="k">Came back</div>' + (r ? '<div class="v">' + r.back + ' of ' + r.of + ' · ' + r.pct + '%</div><div class="meter" aria-hidden="true"><i style="width:' + r.pct + '%"></i></div>' : '<div class="v">—</div><div class="s">Lend something to start</div>') + '</div>' +
      '<div class="fact"><div class="k">Most reliable</div>' + (s.reliable ? '<div class="v">🏅 ' + esc(s.reliable.who) + '</div><div class="s">' + esc(s.reliable.line) + '</div>' : '<div class="v">—</div><div class="s">Shows once something comes back</div>') + '</div>' +
      '<div class="fact"><div class="k">Your best lender</div>' + (s.bestLender ? '<div class="v">💛 ' + esc(s.bestLender.who) + '</div><div class="s">' + esc(s.bestLender.line) + '</div>' : '<div class="v">—</div><div class="s">Shows once you borrow something</div>') + '</div>' +
      '<div class="fact"><div class="k">On your shelf</div><div class="v">' + plural(state.loans.length, 'thing') + '</div><div class="s">' + (syncOn() ? 'Synced to your account' : 'On this phone') + '</div></div>' +
      '</div></section>';
    return h;
  }
  function receiptChip(l) {
    if (!l.share) return '';
    var v = state.hsCache[l.share.token];
    var st = (v && v.state) || l.share.state;
    var other = l.who;
    var mine = Boolean(l.share.key);
    var text = st === 'sent' ? (mine ? '🤝 Receipt sent' : '🤝 Receipt from ' + other)
      : st === 'confirmed' ? '✓ ' + (mine ? other + ' confirmed it' : 'Confirmed')
        : st === 'returning' ? (l.dir === 'lent' ? '📦 ' + other + ' says it’s on its way' : '📦 You said it’s on its way')
          : '🏠 Receipt closed';
    return '<span class="chip out">' + esc(text) + '</span>';
  }
  function chipClass(st) { return st === 'overdue' ? 'late' : st === 'soon' ? 'soon' : st === 'back' ? 'home' : 'out'; }
  function chipIcon(st) { return st === 'overdue' ? '⏰ ' : st === 'soon' ? '📅 ' : st === 'back' ? '🏠 ' : ''; }
  function loanCard(l) {
    var t = today();
    var st = C.status(l, t);
    var acts = '';
    if (st !== 'back') {
      acts = '<div class="acts">' +
        '<button class="btn small soft" type="button" data-act="nudge" data-id="' + esc(l.id) + '">💬 ' + (l.dir === 'lent' ? 'Nudge' : 'Message') + '</button>' +
        '<button class="btn small ' + (l.dir === 'lent' ? 'home' : 'ghost') + '" type="button" data-act="back" data-id="' + esc(l.id) + '">' + (l.dir === 'lent' ? '🪃 It’s back' : '📦 I gave it back') + '</button></div>';
    }
    var dirChip = state.tab === 'all' ? '<span class="chip dir">' + (l.dir === 'lent' ? '📤 Lent' : '📥 Borrowed') + '</span>' : '';
    var label = l.item + ', ' + (l.dir === 'lent' ? 'lent to ' : 'borrowed from ') + l.who + ', ' + C.dueText(l, t);
    return '<article class="loan' + (st === 'overdue' ? ' is-late' : st === 'back' ? ' is-back' : '') + '">' + tileFor(l) +
      '<button class="loan-open" type="button" data-act="open" data-id="' + esc(l.id) + '" aria-label="' + esc(label) + '">' +
      '<div class="t">' + esc(l.item) + '</div><div class="w">' + esc(C.whoLine(l, t)) + '</div>' +
      '<div class="chips"><span class="chip ' + chipClass(st) + '">' + chipIcon(st) + esc(C.dueText(l, t)) + '</span>' + dirChip + receiptChip(l) + '</div></button>' +
      acts + '</article>';
  }
  function drawShelf() {
    var t = today();
    var g = C.shelf(state.loans, t, state.tab === 'all' ? null : state.tab);
    var n = function (d) { return state.loans.filter(function (l) { return !d || l.dir === d; }).length; };
    var tab = function (id, label, d) { return '<button type="button" role="tab" data-act="tab" data-tab="' + id + '" aria-selected="' + (state.tab === id) + '">' + label + ' <span class="n">' + n(d) + '</span></button>'; };
    var sec = function (cls, icon, title, list, sub) {
      if (!list.length) return '';
      return '<div class="sec ' + cls + '"><h2><span aria-hidden="true">' + icon + '</span>' + title + '</h2><span class="ct">' + (sub || list.length) + '</span></div><div class="loans">' + list.map(loanCard).join('') + '</div>';
    };
    var outTitle = state.tab === 'borrowed' ? 'With you now' : state.tab === 'lent' ? 'Out now' : 'Out and about';
    var body = sec('late', '⏰', 'Overdue', g.overdue) + sec('soon', '📅', 'Due soon', g.soon) + sec('', '📤', outTitle, g.out);
    if (g.back.length) {
      body += '<details class="more"' + (!body || g.back.length <= 4 ? ' open' : '') + '><summary>🏠 Back home <span class="muted">· ' + g.back.length + '</span></summary><div class="loans backlist">' + g.back.map(loanCard).join('') + '</div></details>';
    }
    if (!body) {
      body = '<div class="empty-tab"><p>' + (state.tab === 'borrowed' ? 'Nothing borrowed. Nobody is waiting on you. 😇' : 'Nothing lent out yet.') + '</p><button class="btn small" type="button" data-act="' + (state.tab === 'borrowed' ? 'add-borrowed' : 'add-lent') + '">+ Add one</button></div>';
    }
    var strip = hasSample()
      ? '<div class="strip" role="note"><p><b>🧪 A made-up sample shelf.</b> Tap anything - nudges, receipts, It’s back. Nothing here is saved anywhere.</p><div class="row"><button class="btn small" type="button" data-act="mine">Start my own</button><button class="btn small ghost" type="button" data-act="clearsample">Clear the sample</button></div></div>'
      : '';
    main.innerHTML = strip + '<div class="dk-split dk-split-aside shelf">' +
      '<aside class="shelf-aside">' + statsHtml() + '</aside>' +
      '<div class="shelf-main"><div class="tabs" role="tablist" aria-label="Show">' + tab('all', 'All', null) + tab('lent', 'I lent', 'lent') + tab('borrowed', 'I borrowed', 'borrowed') + '</div>' + body + '</div></div>';
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
    state.nudge = null; state.form = null; state.armed = null;
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  function head(title) { return '<div class="sheet-head"><h2>' + title + '</h2><button class="x" type="button" data-act="closesheet" aria-label="Close">×</button></div>'; }

  /* ---------------- adding and editing ---------------- */

  var DUE_CHOICES = [['none', 'No date'], ['7', '1 week'], ['14', '2 weeks'], ['30', '1 month'], ['date', 'Pick a date']];
  function openForm(dir, id) {
    var l = id ? loanById(id) : null;
    var t = today();
    state.form = l
      ? { id: l.id, dir: l.dir, item: l.item, emoji: l.emoji, emojiTouched: true, who: l.who, on: l.on, dueMode: l.due ? 'date' : 'none', due: l.due || '', note: l.note, photo: state.photos[l.id] || null, photoChanged: false, sample: Boolean(l.sample) }
      : { id: null, dir: dir || 'lent', item: '', emoji: '', emojiTouched: false, who: '', on: t, dueMode: '14', due: C.addDays(t, 14), note: '', photo: null, photoChanged: false, sample: false };
    drawForm();
  }
  function names() {
    var seen = {}, out = [];
    state.loans.forEach(function (l) { var k = C.fold(l.who); if (!seen[k] && out.length < 6) { seen[k] = true; out.push(l.who); } });
    return out;
  }
  function drawForm() {
    var f = state.form;
    var guess = f.emoji || C.suggestEmoji(f.item);
    var who = names();
    sheet(head(f.id ? 'Edit' : (f.dir === 'lent' ? 'I lent something' : 'I borrowed something')) +
      '<form id="loanForm" novalidate>' +
      '<div class="seg" role="group" aria-label="Which way">' +
      '<button type="button" data-act="fdir" data-dir="lent" aria-pressed="' + (f.dir === 'lent') + '">📤 I lent</button>' +
      '<button type="button" data-act="fdir" data-dir="borrowed" aria-pressed="' + (f.dir === 'borrowed') + '">📥 I borrowed</button></div>' +
      '<div class="field"><span id="whatL">What is it?</span><div class="what"><button class="emoji-btn" type="button" id="emojiBtn" data-act="emojis" aria-label="Emoji: ' + esc(guess) + '. Change it">' + esc(guess) + '</button>' +
      '<input class="input" id="fItem" name="item" maxlength="' + C.LIMITS.item + '" autocomplete="off" placeholder="Cordless drill" aria-labelledby="whatL" value="' + esc(f.item) + '"' + (f.id ? '' : ' autofocus') + '></div>' +
      '<div class="picker" id="picker" role="group" aria-label="Pick an emoji">' + C.PICKER.map(function (e) { return '<button type="button" data-act="pick" data-e="' + esc(e) + '" aria-pressed="' + (guess === e) + '">' + esc(e) + '</button>'; }).join('') + '</div></div>' +
      '<label class="field"><span>' + (f.dir === 'lent' ? 'Who has it?' : 'Whose is it?') + '</span><input class="input" id="fWho" name="who" maxlength="' + C.LIMITS.name + '" autocomplete="off" placeholder="Sam" value="' + esc(f.who) + '"></label>' +
      (who.length ? '<div class="pills" role="group" aria-label="Recent names">' + who.map(function (n) { return '<button class="pill" type="button" data-act="fwho" data-who="' + esc(n) + '">' + esc(n) + '</button>'; }).join('') + '</div>' : '') +
      '<div class="two"><label class="field"><span>' + (f.dir === 'lent' ? 'Lent on' : 'Borrowed on') + '</span><input class="input" id="fOn" type="date" max="' + today() + '" value="' + esc(f.on) + '"></label>' +
      '<label class="field" id="dueField"' + (f.dueMode === 'date' ? '' : ' hidden') + '><span>Back by</span><input class="input" id="fDue" type="date" min="' + esc(f.on) + '" value="' + esc(f.due) + '"></label></div>' +
      '<div class="field"><span>Back by</span><div class="pills" role="group" aria-label="Back by">' + DUE_CHOICES.map(function (c) { return '<button class="pill" type="button" data-act="fdue" data-due="' + c[0] + '" aria-pressed="' + (f.dueMode === c[0]) + '">' + c[1] + '</button>'; }).join('') + '</div>' +
      '<p class="small muted" id="dueSay">' + esc(dueSay()) + '</p></div>' +
      '<label class="field"><span>Note <span class="muted">(optional)</span></span><textarea class="input" id="fNote" maxlength="' + C.LIMITS.note + '" placeholder="In the blue case, with the bits">' + esc(f.note) + '</textarea></label>' +
      '<div class="field"><span>Photo <span class="muted">(optional - stays on this phone)</span></span><div class="photo-row" id="photoRow">' + photoRowHtml() + '</div></div>' +
      '<div id="formErr"></div>' +
      '<button class="btn block big" type="submit">' + (f.id ? 'Save' : 'Add to my shelf') + '</button>' +
      (f.id ? '<button class="btn danger block" type="button" data-act="delete" data-id="' + esc(f.id) + '" style="margin-top:10px">Delete</button>' : '') +
      '</form>', bindForm);
  }
  function photoRowHtml() {
    var f = state.form;
    return (f.photo ? '<img src="' + esc(f.photo) + '" alt="The photo you added"><button class="btn small ghost" type="button" data-act="nophoto">Remove</button>' : '') +
      '<span class="btn small ghost filebtn">' + (f.photo ? 'Change' : '📷 Add a photo') + '<input type="file" id="fPhoto" accept="image/*" aria-label="Add a photo"></span>';
  }
  function dueSay() {
    var f = state.form;
    if (f.dueMode === 'none') return 'No date - it’s on the shelf until it comes back.';
    if (!C.isDay(f.due)) return 'Pick the day it should be back.';
    var left = C.daysBetween(today(), f.due);
    return 'Back by ' + fmt(f.due) + (left >= 0 ? ' - ' + (left === 0 ? 'today' : left === 1 ? 'tomorrow' : 'in ' + left + ' days') : ' - that’s already passed');
  }
  function refreshEmoji() {
    var f = state.form;
    var e = f.emojiTouched && f.emoji ? f.emoji : C.suggestEmoji(f.item);
    var b = $('#emojiBtn');
    if (b) { b.textContent = e; b.setAttribute('aria-label', 'Emoji: ' + e + '. Change it'); }
    $$('#picker [data-e]').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-e') === e)); });
  }
  function bindForm(root) {
    var f = state.form;
    $('#fItem', root).addEventListener('input', function (e) { f.item = e.target.value; if (!f.emojiTouched) f.emoji = ''; refreshEmoji(); });
    $('#fWho', root).addEventListener('input', function (e) { f.who = e.target.value; });
    $('#fOn', root).addEventListener('change', function (e) {
      if (C.isDay(e.target.value)) f.on = e.target.value;
      var n = { '7': 7, '14': 14, '30': 30 }[f.dueMode];
      if (n) f.due = C.addDays(f.on, n);
      $('#fDue', root).min = f.on;
      $('#dueSay', root).textContent = dueSay();
    });
    $('#fDue', root).addEventListener('change', function (e) { f.due = e.target.value; $('#dueSay', root).textContent = dueSay(); });
    $('#fNote', root).addEventListener('input', function (e) { f.note = e.target.value; });
    bindPhoto(root);
    $('#loanForm', root).addEventListener('submit', function (e) { e.preventDefault(); saveForm(); });
  }
  function bindPhoto(root) {
    var input = $('#fPhoto', root);
    if (!input) return;
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      shrink(file).then(function (url) { state.form.photo = url; state.form.photoChanged = true; $('#photoRow').innerHTML = photoRowHtml(); bindPhoto($('#sheet')); })
        .catch(function (err) { showError(err, $('#formErr')); });
    });
  }
  function saveForm() {
    var f = state.form;
    var t = today();
    var id = f.id || C.newLoanId(rand);
    var prev = f.id ? loanById(f.id) : null;
    var raw = { id: id, dir: f.dir, item: f.item, emoji: f.emojiTouched ? f.emoji : '', who: f.who, on: f.on, due: f.dueMode === 'none' ? null : f.due, note: f.note, back: prev ? prev.back : null, share: prev ? prev.share : null, photo: Boolean(f.photo), sample: Boolean(prev && prev.sample) };
    var l = C.cleanLoan(raw, t);
    if (!l) return showError({ message: !C.cleanItem(f.item) ? 'Say what it is - “cordless drill” is plenty.' : (f.dir === 'lent' ? 'Say who has it - a first name is fine.' : 'Say whose it is - a first name is fine.') }, $('#formErr'));
    if (!prev && state.loans.filter(function (x) { return !x.sample; }).length >= C.LIMITS.loans) return showError({ message: 'Your shelf is full (' + C.LIMITS.loans + '). Delete a few old ones first.' }, $('#formErr'));
    touch(l);
    if (!prev && hasSample()) { state.loans = state.loans.filter(function (x) { return !x.sample; }); toast('Cleared the sample - this is your shelf now.'); }
    if (f.photoChanged || (!f.photo && prev && prev.photo)) { if (f.photo) photoPut(id, f.photo); else photoDel(id); }
    if (prev) state.loans = state.loans.map(function (x) { return x.id === id ? l : x; });
    else state.loans.unshift(l);
    saveLocal(); pushLoan(l);
    closeSheet(true);
    draw();
    if (!prev) { say('Added ' + l.item); toast(l.emoji + ' ' + l.item + ' is on your shelf.'); }
  }
  function openEmojis() {
    var picker = $('#picker');
    if (picker) picker.scrollIntoView({ block: 'nearest', behavior: REDUCED ? 'auto' : 'smooth' });
    var first = picker && $('button', picker);
    if (first) first.focus();
  }

  /* ---------------- a loan, up close ---------------- */

  function openLoan(id) {
    var l = loanById(id);
    if (!l) return;
    var t = today();
    var st = C.status(l, t);
    var v = l.share ? (state.hsCache[l.share.token] || (l.sample ? sampleView(l) : null)) : null;
    var tl = '<li class="done"><b>' + (l.dir === 'lent' ? 'Lent to ' : 'Borrowed from ') + esc(l.who) + '</b><span>' + esc(fmt(l.on)) + '</span></li>';
    if (v) {
      tl += '<li class="done"><b>Receipt ' + (l.share.key ? 'sent' : 'received') + '</b><span>' + esc(fmt(dayOf(v.steps.sent))) + '</span></li>';
      var other = l.share.key ? l.who : 'You';
      tl += '<li class="' + (v.steps.confirmed ? 'done' : '') + '"><b>' + esc(v.steps.confirmed ? other + ' confirmed it' : 'Waiting for ' + l.who + ' to confirm') + '</b>' + (v.steps.confirmed ? '<span>' + esc(fmt(dayOf(v.steps.confirmed))) + '</span>' : '') + '</li>';
      if (v.steps.returning) tl += '<li class="done"><b>' + esc(v.borrower) + ' said it’s on its way back</b><span>' + esc(fmt(dayOf(v.steps.returning))) + '</span></li>';
    }
    if (l.due) tl += '<li class="' + (st === 'overdue' ? 'late' : '') + '"><b>Back by ' + esc(fmt(l.due)) + '</b><span>' + esc(st === 'back' ? (C.daysBetween(l.back, l.due) >= 0 ? 'Made it in time' : 'Came back late') : C.dueText(l, t)) + '</span></li>';
    tl += l.back ? '<li class="done"><b>Back home 🏠</b><span>' + esc(fmt(l.back)) + ' · after ' + esc(plural(C.daysAway(l, t), 'day')) + '</span></li>' : '<li><b>Back home</b><span>Not yet</span></li>';
    var actions = '';
    if (!l.back) {
      actions += '<button class="btn block big" type="button" data-act="nudge" data-id="' + esc(l.id) + '">💬 ' + (l.dir === 'lent' ? 'Nudge ' : 'Message ') + esc(l.who) + '</button>';
      if (!l.share) actions += '<button class="btn soft block" type="button" data-act="receipt" data-id="' + esc(l.id) + '">🤝 Send ' + esc(l.who) + ' a receipt</button>';
      else actions += '<button class="btn soft block" type="button" data-act="seeit" data-id="' + esc(l.id) + '">👀 See what ' + esc(l.who) + ' sees</button>' +
        (l.share.key && !l.sample ? '<button class="btn ghost block" type="button" data-act="resend" data-id="' + esc(l.id) + '">🔗 Share the receipt link again</button>' : '');
      actions += '<button class="btn ' + (l.dir === 'lent' ? 'home' : 'ghost') + ' block" type="button" data-act="back" data-id="' + esc(l.id) + '">' + (l.dir === 'lent' ? '🪃 It’s back' : '📦 I gave it back') + '</button>';
    } else {
      actions += '<button class="btn ghost block" type="button" data-act="unback" data-id="' + esc(l.id) + '">↩︎ Not back after all</button>';
    }
    actions += '<div class="row"><button class="btn ghost" type="button" data-act="edit" data-id="' + esc(l.id) + '" style="flex:1">✏️ Edit</button>' +
      (l.share && l.share.key && !l.sample ? '<button class="btn ghost" type="button" data-act="revoke" data-id="' + esc(l.id) + '" style="flex:1">Take the link back</button>' : '') +
      '<button class="btn danger" type="button" data-act="delete" data-id="' + esc(l.id) + '" style="flex:1">Delete</button></div>';
    sheet(head(l.dir === 'lent' ? 'You lent it' : 'You borrowed it') +
      '<div class="detail-top">' + tileFor(l).replace('class="tile"', 'class="tile big"') + '<div><h2>' + esc(l.item) + '</h2><div class="muted">' + esc(C.whoLine(l, t)) + '</div><div class="chips"><span class="chip ' + chipClass(st) + '">' + chipIcon(st) + esc(C.dueText(l, t)) + '</span>' + receiptChip(l) + '</div></div></div>' +
      (l.note ? '<div class="note-box"><span class="eyebrow">Note</span><p style="margin:0">' + esc(l.note) + '</p></div>' : '') +
      '<ol class="timeline">' + tl + '</ol><div class="stack">' + actions + '</div>' +
      (l.sample ? '<p class="small muted center" style="margin-top:12px">A sample loan - nothing here is saved anywhere.</p>' : ''));
    if (l.share && !l.sample && !state.hsCache[l.share.token]) readShare(l).then(function (r) { if (r && !$('#sheet').hidden && loanById(id)) openLoan(id); });
  }

  /* ---------------- marking it back ---------------- */

  function markBack(id) {
    var l = loanById(id);
    if (!l || l.back) return;
    var t = today();
    var days = C.daysAway(l, t);
    l.back = t;
    touch(l);
    var share0 = l.share;
    saveLocal(); pushLoan(l);
    closeSheet(true);
    draw();
    if (share0 && !l.sample) {
      // Tell the receipt too: the lender closes it, the borrower says it's on its way.
      var step = l.dir === 'lent' ? 'back' : (share0.state === 'confirmed' ? 'gave' : null);
      if (step) api('POST', 'api/h/' + share0.token + '/step', { step: step }, hsHeaders(l)).then(function (r) { state.hsCache[share0.token] = r.h; share0.state = r.h.state; saveLocal(); pushLoan(l); }).catch(function () { /* the shelf is right either way */ });
    }
    if (l.dir === 'lent') celebrate('🪃', 'It came back!', 'Your ' + C.itemPhrase(l.item) + ' is home' + (days ? ' after ' + plural(days, 'day') : '') + '. Thanks, ' + l.who + '.');
    else celebrate('📦', 'Returned!', l.who + '’s ' + C.itemPhrase(l.item) + ' is going home. Good borrower energy.');
  }
  function unBack(id) {
    var l = loanById(id);
    if (!l) return;
    l.back = null; touch(l); saveLocal(); pushLoan(l); closeSheet(true); draw(); toast('Back on the shelf as still out.');
  }
  function celebrate(icon, title, sub) {
    say(title + ' ' + sub);
    if (navigator.vibrate) try { navigator.vibrate([12, 50, 12]); } catch (e) { /* ignore */ }
    if (REDUCED) { toast(icon + ' ' + title + ' ' + sub, 4200); return; }
    var c = document.createElement('div');
    c.className = 'celebrate';
    c.setAttribute('aria-hidden', 'true');
    c.innerHTML = '<div class="card"><span class="big">' + esc(icon) + '</span><b>' + esc(title) + '</b><span>' + esc(sub) + '</span></div>';
    document.body.appendChild(c);
    var box = $('#confetti');
    var bits = '';
    for (var i = 0; i < 36; i++) {
      var left = (i * 37) % 100, delay = (i % 9) * 0.06, col = CONFETTI[i % CONFETTI.length];
      bits += '<i style="left:' + left + 'vw;background:' + col + ';animation-delay:' + delay.toFixed(2) + 's"></i>';
    }
    box.innerHTML = bits;
    setTimeout(function () { c.remove(); box.innerHTML = ''; }, 2600);
  }

  /* ---------------- receipts (handshakes) ---------------- */

  /** A sample loan's receipt, worked out on this phone (nothing is made). */
  function sampleView(l) {
    var at = function (day) { return day + 'T12:00:00.000Z'; };
    var h = {
      item: l.item, emoji: l.emoji, dir: l.dir, lender: l.dir === 'lent' ? 'You' : l.who, borrower: l.dir === 'lent' ? l.who : 'You',
      on: l.on, due: l.due, note: l.note, state: (l.share && l.share.state) || 'sent',
      steps: { sent: at(l.on), confirmed: l.share && l.share.state !== 'sent' ? at(C.addDays(l.on, 1)) : null, returning: l.share && /returning|closed/.test(l.share.state) ? at(today()) : null, closed: l.share && l.share.state === 'closed' ? at(today()) : null },
      expiresAt: at(C.addDays(today(), 365)),
    };
    return C.handshakeView(h, 'owner');
  }
  function openReceipt(id) {
    var l = loanById(id);
    if (!l) return;
    if (l.sample) {
      l.share = { token: 'SAMPLEx' + l.id.slice(0, 15).padEnd(15, 'x'), key: 'SAMPLExSAMPLExSAMPLE02', state: 'sent' };
      saveLocal();
      return sheet(head('Send ' + esc(l.who) + ' a receipt') +
        '<p>On a real loan this makes a link you send to ' + esc(l.who) + '. They open it with no app and no account, tap <b>Got it</b>, and later <b>I’ve given it back</b> - and you tap <b>It’s back</b>.</p>' +
        '<p class="small muted">This one is a sample, so no link was made. Have a look at what ' + esc(l.who) + ' would see - you can tap through their side too.</p>' +
        '<div class="stack"><button class="btn block big" type="button" data-act="preview" data-id="' + esc(l.id) + '">👀 See it as ' + esc(l.who) + '</button></div>');
    }
    if (!myName()) return askName(id);
    makeReceipt(id);
  }
  function askName(id) {
    sheet(head('Your first name') +
      '<p class="muted">So ' + esc(loanById(id).who) + ' knows who the receipt is from. It goes on the link - nothing else about you does.</p>' +
      '<form id="nameForm"><label class="field"><span>First name or nickname</span><input class="input" id="myName" maxlength="' + C.LIMITS.name + '" autocomplete="given-name" autofocus></label><div id="nameErr"></div>' +
      '<button class="btn block big" type="submit">Make the receipt</button></form>', function (root) {
      $('#nameForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var n = C.cleanName($('#myName', root).value);
        if (!n) return showError({ message: 'Add a first name - that’s all it needs.' }, $('#nameErr', root));
        keep(K_NAME, n);
        makeReceipt(id);
      });
    });
  }
  function makeReceipt(id) {
    var l = loanById(id);
    sheet(head('Making the receipt…') + '<p class="muted">One moment.</p>');
    api('POST', 'api/h', { item: l.item, emoji: l.emoji, who: l.who, me: myName(), dir: l.dir, on: l.on, due: l.due, note: l.note, today: today() }).then(function (r) {
      l.share = { token: r.token, key: r.key, state: r.h.state };
      state.hsCache[r.token] = r.h;
      touch(l); saveLocal(); pushLoan(l);
      draw();
      receiptReady(l);
    }).catch(function (e) { sheet(head('Couldn’t make it') + '<p class="err" role="alert">' + esc(e.message) + '</p><button class="btn ghost block" type="button" data-act="closesheet">Close</button>'); });
  }
  function receiptText(l) {
    return l.dir === 'lent'
      ? 'Here’s a little receipt for my ' + C.itemPhrase(l.item) + ' ' + l.emoji + ' - tap “Got it” so neither of us forgets:'
      : 'I’ve got your ' + C.itemPhrase(l.item) + ' ' + l.emoji + ' - here’s a receipt so I remember to bring it back:';
  }
  function receiptReady(l) {
    var link = receiptLink(l.share.token);
    sheet(head('Receipt ready 🤝') +
      '<p>Send this to ' + esc(l.who) + '. They open it with no app and no account and tap <b>Got it</b>.</p>' +
      '<div class="linkbox"><code>' + esc(link) + '</code><button class="btn small ghost" type="button" data-act="copylink" data-id="' + esc(l.id) + '">Copy</button></div>' +
      '<div class="stack"><button class="btn block big" type="button" data-act="sharelink" data-id="' + esc(l.id) + '">Send it to ' + esc(l.who) + '</button>' +
      '<button class="btn ghost block" type="button" data-act="seeit" data-id="' + esc(l.id) + '">👀 See what ' + esc(l.who) + ' sees</button></div>' +
      '<p class="small muted" style="margin-top:12px">The link shows only the item, your two first names, the dates' + (l.note ? ', your note' : '') + ' and where it’s up to. Anyone with the link can see it, so send it only to ' + esc(l.who) + '. You can take it back any time.</p>');
  }
  function revoke(id) {
    var l = loanById(id);
    if (!l || !l.share) return;
    if (state.armed !== 'revoke:' + id) {
      state.armed = 'revoke:' + id;
      var b = $('[data-act="revoke"][data-id="' + id + '"]');
      if (b) b.textContent = 'Tap again: the link stops working';
      return;
    }
    var tok = l.share.token;
    api('DELETE', 'api/h/' + tok, null, hsHeaders(l)).catch(function (e) { if (e.status !== 404) throw e; }).then(function () {
      delete state.hsCache[tok];
      l.share = null; touch(l); saveLocal(); pushLoan(l); closeSheet(true); draw(); toast('Link taken back. It no longer opens.');
    }).catch(function (e) { toast(e.message); });
  }

  /* ---------------- the receipt page ---------------- */

  function ownerLoanFor(token) {
    for (var i = 0; i < state.loans.length; i++) { var l = state.loans[i]; if (l.share && l.share.token === token) return l; }
    return null;
  }
  function loadHs(token) {
    state.hs = { token: token, v: null, preview: false, err: null };
    main.innerHTML = '<div class="hs"><div class="hs-card"><p class="muted">Opening the receipt…</p></div></div>';
    draw();
    var l = ownerLoanFor(token);
    var headers = l && l.share.key && !AS_FRIEND ? hsHeaders(l) : null;
    api('GET', 'api/h/' + token, null, headers).then(function (r) { state.hs.v = r.h; draw(); })
      .catch(function (e) { state.hs.err = e; draw(); });
  }
  function openPreview(id) {
    var l = loanById(id);
    if (!l) return;
    if (!l.share) l.share = { token: 'SAMPLEx' + l.id.slice(0, 15).padEnd(15, 'x'), key: 'SAMPLExSAMPLExSAMPLE02', state: 'sent' };
    var v = sampleView(l);
    var friend = C.handshakeView({ item: v.item, emoji: v.emoji, dir: l.dir, lender: l.dir === 'lent' ? (myName() || 'Charlie') : l.who, borrower: l.dir === 'lent' ? l.who : (myName() || 'Charlie'), on: v.on, due: v.due, note: v.note, state: v.state, steps: v.steps, expiresAt: v.expiresAt }, 'friend');
    state.view = 'hs';
    state.hs = { token: null, v: friend, preview: true, loanId: id, err: null };
    closeSheet(true);
    draw();
    scrollTo(0, 0);
  }
  function trackHtml(v) {
    var steps = [
      ['sent', '✓', 'Lent'],
      ['confirmed', '2', v.you === 'lender' ? 'Confirmed' : 'Got it'],
      ['returning', '3', 'Given back'],
      ['closed', '🏠', 'Back home'],
    ];
    var nowI = { sent: 1, confirmed: 2, returning: 3 }[v.state];
    if (nowI === undefined) nowI = -1;
    return '<ol class="track" aria-label="Where it’s up to">' + steps.map(function (s, i) {
      var done = Boolean(v.steps[s[0]]);
      var cls = done ? 'done' : (i === nowI ? 'now' : '');
      return '<li class="' + cls + '"><span class="dot" aria-hidden="true">' + (done && i > 0 && i < 3 ? '✓' : s[1]) + '</span><b>' + esc(s[2]) + '</b>' +
        (v.steps[s[0]] ? '<time datetime="' + esc(v.steps[s[0]]) + '">' + esc(fmt(dayOf(v.steps[s[0]]))) + '</time>' : '<span class="vh">not yet</span>') + '</li>';
    }).join('') + '</ol>';
  }
  function hsStatus(v) {
    var other = v.you === 'borrower' ? v.lender : v.borrower;
    var it = C.itemPhrase(v.item);
    if (v.state === 'closed') return v.you === 'borrower' ? '🪃 Back home with ' + v.lender + '. Thanks for bringing it back!' : '🪃 It’s back home. All square.';
    if (v.role === 'owner') {
      if (v.state === 'sent') return 'Sent. Waiting for ' + other + ' to tap “Got it”.';
      if (v.state === 'confirmed') return other + ' confirmed ' + (v.you === 'lender' ? 'they have it' : 'it’s right') + '.';
      return v.you === 'lender' ? other + ' says it’s on its way back. Is it home?' : 'You said you’ve given it back. Waiting for ' + other + '.';
    }
    if (v.you === 'borrower') {
      if (v.state === 'sent') return 'Has the ' + it + ' reached you? Tap Got it so you both know.';
      if (v.state === 'confirmed') return 'It’s with you. When you’ve given it back, tap below - ' + v.lender + ' taps It’s back to close it.';
      return 'You said you’ve given it back. Waiting for ' + v.lender + ' to tap It’s back.';
    }
    if (v.state === 'sent') return 'Is this right, ' + v.lender + '? Tap That’s right so you both have the same record.';
    if (v.state === 'confirmed') return 'Tap It’s back when your ' + it + ' is home.';
    return v.borrower + ' says it’s on its way back. Is it home?';
  }
  var STEP_LABEL = { confirm: '👍 Got it', gave: '📦 I’ve given it back', back: '🪃 It’s back' };
  function drawHs() {
    var hs = state.hs;
    if (!hs) return;
    if (hs.err) {
      main.innerHTML = '<div class="hs"><article class="hs-card"><div class="hs-emoji" aria-hidden="true">🪃</div><h1 class="hs-item">' + (hs.err.status === 404 ? 'Nothing to see here' : 'Couldn’t open it') + '</h1><p class="muted">' + (hs.err.status === 404 ? 'This receipt was taken back by whoever sent it, or it expired. Ask them for a fresh link if you still need one.' : esc(hs.err.message)) + '</p></article>' + ctaHtml(null) + '</div>';
      return;
    }
    var v = hs.v;
    if (!v) return;
    var t = today();
    var who = v.role === 'friend'
      ? (v.you === 'borrower' ? esc(v.lender) + ' lent you' : esc(v.borrower) + ' borrowed your')
      : (v.you === 'lender' ? 'You lent ' + esc(v.borrower) : 'You borrowed from ' + esc(v.lender));
    var noteBy = v.role === 'friend' ? (v.you === 'borrower' ? v.lender : v.borrower) : 'Your';
    var acts = v.can.map(function (s) {
      var label = s === 'confirm' && v.you === 'lender' ? '👍 That’s right' : STEP_LABEL[s];
      var cls = s === 'back' ? 'home' : s === 'gave' && v.can.length > 1 ? 'ghost' : '';
      return '<button class="btn block big ' + cls + '" type="button" data-act="step" data-step="' + s + '">' + label + '</button>';
    }).join('');
    var late = v.due && v.state !== 'closed' && C.daysBetween(t, v.due) < 0;
    main.innerHTML = '<div class="hs">' +
      (hs.preview ? '<div class="center"><span class="preview-flag">Sample · what a friend sees</span></div>' : '') +
      '<article class="hs-card" aria-labelledby="hsItem">' +
      '<div class="hs-emoji" aria-hidden="true">' + esc(v.emoji) + '</div>' +
      '<p class="hs-who">' + who + '</p>' +
      '<h1 class="hs-item" id="hsItem">' + esc(v.item) + '</h1>' +
      '<p class="hs-when">on <b>' + esc(fmt(v.on)) + '</b>' + (v.due ? ' · back by <b>' + esc(fmt(v.due)) + '</b>' + (late ? ' <span class="chip late">' + esc(plural(-C.daysBetween(t, v.due), 'day')) + ' late</span>' : '') : '') + '</p>' +
      (v.note ? '<p class="hs-note"><small>' + esc(noteBy === 'Your' ? 'Your note' : noteBy + '’s note') + '</small>' + esc(v.note) + '</p>' : '') +
      trackHtml(v) +
      '<p class="hs-status" id="hsStatus">' + esc(hsStatus(v)) + '</p>' +
      '<div class="stack">' + acts + '</div>' +
      (v.role === 'owner' && hs.token ? '<div class="stack"><button class="btn ghost block" type="button" data-act="hsshare">🔗 Share the link again</button></div>' : '') +
      '<div id="hsErr"></div>' +
      '</article>' +
      '<p class="hs-foot">' + (v.role === 'friend'
        ? 'This receipt shows only what ' + esc(noteBy) + ' typed - the item, two first names, the dates' + (v.note ? ' and a note' : '') + '. No account, no app, nothing else about you.'
        : 'Anyone with this link sees just this card. It closes itself 30 days after it’s back, or after a year.') + '</p>' +
      ctaHtml(v) + '</div>';
  }
  function ctaHtml(v) {
    if (state.hs && state.hs.preview) {
      var yours = v && v.state === 'returning' && v.you === 'borrower';
      return '<div class="hs-cta"><b>' + (yours ? 'Now it’s your turn.' : 'That’s the friend’s side.') + '</b><p class="small muted">' + (yours ? 'On your phone you’d tap It’s back to close the loop.' : 'Tap their buttons above to see each step, then head back.') + '</p>' +
        (yours ? '<button class="btn home block" type="button" data-act="previewback">🪃 It’s back</button><div style="height:8px"></div>' : '') +
        '<button class="btn ghost block" type="button" data-act="home">← Back to the sample shelf</button></div>';
    }
    var saved = v && state.hs.token && ownerLoanFor(state.hs.token);
    var canSave = v && v.role === 'friend' && !saved && v.state !== 'closed';
    return '<div class="hs-cta">' +
      (canSave ? '<b>Keep track of it yourself</b><p class="small muted">Add this to your own Boomerang shelf - free, no account, it stays on this phone.</p><button class="btn block" type="button" data-act="hssave">+ Add it to my shelf</button>' :
        saved ? '<b>It’s on your shelf</b><p class="small muted">Open Boomerang to see everything you’ve lent and borrowed.</p><a class="btn ghost block" href="./">Open my shelf</a>' :
          '<b>Lend things too?</b><p class="small muted">Keep a shelf of what’s out and who has it - free, no account.</p><a class="btn ghost block" href="./">Open Boomerang</a>') + '</div>';
  }
  function hsStep(what) {
    var hs = state.hs;
    if (hs.preview) {
      // The sample: the friend's side, worked out on this phone.
      var l = loanById(hs.loanId);
      var v = hs.v;
      var now = Date.now();
      var h = { item: v.item, emoji: v.emoji, dir: l ? l.dir : 'lent', lender: v.lender, borrower: v.borrower, on: v.on, due: v.due, note: v.note, state: v.state, steps: v.steps, createdAt: v.steps.sent, expiresAt: v.expiresAt };
      try {
        var p = C.step(h, 'friend', what, now);
        hs.v = C.handshakeView(Object.assign(h, p), 'friend');
        if (l && l.share) { l.share.state = hs.v.state; saveLocal(); }
        draw();
        if (what === 'back') celebrate('🪃', 'It’s back!', 'That’s the whole loop. Nice.');
        else say(hsStatus(hs.v));
      } catch (e) { showError(e, $('#hsErr')); }
      return;
    }
    var mine = ownerLoanFor(hs.token);
    var headers = mine && mine.share.key && !AS_FRIEND ? hsHeaders(mine) : null;
    $$('[data-act="step"]').forEach(function (b) { b.disabled = true; });
    api('POST', 'api/h/' + hs.token + '/step', { step: what }, headers).then(function (r) {
      hs.v = r.h;
      if (mine) { mine.share.state = r.h.state; if (r.h.state === 'closed' && !mine.back) mine.back = today(); touch(mine); saveLocal(); pushLoan(mine); }
      draw();
      if (what === 'back') celebrate('🪃', 'It’s back!', 'Back home. All square.');
      else if (what === 'gave') celebrate('📦', 'On its way!', 'Thanks for bringing it back.');
      else say(hsStatus(r.h));
    }).catch(function (e) { $$('[data-act="step"]').forEach(function (b) { b.disabled = false; }); showError(e, $('#hsErr')); });
  }
  function hsSave() {
    var v = state.hs.v;
    if (!v) return;
    var dir = v.you === 'borrower' ? 'borrowed' : 'lent';
    var l = C.cleanLoan({ id: C.newLoanId(rand), dir: dir, item: v.item, emoji: v.emoji, who: v.you === 'borrower' ? v.lender : v.borrower, on: v.on, due: v.due, note: v.note, share: { token: state.hs.token, state: v.state } }, today());
    if (!l) return;
    touch(l);
    state.loans = state.loans.filter(function (x) { return !x.sample; });
    state.loans.unshift(l);
    saveLocal(); pushLoan(l);
    draw();
    toast(l.emoji + ' Added to your shelf.');
  }

  /* ---------------- nudges ---------------- */

  function openNudge(id) {
    var l = loanById(id);
    if (!l) return;
    var tone = state.nudge && state.nudge.id === id ? state.nudge.tone : (C.status(l, today()) === 'overdue' ? 'cheeky' : 'friendly');
    state.nudge = { id: id, tone: tone, variant: C.firstVariant(l, tone), link: Boolean(l.share), ai: null, chosen: null, hint: '' };
    drawNudge();
  }
  function nudgeText() {
    var n = state.nudge, l = loanById(n.id);
    var link = n.link && l.share ? (l.sample ? '(your receipt link goes here)' : receiptLink(l.share.token)) : null;
    if (n.chosen !== null && n.ai && n.ai.options[n.chosen]) return n.ai.options[n.chosen].text + (link ? '\n\nOur Boomerang receipt: ' + link : '');
    return C.nudge(l, n.tone, n.variant, today(), link);
  }
  function drawNudge() {
    var n = state.nudge, l = loanById(n.id);
    var t = today();
    var stops = C.TONES.map(function (tn) {
      return '<button class="stop" type="button" role="radio" aria-checked="' + (n.tone === tn.id) + '" data-act="tone" data-tone="' + tn.id + '"><span class="knob" aria-hidden="true">' + tn.emoji + '</span>' + tn.label + '</button>';
    }).join('');
    sheet(head((l.dir === 'lent' ? 'Nudge ' : 'Message ') + esc(l.who)) +
      '<p class="small muted" style="margin-top:-2px">' + esc(l.emoji + ' ' + l.item) + ' · ' + esc(C.dueText(l, t)) + '</p>' +
      '<div class="dial"><div class="dial-track" aria-hidden="true"></div><div class="dial-stops" role="radiogroup" aria-label="Tone">' + stops + '</div></div>' +
      '<div class="chat"><div class="to">To ' + esc(l.who) + '</div><div class="bubble-me" id="msg" aria-live="polite">' + esc(nudgeText()) + '</div></div>' +
      '<div class="row" style="margin-top:10px">' +
      '<button class="btn small ghost" type="button" data-act="another">↻ Another one</button>' +
      (l.share ? '<button class="pill" type="button" data-act="togglelink" aria-pressed="' + n.link + '">🔗 Receipt link</button>' : (l.back ? '' : '<button class="btn small ghost" type="button" data-act="receipt" data-id="' + esc(l.id) + '">🤝 Add a receipt link</button>')) +
      '</div>' +
      '<div class="two" style="margin-top:12px"><button class="btn big" type="button" data-act="sendnudge">Send…</button><button class="btn big ghost" type="button" data-act="copynudge">Copy</button></div>' +
      '<p class="small muted" style="margin-top:8px">Boomerang never sends anything itself - this opens your phone’s share sheet.</p>' +
      '<div class="ai-box"><b>✨ Write it for me</b><p class="small muted" style="margin:2px 0 8px">Three fresh ones in this tone. Make it about… <span class="vh">(optional)</span></p>' +
      '<div class="row"><input class="input" id="hint" maxlength="' + C.LIMITS.hint + '" placeholder="their birthday, the football" value="' + esc(n.hint) + '" aria-label="Make it about (optional)"><button class="btn" type="button" data-act="aiwrite">Write</button></div>' +
      '<div id="aiOut">' + aiOutHtml() + '</div></div>', function (root) {
      $('#hint', root).addEventListener('input', function (e) { n.hint = e.target.value; });
      $('#hint', root).addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); aiWrite(); } });
    });
  }
  function aiOutHtml() {
    var n = state.nudge;
    if (!n.ai) return '';
    if (n.ai.busy) return '<p class="small muted" role="status">Writing three…</p>';
    if (n.ai.signin) return '<div class="note"><p style="margin:0 0 8px">Writing it for you uses AI, so it needs a free account - it comes with $2 of AI credit. The ready-made messages above are free and always will be.</p><div class="row"><button class="btn small" type="button" data-act="signup">Create a free account</button><button class="btn small ghost" type="button" data-act="signin">Sign in</button></div></div>';
    if (!n.ai.options || !n.ai.options.length) return '';
    return '<div class="opts" role="group" aria-label="Written for you">' + n.ai.options.map(function (o, i) {
      return '<button class="opt" type="button" data-act="pickai" data-i="' + i + '" aria-pressed="' + (n.chosen === i) + '">' + esc(o.text) + '</button>';
    }).join('') + '</div><p class="small muted" style="margin-top:6px">Tap one to use it. Check it before you send.</p>';
  }
  function refreshNudge() {
    var m = $('#msg');
    if (m) m.textContent = nudgeText();
    $$('.stop').forEach(function (s) { s.setAttribute('aria-checked', String(s.getAttribute('data-tone') === state.nudge.tone)); });
    var out = $('#aiOut');
    if (out) out.innerHTML = aiOutHtml();
  }
  function aiWrite() {
    var n = state.nudge, l = loanById(n.id);
    if (!signedIn()) { n.ai = { signin: true }; return refreshNudge(); }
    n.ai = { busy: true }; refreshNudge();
    api('POST', 'api/write', { loan: { item: l.item, who: l.who, dir: l.dir, on: l.on, due: l.due }, tone: n.tone, hint: n.hint, today: today() }).then(function (r) {
      if (state.nudge !== n) return;
      n.ai = { options: r.options }; n.chosen = 0; refreshNudge();
    }).catch(function (e) {
      if (state.nudge !== n) return;
      n.ai = null; refreshNudge();
      if (e.status === 401) { n.ai = { signin: true }; return refreshNudge(); }
      if (e.status === 402) return openCredit(e.data);
      if (e.data && e.data.code === 'verify-email') return verifyNote($('#aiOut'), e);
      showError(e, $('#aiOut'));
    });
  }

  /* ---------------- the account ---------------- */

  var FREE_LINE = 'Boomerang works without an account. A free account keeps your shelf on all your phones (photos stay where you took them) and unlocks “Write it for me”, with $2 of AI credit. One account works across every app on this site.';
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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); syncIn(true); if (then) then(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { syncIn(true); if (then) then(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(head('Account') + '<p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><b>Your shelf</b><p class="small muted" style="margin:4px 0 0">' + (syncOn() ? 'Kept in your account, so it follows you to any phone you sign in on. Photos stay on the phone that took them.' : 'Syncing isn’t available right now - your shelf is safe on this phone.') + '</p></div>' +
      '<div class="note"><div class="row" style="justify-content:space-between"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">“Write it for me” costs about a cent. The shelf, receipts and ready-made nudges are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>' +
      '<p class="small muted" style="margin-top:8px">Signing out keeps this phone’s copy of your shelf.</p>',
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
    sheet(head('Out of AI credit') + '<p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The shelf, receipts and the ready-made nudges keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });

  /* ---------------- one click listener ---------------- */

  function goHome() {
    if (HS_TOKEN) { location.href = BASE; return; }
    state.view = 'shelf'; state.hs = null; draw(); scrollTo(0, 0);
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var a = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    var f = state.form, n = state.nudge;
    if (a !== 'delete' && a !== 'revoke') state.armed = null;
    switch (a) {
      case 'home': if (t.tagName === 'A' && !HS_TOKEN) { e.preventDefault(); goHome(); } else if (t.tagName !== 'A') goHome(); break;
      case 'closesheet': closeSheet(); break;
      case 'sample':
        state.loans = C.sample(today()).concat(state.loans.filter(function (l) { return !l.sample; }));
        saveLocal(); draw(); scrollTo(0, 0);
        toast('🧪 A made-up shelf to play with. Nothing is saved anywhere.');
        break;
      case 'clearsample':
        state.loans = state.loans.filter(function (l) { return !l.sample; });
        saveLocal(); draw(); scrollTo(0, 0); toast('Sample cleared.');
        break;
      case 'mine':
        state.loans = state.loans.filter(function (l) { return !l.sample; });
        saveLocal(); draw(); openForm('lent');
        break;
      case 'add': openForm(state.tab === 'borrowed' ? 'borrowed' : 'lent'); break;
      case 'add-lent': openForm('lent'); break;
      case 'add-borrowed': openForm('borrowed'); break;
      case 'tab': state.tab = t.getAttribute('data-tab'); keep(K_TAB, state.tab); draw(); break;
      case 'open': openLoan(id); break;
      case 'edit': openForm(null, id); break;
      case 'delete': {
        if (state.armed !== 'delete:' + id) { state.armed = 'delete:' + id; t.textContent = 'Tap again to delete'; break; }
        var gone = loanById(id);
        state.loans = state.loans.filter(function (l) { return l.id !== id; });
        if (gone && gone.photo) photoDel(id);
        if (gone && gone.share && gone.share.key && !gone.sample) api('DELETE', 'api/h/' + gone.share.token, null, hsHeaders(gone)).catch(function () { /* already gone */ });
        saveLocal(); dropLoan(id); closeSheet(true); draw(); toast('Deleted.');
        break;
      }
      case 'fdir': f.dir = t.getAttribute('data-dir'); drawForm(); break;
      case 'emojis': openEmojis(); break;
      case 'pick': f.emoji = t.getAttribute('data-e'); f.emojiTouched = true; refreshEmoji(); break;
      case 'fwho': f.who = t.getAttribute('data-who'); $('#fWho').value = f.who; break;
      case 'fdue': {
        f.dueMode = t.getAttribute('data-due');
        var nDays = { '7': 7, '14': 14, '30': 30 }[f.dueMode];
        if (nDays) f.due = C.addDays(f.on, nDays);
        if (f.dueMode === 'date' && !C.isDay(f.due)) f.due = C.addDays(f.on, 14);
        $('#dueField').hidden = f.dueMode !== 'date';
        $('#fDue').value = f.due || '';
        $$('[data-act="fdue"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); });
        $('#dueSay').textContent = dueSay();
        break;
      }
      case 'nophoto': f.photo = null; f.photoChanged = true; $('#photoRow').innerHTML = photoRowHtml(); bindPhoto($('#sheet')); break;
      case 'back': markBack(id); break;
      case 'unback': unBack(id); break;
      case 'nudge': openNudge(id); break;
      case 'tone': n.tone = t.getAttribute('data-tone'); n.variant = C.firstVariant(loanById(n.id), n.tone); n.chosen = null; n.ai = null; refreshNudge(); break;
      case 'another': n.variant = (n.variant + 1) % C.nudgeCount(loanById(n.id).dir, n.tone); n.chosen = null; refreshNudge(); break;
      case 'togglelink': n.link = !n.link; t.setAttribute('aria-pressed', String(n.link)); refreshNudge(); break;
      case 'sendnudge': share('Boomerang', nudgeText()); break;
      case 'copynudge': copy(nudgeText(), 'Copied - paste it in your chat'); break;
      case 'aiwrite': aiWrite(); break;
      case 'pickai': n.chosen = Number(t.getAttribute('data-i')); refreshNudge(); break;
      case 'signup': { var back1 = n && n.id; openAccount(null, function () { if (back1) openNudge(back1); }); break; }
      case 'signin': { var back2 = n && n.id; openAccount(null, function () { if (back2) openNudge(back2); }, true); break; }
      case 'receipt': openReceipt(id); break;
      case 'resend': receiptReady(loanById(id)); break;
      case 'copylink': copy(receiptLink(loanById(id).share.token), 'Link copied'); break;
      case 'sharelink': { var sl = loanById(id); share('A Boomerang receipt', receiptText(sl), receiptLink(sl.share.token)); break; }
      case 'seeit': {
        var se = loanById(id);
        if (se.sample) openPreview(id);
        else location.href = BASE + 'h/' + se.share.token + (se.share.key ? '?as=friend' : '');
        break;
      }
      case 'preview': openPreview(id); break;
      case 'revoke': revoke(id); break;
      case 'step': hsStep(t.getAttribute('data-step')); break;
      case 'hsshare': { var ol = ownerLoanFor(state.hs.token); if (ol) share('A Boomerang receipt', receiptText(ol), receiptLink(ol.share.token)); break; }
      case 'hssave': hsSave(); break;
      case 'previewback': { var pl = state.hs && state.hs.loanId; state.view = 'shelf'; state.hs = null; if (pl) { var pv = loanById(pl); if (pv && pv.share) pv.share.state = 'closed'; markBack(pl); } else draw(); scrollTo(0, 0); break; }
      default: break;
    }
  });

  /* ---------------- start ---------------- */

  loadLocal();
  route();
  loadPhotos();
  loadMe().then(function () { if (syncOn() && !HS_TOKEN) return syncIn(false); return null; }).then(function () { if (!HS_TOKEN) refreshShares(); });
  // Two phones, one receipt: look again when the app comes back to the
  // foreground, and redraw if the day turned while it was away.
  var lastDay = today();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (state.view === 'hs' && state.hs && state.hs.token && !state.hs.preview) return loadHs(state.hs.token);
    if (today() !== lastDay) { lastDay = today(); if ($('#sheet').hidden) draw(); }
    refreshShares();
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* no offline copy, still works online */ });
  }
}());
