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

  // Drops land at 09:00 UTC on even-numbered days of the month.
  function nextDrop(now) {
    var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9));
    for (var i = 0; i < 40; i++) {
      if (d > now && d.getUTCDate() % 2 === 0 && d.getUTCDate() <= 30) return d;
      d = new Date(d.getTime() + 864e5);
    }
    return d;
  }
  function fmtDate(iso) {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  var data = null;

  function card(a, i) {
    var total = a.votes.keep + a.votes.kill;
    var pct = total ? Math.round(a.votes.keep / total * 100) : 50;
    var href = a.status === 'graduated' && a.home ? a.home : '/' + a.slug + '/';
    return '<article class="app" style="--c1:' + esc(a.color) + ';--c2:' + esc(a.color2) + ';animation-delay:' + (i * 90) + 'ms" data-slug="' + esc(a.slug) + '">' +
      '<div class="top"><span class="badge">Drop #' + String(i + 1).padStart(2, '0') + (a.status === 'graduated' ? ' · Graduated 🎓' : a.status === 'retired' ? ' · Retired' : '') + '</span>' +
      '<h3>' + esc(a.name) + '</h3><div class="date">' + esc(fmtDate(a.dropped)) + '</div><div class="emoji">' + esc(a.emoji) + '</div></div>' +
      '<div class="body"><p class="tagline">' + esc(a.tagline) + '</p><p class="blurb">' + esc(a.blurb) + '</p>' +
      '<div class="feats">' + a.features.map(function (f) { return '<span>' + esc(f) + '</span>'; }).join('') + '</div>' +
      '<div class="who">For: ' + esc(a.audience) + '</div>' +
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

  function tick() {
    var n = nextDrop(new Date()), ms = n - Date.now();
    var d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
    $('#sNext').textContent = (d ? d + 'd ' : '') + h + 'h ' + String(m).padStart(2, '0') + 'm';
    var c = $('#count');
    if (c) c.innerHTML = (d ? d + '<small>d</small>' : '') + h + '<small>h</small>' + String(m).padStart(2, '0') + '<small>m</small>' + String(s).padStart(2, '0') + '<small>s</small>';
  }

  api('GET', '/api/lab').then(function (d) { data = d; draw(); tick(); setInterval(tick, 1000); })
    .catch(function () { $('#drops').innerHTML = '<p style="color:var(--muted)">The lab is waking up. Refresh in a moment.</p>'; });
})();
