/* Pencil - the rules, in one file, run three times: in the page
 * (window.PencilCore), on the server and in the tests (require).
 *
 * Text cleaning, ids and codes, the game catalogue, seven scoring engines
 * (Any game and its presets, Five dice, Bowling, Darts, Hearts, Cribbage,
 * Mini golf), who is ahead and who won, undo and redo, late players,
 * highlights, the history and its stats (wins, streaks, records, head to
 * head), the CSV and JSON, the one door every stored or received game goes
 * through (cleanGame), what a shared table holds, the score-sheet reader's
 * request and answer, the recap card's text fitting, and the made-up game
 * night.
 *
 * NO CLOCK AND NO DICE: "now" and every new id are handed in (tested), so
 * the same input gives the same output on every phone and on the server.
 * The made-up night is the same every time.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PencilCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    sides: 12,          // players or teams at one table
    teamSize: 4,        // people on one team
    rounds: 200,        // rounds, hands, turns or holes a game keeps
    name: 20,           // a first name
    gameName: 30,       // a game's own name ("Spades night")
    note: 120,          // a round note
    groupName: 24,      // "Thursday crew"
    groups: 12,
    people: 80,         // recent players on one phone
    history: 1000,      // finished games remembered (as summaries)
    fullGames: 40,      // finished games kept whole, to reopen
    live: 12,           // games in progress on one phone
    undo: 60,           // steps of undo
    watchers: 20,       // phones watching a shared table
    score: 99999,       // the largest number a cell takes
    minScore: -99999,
    aiRows: 60, aiCols: 12, aiMin: -9999, aiMax: 99999, aiName: 20, aiNote: 160,
    aiImageBytes: 1024 * 1024, aiImageSide: 1600,
    idleHours: 24,      // a shared table nobody touched for a day is gone
  };

  function fail(status, message, extra) {
    var e = new Error(message);
    e.status = status; e.expose = true;
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    return e;
  }

  /* ------------------------------------------------------------------ *
   * Text
   * ------------------------------------------------------------------ */

  // Control characters, zero-width and bidirectional marks: nothing a person
  // means to type in a name, and the bidi ones can turn "Noor" into a lie.
  var INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  /** One plain line: invisible characters gone, whitespace folded, cut on a
   *  whole character. */
  function line(v, max) {
    var s = str(v).slice(0, (max || 200) * 8).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    var cps = Array.from(s);
    return cps.length > max ? cps.slice(0, max).join('').trim() : s;
  }
  /** A line with markup removed too. */
  function plain(v, max) {
    var s = str(v).slice(0, (max || 200) * 8).replace(/<[^>]*>?/g, ' ').replace(/[<>]/g, ' ');
    return line(s, max);
  }
  /** Plain, with anything that looks like a link taken out (for model text). */
  function plainOut(v, max) {
    var s = str(v).slice(0, (max || 200) * 8).replace(/<[^>]*>?/g, ' ').replace(/[<>]/g, ' ')
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' ').replace(/\bwww\.\S*/gi, ' ').replace(/\bjavascript:\S*/gi, ' ')
      .replace(/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|ai|co|uk|us|info|biz|xyz|app|dev|example|ly|me|gg|tv)\b\S*/gi, ' ');
    return line(s, max);
  }
  function esc(v) {
    return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function norm(v) { return line(v, 80).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  /** A first name: letters (any script), spaces, hyphens and apostrophes;
   *  no digits, no markup. Empty when nothing is left. */
  function cleanName(v, max) {
    var s = plain(v, (max || LIMITS.name) * 2).replace(/[^\p{L}\p{M}' \u2019.-]/gu, ' ').replace(/\s+/g, ' ').replace(/^[ '.\u2019-]+|[ '.\u2019-]+$/g, '').trim();
    var cps = Array.from(s).slice(0, max || LIMITS.name);
    s = cps.join('').trim();
    return /\p{L}/u.test(s) ? s : '';
  }
  function cleanNote(v) { return plain(v, LIMITS.note); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function possessive(name) { return name + '\u2019s'; }
  function listNames(names) {
    if (names.length <= 1) return names.join('');
    if (names.length === 2) return names[0] + ' and ' + names[1];
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  function iso(ms) { return new Date(ms).toISOString(); }
  function isIso(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) && isFinite(Date.parse(v)); }
  function intIn(v, lo, hi) {
    var n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*[+-]?\d{1,6}\s*$/.test(v) ? Number(v) : NaN);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
  }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function own(o, k) { return Boolean(o) && Object.prototype.hasOwnProperty.call(o, k); }

  /* ------------------------------------------------------------------ *
   * Ids and codes
   * ------------------------------------------------------------------ */

  var ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
  /** A new id: a letter for its kind and `n` random characters. */
  function newId(rand, n, prefix) {
    var s = prefix || '';
    for (var i = 0; i < (n || 8); i++) s += ID_CHARS[rand(ID_CHARS.length)];
    return s;
  }
  function isId(v) { return typeof v === 'string' && /^[a-z][a-z0-9]{5,15}$/.test(v); }
  /** An id not already used in `taken` (a list or a set-like object). */
  function freshId(rand, prefix, taken, n) {
    var has = function (x) { return Array.isArray(taken) ? taken.indexOf(x) >= 0 : own(taken, x); };
    for (var i = 0; i < 8; i++) { var id = newId(rand, n || 8, prefix); if (!has(id)) return id; }
    throw fail(503, 'Could not make a new id. Try again.');
  }
  // Join codes: no I, O, 0 or 1, so nobody reads one for the other.
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var CODE_LEN = 6;
  function normalizeCode(v) { return str(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
  function isCode(v) { return typeof v === 'string' && v.length === CODE_LEN && v.split('').every(function (c) { return CODE_ALPHABET.indexOf(c) >= 0; }); }
  function formatCode(v) { var c = normalizeCode(v); return c.slice(0, 3) + '-' + c.slice(3); }
  function isTid(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{16}$/.test(v); }

  // A fixed set: a person picks one, nobody types one, so nothing odd ever
  // reaches a page through an emoji.
  var EMOJI = ['\u{1F98A}', '\u{1F43B}', '\u{1F33B}', '\u{1F680}', '\u{1F422}', '\u{1F3B8}', '\u{1F431}', '\u{1F436}', '\u{1F989}', '\u{1F419}', '\u{1F335}', '\u{1F344}',
    '\u{1F355}', '\u{1F369}', '\u{1F34B}', '\u{1F352}', '\u{1F308}', '\u{2B50}', '\u{1F525}', '\u{1F48E}', '\u{1F3A9}', '\u{1F451}', '\u{1F47E}', '\u{1F916}'];
  function cleanEmoji(v, fallback) { return EMOJI.indexOf(v) >= 0 ? v : (fallback === undefined ? EMOJI[0] : fallback); }

  /* ------------------------------------------------------------------ *
   * The games
   * ------------------------------------------------------------------ */

  // Generic names only: these are games, not anybody's brand.
  var GAMES = [
    { id: 'hearts', kind: 'hearts', name: 'Hearts', emoji: '\u2665\uFE0F', blurb: 'Lowest wins. Every hand adds to 26; shoot the moon in one tap.', min: 3, max: 6 },
    { id: 'dice', kind: 'dice', name: 'Five dice', emoji: '\u{1F3B2}', blurb: 'The 13-box sheet. Tap the dice and it shows what each box would score.', min: 1, max: 12 },
    { id: 'rummy', kind: 'any', preset: 'rummy', name: 'Rummy', emoji: '\u{1F0CF}', blurb: 'Highest wins, first to 500. The dealer moves round.', min: 2, max: 8 },
    { id: 'bowling', kind: 'bowling', name: 'Bowling', emoji: '\u{1F3B3}', blurb: 'Ten frames, strikes and spares worked out. Tap the pins.', min: 1, max: 12 },
    { id: 'darts', kind: 'darts', name: 'Darts 501', emoji: '\u{1F3AF}', blurb: '501 or 301, busts called, checkouts suggested.', min: 1, max: 12 },
    { id: 'cribbage', kind: 'cribbage', name: 'Cribbage', emoji: '\u{1F4CC}', blurb: 'To 121 on a drawn peg board; skunks called.', min: 2, max: 3 },
    { id: 'golf', kind: 'golf', name: 'Mini golf', emoji: '\u26F3', blurb: '9 or 18 holes, par if you like, a stroke limit per hole.', min: 1, max: 12 },
    { id: 'euchre', kind: 'any', preset: 'euchre', name: 'Euchre', emoji: '\u2660\uFE0F', blurb: 'Two teams, first to 10.', min: 2, max: 2, teams: true },
    { id: 'cardgolf', kind: 'any', preset: 'cardgolf', name: 'Card golf', emoji: '\u2663\uFE0F', blurb: 'Lowest wins after nine holes.', min: 2, max: 8 },
    { id: 'word', kind: 'any', preset: 'word', name: 'Word game', emoji: '\u{1F524}', blurb: 'A score each turn, highest wins.', min: 2, max: 6 },
    { id: 'any', kind: 'any', preset: 'custom', name: 'Any game', emoji: '\u270F\uFE0F', blurb: 'Your rules: high or low, to a target, a number of rounds, or open.', min: 1, max: 12 },
  ];
  var KINDS = ['any', 'dice', 'bowling', 'darts', 'hearts', 'cribbage', 'golf'];
  var PRESETS = {
    custom: { win: 'high', end: 'open', target: 100, rounds: 10, dealer: false, fillZero: false, quick: [1, 2, 5, 10, 20, 50] },
    rummy: { win: 'high', end: 'target', target: 500, rounds: 10, dealer: true, fillZero: false, quick: [5, 10, 15, 20, 25, 50] },
    cardgolf: { win: 'low', end: 'rounds', target: 100, rounds: 9, dealer: true, fillZero: false, quick: [0, 1, 2, 3, 4, 5, 10] },
    euchre: { win: 'high', end: 'target', target: 10, rounds: 10, dealer: true, fillZero: true, quick: [1, 2, 4] },
    word: { win: 'high', end: 'open', target: 300, rounds: 10, dealer: false, fillZero: false, quick: [5, 10, 15, 20, 30, 50] },
  };
  function gameInfo(id) { for (var i = 0; i < GAMES.length; i++) if (GAMES[i].id === id) return GAMES[i]; return null; }
  /** The catalogue entry a game belongs to. */
  function infoOf(game) {
    if (game.kind === 'any') return gameInfo(game.preset && game.preset !== 'custom' ? game.preset : 'any');
    return gameInfo(game.kind);
  }
  /** The key a game's stats are kept under: its kind, its preset, or for a
   *  game of your own, its name ("Spades"). Mini golf by its holes. */
  function statKey(g) {
    if (g.kind === 'any') return g.preset && g.preset !== 'custom' ? g.preset : 'any:' + (norm(g.name) || 'any game');
    if (g.kind === 'golf') return 'golf' + ((g.settings && g.settings.holes) || g.holes || 9);
    if (g.kind === 'darts') return 'darts' + ((g.settings && g.settings.start) || g.start || 501);
    return g.kind;
  }
  function lowWins(g) {
    if (g.kind === 'hearts' || g.kind === 'golf') return true;
    if (g.kind === 'any') return g.settings.win === 'low';
    if (g.kind === 'darts') return true; // remaining points: fewest left leads
    return false;
  }
  var DEFAULTS = {
    dice: function () { return { extra: true }; },
    bowling: function () { return {}; },
    darts: function () { return { start: 501, doubleOut: true }; },
    hearts: function () { return { endAt: 100, moon: 'add', tie: 'keep', late: 'trail' }; },
    cribbage: function () { return { to: 121, teams: false }; },
    golf: function () { return { holes: 9, max: 6 }; },
  };
  function defaultSettings(kind, preset) {
    if (kind === 'any') {
      var p = PRESETS[preset] || PRESETS.custom;
      return { win: p.win, end: p.end, target: p.target, rounds: p.rounds, dealer: p.dealer, fillZero: p.fillZero, quick: p.quick.slice(), teams: preset === 'euchre', late: 'trail' };
    }
    return DEFAULTS[kind] ? DEFAULTS[kind]() : {};
  }
  function cleanSettings(kind, preset, raw) {
    var d = defaultSettings(kind, preset), r = raw && typeof raw === 'object' ? raw : {};
    var out = {};
    if (kind === 'any') {
      out.win = r.win === 'low' || r.win === 'high' ? r.win : d.win;
      out.end = ['target', 'rounds', 'open'].indexOf(r.end) >= 0 ? r.end : d.end;
      out.target = intIn(r.target, -LIMITS.score, LIMITS.score) === null ? d.target : intIn(r.target, -LIMITS.score, LIMITS.score);
      if (out.target === 0) out.target = d.target;
      out.rounds = intIn(r.rounds, 1, LIMITS.rounds) || d.rounds;
      out.dealer = typeof r.dealer === 'boolean' ? r.dealer : d.dealer;
      out.fillZero = typeof r.fillZero === 'boolean' ? r.fillZero : d.fillZero;
      out.teams = typeof r.teams === 'boolean' ? r.teams : d.teams;
      out.late = r.late === 'zero' ? 'zero' : 'trail';
      var q = Array.isArray(r.quick) ? r.quick.map(function (x) { return intIn(x, -999, 9999); }).filter(function (x) { return x !== null; }) : d.quick;
      out.quick = q.filter(function (x, i) { return q.indexOf(x) === i; }).slice(0, 8);
      if (!out.quick.length) out.quick = d.quick;
    } else if (kind === 'dice') {
      out.extra = typeof r.extra === 'boolean' ? r.extra : d.extra;
    } else if (kind === 'darts') {
      out.start = r.start === 301 || r.start === 501 || r.start === 701 ? r.start : d.start;
      out.doubleOut = typeof r.doubleOut === 'boolean' ? r.doubleOut : d.doubleOut;
    } else if (kind === 'hearts') {
      out.endAt = intIn(r.endAt, 25, 500) || d.endAt;
      out.moon = r.moon === 'subtract' ? 'subtract' : 'add';
      out.tie = r.tie === 'share' ? 'share' : 'keep';
      out.late = r.late === 'zero' ? 'zero' : 'trail';
    } else if (kind === 'cribbage') {
      out.to = 121;
      out.teams = typeof r.teams === 'boolean' ? r.teams : d.teams;
    } else if (kind === 'golf') {
      out.holes = r.holes === 18 ? 18 : 9;
      out.max = intIn(r.max, 2, 12) || d.max;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * People, sides and a new game
   * ------------------------------------------------------------------ */

  /** A person at the table: {id, name, emoji}. */
  function cleanPerson(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = cleanName(raw.name);
    if (!name || !isId(raw.id)) return null;
    return { id: raw.id, name: name, emoji: cleanEmoji(raw.emoji) };
  }
  /** A side is a column of the score sheet: one player, or a team. */
  function sideName(people) { return listNames(people.map(function (p) { return p.name; })); }
  /** A new game. `input`: {game (catalogue id), players: [{id, name, emoji}],
   *  teams: [[i, j], [k, l]] (indices into players, team games only),
   *  settings, name, dealer, group}. */
  function newGame(input, o) {
    var info = gameInfo(input && input.game);
    if (!info) throw fail(400, 'Pick a game.');
    var players = (Array.isArray(input.players) ? input.players : []).map(cleanPerson).filter(Boolean);
    var seen = {};
    players = players.filter(function (p) { var k = norm(p.name); if (seen[p.id] || seen['n' + k]) return false; seen[p.id] = 1; seen['n' + k] = 1; return true; });
    var kind = info.kind, preset = info.preset || '';
    var settings = cleanSettings(kind, preset, Object.assign({}, defaultSettings(kind, preset), (input.settings && typeof input.settings === 'object') ? input.settings : {}));
    var teamGame = (kind === 'any' && settings.teams) || (kind === 'cribbage' && settings.teams);
    var sides = [];
    var taken = [];
    if (teamGame) {
      var teams = Array.isArray(input.teams) && input.teams.length >= 2 ? input.teams : null;
      if (!teams) {
        // Seat partners opposite each other: 1 and 3 against 2 and 4.
        teams = [[], []];
        players.forEach(function (p, i) { teams[i % 2].push(i); });
      }
      teams.forEach(function (t) {
        var ps = (Array.isArray(t) ? t : []).map(function (i) { return players[i]; }).filter(Boolean).slice(0, LIMITS.teamSize);
        if (!ps.length) return;
        var id = freshId(o.rand, 's', taken, 6); taken.push(id);
        sides.push({ id: id, name: sideName(ps), emoji: ps[0].emoji, people: ps, start: 0, from: 0 });
      });
    } else {
      players.forEach(function (p) {
        var id = freshId(o.rand, 's', taken, 6); taken.push(id);
        sides.push({ id: id, name: p.name, emoji: p.emoji, people: [p], start: 0, from: 0 });
      });
    }
    var min = teamGame ? 2 : info.min, max = teamGame ? (kind === 'cribbage' || preset === 'euchre' ? 2 : 6) : info.max;
    if (sides.length < min) throw fail(400, info.name + (teamGame ? ' needs two teams.' : ' needs at least ' + plural(min, 'player') + '.'));
    if (sides.length > Math.min(max, LIMITS.sides)) throw fail(400, info.name + ' takes at most ' + plural(Math.min(max, LIMITS.sides), teamGame ? 'team' : 'player') + '.');
    var g = {
      id: freshId(o.rand, 'g', [], 10),
      kind: kind, preset: preset,
      name: kind === 'any' && preset === 'custom' ? (plain(input.name, LIMITS.gameName) || 'Any game') : info.name,
      sides: sides,
      settings: settings,
      data: emptyData(kind, settings, sides),
      dealer: 0,
      status: 'playing',
      ended: false,
      group: isId(input.group) ? input.group : '',
      createdAt: iso(o.now), updatedAt: iso(o.now), finishedAt: '',
      past: [], future: [],
    };
    var seats = seatsOf(g);
    var d = intIn(input.dealer, 0, seats.length - 1);
    g.dealer = d === null ? 0 : d;
    return g;
  }
  function emptyData(kind, settings, sides) {
    if (kind === 'any') return { rounds: [] };
    if (kind === 'hearts' || kind === 'cribbage') return { hands: [] };
    if (kind === 'golf') { var h = []; for (var i = 0; i < settings.holes; i++) h.push({ par: null, s: {} }); return { holes: h }; }
    var per = {};
    sides.forEach(function (s) { per[s.id] = kind === 'dice' ? { b: {}, x: 0 } : []; });
    if (kind === 'dice') return { sheets: per };
    if (kind === 'bowling') return { rolls: per };
    if (kind === 'darts') return { turns: per };
    return {};
  }
  function sideOf(g, sid) { for (var i = 0; i < g.sides.length; i++) if (g.sides[i].id === sid) return g.sides[i]; return null; }
  /** Everyone at the table in seating order. On a team game partners sit
   *  opposite, so the order runs A1, B1, A2, B2. */
  function seatsOf(g) {
    var out = [], most = 0;
    g.sides.forEach(function (s) { most = Math.max(most, s.people.length); });
    for (var i = 0; i < most; i++) g.sides.forEach(function (s) { if (s.people[i]) out.push({ person: s.people[i], side: s.id }); });
    return out;
  }
  function usesDealer(g) { return g.kind === 'hearts' || g.kind === 'cribbage' || (g.kind === 'any' && g.settings.dealer); }
  /** Who deals round `r` (0-based): the first dealer, moved one seat left
   *  each round. */
  function dealerFor(g, r) {
    var seats = seatsOf(g);
    if (!seats.length) return null;
    return seats[((g.dealer || 0) + r) % seats.length];
  }
  var PASS4 = ['Pass left', 'Pass right', 'Pass across', 'Keep your cards'];
  var PASS = ['Pass left', 'Pass right', 'Keep your cards'];
  /** Hearts: which way the cards go before hand `r`. */
  function passFor(g, r) { return g.sides.length === 4 ? PASS4[r % 4] : PASS[r % 3]; }

  /* ------------------------------------------------------------------ *
   * Any game (and Rummy, Card golf, Euchre, Word game)
   * ------------------------------------------------------------------ */

  function cellOk(n) { return Number.isInteger(n) && n >= LIMITS.minScore && n <= LIMITS.score; }
  /** Is side `s` part of round `r`? A late player sits out the rounds
   *  before they joined. */
  function inRound(s, r) { return r >= (s.from || 0); }
  function roundDone(g, list, r) {
    var row = list[r];
    if (!row) return false;
    return g.sides.every(function (s) { return !inRound(s, r) || (own(row.s, s.id) && row.s[s.id] !== null); });
  }
  /** Put a number in round `r` for side `sid` (r may be the next new
   *  round); null clears the cell. Euchre-style games fill the other
   *  teams' blanks with 0, since only one side scores a hand. */
  function setCell(g, r, sid, value) {
    var list = g.kind === 'hearts' || g.kind === 'cribbage' ? g.data.hands : g.data.rounds;
    if (g.kind !== 'any') throw fail(400, 'That is not how this game is scored.');
    var s = sideOf(g, sid);
    if (!s) throw fail(400, 'That player isn’t in this game.');
    if (!Number.isInteger(r) || r < 0 || r > list.length) throw fail(400, 'That round isn’t there.');
    if (r === list.length && list.length >= LIMITS.rounds) throw fail(409, LIMITS.rounds + ' rounds is the most one game keeps.');
    if (value !== null && !cellOk(value)) throw fail(400, 'A score is a whole number from ' + LIMITS.minScore + ' to ' + LIMITS.score + '.');
    if (!inRound(s, r)) throw fail(400, s.name + ' joined after that round.');
    if (r === list.length) list.push({ s: {}, note: '' });
    var row = list[r];
    row.s[sid] = value;
    if (value !== null && g.settings.fillZero && value !== 0) {
      g.sides.forEach(function (o2) { if (o2.id !== sid && inRound(o2, r) && (!own(row.s, o2.id) || row.s[o2.id] === null)) row.s[o2.id] = 0; });
    }
    // A round left entirely blank at the end is no round at all.
    while (list.length && Object.keys(list[list.length - 1].s).every(function (k) { return list[list.length - 1].s[k] === null; }) && !list[list.length - 1].note) list.pop();
    return g;
  }
  function anyTotals(g) {
    var t = {};
    g.sides.forEach(function (s) { t[s.id] = s.start || 0; });
    g.data.rounds.forEach(function (row) { g.sides.forEach(function (s) { var v = row.s[s.id]; if (Number.isInteger(v)) t[s.id] += v; }); });
    return t;
  }
  function anyDoneRounds(g) { var n = 0; for (var r = 0; r < g.data.rounds.length; r++) if (roundDone(g, g.data.rounds, r)) n++; return n; }
  function anyOver(g, t) {
    var st = g.settings, n = g.data.rounds.length;
    if (st.end === 'rounds') return anyDoneRounds(g) >= st.rounds;
    if (st.end === 'target') {
      if (!n || !roundDone(g, g.data.rounds, n - 1)) return false;
      return g.sides.some(function (s) { return st.target > 0 ? t[s.id] >= st.target : t[s.id] <= st.target; });
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Hearts
   * ------------------------------------------------------------------ */

  /** The points in one hand, checked: whole numbers 0-26 each, and a moon
   *  shot taken as one tap. `sum` should be 26; anything else is a warning,
   *  not a refusal (a misdeal happens). */
  function heartsHand(g, input) {
    var pts = {}, moon = '';
    var raw = input && input.s && typeof input.s === 'object' ? input.s : {};
    if (input && input.moon) {
      var shooter = sideOf(g, input.moon);
      if (!shooter) throw fail(400, 'Pick who shot the moon.');
      moon = shooter.id;
      g.sides.forEach(function (s) {
        if (!inRound(s, g.data.hands.length)) return;
        if (g.settings.moon === 'subtract') pts[s.id] = s.id === moon ? -26 : 0;
        else pts[s.id] = s.id === moon ? 0 : 26;
      });
      return { s: pts, moon: moon, sum: 26, ok: true };
    }
    var sum = 0;
    g.sides.forEach(function (s) {
      if (!inRound(s, g.data.hands.length)) return;
      var v = intIn(raw[s.id], 0, 26);
      if (v === null) throw fail(400, 'Each player takes 0 to 26 points in a hand - check ' + possessive(s.name) + '.');
      pts[s.id] = v; sum += v;
    });
    return { s: pts, moon: '', sum: sum, ok: sum === 26 };
  }
  function heartsCheckLine(sum) { return sum === 26 ? '' : 'These add up to ' + sum + ', not 26. Saved anyway - check for a misdeal.'; }
  function addHand(g, input) {
    if (g.data.hands.length >= LIMITS.rounds) throw fail(409, LIMITS.rounds + ' hands is the most one game keeps.');
    var h = heartsHand(g, input);
    g.data.hands.push({ s: h.s, moon: h.moon, note: cleanNote(input && input.note) });
    return h;
  }
  function editHand(g, r, input) {
    if (!g.data.hands[r]) throw fail(400, 'That hand isn’t there.');
    var saved = g.data.hands;
    g.data.hands = saved.slice(0, r);
    var h;
    try { h = heartsHand(g, input); } finally { g.data.hands = saved; }
    g.data.hands[r] = { s: h.s, moon: h.moon, note: cleanNote(input && input.note !== undefined ? input.note : saved[r].note) };
    return h;
  }
  function heartsTotals(g) {
    var t = {};
    g.sides.forEach(function (s) { t[s.id] = s.start || 0; });
    g.data.hands.forEach(function (h) { g.sides.forEach(function (s) { if (Number.isInteger(h.s[s.id])) t[s.id] += h.s[s.id]; }); });
    return t;
  }
  function moonsOf(g, sid) { return g.data.hands.filter(function (h) { return h.moon === sid; }).length; }

  /* ------------------------------------------------------------------ *
   * Cribbage
   * ------------------------------------------------------------------ */

  // No five cards make 19, 25, 26 or 27 - "a 19 hand" means nothing at all.
  function cribHandOk(n) { return Number.isInteger(n) && n >= 0 && n <= 29 && [19, 25, 26, 27].indexOf(n) < 0; }
  /** One hand, checked: pegging 0-61 per side, each hand and the crib a
   *  count five cards can make. */
  function cribHand(g, input) {
    var peg = {}, hand = {};
    var rp = input && input.peg && typeof input.peg === 'object' ? input.peg : {};
    var rh = input && input.hand && typeof input.hand === 'object' ? input.hand : {};
    g.sides.forEach(function (s) {
      var p = intIn(rp[s.id] === undefined || rp[s.id] === '' ? 0 : rp[s.id], 0, 61);
      if (p === null) throw fail(400, 'Pegging is 0 to 61 points in a hand - check ' + possessive(s.name) + '.');
      var h = intIn(rh[s.id] === undefined || rh[s.id] === '' ? 0 : rh[s.id], 0, 29);
      if (h === null || !cribHandOk(h)) throw fail(400, (h === 19 || h === 25 || h === 26 || h === 27 ? h + ' can’t be counted from five cards' : 'A hand counts 0 to 29') + ' - check ' + possessive(s.name) + ' hand.');
      peg[s.id] = p; hand[s.id] = h;
    });
    var crib = intIn(input && (input.crib === undefined || input.crib === '') ? 0 : input && input.crib, 0, 29);
    if (crib === null || !cribHandOk(crib)) throw fail(400, (crib === 19 || crib === 25 || crib === 26 || crib === 27 ? crib + ' can’t be counted from five cards' : 'The crib counts 0 to 29') + ' - check the crib.');
    return { peg: peg, hand: hand, crib: crib, note: cleanNote(input && input.note) };
  }
  function addCribHand(g, input) {
    if (g.data.hands.length >= LIMITS.rounds) throw fail(409, LIMITS.rounds + ' hands is the most one game keeps.');
    var h = cribHand(g, input);
    g.data.hands.push(h);
    return h;
  }
  /** The board, counted in the order the game is: everyone's pegging, then
   *  the hands from the dealer's left with the dealer last, then the crib.
   *  The first to reach the end wins on the spot - what is counted after
   *  that in the same hand never happened. `prev` is the back peg. */
  function cribBoard(g) {
    var to = g.settings.to || 121;
    var t = {}, prev = {};
    g.sides.forEach(function (s) { t[s.id] = s.start || 0; prev[s.id] = 0; });
    var winner = null, at = null;
    var add = function (sid, n, hi, step) {
      if (winner || !n) return;
      prev[sid] = t[sid];
      t[sid] = Math.min(to, t[sid] + n);
      if (t[sid] >= to) { winner = sid; at = { hand: hi, step: step }; }
    };
    for (var hi = 0; hi < g.data.hands.length && !winner; hi++) {
      var h = g.data.hands[hi];
      var dealer = dealerFor(g, hi);
      var di = 0;
      g.sides.forEach(function (s, i) { if (s.id === dealer.side) di = i; });
      var order = [];
      for (var k = 1; k <= g.sides.length; k++) order.push(g.sides[(di + k) % g.sides.length].id);
      order.forEach(function (sid) { add(sid, h.peg[sid] || 0, hi, 'pegging'); });
      order.forEach(function (sid) { add(sid, h.hand[sid] || 0, hi, sid === dealer.side ? 'the dealer’s hand' : 'hand'); });
      add(dealer.side, h.crib || 0, hi, 'the crib');
    }
    return { totals: t, prev: prev, winner: winner, at: at, to: to };
  }
  /** Skunks, called at the end: a loser under 91 is skunked, under 61
   *  double skunked (in a game to 121). */
  function skunks(g, board) {
    if (!board.winner) return [];
    var line1 = 91, line2 = 61;
    return g.sides.filter(function (s) { return s.id !== board.winner && board.totals[s.id] < line1; })
      .map(function (s) { return { side: s.id, double: board.totals[s.id] < line2 }; });
  }

  /* ------------------------------------------------------------------ *
   * Mini golf
   * ------------------------------------------------------------------ */

  function setStroke(g, hole, sid, value) {
    var h = g.data.holes[hole];
    if (!h) throw fail(400, 'That hole isn’t there.');
    if (!sideOf(g, sid)) throw fail(400, 'That player isn’t in this game.');
    if (value !== null) {
      var max = g.settings.max;
      if (!Number.isInteger(value) || value < 1 || value > max) throw fail(400, 'A hole takes 1 to ' + max + ' strokes here - the most is ' + max + ', and that is what a player who never gets it in scores.');
    }
    h.s[sid] = value;
    return g;
  }
  function setPar(g, hole, par) {
    var h = g.data.holes[hole];
    if (!h) throw fail(400, 'That hole isn’t there.');
    if (par !== null && (!Number.isInteger(par) || par < 1 || par > 12)) throw fail(400, 'Par is 1 to 12.');
    h.par = par;
    return g;
  }
  function golfTotals(g) {
    var t = {};
    g.sides.forEach(function (s) { t[s.id] = 0; g.data.holes.forEach(function (h) { if (Number.isInteger(h.s[s.id])) t[s.id] += h.s[s.id]; }); });
    return t;
  }
  /** Strokes against par for the holes this side has played that have a
   *  par: "+3", "-1", "E". Null when no played hole has a par. */
  function toPar(g, sid) {
    var d = 0, any = false;
    g.data.holes.forEach(function (h) { if (Number.isInteger(h.s[sid]) && Number.isInteger(h.par)) { d += h.s[sid] - h.par; any = true; } });
    return any ? d : null;
  }
  function parLine(d) { return d === null ? '' : d === 0 ? 'E' : (d > 0 ? '+' + d : '−' + Math.abs(d)); }
  function golfOver(g) { return g.data.holes.every(function (h) { return g.sides.every(function (s) { return Number.isInteger(h.s[s.id]); }); }); }

  /* ------------------------------------------------------------------ *
   * Five dice
   * ------------------------------------------------------------------ */

  var BOXES = [
    { id: 'ones', label: 'Ones', face: 1 }, { id: 'twos', label: 'Twos', face: 2 }, { id: 'threes', label: 'Threes', face: 3 },
    { id: 'fours', label: 'Fours', face: 4 }, { id: 'fives', label: 'Fives', face: 5 }, { id: 'sixes', label: 'Sixes', face: 6 },
    { id: 'three', label: 'Three of a kind', hint: 'Sum of all dice' }, { id: 'four', label: 'Four of a kind', hint: 'Sum of all dice' },
    { id: 'full', label: 'Full house', hint: '25' }, { id: 'small', label: 'Small straight', hint: '30' },
    { id: 'large', label: 'Large straight', hint: '40' }, { id: 'five', label: 'Five of a kind', hint: '50' },
    { id: 'chance', label: 'Chance', hint: 'Sum of all dice' },
  ];
  var BOX_IDS = BOXES.map(function (b) { return b.id; });
  var UPPER_BONUS = 35, UPPER_LINE = 63, EXTRA_BONUS = 100;
  function boxInfo(id) { for (var i = 0; i < BOXES.length; i++) if (BOXES[i].id === id) return BOXES[i]; return null; }
  function cleanDice(d) {
    if (!Array.isArray(d) || d.length !== 5) return null;
    var out = d.map(function (x) { return intIn(x, 1, 6); });
    return out.every(function (x) { return x !== null; }) ? out : null;
  }
  function counts(dice) { var c = [0, 0, 0, 0, 0, 0, 0]; dice.forEach(function (x) { c[x]++; }); return c; }
  function hasRun(c, len) {
    for (var start = 1; start + len - 1 <= 6; start++) {
      var ok = true;
      for (var k = start; k < start + len; k++) if (!c[k]) ok = false;
      if (ok) return true;
    }
    return false;
  }
  /** Five of a kind rolled again after the Five of a kind box is used: a
   *  joker - the full house and straights score in full. */
  function isJoker(dice, sheet) {
    var c = counts(dice);
    return c.some(function (n) { return n === 5; }) && sheet && Number.isInteger(sheet.b.five);
  }
  /** What these five dice would score in a box. */
  function diceScore(box, diceIn, sheet) {
    var dice = cleanDice(diceIn);
    if (!dice) return null;
    var c = counts(dice), sum = dice.reduce(function (a, b) { return a + b; }, 0);
    var most = Math.max.apply(null, c);
    var joker = isJoker(dice, sheet);
    var info = boxInfo(box);
    if (!info) return null;
    if (info.face) return c[info.face] * info.face;
    if (box === 'three') return most >= 3 ? sum : 0;
    if (box === 'four') return most >= 4 ? sum : 0;
    if (box === 'full') return joker || (c.indexOf(3) >= 0 && c.indexOf(2) >= 0) ? 25 : 0;
    if (box === 'small') return joker || hasRun(c, 4) ? 30 : 0;
    if (box === 'large') return joker || hasRun(c, 5) ? 40 : 0;
    if (box === 'five') return most === 5 ? 50 : 0;
    if (box === 'chance') return sum;
    return null;
  }
  /** Could a box ever hold this number? Twos only 0, 2, 4 ... 10; a full
   *  house only 0 or 25; chance 5 to 30. */
  function dicePossible(box, n) {
    if (!Number.isInteger(n)) return false;
    var info = boxInfo(box);
    if (!info) return false;
    if (info.face) return n >= 0 && n <= info.face * 5 && n % info.face === 0;
    if (box === 'three' || box === 'four') return n === 0 || (n >= 5 && n <= 30);
    if (box === 'full') return n === 0 || n === 25;
    if (box === 'small') return n === 0 || n === 30;
    if (box === 'large') return n === 0 || n === 40;
    if (box === 'five') return n === 0 || n === 50;
    if (box === 'chance') return n >= 5 && n <= 30;
    return false;
  }
  function possibleLine(box) {
    var info = boxInfo(box);
    if (info.face) { var v = []; for (var k = 0; k <= 5; k++) v.push(k * info.face); return info.label + ' can only be ' + v.slice(0, -1).join(', ') + ' or ' + v[5] + '.'; }
    if (box === 'three' || box === 'four') return info.label + ' is 0, or the sum of the dice: 5 to 30.';
    if (box === 'chance') return 'Chance is the sum of the dice: 5 to 30.';
    return info.label + ' is ' + info.hint + ' or 0.';
  }
  /** Put a score in a box. With `dice`, the score is worked out from them
   *  (and an extra five of a kind earns its bonus); without, the number is
   *  checked against what the box can hold. */
  function diceSet(g, sid, box, n, dice) {
    var sheet = g.data.sheets[sid];
    if (!sheet) throw fail(400, 'That player isn’t in this game.');
    if (BOX_IDS.indexOf(box) < 0) throw fail(400, 'That box isn’t on the sheet.');
    if (Number.isInteger(sheet.b[box])) throw fail(409, boxInfo(box).label + ' is already filled. Undo first to change it.');
    var bonus = false;
    if (dice) {
      var d = cleanDice(dice);
      if (!d) throw fail(400, 'Five dice, each 1 to 6.');
      n = diceScore(box, d, sheet);
      bonus = g.settings.extra && isJoker(d, sheet) && sheet.b.five === 50;
    }
    if (!dicePossible(box, n)) throw fail(400, possibleLine(box));
    sheet.b[box] = n;
    if (bonus) sheet.x = Math.min(12, (sheet.x || 0) + 1);
    return { score: n, bonus: bonus };
  }
  /** The extra five-of-a-kind bonus typed by hand (+100). Only once the
   *  Five of a kind box holds 50. */
  function diceExtra(g, sid) {
    var sheet = g.data.sheets[sid];
    if (!sheet) throw fail(400, 'That player isn’t in this game.');
    if (!g.settings.extra) throw fail(400, 'The extra bonus is switched off for this game.');
    if (sheet.b.five !== 50) throw fail(400, 'The bonus needs 50 in Five of a kind first.');
    if ((sheet.x || 0) >= 12) throw fail(409, 'That is every bonus a sheet can hold.');
    sheet.x = (sheet.x || 0) + 1;
    return g;
  }
  /** A sheet's sums, and how far it is from the upper bonus. `pace` is the
   *  upper section against three of each face. */
  function diceSums(sheet) {
    var upper = 0, lower = 0, filledUpper = 0, pace = 0, left = 0;
    BOXES.forEach(function (b) {
      var v = sheet.b[b.id];
      if (b.face) {
        if (Number.isInteger(v)) { upper += v; filledUpper++; pace += v - 3 * b.face; } else left += 5 * b.face;
      } else if (Number.isInteger(v)) lower += v;
    });
    var bonus = upper >= UPPER_LINE ? UPPER_BONUS : 0;
    var extra = (sheet.x || 0) * EXTRA_BONUS;
    var filled = BOX_IDS.filter(function (k) { return Number.isInteger(sheet.b[k]); }).length;
    var toBonus = Math.max(0, UPPER_LINE - upper);
    var bonusLine;
    if (bonus) bonusLine = 'Bonus +35 ✓';
    else if (upper + left < UPPER_LINE) bonusLine = 'No bonus this game';
    else bonusLine = toBonus + ' to go for +35' + (filledUpper ? ' · ' + (pace === 0 ? 'on pace' : (pace > 0 ? pace + ' ahead of pace' : -pace + ' behind pace')) : '');
    return { upper: upper, bonus: bonus, lower: lower, extra: extra, total: upper + bonus + lower + extra, filled: filled, toBonus: toBonus, pace: pace, bonusLine: bonusLine };
  }
  function diceTotals(g) { var t = {}; g.sides.forEach(function (s) { t[s.id] = diceSums(g.data.sheets[s.id] || { b: {}, x: 0 }).total; }); return t; }

  /* ------------------------------------------------------------------ *
   * Bowling
   * ------------------------------------------------------------------ */

  /** What the next ball can knock down: {frame (1-10), ball (1-3), max (pins
   *  standing), strike (X allowed), spare (/ allowed)} - or null when the
   *  game is complete. The keypad offers 0 to max and nothing more. */
  function bowlNext(rolls) {
    var i = 0;
    for (var f = 1; f <= 10; f++) {
      if (f < 10) {
        if (i >= rolls.length) return { frame: f, ball: 1, max: 10, strike: true, spare: false };
        if (rolls[i] === 10) { i += 1; continue; }
        if (i + 1 >= rolls.length) return { frame: f, ball: 2, max: 10 - rolls[i], strike: false, spare: true };
        i += 2;
      } else {
        var a = rolls[i], b = rolls[i + 1], c = rolls[i + 2];
        if (a === undefined) return { frame: 10, ball: 1, max: 10, strike: true, spare: false };
        if (b === undefined) return a === 10 ? { frame: 10, ball: 2, max: 10, strike: true, spare: false } : { frame: 10, ball: 2, max: 10 - a, strike: false, spare: true };
        if (a !== 10 && a + b < 10) return null; // an open tenth: two balls
        if (c === undefined) {
          if (a === 10 && b !== 10) return { frame: 10, ball: 3, max: 10 - b, strike: false, spare: true };
          return { frame: 10, ball: 3, max: 10, strike: true, spare: false };
        }
        return null;
      }
    }
    return null;
  }
  /** Each frame with its marks (X, /, - for a miss) and its running total,
   *  null until the bonus balls it waits on are thrown. */
  function bowlFrames(rolls) {
    var frames = [], i = 0, run = 0, known = true;
    var mark = function (n) { return n === 0 ? '-' : String(n); };
    for (var f = 1; f <= 10 && i < rolls.length; f++) {
      var fr = { n: f, rolls: [], marks: [], score: null };
      if (f < 10) {
        if (rolls[i] === 10) {
          fr.rolls = [10]; fr.marks = ['X'];
          if (rolls[i + 1] !== undefined && rolls[i + 2] !== undefined && known) { run += 10 + rolls[i + 1] + rolls[i + 2]; fr.score = run; } else known = false;
          i += 1;
        } else {
          var a = rolls[i], b = rolls[i + 1];
          fr.rolls = b === undefined ? [a] : [a, b];
          fr.marks = [mark(a)];
          if (b !== undefined) fr.marks.push(a + b === 10 ? '/' : mark(b));
          if (b === undefined) known = false;
          else if (a + b === 10) { if (rolls[i + 2] !== undefined && known) { run += 10 + rolls[i + 2]; fr.score = run; } else known = false; }
          else if (known) { run += a + b; fr.score = run; }
          i += 2;
        }
      } else {
        var t = rolls.slice(i, i + 3);
        fr.rolls = t;
        fr.marks = t.map(function (n, k) {
          if (n === 10 && (k === 0 || t[k - 1] === 10 || (k === 2 && t[0] + t[1] === 10 && t[0] !== 10))) return 'X';
          if (k === 1 && t[0] !== 10 && t[0] + n === 10) return '/';
          if (k === 2 && t[0] === 10 && t[1] !== 10 && t[1] + n === 10) return '/';
          return mark(n);
        });
        var need = t[0] === 10 || t[0] + t[1] === 10 ? 3 : 2;
        if (t.length >= need && known) { run += t.reduce(function (x, y) { return x + y; }, 0); fr.score = run; } else known = false;
        i += 3;
      }
      frames.push(fr);
    }
    return { frames: frames, total: run, complete: bowlNext(rolls) === null && frames.length === 10 };
  }
  function bowlAdd(rolls, pins) {
    var nx = bowlNext(rolls);
    if (!nx) throw fail(409, 'That game is complete.');
    if (!Number.isInteger(pins) || pins < 0 || pins > nx.max) throw fail(400, nx.max === 10 ? 'Pick 0 to 10 pins.' : 'Only ' + plural(nx.max, 'pin is', 'pins are') + ' standing.');
    return rolls.concat([pins]);
  }
  /** The most this game could still reach - "can still make 247". */
  function bowlMax(rolls) {
    var r = rolls.slice();
    for (var guard = 0; guard < 25; guard++) { var nx = bowlNext(r); if (!nx) break; r.push(nx.max); }
    return bowlFrames(r).total;
  }
  function bowlTotals(g) { var t = {}; g.sides.forEach(function (s) { t[s.id] = bowlFrames(g.data.rolls[s.id] || []).total; }); return t; }
  /** Longest run of strikes in a row. */
  function strikeRun(rolls) {
    var fr = bowlFrames(rolls).frames, best = 0, cur = 0;
    fr.forEach(function (f) { f.marks.forEach(function (m) { if (m === 'X') { cur++; best = Math.max(best, cur); } else cur = 0; }); });
    return best;
  }

  /* ------------------------------------------------------------------ *
   * Darts 501 / 301
   * ------------------------------------------------------------------ */

  var DARTS = (function () {
    var d = [];
    for (var n = 20; n >= 1; n--) { d.push({ id: 'T' + n, v: 3 * n, dbl: false, t: 3 }); }
    for (var m = 20; m >= 1; m--) { d.push({ id: 'D' + m, v: 2 * m, dbl: true, t: 2 }); }
    d.push({ id: 'Bull', v: 50, dbl: true, t: 2 });
    d.push({ id: '25', v: 25, dbl: false, t: 1 });
    for (var k = 20; k >= 1; k--) { d.push({ id: String(k), v: k, dbl: false, t: 1 }); }
    return d;
  }());
  // What three darts can add up to (a miss is 0). 179, 178, 176, 175, 173,
  // 172, 169, 166 and 163 are not on the list.
  var THREE = (function () {
    var vals = [0].concat(DARTS.map(function (d) { return d.v; }));
    var one = {}, out = {};
    vals.forEach(function (a) { one[a] = 1; });
    var two = {};
    Object.keys(one).forEach(function (a) { vals.forEach(function (b) { two[Number(a) + b] = 1; }); });
    Object.keys(two).forEach(function (a) { vals.forEach(function (b) { out[Number(a) + b] = 1; }); });
    return out;
  }());
  function dartsPossible(n) { return Number.isInteger(n) && n >= 0 && n <= 180 && Boolean(THREE[n]); }
  // The doubles people like to finish on, best first.
  var FINISH_ORDER = ['D20', 'D16', 'D18', 'D12', 'D10', 'D8', 'D19', 'D17', 'D14', 'D15', 'D13', 'D11', 'D9', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'Bull'];
  var checkoutCache = {};
  /** The darts to finish from `n`: fewest darts; then the friendliest
   *  finishing double; then the biggest first dart (trebles before doubles
   *  before singles). Null when it can't be done in three - with double-out
   *  that is 169, 168, 166, 165, 163, 162, 159 and everything over 170. */
  function checkout(n, doubleOut) {
    var key = n + (doubleOut ? 'd' : 's');
    if (own(checkoutCache, key)) return checkoutCache[key] ? checkoutCache[key].slice() : null;
    var best = null;
    var lastOk = function (d) { return doubleOut ? d.dbl : true; };
    var lastRank = function (d) { return doubleOut ? FINISH_ORDER.indexOf(d.id) : 0; };
    var better = function (a, b) {
      if (!b) return true;
      if (a.length !== b.length) return a.length < b.length;
      var la = lastRank(a[a.length - 1]), lb = lastRank(b[b.length - 1]);
      if (la !== lb) return la < lb;
      for (var i = 0; i < a.length - 1; i++) {
        if (a[i].v !== b[i].v) return a[i].v > b[i].v;
        if (a[i].t !== b[i].t) return a[i].t > b[i].t;
      }
      return false;
    };
    if (Number.isInteger(n) && n >= 1 && n <= 180) {
      DARTS.forEach(function (z) { if (lastOk(z) && z.v === n && better([z], best)) best = [z]; });
      if (!best) DARTS.forEach(function (a) { DARTS.forEach(function (z) { if (lastOk(z) && a.v + z.v === n && better([a, z], best)) best = [a, z]; }); });
      if (!best) DARTS.forEach(function (a) { DARTS.forEach(function (b) { DARTS.forEach(function (z) { if (lastOk(z) && a.v + b.v + z.v === n && better([a, b, z], best)) best = [a, b, z]; }); }); });
    }
    checkoutCache[key] = best ? best.map(function (d) { return d.id; }) : null;
    return checkoutCache[key] ? checkoutCache[key].slice() : null;
  }
  function dartValue(id) { for (var i = 0; i < DARTS.length; i++) if (DARTS[i].id === id) return DARTS[i]; return null; }
  /** What a turn of `score` does from `left`: {ok} to score it, {bust},
   *  {finish}, {ask: true} when it lands on zero with double-out on (did the
   *  last dart hit a double?), or {error} when three darts can't make it. */
  function dartsCheck(left, score, doubleOut, onDouble) {
    if (!dartsPossible(score)) return { error: score > 180 ? 'A turn is 0 to 180.' : 'Three darts can’t make ' + score + '.' };
    var rest = left - score;
    if (rest < 0) return { bust: true, why: 'Bust - that goes below zero.' };
    if (doubleOut && rest === 1) return { bust: true, why: 'Bust - 1 can’t be finished on a double.' };
    if (rest === 0) {
      if (!doubleOut) return { finish: true };
      if (!checkout(left, true)) return { error: left + ' can’t be checked out with a double in three darts.' };
      if (onDouble === undefined || onDouble === null) return { ask: true };
      return onDouble ? { finish: true } : { bust: true, why: 'Bust - the last dart has to be a double.' };
    }
    return { ok: true };
  }
  function dartsLeft(g, sid) {
    var left = g.settings.start;
    (g.data.turns[sid] || []).forEach(function (t) { if (!t.b) left -= t.s; });
    return left;
  }
  /** Score a turn. `onDouble` answers "finished on a double?" when asked. */
  function dartsTurn(g, sid, score, onDouble) {
    var turns = g.data.turns[sid];
    if (!turns) throw fail(400, 'That player isn’t in this game.');
    if (turns.length >= LIMITS.rounds) throw fail(409, LIMITS.rounds + ' turns is the most one game keeps.');
    if (dartsWinner(g)) throw fail(409, 'That leg is over.');
    var left = dartsLeft(g, sid);
    var c = dartsCheck(left, score, g.settings.doubleOut, onDouble);
    if (c.error) throw fail(400, c.error);
    if (c.ask) return c;
    turns.push({ s: score, b: Boolean(c.bust), f: Boolean(c.finish) });
    return c;
  }
  function dartsWinner(g) {
    for (var i = 0; i < g.sides.length; i++) { var t = g.data.turns[g.sides[i].id] || []; if (t.length && t[t.length - 1].f) return g.sides[i].id; }
    return null;
  }
  function dartsTotals(g) { var t = {}; g.sides.forEach(function (s) { t[s.id] = dartsLeft(g, s.id); }); return t; }
  /** Points per turn of three darts (a bust scores nothing). */
  function dartsAverage(g, sid) {
    var turns = g.data.turns[sid] || [];
    if (!turns.length) return null;
    var pts = turns.reduce(function (a, t) { return a + (t.b ? 0 : t.s); }, 0);
    return Math.round((pts / turns.length) * 10) / 10;
  }
  function dartsCheckoutScore(g, sid) { var t = g.data.turns[sid] || []; var last = t[t.length - 1]; return last && last.f ? last.s : null; }

  /* ------------------------------------------------------------------ *
   * Who is ahead, who won, whose turn
   * ------------------------------------------------------------------ */

  function totals(g) {
    if (g.kind === 'any') return anyTotals(g);
    if (g.kind === 'hearts') return heartsTotals(g);
    if (g.kind === 'cribbage') return cribBoard(g).totals;
    if (g.kind === 'golf') return golfTotals(g);
    if (g.kind === 'dice') return diceTotals(g);
    if (g.kind === 'bowling') return bowlTotals(g);
    if (g.kind === 'darts') return dartsTotals(g);
    return {};
  }
  function started(g) {
    if (g.kind === 'any') return g.data.rounds.length > 0;
    if (g.kind === 'hearts' || g.kind === 'cribbage') return g.data.hands.length > 0;
    if (g.kind === 'golf') return g.data.holes.some(function (h) { return Object.keys(h.s).some(function (k) { return Number.isInteger(h.s[k]); }); });
    if (g.kind === 'dice') return g.sides.some(function (s) { return diceSums(g.data.sheets[s.id]).filled > 0; });
    if (g.kind === 'bowling') return g.sides.some(function (s) { return (g.data.rolls[s.id] || []).length > 0; });
    if (g.kind === 'darts') return g.sides.some(function (s) { return (g.data.turns[s.id] || []).length > 0; });
    return false;
  }
  /** Sides best first, with places: a shared total shares a place. Darts
   *  counts down (fewest left leads, whoever checked out first); Hearts,
   *  Mini golf and low games count up from the bottom. */
  function standings(g) {
    var t = totals(g), low = lowWins(g);
    var first = g.kind === 'darts' ? dartsWinner(g) : g.kind === 'cribbage' ? cribBoard(g).winner : null;
    var rows = g.sides.map(function (s, i) { return { side: s, total: t[s.id], seat: i, place: 0 }; });
    rows.sort(function (a, b) {
      if (first && (a.side.id === first) !== (b.side.id === first)) return a.side.id === first ? -1 : 1;
      if (a.total !== b.total) return low ? a.total - b.total : b.total - a.total;
      return a.seat - b.seat;
    });
    rows.forEach(function (r, i) {
      var prev = rows[i - 1];
      r.place = prev && prev.total === r.total && !(first && (r.side.id === first || prev.side.id === first)) ? prev.place : i + 1;
    });
    return rows;
  }
  function engineOver(g, t) {
    if (g.kind === 'any') return anyOver(g, t);
    if (g.kind === 'hearts') return g.sides.some(function (s) { return t[s.id] >= g.settings.endAt; });
    if (g.kind === 'cribbage') return Boolean(cribBoard(g).winner);
    if (g.kind === 'golf') return golfOver(g);
    if (g.kind === 'dice') return g.sides.every(function (s) { return diceSums(g.data.sheets[s.id]).filled === BOXES.length; });
    if (g.kind === 'bowling') return g.sides.every(function (s) { return bowlNext(g.data.rolls[s.id] || []) === null; });
    if (g.kind === 'darts') return Boolean(dartsWinner(g));
    return false;
  }
  function namesOf(g, ids) { return listNames(ids.map(function (id) { return sideOf(g, id).name; })); }
  function totalWord(g, n) { return g.kind === 'darts' ? n + ' left' : g.kind === 'golf' ? plural(n, 'stroke') : String(n); }
  /** The game's state in words. {over, winners, tie, leaders, line, wait}:
   *  `wait` says why a game that reached its end goes on (Hearts tied at
   *  the bottom, with "keep playing" on). */
  function result(g) {
    var t = totals(g), rows = standings(g);
    var reached = engineOver(g, t);
    var over = reached || Boolean(g.ended);
    var bestTotal = rows.length ? rows[0].total : null;
    var top = rows.filter(function (r) { return r.place === 1; }).map(function (r) { return r.side.id; });
    var wait = '';
    if (g.kind === 'hearts' && reached && !g.ended && top.length > 1 && g.settings.tie === 'keep') {
      over = false;
      wait = namesOf(g, top) + ' are tied at the bottom on ' + bestTotal + ' - keep playing until it breaks.';
    }
    var any = started(g);
    var out = { over: over, reached: reached, winners: [], tie: false, leaders: any ? top : [], line: '', wait: wait, totals: t, rows: rows, extra: '' };
    var plur = function (ids) { return ids.length > 1 || (sideOf(g, ids[0]) && sideOf(g, ids[0]).people.length > 1); };
    if (over && any) {
      out.winners = top;
      out.tie = top.length > 1;
      if (out.tie) out.line = namesOf(g, top) + ' tie for the win on ' + totalWord(g, bestTotal) + '.';
      else if (g.kind === 'darts' && dartsWinner(g)) out.line = namesOf(g, top) + (plur(top) ? ' check out ' : ' checks out ') + dartsCheckoutScore(g, top[0]) + ' to win.';
      else if (g.kind === 'golf') { var d = toPar(g, top[0]); out.line = namesOf(g, top) + (plur(top) ? ' win' : ' wins') + ' with ' + bestTotal + (d === null ? '' : ' (' + parLine(d) + ')') + '.'; }
      else out.line = namesOf(g, top) + (plur(top) ? ' win' : ' wins') + ' with ' + totalWord(g, bestTotal) + '.';
      if (g.kind === 'cribbage') {
        var sk = skunks(g, cribBoard(g));
        if (sk.length) out.extra = sk.map(function (k) { return sideOf(g, k.side).name + (k.double ? ' is double skunked' : ' is skunked'); }).join(' and ') + '.';
      }
    } else if (over) {
      out.line = 'Finished before anyone scored.';
    } else if (any && top.length) {
      var lead = top.length > 1 ? namesOf(g, top) + ' share the lead on ' + totalWord(g, bestTotal) : namesOf(g, top) + (plur(top) ? ' lead' : ' leads') + ' with ' + totalWord(g, bestTotal);
      out.line = lead + '.';
    } else out.line = 'No scores yet.';
    if (g.sides.length < 2 && over && any) { out.line = 'Finished on ' + totalWord(g, bestTotal) + '.'; out.tie = false; }
    return out;
  }
  /** Who goes next: {sid, line} - or null when it is a round everyone fills. */
  function nextUp(g) {
    if (result(g).over) return null;
    var pick = function (score) {
      var best = null;
      g.sides.forEach(function (s, i) { var v = score(s); if (v === null) return; if (!best || v < best.v) best = { v: v, s: s, i: i }; });
      return best ? best.s : null;
    };
    var s = null;
    if (g.kind === 'dice') s = pick(function (x) { var f = diceSums(g.data.sheets[x.id]).filled; return f >= BOXES.length ? null : f; });
    if (g.kind === 'darts') s = pick(function (x) { return (g.data.turns[x.id] || []).length; });
    if (g.kind === 'bowling') {
      var mid = g.sides.filter(function (x) { var n = bowlNext(g.data.rolls[x.id] || []); return n && n.ball > 1 && n.frame < 10; })[0];
      s = mid || pick(function (x) { var n = bowlNext(g.data.rolls[x.id] || []); return n ? n.frame * 10 + (n.ball > 1 ? 0 : 5) : null; });
    }
    if (!s) return null;
    return { sid: s.id, line: possessive(s.name) + ' turn' };
  }

  /* ------------------------------------------------------------------ *
   * Changes, undo and redo
   * ------------------------------------------------------------------ */

  var SNAP = ['sides', 'data', 'dealer', 'status', 'ended', 'finishedAt'];
  function snapOf(g) { var o = {}; SNAP.forEach(function (k) { o[k] = g[k]; }); return JSON.stringify(o); }
  function restore(g, snap) { var o = JSON.parse(snap); SNAP.forEach(function (k) { g[k] = o[k]; }); return g; }
  function copyGame(g) {
    var n = {};
    for (var k in g) if (own(g, k)) n[k] = g[k];
    n.sides = clone(g.sides); n.data = clone(g.data); n.settings = clone(g.settings);
    n.past = (g.past || []).slice(); n.future = (g.future || []).slice();
    if (g.shared) n.shared = clone(g.shared);
    return n;
  }
  /** A finished game is marked done (and an undone finish playing again). */
  function settle(g, o) {
    var r = result(g);
    if (r.over && g.status !== 'done') { g.status = 'done'; g.finishedAt = iso(o.now); }
    else if (!r.over && g.status === 'done') { g.status = 'playing'; g.finishedAt = ''; }
    return g;
  }
  /** Every change goes through here: `fn` changes a copy (and may throw);
   *  the old state goes onto the undo stack; redo is cleared. Returns
   *  {game, out} - the same game when nothing changed. */
  function change(g, fn, o) {
    var before = snapOf(g);
    var n = copyGame(g);
    var out = fn(n);
    settle(n, o);
    if (snapOf(n) === before) return { game: g, out: out };
    n.past = n.past.concat([before]).slice(-LIMITS.undo);
    n.future = [];
    n.updatedAt = iso(o.now);
    return { game: n, out: out };
  }
  function undo(g, o) {
    if (!g.past || !g.past.length) return g;
    var n = copyGame(g);
    var prev = n.past.pop();
    n.future.push(snapOf(g));
    restore(n, prev);
    n.updatedAt = iso(o.now);
    return n;
  }
  function redo(g, o) {
    if (!g.future || !g.future.length) return g;
    var n = copyGame(g);
    var next = n.future.pop();
    n.past.push(snapOf(g));
    restore(n, next);
    n.updatedAt = iso(o.now);
    return n;
  }
  function canUndo(g) { return Boolean(g.past && g.past.length); }
  function canRedo(g) { return Boolean(g.future && g.future.length); }

  /* ------------------------------------------------------------------ *
   * The table: late players, names, order, the dealer, notes, finishing
   * ------------------------------------------------------------------ */

  function maxSides(g) {
    if (g.kind === 'cribbage') return g.settings.teams ? 2 : 3;
    if (g.kind === 'any' && g.settings.teams) return g.preset === 'euchre' ? 2 : 6;
    return Math.min(infoOf(g).max, LIMITS.sides);
  }
  /** A player who arrives late. Rounds already played are theirs to sit
   *  out; in a running-total game they start at the score of whoever is
   *  last (or at zero - a setting). Five dice, bowling, darts and mini golf
   *  give them a fresh sheet. */
  function addSide(g, person, o) {
    var p = cleanPerson(person);
    if (!p) throw fail(400, 'Type a first name.');
    if (g.kind === 'cribbage') throw fail(409, 'A cribbage board is set when the game starts - start a new game to add a player.');
    if (g.kind === 'any' && g.settings.teams) throw fail(409, 'Add a partner to a team when you start the game.');
    if (g.sides.length >= maxSides(g)) throw fail(409, infoOf(g).name + ' takes at most ' + plural(maxSides(g), 'player') + '.');
    if (g.sides.some(function (s) { return s.people.some(function (x) { return x.id === p.id || norm(x.name) === norm(p.name); }); })) throw fail(409, p.name + ' is already playing.');
    var id = freshId(o.rand, 's', g.sides.map(function (s) { return s.id; }), 6);
    var side = { id: id, name: p.name, emoji: p.emoji, people: [p], start: 0, from: 0 };
    if (g.kind === 'any' || g.kind === 'hearts') {
      var list = g.kind === 'any' ? g.data.rounds : g.data.hands;
      side.from = list.length;
      if (g.settings.late !== 'zero' && g.sides.length) {
        var t = totals(g), vals = g.sides.map(function (s) { return t[s.id]; });
        side.start = lowWins(g) ? Math.max.apply(null, vals) : Math.min.apply(null, vals);
      }
    }
    if (g.kind === 'dice') g.data.sheets[id] = { b: {}, x: 0 };
    if (g.kind === 'bowling') g.data.rolls[id] = [];
    if (g.kind === 'darts') g.data.turns[id] = [];
    g.sides.push(side);
    return side;
  }
  /** A side with nothing scored can go (someone added by mistake). */
  function dropSide(g, sid) {
    var s = sideOf(g, sid);
    if (!s) throw fail(400, 'That player isn’t in this game.');
    var scored = g.kind === 'any' ? g.data.rounds.some(function (r) { return Number.isInteger(r.s[sid]); })
      : g.kind === 'hearts' || g.kind === 'cribbage' ? g.data.hands.length > 0
        : g.kind === 'golf' ? g.data.holes.some(function (h) { return Number.isInteger(h.s[sid]); })
          : g.kind === 'dice' ? diceSums(g.data.sheets[sid]).filled > 0
            : g.kind === 'bowling' ? (g.data.rolls[sid] || []).length > 0 : (g.data.turns[sid] || []).length > 0;
    if (scored) throw fail(409, s.name + ' already has scores - undo them first.');
    var min = infoOf(g).min;
    if (g.sides.length <= Math.max(1, min)) throw fail(409, infoOf(g).name + ' needs at least ' + plural(min, 'player') + '.');
    g.sides = g.sides.filter(function (x) { return x.id !== sid; });
    if (g.data.sheets) delete g.data.sheets[sid];
    if (g.data.rolls) delete g.data.rolls[sid];
    if (g.data.turns) delete g.data.turns[sid];
    return g;
  }
  function renameSide(g, sid, name) {
    var s = sideOf(g, sid);
    if (!s) throw fail(400, 'That player isn’t in this game.');
    var n = cleanName(name, s.people.length > 1 ? LIMITS.gameName : LIMITS.name);
    if (!n) throw fail(400, 'Type a name with a letter in it.');
    if (g.sides.some(function (x) { return x.id !== sid && norm(x.name) === norm(n); })) throw fail(409, n + ' is already at the table.');
    s.name = n;
    if (s.people.length === 1) s.people[0].name = n;
    return g;
  }
  function moveSide(g, sid, dir) {
    var i = -1;
    g.sides.forEach(function (s, k) { if (s.id === sid) i = k; });
    var j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= g.sides.length) return g;
    var t = g.sides[i]; g.sides[i] = g.sides[j]; g.sides[j] = t;
    return g;
  }
  function setDealer(g, seat) {
    var n = seatsOf(g).length;
    if (!Number.isInteger(seat) || seat < 0 || seat >= n) throw fail(400, 'Pick who deals.');
    // Hands already played keep their dealer: move the start so the next
    // round is dealt by `seat`.
    var r = g.kind === 'any' ? g.data.rounds.length : (g.data.hands ? g.data.hands.length : 0);
    g.dealer = ((seat - r) % n + n) % n;
    return g;
  }
  function setNote(g, r, text) {
    var list = g.kind === 'any' ? g.data.rounds : (g.kind === 'hearts' || g.kind === 'cribbage') ? g.data.hands : null;
    if (!list || !list[r]) throw fail(400, 'That round isn’t there.');
    list[r].note = cleanNote(text);
    return g;
  }
  /** Finish now: the standings as they are decide it. */
  function endNow(g) { g.ended = true; return g; }
  function roundsOf(g) {
    if (g.kind === 'any') return g.data.rounds.length;
    if (g.kind === 'hearts' || g.kind === 'cribbage') return g.data.hands.length;
    if (g.kind === 'golf') return g.data.holes.filter(function (h) { return g.sides.every(function (s) { return Number.isInteger(h.s[s.id]); }); }).length;
    if (g.kind === 'dice') return Math.max.apply(null, g.sides.map(function (s) { return diceSums(g.data.sheets[s.id]).filled; }).concat([0]));
    if (g.kind === 'bowling') return Math.max.apply(null, g.sides.map(function (s) { return bowlFrames(g.data.rolls[s.id] || []).frames.length; }).concat([0]));
    if (g.kind === 'darts') return Math.max.apply(null, g.sides.map(function (s) { return (g.data.turns[s.id] || []).length; }).concat([0]));
    return 0;
  }
  /** One line for a list of games: "Hearts · round 7 · Priya leads with 41". */
  function gameLine(g) {
    var r = result(g);
    var where = g.kind === 'bowling' ? 'frame ' + Math.max(1, roundsOf(g)) : g.kind === 'golf' ? 'hole ' + Math.min(g.data.holes.length, roundsOf(g) + 1) : g.kind === 'dice' ? 'turn ' + Math.min(13, roundsOf(g) + 1) : g.kind === 'darts' ? 'turn ' + (roundsOf(g) + 1) : (g.kind === 'any' ? 'round ' : 'hand ') + (roundsOf(g) + 1);
    return r.over ? r.line : where + ' · ' + r.line;
  }

  /* ------------------------------------------------------------------ *
   * Highlights - what the table will talk about
   * ------------------------------------------------------------------ */

  function times(n) { return n === 1 ? 'once' : n === 2 ? 'twice' : n + ' times'; }
  /** The moments of a game in words, best first (at most three). */
  function highlights(g) {
    var out = [];
    var push = function (weight, text) { out.push({ w: weight, t: text }); };
    if (g.kind === 'hearts') {
      g.sides.forEach(function (s) { var n = moonsOf(g, s.id); if (n) push(80 + n, s.name + ' shot the moon ' + times(n)); });
    }
    if (g.kind === 'dice') {
      g.sides.forEach(function (s) {
        var sh = g.data.sheets[s.id], sum = diceSums(sh);
        if (sh.b.five === 50) push(70 + (sh.x || 0) * 5, s.name + ' rolled five of a kind' + (sh.x ? ' - and ' + plural(sh.x, 'bonus', 'bonuses') + ' of 100' : ''));
        if (sum.total >= 300) push(75, s.name + ' scored ' + sum.total);
      });
    }
    if (g.kind === 'bowling') {
      g.sides.forEach(function (s) {
        var r = g.data.rolls[s.id] || [], run = strikeRun(r), f = bowlFrames(r);
        if (f.complete && f.total === 300) push(100, s.name + ' bowled a perfect 300');
        else if (run >= 3) push(60 + run, s.name + ' threw ' + (run === 3 ? 'a turkey - three strikes in a row' : run + ' strikes in a row'));
        if (f.complete && f.total >= 200 && f.total < 300) push(65, s.name + ' broke 200 with ' + f.total);
      });
    }
    if (g.kind === 'darts') {
      g.sides.forEach(function (s) {
        var t = g.data.turns[s.id] || [];
        var n180 = t.filter(function (x) { return x.s === 180 && !x.b; }).length;
        if (n180) push(70 + n180, s.name + ' hit 180' + (n180 > 1 ? ' ' + times(n180) : ''));
        var co = dartsCheckoutScore(g, s.id);
        if (co !== null && co >= 60) push(60 + co / 10, s.name + ' checked out ' + co);
      });
    }
    if (g.kind === 'cribbage') {
      var best = null;
      g.data.hands.forEach(function (h) { g.sides.forEach(function (s) { if (!best || h.hand[s.id] > best.n) best = { n: h.hand[s.id], s: s }; }); });
      if (best && best.n === 29) push(100, best.s.name + ' counted a perfect 29');
      else if (best && best.n >= 16) push(55 + best.n, best.s.name + ' counted a ' + best.n + ' hand');
      var b = cribBoard(g);
      skunks(g, b).forEach(function (k) { push(68, sideOf(g, b.winner).name + (k.double ? ' double skunked ' : ' skunked ') + sideOf(g, k.side).name); });
    }
    if (g.kind === 'golf') {
      g.sides.forEach(function (s) {
        var aces = [];
        g.data.holes.forEach(function (h, i) { if (h.s[s.id] === 1) aces.push(i + 1); });
        if (aces.length) push(70 + aces.length, s.name + ' got ' + (aces.length === 1 ? 'a hole in one on hole ' + aces[0] : plural(aces.length, 'hole in one', 'holes in one')));
      });
    }
    if (g.kind === 'any' && g.data.rounds.length >= 2) {
      var big = null;
      g.data.rounds.forEach(function (row, i) { g.sides.forEach(function (s) { var v = row.s[s.id]; if (Number.isInteger(v) && (!big || (lowWins(g) ? v < big.v : v > big.v))) big = { v: v, s: s, r: i }; }); });
      var ties2 = 0;
      g.data.rounds.forEach(function (row) { g.sides.forEach(function (s) { if (big && row.s[s.id] === big.v) ties2++; }); });
      if (big && g.sides.length > 1 && ties2 === 1) push(40, big.s.name + ' scored ' + big.v + ' in round ' + (big.r + 1));
      // A comeback: last at the halfway mark, first at the end.
      var r = result(g);
      if (r.over && r.winners.length === 1 && g.data.rounds.length >= 4 && g.sides.length > 2) {
        var half = copyGame(g); half.data.rounds = g.data.rounds.slice(0, Math.floor(g.data.rounds.length / 2)); half.ended = false;
        var st = standings(half);
        if (st[st.length - 1].side.id === r.winners[0]) push(90, sideOf(g, r.winners[0]).name + ' came back from last place at halfway');
      }
    }
    out.sort(function (a, b) { return b.w - a.w; });
    return out.slice(0, 3).map(function (x) { return x.t; });
  }

  /* ------------------------------------------------------------------ *
   * History: what a finished game leaves behind
   * ------------------------------------------------------------------ */

  /** The number a game puts in the record book for a side - and whether
   *  bigger is better. */
  var RECORDS = {
    dice: { label: 'Best Five dice game', high: true },
    bowling: { label: 'Best Bowling game', high: true },
    darts: { label: 'Highest Darts checkout', high: true },
    golf: { label: 'Best round of Mini golf', high: false },
    hearts: { label: 'Lowest Hearts game', high: false },
    cribbage: { label: 'Best Cribbage hand', high: true },
  };
  function recOf(g, s) {
    if (g.kind === 'dice') return diceSums(g.data.sheets[s.id]).total;
    if (g.kind === 'bowling') return bowlFrames(g.data.rolls[s.id] || []).complete ? bowlFrames(g.data.rolls[s.id]).total : null;
    if (g.kind === 'darts') return dartsCheckoutScore(g, s.id);
    if (g.kind === 'golf') return golfOver(g) ? golfTotals(g)[s.id] : null;
    if (g.kind === 'hearts') return heartsTotals(g)[s.id];
    if (g.kind === 'cribbage') { var b = null; g.data.hands.forEach(function (h) { if (b === null || h.hand[s.id] > b) b = h.hand[s.id]; }); return b; }
    return null;
  }
  /** A finished game, as the history keeps it: who, how they finished,
   *  the record-book numbers and the best moment. */
  function summarize(g) {
    var r = result(g);
    var many = g.sides.length > 1;
    var info = infoOf(g);
    return {
      id: g.id, key: statKey(g), kind: g.kind, preset: g.preset || '', name: g.name, emoji: info ? info.emoji : '',
      at: g.finishedAt || g.updatedAt, group: g.group || '', tie: r.tie,
      sides: r.rows.map(function (row) {
        return { name: row.side.name, emoji: row.side.emoji, total: row.total, place: row.place, won: many && row.place === 1 && !r.tie, people: row.side.people.map(function (p) { return { id: p.id, name: p.name, emoji: p.emoji }; }), rec: recOf(g, row.side) };
      }),
      highlight: highlights(g)[0] || '',
    };
  }
  function keyName(key, h) {
    var info = gameInfo(key);
    if (info) return info.name;
    if (/^golf(9|18)$/.test(key)) return 'Mini golf (' + key.slice(4) + ' holes)';
    if (/^darts\d+$/.test(key)) return 'Darts ' + key.slice(5);
    return h ? h.name : key.replace(/^any:/, '');
  }
  function keyEmoji(key, h) {
    var info = gameInfo(key) || (/^golf/.test(key) ? gameInfo('golf') : /^darts/.test(key) ? gameInfo('darts') : null);
    return info ? info.emoji : (h && h.emoji) || gameInfo('any').emoji;
  }
  function byTime(a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : (a.id < b.id ? -1 : 1); }
  /** Wins, win rate and the current streak per person per game, the record
   *  for each game and who holds it, and the same across every game.
   *  `group`: only that group's games. A game with one player counts for
   *  records, never for wins. */
  function stats(history, opts) {
    var hs = (history || []).filter(function (h) { return !opts || !opts.group || h.group === opts.group; }).slice().sort(byTime);
    var games = {}, overall = {};
    var bump = function (map, p, h, side) {
      var row = map[p.id] || (map[p.id] = { id: p.id, name: p.name, emoji: p.emoji, played: 0, wins: 0, ties: 0, streak: 0, best: 0 });
      row.name = p.name; row.emoji = p.emoji;
      row.played++;
      if (side.won) { row.wins++; row.streak++; row.best = Math.max(row.best, row.streak); } else { row.streak = 0; if (side.place === 1 && h.tie) row.ties++; }
    };
    hs.forEach(function (h) {
      var gk = games[h.key] || (games[h.key] = { key: h.key, name: keyName(h.key, h), emoji: keyEmoji(h.key, h), kind: h.kind, played: 0, last: '', rows: {}, record: null });
      gk.played++; gk.last = h.at; gk.name = keyName(h.key, h);
      var spec = RECORDS[h.kind] || (h.kind === 'any' ? { label: 'Best score in ' + gk.name, high: !(h.sides[0] && h.sides[h.sides.length - 1] && h.sides[0].total < h.sides[h.sides.length - 1].total) } : null);
      h.sides.forEach(function (side) {
        var val = h.kind === 'any' || h.kind === 'hearts' ? side.total : side.rec;
        if (spec && Number.isInteger(val) && side.people.length === 1 && (h.kind !== 'any' || h.sides.length > 1)) {
          var better = !gk.record || (spec.high ? val > gk.record.value : val < gk.record.value);
          if (better) gk.record = { label: spec.label, value: val, name: side.people[0].name, emoji: side.people[0].emoji, id: side.people[0].id, at: h.at };
        }
        if (h.sides.length < 2) return;
        side.people.forEach(function (p) { bump(gk.rows, p, h, side); bump(overall, p, h, side); });
      });
    });
    var rank = function (map) {
      return Object.keys(map).map(function (k) { var r = map[k]; r.rate = r.played ? Math.round((r.wins / r.played) * 100) : 0; return r; })
        .sort(function (a, b) { return b.wins - a.wins || b.rate - a.rate || b.played - a.played || (a.name < b.name ? -1 : 1); });
    };
    var list = Object.keys(games).map(function (k) {
      var g = games[k];
      g.rows = rank(g.rows);
      g.next = g.record ? 'Next to beat: ' + recordText(g.record, g, k) : '';
      return g;
    }).sort(function (a, b) { return b.played - a.played || (a.last < b.last ? 1 : -1); });
    return { games: hs.length, byGame: list, overall: rank(overall) };
  }
  function recordText(rec, g, key) {
    var what = /^golf/.test(key) ? rec.value + ' in ' + keyName(key) : g.kind === 'hearts' ? rec.value + ' in Hearts' : g.kind === 'cribbage' ? rec.value + ' hand in Cribbage' : g.kind === 'darts' ? rec.value + ' checkout' : rec.value + ' in ' + g.name;
    return possessive(rec.name) + ' ' + what;
  }
  /** Two people, every game they both played on different sides: who
   *  finished ahead how often. */
  function headToHead(history, a, b) {
    var out = { games: 0, a: 0, b: 0, ties: 0, byGame: {}, last: null };
    (history || []).slice().sort(byTime).forEach(function (h) {
      var sa = null, sb = null;
      h.sides.forEach(function (s) { s.people.forEach(function (p) { if (p.id === a) sa = s; if (p.id === b) sb = s; }); });
      if (!sa || !sb || sa === sb) return;
      out.games++;
      var row = out.byGame[h.key] || (out.byGame[h.key] = { key: h.key, name: keyName(h.key, h), emoji: keyEmoji(h.key, h), a: 0, b: 0, ties: 0 });
      var w = sa.place < sb.place ? 'a' : sb.place < sa.place ? 'b' : 'ties';
      out[w]++; row[w]++;
      out.last = { at: h.at, name: keyName(h.key, h), w: w };
    });
    out.byGame = Object.keys(out.byGame).map(function (k) { return out.byGame[k]; }).sort(function (x, y) { return (y.a + y.b + y.ties) - (x.a + x.b + x.ties); });
    return out;
  }
  function h2hLine(h, an, bn) {
    if (!h.games) return an + ' and ' + bn + ' haven’t played each other yet.';
    return an + ' ' + h.a + ' – ' + h.b + ' ' + bn + (h.ties ? ' (' + plural(h.ties, 'tie') + ')' : '');
  }

  /* ------------------------------------------------------------------ *
   * Spreadsheets: CSV and JSON out and back in
   * ------------------------------------------------------------------ */

  var CSV_HEAD = ['game_id', 'date', 'game', 'key', 'kind', 'player', 'emoji', 'side', 'total', 'place', 'won', 'tie', 'record', 'highlight'];
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    // A cell a spreadsheet would run as a formula is defused with a quote.
    if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function historyCsv(history) {
    var rows = [CSV_HEAD.join(',')];
    (history || []).slice().sort(byTime).forEach(function (h) {
      h.sides.forEach(function (s) {
        s.people.forEach(function (p) {
          rows.push([h.id, h.at, h.name, h.key, h.kind, p.name, p.emoji, s.people.length > 1 ? s.name : '', s.total, s.place, s.won ? 'yes' : 'no', h.tie ? 'yes' : 'no', s.rec === null || s.rec === undefined ? '' : s.rec, h.highlight].map(csvCell).join(','));
        });
      });
    });
    return rows.join('\r\n') + '\r\n';
  }
  function parseCsv(text) {
    var rows = [], row = [], cell = '', q = false, s = str(text).replace(/^\ufeff/, '');
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
      if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
      if (rows.length > 20000) break;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return x.trim(); }); });
  }
  function undefuse(v) { return /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v; }
  /** History from a CSV this app made (or one shaped like it). */
  function historyFromCsv(text) {
    var rows = parseCsv(text);
    if (!rows.length) return { history: [], error: 'That file is empty.' };
    var head = rows[0].map(function (h) { return norm(h).replace(/ /g, '_'); });
    var col = function (n) { return head.indexOf(n); };
    if (col('game_id') < 0 || col('player') < 0 || col('total') < 0) return { history: [], error: 'That file has no game_id, player and total columns - export one from Pencil to see the shape.' };
    var byId = {}, order = [];
    rows.slice(1).forEach(function (r) {
      var get = function (n) { var i = col(n); return i < 0 ? '' : undefuse(String(r[i] || '').trim()); };
      var id = get('game_id');
      if (!/^g[a-z0-9]{5,15}$/.test(id)) return;
      var h = byId[id];
      if (!h) {
        h = byId[id] = { id: id, at: get('date'), name: get('game'), key: get('key'), kind: get('kind'), tie: get('tie') === 'yes', highlight: get('highlight'), group: '', sides: [], emoji: '' };
        order.push(id);
      }
      var side = get('side');
      var person = { id: '', name: get('player'), emoji: get('emoji') };
      var found = side ? h.sides.filter(function (s) { return s.team === side; })[0] : null;
      if (found) { found.people.push(person); return; }
      h.sides.push({ team: side, name: side || person.name, emoji: person.emoji, total: intIn(get('total'), LIMITS.minScore, LIMITS.score), place: intIn(get('place'), 1, LIMITS.sides), won: get('won') === 'yes', rec: intIn(get('record'), LIMITS.minScore, LIMITS.score), people: [person] });
    });
    var history = order.map(function (id) { return byId[id]; });
    if (!history.length) return { history: [], error: 'No games could be read from that file.' };
    return { history: history, error: '' };
  }
  function exportJson(store) {
    return JSON.stringify({ app: 'pencil', v: 1, people: store.people || [], groups: store.groups || [], history: store.history || [] }, null, 1);
  }
  /** Games from a file, merged into this phone's: people matched by id,
   *  then by name, else added; a game already here (same id) is skipped. */
  function mergeImport(mine, incoming, o) {
    var people = (mine.people || []).slice(), groups = (mine.groups || []).slice(), history = (mine.history || []).slice();
    var have = {};
    history.forEach(function (h) { have[h.id] = 1; });
    var idMap = {};
    var personFor = function (p) {
      var name = cleanName(p && p.name);
      if (!name) return null;
      if (p.id && idMap[p.id]) return idMap[p.id];
      var hit = people.filter(function (x) { return x.id === p.id && norm(x.name) === norm(name); })[0] || people.filter(function (x) { return norm(x.name) === norm(name); })[0];
      if (!hit) {
        if (people.length >= LIMITS.people) return null;
        hit = { id: freshId(o.rand, 'p', people.map(function (x) { return x.id; }), 8), name: name, emoji: cleanEmoji(p.emoji), at: o.now };
        people.push(hit);
      }
      if (p.id) idMap[p.id] = hit;
      return hit;
    };
    var added = 0, skipped = 0;
    (incoming.history || []).forEach(function (raw) {
      if (raw && have[raw.id]) { skipped++; return; }
      var h = cleanSummary(raw);
      if (!h) { skipped++; return; }
      var ok = true;
      h.sides.forEach(function (s) { s.people = s.people.map(function (p) { var q = personFor(p); if (!q) ok = false; return q ? { id: q.id, name: q.name, emoji: q.emoji } : null; }).filter(Boolean); });
      if (!ok || history.length >= LIMITS.history) { skipped++; return; }
      h.group = '';
      history.push(h); have[h.id] = 1; added++;
    });
    (incoming.groups || []).forEach(function (raw) {
      var gr = cleanGroup(raw);
      if (!gr || groups.length >= LIMITS.groups || groups.some(function (x) { return norm(x.name) === norm(gr.name); })) return;
      var ids = (raw.people || []).map(function (pid) { var src = (incoming.people || []).filter(function (x) { return x && x.id === pid; })[0]; var q = src ? personFor(src) : null; return q ? q.id : null; }).filter(Boolean);
      groups.push({ id: freshId(o.rand, 'r', groups.map(function (x) { return x.id; }), 8), name: gr.name, people: ids });
    });
    return { people: people, groups: groups, history: history.sort(byTime), added: added, skipped: skipped };
  }

  /* ------------------------------------------------------------------ *
   * One door: every game, person, group and history row read back from a
   * phone, a file or a server comes through these
   * ------------------------------------------------------------------ */

  function cleanSide(raw, team) {
    if (!raw || typeof raw !== 'object' || !isId(raw.id)) return null;
    var people = (Array.isArray(raw.people) ? raw.people : []).map(cleanPerson).filter(Boolean).slice(0, LIMITS.teamSize);
    if (!people.length) return null;
    var name = cleanName(raw.name, people.length > 1 ? LIMITS.gameName : LIMITS.name) || sideName(people);
    return { id: raw.id, name: name, emoji: cleanEmoji(raw.emoji, people[0].emoji), people: people, start: intIn(raw.start, LIMITS.minScore, LIMITS.score) || 0, from: intIn(raw.from, 0, LIMITS.rounds) || 0 };
  }
  function cleanCells(s, sides, lo, hi) {
    var out = {};
    sides.forEach(function (side) { if (s && own(s, side.id)) { var v = s[side.id]; out[side.id] = Number.isInteger(v) && v >= lo && v <= hi ? v : null; } });
    return out;
  }
  function cleanData(kind, settings, sides, raw) {
    var d = raw && typeof raw === 'object' ? raw : {};
    var data = emptyData(kind, settings, sides);
    var list = function (v) { return (Array.isArray(v) ? v : []).slice(0, LIMITS.rounds); };
    if (kind === 'any') {
      data.rounds = list(d.rounds).map(function (r) { return { s: cleanCells(r && r.s, sides, LIMITS.minScore, LIMITS.score), note: cleanNote(r && r.note) }; });
    } else if (kind === 'hearts') {
      data.hands = list(d.hands).map(function (h) {
        var moon = h && sides.some(function (s) { return s.id === h.moon; }) ? h.moon : '';
        return { s: cleanCells(h && h.s, sides, -26, 26), moon: moon, note: cleanNote(h && h.note) };
      });
    } else if (kind === 'cribbage') {
      data.hands = list(d.hands).map(function (h) {
        var peg = {}, hand = {};
        sides.forEach(function (s) {
          var p = h && h.peg && intIn(h.peg[s.id], 0, 61); peg[s.id] = p === null || p === undefined ? 0 : p;
          var c = h && h.hand && intIn(h.hand[s.id], 0, 29); hand[s.id] = c !== null && c !== undefined && cribHandOk(c) ? c : 0;
        });
        var crib = h ? intIn(h.crib, 0, 29) : null;
        return { peg: peg, hand: hand, crib: crib !== null && cribHandOk(crib) ? crib : 0, note: cleanNote(h && h.note) };
      });
    } else if (kind === 'golf') {
      var holes = Array.isArray(d.holes) ? d.holes : [];
      data.holes = data.holes.map(function (h0, i) {
        var h = holes[i] || {};
        return { par: intIn(h.par, 1, 12), s: cleanCells(h.s, sides, 1, settings.max) };
      });
    } else if (kind === 'dice') {
      sides.forEach(function (s) {
        var raw2 = d.sheets && d.sheets[s.id], b = {};
        BOX_IDS.forEach(function (k) { var v = raw2 && raw2.b ? raw2.b[k] : null; if (dicePossible(k, v)) b[k] = v; });
        var x = raw2 ? intIn(raw2.x, 0, 12) : 0;
        data.sheets[s.id] = { b: b, x: b.five === 50 && settings.extra ? (x || 0) : 0 };
      });
    } else if (kind === 'bowling') {
      sides.forEach(function (s) {
        var rolls = [];
        var raw2 = d.rolls && Array.isArray(d.rolls[s.id]) ? d.rolls[s.id].slice(0, 21) : [];
        for (var i = 0; i < raw2.length; i++) {
          var nx = bowlNext(rolls), v = raw2[i];
          if (!nx || !Number.isInteger(v) || v < 0 || v > nx.max) break;
          rolls.push(v);
        }
        data.rolls[s.id] = rolls;
      });
    } else if (kind === 'darts') {
      // Replayed from the start, so a stored bust or finish is always the
      // one the rules say - whoever wrote the file.
      sides.forEach(function (s) {
        var left = settings.start, out = [], done = false;
        var raw2 = d.turns && Array.isArray(d.turns[s.id]) ? d.turns[s.id].slice(0, LIMITS.rounds) : [];
        for (var i = 0; i < raw2.length && !done; i++) {
          var t = raw2[i] || {};
          var c = dartsCheck(left, t.s, settings.doubleOut, Boolean(t.f));
          if (c.error) break;
          out.push({ s: t.s, b: Boolean(c.bust), f: Boolean(c.finish) });
          if (!c.bust) left -= t.s;
          if (c.finish) done = true;
        }
        data.turns[s.id] = out;
      });
    }
    return data;
  }
  function cleanShared(raw) {
    if (!raw || typeof raw !== 'object' || !isTid(raw.id)) return null;
    return {
      id: raw.id, role: raw.role === 'scorer' ? 'scorer' : 'watcher',
      code: isCode(raw.code) ? raw.code : '', v: intIn(raw.v, 0, 1e6) || 0,
      at: typeof raw.at === 'number' && isFinite(raw.at) ? raw.at : 0,
      mv: intIn(raw.mv, 0, 1e6) || 0,
      members: (Array.isArray(raw.members) ? raw.members : []).slice(0, LIMITS.watchers + 1).map(function (m) {
        return m && isId(m.id) && cleanName(m.name) ? { id: m.id, name: cleanName(m.name), role: m.role === 'scorer' ? 'scorer' : 'watcher', you: m.you === true } : null;
      }).filter(Boolean),
    };
  }
  /** A game, rebuilt from whatever claims to be one. `opts.share` leaves
   *  out what only this phone keeps (undo, the group, sharing details).
   *  Null when nothing usable is left. */
  function cleanGame(raw, opts) {
    opts = opts || {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!isId(raw.id) || KINDS.indexOf(raw.kind) < 0) return null;
    var kind = raw.kind;
    var preset = kind === 'any' ? (own(PRESETS, raw.preset) ? raw.preset : 'custom') : '';
    var settings = cleanSettings(kind, preset, raw.settings);
    var seen = {};
    var sides = (Array.isArray(raw.sides) ? raw.sides : []).slice(0, LIMITS.sides).map(cleanSide).filter(function (s) { if (!s || seen[s.id]) return false; seen[s.id] = 1; return true; });
    if (!sides.length) return null;
    var info = kind === 'any' ? gameInfo(preset === 'custom' ? 'any' : preset) : gameInfo(kind);
    var now = isFinite(opts.now) ? opts.now : 0;
    var g = {
      id: raw.id, kind: kind, preset: preset,
      name: kind === 'any' && preset === 'custom' ? (plain(raw.name, LIMITS.gameName) || 'Any game') : info.name,
      sides: sides, settings: settings,
      data: cleanData(kind, settings, sides, raw.data),
      dealer: 0, status: 'playing', ended: raw.ended === true,
      group: !opts.share && isId(raw.group) ? raw.group : '',
      createdAt: isIso(raw.createdAt) ? raw.createdAt : iso(now), updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : iso(now),
      finishedAt: isIso(raw.finishedAt) ? raw.finishedAt : '',
    };
    var seats = seatsOf(g).length;
    g.dealer = intIn(raw.dealer, 0, Math.max(0, seats - 1)) || 0;
    var r = result(g);
    g.status = r.over ? 'done' : 'playing';
    if (r.over && !g.finishedAt) g.finishedAt = g.updatedAt;
    if (!r.over) g.finishedAt = '';
    if (!opts.share) {
      var snaps = function (v) { return (Array.isArray(v) ? v : []).filter(function (x) { return typeof x === 'string' && x.length < 200000 && x.charAt(0) === '{'; }).slice(-LIMITS.undo); };
      g.past = snaps(raw.past); g.future = snaps(raw.future);
      var sh = cleanShared(raw.shared);
      if (sh) g.shared = sh;
      // A game that came from someone else's table: its people are matched
      // to this phone's by name when it goes into the history.
      if (raw.foreign === true) g.foreign = true;
    }
    return g;
  }
  /** What a shared table holds: the game without anything only the
   *  scorer's phone keeps. */
  function shareGame(g) { return cleanGame(g, { share: true, now: Date.parse(g.updatedAt) || 0 }); }
  /** Too much to share? A message, or ''. Checked before cleaning, so a
   *  long game is refused rather than cut short. */
  function overLimits(raw) {
    if (!raw || typeof raw !== 'object') return 'That isn’t a game.';
    if (Array.isArray(raw.sides) && raw.sides.length > LIMITS.sides) return LIMITS.sides + ' players is the most one table takes.';
    var d = raw.data || {};
    var long = function (v) { return Array.isArray(v) && v.length > LIMITS.rounds; };
    if (long(d.rounds) || long(d.hands)) return LIMITS.rounds + ' rounds is the most one table keeps.';
    var per = d.turns || {};
    for (var k in per) if (own(per, k) && long(per[k])) return LIMITS.rounds + ' turns is the most one table keeps.';
    return '';
  }
  function cleanSummary(raw) {
    if (!raw || typeof raw !== 'object' || !/^g[a-z0-9]{5,15}$/.test(String(raw.id))) return null;
    var key = str(raw.key).slice(0, 60);
    if (!/^[a-z0-9]+(:[a-z0-9 ]{1,40})?$/.test(key)) return null;
    var kind = KINDS.indexOf(raw.kind) >= 0 ? raw.kind : null;
    if (!kind) return null;
    var sides = (Array.isArray(raw.sides) ? raw.sides : []).slice(0, LIMITS.sides).map(function (s) {
      if (!s || typeof s !== 'object') return null;
      var people = (Array.isArray(s.people) ? s.people : []).slice(0, LIMITS.teamSize).map(function (p) {
        var name = p && cleanName(p.name);
        return name ? { id: isId(p.id) ? p.id : '', name: name, emoji: cleanEmoji(p.emoji) } : null;
      }).filter(Boolean);
      if (!people.length) return null;
      var total = intIn(s.total, LIMITS.minScore, LIMITS.score);
      return { name: cleanName(s.name, people.length > 1 ? LIMITS.gameName : LIMITS.name) || sideName(people), emoji: cleanEmoji(s.emoji, people[0].emoji), total: total === null ? 0 : total, place: intIn(s.place, 1, LIMITS.sides) || 1, won: s.won === true, people: people, rec: intIn(s.rec, LIMITS.minScore, LIMITS.score) };
    }).filter(Boolean);
    if (!sides.length) return null;
    var info = gameInfo(key) || gameInfo(kind === 'any' ? 'any' : kind);
    return {
      id: raw.id, key: key, kind: kind, preset: kind === 'any' && own(PRESETS, raw.preset) ? raw.preset : '',
      name: plain(raw.name, LIMITS.gameName) || (info ? info.name : 'Game'), emoji: info ? info.emoji : '',
      at: isIso(raw.at) ? raw.at : '1970-01-01T00:00:00.000Z', group: isId(raw.group) ? raw.group : '',
      tie: raw.tie === true, sides: sides, highlight: plain(raw.highlight, 120),
    };
  }
  function cleanHistory(list) {
    var seen = {};
    return (Array.isArray(list) ? list : []).map(cleanSummary).filter(function (h) { if (!h || seen[h.id]) return false; seen[h.id] = 1; return true; }).sort(byTime).slice(-LIMITS.history);
  }
  function cleanPeople(list) {
    var seen = {};
    return (Array.isArray(list) ? list : []).map(function (p) {
      var c = cleanPerson(p);
      if (!c || seen[c.id] || seen['n' + norm(c.name)]) return null;
      seen[c.id] = 1; seen['n' + norm(c.name)] = 1;
      c.at = typeof p.at === 'number' && isFinite(p.at) ? p.at : 0;
      return c;
    }).filter(Boolean).slice(0, LIMITS.people);
  }
  function cleanGroup(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = plain(raw.name, LIMITS.groupName);
    if (!name || !/\p{L}|\p{N}/u.test(name)) return null;
    return { id: isId(raw.id) ? raw.id : '', name: name, people: (Array.isArray(raw.people) ? raw.people : []).filter(isId).slice(0, LIMITS.people) };
  }
  function cleanGroups(list) {
    var seen = {};
    return (Array.isArray(list) ? list : []).map(cleanGroup).filter(function (g) { if (!g || !g.id || seen[g.id]) return false; seen[g.id] = 1; return true; }).slice(0, LIMITS.groups);
  }
  /** People seen most recently first - one tap away when a game starts. */
  function recentPeople(people, n) {
    return (people || []).slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0) || (a.name < b.name ? -1 : 1); }).slice(0, n || 12);
  }

  /* ------------------------------------------------------------------ *
   * A shared table, as the server keeps it and members see it
   * ------------------------------------------------------------------ */

  /** The one shape a member gets: the game, who is at the table (first
   *  names and roles, never a key), the code for the scorer only. */
  function tableView(doc, mid) {
    var members = doc.members || {};
    var role = members[mid] ? members[mid].role : '';
    return {
      id: doc.id, v: doc.v || 0, mv: doc.mv || 0, role: role === 'scorer' ? 'scorer' : 'watcher',
      code: role === 'scorer' ? doc.code : '',
      game: doc.game,
      at: doc.updatedAt,
      members: Object.keys(members).map(function (k) { return { id: k, name: members[k].name, role: members[k].role === 'scorer' ? 'scorer' : 'watcher', you: k === mid, joinedAt: members[k].joinedAt || '' }; })
        .sort(function (a, b) { return (a.role === 'scorer' ? 0 : 1) - (b.role === 'scorer' ? 0 : 1) || (a.joinedAt < b.joinedAt ? -1 : 1); })
        .map(function (m) { return { id: m.id, name: m.name, role: m.role, you: m.you }; }),
    };
  }
  function joinUrl(origin, base, code) { return origin + base + '#join=' + normalizeCode(code); }
  /** The page's routes, read strictly. */
  function parseHash(h) {
    var s = str(h).replace(/^#/, '');
    var m;
    if (s === '' ) return { view: '' };
    if ((m = /^g\/([a-z][a-z0-9]{5,15})$/.exec(s))) return { view: 'game', id: m[1] };
    if ((m = /^join=([A-Za-z0-9-]{6,8})$/.exec(s))) { var c = normalizeCode(m[1]); return isCode(c) ? { view: 'join', code: c } : { view: '' }; }
    if (s === 'join') return { view: 'join', code: '' };
    if (s === 'new') return { view: 'new' };
    if ((m = /^new\/([a-z]{2,10})$/.exec(s)) && gameInfo(m[1])) return { view: 'setup', game: m[1] };
    if (s === 'table' || s === 'more' || s === 'games') return { view: s };
    return { view: '' };
  }

  /* ------------------------------------------------------------------ *
   * "Read a paper score sheet"
   * ------------------------------------------------------------------ */

  /** The request: exactly one JPEG or PNG and nothing else. */
  function aiRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (Object.keys(body).length !== 1 || !body.image || typeof body.image !== 'object') return null;
    var im = body.image;
    if (Object.keys(im).sort().join() !== 'data,type') return null;
    if (im.type !== 'image/jpeg' && im.type !== 'image/png') return null;
    if (typeof im.data !== 'string' || im.data.length < 16 || im.data.length > Math.ceil(LIMITS.aiImageBytes * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+=*$/.test(im.data)) return null;
    return { image: { type: im.type, data: im.data } };
  }
  var CONFIDENCE = ['high', 'medium', 'low'];
  function conf(v) { return CONFIDENCE.indexOf(v) >= 0 ? v : 'low'; }
  /** The model's answer, checked: at most 12 columns and 60 rows of whole
   *  numbers (-9999 to 99999, or blank), the names as written (letters only,
   *  20 characters), a confidence per column. Null when nothing usable. */
  function cleanAiAnswer(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var players = (Array.isArray(raw.players) ? raw.players : []).slice(0, LIMITS.aiCols).map(function (p) {
      var o2 = p && typeof p === 'object' ? p : { name: p };
      return { name: cleanName(plainOut(o2.name, 60), LIMITS.aiName), confidence: conf(o2.confidence) };
    });
    var rowsIn = (Array.isArray(raw.rows) ? raw.rows : []).slice(0, LIMITS.aiRows);
    var cols = players.length || Math.min(LIMITS.aiCols, rowsIn.reduce(function (m, r) { return Math.max(m, Array.isArray(r) ? r.length : 0); }, 0));
    while (players.length < cols) players.push({ name: '', confidence: 'low' });
    var rows = rowsIn.map(function (r) {
      var row = [];
      for (var i = 0; i < cols; i++) { var v = Array.isArray(r) ? r[i] : null; row.push(Number.isInteger(v) && v >= LIMITS.aiMin && v <= LIMITS.aiMax ? v : null); }
      return row;
    }).filter(function (r) { return r.some(function (v) { return v !== null; }); });
    if (!cols || !rows.length) return null;
    return { players: players, rows: rows, confidence: conf(raw.confidence), note: plainOut(raw.note, LIMITS.aiNote) };
  }
  var SHEET_KINDS = ['any', 'hearts', 'golf', 'darts'];
  /** Rows of a read sheet into a game: `map[col]` is a side id or '' to
   *  leave that column out. Every number goes through the game's own rules,
   *  so the result is what typing it would have made. Returns {game, added}
   *  or throws with the row that does not fit. */
  function applySheet(g, proposal, map) {
    if (SHEET_KINDS.indexOf(g.kind) < 0) throw fail(400, 'A paper sheet can go into Any game, Hearts, Mini golf or Darts.');
    var cols = [];
    (Array.isArray(map) ? map : []).forEach(function (sid, i) { if (sid && sideOf(g, sid) && cols.every(function (c) { return c.sid !== sid; })) cols.push({ i: i, sid: sid }); });
    if (!cols.length) throw fail(400, 'Match at least one column to a player.');
    var rows = proposal.rows || [];
    var added = 0;
    rows.forEach(function (row, n) {
      var where = 'Row ' + (n + 1) + ': ';
      try {
        if (g.kind === 'any') {
          var r = g.data.rounds.length;
          cols.forEach(function (c) { if (row[c.i] !== null) setCell(g, r, c.sid, row[c.i]); });
        } else if (g.kind === 'hearts') {
          if (cols.length !== g.sides.length) throw fail(400, 'Match every player to a column - a hand needs everyone’s points.');
          var s = {};
          cols.forEach(function (c) { s[c.sid] = row[c.i] === null ? 0 : row[c.i]; });
          addHand(g, { s: s });
        } else if (g.kind === 'golf') {
          if (n >= g.data.holes.length) throw fail(400, 'This course has ' + g.data.holes.length + ' holes.');
          cols.forEach(function (c) { if (row[c.i] !== null) setStroke(g, n, c.sid, row[c.i]); });
        } else if (g.kind === 'darts') {
          cols.forEach(function (c) {
            // A finished leg ends the sheet: nothing after it was thrown.
            if (row[c.i] === null || dartsWinner(g)) return;
            var left = dartsLeft(g, c.sid);
            var res = dartsTurn(g, c.sid, row[c.i], left === row[c.i] ? true : undefined);
            if (res.ask) throw fail(400, 'that finish needs a double.');
          });
        }
        added++;
      } catch (e) { throw fail(e.status || 400, where + e.message); }
    });
    return added;
  }

  /* ------------------------------------------------------------------ *
   * The recap card's words (the page draws it on a canvas)
   * ------------------------------------------------------------------ */

  /** Text cut to fit `max` pixels by `measure`, ending in an ellipsis. */
  function fitText(measure, text, max) {
    var s = line(text, 400);
    if (measure(s) <= max) return s;
    var cps = Array.from(s);
    while (cps.length > 1 && measure(cps.join('') + '…') > max) cps.pop();
    return cps.join('').trim() + '…';
  }
  /** The last line of a wrap: whole words and an ellipsis, when a word fits. */
  function lastLine(measure, words, max) {
    var cur = '';
    for (var i = 0; i < words.length; i++) {
      var next = cur ? cur + ' ' + words[i] : words[i];
      if (measure(next + (i < words.length - 1 ? '\u2026' : '')) > max) break;
      cur = next;
      if (i === words.length - 1) return cur;
    }
    return cur ? cur + '\u2026' : fitText(measure, words.join(' '), max);
  }
  /** Text in at most `lines` lines of `max` pixels, the last one cut. */
  function wrapText(measure, text, max, lines) {
    var words = line(text, 600).split(' ').filter(Boolean), out = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i], next = cur ? cur + ' ' + w : w;
      if (measure(next) <= max) { cur = next; continue; }
      if (cur) out.push(cur);
      cur = measure(w) <= max ? w : fitText(measure, w, max);
      if (out.length === lines - 1) { out.push(lastLine(measure, words.slice(i), max)); return out; }
    }
    if (cur) out.push(cur);
    return out.slice(0, lines);
  }
  function C2rounds(g) {
    var n = roundsOf(g);
    if (g.kind === 'bowling') return 'Ten frames';
    if (g.kind === 'dice') return 'Thirteen turns';
    if (g.kind === 'golf') return plural(g.data.holes.length, 'hole');
    if (g.kind === 'darts') return g.settings.start + ' \u00B7 ' + plural(n, 'turn');
    return plural(n, g.kind === 'any' ? 'round' : 'hand') + (g.kind === 'any' && g.settings.end === 'target' ? ' \u00B7 to ' + g.settings.target : g.kind === 'hearts' ? ' \u00B7 to ' + g.settings.endAt : '');
  }
  /** What the card says. `dateText` comes from the page (it knows the
   *  locale); at most eight rows, then "+3 more". */
  function recapData(g, dateText) {
    var r = result(g), info = infoOf(g);
    var rows = r.rows.slice(0, 8).map(function (row) {
      var sub = g.kind === 'golf' ? parLine(toPar(g, row.side.id)) : g.kind === 'darts' && dartsAverage(g, row.side.id) !== null ? 'avg ' + dartsAverage(g, row.side.id) : '';
      return { place: row.place, emoji: row.side.emoji, name: row.side.name, total: g.kind === 'darts' ? (row.total === 0 ? 'Out' : row.total + ' left') : String(row.total), sub: sub, win: r.winners.indexOf(row.side.id) >= 0 };
    });
    return {
      title: g.name, emoji: info ? info.emoji : '', date: dateText || '',
      headline: r.over ? r.line : 'Still playing - ' + r.line.charAt(0).toLowerCase() + r.line.slice(1),
      extra: r.extra, rows: rows, more: Math.max(0, r.rows.length - 8),
      highlight: highlights(g)[0] || '',
      stats: (C2rounds(g)) + (g.sides.length > 1 ? ' \u00B7 ' + plural(g.sides.length, g.sides.some(function (s) { return s.people.length > 1; }) ? 'team' : 'player') : ''),
      foot: 'Kept with Pencil',
    };
  }

  /* ------------------------------------------------------------------ *
   * The made-up game night: the Larkfield-Osei family and friends, every
   * name invented. The same every time (no clock, no dice): dates are
   * counted back from the `now` handed in.
   * ------------------------------------------------------------------ */

  var CAST = [
    { id: 'ppriya01', name: 'Priya', emoji: '\u{1F98A}' },
    { id: 'pmarcus1', name: 'Marcus', emoji: '\u{1F43B}' },
    { id: 'pnoorr01', name: 'Noor', emoji: '\u{1F33B}' },
    { id: 'pkaikai1', name: 'Kai', emoji: '\u{1F680}' },
    { id: 'pinesss1', name: 'Ines', emoji: '\u{1F422}' },
    { id: 'ptheooo1', name: 'Theo', emoji: '\u{1F3B8}' },
  ];
  function cast(name) { for (var i = 0; i < CAST.length; i++) if (CAST[i].name === name) return { id: CAST[i].id, name: CAST[i].name, emoji: CAST[i].emoji }; return null; }
  function demoRand() { var x = 7; return function (n) { x = (x * 1103515245 + 12345) % 2147483648; return Math.floor(x / 65536) % n; }; }
  function sampleNight(o) {
    var rand = demoRand();
    var at = function (daysAgo, hour) { return iso(o.now - daysAgo * 86400000 - (hour || 0) * 3600000); };
    var mk = function (game, names, extra) {
      var g = newGame(Object.assign({ game: game, players: names.map(cast) }, extra || {}), { now: o.now - 3 * 3600000, rand: rand });
      g.past = []; g.future = [];
      return g;
    };
    var ids = function (g) { return g.sides.map(function (s) { return s.id; }); };
    var people = CAST.map(function (p, i) { return { id: p.id, name: p.name, emoji: p.emoji, at: o.now - i * 60000 }; });
    var groups = [
      { id: 'rfamily1', name: 'Larkfield-Osei family', people: ['ppriya01', 'pmarcus1', 'pnoorr01', 'pkaikai1', 'pinesss1'] },
      { id: 'rthursd1', name: 'Thursday crew', people: ['pnoorr01', 'pmarcus1', 'ptheooo1', 'pkaikai1'] },
    ];

    // Hearts, seven hands in: Priya shot the moon once and leads on 30 -
    // one more moon and Marcus goes past 100.
    var hearts = mk('hearts', ['Priya', 'Marcus', 'Noor', 'Kai'], { group: 'rfamily1' });
    var hs = ids(hearts);
    [[3, 13, 6, 4], 'moon', [8, 2, 16, 0], [1, 5, 3, 17], [13, 4, 2, 7], [2, 18, 1, 5], [3, 12, 10, 1]].forEach(function (h) {
      if (h === 'moon') { addHand(hearts, { moon: hs[0] }); return; }
      var s = {}; hs.forEach(function (id, i) { s[id] = h[i]; });
      addHand(hearts, { s: s });
    });
    hearts.data.hands[4].note = 'Marcus held the queen all hand';

    // Five dice, finished earlier tonight.
    var dice = mk('dice', ['Ines', 'Theo', 'Kai'], { group: '' });
    var ds = ids(dice);
    var sheets = [
      { ones: 3, twos: 6, threes: 12, fours: 12, fives: 20, sixes: 18, three: 24, four: 22, full: 25, small: 30, large: 40, five: 0, chance: 21 },
      { ones: 2, twos: 4, threes: 9, fours: 16, fives: 15, sixes: 24, three: 26, four: 0, full: 25, small: 30, large: 0, five: 50, chance: 23 },
      { ones: 1, twos: 6, threes: 6, fours: 8, fives: 10, sixes: 18, three: 18, four: 0, full: 0, small: 30, large: 40, five: 0, chance: 25 },
    ];
    ds.forEach(function (id, i) { BOX_IDS.forEach(function (k) { diceSet(dice, id, k, sheets[i][k]); }); });
    dice.status = 'done'; dice.finishedAt = at(0, 2); dice.updatedAt = dice.finishedAt;

    // Bowling, six frames in - Marcus opened with a turkey.
    var bowl = mk('bowling', ['Marcus', 'Noor', 'Theo'], { group: 'rthursd1' });
    var bs = ids(bowl);
    bowl.data.rolls[bs[0]] = [10, 10, 10, 9, 1, 8, 1, 10];
    bowl.data.rolls[bs[1]] = [7, 2, 9, 1, 10, 8, 2, 6, 3, 9, 0];
    bowl.data.rolls[bs[2]] = [5, 4, 10, 3, 7, 8, 1, 10, 9, 1];

    // Darts 501: Noor needs 121 - a three-dart finish.
    var darts = mk('darts', ['Noor', 'Kai'], { group: 'rthursd1' });
    var dd = ids(darts);
    [[100, 60], [60, 41], [85, 100], [135, 81]].forEach(function (t) { dartsTurn(darts, dd[0], t[0]); dartsTurn(darts, dd[1], t[1]); });

    // Cribbage: Ines 96, Theo 81, Ines dealt first.
    var crib = mk('cribbage', ['Ines', 'Theo'], { group: '' });
    var cs = ids(crib);
    [[2, 4, 8, 6, 4], [3, 1, 12, 8, 2], [1, 5, 6, 16, 6], [4, 2, 24, 7, 0], [3, 3, 10, 12, 5], [2, 4, 6, 8, 3]].forEach(function (h) {
      var peg = {}, hand = {};
      peg[cs[0]] = h[0]; peg[cs[1]] = h[1]; hand[cs[0]] = h[2]; hand[cs[1]] = h[3];
      addCribHand(crib, { peg: peg, hand: hand, crib: h[4] });
    });

    var games = [hearts, bowl, darts, crib, dice];
    games.forEach(function (g, i) { g.updatedAt = g.status === 'done' ? g.updatedAt : at(0, 0.1 * (i + 1)); });

    // Two months of Friday nights, so the table has stories: Priya's
    // Hearts run, Marcus's 287 in Bowling, Noor's 121 checkout, Kai's 312.
    var P = function (name, total, rec) { var p = cast(name); return { name: p.name, emoji: p.emoji, total: total, rec: rec === undefined ? null : rec, people: [p] }; };
    var T = function (names, total) { var ps = names.map(cast); return { name: sideName(ps), emoji: ps[0].emoji, total: total, rec: null, people: ps }; };
    var past = [
      [63, 'hearts', 'rfamily1', [P('Priya', 41), P('Kai', 77), P('Noor', 88), P('Marcus', 102)], 'Priya shot the moon once'],
      [63, 'rummy', 'rfamily1', [P('Marcus', 512), P('Ines', 455), P('Noor', 390)], ''],
      [56, 'dice', '', [P('Kai', 312, 312), P('Priya', 244, 244), P('Ines', 230, 230)], 'Kai scored 312'],
      [56, 'hearts', 'rfamily1', [P('Noor', 52), P('Priya', 60), P('Marcus', 79), P('Kai', 104)], ''],
      [49, 'bowling', 'rthursd1', [P('Marcus', 287, 287), P('Theo', 182, 182), P('Noor', 164, 164)], 'Marcus threw 9 strikes in a row'],
      [49, 'darts501', 'rthursd1', [P('Noor', 0, 121), P('Theo', 64)], 'Noor checked out 121'],
      [42, 'euchre', 'rthursd1', [T(['Noor', 'Theo'], 10), T(['Marcus', 'Kai'], 7)], ''],
      [42, 'hearts', 'rfamily1', [P('Priya', 38), P('Ines', 66), P('Noor', 81), P('Marcus', 100)], ''],
      [35, 'golf9', 'rfamily1', [P('Kai', 24, 24), P('Priya', 27, 27), P('Marcus', 29, 29), P('Noor', 31, 31), P('Ines', 33, 33)], 'Kai got a hole in one on hole 4'],
      [35, 'cribbage', '', [P('Ines', 121, 20), P('Marcus', 84, 12)], 'Ines skunked Marcus'],
      [28, 'hearts', 'rfamily1', [P('Priya', 44), P('Kai', 58), P('Marcus', 90), P('Noor', 101)], 'Priya shot the moon once'],
      [28, 'dice', '', [P('Ines', 271, 271), P('Kai', 255, 255), P('Priya', 213, 213)], ''],
      [21, 'bowling', 'rthursd1', [P('Theo', 201, 201), P('Marcus', 188, 188), P('Noor', 150, 150)], 'Theo broke 200 with 201'],
      [21, 'rummy', 'rfamily1', [P('Ines', 505), P('Priya', 470), P('Marcus', 420)], ''],
      [14, 'hearts', 'rfamily1', [P('Priya', 33), P('Noor', 70), P('Kai', 85), P('Marcus', 105)], ''],
      [14, 'darts501', 'rthursd1', [P('Theo', 0, 40), P('Noor', 32)], ''],
      [7, 'cardgolf', 'rfamily1', [P('Noor', 18), P('Kai', 23), P('Priya', 29), P('Marcus', 35)], ''],
      [7, 'golf9', 'rfamily1', [P('Priya', 25, 25), P('Kai', 26, 26), P('Ines', 30, 30), P('Marcus', 32, 32)], ''],
      [7, 'dice', '', [P('Kai', 289, 289), P('Ines', 240, 240), P('Noor', 236, 236)], 'Kai rolled five of a kind'],
    ];
    var kindOfKey = function (k) { return gameInfo(k) ? gameInfo(k).kind : /^golf/.test(k) ? 'golf' : /^darts/.test(k) ? 'darts' : 'any'; };
    var history = past.map(function (row, i) {
      var key = row[1], kind = kindOfKey(key), low = kind === 'hearts' || kind === 'golf' || key === 'cardgolf' || kind === 'darts';
      var sides = row[3].slice();
      sides.forEach(function (s, k) { s.place = k + 1; s.won = k === 0; });
      void low;
      return { id: 'gpast' + String(100 + i), key: key, kind: kind, preset: kind === 'any' ? key : '', name: keyName(key), emoji: keyEmoji(key), at: at(row[0], 20 - (i % 3)), group: row[2], tie: false, sides: sides, highlight: row[4] };
    });
    history.push(summarize(dice));
    return { people: people, groups: groups, games: games, history: cleanHistory(history) };
  }

  return {
    LIMITS: LIMITS, fail: fail,
    line: line, plain: plain, plainOut: plainOut, esc: esc, norm: norm, cleanName: cleanName, cleanNote: cleanNote, plural: plural, possessive: possessive, listNames: listNames,
    iso: iso, intIn: intIn, clone: clone,
    newId: newId, freshId: freshId, isId: isId, isTid: isTid, CODE_ALPHABET: CODE_ALPHABET, CODE_LEN: CODE_LEN, normalizeCode: normalizeCode, isCode: isCode, formatCode: formatCode,
    EMOJI: EMOJI, cleanEmoji: cleanEmoji,
    GAMES: GAMES, KINDS: KINDS, PRESETS: PRESETS, gameInfo: gameInfo, infoOf: infoOf, statKey: statKey, lowWins: lowWins, defaultSettings: defaultSettings, cleanSettings: cleanSettings,
    cleanPerson: cleanPerson, newGame: newGame, sideOf: sideOf, seatsOf: seatsOf, usesDealer: usesDealer, dealerFor: dealerFor, passFor: passFor, maxSides: maxSides,
    setCell: setCell, roundDone: roundDone, inRound: inRound,
    heartsHand: heartsHand, heartsCheckLine: heartsCheckLine, addHand: addHand, editHand: editHand, moonsOf: moonsOf,
    cribHandOk: cribHandOk, cribHand: cribHand, addCribHand: addCribHand, cribBoard: cribBoard, skunks: skunks,
    setStroke: setStroke, setPar: setPar, toPar: toPar, parLine: parLine,
    BOXES: BOXES, BOX_IDS: BOX_IDS, boxInfo: boxInfo, diceScore: diceScore, dicePossible: dicePossible, possibleLine: possibleLine, diceSet: diceSet, diceExtra: diceExtra, diceSums: diceSums, isJoker: isJoker,
    bowlNext: bowlNext, bowlFrames: bowlFrames, bowlAdd: bowlAdd, bowlMax: bowlMax, strikeRun: strikeRun,
    DARTS: DARTS, dartsPossible: dartsPossible, checkout: checkout, dartValue: dartValue, dartsCheck: dartsCheck, dartsLeft: dartsLeft, dartsTurn: dartsTurn, dartsWinner: dartsWinner, dartsAverage: dartsAverage, dartsCheckoutScore: dartsCheckoutScore,
    totals: totals, standings: standings, result: result, nextUp: nextUp, started: started, roundsOf: roundsOf, gameLine: gameLine,
    change: change, undo: undo, redo: redo, canUndo: canUndo, canRedo: canRedo, settle: settle,
    addSide: addSide, dropSide: dropSide, renameSide: renameSide, moveSide: moveSide, setDealer: setDealer, setNote: setNote, endNow: endNow,
    highlights: highlights, summarize: summarize, stats: stats, headToHead: headToHead, h2hLine: h2hLine, keyName: keyName, keyEmoji: keyEmoji, RECORDS: RECORDS,
    historyCsv: historyCsv, historyFromCsv: historyFromCsv, parseCsv: parseCsv, exportJson: exportJson, mergeImport: mergeImport,
    cleanGame: cleanGame, shareGame: shareGame, overLimits: overLimits, cleanSummary: cleanSummary, cleanHistory: cleanHistory, cleanPeople: cleanPeople, cleanGroup: cleanGroup, cleanGroups: cleanGroups, recentPeople: recentPeople,
    tableView: tableView, joinUrl: joinUrl, parseHash: parseHash,
    aiRequest: aiRequest, cleanAiAnswer: cleanAiAnswer, CONFIDENCE: CONFIDENCE, SHEET_KINDS: SHEET_KINDS, applySheet: applySheet,
    fitText: fitText, wrapText: wrapText, recapData: recapData,
    sampleNight: sampleNight,
  };
});
