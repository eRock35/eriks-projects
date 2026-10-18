// The concierge's front door (2026-10-18): asks from the phone, scoped
// tokens, the agent's claim / read-once / park, Erik's one-tap reply, the
// calendar add the phone writes, and what is forgotten when.
//
// Booted on the in-memory store (no FIRESTORE_DATABASE_ID), like
// test/inbox.js, so the caps are counted through the routes. Time is moved
// by rewriting stored timestamps, never by waiting.
const h = require('./harness.js');
h.install();
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 8319;
process.env.IDENTITY_SESSION_SECRET = 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'landing-secret-abcdefghijklm';
process.env.ADMIN_PASSWORD = 'admin-password-here-1';
process.env.ADMIN_EMAIL = 'owner@example.com';
delete process.env.FIRESTORE_DATABASE_ID;
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.PORT = String(PORT);

const printed = [];
for (const k of ['log', 'warn', 'error', 'info']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { printed.push(a.map(String).join(' ')); orig(...a); };
}
const say = (...a) => process.stdout.write(a.join(' ') + '\n');

const inbox = require('../lib/inbox');
const view = require('../site/assets/inbox.js');
const cli = require('../scripts/inbox.js');
require(path.join(__dirname, '..', 'server.js'));
const db = require('../lib/store').store();

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const base = 'http://127.0.0.1:' + PORT;
const PAGE = { 'X-Inbox-Page': '1' };

async function req(method, url, { body, headers = {}, raw } = {}) {
  const opts = { method, headers: { ...headers }, redirect: 'manual' };
  if (raw !== undefined) opts.body = raw;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const r = await fetch(base + url, opts);
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  return { status: r.status, headers: r.headers, text, data, buf };
}
const auth = (t) => ({ authorization: 'Bearer ' + t });

/* Tiny real images: a JPEG with a SOF0 frame header and a PNG with IHDR. */
function jpeg(w, h, pad = 0) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([head, sof, Buffer.alloc(pad, 0x55), Buffer.from([0xff, 0xd9])]);
}
function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
const b64 = (buf) => buf.toString('base64');
const hoursAgo = (n) => new Date(Date.now() - n * 3600e3).toISOString();
const inDays = (n) => new Date(Date.now() + n * 86400e3);

/** An ISO time n days ahead at 19:45 in New York, with that day's offset. */
function nyEvening(days) {
  const d = inDays(days);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const guess = Date.parse(`${ymd}T19:45:00Z`);
  const off = inbox.zoneOffsetAt('America/New_York', guess + 5 * 3600e3);
  return `${ymd}T19:45:00${off}`;
}

