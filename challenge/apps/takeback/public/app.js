/* Takeback - the page. One file, no build step.
 *
 * EVERYTHING STAYS ON THIS DEVICE unless the person turns sync on: the
 * purchases, store notes and settings in localStorage, receipt and drop-off
 * photos in IndexedDB (shrunk through a canvas first, which drops their
 * EXIF, location included), the countdowns, the tally, the reminders (.ics)
 * and the recap image worked out here by TakebackCore. Every storage access
 * is wrapped in try/catch, and the page works - in memory - when storage is
 * unavailable.
 *
 * The requests this page makes: sign-in; sync of the LIST (never a photo),
 * only when the person turns it on in Settings; and the optional receipt
 * reader, whose payload (the one image) is shown before it is sent.
 *
 * Every string a person typed, a file held, the server answered or a model
 * wrote is escaped before it is drawn, and no handler is written into
 * markup: clicks are routed by data-act attributes from one listener (the
 * lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.TakebackCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  // A tag the browser reports but Intl refuses ("en-US@posix" in some
  // headless browsers) would make every date and amount throw: fall back.
  var LOCALE = (function () { try { return Intl.getCanonicalLocales(navigator.language || 'en-US')[0] || 'en-US'; } catch (e) { return 'en-US'; } }());
  var K_DATA = 'takeback-data-v1', K_PREFS = 'takeback-prefs-v1', K_SYNC = 'takeback-sync-v1';

  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function now() { return Date.now(); }
  function newId() {
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789', out = '', a = new Uint8Array(12);
    try { crypto.getRandomValues(a); } catch (e) { for (var j = 0; j < 12; j++) a[j] = Math.floor(Math.random() * 256); }
    for (var i = 0; i < 12; i++) out += abc[a[i] % 36];
    return out;
  }
  function ctx(extra) { var o = { nowMs: now(), today: today(), newId: newId, currency: cur(), locale: LOCALE }; if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; }); return o; }

  /* ---------------- what this device keeps ---------------- */

  var prefs = recall(K_PREFS) || {};
  if (!C.isCurrency(prefs.currency)) prefs.currency = C.currencyFor(LOCALE);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(prefs.time || '')) prefs.time = '09:00';
  if (!C.FILTERS.some(function (f) { return f.id === prefs.filter; })) prefs.filter = 'all';
  function savePrefs() { keep(K_PREFS, prefs); }
  function cur() { return prefs.currency; }
  function money(c) { return C.money(c, cur(), LOCALE); }

  function loadData() {
    var raw = recall(K_DATA) || {};
    var o = { nowMs: now(), today: today() };
    var seen = {};
    return {
      v: 1,
      purchases: (Array.isArray(raw.purchases) ? raw.purchases : []).map(function (p) { return C.cleanPurchase(p, o); }).filter(function (p) { if (!p || seen[p.id]) return false; seen[p.id] = 1; return true; }).slice(-C.LIMITS.purchases),
      notes: C.cleanNotes(raw.notes, o),
      deleted: C.cleanTombstones(raw.deleted, o),
    };
  }
  var data = loadData();
  var sync = recall(K_SYNC) || {};
  if (typeof sync.version !== 'number') sync.version = null;
  sync.dirty = sync.dirty === true;
  var storageOk = true;
  function saveLocal() {
    var ok = keep(K_DATA, data);
    if (!ok && storageOk) { storageOk = false; toast('This browser isn’t keeping things right now - they’ll be gone when the page closes.', 5200); }
  }
  function save() {
    saveLocal();
    if (prefs.sync) { sync.dirty = true; keep(K_SYNC, sync); schedulePush(); }
  }

  var state = {
    me: null, view: 'home', arg: '',
    trying: false, tryList: null,
    thumbs: {}, thumbsLoaded: false,
    recapUrl: null, recapBlob: null, recapStores: false,
    form: null, reader: null,
    syncBusy: false, syncErr: '',
  };
  function list() { return state.trying ? state.tryList : data.purchases; }
  function notes() { return state.trying ? C.SAMPLE_NOTES : data.notes; }
  function find(id) { return list().find(function (p) { return p.id === id; }) || null; }
  function put(p) {
    if (!p) return null;
    var l = list(), i = l.findIndex(function (x) { return x.id === p.id; });
    if (i >= 0) l[i] = p; else l.push(p);
    if (!state.trying) save();
    return p;
  }
  function removePurchase(id) {
    var p = find(id); if (!p) return;
    if (state.trying) { state.tryList = state.tryList.filter(function (x) { return x.id !== id; }); return; }
    data.purchases = data.purchases.filter(function (x) { return x.id !== id; });
    data.deleted = C.cleanTombstones([{ id: id, at: now() }].concat(data.deleted), ctx());
    if (p.dropPhoto) photoDel('d-' + id);
    if (p.photo && !data.purchases.some(function (x) { return x.group === p.group && x.photo; })) photoDel('r-' + p.group);
    save();
  }

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
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
  function slug(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'purchase'; }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  /** Which reader the server runs: the transcribing one also takes pasted text. */
  function transcribes() { return Boolean(state.me && state.me.reader === 'gemini'); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function initial(s) { var a = Array.from(String(s || '').replace(/[^\p{L}\p{N}]/gu, '')); return (a[0] || '?').toUpperCase(); }

  /** Line icons: one weight, drawn from fixed paths (never from data). */
  var ICONS = {
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    refund: '<path d="M9.5 5L4 10l5.5 5"/><path d="M4.5 10h10a5 5 0 010 10H11"/>',
    chart: '<path d="M5 20v-8M10 20V5M15 20v-6M20 20V9"/>',
    bell: '<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>',
    camera: '<path d="M4 8.5h3l1.5-2.5h7L17 8.5h3v10H4z"/><circle cx="12" cy="13" r="3.2"/>',
    spark: '<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
    check: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.5 2.5 4.5-5"/>',
    store: '<path d="M4 9.5L5.5 4h13L20 9.5M5.5 12.5V20h13v-7.5M4 9.5a2.7 2.7 0 005.3 0 2.7 2.7 0 005.4 0 2.7 2.7 0 005.3 0z"/>',
    text: '<path d="M6 4h9l3 3v13H6z"/><path d="M9 10h6M9 13.5h6M9 17h4"/>'
  };
  function ico(name) { return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>'; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Takeback stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
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

  /* ---------------- photos: on this device only ---------------- */

  var dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve) {
      try {
        var r = indexedDB.open('takeback', 1);
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
  var JPEG_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
  var memPhotos = {};
  function photoGet(key) {
    if (memPhotos[key]) return Promise.resolve(memPhotos[key]);
    return idb('readonly', function (s) { return s.get(key); }).then(function (v) {
      if (v && JPEG_URL.test(v.thumb || '') && JPEG_URL.test(v.full || '')) memPhotos[key] = v;
      return memPhotos[key] || null;
    });
  }
  function photoPut(key, p) { memPhotos[key] = p; state.thumbs[key] = p.thumb; return idb('readwrite', function (s) { return s.put(p, key); }); }
  function photoDel(key) { delete memPhotos[key]; delete state.thumbs[key]; return idb('readwrite', function (s) { return s.delete(key); }); }
  /** A photo redrawn through a canvas at `max` px (which drops its EXIF,
   *  location included). */
  function redraw(img, max, q) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, s = Math.min(1, max / Math.max(w, h));
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * s)); cv.height = Math.max(1, Math.round(h * s));
    var g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', q);
  }
  function loadImg(src) { return new Promise(function (r) { var im = new Image(); im.addEventListener('load', function () { r(im); }); im.addEventListener('error', function () { r(null); }); im.src = src; }); }
  /** A receipt or drop-off photo: 1600 px (receipts need their small print)
   *  and a 240 px thumbnail, both redrawn here. */
  function prepPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('That isn’t a photo or a screenshot.'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener('load', function () {
        try {
          var full = redraw(img, 1600, 0.82);
          var thumb = redraw(img, 240, 0.74);
          URL.revokeObjectURL(url);
          resolve({ full: full, thumb: thumb });
        } catch (e) { URL.revokeObjectURL(url); reject(new Error('That image could not be read.')); }
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That image could not be read.')); });
      img.src = url;
    });
  }
  function loadThumbs() {
    var keys = [];
    list().forEach(function (p) { if (p.photo && !state.thumbs['r-' + p.group]) keys.push('r-' + p.group); });
    if (!keys.length) { state.thumbsLoaded = true; return Promise.resolve(false); }
    return Promise.all(keys.map(function (k) { return photoGet(k).then(function (p) { if (p) state.thumbs[k] = p.thumb; }); }))
      .then(function () { state.thumbsLoaded = true; return true; });
  }
  function avatar(p) {
    var t = p.photo && state.thumbs['r-' + p.group];
    return '<span class="av" aria-hidden="true">' + (t ? '<img alt="" src="' + esc(t) + '">' : esc(initial(p.store))) + '</span>';
  }

  /* ---------------- routing ---------------- */

  var VIEWS = ['home', 'add', 'money', 'stores', 'settings', 'try'];
  function route() {
    var h = (location.hash || '').replace(/^#/, '').split('/');
    var v = VIEWS.indexOf(h[0]) >= 0 ? h[0] : 'home';
    if (v === 'try') { startTry(); return; }
    if (v === 'add' && state.trying) { leaveTry(true); }
    state.view = v;
    state.arg = h[1] || '';
    draw();
  }
  function go(hash) {
    var target = BASE + (hash ? '#' + hash : '');
    if (location.pathname + location.hash !== target) history.pushState(null, '', target);
    route();
    scrollTo(0, 0);
  }
  window.addEventListener('popstate', route);

  function first() { return !state.trying && !data.purchases.length && state.view === 'home'; }
  function draw() {
    var tabs = $('#tabbar');
    tabs.hidden = first();
    $$('[data-act="tab"]', tabs).forEach(function (b) { if (b.getAttribute('data-tab') === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var s = C.summary(list(), ctx()), badge = $('#homeBadge'), urgent = s.overdue + list().filter(function (p) { var st = C.stateOf(p, today()), d = C.daysLeft(p, today()); return C.isOpen(st) && d !== null && d <= 1; }).length;
    badge.hidden = !urgent; badge.textContent = urgent > 99 ? '99+' : String(urgent);
    var html = ({ home: first() ? viewFirst : viewHome, add: viewAdd, money: viewMoney, stores: viewStores, settings: viewSettings })[state.view]();
    $('#main').innerHTML = (state.trying && state.view !== 'add' ? ribbon() : '') + html;
    after();
  }
  function after() {
    if (state.view === 'add') bindAdd();
    if (state.view === 'settings') bindSettings();
    if (!state.thumbsLoaded) loadThumbs().then(function (changed) { if (changed && state.view === 'home') draw(); });
  }

  /* ---------------- the first run ---------------- */

  function viewFirst() {
    var ring = function (pct) { var r = 21, c = 2 * Math.PI * r; return '<svg viewBox="0 0 48 48" aria-hidden="true"><circle class="rt" cx="24" cy="24" r="' + r + '" fill="none" stroke-width="3"/><circle class="rv" cx="24" cy="24" r="' + r + '" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="' + (c * pct).toFixed(1) + ' ' + c.toFixed(1) + '"/></svg>'; };
    var holiday = /^(10|11|12)$/.test(today().slice(5, 7));
    return '<section class="first" aria-labelledby="heroTitle">' +
      '<p class="lab">Returns, refunds, done</p>' +
      '<h1 id="heroTitle">Never miss a return window.</h1>' +
      '<p class="lede">And make sure the refund actually lands. Takeback counts down the days, walks you through the return and watches for the money.</p>' +
      '<div class="cta"><button class="btn big" type="button" data-act="try">Try it - a made-up list</button><button class="btn big ghost" type="button" data-act="addfirst">Add my first purchase</button></div>' +
      '<p class="small muted mt16">Free, no sign-up. It all stays on this phone.</p>' +
      '<div class="mock" aria-hidden="true">' +
      '<div class="mc"><span><b>Boots · $89</b><small>Return by Friday</small></span><span class="ring">' + ring(0.1) + '<b>3</b></span></div>' +
      '<div class="mc"><span><b>Earbuds</b><small>Dropped off</small></span><span class="pill t-wait">Refund Mon</span></div>' +
      '<div class="mc"><span><b>Grinder</b><small>Refunded</small></span><span class="pill t-done">$64 back ✓</span></div>' +
      '</div></section>' +
      '<section class="sec narrow" aria-labelledby="howTitle"><h2 id="howTitle">How it works</h2><ol class="how">' +
      '<li><div><b>Add it while the bag is still on the floor.</b><br><span class="muted">Store, item, price and the return window from the receipt - 14, 30, 60, 90 days or a date. Several items from one order at once.</span></div></li>' +
      '<li><div><b>Decide before the window closes.</b><br><span class="muted">Everything is sorted by what needs you soonest: amber under a week, red under two days. Keep it, or send it back.</span></div></li>' +
      '<li><div><b>Follow the money home.</b><br><span class="muted">Label printed, packed, dropped off - then Takeback watches for the refund and flags the one that never arrived.</span></div></li>' +
      '</ol></section>' +
      '<div class="sec feats">' +
      '<section class="feat">' + ico('clock') + '<h3>Countdowns that nudge</h3><p class="muted small">“Return by Fri Nov 6 · 4 days left” on every purchase, and a calendar reminder 3 days before and on the morning of.</p></section>' +
      '<section class="feat">' + ico('refund') + '<h3>A refund watch</h3><p class="muted small">Refunds go missing and nobody notices. Takeback expects them ten business days after drop-off and says when one is late - and what to do.</p></section>' +
      '<section class="feat">' + ico('chart') + '<h3>Money back, counted</h3><p class="muted small">What you recovered this year, what is still returnable, what is on its way - and a recap image to share.</p></section>' +
      '</div>' +
      (holiday ? '<p class="note small mt32 narrow"><b>Holiday shopping?</b> Many stores run longer holiday return windows that start around now. If the receipt gives a date, pick “Until a date” - Takeback never guesses a store’s policy.</p>' : '');
  }

  /* ---------------- try it ---------------- */

  function startTry() {
    state.trying = true;
    state.tryList = C.sample(ctx());
    state.view = 'home'; state.arg = '';
    if (location.hash) history.replaceState(null, '', BASE);
    draw(); scrollTo(0, 0);
    say('A made-up list. Nothing is saved.');
  }
  function leaveTry(quiet) {
    state.trying = false; state.tryList = null;
    if (!quiet) { go(''); }
  }
  function ribbon() {
    return '<div class="ribbon" role="note"><span><b>Made-up purchases</b> - tap around, nothing here is saved.</span><div class="row"><button class="btn small" type="button" data-act="tryadd">Add my own</button><button class="btn small ghost" type="button" data-act="tryleave">Leave</button></div></div>';
  }

  /* ---------------- the list ---------------- */

  function daysChip(p, st, tone) {
    var t = today(), d = C.daysLeft(p, t);
    if (C.isOpen(st) && d !== null) return '<span class="days t-' + tone + '" aria-hidden="true"><b>' + d + '</b><small>' + (d === 0 ? 'today' : d === 1 ? 'day' : 'days') + '</small></span>';
    if (st === 'overdue') return '<span class="days t-red" aria-hidden="true"><b>' + C.lateDays(p, t) + '</b><small>late</small></span>';
    if (st === 'waiting') { var w = C.daysBetween(t, p.expectBy); return '<span class="days t-wait" aria-hidden="true"><b>' + w + '</b><small>to go</small></span>'; }
    if (st === 'refunded') return '<span class="pill t-done">' + (p.refund.kind === 'credit' ? 'Credit' : 'Back') + ' ✓</span>';
    if (st === 'kept') return '<span class="pill t-grey">Kept</span>';
    if (st === 'missed') return '<span class="pill t-grey">Missed</span>';
    return '';
  }
  function stepsMini(p) {
    return '<div class="steps-mini" aria-label="Return steps">' + C.stepsFor(p.how).map(function (s) { return '<span class="' + (p.steps[s.id] ? 'on' : '') + '">' + (p.steps[s.id] ? '✓ ' : '') + esc(s.label) + '</span>'; }).join('') + '</div>';
  }
  function doneHtml(p) {
    var s = C.statusOf(p, ctx()), st = s.state;
    var label = [p.item, p.store].join(', ') + '. ' + s.text; // escaped where it is used
    return '<article class="pcard compact tone-' + s.tone + ' st-' + st + '"><button class="pc-open" type="button" data-act="open" data-id="' + esc(p.id) + '" aria-label="' + esc(label) + '">' + avatar(p) +
      '<span><span class="pc-item">' + esc(p.item) + '</span><span class="pc-sub">' + esc(p.store) + ' · ' + esc(s.text) + '</span></span>' + daysChip(p, st, s.tone) + '</button></article>';
  }
  function cardHtml(p) {
    var o = ctx(), s = C.statusOf(p, o), st = s.state;
    var acts = '';
    if (st === 'deciding') acts = '<button class="btn keep" type="button" data-act="keep" data-id="' + esc(p.id) + '">Keep it</button><button class="btn back" type="button" data-act="return" data-id="' + esc(p.id) + '">Send it back</button>';
    else if (st === 'returning') {
      var nx = C.nextStep(p), step = C.stepsFor(p.how).find(function (x) { return x.id === nx; });
      if (step) acts = '<button class="btn soft" type="button" data-act="step" data-step="' + esc(step.id) + '" data-id="' + esc(p.id) + '">' + esc(step.act) + ' ✓</button><button class="btn ghost" type="button" data-act="open" data-id="' + esc(p.id) + '">Checklist</button>';
    } else if (st === 'waiting' || st === 'overdue') acts = '<button class="btn' + (st === 'overdue' ? '' : ' soft') + '" type="button" data-act="refund" data-id="' + esc(p.id) + '">Refund received</button>' + (st === 'overdue' ? '<button class="btn ghost" type="button" data-act="followup" data-id="' + esc(p.id) + '">What to do</button>' : '');
    var label = [p.item, p.store].concat(p.price !== null ? [money(p.price)] : []).join(', ') + '. ' + s.text; // escaped where it is used
    return '<article class="pcard tone-' + s.tone + ' st-' + st + '">' +
      '<button class="pc-open" type="button" data-act="open" data-id="' + esc(p.id) + '" aria-label="' + esc(label) + '">' + avatar(p) +
      '<span><span class="pc-item">' + esc(p.item) + '</span><span class="pc-sub">' + esc(p.store) + (p.price !== null ? ' · ' + esc(money(p.price)) : '') + (p.gift ? ' · gift' : '') + '</span></span>' + daysChip(p, st, s.tone) + '</button>' +
      '<p class="status t-' + s.tone + '">' + esc(s.text) + '</p>' +
      (st === 'returning' ? stepsMini(p) : '') +
      (acts ? '<div class="pc-acts">' + acts + '</div>' : '') + '</article>';
  }
  function watchHtml(l) {
    var t = today();
    var rows = C.byNeed(l, t).filter(function (p) { var st = C.stateOf(p, t); return st === 'overdue' || st === 'waiting'; });
    var late = rows.filter(function (p) { return C.stateOf(p, t) === 'overdue'; }).length;
    var out = '<section class="watch' + (late ? ' alert' : '') + '" aria-labelledby="watchTitle"><h2 id="watchTitle">' + ico('refund') + ' Refund watch</h2>';
    if (!rows.length) {
      var done = l.filter(function (p) { return p.refund; }).length;
      return out + '<p class="muted">' + (done ? 'Nothing waiting - every refund you sent for has landed.' : 'When you drop something off, Takeback expects the refund ten business days later and tells you if it’s late.') + '</p></section>';
    }
    out += '<p class="muted small">' + (late ? plural(late, 'refund') + ' late · ' : '') + money(rows.reduce(function (a, p) { return a + (p.price || 0); }, 0)) + ' on its way back to you</p>';
    rows.forEach(function (p) {
      var st = C.stateOf(p, t), total = Math.max(1, C.daysBetween(p.steps.dropped, p.expectBy)), gone = C.daysBetween(p.steps.dropped, t);
      var pct = Math.max(4, Math.min(100, Math.round(gone / total * 100)));
      out += '<div class="wrow"><span class="what">' + esc(p.item) + ' · ' + esc(p.store) + (p.price !== null ? ' · ' + esc(money(p.price)) : '') + '</span>' +
        (st === 'overdue' ? '<p class="say t-red">' + esc(C.overdueLine(p, t)) + '</p>' : '<p class="say small muted">Dropped off ' + esc(C.shortDay(p.steps.dropped, t)) + ' · expected by ' + esc(C.fmtDay(p.expectBy, t)) + '</p>') +
        '<svg class="bar' + (st === 'overdue' ? ' late' : '') + '" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="' + esc(st === 'overdue' ? 'Past the expected date' : gone + ' of ' + total + ' days waited') + '"><rect class="bt" width="100" height="4"></rect><rect class="bv" width="' + pct + '" height="4"></rect></svg>' +
        '<div class="row"><button class="btn small' + (st === 'overdue' ? '' : ' soft') + '" type="button" data-act="refund" data-id="' + esc(p.id) + '">Refund received</button>' +
        (st === 'overdue' ? '<button class="btn small ghost" type="button" data-act="followup" data-id="' + esc(p.id) + '">Message to send them</button>' : '<button class="btn small ghost" type="button" data-act="remind" data-id="' + esc(p.id) + '">Remind me</button>') + '</div></div>';
    });
    return out + '</section>';
  }
  function viewHome() {
    var l = list(), o = ctx(), s = C.summary(l, o), t = today();
    var counts = {};
    C.FILTERS.forEach(function (f) { counts[f.id] = C.filterList(l, f.id, t).length; });
    var shown = C.filterList(l, prefs.filter, t);
    var nd = C.nudges(l, o).filter(function (n) { return n.kind !== 'overdue'; });
    var out = '<div class="sec-head"><h1>Returns</h1><button class="btn small" type="button" data-act="tab" data-tab="add">+ Add</button></div>' +
      '<div class="summary"><span class="big">' + esc(s.text) + '</span>' + (s.waitingCount ? '<span class="muted small">' + esc(money(s.waiting)) + ' waiting on ' + plural(s.waitingCount, 'refund') + (s.overdue ? ' · ' + s.overdue + ' late' : '') + '</span>' : '') + '</div>';
    out += '<div class="grid home-split"><div class="home-main">';
    nd.forEach(function (n) { out += '<div class="nudge t-' + (n.kind === 'expect' ? 'wait' : n.kind === 'drop' ? 'amber' : 'red') + '" role="note">' + ico(n.kind === 'expect' ? 'refund' : 'clock') + '<span>' + esc(n.text) + '</span><button class="link-btn" type="button" data-act="open" data-id="' + esc(n.id) + '">Open</button></div>'; });
    out += '<div class="filters" role="group" aria-label="Show">' + C.FILTERS.map(function (f) { return '<button class="chip" type="button" data-act="filter" data-f="' + f.id + '" aria-pressed="' + (prefs.filter === f.id) + '">' + esc(f.label) + '<span class="ct">' + counts[f.id] + '</span></button>'; }).join('') + '</div>';
    if (!shown.length) out += '<section class="empty">' + ico('check') + '<p class="m0"><b>Nothing here.</b></p><p class="muted small m0">' + (prefs.filter === 'all' ? 'Add a purchase to start the countdown.' : 'Nothing in this list right now.') + '</p></section>';
    var isDone = function (p) { var st = C.stateOf(p, t); return st === 'refunded' || st === 'kept' || st === 'missed'; };
    var active = shown.filter(function (p) { return !isDone(p); }), done = shown.filter(isDone);
    if (active.length) out += '<div class="plist">' + active.map(cardHtml).join('') + '</div>';
    if (done.length) {
      if (active.length) out += '<h2 class="lab mt32">Done · ' + done.length + '</h2>';
      out += '<div class="plist">' + done.map(doneHtml).join('') + '</div>';
    }
    var watching = l.some(function (p) { var st = C.stateOf(p, t); return st === 'waiting' || st === 'overdue'; });
    out += '</div><aside class="home-aside' + (watching ? '' : ' quiet') + '">' + watchHtml(l) + moneyMini(l) + '</aside></div>';
    return out;
  }
  function moneyMini(l) {
    var t = C.tally(l, ctx());
    return '<section class="mini-money"><h2>This year</h2><div class="stats"><div class="stat hi"><b>' + esc(money(t.recovered)) + '</b><span>recovered</span></div><div class="stat"><b>' + esc(money(t.returnable)) + '</b><span>still returnable</span></div></div>' +
      '<button class="btn small ghost mt16" type="button" data-act="tab" data-tab="money">See the money</button></section>';
  }

  /* ---------------- one purchase ---------------- */

  function openPurchase(id) {
    var p = find(id); if (!p) return;
    var o = ctx(), t = o.today, s = C.statusOf(p, o), st = s.state, rb = C.returnBy(p);
    var html = '<h2>' + esc(p.item) + '</h2><p class="muted pull">' + esc(p.store) + (p.price !== null ? ' · ' + esc(money(p.price)) : '') + ' · bought ' + esc(C.shortDay(p.bought, t)) + '</p>' +
      '<p class="status t-' + s.tone + ' mb12">' + esc(s.text) + '</p>';
    if (st === 'deciding') html += '<div class="row mb12"><button class="btn keep grow" type="button" data-act="keep" data-id="' + esc(p.id) + '">Keep it</button><button class="btn back grow" type="button" data-act="return" data-id="' + esc(p.id) + '">Send it back</button></div>';
    if (st === 'missed' && p.decision !== 'return') html += '<p class="note small">The window closed. If the store will still take it back, ask them - then tick the steps below as you go.</p><button class="btn small ghost mb12" type="button" data-act="return" data-id="' + esc(p.id) + '">They took it back anyway</button>';
    if (p.decision === 'return') html += checklistHtml(p);
    var ro = C.reminderOptions(p, t);
    if (ro.length) html += '<button class="btn soft block my12" type="button" data-act="remind" data-id="' + esc(p.id) + '">' + ico('bell') + ' Remind me</button>';
    var note = C.noteFor(notes(), p.store);
    html += '<h3 class="mt16">Details</h3><dl class="kv">' +
      '<dt>Return window</dt><dd>' + esc(C.windowLabel(p.window, t)) + (rb ? ' · return by ' + esc(C.fmtDay(rb, t)) : '') + '</dd>' +
      (p.order ? '<dt>Order</dt><dd>' + esc(p.order) + '</dd>' : '') +
      (p.how ? '<dt>Goes back</dt><dd>' + esc(C.howLabel(p.how)) + '</dd>' : '') +
      (p.gift ? '<dt>A gift</dt><dd>Gift receipt - the refund usually comes as store credit</dd>' : '') +
      (p.url ? '<dt>Returns page</dt><dd><a href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer">' + esc(p.url.replace(/^https:\/\//, '').slice(0, 60)) + '</a></dd>' : '') +
      (p.note ? '<dt>Note</dt><dd class="pre">' + esc(p.note) + '</dd>' : '') + '</dl>' +
      (note ? '<p class="store-note mt12"><b>Your note on ' + esc(note.name) + ':</b> ' + esc(note.text) + '</p>' : '') +
      '<div class="photo-row mt12" id="photoRow"></div>' +
      '<div class="row mt16">' + (state.trying ? '' : '<button class="btn small ghost" type="button" data-act="edit" data-id="' + esc(p.id) + '">Edit</button>') +
      (p.decision ? '<button class="btn small ghost" type="button" data-act="undecide" data-id="' + esc(p.id) + '">Undecide</button>' : '') +
      '<button class="btn small ghost" type="button" data-act="delete" data-id="' + esc(p.id) + '">Delete</button></div>';
    sheet(html, function (root) {
      var row = $('#photoRow', root);
      var keys = [];
      if (p.photo) keys.push(['r-' + p.group, 'Receipt']);
      if (p.dropPhoto) keys.push(['d-' + p.id, 'Drop-off receipt']);
      keys.forEach(function (k) {
        photoGet(k[0]).then(function (ph) {
          if (!ph) return;
          var b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', 'Show the ' + k[1].toLowerCase());
          var im = document.createElement('img'); im.alt = ''; im.src = ph.thumb; b.appendChild(im);
          b.addEventListener('click', function () { sheet('<h2>' + esc(k[1]) + '</h2><img class="big-photo" alt="' + esc(k[1] + ' for ' + p.item) + '" src="' + esc(ph.full) + '"><p class="tiny muted mt8">Kept on this phone only.</p><button class="btn small ghost mt8" type="button" data-act="open" data-id="' + esc(p.id) + '">Back</button>'); });
          row.appendChild(b);
        });
      });
      var url = $('#retUrl', root);
      if (url) $('#retUrlSave', root).addEventListener('click', function () {
        var u = C.cleanUrl(url.value);
        if (!u) { $('#retUrlErr', root).textContent = 'Paste the store’s returns page - an https:// link.'; return; }
        var q = find(p.id); if (!q) return;
        var next = JSON.parse(JSON.stringify(q)); next.url = u; next.updatedAt = now();
        put(C.cleanPurchase(next, ctx())); openPurchase(p.id); draw();
      });
      var eb = $('#expectIn', root);
      if (eb) eb.addEventListener('change', function () {
        var q = find(p.id); if (!q || !C.isDay(eb.value)) return;
        put(C.setExpectBy(q, eb.value, ctx())); draw(); openPurchase(p.id); toast('Refund expected by ' + C.fmtDay(eb.value, today()) + '.');
      });
    });
  }
  function checklistHtml(p) {
    var t = today(), st = C.stateOf(p, t);
    var out = '<h3>Sending it back</h3><ol class="checklist">';
    C.stepsFor(p.how).forEach(function (s) {
      var on = Boolean(p.steps[s.id]);
      out += '<li><button class="tick" type="button" data-act="' + (on ? 'unstep' : 'step') + '" data-step="' + esc(s.id) + '" data-id="' + esc(p.id) + '" aria-pressed="' + on + '" aria-label="' + esc(s.label + (on ? ' - done, tap to undo' : '')) + '">' + (on ? '✓' : '') + '</button>' +
        '<span><span class="lbl">' + esc(s.label) + '</span><br><span class="when">' + (on ? esc(C.fmtDay(p.steps[s.id], t)) : 'Not yet') + '</span></span>';
      if (s.id === 'started') {
        out += p.url ? '<a class="btn small ghost" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer">Returns page ↗</a>' : '<span></span>';
      } else if (s.id === 'dropped' && p.dropPhoto) out += '<span class="pill t-ok">Receipt ✓</span>';
      else out += '<span></span>';
      out += '</li>';
      if (s.id === 'started' && !p.url && !state.trying) out += '<li class="wide"><label class="field"><span class="hint">The store’s returns page (optional)</span><input class="input" id="retUrl" type="url" inputmode="url" placeholder="https://" autocomplete="off"></label><button class="btn small ghost" type="button" id="retUrlSave">Save</button><span class="err small span-all m0" id="retUrlErr"></span></li>';
    });
    if (p.steps.dropped) {
      var cls = p.refund ? 'done' : st === 'overdue' ? 'late' : '';
      out += '<li class="money ' + cls + '"><span class="tick' + (p.refund ? ' on' : '') + '" aria-hidden="true">' + (p.refund ? '✓' : '$') + '</span><span><span class="lbl">' +
        (p.refund ? esc(C.refundWord(p, ctx())) + ' on ' + esc(C.fmtDay(p.refund.day, t)) : st === 'overdue' ? esc('No refund yet - ' + plural(C.lateDays(p, t), 'day') + ' late') : 'Refund expected by') + '</span><br>' +
        (p.refund ? '<button class="link-btn" type="button" data-act="unrefund" data-id="' + esc(p.id) + '">Not right? Undo</button>' : '<label class="when">' + (state.trying ? 'Expected by ' + esc(C.fmtDay(p.expectBy, t)) : '<input class="input" id="expectIn" type="date" value="' + esc(p.expectBy) + '" min="' + esc(p.steps.dropped) + '" aria-label="Refund expected by">') + '</label>') + '</span>' +
        (p.refund ? '<span></span>' : '<button class="btn small" type="button" data-act="refund" data-id="' + esc(p.id) + '">Received</button>') + '</li>';
    }
    out += '</ol>';
    if (st === 'overdue') out += '<p class="note small mt12">' + esc(C.overdueLine(p, t)) + ' <button class="link-btn" type="button" data-act="followup" data-id="' + esc(p.id) + '">A message to send them</button></p>';
    if (!p.steps.dropped) out += '<p class="tiny muted mt8">Once it’s dropped off, Takeback expects the refund ten business days later (you can change the date) and tells you if it’s late.</p>';
    return out;
  }

  /* ---------------- the steps ---------------- */

  function undoTo(prev, msg) { return { label: 'Undo', fn: function () { put(prev); draw(); say(msg || 'Undone.'); } }; }
  function doDecide(id, decision) {
    var p = find(id); if (!p) return;
    var next = C.decide(p, decision, ctx());
    put(next); closeSheet(true); draw();
    if (decision === 'keep') toast('Kept - enjoy it.', 3200, undoTo(p));
    else if (decision === 'return') { openPurchase(id); toast('On the send-back list. Tick each step as you go.', 3200); }
    else toast('Back to deciding.');
  }
  function doStep(id, step) {
    var p = find(id); if (!p) return;
    if (step === 'dropped') return openDropped(id);
    var next = C.setStep(p, step, today(), ctx());
    put(next); draw();
    if (!$('#sheet').hidden) openPurchase(id);
    var s = C.stepsFor(next.how).find(function (x) { return x.id === step; });
    toast((s ? s.label : 'Done') + ' ✓', 2600, undoTo(p));
  }
  function undoStep(id, step) {
    var p = find(id); if (!p) return;
    put(C.setStep(p, step, null, ctx())); draw(); openPurchase(id);
  }
  function dateField(id, label, value, max, min) {
    return '<label class="field my12"><span>' + esc(label) + '</span><input class="input w220" id="' + id + '" type="date" value="' + esc(value) + '"' + (max ? ' max="' + esc(max) + '"' : '') + (min ? ' min="' + esc(min) + '"' : '') + '></label>';
  }
  function openDropped(id) {
    var p = find(id); if (!p) return;
    var t = today(), how = p.how === 'store' ? 'Taken back to the store' : 'Dropped off';
    sheet('<h2>' + esc(how) + '</h2><p class="muted">' + esc(p.item) + ' · ' + esc(p.store) + '</p>' +
      dateField('dropDay', 'When', t, t) +
      dateField('dropExpect', 'Refund expected by', C.addBusinessDays(t, C.LIMITS.refundBusinessDays), '', t) +
      '<p class="tiny muted pull">Ten business days after it’s dropped off - change it if the store says otherwise.</p>' +
      (state.trying ? '' : '<div class="field my12"><span>Photo of the drop-off receipt <span class="hint">(optional - it’s your proof)</span></span><label class="btn ghost file-btn">' + ico('camera') + ' Add a photo<input class="vh" id="dropPhoto" type="file" accept="image/*"></label><span class="hint" id="dropPhotoName"></span></div><p class="tiny muted">Photos are shrunk on this phone and their location is removed. They never leave it.</p>') +
      '<div id="dropErr"></div><button class="btn block mt8" type="button" id="dropSave">Save - start the refund watch</button>', function (root) {
      var day = $('#dropDay', root), ex = $('#dropExpect', root), touched = false, dp = $('#dropPhoto', root);
      if (dp) dp.addEventListener('change', function () { $('#dropPhotoName', root).textContent = dp.files[0] ? 'Photo chosen - it is shrunk and kept on this phone when you save.' : ''; });
      ex.addEventListener('change', function () { touched = true; });
      day.addEventListener('change', function () { if (!touched && C.isDay(day.value)) { ex.value = C.addBusinessDays(day.value, C.LIMITS.refundBusinessDays); ex.min = day.value; } });
      $('#dropSave', root).addEventListener('click', function () {
        var d = C.isDay(day.value) && day.value <= today() ? day.value : today();
        var e = C.isDay(ex.value) && ex.value >= d ? ex.value : null;
        var q = find(id); if (!q) return;
        var next = C.setStep(q, 'dropped', d, ctx(), e);
        var file = $('#dropPhoto', root) && $('#dropPhoto', root).files[0];
        var done = function () { put(next); closeSheet(true); draw(); openPurchase(id); toast('Dropped off ✓ - the refund watch is on.', 3200, undoTo(q)); };
        if (!file) return done();
        prepPhoto(file).then(function (ph) { return photoPut('d-' + id, ph).then(function () { next.dropPhoto = true; next = C.cleanPurchase(next, ctx()); done(); }); })
          .catch(function (err) { showError(err, $('#dropErr', root)); });
      });
    });
  }
  function openRefund(id) {
    var p = find(id); if (!p) return;
    var t = today();
    var kind = p.gift ? 'credit' : 'card';
    sheet('<h2>Refund received</h2><p class="muted">' + esc(p.item) + ' · ' + esc(p.store) + '</p>' +
      '<label class="field my12"><span>How much came back</span><input class="input w200" id="rfAmt" inputmode="decimal" autocomplete="off" value="' + esc(p.price !== null ? C.decimal(p.price) : '') + '"></label>' +
      '<p class="small muted pull" id="rfPart"></p>' +
      dateField('rfDay', 'When it landed', t, t, p.steps.dropped || '') +
      '<div class="field my12"><span>As</span><div class="seg" role="group" aria-label="Refund as"><button type="button" data-k="card" aria-pressed="' + (kind === 'card') + '">Back to my card</button><button type="button" data-k="credit" aria-pressed="' + (kind === 'credit') + '">Store credit or gift card</button></div></div>' +
      '<div id="rfErr"></div><button class="btn block" type="button" id="rfSave">Save</button>', function (root) {
      var amt = $('#rfAmt', root), part = $('#rfPart', root);
      function upd() { var c = C.readMoney(amt.value); part.textContent = c !== null && p.price && c < p.price ? 'A partial refund - ' + money(p.price - c) + ' kept back.' : ''; }
      amt.addEventListener('input', upd); upd();
      $$('[data-k]', root).forEach(function (b) { b.addEventListener('click', function () { kind = b.getAttribute('data-k'); $$('[data-k]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); }); });
      $('#rfSave', root).addEventListener('click', function () {
        var c = C.readMoney(amt.value);
        if (c === null) { $('#rfErr', root).innerHTML = '<p class="err">Type the amount that came back - 0 if nothing did.</p>'; return; }
        var q = find(id); if (!q) return;
        var next = C.recordRefund(q, { amount: c, day: $('#rfDay', root).value, kind: kind }, ctx());
        put(next); closeSheet(true); draw();
        toast(money(c) + (kind === 'credit' ? ' in store credit' : ' back') + ' - nice.', 3400, undoTo(q));
      });
    });
  }
  function openFollowUp(id) {
    var p = find(id); if (!p) return;
    var text = C.followUpText(p, ctx());
    sheet('<h2>Chase the refund</h2><p>' + esc(C.overdueLine(p, today()) || 'Not late yet - but here is a message if you need one.') + '</p>' +
      '<ol class="small steps"><li>Look for it on your card statement or in your account - refunds can show up as a credit with a different name.</li><li>Find the drop-off receipt or tracking number.</li><li>Contact ' + esc(p.store) + ' with this message:</li></ol>' +
      '<textarea class="input" id="fuText" rows="6">' + esc(text) + '</textarea>' +
      '<div class="row mt12"><button class="btn" type="button" id="fuCopy">Copy the message</button><button class="btn ghost" type="button" data-act="refund" data-id="' + esc(p.id) + '">It landed</button></div>', function (root) {
      $('#fuCopy', root).addEventListener('click', function () { copy($('#fuText', root).value, 'Copied - paste it into their contact form or chat.'); });
    });
  }

  /* ---------------- reminders ---------------- */

  function openRemind(id) {
    var p = find(id); if (!p) return;
    var opts = C.reminderOptions(p, today());
    sheet('<h2>Remind me</h2><p class="muted">' + esc(p.item) + ' · ' + esc(p.store) + '</p>' +
      '<p>This makes a calendar file on this phone. Open it and your calendar adds the reminders - so they ring even with Takeback closed. Nothing is sent anywhere.</p>' +
      (opts.length ? '<div role="group" aria-label="Reminders">' + opts.map(function (o) { return '<label class="check"><input type="checkbox" data-kind="' + esc(o.kind) + '" checked> ' + esc(o.label) + '</label>'; }).join('') + '</div>' +
        '<label class="field my12"><span>At</span><input class="input w160" id="remTime" type="time" value="' + esc(prefs.time) + '"></label>' +
        (state.trying ? '<p class="note small">This is the made-up list, so nothing goes in your calendar - on your own list, this button makes the file.</p><button class="btn block" type="button" data-act="tryadd">Add my own purchases</button>'
          : '<div id="remErr"></div><button class="btn block" type="button" id="remGo">Add to my calendar</button>') + '<p class="tiny muted mt8">Local time on the phone - 9 AM is 9 AM wherever you are, clock changes included.</p>'
        : '<p class="note">Nothing left to remind you about for this one.</p>'), function (root) {
      var go2 = $('#remGo', root); if (!go2) return;
      go2.addEventListener('click', function () {
        var picks = $$('[data-kind]', root).filter(function (c) { return c.checked; }).map(function (c) { return { id: p.id, kind: c.getAttribute('data-kind') }; });
        if (!picks.length) { $('#remErr', root).innerHTML = '<p class="err">Tick at least one.</p>'; return; }
        var tm = $('#remTime', root).value; if (/^([01]\d|2[0-3]):[0-5]\d$/.test(tm)) { prefs.time = tm; savePrefs(); }
        var ics = C.buildIcs(list(), picks, ctx({ time: prefs.time }));
        if (!ics) return;
        download('takeback-' + slug(p.item) + '.ics', 'text/calendar', ics);
        closeSheet(); toast('Open the file to add ' + plural(picks.length, 'reminder') + ' to your calendar.', 3600);
      });
    });
  }
  function allReminders() {
    var t = today(), picks = [];
    list().forEach(function (p) { C.reminderOptions(p, t).forEach(function (o) { picks.push({ id: p.id, kind: o.kind }); }); });
    if (!picks.length) return toast('Nothing open to remind you about.');
    download('takeback-all-reminders.ics', 'text/calendar', C.buildIcs(list(), picks, ctx({ time: prefs.time })));
    toast('Open the file to add ' + plural(picks.length, 'reminder') + ' to your calendar.', 3600);
  }

  /* ---------------- adding (and editing) ---------------- */

  function blankForm() { return { store: '', bought: today(), win: null, until: '', items: [{ item: '', price: '' }], order: '', how: '', gift: false, url: '', note: '', photo: null, editing: null, picked: false }; }
  function formFor(p) {
    var w = p.window, preset = w && w.days && C.WINDOW_PRESETS.indexOf(w.days) >= 0;
    return { store: p.store, bought: p.bought, win: w ? (w.until ? 'date' : (preset ? String(w.days) : 'd' + w.days)) : null, until: w && w.until ? w.until : '', items: [{ item: p.item, price: p.price !== null ? C.decimal(p.price) : '' }], order: p.order, how: p.how, gift: p.gift, url: p.url, note: p.note, photo: null, editing: p.id, picked: true };
  }
  /** Drawn again when the account answers, so it names the reader the server runs. */
  function aiCard() {
    return '<div class="ai-card" id="aiCard"><p><b>Have the receipt or order email?</b><br><span class="small muted">' + (transcribes() ? 'Snap it or paste it - AI copies what is printed, Takeback works out the return-by day, and you check it before it’s added.' : 'AI can read a photo or screenshot of it - you check everything before it’s added.') + '</span></p><button class="btn" type="button" data-act="reader">' + ico('spark') + (transcribes() ? ' Snap the receipt' : ' Read my receipt') + '</button></div>';
  }
  function viewAdd() {
    var editing = state.arg ? find(state.arg) : null;
    if (!state.form || (state.form.editing || null) !== (editing ? editing.id : null)) state.form = editing ? formFor(editing) : blankForm();
    var f = state.form, stores = C.storesUsed(list()).slice(0, 8);
    var winBtn = function (v, label) { return '<button type="button" data-win="' + esc(v) + '" aria-pressed="' + (f.win === v) + '">' + esc(label) + '</button>'; };
    var custom = f.win && /^d\d+$/.test(f.win) ? winBtn(f.win, f.win.slice(1) + ' days') : '';
    var out = '<div class="sec-head"><h1>' + (editing ? 'Edit purchase' : 'Add a purchase') + '</h1>' + (editing ? '<button class="btn small ghost" type="button" data-act="canceledit">Cancel</button>' : '') + '</div>';
    if (!editing) out += aiCard();
    out += '<div class="add-grid"><form class="stack" id="addForm" novalidate>' +
      '<label class="field"><span>Store</span><input class="input" id="fStore" autocomplete="off" maxlength="60" value="' + esc(f.store) + '" placeholder="Where you bought it"></label>' +
      (stores.length ? '<div class="seg" role="group" aria-label="Stores you have used">' + stores.map(function (s) { return '<button type="button" class="chip" data-store="' + esc(s.name) + '">' + esc(s.name) + '</button>'; }).join('') + '</div>' : '') +
      '<div id="fNote"></div>' +
      '<div class="field"><span>' + (editing ? 'Item and price' : 'What you bought') + '</span><div class="items" id="fItems"></div>' + (editing ? '' : '<button class="btn small ghost start" type="button" id="fMore">+ Another item from this order</button>') + '</div>' +
      '<div class="field"><span>Bought</span><div class="row"><input class="input w200" id="fBought" type="date" value="' + esc(f.bought) + '" max="' + esc(today()) + '"><button class="chip" type="button" data-day="0">Today</button><button class="chip" type="button" data-day="-1">Yesterday</button></div></div>' +
      '<div class="field"><span>Return window <span class="hint">- from the receipt or the store’s returns page</span></span><div class="seg" role="group" aria-label="Return window" id="fWin">' +
      C.WINDOW_PRESETS.map(function (d) { return winBtn(String(d), d + ' days'); }).join('') + custom + winBtn('date', 'Until a date') + '</div>' +
      '<input class="input w200" id="fUntil" type="date" value="' + esc(f.until) + '"' + (f.win === 'date' ? '' : ' hidden') + ' aria-label="Return by"><span class="hint" id="fLast"></span></div>' +
      '<p class="preview t-grey" id="fPreview" aria-live="polite"></p>' +
      '<details class="more"' + (f.order || f.how || f.gift || f.url || f.note ? ' open' : '') + '><summary>More details (optional)</summary><div class="stack">' +
      '<label class="field"><span>Order number</span><input class="input" id="fOrder" autocomplete="off" maxlength="40" value="' + esc(f.order) + '"></label>' +
      '<div class="field"><span>How it goes back</span><div class="seg" role="group" aria-label="How it goes back">' + C.HOW.map(function (h) { return '<button type="button" data-how="' + h.id + '" aria-pressed="' + (f.how === h.id) + '">' + esc(h.label) + '</button>'; }).join('') + '</div></div>' +
      '<label class="check"><input type="checkbox" id="fGift"' + (f.gift ? ' checked' : '') + '> A gift (gift receipt - refunds usually come as store credit)</label>' +
      '<label class="field"><span>The store’s returns page</span><input class="input" id="fUrl" type="url" inputmode="url" autocomplete="off" placeholder="https://" value="' + esc(f.url) + '"></label>' +
      (editing ? '' : '<div class="field"><span>Receipt or order photo</span><label class="btn ghost file-btn">' + ico('camera') + ' Add a photo<input class="vh" id="fPhoto" type="file" accept="image/*"></label><span class="hint">Shrunk on this phone and their location is removed - kept only here.</span><div id="fPhotoPrev"></div></div>') +
      '<label class="field"><span>Note</span><textarea class="input" id="fNoteIn" maxlength="300" rows="2" placeholder="Size, colour, why it might go back">' + esc(f.note) + '</textarea></label>' +
      '</div></details>' +
      '<div id="fErr"></div><button class="btn big block" type="submit" id="fSave">' + (editing ? 'Save changes' : 'Add purchase') + '</button></form>' +
      '<aside><section><h2>Quick tips</h2><ul class="tips"><li>Pick the window the receipt says - Takeback never guesses a store’s policy.</li><li>Many stores run longer holiday return windows that start around now. Use “Until a date” for those.</li><li>Several things from one order? Add them together and decide on each one.</li></ul></section></aside></div>';
    return out;
  }
  function drawItems() {
    var f = state.form, box = $('#fItems'); if (!box) return;
    box.innerHTML = f.items.map(function (r, i) {
      return '<div class="irow"><input class="input" data-i="' + i + '" data-k="item" autocomplete="off" maxlength="80" placeholder="Item" aria-label="Item ' + (i + 1) + '" value="' + esc(r.item) + '">' +
        '<input class="input" data-i="' + i + '" data-k="price" inputmode="decimal" autocomplete="off" placeholder="Price" aria-label="Price of item ' + (i + 1) + '" value="' + esc(r.price) + '">' +
        (f.items.length > 1 ? '<button class="rm" type="button" data-rm="' + i + '" aria-label="Remove item ' + (i + 1) + '">×</button>' : '<span></span>') + '</div>';
    }).join('');
  }
  function saveLabel() {
    var f = state.form, b = $('#fSave'); if (!b || f.editing) return;
    var n = f.items.filter(function (r) { return C.hasWord(C.plain(r.item, 80)); }).length;
    b.textContent = n > 1 ? 'Add ' + plural(n, 'purchase') : 'Add purchase';
  }
  function formWindow() {
    var f = state.form;
    if (f.win === 'date') return C.isDay(f.until) ? { until: f.until } : null;
    if (f.win && /^d?\d+$/.test(f.win)) return { days: Number(f.win.replace('d', '')) };
    return null;
  }
  function updatePreview() {
    var f = state.form, el = $('#fPreview'); if (!el) return;
    var w = C.cleanWindow(formWindow(), C.isDay(f.bought) ? f.bought : today());
    if (!w) { el.className = 'preview t-grey'; el.textContent = f.win === 'date' ? 'Pick the last day to return it.' : 'Pick the return window to start the countdown.'; return; }
    var p = { bought: C.isDay(f.bought) ? f.bought : today(), window: w };
    var rb = C.returnBy(p), d = C.daysBetween(today(), rb);
    el.className = 'preview t-' + C.urgency(d);
    el.textContent = d < 0 ? 'That window closed on ' + C.fmtDay(rb, today()) + '.' : 'Return by ' + C.fmtDay(rb, today()) + ' · ' + (d === 0 ? 'last day today' : plural(d, 'day') + ' left');
  }
  function updateStoreHints() {
    var f = state.form, n = C.noteFor(notes(), f.store), box = $('#fNote'), last = $('#fLast');
    if (box) box.innerHTML = n ? '<p class="store-note"><b>Your note:</b> ' + esc(n.text) + '</p>' : '';
    var lw = f.editing ? null : C.lastWindowFor(list(), f.store);
    if (lw && !f.picked) { f.win = C.WINDOW_PRESETS.indexOf(lw.days) >= 0 ? String(lw.days) : 'd' + lw.days; setWinButtons(); }
    if (last) last.textContent = lw ? 'Last time at ' + f.store.trim() + ' you picked ' + lw.days + ' days.' : '';
    updatePreview();
  }
  function setWinButtons() {
    var f = state.form, box = $('#fWin'); if (!box) return;
    if (f.win && /^d\d+$/.test(f.win) && !$('[data-win="' + f.win + '"]', box)) {
      var b = document.createElement('button'); b.type = 'button'; b.setAttribute('data-win', f.win); b.textContent = f.win.slice(1) + ' days';
      box.insertBefore(b, $('[data-win="date"]', box));
    }
    $$('[data-win]', box).forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-win') === f.win)); });
    $('#fUntil').hidden = f.win !== 'date';
  }
  function bindAdd() {
    var f = state.form, form = $('#addForm'); if (!form) return;
    drawItems(); updateStoreHints(); setWinButtons(); updatePreview(); saveLabel();
    $('#fStore').addEventListener('input', function (e) { f.store = e.target.value; updateStoreHints(); });
    $$('[data-store]', form).forEach(function (b) { b.addEventListener('click', function () { f.store = b.getAttribute('data-store'); $('#fStore').value = f.store; updateStoreHints(); var first = $('[data-k="item"]'); if (first) first.focus(); }); });
    $('#fItems').addEventListener('input', function (e) { var i = Number(e.target.getAttribute('data-i')), k = e.target.getAttribute('data-k'); if (f.items[i] && k) f.items[i][k] = e.target.value; saveLabel(); });
    $('#fItems').addEventListener('click', function (e) { var b = e.target.closest('[data-rm]'); if (!b) return; f.items.splice(Number(b.getAttribute('data-rm')), 1); drawItems(); saveLabel(); });
    var more = $('#fMore');
    if (more) more.addEventListener('click', function () { if (f.items.length >= C.LIMITS.batch) return; f.items.push({ item: '', price: '' }); drawItems(); var ins = $$('[data-k="item"]'); ins[ins.length - 1].focus(); });
    $('#fBought').addEventListener('change', function (e) { f.bought = e.target.value; updatePreview(); });
    $$('[data-day]', form).forEach(function (b) { b.addEventListener('click', function () { f.bought = C.addDays(today(), Number(b.getAttribute('data-day'))); $('#fBought').value = f.bought; updatePreview(); }); });
    $('#fWin').addEventListener('click', function (e) { var b = e.target.closest('[data-win]'); if (!b) return; f.win = b.getAttribute('data-win'); f.picked = true; setWinButtons(); updatePreview(); if (f.win === 'date') $('#fUntil').focus(); });
    $('#fUntil').addEventListener('change', function (e) { f.until = e.target.value; updatePreview(); });
    $$('[data-how]', form).forEach(function (b) { b.addEventListener('click', function () { f.how = f.how === b.getAttribute('data-how') ? '' : b.getAttribute('data-how'); $$('[data-how]', form).forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-how') === f.how)); }); }); });
    $('#fGift').addEventListener('change', function (e) { f.gift = e.target.checked; });
    $('#fOrder').addEventListener('input', function (e) { f.order = e.target.value; });
    $('#fUrl').addEventListener('input', function (e) { f.url = e.target.value; });
    $('#fNoteIn').addEventListener('input', function (e) { f.note = e.target.value; });
    var ph = $('#fPhoto');
    if (ph) ph.addEventListener('change', function () {
      var file = ph.files[0]; if (!file) return;
      prepPhoto(file).then(function (p) { f.photo = p; $('#fPhotoPrev').innerHTML = '<div class="row"><img class="thumb" alt="The receipt photo" src="' + esc(p.thumb) + '"><span class="small muted">Kept on this phone.</span></div>'; })
        .catch(function (err) { showError(err, $('#fPhotoPrev')); });
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); saveForm(); });
  }
  function saveForm() {
    var f = state.form, err = $('#fErr');
    if (f.url && !C.cleanUrl(f.url)) { err.innerHTML = '<p class="err" role="alert">The returns page must be an https:// link - or leave it empty.</p>'; return; }
    if (f.editing) {
      var p = find(f.editing); if (!p) return;
      var it = f.items[0] || {};
      var w = C.cleanWindow(formWindow(), f.bought);
      if (!C.hasWord(C.plain(f.store, 60)) || !C.hasWord(C.plain(it.item, 80))) { err.innerHTML = '<p class="err" role="alert">A store and an item, please.</p>'; return; }
      if (!w) { err.innerHTML = '<p class="err" role="alert">Pick the return window.</p>'; return; }
      var next = JSON.parse(JSON.stringify(p));
      Object.assign(next, { store: f.store, item: it.item, price: C.readMoney(it.price), bought: f.bought, window: w, order: f.order, how: f.how, gift: f.gift, url: f.url, note: f.note, updatedAt: Math.max(now(), p.updatedAt + 1) });
      var clean = C.cleanPurchase(next, ctx());
      if (!clean) { err.innerHTML = '<p class="err" role="alert">That could not be saved.</p>'; return; }
      put(clean); state.form = null; go(''); openPurchase(clean.id); toast('Saved.');
      return;
    }
    var r = C.newPurchases({ store: f.store, bought: f.bought, window: formWindow(), items: f.items, order: f.order, how: f.how, gift: f.gift, url: f.url, note: f.note, photo: Boolean(f.photo) }, ctx());
    if (r.error) { err.innerHTML = '<p class="err" role="alert">' + esc(r.error) + '</p>'; return; }
    if (data.purchases.length + r.purchases.length > C.LIMITS.purchases) { err.innerHTML = '<p class="err" role="alert">Takeback keeps up to ' + C.LIMITS.purchases + ' purchases. Delete a few old ones in Settings first.</p>'; return; }
    addAll(r.purchases, f.photo);
  }
  function addAll(ps, photo) {
    var done = function () {
      ps.forEach(function (p) { data.purchases.push(p); });
      save();
      state.form = null; prefs.filter = 'all'; savePrefs();
      go('');
      var rb = C.returnBy(ps[0]);
      toast((ps.length > 1 ? plural(ps.length, 'purchase') + ' added' : 'Added') + ' - return by ' + C.fmtDay(rb, today()) + '.', 3600, { label: 'Undo', fn: function () { ps.forEach(function (p) { removePurchase(p.id); }); draw(); } });
    };
    if (!photo) return done();
    photoPut('r-' + ps[0].group, photo).then(done, done);
  }

  /* ---------------- "Read my receipt" (metered) ---------------- */

  /** The image to send: the receipt redrawn at 1600 px, smaller until it
   *  fits under the server's limit. */
  function sendable(full) {
    var max = C.LIMITS.aiImageBytes * 4 / 3;
    var b64 = full.replace(/^data:image\/jpeg;base64,/, '');
    if (b64.length <= max) return Promise.resolve(b64);
    return loadImg(full).then(function (im) {
      var steps = [[1600, 0.7], [1400, 0.66], [1200, 0.62], [1000, 0.6]];
      for (var i = 0; i < steps.length; i++) { var d = redraw(im, steps[i][0], steps[i][1]).replace(/^data:image\/jpeg;base64,/, ''); if (d.length <= max) return d; }
      throw new Error('That image is too large to send. Try a closer photo of just the receipt.');
    });
  }
  function openReader() {
    state.reader = { mode: 'photo', photo: null, text: '', proposal: null, stripped: 0 };
    sheet('<div class="body"></div>', drawReader);
  }
  function drawReader(root) {
    var b = $('.body', root), r = state.reader, tx = transcribes();
    var title = tx ? 'Snap the receipt or order email' : 'Read my receipt or order email';
    var sentPhoto = '<div class="sent">' + (r.photo ? '<img alt="" src="' + esc(r.photo.thumb) + '">' : '') + '<b>What is sent:</b> this one image, shrunk on this phone with its location removed. Nothing else - not your list, your notes or your stores. <b>If a card number is printed on it, crop it out first.</b><span class="clear"></span></div>';
    var sentText = '<div class="sent"><b>What is sent:</b> the text you paste, after Takeback takes out email addresses, phone numbers, card numbers, long numbers and street lines. Nothing else - not your list, your notes or your stores.</div>';
    if (!signedIn()) {
      b.innerHTML = '<h2>' + title + '</h2><p>' + (tx ? 'Take a photo of a receipt, or paste an order email. AI copies only what is printed - the store, the date, the items and any return wording, word for word. Takeback works out the return-by day, and you check it before anything is added.' : 'Take a photo of a receipt, or a screenshot of an order email, and AI reads the store, the date, the items with their prices, the order number - and the return window, only if it’s printed on it.') + '</p>' + sentPhoto +
        '<p class="note mt12">This needs a free account - it comes with $2 of AI credit, and one receipt costs about a cent. Adding by hand, the countdowns and the refund watch stay free with no account.</p>' +
        '<div class="row mt12"><button class="btn" type="button" id="rdJoin">Create a free account</button><button class="btn ghost" type="button" id="rdIn">Sign in</button></div>';
      $('#rdJoin', root).addEventListener('click', function () { openAccount('Create a free account to read receipts.', openReader); });
      $('#rdIn', root).addEventListener('click', function () { openAccount('Sign in to read receipts.', openReader, 'login'); });
      return;
    }
    if (r.proposal) return r.proposal.reader === 'transcribe' ? drawChecked(root) : drawProposal(root);
    var textMode = tx && r.mode === 'text';
    b.innerHTML = '<h2>' + title + '</h2>' +
      (tx ? '<p class="small muted">AI copies what is printed, word for word. Takeback works out the return-by day - and you check it before anything is added.</p><div class="seg rd-tabs" role="group" aria-label="What you have"><button type="button" data-mode="photo" aria-pressed="' + !textMode + '">Photo or screenshot</button><button type="button" data-mode="text" aria-pressed="' + textMode + '">Paste the email</button></div>' : '') +
      (textMode
        ? '<label class="field mb12"><span>The order email, pasted <span class="hint">- the part with the store, the items, the date and anything about returns</span></span><textarea class="input" id="rdText" rows="7" maxlength="' + C.LIMITS.aiTextChars + '" placeholder="Paste it here">' + esc(r.text) + '</textarea><span class="hint num count" id="rdCount"></span></label>' + sentText
        : '<div class="field my12"><span>A photo of the receipt, or a screenshot of the order email</span><label class="btn ghost file-btn">' + ico('camera') + (r.photo ? ' Choose another' : ' Choose a photo or screenshot') + '<input class="vh" id="rdFile" type="file" accept="image/*"></label></div>' + sentPhoto) +
      '<div id="rdOut" class="mt12" aria-live="polite"></div><div class="row mt12"><button class="btn" type="button" id="rdGo">' + ico('spark') + ' Read it</button><span class="tiny muted">About a cent of AI credit.</span></div>';
    var out = $('#rdOut', root), go2 = $('#rdGo', root), ta = $('#rdText', root), file = $('#rdFile', root);
    var ready = function () { return textMode ? r.text.trim().length >= C.LIMITS.aiTextMin : Boolean(r.photo); };
    var count = function () { var c = $('#rdCount', root); if (c) c.textContent = r.text.length + ' / ' + C.LIMITS.aiTextChars; go2.disabled = !ready(); };
    count();
    $$('[data-mode]', root).forEach(function (x) { x.addEventListener('click', function () { r.mode = x.getAttribute('data-mode'); drawReader(root); }); });
    if (ta) ta.addEventListener('input', function () { r.text = ta.value.slice(0, C.LIMITS.aiTextChars); count(); });
    if (file) file.addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      prepPhoto(f).then(function (p) { r.photo = p; drawReader(root); }).catch(function (err) { showError(err, out); });
    });
    go2.addEventListener('click', function () {
      if (!ready()) return;
      go2.disabled = true;
      out.innerHTML = '<p class="reading" role="status"><i aria-hidden="true"></i>Reading it…</p>';
      var ask = textMode
        ? api('POST', 'api/ai/receipt', { text: r.text })
        : sendable(r.photo.full).then(function (b64) {
          return api('POST', 'api/ai/receipt', { image: { type: 'image/jpeg', data: b64 } });
        });
      ask.then(function (res) {
        r.proposal = res.proposal; r.stripped = Number(res.stripped) || 0; drawReader(root); loadMe();
      }).catch(function (err) {
        go2.disabled = false;
        meteredError(err, out, openReader, 'Sign in to read receipts.');
      });
    });
  }

  /* The transcribing reader's answer. AI copied what is printed and said how
     sure it was of each part; the return-by day below is Takeback's own sum
     (TakebackCore.windowFromQuote) from the quoted words and the day in the
     form, redone whenever that day changes. Every part the reader was unsure
     of is marked, and nothing can be added until each has been looked at. */
  var WHY = {
    several: 'The wording gives more than one window, so Takeback did not pick one - choose the one for what you bought.',
    'business-days': 'It counts business days, which Takeback does not guess - pick the last day.',
    months: 'It counts in months - pick the last day.',
    'unclear-date': 'The date could be read two ways (day first or month first) - pick the last day.'
  };
  function drawChecked(root) {
    var b = $('.body', root), r = state.reader, p = r.proposal, t = today(), ck = p.checks || {};
    var picked = false, win = null, until = '';
    var todo = {};
    var unsure = function (c) { return c !== 'high'; };
    if (unsure(ck.store)) todo.store = 1;
    if (unsure(ck.bought)) todo.bought = 1;
    p.items.forEach(function (it, i) { if (unsure(it.confidence)) todo['i' + i] = 1; });
    var flag = function (key, words) { return todo[key] ? '<p class="flag m0" data-flag="' + key + '"><span>' + esc(words) + '</span><button class="chip" type="button" data-ok="' + key + '">Looks right</button></p>' : ''; };
    var winKey = function (w) { return w ? (w.until ? 'date' : (C.WINDOW_PRESETS.indexOf(w.days) >= 0 ? String(w.days) : 'd' + w.days)) : null; };
    var worked = p.quote ? C.windowFromQuote(p.quote, p.bought || p.delivered || t) : { window: null, basis: '', why: 'none' };
    if (p.quote && (unsure(ck.window) || !worked.window)) todo.window = 1;
    var last = !p.quote ? C.lastWindowFor(list(), p.store) : null;
    win = worked.window ? winKey(worked.window) : (last ? winKey(last) : null);
    until = worked.window && worked.window.until ? worked.window.until : '';
    var winBtn = function (v, label) { return '<button type="button" data-win="' + esc(v) + '" aria-pressed="' + (win === v) + '">' + esc(label) + '</button>'; };
    b.innerHTML = '<h2>Check it, then add</h2>' +
      '<p class="small muted">AI copied what is printed; the return-by day is Takeback’s own sum. Nothing is added until you tap Add.' + (r.stripped ? ' ' + plural(r.stripped, 'personal detail') + ' ' + (r.stripped === 1 ? 'was' : 'were') + ' taken out before it was sent.' : '') + '</p>' +
      '<p class="todo" id="ckTodo" role="status"></p>' +
      (p.currency && p.currency !== cur() ? '<p class="note small mt12">These prices look like ' + esc(p.currency) + '. Takeback shows amounts in ' + esc(cur()) + ' - change the currency in Settings if that’s wrong.</p>' : '') +
      '<div class="prop stack mt16">' +
      '<label class="field"><span>Store</span><input class="input' + (todo.store ? ' unsure' : '') + '" id="ppStore" data-for="store" maxlength="60" value="' + esc(p.store) + '"></label>' + flag('store', p.store ? 'Hard to read - is this the store?' : 'The store could not be read - type it in.') +
      '<div class="row"><label class="field grow160"><span>Bought</span><input class="input' + (todo.bought ? ' unsure' : '') + '" id="ppDay" data-for="bought" type="date" max="' + esc(t) + '" value="' + esc(p.bought) + '"></label><label class="field grow160"><span>Order number</span><input class="input" id="ppOrder" maxlength="40" value="' + esc(p.order) + '"></label></div>' +
      flag('bought', p.bought ? 'Hard to read - is this the day?' : 'The day could not be read - set it.') +
      (p.delivered ? '<div class="field"><span class="hint">It also says it was delivered on ' + esc(C.fmtDay(p.delivered, t)) + '. If the return wording counts from delivery, use that day.</span><div class="seg" role="group" aria-label="Count from">' + (p.bought ? '<button type="button" data-from="' + esc(p.bought) + '" aria-pressed="true">Ordered ' + esc(C.shortDay(p.bought, t)) + '</button>' : '') + '<button type="button" data-from="' + esc(p.delivered) + '" aria-pressed="false">Delivered ' + esc(C.shortDay(p.delivered, t)) + '</button></div></div>' : '') +
      (p.orderDropped ? '<p class="tiny muted pull">The order number had a long run of digits that could be a card number, so it was left out - type it in if you need it.</p>' : '') +
      '<div class="field"><span>Items <span class="hint">- as written on it</span></span><div class="items">' + p.items.map(function (it, i) {
        return '<div class="irow"><input type="checkbox" data-pi="' + i + '" checked aria-label="Add ' + esc(it.item) + '"><input class="input' + (todo['i' + i] ? ' unsure' : '') + '" data-pn="' + i + '" data-for="i' + i + '" maxlength="80" value="' + esc(it.item) + '" aria-label="Item ' + (i + 1) + '"><input class="input" data-pp="' + i + '" data-for="i' + i + '" inputmode="decimal" value="' + esc(it.price !== null ? C.decimal(it.price) : '') + '" placeholder="Price" aria-label="Price of item ' + (i + 1) + '"></div>' + flag('i' + i, 'Hard to read - check the name' + (it.price === null ? ' and add the price.' : ' and price.'));
      }).join('') + (p.items.length ? '' : '<p class="muted small">No items could be read - add them by hand.</p>') + '</div></div>' +
      '<div class="field"><span>Return window</span>' +
      (p.quote ? '<p class="small m0">Printed on it:</p><p class="quote">“' + esc(p.quote) + '”</p>' + flag('window', worked.window ? 'Hard to read - do the words above match the receipt?' : (WHY[worked.why] || 'Takeback could not work out a number of days from these words - pick the window.'))
        : '<p class="small muted m0">' + (p.quoteDropped ? 'The return wording that came back was not in the text you pasted, so it was left out. Pick the window the store gives.' : 'Nothing about returns is printed on it - pick the window the store gives.') + '</p>') +
      '<div class="seg" role="group" aria-label="Return window" id="ppWin">' + C.WINDOW_PRESETS.map(function (d) { return winBtn(String(d), d + ' days'); }).join('') + (win && /^d\d+$/.test(win) ? winBtn(win, win.slice(1) + ' days') : '') + winBtn('date', 'Until a date') + '</div>' +
      '<input class="input w200" id="ppUntil" type="date" value="' + esc(until) + '"' + (win === 'date' ? '' : ' hidden') + ' aria-label="Return by"></div>' +
      '<div class="deadline" aria-live="polite"><p class="big" id="ckBy"></p><p class="small muted" id="ckSum"></p></div>' +
      '</div><div id="ppErr"></div><div class="row mt16"><button class="btn" type="button" id="ppAdd">Add</button><button class="btn ghost" type="button" id="ppBack">Read another</button></div>' +
      (r.photo ? '<p class="tiny muted mt8">The receipt image is kept on this phone with the purchase.</p>' : '');
    var dayIn = $('#ppDay', root), untilIn = $('#ppUntil', root), add = $('#ppAdd', root);
    var current = function () { return win === 'date' ? (C.isDay(untilIn.value) ? { until: untilIn.value } : null) : (win ? { days: Number(win.replace('d', '')) } : null); };
    var setWin = function () {
      var box = $('#ppWin', root);
      if (win && /^d\d+$/.test(win) && !$('[data-win="' + win + '"]', box)) {
        var nb = document.createElement('button'); nb.type = 'button'; nb.setAttribute('data-win', win); nb.textContent = win.slice(1) + ' days';
        box.insertBefore(nb, $('[data-win="date"]', box));
      }
      $$('[data-win]', box).forEach(function (y) { y.setAttribute('aria-pressed', String(y.getAttribute('data-win') === win)); });
      untilIn.hidden = win !== 'date';
    };
    var refresh = function () {
      var left = Object.keys(todo).length, n = $$('[data-pi]', root).filter(function (c) { return c.checked; }).length;
      var td = $('#ckTodo', root);
      td.className = 'todo ' + (left ? 't-amber' : 't-ok');
      td.textContent = left ? plural(left, 'thing') + ' to check before adding - marked below.' : 'Everything is checked.';
      add.disabled = !n || left > 0;
      add.textContent = left ? 'Check ' + left + ' more to add' : (n ? 'Add ' + plural(n, 'purchase') : 'Add');
      var day = C.isDay(dayIn.value) ? dayIn.value : '', w = day ? C.cleanWindow(current(), day) : null, by = $('#ckBy', root), sum = $('#ckSum', root);
      if (!day) { by.textContent = 'Set the day to see the return-by date.'; sum.textContent = ''; return; }
      if (!w) { by.textContent = win === 'date' ? 'Pick the last day to return it.' : 'Pick the return window to see the return-by date.'; sum.textContent = ''; return; }
      var rb = C.returnBy({ bought: day, window: w }), d = C.daysBetween(t, rb);
      by.textContent = d < 0 ? 'That window closed on ' + C.fmtDay(rb, t) + '.' : 'Return by ' + C.fmtDay(rb, t) + ' · ' + (d === 0 ? 'last day today' : plural(d, 'day') + ' left');
      sum.textContent = 'Worked out by Takeback, not by AI: ' + (w.until ? 'the date ' + (picked || !p.quote ? 'you picked' : 'in the words above') : w.days + ' days from ' + C.fmtDay(day, t) + (picked || !p.quote ? ' - your pick' : ' - from the words above')) + '.';
    };
    var settle = function (key) {
      if (!todo[key]) return;
      delete todo[key];
      var f = $('[data-flag="' + key + '"]', root);
      if (f) { f.className = 'flag ok m0'; f.textContent = 'Checked ✓'; }
      $$('[data-for="' + key + '"]', root).forEach(function (x) { x.classList.remove('unsure'); });
      refresh();
    };
    var recompute = function () {
      if (picked || !p.quote || !C.isDay(dayIn.value)) return;
      var again = C.windowFromQuote(p.quote, dayIn.value);
      if (again.window) { win = winKey(again.window); if (again.window.until) untilIn.value = again.window.until; setWin(); }
    };
    b.addEventListener('click', function (e) {
      var ok = e.target.closest('[data-ok]'); if (ok) { settle(ok.getAttribute('data-ok')); return; }
      var x = e.target.closest('[data-win]');
      if (x) { win = x.getAttribute('data-win'); picked = true; setWin(); settle('window'); refresh(); if (win === 'date') untilIn.focus(); return; }
      var fr = e.target.closest('[data-from]');
      if (fr) { dayIn.value = fr.getAttribute('data-from'); $$('[data-from]', root).forEach(function (y) { y.setAttribute('aria-pressed', String(y === fr)); }); settle('bought'); recompute(); refresh(); }
    });
    b.addEventListener('input', function (e) { var k = e.target.getAttribute('data-for'); if (k) settle(k); });
    b.addEventListener('change', function (e) {
      var pi = e.target.getAttribute('data-pi');
      if (pi !== null && !e.target.checked) settle('i' + pi);
      if (e.target === dayIn) { settle('bought'); recompute(); }
      refresh();
    });
    refresh();
    $('#ppBack', root).addEventListener('click', function () { openReader(); });
    add.addEventListener('click', function () {
      if (Object.keys(todo).length) return;
      var items = $$('[data-pi]', root).filter(function (c) { return c.checked; }).map(function (c) { var i = c.getAttribute('data-pi'); return { item: $('[data-pn="' + i + '"]', root).value, price: $('[data-pp="' + i + '"]', root).value }; });
      if (state.trying) leaveTry(true);
      var res = C.newPurchases({ store: $('#ppStore', root).value, bought: dayIn.value, window: current(), items: items, order: $('#ppOrder', root).value, photo: Boolean(r.photo) }, ctx());
      if (res.error) { $('#ppErr', root).innerHTML = '<p class="err" role="alert">' + esc(res.error) + '</p>'; return; }
      closeSheet(true);
      addAll(res.purchases, r.photo);
      state.reader = null;
    });
  }
  function drawProposal(root) {
    var b = $('.body', root), r = state.reader, p = r.proposal, t = today();
    var win = p.window ? (p.window.until ? 'date' : (C.WINDOW_PRESETS.indexOf(p.window.days) >= 0 ? String(p.window.days) : 'd' + p.window.days)) : (C.lastWindowFor(list(), p.store) ? String(C.lastWindowFor(list(), p.store).days) : null);
    var until = p.window && p.window.until ? p.window.until : '';
    var winBtn = function (v, label) { return '<button type="button" data-win="' + esc(v) + '" aria-pressed="' + (win === v) + '">' + esc(label) + '</button>'; };
    b.innerHTML = '<h2>Check it, then add</h2><p class="small muted">Read by AI - check every line. Nothing is added until you tap Add.</p>' +
      '<p><span class="pill t-' + (p.confidence === 'high' ? 'ok' : p.confidence === 'medium' ? 'wait' : 'amber') + '">' + esc(p.confidence) + ' confidence</span>' + (p.note ? ' <span class="small muted">' + esc(p.note) + '</span>' : '') + '</p>' +
      (p.currency && p.currency !== cur() ? '<p class="note small">These prices look like ' + esc(p.currency) + '. Takeback shows amounts in ' + esc(cur()) + ' - change the currency in Settings if that’s wrong.</p>' : '') +
      '<div class="prop stack">' +
      '<label class="field"><span>Store</span><input class="input" id="ppStore" maxlength="60" value="' + esc(p.store) + '"></label>' +
      '<div class="row"><label class="field grow160"><span>Bought</span><input class="input" id="ppDay" type="date" max="' + esc(t) + '" value="' + esc(p.bought || t) + '"></label><label class="field grow160"><span>Order number</span><input class="input" id="ppOrder" maxlength="40" value="' + esc(p.order) + '"></label></div>' +
      (p.orderDropped ? '<p class="tiny muted pull">The order number had a long run of digits that could be a card number, so it was left out - type it in if you need it.</p>' : '') +
      '<div class="field"><span>Items</span><div class="items">' + p.items.map(function (it, i) {
        return '<div class="irow"><input type="checkbox" data-pi="' + i + '" checked aria-label="Add ' + esc(it.item) + '"><input class="input" data-pn="' + i + '" maxlength="80" value="' + esc(it.item) + '" aria-label="Item ' + (i + 1) + '"><input class="input" data-pp="' + i + '" inputmode="decimal" value="' + esc(it.price !== null ? C.decimal(it.price) : '') + '" placeholder="Price" aria-label="Price of item ' + (i + 1) + '"></div>';
      }).join('') + (p.items.length ? '' : '<p class="muted small">No items could be read - add them by hand.</p>') + '</div></div>' +
      '<div class="field"><span>Return window</span>' + (p.window ? '<p class="small m0">Printed on it:</p><p class="quote">“' + esc(p.quote) + '”</p>' : '<p class="small muted m0">No return window is printed on it - pick the one the store gives.</p>') +
      '<div class="seg" role="group" aria-label="Return window" id="ppWin">' + C.WINDOW_PRESETS.map(function (d) { return winBtn(String(d), d + ' days'); }).join('') + (win && /^d\d+$/.test(win) ? winBtn(win, win.slice(1) + ' days') : '') + winBtn('date', 'Until a date') + '</div>' +
      '<input class="input w200" id="ppUntil" type="date" value="' + esc(until) + '"' + (win === 'date' ? '' : ' hidden') + ' aria-label="Return by"></div>' +
      '</div><div id="ppErr"></div><div class="row mt12"><button class="btn" type="button" id="ppAdd">Add</button><button class="btn ghost" type="button" id="ppBack">Read another</button></div>' +
      '<p class="tiny muted mt8">The receipt image is kept on this phone with the purchase.</p>';
    var cnt = function () { var n = $$('[data-pi]', root).filter(function (c) { return c.checked; }).length; $('#ppAdd', root).textContent = n ? 'Add ' + plural(n, 'purchase') : 'Add'; $('#ppAdd', root).disabled = !n; };
    $$('[data-pi]', root).forEach(function (c) { c.addEventListener('change', cnt); }); cnt();
    $('#ppWin', root).addEventListener('click', function (e) { var x = e.target.closest('[data-win]'); if (!x) return; win = x.getAttribute('data-win'); $$('[data-win]', root).forEach(function (y) { y.setAttribute('aria-pressed', String(y === x)); }); $('#ppUntil', root).hidden = win !== 'date'; });
    $('#ppBack', root).addEventListener('click', function () { openReader(); });
    $('#ppAdd', root).addEventListener('click', function () {
      var items = $$('[data-pi]', root).filter(function (c) { return c.checked; }).map(function (c) { var i = c.getAttribute('data-pi'); return { item: $('[data-pn="' + i + '"]', root).value, price: $('[data-pp="' + i + '"]', root).value }; });
      var w = win === 'date' ? ($('#ppUntil', root).value ? { until: $('#ppUntil', root).value } : null) : (win ? { days: Number(win.replace('d', '')) } : null);
      if (state.trying) leaveTry(true);
      var res = C.newPurchases({ store: $('#ppStore', root).value, bought: $('#ppDay', root).value, window: w, items: items, order: $('#ppOrder', root).value, photo: true }, ctx());
      if (res.error) { $('#ppErr', root).innerHTML = '<p class="err" role="alert">' + esc(res.error) + '</p>'; return; }
      closeSheet(true);
      addAll(res.purchases, r.photo);
      state.reader = null;
    });
  }

  /* ---------------- money ---------------- */

  function chartSvg(months) {
    var W = 440, H = 220, pad = 24, bw = (W - pad * 2) / months.length, max = Math.max(100, months.reduce(function (m, x) { return Math.max(m, x.recovered, x.missed); }, 0));
    var desc = months.map(function (m) { return m.label + ': ' + money(m.recovered) + ' back' + (m.missed ? ', ' + money(m.missed) + ' missed' : ''); }).join('; ');
    var bars = months.map(function (m, i) {
      var x = pad + i * bw, w = bw * 0.34, base = H - pad, out = '';
      var h1 = (m.recovered / max) * (H - pad * 2), h2 = (m.missed / max) * (H - pad * 2);
      out += '<rect class="b-back" x="' + (x + bw * 0.14).toFixed(1) + '" y="' + (base - h1).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(m.recovered ? 2 : 0, h1).toFixed(1) + '" rx="3"></rect>';
      out += '<rect class="b-miss" x="' + (x + bw * 0.52).toFixed(1) + '" y="' + (base - h2).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(m.missed ? 2 : 0, h2).toFixed(1) + '" rx="3"></rect>';
      if (m.recovered) out += '<text x="' + (x + bw * 0.31).toFixed(1) + '" y="' + (base - h1 - 5).toFixed(1) + '" text-anchor="middle">' + esc(C.money(m.recovered, cur(), LOCALE).replace(/\.\d\d$/, '')) + '</text>';
      return out + '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 7) + '" text-anchor="middle">' + esc(m.label) + '</text>';
    }).join('');
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('Money back and windows missed by month: ' + desc) + '"><line class="ax" x1="' + pad + '" x2="' + (W - pad) + '" y1="' + (H - pad) + '" y2="' + (H - pad) + '"></line>' + bars + '</svg>' +
      '<div class="legend" aria-hidden="true"><span><i class="b-back"></i>Money back</span><span><i class="b-miss"></i>Windows missed</span></div>';
  }
  function viewMoney() {
    var l = list(), t = C.tally(l, ctx());
    var out = '<div class="sec-head"><h1>Money</h1><span class="muted">' + esc(t.year) + '</span></div>';
    out += '<p class="muted pull mb12">' + esc(t.headline) + '</p>';
    out += '<div class="stats four"><div class="stat hi"><b>' + esc(money(t.recovered)) + '</b><span>recovered this year</span></div><div class="stat"><b>' + esc(money(t.returnable)) + '</b><span>still returnable (' + t.returnableCount + ')</span></div><div class="stat"><b>' + esc(money(t.waiting)) + '</b><span>waiting on ' + plural(t.waitingCount, 'refund') + '</span></div><div class="stat"><b>' + t.missedCount + '</b><span>' + (t.missedCount === 1 ? 'window' : 'windows') + ' missed' + (t.missedCount ? ' (' + esc(money(t.missed)) + ')' : '') + '</span></div></div>';
    out += '<div class="grid two sec"><section><h2>By month</h2>' + chartSvg(t.months) + '</section>' +
      '<section><h2>Where it went</h2><dl class="kv"><dt>Back to a card</dt><dd>' + esc(money(t.card)) + '</dd><dt>As store credit</dt><dd>' + esc(money(t.credit)) + '</dd><dt>Refunds landed</dt><dd>' + t.refunds + (t.partial ? ' (' + t.partial + ' partial)' : '') + '</dd><dt>Returns made</dt><dd>' + t.returns + '</dd><dt>Kept</dt><dd>' + plural(t.keptCount, 'thing') + (t.kept ? ' · ' + esc(money(t.kept)) : '') + '</dd>' + (t.overdueCount ? '<dt>Late refunds</dt><dd class="err">' + t.overdueCount + '</dd>' : '') + '</dl></section></div>';
    out += '<section class="sec"><h2>Your recap image</h2><p class="muted small">Your year in returns, to share - drawn on this phone, never uploaded. Totals and counts only; no item is ever on it.</p>' +
      '<label class="check"><input type="checkbox" id="recapStores"' + (state.recapStores ? ' checked' : '') + '> Show store names</label>' +
      '<div class="row"><button class="btn" type="button" data-act="recapimg">' + (state.recapUrl ? 'Draw it again' : 'Make my recap image') + '</button>' + (state.recapUrl ? '<button class="btn" type="button" data-act="recapshare">' + (canShareFiles() ? 'Share it' : 'Download it') + '</button>' : '') + '</div>' +
      (state.recapUrl ? '<img class="recap-img" alt="' + esc('Your recap image: ' + t.headline) + '" src="' + esc(state.recapUrl) + '">' : '') + '</section>';
    return out;
  }
  function canShareFiles() {
    try { return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [new File(['x'], 'x.png', { type: 'image/png' })] })); } catch (e) { return false; }
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function fit(g, s, max) { s = String(s); if (g.measureText(s).width <= max) return s; var cps = Array.from(s); while (cps.length > 1 && g.measureText(cps.join('') + '…').width > max) cps.pop(); return cps.join('') + '…'; }
  /** The recap image: 1080 x 1350, drawn here on a canvas. Totals and
   *  counts only; store names only when the box is ticked. Never uploaded. */
  function drawRecap() {
    var l = list(), o = ctx(), t = C.tally(l, o);
    var withStores = Boolean($('#recapStores') && $('#recapStores').checked);
    state.recapStores = withStores;
    var tops = withStores ? C.topStores(l, o, 3) : [];
    var cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1350;
    var g = cv.getContext('2d');
    var grad = g.createLinearGradient(0, 0, 1080, 1350); grad.addColorStop(0, '#1e40af'); grad.addColorStop(1, '#9d174d');
    g.fillStyle = grad; g.fillRect(0, 0, 1080, 1350);
    var F = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    // the mark: a return arrow on a white tile
    g.fillStyle = '#ffffff'; roundRect(g, 84, 84, 96, 96, 26); g.fill();
    // The header's mark, scaled from its 32-unit box to 96 px.
    g.strokeStyle = '#1e40af'; g.lineWidth = 10; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(123, 105); g.lineTo(102, 124.5); g.lineTo(123, 144); g.stroke();
    g.beginPath(); g.moveTo(105, 124.5); g.lineTo(142.5, 124.5); g.arc(142.5, 144, 19.5, -Math.PI / 2, Math.PI / 2); g.lineTo(126, 163.5); g.stroke();
    g.fillStyle = '#ffffff'; g.font = '800 50px ' + F; g.textBaseline = 'middle'; g.fillText('Takeback', 206, 120);
    g.fillStyle = '#e6eaff'; g.font = '700 32px ' + F; g.fillText('My ' + t.year + ' in returns', 206, 162);
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#ffffff'; g.font = '900 210px ' + F; g.fillText(fit(g, money(t.recovered), 912), 76, 470);
    g.font = '800 58px ' + F; g.fillText('recovered this year', 84, 552);
    var stats = [[String(t.refunds), t.refunds === 1 ? 'refund landed' : 'refunds landed'], [money(t.waiting), 'on the way'], [String(t.missedCount), t.missedCount === 1 ? 'window missed' : 'windows missed']];
    stats.forEach(function (s, i) {
      var x = 84 + i * 316;
      g.fillStyle = 'rgba(255,255,255,.14)'; roundRect(g, x, 616, 290, 164, 28); g.fill();
      g.fillStyle = '#ffffff'; g.font = '900 66px ' + F; g.fillText(fit(g, s[0], 250), x + 26, 702);
      g.fillStyle = '#e6eaff'; g.font = '700 31px ' + F; g.fillText(s[1], x + 26, 750);
    });
    var y = 850;
    g.fillStyle = '#e6eaff'; g.font = '700 34px ' + F;
    g.fillText(fit(g, money(t.returnable) + ' still returnable · ' + plural(t.returns, 'return') + ' sent back', 912), 84, y); y += 70;
    if (tops.length) {
      g.fillStyle = '#ffffff'; g.font = '800 36px ' + F; g.fillText('Most money back from', 84, y + 10); y += 40;
      tops.forEach(function (s) {
        g.fillStyle = 'rgba(255,255,255,.14)'; roundRect(g, 84, y, 912, 76, 22); g.fill();
        g.fillStyle = '#ffffff'; g.font = '800 34px ' + F; g.fillText(fit(g, s.name, 620), 112, y + 50);
        g.font = '900 34px ' + F; var mv = money(s.amount); g.fillText(mv, 968 - g.measureText(mv).width, y + 50);
        y += 92;
      });
    } else {
      g.fillStyle = '#ffffff'; g.font = '800 40px ' + F;
      g.fillText(t.missedCount ? 'Next year: zero missed windows.' : 'Not one return window missed.', 84, y + 30);
    }
    g.fillStyle = '#e6eaff'; g.font = '700 30px ' + F; g.fillText('Tracked with Takeback · ' + fit(g, location.host + BASE.replace(/\/$/, ''), 560), 84, 1286);
    return new Promise(function (resolve) { cv.toBlob(function (b) { resolve(b); }, 'image/png'); }).then(function (blob) {
      if (!blob) throw new Error('This browser couldn’t draw the image.');
      if (state.recapUrl) URL.revokeObjectURL(state.recapUrl);
      state.recapBlob = blob; state.recapUrl = URL.createObjectURL(blob);
      draw();
      toast(canShareFiles() ? 'Drawn - tap Share it.' : 'Drawn - tap Download it.');
    });
  }
  function shareRecap() {
    if (!state.recapBlob) return;
    var file = new File([state.recapBlob], 'takeback-recap.png', { type: 'image/png' });
    if (canShareFiles()) {
      navigator.share({ files: [file], title: 'My year in returns' }).catch(function (e) { if (!e || e.name !== 'AbortError') download('takeback-recap.png', 'image/png', state.recapBlob); });
    } else download('takeback-recap.png', 'image/png', state.recapBlob);
  }

  /* ---------------- stores ---------------- */

  function viewStores() {
    var used = C.storesUsed(list()), n = notes();
    var keys = {};
    used.forEach(function (s) { keys[s.key] = 1; });
    var extra = Object.keys(n).filter(function (k) { return !keys[k]; }).map(function (k) { return { key: k, name: n[k].name, count: 0, last: 0 }; });
    var rows = used.concat(extra);
    var out = '<div class="sec-head"><h1>Stores</h1>' + (state.trying ? '' : '<button class="btn small ghost" type="button" data-act="storenote" data-store="">+ A note</button>') + '</div>' +
      '<p class="muted">Your own notes on each store’s returns - “free returns in store”, “keeps the shipping fee”. They show up when you add something from that store. Takeback never fills these in; only you do.</p>';
    if (!rows.length) return out + '<section class="empty">' + ico('store') + '<p class="muted m0">Stores appear here as you add purchases.</p></section>';
    out += '<section class="slist">' + rows.map(function (s) {
      var note = n[s.key];
      var items = list().filter(function (p) { return C.storeKey(p.store) === s.key; });
      var back = items.reduce(function (a, p) { return a + (p.refund ? p.refund.amount : 0); }, 0);
      return '<div class="srow"><span class="av" aria-hidden="true">' + esc(initial(s.name)) + '</span><div><div class="nm">' + esc(s.name) + '</div><div class="small muted">' + plural(items.length, 'purchase') + (back ? ' · ' + esc(money(back)) + ' back' : '') + '</div>' +
        (note ? '<div class="tx">' + esc(note.text) + '</div>' : '<div class="tx">No note yet.</div>') + '</div>' +
        (state.trying ? '<span></span>' : '<button class="btn small ghost" type="button" data-act="storenote" data-store="' + esc(s.name) + '">' + (note ? 'Edit' : 'Add note') + '</button>') + '</div>';
    }).join('') + '</section>';
    return out;
  }
  function openStoreNote(name) {
    var n = name ? C.noteFor(data.notes, name) : null;
    sheet('<h2>' + (name ? esc(name) : 'A note on a store') + '</h2>' +
      (name ? '' : '<label class="field my12"><span>Store</span><input class="input" id="snName" maxlength="60" autocomplete="off"></label>') +
      '<label class="field my12"><span>Your note</span><textarea class="input" id="snText" maxlength="300" rows="4" placeholder="Free returns in store; keeps the shipping fee by mail">' + esc(n ? n.text : '') + '</textarea></label>' +
      '<div id="snErr"></div><div class="row"><button class="btn" type="button" id="snSave">Save</button>' + (n ? '<button class="btn ghost" type="button" id="snDel">Remove the note</button>' : '') + '</div>', function (root) {
      $('#snSave', root).addEventListener('click', function () {
        var nm = C.plain(name || $('#snName', root).value, C.LIMITS.store), key = C.storeKey(nm), text = C.para($('#snText', root).value, C.LIMITS.storeNote);
        if (!key) { $('#snErr', root).innerHTML = '<p class="err">Which store?</p>'; return; }
        if (!text) { delete data.notes[key]; } else {
          if (!data.notes[key] && Object.keys(data.notes).length >= C.LIMITS.storeNotes) { $('#snErr', root).innerHTML = '<p class="err">That’s ' + C.LIMITS.storeNotes + ' notes - remove one first.</p>'; return; }
          data.notes[key] = { name: nm, text: text, at: now() };
        }
        save(); closeSheet(); draw(); toast('Saved.');
      });
      var del = $('#snDel', root);
      if (del) del.addEventListener('click', function () { delete data.notes[C.storeKey(name)]; save(); closeSheet(); draw(); toast('Note removed.'); });
    });
  }

  /* ---------------- settings, export, import, sync ---------------- */

  function syncCard() {
    var out = '<section id="syncCard"><h2>Phone and laptop</h2>';
    if (!signedIn()) return out + '<p>Your list lives on this device. With a free account you can turn on sync, so a phone and a laptop see the same list.</p><div class="row"><button class="btn" type="button" data-act="signin">Create a free account</button><button class="btn ghost" type="button" data-act="signin-login">Sign in</button></div></section>';
    if (!state.me.sync) return out + '<p class="muted">Sync isn’t available right now. Your list is safe on this device.</p></section>';
    var plain2 = '<p class="small">Sync stores your list - stores, items, prices, dates, the return steps, refunds and your store notes - in the lab’s database, so your other device can see it. <b>Photos stay on this phone.</b> It is filed under a code made from your account, never your email.</p>';
    if (!prefs.sync) return out + plain2 + '<button class="btn" type="button" data-act="syncon">Turn on sync</button></section>';
    var when = sync.at ? 'Last saved ' + new Date(sync.at).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not saved yet';
    return out + '<p><span class="pill t-ok">Sync is on</span> <span class="small muted">' + esc(when) + (sync.dirty ? ' · changes waiting' : '') + '</span></p>' + (state.syncErr ? '<p class="err small">' + esc(state.syncErr) + '</p>' : '') + plain2 +
      '<div class="row"><button class="btn small" type="button" data-act="syncnow">Sync now</button><button class="btn small ghost" type="button" data-act="syncoff">Turn off</button><button class="btn small ghost" type="button" data-act="syncdel">Turn off and delete the account copy</button></div></section>';
  }
  function viewSettings() {
    var out = '<div class="sec-head"><h1>Settings</h1></div><div class="grid two">';
    out += '<section class="stack"><h2>This device</h2><label class="field"><span>Currency</span><select class="input w220" id="curSel">' + C.CURRENCIES.map(function (c) { return '<option' + (c === cur() ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Reminders at</span><input class="input w160" id="timeSel" type="time" value="' + esc(prefs.time) + '"></label>' +
      '<button class="btn soft start" type="button" data-act="allics">' + ico('bell') + ' Add every open return to my calendar</button></section>';
    out += syncCard();
    out += '<section class="stack"><h2>Your data</h2><p class="small muted">A spreadsheet of every purchase and refund, made on this device. Open it in any spreadsheet app, or bring it back here.</p>' +
      '<div class="row"><button class="btn" type="button" data-act="csvout">Export CSV</button><label class="btn ghost pick">Import CSV<input type="file" id="csvIn" accept=".csv,text/csv" class="vh"></label></div><div id="csvMsg"></div></section>';
    out += '<section class="stack"><h2>Privacy</h2><p class="small">Everything is kept in this browser: the list in its storage, photos in its database. Clearing your browser’s data clears it. Photos are shrunk on this phone and their location is removed; they never leave it.</p>' +
      '<p class="small muted">Takeback never guesses a store’s return policy - the windows and notes are yours.</p>' +
      (state.trying ? '' : '<button class="btn small ghost" type="button" data-act="clearall">Clear everything on this device</button>') + '</section>';
    return out + '</div>';
  }
  function bindSettings() {
    var sel = $('#curSel'); if (sel) sel.addEventListener('change', function () { prefs.currency = sel.value; savePrefs(); state.recapUrl = null; draw(); });
    var tm = $('#timeSel'); if (tm) tm.addEventListener('change', function () { if (/^([01]\d|2[0-3]):[0-5]\d$/.test(tm.value)) { prefs.time = tm.value; savePrefs(); toast('Reminders at ' + tm.value + '.'); } });
    var inp = $('#csvIn');
    if (inp) inp.addEventListener('change', function () {
      var file = inp.files[0]; inp.value = ''; if (!file) return;
      if (file.size > C.LIMITS.csvBytes) { $('#csvMsg').innerHTML = '<p class="err">That file is over 2 MB.</p>'; return; }
      var rd = new FileReader();
      rd.addEventListener('load', function () { importCsv(String(rd.result || '')); });
      rd.readAsText(file);
    });
  }
  function importCsv(text) {
    var r = C.fromCsv(text, ctx()), msg = $('#csvMsg');
    if (r.error) { msg.innerHTML = '<p class="err" role="alert">' + esc(r.error) + '</p>'; return; }
    if (state.trying) leaveTry(true);
    var ids = {}; data.purchases.forEach(function (p) { ids[p.id] = 1; });
    var fresh = r.purchases.filter(function (p) { return !ids[p.id]; }), same = r.purchases.length - fresh.length;
    sheet('<h2>Import ' + plural(r.purchases.length, 'purchase') + '?</h2><p>' + plural(fresh.length, 'new purchase') + (same ? ' and ' + plural(same, 'purchase') + ' already here, which the file’s copy will replace' : '') + '.' + (r.skipped ? ' ' + plural(r.skipped, 'row') + ' could not be read and will be left out.' : '') + '</p>' +
      '<div class="row"><button class="btn" type="button" id="imGo">Import</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div>', function (root) {
      $('#imGo', root).addEventListener('click', function () {
        var room = C.LIMITS.purchases - data.purchases.length;
        r.purchases.forEach(function (p) {
          var i = data.purchases.findIndex(function (x) { return x.id === p.id; });
          if (i >= 0) { p.photo = data.purchases[i].photo; data.purchases[i] = p; } else if (room-- > 0) data.purchases.push(p);
        });
        save(); closeSheet(); go(''); toast('Imported.');
      });
    });
  }

  /* sync: the list, never a photo */
  var pushTimer = null;
  function syncOn() { return Boolean(prefs.sync && signedIn() && state.me.sync); }
  function schedulePush() { clearTimeout(pushTimer); if (syncOn()) pushTimer = setTimeout(push, 1200); }
  function mine() { return C.syncPayload(data.purchases, data.notes, data.deleted); }
  function localFlags() { var m = {}; data.purchases.forEach(function (p) { m[p.id] = { photo: p.photo, dropPhoto: p.dropPhoto }; }); return m; }
  function withFlags(ps, flags) {
    return ps.map(function (p) { var f = flags[p.id]; if (f) { p.photo = f.photo; p.dropPhoto = f.dropPhoto && Boolean(p.steps.dropped); } return p; });
  }
  function setList(l, flags) {
    var o = ctx(), clean = C.cleanList(l, o).list;
    data.purchases = withFlags(clean.purchases, flags || localFlags());
    data.notes = clean.notes; data.deleted = clean.deleted;
  }
  function syncDone(version) { sync.version = version; sync.dirty = false; sync.at = now(); keep(K_SYNC, sync); state.syncErr = ''; }
  function push() {
    if (!syncOn() || state.syncBusy) return Promise.resolve();
    state.syncBusy = true;
    return api('PUT', 'api/list', { list: mine(), base: sync.version }).then(function (r) {
      state.syncBusy = false; syncDone(r.version);
      if (state.view === 'settings') draw();
    }).catch(function (err) {
      state.syncBusy = false;
      if (err.status === 409 && err.data) return openConflict(err.data);
      state.syncErr = err.offline ? 'Offline - your changes will be saved when you’re back online.' : err.message;
      if (state.view === 'settings') draw();
    });
  }
  function pull() {
    if (!syncOn()) return Promise.resolve();
    return api('GET', 'api/list').then(function (r) {
      if (!r.list) { sync.version = null; return push(); }
      if (r.version === sync.version) return sync.dirty ? push() : null;
      if (!sync.dirty && (sync.version !== null || !data.purchases.length)) { setList(r.list); saveLocal(); syncDone(r.version); state.thumbsLoaded = false; draw(); return null; }
      return openConflict(r);
    }).catch(function (err) { state.syncErr = err.offline ? 'Offline right now.' : err.message; if (state.view === 'settings') draw(); });
  }
  function openConflict(d) {
    var o = ctx(), theirs = C.cleanList(d.list, o).list, merged = C.mergeLists(mine(), d.list, o);
    sheet('<h2>Your list changed on another device</h2><p>This device and your account copy don’t match. Which should both keep?</p>' +
      '<div class="choice3"><button class="btn ghost" type="button" id="cfTheirs"><span>Use theirs</span><small>' + plural(theirs.purchases.length, 'purchase') + '</small></button>' +
      '<button class="btn ghost" type="button" id="cfMine"><span>Keep mine</span><small>' + plural(data.purchases.length, 'purchase') + '</small></button>' +
      '<button class="btn" type="button" id="cfMerge"><span>Merge by item</span><small>' + plural(merged.purchases.length, 'purchase') + '</small></button></div>' +
      '<p class="tiny muted mt12">Merging keeps every purchase from both, and the later edit of anything changed on both. Photos are never synced, so they stay where they are.</p>', function (root) {
      $('#cfTheirs', root).addEventListener('click', function () { setList(d.list); saveLocal(); syncDone(d.version); closeSheet(); state.thumbsLoaded = false; draw(); toast('Using the account copy.'); });
      $('#cfMine', root).addEventListener('click', function () { sync.version = d.version; sync.dirty = true; closeSheet(); push().then(function () { toast('Kept this device’s list.'); }); });
      $('#cfMerge', root).addEventListener('click', function () { setList(merged); saveLocal(); sync.version = d.version; sync.dirty = true; closeSheet(); draw(); push().then(function () { toast('Merged.'); }); });
    });
  }
  function turnSyncOn() {
    prefs.sync = true; savePrefs();
    if (data.purchases.length) sync.dirty = true;
    keep(K_SYNC, sync);
    pull().then(function () { if (state.view === 'settings') draw(); });
  }

  /* ---------------- sheets and the account ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn close" type="button" data-act="closesheet" aria-label="Close">×</button>' + html;
    s.hidden = false; back.hidden = false; document.body.classList.add('sheet-open'); s.scrollTop = 0;
    // The shared "confirm your email" banner sits above everything at the top
    // of the page; keep the sheet (and its Close button) clear of it.
    var vb = document.getElementById('stc-verify-banner'), off = vb ? Math.max(0, vb.getBoundingClientRect().bottom) : 0;
    s.classList.remove('under-1', 'under-2', 'under-3');
    if (off) s.classList.add(off <= 64 ? 'under-1' : off <= 104 ? 'under-2' : 'under-3');
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2'); if (f) f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f && !s.contains(document.activeElement)) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); var c = $('#aiCard'); if (c) c.outerHTML = aiCard(); return me; })
      .catch(function () { state.me = state.me || { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var FREE_LINE = 'Takeback is free with no account, and your list stays on this device. A free account adds sync between a phone and a laptop (only if you turn it on) and the receipt reader - it comes with $2 of AI credit, and one account works across every app on this site.';
  function openAccount(reason, then, start) {
    var mode = start === 'login' ? 'login' : 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field my12"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field my12"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block mt12" id="pkBtn" type="button">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center mt12">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      $('#swap', root).addEventListener('click', function () { mode = mode === 'register' ? 'login' : 'register'; draw2(root); });
      $('#authForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); if (prefs.sync) pull(); if (then) then(); else draw(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { if (prefs.sync) pull(); if (then) then(); else draw(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openAccountSheet() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted mt8">Reading a receipt costs about a cent. Everything else is free.</p><div id="billing"></div></div>' +
      '<p class="small muted mt12">' + (prefs.sync ? 'Sync is on: your list (never your photos) is kept with this account.' : 'Your list is not in your account - it stays on this device unless you turn on sync in Settings.') + '</p>' +
      (pkOk() ? '<button class="btn ghost block mt12" id="pkEnrol" type="button">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block mt12" id="signOut" type="button">Sign out</button>',
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((d && d.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Adding by hand, the countdowns and the refund watch keep working, free.</p><div id="billing"></div>' +
      (d && d.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(d.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- clicks ---------------- */

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); closeSheet(true); go(''); break;
      case 'tab': closeSheet(true); go(t.getAttribute('data-tab') === 'home' ? '' : t.getAttribute('data-tab')); break;
      case 'try': startTry(); break;
      case 'tryleave': leaveTry(); toast('That was the made-up list - nothing was saved.'); break;
      case 'tryadd': case 'addfirst': leaveTry(true); state.form = null; go('add'); break;
      case 'filter': prefs.filter = t.getAttribute('data-f'); savePrefs(); draw(); break;
      case 'open': closeSheet(true); openPurchase(id); break;
      case 'keep': doDecide(id, 'keep'); break;
      case 'return': doDecide(id, 'return'); break;
      case 'undecide': doDecide(id, null); break;
      case 'step': doStep(id, t.getAttribute('data-step')); break;
      case 'unstep': undoStep(id, t.getAttribute('data-step')); break;
      case 'refund': closeSheet(true); openRefund(id); break;
      case 'unrefund': { var q0 = find(id); if (q0) { put(C.clearRefund(q0, ctx())); draw(); openPurchase(id); } break; }
      case 'followup': closeSheet(true); openFollowUp(id); break;
      case 'remind': closeSheet(true); openRemind(id); break;
      case 'edit': closeSheet(true); state.form = null; go('add/' + id); break;
      case 'canceledit': state.form = null; go(''); break;
      case 'delete': {
        var pd = find(id); if (!pd) break;
        if (!confirm('Delete “' + pd.item + '”' + (state.trying ? '' : ' and its photos') + '? This can’t be undone.')) break;
        removePurchase(id); closeSheet(true); draw(); toast('Deleted.');
        break;
      }
      case 'reader': openReader(); break;
      case 'recapimg': t.disabled = true; drawRecap().catch(function (err) { t.disabled = false; showError(err); }); break;
      case 'recapshare': shareRecap(); break;
      case 'storenote': openStoreNote(t.getAttribute('data-store')); break;
      case 'allics': allReminders(); break;
      case 'csvout': download('takeback-' + today() + '.csv', 'text/csv', C.purchasesCsv(list(), { currency: cur() })); toast('Downloaded - made on this device.'); break;
      case 'signin': openAccount('Create a free account to sync your list between devices.', function () { draw(); }); break;
      case 'signin-login': openAccount('Sign in to sync your list between devices.', function () { draw(); }, 'login'); break;
      case 'syncon': turnSyncOn(); break;
      case 'syncnow': pull().then(function () { toast(sync.dirty ? 'Saving…' : 'Up to date.'); }); break;
      case 'syncoff': prefs.sync = false; savePrefs(); draw(); toast('Sync is off. The account copy is still there.'); break;
      case 'syncdel':
        if (!confirm('Turn sync off and delete the copy in your account? This device keeps its list.')) break;
        api('DELETE', 'api/list').then(function () { prefs.sync = false; savePrefs(); sync = { version: null, dirty: false }; keep(K_SYNC, sync); draw(); toast('The account copy is deleted.'); }).catch(function (err) { showError(err); });
        break;
      case 'clearall': {
        if (!confirm('Clear everything Takeback keeps on this device - purchases, notes and photos? This can’t be undone.')) break;
        data.purchases.forEach(function (p) { if (p.photo) photoDel('r-' + p.group); if (p.dropPhoto) photoDel('d-' + p.id); });
        data = { v: 1, purchases: [], notes: {}, deleted: [] }; saveLocal();
        prefs.sync = false; savePrefs(); sync = { version: null, dirty: false }; keep(K_SYNC, sync);
        state.recapUrl = null; state.recapBlob = null;
        go(''); toast('Cleared.');
        break;
      }
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
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (syncOn()) pull();
    if ($('#sheet').hidden && state.view !== 'add') draw();
  });
  drawTop();
  route();
  loadMe().then(function () {
    if (syncOn()) pull();
    if (state.view === 'settings') draw();
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openAccountSheet();
  });
}());
