/* Whichbox - the rules, in one file run three times: `window.WhichboxCore`
 * in the page, `require` in the server and in the tests.
 *
 * NO CLOCK AND NO DICE. Nothing here reads the time or makes a random
 * number: "now" (milliseconds) and every new id are handed in. No lookbehind
 * regexes (older iPhones cannot parse them), no storage, no network.
 *
 * What lives here:
 *   - text cleaning and escaping (every typed item, note, room and name and
 *     every model answer goes through these);
 *   - a move or a storage inventory, its rooms (each with a colour that
 *     keeps white text at 4.5:1 or better, in colour and in greyscale), its
 *     boxes, their numbers, flags, statuses and transitions;
 *   - search that forgives: plurals, accents, small typos, a box number;
 *   - moving day: per room, open-first, loaded but not delivered;
 *   - storage: what's where, seasonal tags, taken out;
 *   - CSV out (formulas defused) and back in;
 *   - the QR payloads and the hash routes they open;
 *   - the label and room-sign layout maths, in millimetres, for Letter and
 *     A4, two or six labels to a page;
 *   - sharing: what leaves the phone (text only - never a photo) and the
 *     one view the server sends to a member;
 *   - "List what's in this box": what is sent and what is accepted back;
 *   - the made-up move for "Try it" and a made-up loft.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WhichboxCore = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const LIMITS = {
    moves: 20,             // moves and storage inventories on one phone
    boxes: 500,            // in one move, on a phone and on the server
    boxNo: 9999,
    items: 80,             // things listed in one box
    item: 60,
    note: 300,
    name: 40,              // the move's short name
    place: 60,             // where from / where to
    rooms: 24,
    room: 24,
    location: 40,          // storage: shelf, bay, "loft left"
    tags: 6,
    tag: 24,
    helperName: 24,
    members: 51,           // the owner and 50 helpers
    batch: 50,             // boxes per request while sharing
    idleDays: 90,          // a shared move nobody opens or changes for this long is deleted
    csvBytes: 2 * 1024 * 1024,
    csvRows: 600,
    csvCols: 30,
    // "List what's in this box"
    aiItems: 40,
    aiItem: 40,
    aiNote: 160,
    aiImageBytes: 1000000,
    aiImageSide: 1600,
  };

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

  /* ------------------------------------------------------------------ *
   * Text
   * ------------------------------------------------------------------ */

  // Control characters, bidi overrides and isolates, zero-width characters
  // and the BOM. Written as escapes so this file carries none of its own.
  const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

  function str(v) { return v === null || v === undefined || typeof v === 'object' || typeof v === 'function' ? '' : String(v); }
  function cut(s, max) { const cps = Array.from(s); return cps.length > max ? cps.slice(0, max).join('').trim() : s; }
  /** One line of plain text: no control or invisible characters, single
   *  spaces, at most `max` characters (never splitting one). */
  function line(v, max) {
    const s = str(v).slice(0, max * 8 + 64).replace(/[\r\n\t]+/g, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    return cut(s, max);
  }
  /** A line with markup taken out as well. Angle brackets never survive. */
  function plain(v, max) {
    return line(str(v).slice(0, max * 8 + 64).replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' '), max);
  }
  /** Several lines (a note): each line plain, at most `max` characters in all. */
  function para(v, max) {
    const s = str(v).slice(0, max * 8 + 64).replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ');
    const out = s.split(/\r\n|\r|\n/).map((l) => line(l, max)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return cut(out, max);
  }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const hasWord = (s) => /[\p{L}\p{N}]/u.test(s);
  /** Links of any kind out of something a model wrote. */
  function stripLinks(s) {
    return String(s)
      .replace(/\b(?:https?|ftp|file|data|javascript|vbscript)\s*:\S*/gi, '')
      .replace(/\bwww\.\S+/gi, '')
      .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|uk|us|ca|au|de|app|dev|info|biz|ly|me|tv|xyz|link|site|online|shop|store|example)\b\S*/gi, '');
  }
  /** A model's words: plain, no links, bounded. */
  function plainOut(v, max) {
    if (typeof v !== 'string') return '';
    return line(stripLinks(plain(v, max * 4)).replace(/\s+([,.!?;:])/g, '$1'), max);
  }
  /** A helper's first name: letters, spaces, apostrophes, dots and hyphens. */
  function cleanName(v) {
    const s = plain(v, LIMITS.helperName * 2).replace(/[^\p{L}\p{M}' .’-]/gu, ' ').replace(/\s+/g, ' ').replace(/^[ .'’-]+|[ .'’-]+$/g, '').trim();
    return /\p{L}/u.test(s) ? cut(s, LIMITS.helperName).replace(/[ .'’-]+$/, '') : '';
  }
  function intIn(v, lo, hi) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d{1,6}\s*$/.test(v) ? Number(v) : NaN);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
  }
  function iso(now) { return new Date(now).toISOString(); }
  function isIso(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v)); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  /* ------------------------------------------------------------------ *
   * Ids and codes
   * ------------------------------------------------------------------ */

  const ID36 = 'abcdefghijklmnopqrstuvwxyz0123456789';
  /** A new id from the dice it is handed: rand(n) -> 0..n-1. */
  function newId(rand, len) {
    let s = ID36[rand(26)];
    for (let i = 1; i < (len || 10); i++) s += ID36[rand(36)];
    return s;
  }
  const ID_RE = /^[a-z][a-z0-9]{5,15}$/;
  function isId(v) { return typeof v === 'string' && ID_RE.test(v); }
  /** A new id that none of `taken` (a list of things with ids) has. */
  function freshId(taken, rand, len) {
    const have = new Set((taken || []).map((x) => x && x.id));
    for (let i = 0; i < 50; i++) { const id = newId(rand, len); if (!have.has(id)) return id; }
    throw fail(503, 'Could not make a new id. Try again.');
  }
  /** A shared move's id on the server: 16 base64url characters. */
  const SID_RE = /^[A-Za-z0-9_-]{16}$/;
  function isSid(v) { return typeof v === 'string' && SID_RE.test(v); }

  // Join codes: no I, O, 0 or 1, so nobody reads a code off a screen wrong.
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_LEN = 6;
  const CODE_RE = new RegExp('^[' + CODE_ALPHABET + ']{' + CODE_LEN + '}$');
  function normalizeCode(v) { return str(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
  function isCode(v) { return CODE_RE.test(String(v || '')); }
  function formatCode(c) { const s = normalizeCode(c); return s.length === CODE_LEN ? s.slice(0, 3) + '-' + s.slice(3) : s; }

  /* ------------------------------------------------------------------ *
   * Rooms. Every colour keeps WHITE text at 4.5:1 or better - on the
   * label's band, on a chip, and in greyscale (a black-and-white printer
   * keeps the luminance, so it keeps the contrast). The words are always
   * printed too: a colour is never the only thing that says where a box
   * goes.
   * ------------------------------------------------------------------ */

  const PALETTE = [
    { id: 'orange', name: 'Orange', hex: '#c2410c' },
    { id: 'blue', name: 'Blue', hex: '#1d4ed8' },
    { id: 'violet', name: 'Violet', hex: '#6d28d9' },
    { id: 'pink', name: 'Pink', hex: '#be185d' },
    { id: 'teal', name: 'Teal', hex: '#0f766e' },
    { id: 'slate', name: 'Slate', hex: '#334155' },
    { id: 'green', name: 'Green', hex: '#15803d' },
    { id: 'brown', name: 'Brown', hex: '#854d0e' },
    { id: 'plum', name: 'Plum', hex: '#86198f' },
    { id: 'red', name: 'Red', hex: '#b91c1c' },
    { id: 'cyan', name: 'Cyan', hex: '#0e7490' },
    { id: 'indigo', name: 'Indigo', hex: '#4338ca' },
    { id: 'olive', name: 'Olive', hex: '#3f6212' },
    { id: 'stone', name: 'Stone', hex: '#57534e' },
  ];
  const COLOR_IDS = PALETTE.map((p) => p.id);
  function colorHex(id) { const p = PALETTE.find((x) => x.id === id); return p ? p.hex : PALETTE[0].hex; }

  // What kind of room a room is - so "List what's in this box" can suggest
  // one without the model ever seeing a room's typed name, and so the add
  // form can offer the right starter words.
  const ROOM_KINDS = ['kitchen', 'living', 'dining', 'bedroom', 'bathroom', 'office', 'kids', 'garage', 'storage', 'laundry', 'outdoor', 'other'];
  const KIND_WORDS = {
    kitchen: ['kitchen', 'pantry', 'larder', 'cupboard'],
    living: ['living', 'lounge', 'sitting', 'family room', 'den', 'front room', 'tv'],
    dining: ['dining'],
    bedroom: ['bedroom', 'bed room', 'guest', 'master', 'main bed', 'spare room'],
    bathroom: ['bathroom', 'bath', 'shower', 'toilet', 'wc', 'washroom', 'loo', 'ensuite', 'en suite'],
    office: ['office', 'study', 'desk', 'workroom', 'work room', 'paperwork', 'papers', 'documents', 'files'],
    kids: ['kids', 'kid', 'child', 'children', 'nursery', 'playroom', 'play room', 'baby', 'toy'],
    garage: ['garage', 'workshop', 'shed', 'tools'],
    storage: ['storage', 'loft', 'attic', 'basement', 'cellar', 'unit', 'closet', 'hall', 'holiday', 'holidays', 'christmas', 'decorations', 'seasonal'],
    laundry: ['laundry', 'utility', 'washing'],
    outdoor: ['garden', 'yard', 'patio', 'balcony', 'outdoor', 'outside', 'porch', 'deck'],
  };
  function roomKind(name) {
    const n = ' ' + norm(name) + ' ';
    for (const k of ROOM_KINDS) {
      if (k === 'other') continue;
      if (KIND_WORDS[k].some((w) => n.indexOf(' ' + w + ' ') >= 0 || n.indexOf(' ' + w + 's ') >= 0)) return k;
    }
    return 'other';
  }
  const DEFAULT_ROOMS = {
    move: [['Kitchen', 'orange'], ['Living room', 'blue'], ['Bedroom 1', 'violet'], ['Bedroom 2', 'pink'], ['Bathroom', 'teal'], ['Office', 'slate'], ['Kids’ room', 'green'], ['Garage', 'brown'], ['Storage', 'plum']],
    storage: [['Holidays', 'red'], ['Kitchen', 'orange'], ['Living room', 'blue'], ['Bedrooms', 'violet'], ['Kids', 'green'], ['Garage', 'brown'], ['Paperwork', 'slate'], ['Other', 'stone']],
  };
  /** The starting rooms, with ids from the dice. */
  function defaultRooms(kind, rand) {
    const out = [];
    for (const [name, color] of DEFAULT_ROOMS[kind === 'storage' ? 'storage' : 'move']) out.push({ id: freshId(out, rand, 8), name, color, kind: roomKind(name) });
    return out;
  }
  function cleanRoomName(v) { return plain(v, LIMITS.room); }
  function cleanRoom(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = cleanRoomName(raw.name);
    if (!isId(raw.id) || !hasWord(name)) return null;
    return { id: raw.id, name, color: COLOR_IDS.indexOf(raw.color) >= 0 ? raw.color : 'stone', kind: ROOM_KINDS.indexOf(raw.kind) >= 0 ? raw.kind : roomKind(name) };
  }
  function cleanRooms(list) {
    const out = [], seen = {}, names = {};
    for (const r of (Array.isArray(list) ? list : []).slice(0, LIMITS.rooms * 2)) {
      const c = cleanRoom(r);
      if (!c || seen[c.id] || names[norm(c.name)]) continue;
      seen[c.id] = 1; names[norm(c.name)] = 1;
      out.push(c);
      if (out.length >= LIMITS.rooms) break;
    }
    return out;
  }
  /** The first colour no room has yet, or the least used one. */
  function nextColor(rooms) {
    const n = {};
    for (const r of rooms) n[r.color] = (n[r.color] || 0) + 1;
    let best = COLOR_IDS[0];
    for (const c of COLOR_IDS) if ((n[c] || 0) < (n[best] || 0)) best = c;
    return best;
  }
  function roomOf(move, id) { return (move.rooms || []).find((r) => r.id === id) || null; }
  function roomByName(move, name) { const k = norm(name); return (move.rooms || []).find((r) => norm(r.name) === k) || null; }
  /** A new room: {move (the new move), room}. A name already used is that room. */
  function addRoom(move, input, rand) {
    const name = cleanRoomName(input && input.name);
    if (!hasWord(name)) throw fail(400, 'Give the room a name.');
    const have = roomByName(move, name);
    if (have) return { move, room: have };
    if (move.rooms.length >= LIMITS.rooms) throw fail(409, `A move has up to ${LIMITS.rooms} rooms.`);
    const room = { id: freshId(move.rooms, rand, 8), name, color: COLOR_IDS.indexOf(input.color) >= 0 ? input.color : nextColor(move.rooms), kind: ROOM_KINDS.indexOf(input.kind) >= 0 ? input.kind : roomKind(name) };
    const next = clone(move); next.rooms.push(room);
    return { move: next, room };
  }
  function editRoom(move, id, input) {
    const next = clone(move);
    const r = next.rooms.find((x) => x.id === id);
    if (!r) throw fail(404, 'That room isn’t in this move any more.');
    if (input && input.name !== undefined) {
      const name = cleanRoomName(input.name);
      if (!hasWord(name)) throw fail(400, 'Give the room a name.');
      const other = roomByName(next, name);
      if (other && other.id !== id) throw fail(409, `There is already a room called ${other.name}.`);
      r.name = name; r.kind = input.kind && ROOM_KINDS.indexOf(input.kind) >= 0 ? input.kind : roomKind(name);
    }
    if (input && COLOR_IDS.indexOf(input.color) >= 0) r.color = input.color;
    return next;
  }
  function removeRoom(move, id) {
    if (!roomOf(move, id)) throw fail(404, 'That room isn’t in this move any more.');
    const n = move.boxes.filter((b) => b.room === id).length;
    if (n) throw fail(409, `${plural(n, 'box', 'boxes')} go${n === 1 ? 'es' : ''} to that room. Move ${n === 1 ? 'it' : 'them'} to another room first.`);
    if (move.rooms.length <= 1) throw fail(409, 'A move needs at least one room.');
    const next = clone(move); next.rooms = next.rooms.filter((r) => r.id !== id);
    return next;
  }

  /* ------------------------------------------------------------------ *
   * Flags. Printed as bold WORDS on the label - never only a colour or a
   * symbol. Valuables is never printed: a label that says "valuables" tells
   * everyone on the pavement which box to walk off with.
   * ------------------------------------------------------------------ */

  const FLAGS = [
    { id: 'fragile', label: 'Fragile', print: 'FRAGILE' },
    { id: 'openfirst', label: 'Open first', print: 'OPEN FIRST' },
    { id: 'heavy', label: 'Heavy', print: 'HEAVY' },
    { id: 'upright', label: 'This way up', print: 'THIS WAY UP' },
    { id: 'valuables', label: 'Valuables', print: '' },
  ];
  const FLAG_IDS = FLAGS.map((f) => f.id);
  function cleanFlags(list) {
    const have = new Set(Array.isArray(list) ? list : []);
    return FLAG_IDS.filter((f) => have.has(f));
  }
  function flagLabel(id) { const f = FLAGS.find((x) => x.id === id); return f ? f.label : ''; }
  function printedFlags(flags) { return FLAGS.filter((f) => f.print && flags.indexOf(f.id) >= 0).map((f) => f.print); }

  /* ------------------------------------------------------------------ *
   * Statuses. A move: Packed -> Loaded -> Delivered -> Unpacked. Storage:
   * In storage <-> Taken out. Any status can be set (a mis-tap is undone by
   * tapping the right one); "next" is the one-tap step forward.
   * ------------------------------------------------------------------ */

  const KINDS = ['move', 'storage'];
  const STATUS = { move: ['packed', 'loaded', 'delivered', 'unpacked'], storage: ['stored', 'out'] };
  const STATUS_LABEL = { packed: 'Packed', loaded: 'Loaded', delivered: 'Delivered', unpacked: 'Unpacked', stored: 'In storage', out: 'Taken out' };
  const STATUS_ACT = { loaded: 'Mark loaded', delivered: 'Mark delivered', unpacked: 'Mark unpacked', out: 'Mark taken out', stored: 'Put back in storage' };
  function kindOf(v) { return v === 'storage' ? 'storage' : 'move'; }
  function cleanStatus(kind, s) { const l = STATUS[kindOf(kind)]; return l.indexOf(s) >= 0 ? s : l[0]; }
  function statusLabel(s) { return STATUS_LABEL[s] || ''; }
  function nextStatus(kind, s) {
    const k = kindOf(kind);
    if (k === 'storage') return s === 'out' ? 'stored' : 'out';
    const l = STATUS.move, i = l.indexOf(s);
    return i >= 0 && i < l.length - 1 ? l[i + 1] : null;
  }
  /** In the new place: delivered, or already unpacked. */
  function arrived(s) { return s === 'delivered' || s === 'unpacked'; }

  /* ------------------------------------------------------------------ *
   * Contents, notes, locations and tags
   * ------------------------------------------------------------------ */

  function cleanItem(v) { return plain(str(v).replace(/;/g, ','), LIMITS.item).replace(/^[,.\s-]+|[,\s]+$/g, ''); }
  /** A list of things: each plain, bounded, no empties, no repeats (by the
   *  forgiving key, so "Mugs" and "mug" are one thing). */
  function cleanItems(list) {
    const out = [], seen = {};
    for (const v of (Array.isArray(list) ? list : []).slice(0, LIMITS.items * 3)) {
      const s = cleanItem(v);
      const k = itemKey(s);
      if (!hasWord(s) || seen[k]) continue;
      seen[k] = 1; out.push(s);
      if (out.length >= LIMITS.items) break;
    }
    return out;
  }
  /** Typed or pasted: "kettle, mugs; tea" or one per line becomes three -
   *  each starting with a capital, so a label reads "Kettle, Mugs, Tea". */
  function splitItems(text) {
    return str(text).split(/[,;\n\r\u2022]+/).map(cleanItem).filter(hasWord)
      .map((t) => t.charAt(0).toLocaleUpperCase() + t.slice(1));
  }
  function addItems(items, text) { return cleanItems(items.concat(splitItems(text))); }
  function cleanNote(v) { return para(v, LIMITS.note); }
  function cleanLocation(v) { return plain(v, LIMITS.location); }
  const TAGS = ['Holiday decorations', 'Summer', 'Winter', 'Camping', 'Keepsakes', 'Kids’ clothes', 'Paperwork', 'Sports'];
  function cleanTags(list) {
    const out = [], seen = {};
    for (const v of (Array.isArray(list) ? list : []).slice(0, LIMITS.tags * 3)) {
      const s = plain(v, LIMITS.tag);
      if (!hasWord(s) || seen[norm(s)]) continue;
      seen[norm(s)] = 1; out.push(s);
      if (out.length >= LIMITS.tags) break;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * A box
   *   {id, no, room, items, flags, note, status, statusAt, location, tags,
   *    createdAt, updatedAt, photo (this phone only), by (a shared move's
   *    view only: who changed the status)}
   * ------------------------------------------------------------------ */

  function nextNo(move) {
    let n = intIn(move.nextNo, 1, LIMITS.boxNo + 1) || 1;
    for (const b of move.boxes || []) if (b.no >= n) n = b.no + 1;
    return Math.min(n, LIMITS.boxNo);
  }
  function noTaken(move, no, exceptId) { return (move.boxes || []).some((b) => b.no === no && b.id !== exceptId); }
  function boxOf(move, id) { return (move.boxes || []).find((b) => b.id === id) || null; }
  function boxByNo(move, no) { return (move.boxes || []).find((b) => b.no === no) || null; }

  /** One door for a stored, imported, synced or shared box: bounded,
   *  unknown fields dropped. Null if it is not a box. */
  function cleanBox(raw, move, o) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const no = intIn(raw.no, 1, LIMITS.boxNo);
    if (!isId(raw.id) || !no) return null;
    const kind = kindOf(move && move.kind);
    const rooms = (move && move.rooms) || [];
    const room = rooms.some((r) => r.id === raw.room) ? raw.room : (rooms[0] ? rooms[0].id : '');
    const now = o && Number.isFinite(o.now) ? o.now : 0;
    const status = cleanStatus(kind, raw.status);
    const b = {
      id: raw.id, no, room,
      items: cleanItems(raw.items),
      flags: cleanFlags(raw.flags),
      note: cleanNote(raw.note),
      status,
      statusAt: isIso(raw.statusAt) ? raw.statusAt : '',
      location: kind === 'storage' ? cleanLocation(raw.location) : '',
      tags: kind === 'storage' ? cleanTags(raw.tags) : [],
      createdAt: isIso(raw.createdAt) ? raw.createdAt : iso(now),
      updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : iso(now),
      photo: raw.photo === true,
    };
    const by = cleanName(raw.by);
    if (by) b.by = by;
    return b;
  }
  /** A new box in `move`: {box}. The number is the next free one unless a
   *  free one is asked for; a number in use is a 409 that names the next. */
  function newBox(move, input, o) {
    const i = input || {};
    if (move.boxes.length >= LIMITS.boxes) throw fail(409, `A move holds up to ${LIMITS.boxes} boxes.`);
    let no = i.no === undefined || i.no === null || i.no === '' ? nextNo(move) : intIn(i.no, 1, LIMITS.boxNo);
    if (!no) throw fail(400, `A box number is a whole number from 1 to ${LIMITS.boxNo}.`);
    if (noTaken(move, no)) throw fail(409, `Box ${no} is already used. The next free number is ${nextNo(move)}.`, { code: 'taken' });
    const id = isId(i.id) && !boxOf(move, i.id) ? i.id : freshId(move.boxes, o.rand, 10);
    const kind = kindOf(move.kind);
    const box = cleanBox({
      id, no, room: i.room, items: i.items, flags: i.flags, note: i.note,
      status: i.status, statusAt: i.status ? iso(o.now) : '', location: i.location, tags: i.tags,
      createdAt: iso(o.now), updatedAt: iso(o.now), photo: i.photo === true,
    }, move, o);
    if (!box.room) throw fail(400, 'Add a room first.');
    if (kind === 'move' && !i.status) box.status = 'packed';
    return { box };
  }
  /** The fields a person may edit (never the status - that is setStatus). */
  const EDIT_FIELDS = ['no', 'room', 'items', 'flags', 'note', 'location', 'tags', 'photo'];
  function editBox(move, box, input, o) {
    const i = input || {};
    const next = clone(box);
    if (i.no !== undefined) {
      const no = intIn(i.no, 1, LIMITS.boxNo);
      if (!no) throw fail(400, `A box number is a whole number from 1 to ${LIMITS.boxNo}.`);
      if (noTaken(move, no, box.id)) throw fail(409, `Box ${no} is already used.`, { code: 'taken' });
      next.no = no;
    }
    if (i.room !== undefined) { if (!roomOf(move, i.room)) throw fail(400, 'Pick one of the move’s rooms.'); next.room = i.room; }
    if (i.items !== undefined) next.items = cleanItems(i.items);
    if (i.flags !== undefined) next.flags = cleanFlags(i.flags);
    if (i.note !== undefined) next.note = cleanNote(i.note);
    if (kindOf(move.kind) === 'storage') {
      if (i.location !== undefined) next.location = cleanLocation(i.location);
      if (i.tags !== undefined) next.tags = cleanTags(i.tags);
    }
    if (i.photo !== undefined) next.photo = i.photo === true;
    next.updatedAt = iso(o.now);
    return next;
  }
  function setStatus(move, box, status, o) {
    const kind = kindOf(move.kind);
    if (STATUS[kind].indexOf(status) < 0) throw fail(400, 'That isn’t a status this box can have.');
    const next = clone(box);
    next.status = status; next.statusAt = iso(o.now); next.updatedAt = iso(o.now);
    if (o.by) next.by = o.by; else delete next.by;
    return next;
  }
  /** The fields that differ between two versions of a box, as a patch of
   *  keys - what a shared move writes, so two people changing different
   *  fields of one box both stick. */
  function boxPatch(before, after, fields) {
    const set = {};
    for (const f of fields) if (JSON.stringify(before[f]) !== JSON.stringify(after[f])) set[f] = after[f];
    return set;
  }
  /** "Box 14 · Kitchen · Delivered" */
  function boxLine(move, box) {
    const r = roomOf(move, box.room);
    return ['Box ' + box.no, r ? r.name : '', statusLabel(box.status)].filter(Boolean).join(' · ');
  }
  function itemsLine(items, max) {
    if (!items.length) return 'Nothing listed yet';
    const n = max || 3;
    const shown = items.slice(0, n).join(', ');
    return items.length > n ? shown + ' +' + (items.length - n) : shown;
  }

  /* ------------------------------------------------------------------ *
   * A move (or a storage inventory)
   *   {id, kind, name, from, to, rooms, boxes, nextNo, createdAt, updatedAt,
   *    printedAt, shared?: {id, role, code, v, at, name}, sample?}
   * ------------------------------------------------------------------ */

  /** "12 Larkfield Lane" -> "Larkfield". */
  function shortPlace(v) {
    const words = plain(v, LIMITS.place).replace(/^(flat|apt|apartment|unit)\s+\S+\s*,?\s*/i, '').split(/[\s,]+/).filter((w) => !/^\d+[a-z]?$/i.test(w));
    const SUFFIX = /^(lane|ln|road|rd|street|st|avenue|ave|row|close|drive|dr|way|court|ct|place|pl|crescent|terrace|gardens|square|sq|boulevard|blvd|grove|hill|mews|walk)$/i;
    const keep = words.filter((w) => !SUFFIX.test(w));
    return (keep[0] || words[0] || '').slice(0, 18);
  }
  function defaultName(kind, from, to) {
    if (kindOf(kind) === 'storage') return 'Storage boxes';
    const a = shortPlace(from), b = shortPlace(to);
    if (a && b) return a + ' → ' + b;
    if (b) return 'Moving to ' + b;
    return 'Our move';
  }
  function newMove(input, o) {
    const i = input || {};
    const kind = kindOf(i.kind);
    const from = kind === 'move' ? plain(i.from, LIMITS.place) : '';
    const to = kind === 'move' ? plain(i.to, LIMITS.place) : '';
    const name = plain(i.name, LIMITS.name) || defaultName(kind, from, to);
    const rooms = Array.isArray(i.rooms) && i.rooms.length ? cleanRooms(i.rooms) : defaultRooms(kind, o.rand);
    return { id: newId(o.rand, 12), kind, name, from, to, rooms: rooms.length ? rooms : defaultRooms(kind, o.rand), boxes: [], nextNo: 1, createdAt: iso(o.now), updatedAt: iso(o.now), printedAt: '' };
  }
  /** One door for a move read back from this phone or an imported file. */
  function cleanMove(raw, o) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isId(raw.id)) return null;
    const kind = kindOf(raw.kind);
    const rooms = cleanRooms(raw.rooms);
    if (!rooms.length) return null;
    const m = {
      id: raw.id, kind,
      name: plain(raw.name, LIMITS.name) || defaultName(kind, raw.from, raw.to),
      from: kind === 'move' ? plain(raw.from, LIMITS.place) : '',
      to: kind === 'move' ? plain(raw.to, LIMITS.place) : '',
      rooms, boxes: [],
      nextNo: intIn(raw.nextNo, 1, LIMITS.boxNo + 1) || 1,
      createdAt: isIso(raw.createdAt) ? raw.createdAt : iso(o.now),
      updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : iso(o.now),
      printedAt: isIso(raw.printedAt) ? raw.printedAt : '',
    };
    const seenId = {}, seenNo = {};
    for (const b of (Array.isArray(raw.boxes) ? raw.boxes : []).slice(0, LIMITS.boxes * 2)) {
      const c = cleanBox(b, m, o);
      if (!c || seenId[c.id] || seenNo[c.no]) continue;
      seenId[c.id] = 1; seenNo[c.no] = 1;
      m.boxes.push(c);
      if (m.boxes.length >= LIMITS.boxes) break;
    }
    m.boxes.sort((a, b) => a.no - b.no);
    m.nextNo = nextNo(m);
    const s = raw.shared;
    if (s && typeof s === 'object' && isSid(s.id) && (s.role === 'owner' || s.role === 'helper')) {
      const members = (Array.isArray(s.members) ? s.members : []).slice(0, LIMITS.members)
        .filter((x) => x && isId(x.id) && cleanName(x.name))
        .map((x) => ({ id: x.id, name: cleanName(x.name), role: x.role === 'owner' ? 'owner' : 'helper', you: x.you === true }));
      m.shared = { id: s.id, role: s.role, code: isCode(s.code) ? s.code : '', v: intIn(s.v, 0, 1e9) || 0, at: Number.isFinite(s.at) ? s.at : 0, members };
    }
    return m;
  }
  function putBox(move, box) {
    const next = clone(move);
    const i = next.boxes.findIndex((b) => b.id === box.id);
    if (i >= 0) next.boxes[i] = box; else next.boxes.push(box);
    next.boxes.sort((a, b) => a.no - b.no);
    next.nextNo = Math.max(next.nextNo || 1, box.no + 1);
    return next;
  }
  function dropBox(move, id) {
    const next = clone(move);
    next.boxes = next.boxes.filter((b) => b.id !== id);
    return next;
  }
  function summaryLine(move) {
    const n = move.boxes.length;
    if (!n) return 'No boxes yet';
    if (move.kind === 'storage') {
      const out = move.boxes.filter((b) => b.status === 'out').length;
      return plural(n, 'box', 'boxes') + (out ? ' · ' + out + ' taken out' : ' · all in storage');
    }
    const a = move.boxes.filter((b) => arrived(b.status)).length;
    return plural(n, 'box', 'boxes') + (a ? ' · ' + a + ' in the new place' : '');
  }

  /* ------------------------------------------------------------------ *
   * Search that forgives. "kettle" finds "Kettle"; "mug" finds "Mugs",
   * "knives" finds "Knife", "cafe" finds "Café", "ketle" finds "Kettle",
   * "14" or "#14" or "box 14" opens box 14. Every word of the search must
   * match somewhere in the box (its contents, room, note, location or
   * tags).
   * ------------------------------------------------------------------ */

  function norm(v) {
    return str(v).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[’'`]/g, '').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function tokens(v) { return norm(v).split(' ').filter(Boolean); }
  /** One spelling for a word and its plural: "mugs" and "mug" are "mug",
   *  "knives" and "knife" are "kniv", "shelves" and "shelf" are "shelv",
   *  "gloves" and "glove" are "glov", "batteries" and "battery" are
   *  "battery", "boxes" and "box" are "box". */
  function stem(t) {
    let s = t;
    if (s.length > 4 && /ies$/.test(s)) s = s.slice(0, -3) + 'y';
    else if (s.length > 4 && /(ches|shes|sses|xes|zes)$/.test(s)) s = s.slice(0, -2);
    else if (s.length > 3 && /s$/.test(s) && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
    if (s.length > 3 && /fe$/.test(s)) s = s.slice(0, -2) + 'v';
    else if (s.length > 3 && /f$/.test(s) && !/ff$/.test(s)) s = s.slice(0, -1) + 'v';
    else if (s.length > 3 && /ve$/.test(s)) s = s.slice(0, -1);
    return s;
  }
  /** The forms a word might be written in: itself, its singular, its stem. */
  function forms(t) {
    const out = [t];
    if (t.length > 3 && /s$/.test(t) && !/(ss|us|is)$/.test(t)) out.push(t.slice(0, -1));
    if (t.length > 4 && /(ches|shes|sses|xes|zes)$/.test(t)) out.push(t.slice(0, -2));
    if (t.length > 4 && /ies$/.test(t)) out.push(t.slice(0, -3) + 'y');
    const st = stem(t);
    if (out.indexOf(st) < 0) out.push(st);
    return out;
  }
  function itemKey(s) { return tokens(s).map(stem).join(' '); }
  /** Edit distance with transpositions, stopping early past `max`. */
  function editDistance(a, b, max) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const d = [];
    for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      let rowMin = Infinity;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
        d[i][j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
    }
    return d[a.length][b.length];
  }
  /** How well one search word matches one word of the box: 4 the same
   *  word, 3 a plural or singular of it, 2 the start of it (while typing),
   *  1 a small typo, 0 not at all. */
  function wordScore(q, w, last) {
    if (q === w) return 4;
    const fq = forms(q), fw = forms(w);
    if (fq.some((x) => fw.indexOf(x) >= 0)) return 3;
    if (last && q.length >= 2 && w.indexOf(q) === 0) return 2;
    // A typo only in a word long enough to have one: "ketle", not "too".
    if (q.length >= 5 && w.length >= 4 && !/^\d+$/.test(q)) {
      const max = q.length >= 8 ? 2 : 1;
      if (fw.some((x) => fq.some((y) => editDistance(y, x, max) <= max))) return 1;
    }
    return 0;
  }
  function fieldScore(qs, text) {
    const ws = tokens(text);
    const per = qs.map((q, i) => ws.reduce((m, w) => Math.max(m, wordScore(q, w, i === qs.length - 1)), 0));
    return per;
  }
  const NO_RE = /^\s*(?:box\s*|b\s*|#\s*|no\.?\s*)?(\d{1,4})\s*$/i;
  /**
   * The boxes that match, best first: [{box, score, hits: [{field, text}]}].
   * Each search word must match one of the box's fields; the score adds the
   * best match of each word, weighted by where it was found.
   */
  function search(move, query) {
    const q = str(query).slice(0, 200);
    const out = [];
    const num = NO_RE.exec(q);
    if (num) {
      const b = boxByNo(move, Number(num[1]));
      if (b) out.push({ box: b, score: 1000, hits: [{ field: 'no', text: 'Box ' + b.no }] });
    }
    const qs = tokens(q).filter((t) => !(num && /^(box|b|no)$/.test(t))).slice(0, 8);
    if (!qs.length) return out;
    const W = { item: 3, room: 2, location: 2, tag: 2, note: 1 };
    for (const b of move.boxes) {
      if (out.length && out[0].box === b) continue;
      const r = roomOf(move, b.room);
      const fields = [];
      b.items.forEach((t) => fields.push({ field: 'item', text: t }));
      if (r) fields.push({ field: 'room', text: r.name });
      if (b.location) fields.push({ field: 'location', text: b.location });
      b.tags.forEach((t) => fields.push({ field: 'tag', text: t }));
      if (b.note) fields.push({ field: 'note', text: b.note });
      const best = qs.map(() => 0);
      const hits = [];
      for (const f of fields) {
        const per = fieldScore(qs, f.text);
        let any = false;
        per.forEach((s, i) => { if (s) { any = true; best[i] = Math.max(best[i], s * W[f.field]); } });
        if (any) hits.push(f);
      }
      if (best.every((s) => s > 0)) out.push({ box: b, score: best.reduce((a, s) => a + s, 0), hits: hits.slice(0, 6) });
    }
    return out.sort((a, b) => b.score - a.score || a.box.no - b.box.no);
  }
  /** Boxes with nothing listed: where something unlisted might be. */
  function unlisted(move) { return move.boxes.filter((b) => !b.items.length); }

  /** Words already used in this move, most used first: [{text, n}]. */
  function wordsUsed(move) {
    const m = {};
    for (const b of move.boxes) for (const t of b.items) {
      const k = itemKey(t);
      if (!m[k]) m[k] = { text: t, n: 0 };
      m[k].n++;
    }
    return Object.keys(m).map((k) => m[k]).sort((a, b) => b.n - a.n || a.text.localeCompare(b.text));
  }
  const STARTERS = {
    kitchen: ['Plates', 'Bowls', 'Mugs', 'Glasses', 'Cutlery', 'Pots', 'Pans', 'Kettle', 'Toaster', 'Spices', 'Tea towels', 'Baking trays'],
    living: ['Books', 'Cushions', 'Throw blankets', 'Lamp', 'Picture frames', 'Board games', 'Speaker', 'Cables'],
    dining: ['Tablecloth', 'Candles', 'Serving dishes', 'Placemats', 'Glasses'],
    bedroom: ['Bedding', 'Pillows', 'Towels', 'Clothes', 'Shoes', 'Coats', 'Alarm clock'],
    bathroom: ['Towels', 'Toiletries', 'First aid kit', 'Hairdryer', 'Shower curtain', 'Bath mat'],
    office: ['Laptop', 'Monitor', 'Keyboard', 'Cables', 'Files', 'Printer paper', 'Stationery'],
    kids: ['Toys', 'Building blocks', 'Stuffed animals', 'Books', 'Night light', 'Clothes', 'Art supplies'],
    garage: ['Tools', 'Drill', 'Extension cords', 'Light bulbs', 'Bike pump', 'Paint'],
    storage: ['Holiday decorations', 'String lights', 'Suitcases', 'Keepsakes', 'Photo albums'],
    laundry: ['Detergent', 'Iron', 'Hangers', 'Laundry basket'],
    outdoor: ['Garden tools', 'Plant pots', 'Hose', 'Camping chairs'],
    other: ['Chargers', 'Batteries', 'Light bulbs', 'Cables'],
  };
  const OPEN_FIRST_IDEAS = ['Kettle', 'Mugs', 'Phone chargers', 'Toilet roll', 'Snacks', 'Medicines', 'Bedding', 'Towels', 'Scissors'];
  /** Up to `n` words to offer under the contents box: used ones that start
   *  with what is typed (or contain it), then starters for the room. Never
   *  one already in the box. */
  function suggestItems(move, typed, current, room, n) {
    const max = n || 6;
    const have = new Set((current || []).map(itemKey));
    const q = norm(typed);
    const kind = room && room.kind ? room.kind : 'other';
    const used = wordsUsed(move).map((w) => w.text);
    const pool = used.concat(STARTERS[kind] || [], STARTERS.other);
    const out = [], seen = new Set();
    const take = (t) => { const k = itemKey(t); if (have.has(k) || seen.has(k) || out.length >= max) return; seen.add(k); out.push(t); };
    // Nothing typed: what usually goes in a box for this room, then what
    // this move has used most.
    if (!q) { (STARTERS[kind] || []).concat(used, STARTERS.other).forEach(take); return out; }
    pool.filter((t) => norm(t).indexOf(q) === 0 || tokens(t).some((w) => w.indexOf(q) === 0)).forEach(take);
    pool.filter((t) => norm(t).indexOf(q) > 0).forEach(take);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Moving day
   * ------------------------------------------------------------------ */

  /**
   * {total, arrived, line, rooms: [{room, total, packed, loaded, arrived,
   *  unpacked, line}], openFirst, missing (loaded but not delivered),
   *  notLoaded (still packed), done}
   */
  function dayCounts(move) {
    const boxes = move.boxes;
    const rooms = [];
    for (const r of move.rooms) {
      const bs = boxes.filter((b) => b.room === r.id);
      if (!bs.length) continue;
      const c = { room: r, total: bs.length, packed: 0, loaded: 0, arrived: 0, unpacked: 0, boxes: bs };
      for (const b of bs) { if (b.status === 'packed') c.packed++; if (b.status === 'loaded') c.loaded++; if (arrived(b.status)) c.arrived++; if (b.status === 'unpacked') c.unpacked++; }
      c.line = r.name + ': ' + c.arrived + ' of ' + c.total + ' delivered';
      rooms.push(c);
    }
    const total = boxes.length;
    const inNew = boxes.filter((b) => arrived(b.status)).length;
    const order = { packed: 1, loaded: 0, delivered: 2, unpacked: 3 };
    return {
      total, arrived: inNew,
      line: total ? inNew + ' of ' + plural(total, 'box', 'boxes') + ' in the new place' : 'No boxes yet',
      rooms,
      openFirst: boxes.filter((b) => b.flags.indexOf('openfirst') >= 0).sort((a, b) => order[a.status] - order[b.status] || a.no - b.no),
      missing: boxes.filter((b) => b.status === 'loaded'),
      notLoaded: boxes.filter((b) => b.status === 'packed'),
      done: total > 0 && inNew === total,
    };
  }

  /* ------------------------------------------------------------------ *
   * Storage: what's where
   * ------------------------------------------------------------------ */

  /** {places: [{name, boxes}], none: [boxes with no location], tags:
   *  [{tag, n}], out: [taken out]} - places in the order first written. */
  function whereView(move) {
    const places = [], at = {};
    const none = [];
    for (const b of move.boxes) {
      if (!b.location) { none.push(b); continue; }
      const k = norm(b.location);
      if (!at[k]) { at[k] = { name: b.location, boxes: [] }; places.push(at[k]); }
      at[k].boxes.push(b);
    }
    places.sort((a, b) => a.name.localeCompare(b.name));
    const t = {};
    for (const b of move.boxes) for (const g of b.tags) { const k = norm(g); if (!t[k]) t[k] = { tag: g, n: 0 }; t[k].n++; }
    return { places, none, tags: Object.keys(t).map((k) => t[k]).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)), out: move.boxes.filter((b) => b.status === 'out') };
  }
  function locationsUsed(move) { return whereView(move).places.map((p) => p.name); }

  /* ------------------------------------------------------------------ *
   * CSV: out with formulas defused, back in through cleanBox.
   * ------------------------------------------------------------------ */

  const CSV_HEAD = ['box', 'room', 'room_colour', 'status', 'contents', 'flags', 'note', 'location', 'tags', 'updated'];
  /** RFC 4180, with formulas defused (a leading = + - @ tab or CR). */
  function csvCell(v) {
    let s = String(v === null || v === undefined ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows) { return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
  function boxesCsv(move) {
    const rows = [CSV_HEAD];
    for (const b of move.boxes) {
      const r = roomOf(move, b.room);
      rows.push([b.no, r ? r.name : '', r ? r.color : '', statusLabel(b.status), b.items.join('; '), b.flags.map(flagLabel).join('; '), b.note, b.location, b.tags.join('; '), b.updatedAt]);
    }
    return toCsv(rows);
  }
  /** RFC 4180 rows: quoted delimiters, doubled quotes, line breaks inside
   *  quotes, CRLF / LF / CR, a BOM. Bounded. */
  function parseCsv(text) {
    const s = str(text).slice(0, LIMITS.csvBytes).replace(/^\ufeff/, '');
    const rows = [];
    let row = [], cell = '', q = false, i = 0;
    const push = () => { if (row.length < LIMITS.csvCols) row.push(cell); cell = ''; };
    while (i < s.length && rows.length <= LIMITS.csvRows) {
      const ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
        if (cell.length < 6000) cell += ch;
        i++; continue;
      }
      if (ch === '"' && cell === '') { q = true; i++; continue; }
      if (ch === ',') { push(); i++; continue; }
      if (ch === '\r' || ch === '\n') { push(); rows.push(row); row = []; i += (ch === '\r' && s[i + 1] === '\n') ? 2 : 1; continue; }
      if (cell.length < 6000) cell += ch;
      i++;
    }
    if (cell !== '' || row.length) { push(); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }
  /** Our own defusing, undone: a ' in front of = + - @ tab or CR. */
  const undefuse = (v) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);
  /**
   * A CSV back into boxes for `move`: rooms are matched by name (or added,
   * keeping the colour the file names), a number already in the move is
   * skipped and counted. Returns {move, added, skipped, error}.
   */
  function fromCsv(text, move, o) {
    const rows = parseCsv(text);
    if (!rows.length) return { move, added: 0, skipped: 0, error: 'That file is empty.' };
    const head = rows[0].map((h) => line(h, 40).toLowerCase().replace(/[^a-z_]/g, ''));
    const col = (name) => head.indexOf(name);
    if (col('box') < 0 || col('contents') < 0) return { move, added: 0, skipped: 0, error: 'That file has no box and contents columns. Use a CSV that Whichbox made.' };
    let m = clone(move);
    let added = 0, skipped = 0;
    const kind = kindOf(m.kind);
    const statusOf = (v) => { const k = norm(v); for (const s of STATUS[kind]) if (k === s || k === norm(STATUS_LABEL[s])) return s; return STATUS[kind][0]; };
    const flagOf = (v) => { const k = norm(v); const f = FLAGS.find((x) => k === x.id || k === norm(x.label)); return f ? f.id : null; };
    for (const r of rows.slice(1, LIMITS.boxes + 1)) {
      const get = (name) => { const i = col(name); return i >= 0 && r[i] !== undefined ? undefuse(String(r[i])) : ''; };
      const no = intIn(get('box').replace(/^\s*(box\s*|#)/i, ''), 1, LIMITS.boxNo);
      if (!no || noTaken(m, no) || m.boxes.length >= LIMITS.boxes) { skipped++; continue; }
      let room = roomByName(m, get('room'));
      if (!room && hasWord(cleanRoomName(get('room'))) && m.rooms.length < LIMITS.rooms) {
        const res = addRoom(m, { name: get('room'), color: COLOR_IDS.indexOf(get('room_colour').trim()) >= 0 ? get('room_colour').trim() : undefined }, o.rand);
        m = res.move; room = res.room;
      }
      const ts = isIso(get('updated').trim()) ? get('updated').trim() : iso(o.now);
      const box = cleanBox({
        id: freshId(m.boxes, o.rand, 10), no, room: room ? room.id : '',
        items: get('contents').split(';'), flags: get('flags').split(';').map(flagOf).filter(Boolean),
        note: get('note'), status: statusOf(get('status')), location: get('location'), tags: get('tags').split(';'),
        createdAt: ts, updatedAt: ts,
      }, m, o);
      if (!box) { skipped++; continue; }
      m = putBox(m, box);
      added++;
    }
    skipped += Math.max(0, rows.length - 1 - LIMITS.boxes);
    return { move: m, added, skipped, error: added ? '' : 'No boxes could be read from that file.' };
  }

  /* ------------------------------------------------------------------ *
   * Links. A label's QR code opens that box's page in the app:
   *   device-only move   <base>#box/<box id>
   *   shared move        <base>#s/<shared move id>/<box id>
   * A shared label does NOT carry the join code - a box sits on a pavement
   * and in a van, and anyone can read a label. Someone who has not joined
   * sees the join screen and asks for the code.
   * ------------------------------------------------------------------ */

  function boxHash(move, box) {
    return move.shared && isSid(move.shared.id) ? '#s/' + move.shared.id + '/' + box.id : '#box/' + box.id;
  }
  function boxUrl(origin, base, move, box) { return String(origin) + String(base) + boxHash(move, box); }
  function joinUrl(origin, base, code) { return String(origin) + String(base) + '#join=' + normalizeCode(code); }
  /** What a hash asks for: {view, ...}. Anything unknown is home. */
  function parseHash(h) {
    const s = str(h).replace(/^#/, '');
    let m;
    if ((m = /^box\/([a-z][a-z0-9]{5,15})$/.exec(s))) return { view: 'box', id: m[1] };
    if ((m = /^s\/([A-Za-z0-9_-]{16})\/([a-z][a-z0-9]{5,15})$/.exec(s))) return { view: 'sbox', sid: m[1], id: m[2] };
    if ((m = /^s\/([A-Za-z0-9_-]{16})$/.exec(s))) return { view: 'smove', sid: m[1] };
    if ((m = /^join=([A-Za-z0-9-]{1,14})$/.exec(s))) return { view: 'join', code: normalizeCode(m[1]) };
    if ((m = /^edit\/([a-z][a-z0-9]{5,15})$/.exec(s))) return { view: 'edit', id: m[1] };
    if (['boxes', 'find', 'day', 'where', 'labels', 'more', 'add', 'try', 'tryloft', 'join', 'new', 'newstorage'].indexOf(s) >= 0) return { view: s };
    return { view: '' };
  }

  /* ------------------------------------------------------------------ *
   * Labels and room signs, in millimetres. A sheet is exactly the printable
   * area of the paper (10 mm margins, 2 mm spare), split into two labels
   * (one above the other) or six (two across, three down), with a cutting
   * gap between them. fits() is checked for every paper and count.
   * ------------------------------------------------------------------ */

  const PAPERS = { letter: { id: 'letter', name: 'Letter', w: 215.9, h: 279.4, css: 'letter' }, a4: { id: 'a4', name: 'A4', w: 210, h: 297, css: 'A4' } };
  const PER_PAGE = [2, 6];
  const MARGIN = 10;
  const SPARE = 2;
  /** Letter where Letter is the paper in the shops, A4 everywhere else. */
  function paperFor(locale) {
    const l = str(locale);
    return /^(en-(US|CA|PH)|es-(US|MX|CO|VE|CL|GT|PR|CR|PA|DO|SV|HN|NI|BO|EC|PE)|fr-CA|fil)\b/i.test(l) || /^en$/i.test(l) ? 'letter' : 'a4';
  }
  const floor1 = (v) => Math.floor(v * 10 + 1e-9) / 10;
  function labelGrid(paperIn, perIn) {
    const paper = PAPERS[paperIn] ? paperIn : 'letter';
    const per = PER_PAGE.indexOf(perIn) >= 0 ? perIn : 6;
    const P = PAPERS[paper];
    const cols = per === 6 ? 2 : 1, rows = per === 6 ? 3 : 2;
    const gap = per === 6 ? 6 : 8;
    const innerW = floor1(P.w - 2 * MARGIN), innerH = floor1(P.h - 2 * MARGIN - SPARE);
    const w = floor1((innerW - gap * (cols - 1)) / cols), h = floor1((innerH - gap * (rows - 1)) / rows);
    const six = per === 6;
    return {
      paper, per, page: P, margin: MARGIN, innerW, innerH, cols, rows, gap, w, h,
      pad: six ? 4 : 6,
      row: six ? 1.6 : 2.2,         // the gap between a label's rows, mm
      qr: six ? 27 : 44,            // the QR code's side, mm: 27 mm reads from a metre away
      num: six ? 25 : 44,           // the number's font size, mm
      small: six ? 3 : 4,           // the word "Box" above it
      band: six ? 15 : 22,          // the room band's height, mm
      flag: six ? 4.4 : 7,          // a flag word's font size, mm
      item: six ? 3.4 : 5,          // a contents line's font size, mm
      lines: six ? 2 : 3,           // contents lines
      foot: six ? 3 : 4.2,          // the move's name, mm
    };
  }
  /** The height a label's rows need at most, mm: number and QR, the band,
   *  a row of flags, the contents lines and the footer, with the gaps. */
  function labelHeight(g) {
    const top = Math.max(g.qr, g.num * 0.86 + g.small * 1.2 + 0.4);
    return top + g.band + (g.flag * 1.25 + 1.4) + g.lines * g.item * 1.25 + (g.foot * 1.2 + 1.3) + 4 * g.row;
  }
  function fits(g) {
    return g.cols * g.w + (g.cols - 1) * g.gap <= g.innerW + 1e-9 && g.rows * g.h + (g.rows - 1) * g.gap <= g.innerH + 1e-9
      && g.innerW + 2 * g.margin <= g.page.w + 1e-9 && g.innerH + 2 * g.margin <= g.page.h + 1e-9
      && labelHeight(g) <= g.h - 2 * g.pad + 1e-9
      && g.qr + 3 + g.num * 0.62 * 3 <= g.w - 2 * g.pad;
  }
  /** A font size (mm) for `text` in bold capitals on a w x h band; when even
   *  the smallest size would not fit, `squeeze` asks the SVG to fit it to
   *  the width. ~0.68 em per capital. */
  function bandFit(text, w, h) {
    const n = Math.max(1, Array.from(str(text)).length);
    const tall = h * 0.62;
    const wide = (w * 0.9) / (n * 0.68);
    const size = Math.min(tall, wide);
    const min = h * 0.34;
    return { size: Math.round(Math.max(size, min) * 10) / 10, squeeze: wide < min, width: Math.round(w * 0.9 * 10) / 10 };
  }
  /** How many characters of contents fit on `lines` lines of a label, and
   *  the text: items joined, then "+N more". ~0.5 em per character. */
  function fitItems(items, widthMm, fontMm, lines) {
    if (!items.length) return '';
    const per = Math.max(8, Math.floor(widthMm / (fontMm * 0.52)));
    const cap = per * lines - 8;
    let out = '';
    let n = 0;
    for (const t of items) {
      const next = out ? out + ', ' + t : t;
      if (next.length > cap) break;
      out = next; n++;
    }
    if (!n) { out = cut(items[0], Math.max(4, cap - 1)) + '…'; n = 1; }
    return n < items.length ? out + ' +' + (items.length - n) + ' more' : out;
  }
  /** Everything a label prints, worked out once. */
  function labelFor(move, box, g, opts) {
    const r = roomOf(move, box.room) || { name: 'No room', color: 'stone' };
    const roomText = r.name.toUpperCase();
    const bandW = g.w - 2 * g.pad;
    const digits = String(box.no).length;
    const numRoom = g.w - 2 * g.pad - g.qr - 3;
    const num = Math.min(g.num, numRoom / (digits * 0.62));
    return {
      no: box.no,
      num: Math.round(num * 10) / 10,
      room: r.name, roomText, color: colorHex(r.color),
      band: bandFit(roomText, bandW, g.band),
      bandW: Math.round(bandW * 10) / 10,
      flags: printedFlags(box.flags),
      items: opts && opts.contents === false ? '' : fitItems(box.items, bandW, g.item, g.lines),
      move: move.name,
      url: opts && opts.url ? String(opts.url) : '',
    };
  }
  /** A room sign: the name, its colour, and which boxes go there. */
  function signFor(move, room, paperIn) {
    const P = PAPERS[PAPERS[paperIn] ? paperIn : 'letter'];
    const w = floor1(P.w - 2 * MARGIN), bandH = 90;
    const text = room.name.toUpperCase();
    const nos = move.boxes.filter((b) => b.room === room.id).map((b) => b.no);
    return { name: room.name, text, color: colorHex(room.color), w, bandH, band: bandFit(text, w, bandH), nos, count: nos.length, move: move.name };
  }
  /** "Boxes 1-3, 7, 14" */
  function rangeLine(nos) {
    const s = nos.slice().sort((a, b) => a - b);
    const parts = [];
    for (let i = 0; i < s.length; i++) {
      let j = i;
      while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
      parts.push(j - i >= 2 ? s[i] + '–' + s[j] : (j === i ? String(s[i]) : s[i] + ', ' + s[j]));
      i = j;
    }
    return parts.join(', ');
  }

  /* ------------------------------------------------------------------ *
   * Sharing: TEXT ONLY. What leaves the phone is the move's name, where it
   * is going, its rooms and its boxes - number, room, contents, flags, note,
   * status, location, tags. Never a photo, never a photo flag.
   * ------------------------------------------------------------------ */

  const SHARE_BOX_FIELDS = ['id', 'no', 'room', 'items', 'flags', 'note', 'status', 'location', 'tags'];
  function shareBox(b) { const o = {}; for (const f of SHARE_BOX_FIELDS) o[f] = clone(b[f]); return o; }
  function shareMeta(move) { return { name: move.name, kind: move.kind, from: move.from, to: move.to, rooms: move.rooms.map((r) => ({ id: r.id, name: r.name, color: r.color, kind: r.kind })) }; }
  /** Anything that looks like a picture: a key called photo / image /
   *  thumb, a data: URL, or a long base64 run. The share routes refuse a
   *  request carrying one, whatever else it holds. */
  function carriesPhoto(v, depth) {
    const d = depth || 0;
    if (d > 8) return true;
    // A base64 run: long, with capitals, small letters and digits all in it
    // (any encoded picture has them; a long run of one typed key does not).
    if (typeof v === 'string') return /^\s*data:/i.test(v) || (v.match(/[A-Za-z0-9+/]{400,}/g) || []).some((r) => /[A-Z]/.test(r) && /[a-z]/.test(r) && /[0-9]/.test(r));
    if (Array.isArray(v)) return v.some((x) => carriesPhoto(x, d + 1));
    if (v && typeof v === 'object') return Object.keys(v).some((k) => /photo|image|thumb|picture|blob/i.test(k) || carriesPhoto(v[k], d + 1));
    return false;
  }
  /**
   * The one shape a member is sent - a move in the page's own shape, so the
   * page draws a shared move with the same code as one on the phone. Never a
   * key hash, never anyone's account, never a photo.
   *   doc:   {name, kind, from, to, rooms, members, code, v, createdAt, updatedAt}
   *   boxes: [{bid, no, room, items, flags, note, status, statusAt, statusBy, location, tags, createdAt, updatedAt}]
   */
  function sharedView(doc, boxDocs, mid, o) {
    const kind = kindOf(doc.kind);
    const move = { id: 'shared', kind, rooms: cleanRooms(doc.rooms), boxes: [] };
    const members = doc.members || {};
    const nameOf = (id) => (members[id] ? members[id].name : '');
    const role = members[mid] ? members[mid].role : 'helper';
    const boxes = [];
    const seenNo = {};
    for (const d of boxDocs || []) {
      const b = cleanBox({ id: d.bid, no: d.no, room: d.room, items: d.items, flags: d.flags, note: d.note, status: d.status, statusAt: d.statusAt, location: d.location, tags: d.tags, createdAt: d.createdAt, updatedAt: d.updatedAt, by: d.statusBy ? nameOf(d.statusBy) : '' }, move, o);
      if (!b || seenNo[b.no]) continue;
      seenNo[b.no] = 1;
      delete b.photo;
      boxes.push(b);
    }
    boxes.sort((a, b) => a.no - b.no);
    const list = Object.keys(members).map((id) => ({ id, name: members[id].name, role: members[id].role === 'owner' ? 'owner' : 'helper', you: id === mid, joinedAt: members[id].joinedAt || '' }))
      .sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0) || String(a.joinedAt).localeCompare(String(b.joinedAt)));
    return {
      name: plain(doc.name, LIMITS.name) || defaultName(kind),
      kind, from: kind === 'move' ? plain(doc.from, LIMITS.place) : '', to: kind === 'move' ? plain(doc.to, LIMITS.place) : '',
      rooms: move.rooms, boxes,
      nextNo: intIn(doc.nextNo, 1, LIMITS.boxNo + 1) || 1,
      members: list, me: mid, role,
      code: role === 'owner' ? (doc.code || '') : '',
      v: doc.v || 0,
      createdAt: doc.createdAt || '', updatedAt: doc.updatedAt || '',
    };
  }

  /* ------------------------------------------------------------------ *
   * "List what's in this box" - what is sent, and what is accepted back.
   * ------------------------------------------------------------------ */

  const CONFIDENCE = ['high', 'medium', 'low'];
  const AI_FLAGS = ['fragile', 'heavy'];
  const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
  /** Exactly {image: {type, data}} - one JPEG or PNG and nothing else. */
  function aiRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (Object.keys(body).length !== 1 || !body.image || typeof body.image !== 'object' || Array.isArray(body.image)) return null;
    const im = body.image;
    if (Object.keys(im).sort().join(',') !== 'data,type') return null;
    if (im.type !== 'image/jpeg' && im.type !== 'image/png') return null;
    if (typeof im.data !== 'string' || im.data.length < 16 || im.data.length > Math.ceil(LIMITS.aiImageBytes / 3) * 4 + 4 || !B64.test(im.data)) return null;
    return { image: { type: im.type, data: im.data } };
  }
  /**
   * The model's answer, checked: at most 40 short plain item names (no
   * links, no markup, no long numbers, no repeats), a room KIND from the
   * fixed list or "unsure", flags only from {fragile, heavy}, confidences
   * from the fixed set. Null when nothing usable came back.
   */
  function cleanAiAnswer(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const items = [];
    const seen = {};
    for (const v of (Array.isArray(raw.items) ? raw.items : []).slice(0, LIMITS.aiItems * 3)) {
      const s = plainOut(typeof v === 'string' ? v : (v && typeof v.name === 'string' ? v.name : ''), LIMITS.aiItem).replace(/\d{6,}/g, '').replace(/\s+/g, ' ').replace(/^[,.\s-]+|[,.\s-]+$/g, '').trim();
      const k = itemKey(s);
      if (!hasWord(s) || seen[k]) continue;
      seen[k] = 1; items.push(cleanItem(s));
      if (items.length >= LIMITS.aiItems) break;
    }
    const conf = (v) => (CONFIDENCE.indexOf(v) >= 0 ? v : 'low');
    const room = ROOM_KINDS.indexOf(raw.room) >= 0 ? raw.room : 'unsure';
    const flags = [];
    for (const f of Array.isArray(raw.flags) ? raw.flags.slice(0, 10) : []) {
      const id = f && typeof f === 'object' ? f.flag : f;
      if (AI_FLAGS.indexOf(id) < 0 || flags.some((x) => x.id === id)) continue;
      flags.push({ id, confidence: conf(f && f.confidence) });
    }
    if (!items.length && room === 'unsure') return null;
    return { items, room, roomConfidence: room === 'unsure' ? 'low' : conf(raw.room_confidence), flags, confidence: items.length ? conf(raw.confidence) : 'low', note: plainOut(raw.note, LIMITS.aiNote) };
  }
  /** The move's room for a suggested kind: the first room of that kind. */
  function roomForKind(move, kind) { return kind && kind !== 'unsure' ? move.rooms.find((r) => r.kind === kind) || null : null; }

  /* ------------------------------------------------------------------ *
   * The made-up move ("Try it") and a made-up loft. Every person, street
   * and town is invented.
   * ------------------------------------------------------------------ */

  function sampleMove(o) {
    const now = o.now;
    let seq = 0;
    const id = (p) => (p + 'demo' + (++seq).toString(36) + 'xx').slice(0, 12);
    const rooms = DEFAULT_ROOMS.move.map(([name, color], i) => ({ id: 'rdemo' + i + 'xx', name, color, kind: roomKind(name) }));
    const R = (name) => rooms.find((r) => r.name === name).id;
    const ago = (min) => iso(now - min * 60000);
    const rows = [
      [1, 'Kitchen', ['Plates', 'Bowls', 'Wine glasses', 'Serving dishes'], ['fragile'], 'delivered', 95, 'Noor', ''],
      [2, 'Kitchen', ['Pots', 'Frying pan', 'Baking trays', 'Colander'], ['heavy'], 'delivered', 92, 'Noor', ''],
      [3, 'Kitchen', ['Cookbooks', 'Recipe box', 'Spices', 'Tea towels'], ['heavy'], 'loaded', 150, '', ''],
      [4, 'Living room', ['Books', 'Board games', 'Puzzles'], ['heavy'], 'delivered', 80, 'Ezra', ''],
      [5, 'Living room', ['TV remote', 'HDMI cables', 'Speaker', 'Lamp', 'Router'], ['fragile', 'upright'], 'unpacked', 40, 'Juno', 'The router is in here - wifi first!'],
      [6, 'Living room', ['Throw blankets', 'Cushions'], [], 'unpacked', 55, 'Juno', ''],
      [7, 'Bedroom 1', ['Bedding', 'Pillows', 'Duvet', 'Towels'], ['openfirst'], 'delivered', 70, 'Ezra', 'Make the beds before anyone is too tired.'],
      [8, 'Bedroom 1', ['Winter coats', 'Scarves', 'Boots', 'Gloves'], [], 'loaded', 150, '', ''],
      [9, 'Bedroom 2', [], [], 'packed', 0, '', 'Packed in a hurry - nothing listed.'],
      [10, 'Bathroom', ['Toiletries', 'First aid kit', 'Shower curtain', 'Hairdryer', 'Toilet roll'], ['openfirst'], 'delivered', 64, 'Noor', ''],
      [11, 'Office', ['Monitor', 'Keyboard', 'Desk lamp', 'Cables'], ['fragile'], 'loaded', 148, '', ''],
      [12, 'Office', ['Passports', 'Spare keys', 'Lease papers'], ['valuables'], 'delivered', 120, '', 'In the car with us, not on the truck.'],
      [13, 'Kids’ room', ['Building blocks', 'Stuffed animals', 'Night light', 'Bedtime books'], ['openfirst'], 'loaded', 146, '', 'Bedtime tonight depends on this one.'],
      [14, 'Kitchen', ['Kettle', 'Mugs', 'Tea', 'Coffee', 'Phone chargers', 'Dish soap', 'Snacks', 'Paper plates'], ['openfirst'], 'delivered', 88, 'Ezra', 'The survival box.'],
      [15, 'Garage', ['Drill', 'Toolbox', 'Extension cords', 'Light bulbs'], ['heavy'], 'loaded', 140, '', ''],
      [16, 'Garage', ['Bike pump', 'Camping chairs', 'Tent'], [], 'packed', 0, '', ''],
      [17, 'Storage', ['Holiday decorations', 'String lights', 'Wreath', 'Tree stand'], ['fragile'], 'loaded', 138, '', ''],
      [18, 'Living room', ['Picture frames', 'Mirror', 'Vase'], ['fragile', 'upright'], 'loaded', 136, '', ''],
    ];
    const boxes = rows.map(([no, room, items, flags, status, min, by, note]) => {
      const b = { id: id('b'), no, room: R(room), items, flags, note, status, statusAt: min ? ago(min) : '', location: '', tags: [], createdAt: ago(60 * 24 * 6 - no * 30), updatedAt: ago(Math.max(min, 1)), photo: false };
      if (by) b.by = by;
      return b;
    });
    return {
      id: 'mdemomove01', kind: 'move', name: 'Larkfield → Harbour', from: '12 Larkfield Lane', to: '4 Harbour Row',
      rooms, boxes, nextNo: 19, createdAt: ago(60 * 24 * 7), updatedAt: ago(36), printedAt: ago(60 * 24 * 2), sample: true,
      helpers: ['Noor', 'Ezra', 'Juno'],
    };
  }
  function sampleStorage(o) {
    const now = o.now;
    let seq = 0;
    const id = (p) => (p + 'loft' + (++seq).toString(36) + 'xx').slice(0, 12);
    const rooms = DEFAULT_ROOMS.storage.map(([name, color], i) => ({ id: 'rloft' + i + 'xx', name, color, kind: roomKind(name) }));
    const R = (name) => rooms.find((r) => r.name === name).id;
    const ago = (d) => iso(now - d * 86400000);
    const rows = [
      [1, 'Holidays', ['String lights', 'Tree ornaments', 'Tree topper', 'Extension cord'], ['fragile'], 'Loft left', ['Holiday decorations'], 'stored'],
      [2, 'Holidays', ['Wreath', 'Stockings', 'Advent calendar', 'Table runner'], [], 'Loft left', ['Holiday decorations'], 'stored'],
      [3, 'Holidays', ['Pumpkin lanterns', 'Costumes', 'Window stickers'], [], 'Loft left', ['Holiday decorations'], 'out'],
      [4, 'Garage', ['Tent', 'Sleeping bags', 'Camping stove', 'Lantern'], ['heavy'], 'Garage shelf 2', ['Camping', 'Summer'], 'stored'],
      [5, 'Garage', ['Beach towels', 'Paddling pool', 'Sun hats', 'Picnic blanket'], [], 'Garage shelf 2', ['Summer'], 'stored'],
      [6, 'Bedrooms', ['Winter duvet', 'Flannel sheets', 'Hot water bottles'], [], 'Under the stairs', ['Winter'], 'out'],
      [7, 'Kids', ['Baby clothes', 'First shoes', 'Drawings', 'School reports'], [], 'Loft right', ['Keepsakes', 'Kids’ clothes'], 'stored'],
      [8, 'Paperwork', ['Tax papers', 'Warranties', 'Old bank statements'], ['heavy'], 'Loft right', ['Paperwork'], 'stored'],
    ];
    const boxes = rows.map(([no, room, items, flags, location, tags, status]) => ({ id: id('b'), no, room: R(room), items, flags, note: '', status, statusAt: ago(no), location, tags, createdAt: ago(300 - no), updatedAt: ago(no), photo: false }));
    return { id: 'mdemoloft01', kind: 'storage', name: 'The loft & garage', from: '', to: '', rooms, boxes, nextNo: 9, createdAt: ago(400), updatedAt: ago(1), printedAt: ago(200), sample: true };
  }

  return {
    LIMITS, INVISIBLE, PALETTE, COLOR_IDS, ROOM_KINDS, DEFAULT_ROOMS, FLAGS, FLAG_IDS, KINDS, STATUS, STATUS_LABEL, STATUS_ACT, TAGS, STARTERS, OPEN_FIRST_IDEAS,
    CSV_HEAD, PAPERS, PER_PAGE, MARGIN, CODE_ALPHABET, CODE_LEN, CONFIDENCE, AI_FLAGS, SHARE_BOX_FIELDS, EDIT_FIELDS,
    fail, plural, line, plain, para, esc, stripLinks, plainOut, cleanName, intIn, iso, isIso, clone,
    newId, isId, freshId, isSid, normalizeCode, isCode, formatCode,
    colorHex, roomKind, defaultRooms, cleanRoom, cleanRooms, nextColor, roomOf, roomByName, addRoom, editRoom, removeRoom,
    cleanFlags, flagLabel, printedFlags,
    kindOf, cleanStatus, statusLabel, nextStatus, arrived,
    cleanItem, cleanItems, splitItems, addItems, cleanNote, cleanLocation, cleanTags,
    nextNo, noTaken, boxOf, boxByNo, cleanBox, newBox, editBox, setStatus, boxPatch, boxLine, itemsLine,
    shortPlace, defaultName, newMove, cleanMove, putBox, dropBox, summaryLine,
    norm, tokens, stem, forms, itemKey, editDistance, search, unlisted, wordsUsed, suggestItems,
    dayCounts, whereView, locationsUsed,
    csvCell, toCsv, boxesCsv, parseCsv, fromCsv,
    boxHash, boxUrl, joinUrl, parseHash,
    paperFor, labelGrid, labelHeight, fits, bandFit, fitItems, labelFor, signFor, rangeLine,
    shareBox, shareMeta, carriesPhoto, sharedView,
    aiRequest, cleanAiAnswer, roomForKind,
    sampleMove, sampleStorage,
  };
}));
