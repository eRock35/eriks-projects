/* The home page's script (site/index.html). One file, loaded with defer, so
 * the page carries no inline script. Everything here is an addition: with
 * this file missing or blocked the page still reads, links and posts its
 * signup form.
 *
 * In order: small page behaviour (the bar, the year count, the signup form),
 * the live previews, the Challenge band and lab cards (/api/lab), "Most used
 * this week" (/api/stats/public) and "Live now" (/api/activity). The last
 * two return at once while data-counts="off" sits on <html>.
 */
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.add("js");

  /* ---------- The bar: a hairline once the page has moved ---------- */
  var nav = document.getElementById("nav");
  if (nav) {
    var ticking = false;
    var onScroll = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        nav.classList.toggle("is-scrolled", (window.scrollY || 0) > 8);
        ticking = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ---------- Active section in the bar ---------- */
  // Tracks which sections are in the band across the middle of the screen
  // and redraws from that, so the underline also CLEARS - back at the hero
  // nothing is underlined. The Blog section lights "Blog".
  var links = {};
  document.querySelectorAll("[data-nav]").forEach(function (a) { links[a.dataset.nav] = a; });
  if ("IntersectionObserver" in window) {
    var sections = ["apps", "about", "writing", "contact"], inBand = {};
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { inBand[e.target.id] = e.isIntersecting; });
      var cur = null;
      sections.forEach(function (id) { if (inBand[id]) cur = id; });
      Object.keys(links).forEach(function (k) {
        links[k].classList.toggle("is-active", k === cur);
        if (k === cur) links[k].setAttribute("aria-current", "true"); else links[k].removeAttribute("aria-current");
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    sections.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) spy.observe(el);
    });
  }

  /* ---------- "Years at Equifax" stays current ---------- */
  document.querySelectorAll("[data-since]").forEach(function (el) {
    var n = new Date().getFullYear() - Number(el.dataset.since);
    if (isFinite(n) && n > 0) el.textContent = n + (el.dataset.suffix || "");
  });

  /* ---------- Subscribe ---------- */
  // The form posts on its own without JavaScript; this just keeps the reader
  // on the page and answers inline.
  var subForm = document.getElementById("subForm");
  if (subForm) {
    var subT = document.getElementById("subT");
    if (subT) subT.value = String(Date.now());
    subForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var input = document.getElementById("subEmail");
      var btn = document.getElementById("subBtn");
      var note = document.getElementById("subNote");
      var address = input.value.trim();
      if (!address) return;
      btn.disabled = true;
      note.className = "sub-note";
      note.textContent = "Signing you up…";
      try {
        var res = await fetch("/api/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: address, source: "landing", website: (document.getElementById("subWebsite") || {}).value || "", t: Number((document.getElementById("subT") || {}).value) || 0 })
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || "That did not work.");
        note.className = "sub-note ok";
        note.textContent = data.message || "Check your inbox to confirm.";
        input.value = "";
      } catch (err) {
        note.className = "sub-note error";
        // A TypeError is fetch failing to reach the server at all, and its
        // message is the browser's ("Failed to fetch", "Load failed").
        note.textContent = err instanceof TypeError
          ? "Couldn't reach the server. Check your connection and try again."
          : (err.message || "That did not work. Try again.");
      }
      btn.disabled = false;
    });
  }
})();

