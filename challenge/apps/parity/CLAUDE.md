# For Claude: Parity

Prove the migrated data matches - without it leaving your machine. For data
engineers, platform leads and DBAs who move a table between schemas or
systems (a database upgrade, a warehouse move, an ETL rewrite) somewhere the
data cannot go to a cloud diff tool - regulated, on-prem, air-gapped - and
who today eyeball row counts and hope. Drop the table **before** and
**after** (CSV with any delimiter, TSV or JSON Lines, up to about 1 GB each),
**read in a Web Worker on the device, never uploaded**. Parity pairs the
columns by name (renames, units, splits and joins), **learns the rules**
that make before look like after from rows that share a key (trim, case
fold, cents to dollars, date formats, code tables), and gives a verdict:
"Matches ✓" or "5 problems in 2,000 rows", each problem ranked by rows
affected, naming the exact keys, with before → after and the pattern
("truncated to 30 characters", "shifted by +4 hours", "null became an empty
string"). Aggregates side by side, a sign-off report (HTML, Markdown, JSON),
and **fingerprint mode** for two machines that cannot share data at all.

Built 2026-10-09 as a **business** drop: Pickup (2026-10-08) was everyday,
so today was the other kind. **Staging only**: no custom domain until Erik
decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/parity`,
served at `challenge.strongtechnicalconsulting.com/parity/` once it has a
`lab.js` entry, deployed with `gcpdeploy ship challenge`. See
`challenge/CLAUDE.md` for mounting, prefixes and graduation. Every browser
URL is relative to `BASE`; keep it that way. **It stores nothing in the lab
database** (see Data).

## Why it exists

It answers Friction's rising problem **"No air-gapped way to verify
transformed data after schema migration"**. A migration's sign-off is
usually a row count and a few spot checks, because the real diff tools want
both tables in their cloud, and the tables are exactly what a regulated team
may not move. Parity does the diff where the data already is - in a browser
on the machine that holds it - and, when before and after live on two
machines that cannot talk, compares them by fingerprints that hold no value.

Not a repeat: **Tieout** checks a bank statement's own arithmetic;
**Burnrate** reads agent logs; **Shadow** and **Drip** read card CSVs.
Nothing in the lab or the portfolio compares two datasets.

**Who pays.** Almost nobody. The example, reading files, the mapping, the
learned rules, the verdict, aggregates, fingerprints, row lists, the report
and the recipe are free, need no account, and make no request. The one
metered thing is **Suggest with AI** (Haiku for the free tier, Sonnet for
members via `identity.planFor`), about a cent, and it is optional: the
auto-map is free and usually enough.

**The honest risk.** A verdict someone signs has to be right in both
directions. So: comparisons are exact (numbers as decimal strings, never
floats; dates as instants), the rules come from a fixed list with checked
settings, learned rules are only kept when they fix many rows and break none
(so a defect on a few rows is never "learned away"), and every finding names
its keys so a person can look. Hashes are 53-bit keys and 64-bit rows: a
collision would hide a difference with odds near 2^-53 per pair; this
file says so, and the page claims nothing stronger.

**How it becomes an iPhone app.** Not for reading the files - those live on
servers. For the sign-off: open a report or compare two fingerprints that
arrived by mail, on the phone, offline. The core is one UMD file already.

## The decisions that matter

- **No row reaches the server.** `public/parity-core.js` (UMD:
  `window.ParityCore` in the page, `importScripts` in the worker, `require`
  in the server and tests) holds every rule; `public/parse-worker.js` reads
  files. There is **no route** that accepts data (POSTs to `/api/upload`,
  `/api/compare`, `/api/rows`, `/api/fingerprint` are 404s, tested), and the
  test holds every request `app.js` makes to `api/me`, `api/suggest` and the
  auth/billing routes. The core and the worker contain no `fetch`.
- **Reading** (`createCsvParser`, `createJsonlParser`, `sniff`): streamed
  with `File.stream()` and a `TextDecoder` in the worker, so the page never
  freezes and a 1 GB file is never held as one string. CSV: quotes, `""`
  inside quotes, line breaks inside quotes, CRLF / LF / CR, a BOM, any of
  `, ; TAB |` (sniffed from the first 64 KB by the most consistent field
  count), ragged rows padded with null or cut, and counted. An **unquoted**
  `NULL`, `\N`, `None`, `N/A`, `#N/A`... is null; a quoted one is text; an
  empty cell is an empty string unless "Empty cells are null" (Postgres COPY)
  is ticked. JSON Lines: keys in first-seen order, a missing key is null, a
  number kept **as written** (`12.50`, 20-digit ids) via JSON.parse's source
  text, nested values as JSON. The same rows come out whatever the chunk
  boundaries (tested at 1..9 characters). Header detection: row one is names
  when every cell is a distinct non-empty label and none is a number or date;
  the person can say otherwise.
- **Types** (`createProfiler`): int, decimal, bool, date and date-time with
  their **format** (20 formats; MM/DD vs DD/MM settled by a day over 12 and
  flagged when not; fractions of a second optional), text, or empty. Leading
  zeros (`02134`) are text - a code, not a number. Stats are streamed:
  rows, nulls, empties, distinct (exact to 50,000, then a HyperLogLog
  estimate, marked ≈), lengths, padding and case counts. No value is kept but
  eight preview rows.
- **Mapping** (`automap`): token similarity after synonyms (`cust` →
  customer, `dt` → date, camelCase split) with unit/role words (`_cents`,
  `_cd`, `_at`, `_id`) weighted down, types that cannot match (a date and a
  number) halved, then greedy one-to-one, each with a confidence (Same name /
  Likely / Check this). Splits and joins of a person's name
  (`full_name` → `first_name` + `last_name`) are found; any other split or
  join is one tap in the pair sheet. A split pair compares **joined** (empty
  parts left out), so no splitting rule is needed. The **key**
  (`suggestKey`): a one-to-one pair unique and never null on both sides (1%
  duplicates allowed after - that is a finding), an id first.
- **Rules** (`RULES`, `cleanRule`): a fixed list, no code - ignore, null
  equals empty, trim, value map, cents ↔ units (÷100 / ×100, exact decimal
  shift), date reformat (from/to in the format list), time zone offset
  (quarter hours, ±14), round to n places (half away from zero), case fold.
  Applied in that fixed order. Most shape the **before** value into what the
  after value should be; ignore, null-equals-empty, round and case fold apply
  to both sides because they define "equal". Then both sides go to the
  **after column's type**: numbers as canonical decimals, dates as ISO
  instants, booleans as true/false, text as written.
- **Learned rules** (`learnRules`): rows that share a key are joined
  (`sampleJoin`, about 3,000 chosen by key hash so both sides pick the same
  ones) and candidate rules are tried per pair - trim when before has padding,
  a date reformat when the formats differ, ÷100/×100 for numbers, case fold,
  a value map built from the joined values for code columns (≤ 40 distinct).
  **A rule is kept only if it fixes at least five rows, at least half of the
  pair's disagreements, and breaks none.** The example's +4 h batch (129
  rows) and its single null-turned-empty stay findings. Each learned rule is
  marked "learned" on the Map step.
- **Comparing** (`createHasher` → `diffHashers` → `createDetail` →
  `diagnose`): pass one, per side, keeps a `Map` of 53-bit key hash → slot
  and, in typed arrays, a 64-bit row hash and a count per key (duplicates add
  lane by lane, so row order never matters), plus column aggregates. The
  diff gives missing, extra, duplicated (counts differ), mismatched, and
  "not unique on both sides" (a note). Pass two re-reads both sides and keeps
  only the rows of the wanted keys (20 examples a kind, every mismatch up to
  50,000 for the per-column patterns; past that, "explained from the first
  50,000") and the **like-for-like aggregates** over keys present once on
  both sides. Files up to `LIMITS.memoryBytes` (96 MB) stay in the worker's
  memory; bigger ones are re-read for each pass, so memory is the key map,
  not the file. Measured in Node: 200,000 rows x 5 columns, both sides, all
  passes, about 5 s; the 2,000-row example in about 0.4 s.
- **Patterns** (`recognize`): null↔empty, value lost or filled, truncated
  to N characters, case changed, spaces, Unicode re-normalised, mojibake,
  sign flipped, rounded to n places, scaled by 100, shifted by N hours (to the
  quarter hour, ±26), moved by whole days, a date written in another format
  (with the rule to add), else "different value". A column's finding is
  titled by its dominant pattern ("company_name: 310 values truncated to 30
  characters"), with the breakdown when there are several, and a fix in words.
- **Aggregates** (`aggregateChecks`): per compared column, values, nulls,
  empty strings, distinct, and sum / min / max for numbers (sums exact, to
  six decimal places), min / max for dates, longest for text - each ✓ or ✗.
  Two views: **rows on both sides** (the default, so a missing row does not
  drown out a changed value) and **all rows**. In the example, like for like,
  only company_name and phone disagree.

### The example migration (`public/demo.js`)

2,000 made-up customers, generated deterministically from a seed: the
legacy export as CSV (CRLF, `NULL`, quoted names with commas and quotes,
padded names, mixed-case emails, `MM/DD/YYYY`, cents, `A/I/S/P`, naive
times) and the warehouse export as JSON Lines (first/last split, lower-case
email, ISO dates, dollars as `1234.50`, words, `...Z` times). Planted, and
asserted to be **exactly** what the example finds: 3 rows dropped, 1 row
loaded twice, `company_name` cut to 30 characters (310 rows), a batch of
`last_login_at` shifted +4 h (129 rows), one phone null that became `""`.
Emails are built at run time on example.* domains (no address in the
source). It is never saved.

### Fingerprints: two machines, no data crossing

- **What a fingerprint holds** (`fingerprintFrom`): the side, row and key
  counts, the column names and types the recipe compares, per-column counts
  (values, nulls, empties, distinct, longest), the recipe's hash, a
  passphrase check, and **4,096 bucket entries**: each a row count and a
  keyed hash of the rows in it. A row's bucket is a keyed hash of its key;
  a bucket's hash is SipHash-2-4 over the lane sums of its rows' hashes
  (keys mixed in, so a changed key shows). **No value from the data** -
  tested on the example: no text, date, code or id appears in it. Sums,
  minimums and maximums are values, so they are **opt-in** ("Include sums,
  minimums and maximums", off) and the file says `includesValues`.
- **The passphrase.** PBKDF2-SHA-256, 210,000 rounds, salt "parity
  fingerprint v1", 128-bit key, in WebCrypto (the worker). It keys every
  hash, so a fingerprint cannot be tested against guesses ("is customer
  10457 in here?") without it. At least 12 characters; never saved or sent;
  the page says to pass it by phone, not with the file. A short check value
  in the file lets two fingerprints say "different passphrases" instead of
  "everything differs" (it also lets someone holding a fingerprint test
  passphrase guesses at PBKDF2 speed - hence the length rule).
- **Comparing** (`compareFingerprints`): rows, aggregates and buckets, with
  a 64x64 map of agree / differ / empty. Equal data under one recipe and
  passphrase gives byte-equal fingerprints (tested); one changed row changes
  exactly one bucket (tested). Different recipes warn.
- **Find rows** (`rowListFrom`, `compareRowLists`): each side lists just the
  differing buckets' rows as keyed key and row hashes (key values only if
  ticked); the two lists name which keys are missing, extra, repeated or
  changed, and each machine shows its own rows for them. Narrowing works best
  when a few rows differ in a big table; when most buckets differ the page
  says so and points at the aggregates (the example is in that case: 424 of
  2,000 rows changed).
- **The flow across machines:** after machine saves its **shape** (names,
  types, counts - no values) → before machine loads it, maps, makes the
  before fingerprint and saves the **recipe** → after machine loads the
  recipe and makes its fingerprint → compare anywhere. In the example both
  files are in one browser, so both machines can be played on one page.

### The report and the recipe

HTML (self-contained: inline styles only, a `default-src 'none'` CSP, no
script, no external asset, every string escaped - previewed in a sandboxed
iframe), Markdown (prose escaped, `<` `>` as entities, values in code spans)
and JSON, each with the files, the mapping and rules, every finding, the
like-for-like aggregates, the verdict and the time. **Summary only** drops
every example and key value, sums, minimums, maximums and value-map entries,
for sharing outside the team (tested). Examples as CSV: RFC 4180 quoting and
the formula guard - a cell starting `= + - @`, tab or CR gets a `'`, except a
plain number like `-12.50`. The **recipe** is the mapping, rules, key and the
after side's types as JSON (`toRecipe`), loadable on any machine; loading
one checks every name against the real columns and says how many pairs did
not fit.

### Works with the network off

`public/sw.js` is a service worker served from the app's own path
(`/parity/sw.js`, `Cache-Control: no-cache`), scope the app base. Network
first, cache as the fallback, for the app shell only (the page, its scripts,
styles, worker, icon, manifest); never `api/` (the account and the AI call
must never come from a cache), never another app's path (the lab shares the
origin), and it deletes only its own `parity-*` caches. **Checked in
headless Chromium**: load once, cut the network (`context.setOffline`),
reload - the page loads, the example runs, the verdict draws, and a request
to `api/health` is refused. The lab CSP needed nothing: `worker-src` falls
back to `script-src 'self'`, and both workers are files on this origin. The
host needs nothing either (no `Service-Worker-Allowed`: the scope is the
script's own folder). One gap: offline, `/parity` without the slash is not
answered (the host's redirect needs the network); `/parity/` is.

## The one model call (metered)

**Suggest with AI** (`POST /api/suggest`): `requireUser, requireBudget,
requireDailyCap`, **then** a 64 KB parser, then `ai.cleanRequest` rebuilds
the two shapes field by field (names, a type from the list, a format from
the list, counts) - a 400 costs nothing - then one forced tool,
`propose_mapping` `{pairs: [{from, to, rules: [{rule, ...}], why}], key}`,
then `ParityCore.cleanProposal` keeps only real column names and valid rules.
The page shows **exactly** what will be sent first (`ParityCore.modelSummary`
- names, types, counts, never a value) and the answer as suggestions with
ticks, "Use the ticked suggestions". Signed out, the sheet explains and
offers a free account (and still shows what would be sent); 402 opens the
credit sheet; 403 `verify-email` shows its sentence and a resend. Tested:
markers planted as `sample`, `values` and `rowsData` never reach the fake
model's request; no example value does.

## Local run and tests

```
npm run dev     # memory identity + fake model, at http://localhost:8126/parity/
npm test        # pure rules, the worker in Node, then end to end over HTTP under /parity
```

`PARITY_MEMORY=1` (the shared account in memory - Parity has no store of its
own) and `PARITY_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`) - in
`lib/store.js`, `lib/fakeai.js` and `server.js`; the tests spawn each with
`K_SERVICE` to prove it. `npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`.
The fake model refuses a call that does not force a tool, logs every request
(`fakeCalls`) and answers with the name-based auto-map; triggers in a column
name: `BLANK`, `INJECT`, `MAXTOKENS`, `UPSTREAMnnn`.

The suite also runs `parse-worker.js` itself in Node (a stand-in `self`,
Node's `File`), once with the files held in memory and once re-read for
every pass, and checks both give the core's verdict. Screenshots at 390px
and 1280px, light and dark, plus offline, were taken with playwright-core
against `npm run dev`.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Data

**None in the lab database.** No file, row, result, recipe or answer is
stored (tested: the identity store holds only `users`, `usage`, `events`,
`control`). `lib/store.js` reads `PARITY_COLLECTION_PREFIX` so that anything
ever stored is prefixed from its first write. **In the browser:** the last
recipe of your own files (mapping and rules - and a value map's entries -
never data) in `localStorage` `parity-recipe-v1`, every access in try/catch,
with Clear on the first run and the Report step. The example is never saved.

## Routes

Public: `GET /api/health`, `/api/meta` (limits, rules, date formats, types),
`/api/me`, `/sw.js`, the page. Metered: `POST /api/suggest`. The shared
account at `/api/auth`. There is deliberately no route for data.

## Ideas not built yet

- **Database connectors** (a local agent reading Postgres/Oracle directly
  and writing fingerprints) - the browser can only read exports.
- **Excel and Parquet** input (Parquet needs a WASM reader).
- **Composite-row fuzzy matching** when there is no key at all.
- **A shareable signed report** (a hash of the report a second person can
  verify) - needs a signing story.
- **Adaptive buckets** (more buckets for big tables, so narrowing stays
  tight at tens of millions of rows).

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`), not loosened for the workers; no
  inline `<script>` or `on*=`; handlers by `data-act` from one listener.
- No model call for a signed-out visitor, ever; the metered route's gates run
  before its parser (401/402/403, never 413 - tested).
- Column names and values are hostile: `esc()` strips control, bidi and
  zero-width characters before escaping, every render goes through it, and
  each export escapes for its own format (tested with markup, a bidi
  override and formula cells in a column name and its values).
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
