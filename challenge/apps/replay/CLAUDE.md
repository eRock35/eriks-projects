# For Claude: Replay

Every automated decision, recorded well enough to replay - and explain. For
**risk, compliance and engineering teams at lenders, fintechs and fraud
teams** that let an AI model or a scoring system approve, decline, refer or
flag.

- **Load a decision log**: JSON Lines, a JSON array (or records wrapped in an
  object) or CSV, read in a Web Worker on the device. Nested keys become dot
  paths. Replay **guesses which key is which field** (decision id, time, case
  id, outcome, score, model and its version, prompt and its version or hash,
  temperature, seed, inputs or their hash, tool calls, reason codes, policy
  rules, reviewer, override and why, previous hash, hash) from the key names
  and the SHAPE of the values, and the person confirms it before anything is
  checked.
- **The checks**, each with counts, the exact records and a plain sentence,
  most serious first: completeness against a **must-record profile** (and the
  share of records that can be replayed in full); adverse outcomes with no
  reasons, too many, or codes not on the team's list; temperature above 0 and
  missing seeds; **the same inputs giving different outcomes**; **version
  drift** against a pasted change log; the **SHA-256 hash chain** link by link
  with the first broken link named, plus gaps in numbered ids, duplicate ids
  and out-of-order times; overrides with no reviewer or reason, and rates by
  reviewer; **time gaps** at normally busy hours.
- **Replay pack** for any one decision: one page - what went in, which model
  and prompt, the parameters, tool calls, the outcome and score, the reasons
  in words, who reviewed and overrode it, the chain proof, and "what is
  missing to replay this". Markdown and JSON, case id masked by default.
- **Sampling**: a reproducible review sample, stratified by outcome and
  model (and prompt) version, from a seed that is shown and reusable; a CSV
  of ids.
- **Exports**: the findings report (Markdown, case ids masked by default), a
  flagged-records CSV, the replay packs, the sample. Formula-safe.
- **Signed in (free)**: checking settings follow the account - never a
  decision.
- **Metered AI**: "Help me map these fields" - key names and shape codes
  only.

Built 2026-11-07 as a **business** drop: Chapter (2026-11-06) was everyday,
so today was the other kind. **Staging only**: no custom domain until Erik
decides it is worth one. **A starting checklist, not legal advice** - said
on the page, in every export and in every replay pack. Regulations are named
only generically ("adverse-action notices", "model risk management").

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/replay`,
served at `challenge.strongtechnicalconsulting.com/replay/`, data in
`replay_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

Inspired by the Friction problem titled **"LLMs making lending/fraud
decisions that must be auditable and replayable"** (named by title only).

- **The question always comes after the fact.** An examiner, an auditor or a
  customer asks "why was this declined?" - weeks later.
- **And that is when teams find out what the log never kept**: the model
  version, the prompt version, the inputs (or a hash of them), the reasons,
  who overrode it - or that nothing proves the log was not edited since.
- **A checker that says exactly what is missing, record by record**, and
  builds the one-page answer for a single decision, is useful on day one -
  before the next question, not during it.
- **It runs on the device because decision logs hold customer data.**

**Not a repeat.** **Proof** checks a coding agent's claims against its own
logs; **Leash** maps what an agent is allowed to do; **Sieve** tunes
guardrail filters; **Canon** keeps metric definitions straight. Replay is
the record-keeping of automated decisions in lending and fraud: whether a
decision log can answer for each decision, and the answer for one.

**Who pays.** Almost nobody. The demo, reading a log, every check, the hash
chain, the packs, the sample and every export are free, need no account and
make no request. A free account keeps checking settings across devices. The
one metered thing (Haiku for the free tier, Sonnet for members via
`identity.planFor`) costs about a cent.

**How it becomes an iPhone app.** Not for 100,000-record logs: for the risk
lead who is asked about one decision in a meeting - open last month's
export from Files, search the id, show the replay pack. The core is one
dependency-free UMD file a team's own pipeline could run as is (a nightly
"is yesterday's log replayable?" check).