/* The live previews: each phone is the real app in a frame. */
(function () {
  "use strict";
  // Fade (and, for the strip, show an arrow on) the side that has more.
  function edgeFade(el) {
    var max = el.scrollWidth - el.clientWidth, f = "";
    if (max > 1) {
      if (el.scrollLeft > 1) f += "l";
      if (el.scrollLeft < max - 1) f += "r";
    }
    if (f) el.setAttribute("data-fade", f); else el.removeAttribute("data-fade");
  }
  var strip = document.getElementById("previewStrip");
  if (!strip || !("IntersectionObserver" in window)) return;
  var cards = Array.prototype.slice.call(strip.querySelectorAll(".preview"));
  var dots = document.getElementById("previewDots");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var how = reduce ? "auto" : "smooth";
  // Scroll the strip (only the strip - never the page) so a card is centred.
  function centre(card) {
    var s = strip.getBoundingClientRect(), c = card.getBoundingClientRect();
    strip.scrollBy({ left: (c.left + c.width / 2) - (s.left + s.width / 2), behavior: how });
  }
  cards.forEach(function (card) {
    var b = document.createElement("button");
    b.type = "button"; b.tabIndex = -1;
    b.addEventListener("click", function () { centre(card); });
    dots.appendChild(b);
  });
  document.querySelectorAll(".strip-nav").forEach(function (b) {
    b.addEventListener("click", function () { strip.scrollBy({ left: Number(b.dataset.dir) * strip.clientWidth * 0.8, behavior: how }); });
  });
  // Tabbing to a frame's link brings the frame into view; mandatory snap
  // otherwise pulls the strip back and leaves the focused frame off-screen.
  strip.addEventListener("focusin", function (e) {
    var c = e.target.closest(".preview");
    if (c) c.scrollIntoView({ inline: "center", block: "nearest", behavior: how });
  });

  // The app renders at 390px wide - what it was designed for - and is scaled
  // to whatever the phone frame happens to be. Re-fit on resize.
  function fit(card) {
    var screen = card.querySelector(".phone-screen"), frame = screen.querySelector("iframe");
    if (!frame) return;
    var k = screen.clientWidth / 390;
    frame.style.transform = "scale(" + k + ")";
    frame.style.height = Math.ceil(screen.clientHeight / k) + "px";
  }
  function load(card) {
    if (card.dataset.loaded) return;
    card.dataset.loaded = "1";
    var screen = card.querySelector(".phone-screen");
    var frame = document.createElement("iframe");
    frame.title = card.querySelector("figcaption b").textContent + " preview";
    frame.loading = "lazy";
    frame.referrerPolicy = "strict-origin";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.addEventListener("load", function () {
      frame.classList.add("in");
      var skel = screen.querySelector(".phone-skel");
      if (skel) skel.remove();
    });
    screen.appendChild(frame);
    fit(card);
    frame.src = card.dataset.src;
  }

  // Load a card when it is on screen or one card away - not the whole strip
  // at once, and not only when it is already centred (that would show a
  // cold start every swipe).
  var loader = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { load(e.target); loader.unobserve(e.target); } });
  }, { root: strip, rootMargin: "0px 60% 0px 60%", threshold: 0.01 });
  // That observer's root is the strip, so it measures against the strip's own
  // box and knows nothing about the viewport: on its own it loaded the first
  // cards on page load, below the fold, for visitors who never scrolled to
  // them. So it only starts once the strip itself reaches the screen.
  var gate = new IntersectionObserver(function (es) {
    if (!es.some(function (e) { return e.isIntersecting; })) return;
    gate.disconnect();
    cards.forEach(function (c) { loader.observe(c); });
  });
  gate.observe(strip);

  // The dots follow the card nearest the strip's centre, and the ends win at
  // the ends: on a wide screen several cards are fully visible at once, and
  // "most visible" then always picked the first of them.
  function sync() {
    var max = strip.scrollWidth - strip.clientWidth, best = 0;
    if (strip.scrollLeft >= max - 1 && max > 0) best = cards.length - 1;
    else if (strip.scrollLeft > 1) {
      var s = strip.getBoundingClientRect(), mid = s.left + s.width / 2, d = Infinity;
      cards.forEach(function (c, j) {
        var r = c.getBoundingClientRect(), k = Math.abs(r.left + r.width / 2 - mid);
        if (k < d) { d = k; best = j; }
      });
    }
    Array.prototype.forEach.call(dots.children, function (b, j) { b.classList.toggle("on", best === j); });
    edgeFade(strip);
  }
  var ticking = false;
  strip.addEventListener("scroll", function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; sync(); });
  }, { passive: true });
  sync();

  var t; window.addEventListener("resize", function () { clearTimeout(t); t = setTimeout(function () { cards.forEach(fit); sync(); }, 120); });
})();

