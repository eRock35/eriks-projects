// The lab's Claude calls through workload identity federation (lib/claude-auth.js).
// No network: every fetch is a fake. Run: node test/claude-auth.js
const assert = require('assert');
const path = require('path');
const { create, config } = require('../lib/claude-auth');

const LAB_KEY = 'sk-ant-lab-key-for-tests';
const ENV = {
  LAB_CLAUDE_AUTH: 'federation',
  LAB_WIF_RULE_ID: 'fdrl_01TestRule',
  LAB_WIF_ORG_ID: '00000000-0000-4000-8000-000000000000',
  LAB_WIF_SERVICE_ACCOUNT_ID: 'svac_01TestAccount',
  LAB_WIF_WORKSPACE_ID: 'wrkspc_01TestSpace',
  LAB_WIF_GOOGLE_SA: 'claude-api@example-project.iam.gserviceaccount.com',
  ANTHROPIC_API_KEY: LAB_KEY,
};

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A fake network: Google metadata, IAM ID token, the exchange, and the Messages API. */
function fakeNet({ exchangeStatus = 200, apiStatus = () => 200, expiresIn = 600 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const headers = new Headers(init.headers || {});
    calls.push({ url: u, headers, body: init.body });
    const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('metadata.google.internal')) return json(200, { access_token: 'gcp-access', expires_in: 3599 });
    if (u.includes('iamcredentials.googleapis.com')) return json(200, { token: 'google.id.token' });
    if (u.endsWith('/v1/oauth/token')) {
      return exchangeStatus === 200
        ? json(200, { access_token: `fed-token-${calls.filter((c) => c.url.endsWith('/v1/oauth/token')).length}`, expires_in: expiresIn, token_type: 'Bearer' })
        : json(exchangeStatus, { type: 'error', error: { type: 'authentication_error', message: 'Authentication failed' } });
    }
    if (u.includes('/v1/messages')) {
      const st = apiStatus(headers);
      return st === 200
        ? json(200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
        : json(st, { type: 'error', error: { type: 'authentication_error', message: 'nope' } });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { calls, fetchImpl };
}

// The real SDK's client module, swapped the way the host does it. A fresh copy per test.
function freshSdk() {
  const dir = path.dirname(require.resolve('@anthropic-ai/sdk'));
  for (const k of Object.keys(require.cache)) if (k.startsWith(dir)) delete require.cache[k];
  return { index: require('@anthropic-ai/sdk'), client: require(path.join(dir, 'client.js')) };
}
const ask = (c) => c.messages.create({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
const apiCalls = (calls) => calls.filter((c) => c.url.includes('/v1/messages'));
const exchanges = (calls) => calls.filter((c) => c.url.endsWith('/v1/oauth/token'));

test('off by default: nothing is swapped and the key is used', async () => {
  const { client } = freshSdk();
  const Orig = client.Anthropic;
  const auth = create({ env: { ANTHROPIC_API_KEY: LAB_KEY }, fetchImpl: fakeNet().fetchImpl, log: () => {} });
  assert.strictEqual(auth.install(client), false);
  assert.strictEqual(client.Anthropic, Orig);
  assert.strictEqual(auth.status().mode, 'api-key');
  assert.strictEqual(await auth.token(), null);
});

test('incomplete settings: not installed, one warning, the key is used', () => {
  const { client } = freshSdk();
  const logs = [];
  const auth = create({ env: { ...ENV, LAB_WIF_RULE_ID: '' }, fetchImpl: fakeNet().fetchImpl, log: (m) => logs.push(m) });
  assert.strictEqual(auth.install(client), false);
  assert.strictEqual(logs.length, 1);
  assert.ok(!/fdrl_|wrkspc_|svac_|sk-ant/.test(logs[0]));
  for (const bad of [{ LAB_WIF_ORG_ID: 'nope' }, { LAB_WIF_GOOGLE_SA: 'someone@gmail.com' }, { LAB_WIF_WORKSPACE_ID: 'x' }, { LAB_WIF_SERVICE_ACCOUNT_ID: 'x' }]) {
    assert.strictEqual(config({ ...ENV, ...bad }).complete, false, JSON.stringify(bad));
  }
  assert.strictEqual(config(ENV).complete, true);
});

test('every import form gets the federating class; a lab-key client sends the token, never the key', async () => {
  const { index, client } = freshSdk();
  const net = fakeNet();
  const auth = create({ env: ENV, fetchImpl: net.fetchImpl, log: () => {} });
  assert.strictEqual(auth.install(client), true);
  assert.strictEqual(auth.install(client), true, 'idempotent');
  const viaCall = new index({ apiKey: LAB_KEY, fetch: net.fetchImpl }); // new (require(sdk))(...)
  const viaDefault = new index.default({ apiKey: LAB_KEY, fetch: net.fetchImpl });
  const viaNamed = new index.Anthropic({ apiKey: LAB_KEY, fetch: net.fetchImpl });
  for (const c of [viaCall, viaDefault, viaNamed]) {
    assert.ok(c instanceof index.Anthropic && c instanceof index.BaseAnthropic);
    const r = await ask(c);
    assert.strictEqual(r.content[0].text, 'ok');
  }
  const sent = apiCalls(net.calls);
  assert.strictEqual(sent.length, 3);
  for (const s of sent) {
    assert.strictEqual(s.headers.get('authorization'), 'Bearer fed-token-1');
    assert.strictEqual(s.headers.get('x-api-key'), null);
  }
  assert.strictEqual(exchanges(net.calls).length, 1, 'one exchange, cached');
});

test("a member's own key (BYOK) is untouched", async () => {
  const { index, client } = freshSdk();
  const net = fakeNet();
  create({ env: ENV, fetchImpl: net.fetchImpl, log: () => {} }).install(client);
  await ask(new index({ apiKey: 'sk-ant-members-own', fetch: net.fetchImpl }));
  const [s] = apiCalls(net.calls);
  assert.strictEqual(s.headers.get('x-api-key'), 'sk-ant-members-own');
  assert.strictEqual(s.headers.get('authorization'), null);
  assert.strictEqual(exchanges(net.calls).length, 0);
});

test('the exchange asks for exactly the rule, org, account and workspace, from a Google ID token with its email', async () => {
  const net = fakeNet();
  const auth = create({ env: ENV, fetchImpl: net.fetchImpl, log: () => {} });
  assert.strictEqual(await auth.token(), 'fed-token-1');
  const meta = net.calls.find((c) => c.url.includes('metadata.google.internal'));
  assert.strictEqual(meta.headers.get('metadata-flavor'), 'Google');
  const idt = net.calls.find((c) => c.url.includes('iamcredentials'));
  assert.ok(idt.url.includes(encodeURIComponent(ENV.LAB_WIF_GOOGLE_SA)));
  assert.strictEqual(idt.headers.get('authorization'), 'Bearer gcp-access');
  assert.deepStrictEqual(JSON.parse(idt.body), { audience: 'https://api.anthropic.com', includeEmail: true });
  const ex = JSON.parse(exchanges(net.calls)[0].body);
  assert.deepStrictEqual(ex, {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: 'google.id.token',
    federation_rule_id: ENV.LAB_WIF_RULE_ID, organization_id: ENV.LAB_WIF_ORG_ID,
    service_account_id: ENV.LAB_WIF_SERVICE_ACCOUNT_ID, workspace_id: ENV.LAB_WIF_WORKSPACE_ID,
  });
});

test('parallel calls share one exchange; a new one only near the end of the token', async () => {
  let t = 1_000_000;
  const net = fakeNet({ expiresIn: 600 });
  const auth = create({ env: ENV, fetchImpl: net.fetchImpl, now: () => t, log: () => {} });
  const toks = await Promise.all(Array.from({ length: 20 }, () => auth.token()));
  assert.ok(toks.every((x) => x === 'fed-token-1'));
  assert.strictEqual(exchanges(net.calls).length, 1);
  t += 8 * 60 * 1000; // 8 of 10 minutes: still good
  assert.strictEqual(await auth.token(), 'fed-token-1');
  t += 90 * 1000; // inside the last minute: renewed
  assert.strictEqual(await auth.token(), 'fed-token-2');
  assert.strictEqual(exchanges(net.calls).length, 2);
});

test('a failed exchange falls back to the key, backs off a minute and logs once without secrets', async () => {
  let t = 5_000_000;
  const logs = [];
  const { index, client } = freshSdk();
  const net = fakeNet({ exchangeStatus: 401 });
  const auth = create({ env: ENV, fetchImpl: net.fetchImpl, now: () => t, log: (m) => logs.push(m) });
  auth.install(client);
  const c = new index({ apiKey: LAB_KEY, fetch: net.fetchImpl });
  await ask(c); await ask(c); await ask(c);
  for (const s of apiCalls(net.calls)) {
    assert.strictEqual(s.headers.get('x-api-key'), LAB_KEY);
    assert.strictEqual(s.headers.get('authorization'), null);
  }
  assert.strictEqual(exchanges(net.calls).length, 1, 'backed off');
  assert.strictEqual(logs.length, 1);
  assert.ok(/exchange-401/.test(logs[0]) && !/fdrl_|wrkspc_|svac_|sk-ant|token-/.test(logs[0]));
  t += 61 * 1000;
  await ask(c);
  assert.strictEqual(exchanges(net.calls).length, 2, 'tries again after the minute');
  const st = auth.status();
  assert.strictEqual(st.mode, 'federation');
  assert.strictEqual(st.lastError, 'exchange-401');
  assert.ok(st.fallbacks >= 4);
});

test('a token the API refuses (401) is dropped and that request goes out with the key', async () => {
  const { index, client } = freshSdk();
  const net = fakeNet({ apiStatus: (h) => (h.get('authorization') ? 401 : 200) });
  const auth = create({ env: ENV, fetchImpl: net.fetchImpl, log: () => {} });
  auth.install(client);
  const r = await ask(new index({ apiKey: LAB_KEY, fetch: net.fetchImpl, maxRetries: 0 }));
  assert.strictEqual(r.content[0].text, 'ok');
  const sent = apiCalls(net.calls);
  assert.strictEqual(sent.length, 2);
  assert.ok(sent[0].headers.get('authorization'));
  assert.strictEqual(sent[1].headers.get('x-api-key'), LAB_KEY);
  assert.strictEqual(auth.status().lastError, 'refused-401');
});

test('status never carries an id, token or key', async () => {
  const net = fakeNet();
  const auth = create({ env: ENV, fetchImpl: net.fetchImpl, log: () => {} });
  await auth.token();
  const s = JSON.stringify(auth.status());
  assert.ok(!/fdrl_|wrkspc_|svac_|sk-ant|fed-token|google\.id|gcp-access|@/.test(s), s);
  assert.deepStrictEqual(Object.keys(auth.status()).sort(), ['configured', 'exchanges', 'fallbacks', 'lastError', 'lastOkAt', 'mode']);
});

/* ---------------- prompt caching from the host (lib/claude-cache.js) ---------------- */
const claudeCache = require('../lib/claude-cache');
const aiGuard = require('../lib/ai-guard');
const LONG = 'You are a careful assistant. '.repeat(120);       // ~3,500 chars, ~870 tokens at 4 a token
const SHORT = 'Be brief.';

/** A Messages API that records each body; SSE when the body asks to stream. */
function fakeApi(usage = { input_tokens: 10, output_tokens: 5 }) {
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const msg = { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage };
    if (!body.stream) return new Response(JSON.stringify(msg), { status: 200, headers: { 'content-type': 'application/json' } });
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const sse = ev('message_start', { message: { ...msg, content: [], usage } })
      + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } })
      + ev('content_block_stop', { index: 0 })
      + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
      + ev('message_stop', {});
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { bodies, fetchImpl };
}
const req = (system, extra = {}) => ({ model: 'claude-sonnet-5-5', max_tokens: 8, system, messages: [{ role: 'user', content: 'hi' }], ...extra });
const breakpoints = (b) => JSON.stringify(b).split('"cache_control"').length - 1;

test('cache: off by default - nothing installed, the request goes out as written', async () => {
  const { client } = freshSdk();
  const Orig = client.Anthropic;
  const cache = claudeCache.create({ env: {} });
  assert.strictEqual(cache.install(client), false);
  assert.strictEqual(client.Anthropic, Orig);
  const p = req(LONG);
  assert.strictEqual(cache.prepare(p).params, p);
});

test('cache: one breakpoint on the last system block once the prefix repeats; string becomes a block; caller untouched', async () => {
  const { client, index } = freshSdk();
  const cache = claudeCache.create({ env: { LAB_CLAUDE_CACHE: '1' } });
  assert.strictEqual(cache.install(client, LAB_KEY), true);
  const api = fakeApi();
  const c = new index({ apiKey: LAB_KEY, fetch: api.fetchImpl, maxRetries: 0 });
  const p = req(LONG);
  await c.messages.create(p);
  await c.messages.create(p);
  assert.strictEqual(typeof p.system, 'string', 'the caller\'s params are never mutated');
  assert.strictEqual(api.bodies[0].system, LONG, 'the first sight of a prefix is sent unmarked');
  assert.deepStrictEqual(api.bodies[1].system, [{ type: 'text', text: LONG, cache_control: { type: 'ephemeral' } }]);
  assert.strictEqual(breakpoints(api.bodies[1]), 1);
  // A block system: only the last block is marked, the rest as they were.
  const blocks = [{ type: 'text', text: LONG }, { type: 'text', text: 'Tail.' }];
  await c.messages.create(req(blocks));
  await c.messages.create(req(blocks));
  assert.deepStrictEqual(api.bodies[3].system, [{ type: 'text', text: LONG }, { type: 'text', text: 'Tail.', cache_control: { type: 'ephemeral' } }]);
  assert.strictEqual(blocks[1].cache_control, undefined);
});

test('cache: none below the model minimum, for an unknown model, or when the request has its own', async () => {
  const cache = claudeCache.create({ env: { LAB_CLAUDE_CACHE: '1' } });
  const twice = (p) => { cache.prepare(p); return cache.prepare(p); };
  assert.strictEqual(twice(req(SHORT)).marked, false);
  // ~870 tokens: enough for Sonnet 5.5 (512), not for Haiku 4.5 (4,096).
  assert.strictEqual(twice(req(LONG, { model: 'claude-haiku-4-5' })).marked, false);
  assert.strictEqual(twice(req(LONG, { model: 'claude-future-9' })).marked, false);
  // Tools count toward the prefix.
  const tools = [{ name: 'respond', description: 'x'.repeat(4000), input_schema: { type: 'object' } }];
  assert.strictEqual(twice(req(SHORT, { tools })).marked, true);
  for (const own of [
    req(LONG, { cache_control: { type: 'ephemeral' } }),
    req([{ type: 'text', text: LONG, cache_control: { type: 'ephemeral', ttl: '1h' } }]),
    req(LONG, { tools: [{ ...tools[0], cache_control: { type: 'ephemeral' } }] }),
    req(LONG, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }] }),
  ]) {
    const r = twice(own);
    assert.strictEqual(r.marked, false);
    assert.strictEqual(r.params, own);
  }
  assert.strictEqual(twice(req(LONG)).marked, true);
  // A prefix that varies every time is never marked (no write premium for nothing).
  for (let i = 0; i < 3; i++) assert.strictEqual(cache.prepare(req(`${LONG} ${i}`)).marked, false);
});

