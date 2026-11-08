/* Lab Pulse (/pulse): draws /api/pulse. Read-only; no model call, no account.
   Everything is built with textContent, never markup, and every link is
   checked again here before it is used. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  // Only the links the server is allowed to send: this host, GitHub Actions,
  // Apple's developer site.
  function safeHref(href) {
    if (typeof href !== 'string') return null;
    if (/^\/[a-z0-9-]+\/$/.test(href)) return href;
    if (/^https:\/\/github\.com\/eRock35\/eriks-projects\/actions\/(runs\/\d+(\/job\/\d+)?|workflows\/[a-z-]+\.yml)$/.test(href)) return href;
    if (/^https:\/\/(developer\.apple\.com\/account|appstoreconnect\.apple\.com\/)$/.test(href)) return href;
    if (/^https:\/\/[a-z0-9-]+\.strongtechnicalconsulting\.com\/?$/.test(href)) return href;
    return null;
  }
  function link(href, cls, text) {
    var ok = safeHref(href);
    if (!ok) return el('span', cls, text);
    var a = el('a', cls, text);
    a.href = ok;
    if (/^https:/.test(ok)) a.rel = 'noopener noreferrer';
    return a;
  }

  function shortDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  function longDate(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
      + ', ' + d.toISOString().slice(11, 16) + ' UTC';
  }
  function ago(minutes) {
    if (minutes == null) return '';
    if (minutes < 2) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    var h = Math.round(minutes / 60);
    if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + ' days ago';
  }
  function agoFrom(iso, servedAt) {
    var a = Date.parse(iso), b = Date.parse(servedAt);
    return isFinite(a) && isFinite(b) ? ago(Math.max(0, Math.round((b - a) / 6e4))) : '';
  }
  function tokens(v) {
    v = Number(v);
    if (!isFinite(v) || v < 0) return '–';
    if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (v >= 1e3) return Math.round(v / 1e3) + 'K';
    return String(Math.round(v));
  }
  function span(ms) {
    var m = Math.round(Number(ms) / 6e4);
    if (!isFinite(m) || m < 0) return '–';
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' m';
  }

  var RESULT = {
    ok: { mark: '✓', word: 'Passed', cls: 'ok' },
    bad: { mark: '✗', word: 'Failed', cls: 'bad' },
    running: { mark: '…', word: 'Running', cls: 'running' },
    other: { mark: '–', word: 'Did not finish', cls: '' },
  };
  function resultChip(r, href, suffix) {
    var k = RESULT[r] || RESULT.other;
    var c = link(href, 'chip ' + k.cls);
    var m = el('span', 'mark', k.mark); m.setAttribute('aria-hidden', 'true');
    c.appendChild(m);
    c.appendChild(document.createTextNode(k.word + (suffix ? ' · ' + suffix : '')));
    return c;
  }

  function drawFresh(d) {
    var f = $('fresh'); f.textContent = '';
    var s = d.source;
    if (!s.ok) {
      f.appendChild(el('b', null, 'Build data is unavailable right now.'));
      f.appendChild(document.createTextNode(' The lab’s list of builds and TestFlight states could not be read'
        + (s.status === 'timeout' ? ' in time' : '') + '. The lab apps below are live from this server.'));
      return;
    }
    var from = s.appStoreConnect === 'ok' ? 'from GitHub and App Store Connect.'
      : 'from GitHub. App Store Connect ' + ({ agreement: 'refused: the agreement is not accepted.', auth: 'refused the key.', unset: 'was not checked.' }[s.appStoreConnect] || 'did not answer.');
    f.appendChild(el('b', null, 'Updated ' + ago(s.ageMinutes)));
    f.appendChild(document.createTextNode(' ' + from));
    if (s.github === false) f.appendChild(document.createTextNode(' GitHub could not be read on that run.'));
    if (s.refreshFailed) f.appendChild(document.createTextNode(' (The latest refresh failed; this is the last good copy.)'));
    if (s.stale) f.appendChild(document.createTextNode(' That is older than it should be: the Lab Pulse workflow may have stopped.'));
  }

  function drawBanners(d) {
    var box = $('banners'); box.textContent = '';
    d.banners.forEach(function (b) {
      var p = el('div', 'banner' + (b.kind === 'expiry' ? ' notice' : ''));
      p.setAttribute('role', b.kind === 'agreement' ? 'alert' : 'status');
      p.appendChild(el('b', null, b.kind === 'agreement' ? 'iPhone builds are stopped' : 'TestFlight builds are running out'));
      p.appendChild(document.createTextNode(b.text));
      var go = el('span', 'go');
      (b.links || []).forEach(function (l) { go.appendChild(link(l.href, null, l.text)); });
      p.appendChild(go);
      box.appendChild(p);
    });
  }

  function cell(label, cls) {
    var c = el('div', cls);
    c.appendChild(el('span', 'cell-label', label));
    return c;
  }

  function drawIos(d) {
    var ip = d.iphone, meta = $('iosMeta'); meta.textContent = '';
    if (ip.lastRun) {
      var lr = ip.lastRun;
      meta.appendChild(document.createTextNode('Last run '));
      meta.appendChild(link(lr.url, null, '#' + lr.number));
      meta.appendChild(document.createTextNode(' · ' + shortDate(lr.at) + ' · '
        + (lr.checkOnly ? 'check only' : { schedule: 'scheduled', workflow_dispatch: 'by hand' }[lr.event] || lr.event) + ' · '
        + (RESULT[lr.result] || RESULT.other).word.toLowerCase() + '. '));
    }
    meta.appendChild(document.createTextNode('Next scheduled build: '));
    meta.appendChild(el('b', null, longDate(ip.nextScheduled)));

    var list = $('iosList'); list.textContent = '';
    ip.apps.forEach(function (a) {
      var li = el('li');
      var c1 = el('div', 'app');
      c1.appendChild(el('b', null, a.name));
      c1.appendChild(el('span', 'sub', a.build && a.build.version
        ? 'Build ' + a.build.version + (a.build.number ? ' (' + a.build.number + ')' : '')
        : (a.build && a.build.number ? 'Build ' + a.build.number : (d.source.ok ? 'No build number known' : 'Build unknown'))));
      li.appendChild(c1);

      var c2 = cell('Latest build');
      if (a.latest) {
        c2.appendChild(resultChip(a.latest.result, a.latest.url, 'run #' + a.latest.run));
        var why = [shortDate(a.latest.at)];
        if (a.latest.stoppedInPlan) why.push('stopped before building');
        else if (a.latest.failedStep && a.latest.result === 'bad') why.push('at ' + a.latest.failedStep);
        if (a.latest.why) why.push(a.latest.why);
        c2.appendChild(el('span', 'sub', why.filter(Boolean).join(' · ')));
      } else {
        c2.appendChild(el('span', 'chip', d.source.ok ? 'No build in the recent runs' : 'Unknown'));
      }
      li.appendChild(c2);

      var c3 = cell('TestFlight');
      c3.appendChild(el('span', 'chip ' + (a.testflight.tone === 'muted' ? '' : a.testflight.tone), a.testflight.text));
      li.appendChild(c3);

      var c4 = cell('Last upload', 'up');
      if (a.lastUpload) {
        c4.appendChild(link(a.lastUpload.url, null, 'Run #' + a.lastUpload.run + ' · ' + shortDate(a.lastUpload.at)));
      } else {
        c4.appendChild(el('span', 'sub', d.source.ok ? 'None in the recent runs' : 'Unknown'));
      }
      li.appendChild(c4);
      list.appendChild(li);
    });
  }

  var HEX = /^#[0-9a-f]{6}$/i;
  function drawLab(d) {
    var L = d.lab, c = L.counts;
    $('labMeta').textContent = c.total + ' drops · ' + c.mounted + ' live here'
      + (c.graduated ? ' · ' + c.graduated + ' graduated' : '') + (c.retired ? ' · ' + c.retired + ' retired' : '');

    var ci = $('labCi'); ci.textContent = '';
    if (d.ci) {
      ci.appendChild(document.createTextNode('Repo CI on main:'));
      ci.appendChild(resultChip(d.ci.result, d.ci.url, 'run #' + d.ci.run));
      ci.appendChild(el('span', null, 'finished ' + agoFrom(d.ci.at, d.servedAt)));
    } else {
      ci.textContent = 'Repo CI on main: not known right now.';
    }

    var body = $('labRows'); body.textContent = '';
    L.apps.slice().reverse().forEach(function (a) {
      var tr = el('tr');
      tr.appendChild(el('td', 'num', a.drop));
      var tdApp = el('td', 'app');
      var name = a.href ? link(a.href, null) : el('span', 'n');
      var e = el('span', 'e', a.emoji); e.setAttribute('aria-hidden', 'true');
      if (HEX.test(a.color || '') && HEX.test(a.color2 || '')) e.style.background = 'linear-gradient(135deg,' + a.color + ',' + a.color2 + ')';
      name.appendChild(e);
      name.appendChild(document.createTextNode(a.name));
      tdApp.appendChild(name);
      tr.appendChild(tdApp);
      tr.appendChild(el('td', null, shortDate(a.dropped + 'T12:00:00Z')));
      var st = el('td');
      st.appendChild(el('span', 'chip', { testing: 'Testing', graduated: 'Graduated', retired: 'Retired' }[a.status] || a.status));
      tr.appendChild(st);
      var live = el('td');
      live.appendChild(el('span', 'chip ' + (a.mounted ? 'ok' : (a.status === 'testing' ? 'bad' : '')),
        a.mounted ? '✓ Mounted' : (a.status === 'testing' ? '✗ Not mounted' : '–')));
      tr.appendChild(live);
      var b = a.build;
      var tok = el('td', 'num', b ? tokens(b.in) + ' / ' + tokens(b.out) : '–');
      if (b && !b.exact) tok.appendChild(el('span', 'est', 'est.'));
      tr.appendChild(tok);
      tr.appendChild(el('td', 'num', b ? b.agents : '–'));
      tr.appendChild(el('td', 'num', b ? span(b.agentMs) : '–'));
      body.appendChild(tr);
    });
  }

  fetch('/api/pulse', { credentials: 'omit', headers: { Accept: 'application/json' } })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(function (d) {
      drawFresh(d); drawBanners(d); drawIos(d); drawLab(d);
      document.documentElement.setAttribute('data-drawn', '1');
    })
    .catch(function () {
      $('fresh').textContent = 'Lab Pulse could not load just now. Try again in a minute.';
    });
})();