/* The Challenge banner, live: the lab's latest drop, how many apps are live,
 * and the countdown to the next drop.
 *
 * The lab is another service (challenge/ in this repo), so this is additive
 * and fails quietly. Its /api/lab allows this page's two origins by CORS, and
 * the request carries no cookies: the lab's CORS does not allow credentials,
 * and the banner has no use for a visitor's own votes (the lab mints its vote
 * cookie only on its own page or on a vote). Until it answers the tile keeps
 * its place with its contents out of sight; after FALLBACK_MS the copy in the
 * markup is shown, which carries no numbers, and a late answer still replaces
 * it. Every field is set with textContent, never as markup.
 *
 * The same answer keeps the "New in the Lab" cards honest ([data-lab] in the
 * markup, which carries the lab's own name, emoji, colours and tagline as
 * written on 2026-11-22): each card is refreshed from the lab, and a card
 * whose app is retired, gone or not up is taken away rather than left as a
 * link to nothing. With no answer the cards stay as authored.
 *
 * A tab left open past 09:00 UTC, or brought back from memory the next day,
 * asks again once a drop has landed since the last answer, so the tile never
 * names yesterday's drop beside today's countdown. The old tile stays until
 * the new answer draws; if that answer never comes, the tile goes back to the
 * copy in the markup rather than keep an old "Latest drop".
 */
