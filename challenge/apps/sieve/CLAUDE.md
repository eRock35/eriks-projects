# For Claude: Sieve

Tune your agent's guardrails until nothing leaks - and nothing legit gets
blocked. For engineers, security and platform people shipping internal or
customer-facing AI agents at small and mid-size companies.

- **Rules** (the guardrail being tested): twelve built-in detectors, each
  switchable and tunable - email; phone (NANP formats and E.164, or "any run
  of digits"); payment card (13-19 digits, separators, an optional **Luhn
  check**, line breaks optional); IBAN with **mod-97**; US SSN (dashes, or
  any one separator used twice; the impossible ranges 000, 666, 9xx, group 00
  and serial 0000 skipped); AWS access key ids; GitHub, Slack and Stripe-style
  live keys; private key blocks; JWTs whose header decodes to JSON with
  "alg"; IPv4 (private and documentation ranges optional). Options where they
  make sense: word boundaries, context words within N characters, a minimum
  length. Custom rules (a JavaScript regex, or a keyword list), an
  **allow-list** that wins over everything, and per rule an action (**redact**
  to `[REDACTED:<rule>]`, **block** the whole message, **flag** and let it
  through) and a direction (input to the agent, output from it, or both).
  A **normaliser** (NFKC, zero-width and direction characters removed,
  Cyrillic/Greek look-alikes folded, plus optional %-escape and base64
  decoding) runs before the rules.
- **Test cases**: text, direction, and the expected outcome - **pass**
  untouched, **redact** (the sensitive spans marked: select text, Mark), or
  **block**. Written, pasted, imported (CSV, JSONL, JSON) and exported.
- **Run and score**, re-run on every change (debounced): **Leak** (a
  sensitive span got through), **Partial** (some of the spans, or redacted
  when it should have been blocked), **Break** (legit text blocked or
  redacted), **Correct**. "Leaks 3 · Breaks 5 · 32 correct of 40", per-rule
  counts (which rule caused each break, which spans no rule caught),
  precision and recall per kind, a side-by-side for each case, and a chart of
  leaks and breaks over the last 20 runs.
- **Suggested fixes**, each simulated against the whole set before it is
  shown, one tap to apply: "Turn on the Luhn check for cards: 4111-2222-3333-4444
  fails it · −2 breaks, no new leaks". "Apply every safe fix" applies the best
  one again and again.
- **Attack my rules**: ten evasion tricks on every sensitive case the rules
  catch now, and what survives - with the normaliser, and with decoding.
  The survivors can be added to the test set with one toggle.
- **Export**: the rule set as JSON (round-trips through import), a Markdown
  report of the run (values masked and shortened), the test set as JSONL or
  CSV (formula-safe).
- **Signed in (free)**: the rule set follows the account. Never a test case.
- **Metered AI**: "Write tricky test cases".

Built 2026-11-01 as a **business** drop: Haul (2026-10-31, the Halloween
drop) was everyday, so today was the other kind. **Staging only**: no custom
domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/sieve`,
served at `challenge.strongtechnicalconsulting.com/sieve/`, data in `sieve_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

Inspired by the Friction problem titled **"Enterprise agent guardrails
either leak data or break the agent"** (title only).

- **Guardrails are usually a pile of regexes nobody measures.** Someone
  writes "13 to 19 digits is a card" on day one, it ships, and nobody can say
  what it catches or what it breaks.
- **Too loose, and something leaks**: a card number, an API key in a stack
  trace the output filter never reads, an SSN typed with spaces, a token
  with zero-width characters in it.
- **Too tight, and the agent breaks**: it refuses an order number that looks
  like a card, redacts a tracking number as a phone, hides the support
  team's own address from the customer.
- **The only way out is a labelled test set and a score, re-run on every
  change.** That is what Sieve is: on the device, free, in a minute.

Not a repeat: **Leash** (2026-09-30) maps what an agent's tools and
permissions can do (blast radius, a charter); **Proof** (2026-10-25) checks an
agent's claims against its own logs. Neither touches the filters on the text
going in and out. **Canon** checks SQL against metric definitions and
suggests a fix as a diff; Sieve borrowed that "deterministic checker plus a
previewed fix" shape and nothing else.

**Who pays.** Almost nobody. Rules, the demo, test cases, every run, the
attack, every export and keeping it on the device are free, need no account
and make no request. A free account keeps the rule set across devices. The
one metered thing (Haiku for the free tier, Sonnet for members via
`identity.planFor`) costs about a cent.

