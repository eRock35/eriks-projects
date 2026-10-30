/* Sorted - the rules, in one file run three times: `window.SortedCore` in
 * the page, `require` in the server and in the tests.
 *
 * NO CLOCK AND NO DICE. Nothing here reads the time or makes a random
 * number: "now" (milliseconds), "today" (YYYY-MM-DD in the person's own day)
 * and every new id are handed in. No lookbehind regexes (older iPhones
 * cannot parse them), no storage, no network.
 *
 * What lives here:
 *   - text cleaning and escaping (every typed name, note, claim name and
 *     model answer goes through these);
 *   - the curated household emoji (about eighty), the rooms, conditions and
 *     where-to-sell labels, and the emoji guess for a typed name;
 *   - an item, and the decision deck: decide, undo, the queue;
 *   - the 10-minute sprint: time left with pauses, the recap line;
 *   - the piles: sell (listing text, price drops, money made), donate (bags,
 *     the itemised list), toss (generic hints), the Maybe box (its date, the
 *     .ics reminder);
 *   - the tally: by room, by week, the streak of days with a sprint;
 *   - up for grabs: what a published item and a friend's claim may hold;
 *   - the price estimate: what is sent, and what is accepted back;
 *   - the made-up sample closet for "Try it".
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SortedCore = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const LIMITS = {
    items: 600,              // things kept on one device
    name: 60,
    note: 200,
    priceCents: 100000000,   // a million, in any currency's cents
    sprintMs: 10 * 60 * 1000,
    sprintExtraMs: 5 * 60 * 1000,
    maybeDays: 30,
    priceDropDays: 7,
    priceDropPct: 15,
    undo: 30,
    url: 300,
    bags: 60,
    // up for grabs
    grabItems: 40,
    grabTitle: 140,
    grabNote: 140,
    grabFrom: 30,
    claimName: 30,
    grabDaysMin: 1,
    grabDaysMax: 14,
    grabDaysDefault: 7,
    grabsOpen: 3,
    grabKeepDays: 14,        // a closed or expired link is kept this long for the owner, then deleted
    thumbBytes: 60 * 1024,
    thumbSide: 320,
    // the price estimate
    aiTitle: 80,
    aiReason: 160,
    aiTip: 120,
    aiTips: 3,
    aiImageBytes: 560 * 1024,
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
    let s = String(v === null || v === undefined ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    const cps = Array.from(s);
    if (cps.length > max) s = cps.slice(0, max).join('').trim();
    return s;
  }
  /** A line with markup taken out as well - for anything other people read
   *  (a published item, a friend's name). Angle brackets never survive. */
  function plain(v, max) {
    const s = String(v === null || v === undefined ? '' : v).slice(0, max * 8 + 64);
    return line(s.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' '), max);
  }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function plural(n, word, many) { return `${n} ${n === 1 ? word : (many || `${word}s`)}`; }
  /** Links of any kind out of something a model wrote. */
  function stripLinks(s) {
    return String(s)
      .replace(/\b(?:https?|ftp|file|data|javascript|vbscript)\s*:\S*/gi, '')
      .replace(/\bwww\.\S+/gi, '')
      .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|uk|us|app|dev|info|biz|ly|me|tv|xyz|link|site|online|shop|store|example)\b\S*/gi, '');
  }
  /** A model's sentence: plain, no links, bounded. */
  function plainOut(v, max) {
    if (typeof v !== 'string') return '';
    return line(stripLinks(plain(v, max * 4)).replace(/\s+([,.!?;:])/g, '$1'), max);
  }
  const ID_RE = /^[a-z0-9-]{1,24}$/;
  const isId = (v) => typeof v === 'string' && ID_RE.test(v);
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isDay(v) {
    if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d);
    const back = new Date(t);
    return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
  }
  function dayMs(day) { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); }
  function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(day, n) { return dayOf(dayMs(day) + n * 86400000); }
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / 86400000); }
  /** Monday of the week a day is in. */
  function weekOf(day) { const wd = new Date(dayMs(day)).getUTCDay(); return addDays(day, -((wd + 6) % 7)); }
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDay(day) { if (!isDay(day)) return ''; const [, m, d] = day.split('-').map(Number); return `${MONTH_SHORT[m - 1]} ${d}`; }

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
  /** The currency for a locale like "en-GB" (USD when it cannot tell). */
  function currencyFor(locale) {
    const m = /[-_]([A-Za-z]{2})\b/.exec(String(locale || ''));
    return (m && REGION_CURRENCY[m[1].toUpperCase()]) || 'USD';
  }
  const isCurrency = (c) => CURRENCIES.includes(c);
  const SYMBOL = { USD: '$', CAD: '$', AUD: '$', NZD: '$', SGD: '$', MXN: '$', GBP: '£', EUR: '€', INR: '₹', ZAR: 'R', CHF: 'CHF ', SEK: 'kr ', NOK: 'kr ', DKK: 'kr ', PLN: 'zł ' };
  /** "$85", "£12.50". Whole amounts drop the pennies. */
  function money(cents, currency, locale) {
    const c = isCurrency(currency) ? currency : 'USD';
    const n = Math.round(Number(cents) || 0);
    const whole = n % 100 === 0;
    try {
      return new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: c, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(n / 100);
    } catch (e) {
      return `${n < 0 ? '-' : ''}${SYMBOL[c] || ''}${(Math.abs(n) / 100).toFixed(whole ? 0 : 2)}`;
    }
  }
  /** What someone typed as a price, in cents - or null. "free" and "" are
   *  no price (never $0.00); a negative is refused. "12", "12.5", "$1,240",
   *  "12,50" all read. */
  function readMoney(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v * 100 <= LIMITS.priceCents ? Math.round(v * 100) : null;
    let s = String(v === null || v === undefined ? '' : v).trim();
    if (!s || /^-|\(/.test(s) || !/\d/.test(s)) return null;
    s = s.replace(/[^\d.,]/g, '');
    if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    s = s.replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s) && !/^\d+\.$/.test(s)) return null;
    const cents = Math.round(parseFloat(s) * 100);
    return Number.isFinite(cents) && cents >= 0 && cents <= LIMITS.priceCents ? cents : null;
  }
  function cents(v) { return Number.isInteger(v) && v >= 0 && v <= LIMITS.priceCents ? v : null; }

  /* ------------------------------------------------------------------ *
   * The emoji: a curated set, each with a label, a kind (which drives the
   * toss hints) and the words that find it. A name finds its emoji from the
   * LAST word back (the head noun in English: "running shoes" are shoes),
   * longest phrase first at each word.
   * ------------------------------------------------------------------ */

  const EMOJI = [
    // clothes
    ['👕', 'T-shirt', 'clothes', 't shirt,tshirt,tee,tees,shirt,shirts,top,tops,polo,vest,tank top'],
    ['👔', 'Work shirt', 'clothes', 'work shirt,dress shirt,blouse,blouses,tie,ties,uniform'],
    ['👗', 'Dress', 'clothes', 'dress,dresses,gown,skirt,skirts'],
    ['👖', 'Jeans', 'clothes', 'jeans,trousers,pants,leggings,shorts,joggers,chinos'],
    ['🧥', 'Coat', 'clothes', 'coat,coats,jacket,jackets,blazer,parka,raincoat,hoodie,hoodies,fleece'],
    ['🧶', 'Jumper', 'clothes', 'jumper,jumpers,sweater,sweaters,cardigan,knitwear,sweatshirt,wool,yarn'],
    ['🧣', 'Scarf and gloves', 'clothes', 'scarf,scarves,shawl,blanket scarf,gloves,glove,mittens'],
    ['🧦', 'Socks', 'clothes', 'socks,sock,tights,stockings'],
    ['👙', 'Swimwear', 'clothes', 'swimsuit,swimwear,bikini,trunks,swimming costume'],
    ['👒', 'Hat', 'clothes', 'hat,hats,sun hat,sunhat,cap,caps,beanie,beanies,baseball cap'],
    ['🎭', 'Costume', 'clothes', 'costume,costumes,fancy dress,dressing up,dress up'],
    // shoes, bags, accessories
    ['👟', 'Trainers', 'shoes', 'shoes,shoe,trainers,sneakers,runners,running shoes'],
    ['👠', 'Heels', 'shoes', 'heels,high heels,pumps,stilettos'],
    ['👢', 'Boots', 'shoes', 'boots,boot,wellies,wellingtons'],
    ['🥾', 'Hiking boots', 'shoes', 'hiking boots,walking boots'],
    ['👡', 'Sandals', 'shoes', 'sandals,sandal,flip flops,flipflops,slides,slippers'],
    ['👜', 'Handbag', 'bags', 'bag,bags,handbag,handbags,purse,tote,clutch,briefcase,satchel'],
    ['🎒', 'Backpack', 'bags', 'backpack,backpacks,rucksack,school bag,schoolbag'],
    ['🧳', 'Suitcase', 'bags', 'suitcase,suitcases,luggage,holdall,duffel'],
    ['💍', 'Jewellery', 'bags', 'ring,rings,necklace,necklaces,jewellery,jewelry,earrings,bracelet,bracelets,watch,watches'],
    ['🕶️', 'Sunglasses', 'bags', 'sunglasses,shades'],
    // kids
    ['🧸', 'Toys', 'kids', 'teddy,teddies,teddy bear,soft toy,soft toys,plush,stuffed animal,stuffed animals,toy,toys,train set,trains,train,railway'],
    ['🧱', 'Building bricks', 'kids', 'lego,duplo,bricks,blocks,building blocks'],
    ['🧩', 'Puzzle', 'kids', 'puzzle,puzzles,jigsaw,jigsaws'],
    ['🎲', 'Board game', 'kids', 'board game,board games,game,games,cards,playing cards'],
    ['🖍️', 'Art supplies', 'kids', 'crayons,colouring,coloring,markers,felt tips,art supplies,paint set,stickers'],
    ['👶', 'Baby gear', 'kids', 'pram,stroller,buggy,pushchair,baby,bouncer,car seat,high chair,cot,crib,baby clothes,baby bottle,baby bottles,sippy cup,sippy cups,steriliser,sterilizer'],
    ['🛴', 'Scooter', 'kids', 'scooter,scooters,skateboard,skateboards,skates,roller skates,rollerblades'],
    ['🚲', 'Bike', 'sport', 'bike,bikes,bicycle,balance bike,trike,tricycle,helmet'],
    // kitchen
    ['🍳', 'Frying pan', 'kitchen', 'frying pan,pan,pans,skillet,wok'],
    ['🍲', 'Pot', 'kitchen', 'pot,pots,saucepan,saucepans,stockpot,slow cooker,crockpot,casserole dish,dutch oven'],
    ['🥣', 'Bowls', 'kitchen', 'bowl,bowls,mixing bowl,mixing bowls'],
    ['🍽️', 'Plates', 'kitchen', 'plate,plates,dinner set,dishes,crockery,dinnerware'],
    ['☕', 'Mugs', 'kitchen', 'mug,mugs,cup,cups,coffee cup,travel mug,flask,thermos,teapot,teapots,kettle'],
    ['🥂', 'Glasses', 'kitchen', 'wine glasses,glasses,champagne flutes,tumblers,glassware'],
    ['🍴', 'Cutlery', 'kitchen', 'cutlery,silverware,forks,spoons,utensils,knife,knives'],
    ['🥤', 'Blender', 'kitchen', 'blender,smoothie maker,juicer,food processor,mixer'],
    ['🍞', 'Toaster', 'kitchen', 'toaster,bread maker,breadmaker,sandwich maker,waffle maker'],
    ['🧁', 'Baking tins', 'kitchen', 'baking tin,baking tins,cake tin,muffin tray,baking tray,tray,trays,baking'],
    ['🥡', 'Containers', 'kitchen', 'tupperware,container,containers,lunchbox,lunch box,jar,jars,mason jars'],
    // tech
    ['💻', 'Computer things', 'tech', 'laptop,laptops,computer,computers,macbook,chromebook,pc,keyboard,mouse,webcam,router,printer,printers,scanner,ink,cartridges'],
    ['📱', 'Phone', 'tech', 'phone,phones,iphone,mobile,tablet,ipad,kindle,e reader'],
    ['🔌', 'Cables', 'tech', 'cable,cables,charger,chargers,adapter,adapters,lead,leads,plug,plugs,extension lead,power strip'],
    ['🎧', 'Headphones', 'tech', 'headphones,earbuds,earphones,headset,airpods'],
    ['📷', 'Camera', 'tech', 'camera,cameras,lens,lenses,tripod'],
    ['🎮', 'Games console', 'tech', 'console,consoles,controller,controllers,xbox,playstation,nintendo,switch,video game,video games'],
    ['📺', 'TV and audio', 'tech', 'tv,tvs,television,monitor,monitors,screen,dvd player,speaker,speakers,radio,stereo,soundbar'],
    ['🔋', 'Batteries', 'hazard', 'battery,batteries,power bank,powerbank'],
    // books, media, paper
    ['📚', 'Books', 'media', 'book,books,novel,novels,cookbook,cookbooks,textbook,textbooks,comics'],
    ['💿', 'CDs and DVDs', 'media', 'cd,cds,dvd,dvds,blu ray,bluray,vinyl,records,cassettes,video tapes'],
    ['📰', 'Magazines', 'paper', 'magazine,magazines,newspaper,newspapers,catalogues,catalogs'],
    ['📄', 'Papers', 'paper', 'papers,paperwork,documents,letters,receipts,bills,statements,manuals,folder,folders,files,binder'],
    ['📒', 'Notebooks', 'paper', 'notebook,notebooks,diary,diaries,journal,journals,planner'],
    ['🖊️', 'Stationery', 'paper', 'pen,pens,pencil,pencils,stationery,highlighters,stapler,scissors'],
    // furniture, decor, linen
    ['🪑', 'Chair', 'furniture', 'chair,chairs,stool,stools,table,tables,bench,shelf,shelves,bookcase'],
    ['🛋️', 'Sofa', 'furniture', 'sofa,sofas,couch,armchair,cushion,cushions,throw,beanbag'],
    ['🛏️', 'Bedding', 'linen', 'bedding,sheets,duvet,duvet cover,pillow,pillows,quilt,mattress,bed'],
    ['🧺', 'Towels', 'linen', 'towel,towels,bath mat,laundry basket,basket,baskets,tea towels'],
    ['🪞', 'Mirror', 'decor', 'mirror,mirrors'],
    ['🖼️', 'Frames', 'decor', 'frame,frames,picture,pictures,painting,paintings,poster,posters,art,print,prints'],
    ['🕯️', 'Candles', 'decor', 'candle,candles,candle holder,diffuser'],
    ['🏺', 'Ornaments', 'decor', 'vase,vases,ornament,ornaments,figurine,figurines,trinkets,clock,clocks'],
    ['💡', 'Lamp', 'decor', 'lamp,lamps,light,lights,fairy lights,lampshade'],
    ['🎄', 'Holiday decorations', 'decor', 'decorations,christmas decorations,baubles,tinsel,wreath'],
    // bathroom
    ['🧴', 'Toiletries', 'bath', 'lotion,lotions,shampoo,conditioner,toiletries,sunscreen,body wash,moisturiser,moisturizer,perfume,soap,toothbrush'],
    ['💄', 'Makeup', 'bath', 'makeup,make up,lipstick,cosmetics,nail polish,mascara,palette'],
    ['🪒', 'Grooming', 'bath', 'razor,razors,shaver,hairdryer,hair dryer,straighteners,curling iron,clippers'],
    ['💊', 'Medicines', 'bath', 'medicine,medicines,pills,vitamins,prescription'],
    // garage, tools, garden
    ['🔧', 'Tools', 'tools', 'tool,tools,wrench,spanner,drill,drills,sander,hammer,screwdriver,saw,torch,flashlight'],
    ['🧰', 'Toolbox', 'tools', 'toolbox,toolkit,tool box,tool kit'],
    ['🪜', 'Ladder', 'tools', 'ladder,ladders,stepladder,step stool'],
    ['🧹', 'Cleaning things', 'tools', 'broom,brush,vacuum,hoover,dustpan,mop,mops,bucket,buckets'],
    ['🌱', 'Garden things', 'garden', 'garden,gardening,seeds,hose,mower,lawnmower,strimmer,trimmer,rake,spade,shovel,plant,plants,planter,planters,plant pot'],
    ['🎨', 'Paint tins', 'hazard', 'paint,paints,paint tins,paint cans,varnish,primer'],
    ['🧪', 'Chemicals', 'hazard', 'chemicals,cleaner,cleaners,bleach,weedkiller,pesticide,solvent,white spirit,aerosol,aerosols'],
    ['🚗', 'Car things', 'tools', 'car,car parts,tyre,tyres,tire,tires,roof rack,car mats'],
    // sport, outdoors, music, everything else
    ['⛺', 'Camping', 'sport', 'tent,tents,camping,sleeping bag,sleeping bags,camping chair,air bed'],
    ['⚽', 'Sports gear', 'sport', 'ball,balls,football,soccer ball,basketball,rugby ball,golf,golf clubs,golf balls,clubs'],
    ['🎾', 'Racket', 'sport', 'racket,rackets,racquet,racquets,tennis,tennis racket,tennis balls,badminton,squash,pickleball,paddle,paddles'],
    ['🏋️', 'Weights', 'sport', 'weights,dumbbells,kettlebell,kettlebells,barbell,yoga mat,exercise mat,skis,ski,snowboard'],
    ['🎸', 'Instrument', 'music', 'guitar,guitars,ukulele,bass,amp,amplifier,piano,drum,drums,drum kit,violin,recorder'],
    ['🧵', 'Sewing and crafts', 'misc', 'sewing,sewing machine,fabric,thread,craft,crafts,knitting needles'],
    ['🐾', 'Pet things', 'misc', 'pet bed,dog bed,cat bed,leash,collar,crate,pet carrier,cat tree'],
    ['🎁', 'Gift', 'misc', 'gift,gifts,present,presents,unused gift,gift set'],
    ['📦', 'Box of things', 'misc', 'box,boxes,stuff,misc,bits,things'],
  ];
  const DEFAULT_EMOJI = '📦';
  /** The emoji as a set, with and without the variation selector, so a
   *  typed or synced one is accepted either way. */
  const EMOJI_SET = (function () {
    const m = new Map();
    for (const [e] of EMOJI) { m.set(e, e); m.set(e.replace(/\ufe0f/g, ''), e); }
    return m;
  }());
  const emojiOk = (e) => typeof e === 'string' && EMOJI_SET.has(e);
  const emojiOf = (e) => (emojiOk(e) ? EMOJI_SET.get(e) : null);
  const META = new Map(EMOJI.map(([e, label, kind]) => [e, { label, kind }]));
  function kindOf(emoji) { const m = META.get(emojiOf(emoji) || ''); return m ? m.kind : 'misc'; }
  function fold(s) {
    return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  const PHRASES = (function () {
    const m = new Map();
    for (const [e, , , words] of EMOJI) for (const w of words.split(',')) { const k = fold(w); if (k && !m.has(k)) m.set(k, e); }
    return m;
  }());
  function singular(w) {
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 4 && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }
  // Words that hold other things: "Lego box" is Lego, "bag of socks" is
  // socks. They only answer for themselves when nothing else in the name does.
  const CONTAINERS = new Set(['box', 'boxes', 'bag', 'bags', 'set', 'sets', 'pack', 'packs', 'bundle', 'bundles', 'lot', 'lots', 'pile', 'piles', 'bunch', 'pair', 'pairs', 'stack', 'stacks', 'collection', 'load', 'tub', 'tubs', 'crate', 'crates', 'basket', 'baskets']);
  /** The emoji a typed name would get, or null when nothing fits. */
  function guessEmoji(name) {
    const words = fold(name).split(' ').filter(Boolean).slice(0, 14);
    const at = (i, singleOk) => {
      for (let len = Math.min(3, i + 1); len >= (singleOk ? 1 : 2); len--) {
        const head = words.slice(i - len + 1, i);
        const exact = head.concat(words[i]).join(' ');
        if (PHRASES.has(exact)) return PHRASES.get(exact);
        const sing = head.concat(singular(words[i])).join(' ');
        if (PHRASES.has(sing)) return PHRASES.get(sing);
      }
      return null;
    };
    for (let i = words.length - 1; i >= 0; i--) {
      const hit = at(i, !CONTAINERS.has(words[i]));
      if (hit) return hit;
    }
    for (let i = words.length - 1; i >= 0; i--) {
      const hit = CONTAINERS.has(words[i]) && at(i, true);
      if (hit) return hit;
    }
    return null;
  }
  const emojiFor = (name) => guessEmoji(name) || DEFAULT_EMOJI;

  /* ------------------------------------------------------------------ *
   * Rooms, decisions, conditions, where to sell
   * ------------------------------------------------------------------ */

  const ROOMS = [
    { id: 'closet', label: 'Closet', emoji: '👗' },
    { id: 'kitchen', label: 'Kitchen', emoji: '🍳' },
    { id: 'kids', label: 'Kids’ room', emoji: '🧸' },
    { id: 'garage', label: 'Garage', emoji: '🧰' },
    { id: 'bathroom', label: 'Bathroom', emoji: '🧴' },
    { id: 'desk', label: 'Desk', emoji: '🖊️' },
    { id: 'other', label: 'Other', emoji: '📦' },
  ];
  const ROOM_IDS = ROOMS.map((r) => r.id);
  const roomOf = (id) => ROOMS.find((r) => r.id === id) || ROOMS[ROOMS.length - 1];

  // The four swipes and the button. Keep stays at home; the other three are
  // "leaving". Maybe goes in a box with a date on it.
  const DECISIONS = [
    { id: 'keep', label: 'Keep', verb: 'kept', dir: 'right', key: 'ArrowRight', icon: '🏠', leaving: false },
    { id: 'toss', label: 'Toss', verb: 'to toss', dir: 'left', key: 'ArrowLeft', icon: '🗑️', leaving: true },
    { id: 'sell', label: 'Sell', verb: 'to sell', dir: 'up', key: 'ArrowUp', icon: '🏷️', leaving: true },
    { id: 'donate', label: 'Donate', verb: 'to donate', dir: 'down', key: 'ArrowDown', icon: '💝', leaving: true },
    { id: 'maybe', label: 'Maybe', verb: 'in the Maybe box', dir: null, key: 'm', icon: '🤔', leaving: false },
  ];
  const DECISION_IDS = DECISIONS.map((d) => d.id);
  const decisionOf = (id) => DECISIONS.find((d) => d.id === id) || null;
  const LEAVING = ['toss', 'sell', 'donate'];

  const CONDITIONS = [
    { id: 'new', label: 'New, never used' },
    { id: 'like-new', label: 'Like new' },
    { id: 'good', label: 'Good' },
    { id: 'fair', label: 'Fair - some wear' },
    { id: 'worn', label: 'Well loved' },
  ];
  const CONDITION_IDS = CONDITIONS.map((c) => c.id);
  const conditionLabel = (id) => (CONDITIONS.find((c) => c.id === id) || {}).label || '';

  const WHERE = [
    { id: 'marketplace', label: 'Marketplace' },
    { id: 'ebay', label: 'eBay' },
    { id: 'vinted', label: 'Vinted / Poshmark' },
    { id: 'yard', label: 'A yard sale' },
    { id: 'consign', label: 'Consignment' },
    { id: 'other', label: 'Somewhere else' },
  ];
  const WHERE_IDS = WHERE.map((w) => w.id);
  const whereLabel = (id) => (WHERE.find((w) => w.id === id) || {}).label || '';
  const SELL_STATUS = [
    { id: 'to-list', label: 'To list' },
    { id: 'listed', label: 'Listed' },
    { id: 'sold', label: 'Sold' },
    { id: 'unsold', label: 'Didn’t sell' },
  ];
  const SELL_IDS = SELL_STATUS.map((s) => s.id);

  /** An https link, or ''. No credentials, no other scheme, bounded. */
  function cleanUrl(v) {
    const s = line(v, LIMITS.url);
    if (!/^https:\/\//i.test(s)) return '';
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' || u.username || u.password || !u.hostname || !/\./.test(u.hostname)) return '';
      return u.href.length <= LIMITS.url ? u.href : '';
    } catch (e) { return ''; }
  }

  /* ------------------------------------------------------------------ *
   * An item. One door for typed, stored and sample items alike.
   * ------------------------------------------------------------------ */

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  /**
   * @param raw  anything
   * @param o    {nowMs}
   * @returns    the item, or null when it has no name or id
   */
  function cleanItem(raw, o) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = isId(raw.id) ? raw.id : null;
    const name = line(raw.name, LIMITS.name);
    if (!id || !name) return null;
    const now = (o && num(o.nowMs)) || 0;
    const created = num(raw.createdAt);
    const decision = DECISION_IDS.includes(raw.decision) ? raw.decision : null;
    const item = {
      id,
      name,
      emoji: emojiOf(raw.emoji) || emojiFor(name),
      room: ROOM_IDS.includes(raw.room) ? raw.room : 'other',
      paid: cents(raw.paid),
      cond: CONDITION_IDS.includes(raw.cond) ? raw.cond : '',
      note: line(raw.note, LIMITS.note),
      photo: raw.photo === true,
      createdAt: created !== null && created > 0 && (!now || created <= now + 86400000) ? created : now,
      sprint: isId(raw.sprint) ? raw.sprint : null,
      decision,
      decidedAt: decision ? num(raw.decidedAt) : null,
      decidedDay: decision && isDay(raw.decidedDay) ? raw.decidedDay : null,
      outAt: num(raw.outAt),
      outDay: isDay(raw.outDay) ? raw.outDay : null,
      sell: cleanSell(raw.sell),
      donate: cleanDonate(raw.donate),
      maybe: raw.maybe && isDay(raw.maybe.until) ? { until: raw.maybe.until, from: isDay(raw.maybe.from) ? raw.maybe.from : null } : null,
      estimate: cleanStoredEstimate(raw.estimate),
    };
    if (!item.outAt) { item.outAt = null; item.outDay = null; }
    return item;
  }
  function cleanSell(s) {
    if (!s || typeof s !== 'object') return null;
    return {
      ask: cents(s.ask),
      where: WHERE_IDS.includes(s.where) ? s.where : '',
      url: cleanUrl(s.url),
      status: SELL_IDS.includes(s.status) ? s.status : 'to-list',
      listedDay: isDay(s.listedDay) ? s.listedDay : null,
      droppedDay: isDay(s.droppedDay) ? s.droppedDay : null,
      sold: cents(s.sold),
      soldDay: isDay(s.soldDay) ? s.soldDay : null,
    };
  }
  function cleanDonate(d) {
    if (!d || typeof d !== 'object') return null;
    return { bag: isId(d.bag) ? d.bag : null, value: cents(d.value) };
  }
  function cleanStoredEstimate(e) {
    if (!e || typeof e !== 'object') return null;
    const low = cents(e.low); const high = cents(e.high);
    if (low === null || high === null || high < low) return null;
    return { low, high, currency: isCurrency(e.currency) ? e.currency : 'USD', confidence: ['low', 'medium', 'high'].includes(e.confidence) ? e.confidence : 'low', title: plainOut(e.title, LIMITS.aiTitle) };
  }
  /** A new item from what was typed. */
  function newItem(input, o) {
    return cleanItem({
      id: o.id,
      name: input.name,
      emoji: input.emoji,
      room: input.room,
      paid: typeof input.paid === 'number' ? input.paid : readMoney(input.paid),
      cond: input.cond,
      note: input.note,
      photo: input.photo === true,
      createdAt: o.nowMs,
      sprint: o.sprint || null,
    }, o);
  }

  /* ------------------------------------------------------------------ *
   * The deck: decide, undo, the queue.
   *
   * A deck is {items: {id: item}, history: [{id, before}]}. Decisions are
   * pure: they return a new deck and never touch the one passed in.
   * ------------------------------------------------------------------ */

  const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  function deckOf(items) {
    const out = { items: {}, history: [] };
    for (const it of items || []) if (it && it.id) out.items[it.id] = copy(it);
    return out;
  }
  /** The undecided items, oldest first (the order they were added). */
  function queue(deck, sprintId) {
    return Object.values(deck.items).filter((it) => !it.decision && (!sprintId || it.sprint === sprintId))
      .sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
  }
  /** The item as it is once `decision` is made. */
  function withDecision(item, decision, o) {
    const it = copy(item);
    if (!DECISION_IDS.includes(decision)) return it;
    it.decision = decision;
    it.decidedAt = o.nowMs;
    it.decidedDay = o.today;
    if (decision === 'sell') {
      const ask = o.ask !== undefined && o.ask !== null ? cents(o.ask) : (it.sell && it.sell.ask);
      it.sell = Object.assign({ ask: null, where: '', url: '', status: 'to-list', listedDay: null, droppedDay: null, sold: null, soldDay: null }, it.sell || {}, { ask: ask === undefined ? null : ask });
      if (it.sell.status === 'unsold') it.sell.status = 'to-list';
    }
    if (decision === 'donate') it.donate = Object.assign({ bag: null, value: null }, it.donate || {});
    if (decision === 'maybe') it.maybe = { from: o.today, until: addDays(o.today, LIMITS.maybeDays) };
    else it.maybe = null;
    // A new pile starts over: out of the house is decided again there.
    if (item.decision !== decision || decision === 'keep' || decision === 'maybe') { it.outAt = null; it.outDay = null; }
    return it;
  }
  /** Decide one item; the old copy goes on the undo stack. */
  function decide(deck, id, decision, o) {
    const cur = deck.items[id];
    if (!cur || !DECISION_IDS.includes(decision)) return deck;
    const next = { items: Object.assign({}, deck.items), history: deck.history.concat([{ id, before: copy(cur) }]).slice(-LIMITS.undo) };
    next.items[id] = withDecision(cur, decision, o);
    return next;
  }
  /** Put the last decided item back exactly as it was. */
  function undo(deck) {
    if (!deck.history.length) return { deck, id: null };
    const last = deck.history[deck.history.length - 1];
    const next = { items: Object.assign({}, deck.items), history: deck.history.slice(0, -1) };
    if (last.before) next.items[last.id] = copy(last.before);
    return { deck: next, id: last.id };
  }
  /** Which decision a drag means, or null: past `threshold` pixels in the
   *  stronger direction (a short flick counts with speed). */
  function dragDecision(dx, dy, o) {
    const t = (o && o.threshold) || 110;
    const ax = Math.abs(dx); const ay = Math.abs(dy);
    const vx = Math.abs((o && o.vx) || 0); const vy = Math.abs((o && o.vy) || 0);
    if (ax >= ay) {
      if (ax >= t || (ax >= t / 3 && vx > 0.6)) return dx > 0 ? 'keep' : 'toss';
    } else if (ay >= t || (ay >= t / 3 && vy > 0.6)) return dy < 0 ? 'sell' : 'donate';
    return null;
  }
  /** While dragging: which label shows, and how strongly (0..1). */
  function dragHint(dx, dy, threshold) {
    const t = threshold || 110;
    const ax = Math.abs(dx); const ay = Math.abs(dy);
    if (ax < 8 && ay < 8) return { decision: null, strength: 0 };
    const decision = ax >= ay ? (dx > 0 ? 'keep' : 'toss') : (dy < 0 ? 'sell' : 'donate');
    return { decision, strength: Math.min(1, Math.max(ax, ay) / t) };
  }

  /* ------------------------------------------------------------------ *
   * The 10-minute sprint
   * ------------------------------------------------------------------ */

  function newSprint(room, o) {
    return { id: o.id, room: ROOM_IDS.includes(room) ? room : 'other', day: o.today, startedAt: o.nowMs, durationMs: LIMITS.sprintMs, pausedAt: null, pausedMs: 0, endedAt: null };
  }
  function cleanSprint(s) {
    if (!s || typeof s !== 'object' || !isId(s.id) || !isDay(s.day)) return null;
    const started = num(s.startedAt);
    if (started === null) return null;
    return {
      id: s.id, room: ROOM_IDS.includes(s.room) ? s.room : 'other', day: s.day, startedAt: started,
      durationMs: Math.min(LIMITS.sprintMs * 4, Math.max(60000, num(s.durationMs) || LIMITS.sprintMs)),
      pausedAt: num(s.pausedAt), pausedMs: Math.max(0, num(s.pausedMs) || 0), endedAt: num(s.endedAt),
    };
  }
  /** Time spent sorting (pauses not counted). */
  function sprintElapsed(s, now) {
    const end = s.endedAt || now;
    const pausedNow = s.pausedAt && !s.endedAt ? Math.max(0, now - s.pausedAt) : 0;
    return Math.max(0, end - s.startedAt - s.pausedMs - pausedNow);
  }
  function sprintLeft(s, now) { return Math.max(0, s.durationMs - sprintElapsed(s, now)); }
  function sprintOver(s, now) { return Boolean(s.endedAt) || sprintLeft(s, now) === 0; }
  function pauseSprint(s, now) { return s.pausedAt || s.endedAt ? s : Object.assign({}, s, { pausedAt: now }); }
  function resumeSprint(s, now) { return !s.pausedAt || s.endedAt ? s : Object.assign({}, s, { pausedAt: null, pausedMs: s.pausedMs + Math.max(0, now - s.pausedAt) }); }
  /** Five more minutes, from now if time had already run out. */
  function extendSprint(s, now) {
    if (s.endedAt) return s;
    const used = sprintElapsed(s, now);
    return Object.assign({}, s, { durationMs: Math.max(s.durationMs, used) + LIMITS.sprintExtraMs });
  }
  function endSprint(s, now) {
    if (s.endedAt) return s;
    const r = resumeSprint(s, now);
    // Ended after the time ran out: the sprint ends when it did, not now.
    const end = Math.min(now, r.startedAt + r.pausedMs + r.durationMs);
    return Object.assign({}, r, { endedAt: Math.max(r.startedAt, end) });
  }
  /** "9:58". */
  function clock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  /** "10 minutes", "a minute", "under a minute". */
  function minutesWord(ms) {
    const m = Math.round(ms / 60000);
    if (ms < 45000) return 'under a minute';
    if (m <= 1) return 'a minute';
    return `${m} minutes`;
  }
  const askOf = (it) => (it.sell && cents(it.sell.ask)) || (it.estimate ? Math.round((it.estimate.low + it.estimate.high) / 2) : null) || cents(it.tryAsk);
  /**
   * The recap of a run of decisions.
   * @param items  the items in it (decided or not)
   * @param ms     how long it took
   * @returns      {count, counts, sellCents, line, parts}
   *   "12 things in 10 minutes - 5 to donate, 3 to sell (about $85), 3 to toss, 1 kept"
   */
  function recap(items, ms, o) {
    const decided = items.filter((it) => it.decision);
    const counts = { keep: 0, toss: 0, sell: 0, donate: 0, maybe: 0 };
    for (const it of decided) counts[it.decision]++;
    const sellCents = decided.filter((it) => it.decision === 'sell').reduce((n, it) => n + (askOf(it) || 0), 0);
    const cur = (o && o.currency) || 'USD';
    const parts = [];
    if (counts.donate) parts.push(`${counts.donate} to donate`);
    if (counts.sell) parts.push(`${counts.sell} to sell${sellCents ? ` (about ${money(sellCents, cur, o && o.locale)})` : ''}`);
    if (counts.toss) parts.push(`${counts.toss} to toss`);
    if (counts.maybe) parts.push(`${counts.maybe} in the Maybe box`);
    if (counts.keep) parts.push(`${counts.keep} kept`);
    const head = `${plural(decided.length, 'thing')} in ${minutesWord(ms)}`;
    return { count: decided.length, counts, sellCents, leaving: counts.toss + counts.sell + counts.donate, parts, line: parts.length ? `${head} - ${parts.join(', ')}` : head };
  }

  /** Days in a row with a sprint. A run is alive through today if the last
   *  sprint was today or yesterday (yesterday's still counts until a whole
   *  day goes by with none). */
  function streak(days, today) {
    const set = new Set((days || []).filter(isDay));
    let best = 0; let run = 0; let prev = null;
    for (const d of [...set].sort()) {
      run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
      best = Math.max(best, run);
      prev = d;
    }
    let from = set.has(today) ? today : (set.has(addDays(today, -1)) ? addDays(today, -1) : null);
    let current = 0;
    while (from && set.has(from)) { current++; from = addDays(from, -1); }
    return { current, best, today: set.has(today), pending: !set.has(today) && current > 0 };
  }

  /* ------------------------------------------------------------------ *
   * Out of the house, by room, by week
   * ------------------------------------------------------------------ */

  const isOut = (it) => Boolean(it.outAt);
  const leaving = (it) => LEAVING.includes(it.decision);
  /** Per room: sorted, leaving and out - only rooms with something in them. */
  function roomStats(items) {
    return ROOMS.map((r) => {
      const mine = items.filter((it) => it.room === r.id);
      const sorted = mine.filter((it) => it.decision).length;
      const out = { room: r.id, label: r.label, emoji: r.emoji, total: mine.length, sorted, waiting: mine.length - sorted, leaving: mine.filter(leaving).length, out: mine.filter(isOut).length };
      out.line = `${r.label}: ${sorted} sorted, ${out.leaving} leaving`;
      return out;
    }).filter((r) => r.total > 0);
  }
  /** The last `n` weeks (Monday first), oldest first. */
  function weeks(today, n) {
    const out = [];
    let w = weekOf(today);
    for (let i = 0; i < n; i++) { out.unshift(w); w = addDays(w, -7); }
    return out;
  }
  /**
   * The tally.
   * @returns {out, made, sold, bagsDonated, bagsOpen, sorted, waiting, kept,
   *           leaving, maybe, byWeek: [{week, label, keep, toss, sell, donate, maybe, total}],
   *           rooms, headline}
   */
  function tally(items, bags, o) {
    const today = o.today;
    const cur = o.currency || 'USD';
    const sold = items.filter((it) => it.decision === 'sell' && it.sell && it.sell.status === 'sold');
    const made = sold.reduce((n, it) => n + (cents(it.sell.sold) || 0), 0);
    const dropped = (bags || []).filter((b) => b.droppedDay);
    const out = items.filter(isOut).length;
    const byWeek = weeks(today, o.weeks || 8).map((w) => {
      const end = addDays(w, 6);
      const row = { week: w, label: shortDay(w), keep: 0, toss: 0, sell: 0, donate: 0, maybe: 0, total: 0, out: 0 };
      for (const it of items) {
        if (it.decision && it.decidedDay && it.decidedDay >= w && it.decidedDay <= end) { row[it.decision]++; row.total++; }
        if (it.outDay && it.outDay >= w && it.outDay <= end) row.out++;
      }
      return row;
    });
    const res = {
      total: items.length,
      sorted: items.filter((it) => it.decision).length,
      waiting: items.filter((it) => !it.decision).length,
      kept: items.filter((it) => it.decision === 'keep').length,
      leaving: items.filter(leaving).length,
      maybe: items.filter((it) => it.decision === 'maybe').length,
      out,
      made,
      sold: sold.length,
      bagsDonated: dropped.length,
      bagsOpen: (bags || []).length - dropped.length,
      byWeek,
      rooms: roomStats(items),
    };
    res.headline = `${plural(out, 'thing')} out of the house · ${money(made, cur, o.locale)} made · ${plural(dropped.length, 'bag')} donated`;
    return res;
  }

  /* ------------------------------------------------------------------ *
   * The sell pile
   * ------------------------------------------------------------------ */

  /** 15% off, to a whole unit, and at least one unit less - or null when
   *  there is nothing sensible to take off. */
  function dropPrice(ask) {
    const a = cents(ask);
    if (!a || a < 200) return null;
    const next = Math.floor((a * (100 - LIMITS.priceDropPct)) / 100 / 100) * 100;
    return next >= 100 && next < a ? next : null;
  }
  /** Things listed for more than a week (since listing, or since the last
   *  drop) with a price drop to suggest. */
  function priceDrops(items, today) {
    const out = [];
    for (const it of items) {
      if (it.decision !== 'sell' || !it.sell || it.sell.status !== 'listed') continue;
      const since = [it.sell.listedDay, it.sell.droppedDay].filter(isDay).sort().pop();
      if (!since) continue;
      const days = daysBetween(since, today);
      const to = dropPrice(it.sell.ask);
      if (days > LIMITS.priceDropDays && to) out.push({ id: it.id, name: it.name, emoji: it.emoji, days, from: it.sell.ask, to });
    }
    return out.sort((a, b) => b.days - a.days);
  }
  /** A plain listing to paste anywhere: name, condition, price, note. */
  function listingText(it, o) {
    const cur = (o && o.currency) || 'USD';
    const lines = [it.name];
    const cond = conditionLabel(it.cond);
    if (cond) lines.push(`Condition: ${cond}`);
    const ask = it.sell && cents(it.sell.ask);
    lines.push(ask ? `Price: ${money(ask, cur, o && o.locale)}` : 'Price: make me an offer');
    if (it.note) lines.push('', it.note);
    lines.push('', 'Pick up from me, or I can meet nearby. Message me if you’re interested.');
    return lines.join('\n');
  }
  /** Money made, and what is still out there. */
  function sellSummary(items) {
    const sell = items.filter((it) => it.decision === 'sell' && it.sell);
    const by = (st) => sell.filter((it) => it.sell.status === st);
    return {
      made: by('sold').reduce((n, it) => n + (cents(it.sell.sold) || 0), 0),
      sold: by('sold').length,
      listed: by('listed').length,
      toList: by('to-list').length,
      asking: sell.filter((it) => it.sell.status !== 'sold').reduce((n, it) => n + (cents(it.sell.ask) || 0), 0),
    };
  }

  /* ------------------------------------------------------------------ *
   * The donate pile: bags and the itemised list
   * ------------------------------------------------------------------ */

  function cleanBag(b) {
    if (!b || typeof b !== 'object' || !isId(b.id)) return null;
    const n = Number.isInteger(b.n) && b.n > 0 && b.n < 10000 ? b.n : 1;
    return { id: b.id, n, droppedDay: isDay(b.droppedDay) ? b.droppedDay : null, where: line(b.where, 60) };
  }
  function bagRows(items, bags) {
    return (bags || []).map((b) => {
      const inBag = items.filter((it) => it.decision === 'donate' && it.donate && it.donate.bag === b.id);
      return { id: b.id, n: b.n, droppedDay: b.droppedDay, where: b.where, count: inBag.length, items: inBag, line: `Bag ${b.n}: ${plural(inBag.length, 'item')}${b.droppedDay ? ' - dropped off' : ''}` };
    });
  }
  /** The itemised list, as plain text for the person's own records. */
  function donationText(items, bags, o) {
    const cur = (o && o.currency) || 'USD';
    const rows = items.filter((it) => it.decision === 'donate');
    const bagN = new Map((bags || []).map((b) => [b.id, b]));
    const lines = ['Donated items', 'Keep your donation receipt; values are your own estimates.', ''];
    let total = 0;
    for (const it of rows) {
      const b = it.donate && it.donate.bag ? bagN.get(it.donate.bag) : null;
      const v = it.donate && cents(it.donate.value);
      if (v) total += v;
      lines.push(`- ${it.name}${it.cond ? ` (${conditionLabel(it.cond)})` : ''}${b ? ` - Bag ${b.n}${b.droppedDay ? `, dropped off ${shortDay(b.droppedDay)}` : ''}` : ''}${v ? ` - est. ${money(v, cur, o && o.locale)}` : ''}`);
    }
    lines.push('', `${plural(rows.length, 'item')}${total ? ` · your estimated total ${money(total, cur, o && o.locale)}` : ''}`);
    return lines.join('\n');
  }
  /** RFC 4180 CSV, with formulas defused (a leading = + - @ tab or CR). */
  function csvCell(v) {
    let s = String(v === null || v === undefined ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCsv(rows) { return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
  function donationCsv(items, bags, o) {
    const bagN = new Map((bags || []).map((b) => [b.id, b]));
    const rows = [['Item', 'Condition', 'Room', 'Bag', 'Dropped off', `Your estimated value (${(o && o.currency) || 'USD'})`]];
    for (const it of items.filter((x) => x.decision === 'donate')) {
      const b = it.donate && it.donate.bag ? bagN.get(it.donate.bag) : null;
      const v = it.donate && cents(it.donate.value);
      rows.push([it.name, conditionLabel(it.cond), roomOf(it.room).label, b ? `Bag ${b.n}` : '', b && b.droppedDay ? b.droppedDay : '', v ? (v / 100).toFixed(2) : '']);
    }
    return toCsv(rows);
  }

  /* ------------------------------------------------------------------ *
   * The toss pile: generic hints, never a claim about local rules.
   * ------------------------------------------------------------------ */

  const TOSS_RULES_LINE = 'Rules differ from place to place - check your council’s or city’s rules before anything goes in the bin.';
  const TOSS_TIPS = {
    textiles: { title: 'Clothes, shoes, bags and linen', text: 'Too worn to donate? Many textile banks take worn and torn fabric for recycling - bag it separately and label it. Tie pairs of shoes together. Animal shelters often welcome old towels and bedding.' },
    tech: { title: 'Anything with a plug or a battery', text: 'Electronics, cables and chargers are e-waste, not bin waste. Many places have e-waste drop-off points, and some shops take old devices back. Wipe and sign out of anything that held your data first.' },
    hazard: { title: 'Batteries, paint and chemicals', text: 'These need a hazardous-waste or battery drop-off - never the bin or the drain. Tape the ends of lithium batteries and keep chemicals in their own containers.' },
    paper: { title: 'Paper, books and discs', text: 'Paper and card usually recycle; shred anything with your name, address or account numbers first. Discs and cassettes usually don’t go in household recycling.' },
    kitchen: { title: 'Kitchen things', text: 'Glass jars and metal tins usually recycle once rinsed. Broken glass and ceramics usually don’t - wrap them before they go in the bin. Old metal pans may count as scrap metal.' },
    kids: { title: 'Toys and baby things', text: 'Take the batteries out of toys first (they go to a battery drop-off). Hard plastic toys are often not accepted in household recycling. Car seats past their date shouldn’t be passed on.' },
    furniture: { title: 'Furniture', text: 'Big things usually need a bulky-item collection or a trip to a recycling centre. Upholstered furniture often can’t be donated without its fire-safety label.' },
    decor: { title: 'Decor and lighting', text: 'Light bulbs, especially energy-saving ones, often need their own drop-off. Mirrors and window glass don’t go in glass recycling - wrap them for the bin.' },
    bath: { title: 'Bathroom things', text: 'Rinsed bottles often recycle. Unused or out-of-date medicines go back to a pharmacy - never in the bin or down the toilet.' },
    tools: { title: 'Tools and garage things', text: 'Metal tools may count as scrap metal. Car batteries, oil and tyres each have their own drop-off; garden and car chemicals are hazardous waste.' },
    other: { title: 'Everything else', text: 'If it can’t be reused or recycled where you live, the bin is fine - check first.' },
  };
  const KIND_TIP = { clothes: 'textiles', shoes: 'textiles', bags: 'textiles', linen: 'textiles', tech: 'tech', hazard: 'hazard', paper: 'paper', media: 'paper', kitchen: 'kitchen', kids: 'kids', furniture: 'furniture', decor: 'decor', bath: 'bath', tools: 'tools', garden: 'tools', sport: 'other', music: 'tech', misc: 'other' };
  function tossTipFor(it) { return KIND_TIP[kindOf(it.emoji)] || 'other'; }
  /** The toss pile grouped by hint, in a fixed order. */
  function tossGroups(items) {
    const order = Object.keys(TOSS_TIPS);
    const groups = new Map();
    for (const it of items.filter((x) => x.decision === 'toss')) {
      const k = tossTipFor(it);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    return order.filter((k) => groups.has(k)).map((k) => ({ tip: k, title: TOSS_TIPS[k].title, text: TOSS_TIPS[k].text, items: groups.get(k) }));
  }

  /* ------------------------------------------------------------------ *
   * The Maybe box: a date thirty days out, an .ics reminder.
   *
   * FLOATING local time (DTSTART:20261129T100000, no TZID, no Z), as Tada's
   * bedtime reminder is: 10 AM wherever the phone is, and iOS and macOS
   * Calendar import a floating event as exactly that. A TZID would need a
   * VTIMEZONE to be correct, and building one from Intl alone means guessing
   * each zone's yearly rule.
   * ------------------------------------------------------------------ */

  function maybeState(it, today) {
    if (it.decision !== 'maybe' || !it.maybe) return null;
    const left = daysBetween(today, it.maybe.until);
    return { until: it.maybe.until, left, due: left <= 0, line: left > 1 ? `Opens ${shortDay(it.maybe.until)} - in ${left} days` : left === 1 ? `Opens tomorrow, ${shortDay(it.maybe.until)}` : left === 0 ? 'Due today' : `Due since ${shortDay(it.maybe.until)}` };
  }
  function maybeDue(items, today) { return items.filter((it) => { const s = maybeState(it, today); return s && s.due; }); }
  /** The next date something comes out of the box, and what. */
  function maybeNext(items, today) {
    const dates = items.filter((it) => it.decision === 'maybe' && it.maybe).map((it) => it.maybe.until).sort();
    const next = dates.find((d) => d >= today) || null;
    return next ? { day: next, items: items.filter((it) => it.decision === 'maybe' && it.maybe && it.maybe.until === next) } : null;
  }
  function icsText(v) {
    return String(v === null || v === undefined ? '' : v).replace(INVISIBLE, '')
      .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
  }
  function utf8Len(ch) { const c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  /** Lines folded at 75 octets of UTF-8, never inside a character. */
  function icsFold(l) {
    const out = [];
    let cur = ''; let bytes = 0;
    for (const ch of Array.from(l)) {
      const n = utf8Len(ch);
      if (bytes + n > 75) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch; bytes += n;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  function stampOf(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
  /**
   * A reminder to open the Maybe box on `day` at 10 AM local (floating).
   * @param names  the things coming out that day
   */
  function maybeIcs(day, names, o) {
    const list = (names || []).map((n) => line(n, LIMITS.name)).filter(Boolean).slice(0, 40);
    const desc = [
      'Time to open the Maybe box.',
      'If you haven’t needed these since you boxed them, let them go:',
      ...list.map((n) => `- ${n}`),
      'Open Sorted to decide.',
    ].join('\n');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sorted//Maybe box//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:sorted-maybe-${day.replace(/-/g, '')}@sorted`,
      `DTSTAMP:${stampOf(o.nowMs)}`,
      `DTSTART:${day.replace(/-/g, '')}T100000`,
      'DURATION:PT15M',
      `SUMMARY:${icsText(`Open the Maybe box (${plural(list.length, 'thing')})`)}`,
      `DESCRIPTION:${icsText(desc)}`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText('Open the Maybe box')}`, 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ];
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ *
   * Up for grabs: what a published item and a claim may hold.
   *
   * A published item carries a name, an optional short note, a price if it
   * came from the Sell pile, its emoji and whether it has a photo (the
   * thumbnail itself travels separately and is checked by its bytes on the
   * server). Nothing else: no room, no paid price, no id from this device.
   * ------------------------------------------------------------------ */

  const GRAB_TITLE_DEFAULT = 'Before it goes to the charity shop on Saturday - anything you want?';
  const FRIEND = 'A friend';
  /** A first name as other people will read it: no markup, no invisible
   *  characters, bounded - and it must have a letter or a digit in it. */
  function cleanName(v, max) {
    const s = plain(v, max || LIMITS.claimName);
    return /[\p{L}\p{N}]/u.test(s) ? s : '';
  }
  /**
   * The body of "make a link", rebuilt field by field.
   * @returns {title, from, days, items: [{name, note, emoji, price, currency, photo}]} or null
   */
  function grabRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (Object.keys(body).some((k) => !['title', 'from', 'days', 'items', 'currency'].includes(k))) return null;
    const days = Number.isInteger(body.days) ? body.days : LIMITS.grabDaysDefault;
    if (days < LIMITS.grabDaysMin || days > LIMITS.grabDaysMax) return null;
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > LIMITS.grabItems) return null;
    const currency = isCurrency(body.currency) ? body.currency : 'USD';
    const items = [];
    for (const raw of body.items) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      if (Object.keys(raw).some((k) => !['name', 'note', 'emoji', 'price', 'photo'].includes(k))) return null;
      const name = plain(raw.name, LIMITS.name);
      if (!name) return null;
      const price = raw.price === null || raw.price === undefined ? null : cents(raw.price);
      if (raw.price !== null && raw.price !== undefined && price === null) return null;
      items.push({ name, note: plain(raw.note, LIMITS.grabNote), emoji: emojiOf(raw.emoji) || emojiFor(name), price, photo: raw.photo === true });
    }
    return {
      title: plain(body.title, LIMITS.grabTitle) || GRAB_TITLE_DEFAULT,
      from: cleanName(body.from, LIMITS.grabFrom) || FRIEND,
      days,
      currency,
      items,
    };
  }

  /* ------------------------------------------------------------------ *
   * The price estimate (metered; signed in only)
   * ------------------------------------------------------------------ */

  const CONFIDENCE = ['low', 'medium', 'high'];
  /** What the page sends: the one item's name, its condition, the currency -
   *  and its photo, if it has one. Anything else is a 400. */
  function estimateRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (Object.keys(body).some((k) => !['name', 'cond', 'currency', 'image'].includes(k))) return null;
    const name = plain(body.name, LIMITS.name);
    if (!name) return null;
    const cond = body.cond === undefined || body.cond === '' ? '' : (CONDITION_IDS.includes(body.cond) ? body.cond : null);
    if (cond === null) return null;
    const currency = body.currency === undefined ? 'USD' : (isCurrency(body.currency) ? body.currency : null);
    if (!currency) return null;
    let image = null;
    if (body.image !== undefined && body.image !== null) {
      const im = body.image;
      if (!im || typeof im !== 'object' || Array.isArray(im) || Object.keys(im).some((k) => k !== 'type' && k !== 'data')) return null;
      if (!['image/jpeg', 'image/png'].includes(im.type) || typeof im.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(im.data)) return null;
      if (Math.floor(im.data.length * 3 / 4) > LIMITS.aiImageBytes + 3) return null;
      image = { type: im.type, data: im.data };
    }
    return { name, cond, currency, image };
  }
  /** The payload the page shows before sending, then sends. */
  function estimatePayload(it, image, currency) {
    const out = { name: it.name, cond: it.cond || '', currency: isCurrency(currency) ? currency : 'USD' };
    if (image) out.image = image;
    return out;
  }
  function wholeCents(v) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN);
    if (!Number.isFinite(n) || n < 0 || n > LIMITS.priceCents / 100) return null;
    return Math.round(n) * 100;
  }
  /** The model's answer, checked: whole amounts at or above zero with high
   *  at or above low, a known confidence, short plain sentences, no links. */
  function cleanEstimate(raw, req) {
    if (!raw || typeof raw !== 'object') return null;
    let low = wholeCents(raw.low); let high = wholeCents(raw.high);
    if (low === null || high === null) return null;
    if (high < low) { const t = low; low = high; high = t; }
    const tips = (Array.isArray(raw.tips) ? raw.tips : []).map((t) => plainOut(t, LIMITS.aiTip)).filter(Boolean);
    const seen = new Set();
    const uniq = tips.filter((t) => { const k = fold(t); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, LIMITS.aiTips);
    let confidence = CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'low';
    // From a name alone, never more than "medium".
    if (!req.image && confidence === 'high') confidence = 'medium';
    return {
      low, high, currency: req.currency, confidence,
      reason: plainOut(raw.reason, LIMITS.aiReason),
      title: plainOut(raw.title, LIMITS.aiTitle) || req.name,
      tips: uniq,
    };
  }

  /* ------------------------------------------------------------------ *
   * "Try it": a made-up closet, drawn as emoji cards. Never saved.
   * ------------------------------------------------------------------ */

  const SAMPLE = [
    ['👗', 'Wedding guest dress', 'Worn once, still has the spare button', 'like-new', 12000, 4500],
    ['👕', 'Band T-shirt from 2009', 'Faded and two sizes too small', 'worn', null, 500],
    ['👖', 'Jeans that never fit', 'Bought in a sale, never really worn', 'good', 6000, 1500],
    ['🧥', 'Winter coat', 'Warm, just a bit big now', 'good', 15000, 4000],
    ['👟', 'Running shoes', 'The soles are going', 'worn', 9000, 500],
    ['👔', 'Four work ties', null, 'good', null, 800],
    ['🧣', 'Cosy scarf', 'The one everyone compliments', 'good', null, 1000],
    ['👜', 'Leather handbag', 'Gift, used twice', 'like-new', null, 2500],
    ['🧦', 'Odd socks', 'Seven of them, no pairs', 'worn', null, 100],
    ['🎒', 'Old school backpack', 'One zip sticks', 'fair', null, 500],
    ['🥾', 'Hiking boots', 'Barely worn - wrong size', 'like-new', 11000, 1500],
    ['👒', 'Straw sun hat', 'For the holiday that keeps not happening', 'good', null, 800],
  ];
  function sampleCloset(o) {
    return SAMPLE.map(([emoji, name, note, cond, paid, ask], i) => {
      const it = cleanItem({ id: `sample-${i + 1}`, name, emoji, note, cond, paid, room: 'closet', createdAt: o.nowMs + i, sprint: 'sample' }, o);
      it.tryAsk = ask;
      it.sample = true;
      return it;
    });
  }

  return {
    LIMITS, INVISIBLE, EMOJI, DEFAULT_EMOJI, ROOMS, ROOM_IDS, DECISIONS, DECISION_IDS, LEAVING, CONDITIONS, CONDITION_IDS,
    WHERE, WHERE_IDS, SELL_STATUS, SELL_IDS, CURRENCIES, TOSS_TIPS, TOSS_RULES_LINE, GRAB_TITLE_DEFAULT, FRIEND, ID_RE, DAY_RE, CONFIDENCE,
    line, plain, esc, plural, stripLinks, plainOut, isId, isDay, addDays, daysBetween, weekOf, shortDay,
    currencyFor, isCurrency, money, readMoney, cents,
    emojiOk, emojiOf, emojiFor, guessEmoji, kindOf, fold,
    roomOf, decisionOf, conditionLabel, whereLabel, cleanUrl,
    cleanItem, newItem, cleanSprint, cleanBag,
    deckOf, queue, decide, undo, withDecision, dragDecision, dragHint,
    newSprint, sprintElapsed, sprintLeft, sprintOver, pauseSprint, resumeSprint, extendSprint, endSprint, clock, minutesWord, recap, streak,
    isOut, leaving, roomStats, weeks, tally,
    dropPrice, priceDrops, listingText, sellSummary,
    bagRows, donationText, donationCsv, toCsv, csvCell,
    tossTipFor, tossGroups,
    maybeState, maybeDue, maybeNext, maybeIcs, icsText, icsFold,
    cleanName, grabRequest,
    estimateRequest, estimatePayload, cleanEstimate,
    sampleCloset,
  };
}));
