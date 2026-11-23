/* Pawlog - the page. One file, no build step. Every string that came from
 * outside this file (a typed name, a pet's notes, a medicine, a household
 * member's name, a model's answer, anything from the server) is escaped
 * before it is drawn, and no handler is written into markup: clicks are
 * routed by data-act attributes from one listener (the lab's CSP allows
 * script from this origin only). The rules - what is due, the board, the
 * guard, undo, health, the week, the calendar file - are pawlog-core.js,
 * the same file the server and the tests run.
 *
 * Modes: none (the first run), local (a household only on this phone, the
 * sample included), owner (this phone shared it and holds the key), member
 * (opened from the household link, h/<CODE>), sitter (a sitter link,
 * s/<CODE>) and preview (the sample's sitter page). Local changes run the
 * core here; the others post the same change to the server, which runs the
 * core in a transaction.
 *
 * Where things live: this phone's own household (or the keys to the shared
 * one) in localStorage `pawlog-home-v1`, who you are in each household in
 * `pawlog-me-v1`, the last household link opened in `pawlog-joined-v1`, the
 * tab in `pawlog-tab-v1`.
 */
(function () {
  'use strict';

  var C = window.PawlogCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_HOME = 'pawlog-home-v1';
  var K_ME = 'pawlog-me-v1';
  var K_JOINED = 'pawlog-joined-v1';
  var K_TAB = 'pawlog-tab-v1';
  var TABS = ['today', 'health', 'week', 'home'];
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var PHOTO_PX = 1600;
  var ROUTE = (function () {
    var rel = location.pathname.indexOf(BASE) === 0 ? location.pathname.slice(BASE.length) : '';
    var m = /^([hso])\/([A-Z2-9]{10})$/.exec(rel);
    return m ? { kind: m[1], code: m[2] } : null;
  }());
  var PHONE_TZ = (function () { try { return C.cleanTz(Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC'; } catch (e) { return 'UTC'; } }());

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ids(p) { var a = new Uint8Array(11); crypto.getRandomValues(a); return p + Array.prototype.map.call(a, function (x) { return 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]; }).join(''); }
  var plural = C.plural;

  /* Thin line icons, one stroke width, drawn from this table only. */
  var ICONS = {
    feed: '<path d="M3.5 11.5h17a8.5 8.5 0 0 1-17 0z"/><path d="M8.5 20h7"/>',
    walk: '<ellipse cx="12" cy="15.5" rx="4" ry="3.2"/><circle cx="6.5" cy="10.5" r="1.6"/><circle cx="10" cy="6.8" r="1.6"/><circle cx="14" cy="6.8" r="1.6"/><circle cx="17.5" cy="10.5" r="1.6"/>',
    litter: '<path d="M4 10.5h16l-1.5 8h-13z"/><path d="M8 10.5V7.5M12 10.5v-5M16 10.5v-3"/>',
    water: '<path d="M12 3.5c3 4 5.5 6.8 5.5 10a5.5 5.5 0 0 1-11 0c0-3.2 2.5-6 5.5-10z"/>',
    clean: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5L9 9M15 15l2.5 2.5M17.5 6.5L15 9M9 15l-2.5 2.5"/>',
    play: '<circle cx="12" cy="12" r="8.5"/><path d="M5.6 6.8c3.6 1.7 5 5.6 4 10.6M18.4 17.2c-3.6-1.7-5-5.6-4-10.6"/>',
    meds: '<rect x="3" y="8.5" width="18" height="7" rx="3.5" transform="rotate(-45 12 12)"/><path d="M9.6 9.6l4.8 4.8"/>',
    other: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>',
    vaccine: '<path d="M17 3l4 4M19 5l-3 3M14.5 6.5l3 3L9 18H6v-3zM6 18l-3 3M11 10l1.5 1.5"/>',
    shield: '<path d="M12 3.5l7 2.5v5.5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z"/>',
    visit: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>',
    doc: '<path d="M7 3.5h7l4 4v13H7zM14 3.5v4h4M9.5 12h6M9.5 15.5h6"/>',
    camera: '<path d="M4 8.5h3l1.5-2.5h7L17 8.5h3v10H4z"/><circle cx="12" cy="13" r="3.2"/>',
    calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
    phone: '<path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>',
    lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.5 3.5-5.5 7-5.5s6.2 2 7 5.5"/>',
    flame: '<path d="M12 3.5c1 3.5 5 5.2 5 10a5 5 0 0 1-10 0c0-1.8.8-3 1.8-4 .4 1.6 1.2 2.4 2.2 2.6-.6-3 .2-6 1-8.6z"/>',
    alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.2v.3"/>',
    home: '<path d="M4 11l8-6.5 8 6.5v9H4zM9.5 20v-5.5h5V20"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    tap: '<path d="M9 11.5V5.8a1.6 1.6 0 0 1 3.2 0v5M12.2 10.2a1.6 1.6 0 0 1 3.2 0v1M15.4 11a1.6 1.6 0 0 1 3.1.5v3.5a5.5 5.5 0 0 1-5.5 5.5h-1.2a5 5 0 0 1-4-2l-3-4.3a1.5 1.5 0 0 1 2.3-1.9L9 14.5"/>',
    weight: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8.5 9.5a4.5 4.5 0 0 1 7 0M12 9.5l1.5-2"/>',
  };
  var TASK_ICONS = { feed: 'feed', walk: 'walk', litter: 'litter', water: 'water', clean: 'clean', play: 'play', meds: 'meds' };
  var HEALTH_ICONS = { vaccine: 'vaccine', flea: 'shield', worm: 'shield', visit: 'visit', med: 'meds' };
  function icon(name) {
    return '<svg class="ic" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || ICONS.other) + '</svg>';
  }
  function taskIcon(id) { return icon(TASK_ICONS[id] || 'other'); }
  function healthIcon(id) { return icon(HEALTH_ICONS[id] || 'doc'); }
  /** Which reader the server uses: "gemini" transcribes each medicine field
   *  by field for you to confirm; anything else is the older tick list. */
  function reader() { return state.account && state.account.reader === 'gemini' ? 'gemini' : 'claude'; }
  function paperTitle() { return reader() === 'gemini' ? 'Snap the vet paperwork' : 'Read the vet paperwork'; }
  var CHECK_LINE = 'Check every detail against the label, and ask your vet if you’re unsure.';

  var state = {
    mode: 'none',
    doc: null,          // the household (or the sitter's slice of it)
    code: null,         // owner: the home's code; member, sitter: the link's
    key: null,          // owner only
    owner: null,        // owner: {link, sitters}
    savedAt: 0,         // local: when this phone last changed it
    me: null,           // the member id this phone is
    tab: 'today',
    pet: null,          // the pet picked on Health and Week
    account: null,      // /api/me
    gone: null,         // a link that no longer opens
    just: null,         // the row just ticked, for its little pop
    armed: null,        // a destructive tap waiting for its second
    preview: null,      // the sample's sitter page: {name, until}
    ai: null,           // the paperwork sheet
  };
  var main = $('#main');

  /* ---------------- plumbing ---------------- */

  function api(method, path, body, headers) {
    var h = {};
    if (body) h['Content-Type'] = 'application/json';
    for (var k in headers || {}) h[k] = headers[k];
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
  /** A short message, with an optional button (Undo) routed by data-act. */
  function toast(msg, ms, button) {
    $$('.toast').forEach(function (old) { old.remove(); });
    clearTimeout(toastTimer);
    if (!msg) return;
    var t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    var s = document.createElement('span');
    s.textContent = msg;
    t.appendChild(s);
    if (button) {
      var b = document.createElement('button');
      b.className = 'btn small'; b.type = 'button';
      b.textContent = button.label;
      b.setAttribute('data-act', button.act);
      for (var k in button.data || {}) b.setAttribute('data-' + k, button.data[k]);
      t.appendChild(b);
    }
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, ms || Math.min(6500, 2600 + msg.length * 30));
  }
  function say(msg) { var l = $('#live'); if (l) { l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); } }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.account && state.account.signedIn); }
  function syncOn() { return signedIn() && state.account.sync !== false; }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function now() { return Date.now(); }
  function tz() { return (state.doc && state.doc.tz) || PHONE_TZ; }
  function today() { return C.zoned(now(), tz()).day; }
  function isSample() { return Boolean(state.mode === 'local' && state.doc && state.doc.sample); }
  function petOf(id) { return ((state.doc && state.doc.pets) || []).filter(function (p) { return p.id === id; })[0] || null; }
  function memberOf(id) { return ((state.doc && state.doc.members) || []).filter(function (m) { return m.id === id; })[0] || null; }
  function emojiOf(p) { return C.kindOf(p && p.kind).emoji; }
  function units() { return (state.doc && state.doc.units) || 'lb'; }
  function ctxKey() { return state.mode === 'local' ? 'local' : state.mode === 'owner' ? 'o:' + state.code : state.mode === 'member' ? 'h:' + state.code : null; }
  function loadMe() { var all = recall(K_ME) || {}; var id = ctxKey() && all[ctxKey()]; state.me = id && memberOf(id) ? id : null; }
  function saveMe(id) { var all = recall(K_ME) || {}; if (ctxKey()) { all[ctxKey()] = id; keep(K_ME, all); } state.me = id; }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function linkUrl(kind, code) { return location.origin + BASE + kind + '/' + code; }
  function share(title, text, url) {
    if (navigator.share) { navigator.share({ title: title, text: text, url: url }).catch(function () { /* cancelled */ }); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(text + ' ' + url).then(function () { toast('Copied - paste it into a message.'); }, function () { toast('Copy the link from the box.'); });
    else toast('Copy the link from the box.');
  }
  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4600);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err mt0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else works meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).addEventListener('click', function () {
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { toast('Sent - check your email.'); }, function () { toast('Could not send it. Try again in a minute.'); });
    });
  }

  /* ---------------- this phone's household ---------------- */

  function saveLocal() {
    if (state.mode === 'local') { state.savedAt = now(); keep(K_HOME, { mode: 'local', doc: state.doc, savedAt: state.savedAt }); pushMine(); }
    else if (state.mode === 'owner') keep(K_HOME, { mode: 'owner', code: state.code, key: state.key, cache: state.doc, owner: state.owner, savedAt: state.savedAt });
  }
  function loadOwn() {
    var h = recall(K_HOME);
    if (!h || typeof h !== 'object') return false;
    if (h.mode === 'local' && h.doc) {
      var sample = h.doc.sample === true;
      var d = C.cleanHome(h.doc, now(), PHONE_TZ);
      if (!d.pets.length && !sample) return false;
      if (sample) d.sample = true;
      state.mode = 'local'; state.doc = d; state.savedAt = h.savedAt || 0;
      return true;
    }
    if (h.mode === 'owner' && /^[A-Z2-9]{10}$/.test(h.code || '') && /^[A-Za-z0-9_-]{22}$/.test(h.key || '')) {
      state.mode = 'owner'; state.code = h.code; state.key = h.key; state.savedAt = h.savedAt || 0;
      state.doc = h.cache ? C.cleanHome(h.cache, now(), PHONE_TZ) : null;
      if (state.doc && h.cache) state.doc.v = -1; // always ask afresh
      state.owner = h.owner || null;
      return true;
    }
    return false;
  }

  /** Run one change: here for a household on this phone, on the server for
   *  a shared one. Errors come back in one shape either way. */
  function doAct(action, args) {
    var b = Object.assign({ action: action }, args || {});
    if (state.mode === 'local' || state.mode === 'preview') {
      return new Promise(function (resolve, reject) {
        try {
          var copy = clone(state.doc);
          var res = C.act(copy, { role: 'owner' }, action, b, now(), ids);
          if (state.doc.sample) copy.sample = true;
          state.doc = copy; saveLocal();
          resolve(res);
        } catch (e) {
          var err = new Error(e.message || 'Something went wrong.');
          err.status = e.status || 400;
          err.data = { code: e.code, by: e.by, at: e.at, when: e.when, mine: e.mine, key: e.key, dose: e.dose };
          if (!e.status) console.error(e);
          reject(err);
        }
      });
    }
    var path = state.mode === 'owner' ? 'api/homes/' + state.code + '/act' : 'api/l/' + state.code + '/act';
    return api('POST', path, b, state.mode === 'owner' ? { 'X-Pawlog-Key': state.key } : null).then(function (r) {
      applyRemote(r);
      return r.result;
    }).catch(function (e) {
      if (e.status === 404 && !(e.data && e.data.code)) { state.gone = e.message; draw(); }
      throw e;
    });
  }
  function applyRemote(r) {
    if (!r || r.same) return;
    state.doc = r.home;
    if (state.mode === 'owner') { state.owner = { link: r.link, sitters: r.sitters || [] }; saveLocal(); }
    if (state.mode === 'member' || state.mode === 'owner') loadMe();
  }
  /** Ask the server again. `?since=v` keeps a 20-second poll to one small
   *  read when nothing moved. */
  var fetching = false;
  function fetchRemote() {
    if (fetching || ['owner', 'member', 'sitter'].indexOf(state.mode) < 0 || state.gone) return Promise.resolve();
    fetching = true;
    var path = state.mode === 'owner' ? 'api/homes/' + state.code : 'api/l/' + state.code;
    var since = state.doc && state.doc.v >= 0 ? '?since=' + state.doc.v : '';
    return api('GET', path + since, null, state.mode === 'owner' ? { 'X-Pawlog-Key': state.key } : null).then(function (r) {
      fetching = false;
      if (r.same) return;
      if (state.mode !== 'owner' && r.role && r.role !== state.mode) state.mode = r.role;
      applyRemote(r);
      if (state.mode === 'member') keep(K_JOINED, { code: state.code, name: state.doc.name });
      redraw();
    }).catch(function (e) {
      fetching = false;
      if (e.status === 404) { state.gone = e.message; draw(); }
    });
  }

  /* ---------------- the account: the owner's household follows them ---------------- */

  var pushTimer = null;
  function pushMine() {
    if (!syncOn() || isSample() || (state.mode !== 'local' && state.mode !== 'owner')) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      var body = state.mode === 'owner' ? { shared: { code: state.code, key: state.key }, updatedAt: state.savedAt || now() } : { home: state.doc, updatedAt: state.savedAt || now() };
      api('PUT', 'api/mine', body).catch(function (e) { if (e.status !== 401) toast(e.message); });
    }, 1200);
  }
  /** Signed in: the newer of this phone's household and the account's wins. */
  function syncIn(announce) {
    if (!syncOn()) return Promise.resolve();
    return api('GET', 'api/mine').then(function (acc) {
      var mine = (state.mode === 'local' && !isSample()) || state.mode === 'owner';
      var theirs = acc.home || acc.shared;
      if (mine && (!theirs || (acc.updatedAt || 0) <= (state.savedAt || 0))) {
        if (!state.savedAt) state.savedAt = now();
        pushMine();
        if (announce) toast('Signed in. Your household now follows you to any phone you sign in on.');
        return;
      }
      if (!theirs || (state.mode !== 'none' && state.mode !== 'local' && state.mode !== 'owner')) { if (announce) toast('Signed in.'); return; }
      if (acc.shared) {
        state.mode = 'owner'; state.code = acc.shared.code; state.key = acc.shared.key; state.doc = null; state.savedAt = acc.updatedAt || now();
        saveLocal(); draw(); fetchRemote();
      } else {
        state.mode = 'local'; state.doc = C.cleanHome(acc.home, now(), PHONE_TZ); state.savedAt = acc.updatedAt || now();
        keep(K_HOME, { mode: 'local', doc: state.doc, savedAt: state.savedAt }); loadMe(); draw();
      }
      toast('Your household is back from your account.');
    }).catch(function (e) { if (e.status !== 401 && e.status !== 503) toast(e.message); });
  }

  /* ---------------- drawing helpers ---------------- */

  function ring(done, total) {
    var r = 22, c = 2 * Math.PI * r, f = total ? done / total : 0;
    return '<div class="ring" role="img" aria-label="' + done + ' of ' + total + ' done"><svg viewBox="0 0 54 54" width="54" height="54" aria-hidden="true"><circle class="bgc" cx="27" cy="27" r="' + r + '" fill="none" stroke-width="6"/><circle class="fgc" cx="27" cy="27" r="' + r + '" fill="none" stroke-width="6" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (c * (1 - f)).toFixed(1) + '"/></svg><b>' + done + '/' + total + '</b></div>';
  }
  function petMeta(p) {
    var bits = [C.kindOf(p.kind).label];
    if (p.birthday) bits.push(C.ageWords(p.birthday, today()));
    var w = state.doc.weights ? C.weightsOf(state.doc, p.id) : [];
    if (w.length) bits.push(C.fmtWeight(w[w.length - 1].g, units()));
    return bits.join(' · ');
  }
  function taskRow(row) {
    var t = C.taskOf(row.task);
    var cls = 'task' + (row.log ? ' is-done' : row.state === 'overdue' ? ' is-over' : row.state === 'now' ? ' is-now' : '') + (state.just === row.key ? ' just' : '');
    var sub = row.log ? esc(C.doneWords(row, tz()))
      : esc(C.windowWords(row)) + (row.state === 'overdue' ? ' <span class="chip over">Overdue</span>' : row.state === 'now' ? ' <span class="chip now">Due now</span>' : '');
    var label = row.log ? 'Done: ' : row.state === 'overdue' ? 'Overdue: ' : '';
    return '<button class="' + cls + '" type="button" data-act="task" data-key="' + esc(row.key) + '" aria-label="' + esc(label + row.label + ', ' + (row.log ? C.doneWords(row, tz()) : C.windowWords(row)) + (row.log ? '' : '. Tap to mark done.')) + '">' +
      '<span class="te" aria-hidden="true">' + (row.kind === 'dose' ? icon('meds') : taskIcon(row.task)) + '</span>' +
      '<span class="tt"><b>' + esc(row.label) + '</b><small>' + sub + '</small></span>' +
      '<span class="tick" aria-hidden="true"></span></button>';
  }
  function petBoard(pb) {
    var p = pb.pet;
    var rows = pb.rows.length ? pb.rows.map(taskRow).join('') : '<p class="empty">Nothing due today.</p>';
    var all = pb.total && pb.done === pb.total ? '<p class="allset">' + icon('other') + '<span>All done for ' + esc(p.name) + ' today.</span></p>' : '';
    return '<section class="pet" aria-label="' + esc(p.name) + '"><div class="pet-head"><span class="pet-av" aria-hidden="true">' + esc(emojiOf(p)) + '</span><div><h2>' + esc(p.name) + '</h2><span class="w">' +
      (pb.overdue ? '<span class="chip over">' + esc(plural(pb.overdue, 'thing') + ' overdue') + '</span>' : pb.total ? esc(pb.done + ' of ' + pb.total + ' done') : 'Nothing due') + '</span></div>' + ring(pb.done, pb.total) + '</div>' +
      '<div class="rows">' + rows + '</div>' + all + '</section>';
  }
  function sampleStrip() {
    if (!isSample()) return '';
    return '<div class="strip" role="note"><p><b>A sample home.</b> Biscuit, Miso and three made-up people - you’re Alex. Tap anything; nothing leaves this phone.</p>' +
      '<div class="row"><button class="btn small" type="button" data-act="mine">Start my own</button><button class="btn small ghost" type="button" data-act="clearsample">Clear</button></div></div>';
  }

  /* ---------------- the views ---------------- */

  function draw() {
    var tabbed = (state.mode === 'local' || state.mode === 'owner' || state.mode === 'member') && state.doc && !state.gone && (state.me || state.mode !== 'member');
    $('#tabbar').hidden = !tabbed;
    $$('#tabbar [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === state.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var who = $('#who');
    var m = state.me && memberOf(state.me);
    who.hidden = !tabbed;
    who.textContent = m ? m.name : 'Who are you?';
    $('#acct').hidden = state.mode === 'sitter' || state.mode === 'preview';
    if (state.gone) { main.innerHTML = goneView(); return; }
    if (state.mode === 'none') { main.innerHTML = firstRun(); return; }
    if (state.mode === 'sitter' || state.mode === 'preview') { main.innerHTML = state.doc ? sitterPage() : loading(); return; }
    if (!state.doc) { main.innerHTML = loading(); return; }
    if (state.mode === 'member' && !state.me) { main.innerHTML = whoView(); return; }
    var html = sampleStrip();
    if (state.tab === 'health') html += healthView();
    else if (state.tab === 'week') html += weekView();
    else if (state.tab === 'home') html += homeView();
    else html += todayView();
    main.innerHTML = html;
  }
  /** A redraw that keeps the scroll and leaves an open sheet alone. */
  function redraw() { var y = scrollY; draw(); scrollTo(0, y); }
  function loading() { return '<p class="muted center mt40">Opening…</p>'; }
  function goneView() {
    return '<section class="first"><div class="hero"><p class="eyebrow">Pawlog</p><h1>This link isn’t open any more</h1><p class="lede">' + esc(state.gone) + '</p>' +
      '<div class="choices"><button class="choice" type="button" data-act="forget"><span class="ci" aria-hidden="true">' + icon('home') + '</span><span class="ct"><b>Go to Pawlog</b><span>Start your own household, or try the sample.</span></span><span class="chev" aria-hidden="true">›</span></button></div></div></section>';
  }

  function firstRun() {
    return '<section class="first">' +
      '<div class="hero">' +
      '<p class="eyebrow">Pet care for the whole house</p>' +
      '<h1>Fed? Walked? Meds given? <em>The whole house knows.</em></h1>' +
      '<p class="lede">One tap marks it done, with who and when - so the dog never gets two breakfasts and nobody misses a dose.</p>' +
      '<div class="hero-acts"><button class="btn big" type="button" data-act="sample">Try a sample home</button><button class="btn big ghost" type="button" data-act="setup">Set up my pet</button></div>' +
      '<p class="got-link">Got a link from your household or a pet owner? Just open it - no app, no account.</p></div>' +
      '<div class="mock" aria-hidden="true"><div class="pet"><div class="pet-head"><span class="pet-av">🐕</span><div><h2>Biscuit</h2><span class="w">2 of 3 done</span></div>' + ring(2, 3) + '</div><div class="rows">' +
      '<div class="task is-done"><span class="te">' + icon('feed') + '</span><span class="tt"><b>Breakfast</b><small>Fed by Sam 7:42am</small></span><span class="tick"></span></div>' +
      '<div class="task is-done"><span class="te">' + icon('walk') + '</span><span class="tt"><b>Morning walk</b><small>Walked by Alex 8:10am</small></span><span class="tick"></span></div>' +
      '<div class="task is-over"><span class="te">' + icon('meds') + '</span><span class="tt"><b>Ear drops · 4 drops</b><small>8:00am <span class="chip over">Overdue</span></small></span><span class="tick"></span></div>' +
      '</div></div><p class="mock-bubble"><b>Already fed by Sam at 7:42am.</b> Do it again?</p></div>' +
      '<h2 class="how-title">How it works</h2><ol class="how">' +
      '<li><span class="n" aria-hidden="true">' + icon('walk') + '</span><div><b>Add your pets</b><p>Dog, cat, rabbit, bird, fish or reptile - each starts with a routine you can change: meals, walks, litter, water changes, each with a time window.</p></div></li>' +
      '<li><span class="n" aria-hidden="true">' + icon('tap') + '</span><div><b>Tap it when it’s done</b><p>Everyone sees “Fed by Sam 7:42am”. A second tap within half an hour asks first. Overdue things stand out.</p></div></li>' +
      '<li><span class="n" aria-hidden="true">' + icon('link') + '</span><div><b>One link for the house, one for the sitter</b><p>No app, no account. The sitter sees the routine, your notes and the vet’s number - until the day you’re back.</p></div></li>' +
      '<li><span class="n" aria-hidden="true">' + icon('camera') + '</span><div><b>Medicines and due dates, handled</b><p>Courses with an end date, boosters and flea treatments with reminders in your own calendar. Sign in and AI can read the vet’s paperwork for you to check.</p></div></li>' +
      '</ol>' +
      '<p class="promise">' + icon('lock') + '<span><b>Stays on your phone until you share it.</b> No account and no ads. Share one link with the people at home, and a sitter link that closes the day you’re back. First names only.</span></p>' +
      '</section>';
  }

  function whoView() {
    var d = state.doc;
    return '<section class="first"><div class="hero"><p class="eyebrow">' + esc(d.name) + '</p><h1>Who are you?</h1><p class="lede">Pick your name so everyone sees who fed, walked and gave the meds. First names only.</p>' +
      '<div class="whoami">' + d.members.map(function (m, i) {
        return '<button class="choice" type="button" data-act="iam" data-id="' + esc(m.id) + '"><span class="ci" aria-hidden="true"><span class="person"><span class="av c' + ((i % 6) + 1) + '">' + esc(m.name.charAt(0)) + '</span></span></span><span class="ct"><b>' + esc(m.name) + '</b></span><span class="chev" aria-hidden="true">›</span></button>';
      }).join('') +
      '<form id="joinForm" class="card m4t"><label class="field mt0"><span>Someone new? Add your first name</span><input class="input" id="joinName" maxlength="' + C.LIMITS.name + '" autocomplete="given-name" placeholder="Jamie" required></label><div id="joinErr"></div><button class="btn block" type="submit">That’s me</button></form>' +
      '</div></div></section>';
  }

  function todayView() {
    var d = state.doc;
    var b = C.board(d, now());
    var soon = C.dueSoon(d, b.day, 14);
    var head = '<div class="page-title"><h1>Today</h1><span class="sum">' + esc(C.WEEKDAYS[C.weekday(b.day)] + ', ' + C.fmtDay(b.day, b.day)) + ' · ' + esc(b.done + ' of ' + b.total + ' done') + (b.overdue ? ' · ' + esc(b.overdue + ' overdue') : '') + '</span></div>';
    var soonHtml = soon.length ? '<button class="soonline" type="button" data-act="tab" data-tab="health">' + healthIcon(soon[0].type) + '<span class="st"><b>' + esc(soon[0].petName + ': ' + soon[0].title) + '</b> · ' + esc(soon[0].words.toLowerCase()) + (soon.length > 1 ? ' · ' + esc(plural(soon.length - 1, 'more thing')) + ' soon' : '') + '</span><span aria-hidden="true">›</span></button>' : '';
    if (!d.pets.length) return head + '<section class="card"><p>No pets yet.</p><button class="btn" type="button" data-act="addpet">Add a pet</button></section>';
    return head + soonHtml + '<div class="pets">' + b.pets.map(petBoard).join('') + '</div>' +
      '<p class="fine">Tap when it’s done. A second tap within ' + C.LIMITS.guardMin + ' minutes asks first; you can undo for ' + C.LIMITS.undoMin + ' minutes.' + (state.mode !== 'local' ? ' Everyone with the link sees it within seconds.' : '') + '</p>';
  }

  function pickPet() {
    var pets = state.doc.pets;
    if (!state.pet || !petOf(state.pet)) state.pet = pets.length ? pets[0].id : null;
    if (pets.length < 2) return '';
    return '<div class="pills mb12" role="group" aria-label="Pet">' + pets.map(function (p) {
      return '<button class="pill" type="button" data-act="pickpet" data-id="' + esc(p.id) + '" aria-pressed="' + (p.id === state.pet) + '">' + esc(emojiOf(p) + ' ' + p.name) + '</button>';
    }).join('') + '</div>';
  }

  function healthView() {
    var d = state.doc, t = today();
    var soon = C.dueSoon(d, t);
    var html = '<div class="page-title"><h1>Health</h1></div>' +
      '<div class="acts"><button class="btn" type="button" data-act="paper">' + icon('camera') + esc(paperTitle()) + '</button><button class="btn ghost" type="button" data-act="ics">' + icon('calendar') + 'Add to my calendar</button></div>';
    html += '<section class="card"><div class="sec mt0"><h2>Due soon</h2><span class="ct">next ' + C.LIMITS.soonDays + ' days</span></div>' +
      (soon.length ? '<ul class="list">' + soon.map(function (s) {
        return '<li class="li' + (s.overdue ? ' is-over' : s.inDays <= 7 ? ' is-soon' : '') + '"><span class="le" aria-hidden="true">' + healthIcon(s.type) + '</span><span class="lt"><b>' + esc(s.petName + ': ' + s.title) + '</b><small>' + esc(s.words + ' · ' + C.relDay(s.day, t)) + '</small></span>' +
          (s.kind === 'health' ? '<span class="la"><button class="btn small soft" type="button" data-act="given" data-id="' + esc(s.id) + '">Done today</button></span>' : '<span class="la"></span>') + '</li>';
      }).join('') + '</ul>' : '<p class="empty">Nothing due in the next ' + C.LIMITS.soonDays + ' days.</p>') +
      '</section>';
    if (!d.pets.length) return html;
    html += pickPet();
    var p = petOf(state.pet);
    var meds = d.meds.filter(function (m) { return m.pet === p.id; });
    var active = meds.filter(function (m) { return C.medStatus(m, t).id !== 'ended'; });
    var ended = meds.filter(function (m) { return C.medStatus(m, t).id === 'ended'; });
    html += '<section class="card"><div class="sec mt0"><h2>' + esc(emojiOf(p) + ' ' + p.name.concat(': medicines')) + '</h2><button class="btn small ghost" type="button" data-act="med">+ Add</button></div>' +
      (active.length ? '<ul class="list">' + active.map(function (m) { return medRow(m, t); }).join('') + '</ul>' : '<p class="empty">No medicines right now. Add a course and each dose appears on Today.</p>') +
      (ended.length ? '<p class="small muted m8t">Finished: ' + ended.map(function (m) { return esc(m.name + ' (' + C.fmtDay(m.until, t) + ')'); }).join(', ') + '</p>' : '') + '</section>';
    var recs = d.health.filter(function (h) { return h.pet === p.id; }).sort(function (a, b) { return (a.due || '9999') < (b.due || '9999') ? -1 : 1; });
    html += '<section class="card"><div class="sec mt0"><h2>Vaccinations, treatments and visits</h2><button class="btn small ghost" type="button" data-act="health">+ Add</button></div>' +
      (recs.length ? '<ul class="list">' + recs.map(function (h) { return healthRow(h, t); }).join('') + '</ul>' : '<p class="empty">Add a vaccination, a flea or worm treatment, or a vet visit - with its due date, it goes on “Due soon” and in your calendar.</p>') + '</section>';
    html += weightCard(p, t);
    html += vetCard(true);
    return html;
  }
  function medRow(m, t) {
    var s = C.medStatus(m, t);
    var times = m.times.map(C.fmtTime).join(' & ');
    return '<li class="li' + (s.left !== undefined && s.left !== null && s.left <= 2 ? ' is-soon' : '') + '"><span class="le" aria-hidden="true">' + icon('meds') + '</span><span class="lt"><b>' + esc(m.name) + (m.dose ? ' · ' + esc(m.dose) : '') + '</b><small>' + esc(C.repeatWords(m.repeat) + ' at ' + times + ' · ' + s.words) + '</small></span>' +
      '<span class="la"><button class="btn small ghost" type="button" data-act="med" data-id="' + esc(m.id) + '">Edit</button>' + (s.id !== 'ended' ? '<button class="btn small danger" type="button" data-act="stopmed" data-id="' + esc(m.id) + '">Stop</button>' : '') + '</span></li>';
  }
  function healthRow(h, t) {
    var n = h.due ? C.daysBetween(t, h.due) : null;
    var bits = [];
    if (h.given) bits.push((h.type === 'visit' ? 'Last ' : 'Given ') + C.fmtDay(h.given, t));
    if (h.due) bits.push(n < 0 ? C.dueWords(n) : C.dueWords(n) + ' (' + C.fmtDay(h.due, t) + ')');
    if (h.everyMonths) bits.push(h.everyMonths === 1 ? 'every month' : 'every ' + h.everyMonths + ' months');
    return '<li class="li' + (n !== null && n < 0 ? ' is-over' : n !== null && n <= 14 ? ' is-soon' : '') + '"><span class="le" aria-hidden="true">' + healthIcon(h.type) + '</span><span class="lt"><b>' + esc(h.name) + '</b><small>' + esc(bits.join(' · ')) + '</small></span>' +
      '<span class="la">' + (h.due ? '<button class="btn small soft" type="button" data-act="given" data-id="' + esc(h.id) + '">Done today</button>' : '') + '<button class="btn small ghost" type="button" data-act="health" data-id="' + esc(h.id) + '">Edit</button></span></li>';
  }
  function weightCard(p, t) {
    var ws = C.weightsOf(state.doc, p.id);
    var u = units();
    var html = '<section class="card"><div class="sec mt0"><h2>Weight</h2><button class="btn small ghost" type="button" data-act="weight">+ Add</button></div>';
    if (!ws.length) return html + '<p class="empty">Weigh ' + esc(p.name) + ' now and then - a slow change is easy to miss and easy to see on a chart.</p></section>';
    var last = ws[ws.length - 1], first = ws[0];
    var diff = last.g - first.g;
    html += '<div class="bigstat"><b>' + esc(C.fmtWeight(last.g, u)) + '</b><span>' + esc(C.relDay(last.day, t)) + (ws.length > 1 ? ' · ' + (diff === 0 ? 'steady' : (diff > 0 ? 'up ' : 'down ') + C.fmtWeight(Math.abs(diff), u)) + ' since ' + esc(C.fmtDay(first.day, t)) : '') + '</span></div>';
    if (ws.length > 1) html += chart(ws, u, t);
    return html + '</section>';
  }
  function chart(ws, u, t) {
    var W = 380, Hh = 150, pl = 58, pr = 10, pt = 14, pb = 24;
    var xs = ws.map(function (w) { return C.dayMs(w.day); });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var v = ws.map(function (w) { return w.g; });
    var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
    var pad = Math.max(200, (hi - lo) * 0.25); lo -= pad; hi += pad;
    var X = function (ms) { return pl + (x1 === x0 ? (W - pl - pr) / 2 : (ms - x0) / (x1 - x0) * (W - pl - pr)); };
    var Y = function (g) { return pt + (1 - (g - lo) / (hi - lo)) * (Hh - pt - pb); };
    var pts = ws.map(function (w) { return X(C.dayMs(w.day)).toFixed(1) + ',' + Y(w.g).toFixed(1); });
    var area = 'M' + pts[0] + ' L' + pts.join(' L') + ' L' + X(x1).toFixed(1) + ',' + (Hh - pb) + ' L' + X(x0).toFixed(1) + ',' + (Hh - pb) + ' Z';
    var label = 'Weight from ' + C.fmtWeight(ws[0].g, u) + ' on ' + C.fmtDay(ws[0].day, t) + ' to ' + C.fmtWeight(ws[ws.length - 1].g, u) + ' on ' + C.fmtDay(ws[ws.length - 1].day, t);
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-label="' + esc(label) + '">' +
      '<line class="gl" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + Y(hi - pad) + '" y2="' + Y(hi - pad) + '"/><line class="gl" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + Y(lo + pad) + '" y2="' + Y(lo + pad) + '"/>' +
      '<text x="4" y="' + (Y(hi - pad) + 4) + '">' + esc(C.fmtWeight(hi - pad, u)) + '</text><text x="4" y="' + (Y(lo + pad) + 4) + '">' + esc(C.fmtWeight(lo + pad, u)) + '</text>' +
      '<path class="ar" d="' + area + '"/><polyline class="ln" points="' + pts.join(' ') + '"/>' +
      ws.map(function (w) { return '<circle class="dt" cx="' + X(C.dayMs(w.day)).toFixed(1) + '" cy="' + Y(w.g).toFixed(1) + '" r="5"/>'; }).join('') +
      '<text x="' + pl + '" y="' + (Hh - 6) + '">' + esc(C.fmtDay(ws[0].day, t)) + '</text><text x="' + (W - pr) + '" y="' + (Hh - 6) + '" text-anchor="end">' + esc(C.fmtDay(ws[ws.length - 1].day, t)) + '</text></svg>';
  }
  function vetCard(editable) {
    var v = state.doc.vet || {};
    var body = v.practice || v.phone
      ? '<div class="vetcard"><span class="le" aria-hidden="true">' + icon('visit') + '</span><div><b>' + esc(v.practice || 'The vet') + '</b>' + (v.phone ? '<span class="marked">The one number</span><br><a href="' + esc(C.telHref(v.phone)) + '">' + icon('phone') + esc(v.phone) + '</a>' : '') + '</div></div>'
      : '<p class="empty">Add the vet’s practice name and phone number - the sitter sees them, and they’re one tap away when it matters.</p>';
    return '<section class="card"><div class="sec mt0"><h2>The vet</h2>' + (editable ? '<button class="btn small ghost" type="button" data-act="vet">' + (v.practice || v.phone ? 'Edit' : '+ Add') + '</button>' : '') + '</div>' + body + '</section>';
  }

  function weekView() {
    var d = state.doc, n = now(), t = today();
    var html = '<div class="page-title"><h1>This week</h1><span class="sum">' + esc(C.fmtDay(C.addDays(t, -6), t) + ' – ' + C.fmtDay(t, t)) + '</span></div>';
    html += '<div class="pets">' + d.pets.map(function (p) {
      var w = C.week(d, p.id, n);
      var days = w.days.map(function (x) {
        var f = x.due ? x.done / x.due : 0;
        var cls = 'bar' + (x.due && x.done === x.due ? ' full' : '') + (x.day < t && x.done < x.due ? ' miss' : '');
        return '<div class="day' + (x.day === t ? ' today' : '') + '"><svg class="' + cls + '" viewBox="0 0 12 56" width="12" height="56" role="img" aria-label="' + esc(C.WEEKDAYS[C.weekday(x.day)] + ': ' + x.done + ' of ' + x.due + ' done') + '"><rect class="bg" x="0" y="0" width="12" height="56" rx="6"/>' + (f > 0 ? '<rect class="fg" x="0" y="' + (56 - Math.max(12, Math.round(f * 56))) + '" width="12" height="' + Math.max(12, Math.round(f * 56)) + '" rx="6"/>' : '') + '</svg><span class="n">' + (x.due ? x.done + '/' + x.due : '–') + '</span><small>' + (x.day === t ? 'Today' : C.WEEKDAYS[C.weekday(x.day)].slice(0, 3)) + '</small></div>';
      }).join('');
      var lines = w.lines.length ? '<ul class="lines">' + w.lines.map(function (l) { return '<li>' + taskIcon(l.task) + '<span>' + esc(l.words) + '</span>' + (l.done === l.due ? '<span class="q">every one</span>' : '') + '</li>'; }).join('') + '</ul>' : '<p class="empty">Nothing was due this week.</p>';
      var st = w.streak.days ? '<span class="streak">' + icon('flame') + esc(plural(w.streak.days, 'day') + (w.streak.capped ? '+' : '')) + ' in a row with everything done</span>' : '';
      return '<section class="pet"><div class="pet-head"><span class="pet-av" aria-hidden="true">' + esc(emojiOf(p)) + '</span><div><h2>' + esc(p.name) + '</h2><span class="w">' + esc(w.done + ' of ' + w.due + ' done this week') + '</span></div>' + ring(w.done, w.due) + '</div>' +
        '<div class="days">' + days + '</div>' + lines + st + '</section>';
    }).join('') + '</div>';
    var fs = C.fairShare(d, n);
    var order = (d.members || []).map(function (m) { return m.name; });
    var colour = function (name) { var i = order.indexOf(name); return 'c' + (((i < 0 ? order.length + 1 : i) % 6) + 1); };
    var rows = fs.rows.slice().sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    html += '<section class="card"><h2>Who did what</h2>' + (fs.total ? '<p class="small muted">' + esc(plural(fs.total, 'job')) + ' this week. Thanks, everyone.</p>' +
      shareBar(rows, fs.total, colour) +
      '<ul class="who-list">' + rows.map(function (r) { return '<li><span class="sw ' + colour(r.name) + '" aria-hidden="true"></span><span class="nm">' + esc(r.name) + '</span><span class="ct">' + esc(plural(r.n, 'job')) + '</span></li>'; }).join('') + '</ul>' +
      '<p class="small muted m8t">A share, not a scoreboard - some weeks one person is home more.</p>' : '<p class="empty">Nothing ticked off yet this week.</p>') + '</section>';
    return html;
  }

  /** The share of the week's jobs, one rounded bar, drawn as SVG. */
  function shareBar(rows, total, colour) {
    var x = 0;
    var parts = rows.map(function (r) { var w = r.n / total * 100; var out = '<rect class="' + colour(r.name) + '" x="' + x.toFixed(2) + '" y="0" width="' + Math.max(0, w - 0.6).toFixed(2) + '" height="8"/>'; x += w; return out; }).join('');
    return '<svg class="share" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="' + esc(rows.map(function (r) { return r.name + ' ' + r.n; }).join(', ')) + '">' + parts + '</svg>';
  }

  function homeView() {
    var d = state.doc, t = today();
    var html = '<div class="page-title"><h1>' + esc(d.name) + '</h1><button class="btn small ghost" type="button" data-act="homeedit">Rename</button></div>';
    html += '<section class="card"><div class="sec mt0"><h2>People</h2>' + (state.mode !== 'member' ? '<button class="btn small ghost" type="button" data-act="addperson">+ Add</button>' : '') + '</div><div class="people-row">' + d.members.map(function (m, i) {
      return '<span class="person' + (m.id === state.me ? ' me' : '') + '"><span class="av c' + ((i % 6) + 1) + '" aria-hidden="true">' + esc(m.name.charAt(0)) + '</span>' + esc(m.name) + (m.id === state.me ? ' (you)' : '') + '</span>';
    }).join('') + '</div>' + (state.mode === 'local' && !isSample() ? '<p class="small muted m8t">Share the household link below and each person adds their own name on their phone.</p>' : '') + '</section>';
    html += '<section class="card"><div class="sec mt0"><h2>Pets and routines</h2><button class="btn small ghost" type="button" data-act="addpet">+ Add a pet</button></div><ul class="list">' + d.pets.map(function (p) {
      var n = d.items.filter(function (i) { return i.pet === p.id; }).length;
      return '<li class="li"><span class="le" aria-hidden="true">' + esc(emojiOf(p)) + '</span><span class="lt"><b>' + esc(p.name) + '</b><small>' + esc(petMeta(p) + ' · ' + plural(n, 'routine item')) + '</small></span><span class="la"><button class="btn small ghost" type="button" data-act="openpet" data-id="' + esc(p.id) + '">Open</button></span></li>';
    }).join('') + '</ul></section>';
    html += shareCard(t);
    html += vetCard(true);
    html += '<section class="card"><h2>Settings</h2><div class="field mt4"><span>Weights in</span><div class="pills" role="group" aria-label="Weight units">' + C.UNITS.map(function (u) { return '<button class="pill" type="button" data-act="units" data-u="' + u + '" aria-pressed="' + (u === units()) + '">' + (u === 'lb' ? 'Pounds (lb)' : 'Kilograms (kg)') + '</button>'; }).join('') + '</div></div>' +
      '<p class="small muted">Times are in ' + esc(d.tz.replace(/_/g, ' ')) + '.' + (d.tz !== PHONE_TZ && state.mode !== 'member' ? ' <button class="link-btn" type="button" data-act="usetz">Use this phone’s zone (' + esc(PHONE_TZ.replace(/_/g, ' ')) + ')</button>' : '') + '</p>' +
      '<div class="stack"><button class="btn ghost block" type="button" data-act="ics">Download health due dates (.ics)</button>' +
      (state.mode === 'owner' ? '<button class="btn danger block" type="button" data-act="deletehome">Delete the shared household</button>' : state.mode === 'member' ? '<button class="btn danger block" type="button" data-act="leave">Leave this household on this phone</button>' : '<button class="btn danger block" type="button" data-act="wipe">Clear this phone</button>') + '</div></section>';
    return html;
  }
  function shareCard(t) {
    if (isSample()) {
      return '<section class="card"><h2>Share with the household</h2><p class="small muted">On your own home this makes one link for everyone - no app, no account - and sitter links that close the day you’re back. The sample stays on this phone, but you can see exactly what a sitter would see.</p>' +
        '<div class="stack"><button class="btn block" type="button" data-act="previewsitter">Preview Jo’s sitter link</button></div></section>';
    }
    if (state.mode === 'local') {
      return '<section class="card"><h2>Share with the household</h2><p>One link for everyone at home. They open it on their phone, pick their name, and the board updates for all of you. No app, no account.</p><p class="small muted">Sharing puts this household on the server under a random code. Anyone with the link can see and tick the board - send it only to your household.</p>' +
        '<div class="stack"><button class="btn big block" type="button" data-act="sharehome">Make the household link</button></div><p class="small muted m8t">After that you can make a sitter link that closes on a day you choose.</p></section>';
    }
    if (state.mode === 'member') {
      return '<section class="card"><h2>The household link</h2><p class="small muted">You’re in through the household link. Send it to anyone else who looks after the pets.</p><div class="linkout">' + esc(linkUrl('h', state.code)) + '</div><button class="btn block" type="button" data-act="sharelink">Share the link</button></section>';
    }
    var o = state.owner || {};
    var sit = (o.sitters || []).map(function (s) {
      return '<li class="li"><span class="le" aria-hidden="true">' + icon('user') + '</span><span class="lt"><b>' + esc(s.name) + '</b><small>Open until the end of ' + esc(C.relDay(s.until, t)) + '</small></span><span class="la"><button class="btn small" type="button" data-act="sharesitter" data-code="' + esc(s.code) + '">Share</button><button class="btn small danger" type="button" data-act="closesitter" data-code="' + esc(s.code) + '">Close</button></span></li>';
    }).join('');
    return '<section class="card"><h2>The household link</h2><p class="small muted">Everyone at home opens this - no app, no account - and picks their name.</p>' +
      (o.link ? '<div class="linkout">' + esc(linkUrl('h', o.link)) + '</div><div class="row"><button class="btn" type="button" data-act="sharelink">Share the link</button><button class="btn ghost" type="button" data-act="relink">Replace it</button></div>' : '<p class="empty">Loading…</p>') +
      '<div class="sec"><h2>Sitter links</h2><button class="btn small ghost" type="button" data-act="sitter">+ New</button></div>' +
      (sit ? '<ul class="list">' + sit + '</ul>' : '<p class="empty">Going away? A sitter link shows the pets, the routine, your notes and the vet’s number - and closes on the day you choose.</p>') +
      '<div class="sec"><h2>Your other devices</h2></div><p class="small muted">To run this household from a laptop or another phone, open your owner link there. It carries your key - keep it to yourself.</p><button class="btn small ghost" type="button" data-act="ownerlink">Copy my owner link</button>' +
      (signedIn() ? '<p class="small muted m8t">Or just sign in there: your account keeps the key.</p>' : '') + '</section>';
  }

  /* ---------------- the sitter's page ---------------- */

  function sitterPage() {
    var d = state.doc;
    var s = d.sitter || {};
    var t = today();
    var b = C.board(d, now());
    var names = d.pets.map(function (p) { return p.name; });
    var list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0] || 'the pets';
    var html = '';
    if (state.mode === 'preview') html += '<div class="strip" role="note"><p><b>A preview.</b> This is exactly what Jo sees on the sitter link - no names but Jo’s, no health records, no other links.</p><div class="row"><button class="btn small" type="button" data-act="endpreview">Back to the sample</button></div></div>';
    html += '<section class="sitter-hero"><p class="eyebrow">' + esc(d.name) + '</p><h1>Hi ' + esc(s.name || 'there') + '!</h1><p>Thanks for looking after ' + esc(list) + '. This link is open until the end of ' + esc(C.relDay(s.until, t) === 'Today' ? 'today' : C.WEEKDAYS[C.weekday(s.until)] + ' ' + C.fmtDay(s.until, t)) + '.</p></section>';
    html += '<div class="page-title"><h1>Today</h1><span class="sum">' + esc(b.done + ' of ' + b.total + ' done') + (b.overdue ? ' · ' + esc(b.overdue + ' overdue') : '') + '</span></div>';
    html += '<div class="pets">' + b.pets.map(petBoard).join('') + '</div>';
    html += '<section class="card"><h2>Good to know</h2>' + d.pets.map(function (p) {
      return '<h3>' + esc(emojiOf(p) + ' ' + p.name) + '</h3>' + (p.notes ? '<p class="goodto">' + esc(p.notes) + '</p>' : '<p class="empty">No notes.</p>');
    }).join('') + '</section>';
    html += '<section class="card"><h2>The routine</h2><ul class="list">' + d.items.slice().sort(function (a, b2) { return a.from - b2.from; }).map(function (i) {
      var p = petOf(i.pet);
      return '<li class="li"><span class="le" aria-hidden="true">' + taskIcon(i.task) + '</span><span class="lt"><b>' + esc((p ? p.name + ': ' : '') + i.label) + '</b><small>' + esc(C.repeatWords(i.repeat) + ', ' + C.fmtTime(i.from) + '–' + C.fmtTime(i.to)) + '</small></span><span class="la"></span></li>';
    }).join('') + '</ul>' +
      (d.meds.length ? '<h3>Medicines</h3><ul class="list">' + d.meds.map(function (m) {
        var p = petOf(m.pet);
        return '<li class="li"><span class="le" aria-hidden="true">' + icon('meds') + '</span><span class="lt"><b>' + esc((p ? p.name + ': ' : '') + m.name + (m.dose ? ' · ' + m.dose : '')) + '</b><small>' + esc(m.times.map(C.fmtTime).join(' & ') + ' · ' + C.medStatus(m, t).words) + '</small></span><span class="la"></span></li>';
      }).join('') + '</ul>' : '') + '</section>';
    html += vetCard(false);
    html += '<p class="fine">Tap a job when it’s done - the household sees it straight away. No account needed. <a href="' + esc(BASE) + '">What is Pawlog?</a></p>';
    return html;
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function head(title) { return '<div class="grab" aria-hidden="true"></div><div class="sheet-head"><h2 id="sheetTitle">' + esc(title) + '</h2><button class="x" type="button" data-act="closesheet" aria-label="Close">×</button></div>'; }
  function sheet(html, bind) {
    var s = $('#sheet');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = html;
    s.hidden = false; $('#sheetBack').hidden = false;
    document.body.classList.add('sheet-open');
    var h = $('#sheetTitle', s);
    s.setAttribute('aria-labelledby', 'sheetTitle');
    if (bind) bind(s);
    if (h) h.setAttribute('tabindex', '-1');
    setTimeout(function () { var f = $('[autofocus]', s) || h; if (f) f.focus(); }, 30);
  }
  function closeSheet(noFocus) {
    var s = $('#sheet');
    if (s.hidden) return;
    s.hidden = true; s.innerHTML = ''; $('#sheetBack').hidden = true;
    document.body.classList.remove('sheet-open');
    state.armed = null; state.ai = null;
    if (!noFocus && lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) { /* gone */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  function errBox(root, e) { var el = $('.ferr', root); if (el) { el.innerHTML = '<p class="err" role="alert">' + esc(e.message || e) + '</p>'; el.scrollIntoView({ block: 'nearest' }); } }
  function kindPills(sel) {
    return '<div class="pills" role="group" aria-label="What kind of pet">' + C.KINDS.map(function (k) { return '<button class="pill" type="button" data-kind="' + k.id + '" aria-pressed="' + (k.id === sel) + '">' + k.emoji + ' ' + esc(k.label) + '</button>'; }).join('') + '</div>';
  }
  function bindPills(root, attr, onPick) {
    $$('[' + attr + ']', root).forEach(function (b) {
      b.addEventListener('click', function () { $$('[' + attr + ']', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); onPick(b.getAttribute(attr)); });
    });
  }
  function contactWarn(text) { return C.hasContact(text) ? 'Phone numbers, emails and addresses stay out of the notes - the sitter sees these. The vet’s number has its own field.' : null; }

  /** The first pet: who you are, and the pet. The routine comes from the
   *  pet's kind. */
  function openSetup() {
    var kind = 'dog';
    sheet(head('Set up my pet') + '<form id="setupForm">' +
      '<label class="field"><span>Your first name</span><input class="input" id="sMe" maxlength="' + C.LIMITS.name + '" autocomplete="given-name" required autofocus placeholder="Sam"><span class="hint">So the house sees “Fed by Sam”. First names only.</span></label>' +
      '<label class="field"><span>Your pet’s name</span><input class="input" id="sPet" maxlength="' + C.LIMITS.petName + '" required placeholder="Biscuit" autocomplete="off"></label>' +
      '<div class="field"><span>They’re a…</span>' + kindPills(kind) + '</div>' +
      '<div class="two"><label class="field"><span>Birthday <span class="hint">(optional)</span></span><input class="input" id="sBday" type="date" max="' + today() + '"></label>' +
      '<label class="field"><span>Weight <span class="hint">(' + units() + ', optional)</span></span><input class="input" id="sW" inputmode="decimal" placeholder="' + (units() === 'kg' ? '11.2' : '24.5') + '"></label></div>' +
      '<p class="small muted" id="sTpl"></p><div class="ferr"></div><button class="btn big block" type="submit">Start my household</button></form>', function (root) {
      var tpl = function () { $('#sTpl', root).textContent = 'Starts with: ' + C.TEMPLATES[kind].map(function (x) { return x[1]; }).join(', ') + '. Change any of it later.'; };
      tpl();
      bindPills(root, 'data-kind', function (k) { kind = k; tpl(); });
      $('#setupForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var me = C.firstName($('#sMe', root).value);
        if (!me) return errBox(root, 'Add your first name.');
        var doc = C.cleanHome({ name: 'Our home', tz: PHONE_TZ, members: [{ id: ids('m'), name: me }] }, now(), PHONE_TZ);
        try {
          C.act(doc, { role: 'owner' }, 'pet', { pet: { name: $('#sPet', root).value, kind: kind, birthday: $('#sBday', root).value || null }, weight: $('#sW', root).value, unit: units() }, now(), ids);
        } catch (err) { return errBox(root, err); }
        state.mode = 'local'; state.doc = doc; state.tab = 'today';
        saveLocal(); saveMe(doc.members[0].id);
        closeSheet(true); draw(); scrollTo(0, 0);
        toast('Done. Tap each job when it’s done - and share the household link from Home.');
      });
    });
  }

  /** Who this phone is in the household. */
  function openWho(then) {
    var d = state.doc;
    sheet(head('Who are you?') + '<p class="small muted">So the house sees who did it. This phone remembers.</p><div class="stack">' + d.members.map(function (m) {
      return '<button class="btn ' + (m.id === state.me ? '' : 'ghost ') + 'block" type="button" data-pickme="' + esc(m.id) + '">' + esc(m.name) + (m.id === state.me ? ' ✓' : '') + '</button>';
    }).join('') + '</div><form id="whoForm"><label class="field"><span>Someone new</span><input class="input" id="whoName" maxlength="' + C.LIMITS.name + '" autocomplete="given-name" placeholder="Your first name"></label><div class="ferr"></div><button class="btn block" type="submit">Add me</button></form>', function (root) {
      $$('[data-pickme]', root).forEach(function (b) { b.addEventListener('click', function () { saveMe(b.getAttribute('data-pickme')); closeSheet(true); draw(); if (then) then(); }); });
      $('#whoForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        doAct('join', { name: $('#whoName', root).value }).then(function (r) { saveMe(r.member.id); closeSheet(true); draw(); if (then) then(); }).catch(function (err) { errBox(root, err); });
      });
    });
  }

  /** The double-done guard: "Already fed by Sam at 7:42am - do it again?" */
  function openGuard(row, info) {
    var p = petOf(row.pet);
    var dose = row.kind === 'dose';
    var verb = dose ? 'given' : ({ feed: 'fed', walk: 'walked', clean: 'cleaned', play: 'played' }[row.task] || 'done');
    var mine = info.mine;
    var canUndo = mine && info.logId && now() - info.at <= C.LIMITS.undoMin * 60000;
    var warn = dose ? 'A double dose can be dangerous. If you’re not sure, check with the vet before giving another.' : row.task === 'feed' ? esc((p ? p.name : 'They') + ' might happily eat twice - which is how pets get round.') : 'It’s been ticked off already.';
    sheet(head('Hold on') + '<div class="guard"><p class="big" aria-hidden="true">' + icon(dose ? 'meds' : 'alert') + '</p><h2>Already ' + esc(verb) + ' by ' + esc(mine ? 'you' : info.by) + ' at ' + esc(info.when) + '</h2><p>' + (dose ? esc(warn) : warn) + '</p></div>' +
      '<div class="stack"><button class="btn big block" type="button" data-act="closesheet" autofocus>No, leave it</button>' +
      (canUndo ? '<button class="btn ghost block" type="button" data-act="undo" data-log="' + esc(info.logId) + '">Undo my tick</button>' : '') +
      '<button class="btn ghost block" type="button" data-act="again" data-key="' + esc(row.key) + '">Yes, ' + (dose ? 'give another dose' : 'do it again') + '</button></div>');
  }
  function boardRow(key) {
    var b = C.board(state.doc, now());
    for (var i = 0; i < b.pets.length; i++) for (var j = 0; j < b.pets[i].rows.length; j++) if (b.pets[i].rows[j].key === key) return { row: b.pets[i].rows[j], day: b.day };
    return null;
  }
  function tapTask(key, again) {
    var hit = boardRow(key);
    if (!hit) return;
    var row = hit.row;
    if (state.mode !== 'sitter' && state.mode !== 'preview' && !state.me) return openWho(function () { tapTask(key, again); });
    if (row.log && !again) {
      var l = row.log;
      var mine = state.mode === 'sitter' ? l.mine : l.by === state.me;
      return openGuard(row, { by: l.name || 'someone', when: C.clockOf(l.at, tz()), at: l.at, mine: mine, logId: l.id });
    }
    var args = { key: key, day: hit.day, by: state.me, again: Boolean(again) };
    if (state.mode === 'preview') return toast('In the preview, ticks stay pretend. On a real sitter link they go straight to the household.');
    doAct('done', args).then(function (r) {
      closeSheet(true);
      state.just = key;
      redraw();
      setTimeout(function () { state.just = null; }, 600);
      var p = petOf(row.pet);
      var verb = row.kind === 'dose' ? 'Given' : C.taskOf(row.task).done;
      var msg = (verb === 'Done' || verb === 'Given' ? row.label.split(' · ')[0] + ': ' + verb.toLowerCase() : verb + ' ' + (p ? p.name : '')) + (r && r.again ? ' (again)' : '') + '.';
      toast(msg, 8000, { label: 'Undo', act: 'undo', data: { log: r && r.log ? r.log.id : '' } });
      say(msg);
    }).catch(function (e) {
      if (e.status === 409 && e.data && e.data.code === 'already') { redraw(); return openGuard(row, { by: e.data.by, when: e.data.when, at: e.data.at, mine: e.data.mine }); }
      if (e.data && e.data.code === 'who') return openWho(function () { tapTask(key, again); });
      showError(e);
    });
  }
  function undo(logId) {
    if (!logId) return;
    doAct('undo', { log: logId }).then(function () { closeSheet(true); toast('Taken back.'); redraw(); }).catch(function (e) { toast(e.message); });
  }

  /** A pet: details, notes, its routine. */
  function openPet(id) {
    var p = id ? petOf(id) : null;
    var kind = p ? p.kind : 'dog';
    var d = state.doc;
    var items = p ? d.items.filter(function (i) { return i.pet === p.id; }).sort(function (a, b) { return a.from - b.from; }) : [];
    sheet(head(p ? p.name : 'Add a pet') + '<form id="petForm">' +
      '<label class="field"><span>Name</span><input class="input" id="pName" maxlength="' + C.LIMITS.petName + '" required value="' + esc(p ? p.name : '') + '"' + (p ? '' : ' autofocus') + ' autocomplete="off"></label>' +
      '<div class="field"><span>Kind</span>' + kindPills(kind) + '</div>' +
      '<div class="two"><label class="field"><span>Birthday <span class="hint">(optional)</span></span><input class="input" id="pBday" type="date" max="' + today() + '" value="' + esc(p && p.birthday ? p.birthday : '') + '"></label>' +
      (p ? '<span></span>' : '<label class="field"><span>Weight <span class="hint">(' + units() + ')</span></span><input class="input" id="pW" inputmode="decimal"></label>') + '</div>' +
      '<label class="field"><span>Notes for whoever’s looking after them</span><textarea class="input" id="pNotes" maxlength="' + C.LIMITS.note + '" placeholder="Hides the pill in cheese. No grapes or chocolate.">' + esc(p ? p.notes : '') + '</textarea><span class="hint">The sitter sees these. Keep phone numbers and addresses out - the vet has a field of its own.</span></label>' +
      '<div class="ferr"></div><button class="btn block" type="submit">' + (p ? 'Save' : 'Add ' + 'them with a starter routine') + '</button></form>' +
      (p ? '<div class="sec"><h2>Routine</h2><button class="btn small ghost" type="button" data-act="item" data-pet="' + esc(p.id) + '">+ Add</button></div>' +
        (items.length ? '<ul class="list">' + items.map(function (i) {
          return '<li class="li"><span class="le" aria-hidden="true">' + taskIcon(i.task) + '</span><span class="lt"><b>' + esc(i.label) + '</b><small>' + esc(C.repeatWords(i.repeat) + ', ' + C.fmtTime(i.from) + '–' + C.fmtTime(i.to)) + '</small></span><span class="la"><button class="btn small ghost" type="button" data-act="item" data-id="' + esc(i.id) + '">Edit</button></span></li>';
        }).join('') + '</ul>' : '<p class="empty">No routine yet.</p>') +
        '<div class="stack"><button class="btn danger block" type="button" data-act="delpet" data-id="' + esc(p.id) + '">Remove ' + esc(p.name) + '</button></div>' : ''), function (root) {
      bindPills(root, 'data-kind', function (k) { kind = k; });
      $('#petForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var notes = $('#pNotes', root).value;
        var w = contactWarn(notes);
        if (w) return errBox(root, w);
        var pet = { id: p ? p.id : undefined, name: $('#pName', root).value, kind: kind, birthday: $('#pBday', root).value || null, notes: notes };
        var wEl = $('#pW', root);
        doAct('pet', { pet: pet, weight: wEl ? wEl.value : '', unit: units() }).then(function (r) {
          toast(p ? 'Saved.' : r.pet.name + ' is in, with a starter routine.');
          if (p) openPet(p.id); else { closeSheet(true); state.pet = r.pet.id; }
          redraw();
        }).catch(function (err) { errBox(root, err); });
      });
    });
  }

  function repeatFields(r) {
    var rr = r || { every: 'day', n: 2, anchor: today() };
    return '<div class="two"><label class="field"><span>Repeats</span><select class="input" id="rEvery">' +
      [['day', 'Every day'], ['days', 'Every few days'], ['week', 'Weekly'], ['month', 'Monthly']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === rr.every ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
      '<label class="field" id="rNBox"' + (rr.every === 'days' ? '' : ' hidden') + '><span>Every how many days</span><input class="input" id="rN" type="number" min="2" max="30" value="' + esc(rr.every === 'days' ? rr.n : 3) + '"></label></div>' +
      '<label class="field" id="rABox"' + (rr.every === 'day' ? ' hidden' : '') + '><span>Starting (sets the weekday or day of the month)</span><input class="input" id="rAnchor" type="date" value="' + esc(rr.anchor || today()) + '"></label>';
  }
  function bindRepeat(root) {
    var sel = $('#rEvery', root);
    sel.addEventListener('change', function () { $('#rNBox', root).hidden = sel.value !== 'days'; $('#rABox', root).hidden = sel.value === 'day'; });
  }
  function readRepeat(root) {
    var every = $('#rEvery', root).value;
    return { every: every, n: Number($('#rN', root).value) || 3, anchor: $('#rAnchor', root).value || today() };
  }

  function openItem(id, petId) {
    var d = state.doc;
    var it = id ? d.items.filter(function (x) { return x.id === id; })[0] : null;
    var pet = it ? it.pet : petId;
    var task = it ? it.task : 'feed';
    sheet(head(it ? 'Edit ' + it.label : 'Add to the routine') + '<form id="itemForm">' +
      '<div class="field"><span>What</span><div class="pills" role="group" aria-label="Kind of job">' + C.TASKS.filter(function (t) { return t.id !== 'meds'; }).map(function (t) { return '<button class="pill" type="button" data-task="' + t.id + '" aria-pressed="' + (t.id === task) + '">' + esc(t.label) + '</button>'; }).join('') + '</div></div>' +
      '<label class="field"><span>Label</span><input class="input" id="iLabel" maxlength="' + C.LIMITS.label + '" value="' + esc(it ? it.label : '') + '" placeholder="Breakfast" required></label>' +
      '<div class="two"><label class="field"><span>From</span><input class="input" id="iFrom" type="time" value="' + C.hhmm(it ? it.from : 480) + '" required></label><label class="field"><span>Until</span><input class="input" id="iTo" type="time" value="' + C.hhmm(it ? it.to : 600) + '" required></label></div>' +
      '<p class="hint mtn4">After “until” it glows as overdue.</p>' + repeatFields(it && it.repeat) +
      '<div class="ferr"></div><button class="btn block" type="submit">' + (it ? 'Save' : 'Add it') + '</button></form>' +
      (it ? '<div class="stack"><button class="btn danger block" type="button" data-act="delitem" data-id="' + esc(it.id) + '">Remove from the routine</button></div>' : ''), function (root) {
      bindPills(root, 'data-task', function (t) { task = t; });
      bindRepeat(root);
      $('#itemForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var from = C.parseHhmm($('#iFrom', root).value), to = C.parseHhmm($('#iTo', root).value);
        if (from === null || to === null || to <= from) return errBox(root, '“Until” has to be after “from” (the same day).');
        doAct('item', { item: { id: it ? it.id : undefined, pet: pet, task: task, label: $('#iLabel', root).value, from: from, to: to, repeat: readRepeat(root) } })
          .then(function () { toast('Saved to the routine.'); openPet(pet); redraw(); }).catch(function (err) { errBox(root, err); });
      });
    });
  }

  function openMed(id) {
    var d = state.doc;
    var m = id ? d.meds.filter(function (x) { return x.id === id; })[0] : null;
    var pet = m ? m.pet : state.pet || (d.pets[0] && d.pets[0].id);
    var times = m ? m.times.slice() : [480];
    var draw2 = function (root) {
      $('#mTimes', root).innerHTML = times.map(function (t, i) { return '<div class="row"><input class="input grow" type="time" data-ti="' + i + '" value="' + C.hhmm(t) + '" aria-label="Dose time ' + (i + 1) + '">' + (times.length > 1 ? '<button class="btn small ghost" type="button" data-rmt="' + i + '" aria-label="Remove this time">Remove</button>' : '') + '</div>'; }).join('') +
        (times.length < C.LIMITS.timesPerMed ? '<button class="btn small ghost" type="button" id="addT">+ Another time</button>' : '');
      $$('[data-ti]', root).forEach(function (el) { el.addEventListener('change', function () { var v = C.parseHhmm(el.value); if (v !== null) times[Number(el.getAttribute('data-ti'))] = v; }); });
      $$('[data-rmt]', root).forEach(function (b) { b.addEventListener('click', function () { times.splice(Number(b.getAttribute('data-rmt')), 1); draw2(root); }); });
      var add = $('#addT', root); if (add) add.addEventListener('click', function () { times.push(1200); draw2(root); });
    };
    sheet(head(m ? 'Edit ' + m.name : 'Add a medicine') + '<form id="medForm">' + petPick(pet) +
      '<label class="field"><span>Medicine</span><input class="input" id="mName" maxlength="' + C.LIMITS.medName + '" required value="' + esc(m ? m.name : '') + '" placeholder="Ear drops" autocomplete="off"' + (m ? '' : ' autofocus') + '></label>' +
      '<label class="field"><span>Dose</span><input class="input" id="mDose" maxlength="' + C.LIMITS.dose + '" value="' + esc(m ? m.dose : '') + '" placeholder="4 drops, left ear"></label>' +
      '<div class="field"><span>Times</span><div id="mTimes" class="stack mt0"></div></div>' + repeatFields(m && m.repeat) +
      '<div class="two"><label class="field"><span>Starts</span><input class="input" id="mStart" type="date" value="' + esc(m ? m.start : today()) + '"></label><label class="field"><span>Last day <span class="hint">(empty: ongoing)</span></span><input class="input" id="mUntil" type="date" value="' + esc(m && m.until ? m.until : '') + '"></label></div>' +
      '<p class="hint">Each dose appears on Today with the same double-dose guard.</p><div class="ferr"></div><button class="btn block" type="submit">' + (m ? 'Save' : 'Add the course') + '</button></form>' +
      (m ? '<div class="stack"><button class="btn danger block" type="button" data-act="delmed" data-id="' + esc(m.id) + '">Delete this medicine</button></div>' : ''), function (root) {
      draw2(root); bindRepeat(root);
      bindPills(root, 'data-pp', function (v) { pet = v; });
      $('#medForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var start = $('#mStart', root).value || today(), until = $('#mUntil', root).value || null;
        if (until && until < start) return errBox(root, 'The last day can’t be before the first.');
        var r = readRepeat(root); r.anchor = start;
        doAct('med', { med: { id: m ? m.id : undefined, pet: pet, name: $('#mName', root).value, dose: $('#mDose', root).value, times: times, repeat: r, start: start, until: until } })
          .then(function () { closeSheet(true); toast('Saved. The doses are on Today.'); redraw(); }).catch(function (err) { errBox(root, err); });
      });
    });
  }
  function petPick(sel) {
    var pets = state.doc.pets;
    if (pets.length < 2) return '';
    return '<div class="field"><span>For</span><div class="pills" role="group" aria-label="Which pet">' + pets.map(function (p) { return '<button class="pill" type="button" data-pp="' + esc(p.id) + '" aria-pressed="' + (p.id === sel) + '">' + esc(emojiOf(p) + ' ' + p.name) + '</button>'; }).join('') + '</div></div>';
  }

  function openHealth(id) {
    var d = state.doc;
    var h = id ? d.health.filter(function (x) { return x.id === id; })[0] : null;
    var pet = h ? h.pet : state.pet || (d.pets[0] && d.pets[0].id);
    var type = h ? h.type : 'vaccine';
    sheet(head(h ? 'Edit ' + h.name : 'Add a health record') + '<form id="hForm">' + petPick(pet) +
      '<div class="field"><span>Type</span><div class="pills" role="group" aria-label="Type">' + C.HEALTH_TYPES.map(function (t) { return '<button class="pill" type="button" data-ht="' + t.id + '" aria-pressed="' + (t.id === type) + '">' + esc(t.label) + '</button>'; }).join('') + '</div></div>' +
      '<label class="field"><span>What</span><input class="input" id="hName" maxlength="' + C.LIMITS.healthName + '" value="' + esc(h ? h.name : '') + '" placeholder="Rabies booster" autocomplete="off"></label>' +
      '<div class="two"><label class="field"><span>Last given</span><input class="input" id="hGiven" type="date" max="' + today() + '" value="' + esc(h && h.given ? h.given : '') + '"></label><label class="field"><span>Next due</span><input class="input" id="hDue" type="date" value="' + esc(h && h.due ? h.due : '') + '"></label></div>' +
      '<label class="field"><span>Repeats</span><select class="input" id="hEvery">' + [0, 1, 2, 3, 6, 12, 24, 36].map(function (n) { var cur = h ? h.everyMonths : C.healthOf(type).months; return '<option value="' + n + '"' + (n === cur ? ' selected' : '') + '>' + (n ? 'Every ' + plural(n, 'month') : 'Doesn’t repeat') + '</option>'; }).join('') + '</select><span class="hint">“Done today” then sets the next due date for you.</span></label>' +
      '<div class="ferr"></div><button class="btn block" type="submit">' + (h ? 'Save' : 'Add it') + '</button></form>' +
      (h ? '<div class="stack"><button class="btn danger block" type="button" data-act="delhealth" data-id="' + esc(h.id) + '">Delete this record</button></div>' : ''), function (root) {
      bindPills(root, 'data-pp', function (v) { pet = v; });
      bindPills(root, 'data-ht', function (v) { type = v; if (!h) $('#hEvery', root).value = String(C.healthOf(v).months); });
      $('#hGiven', root).addEventListener('change', function () { var g = $('#hGiven', root).value, n = Number($('#hEvery', root).value); if (g && n && !$('#hDue', root).value) $('#hDue', root).value = C.addMonths(g, n); });
      $('#hForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        doAct('health', { health: { id: h ? h.id : undefined, pet: pet, type: type, name: $('#hName', root).value, given: $('#hGiven', root).value || null, due: $('#hDue', root).value || null, everyMonths: Number($('#hEvery', root).value) } })
          .then(function () { closeSheet(true); toast('Saved.'); redraw(); }).catch(function (err) { errBox(root, err); });
      });
    });
  }
  function openWeight() {
    var p = petOf(state.pet);
    if (!p) return;
    sheet(head('Weigh ' + p.name) + '<form id="wForm"><div class="two"><label class="field"><span>Weight (' + units() + ')</span><input class="input" id="wVal" inputmode="decimal" required autofocus></label><label class="field"><span>On</span><input class="input" id="wDay" type="date" max="' + today() + '" value="' + today() + '"></label></div><div class="ferr"></div><button class="btn block" type="submit">Save</button></form>', function (root) {
      $('#wForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        doAct('weight', { pet: p.id, value: $('#wVal', root).value, unit: units(), day: $('#wDay', root).value }).then(function () { closeSheet(true); toast('Saved.'); redraw(); }).catch(function (err) { errBox(root, err); });
      });
    });
  }
  function openVet() {
    var v = state.doc.vet || {};
    sheet(head('The vet') + '<form id="vForm"><label class="field"><span>Practice name</span><input class="input" id="vName" maxlength="' + C.LIMITS.practice + '" value="' + esc(v.practice || '') + '" placeholder="Fernhill Vets" autofocus></label>' +
      '<label class="field"><span>Phone <span class="marked">The one number</span></span><input class="input" id="vPhone" type="tel" inputmode="tel" value="' + esc(v.phone || '') + '" placeholder="(555) 010-4477"><span class="hint">The only phone number Pawlog keeps. The sitter link shows it, so it’s one tap away.</span></label>' +
      '<div class="ferr"></div><button class="btn block" type="submit">Save</button></form>', function (root) {
      $('#vForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        doAct('vet', { practice: $('#vName', root).value, phone: $('#vPhone', root).value }).then(function () { closeSheet(true); toast('Saved.'); redraw(); }).catch(function (err) { errBox(root, err); });
      });
    });
  }
  function openHomeEdit() {
    sheet(head('Rename the household') + '<form id="hnForm"><label class="field"><span>Name</span><input class="input" id="hn" maxlength="' + C.LIMITS.homeName + '" value="' + esc(state.doc.name) + '" autofocus></label><div class="ferr"></div><button class="btn block" type="submit">Save</button></form>', function (root) {
      $('#hnForm', root).addEventListener('submit', function (e) { e.preventDefault(); doAct('home', { name: $('#hn', root).value }).then(function () { closeSheet(true); redraw(); }).catch(function (err) { errBox(root, err); }); });
    });
  }
  function openAddPerson() {
    sheet(head('Add someone') + '<form id="apForm"><label class="field"><span>Their first name</span><input class="input" id="apName" maxlength="' + C.LIMITS.name + '" autofocus></label><p class="small muted">Or just send them the household link - they add their own name.</p><div class="ferr"></div><button class="btn block" type="submit">Add</button></form>', function (root) {
      $('#apForm', root).addEventListener('submit', function (e) { e.preventDefault(); doAct('join', { name: $('#apName', root).value }).then(function () { closeSheet(true); redraw(); }).catch(function (err) { errBox(root, err); }); });
    });
  }
  function openSitter() {
    var max = C.addDays(today(), C.LIMITS.sitterDays);
    sheet(head('A link for the sitter') + '<p class="small muted">They see the pets, the routine, your notes, the medicines and the vet’s practice and phone - and tick things off. Not your names, not the health records, not the household link. It closes at the end of the day you pick.</p>' +
      '<form id="sForm"><label class="field"><span>Sitter’s first name</span><input class="input" id="sName" maxlength="' + C.LIMITS.name + '" required autofocus placeholder="Jo"></label>' +
      '<label class="field"><span>Last day</span><input class="input" id="sUntil" type="date" min="' + today() + '" max="' + max + '" value="' + C.addDays(today(), 7) + '" required></label><div class="ferr"></div><button class="btn block" type="submit">Make the link</button></form>', function (root) {
      $('#sForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        doAct('sitter', { name: $('#sName', root).value, until: $('#sUntil', root).value }).then(function (r) {
          closeSheet(true); redraw(); shareSitter(r.sitter);
        }).catch(function (err) { errBox(root, err); });
      });
    });
  }
  function shareSitter(code) {
    var s = ((state.owner && state.owner.sitters) || []).filter(function (x) { return x.code === code; })[0];
    share('Pet care for ' + (s ? s.name : 'you'), 'Hi' + (s ? ' ' + s.name : '') + '! Everything for looking after the pets - the routine, notes and the vet - tick things off as you go:', linkUrl('s', code));
  }

  /* ---------------- the vet paperwork (the one model call) ---------------- */

  var PHOTO_MAX = 3 * 1024 * 1024; // decoded bytes; the server refuses over 4 MB
  /** Shrink a photo on this phone before it goes anywhere: a canvas redraw
   *  (which also drops its EXIF), smaller and plainer until it is under the
   *  cap. A photo that will not fit is refused here. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('not an image'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener('load', function () {
        var steps = [[PHOTO_PX, 0.85], [1280, 0.8], [1024, 0.75], [800, 0.7]];
        var dataUrl = null;
        for (var i = 0; i < steps.length; i++) {
          var s = Math.min(1, steps[i][0] / Math.max(img.naturalWidth, img.naturalHeight));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          dataUrl = c.toDataURL('image/jpeg', steps[i][1]);
          if ((dataUrl.length - 23) * 3 / 4 <= PHOTO_MAX) break;
          dataUrl = null;
        }
        URL.revokeObjectURL(url);
        if (!dataUrl) return reject(new Error('too large'));
        resolve({ type: 'image/jpeg', data: dataUrl.split(',')[1], url: dataUrl });
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('bad image')); });
      img.src = url;
    });
  }
  function openPaper() {
    if (!state.doc.pets.length) return toast('Add a pet first.');
    state.ai = { pet: state.pet || state.doc.pets[0].id, how: 'photo', photo: null, text: '', proposal: null, drafts: null, busy: false };
    drawPaper();
  }
  function drawPaper() {
    var a = state.ai;
    if (!a) return;
    var p = petOf(a.pet);
    var gem = reader() === 'gemini';
    var html = head(paperTitle());
    if (!signedIn()) {
      html += '<p>' + (gem ? 'Snap the prescription label or the discharge sheet and AI copies each medicine - name, strength, amount, how often, how long - for you to check against the label. Pawlog then works out the dose times.' : 'Snap an invoice or a vaccination card and AI fills in the boosters, medicines, weight and next visit for you to check.') + ' It needs a free account, which comes with $2 of AI credit (well over a hundred pages).</p>' +
        '<p class="small muted">Everything else in Pawlog stays free with no account: the board, the household and sitter links, health records by hand and the calendar.</p>' +
        '<div class="stack"><button class="btn big block" type="button" data-act="signup">Create a free account</button><button class="btn ghost block" type="button" data-act="signin">I have an account</button></div>';
      return sheet(html);
    }
    if (a.proposal) return sheet(html + resultHtml(a), bindResult);
    html += petPick(a.pet) + '<div class="field"><span>From</span><div class="pills" role="group" aria-label="Photo or text"><button class="pill" type="button" data-how="photo" aria-pressed="' + (a.how === 'photo') + '">A photo</button><button class="pill" type="button" data-how="text" aria-pressed="' + (a.how === 'text') + '">Pasted text</button></div></div>';
    html += a.how === 'photo'
      ? '<div class="field"><label class="filepick"><input class="vh" id="paFile" type="file" accept="image/*"><span class="btn ghost block">' + icon('camera') + (a.photo ? 'Choose a different photo' : 'Take or choose a photo') + '</span></label></div>' + (a.photo ? '<img class="preview-img" alt="The photo to read" src="' + esc(a.photo.url) + '">' : '')
      : '<label class="field"><span>Paste the text</span><textarea class="input" id="paText" maxlength="8000" placeholder="' + (gem ? 'Give 1 tablet twice daily with food for 7 days…' : 'Vaccinations given today: Rabies (next due 10/2027)…') + '">' + esc(a.text) + '</textarea></label>';
    html += '<p class="sent"><b>What is sent:</b> ' + (a.how === 'photo' ? 'the photo, shrunk on this phone, read once and never kept' : 'the text, with anything that looks like an address, a phone number or an account number taken out first') + ', and that ' + esc(p ? p.name : 'the pet') + ' is a ' + esc(p ? C.kindOf(p.kind).label.toLowerCase() : 'pet') + '. Not your names, not the pet’s name. Nothing is saved until you’ve checked it.</p>' +
      '<div class="ferr" id="paOut"></div><button class="btn big block" type="button" data-act="doread"' + (a.busy ? ' disabled' : '') + '>' + (a.busy ? 'Reading…' : 'Read it') + '</button>' +
      (gem ? '<p class="fine">AI copies what the paperwork says. It never suggests or changes a dose. ' + CHECK_LINE + '</p>' : '');
    sheet(html, function (root) {
      bindPills(root, 'data-pp', function (v) { a.pet = v; });
      bindPills(root, 'data-how', function (v) { a.how = v; drawPaper(); });
      var f = $('#paFile', root);
      if (f) f.addEventListener('change', function () {
        var file = f.files && f.files[0];
        shrink(file).then(function (ph) { a.photo = ph; drawPaper(); }).catch(function (e) { errBox(root, e && e.message === 'too large' ? 'That photo is too large even after shrinking. Try a closer shot of just the label.' : 'That file isn’t a photo this phone can read.'); });
      });
      var tx = $('#paText', root);
      if (tx) tx.addEventListener('input', function () { a.text = tx.value; });
    });
  }

  /** The other things found on the paper (and, on the older reader, the
   *  medicines too): a tick list. */
  function proposalRows(pr) {
    var t = today();
    var rows = [];
    pr.vaccinations.forEach(function (v, i) { rows.push(['v' + i, healthIcon(v.kind), v.name, [v.given ? 'given ' + C.fmtDay(v.given, t) : '', v.due ? 'due ' + C.fmtDay(v.due, t) : ''].filter(Boolean).join(' · ')]); });
    pr.medicines.forEach(function (m, i) { rows.push(['m' + i, icon('meds'), m.name + (m.dose ? ' · ' + m.dose : ''), m.schedule + (m.until ? ' until ' + C.fmtDay(m.until, t) : '')]); });
    if (pr.weight) rows.push(['w', icon('weight'), 'Weight ' + C.fmtWeight(pr.weight.g, units()), 'today']);
    if (pr.nextVisit) rows.push(['n', icon('visit'), pr.nextVisit.what, 'on ' + C.fmtDay(pr.nextVisit.day, t)]);
    if (!rows.length) return '';
    return '<ul class="prop">' + rows.map(function (r) { return '<li><label class="check"><input type="checkbox" data-pick="' + esc(r[0]) + '" checked><span class="le" aria-hidden="true">' + r[1] + '</span><span class="pt"><b>' + esc(r[2]) + '</b><small>' + esc(r[3]) + '</small></span></label></li>'; }).join('') + '</ul>';
  }
  var RX_HINT = {
    name: 'Couldn’t read the name - type it from the label.',
    strength: 'No strength was read. Type it from the label, or tick the box if the label doesn’t give one.',
    amount: 'Couldn’t read the amount - type it exactly as the label says.',
    frequency: 'Choose how often, as the label says.',
    days: 'No number of days was read. Type it from the label, or tick “no end date”.',
    food: 'The paperwork didn’t say. Choose one, or tick the box to leave it out.',
    start: 'No start date on the paperwork, so this is set to today.',
  };
  function rxOk(i, k, f) {
    if (!f.flagged) return '';
    var empty = f.value === null || f.assumed || (k === 'food' && f.value === 'none');
    var words = k === 'start' ? 'Yes, this start date is right' : k === 'frequency' ? 'This matches the label' : empty ? (k === 'days' ? '' : 'The label doesn’t say') : 'This matches the label';
    if (k === 'name' || k === 'amount') words = empty ? '' : words;
    return (empty || k === 'frequency' ? '<span class="hint">' + esc(RX_HINT[k]) + '</span>' : '') +
      (words ? '<label class="check small"><input type="checkbox" data-ok="' + k + '" id="rx' + i + k + 'ok"><span>' + esc(words) + '</span></label>' : '');
  }
  function rxLabel(k, f, extra) { return '<span class="rx-l">' + esc(C.MED_FIELD_LABELS[k]) + (extra || '') + (f.flagged ? ' <span class="chip now" data-chip="' + k + '">Check</span>' : '') + '</span>'; }
  function rxTimes(times) {
    return times.map(function (t, j) { return '<input class="input" type="time" data-t="' + j + '" value="' + C.hhmm(t) + '" aria-label="Dose time ' + (j + 1) + '">'; }).join('');
  }
  /** One medicine, as read: every field editable, the unsure and missing
   *  ones marked "Check" with a box to tick (or type over). */
  function rxCard(dr, i, n) {
    var F = dr.fields;
    var text = function (k, max, ph) { return '<div class="field rxf" data-f="' + k + '">' + rxLabel(k, F[k]) + '<input class="input" data-v="' + k + '" maxlength="' + max + '" value="' + esc(F[k].value === null ? '' : F[k].value) + '" placeholder="' + esc(ph) + '" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="' + esc(C.MED_FIELD_LABELS[k]) + '">' + rxOk(i, k, F[k]) + '</div>'; };
    return '<section class="rx" data-rx="' + i + '" aria-label="Medicine ' + (i + 1) + '">' +
      '<div class="rx-head"><label class="check"><input type="checkbox" data-rx-on checked><span><b>' + (n > 1 ? 'Medicine ' + (i + 1) + ' of ' + n : 'The medicine') + '</b></span></label><span class="rx-left" data-rx-left></span></div>' +
      '<div class="rx-body">' +
      text('name', C.LIMITS.medName, 'As printed on the label') +
      '<div class="two">' + text('amount', C.LIMITS.medAmount, '1 tablet') + text('strength', C.LIMITS.medStrength, '25 mg') + '</div>' +
      '<div class="field rxf" data-f="frequency">' + rxLabel('frequency', F.frequency) +
      '<span class="said">' + (dr.said ? 'The paperwork says: “' + esc(dr.said) + '”' : 'The paperwork didn’t say, or it couldn’t be read.') + '</span>' +
      '<select class="input" data-v="freq" aria-label="How often"><option value="">Choose…</option>' + C.FREQUENCIES.map(function (f) { return '<option value="' + f.id + '"' + (f.id === dr.freq ? ' selected' : '') + '>' + esc(f.label) + '</option>'; }).join('') + '</select>' +
      '<div class="rx-times" data-times>' + rxTimes(dr.times) + '</div><span class="hint">Pawlog sets the reminder times - move them to suit your day.</span>' + rxOk(i, 'frequency', F.frequency) + '</div>' +
      '<div class="two"><div class="field rxf" data-f="start">' + rxLabel('start', F.start) + '<input class="input" type="date" data-v="start" value="' + esc(F.start.value) + '" aria-label="Starts">' + rxOk(i, 'start', F.start) + '</div>' +
      '<div class="field rxf" data-f="days">' + rxLabel('days', F.days) + '<input class="input" data-v="days" inputmode="numeric" maxlength="3" value="' + esc(F.days.value === null ? '' : F.days.value) + '" placeholder="7" aria-label="For how many days">' +
      '<label class="check small"><input type="checkbox" data-v="ongoing"><span>No end date</span></label>' + rxOk(i, 'days', F.days) + '</div></div>' +
      '<div class="field rxf" data-f="food">' + rxLabel('food', F.food) + '<select class="input" data-v="food" aria-label="With food">' + C.FOODS.map(function (f) { return '<option value="' + f.id + '"' + (f.id === F.food.value ? ' selected' : '') + '>' + esc(f.label) + '</option>'; }).join('') + '</select>' + rxOk(i, 'food', F.food) + '</div>' +
      '<p class="rx-sum" data-sum></p>' +
      '<label class="check rx-final"><input type="checkbox" data-rx-checked><span>I’ve checked this against the label</span></label>' +
      '<div class="rx-err" data-rx-err></div></div></section>';
  }
  function resultHtml(a) {
    var pr = a.proposal;
    var n = (a.drafts || []).length;
    var rest = proposalRows(pr);
    var html = '<p class="small muted">Read for ' + esc((petOf(a.pet) || {}).name || 'your pet') + '. ' + (pr.stripped ? 'Addresses, phone and account numbers were left out. ' : '') + 'Nothing is saved yet.</p>';
    if (n) {
      html += '<p class="note warn" role="note"><b>' + esc(CHECK_LINE) + '</b> Pawlog copied what the paperwork says - it never suggests or changes a dose. Anything marked “Check” was unclear or missing.</p>' +
        a.drafts.map(function (d, i) { return rxCard(d, i, n); }).join('');
    }
    if (rest) html += '<div class="sec"><h2>' + (n ? 'Also on the paper' : 'Found on the paper') + '</h2><span class="ct">untick to leave out</span></div>' + rest;
    if (!n && pr.medicines.length) html += '<p class="note warn" role="note"><b>' + esc(CHECK_LINE) + '</b> Open each medicine on Health after adding it and compare the dose and times with the label.</p>';
    html += '<div class="ferr"></div><div class="stack"><button class="btn big block" type="button" data-act="applypaper">' + (n ? 'Save what I’ve checked' : 'Add the ticked ones') + '</button><button class="btn ghost block" type="button" data-act="rereadpaper">Read a different page</button></div>';
    return html;
  }
  /** What one review card holds right now, in the shape medFromDraft takes. */
  function rxRead(card, dr, pet) {
    var v = function (k) { var el = $('[data-v="' + k + '"]', card); return el ? el.value : ''; };
    var confirmed = {};
    $$('[data-ok]', card).forEach(function (c) { if (c.checked) confirmed[c.getAttribute('data-ok')] = true; });
    for (var k in dr.touched) confirmed[k] = true;
    return {
      pet: pet, name: v('name'), strength: v('strength'), amount: v('amount'), freq: v('freq'),
      times: $$('[data-t]', card).map(function (el) { return C.parseHhmm(el.value); }),
      days: v('days'), ongoing: $('[data-v="ongoing"]', card).checked, food: v('food'), start: v('start'),
      flagged: C.MED_FIELDS.filter(function (f) { return dr.fields[f].flagged; }), confirmed: confirmed,
      checked: $('[data-rx-checked]', card).checked,
    };
  }
  /** Keep a card's summary, "to check" count and chips in step with what is
   *  typed and ticked - without redrawing the inputs. */
  function rxSync(card, dr) {
    var x = rxRead(card, dr, state.ai.pet);
    var open = x.flagged.filter(function (k) { return !x.confirmed[k]; });
    x.flagged.forEach(function (k) {
      var chip = $('[data-chip="' + k + '"]', card);
      if (chip) { chip.textContent = x.confirmed[k] ? 'Checked' : 'Check'; chip.className = 'chip ' + (x.confirmed[k] ? 'done' : 'now'); }
    });
    var on = $('[data-rx-on]', card).checked;
    card.classList.toggle('is-off', !on);
    $('[data-rx-left]', card).textContent = !on ? 'Left out' : open.length ? plural(open.length, 'thing') + ' to check' : 'All checked';
    var f = C.frequencyOf(x.freq);
    var until = x.ongoing ? null : C.courseEnd(x.start, /^\d{1,3}$/.test(String(x.days).trim()) ? Number(String(x.days).trim()) : NaN);
    var okTimes = f && x.times.length === f.times.length && x.times.every(function (t) { return t !== null; });
    $('[data-sum]', card).textContent = f && okTimes && C.isDay(x.start) && (x.ongoing || until)
      ? 'On Today: ' + C.scheduleWords(x.freq, x.times.slice().sort(function (p, q) { return p - q; }), x.start, until, today()) + '.'
      : 'Fill in how often, the start and the number of days to see the dose times.';
  }
  function bindResult(root) {
    var a = state.ai;
    $$('[data-rx]', root).forEach(function (card) {
      var dr = a.drafts[Number(card.getAttribute('data-rx'))];
      dr.touched = dr.touched || {};
      var touch = function (k) { dr.touched[k] = true; var box = $('[data-ok="' + k + '"]', card); if (box) box.checked = true; };
      card.addEventListener('input', function (e) {
        var k = e.target.getAttribute('data-v');
        if (k === 'freq') {
          var f = C.frequencyOf(e.target.value);
          $('[data-times]', card).innerHTML = rxTimes(f ? f.times : []);
          touch('frequency');
        } else if (k === 'ongoing') { if (e.target.checked) { $('[data-v="days"]', card).value = ''; touch('days'); } else delete dr.touched.days; }
        else if (k === 'days') { $('[data-v="ongoing"]', card).checked = false; touch('days'); }
        else if (k && C.MED_FIELDS.indexOf(k) >= 0) touch(k);
        $('[data-rx-err]', card).innerHTML = '';
        rxSync(card, dr);
      });
      card.addEventListener('change', function () { rxSync(card, dr); });
      rxSync(card, dr);
    });
  }
  function doRead() {
    var a = state.ai;
    var p = petOf(a.pet);
    var body = { kind: p ? p.kind : 'other', today: today() };
    if (a.how === 'photo') { if (!a.photo) return errBox($('#sheet'), 'Pick a photo first.'); body.photo = { type: a.photo.type, data: a.photo.data }; }
    else { var tx = $('#paText'); a.text = tx ? tx.value : a.text; if (!a.text.trim()) return errBox($('#sheet'), 'Paste the text first.'); body.text = a.text; }
    a.busy = true; drawPaper();
    api('POST', 'api/read-paperwork', body).then(function (r) {
      if (state.ai !== a) return;
      a.busy = false; a.proposal = r.proposal;
      a.drafts = (r.proposal.meds || []).map(function (m) { return C.medDraft(m, today()); });
      a.photo = null; // read once: the page lets go of it too
      drawPaper();
      $('#sheet').scrollTop = 0;
    }).catch(function (e) {
      if (state.ai !== a) return;
      a.busy = false; drawPaper();
      var out = $('#paOut');
      if (e.status === 402) return openCredit(e.data);
      if (e.status === 403 && e.data && e.data.code === 'verify-email') return verifyNote(out, e);
      if (e.status === 401) { loadAccount().then(drawPaper); return; }
      showError(e, out);
    });
  }
  /** Save: every medicine left in must pass medFromDraft - each flagged
   *  field confirmed or typed, the label box ticked - or NOTHING is saved
   *  and the first thing still to check is shown. */
  function applyPaper() {
    var a = state.ai, pr = a && a.proposal;
    if (!pr) return;
    var root = $('#sheet');
    var picked = {};
    $$('[data-pick]', root).forEach(function (c) { picked[c.getAttribute('data-pick')] = c.checked; });
    var t = today();
    var jobs = [];
    var bad = null;
    $$('[data-rx]', root).forEach(function (card) {
      $('[data-rx-err]', card).innerHTML = '';
      if (bad || !$('[data-rx-on]', card).checked) return;
      var dr = a.drafts[Number(card.getAttribute('data-rx'))];
      try { jobs.push(['med', { med: C.medFromDraft(rxRead(card, dr, a.pet), t) }]); } catch (e) {
        bad = e;
        $('[data-rx-err]', card).innerHTML = '<p class="err" role="alert">' + esc(e.message) + '</p>';
        var at = (e.field && $('[data-f="' + e.field + '"]', card)) || $('[data-rx-err]', card);
        at.scrollIntoView({ block: 'center' });
      }
    });
    if (bad) return;
    pr.vaccinations.forEach(function (v, i) {
      if (!picked['v' + i]) return;
      var months = v.given && v.due ? Math.max(0, Math.min(36, Math.round(C.daysBetween(v.given, v.due) / 30.44))) : C.healthOf(v.kind).months;
      jobs.push(['health', { health: { pet: a.pet, type: v.kind, name: v.name, given: v.given, due: v.due || (v.given && months ? C.addMonths(v.given, months) : null), everyMonths: months } }]);
    });
    pr.medicines.forEach(function (m, i) {
      if (!picked['m' + i]) return;
      var s = C.parseSchedule(m.schedule);
      jobs.push(['med', { med: { pet: a.pet, name: m.name, dose: m.dose, times: s.times, repeat: { every: s.repeat.every, n: s.repeat.n, anchor: t }, start: t, until: m.until } }]);
    });
    if (pr.weight && picked.w) jobs.push(['weight', { pet: a.pet, g: pr.weight.g }]);
    if (pr.nextVisit && picked.n) jobs.push(['health', { health: { pet: a.pet, type: 'visit', name: pr.nextVisit.what, given: null, due: pr.nextVisit.day, everyMonths: 0 } }]);
    if (!jobs.length) return toast('Nothing ticked.');
    var done = 0;
    var meds = jobs.filter(function (j) { return j[0] === 'med'; }).length;
    jobs.reduce(function (pChain, j) { return pChain.then(function () { return doAct(j[0], j[1]).then(function () { done++; }); }); }, Promise.resolve())
      .then(function () { state.pet = a.pet; closeSheet(true); state.tab = 'health'; redraw(); toast('Added ' + plural(done, 'thing') + '.' + (meds ? ' The doses are on Today.' : ' Check the dates on Health.')); })
      .catch(function (e) { closeSheet(true); redraw(); toast('Added ' + done + ', then: ' + e.message); });
  }

  /* ---------------- sharing ---------------- */

  function shareHome() {
    if (!state.me) return openWho(shareHome);
    var btn = $('[data-act="sharehome"]'); if (btn) btn.disabled = true;
    api('POST', 'api/homes', { home: state.doc }).then(function (r) {
      var me = state.me;
      state.mode = 'owner'; state.code = r.code; state.key = r.key; state.doc = r.home; state.owner = { link: r.link, sitters: r.sitters || [] }; state.savedAt = now();
      saveLocal(); saveMe(me); pushMine();
      draw(); scrollTo(0, 0);
      toast('Shared. Send the household link to everyone at home.');
      state.tab = 'home'; draw();
      share(state.doc.name, 'Our pets’ board - tap when you feed, walk or give meds:', linkUrl('h', r.link));
    }).catch(function (e) { if (btn) btn.disabled = false; showError(e); });
  }
  function ownerLink() {
    var url = linkUrl('o', state.code) + '#k=' + state.key;
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('Copied. Open it on your other device - and keep it to yourself.'); }, function () { prompt('Your owner link:', url); });
    else prompt('Your owner link:', url);
  }

  /* ---------------- the account ---------------- */

  var FREE_LINE = 'Pawlog works without an account. A free account keeps your household on all your phones and lets AI read the vet’s paperwork, with $2 of AI credit. One account works across every app on this site.';
  function loadAccount() {
    return api('GET', 'api/me').then(function (me) { state.account = me; drawTop(); return me; })
      .catch(function () { state.account = { signedIn: false }; drawTop(); return state.account; });
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
        (pkOk() && mode === 'login' ? '<button class="btn ghost block mt8" id="pkBtn" type="button">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center mt12">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      $('#swap', root).addEventListener('click', function () { mode = mode === 'register' ? 'login' : 'register'; draw2(root); });
      $('#authForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(true); return loadAccount(); }).then(function () { syncIn(true); if (then) then(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(true); return loadAccount(); }).then(function () { syncIn(true); if (then) then(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openAccountSheet() {
    var me = state.account, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(head('Account') + '<p class="small muted wrapany">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><b>Your household</b><p class="small muted m4t">' + (syncOn() ? (state.mode === 'member' ? 'This phone is in someone else’s household through its link - nothing to keep in your account.' : 'Kept in your account, so it follows you to any phone you sign in on. Everyone else keeps using the household link.') : 'Syncing isn’t available right now - your household is safe on this phone.') + '</p></div>' +
      '<div class="note"><div class="row between"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted m4t">Reading a page of vet paperwork costs about a cent. Everything else in Pawlog is free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block mt16" id="pkEnrol" type="button">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block mt8" id="signOut" type="button">Sign out</button>' +
      '<p class="small muted mt8">Signing out keeps this phone’s copy of your household.</p>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.account = { signedIn: false }; drawTop(); draw(); });
        });
        var pk = $('#pkEnrol', root);
        if (pk) pk.addEventListener('click', function () {
          var pw = prompt('Your password for this site, to confirm it is you:');
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
    sheet(head('Out of AI credit') + '<p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The board, the links, health records by hand and the calendar keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });

  /* ---------------- one click listener ---------------- */

  function setTab(tab) {
    if (TABS.indexOf(tab) < 0) return;
    state.tab = tab; keep(K_TAB, tab);
    closeSheet(true); draw(); scrollTo(0, 0);
    var m = $('#main'); if (m) m.focus({ preventScroll: true });
  }
  function twice(t, key, words) {
    if (state.armed !== key) { state.armed = key; t.textContent = words; return false; }
    state.armed = null; return true;
  }
  function forgetLink() {
    state.gone = null; state.mode = 'none'; state.doc = null; state.code = null;
    if (ROUTE) { history.replaceState(null, '', BASE); }
    keep(K_JOINED, null);
    if (loadOwn()) loadMe();
    draw(); fetchRemote();
  }
  document.addEventListener('submit', function (e) {
    if (e.target && e.target.id === 'joinForm') {
      e.preventDefault();
      doAct('join', { name: $('#joinName').value }).then(function (r) { saveMe(r.member.id); draw(); toast('Welcome, ' + r.member.name + '! Tap a job when you’ve done it.'); })
        .catch(function (err) { $('#joinErr').innerHTML = '<p class="err" role="alert">' + esc(err.message) + '</p>'; });
    }
  });
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var a = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    if (['delpet', 'delitem', 'delmed', 'delhealth', 'stopmed', 'wipe', 'deletehome', 'leave', 'relink', 'closesitter'].indexOf(a) < 0) state.armed = null;
    switch (a) {
      case 'home': e.preventDefault(); if (state.mode === 'sitter') location.href = BASE; else if (state.mode === 'preview') endPreview(); else setTab('today'); break;
      case 'closesheet': closeSheet(); break;
      case 'tab': setTab(t.getAttribute('data-tab')); break;
      case 'sample':
        state.mode = 'local'; state.doc = C.sample(now(), PHONE_TZ); state.tab = 'today'; state.pet = null;
        keep(K_HOME, { mode: 'local', doc: state.doc, savedAt: 0 }); saveMe('sample-alex');
        draw(); scrollTo(0, 0);
        toast('A made-up home. You’re Alex - try tapping Miso’s breakfast.');
        break;
      case 'clearsample': case 'mine':
        keep(K_HOME, null); state.mode = 'none'; state.doc = null; state.me = null;
        draw(); scrollTo(0, 0);
        if (a === 'mine') openSetup(); else toast('Sample cleared.');
        break;
      case 'setup': openSetup(); break;
      case 'who': openWho(); break;
      case 'iam': saveMe(id); draw(); toast('Hi ' + memberOf(id).name + '! Tap a job when you’ve done it.'); break;
      case 'task': tapTask(t.getAttribute('data-key'), false); break;
      case 'again': tapTask(t.getAttribute('data-key'), true); break;
      case 'undo': $$('.toast').forEach(function (x) { x.remove(); }); undo(t.getAttribute('data-log')); break;
      case 'pickpet': state.pet = id; redraw(); break;
      case 'addpet': openPet(null); break;
      case 'openpet': openPet(id); break;
      case 'item': openItem(id, t.getAttribute('data-pet')); break;
      case 'med': openMed(id); break;
      case 'health': openHealth(id); break;
      case 'weight': openWeight(); break;
      case 'vet': openVet(); break;
      case 'homeedit': openHomeEdit(); break;
      case 'addperson': openAddPerson(); break;
      case 'given': doAct('given', { id: id }).then(function (r) { toast(r.health.due ? 'Done. Next due ' + C.fmtDay(r.health.due, today()) + '.' : 'Done.'); redraw(); }).catch(showError); break;
      case 'stopmed': if (twice(t, 'stop:' + id, 'Tap again')) doAct('stopmed', { id: id }).then(function () { toast('Course ends today.'); redraw(); }).catch(showError); break;
      case 'delpet': {
        var dp = petOf(id);
        if (twice(t, 'delpet:' + id, 'Tap again to remove ' + (dp ? dp.name : '') + ' and their records')) doAct('unpet', { id: id }).then(function () { closeSheet(true); state.pet = null; redraw(); toast('Removed.'); }).catch(showError);
        break;
      }
      case 'delitem': { var it = state.doc.items.filter(function (x) { return x.id === id; })[0]; if (twice(t, 'delitem:' + id, 'Tap again to remove')) doAct('unitem', { id: id }).then(function () { if (it) openPet(it.pet); redraw(); }).catch(showError); break; }
      case 'delmed': if (twice(t, 'delmed:' + id, 'Tap again to delete')) doAct('unmed', { id: id }).then(function () { closeSheet(true); redraw(); }).catch(showError); break;
      case 'delhealth': if (twice(t, 'delh:' + id, 'Tap again to delete')) doAct('unhealth', { id: id }).then(function () { closeSheet(true); redraw(); }).catch(showError); break;
      case 'units': doAct('home', { units: t.getAttribute('data-u') }).then(redraw).catch(showError); break;
      case 'usetz': doAct('home', { tz: PHONE_TZ }).then(function () { toast('Times now follow this phone’s zone.'); redraw(); }).catch(showError); break;
      case 'ics': {
        var t0 = today();
        var text = C.buildIcs(state.doc, { today: t0, nowMs: now() });
        if (text.indexOf('BEGIN:VEVENT') < 0) { toast('Add a due date on Health first.'); break; }
        download('pawlog-due-dates.ics', text, 'text/calendar;charset=utf-8');
        toast('Calendar file downloaded - open it to add the due dates, with reminders.');
        break;
      }
      case 'paper': openPaper(); break;
      case 'doread': doRead(); break;
      case 'applypaper': applyPaper(); break;
      case 'rereadpaper': if (state.ai) { state.ai.proposal = null; state.ai.drafts = null; drawPaper(); } break;
      case 'signup': openAccount(null, function () { if (state.doc) openPaper(); }); break;
      case 'signin': openAccount(null, function () { if (state.doc) openPaper(); }, true); break;
      case 'sharehome': shareHome(); break;
      case 'sharelink': share(state.doc.name, 'Our pets’ board - tap when you feed, walk or give meds:', linkUrl('h', state.mode === 'owner' ? state.owner.link : state.code)); break;
      case 'relink': if (twice(t, 'relink', 'Tap again - the old link stops working')) doAct('relink', {}).then(function () { toast('New link made. The old one no longer opens.'); redraw(); }).catch(showError); break;
      case 'sitter': openSitter(); break;
      case 'sharesitter': shareSitter(t.getAttribute('data-code')); break;
      case 'closesitter': if (twice(t, 'cs:' + t.getAttribute('data-code'), 'Tap again')) doAct('unsitter', { code: t.getAttribute('data-code') }).then(function () { toast('Closed. That link no longer opens.'); redraw(); }).catch(showError); break;
      case 'ownerlink': ownerLink(); break;
      case 'previewsitter': {
        var until = C.addDays(today(), 5);
        state.preview = { mode: state.mode, doc: state.doc };
        state.doc = C.sitterView(state.doc, { code: 'PREVIEW234', name: 'Jo', until: until }, now());
        state.mode = 'preview'; draw(); scrollTo(0, 0);
        break;
      }
      case 'endpreview': endPreview(); break;
      case 'forget': forgetLink(); break;
      case 'deletehome':
        if (twice(t, 'del', 'Tap again - every link stops working')) {
          api('DELETE', 'api/homes/' + state.code, null, { 'X-Pawlog-Key': state.key }).catch(function () { return null; }).then(function () {
            keep(K_HOME, null); state.mode = 'none'; state.doc = null; state.code = null; state.key = null;
            if (syncOn()) api('DELETE', 'api/mine').catch(function () { return null; });
            draw(); scrollTo(0, 0); toast('Deleted. Every link to it is closed.');
          });
        }
        break;
      case 'leave': if (twice(t, 'leave', 'Tap again to leave on this phone')) { keep(K_JOINED, null); history.replaceState(null, '', BASE); location.reload(); } break;
      case 'wipe':
        if (twice(t, 'wipe', 'Tap again to clear everything here')) { keep(K_HOME, null); state.mode = 'none'; state.doc = null; draw(); scrollTo(0, 0); toast('Cleared from this phone.'); }
        break;
      default: break;
    }
  });
  function endPreview() {
    if (!state.preview) return;
    state.mode = state.preview.mode; state.doc = state.preview.doc; state.preview = null; state.tab = 'home';
    draw(); scrollTo(0, 0);
  }

  /* ---------------- start ---------------- */

  var saved = recall(K_TAB);
  if (TABS.indexOf(saved) >= 0) state.tab = saved;
  if (ROUTE && ROUTE.kind === 'o') {
    var k = /(?:^#|&)k=([A-Za-z0-9_-]{22})(?:&|$)/.exec(location.hash || '');
    history.replaceState(null, '', BASE);
    var have = recall(K_HOME);
    if (k && (!have || (have.doc && have.doc.sample) || have.code === ROUTE.code)) {
      keep(K_HOME, { mode: 'owner', code: ROUTE.code, key: k[1], savedAt: 0 });
    } else if (k) {
      toast('This phone already has its own household - clear it on Home first, then open the owner link again.', 7000);
    }
    loadOwn(); loadMe();
  } else if (ROUTE) {
    state.mode = ROUTE.kind === 'h' ? 'member' : 'sitter';
    state.code = ROUTE.code;
    document.title = (ROUTE.kind === 's' ? 'Pet sitting' : 'Our pets') + ' - Pawlog';
  } else if (!loadOwn()) {
    var j = recall(K_JOINED);
    if (j && /^[A-Z2-9]{10}$/.test(j.code || '')) { location.replace(BASE + 'h/' + j.code); return; }
  } else {
    loadMe();
  }
  draw();
  if (['owner', 'member', 'sitter'].indexOf(state.mode) >= 0) fetchRemote();
  loadAccount().then(function () { if (!ROUTE || ROUTE.kind === 'o') syncIn(false); });
  // Everyone's board stays current: ask again every 20 seconds while the
  // page is on screen (one small read when nothing moved), and on return.
  // Redraw every half minute so "Due now" and the overdue glow follow the
  // clock without a server.
  setInterval(function () { if (document.visibilityState === 'visible') fetchRemote(); }, 20000);
  setInterval(function () { if (document.visibilityState === 'visible' && $('#sheet').hidden && state.doc) redraw(); }, 30000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { fetchRemote(); if ($('#sheet').hidden && state.doc) redraw(); } });
  if ('serviceWorker' in navigator && !ROUTE) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* no offline copy, still works online */ });
  }
}());