## The decisions that matter

- **No record, case id, input, score or hash ever reaches the server or a
  model.** `public/replay-core.js` (UMD: `window.ReplayCore` in the page,
  `importScripts` in `public/replay-worker.js`, `require` in the server and
  tests) holds every rule. There is **no route that takes a log**
  (`/api/upload`, `/api/check`, `/api/analyze`, `/api/records`,
  `/api/verify`, `/api/log`, `/api/decisions`, `/api/pack`, `/api/sample`,
  `/api/report`, `/api/hash` are 404s, tested); the page's requests are
  listed by the test (`api/me`, `api/settings`, `api/ai/fields`, the auth
  and billing routes); the core, the demo and the worker contain no `fetch`,
  no storage, no clock and no dice (tested). **The pasted change log is
  never stored or synced** - not even with "keep my settings".
- **SHA-256 is handed in.** The core never hashes by itself
  (`createEngine({digest})`): the page and the worker pass SubtleCrypto
  (`crypto.subtle.digest`), the tests node:crypto - over the same canonical
  form, built once in the core. The worker-thread test proves the two agree
  on every hash. SubtleCrypto needs a secure page (https or localhost); on
  anything else the page says so instead of guessing.
- **The worker** reads the File itself as bytes, keeps each loaded log and
  answers `load`, `analyze` (posting hashing progress), `pack`, `find`,
  `sample`, `flagged`, `drop` - `ReplayCore.createEngine()`. Without a
  Worker the page runs the same engine itself. Caps, said in words on the
  page: **20 MB a file** (refused before it is read), **100,000 records**
  (the rest counted, a finding says so), 400 key paths, objects wider than 60
  keys read as one value (a map keyed by ids would otherwise make every id a
  key). A 20 MB, 42,000-record hash-chained log is checked in about a second
  in Node; in Chromium the hashing is batched 1,000 at a time.
- **Reading** (`parseLog`): a leading `[` is a JSON array; a leading `{` is
  JSON Lines if the first line parses alone, else one JSON object whose array
  of records (`records`, `decisions`, `events`, ... or the first array of
  objects) is used; anything else is CSV with its delimiter sniffed and RFC
  4180 quoting, header names deduplicated, and a row of the wrong width
  **unreadable** (never misaligned). Unreadable lines are a finding with
  their line numbers. UTF-8 (with or without a byte-order mark) and UTF-16
  with one; a workbook, PDF, gzip or binary file is refused with what to do.
- **Paths** (`getPath`): a key that itself holds a dot (`model.version` as a
  CSV header) is found as it is, otherwise the path is walked; own
  properties only, so `__proto__` in a file is just a key.

### Shapes and the field guess

`SHAPES` is a fixed list of 25 codes (no digit in any code) describing
values - "ISO date-times", "long hex strings, like a SHA-256 hash", "words
like approve, decline, refer or flag", "lists of short codes", "a nested
object"... - computed from up to 300 values per key. They are what the AI
helper is told, and half of the guess.

`guessFields`: name rules over the normalised path (camelCase, dots and
underscores to words; best match counts, a penalty rule on top: the id rule
does not want `model.id`, the hash rule does not want `prev_hash` or
`inputs_hash`, the score rule does not want anything under the inputs) plus
shape points. Inputs and tool-call objects are placed first and **nothing
inside them is offered for another field**. Each key once, each field once;
sure / likely / unsure. A field with no name match but exactly one key whose
values can only be it (dates for time, outcome words, a unique hex column
for the hash, code lists for reasons) is placed **unsure**. The demo is
placed exactly; an awkward nested export (`evt.uuid`, `evt.at` epoch
seconds, `result.label`, `engine.rev`, `audit.parent`) and a CSV with
"Timestamp (UTC)" and "Inputs SHA256" headers are placed sensibly (tested).
**Presets**: key names a team saves; a log with four in five of a preset's
keys picks it up at once.

## The checks (`analyze`)

