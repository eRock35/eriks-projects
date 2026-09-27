// "Check with Tells" - the bookmarklet, readable. lib/bookmarklet.js turns
// this one file into the javascript: link the page offers; test/run.js
// checks the served link decodes back to exactly this (minus comments).
//
// It reads the selection (or, with nothing selected, the page address) and
// OPENS Tells in a new tab with it in ?q=. It never fetches anything from the
// page it runs on: LinkedIn's and X's Content-Security-Policy would block a
// request to our API, but navigating to a new tab is always allowed. Tells
// then runs only the free quick scan; nothing that costs credit happens
// without a tap there.
(function () {
  var base = '__TELLS_BASE__';
  var max = 6800;
  var s = '';
  var cut = 0;
  try { s = String(window.getSelection() || '').trim(); } catch (e) { s = ''; }
  var q = s || String(location.href);
  var enc = function (v) { return encodeURIComponent(v.replace(/[\uD800-\uDBFF]$/, '')); };
  var e = enc(q);
  while (e.length > max && q.length > 1) { q = q.slice(0, Math.floor(q.length * 0.85)); cut = 1; e = enc(q); }
  var url = base + '?q=' + e + (cut ? '&cut=1' : '') + '&src=bm';
  var w = null;
  try { w = window.open(url, '_blank'); } catch (e2) { w = null; }
  if (!w) location.href = url;
})();
