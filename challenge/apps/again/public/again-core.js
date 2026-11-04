/* Again - the rules, in one file run three times: `window.AgainCore` in the
 * page, `require` in the server and in the tests.
 *
 * NO CLOCK AND NO DICE. Nothing here reads the time or makes a random
 * number: "now" (milliseconds), "today" (YYYY-MM-DD in the person's own day)
 * and every new id are handed in. Days are day numbers from Date.UTC. No
 * lookbehind regexes (older iPhones cannot parse them), no storage, no
 * network.
 *
 * What lives here:
 *   - text cleaning and escaping (every typed place, dish, note and name,
 *     every friend's link and every model answer goes through these);
 *   - folding for search: case, accents, a leading "the" and "&" / "and";
 *   - a place, a dish (its verdict - Order again, Fine or Skip - its note,
 *     price and the days it was ordered, and who with), logging a visit and
 *     quick-adding dishes to it;
 *   - "I'm here": the card for one place, in the order it is read;
 *   - fuzzy place search and a search across dish names;
 *   - Want to try: a friend's recommendation, and turning it into a verdict;
 *   - browsing by city and cuisine, every "Order again", and the stats;
 *   - the share link's payload (only place, neighbourhood, cuisine, dish,
 *     verdict and the one-line note) and the share card's dishes;
 *   - JSON and CSV out (formulas defused) and back in;
 *   - sync: what the account copy may hold, and a merge by item;
 *   - "Read the menu": what is sent, and what is accepted back;
 *   - the made-up list for "Try it".
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgainCore = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const LIMITS = {
    places: 500,             // on a device, and in the account copy
    dishes: 2500,
    wants: 300,
    orders: 40,              // days one dish was ordered, kept per dish
    with: 8,                 // first names per visit
    visitItems: 40,          // dishes logged in one visit
    place: 60,
    area: 40,
    city: 40,
    dish: 80,
    note: 140,               // "the one-line note"
    person: 24,
    tombstones: 800,
    priceCents: 1000000,     // 10,000.00 in any two-decimal currency
    backDays: 20 * 366,      // a meal older than this is not believed
    listBytes: 800 * 1024,   // the account copy, as JSON
    csvBytes: 2 * 1024 * 1024,
    csvRows: 4000,
    csvCols: 30,
    jsonBytes: 3 * 1024 * 1024,
    // A share link: one city's "Order again" list
    sharePlaces: 60,
    shareDishesPerPlace: 30,
    shareDishes: 200,
    shareDaysMin: 1,
    shareDaysMax: 30,
    sharesOpen: 5,
    shareBytes: 48 * 1024,
    // "Read the menu"
    aiDishes: 80,
    aiDesc: 140,
    aiReason: 140,
    aiPicks: 3,
    aiHistory: 120,
    aiNote: 160,
    aiImageBytes: 1000000,
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
  function plural(n, word, many) { return `${n} ${n === 1 ? word : (many || `${word}s`)}`; }
  const hasWord = (s) => /[\p{L}\p{N}]/u.test(String(s || ''));
  /** "Sam", "Sam and Priya", "Sam, Priya and Jo". */
  function listNames(names) {
    const n = (names || []).filter(Boolean);
    if (n.length <= 1) return n.join('');
    return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  }
  /** Links of any kind out of something a model or a friend's link wrote. */
  function stripLinks(s) {
    return String(s)
      .replace(/\b(?:https?|ftp|file|data|javascript|vbscript)\s*:\S*/gi, '')
      .replace(/\bwww\.\S+/gi, '')
      .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|uk|us|ca|au|de|app|dev|info|biz|ly|me|tv|xyz|link|site|online|shop|store|menu|example)\b\S*/gi, '');
  }
  /** A model's words: plain, no links, bounded. */
  function plainOut(v, max) {
    if (typeof v !== 'string') return '';
    return line(stripLinks(plain(v, max * 4)).replace(/\s+([,.!?;:])/g, '$1'), max);
  }
  /** A first name: letters, marks, spaces, hyphens, apostrophes and dots
   *  only, so it can never carry markup, a separator or a number. */
  function cleanPerson(v) {
    if (typeof v !== 'string') return '';
    // Punctuation only inside a name ("Anne-Marie", "O’Neil"), never left on its own.
    const s = line(plain(v, LIMITS.person * 2).replace(/[^\p{L}\p{M}\s'\u2019.-]/gu, ' ').split(/\s+/)
      .map((w) => w.replace(/^[-'\u2019.]+|[-'\u2019]+$/g, '')).filter((w) => /\p{L}/u.test(w)).join(' '), LIMITS.person);
    return /\p{L}/u.test(s) ? s : '';
  }
  function cleanPeople(v) {
    const out = [];
    const seen = new Set();
    for (const x of Array.isArray(v) ? v.slice(0, LIMITS.with * 3) : []) {
      const n = cleanPerson(x);
      const k = fold(n);
      if (!n || seen.has(k) || out.length >= LIMITS.with) continue;
      seen.add(k);
      out.push(n);
    }
    return out;
  }

  const ID_RE = /^[a-z0-9-]{1,24}$/;
  const isId = (v) => typeof v === 'string' && ID_RE.test(v);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const msOk = (v, o) => (Number.isInteger(v) && v > 0 ? Math.min(v, o.nowMs + 86400000) : null);

  /* ------------------------------------------------------------------ *
   * Folding: what makes "Café Orzolino", "cafe orzolino" and "The Café Orzolino" the
   * same place, and "Hickory & Hush" the same as "hickory and hush".
   * ------------------------------------------------------------------ */

  function fold(s) {
    let t = String(s === null || s === undefined ? '' : s).slice(0, 400).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    t = t.replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    t = t.replace(/^the\s+/, '');
    return t.replace(/\s+/g, ' ');
  }
  const cityKey = (c) => fold(c);
  /** A place is the same place when its folded name and city match. */
  const placeKey = (name, city) => `${fold(name)}|${fold(city)}`;
  const dishKey = (name) => fold(name);

  /* ------------------------------------------------------------------ *
   * Days
   * ------------------------------------------------------------------ */

  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isDay(v) {
    if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    if (y < 2000 || y > 2100) return false;
    const back = new Date(Date.UTC(y, m - 1, d));
    return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
  }
  function dayMs(day) { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); }
  function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(day, n) { return dayOf(dayMs(day) + n * 86400000); }
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / 86400000); }
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** "Oct 6" (with the year when it is not this year's). */
  function shortDay(day, today) {
    if (!isDay(day)) return '';
    const [y, m, d] = day.split('-').map(Number);
    return `${MONTH_SHORT[m - 1]} ${d}${today && isDay(today) && today.slice(0, 4) !== day.slice(0, 4) ? `, ${y}` : ''}`;
  }
  /** "today", "yesterday", "5 days ago", "3 weeks ago", "4 months ago". */
  function ago(day, today) {
    if (!isDay(day) || !isDay(today)) return '';
    const d = daysBetween(day, today);
    if (d < 0) return shortDay(day, today);
    if (d === 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 7) return `${d} days ago`;
    if (d < 14) return 'last week';
    if (d < 31) return `${Math.floor(d / 7)} weeks ago`;
    if (d < 60) return 'last month';
    if (d < 365) return `${Math.round(d / 30.44)} months ago`;
    if (d < 730) return 'over a year ago';
    return `${Math.floor(d / 365.25)} years ago`;
  }
  /** The calendar day at instant `ms` in time zone `tz`, from Intl alone. */
  function localDay(ms, tz) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  const dayOk = (v, o) => isDay(v) && v <= addDays(o.today, 1) && v >= addDays(o.today, -LIMITS.backDays);

  /* ------------------------------------------------------------------ *
   * Money: integer cents, in the person's own currency.
   * ------------------------------------------------------------------ */

  // Two-decimal currencies only, so cents are always cents.
  const CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'ZAR', 'INR', 'SGD', 'MXN'];
  const REGION_CURRENCY = {
    US: 'USD', CA: 'CAD', GB: 'GBP', UK: 'GBP', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR',
    FI: 'EUR', GR: 'EUR', LU: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', MT: 'EUR', CY: 'EUR', HR: 'EUR',
    AU: 'AUD', NZ: 'NZD', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', ZA: 'ZAR', IN: 'INR', SG: 'SGD', MX: 'MXN',
  };
  /** The currency for a locale like "en-GB" (USD when it cannot tell, or
   *  when the region's currency has no cents). */
  function currencyFor(locale) {
    const m = /[-_]([A-Za-z]{2})\b/.exec(String(locale || ''));
    return (m && REGION_CURRENCY[m[1].toUpperCase()]) || 'USD';
  }
  const isCurrency = (c) => CURRENCIES.includes(c);
  const SYMBOL = { USD: '$', CAD: '$', AUD: '$', NZD: '$', SGD: '$', MXN: '$', GBP: '£', EUR: '€', INR: '₹', ZAR: 'R', CHF: 'CHF ', SEK: 'kr ', NOK: 'kr ', DKK: 'kr ', PLN: 'zł ' };
  /** "$18", "£12.50". Whole amounts drop the pennies. */
  function money(c, currency, locale) {
    const cur = isCurrency(currency) ? currency : 'USD';
    const n = Math.round(Number(c) || 0);
    const whole = n % 100 === 0;
    try {
      return new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: cur, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(n / 100);
    } catch (e) {
      return `${n < 0 ? '-' : ''}${SYMBOL[cur] || ''}${(Math.abs(n) / 100).toFixed(whole ? 0 : 2)}`;
    }
  }
  /** "18.00" - the plain number a spreadsheet reads. */
  function decimal(c) { return Number.isInteger(c) ? (c / 100).toFixed(2) : ''; }
  /** What someone typed as a price, in cents - or null. "free" and "" are
   *  no price (never 0.00); a negative is refused. */
  function readMoney(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v * 100 <= LIMITS.priceCents ? Math.round(v * 100) : null;
    let s = String(v === null || v === undefined ? '' : v).trim().slice(0, 40);
    if (!s || /^-|\(/.test(s) || !/\d/.test(s)) return null;
    s = s.replace(/[^\d.,]/g, '');
    if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    s = s.replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s) && !/^\d+\.$/.test(s)) return null;
    const c = Math.round(parseFloat(s) * 100);
    return Number.isFinite(c) && c >= 0 && c <= LIMITS.priceCents ? c : null;
  }
  function cents(v) { return Number.isInteger(v) && v >= 0 && v <= LIMITS.priceCents ? v : null; }

  /* ------------------------------------------------------------------ *
   * Cuisines (a curated set, each with its emoji) and verdicts.
   * ------------------------------------------------------------------ */

  const CUISINES = [
    ['italian', 'Italian', '\u{1F35D}'], ['pizza', 'Pizza', '\u{1F355}'], ['mexican', 'Mexican', '\u{1F32E}'],
    ['japanese', 'Japanese', '\u{1F363}'], ['noodles', 'Ramen & noodles', '\u{1F35C}'], ['chinese', 'Chinese', '\u{1F95F}'],
    ['korean', 'Korean', '\u{1F35A}'], ['thai', 'Thai', '\u{1F336}\u{FE0F}'], ['vietnamese', 'Vietnamese', '\u{1F962}'],
    ['indian', 'Indian', '\u{1F35B}'], ['middle-eastern', 'Middle Eastern', '\u{1F9C6}'], ['mediterranean', 'Mediterranean', '\u{1FAD2}'],
    ['greek', 'Greek', '\u{1F959}'], ['french', 'French', '\u{1F950}'], ['spanish', 'Spanish & tapas', '\u{1F958}'],
    ['american', 'Burgers & American', '\u{1F354}'], ['bbq', 'BBQ', '\u{1F356}'], ['steak', 'Steakhouse', '\u{1F969}'],
    ['seafood', 'Seafood', '\u{1F99E}'], ['brunch', 'Brunch', '\u{1F95E}'], ['cafe', 'Café & bakery', '☕'],
    ['dessert', 'Dessert', '\u{1F370}'], ['veg', 'Vegetarian', '\u{1F957}'], ['sandwich', 'Sandwiches', '\u{1F96A}'],
    ['pub', 'Pub & bar', '\u{1F37A}'], ['african', 'African', '\u{1F372}'], ['caribbean', 'Caribbean', '\u{1F96D}'],
    ['other', 'Somewhere else', '\u{1F374}'],
  ].map(([id, label, emoji]) => ({ id, label, emoji }));
  const CUISINE_IDS = CUISINES.map((c) => c.id);
  const isCuisine = (v) => CUISINE_IDS.includes(v);
  function cuisineOf(id) { return CUISINES.find((c) => c.id === id) || CUISINES[CUISINES.length - 1]; }

  const VERDICTS = [
    { id: 'again', emoji: '❤️', label: 'Order again', short: 'Again' },
    { id: 'fine', emoji: '\u{1F44D}', label: 'Fine', short: 'Fine' },
    { id: 'skip', emoji: '\u{1F44E}', label: 'Skip', short: 'Skip' },
  ];
  const VERDICT_IDS = VERDICTS.map((v) => v.id);
  const isVerdict = (v) => VERDICT_IDS.includes(v);
  function verdictOf(id) { return VERDICTS.find((v) => v.id === id) || VERDICTS[1]; }
  const VERDICT_RANK = { again: 0, skip: 1, fine: 2 };

  /* ------------------------------------------------------------------ *
   * Places and dishes. One door for typed, stored, imported, synced and
   * sample ones: cleanPlace / cleanDish / cleanWant.
   * ------------------------------------------------------------------ */

  function cleanPlace(raw, o) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isId(raw.id)) return null;
    const name = plain(raw.name, LIMITS.place);
    if (!hasWord(name)) return null;
    const createdAt = msOk(raw.createdAt, o) || o.nowMs;
    return {
      id: raw.id,
      name,
      area: plain(raw.area, LIMITS.area),
      city: plain(raw.city, LIMITS.city),
      cuisine: isCuisine(raw.cuisine) ? raw.cuisine : 'other',
      createdAt,
      updatedAt: Math.max(createdAt, msOk(raw.updatedAt, o) || createdAt),
    };
  }
  /** The days a dish was ordered: newest first, one entry a day, each with
   *  the first names of who was there. */
  function cleanOrders(raw, o) {
    const by = new Map();
    for (const x of Array.isArray(raw) ? raw.slice(0, LIMITS.orders * 3) : []) {
      if (!x || typeof x !== 'object' || !dayOk(x.day, o)) continue;
      const prev = by.get(x.day);
      by.set(x.day, cleanPeople((prev || []).concat(Array.isArray(x.with) ? x.with : [])));
    }
    return [...by.entries()].map(([day, w]) => ({ day, with: w })).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, LIMITS.orders);
  }
  function cleanDish(raw, o) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isId(raw.id) || !isId(raw.placeId)) return null;
    const name = plain(raw.name, LIMITS.dish);
    if (!hasWord(name)) return null;
    let orders = cleanOrders(raw.orders, o);
    if (!orders.length) orders = [{ day: o.today, with: [] }];
    const createdAt = msOk(raw.createdAt, o) || o.nowMs;
    return {
      id: raw.id,
      placeId: raw.placeId,
      name,
      verdict: isVerdict(raw.verdict) ? raw.verdict : 'fine',
      note: plain(raw.note, LIMITS.note),
      price: cents(raw.price),
      photo: raw.photo === true,
      orders,
      createdAt,
      updatedAt: Math.max(createdAt, msOk(raw.updatedAt, o) || createdAt),
    };
  }
  const lastDay = (d) => (d.orders[0] ? d.orders[0].day : '');
  const times = (d) => d.orders.length;

  /** A new place from the form, or the one already kept with the same name
   *  in the same city. Returns {place, existing, error}. */
  function newPlace(input, places, o) {
    const i = input || {};
    const name = plain(i.name, LIMITS.place);
    if (!hasWord(name)) return { place: null, existing: false, error: 'What’s the place called?' };
    const city = plain(i.city, LIMITS.city);
    const key = placeKey(name, city);
    const found = (places || []).find((p) => placeKey(p.name, p.city) === key);
    if (found) return { place: found, existing: true, error: '' };
    const place = cleanPlace({ id: o.newId(), name, area: i.area, city, cuisine: i.cuisine, createdAt: o.nowMs, updatedAt: o.nowMs }, o);
    return { place, existing: false, error: '' };
  }

  /** Quick-add: one tap per verdict. A name already in the visit takes the
   *  new verdict instead of being added twice. Returns the new list. */
  function quickAdd(items, name, verdict) {
    const n = plain(name, LIMITS.dish);
    const list = (items || []).slice();
    if (!hasWord(n) || !isVerdict(verdict)) return list;
    const k = dishKey(n);
    const i = list.findIndex((x) => dishKey(x.name) === k);
    if (i >= 0) { list[i] = Object.assign({}, list[i], { verdict }); return list; }
    if (list.length >= LIMITS.visitItems) return list;
    list.push({ name: n, verdict, note: '', price: null });
    return list;
  }

  /**
   * Log a visit: a place (one already kept, or a new one), a day, who was
   * there, and the dishes with their verdicts. A dish already kept at that
   * place gets another day and its new verdict; a new one is added. Pure:
   * returns a new data object.
   * @param data  {places, dishes, wants, deleted}
   * @param input {placeId | place: {name, area, city, cuisine}, day, with,
   *               items: [{name, verdict, note, price, photo}]}
   * @param o     {today, nowMs, newId()}
   * @returns {data, place, touched: [dish ids], created: [dish ids], error}
   */
  function logVisit(data, input, o) {
    const i = input || {};
    const out = { places: data.places.slice(), dishes: data.dishes.slice(), wants: data.wants.slice(), deleted: (data.deleted || []).slice() };
    let place = i.placeId ? out.places.find((p) => p.id === i.placeId) : null;
    if (!place) {
      const np = newPlace(i.place, out.places, o);
      if (np.error) return { data, place: null, touched: [], created: [], error: np.error };
      place = np.place;
      if (!np.existing) {
        if (out.places.length >= LIMITS.places) return { data, place: null, touched: [], created: [], error: `That’s ${LIMITS.places} places - remove an old one first.` };
        out.places.push(place);
      }
    }
    const day = isDay(i.day) ? i.day : o.today;
    if (!dayOk(day, o)) return { data, place: null, touched: [], created: [], error: 'Pick the day you were there - not one in the future.' };
    const people = cleanPeople(i.with);
    const items = [];
    const seen = new Map();
    for (const it of Array.isArray(i.items) ? i.items.slice(0, LIMITS.visitItems) : []) {
      if (!it || !isVerdict(it.verdict)) continue;
      const name = plain(it.name, LIMITS.dish);
      if (!hasWord(name)) continue;
      const k = dishKey(name);
      const row = { name, verdict: it.verdict, note: plain(it.note, LIMITS.note), price: typeof it.price === 'string' ? readMoney(it.price) : cents(it.price), photo: it.photo === true };
      if (seen.has(k)) items[seen.get(k)] = row; else { seen.set(k, items.length); items.push(row); }
    }
    if (!items.length) return { data, place: null, touched: [], created: [], error: 'Add at least one dish - type it and tap ❤️, 👍 or 👎.' };
    const touched = [];
    const created = [];
    for (const it of items) {
      const k = dishKey(it.name);
      const at = out.dishes.findIndex((d) => d.placeId === place.id && dishKey(d.name) === k);
      if (at >= 0) {
        const d = clone(out.dishes[at]);
        d.verdict = it.verdict;
        if (it.note) d.note = it.note;
        if (it.price !== null) d.price = it.price;
        if (it.photo) d.photo = true;
        d.orders = cleanOrders(d.orders.concat([{ day, with: people }]), o);
        d.updatedAt = Math.max(o.nowMs, d.updatedAt + 1);
        out.dishes[at] = d;
        touched.push(d.id);
      } else {
        if (out.dishes.length >= LIMITS.dishes) return { data, place: null, touched: [], created: [], error: `That’s ${LIMITS.dishes} dishes - remove a few old ones first.` };
        const d = cleanDish({ id: o.newId(), placeId: place.id, name: it.name, verdict: it.verdict, note: it.note, price: it.price, photo: it.photo, orders: [{ day, with: people }], createdAt: o.nowMs, updatedAt: o.nowMs }, o);
        out.dishes.push(d);
        touched.push(d.id);
        created.push(d.id);
      }
    }
    const pi = out.places.findIndex((p) => p.id === place.id);
    place = Object.assign({}, out.places[pi], { updatedAt: Math.max(o.nowMs, out.places[pi].updatedAt + 1) });
    out.places[pi] = place;
    return { data: out, place, touched, created, error: '' };
  }

  /** Change one dish (a verdict, a note, a price, a name): pure. */
  function editDish(d, patch, o) {
    const next = Object.assign(clone(d), {});
    if (patch.verdict !== undefined && isVerdict(patch.verdict)) next.verdict = patch.verdict;
    if (patch.name !== undefined && hasWord(plain(patch.name, LIMITS.dish))) next.name = plain(patch.name, LIMITS.dish);
    if (patch.note !== undefined) next.note = plain(patch.note, LIMITS.note);
    if (patch.price !== undefined) next.price = typeof patch.price === 'string' ? readMoney(patch.price) : cents(patch.price);
    if (patch.photo !== undefined) next.photo = patch.photo === true;
    next.updatedAt = Math.max(o.nowMs, d.updatedAt + 1);
    return cleanDish(next, o);
  }
  function editPlace(p, patch, o) {
    const next = Object.assign(clone(p), {});
    for (const k of ['name', 'area', 'city', 'cuisine']) if (patch[k] !== undefined) next[k] = patch[k];
    next.updatedAt = Math.max(o.nowMs, p.updatedAt + 1);
    return cleanPlace(next, o) || p;
  }
  /** Forget a dish, or a place and every dish at it; tombstones for sync. */
  function removeIds(data, ids, o) {
    const gone = new Set(ids);
    const at = o.nowMs;
    return {
      places: data.places.filter((p) => !gone.has(p.id)),
      dishes: data.dishes.filter((d) => !gone.has(d.id)),
      wants: data.wants.filter((w) => !gone.has(w.id)),
      deleted: cleanTombstones(ids.map((id) => ({ id, at })).concat(data.deleted || []), o),
    };
  }
  function removePlace(data, placeId, o) {
    const ids = [placeId].concat(data.dishes.filter((d) => d.placeId === placeId).map((d) => d.id));
    return removeIds(data, ids, o);
  }

  /* ------------------------------------------------------------------ *
   * "I'm here": one place, read at a glance.
   * ------------------------------------------------------------------ */

  function dishesAt(data, placeId) { return data.dishes.filter((d) => d.placeId === placeId); }
  /** The last visit (the newest day any dish there was ordered), who was
   *  there that day, and how many days in all. */
  function lastVisit(dishes) {
    const days = new Set();
    let last = '';
    for (const d of dishes) for (const x of d.orders) { days.add(x.day); if (x.day > last) last = x.day; }
    const people = [];
    for (const d of dishes) for (const x of d.orders) if (x.day === last) for (const n of x.with) if (!people.some((p) => fold(p) === fold(n))) people.push(n);
    return last ? { day: last, with: people.slice(0, LIMITS.with), visits: days.size } : null;
  }
  /** Order again first, most-ordered first; then Fine, then Skip, newest first. */
  function byLove(a, b) {
    return (times(b) - times(a)) || (lastDay(a) < lastDay(b) ? 1 : lastDay(a) > lastDay(b) ? -1 : 0) || (fold(a.name) < fold(b.name) ? -1 : 1);
  }
  function byRecent(a, b) {
    return (lastDay(a) < lastDay(b) ? 1 : lastDay(a) > lastDay(b) ? -1 : 0) || (fold(a.name) < fold(b.name) ? -1 : 1);
  }
  /** Friends' recommendations for this place that have not been tried yet. */
  function wantsAt(place, wants) {
    const k = fold(place.name);
    const c = cityKey(place.city);
    return (wants || []).filter((w) => !w.done && fold(w.place) === k && (!w.city || !c || cityKey(w.city) === c))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
  }
  /**
   * The card: Order again (the biggest), Fine, Skip with their notes, the
   * last visit, and what friends recommended there.
   */
  function hereCard(place, data, o) {
    const ds = dishesAt(data, place.id);
    const again = ds.filter((d) => d.verdict === 'again').sort(byLove);
    const fine = ds.filter((d) => d.verdict === 'fine').sort(byRecent);
    const skip = ds.filter((d) => d.verdict === 'skip').sort(byRecent);
    const last = lastVisit(ds);
    return {
      place,
      cuisine: cuisineOf(place.cuisine),
      again, fine, skip,
      last,
      lastText: last ? `Last here ${ago(last.day, o.today)}${last.with.length ? `, with ${listNames(last.with)}` : ''}` : 'Not logged here yet',
      visits: last ? last.visits : 0,
      friends: wantsAt(place, data.wants),
      line: hereLine(again, skip),
    };
  }
  /** "Order again: cacio e pepe, the burrata · Skip: tiramisu - too sweet". */
  function hereLine(again, skip) {
    const parts = [];
    if (again.length) parts.push(`Order again: ${again.slice(0, 3).map((d) => d.name).join(', ')}`);
    if (skip.length) parts.push(`Skip: ${skip.slice(0, 2).map((d) => (d.note ? `${d.name} - ${soften(d.note)}` : d.name)).join(', ')}`);
    return parts.join(' · ');
  }
  /** "Too sweet" reads as "too sweet" after a dash; "BBQ sauce" stays. */
  function soften(s) { return /^\p{Lu}\p{Ll}/u.test(s) ? s[0].toLowerCase() + s.slice(1) : s; }

  /* ------------------------------------------------------------------ *
   * Search: fuzzy for places, plain for dishes.
   * ------------------------------------------------------------------ */

  /** Optimal string alignment distance, stopping early past `max`. */
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const rows = [];
    for (let i = 0; i <= a.length; i++) { rows.push(new Array(b.length + 1).fill(0)); rows[i][0] = i; }
    for (let j = 0; j <= b.length; j++) rows[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      let best = max + 1;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2][j - 2] + 1);
        rows[i][j] = v;
        if (v < best) best = v;
      }
      if (best > max) return max + 1;
    }
    return rows[a.length][b.length];
  }
  /** How well a folded query matches a folded text: 0 (not at all) to 100. */
  function matchScore(q, t) {
    if (!q || !t) return 0;
    if (t === q) return 100;
    if (t.startsWith(q)) return 92;
    const words = t.split(' ');
    if (words.some((w) => w.startsWith(q))) return 84;
    const qw = q.split(' ');
    if (qw.length > 1 && qw.every((x) => words.some((w) => w.startsWith(x)))) return 80;
    if (t.includes(q)) return 72;
    // A typo or two: each query word close to the start of some word.
    if (q.length >= 3 && qw.every((x) => {
      const tol = x.length >= 7 ? 2 : x.length >= 3 ? 1 : 0;
      return words.some((w) => w.startsWith(x) || (tol && (editDistance(x, w.slice(0, x.length), tol) <= tol || editDistance(x, w, tol) <= tol)));
    })) return 58;
    // The letters in order, close together ("smkembr").
    if (q.length >= 3) {
      const flat = t.replace(/ /g, '');
      const qq = q.replace(/ /g, '');
      let at = -1, start = -1;
      for (const ch of qq) { at = flat.indexOf(ch, at + 1); if (at < 0) return 0; if (start < 0) start = at; }
      if (at - start + 1 <= qq.length * 2) return 34;
    }
    return 0;
  }
  /**
   * Places for what someone typed - "orzolino", "ORZOLÍNO", "the orzolino", "hickory &
   * hush", "hick", "ozrolino" - best first, then the most recent visit.
   * Matches the name first, and the neighbourhood, city or cuisine less.
   */
  function searchPlaces(data, query) {
    const q = fold(query);
    const rows = [];
    for (const p of data.places) {
      const last = lastVisit(dishesAt(data, p.id));
      if (!q) { rows.push({ place: p, score: 1, last: last ? last.day : '' }); continue; }
      const s = Math.max(matchScore(q, fold(p.name)), matchScore(q, fold(p.area)) * 0.6, matchScore(q, fold(p.city)) * 0.55, matchScore(q, fold(cuisineOf(p.cuisine).label)) * 0.5);
      if (s >= 30) rows.push({ place: p, score: Math.round(s), last: last ? last.day : '' });
    }
    return rows.sort((a, b) => (b.score - a.score) || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0) || (fold(a.place.name) < fold(b.place.name) ? -1 : 1));
  }
  /** Every dish whose name (or note) has the words in it - "short rib". */
  function searchDishes(data, query, opts) {
    const q = fold(query);
    if (!q) return [];
    const city = opts && opts.city ? cityKey(opts.city) : '';
    const byId = new Map(data.places.map((p) => [p.id, p]));
    const out = [];
    for (const d of data.dishes) {
      const p = byId.get(d.placeId);
      if (!p || (city && cityKey(p.city) !== city)) continue;
      const s = Math.max(matchScore(q, fold(d.name)), matchScore(q, fold(d.note)) * 0.7);
      if (s >= 55) out.push({ dish: d, place: p, score: Math.round(s) });
    }
    return out.sort((a, b) => (b.score - a.score) || (VERDICT_RANK[a.dish.verdict] - VERDICT_RANK[b.dish.verdict]) || byLove(a.dish, b.dish));
  }

  /* ------------------------------------------------------------------ *
   * Browse: cities, cuisines, every "Order again", the stats.
   * ------------------------------------------------------------------ */

  function citiesOf(data) {
    const by = new Map();
    for (const p of data.places) {
      const k = cityKey(p.city);
      if (!k) continue;
      const e = by.get(k) || { key: k, city: p.city, places: 0, again: 0 };
      e.places++;
      by.set(k, e);
    }
    const pc = new Map(data.places.map((p) => [p.id, cityKey(p.city)]));
    for (const d of data.dishes) { const e = by.get(pc.get(d.placeId)); if (e && d.verdict === 'again') e.again++; }
    return [...by.values()].sort((a, b) => (b.places - a.places) || (a.key < b.key ? -1 : 1));
  }
  function cuisinesOf(data, city) {
    const by = new Map();
    for (const p of data.places) {
      if (city && cityKey(p.city) !== cityKey(city)) continue;
      by.set(p.cuisine, (by.get(p.cuisine) || 0) + 1);
    }
    return [...by.entries()].map(([id, n]) => Object.assign({ places: n }, cuisineOf(id))).sort((a, b) => (b.places - a.places) || (a.label < b.label ? -1 : 1));
  }
  /** Places that match a city and a cuisine ('' for any), most recent first. */
  function placesIn(data, opts) {
    const c = opts && opts.city ? cityKey(opts.city) : '';
    const cu = opts && opts.cuisine ? opts.cuisine : '';
    return searchPlaces(data, '').filter((r) => (!c || cityKey(r.place.city) === c) && (!cu || r.place.cuisine === cu));
  }
  /** Every "Order again", grouped by place: "every ❤️ in Riverton". */
  function againList(data, opts) {
    const rows = [];
    for (const r of placesIn(data, opts)) {
      const ds = dishesAt(data, r.place.id).filter((d) => d.verdict === 'again').sort(byLove);
      if (ds.length) rows.push({ place: r.place, dishes: ds });
    }
    return rows.sort((a, b) => (b.dishes.length - a.dishes.length) || (lastDay(b.dishes[0]) > lastDay(a.dishes[0]) ? 1 : -1));
  }
  /**
   * The stats - places tried this year, the favourite cuisine, the dish
   * ordered again most - and nothing gamified.
   * @param o {today}
   */
  function stats(data, o) {
    const year = o.today.slice(0, 4);
    const byId = new Map(data.places.map((p) => [p.id, p]));
    const visits = new Set();
    const placesYear = new Set();
    const firstDay = new Map();
    for (const d of data.dishes) {
      if (!byId.has(d.placeId)) continue;
      for (const x of d.orders) {
        if (x.day.slice(0, 4) === year && x.day <= o.today) { visits.add(`${d.placeId}|${x.day}`); placesYear.add(d.placeId); }
        if (!firstDay.has(d.placeId) || x.day < firstDay.get(d.placeId)) firstDay.set(d.placeId, x.day);
      }
    }
    const newThisYear = [...firstDay.entries()].filter(([, day]) => day.slice(0, 4) === year).length;
    const again = data.dishes.filter((d) => d.verdict === 'again' && byId.has(d.placeId));
    const counted = data.dishes.filter((d) => byId.has(d.placeId));
    const loves = new Map();
    for (const d of again) { const c = byId.get(d.placeId).cuisine; loves.set(c, (loves.get(c) || 0) + 1); }
    let fav = null;
    for (const [id, n] of loves) if (!fav || n > fav.n || (n === fav.n && cuisineOf(id).label < cuisineOf(fav.id).label)) fav = { id, n };
    let top = null;
    for (const d of again) if (!top || byLove(d, top) < 0) top = d;
    return {
      year,
      placesThisYear: placesYear.size,
      newPlacesThisYear: newThisYear,
      visitsThisYear: visits.size,
      places: data.places.length,
      dishes: counted.length,
      again: again.length,
      hitRate: counted.length ? Math.round((again.length / counted.length) * 100) : 0,
      favCuisine: fav ? Object.assign({ loves: fav.n }, cuisineOf(fav.id)) : null,
      topDish: top ? { dish: top, place: byId.get(top.placeId), times: times(top) } : null,
      cities: citiesOf(data).length,
    };
  }

  /* ------------------------------------------------------------------ *
   * Want to try: what friends recommended, with who said it and when.
   * ------------------------------------------------------------------ */

  function cleanDone(raw, o) {
    if (!raw || typeof raw !== 'object' || !isVerdict(raw.verdict) || !dayOk(raw.day, o)) return null;
    return { day: raw.day, verdict: raw.verdict, dishId: isId(raw.dishId) ? raw.dishId : '' };
  }
  function cleanWant(raw, o) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isId(raw.id)) return null;
    const place = plain(raw.place, LIMITS.place);
    if (!hasWord(place)) return null;
    const dish = plain(raw.dish, LIMITS.dish);
    const createdAt = msOk(raw.createdAt, o) || o.nowMs;
    return {
      id: raw.id,
      dish: hasWord(dish) ? dish : '',
      place,
      area: plain(raw.area, LIMITS.area),
      city: plain(raw.city, LIMITS.city),
      cuisine: isCuisine(raw.cuisine) ? raw.cuisine : '',
      from: cleanPerson(raw.from),
      day: dayOk(raw.day, o) ? raw.day : o.today,
      note: plain(raw.note, LIMITS.note),
      via: raw.via === 'link' ? 'link' : '',
      done: cleanDone(raw.done, o),
      createdAt,
      updatedAt: Math.max(createdAt, msOk(raw.updatedAt, o) || createdAt),
    };
  }
  /** A recommendation from the form. Returns {want, error}. */
  function newWant(input, o) {
    const i = input || {};
    if (!hasWord(plain(i.place, LIMITS.place))) return { want: null, error: 'Which place did they recommend?' };
    const want = cleanWant({ id: o.newId(), dish: i.dish, place: i.place, area: i.area, city: i.city, cuisine: i.cuisine, from: i.from, day: i.day || o.today, note: i.note, via: i.via, done: null, createdAt: o.nowMs, updatedAt: o.nowMs }, o);
    return { want, error: '' };
  }
  /** "The mole at Casa Lunaria", or just the place. */
  function wantTitle(w) { return w.dish ? `${w.dish} at ${w.place}` : w.place; }
  /** "Priya was right ❤️" - what trying it turned out to be. */
  function triedLine(w, verdict) {
    const v = verdictOf(verdict);
    if (w.from) {
      if (verdict === 'again') return `${w.from} was right ${v.emoji}`;
      if (verdict === 'fine') return `${w.from}’s pick: fine ${v.emoji}`;
      return `Not for you ${v.emoji} - sorry, ${w.from}`;
    }
    return verdict === 'again' ? `Worth it ${v.emoji}` : verdict === 'fine' ? `Fine ${v.emoji}` : `Not for you ${v.emoji}`;
  }
  /**
   * One tap turns a recommendation into a real verdict: the place is found
   * (or added), the dish logged today with that verdict, and the
   * recommendation marked tried. A place-only one marks the place tried.
   * @returns {data, want, place, dishId, line, error}
   */
  function tryWant(data, wantId, verdict, o) {
    const w = data.wants.find((x) => x.id === wantId);
    if (!w || !isVerdict(verdict)) return { data, want: null, place: null, dishId: '', line: '', error: 'That recommendation isn’t here any more.' };
    let next = data;
    let place = null;
    let dishId = '';
    if (w.dish) {
      const found = data.places.find((p) => placeKey(p.name, p.city) === placeKey(w.place, w.city)) || (!w.city ? data.places.find((p) => fold(p.name) === fold(w.place)) : null);
      const r = logVisit(data, found ? { placeId: found.id, day: o.today, items: [{ name: w.dish, verdict, note: w.note }] } : { place: { name: w.place, area: w.area, city: w.city, cuisine: w.cuisine }, day: o.today, items: [{ name: w.dish, verdict, note: w.note }] }, o);
      if (r.error) return { data, want: null, place: null, dishId: '', line: '', error: r.error };
      next = r.data;
      place = r.place;
      dishId = r.touched[0];
    } else {
      const np = newPlace({ name: w.place, area: w.area, city: w.city, cuisine: w.cuisine }, data.places, o);
      if (np.error) return { data, want: null, place: null, dishId: '', line: '', error: np.error };
      place = np.place;
      next = Object.assign({}, data, { places: np.existing ? data.places : data.places.concat([np.place]) });
    }
    const done = { day: o.today, verdict, dishId };
    const want = cleanWant(Object.assign(clone(w), { done, updatedAt: Math.max(o.nowMs, w.updatedAt + 1) }), o);
    next = Object.assign({}, next, { wants: next.wants.map((x) => (x.id === w.id ? want : x)) });
    return { data: next, want, place, dishId, line: triedLine(w, verdict), error: '' };
  }

  /**
   * After a visit is logged: any open recommendation for a dish that was
   * just logged at that place is settled with the verdict it got - logging
   * "the carbonara" at Orzolino answers Alex's "try the carbonara at Orzolino".
   * @returns {data, lines: ["Alex was right ❤️"]}
   */
  function settleWants(data, placeId, dishIds, o) {
    const place = data.places.find((p) => p.id === placeId);
    if (!place) return { data, lines: [] };
    const logged = data.dishes.filter((d) => dishIds.includes(d.id));
    const lines = [];
    const open = new Set(wantsAt(place, data.wants).filter((w) => w.dish).map((w) => w.id));
    const wants = data.wants.map((w) => {
      if (!open.has(w.id)) return w;
      const d = logged.find((x) => dishKey(x.name) === dishKey(w.dish));
      if (!d) return w;
      lines.push(triedLine(w, d.verdict));
      return cleanWant(Object.assign(clone(w), { done: { day: lastDay(d) || o.today, verdict: d.verdict, dishId: d.id }, updatedAt: Math.max(o.nowMs, w.updatedAt + 1) }), o);
    });
    return { data: lines.length ? Object.assign({}, data, { wants }) : data, lines };
  }

  /* ------------------------------------------------------------------ *
   * A share link: one city's "Order again" list, for friends with no
   * account. Place names, neighbourhoods, cuisines, dish names, verdicts and
   * the one-line notes - never a price, a companion's name, a date or a
   * photo. The page builds it; the server takes nothing else.
   * ------------------------------------------------------------------ */

  const SHARE_KEYS = ['city', 'from', 'days', 'places'];
  const SHARE_PLACE_KEYS = ['name', 'area', 'cuisine', 'dishes'];
  const SHARE_DISH_KEYS = ['name', 'verdict', 'note'];
  /** What the page sends: the city's ❤️ dishes (and, if asked, the 👎 ones). */
  function sharePayload(data, city, opts) {
    const o = opts || {};
    const want = o.skip ? ['again', 'skip'] : ['again'];
    const places = [];
    let total = 0;
    for (const r of placesIn(data, { city })) {
      const ds = dishesAt(data, r.place.id).filter((d) => want.includes(d.verdict))
        .sort((a, b) => (VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]) || byLove(a, b))
        .slice(0, Math.min(LIMITS.shareDishesPerPlace, LIMITS.shareDishes - total));
      if (!ds.some((d) => d.verdict === 'again')) continue;
      total += ds.length;
      places.push({ name: r.place.name, area: r.place.area, cuisine: r.place.cuisine, dishes: ds.map((d) => ({ name: d.name, verdict: d.verdict, note: d.note })) });
      if (places.length >= LIMITS.sharePlaces || total >= LIMITS.shareDishes) break;
    }
    places.sort((a, b) => b.dishes.filter((d) => d.verdict === 'again').length - a.dishes.filter((d) => d.verdict === 'again').length);
    return { city: plain(city, LIMITS.city), from: cleanPerson(o.from), places };
  }
  const onlyKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => keys.includes(k));
  /**
   * What the server takes to make a link - exactly the allowed fields, or
   * null. Any other field anywhere (a price, a day, a name of who was
   * there, a photo) refuses the whole request.
   */
  function shareRequest(body) {
    if (!onlyKeys(body, SHARE_KEYS)) return null;
    const days = body.days;
    if (!Number.isInteger(days) || days < LIMITS.shareDaysMin || days > LIMITS.shareDaysMax) return null;
    const city = plain(body.city, LIMITS.city);
    if (!hasWord(city)) return null;
    if (body.from !== undefined && typeof body.from !== 'string') return null;
    const places = cleanSharePlaces(body.places, true);
    if (!places) return null;
    return { city, from: cleanPerson(body.from), days, places };
  }
  function cleanSharePlaces(raw, strict) {
    if (!Array.isArray(raw) || !raw.length || raw.length > LIMITS.sharePlaces) return strict ? null : [];
    const out = [];
    let total = 0;
    for (const p of raw) {
      if (!p || typeof p !== 'object' || Array.isArray(p) || (strict && !onlyKeys(p, SHARE_PLACE_KEYS))) { if (strict) return null; continue; }
      const name = plain(p.name, LIMITS.place);
      if (!hasWord(name) || !Array.isArray(p.dishes) || !p.dishes.length || p.dishes.length > LIMITS.shareDishesPerPlace) { if (strict) return null; continue; }
      if (p.cuisine !== undefined && p.cuisine !== '' && !isCuisine(p.cuisine)) { if (strict) return null; continue; }
      const dishes = [];
      for (const d of p.dishes) {
        if (!d || typeof d !== 'object' || (strict && !onlyKeys(d, SHARE_DISH_KEYS)) || !isVerdict(d.verdict)) { if (strict) return null; continue; }
        const dn = plain(d.name, LIMITS.dish);
        if (!hasWord(dn)) { if (strict) return null; continue; }
        dishes.push({ name: dn, verdict: d.verdict, note: plain(d.note, LIMITS.note) });
      }
      total += dishes.length;
      if (total > LIMITS.shareDishes) return strict ? null : out;
      if (dishes.length) out.push({ name, area: plain(p.area, LIMITS.area), cuisine: isCuisine(p.cuisine) ? p.cuisine : 'other', dishes });
    }
    return out.length ? out : (strict ? null : out);
  }
  /** What a friend sees: the same fields, cleaned again on the way out. */
  function shareView(doc) {
    if (!doc || typeof doc !== 'object') return null;
    const places = cleanSharePlaces(doc.places, false);
    if (!places.length) return null;
    return { city: plain(doc.city, LIMITS.city), from: cleanPerson(doc.from), places };
  }
  /** A friend's tap on "Save to my Want to try": a recommendation on their
   *  own device. Nothing is written anywhere else. */
  function wantFromShare(share, pi, di, o) {
    const p = share && share.places && share.places[pi];
    const d = p && p.dishes[di];
    if (!d) return null;
    return newWant({ dish: d.name, place: p.name, area: p.area, city: share.city, cuisine: p.cuisine, from: share.from, note: d.note, via: 'link', day: o.today }, o).want;
  }
  /** Already on the list (not yet tried)? */
  function hasWant(wants, dish, place) {
    return (wants || []).some((w) => !w.done && fold(w.place) === fold(place) && fold(w.dish) === fold(dish));
  }

  /* ------------------------------------------------------------------ *
   * The share card: "My top dishes in <city>".
   * ------------------------------------------------------------------ */

  function topDishes(data, city, n) {
    const out = [];
    for (const r of againList(data, { city })) for (const d of r.dishes) out.push({ dish: d, place: r.place });
    return out.sort((a, b) => byLove(a.dish, b.dish)).slice(0, n || 6);
  }

  /* ------------------------------------------------------------------ *
   * The whole list: one door for stored, imported and synced copies.
   * ------------------------------------------------------------------ */

  function cleanTombstones(raw, o) {
    const by = new Map();
    for (const t of Array.isArray(raw) ? raw.slice(0, LIMITS.tombstones * 2) : []) {
      if (!t || !isId(t.id)) continue;
      const at = msOk(t.at, o);
      if (!at) continue;
      if (!by.has(t.id) || by.get(t.id) < at) by.set(t.id, at);
    }
    return [...by.entries()].map(([id, at]) => ({ id, at })).sort((a, b) => b.at - a.at).slice(0, LIMITS.tombstones);
  }
  const TOP_KEYS = ['places', 'dishes', 'wants', 'deleted'];
  /**
   * Cleaned. Strict (the server): unknown fields or too many of anything are
   * errors and nothing is saved. A dish whose place is not in the list is
   * dropped, never kept as an orphan.
   * @returns {list: {places, dishes, wants, deleted}, errors, dropped}
   */
  function cleanList(raw, o, strict) {
    const errors = [];
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (strict) {
      if (r !== raw) errors.push('Send the list.');
      for (const k of Object.keys(r)) if (!TOP_KEYS.includes(k)) errors.push(`Unknown field: ${line(k, 20)}`);
      for (const [k, max] of [['places', LIMITS.places], ['dishes', LIMITS.dishes], ['wants', LIMITS.wants]]) {
        if (r[k] !== undefined && !Array.isArray(r[k])) errors.push(`${k[0].toUpperCase()}${k.slice(1)} must be a list.`);
        else if (Array.isArray(r[k]) && r[k].length > max) errors.push(`At most ${max} ${k}.`);
      }
    }
    let dropped = 0;
    const take = (arr, max, fn) => {
      const seen = new Set();
      const out = [];
      for (const x of Array.isArray(arr) ? arr.slice(0, max) : []) {
        const c = fn(x, o);
        if (!c || seen.has(c.id)) { dropped++; continue; }
        seen.add(c.id);
        out.push(c);
      }
      return out;
    };
    const places = take(r.places, LIMITS.places, cleanPlace);
    const ids = new Set(places.map((p) => p.id));
    const dishes = take(r.dishes, LIMITS.dishes, cleanDish).filter((d) => { if (ids.has(d.placeId)) return true; dropped++; return false; });
    if (strict) for (const d of dishes) d.photo = false;
    const wants = take(r.wants, LIMITS.wants, cleanWant);
    return { list: { places, dishes, wants, deleted: cleanTombstones(r.deleted, o) }, errors, dropped };
  }
  /** What leaves the device: no photo flags (photos stay on the phone). */
  function syncPayload(data) {
    return {
      places: data.places.map(clone),
      dishes: data.dishes.map((d) => { const c = clone(d); delete c.photo; return c; }),
      wants: data.wants.map(clone),
      deleted: (data.deleted || []).map(clone),
    };
  }
  /** Merge two copies by item: the later edit of each place, dish and
   *  recommendation wins, and a deletion beats an older edit. */
  function mergeLists(mine, theirs, o) {
    const a = cleanList(mine, o).list;
    const b = cleanList(theirs, o).list;
    const deleted = cleanTombstones(a.deleted.concat(b.deleted), o);
    const gone = new Map(deleted.map((t) => [t.id, t.at]));
    const pick = (xs, ys, max) => {
      const by = new Map();
      for (const x of ys) by.set(x.id, x);
      for (const x of xs) { const y = by.get(x.id); if (!y || x.updatedAt >= y.updatedAt) by.set(x.id, x); }
      return [...by.values()].filter((x) => !(gone.has(x.id) && gone.get(x.id) >= x.updatedAt))
        .sort((x, y) => (x.createdAt - y.createdAt) || (x.id < y.id ? -1 : 1)).slice(-max);
    };
    const places = pick(a.places, b.places, LIMITS.places);
    const ids = new Set(places.map((p) => p.id));
    const dishes = pick(a.dishes, b.dishes, LIMITS.dishes).filter((d) => ids.has(d.placeId));
    return { places, dishes, wants: pick(a.wants, b.wants, LIMITS.wants), deleted };
  }
  function listBytes(list) { return new TextEncoder().encode(JSON.stringify(list)).length; }
  function countOf(list) { return { places: list.places.length, dishes: list.dishes.length, wants: list.wants.length }; }

  /* ------------------------------------------------------------------ *
   * Export and import: JSON (everything but photos) and CSV (formulas
   * defused on the way out, the defusing undone on the way in).
   * ------------------------------------------------------------------ */

  function toJson(data, o) {
    const s = syncPayload(data);
    return JSON.stringify({ app: 'again', version: 1, exported: o.today, places: s.places, dishes: s.dishes, wants: s.wants }, null, 2);
  }
  /** A JSON file back in: {list, error}. Everything goes through cleanList. */
  function fromJson(text, o) {
    const s = String(text || '');
    if (!s.trim()) return { list: null, error: 'That file is empty.' };
    if (s.length > LIMITS.jsonBytes) return { list: null, error: 'That file is over 3 MB.' };
    let raw;
    try { raw = JSON.parse(s); } catch (e) { return { list: null, error: 'That file isn’t JSON that Again can read.' }; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.app !== 'again') return { list: null, error: 'That file isn’t an Again export.' };
    const r = cleanList({ places: raw.places, dishes: raw.dishes, wants: raw.wants }, o);
    for (const d of r.list.dishes) d.photo = false;
    if (!r.list.places.length && !r.list.wants.length) return { list: null, error: 'Nothing could be read from that file.' };
    return { list: r.list, error: '', dropped: r.dropped };
  }

  const CSV_HEAD = ['kind', 'id', 'place_id', 'place', 'area', 'city', 'cuisine', 'dish', 'verdict', 'note', 'price', 'currency', 'orders', 'from', 'said_on', 'tried', 'tried_on'];
  /** RFC 4180, with formulas defused (a leading = + - @ tab or CR). */
  function csvCell(v) {
    let s = String(v === null || v === undefined ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCsv(rows) { return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
  /** "2026-10-01: Sam, Priya; 2026-08-12" - names never hold : ; or ,. */
  const ordersText = (orders) => orders.map((x) => (x.with.length ? `${x.day}: ${x.with.join(', ')}` : x.day)).join('; ');
  function readOrders(s) {
    return String(s || '').split(';').map((part) => {
      const m = /^\s*(\d{4}-\d{2}-\d{2})\s*(?::\s*(.*))?$/.exec(part);
      return m ? { day: m[1], with: m[2] ? m[2].split(',').map((x) => x.trim()).filter(Boolean) : [] } : null;
    }).filter(Boolean);
  }
  function dataCsv(data, o) {
    const rows = [CSV_HEAD];
    const byId = new Map(data.places.map((p) => [p.id, p]));
    const used = new Set();
    for (const d of data.dishes) {
      const p = byId.get(d.placeId);
      if (!p) continue;
      used.add(p.id);
      rows.push(['dish', d.id, p.id, p.name, p.area, p.city, p.cuisine, d.name, d.verdict, d.note, decimal(d.price), o.currency || 'USD', ordersText(d.orders), '', '', '', '']);
    }
    for (const p of data.places) if (!used.has(p.id)) rows.push(['place', '', p.id, p.name, p.area, p.city, p.cuisine, '', '', '', '', '', '', '', '', '', '']);
    for (const w of data.wants) rows.push(['want', w.id, '', w.place, w.area, w.city, w.cuisine, w.dish, '', w.note, '', '', '', w.from, w.day, w.done ? w.done.verdict : '', w.done ? w.done.day : '']);
    return toCsv(rows);
  }
  /** RFC 4180 rows: quoted delimiters, doubled quotes, line breaks inside
   *  quotes, CRLF / LF / CR, a BOM. Bounded. */
  function parseCsv(text) {
    const s = String(text || '').slice(0, LIMITS.csvBytes).replace(/^\ufeff/, '');
    const rows = [];
    let row = [], cell = '', q = false, i = 0;
    const push = () => { if (row.length < LIMITS.csvCols) row.push(cell); cell = ''; };
    while (i < s.length && rows.length <= LIMITS.csvRows) {
      const ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
        if (cell.length < 4000) cell += ch;
        i++; continue;
      }
      if (ch === '"' && cell === '') { q = true; i++; continue; }
      if (ch === ',') { push(); i++; continue; }
      if (ch === '\r' || ch === '\n') { push(); rows.push(row); row = []; i += (ch === '\r' && s[i + 1] === '\n') ? 2 : 1; continue; }
      if (cell.length < 4000) cell += ch;
      i++;
    }
    if (cell !== '' || row.length) { push(); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }
  const undefuse = (v) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);
  /**
   * A CSV back into a list. A row with no kind is a dish if it has one.
   * Places are matched by their id, else by name and city. Every row goes
   * through the same cleaning as anything typed.
   * @param o {today, nowMs, newId()}
   * @returns {list, skipped, error}
   */
  function fromCsv(text, o) {
    const rows = parseCsv(text);
    if (!rows.length) return { list: null, skipped: 0, error: 'That file is empty.' };
    const head = rows[0].map((h) => line(h, 40).toLowerCase().replace(/[^a-z_]/g, ''));
    const col = (name) => head.indexOf(name);
    if (col('place') < 0) return { list: null, skipped: 0, error: 'That file has no place column. Use a CSV that Again exported.' };
    const places = [], dishes = [], wants = [];
    const placeBy = new Map();
    const seen = new Set();
    let skipped = 0;
    const freshId = (v) => { const t = String(v || '').trim(); const id = isId(t) && !seen.has(t) ? t : o.newId(); seen.add(id); return id; };
    let n = 0;
    for (const r of rows.slice(1)) {
      const get = (name) => { const i = col(name); return i >= 0 && r[i] !== undefined ? undefuse(String(r[i])) : ''; };
      const kind = get('kind').trim().toLowerCase() || (get('dish').trim() ? 'dish' : 'place');
      const stamp = o.nowMs + n++;
      if (kind === 'want') {
        if (wants.length >= LIMITS.wants) { skipped++; continue; }
        const tried = get('tried').trim().toLowerCase();
        const w = cleanWant({ id: freshId(get('id')), dish: get('dish'), place: get('place'), area: get('area'), city: get('city'), cuisine: get('cuisine').trim(), from: get('from'), day: get('said_on').trim(), note: get('note'), done: isVerdict(tried) ? { verdict: tried, day: get('tried_on').trim() } : null, createdAt: stamp, updatedAt: stamp }, o);
        if (w) wants.push(w); else skipped++;
        continue;
      }
      if (kind !== 'dish' && kind !== 'place') { skipped++; continue; }
      const pidRaw = get('place_id').trim();
      const key = isId(pidRaw) ? `id:${pidRaw}` : placeKey(get('place'), get('city'));
      let place = placeBy.get(key);
      if (!place) {
        if (places.length >= LIMITS.places) { skipped++; continue; }
        place = cleanPlace({ id: freshId(pidRaw), name: get('place'), area: get('area'), city: get('city'), cuisine: get('cuisine').trim(), createdAt: stamp, updatedAt: stamp }, o);
        if (!place) { skipped++; continue; }
        placeBy.set(key, place);
        places.push(place);
      }
      if (kind === 'place') continue;
      if (dishes.length >= LIMITS.dishes) { skipped++; continue; }
      const d = cleanDish({ id: freshId(get('id')), placeId: place.id, name: get('dish'), verdict: get('verdict').trim().toLowerCase(), note: get('note'), price: readMoney(get('price')), orders: readOrders(get('orders')), createdAt: stamp, updatedAt: stamp }, o);
      if (d) dishes.push(d); else skipped++;
    }
    if (!places.length && !wants.length) return { list: null, skipped, error: 'No places or dishes could be read from that file.' };
    return { list: { places, dishes, wants, deleted: [] }, skipped, error: '' };
  }
  /** Bring an imported list in: the file's copy of anything with the same
   *  id replaces this device's; everything else is added. Photo flags stay
   *  this device's. */
  function importInto(data, list, o) {
    const merge = (xs, ys, max, keepPhoto) => {
      const by = new Map(xs.map((x) => [x.id, x]));
      const out = xs.slice();
      for (const y of ys) {
        const at = out.findIndex((x) => x.id === y.id);
        const v = keepPhoto && by.has(y.id) ? Object.assign({}, y, { photo: by.get(y.id).photo }) : y;
        if (at >= 0) out[at] = v; else if (out.length < max) out.push(v);
      }
      return out;
    };
    const places = merge(data.places, list.places, LIMITS.places, false);
    const ids = new Set(places.map((p) => p.id));
    return { places, dishes: merge(data.dishes, list.dishes, LIMITS.dishes, true).filter((d) => ids.has(d.placeId)), wants: merge(data.wants, list.wants, LIMITS.wants, false), deleted: cleanTombstones(data.deleted, o) };
  }

  /* ------------------------------------------------------------------ *
   * "Read the menu": what is sent, what is accepted back.
   * ------------------------------------------------------------------ */

  const CONFIDENCE = ['low', 'medium', 'high'];
  const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
  const HISTORY_KEYS = ['dish', 'cuisine', 'verdict'];
  /**
   * Exactly {image: {type, data}} - one JPEG or PNG - and, for "What should I
   * order?", `history`: the person's own dish names with their cuisine and
   * verdict, and nothing else. A place name, a companion, a date or a note
   * (any other field, anywhere) refuses the request. Its bytes are checked
   * again on the server.
   */
  function menuRequest(body) {
    if (!onlyKeys(body, ['image', 'history']) || !body.image) return null;
    const im = body.image;
    if (!onlyKeys(im, ['type', 'data']) || Object.keys(im).length !== 2) return null;
    if (im.type !== 'image/jpeg' && im.type !== 'image/png') return null;
    if (typeof im.data !== 'string' || im.data.length < 16 || im.data.length > Math.ceil(LIMITS.aiImageBytes / 3) * 4 + 4 || !B64.test(im.data)) return null;
    let history = null;
    if (body.history !== undefined) {
      if (!Array.isArray(body.history) || !body.history.length || body.history.length > LIMITS.aiHistory) return null;
      history = [];
      for (const h of body.history) {
        if (!onlyKeys(h, HISTORY_KEYS) || !isVerdict(h.verdict) || typeof h.dish !== 'string') return null;
        if (h.cuisine !== undefined && h.cuisine !== '' && !isCuisine(h.cuisine)) return null;
        const dish = plain(h.dish, LIMITS.dish);
        if (!hasWord(dish)) return null;
        history.push({ dish, cuisine: isCuisine(h.cuisine) ? h.cuisine : '', verdict: h.verdict });
      }
    }
    return { image: { type: im.type, data: im.data }, history };
  }
  /** The person's own dishes for "What should I order?": names, cuisines and
   *  verdicts only, from every place but the one they are at. Loved and
   *  skipped first (they say the most), the most-ordered first. */
  function historyFor(data, opts) {
    const except = opts && opts.exceptPlaceId;
    const byId = new Map(data.places.map((p) => [p.id, p]));
    const rows = data.dishes.filter((d) => byId.has(d.placeId) && d.placeId !== except)
      .sort((a, b) => (VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]) || byLove(a, b));
    const out = [];
    const seen = new Set();
    for (const d of rows) {
      const k = `${dishKey(d.name)}|${d.verdict}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ dish: d.name, cuisine: byId.get(d.placeId).cuisine, verdict: d.verdict });
      if (out.length >= LIMITS.aiHistory) break;
    }
    return out;
  }
  /**
   * The model's answer, checked. Nothing it says is trusted: at most 80
   * dishes with plain names and short descriptions, prices whole cents at or
   * above zero and bounded (or none), no links; picks only when they were
   * asked for, only dishes from its own list, at most three, each reason
   * plain and short.
   * @param req the checked request (so picks need a history)
   */
  function cleanMenu(raw, req) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const dishes = [];
    const keys = new Map();
    for (const it of Array.isArray(raw.dishes) ? raw.dishes.slice(0, LIMITS.aiDishes * 3) : []) {
      if (dishes.length >= LIMITS.aiDishes) break;
      if (!it || typeof it !== 'object') continue;
      const name = plainOut(it.name, LIMITS.dish);
      const k = dishKey(name);
      if (!hasWord(name) || keys.has(k)) continue;
      const pr = it.price;
      const price = typeof pr === 'number' && Number.isFinite(pr) && pr >= 0 && pr * 100 <= LIMITS.priceCents ? Math.round(pr * 100) : null;
      keys.set(k, dishes.length);
      dishes.push({ name, desc: plainOut(it.description, LIMITS.aiDesc), price });
    }
    if (!dishes.length) return null;
    const picks = [];
    if (req && req.history && req.history.length) {
      for (const p of Array.isArray(raw.picks) ? raw.picks.slice(0, 10) : []) {
        if (picks.length >= LIMITS.aiPicks) break;
        if (!p || typeof p !== 'object') continue;
        const at = keys.get(dishKey(plain(p.name, LIMITS.dish * 2)));
        if (at === undefined || picks.some((x) => x.index === at)) continue;
        picks.push({ index: at, name: dishes[at].name, reason: plainOut(p.reason, LIMITS.aiReason) });
      }
    }
    const cur = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
    return {
      dishes,
      currency: isCurrency(cur) ? cur : '',
      picks,
      asked: Boolean(req && req.history && req.history.length),
      confidence: CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'low',
      note: plainOut(raw.note, LIMITS.aiNote),
    };
  }

  /* ------------------------------------------------------------------ *
   * "Try it": a made-up list - ten places in two cities, dishes with
   * verdicts, and a friend's recommendations. Never saved. Every place, dish
   * and person is invented.
   * ------------------------------------------------------------------ */

  function sample(o) {
    const t = o.today;
    const d = (n) => addDays(t, -n);
    const at = (n) => o.nowMs - n * 86400000;
    const P = [
      ['s-orzolino', 'Orzolino', 'Old Mill', 'Riverton', 'italian'],
      ['s-hickory', 'Hickory & Hush', 'Canal Row', 'Riverton', 'bbq'],
      ['s-brothwick', 'Brothwick Noodle Bar', 'Brickyard', 'Riverton', 'noodles'],
      ['s-lunabrava', 'Taqueria Lunabrava', 'Canal Row', 'Riverton', 'mexican'],
      ['s-kettlebird', 'Pho Kettlebird', 'Northgate', 'Riverton', 'vietnamese'],
      ['s-copperwick', 'Copperwick Hall', 'Lantern Hill', 'Lakeport', 'american'],
      ['s-gogi', 'Gogi Quarry', 'Larkfield', 'Lakeport', 'korean'],
      ['s-nubeluz', 'Panadería Nubeluz', 'Southbank', 'Lakeport', 'cafe'],
      ['s-saffron', 'Saffron Signal Box', 'Harbourside', 'Lakeport', 'indian'],
      ['s-gullwing', 'Gullwing Oyster Bar', 'Pier Quarter', 'Lakeport', 'seafood'],
    ];
    const places = P.map(([id, name, area, city, cuisine], i) => cleanPlace({ id, name, area, city, cuisine, createdAt: at(400 - i), updatedAt: at(10 + i) }, o));
    const D = [
      // id, place, name, verdict, note, price, orders [[days ago, with]]
      ['s-cacio', 's-orzolino', 'Cacio e pepe', 'again', 'Ask for extra pepper', 1900, [[21, ['Sam', 'Priya']], [74, ['Sam']], [160, []]]],
      ['s-burrata', 's-orzolino', 'The burrata', 'again', 'Big enough to share', 1600, [[21, ['Sam', 'Priya']], [74, ['Sam']]]],
      ['s-ragu', 's-orzolino', 'Short rib ragù', 'fine', 'Rich - half portion is plenty', 2600, [[160, []]]],
      ['s-tiramisu', 's-orzolino', 'Tiramisu', 'skip', 'Too sweet', 1100, [[21, ['Sam', 'Priya']]]],
      ['s-brisket', 's-hickory', 'Brisket', 'again', 'Get the fatty end', 2400, [[9, ['Jordan']], [55, ['Jordan', 'Alex']]]],
      ['s-ribs', 's-hickory', 'Pork ribs', 'fine', '', 2200, [[55, ['Jordan', 'Alex']]]],
      ['s-fries', 's-hickory', 'Fries', 'skip', 'Soggy - get the slaw instead', 600, [[9, ['Jordan']]]],
      ['s-tantan', 's-brothwick', 'Tantanmen', 'again', 'Ask for it spicy', 1700, [[33, []], [90, ['Priya']]]],
      ['s-gyoza', 's-brothwick', 'Pork gyoza', 'fine', '', 900, [[33, []]]],
      ['s-pastor', 's-lunabrava', 'Al pastor tacos', 'again', 'Pineapple on the side', 1200, [[3, ['Alex']], [40, ['Sam', 'Alex']], [120, []]]],
      ['s-elote', 's-lunabrava', 'Elote', 'again', '', 600, [[3, ['Alex']]]],
      ['s-queso', 's-lunabrava', 'Queso', 'skip', 'Gluey', 900, [[40, ['Sam', 'Alex']]]],
      ['s-bunbo', 's-kettlebird', 'Bún bò Huế', 'again', 'Medium spice is plenty', 1500, [[62, ['Priya']]]],
      ['s-banhmi', 's-kettlebird', 'Short rib bánh mì', 'fine', 'Messy but good', 1300, [[62, ['Priya']]]],
      ['s-shortrib', 's-copperwick', 'Braised short rib', 'again', 'Comes with the good mash', 3400, [[48, ['Jordan']]]],
      ['s-chicken', 's-copperwick', 'Roast chicken', 'fine', '', 2800, [[48, ['Jordan']]]],
      ['s-wedge', 's-copperwick', 'Wedge salad', 'skip', 'Mostly dressing', 1400, [[48, ['Jordan']]]],
      ['s-galbi', 's-gogi', 'Galbi short rib', 'again', 'Order two - it goes fast', 3200, [[47, ['Jordan', 'Sam']], [210, []]]],
      ['s-pajeon', 's-gogi', 'Kimchi pancake', 'again', '', 1500, [[47, ['Jordan', 'Sam']]]],
      ['s-japchae', 's-gogi', 'Japchae', 'fine', '', 1400, [[47, ['Jordan', 'Sam']]]],
      ['s-concha', 's-nubeluz', 'Concha', 'again', 'Go before 10, they sell out', 300, [[46, []]]],
      ['s-olla', 's-nubeluz', 'Café de olla', 'fine', '', 400, [[46, []]]],
      ['s-rogan', 's-saffron', 'Lamb rogan josh', 'again', 'Ask for it hot', 2100, [[45, ['Alex']]]],
      ['s-lassi', 's-saffron', 'Mango lassi', 'skip', 'Watery', 500, [[45, ['Alex']]]],
      ['s-oysters', 's-gullwing', 'Oysters', 'fine', 'Happy hour is the deal', 3000, [[44, ['Priya', 'Sam']]]],
      ['s-roll', 's-gullwing', 'Lobster roll', 'skip', 'Tiny for the price', 3800, [[44, ['Priya', 'Sam']]]],
    ];
    const dishes = D.map(([id, placeId, name, verdict, note, price, orders], i) => cleanDish({ id, placeId, name, verdict, note, price, orders: orders.map(([n, w]) => ({ day: d(n), with: w })), createdAt: at(300 - i), updatedAt: at(orders[0][0]) }, o));
    const W = [
      ['s-w-mole', 'The mole', 'Casa Lunaria', 'Fairhollow', 'Riverton', 'mexican', 'Priya', 12, 'Get it with the handmade tortillas', null],
      ['s-w-carbonara', 'The carbonara', 'Orzolino', 'Old Mill', 'Riverton', 'italian', 'Alex', 30, '', null],
      ['s-w-khao', 'Khao soi', 'Khao Lantern', 'Mapleward', 'Lakeport', 'thai', 'Jordan', 6, 'Extra crispy noodles on top', null],
      ['s-w-croissant', '', 'Butterbell Bakery', 'Quarry Hill', 'Riverton', 'cafe', 'Sam', 3, 'Their almond croissant, apparently', null],
      ['s-w-brisket', 'Brisket', 'Hickory & Hush', 'Canal Row', 'Riverton', 'bbq', 'Sam', 70, '', { day: d(55), verdict: 'again', dishId: 's-brisket' }],
    ];
    const wants = W.map(([id, dish, place, area, city, cuisine, from, n, note, done], i) => cleanWant({ id, dish, place, area, city, cuisine, from, day: d(n), note, done, createdAt: at(n), updatedAt: at(done ? 55 : n) - i }, o));
    return { places, dishes, wants, deleted: [] };
  }

  return {
    LIMITS, INVISIBLE, CUISINES, CUISINE_IDS, VERDICTS, VERDICT_IDS, CURRENCIES, CONFIDENCE, CSV_HEAD, SHARE_KEYS, SHARE_PLACE_KEYS, SHARE_DISH_KEYS, HISTORY_KEYS,
    line, plain, esc, plural, hasWord, listNames, stripLinks, plainOut, cleanPerson, cleanPeople, isId,
    fold, cityKey, placeKey, dishKey,
    isDay, addDays, daysBetween, shortDay, ago, localDay,
    currencyFor, isCurrency, money, decimal, readMoney, cents,
    isCuisine, cuisineOf, isVerdict, verdictOf,
    cleanPlace, cleanDish, cleanOrders, newPlace, quickAdd, logVisit, editDish, editPlace, removeIds, removePlace, lastDay, times,
    dishesAt, lastVisit, wantsAt, hereCard, hereLine,
    editDistance, matchScore, searchPlaces, searchDishes,
    citiesOf, cuisinesOf, placesIn, againList, stats,
    cleanWant, newWant, wantTitle, triedLine, tryWant, settleWants,
    sharePayload, shareRequest, shareView, wantFromShare, hasWant, topDishes,
    cleanTombstones, cleanList, syncPayload, mergeLists, listBytes, countOf,
    toJson, fromJson, csvCell, toCsv, dataCsv, parseCsv, fromCsv, importInto,
    menuRequest, historyFor, cleanMenu,
    sample,
  };
}));