test('cache: a prefix not seen for five minutes starts over', async () => {
  let t = 0;
  const cache = claudeCache.create({ env: { LAB_CLAUDE_CACHE: '1' }, now: () => t });
  cache.prepare(req(LONG));
  t += 5 * 60 * 1000;
  assert.strictEqual(cache.prepare(req(LONG)).marked, false);
  t += 1000;
  assert.strictEqual(cache.prepare(req(LONG)).marked, true);
});

test('cache: streams are marked too, exactly once (stream() goes through create())', async () => {
  const { client, index } = freshSdk();
  claudeCache.create({ env: { LAB_CLAUDE_CACHE: '1' } }).install(client, LAB_KEY);
  const api = fakeApi();
  const c = new index({ apiKey: LAB_KEY, fetch: api.fetchImpl, maxRetries: 0 });
  await c.messages.stream(req(LONG)).finalMessage();
  const s = c.messages.stream(req(LONG));
  assert.strictEqual((await s.finalMessage()).content[0].text, 'ok');
  assert.strictEqual(api.bodies[1].stream, true);
  assert.strictEqual(breakpoints(api.bodies[1]), 1);
  assert.strictEqual(api.bodies[1].system[0].cache_control.type, 'ephemeral');
});

test('cache: composes with federation, and a BYOK client is cached but never charged to the lab', async () => {
  const { client, index } = freshSdk();
  const net = fakeNet();
  create({ env: ENV, fetchImpl: net.fetchImpl, log: () => {} }).install(client);
  claudeCache.create({ env: { LAB_CLAUDE_CACHE: '1' } }).install(client, LAB_KEY);
  assert.ok(client.Anthropic.__labFederated && client.Anthropic.__labCached);
  const c = new index({ apiKey: LAB_KEY, fetch: net.fetchImpl, maxRetries: 0 });
  await c.messages.create(req(LONG, { model: 'claude-haiku-5-5' }));
  await c.messages.create(req(LONG, { model: 'claude-haiku-5-5' }));
  const sent = apiCalls(net.calls);
  assert.ok(sent[1].headers.get('authorization'), 'still federated');
  assert.strictEqual(breakpoints(JSON.parse(sent[1].body)), 1, 'and cached');
  // BYOK
  const records = [];
  global.LAB_AI_GUARD = { priceUsd: aiGuard.priceUsd, record: async (r) => { records.push(r); } };
  const api = fakeApi({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1000 });
  const mine = new index({ apiKey: 'sk-ant-members-own', fetch: api.fetchImpl, maxRetries: 0 });
  await mine.messages.create(req(LONG));
  await mine.messages.create(req(LONG));
  assert.strictEqual(breakpoints(api.bodies[1]), 1);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(records.length, 0);
  delete global.LAB_AI_GUARD;
});

