/* Tells extension - options: the device key and, for local testing, the
 * Tells address. The key is kept in storage.local (never sync: a key is per
 * device, and revoking one should not reach into other browsers). */
(function () {
  'use strict';
  var api = globalThis.browser || globalThis.chrome;
  var DEFAULT_BASE = 'https://challenge.strongtechnicalconsulting.com/tells/';
  var $ = function (id) { return document.getElementById(id); };
  var msg = $('msg');
  function say(text, ok) { msg.textContent = text; msg.className = ok ? 'ok' : 'bad'; }

  api.storage.local.get(['key', 'base']).then(function (v) {
    $('key').value = (v && v.key) || '';
    $('base').value = (v && v.base) || DEFAULT_BASE;
  });

  function cleanBase(b) {
    b = String(b || '').trim() || DEFAULT_BASE;
    if (!/\/$/.test(b)) b += '/';
    if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/.test(b)) return null;
    return b;
  }

  $('save').addEventListener('click', function () {
    var key = $('key').value.trim();
    var base = cleanBase($('base').value);
    if (key && !/^tells_[A-Za-z0-9_-]{43}$/.test(key)) return say('That does not look like a Tells device key (tells_ and 43 more characters).');
    if (!base) return say('The address must start with https:// (or http://localhost for testing).');
    var ask = base === DEFAULT_BASE || !api.permissions ? Promise.resolve(true) : api.permissions.request({ origins: [new URL(base).origin + '/*'] });
    ask.then(function (ok) {
      if (!ok) return say('Tells needs permission to reach that address.');
      return api.storage.local.set({ key: key, base: base }).then(function () { say(key ? 'Saved.' : 'Saved without a key: only the free quick scan will work.', true); });
    }).catch(function () { say('Could not save.'); });
  });

  $('test').addEventListener('click', function () {
    var key = $('key').value.trim();
    var base = cleanBase($('base').value);
    if (!key || !base) return say('Add a key first.');
    fetch(base + 'api/me', { headers: { Authorization: 'Bearer ' + key }, credentials: 'omit' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (x.ok && x.d.signedIn) say('Works. Checks will be charged to ' + x.d.email + '.', true);
        else say((x.d && x.d.error) || 'That key did not work.');
      }, function () { say('Tells could not be reached.'); });
  });

  $('allow').addEventListener('click', function () {
    api.permissions.request({ origins: ['https://*/*'] }).then(function (ok) {
      say(ok ? 'Allowed. Right-click any picture and choose Check this image with Tells.' : 'Not allowed. Images on LinkedIn and X still work.', ok);
    });
  });
}());
