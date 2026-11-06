/* Chapter - the rules, in one file run three times: `window.ChapterCore` in
 * the page, `require` in the server and in the tests.
 *
 * NO CLOCK AND NO DICE. Nothing here reads the time or makes a random
 * number: "now" (milliseconds), "today" (YYYY-MM-DD in the reader's own day)
 * and every new id are handed in. Days are day numbers from Date.UTC, so a
 * week across a clock change counts days, not hours. No lookbehind regexes
 * (older iPhones cannot parse them), no storage, no network.
 *
 * What lives here:
 *   - text cleaning and escaping (every name, note, title, place and every
 *     model answer goes through these);
 *   - the book: chapters or pages, and the reader's place in it;
 *   - the progress board: who is where, "Maya is 3 chapters ahead of you",
 *     the meeting as the finish line and the "behind schedule" nudge;
 *   - THE SPOILER RULE: a note or question tagged with a chapter is seen
 *     only by members who have read that far (`canSee`) - the server runs
 *     the same function before it sends a single note's text;
 *   - what's next: nominations, approval voting and its tie-break, said in
 *     words; the shelf and its ratings;
 *   - meetups, RSVPs and a floating-time .ics;
 *   - every write as a patch of keys ({set: {'members.m1.pos': 12}, del}),
 *     so the server writes only what changed and two phones never undo each
 *     other;
 *   - the member's view of a club (`memberView`) - the one shape the server
 *     sends and the page draws, for real clubs and the made-up one alike;
 *   - the made-up club for "Try it": Pride and Prejudice (public domain),
 *     six invented readers, notes that quote nothing.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChapterCore = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const LIMITS = {
    members: 30,
    name: 24,
    clubName: 48,
    title: 100,
    author: 60,
    chapters: 400,
    pages: 3000,
    note: 500,
    question: 300,
    noteLines: 6,
    notesPerBook: 400,
    noms: 12,
    nomsPerMember: 2,
    why: 120,
    meetings: 8,
    place: 80,
    link: 300,
    shelf: 40,
    idleDays: 120,
    meetingAheadDays: 730,
    moveMinutes: 30,
    aiQuestions: 6,
    aiQuestionMin: 12,
    aiQuestionMax: 240,
    aiQuoteWords: 12,
  };

  // Emoji a member can pick. A closed set: nothing typed reaches an avatar,
  // and every one of these renders on a phone from 2018 on.
  const EMOJI = ['\u{1F4DA}', '\u{1F989}', '\u{1F98A}', '\u{1F422}', '\u{1F419}', '\u{1F41D}', '\u{1F33B}', '\u{1F375}', '\u{2615}', '\u{1F319}', '\u{2B50}', '\u{1F340}', '\u{1F408}', '\u{1F415}', '\u{1F994}', '\u{1F427}', '\u{1F98B}', '\u{1F335}', '\u{1F344}', '\u{1F3BB}', '\u{1F9F6}', '\u{1F6B2}', '\u{1F337}', '\u{1F34B}'];
  // Reactions on a note, also a closed set.
  const REACTIONS = ['\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F914}', '\u{1F44F}'];
  const RSVP = ['yes', 'maybe', 'no'];
  const KINDS = ['note', 'question'];
  // No I, O, 0 or 1: a code read out across a table is never misheard.
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_LEN = 6;
  const CODE_RE = new RegExp('^[' + CODE_ALPHABET + ']{' + CODE_LEN + '}$');
  const ID36 = 'abcdefghijklmnopqrstuvwxyz0123456789';

  /* ------------------------------------------------------------------ *
   * Errors and words
   * ------------------------------------------------------------------ */

  function fail(status, message, extra) {
    const e = new Error(message);
    e.status = status; e.expose = true;
    if (extra) Object.assign(e, extra);
    return e;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  /** "a", "a and b", "a, b and c". */
  function nameList(names) {
    const l = names.filter(Boolean);
    if (l.length <= 1) return l.join('');
    return l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1];
  }
  const has = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);

  /* ------------------------------------------------------------------ *
   * Text
   * ------------------------------------------------------------------ */

  // Control characters, bidi overrides and isolates, zero-width characters
  // and the BOM. Written as escapes so this file carries none of its own.
  const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

  /** Only strings and numbers are text; anything else ({}, [], true) is none. */
  function str(v) { return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''; }
  function cut(s, max) { const cps = Array.from(s); return cps.length > max ? cps.slice(0, max).join('').trim() : s; }
  /** One line of plain text: no control or invisible characters, single
   *  spaces, at most `max` characters (never splitting one). */
  function line(v, max) {
    const s = str(v).slice(0, max * 8 + 64).replace(/[\r\n\t]+/g, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    return cut(s, max);
  }
  /** A line with markup taken out as well. Angle brackets never survive. */
  function plain(v, max) {
    const s = str(v).slice(0, max * 8 + 64);
    return line(s.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' '), max);
  }
  /** A short paragraph: markup out, at most LIMITS.noteLines line breaks kept,
   *  no blank lines in a row. */
  function para(v, max) {
    let s = str(v).slice(0, max * 8 + 64).replace(/\r\n?/g, '\n');
    s = s.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ');
    const lines = s.split('\n').map((l) => l.replace(INVISIBLE, '').replace(/[\t ]+/g, ' ').replace(/\s+/g, ' ').trim());
    const out = [];
    for (const l of lines) { if (l || (out.length && out[out.length - 1])) out.push(l); }
    while (out.length && !out[out.length - 1]) out.pop();
    const head = out.slice(0, LIMITS.noteLines);
    const rest = out.slice(LIMITS.noteLines).filter(Boolean).join(' ');
    if (rest) head[head.length - 1] = (head[head.length - 1] + ' ' + rest).trim();
    return cut(head.join('\n').trim(), max);
  }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /** A first name (or a short nickname): letters, marks, spaces, hyphens,
   *  apostrophes and dots - never markup, digits strings or separators. */
  function cleanName(v) {
    const s = plain(v, LIMITS.name * 2).replace(/[^\p{L}\p{M}' .\u2019-]/gu, ' ').replace(/\s+/g, ' ').replace(/^[ .'\u2019-]+|[ .'\u2019-]+$/g, '').trim();
    return /\p{L}/u.test(s) ? cut(s, LIMITS.name).replace(/[ .'\u2019-]+$/, '') : '';
  }
  function cleanEmoji(v) { return EMOJI.indexOf(v) >= 0 ? v : EMOJI[0]; }
  function cleanClubName(v) { return plain(v, LIMITS.clubName); }
  /** https only, no credentials, a real host. Anything else is ''. */
  function cleanLink(v) {
    const s = line(v, LIMITS.link);
    if (!s) return '';
    let u;
    try { u = new URL(s); } catch (e) { return ''; }
    if (u.protocol !== 'https:' || u.username || u.password || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return '';
    const out = u.href;
    return out.length <= LIMITS.link && !/[<>"'\s]/.test(out) ? out : '';
  }
  function intIn(v, lo, hi) {
    const n = typeof v === 'string' && /^\s*\d{1,5}\s*$/.test(v) ? Number(v) : v;
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
  }

  /* ------------------------------------------------------------------ *
   * Codes and ids
   * ------------------------------------------------------------------ */

  function normalizeCode(v) { return String(v === null || v === undefined ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
  function isCode(v) { return CODE_RE.test(String(v || '')); }
  function formatCode(c) { const s = normalizeCode(c); return s.length === CODE_LEN ? s.slice(0, 3) + '-' + s.slice(3) : s; }
  /** A new id from the dice it is handed: rand(n) -> 0..n-1. */
  function newId(prefix, rand, len) {
    let s = prefix || '';
    for (let i = 0; i < (len || 8); i++) s += ID36[rand(36)];
    return s;
  }
  const ID_RE = /^[a-z][a-z0-9]{4,23}$/;
  function isId(v) { return ID_RE.test(String(v || '')); }

  /* ------------------------------------------------------------------ *
   * Days (YYYY-MM-DD; day numbers from Date.UTC - no clock is read)
   * ------------------------------------------------------------------ */

  const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  function dayNum(d) {
    const m = DAY_RE.exec(String(d || ''));
    if (!m) return null;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const back = new Date(ms).toISOString().slice(0, 10);
    return back === d ? Math.round(ms / 86400000) : null;
  }
  function isDay(d) { return dayNum(d) !== null; }
  function fromNum(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  function addDays(d, n) { const x = dayNum(d); return x === null ? null : fromNum(x + n); }
  function dayDiff(a, b) { const x = dayNum(a), y = dayNum(b); return x === null || y === null ? null : y - x; }
  const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
  function cleanTime(v) { const s = String(v || '').trim(); return TIME_RE.test(s) ? s : ''; }
  function utcDate(d) { return new Date(dayNum(d) * 86400000); }
  function fmt(locale, opts) {
    try { return new Intl.DateTimeFormat(locale || 'en-US', Object.assign({ timeZone: 'UTC' }, opts)); } catch (e) { return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'UTC' }, opts)); }
  }
  /** "today", "tomorrow", "Thu" (within a week), "Thu, Nov 19" (further),
   *  "Nov 19, 2027" (another year). */
  function dayLabel(d, today, locale) {
    const n = dayDiff(today, d);
    if (n === null) return '';
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n > 1 && n < 7) return fmt(locale, { weekday: 'short' }).format(utcDate(d));
    if (d.slice(0, 4) !== String(today).slice(0, 4)) return fmt(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(utcDate(d));
    return fmt(locale, { weekday: 'short', month: 'short', day: 'numeric' }).format(utcDate(d));
  }
  /** "Thursday, November 12". */
  function longDay(d, locale) { return isDay(d) ? fmt(locale, { weekday: 'long', month: 'long', day: 'numeric' }).format(utcDate(d)) : ''; }
  function shortDay(d, locale) { return isDay(d) ? fmt(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(utcDate(d)) : ''; }
  /** "7:00 PM" (or "19:00" where that is how the reader's clock reads). */
  function timeLabel(t, locale) {
    const s = cleanTime(t);
    if (!s) return '';
    const [h, m] = s.split(':').map(Number);
    return fmt(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(Date.UTC(2026, 0, 1, h, m)));
  }

  /* Time zones: Intl only (it is a calendar, not a clock). */
  function cleanTz(tz) {
    if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return '';
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return ''; }
  }
  const fmtCache = {};
  function zparts(ms, tz) {
    const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const p = {};
    for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
    if (p.hour === '24') p.hour = '00';
    return p;
  }
  function offsetAt(ms, tz) {
    const p = zparts(ms, tz);
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(ms / 1000) * 1000;
  }
  /** The instant a wall-clock date and time happen in `tz` (DST-safe; an
   *  hour skipped in spring lands an hour later). */
  function zonedMs(date, time, tz) {
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = (cleanTime(time) || '00:00').split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    let ms = guess - offsetAt(guess, tz);
    const again = guess - offsetAt(ms, tz);
    if (again !== ms) ms = Math.max(ms, again);
    return ms;
  }
  /** Today in a zone, from an instant handed in. */
  function localDay(ms, tz) { const p = zparts(ms, cleanTz(tz) || 'UTC'); return p.year + '-' + p.month + '-' + p.day; }

  /* ------------------------------------------------------------------ *
   * The book
   * ------------------------------------------------------------------ */

  /** {title, author, chapters, pages} or an error. Chapters are the unit
   *  when they are given: they are the same in every edition, pages are not. */
  function cleanBook(b) {
    const x = b && typeof b === 'object' ? b : {};
    const title = plain(x.title, LIMITS.title);
    const author = plain(x.author, LIMITS.author);
    const chapters = x.chapters === '' || x.chapters === null || x.chapters === undefined ? null : intIn(x.chapters, 1, LIMITS.chapters);
    const pages = x.pages === '' || x.pages === null || x.pages === undefined ? null : intIn(x.pages, 1, LIMITS.pages);
    if (!title) throw fail(400, 'What’s the book called?');
    if (x.chapters !== undefined && x.chapters !== null && x.chapters !== '' && chapters === null) throw fail(400, `Chapters is a number from 1 to ${LIMITS.chapters}.`);
    if (x.pages !== undefined && x.pages !== null && x.pages !== '' && pages === null) throw fail(400, `Pages is a number from 1 to ${LIMITS.pages}.`);
    if (!chapters && !pages) throw fail(400, 'How many chapters does it have? (Or pages, if it has no chapters.)');
    return { title, author, chapters, pages };
  }
  function unitOf(book) { return book && book.chapters ? 'ch' : 'pg'; }
  function totalOf(book) { return book ? (book.chapters || book.pages || 0) : 0; }
  function unitWord(book, n) { return unitOf(book) === 'ch' ? (n === 1 ? 'chapter' : 'chapters') : (n === 1 ? 'page' : 'pages'); }
  function units(book, n) { return n + ' ' + unitWord(book, n); }
  function atLabel(book, n) { return (unitOf(book) === 'ch' ? 'chapter ' : 'page ') + n; }
  function atShort(book, n) { return (unitOf(book) === 'ch' ? 'ch ' : 'p. ') + n; }

  /** Where a member is: 0 (not started) to the book's total. */
  function posOf(m, book) {
    const t = totalOf(book);
    if (!m) return 0;
    if (m.done) return t;
    const p = Number.isInteger(m.pos) ? m.pos : 0;
    return Math.max(0, Math.min(t, p));
  }
  function isDone(m, book) { const t = totalOf(book); return Boolean(m) && t > 0 && (Boolean(m.done) || posOf(m, book) >= t); }
  function pct(m, book) { const t = totalOf(book); return t ? Math.round((posOf(m, book) / t) * 1000) / 10 : 0; }

  /* ------------------------------------------------------------------ *
   * Patches: what a write changes, key by key
   * ------------------------------------------------------------------ */

  function patch() { return { set: {}, del: [] }; }
  function setPath(o, key, v) {
    const parts = key.split('.');
    let at = o;
    for (const p of parts.slice(0, -1)) { if (!at[p] || typeof at[p] !== 'object') at[p] = {}; at = at[p]; }
    at[parts[parts.length - 1]] = v;
  }
  function delPath(o, key) {
    const parts = key.split('.');
    let at = o;
    for (const p of parts.slice(0, -1)) { if (!at[p] || typeof at[p] !== 'object') return; at = at[p]; }
    delete at[parts[parts.length - 1]];
  }
  /** Apply a patch to a copy (the page's made-up club, and the tests). The
   *  server hands the same patch to Firestore's update(). */
  function applyPatch(doc, p) {
    const out = JSON.parse(JSON.stringify(doc));
    for (const k of Object.keys(p.set || {})) setPath(out, k, JSON.parse(JSON.stringify(p.set[k])));
    for (const k of p.del || []) delPath(out, k);
    return out;
  }
  function iso(now) { return new Date(now).toISOString(); }

  /* ------------------------------------------------------------------ *
   * A club, its members and the host
   * ------------------------------------------------------------------ */

  function memberIds(club) { return Object.keys((club && club.members) || {}).sort((a, b) => ((club.members[a].joinedAt || '') < (club.members[b].joinedAt || '') ? -1 : (club.members[a].joinedAt || '') > (club.members[b].joinedAt || '') ? 1 : a < b ? -1 : 1)); }
  function memberCount(club) { return memberIds(club).length; }
  function hostId(club) { return memberIds(club).find((id) => club.members[id].host) || null; }
  function isHost(club, mid) { return Boolean(mid && club.members && club.members[mid] && club.members[mid].host); }
  function nameOf(club, mid) { const m = club.members && club.members[mid]; return m ? m.name : 'Someone'; }

  /**
   * A new club: its name, the host (the creator) and the first book.
   * @param input {name, you: {name, emoji}, book: {title, author, chapters, pages}}
   * @param o     {now, today, hostId, bookId, tz}
   */
  function newClub(input, o) {
    const x = input && typeof input === 'object' ? input : {};
    const name = cleanClubName(x.name);
    if (!name) throw fail(400, 'Give the club a name - “Tuesday Readers” will do.');
    const you = x.you && typeof x.you === 'object' ? x.you : {};
    const first = cleanName(you.name);
    if (!first) throw fail(400, 'Add your first name so the club knows who you are.');
    const book = cleanBook(x.book);
    const at = iso(o.now);
    return {
      name, tz: cleanTz(o.tz), createdAt: at, updatedAt: at, v: 1,
      book: Object.assign({ id: o.bookId, started: o.today, ratings: {} }, book),
      members: { [o.hostId]: { name: first, emoji: cleanEmoji(you.emoji), host: true, joinedAt: at, pos: 0, done: false, at: null } },
      meetings: {},
      vote: { noms: {}, ballots: {}, closed: null },
      shelf: {},
    };
  }

  /** Joining: a first name and an emoji. The same name twice gets a number,
   *  so the board never shows two Sams nobody can tell apart. */
  function join(club, j, now) {
    if (memberCount(club) >= LIMITS.members) throw fail(409, `This club is full - ${LIMITS.members} readers is the most a club can have.`);
    const name = cleanName(j.name);
    if (!name) throw fail(400, 'Add your first name so the club knows who you are.');
    const taken = new Set(memberIds(club).map((id) => club.members[id].name.toLowerCase()));
    let shown = name;
    for (let i = 2; taken.has(shown.toLowerCase()) && i < 99; i++) shown = cut(name, LIMITS.name - 3) + ' ' + i;
    const p = patch();
    p.set['members.' + j.mid] = { name: shown, emoji: cleanEmoji(j.emoji), host: false, joinedAt: iso(now), pos: 0, done: false, at: null, keyHash: j.keyHash || null };
    return { patch: p, name: shown };
  }

  /** A member renames themselves or picks another emoji. */
  function rename(club, mid, input) {
    const m = club.members[mid];
    if (!m) throw fail(404, 'Nothing here.');
    const p = patch();
    if (input && input.name !== undefined) {
      const name = cleanName(input.name);
      if (!name) throw fail(400, 'A name needs at least one letter.');
      if (memberIds(club).some((id) => id !== mid && club.members[id].name.toLowerCase() === name.toLowerCase())) throw fail(409, 'Someone in the club already goes by that name.');
      p.set['members.' + mid + '.name'] = name;
    }
    if (input && input.emoji !== undefined) p.set['members.' + mid + '.emoji'] = cleanEmoji(input.emoji);
    return { patch: p };
  }

  /** Hand hosting to another member. */
  function handOver(club, from, to) {
    if (!isHost(club, from)) throw fail(403, 'Only the host can hand hosting over.');
    if (!club.members[to] || to === from) throw fail(404, 'That reader isn’t in the club.');
    const p = patch();
    p.set['members.' + from + '.host'] = false;
    p.set['members.' + to + '.host'] = true;
    return { patch: p, msg: nameOf(club, to) + ' hosts the club now.' };
  }

  /** Everything of a member's in the club document: their seat, their
   *  ballot and nominations, RSVPs and ratings. (Their notes are documents
   *  of their own; the server removes them too.) A host must hand over
   *  first, unless they are the last one. */
  function removeMember(club, mid) {
    if (!club.members[mid]) throw fail(404, 'That reader isn’t in the club.');
    const p = patch();
    p.del.push('members.' + mid);
    if (has(club.vote && club.vote.ballots, mid)) p.del.push('vote.ballots.' + mid);
    const gone = Object.keys((club.vote && club.vote.noms) || {}).filter((nid) => club.vote.noms[nid].by === mid);
    for (const nid of gone) p.del.push('vote.noms.' + nid);
    if (gone.length) {
      for (const b of Object.keys(club.vote.ballots || {})) {
        const was = club.vote.ballots[b] || [];
        if (b !== mid && was.some((x) => gone.indexOf(x) >= 0)) p.set['vote.ballots.' + b] = was.filter((x) => gone.indexOf(x) < 0);
      }
    }
    for (const id of Object.keys(club.meetings || {})) if (has(club.meetings[id].rsvps, mid)) p.del.push('meetings.' + id + '.rsvps.' + mid);
    if (has(club.book && club.book.ratings, mid)) p.del.push('book.ratings.' + mid);
    for (const bid of Object.keys(club.shelf || {})) {
      if (has(club.shelf[bid].ratings, mid)) p.del.push('shelf.' + bid + '.ratings.' + mid);
      if (has(club.shelf[bid].final, mid)) p.del.push('shelf.' + bid + '.final.' + mid);
    }
    return { patch: p };
  }

  /* ------------------------------------------------------------------ *
   * Progress
   * ------------------------------------------------------------------ */

  /** Where a member is now: {pos} (0..total) or {done: true}. Reaching the
   *  last chapter is finishing. */
  function setProgress(club, mid, input, now) {
    const m = club.members[mid];
    if (!m) throw fail(404, 'Nothing here.');
    const book = club.book, t = totalOf(book);
    const x = input && typeof input === 'object' ? input : {};
    let pos, done;
    if (x.done === true) { pos = t; done = true; } else {
      pos = intIn(x.pos, 0, t);
      if (pos === null) throw fail(400, `Pick a ${unitOf(book) === 'ch' ? 'chapter' : 'page'} from 0 to ${t}.`);
      done = pos >= t;
    }
    const before = posOf(m, book);
    const p = patch();
    p.set['members.' + mid + '.pos'] = pos;
    p.set['members.' + mid + '.done'] = done;
    p.set['members.' + mid + '.at'] = iso(now);
    return { patch: p, before, after: pos, done };
  }

  /** "Maya is 3 chapters ahead of you" - one member against the viewer. */
  function relLine(club, otherId, meId) {
    const book = club.book, o = club.members[otherId], me = club.members[meId];
    if (!o) return '';
    if (otherId === meId) return isDone(o, book) ? 'You’ve finished' : posOf(o, book) ? 'You’re at ' + atLabel(book, posOf(o, book)) : 'You haven’t started yet';
    const on = isDone(o, book);
    if (!me) return on ? o.name + ' has finished' : o.name + ' is at ' + atLabel(book, posOf(o, book));
    if (on) return o.name + (isDone(me, book) ? ' has finished too' : ' has finished');
    const d = posOf(o, book) - posOf(me, book);
    if (d > 0) return o.name + ' is ' + units(book, d) + ' ahead of you';
    if (d < 0) return o.name + ' is ' + units(book, -d) + ' behind you';
    return o.name + ' is on the same ' + (unitOf(book) === 'ch' ? 'chapter' : 'page') + ' as you';
  }

  /** The same, short, beside the name: "3 chapters ahead of you". */
  function relShort(club, otherId, meId) {
    const book = club.book, o = club.members[otherId], me = club.members[meId];
    if (!o) return '';
    if (isDone(o, book)) return 'Finished';
    if (otherId === meId || !me) return posOf(o, book) ? atLabel(book, posOf(o, book)).replace(/^./, (c) => c.toUpperCase()) : 'Not started yet';
    const d = posOf(o, book) - posOf(me, book);
    if (d > 0) return units(book, d) + ' ahead of you';
    if (d < 0) return units(book, -d) + ' behind you';
    return 'Same ' + (unitOf(book) === 'ch' ? 'chapter' : 'page') + ' as you';
  }
  /** The one line at the top of the board: the nearest reader ahead of you
   *  ("Maya is 3 chapters ahead of you"), else the news. */
  function headline(club, meId) {
    const book = club.book, me = club.members[meId];
    if (!me) return '';
    const ids = memberIds(club).filter((id) => id !== meId);
    if (!ids.length) return 'Just you so far - share the code to bring the club in.';
    if (isDone(me, book)) { const left = ids.filter((id) => !isDone(club.members[id], book)).length; return left ? plural(left, 'reader') + ' still reading - no spoilers in the chat.' : 'Everyone has finished.'; }
    const ahead = ids.filter((id) => !isDone(club.members[id], book) && posOf(club.members[id], book) > posOf(me, book))
      .sort((a, b) => posOf(club.members[a], book) - posOf(club.members[b], book) || (club.members[a].name < club.members[b].name ? -1 : 1));
    if (ahead.length) return relLine(club, ahead[0], meId);
    const fin = ids.filter((id) => isDone(club.members[id], book));
    if (fin.length) return relLine(club, fin[0], meId);
    return 'You’re out in front.';
  }

  /** The next meeting from today on (the board's finish line). */
  function meetingList(club) {
    return Object.keys(club.meetings || {}).map((id) => Object.assign({ id }, club.meetings[id]))
      .filter((m) => isDay(m.date))
      .sort((a, b) => (a.date + (a.time || '99:99') < b.date + (b.time || '99:99') ? -1 : a.date + (a.time || '99:99') > b.date + (b.time || '99:99') ? 1 : a.id < b.id ? -1 : 1));
  }
  function nextMeeting(club, today) { return meetingList(club).find((m) => m.date >= today) || null; }
  /** Where a meeting asks everyone to have read to. */
  function targetOf(club, meeting) {
    const t = totalOf(club.book);
    const u = meeting && Number.isInteger(meeting.upTo) ? meeting.upTo : null;
    return u && u >= 1 && u <= t ? u : t;
  }

  /**
   * The nudge against the meeting date, for one member.
   *   kind: done | ready | late | behind | on-track | none
   * "Behind schedule" is measured against a straight line from the day the
   * book started to the meeting's target; the per-day number is what is left
   * over the days before the meeting day.
   */
  function nudge(club, mid, today, locale) {
    const m = club.members[mid];
    if (!m) return null;
    const book = club.book, meet = nextMeeting(club, today);
    const pos = posOf(m, book);
    if (isDone(m, book)) return { kind: 'done', line: 'You’ve finished - every note is open to you.' };
    if (!meet) return { kind: 'none', line: pos ? 'No meeting planned yet - read at your own pace.' : 'No meeting planned yet. Move your bookmark as you go.' };
    const target = targetOf(club, meet);
    const whole = target >= totalOf(book);
    const left = target - pos;
    const days = dayDiff(today, meet.date);
    const by = dayLabel(meet.date, today, locale);
    const byWord = by === 'today' || by === 'tomorrow' ? by : 'by ' + by;
    if (left <= 0) return { kind: 'ready', line: 'You’re ready for the meeting ' + (by === 'today' || by === 'tomorrow' ? by : 'on ' + by) + '.', target, days };
    if (days <= 0) return { kind: 'late', line: 'The meeting is today - ' + units(book, left) + ' to go' + (whole ? '.' : ' to reach ' + atLabel(book, target) + '.'), target, days, left };
    const perDay = Math.ceil(left / days);
    const start = isDay(book.started) && book.started <= today ? book.started : today;
    const span = dayDiff(start, meet.date);
    const expected = span > 0 ? Math.floor((target * dayDiff(start, today)) / span) : 0;
    if (pos < expected) return { kind: 'behind', line: 'Behind schedule - read ' + units(book, perDay) + ' a day to ' + (whole ? 'finish ' : 'reach ' + atLabel(book, target) + ' ') + byWord, perDay, target, days, left, expected };
    return { kind: 'on-track', line: 'On track - ' + units(book, perDay) + ' a day gets you ' + (whole ? 'to the end ' : 'to ' + atLabel(book, target) + ' ') + byWord, perDay, target, days, left, expected };
  }

  /** The board: everyone along the book, furthest first. */
  function board(club, meId, today, locale) {
    const book = club.book, t = totalOf(book);
    const ids = memberIds(club);
    const rows = ids.map((id) => {
      const m = club.members[id];
      return { id, name: m.name, emoji: m.emoji, host: Boolean(m.host), pos: posOf(m, book), done: isDone(m, book), pct: pct(m, book), at: m.at || null, you: id === meId, line: relLine(club, id, meId), short: relShort(club, id, meId) };
    }).sort((a, b) => b.pos - a.pos || (a.you ? -1 : b.you ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const meet = nextMeeting(club, today);
    const target = meet ? targetOf(club, meet) : t;
    const finished = rows.filter((r) => r.done).length;
    const ready = rows.filter((r) => r.pos >= target).length;
    return {
      rows, total: t, unit: unitOf(book), finished, ready, headline: meId ? headline(club, meId) : '',
      allDone: rows.length > 0 && finished === rows.length,
      finish: meet ? { id: meet.id, date: meet.date, time: meet.time || '', at: target, pct: t ? Math.round((target / t) * 1000) / 10 : 100, label: dayLabel(meet.date, today, locale) } : null,
      nudge: meId ? nudge(club, meId, today, locale) : null,
    };
  }

  /* ------------------------------------------------------------------ *
   * Notes and questions - THE SPOILER RULE
   * ------------------------------------------------------------------ */

  /**
   * A note or question, before it is stored. Tagged with the chapter (or
   * page) it belongs to, never beyond where its author is: nobody has a
   * reaction to a chapter they have not read, and the tag is what keeps it
   * from everyone who hasn't read that far.
   */
  function newNote(club, mid, input, o) {
    const m = club.members[mid];
    if (!m) throw fail(404, 'Nothing here.');
    const book = club.book, x = input && typeof input === 'object' ? input : {};
    const kind = KINDS.indexOf(x.kind) >= 0 ? x.kind : 'note';
    const max = kind === 'question' ? LIMITS.question : LIMITS.note;
    const text = para(x.text, max);
    if (!text || !/[\p{L}\p{N}]/u.test(text)) throw fail(400, kind === 'question' ? 'Write the question first.' : 'Write the note first.');
    const mine = posOf(m, book);
    const at = intIn(x.at, 1, totalOf(book));
    if (at === null) throw fail(400, 'Which ' + (unitOf(book) === 'ch' ? 'chapter' : 'page') + ' is it about?');
    if (!mine) throw fail(400, 'Set your bookmark first - a note is tagged with a chapter you have read.');
    if (at > mine && !isDone(m, book)) throw fail(400, 'You can only tag up to where you are (' + atLabel(book, mine) + '). Move your bookmark first.');
    return { club: club.id, book: book.id, mid, kind, text, at, ai: x.ai === true && kind === 'question', reactions: {}, createdAt: iso(o.now) };
  }
  /** Whether `viewer` may read `note` of `book`: they wrote it, they have
   *  finished, or they have read up to its chapter. */
  function canSee(note, viewerId, viewer, book) {
    if (!note || !viewer) return false;
    if (note.mid === viewerId) return true;
    if (isDone(viewer, book)) return true;
    return Number.isInteger(note.at) && note.at <= posOf(viewer, book);
  }
  /** Notes split into what the viewer can read, and counts of what is
   *  locked by chapter - never a locked note's text, author or reactions. */
  function splitNotes(notes, viewerId, viewer, book) {
    const visible = [], locked = {};
    let total = 0;
    for (const n of notes || []) {
      if (canSee(n, viewerId, viewer, book)) visible.push(n);
      else { locked[n.at] = (locked[n.at] || 0) + 1; total++; }
    }
    const chapters = Object.keys(locked).map(Number).sort((a, b) => a - b).map((c) => [c, locked[c]]);
    return { visible, locked: { total, chapters, after: viewer ? posOf(viewer, book) : 0 } };
  }
  /** "4 notes waiting past chapter 12". */
  function lockedLine(locked, book) {
    if (!locked || !locked.total) return '';
    return plural(locked.total, 'note') + ' waiting past ' + (locked.after ? atLabel(book, locked.after) : 'the start');
  }
  function react(note, mid, emoji) {
    const p = patch();
    if (emoji === null || emoji === '' || emoji === undefined) { p.del.push('reactions.' + mid); return { patch: p }; }
    if (REACTIONS.indexOf(emoji) < 0) throw fail(400, 'Pick one of the reactions.');
    p.set['reactions.' + mid] = emoji;
    return { patch: p };
  }
  function reactionCounts(note) {
    const out = {};
    for (const k of Object.keys(note.reactions || {})) { const e = note.reactions[k]; if (REACTIONS.indexOf(e) >= 0) out[e] = (out[e] || 0) + 1; }
    return REACTIONS.filter((e) => out[e]).map((e) => [e, out[e]]);
  }

  /* ------------------------------------------------------------------ *
   * What's next: nominations and approval voting
   * ------------------------------------------------------------------ */

  function nomList(club) {
    const noms = (club.vote && club.vote.noms) || {};
    return Object.keys(noms).map((id) => Object.assign({ id }, noms[id]))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  }
  function nominate(club, mid, input, nid, now) {
    if (!club.members[mid]) throw fail(404, 'Nothing here.');
    if (club.vote && club.vote.closed) throw fail(409, 'The vote is closed. The host can re-open it.');
    const list = nomList(club);
    if (list.length >= LIMITS.noms) throw fail(409, `That’s ${LIMITS.noms} books on the list - enough to choose from.`);
    if (list.filter((n) => n.by === mid).length >= LIMITS.nomsPerMember) throw fail(409, `You’ve nominated ${LIMITS.nomsPerMember} - take one off to add another.`);
    const x = input && typeof input === 'object' ? input : {};
    const title = plain(x.title, LIMITS.title);
    if (!title) throw fail(400, 'Which book?');
    const fold = (s) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
    if (list.some((n) => fold(n.title) === fold(title))) throw fail(409, 'That book is already on the list.');
    const chapters = intIn(x.chapters, 1, LIMITS.chapters), pages = intIn(x.pages, 1, LIMITS.pages);
    const p = patch();
    p.set['vote.noms.' + nid] = { title, author: plain(x.author, LIMITS.author), why: plain(x.why, LIMITS.why), chapters: chapters || null, pages: pages || null, by: mid, at: iso(now) };
    return { patch: p };
  }
  function unnominate(club, mid, nid) {
    const n = club.vote && club.vote.noms && club.vote.noms[nid];
    if (!n) throw fail(404, 'That book isn’t on the list.');
    if (n.by !== mid && !isHost(club, mid)) throw fail(403, 'Only whoever nominated it, or the host, can take it off.');
    if (club.vote.closed) throw fail(409, 'The vote is closed. The host can re-open it.');
    const p = patch();
    p.del.push('vote.noms.' + nid);
    for (const b of Object.keys(club.vote.ballots || {})) if ((club.vote.ballots[b] || []).indexOf(nid) >= 0) p.set['vote.ballots.' + b] = club.vote.ballots[b].filter((x) => x !== nid);
    return { patch: p };
  }
  /** Approval voting: tap every book you'd read. One ballot per member,
   *  written as one key, so two people voting at once both count. */
  function approve(club, mid, picks) {
    if (!club.members[mid]) throw fail(404, 'Nothing here.');
    if (club.vote && club.vote.closed) throw fail(409, 'The vote is closed. The host can re-open it.');
    const noms = (club.vote && club.vote.noms) || {};
    const list = Array.isArray(picks) ? picks : [];
    const clean = [];
    for (const id of list.slice(0, LIMITS.noms * 2)) if (typeof id === 'string' && has(noms, id) && clean.indexOf(id) < 0) clean.push(id);
    const p = patch();
    if (clean.length) p.set['vote.ballots.' + mid] = clean; else p.del.push('vote.ballots.' + mid);
    return { patch: p };
  }
  /**
   * The count, and the winner with its tie-break said in words. Most
   * approvals wins; a tie goes to the book nominated first - shown, never
   * hidden ("Frankenstein wins the tie because it was nominated first").
   */
  function tally(club) {
    const ids = new Set(memberIds(club));
    const list = nomList(club);
    const votes = {};
    for (const n of list) votes[n.id] = 0;
    let voters = 0;
    for (const mid of Object.keys((club.vote && club.vote.ballots) || {})) {
      if (!ids.has(mid)) continue;
      const seen = new Set();
      for (const nid of club.vote.ballots[mid] || []) if (has(votes, nid) && !seen.has(nid)) { seen.add(nid); votes[nid]++; }
      if (seen.size) voters++;
    }
    const rows = list.map((n, i) => ({ id: n.id, title: n.title, author: n.author, votes: votes[n.id], order: i }))
      .sort((a, b) => b.votes - a.votes || a.order - b.order);
    const top = rows[0];
    if (!top || !top.votes) return { rows, voters, winner: null, tied: [], line: list.length ? 'No votes yet.' : 'Nothing nominated yet.' };
    const tied = rows.filter((r) => r.votes === top.votes);
    const line = tied.length > 1
      ? nameList(tied.map((r) => r.title)) + ' tied on ' + plural(top.votes, 'vote') + ' - ' + top.title + ' wins the tie because it was nominated first.'
      : top.title + ' wins with ' + plural(top.votes, 'vote') + ' from ' + plural(voters, 'voter') + '.';
    return { rows, voters, winner: top.id, tied: tied.map((r) => r.id), line };
  }
  function closeVote(club, now) {
    const t = tally(club);
    if (!t.winner) throw fail(409, 'Nobody has voted yet.');
    const counts = {};
    for (const r of t.rows) counts[r.id] = r.votes;
    const p = patch();
    p.set['vote.closed'] = { at: iso(now), winner: t.winner, line: t.line, counts, voters: t.voters, tied: t.tied };
    return { patch: p, msg: t.line };
  }
  function reopenVote() { const p = patch(); p.set['vote.closed'] = null; return { patch: p }; }

  /**
   * The next book: the current one goes to the shelf (its ratings, the day
   * it finished and where everyone got to, so its notes stay spoiler-safe
   * there), the winner - or a book the host types - becomes the current one,
   * everyone's bookmark goes back to the start, and the vote starts again.
   * Meetings already planned stay; their "read to" is cleared.
   */
  function startNext(club, input, o) {
    const x = input && typeof input === 'object' ? input : {};
    let next;
    if (x.book) next = cleanBook(x.book);
    else {
      const closed = club.vote && club.vote.closed;
      const nom = closed && club.vote.noms && club.vote.noms[closed.winner];
      if (!nom) throw fail(409, 'Close the vote first, or type the next book.');
      next = cleanBook({ title: nom.title, author: nom.author, chapters: x.chapters !== undefined ? x.chapters : nom.chapters, pages: x.pages !== undefined ? x.pages : nom.pages });
    }
    const cur = club.book;
    const p = patch();
    const shelf = club.shelf || {};
    const order = Object.keys(shelf).reduce((n, k) => Math.max(n, Number(shelf[k].order) || 0), 0) + 1;
    const final = {};
    for (const id of memberIds(club)) final[id] = posOf(club.members[id], cur);
    p.set['shelf.' + cur.id] = { title: cur.title, author: cur.author || '', chapters: cur.chapters || null, pages: cur.pages || null, started: cur.started || o.today, finished: o.today, ratings: cur.ratings || {}, final, order };
    const drop = Object.keys(shelf).sort((a, b) => (Number(shelf[a].order) || 0) - (Number(shelf[b].order) || 0));
    const dropped = drop.slice(0, Math.max(0, drop.length + 1 - LIMITS.shelf));
    for (const bid of dropped) p.del.push('shelf.' + bid);
    p.set.book = Object.assign({ id: o.bookId, started: o.today, ratings: {} }, next);
    for (const id of memberIds(club)) { p.set['members.' + id + '.pos'] = 0; p.set['members.' + id + '.done'] = false; p.set['members.' + id + '.at'] = null; }
    p.set.vote = { noms: {}, ballots: {}, closed: null };
    for (const id of Object.keys(club.meetings || {})) {
      if (club.meetings[id].date < o.today) p.del.push('meetings.' + id);
      else if (club.meetings[id].upTo) p.set['meetings.' + id + '.upTo'] = null;
    }
    return { patch: p, dropped, msg: 'Now reading ' + next.title + '. Everyone starts at the beginning.' };
  }
  /** The host changes the current book's details. Bookmarks past a shorter
   *  total are read as the end. */
  function editBook(club, input) {
    const b = cleanBook(Object.assign({ title: club.book.title, author: club.book.author, chapters: club.book.chapters, pages: club.book.pages }, input || {}));
    const p = patch();
    p.set['book.title'] = b.title; p.set['book.author'] = b.author; p.set['book.chapters'] = b.chapters; p.set['book.pages'] = b.pages;
    return { patch: p };
  }

  /* ------------------------------------------------------------------ *
   * Ratings and the shelf
   * ------------------------------------------------------------------ */

  function rate(club, mid, bid, stars) {
    if (!club.members[mid]) throw fail(404, 'Nothing here.');
    const p = patch();
    const base = club.book && club.book.id === bid ? 'book' : (club.shelf && has(club.shelf, bid) ? 'shelf.' + bid : null);
    if (!base) throw fail(404, 'That book isn’t on the shelf.');
    if (stars === null) { p.del.push(base + '.ratings.' + mid); return { patch: p }; }
    const n = intIn(stars, 1, 5);
    if (n === null) throw fail(400, 'A rating is 1 to 5 stars.');
    p.set[base + '.ratings.' + mid] = n;
    return { patch: p };
  }
  /** The club's average to one decimal, and how many rated it. */
  function average(ratings) {
    const vals = Object.keys(ratings || {}).map((k) => ratings[k]).filter((n) => Number.isInteger(n) && n >= 1 && n <= 5);
    if (!vals.length) return { avg: null, n: 0 };
    return { avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10, n: vals.length };
  }
  function shelfList(club) {
    const s = club.shelf || {};
    return Object.keys(s).map((id) => Object.assign({ id }, s[id])).sort((a, b) => (Number(b.order) || 0) - (Number(a.order) || 0));
  }

  /* ------------------------------------------------------------------ *
   * Meetups
   * ------------------------------------------------------------------ */

  function cleanMeeting(input, club, today) {
    const x = input && typeof input === 'object' ? input : {};
    const date = String(x.date || '');
    if (!isDay(date)) throw fail(400, 'Pick a day for the meeting.');
    if (date < today) throw fail(400, 'That day has passed - pick today or later.');
    if (dayDiff(today, date) > LIMITS.meetingAheadDays) throw fail(400, 'That’s more than two years away.');
    const time = cleanTime(x.time);
    if (x.time && !time) throw fail(400, 'A time looks like 19:30.');
    const place = plain(x.place, LIMITS.place);
    const link = x.link ? cleanLink(x.link) : '';
    if (x.link && !link) throw fail(400, 'A call link must start with https:// - paste it from the invite.');
    const t = totalOf(club.book);
    const upTo = x.upTo === null || x.upTo === '' || x.upTo === undefined ? null : intIn(x.upTo, 1, t);
    if (x.upTo !== null && x.upTo !== '' && x.upTo !== undefined && upTo === null) throw fail(400, `“Read to” is ${unitOf(club.book) === 'ch' ? 'a chapter' : 'a page'} from 1 to ${t}.`);
    return { date, time, place, link, upTo: upTo && upTo < t ? upTo : null };
  }
  function addMeeting(club, mid, input, id, o) {
    const m = cleanMeeting(input, club, o.today);
    const p = patch();
    p.set['meetings.' + id] = Object.assign(m, { rsvps: {}, by: mid, at: iso(o.now) });
    const all = meetingList(club);
    if (all.length >= LIMITS.meetings) {
      const past = all.filter((x) => x.date < o.today);
      if (!past.length) throw fail(409, `That’s ${LIMITS.meetings} meetings planned - remove one first.`);
      p.del.push('meetings.' + past[0].id);
    }
    return { patch: p };
  }
  function editMeeting(club, id, input, today) {
    const cur = club.meetings && club.meetings[id];
    if (!cur) throw fail(404, 'That meeting isn’t planned any more.');
    const m = cleanMeeting(Object.assign({ date: cur.date, time: cur.time, place: cur.place, link: cur.link, upTo: cur.upTo }, input || {}), club, today);
    const p = patch();
    for (const k of Object.keys(m)) p.set['meetings.' + id + '.' + k] = m[k];
    return { patch: p };
  }
  function rsvp(club, mid, id, a) {
    if (!club.members[mid]) throw fail(404, 'Nothing here.');
    if (!club.meetings || !club.meetings[id]) throw fail(404, 'That meeting isn’t planned any more.');
    const p = patch();
    if (a === null || a === '') p.del.push('meetings.' + id + '.rsvps.' + mid);
    else if (RSVP.indexOf(a) >= 0) p.set['meetings.' + id + '.rsvps.' + mid] = a;
    else throw fail(400, 'Yes, maybe or no.');
    return { patch: p };
  }
  /** A Google Maps search for the place someone typed (no key, no lookup). */
  function mapLink(place) { return place ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(place) : ''; }

  /* .ics: an event in FLOATING local time (DTSTART:20261112T190000, no TZID,
   * no Z) - "7 PM" wherever the phone is, across a clock change, which is
   * what a club that meets in one place means (Takeback's and Tada's
   * reasoning: no VTIMEZONE needed). When the person saving it is in another
   * zone than the club's (a video call across time zones), the event carries
   * the exact instant instead, in UTC, worked out from the club's zone. */
  function icsText(v) {
    return String(v === null || v === undefined ? '' : v).replace(INVISIBLE, '')
      .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
  }
  function utf8Len(ch) { const c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  /** Lines folded at 75 octets of UTF-8, never inside a character. */
  function icsFold(l) {
    const out = [];
    let cur = '', bytes = 0;
    for (const ch of Array.from(l)) {
      const n = utf8Len(ch);
      if (bytes + n > 75) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch; bytes += n;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  function stampOf(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
  /** @param o {nowMs, viewerTz} */
  function meetingIcs(club, meeting, o) {
    const book = club.book, target = targetOf(club, meeting);
    const summary = club.name + ': ' + book.title;
    const desc = [(target < totalOf(book) ? 'Read to ' + atLabel(book, target) + ' of ' : 'Finish ') + book.title + (book.author ? ' by ' + book.author : '') + '.'];
    if (meeting.link) desc.push('Call: ' + meeting.link);
    desc.push('Notes in Chapter stay spoiler-free until you have read that far.');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Chapter//Book club//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
      'UID:chapter-' + String(club.id || 'club').replace(/[^A-Za-z0-9-]/g, '') + '-' + String(meeting.id).replace(/[^A-Za-z0-9-]/g, '') + '@chapter',
      'DTSTAMP:' + stampOf(o.nowMs)];
    const d = meeting.date.replace(/-/g, '');
    const clubTz = cleanTz(club.tz), viewerTz = cleanTz(o.viewerTz);
    if (!meeting.time) {
      lines.push('DTSTART;VALUE=DATE:' + d, 'DTEND;VALUE=DATE:' + addDays(meeting.date, 1).replace(/-/g, ''));
    } else if (clubTz && viewerTz && clubTz !== viewerTz) {
      lines.push('DTSTART:' + stampOf(zonedMs(meeting.date, meeting.time, clubTz)), 'DURATION:PT2H');
    } else {
      lines.push('DTSTART:' + d + 'T' + meeting.time.replace(':', '') + '00', 'DURATION:PT2H');
    }
    lines.push('SUMMARY:' + icsText(summary), 'DESCRIPTION:' + icsText(desc.join('\n')));
    if (meeting.place) lines.push('LOCATION:' + icsText(meeting.place));
    if (meeting.link) lines.push('URL:' + icsText(meeting.link));
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(summary), 'TRIGGER:-PT2H', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ *
   * What a member sees - the one shape the server sends and the page draws
   * ------------------------------------------------------------------ */

  function noteOut(club, n, meId) {
    const a = club.members[n.mid];
    return { id: n.id, mid: n.mid, name: a ? a.name : 'A former member', emoji: a ? a.emoji : EMOJI[0], kind: n.kind === 'question' ? 'question' : 'note', text: n.text, at: n.at, ai: Boolean(n.ai), createdAt: n.createdAt, reactions: reactionCounts(n), mine: (n.reactions && n.reactions[meId]) || null, own: n.mid === meId, canRemove: n.mid === meId || isHost(club, meId) };
  }
  function sortNotes(list) { return list.slice().sort((a, b) => b.at - a.at || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)); }

  /**
   * @param club   the stored club (with `id`)
   * @param notes  every note of the CURRENT book (the server queries them)
   * @param meId   the member asking
   * @param o      {today, locale}
   * Never a key hash, an account tag, a locked note's text - or, while the
   * vote is open, anyone's ballot but the viewer's own.
   */
  function memberView(club, notes, meId, o) {
    const me = club.members[meId];
    const book = club.book;
    const host = isHost(club, meId);
    const split = splitNotes((notes || []).filter((n) => n.book === book.id), meId, me, book);
    const closed = club.vote && club.vote.closed;
    const ballots = (club.vote && club.vote.ballots) || {};
    const ids = memberIds(club);
    const avg = average(book.ratings);
    return {
      id: club.id, name: club.name, code: club.code || '', display: formatCode(club.code || ''), tz: club.tz || '', v: club.v || 0,
      you: meId, host,
      book: { id: book.id, title: book.title, author: book.author || '', chapters: book.chapters || null, pages: book.pages || null, unit: unitOf(book), total: totalOf(book), started: book.started || '', avg: avg.avg, rated: avg.n, myRating: (book.ratings && book.ratings[meId]) || null },
      board: board(club, meId, o.today, o.locale),
      members: ids.map((id) => ({ id, name: club.members[id].name, emoji: club.members[id].emoji, host: Boolean(club.members[id].host), you: id === meId, joinedAt: club.members[id].joinedAt || '' })),
      meetings: meetingList(club).map((m) => {
        const r = m.rsvps || {};
        const who = { yes: [], maybe: [], no: [] };
        for (const id of ids) if (r[id] && who[r[id]]) who[r[id]].push(club.members[id].name);
        return { id: m.id, date: m.date, time: m.time || '', place: m.place || '', link: m.link || '', upTo: m.upTo || null, target: targetOf(club, m), past: m.date < o.today, rsvps: who, mine: r[meId] || null };
      }),
      vote: {
        open: !closed,
        voted: ids.filter((id) => (ballots[id] || []).length).length,
        of: ids.length,
        mine: (ballots[meId] || []).slice(),
        noms: nomList(club).map((n) => ({ id: n.id, title: n.title, author: n.author || '', why: n.why || '', chapters: n.chapters || null, pages: n.pages || null, by: nameOf(club, n.by), mine: n.by === meId, votes: closed && closed.counts && Number.isInteger(closed.counts[n.id]) ? closed.counts[n.id] : null })),
        closed: closed ? { at: closed.at, winner: closed.winner, line: closed.line, voters: closed.voters || 0, tied: closed.tied || [] } : null,
      },
      shelf: shelfList(club).map((s) => {
        const a = average(s.ratings);
        const fin = s.final || {};
        return { id: s.id, title: s.title, author: s.author || '', finished: s.finished || '', started: s.started || '', unit: s.chapters ? 'ch' : 'pg', total: s.chapters || s.pages || 0, avg: a.avg, rated: a.n, myRating: (s.ratings && s.ratings[meId]) || null, readers: Object.keys(fin).filter((k) => fin[k] >= (s.chapters || s.pages || 1)).length, ratings: ids.filter((id) => s.ratings && s.ratings[id]).map((id) => ({ name: club.members[id].name, emoji: club.members[id].emoji, stars: s.ratings[id], you: id === meId })) };
      }),
      notes: sortNotes(split.visible.map((n) => noteOut(club, n, meId))),
      locked: split.locked,
    };
  }
  /** A shelf book's notes for one member: the same rule, against where
   *  they had got to when the club moved on. */
  function shelfNotes(club, bid, notes, meId) {
    const s = club.shelf && club.shelf[bid];
    if (!s) throw fail(404, 'That book isn’t on the shelf.');
    const book = { chapters: s.chapters, pages: s.pages };
    const fin = s.final && Number.isInteger(s.final[meId]) ? s.final[meId] : 0;
    const viewer = { pos: fin, done: fin >= totalOf(book) };
    const split = splitNotes((notes || []).filter((n) => n.book === bid), meId, viewer, book);
    return { book: { id: bid, title: s.title, author: s.author || '', unit: unitOf(book), total: totalOf(book) }, notes: sortNotes(split.visible.map((n) => noteOut(club, n, meId))), locked: split.locked };
  }

  /** The share card's words: "Our club finished Pride and Prejudice -
   *  4.2★ avg". Names never; counts only. */
  function cardData(view, bid) {
    const s = bid === view.book.id ? { title: view.book.title, author: view.book.author, avg: view.book.avg, rated: view.book.rated, readers: view.board.finished, finished: '' } : (view.shelf || []).find((x) => x.id === bid);
    if (!s) return null;
    return { club: view.name, title: s.title, author: s.author || '', avg: s.avg, rated: s.rated || 0, readers: s.readers || 0, members: (view.members || []).length, finished: s.finished || '', line: 'Our club finished ' + s.title + (s.avg ? ' - ' + s.avg.toFixed(1) + '\u2605 avg' : '') };
  }

  /* ------------------------------------------------------------------ *
   * "Suggest discussion questions" - what is asked, and what is accepted
   * ------------------------------------------------------------------ */

  /** The range a member may ask for: from 1 to where they are, so the
   *  questions can never spoil the book for whoever asked. */
  function aiRange(view, from, to) {
    const t = view.book.total;
    const mine = view.board.rows.find((r) => r.you);
    const upto = mine ? (mine.done ? t : mine.pos) : 0;
    const a = intIn(from, 1, t), b = intIn(to, 1, t);
    if (!upto) throw fail(400, 'Move your bookmark first - questions only go up to where you are.');
    if (a === null || b === null || a > b) throw fail(400, `Pick a range from ${atLabel(view.book, 1)} to ${atLabel(view.book, upto)}.`);
    if (b > upto) throw fail(400, `Questions only go up to where you are (${atLabel(view.book, upto)}), so they can’t spoil it for you.`);
    return { from: a, to: b };
  }
  const LINKISH = /(https?:|www\.|\b[a-z0-9-]+\.(com|org|net|io|co|uk|us|edu|gov|info|biz|app|dev|ly|me|ai|xyz|site|online|shop)\b)/i;
  /** The longest run of words inside quotation marks. */
  function longestQuote(s) {
    let best = 0;
    const re = /"([^"]*)"|\u201c([^\u201d]*)\u201d|\u2018([^\u2019]*)\u2019|\u00ab([^\u00bb]*)\u00bb/g;
    let m;
    while ((m = re.exec(s))) {
      const inner = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
      const words = String(inner).trim().split(/\s+/).filter(Boolean).length;
      if (words > best) best = words;
    }
    // An opening mark with no closing one still counts to the end.
    const open = /["\u201c\u00ab]([^"\u201d\u00bb]*)$/.exec(s);
    if (open) best = Math.max(best, open[1].trim().split(/\s+/).filter(Boolean).length);
    return best;
  }
  /**
   * The model's answer, checked: at most six questions, each 12-240
   * characters of plain text, no links, no quoted span over twelve words,
   * a chapter inside the range asked for (a page-based book's questions are
   * all placed at the end of the range). A book the model says it does not
   * know gets general questions, placed at the start of the range.
   */
  function cleanQuestions(raw, range, unit) {
    const x = raw && typeof raw === 'object' ? raw : {};
    const knows = x.knowsBook === true;
    const out = [], seen = new Set();
    for (const q of Array.isArray(x.questions) ? x.questions.slice(0, 30) : []) {
      if (out.length >= LIMITS.aiQuestions) break;
      if (!q || typeof q !== 'object') continue;
      const rawText = String(typeof q.text === 'string' ? q.text : '');
      if (/<[a-z!/]/i.test(rawText)) continue;
      const text = plain(rawText, LIMITS.aiQuestionMax + 40);
      if (Array.from(text).length < LIMITS.aiQuestionMin || Array.from(text).length > LIMITS.aiQuestionMax) continue;
      if (LINKISH.test(text) || /[\u0000-\u001f]/.test(rawText.replace(/\n/g, ''))) continue;
      if (longestQuote(text) > LIMITS.aiQuoteWords) continue;
      let at;
      if (!knows) at = range.from;
      else if (unit === 'pg') at = range.to;
      else {
        at = intIn(q.chapter, 1, 100000);
        if (at === null || at < range.from || at > range.to) continue;
      }
      const k = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ text, at });
    }
    return { knowsBook: knows, questions: out };
  }

  /* ------------------------------------------------------------------ *
   * The made-up club for "Try it"
   *
   * Pride and Prejudice is public domain; nothing below quotes it. Every
   * reader, the club, the café and every note are invented.
   * ------------------------------------------------------------------ */

  function nextWeekday(today, wd) { // 0 = Sunday ... 6 = Saturday
    const n = dayNum(today), cur = new Date(n * 86400000).getUTCDay();
    let add = (wd - cur + 7) % 7;
    if (add < 5) add += 7;
    return fromNum(n + add);
  }
  function demo(today) {
    const meet = nextWeekday(today, 4); // a Thursday, five to eleven days away
    const d = (n) => addDays(today, n) + 'T18:00:00.000Z';
    const at = (n) => addDays(today, -n) + 'T19:30:00.000Z';
    const club = {
      id: 'demo', name: 'The Quillfeather Readers', code: 'PAGE42', tz: '', v: 1, createdAt: at(80), updatedAt: at(0),
      book: { id: 'bpride', title: 'Pride and Prejudice', author: 'Jane Austen', chapters: 61, pages: null, started: addDays(today, -12), ratings: {} },
      members: {
        myou: { name: 'Alex', emoji: '\u{1F33B}', host: true, joinedAt: at(80), pos: 18, done: false, at: at(1) },
        mmaya: { name: 'Maya', emoji: '\u{1F419}', host: false, joinedAt: at(79), pos: 21, done: false, at: at(0) },
        mpriya: { name: 'Priya', emoji: '\u{1F98A}', host: false, joinedAt: at(79), pos: 61, done: true, at: at(2) },
        mtheo: { name: 'Theo', emoji: '\u{1F989}', host: false, joinedAt: at(78), pos: 30, done: false, at: at(1) },
        mjordan: { name: 'Jordan', emoji: '\u{1F422}', host: false, joinedAt: at(70), pos: 15, done: false, at: at(3) },
        msam: { name: 'Sam', emoji: '\u{1F41D}', host: false, joinedAt: at(60), pos: 9, done: false, at: at(4) },
      },
      meetings: {
        mtvol2: { date: meet, time: '19:00', place: 'The back room at Quillfeather Café', link: '', upTo: 42, by: 'myou', at: at(10), rsvps: { mmaya: 'yes', mpriya: 'yes', mtheo: 'maybe', msam: 'yes', mjordan: 'no' } },
      },
      vote: {
        noms: {
          nfrank: { title: 'Frankenstein', author: 'Mary Shelley', why: 'Short, eerie and perfect for November nights.', chapters: 24, pages: null, by: 'mtheo', at: at(6) },
          nmiddle: { title: 'Middlemarch', author: 'George Eliot', why: 'Ambitious - but it would carry us through the whole winter.', chapters: 86, pages: null, by: 'mpriya', at: at(5) },
          nmoon: { title: 'The Moonstone', author: 'Wilkie Collins', why: 'An early detective story, told by a rotating cast of narrators.', chapters: null, pages: null, by: 'msam', at: at(4) },
          nlittle: { title: 'Little Women', author: 'Louisa May Alcott', why: 'Something cosy for the holidays.', chapters: 47, pages: null, by: 'mjordan', at: at(3) },
        },
        ballots: { mtheo: ['nfrank', 'nmoon'], mpriya: ['nmiddle', 'nfrank'], msam: ['nmoon', 'nfrank'], mjordan: ['nlittle', 'nmoon'], mmaya: ['nfrank'] },
        closed: null,
      },
      shelf: {
        bjane: { title: 'Jane Eyre', author: 'Charlotte Bront\u00eb', chapters: 38, pages: null, started: addDays(today, -96), finished: addDays(today, -58), order: 3, ratings: { myou: 4, mmaya: 4, mpriya: 5, mtheo: 4, mjordan: 5, msam: 3 }, final: { myou: 38, mmaya: 38, mpriya: 38, mtheo: 38, mjordan: 38, msam: 31 } },
        bhound: { title: 'The Hound of the Baskervilles', author: 'Arthur Conan Doyle', chapters: 15, pages: null, started: addDays(today, -130), finished: addDays(today, -101), order: 2, ratings: { myou: 4, mmaya: 4, mpriya: 3, mtheo: 5, mjordan: 4 }, final: { myou: 15, mmaya: 15, mpriya: 15, mtheo: 15, mjordan: 15 } },
        bdorian: { title: 'The Picture of Dorian Gray', author: 'Oscar Wilde', chapters: 20, pages: null, started: addDays(today, -170), finished: addDays(today, -136), order: 1, ratings: { myou: 3, mmaya: 4, mpriya: 4, mtheo: 4 }, final: { myou: 20, mmaya: 20, mpriya: 20, mtheo: 20 } },
      },
    };
    const N = (id, mid, kind, ch, text, ago, reactions) => ({ id, club: 'demo', book: 'bpride', mid, kind, text, at: ch, ai: false, reactions: reactions || {}, createdAt: d(-ago) });
    const notes = [
      N('n1open', 'mpriya', 'note', 1, 'That opening line sets the tone for the whole book. I laughed out loud on the bus.', 11, { mmaya: '\u{1F602}', mtheo: '\u{2764}\u{FE0F}' }),
      N('n3ball', 'msam', 'note', 3, 'The first ball! Everyone’s first impressions are so confident. Taking bets on how many of them survive.', 9, { mjordan: '\u{1F602}', myou: '\u{1F914}' }),
      N('n6char', 'mjordan', 'question', 6, 'Is Charlotte the most practical person in the book so far - or the saddest?', 8, { mpriya: '\u{1F914}' }),
      N('n9mrsb', 'mtheo', 'note', 9, 'Mrs Bennet is exhausting - and somehow my favourite so far.', 6, { mmaya: '\u{1F602}', msam: '\u{1F602}', mpriya: '\u{2764}\u{FE0F}' }),
      N('n10imp', 'mpriya', 'question', 10, 'Which first impression in these early chapters feels the most unfair to you?', 6),
      N('n13lett', 'mmaya', 'note', 13, 'The letter from the cousin. I had to read it twice to believe anyone writes like that.', 2, { mtheo: '\u{1F602}' }),
      N('n19prop', 'mmaya', 'note', 19, 'This might be the funniest scene I’ve read all year.', 1, { mpriya: '\u{1F602}' }),
      N('n22char', 'mtheo', 'question', 22, 'Did anyone see Charlotte’s decision coming? I want to argue about it on Thursday.', 1),
      N('n34big', 'mpriya', 'note', 34, 'Chapter 34. That’s all I’ll say. Hold on to something.', 4, { mtheo: '\u{1F62E}' }),
      N('n43trip', 'mpriya', 'note', 43, 'The trip north changes everything. I need a sequel to this chapter alone.', 3),
    ];
    return { club, notes, you: 'myou' };
  }

  return {
    LIMITS, EMOJI, REACTIONS, RSVP, KINDS, CODE_ALPHABET, CODE_LEN,
    fail, plural, nameList, line, plain, para, esc, cleanName, cleanEmoji, cleanClubName, cleanLink, intIn,
    normalizeCode, isCode, formatCode, newId, isId,
    dayNum, isDay, addDays, dayDiff, cleanTime, dayLabel, longDay, shortDay, timeLabel, cleanTz, zonedMs, localDay,
    cleanBook, unitOf, totalOf, unitWord, units, atLabel, atShort, posOf, isDone, pct,
    patch, applyPatch,
    memberIds, memberCount, hostId, isHost, nameOf, newClub, join, rename, handOver, removeMember,
    setProgress, relLine, relShort, headline, meetingList, nextMeeting, targetOf, nudge, board,
    newNote, canSee, splitNotes, lockedLine, react, reactionCounts,
    nomList, nominate, unnominate, approve, tally, closeVote, reopenVote, startNext, editBook,
    rate, average, shelfList,
    cleanMeeting, addMeeting, editMeeting, rsvp, mapLink, icsText, icsFold, meetingIcs,
    memberView, shelfNotes, cardData,
    aiRange, longestQuote, cleanQuestions,
    demo,
  };
}));