(async () => {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  let r = await req('POST', '/api/admin/login', { body: { password: process.env.ADMIN_PASSWORD } });
  const ADMIN = { cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  const PG = { ...ADMIN, ...PAGE };

  /* ---------- pure rules ---------- */
  say('\nwhat may be written');
  ok('a one-time code is spotted', inbox.looksSecret('Your verification code is 482913') && inbox.looksSecret('482913 is your Uber code') && inbox.looksSecret('PIN: 4417'));
  ok('...a card number (Luhn) is spotted', inbox.looksSecret('card 4111 1111 1111 1111 exp 09/29') && inbox.looksSecret('4242-4242-4242-4242'));
  ok('...a password is spotted', inbox.looksSecret('the password is hunter22'));
  ok('...but a year, a time and a party size are not', !inbox.looksSecret('Table for 2 at Lilia, Sat Oct 24 2026 around 7:45, dress code casual')
    && !inbox.looksSecret('Flight 1234 lands at 10:40'), 'false positive');
  ok('...and sixteen random digits that fail Luhn are not a card', !inbox.looksSecret('order 1234 5678 9012 3456'));
  ok('a booking code next to a name is a pair', inbox.codeWithName('Delta GH7K2L for John Smith') && inbox.codeWithName('Confirmation GH7K2L, passenger SMITH/JOHN'));
  ok('...a code alone, or a name alone, is not', !inbox.codeWithName('Delta GH7K2L Fri Nov 6') && !inbox.codeWithName('Lilia Sat Oct 24 7:45 for 2'));
  ok('hosts: exact or a dot-suffix, nothing else', inbox.hostAllowed('resy.com') && inbox.hostAllowed('widgets.resy.com') && inbox.hostAllowed('trip.strongtechnicalconsulting.com')
    && !inbox.hostAllowed('evilresy.com') && !inbox.hostAllowed('resy.com.evil.net') && !inbox.hostAllowed('example.com'));
  ok('a shared link is reduced to origin + path + query, https only', inbox.cleanUrl('https://u:p@x.example/a?b=1#frag') === null
    && inbox.cleanUrl('https://x.example/a?b=1#frag') === 'https://x.example/a?b=1' && inbox.cleanUrl('http://x.example/') === null && inbox.cleanUrl('javascript:alert(1)') === null);
  ok('JPEG and PNG are told by their bytes, with their size', JSON.stringify(inbox.sniffImage(jpeg(1280, 2770))) === JSON.stringify({ mediaType: 'image/jpeg', height: 2770, width: 1280 })
    && inbox.sniffImage(png(390, 844)).width === 390 && inbox.sniffImage(Buffer.from('GIF89a' + 'x'.repeat(40))) === null);
  ok('"Errand:" and "Ask:" file an ask; an idea stays an idea', inbox.askNoteFrom({ text: 'Errand: table for two Saturday' }) === 'table for two Saturday'
    && inbox.askNoteFrom({ text: 'x', kind: 'ask' }) === 'x' && inbox.askNoteFrom({ text: 'Bug: it crashes' }) === null);

  /* ---------- tokens ---------- */
  say('\nscoped tokens');
  const mint = async (scope, label) => (await req('POST', '/api/inbox/tokens', { body: { scope, label }, headers: PG })).data;
  r = await req('POST', '/api/inbox/tokens', { body: { scope: 'phone', label: 'x' }, headers: ADMIN });
  ok('minting needs the page header (CSRF)', r.status === 403);
  r = await req('POST', '/api/inbox/tokens', { body: { scope: 'root', label: 'x' }, headers: PG });
  ok('a scope is phone or agent', r.status === 400);
  const phone = await mint('phone', 'iPhone');
  const phone2 = await mint('phone', 'Caps phone');
  const agent = await mint('agent', 'Concierge');
  // 30 requests a minute per token: later sections use their own.
  const phoneB = await mint('phone', 'Phone B');
  const phoneC = await mint('phone', 'Phone C');
  ok('the page mints labelled phone and agent tokens, shown once', /^ibx_/.test(phone.token) && /^ibx_/.test(agent.token) && phone.scope === 'phone' && agent.scope === 'agent' && phone.label === 'iPhone');
  r = await req('GET', '/api/inbox/tokens', { headers: ADMIN });
  const listed = r.data.tokens || [];
  ok('the list shows labels, scopes, dates and a short prefix only', r.status === 200 && listed.length === 5
    && listed.every((t) => t.prefix.length === 6 && t.ref && t.scope) && ![phone.token, agent.token].some((t) => r.text.includes(t)) && !/[0-9a-f]{64}/.test(r.text), r.text.slice(0, 300));
  const stored = await db.list(inbox.TOKENS);
  ok('...and only hashes are stored', stored.length === 5 && !JSON.stringify(stored).includes(phone.token));
  r = await req('POST', '/api/inbox/tokens', { body: { scope: 'agent', label: 'mine' }, headers: auth(agent.token) });
  ok('the agent cannot mint a token (the admin surface 404s)', r.status === 404);
  r = await req('GET', '/api/inbox/tokens', { headers: auth(phone.token) });
  ok('...nor can the phone list them', r.status === 404);
  const spare = await mint('agent', 'Spare');
  const agentB = await mint('agent', 'Agent B');
  const agentC = await mint('agent', 'Agent C');
  r = await req('DELETE', '/api/inbox/tokens/' + spare.ref, { headers: PG });
  const after = await req('GET', '/api/inbox', { headers: auth(spare.token) });
  ok('a revoked token stops at once', r.status === 200 && after.status === 401);

  /* ---------- the legacy token ---------- */
  say('\nthe original token');
  r = await req('POST', '/api/inbox/token', { headers: PG });
  const legacy = r.data.token;
  r = await req('POST', '/api/inbox/capture', { body: { source: 'share', text: 'from the old token' }, headers: auth(legacy) });
  ok('the original single token still works, as a phone token', r.status === 200 && r.data.ok === true, r.text);
  r = await req('GET', '/api/inbox?kind=ask', { headers: auth(legacy) });
  ok('...and cannot list', r.status === 403);
  r = await req('GET', '/api/inbox/tokens', { headers: ADMIN });
  ok('...it is listed as "Siri (original)", scope phone', r.data.tokens.some((t) => t.legacy && t.scope === 'phone' && t.ref === 'legacy'));
  r = await req('GET', '/api/inbox/answers', { headers: auth(legacy) });
  ok('...and reads answers', r.status === 200);

  /* ---------- the phone's door ---------- */
  say('\nthe phone may send and reply, nothing more');
  await req('POST', '/api/inbox', { body: { text: 'an app that plans school pickups' }, headers: PG });
  r = await req('POST', '/api/inbox', { body: { text: 'Bug: an idea from the phone' }, headers: auth(phone.token) });
  ok('the phone still files ideas', r.status === 200 && r.data.item.kind === 'bug');
  const ideaId = r.data.id;
  r = await req('POST', '/api/inbox', { body: { text: 'Errand: table for two at Lilia Saturday 7 to 8:30' }, headers: auth(phone.token) });
  ok('"Errand: ..." files an ask, and Siri hears all of it back', r.status === 200 && r.data.item.kind === 'ask' && r.data.item.source === 'siri'
    && /Lilia Saturday 7 to 8:30/.test(r.data.message), r.text);
  const errandId = r.data.id;
  r = await req('POST', '/api/inbox/capture', { body: { source: 'share', text: 'Sam: dinner Friday?', app: 'Messages', note: 'find us somewhere' }, headers: auth(phone.token) });
  ok('a shared message is captured as an ask', r.status === 200 && /a message/.test(r.data.message), r.text);
  const msgId = r.data.id;
  for (const [what, method, url] of [
    ['list the inbox', 'GET', '/api/inbox'],
    ['list asks', 'GET', '/api/inbox?kind=ask'],
    ['read an ask\'s capture', 'GET', `/api/inbox/${msgId}/context`],
    ['fetch a picture', 'GET', `/api/inbox/${msgId}/image`],
    ['claim', 'POST', `/api/inbox/${msgId}/claim`],
    ['PATCH an ask', 'PATCH', `/api/inbox/${msgId}`],
    ['PATCH an idea', 'PATCH', `/api/inbox/${ideaId}`],
  ]) {
    r = await req(method, url, { body: method === 'GET' ? undefined : { status: 'done' }, headers: auth(phone.token) });
    ok(`the phone cannot ${what}`, r.status === 403, `${r.status} ${r.text.slice(0, 80)}`);
  }
  r = await req('GET', '/api/inbox/answers', { headers: auth(phone.token) });
  ok('answers carry no capture, no note, no idea', r.status === 200 && !/dinner Friday|find us somewhere|Lilia|school pickups|idea from the phone/.test(r.text), r.text);

  /* ---------- the agent's door ---------- */
  say('\nthe agent reads asks, never ideas');
  r = await req('GET', '/api/inbox?status=new&kind=ideas', { headers: auth(agent.token) });
  ok('the agent lists asks only, whatever kind it asks for', r.status === 200 && r.data.items.length >= 3 && r.data.items.every((i) => i.kind === 'ask') && !('counts' in r.data), r.text.slice(0, 200));
  ok('...and the list carries no capture text', !/dinner Friday/.test(r.text) && r.data.items.find((i) => i.id === msgId).context.hasText === true);
  r = await req('GET', '/api/inbox?status=new&order=oldest&limit=1', { headers: auth(agent.token) });
  ok('...oldest first when asked, bounded by limit', r.data.items.length === 1);
  r = await req('PATCH', '/api/inbox/' + ideaId, { body: { claudeNote: 'mine now' }, headers: auth(agent.token) });
  ok('the agent cannot touch an idea (404, like an unknown id)', r.status === 404);
  r = await req('POST', '/api/inbox', { body: { text: 'Errand: from the agent' }, headers: auth(agent.token) });
  ok('...cannot file anything', r.status === 403);
  r = await req('GET', '/api/inbox/answers', { headers: auth(agent.token) });
  ok('...and does not read the phone\'s answers', r.status === 403);
  r = await req('GET', `/api/inbox/${msgId}/context`, { headers: auth(agent.token) });
  ok('a capture cannot be read before it is claimed', r.status === 409);
  r = await req('PATCH', '/api/inbox/' + msgId, { body: { status: 'done' }, headers: auth(agent.token) });
  ok('...nor closed', r.status === 409);
  r = await req('GET', '/api/inbox?kind=all', { headers: ADMIN });
  ok('the page reads everything (kind=all)', r.status === 200 && r.data.items.some((i) => i.kind === 'ask') && r.data.items.some((i) => i.kind !== 'ask'));
  r = await req('GET', '/api/inbox', { headers: ADMIN });
  ok('...and its ideas list leaves asks out, in the items and the counts', r.data.items.every((i) => i.kind !== 'ask') && r.data.counts.new === r.data.items.filter((i) => i.status === 'new').length, JSON.stringify(r.data.counts));

  /* ---------- claim ---------- */
  say('\nclaiming');
  const [c1, c2] = await Promise.all([
    req('POST', `/api/inbox/${msgId}/claim`, { headers: auth(agent.token) }),
    req('POST', `/api/inbox/${msgId}/claim`, { headers: auth(agent.token) }),
  ]);
  ok('two claims at once: exactly one wins', [c1.status, c2.status].sort().join(',') === '200,409', `${c1.status},${c2.status}`);
  r = await req('GET', `/api/inbox/${msgId}/context`, { headers: auth(agent.token) });
  ok('the claimed capture is read, note and all', r.status === 200 && r.data.item.context.text === 'Sam: dinner Friday?' && r.data.item.note === 'find us somewhere');
  const claims = await db.get('control', inbox.CLAIMS_DOC);
  ok('...and only one claim was counted', claims && claims.n === 1, JSON.stringify(claims));

  /* ---------- park and reply ---------- */
  say('\nparking a question, and the reply');
  r = await req('PATCH', '/api/inbox/' + msgId, { body: { status: 'parked', ask: { question: 'Sam, dinner Fri?', choices: ['Say yes'] } }, headers: auth(agent.token) });
  ok('parking needs two or three choices', r.status === 422);
  r = await req('PATCH', '/api/inbox/' + msgId, { body: { status: 'parked', ask: { question: 'Sam, dinner Fri?', choices: ['A', 'B', 'C', 'D'] } }, headers: auth(agent.token) });
  ok('...and at most three', r.status === 422);
  r = await req('PATCH', '/api/inbox/' + msgId, { body: { status: 'parked', claudeNote: 'Needs you: dinner with Sam Friday', ask: { question: 'Dinner Friday: say yes and I find a table?', choices: ['Yes, find one', 'You pick', 'Say no'] } }, headers: auth(agent.token) });
  const parked = r.data && r.data.item;
  ok('the agent parks a question with three choices and a fresh k', r.status === 200 && parked.status === 'parked' && /^[0-9a-f]{6}$/.test(parked.ask.k) && parked.ask.choices.length === 3, r.text);
  const doc = await db.get('inbox', msgId);
  ok('leaving doing deletes the capture\'s text', doc.context.text === '' && doc.context.type === 'text');
  r = await req('GET', '/api/inbox/answers', { headers: auth(phone.token) });
  const waiting = r.data.parked.find((p) => p.id === msgId);
  ok('answers list it: id, k, question, choices, no add', waiting && waiting.k === parked.ask.k && waiting.choices[0] === 'Yes, find one' && waiting.hasAdd === false
    && r.data.next.id === msgId && r.data.say === 'Dinner Friday: say yes and I find a table?', r.text);
  ok('...and nothing else of the item', !/Needs you|Sam: dinner/.test(r.text));
  r = await req('POST', `/api/inbox/${msgId}/reply`, { body: { k: parked.ask.k, choice: 'yes' }, headers: auth(phone.token) });
  ok('a reply that is not exactly one of the choices -> 400', r.status === 400);
  r = await req('POST', `/api/inbox/${msgId}/reply`, { body: { k: 'abc123', choice: 'You pick' }, headers: auth(phone.token) });
  ok('a reply to an older question (wrong k) -> 409', r.status === 409);
  r = await req('POST', `/api/inbox/${msgId}/reply`, { body: { text: 'yes, 7:30 works' }, headers: auth(phone.token) });
  ok('free text is not a reply', r.status === 400);
  r = await req('POST', `/api/inbox/${msgId}/reply`, { body: { text: 'the code is 482913' }, headers: auth(phone.token) });
  ok('...and a code in it is refused with the sentence', r.status === 422 && r.data.message === inbox.CODE_REFUSAL, r.text);
  r = await req('POST', `/api/inbox/${msgId}/reply`, { body: { k: parked.ask.k, choice: 'You pick' }, headers: auth(phone.token) });
  ok('the right k and one of the choices -> answered', r.status === 200 && r.data.item.status === 'answered' && r.data.item.answer.choice === 'You pick' && !('add' in r.data), r.text);
  r = await req('POST', `/api/inbox/${msgId}/reply`, { body: { k: parked.ask.k, choice: 'Say no' }, headers: auth(phone.token) });
  ok('a second reply -> 409', r.status === 409);
  r = await req('GET', '/api/inbox?status=answered', { headers: auth(agent.token) });
  ok('the agent sees the answer on its next run', r.data.items.some((i) => i.id === msgId && i.answer.choice === 'You pick'));
  r = await req('PATCH', '/api/inbox/' + msgId, { body: { status: 'done', claudeNote: 'Draft for Sam: "Yes! You pick the place." Paste it yourself.' }, headers: auth(agent.token) });
  ok('...and closes it with a note', r.status === 200 && r.data.item.status === 'done');
  r = await req('GET', '/api/inbox/answers', { headers: auth(phone.token) });
  ok('"Any answer?" gets the newest done note', r.data.latest && r.data.latest.id === msgId && /Paste it yourself/.test(r.data.latest.note));

  /* expiry at the moment of the reply */
  await req('POST', `/api/inbox/${errandId}/claim`, { headers: auth(agent.token) });
  r = await req('PATCH', '/api/inbox/' + errandId, { body: { status: 'parked', ask: { question: 'Lilia Sat 7:45 for 2?', choices: ['Send the link', 'Skip'] } }, headers: auth(agent.token) });
  const ek = r.data.item.ask.k;
  const ed = await db.get('inbox', errandId);
  await db.update('inbox', errandId, { ask: { ...ed.ask, expiresAt: hoursAgo(0.01) } });
  r = await req('POST', `/api/inbox/${errandId}/reply`, { body: { k: ek, choice: 'Skip' }, headers: auth(phone.token) });
  ok('a reply after expiresAt is refused, and the ask is expired', r.status === 410 && (await db.get('inbox', errandId)).status === 'expired', r.text);

  /* ---------- what the agent may write ---------- */
  say('\nwhat the agent may write');
  r = await req('POST', '/api/inbox/capture', { body: { source: 'share', text: 'a page about a bar', title: 'Bar Contra' }, headers: auth(phoneB.token) });
  const wId = r.data.id;
  await req('POST', `/api/inbox/${wId}/claim`, { headers: PG });
  const tryNote = async (note) => (await req('PATCH', '/api/inbox/' + wId, { body: { claudeNote: note }, headers: auth(agentB.token) }));
  const NOTE_CASES = [
    ['a link to resy.com', 'Misi Sat 7:30 for 2: https://resy.com/cities/ny/misi?date=2026-10-24&seats=2', 200],
    ['a link to a subdomain of an allowed host', 'Your trip: https://trip.strongtechnicalconsulting.com/trips/abc', 200],
    ['opentable and exploretock', 'https://www.opentable.com/r/x or https://www.exploretock.com/y', 200],
    ['a link anywhere else', 'Tickets: https://tickets.example.com/buy', 422],
    ['a look-alike host', 'https://evilresy.com/book', 422],
    ['http, not https', 'http://resy.com/cities/ny', 422],
    ['a bare domain elsewhere', 'Book at lilianewyork.com tonight', 422],
    ['markup', 'Done <img src=x onerror=alert(1)>', 422],
    ['a one-time code', 'Your code is 482913, type it in', 422],
    ['a card number', 'Paid with 4111 1111 1111 1111', 422],
    ['a phone number', 'Call them on 212-555-0143', 422],
    ['a confirmation code with a name', 'Delta GH7K2L for John Smith on Nov 6', 422],
    ['a payment instruction', 'Send $40 by Venmo to hold it', 422],
    ['over 500 characters', 'x'.repeat(501), 422],
    ['a plain answer', 'Lilia Sat Oct 24: nothing 7-8:30; 9:15 only. Set Resy Notify.', 200],
  ];
  for (const [what, note, want] of NOTE_CASES) {
    r = await tryNote(note);
    ok(`claudeNote: ${what} -> ${want}`, r.status === want, `${r.status} ${r.text.slice(0, 120)}`);
  }
  ok('a code in claudeNote gets the codes-and-cards sentence', (await tryNote('PIN: 4417')).data.message === inbox.CODE_REFUSAL);
  r = await req('PATCH', '/api/inbox/' + wId, { body: { ask: { question: 'Which?', choices: ['https://resy.com/x', 'Skip'] } }, headers: auth(agentB.token) });
  ok('a choice may not carry a link', r.status === 422);
  r = await req('PATCH', '/api/inbox/' + wId, { body: { note: 'rewrite Erik' }, headers: auth(agentB.token) });
  ok('the agent cannot rewrite Erik\'s note', r.status === 400);

  /* ---------- Erik's words: codes and cards are refused ---------- */
  say('\ncodes and cards never go through the inbox');
  r = await req('POST', '/api/inbox/capture', { body: { note: 'the code is 482913 for the Delta login' }, headers: auth(phoneB.token) });
  ok('a note with a one-time code -> 422 with the sentence', r.status === 422 && r.data.message === inbox.CODE_REFUSAL, r.text);
  r = await req('POST', '/api/inbox/capture', { body: { source: 'share', text: 'Your Chase verification code: 771204' }, headers: auth(phoneB.token) });
  ok('...a shared message carrying one', r.status === 422);
  r = await req('POST', '/api/inbox', { body: { text: 'Errand: pay with 4111 1111 1111 1111' }, headers: auth(phoneB.token) });
  ok('...an errand with a card number', r.status === 422);
  const stillThere = (await db.list('inbox')).some((d) => /482913|771204|4111 1111/.test(JSON.stringify(d)));
  ok('...and none of them was stored', !stillThere);

  /* ---------- pictures ---------- */
  say('\npictures');
  r = await req('POST', '/api/inbox/capture', { raw: '{"x":"' + 'a'.repeat(1024 * 1024) + '', headers: { 'content-type': 'application/json' } });
  ok('a stranger\'s broken 1 MB body is a 401, not a parse error: auth runs first', r.status === 401, String(r.status));
  r = await req('POST', '/api/inbox/capture', { raw: '{"x":"' + 'a'.repeat(1024 * 1024) + '', headers: { 'content-type': 'application/json', ...auth(agentB.token) } });
  ok('...and the agent\'s is a 403 before any parsing', r.status === 403, String(r.status));
  r = await req('POST', '/api/inbox/capture', { body: { source: 'screen', image: { mediaType: 'image/jpeg', data: 'x'.repeat(1700 * 1024) } }, headers: auth(phoneB.token) });
  ok('a body over 1.5 MB -> 413', r.status === 413, String(r.status));
  r = await req('POST', '/api/inbox/capture', { body: { source: 'screen', image: { mediaType: 'image/jpeg', data: b64(jpeg(800, 600, 720 * 1024)) } }, headers: auth(phoneB.token) });
  ok('a picture over 700 KB decoded -> 413', r.status === 413 && /700 KB/.test(r.data.message), r.text.slice(0, 120));
  r = await req('POST', '/api/inbox/capture', { body: { source: 'screen', image: { mediaType: 'image/jpeg', data: b64(Buffer.from('GIF89a' + 'z'.repeat(100))) } }, headers: auth(phoneB.token) });
  ok('a GIF claiming to be a JPEG -> 415', r.status === 415, String(r.status));
  r = await req('POST', '/api/inbox/capture', { body: { source: 'screen', image: { mediaType: 'image/jpeg', data: b64(Buffer.from('<svg onload=alert(1)>' + 'z'.repeat(40))) } }, headers: auth(phoneB.token) });
  ok('...an SVG -> 415', r.status === 415);
  const shot = jpeg(1280, 2770, 2000);
  r = await req('POST', '/api/inbox/capture', { body: { source: 'screen', image: { mediaType: 'image/png', data: 'data:image/png;base64,' + b64(shot) } }, headers: auth(phoneB.token) });
  ok('a screenshot is saved, typed by its bytes', r.status === 200 && /a screenshot/.test(r.data.message), r.text);
  const imgId = r.data.id;
  const imgItem = await db.get('inbox', imgId);
  const imgDoc = await db.get(inbox.IMAGES, imgId);
  ok('...as its own document, with its size on the item', imgDoc && imgDoc.mediaType === 'image/jpeg' && imgItem.context.image.width === 1280 && imgItem.context.image.height === 2770 && imgItem.context.image.bytes === shot.length);
  r = await req('GET', '/api/inbox?status=new', { headers: auth(agentB.token) });
  ok('listing never loads the picture', !r.text.includes(b64(shot).slice(0, 40)));
  r = await req('GET', `/api/inbox/${imgId}/image`, { headers: auth(agentB.token) });
  ok('the picture is not served before the claim', r.status === 409);
  await req('POST', `/api/inbox/${imgId}/claim`, { headers: auth(agentB.token) });
  r = await req('GET', `/api/inbox/${imgId}/image`, { headers: auth(agentB.token) });
  ok('after the claim it is served once, as the bytes sent', r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && r.buf.equals(shot)
    && r.headers.get('cache-control') === 'no-store' && r.headers.get('x-content-type-options') === 'nosniff');
  ok('...and deleted in that response', (await db.get(inbox.IMAGES, imgId)) === null && (await db.get('inbox', imgId)).context.image === null);
  r = await req('GET', `/api/inbox/${imgId}/image`, { headers: auth(agentB.token) });
  ok('a second fetch -> 410', r.status === 410);
  r = await req('PATCH', '/api/inbox/' + imgId, { body: { status: 'done', claudeNote: 'Not read: looked private' }, headers: auth(agentB.token) });
  ok('the agent closes a private-looking one with its note', r.status === 200 && r.data.item.claudeNote === 'Not read: looked private');

  /* ---------- caps and dedupe ---------- */
  say('\ncaps and dedupe');
  r = await req('POST', '/api/inbox/capture', { body: { source: 'share', url: 'https://www.example.com/menu?x=1#top', title: 'Menu' }, headers: auth(phone2.token) });
  const firstId = r.data.id;
  r = await req('POST', '/api/inbox/capture', { body: { source: 'share', url: 'https://www.example.com/menu?x=1#top', title: 'Menu' }, headers: auth(phone2.token) });
  ok('the same thing twice within 120 s is one item: "Already saved"', r.status === 200 && r.data.duplicate === true && r.data.id === firstId && r.data.message === 'Already saved.', r.text);
  const fd = await db.get('inbox', firstId);
  await db.update('inbox', firstId, { createdAt: new Date(Date.now() - 121e3).toISOString() });
  r = await req('POST', '/api/inbox/capture', { body: { source: 'share', url: 'https://www.example.com/menu?x=1#top', title: 'Menu' }, headers: auth(phone2.token) });
  ok('...after 120 s it is a new one', r.status === 200 && r.data.duplicate === false && r.data.id !== firstId);
  ok('...and the link was kept as origin + path + query', fd.context.url === 'https://www.example.com/menu?x=1');
  const today = new Date().toISOString().slice(0, 10);
  const mine = await db.count('inbox', [['by', '==', phone2.ref], ['day', '==', today]]);
  for (let i = mine; i < inbox.CAPTURES_PER_TOKEN_DAY; i++) {
    await req('POST', '/api/inbox/capture', { body: { source: 'share', text: 'cap filler ' + i }, headers: auth(phone2.token) });
  }
  r = await req('POST', '/api/inbox/capture', { body: { source: 'share', text: 'one too many' }, headers: auth(phone2.token) });
  ok(`${inbox.CAPTURES_PER_TOKEN_DAY} asks a day per phone token, then 429`, r.status === 429 && /daily limit/.test(r.data.message), `${r.status} ${r.text.slice(0, 100)}`);
  r = await req('POST', '/api/inbox/capture', { body: { source: 'share', text: 'from the other phone token' }, headers: auth(phoneC.token) });
  ok('...which is per token', r.status === 200, r.text);
  const queued = (await db.list('inbox', { where: [['status', '==', 'new']] })).filter((d) => d.kind === 'ask').map((d) => d.id);
  const claimStatuses = [];
  for (const id of queued.slice(0, 8)) claimStatuses.push((await req('POST', `/api/inbox/${id}/claim`, { headers: PG })).status);
  const worked = (await db.get('control', inbox.CLAIMS_DOC)).n;
  ok(`at most ${inbox.CLAIMS_PER_DAY} asks moved to doing a day: the next claim is a 429`, worked === inbox.CLAIMS_PER_DAY && claimStatuses.includes(429) && claimStatuses.filter((s) => s === 200).length === inbox.CLAIMS_PER_DAY - 4, `${worked} ${claimStatuses.join(',')}`);

  /* ---------- forgetting ---------- */
  say('\nforgetting on read');
  await db.set('control', inbox.CLAIMS_DOC, { day: today, n: 0 });
  r = await req('POST', '/api/inbox/capture', { body: { source: 'screen', image: { data: b64(png(390, 844)) } }, headers: auth(phoneC.token) });
  const oldId = r.data.id;
  const od = await db.get('inbox', oldId);
  await db.update('inbox', oldId, { context: { ...od.context, captured: hoursAgo(25) } });
  await db.update(inbox.IMAGES, oldId, { createdAt: hoursAgo(25) });
  r = await req('POST', '/api/inbox/capture', { body: { source: 'share', text: 'an old shared message' }, headers: auth(phoneC.token) });
  const oldText = r.data.id;
  const ot = await db.get('inbox', oldText);
  await db.update('inbox', oldText, { context: { ...ot.context, captured: hoursAgo(25) }, ask: { ...ot.ask, expiresAt: hoursAgo(1) } });
  await req('GET', '/api/inbox/answers', { headers: auth(phoneC.token) });
  const o1 = await db.get('inbox', oldId);
  const o2 = await db.get('inbox', oldText);
  ok('24 h after capture the picture is deleted, even unread', (await db.get(inbox.IMAGES, oldId)) === null && o1.context.image === null);
  ok('...and a shared message\'s text, and a passed expiry makes it expired', o2.context.text === '' && o2.status === 'expired' && o2.live === false, JSON.stringify(o2).slice(0, 200));
  r = await req('POST', '/api/inbox/capture', { body: { source: 'share', text: 'claimed and abandoned' }, headers: auth(phoneC.token) });
  const staleId = r.data.id;
  await req('POST', `/api/inbox/${staleId}/claim`, { headers: auth(agentC.token) });
  await db.update('inbox', staleId, { claimedAt: hoursAgo(2) });
  await req('GET', '/api/inbox?status=doing', { headers: auth(agentC.token) });
  const sd = await db.get('inbox', staleId);
  ok('a run that stopped partway (doing for 90 minutes) ends expired, its capture gone', sd.status === 'expired' && sd.context.text === '' && /stopped partway/.test(sd.claudeNote));

  /* ---------- calendar and reminders ---------- */
  say('\nadding to the calendar: proposed by the agent, written by the phone');
  r = await req('POST', '/api/inbox/capture', { body: { source: 'share', text: 'Friday 7 at Misi?', note: 'make it happen' }, headers: auth(phoneC.token) });
  const calId = r.data.id;
  await req('POST', `/api/inbox/${calId}/claim`, { headers: auth(agentC.token) });
  const start = nyEvening(5);
  const choices = ['Add to calendar', 'Skip'];
  const event = { type: 'event', title: 'Dinner at Misi', start, timeZone: 'America/New_York', location: '329 Kent Ave, Brooklyn', notes: 'Booked by you on Resy: https://resy.com/cities/ny/misi', alertMinutes: 60 };
  const tryAdd = async (add, ch = choices) => (await req('PATCH', '/api/inbox/' + calId, { body: { ask: { question: 'Add dinner at Misi, Fri 7:45?', choices: ch, add } }, headers: auth(agentC.token) }));
  const ADD_CASES = [
    ['no zone', { ...event, timeZone: undefined }, 422],
    ['a made-up zone', { ...event, timeZone: 'Mars/Olympus' }, 422],
    ['an offset that is not the zone\'s', { ...event, start: start.replace(/[+-]\d\d:\d\d$/, '+02:00') }, 422],
    ['a time with no offset', { ...event, start: start.slice(0, 19) }, 422],
    ['an end before the start', { ...event, end: start.replace('T19:45', 'T18:00') }, 422],
    ['alertMinutes over a day', { ...event, alertMinutes: 2000 }, 422],
    ['a code in the notes', { ...event, notes: 'Door code 4417 at the gate' }, 422],
    ['a code with a surname in the notes', { ...event, notes: 'Confirmation K7Q2LP under Smith, party of Erik Smith' }, 422],
    ['a link off the allowlist', { ...event, url: 'https://misi.example.com' }, 422],
    ['a title with markup', { ...event, title: '<b>Dinner</b>' }, 422],
    ['a title over 120', { ...event, title: 't'.repeat(121) }, 422],
    ['no choice that adds it', event, 422, ['Yes', 'No']],
    ['a type that is neither', { ...event, type: 'alarm' }, 422],
  ];
  for (const [what, add, want, ch] of ADD_CASES) {
    r = await tryAdd(add, ch);
    ok(`add: ${what} -> ${want}`, r.status === want, `${r.status} ${r.text.slice(0, 140)}`);
  }
  r = await tryAdd(event);
  ok('a good event is accepted, with its end defaulting to start + 2 h in the same offset', r.status === 200 && r.data.item.ask.add.end === start.replace('T19:45', 'T21:45')
    && r.data.item.ask.addChoice === 'Add to calendar', r.text.slice(0, 300));
  r = await req('PATCH', '/api/inbox/' + calId, { body: { status: 'parked' }, headers: auth(agentC.token) });
  const calK = r.data.item.ask.k;
  r = await req('GET', '/api/inbox/answers', { headers: auth(phoneC.token) });
  const calQ = r.data.parked.find((p) => p.id === calId);
  ok('answers say the question carries an add, without the add itself', calQ && calQ.hasAdd === true && calQ.addType === 'event' && !/Misi, Brooklyn|329 Kent/.test(r.text));
  r = await req('POST', `/api/inbox/${calId}/reply`, { body: { k: calK, choice: 'Add to calendar' }, headers: auth(phoneC.token) });
  const add = r.data && r.data.add;
  ok('picking the add choice returns the validated event', r.status === 200 && add && add.type === 'event' && add.title === 'Dinner at Misi' && add.start === start && add.timeZone === 'America/New_York'
    && add.alertMinutes === 60 && add.location === '329 Kent Ave, Brooklyn' && /7:45 PM/.test(add.when), r.text);
  ok('...and records addedAt', !!(await db.get('inbox', calId)).addedAt);
  r = await req('POST', `/api/inbox/${calId}/reply`, { body: { k: calK, choice: 'Add to calendar' }, headers: auth(phoneC.token) });
  ok('...once: a second reply gets no add', r.status === 409 && !(r.data && r.data.add));

  r = await req('POST', '/api/inbox/capture', { body: { source: 'share', text: 'cancel by Thursday noon or pay a fee', title: 'Hotel policy' }, headers: auth(phoneC.token) });
  const remId = r.data.id;
  await req('POST', `/api/inbox/${remId}/claim`, { headers: auth(agentC.token) });
  const due = nyEvening(3).replace('T19:45', 'T12:00');
  r = await req('PATCH', '/api/inbox/' + remId, { body: { status: 'parked', ask: { question: 'Remind you to cancel by Thu noon?', choices: ['Remind me', 'Skip'], add: { type: 'reminder', title: 'Cancel the hotel (fee after noon)', due, timeZone: 'America/New_York', choice: 'Remind me' } } }, headers: auth(agentC.token) });
  ok('a reminder with a named choice is accepted', r.status === 200 && r.data.item.ask.add.type === 'reminder', r.text.slice(0, 200));
  const remK = r.data.item.ask.k;
  r = await req('POST', `/api/inbox/${remId}/reply`, { body: { k: remK, choice: 'Skip' }, headers: auth(phoneC.token) });
  ok('picking the other choice returns no add and records no addedAt', r.status === 200 && !('add' in r.data) && !(await db.get('inbox', remId)).addedAt);

  /* ---------- the ideas run's CLI ---------- */
  say('\nthe ideas run never sees an ask');
  const tokFile = path.join(os.tmpdir(), 'concierge-test-token-' + process.pid);
  fs.writeFileSync(tokFile, 'ya29.test\n');
  process.env.GCP_TOKEN_FILE = tokFile;
  const fakeFetch = async () => new Response(JSON.stringify([
    { document: { name: 'projects/p/databases/eriks-projects/documents/inbox/aaaa1111', fields: { text: { stringValue: 'an idea' }, kind: { stringValue: 'idea' }, status: { stringValue: 'new' }, createdAt: { stringValue: '2026-10-01T00:00:00.000Z' } } } },
    { document: { name: 'projects/p/databases/eriks-projects/documents/inbox/bbbb2222', fields: { text: { stringValue: '' }, kind: { stringValue: 'ask' }, status: { stringValue: 'new' }, createdAt: { stringValue: '2026-10-02T00:00:00.000Z' } } } },
  ]), { status: 200 });
  const rows = await cli.list({ status: 'new' }, fakeFetch);
  ok('scripts/inbox.js list leaves asks out', rows.length === 1 && rows[0].id === 'aaaa1111');
  fs.unlinkSync(tokFile);

  /* ---------- the page ---------- */
  say('\nthe page draws asks escaped');
  const html = view.askHtml({
    id: '"><svg onload=alert(1)>', status: 'parked', note: '<img src=x onerror=alert(1)>', source: 'share', claudeNote: '</p><script>alert(2)</script>',
    context: { type: 'url', url: 'javascript:alert(3)', title: '<b>t</b>', app: '<i>', hasText: false, image: null },
    ask: { k: '" onclick="x', question: '<script>q</script>', choices: ['<b>A</b>', '" autofocus onfocus="alert(4)'], expiresAt: null, add: null },
  }, Date.now());
  ok('no markup from an ask survives', !/<img|<script|<svg[^>]*onload|<b>|<i>|onfocus="|onclick="/i.test(html), html);
  ok('...and a non-https link is not drawn as a link', !/href="javascript/i.test(html));
  ok('the token row shows a prefix, never a hash', !/[0-9a-f]{64}/.test(view.tokenHtml({ ref: 'abcdef012345', scope: 'agent', label: '<x>', prefix: 'a1b2c3', createdAt: null })));
  const ics = view.icsFor({ type: 'event', title: 'Dinner, at; Misi', start, end: start.replace('T19:45', 'T21:45'), location: 'Kent Ave', notes: 'line1\nline2', alertMinutes: 30 }, new Date('2026-10-18T00:00:00Z'));
  ok('the page\'s .ics escapes commas, semicolons and newlines, in UTC', /SUMMARY:Dinner\\, at\\; Misi/.test(ics) && /DESCRIPTION:line1\\nline2/.test(ics) && /DTSTART:\d{8}T\d{6}Z/.test(ics) && /TRIGGER:-PT30M/.test(ics), ics);

  /* ---------- nothing private was printed ---------- */
  const log = printed.join('\n');
  ok('no token and no capture text ever reached the log', ![phone.token, phone2.token, phoneB.token, phoneC.token, agent.token, agentB.token, agentC.token, legacy].some((t) => log.includes(t))
    && !/dinner Friday|Lilia|482913|4111|Misi/.test(log), log.slice(0, 300));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { say('CRASH ' + (err && err.stack)); process.exit(1); });