The must-record profile (Settings) defaults to: decision id, time, model id,
model version, prompt version or hash, **inputs or their hash**, outcome -
and, when they apply, reasons on adverse outcomes and a reviewer on every
override. A required field the log has **no key for** is one critical
finding (`unmapped`), not one per record, and no record counts as
replayable without it. **Fully replayable** = readable, nothing the profile
asks for missing, and deterministic under the policy.

- **Adverse outcomes** (default: decline; the team picks any of approve /
  decline / refer / flag; its own outcome words map "DCLN" to decline):
  with no reason codes (empty or missing - critical), more than the maximum
  (default 4 - medium, "check your policy"), codes not on the team's
  reason-code list (high - no words to give the customer). With no list, an
  info finding asks for one. Outcomes Replay cannot place are named.
- **Determinism**: temperature above 0 when the policy says 0 (with the
  share and the temperatures seen); no seed when the policy requires one;
  **the same inputs, different outcomes** - grouped by inputs hash, else by
  the canonical inputs snapshot - high when under the same model and prompt
  versions with no override, medium when a version change or an override
  explains it.
- **Version drift**: per model and prompt version, decisions and first /
  last use, and every change in time order (versions running side by side,
  like a canary, are told apart from a change). With a pasted change log
  (`date, version, approver` a line, `versionMatches` on whole tokens), a
  version with **no entry** is high, one used **before its approval date**
  medium, an entry with no approver low. With none, an info finding asks for
  it.
- **The hash chain** - see below - plus **numbered ids with numbers missing**
  (when 90% of ids share a prefix and the numbers are dense), **duplicate
  ids**, **records dated before the one above** (a whole file newest-first is
  not out of order).
- **Overrides**: by reviewer (overrode N of M, rate) and by final outcome;
  overrides with **no reviewer** (high) or **no reason** (medium - or "no
  field for why"); a reviewer overriding at least twice the team's rate with
  10+ reviews and 3+ overrides (info, "not wrong in itself").
- **Time gaps**: the usual volume per hour of day, weekdays and weekends
  apart, in the log's own clock (its most common UTC offset); a quiet stretch
  of 30+ minutes is flagged when the usual volume would have put **3 or more**
  decisions in it - seeing none then happens by chance about e^-3 (5%) of
  the time or less, which the sentence says ("about 3%"). Logs under 50 timed
  records or 2 days long are skipped. The finding draws that day hour by
  hour against a usual day.

### The hash recipe (exact)

For each record, in file order:

```
input = prev + "\n" + body            (prevInInput: on, the default)
input = body                          (prevInInput: off)
hash  = lowercase hex SHA-256 of the UTF-8 bytes of input
```

- `prev` is the record's previous-hash field **as written** (when one is
  mapped), else the previous record's own hash as written, else the empty
  string; null is the empty string.
- `body`, **canonical JSON** (the default): the record without its own hash
  field (removed at its dot path), keys sorted by UTF-16 code units at every
  level, no whitespace, strings and numbers exactly as `JSON.stringify`
  writes them (the rules of RFC 8785, JCS), undefined members left out,
  undefined in an array as null. The previous-hash field stays in.
- `body`, **the raw line**: the JSON line exactly as written, with the hash
  member removed **as text** - the member, and the comma that joined it to
  the one before (or after, when it is first) - only a top-level key; a CSV
  row exactly as written without the hash cell and one delimiter. A JSON
  array has no lines, so it is always canonical (said so). A nested hash key
  with the raw recipe is a finding saying to switch.
- A stored hash is read as 64 hex characters (any case, optionally after
  `sha256:`) or as base64 / base64url of the 32 bytes.