test('cache: the lab cap counts the cache part of a breakpoint it added, once', async () => {
  const { client, index } = freshSdk();
  claudeCache.create({ env: { LAB_CLAUDE_CACHE: '1' } }).install(client, LAB_KEY);
  const records = [];
  global.LAB_AI_GUARD = { priceUsd: aiGuard.priceUsd, record: async (r) => { records.push(r); } };
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 };
  const api = fakeApi(usage);
  const c = new index({ apiKey: LAB_KEY, fetch: api.fetchImpl, maxRetries: 0 });
  await c.messages.create(req(LONG));                          // unmarked: nothing recorded
  const res = await c.messages.create(req(LONG));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].app, 'lab-cache');
  // Sonnet 5.5: 5-minute write $2.50 + read $0.10 per MTok.
  assert.ok(Math.abs(records[0].usd - 2.6) < 1e-9, String(records[0].usd));
  // An app that later prices the whole usage object does not count it again.
  const app = aiGuard.priceUsd({ provider: 'claude', model: 'claude-sonnet-5-5', usage: res.usage });
  assert.ok(Math.abs(app - (10 * 2 + 5 * 10) / 1e6) < 1e-12, String(app));
  delete global.LAB_AI_GUARD;
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (err) { console.log(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 3).join('\n       ')}`); process.exitCode = 1; }
  }
  console.log(`claude-auth: ${passed}/${tests.length} passed`);
})();
