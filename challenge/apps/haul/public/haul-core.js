/* Haul - the rules, in one file run three times: `window.HaulCore` in the
 * page, `require` in the server and in the tests.
 *
 * NO CLOCK AND NO DICE. Nothing here reads the time or makes a random
 * number: "today" (YYYY-MM-DD in the family's own day), "now" (ms) and every
 * new id are handed in. No lookbehind regexes (older iPhones cannot parse
 * them), no storage, no network.
 *
 * What lives here:
 *   - text cleaning and escaping (every typed name, custom candy and model
 *     answer goes through these);
 *   - the candy list (48 common US Halloween treats, brand names as plain
 *     text only), the six categories and their trade values, the avatars;
 *   - a trick-or-treater and the family, counting and undo, the totals;
 *   - the haul card: top three, the rarest find and a fun title (never mean);
 *   - fair trade: the points, the plain words, the hint and the swap;
 *   - make it last: pieces a day, which days, when the stash runs out, eat
 *     one, and the buyback ("Switch Witch") sums;
 *   - set aside: the family's own flags - Haul has no allergen data;
 *   - "Count it from a photo": what is sent, and what is accepted back;
 *   - the made-up sample haul for "Try it".
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HaulCore = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const LIMITS = {
    kids: 6,              // trick-or-treaters on one device
    name: 20,             // a first name or nickname
    customName: 28,       // an "Other" candy's name
    custom: 30,           // "Other" candies per family
    perCandy: 999,        // pieces of one candy one child can have
    undo: 60,             // counting steps that can be undone
    trades: 60,           // the trade log
    perDayMax: 12,        // the ration slider's top
    eatenDays: 120,       // days of "eaten" kept per child
    valueMax: 20,         // a category's trade value
    centsMax: 500,        // buyback cents per piece
    prize: 40,            // a buyback prize's name
    prizePieces: 500,
    aiPerCandy: 200,      // a photo count per candy...
    aiTotal: 800,         // ...and in all
    aiOthers: 8,          // "Other: <name>" rows from a photo
    aiOtherName: 28,
    aiNote: 160,
    aiImageBytes: 720 * 1024,
    aiImageSide: 1600,
  };

  /* ------------------------------------------------------------------ *
   * Text
   * ------------------------------------------------------------------ */

  // Control characters, bidi overrides and isolates, zero-width characters
  // and the BOM. Written as escapes so this file carries none of its own.
  const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

  /** One line of plain text: no control or invisible characters, single
   *  spaces, at most `max` characters (never splitting one). */
  function line(v, max) {
    let s = String(v === null || v === undefined ? '' : v).slice(0, max * 8 + 64).replace(/[\r\n\t]+/g, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    const cps = Array.from(s);
    if (cps.length > max) s = cps.slice(0, max).join('').trim();
    return s;
  }
  /** A line with markup taken out as well. Angle brackets never survive. */
  function plain(v, max) {
    const s = String(v === null || v === undefined ? '' : v).slice(0, max * 8 + 64);
    return line(s.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' '), max);
  }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || `${one}s`)}`; }
  /** A name people will read: plain, bounded, and it must have a letter or
   *  a digit in it (an emoji-only or blank name is no name). */
  function cleanName(v, max) {
    const s = plain(v, max || LIMITS.name);
    return /[\p{L}\p{N}]/u.test(s) ? s : '';
  }
  /** Links of any kind out of something a model wrote. */
  function stripLinks(s) {
    return String(s)
      .replace(/\b(?:https?|ftp|javascript|data|vbscript):\S*/gi, ' ')
      .replace(/\bwww\.\S*/gi, ' ')
      .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|app|xyz|info|biz|ly|me|example|site|online|shop|top|uk|us|ru|cn)\b\S*/gi, ' ');
  }
  /** One short sentence from a model: plain, no links, a letter in it. */
  function modelText(v, max) {
    const s = line(stripLinks(plain(v, max * 2)), max);
    return /[\p{L}]/u.test(s) ? s : '';
  }
  const ID_RE = /^[a-z0-9]{6,16}$/;
  const CUSTOM_RE = /^x[a-z0-9]{6,12}$/;
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isId = (v) => typeof v === 'string' && ID_RE.test(v);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const intIn = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);

  /* ------------------------------------------------------------------ *
   * The candy
   * ------------------------------------------------------------------ */

  // Trade values are a simple tier the family can change in settings.
  const CATS = [
    { id: 'choc', label: 'Chocolate', emoji: '🍫', value: 3 },
    { id: 'fruity', label: 'Fruity & sour', emoji: '🍋', value: 2 },
    { id: 'gummy', label: 'Gummies', emoji: '🐻', value: 2 },
    { id: 'hard', label: 'Hard candy', emoji: '🍭', value: 1 },
    { id: 'full', label: 'Full-size!', emoji: '🏆', value: 5 },
    { id: 'not', label: 'Not candy', emoji: '✏️', value: 0.5 },
  ];
  const CAT_IDS = CATS.map((c) => c.id);
  const catOf = (id) => CATS.find((c) => c.id === id) || null;
  const DEFAULT_VALUES = CATS.reduce((o, c) => { o[c.id] = c.value; return o; }, {});

  /**
   * One candy: `rare` (1 everywhere - 5 the porch everyone talks about)
   * picks the card's "rarest find"; `one` / `many` are the words in a
   * sentence ("2 peanut butter cups"); `eat: false` is a thing nobody eats
   * (a pencil), left out of the ration plan.
   */
  function c(id, name, emoji, cat, rare, one, many, words, eat) {
    return { id, name, emoji, cat, rare, one: one || name, many: many || one || name, words: words || '', eat: eat !== false };
  }
  const CANDY = [
    c('pbcups', 'Peanut butter cups', '🥜', 'choc', 2, 'peanut butter cup', 'peanut butter cups', 'reeses reese pb'),
    c('chocbar', 'Chocolate bar (mini)', '🍫', 'choc', 1, 'mini chocolate bar', 'mini chocolate bars', 'hersheys hershey milk plain'),
    c('wafer', 'KitKat-style wafer', '🧇', 'choc', 1, 'KitKat-style wafer', 'KitKat-style wafers', 'kit kat kitkat'),
    c('snickers', 'Snickers', '🍫', 'choc', 1),
    c('mms', 'M&M’s', '🟤', 'choc', 1, 'pack of M&M’s', 'packs of M&M’s', 'mms m and ms'),
    c('twix', 'Twix', '🍪', 'choc', 1),
    c('milkyway', 'Milky Way', '🌌', 'choc', 1),
    c('musketeers', '3 Musketeers', '☁️', 'choc', 1, '3 Musketeers bar', '3 Musketeers bars', 'three'),
    c('butterfinger', 'Butterfinger', '🧈', 'choc', 1),
    c('kisses', 'Hershey’s Kisses', '💋', 'choc', 1, 'Hershey’s Kiss', 'Hershey’s Kisses', 'hersheys kiss'),
    c('almondjoy', 'Almond Joy / Mounds', '🥥', 'choc', 2, 'Almond Joy', 'Almond Joys', 'mounds coconut'),
    c('milkduds', 'Milk Duds', '🍮', 'choc', 2, 'box of Milk Duds', 'boxes of Milk Duds', 'caramel'),
    c('whoppers', 'Whoppers', '🥛', 'choc', 2, 'box of Whoppers', 'boxes of Whoppers', 'malted'),

    c('skittles', 'Skittles', '🌈', 'fruity', 1, 'pack of Skittles', 'packs of Skittles'),
    c('starburst', 'Starburst', '⭐', 'fruity', 1),
    c('sourpatch', 'Sour Patch Kids', '😝', 'fruity', 2, 'pack of Sour Patch Kids', 'packs of Sour Patch Kids'),
    c('warheads', 'Warheads', '😖', 'fruity', 2, 'Warhead', 'Warheads', 'sour'),
    c('nerds', 'Nerds', '🤓', 'fruity', 1, 'box of Nerds', 'boxes of Nerds'),
    c('laffy', 'Laffy Taffy', '😂', 'fruity', 1, 'Laffy Taffy', 'Laffy Taffys', 'taffy'),
    c('airheads', 'Airheads', '💨', 'fruity', 1, 'Airhead', 'Airheads'),
    c('smarties', 'Smarties (rolls)', '🧠', 'fruity', 1, 'roll of Smarties', 'rolls of Smarties'),
    c('licorice', 'Twizzlers / licorice', '🎀', 'fruity', 1, 'licorice twist', 'licorice twists', 'twizzlers red vines'),
    c('sourcandy', 'Sour candy', '🍋', 'fruity', 1, 'sour candy', 'sour candies', 'sour'),

    c('gummybears', 'Gummy bears', '🐻', 'gummy', 1, 'pack of gummy bears', 'packs of gummy bears', 'haribo gummi'),
    c('gummyworms', 'Gummy worms', '🪱', 'gummy', 1, 'gummy worm', 'gummy worms', 'gummi'),
    c('fruitsnacks', 'Fruit snacks', '🍓', 'gummy', 1, 'pack of fruit snacks', 'packs of fruit snacks', 'welchs'),
    c('swedishfish', 'Swedish Fish', '🐟', 'gummy', 2, 'pack of Swedish Fish', 'packs of Swedish Fish'),
    c('gummyeyes', 'Gummy eyeballs', '👁️', 'gummy', 3, 'gummy eyeball', 'gummy eyeballs', 'gummi'),
    c('gummies', 'Gummies', '🍒', 'gummy', 1, 'gummy', 'gummies', 'gummi'),

    c('lollipop', 'Lollipop', '🍭', 'hard', 1, 'lollipop', 'lollipops', 'dum dums dumdums sucker'),
    c('jollyrancher', 'Jolly Rancher', '💎', 'hard', 1, 'Jolly Rancher', 'Jolly Ranchers'),
    c('candycorn', 'Candy corn', '🌽', 'hard', 1, 'candy corn', 'candy corn'),
    c('tootsieroll', 'Tootsie Roll', '🪵', 'hard', 1, 'Tootsie Roll', 'Tootsie Rolls', 'tootsie pop'),
    c('ringpop', 'Ring Pop', '💍', 'hard', 3, 'Ring Pop', 'Ring Pops'),
    c('jawbreaker', 'Jawbreaker', '🔮', 'hard', 2, 'jawbreaker', 'jawbreakers', 'gobstopper'),
    c('bubblegum', 'Bubble gum', '🎈', 'hard', 1, 'piece of bubble gum', 'pieces of bubble gum', 'gum'),
    c('hardcandy', 'Hard candy', '🍬', 'hard', 1, 'hard candy', 'hard candies', 'mints peppermint butterscotch'),

    c('fullbar', 'Full-size bar', '🏆', 'full', 4, 'full-size bar', 'full-size bars', 'big'),
    c('kingsize', 'King-size', '👑', 'full', 5, 'king-size', 'king-size', 'big'),
    c('fullbag', 'Full-size bag', '🎁', 'full', 4, 'full-size bag', 'full-size bags', 'big'),

    c('raisins', 'Raisins', '🍇', 'not', 2, 'box of raisins', 'boxes of raisins'),
    c('pretzels', 'Chips or pretzels', '🥨', 'not', 1, 'bag of chips or pretzels', 'bags of chips or pretzels', 'chips popcorn crackers snack'),
    c('stickers', 'Stickers', '🌟', 'not', 1, 'sticker', 'stickers', 'teal', false),
    c('pencil', 'Pencil', '✏️', 'not', 2, 'pencil', 'pencils', 'eraser teal', false),
    c('toothbrush', 'Toothbrush', '🪥', 'not', 3, 'toothbrush', 'toothbrushes', 'dentist', false),
    c('glowstick', 'Glow stick', '🪄', 'not', 2, 'glow stick', 'glow sticks', 'bracelet teal', false),
    c('toy', 'Little toy', '🧸', 'not', 2, 'little toy', 'little toys', 'bouncy ball ring teal', false),
    c('coins', 'Coins', '🪙', 'not', 4, 'coin', 'coins', 'money', false),
  ];
  const CANDY_IDS = CANDY.map((x) => x.id);
  const BY_ID = CANDY.reduce((o, x) => { o[x.id] = x; return o; }, {});

  const AVATARS = [
    ['🧛', 'Vampire'], ['🧙', 'Wizard'], ['👻', 'Ghost'], ['🦇', 'Bat'], ['🧟', 'Zombie'], ['🦸', 'Superhero'],
    ['🐱', 'Black cat'], ['🦖', 'Dinosaur'], ['🎃', 'Pumpkin'], ['🧚', 'Fairy'], ['🤖', 'Robot'], ['💀', 'Skeleton'],
    ['🦄', 'Unicorn'], ['🐉', 'Dragon'], ['🥷', 'Ninja'], ['👽', 'Alien'],
  ];
  const AVATAR_SET = AVATARS.map((a) => a[0]);
  const avatarLabel = (e) => (AVATARS.find((a) => a[0] === e) || AVATARS[0])[1];

  function candyOf(id, custom) {
    if (typeof id !== 'string') return null;
    if (own(BY_ID, id)) return BY_ID[id];
    return (custom || []).find((x) => x.id === id) || null;
  }
  const catalog = (custom) => CANDY.concat(custom || []);

  /** A family's own "Other" candy. */
  function customCandy(name, cat, id) {
    const nm = cleanName(name, LIMITS.customName);
    if (!nm || !CUSTOM_RE.test(String(id || '')) || CAT_IDS.indexOf(cat) < 0) return null;
    return { id, name: nm, emoji: catOf(cat).emoji, cat, rare: 2, one: nm, many: nm, words: '', eat: cat !== 'not', custom: true };
  }
  function cleanCustom(list) {
    const out = []; const seen = new Set();
    for (const r of Array.isArray(list) ? list : []) {
      const x = r && customCandy(r.name, r.cat, r.id);
      if (!x || seen.has(x.id)) continue;
      seen.add(x.id); out.push(x);
      if (out.length >= LIMITS.custom) break;
    }
    return out;
  }
  /** The family's custom candy with this name and category, if any. */
  function findCustom(custom, name, cat) {
    const k = String(name || '').toLowerCase();
    return (custom || []).find((x) => x.name.toLowerCase() === k && x.cat === cat) || null;
  }

  function cleanValues(v) {
    const out = {};
    for (const cat of CATS) {
      const n = v && typeof v === 'object' ? Number(v[cat.id]) : NaN;
      out[cat.id] = Number.isFinite(n) && n >= 0 && n <= LIMITS.valueMax ? Math.round(n * 2) / 2 : cat.value;
    }
    return out;
  }

  /** Words to search a tile by: name, sentence forms, extra words, category. */
  function norm(s) { return String(s || '').toLowerCase().replace(/[’'`.]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
  function matches(candy, q) {
    const want = norm(q);
    if (!want) return true;
    const hay = ` ${norm([candy.name, candy.one, candy.many, candy.words, (catOf(candy.cat) || {}).label].join(' '))} `;
    const compact = hay.replace(/ /g, '');
    return want.split(' ').every((w) => hay.indexOf(w) >= 0) || compact.indexOf(want.replace(/ /g, '')) >= 0;
  }

  /* ------------------------------------------------------------------ *
   * A trick-or-treater, and the family
   * ------------------------------------------------------------------ */

  const EVERY_DAY = [true, true, true, true, true, true, true];
  function cleanPlan(p) {
    p = p && typeof p === 'object' ? p : {};
    const days = Array.isArray(p.days) && p.days.length === 7 ? p.days.map((d) => d === true) : EVERY_DAY.slice();
    const eaten = {};
    if (p.eaten && typeof p.eaten === 'object') {
      Object.keys(p.eaten).filter((k) => DAY_RE.test(k) && dayNum(k) !== null).sort().slice(-LIMITS.eatenDays).forEach((k) => {
        const n = intIn(p.eaten[k], 1, LIMITS.perCandy, 0);
        if (n) eaten[k] = n;
      });
    }
    return { perDay: intIn(p.perDay, 0, LIMITS.perDayMax, 2), days, eaten };
  }
  function cleanKid(raw, custom) {
    if (!raw || typeof raw !== 'object' || !isId(raw.id)) return null;
    const counts = {};
    if (raw.counts && typeof raw.counts === 'object' && !Array.isArray(raw.counts)) {
      for (const id of Object.keys(raw.counts)) {
        if (!candyOf(id, custom)) continue;
        const n = intIn(raw.counts[id], 1, LIMITS.perCandy, 0);
        if (n) counts[id] = n;
      }
    }
    const aside = (Array.isArray(raw.aside) ? raw.aside : []).filter((id, i, a) => candyOf(id, custom) && a.indexOf(id) === i).slice(0, 80);
    return {
      id: raw.id,
      name: cleanName(raw.name, LIMITS.name),
      avatar: AVATAR_SET.indexOf(raw.avatar) >= 0 ? raw.avatar : AVATARS[0][0],
      counts,
      aside,
      plan: cleanPlan(raw.plan),
      handed: intIn(raw.handed, 0, 1e6, 0),
      tradedIn: intIn(raw.tradedIn, 0, 1e6, 0),
    };
  }
  function newKid(name, avatar, id) { return cleanKid({ id, name, avatar }, []); }

  function cleanBuyback(b) {
    b = b && typeof b === 'object' ? b : {};
    return {
      mode: b.mode === 'prize' ? 'prize' : 'cents',
      cents: intIn(b.cents, 0, LIMITS.centsMax, 10),
      prize: plain(b.prize, LIMITS.prize) || 'a small toy',
      pieces: intIn(b.pieces, 1, LIMITS.prizePieces, 30),
    };
  }
  function cleanTrade(t, kidIds, custom) {
    if (!t || typeof t !== 'object' || !isId(t.id) || kidIds.indexOf(t.a) < 0 || kidIds.indexOf(t.b) < 0 || t.a === t.b) return null;
    const side = (o) => {
      const out = {};
      if (o && typeof o === 'object') for (const id of Object.keys(o)) { const n = intIn(o[id], 1, LIMITS.perCandy, 0); if (n && candyOf(id, custom)) out[id] = n; }
      return out;
    };
    return { id: t.id, at: intIn(t.at, 0, 8.64e15, 0), a: t.a, b: t.b, ga: side(t.ga), gb: side(t.gb), fair: t.fair === true, words: plain(t.words, 240) };
  }
  function emptyFamily() { return { v: 1, kids: [], custom: [], values: cleanValues(null), trades: [], buyback: cleanBuyback(null) }; }
  function cleanFamily(raw) {
    raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const custom = cleanCustom(raw.custom);
    const kids = []; const seen = new Set();
    for (const k of Array.isArray(raw.kids) ? raw.kids : []) {
      const kid = cleanKid(k, custom);
      if (!kid || seen.has(kid.id)) continue;
      seen.add(kid.id); kids.push(kid);
      if (kids.length >= LIMITS.kids) break;
    }
    const ids = kids.map((k) => k.id);
    const trades = (Array.isArray(raw.trades) ? raw.trades : []).map((t) => cleanTrade(t, ids, custom)).filter(Boolean).slice(-LIMITS.trades);
    return { v: 1, kids, custom, values: cleanValues(raw.values), trades, buyback: cleanBuyback(raw.buyback) };
  }
  const kidById = (fam, id) => fam.kids.find((k) => k.id === id) || null;
  /** What to call a child: the name given, or their avatar ("Vampire"), with
   *  a number when two unnamed children share one. */
  function displayName(kid, kids) {
    if (kid.name) return kid.name;
    const label = avatarLabel(kid.avatar);
    const same = (kids || []).filter((k) => !k.name && k.avatar === kid.avatar);
    return same.length > 1 ? `${label} ${same.indexOf(kid) + 1}` : label;
  }
  function possessive(name) { return /s$/i.test(name) ? `${name}’` : `${name}’s`; }

  /** A new family with one child replaced. */
  function withKid(fam, kid) { return Object.assign({}, fam, { kids: fam.kids.map((k) => (k.id === kid.id ? kid : k)) }); }
  function copyKid(kid) { return Object.assign({}, kid, { counts: Object.assign({}, kid.counts), aside: kid.aside.slice(), plan: Object.assign({}, kid.plan, { days: kid.plan.days.slice(), eaten: Object.assign({}, kid.plan.eaten) }) }); }

  /* ------------------------------------------------------------------ *
   * Counting
   * ------------------------------------------------------------------ */

  /**
   * Add `deltas` ({candyId: +n or -n}) to one child's counts, each clamped
   * to 0..999. Returns the new family and what was actually applied (a
   * minus at zero applies nothing), which is the undo step.
   */
  function adjust(fam, kidId, deltas) {
    const kid = kidById(fam, kidId);
    if (!kid) return { fam, applied: {} };
    const next = copyKid(kid);
    const applied = {};
    for (const id of Object.keys(deltas || {})) {
      const d = Number(deltas[id]);
      if (!Number.isInteger(d) || !d || !candyOf(id, fam.custom)) continue;
      const cur = next.counts[id] || 0;
      const to = Math.max(0, Math.min(LIMITS.perCandy, cur + d));
      if (to === cur) continue;
      applied[id] = to - cur;
      if (to) next.counts[id] = to; else delete next.counts[id];
    }
    return { fam: Object.keys(applied).length ? withKid(fam, next) : fam, applied };
  }
  /** Undo a counting step: the applied deltas, reversed. */
  function undoStep(fam, step) {
    const back = {};
    Object.keys(step.applied || {}).forEach((id) => { back[id] = -step.applied[id]; });
    return adjust(fam, step.kid, back).fam;
  }
  function pushUndo(stack, step) {
    if (!step || !Object.keys(step.applied || {}).length) return stack;
    return stack.concat([step]).slice(-LIMITS.undo);
  }

  /** One child's numbers. `edible` is what the ration plan counts: candy
   *  that is eaten, not set aside. */
  function totals(kid, fam) {
    const by = {}; CAT_IDS.forEach((k) => { by[k] = 0; });
    const asideSet = new Set(kid.aside);
    let total = 0; let kinds = 0; let edible = 0; let aside = 0; let nonFood = 0;
    for (const id of Object.keys(kid.counts)) {
      const cd = candyOf(id, fam.custom); const n = kid.counts[id];
      if (!cd || !n) continue;
      by[cd.cat] += n; total += n; kinds += 1;
      if (asideSet.has(id)) aside += n;
      else if (cd.eat) edible += n;
      else nonFood += n;
    }
    return { total, kinds, by, edible, aside, nonFood, full: by.full };
  }
  /** Every child's counts added up, as one pretend child. */
  function familyKid(fam) {
    const counts = {};
    fam.kids.forEach((k) => Object.keys(k.counts).forEach((id) => { counts[id] = (counts[id] || 0) + k.counts[id]; }));
    return { id: 'family0', name: '', avatar: AVATARS[0][0], counts, aside: [], plan: cleanPlan(null), handed: 0, tradedIn: 0 };
  }
  /** The per-category bar: [{cat, label, n, pct}] in category order. */
  function catBar(t) {
    return CATS.map((cat) => ({ cat: cat.id, label: cat.label, n: t.by[cat.id], pct: t.total ? Math.round((t.by[cat.id] / t.total) * 1000) / 10 : 0 }));
  }
  function ranked(kid, fam) {
    return Object.keys(kid.counts).map((id) => ({ c: candyOf(id, fam.custom), n: kid.counts[id] })).filter((r) => r.c && r.n);
  }
  const byName = (a, b) => (a.c.name < b.c.name ? -1 : a.c.name > b.c.name ? 1 : 0);
  function top(kid, fam, k) {
    return ranked(kid, fam).sort((a, b) => (b.n - a.n) || byName(a, b)).slice(0, k || 3).map((r) => ({ id: r.c.id, name: r.c.name, emoji: r.c.emoji, n: r.n }));
  }
  function rarest(kid, fam) {
    const r = ranked(kid, fam).sort((a, b) => (b.c.rare - a.c.rare) || (a.n - b.n) || byName(a, b))[0];
    return r ? { id: r.c.id, name: r.c.name, emoji: r.c.emoji, n: r.n } : null;
  }

  /* ------------------------------------------------------------------ *
   * The haul card: a fun title from the mix - never a mean one
   * ------------------------------------------------------------------ */

  function titleFor(t) {
    if (!t.total) return { id: 'ready', title: 'Ready for the haul', line: 'Tip out the bag and start counting.' };
    const share = (k) => t.by[k] / t.total;
    const pct = (k) => Math.round(share(k) * 100);
    const options = [];
    const add = (id, title, l, score) => options.push({ id, title, line: l, score });
    if (t.full >= 3) add('full', 'Full-Size Hunter', `${plural(t.full, 'full-size treat')} - the porch lights were good to you.`, 2);
    if (t.total >= 150) add('mega', 'Mega Hauler', `${t.total} pieces - that bag earned its keep.`, 1.5);
    if (share('choc') >= 0.5) add('choc', 'The Chocolate Baron', `${pct('choc')}% chocolate - a rich haul.`, 0.5 + share('choc'));
    if (share('fruity') >= 0.35) add('fruity', 'Sour Specialist', `${pct('fruity')}% fruity and sour - pucker up.`, 0.6 + share('fruity'));
    if (share('gummy') >= 0.3) add('gummy', 'Gummy Guru', `${pct('gummy')}% gummies - squishy and proud.`, 0.6 + share('gummy'));
    if (share('hard') >= 0.35) add('hard', 'Lollipop Legend', `${pct('hard')}% hard candy - built to last.`, 0.5 + share('hard'));
    if (share('not') >= 0.2) add('not', 'Treasure Collector', 'Stickers, pencils and surprises - not just sweets.', 0.6 + share('not'));
    if (t.full >= 1) add('full', 'Full-Size Hunter', `${plural(t.full, 'full-size treat')} - a legendary porch found.`, 0.95);
    if (t.kinds >= 14) add('variety', 'Variety Champion', `${t.kinds} different kinds - a bit of everything.`, 0.9);
    options.sort((a, b) => b.score - a.score);
    if (options.length) return { id: options[0].id, title: options[0].title, line: options[0].line };
    return t.total < 15
      ? { id: 'mighty', title: 'Small but Mighty', line: 'Every piece counts - and so did every doorbell.' }
      : { id: 'champ', title: 'Trick-or-Treat Champ', line: 'A haul worth showing off.' };
  }

  /** Should names be on the card by default? Only if a name was given. */
  function cardNamesDefault(fam, who) {
    if (who === 'family') return fam.kids.some((k) => Boolean(k.name));
    const kid = kidById(fam, who);
    return Boolean(kid && kid.name);
  }
  /**
   * Everything the card draws, for one child or the whole family.
   * @param o {names: boolean}
   */
  function cardData(fam, who, o) {
    const names = Boolean(o && o.names);
    const family = who === 'family';
    const kid = family ? familyKid(fam) : kidById(fam, who);
    if (!kid) return null;
    const t = totals(kid, fam);
    const tt = titleFor(t);
    const out = {
      kind: family ? 'family' : 'kid',
      name: family ? '' : (names && kid.name ? kid.name : ''),
      avatar: family ? fam.kids.map((k) => k.avatar).join('') : kid.avatar,
      heading: family ? 'Our family haul' : (names && kid.name ? `${possessive(kid.name)} haul` : 'My Halloween haul'),
      title: tt.title, line: tt.line, titleId: tt.id,
      total: t.total, full: t.full, kinds: t.kinds,
      top: top(kid, fam, 3), rarest: rarest(kid, fam),
      bar: catBar(t),
      // With names off, a child is their costume ("Dinosaur"), never a name.
      kids: family ? fam.kids.map((k) => ({ avatar: k.avatar, name: names && k.name ? k.name : avatarLabel(k.avatar), total: totals(k, fam).total })) : [],
    };
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Fair trade
   * ------------------------------------------------------------------ */

  /** An offer that this child can actually make: known candy, 1..what they have. */
  function cleanOffer(offer, kid, fam) {
    const out = {};
    if (!kid || !offer || typeof offer !== 'object') return out;
    for (const id of Object.keys(offer)) {
      const have = kid.counts[id] || 0;
      const n = Math.min(have, intIn(offer[id], 0, LIMITS.perCandy, 0));
      if (n > 0 && candyOf(id, fam.custom)) out[id] = n;
    }
    return out;
  }
  const pieces = (offer) => Object.keys(offer).reduce((s, id) => s + offer[id], 0);
  function valueOf(id, fam) { const cd = candyOf(id, fam.custom); return cd ? fam.values[cd.cat] : 0; }
  function offerValue(offer, fam) { return Object.keys(offer).reduce((s, id) => s + offer[id] * valueOf(id, fam), 0); }
  /** "2 peanut butter cups, 1 Twix and 3 more" */
  function describeOffer(offer, fam, max) {
    const rows = Object.keys(offer).map((id) => ({ c: candyOf(id, fam.custom), n: offer[id] })).filter((r) => r.c)
      .sort((a, b) => (b.n - a.n) || byName(a, b));
    if (!rows.length) return 'nothing';
    const k = max || 3;
    const words = rows.slice(0, k).map((r) => `${r.n} ${r.n === 1 ? r.c.one : r.c.many}`);
    const rest = rows.slice(k).reduce((s, r) => s + r.n, 0);
    if (rest) words.push(`${rest} more`);
    return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  }
  function points(v) { const r = Math.round(v * 2) / 2; return `${r % 1 ? r.toFixed(1) : r} ${r === 1 ? 'point' : 'points'}`; }

  /**
   * Is this trade fair? Both offers are cleaned against what each child has.
   * Fair is within 10% of the bigger side (and never more than half a point
   * apart on small trades). A child can offer their own set-aside candy - the
   * classic allergy swap - but never be handed candy they set aside.
   */
  function tradeCheck(fam, aId, bId, offerA, offerB) {
    const A = kidById(fam, aId); const B = kidById(fam, bId);
    if (!A || !B || A.id === B.id) return { state: 'none', va: 0, vb: 0, words: 'Pick two trick-or-treaters to trade.', hint: '' };
    const ga = cleanOffer(offerA, A, fam); const gb = cleanOffer(offerB, B, fam);
    const na = displayName(A, fam.kids); const nb = displayName(B, fam.kids);
    const va = offerValue(ga, fam); const vb = offerValue(gb, fam);
    const base = { ga, gb, va, vb, giver: null, hint: '' };
    const blockedFor = (kid, offer) => Object.keys(offer).filter((id) => kid.aside.indexOf(id) >= 0);
    const bb = blockedFor(B, ga); const ba = blockedFor(A, gb);
    if (bb.length || ba.length) {
      const who = bb.length ? nb : na; const id = (bb.length ? bb : ba)[0];
      return Object.assign(base, { state: 'blocked', words: `${who} sets ${candyOf(id, fam.custom).many} aside - pick something else.` });
    }
    const pa = pieces(ga); const pb = pieces(gb);
    if (!pa && !pb) return Object.assign(base, { state: 'empty', words: `Pick what ${na} and ${nb} each offer.` });
    if (!pa || !pb) {
      const [who, other, offer] = pa ? [na, nb, ga] : [nb, na, gb];
      return Object.assign(base, { state: 'half', words: `${who} offers ${describeOffer(offer, fam)}. What will ${other} give?` });
    }
    const deal = `${possessive(na)} ${describeOffer(ga, fam)} for ${possessive(nb)} ${describeOffer(gb, fam)}`;
    const diff = Math.abs(va - vb);
    const tol = Math.max(0.5, 0.1 * Math.max(va, vb));
    if (diff <= tol + 1e-9) return Object.assign(base, { state: 'fair', words: `${deal} is fair.` });
    const aMore = va > vb;
    const more = aMore ? na : nb; const less = aMore ? nb : na;
    const lot = Math.min(va, vb) / Math.max(va, vb) < 0.6;
    const lessKid = aMore ? B : A; const lessOffer = aMore ? gb : ga;
    // A hint: one kind of candy the child giving less still has, whose
    // pieces come closest to the gap.
    let best = null;
    for (const id of Object.keys(lessKid.counts)) {
      const left = lessKid.counts[id] - (lessOffer[id] || 0);
      const v = valueOf(id, fam);
      const receiver = aMore ? A : B;
      if (left <= 0 || v <= 0 || receiver.aside.indexOf(id) >= 0) continue;
      const k = Math.max(1, Math.min(left, Math.round(diff / v)));
      const miss = Math.abs(diff - k * v);
      const cd = candyOf(id, fam.custom);
      // Closest to the gap; then fewer pieces (a Snickers beats 3 candy corn); then by name.
      const better = !best || miss < best.miss - 1e-9 || (Math.abs(miss - best.miss) < 1e-9 && (k < best.k || (k === best.k && cd.name < best.c.name)));
      if (better) best = { c: cd, k, miss };
    }
    const hint = best && best.miss < diff
      ? `To even it up, ${less} could add ${points(diff)} - like ${best.k} ${best.k === 1 ? best.c.one : best.c.many}. Or ${more} could give a little less.`
      : `To even it up, ${more} could give a little less.`;
    return Object.assign(base, {
      state: 'leans', giver: aMore ? 'a' : 'b',
      words: `${deal}: ${more} gives ${lot ? 'a lot' : 'a bit'} more.`,
      hint,
    });
  }
  /**
   * Swap the pieces. Refused (null) unless both offers are real and nothing
   * goes to a child who sets it aside. A gift (an unfair swap both agree to)
   * is allowed: the meter advises, it does not rule.
   */
  function applyTrade(fam, aId, bId, offerA, offerB, at, id) {
    const chk = tradeCheck(fam, aId, bId, offerA, offerB);
    if (['none', 'blocked', 'empty'].indexOf(chk.state) >= 0 || !isId(id)) return null;
    const A = copyKid(kidById(fam, aId)); const B = copyKid(kidById(fam, bId));
    const move = (from, to, offer) => Object.keys(offer).forEach((cid) => {
      from.counts[cid] -= offer[cid]; if (!from.counts[cid]) delete from.counts[cid];
      to.counts[cid] = Math.min(LIMITS.perCandy, (to.counts[cid] || 0) + offer[cid]);
    });
    move(A, B, chk.ga); move(B, A, chk.gb);
    const trade = { id, at: intIn(at, 0, 8.64e15, 0), a: aId, b: bId, ga: chk.ga, gb: chk.gb, fair: chk.state === 'fair', words: chk.words };
    const next = withKid(withKid(fam, A), B);
    next.trades = fam.trades.concat([trade]).slice(-LIMITS.trades);
    return { fam: next, trade };
  }
  /** Undo the latest trade, if both children still have the pieces. */
  function undoTrade(fam, tradeId) {
    const t = fam.trades[fam.trades.length - 1];
    if (!t || t.id !== tradeId) return null;
    const A = kidById(fam, t.a); const B = kidById(fam, t.b);
    if (!A || !B) return null;
    const has = (kid, offer) => Object.keys(offer).every((cid) => (kid.counts[cid] || 0) >= offer[cid]);
    if (!has(B, t.ga) || !has(A, t.gb)) return null;
    const a = copyKid(A); const b = copyKid(B);
    const move = (from, to, offer) => Object.keys(offer).forEach((cid) => {
      from.counts[cid] -= offer[cid]; if (!from.counts[cid]) delete from.counts[cid];
      to.counts[cid] = Math.min(LIMITS.perCandy, (to.counts[cid] || 0) + offer[cid]);
    });
    move(b, a, t.ga); move(a, b, t.gb);
    const next = withKid(withKid(fam, a), b);
    next.trades = fam.trades.slice(0, -1);
    return next;
  }

  /* ------------------------------------------------------------------ *
   * Days (no clock: "today" is handed in as YYYY-MM-DD)
   * ------------------------------------------------------------------ */

  const DAY_MS = 86400000;
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayNum(s) {
    const m = DAY_RE.test(String(s)) ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
    if (!m) return null;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isFinite(t)) return null;
    const n = Math.round(t / DAY_MS);
    return dayStr(n) === s ? n : null;
  }
  function dayStr(n) {
    const d = new Date(n * DAY_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  const weekdayOf = (n) => (((n + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
  function dayLabel(n) { const d = new Date(n * DAY_MS); return `${WD[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; }

  /* ------------------------------------------------------------------ *
   * Make it last
   * ------------------------------------------------------------------ */

  /**
   * The ration plan for one child from `today`: what is left today, and the
   * day the stash runs out at this many pieces a day on these days. Only
   * candy that is eaten and not set aside counts (a pencil is not rationed).
   */
  function plan(kid, fam, today) {
    const p = kid.plan;
    const t = totals(kid, fam);
    const start = dayNum(today);
    if (start === null) return null;
    const eatenToday = p.eaten[today] || 0;
    const todayOn = p.days[weekdayOf(start)];
    const leftToday = todayOn ? Math.max(0, p.perDay - eatenToday) : 0;
    const never = p.perDay === 0 || !p.days.some(Boolean);
    let left = t.edible; let last = null; let candyDays = 0;
    const upcoming = [];
    for (let i = 0, d = start; i < 1100 && (i < 7 || (left > 0 && !never)); i++, d++) {
      const on = p.days[weekdayOf(d)];
      const allow = never || !on ? 0 : (i === 0 ? leftToday : p.perDay);
      const take = Math.min(allow, left);
      left -= take;
      if (take > 0) { last = d; candyDays += 1; }
      if (i < 7) upcoming.push({ day: dayStr(d), label: WD[weekdayOf(d)], n: take, on: Boolean(on) && !never });
    }
    let words;
    if (!t.edible) words = t.total ? 'Nothing left to ration - everything here is set aside or not for eating.' : 'The stash is all gone. What a Halloween!';
    else if (never) words = 'Pick at least one piece a day and one day of the week.';
    else words = `The stash lasts until ${dayLabel(last)}`;
    const todayWords = never ? 'No plan yet.'
      : !todayOn ? 'Today is a day off from the stash.'
        : `Today: ${plural(p.perDay, 'piece')} - ${leftToday} left today`;
    return {
      perDay: p.perDay, days: p.days.slice(), edible: t.edible, aside: t.aside, nonFood: t.nonFood,
      eatenToday, leftToday, todayOn: Boolean(todayOn) && !never, never,
      lastDay: last === null ? null : dayStr(last), lastLabel: last === null ? '' : dayLabel(last),
      candyDays, upcoming, words, todayWords,
      over: todayOn && !never && eatenToday >= p.perDay,
    };
  }
  function setPlan(fam, kidId, patch) {
    const kid = kidById(fam, kidId);
    if (!kid) return fam;
    const next = copyKid(kid);
    if (patch && Number.isInteger(patch.perDay)) next.plan.perDay = intIn(patch.perDay, 0, LIMITS.perDayMax, next.plan.perDay);
    if (patch && Array.isArray(patch.days) && patch.days.length === 7) next.plan.days = patch.days.map((d) => d === true);
    return withKid(fam, next);
  }
  /** What can be eaten: candy this child has that is eaten and not set aside. */
  function eatable(kid, fam) {
    return ranked(kid, fam).filter((r) => r.c.eat && kid.aside.indexOf(r.c.id) < 0)
      .sort((a, b) => (b.n - a.n) || byName(a, b)).map((r) => ({ id: r.c.id, name: r.c.name, emoji: r.c.emoji, n: r.n }));
  }
  /** One piece eaten today. Null if that piece is not there to eat. */
  function eatOne(fam, kidId, candyId, today) {
    const kid = kidById(fam, kidId);
    const cd = candyOf(candyId, fam.custom);
    if (!kid || !cd || !cd.eat || kid.aside.indexOf(candyId) >= 0 || !(kid.counts[candyId] > 0) || dayNum(today) === null) return null;
    const next = copyKid(kid);
    next.counts[candyId] -= 1; if (!next.counts[candyId]) delete next.counts[candyId];
    next.plan.eaten[today] = (next.plan.eaten[today] || 0) + 1;
    next.plan = cleanPlan(next.plan);
    return withKid(fam, next);
  }
  function uneat(fam, kidId, candyId, day) {
    const kid = kidById(fam, kidId);
    if (!kid || !candyOf(candyId, fam.custom) || !(kid.plan.eaten[day] > 0)) return fam;
    const next = copyKid(kid);
    next.counts[candyId] = Math.min(LIMITS.perCandy, (next.counts[candyId] || 0) + 1);
    next.plan.eaten[day] -= 1; if (!next.plan.eaten[day]) delete next.plan.eaten[day];
    return withKid(fam, next);
  }

  /** Cents as people say them: 60¢, $1.50. */
  function money(cents) {
    const c0 = Math.max(0, Math.round(Number(cents) || 0));
    return c0 < 100 ? `${c0}¢` : `$${(c0 / 100).toFixed(2)}`;
  }
  /** What trading in n pieces is worth, in words. */
  function buybackWords(b, n) {
    if (b.mode === 'prize') {
      if (n >= b.pieces) return `${plural(n, 'piece')} - enough for ${b.prize}!`;
      return `${n} of ${b.pieces} pieces for ${b.prize} - ${b.pieces - n} to go.`;
    }
    return `Trading in ${plural(n, 'piece')} is worth ${money(n * b.cents)}.`;
  }
  /** Which pieces go when n are traded in: the lowest trade value first,
   *  then the most plentiful - favourites stay. Set-aside candy and things
   *  nobody eats stay too. */
  function tradeInPick(kid, fam, n) {
    const want = Math.max(0, Math.floor(Number(n) || 0));
    const rows = eatable(kid, fam).map((r) => Object.assign(r, { v: valueOf(r.id, fam) }))
      .sort((a, b) => (a.v - b.v) || (b.n - a.n) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const out = {}; let left = want;
    for (const r of rows) { if (left <= 0) break; const k = Math.min(r.n, left); out[r.id] = k; left -= k; }
    return out;
  }
  function tradeIn(fam, kidId, n) {
    const kid = kidById(fam, kidId);
    if (!kid) return null;
    const pick = tradeInPick(kid, fam, n);
    const total = pieces(pick);
    if (!total) return null;
    const next = copyKid(kid);
    Object.keys(pick).forEach((id) => { next.counts[id] -= pick[id]; if (!next.counts[id]) delete next.counts[id]; });
    next.tradedIn += total;
    return { fam: withKid(fam, next), removed: pick, n: total };
  }
  function setBuyback(fam, patch) {
    return Object.assign({}, fam, { buyback: cleanBuyback(Object.assign({}, fam.buyback, patch || {})) });
  }
  function setValues(fam, patch) {
    return Object.assign({}, fam, { values: cleanValues(Object.assign({}, fam.values, patch || {})) });
  }

  /* ------------------------------------------------------------------ *
   * Set aside: the family's own flags. Haul has NO allergen data - it
   * never says what is in anything.
   * ------------------------------------------------------------------ */

  function toggleAside(fam, kidId, candyId) {
    const kid = kidById(fam, kidId);
    if (!kid || !candyOf(candyId, fam.custom)) return fam;
    const next = copyKid(kid);
    const i = next.aside.indexOf(candyId);
    if (i >= 0) next.aside.splice(i, 1); else next.aside.push(candyId);
    return withKid(fam, next);
  }
  /** Copy one child's set-aside choices to every child. */
  function asideForAll(fam, kidId) {
    const kid = kidById(fam, kidId);
    if (!kid) return fam;
    return Object.assign({}, fam, { kids: fam.kids.map((k) => Object.assign(copyKid(k), { aside: kid.aside.slice() })) });
  }
  function asidePile(kid, fam) {
    return kid.aside.filter((id) => kid.counts[id] > 0).map((id) => { const cd = candyOf(id, fam.custom); return { id, name: cd.name, emoji: cd.emoji, n: kid.counts[id] }; });
  }
  /** The set-aside pile handed to a grown-up: those pieces leave the count. */
  function handOver(fam, kidId) {
    const kid = kidById(fam, kidId);
    if (!kid) return null;
    const pile = asidePile(kid, fam);
    const n = pile.reduce((s, r) => s + r.n, 0);
    if (!n) return null;
    const next = copyKid(kid);
    const removed = {};
    pile.forEach((r) => { removed[r.id] = r.n; delete next.counts[r.id]; });
    next.handed += n;
    return { fam: withKid(fam, next), removed, n };
  }
  /** Put pieces back (undo for trade-in and hand-over). */
  function giveBack(fam, kidId, removed, field) {
    const kid = kidById(fam, kidId);
    if (!kid) return fam;
    const next = copyKid(kid);
    let n = 0;
    Object.keys(removed || {}).forEach((id) => { if (candyOf(id, fam.custom)) { next.counts[id] = Math.min(LIMITS.perCandy, (next.counts[id] || 0) + removed[id]); n += removed[id]; } });
    if (field === 'tradedIn' || field === 'handed') next[field] = Math.max(0, next[field] - n);
    return withKid(fam, next);
  }

  /* ------------------------------------------------------------------ *
   * "Count it from a photo" (metered, signed in)
   *
   * Sent: the one photo, and nothing else - not the child's name, not the
   * counts. Accepted back: counts of Haul's own candy (known ids only, whole
   * numbers, 200 a kind, 800 in all), up to 8 "Other" things with a short
   * plain name and a known category, a confidence and one short note.
   * ------------------------------------------------------------------ */

  const CONFIDENCE = ['low', 'medium', 'high'];
  function photoRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'image') return null;
    const im = body.image;
    if (!im || typeof im !== 'object' || Array.isArray(im)) return null;
    if (Object.keys(im).some((k) => k !== 'type' && k !== 'data')) return null;
    if (im.type !== 'image/jpeg' && im.type !== 'image/png') return null;
    if (typeof im.data !== 'string' || !im.data || Math.floor(im.data.length * 3 / 4) > LIMITS.aiImageBytes + 3) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(im.data)) return null;
    return { image: { type: im.type, data: im.data } };
  }
  /** A built-in candy a model's "other" name really is ("Snickers bar"). */
  function knownByName(name) {
    const k = norm(name);
    if (!k) return null;
    return CANDY.find((x) => [x.name, x.one, x.many].some((w) => norm(w) === k)) || null;
  }
  function cleanCount(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const counts = {};
    const addTo = (id, n) => { counts[id] = Math.min(LIMITS.aiPerCandy, (counts[id] || 0) + n); };
    const whole = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? Math.min(n, LIMITS.aiPerCandy) : 0; };
    for (const r of Array.isArray(raw.counts) ? raw.counts.slice(0, 200) : []) {
      if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !own(BY_ID, r.id)) continue;
      const n = whole(r.count);
      if (n) addTo(r.id, n);
    }
    const others = []; const seen = new Set();
    for (const r of Array.isArray(raw.others) ? raw.others.slice(0, 40) : []) {
      if (!r || typeof r !== 'object') continue;
      const n = whole(r.count);
      const name = cleanName(modelText(String(r.name || '').replace(/^\s*other\s*:\s*/i, ''), LIMITS.aiOtherName), LIMITS.aiOtherName);
      if (!n || !name) continue;
      const known = knownByName(name);
      if (known) { addTo(known.id, n); continue; }
      const key = name.toLowerCase();
      if (seen.has(key) || others.length >= LIMITS.aiOthers) continue;
      seen.add(key);
      others.push({ name, cat: CAT_IDS.indexOf(r.category) >= 0 ? r.category : 'hard', n });
    }
    let total = 0;
    const list = [];
    for (const id of CANDY_IDS) {
      if (!counts[id]) continue;
      const n = Math.min(counts[id], LIMITS.aiTotal - total);
      if (n <= 0) break;
      list.push({ id, n }); total += n;
    }
    const keptOthers = [];
    for (const o of others) {
      const n = Math.min(o.n, LIMITS.aiTotal - total);
      if (n <= 0) break;
      keptOthers.push(Object.assign({}, o, { n })); total += n;
    }
    return {
      counts: list, others: keptOthers, total,
      confidence: total && CONFIDENCE.indexOf(raw.confidence) >= 0 ? raw.confidence : 'low',
      note: modelText(raw.note, LIMITS.aiNote),
    };
  }
  /**
   * Add an accepted proposal to one child: rows of {id, n} (built-in) and
   * {other: true, name, cat, n}. An "Other" becomes the family's own candy
   * (or finds the one it already has); `newId()` comes from the page.
   */
  function applyProposal(fam, kidId, rows, newId) {
    let next = fam;
    const deltas = {}; let skipped = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      const n = intIn(r && r.n, 0, LIMITS.aiPerCandy, 0);
      if (!n) continue;
      if (r.other) {
        const name = cleanName(r.name, LIMITS.customName);
        const cat = CAT_IDS.indexOf(r.cat) >= 0 ? r.cat : 'hard';
        if (!name) continue;
        let cd = findCustom(next.custom, name, cat);
        if (!cd) {
          if (next.custom.length >= LIMITS.custom) { skipped += n; continue; }
          cd = customCandy(name, cat, newId());
          if (!cd) { skipped += n; continue; }
          next = Object.assign({}, next, { custom: next.custom.concat([cd]) });
        }
        deltas[cd.id] = (deltas[cd.id] || 0) + n;
      } else if (own(BY_ID, r.id)) {
        deltas[r.id] = (deltas[r.id] || 0) + n;
      }
    }
    const res = adjust(next, kidId, deltas);
    return { fam: res.fam, applied: res.applied, skipped };
  }

  /* ------------------------------------------------------------------ *
   * "Try it": a made-up haul, never saved
   * ------------------------------------------------------------------ */

  function sample() {
    return cleanFamily({
      kids: [
        { id: 'sampleleo', name: 'Leo', avatar: '🦖', counts: { pbcups: 6, chocbar: 9, wafer: 5, snickers: 4, mms: 3, twix: 2, skittles: 4, starburst: 3, nerds: 2, gummybears: 3, lollipop: 7, candycorn: 5, tootsieroll: 6, fullbar: 2, raisins: 2, pencil: 1, stickers: 2 }, plan: { perDay: 2 } },
        { id: 'samplemaya', name: 'Maya', avatar: '🧙', counts: { pbcups: 2, chocbar: 4, kisses: 6, sourpatch: 5, warheads: 3, skittles: 6, laffy: 4, airheads: 3, gummyworms: 4, swedishfish: 3, lollipop: 8, jollyrancher: 4, ringpop: 1, kingsize: 1, toothbrush: 1, coins: 1 }, aside: ['pbcups', 'snickers'], plan: { perDay: 3 } },
      ],
    });
  }

  return {
    LIMITS, INVISIBLE, CATS, CAT_IDS, CANDY, CANDY_IDS, AVATARS, CONFIDENCE, DEFAULT_VALUES, WD,
    line, plain, esc, plural, cleanName, modelText, stripLinks, isId,
    catOf, candyOf, catalog, customCandy, cleanCustom, findCustom, cleanValues, matches, avatarLabel,
    cleanPlan, cleanKid, newKid, cleanBuyback, emptyFamily, cleanFamily, kidById, displayName, possessive,
    adjust, undoStep, pushUndo, totals, familyKid, catBar, top, rarest,
    titleFor, cardNamesDefault, cardData,
    cleanOffer, offerValue, describeOffer, points, tradeCheck, applyTrade, undoTrade, valueOf, pieces,
    dayNum, dayStr, weekdayOf, dayLabel,
    plan, setPlan, eatable, eatOne, uneat, money, buybackWords, tradeInPick, tradeIn, setBuyback, setValues,
    toggleAside, asideForAll, asidePile, handOver, giveBack,
    photoRequest, cleanCount, applyProposal, knownByName,
    sample,
  };
}));
