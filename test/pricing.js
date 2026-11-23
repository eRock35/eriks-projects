// What a call costs, and who pays for it.
//
// The ledger is the only thing standing between a free allowance and an
// unbounded Anthropic bill, so the arithmetic is worth pinning down - and one
// half of it was simply missing until 2026-09-21.
const h = require('./harness.js');
h.install();
const identity = require(require('path').join(__dirname, '..', 'shared', 'identity.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// Published rates, 2026-09-21. If Anthropic moves a price, this fails first.
ok('Sonnet 5 input is $2/MTok',
   near(identity.priceOf('claude-sonnet-5', { input_tokens: 1e6, output_tokens: 0 }), 2));
ok('...and output is $10/MTok',
   near(identity.priceOf('claude-sonnet-5', { input_tokens: 0, output_tokens: 1e6 }), 10));
ok('Haiku 4.5 is $1/$5',
   near(identity.priceOf('claude-haiku-4-5', { input_tokens: 1e6, output_tokens: 1e6 }), 6));
ok('Opus 5 is $5/$25',
   near(identity.priceOf('claude-opus-5', { input_tokens: 1e6, output_tokens: 1e6 }), 30));

// A cache read is a tenth of an input token; a write is 1.25x.
ok('a cache read costs 0.1x input',
   near(identity.priceOf('claude-sonnet-5', { cache_read_input_tokens: 1e6 }), 0.2));
ok('a cache write costs 1.25x input',
   near(identity.priceOf('claude-sonnet-5', { cache_creation_input_tokens: 1e6 }), 2.5));

// The half that was missing. Web search bills per search, on top of tokens.
const SEARCHES = { server_tool_use: { web_search_requests: 5 } };
ok('five searches cost $0.05, tokens aside',
   near(identity.priceOf('claude-sonnet-5', { input_tokens: 0, output_tokens: 0, ...SEARCHES }), 0.05));

const tokensOnly = identity.priceOf('claude-sonnet-5', { input_tokens: 8000, output_tokens: 1500 });
const withSearch = identity.priceOf('claude-sonnet-5', { input_tokens: 8000, output_tokens: 1500, ...SEARCHES });
ok('a real research answer costs more than its tokens', withSearch > tokensOnly * 2,
   `${tokensOnly.toFixed(4)} vs ${withSearch.toFixed(4)}`);

// The batch discount is on tokens only - searches are not discounted.
const batched = identity.priceOf('claude-sonnet-5', { input_tokens: 1e6, output_tokens: 0, ...SEARCHES }, true);
ok('batch halves the tokens but not the searches', near(batched, 1 + 0.05), String(batched));

// Web fetch is free, so it must not be priced as a search.
ok('web fetch is not charged',
   near(identity.priceOf('claude-sonnet-5', { server_tool_use: { web_fetch_requests: 9 } }), 0));

// An unknown model returns null rather than guessing a price.
ok('an unpriced model returns null', identity.priceOf('some-future-model', { input_tokens: 10 }) === null);

/* ---------- the current models, at their published rates (2026-11-23) ---------- */
// Source: the Claude API skill's shared/models.md and model-migration.md.
const M = 1e6;
const P = (m, u, b) => identity.priceOf(m, u, b);
ok('Opus 5.5 is $4/$20', near(P('claude-opus-5-5', { input_tokens: M, output_tokens: M }), 24));
ok('Sonnet 5.5 is $2/$10', near(P('claude-sonnet-5-5', { input_tokens: M, output_tokens: M }), 12));
ok('Fable 5.2 is $8/$40', near(P('claude-fable-5-2', { input_tokens: M, output_tokens: M }), 48));
ok('Mythos 5.2 prices as Fable 5.2', near(P('claude-mythos-5-2', { input_tokens: M, output_tokens: M }), 48));
ok('Fable 5.1 is still $10/$50', near(P('claude-fable-5-1', { input_tokens: M, output_tokens: M }), 60));
ok('Fable 5 is $10/$50', near(P('claude-fable-5', { input_tokens: M, output_tokens: M }), 60));
ok('Opus 5 is still $5/$25', near(P('claude-opus-5', { input_tokens: M, output_tokens: M }), 30));
ok('Opus 4.8 is $5/$25', near(P('claude-opus-4-8', { input_tokens: M, output_tokens: M }), 30));
ok('Haiku 5.5 is $0.10/$0.50 up to 100K prompt tokens',
   near(P('claude-haiku-5-5', { input_tokens: 100000, output_tokens: M }), 0.01 + 0.5));
ok('...and $0.50/$2.50 above it',
   near(P('claude-haiku-5-5', { input_tokens: 100001, output_tokens: M }), 100001 * 0.5 / M + 2.5));
ok('...where cached tokens count toward the prompt length',
   near(P('claude-haiku-5-5', { input_tokens: 1000, cache_read_input_tokens: 100000 }), 1000 * 0.5 / M + 100000 * 0.05 / M));
ok('...and its cache rates follow the card it is on (write 1.25x of $0.10)',
   near(P('claude-haiku-5-5', { cache_creation_input_tokens: 50000 }), 50000 * 0.125 / M));

/* ---------- cache rates are per model ---------- */
ok('Opus 5.5 reads cache at $0.20', near(P('claude-opus-5-5', { cache_read_input_tokens: M }), 0.2));
ok('Opus 5.5 5-minute write is $5', near(P('claude-opus-5-5', { cache_creation_input_tokens: M }), 5));
ok('Sonnet 5.5 reads cache at $0.10', near(P('claude-sonnet-5-5', { cache_read_input_tokens: M }), 0.1));
ok('Fable 5.2 reads at $0.20, writes $10', near(P('claude-fable-5-2', { cache_read_input_tokens: M, cache_creation_input_tokens: M }), 10.2));
ok('Fable 5.1 reads at $0.25', near(P('claude-fable-5-1', { cache_read_input_tokens: M }), 0.25));
ok('Fable 5 reads at $1', near(P('claude-fable-5', { cache_read_input_tokens: M }), 1));
ok('Opus 5 falls back to the 0.1x read', near(P('claude-opus-5', { cache_read_input_tokens: M }), 0.5));
const ttl = (five, hour) => ({ cache_creation_input_tokens: five + hour, cache_creation: { ephemeral_5m_input_tokens: five, ephemeral_1h_input_tokens: hour } });
ok('Fable 5.2 1-hour write is $16', near(P('claude-fable-5-2', ttl(0, M)), 16));
ok('Opus 5.5 splits by TTL: $5 + $8', near(P('claude-opus-5-5', ttl(M, M)), 13));
ok('Sonnet 5.5 1-hour write is $4', near(P('claude-sonnet-5-5', ttl(0, M)), 4));
ok('a model without its own rate writes 1 hour at 2x', near(P('claude-sonnet-5', ttl(0, M)), 4));

/* ---------- the advisor tool ---------- */
// Top-level usage is the executor's; each advisor_message iteration is billed
// at the advisor model's own rates, on top.
const advised = {
  input_tokens: 10000, output_tokens: 2000, cache_read_input_tokens: 0,
  iterations: [
    { type: 'message', input_tokens: 6000, output_tokens: 1200 },
    { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 20000, output_tokens: 1500, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 },
    { type: 'message', input_tokens: 4000, output_tokens: 800 },
    { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 60000 },
  ],
};
const exec = (10000 * 2 + 2000 * 10) / M;                                   // Sonnet 5.5 executor
const adv = (21000 * 4 + 2000 * 20 + 100000 * 0.2) / M;                     // Opus 5.5 advisor
ok('an advised call costs the executor plus the advisor at its own rates',
   near(P('claude-sonnet-5-5', advised), exec + adv), `${P('claude-sonnet-5-5', advised)} vs ${exec + adv}`);
const parts = identity.priceParts('claude-sonnet-5-5', advised);
ok('...split into its parts', near(parts.executorUsd, exec) && near(parts.advisorUsd, adv) && parts.advisor.calls === 2, JSON.stringify(parts));
ok('...and batch halves both', near(P('claude-sonnet-5-5', advised, true), (exec + adv) / 2));
ok('an advisor on an unknown model prices the call as null',
   P('claude-sonnet-5-5', { input_tokens: 1, iterations: [{ type: 'advisor_message', model: 'claude-future-9', input_tokens: 1 }] }) === null);
ok('an unknown executor is still null', P('claude-future-9', { input_tokens: 1 }) === null);
ok('a dated id is not guessed', P('claude-haiku-4-5-20251001', { input_tokens: 1 }) === null);
ok('batch still halves a plain call', near(P('claude-opus-5-5', { input_tokens: M, output_tokens: M }, true), 12));

// Search budgets are per tier: enough to finish the job when it is paid for.
const TIERS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };
const owner = identity.planFor({ admin: true }, TIERS);
const guest = identity.planFor({ email: 'a@b.co' }, TIERS);
ok('a paid plan gets a search budget that can finish a research answer', owner.maxUses >= 10, String(owner.maxUses));
ok('...and the free tier stays tight, because the allowance is real money', guest.maxUses <= 5, String(guest.maxUses));
ok('paid rides the better model', owner.model === 'claude-sonnet-5', owner.model);
ok('free rides the cheap one', guest.model === 'claude-haiku-4-5', guest.model);
// Haiku 400s on the newer search tool, so the two must move together.
ok('the search tool version matches the model', guest.webSearch.type === 'web_search_20250305', guest.webSearch.type);
ok('...and the modern one goes with Sonnet', owner.webSearch.type === 'web_search_20260209', owner.webSearch.type);
// An app that wants its own number still wins.
ok('an app can still override the budget',
   identity.planFor({ admin: true }, { ...TIERS, maxUses: 2 }).maxUses === 2);

/* ---------- metering must not stand between a caller and the SDK ---------- */
//
// The meter wraps client.messages.create. It used to be an `async` wrapper,
// which awaited the SDK's APIPromise and handed back an ordinary one - and
// `messages.stream()` is built on `this.create(...).withResponse()`, so
// metering a client silently broke streaming for every caller. The error named
// a method nobody here had written, on a line nobody here had touched.
(async () => {
  const meterOf = identity.create({
    store: { get: async () => null, set: async () => {}, add: async () => {}, list: async () => [] },
    secret: () => 'x'.repeat(20),
    app: 'test',
  }).meter;

  let charged = null;
  const usage = { input_tokens: 10, output_tokens: 5 };
  const apiPromise = () => {
    const p = Promise.resolve({ usage, content: [] });
    p.withResponse = () => Promise.resolve({ data: { usage }, response: {} });
    return p;
  };
  const client = {
    messages: {
      create: () => apiPromise(),
      stream: () => ({ finalMessage: async () => { charged = 'stream'; return { usage, content: [] }; } }),
    },
  };

  meterOf(client, { route: 'test' });
  const out = client.messages.create({ model: 'claude-sonnet-5' });
  ok('a metered create still returns what the SDK returned',
     typeof out.withResponse === 'function', typeof out.withResponse);
  ok('...and it still resolves to the message', Boolean((await out).usage));

  const s = client.messages.stream({ model: 'claude-sonnet-5' });
  ok('a metered client can still stream', typeof s.finalMessage === 'function');
  await s.finalMessage();
  ok('...and the streamed call is the one that got measured', charged === 'stream');

  // recordUsage charges the advisor part and says how much of it there was.
  const rows = [];
  const rec = identity.create({
    store: { get: async () => null, set: async () => {}, add: async (_c, r) => { rows.push(r); }, list: async () => [] },
    secret: () => 'x'.repeat(20),
    app: 'test',
  }).recordUsage;
  const row = await rec({ model: 'claude-sonnet-5-5', usage: advised, route: 't' });
  ok('recordUsage prices the advisor in', near(row.costUsd, exec + adv), String(row.costUsd));
  ok('...and records its share', row.advisorCalls === 2 && near(row.advisorUsd, adv) && row.advisorModels[0] === 'claude-opus-5-5');
  const plain = await rec({ model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 1 }, route: 't' });
  ok('...and a plain call carries no advisor fields', !('advisorCalls' in plain));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
