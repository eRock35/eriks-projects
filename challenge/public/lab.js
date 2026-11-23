/* The lab's landing page. No model calls, no account needed.
   Nothing here writes a style attribute into markup: an app's two
   colours and every bar width travel as data-* and are applied by paint(). */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(method, path, body) {
    return fetch(path, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Something went wrong.'); return d; }); });
  }
  function toast(msg) {
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    ($('#toasts') || document.body).appendChild(t); setTimeout(function () { t.remove(); }, 2600);
  }
  var reducedMotion = function () { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); };
  function burst(el, chars) {
    if (reducedMotion()) return;
    var r = el.getBoundingClientRect();
    for (var i = 0; i < 14; i++) {
      var s = document.createElement('span');
      s.className = 'burst'; s.textContent = chars[i % chars.length]; s.setAttribute('aria-hidden', 'true');
      s.style.left = (r.left + r.width / 2) + 'px'; s.style.top = (r.top + r.height / 2) + 'px';
      var a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 90;
      s.style.setProperty('--dx', Math.cos(a) * d + 'px'); s.style.setProperty('--dy', Math.sin(a) * d - 40 + 'px');
      s.style.setProperty('--r', (Math.random() * 360 - 180) + 'deg');
      document.body.appendChild(s); setTimeout(function (x) { x.remove(); }.bind(null, s), 1100);
    }
  }

  // Colours and widths, from data-* to custom properties. Only a hex colour
  // or a 0-100 number ever gets through.
  var HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  function paint(root) {
    var all = function (sel) { return (root.matches && root.matches(sel) ? [root] : []).concat($$(sel, root)); };
    all('[data-c1]').forEach(function (el) {
      var c1 = el.getAttribute('data-c1'), c2 = el.getAttribute('data-c2');
      if (HEX.test(c1) && HEX.test(c2)) { el.style.setProperty('--c1', c1); el.style.setProperty('--c2', c2); }
    });
    all('[data-w]').forEach(function (el) {
      var w = Number(el.getAttribute('data-w'));
      el.style.setProperty('--w', (isFinite(w) ? Math.min(100, Math.max(0, w)) : 0) + '%');
    });
  }

  // Drops land at 09:00 UTC every day (the daily routine's schedule).
  function nextDrop(now) {
    var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9));
    for (var i = 0; i < 40; i++) {
      if (d > now) return d;
      d = new Date(d.getTime() + 864e5);
    }
    return d;
  }
  function fmtDate(iso) {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  var data = null, drewBuilt = false;

  // ---- build stats: human numbers ----
  function num(v) { v = Number(v); return isFinite(v) && v >= 0 ? v : 0; }
  // 393122130 -> "393M", 2353623 -> "2.4M", 196855 -> "197K"
  function tokens(v) {
    v = num(v);
    if (v >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (v >= 1e3) return Math.round(v / 1e3) + 'K';
    return String(Math.round(v));
  }
  function tokenWords(v) {
    v = num(v);
    if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + ' billion';
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + ' million';
    if (v >= 1e3) return Math.round(v / 1e3) + ' thousand';
    return String(Math.round(v));
  }
  // 2862069 -> "48 min", 29104934 -> "8 h 5 m"
  function span(ms) {
    var m = Math.round(num(ms) / 6e4);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' m';
  }
  function spanWords(ms) {
    var m = Math.round(num(ms) / 6e4), h = Math.floor(m / 60);
    return (h ? h + ' hour' + (h === 1 ? '' : 's') + ' ' : '') + (m % 60) + ' minute' + (m % 60 === 1 ? '' : 's');
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  function madeLine(b) {
    if (!b) return '';
    var agents = Math.round(num(b.agents));
    // Each part holds together (no-break spaces), so a narrow card wraps
    // between parts, never inside "45 min".
    var text = [tokens(b.in) + ' in', tokens(b.out) + ' out', plural(agents, 'agent'), span(b.agentMs)]
      .map(function (x) { return esc(x).replace(/ /g, '&nbsp;'); }).join(' · ');
    var tip = (b.exact ? '' : 'Estimate. ') + (b.note || '') + (agents > 1 && b.wallMs ? ' ' + span(b.wallMs) + ' start to finish.' : '');
    // The chip links to the "How it's built" strip, which says what in and
    // out mean; a tooltip alone would never reach a phone.
    return '<p class="made" title="' + esc(tip.trim()) + '"><a class="est" href="#built">Build' + (b.exact ? '' : ' est.') + '</a>' +
      '<span class="sr">' + (b.exact ? '' : 'estimated: ') + '</span><span class="made-n">' + text + '</span></p>';
  }

  // Count up from zero once, when the strip is on screen; never with
  // reduced motion, where the final numbers are simply there.
  function countUp(els) {
    if (reducedMotion() || !window.requestAnimationFrame) return;
    els.forEach(function (el) { el.textContent = el.getAttribute('data-fmt') === 'span' ? span(0) : tokens(0); });
    function run() {
      var t0 = null, D = 1100;
      function frame(t) {
        if (t0 === null) t0 = t;
        var k = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - k, 3);
        els.forEach(function (el) {
          var to = Number(el.getAttribute('data-to')), f = el.getAttribute('data-fmt');
          el.textContent = k >= 1 ? el.getAttribute('data-final') : f === 'span' ? span(to * e) : f === 'int' ? String(Math.round(to * e)) : tokens(to * e);
        });
        if (k < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }
    var host = $('#built');
    if (!('IntersectionObserver' in window)) return run();
    var io = new IntersectionObserver(function (es) {
      if (es.some(function (e) { return e.isIntersecting; })) { io.disconnect(); run(); }
    }, { threshold: 0.35 });
    io.observe(host);
  }

  // "Spar and Snapquote are estimates (marked est.):", or "2 apps are ..."
  // when the names are not known.
  function estNames(n) {
    var names = (data && data.apps || []).filter(function (a) { return a.build && !a.build.exact; }).map(function (a) { return esc(a.name); });
    var est = ' (marked <span class="est-inline">est.</span>),';
    if (names.length !== n || n > 3) return (n === 1 ? 'One app is an estimate' : n + ' apps are estimates') + est;
    return (n === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[n - 1]) + (n === 1 ? ' is an estimate' : ' are estimates') + est;
  }

  function drawBuilt(t) {
    if (!t || !(num(t.in) > 0)) return;
    var tiles = [
      { to: num(t.in), fmt: 'tok', label: 'tokens in', words: tokenWords(t.in) + ' tokens in' },
      { to: num(t.out), fmt: 'tok', label: 'tokens out', words: tokenWords(t.out) + ' tokens out' },
      { to: Math.round(num(t.agents)), fmt: 'int', label: 'agents run', words: Math.round(num(t.agents)) + ' agents run' },
      { to: num(t.agentMs), fmt: 'span', label: 'of agent time', words: spanWords(t.agentMs) + ' of agent time' },
    ];
    $('#builtGrid').innerHTML = tiles.map(function (x) {
      var fin = x.fmt === 'span' ? span(x.to) : x.fmt === 'int' ? String(x.to) : tokens(x.to);
      return '<div class="bt"><b aria-hidden="true" data-to="' + x.to + '" data-fmt="' + x.fmt + '" data-final="' + esc(fin) + '">' + esc(fin) + '</b>' +
        '<span aria-hidden="true">' + esc(x.label) + '</span><span class="sr">' + esc(x.words) + '</span></div>';
    }).join('');
    var apps = Math.round(num(t.apps)), est = Math.round(num(t.estimated));
    $('#builtLead').innerHTML = 'Every drop is built by Claude agents. <b>' + esc(plural(apps, 'app')) + ' shipped</b> so far.';
    var share = t.cachedShare == null ? null : Math.round(num(t.cachedShare) * 100);
    $('#builtNote').innerHTML = '<b>Why so much in?</b> “In” is everything the agents read, “out” everything they wrote. ' +
      (share ? 'About ' + share + '% of what they read is their own work, re-read at every step, which is the cheap part.' : 'Most of what they read is their own work, re-read at every step, which is the cheap part.') +
      (est ? ' ' + estNames(est) + ' built in a session whose transcripts are not kept here.' : '');
    $('#built').hidden = false;
    countUp($$('#builtGrid b'));
  }

  // ---- the crowd reveal ----
  // Before this browser votes on an app it sees how many voted, never which
  // way (the server does not even send the split). After, the split, with
  // at least 5 votes behind it.
  function sidedPct(a) { return a.split ? (a.myVote === 'keep' ? a.split.keepPct : 100 - a.split.keepPct) : null; }
  function bySlug(slug) { return data.apps.filter(function (x) { return x.slug === slug; })[0] || null; }
  function openApps() { return data.apps.filter(function (x) { return x.status !== 'retired'; }); }
  function votedCount() { return openApps().filter(function (x) { return x.myVote; }).length; }
  function nextUnvoted(after) {
    var list = openApps().filter(function (x) { return !x.myVote && x.live; });
    return list.filter(function (x) { return x.slug !== after; }).pop() || null; // newest first
  }
  function revealHtml(a, fresh) {
    var total = num(a.votes && a.votes.total), at = num(a.splitAt) || 5;
    if (!a.myVote) {
      return '<p class="locked"><span aria-hidden="true">🔒</span> Vote to see how the crowd split</p>';
    }
    var side = a.myVote === 'keep' ? 'Keep' : 'Kill', out = '';
    if (a.split) {
      var k = Math.min(100, Math.max(0, Math.round(num(a.split.keepPct)))), p = sidedPct(a);
      var tag = p < 35 ? ' <span class="tag contra">Contrarian</span>' : p >= 80 ? ' <span class="tag herd">With the crowd</span>' : '';
      out = '<div class="reveal ' + (a.myVote === 'keep' ? 'is-keep' : 'is-kill') + (fresh ? ' pre' : '') + '">' +
        '<p class="rv-line">You sided with <b class="rv-pct" data-to="' + p + '">' + (fresh && !reducedMotion() ? 0 : p) + '%</b> <span class="rv-side">(' + side + ')</span>' + tag + '</p>' +
        '<div class="split" role="img" aria-label="' + k + '% keep, ' + (100 - k) + '% kill, ' + total + ' votes"><i class="k" data-w="' + k + '"></i><i class="x" data-w="' + (100 - k) + '"></i></div>' +
        '<p class="split-legend" aria-hidden="true"><span>🔥 Keep ' + k + '%</span><span>' + (100 - k) + '% Kill 💀</span></p></div>';
    } else {
      out = '<div class="reveal thin"><p class="rv-line">You voted <b>' + side + '</b>. ' +
        (total <= 1 ? 'You’re the first' : 'Only ' + total + ' votes so far') + ' — the split shows at ' + at + '.</p></div>';
    }
    if (fresh) {
      var n = votedCount(), of = openApps().length, nx = nextUnvoted(a.slug);
      out += '<p class="prog-line">You’ve voted on <b>' + n + ' of ' + of + '</b> drops' +
        (nx ? ' · <a href="#app-' + esc(nx.slug) + '">Next: ' + esc(nx.name) + ' →</a>' : n === of ? ' · every one of them 🎉' : '') + '</p>';
    }
    return out;
  }
  // The split grows in and the percentage counts up, once, just after a vote.
  function animateReveal(host) {
    var rv = $('.reveal.pre', host);
    if (!rv) return;
    var pctEl = $('.rv-pct', rv), to = Number(pctEl && pctEl.getAttribute('data-to')) || 0;
    if (reducedMotion() || !window.requestAnimationFrame) { rv.classList.remove('pre'); if (pctEl) pctEl.textContent = to + '%'; return; }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        rv.classList.remove('pre');
        var t0 = null;
        (function frame(t) {
          if (t0 === null) t0 = t;
          var k = Math.min(1, (t - t0) / 900), e = 1 - Math.pow(1 - k, 3);
          if (pctEl) pctEl.textContent = Math.round(to * e) + '%';
          if (k < 1) requestAnimationFrame(frame);
        })(performance.now());
      });
    });
  }

  // ---- order ----
  // The drop number is the app's place in the registry, whatever the sort:
  // Tells is Drop #11 at the top of Newest and at the bottom of Oldest.
  // Retired apps sit at the end of every order.
  var SORTS = { 'new': 1, old: 1, votes: 1, todo: 1, az: 1 };
  var sortBy = 'new';
  try { var saved = localStorage.getItem('lab-sort'); if (SORTS[saved] === 1) sortBy = saved; } catch (e) { /* private window */ }
  function dropNo(a) { return data.apps.indexOf(a) + 1; }
  function dropLabel(n) { return 'Drop #' + String(n).padStart(2, '0'); }
  function newer(a, b) { return a.dropped < b.dropped ? 1 : a.dropped > b.dropped ? -1 : dropNo(b) - dropNo(a); }
  var ORDER = {
    'new': newer,
    old: function (a, b) { return -newer(a, b); },
    votes: function (a, b) { return num(b.votes && b.votes.total) - num(a.votes && a.votes.total) || newer(a, b); },
    todo: function (a, b) { return (a.myVote ? 1 : 0) - (b.myVote ? 1 : 0) || newer(a, b); },
    az: function (a, b) { return String(a.name).localeCompare(String(b.name)) || newer(a, b); },
  };
  function sorted() {
    var retired = function (a) { return a.status === 'retired' ? 1 : 0; };
    return data.apps.slice().sort(function (a, b) { return retired(a) - retired(b) || ORDER[sortBy](a, b); });
  }

  // ---- find and show ----
  // Only what the registry holds: the words on a card, and whether this
  // browser has voted on it. Neither is kept or sent anywhere. Until someone
  // searches, filters or asks for all of them, the grid shows the first
  // PAGE drops of the chosen order; "Classified" is always the last card.
  var PAGE = 11, SHOWS = { all: 1, todo: 1, done: 1 };
  var query = '', show = 'all', showAll = false;
  function matches(a) {
    if (show === 'todo' && a.myVote) return false;
    if (show === 'done' && !a.myVote) return false;
    if (!query) return true;
    var hay = [a.name, a.tagline, a.blurb, a.audience].concat(a.features || []).join(' ').toLowerCase();
    return query.toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) >= 0; });
  }
  function narrowed() { return !!query || show !== 'all'; }

  function wireBar() {
    var bar = $('#dropsBar');
    $$('[data-sort]', bar).forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-sort') === sortBy));
      b.onclick = function () {
        var next = b.getAttribute('data-sort');
        if (next === sortBy || SORTS[next] !== 1) return;
        sortBy = next;
        try { localStorage.setItem('lab-sort', sortBy); } catch (e) { /* not kept, still sorted */ }
        wireBar();
        draw();
      };
    });
    $$('[data-show]', bar).forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-show') === show));
      b.onclick = function () {
        var next = b.getAttribute('data-show');
        if (next === show || SHOWS[next] !== 1) return;
        show = next;
        wireBar();
        draw();
      };
    });
    var find = $('#find');
    find.oninput = function () { query = find.value.trim().slice(0, 80); draw(); };
    $('#dropsMore').onclick = function () {
      showAll = !showAll;
      draw();
      if (!showAll) $('#dropsTitle').scrollIntoView({ block: 'start' });
    };
    bar.hidden = false;
  }

  // ---- a drop, drawn twice: the card in the grid and "today's drop" ----
  function tile(a, cls) {
    return '<span class="tile' + (cls ? ' ' + cls : '') + '" data-c1="' + esc(a.color) + '" data-c2="' + esc(a.color2) + '" aria-hidden="true">' + esc(a.emoji) + '</span>';
  }
  function tryLink(a, cls) {
    var href = a.status === 'graduated' && a.home ? a.home : '/' + a.slug + '/';
    return a.live || a.status === 'graduated'
      ? '<a class="try ' + cls + '" href="' + esc(href) + '">Try ' + esc(a.name) + ' <span class="arr" aria-hidden="true">→</span></a>'
      : '<span class="try off ' + cls + '">Warming up…</span>';
  }
  function voteBlock(a, fresh) {
    var total = num(a.votes && a.votes.total);
    return '<div class="vote"><p class="q"><span>Keep it or kill it?</span><span class="vc">' + total + ' vote' + (total === 1 ? '' : 's') + '</span></p>' +
      '<div class="vbtns" role="group" aria-label="Vote on ' + esc(a.name) + '">' +
      '<button type="button" class="keep' + (a.myVote === 'keep' ? ' on' : '') + '" data-v="keep" aria-pressed="' + (a.myVote === 'keep') + '"><span aria-hidden="true">🔥</span> Keep</button>' +
      '<button type="button" class="kill' + (a.myVote === 'kill' ? ' on' : '') + '" data-v="kill" aria-pressed="' + (a.myVote === 'kill') + '"><span aria-hidden="true">💀</span> Kill</button></div>' +
      '<div class="rv" aria-live="polite">' + revealHtml(a, fresh) + '</div></div>';
  }
  function statusWord(a) { return a.status === 'graduated' ? ' · Graduated 🎓' : a.status === 'retired' ? ' · Retired' : ''; }

  function card(a, fresh) {
    return '<article class="app" id="app-' + esc(a.slug) + '" data-slug="' + esc(a.slug) + '" data-kind="card" tabindex="-1">' +
      '<div class="app-head">' + tile(a) + '<div class="app-id"><h3>' + esc(a.name) + '</h3>' +
      '<p class="meta"><span class="no">' + dropLabel(dropNo(a)) + '</span> · ' + esc(fmtDate(a.dropped)) + esc(statusWord(a)) + '</p></div></div>' +
      '<p class="tagline">' + esc(a.tagline) + '</p>' +
      tryLink(a, 'try-card') + voteBlock(a, fresh) +
      '<div class="app-foot"><details class="more"><summary>About <span class="sr">' + esc(a.name) + '</span></summary>' +
      '<p class="blurb">' + esc(a.blurb) + '</p>' +
      '<ul class="feats">' + (a.features || []).map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' +
      '<p class="who"><b>For</b> ' + esc(a.audience) + '</p>' + madeLine(a.build) + '</details>' +
      '<button type="button" class="note-btn"><span aria-hidden="true">💬</span> Tell Erik<span class="sr"> what you’d change about ' + esc(a.name) + '</span></button></div></article>';
  }

  // The newest drop that is not retired: the hero's "today's drop".
  function todayApp() { return openApps().slice().sort(newer)[0] || null; }
  function todayCard(a, fresh) {
    return '<div class="today-card" data-slug="' + esc(a.slug) + '" data-kind="today">' +
      '<p class="kicker lit"><span class="live-dot" aria-hidden="true"></span>Today’s drop · <span class="no">' + dropLabel(dropNo(a)).replace('Drop ', '') + '</span></p>' +
      '<div class="today-head">' + tile(a, 'lg') + '<div><h2 id="todayTitle">' + esc(a.name) + '</h2><p class="today-for">' + esc(fmtDate(a.dropped)) + ' · For ' + esc(String(a.audience).charAt(0).toLowerCase() + String(a.audience).slice(1)) + '</p></div></div>' +
      '<p class="tagline">' + esc(a.tagline) + '</p>' +
      tryLink(a, 'btn btn-lum') + voteBlock(a, fresh) +
      '<button type="button" class="note-btn"><span aria-hidden="true">💬</span> Tell Erik what you’d change</button></div>';
  }
  var RENDER = { card: card, today: todayCard };

  // ---- your lab: streak, progress, badges ----
  var BADGE_ICON = { first: '🗳️', streak3: '🔥', streak7: '☄️', fullweek: '📅', contrarian: '🦄' };
  function names(slugs) {
    var n = slugs.map(function (s) { var a = bySlug(s); return a ? a.name : null; }).filter(Boolean);
    return n.length <= 1 ? (n[0] || '') : n.slice(0, -1).join(', ') + ' or ' + n[n.length - 1];
  }
  function drawMe(newBadges) {
    var me = data.me;
    if (!me) return;
    var streak = Math.round(num(me.streak)), best = Math.round(num(me.best));
    var today = Array.isArray(me.today) ? me.today : [];
    // Several drops can share the newest date; any of them keeps the streak.
    // The link goes to the one in the hero when it is among them.
    var hero = todayApp(), inHero = !!hero && today.indexOf(hero.slug) >= 0;
    var todayName = inHero ? hero.name : names(today), first = today[0];
    var link = function (t) { return inHero ? '<a href="#today">' + t + '</a>' : first ? '<a href="#app-' + esc(first) + '">' + t + '</a>' : t; };
    var head, sub;
    if (streak > 0 && !me.pending) {
      head = streak + '-day streak';
      sub = 'You’re in on today’s drop. The next one lands in <b class="me-next">' + esc($('#sNext').textContent || 'a few hours') + '</b>.';
    } else if (streak > 0) {
      head = streak + '-day streak';
      sub = link('Vote on today’s drop' + (todayName ? ', ' + esc(todayName) + ',' : '') + ' to make it ' + (streak + 1) + ' →');
    } else if (best > 0) {
      head = 'Streak over';
      sub = 'Your best was ' + best + ' day' + (best === 1 ? '' : 's') + '. ' + link('Vote on ' + (todayName ? esc(todayName) : 'today’s drop') + ' to start again →');
    } else {
      head = 'No streak yet';
      sub = link('Vote on today’s drop' + (todayName ? ', ' + esc(todayName) + ',' : '') + ' to start one →');
    }
    var n = votedCount(), of = openApps().length, pct = of ? Math.round(n / of * 100) : 0;
    var badges = Array.isArray(me.badges) ? me.badges : [];
    var fresh = Array.isArray(newBadges) ? newBadges : [];
    $('#meStreak').innerHTML = '<span class="flame' + (streak > 0 ? ' lit' : '') + '" aria-hidden="true">🔥</span>' +
      '<div><b>' + esc(head) + '</b><p>' + sub + '</p></div>';
    $('#meProg').innerHTML = '<p class="mp-top"><b>' + n + ' of ' + of + '</b><span>drops voted</span></p>' +
      '<div class="mp-bar" role="img" aria-label="' + n + ' of ' + of + ' drops voted"><i data-w="' + pct + '"></i></div>';
    $('#meBadges').innerHTML = badges.map(function (b) {
      var id = String(b.id);
      return '<li class="bdg' + (b.earned ? ' got' : '') + (fresh.indexOf(id) >= 0 ? ' new' : '') + '"><button type="button" data-hint="' + esc(b.earned ? b.label + ': earned. ' + b.hint : b.label + ': locked. ' + b.hint) + '">' +
        '<span class="bi" aria-hidden="true">' + esc(BADGE_ICON[id] || '★') + '</span><span class="bl">' + esc(b.label) + '</span>' +
        '<span class="sr">' + (b.earned ? ', earned' : ', locked: ' + esc(b.hint)) + '</span></button></li>';
    }).join('');
    // The hint is said in its own line under the badges (a status region),
    // where a phone can read it for as long as it likes.
    $$('#meBadges button').forEach(function (btn) {
      btn.onclick = function () {
        $$('#meBadges button').forEach(function (x) { x.classList.toggle('sel', x === btn); });
        $('#meHint').textContent = btn.getAttribute('data-hint');
      };
    });
    $('#meHint').textContent = badges.length ? 'Tap a badge to see how it is earned.' : '';
    var got = badges.filter(function (b) { return b.earned; }).length;
    $('#meBadgeCount').textContent = got + ' of ' + badges.length;
    paint($('#me'));
    $('#me').hidden = false;
  }

  function nextCard() {
    return '<article class="app next dk" aria-labelledby="nextTitle"><div class="app-head"><span class="tile" aria-hidden="true">🧪</span>' +
      '<div class="app-id"><h3 id="nextTitle">???</h3><p class="meta"><span class="no">' + dropLabel(data.apps.length + 1) + '</span> · Classified</p></div></div>' +
      '<p class="tagline">The next experiment is being built right now.</p>' +
      '<p class="count-label">Something is cooking. It lands in</p><div class="count" id="count" role="timer" aria-live="off">–</div>' +
      '<p class="blurb">Every drop tries to fix a real headache, at home or at work, in a way that’s fun to use. Come back and vote.</p></article>';
  }

  function wire(host) {
    var slug = host.getAttribute('data-slug');
    $$('.vbtns button', host).forEach(function (b) {
      b.onclick = function () { vote(slug, b.getAttribute('data-v'), b, host); };
    });
    var nb = $('.note-btn', host);
    if (nb) nb.onclick = function () { note(slug, nb); };
    paint(host);
  }

  function totalVotes() { return data.apps.reduce(function (s, a) { return s + num(a.votes && a.votes.total); }, 0); }
  function drawStats() {
    $('#sApps').textContent = data.apps.length;
    var first = data.apps.reduce(function (m, a) { return a.dropped < m ? a.dropped : m; }, data.apps[0] ? data.apps[0].dropped : new Date().toISOString().slice(0, 10));
    $('#sDay').textContent = Math.max(1, Math.floor((Date.now() - new Date(first + 'T00:00:00Z')) / 864e5) + 1);
    // The small live numbers are off while <html data-counts="off"> (as on
    // the main site); the readout is then neither shown nor filled.
    if (document.documentElement.getAttribute('data-counts') !== 'off') $('#sVotes').textContent = totalVotes().toLocaleString();
  }

  function drawToday() {
    var a = todayApp(), el = $('#today');
    if (!a) { el.innerHTML = '<p class="today-wait">No drop yet. The first one is on its way.</p>'; return; }
    el.innerHTML = todayCard(a, false);
    wire(el.firstChild);
  }

  var drewBar = false;
  function draw() {
    var el = $('#drops');
    var list = sorted().filter(matches);
    var capped = !showAll && !narrowed() && list.length > PAGE;
    var shown = capped ? list.slice(0, PAGE) : list;
    el.innerHTML = shown.map(function (a) { return card(a, false); }).join('') +
      (list.length ? '' : '<p class="none">No drop matches that. <button type="button" class="link-btn" id="clearFind">Show every drop</button></p>') +
      nextCard();
    if (!drewBar) { drewBar = true; wireBar(); }
    if (!drewBuilt) { drewBuilt = true; drawBuilt(data.buildTotals); }
    $$('.app[data-slug]', el).forEach(wire);
    var clear = $('#clearFind');
    if (clear) clear.onclick = function () { resetFind(); draw(); $('#find').focus(); };
    var all = data.apps.length;
    $('#dropsCount').textContent = narrowed()
      ? list.length + ' of ' + all + ' drops' + (query ? ' match “' + query + '”' : show === 'todo' ? ' still to vote on' : ' voted on')
      : capped ? 'Showing ' + shown.length + ' of ' + all + ' drops' : 'All ' + all + ' drops';
    var more = $('#dropsMore');
    more.hidden = narrowed() || list.length <= PAGE;
    more.textContent = showAll ? 'Show fewer drops' : 'Show all ' + all + ' drops';
    more.setAttribute('aria-expanded', String(showAll));
    drawStats();
    tick();
  }
  function resetFind() {
    query = ''; show = 'all'; $('#find').value = '';
    $$('#dropsBar [data-show]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-show') === 'all')); });
  }

  // A link to a drop's card ("Next: Booth →", a leaderboard row, the streak
  // line) may point at a card the grid is not showing. Bring it in first.
  function goTo(slug) {
    var t = todayApp();
    var el = document.getElementById('app-' + slug);
    if (!el && bySlug(slug)) { resetFind(); showAll = true; draw(); el = document.getElementById('app-' + slug); }
    if (!el && t && t.slug === slug) el = $('#today');
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    try { el.focus({ preventScroll: true }); } catch (e) { /* older browsers */ }
    return true;
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="#app-"]') : null;
    if (!a || !data) return;
    var slug = a.getAttribute('href').slice(5);
    if (goTo(slug)) { e.preventDefault(); try { history.replaceState(null, '', '#app-' + slug); } catch (err) { /* fine */ } }
  });

  var voting = {};
  function vote(slug, v, btn, host) {
    if (voting[slug]) return;
    var a = bySlug(slug);
    var next = a.myVote === v ? null : v;
    if (next === 'keep') burst(btn, ['🔥', '✨', '🎉']);
    if (next === 'kill') { burst(btn, ['💀', '🪦', '👻']); host.classList.add('shake'); setTimeout(function () { host.classList.remove('shake'); }, 500); }
    voting[slug] = true;
    api('POST', '/api/lab/' + slug + '/vote', { v: next }).then(function (r) {
      a.votes = r.votes; a.split = r.split || null; a.splitAt = r.splitAt; a.myVote = r.myVote;
      // Every drawing of this drop is redrawn where it stands: its card in
      // the grid and, for the newest, the hero. Nothing is re-sorted. The
      // one that was tapped gets the reveal's animation and the "Next" line.
      var tapped = null;
      $$('[data-slug="' + slug + '"]').forEach(function (old) {
        var mine = old === host || old.contains(btn);
        var tmp = document.createElement('div');
        tmp.innerHTML = RENDER[old.getAttribute('data-kind') || 'card'](a, mine && !!next);
        var fresh = tmp.firstChild;
        var had = old.contains(document.activeElement);
        var open = $('details', old) && $('details', old).open;
        old.replaceWith(fresh);
        wire(fresh);
        if (open && $('details', fresh)) $('details', fresh).open = true;
        if (mine) { tapped = fresh; animateReveal(fresh); }
        if (had) { var again = $('[data-v="' + v + '"]', fresh); if (again) again.focus({ preventScroll: true }); }
      });
      drawStats();
      if (r.me) {
        data.me = r.me;
        drawMe(r.newBadges);
        // Said in the card, under the reveal, rather than in a toast that
        // would sit on top of the split on a phone.
        var won = (r.newBadges || []).map(function (id) { return (r.me.badges || []).filter(function (x) { return x.id === id; })[0]; }).filter(Boolean);
        if (won.length && tapped) {
          var u = document.createElement('p'); u.className = 'unlocked';
          u.innerHTML = 'Badge unlocked: ' + won.map(function (b) { return '<span aria-hidden="true">' + esc(BADGE_ICON[b.id] || '★') + '</span> ' + esc(b.label); }).join(', ') + ' · <a href="#me">see yours</a>';
          $('.rv', tapped).appendChild(u);
        }
      }
      loadBoard(true);
    }).catch(function (e) { toast(e.message); })
      .then(function () { voting[slug] = false; });
  }

  // The private note: a modal <dialog>, so focus stays inside it, Escape
  // closes it and focus goes back to the button that opened it.
  function note(slug, opener) {
    var a = bySlug(slug);
    var dlg = document.createElement('dialog');
    dlg.className = 'sheet';
    dlg.setAttribute('aria-labelledby', 'noteTitle');
    dlg.innerHTML = '<h2 id="noteTitle"><span aria-hidden="true">' + esc(a.emoji) + '</span> Notes on ' + esc(a.name) + '</h2>' +
      '<p class="sheet-p" id="noteHelp">What would make you use it every week? What annoyed you? This goes straight to Erik — it is not posted anywhere.</p>' +
      '<label class="sr" for="noteText">Your note to Erik</label>' +
      '<textarea id="noteText" maxlength="600" aria-describedby="noteHelp" placeholder="Be honest. It helps."></textarea>' +
      '<p class="sheet-err" role="alert"></p>' +
      '<div class="row"><button type="button" class="btn btn-ghost" data-x>Cancel</button><button type="button" class="btn btn-solid" data-s>Send</button></div>';
    document.body.appendChild(dlg);
    var ta = $('textarea', dlg), err = $('.sheet-err', dlg), send = $('[data-s]', dlg);
    var close = function () { if (dlg.open && dlg.close) dlg.close(); else done(); };
    var done = function () { dlg.remove(); if (opener && document.contains(opener)) opener.focus(); };
    dlg.addEventListener('close', done);
    dlg.addEventListener('click', function (e) { if (e.target === dlg) close(); });
    $('[data-x]', dlg).onclick = close;
    send.onclick = function () {
      send.disabled = true; err.textContent = '';
      api('POST', '/api/lab/' + slug + '/note', { text: ta.value }).then(function () { close(); toast('Sent. Thank you 🙏'); })
        .catch(function (e) { err.textContent = e.message; send.disabled = false; ta.focus(); });
    };
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    ta.focus();
  }

  // Keep or kill standings: rank, votes and the leader, from the lab's own
  // ranking - the public answer carries no split. A keep % comes only from
  // this browser's own reveal (/api/lab's `split`: voted on it, 5+ votes).
  // Hidden until it answers, and left as it was if a refresh fails. The top
  // five show; the rest are one tap away.
  var TOP = 5, boardAll = false, boardData = null;
  function drawBoard() {
    var d = boardData;
    if (!d) return;
    var lead = null;
    var rows = d.apps.map(function (a, i) {
      var v = Math.max(0, Math.floor(Number(a.votes) || 0));
      var isLead = d.leader === a.slug && i === 0;
      if (isLead) lead = a;
      // The rank is public; the split is drawn only for a drop this browser
      // has voted on, with at least 5 votes behind it - the card's rule.
      var mine = data && bySlug(a.slug);
      var showSplit = !!(mine && mine.myVote && mine.split);
      var p = showSplit ? Math.min(100, Math.max(0, Math.round(num(mine.split.keepPct)))) : 0;
      var head = !v ? '' : showSplit ? '<b>' + p + '% keep</b>' : mine && mine.myVote ? '<b class="dim">Split at 5</b>' : '<b class="dim"><span aria-hidden="true">🔒</span> Vote to see</b>';
      var name = mine ? '<a href="#app-' + esc(a.slug) + '">' + esc(a.name) + '</a>' : '<b>' + esc(a.name) + '</b>';
      return '<li' + (isLead ? ' class="lead"' : '') + '><span class="r">' + (i + 1) + '</span>' +
        '<span class="tile sm" data-c1="' + esc(a.color) + '" data-c2="' + esc(a.color2) + '" aria-hidden="true">' + esc(a.emoji) + '</span>' +
        '<span class="n">' + name + '<span class="bar' + (showSplit ? '' : ' hid') + '" aria-hidden="true"><i data-w="' + p + '"></i></span></span>' +
        '<span class="s">' + (v ? head + '<span>' + v + ' vote' + (v === 1 ? '' : 's') + '</span>' : '<span>No votes yet</span>') + '</span></li>';
    });
    var board = $('#board');
    board.innerHTML = (boardAll ? rows : rows.slice(0, TOP)).join('');
    paint(board);
    $('#standingsLead').textContent = lead ? '🔥 ' + lead.name + ' leads' : 'Nobody leads yet';
    var more = $('#boardMore');
    more.hidden = rows.length <= TOP;
    more.textContent = boardAll ? 'Show the top ' + TOP : 'Show all ' + rows.length;
    more.setAttribute('aria-expanded', String(boardAll));
    $('#deck').classList.toggle('open', boardAll);
    $('#standings').hidden = false;
  }
  $('#boardMore').onclick = function () { boardAll = !boardAll; drawBoard(); };
  // After a vote the browser's own 15-second copy is skipped, so the row's
  // count matches the card that was just tapped.
  function loadBoard(fresh) {
    fetch('/api/lab/leaderboard', { credentials: 'omit', cache: fresh ? 'reload' : 'default' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !Array.isArray(d.apps) || !d.apps.length) return;
      boardData = d;
      drawBoard();
    }).catch(function () {});
  }

  function tick() {
    var n = nextDrop(new Date()), ms = n - Date.now();
    var d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
    var short = (d ? d + 'd ' : '') + h + 'h ' + String(m).padStart(2, '0') + 'm';
    if ($('#sNext').textContent !== short) $('#sNext').textContent = short;
    $$('.me-next').forEach(function (x) { if (x.textContent !== short) x.textContent = short; });
    var c = $('#count');
    if (c) c.innerHTML = (d ? d + '<small>d</small>' : '') + h + '<small>h</small>' + String(m).padStart(2, '0') + '<small>m</small>' + String(s).padStart(2, '0') + '<small>s</small>';
  }

  // The hero's cyan glow leans toward the pointer. It never moves by itself,
  // and not at all with reduced motion or without a mouse.
  (function () {
    var hero = $('.hero'), glow = $('#heroGlow');
    if (!hero || !glow || reducedMotion() || !window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    var queued = false, x = 0, y = 0;
    hero.addEventListener('pointermove', function (e) {
      var r = hero.getBoundingClientRect(); x = e.clientX - r.left; y = e.clientY - r.top;
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; glow.style.setProperty('--gx', x + 'px'); glow.style.setProperty('--gy', y + 'px'); });
    });
  })();

  api('GET', '/api/lab').then(function (d) {
    data = d; drawToday(); draw(); drawMe(); setInterval(tick, 1000); loadBoard();
    if (/^#app-/.test(location.hash)) goTo(location.hash.slice(5));
  }).catch(function () {
    $('#drops').innerHTML = '<p class="none">The lab is waking up. Refresh in a moment.</p>';
    $('#today').innerHTML = '<p class="today-wait">The lab is waking up. Refresh in a moment.</p>';
  });
})();