- Other writers: Python's `json.dumps(obj, sort_keys=True,
  separators=(",", ":"), ensure_ascii=False)` gives the same canonical text
  except for floats with nothing after the point (Python writes `1.0`,
  JavaScript `1`) and keys outside the Basic Multilingual Plane (sorted by
  code point rather than UTF-16 unit); a team whose writer does that, or
  hashes the text it writes, should use the raw-line recipe.

Each record: `ok` (matches), `changed` (does not - **edited after it was
hashed**), `nohash`, `badformat`. Each previous-hash: equal to the hash of
the record above (`ok`), the first record (`genesis` for empty/zeros,
`starts-mid` otherwise), or `broken` - **missing** (it points at a hash not in
this log: records removed before it) or **reordered** (it points at another
record here). **A recipe mismatch is never called tampering**: with 5+
readable hashes and none matching, the one finding is `chain-scheme` ("try
the other recipe"), with Replay's and the log's hash for the first record.
The first broken link is named, how many records before it check out, and
whether the chain picks up again after it (edited in place, not inserted or
removed). The snippet on the page ("How the hashes are checked - and how to
add them", `HASH_SNIPPET`) is a Node writer that produces exactly this; the
test runs it and verifies its output.

## The replay pack, the sample, the exports

- **The pack** (`pack`): the decision, when (in its own offset), the case
  id (masked unless untoggled), outcome and score, model and prompt with
  versions, temperature and seed, inputs hash, tool calls, the inputs
  snapshot, reasons with their words (a code not on the list says so),
  policy rules, reviewer / override / why, the proof (stored, computed and
  previous hash, the link, the recipe), and **what is missing to replay it**
  (profile gaps, non-determinism, unknown codes, a changed hash, a broken
  link, no hash). "The answer, in words" drafts the sentence ("Declined on
  ... by ... The reasons recorded: ...") - a starting point, not legal
  advice; a changed record carries a warning that the answer is unproven.
  Markdown (`packMarkdown`) and JSON (`packJson`), the inputs snapshot
  optional (it is customer data). Print uses a print stylesheet.
- **The sample** (`sample`): groups by the chosen strata (outcome, model
  version, prompt version), at least one from every group when there is
  room, the rest proportional (largest remainder), each group shuffled by a
  generator seeded from the seed and the group's name (FNV-1a into
  mulberry32 - for reproducibility, never for proof). The same log, seed and
  choices give the same sample on any device. The page makes a seed like
  "cedar-41"; the CSV's first line records it.
- **Exports**: the findings report (`reportMarkdown`: the summary, every
  finding with up to 50 records, version history with the change log, overrides
  by reviewer, how it was checked; Markdown-escaped; case ids masked by
  default), the flagged-records CSV (`flaggedCsv`: every record behind every
  finding), the packs, the sample. Every CSV cell is **formula-safe** (a
  leading `=` `+` `-` `@`, tab or CR gets an apostrophe) and quoted when it
  needs it.

## The demo (`public/demo.js`)

**Riverton Small Business Lending** - made up, said so on the card, the
strip and in the file - October 2026: 400 automated credit and fraud
decisions on small-business loan applications (weekdays 08:00-18:00,
UTC-05:00), pseudonymous case ids (`APP-MXJB`), invented businesses,
reviewer handles (`u.alder`), model `riverton-underwriter` 2.4.0 then 2.5.0,
prompt `sb-credit-memo` 3.1 then 3.2, inputs snapshots with their SHA-256,
tool calls, reason codes R01-R10 and F01-F04 with plain words, and a hash
chain in Replay's own recipe. Built from a seeded generator, so the same
every run. Planted, and nothing else (tested: the finding keys equal
`D.PLANTED`):

| Planted | Finding |
|---|---|
| RVT-D-0212, a decline, edited to approve after it was hashed | `chain-changed` (critical): 211 before it check out, the chain picks up after it |
| 11 declines with no reason codes (7 as `[]`, 4 with no key) | `adverse-none` (critical), and in `incomplete` |
| Prompt 3.1 -> 3.2 on Wed 14 Oct, no change-log entry (2.4.0 and 2.5.0 have one) | `drift-unlogged` (high) |
| 12 calls (3%) at temperature 0.7 | `temperature` (high) |
| 4 overrides with no reviewer | `override-noreviewer` (high), and in `incomplete` |
| Nothing logged Tue 20 Oct 10:03-12:05 | `gap` (medium): about 3.5 expected, "about 3%" by chance |
| RVT-D-0318 and RVT-D-0352: identical inputs, approve and refer, same versions | `same-inputs` (high) |

373 of 400 (93%) fully replayable; 399 of 400 hashes verified. The planted
sets do not overlap, so each number means one thing. The first-run screen:
two lines on the job, **Try the demo** (one tap to the report, with a "Start
here" hint on the broken chain, which pulses and is open) and **Check my
log** ("Read on this device, never uploaded"), the demo card, how it works,
a drop zone and what it checks. The demo always checks against its own
reason-code list; the change log is filled in with its three lines.

## Storage: opt-in, settings only

- **This device**: nothing is stored unless "Keep my settings on this
  device" is ticked (Settings, off by default, with Clear) - and then only
  the settings and whether the hint was dismissed. **Never a log, a record,
  a case id or a change log**, even with it ticked. Three wrapped
  localStorage accesses (tested).
- **Lab database**: `replay_settings/<owner tag>` = `{owner, settings,
  updatedAt}` and nothing else (tested). The tag is an HMAC of the account id
  under a key derived from `IDENTITY_SESSION_SECRET` ("replay owner v1").
  `PUT /api/settings {settings, base}` saves in a transaction only if `base`
  is the account copy this device last saw, else **409 with the account
  copy**; the page offers Merge them (`mergeSettings`: every reason code,
  outcome word and preset from both, this device's winning one both name),
  Use the account's copy, or Keep this device's. `cleanSettings(strict)`
  refuses the whole body (400, nothing saved) for unknown fields anywhere
  (`records`, `changeLog`, a case id on a code...), lists over their limits,
  and **anything that looks like a record** in a code, its words, an outcome
  word, a preset name or a preset key path (`looksLikeData`): an `@`, a run
  of 5+ digits, 8+ digits with spaces or dashes between, a hash-like hex run
  (16+, or 12+ mixing digits and a-f), a currency amount, a date, markup,
  invisible characters. Settings: required fields, the when-it-applies rules,
  adverse outcomes, the most reasons, reason codes `{code, text}` (200),
  outcome words (40), determinism, the recipe, previous hash on/off, presets
  `{name, map}` (10). No secret: 503, and they stay on the device. No query
  anywhere.

## The model call (metered): "Help me map these fields"

`requireUser, requireBudget, requireDailyCap` **then** the route's own 24 KB
parser (401 / 402 / 403 / 503 before it, never 413 - tested), then the body
rebuilt by `keysRequest` - `{keys: [{path, shape}]}` and nothing else, up to
120 keys and 6 codes each. The page builds it with `keysPayload`: each key
path (one that looks like a value - an `@`, four digits in a row, a hash-like
run, a date, a UUID, markup - is sent as "key N") and its shape codes.
**The server refuses** an unknown field (`sample`, `values`, `records`), a
path with an `@`, 5+ digits, a hash-like run, a date or markup
(`value-in-key`), a shape code not on the list (`unknown-shape`) - 400, no
model call. The sheet shows the table of names and shapes and **exactly the
JSON** before the tap. One forced tool (`map_fields`) through **one call
site** (`ai.ask`); the names are fenced (`<<<KEYS`) as untrusted. Back:
`cleanMapping` keeps known fields mapped to real keys, each key once and each
field (but `ignore`) once, a confidence from the list (else low), and a note
with markup and links removed. The page applies it as a proposal ("AI ·
high" badges) on the Fields tab; nothing runs until the person runs the
checks. Signed out the sheet still shows what would be sent and offers a
free account; 402 opens the credit sheet; 403 `verify-email` shows its
sentence and "Send the link again"; sheets size themselves below the
confirm-your-email banner. Nothing stored, nothing logged.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8162/replay/
npm test        # reading, shapes, the guess, every check, the chain, packs, sample, exports, the demo, hostile files, the worker in a thread, the page, then HTTP under a /replay mount
```

