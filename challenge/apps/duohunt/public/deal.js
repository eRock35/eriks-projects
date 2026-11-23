/* Duo Hunt - "Check a deal" and the account sheet.
 *
 * Paste a carrier offer, tap "Work it out": the server has a model copy the
 * terms out (signed-in only), then adds up the 36-month cost itself and
 * checks every quoted catch against the pasted words. This file only sends
 * the text and draws the answer - every string through textContent, nothing
 * as markup, nothing stored in the browser.
 */
(function () {
  'use strict';
  var D = window.DealCore;
  var BASE = location.pathname.replace(/[^/]*$/, '');
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') n.textContent = String(v);
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function say(msg) { var l = $('live'); l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); }
  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var e = new Error((data && data.error) || 'That did not work. Try again.'); e.status = res.status; e.data = data || {}; throw e; }
        return data;
      });
    });
  }

  /* ---------------- the account ---------------- */
  var me = { signedIn: false };
  var afterSignIn = null;
  var sheet = $('account');
  function drawAccount() {
    $('acctBtn').textContent = me.signedIn ? 'Account' : 'Sign in';
    $('acctOut').hidden = !!me.signedIn;
    $('acctIn').hidden = !me.signedIn;
    if (me.signedIn) {
      $('acctWho').textContent = me.email || 'you';
      var b = me.budget || {};
      $('acctCredit').textContent = b.unlimited ? 'AI use is not metered on this account.'
        : typeof b.remainingUsd === 'number' ? 'AI credit left: $' + Math.max(0, b.remainingUsd).toFixed(2) + '. It works across every app in the lab.' : '';
    }
    var pk = window.Passkey && window.Passkey.supported && window.Passkey.supported() && !/\.run\.app$/.test(location.hostname);
    $('acctPasskey').hidden = !pk;
  }
  function loadMe() {
    return api('GET', 'api/auth/me').then(function (m) { me = m && m.signedIn ? m : { signedIn: false }; }, function () { me = { signedIn: false }; }).then(drawAccount);
  }
  function openAccount(why, then) {
    afterSignIn = then || null;
    $('acctWhy').textContent = why || 'Sign in to check a deal. One account works across every app in the lab, and it comes with a little free AI credit.';
    $('acctErr').hidden = true;
    drawAccount();
    try { if (sheet.showModal) sheet.showModal(); else sheet.setAttribute('open', ''); } catch (e) { sheet.setAttribute('open', ''); }
    if (!me.signedIn) $('acctEmail').focus();
  }
  function closeAccount() { try { if (sheet.close) sheet.close(); else sheet.removeAttribute('open'); } catch (e) { sheet.removeAttribute('open'); } }
  function acctFail(e) { var p = $('acctErr'); p.textContent = e && e.message ? e.message : 'That did not work.'; p.hidden = false; }
  function signedIn() {
    return loadMe().then(function () {
      closeAccount();
      say('Signed in.');
      var then = afterSignIn; afterSignIn = null;
      if (then) then();
    });
  }
  function auth(path) {
    $('acctErr').hidden = true;
    var email = $('acctEmail').value.trim(), password = $('acctPass').value;
    if (!email || !password) { acctFail(new Error('Enter your email and a password.')); return; }
    api('POST', 'api/auth/' + path, { email: email, password: password }).then(function () { $('acctPass').value = ''; return signedIn(); }).catch(acctFail);
  }
  $('acctBtn').addEventListener('click', function () { openAccount(); });
  $('accountClose').addEventListener('click', closeAccount);
  sheet.addEventListener('click', function (e) { if (e.target === sheet) closeAccount(); });
  $('acctForm').addEventListener('submit', function (e) { e.preventDefault(); auth('login'); });
  $('acctCreate').addEventListener('click', function () { auth('register'); });
  $('acctPasskey').addEventListener('click', function () {
    $('acctErr').hidden = true;
    window.Passkey.signIn(BASE + 'api/auth/passkey').then(signedIn).catch(function (e) { if (!window.Passkey.cancelled(e)) acctFail(e); });
  });
  $('acctSignOut').addEventListener('click', function () {
    api('POST', 'api/auth/logout', {}).catch(function () {}).then(function () { me = { signedIn: false }; drawAccount(); closeAccount(); say('Signed out.'); });
  });

  /* ---------------- the deal ---------------- */
  var busy = false;
  function dealError(text, more) {
    var p = $('dealErr');
    p.textContent = text || '';
    p.hidden = !text;
    var m = $('dealMore');
    m.textContent = '';
    m.hidden = true;
    if (more && more.detail) { m.appendChild(document.createTextNode(String(more.detail) + ' ')); m.hidden = false; }
    if (more && more.topUpUrl) {
      // Only ever a link on this site.
      try {
        var u = new URL(String(more.topUpUrl), location.href);
        if (u.origin === location.origin) { m.appendChild(el('a', { href: u.pathname + u.search, text: 'Top up credit' })); m.hidden = false; }
      } catch (e) { /* no link */ }
    }
    if (text) say(text);
  }
  function section(title, kids, cls) {
    return el('section', { class: 'd-sec' + (cls ? ' ' + cls : '') }, [el('h2', { class: 'h2', text: title })].concat(kids));
  }
  function draw(r) {
    var out = $('dealOut');
    out.textContent = '';
    var c = r.cost || {};
    var name = r.terms && r.terms.deviceName ? r.terms.deviceName : 'This deal';
    out.appendChild(el('div', { class: 'd-total' }, [
      el('p', { class: 'd-kicker', text: name + ' · ' + c.months + ' months, all in' }),
      el('p', { class: 'd-figure', text: c.total }),
      el('p', { class: 'd-sub', text: c.complete ? 'About ' + c.perMonth + ' a month, before tax.' : 'So far - the offer didn’t give ' + (c.missing || []).join(' or ') + ', so the real total is higher.' }),
      c.ifMissed ? el('p', { class: 'd-risk' }, [el('strong', { text: c.ifMissed }), ' if the conditions slip - the monthly credits stop' + (r.terms && r.terms.monthlyLineWithout !== null ? ' and AutoPay is off.' : '.')]) : null,
    ]));

    var rows = (c.lines || []).map(function (l) {
      return el('li', { class: 'd-row' + (l.credit ? ' credit' : '') }, [
        el('span', { class: 'd-what' }, [el('span', { class: 'd-label', text: l.label }), el('span', { class: 'd-work', text: l.working }), l.condition ? el('span', { class: 'd-cond', text: 'Only if: ' + l.condition }) : null]),
        el('span', { class: 'd-amt', text: l.amount }),
      ]);
    });
    rows.push(el('li', { class: 'd-row sum' }, [el('span', { class: 'd-what' }, [el('span', { class: 'd-label', text: c.months + '-month total' })]), el('span', { class: 'd-amt', text: c.total })]));
    var workKids = [el('ul', { class: 'd-rows' }, rows)];
    (c.after || []).forEach(function (a) { workKids.push(el('p', { class: 'hint', text: a })); });
    workKids.push(el('p', { class: 'hint', text: 'Added up by Duo Hunt from the numbers in your text - not by the AI. Sales tax and government fees are not included.' }));
    out.appendChild(section('The working', workKids));

    var catches = r.catches || [];
    out.appendChild(section('The catch', catches.length ? [el('ol', { class: 'd-catches' }, catches.map(function (k) {
      return el('li', null, [el('p', { class: 'd-catch', text: k.text }), el('blockquote', { class: 'd-quote', text: '“' + k.quote + '”' })]);
    })), el('p', { class: 'hint', text: 'Each quote is word for word from what you pasted.' })]
      : [el('p', { class: 'hint', text: 'No catch could be tied to the offer’s own words. Read the fine print yourself before you sign.' })]));

    var notes = [];
    var d = r.dropped || {};
    if (d.numbers && d.numbers.length) notes.push('Left out because the number wasn’t in your text: ' + d.numbers.join(', ') + '.');
    if (d.catches) notes.push(d.catches + (d.catches === 1 ? ' catch was' : ' catches were') + ' left out because the quote wasn’t word for word in your text.');
    if (r.unsure && r.unsure.length) notes.push('The offer leaves unclear: ' + r.unsure.join('; ') + '.');
    if (r.redacted) notes.push('An email address or phone number was taken out of your text before it was read.');
    if (notes.length) out.appendChild(section('Worth knowing', [el('ul', { class: 'd-notes' }, notes.map(function (n) { return el('li', { text: n }); }))]));
    out.hidden = false;
    say('Worked out: ' + c.total + ' over ' + c.months + ' months.');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(function () { out.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); }, 50);
  }
  function work() {
    if (busy) return;
    var checked = D.cleanText($('dealText').value);
    if (checked.error) { dealError(checked.error); $('dealText').focus(); return; }
    if (!me.signedIn) { openAccount('Sign in to check a deal - reading an offer uses a little AI credit.', work); return; }
    dealError('');
    busy = true;
    var btn = $('dealBtn');
    btn.disabled = true; btn.textContent = 'Reading the fine print…';
    api('POST', 'api/deal', { text: $('dealText').value }).then(draw).catch(function (e) {
      if (e.status === 401) { me = { signedIn: false }; drawAccount(); openAccount('Sign in to check a deal.', work); return; }
      dealError(e.message, e.data);
    }).then(function () {
      busy = false;
      btn.disabled = false; btn.textContent = 'Work it out';
    });
  }
  $('dealForm').addEventListener('submit', function (e) { e.preventDefault(); work(); });
  $('dealSample').addEventListener('click', function () {
    $('dealText').value = D.SAMPLE;
    dealError('');
    say('Sample deal pasted. Northwind Mobile is a made-up carrier.');
    $('dealBtn').focus();
  });

  loadMe();
}());