**How it becomes an iPhone app.** Not for writing regexes on a phone: for
reviewing a run - the score, the leaks and breaks, a case side by side, and a
suggested fix applied with one thumb - and for the chart. The core is one
dependency-free UMD file that a CI step could run as is against a rule set
and a JSONL test set.

## The decisions that matter

- **No test case, rule match or input text ever reaches the server or a
  model.** Test cases can hold real secrets and personal data.
  `public/sieve-core.js` (UMD: `window.SieveCore` in the page,
  `importScripts` in `public/sieve-worker.js`, `require` in the server and
  tests) holds every rule. There is **no route that takes a case**
  (`/api/run`, `/api/check`, `/api/cases`, `/api/scan`, `/api/score`,
  `/api/attack`, `/api/report`, `/api/upload` are 404s, tested); the page's
  requests are listed by the test (`api/me`, `api/rules`, `api/ai/cases`, the
  auth and billing routes); the core, the demo and the worker contain no
  `fetch`, no storage, no clock and no dice (tested).
- **User regexes run only in the worker, under a watchdog.** `sieve-runner.js`
  sends one job at a time; the worker says `{begin: key}` before a user
  pattern runs over the set and `{end}` after. A pattern still running after
  `LIMITS.ruleMs` (1.5 s) has the worker **terminated** (the only way to stop
  a regex mid-match), is recorded as timed out **by name**, a fresh worker
  gets the cases again and the same job re-runs with it skipped. It stays
  skipped until its source changes ("try it again" clears it). A whole job
  past `runMs` (20 s) is refused. The page warns before running a pattern
  with a repeat inside a repeat (`riskyRegex`). Without a Worker the page
  runs the built-ins and keyword lists and **skips user regexes** (said in a
  notice). The server compiles regexes to check the syntax and never runs
  one. The test drives the real worker in a `worker_threads` thread and
  stops `(a+)+$` on 36 a's in well under a second.
- **The built-in detectors are bounded** (every repeat capped), so none can
  backtrack through an 8 KB message (tested on hostile texts). Matches per
  case per rule are capped at 200. Cases: 2,000 a set, 8 KB (UTF-8) each.