`REPLAY_MEMORY=1` and `REPLAY_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `REPLAY_COLLECTION_PREFIX`
(`replay_` from the lab host) prefixes every collection. `npm test` runs
with `REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that
does not force a tool, keeps every request (`fakeClient.calls`), maps keys
from their names and shapes deterministically, and takes `fakeClient.mode`
(`blank`, `inject`, `maxtokens`, `upstream401`, `upstream529`) for one call.

`test/run.js` (32 tests): reading (JSON Lines with blank, CRLF, broken and
non-object lines; arrays; wrapped records; CSV quoting, delimiters,
duplicate headers, ragged rows; BOM, UTF-16, workbook / PDF / gzip / binary
refused); dot paths and `__proto__`; shapes; the guess (the demo exactly, an
awkward nested export, a CSV, the inputs fence, shape-only unsure); every
check with planted cases; **the chain verified with node:crypto against the
core's canonical form** - an edit, a removal, a swap, partial and
unreadable hashes, base64 and `sha256:` forms, the raw-line recipe, no
previous hash, a mismatched recipe (never tampering), a nested hash with the
raw recipe, CSV raw cells, a JSON array; **the page's snippet run and
verified**; gaps, duplicates, order; overrides; time gaps (nights and
weekends not flagged); the pack and its missing box; the sample (same seed,
same sample; strata; proportional; masked, formula-safe CSV); exports
(masked, escaped, formula-safe); **the demo yields exactly the planted
findings** and is made up (tested against a list of real lenders, bureaus,
fintechs and model makers); strict settings and merge; the AI request and
answer; hostile files (markup and bidi in keys and values, `__proto__`, a
2 MB value, a key per record, 100,500 records, over 20 MB); **the real worker
in a worker thread with SubtleCrypto, agreeing with node:crypto**; contrast in
both themes, the hero, the mock and the lab card; the page's promises (no
inline script, storage opt-in and wrapped, the locale fallback for
`en-US@posix`, no eval, every markup line escaped, the service worker, no
regulation named by citation); no invisible characters or key-shaped strings
in any file; the local switches; and over HTTP: signed out with zero model
calls and 401 before every parser, no route that takes a log, the gate
order, one model call site, settings sync (409, record-looking settings
refused, nothing identifying stored), the AI route (values refused before
any call, what the model saw, hostile output, errors not passed on) and the
401 / 402 / 403 / 503 gates.

