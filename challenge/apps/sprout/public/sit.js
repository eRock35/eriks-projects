/* Sprout - the plant-sitter's page.
 *
 * The plan is in this page's URL FRAGMENT (everything after '#'). Browsers
 * never send a fragment to a server, so the server that served this page
 * never saw the plan - and this script never sends it anywhere either: it
 * makes no request at all. Anyone could have written the link, so it is
 * decoded defensively (SproutCore.decodeSit: size caps, a capped inflate,
 * strict JSON) and every field goes through SproutCore.cleanSit, the same
 * cleaner the owner's phone used. Every string is escaped before it is
 * drawn; nothing from the link is ever treated as markup.
 *
 * The sitter's ticks stay in their own browser (localStorage, keyed by a
 * hash of the link), and "Send a done update" goes out through their own
 * share sheet.
 */
(function () {
  'use strict';

  var C = window.SproutCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = C.esc, plural = C.plural;
  var TZ = (function () { try { return C.cleanTz(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) { return 'UTC'; } })();
  var sit = null, key = null, ticks = {};

  function today() { return C.localDate(Date.now(), TZ); }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function toast(msg) {
    var old = $('.toast'); if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'toast plain'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3000);
  }

  function emojiOf(p) { var c = C.catalogue(p.cat); return c ? c.emoji : '🪴'; }
  function kindOf(p) { var c = C.catalogue(p.cat); return c ? c.name : 'Houseplant'; }

  function broken() {
    $('#main').innerHTML = '<section class="card empty"><div class="big" aria-hidden="true">🥀</div><h1>This care sheet didn’t open</h1><p class="muted">The link looks incomplete or damaged - messaging apps sometimes cut long links short. Ask for it again, or ask them to copy the whole thing.</p><p><a class="btn" href="./">What is Sprout?</a></p></section>';
  }

  /** One plant to water on one day. `full` (today's card) carries how much;
   *  the day-by-day list stays slim and the amounts live under The plants. */
  function rowHtml(x, d, full) {
    var p = x.p, k = x.j + ':' + d.i, done = Boolean(ticks[k]);
    var c = C.catalogue(p.cat);
    return '<li><label class="tickrow' + (full ? '' : ' slim') + (done ? ' done' : '') + '"><input type="checkbox" data-tick="' + esc(k) + '"' + (done ? ' checked' : '') + '>' +
      '<span class="pe" aria-hidden="true">' + esc(emojiOf(p)) + '</span><span class="tb"><b class="tname">' + esc(p.nick) + '</b><span>' + esc(kindOf(p) + ' · ' + C.room(p.room).label) + '</span>' +
      (full ? '<span>' + esc(C.amountFor(p.pot, p.drain, c)) + '</span>' : '') + '</span></label></li>';
  }

  function draw() {
    var t = today();
    var dd = C.sitDays(sit);
    var nowRow = dd.days.filter(function (d) { return d.date === t; })[0];
    var drinks = dd.days.reduce(function (n, d) { return n + d.plants.length; }, 0);
    var html = '<section class="hero" style="text-align:left;padding-top:4px"><p class="eyebrow">Plant-sitting</p><h1 style="margin:4px 0 6px">' + (sit.from ? esc(sit.from) + '’s plants' : 'The plants') + ' 🌿</h1>' +
      '<p class="muted" style="margin:0">' + esc(C.dateLabel(sit.start, t)) + ' to ' + esc(C.dateLabel(sit.end, t)) + ' · ' + esc(plural(sit.plants.length, 'plant')) + ' · ' + esc(plural(drinks, 'drink')) + ' in all</p></section>';
    if (sit.note) html += '<p class="quote">' + esc(sit.note) + '</p>';

    if (nowRow) {
      html += '<section class="card"><h2>Today, ' + esc(C.dateLabel(t, t)) + '</h2>' + (nowRow.plants.length
        ? '<p class="small muted">Tick each one as you water it. Feel the soil first - if it’s still damp, skip it.</p><ul class="ticks">' + nowRow.plants.map(function (x) { return rowHtml(x, nowRow, true); }).join('') + '</ul>'
        : '<p>Nothing to water today. 🎉 Enjoy the peace.</p>') + '</section>';
    } else if (t < sit.start) {
      html += '<section class="card"><h2>Starts ' + esc(C.whenLabel(sit.start, t)) + '</h2><p class="muted">Nothing to do yet. Here’s the whole plan so you know what’s coming.</p></section>';
    } else {
      html += '<section class="card"><h2>All done - thank you! 🙏</h2><p class="muted">The trip is over. Send a last update so they know how it went.</p></section>';
    }
    html += '<div class="btns noprint"><button class="btn" type="button" data-act="share">Send a “done” update</button><button class="btn ghost" type="button" data-act="print">Print it</button></div>';

    html += '<section class="card"><h2>How to water</h2><ul class="steps"><li><span class="sn">1</span><span><b>Feel the soil first.</b> Push a finger in up to the first knuckle. Damp? Skip it today - more plants die from too much water than too little.</span></li>' +
      '<li><span class="sn">2</span><span><b>Water slowly</b> at the base, not over the leaves, until a little runs out of the bottom. Tip away what’s left in the saucer after ten minutes.</span></li>' +
      '<li><span class="sn">3</span><span><b>Room-temperature water</b> is kindest. A watering can or a jug both do.</span></li></ul></section>';

    html += '<section class="card"><h2>Day by day</h2>' + dd.days.map(function (d) {
      if (!d.plants.length) return '';
      var isToday = d.date === t;
      return '<div class="sitday"><h3>' + esc(C.dateLabel(d.date, t)) + (isToday ? ' <span class="today-tag">Today</span>' : '') + ' <span class="small muted">· ' + esc(plural(d.plants.length, 'plant')) + '</span></h3><ul class="ticks">' + d.plants.map(function (x) { return rowHtml(x, d, false); }).join('') + '</ul></div>';
    }).join('') + (drinks ? '' : '<p>Nothing needs water while they’re away.</p>') + '</section>';

    html += '<section class="card"><h2>The plants</h2>' + sit.plants.map(function (p) {
      var c = C.catalogue(p.cat);
      var lines = [];
      if (p.days.length) {
        lines.push('Water ' + plural(p.days.length, 'time') + ' (' + C.nameList(p.days.slice(0, 6).map(function (i) { return C.dateLabel(C.addDays(sit.start, i), today()).replace(/ [A-Z][a-z]+( \d{4})?$/, ''); })) + (p.days.length > 6 ? ' …' : '') + '). ' + C.SOIL[c ? c.soil : 'top'].check);
        lines.push('How much: ' + C.amountFor(p.pot, p.drain, c));
      } else lines.push('Leave it alone - it doesn’t need water while they’re away.');
      if (p.mist) lines.push('Likes humid air: a mist every couple of days is a nice extra, not a must.');
      if (c && c.soil === 'soak') lines.push(c.tip);
      if (p.note) lines.push('Note: ' + p.note);
      return '<div class="sitplant"><span class="pe" aria-hidden="true">' + esc(emojiOf(p)) + '</span><div class="tb"><b>' + esc(p.nick) + '</b> <span class="small muted">' + esc(kindOf(p) + ' · ' + C.room(p.room).label) + '</span>' +
        lines.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') + '</div></div>';
    }).join('') + '</section>';

    var leave = dd.leave;
    if (leave.length) html += '<section class="card"><h2>Leave these alone</h2><p>' + esc(C.nameList(leave.map(function (x) { return x.p.nick; }))) + ' - they’re fine until ' + (sit.from ? esc(sit.from) : 'the owner') + ' is back. Watering them “just in case” is the classic way to drown one.</p></section>';

    html += '<footer class="foot small muted"><p>Made with <a href="./">Sprout</a>. This plan lives in the link itself - after the “#”, which browsers never send to a server - so nothing about it is stored anywhere. Your ticks stay in this browser.</p></footer>';
    $('#main').innerHTML = html;
    document.title = (sit.from ? sit.from + '’s plants' : 'Plant-sitting') + ' · Sprout';
  }

  function load() {
    var frag = location.hash || '';
    C.decodeSit(frag).then(function (s) {
      if (!s) { sit = null; broken(); return; }
      sit = s;
      key = 'sprout-sit-' + C.hash32(frag).toString(36);
      var saved = recall(key);
      ticks = {};
      if (saved && typeof saved === 'object' && saved.ticks && typeof saved.ticks === 'object') {
        Object.keys(saved.ticks).forEach(function (k) { if (/^\d{1,2}:\d{1,2}$/.test(k) && saved.ticks[k] === true) ticks[k] = true; });
      }
      draw();
    });
  }

  document.addEventListener('change', function (e) {
    var k = e.target.getAttribute && e.target.getAttribute('data-tick');
    if (!k || !sit) return;
    if (e.target.checked) ticks[k] = true; else delete ticks[k];
    if (!keep(key, { ticks: ticks })) toast('This browser won’t keep ticks (private browsing?) - they last until you close the tab.');
    // Every row for this plant and day (today's card and the day list) moves together.
    Array.prototype.slice.call(document.querySelectorAll('input[data-tick]')).forEach(function (x) {
      if (x.getAttribute('data-tick') === k) { x.checked = Boolean(ticks[k]); x.closest('.tickrow').classList.toggle('done', Boolean(ticks[k])); }
    });
  });
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || !sit) return;
    var act = el.getAttribute('data-act');
    if (act === 'print') window.print();
    if (act === 'share') {
      var text = C.sitSummary(sit, ticks, today());
      if (navigator.share) navigator.share({ text: text }).catch(function () { /* cancelled */ });
      else (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast('Update copied - paste it into a message.'); }, function () { toast('Could not copy - your browser blocked it.'); });
    }
  });
  window.addEventListener('hashchange', load);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && sit) draw(); });
  load();
}());
