/* Glovebox - the buyer's page. The service history is everything after the
 * '#' in this page's address. Browsers never send that part to a server, so
 * this page makes NO request at all: it decodes the fragment here, runs it
 * through GloveboxCore.cleanReport (the same rules the owner's phone uses),
 * and draws it with every string escaped. A garbled, cut-short or hostile
 * link gets a kind sentence, never a broken page or anyone's markup.
 */
(function () {
  'use strict';
  var C = window.GloveboxCore;
  var main = document.getElementById('main');
  var units = null;
  var region = C.regionOf((navigator.languages && navigator.languages[0]) || navigator.language || 'en-US');

  function bad(msg) {
    main.innerHTML = '<div class="card empty"><div class="big" aria-hidden="true">🧾</div><p><b>' + C.esc(msg) + '</b></p>' +
      '<p class="muted small">Ask the person who sent it for the link again - the whole history is inside the link, so if part of it was cut off when it was copied, it can’t be read.</p>' +
      '<p><a class="btn ghost" href="./">What is Glovebox?</a></p></div>';
  }
  function draw(rep) {
    var u = units || rep.units;
    var other = u === 'mi' ? 'km' : 'mi';
    main.innerHTML = '<div class="noprint row spread" style="margin:6px 0 10px"><p class="small muted" style="margin:0">Shared from Glovebox. The history travels inside this link - it isn’t stored on any server.</p>' +
      '<div class="row"><button class="btn small ghost" type="button" id="unitBtn">Show in ' + (other === 'mi' ? 'miles' : 'km') + '</button><button class="btn small" type="button" id="printBtn">Print or save as PDF</button></div></div>' +
      '<article class="report print-me">' + C.reportHtml(rep, { units: u, region: region }) + '</article>' +
      '<p class="small muted center noprint" style="margin-top:18px">Keep your own car’s history the same way - free, on your phone: <a href="./">Glovebox</a>.</p>';
    document.getElementById('unitBtn').addEventListener('click', function () { units = other; draw(rep); });
    document.getElementById('printBtn').addEventListener('click', function () { window.print(); });
    var t = [rep.year, rep.make, rep.model].filter(Boolean).join(' ');
    document.title = 'Service history: ' + t + ' · Glovebox';
  }
  function open() {
    var frag = location.hash || '';
    if (!frag || frag === '#') return bad('This link has no service history in it.');
    C.decodeReport(frag).then(function (rep) {
      if (!rep) return bad('This service history link can’t be read.');
      draw(rep);
    }, function () { bad('This service history link can’t be read.'); });
  }
  window.addEventListener('hashchange', function () { units = null; open(); });
  open();
}());
