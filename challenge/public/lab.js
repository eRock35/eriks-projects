/* The lab's landing page. No model calls, no account needed. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };

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
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2400);
  }
  function burst(el, chars) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var r = el.getBoundingClientRect();
    for (var i = 0; i < 14; i++) {
      var s = document.createElement('span');
      s.className = 'burst'; s.textContent = chars[i % chars.length];
      s.style.left = (r.left + r.width / 2) + 'px'; s.style.top = (r.top + r.height / 2) + 'px';
      var a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 90;
      s.style.setProperty('--dx', Math.cos(a) * d + 'px'); s.style.setProperty('--dy', Math.sin(a) * d - 40 + 'px');
      s.style.setProperty('--r', (Math.random() * 360 - 180) + 'deg');
      document.body.appendChild(s); setTimeout(function (x) { x.remove(); }.bind(null, s), 1100);
    }
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
    return '<div class="made" title="' + esc(tip.trim()) + '"><a class="est" href="#built">Build' + (b.exact ? '' : ' est.') + '</a>' +
      '<span class="sr">' + (b.exact ? '' : 'estimated: ') + '</span>' + text + '</div>';
  }

  // Count up from zero once, when the strip is on screen; never with
  // reduced motion, where the final numbers are simply there.
  function countUp(els) {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !window.requestAnimationFrame) return;
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
    countUp(Array.prototype.slice.call(document.querySelectorAll('#builtGrid b')));
  }

  function card(a, i) {
    var total = a.votes.keep + a.votes.kill;
    var pct = total ? Math.round(a.votes.keep / total * 100) : 50;
    var href = a.status === 'graduated' && a.home ? a.home : '/' + a.slug + '/';
    return '<article class="app" style="--c1:' + esc(a.color) + ';--c2:' + esc(a.color2) + ';animation-delay:' + (i * 90) + 'ms" data-slug="' + esc(a.slug) + '">' +
      '<div class="top"><span class="badge">Drop #' + String(i + 1).padStart(2, '0') + (a.status === 'graduated' ? ' · Graduated 🎓' : a.status === 'retired' ? ' · Retired' : '') + '</span>' +
      '<h3>' + esc(a.name) + '</h3><div class="date">' + esc(fmtDate(a.dropped)) + '</div><div class="emoji">' + esc(a.emoji) + '</div></div>' +
      '<div class="body"><p class="tagline">' + esc(a.tagline) + '</p><p class="blurb">' + esc(a.blurb) + '</p>' +
      '<div class="feats">' + a.features.map(function (f) { return '<span>' + esc(f) + '</span>'; }).join('') + '</div>' +
      '<div class="who">For: ' + esc(a.audience) + '</div>' + madeLine(a.build) +
      (a.live || a.status === 'graduated' ? '<a class="try" href="' + esc(href) + '">Try ' + esc(a.name) + ' <span class="arr">→</span></a>' : '<span class="try off">Warming up…</span>') +
      '<div class="vote"><div class="q"><span>Keep it or kill it?</span><span>' + total + ' vote' + (total === 1 ? '' : 's') + '</span></div>' +
      '<div class="vbtns"><button class="keep' + (a.myVote === 'keep' ? ' on' : '') + '" data-v="keep">🔥 Keep <span class="c">' + a.votes.keep + '</span></button>' +
      '<button class="kill' + (a.myVote === 'kill' ? ' on' : '') + '" data-v="kill">💀 Kill <span class="c">' + a.votes.kill + '</span></button></div>' +
      '<div class="meter" title="' + pct + '% keep"><i style="width:' + pct + '%"></i></div>' +
      '<button class="note-btn">💬 Tell Erik what you’d change</button></div></div></article>';
  }

  function nextCard() {
    return '<article class="app next" style="--c1:#7c3aed;--c2:#ec4899"><div class="top"><span class="badge">Drop #' + String(data.apps.length + 1).padStart(2, '0') + ' · Classified</span>' +
      '<h3>???</h3><div class="date">Something is cooking</div><div class="emoji">🧪</div></div>' +
      '<div class="body"><p class="tagline">The next experiment is being built right now.</p>' +
      '<div class="count" id="count">–</div><p class="blurb">Every drop tries to fix a real business headache in a way that’s fun to use. Come back and vote.</p></div></article>';
  }

  function draw() {
    var el = $('#drops');
    el.innerHTML = data.apps.map(card).join('') + nextCard();
    if (!drewBuilt) { drewBuilt = true; drawBuilt(data.buildTotals); }
    Array.prototype.forEach.call(el.querySelectorAll('.app[data-slug]'), function (c) {
      var slug = c.dataset.slug;
      Array.prototype.forEach.call(c.querySelectorAll('.vbtns button'), function (b) {
        b.onclick = function () { vote(slug, b.dataset.v, b, c); };
      });
      $('.note-btn', c).onclick = function () { note(slug); };
    });
    $('#sApps').textContent = data.apps.length;
    var first = data.apps.reduce(function (m, a) { return a.dropped < m ? a.dropped : m; }, data.apps[0] ? data.apps[0].dropped : new Date().toISOString().slice(0, 10));
    $('#sDay').textContent = Math.max(1, Math.floor((Date.now() - new Date(first + 'T00:00:00Z')) / 864e5) + 1);
  }

  function vote(slug, v, btn, cardEl) {
    var a = data.apps.filter(function (x) { return x.slug === slug; })[0];
    var next = a.myVote === v ? null : v;
    if (next === 'keep') burst(btn, ['🔥', '✨', '🎉']);
    if (next === 'kill') { burst(btn, ['💀', '🪦', '👻']); cardEl.classList.add('shake'); setTimeout(function () { cardEl.classList.remove('shake'); }, 500); }
    api('POST', '/api/lab/' + slug + '/vote', { v: next }).then(function (r) {
      a.votes = r.votes; a.myVote = r.myVote;
      var i = data.apps.indexOf(a);
      var tmp = document.createElement('div'); tmp.innerHTML = card(a, i);
      var fresh = tmp.firstChild; fresh.style.animation = 'none';
      cardEl.replaceWith(fresh);
      Array.prototype.forEach.call(fresh.querySelectorAll('.vbtns button'), function (b) { b.onclick = function () { vote(slug, b.dataset.v, b, fresh); }; });
      $('.note-btn', fresh).onclick = function () { note(slug); };
      if (next) toast(next === 'keep' ? 'Noted — you want ' + a.name + ' kept 🔥' : 'Brutal. Noted 💀');
      loadBoard();
    }).catch(function (e) { toast(e.message); });
  }

  function note(slug) {
    var a = data.apps.filter(function (x) { return x.slug === slug; })[0];
    var scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = '<div class="sheet"><h3>' + esc(a.emoji) + ' Notes on ' + esc(a.name) + '</h3><p style="color:var(--muted);margin:6px 0 0">What would make you use it every week? What annoyed you? This goes straight to Erik — it is not posted anywhere.</p>' +
      '<textarea maxlength="600" placeholder="Be honest. It helps."></textarea><div class="row"><button class="btn ghost" data-x>Cancel</button><button class="btn" data-s>Send</button></div></div>';
    document.body.appendChild(scrim);
    var ta = $('textarea', scrim); ta.focus();
    scrim.onclick = function (e) { if (e.target === scrim || e.target.hasAttribute('data-x')) scrim.remove(); };
    $('[data-s]', scrim).onclick = function () {
      api('POST', '/api/lab/' + slug + '/note', { text: ta.value }).then(function () { scrim.remove(); toast('Sent. Thank you 🙏'); })
        .catch(function (e) { toast(e.message); });
    };
  }

  // Keep or kill standings. Counts only, from the lab's own ranking; hidden
  // until it answers, and left as it was if a refresh fails.
  var HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  function loadBoard() {
    fetch('/api/lab/leaderboard', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !Array.isArray(d.apps) || !d.apps.length) return;
      var lead = null;
      $('#board').innerHTML = d.apps.map(function (a, i) {
        var v = Math.max(0, Math.floor(Number(a.votes) || 0)), p = a.keepPct == null ? null : Math.min(100, Math.max(0, Math.floor(Number(a.keepPct) || 0)));
        var isLead = d.leader === a.slug && i === 0;
        if (isLead) lead = a;
        var style = HEX.test(a.color) && HEX.test(a.color2) ? ' style="--c1:' + a.color + ';--c2:' + a.color2 + '"' : '';
        return '<li' + (isLead ? ' class="lead"' : '') + '><span class="r">' + (i + 1) + '</span><span class="e"' + style + ' aria-hidden="true">' + esc(a.emoji) + '</span>' +
          '<span class="n"><b>' + esc(a.name) + '</b><span class="bar" aria-hidden="true"><i style="--p:' + (p || 0) + '%"></i></span></span>' +
          '<span class="s">' + (v ? '<b>' + p + '% keep</b>' + v + ' vote' + (v === 1 ? '' : 's') : 'No votes yet') + '</span></li>';
      }).join('');
      $('#standingsLead').textContent = lead ? '🔥 ' + lead.name + ' leads' : 'Nobody leads yet';
      $('#standings').hidden = false;
    }).catch(function () {});
  }

  function tick() {
    var n = nextDrop(new Date()), ms = n - Date.now();
    var d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
    $('#sNext').textContent = (d ? d + 'd ' : '') + h + 'h ' + String(m).padStart(2, '0') + 'm';
    var c = $('#count');
    if (c) c.innerHTML = (d ? d + '<small>d</small>' : '') + h + '<small>h</small>' + String(m).padStart(2, '0') + '<small>m</small>' + String(s).padStart(2, '0') + '<small>s</small>';
  }

  api('GET', '/api/lab').then(function (d) { data = d; draw(); tick(); setInterval(tick, 1000); loadBoard(); })
    .catch(function () { $('#drops').innerHTML = '<p style="color:var(--muted)">The lab is waking up. Refresh in a moment.</p>'; });
})();
