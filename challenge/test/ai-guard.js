// The Lab AI guard (lib/ai-guard.js, lib/vertex.js, GET /api/lab/ai-guard):
// burst limits per account and per address, the monthly cap per provider,
// atomic month totals, prices, fail-closed cap, the public status, and the
// Gemini helper against a fake fetch. Nothing here touches the network.
process.env.LAB_MEMORY = '1';
const assert = require('assert');
const http = require('http');
const aiGuard = require('../lib/ai-guard');
const vertex = require('../lib/vertex');

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };
const quiet = { warn() {}, error() {} };
const clock = (start) => { const c = { t: Date.parse(start) }; c.now = () => c.t; return c; };
const req = (ip, uid) => ({ ip, user: uid ? { id: uid } : undefined });
const env = (extra = {}) => ({ ...extra });

// AbortSignal.timeout's timer does not hold the process open, so without
// this a hanging fake fetch would let node exit 0 halfway through. And a run
// that never reaches the end must fail.
const keepAlive = setInterval(() => {}, 1000);
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('ai-guard: the suite stopped before the end'); process.exitCode = 1; } });

(async () => {
  /* ---------------- burst: per account ---------------- */
  {
    const c = clock('2026-11-23T10:00:00Z');
    const g = aiGuard.create({ env: env(), now: c.now, log: quiet });
    // Five a minute for one account, even from five different addresses.
    for (let i = 0; i < 5; i++) assert.deepStrictEqual(await g.allow({ provider: 'claude', req: req(`198.51.100.${i}`, 'u1'), app: 'spar' }), { ok: true });
    const six = await g.allow({ provider: 'gemini', req: req('198.51.100.9', 'u1'), app: 'rave' });
    assert.strictEqual(six.ok, false); assert.strictEqual(six.code, 'burst-minute'); assert.strictEqual(six.status, 429);
    assert.strictEqual(six.message, 'Lots of people are using AI right now - try again in a minute.');
    // Another account is not affected.
    assert.ok((await g.allow({ provider: 'claude', req: req('203.0.113.1', 'u2'), app: 'spar' })).ok);
    ok('an account gets 5 AI calls a minute across apps, providers and addresses');

    // The minute slides: after 60 s the account may go again, up to 30 a day.
    let allowed = 5; // u1's so far
    for (let m = 1; allowed < 30 && m < 100; m++) {
      c.t += 61 * 1000;
      for (let i = 0; i < 5 && allowed < 30; i++) {
        const r = await g.allow({ provider: 'claude', req: req(`198.51.${m}.${i}`, 'u1'), app: 'spar' });
        assert.ok(r.ok, `call ${allowed + 1}`);
        allowed++;
      }
    }
    c.t += 61 * 1000;
    const day = await g.allow({ provider: 'claude', req: req('192.0.2.200', 'u1'), app: 'spar' });
    assert.strictEqual(day.code, 'burst-day'); assert.strictEqual(day.status, 429);
    ok('an account gets 30 AI calls a day, then burst-day');

    c.t += 24 * 60 * 60 * 1000;
    assert.ok((await g.allow({ provider: 'claude', req: req('192.0.2.200', 'u1'), app: 'spar' })).ok);
    ok('the day window slides: a day later the account may call again');
  }

  /* ---------------- burst: per address (IPv6 /64) ---------------- */
  {
    const c = clock('2026-11-23T10:00:00Z');
    const g = aiGuard.create({ env: env(), now: c.now, log: quiet });
    // Five different accounts (and anonymous) from one /64: the sixth is refused.
    for (let i = 0; i < 5; i++) assert.ok((await g.allow({ provider: 'gemini', req: req(`2001:db8:1:2:${i}::1`, `acct${i}`), app: 'rave' })).ok);
    const sixth = await g.allow({ provider: 'gemini', req: req('2001:db8:1:2:ffff:eeee:dddd:cccc'), app: 'rave' });
    assert.strictEqual(sixth.code, 'burst-minute');
    assert.ok((await g.allow({ provider: 'gemini', req: req('2001:db8:1:3::1'), app: 'rave' })).ok, 'the next /64 is someone else');
    ok('an address (IPv6 by its /64) gets 5 a minute whoever is signed in');

    const g2 = aiGuard.create({ env: env(), now: c.now, log: quiet });
    let made = 0;
    for (let m = 0; m < 10; m++) {
      for (let i = 0; i < 5 && made < 30; i++) { assert.ok((await g2.allow({ provider: 'claude', req: req('192.0.2.7'), app: 'spar' })).ok); made++; }
      c.t += 61 * 1000;
    }
    assert.strictEqual((await g2.allow({ provider: 'claude', req: req('::ffff:192.0.2.7'), app: 'spar' })).code, 'burst-day');
    ok('an address gets 30 a day (IPv4-mapped counts as IPv4)');

    // Env overrides.
    const g3 = aiGuard.create({ env: env({ LAB_AI_BURST_MINUTE: '2', LAB_AI_BURST_IP_MINUTE: '50' }), now: c.now, log: quiet });
    assert.ok((await g3.allow({ provider: 'claude', req: req('192.0.2.8', 'z'), app: 'x' })).ok);
    assert.ok((await g3.allow({ provider: 'claude', req: req('192.0.2.8', 'z'), app: 'x' })).ok);
    assert.strictEqual((await g3.allow({ provider: 'claude', req: req('192.0.2.8', 'z'), app: 'x' })).code, 'burst-minute');
    assert.deepStrictEqual(g3.burst, { accountMinute: 2, accountDay: 30, ipMinute: 50, ipDay: 30 });
    ok('burst numbers come from env, the per-address ones defaulting to the account ones');

    // Parallel requests cannot all slip past one check.
    const g4 = aiGuard.create({ env: env(), now: c.now, log: quiet });
    const many = await Promise.all(Array.from({ length: 20 }, () => g4.allow({ provider: 'claude', req: req('192.0.2.9', 'p'), app: 'x' })));
    assert.strictEqual(many.filter((r) => r.ok).length, 5);
    ok('20 calls at once: exactly 5 pass');
  }

  /* ---------------- monthly cap per provider ---------------- */
  {
    const c = clock('2026-11-23T10:00:00Z');
    const lines = [];
    const log = { warn: (s) => lines.push(s), error() {} };
    const g = aiGuard.create({ env: env({ LAB_AI_CAP_GEMINI_USD: '1', LAB_AI_BURST_MINUTE: '1000', LAB_AI_BURST_DAY: '1000' }), now: c.now, log });
    assert.deepStrictEqual(g.caps, { claude: 25, gemini: 1 });
    assert.ok((await g.allow({ provider: 'gemini', req: req('192.0.2.1', 'a'), app: 'rave' })).ok);
    await g.record({ provider: 'gemini', app: 'rave', usd: 0.6 });
    assert.ok((await g.allow({ provider: 'gemini', req: req('192.0.2.1', 'a'), app: 'rave' })).ok);
    await g.record({ provider: 'gemini', app: 'rave', usd: 0.45 });
    const capped = await g.allow({ provider: 'gemini', req: req('192.0.2.1', 'a'), app: 'rave' });
    assert.deepStrictEqual(capped, { ok: false, status: 503, code: 'monthly-cap', message: 'AI answers are resting until next month; everything else still works.' });
    assert.ok((await g.allow({ provider: 'claude', req: req('192.0.2.1', 'a'), app: 'spar' })).ok);
    ok('crossing the Gemini cap denies Gemini only; Claude still answers');

    assert.strictEqual(lines.length, 1); assert.match(lines[0], /gemini monthly cap reached for 2026-11: \$1\.05 of \$1\.00/);
    await g.record({ provider: 'gemini', app: 'rave', usd: 0.1 });
    c.t += 31 * 1000; await g.allow({ provider: 'gemini', req: req('192.0.2.1'), app: 'rave' });
    assert.strictEqual(lines.length, 1);
    assert.ok(!/192\.0\.2|rave|\ba\b/.test(lines[0]));
    ok('one log line when a cap is crossed, with no user data');

    c.t = Date.parse('2026-12-01T00:00:01Z');
    assert.ok((await g.allow({ provider: 'gemini', req: req('192.0.2.1', 'a'), app: 'rave' })).ok);
    ok('a new UTC month starts from zero');

    // A second instance sees the first one's spend through the shared store.
    const store = aiGuard.memoryStore();
    const c2 = clock('2026-11-23T10:00:00Z');
    const a = aiGuard.create({ store, env: env({ LAB_AI_CAP_CLAUDE_USD: '2' }), now: c2.now, log: quiet });
    const b = aiGuard.create({ store, env: env({ LAB_AI_CAP_CLAUDE_USD: '2' }), now: c2.now, log: quiet });
    assert.ok((await b.allow({ provider: 'claude', req: req('192.0.2.2'), app: 'x' })).ok);
    await a.record({ provider: 'claude', app: 'x', usd: 2.5 });
    assert.ok((await b.allow({ provider: 'claude', req: req('192.0.2.3'), app: 'x' })).ok, 'b still uses its 30 s cache');
    c2.t += 30 * 1000;
    assert.strictEqual((await b.allow({ provider: 'claude', req: req('192.0.2.4'), app: 'x' })).code, 'monthly-cap');
    assert.deepStrictEqual(await store.get('lab_ai_spend', 'claude-2026-11'), { usd: 2.5 });
    ok('the month total is shared through lab_ai_spend/<provider>-<YYYY-MM>, re-read every 30 s');
  }

  /* ---------------- atomic increments ---------------- */
  {
    // A store whose bump yields first, the way a network call would.
    const inner = aiGuard.memoryStore();
    const store = {
      get: inner.get,
      async bump(c, id, d) { await new Promise((r) => setImmediate(r)); return inner.bump(c, id, d); },
    };
    const g = aiGuard.create({ store, log: quiet });
    await Promise.all(Array.from({ length: 200 }, () => g.record({ provider: 'claude', app: 'x', usd: 0.01 })));
    const month = aiGuard.monthOf(Date.now());
    const got = await store.get('lab_ai_spend', `claude-${month}`);
    assert.ok(Math.abs(got.usd - 2) < 1e-9, String(got.usd));
    assert.strictEqual(await store.get('lab_ai_spend', `gemini-${month}`), null);
    ok('200 concurrent records add up exactly (increment, never read-and-write)');

    await assert.rejects(() => g.record({ provider: 'claude', app: 'x', usd: -1 }), TypeError);
    await assert.rejects(() => g.record({ provider: 'claude', app: 'x', usd: NaN }), TypeError);
    await assert.rejects(() => g.record({ provider: 'claude', app: 'x', usd: '0.1' }), TypeError);
    await assert.rejects(() => g.record({ provider: 'openai', app: 'x', usd: 1 }), /unknown provider/);
    await assert.rejects(() => g.allow({ provider: 'claude', app: 'x' }), TypeError);
    await assert.rejects(() => g.allow({ provider: 'claude', req: req('1.2.3.4') }), TypeError);
    ok('misuse throws: bad usd, unknown provider, no request, no app');

    const bad = aiGuard.create({ store: { get: inner.get, async bump() { throw new Error('down'); } }, log: quiet });
    assert.strictEqual(await bad.record({ provider: 'claude', app: 'x', usd: 0.1 }), false);
    ok('a failed record resolves false rather than failing the answer');
  }

  /* ---------------- fail closed on the cap ---------------- */
  {
    const c = clock('2026-11-23T10:00:00Z');
    let broken = true;
    const inner = aiGuard.memoryStore();
    const store = { async get(...a) { if (broken) throw new Error('unreachable'); return inner.get(...a); }, bump: inner.bump };
    const g = aiGuard.create({ store, now: c.now, log: quiet });
    const r = await g.allow({ provider: 'claude', req: req('192.0.2.1', 'a'), app: 'x' });
    assert.strictEqual(r.code, 'monthly-cap');
    assert.deepStrictEqual(await g.status(), { claude: { capUsd: 25, monthUsd: null }, gemini: { capUsd: 25, monthUsd: null } });
    ok('no readable month total and nothing cached: denied as monthly-cap');

    broken = false;
    assert.ok((await g.allow({ provider: 'claude', req: req('192.0.2.1', 'a'), app: 'x' })).ok);
    broken = true; c.t += 60 * 1000;
    assert.ok((await g.allow({ provider: 'claude', req: req('192.0.2.1', 'a'), app: 'x' })).ok, 'last good value this month is used');
    c.t = Date.parse('2026-12-01T00:00:05Z');
    assert.strictEqual((await g.allow({ provider: 'claude', req: req('192.0.2.1', 'a'), app: 'x' })).code, 'monthly-cap', 'last month\'s value does not count');
    ok('an unreadable total keeps this month\'s cached value, never last month\'s');
  }

  /* ---------------- prices ---------------- */
  {
    const P = aiGuard.priceUsd;
    const m = 1e6;
    assert.strictEqual(P({ provider: 'gemini', model: 'gemini-3.8-flash', inputTokens: m, outputTokens: m, at: new Date('2026-12-31T23:59:59Z') }), 0.75 + 3.75);
    assert.strictEqual(P({ provider: 'gemini', model: 'gemini-3.8-flash', inputTokens: m, outputTokens: m, at: new Date('2027-01-01T00:00:00Z') }), 1.5 + 7.5);
    assert.strictEqual(P({ provider: 'gemini', model: 'gemini-3.8-flash', inputTokens: m, outputTokens: 0, at: '2027-06-01T00:00:00Z' }), 1.5);
    ok('gemini-3.8-flash: $0.75/$3.75 through 2026-12-31, $1.50/$7.50 from 2027-01-01 UTC');
    assert.ok(Math.abs(P({ provider: 'gemini', model: 'gemini-3.5-flash-lite', inputTokens: m, outputTokens: m }) - 2.8) < 1e-12);
    ok('gemini-3.5-flash-lite: $0.30/$2.50');
    assert.strictEqual(P({ provider: 'claude', model: 'claude-sonnet-4-6', inputTokens: m, outputTokens: m }), 3 + 15);
    assert.strictEqual(P({ provider: 'claude', model: 'claude-haiku-4-5', inputTokens: 2000, outputTokens: 1000 }), (2000 * 1 + 1000 * 5) / m);
    assert.ok(Math.abs(P({ provider: 'claude', model: 'claude-haiku-4-5', inputTokens: 0, outputTokens: 0, webSearches: 3 }) - 0.03) < 1e-12);
    ok('Claude prices come from the identity table (searches included)');
    const near = (a, b) => Math.abs(a - b) < 1e-12;
    assert.ok(near(P({ provider: 'claude', model: 'claude-opus-5-5', inputTokens: m, outputTokens: m }), 24));
    assert.ok(near(P({ provider: 'claude', model: 'claude-fable-5-2', inputTokens: 0, cacheReadTokens: m, cacheWriteTokens: m }), 10.2));
    assert.ok(near(P({ provider: 'claude', model: 'claude-haiku-5-5', inputTokens: 200000, outputTokens: 0 }), 0.1));
    ok('new models and per-model cache rates (Opus 5.5 $4/$20, Fable 5.2 read $0.20 / write $10, Haiku 5.5 long card)');
    const iterations = [{ type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 10000, output_tokens: 1000 }];
    const exec = (5000 * 2 + 500 * 10) / m;
    const adv = (10000 * 4 + 1000 * 20) / m;
    assert.ok(near(P({ provider: 'claude', model: 'claude-sonnet-5-5', inputTokens: 5000, outputTokens: 500, iterations }), exec + adv));
    assert.ok(near(P({ provider: 'claude', model: 'claude-sonnet-5-5', usage: { input_tokens: 5000, output_tokens: 500, iterations } }), exec + adv));
    assert.ok(near(P({ provider: 'claude', model: 'claude-sonnet-5-5', inputTokens: 5000, outputTokens: 500 }), exec), 'without iterations: the executor only');
    assert.throws(() => P({ provider: 'claude', model: 'claude-sonnet-5-5', usage: { input_tokens: 1, iterations: [{ type: 'advisor_message', model: 'claude-future-9', input_tokens: 1 }] } }), /no Claude price/);
    assert.throws(() => P({ provider: 'claude', model: 'claude-sonnet-5-5', usage: { input_tokens: -1 } }), TypeError);
    // A usage object whose cache part the host already recorded counts only the rest.
    const marked = { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: m };
    Object.defineProperty(marked, Symbol.for('lab.claudeCache.charged'), { value: true });
    assert.ok(near(P({ provider: 'claude', model: 'claude-sonnet-5-5', usage: marked }), 20 / m));
    ok('the advisor (usage.iterations) is charged at its own model; an unknown advisor throws; host-charged cache counts once');
    assert.throws(() => P({ provider: 'gemini', model: 'gemini-9-ultra', inputTokens: 1 }), /no Gemini price/);
    assert.throws(() => P({ provider: 'claude', model: 'claude-unknown-1', inputTokens: 1 }), /no Claude price/);
    assert.throws(() => P({ provider: 'claude', model: 'constructor', inputTokens: 1 }), /no Claude price/);
    assert.throws(() => P({ provider: 'gemini', model: 'toString', inputTokens: 1 }), /no Gemini price/);
    assert.throws(() => P({ provider: 'mistral', model: 'x' }), /unknown provider/);
    assert.throws(() => P({ provider: 'gemini', model: 'gemini-3.8-flash', inputTokens: -5 }), TypeError);
    ok('an unknown model or provider throws - never priced as zero');
  }

  /* ---------------- the Gemini helper ---------------- */
  {
    const schema = { type: 'object', properties: { title: { type: 'string' }, score: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } }, mood: { type: 'string', enum: ['calm', 'busy'] } }, required: ['title'] };
    const calls = [];
    const fakeFetch = (responder) => async (url, init = {}) => { calls.push({ url, init }); return responder(url, init); };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    const good = fakeFetch((url) => {
      if (url.startsWith('http://metadata.google.internal')) return json({ access_token: 'tok-1', expires_in: 3599, token_type: 'Bearer' });
      return json({
        candidates: [{ content: { role: 'model', parts: [{ text: 'thinking...', thought: true }, { text: '{"title":"Hi",' }, { text: '"score":3}' }] } }],
        usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 80, thoughtsTokenCount: 20, totalTokenCount: 1300 },
      });
    });
    const v = vertex.create({ env: {}, fetch: good });
    const out = await v.generate({ model: 'gemini-3.8-flash', contents: 'Name it.', responseSchema: schema, systemInstruction: 'Be brief.', generationConfig: { temperature: 0.2 } });
    assert.deepStrictEqual(out.json, { title: 'Hi', score: 3 });
    assert.deepStrictEqual(out.usage, { inputTokens: 1200, outputTokens: 100 });
    const [tokCall, genCall] = calls;
    assert.strictEqual(tokCall.url, 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
    assert.strictEqual(tokCall.init.headers['Metadata-Flavor'], 'Google');
    assert.strictEqual(genCall.url, 'https://aiplatform.googleapis.com/v1/projects/metal-celerity-236019/locations/global/publishers/google/models/gemini-3.8-flash:generateContent');
    assert.strictEqual(genCall.init.method, 'POST');
    assert.strictEqual(genCall.init.headers.Authorization, 'Bearer tok-1');
    assert.ok(genCall.init.signal, 'a timeout signal');
    const sent = JSON.parse(genCall.init.body);
    assert.strictEqual(sent.generationConfig.responseMimeType, 'application/json');
    assert.deepStrictEqual(sent.generationConfig.responseSchema, schema);
    assert.strictEqual(sent.generationConfig.temperature, 0.2);
    assert.deepStrictEqual(sent.contents, [{ role: 'user', parts: [{ text: 'Name it.' }] }]);
    assert.deepStrictEqual(sent.systemInstruction, { parts: [{ text: 'Be brief.' }] });
    ok('generate: metadata token, the global Vertex endpoint, JSON mode with the schema, usage (thinking billed as output)');

    await v.generate({ model: 'gemini-3.5-flash-lite', contents: [{ role: 'user', parts: [{ text: 'x' }] }], responseSchema: schema });
    assert.strictEqual(calls.filter((c) => c.url.startsWith('http://metadata')).length, 1);
    ok('the token is cached until near expiry');

    // A model that hangs: the timeout wins.
    const hang = fakeFetch((url, init) => {
      if (url.startsWith('http://metadata')) return json({ access_token: 't', expires_in: 100 });
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    });
    const slow = vertex.create({ env: {}, fetch: hang });
    const t0 = Date.now();
    await assert.rejects(() => slow.generate({ model: 'gemini-3.8-flash', contents: 'x', responseSchema: schema, timeoutMs: 50 }), (e) => e.code === 'timeout');
    assert.ok(Date.now() - t0 < 2000);
    ok('a model call that hangs times out');

    const failing = vertex.create({ env: {}, fetch: fakeFetch((url) => (url.startsWith('http://metadata') ? json({ access_token: 't', expires_in: 100 }) : json({ error: { message: 'quota for project 123 exceeded' } }, 429))) });
    await assert.rejects(() => failing.generate({ model: 'gemini-3.8-flash', contents: 'x', responseSchema: schema }), (e) => e.code === 'http' && e.status === 429 && !/quota|123/.test(e.message));
    ok('a provider error becomes a plain error without the provider\'s text');

    const notJson = vertex.create({ env: {}, fetch: fakeFetch((url) => (url.startsWith('http://metadata') ? json({ access_token: 't', expires_in: 100 }) : json({ candidates: [{ content: { parts: [{ text: 'not json' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }))) });
    await assert.rejects(() => notJson.generate({ model: 'gemini-3.8-flash', contents: 'x', responseSchema: schema }), (e) => e.code === 'bad-json' && e.usage.inputTokens === 5);
    ok('unreadable output throws bad-json and still carries the usage to record');

    const noToken = vertex.create({ env: {}, fetch: fakeFetch(() => json({}, 404)) });
    await assert.rejects(() => noToken.generate({ model: 'gemini-3.8-flash', contents: 'x', responseSchema: schema }), (e) => e.code === 'token');
    ok('no metadata server: a token error');

    await assert.rejects(() => v.generate({ model: 'gemini-9', contents: 'x', responseSchema: schema }), TypeError);
    await assert.rejects(() => v.generate({ model: 'gemini-3.8-flash', contents: 'x' }), /responseSchema/);
    ok('an unpriced model or a missing schema is refused before any call');

    // Fake modes: never a fetch.
    const never = async () => { throw new Error('network touched'); };
    const fakeEnv = vertex.create({ env: { LAB_FAKE_AI: '1' }, fetch: never });
    const f1 = await fakeEnv.generate({ model: 'gemini-3.8-flash', contents: 'x', responseSchema: schema });
    assert.deepStrictEqual(f1.json, { title: 'Sample', score: 1, tags: ['Sample'], mood: 'calm' });
    assert.strictEqual(f1.fake, true); assert.ok(f1.usage.inputTokens > 0);
    const f2 = await vertex.create({ env: {}, fetch: never }).generate({ model: 'gemini-3.8-flash', contents: 'x', responseSchema: schema, fake: (body) => ({ title: body.contents[0].parts[0].text }) });
    assert.deepStrictEqual(f2.json, { title: 'x' });
    ok('LAB_FAKE_AI=1 or a caller\'s fake answers without the network');
  }

  /* ---------------- the host: global and status endpoint ---------------- */
  {
    const { host, guard } = require('../server');
    assert.strictEqual(global.LAB_AI_GUARD, guard);
    assert.strictEqual(typeof global.LAB_AI_GUARD.allow, 'function');
    assert.strictEqual(typeof global.LAB_AI_GUARD.gemini.generate, 'function');
    assert.strictEqual(process.env.LAB_FAKE_AI, '1');
    ok('the host sets global.LAB_AI_GUARD (with .gemini), fake AI under LAB_MEMORY');

    await guard.record({ provider: 'gemini', app: 'spar', usd: 1.23456 });
    const server = http.createServer(host).listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/lab/ai-guard`, { headers: { Cookie: 'lab_vid=abcdefghijklmnopqrst' } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=30');
      assert.strictEqual(r.headers.get('set-cookie'), null);
      const body = await r.json();
      assert.deepStrictEqual(Object.keys(body).sort(), ['claude', 'gemini']);
      for (const p of ['claude', 'gemini']) assert.deepStrictEqual(Object.keys(body[p]).sort(), ['capUsd', 'monthUsd']);
      assert.deepStrictEqual(body.gemini, { capUsd: 25, monthUsd: 1.23 });
      assert.strictEqual(body.claude.monthUsd, 0);
      assert.ok(!/spar|uid|ip|user|app/i.test(JSON.stringify(body)));
      ok('GET /api/lab/ai-guard: cap and month-to-date per provider to the cent, nothing per user or app, 30 s cache');
    } finally {
      server.close();
    }
  }

  /* ---------------- burst: a per-app allowance (Spar) ---------------- */
  {
    const c = clock('2026-11-23T10:00:00Z');
    const g = aiGuard.create({ env: env({ LAB_AI_BURST_APP_SPAR: '15/150', LAB_AI_BURST_APP_BAD: 'lots', LAB_AI_BURST_APP_ODD: '9/3' }), now: c.now, log: quiet });
    // Spar: 15 a minute for one account, on its own book.
    for (let i = 0; i < 15; i++) assert.ok((await g.allow({ provider: 'claude', req: req(`198.51.100.${i}`, 'u1'), app: 'spar' })).ok, `spar ${i + 1}`);
    const s16 = await g.allow({ provider: 'claude', req: req('198.51.100.99', 'u1'), app: 'spar' });
    assert.strictEqual(s16.code, 'burst-minute');
    // Spar's 15 did not touch the shared book: another app still gets its 5 ...
    for (let i = 0; i < 5; i++) assert.ok((await g.allow({ provider: 'claude', req: req(`203.0.113.${i}`, 'u1'), app: 'rave' })).ok, `rave ${i + 1}`);
    assert.strictEqual((await g.allow({ provider: 'claude', req: req('203.0.113.9', 'u1'), app: 'rave' })).code, 'burst-minute');
    // ... and spending the shared 5 does not stop Spar once its minute slides.
    c.t += 61 * 1000;
    assert.ok((await g.allow({ provider: 'gemini', req: req('198.51.100.50', 'u1'), app: 'spar' })).ok);
    // Spar's day: 150, then burst-day.
    let used = 16; // 15 + 1 above
    while (used < 150) {
      c.t += 61 * 1000;
      for (let i = 0; i < 15 && used < 150; i++, used++) assert.ok((await g.allow({ provider: 'claude', req: req(`10.0.${used % 250}.${i}`, 'u1'), app: 'spar' })).ok, `spar day ${used + 1}`);
    }
    c.t += 61 * 1000;
    assert.strictEqual((await g.allow({ provider: 'claude', req: req('10.9.9.9', 'u1'), app: 'spar' })).code, 'burst-day');
    // Malformed or nonsensical settings are ignored: those apps keep the shared 5.
    const g2 = aiGuard.create({ env: env({ LAB_AI_BURST_APP_BAD: 'lots', LAB_AI_BURST_APP_ODD: '9/3' }), now: c.now, log: quiet });
    for (const app of ['bad', 'odd']) {
      for (let i = 0; i < 5; i++) assert.ok((await g2.allow({ provider: 'claude', req: req(`192.0.2.${i}`, `x-${app}`), app })).ok);
      assert.strictEqual((await g2.allow({ provider: 'claude', req: req('192.0.2.200', `x-${app}`), app })).code, 'burst-minute');
    }
    // The monthly cap still applies to an app with its own allowance.
    const store = { async get() { return { usd: 25 }; }, async bump() {} };
    const g3 = aiGuard.create({ store, env: env({ LAB_AI_BURST_APP_SPAR: '15/150' }), now: c.now, log: quiet });
    assert.strictEqual((await g3.allow({ provider: 'claude', req: req('192.0.2.1', 'u9'), app: 'spar' })).code, 'monthly-cap');
    ok('LAB_AI_BURST_APP_<SLUG>="m/d" gives one app its own burst book (Spar 15/150); bad values ignored; caps still apply');
  }

  finished = true;
  clearInterval(keepAlive);
  console.log(`ai-guard: ${n} passed`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
