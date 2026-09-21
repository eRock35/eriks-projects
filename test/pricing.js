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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