- **Matching** happens on the normalised text; every normalised character
  remembers which original characters it came from, so a match is reported
  and redacted on the text as it arrived. The base64 step adds the decoded
  text beside a run rather than replacing it (a JWT's parts are base64 too)
  and never decodes a dotted token's part.
- **The guardrail**: block beats redact beats flag; a detection that
  overlaps an allow-list match is dropped. Matches are cached per rule by
  what they depend on (matching options and the normaliser, never action or
  direction), so changing an action re-scores without re-matching, and a
  suggestion that touches one detector re-matches only that one.
- **Scoring** (`compare`): a span is caught when the redactions cover every
  character of it but separators at its edges; a blocked message catches
  everything. Expect pass: redacted or blocked is a Break. Expect redact:
  blocked is a Break; none caught a Leak; some caught a Partial; all caught
  but something else redacted a Break. Expect block: blocked is Correct,
  through untouched a Leak, redacted a Partial (or a Leak if the redaction
  missed the spans). Precision is per rule kind over its detections;
  recall per kind over the marked spans, each span's kind found by the
  detectors (`classify`).
- **Suggested fixes** (`candidates`, `suggest`): built from the failures -
  Luhn / mod-97 / impossible-SSN checks for a break on text that fails them,
  strict phone formats, word boundaries, context words, an allow-list entry
  for an id like `ORD-8812004410093317` (letters as written, digits counted,
  every length seen), the support address, redact-instead-of-block; and for
  leaks, a detector that is off (grouped: "Turn on the 3 detectors that are
  off"), the other direction, an option that would catch it, the normaliser.
  Each is **simulated against the whole set**; only changes that add **no
  new leak** are shown, ranked by what they fix (broad ones like context
  words carry a penalty), with the effect in words.
- **The demo** (`public/demo.js`): a made-up **Juniper Outfitters** support
  agent with the guardrail people ship on day one (Luhn off, "any run of
  digits is a phone", SSNs with dashes only, the AWS rule on input only, no
  IBAN, JWT or private-key rule, no normaliser) and 40 labelled messages. It
  scores **Leaks 6 · Partial 1 · Breaks 8 · 25 correct of 40**:

  | Case | Shows | Fixed by |
  |---|---|---|
  | j01, j07 | an order number and a serial in card format | the Luhn check |
  | j04-j06 | `ORD-` ids whose digits pass Luhn by chance | allow-list `ORD-\d{16}` |
  | j02 | a FedEx tracking number taken for a phone | NANP and E.164 formats |
  | j03, j08 | the support team's own address redacted | an allow-list entry |
  | j28 | an SSN typed with spaces (the address is caught: Partial) | spaces and dots in SSNs |
  | j30 | AWS's example key in a stack trace in the output | check output too |
  | j31, j32, j33 | a JWT in a log line, an IBAN, a private key block | turn on the 3 detectors |
  | j34, j35 | full-width digits, a zero-width Slack token | the normaliser |

  Eight taps (or "Apply every safe fix") reach **0 and 0**; the test holds
  every outcome and every step, and that every demo value passes the same
  fake-value check the AI's output must. The first-run screen offers **Try
  the demo** (one tap to a scored run, with a hint on the first Break that
  opens its side-by-side and its Luhn fix) or **Start with my own rules**.
  At 0/0 the score offers **Attack my rules**.
- **Every value is obviously fake**: Visa's test number, AWS's documented
  `AKIAIOSFODNN7EXAMPLE`, example.com/.org/.net addresses (built from
  `String.fromCharCode(64)` - no file carries an address, tested), 555-01xx
  phones, the published example IBANs, retired example SSNs, keys with
  EXAMPLE in them, order ids starting 88 (no card network issues those).

## Attack my rules (`variantsOf`, `attack`)

From each sensitive case that is **Correct now** (not the trick cases
themselves), its first span rewritten each way that fits: digits spaced out,
dashed in threes, full-width, zero-width characters between every
character, Cyrillic/Greek look-alikes, base64 (with a hint), split across
two lines, URL-encoded, reversed (with a "read it backwards" hint), written as
words. Each variant keeps the case's label and carries its spans. They are
run three times - the rules as set, with the basic normaliser, with decoding
too - so the page can say what each step buys. On the demo after its fixes:
full-width, zero-width and look-alikes are all caught; base64 and %-escapes
get through until decoding is on; words, reversed and split survive
everything, which is the honest point (block on the output side, or keep
secrets out of the agent's reach). The survivors toggle adds them as
ordinary cases (`src: 'attack'`) and takes them out again.

## Storage: opt-in, and the rule set only in the account

- **Rules, cases and the chart** touch the browser's storage only when "Keep
  this on this device" is ticked (off by default, with Clear) - `sieve-v1`,
  both workspaces (demo and own). A set too big for the browser's quota keeps
  the rules and the chart. Every access is wrapped in try/catch (tested:
  three accesses, all wrapped).
- **Lab database**: `sieve_rules/<owner tag>` = `{owner, rules, updatedAt}`
  and nothing else (tested). The tag is an HMAC of the account id under a key
  derived from `IDENTITY_SESSION_SECRET` ("sieve owner v1"). `PUT /api/rules
  {rules, base}` saves in a transaction only if `base` is the account copy
  this device last saw, else **409 with the account copy**; the page offers
  **Merge them** (`mergeRules`: this device's settings plus the custom and
  allow-list rules only the account has), **Use the account's copy** or
  **Keep this device's**. Only the own workspace syncs; the demo never does.
  `cleanRules(strict)` refuses the whole body (400, nothing saved) for
  unknown fields (a `cases` field included), oversize lists, a regex that
  does not compile, and **any string - a name, a pattern, a keyword, a
  context word - in which the detectors find a secret or an id**: a
  Luhn-valid card, a mod-97 IBAN, a possible SSN (dashed or nine bare
  digits), an AWS, GitHub, Slack or Stripe key, a private key, a JWT. Contact
  details are allowed: an allow-list needs the support address. No secret:
  503, and the rules stay on the device. No query anywhere.

## The model call (metered): "Write tricky test cases"

`requireUser, requireBudget, requireDailyCap` **then** the route's own 4 KB
parser (401 / 402 / 403 / 503 before it, never 413 - tested), then the body
rebuilt by `aiRequest` - `{category, about}` and nothing else; category one
of `cards`, `govid`, `keys`, `contact`, `lookalike`; `about` at most 160
characters and **refused if any built-in detector finds anything in it**
(after deep normalisation, so full-width digits do not slip past; a 400
`data-in-description` with no model call, checked on the page too). One
forced tool (`write_cases`) through **one call site** (`ai.ask`). The
description is fenced (`<<<AGENT`) as untrusted. Back: up to 20 cases;
`cleanAiCases` keeps a case only if its sensitive parts are really in its
text, it carries no markup, and **`realLooking` finds nothing that could be
real**: a card candidate that passes Luhn, starts 1-6 (the card networks'
range) and is not a documented test number; an IBAN that passes mod-97 and is
not a documented example; a possible SSN outside the impossible ranges and
the retired examples; an AWS key without EXAMPLE; another key or token
without EXAMPLE/FAKE/TEST/a run of one character; a long private key without
a fake marker; a JWT with a real-looking signature or payload; an address
outside example.com/.org/.net (or .example/.test/.invalid); a phone outside
555-01xx; a public IP next to words that make it one. What is dropped is
counted and said. The page shows the rest as a proposal labelled **"AI-written
- check the labels"**, each ticked, added only on a tap. Nothing stored,
nothing logged. Signed out, the sheet says what it costs and offers a free
account; 402 opens the credit sheet; 403 `verify-email` shows its sentence and
"Send the link again"; sheets size themselves below the confirm-your-email
banner.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8143/sieve/
npm test        # the rules, the worker in a thread, the page, then HTTP under a /sieve mount
```

`SIEVE_MEMORY=1` and `SIEVE_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `SIEVE_COLLECTION_PREFIX` (`sieve_`
from the lab host) prefixes every collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that does not
force a tool, keeps every request (`fakeClient.calls`), answers each category
with a clean set, and takes `fakeClient.mode` (`blank`, `inject`,
`maxtokens`, `upstream401`, `upstream529`) for one call.

`test/run.js` (26 tests): every detector (true positives, near misses, Luhn,
mod-97, the SSN ranges, the JWT header check, phones never stopping inside a
longer number), hostile 8 KB texts against every detector; the normaliser and
its offset map; the guardrail (actions, directions, the allow-list winning);
the score (leak, partial, break, correct, span by span; per-rule breaks;
precision and recall); suggested fixes and their previewed effect (and one
that would add a leak never offered); **the demo's 40 outcomes, its eight
fixes and 0/0**; the evasion pack; import (CSV with offsets or substrings,
JSONL, JSON, caps, problems), export round trips (JSONL, CSV, rule set),
CSV injection, the Markdown report with every value masked; strict rule-set
cleaning and merge; the AI request and the fake-value checks; **the real
worker in a worker thread, with `(a+)+$` stopped by the watchdog, named and
skipped while the rest scores**; contrast in both themes and the lab card;
the page's promises (no inline script, storage opt-in and wrapped, no eval,
every user string escaped, the service worker); the local switches; and over
HTTP: signed out with zero model calls and 401 before every parser, no route
that takes a case, the gate order, one model call site, rule sync (409,
secrets and test data refused, nothing identifying stored), the AI route
(descriptions with data refused before any call, hostile output reduced to
its one clean case, provider errors not passed on) and the 401 / 402 / 403 /
503 gates.

Screenshots at 390px and 1280px, light and dark - first run, the demo's first
scored run with the hint, a Break, a Leak and a Partial side by side, the
rules panel with a suggested fix, Attack my rules before and after the
normaliser, the run after the fixes (0/0) with the chart, the survivors,
the survivors added, exports, own rules from an empty start through an
imported test set, a timed-out regex (the rule and the notice), the AI sheet
signed out, signed in and its proposal, a description with an address
refused, the case editor finding likely spans, the rules synced - and a
hostile pass (markup, bidi, 8 KB cases, evil regexes; nothing injected, no
dialog, no CSP violation) were taken with Playwright.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, the worker, the
runner, the service worker. Signed in, free: `GET|PUT|DELETE /api/rules`.
Metered: `POST /api/ai/cases`. The shared account at `/api/auth`.

## Ideas not built yet

- **A CLI / CI step**: run `sieve-core.js` against an exported rule set and a
  JSONL test set in CI and fail the build on a new leak or break.
- **Export to a guardrail framework's format** (a Presidio recognizer list, a
  NeMo Guardrails rail, an LLM gateway's regex list) - each its own
  converter, and only once someone asks.
- **More detectors**: national ids beyond the US, passport numbers, crypto
  wallet addresses, more vendors' keys (Google, OpenAI-style).
- **A semantic check** (a small classifier for "is this a password?") - would
  need a model call per message, which this app deliberately never makes.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; no eval or
  `new Function` (`new RegExp` is how a user pattern becomes a regex); the
  worker is a same-origin file; clicks by one `data-act` listener (tested
  here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; every metered and rules
  parser runs after its gates.
- Case text, file contents, typed rules, the server's answers and the model's
  answers are untrusted: escaped on render (`esc`, or `vis`/`paint`, which
  escape every character and draw zero-width and bidi characters as visible
  marks so they can never reorder or hide anything on screen; the test cuts
  out every escaping call and fails on any user field still concatenated into
  markup), bounded, and cleaned. Exports defuse `= + - @` (and tab or
  carriage return) with a leading `'` (undone on import) and quote per
  RFC 4180. The Markdown report escapes Markdown and masks every value.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
