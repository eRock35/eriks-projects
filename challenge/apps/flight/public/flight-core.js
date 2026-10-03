/* Flight - the rules, in one file run three times: by the server (which
 * stores and masks), by the page (which draws, and plays the example crew
 * without a server), and by the tests. UMD: window.FlightCore in the page,
 * require() in node.
 *
 * Everything here is deterministic. A crew's results, awards and
 * leaderboard are worked out from the stored scores on every read - never
 * stored, never random - so every phone in the room (or in four cities)
 * sees the same numbers, and deleting a session takes its points with it.
 *
 * Stars are stored as numbers in half steps (0.5 .. 5) and summed as
 * half-units (whole numbers), so no average is ever off by a float.
 * ABV is stored to one decimal and compared in tenths, for the same reason.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlightCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    crewName: 40, title: 60, memberName: 20, members: 20,
    beers: 8, beersPerMember: 2, homeBeers: 20,
    beerName: 60, brewery: 50, note: 140, city: 40, chips: 6,
    pollQuestion: 80, pollOption: 80, pollOptions: 12,
    sessionsPerCrew: 100, pollsPerCrew: 30,
    windowMinMs: 60 * 60 * 1000, windowMaxMs: 14 * 24 * 60 * 60 * 1000,
    abvMax: 20,
    // Cellar & Swap.
    haves: 60, wants: 60, itemCount: 99, link: 300, swapWhere: 80, swapLines: 6,
    swapsOpen: 30, swapsKept: 200, giftsKept: 120, squaresKept: 120, feed: 12, matches: 20,
  };

  var POINTS = { styleExact: 3, styleFamily: 1, abvClosest: 2, whoBrought: 2, award: 2 };

  /* ------------------------------------------------------------------ *
   * Styles: a fixed list in families. A guess of the exact style scores 3,
   * one in the same family 1. Non-alcoholic beers are a family of their
   * own - first-class, not a footnote.
   * ------------------------------------------------------------------ */

  var FAMILIES = [
    { id: 'lager', name: 'Lagers' },
    { id: 'hybrid', name: 'Hybrids' },
    { id: 'pale', name: 'Pale & amber ales' },
    { id: 'ipa', name: 'IPAs' },
    { id: 'wheat', name: 'Wheat beers' },
    { id: 'belgian', name: 'Belgian styles' },
    { id: 'sour', name: 'Sours & wild' },
    { id: 'dark', name: 'Porters & stouts' },
    { id: 'strong', name: 'Strong & barrel-aged' },
    { id: 'na', name: 'Non-alcoholic' },
  ];
  var STYLES = [
    ['pilsner', 'Pilsner', 'lager'], ['helles', 'Helles', 'lager'], ['light-lager', 'Light lager', 'lager'],
    ['mexican-lager', 'Mexican lager', 'lager'], ['marzen', 'Märzen / Oktoberfest', 'lager'], ['dunkel', 'Dunkel', 'lager'],
    ['bock', 'Bock', 'lager'],
    ['kolsch', 'Kölsch', 'hybrid'], ['cream-ale', 'Cream ale', 'hybrid'], ['altbier', 'Altbier', 'hybrid'],
    ['blonde', 'Blonde ale', 'pale'], ['apa', 'American pale ale', 'pale'], ['bitter', 'English bitter / ESB', 'pale'],
    ['amber', 'Amber / red ale', 'pale'], ['brown', 'Brown ale', 'pale'],
    ['ipa', 'American IPA', 'ipa'], ['west-coast', 'West Coast IPA', 'ipa'], ['hazy', 'Hazy IPA', 'ipa'],
    ['dipa', 'Double IPA', 'ipa'], ['session-ipa', 'Session IPA', 'ipa'], ['black-ipa', 'Black IPA', 'ipa'],
    ['hefeweizen', 'Hefeweizen', 'wheat'], ['witbier', 'Witbier', 'wheat'], ['american-wheat', 'American wheat', 'wheat'],
    ['saison', 'Saison', 'belgian'], ['dubbel', 'Dubbel', 'belgian'], ['tripel', 'Tripel', 'belgian'], ['quad', 'Quad / dark strong', 'belgian'],
    ['gose', 'Gose', 'sour'], ['berliner', 'Berliner weisse', 'sour'], ['fruited-sour', 'Fruited sour', 'sour'], ['wild', 'Wild ale / lambic', 'sour'],
    ['porter', 'Porter', 'dark'], ['stout', 'Dry stout', 'dark'], ['milk-stout', 'Milk stout', 'dark'], ['oatmeal-stout', 'Oatmeal stout', 'dark'],
    ['imperial-stout', 'Imperial stout', 'strong'], ['barleywine', 'Barleywine', 'strong'], ['wee-heavy', 'Wee heavy', 'strong'], ['barrel-aged', 'Barrel-aged', 'strong'],
    ['na-lager', 'NA lager', 'na'], ['na-ipa', 'NA IPA', 'na'], ['na-wheat', 'NA wheat', 'na'], ['na-dark', 'NA stout / porter', 'na'],
  ].map(function (r) { return { id: r[0], name: r[1], family: r[2] }; });
  var OTHER = { id: 'other', name: 'Something else', family: null };
  var STYLE_BY_ID = {};
  STYLES.forEach(function (s) { STYLE_BY_ID[s.id] = s; });
  STYLE_BY_ID.other = OTHER;
  var STYLE_IDS = STYLES.map(function (s) { return s.id; });
  // What "rated IPAs highest" means for the Hop Head award.
  var HOPPY = { 'na-ipa': true };
  STYLES.forEach(function (s) { if (s.family === 'ipa') HOPPY[s.id] = true; });

  function styleName(id) { return (STYLE_BY_ID[id] || OTHER).name; }
  function familyOf(id) { return STYLE_BY_ID[id] ? STYLE_BY_ID[id].family : null; }
  function familyName(id) { for (var i = 0; i < FAMILIES.length; i++) if (FAMILIES[i].id === id) return FAMILIES[i].name; return ''; }

  /** Style points for one guess: 3 exact, 1 same family, 0 otherwise. A beer
   *  whose style is "something else" (or not given) scores nobody. */
  function stylePoints(guess, actual) {
    if (!guess || !actual || actual === 'other' || !STYLE_BY_ID[actual] || !STYLE_BY_ID[guess]) return 0;
    if (guess === actual) return POINTS.styleExact;
    var f = familyOf(actual);
    return f && familyOf(guess) === f ? POINTS.styleFamily : 0;
  }

  var CHIPS = ['hoppy', 'malty', 'sour', 'roasty', 'fruity', 'crisp', 'boozy', 'funky', 'bitter', 'sweet', 'juicy', 'dry', 'smooth', 'smoky', 'spicy', 'light'];

  // Avatars: a fixed set, so a name is never the only thing telling two
  // people apart and nobody can put markup in one.
  var EMOJI = ['🦊', '🐙', '🌵', '🌶️', '🐻', '🦉', '🐢', '🦄', '🐝', '🍕', '🎸', '🚲', '⚡', '🌊', '🍀', '🔥', '🎯', '🧢', '🐸', '🦖', '🌻', '🍋', '🎲', '🛶'];

  /* ------------------------------------------------------------------ *
   * Text
   * ------------------------------------------------------------------ */

  // Control characters, zero-width marks and bidi overrides are removed from
  // anything typed or read (a name like "‮Sam" would draw backwards on
  // every phone). The zero-width joiner stays: family emoji need it.
  var STRIP = /[\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁠-⁩﻿]/g;

  /** One line of untrusted text: no markup, no control or bidi characters,
   *  single spaces, at most `max` characters, cut on a whole character. Cut
   *  before any pattern runs, so hostile input costs linear time. */
  function clean(v, max) {
    var s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 200) s = s.slice(0, max * 4 + 200);
    s = s.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    var chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
    return s;
  }
  /** A member's name: has to have a letter, digit or emoji in it. */
  function cleanName(v) {
    var s = clean(v, LIMITS.memberName);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  function cleanEmoji(v) { return EMOJI.indexOf(v) >= 0 ? v : null; }

  /** Stars: 0.5 to 5 in half steps, or null. */
  function cleanStars(v) {
    var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !isFinite(n)) return null;
    var h = n * 2;
    if (Math.abs(h - Math.round(h)) > 1e-9) return null;
    h = Math.round(h);
    return h >= 1 && h <= 10 ? h / 2 : null;
  }
  /** ABV: "6.8", "6.8%", 6.8 -> 6.8 (one decimal, 0 to 20), else null. */
  function cleanAbv(v) {
    var n = v;
    if (typeof v === 'string') {
      var s = v.trim().replace(/%$/, '').replace(',', '.').trim();
      if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null;
      n = Number(s);
    }
    if (typeof n !== 'number' || !isFinite(n) || n < 0 || n > LIMITS.abvMax) return null;
    return Math.round(n * 10) / 10;
  }
  function cleanStyle(v) { return typeof v === 'string' && (STYLE_BY_ID[v]) ? v : null; }
  function cleanChips(v) {
    if (!Array.isArray(v)) return [];
    var out = [];
    for (var i = 0; i < v.length && i < 40; i++) if (CHIPS.indexOf(v[i]) >= 0 && out.indexOf(v[i]) < 0 && out.length < LIMITS.chips) out.push(v[i]);
    return out;
  }
  function abvText(a) { return a === null || a === undefined ? '' : (Math.round(a * 10) / 10).toFixed(1) + '%'; }
  function starsText(s) { return s === null || s === undefined ? '' : (s % 1 ? s.toFixed(1) : String(s)); }

  function fail(status, message, extra) {
    var e = new Error(message);
    e.status = status; e.expose = true;
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    return e;
  }
  function shortId(prefix) { return (prefix || '') + Math.random().toString(36).slice(2, 10); }
  /** "Ana", "Ana & Ben", "Ana, Ben & Cleo". */
  function nameList(names) {
    if (names.length <= 2) return names.join(' & ');
    return names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
  }
  function has(o, k) { return Boolean(o) && Object.prototype.hasOwnProperty.call(o, k); }

  /* ------------------------------------------------------------------ *
   * Sessions: a blind tasting, or a Same-Can Challenge played apart.
   * ------------------------------------------------------------------ */

  var LETTERS = 'ABCDEFGHIJKLMNOPQRST';

  /** The stage a session is in RIGHT NOW. A Same-Can window is checked on
   *  read: there is no timer, so a closed window is simply "revealed" from
   *  the first read after it closes. */
  function stageOf(s, now) {
    if (s.revealedAt) return 'revealed';
    if (s.kind === 'samecan') {
      var w = s.window || {};
      if (now < Date.parse(w.opensAt)) return 'upcoming';
      if (now >= Date.parse(w.closesAt)) return 'revealed';
      return 'open';
    }
    return s.stage === 'tasting' ? 'tasting' : 'setup';
  }
  function scoringOpen(s, now) { var st = stageOf(s, now); return st === 'tasting' || st === 'open'; }
  function knows(beer, mid) { return Boolean(mid) && (beer.broughtBy === mid || beer.addedBy === mid); }
  function isHome(s) { return s.kind === 'samecan' && s.mode === 'home'; }
  function beerOf(s, id) { for (var i = 0; i < s.beers.length; i++) if (s.beers[i].id === id) return s.beers[i]; return null; }

  /** A Same-Can window ending this weekend: from now to Sunday 23:59 in the
   *  creator's own time zone (`offsetMin`, minutes east of UTC - the page
   *  sends -getTimezoneOffset()). On a Sunday evening it runs to next
   *  Sunday rather than closing in an hour. Returned as instants. */
  function weekendWindow(nowMs, offsetMin) {
    var off = (Number(offsetMin) || 0) * 60000;
    var local = new Date(nowMs + off);              // its UTC fields are local time
    var dow = local.getUTCDay();                    // 0 Sunday
    var addDays = (7 - dow) % 7;
    if (dow === 0 && local.getUTCHours() >= 18) addDays = 7;
    var endLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + addDays, 23, 59, 0);
    return { opensAt: new Date(nowMs).toISOString(), closesAt: new Date(endLocal - off).toISOString() };
  }

  function cleanWindow(w, now) {
    var o = w && Date.parse(w.opensAt);
    var c = w && Date.parse(w.closesAt);
    if (!isFinite(o)) o = now;
    if (!isFinite(c)) throw fail(400, 'Pick when the challenge closes.');
    if (o < now - 5 * 60000) o = now;
    if (c - o < LIMITS.windowMinMs) throw fail(400, 'Give the crew at least an hour.');
    if (c - o > LIMITS.windowMaxMs) throw fail(400, 'Keep it to two weeks at most.');
    return { opensAt: new Date(o).toISOString(), closesAt: new Date(c).toISOString() };
  }

  /** What one person typed about one beer. */
  function cleanBeer(b) {
    b = b || {};
    var name = clean(b.name, LIMITS.beerName);
    if (!/[\p{L}\p{N}]/u.test(name)) throw fail(400, 'Give the beer a name.');
    return { name: name, brewery: clean(b.brewery, LIMITS.brewery), style: cleanStyle(b.style), abv: cleanAbv(b.abv) };
  }

  /**
   * A new session. `input`: {kind: 'blind'|'samecan', mode: 'same'|'home',
   * title, window, beer}. The person who starts it runs it (with the crew's
   * host): starts the tasting, reveals, deletes.
   */
  function newSession(input, actor, now, ids) {
    input = input || {};
    var kind = input.kind === 'samecan' ? 'samecan' : 'blind';
    var title = clean(input.title, LIMITS.title);
    var s = {
      kind: kind, title: title || (kind === 'blind' ? 'Blind tasting' : 'Same-Can Challenge'),
      runner: actor.mid, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), v: 1,
      beers: [], scores: {}, guesses: {}, cities: {}, revealedAt: null,
    };
    if (kind === 'blind') s.stage = 'setup';
    else {
      s.mode = input.mode === 'home' ? 'home' : 'same';
      s.window = cleanWindow(input.window, now);
      if (s.mode === 'same') {
        var b = cleanBeer(input.beer);
        s.beers.push({ id: ids.beer(), label: 'A', name: b.name, brewery: b.brewery, style: b.style, abv: b.abv, broughtBy: null, addedBy: actor.mid, at: s.createdAt });
        if (!title) s.title = 'Same-Can: ' + b.name;
      }
    }
    return s;
  }

  function mayRun(s, actor) { return Boolean(actor.host || (actor.mid && s.runner === actor.mid)); }
  function touch(s, now) { s.updatedAt = new Date(now).toISOString(); s.v = (s.v || 0) + 1; }

  /** Bring a beer. Blind: anyone before the tasting starts (two each, eight
   *  in all); whoever runs it may add one for someone else, or for nobody.
   *  Home pours: your own, one each, while the window is open. */
  function addBeer(s, actor, input, now, ids, memberIds) {
    if (!actor.mid) throw fail(403, 'Join the crew first.');
    input = input || {};
    var stage = stageOf(s, now);
    var b = cleanBeer(input);
    var by = actor.mid;
    if (s.kind === 'blind') {
      if (stage !== 'setup') throw fail(409, 'The tasting has started - the lineup is set.');
      if (s.beers.length >= LIMITS.beers) throw fail(409, 'That’s ' + LIMITS.beers + ' beers - the most one flight takes.');
      if (has(input, 'broughtBy') && input.broughtBy !== actor.mid) {
        if (!mayRun(s, actor)) throw fail(403, 'Only whoever runs the tasting can add a beer for someone else.');
        by = input.broughtBy === null ? null : (memberIds.indexOf(input.broughtBy) >= 0 ? input.broughtBy : undefined);
        if (by === undefined) throw fail(400, 'That person isn’t in the crew.');
      }
      if (by && s.beers.filter(function (x) { return x.broughtBy === by; }).length >= LIMITS.beersPerMember) throw fail(409, 'Two beers each is plenty.');
    } else if (isHome(s)) {
      if (stage !== 'open') throw fail(409, stage === 'upcoming' ? 'The challenge hasn’t opened yet.' : 'The challenge has closed.');
      if (s.beers.some(function (x) { return x.broughtBy === actor.mid; })) throw fail(409, 'You’ve already poured yours - edit it instead.');
      if (s.beers.length >= LIMITS.homeBeers) throw fail(409, 'Everyone’s poured.');
    } else {
      throw fail(409, 'This challenge has one beer, picked when it started.');
    }
    var beer = { id: ids.beer(), label: null, name: b.name, brewery: b.brewery, style: b.style, abv: b.abv, broughtBy: by, addedBy: actor.mid, at: new Date(now).toISOString() };
    if (isHome(s)) beer.label = LETTERS[s.beers.length];
    s.beers.push(beer);
    touch(s, now);
    return beer;
  }

  /** Fix a beer's details: whoever added or brought it, or whoever runs it,
   *  until the reveal (and in a blind tasting, until it starts - except the
   *  style and ABV, which the bringer may still correct). */
  function editBeer(s, actor, beerId, input, now) {
    var beer = beerOf(s, beerId);
    if (!beer) throw fail(404, 'No such beer.');
    var stage = stageOf(s, now);
    if (stage === 'revealed') throw fail(409, 'It’s been revealed - no changes now.');
    if (!(knows(beer, actor.mid) || mayRun(s, actor))) throw fail(403, 'That’s not yours to change.');
    var b = cleanBeer(Object.assign({ name: beer.name, brewery: beer.brewery, style: beer.style, abv: beer.abv }, input || {}));
    if (s.kind === 'blind' && stage !== 'setup') {
      if (!knows(beer, actor.mid)) throw fail(409, 'The tasting has started - only whoever brought it can fix its details now.');
    }
    beer.name = b.name; beer.brewery = b.brewery; beer.style = b.style; beer.abv = b.abv;
    touch(s, now);
    return beer;
  }

  function removeBeer(s, actor, beerId, now) {
    var beer = beerOf(s, beerId);
    if (!beer) throw fail(404, 'No such beer.');
    var stage = stageOf(s, now);
    if (s.kind === 'blind' && stage !== 'setup') throw fail(409, 'The tasting has started - the lineup is set.');
    if (s.kind === 'samecan' && !isHome(s)) throw fail(409, 'A Same-Can Challenge keeps its beer.');
    if (stage === 'revealed') throw fail(409, 'It’s been revealed - no changes now.');
    if (!(knows(beer, actor.mid) || mayRun(s, actor))) throw fail(403, 'That’s not yours to take out.');
    s.beers = s.beers.filter(function (x) { return x.id !== beerId; });
    delete s.scores[beerId];
    Object.keys(s.guesses).forEach(function (m) { delete s.guesses[m][beerId]; });
    if (isHome(s)) s.beers.forEach(function (x, i) { x.label = LETTERS[i]; });
    touch(s, now);
  }

  /** Start the tasting: the letters are handed out in a shuffled order, so
   *  the order beers were added says nothing about who brought which.
   *  `rand(n)` is a uniform integer below n (crypto on the server). */
  function startTasting(s, actor, now, rand) {
    if (!mayRun(s, actor)) throw fail(403, 'Only whoever runs the tasting can start it.');
    if (s.kind !== 'blind' || stageOf(s, now) !== 'setup') throw fail(409, 'It’s already started.');
    if (s.beers.length < 2) throw fail(409, 'Add at least two beers first.');
    var order = s.beers.map(function (_, i) { return i; });
    for (var i = order.length - 1; i > 0; i--) { var j = rand(i + 1); var t = order[i]; order[i] = order[j]; order[j] = t; }
    var shuffled = order.map(function (k) { return s.beers[k]; });
    shuffled.forEach(function (b, k) { b.label = LETTERS[k]; });
    s.beers = shuffled;
    s.stage = 'tasting';
    touch(s, now);
  }

  /** One member's score for one beer - always their own; the route never
   *  takes a member id from the body. Blind: not your own beer. Home pours:
   *  stars, chips and a note on yours; a style and ABV guess on the rest. */
  function setScore(s, actor, beerId, input, now) {
    if (!actor.mid) throw fail(403, 'Join the crew first.');
    if (!scoringOpen(s, now)) throw fail(409, stageOf(s, now) === 'setup' ? 'The tasting hasn’t started yet.' : stageOf(s, now) === 'upcoming' ? 'The challenge hasn’t opened yet.' : 'Scoring has closed.');
    var beer = beerOf(s, beerId);
    if (!beer) throw fail(404, 'No such beer.');
    input = input || {};
    var mine = beer.broughtBy === actor.mid;
    if (s.kind === 'blind' && mine) throw fail(409, 'You brought this one - sit it out.');
    var given = function (v) { return v !== null && v !== undefined && v !== ''; };
    if (given(input.stars) && cleanStars(input.stars) === null) throw fail(400, 'Stars go from half a star to five, in halves.');
    if (given(input.abv) && cleanAbv(input.abv) === null) throw fail(400, 'ABV is a number from 0 to 20, like 6.5.');
    if (given(input.style) && !cleanStyle(input.style)) throw fail(400, 'Pick a style from the list.');
    var sc = {
      stars: cleanStars(input.stars), style: cleanStyle(input.style), abv: cleanAbv(input.abv),
      chips: cleanChips(input.chips), note: clean(input.note, LIMITS.note), at: new Date(now).toISOString(),
    };
    if (isHome(s)) {
      if (mine) { sc.style = null; sc.abv = null; } else { sc.stars = null; sc.chips = []; sc.note = ''; }
    }
    if (sc.stars === null && !sc.style && sc.abv === null && !sc.chips.length && !sc.note) {
      if (has(s.scores, beerId)) delete s.scores[beerId][actor.mid];
    } else {
      if (!s.scores[beerId]) s.scores[beerId] = {};
      s.scores[beerId][actor.mid] = sc;
    }
    touch(s, now);
    return sc;
  }

  /** "Who brought it?" - blind tastings only, before the reveal. Not for a
   *  beer you brought or added, and never yourself. null takes it back. */
  function setGuess(s, actor, beerId, who, memberIds, now) {
    if (!actor.mid) throw fail(403, 'Join the crew first.');
    if (s.kind !== 'blind') throw fail(409, 'Guessing who brought it is for blind tastings.');
    if (!scoringOpen(s, now)) throw fail(409, 'Guessing is closed.');
    var beer = beerOf(s, beerId);
    if (!beer) throw fail(404, 'No such beer.');
    if (knows(beer, actor.mid)) throw fail(409, 'You know who brought this one.');
    if (who !== null) {
      if (who === actor.mid) throw fail(400, 'You know you didn’t bring it.');
      if (memberIds.indexOf(who) < 0) throw fail(400, 'That person isn’t in the crew.');
    }
    if (!s.guesses[actor.mid]) s.guesses[actor.mid] = {};
    if (who === null) delete s.guesses[actor.mid][beerId];
    else s.guesses[actor.mid][beerId] = who;
    touch(s, now);
  }

  function setCity(s, actor, city, now) {
    if (!actor.mid) throw fail(403, 'Join the crew first.');
    if (s.kind !== 'samecan') throw fail(409, 'Cities are for Same-Can Challenges.');
    if (stageOf(s, now) === 'revealed') throw fail(409, 'It’s closed.');
    var c = clean(city, LIMITS.city);
    if (c) s.cities[actor.mid] = c; else delete s.cities[actor.mid];
    touch(s, now);
  }

  function reveal(s, actor, now) {
    if (!mayRun(s, actor)) throw fail(403, 'Only whoever runs it can reveal it.');
    var st = stageOf(s, now);
    if (st === 'revealed') return;
    if (st === 'setup') throw fail(409, 'Start the tasting first.');
    s.revealedAt = new Date(now).toISOString();
    touch(s, now);
  }

  /** A member leaving or removed: everything they put in a session goes
   *  with them - their scores, guesses, city, and the guesses naming them -
   *  and a beer they brought stays (others scored it) with nobody's name. */
  function scrubMember(s, mid) {
    var changed = false;
    Object.keys(s.scores || {}).forEach(function (b) { if (has(s.scores[b], mid)) { delete s.scores[b][mid]; changed = true; } });
    if (has(s.guesses, mid)) { delete s.guesses[mid]; changed = true; }
    Object.keys(s.guesses || {}).forEach(function (m) { Object.keys(s.guesses[m]).forEach(function (b) { if (s.guesses[m][b] === mid) { delete s.guesses[m][b]; changed = true; } }); });
    if (has(s.cities, mid)) { delete s.cities[mid]; changed = true; }
    (s.beers || []).forEach(function (b) { if (b.broughtBy === mid) { b.broughtBy = null; changed = true; } if (b.addedBy === mid) { b.addedBy = null; changed = true; } });
    if (s.runner === mid) { s.runner = null; changed = true; }
    return changed;
  }

  /* ------------------------------------------------------------------ *
   * Results: worked out from the scores, the same on every phone.
   * ------------------------------------------------------------------ */

  /** Whose stars count toward a beer's crowd score: everyone but whoever
   *  brought it (they'd vote for their own); on a home pour, only the person
   *  who poured it - nobody else tasted it. */
  function counts(s, beer, mid) { return isHome(s) ? beer.broughtBy === mid : beer.broughtBy !== mid; }

  function halfStar(mean) { return mean === null ? null : Math.round(mean * 2) / 2; }

  /** The award definitions, in the order they are shown. */
  var AWARDS = [
    { id: 'palate', title: 'Best Palate', emoji: '👃', blurb: 'most style points' },
    { id: 'abv', title: 'ABV Whisperer', emoji: '🎯', blurb: 'closest on the most ABVs' },
    { id: 'pleaser', title: 'Crowd Pleaser', emoji: '🏆', blurb: 'brought the top beer' },
    { id: 'hometown', title: 'Hometown Hero', emoji: '🏡', blurb: 'poured the best local beer' },
    { id: 'sleuth', title: 'Sleuth', emoji: '🕵️', blurb: 'most right on who brought what' },
    { id: 'contrarian', title: 'Contrarian', emoji: '🙃', blurb: 'furthest from the crowd' },
    { id: 'hophead', title: 'Hop Head', emoji: '🌿', blurb: 'rated the IPAs highest' },
  ];
  function awardDef(id) { for (var i = 0; i < AWARDS.length; i++) if (AWARDS[i].id === id) return AWARDS[i]; return null; }

  /** The keys of `obj` whose value is the largest, if that is at least
   *  `min`. Every key at the top shares it: ties are honest. */
  function topKeys(obj, min) {
    var best = null, keys = [];
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v === null || v === undefined || v < min) return;
      if (best === null || v > best + 1e-9) { best = v; keys = [k]; } else if (Math.abs(v - best) <= 1e-9) keys.push(k);
    });
    return { best: best, keys: keys.sort() };
  }

  /**
   * Everything the reveal shows. `memberIds` are the crew's current members:
   * anyone else's scores are ignored (a member who left took them along).
   */
  function results(s, memberIds) {
    var inCrew = {};
    memberIds.forEach(function (m) { inCrew[m] = true; });
    var per = {};
    memberIds.forEach(function (m) { per[m] = { stylePts: 0, abvWins: 0, abvErr: 0, abvN: 0, whoRight: 0, whoN: 0, rated: 0, awards: [], points: 0 }; });
    var beers = s.beers.map(function (b) {
      var row = s.scores[b.id] || {};
      var raters = Object.keys(row).filter(function (m) { return inCrew[m]; }).sort();
      var halves = 0, n = 0;
      raters.forEach(function (m) {
        var sc = row[m];
        if (sc.stars !== null && sc.stars !== undefined && counts(s, b, m)) { halves += Math.round(sc.stars * 2); n++; }
        if (sc.stars !== null && sc.stars !== undefined) per[m].rated++;
      });
      var mean = n ? halves / n / 2 : null;
      var styleHits = [];
      var abvBest = null, abvWinners = [];
      raters.forEach(function (m) {
        var sc = row[m];
        if (knows(b, m)) return;
        var pts = stylePoints(sc.style, b.style);
        if (sc.style) styleHits.push({ member: m, guess: sc.style, pts: pts });
        per[m].stylePts += pts;
        if (sc.abv !== null && sc.abv !== undefined && b.abv !== null && b.abv !== undefined) {
          var d = Math.round(Math.abs(sc.abv - b.abv) * 10);
          per[m].abvErr += d; per[m].abvN++;
          if (abvBest === null || d < abvBest) { abvBest = d; abvWinners = [m]; } else if (d === abvBest) abvWinners.push(m);
        }
      });
      abvWinners.forEach(function (m) { per[m].abvWins++; });
      var who = [];
      if (s.kind === 'blind') {
        Object.keys(s.guesses || {}).filter(function (m) { return inCrew[m]; }).sort().forEach(function (m) {
          var g = s.guesses[m][b.id];
          if (!g || knows(b, m)) return;
          var right = Boolean(b.broughtBy) && g === b.broughtBy && inCrew[b.broughtBy];
          who.push({ member: m, guess: g, right: right });
          per[m].whoN++;
          if (right) per[m].whoRight++;
        });
      }
      return {
        id: b.id, label: b.label, name: b.name, brewery: b.brewery, style: b.style, abv: b.abv,
        broughtBy: b.broughtBy && inCrew[b.broughtBy] ? b.broughtBy : null,
        crowd: { mean: mean, half: halfStar(mean), n: n },
        styleHits: styleHits, abv: b.abv, abvBest: abvBest === null ? null : abvBest / 10, abvWinners: abvWinners.sort(), who: who,
        scores: raters.map(function (m) { var sc = row[m]; return { member: m, stars: sc.stars, style: sc.style, abv: sc.abv, chips: sc.chips || [], note: sc.note || '' }; }),
      };
    });
    var ranked = beers.filter(function (b) { return b.crowd.n > 0; }).sort(function (a, b) {
      return (b.crowd.mean - a.crowd.mean) || (b.crowd.n - a.crowd.n) || String(a.label || '').localeCompare(String(b.label || ''));
    }).map(function (b) { return b.id; });

    // Awards.
    var awards = [];
    function give(id, winners, detail) {
      if (!winners.length) return;
      awards.push({ id: id, title: awardDef(id).title, emoji: awardDef(id).emoji, winners: winners, detail: detail });
      winners.forEach(function (m) { per[m].awards.push(id); });
    }
    var sp = {}; memberIds.forEach(function (m) { sp[m] = per[m].stylePts; });
    var t = topKeys(sp, 1);
    give('palate', t.keys, t.best + ' style point' + (t.best === 1 ? '' : 's'));

    var aw = {}; memberIds.forEach(function (m) { aw[m] = per[m].abvWins; });
    t = topKeys(aw, 1);
    if (t.keys.length > 1) {
      // Tied on closest calls: the smaller average miss breaks it.
      var err = {}; t.keys.forEach(function (m) { err[m] = -per[m].abvErr / per[m].abvN; });
      t = { best: t.best, keys: topKeys(err, -Infinity).keys };
    }
    give('abv', t.keys, 'closest on ' + t.best + ' beer' + (t.best === 1 ? '' : 's'));

    if (ranked.length) {
      var top = beers.filter(function (b) { return b.id === ranked[0]; })[0];
      var tied = beers.filter(function (b) { return b.crowd.n > 0 && Math.abs(b.crowd.mean - top.crowd.mean) < 1e-9; });
      var by = [];
      tied.forEach(function (b) { if (b.broughtBy && by.indexOf(b.broughtBy) < 0) by.push(b.broughtBy); });
      if (s.kind === 'blind') give('pleaser', by.sort(), (tied.length > 1 ? 'tied top beers' : top.name) + ' · ' + starsText(top.crowd.half) + '★');
      if (isHome(s)) give('hometown', by.sort(), (tied.length > 1 ? 'tied top pours' : top.name) + ' · ' + starsText(top.crowd.half) + '★');
    }

    if (s.kind === 'blind') {
      var wr = {}; memberIds.forEach(function (m) { wr[m] = per[m].whoRight; });
      t = topKeys(wr, 1);
      give('sleuth', t.keys, t.best + ' right');
    }

    if (!isHome(s)) {
      // Contrarian: the largest average gap between your stars and everyone
      // else's average, over beers at least two others rated. Half a star
      // or more, or nobody is really contrary.
      var gap = {};
      memberIds.forEach(function (m) {
        var sum = 0, k = 0;
        s.beers.forEach(function (b) {
          var row = s.scores[b.id] || {};
          if (!row[m] || row[m].stars === null || row[m].stars === undefined || !counts(s, b, m)) return;
          var others = Object.keys(row).filter(function (o) { return o !== m && inCrew[o] && row[o].stars !== null && row[o].stars !== undefined && counts(s, b, o); });
          if (others.length < 2) return;
          var avg = others.reduce(function (a, o) { return a + row[o].stars; }, 0) / others.length;
          sum += Math.abs(row[m].stars - avg); k++;
        });
        gap[m] = k ? sum / k : null;
      });
      t = topKeys(gap, 0.5);
      give('contrarian', t.keys, Math.round(t.best * 10) / 10 + '★ from the crowd, on average');

      // Hop Head: the highest average on the IPAs, with at least two people
      // having rated one - one person can't out-hop nobody.
      var hop = {}, contenders = 0;
      memberIds.forEach(function (m) {
        var sum = 0, k = 0;
        s.beers.forEach(function (b) {
          if (!HOPPY[b.style]) return;
          var sc = (s.scores[b.id] || {})[m];
          if (!sc || sc.stars === null || sc.stars === undefined || !counts(s, b, m)) return;
          sum += sc.stars; k++;
        });
        hop[m] = k ? sum / k : null;
        if (k) contenders++;
      });
      if (contenders >= 2) {
        t = topKeys(hop, 0.5);
        give('hophead', t.keys, Math.round(t.best * 10) / 10 + '★ on the IPAs');
      }
    }
    awards.sort(function (a, b) { return AWARDS.indexOf(awardDef(a.id)) - AWARDS.indexOf(awardDef(b.id)); });

    memberIds.forEach(function (m) {
      var p = per[m];
      p.points = p.stylePts + POINTS.abvClosest * p.abvWins + POINTS.whoBrought * p.whoRight + POINTS.award * p.awards.length;
      p.attended = p.rated > 0 || p.whoN > 0 || Object.keys(s.scores || {}).some(function (b) { return has(s.scores[b], m); });
    });
    return { beers: beers, ranked: ranked, awards: awards, members: per };
  }

  /** The text for the group chat. Names come from the crew; nothing else
   *  personal (no notes) - a recap gets forwarded. */
  function recap(crewName, s, r, nameOf) {
    var lines = ['🍻 ' + (crewName ? crewName + ' · ' : '') + s.title];
    var byId = {};
    r.beers.forEach(function (b) { byId[b.id] = b; });
    var order = r.ranked.concat(r.beers.filter(function (b) { return r.ranked.indexOf(b.id) < 0; }).map(function (b) { return b.id; }));
    order.forEach(function (id, i) {
      var b = byId[id];
      var bits = [(b.label ? b.label + ': ' : '') + b.name + (b.brewery ? ' (' + b.brewery + ')' : '')];
      var meta = [b.style ? styleName(b.style) : '', b.abv !== null && b.abv !== undefined ? abvText(b.abv) : ''].filter(Boolean).join(' ');
      if (meta) bits.push(meta);
      if (b.crowd.n) bits.push(starsText(b.crowd.half) + '★');
      if (b.broughtBy) bits.push((isHome(s) ? 'poured by ' : 'brought by ') + nameOf(b.broughtBy));
      lines.push((i + 1) + '. ' + bits.join(' · '));
    });
    if (s.kind === 'samecan') {
      var cities = [];
      Object.keys(s.cities || {}).sort().forEach(function (m) { if (r.members[m]) { var c = s.cities[m]; if (cities.indexOf(c) < 0) cities.push(c); } });
      if (cities.length) lines.push('Tasted in ' + cities.join(', '));
    }
    r.awards.forEach(function (a) { lines.push(a.emoji + ' ' + a.title + ': ' + nameList(a.winners.map(nameOf))); });
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * What one member sees of a session. The server sends this and nothing
   * else, so a blind tasting stays blind: before the reveal nobody gets a
   * beer's name, style, ABV or bringer unless it is theirs, nor anyone
   * else's scores or guesses - only how far along each person is.
   * ------------------------------------------------------------------ */
  function sessionView(s, memberIds, me, canRun, now) {
    var stage = stageOf(s, now);
    var revealed = stage === 'revealed';
    var home = isHome(s);
    var beers = s.beers.map(function (b) {
      var mine = Boolean(me) && b.broughtBy === me;
      var added = Boolean(me) && b.addedBy === me;
      var open = revealed || mine || added;
      var out = { id: b.id, label: b.label, mine: mine, added: added };
      if (open || s.kind === 'samecan' && !home) { out.name = b.name; out.brewery = b.brewery; }
      if (open) { out.style = b.style; out.abv = b.abv; }
      if (revealed || mine) out.broughtBy = b.broughtBy;
      if (home) {
        // A home pour's tasting notes and city show before the reveal - they
        // are the clues for guessing its style - but not its stars.
        out.poured = b.broughtBy || null;
        var own = (s.scores[b.id] || {})[b.broughtBy];
        out.clues = own ? { chips: own.chips || [], note: own.note || '' } : { chips: [], note: '' };
        out.city = (s.cities || {})[b.broughtBy] || '';
      }
      return out;
    });
    var mine = { scores: {}, guesses: {}, city: (s.cities || {})[me] || '' };
    if (me) {
      s.beers.forEach(function (b) { var sc = (s.scores[b.id] || {})[me]; if (sc) mine.scores[b.id] = sc; });
      mine.guesses = (s.guesses || {})[me] || {};
    }
    var inCrew = {};
    memberIds.forEach(function (m) { inCrew[m] = true; });
    var bringers = [];
    if (s.kind === 'blind' && stage !== 'setup') s.beers.forEach(function (b) { if (b.broughtBy && inCrew[b.broughtBy] && bringers.indexOf(b.broughtBy) < 0) bringers.push(b.broughtBy); });
    var progress = memberIds.map(function (m) {
      var scorable = s.beers.filter(function (b) { return home ? true : b.broughtBy !== m; });
      var done = scorable.filter(function (b) { var sc = (s.scores[b.id] || {})[m]; return sc && (sc.stars !== null || (home && b.broughtBy !== m && (sc.style || sc.abv !== null))); }).length;
      return { member: m, done: done, of: scorable.length, city: s.kind === 'samecan' ? ((s.cities || {})[m] || '') : '', brought: s.beers.filter(function (b) { return b.broughtBy === m; }).length };
    });
    var v = {
      id: s.id, kind: s.kind, mode: s.mode || null, title: s.title, stage: stage, createdAt: s.createdAt,
      window: s.window || null, revealedAt: s.revealedAt || null, v: s.v || 0,
      runner: s.runner || null, canRun: Boolean(canRun), me: me || null,
      beers: beers, bringers: bringers.sort(), mine: mine, progress: progress,
    };
    if (revealed) v.results = results(s, memberIds);
    return v;
  }

  /** One line per session for the crew's list. */
  function sessionSummary(s, memberIds, now) {
    var stage = stageOf(s, now);
    var out = { id: s.id, kind: s.kind, mode: s.mode || null, title: s.title, stage: stage, createdAt: s.createdAt, window: s.window || null, revealedAt: s.revealedAt || null, beers: s.beers.length };
    var players = {};
    Object.keys(s.scores || {}).forEach(function (b) { Object.keys(s.scores[b]).forEach(function (m) { if (memberIds.indexOf(m) >= 0) players[m] = true; }); });
    out.players = Object.keys(players).length;
    if (stage === 'revealed') {
      var r = results(s, memberIds);
      var top = r.ranked.length ? r.beers.filter(function (b) { return b.id === r.ranked[0]; })[0] : null;
      out.top = top ? { name: top.name, half: top.crowd.half } : null;
      out.awards = r.awards.map(function (a) { return { id: a.id, emoji: a.emoji, title: a.title, winners: a.winners, detail: a.detail }; });
    }
    return out;
  }

  /** When a session counts in the history: its reveal, or its window's close. */
  function settledAt(s, now) {
    if (s.revealedAt) return Date.parse(s.revealedAt);
    if (s.kind === 'samecan' && stageOf(s, now) === 'revealed') return Date.parse(s.window.closesAt);
    return null;
  }

  /* ------------------------------------------------------------------ *
   * The crew's leaderboard and history: every revealed session, in order.
   * ------------------------------------------------------------------ */
  function board(sessions, memberIds, now) {
    var done = sessions.filter(function (s) { return settledAt(s, now) !== null; })
      .sort(function (a, b) { return (settledAt(a, now) - settledAt(b, now)) || String(a.id).localeCompare(String(b.id)); });
    var rows = {};
    memberIds.forEach(function (m) {
      rows[m] = { member: m, points: 0, stylePts: 0, abvWins: 0, whoRight: 0, awards: 0, sessions: 0, streak: 0, best: 0, fam: {} };
    });
    var beers = [];
    done.forEach(function (s) {
      var r = results(s, memberIds);
      memberIds.forEach(function (m) {
        var p = r.members[m], row = rows[m];
        row.points += p.points; row.stylePts += p.stylePts; row.abvWins += p.abvWins; row.whoRight += p.whoRight; row.awards += p.awards.length;
        if (p.attended) { row.sessions++; row.streak++; if (row.streak > row.best) row.best = row.streak; } else row.streak = 0;
      });
      r.beers.forEach(function (b) {
        if (b.crowd.n) beers.push({ name: b.name, brewery: b.brewery, style: b.style, abv: b.abv, mean: b.crowd.mean, half: b.crowd.half, n: b.crowd.n, session: s.title, sessionId: s.id, broughtBy: b.broughtBy });
        b.scores.forEach(function (sc) {
          var orig = beerOf(s, b.id);
          var f = familyOf(b.style);
          if (!f || sc.stars === null || sc.stars === undefined || !counts(s, orig, sc.member)) return;
          var fam = rows[sc.member].fam;
          if (!fam[f]) fam[f] = { sum: 0, n: 0 };
          fam[f].sum += Math.round(sc.stars * 2); fam[f].n++;
        });
      });
    });
    var out = memberIds.map(function (m) {
      var row = rows[m];
      var profile = Object.keys(row.fam).map(function (f) { return { family: f, name: familyName(f), mean: row.fam[f].sum / row.fam[f].n / 2, n: row.fam[f].n }; })
        .sort(function (a, b) { return (b.mean - a.mean) || (b.n - a.n) || FAMILIES.map(function (x) { return x.id; }).indexOf(a.family) - FAMILIES.map(function (x) { return x.id; }).indexOf(b.family); });
      delete row.fam;
      row.profile = profile;
      return row;
    });
    out.sort(function (a, b) { return (b.points - a.points) || (b.stylePts - a.stylePts) || (b.sessions - a.sessions) || String(a.member).localeCompare(String(b.member)); });
    beers.sort(function (a, b) { return (b.mean - a.mean) || (b.n - a.n) || a.name.localeCompare(b.name); });
    return { rows: out, topBeers: beers.slice(0, 10), sessions: done.length };
  }

  /* ------------------------------------------------------------------ *
   * Polls: approval voting. Tick every option you'd be happy with; the
   * most ticks wins. One tap per option, no spoilers, and a tie is shown
   * as a tie for whoever runs it to break.
   * ------------------------------------------------------------------ */
  function newPoll(input, actor, now, ids) {
    input = input || {};
    var q = clean(input.question, LIMITS.pollQuestion);
    if (!q) throw fail(400, 'Ask the crew something.');
    var p = { question: q, runner: actor.mid, options: [], votes: {}, closed: false, pick: null, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), v: 1 };
    (Array.isArray(input.options) ? input.options : []).slice(0, LIMITS.pollOptions).forEach(function (o) {
      var t = clean(typeof o === 'string' ? o : o && o.text, LIMITS.pollOption);
      if (t) p.options.push({ id: ids.option(), text: t, crawl: null, addedBy: actor.mid });
    });
    return p;
  }
  function addOption(p, actor, text, crawl, now, ids) {
    if (!actor.mid) throw fail(403, 'Join the crew first.');
    if (p.closed) throw fail(409, 'The vote has closed.');
    if (p.options.length >= LIMITS.pollOptions) throw fail(409, LIMITS.pollOptions + ' options is the most.');
    var t = clean(text, LIMITS.pollOption);
    if (!t) throw fail(400, 'Type an option.');
    var o = { id: ids.option(), text: t, crawl: crawl || null, addedBy: actor.mid };
    p.options.push(o);
    touch(p, now);
    return o;
  }
  function removeOption(p, actor, optionId, now) {
    var o = p.options.filter(function (x) { return x.id === optionId; })[0];
    if (!o) throw fail(404, 'No such option.');
    if (!(actor.host || (actor.mid && (p.runner === actor.mid || o.addedBy === actor.mid)))) throw fail(403, 'That’s not yours to take out.');
    if (p.closed) throw fail(409, 'The vote has closed.');
    p.options = p.options.filter(function (x) { return x.id !== optionId; });
    Object.keys(p.votes).forEach(function (m) { p.votes[m] = p.votes[m].filter(function (x) { return x !== optionId; }); });
    touch(p, now);
  }
  function vote(p, actor, optionIds, now) {
    if (!actor.mid) throw fail(403, 'Join the crew first.');
    if (p.closed) throw fail(409, 'The vote has closed.');
    if (!Array.isArray(optionIds)) throw fail(400, 'Pick at least one option.');
    var valid = p.options.map(function (o) { return o.id; });
    var mine = [];
    optionIds.slice(0, 50).forEach(function (id) { if (valid.indexOf(id) >= 0 && mine.indexOf(id) < 0) mine.push(id); });
    if (!mine.length) throw fail(400, 'Pick at least one option.');
    p.votes[actor.mid] = mine;
    touch(p, now);
  }
  function pollResults(p, memberIds) {
    var counts = {};
    p.options.forEach(function (o) { counts[o.id] = []; });
    Object.keys(p.votes || {}).forEach(function (m) {
      if (memberIds.indexOf(m) < 0) return;
      (p.votes[m] || []).forEach(function (id) { if (counts[id]) counts[id].push(m); });
    });
    var voters = Object.keys(p.votes || {}).filter(function (m) { return memberIds.indexOf(m) >= 0 && p.votes[m].length; });
    var rows = p.options.map(function (o, i) { return { id: o.id, n: counts[o.id].length, voters: counts[o.id].sort(), order: i }; })
      .sort(function (a, b) { return (b.n - a.n) || (a.order - b.order); });
    var max = rows.length ? rows[0].n : 0;
    var leaders = max ? rows.filter(function (r) { return r.n === max; }).map(function (r) { return r.id; }) : [];
    var winner = p.pick && counts[p.pick] ? p.pick : (leaders.length === 1 ? leaders[0] : null);
    return { rows: rows, voters: voters.length, leaders: leaders, tie: leaders.length > 1, winner: winner };
  }
  function closePoll(p, actor, pick, memberIds, now) {
    if (!(actor.host || (actor.mid && p.runner === actor.mid))) throw fail(403, 'Only whoever started the vote can close it.');
    var r = pollResults(p, memberIds);
    if (pick !== null && pick !== undefined && !p.options.some(function (o) { return o.id === pick; })) throw fail(400, 'No such option.');
    if (r.tie && !pick) throw fail(409, 'It’s a tie - pick the winner to close it.', { code: 'tie' });
    p.closed = true;
    p.pick = pick || r.winner || null;
    touch(p, now);
  }
  /** A member sees the counts once they have voted, or once it has closed. */
  function pollView(p, memberIds, me, canRun) {
    var voted = Boolean(me) && Boolean(p.votes && p.votes[me] && p.votes[me].length);
    var show = voted || p.closed;
    var v = {
      id: p.id, question: p.question, closed: Boolean(p.closed), createdAt: p.createdAt, v: p.v || 0,
      options: p.options.map(function (o) { return { id: o.id, text: o.text, crawl: o.crawl || null, mine: Boolean(me) && o.addedBy === me }; }),
      myVote: voted ? p.votes[me].slice() : [], voted: voted, canRun: Boolean(canRun),
      voters: Object.keys(p.votes || {}).filter(function (m) { return memberIds.indexOf(m) >= 0 && p.votes[m].length; }).length,
    };
    if (show) v.results = pollResults(p, memberIds);
    return v;
  }

  /* ------------------------------------------------------------------ *
   * Cellar & Swap: what each member has and wants, matched across the
   * crew; swaps in person; gifts bought from a licensed seller; and a
   * friendly tally of who owes whom a beer. The legal version, by design:
   * Flight never arranges shipping between people, never handles money and
   * never asks for an address - there is no field for any of them.
   *
   * One document per member's lists (`cellars/<crewId>_<memberId>`): their
   * haves, their wants, the gifts made TO them (a claim lives on the wish
   * it answers) and the "squared up" marks they made. Each swap is its own
   * document. Every write is a transaction on one of those, so two phones
   * editing at once both stick. Matches and the IOU tally are worked out
   * on read and never stored.
   * ------------------------------------------------------------------ */

  var SIZES = [['can', 'Can'], ['bottle', 'Bottle'], ['crowler', 'Crowler'], ['growler', 'Growler']].map(function (r) { return { id: r[0], name: r[1] }; });
  var SIZE_IDS = SIZES.map(function (s) { return s.id; });
  var SELLER_SHIPS = ['yes', 'no', 'unsure'];
  var SWAP_ACTIONS = ['accept', 'decline', 'cancel', 'swapped', 'unswapped'];
  var MATCH_KINDS = ['two-way', 'one-way', 'brewery', 'style'];
  function sizeName(id) { for (var i = 0; i < SIZES.length; i++) if (SIZES[i].id === id) return SIZES[i].name; return ''; }
  function iso(t) { return new Date(t).toISOString(); }

  /** Folds case, accents, punctuation and "&", so "Fog Lantern" typed on
   *  one phone meets "fog-lantern" on another (Hopscotch's rule, written
   *  again here). Letters of any script survive - a name in kanji is not
   *  folded to nothing - and punctuation alone folds to nothing. */
  function foldText(v) {
    var s = typeof v === 'string' ? v : '';
    if (s.length > 400) s = s.slice(0, 400);
    return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  // "Tidewater" typed by hand and "Tidewater Brewing Co." from a can are the
  // same place. Only the corporate words go - never "beer" or "ale", which
  // are sometimes the name.
  var BREWERY_NOISE = /\b(the|brewing|brewery|breweries|brewers|brewhouse|company|co|llc|inc|ltd)\b/g;
  function breweryKey(name) {
    var plain = foldText(name);
    return plain.replace(BREWERY_NOISE, ' ').replace(/\s+/g, ' ').trim() || plain;
  }
  function beerKey(brewery, name) { var b = foldText(name); return b ? breweryKey(brewery) + '|' + b : ''; }

  /** How well a wish meets a bottle: 3 the same beer (same name, and the
   *  same brewery when both say one), 2 the same brewery, 1 the same style,
   *  0 nothing. */
  function matchLevel(want, have) {
    var wn = foldText(want.name), hn = foldText(have.name);
    var wb = breweryKey(want.brewery), hb = breweryKey(have.brewery);
    if (wn && wn === hn && (!wb || !hb || wb === hb)) return 3;
    if (wb && wb === hb) return 2;
    if (want.style && want.style !== 'other' && want.style === have.style) return 1;
    return 0;
  }

  var LINK_MSG = 'Paste an https link to the brewery’s own shop or a licensed retailer - or leave it blank.';
  /** "Where to buy it legally": an https link the member pasted. Never
   *  fetched by anyone - it is only drawn, as a link. http, javascript:,
   *  data:, a link with a user name or password in it, a bare word, or
   *  anything over 300 characters is refused. Blank is no link. */
  function cleanLink(v) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throw fail(400, LINK_MSG);
    var s = v.trim();
    if (!s) return null;
    if (s.length > LIMITS.link || !/^https:\/\//i.test(s) || /[\s<>"'`\\\u0000-\u001f\u007f-\u009f]/.test(s) || s.replace(STRIP, '') !== s) throw fail(400, LINK_MSG);
    var u;
    try { u = new URL(s); } catch (e) { throw fail(400, LINK_MSG); }
    if (u.protocol !== 'https:' || u.username || u.password || !/^[a-z0-9.-]+$/i.test(u.hostname) || u.hostname.indexOf('.') < 1 || /\.$/.test(u.hostname)) throw fail(400, LINK_MSG);
    if (u.href.length > LIMITS.link) throw fail(400, LINK_MSG);
    return u.href;
  }
  /** The host a link goes to, for showing beside it ("shop.example"). */
  function linkHost(href) {
    try { return new URL(href).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  function cleanCount(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'string' ? Number(v.trim()) : v;
    if (typeof n !== 'number' || !isFinite(n) || Math.floor(n) !== n || n < 1 || n > LIMITS.itemCount) throw fail(400, 'Count is a whole number from 1 to ' + LIMITS.itemCount + '.');
    return n;
  }

  /** One line of a cellar or a wishlist, as typed. `prev` is the line being
   *  edited: a field the input leaves out keeps its old value. There is no
   *  price, no payment, no address and no shipping field - by design. */
  function cleanItem(input, list, prev) {
    input = input || {};
    prev = prev || {};
    function pick(k) { return has(input, k) ? input[k] : prev[k]; }
    var name = clean(pick('name'), LIMITS.beerName);
    if (!/[\p{L}\p{N}]/u.test(name)) throw fail(400, 'Give the beer a name.');
    var style = pick('style');
    if (style !== null && style !== undefined && style !== '' && !cleanStyle(style)) throw fail(400, 'Pick a style from the list.');
    var size = pick('size');
    if (size !== null && size !== undefined && size !== '' && SIZE_IDS.indexOf(size) < 0) throw fail(400, 'Pick can, bottle, crowler or growler.');
    var out = {
      name: name, brewery: clean(pick('brewery'), LIMITS.brewery), style: cleanStyle(style),
      size: SIZE_IDS.indexOf(size) >= 0 ? size : null, count: cleanCount(pick('count')), note: clean(pick('note'), LIMITS.note),
    };
    if (list === 'haves') out.swap = pick('swap') === true;
    else {
      out.buyLink = cleanLink(pick('buyLink'));
      var sh = pick('sellerShips');
      out.sellerShips = SELLER_SHIPS.indexOf(sh) >= 0 ? sh : null;
    }
    return out;
  }

  function newCellar(crewId, mid, now) {
    return { crewId: crewId, member: mid, haves: [], wants: [], gifts: [], squares: [], createdAt: iso(now), updatedAt: iso(now), v: 0 };
  }
  function cellarList(list) {
    if (list !== 'haves' && list !== 'wants') throw fail(404, 'Not a list.');
    return list;
  }
  /** Only you write your own lists. */
  function ownCellar(doc, actor) {
    if (!actor || !actor.mid) throw fail(403, 'Join the crew first.');
    if (doc.member !== actor.mid) throw fail(403, 'That’s not your list.');
  }
  function findItem(doc, iid) {
    var lists = ['haves', 'wants'];
    for (var i = 0; i < lists.length; i++) {
      var arr = doc[lists[i]] || [];
      for (var j = 0; j < arr.length; j++) if (arr[j].id === iid) return { list: lists[i], item: arr[j], index: j };
    }
    return null;
  }
  function itemOf(id, it, list, at) {
    var out = { id: id, name: it.name, brewery: it.brewery, style: it.style, size: it.size, count: it.count, note: it.note };
    if (list === 'haves') out.swap = it.swap;
    else { out.buyLink = it.buyLink; out.sellerShips = it.sellerShips; }
    out.at = at;
    return out;
  }

  function addItem(doc, actor, list, input, now, ids) {
    ownCellar(doc, actor);
    cellarList(list);
    var max = list === 'haves' ? LIMITS.haves : LIMITS.wants;
    if ((doc[list] || []).length >= max) throw fail(409, (list === 'haves' ? 'Your cellar' : 'Your wishlist') + ' holds ' + max + ' beers. Take one off first.');
    var it = itemOf(ids.item(), cleanItem(input, list), list, iso(now));
    doc[list] = (doc[list] || []).concat([it]);
    touch(doc, now);
    return it;
  }
  function editItem(doc, actor, iid, input, now) {
    ownCellar(doc, actor);
    var f = findItem(doc, iid);
    if (!f) throw fail(404, 'That beer isn’t on your list any more.');
    var it = itemOf(f.item.id, cleanItem(input, f.list, f.item), f.list, f.item.at);
    doc[f.list][f.index] = it;
    touch(doc, now);
    return it;
  }
  /** Take a line off. A wish someone is gifting goes with its claim - the
   *  gift was never bought through Flight, so there is nothing to undo. */
  function removeItem(doc, actor, iid, now) {
    ownCellar(doc, actor);
    var f = findItem(doc, iid);
    if (!f) throw fail(404, 'That beer isn’t on your list any more.');
    doc[f.list] = doc[f.list].filter(function (x) { return x.id !== iid; });
    if (f.list === 'wants') doc.gifts = (doc.gifts || []).filter(function (g) { return !(g.want === iid && !g.arrivedAt); });
    touch(doc, now);
  }

  /* ---- gifts: through a licensed seller, never person to person ---- */

  function activeGift(doc, wantId) {
    var gs = doc.gifts || [];
    for (var i = 0; i < gs.length; i++) if (gs[i].want === wantId && !gs[i].arrivedAt) return gs[i];
    return null;
  }
  /** Keep a list within `max` by dropping its oldest settled records (the
   *  ones `done` says are finished); refuses when only open ones are left. */
  function prune(arr, max, done) {
    var out = arr.slice();
    while (out.length >= max) {
      var k = -1;
      for (var i = 0; i < out.length; i++) if (done(out[i])) { k = i; break; }
      if (k < 0) return null;
      out.splice(k, 1);
    }
    return out;
  }
  /** "I'll gift this": someone else in the crew claims a wish that has a
   *  seller's link. One claimer at a time; never your own wish. The order
   *  itself happens at the seller, to the friend's address - Flight never
   *  sees the address, the order or the money. */
  function claimGift(doc, actor, wantId, now, ids) {
    if (!actor || !actor.mid) throw fail(403, 'Join the crew first.');
    var w = (doc.wants || []).filter(function (x) { return x.id === wantId; })[0];
    if (!w) throw fail(404, 'That’s not on their wishlist any more.');
    if (doc.member === actor.mid) throw fail(409, 'That’s your own wish - you can’t gift it to yourself.');
    if (!w.buyLink) throw fail(409, 'Gifts go through a licensed seller, and this wish has no link to one yet.');
    var g = activeGift(doc, wantId);
    if (g) throw fail(409, g.by === actor.mid ? 'You’re already on it.' : 'Someone’s already on this one.');
    var kept = prune(doc.gifts || [], LIMITS.giftsKept, function (x) { return Boolean(x.arrivedAt); });
    if (!kept) throw fail(409, 'Too many gifts on the way at once.');
    var gift = { id: ids.gift(), want: wantId, by: actor.mid, name: w.name, brewery: w.brewery, claimedAt: iso(now), arrivedAt: null };
    doc.gifts = kept.concat([gift]);
    touch(doc, now);
    return gift;
  }
  function unclaimGift(doc, actor, wantId, now) {
    var g = activeGift(doc, wantId);
    if (!g) throw fail(404, 'Nobody’s on that one.');
    if (!actor || g.by !== actor.mid) throw fail(403, 'Only whoever claimed it can let it go.');
    doc.gifts = doc.gifts.filter(function (x) { return x !== g; });
    touch(doc, now);
  }
  /** The recipient says it came. The wish comes off the list; the gift is
   *  kept, because the crew's IOU tally is worked out from it. */
  function giftArrived(doc, actor, wantId, now) {
    if (!actor || !actor.mid || doc.member !== actor.mid) throw fail(403, 'Only whoever wished for it can say it arrived.');
    var g = activeGift(doc, wantId);
    if (!g) throw fail(409, 'Nobody’s on that one yet.');
    g.arrivedAt = iso(now);
    doc.wants = (doc.wants || []).filter(function (x) { return x.id !== wantId; });
    touch(doc, now);
  }

  /* ---- swaps: in person only ---- */

  function swapOpen(w) { return w.state === 'proposed' || w.state === 'accepted'; }
  /** The beers on one side of a swap, picked from a list by id, copied as
   *  they are now (the swap still reads if the line is edited later). */
  function pickLines(picks, items, theirs) {
    if (picks === null || picks === undefined) return [];
    if (!Array.isArray(picks)) throw fail(400, 'Pick beers from the lists.');
    var out = [], seen = {};
    picks.slice(0, 40).forEach(function (p) {
      var id = typeof p === 'string' ? p : (p && typeof p.item === 'string' ? p.item : '');
      if (seen[id]) return;
      var it = (items || []).filter(function (x) { return x.id === id; })[0];
      if (!it) throw fail(400, 'That beer isn’t on the list any more.');
      if (theirs && !it.swap) throw fail(409, 'They haven’t marked ' + it.name + ' open to swap.');
      var max = it.count || 12;
      var n = p && typeof p === 'object' && has(p, 'n') ? Number(p.n) : 1;
      if (!isFinite(n) || Math.floor(n) !== n || n < 1 || n > max) throw fail(400, 'How many of ' + it.name + '? Up to ' + max + '.');
      seen[id] = true;
      out.push({ item: it.id, name: it.name, brewery: it.brewery, style: it.style, size: it.size, n: n });
    });
    if (out.length > LIMITS.swapLines) throw fail(400, LIMITS.swapLines + ' beers a side is plenty.');
    return out;
  }
  /**
   * A proposal: what I give (from my cellar), what I get (from their
   * open-to-swap cellar) - either side may be empty ("nothing back, a
   * gift"), not both - and where: a tasting the crew has on (`session`, not
   * yet revealed) or a few words. No price, no address, no shipping.
   */
  function newSwap(input, actor, mine, theirs, memberIds, session, now) {
    input = input || {};
    if (!actor || !actor.mid) throw fail(403, 'Join the crew first.');
    var to = input.to;
    if (typeof to !== 'string' || memberIds.indexOf(to) < 0) throw fail(400, 'Pick someone in the crew.');
    if (to === actor.mid) throw fail(400, 'Swapping with yourself? Pick someone else.');
    var give = pickLines(input.give, mine ? mine.haves : [], false);
    var get = pickLines(input.get, theirs ? theirs.haves : [], true);
    if (!give.length && !get.length) throw fail(400, 'Pick at least one beer to give or get.');
    var wantSession = input.session !== null && input.session !== undefined && input.session !== '';
    if (wantSession && !session) throw fail(400, 'That tasting isn’t in this crew.');
    if (session && session.kind !== 'blind') throw fail(409, 'A Same-Can Challenge is played apart - pick a tasting in one room, or say where.');
    if (session && stageOf(session, now) === 'revealed') throw fail(409, 'That tasting is over - pick another, or say where.');
    var where = clean(input.where, LIMITS.swapWhere);
    return {
      from: actor.mid, to: to, give: give, get: get,
      where: session ? '' : (where || 'At our next tasting'),
      session: session ? session.id : null, sessionTitle: session ? clean(session.title, LIMITS.title) : null,
      state: 'proposed', ticks: {}, createdAt: iso(now), updatedAt: iso(now), decidedAt: null, doneAt: null, v: 1,
    };
  }
  /**
   * proposed -> accepted | declined (whoever it was offered to) | cancelled
   * (whoever proposed it); accepted -> done (both tick "swapped") |
   * cancelled (either). Only the two of them can act; to anyone else it
   * does not exist. A closed swap stays closed.
   */
  function swapAct(w, actor, action, now) {
    if (!actor || !actor.mid || (actor.mid !== w.from && actor.mid !== w.to)) throw fail(404, 'No such swap.');
    if (SWAP_ACTIONS.indexOf(action) < 0) throw fail(404, 'No such swap.');
    if (!swapOpen(w)) throw fail(409, 'That swap is ' + (w.state === 'done' ? 'done' : w.state) + ' - nothing more to do.');
    var at = iso(now);
    w.ticks = w.ticks || {};
    if (action === 'accept' || action === 'decline') {
      if (w.state !== 'proposed') throw fail(409, 'It’s already been accepted.');
      if (actor.mid !== w.to) throw fail(403, action === 'accept' ? 'You can’t accept your own proposal.' : 'It’s yours - cancel it instead.');
      w.state = action === 'accept' ? 'accepted' : 'declined';
      w.decidedAt = at;
    } else if (action === 'cancel') {
      if (w.state === 'proposed' && actor.mid !== w.from) throw fail(403, 'Decline it instead.');
      w.state = 'cancelled';
      w.decidedAt = at;
    } else {
      if (w.state !== 'accepted') throw fail(409, 'Accept it first - then tick it once you’ve swapped.');
      if (action === 'swapped') w.ticks[actor.mid] = at; else delete w.ticks[actor.mid];
      if (w.ticks[w.from] && w.ticks[w.to]) { w.state = 'done'; w.doneAt = at; }
    }
    touch(w, now);
    return w;
  }

  /* ---- friendly IOUs: counts, never money ---- */

  function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
  /**
   * The tally between every pair, worked out from what is stored and never
   * stored itself: an arrived gift means its recipient owes the giver one;
   * a one-sided swap that is done means whoever received owes whoever gave
   * one; a "squared up" mark takes one off whichever way it leans (and
   * does nothing once it is level). In time order, so the same records give
   * the same numbers on every phone. `t['a|b'] > 0`: a owes b that many.
   */
  function tallies(cellars, swaps, memberIds) {
    var inCrew = {};
    memberIds.forEach(function (m) { inCrew[m] = true; });
    var ev = [];
    (cellars || []).forEach(function (c) {
      if (!inCrew[c.member]) return;
      (c.gifts || []).forEach(function (g) { if (g.arrivedAt && inCrew[g.by] && g.by !== c.member) ev.push({ at: g.arrivedAt, id: g.id, owes: c.member, to: g.by }); });
      (c.squares || []).forEach(function (q) { if (inCrew[q.with] && q.with !== c.member) ev.push({ at: q.at, id: q.id, a: c.member, b: q.with, square: true }); });
    });
    (swaps || []).forEach(function (w) {
      if (w.state !== 'done' || !inCrew[w.from] || !inCrew[w.to]) return;
      var gives = (w.give || []).length, gets = (w.get || []).length;
      if (gives && !gets) ev.push({ at: w.doneAt, id: w.id, owes: w.to, to: w.from });
      else if (!gives && gets) ev.push({ at: w.doneAt, id: w.id, owes: w.from, to: w.to });
    });
    ev.sort(function (x, y) { return String(x.at).localeCompare(String(y.at)) || String(x.id).localeCompare(String(y.id)); });
    var t = {};
    ev.forEach(function (e) {
      if (e.square) {
        var k = pairKey(e.a, e.b), v = t[k] || 0;
        if (v > 0) t[k] = v - 1; else if (v < 0) t[k] = v + 1;
        return;
      }
      var k2 = pairKey(e.owes, e.to);
      t[k2] = (t[k2] || 0) + (e.owes < e.to ? 1 : -1);
    });
    return t;
  }
  /** > 0: `other` owes `me` that many beers; < 0: I owe them. */
  function owedBetween(t, me, other) {
    var v = t[pairKey(me, other)] || 0;
    return (me < other ? -v : v) || 0;
  }
  /** "Squared up": either side marks one beer settled. Refused when the two
   *  are already level (`net` is what the tally says now). */
  function squareUp(doc, actor, withMid, net, memberIds, now, ids) {
    ownCellar(doc, actor);
    if (typeof withMid !== 'string' || withMid === actor.mid || memberIds.indexOf(withMid) < 0) throw fail(400, 'Pick someone in the crew.');
    if (!net) throw fail(409, 'You two are square already.');
    var kept = prune(doc.squares || [], LIMITS.squaresKept, function () { return true; });
    doc.squares = kept.concat([{ id: ids.square(), with: withMid, at: iso(now) }]);
    touch(doc, now);
  }

  /* ---- matches ---- */

  function bestLines(wants, haves) {
    var out = [];
    wants.forEach(function (w) {
      var best = null, lvl = 0;
      haves.forEach(function (h) { var l = matchLevel(w, h); if (l > lvl) { lvl = l; best = h; } });
      if (best) out.push({ want: w.id, wantName: w.name, have: best.id, haveName: best.name, haveBrewery: best.brewery, haveStyle: best.style, level: lvl });
    });
    return out;
  }
  /**
   * My wants against everyone else's open-to-swap cellar, and their wants
   * against mine. Per crew-mate: "two-way" when each has a beer the other
   * wants, "one-way" when only one side does, then the weaker "same
   * brewery" and "same style". A wish someone is already gifting is left
   * out. Two-way first, then one-way, then brewery, then style; within a
   * kind, more beers first, then the member id - deterministic.
   */
  function cellarMatches(byMember, me, memberIds) {
    var empty = { haves: [], wants: [], gifts: [] };
    var mine = byMember[me] || empty;
    var open = function (c) { return (c.haves || []).filter(function (h) { return h.swap; }); };
    var wishes = function (c) { return (c.wants || []).filter(function (w) { return !activeGift(c, w.id); }); };
    var myWants = wishes(mine), myHaves = open(mine);
    var out = [];
    memberIds.forEach(function (m) {
      if (m === me || !byMember[m]) return;
      var c = byMember[m];
      var gets = bestLines(myWants, open(c));
      var gives = bestLines(wishes(c), myHaves);
      var top = function (arr) { return arr.reduce(function (a, x) { return Math.max(a, x.level); }, 0); };
      var g = top(gets), v = top(gives);
      var kind = g === 3 && v === 3 ? 'two-way' : (g === 3 || v === 3 ? 'one-way' : (Math.max(g, v) === 2 ? 'brewery' : (Math.max(g, v) === 1 ? 'style' : null)));
      if (!kind) return;
      var lvl = { 'two-way': 3, 'one-way': 3, brewery: 2, style: 1 }[kind];
      var only = function (arr) { return arr.filter(function (x) { return x.level === lvl; }); };
      out.push({ member: m, kind: kind, gets: only(gets), gives: only(gives) });
    });
    out.sort(function (a, b) {
      return (MATCH_KINDS.indexOf(a.kind) - MATCH_KINDS.indexOf(b.kind)) || ((b.gets.length + b.gives.length) - (a.gets.length + a.gives.length)) || String(a.member).localeCompare(String(b.member));
    });
    return out.slice(0, LIMITS.matches);
  }

  /* ---- what one member sees ---- */

  function swapView(w, me, canSee) {
    var outgoing = w.from === me;
    var other = outgoing ? w.to : w.from;
    var open = swapOpen(w);
    var ticks = w.ticks || {};
    return {
      id: w.id, from: w.from, to: w.to, with: other, outgoing: outgoing,
      give: outgoing ? w.give : w.get, get: outgoing ? w.get : w.give,
      where: w.where || '', session: w.session || null, sessionTitle: w.sessionTitle || null,
      state: w.state, createdAt: w.createdAt, decidedAt: w.decidedAt || null, doneAt: w.doneAt || null,
      myTick: Boolean(ticks[me]), theirTick: Boolean(ticks[other]),
      can: {
        accept: canSee && w.state === 'proposed' && !outgoing,
        decline: canSee && w.state === 'proposed' && !outgoing,
        cancel: canSee && open && (w.state === 'accepted' || outgoing),
        tick: canSee && w.state === 'accepted',
      },
    };
  }
  /**
   * The Cellar tab, for one member: every crew-mate's cellar and wishlist
   * (with who is gifting what), my matches, my own swaps (another pair's
   * open or declined swap is theirs alone), the crew's feed of completed
   * swaps and arrived gifts, and my IOUs. A free-typed "where" stays
   * between the two people; the feed names a tasting, never a place.
   */
  function cellarView(cellars, swaps, memberIds, me, now) {
    var inCrew = {};
    memberIds.forEach(function (m) { inCrew[m] = true; });
    var byMember = {};
    (cellars || []).forEach(function (c) { if (inCrew[c.member]) byMember[c.member] = c; });
    swaps = (swaps || []).filter(function (w) { return inCrew[w.from] && inCrew[w.to]; });
    var members = memberIds.map(function (m) {
      var c = byMember[m] || { haves: [], wants: [], gifts: [] };
      return {
        member: m,
        haves: (c.haves || []).map(function (h) { return itemOf(h.id, h, 'haves', h.at); }),
        wants: (c.wants || []).map(function (w) {
          var it = itemOf(w.id, w, 'wants', w.at);
          var g = activeGift(c, w.id);
          it.gift = g && inCrew[g.by] ? { by: g.by, claimedAt: g.claimedAt } : null;
          return it;
        }),
      };
    });
    var mineSwaps = [];
    if (me) {
      var involved = swaps.filter(function (w) { return w.from === me || w.to === me; })
        .sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.id).localeCompare(String(b.id)); });
      var openOnes = involved.filter(swapOpen), closed = involved.filter(function (w) { return !swapOpen(w); }).slice(0, 8);
      mineSwaps = openOnes.concat(closed).map(function (w) { return swapView(w, me, true); });
    }
    var feed = [];
    swaps.forEach(function (w) {
      if (w.state !== 'done') return;
      feed.push({ kind: 'swap', id: w.id, at: w.doneAt, from: w.from, to: w.to, give: w.give.map(function (l) { return l.name; }), get: w.get.map(function (l) { return l.name; }), sessionTitle: w.sessionTitle || null });
    });
    Object.keys(byMember).forEach(function (m) {
      (byMember[m].gifts || []).forEach(function (g) {
        if (g.arrivedAt && inCrew[g.by]) feed.push({ kind: 'gift', id: g.id, at: g.arrivedAt, from: g.by, to: m, give: [g.name], get: [], sessionTitle: null });
      });
    });
    feed.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)) || String(a.id).localeCompare(String(b.id)); });
    var t = tallies(cellars, swaps, memberIds);
    var ious = me ? memberIds.filter(function (m) { return m !== me; }).map(function (m) { return { member: m, n: owedBetween(t, me, m) }; }).filter(function (x) { return x.n; }) : [];
    return {
      members: members,
      matches: me ? cellarMatches(byMember, me, memberIds) : [],
      swaps: mineSwaps,
      feed: feed.slice(0, LIMITS.feed),
      ious: ious,
      open: swaps.filter(swapOpen).length,
    };
  }

  /** A member leaving or removed, seen from someone else's lists: the gifts
   *  they claimed or gave and the squared-up marks naming them go. (Their
   *  own lists and every swap they are in are deleted outright.) */
  function scrubCellar(doc, mid) {
    var g0 = (doc.gifts || []).length, q0 = (doc.squares || []).length;
    doc.gifts = (doc.gifts || []).filter(function (g) { return g.by !== mid; });
    doc.squares = (doc.squares || []).filter(function (q) { return q.with !== mid; });
    return doc.gifts.length !== g0 || doc.squares.length !== q0;
  }

  return {
    LIMITS: LIMITS, POINTS: POINTS, FAMILIES: FAMILIES, STYLES: STYLES, STYLE_IDS: STYLE_IDS, OTHER: OTHER, HOPPY: HOPPY,
    CHIPS: CHIPS, EMOJI: EMOJI, AWARDS: AWARDS, LETTERS: LETTERS,
    styleName: styleName, familyOf: familyOf, familyName: familyName, stylePoints: stylePoints,
    clean: clean, cleanName: cleanName, cleanEmoji: cleanEmoji, cleanStars: cleanStars, cleanAbv: cleanAbv, cleanStyle: cleanStyle, cleanChips: cleanChips, cleanBeer: cleanBeer,
    abvText: abvText, starsText: starsText, nameList: nameList, fail: fail, shortId: shortId, halfStar: halfStar, awardDef: awardDef,
    stageOf: stageOf, scoringOpen: scoringOpen, knows: knows, isHome: isHome, weekendWindow: weekendWindow, cleanWindow: cleanWindow,
    newSession: newSession, mayRun: mayRun, addBeer: addBeer, editBeer: editBeer, removeBeer: removeBeer, startTasting: startTasting,
    setScore: setScore, setGuess: setGuess, setCity: setCity, reveal: reveal, scrubMember: scrubMember,
    results: results, recap: recap, sessionView: sessionView, sessionSummary: sessionSummary, settledAt: settledAt, board: board,
    newPoll: newPoll, addOption: addOption, removeOption: removeOption, vote: vote, pollResults: pollResults, closePoll: closePoll, pollView: pollView,
    SIZES: SIZES, SELLER_SHIPS: SELLER_SHIPS, SWAP_ACTIONS: SWAP_ACTIONS, MATCH_KINDS: MATCH_KINDS, sizeName: sizeName,
    foldText: foldText, breweryKey: breweryKey, beerKey: beerKey, matchLevel: matchLevel, cleanLink: cleanLink, linkHost: linkHost,
    cleanCount: cleanCount, cleanItem: cleanItem, newCellar: newCellar, cellarList: cellarList, findItem: findItem,
    addItem: addItem, editItem: editItem, removeItem: removeItem, activeGift: activeGift, claimGift: claimGift, unclaimGift: unclaimGift, giftArrived: giftArrived,
    swapOpen: swapOpen, newSwap: newSwap, swapAct: swapAct, tallies: tallies, owedBetween: owedBetween, squareUp: squareUp,
    cellarMatches: cellarMatches, cellarView: cellarView, scrubCellar: scrubCellar,
  };
});
