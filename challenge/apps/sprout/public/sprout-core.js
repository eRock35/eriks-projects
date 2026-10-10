/* Sprout - the rules, in one file, run three times: by the page (a jungle on
 * this phone and the example jungle), by the sitter's page (a care sheet
 * decoded from a link), by the server (which only cleans the one AI answer)
 * and by the tests. UMD: window.SproutCore in the page, require() in node.
 *
 * Nothing here touches a store, the network or the clock on its own: every
 * function is handed `today` (a 'YYYY-MM-DD' in the phone's own time zone)
 * and the hemisphere, so the same plants always give the same board.
 *
 * What is in it:
 *   - the CATALOGUE: ~85 common houseplants and kitchen herbs, each with an
 *     emoji, the light it wants (and puts up with), a base watering interval
 *     with a "check the soil first" rule, humidity, pet safety, a care tip
 *     and the classic mistake. All of it is GUIDANCE, not gospel - the page
 *     says so wherever it shows it;
 *   - cleanPlant: the ONE function every plant goes through - added by hand,
 *     imported from a file, built for the example, or offered by the AI;
 *   - the schedule: when each plant is next due, the bands ("Thirsty today",
 *     "Check soil", "Coming up", "Happy"), the headline, the season (longer
 *     between drinks in winter, by hemisphere), and the interval each plant
 *     LEARNS from "Not yet" and "It was fine" - bounded either side;
 *   - the actions (water, not yet, it was fine, mist, fertilise, snooze,
 *     repot, move, note) and undo, each returning a new plant;
 *   - streaks of on-time care, light-mismatch warnings;
 *   - the plant-sitter link: a care plan for the trip, packed into the URL
 *     FRAGMENT (compressed when the browser can), decoded defensively and
 *     run back through the same cleaner;
 *   - the calendar (.ics) for the next four weeks, and export / import.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SproutCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = {
    plants: 200,           // on one phone
    nick: 30,
    note: 280,             // a note on a plant's timeline
    events: 150,           // per plant, oldest dropped
    sitPlants: 60,         // in one sitter link
    sitNote: 80,           // a note per plant in the link
    sitHomeNote: 280,      // the note for the sitter
    sitFrom: 30,
    sitDays: 42,           // the longest trip a link covers
    fragment: 16000,       // characters after the #
    inflated: 96 * 1024,   // bytes, once decompressed
    importBytes: 2 * 1024 * 1024,
    icsDays: 28,
  };

  /* ------------------------------------------------------------------ *
   * Text: untrusted until cleaned (Shelf Life's cleaner)
   * ------------------------------------------------------------------ */

  // Control characters, zero-width marks and bidi overrides are removed from
  // anything typed or read (a nickname like "‮treB" would draw backwards).
  // The zero-width joiner stays: some emoji need it.
  const STRIP = /[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

  /** One line of untrusted text: no markup, no control or bidi characters,
   *  single spaces, at most `max` characters, cut on a whole character. */
  function clean(v, max) {
    let s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 200) s = s.slice(0, max * 4 + 200);
    s = s.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
    return s;
  }
  /** A name: has to have a letter, a digit or an emoji in it. */
  function cleanText(v, max) {
    const s = clean(v, max);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  /** One emoji (a ZWJ sequence counts as one), else null. */
  function cleanEmoji(v) {
    if (typeof v !== 'string' || v.length > 24) return null;
    const s = v.replace(STRIP, '').trim();
    if (!/^\p{Extended_Pictographic}/u.test(s)) return null;
    if (/[\p{L}\p{N}<>&"'\s]/u.test(s.replace(/[\u20e3\ufe0f]/g, ''))) return null;
    let n = 0;
    if (typeof Intl !== 'undefined' && Intl.Segmenter) { for (const _ of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)) n++; } else n = 1;
    return n === 1 ? s : null;
  }
  /** For HTML: every string drawn on a page goes through this. */
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(STRIP, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  /** "a", "a and b", "a, b and c". */
  function nameList(names) {
    if (names.length <= 2) return names.join(' and ');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  function newId(prefix, rand) {
    const A = 'abcdefghijkmnpqrstuvwxyz23456789';
    const r = rand || ((n) => Math.floor(Math.random() * n));
    let s = prefix;
    for (let i = 0; i < 9; i++) s += A[r(A.length)];
    return s;
  }
  const PLANT_ID = /^p[a-z0-9]{6,12}$/;
  const EVENT_ID = /^e[a-z0-9]{6,12}$/;
  const isPlantId = (v) => typeof v === 'string' && PLANT_ID.test(v);
  const isEventId = (v) => typeof v === 'string' && EVENT_ID.test(v);
  /** FNV-1a, 32 bits, finalised - for the example's deterministic choices
   *  and the sitter's tick key. */
  function hash32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }

  /* ------------------------------------------------------------------ *
   * Days, in the phone's own time zone
   * ------------------------------------------------------------------ */

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isDate(v) {
    if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
    const ms = Date.parse(v + 'T00:00:00Z');
    return !isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === v;
  }
  function cleanTz(tz) {
    if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return 'UTC';
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return 'UTC'; }
  }
  const fmtCache = {};
  /** The calendar date at `ms` in `tz`, as 'YYYY-MM-DD'. */
  function localDate(ms, tz) {
    const z = cleanTz(tz);
    const f = fmtCache[z] || (fmtCache[z] = new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }));
    const p = {};
    for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
    return p.year + '-' + p.month + '-' + p.day;
  }
  const DAY_MS = 86400000;
  const dateMs = (d) => Date.parse(d + 'T00:00:00Z');
  const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
  function addDays(d, n) { return isoDate(dateMs(d) + n * DAY_MS); }
  /** Whole days from a to b, b - a. */
  function daysBetween(a, b) { return Math.round((dateMs(b) - dateMs(a)) / DAY_MS); }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  /** "Wed 8 Oct" (the year when it is not this one). */
  function dateLabel(d, today) {
    const x = new Date(dateMs(d));
    const s = WEEKDAYS[x.getUTCDay()] + ' ' + x.getUTCDate() + ' ' + MONTHS[x.getUTCMonth()];
    return today && d.slice(0, 4) !== today.slice(0, 4) ? s + ' ' + d.slice(0, 4) : s;
  }
  /** "today", "tomorrow", "Thu", "Thu 23 Oct", "yesterday", "3 days ago". */
  function whenLabel(d, today) {
    const n = daysBetween(today, d);
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    if (n < 0) return plural(-n, 'day') + ' ago';
    if (n < 7) return WEEKDAYS[new Date(dateMs(d)).getUTCDay()];
    return dateLabel(d, today);
  }

  /* ------------------------------------------------------------------ *
   * The catalogue
   * ------------------------------------------------------------------ */

  // Light, darkest to sunniest. A plant has the light it likes best and the
  // range it puts up with; a spot has one of these.
  const LIGHTS = [
    { id: 0, key: 'low', label: 'Low light', hint: 'Far from a window, or a north-facing room' },
    { id: 1, key: 'medium', label: 'Medium', hint: 'A couple of metres from a bright window' },
    { id: 2, key: 'bright', label: 'Bright, no sun on it', hint: 'Near a window; the sun doesn’t touch the leaves' },
    { id: 3, key: 'direct', label: 'Direct sun', hint: 'Sun on the leaves for a few hours a day' },
  ];
  // The "check the soil first" rule each plant follows.
  const SOIL = {
    moist: { short: 'Keep lightly moist', check: 'Touch the surface: water when it just feels dry. Never let it dry out all the way.' },
    top: { short: 'Top 2-3 cm dry', check: 'Push a finger in to the first knuckle: water when the top 2-3 cm are dry.' },
    most: { short: 'Mostly dry', check: 'Water when the top half of the pot is dry - lift it: a light pot is a thirsty pot.' },
    dry: { short: 'Fully dry', check: 'Water only when the soil is dry all the way down. When in doubt, wait a few days.' },
    soak: { short: 'No soil to check', check: 'No soil to feel - follow the care tip for how it drinks.' },
  };
  const SOIL_IDS = Object.keys(SOIL);
  const HUMIDITY = {
    low: 'Happy with dry room air',
    medium: 'Ordinary room air is fine',
    high: 'Likes humid air - a bathroom, a pebble tray or a mist',
  };
  // Pet safety: from the ASPCA's well-known toxic / non-toxic plant lists.
  // 'check' where the listing is unclear or the plant is not on it.
  const PETS = {
    safe: { short: 'Pet-safe', line: 'Listed as non-toxic to cats and dogs (ASPCA).' },
    toxic: { short: 'Toxic to pets', line: 'Toxic to cats and dogs if chewed (ASPCA) - keep it out of reach.' },
    check: { short: 'Pets: check', line: 'Not clearly listed - check the ASPCA plant list before a pet nibbles it.' },
  };
  // Groups: how often to feed in the growing season (0 = do not) and how much
  // longer between drinks in deep winter.
  const GROUPS = {
    foliage: { fert: 30, winter: 1.4 },
    trailing: { fert: 30, winter: 1.4 },
    tree: { fert: 30, winter: 1.4 },
    palm: { fert: 45, winter: 1.4 },
    fern: { fert: 45, winter: 1.25 },
    succulent: { fert: 60, winter: 1.8 },
    cactus: { fert: 60, winter: 2.0 },
    flowering: { fert: 21, winter: 1.3 },
    orchid: { fert: 30, winter: 1.3 },
    herb: { fert: 21, winter: 1.2 },
    carnivore: { fert: 0, winter: 1.3 },
    airplant: { fert: 30, winter: 1.3 },
  };

  // [id, name, emoji, group, light min, ideal, max, water days, soil rule,
  //  humidity, pets, tip, the classic mistake, search words, popular]
  const ROWS = [
    ['pothos', 'Pothos', '🌿', 'trailing', 0, 2, 2, 7, 'top', 'medium', 'toxic', 'Trails or climbs happily; pinch the tips and it grows bushier.', 'Yellow leaves all over usually mean too much water - let the top dry first.', 'devils ivy golden epipremnum money plant', 1],
    ['monstera', 'Monstera', '🌿', 'foliage', 1, 2, 2, 7, 'top', 'medium', 'toxic', 'Give it a moss pole and it rewards you with bigger, holier leaves.', 'Yellow lower leaves usually mean too much water.', 'swiss cheese plant deliciosa', 1],
    ['adansonii', 'Swiss cheese vine', '🍃', 'trailing', 1, 2, 2, 6, 'top', 'high', 'toxic', 'Loves a little humidity and something to climb.', 'Crispy brown edges mean dry air, or it dried out completely.', 'monstera adansonii monkey mask', 0],
    ['minimonstera', 'Mini monstera', '🌿', 'trailing', 1, 2, 2, 7, 'top', 'medium', 'check', 'A fast climber - tie it to a stake and it races up.', 'Leaves that stay small mean it wants more light.', 'rhaphidophora tetrasperma', 0],
    ['snake', 'Snake plant', '🪴', 'foliage', 0, 2, 3, 14, 'dry', 'low', 'toxic', 'Thrives on neglect - it stores water in its leaves.', 'Mushy, folding leaves mean overwatering: the commonest way to lose one.', 'sansevieria dracaena trifasciata mother in laws tongue', 1],
    ['zz', 'ZZ plant', '🪴', 'foliage', 0, 1, 2, 14, 'dry', 'low', 'toxic', 'Its fat roots store water - it would rather be forgotten than fussed over.', 'Yellowing stems mean it was watered before it dried out.', 'zamioculcas zanzibar gem', 1],
    ['peacelily', 'Peace lily', '🪷', 'flowering', 0, 1, 2, 6, 'top', 'high', 'toxic', 'It droops dramatically when thirsty and perks up within hours of a drink.', 'Brown leaf tips often come from tap water or dry air - try filtered water.', 'spathiphyllum', 1],
    ['fiddle', 'Fiddle leaf fig', '🌳', 'tree', 2, 2, 3, 8, 'top', 'medium', 'toxic', 'Pick a bright spot and leave it there - it sulks when moved.', 'Brown patches in the middle of leaves usually mean wet roots.', 'ficus lyrata fig', 1],
    ['spider', 'Spider plant', '🌱', 'foliage', 1, 2, 2, 7, 'top', 'medium', 'safe', 'Its babies root in a glass of water - free plants to give away.', 'Brown tips are usually tap water or dry air, not a dying plant.', 'chlorophytum airplane plant', 1],
    ['calathea', 'Calathea', '🍃', 'foliage', 0, 1, 2, 6, 'moist', 'high', 'safe', 'The leaves fold up at night - that is it praying, not dying.', 'Crispy edges mean dry air or hard water; curled leaves mean thirsty.', 'goeppertia medallion prayer zebra', 1],
    ['maranta', 'Prayer plant', '🍃', 'foliage', 0, 1, 2, 6, 'moist', 'high', 'safe', 'Lifts its leaves at dusk like hands in prayer.', 'Faded leaves mean too much sun.', 'maranta leuconeura red veined herringbone', 0],
    ['rattlesnake', 'Rattlesnake plant', '🍃', 'foliage', 0, 1, 2, 6, 'moist', 'high', 'safe', 'One of the easier calatheas - steady moisture and no sun.', 'Curling leaves mean the soil went dry.', 'calathea lancifolia', 0],
    ['echeveria', 'Echeveria', '🪴', 'succulent', 2, 3, 3, 14, 'dry', 'low', 'safe', 'Water deeply, let it dry right out, and give it the sunniest sill you have.', 'Stretched, pale growth means not enough light.', 'succulent rosette', 1],
    ['jade', 'Jade plant', '🪴', 'succulent', 2, 3, 3, 14, 'dry', 'low', 'toxic', 'Lives for decades; a sunny sill makes the leaf edges blush red.', 'Shrivelled leaves mean thirsty; soft yellow ones mean too much water.', 'crassula money tree lucky', 0],
    ['aloe', 'Aloe vera', '🪴', 'succulent', 2, 3, 3, 18, 'dry', 'low', 'toxic', 'Gritty cactus soil and a pot with a hole keep it happy for years.', 'Thin, curling leaves mean it is living on its stored water - give it a drink.', 'aloe barbadensis', 1],
    ['haworthia', 'Haworthia', '🪴', 'succulent', 1, 2, 3, 14, 'dry', 'low', 'safe', 'Happy with less sun than most succulents - a sill with morning light will do.', 'Brown, mushy leaves at the base mean the soil stayed wet too long.', 'zebra cactus', 0],
    ['sempervivum', 'Hens and chicks', '🪴', 'succulent', 2, 3, 3, 14, 'dry', 'low', 'safe', 'The little offsets can be popped off and potted on their own.', 'Rot at the centre comes from water sitting in the rosette.', 'sempervivum houseleek', 0],
    ['burrostail', 'Burro’s tail', '🪴', 'succulent', 2, 3, 3, 14, 'dry', 'low', 'safe', 'Its leaves drop if you breathe on it - pick a spot and stop moving it.', 'Wrinkled leaves mean thirsty; it still wants to dry out between drinks.', 'sedum morganianum donkey', 0],
    ['pearls', 'String of pearls', '📿', 'succulent', 2, 2, 3, 14, 'dry', 'low', 'toxic', 'Water when the pearls look slightly wrinkled.', 'Mushy, flat pearls mean too much water - it hates sitting wet.', 'senecio rowleyanus curio', 1],
    ['bananas', 'String of bananas', '🍌', 'succulent', 2, 2, 3, 12, 'dry', 'low', 'check', 'Grows faster and forgives more than string of pearls.', 'Soft, see-through leaves mean too much water.', 'curio radicans senecio', 0],
    ['hearts', 'String of hearts', '💞', 'trailing', 2, 2, 3, 12, 'most', 'low', 'check', 'The little bulbs on the vines root if you lay them on soil.', 'Losing leaves at the top usually means too much water.', 'ceropegia woodii rosary vine', 0],
    ['cactus', 'Cactus', '🌵', 'cactus', 2, 3, 3, 21, 'dry', 'low', 'check', 'Almost no water in winter - once a month at most.', 'A soft, mushy base means rot from too much water.', 'barrel bunny ears opuntia mammillaria', 1],
    ['christmascactus', 'Christmas cactus', '🌺', 'flowering', 1, 2, 2, 9, 'top', 'medium', 'safe', 'Long, dark nights in autumn make it set buds.', 'Dropping buds come from moving it or a sudden draught.', 'schlumbergera holiday thanksgiving easter', 0],
    ['phalaenopsis', 'Moth orchid', '🌸', 'orchid', 1, 2, 2, 8, 'most', 'high', 'safe', 'Water when the roots look silvery, not green: soak the pot ten minutes, then drain.', 'Ice cubes and soggy moss rot the roots - water properly, then let it drain.', 'orchid phalaenopsis', 1],
    ['rubber', 'Rubber plant', '🌳', 'tree', 1, 2, 2, 9, 'top', 'medium', 'toxic', 'Wipe the big leaves with a damp cloth - dust blocks light.', 'Dropping lower leaves usually mean overwatering or a cold draught.', 'ficus elastica', 1],
    ['weepingfig', 'Weeping fig', '🌳', 'tree', 2, 2, 2, 7, 'top', 'medium', 'toxic', 'It drops leaves after a move and settles in a couple of weeks.', 'Moving it around to "help" is what makes it shed.', 'ficus benjamina', 0],
    ['bostonfern', 'Boston fern', '🌿', 'fern', 0, 1, 2, 3, 'moist', 'high', 'safe', 'A bathroom with a window is fern heaven.', 'Crispy, brown fronds mean it dried out or the air is too dry.', 'nephrolepis sword', 1],
    ['maidenhair', 'Maidenhair fern', '🌿', 'fern', 0, 1, 2, 3, 'moist', 'high', 'safe', 'Never let it dry out - not even once.', 'Crispy fronds mean it dried out: cut them off and keep the soil moist.', 'adiantum', 0],
    ['birdsnest', 'Bird’s nest fern', '🌿', 'fern', 0, 1, 2, 6, 'top', 'high', 'safe', 'Water the soil, not the centre of the rosette.', 'Brown, rotting new growth means water sat in the middle.', 'asplenium nidus', 0],
    ['staghorn', 'Staghorn fern', '🦌', 'fern', 1, 2, 2, 7, 'soak', 'high', 'safe', 'Mounted? Soak the whole mount in a sink for 15 minutes once a week, then drain.', 'Browning shields at the base are normal - do not peel them off.', 'platycerium', 0],
    ['asparagusfern', 'Asparagus fern', '🌿', 'fern', 1, 2, 2, 5, 'moist', 'medium', 'toxic', 'Not a true fern, and tougher than it looks.', 'A shower of yellow needles means it dried out.', 'asparagus setaceus plumosa', 0],
    ['hoya', 'Hoya', '🌸', 'trailing', 1, 2, 3, 10, 'most', 'medium', 'safe', 'Leave old flower stalks on - it blooms from them again.', 'Wrinkled leaves mean thirsty; soft yellow ones mean too much water.', 'wax plant carnosa kerrii', 1],
    ['heartleaf', 'Heartleaf philodendron', '🌿', 'trailing', 0, 1, 2, 7, 'top', 'medium', 'toxic', 'One of the most forgiving trailing plants there is.', 'Small, pale new leaves mean it wants more light.', 'philodendron hederaceum sweetheart', 0],
    ['philodendron', 'Philodendron', '🌿', 'foliage', 1, 2, 2, 7, 'top', 'medium', 'toxic', 'Turn it a quarter every week or two so it grows evenly.', 'Yellow older leaves usually mean too much water.', 'birkin brasil pink princess congo', 1],
    ['alocasia', 'Alocasia', '🐘', 'foliage', 1, 2, 2, 6, 'top', 'high', 'toxic', 'It may go dormant in winter - water less and wait; it comes back.', 'Drooping, yellowing leaves usually mean wet, cold roots.', 'elephant ear polly amazonica', 1],
    ['birdofparadise', 'Bird of paradise', '🐦', 'tree', 2, 3, 3, 8, 'top', 'medium', 'toxic', 'Split leaves are natural - in the wild the wind tears them.', 'Curling leaves mean thirsty or very dry air.', 'strelitzia nicolai reginae', 1],
    ['basil', 'Basil', '🌿', 'herb', 2, 3, 3, 2, 'moist', 'medium', 'safe', 'Pinch above a pair of leaves to keep it bushy, and nip off flowers.', 'Supermarket pots are crowded - split one into three or four and it lives for months.', 'sweet basil herb', 1],
    ['mint', 'Mint', '🌱', 'herb', 1, 2, 3, 3, 'moist', 'medium', 'toxic', 'It grows fast: cut it often and give it a bigger pot than you think.', 'Wilting in a sunny window means water more often, not less.', 'spearmint peppermint herb', 0],
    ['rosemary', 'Rosemary', '🌿', 'herb', 2, 3, 3, 7, 'most', 'low', 'safe', 'Likes it drier than other herbs, and all the sun you have.', 'Indoors it dies of wet roots more often than of thirst.', 'herb', 0],
    ['thyme', 'Thyme', '🌱', 'herb', 2, 3, 3, 7, 'most', 'low', 'safe', 'Trim it after it flowers to keep it compact.', 'Soggy soil turns it woody and grey.', 'herb', 0],
    ['parsley', 'Parsley', '🌿', 'herb', 1, 2, 3, 3, 'top', 'medium', 'toxic', 'Cut the outer stems first; it keeps growing from the middle.', 'Yellowing usually means the pot is too small or too wet.', 'herb', 0],
    ['chives', 'Chives', '🌱', 'herb', 1, 2, 3, 3, 'top', 'medium', 'toxic', 'Snip from the base and it regrows within weeks.', 'Floppy, pale leaves mean not enough light.', 'herb onion', 0],
    ['coriander', 'Coriander', '🌿', 'herb', 1, 2, 3, 3, 'top', 'medium', 'check', 'It bolts fast in heat - sow a new pot every few weeks.', 'Feathery new leaves mean it is going to seed; pick it now.', 'cilantro herb', 0],
    ['oregano', 'Oregano', '🌱', 'herb', 2, 3, 3, 5, 'most', 'low', 'toxic', 'Tastes stronger when it is kept on the dry side.', 'Wet roots and low light make it leggy and bland.', 'herb marjoram', 0],
    ['sage', 'Sage', '🌿', 'herb', 2, 3, 3, 7, 'most', 'low', 'check', 'Pinch the tips in spring to keep it from going woody.', 'Mildew on the leaves means too much water and too little air.', 'herb salvia', 0],
    ['lavender', 'Lavender', '🪻', 'flowering', 3, 3, 3, 10, 'most', 'low', 'toxic', 'It needs real sun - indoors it is best as a summer guest on the sunniest sill.', 'Grey, droopy lavender has usually been watered too often.', 'lavandula', 0],
    ['areca', 'Areca palm', '🌴', 'palm', 1, 2, 2, 7, 'top', 'medium', 'safe', 'Rinse the fronds in the shower now and then - it hates dust and spider mites.', 'Brown tips are usually dry air or tap water.', 'butterfly palm dypsis', 0],
    ['parlour', 'Parlour palm', '🌴', 'palm', 0, 1, 2, 8, 'top', 'medium', 'safe', 'A slow, patient palm that copes with a dim room.', 'Yellowing fronds usually mean too much water.', 'parlor chamaedorea neanthe bella', 0],
    ['kentia', 'Kentia palm', '🌴', 'palm', 0, 1, 2, 10, 'top', 'medium', 'safe', 'Grows one frond at a time; do not cut green ones.', 'Black tips mean overwatering; brown tips mean dry air.', 'howea', 0],
    ['ponytail', 'Ponytail palm', '🌴', 'succulent', 2, 3, 3, 14, 'dry', 'low', 'safe', 'Not really a palm: the swollen trunk is a water tank.', 'A soft trunk means rot - it wanted much less water.', 'beaucarnea elephant foot', 0],
    ['peperomia', 'Peperomia', '🪴', 'foliage', 1, 2, 2, 10, 'most', 'medium', 'safe', 'Fleshy leaves hold water - err on the dry side.', 'Droopy, soft leaves can mean too much water as well as too little - feel the soil.', 'radiator plant watermelon baby rubber', 0],
    ['pilea', 'Chinese money plant', '🪙', 'foliage', 1, 2, 2, 7, 'top', 'medium', 'check', 'Turn it every week or it leans towards the window.', 'Curling, domed leaves mean too much sun.', 'pilea peperomioides pancake ufo', 1],
    ['dracaena', 'Dracaena', '🌴', 'foliage', 0, 1, 2, 10, 'most', 'low', 'toxic', 'Copes with low light; grows faster with more.', 'Brown tips usually come from fluoride in tap water.', 'corn plant marginata dragon tree', 0],
    ['luckybamboo', 'Lucky bamboo', '🎋', 'foliage', 0, 1, 2, 7, 'soak', 'medium', 'toxic', 'In water: keep the roots covered and change the water every week.', 'Yellow stalks usually mean old water or too much sun.', 'dracaena sanderiana', 0],
    ['croton', 'Croton', '🍂', 'foliage', 2, 3, 3, 7, 'top', 'medium', 'toxic', 'Brighter light, brighter colours.', 'Dropping leaves after a move is normal sulking - give it a fortnight.', 'codiaeum', 0],
    ['dieffenbachia', 'Dumb cane', '🌿', 'foliage', 1, 1, 2, 8, 'top', 'medium', 'toxic', 'The sap irritates mouths and skin - wash your hands after pruning.', 'Yellow lower leaves usually mean too much water.', 'dieffenbachia', 0],
    ['englishivy', 'English ivy', '🍃', 'trailing', 1, 2, 2, 6, 'top', 'medium', 'toxic', 'Likes it cool; a warm, dry room invites spider mites.', 'Crispy leaves mean the air is too warm and dry.', 'hedera helix', 0],
    ['aglaonema', 'Chinese evergreen', '🌿', 'foliage', 0, 1, 2, 9, 'top', 'medium', 'toxic', 'Copes with shade; the pink and red kinds want more light.', 'Yellow, soft stems mean it sat wet and cold.', 'aglaonema', 0],
    ['anthurium', 'Anthurium', '🌺', 'flowering', 1, 2, 2, 7, 'top', 'high', 'toxic', 'Bright light with no direct sun keeps it flowering.', 'No new flowers usually means too little light.', 'flamingo flower laceleaf', 0],
    ['begonia', 'Begonia', '🌺', 'flowering', 1, 2, 2, 6, 'top', 'medium', 'toxic', 'Water the soil, not the leaves - wet leaves get mildew.', 'Powdery white leaves mean damp air with no breeze.', 'rex maculata polka dot', 0],
    ['castiron', 'Cast iron plant', '🛡️', 'foliage', 0, 0, 1, 12, 'most', 'low', 'safe', 'It lives in the dark corner nothing else will.', 'Bleached, pale patches mean too much sun.', 'aspidistra', 0],
    ['bromeliad', 'Bromeliad', '🌺', 'flowering', 1, 2, 2, 10, 'most', 'medium', 'safe', 'Keep a little water in the central cup and refresh it weekly.', 'It flowers once, then makes pups - the mother fading is normal.', 'guzmania vriesea pineapple', 0],
    ['airplant', 'Air plant', '🌬️', 'airplant', 1, 2, 2, 7, 'soak', 'medium', 'safe', 'Soak it for 20 minutes once a week, then shake it and dry it upside down.', 'Rot comes from water left in the base - always dry it upside down.', 'tillandsia', 0],
    ['africanviolet', 'African violet', '🪻', 'flowering', 1, 2, 2, 6, 'top', 'medium', 'safe', 'Water from below - cold water spots the leaves.', 'Rotting crowns come from water poured into the middle.', 'saintpaulia', 0],
    ['moneytree', 'Money tree', '🌳', 'tree', 1, 2, 2, 10, 'most', 'medium', 'safe', 'The braided trunks are several plants - they are happy sharing.', 'Yellow leaves that drop usually mean overwatering.', 'pachira aquatica braided', 0],
    ['umbrella', 'Umbrella plant', '☂️', 'tree', 1, 2, 2, 9, 'top', 'medium', 'toxic', 'Prune it to keep it bushy; it shrugs off a hard cut.', 'Leaves dropping all at once usually mean a cold draught.', 'schefflera arboricola', 0],
    ['arrowhead', 'Arrowhead plant', '🏹', 'foliage', 0, 1, 2, 7, 'top', 'medium', 'toxic', 'It climbs as it ages; pinch it if you want it compact.', 'Brown, crispy tips mean dry air.', 'syngonium', 0],
    ['tradescantia', 'Tradescantia', '💜', 'trailing', 1, 2, 2, 6, 'top', 'medium', 'toxic', 'Cuttings root in water in a week - easy to keep it full.', 'Bald, leggy stems mean too little light.', 'wandering dude inch plant zebrina', 0],
    ['fittonia', 'Nerve plant', '🍃', 'foliage', 0, 1, 1, 4, 'moist', 'high', 'safe', 'It faints when thirsty and revives within an hour - but do not make a habit of it.', 'Crispy leaves mean dry air; it loves a terrarium.', 'fittonia', 0],
    ['polkadot', 'Polka dot plant', '🌱', 'foliage', 1, 2, 2, 4, 'moist', 'medium', 'safe', 'Pinch it often or it gets leggy.', 'Fading spots mean it wants more light.', 'hypoestes freckle face', 0],
    ['kalanchoe', 'Kalanchoe', '🌼', 'succulent', 2, 3, 3, 12, 'dry', 'low', 'toxic', 'Short days in autumn bring it back into flower.', 'Soft stems mean too much water.', 'flaming katy', 0],
    ['flytrap', 'Venus flytrap', '🪤', 'carnivore', 3, 3, 3, 3, 'moist', 'high', 'safe', 'Rainwater or distilled water only, standing in a saucer - never fertiliser.', 'Setting the traps off for fun costs it energy; each trap only snaps a few times.', 'dionaea carnivorous', 0],
    ['lemon', 'Lemon tree', '🍋', 'tree', 3, 3, 3, 6, 'top', 'medium', 'toxic', 'Wants the sunniest spot you have, and a summer outdoors.', 'Dropping leaves in winter usually mean too little light, not too little water.', 'citrus calamondin meyer', 0],
    ['olive', 'Olive tree', '🫒', 'tree', 3, 3, 3, 9, 'most', 'low', 'safe', 'A cool winter helps it flower in spring.', 'Shedding leaves indoors usually means it wants more light.', 'olea europaea', 0],
    ['strawberry', 'Strawberry', '🍓', 'herb', 2, 3, 3, 2, 'top', 'medium', 'safe', 'Pick the runners off unless you want more plants.', 'Mouldy fruit means the soil and berries stay wet - water at the base.', 'fruit', 0],
    ['chilli', 'Chilli pepper', '🌶️', 'herb', 3, 3, 3, 3, 'top', 'medium', 'check', 'Tap the flowers gently to help them set fruit indoors.', 'Dropping flowers mean it got too dry or too cold.', 'pepper capsicum', 0],
    ['tomato', 'Tomato', '🍅', 'herb', 3, 3, 3, 2, 'top', 'medium', 'toxic', 'Steady watering stops split fruit; feed it once flowers appear.', 'Blossom-end rot (black bottoms) comes from uneven watering.', 'cherry tomato', 0],
    ['yucca', 'Yucca', '🌴', 'tree', 2, 3, 3, 14, 'dry', 'low', 'toxic', 'Tough as nails in a sunny room.', 'A soft trunk means rot from too much water.', 'spineless yucca', 0],
    ['poinsettia', 'Poinsettia', '🌺', 'flowering', 1, 2, 2, 7, 'top', 'medium', 'toxic', 'Keep it away from draughts; it is more irritating than dangerous, but keep it from pets.', 'Leaves dropping in a week often mean a cold trip home from the shop.', 'euphorbia christmas', 0],
    ['cyclamen', 'Cyclamen', '🌸', 'flowering', 1, 2, 2, 6, 'top', 'medium', 'toxic', 'It likes it cool; water from below, never into the crown.', 'Collapsing in a warm room is heat, not thirst.', 'cyclamen persicum', 0],
    ['calla', 'Calla lily', '🌷', 'flowering', 2, 2, 3, 5, 'top', 'medium', 'toxic', 'Let it rest dry for a couple of months after flowering.', 'Yellow leaves after blooming are it going to rest.', 'zantedeschia arum', 0],
    ['gerbera', 'Gerbera daisy', '🌼', 'flowering', 2, 3, 3, 5, 'top', 'medium', 'safe', 'Water the soil, not the crown, and deadhead to keep it flowering.', 'Crown rot comes from water left at the base of the leaves.', 'gerbera', 0],
    ['banana', 'Banana plant', '🍌', 'tree', 2, 3, 3, 4, 'top', 'high', 'safe', 'A thirsty, hungry grower - big leaves, big drinks in summer.', 'Torn leaves are normal; brown edges mean dry air.', 'musa', 0],
    ['coffee', 'Coffee plant', '☕', 'tree', 1, 2, 2, 6, 'top', 'high', 'check', 'Likes even moisture and a humid room; it can flower in a few years.', 'Brown leaf edges mean dry air or a dried-out pot.', 'coffea arabica', 0],
    ['oxalis', 'Purple shamrock', '☘️', 'flowering', 1, 2, 3, 6, 'top', 'medium', 'toxic', 'The leaves close at night and open in the morning.', 'If it dies back, it is resting - stop watering for a few weeks and it returns.', 'oxalis triangularis', 0],
    ['lithops', 'Living stones', '🪨', 'succulent', 3, 3, 3, 30, 'dry', 'low', 'check', 'Water only in spring and autumn - never while it is splitting into new leaves.', 'Water in summer or winter and it bursts or rots.', 'lithops pebble', 0],
    ['jasmine', 'Jasmine', '🌼', 'flowering', 2, 3, 3, 6, 'top', 'medium', 'check', 'A cool spell in autumn helps it set its winter flowers.', 'Dropping buds mean it got too warm or dry.', 'jasminum polyanthum', 0],
    ['hibiscus', 'Hibiscus', '🌺', 'flowering', 3, 3, 3, 4, 'top', 'medium', 'check', 'Each flower lasts a day - more come with sun and steady water.', 'Yellow leaves dropping usually mean watering on and off.', 'rosa sinensis', 0],
    ['geranium', 'Geranium', '🌸', 'flowering', 2, 3, 3, 7, 'most', 'low', 'toxic', 'Deadhead it and it flowers all summer on a sunny sill.', 'Yellow, soft lower leaves mean too much water.', 'pelargonium', 0],
  ];
  const CATALOGUE = ROWS.map((r) => ({
    id: r[0], name: r[1], emoji: r[2], group: r[3],
    light: { min: r[4], ideal: r[5], max: r[6] },
    water: r[7], soil: r[8], humidity: r[9], pets: r[10],
    tip: r[11], mistake: r[12], aka: r[13], popular: r[14] === 1,
  }));
  const BY_ID = Object.create(null);
  CATALOGUE.forEach((c) => { BY_ID[c.id] = c; });
  function catalogue(id) { return typeof id === 'string' && own(BY_ID, id) ? BY_ID[id] : null; }

  /** Type-ahead: names first, then words they are known by. */
  function search(q, limit) {
    const s = clean(q, 40).toLowerCase().replace(/[’']/g, '');
    if (!s) return CATALOGUE.filter((c) => c.popular).slice(0, limit || 24);
    const words = s.split(' ').filter(Boolean);
    const scored = [];
    for (const c of CATALOGUE) {
      const name = c.name.toLowerCase().replace(/[’']/g, '');
      const all = name + ' ' + c.aka + ' ' + c.group;
      if (!words.every((w) => all.indexOf(w) >= 0)) continue;
      let score = 0;
      if (name === s) score += 100;
      if (name.indexOf(s) === 0) score += 50;
      if (name.split(' ').some((w) => w.indexOf(words[0]) === 0)) score += 20;
      if (c.popular) score += 5;
      scored.push([score, c]);
    }
    return scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).map((x) => x[1]).slice(0, limit || 12);
  }

  // Nicknames. A few per plant (puns allowed), then a general list.
  const NICKS = {
    monstera: ['Bert', 'Monty', 'Cookie Monstera'], snake: ['Sir Hiss', 'Kaa', 'Slinky'], zz: ['Zed', 'Zsa Zsa', 'Ziggy'],
    peacelily: ['Lily', 'Zen', 'Peaches'], fiddle: ['Figgy', 'Fidel', 'Ficus Pocus'], spider: ['Spidey', 'Charlotte', 'Itsy'],
    calathea: ['Calvin', 'Drama Queen', 'Cal'], maranta: ['Amen', 'Mara'], cactus: ['Spike', 'Prickles', 'Cactus Jack'],
    aloe: ['Al', 'Aloe Blacc', 'Vera'], pothos: ['Polly', 'Potter', 'Pothos Malone'], basil: ['Basil Fawlty', 'Baz', 'Pesto'],
    mint: ['Minty', 'Mint Condition', 'Mojito'], phalaenopsis: ['Orla', 'Orchidea', 'Moth-ra'], bostonfern: ['Fernando', 'Fern Gully', 'Fernie'],
    maidenhair: ['Maisie', 'Diva'], rubber: ['Rubi', 'Bouncer', 'Duckie'], pearls: ['Pearl', 'Necklace', 'Pearl Jam'],
    hoya: ['Hoya Doin', 'Hoyt', 'Waxy'], philodendron: ['Phil', 'Philly', 'Dendron'], heartleaf: ['Sweetheart', 'Phil'],
    alocasia: ['Dumbo', 'Ellie', 'Ears'], birdofparadise: ['Tweety', 'Big Bird', 'Paradise'], pilea: ['Penny', 'Cash', 'Coin'],
    jade: ['Jade', 'Lucky', 'Jadeite'], echeveria: ['Echo', 'Rosie'], rosemary: ['Rosie', 'Rosemary Baby'], thyme: ['Father Thyme', 'Tim'],
    flytrap: ['Audrey', 'Snappy', 'Chompers'], lemon: ['Lemmy', 'Zest'], olive: ['Olive', 'Popeye'], tomato: ['Tom', 'Ketchup'],
    chilli: ['Chilli Willy', 'Hot Stuff'], strawberry: ['Shortcake', 'Berry'], lavender: ['Lavvy', 'Calm'], airplant: ['Floaty', 'Houdini'],
    stringhearts: ['Valentine'], hearts: ['Valentine', 'Romeo'], bananas: ['Chiquita'], castiron: ['Ironside', 'Tank'],
    luckybamboo: ['Lucky', 'Panda Snack'], lithops: ['Rocky', 'Pebbles'], umbrella: ['Ella', 'Brolly'], arrowhead: ['Robin Hood', 'Arrow'],
    tradescantia: ['Trad', 'Wanda'], fittonia: ['Fainting Fran', 'Nervy'], ponytail: ['Ponytail', 'Rapunzel'], kentia: ['Ken'],
    coffee: ['Espresso', 'Bean'], banana: ['Split', 'Bananarama'], croton: ['Disco', 'Croton'], begonia: ['Beggy', 'Bea'],
  };
  const GENERAL_NICKS = ['Leafy', 'Gus', 'Kevin', 'Planty McPlantface', 'Groot', 'Leif', 'Barbara', 'Morticia', 'Fernie Sanders', 'Sprout', 'Greta', 'Herb', 'Ivy', 'Sheila', 'Doug', 'Jeff', 'Shrubert', 'Leaf Erikson', 'Twiggy', 'Bud'];
  /** A fun nickname not already taken on this phone. `n` picks a different
   *  one each time it is asked again (the dice button). */
  function suggestNick(catId, taken, n) {
    const used = new Set((taken || []).map((s) => String(s).toLowerCase()));
    const list = ((catId && NICKS[catId]) || []).concat(GENERAL_NICKS);
    const free = list.filter((s) => !used.has(s.toLowerCase()));
    const pool = free.length ? free : list;
    return pool[Math.abs(Number(n) || 0) % pool.length];
  }

  /* ------------------------------------------------------------------ *
   * Rooms, pots, amounts
   * ------------------------------------------------------------------ */

  const ROOMS = [
    { id: 'living', label: 'Living room', emoji: '🛋️' },
    { id: 'bedroom', label: 'Bedroom', emoji: '🛏️' },
    { id: 'kitchen', label: 'Kitchen', emoji: '🍳' },
    { id: 'bathroom', label: 'Bathroom', emoji: '🛁' },
    { id: 'office', label: 'Office', emoji: '💻' },
    { id: 'hall', label: 'Hallway', emoji: '🚪' },
    { id: 'balcony', label: 'Balcony', emoji: '🌤️' },
    { id: 'other', label: 'Elsewhere', emoji: '🏠' },
  ];
  const ROOM_IDS = ROOMS.map((r) => r.id);
  const room = (id) => ROOMS.find((r) => r.id === id) || ROOMS[ROOMS.length - 1];
  const POTS = { s: 'Small (up to 12 cm)', m: 'Medium (13-20 cm)', l: 'Large (over 20 cm)' };
  const POT_IDS = Object.keys(POTS);

  /** How much water, in words a sitter can follow. */
  function amountFor(pot, drain, cat) {
    const g = cat ? cat.group : 'foliage';
    if (cat && cat.soil === 'soak') return 'No pouring - see how it drinks below.';
    const dryKind = g === 'succulent' || g === 'cactus';
    const base = { s: dryKind ? 'a few good splashes (about 100 ml)' : 'about half a glass (100-150 ml)', m: dryKind ? 'about a glass (250 ml)' : 'about two glasses (400-500 ml)', l: dryKind ? 'a small jug (about 500 ml)' : 'a jug (1-1.5 litres)' }[POT_IDS.indexOf(pot) >= 0 ? pot : 'm'];
    if (drain === false) return 'Gently, ' + base.replace(/^about /, 'less than ') + ' - no drainage hole, so it must never stand in water.';
    return 'Slowly, ' + base + ', until a little runs out of the bottom. Tip away what collects in the saucer.';
  }

  /* ------------------------------------------------------------------ *
   * Seasons: by hemisphere, guessed from the phone's time zone
   * ------------------------------------------------------------------ */

  const SOUTH_TZ = [
    /^Australia\//, /^Antarctica\//,
    /^Pacific\/(Auckland|Chatham|Fiji|Tongatapu|Noumea|Efate|Apia|Rarotonga|Tahiti|Norfolk|Port_Moresby|Guadalcanal|Pago_Pago|Niue|Fakaofo|Funafuti|Wallis|Marquesas|Gambier|Pitcairn|Easter)$/,
    /^America\/(Argentina\/.+|Buenos_Aires|Cordoba|Mendoza|Sao_Paulo|Santiago|Punta_Arenas|Montevideo|Asuncion|La_Paz|Lima|Cuiaba|Campo_Grande|Bahia|Recife|Fortaleza|Maceio|Belem|Manaus|Porto_Velho|Rio_Branco|Araguaina|Santarem|Noronha|Eirunepe)$/,
    /^Africa\/(Johannesburg|Maputo|Harare|Lusaka|Windhoek|Gaborone|Maseru|Mbabane|Blantyre|Lubumbashi|Luanda|Kinshasa|Dar_es_Salaam|Nairobi|Kigali|Bujumbura)$/,
    /^Indian\/(Mauritius|Reunion|Antananarivo|Mayotte|Comoro|Kerguelen|Chagos)$/,
    /^Asia\/(Jakarta|Makassar|Jayapura|Dili)$/,
    /^Atlantic\/(St_Helena|South_Georgia|Stanley)$/,
  ];
  const HEMIS = ['north', 'south', 'off'];
  function hemisphereOf(tz) {
    const z = cleanTz(tz);
    return SOUTH_TZ.some((re) => re.test(z)) ? 'south' : 'north';
  }
  /** The month as the northern hemisphere would feel it (1..12). */
  function feltMonth(date, hemi) {
    const m = Number(date.slice(5, 7));
    return hemi === 'south' ? ((m + 5) % 12) + 1 : m;
  }
  function seasonName(date, hemi) {
    if (hemi === 'off') return null;
    const m = feltMonth(date, hemi);
    return m === 12 || m <= 2 ? 'winter' : m <= 5 ? 'spring' : m <= 8 ? 'summer' : 'autumn';
  }
  /** How much longer between drinks at this time of year: 1 in summer, up
   *  to the group's winter factor in Dec-Feb (northern months), in steps. */
  function seasonFactor(group, date, hemi) {
    if (hemi === 'off' || !isDate(date)) return 1;
    const w = (GROUPS[group] || GROUPS.foliage).winter;
    const m = feltMonth(date, hemi);
    if (m === 12 || m === 1 || m === 2) return w;
    if (m === 11 || m === 3) return 1 + (w - 1) * 0.6;
    if (m === 10 || m === 4) return 1 + (w - 1) * 0.25;
    return 1;
  }

  /* ------------------------------------------------------------------ *
   * A plant
   * ------------------------------------------------------------------ */

  // How far the learned interval may move from the catalogue's: it can
  // learn that your bathroom fern drinks more or your snake plant less, but
  // it can never learn its way to "water the cactus daily".
  const LEARN = { min: 0.6, max: 1.8, floor: 1, ceil: 90 };
  const EVENT_KINDS = ['water', 'notyet', 'fine', 'mist', 'fert', 'snooze', 'repot', 'move', 'note'];
  const CUSTOM_PACE = { thirsty: 4, average: 7, tough: 14 };

  function baseDays(p) { const c = catalogue(p.cat); return c ? c.water : (p.custom && p.custom.water) || 7; }
  function groupOf(p) { const c = catalogue(p.cat); return c ? c.group : 'foliage'; }
  function bounds(p) {
    const b = baseDays(p);
    return { lo: Math.max(LEARN.floor, b * LEARN.min), hi: Math.min(LEARN.ceil, b * LEARN.max) };
  }
  function clampInterval(p, v) {
    const { lo, hi } = bounds(p);
    const n = Number(v);
    if (!isFinite(n)) return baseDays(p);
    return Math.round(Math.min(hi, Math.max(lo, n)) * 100) / 100;
  }
  /** The interval this plant has learned (before the season). */
  function learned(p) { return clampInterval(p, p.interval == null ? baseDays(p) : p.interval); }
  /** Days between drinks, from `date`, at that time of year. */
  function effective(p, date, hemi) {
    return Math.max(1, Math.min(120, Math.round(learned(p) * seasonFactor(groupOf(p), date, hemi))));
  }
  /** One step of learning: about an eighth of the catalogue's interval. */
  function step(p) { return Math.max(0.5, baseDays(p) * 0.12); }
  function plantName(p) { const c = catalogue(p.cat); return c ? c.name : (p.custom && p.custom.name) || 'Plant'; }
  function plantEmoji(p) { const c = catalogue(p.cat); return c ? c.emoji : (p.custom && p.custom.emoji) || '🪴'; }
  /** "Bert the monstera", or just "Bert" when the nickname is the name. */
  function called(p) {
    const n = plantName(p);
    if (!p.nick || p.nick.toLowerCase() === n.toLowerCase()) return n;
    return p.nick + ' the ' + (/^[A-Z]{2}/.test(n) ? n : n.charAt(0).toLowerCase() + n.slice(1));
  }

  function waters(p) { return (p.events || []).filter((e) => e.k === 'water'); }
  function lastOf(p, kind) { const e = (p.events || []).filter((x) => x.k === kind); return e.length ? e[e.length - 1] : null; }

  /** When this plant next wants looking at, and why:
   *  why = water (a regular drink) | check (after "Not yet", or history
   *  unknown: feel the soil) | snooze (put off a day). */
  function dueOf(p, today, hemi) {
    const lw = lastOf(p, 'water');
    let due; let why;
    if (!lw) { due = p.added && isDate(p.added) ? p.added : today; why = 'check'; } else { due = addDays(lw.d, effective(p, lw.d, hemi)); why = 'water'; }
    if (p.hold && isDate(p.hold.d) && p.hold.d > due) { due = p.hold.d; why = p.hold.why === 'snooze' ? 'snooze' : 'check'; }
    return { due, days: daysBetween(today, due), why, last: lw ? lw.d : null };
  }

  const BANDS = [
    { id: 'thirsty', label: 'Thirsty today', icon: '💧' },
    { id: 'check', label: 'Check soil', icon: '👆' },
    { id: 'soon', label: 'Coming up', icon: '🗓️' },
    { id: 'happy', label: 'Happy', icon: '😌' },
  ];
  /** Which band a plant sits in today. Never by colour alone: each band has
   *  its words and an icon. */
  function bandOf(p, today, hemi) {
    const d = dueOf(p, today, hemi);
    if (d.last === today) return 'happy';
    if (d.days <= 0) return d.why === 'check' ? 'check' : 'thirsty';
    if (d.days === 1) return 'check';
    if (d.days <= 3) return 'soon';
    return 'happy';
  }

  /** Everything a card needs, worked out once. */
  function status(p, today, hemi) {
    const d = dueOf(p, today, hemi);
    const band = bandOf(p, today, hemi);
    const eff = effective(p, d.last || today, hemi);
    const flags = [];
    const ws = waters(p).filter((e) => !e.est);
    if (ws.length >= 2) {
      const a = ws[ws.length - 2].d; const b = ws[ws.length - 1].d;
      const gap = daysBetween(a, b);
      if (gap < Math.max(2, eff * 0.4) && daysBetween(b, today) < eff) flags.push({ k: 'overwatered', text: 'Watered twice in ' + plural(Math.max(1, gap), 'day') + ' - let it dry out before the next drink.' });
    }
    const rp = lastOf(p, 'repot');
    const repotAgo = rp ? daysBetween(rp.d, today) : null;
    if (rp && repotAgo >= 0 && repotAgo <= 14) flags.push({ k: 'repotted', text: 'Repotted ' + (repotAgo === 0 ? 'today' : whenLabel(rp.d, today)) + ' - water lightly while the roots settle, and no feed for a month.' });
    const feed = feedDue(p, today, hemi);
    if (feed) flags.push({ k: 'feed', text: 'Feed due - it’s growing season. Half-strength houseplant feed with its next drink.' });
    const lw = lightWarning(catalogue(p.cat), p.light, p.nick);
    if (lw) flags.push({ k: 'light', text: lw.text });
    let chip;
    if (band === 'thirsty') chip = d.days < 0 ? plural(-d.days, 'day') + ' late' : 'Today';
    else if (band === 'check') chip = d.days <= 0 ? 'Feel the soil' : 'Tomorrow';
    else if (band === 'soon') chip = 'In ' + plural(d.days, 'day');
    else chip = d.last === today ? 'Watered today' : 'Next ' + whenLabel(d.due, today);
    return { band, due: d.due, days: d.days, why: d.why, last: d.last, every: eff, chip, flags, streak: streakOf(p, today, hemi) };
  }

  /** Feed due: growing season (not winter), the group is fed at all, not
   *  repotted in the last month, and it has been long enough. */
  function feedDue(p, today, hemi) {
    const g = GROUPS[groupOf(p)] || GROUPS.foliage;
    if (!g.fert) return false;
    const s = seasonName(today, hemi);
    if (s === 'winter' || (s === 'autumn' && feltMonth(today, hemi) === 11)) return false;
    const rp = lastOf(p, 'repot');
    if (rp && daysBetween(rp.d, today) < 30) return false;
    const f = lastOf(p, 'fert');
    const from = f ? f.d : p.added;
    return isDate(from) && daysBetween(from, today) >= g.fert;
  }

  /** On-time care: the drinks given no more than a day after they were
   *  due, counted back from the latest. "Not yet" never breaks a streak -
   *  checking the soil IS on-time care. `atRisk` when it is late right now. */
  function streakOf(p, today, hemi) {
    const ws = waters(p).filter((e) => !e.est);
    let current = 0;
    for (let i = ws.length - 1; i >= 0; i--) { if ((ws[i].late || 0) <= 1) current++; else break; }
    let best = 0; let run = 0;
    for (const w of ws) { run = (w.late || 0) <= 1 ? run + 1 : 0; best = Math.max(best, run); }
    const d = dueOf(p, today, hemi);
    return { current, best, atRisk: d.why === 'water' && d.days < -1 };
  }

  /** "Bert drinks every 9 days here, not 7." once it has learned something. */
  function learnedLine(p, today, hemi) {
    const base = baseDays(p);
    const l = Math.round(learned(p));
    const taught = (p.events || []).some((e) => e.k === 'notyet' || e.k === 'fine');
    const name = p.nick || plantName(p);
    const eff = effective(p, today, hemi);
    const season = seasonName(today, hemi);
    const seasonal = eff !== l && season ? ' In ' + season + ' that stretches to about ' + plural(eff, 'day') + '.' : '';
    if (taught && l !== base) return name + ' drinks every ' + plural(l, 'day') + ' here, not ' + base + '.' + seasonal;
    if (taught) return name + ' is right on the usual ' + plural(base, 'day') + ' here.' + seasonal;
    return 'Every ' + plural(base, 'day') + ', the usual for ' + (catalogue(p.cat) ? 'a ' + plantName(p).toLowerCase().replace(/^zz/, 'ZZ') : 'this plant') + '. Tap “Not yet” when the soil is still damp and Sprout learns ' + name + '’s own pace.' + seasonal;
  }

  /** The spot's light against what the plant wants. */
  function lightWarning(cat, spot, nick) {
    if (!cat || !Number.isInteger(spot) || spot < 0 || spot > 3) return null;
    const lower = cat.name.charAt(0).toLowerCase() + cat.name.slice(1);
    const a = /^[aeiou]/i.test(cat.name) ? 'An ' : 'A ';
    const who = a + (/^[A-Z]{2}/.test(cat.name) ? cat.name : lower);
    if (spot > cat.light.max) {
      if (spot === 3) {
        const crisp = cat.humidity === 'high' || cat.group === 'fern' || cat.soil === 'moist';
        return { level: 'bright', text: who + ' in direct sun will ' + (crisp ? 'crisp' : 'scorch') + ' - try a few metres back from the window, or behind a sheer curtain.' };
      }
      return { level: 'bright', text: who + ' prefers it shadier - bright light can bleach its leaves. Somewhere dimmer would suit it.' };
    }
    if (spot < cat.light.min) {
      if (cat.group === 'succulent' || cat.group === 'cactus' || cat.light.min === 3) return { level: 'dark', text: who + ' in ' + (spot === 0 ? 'low light' : 'that light') + ' will stretch and go pale - it wants your sunniest window.' };
      return { level: 'dark', text: who + ' will survive there but barely grow - a brighter spot nearer a window would suit it.' };
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * The one door for a plant
   * ------------------------------------------------------------------ */

  function cleanEvent(raw, ctx) {
    if (!raw || typeof raw !== 'object') return null;
    const k = EVENT_KINDS.indexOf(raw.k) >= 0 ? raw.k : null;
    if (!k || !isDate(raw.d)) return null;
    if (ctx && ctx.today && raw.d > addDays(ctx.today, 1)) return null;
    const e = { id: isEventId(raw.id) ? raw.id : newId('e', ctx && ctx.rand), k, d: raw.d };
    if (k === 'water') {
      if (raw.est === true) e.est = true;
      const late = Number(raw.late);
      if (Number.isInteger(late) && late > 0 && late < 1000) e.late = late;
    }
    if (k === 'note' || k === 'fine' || k === 'repot' || k === 'move') {
      const n = clean(raw.note, LIMITS.note);
      if (n) e.note = n;
      else if (k === 'note') return null;
    }
    if (raw.prev && typeof raw.prev === 'object') {
      const pr = {};
      if (raw.prev.interval === null || (typeof raw.prev.interval === 'number' && isFinite(raw.prev.interval))) pr.interval = raw.prev.interval;
      if (own(raw.prev, 'hold')) pr.hold = cleanHold(raw.prev.hold);
      if (ROOM_IDS.indexOf(raw.prev.room) >= 0) pr.room = raw.prev.room;
      if (Number.isInteger(raw.prev.light) && raw.prev.light >= 0 && raw.prev.light <= 3) pr.light = raw.prev.light;
      if (POT_IDS.indexOf(raw.prev.pot) >= 0) pr.pot = raw.prev.pot;
      if (Object.keys(pr).length) e.prev = pr;
    }
    return e;
  }
  function cleanHold(h) {
    if (!h || typeof h !== 'object' || !isDate(h.d)) return null;
    return { d: h.d, why: h.why === 'snooze' ? 'snooze' : 'check' };
  }

  /** Every plant comes through here: typed, imported, the example's, or one
   *  the AI recognised. Unknown fields are dropped; a bad field becomes the
   *  default rather than an error, except a plant with no name at all. */
  function cleanPlant(raw, ctx) {
    if (!raw || typeof raw !== 'object') return null;
    const today = ctx && ctx.today;
    const cat = catalogue(raw.cat) ? raw.cat : null;
    const p = { id: isPlantId(raw.id) ? raw.id : newId('p', ctx && ctx.rand), cat };
    if (!cat) {
      const c = raw.custom && typeof raw.custom === 'object' ? raw.custom : {};
      const name = cleanText(c.name, 40);
      if (!name) return null;
      const water = Number.isInteger(c.water) && c.water >= 1 && c.water <= 60 ? c.water : 7;
      p.custom = { name, emoji: cleanEmoji(c.emoji) || '🪴', water };
    }
    p.nick = cleanText(raw.nick, LIMITS.nick) || plantName(p);
    p.room = ROOM_IDS.indexOf(raw.room) >= 0 ? raw.room : 'other';
    p.light = Number.isInteger(raw.light) && raw.light >= 0 && raw.light <= 3 ? raw.light : (catalogue(cat) ? catalogue(cat).light.ideal : 1);
    p.pot = POT_IDS.indexOf(raw.pot) >= 0 ? raw.pot : 'm';
    p.drain = raw.drain !== false;
    p.added = isDate(raw.added) && (!today || raw.added <= today) ? raw.added : (today || '2026-01-01');
    if (typeof raw.interval === 'number' && isFinite(raw.interval)) p.interval = clampInterval(p, raw.interval);
    const hold = cleanHold(raw.hold);
    if (hold) p.hold = hold;
    const evs = Array.isArray(raw.events) ? raw.events.slice(-LIMITS.events * 2) : [];
    const seen = new Set();
    p.events = evs.map((e) => cleanEvent(e, ctx)).filter((e) => e && !seen.has(e.id) && seen.add(e.id))
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)).slice(-LIMITS.events);
    return p;
  }

  /* ------------------------------------------------------------------ *
   * The actions: each returns {plant, event, msg} and never changes its
   * argument. Undo puts back what the event's `prev` recorded.
   * ------------------------------------------------------------------ */

  function copy(p) { return JSON.parse(JSON.stringify(p)); }
  function push(p, ev) {
    p.events.push(ev);
    if (p.events.length > LIMITS.events) p.events = p.events.slice(-LIMITS.events);
    return ev;
  }
  const nameOf = (p) => p.nick || plantName(p);

  function act(plant, kind, ctx, opts) {
    const o = opts || {};
    const today = ctx.today; const hemi = ctx.hemi;
    const p = copy(plant);
    const ev = { id: newId('e', ctx.rand), k: kind, d: today };
    const before = dueOf(plant, today, hemi);
    let msg = '';
    if (kind === 'water') {
      ev.prev = { interval: plant.interval == null ? null : plant.interval, hold: plant.hold || null };
      if (before.why === 'water' && before.days < 0) ev.late = -before.days;
      delete p.hold;
      push(p, ev);
      const next = addDays(today, effective(p, today, hemi));
      msg = 'Watered ' + nameOf(p) + (ev.late ? ' - ' + plural(ev.late, 'day') + ' late' : '') + '. Next drink ' + whenLabel(next, today) + '.';
    } else if (kind === 'notyet') {
      // The soil was still wet: it can go longer. Learn a step, and look
      // again in a fifth of an interval (at least a day).
      ev.prev = { interval: plant.interval == null ? null : plant.interval, hold: plant.hold || null };
      p.interval = clampInterval(p, learned(p) + step(p));
      const push2 = Math.max(1, Math.round(effective(p, today, hemi) * 0.2));
      p.hold = { d: addDays(today, push2), why: 'check' };
      push(p, ev);
      const capped = p.interval === bounds(p).hi;
      msg = 'Got it - ' + nameOf(p) + ' can go longer. Check again ' + whenLabel(p.hold.d, today) + '. ' + (capped ? 'That’s as long as Sprout will stretch it.' : 'Learning: about every ' + plural(Math.round(learned(p)), 'day') + ' now.');
    } else if (kind === 'fine') {
      // Watered late and it was fine: it can go a little longer - half a
      // step, and only after a drink that really was late.
      const lw = lastOf(plant, 'water');
      if (!lw || !lw.late || lw.late < 1) throw Object.assign(new Error('Only after a late drink.'), { status: 400, expose: true });
      ev.prev = { interval: plant.interval == null ? null : plant.interval };
      ev.note = 'Fine after ' + plural(lw.late, 'extra day');
      p.interval = clampInterval(p, learned(p) + Math.min(step(p), lw.late) * 0.5);
      push(p, ev);
      msg = 'Noted - ' + nameOf(p) + ' can wait a little longer between drinks.';
    } else if (kind === 'mist') {
      push(p, ev); msg = 'Misted ' + nameOf(p) + '.';
    } else if (kind === 'fert') {
      push(p, ev); msg = 'Fed ' + nameOf(p) + '. Next feed in about ' + plural((GROUPS[groupOf(p)] || GROUPS.foliage).fert || 30, 'day') + '.';
    } else if (kind === 'snooze') {
      ev.prev = { hold: plant.hold || null };
      p.hold = { d: addDays(today, 1), why: 'snooze' };
      push(p, ev); msg = nameOf(p) + ' will ask again tomorrow.';
    } else if (kind === 'repot') {
      ev.prev = { pot: plant.pot };
      if (POT_IDS.indexOf(o.pot) >= 0) p.pot = o.pot;
      const n = clean(o.note, LIMITS.note); if (n) ev.note = n;
      push(p, ev); msg = 'Repotted ' + nameOf(p) + '. Water lightly for a couple of weeks while it settles.';
    } else if (kind === 'move') {
      ev.prev = { room: plant.room, light: plant.light };
      if (ROOM_IDS.indexOf(o.room) >= 0) p.room = o.room;
      if (Number.isInteger(o.light) && o.light >= 0 && o.light <= 3) p.light = o.light;
      ev.note = room(p.room).label + ', ' + LIGHTS[p.light].label.toLowerCase();
      push(p, ev); msg = nameOf(p) + ' moved to the ' + room(p.room).label.toLowerCase() + '.';
    } else if (kind === 'note') {
      const n = clean(o.note, LIMITS.note);
      if (!n) throw Object.assign(new Error('Write something first.'), { status: 400, expose: true });
      ev.note = n; push(p, ev); msg = 'Note added.';
    } else {
      throw Object.assign(new Error('Unknown action.'), { status: 400, expose: true });
    }
    return { plant: p, event: ev, msg };
  }

  /** Undo the plant's most recent event: it goes, and whatever it changed
   *  comes back. Only the latest - undoing an older one would overwrite
   *  what happened since. */
  function undo(plant, eventId) {
    const last = plant.events[plant.events.length - 1];
    if (!last || last.id !== eventId) throw Object.assign(new Error('Only the latest change can be undone.'), { status: 409, expose: true });
    const p = copy(plant);
    p.events.pop();
    const pr = last.prev || {};
    if (own(pr, 'interval')) { if (pr.interval === null) delete p.interval; else p.interval = pr.interval; }
    if (own(pr, 'hold')) { if (pr.hold) p.hold = pr.hold; else delete p.hold; }
    if (own(pr, 'room')) p.room = pr.room;
    if (own(pr, 'light')) p.light = pr.light;
    if (own(pr, 'pot')) p.pot = pr.pot;
    return p;
  }

  /** A new plant from the add form. lastWatered: today | few | week | unknown. */
  function newPlant(form, ctx) {
    const f = form || {};
    const raw = { cat: f.cat, custom: f.custom, nick: f.nick, room: f.room, light: f.light, pot: f.pot, drain: f.drain, added: ctx.today, events: [] };
    const ago = { today: 0, few: 3, week: 8 }[f.lastWatered];
    if (ago !== undefined) raw.events.push({ k: 'water', d: addDays(ctx.today, -ago), est: ago > 0 });
    return cleanPlant(raw, ctx);
  }

  /* ------------------------------------------------------------------ *
   * The board and the headline
   * ------------------------------------------------------------------ */

  /** Plants into the four bands, most urgent first in each. */
  function board(plants, today, hemi) {
    const out = { thirsty: [], check: [], soon: [], happy: [] };
    for (const p of plants) {
      const s = status(p, today, hemi);
      out[s.band].push({ plant: p, s });
    }
    const byDue = (a, b) => a.s.days - b.s.days || a.s.every - b.s.every || nameOf(a.plant).localeCompare(nameOf(b.plant));
    Object.keys(out).forEach((k) => out[k].sort(byDue));
    return out;
  }
  function headline(plants, today, hemi) {
    if (!plants.length) return 'No plants yet - add your first and Sprout will keep track.';
    const b = board(plants, today, hemi);
    if (b.thirsty.length === 1) return called(b.thirsty[0].plant) + ' wants water today.';
    if (b.thirsty.length) return b.thirsty.length + ' plants want water today - ' + called(b.thirsty[0].plant) + ' first.';
    if (b.check.length === 1) return 'Nothing is thirsty. Feel ' + nameOf(b.check[0].plant) + '’s soil - it may be ready.';
    if (b.check.length) return 'Nothing is thirsty. Feel the soil of ' + b.check.length + ' plants - ' + nameOf(b.check[0].plant) + ' first.';
    const next = b.soon[0] || b.happy.slice().sort((x, y) => x.s.days - y.s.days)[0];
    return 'Everyone’s happy. Next drink: ' + nameOf(next.plant) + ', ' + whenLabel(next.s.due, today) + '.';
  }

  /* ------------------------------------------------------------------ *
   * The future: the next few weeks of drinks, assuming each is given on
   * its day. Used by the sitter plan and the calendar.
   * ------------------------------------------------------------------ */

  /** Dates in [from, to] this plant is due, starting from its next due
   *  (anything overdue counts as due on `from`). */
  function projectWaterings(p, from, to, hemi, startFrom) {
    const out = [];
    let d = startFrom || dueOf(p, from, hemi).due;
    if (d < from) d = from;
    let guard = 0;
    while (d <= to && guard++ < 400) { out.push(d); d = addDays(d, effective(p, d, hemi)); }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * The plant-sitter link
   * ------------------------------------------------------------------ */

  /** The care plan for a trip: who to water before you go, and every day's
   *  list while you are away. Pure; the page packs `sit` into the link. */
  function sitPlan(plants, opts) {
    const o = opts || {};
    const today = o.today; const hemi = o.hemi;
    let start = isDate(o.start) ? o.start : addDays(today, 1);
    if (start < today) start = today;
    let end = isDate(o.end) && o.end >= start ? o.end : addDays(start, 6);
    let cut = false;
    if (daysBetween(start, end) > LIMITS.sitDays - 1) { end = addDays(start, LIMITS.sitDays - 1); cut = true; }
    const span = daysBetween(start, end);
    const before = []; const entries = [];
    const sorted = plants.slice().sort((a, b) => ROOM_IDS.indexOf(a.room) - ROOM_IDS.indexOf(b.room) || nameOf(a).localeCompare(nameOf(b)));
    for (const p of sorted.slice(0, LIMITS.sitPlants)) {
      // Every drink from today to the end of the trip, as if each is given
      // on its day: the ones before the trip are yours, the rest the
      // sitter's. Anything overdue counts as due today.
      const all = projectWaterings(p, today, end, hemi);
      const mine = all.filter((x) => x < start);
      const theirs = all.filter((x) => x >= start);
      if (mine.length) before.push({ plant: p, dates: mine });
      const c = catalogue(p.cat);
      entries.push([
        nameOf(p), p.cat || '', p.room, p.pot, p.drain ? 1 : 0,
        theirs.map((x) => daysBetween(start, x)),
        c && c.humidity === 'high' ? 1 : 0,
        '',
      ]);
    }
    const sit = { v: 1, s: start, e: end, p: entries };
    const from = cleanText(o.from, LIMITS.sitFrom); if (from) sit.f = from;
    const note = clean(o.note, LIMITS.sitHomeNote); if (note) sit.t = note;
    return { sit, before, start, end, span, cut, left: Math.max(0, plants.length - LIMITS.sitPlants) };
  }

  /** The decoded link, cleaned field by field - the same rules whether it
   *  came from this phone or from anyone. null when it is not a plan. */
  function cleanSit(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return null;
    if (!isDate(raw.s) || !isDate(raw.e) || raw.e < raw.s) return null;
    const span = daysBetween(raw.s, raw.e);
    if (span > LIMITS.sitDays - 1) return null;
    if (!Array.isArray(raw.p) || !raw.p.length) return null;
    const plants = [];
    for (const r of raw.p.slice(0, LIMITS.sitPlants)) {
      if (!Array.isArray(r)) continue;
      const nick = cleanText(r[0], LIMITS.nick);
      if (!nick) continue;
      const cat = catalogue(r[1]) ? r[1] : null;
      const days = Array.isArray(r[5]) ? r[5].filter((n) => Number.isInteger(n) && n >= 0 && n <= span) : [];
      plants.push({
        nick, cat,
        room: ROOM_IDS.indexOf(r[2]) >= 0 ? r[2] : 'other',
        pot: POT_IDS.indexOf(r[3]) >= 0 ? r[3] : 'm',
        drain: r[4] !== 0,
        days: [...new Set(days)].sort((a, b) => a - b).slice(0, LIMITS.sitDays),
        mist: r[6] === 1,
        note: clean(r[7], LIMITS.sitNote),
      });
    }
    if (!plants.length) return null;
    return { v: 1, start: raw.s, end: raw.e, span, from: cleanText(raw.f, LIMITS.sitFrom), note: clean(raw.t, LIMITS.sitHomeNote), plants };
  }

  /** The sitter's view of a clean plan: a list per day, and the plants to
   *  leave alone. */
  function sitDays(sit) {
    const days = [];
    for (let i = 0; i <= sit.span; i++) {
      days.push({ i, date: addDays(sit.start, i), plants: sit.plants.map((p, j) => ({ p, j })).filter((x) => x.p.days.indexOf(i) >= 0) });
    }
    return { days, leave: sit.plants.map((p, j) => ({ p, j })).filter((x) => !x.p.days.length) };
  }

  /** The "done" message the sitter sends back through their share sheet. */
  function sitSummary(sit, ticks, today) {
    const t = ticks || {};
    const { days } = sitDays(sit);
    const upTo = days.filter((d) => d.date <= today);
    const done = []; const missed = [];
    upTo.forEach((d) => d.plants.forEach((x) => { (t[x.j + ':' + d.i] ? done : missed).push({ name: x.p.nick, date: d.date }); }));
    const todayRow = days.find((d) => d.date === today);
    const todayDone = todayRow ? todayRow.plants.filter((x) => t[x.j + ':' + todayRow.i]).map((x) => x.p.nick) : [];
    const lines = ['🌿 Plant update (' + dateLabel(today, today) + ')'];
    if (todayRow && todayRow.plants.length) lines.push(todayDone.length ? 'Watered today: ' + nameList(todayDone) + '.' : 'Nothing ticked off today yet.');
    else if (todayRow) lines.push('No watering needed today.');
    lines.push(missed.length ? 'Not ticked yet: ' + nameList([...new Set(missed.map((m) => m.name))]) + '.' : (upTo.length ? 'Everything due so far is done. ✅' : 'The plan starts ' + dateLabel(sit.start, today) + '.'));
    lines.push(plural(done.length, 'drink') + ' given so far.');
    return lines.join('\n');
  }

  // base64url, for bytes. btoa/atob exist in browsers and in Node 16+.
  function b64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64url(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
    try {
      const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) { return null; }
  }
  const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function' && typeof Blob === 'function' && typeof Response === 'function';

  /** Read a stream into bytes, refusing more than `max` (a deflate bomb). */
  async function readCapped(stream, max) {
    const reader = stream.getReader();
    const parts = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) { try { await reader.cancel(); } catch (e) { /* ignore */ } throw new Error('too big'); }
      parts.push(value);
    }
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  /** The plan -> the part after '#': 'v1.z.<deflate, base64url>' when the
   *  browser can compress, else 'v1.p.<utf-8 JSON, base64url>'. */
  async function encodeSit(sit, opts) {
    const json = JSON.stringify(sit);
    const bytes = new TextEncoder().encode(json);
    const plain = (opts && opts.plain) || !canCompress();
    if (plain) return 'v1.p.' + b64url(bytes);
    const z = await readCapped(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')), LIMITS.inflated * 4);
    return 'v1.z.' + b64url(z);
  }
  /** '#…' or '…' -> a clean plan, or null for anything else: wrong
   *  version, bad characters, too long, not deflate, a bomb, not JSON, not a
   *  plan. Never throws. */
  async function decodeSit(fragment) {
    try {
      let s = typeof fragment === 'string' ? fragment : '';
      if (s.charAt(0) === '#') s = s.slice(1);
      if (!s || s.length > LIMITS.fragment) return null;
      const m = /^v1\.([zp])\.([A-Za-z0-9_-]+)$/.exec(s);
      if (!m) return null;
      const bytes = unb64url(m[2]);
      if (!bytes || !bytes.length) return null;
      let data;
      if (m[1] === 'z') {
        if (!canCompress()) return null;
        data = await readCapped(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')), LIMITS.inflated);
      } else {
        if (bytes.length > LIMITS.inflated) return null;
        data = bytes;
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      return cleanSit(JSON.parse(text));
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ *
   * The calendar: one all-day event per watering day, next four weeks
   * ------------------------------------------------------------------ */

  function icsText(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  /** Fold at 75 octets, never inside a UTF-8 character (RFC 5545 3.1). */
  function fold(line) {
    const enc = new TextEncoder();
    const out = []; let cur = ''; let n = 0; let limit = 75;
    for (const ch of Array.from(line)) {
      const b = enc.encode(ch).length;
      if (n + b > limit) { out.push(cur); cur = ' '; n = 1; limit = 75; }
      cur += ch; n += b;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  function icsFor(plants, opts) {
    const o = opts || {};
    const today = o.today; const hemi = o.hemi;
    const to = addDays(today, (o.days || LIMITS.icsDays) - 1);
    const byDay = {};
    for (const p of plants) for (const d of projectWaterings(p, today, to, hemi)) (byDay[d] = byDay[d] || []).push(p);
    const stamp = new Date(o.now || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sprout//Watering days//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Sprout watering'];
    for (const d of Object.keys(byDay).sort()) {
      const ps = byDay[d].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      const names = ps.map(nameOf);
      const summary = '💧 Water ' + (names.length > 4 ? names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more' : nameList(names));
      const desc = ps.map((p) => { const c = catalogue(p.cat); return plantEmoji(p) + ' ' + nameOf(p) + ' (' + room(p.room).label + '): ' + (c ? SOIL[c.soil].check : 'Feel the soil first.'); }).join('\n') + '\n\nFrom Sprout - feel the soil first; skip any that are still damp.';
      const ymd = d.replace(/-/g, '');
      lines.push('BEGIN:VEVENT', 'UID:sprout-' + ymd + '-' + hash32(names.join('|')).toString(36) + '@sprout.local', 'DTSTAMP:' + stamp,
        'DTSTART;VALUE=DATE:' + ymd, 'DTEND;VALUE=DATE:' + addDays(d, 1).replace(/-/g, ''), 'SUMMARY:' + icsText(summary),
        'DESCRIPTION:' + icsText(desc), 'TRANSP:TRANSPARENT', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return { text: lines.map(fold).join('\r\n') + '\r\n', days: Object.keys(byDay).length };
  }

  /* ------------------------------------------------------------------ *
   * Export / import: a file for moving phones
   * ------------------------------------------------------------------ */

  function cleanSettings(raw, tz) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const auto = s.hemiAuto !== false;
    return { hemi: auto ? hemisphereOf(tz) : (HEMIS.indexOf(s.hemi) >= 0 ? s.hemi : hemisphereOf(tz)), hemiAuto: auto, name: cleanText(s.name, LIMITS.sitFrom) };
  }
  function exportHome(home, now) {
    return JSON.stringify({ app: 'sprout', v: 1, exportedAt: new Date(now || Date.now()).toISOString(), settings: home.settings, plants: home.plants }, null, 1);
  }
  /** A file someone picked -> a clean home, or an Error with a sentence.
   *  Every plant goes through cleanPlant; ids are made unique. */
  function importHome(text, ctx) {
    if (typeof text !== 'string' || text.length > LIMITS.importBytes) throw Object.assign(new Error('That file is too big to be a Sprout export.'), { expose: true });
    let raw;
    try { raw = JSON.parse(text); } catch (e) { throw Object.assign(new Error('That file isn’t a Sprout export (it isn’t JSON).'), { expose: true }); }
    if (!raw || typeof raw !== 'object' || raw.app !== 'sprout' || raw.v !== 1 || !Array.isArray(raw.plants)) throw Object.assign(new Error('That file isn’t a Sprout export.'), { expose: true });
    const ids = new Set();
    const plants = [];
    let dropped = 0;
    for (const r of raw.plants.slice(0, LIMITS.plants * 4)) {
      if (plants.length >= LIMITS.plants) break;
      const p = cleanPlant(r, ctx);
      if (!p) { dropped++; continue; }
      if (ids.has(p.id)) p.id = newId('p', ctx.rand);
      ids.add(p.id);
      plants.push(p);
    }
    return { settings: cleanSettings(raw.settings, ctx.tz), plants, dropped, over: Math.max(0, raw.plants.length - plants.length - dropped) };
  }

  /* ------------------------------------------------------------------ *
   * The one AI answer: "What plant is this? What's wrong with it?"
   * ------------------------------------------------------------------ */

  const CONFIDENCE = ['low', 'medium', 'high'];
  const URGENCY = ['fine', 'soon', 'now'];
  // Pet safety comes from the catalogue, never from the model: any sentence
  // in its answer that makes a claim about pets or toxicity is dropped.
  const PET_CLAIM = /\b(toxic|non-?toxic|poison\w*|pets?|cats?|dogs?|kittens?|puppies|puppy|aspca|safe (for|around)|harmful to)\b/i;
  function scrubPets(s) {
    return s.split(/(?<=[.!?])\s+/).filter((x) => !PET_CLAIM.test(x)).join(' ').trim();
  }
  function cleanLook(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const idf = r.identification && typeof r.identification === 'object' ? r.identification : {};
    const cat = catalogue(idf.catalogueId);
    const out = {
      relevant: r.relevant !== false,
      identification: {
        catalogueId: cat ? cat.id : null,
        name: scrubPets(clean(idf.name, 60)) || (cat ? cat.name : ''),
        confidence: CONFIDENCE.indexOf(idf.confidence) >= 0 ? idf.confidence : 'low',
      },
      health: { issues: [], urgency: 'fine' },
      note: scrubPets(clean(r.note, 300)),
    };
    if (!out.identification.name) out.identification.confidence = 'low';
    const h = r.health && typeof r.health === 'object' ? r.health : {};
    out.health.urgency = URGENCY.indexOf(h.urgency) >= 0 ? h.urgency : 'fine';
    for (const it of (Array.isArray(h.issues) ? h.issues : []).slice(0, 12)) {
      if (!it || typeof it !== 'object') continue;
      const issue = scrubPets(clean(it.issue, 80));
      if (!issue) continue;
      out.health.issues.push({ issue, likely_cause: scrubPets(clean(it.likely_cause, 160)), fix: scrubPets(clean(it.fix, 200)) });
      if (out.health.issues.length >= 5) break;
    }
    return out;
  }

  return {
    LIMITS, LIGHTS, SOIL, SOIL_IDS, HUMIDITY, PETS, GROUPS, CATALOGUE, ROOMS, ROOM_IDS, POTS, POT_IDS, BANDS, HEMIS, LEARN, EVENT_KINDS, CUSTOM_PACE, CONFIDENCE, URGENCY,
    clean, cleanText, cleanEmoji, esc, plural, nameList, newId, isPlantId, isEventId, hash32,
    isDate, cleanTz, localDate, addDays, daysBetween, dateLabel, whenLabel,
    catalogue, search, suggestNick, room, amountFor,
    hemisphereOf, seasonName, seasonFactor,
    baseDays, learned, effective, bounds, plantName, plantEmoji, called, dueOf, bandOf, status, feedDue, streakOf, learnedLine, lightWarning,
    cleanPlant, cleanEvent, act, undo, newPlant, board, headline, projectWaterings,
    sitPlan, cleanSit, sitDays, sitSummary, encodeSit, decodeSit, b64url, unb64url, canCompress,
    icsFor, cleanSettings, exportHome, importHome,
    cleanLook, scrubPets,
  };
});
