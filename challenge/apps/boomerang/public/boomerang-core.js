/* Boomerang - the rules, in one file. Lend it. Get it back.
 *
 * Run three times: by the page (window.BoomerangCore), by the server and by
 * the tests (require). UMD, no dependencies, no clock of its own: every
 * function that needs "today" is handed it as a 'YYYY-MM-DD' string in the
 * viewer's own day, so the same loan is overdue on every phone on the same
 * date and the tests can stand on any day they like.
 *
 * What is here:
 *   - cleaning: one door for every typed string (no markup, no control or
 *     bidi characters, bounded, cut on a whole character);
 *   - the emoji guess: a fixed keyword map, "Cordless drill" -> 🔧;
 *   - a loan: cleanLoan, its status (out, due soon, overdue, back) and the
 *     words for it;
 *   - the shelf and the stats with personality;
 *   - the handshake: a receipt link's state machine, and what each side sees;
 *   - the nudges: five tones, three ready-to-send messages each, both ways;
 *   - the sample shelf for the first run.
 *
 * Deliberately NOT here: dice, a clock of its own, or anything else that
 * would make two phones disagree.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoomerangCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = {
    item: 60,          // "Cordless drill (the good one)"
    name: 24,          // a first name or a nickname
    note: 140,         // "It's in the blue case with the bits"
    hint: 80,          // "Write it for me": make it about...
    loans: 200,        // one shelf, signed in or not
    pastDays: 3650,    // a loan can start up to ten years ago
    dueDays: 730,      // and be due back up to two years after it starts
    soonDays: 3,       // "due soon" is today and the next three days
    nudgeText: 480,    // one written nudge
    options: 3,        // "Write it for me" returns three
    openReceipts: 50,  // open receipt links per account or device
  };

  const DAY_MS = 86400000;

  /* ------------------------------------------------------------------ *
   * Cleaning
   * ------------------------------------------------------------------ */

  // Control characters and the bidi overrides and isolates: they never
  // belong in a name or an item ("‮llird" would draw backwards on the
  // friend's phone). The zero-width joiner stays: emoji need it.
  const STRIP = /[\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁠-⁩﻿]/g;

  /** One line of untrusted text: no markup, no control or bidi characters,
   *  single spaces, at most `max` characters. Cut before any pattern runs,
   *  so hostile input costs linear time. */
  function clean(v, max) {
    let s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 200) s = s.slice(0, max * 4 + 200);
    s = s.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
    return s;
  }
  /** The same, but it has to say something: a letter, a digit or an emoji. */
  function cleanText(v, max) {
    const s = clean(v, max);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  const cleanItem = (v) => cleanText(v, LIMITS.item);
  const cleanName = (v) => cleanText(v, LIMITS.name);
  const cleanNote = (v) => cleanText(v, LIMITS.note);
  const cleanHint = (v) => cleanText(v, LIMITS.hint);

  const EMOJI_RE = /^(?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2})/u;
  /** One emoji, or ''. */
  function cleanEmoji(v) {
    if (typeof v !== 'string') return '';
    const m = EMOJI_RE.exec(v.replace(STRIP, '').trim().slice(0, 24));
    return m ? m[0] : '';
  }
  function fold(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  /* ------------------------------------------------------------------ *
   * The emoji guess. A fixed map, so it is the same guess every time:
   * the words of the item are read from the LAST one back (the head noun
   * in English - a "camping chair" is a chair), and at each word a
   * two-word rule ending there wins over a one-word rule.
   * ------------------------------------------------------------------ */

  const EMOJI_RULES = [
    // two words first
    ['board game', '🎲'], ['video game', '🎮'], ['sleeping bag', '🛌'], ['car seat', '💺'], ['high chair', '🪑'],
    ['plant pot', '🪴'], ['cake tin', '🎂'], ['baking tray', '🍪'], ['slow cooker', '🍲'], ['frying pan', '🍳'],
    ['tape measure', '📏'], ['extension lead', '🔌'], ['jump leads', '🔌'], ['hard drive', '💾'], ['sewing machine', '🧵'],
    ['golf clubs', '⛳'], ['fishing rod', '🎣'], ['tennis racket', '🎾'], ['air bed', '🛏️'], ['roof box', '🚗'],
    ['cool box', '🧊'], ['rain jacket', '🧥'], ['party lights', '✨'], ['fairy lights', '✨'], ['pressure washer', '🚿'],
    // tools
    ['drill', '🔧'], ['wrench', '🔧'], ['spanner', '🔧'], ['ladder', '🪜'], ['stepladder', '🪜'], ['hammer', '🔨'],
    ['saw', '🪚'], ['screwdriver', '🪛'], ['toolbox', '🧰'], ['tools', '🧰'], ['toolkit', '🧰'], ['axe', '🪓'],
    ['sander', '🔧'], ['jigsaw', '🧩'], ['level', '📏'], ['mower', '🌱'], ['lawnmower', '🌱'], ['strimmer', '🌱'],
    ['trimmer', '🌱'], ['hose', '🚿'], ['wheelbarrow', '🧰'], ['glue', '🧴'], ['paint', '🎨'], ['brush', '🖌️'],
    // books and games
    ['book', '📚'], ['books', '📚'], ['novel', '📖'], ['cookbook', '📕'], ['comic', '📚'], ['magazine', '📰'],
    ['dvd', '📀'], ['bluray', '📀'], ['cd', '💿'], ['vinyl', '💿'], ['record', '💿'], ['game', '🎮'], ['console', '🎮'],
    ['switch', '🎮'], ['playstation', '🎮'], ['ps5', '🎮'], ['xbox', '🎮'], ['controller', '🎮'], ['catan', '🎲'],
    ['monopoly', '🎲'], ['scrabble', '🎲'], ['puzzle', '🧩'], ['cards', '🃏'], ['chess', '♟️'], ['lego', '🧱'],
    ['toy', '🧸'], ['teddy', '🧸'],
    // kitchen
    ['dish', '🥘'], ['casserole', '🥘'], ['pan', '🍳'], ['pot', '🍲'], ['tupperware', '🥡'], ['container', '🥡'],
    ['bowl', '🥣'], ['plate', '🍽️'], ['plates', '🍽️'], ['cutlery', '🍴'], ['knife', '🔪'], ['knives', '🔪'], ['wok', '🥘'],
    ['kettle', '🫖'], ['teapot', '🫖'], ['mug', '☕'], ['thermos', '☕'], ['flask', '☕'], ['cooler', '🧊'],
    ['bbq', '🔥'], ['barbecue', '🔥'], ['grill', '🔥'], ['blender', '🥤'], ['mixer', '🥣'], ['wine', '🍷'],
    ['glasses', '🥂'], ['tray', '🍪'], ['tin', '🥫'], ['cooker', '🍲'],
    // clothes and bags
    ['jacket', '🧥'], ['coat', '🧥'], ['hoodie', '🧥'], ['jumper', '🧶'], ['sweater', '🧶'], ['cardigan', '🧶'],
    ['scarf', '🧣'], ['hat', '👒'], ['cap', '🧢'], ['dress', '👗'], ['shirt', '👕'], ['tshirt', '👕'], ['top', '👕'],
    ['jeans', '👖'], ['trousers', '👖'], ['shoes', '👟'], ['trainers', '👟'], ['sneakers', '👟'], ['boots', '🥾'],
    ['heels', '👠'], ['suit', '🤵'], ['tie', '👔'], ['gloves', '🧤'], ['bag', '👜'], ['handbag', '👜'],
    ['backpack', '🎒'], ['rucksack', '🎒'], ['suitcase', '🧳'], ['luggage', '🧳'], ['umbrella', '☂️'],
    ['sunglasses', '🕶️'], ['necklace', '📿'], ['ring', '💍'], ['earrings', '💍'], ['watch', '⌚'], ['costume', '🎭'],
    // outdoors and sport
    ['tent', '⛺'], ['gazebo', '⛺'], ['bike', '🚲'], ['bicycle', '🚲'], ['helmet', '⛑️'], ['ball', '⚽'],
    ['football', '⚽'], ['basketball', '🏀'], ['racket', '🎾'], ['racquet', '🎾'], ['golf', '⛳'], ['skis', '🎿'],
    ['snowboard', '🏂'], ['skateboard', '🛹'], ['surfboard', '🏄'], ['wetsuit', '🏄'], ['kayak', '🛶'], ['paddle', '🛶'],
    ['canoe', '🛶'], ['rod', '🎣'], ['binoculars', '🔭'], ['telescope', '🔭'], ['hammock', '🏕️'], ['stove', '🔥'],
    ['scooter', '🛴'], ['skates', '⛸️'], ['weights', '🏋️'], ['dumbbells', '🏋️'], ['mat', '🧘'],
    // tech
    ['laptop', '💻'], ['computer', '💻'], ['ipad', '📱'], ['tablet', '📱'], ['phone', '📱'], ['kindle', '📱'],
    ['camera', '📷'], ['lens', '📷'], ['tripod', '📷'], ['projector', '📽️'], ['speaker', '🔊'], ['headphones', '🎧'],
    ['earbuds', '🎧'], ['airpods', '🎧'], ['cable', '🔌'], ['charger', '🔌'], ['hdmi', '🔌'], ['adapter', '🔌'],
    ['lead', '🔌'], ['usb', '💾'], ['keyboard', '⌨️'], ['mouse', '🖱️'], ['printer', '🖨️'], ['drone', '🚁'],
    ['battery', '🔋'], ['torch', '🔦'], ['flashlight', '🔦'],
    // music
    ['guitar', '🎸'], ['ukulele', '🎸'], ['bass', '🎸'], ['violin', '🎻'], ['drum', '🥁'], ['drums', '🥁'],
    ['microphone', '🎤'], ['mic', '🎤'], ['piano', '🎹'], ['amp', '🔊'],
    // home, car, baby
    ['car', '🚗'], ['keys', '🔑'], ['key', '🔑'], ['van', '🚐'], ['trailer', '🚚'], ['vacuum', '🧹'], ['hoover', '🧹'],
    ['iron', '🧺'], ['steamer', '🧺'], ['fan', '🌀'], ['heater', '🔥'], ['pram', '👶'], ['stroller', '👶'],
    ['buggy', '👶'], ['pushchair', '👶'], ['cot', '🛏️'], ['crib', '🛏️'], ['chair', '🪑'], ['chairs', '🪑'],
    ['table', '🪑'], ['mattress', '🛏️'], ['airbed', '🛏️'], ['sofa', '🛋️'], ['lamp', '💡'], ['mirror', '🪞'],
    ['plant', '🪴'], ['vase', '🏺'], ['frame', '🖼️'], ['painting', '🖼️'], ['scissors', '✂️'], ['pen', '🖊️'],
    ['calculator', '🧮'], ['money', '💵'], ['cash', '💵'], ['tenner', '💵'], ['fiver', '💵'], ['crate', '🐾'],
    ['carrier', '🐾'], ['lead', '🐾'], ['blanket', '🧣'], ['towel', '🧺'], ['decorations', '🎉'], ['balloons', '🎈'],
    ['lights', '✨'],
  ];
  const RULE_MAP = (function () {
    const m = new Map();
    for (const [k, e] of EMOJI_RULES) if (!m.has(k)) m.set(k, e);
    return m;
  }());
  function singular(w) {
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 3 && w.endsWith('es') && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }
  /** The emoji the keyword map would give this item, or null. */
  function guessEmoji(item) {
    const words = fold(item).split(' ').filter(Boolean).slice(0, 12);
    for (let i = words.length - 1; i >= 0; i--) {
      if (i > 0) {
        const two = words[i - 1] + ' ' + words[i];
        if (RULE_MAP.has(two)) return RULE_MAP.get(two);
        const two1 = words[i - 1] + ' ' + singular(words[i]);
        if (RULE_MAP.has(two1)) return RULE_MAP.get(two1);
      }
      if (RULE_MAP.has(words[i])) return RULE_MAP.get(words[i]);
      const one = singular(words[i]);
      if (RULE_MAP.has(one)) return RULE_MAP.get(one);
    }
    return null;
  }
  const DEFAULT_EMOJI = '📦';
  const suggestEmoji = (item) => guessEmoji(item) || DEFAULT_EMOJI;
  /** The picker, in the order it is shown. */
  const PICKER = ['🔧', '🪜', '📚', '🎲', '🎮', '🥘', '🍳', '🧥', '👗', '🎒', '🧳', '⛺', '🚲', '💻', '📷', '🎸', '🔌', '🧰', '🪴', '☂️', '🔑', '🧸', '💵', '📦'];

  /* ------------------------------------------------------------------ *
   * Days. Every date is 'YYYY-MM-DD' in the viewer's own day.
   * ------------------------------------------------------------------ */

  const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  function isDay(v) {
    if (typeof v !== 'string') return false;
    const m = DAY_RE.exec(v);
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }
  function dayMs(day) { const m = DAY_RE.exec(day); return Date.UTC(+m[1], +m[2] - 1, +m[3]); }
  /** Whole days from a to b (b later is positive). */
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / DAY_MS); }
  function addDays(day, n) { return new Date(dayMs(day) + n * DAY_MS).toISOString().slice(0, 10); }
  /** A Date's day in its own local zone (the page's "today"). */
  function localDay(date) {
    const d = date || new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** "Oct 18", or "Oct 18, 2025" when it is not this year. English, fixed,
   *  so the friend's page and the sender's message say the same thing. */
  function fmtDay(day, today) {
    if (!isDay(day)) return '';
    const m = DAY_RE.exec(day);
    const s = `${MONTHS[+m[2] - 1]} ${+m[3]}`;
    return today && isDay(today) && today.slice(0, 4) === day.slice(0, 4) ? s : `${s}, ${m[1]}`;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* ------------------------------------------------------------------ *
   * A loan
   * ------------------------------------------------------------------ */

  const DIRS = ['lent', 'borrowed'];
  const ID_RE = /^[a-z0-9]{8,20}$/;
  const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
  const STATES = ['sent', 'confirmed', 'returning', 'closed'];

  function fail(status, message, extra) {
    const e = new Error(message);
    e.status = status; e.expose = true;
    if (extra) Object.assign(e, extra);
    return e;
  }

  /** A short random id from a number source (the page passes
   *  crypto.getRandomValues, the server crypto.randomInt). */
  function newLoanId(rand) {
    const A = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 12; i++) s += A[rand(36)];
    return s;
  }

  /**
   * One loan, typed, synced or from the sample - through one door. Returns
   * null when there is no item or no person. `today` bounds the dates: a
   * loan cannot start in the future (it starts today), cannot be due before
   * it started, and cannot come back before it left.
   */
  function cleanLoan(raw, today) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!isDay(today)) throw new Error('cleanLoan needs today');
    const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
    const item = cleanItem(raw.item);
    const who = cleanName(raw.who);
    if (!id || !item || !who) return null;
    const dir = DIRS.includes(raw.dir) ? raw.dir : 'lent';
    let on = isDay(raw.on) ? raw.on : today;
    if (daysBetween(on, today) < 0) on = today;
    if (daysBetween(on, today) > LIMITS.pastDays) on = addDays(today, -LIMITS.pastDays);
    let due = isDay(raw.due) ? raw.due : null;
    if (due && (daysBetween(on, due) < 0 || daysBetween(on, due) > LIMITS.dueDays)) due = null;
    let back = isDay(raw.back) ? raw.back : null;
    if (back && daysBetween(on, back) < 0) back = on;
    if (back && daysBetween(back, today) < 0) back = today;
    const emoji = cleanEmoji(raw.emoji) || suggestEmoji(item);
    const note = cleanNote(raw.note);
    let share = null;
    // A receipt this phone made carries its owner key; one a friend sent and
    // this phone saved carries the token only (it acts as the friend).
    if (raw.share && typeof raw.share === 'object' && TOKEN_RE.test(raw.share.token || '')) {
      share = { token: raw.share.token, key: TOKEN_RE.test(raw.share.key || '') ? raw.share.key : null, state: STATES.includes(raw.share.state) ? raw.share.state : 'sent' };
    }
    const out = { id, dir, item, emoji, who, on, due, back, note, share };
    const at = Number(raw.updatedAt);
    out.updatedAt = Number.isFinite(at) && at > 0 ? Math.floor(at) : 0;
    if (raw.photo === true) out.photo = true;
    if (raw.sample === true) out.sample = true;
    return out;
  }
  /** What an account keeps of a loan: never a photo flag (photos stay on
   *  the phone that took them), never the sample marker. */
  function toSaved(l) {
    return { id: l.id, dir: l.dir, item: l.item, emoji: l.emoji, who: l.who, on: l.on, due: l.due, back: l.back, note: l.note, share: l.share, updatedAt: l.updatedAt };
  }
  const SAVED_FIELDS = ['id', 'dir', 'item', 'emoji', 'who', 'on', 'due', 'back', 'note', 'share', 'updatedAt'];

  /** out | soon | overdue | back. Due today is "soon", not overdue. */
  function status(l, today) {
    if (l.back) return 'back';
    if (l.due) {
      const left = daysBetween(today, l.due);
      if (left < 0) return 'overdue';
      if (left <= LIMITS.soonDays) return 'soon';
    }
    return 'out';
  }
  /** Days a loan has been (or was) away. */
  function daysAway(l, today) { return Math.max(0, daysBetween(l.on, l.back || today)); }
  /** The chip on a card: "3 days late", "Due tomorrow", "Back by Nov 1". */
  function dueText(l, today) {
    const st = status(l, today);
    if (st === 'back') return `Back ${fmtDay(l.back, today)}`;
    if (!l.due) return 'No date set';
    const left = daysBetween(today, l.due);
    if (st === 'overdue') return `${plural(-left, 'day')} late`;
    if (left === 0) return 'Due today';
    if (left === 1) return 'Due tomorrow';
    if (st === 'soon') return `Due in ${left} days`;
    return `Back by ${fmtDay(l.due, today)}`;
  }
  /** "with Sam · 94 days" / "from Mum · 12 days". */
  function whoLine(l, today) {
    const n = daysAway(l, today);
    const away = l.back ? `back after ${plural(n, 'day')}` : (n === 0 ? 'since today' : plural(n, 'day'));
    return `${l.dir === 'lent' ? 'with' : 'from'} ${l.who} · ${away}`;
  }

  // Keywords that are names, not common nouns: "my Catan", not "my catan".
  const PROPER = new Set(['catan', 'monopoly', 'scrabble', 'lego', 'playstation', 'xbox', 'switch', 'kindle', 'ipad', 'airpods', 'hoover', 'tupperware', 'thermos']);
  /** "cordless drill" from "Cordless drill", "Catan" from "Catan": a
   *  leading article goes, and a common noun is lower-cased so it reads in
   *  a sentence ("my cordless drill"); a name stays as typed. */
  function itemPhrase(item) {
    let s = String(item || '').replace(/^(a|an|the|my|your|our|his|her|their)\s+/i, '');
    if (!s) s = String(item || '');
    const words = s.split(' ');
    const first = words[0];
    const rest = words.slice(1);
    const lowerRest = rest.length > 0 && rest.every((w) => w === w.toLowerCase());
    const known = rest.length === 0 && guessEmoji(first) !== null && !PROPER.has(first.toLowerCase());
    if (/^\p{Lu}\p{Ll}+$/u.test(first) && (lowerRest || known)) s = first.charAt(0).toLowerCase() + s.slice(1);
    return s;
  }

  /* ------------------------------------------------------------------ *
   * The shelf and the stats
   * ------------------------------------------------------------------ */

  /** {overdue, soon, out, back}, each sorted the way it is read: the most
   *  late first, the soonest due first, the longest away first, the most
   *  recently home first. `dir` filters ('lent' | 'borrowed' | null). */
  function shelf(loans, today, dir) {
    const g = { overdue: [], soon: [], out: [], back: [] };
    for (const l of loans) if (!dir || l.dir === dir) g[status(l, today)].push(l);
    g.overdue.sort((a, b) => daysBetween(b.due, a.due) || a.item.localeCompare(b.item));
    g.soon.sort((a, b) => daysBetween(b.due, a.due) || a.item.localeCompare(b.item));
    g.out.sort((a, b) => daysBetween(b.on, a.on) || a.item.localeCompare(b.item));
    g.back.sort((a, b) => daysBetween(a.back, b.back) || a.item.localeCompare(b.item));
    return g;
  }

  function hash32(s) {
    let h = 0x811c9dc5;
    const str = String(s);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /** "Your ladder has been on holiday for 94 days" - one of a few, the same
   *  one for the same loan every time. */
  function holidayLine(l, today) {
    const n = daysAway(l, today);
    const it = itemPhrase(l.item);
    if (n === 0) return `Your ${it} went off with ${l.who} today. Have fun, ${it}.`;
    const lines = [
      `Your ${it} has been on holiday for ${plural(n, 'day')}`,
      `Your ${it} has been living at ${l.who}’s for ${plural(n, 'day')}`,
      `Your ${it} left home ${plural(n, 'day')} ago`,
      `${plural(n, 'day')} since your ${it} last saw your shelf`,
    ];
    return cap(lines[hash32(l.id) % lines.length]);
  }

  /**
   * The numbers at the top of the shelf:
   *   lentOut, borrowedOut, overdue  - counts right now;
   *   oldest      - the lent thing away longest, with its line;
   *   returns     - {back, of, pct}: of everything you lent, how much came
   *                 back (null with nothing lent);
   *   reliable    - the borrower with the most things back ON TIME (by
   *                 its date, or with no date set), fewer late as the
   *                 tie-break, then the name; null until one has come back;
   *   bestLender  - who you have borrowed the most from; null if nobody.
   */
  function stats(loans, today) {
    const lent = loans.filter((l) => l.dir === 'lent');
    const borrowed = loans.filter((l) => l.dir === 'borrowed');
    const out = lent.filter((l) => !l.back);
    const s = {
      lentOut: out.length,
      borrowedOut: borrowed.filter((l) => !l.back).length,
      overdue: loans.filter((l) => status(l, today) === 'overdue').length,
      oldest: null, returns: null, reliable: null, bestLender: null,
    };
    if (out.length) {
      const o = out.slice().sort((a, b) => daysBetween(b.on, a.on) || a.item.localeCompare(b.item))[0];
      s.oldest = { id: o.id, item: o.item, emoji: o.emoji, who: o.who, days: daysAway(o, today), line: holidayLine(o, today) };
    }
    if (lent.length) {
      const back = lent.filter((l) => l.back).length;
      s.returns = { back, of: lent.length, pct: Math.round((100 * back) / lent.length) };
    }
    const people = new Map();
    for (const l of lent) {
      const k = fold(l.who);
      if (!people.has(k)) people.set(k, { who: l.who, onTime: 0, late: 0, back: 0 });
      const p = people.get(k);
      if (l.back) { p.back++; if (!l.due || daysBetween(l.back, l.due) >= 0) p.onTime++; else p.late++; }
      else if (status(l, today) === 'overdue') p.late++;
    }
    const best = [...people.values()].filter((p) => p.onTime > 0)
      .sort((a, b) => b.onTime - a.onTime || a.late - b.late || b.back - a.back || a.who.localeCompare(b.who))[0];
    if (best) s.reliable = { who: best.who, onTime: best.onTime, line: `${plural(best.onTime, 'thing')} back on time` };
    const lenders = new Map();
    for (const l of borrowed) {
      const k = fold(l.who);
      if (!lenders.has(k)) lenders.set(k, { who: l.who, n: 0 });
      lenders.get(k).n++;
    }
    const top = [...lenders.values()].sort((a, b) => b.n - a.n || a.who.localeCompare(b.who))[0];
    if (top) s.bestLender = { who: top.who, n: top.n, line: `lent you ${plural(top.n, 'thing')}` };
    return s;
  }

  /* ------------------------------------------------------------------ *
   * The handshake: one receipt link, two people, four states.
   *
   *   sent ──confirm──▶ confirmed ──gave──▶ returning ──back──▶ closed
   *     └────────────────back────────────────┘ (the lender, any time)
   *
   *   confirm  the friend who opened the link ("Got it" / "That's right")
   *   gave     the borrower, once it is confirmed ("I've given it back")
   *   back     the lender, any time before it is closed ("It's back")
   *
   * The owner is whoever made the link (it holds a key); the friend is
   * whoever holds the link. Which of them is the lender follows the loan's
   * direction as the owner saw it. Revoking is the owner deleting the link,
   * after which it is the same 404 as a link that never existed.
   * ------------------------------------------------------------------ */

  const HANDSHAKE = {
    liveDays: 365,        // a link lasts a year at most
    afterCloseDays: 30,   // and 30 days once it is closed
  };

  /** 'lender' | 'borrower' for an actor ('owner' | 'friend'). */
  function sideOf(h, actor) {
    const ownerLends = h.dir === 'lent';
    if (actor === 'owner') return ownerLends ? 'lender' : 'borrower';
    return ownerLends ? 'borrower' : 'lender';
  }

  /** A new receipt from a loan and the sender's first name. */
  function newHandshake(input, { now, today }) {
    const b = input || {};
    const item = cleanItem(b.item);
    const who = cleanName(b.who);
    const me = cleanName(b.me);
    if (!item) throw fail(400, 'Say what it is - “cordless drill”.');
    if (!who) throw fail(400, 'Say who has it - a first name is plenty.');
    if (!me) throw fail(400, 'Add your first name, so they know who it’s from.');
    const dir = DIRS.includes(b.dir) ? b.dir : 'lent';
    const l = cleanLoan({ id: 'handshake0', item, who, dir, on: b.on, due: b.due, note: b.note, emoji: b.emoji }, today);
    const at = new Date(now).toISOString();
    return {
      item: l.item, emoji: l.emoji, dir,
      lender: dir === 'lent' ? me : who,
      borrower: dir === 'lent' ? who : me,
      on: l.on, due: l.due, note: l.note,
      state: 'sent',
      steps: { sent: at, confirmed: null, returning: null, closed: null },
      createdAt: at,
      expiresAt: new Date(now + HANDSHAKE.liveDays * DAY_MS).toISOString(),
    };
  }

  /** Which steps this actor may take now. */
  function allowed(h, actor) {
    const side = sideOf(h, actor);
    const out = [];
    if (h.state === 'sent' && actor === 'friend') out.push('confirm');
    if (h.state === 'confirmed' && side === 'borrower') out.push('gave');
    if (h.state !== 'closed' && side === 'lender') out.push('back');
    return out;
  }

  /** Take one step. Returns the fields that change; throws 409 for a step
   *  that is not possible now and 403 for one that is not this side's. */
  function step(h, actor, what, now) {
    if (!['owner', 'friend'].includes(actor)) throw fail(403, 'That isn’t yours to change.');
    if (!['confirm', 'gave', 'back'].includes(what)) throw fail(400, 'That isn’t a step.');
    if (h.state === 'closed') throw fail(409, 'This one is already back home - nothing more to do.');
    if (!allowed(h, actor).includes(what)) {
      const side = sideOf(h, actor);
      if (what === 'back' && side !== 'lender') throw fail(403, `Only ${h.lender} can say it’s back - it’s theirs.`);
      if (what === 'gave' && side !== 'borrower') throw fail(403, `Only ${h.borrower} can say they’ve given it back.`);
      if (what === 'confirm' && actor !== 'friend') throw fail(403, 'The other person confirms this one.');
      if (what === 'gave') throw fail(409, h.state === 'sent' ? 'Tap “Got it” first, so you both agree it’s with you.' : 'You’ve already said it’s on its way back.');
      throw fail(409, 'That’s already done.');
    }
    const at = new Date(now).toISOString();
    if (what === 'confirm') return { state: 'confirmed', steps: { ...h.steps, confirmed: at } };
    if (what === 'gave') return { state: 'returning', steps: { ...h.steps, returning: at } };
    const until = Math.min(Date.parse(h.createdAt) + HANDSHAKE.liveDays * DAY_MS, now + HANDSHAKE.afterCloseDays * DAY_MS);
    return { state: 'closed', steps: { ...h.steps, closed: at }, expiresAt: new Date(until).toISOString() };
  }

  function expired(h, now) { return !h || !h.expiresAt || Date.parse(h.expiresAt) <= now; }

  /** Exactly what either side is shown: the item, the two first names as
   *  typed, the dates, the state and when each step happened - and which
   *  side "you" are. Never a hash, an id, a key or a token. */
  function handshakeView(h, actor) {
    const steps = {};
    for (const k of STATES) steps[k] = h.steps && typeof h.steps[k] === 'string' ? h.steps[k] : null;
    return {
      item: h.item, emoji: h.emoji, lender: h.lender, borrower: h.borrower,
      on: h.on, due: h.due || null, note: h.note || '',
      state: STATES.includes(h.state) ? h.state : 'sent', steps,
      role: actor, you: sideOf(h, actor), can: allowed(h, actor),
      expiresAt: h.expiresAt,
    };
  }

  /** The friend's headline, as plain text (the page draws it with markup):
   *  "Sam lent you a cordless drill on Oct 18 - back by Nov 1". */
  function handshakeLine(v, today) {
    const it = itemPhrase(v.item);
    const by = v.due ? ` - back by ${fmtDay(v.due, today)}` : '';
    if (v.role === 'friend' && v.you === 'borrower') return `${v.lender} lent you ${v.emoji} ${it} on ${fmtDay(v.on, today)}${by}`;
    if (v.role === 'friend') return `${v.borrower} borrowed your ${v.emoji} ${it} on ${fmtDay(v.on, today)}${by}`;
    if (v.you === 'lender') return `You lent ${v.borrower} ${v.emoji} ${it} on ${fmtDay(v.on, today)}${by}`;
    return `You borrowed ${v.emoji} ${it} from ${v.lender} on ${fmtDay(v.on, today)}${by}`;
  }
  /** One line per state, for the owner's card ("Sam confirmed ✓"). */
  function stateLine(v) {
    const other = v.role === 'owner' ? (v.you === 'lender' ? v.borrower : v.lender) : 'You';
    if (v.state === 'sent') return v.role === 'owner' ? `Receipt sent · waiting for ${other}` : 'Waiting for you';
    if (v.state === 'confirmed') return v.role === 'owner' ? `${other} confirmed it` : 'Confirmed';
    if (v.state === 'returning') return v.you === 'borrower' ? 'You said you’ve given it back' : `${v.borrower} says it’s on its way back`;
    return 'Back home';
  }

  /* ------------------------------------------------------------------ *
   * Nudges: five tones, three messages each, for both directions. Ready
   * to paste; Boomerang never sends anything itself.
   * ------------------------------------------------------------------ */

  const TONES = [
    { id: 'polite', label: 'Polite', emoji: '🙂' },
    { id: 'friendly', label: 'Friendly', emoji: '😊' },
    { id: 'cheeky', label: 'Cheeky', emoji: '😏' },
    { id: 'dramatic', label: 'Dramatic', emoji: '🎭' },
    { id: 'legal', label: 'Legal-ish', emoji: '⚖️' },
  ];
  const TONE_IDS = TONES.map((t) => t.id);

  // {who} {item} {days} {away} {on} {by} {byWhen} {WHO}
  const TEMPLATES = {
    lent: {
      polite: [
        'Hi {who}, hope you’re well! When you get a moment, could I have my {item} back? No rush if you’re mid-project.',
        'Hi {who} - just checking in on my {item}. Could you drop it back {byWhen}? Thank you!',
        'Hi {who}, would it be OK to get my {item} back {byWhen}? Happy to pick it up if that’s easier.',
      ],
      friendly: [
        'Hey {who}! 👋 Any chance I could grab my {item} back {byWhen}? Hope it came in handy!',
        '{who}! My {item} misses me 😄 Drop it round next time you’re passing?',
        'Hiya {who} - no stress, but I’ll need my {item} back soon. Fancy a coffee when you bring it over? ☕',
      ],
      cheeky: [
        '{who}, my {item} called. It says it’s having a lovely time at yours but would like to come home now 🙃',
        'Not saying I’ve been counting, {who}, but my {item} has been at yours for {away} 👀',
        'Quick one {who}: is my {item} still with you, or has it moved in permanently? Asking for a shelf 😏',
      ],
      dramatic: [
        'Day {days}. The {item} has not returned. The shelf is empty. The evenings are long. {who}, I beg you. 🥀',
        'They say if you love something, let it go. I let my {item} go {away} ago, {who}. It is time. 🎭',
        'Every night I look at the space where my {item} used to be. {who}… bring it home. 🕯️',
      ],
      legal: [
        'NOTICE TO {WHO}: Re: one (1) {item}, on loan since {on}. The Lender respectfully requests its return {byWhen}, failing which the Lender will be mildly put out. ⚖️ (This is a joke. Mostly.)',
        'Dear {who}, it has come to the Lender’s attention that one (1) {item} remains in your custody after {away}. Kindly return it {byWhen}. No lawyers were harmed in writing this. ⚖️',
        'FINAL-ISH DEMAND: {who} is hereby invited to return the {item} {byWhen}. Accepted forms of apology: biscuits. ⚖️',
      ],
    },
    borrowed: {
      polite: [
        'Hi {who}, I haven’t forgotten your {item}! Could I bring it back {byWhen}? Thank you so much for lending it.',
        'Hi {who} - just letting you know I still have your {item} and it’s safe. When suits you to have it back?',
        'Hi {who}, thanks again for the {item}. I’d like to return it {byWhen} - does that work?',
      ],
      friendly: [
        'Hey {who}! 👋 Your {item} is ready to come home - when are you around?',
        '{who}! Still got your {item} - it’s been a hero. Can I drop it round {byWhen}? 😊',
        'Hiya {who} - your {item} and I have had a great time. Coffee and a hand-back soon? ☕',
      ],
      cheeky: [
        '{who}, your {item} has asked me to tell you it’s fine, it’s eating well, and it’ll be home {byWhen} 😏',
        'Confession, {who}: your {item} has been at mine for {away}. It may be getting comfortable 🙃',
        'Hi {who}, this is your {item}. I’m writing from {days} days away. Please arrange collection 📦',
      ],
      dramatic: [
        '{who}, I must confess. Your {item} is still here. It has been {away}. I can’t keep this secret any longer. 🎭',
        'Forgive me, {who}, for I have kept your {item} for {away}. It returns to you {byWhen}. 🥀',
        'The guilt grows heavier each day, {who}. Your {item} deserves to go home. Let us make it so. 🕯️',
      ],
      legal: [
        'NOTICE FROM THE BORROWER: one (1) {item}, belonging to {who}, will be returned {byWhen} in the condition received, give or take. ⚖️',
        'Dear {who}, the Borrower acknowledges custody of your {item} since {on} and proposes its return {byWhen}. Terms: a cup of tea. ⚖️',
        'STATEMENT OF INTENT: the Borrower solemnly swears to return the {item} to {who} {byWhen}. Witnessed by: nobody. ⚖️',
      ],
    },
  };

  /** "by Nov 1", "by tomorrow", "this week" or "when you can" - for the
   *  sentence the template is in. */
  function byWhen(l, today) {
    if (l.due) {
      const left = daysBetween(today, l.due);
      if (left < 0) return 'as soon as you can';
      if (left === 0) return 'today';
      if (left === 1) return 'by tomorrow';
      return `by ${fmtDay(l.due, today)}`;
    }
    return 'sometime this week';
  }

  /** How many messages a tone has (the "Another one" button cycles). */
  function nudgeCount(dir, tone) { return (TEMPLATES[dir === 'borrowed' ? 'borrowed' : 'lent'][tone] || []).length; }
  /** The message this loan starts on for a tone - the same every time. */
  function firstVariant(l, tone) { return hash32(`${l.id}|${tone}`) % nudgeCount(l.dir, tone); }

  /** One ready-to-send message. `link` is the receipt link, added on its
   *  own line when there is one. */
  function nudge(l, tone, variant, today, link) {
    const t = TONE_IDS.includes(tone) ? tone : 'friendly';
    const list = TEMPLATES[l.dir === 'borrowed' ? 'borrowed' : 'lent'][t];
    const i = ((Number.isInteger(variant) ? variant : firstVariant(l, t)) % list.length + list.length) % list.length;
    const n = daysAway(l, today);
    const ctx = {
      who: l.who, WHO: l.who.toUpperCase(), item: itemPhrase(l.item), days: String(n),
      away: plural(n, 'day'), on: fmtDay(l.on, today), byWhen: byWhen(l, today),
    };
    let text = list[i].replace(/\{(\w+)\}/g, (_, k) => (k in ctx ? ctx[k] : ''));
    text = text.charAt(0).toUpperCase() + text.slice(1);
    if (link) text += `\n\nOur Boomerang receipt: ${link}`;
    return text;
  }

  /* ------------------------------------------------------------------ *
   * The sample shelf: made up, dated from today, so every part of the app
   * has something to show in one tap.
   * ------------------------------------------------------------------ */

  function sample(today) {
    const d = (n) => addDays(today, n);
    const raw = [
      { id: 'sample0drill', dir: 'lent', item: 'Cordless drill', emoji: '🔧', who: 'Sam', on: d(-94), due: d(-80), note: 'In the blue case, with the bits', share: { token: 'SAMPLExSAMPLExSAMPLE01', key: 'SAMPLExSAMPLExSAMPLE02', state: 'confirmed' } },
      { id: 'sample0book1', dir: 'lent', item: 'The Thursday Murder Club', emoji: '📚', who: 'Priya', on: d(-20), due: d(1), note: '' },
      { id: 'sample0ladder', dir: 'lent', item: 'Ladder', emoji: '🪜', who: 'Dev', on: d(-38), due: null, note: 'The tall one from the garage' },
      { id: 'sample0dish1', dir: 'borrowed', item: 'Casserole dish', emoji: '🥘', who: 'Mum', on: d(-12), due: d(9), note: 'The orange one. Wash it first!' },
      { id: 'sample0tent1', dir: 'borrowed', item: 'Two-person tent', emoji: '⛺', who: 'Alex', on: d(-6), due: d(2), note: '' },
      { id: 'sample0catan', dir: 'lent', item: 'Catan', emoji: '🎲', who: 'Jordan', on: d(-41), due: d(-27), back: d(-28), note: '' },
      { id: 'sample0jackt', dir: 'lent', item: 'Rain jacket', emoji: '🧥', who: 'Jordan', on: d(-70), due: d(-60), back: d(-61), note: '' },
      { id: 'sample0tin01', dir: 'borrowed', item: 'Cake tin', emoji: '🎂', who: 'Mum', on: d(-60), due: null, back: d(-45), note: '' },
    ];
    return raw.map((l) => cleanLoan({ ...l, sample: true }, today));
  }

  return {
    LIMITS, HANDSHAKE, STATES, TONES, TONE_IDS, DIRS, PICKER, DEFAULT_EMOJI, TEMPLATES, ID_RE, TOKEN_RE, SAVED_FIELDS,
    clean, cleanText, cleanItem, cleanName, cleanNote, cleanHint, cleanEmoji, fold,
    guessEmoji, suggestEmoji,
    isDay, daysBetween, addDays, localDay, fmtDay, plural, hash32, fail,
    newLoanId, cleanLoan, toSaved, status, daysAway, dueText, whoLine, itemPhrase,
    shelf, holidayLine, stats,
    sideOf, newHandshake, allowed, step, expired, handshakeView, handshakeLine, stateLine,
    byWhen, nudgeCount, firstVariant, nudge,
    sample,
  };
});