(function () {
  'use strict';
  var LAB = 'https://challenge.strongtechnicalconsulting.com';
  var FALLBACK_MS = 1500, GIVE_UP_MS = 6000, DAY = 864e5;
  var live = document.getElementById('cbLive');
  if (!live) return;
  function $(id) { return document.getElementById(id); }
  function show(s) { live.setAttribute('data-state', s); }
  function state() { return live.getAttribute('data-state'); }
  var fallback = setTimeout(function () { if (state() === 'wait') show('static'); }, FALLBACK_MS);
  var FIELDS = ['cbEm', 'cbK', 'cbName', 'cbTag', 'cbCount'], MARKUP = null;
  // Back to the copy in the markup: no numbers, nothing that can go stale.
  function plain() {
    if (!MARKUP) return;
    $('cbDrop').setAttribute('href', MARKUP.href);
    FIELDS.forEach(function (id) { $(id).textContent = MARKUP[id]; });
    $('cbEm').style.removeProperty('--c1'); $('cbEm').style.removeProperty('--c2');
  }
  function fail() {
    clearTimeout(fallback);
    if (state() === 'live') plain();
    show('static');
  }

  try {
    MARKUP = { href: $('cbDrop').getAttribute('href') };
    FIELDS.forEach(function (id) { MARKUP[id] = $(id).textContent; });

    // The next drop is 09:00 UTC every day - the lab's own countdown.
    // lastDrop(t) is the most recent one at or before t: the drop that a
    // "Latest drop" answer was true under.
    var lastDrop = function (t) {
      var d = new Date(t), at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9);
      return at > t ? at - DAY : at;
    };
    var loadedFor = null, seq = 0, load;
    var next = $('cbNext');
    var tick = function () {
      var now = Date.now(), at = lastDrop(now) + DAY;
      var mins = Math.max(1, Math.ceil((at - now) / 6e4)), h = Math.floor(mins / 60), m = mins % 60;
      next.textContent = 'Next drop in ' + (h ? h + 'h ' + (m < 10 ? '0' : '') + m + 'm' : m + 'm');
      if (loadedFor !== null && lastDrop(now) !== loadedFor) load();
    };

    var SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/, HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
    var clean = function (v, max) {
      return Array.from(String(v == null ? '' : v).replace(/\s+/g, ' ').trim()).slice(0, max).join('');
    };
    // A graduated app lives on its own subdomain; anything else, or anything
    // that is not a plain https address on this domain, opens in the lab.
    var hrefFor = function (a) {
      if (a.status === 'graduated' && a.home) {
        try {
          var u = new URL(a.home);
          if (u.protocol === 'https:' && /(^|\.)strongtechnicalconsulting\.com$/.test(u.hostname)) return u.href;
        } catch (e) {}
      }
      return SLUG.test(a.slug) ? LAB + '/' + a.slug + '/' : LAB + '/';
    };
    // The lab's own rule for "can be opened" (challenge/public/lab.js): an
    // app whose server failed to mount is listed but not live, and the lab
    // shows it as "Warming up" rather than a link. The banner neither counts
    // it nor headlines it.
    var up = function (a) { return a.live === true || a.status === 'graduated'; };
    var cards = function (apps) {
      var by = {};
      apps.forEach(function (a) { if (SLUG.test(a.slug)) by[a.slug] = a; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-lab]'), function (el) {
        var a = by[el.getAttribute('data-lab')];
        if (!a || !up(a)) { el.hidden = true; return; }
        el.hidden = false;
        el.setAttribute('href', hrefFor(a));
        var name = el.querySelector('[data-lab-name]'), tag = el.querySelector('[data-lab-tag]'), em = el.querySelector('[data-lab-em]');
        if (name) name.textContent = clean(a.name, 60);
        if (tag && clean(a.tagline, 1)) tag.textContent = clean(a.tagline, 160);
        if (em) {
          if (clean(a.emoji, 1)) em.textContent = clean(a.emoji, 8);
          if (HEX.test(a.color) && HEX.test(a.color2)) { em.style.setProperty('--c1', a.color); em.style.setProperty('--c2', a.color2); }
        }
      });
    };
    var draw = function (all) {
      // The list is oldest first. Retired apps are neither counted nor shown,
      // but keep their place in the numbering, as on /challenge, so killing
      // one never renumbers the rest.
      var apps = all.filter(function (a) { return a && typeof a === 'object' && a.status !== 'retired' && clean(a.name, 1); });
      var live = apps.filter(up);
      cards(apps);
      if (!live.length) return false;
      // The newest app that is up. When today's drop is still warming up, the
      // one before it takes the tile rather than a link to a 404.
      var a = live[live.length - 1], n = all.indexOf(a) + 1;
      var newest = a === apps[apps.length - 1];
      $('cbDrop').href = hrefFor(a);
      $('cbEm').textContent = clean(a.emoji, 8) || '\u{1F9EA}';
      var em = $('cbEm').style;
      if (HEX.test(a.color) && HEX.test(a.color2)) { em.setProperty('--c1', a.color); em.setProperty('--c2', a.color2); }
      else { em.removeProperty('--c1'); em.removeProperty('--c2'); }
      $('cbK').textContent = (newest ? 'Latest drop' : 'In the lab') + ' · #' + (n < 10 ? '0' : '') + n;
      $('cbName').textContent = clean(a.name, 60);
      $('cbTag').textContent = clean(a.tagline, 160);
      $('cbCount').textContent = live.length + (live.length === 1 ? ' app live' : ' apps live');
      return true;
    };

    // One question per drop. Only the latest one asked may draw or fail, so a
    // slow answer from before 09:00 cannot overwrite a newer one.
    load = function () {
      var mine = ++seq;
      loadedFor = lastDrop(Date.now());
      var ctl = window.AbortController ? new AbortController() : null;
      var giveUp = setTimeout(function () { if (ctl) ctl.abort(); }, GIVE_UP_MS);
      fetch(LAB + '/api/lab', { mode: 'cors', credentials: 'omit', signal: ctl ? ctl.signal : undefined })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          clearTimeout(giveUp);
          if (mine !== seq) return;
          if (d && Array.isArray(d.apps) && draw(d.apps)) { clearTimeout(fallback); show('live'); }
          else fail();
        })
        .catch(function () { clearTimeout(giveUp); if (mine === seq) fail(); });
    };

    tick();
    setInterval(tick, 15000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    window.addEventListener('pageshow', function (e) { if (e.persisted) tick(); });
    if (!window.fetch) { fail(); return; }
    load();
  } catch (e) { fail(); }
})();

/* What's trending, labelled rather than re-sorted.
 *
 * The counts live on this service (see lib/views.js and beacon.js).
 * The prompt-library version of this page re-ORDERED the cards by rank; that
 * fights this page, whose cards carry staggered CSS reveal delays written
 * into the markup, so reordering would make them flash in at the wrong times
 * and the order would change under a returning reader for no reason they can
 * see. Labelling says the same thing and keeps both.
 *
 * Everything here is additive and failure is silent: this is a static page
 * and the counter is another service. If the fetch never lands, the cards
 * read exactly as they do now.
 */
