/* Settle - the rules, in one file, run three times: by the page (the demo,
 * the swipe deck, the reveal), by the server (which checks and stores every
 * vote) and by the tests. UMD: window.SettleCore in the page, require() in
 * node.
 *
 * Nothing here touches a store, the network or the clock on its own: every
 * function is handed `now` (ms), so two phones looking at one decision draw
 * the same result, and the tie-break wheel lands on the same slice.
 *
 * What is in it:
 *   - cleaning: one door for every typed string (questions, options, names)
 *     and for a model's suggestions - no markup, no control or bidi
 *     characters, bounded, emoji split off the front of a label;
 *   - the built-in decks (free, no model);
 *   - a decision: options, mode (swipe or rank), vetoes, named or anonymous
 *     votes, "show as we go", a deadline and how many people;
 *   - the votes: Yes / No / Love per option (swipe), a top 3 (rank), one
 *     veto each, first come first served;
 *   - closing: by the host, by the deadline, or when everyone expected has
 *     voted - worked out on read, never by a timer;
 *   - the results: a swipe match (everyone said Yes or Love) or a ranking by
 *     score with Love counting double; ranked choice (instant runoff) with
 *     every round in words; a tie-break wheel that is the same on every
 *     phone (a hash of the decision id, the round and the tied options);
 *   - "re-open with the top 3", and the lines people paste in the chat.
 *
 * Every vote returns {patch: {set: {'ballots.<vid>.<oid>': v}, del: [...]},
 * msg}: the page applies it to its own copy (`applyPatch`) and the server
 * writes it as single keys in a transaction, so many phones voting at once
 * never lose each other's votes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SettleCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  const LIMITS = {
    question: 120,
    label: 60,
    note: 80,
    name: 24,
    prompt: 200,
    optionsMin: 2,
    optionsMax: 30,
    voters: 50,
    rankTop: 3,
    pasteChars: 6000,
    deadlineMinMs: 60 * 1000,
    deadlineMaxMs: 7 * 24 * 3600 * 1000,
    suggestMin: 3,
    suggestMax: 20,
    deckTicked: 12,
  };
  const MODES = ['swipe', 'rank'];
  const VOTES = ['no', 'yes', 'love'];
  // Love counts double in a ranking. A No is zero, not minus one: a ranking
  // by "how much does this group want it", not "how much does it object" -
  // objecting is what the veto is for.
  const WEIGHT = { no: 0, yes: 1, love: 2 };
  const ALPHABET36 = '0123456789abcdefghijklmnopqrstuvwxyz';

  /* ------------------------------------------------------------------ *
   * Cleaning: one door for every string
   * ------------------------------------------------------------------ */

  // Control characters and the bidi overrides and isolates: they never belong
  // in anything typed or read (an option like "‮azziP" would draw
  // backwards on every phone). The zero-width joiner stays: emoji need it.
  const STRIP = /[\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁠-⁩﻿]/g;

  /** One line of untrusted text: no markup, no control or bidi characters,
   *  single spaces, at most `max` characters, cut on a whole character. Cut
   *  before any pattern runs, so hostile input costs linear time. */
  function clean(v, max) {
    let s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 200) s = s.slice(0, max * 4 + 200);
    s = s.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
    return s;
  }
  /** Text that has to say something: a letter, a digit or an emoji. */
  function cleanText(v, max) {
    const s = clean(v, max);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  function cleanQuestion(v) { return cleanText(v, LIMITS.question); }
  function cleanName(v) { return cleanText(v, LIMITS.name); }

  // One emoji at the front: a pictograph (with its variation selector, skin
  // tone and ZWJ sequence) or a flag.
  const EMOJI_RE = /^(?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2})/u;
  function cleanEmoji(v) {
    if (typeof v !== 'string') return '';
    const s = v.replace(STRIP, '').trim().slice(0, 24);
    const m = EMOJI_RE.exec(s);
    return m ? m[0] : '';
  }
  /** "🍜 Ramen" -> {emoji: '🍜', label: 'Ramen'}. */
  function splitLead(s) {
    const t = String(s || '').replace(STRIP, ' ').trim();
    const m = EMOJI_RE.exec(t);
    if (!m) return { emoji: '', label: t };
    const rest = t.slice(m[0].length).replace(/^[\s\-–:·]+/, '');
    return { emoji: m[0], label: rest || '' };
  }
  function fold(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\p{Extended_Pictographic}]+/gu, '');
  }

  /** One option, typed, from a deck or from a model: {label, emoji, note},
   *  or null when there is nothing left of it. A label with only an emoji
   *  keeps the emoji as its label. */
  function cleanOption(o) {
    let raw = o;
    let emoji = '';
    let note = '';
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      raw = o.label;
      emoji = cleanEmoji(o.emoji);
      note = clean(o.note, LIMITS.note);
    }
    if (typeof raw !== 'string') return null;
    const lead = splitLead(raw.slice(0, LIMITS.label * 4 + 200));
    if (!emoji && lead.emoji) emoji = lead.emoji;
    let label = cleanText(lead.label, LIMITS.label);
    if (!label && lead.emoji && !lead.label) label = lead.emoji;
    if (!label) return null;
    return { label, emoji, note: /[\p{L}\p{N}]/u.test(note) ? note : '' };
  }

  /** Options for a decision: cleaned, repeats folded away, at most
   *  `optionsMax`, each with an id (o0, o1, ...). */
  function cleanOptions(list) {
    const out = [];
    const seen = new Set();
    let dropped = 0;
    for (const o of (Array.isArray(list) ? list : []).slice(0, 300)) {
      const c = cleanOption(o);
      if (!c) continue;
      const k = fold(c.label) || c.label;
      if (seen.has(k)) continue;
      if (out.length >= LIMITS.optionsMax) { dropped++; continue; }
      seen.add(k);
      out.push({ id: 'o' + out.length.toString(36), label: c.label, emoji: c.emoji, note: c.note });
    }
    return { options: out, dropped };
  }

  /** Typed one per line ("🍜 Ramen", "- Thai", "3. Pizza"); a single line
   *  with commas is split on them ("Pizza, Thai, Ramen"). */
  function parseLines(text) {
    let s = typeof text === 'string' ? text.slice(0, LIMITS.pasteChars) : '';
    let lines = s.split(/\r?\n/);
    if (lines.filter((l) => l.trim()).length === 1 && /,/.test(s)) lines = s.split(',');
    const items = [];
    for (const l of lines) {
      const t = l.replace(/^\s*(?:[-*•·]+|\d{1,2}[.)])\s*/, '').trim();
      if (t) items.push(t);
    }
    return cleanOptions(items);
  }

  function isOptionId(v) { return typeof v === 'string' && /^o[0-9a-z]{1,2}$/.test(v); }
  function isVoterId(v) { return typeof v === 'string' && /^v[0-9a-z]{8}$/.test(v); }
  function newVoterId(rand) {
    let s = 'v';
    for (let i = 0; i < 8; i++) s += ALPHABET36[rand(36)];
    return s;
  }
  function cleanMode(v) { return MODES.indexOf(v) >= 0 ? v : 'swipe'; }
  function cleanVote(v) { return VOTES.indexOf(v) >= 0 ? v : null; }
  function cleanMax(v) {
    const n = typeof v === 'string' && /^\s*\d{1,3}\s*$/.test(v) ? Number(v) : v;
    return Number.isInteger(n) && n >= 2 && n <= LIMITS.voters ? n : null;
  }
  /** A deadline as ms since the epoch, a minute to seven days away; anything
   *  else is no deadline. */
  function cleanDeadline(v, now) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{10,14}$/.test(v) ? Number(v) : NaN);
    if (!Number.isFinite(n)) return null;
    if (n < now + LIMITS.deadlineMinMs || n > now + LIMITS.deadlineMaxMs) return null;
    return Math.floor(n);
  }

  function fail(status, message, extra) {
    const e = new Error(message);
    e.status = status; e.expose = true;
    if (extra) Object.assign(e, extra);
    return e;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  /** "a", "a and b", "a, b and c". */
  function nameList(names) {
    if (names.length <= 2) return names.join(' and ');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  /** FNV-1a, 32 bits, finalised. The tie-break wheel. */
  function hash32(s) {
    let h = 0x811c9dc5;
    const str = String(s);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }
  const own = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);

  /* ------------------------------------------------------------------ *
   * The decks: free, built in, no model
   * ------------------------------------------------------------------ */

  const d = (id, name, emoji, question, vetoes, items) => ({ id, name, emoji, question, vetoes, items: items.map((x) => ({ emoji: x[0], label: x[1] })) });
  const DECKS = [
    d('cuisines', 'Cuisines', '🍜', 'Where are we eating?', true, [
      ['🍕', 'Pizza'], ['🍜', 'Ramen'], ['🌮', 'Tacos'], ['🍣', 'Sushi'], ['🍛', 'Indian'], ['🍔', 'Burgers'], ['🌶️', 'Thai'], ['🥡', 'Chinese'],
      ['🍝', 'Italian'], ['🥙', 'Greek'], ['🧆', 'Middle Eastern'], ['🍲', 'Korean'], ['🥢', 'Vietnamese'], ['🥘', 'Spanish tapas'], ['🍖', 'BBQ'], ['🍤', 'Seafood'],
      ['🥩', 'Steakhouse'], ['🥟', 'Dumplings'], ['🍗', 'Fried chicken'], ['🫓', 'Ethiopian'], ['🧀', 'French bistro'], ['🍳', 'Brunch spot'], ['🥗', 'Something healthy'], ['🌯', 'Mexican'],
    ]),
    d('takeaway', 'Takeaway', '🥡', 'What are we ordering?', true, [
      ['🍕', 'Pizza'], ['🍔', 'Burgers'], ['🥡', 'Chinese'], ['🍛', 'Curry'], ['🍣', 'Sushi'], ['🌯', 'Burritos'], ['🍗', 'Fried chicken'], ['🥙', 'Kebab'],
      ['🍜', 'Noodles'], ['🍟', 'Fish and chips'], ['🥗', 'Poke bowls'], ['🌮', 'Tacos'], ['🥟', 'Dumplings'], ['🍝', 'Pasta'], ['🍖', 'BBQ'], ['🥪', 'Subs'],
    ]),
    d('date', 'Date night', '🕯️', 'What’s the plan tonight?', false, [
      ['🍝', 'Cook dinner together'], ['🎬', 'Movie night in'], ['🍷', 'Wine bar'], ['🎳', 'Bowling'], ['🎨', 'Paint and sip'], ['🌅', 'Sunset walk'],
      ['🎤', 'Karaoke'], ['🧩', 'Puzzle and takeout'], ['🍸', 'Cocktail bar'], ['🎭', 'Comedy show'], ['🎶', 'Live music'], ['⛸️', 'Ice skating'],
      ['🍦', 'Dessert crawl'], ['🏛️', 'Museum late'], ['🛁', 'Spa night at home'], ['🎲', 'Board game café'], ['🌌', 'Stargazing'], ['🍣', 'Try somewhere new'],
    ]),
    d('weekend', 'Weekend plans', '🌞', 'What are we doing this weekend?', false, [
      ['🥾', 'Hike'], ['🚲', 'Bike ride'], ['🏖️', 'Beach day'], ['🧺', 'Picnic'], ['🥕', 'Farmers market'], ['🏊', 'Swimming'], ['🎡', 'Fair or festival'],
      ['🏛️', 'Museum'], ['🎳', 'Bowling'], ['⛳', 'Mini golf'], ['🧗', 'Climbing gym'], ['🥞', 'Big brunch'], ['🎬', 'Cinema'], ['🚗', 'Day trip'],
      ['🛶', 'Kayaking'], ['🎮', 'Games day at home'], ['🥏', 'Park and frisbee'], ['🍺', 'Brewery'], ['🧘', 'Yoga class'], ['🎨', 'Make something'],
    ]),
    d('games', 'Board & party games', '🎲', 'What are we playing?', false, [
      ['🃏', 'Uno'], ['🏝️', 'Catan'], ['🚂', 'Ticket to Ride'], ['🕵️', 'Codenames'], ['✏️', 'Pictionary'], ['🙊', 'Charades'], ['🐱', 'Exploding Kittens'],
      ['🔤', 'Scrabble'], ['🎩', 'Monopoly'], ['❓', 'Trivia'], ['🐺', 'Werewolf'], ['🦠', 'Pandemic'], ['🎲', 'Yahtzee'], ['♟️', 'Chess'],
      ['♠️', 'Poker night'], ['📡', 'Wavelength'], ['🖼️', 'Dixit'], ['🏰', 'Carcassonne'], ['🀄', 'Mahjong'], ['🐉', 'A one-shot RPG'],
    ]),
    d('movies', 'Movie genres & moods', '🍿', 'What are we watching?', false, [
      ['😂', 'Comedy'], ['💥', 'Action'], ['👻', 'Horror'], ['💕', 'Rom-com'], ['🚀', 'Sci-fi'], ['🔍', 'Mystery'], ['🧙', 'Fantasy'],
      ['🎨', 'Animated'], ['🎭', 'Drama'], ['🎵', 'Musical'], ['🌍', 'Documentary'], ['🤠', 'Western'], ['🦸', 'Superhero'], ['🧸', 'Family classic'],
      ['😱', 'Thriller'], ['📼', '80s nostalgia'], ['🏆', 'Award winner'], ['🌈', 'Feel-good'], ['😭', 'A good cry'], ['🔁', 'Rewatch a favourite'],
    ]),
    d('rainy', 'Rainy-day ideas', '🌧️', 'Rainy day - what now?', false, [
      ['🍪', 'Bake something'], ['🧩', 'Jigsaw'], ['🎬', 'Movie marathon'], ['🏰', 'Blanket fort'], ['📚', 'Reading afternoon'], ['🎮', 'Video games'],
      ['🎨', 'Arts and crafts'], ['🍲', 'Make a big soup'], ['🎲', 'Board games'], ['🧘', 'Yoga at home'], ['🎤', 'Living-room karaoke'], ['🏛️', 'Museum'],
      ['🏊', 'Indoor pool'], ['🎳', 'Bowling'], ['☕', 'Café hop'], ['🧹', 'Big clear-out with music'],
    ]),
    d('holiday', 'Holiday vibes', '🏝️', 'Where should we go?', false, [
      ['🏖️', 'Beach and do nothing'], ['🏔️', 'Mountains'], ['🏙️', 'City break'], ['🏕️', 'Camping'], ['🚗', 'Road trip'], ['🛳️', 'Cruise'],
      ['🎿', 'Ski trip'], ['🌴', 'Tropical island'], ['🏰', 'Castles and history'], ['🍷', 'Food and wine'], ['🧖', 'Spa retreat'], ['🎢', 'Theme parks'],
      ['🦁', 'Safari'], ['🛶', 'Lakes and cabins'], ['🎉', 'Party city'], ['🚆', 'Train adventure'], ['🌋', 'Hot springs'], ['🧭', 'Somewhere none of us has been'],
    ]),
  ];
  const DECK = {};
  for (const x of DECKS) DECK[x.id] = x;

  /* ------------------------------------------------------------------ *
   * A decision
   * ------------------------------------------------------------------ */

  /**
   * A new decision from what the creator typed or picked. Throws a 400 the
   * page can show when it cannot be one. `host` is the creator's voter id
   * and name; the server adds the code and the creator's key hash.
   */
  function newDecision(b, ctx) {
    const now = ctx.now;
    const question = cleanQuestion(b && b.question);
    if (!question) throw fail(400, 'Ask the group something - “Where are we eating?”');
    const raw = Array.isArray(b.options) ? b.options : (typeof b.text === 'string' ? parseLines(b.text).options : []);
    const { options } = cleanOptions(raw);
    if (options.length < LIMITS.optionsMin) throw fail(400, 'Add at least two options to choose between.');
    const mode = cleanMode(b.mode);
    const vid = ctx.hostVid;
    const at = new Date(now).toISOString();
    return {
      question, mode, opts: options, active: options.map((o) => o.id),
      vetoes: b.vetoes === true, named: b.named === true, live: b.live === true,
      deadline: cleanDeadline(b.deadline, now), max: cleanMax(b.max),
      round: 1, past: [], closed: null, next: null,
      voters: { [vid]: { name: cleanName(b.name) || 'Host', host: true, at } },
      ballots: {}, ranks: {}, vetoed: {},
      createdAt: at, updatedAt: at, v: 1,
    };
  }

  function optionOf(doc, oid) { return (doc.opts || []).find((o) => o.id === oid) || null; }
  function voterIds(doc) {
    return Object.keys(doc.voters || {}).sort((a, b) => String(doc.voters[a].at).localeCompare(String(doc.voters[b].at)) || (a < b ? -1 : 1));
  }
  /** This round's options still in play: the active ones nobody vetoed. */
  function live(doc) {
    const vet = doc.vetoed || {};
    return (doc.active || []).filter((id) => !own(vet, id) && optionOf(doc, id));
  }
  function vetoesOn(doc) { return Boolean(doc.vetoes) && (doc.round || 1) === 1; }
  /** The option this voter vetoed, if any. */
  function vetoOf(doc, vid) {
    const vet = doc.vetoed || {};
    for (const k of Object.keys(vet)) if (vet[k] === vid) return k;
    return null;
  }
  /** Has this voter finished? Swipe: an answer on every option in play.
   *  Rank: a top 3 (or as many as there are) handed in. */
  function isDone(doc, vid) {
    const L = live(doc);
    if (!L.length) return true;
    if (doc.mode === 'rank') return Array.isArray((doc.ranks || {})[vid]) && doc.ranks[vid].some((id) => L.indexOf(id) >= 0);
    const b = (doc.ballots || {})[vid] || {};
    return L.every((id) => own(b, id));
  }
  function doneCount(doc) { return voterIds(doc).filter((v) => isDone(doc, v)).length; }

  /**
   * Open or closed, and why. Closed when the host closed it, when the
   * deadline has passed, or when the number of people expected (`max`) have
   * all finished. Worked out on every read - there is no timer.
   */
  function status(doc, now) {
    const joined = voterIds(doc).length;
    const done = doneCount(doc);
    let why = null; let at = null;
    if (doc.closed) { why = doc.closed.why || 'host'; at = doc.closed.at || null; }
    else if (doc.deadline && now >= doc.deadline) { why = 'deadline'; at = doc.deadline; }
    else if (doc.max && done >= doc.max) { why = 'all'; at = null; }
    return { open: !why, why, at, joined, done, expected: doc.max || null };
  }
  function closedText(st) {
    if (st.open) return '';
    if (st.why === 'deadline') return 'The deadline passed.';
    if (st.why === 'all') return 'Everyone voted.';
    return 'The host closed voting.';
  }
  function needOpen(doc, now) {
    const st = status(doc, now);
    if (!st.open) throw fail(409, 'Voting has closed - ' + closedText(st).toLowerCase().replace(/\.$/, '') + '.', { code: 'closed' });
    return st;
  }
  function needVoter(doc, vid) {
    if (!isVoterId(vid) || !own(doc.voters, vid)) throw fail(404, 'Nothing here.');
  }
  function needLive(doc, oid) {
    if (!isOptionId(oid) || (doc.active || []).indexOf(oid) < 0 || !optionOf(doc, oid)) throw fail(400, 'That option isn’t in this round.');
    if (own(doc.vetoed, oid)) throw fail(409, 'That one was vetoed.', { code: 'vetoed' });
  }

  /** Apply a patch ({set: {'a.b': v}, del: ['a.c']}) to a copy in memory -
   *  the page's half of a one-key write. */
  function applyPatch(doc, patch) {
    if (!patch) return doc;
    for (const k of Object.keys(patch.set || {})) {
      const parts = k.split('.');
      let at = doc;
      for (const p of parts.slice(0, -1)) { if (!at[p] || typeof at[p] !== 'object') at[p] = {}; at = at[p]; }
      at[parts[parts.length - 1]] = JSON.parse(JSON.stringify(patch.set[k]));
    }
    for (const k of patch.del || []) {
      const parts = k.split('.');
      let at = doc;
      let ok = true;
      for (const p of parts.slice(0, -1)) { if (!at[p] || typeof at[p] !== 'object') { ok = false; break; } at = at[p]; }
      if (ok) delete at[parts[parts.length - 1]];
    }
    return doc;
  }

  /** Join: a new voter, one key. Refused when the decision is full or
   *  closed. */
  function join(doc, { vid, name, keyHash }, now) {
    needOpen(doc, now);
    const n = voterIds(doc).length;
    if (n >= LIMITS.voters) throw fail(409, 'This decision is full - ' + LIMITS.voters + ' people is the most.');
    if (doc.max && n >= doc.max) throw fail(409, 'This decision is for ' + doc.max + ' people and they’ve all joined. Ask whoever sent it to start another.');
    const taken = new Set(voterIds(doc).map((v) => fold(doc.voters[v].name)));
    let nm = cleanName(name);
    if (!nm) nm = 'Friend ' + (n + 1);
    if (taken.has(fold(nm))) { let i = 2; while (taken.has(fold(nm + ' ' + i))) i++; nm = clean(nm + ' ' + i, LIMITS.name); }
    const row = { name: nm, host: false, at: new Date(now).toISOString() };
    if (keyHash) row.keyHash = keyHash;
    return { patch: { set: { ['voters.' + vid]: row }, del: [] }, msg: 'You’re in.', name: nm };
  }

  /** A swipe: Yes, No or Love on one option - or null to take it back. One
   *  key: `ballots.<voter>.<option>`. */
  function swipe(doc, vid, oid, v, now) {
    if (doc.mode !== 'swipe') throw fail(400, 'This one is ranked - pick your top 3.');
    needVoter(doc, vid);
    needOpen(doc, now);
    needLive(doc, oid);
    const key = 'ballots.' + vid + '.' + oid;
    if (v === null) return { patch: { set: {}, del: [key] }, msg: '' };
    const vote = cleanVote(v);
    if (!vote) throw fail(400, 'Yes, No or Love.');
    return { patch: { set: { [key]: vote }, del: [] }, msg: '' };
  }

  /** A top 3 (rank mode): 1-3 different options in play, in order. One key:
   *  `ranks.<voter>`. An empty list takes it back. */
  function rank(doc, vid, order, now) {
    if (doc.mode !== 'rank') throw fail(400, 'This one is a swipe - Yes, No or Love.');
    needVoter(doc, vid);
    needOpen(doc, now);
    const key = 'ranks.' + vid;
    if (!Array.isArray(order) || !order.length) return { patch: { set: {}, del: [key] }, msg: 'Taken back.' };
    if (order.length > LIMITS.rankTop) throw fail(400, 'Your top ' + LIMITS.rankTop + ', no more.');
    const seen = new Set();
    for (const oid of order) {
      needLive(doc, oid);
      if (seen.has(oid)) throw fail(400, 'Each option once.');
      seen.add(oid);
    }
    return { patch: { set: { [key]: order.slice() }, del: [] }, msg: 'Locked in.' };
  }

  /**
   * A veto: one per person, removes an option for everyone. First come:
   * an option someone already vetoed stays theirs and the second voter
   * keeps their veto (status 'already'). Moving your veto to another option
   * gives the first one back; null takes it back. The last option standing
   * cannot be vetoed.
   */
  function veto(doc, vid, oid, now) {
    if (!vetoesOn(doc)) throw fail(400, (doc.round || 1) > 1 ? 'No vetoes in a second round.' : 'Vetoes are off for this one.');
    needVoter(doc, vid);
    needOpen(doc, now);
    const mine = vetoOf(doc, vid);
    if (oid === null) {
      if (!mine) return { patch: { set: {}, del: [] }, msg: 'You haven’t used your veto.', status: 'none' };
      return { patch: { set: {}, del: ['vetoed.' + mine] }, msg: 'Veto taken back - ' + (optionOf(doc, mine) || {}).label + ' is back in.', status: 'back' };
    }
    if (!isOptionId(oid) || (doc.active || []).indexOf(oid) < 0 || !optionOf(doc, oid)) throw fail(400, 'That option isn’t in this round.');
    const o = optionOf(doc, oid);
    if (own(doc.vetoed, oid)) {
      if (doc.vetoed[oid] === vid) return { patch: { set: {}, del: [] }, msg: 'You vetoed that already.', status: 'mine' };
      return { patch: { set: {}, del: [] }, msg: 'Someone beat you to it - ' + o.label + ' is already out. Your veto is still yours.', status: 'already' };
    }
    const left = live(doc).filter((id) => id !== oid && id !== mine);
    if (!left.length || (live(doc).length <= 1)) throw fail(409, o.label + ' is the last one standing - it can’t be vetoed.');
    const del = mine ? ['vetoed.' + mine] : [];
    return { patch: { set: { ['vetoed.' + oid]: vid }, del }, msg: o.label + ' is out for everyone.' + (mine ? ' ' + (optionOf(doc, mine) || {}).label + ' is back in.' : ''), status: 'vetoed' };
  }

  /** The host closes voting now. */
  function close(doc, now) {
    const st = status(doc, now);
    if (!st.open) return { patch: { set: {}, del: [] }, msg: 'Already closed.' };
    if (!voterIds(doc).some((v) => hasVoted(doc, v))) throw fail(409, 'Nobody has voted yet.');
    return { patch: { set: { closed: { at: now, why: 'host' } }, del: [] }, msg: 'Voting closed.' };
  }
  function hasVoted(doc, vid) {
    const L = live(doc);
    if (doc.mode === 'rank') return Array.isArray((doc.ranks || {})[vid]) && doc.ranks[vid].some((id) => L.indexOf(id) >= 0);
    const b = (doc.ballots || {})[vid] || {};
    return L.some((id) => own(b, id));
  }

  /* ------------------------------------------------------------------ *
   * Results
   * ------------------------------------------------------------------ */

  /**
   * The tie-break wheel: the same on every phone, from the decision id, the
   * round and the tied options - never a dice roll. `ids` in the order the
   * wheel draws them (the decision's own order); the pick does not depend
   * on that order.
   */
  function spin(seedId, round, ids) {
    const order = ids.slice();
    const sorted = order.slice().sort();
    const pick = sorted.length ? sorted[hash32(String(seedId) + '|' + (round || 1) + '|' + sorted.join(',')) % sorted.length] : null;
    return { ids: order, pick };
  }
  function byOptionOrder(doc, ids) {
    const pos = {};
    (doc.opts || []).forEach((o, i) => { pos[o.id] = i; });
    return ids.slice().sort((a, b) => pos[a] - pos[b]);
  }

  /**
   * Swipe results. Each option: Yes, Love and No counts and a score (Yes 1,
   * Love 2). A MATCH is an option every voter said Yes or Love to (someone
   * who stopped halfway has not said yes). The winner is the best-loved
   * match; with no match, the highest score. A tie at the top goes to the
   * wheel. Places are shared: 1, 2, 2, 4.
   */
  function swipeResults(doc) {
    const L = live(doc);
    const voters = voterIds(doc).filter((v) => hasVoted(doc, v));
    const rows = L.map((id) => {
      const o = optionOf(doc, id);
      const r = { id, label: o.label, emoji: o.emoji, yes: 0, love: 0, no: 0, score: 0, match: voters.length > 0, by: { yes: [], love: [], no: [] } };
      for (const v of voters) {
        const x = ((doc.ballots || {})[v] || {})[id];
        if (x === 'yes' || x === 'love') { r[x]++; r.score += WEIGHT[x]; r.by[x].push(v); }
        else { if (x === 'no') { r.no++; r.by.no.push(v); } r.match = false; }
      }
      return r;
    });
    const pos = {};
    L.forEach((id, i) => { pos[id] = i; });
    rows.sort((a, b) => b.score - a.score || b.love - a.love || a.no - b.no || pos[a.id] - pos[b.id]);
    let place = 0;
    rows.forEach((r, i) => {
      if (i === 0 || r.score !== rows[i - 1].score) place = i + 1;
      r.place = place;
    });
    const matches = rows.filter((r) => r.match).map((r) => r.id);
    let how = 'none'; let pool = [];
    if (matches.length) {
      const best = Math.max.apply(null, rows.filter((r) => r.match).map((r) => r.score));
      pool = rows.filter((r) => r.match && r.score === best).map((r) => r.id);
      how = 'match';
    } else if (rows.length && rows[0].score > 0) {
      pool = rows.filter((r) => r.score === rows[0].score).map((r) => r.id);
      how = pool.length > 1 ? 'tie' : 'score';
    }
    return finish(doc, { mode: 'swipe', voters: voters.length, rows, matches, how, pool });
  }

  /**
   * Ranked choice (instant runoff). Each ballot counts for its highest
   * choice still in the race. A choice with more than half of the ballots
   * still counting wins; otherwise the one with the fewest is out and its
   * ballots move to their next choice (or run out - "exhausted"). A tie for
   * fewest goes out by fewer points over all ballots (3 for a first, 2 for a
   * second, 1 for a third), then by the wheel. Two left level at the end go
   * to the wheel. Every round is said in words.
   */
  function runoff(doc) {
    const L = live(doc);
    const inPlay = new Set(L);
    const voters = voterIds(doc).filter((v) => hasVoted(doc, v));
    const ballots = voters.map((v) => (doc.ranks[v] || []).filter((id, i, a) => inPlay.has(id) && a.indexOf(id) === i).slice(0, LIMITS.rankTop)).filter((b) => b.length);
    const points = {}; const firsts = {};
    for (const id of L) { points[id] = 0; firsts[id] = 0; }
    for (const b of ballots) b.forEach((id, i) => { points[id] += LIMITS.rankTop - i; if (i === 0) firsts[id]++; });
    const label = (id) => optionOf(doc, id).label;
    const whose = (id) => label(id) + (/s$/i.test(label(id)) ? '’' : '’s');
    const cont = new Set(L.filter((id) => points[id] > 0));
    const rounds = [];
    let winner = null; let how = 'none'; let pool = [];
    const top = (b) => b.find((id) => cont.has(id)) || null;
    let n = 0;
    while (cont.size && n < 40) {
      n++;
      const counts = {};
      for (const id of cont) counts[id] = 0;
      let exhausted = 0;
      for (const b of ballots) { const t = top(b); if (t) counts[t]++; else exhausted++; }
      const counting = ballots.length - exhausted;
      const order = byOptionOrder(doc, Array.from(cont)).sort((a, b) => counts[b] - counts[a]);
      const round = { n, counts: order.map((id) => ({ id, n: counts[id] })), counting, exhausted, out: null, moved: [], ranOut: 0, text: '' };
      rounds.push(round);
      const lead = order[0];
      const tally = order.filter((id) => counts[id] > 0).map((id) => label(id) + ' (' + counts[id] + ')').join(' · ');
      if (counts[lead] * 2 > counting) {
        winner = lead; how = 'majority';
        round.text = (n === 1 ? 'Round 1: ' + tally + '. ' : 'Round ' + n + ': ' + tally + '. ') + label(lead) + ' has more than half (' + counts[lead] + ' of ' + counting + ').';
        break;
      }
      if (cont.size === 1) { winner = lead; how = 'majority'; round.text = 'Round ' + n + ': ' + label(lead) + ' is the only one left.'; break; }
      const low = Math.min.apply(null, order.map((id) => counts[id]));
      const losers = order.filter((id) => counts[id] === low);
      // Everyone level. With three or more still in, 2nd and 3rd picks
      // (points) can still split them; two level at the end - or level on
      // points too - go to the wheel.
      if (losers.length === cont.size && (cont.size === 2 || losers.every((id) => points[id] === points[losers[0]]))) {
        pool = byOptionOrder(doc, losers); how = 'tie';
        round.text = 'Round ' + n + ': ' + tally + '. ' + nameList(pool.map(label)) + (pool.length === 2 ? ' are' : ' are all') + ' level - the wheel decides.';
        break;
      }
      let out = losers[0];
      let tie = '';
      if (losers.length > 1) {
        const fewest = Math.min.apply(null, losers.map((id) => points[id]));
        const byPts = byOptionOrder(doc, losers.filter((id) => points[id] === fewest));
        const names = nameList(byOptionOrder(doc, losers).map(label));
        if (byPts.length === 1) { out = byPts[0]; tie = names + ' tied for fewest and ' + label(out) + ' had fewer 2nd and 3rd picks'; }
        else {
          out = spin(doc.id || 'demo', (doc.round || 1) * 100 + n, byPts).pick;
          tie = byPts.length === losers.length
            ? names + ' tied for fewest, even counting 2nd and 3rd picks, and the draw picked ' + label(out)
            : names + ' tied for fewest; ' + nameList(byPts.map(label)) + ' had the fewest 2nd and 3rd picks, and the draw picked ' + label(out);
        }
      }
      round.out = out;
      cont.delete(out);
      const moved = {};
      let ranOut = 0;
      for (const b of ballots) {
        const before = b.find((id) => cont.has(id) || id === out);
        if (before !== out) continue;
        const next = top(b);
        if (next) moved[next] = (moved[next] || 0) + 1; else ranOut++;
      }
      round.moved = byOptionOrder(doc, Object.keys(moved)).map((id) => ({ id, n: moved[id] }));
      round.ranOut = ranOut;
      const k = counts[out];
      const opener = tie || (label(out) + (k ? ' had the fewest' : ' had no first picks'));
      let tail;
      if (!k) tail = ', so it’s out.';
      else if (round.moved.length === 1 && !ranOut) tail = ', so ' + whose(out) + ' ' + (k === 1 ? 'vote' : 'votes') + ' moved to ' + label(round.moved[0].id) + '.';
      else if (!round.moved.length) tail = ', so it’s out - ' + (k === 1 ? 'that ballot had' : 'those ballots had') + ' no other picks.';
      else tail = ', so ' + whose(out) + ' ' + plural(k, 'vote') + ' moved: ' + round.moved.map((m) => m.n + ' to ' + label(m.id)).concat(ranOut ? [ranOut + ' had no other picks'] : []).join(', ') + '.';
      round.text = 'Round ' + n + ': ' + (tally || 'no first picks') + '. ' + opener + tail;
    }
    const rows = byOptionOrder(doc, L).map((id) => {
      const o = optionOf(doc, id);
      return { id, label: o.label, emoji: o.emoji, firsts: firsts[id], points: points[id], place: 0 };
    });
    // Final standing: the winner, then by points, then first picks.
    rows.sort((a, b) => (b.id === winner) - (a.id === winner) || b.points - a.points || b.firsts - a.firsts);
    let place = 0;
    rows.forEach((r, i) => {
      if (i === 0 || r.id === winner || rows[i - 1].id === winner || r.points !== rows[i - 1].points || r.firsts !== rows[i - 1].firsts) place = i + 1;
      r.place = place;
    });
    if (winner) pool = [winner];
    return finish(doc, { mode: 'rank', voters: voters.length, ballots: ballots.length, rows, rounds, how, pool });
  }

  function finish(doc, r) {
    let winner = null; let wheel = null;
    if (r.pool.length === 1) winner = r.pool[0];
    else if (r.pool.length > 1) {
      wheel = spin(doc.id || 'demo', doc.round || 1, byOptionOrder(doc, r.pool));
      winner = wheel.pick;
    }
    const out = { mode: r.mode, voters: r.voters, how: r.how, winner, wheel, rows: r.rows };
    if (r.matches) out.matches = r.matches;
    if (r.rounds) { out.rounds = r.rounds; out.ballots = r.ballots; }
    out.vetoed = Object.keys(doc.vetoed || {}).filter((id) => (doc.active || []).indexOf(id) >= 0);
    return out;
  }

  function results(doc) { return doc.mode === 'rank' ? runoff(doc) : swipeResults(doc); }

  /** The headline for a result: "It's a match: 🍜 Ramen!" and friends. */
  function headline(doc, res) {
    if (!res.winner) return { eyebrow: 'No winner', title: 'Nobody picked anything', line: 'Not one Yes - try a different set of options.' };
    const o = optionOf(doc, res.winner);
    const name = (o.emoji ? o.emoji + ' ' : '') + o.label;
    if (res.mode === 'swipe') {
      const row = res.rows.find((r) => r.id === res.winner);
      if (res.how === 'match') {
        const others = res.matches.length - 1;
        return {
          eyebrow: 'It’s a match!', title: name, match: true,
          line: (res.voters === 1 ? 'The only vote said yes' : 'Everyone said yes') + (row.love ? ' · ' + (row.love === res.voters ? 'everyone loved it' : plural(row.love, 'person', 'people') + ' loved it') : '') + (others > 0 ? ' · ' + plural(others, 'other match', 'other matches') : '') + (res.wheel ? ' · the wheel broke a tie' : ''),
        };
      }
      return { eyebrow: res.how === 'tie' ? 'No match - the wheel decided' : 'No match - top score', title: name, line: plural(row.yes + row.love, 'yes', 'yeses') + (row.love ? ' (' + row.love + ' ♥)' : '') + ' of ' + plural(res.voters, 'voter') + '. Nobody liked everything the same - this is the closest.' };
    }
    if (res.how === 'majority') {
      const last = res.rounds[res.rounds.length - 1];
      const c = last.counts.find((x) => x.id === res.winner);
      return { eyebrow: res.rounds.length > 1 ? 'Settled after ' + plural(res.rounds.length, 'round') : 'Settled in one round', title: name, line: c ? (res.rounds.length > 1 ? 'Won ' + c.n + ' of ' + last.counting + ' ballots once the others dropped out.' : c.n + ' of ' + last.counting + ' put it first.') : 'The last one standing.' };
    }
    return { eyebrow: 'Dead level - the wheel decided', title: name, line: 'Ranked choice couldn’t split ' + nameList(res.wheel.ids.map((id) => optionOf(doc, id).label)) + '.' };
  }

  /** The line people paste in the chat. */
  function resultLine(doc, res) {
    const q = doc.question;
    if (!res.winner) return '“' + q + '” - no winner yet.';
    const o = optionOf(doc, res.winner);
    const name = (o.emoji ? o.emoji + ' ' : '') + o.label;
    if (res.mode === 'swipe' && res.how === 'match') return 'Settled: ' + name + ' for “' + q + '” - it’s a match, everyone said yes.';
    if (res.how === 'majority') return 'Settled: ' + name + ' for “' + q + '” - ranked choice, ' + plural(res.rounds.length, 'round') + '.';
    if (res.wheel) return 'Settled: ' + name + ' for “' + q + '” - the wheel broke a tie.';
    return 'Settled: ' + name + ' for “' + q + '” - top score.';
  }
  /** The share-sheet message, ready to send. */
  function inviteText(doc, link) {
    const q = doc.question.replace(/\s+$/, '');
    const ask = /[?!.]$/.test(q) ? q : q + '?';
    return ask + ' ' + (doc.mode === 'rank' ? 'Rank your top 3' : 'Swipe') + ' in 30 seconds: ' + link;
  }

  /**
   * Re-open with the top 3: a second round on the three best (two if only
   * two scored). The first round is kept as a line; vetoes are spent.
   */
  function reopenTop(doc, now) {
    if (status(doc, now).open) throw fail(409, 'Close voting first.');
    const res = results(doc);
    const ranked = res.rows.filter((r) => (res.mode === 'rank' ? r.points > 0 : r.score > 0)).map((r) => r.id);
    if (res.winner && ranked.indexOf(res.winner) > 0) { ranked.splice(ranked.indexOf(res.winner), 1); ranked.unshift(res.winner); }
    const top = byOptionOrder(doc, ranked.slice(0, 3));
    if (top.length < 2) throw fail(409, 'Fewer than two options got a vote - start a new one instead.');
    const past = (doc.past || []).slice(-4).concat([{ round: doc.round || 1, winner: res.winner, line: resultLine(doc, res), top }]);
    return {
      patch: { set: { active: top, round: (doc.round || 1) + 1, past, ballots: {}, ranks: {}, vetoed: {}, closed: null, deadline: null }, del: [] },
      msg: 'Round ' + ((doc.round || 1) + 1) + ': ' + nameList(top.map((id) => optionOf(doc, id).label)) + '.',
    };
  }

  /* ------------------------------------------------------------------ *
   * What one member sees
   * ------------------------------------------------------------------ */

  /** A result as one member sees it. Anonymous votes carry counts only;
   *  named ones say who - by name, never by voter id - once revealed. */
  function viewResult(doc, res, revealed) {
    const nm = (v) => (doc.voters[v] ? doc.voters[v].name : 'Someone');
    const out = JSON.parse(JSON.stringify(res));
    for (const r of out.rows) {
      if (!r.by) continue;
      if (doc.named && revealed) r.by = { yes: r.by.yes.map(nm), love: r.by.love.map(nm), no: r.by.no.map(nm) };
      else delete r.by;
    }
    if (doc.mode === 'rank' && doc.named && revealed) {
      const L = live(doc);
      out.picks = voterIds(doc).filter((v) => Array.isArray((doc.ranks || {})[v]) && doc.ranks[v].length).map((v) => ({ name: nm(v), order: doc.ranks[v].filter((id) => L.indexOf(id) >= 0) }));
    }
    return out;
  }

  /**
   * The decision as one member (`actor` = {vid, host}) sees it: never a key
   * hash, never another person's votes before the reveal - unless the host
   * turned on "show as we go", and then only the totals. Who has finished
   * is shown: that is taking part, not a vote.
   */
  function memberView(doc, actor, now) {
    const st = status(doc, now);
    const revealed = !st.open;
    const me = actor.vid;
    const vet = {};
    for (const oid of Object.keys(doc.vetoed || {})) {
      const by = doc.vetoed[oid];
      vet[oid] = by === me ? 'you' : (doc.named && doc.voters[by] ? doc.voters[by].name : 'someone');
    }
    const out = {
      id: doc.id,
      question: doc.question,
      mode: doc.mode,
      opts: doc.opts,
      active: doc.active,
      vetoes: vetoesOn(doc),
      named: Boolean(doc.named),
      live: Boolean(doc.live),
      deadline: doc.deadline || null,
      max: doc.max || null,
      round: doc.round || 1,
      past: doc.past || [],
      next: doc.next || null,
      v: doc.v || 0,
      status: st,
      people: voterIds(doc).map((v) => ({ name: doc.voters[v].name, emoji: doc.voters[v].emoji || '', host: Boolean(doc.voters[v].host), you: v === me, done: isDone(doc, v), started: hasVoted(doc, v) })),
      me: me || null,
      host: Boolean(actor.host),
      mine: {
        ballot: me && doc.ballots && doc.ballots[me] ? Object.assign({}, doc.ballots[me]) : {},
        rank: me && doc.ranks && Array.isArray(doc.ranks[me]) ? doc.ranks[me].slice() : [],
        veto: me ? vetoOf(doc, me) : null,
      },
      vetoed: vet,
      createdAt: doc.createdAt,
    };
    if (revealed || doc.live) out.result = viewResult(doc, results(doc), revealed);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * The demo: "Friday dinner?" with three made-up friends
   * ------------------------------------------------------------------ */

  const DEMO = {
    question: 'Friday dinner?',
    options: [['🍕', 'Pizza'], ['🍜', 'Ramen'], ['🌮', 'Tacos'], ['🍣', 'Sushi'], ['🍛', 'Indian'], ['🍔', 'Burgers'], ['🥗', 'Poke bowls'], ['🌶️', 'Thai']],
    // Made-up friends. Between them Ramen, Tacos and Thai are yes all round,
    // so what YOU swipe decides: a clean match, a tie for the wheel, or no
    // match at all.
    friends: [
      { name: 'Maya', emoji: '🦊', after: 4, votes: ['yes', 'love', 'yes', 'no', 'yes', 'no', 'yes', 'love'] },
      { name: 'Sam', emoji: '🐼', after: 2, votes: ['no', 'yes', 'love', 'yes', 'no', 'yes', 'no', 'yes'] },
      { name: 'Jordan', emoji: '🐙', after: 6, votes: ['yes', 'yes', 'yes', 'no', 'yes', 'no', 'no', 'love'] },
    ],
  };
  /** The demo as a decision document, with the friends' votes in. */
  function demoDecision(now) {
    const at = (i) => new Date(now + i).toISOString();
    const opts = DEMO.options.map((x, i) => ({ id: 'o' + i.toString(36), label: x[1], emoji: x[0], note: '' }));
    const doc = {
      id: 'demo-friday', question: DEMO.question, mode: 'swipe', opts, active: opts.map((o) => o.id),
      vetoes: true, named: true, live: false, deadline: null, max: 4, round: 1, past: [], closed: null, next: null,
      voters: { vyou00000: { name: 'You', host: true, at: at(0) } }, ballots: {}, ranks: {}, vetoed: {}, v: 1,
    };
    DEMO.friends.forEach((f, i) => {
      const vid = 'vdemo' + String(i).padStart(4, '0');
      doc.voters[vid] = { name: f.name, host: false, at: at(i + 1), emoji: f.emoji };
    });
    return doc;
  }
  /** Friend i's votes land (the page calls this as you swipe). */
  function demoLand(doc, i) {
    const vid = 'vdemo' + String(i).padStart(4, '0');
    const f = DEMO.friends[i];
    doc.ballots[vid] = {};
    doc.opts.forEach((o, k) => { doc.ballots[vid][o.id] = f.votes[k]; });
    return vid;
  }

  return {
    LIMITS, MODES, VOTES, WEIGHT, DECKS, DECK, DEMO, STRIP,
    clean, cleanText, cleanQuestion, cleanName, cleanEmoji, splitLead, fold, cleanOption, cleanOptions, parseLines,
    isOptionId, isVoterId, newVoterId, cleanMode, cleanVote, cleanMax, cleanDeadline, fail, plural, nameList, hash32,
    newDecision, optionOf, voterIds, live, vetoesOn, vetoOf, isDone, hasVoted, doneCount, status, closedText, applyPatch,
    join, swipe, rank, veto, close, spin, swipeResults, runoff, results, headline, resultLine, inviteText, reopenTop,
    viewResult, memberView,
    demoDecision, demoLand,
  };
});
