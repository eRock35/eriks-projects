// The ideas inbox: the Siri door, the page's door, and what neither may do.
//
// Booted on the in-memory store (no FIRESTORE_DATABASE_ID), which - unlike
// the harness's fake Firestore - really counts, so the caps are tested
// through the route rather than around it.
const h = require('./harness.js');
h.install();
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const PORT = 8307;
const ADMIN_EMAIL = 'owner@example.com';
process.env.IDENTITY_SESSION_SECRET = 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'landing-secret-abcdefghijklm';
process.env.ADMIN_PASSWORD = 'admin-password-here-1';
process.env.ADMIN_EMAIL = ADMIN_EMAIL;
delete process.env.FIRESTORE_DATABASE_ID;
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.PASSKEY_RP_ID = 'strongtechnicalconsulting.com';
process.env.PORT = String(PORT);

// Everything the server prints, so the suite can say what it never printed.
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
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  return { status: r.status, headers: r.headers, text, data };
}
const auth = (t) => ({ authorization: 'Bearer ' + t });

(async () => {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  /* ---------- pure pieces ---------- */
  say('\nkind guessing and cleaning');
  const g = inbox.guessKind;
  ok('a crash is a bug', g('the trip app crashes when I open photos') === 'bug');
  ok("curly apostrophe: doesn’t work is a bug", g('login doesn’t work on iPad') === 'bug');
  ok('"an app that" is an app idea', g('an app that tracks my kids reading') === 'app idea');
  ok('"would be nice" is a feature', g('it would be nice if football showed spreads') === 'feature');
  ok('"note to self" is a note', g('note to self: renew the domain') === 'note');
  ok('plain musing is an idea', g('what if the landing page had a map') === 'idea');
  ok('word boundaries: "debugging" and "notebook" are not bug/note', g('debugging a notebook') === 'idea');
  let input = inbox.readInput({ text: 'Bug: the countdown is a day off' });
  ok('a spoken "Bug:" prefix files it and is taken off', input.kind === 'bug' && input.text === 'The countdown is a day off', JSON.stringify(input));
  input = inbox.readInput({ text: 'Bug: the countdown', kind: 'note' });
  ok('an explicit kind beats the prefix', input.kind === 'note');
  input = inbox.readInput('  plain text body #Trip #trip #big-idea ');
  ok('a text/plain body is read, hashtags become tags', input.text === 'plain text body #Trip #trip #big-idea' && JSON.stringify(input.tags) === '["trip","big-idea"]', JSON.stringify(input));
  ok('control characters and bidi overrides are removed, newlines kept',
    inbox.cleanText('a\u0000b‮c\r\nd\n\n\n\ne') === 'abc\nd\n\ne');
  ok('text is capped at 2000', inbox.cleanText('x'.repeat(5000)).length === 2000);
  ok('Siri hears the first 60 characters', inbox.savedMessage('y'.repeat(100)) === 'Saved: ' + 'y'.repeat(60) + '…'
    && inbox.savedMessage('short one') === 'Saved: short one');

  /* ---------- the page ---------- */
  say('\nthe page');
  let r = await req('GET', '/admin/inbox');
  ok('signed out, /admin/inbox goes to the login', r.status === 302 && /\/admin\/login$/.test(r.headers.get('location') || ''), String(r.status));
  r = await req('POST', '/api/admin/login', { body: { password: process.env.ADMIN_PASSWORD } });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  ok('admin signs in', r.status === 200 && /^esadmin=/.test(cookie));
  const ADMIN = { cookie };
  r = await req('GET', '/admin/inbox', { headers: ADMIN });
  const csp = r.headers.get('content-security-policy') || '';
  ok('signed in, the page is served', r.status === 200 && /id="inboxApp"/.test(r.text));
  ok('...under a CSP with no inline script', /script-src 'self'(;|$)/.test(csp) && !/<script>/.test(r.text), csp);
  ok('...and with no inline script in the file at all', !/<script(?![^>]*\bsrc=)[^>]*>/i.test(r.text));
  r = await req('GET', '/inbox');
  ok('the bare static shell redirects to the gated page', r.status === 302 && /\/admin\/inbox$/.test(r.headers.get('location') || ''));
  for (const f of ['site/admin-insights.html', 'site/admin.html']) {
    ok(`${f} links the inbox from its section bar`, /<a href="\/admin\/inbox">Inbox<\/a>/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')));
  }

  /* ---------- auth ---------- */
  say('\nwho may knock');
  r = await req('POST', '/api/inbox', { body: { text: 'no token' } });
  ok('no token -> 401, with a message Siri can say', r.status === 401 && /token/i.test(r.data.message), String(r.status));
  r = await req('POST', '/api/inbox', { body: { text: 'no token yet' }, headers: auth('ibx_' + 'a'.repeat(43)) });
  ok('a token before any exists -> 401', r.status === 401);
  r = await req('GET', '/api/inbox/token');
  ok('the token routes are 404 to a stranger', r.status === 404);
  r = await req('POST', '/api/inbox/token', { headers: ADMIN });
  ok('generating a token without the page header is refused (CSRF)', r.status === 403);
  r = await req('POST', '/api/inbox/token', { headers: { ...ADMIN, ...PAGE, 'sec-fetch-site': 'same-site' } });
  ok('...and from a sibling subdomain', r.status === 403);
  r = await req('POST', '/api/inbox/token', { headers: { ...ADMIN, ...PAGE } });
  const token1 = r.data && r.data.token;
  ok('the page generates a token: ibx_ + 32 bytes base64url', r.status === 200 && /^ibx_[A-Za-z0-9_-]{43}$/.test(token1 || ''), r.text);
  const rec = await db.get('control', 'inbox-token');
  ok('only its SHA-256 is stored', rec && rec.hash === crypto.createHash('sha256').update(token1).digest('hex') && !JSON.stringify(rec).includes(token1));
  r = await req('GET', '/api/inbox/token', { headers: ADMIN });
  ok('...and it is never shown again', r.status === 200 && r.data.configured === true && !r.text.includes(token1) && !('hash' in r.data) && !('token' in r.data), r.text);
  r = await req('POST', '/api/inbox', { body: { text: 'wrong' }, headers: auth(token1.slice(0, -1) + (token1.endsWith('A') ? 'B' : 'A')) });
  ok('a wrong token -> 401', r.status === 401);
  r = await req('POST', '/api/inbox', { body: { text: 'wrong' }, headers: { authorization: 'Basic ' + token1 } });
  ok('the right token under the wrong scheme -> 401', r.status === 401);

  /* ---------- adding ---------- */
  say('\nadding');
  r = await req('POST', '/api/inbox', { body: { text: 'Bug: the trip countdown is a day off #trip' }, headers: auth(token1) });
  const first = r.data || {};
  ok('the Shortcut saves: {ok, id, message}', r.status === 200 && first.ok === true && typeof first.id === 'string' && first.message === 'Saved: The trip countdown is a day off #trip', r.text);
  ok('...filed as a bug from Siri, new, tagged', first.item && first.item.kind === 'bug' && first.item.source === 'siri' && first.item.status === 'new' && first.item.tags[0] === 'trip');
  ok('...and the response is JSON, not cached', /application\/json/.test(r.headers.get('content-type')) && r.headers.get('cache-control') === 'no-store');
  r = await req('POST', '/api/inbox', { raw: 'an app that plans school pickups', headers: { ...auth(token1), 'content-type': 'text/plain' } });
  ok('a bare text/plain body works too', r.status === 200 && r.data.item.kind === 'app idea' && r.data.item.text === 'an app that plans school pickups', r.text);
  r = await req('POST', '/api/inbox', { raw: 'text=it%20would%20be%20nice%20to%20export%20budgets', headers: { ...auth(token1), 'content-type': 'application/x-www-form-urlencoded' } });
  ok('...and a form', r.status === 200 && r.data.item.kind === 'feature', r.text);
  r = await req('POST', '/api/inbox', { body: { text: '   ' }, headers: auth(token1) });
  ok('nothing said -> 400 with a message', r.status === 400 && /nothing/i.test(r.data.message));
  r = await req('POST', '/api/inbox', { raw: '{"text": ', headers: { ...auth(token1), 'content-type': 'application/json' } });
  ok('a broken JSON body -> 400, not a 500 page', r.status === 400 && r.data && r.data.ok === false);
  r = await req('POST', '/api/inbox', { body: { text: 'z'.repeat(129 * 1024) }, headers: auth(token1) });
  ok('a body over 128 KB -> 413', r.status === 413 && /too long/i.test(r.data.message), String(r.status));
  r = await req('POST', '/api/inbox', { body: { text: 'q'.repeat(3000) }, headers: auth(token1) });
  ok('under 128 KB but over 2000 characters is kept, cut to 2000', r.status === 200 && r.data.item.text.length === 2000);
  r = await req('POST', '/api/inbox', { raw: 'z'.repeat(200 * 1024), headers: { 'content-type': 'text/plain' } });
  ok('a stranger\'s big body is refused before it is read', r.status === 401);

  r = await req('POST', '/api/inbox', { body: { text: 'typed on the page' }, headers: ADMIN });
  ok('the admin cookie without the page header cannot write (CSRF)', r.status === 403);
  r = await req('POST', '/api/inbox', { body: { text: 'typed on the page', kind: 'note' }, headers: { ...ADMIN, ...PAGE } });
  ok('the admin session saves from the page, no token needed', r.status === 200 && r.data.item.source === 'page' && r.data.item.kind === 'note');
  const pageId = r.data.item.id;

  // The shared account's admin (ADMIN_EMAIL) is the page's other door.
  const uid = Buffer.from(ADMIN_EMAIL).toString('base64url');
  h.bag('identity').set('users/' + uid, { email: ADMIN_EMAIL, createdAt: new Date().toISOString() });
  const idCookie = h.session(process.env.IDENTITY_SESSION_SECRET, ADMIN_EMAIL);
  r = await req('GET', '/api/inbox?status=all', { headers: { cookie: idCookie } });
  ok('the shared-account admin session reads the inbox', r.status === 200 && r.data.items.length === 5, String(r.status));
  const otherCookie = h.session(process.env.IDENTITY_SESSION_SECRET, 'someone@example.com');
  h.bag('identity').set('users/' + Buffer.from('someone@example.com').toString('base64url'), { email: 'someone@example.com' });
  r = await req('GET', '/api/inbox?status=all', { headers: { cookie: otherCookie } });
  ok('any other signed-in account does not', r.status === 401);

  /* ---------- list, filter, patch ---------- */
  say('\nlist, filter, note');
  r = await req('GET', '/api/inbox?status=new', { headers: auth(token1) });
  ok('the daily run lists what is new, newest first', r.status === 200 && r.data.items.length === 5
    && r.data.items[0].id === pageId && r.data.counts.new === 5 && r.data.counts.all === 5, r.text.slice(0, 200));
  r = await req('PATCH', '/api/inbox/' + first.id, { body: { status: 'doing', claudeNote: 'Found it: tripdates.js counts from UTC. Fix drafted.' }, headers: auth(token1) });
  ok('the daily run marks it doing, with a note', r.status === 200 && r.data.item.status === 'doing' && /UTC/.test(r.data.item.claudeNote));
  ok('...and the text is untouched', r.data.item.text === first.item.text);
  r = await req('PATCH', '/api/inbox/' + first.id, { body: { claudeNote: 'n'.repeat(5000) }, headers: auth(token1) });
  ok('a note is capped at 1000', r.status === 200 && r.data.item.claudeNote.length === 1000);
  r = await req('PATCH', '/api/inbox/' + first.id, { body: { text: 'rewritten' }, headers: auth(token1) });
  ok('the text cannot be patched', r.status === 400);
  r = await req('GET', '/api/inbox?status=doing', { headers: ADMIN });
  ok('the Doing filter shows it, and only it', r.status === 200 && r.data.items.length === 1 && r.data.items[0].id === first.id && r.data.counts.doing === 1 && r.data.counts.new === 4);
  r = await req('PATCH', '/api/inbox/' + first.id, { body: { status: 'finished' }, headers: auth(token1) });
  ok('an unknown status -> 400', r.status === 400);
  r = await req('PATCH', '/api/inbox/' + pageId, { body: { kind: 'feature' }, headers: { ...ADMIN, ...PAGE } });
  ok('the page re-files a kind', r.status === 200 && r.data.item.kind === 'feature');
  r = await req('PATCH', '/api/inbox/nosuchitem000', { body: { status: 'done' }, headers: auth(token1) });
  ok('an unknown id -> 404', r.status === 404);
  r = await req('PATCH', '/api/inbox/' + pageId, { body: { status: 'done' }, headers: ADMIN });
  ok('a cookie PATCH without the page header -> 403', r.status === 403);
  r = await req('DELETE', '/api/inbox/' + pageId, { headers: auth(token1) });
  ok('the token cannot delete', r.status === 403);
  r = await req('DELETE', '/api/inbox/' + pageId, { headers: { ...ADMIN, ...PAGE } });
  const gone = await db.get('inbox', pageId);
  ok('the page deletes', r.status === 200 && gone === null);

  /* ---------- rate limit, replace, revoke ---------- */
  say('\nrate limit and revoking');
  r = await req('POST', '/api/inbox/token', { headers: { ...ADMIN, ...PAGE } });
  const token2 = r.data.token;
  r = await req('GET', '/api/inbox?status=new', { headers: auth(token1) });
  ok('a new token replaces the old: the old one -> 401', r.status === 401 && token2 !== token1);
  let statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await req('GET', '/api/inbox?status=new', { headers: auth(token2) })).status);
  ok('30 a minute per token, then 429', statuses.slice(0, 30).every((s) => s === 200) && statuses[30] === 429, statuses.join(','));
  r = await req('GET', '/api/inbox?status=new', { headers: ADMIN });
  ok('...which does not lock the page out', r.status === 200);
  r = await req('DELETE', '/api/inbox/token', { headers: { ...ADMIN, ...PAGE } });
  ok('the page turns the token off', r.status === 200 && (await db.get('control', 'inbox-token')) === null);
  r = await req('POST', '/api/inbox/token', { headers: { ...ADMIN, ...PAGE } });
  const token3 = r.data.token;
  await req('DELETE', '/api/inbox/token', { headers: { ...ADMIN, ...PAGE } });
  r = await req('POST', '/api/inbox', { body: { text: 'after revoke' }, headers: auth(token3) });
  ok('a revoked token -> 401', r.status === 401);

  const lim = inbox.createLimiter({ max: 2, windowMs: 1000, now: (() => { let t = 0; return () => (t += 400); })() });
  ok('the limiter forgets a window once it has passed', lim.hit('k') && lim.hit('k') && !lim.hit('k') && lim.hit('k'));

  /* ---------- caps ---------- */
  say('\ncaps');
  r = await req('POST', '/api/inbox/token', { headers: { ...ADMIN, ...PAGE } });
  const token4 = r.data.token;
  const today = new Date().toISOString().slice(0, 10);
  const have = await db.count('inbox', [['day', '==', today]]);
  for (let i = have; i < inbox.MAX_PER_DAY; i++) await db.set('inbox', 'fill' + String(i).padStart(6, '0'), { text: 'x', status: 'parked', day: today, createdAt: '2000-01-01T00:00:00.000Z' });
  r = await req('POST', '/api/inbox', { body: { text: 'one too many today' }, headers: auth(token4) });
  ok(`${inbox.MAX_PER_DAY} a day, then 429 with a message`, r.status === 429 && /daily/i.test(r.data.message), r.text);
  for (let i = inbox.MAX_PER_DAY; i < inbox.MAX_TOTAL; i++) await db.set('inbox', 'fill' + String(i).padStart(6, '0'), { text: 'x', status: 'parked', day: '2000-01-01', createdAt: '2000-01-01T00:00:00.000Z' });
  r = await req('POST', '/api/inbox', { body: { text: 'no room' }, headers: auth(token4) });
  ok(`${inbox.MAX_TOTAL} in all, then 409`, r.status === 409 && /full/i.test(r.data.message), r.text);
  r = await req('GET', '/api/inbox?status=all&limit=500', { headers: ADMIN });
  ok('a list is bounded at 200', r.status === 200 && r.data.items.length === 200);

  /* ---------- rendering ---------- */
  say('\nrendering hostile text');
  const html = view.itemHtml({
    id: '"><svg onload=alert(1)>',
    text: '<img src=x onerror=alert(1)> & "quotes"',
    claudeNote: '</p><script>alert(2)</script>',
    tags: ['<b>'],
    status: 'x" onmouseover="alert(3)',
    kind: '<i>',
    source: 'siri',
    createdAt: '"><script>',
  }, Date.now());
  ok('no markup from the item survives', !/<img|<script|<svg[^>]*onload|<b>|<i>|onmouseover="/i.test(html), html);
  ok('...it is shown as text', html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;') && html.includes('&lt;/p&gt;&lt;script&gt;'));
  ok('...an unknown status or kind falls back to a real one', /class="pill st st-new"/.test(html) && /<option value="idea" selected>/.test(html));
  ok('the filter bar escapes too', !/<script/.test(view.filtersHtml({ new: '<script>' }, 'new')));
  ok('the endpoint the page shows is the apex', view.ENDPOINT === 'https://strongtechnicalconsulting.com/api/inbox');

  /* ---------- the daily run's CLI ---------- */
  say('\nscripts/inbox.js');
  const tokFile = path.join(os.tmpdir(), 'inbox-test-token-' + process.pid);
  fs.writeFileSync(tokFile, 'ya29.test\n');
  process.env.GCP_TOKEN_FILE = tokFile;
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).endsWith(':runQuery')) {
      return new Response(JSON.stringify([
        { document: { name: 'projects/p/databases/eriks-projects/documents/inbox/aaaa1111', fields: { text: { stringValue: 'older' }, status: { stringValue: 'new' }, kind: { stringValue: 'idea' }, source: { stringValue: 'siri' }, createdAt: { stringValue: '2026-09-01T00:00:00.000Z' }, tags: { arrayValue: { values: [{ stringValue: 'x' }] } } } } },
        { document: { name: 'projects/p/databases/eriks-projects/documents/inbox/bbbb2222', fields: { text: { stringValue: 'newer' }, status: { stringValue: 'new' }, kind: { stringValue: 'bug' }, source: { stringValue: 'page' }, createdAt: { stringValue: '2026-09-02T00:00:00.000Z' }, tags: { arrayValue: {} } } } },
        { readTime: '2026-09-26T00:00:00Z' },
      ]), { status: 200 });
    }
    const body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ name: 'projects/p/databases/eriks-projects/documents/inbox/bbbb2222', fields: { text: { stringValue: 'newer' }, createdAt: { stringValue: '2026-09-02T00:00:00.000Z' }, ...body.fields } }), { status: 200 });
  };
  const listed = await cli.list({ status: 'new' }, fakeFetch);
  const q = JSON.parse(calls[0].opts.body).structuredQuery;
  ok('list asks Firestore for status == new in the eriks-projects database', /databases\/eriks-projects\/documents:runQuery$/.test(calls[0].url)
    && q.where.fieldFilter.value.stringValue === 'new' && !q.orderBy && calls[0].opts.headers.Authorization === 'Bearer ya29.test', calls[0].url + ' ' + JSON.stringify(q));
  ok('...decodes the documents, newest first', listed.length === 2 && listed[0].id === 'bbbb2222' && listed[1].tags[0] === 'x' && listed[0].tags.length === 0);
  const noted = await cli.note('bbbb2222', { status: 'seen', note: 'Read it. Want me to <b>build</b> it?' }, fakeFetch);
  const patchCall = calls[1];
  ok('note PATCHes only status, claudeNote and updatedAt, and only an existing doc',
    patchCall.opts.method === 'PATCH' && /updateMask\.fieldPaths=status&updateMask\.fieldPaths=claudeNote&updateMask\.fieldPaths=updatedAt&currentDocument\.exists=true$/.test(patchCall.url),
    patchCall.url);
  ok('...and reads back the item', noted.status === 'seen' && /build/.test(noted.claudeNote));
  let threw = null;
  try { await cli.note('bbbb2222', { status: 'finished' }, fakeFetch); } catch (e) { threw = e.message; }
  ok('an unknown status is refused before any request', /must be one of/.test(threw || '') && calls.length === 2);
  fs.unlinkSync(tokFile);

  /* ---------- nothing secret was printed ---------- */
  const log = printed.join('\n');
  ok('no token and no item text ever reached the log', ![token1, token2, token3, token4].some((t) => log.includes(t))
    && !/countdown|school pickups|typed on the page/.test(log), log.slice(0, 300));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { say('CRASH ' + (err && err.stack)); process.exit(1); });