(function () {
  'use strict';
  if (document.documentElement.getAttribute('data-counts') === 'off') return;
  var STATS = '/api/stats/public';   // same origin: the counter lives here now
  function n(v) { return Number(v || 0).toLocaleString(); }
  // Labels and URLs come from the counter's own allowlist, not from this page,
  // so they are data rather than markup and get escaped like any other.
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  try {
    fetch(STATS, { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !Array.isArray(d.apps)) return;

        // The ranked strip. Three filters, each for its own reason:
        //  - this page itself is left out. Every visitor arrives here first,
        //    so it would sit at #1 every week and say nothing; the strip is
        //    about the apps. The whole picture is on /admin/views.
        //  - an app with no views is left out rather than listed at zero.
        //  - and nothing is drawn at all below two rows, because a ranking of
        //    one is not a ranking.
        //  - ranked, drawn and scaled on ONE number, this week's: an app with
        //    no views this week is not "most used this week", and one big
        //    all-time count would shrink every weekly bar beside it.
        var seen = d.apps.filter(function (a) {
          return a.app !== 'landing' && Number(a.views7) > 0;
        }).sort(function (a, b) { return b.views7 - a.views7; });
        if (seen.length > 1) {
          var top = Math.max.apply(null, seen.map(function (a) { return a.views7; }));
          // Seven days, because that is the window the numbers below are from
          // (views7) - not d.days, which is how long the sparkline series is.
          document.getElementById('trendWhen').textContent =
            'Last 7 days \u00b7 counted first-party';
          document.getElementById('trendList').innerHTML = seen.map(function (a, i) {
            var v = a.views7;
            var pct = Math.max(6, Math.round((v / top) * 100));
            // The row opens what the app's card opens - for Friction, the
            // public /preview rather than the counter's URL, which is its
            // signed-in board and a sign-in page to everyone else.
            var card = document.querySelector('a.project[data-app="' + a.app + '"]');
            var href = card ? card.getAttribute('href') : a.url;
            return '<li><a href="' + esc(href) + '" style="--w:' + pct + '%">'
              + '<span class="tl-rank">' + (i + 1) + '</span>'
              + '<span class="tl-name">' + esc(a.icon || '') + ' ' + esc(a.label) + '</span>'
              + '<span class="tl-n">' + n(v) + '</span>'
              + '</a></li>';
          }).join('');
          document.getElementById('trendBar').hidden = false;
        }

        // `rank` is the rank across everything the counter tracks, and #1 is
        // always this page - so keying the badge off it meant no app card
        // would ever carry it. The badge belongs to the busiest APP this
        // week, and to nobody in a week with no views. Nor to anybody in a tie
        // or when only one app has views: the server breaks views7 ties on
        // all-time totals, which carry the old preview-frame inflation for
        // good (see lib/views.js), so first place in a tie is not earned.
        var leader = (seen.length > 1 && seen[0].views7 > seen[1].views7) ? seen[0].app : null;

        d.apps.forEach(function (a) {
          var card = document.querySelector('a.project[data-app="' + a.app + '"]');
          if (!card) return;
          // A view count nobody has earned yet reads as a dead app. Say
          // nothing until there is something to say. Weekly only: the
          // all-time total counted landing-page previews until each app
          // shipped the 2026-09-25 beacon, and a card saying "N views" beside others saying "N views this
          // week" mixed two different numbers.
          if (!a.views7) return;
          var h3 = card.querySelector('h3');
          if (a.app === leader && h3 && !h3.querySelector('.trending')) {
            var b = document.createElement('span');
            b.className = 'trending';
            b.textContent = 'Trending';
            h3.appendChild(b);
          }
          var body = card.querySelector('.project-body');
          if (!body || body.querySelector('.views')) return;
          var v = document.createElement('span');
          v.className = 'views';
          v.textContent = n(a.views7) + ' views this week';
          body.appendChild(v);
        });
      })
      .catch(function () {});
  } catch (e) {}
})();

/* Live now, and the Keep or kill standings in the Challenge banner.
 *
 * Both come from one same-origin call, /api/activity (lib/activity.js), which
 * the server answers from a 15-second memory - so this page can ask every 30
 * seconds and it costs next to nothing. It asks only while the tab is
 * visible: a hidden tab's timer is cleared, and coming back asks at once if
 * the last answer is older than the interval.
 *
 * Nothing on the page moves because of it:
 *  - the strip is one sideways-scrolling row, so one line or six are the same
 *    height, and a refresh keeps where the row was scrolled to;
 *  - while the first answer is on its way the strip holds its place with
 *    blank pills; if it is empty or does not come, the strip is removed;
 *  - after that, the strip appears or goes only while its place is below the
 *    bottom of the screen, where nothing a reader is looking at can shift;
 *  - the standings box is the same size whatever it shows.
 * A failed poll is never shown: the last good lines stay, and after four
 * misses in a row (two minutes) the strip goes when it is out of sight.
 * Every string from the server is escaped; links must be https on this
 * domain or they are not links.
 */
