/* Tells extension - the toolbar popup. The same checks as the right-click
 * menu, for browsers without one (Safari on iPhone and iPad): read the
 * selection or the page from the active tab (activeTab + scripting, granted
 * by opening the popup), quick-scan it here, and send a deep read or an
 * originality check through the background worker only when asked. */
(function () {
  'use strict';
  var api = globalThis.browser || globalThis.chrome;
  var Core = window.TellsCore, UI = window.TellsUI;
  var out = document.getElementById('out');
  var state = null;

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        var p = api.runtime.sendMessage(msg, function (r) { resolve(r || { error: 'No answer from Tells.' }); });
        if (p && typeof p.then === 'function') p.then(resolve, function (e) { resolve({ error: String(e && e.message || e) }); });
      } catch (e) { resolve({ error: 'Tells could not be reached.' }); }
    });
  }
  function draw() { UI.render(out, state); }
  function run(kind) {
    if (state.busy[kind]) return;
    state.busy[kind] = true; state.error = null; draw();
    send({ type: 'check', kind: kind, text: state.text }).then(function (r) {
      state.busy[kind] = false;
      if (r.error) state.error = r.error; else state[kind] = r[kind];
      draw();
    });
  }
  function show(text) {
    text = Core.clean(text || '', Core.LIMITS.text).trim();
    state = {
      text: text, quick: text ? Core.scan(text) : null, busy: {}, hasKey: false,
      error: text ? null : 'Nothing to check: select some text on the page first, or use Check this page.',
      actions: {
        deep: function () { run('deep'); },
        originality: function () { run('originality'); },
        options: function () { api.runtime.openOptionsPage(); },
      },
    };
    draw();
    send({ type: 'settings' }).then(function (s) { state.hasKey = Boolean(s && s.hasKey); draw(); });
  }

  // Runs in the page: the selection, or the page's main text.
  function grab(mode) {
    var sel = String(window.getSelection() || '').trim();
    if (mode === 'selection') return sel;
    if (sel) return sel;
    var main = document.querySelector('article') || document.querySelector('main') || document.body;
    return String((main && main.innerText) || '').slice(0, 25000);
  }
  function fromTab(mode) {
    api.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab) return show('');
      return api.scripting.executeScript({ target: { tabId: tab.id }, func: grab, args: [mode] }).then(function (res) {
        show(res && res[0] ? res[0].result : '');
      });
    }).catch(function () { show(''); state.error = 'Tells cannot read this page (browser pages and the extension store are off limits).'; draw(); });
  }

  document.getElementById('sel').addEventListener('click', function () { fromTab('selection'); });
  document.getElementById('page').addEventListener('click', function () { fromTab('page'); });
  document.getElementById('opts').addEventListener('click', function () { api.runtime.openOptionsPage(); });
}());
