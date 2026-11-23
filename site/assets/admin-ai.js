// /admin/ai: find a person, see their AI spend and budget, grant or revoke
// extra credit and higher Lab burst limits. Text only (textContent), no
// inline script, same-origin JSON writes. See server.js "Owner AI grants".
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var current = null; // the person on screen

  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Something went wrong.');
        return data;
      });
    });
  }

  function say(el, text, kind) { el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : ''); }
  var money = function (n) { return n === null || n === undefined || !isFinite(n) ? 'unknown' : '$' + Number(n).toFixed(2); };

  /* ---- the lab's ceiling ---- */
  api('GET', '/api/admin/ai/lab').then(function (d) {
    var box = $('lab'); box.textContent = '';
    if (!d.ok) { box.textContent = d.error || 'The lab did not answer.'; return; }
    ['claude', 'gemini'].forEach(function (p) {
      var r = d[p]; if (!r) return;
      var line = document.createElement('div');
      line.textContent = (p === 'claude' ? 'Claude' : 'Gemini') + ': ' + money(r.monthUsd) + ' of ' + money(r.capUsd);
      var bar = document.createElement('div'); bar.className = 'bar';
      var fill = document.createElement('i');
      var pct = r.capUsd ? Math.max(0, Math.min(100, (Number(r.monthUsd) || 0) / r.capUsd * 100)) : 0;
      fill.style.width = pct.toFixed(1) + '%';
      bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', pct.toFixed(0) + '% of the cap');
      bar.appendChild(fill);
      box.appendChild(line); box.appendChild(bar);
    });
  }).catch(function () { $('lab').textContent = 'The lab did not answer.'; });

  /* ---- one person ---- */
  function fact(dl, k, v) {
    var dt = document.createElement('dt'); dt.textContent = k;
    var dd = document.createElement('dd'); dd.textContent = v;
    dl.appendChild(dt); dl.appendChild(dd);
  }

  function grantText(g, active) {
    if (!g) return 'None';
    var bits = [];
    if (g.extraUsd) bits.push('+' + money(g.extraUsd) + ' credit');
    if (g.perMinute) bits.push(g.perMinute + '/min');
    if (g.perDay) bits.push(g.perDay + '/day');
    var s = bits.join(', ') || 'empty';
    s += g.until ? ' until ' + g.until.slice(0, 10) : ', no end date';
    if (!active) s += ' (ended)';
    if (g.at) s += ' - set ' + g.at.slice(0, 10);
    if (g.note) s += ' - ' + g.note;
    return s;
  }

  function show(p) {
    current = p;
    var dl = $('facts'); dl.textContent = '';
    var b = p.budget || {};
    fact(dl, 'Email', p.email || '');
    fact(dl, 'Since', (p.createdAt || '').slice(0, 10) || 'unknown');
    var m = p.month || {};
    fact(dl, 'Spent this month', money(m.usd) + ' over ' + (m.calls || 0) + ' calls' + (m.byokCalls ? ' (+' + m.byokCalls + ' on their own key)' : ''));
    if (b.unlimited) fact(dl, 'Budget', b.reason === 'owner' ? 'Owner - not metered' : 'Own key - not metered');
    else {
      fact(dl, 'Budget', money(b.remainingUsd) + ' left of ' + money(b.allowanceUsd));
      fact(dl, 'Made of', 'free allowance' + (b.toppedUpUsd ? ' + ' + money(b.toppedUpUsd) + ' bought' : '') + (b.grantedUsd ? ' + ' + money(b.grantedUsd) + ' granted by you' : ''));
      fact(dl, 'Spent all time', money(b.spentUsd));
    }
    fact(dl, 'Grant', grantText(p.aiGrant, p.grantActive));
    var g = p.grantActive && p.aiGrant ? p.aiGrant : {};
    $('extraUsd').value = g.extraUsd || '';
    $('perMinute').value = g.perMinute || '';
    $('perDay').value = g.perDay || '';
    $('until').value = g.until ? g.until.slice(0, 10) : '';
    $('note').value = g.note || '';
    $('revoke').disabled = !p.aiGrant;
    $('person').hidden = false;
  }

  $('find').addEventListener('submit', function (e) {
    e.preventDefault();
    say($('find-msg'), 'Looking…');
    say($('grant-msg'), '');
    api('GET', '/api/admin/ai?email=' + encodeURIComponent($('email').value.trim()))
      .then(function (d) { say($('find-msg'), ''); show(d.person); })
      .catch(function (err) { $('person').hidden = true; say($('find-msg'), err.message, 'err'); });
  });

  document.querySelectorAll('[data-preset]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var k = btn.getAttribute('data-preset');
      var cur = Number($('extraUsd').value) || 0;
      if (k === 'usd5') $('extraUsd').value = (cur + 5).toFixed(2);
      if (k === 'usd20') $('extraUsd').value = (cur + 20).toFixed(2);
      if (k === 'limits') { $('perMinute').value = 20; $('perDay').value = 200; }
      $('extraUsd').focus();
    });
  });

  $('grant').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!current) return;
    say($('grant-msg'), 'Saving…');
    api('POST', '/api/admin/ai/grant', {
      uid: current.uid,
      extraUsd: $('extraUsd').value,
      perMinute: $('perMinute').value,
      perDay: $('perDay').value,
      until: $('until').value || null,
      note: $('note').value,
    }).then(function (d) { show(d.person); say($('grant-msg'), 'Saved.', 'ok'); })
      .catch(function (err) { say($('grant-msg'), err.message, 'err'); });
  });

  $('revoke').addEventListener('click', function () {
    if (!current || !confirm('Revoke this grant?')) return;
    api('POST', '/api/admin/ai/revoke', { uid: current.uid })
      .then(function (d) { show(d.person); say($('grant-msg'), 'Revoked.', 'ok'); })
      .catch(function (err) { say($('grant-msg'), err.message, 'err'); });
  });
})();