(function () {
  'use strict';
  if (document.documentElement.getAttribute('data-counts') === 'off') return;
  var feed = document.getElementById('liveFeed'), list = document.getElementById('lfList');
  var board = document.getElementById('cbBoard');
  if (!feed || !list) return;
  var POLL = 30000, GIVE_UP = 8000, STATIC_AFTER = 2500, MISSES = 4;
  var timer = null, lastAsk = 0, seq = 0, misses = 0, lastFeed = '', lastBoard = '';

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clean(v, max) { return Array.from(String(v == null ? '' : v).replace(/\s+/g, ' ').trim()).slice(0, max).join(''); }
  function safeHref(u) {
    try {
      var x = new URL(String(u));
      if (x.protocol === 'https:' && /(^|\.)strongtechnicalconsulting\.com$/.test(x.hostname)) return x.href;
    } catch (e) {}
    return null;
  }
  function num(v) { var n = Number(v); return isFinite(n) && n >= 0 ? Math.floor(n) : 0; }

  /* ---------- the strip ---------- */
  function state() { return feed.getAttribute('data-state'); }
  // Where the strip is (or would be): below the screen means a change there
  // shifts nothing anyone can see.
  function outOfSight() {
    var el = state() === 'gone' ? feed.nextElementSibling : feed;
    if (!el) return true;
    return el.getBoundingClientRect().top >= (window.innerHeight || document.documentElement.clientHeight);
  }
  function drawFeed(items) {
    var html = items.map(function (it) {
      var href = safeHref(it.href);
      var name = clean(it.name, 40), text = clean(it.text, 110), when = clean(it.when, 24), icon = clean(it.icon, 4);
      // The when is a second line, so a narrow screen cuts neither.
      var inner = '<span class="lf-ic" aria-hidden="true">' + esc(icon) + '</span>'
        + '<span class="lf-body"><span class="lf-tx"><b>' + esc(name) + '</b> ' + esc(text) + '</span>'
        + (when ? '<span class="lf-when"><span class="sr">, </span>' + esc(when) + '</span>' : '') + '</span>';
      var title = esc(name + ' ' + text + (when ? ' · ' + when : ''));
      return '<li>' + (href
        ? '<a class="lf-item" href="' + esc(href) + '" title="' + title + '" target="_blank" rel="noopener">' + inner + '</a>'
        : '<span class="lf-item" title="' + title + '">' + inner + '</span>') + '</li>';
    }).join('');
    if (html === lastFeed) return;
    var x = list.scrollLeft;
    list.innerHTML = html;
    list.scrollLeft = x;
    lastFeed = html;
  }
  function usable(items) {
    return Array.isArray(items) ? items.filter(function (it) { return it && typeof it === 'object' && clean(it.name, 1) && clean(it.text, 1); }).slice(0, 6) : [];
  }
  function onFeed(items) {
    var s = state();
    if (items.length) {
      misses = 0;
      if (s === 'gone' && !outOfSight()) return;   // wait for it to be off screen
      drawFeed(items);
      feed.setAttribute('data-state', 'live');
    } else if (s === 'wait') {
      feed.setAttribute('data-state', 'gone');
    } else if (s === 'live' && outOfSight()) {
      feed.setAttribute('data-state', 'gone');
      lastFeed = '';
    }
  }
  function onFail() {
    misses += 1;
    var s = state();
    if (s === 'wait' || (s === 'live' && misses >= MISSES && outOfSight())) { feed.setAttribute('data-state', 'gone'); lastFeed = ''; }
    if (board && board.getAttribute('data-state') === 'wait') board.setAttribute('data-state', 'static');
  }

  /* ---------- the standings ---------- */
  var HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  function drawBoard(b) {
    if (!board) return;
    var bl = document.getElementById('cbBl'), bk = document.getElementById('cbBk'), bs = document.getElementById('cbBs');
    var apps = (b && Array.isArray(b.apps) ? b.apps : []).filter(function (a) { return a && typeof a === 'object' && clean(a.name, 1); }).slice(0, 3);
    var any = b && b.anyVotes === true && apps.some(function (a) { return num(a.votes) > 0; });
    if (!apps.length || !any) {
      bs.textContent = apps.length ? 'No votes yet. Be the first to keep or kill a drop.' : '\u{1F525} Keep or \u{1F480} kill: vote on every drop in the lab.';
      bk.textContent = 'Keep or kill';
      board.setAttribute('data-state', 'static');
      return;
    }
    var leader = null;
    var html = apps.map(function (a, i) {
      // Rank and votes only: the lab publishes no keep % (a split is shown
      // only in the lab, to someone who has voted on that app).
      var votes = num(a.votes);
      var isLead = b.leader && a.slug === b.leader && i === 0;
      if (isLead) leader = clean(a.name, 30);
      var line = votes
        ? '<b>' + votes + '</b> vote' + (votes === 1 ? '' : 's') + (isLead ? '<span class="cb-w"> · leads</span>' : '')
        : 'no votes yet';
      return '<li class="cb-bc' + (isLead ? ' lead' : '') + '">'
        + '<span class="cb-bn"><span class="cb-br">' + (i + 1) + '</span>' + esc(clean(a.emoji, 4)) + ' ' + esc(clean(a.name, 30)) + '</span>'
        + '<span class="cb-bp">' + line + '</span>'
        + '</li>';
    });
    // Always three cells, so the box keeps its height with fewer apps.
    while (html.length < 3) html.push('<li class="cb-bc" aria-hidden="true"><span class="cb-bn">&nbsp;</span><span class="cb-bp">&nbsp;</span></li>');
    var joined = html.join('');
    bk.textContent = leader ? 'Keep or kill · ' + leader + ' leads now' : 'Keep or kill · standings';
    if (joined !== lastBoard) { bl.innerHTML = joined; lastBoard = joined; }
    board.setAttribute('data-state', 'live');
  }
  if (board) setTimeout(function () { if (board.getAttribute('data-state') === 'wait') board.setAttribute('data-state', 'static'); }, STATIC_AFTER);

  /* ---------- asking ---------- */
  function schedule(ms) {
    clearTimeout(timer);
    if (document.hidden) return;
    timer = setTimeout(ask, Math.max(0, ms));
  }
  function ask() {
    clearTimeout(timer);
    if (document.hidden) return;
    var mine = ++seq;
    lastAsk = Date.now();
    var ctl = window.AbortController ? new AbortController() : null;
    var giveUp = setTimeout(function () { if (ctl) ctl.abort(); }, GIVE_UP);
    fetch('/api/activity', { credentials: 'omit', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        clearTimeout(giveUp);
        if (mine !== seq) return;
        if (!d || typeof d !== 'object') { onFail(); return; }
        onFeed(usable(d.items));
        if (d.board) drawBoard(d.board);
        else if (board && board.getAttribute('data-state') === 'wait') board.setAttribute('data-state', 'static');
      })
      .catch(function () { clearTimeout(giveUp); if (mine === seq) onFail(); })
      .then(function () { if (mine === seq) schedule(POLL); });
  }
  function wake() {
    if (document.hidden) { clearTimeout(timer); return; }
    var since = Date.now() - lastAsk;
    if (since >= POLL) ask(); else schedule(POLL - since);
  }
  // Sideways fade on the side that has more, like the nav row.
  function fade() {
    var max = list.scrollWidth - list.clientWidth, x = list.scrollLeft;
    var f = (x > 2 ? 'l' : '') + (x < max - 2 ? 'r' : '');
    if (f) list.setAttribute('data-fade', f); else list.removeAttribute('data-fade');
  }
  list.addEventListener('scroll', fade, { passive: true });
  window.addEventListener('resize', fade);
  if (window.MutationObserver) new MutationObserver(fade).observe(list, { childList: true });

  try {
    if (!window.fetch) { onFail(); return; }
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', function (e) { if (e.persisted) wake(); });
    ask();
  } catch (e) { onFail(); }
})();
