/* Settle - the page. One file, no build step. Every string that came from
 * outside this file (a typed question, an option, a friend's name, a model's
 * suggestion, anything from the server) is escaped before it is drawn, and
 * no handler is written into markup: clicks are routed by data-act
 * attributes from one listener (the lab's CSP allows script from this
 * origin only). The rules - the match, the runoff, the wheel - are
 * settle-core.js, the same file the server and the tests run.
 *
 * Views:
 *   start    - the hero: Try it now, Start a decision, Join with a code.
 *   demo     - "Friday dinner?" with three made-up friends, on this phone
 *              only, drawn by the very same functions as a real one.
 *   new      - the form: a question, options (a deck, typed, or AI), a mode.
 *   d/<id>   - a decision: swipe or rank, wait, the reveal.
 *   j/<code> - joining one, with a name and no account.
 */
(function () {
  'use strict';

  var C = window.SettleCore;
  var QR = window.SettleQR;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_RECENT = 'settle-recent-v1';
  var K_NAME = 'settle-name-v1';
  var K_SPUN = 'settle-spun-v1';
  var POLL_MS = 4000;
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DEC_ID = (function () { var m = /\/d\/([A-Za-z0-9_-]{16})\/?$/.exec(location.pathname); return m ? m[1] : null; }());
  var JOIN_CODE = (function () { var m = /\/j\/([A-Za-z0-9-]{4,16})\/?$/.exec(location.pathname); return m ? m[1].toUpperCase().replace(/[^A-Z0-9]/g, '') : null; }());
  var DEMO_ME = 'vyou00000';
  var WORD = { yes: 'Yes', no: 'Nope', love: 'Love' };
  var WHEEL = ['#ddd6fe', '#fbcfe8', '#bbf7d0', '#fde68a', '#bae6fd', '#fecaca', '#e9d5ff', '#c7f9cc'];
  var CONFETTI = ['#7c3aed', '#db2777', '#16a34a', '#f59e0b', '#0ea5e9', '#f43f5e'];
  var EXAMPLES = ['cheap date ideas in winter', 'family movies for a 7 and 10 year old', 'board games for six adults', 'weekend trips by train from the city'];

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var plural = C.plural;

  var state = {
    me: null,          // the account, if any (only "Fill the deck" needs one)
    view: 'start',     // start | demo | new | join | d
    d: null,           // the decision as this member sees it
    demo: null,        // the demo's own document
    landed: {},        // demo friends whose votes have landed
    curId: null,       // the card on top
    vetoArm: null,     // a veto waiting for its second tap
    rankDraft: null,   // the top 3 being arranged
    rankEditing: false,
    dragging: false,
    timer: null,
    seen: {},          // reveals already celebrated in this page
    spun: {},          // wheels spun in this page
    join: null,
    draft: null,       // the new-decision form
    ai: null,          // {prompt, list}
  };
  var main = $('#main');

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
  function say(msg) { var l = $('#live'); if (l) { l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); } }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  /** The phone's own share sheet - Settle never sends anything itself. */
  function share(title, text) {
    if (navigator.share) navigator.share({ title: title, text: text }).catch(function () { /* closed */ });
    else copy(text, 'Copied - paste it in the group chat');
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function isDemo() { return state.view === 'demo'; }
  function joinLink(V) { return location.origin + BASE + 'j/' + V.code; }
  function remember(id, q) {
    var list = (recall(K_RECENT) || []).filter(function (x) { return x && x.id !== id; });
    list.unshift({ id: id, q: C.clean(q, 120), at: Date.now() });
    keep(K_RECENT, list.slice(0, 12));
  }
  function forget(id) { keep(K_RECENT, (recall(K_RECENT) || []).filter(function (x) { return x && x.id !== id; })); }
  function myName() { var n = recall(K_NAME); return typeof n === 'string' ? C.cleanName(n) : ''; }
  function spunKey(V) { return V.id + ':' + V.round; }
  function isSpun(V) {
    if (state.spun[spunKey(V)]) return true;
    var s = recall(K_SPUN);
    return Boolean(s && s.indexOf && s.indexOf(spunKey(V)) >= 0);
  }
  function markSpun(V) {
    state.spun[spunKey(V)] = true;
    if (isDemo()) return;
    var s = recall(K_SPUN);
    s = Array.isArray(s) ? s : [];
    s.push(spunKey(V));
    keep(K_SPUN, s.slice(-40));
  }
  function timeLabel(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function dueLabel(ms) {
    var left = ms - Date.now();
    if (left <= 0) return 'the deadline passed';
    if (left < 60 * 60 * 1000) return 'closes in ' + Math.max(1, Math.round(left / 60000)) + ' min';
    var sameDay = new Date(ms).toDateString() === new Date().toDateString();
    return 'decides at ' + timeLabel(ms) + (sameDay ? '' : ' tomorrow');
  }
  function optionEmoji(o) { return o.emoji ? esc(o.emoji) : '<span aria-hidden="true">' + esc(Array.from(o.label)[0].toUpperCase()) + '</span>'; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. The decks and typing your own still work meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).addEventListener('click', function () {
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { toast('Sent - check your email.'); }, function () { toast('Could not send it. Try again in a minute.'); });
    });
  }

  /* ---------------- routing ---------------- */

  function go(hash) { history.pushState(null, '', BASE + (hash ? '#' + hash : '')); route(); scrollTo(0, 0); }
  function route() {
    stopPolling();
    if (JOIN_CODE) { state.view = 'join'; draw(); return loadJoin(); }
    if (DEC_ID) { state.view = 'd'; draw(); return loadDecision(); }
    var h = location.hash.slice(1);
    if (h === 'demo') return startDemo();
    if (h === 'new') {
      // "Settle another" arrives as ?after=<the last decision's id>.
      var after = /^[A-Za-z0-9_-]{16}$/.test(new URLSearchParams(location.search).get('after') || '') ? new URLSearchParams(location.search).get('after') : null;
      if (!state.draft) state.draft = newDraft(after);
      state.view = 'new';
      return draw();
    }
    state.view = 'start';
    draw();
  }
  window.addEventListener('popstate', route);

  function draw() {
    var keepId = document.activeElement && document.activeElement.id;
    if (state.view === 'start') drawStart();
    else if (state.view === 'new') drawNew();
    else if (state.view === 'join') drawJoin();
    else drawDecision();
    if (keepId && keepId !== 'main') { var el = document.getElementById(keepId); if (el && el.focus) try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }

  /* ---------------- start ---------------- */

  function choice(act, cls, icon, title, sub) {
    return '<button class="choice ' + cls + '" type="button" data-act="' + act + '"><span class="ci" aria-hidden="true">' + icon + '</span><span class="ct"><b>' + title + '</b><span>' + sub + '</span></span><span class="chev" aria-hidden="true">›</span></button>';
  }
  function drawStart() {
    var recent = (recall(K_RECENT) || []).filter(function (x) { return x && typeof x.id === 'string' && /^[A-Za-z0-9_-]{16}$/.test(x.id); });
    main.innerHTML = '<div class="dk-split"><section class="hero">' +
      '<div class="fan" aria-hidden="true"><span>🍕</span><span>🍜</span><span>🌮</span><i class="n">NOPE</i><i class="y">YES</i></div>' +
      '<h1>Where are we eating? <em>Settle it in a minute.</em></h1>' +
      '<p class="lede">Everyone swipes, nobody argues. Send one link to the group chat - each person swipes Yes, No or Love on their own phone, no app and no account - and Settle finds the match.</p>' +
      '<div class="choices">' +
      choice('demo', 'primary', '✨', 'Try it now', '“Friday dinner?” - swipe 8 options with three friends') +
      choice('new', '', '🗳️', 'Start a decision', 'A question, some options or a ready-made deck, one link') +
      choice('joincode', '', '🔑', 'Join with a code', 'Six characters from whoever sent it') +
      '</div></section><div>' +
      '<section class="card"><h2>How it works</h2><ol class="steps">' +
      '<li><span class="sn">1</span><span><b>Ask and pick options.</b> Type them, or grab a deck: cuisines, takeaway, date night, movies, games, rainy days, holidays.</span></li>' +
      '<li><span class="sn">2</span><span><b>Send the link.</b> Or show the QR code, or read out six letters. Nobody installs anything.</span></li>' +
      '<li><span class="sn">3</span><span><b>Everyone swipes.</b> Yes, No or Love - nobody sees anyone’s votes until the reveal. One veto each for the thing you really can’t face.</span></li>' +
      '<li><span class="sn">4</span><span><b>It’s a match.</b> The first thing everyone said yes to. A tie? The wheel spins - the same on every phone.</span></li>' +
      '</ol></section>' +
      (recent.length ? '<section class="card"><h2>Your decisions</h2><ul class="tlist">' + recent.slice(0, 8).map(function (r) {
        return '<li><a href="' + esc(BASE + 'd/' + r.id) + '"><span aria-hidden="true">🗳️</span><span class="tn"><b>' + esc(C.clean(r.q, 120) || 'A decision') + '</b><span>' + esc(new Date(r.at || 0).toLocaleDateString([], { month: 'short', day: 'numeric' })) + '</span></span><span aria-hidden="true">›</span></a></li>';
      }).join('') + '</ul></section>' : '') +
      '</div></div>' + footer();
  }
  function footer() {
    return '<footer class="foot small muted"><p>No account to vote. Names are whatever you type, votes stay hidden until the reveal, and a decision disappears 14 days after anyone last touched it.</p><p>A free account is only needed for “Fill the deck for me”, which uses AI (it comes with $2 of credit).</p></footer>';
  }

  function openJoinCode() {
    sheet('<h2>Join with a code</h2><p class="muted">Six characters - it’s under the QR code on whoever’s phone started it.</p>' +
      '<form id="codeForm"><label class="field"><span>Code</span><input class="input" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="9" placeholder="ABC-DEF" required></label><div id="codeErr"></div><button class="btn block big" type="submit">Join</button></form>', function (root) {
      $('#codeForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var c = String(e.target.code.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (c.length !== 6) { $('#codeErr', root).innerHTML = '<p class="err" role="alert">That’s ' + c.length + ' characters - a code has six.</p>'; return; }
        location.href = BASE + 'j/' + c;
      });
    });
  }

  /* ---------------- the demo ---------------- */

  function startDemo() {
    state.view = 'demo';
    state.demo = C.demoDecision(Date.now());
    state.landed = {};
    state.curId = null; state.vetoArm = null; state.rankDraft = null; state.demoFinishing = false;
    var k = state.demo.id + ':1';
    delete state.spun[k]; delete state.seen[k];
    state.d = demoView();
    draw();
  }
  function demoView() { return C.memberView(state.demo, { vid: DEMO_ME, host: true }, Date.now()); }
  /** Friends' votes land as you swipe: Sam after your 2nd card, Maya after
   *  your 4th, Jordan after your 6th - and anyone left once you finish. */
  function demoLand(all) {
    var n = Object.keys(state.demo.ballots[DEMO_ME] || {}).length;
    var news = [];
    C.DEMO.friends.forEach(function (f, i) {
      if (state.landed[i] || (!all && n < f.after)) return;
      state.landed[i] = Date.now();
      C.demoLand(state.demo, i);
      news.push(f.name);
    });
    if (news.length) { toast(C.nameList(news) + (news.length > 1 ? ' have' : ' has') + ' voted ✓', 1800); say(C.nameList(news) + ' voted.'); }
  }

  /* ---------------- acting on a decision (online or the demo) ---------------- */

  function act(kind, body) {
    if (isDemo()) {
      var doc = state.demo; var now = Date.now(); var r;
      try {
        if (kind === 'vote') r = C.swipe(doc, DEMO_ME, body.oid, body.v, now);
        else if (kind === 'veto') r = C.veto(doc, DEMO_ME, body.oid, now);
        else if (kind === 'rank') r = C.rank(doc, DEMO_ME, body.order, now);
        else if (kind === 'close') r = C.close(doc, now);
        else if (kind === 'reopen') r = C.reopenTop(doc, now);
      } catch (e) { return Promise.reject(e); }
      C.applyPatch(doc, r.patch);
      doc.v++;
      if (kind === 'vote') demoLand(false);
      if (kind === 'reopen') { state.landed = {}; }
      state.d = demoView();
      return Promise.resolve({ d: state.d, msg: r.msg, status: r.status });
    }
    var method = kind === 'close' || kind === 'reopen' ? 'POST' : 'PUT';
    return api(method, 'api/d/' + DEC_ID + '/' + kind, body).then(function (r) { state.d = r.d; return r; });
  }

  /* ---------------- the decision ---------------- */

  function liveIds(V) { return V.active.filter(function (id) { return !Object.prototype.hasOwnProperty.call(V.vetoed, id); }); }
  function opt(V, id) { return C.optionOf(V, id); }
  function meDone(V) {
    var L = liveIds(V);
    if (V.mode === 'rank') return V.mine.rank.some(function (id) { return L.indexOf(id) >= 0; });
    return L.every(function (id) { return Object.prototype.hasOwnProperty.call(V.mine.ballot, id); });
  }
  /** The card on top: the one being looked at again, else the first not
   *  swiped yet; null when every card is done. */
  function curCard(V) {
    var L = liveIds(V);
    if (state.curId && L.indexOf(state.curId) >= 0) return state.curId;
    for (var i = 0; i < L.length; i++) if (!Object.prototype.hasOwnProperty.call(V.mine.ballot, L[i])) return L[i];
    return null;
  }
  function drawDecision() {
    var V = state.d;
    if (!V) { main.innerHTML = '<p class="busy">Opening…</p>'; return; }
    if (V.gone) { main.innerHTML = V.gone; return; }
    var st = V.status;
    var html = '<div class="narrow">';
    if (isDemo()) html += '<div class="strip"><p><b>A demo</b> with three made-up friends. Nothing is saved.</p><button class="btn small light" type="button" data-act="new">Start your own</button></div>';
    html += head(V);
    if (st.open) {
      if (V.mode === 'swipe') html += curCard(V) ? swipeDeck(V) : waiting(V);
      else html += (state.rankEditing || !meDone(V)) ? rankUI(V) : waiting(V);
      if (V.live && V.result) html += tally(V, true);
    } else html += reveal(V);
    html += '</div>';
    main.innerHTML = html;
    bindDecision(V);
  }

  function head(V) {
    var st = V.status;
    var bits = [];
    if (st.open) {
      bits.push(st.done + ' of ' + (st.expected || st.joined) + ' voted');
      if (V.deadline) bits.push(dueLabel(V.deadline));
    } else bits.push(C.closedText(st).replace(/\.$/, ''));
    var people = '<ul class="people" aria-label="Who’s here">' + V.people.map(function (p, i) {
      var landed = isDemo() && p.done && !p.you && state.landed[i - 1] && Date.now() - state.landed[i - 1] < 1500;
      return '<li class="' + (p.done ? 'done' : '') + (landed ? ' landed' : '') + '"><span class="av" aria-hidden="true">' + (p.done ? '✓' : esc(p.emoji || Array.from(p.name)[0].toUpperCase())) + '</span><span class="pn">' + esc(p.you ? 'You' : p.name) + '<span class="vh">' + (p.done ? ' has voted' : p.started ? ' is voting' : ' hasn’t started') + '</span></span></li>';
    }).join('') + (st.open && st.expected && st.joined < st.expected ? '<li><span class="av" aria-hidden="true">…</span><span class="pn">' + (st.expected - st.joined) + ' more to join</span></li>' : '') + '</ul>';
    var prog = '';
    if (st.open && V.mode === 'swipe' && curCard(V)) {
      var L = liveIds(V);
      var done = L.filter(function (id) { return Object.prototype.hasOwnProperty.call(V.mine.ballot, id); }).length;
      prog = '<div class="progress" role="progressbar" aria-label="Your swipes" aria-valuemin="0" aria-valuemax="' + L.length + '" aria-valuenow="' + done + '"><i style="width:' + Math.round(100 * done / Math.max(1, L.length)) + '%"></i></div>';
    }
    var inv = st.open && !isDemo() ? '<button class="btn small ghost invite" type="button" data-act="share">📣 ' + (V.host && st.joined < 2 ? 'Send it to the group' : 'Invite') + '</button>' : '';
    return '<section class="dhead"><p class="eyebrow">' + (V.round > 1 ? 'Round ' + V.round + ' · ' : '') + (V.mode === 'rank' ? (st.open ? 'Rank your top 3' : 'Ranked choice') : 'Swipe') + '</p><h1>' + esc(V.question) + '</h1><p class="dmeta">' + esc(bits.join(' · ')) + '</p>' + people + inv + prog + '</section>';
  }

  function swipeDeck(V) {
    var L = liveIds(V);
    var id = curCard(V);
    var i = L.indexOf(id);
    var o = opt(V, id);
    var was = V.mine.ballot[id];
    var under = '';
    var rest = L.slice(i + 1).filter(function (x) { return !Object.prototype.hasOwnProperty.call(V.mine.ballot, x); });
    if (rest[1]) under += '<div class="sw-card next2" aria-hidden="true"></div>';
    if (rest[0]) under += '<div class="sw-card next" aria-hidden="true"><span class="ce">' + optionEmoji(opt(V, rest[0])) + '</span></div>';
    var mineVeto = V.mine.veto ? opt(V, V.mine.veto) : null;
    var vet = Object.keys(V.vetoed).filter(function (k) { return V.active.indexOf(k) >= 0; });
    var html = '<div class="deckwrap" id="deckwrap">' + under +
      '<div class="sw-card top" id="topCard" tabindex="0" role="group" aria-roledescription="card" aria-label="' + esc(o.label + ', ' + (i + 1) + ' of ' + L.length + (was ? ', you said ' + WORD[was] : '') + '. Right arrow for yes, left for no, up to love it.') + '">' +
      '<span class="cnum">' + (i + 1) + ' / ' + L.length + '</span>' +
      '<span class="ce">' + optionEmoji(o) + '</span><h2>' + esc(o.label) + '</h2>' + (o.note ? '<p class="cn">' + esc(o.note) + '</p>' : '') +
      (was ? '<p class="was">You said ' + WORD[was] + ' - swipe again to change it</p>' : '') +
      '<span class="stamp yes" aria-hidden="true">YES</span><span class="stamp no" aria-hidden="true">NOPE</span><span class="stamp love" aria-hidden="true">LOVE ♥</span></div></div>' +
      '<div class="swbtns">' +
      '<button class="swb no" type="button" data-act="sw" data-v="no" aria-pressed="' + (was === 'no') + '" aria-label="No to ' + esc(o.label) + '">✕<small>Nope</small></button>' +
      '<button class="swb love" type="button" data-act="sw" data-v="love" aria-pressed="' + (was === 'love') + '" aria-label="Love ' + esc(o.label) + '">♥<small>Love</small></button>' +
      '<button class="swb yes" type="button" data-act="sw" data-v="yes" aria-pressed="' + (was === 'yes') + '" aria-label="Yes to ' + esc(o.label) + '">✓<small>Yes</small></button></div>' +
      '<div class="swtools">' +
      (i > 0 ? '<button class="link-btn" type="button" data-act="back">↩ Back</button>' : '') +
      (V.vetoes ? (mineVeto ? '<button class="link-btn vetobtn" type="button" data-act="unveto">🚫 Your veto: ' + esc(mineVeto.label) + ' · take it back</button>'
        : '<button class="link-btn vetobtn" type="button" data-act="veto" data-oid="' + esc(id) + '">' + (state.vetoArm === id ? 'Tap again: veto ' + esc(o.label) + ' for everyone' : '🚫 Veto this (you get one)') + '</button>') : '') +
      (state.curId && meDone(V) ? '<button class="link-btn" type="button" data-act="donereview">Done ✓</button>' : '') +
      '</div><p class="kbd-hint">Drag the card - right for yes, left for no, up to love it. Or tap a button, or use the arrow keys.</p>';
    if (vet.length) html += '<p class="vetoed-line">🚫 Out: ' + vet.map(function (k) { return esc(opt(V, k).label) + ' <span class="small">(' + esc(V.vetoed[k] === 'you' ? 'your veto' : 'vetoed by ' + V.vetoed[k]) + ')</span>'; }).join(', ') + '</p>';
    return html;
  }

  function waiting(V) {
    var st = V.status;
    var hidden = !V.live;
    var html = '<section class="card waiting"><div class="big-emoji" aria-hidden="true">🙌</div><h2>You’re done!</h2>' +
      '<p class="ring">' + st.done + ' of ' + (st.expected || st.joined) + '</p><p class="muted">' + (st.done === 1 ? 'has' : 'have') + ' voted. ' + (hidden ? 'Nobody sees anyone’s votes until the reveal.' : 'The tally below moves as people vote.') + '</p>';
    var when = [];
    if (st.expected) when.push('when all ' + st.expected + ' have voted');
    if (V.deadline) when.push('at ' + timeLabel(V.deadline));
    if (V.host) {
      html += '<div class="hostbar">' + (isDemo() ? '' : '<button class="btn ghost" type="button" data-act="share">Invite more</button>') + '<button class="btn" type="button" data-act="close">' + (st.done >= Math.max(2, st.joined) ? 'Everyone’s in - reveal!' : 'Reveal now') + '</button></div>';
      html += '<p class="small muted" style="margin-top:10px">You’re the host: reveal whenever you like' + (when.length ? ', or it reveals itself ' + when.join(' or ') : '') + '.</p>';
    } else {
      html += '<p class="small muted">The reveal happens ' + (when.length ? when.join(' or ') + ', or when the host taps Reveal' : 'when the host taps Reveal') + '. Leave this open - it updates by itself.</p>';
      html += '<button class="btn ghost block" type="button" data-act="share">Invite someone</button>';
    }
    html += '<button class="link-btn" type="button" data-act="review">' + (V.mode === 'rank' ? 'Change my top 3' : 'Change my votes') + '</button></section>';
    return html;
  }

  function tally(V, live) {
    var R = V.result;
    if (!R || !R.rows.length) return '';
    var html = '<section class="card"><h2>' + (live ? 'The tally so far' : 'The ranking') + '</h2>' + (live ? '<p class="small muted">The host turned on “show as we go”. It settles at the reveal.</p>' : '') + '<ol class="ranking">';
    if (R.mode === 'swipe') {
      var top = Math.max.apply(null, R.rows.map(function (r) { return r.score; }).concat([1]));
      html += R.rows.map(function (r) {
        var who = '';
        if (r.by && (r.by.love.length || r.by.yes.length)) who = '<span class="who">' + (r.by.love.length ? '♥ ' + esc(r.by.love.join(', ')) : '') + (r.by.love.length && r.by.yes.length ? ' · ' : '') + (r.by.yes.length ? '✓ ' + esc(r.by.yes.join(', ')) : '') + '</span>';
        var isWin = !live && r.id === R.winner;
        return '<li class="' + (isWin ? 'win' : '') + (r.match ? ' match' : '') + '"><span class="rp">' + r.place + '</span><span class="re" aria-hidden="true">' + optionEmoji(r) + '</span><span class="rl">' + esc(r.label) + (r.match ? '<span class="tag match">Match</span>' : '') + '</span>' +
          '<span class="rs">' + r.love + ' ♥ · ' + r.yes + ' ✓ · ' + r.no + ' ✕<span class="vh"> - ' + r.love + ' love, ' + r.yes + ' yes, ' + r.no + ' no</span></span>' +
          '<span class="bar" aria-hidden="true"><i style="width:' + Math.round(100 * r.score / top) + '%"></i></span>' + who + '</li>';
      }).join('');
    } else {
      var topP = Math.max.apply(null, R.rows.map(function (r) { return r.points; }).concat([1]));
      html += R.rows.map(function (r) {
        var isWin = !live && r.id === R.winner;
        return '<li class="' + (isWin ? 'win' : '') + '"><span class="rp">' + r.place + '</span><span class="re" aria-hidden="true">' + optionEmoji(r) + '</span><span class="rl">' + esc(r.label) + '</span>' +
          '<span class="rs">' + plural(r.firsts, 'first pick') + ' · ' + r.points + ' pts</span><span class="bar" aria-hidden="true"><i style="width:' + Math.round(100 * r.points / topP) + '%"></i></span></li>';
      }).join('');
    }
    html += (R.vetoed || []).map(function (id) {
      var o = opt(V, id);
      return '<li><span class="rp">-</span><span class="re" aria-hidden="true">' + optionEmoji(o) + '</span><span class="rl">' + esc(o.label) + '<span class="tag veto">Vetoed</span></span><span class="rs">' + esc(V.vetoed[id] === 'you' ? 'by you' : 'by ' + V.vetoed[id]) + '</span></li>';
    }).join('');
    return html + '</ol></section>';
  }

  function wheelSvg(V, ids) {
    var n = ids.length; var seg = 360 / n; var out = '';
    function pt(a, r) { var t = (a - 90) * Math.PI / 180; return (r * Math.cos(t)).toFixed(2) + ' ' + (r * Math.sin(t)).toFixed(2); }
    ids.forEach(function (id, i) {
      var a0 = i * seg; var a1 = (i + 1) * seg; var o = opt(V, id);
      out += '<path d="M0 0 L' + pt(a0, 100) + ' A100 100 0 ' + (seg > 180 ? 1 : 0) + ' 1 ' + pt(a1, 100) + ' Z" fill="' + WHEEL[i % WHEEL.length] + '" stroke="#ffffff" stroke-width="1.5"/>';
      var lab = Array.from(o.label); lab = lab.length > 11 ? lab.slice(0, 10).join('') + '…' : o.label;
      out += '<g transform="rotate(' + (a0 + seg / 2) + ')"><text x="0" y="-70" text-anchor="middle" font-size="20">' + esc(o.emoji || '') + '</text><text x="0" y="-48" text-anchor="middle" font-size="11" font-weight="800" fill="#1d1530">' + esc(lab) + '</text></g>';
    });
    return '<svg viewBox="-104 -104 208 208" role="img" aria-label="' + esc('A wheel between ' + C.nameList(ids.map(function (x) { return opt(V, x).label; }))) + '"><g class="spinner" id="spinner">' + out + '</g><circle r="13" fill="#ffffff" stroke="#1d1530" stroke-width="3"/></svg>';
  }

  function confetti() {
    if (REDUCED) return '';
    var s = '';
    for (var i = 0; i < 46; i++) {
      var x = (i * 37 + 11) % 100; var dl = ((i * 53) % 90) / 100; var c = CONFETTI[i % CONFETTI.length];
      s += '<i style="left:' + x + '%;background:' + c + ';animation-delay:' + dl + 's;width:' + (6 + (i % 3) * 3) + 'px"></i>';
    }
    return '<div class="confetti" aria-hidden="true">' + s + '</div>';
  }

  function reveal(V) {
    var R = V.result;
    var h = C.headline(V, R);
    var spin = R.wheel && !isSpun(V);
    var html = '';
    if (V.next) html += '<div class="nextup"><p><b>Next up:</b> “' + esc(V.next.question) + '”</p><button class="btn light" type="button" data-act="gonext">Swipe now →</button></div>';
    html += '<section class="card reveal">';
    if (spin) {
      html += '<p class="eyebrow">' + (R.how === 'match' ? (R.wheel.ids.length === 2 ? 'Two matches' : R.wheel.ids.length + ' matches') + ' - spin for it!' : 'It’s a tie - spin for it!') + '</p><h2>' + esc(C.nameList(R.wheel.ids.map(function (x) { return opt(V, x).label; }))) + '</h2>' +
        '<p class="muted small">' + (R.how === 'match' ? 'Everyone said yes to these, and loved them equally. ' : 'Level on score. ') + 'The wheel lands the same way on every phone.</p>' +
        '<div class="wheelbox"><span class="pointer" aria-hidden="true"></span>' + wheelSvg(V, R.wheel.ids) + '</div>' +
        '<button class="btn big" type="button" data-act="spin" id="spinBtn">Spin the wheel</button><br><button class="link-btn" type="button" data-act="skipspin">Skip to the winner</button>';
    } else {
      var first = !state.seen[spunKey(V)];
      state.seen[spunKey(V)] = true;
      var o = R.winner ? opt(V, R.winner) : null;
      if (o && first) html += confetti();
      html += '<p class="eyebrow">' + esc(h.eyebrow) + '</p>' +
        (o ? '<div class="winner"><span class="we" aria-hidden="true">' + optionEmoji(o) + '</span><h1>' + esc(o.label) + (h.match ? '!' : '') + '</h1></div>' : '<h1>' + esc(h.title) + '</h1>') +
        '<p class="muted">' + esc(h.line) + '</p>';
      if (o && first) say((h.match ? 'It’s a match: ' : 'Settled: ') + o.label);
      if (o && o.note) html += '<p class="small muted">' + esc(o.note) + '</p>';
      html += '<div class="row" style="margin-top:12px"><button class="btn" type="button" data-act="shareresult">Share the result</button><button class="btn ghost" type="button" data-act="copyresult">Copy</button></div>';
      if (V.host && !isDemo()) html += '<div class="row" style="margin-top:8px"><button class="btn ghost" type="button" data-act="reopen">Re-open with the top 3</button><button class="btn ghost" type="button" data-act="another">Settle another</button></div>';
      if (isDemo()) html += '<div class="row" style="margin-top:8px"><button class="btn ghost" type="button" data-act="demoagain">Swipe it again</button><button class="btn ghost" type="button" data-act="new">Start your own</button></div>';
      else if (!V.host) html += '<button class="link-btn" type="button" data-act="new">Start your own decision</button>';
    }
    html += '</section>';
    if (!spin) {
      html += tally(V, false);
      if (R.rounds) {
        html += '<section class="card"><h2>How it was decided</h2><p class="small muted">Ranked choice: each ballot counts for its highest pick still in. The fewest drops out each round until one has more than half.</p><ol class="rounds">' + R.rounds.map(function (r, i) {
          return '<li class="' + (i === R.rounds.length - 1 && R.how === 'majority' ? 'final' : '') + '">' + esc(r.text) + '</li>';
        }).join('') + '</ol></section>';
      }
      if (R.picks && R.picks.length) {
        html += '<section class="card"><h2>Everyone’s top 3</h2><ul class="tlist">' + R.picks.map(function (p) {
          return '<li><a><span class="tn"><b>' + esc(p.name) + '</b><span>' + esc(p.order.map(function (x, k) { return ['🥇', '🥈', '🥉'][k] + ' ' + opt(V, x).label; }).join(' · ')) + '</span></span></a></li>';
        }).join('') + '</ul></section>';
      }
      if (V.past && V.past.length) html += '<p class="small muted center">' + V.past.map(function (p) { return 'Round ' + p.round + ': ' + esc(p.line); }).join('<br>') + '</p>';
    }
    return html;
  }

  /* ---------------- rank ---------------- */

  function rankUI(V) {
    var L = liveIds(V);
    if (!state.rankDraft) state.rankDraft = V.mine.rank.filter(function (id) { return L.indexOf(id) >= 0; });
    var d = state.rankDraft = state.rankDraft.filter(function (id) { return L.indexOf(id) >= 0; });
    var max = Math.min(C.LIMITS.rankTop, L.length);
    var slots = '';
    for (var i = 0; i < max; i++) {
      var id = d[i];
      if (id) {
        var o = opt(V, id);
        slots += '<li class="slot filled" data-i="' + i + '"><span class="handle" aria-hidden="true">⠿</span><span class="num">' + (i + 1) + '</span><span class="sl">' + (o.emoji ? esc(o.emoji) + ' ' : '') + esc(o.label) + '</span>' +
          '<button class="mini" type="button" data-act="rk-up" data-i="' + i + '" aria-label="Move ' + esc(o.label) + ' up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button class="mini" type="button" data-act="rk-down" data-i="' + i + '" aria-label="Move ' + esc(o.label) + ' down"' + (i === d.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button class="mini" type="button" data-act="rk-rm" data-i="' + i + '" aria-label="Take ' + esc(o.label) + ' out">✕</button></li>';
      } else slots += '<li class="slot empty"><span class="num">' + (i + 1) + '</span><span class="sl">' + (i === d.length ? 'Tap your ' + ['first', 'second', 'third'][i] + ' choice below' : '') + '</span></li>';
    }
    var vet = V.vetoes;
    var pool = V.active.map(function (oid) {
      var o = opt(V, oid);
      var out = Object.prototype.hasOwnProperty.call(V.vetoed, oid);
      var k = d.indexOf(oid);
      return '<div class="prow' + (out ? ' out' : '') + '"><button class="pick" type="button" data-act="rk-add" data-oid="' + esc(oid) + '" aria-pressed="' + (k >= 0) + '"' + (out ? ' disabled' : '') + '><span class="pe" aria-hidden="true">' + optionEmoji(o) + '</span><span class="pl">' + esc(o.label) + (out ? ' <span class="small">(vetoed' + (V.vetoed[oid] === 'you' ? ' by you' : '') + ')</span>' : '') + '</span>' + (k >= 0 ? '<span class="pb">#' + (k + 1) + '</span>' : '') + '</button>' +
        (vet && !out && !V.mine.veto ? '<button class="mini veto" type="button" data-act="veto" data-oid="' + esc(oid) + '" aria-label="' + esc(state.vetoArm === oid ? 'Tap again to veto ' + o.label + ' for everyone' : 'Veto ' + o.label) + '">' + (state.vetoArm === oid ? 'Sure?' : '🚫') + '</button>' : '') +
        (vet && V.vetoed[oid] === 'you' ? '<button class="mini" type="button" data-act="unveto" aria-label="Take back your veto">↩</button>' : '') + '</div>';
    }).join('');
    return '<section class="card"><h2>Your top ' + max + '</h2><p class="small muted">Tap in order of preference. Drag a row or use the arrows to reorder.' + (vet ? ' 🚫 knocks one option out for everyone - you get one veto.' : '') + '</p>' +
      '<ol class="top3" id="top3">' + slots + '</ol><div class="pool">' + pool + '</div>' +
      '<button class="btn block big" type="button" data-act="rk-save"' + (d.length ? '' : ' disabled') + '>' + (d.length ? 'Lock in my top ' + d.length : 'Pick at least one') + '</button></section>';
  }

  /* ---------------- binding: the card and the rank rows ---------------- */

  function bindDecision(V) {
    var card = $('#topCard');
    if (card) bindCard(card);
    var t3 = $('#top3');
    if (t3) bindRankDrag(t3);
  }
  function setStamps(card, dx, dy) {
    var up = -dy > Math.abs(dx);
    var yes = !up && dx > 0 ? Math.min(1, dx / 100) : 0;
    var no = !up && dx < 0 ? Math.min(1, -dx / 100) : 0;
    var love = up ? Math.min(1, -dy / 110) : 0;
    $('.stamp.yes', card).style.opacity = yes;
    $('.stamp.no', card).style.opacity = no;
    $('.stamp.love', card).style.opacity = love;
  }
  function bindCard(card) {
    var sx = 0; var sy = 0; var dx = 0; var dy = 0; var pid = null;
    card.addEventListener('pointerdown', function (e) {
      if (e.button > 0 || state.busySwipe) return;
      pid = e.pointerId; sx = e.clientX; sy = e.clientY; dx = 0; dy = 0;
      try { card.setPointerCapture(pid); } catch (err) { /* ignore */ }
      card.classList.remove('snap'); card.classList.add('drag');
      state.dragging = true;
    });
    card.addEventListener('pointermove', function (e) {
      if (e.pointerId !== pid) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      card.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(' + (dx / 16) + 'deg)';
      setStamps(card, dx, dy);
    });
    function end(e) {
      if (e.pointerId !== pid) return;
      pid = null; state.dragging = false;
      card.classList.remove('drag');
      var v = null;
      if (-dy > 110 && -dy > Math.abs(dx)) v = 'love';
      else if (dx > 100) v = 'yes';
      else if (dx < -100) v = 'no';
      if (v) return swipe(v, card);
      card.classList.add('snap');
      card.style.transform = '';
      setStamps(card, 0, 0);
    }
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }
  /** One swipe: the card flies, the vote is sent, the next card comes up. */
  function swipe(v, card) {
    var V = state.d;
    var id = curCard(V);
    if (!id || state.busySwipe) return;
    card = card || $('#topCard');
    state.busySwipe = true;
    state.vetoArm = null;
    if (navigator.vibrate) try { navigator.vibrate(8); } catch (e) { /* ignore */ }
    var fly = { yes: 'translate(140%, 20px) rotate(24deg)', no: 'translate(-140%, 20px) rotate(-24deg)', love: 'translate(0, -130%) rotate(-4deg)' }[v];
    if (card) {
      setStamps(card, v === 'yes' ? 120 : v === 'no' ? -120 : 0, v === 'love' ? -130 : 0);
      card.classList.remove('drag', 'snap');
      if (!REDUCED) { card.classList.add('fly'); card.style.transform = fly; }
    }
    var prevBallot = Object.assign({}, V.mine.ballot);
    V.mine.ballot[id] = v; // optimistic
    // Looking back through the cards steps to the next one in order; a
    // first pass jumps to the next one not swiped yet.
    if (state.curId) { var L0 = liveIds(V); state.curId = L0[L0.indexOf(id) + 1] || null; }
    else state.curId = null;
    var p = act('vote', { oid: id, v: v });
    setTimeout(function () {
      state.busySwipe = false;
      draw();
      var nc = $('#topCard');
      if (nc && document.activeElement === document.body) try { nc.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      if (!curCard(state.d) && meDone(state.d)) say('All swiped. ' + state.d.status.done + ' of ' + (state.d.status.expected || state.d.status.joined) + ' have voted.');
    }, REDUCED ? 0 : 230);
    p.then(function () {
      if (isDemo() && meDone(state.d) && !state.demoFinishing) finishDemo();
      if (!state.busySwipe && !state.dragging) draw();
    }).catch(function (err) {
      V.mine.ballot = prevBallot;
      state.curId = id;
      if (err && err.data && err.data.code === 'vetoed') toast('Someone just vetoed that one.');
      else showError(err);
      refresh();
    });
  }
  function finishDemo() {
    state.demoFinishing = true;
    var left = C.DEMO.friends.map(function (f, i) { return i; }).filter(function (i) { return !state.landed[i]; });
    var step = function () {
      if (!isDemo()) return;
      var i = left.shift();
      if (i !== undefined) {
        state.landed[i] = Date.now(); C.demoLand(state.demo, i); state.demo.v++;
        toast(C.DEMO.friends[i].name + ' has voted ✓', 1400);
      }
      state.d = demoView();
      if (!state.dragging) draw();
      if (left.length) setTimeout(step, 700);
      else state.demoFinishing = false;
    };
    setTimeout(step, left.length ? 600 : 0);
  }

  function bindRankDrag(list) {
    $$('.slot.filled', list).forEach(function (row) {
      var handleRow = row;
      var pid = null; var sy = 0; var dy = 0; var h = 0;
      handleRow.addEventListener('pointerdown', function (e) {
        if (e.target.closest('button') || e.button > 0) return;
        pid = e.pointerId; sy = e.clientY; dy = 0; h = row.getBoundingClientRect().height + 8;
        try { row.setPointerCapture(pid); } catch (err) { /* ignore */ }
        row.classList.add('dragging'); state.dragging = true;
      });
      handleRow.addEventListener('pointermove', function (e) {
        if (e.pointerId !== pid) return;
        dy = e.clientY - sy;
        row.style.transform = 'translateY(' + dy + 'px)';
      });
      function end(e) {
        if (e.pointerId !== pid) return;
        pid = null; state.dragging = false;
        row.classList.remove('dragging'); row.style.transform = '';
        var from = Number(row.getAttribute('data-i'));
        var to = Math.max(0, Math.min(state.rankDraft.length - 1, from + Math.round(dy / h)));
        if (to !== from) { var x = state.rankDraft.splice(from, 1)[0]; state.rankDraft.splice(to, 0, x); }
        draw();
      }
      handleRow.addEventListener('pointerup', end);
      handleRow.addEventListener('pointercancel', end);
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) return closeSheet();
    if (state.view !== 'd' && state.view !== 'demo') return;
    if (!$('#sheet').hidden || e.altKey || e.ctrlKey || e.metaKey) return;
    var tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (!$('#topCard')) return;
    var v = { ArrowRight: 'yes', ArrowLeft: 'no', ArrowUp: 'love' }[e.key];
    if (v) { e.preventDefault(); swipe(v); return; }
    if (e.key === 'Backspace' || e.key === 'ArrowDown') { e.preventDefault(); back(); }
  });
  function back() {
    var V = state.d; var L = liveIds(V);
    var id = curCard(V);
    var i = id ? L.indexOf(id) : L.length;
    if (i > 0) { state.curId = L[i - 1]; state.vetoArm = null; draw(); var c = $('#topCard'); if (c) try { c.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }

  /* ---------------- online: load, poll ---------------- */

  function loadDecision() {
    return api('GET', 'api/d/' + DEC_ID).then(function (r) {
      state.d = r.d;
      remember(r.d.id, r.d.question);
      draw();
      if (location.hash === '#share' && r.d.host) { history.replaceState(null, '', location.pathname); openShare(); }
      startPolling();
    }).catch(function (err) {
      if (err && err.status === 404) forget(DEC_ID);
      state.d = { gone: '<section class="card center"><div style="font-size:3rem" aria-hidden="true">🤷</div><h1>Nothing here</h1><p class="muted">' + esc(err && err.status === 404 ? 'This decision doesn’t exist, was deleted, or went quiet for 14 days - or it was joined on a different phone. Ask whoever sent it for the link again.' : (err && err.message) || 'That didn’t load.') + '</p><div class="row"><button class="btn" type="button" data-act="joincode">Join with a code</button><button class="btn ghost" type="button" data-act="new">Start a decision</button></div></section>' };
      draw();
    });
  }
  function refresh() {
    if (!DEC_ID) { state.d = demoView(); draw(); return Promise.resolve(); }
    return api('GET', 'api/d/' + DEC_ID).then(function (r) { state.d = r.d; draw(); }).catch(function () { /* next poll */ });
  }
  function poll() {
    if (!DEC_ID || !state.d || state.d.gone || document.hidden || state.dragging || state.busySwipe || !$('#sheet').hidden) return;
    api('GET', 'api/d/' + DEC_ID + '?since=' + state.d.v).then(function (r) {
      if (r.same || !r.d) return;
      var wasOpen = state.d.status.open;
      state.d = r.d;
      if (wasOpen && !r.d.status.open) { state.rankEditing = false; state.curId = null; }
      if (!state.dragging && !state.busySwipe) draw();
    }).catch(function (err) { if (err && err.status === 404) { stopPolling(); loadDecision(); } });
  }
  function startPolling() { stopPolling(); state.timer = setInterval(poll, POLL_MS); }
  function stopPolling() { if (state.timer) clearInterval(state.timer); state.timer = null; }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  /* ---------------- sharing ---------------- */

  function openShare() {
    var V = state.d;
    var link = joinLink(V);
    var msg = C.inviteText(V, link);
    sheet('<h2>Send it to the group</h2>' +
      '<div class="sharegrid"><button class="qr" type="button" data-act="qrbig" aria-label="Show the QR code full screen">' + QR.svg(link, 'Join ' + V.question) + '</button><div><p class="small muted" style="margin:0">Code</p><p class="code">' + esc(V.display) + '</p><p class="small muted">Friends open the link, scan or type the code - no app, no account.</p></div></div>' +
      '<p class="small muted" style="margin:14px 0 6px">The message, ready to send:</p><p class="copybox">' + esc(msg) + '</p>' +
      '<button class="btn block big" type="button" data-act="sharemsg">Share to the group chat</button>' +
      '<div class="row" style="margin-top:8px"><button class="btn ghost" type="button" data-act="copymsg">Copy message</button><button class="btn ghost" type="button" data-act="copylink">Copy link</button></div>' +
      '<button class="btn ghost block" type="button" data-act="closesheet">' + (V.status.open && !meDone(V) ? 'Start swiping →' : 'Done') + '</button>');
  }
  function showQr() {
    var V = state.d;
    var o = document.createElement('div');
    o.className = 'qrfull';
    o.setAttribute('role', 'dialog'); o.setAttribute('aria-label', 'Join code');
    o.innerHTML = '<button class="btn ghost" type="button">Close</button><p style="font-weight:800;font-size:1.3rem;margin:0;max-width:90vw;overflow-wrap:anywhere">' + esc(V.question) + '</p><div class="qrbox">' + QR.svg(joinLink(V), 'Join ' + V.question) + '</div><p class="code">' + esc(V.display) + '</p><p style="margin:0;color:#333333">Scan to swipe - no app needed</p>';
    function close() { o.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    o.addEventListener('click', function (e) { if (e.target === o || e.target.tagName === 'BUTTON') close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(o);
  }

  /* ---------------- start a decision ---------------- */

  function newDraft(after) {
    return { question: '', mode: 'swipe', src: 'deck', deck: null, items: [], text: '', vetoes: false, vetoesTouched: false, named: true, live: false, time: '', max: '', name: myName(), after: after || null };
  }
  function onCount(d) { return d.items.filter(function (x) { return x.on; }).length; }
  function addItems(d, list, on) {
    var have = {};
    d.items.forEach(function (x) { have[C.fold(x.label)] = true; });
    var added = 0; var capped = 0;
    list.forEach(function (o) {
      var c = C.cleanOption(o);
      if (!c || have[C.fold(c.label)]) return;
      have[C.fold(c.label)] = true;
      var turnOn = on && onCount(d) < C.LIMITS.optionsMax;
      if (on && !turnOn) capped++;
      d.items.push({ label: c.label, emoji: c.emoji, note: c.note, on: turnOn });
      added++;
    });
    if (capped) toast(C.LIMITS.optionsMax + ' options is the most - ' + capped + ' left unticked.');
    return added;
  }
  function pickDeck(id) {
    var d = state.draft; var deck = C.DECK[id];
    if (!deck) return;
    var prevQ = d.deck && C.DECK[d.deck] ? C.DECK[d.deck].question : null;
    d.items = d.items.filter(function (x) { return x.own; });
    d.deck = id;
    var k = 0;
    deck.items.forEach(function (it) {
      if (d.items.some(function (x) { return C.fold(x.label) === C.fold(it.label); })) return;
      d.items.push({ label: it.label, emoji: it.emoji, note: '', on: k++ < C.LIMITS.deckTicked && onCount(d) < C.LIMITS.optionsMax });
    });
    if (!d.question || d.question === prevQ) d.question = deck.question;
    if (!d.vetoesTouched) d.vetoes = deck.vetoes;
  }
  function deadlineMs(hhmm) {
    var m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return null;
    var t = new Date(); t.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (t.getTime() < Date.now() + 2 * 60000) t.setDate(t.getDate() + 1);
    return t.getTime();
  }

  function drawNew() {
    var d = state.draft || (state.draft = newDraft());
    var n = onCount(d);
    var decks = '<div class="decks">' + C.DECKS.map(function (k) {
      return '<button class="deck" type="button" data-act="deck" data-id="' + k.id + '" aria-pressed="' + (d.deck === k.id) + '"><span class="de" aria-hidden="true">' + k.emoji + '</span><span><b>' + esc(k.name) + '</b><span class="n">' + k.items.length + ' ideas</span></span></button>';
    }).join('') + '</div>';
    var typed = '<label class="field" style="margin-top:4px"><span>One per line <span class="hint">- “🍜 Ramen” works too</span></span><textarea class="input" id="typed" placeholder="Pizza&#10;Thai&#10;That new ramen place">' + esc(d.text) + '</textarea></label><button class="btn ghost small" type="button" data-act="addtyped">Add to the list</button>';
    var chips = d.items.length ? '<div class="chips" role="group" aria-label="Options">' + d.items.map(function (x, i) {
      return '<button class="chip" type="button" data-act="chip" data-i="' + i + '" id="chip' + i + '" aria-pressed="' + x.on + '"><span class="ce" aria-hidden="true">' + esc(x.emoji || '•') + '</span><span class="cl">' + esc(x.label) + '</span></button>';
    }).join('') + '</div>' : '';
    var secs = Math.max(5, Math.round(n * 1.4));
    var count = d.items.length ? '<div class="count-line"><span class="small muted"><b>' + n + '</b> of ' + d.items.length + ' ticked · about ' + secs + ' seconds to swipe' + (n > 20 ? ' - fewer is faster' : '') + '</span><span><button class="link-btn small" type="button" data-act="tickall">' + (n === Math.min(d.items.length, C.LIMITS.optionsMax) ? 'Untick all' : 'Tick all') + '</button></span></div>' : '';
    var fill = '<button class="btn ghost block" type="button" data-act="fill">✨ Fill the deck for me <span class="ai">AI</span></button>';
    var first = d.items.filter(function (x) { return x.on; })[0];
    var preview = '<aside class="card preview" aria-label="Preview"><p class="eyebrow">What your friends get</p>' +
      '<p class="copybox">' + esc(C.inviteText({ question: C.cleanQuestion(d.question) || 'Where are we eating?', mode: d.mode }, location.origin + BASE + 'j/ABCDEF')) + '</p>' +
      '<div class="deckwrap" style="height:280px;min-height:0;pointer-events:none"><div class="sw-card next" aria-hidden="true"></div><div class="sw-card" aria-hidden="true" style="cursor:default"><span class="cnum">1 / ' + Math.max(n, 1) + '</span><span class="ce">' + (first ? optionEmoji(first) : '🗳️') + '</span><h2>' + esc(first ? first.label : 'Your options') + '</h2></div></div>' +
      '<p class="small muted center">' + (d.mode === 'rank' ? 'Everyone ranks a top 3; ranked choice settles it.' : 'Everyone swipes. The first thing all of you say yes to wins.') + '</p></aside>';
    main.innerHTML = '<div class="dk-split"><section class="card"><h1>' + (d.after ? 'Settle another' : 'Start a decision') + '</h1>' +
      (d.after ? '<p class="small muted">Everyone still on the last reveal gets a “Next up” button.</p>' : '') +
      '<form id="newForm" novalidate>' +
      '<label class="field"><span>What are you deciding?</span><input class="input" id="q" maxlength="' + C.LIMITS.question + '" placeholder="Where are we eating?" value="' + esc(d.question) + '" autocomplete="off"></label>' +
      '<div class="field"><span>Choose between</span><div class="seg" role="radiogroup" aria-label="Where the options come from">' +
      '<button type="button" class="segb" role="radio" data-act="src" data-v="deck" aria-checked="' + (d.src === 'deck') + '">Use a deck</button>' +
      '<button type="button" class="segb" role="radio" data-act="src" data-v="type" aria-checked="' + (d.src === 'type') + '">Type my own</button></div>' +
      '<div style="margin-top:10px">' + (d.src === 'deck' ? decks : typed) + '</div>' + (d.items.length ? '<p class="small muted" style="margin:12px 0 0">Tap to add or drop. About a dozen keeps it quick.</p>' : '') + chips + count + fill + '</div>' +
      '<div class="field"><span>How to decide</span><div class="seg" role="radiogroup" aria-label="How to decide">' +
      '<button type="button" class="segb" role="radio" data-act="mode" data-v="swipe" aria-checked="' + (d.mode === 'swipe') + '">Swipe<span class="sub">Yes · No · Love</span></button>' +
      '<button type="button" class="segb" role="radio" data-act="mode" data-v="rank" aria-checked="' + (d.mode === 'rank') + '">Rank a top 3<span class="sub">Ranked choice</span></button></div></div>' +
      '<label class="field"><span>Your name <span class="hint">- so friends know who asked</span></span><input class="input" id="nm" maxlength="' + C.LIMITS.name + '" autocomplete="given-name" value="' + esc(d.name) + '" placeholder="Alex"></label>' +
      '<details class="fold"' + (d.time || d.max ? ' open' : '') + '><summary>More options</summary>' +
      '<div class="two"><label class="field"><span>Decide by <span class="hint">(optional)</span></span><input class="input" id="dtime" type="time" value="' + esc(d.time) + '"></label>' +
      '<label class="field"><span>How many of you? <span class="hint">(optional)</span></span><input class="input" id="dmax" type="number" inputmode="numeric" min="2" max="' + C.LIMITS.voters + '" value="' + esc(d.max) + '" placeholder="4"></label></div>' +
      '<p class="small muted" style="margin-top:-4px">It reveals itself at that time, or when that many have voted. Otherwise you tap Reveal.</p>' +
      sw('vetoes', d.vetoes, 'Vetoes', 'Everyone gets one veto to knock an option out for all') +
      sw('named', d.named, 'Show who voted what', 'At the reveal. Off: only the totals, nobody’s name') +
      sw('live', d.live, 'Show the tally as people vote', 'Off: it stays hidden until the reveal') +
      '</details><div id="newErr"></div>' +
      '<button class="btn block big" type="submit" id="createBtn">' + (n >= 2 ? 'Start - get the link' : 'Pick at least two options') + '</button></form></section>' + preview + '</div>';
    bindNew();
  }
  function sw(id, on, title, sub) {
    return '<label class="switch"><input type="checkbox" id="sw-' + id + '" data-sw="' + id + '"' + (on ? ' checked' : '') + '><span class="st"><b>' + title + '</b><span>' + sub + '</span></span></label>';
  }
  function bindNew() {
    var d = state.draft;
    $('#q').addEventListener('input', function (e) { d.question = e.target.value; });
    $('#nm').addEventListener('input', function (e) { d.name = e.target.value; });
    var t = $('#typed'); if (t) t.addEventListener('input', function (e) { d.text = e.target.value; });
    $('#dtime').addEventListener('input', function (e) { d.time = e.target.value; });
    $('#dmax').addEventListener('input', function (e) { d.max = e.target.value; });
    $$('[data-sw]').forEach(function (c) { c.addEventListener('change', function () { var k = c.getAttribute('data-sw'); d[k] = c.checked; if (k === 'vetoes') d.vetoesTouched = true; }); });
    $('#newForm').addEventListener('submit', function (e) { e.preventDefault(); create(); });
  }
  function create() {
    var d = state.draft;
    var err = $('#newErr');
    var q = C.cleanQuestion(d.question) || (d.deck ? C.DECK[d.deck].question : '');
    if (!q) { err.innerHTML = '<p class="err" role="alert">Ask the group something - “Where are we eating?”</p>'; $('#q').focus(); return; }
    if (d.src === 'type' && d.text.trim()) { addItems(d, C.parseLines(d.text).options, true); d.text = ''; }
    var options = d.items.filter(function (x) { return x.on; }).map(function (x) { return { label: x.label, emoji: x.emoji, note: x.note }; });
    if (options.length < 2) { drawNew(); $('#newErr').innerHTML = '<p class="err" role="alert">Pick at least two options - tap a deck, or type some.</p>'; return; }
    var btn = $('#createBtn'); btn.disabled = true; btn.textContent = 'Starting…';
    var name = C.cleanName(d.name);
    if (name) keep(K_NAME, name);
    api('POST', 'api/decisions', { question: q, mode: d.mode, options: options, vetoes: d.vetoes, named: d.named, live: d.live, deadline: deadlineMs(d.time), max: d.max ? Number(d.max) : null, name: name, after: d.after })
      .then(function (r) { remember(r.id, q); state.draft = null; location.href = BASE + 'd/' + r.id + '#share'; })
      .catch(function (e2) { btn.disabled = false; btn.textContent = 'Start - get the link'; showError(e2, $('#newErr')); });
  }

  /* ---------------- fill the deck for me (the one model call) ---------------- */

  function openFill() {
    var a = state.ai || (state.ai = { prompt: '', list: null });
    var signed = signedIn();
    sheet('<h2>✨ Fill the deck for me</h2><p class="muted">Say what you’re choosing and AI suggests 8 to 20 options to swipe on. It suggests <b>ideas</b> - not real places, prices or showtimes; it can’t see what’s open near you.</p>' +
      '<form id="aiForm"><label class="field"><span>What are you choosing?</span><input class="input" id="aiPrompt" maxlength="' + C.LIMITS.prompt + '" placeholder="cheap date ideas in winter" value="' + esc(a.prompt) + '" autocomplete="off"></label>' +
      '<div class="chips" aria-label="Examples">' + EXAMPLES.map(function (x) { return '<button class="chip" type="button" data-act="aiex" data-v="' + esc(x) + '">' + esc(x) + '</button>'; }).join('') + '</div>' +
      '<div id="aiOut" style="margin-top:12px"></div>' +
      (signed ? '<button class="btn block big" type="submit" id="aiGo">Suggest ideas <span class="ai">AI</span> <span class="small">about a cent</span></button>'
        : '<div class="note"><p><b>This one uses AI, so it needs a free account.</b> A free account comes with $2 of AI credit, and a deck of ideas costs about a cent. The built-in decks and typing your own stay free, no account.</p><div class="row"><button class="btn" type="button" data-act="signin-ai">Create a free account</button><button class="btn ghost" type="button" data-act="signin-ai-login">Sign in</button></div></div>') +
      '</form>', function (root) {
      $('#aiPrompt', root).addEventListener('input', function (e) { a.prompt = e.target.value; });
      $('#aiForm', root).addEventListener('submit', function (e) { e.preventDefault(); if (signedIn()) runFill(root); });
      if (a.list) drawAiList(root);
    });
  }
  function runFill(root) {
    var a = state.ai; var out = $('#aiOut', root); var btn = $('#aiGo', root);
    if (!/\p{L}{2}/u.test(a.prompt || '')) { out.innerHTML = '<p class="err" role="alert">Say what you’re choosing first.</p>'; return; }
    btn.disabled = true; btn.textContent = 'Thinking…';
    out.innerHTML = '<p class="busy" style="padding:8px 0">Dealing some ideas…</p>';
    var have = (state.draft ? state.draft.items : []).map(function (x) { return x.label; });
    api('POST', 'api/suggest', { prompt: a.prompt, have: have }).then(function (r) {
      a.list = r.options.map(function (o) { return { label: o.label, emoji: o.emoji, note: o.note, on: true }; });
      drawAiList(root);
    }).catch(function (err) {
      if (err.status === 401) { out.innerHTML = ''; return openAccount('“Fill the deck for me” uses AI, so it needs a free account - it comes with $2 of credit. Everything else in Settle is free.', openFill); }
      if (err.status === 402) { out.innerHTML = ''; return openCredit(err.data); }
      if (err.data && err.data.code === 'verify-email') return verifyNote(out, err);
      showError(err, out);
    }).then(function () { if (btn) { btn.disabled = false; btn.innerHTML = 'Suggest ideas <span class="ai">AI</span> <span class="small">about a cent</span>'; } });
  }
  function drawAiList(root) {
    var a = state.ai; var out = $('#aiOut', root);
    var n = a.list.filter(function (x) { return x.on; }).length;
    var ex = $('.chips[aria-label="Examples"]', root); if (ex) ex.hidden = true;
    out.innerHTML = '<p class="small muted" style="margin:0">Ideas, not venues - check what’s actually open. Untick any you don’t want.</p><div class="chips">' + a.list.map(function (x, i) {
      return '<button class="chip" type="button" data-act="aichip" data-i="' + i + '" aria-pressed="' + x.on + '" title="' + esc(x.note) + '"><span class="ce" aria-hidden="true">' + esc(x.emoji || '•') + '</span><span class="cl">' + esc(x.label) + '</span></button>';
    }).join('') + '</div><button class="btn block" type="button" data-act="aiadd"' + (n ? '' : ' disabled') + '>Add ' + plural(n, 'idea') + ' to my list</button>';
  }

  /* ---------------- join ---------------- */

  function loadJoin() {
    return api('GET', 'api/join/' + JOIN_CODE).then(function (j) {
      if (j.already) { location.replace(BASE + 'd/' + j.already); return; }
      state.join = j; draw();
    }).catch(function (err) { state.join = { error: err.message, status: err.status }; draw(); });
  }
  function drawJoin() {
    var j = state.join;
    if (!j) { main.innerHTML = '<p class="busy">Looking that up…</p>'; return; }
    if (j.error) {
      main.innerHTML = '<div class="narrow"><section class="card center"><div style="font-size:3rem" aria-hidden="true">🔑</div><h1>That code didn’t work</h1><p class="muted">' + esc(j.error) + '</p><div class="row"><button class="btn" type="button" data-act="joincode">Try another code</button><a class="btn ghost" href="' + esc(BASE) + '#start">What is Settle?</a></div></section></div>';
      return;
    }
    var bits = [j.mode === 'rank' ? 'Rank your top 3' : 'Swipe', plural(j.options, 'option'), plural(j.joined, 'person', 'people') + ' in'];
    if (j.deadline) bits.push(dueLabel(j.deadline));
    var closed = !j.open; var full = j.full;
    var html = '<div class="narrow"><section class="card"><p class="eyebrow">You’re invited to settle something</p><h1>' + esc(j.question) + '</h1><p class="muted">' + esc(bits.join(' · ')) + '</p>' +
      '<div class="chips" aria-label="Some of the options">' + j.preview.map(function (o) { return '<span class="chip" style="cursor:default"><span class="ce" aria-hidden="true">' + esc(o.emoji || '•') + '</span><span class="cl">' + esc(o.label) + '</span></span>'; }).join('') + (j.options > j.preview.length ? '<span class="chip" style="cursor:default">+' + (j.options - j.preview.length) + ' more</span>' : '') + '</div>';
    if (closed) html += '<p class="err" style="margin-top:14px">Voting on this one has closed.</p><p class="small muted">If you were in it, open it from the phone you joined on.</p><button class="btn ghost block" type="button" data-act="new">Start your own</button>';
    else if (full) html += '<p class="err" style="margin-top:14px">Everyone this was for has joined.</p><p class="small muted">Ask whoever sent it to start another for you.</p>';
    else {
      html += '<form id="joinForm" style="margin-top:12px"><label class="field"><span>Your name</span><input class="input" name="name" maxlength="' + C.LIMITS.name + '" autocomplete="given-name" placeholder="First name or nickname" value="' + esc(myName()) + '"></label>' +
        '<p class="small muted">' + (j.named ? 'Your name shows beside your votes at the reveal.' : 'Votes are anonymous - only how many voted is shown.') + ' No account, nothing to install.</p>' +
        '<div id="joinErr"></div><button class="btn block big" type="submit">' + (j.mode === 'rank' ? 'Join and rank →' : 'Join and swipe →') + '</button></form>';
    }
    html += '</section><p class="small muted center">Settle: everyone swipes, nobody argues. <a href="' + esc(BASE) + '#start">What’s this?</a></p></div>';
    main.innerHTML = html;
    var f = $('#joinForm');
    if (f) f.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = C.cleanName(f.name.value);
      var b = $('button[type=submit]', f); b.disabled = true;
      if (name) keep(K_NAME, name);
      api('POST', 'api/join/' + JOIN_CODE, { name: name }).then(function (r) { remember(r.id, j.question); location.href = BASE + 'd/' + r.id; })
        .catch(function (err) { b.disabled = false; showError(err, $('#joinErr')); });
    });
  }

  /* ---------------- sheets and the account ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back2 = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.hidden = false; back2.hidden = false;
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
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  var FREE_LINE = 'Nothing in Settle needs an account except “Fill the deck for me”, which uses AI - a free account comes with $2 of AI credit. One account works across every app on this site.';
  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }
  function openAccount(reason, then, login) {
    var mode = login ? 'login' : 'register';
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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); if (then) then(); })
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
      '<div class="note"><div class="row" style="justify-content:space-between"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">“Fill the deck for me” costs about a cent. Decisions, decks, votes and the reveal are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The decks, typing your own, voting and the reveal keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- the wheel ---------------- */

  function spinWheel(skip) {
    var V = state.d; var R = V.result;
    if (!R || !R.wheel) return;
    var g = $('#spinner'); var btn = $('#spinBtn');
    var n = R.wheel.ids.length; var p = R.wheel.ids.indexOf(R.wheel.pick); var seg = 360 / n;
    var done = function () { markSpun(V); draw(); };
    if (skip || REDUCED || !g) return done();
    if (btn) btn.disabled = true;
    // The pointer is at the top: turn the wheel so the chosen slice's middle
    // ends under it, after six full turns.
    var turn = 360 * 6 - (p + 0.5) * seg;
    g.classList.add('go');
    g.style.transform = 'rotate(' + turn + 'deg)';
    if (navigator.vibrate) try { navigator.vibrate([10, 60, 10]); } catch (e) { /* ignore */ }
    var fired = false;
    var fin = function () { if (fired) return; fired = true; setTimeout(done, 350); };
    g.addEventListener('transitionend', fin);
    setTimeout(fin, 4600);
  }

  /* ---------------- one click listener ---------------- */

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var a = t.getAttribute('data-act');
    var V = state.d;
    var d = state.draft;
    switch (a) {
      case 'closesheet': closeSheet(); break;
      case 'demo': go('demo'); break;
      case 'demoagain': startDemo(); scrollTo(0, 0); break;
      case 'new': closeSheet(true); state.draft = newDraft(); if (DEC_ID || JOIN_CODE) { location.href = BASE + '#new'; } else go('new'); break;
      case 'joincode': openJoinCode(); break;
      case 'signin-ai': openAccount('“Fill the deck for me” uses AI, so it needs a free account - it comes with $2 of credit and a deck of ideas costs about a cent.', openFill); break;
      case 'signin-ai-login': openAccount('', openFill, true); break;
      // the swipe deck
      case 'sw': swipe(t.getAttribute('data-v')); break;
      case 'back': back(); break;
      case 'donereview': state.curId = null; draw(); break;
      case 'review': state.curId = V.mode === 'swipe' ? liveIds(V)[0] : null; state.rankEditing = true; state.rankDraft = null; draw(); scrollTo(0, 0); break;
      case 'veto': {
        var oid = t.getAttribute('data-oid');
        if (state.vetoArm !== oid) { state.vetoArm = oid; draw(); setTimeout(function () { if (state.vetoArm === oid) { state.vetoArm = null; if (!state.dragging) draw(); } }, 4000); break; }
        state.vetoArm = null;
        act('veto', { oid: oid }).then(function (r) { if (state.curId === oid) state.curId = null; draw(); toast(r.msg); say(r.msg); }).catch(function (err) { showError(err); refresh(); });
        break;
      }
      case 'unveto': act('veto', { oid: null }).then(function (r) { draw(); toast(r.msg); }).catch(function (err) { showError(err); }); break;
      // rank
      case 'rk-add': {
        var id = t.getAttribute('data-oid'); var dr = state.rankDraft || [];
        var k = dr.indexOf(id);
        if (k >= 0) dr.splice(k, 1);
        else if (dr.length < C.LIMITS.rankTop) dr.push(id);
        else { toast('That’s three - take one out first.'); break; }
        state.rankDraft = dr; draw(); break;
      }
      case 'rk-up': case 'rk-down': {
        var i = Number(t.getAttribute('data-i')); var j = a === 'rk-up' ? i - 1 : i + 1; var r2 = state.rankDraft;
        if (j < 0 || j >= r2.length) break;
        var x = r2[i]; r2[i] = r2[j]; r2[j] = x; draw();
        var nb = $('[data-act="' + a + '"][data-i="' + j + '"]'); if (nb && !nb.disabled) nb.focus(); break;
      }
      case 'rk-rm': state.rankDraft.splice(Number(t.getAttribute('data-i')), 1); draw(); break;
      case 'rk-save':
        t.disabled = true;
        act('rank', { order: state.rankDraft }).then(function () {
          state.rankEditing = false;
          if (isDemo() && meDone(state.d)) finishDemo();
          draw(); toast('Locked in ✓'); scrollTo(0, 0);
        }).catch(function (err) { t.disabled = false; showError(err); refresh(); });
        break;
      // host
      case 'close':
        t.disabled = true;
        act('close', {}).then(function () { draw(); scrollTo(0, 0); }).catch(function (err) { t.disabled = false; showError(err); });
        break;
      case 'reopen':
        if (!confirm('Start round 2 with the top 3? Everyone votes again on just those.')) break;
        act('reopen', {}).then(function (r) { state.curId = null; state.rankDraft = null; state.rankEditing = false; draw(); toast(r.msg); scrollTo(0, 0); }).catch(function (err) { showError(err); });
        break;
      case 'another': location.href = BASE + '?after=' + encodeURIComponent(V.id) + '#new'; break;
      case 'gonext': {
        var nx = V.next; var nm = myName() || ((V.people.filter(function (p) { return p.you; })[0] || {}).name) || '';
        t.disabled = true;
        api('POST', 'api/join/' + nx.code, { name: nm }).then(function (r) { remember(r.id, nx.question); location.href = BASE + 'd/' + r.id; })
          .catch(function (err) { t.disabled = false; if (err.status === 404) location.href = BASE + 'j/' + nx.code; else showError(err); });
        break;
      }
      // sharing
      case 'share': openShare(); break;
      case 'qrbig': showQr(); break;
      case 'sharemsg': {
        var link = joinLink(V); var msg = C.inviteText(V, link);
        if (navigator.share) navigator.share({ title: V.question, text: msg.replace(link, '').trim(), url: link }).catch(function () { /* closed */ });
        else copy(msg, 'Copied - paste it in the group chat');
        break;
      }
      case 'copymsg': copy(C.inviteText(V, joinLink(V)), 'Message copied'); break;
      case 'copylink': copy(joinLink(V), 'Link copied'); break;
      case 'shareresult': share('Settled', C.resultLine(V, V.result)); break;
      case 'copyresult': copy(C.resultLine(V, V.result), 'Result copied'); break;
      case 'spin': spinWheel(false); break;
      case 'skipspin': spinWheel(true); break;
      // the form
      case 'src': d.src = t.getAttribute('data-v'); drawNew(); break;
      case 'deck': pickDeck(t.getAttribute('data-id')); drawNew(); var dk = $('.chips'); if (dk) dk.scrollIntoView({ block: 'nearest', behavior: REDUCED ? 'auto' : 'smooth' }); break;
      case 'addtyped': {
        var parsed = C.parseLines(d.text).options;
        if (!parsed.length) { toast('Type an option on each line first.'); break; }
        var added = addItems(d, parsed, true);
        d.items.forEach(function (it) { if (parsed.some(function (p) { return C.fold(p.label) === C.fold(it.label); })) it.own = true; });
        d.text = ''; drawNew(); toast(added ? plural(added, 'option') + ' added' : 'Those are already on the list');
        break;
      }
      case 'chip': {
        var it2 = d.items[Number(t.getAttribute('data-i'))];
        if (!it2.on && onCount(d) >= C.LIMITS.optionsMax) { toast(C.LIMITS.optionsMax + ' options is the most.'); break; }
        it2.on = !it2.on; drawNew(); var c = $('#' + t.id); if (c) c.focus({ preventScroll: true }); break;
      }
      case 'tickall': {
        var all = onCount(d) === Math.min(d.items.length, C.LIMITS.optionsMax);
        var cnt = 0; d.items.forEach(function (x) { x.on = !all && cnt++ < C.LIMITS.optionsMax; }); drawNew(); break;
      }
      case 'mode': d.mode = t.getAttribute('data-v'); drawNew(); break;
      case 'fill': openFill(); break;
      case 'aiex': { var inp = $('#aiPrompt'); inp.value = t.getAttribute('data-v'); state.ai.prompt = inp.value; break; }
      case 'aichip': { var ai2 = state.ai.list[Number(t.getAttribute('data-i'))]; ai2.on = !ai2.on; drawAiList($('#sheet')); break; }
      case 'aiadd': {
        var picked = state.ai.list.filter(function (x) { return x.on; });
        var n2 = addItems(d, picked, true);
        d.items.forEach(function (it) { if (picked.some(function (p) { return C.fold(p.label) === C.fold(it.label); })) it.own = true; });
        state.ai = { prompt: state.ai.prompt, list: null };
        closeSheet(true); drawNew(); toast(plural(n2, 'idea') + ' added');
        break;
      }
      default: break;
    }
  });

  /* ---------------- start ---------------- */

  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });
  drawTop();
  route();
  loadMe().then(function () {
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
  });
})();