Screenshots at 390px and 1280px, light and dark - first run, the demo report
with its hint, the broken chain, adverse outcomes, version drift with the
change log, the gap hour by hour, a replay pack, the sample, the fields for
an awkward nested JSONL and a CSV, exports, the AI sheet signed out and
signed in (fake model) showing exactly what is sent, settings synced, the
lab card - and a hostile pass (markup and bidi in keys and values, a 20 MB
log, a file over the cap, malformed lines) were taken with Playwright.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, the worker, the
service worker. Signed in, free: `GET|PUT|DELETE /api/settings`. Metered:
`POST /api/ai/fields`. The shared account at `/api/auth`.

## Ideas not built yet

- **Replay for real**: re-run a decision against a team's own model endpoint
  with the recorded inputs and versions, and diff the answer. It needs the
  team's key and endpoint - a different trust model from "nothing leaves the
  device", so it waits for a decision.
- **Several logs joined** (the decision service, the review queue, the
  notice sender) by decision id, so a reviewer recorded elsewhere counts.
- **Merkle roots** and signed checkpoints (a daily root a third party
  holds) as well as a linear chain.
- **A nightly check in CI** with the core as a CLI.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; no eval or
  `new Function`; the worker is a same-origin file; clicks by one `data-act`
  listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; every metered and settings
  parser runs after its gates.
- Log contents, typed text, the server's answers and the model's answers are
  untrusted: keys and values are shown through `visible()` (bidi, zero-width
  and control characters drawn as marks), bounded, and escaped on render (the
  test cuts out every `esc(...)` and fails on anything else concatenated into
  a line of markup). Tables, hashes and code scroll or wrap in their own box.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
