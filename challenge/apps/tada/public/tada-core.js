/* Tada - the rules. One file, run three times: in the page (window.TadaCore),
 * on the server and in the tests (require). See CLAUDE.md.
 *
 *   - the curated emoji set, the stickers, the four templates by age;
 *   - times: "Start by 7:05 PM" worked back from the done-by time;
 *   - today's status per routine ("4 of 6 - on track for 8:05 PM");
 *   - progress taps (one key per child, routine and step), stickers and
 *     streaks;
 *   - the clocks-change helper: the next daylight-saving change in a time
 *     zone, found with Intl alone, and a plan that eases bedtime (and
 *     mornings, only if asked) 15 minutes a day across the days before it;
 *   - the calendar file (.ics, floating local time, a weekly RRULE);
 *   - cleaning every field both sides accept, and the two AI briefs and
 *     answers.
 *
 * No clock and no dice: "now", "today", the time zone and every new id are
 * handed in, so the same input gives the same answer on every device and in
 * every test. No network and no storage either.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TadaCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = {
    children: 4,
    routinesPerChild: 6,
    steps: 20,
    aiSteps: 12,
    stepName: 40,
    routineName: 40,
    childName: 24,
    game: 140,
    minMinutes: 1,
    maxMinutes: 30,
    progressDays: 14,     // step taps kept, today included
    finDays: 400,         // finished routines (stickers) kept
    tapsPerRequest: 60,
    familyBytes: 64 * 1024,
    sentence: 300,
    ideas: 3,
    idea: 140,
  };

  const KINDS = ['morning', 'bedtime', 'other'];
  const BANDS = [
    { id: 'little', label: '3-5' },
    { id: 'middle', label: '6-8' },
    { id: 'big', label: '9-10' },
  ];
  const BAND_IDS = BANDS.map((b) => b.id);
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_ICS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** The week as the page draws it: Monday first. */
  const WEEK = [1, 2, 3, 4, 5, 6, 0];

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
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function plural(n, word, many) { return `${n} ${n === 1 ? word : (many || `${word}s`)}`; }
  function clampInt(v, lo, hi, dflt) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  }
  const ID_RE = /^[a-z0-9]{1,16}$/;
  const isId = (v) => typeof v === 'string' && ID_RE.test(v);

  /** Links and markup out of anything a model wrote. */
  function stripLinks(s) {
    return String(s)
      .replace(/\b(?:https?|ftp|file|data|javascript|vbscript)\s*:\S*/gi, '')
      .replace(/\bwww\.\S+/gi, '')
      .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|uk|us|app|dev|info|biz|ly|me|tv|xyz|link|site|online|example)\b\S*/gi, '');
  }
  function stripMarkup(s) { return String(s).replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' '); }
  function plainOut(v, max) {
    if (typeof v !== 'string') return '';
    return line(stripLinks(stripMarkup(line(v, max * 4))).replace(/\s+([,.!?;:])/g, '$1'), max);
  }

  /* ------------------------------------------------------------------ *
   * The emoji a step may have (about sixty, all of them for children), the
   * stickers a finished routine earns, and the animals and colours a child
   * can be.
   * ------------------------------------------------------------------ */

  const EMOJI = [
    ['🪥', 'Toothbrush', 'brush teeth,teeth,toothbrush,brush your teeth'],
    ['🦷', 'Tooth', 'floss,tooth,dentist,brush and floss'],
    ['🚽', 'Toilet', 'toilet,potty,wee,bathroom,loo,pee'],
    ['🧼', 'Soap', 'wash,hands,soap,wash hands,wash your hands,face,wash your face'],
    ['🛁', 'Bath', 'bath,bath time,tub'],
    ['🚿', 'Shower', 'shower'],
    ['🧴', 'Lotion', 'lotion,cream,sunscreen,sun cream,moisturiser,moisturizer,dry off'],
    ['💇', 'Hair', 'hair,comb,brush hair,brush your hair,plait,braid,ponytail'],
    ['🧻', 'Tissues', 'nose,tissue,blow your nose'],
    ['👕', 'T-shirt', 'dressed,get dressed,clothes,shirt,uniform,top,clothes out'],
    ['👖', 'Trousers', 'trousers,jeans,leggings,pants'],
    ['🩲', 'Underwear', 'underwear,undies,knickers'],
    ['🧦', 'Socks', 'socks'],
    ['🩳', 'Shorts', 'shorts'],
    ['🌛', 'Pajamas', 'pajamas,pyjamas,pjs,jammies,nightie'],
    ['🧥', 'Coat', 'coat,jacket,coat on'],
    ['🧢', 'Cap', 'hat,cap,sun hat'],
    ['🧤', 'Gloves', 'gloves,mittens'],
    ['🧣', 'Scarf', 'scarf'],
    ['👟', 'Shoes', 'shoes,trainers,sneakers,shoes on'],
    ['🥾', 'Boots', 'boots,wellies,rain boots'],
    ['👓', 'Glasses', 'glasses,specs'],
    ['🎒', 'School bag', 'bag,backpack,school bag,pack your bag,book bag'],
    ['☂️', 'Umbrella', 'umbrella,rain'],
    ['🥣', 'Breakfast', 'breakfast,cereal,porridge,oatmeal,eat breakfast'],
    ['🍎', 'Apple', 'fruit,snack,apple'],
    ['🍌', 'Banana', 'banana'],
    ['🥪', 'Sandwich', 'lunch,sandwich,pack your lunch'],
    ['🍱', 'Lunchbox', 'lunchbox,lunch box,packed lunch'],
    ['🥛', 'Milk', 'milk'],
    ['💧', 'Water', 'water,drink,sip of water,water bottle'],
    ['🧃', 'Juice box', 'juice'],
    ['🍽️', 'Plate', 'table,set the table,dinner,plate,dishes,clear the table'],
    ['🛏️', 'Bed', 'make your bed,make the bed'],
    ['🛌', 'Into bed', 'into bed,bed,tuck in,in bed'],
    ['😴', 'Sleepy', 'sleep,sleepy,nap,rest'],
    ['🌙', 'Moon', 'night,lights out,goodnight,good night'],
    ['💡', 'Light', 'light,lamp,nightlight,night light,lights off'],
    ['📖', 'Story', 'story,story time,book,read together,bedtime story'],
    ['📚', 'Books', 'read,reading,books,read on your own,library'],
    ['🧸', 'Teddy', 'teddy,toys,toys away,cuddly,tidy toys,toys back'],
    ['🤗', 'Hug', 'hug,hugs,cuddle,cuddles,kiss'],
    ['🎵', 'Music', 'song,music,sing,lullaby'],
    ['🧩', 'Puzzle', 'puzzle,game,games'],
    ['🧹', 'Tidy up', 'tidy,tidy up,tidy your room,sweep,clean up'],
    ['🧺', 'Laundry', 'laundry,washing,basket,clothes in the basket,hamper'],
    ['🐶', 'Dog', 'dog,puppy,walk the dog,feed the dog'],
    ['🐱', 'Cat', 'cat,kitten,feed the cat'],
    ['🐠', 'Fish', 'fish,feed the fish'],
    ['🪴', 'Plant', 'plant,plants,water the plants'],
    ['✏️', 'Pencil', 'homework,write,pencil,spelling,writing'],
    ['🎹', 'Piano', 'piano,practice,practise,instrument,violin,guitar'],
    ['🎨', 'Paint', 'draw,drawing,paint,art,colour,color,crayons'],
    ['⚽', 'Ball', 'sport,sports,kit,football,soccer,ball,pe kit,gym'],
    ['🚌', 'Bus', 'bus,school bus,catch the bus'],
    ['🚗', 'Car', 'car,drive,seatbelt,seat belt,car seat'],
    ['🚶', 'Walk', 'walk,walk to school,out the door,leave'],
    ['🔑', 'Keys', 'keys,door,lock'],
    ['⏰', 'Alarm', 'alarm,wake,wake up,get up'],
    ['🌞', 'Sun', 'morning,sun,curtains,good morning,open the curtains'],
    ['🧘', 'Calm', 'calm,breathe,breathing,stretch,relax,yoga,quiet'],
    ['💬', 'Talk', 'talk,chat,tell,talk about your day'],
    ['❤️', 'Heart', 'love,kind,thank,thank you,kindness'],
    ['💊', 'Medicine', 'medicine,vitamin,vitamins,inhaler,meds'],
    ['⭐', 'Star', 'star,done,finish'],
  ].map(([e, label, words]) => ({ e, label, words: words.split(',') }));
  const bare = (e) => String(e || '').replace(/\ufe0f/g, '').trim();
  const BY_BARE = {};
  EMOJI.forEach((x) => { BY_BARE[bare(x.e)] = x; });
  /** An emoji from the set (in its own spelling), or null. */
  function emojiOf(v) { const x = BY_BARE[bare(v)]; return x ? x.e : null; }
  function emojiLabel(v) { const x = BY_BARE[bare(v)]; return x ? x.label : ''; }
  const singular = (w) => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
  /** The best emoji for a step's name: the longest phrase it contains. */
  function emojiFor(name) {
    const words = String(name || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
    const hay = ` ${words.join(' ')} `;
    const hay1 = ` ${words.map(singular).join(' ')} `;
    let best = null; let len = 0;
    for (const x of EMOJI) {
      for (const w of x.words) {
        if ((hay.includes(` ${w} `) || hay1.includes(` ${w} `)) && w.length > len) { best = x.e; len = w.length; }
      }
    }
    return best || '⭐';
  }

  const STICKERS = ['🦄', '🦖', '🚀', '🌈', '🐙', '🦊', '🐢', '🍩', '🎈', '🐳', '🦋', '🌻', '🍕', '🐼', '🦁', '🐸', '🪐', '🐝', '🍓', '🦕', '🐬', '🌟', '🐞', '🦉', '🧁', '🐧', '🦒', '🐨', '🍦', '🎸'];
  const AVATARS = ['🦊', '🐼', '🦁', '🐸', '🐙', '🦄', '🐯', '🐨'];
  const AVATAR_NAMES = ['Fox', 'Panda', 'Lion', 'Frog', 'Octopus', 'Unicorn', 'Tiger', 'Koala'];
  // White text holds 4.5:1 or better on each (test/run.js measures them).
  const COLORS = [
    { id: 'sun', label: 'Sunrise', hex: '#c2410c' },
    { id: 'sea', label: 'Sea', hex: '#0e7490' },
    { id: 'leaf', label: 'Leaf', hex: '#15803d' },
    { id: 'plum', label: 'Plum', hex: '#7e22ce' },
  ];
  const COLOR_IDS = COLORS.map((c) => c.id);

  /** FNV-1a, for choosing a sticker without dice. */
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  /** The sticker a finished routine earns: the same on every device. */
  function stickerFor(childId, day, routineId) { return STICKERS[hash(`${childId}|${day}|${routineId}`) % STICKERS.length]; }

  /* ------------------------------------------------------------------ *
   * Days and times
   * ------------------------------------------------------------------ */

  const pad = (n) => (n < 10 ? '0' : '') + n;
  function isDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }
  function dayMs(iso) { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); }
  function isoOf(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
  function addDays(iso, n) { return isoOf(dayMs(iso) + n * 86400000); }
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / 86400000); }
  function weekday(iso) { return new Date(dayMs(iso)).getUTCDay(); }
  function niceDay(iso) { const d = new Date(dayMs(iso)); return `${DAY_SHORT[d.getUTCDay()]} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`; }
  function shortDay(iso) { const d = new Date(dayMs(iso)); return `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`; }

  function toMin(t) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t === null || t === undefined ? '' : t).trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  const mod = (m) => ((Math.round(m) % 1440) + 1440) % 1440;
  function hhmm(min) { const m = mod(min); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
  /** 7:05 PM, or 19:05 for a 24-hour clock. */
  function fmtTime(min, h12) {
    const m = mod(min); const h = Math.floor(m / 60); const mm = m % 60;
    if (h12 === false) return `${pad(h)}:${pad(mm)}`;
    return `${h % 12 || 12}:${pad(mm)} ${h < 12 ? 'AM' : 'PM'}`;
  }
  function fmtMinutes(n) {
    n = Math.max(0, Math.round(n));
    if (n < 60) return plural(n, 'minute');
    const h = Math.floor(n / 60); const r = n % 60;
    return r ? `${plural(h, 'hour')} ${plural(r, 'minute')}` : plural(h, 'hour');
  }
  function fmtDays(days) {
    const set = [...new Set(days)].sort();
    if (set.length === 7) return 'Every day';
    if (set.join() === '1,2,3,4,5') return 'Weekdays';
    if (set.join() === '0,6') return 'Weekends';
    if (!set.length) return 'No days';
    return WEEK.filter((d) => set.includes(d)).map((d) => DAY_SHORT[d]).join(', ');
  }

  /* ---- time zones, with Intl alone (no tz database shipped) ---- */

  const dtfs = {};
  function dtf(tz) {
    const k = tz || '';
    if (!dtfs[k]) {
      dtfs[k] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz || undefined, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    }
    return dtfs[k];
  }
  function partsOf(ms, tz) {
    const o = {};
    for (const p of dtf(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
    return { y: Number(o.year), mo: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, mi: Number(o.minute), s: Number(o.second) };
  }
  /** Minutes east of UTC in `tz` at the instant `ms`. */
  function offsetAt(ms, tz) {
    const p = partsOf(ms, tz);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  }
  /** The calendar day in `tz` at `ms`. */
  function dayOf(ms, tz) { const p = partsOf(ms, tz); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; }
  /** Minutes since local midnight in `tz` at `ms`. */
  function minuteOf(ms, tz) { const p = partsOf(ms, tz); return p.h * 60 + p.mi; }
  function zoneOk(tz) {
    if (typeof tz !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.length > 40) return false;
    try { dtf(tz).format(0); return true; } catch (e) { return false; }
  }

  /**
   * The next time the clocks change in `tz`, within `days` days of `nowMs`:
   * {at, before, after, delta, day, wallFrom, wallTo, kind}. `at` is the
   * first instant on the new offset, found to the minute; `day` is the local
   * day it happens on; `kind` is 'back' (an hour is repeated, autumn) or
   * 'forward' (an hour is skipped, spring). Null when none is coming - most
   * of the world never changes, and that is answered the same way.
   */
  function nextChange(nowMs, tz, days) {
    const span = days === undefined ? 60 : days;
    const H = 3600000;
    let prevT = nowMs;
    let prev = offsetAt(nowMs, tz);
    // Every six hours: two changes can never fall inside one step.
    for (let t = nowMs + 6 * H; t <= nowMs + span * 24 * H; t += 6 * H) {
      const o = offsetAt(t, tz);
      if (o !== prev) {
        let lo = Math.floor(prevT / 60000) * 60000;
        let hi = Math.ceil(t / 60000) * 60000;
        while (hi - lo > 60000) {
          const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
          if (offsetAt(mid, tz) === prev) lo = mid; else hi = mid;
        }
        const delta = o - prev;
        return {
          at: hi, before: prev, after: o, delta, day: dayOf(hi, tz),
          wallFrom: mod(minuteOf(hi - 60000, tz) + 1), wallTo: minuteOf(hi, tz),
          kind: delta < 0 ? 'back' : 'forward',
        };
      }
      prevT = t; prev = o;
    }
    return null;
  }

  /**
   * Ease into a clock change: move lights-out (and, only if asked, the morning)
   * 15 minutes a day across the days before it, so the new clock's usual
   * time feels normal on the day itself. Clocks going back (an hour longer
   * in bed by the clock) means LATER each day; forward means EARLIER.
   * Fewer days left than steps needed: the same total over the days there
   * are, in 5-minute steps. None left: null.
   */
  function clockPlan(change, today, opts) {
    if (!change || !isDay(change.day) || !isDay(today) || !change.delta) return null;
    const total = Math.abs(change.delta);
    const want = Math.max(1, Math.ceil(total / 15));
    const first = addDays(change.day, -want);
    const from = today > first ? today : first;
    const left = daysBetween(from, change.day);
    if (left <= 0) return null;
    const sign = change.delta < 0 ? 1 : -1;
    const days = [];
    for (let i = 1; i <= left; i++) {
      const step = left === want ? Math.min(total, 15 * i) : Math.round((total * i / left) / 5) * 5;
      days.push({ day: addDays(from, i - 1), shift: sign * step });
    }
    return {
      at: change.at, day: change.day, delta: change.delta, kind: change.kind,
      days, mornings: Boolean(opts && opts.mornings === true), made: today,
    };
  }
  /** Minutes a routine moves on `day` under a plan (0 when it does not). */
  function shiftFor(plan, day, kind) {
    if (!plan || !Array.isArray(plan.days)) return 0;
    if (kind !== 'bedtime' && kind !== 'morning') return 0;
    if (kind === 'morning' && plan.mornings !== true) return 0;
    const hit = plan.days.find((d) => d.day === day);
    return hit ? hit.shift : 0;
  }
  function cleanPlan(x) {
    if (!x || typeof x !== 'object') return null;
    if (!isDay(x.day) || !Number.isInteger(x.delta) || Math.abs(x.delta) > 180 || !x.delta) return null;
    const days = (Array.isArray(x.days) ? x.days : []).slice(0, 14)
      .filter((d) => d && isDay(d.day) && d.day < x.day && Number.isInteger(d.shift) && Math.abs(d.shift) <= 180)
      .map((d) => ({ day: d.day, shift: d.shift }));
    if (!days.length) return null;
    return {
      at: Number.isFinite(x.at) ? Math.round(x.at) : 0, day: x.day, delta: x.delta,
      kind: x.delta < 0 ? 'back' : 'forward', days, mornings: x.mornings === true, made: isDay(x.made) ? x.made : days[0].day,
    };
  }

  /* ------------------------------------------------------------------ *
   * Templates: four, each in three ages. Steps are [emoji, name, minutes].
   * Names speak to the child ("Brush your teeth") and never assume who
   * they are.
   * ------------------------------------------------------------------ */

  const TEMPLATES = [
    {
      id: 'school-morning', name: 'Morning school day', routine: 'School morning', kind: 'morning', emoji: '🌞', days: [1, 2, 3, 4, 5],
      doneBy: { little: '08:00', middle: '08:00', big: '08:00' },
      blurb: 'Dressed, fed, teeth, bag and shoes - out the door on time.',
      steps: {
        little: [['🚽', 'Potty', 3], ['🧼', 'Wash your hands and face', 3], ['👕', 'Get dressed', 8], ['🥣', 'Breakfast', 15], ['🪥', 'Brush your teeth', 3], ['💇', 'Brush your hair', 2], ['🧥', 'Coat on', 3], ['👟', 'Shoes on', 3]],
        middle: [['🚽', 'Toilet and wash', 4], ['👕', 'Get dressed', 6], ['🥣', 'Breakfast', 15], ['🪥', 'Brush your teeth', 3], ['💇', 'Do your hair', 2], ['🎒', 'Pack your bag', 3], ['🧥', 'Coat on', 2], ['👟', 'Shoes on', 2]],
        big: [['🛏️', 'Make your bed', 3], ['👕', 'Get dressed', 5], ['🥣', 'Breakfast', 15], ['🪥', 'Brush your teeth', 3], ['💇', 'Do your hair', 3], ['🥪', 'Pack your lunch', 5], ['🎒', 'Check your bag', 2], ['👟', 'Shoes and coat', 3]],
      },
    },
    {
      id: 'weekend-morning', name: 'Weekend morning', routine: 'Weekend morning', kind: 'morning', emoji: '🥞', days: [0, 6],
      doneBy: { little: '09:30', middle: '09:30', big: '10:00' },
      blurb: 'A slower start, with the bed made and the room tidy.',
      steps: {
        little: [['🚽', 'Potty', 3], ['🥣', 'Breakfast', 20], ['🪥', 'Brush your teeth', 3], ['👕', 'Get dressed', 8], ['🧸', 'Toys back in the box', 8]],
        middle: [['🚽', 'Toilet and wash', 4], ['🥣', 'Breakfast', 20], ['🪥', 'Brush your teeth', 3], ['👕', 'Get dressed', 6], ['🛏️', 'Make your bed', 3], ['🧹', 'Tidy your room', 10]],
        big: [['🥣', 'Breakfast', 20], ['🪥', 'Brush your teeth', 3], ['👕', 'Get dressed', 5], ['🛏️', 'Make your bed', 3], ['🧺', 'Clothes in the basket', 3], ['🧹', 'Tidy your room', 10]],
      },
    },
    {
      id: 'bedtime', name: 'Bedtime', routine: 'Bedtime', kind: 'bedtime', emoji: '🌙', days: [0, 1, 2, 3, 4, 5, 6],
      doneBy: { little: '19:30', middle: '20:00', big: '20:45' },
      blurb: 'Tidy, pajamas, teeth, a story and into bed.',
      steps: {
        little: [['🧸', 'Toys away', 5], ['🌛', 'Pajamas on', 5], ['🪥', 'Brush your teeth', 3], ['🚽', 'Potty', 3], ['💧', 'Sip of water', 1], ['📖', 'Story time', 15], ['🤗', 'Hugs', 2], ['🛌', 'Into bed', 2]],
        middle: [['🧸', 'Tidy up', 5], ['🌛', 'Pajamas on', 4], ['🪥', 'Brush your teeth', 3], ['🚽', 'Toilet', 2], ['🎒', 'Bag ready for tomorrow', 3], ['📖', 'Read together', 15], ['🤗', 'Hugs', 2], ['🛌', 'Into bed', 1]],
        big: [['🎒', 'Pack your bag for tomorrow', 4], ['👕', 'Clothes out for tomorrow', 3], ['🌛', 'Pajamas on', 3], ['🦷', 'Brush and floss', 4], ['📚', 'Read on your own', 20], ['💬', 'Talk about your day', 5], ['🛌', 'Into bed', 1]],
      },
    },
    {
      id: 'bath-night', name: 'Bath night', routine: 'Bath night', kind: 'bedtime', emoji: '🛁', days: [0, 3],
      doneBy: { little: '19:30', middle: '20:00', big: '20:45' },
      blurb: 'Bedtime with a bath in it - for the nights that have one.',
      steps: {
        little: [['🧸', 'Toys away', 5], ['🛁', 'Bath time', 20], ['🧴', 'Dry off', 4], ['🌛', 'Pajamas on', 5], ['🪥', 'Brush your teeth', 3], ['📖', 'Story time', 15], ['🤗', 'Hugs', 2], ['🛌', 'Into bed', 2]],
        middle: [['🧸', 'Tidy up', 5], ['🛁', 'Bath time', 20], ['🌛', 'Pajamas on', 4], ['🪥', 'Brush your teeth', 3], ['🎒', 'Bag ready for tomorrow', 3], ['📖', 'Read together', 15], ['🛌', 'Into bed', 1]],
        big: [['🎒', 'Pack your bag for tomorrow', 4], ['🚿', 'Shower', 10], ['🌛', 'Pajamas on', 3], ['🦷', 'Brush and floss', 4], ['📚', 'Read on your own', 20], ['🛌', 'Into bed', 1]],
      },
    },
  ];
  const DEMO_STEPS = [['🪥', 'Brush your teeth', 1], ['🌛', 'Pajamas on', 1], ['📖', 'Pick a story', 1], ['🤗', 'Big hug', 1], ['🛌', 'Into bed', 1]];

  function template(id) { return TEMPLATES.find((t) => t.id === id) || null; }
  const bandOf = (b) => (BAND_IDS.includes(b) ? b : 'middle');
  const ROUTINE_ICON = { morning: '🌞', bedtime: '🌙', other: '⭐' };
  const ROUTINE_ICONS = ['🌞', '🌙', '🛁', '🥞', '⭐', '🏫', '🌈', '🎒', '📚', '⚽'];
  const DONE_BY_WORD = { morning: 'Out the door by', bedtime: 'Lights out by', other: 'Done by' };
  const DONE_BY_SHORT = { morning: 'out the door', bedtime: 'lights out', other: 'done' };

  /** A routine from a template, for a child of `band`. `ids()` makes ids. */
  function fromTemplate(id, band, ids, opts) {
    const t = template(id);
    if (!t) return null;
    const b = bandOf(band);
    const o = opts || {};
    const doneBy = toMin(o.doneBy) !== null ? hhmm(toMin(o.doneBy)) : t.doneBy[b];
    return {
      id: ids(), kind: t.kind, name: t.routine, emoji: t.emoji, doneBy, days: t.days.slice(),
      steps: t.steps[b].map(([emoji, name, minutes]) => ({ id: ids(), emoji, name, minutes })),
      template: t.id, since: isDay(o.today) ? o.today : null,
    };
  }
  /** The made-up routine "Try it" taps through. Never saved. */
  function demoRoutine() {
    return {
      id: 'demo', kind: 'bedtime', name: 'Bedtime (try it)', emoji: '🌙', doneBy: '19:30', days: [0, 1, 2, 3, 4, 5, 6],
      steps: DEMO_STEPS.map(([emoji, name, minutes], i) => ({ id: `demo${i + 1}`, emoji, name, minutes })), template: null, since: null, demo: true,
    };
  }

  /* ------------------------------------------------------------------ *
   * Cleaning: every field either side accepts goes through here.
   * ------------------------------------------------------------------ */

  function cleanStep(x) {
    if (!x || typeof x !== 'object') return null;
    const name = line(x.name, LIMITS.stepName);
    if (!name || !isId(x.id)) return null;
    const out = { id: x.id, emoji: emojiOf(x.emoji) || emojiFor(name), name, minutes: clampInt(x.minutes, LIMITS.minMinutes, LIMITS.maxMinutes, 3) };
    const game = plainOut(x.game, LIMITS.game);
    if (game) out.game = game;
    return out;
  }
  function cleanDays(v) {
    const days = [...new Set((Array.isArray(v) ? v : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    return days.length ? days : [0, 1, 2, 3, 4, 5, 6];
  }
  function cleanRoutine(x) {
    if (!x || typeof x !== 'object' || !isId(x.id)) return null;
    const kind = KINDS.includes(x.kind) ? x.kind : 'other';
    const seen = new Set();
    const steps = [];
    for (const s of Array.isArray(x.steps) ? x.steps : []) {
      const c = cleanStep(s);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id); steps.push(c);
      if (steps.length >= LIMITS.steps) break;
    }
    if (!steps.length) return null;
    const dflt = { morning: '08:00', bedtime: '20:00', other: '17:00' }[kind];
    return {
      id: x.id, kind,
      name: line(x.name, LIMITS.routineName) || { morning: 'Morning', bedtime: 'Bedtime', other: 'Routine' }[kind],
      emoji: ROUTINE_ICONS.includes(x.emoji) ? x.emoji : ROUTINE_ICON[kind],
      doneBy: toMin(x.doneBy) !== null ? hhmm(toMin(x.doneBy)) : dflt,
      days: cleanDays(x.days),
      steps,
      template: template(x.template) ? x.template : null,
      since: isDay(x.since) ? x.since : null,
    };
  }
  function cleanChild(x) {
    if (!x || typeof x !== 'object' || !isId(x.id)) return null;
    const seen = new Set();
    const routines = [];
    for (const r of Array.isArray(x.routines) ? x.routines : []) {
      const c = cleanRoutine(r);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id); routines.push(c);
      if (routines.length >= LIMITS.routinesPerChild) break;
    }
    return {
      id: x.id,
      name: line(x.name, LIMITS.childName),
      avatar: AVATARS.includes(x.avatar) ? x.avatar : AVATARS[0],
      color: COLOR_IDS.includes(x.color) ? x.color : COLOR_IDS[0],
      band: bandOf(x.band),
      routines,
    };
  }
  /** The family's shared settings: the clocks-change plan, and which coming
   *  change the parents said "not now" to. (Sound and read-aloud are each
   *  device's own, kept by the page.) */
  function cleanSettings(x) {
    const s = x && typeof x === 'object' ? x : {};
    return {
      plan: cleanPlan(s.plan),
      planDismissed: Number.isFinite(s.planDismissed) ? Math.round(s.planDismissed) : 0,
    };
  }
  /** The whole family document: children, their routines, the settings. */
  function cleanFamily(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
    const seen = new Set();
    const children = [];
    for (const c of Array.isArray(x.children) ? x.children : []) {
      const k = cleanChild(c);
      if (!k || seen.has(k.id)) continue;
      seen.add(k.id); children.push(k);
      if (children.length >= LIMITS.children) break;
    }
    return { v: 1, children, settings: cleanSettings(x.settings), updatedAt: Number.isFinite(x.updatedAt) ? Math.round(x.updatedAt) : 0 };
  }
  function familyBytes(f) { return new TextEncoder().encode(JSON.stringify(f)).length; }
  /** A child's name as the page shows it: theirs, or a neutral stand-in. */
  function nameOf(child, i) { return (child && child.name) || (i === undefined ? 'Your child' : `Child ${i + 1}`); }

  /* ------------------------------------------------------------------ *
   * Routines on a day
   * ------------------------------------------------------------------ */

  function totalMinutes(r) { return (r && r.steps ? r.steps : []).reduce((n, s) => n + s.minutes, 0); }
  function runsOn(r, day) { return Boolean(r && isDay(day) && r.days.includes(weekday(day))); }
  /** {start, doneBy} in minutes since midnight, with a plan's shift. */
  function timesFor(r, shift) {
    const doneBy = toMin(r.doneBy) + (shift || 0);
    return { start: doneBy - totalMinutes(r), doneBy };
  }
  function todays(child, day) {
    return (child.routines || []).filter((r) => runsOn(r, day)).sort((a, b) => toMin(a.doneBy) - toMin(b.doneBy));
  }

  /* ---- progress: one key per (child, routine, step) per day ----
   *
   * steps[day][child_routine_step] = +ms when done, -ms when un-done (so
   * an undo on one device beats an older done from another; the larger
   * time wins). fin[day][child_routine] = ms when the routine was finished
   * - a sticker, never taken back.
   */
  const KEY_RE = /^[a-z0-9]{1,16}_[a-z0-9]{1,16}_[a-z0-9]{1,16}$/;
  const FIN_RE = /^[a-z0-9]{1,16}_[a-z0-9]{1,16}$/;
  const TS_MIN = 1500000000000; const TS_MAX = 4000000000000;
  const tsOk = (v) => Number.isInteger(v) && Math.abs(v) >= TS_MIN && Math.abs(v) <= TS_MAX;
  function tapKey(c, r, s) { return `${c}_${r}_${s}`; }
  function finKey(c, r) { return `${c}_${r}`; }
  function emptyProgress() { return { steps: {}, fin: {} }; }
  function cleanProgress(x, today) {
    const out = emptyProgress();
    if (!x || typeof x !== 'object') return out;
    const lo = isDay(today) ? addDays(today, -(LIMITS.progressDays - 1)) : null;
    const loFin = isDay(today) ? addDays(today, -(LIMITS.finDays - 1)) : null;
    const hi = isDay(today) ? addDays(today, 1) : null;
    for (const [part, re, low] of [['steps', KEY_RE, lo], ['fin', FIN_RE, loFin]]) {
      const src = x[part] && typeof x[part] === 'object' ? x[part] : {};
      for (const day of Object.keys(src)) {
        if (!isDay(day) || (low && (day < low || day > hi))) continue;
        const row = src[day];
        if (!row || typeof row !== 'object') continue;
        for (const k of Object.keys(row)) {
          if (!re.test(k) || !tsOk(row[k]) || (part === 'fin' && row[k] < 0)) continue;
          (out[part][day] = out[part][day] || {})[k] = row[k];
        }
      }
    }
    return out;
  }
  /** Two copies of progress made one: per key, the later tap wins. */
  function mergeProgress(a, b) {
    const out = emptyProgress();
    for (const src of [a, b]) {
      if (!src) continue;
      for (const part of ['steps', 'fin']) {
        for (const [day, row] of Object.entries(src[part] || {})) {
          const into = (out[part][day] = out[part][day] || {});
          for (const [k, v] of Object.entries(row || {})) {
            if (!(k in into) || Math.abs(v) > Math.abs(into[k])) into[k] = v;
          }
        }
      }
    }
    return out;
  }
  function doneIds(progress, day, c, r) {
    const row = (progress && progress.steps && progress.steps[day]) || {};
    const pre = `${c}_${r}_`;
    const out = new Set();
    for (const [k, v] of Object.entries(row)) if (v > 0 && k.indexOf(pre) === 0) out.add(k.slice(pre.length));
    return out;
  }
  function isFinished(progress, day, c, r) { return Boolean(progress && progress.fin && progress.fin[day] && progress.fin[day][finKey(c, r)] > 0); }
  /** A tap as it travels: {day, c, r, s, v} or {day, c, r, fin: v}. */
  function cleanTap(t, today) {
    if (!t || typeof t !== 'object' || !isDay(t.day) || !isId(t.c) || !isId(t.r)) return null;
    if (isDay(today) && (t.day < addDays(today, -(LIMITS.progressDays - 1)) || t.day > addDays(today, 1))) return null;
    if (t.fin !== undefined) return tsOk(t.fin) && t.fin > 0 ? { day: t.day, c: t.c, r: t.r, fin: t.fin } : null;
    if (!isId(t.s) || !tsOk(t.v)) return null;
    return { day: t.day, c: t.c, r: t.r, s: t.s, v: t.v };
  }
  function applyTap(progress, t) {
    if (t.fin !== undefined) {
      const row = (progress.fin[t.day] = progress.fin[t.day] || {});
      const k = finKey(t.c, t.r);
      if (!(k in row) || t.fin > row[k]) row[k] = t.fin;
      return progress;
    }
    const row = (progress.steps[t.day] = progress.steps[t.day] || {});
    const k = tapKey(t.c, t.r, t.s);
    if (!(k in row) || Math.abs(t.v) >= Math.abs(row[k])) row[k] = t.v;
    return progress;
  }

  /**
   * Where a routine stands today, in one gentle line:
   *   "Starts 7:05 PM", "4 of 6 - on track for 8:05 PM",
   *   "4 of 6 - about 6 minutes behind", "All done", "3 of 8 done".
   */
  function status(r, done, nowMin, shift, h12) {
    const t = timesFor(r, shift);
    const total = r.steps.length;
    const n = r.steps.filter((s) => done.has(s.id)).length;
    const remaining = r.steps.filter((s) => !done.has(s.id)).reduce((m, s) => m + s.minutes, 0);
    const base = { done: n, total, start: t.start, doneBy: t.doneBy, remaining, projected: null, behind: 0 };
    if (n === total) return Object.assign(base, { state: 'finished', line: 'All done' });
    if (n === 0 && nowMin < t.start) return Object.assign(base, { state: 'later', line: `Starts ${fmtTime(t.start, h12)}` });
    if (nowMin > t.doneBy + 90) return Object.assign(base, { state: 'past', line: `${n} of ${total} done` });
    const projected = nowMin + remaining;
    const behind = Math.round(projected - t.doneBy);
    if (behind > 0) return Object.assign(base, { state: 'behind', projected, behind, line: `${n} of ${total} - about ${fmtMinutes(behind)} behind` });
    return Object.assign(base, { state: 'ontrack', projected, line: `${n} of ${total} - on track for ${fmtTime(projected, h12)}` });
  }
  /** The routine a child is most likely on now: due now, else the next one
   *  today, else the latest one not finished, else null. */
  function currentRoutine(child, day, nowMin, progress, plan) {
    const list = todays(child, day).filter((r) => !isFinished(progress, day, child.id, r.id));
    if (!list.length) return null;
    const t = (r) => timesFor(r, shiftFor(plan, day, r.kind));
    const now = list.find((r) => nowMin >= t(r).start - 120 && nowMin <= t(r).doneBy + 90);
    if (now) return now;
    const next = list.find((r) => t(r).start > nowMin);
    return next || list[list.length - 1];
  }
  function nextStep(r, done) { return r.steps.find((s) => !done.has(s.id)) || null; }

  /* ---- stickers and streaks ---- */

  /** Every sticker a child has, newest first. */
  function stickerBook(child, progress) {
    const out = [];
    const names = {};
    (child.routines || []).forEach((r) => { names[r.id] = r.name; });
    for (const [day, row] of Object.entries((progress && progress.fin) || {})) {
      for (const [k, at] of Object.entries(row || {})) {
        const [c, r] = k.split('_');
        if (c !== child.id || !(at > 0)) continue;
        out.push({ day, routine: r, routineName: names[r] || 'A routine', sticker: stickerFor(c, day, r), at });
      }
    }
    return out.sort((a, b) => (a.day === b.day ? b.at - a.at : (a.day < b.day ? 1 : -1)));
  }
  /**
   * Streaks of finished routines, counted in routine runs: every time a
   * routine was due (on its days, from the day it was added), in order. A
   * run due today that is not finished yet is still pending - it neither
   * counts nor breaks anything.
   */
  function streaks(child, progress, today) {
    const fin = (progress && progress.fin) || {};
    const firstFin = {};
    for (const [day, row] of Object.entries(fin)) {
      for (const k of Object.keys(row || {})) {
        const [c, r] = k.split('_');
        if (c === child.id && (!firstFin[r] || day < firstFin[r])) firstFin[r] = day;
      }
    }
    const routines = (child.routines || []).map((r) => {
      let since = isDay(r.since) ? r.since : today;
      if (firstFin[r.id] && firstFin[r.id] < since) since = firstFin[r.id];
      return { r, since };
    }).sort((a, b) => toMin(a.r.doneBy) - toMin(b.r.doneBy));
    let earliest = today;
    routines.forEach((x) => { if (x.since < earliest) earliest = x.since; });
    const floor = addDays(today, -(LIMITS.finDays - 1));
    if (earliest < floor) earliest = floor;
    const runs = [];
    for (let d = earliest; d <= today; d = addDays(d, 1)) {
      for (const { r, since } of routines) {
        if (d < since || !runsOn(r, d)) continue;
        const done = Boolean(fin[d] && fin[d][finKey(child.id, r.id)] > 0);
        if (d === today && !done) continue;
        runs.push(done);
      }
    }
    let best = 0; let cur = 0;
    for (const ok of runs) { cur = ok ? cur + 1 : 0; if (cur > best) best = cur; }
    return { current: cur, best, total: stickerBook(child, progress).length };
  }

  /* ------------------------------------------------------------------ *
   * Read aloud
   * ------------------------------------------------------------------ */

  const VERBS = /^(brush|get|put|wash|pack|make|eat|read|tidy|drink|take|feed|check|do|go|have|clean|wipe|find|pick|choose|open|close|turn|switch|say|give|hang|fill|clear|set|walk|practise|practice|water|talk|tell|dry|comb|floss|wake|stretch|breathe|lay|line|grab|wear|zip|tie|fetch|bring|kiss|hug|sing|draw|write)\b/i;
  /** "Time to brush your teeth!", "Time to get your coat on!",
   *  "It's story time!", "Time for hugs!" */
  function sayFor(step) {
    const name = line(step && step.name, LIMITS.stepName).replace(/[.!?]+$/, '');
    if (!name) return '';
    const lower = name.charAt(0).toLowerCase() + name.slice(1);
    const yours = (x) => (/^(your|the|my|a|an)\b/i.test(x) ? x : `your ${x}`);
    let m;
    if (/\btime$/i.test(name)) return `It's ${lower}!`;
    if (VERBS.test(name)) return `Time to ${lower}!`;
    if (/^(into|in|out|up)\b/i.test(name)) return `Time to get ${lower}!`;
    if ((m = /^(.+?) (on|off)$/i.exec(lower))) return `Time to get ${yours(m[1])} ${m[2]}!`;
    if ((m = /^(.+?) away$/i.exec(lower))) return `Time to put ${yours(m[1])} away!`;
    return `Time for ${lower}!`;
  }

  /* ------------------------------------------------------------------ *
   * The calendar file: "Start bedtime" as a weekly event at the start time.
   *
   * FLOATING local time (DTSTART:20261028T190500, no TZID, no Z): the event
   * is at 7:05 PM wherever the phone is, across a clock change and on a
   * trip, which is what a bedtime is. iOS and macOS Calendar import a
   * floating event as just that, and it needs no VTIMEZONE. A TZID would
   * need one to be correct, and building it from Intl alone would mean
   * guessing each zone's yearly rule.
   * ------------------------------------------------------------------ */

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
  const compact = (iso) => iso.replace(/-/g, '');
  function stampOf(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
  function startWord(r) { return r.kind === 'bedtime' ? 'Start bedtime' : r.kind === 'morning' ? 'Start the morning routine' : `Start ${r.name}`; }
  /**
   * @param child  {id, name}
   * @param r      a routine
   * @param o      {today, nowMs, h12}
   */
  function buildIcs(child, r, o) {
    const t = timesFor(r, 0);
    const back = t.start < 0 ? 1 : 0; // a start before midnight is the evening before
    const startMin = mod(t.start);
    const days = r.days.map((d) => (d + 7 - back) % 7);
    let first = o.today;
    for (let i = 0; i < 7 && !days.includes(weekday(first)); i++) first = addDays(first, 1);
    const who = child && child.name ? ` - ${child.name}` : '';
    const summary = `${startWord(r)}${who}`;
    const desc = [
      `${DONE_BY_WORD[r.kind]} ${fmtTime(t.doneBy, o.h12)} (${plural(totalMinutes(r), 'minute')} of steps).`,
      ...r.steps.map((s, i) => `${i + 1}. ${s.name} (${s.minutes} min)`),
      'Open Tada to start.',
    ].join('\n');
    const dur = totalMinutes(r);
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tada//Routines//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:tada-${child && isId(child.id) ? child.id : 'child'}-${r.id}@tada`,
      `DTSTAMP:${stampOf(o.nowMs)}`,
      `DTSTART:${compact(first)}T${hhmm(startMin).replace(':', '')}00`,
      `DURATION:PT${Math.max(1, dur)}M`,
      `RRULE:FREQ=WEEKLY;BYDAY=${WEEK.filter((d) => days.includes(d)).map((d) => DAY_ICS[d]).join(',')}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(desc)}`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(summary)}`, 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ];
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ *
   * The AI: what is sent, and what is accepted back.
   * ------------------------------------------------------------------ */

  // Capitalised words that are not names, so they are never taken out.
  const NOT_NAMES = new Set(('I Im Ill Ive Id OK TV PE PJs PJ iPad Lego Mum Mom Mummy Mommy Dad Daddy Grandma Grandpa Granny Nana Papa Gran ' +
    'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December ' +
    'He She They We You It My Our Their His Her The A An And But So Then After Before At In On By For With No Not If When Every Each Also Usually Always Never Sometimes ' +
    'School Bus Morning Bedtime Night Breakfast Lunch Dinner Bath Shower Teeth Shoes Bag Coat Needs Slow Fast Loves Hates Likes ' +
    'This That These Those There Here Please Thanks Thank Yes Maybe Just Only Very Really Lights Out Wake Up Get Make Brush Pack Put Read').split(' '));
  const NAMEISH = '\\p{Lu}\\p{Ll}+(?:-\\p{Lu}?\\p{Ll}+)?';
  /**
   * Names out of a sentence before it goes to a model: the family's own
   * names (signed in, the server knows them), "named X" / "called X" /
   * "my son X", a capitalised word that starts a clause about a person
   * ("Jake needs..."), and one in the middle of a sentence ("...and Jake").
   * Emails, phone numbers and links go too. Returns {text, n}.
   */
  function stripNames(text, names) {
    let s = String(text || '');
    let n = 0;
    const count = (re, by) => {
      s = s.replace(re, (...m) => {
        const out = typeof by === 'function' ? by(...m) : by;
        if (out !== m[0]) n++;
        return out;
      });
    };
    count(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '');
    count(/\b(?:https?:\/\/|www\.)\S+/gi, '');
    count(/\+?\d[\d ().-]{7,}\d/g, '');
    const swapAll = (name) => {
      const e = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      count(new RegExp(`(^|[^\\p{L}\\p{N}])${e}(['\u2019]s)?(?![\\p{L}\\p{N}])`, 'giu'), (m, pre, p) => `${pre}my child${p ? "'s" : ''}`);
    };
    const own = [...new Set((names || []).map((x) => line(x, LIMITS.childName)).filter((x) => x.length >= 2))].sort((a, b) => b.length - a.length);
    own.forEach(swapAll);
    const found = new Set();
    const keep = (w) => {
      const ok = w.split(/\s+/).every((x) => NOT_NAMES.has(x.replace(/-/g, '')));
      if (!ok) w.split(/\s+/).forEach((x) => { if (!NOT_NAMES.has(x.replace(/-/g, ''))) found.add(x); });
      return ok;
    };
    const poss = "(['\u2019]s)?";
    const mine = (p) => `my child${p ? "'s" : ''}`;
    count(new RegExp(`\\b(?:named|called|name is|name's)\\s+(${NAMEISH})${poss}`, 'gu'), (m, w) => (keep(w) ? m : ''));
    count(new RegExp(`\\b[Mm]y (?:son|daughter|boy|girl|kid|child|little one|eldest|youngest|oldest)\\s+(${NAMEISH})${poss}`, 'gu'), (m, w, p) => (keep(w) ? m : mine(p)));
    count(new RegExp(`(^|[.!?;:,]\\s*|\\n\\s*)(${NAMEISH})${poss}(?=\\s+(?:is|has|needs|likes|loves|hates|gets|takes|wants|forgets|always|never|usually|can't|won't|doesn't|dawdles)\\b)`, 'gu'), (m, pre, w, p) => (keep(w) ? m : pre + mine(p)));
    count(new RegExp(`([\\p{Ll}\\p{N}] )(${NAMEISH}(?: ${NAMEISH})*)${poss}(?![\\p{L}])`, 'gu'), (m, pre, w, p) => (keep(w) ? m : pre + mine(p)));
    // A name found once is a name everywhere: "Ava hates shoes. Ava's bag..."
    [...found].sort((a, b) => b.length - a.length).forEach(swapAll);
    s = s.replace(/\bmy child(?:\s+my child)+/gi, 'my child').replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
    return { text: s, n };
  }

  /** "Build my routine from a sentence": what reaches the model. */
  function routineBrief(input, names) {
    const x = input && typeof input === 'object' ? input : {};
    const raw = line(x.sentence, LIMITS.sentence);
    if (!raw || raw.length < 3) return null;
    const s = stripNames(raw, names);
    const sentence = line(s.text, LIMITS.sentence); // "my child" is longer than most names
    if (!sentence) return null;
    return {
      sentence, stripped: s.n,
      kind: KINDS.includes(x.kind) ? x.kind : 'morning',
      band: bandOf(x.band),
      doneBy: toMin(x.doneBy) !== null ? hhmm(toMin(x.doneBy)) : null,
    };
  }
  /** "Make this step a game": what reaches the model. */
  function gameBrief(input, names) {
    const x = input && typeof input === 'object' ? input : {};
    const st = x.step && typeof x.step === 'object' ? x.step : {};
    const raw = line(st.name, LIMITS.stepName);
    if (!raw) return null;
    const s = stripNames(raw, names);
    const name = line(s.text, LIMITS.stepName);
    if (!name) return null;
    return {
      step: { name, emoji: emojiOf(st.emoji) || emojiFor(s.text), minutes: clampInt(st.minutes, 1, 30, 3) },
      stripped: s.n, band: bandOf(x.band), kind: KINDS.includes(x.kind) ? x.kind : 'other',
    };
  }
  /** A proposed routine, as the page may show it: steps from the emoji set,
   *  1-30 minutes, at most twelve, no links, no markup. */
  function cleanProposal(raw, kind) {
    if (!raw || typeof raw !== 'object') return null;
    const k = KINDS.includes(kind) ? kind : 'morning';
    const list = Array.isArray(raw.steps) ? raw.steps.slice(0, 40) : [];
    let dropped = 0;
    const steps = [];
    for (const x of list) {
      const name = x && typeof x === 'object' ? plainOut(x.name, LIMITS.stepName) : '';
      if (!name) { dropped++; continue; }
      if (steps.length >= LIMITS.aiSteps) { dropped++; continue; }
      steps.push({ emoji: emojiOf(x.emoji) || emojiFor(name), name, minutes: clampInt(x.minutes, 1, 30, 3) });
    }
    if (!steps.length) return null;
    return {
      name: plainOut(raw.name, LIMITS.routineName) || { morning: 'Morning', bedtime: 'Bedtime', other: 'Routine' }[k],
      kind: k, steps, tip: plainOut(raw.tip, 200), dropped,
    };
  }
  /** Three short game ideas, each 140 characters at most, no links. */
  function cleanIdeas(raw) {
    const list = raw && Array.isArray(raw.ideas) ? raw.ideas.slice(0, 12) : [];
    const out = [];
    for (const x of list) {
      const t = plainOut(typeof x === 'string' ? x : (x && x.text), LIMITS.idea);
      if (t.length >= 8 && !out.some((y) => y.toLowerCase() === t.toLowerCase())) out.push(t);
      if (out.length >= LIMITS.ideas) break;
    }
    return out.length ? out : null;
  }

  return {
    LIMITS, KINDS, BANDS, DAY_SHORT, DAY_LONG, WEEK, EMOJI, STICKERS, AVATARS, AVATAR_NAMES, COLORS, TEMPLATES, ROUTINE_ICON, ROUTINE_ICONS, DONE_BY_WORD, DONE_BY_SHORT,
    line, esc, plural, clampInt, isId, stripLinks, stripMarkup, plainOut,
    emojiOf, emojiLabel, emojiFor, stickerFor, hash,
    isDay, addDays, daysBetween, weekday, niceDay, shortDay, toMin, hhmm, fmtTime, fmtMinutes, fmtDays,
    offsetAt, dayOf, minuteOf, zoneOk, nextChange, clockPlan, shiftFor, cleanPlan,
    template, fromTemplate, demoRoutine,
    cleanStep, cleanRoutine, cleanChild, cleanSettings, cleanFamily, familyBytes, nameOf,
    totalMinutes, runsOn, timesFor, todays,
    tapKey, finKey, emptyProgress, cleanProgress, mergeProgress, doneIds, isFinished, cleanTap, applyTap,
    status, currentRoutine, nextStep, stickerBook, streaks, sayFor,
    icsText, icsFold, buildIcs, startWord,
    stripNames, routineBrief, gameBrief, cleanProposal, cleanIdeas,
  };
}));
