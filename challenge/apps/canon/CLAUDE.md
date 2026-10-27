# For Claude: Canon

One definition of every metric - and a check on every AI answer that uses
it. For analytics and BI owners and data-savvy operators at small and
mid-size companies whose teams now ask an AI for numbers ("revenue last
quarter") and get confident SQL that quietly counts refunds, test accounts
or the wrong date.

- **The canon**: per metric, its name and other names ("revenue", "sales",
  "GMV"), what it means, its owner, the source tables, the measure
  (`SUM(order_lines.net_amount)`, `COUNT(DISTINCT orders.id)`, or a ratio of
  two), the filters that always apply (`orders.status = 'paid'`,
  `orders.is_test = false`, `order_lines.refunded_at IS NULL`, each with what
  it keeps out), the date column and the time zone its days are in, the
  grain, the dimensions it may be split by, and known traps. Plus **schema
  notes**: tables, what one row is, their key, and the one-to-many links.
- **Check an answer** (the headline): paste the question and the SQL. Canon
  matches the question to metrics by name and other names and checks the SQL
  against each: source, aggregation, every required filter (in any
  equivalent form), date column, time zone, date range (and the BETWEEN
  trap), grain and fan-out, dimensions, and filters the canon does not have.
  Each row is **Matches / Missing / Different / Can't tell** with the SQL
  fragment and the definition line side by side; one verdict line ("2
  problems: refunds included, test orders included"); a **suggested fix**
  as a diff where it is safe, never applied.
- **Export** as Markdown (a glossary written for an AI tool's instructions),
  YAML labelled **dbt-style** (shaped like dbt's semantic layer, not claiming
  compatibility) or JSON; **import** JSON.
- **Signed in (free)**: the canon syncs to the account, and a **read-only
  share link** lets a team read it (and check answers against it) with no
  account.
- **Metered AI**: "Draft definitions from my schema" and "Explain this
  answer".

Built 2026-10-27 as a **business** drop: Rep (2026-10-26) was everyday, so
today was the other kind. **Staging only**: no custom domain until Erik
decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/canon`,
served at `challenge.strongtechnicalconsulting.com/canon/`, data in
`canon_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

It answers Friction's problem **"LLM-generated dashboards produce wrong
answers without a maintained semantic layer"**. The model writes plausible
SQL; nobody wrote down what "revenue" means, so nobody can say the SQL is
wrong. Canon is the smallest semantic layer that is useful on day one: the
definitions in a form a person can read and an AI can follow, and a checker
that holds any SQL up against them.

Not a repeat: **Parity** (2026-10-09) proves two tables match after a
migration - data, not definitions; **Proof** checks an agent's claims against
its run; **DataViz** in the portfolio draws charts. Nothing in the lab or the
portfolio writes metric definitions or checks SQL against them.

**Who pays.** Almost nobody. The canon, the example, every check, the fix,
the exports and import are free, need no account and make no request. A free
account adds sync and share links. The two metered things (Haiku for the free
tier, Sonnet for members via `identity.planFor`): an explanation is a cent or
two, a draft a few cents.

**The honest risk, said on the page.** "Rules, not a judge": Canon reads SQL
against what was written down. It never runs a query or sees data, it cannot
know a column's type or a database's NULLs, and "Can't tell" means look by
hand. Its own false positives are kept down on purpose:

- a filter is matched in any equivalent form - `= false`, `IS FALSE`,
  `NOT x`, `<> true`, `!= TRUE`, `= 0`, `'f'`, flipped (`'paid' = status`),
  `IN ('paid')`, `LOWER(x) = 'paid'`, `NOT (x IS NOT NULL)`; `IS NOT TRUE` and
  `COALESCE(x, false) = false` match with a note that NULLs are kept too;
- a filter counts wherever it reaches the rows: the same SELECT, a CTE or
  derived table it reads, an INNER JOIN's ON, an outer WHERE on a column that
  passes through; a test only inside a `WHERE x IN (SELECT ...)` is "Can't
  tell", not "Missing";
- a COUNT(*) where the canon counts DISTINCT is fine when nothing joined
  multiplies the rows (it says so, and that DISTINCT stays right if a join is
  added); a many-to-one join (lines up to orders, products, customers) never
  counts as fan-out; a join to a pre-aggregated subquery is assumed to be one
  row per key, and said;
- a filter the canon does not have is listed ("Other filters", Can't tell),
  never counted as a problem; a filter on an allowed dimension is a slice;
- relative ranges (`date_trunc('quarter', now())`), parameters and date-part
  filters are "Can't tell" for the range, never guessed;
- an unqualified column with two candidate tables is never guessed: the
  schema notes' column lists decide, else "Can't tell".

**How it becomes an iPhone app.** Not for writing SQL on a phone: for the
definitions and the sign-off. The canon in your pocket (what does "active
customer" mean?), a share link the team opens without an account, and a push
when an AI answer posted to Slack fails a check - the core is one UMD file
that a bot or a CI step can run as is.

## The decisions that matter

- **Every check runs on the device.** `public/canon-core.js` (UMD:
  `window.CanonCore` in the page, `require` in the server and tests) holds the
  tokenizer, parser, checks, fix, exports and cleaning. There is **no route
  that takes SQL to check** (`/api/check`, `/api/analyze`, `/api/sql` are 404s,
  tested), and the core and the demo contain no `fetch`, no storage, no clock
  and no dice (tested). "Today" is handed in by the page.
- **The tokenizer** (`tokenize`): `--`, nested `/* */` and MySQL `#`
  comments; quoted identifiers as `"x"`, `` `x` `` (dots inside split into
  parts), `[x]` (T-SQL - `arr[1]` stays a subscript); strings with doubled
  quotes, backslash escapes (MySQL / BigQuery, read that way only when the
  standard reading cannot be right), `E'..'`, `N'..'`, BigQuery triple quotes,
  Postgres dollar quotes; dbt/Jinja `{{ }}` `{% %}`; `$1`, `:name`, `@p`, `?`;
  `::` casts; T-SQL `#temp`. A double-quoted date or IANA zone
  (`"2026-07-01"`, `"America/New_York"`) is read as a string, the way
  BigQuery and MySQL mean it; any other `"x"` is a name, unless it resolves
  to no column where a value belongs. Never throws; an unterminated string or
  comment is noted.
- **The parser** is loose and structural, not a grammar: statements split on
  `;` (the one with an aggregate is checked, and the note says which), `WITH
  [RECURSIVE]` (column lists, `[NOT] MATERIALIZED`), UNION / INTERSECT /
  EXCEPT branches, SELECT lists with aliases (`AS x`, bare `x`), `TOP`,
  `DISTINCT ON`, FROM trees (comma joins, every JOIN kind, `APPLY`, nested
  `(a JOIN b)` groups, derived tables, `LATERAL`, table functions, `USING`,
  table hints, dbt's `{{ ref('orders') }}` and `{{ source('shop', 'orders') }}`
  as the table they name), WHERE / GROUP BY (positions, aliases, `ROLLUP`, `CUBE`,
  `GROUPING SETS`, `GROUP BY ALL`) / HAVING, and subqueries in expressions as
  their own scopes - a scalar subquery in the select list feeds the result
  (two metrics in one SELECT, each from its own subquery, are each checked
  against only their own subquery's filters and dates). `IS DISTINCT FROM` and `EXTRACT(x FROM y)` are not a FROM;
  `BETWEEN x AND y` and `CASE ... AND ... END` stay inside one condition.
- **Resolution** (`resolve`): every column is followed through aliases, CTEs,
  derived tables, `SELECT *` and UNION branches (by position) to the base
  table **scan** it came from, keeping the expressions it passed through (so
  a CTE's `AT TIME ZONE` counts for an outer filter). Table names compare by
  their last part, case-insensitively.
- **Predicates** (`predicate`, `equivalent`) are normalised to bool / set /
  null / comparison / range / like before comparing, with NOT pushed through
  (two-valued `IS` forms and three-valued `=` forms negate differently).
- **The canon side uses the same machinery**: a measure is read as
  `SELECT <measure> FROM <its tables>`, a filter as `... WHERE <filter>`, so
  `orders.status = 'paid'` and the SQL's `o.status = 'paid'` meet as the same
  base column.

### The checks (`checkMetric`)

- **Source / Aggregation**: the SQL aggregate that best fits each of the
  measure's aggregates (function, columns, alias); a different column,
  `SUM` vs `AVG`, a ratio answered with one AVG, no aggregate at all.
- **Required filters**, per scan of the filter's table: applied (Matches),
  nothing tests the column (Missing - "refunds included"), the table is never
  read (Missing), the opposite / wider / narrower / inside an OR / in a LEFT
  JOIN's ON (Different), applied where the table is read once but not where
  it is read again (Different), only in a subquery or HAVING (Can't tell).
- **Date column** from date filters and time groupings (resolved through
  CTEs); none while the question names a period is Missing.
- **Time zone** (when the canon's zone is not UTC): `AT TIME ZONE`,
  `CONVERT_TZ`, `convert_timezone`, `from_utc_timestamp`, BigQuery
  `DATE/DATETIME/TIMESTAMP_TRUNC(..., zone)`, any zone-named argument, a bound
  converted instead of the column (`>= TIMESTAMP '2026-07-01' AT TIME ZONE
  ...`), or an offset in the bound; Windows zone names and `US/Eastern`-style
  aliases are mapped.
- **Date range**: `BETWEEN ... AND '2026-09-30'` or `<= '2026-09-30'` on a
  timestamp cuts off that day; `23:59:59` loses the last second; a cast to
  date or a `*_date` column is fine. The literal range is compared with the
  period the question asks for (`timeAsk`: Q3 2026, last quarter, last month,
  a month name - "may I" is not May - this year, last week Monday-Sunday,
  yesterday; "last 30 days" is rolling and not compared).
- **Grain and fan-out**: the host select's joined tables (through derived
  tables that are not aggregated) against the schema notes' one-to-many
  links: a `SUM`/`AVG`/`COUNT` over a table with a one-to-many step to
  anything joined double counts; `COUNT(*)` of the wrong table; unknown links
  are Can't tell; `SUM(DISTINCT)` is Can't tell.
- **Dimensions**: GROUP BY columns (time groupings always allowed) against the
  allowed list; "by channel" in the question with no grouping is Missing.

### The fix (`suggestFix`) - deterministic, shown as a diff, never applied

Only where it is safe: a **missing filter** is added in the canon's own words
with the SQL's alias and keyword case, to the SELECT that reads its table (a
WHERE with a top-level OR is wrapped first; a statement ending `;` gets the
new lines before its last condition, without splitting a date range, so the
diff is pure additions); **COUNT(x) -> COUNT(DISTINCT x)** for a fan-out
count; a **half-open range** for the BETWEEN / `<=` trap; the **canon's date
column** where it is on the same table. Never automatic, listed under "Not
fixed automatically": a different source column, time zone conversion
(dialect-specific), a fan-out SUM (the join has to change), a filter whose
table is not read (it needs a join). "Check the fixed SQL" re-checks it on a
tap; the tests prove each demo fix then matches.

### The example (`public/demo.js`)

A **made-up** shop, Fernhill Coffee Co. (labelled everywhere): five metrics
(Revenue, Orders, Active customers, Average order value, Refund rate), four
tables and three links, and three AI answers - Revenue in Q3 2026 (refunds and
test orders counted: "2 problems"), Average order value by channel (the join
counts every order once per line: "1 problem", fixed with COUNT(DISTINCT)),
Active customers by month (right, through a CTE, `IS FALSE`). Tapping one on
the first run opens the example as the canon; over an own canon it is a
**preview** that saves nothing.

## Export and import

`toMarkdown` (a preamble telling an AI to compute each metric exactly as
written, then per metric: other names, meaning, measure, tables, required
filters with what each keeps out, date and zone, grain, dimensions, owner,
traps; schema notes as a table and the one-to-many links; escaped without
mangling `order_lines`). `toYaml` (headed "dbt-style ... NOT checked against
dbt"; `semantic_models` with entities, `metrics` with `type`, `type_params`,
`filter`, `meta`; every string double-quoted and escaped, tested with hostile
names). `exportJson` / `importJson` (`{app: 'canon', version, canon}`; 1 MB;
another app's file, no metrics, or nothing usable is refused in words; each
dropped metric is listed; every field through `cleanCanon`). The page shows
what an import holds before Add (merge, newer wins) or Replace.

## Sync and share links (signed in, free)

Filed under an **owner tag**, an HMAC of the account id under a key derived
from `IDENTITY_SESSION_SECRET` ("canon owner v1") - never the id or the email.
No secret: sync and links answer 503 and the canon stays on the device.

- `canons/<tag>` = `{owner, canon, updatedAt}`, one per account (bounded:
  60 metrics, 80 tables). `PUT /api/canon {canon, base}` saves in a
  transaction only if the account copy is still the one this device last saw
  (`base`); otherwise **409 with the account copy**, and the page merges
  (`mergeCanons`: by id or name, newer wins) and retries. The made-up example
  never syncs (400). On sign-in the page pulls, pushes or merges.
- `shares/<sha256 of the code>` = `{owner, createdAt, expiresAt, opens}`. The
  code is 16 random bytes (22 characters) and is **never stored**. A link
  lasts 7, 30 or 90 days; 10 open per account; 20 made an hour. It shows the
  account's canon **as it is now** (`shareView`: name, metrics, tables,
  relationships, updatedAt - tested by the exact key list) and nothing else.
  Expired and closed links are the same 404 as one that never existed (an
  expired one is deleted by the read that finds it). Wrong codes: 30 distinct
  misses per address in 15 minutes, then 429. `no-store`, `no-referrer`,
  `noindex`. Removing the canon from the account closes every link. The page
  at `s/<code>` is the app with `<base href="../">`; a visitor can read the
  definitions, copy them as Markdown and check an answer against them.
- The only query is `owner == tag` on shares: one equality filter, no index.

## The model calls (metered)

Both: `requireUser, requireBudget, requireDailyCap` **then** the route's own
parser (draft 256 KB, explain 128 KB; 401 / 402 / 403 / 503 before it, never
413 - tested), then the request rebuilt field by field (a 400 costs nothing),
one forced tool, then the answer cleaned. Nothing stored, nothing logged.

- **`POST /api/draft`** (`propose_metrics`): the page parses the pasted DDL /
  describe output / column lists **on the device** (`parseSchemaText`) and
  sends only table and column names, types, keys and links plus one sentence
  (`draftPayload`, shown in full first). `cleanDraft` keeps a definition only
  if **every column its measure names is in that schema**; a filter, date
  column or dimension naming another column is dropped; everything dropped is
  listed. Proposals are ticked for review and saved only on a tap.
- **`POST /api/explain`** (`explain_answer`): the question, the SQL and
  **only the matched definitions** (no owners, not the rest of the canon, not
  the schema notes) plus the rules' verdicts (`explainPayload`, shown first).
  Back: what the SQL computes, matches / differs / unclear, the differences,
  a fix in words - marked as a second opinion, not a verdict.
- The prompts fence the schema, business sentence, question and SQL
  (`<<<SCHEMA`, `<<<SQL`, ...) as untrusted data. Signed out, both sheets show
  exactly what would be sent and offer a free account; 402 opens the credit
  sheet; 403 `verify-email` shows its sentence and "Send the link again".

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8140/canon/
npm test        # the rules first, then end to end over HTTP under a /canon mount
```

`CANON_MEMORY=1` and `CANON_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `CANON_COLLECTION_PREFIX` (set to
`canon_` by the lab host) prefixes every collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that does not
force a tool, keeps every request (`fakeClient.calls`), always proposes one
metric and one filter on invented columns (so dropping them is exercised),
and reads triggers in the business sentence or the question: `BLANK`,
`INJECT`, `MAXTOKENS`, `UPSTREAMnnn`.

`test/run.js` (42 tests): the tokenizer on every quoting, comment and
parameter style; the parser on CTEs, derived tables, nested joins, UNION,
clause edges and quoted names in four dialects; resolution through CTEs,
`SELECT *` and UNION; equivalent forms (both sides); the three demo answers;
correct revenue written for Snowflake, BigQuery, MySQL, T-SQL and dbt, with a
bound-side zone, scalar subqueries and a NULLIF ratio - all clean;
each check with its match / missing / different / can't tell cases; fan-out;
the BETWEEN, `<=` and 23:59:59 traps; question matching and periods; the fix
(pure additions, aliases, keyword case, OR wrapping, no WHERE, COUNT DISTINCT,
half-open, date swap, what is never fixed, and fixed SQL re-checking clean);
hostile SQL; cleaning, merge, the three exports (hostile YAML and Markdown),
import validation; schema text in four formats; editor hints; the two AI
payloads and answers; contrast in both themes; the page's promises; the
local-only switches and the prefix; and over HTTP: signed out with zero model
calls and 401s before every parser, the gate order, sync (409, the example
refused, nothing identifying stored), share links (what one reveals, live
edits, closing, expiry, the cap, wrong guesses), both AI routes (what the
model saw, unknown columns dropped, hostile output, errors not passed on),
and the 401 / 402 / 403 / 503 gates.

Screenshots at 390px and 1280px, light and dark - the first run, the demo
canon, each demo check, the metric editor, export, a share link made and
opened (definitions and a check), the closed-link page, both AI sheets signed
out and answered - and a hostile-input pass (markup and bidi in a canon name,
a metric, a filter, the question, the SQL and an imported file: nothing
injected, no CSP violation) were taken with Playwright. Sheets size
themselves below the shared "confirm your email" banner when it is showing,
which otherwise covers a phone sheet's Close button.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Data

- **In the browser:** `canon-v1` (the canon), `canon-draft-v1` (the last
  question and SQL typed against an own canon - never the example's),
  `canon-sync-v1` (the account copy's `updatedAt` last seen), `canon-links-v1`
  (share codes this device made, so it can copy them again). Every access is
  wrapped in try/catch.
- **In the lab database:** `canon_canons/<tag>` and `canon_shares/<hash>`
  (above). No question, SQL, check, draft or explanation is ever stored.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, `GET /api/s/:code`, the
page, `s/:code`, the service worker. Signed in, free: `GET|PUT|DELETE
/api/canon`, `POST|GET /api/shares`, `DELETE /api/shares/:id`. Metered:
`POST /api/draft`, `POST /api/explain`. The shared account at `/api/auth`.

## Ideas not built yet

- **A Slack / CI hook** that runs the core on SQL an AI posts and replies with
  the verdict line (the core is one dependency-free UMD file).
- **Reading dbt's own YAML** into a canon (the export is already shaped
  like it).
- **Column types** in the schema notes, to tell a DATE from a TIMESTAMP
  instead of reading the name.
- **Editing together**: today the last save wins per metric on merge; a team
  editing one canon would want per-field history.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; handlers by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; every metered and sync parser
  runs after its gates.
- Pasted SQL, typed definitions, imported files, share-link canons and model
  answers are untrusted: cleaned in the core (control, bidi and zero-width
  characters removed - pasted SQL says how many), bounded, and escaped on
  render; SQL, diffs and exports scroll in their own box. The test greps
  `app.js` for typed fields concatenated into markup without `esc()`.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
