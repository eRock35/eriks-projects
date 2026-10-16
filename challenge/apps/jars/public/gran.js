/* Jars - the grandparents' page. The snapshot is everything after the '#'
 * in this page's address. Browsers never send that part to a server, so
 * this page makes NO request at all: it decodes the fragment here, runs it
 * through JarsCore.cleanSnapshot (the same rules the parent's phone uses),
 * and draws it with every string escaped. A garbled, cut-short or hostile
 * link gets a kind sentence, never a broken page or anyone's markup.
 *
 * It also writes a GIFT NOTE: "I'm sending £10 for Maya". The note is a
 * short code the grandparent sends back to the parent (through their own
 * share sheet, or copied); it is never money, and says so. Nothing is
 * stored here - not in this browser, not on a server.
 */
(function () {
  'use strict';
  var C = window.JarsCore;
  var main = document.getElementById('main');
  var LOCALE = (navigator.languages && navigator.languages[0]) || navigator.language || 'en-US';
  var TZ = (function () { try { return C.cleanTz(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) { return 'UTC'; } })();
  var esc = C.esc;
  var base = location.href.split('#')[0].replace(/gran(\.html)?$/, '');

  function bad(msg) {
    main.innerHTML = '<div class="card center"><p class="bigemoji" aria-hidden="true">🫙</p><p><b>' + esc(msg) + '</b></p>' +
      '<p class="muted small">Ask for the link again - the whole snapshot is inside the link, so if part of it was cut off when it was copied, it can’t be read.</p>' +
      '<p><a class="btn ghost" href="./">What is Jars?</a></p></div>';
  }
  function giftForm(snap) {
    var into = 'split';
    var box = document.getElementById('giftBox');
    function draw() {
      box.innerHTML = '<h2>🎁 Send ' + esc(snap.name) + ' a gift note</h2>' +
        '<p class="small muted">Sending pocket money or a birthday gift? Write a note here and send it to ' + esc(snap.name) + '’s grown-up. <b>It’s a note, not a payment: no money moves through Jars.</b> Give the money the way you always do - cash, a card, a transfer to the parent - and they add it to the jars.</p>' +
        '<form id="giftForm">' +
        '<div class="two"><label class="field"><span>From</span><input class="input" name="from" maxlength="20" placeholder="Grandma" autocomplete="off"></label>' +
        '<label class="field"><span>How much? <small>(' + esc(snap.currency) + ')</small></span><input class="input money" name="amount" inputmode="decimal" autocomplete="off" required></label></div>' +
        '<fieldset class="field"><legend>For which jar?</legend><div class="seg" role="radiogroup" aria-label="Which jar">' + C.GIFT_INTO.map(function (j) {
          return '<button class="segb" type="button" role="radio" data-into="' + j + '" aria-checked="' + (into === j) + '">' + (j === 'split' ? 'Their usual split' : C.JAR_ICON[j] + ' ' + C.JAR_LABEL[j]) + '</button>';
        }).join('') + '</div></fieldset>' +
        '<label class="field"><span>A message <small>(optional)</small></span><input class="input" name="message" maxlength="140" placeholder="For the LEGO set - love you!"></label>' +
        '<p class="err" id="giftErr" role="alert"></p><button class="btn block" type="submit">Make the note</button></form><div id="giftOut"></div>';
      Array.prototype.forEach.call(box.querySelectorAll('[data-into]'), function (b) {
        b.addEventListener('click', function () {
          into = b.getAttribute('data-into');
          Array.prototype.forEach.call(box.querySelectorAll('[data-into]'), function (x) { x.setAttribute('aria-checked', String(x === b)); });
        });
      });
      document.getElementById('giftForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target;
        var code;
        try {
          code = C.makeGift({ kid: snap.name, amount: f.amount.value, currency: snap.currency, into: into, message: f.message.value, from: f.from.value, today: C.localDate(Date.now(), TZ) });
        } catch (err) { document.getElementById('giftErr').textContent = err.message; return; }
        document.getElementById('giftErr').textContent = '';
        var link = base + '#gift/' + code;
        var g = C.readGift(code);
        var text = (g.from ? g.from + ' is' : 'I’m') + ' sending ' + C.money(g.amount, g.currency, LOCALE) + ' for ' + snap.name + (g.message ? ' - “' + g.message + '”' : '') + '. Open this on the phone with ' + snap.name + '’s jars to add it: ' + link;
        var out = document.getElementById('giftOut');
        out.innerHTML = '<div class="okbox" style="margin-top:14px">Your note is ready. Send it to ' + esc(snap.name) + '’s grown-up - and give the money the usual way.</div>' +
          '<p class="linkbox" style="margin-top:10px">' + esc(text) + '</p>' +
          '<div class="btns">' + (navigator.share ? '<button class="btn" type="button" id="giftShare">Send it…</button>' : '') + '<button class="btn ghost" type="button" id="giftCopy">Copy it</button></div>';
        var sh = document.getElementById('giftShare');
        if (sh) sh.addEventListener('click', function () { navigator.share({ title: 'A gift note for ' + snap.name, text: text }).catch(function () { /* cancelled */ }); });
        document.getElementById('giftCopy').addEventListener('click', function () {
          var btn = this;
          (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { btn.textContent = 'Copied'; }, function () { btn.textContent = 'Select it and copy by hand'; });
        });
      });
    }
    draw();
  }
  function show(snap) {
    main.innerHTML = '<p class="small muted" style="margin:6px 0 10px">Shared from Jars. This snapshot travels inside the link - it isn’t stored on any server.</p>' +
      '<article class="snap">' + C.snapshotHtml(snap, { locale: LOCALE }) + '</article>' +
      '<section class="card" id="giftBox"></section>' +
      '<p class="small muted center" style="margin-top:18px">Pocket money in three jars - spend, save, give. Free, on the parent’s phone: <a href="./">Jars</a>.</p>';
    document.title = snap.name + '’s jars · Jars';
    giftForm(snap);
  }
  function open() {
    var frag = location.hash || '';
    if (!frag || frag === '#') return bad('This link has no jars in it.');
    C.decodeSnapshot(frag).then(function (snap) {
      if (!snap) return bad('This link can’t be read.');
      show(snap);
    }, function () { bad('This link can’t be read.'); });
  }
  window.addEventListener('hashchange', open);
  open();
}());
