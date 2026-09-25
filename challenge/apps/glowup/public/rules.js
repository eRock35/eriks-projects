/* Glowup's rules - the glow score, with no model, in one file that runs in the
 * browser AND on the server (server.js requires it).
 *
 *   score(listing)        0-100, five category rings, and every check with the
 *                         fix it asks for.
 *   PLATFORMS / TYPES     the platform limits and per-type checklists, as data.
 *   sparkline, streaks    the arithmetic behind the versions view.
 *
 * One implementation on purpose: the page re-scores live as the seller types
 * (free, instant, even signed out), and the server scores everything it saves
 * and everything a model hands back. The model never decides a number - it
 * rewrites, and these rules measure both sides, so a before/after is honest.
 *
 * The rules are blunt keyword and length checks. They are a floor, not a
 * judge: they can tell that a stay never says how guests get in, not whether
 * the prose is lovely. Every deduction names the fix, and every point is
 * earned by something a buyer would actually look for.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GlowRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- listing types ---------------- */

  var TYPES = [
    {
      key: 'stay', label: 'Short-term rental', short: 'Rental', emoji: '🏡', who: 'Airbnb & Vrbo hosts',
      tagsLabel: 'Amenities', tagsHint: 'One per line: hot tub, wood stove, 2 kayaks…',
      minDesc: 300, photosRec: 20,
      cta: 'Tap Reserve to check your dates.',
    },
    {
      key: 'product', label: 'Handmade or product', short: 'Product', emoji: '🕯️', who: 'Etsy & shop sellers',
      tagsLabel: 'Tags', tagsHint: 'One per line: soy candle, cedar candle, gift for her…',
      minDesc: 250, photosRec: 8,
      cta: 'Add it to your cart - it ships in two days.',
    },
    {
      key: 'resale', label: 'Resale item', short: 'Resale', emoji: '🧥', who: 'eBay, Poshmark & Mercari sellers',
      tagsLabel: 'Tags', tagsHint: 'One per line: waxed canvas, field jacket, size M…',
      minDesc: 150, photosRec: 8,
      cta: 'Message me with questions or make an offer.',
    },
    {
      key: 'service', label: 'Local service', short: 'Service', emoji: '🧰', who: 'Google Business & Thumbtack pros',
      tagsLabel: 'Services offered', tagsHint: 'One per line: drain cleaning, water heaters…',
      minDesc: 250, photosRec: 10,
      cta: 'Call or message for a free quote.',
    },
  ];
  var TYPE_KEYS = TYPES.map(function (t) { return t.key; });

  /* ---------------- platform limits ----------------
   * `hard`: the platform itself stops you there. Otherwise it is where search
   * results start cutting the title off - a target, said as one.
   * `titleLocked`: Google wants the real business name; keywords in it break
   * Google's rules, so the name is never rewritten or keyword-scored. */
  var PLATFORMS = [
    { key: 'airbnb', label: 'Airbnb', type: 'stay', titleMax: 50, descMax: 500, hard: true, note: 'Airbnb stops titles at 50 characters and the description box at 500.' },
    { key: 'vrbo', label: 'Vrbo', type: 'stay', titleMax: 80, note: 'Keep the headline under about 80 characters so search results show all of it.' },
    { key: 'direct', label: 'Own site / other', type: 'stay', titleMax: 60, note: 'Search results cut titles at about 60 characters.' },
    { key: 'etsy', label: 'Etsy', type: 'product', titleMax: 140, tagsMax: 13, tagMax: 20, hard: true, note: 'Etsy allows 140 characters in a title and 13 tags of up to 20 characters each.' },
    { key: 'shop', label: 'Own shop / other', type: 'product', titleMax: 70, note: 'Search results cut titles at about 70 characters.' },
    { key: 'ebay', label: 'eBay', type: 'resale', titleMax: 80, hard: true, note: 'eBay stops titles at 80 characters.' },
    { key: 'resale', label: 'Poshmark, Mercari & others', type: 'resale', titleMax: 80, note: 'Keep titles under about 80 characters so the whole thing shows.' },
    { key: 'google', label: 'Google Business Profile', type: 'service', titleMax: 100, descMax: 750, hard: true, titleLocked: true, note: 'Google allows 750 characters of description. Your business name must be your real name - adding keywords to it breaks Google’s rules.' },
    { key: 'thumbtack', label: 'Thumbtack', type: 'service', titleMax: 60, note: 'Keep your headline under about 60 characters so it shows in full.' },
    { key: 'site', label: 'Own site / other', type: 'service', titleMax: 60, note: 'Search results cut titles at about 60 characters.' },
  ];
  var PLATFORM_KEYS = PLATFORMS.map(function (p) { return p.key; });

  /* ---------------- what each type must say ----------------
   * Five essentials per type, two points each. The regexes are deliberately
   * forgiving about wording and strict about substance: "fast wifi" is not a
   * Wi-Fi speed, "300 Mbps" is. */
  var ESSENTIALS = {
    stay: [
      { key: 'checkin', label: 'Check-in', hint: 'check-in time and how guests get in', re: /\b(check[- ]?in|self[- ]check|keypad|lock ?box|smart lock|key ?safe|arrival)\b/i },
      { key: 'parking', label: 'Parking', hint: 'parking: where, and for how many cars', re: /\b(park(ing)?|driveway|garage|car ?port)\b/i },
      { key: 'wifi', label: 'Wi-Fi speed', hint: 'Wi-Fi speed in Mbps', re: /\b\d{1,4}\s?(mbps|mb\/s|megabits?)\b/i },
      { key: 'beds', label: 'Beds', hint: 'how many beds, and what size', re: /\b(sleeps\s+\d+|\d+\s+(beds?|bedrooms?|bunks?)|(king|queen|double|twin|bunk|sofa)[- ]?(size )?beds?|bunks)\b/i },
      { key: 'distance', label: 'Distances', hint: 'how far to what guests come for, in minutes or miles', re: /\b\d+(\.\d+)?\s?(-\s?)?(min(ute)?s?|mi(les?)?|km|blocks?|steps|feet|ft|yards?)\b/i },
    ],
    product: [
      { key: 'materials', label: 'Materials', hint: 'what it is made of', re: /\b(made (from|of|with)|materials?|cotton|linen|wool|silk|leather|wood(en)?|oak|walnut|maple|ceramic|stoneware|porcelain|glass|metal|steel|brass|copper|silver|gold|sterling|wax|soy|beeswax|coconut|resin|clay|paper|cardstock|yarn|acrylic|wick)\b/i },
      { key: 'size', label: 'Size', hint: 'size: dimensions, weight or volume', re: /\b\d+(\.\d+)?\s?(x\s?\d+(\.\d+)?\s?)?(in(ch(es)?)?|cm|mm|oz|fl\.? ?oz|ml|g|grams?|lbs?|kg)\b|\b(dimensions?|measures)\b/i },
      { key: 'care', label: 'Care', hint: 'care: how to clean it or look after it', re: /\b(care|wash(able)?|hand[- ]wash|dishwasher|wipe|trim (the )?wick|burn (it )?for|burn time|store (it )?(in|away)|keep away)\b/i },
      { key: 'shipping', label: 'Shipping', hint: 'when it ships and how', re: /\b(ships?|shipping|dispatch(es|ed)?|processing time|made to order|delivery|arrives?)\b/i },
      { key: 'occasion', label: 'Who it’s for', hint: 'who it is for, or the occasion', re: /\b(gifts?|gifting|for (him|her|mom|mum|dad|kids|teachers?|weddings?|birthdays?|christmas|the holidays|anyone)|housewarming|anniversar(y|ies)|bridesmaids?)\b/i },
    ],
    resale: [
      { key: 'condition', label: 'Condition', hint: 'condition in plain words (like new, gently worn…)', re: /\b(condition|new with(out)? tags|nwt|nwot|like new|gently (used|worn)|pre[- ]?owned|worn (once|twice|a few times))\b/i },
      { key: 'flaws', label: 'Flaws', hint: 'flaws - or say there are none', re: /\b(flaws?|stains?|marks?|scuffs?|tears?|holes?|pilling|fading|faded|signs of wear|defects?|snags?|no (visible )?damage)\b/i },
      { key: 'measurements', label: 'Measurements', hint: 'measurements: pit to pit, length, waist…', re: /\b(pit[- ]to[- ]pit|p2p|chest|length|inseam|waist|shoulders?|sleeves?)\b[^.\n]{0,24}\d|\b\d+(\.\d+)?\s?(in(ch(es)?)?|cm)\b/i },
      { key: 'size', label: 'Size', hint: 'the size on the tag', re: /\b(size[:\s]+\w+|(extra[- ])?(small|medium|large)\b|(xx?s|xx?l)\b|(us|uk|eu)\s?\d+(\.5)?\b)/i },
      { key: 'shipping', label: 'Shipping & offers', hint: 'how fast it ships, and whether you take offers', re: /\b(ships?|shipping|same[- ]day|next[- ]day|bundles?|offers?|returns?)\b/i },
    ],
    service: [
      { key: 'area', label: 'Service area', hint: 'where you work: towns or a radius', re: /\b(serving|we serve|serves|service area|areas?|we cover|within \d+ (mi|miles|km)|county|neighbou?rhoods?)\b/i },
      { key: 'response', label: 'Response time', hint: 'how fast you answer', re: /\b(respond|response|reply|replies|get back|call back|callback|same[- ]day|next[- ]day|within \d+ (hours?|minutes?|mins?|days?)|24\/7)\b/i },
      { key: 'license', label: 'Licensed & insured', hint: 'licensed / insured, with your licence number', re: /\b(licen[cs]ed|insured|bonded|certified|licen[cs]e (no\.?|#|number)|accredited)\b/i },
      { key: 'pricing', label: 'Pricing', hint: 'how pricing works (free quote, from $…)', re: /(\bfree (quote|estimate)s?\b|\bestimates?\b|\bquotes?\b|\bstarting (at|from)\b|\$\s?\d+|\bper hour\b|\/hr\b|\bhourly\b|\bflat[- ]rate\b|\bcall[- ]out fee\b)/i },
      { key: 'hours', label: 'Hours', hint: 'when you work', re: /\b(hours|open|mon(day)?s?|tue(sday)?s?|wed(nesday)?s?|thu(rsday)?s?|fri(day)?s?|sat(urday)?s?|sun(day)?s?|weekends?|evenings?|24\/7|available)\b/i },
    ],
  };

  /* The photos that sell each type. Two points each; the seller ticks what
   * they have, and the glow-up writes a shot list for what is missing. */
  var SHOTS = {
    stay: [
      { key: 'hero', label: 'A hero shot - the best view, in daylight' },
      { key: 'bedrooms', label: 'Every bedroom, bed made' },
      { key: 'bathroom', label: 'The bathroom' },
      { key: 'kitchen', label: 'The kitchen' },
      { key: 'outside', label: 'The outside and what is nearby' },
    ],
    product: [
      { key: 'hero', label: 'A clean hero on a plain background' },
      { key: 'scale', label: 'In a hand or in use, for scale' },
      { key: 'detail', label: 'A close-up of the texture or finish' },
      { key: 'options', label: 'Every colour, scent or option' },
      { key: 'package', label: 'The packaging, gift-ready' },
    ],
    resale: [
      { key: 'front', label: 'Front, flat or on a hanger' },
      { key: 'back', label: 'The back' },
      { key: 'tag', label: 'The label and size tag' },
      { key: 'flaws', label: 'A close-up of any flaw' },
      { key: 'measure', label: 'Measurements with a tape' },
    ],
    service: [
      { key: 'face', label: 'You or your team - a real face' },
      { key: 'beforeafter', label: 'A before and after' },
      { key: 'progress', label: 'Work in progress' },
      { key: 'van', label: 'Your van, sign or shopfront' },
      { key: 'finished', label: 'A finished job, wide' },
    ],
  };

  var CATS = [
    { key: 'title', label: 'Title', emoji: '🏷️', about: 'Length, search words, no shouting.' },
    { key: 'hook', label: 'Hook', emoji: '🪝', about: 'The first line, and what to do next.' },
    { key: 'details', label: 'Details', emoji: '📋', about: 'The facts buyers look for.' },
    { key: 'trust', label: 'Trust', emoji: '🤝', about: 'Clean, scannable, complete.' },
    { key: 'photos', label: 'Photos', emoji: '📸', about: 'Enough of them, and the right ones.' },
  ];
  var CAT_MAX = 20;

  var GRADES = [
    { min: 90, key: 'glowing', label: 'Glowing', emoji: '✨' },
    { min: 75, key: 'great', label: 'Great', emoji: '🌟' },
    { min: 60, key: 'good', label: 'Good', emoji: '👍' },
    { min: 40, key: 'okay', label: 'Getting there', emoji: '🌤️' },
    { min: 0, key: 'dim', label: 'Needs a glow-up', emoji: '🌑' },
  ];

  // Words that sound like praise and prove nothing. Fine next to a fact
  // ("cozy: wood stove and flannel sheets"); empty on their own.
  var VAGUE = ['nice', 'great', 'cozy', 'cosy', 'amazing', 'beautiful', 'lovely', 'cute', 'perfect', 'awesome', 'stunning', 'charming',
    'unique', 'high quality', 'high-quality', 'best', 'wonderful', 'gorgeous', 'incredible', 'fantastic', 'special', 'spacious',
    'one of a kind', 'one-of-a-kind', 'must see', 'must-see', 'dreamy', 'beautifully', 'truly'];

  var FILLER = /^(welcome( to)?\b|this (is|listing|item)\b|hello\b|hi\b|hey\b|we are\b|we're\b|i am\b|i'm\b|located\b|listing for\b|for sale\b|up for (sale|grabs)\b|check (out|this out)\b|introducing\b|come (and )?(stay|see)\b|here is\b|here's\b)/i;

  var CTA = /\b(book( now| your)?|reserve|message (me|us)|send (me|us) a message|add (it )?to (your )?(cart|basket)|order (yours|now|today)|buy (it )?now|grab (yours|one)|shop now|call( or text| us| me| today| now)?|text (me|us)|get a (free )?(quote|estimate)|request a (quote|booking|visit)|make (me )?an offer|ask (me|us)|contact (me|us)|check (your|the) dates|schedule|dm me)\b/i;

  // Capitals that are words, not shouting.
  var ACRONYMS = ['WIFI', 'WI-FI', 'USB', 'LED', 'HVAC', 'NWT', 'NWOT', 'BBQ', 'USA', 'OEM', 'DIY', 'ASAP', 'EV', 'TV', 'AC', 'UK', 'EU', 'US', 'XL', 'XXL', 'XS', 'OBO', 'HDMI', 'UPS', 'USPS', 'FEDEX', 'PPE', 'GFCI', 'SUV', 'RV', 'NYC', 'LA', 'FAQ', 'COVID', 'ADA'];

  var PLACEHOLDER = /\[add:[^\]]{0,80}\]/gi;

  /* ---------------- helpers ---------------- */

  function str(v) { return String(v == null ? '' : v).replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"'); }
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function has(re, s) { re.lastIndex = 0; return re.test(s); }
  function list(v) {
    if (Array.isArray(v)) return v.map(str).map(function (s) { return s.trim(); }).filter(Boolean);
    return str(v).split(/\n|,/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function typeInfo(k) { for (var i = 0; i < TYPES.length; i++) if (TYPES[i].key === k) return TYPES[i]; return TYPES[0]; }
  function platformInfo(k) { for (var i = 0; i < PLATFORMS.length; i++) if (PLATFORMS[i].key === k) return PLATFORMS[i]; return null; }
  function platformsFor(type) { return PLATFORMS.filter(function (p) { return p.type === type; }); }
  /** The platform, if it belongs to the type; else the type's first. */
  function platformOf(type, key) {
    var p = platformInfo(key);
    return p && p.type === type ? p : platformsFor(type)[0];
  }
  function catInfo(k) { for (var i = 0; i < CATS.length; i++) if (CATS[i].key === k) return CATS[i]; return CATS[0]; }
  function gradeOf(score) { for (var i = 0; i < GRADES.length; i++) if (score >= GRADES[i].min) return GRADES[i]; return GRADES[GRADES.length - 1]; }

  /** The text with its gaps taken out. A line that is only a short label and
   *  a gap ("Parking: [add: where]") goes whole: the label names a fact the
   *  listing does not give yet, and must not earn the point for it. */
  function stripPlaceholders(s) {
    return str(s).split('\n').map(function (line) {
      var bare = line.replace(PLACEHOLDER, ' ');
      if (bare === line) return line;
      var words = bare.replace(/[\s\-*•·✓✔–—:]+/g, ' ').trim().split(' ').filter(Boolean);
      return words.length <= 3 ? '' : bare.replace(/\s{2,}/g, ' ');
    }).join('\n');
  }
  function placeholdersIn(s) {
    var out = [];
    var m = str(s).match(PLACEHOLDER) || [];
    for (var i = 0; i < m.length; i++) {
      var t = m[i].replace(/^\[add:\s*/i, '').replace(/\]$/, '').trim();
      if (out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }

  /** The first line of the description, as a reader sees it: bullets and
   *  markdown-ish marks off, cut at the first sentence. */
  function firstSentence(desc) {
    var lines = stripPlaceholders(desc).split(/\n/);
    var line = '';
    for (var i = 0; i < lines.length; i++) { if (lines[i].trim()) { line = lines[i]; break; } }
    line = line.replace(/^[\s\-*•·✓✔–—>#]+/, '').trim();
    var m = line.match(/^(.+?[.!?])(\s|$)/);
    return m ? m[1] : line;
  }

  function sentences(text) {
    // No lookbehind: older iOS Safari cannot parse one, and this file runs there.
    return stripPlaceholders(text).replace(/([.!?])\s+/g, '$1\n').split(/\n+/).map(function (s) { return s.replace(/^[\s\-*•·✓✔–—]+/, '').trim(); }).filter(Boolean);
  }

  function vagueIn(s) {
    var found = [];
    for (var i = 0; i < VAGUE.length; i++) {
      if (has(new RegExp('(^|[^a-z])' + esc(VAGUE[i]) + '(?=$|[^a-z])', 'i'), s)) found.push(VAGUE[i]);
    }
    return found;
  }

  function capsWords(s) {
    var m = str(s).match(/\b[A-Z][A-Z'-]{3,}\b/g) || [];
    return m.filter(function (w) { return ACRONYMS.indexOf(w.replace(/'S$/, '')) < 0; });
  }

  function repeatedWords(s) {
    var out = [];
    var re = /\b([a-z]{2,})\s+\1\b/gi, m;
    while ((m = re.exec(stripPlaceholders(s)))) {
      var w = m[1].toLowerCase();
      if (['had', 'that', 'bye', 'no'].indexOf(w) < 0) out.push(m[0]);
    }
    return out;
  }

  function kwRe(kw) { return new RegExp('(^|[^a-z0-9])' + esc(kw.toLowerCase()).replace(/\s+/g, '[\\s-]+') + '(s|es)?(?=$|[^a-z0-9])', 'i'); }
  function mentions(text, kw) { return has(kwRe(kw), str(text)); }

  /** The words buyers search: what the seller told us, else their tags. */
  function keywordsFor(l) {
    var own = list(l.keywords).map(function (k) { return k.toLowerCase(); });
    var src = own.length ? own : list(l.tags).map(function (k) { return k.toLowerCase(); });
    var out = [];
    for (var i = 0; i < src.length && out.length < 8; i++) if (src[i].length >= 3 && out.indexOf(src[i]) < 0) out.push(src[i]);
    return { words: out, own: own.length > 0 };
  }

  function trunc(s, n) { s = str(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* ---------------- the score ---------------- */

  /**
   * @param l { type, platform, title, description, tags[], keywords[], price,
   *            photoCount, shots[] }
   * @returns { score, grade, cats {key: {score, max, pct}}, checks[], fixes[],
   *            facts }
   */
  function score(l) {
    l = l || {};
    var type = typeInfo(l.type);
    var plat = platformOf(type.key, l.platform);
    var title = str(l.title).trim();
    var rawDesc = str(l.description);
    var desc = stripPlaceholders(rawDesc).trim();
    var tags = list(l.tags);
    var kw = keywordsFor(l);
    var photos = Math.max(0, Math.min(999, Math.floor(Number(l.photoCount) || 0)));
    var shots = list(l.shots);
    var checks = [];

    function check(cat, id, max, lost, label, fix, good) {
      lost = Math.max(0, Math.min(max, Math.round(lost)));
      checks.push({ id: id, cat: cat, max: max, lost: lost, ok: lost === 0, label: label, fix: lost ? fix : '', good: lost ? '' : (good || '') });
    }

    /* ----- Title (20) ----- */
    var t = title.length;
    var minT = Math.max(20, Math.round(plat.titleMax * 0.45));
    if (!t) {
      check('title', 't_len', 7, 7, 'Title length', 'Write a title - it is the first thing anyone reads.');
    } else if (plat.titleLocked) {
      var stuffed = /\s[|•·]\s|\s[-–—]\s.*\b(best|cheap|near me|services?|repair|cleaning|plumb\w*|electric\w*|landscap\w*|roof\w*|hvac)\b/i.test(title);
      check('title', 't_len', 7, stuffed ? 7 : 0, 'Business name', 'Google wants your real business name only. Move “' + trunc(title.split(/\s[|•·\-–—]\s/).slice(1).join(' '), 40) + '” into the description - keyword-stuffed names get profiles suspended.', 'Your real business name - exactly what Google asks for.');
    } else if (t > plat.titleMax) {
      check('title', 't_len', 7, 7, 'Title length', (plat.hard ? plat.label + ' stops titles at ' + plat.titleMax + ' characters' : 'Titles over ' + plat.titleMax + ' characters get cut off in results') + ' - cut ' + plural(t - plat.titleMax, 'character') + '.', '');
    } else if (t < minT) {
      check('title', 't_len', 7, 4, 'Title length', 'Use more of your ' + plat.titleMax + ' characters: add what makes it different - a feature, a place, a size.', '');
    } else {
      check('title', 't_len', 7, 0, 'Title length', '', t + ' of ' + plat.titleMax + ' characters - a good use of the space.');
    }

    if (plat.titleLocked) {
      check('title', 't_kw', 6, 0, 'Search words', '', 'Google names are not for keywords - your description carries them.');
    } else if (!kw.words.length) {
      check('title', 't_kw', 6, t ? 4 : 6, 'Search words', 'Add 3-5 search words buyers type (like “' + (type.key === 'stay' ? 'lake cabin' : type.key === 'product' ? 'soy candle' : type.key === 'resale' ? 'field jacket' : 'emergency plumber') + '”) so we can check your title uses them.');
    } else {
      var inTitle = kw.words.filter(function (k) { return mentions(title, k); });
      if (!inTitle.length) check('title', 't_kw', 6, 6, 'Search words', 'Put “' + kw.words[0] + '” in the title - it is what people type into search.');
      else if (inTitle.indexOf(kw.words[0]) < 0 && kw.own) check('title', 't_kw', 6, 2, 'Search words', 'Lead with “' + kw.words[0] + '”, the search you listed first.');
      else check('title', 't_kw', 6, 0, 'Search words', '', 'Your title has “' + inTitle[0] + '” in it.');
    }

    var tCaps = capsWords(title);
    var tVague = /\d/.test(title) ? [] : vagueIn(title);
    var tPunct = /!{2,}|\*{2,}|~{2,}|\|{2,}|[!?]\s*$/.test(title);
    var styleLost = (tCaps.length ? 2 : 0) + (tVague.length ? 2 : 0) + (tPunct ? 1 : 0);
    var styleFix = [];
    if (tCaps.length) styleFix.push('drop the capitals (' + trunc(tCaps.join(', '), 30) + ')');
    if (tVague.length) styleFix.push('swap “' + tVague[0] + '” for something a photo could prove');
    if (tPunct) styleFix.push('lose the !!! and symbols');
    check('title', 't_style', 5, t ? styleLost : 5, 'Title style', t ? 'In the title: ' + styleFix.join('; ') + '.' : 'Write a title first.', 'Calm, specific, no shouting.');

    if (plat.tagsMax) {
      var longTags = tags.filter(function (x) { return x.length > plat.tagMax; });
      var tagLost = longTags.length ? 2 : (tags.length < plat.tagsMax ? (tags.length < plat.tagsMax / 2 ? 2 : 1) : 0);
      check('title', 't_tags', 2, tagLost, 'Tags', longTags.length
        ? plat.label + ' tags stop at ' + plat.tagMax + ' characters - shorten “' + trunc(longTags[0], 30) + '”.'
        : 'Use all ' + plat.tagsMax + ' tags - you have ' + tags.length + '. Each one is another search you can show up in.', 'All ' + plat.tagsMax + ' tags used.');
    } else {
      check('title', 't_tags', 2, tags.length >= 3 ? 0 : (tags.length ? 1 : 2), type.tagsLabel, 'List at least 3 ' + type.tagsLabel.toLowerCase() + ' - they feed search and the glow-up.', tags.length + ' ' + type.tagsLabel.toLowerCase() + ' listed.');
    }

    /* ----- Hook (20) ----- */
    var first = firstSentence(rawDesc);
    var ess = ESSENTIALS[type.key];
    if (!desc) {
      check('hook', 'h_filler', 6, 6, 'Opening line', 'Write a description - start with the one thing that makes someone stop scrolling.');
      check('hook', 'h_specific', 5, 5, 'A fact up front', 'Write a description first.');
      check('hook', 'h_length', 3, 3, 'Opening length', 'Write a description first.');
      check('hook', 'h_cta', 6, 6, 'What to do next', 'Write a description first.');
    } else {
      var filler = first.match(FILLER);
      check('hook', 'h_filler', 6, filler ? 6 : 0, 'Opening line', 'Lead with the payoff, not “' + (filler ? filler[0] : '') + '…”. Your first line is the preview in search.', 'Opens with substance, not a greeting.');
      var specific = /\d/.test(first) || ess.some(function (e) { return has(e.re, first); }) || kw.words.some(function (k) { return mentions(first, k); });
      check('hook', 'h_specific', 5, specific ? 0 : 5, 'A fact up front', 'Put one concrete fact in the first line - a number, a view, a distance, a material.', 'The first line carries a real fact.');
      var fl = first.length;
      check('hook', 'h_length', 3, fl > 160 ? 3 : (fl < 25 ? 2 : 0), 'Opening length', fl > 160 ? 'Your opening line is ' + fl + ' characters - previews show about 150. Split it.' : 'Your opening line is only ' + fl + ' characters - give it one full, specific sentence.', 'A first line that fits in a preview.');
      check('hook', 'h_cta', 6, has(CTA, desc) ? 0 : 6, 'What to do next', 'End with what to do next: “' + type.cta + '”', 'Ends by telling people what to do.');
    }

    /* ----- Details (20) ----- */
    var body = title + '\n' + desc + '\n' + tags.join('\n');
    var missing = ess.filter(function (e) { return !has(e.re, body); });
    check('details', 'd_essentials', 10, missing.length * 2, 'The essentials', 'Say ' + missing.map(function (e) { return e.hint; }).join('; ') + '.', 'Covers ' + ess.map(function (e) { return e.label.toLowerCase(); }).join(', ') + '.');
    if (kw.words.length) {
      var covered = kw.words.filter(function (k) { return mentions(desc + '\n' + tags.join('\n'), k); });
      var miss = kw.words.filter(function (k) { return covered.indexOf(k) < 0; });
      var share = covered.length / kw.words.length;
      check('details', 'd_keywords', 4, share >= 1 ? 0 : (share >= 0.5 ? 2 : 4), 'Search words in the text', 'Work ' + miss.slice(0, 3).map(function (k) { return '“' + k + '”'; }).join(', ') + ' into the description, naturally.', 'Every search word appears in the text.');
    } else {
      check('details', 'd_keywords', 4, 2, 'Search words in the text', 'Tell us the words buyers search for, and we’ll check the description uses them.');
    }
    var vagueSentences = sentences(desc).filter(function (s) {
      if (/\d/.test(s)) return false;
      if (ess.some(function (e) { return has(e.re, s); })) return false;
      return vagueIn(s).length > 0;
    });
    var vWords = [];
    vagueSentences.forEach(function (s) { vagueIn(s).forEach(function (w) { if (vWords.indexOf(w) < 0) vWords.push(w); }); });
    check('details', 'd_vague', 4, Math.min(4, vagueSentences.length * 2), 'Specifics, not adjectives', '“' + vWords.slice(0, 3).join('”, “') + '” say nothing a photo can’t. Replace with the detail behind it: what makes it ' + (vWords[0] || 'nice') + '?', 'Adjectives come with the facts behind them.');
    var nums = (desc.match(/\d+/g) || []).length;
    check('details', 'd_numbers', 2, desc.length >= 200 && nums < 2 ? 2 : (!desc ? 2 : 0), 'Numbers', 'Add numbers - sizes, minutes, counts, years. Buyers skim for them.', 'Has the numbers buyers skim for.');

    /* ----- Trust (20) ----- */
    var reps = repeatedWords(title + '\n' + rawDesc);
    check('trust', 'r_repeat', 2, reps.length ? 2 : 0, 'Typos', 'Fix the repeated word' + (reps.length > 1 ? 's' : '') + ': “' + trunc(reps.slice(0, 2).join('”, “'), 50) + '”.', 'No doubled words.');
    var dCaps = capsWords(desc);
    check('trust', 'r_caps', 3, dCaps.length >= 2 ? 3 : 0, 'No shouting', 'Turn down the capitals (' + trunc(dCaps.slice(0, 4).join(', '), 40) + ') - ALL CAPS reads as shouting.', 'No ALL CAPS shouting.');
    var bangs = (desc.match(/!/g) || []).length;
    check('trust', 'r_exclaim', 2, /!{2,}/.test(desc) ? 2 : (bangs > 3 ? 1 : 0), 'Exclamation marks', 'Cut the exclamation marks (' + bangs + ') - calm reads as confident.', 'Calm punctuation.');
    var paras = desc.split(/\n/).map(function (p) { return p.trim(); });
    var longest = paras.reduce(function (m, p) { return Math.max(m, p.length); }, 0);
    check('trust', 'r_wall', 4, longest > 350 ? 4 : 0, 'Scannable', 'Break up your ' + longest + '-character paragraph - nobody reads a wall of text on a phone.', 'Short paragraphs, easy to skim.');
    var bulletLines = paras.filter(function (p) { return /^([-*•·✓✔–]|\d+[.)])\s*/.test(p); }).length;
    check('trust', 'r_bullets', 2, desc.length > 350 && bulletLines < 2 ? 2 : 0, 'Bullets', 'Add a short bulleted list of what’s included - the eye jumps to it.', desc.length > 350 ? 'A list the eye can jump to.' : 'Short enough not to need a list.');
    var dl = desc.length;
    var lenLost = !dl ? 3 : (plat.descMax && dl > plat.descMax ? 3 : (dl < type.minDesc ? (dl < type.minDesc / 2 ? 3 : 2) : 0));
    check('trust', 'r_length', 3, lenLost, 'Description length', plat.descMax && dl > plat.descMax
      ? plat.label + ' stops the description at ' + plat.descMax + ' characters - cut ' + plural(dl - plat.descMax, 'character') + '.'
      : 'Say more - at least ' + type.minDesc + ' characters. You have ' + dl + '.', dl + ' characters - enough to answer questions' + (plat.descMax ? ', inside ' + plat.label + '’s ' + plat.descMax : '') + '.');
    var hasPrice = /\d|free|quote|estimate/i.test(str(l.price));
    check('trust', 'r_price', 2, hasPrice ? 0 : 2, 'Price', 'Add your price - or “free quotes” - so nobody has to ask.', 'Price is stated.');
    var gaps = placeholdersIn(title + '\n' + rawDesc);
    check('trust', 'r_gaps', 2, Math.min(2, gaps.length), 'Gaps filled', 'Fill in ' + plural(gaps.length, 'gap') + ' marked [add: …] - ' + trunc(gaps.join('; '), 70) + '.', 'No [add: …] gaps left.');

    /* ----- Photos (20) ----- */
    var rec = type.photosRec;
    check('photos', 'p_count', 10, 10 * (1 - Math.min(1, photos / rec)), 'Number of photos', photos ? 'Add ' + plural(rec - photos, 'more photo') + ' - aim for ' + rec + '.' : 'Add photos - aim for ' + rec + '. Listings without them barely get clicked.', plural(photos, 'photo') + ' - plenty.');
    var shotList = SHOTS[type.key];
    var missingShots = shotList.filter(function (s) { return shots.indexOf(s.key) < 0; });
    check('photos', 'p_shots', 10, missingShots.length * 2, 'The shot list', 'Missing: ' + missingShots.map(function (s) { return s.label.split(' - ')[0].toLowerCase(); }).join('; ') + '.', 'Every shot that sells a ' + type.short.toLowerCase() + '.');

    /* ----- totals ----- */
    var cats = {};
    CATS.forEach(function (c) {
      var lost = checks.filter(function (x) { return x.cat === c.key; }).reduce(function (s, x) { return s + x.lost; }, 0);
      var sc = Math.max(0, CAT_MAX - lost);
      cats[c.key] = { score: sc, max: CAT_MAX, pct: Math.round(sc / CAT_MAX * 100) };
    });
    var total = CATS.reduce(function (s, c) { return s + cats[c.key].score; }, 0);
    var fixes = checks.filter(function (x) { return x.lost > 0; }).sort(function (a, b) { return b.lost - a.lost || CATS.map(function (c) { return c.key; }).indexOf(a.cat) - CATS.map(function (c) { return c.key; }).indexOf(b.cat); });
    return {
      score: total,
      grade: gradeOf(total),
      cats: cats,
      checks: checks,
      fixes: fixes,
      facts: {
        type: type.key, platform: plat.key, titleLength: t, titleMax: plat.titleMax, titleLocked: Boolean(plat.titleLocked),
        descLength: dl, descMax: plat.descMax || null, tags: tags.length, tagsMax: plat.tagsMax || null, photos: photos, photosRec: rec,
        keywords: kw.words, missingEssentials: missing.map(function (e) { return e.key; }), gaps: gaps,
      },
    };
  }

  /** Just the numbers, for a version row or a share card. */
  function summary(l) {
    var s = score(l);
    var cats = {};
    CATS.forEach(function (c) { cats[c.key] = s.cats[c.key].score; });
    return { score: s.score, cats: cats };
  }

  /* ---------------- versions ---------------- */

  /** Points for a sparkline of scores, 0-100 mapped into w x h (top = 100).
   *  One score is a flat line across; none is an empty list. */
  function sparkline(scores, w, h, pad) {
    pad = pad == null ? 3 : pad;
    var n = scores.length;
    if (!n) return [];
    var ys = scores.map(function (s) { return Math.max(0, Math.min(100, Number(s) || 0)); });
    var lo = Math.max(0, Math.min.apply(null, ys) - 10), hi = Math.min(100, Math.max.apply(null, ys) + 10);
    if (hi - lo < 20) { var mid = (hi + lo) / 2; lo = Math.max(0, mid - 10); hi = Math.min(100, lo + 20); }
    var y = function (v) { return Math.round((pad + (h - 2 * pad) * (1 - (v - lo) / (hi - lo))) * 10) / 10; };
    if (n === 1) return [[pad, y(ys[0])], [w - pad, y(ys[0])]];
    return ys.map(function (v, i) { return [Math.round((pad + (w - 2 * pad) * i / (n - 1)) * 10) / 10, y(v)]; });
  }

  /** Saves in a row, ending with the latest, that each scored higher than the
   *  one before. [41, 38, 60, 72] -> 2. */
  function improvementStreak(scores) {
    var n = 0;
    for (var i = scores.length - 1; i > 0; i--) {
      if (Number(scores[i]) > Number(scores[i - 1])) n++;
      else break;
    }
    return n;
  }

  function addDays(day, n) {
    var d = new Date(day + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /** Days in a row with at least one save that raised a score. Runs from
   *  today, or from yesterday until today has one ("at risk"). */
  function dayStreak(days, today) {
    var set = {};
    (days || []).forEach(function (d) { set[d] = true; });
    var start = set[today] ? today : addDays(today, -1);
    var n = 0;
    while (set[addDays(start, -n)]) n++;
    return { days: n, atRisk: n > 0 && !set[today], today: Boolean(set[today]) };
  }

  return {
    TYPES: TYPES,
    TYPE_KEYS: TYPE_KEYS,
    PLATFORMS: PLATFORMS,
    PLATFORM_KEYS: PLATFORM_KEYS,
    ESSENTIALS: ESSENTIALS,
    SHOTS: SHOTS,
    CATS: CATS,
    CAT_MAX: CAT_MAX,
    GRADES: GRADES,
    VAGUE: VAGUE,
    score: score,
    summary: summary,
    typeInfo: typeInfo,
    platformInfo: platformInfo,
    platformsFor: platformsFor,
    platformOf: platformOf,
    catInfo: catInfo,
    gradeOf: gradeOf,
    firstSentence: firstSentence,
    vagueIn: vagueIn,
    capsWords: capsWords,
    repeatedWords: repeatedWords,
    keywordsFor: keywordsFor,
    mentions: mentions,
    stripPlaceholders: stripPlaceholders,
    placeholdersIn: placeholdersIn,
    sparkline: sparkline,
    improvementStreak: improvementStreak,
    dayStreak: dayStreak,
    addDays: addDays,
    list: list,
  };
});
