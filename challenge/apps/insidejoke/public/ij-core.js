/* Inside Joke - the rules. One file, run twice: the page loads it as
 * window.InsideJokeCore, the server and the tests `require` it, so the
 * questions a phone builds from a chat export are checked by the same code
 * the server checks them with, and the scores every phone shows are the
 * scores the tests check.
 *
 * What is here:
 *   - reading a WhatsApp export (iOS and Android, several date locales) or a
 *     pasted "Name: message" log, entirely in the browser (parseChat);
 *   - the free chat stats and the questions made from them (chatStats,
 *     statQuestions);
 *   - stripping phone numbers, emails and links before any excerpt leaves
 *     the phone (stripPII), the excerpt itself (buildExcerpt), and checking a
 *     model's "who said it?" quote against it (verifyQuote) - the true
 *     speaker always comes from the parsed line, never from the model;
 *   - cleaning a question from anywhere (cleanQuestion);
 *   - the daily round: a deterministic draw seeded by group and date
 *     (pickRound, roundFor), grading (grade), streaks (streakOf), the
 *     leaderboard (leaderboard) and the result card (resultCard);
 *   - live game points (livePoints, settleReveal).
 *
 * Nothing here touches the network, and the clock only comes in as an
 * argument, so every rule can be tested at any date in any time zone.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InsideJokeCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    members: 30,          // a group, the host included
    name: 20,             // a member's name
    groupName: 40,
    prompt: 140,          // a question
    quote: 200,           // a "who said it?" quote
    option: 60,
    options: 4,
    questions: 1000,      // a group's bank
    photos: 300,          // a group's photos
    hint: 140,            // what the uploader says about a photo
    place: 60,
    chatChars: 12000000,  // characters of chat export read on the phone
    chatLines: 300000,
    excerpt: 400,         // messages sent to the model, at most
    excerptLine: 300,     // characters of one excerpt line
    daily: 5,             // questions in a daily round
    reserves: 5,          // spares for a player who wrote one of the five
    noRepeatDays: 30,
    liveMax: 20,          // questions in one live game
    city: 30,             // "playing from"
  };

  // Member colours: white text holds 4.5:1 or better on each (tested). A
  // colour is never the only way to tell people apart - every chip carries
  // the emoji and the name.
  var COLORS = [
    { id: 'tomato', hex: '#c0352b' }, { id: 'ocean', hex: '#1f5fbf' }, { id: 'basil', hex: '#1d7a45' },
    { id: 'grape', hex: '#6b3fc4' }, { id: 'amber', hex: '#9a5b00' }, { id: 'berry', hex: '#b0206d' },
    { id: 'teal', hex: '#0d7275' }, { id: 'slate', hex: '#4a5568' }, { id: 'rust', hex: '#a3431a' },
    { id: 'indigo', hex: '#3b4bb0' }, { id: 'olive', hex: '#5a6b12' }, { id: 'plum', hex: '#8a2f86' },
  ];
  var COLOR_IDS = COLORS.map(function (c) { return c.id; });
  function colorHex(id) { for (var i = 0; i < COLORS.length; i++) if (COLORS[i].id === id) return COLORS[i].hex; return COLORS[0].hex; }

  var EMOJI = ['😀', '😎', '🤓', '🥳', '😺', '🐶', '🦊', '🐼', '🐸', '🦄', '🐙', '🐝', '🌻', '🌵', '🍕', '🍩', '🌮', '☕', '⚽', '🏀', '🎸', '🎮', '🎲', '🚀', '⛵', '🏔️', '🌊', '🔥', '⭐', '🌈'];

  /* ---------------- text ---------------- */

  // Control characters and the bidi overrides/isolates that can turn a name
  // around on screen. The zero-width joiner (U+200D) is kept: emoji need it.
  var STRIP = /[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

  function clean(v, max) {
    var s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 200) s = s.slice(0, max * 4 + 200);
    s = s.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    var chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
    return s;
  }
  /** A member's name: a first name or a nickname, max 20 characters. */
  function cleanName(v) {
    var s = clean(v, LIMITS.name);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  function oneOf(v, list, dflt) { return list.indexOf(v) >= 0 ? v : dflt; }
  function firstWord(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/)[0] || ''; }

  /* ---------------- dates ---------------- */

  function validTz(tz) {
    if (typeof tz !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.length > 40) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
  }
  /** The calendar day in a time zone, as YYYY-MM-DD. */
  function dayIn(tz, ms) {
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: validTz(tz) ? tz : 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    var o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    return o.year + '-' + o.month + '-' + o.day;
  }
  /** Milliseconds until the next midnight in a time zone (DST-safe: it asks
   *  the zone, minute by minute from the hour estimate). */
  function msToMidnight(tz, ms) {
    var today = dayIn(tz, ms);
    var parts = new Intl.DateTimeFormat('en-GB', { timeZone: validTz(tz) ? tz : 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
    var o = {};
    parts.forEach(function (p) { o[p.type] = Number(p.value); });
    var guess = ((23 - o.hour) * 3600 + (59 - o.minute) * 60 + (60 - o.second)) * 1000;
    // Walk to the first instant whose day differs (covers 23- and 25-hour days).
    var t = ms + guess - 2 * 3600 * 1000;
    if (dayIn(tz, t) !== today) t = ms;
    while (dayIn(tz, t + 60000) === today) t += 60000;
    while (dayIn(tz, t) === today) t += 1000;
    return t - ms;
  }
  function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
  function addDays(date, n) {
    var t = Date.parse(date + 'T00:00:00Z') + n * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  }
  function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dateLabel(date, withYear) {
    if (!isDate(date)) return '';
    var d = new Date(date + 'T00:00:00Z');
    return DOW[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + (withYear ? ' ' + d.getUTCFullYear() : '');
  }

  /* ---------------- a seeded draw ---------------- */

  // FNV-1a over the UTF-16 units, then mulberry32. Not cryptographic - it
  // only has to give every phone and every server the same order.
  function hash32(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function rng(seed) {
    var a = hash32(seed);
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(list, rand) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /* ---------------- reading a chat export ---------------- */

  // A message's first line. iOS wraps the stamp in brackets and puts the
  // name straight after; Android puts " - " between them. Dates come as
  // D/M/Y, M/D/Y, D.M.Y or Y-M-D with 2- or 4-digit years, times as 24-hour
  // or 12-hour (with "AM", "a.m." or a narrow no-break space before it).
  // Groups: 1 first number, 2 separator, 3 second, 4 third, 5 hour,
  // 6 minute, 7 seconds, 8 am/pm.
  var STAMP = '(\\d{1,4})([./-])(\\d{1,2})[./-](\\d{2,4}),?\\s+(\\d{1,2})[:.](\\d{2})(?:[:.](\\d{2}))?\\s*([AaPp]\\.?\\s?[Mm]\\.?)?';
  var IOS = new RegExp('^\\[' + STAMP + '\\]\\s*(.*)$');
  var ANDROID = new RegExp('^' + STAMP + '\\s+[-\u2013]\\s+(.*)$');
  var MEDIA = /^(?:image|video|audio|sticker|gif|document|contact card|photo) omitted$|<attached: [^>]*>|^<media omitted>$|^null$|\.(?:jpe?g|png|webp|opus|mp4|pdf) \(file attached\)$/i;
  var DELETED = /^(?:this message was deleted|you deleted this message|message deleted)\.?$/i;
  var SYSTEM_NAME = /\b(?:changed|added|removed|created|left|joined|deleted|pinned)\b/i;
  var STRIP_KEEP_NL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

  function normLine(s) { return s.replace(/[\u00a0\u202f\u2007]/g, ' '); }

  /**
   * @param text  the whole export, or a pasted log
   * @returns {format, messages: [{date|null, hour|null, minute|null, name,
   *          text, media}], names, system, skipped, order}
   * Multi-line messages are joined. System lines (encryption notices,
   * "added", "left") are counted and dropped; deleted messages too.
   */
  function parseChat(text, opts) {
    opts = opts || {};
    var src = typeof text === 'string' ? text : '';
    if (src.length > LIMITS.chatChars) src = src.slice(0, LIMITS.chatChars);
    var lines = src.split(/\r\n|\r|\n/);
    if (lines.length > LIMITS.chatLines) lines = lines.slice(0, LIMITS.chatLines);
    var raw = [];
    var cur = null;
    var stamped = 0;
    var nonEmpty = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = normLine(lines[i]).replace(/^[\u200e\u200f\ufeff\s]+/, '');
      if (line.trim()) nonEmpty++;
      var m = IOS.exec(line) || ANDROID.exec(line);
      if (m) {
        stamped++;
        cur = { s: m.slice(1, 9), rest: m[9], more: [] };
        raw.push(cur);
      } else if (cur) {
        cur.more.push(lines[i]);
      }
    }
    // An export is mostly stamped lines (continuations aside); a pasted log
    // has none.
    if (!stamped || stamped < Math.min(3, nonEmpty) * 0.5) return parsePasted(lines);
    var order = dateOrder(raw, opts.order);
    var out = [];
    var system = 0;
    var skipped = 0;
    for (var k = 0; k < raw.length; k++) {
      var r = raw[k];
      var when = stampOf(r.s, order);
      var nm = /^([^:]{1,60}?):\s(.*)$/.exec(r.rest);
      // Android writes system lines with no "Name: " at all.
      if (!nm) { system++; continue; }
      var who = nm[1].replace(/^~\s*/, '');
      if (SYSTEM_NAME.test(who) && who.split(/\s+/).length > 2) { system++; continue; }
      // iOS writes them under the group's name, marked with U+200E -
      // which it also puts in front of "image omitted".
      var firstLine = nm[2];
      var bareFirst = firstLine.replace(/^[\u200e\u200f\s]+/, '');
      if (/^\u200e/.test(firstLine) && !MEDIA.test(bareFirst)) { system++; continue; }
      var name = cleanName(who);
      if (!name) { skipped++; continue; }
      var body = [bareFirst].concat(r.more).join('\n').replace(STRIP_KEEP_NL, '').trim();
      if (DELETED.test(body)) { skipped++; continue; }
      var media = MEDIA.test(body);
      out.push({ date: when.date, hour: when.hour, minute: when.minute, name: name, text: media ? '' : body.slice(0, 4000), media: media });
    }
    return finish('whatsapp', out, system, skipped, order);
  }

  /** A plain "Name: message" log, pasted. No times, so no time stats. */
  function parsePasted(lines) {
    var out = [];
    var skipped = 0;
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var line = normLine(lines[i]).replace(/^[\u200e\u200f\ufeff\s]+/, '');
      if (!line.trim()) continue;
      var m = /^([^:\n]{1,30}?):\s+(.+)$/.exec(line);
      var name = m && !/^(?:https?|www)$/i.test(m[1].trim()) ? cleanName(m[1]) : '';
      if (name) {
        cur = { date: null, hour: null, minute: null, name: name, text: m[2].replace(STRIP_KEEP_NL, '').trim(), media: false };
        out.push(cur);
      } else if (cur) {
        cur.text += '\n' + line.replace(STRIP_KEEP_NL, '').trim();
      } else skipped++;
    }
    out.forEach(function (o) { o.media = MEDIA.test(o.text); if (o.media) o.text = ''; });
    return finish('pasted', out, 0, skipped, null);
  }

  function finish(format, messages, system, skipped, order) {
    var names = [];
    var seen = {};
    messages.forEach(function (m) {
      var k = m.name.toLowerCase();
      if (!seen[k]) { seen[k] = m.name; names.push(m.name); } else m.name = seen[k];
    });
    return { format: format, messages: messages, names: names, system: system, skipped: skipped, order: order };
  }

  /** Which of the first two numbers is the day: decided once per file, from
   *  the stamps themselves where they say (a 13 or more), then from how the
   *  export looks (dots are European; AM/PM is mostly the US). */
  function dateOrder(raw, hint) {
    if (hint === 'dmy' || hint === 'mdy') return hint;
    var dmy = false; var mdy = false; var dots = false; var ampm = false; var ymd = 0; var n = 0;
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i].s;
      n++;
      if (s[0].length === 4) { ymd++; continue; }
      var a = Number(s[0]); var b = Number(s[2]);
      if (a > 12) dmy = true;
      if (b > 12) mdy = true;
      if (s[1] === '.') dots = true;
      if (s[7]) ampm = true;
    }
    if (ymd && ymd === n) return 'ymd';
    if (dmy && !mdy) return 'dmy';
    if (mdy && !dmy) return 'mdy';
    if (dots) return 'dmy';
    return ampm ? 'mdy' : 'dmy';
  }
  function stampOf(s, order) {
    var y; var mo; var d;
    if (s[0].length === 4) { y = Number(s[0]); mo = Number(s[2]); d = Number(s[3]); }
    else if (order === 'mdy') { mo = Number(s[0]); d = Number(s[2]); y = Number(s[3]); }
    else { d = Number(s[0]); mo = Number(s[2]); y = Number(s[3]); }
    if (y < 100) y += 2000;
    var h = Number(s[4]);
    var mi = Number(s[5]);
    if (s[7]) {
      var pm = /^p/i.test(s[7]);
      if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
    }
    var ok = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100 && h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
    if (!ok) return { date: null, hour: null, minute: null };
    var date = y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
    return isDate(date) && new Date(date + 'T00:00:00Z').getUTCDate() === d ? { date: date, hour: h, minute: mi } : { date: null, hour: null, minute: null };
  }

  /* ---------------- the free chat stats ---------------- */

  var LOL = /\b(?:l+o+l+z?|lmf?ao+|rofl|ha(?:ha)+h?|he(?:he)+|jaja(?:ja)*|kkkk+)\b|😂|🤣/i;
  var EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?)*/gu;
  var SKIN = /[\u{1F3FB}-\u{1F3FF}]/gu;

  function chatStats(parsed) {
    var msgs = (parsed && parsed.messages) || [];
    var by = {};
    var order = [];
    var days = {};
    var emojiAll = {};
    var timed = 0;
    var first = msgs[0] || null;
    var longest = null;
    msgs.forEach(function (m) {
      var p = by[m.name];
      if (!p) { p = by[m.name] = { name: m.name, count: 0, night: 0, early: 0, lol: 0, emoji: {}, emojiN: 0, longest: 0 }; order.push(m.name); }
      p.count++;
      if (m.hour !== null && m.hour !== undefined) {
        timed++;
        if (m.hour >= 23 || m.hour < 4) p.night++;
        if (m.hour >= 5 && m.hour < 8) p.early++;
      }
      if (m.date) days[m.date] = (days[m.date] || 0) + 1;
      if (!m.media && m.text) {
        if (LOL.test(m.text)) p.lol++;
        var es = m.text.replace(SKIN, '').match(EMOJI_RE);
        if (es) es.forEach(function (e) { e = e.replace(/\uFE0F/g, ''); p.emoji[e] = (p.emoji[e] || 0) + 1; p.emojiN++; emojiAll[e] = (emojiAll[e] || 0) + 1; });
        var len = Array.from(m.text).length;
        if (len > p.longest) p.longest = len;
        if (!longest || len > longest.len) longest = { name: m.name, len: len };
      }
    });
    var people = order.map(function (n) {
      var p = by[n];
      var top = Object.keys(p.emoji).sort(function (a, b) { return p.emoji[b] - p.emoji[a] || (a < b ? -1 : 1); })[0] || null;
      return { name: n, count: p.count, night: p.night, early: p.early, lol: p.lol, topEmoji: top, topEmojiN: top ? p.emoji[top] : 0, emojiN: p.emojiN, longest: p.longest };
    }).sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : 1); });
    var dayKeys = Object.keys(days).sort();
    var busiest = null;
    dayKeys.forEach(function (d) { if (!busiest || days[d] > busiest.count) busiest = { date: d, count: days[d] }; });
    var topDays = dayKeys.slice().sort(function (a, b) { return days[b] - days[a] || (a < b ? -1 : 1); }).slice(0, 8).map(function (d) { return { date: d, count: days[d] }; });
    return {
      total: msgs.length,
      people: people,
      hasTime: timed > 0,
      first: first ? { name: first.name, date: first.date } : null,
      busiest: busiest,
      topDays: topDays,
      from: dayKeys[0] || null,
      to: dayKeys[dayKeys.length - 1] || null,
      longest: longest,
      topEmoji: Object.keys(emojiAll).sort(function (a, b) { return emojiAll[b] - emojiAll[a] || (a < b ? -1 : 1); }).slice(0, 5),
    };
  }

  /** The unique leader of a stat, or null on a tie or too little to go on. */
  function leader(people, key, min) {
    var s = people.slice().sort(function (a, b) { return b[key] - a[key]; });
    if (!s.length || s[0][key] < (min || 1)) return null;
    if (s[1] && s[1][key] === s[0][key]) return null;
    return s[0];
  }
  /** Up to four names: the answer plus the busiest others, in a seeded order. */
  function nameOptions(people, answer, seed) {
    var others = people.filter(function (p) { return p.name !== answer; }).slice(0, 3).map(function (p) { return p.name; });
    var opts = shuffled([answer].concat(others), rng(seed));
    return { options: opts, answer: opts.indexOf(answer) };
  }

  /**
   * Questions the group can answer from memory, computed on the phone from
   * the stats - no model, no cost. Only stats with a clear winner become a
   * question. Each is a draft the importer reviews before it joins the bank.
   */
  function statQuestions(stats, seed) {
    seed = seed || 'chat';
    var people = (stats && stats.people) || [];
    var out = [];
    if (people.length < 2) return out;
    function who(prompt, p, key) {
      var o = nameOptions(people, p.name, seed + key);
      out.push({ kind: 'choice', style: 'chat_stat', prompt: prompt, options: o.options, answer: o.answer, aboutName: p.name, stat: key });
    }
    var most = leader(people, 'count', 5);
    if (most) who('Who sends the most messages in the group chat?', most, 'count');
    if (stats.hasTime) {
      var owl = leader(people, 'night', 3);
      if (owl) who('Who’s the night owl - most messages between 11pm and 4am?', owl, 'night');
      var bird = leader(people, 'early', 3);
      if (bird) who('Who’s the early bird - most messages between 5 and 8am?', bird, 'early');
    }
    var lol = leader(people, 'lol', 3);
    if (lol) who('Who laughs the most - “lol”, “haha” and 😂?', lol, 'lol');
    if (stats.longest && stats.longest.len >= 80) who('Who sent the longest message ever in the chat?', { name: stats.longest.name }, 'longest');
    if (stats.first) who('Who sent the very first message in this chat?', { name: stats.first.name }, 'first');
    // An emoji that is one person's favourite and nobody else's.
    var favs = people.filter(function (p) { return p.topEmoji && p.topEmojiN >= 3; });
    for (var i = 0; i < favs.length; i++) {
      var e = favs[i].topEmoji;
      if (favs.filter(function (p) { return p.topEmoji === e; }).length === 1) { who('Whose favourite emoji is ' + e + '?', favs[i], 'emoji'); break; }
    }
    if (stats.busiest && stats.topDays && stats.topDays.length >= 4 && stats.topDays[0].count > stats.topDays[1].count) {
      var ds = shuffled(stats.topDays.slice(0, 4).map(function (d) { return d.date; }), rng(seed + 'busy'));
      out.push({ kind: 'choice', style: 'chat_stat', prompt: 'Which was the chat’s busiest day ever?', options: ds.map(function (d) { return dateLabel(d, true); }), answer: ds.indexOf(stats.busiest.date), aboutName: null, stat: 'busiest' });
    }
    if (stats.total >= 50) {
      out.push({ kind: 'number', style: 'chat_stat', prompt: 'How many messages are in this chat export?', answer: stats.total, tolerance: Math.max(1, Math.round(stats.total * 0.1)), unit: 'messages', aboutName: null, stat: 'total' });
    }
    return out;
  }

  /* ---------------- what leaves the phone ---------------- */

  var EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  var URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>]+|\b[a-z0-9-]+\.(?:com|net|org|io|co|uk|me|app|ly|gl|be|tv|us|de|fr|es|it|nl|ca|au)(?:\/[^\s<>]*)?/gi;
  // A run of 7+ digits allowing spaces, dots, dashes and brackets between
  // them, with an optional +: phone numbers in any country's format. A year
  // or a time has fewer digits and is left alone.
  var PHONE = /(?:\+|\(|\b00)?\d(?:[\s().-]{0,2}\d){6,}\)?/g;

  /** Phone numbers, emails and links out - run in the browser before any
   *  excerpt is sent, and again by the server on what arrives. */
  function stripPII(s) {
    return String(s || '')
      .replace(EMAIL, '[email]')
      .replace(URL_RE, '[link]')
      .replace(PHONE, '[phone]')
      .replace(/@\[phone\]/g, '[phone]');
  }

  /**
   * A sampled excerpt for the "who said it?" round: up to 400 messages from
   * windows spread across the chat (so it is not all from last week), media
   * and very short lines left out, every line stripped and bounded. Names are
   * kept - they are what the game is about.
   */
  function buildExcerpt(parsed, max) {
    max = Math.min(max || LIMITS.excerpt, LIMITS.excerpt);
    var msgs = ((parsed && parsed.messages) || []).filter(function (m) { return !m.media && m.text && Array.from(m.text).length >= 12; });
    var pick = [];
    if (msgs.length <= max) pick = msgs;
    else {
      var windows = 8;
      var per = Math.floor(max / windows);
      for (var w = 0; w < windows; w++) {
        var start = Math.floor((msgs.length - per) * (w / (windows - 1)));
        for (var i = start; i < start + per && i < msgs.length; i++) pick.push(msgs[i]);
      }
    }
    var seen = {};
    var out = [];
    pick.forEach(function (m, idx) {
      var key = m.name + '\u0000' + m.text;
      if (seen[key] || out.length >= max) return;
      seen[key] = true;
      var t = stripPII(m.text).replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
      t = Array.from(t).slice(0, LIMITS.excerptLine).join('');
      if (t.length >= 12) out.push({ n: m.name, t: t });
    });
    return out;
  }

  /** The excerpt as it arrives at the server: bounded, stripped again. */
  function cleanExcerpt(lines) {
    if (!Array.isArray(lines)) return [];
    var out = [];
    for (var i = 0; i < lines.length && out.length < LIMITS.excerpt; i++) {
      var l = lines[i];
      if (!l || typeof l !== 'object') continue;
      var n = cleanName(l.n);
      var t = typeof l.t === 'string' ? stripPII(l.t.slice(0, LIMITS.excerptLine * 2)).replace(STRIP, ' ').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim() : '';
      t = Array.from(t).slice(0, LIMITS.excerptLine).join('');
      if (n && t.length >= 4) out.push({ n: n, t: t });
    }
    return out;
  }

  /**
   * Is this quote really in the excerpt, and who said it? An exact substring
   * of one speaker's lines (case and spacing as written). A quote that turns
   * up in two different people's lines is nobody's, and a quote with nothing
   * to it ("ok", "lol") is not a question. Returns the speaker or null.
   */
  function verifyQuote(excerpt, quote) {
    if (typeof quote !== 'string') return null;
    var q = quote.trim();
    var chars = Array.from(q).length;
    if (chars < 12 || chars > 160 || (q.match(/\p{L}+/gu) || []).length < 3) return null;
    if (/\[(?:phone|email|link)\]/.test(q)) return null;
    var who = null;
    for (var i = 0; i < excerpt.length; i++) {
      if (excerpt[i].t.indexOf(q) >= 0) {
        if (who && who !== excerpt[i].n) return null;
        who = excerpt[i].n;
      }
    }
    return who;
  }

  /* ---------------- questions ---------------- */

  var STYLES = ['own', 'own_tf', 'own_number', 'own_who', 'where', 'when', 'who_took', 'whats_happening', 'odd_one_out', 'caption_this', 'who_said', 'chat_stat'];
  var STYLE_LABEL = {
    own: 'Written by the group', own_tf: 'True or false', own_number: 'Closest guess wins', own_who: 'Who in the group…',
    where: 'Where was this?', when: 'What year?', who_took: 'Who took it?', whats_happening: 'What’s happening?',
    odd_one_out: 'Odd one out', caption_this: 'Caption this', who_said: 'Who said it?', chat_stat: 'From the group chat',
  };
  function family(style) {
    if (/^own/.test(style)) return 'own';
    if (style === 'who_said' || style === 'chat_stat') return 'chat';
    return 'photo';
  }
  // A photo question must never ask who someone is from their face: only
  // questions the group answers from memory. This catches the phrasings a
  // model reaches for; the prompt forbids them too.
  var FACE_ASK = /\bwho(?:\s+(?:is|are|was)|'s|’s)\s+(?:this|that|these|those|the\s+(?:person|people|man|men|woman|women|kid|kids|child|children|guy|guys|girl|girls|boy|boys|baby|lady|gentleman|toddler|teen)|in\s+(?:the|this)\s+(?:photo|picture|middle|front|back|centre|center)|on\s+the\s+(?:left|right)|standing|sitting|wearing|holding|smiling)\b|\bname\s+(?:the|this|that)\s+(?:person|people|man|woman|kid|child)|\bidentify\b/i;

  function isInt(v, lo, hi) { return typeof v === 'number' && Math.floor(v) === v && v >= lo && v <= hi; }

  /**
   * One question from anywhere - the page, a model, the sample - made safe,
   * or null. `ctx.members` ([{id, name}]) is needed for the "who in the
   * group" kinds, whose options ARE members: their names are taken from the
   * members, never from the request.
   */
  function cleanQuestion(raw, ctx) {
    ctx = ctx || {};
    if (!raw || typeof raw !== 'object') return null;
    var style = oneOf(raw.style, STYLES, null);
    if (!style) return null;
    var kind = style === 'caption_this' ? 'caption' : (style === 'when' || style === 'own_number' || (style === 'chat_stat' && raw.kind === 'number')) ? 'number' : 'choice';
    var prompt = clean(raw.prompt, LIMITS.prompt);
    if (!/\p{L}/u.test(prompt)) return null;
    if (FACE_ASK.test(prompt)) return null;
    var q = { kind: kind, style: style, prompt: prompt, quote: null, options: null, members: null, answer: null, tolerance: null, unit: null, photoId: null, aboutName: null };
    if (style === 'who_said') {
      q.quote = clean(raw.quote, LIMITS.quote);
      if (Array.from(q.quote).length < 8) return null;
    }
    if (raw.photoId !== undefined && raw.photoId !== null) {
      if (typeof raw.photoId !== 'string' || !/^[a-z0-9]{12,24}$/.test(raw.photoId)) return null;
      q.photoId = raw.photoId;
    }
    if (family(style) === 'photo' && !q.photoId && !ctx.allowNoPhoto) return null;
    if (raw.aboutName) q.aboutName = cleanName(raw.aboutName) || null;
    if (kind === 'number') {
      var n = typeof raw.answer === 'number' ? raw.answer : (typeof raw.answer === 'string' && /^-?\d+(?:\.\d+)?$/.test(raw.answer.trim()) ? Number(raw.answer) : NaN);
      if (!isFinite(n) || Math.abs(n) > 1e9) return null;
      q.answer = Math.round(n * 100) / 100;
      var tol = typeof raw.tolerance === 'number' && isFinite(raw.tolerance) ? Math.abs(raw.tolerance) : (style === 'when' ? 1 : 0);
      q.tolerance = Math.min(Math.round(tol * 100) / 100, Math.max(1, Math.abs(q.answer)));
      if (style === 'when' && !isInt(q.answer, 1900, 2100)) return null;
      q.unit = raw.unit ? clean(raw.unit, 12) || null : null;
      return q;
    }
    if (style === 'own_who' || style === 'who_took') {
      var members = Array.isArray(ctx.members) ? ctx.members : [];
      var ids = Array.isArray(raw.members) ? raw.members : [];
      var picked = [];
      ids.forEach(function (id) { var m = members.filter(function (x) { return x.id === id; })[0]; if (m && picked.indexOf(m) < 0) picked.push(m); });
      if (picked.length < 2 || picked.length > LIMITS.options) return null;
      q.members = picked.map(function (m) { return m.id; });
      q.options = picked.map(function (m) { return m.name; });
      if (!isInt(raw.answer, 0, picked.length - 1)) return null;
      q.answer = raw.answer;
      return q;
    }
    var opts = style === 'own_tf' ? ['True', 'False'] : Array.isArray(raw.options) ? raw.options.slice(0, LIMITS.options + 2).map(function (o) { return clean(o, LIMITS.option); }) : [];
    if (opts.length > LIMITS.options) return null;
    if (opts.length < 2 || opts.some(function (o) { return !o; })) return null;
    var low = opts.map(function (o) { return o.toLowerCase(); });
    if (low.some(function (o, i) { return low.indexOf(o) !== i; })) return null;
    q.options = opts;
    if (kind === 'caption') { q.answer = null; return q; }
    if (!isInt(raw.answer, 0, opts.length - 1)) return null;
    q.answer = raw.answer;
    return q;
  }

  /** What a player may see before answering: never the answer. */
  function publicQuestion(q) {
    return { id: q.id, kind: q.kind, style: q.style, label: STYLE_LABEL[q.style], prompt: q.prompt, quote: q.quote || null, options: q.options || null, members: q.members || null, unit: q.unit || null, photoId: q.photoId || null };
  }

  /** Is this a well-formed answer to this question? */
  function validAnswer(q, a) {
    if (q.kind === 'number') return typeof a === 'number' && isFinite(a) && Math.abs(a) <= 1e9;
    return isInt(a, 0, (q.options || []).length - 1);
  }
  /** true / false, or null when the question has no right answer (captions). */
  function grade(q, a) {
    if (q.kind === 'caption') return null;
    if (q.kind === 'number') return Math.abs(Number(a) - q.answer) <= (q.tolerance || 0) + 1e-9;
    return a === q.answer;
  }

  /* ---------------- the daily round ---------------- */

  /**
   * The day's draw: a deterministic order of up to daily + reserves
   * questions, seeded by group and date, mixing photo, chat and written
   * questions in turn, with no question used in the last 30 days while
   * fresh ones remain (then the longest-unused first). At most one caption
   * (it scores nothing) and, where it can, one question per photo.
   *
   * @param bank  [{id, style, photoId}] - live questions only
   * @param used  {qid: 'YYYY-MM-DD'} - when each was last drawn
   */
  function pickRound(bank, gid, date, used) {
    used = used || {};
    var want = LIMITS.daily + LIMITS.reserves;
    var rand = rng(gid + '|' + date);
    var sorted = bank.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    var fresh = sorted.filter(function (q) { return !used[q.id] || dayDiff(used[q.id], date) >= LIMITS.noRepeatDays; });
    var stale = sorted.filter(function (q) { return fresh.indexOf(q) < 0; }).sort(function (a, b) { return used[a.id] < used[b.id] ? -1 : used[a.id] > used[b.id] ? 1 : (a.id < b.id ? -1 : 1); });
    var fams = {};
    shuffled(fresh, rand).forEach(function (q) { var f = family(q.style); (fams[f] = fams[f] || []).push(q); });
    var famOrder = shuffled(Object.keys(fams).sort(), rand);
    var mixed = [];
    for (var more = true; more;) {
      more = false;
      for (var i = 0; i < famOrder.length; i++) { var l = fams[famOrder[i]]; if (l.length) { mixed.push(l.shift()); more = true; } }
    }
    var pool = mixed.concat(stale);
    var out = [];
    var later = [];
    var captions = 0;
    var photos = {};
    pool.forEach(function (q) {
      if (out.length >= want) return;
      var dupPhoto = q.photoId && photos[q.photoId];
      if ((q.style === 'caption_this' && captions >= 1) || dupPhoto) { later.push(q); return; }
      if (q.style === 'caption_this') captions++;
      if (q.photoId) photos[q.photoId] = true;
      out.push(q);
    });
    for (var j = 0; j < later.length && out.length < want; j++) out.push(later[j]);
    return out.map(function (q) { return q.id; });
  }

  /** Would this question be a giveaway for this player? They wrote it (or
   *  uploaded its photo), or it is their own quote. */
  function trivialFor(q, member) {
    if (!member) return false;
    if (q.createdBy && q.createdBy === member.id) return true;
    if (q.style === 'who_said' && q.aboutName && firstWord(q.aboutName) === firstWord(member.name)) return true;
    return false;
  }
  /** One player's five: the day's draw, minus their giveaways, topped up
   *  from the spares (and from the giveaways only if the bank is that thin). */
  function roundFor(candidates, member) {
    var ok = candidates.filter(function (q) { return !trivialFor(q, member); });
    var core = candidates.slice(0, LIMITS.daily);
    var mine = ok.slice(0, LIMITS.daily);
    // Keep the shared five where possible so results compare like with like.
    var shared = core.filter(function (q) { return ok.indexOf(q) >= 0; });
    var spares = ok.filter(function (q) { return core.indexOf(q) < 0; });
    mine = shared.concat(spares).slice(0, LIMITS.daily);
    if (mine.length < Math.min(LIMITS.daily, candidates.length)) {
      candidates.forEach(function (q) { if (mine.length < LIMITS.daily && mine.indexOf(q) < 0) mine.push(q); });
    }
    return mine;
  }

  /* ---------------- streaks and the leaderboard ---------------- */

  /**
   * days: the group days a member finished the round (any order). A streak
   * is alive through the whole of the next day - nobody loses one at 9am
   * for not having played yet - and is over after a full day missed.
   */
  function streakOf(days, today) {
    var set = {};
    (days || []).forEach(function (d) { if (isDate(d)) set[d] = true; });
    var list = Object.keys(set).sort();
    var best = 0; var run = 0; var prev = null;
    list.forEach(function (d) { run = prev && dayDiff(prev, d) === 1 ? run + 1 : 1; if (run > best) best = run; prev = d; });
    var current = 0;
    var playedToday = Boolean(set[today]);
    var end = playedToday ? today : (set[addDays(today, -1)] ? addDays(today, -1) : null);
    if (end) { current = 1; while (set[addDays(end, -current)]) current++; }
    return { current: current, best: best, playedToday: playedToday, atRisk: !playedToday && current > 0 };
  }

  /**
   * board: {days: {date: {mid: [score, of]}}, total: {mid: {pts, played}},
   * best: {mid: n}}. Rows per member for the week (the last 7 group days),
   * the month (last 30) and all time, each with their streak.
   */
  function leaderboard(board, members, today) {
    board = board || {};
    var days = board.days || {};
    var rows = (members || []).map(function (m) {
      var mine = [];
      var week = 0; var month = 0; var weekN = 0; var monthN = 0;
      Object.keys(days).forEach(function (d) {
        var e = days[d] && days[d][m.id];
        if (!e) return;
        mine.push(d);
        var age = dayDiff(d, today);
        if (age >= 0 && age < 7) { week += e[0]; weekN++; }
        if (age >= 0 && age < 30) { month += e[0]; monthN++; }
      });
      var st = streakOf(mine, today);
      var tot = (board.total && board.total[m.id]) || { pts: 0, played: 0 };
      return {
        id: m.id, name: m.name, emoji: m.emoji, color: m.color,
        week: week, weekPlayed: weekN, month: month, monthPlayed: monthN, all: tot.pts || 0, allPlayed: tot.played || 0,
        streak: st.current, best: Math.max(st.best, (board.best && board.best[m.id]) || 0), playedToday: st.playedToday, atRisk: st.atRisk,
      };
    });
    function by(key, n) {
      return rows.slice().sort(function (a, b) { return b[key] - a[key] || b[n] - a[n] || (a.name < b.name ? -1 : 1); });
    }
    return { week: by('week', 'weekPlayed'), month: by('month', 'monthPlayed'), all: by('all', 'allPlayed'), rows: rows };
  }

  /** The text to paste into the family chat: no link, nothing about who
   *  the group is beyond its name. */
  function resultCard(o) {
    var marks = (o.marks || []).map(function (m) { return m === true ? '🟩' : m === false ? '🟥' : '🗳️'; }).join('');
    var lines = ['Inside Joke · ' + clean(o.group, LIMITS.groupName), dateLabel(o.date) + ' · ' + o.score + '/' + o.of, marks];
    if (o.streak > 1) lines.push('🔥 ' + o.streak + '-day streak');
    return lines.join('\n');
  }

  /* ---------------- live game points ---------------- */

  var LIVE = { base: 500, speed: 500, closest: 1000, crowd: 500, graceMs: 1500, hostWindowMs: 20000 };

  /** Points for a choice answer the moment it lands: right, plus a speed
   *  bonus that falls from 500 to 0 across the question's window. */
  function livePoints(q, a, elapsedMs, windowMs) {
    if (q.kind !== 'choice') return 0;
    if (a !== q.answer) return 0;
    var w = windowMs > 0 ? windowMs : LIVE.hostWindowMs;
    var frac = Math.max(0, Math.min(1, 1 - Math.max(0, elapsedMs) / w));
    return LIVE.base + Math.round(LIVE.speed * frac);
  }
  /**
   * At the reveal: a number question's closest guess (every guess tied for
   * closest) takes 1000, and a caption's most popular choice gives its
   * voters 500 ("read the room"). answers: {mid: {a, pts}}. Returns
   * {mid: pts} for those questions, and the winning value.
   */
  function settleReveal(q, answers) {
    var out = {};
    var ids = Object.keys(answers || {});
    if (!ids.length) return { pts: out, best: null };
    if (q.kind === 'number') {
      var bestDiff = Infinity;
      ids.forEach(function (id) { var d = Math.abs(answers[id].a - q.answer); if (d < bestDiff) bestDiff = d; });
      ids.forEach(function (id) { out[id] = Math.abs(answers[id].a - q.answer) === bestDiff ? LIVE.closest : 0; });
      return { pts: out, best: bestDiff };
    }
    if (q.kind === 'caption') {
      var votes = {};
      ids.forEach(function (id) { votes[answers[id].a] = (votes[answers[id].a] || 0) + 1; });
      var top = Math.max.apply(null, Object.keys(votes).map(function (k) { return votes[k]; }));
      ids.forEach(function (id) { out[id] = votes[answers[id].a] === top ? LIVE.crowd : 0; });
      return { pts: out, best: Object.keys(votes).filter(function (k) { return votes[k] === top; }).map(Number) };
    }
    ids.forEach(function (id) { out[id] = answers[id].pts || 0; });
    return { pts: out, best: q.answer };
  }

  return {
    LIMITS: LIMITS, COLORS: COLORS, COLOR_IDS: COLOR_IDS, colorHex: colorHex, EMOJI: EMOJI, STYLES: STYLES, STYLE_LABEL: STYLE_LABEL, LIVE: LIVE,
    clean: clean, cleanName: cleanName, firstWord: firstWord,
    validTz: validTz, dayIn: dayIn, msToMidnight: msToMidnight, isDate: isDate, addDays: addDays, dayDiff: dayDiff, dateLabel: dateLabel,
    hash32: hash32, rng: rng, shuffled: shuffled,
    parseChat: parseChat, chatStats: chatStats, statQuestions: statQuestions,
    stripPII: stripPII, buildExcerpt: buildExcerpt, cleanExcerpt: cleanExcerpt, verifyQuote: verifyQuote,
    family: family, cleanQuestion: cleanQuestion, publicQuestion: publicQuestion, validAnswer: validAnswer, grade: grade, FACE_ASK: FACE_ASK,
    pickRound: pickRound, trivialFor: trivialFor, roundFor: roundFor,
    streakOf: streakOf, leaderboard: leaderboard, resultCard: resultCard,
    livePoints: livePoints, settleReveal: settleReveal,
  };
}));
