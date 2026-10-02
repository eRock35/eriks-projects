# For Claude: Next Move

"What's my next move" - a career copilot, for anyone. Every day a job reads
the career boards of the companies a person watches, public pay data and
company news, and scores the new roles against their background: a score, a
verdict, the posting's own words for why (each quote checked against the
posting), the gaps, and how to position themselves. Weekly, a web-search
sweep finds what the boards missed and a digest is built.

Built 2026-10-02 at Erik's request: "Scheduled job that watches postings,
comp data, and company news for roles like the one you're eyeing, then scores
fit against your background ... Can we store it in a BigQuery table." He then
chose: **a product for anyone**; **a Cloud Run job writing to BigQuery** (not
Dataflow); **all four sources**; **daily runs with a weekly digest**.

**Where it lives:** `eriks-projects/apps/nextmove`, a subdirectory app like
Friction (the GitHub App cannot create repos). `apps.json` entry `nextmove`.

## Cloud Run job, not Dataflow - the trade

Dataflow (Apache Beam) starts a fleet of worker VMs for every run and is built
for streams and batches far larger than this: tens of millions of records,
autoscaling shuffles. A run here reads a few hundred career boards (thousands
to tens of thousands of postings), a few hundred filings and news queries, and
makes a few hundred model calls. A Cloud Run job does that in one container in
minutes for pennies, bills only while it runs, needs no Beam pipeline code and
shares the web service's image and identity. Dataflow would cost more per run
just to start its workers and add a second programming model. Revisit only if
the posting volume grows by two or three orders of magnitude - and even then
BigQuery's own SQL (the MERGE below) is likely the next step, not Dataflow.

## One image, two entrypoints

- `server.js` - the web app, Cloud Run **service** `nextmove`. No timers,
  nothing after a response (billed per request).
- `jobs/run.js <job>` - Cloud Run **jobs** on the same image:
  `daily` (boards, postings MERGE, filings and news, scoring), `weekly` (the
  web-search sweep, then digests), `comp-refresh` (DOL LCA and BLS OEWS),
  `setup` (create missing tables), `check-sql` (dry-run every query - free),
  `schema` (print `bq/schema.json`). Every step awaited; ends with ONE line of
  JSON (`{job, runId, ok, counts, errors, firstError, ms}`); exit 1 when the
  job failed outright. A board, a filing or a person failing is counted in
  `errors` and the run goes on. Each run also writes `control/last-<job>`
  (and `control/last-run` for daily) in Firestore and a row in BigQuery `runs`.

`lib/context.js` builds the shared pieces once (stores, identity, BigQuery,
metered clients) so the service and a job in the same process (tests, dev)
see the same data.

## Where data lives - and what never goes where

- **Firestore `nextmove`** (Native, us-central1): `users/<uid>` - background,
  targets, watchlist, `lastScoredAt`, `lastRun`; `users/<uid>/digests/<week>`
  (the weekly snapshot, kept for a future email); `boards/<companyKey>` (the
  resolved board, `openCount`, `newThisWeek`, `newest`, `cik`, `secSince`,
  `newsAt`, `lastError`; `boards/name:<slug>` caches a name probe for 30 days);
  `control/*`. **The background/resume lives only here.**
- **BigQuery dataset `nextmove`** (us-central1): what grows - `postings`,
  `comp_public`, `company_events`, `fits`, `runs`. **No uid, email or name.**
  A person appears only as `user_key` = HMAC-SHA256 of the uid under a key
  derived from `IDENTITY_SESSION_SECRET` ("nextmove user key v1",
  `lib/userkey.js`). Without the secret the app refuses to derive keys (no
  fallback key - an HMAC under '' is computable by anyone reading this repo).
  **Rotating `IDENTITY_SESSION_SECRET` orphans every fit** (old rows stay under
  keys nobody derives; delete-account can no longer find them). A rotation
  therefore needs a re-key: compute old and new keys per user and
  `UPDATE fits SET user_key=@new WHERE user_key=@old` before switching.
- An uploaded resume is read once by the model and dropped; contact details
  the model returns anyway are scrubbed (`profile.scrubContact`). Nothing is
  logged that carries a body, a resume, a name or an email (test-held).
- **Delete my data** (`DELETE /api/me`, `{confirm:'delete'}`, same-origin):
  the Firestore profile, every digest, and a DML `DELETE FROM fits WHERE
  user_key=@key`. The shared account is untouched (it covers every app; it is
  deleted from identity). Fits are written by **load jobs**, never streaming
  inserts, precisely so this DELETE can always reach them (rows in a streaming
  buffer cannot be deleted by DML for up to ~30 minutes).

## BigQuery (`lib/bq.js`, `lib/schema.js`, `lib/queries.js`, `bq/schema.json`)

REST, no client library: queries (`jobs.query` + polling + paging), NDJSON
**load jobs** by resumable upload, table create/delete. Token from the
metadata server (`NEXTMOVE_BQ_TOKEN` overrides it for a local run against the
real dataset). `NEXTMOVE_MEMORY=1` swaps in an in-memory fake that **throws on
Cloud Run** (`K_SERVICE` or `CLOUD_RUN_JOB`).

Rules every call keeps (tests hold them):
- **Registered queries only** (`lib/queries.js`): fixed SQL, named
  `@parameters`, each beside its JavaScript twin the fake runs. The only
  substitution is `{{table}}` -> `` `project.dataset.table` `` from env vars
  checked against a strict pattern; stage-table names are validated too.
- **`maximumBytesBilled` on every query** (`NEXTMOVE_BQ_MAX_BYTES`, default
  2 GB; the MERGE `NEXTMOVE_BQ_MERGE_MAX_BYTES` 50 GB; the comp swap
  `NEXTMOVE_BQ_COMP_MAX_BYTES` 50 GB). The fake throws without it.
- Reads are partition-pruned (`first_seen`, `scored_at`, `published_at`,
  `year`) or narrow and clustered (`company_key`, `user_key`, `title_norm`).
  Web reads are memoised per person for 5 minutes (`NEXTMOVE_CACHE_MS`); comp
  per role for 30 minutes, shared (public data).

Tables (full definitions in `lib/schema.js`; `bq/schema.json` is generated
from it by `node jobs/run.js schema > bq/schema.json` and a test fails if they
differ):
- `postings` - partitioned DAY(`first_seen`), clustered `company_key`. As the
  brief, plus `location_state`, `pay_min_annual`, `pay_max_annual` (every
  comparison is annual), and `pay_source` `posted | ashby_comp | lever_salary`
  (Lever publishes a structured range too). `description_text` <= 20k chars.
- `comp_public` - integer-range partitioned on `year` (2015-2040), clustered
  `source, title_norm, worksite_state`. As the brief, plus `seniority`,
  `wage_p25`, `wage_p75`, `employment` (OEWS publishes percentiles, not people).
- `company_events` - partitioned DAY(`published_at`), clustered `company_key`;
  `source` also `websearch`; `sec_items` REPEATED.
- `fits` - partitioned DAY(`scored_at`), clustered `user_key`. As the brief,
  plus `prefilter`, `content_hash` and the posting as scored (company, title,
  url, location, remote, annual pay, source) **denormalised**, so Today is one
  partition-pruned read of `fits`, never a join that scans `postings`.
  `reasons` JSON = `{strengths: [{point, quote}], positioning}`; `gaps` JSON.
- `runs` - partitioned DAY(`started_at`).

### The postings upsert: MERGE from a per-run stage table

The daily job loads every posting it fetched into `postings_stage_<runId>`
(expires in a day, dropped after), then one MERGE: unchanged -> `last_seen`
moves (and a closed one reopens); changed text -> fields updated, `first_seen`
kept; new -> inserted; **not in the stage, at a board fetched in this run, open
and not from the web search -> `closed_at`**. A board that failed to load is
not in `@companies`, so it closes nothing. Before the MERGE, a narrow query
(`existing_postings`) gives the diff - which postings are new or changed - so
only those are scored.

Why MERGE over "insert + dedupe view": the view would have to pick the latest
row per posting on every read and carry every sighting forever; a MERGE keeps
one row per posting, which every reader wants. Its cost: a MERGE with UPDATE
bills the whole target table once a day. At the expected size (tens of
thousands of open postings, a few GB with descriptions) that is well inside
BigQuery's free monthly terabyte. If `postings` grows past ~50 GB (the MERGE's
byte cap refuses rather than overspends), move closed postings older than a
year out, or switch to an insert-only `sightings` table plus a view.

## Sources - public and permitted only

**Never LinkedIn, Indeed, Glassdoor or any job aggregator - no scraping, ever.**
Their terms forbid it; a company's own board is the better source anyway.
The web-search sweep is told the same, and its results drop those hosts.

1. **Career boards** (`lib/boards.js`): Greenhouse
   `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`, Lever
   `api.lever.co/v0/postings/{company}?mode=json` (EU boards on
   `api.eu.lever.co`), Ashby
   `api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true`.
   Public, documented embed APIs. A company resolves from a pasted careers URL
   (boards.greenhouse.io/X, job-boards.greenhouse.io/X, the embed form,
   jobs.lever.co/X, jobs.ashbyhq.com/X) or by probing the three APIs with
   slugs of its name; an unknown careers site is tried by its domain name.
   Nothing found -> `name:<slug>`, still watched for filings, news and the
   sweep. Polite (`lib/http.js`): an identifying User-Agent, a concurrency
   limit, a minimum gap per host, timeouts, retries with backoff on 429/5xx
   only (Retry-After honoured), size caps; boards per run capped
   (`NEXTMOVE_MAX_BOARDS_PER_RUN`, 150, stalest first).
   **Posted pay** is parsed deterministically (`lib/pay.js`, tested on many
   real shapes: `$180,000 - $220,000`, `$180K–$220K`, `USD 150K–190K`,
   `150-190K`, `$85/hr`, `€70.000 - €90.000`, `up to`, `starting at`, several
   ranges -> one envelope in the common currency); bonuses, stipends, funding
   and revenue are refused; doubtful -> no pay. Ashby's and Lever's structured
   compensation win when present.
2. **Comp from public filings** (`comp-refresh`, `lib/comprefresh.js`,
   `lib/lca.js`, `lib/xlsx.js`): the DOL OFLC LCA disclosure files
   (`LCA_URLS`, comma-separated; **the file names change every quarter**, so
   this env var is updated by hand - each file's name must carry
   `FYyyyy_Qn`, which is the period it replaces) and BLS OEWS national and
   state files (`OEWS_URLS`, the `.zip`s; optional). Downloaded to the job's
   disk, read row by row by a dependency-free zip/xlsx reader (shared strings
   held in memory, rows streamed; CSV too), certified full-time cases kept,
   wages annualised by unit (hour 2080, week 52, bi-weekly 26, month 12),
   implausible wages dropped, **only whitelisted columns copied** (the files
   also hold employer contacts and attorneys' emails - never loaded), loaded
   into a stage table in NDJSON chunks, then swapped in with one transaction
   (DELETE that period + INSERT). OEWS files of one year share one stage so
   the state file's swap cannot delete the national rows.
   Uncertain until the first live run: whether `dol.gov` and `bls.gov` serve
   these files to a script from Google's network (BLS in particular blocks
   many automated clients; the job sends `BLS_USER_AGENT` or
   `SEC_USER_AGENT`). A refusal is a recorded error, not a crash.
3. **Company news & filings** (daily): SEC EDGAR (`lib/sec.js`) - name or
   ticker -> CIK via `company_tickers.json` (exact normalised matches only; a
   name two CIKs share matches nothing), then `data.sec.gov/submissions` for
   new 8-Ks: 2.05 -> layoff, 5.02 -> exec_change, 2.01 -> acquisition, 2.02 ->
   earnings, 1.01 -> other. **EDGAR requires a User-Agent naming the operator
   and a contact address: `SEC_USER_AGENT`, never hardcoded (this repo is
   public); without it the job does not call EDGAR at all** and says so in
   `counts.secSkipped`. GDELT DOC 2.0 (`lib/gdelt.js`) per company, headlines
   that name the company, classified by keyword rules, one request every 5.5 s
   (`NEXTMOVE_GDELT_GAP_MS`), capped per run (`NEXTMOVE_MAX_NEWS_PER_RUN`, 40,
   round robin).
4. **The web-search sweep** (`weekly`, `lib/sweep.js`): per eligible person,
   ONE call with the server `web_search` tool and `record_finds`. The tool
   cannot be forced from the start (a forced tool is the first thing the model
   does, so it would never search): tool_choice auto with an instruction to
   finish with it, and one forced follow-up when it answers in prose.
   `pause_turn` is resumed by re-sending the conversation with the paused
   assistant turn - no "continue" message (college-football-app, "Two things
   that cost three failed runs"). Finds validated: https only, no aggregators,
   bounded strings, one per URL, deduplicated against `postings` by URL;
   stored as `source: websearch` postings (scored by the next daily run) and
   events.

## Scoring and money

- **The free prefilter** (`lib/prefilter.js`): title similarity (normalised
  roles, `lib/titles.js`), the seniority ladder (intern ... C-level), remote
  and locations, posted pay vs their floor, their skills in the text, +5 for a
  watched company. A posting elsewhere must look like a target title. Top N:
  **5 free, 20 members** (`NEXTMOVE_TOP_N_FREE` / `_MEMBER`), above a floor
  (`NEXTMOVE_PREFILTER_MIN`, 40). New or changed postings each day; everything
  open the first time and after a profile or watchlist change; never a posting
  already scored for them with the same text (60 days).
- **`score_fit`** (`lib/fit.js`, forced): score 0-100 (out of range -> the fit
  is dropped), verdict (bad -> derived from the score), up to 5 strengths
  each with a quote **verified as a substring of the posting** (whitespace and
  typographic quotes aside; unverified strengths dropped), up to 5 gaps, one
  paragraph of positioning; markup, control and bidi characters stripped,
  everything bounded. Cost per call in `fits.cost_usd`.
- **Who pays** - Trip Planner's sweep pattern ("The sweep charges the owner"):
  every call in a job is on a client metered to that person
  (`identity.meter(client, {uid, route})`, routes `nextmove-score` and
  `nextmove-sweep`), or their own key when they have one on file
  (`identity.clientFor`). Skipped: no shared account, an unconfirmed free
  address (`mustVerifyForFreeAi`), no credit, or the free tier's daily
  ceiling when it is on. Members on Sonnet, free on Haiku (`planFor`). Their
  remaining credit is checked between calls. **Run-wide caps**
  `NEXTMOVE_MAX_CALLS_PER_RUN` (400) and `NEXTMOVE_MAX_USD_PER_RUN` ($10)
  (weekly: 300 / $15, `NEXTMOVE_MAX_SWEEPS_PER_RUN` 100); people are scored
  `NEXTMOVE_SCORE_CONCURRENCY` (4) at a time, so a cap can be overshot by at
  most that many calls.
- **Models** (`lib/context.js`): `claude-haiku-4-5` / `claude-sonnet-5`. Both
  accept a forced `tool_choice`. Sonnet 5.5 and Opus 5.5 reject forced tools
  (400) - moving to them means tool_choice auto + `strict: true` first.

## The web app

Shared identity at `/api/auth` (like Friction; the verify banner loads with
`data-mount="api/auth"`). CSP `script-src 'self'; object-src 'none'; base-uri
'self'` + frame-ancestors, no inline script or handlers, `nosniff`, `trust
proxy` 1. Writes are same-origin JSON only (`identity.sameOriginOnly`).

- Public: `GET /api/health`, `/api/meta`, `/api/me`, the page.
- Signed in, free: `GET|PUT /api/profile`, `POST /api/watchlist {input}`
  (probes cached; 20 lookups / 10 min), `DELETE /api/watchlist/:key`,
  `GET /api/today` (fits, 14 days), `/api/companies` (board counts from
  Firestore + 30 days of events), `/api/comp` (per target title: posted
  ranges, H-1B, OEWS - each with its sample size, "not enough data" under 10
  rows, `NEXTMOVE_COMP_MIN_ROWS`), `/api/week` (built live; the stored
  snapshot is for email), `DELETE /api/me`.
- Metered (`requireUser, requireBudget, requireDailyCap`, then the 12 MB
  parser): `POST /api/profile/extract` (`{text}` or `{pdf:{data}}` -> a
  structured background to review; nothing saved) and `POST /api/score-now`
  (reads their watched boards now and scores the best 3 / 8; once in 20 h;
  so someone who just set up does not wait a day). Both stream whitespace
  (the `streamedJson` contract: after it starts, failures are 200 `{error}`).
- Another person's data is unreachable: the user key is derived server-side
  from the session; every Firestore path is under the session's uid.

**The example** (`public/sample.js`): "Example: a Director of Analytics in
Atlanta", made-up companies, fits, filings and pay, so every tab works on the
first open with no account, no model call and no BigQuery query (tested). The
set-up flow is three steps (background: paste / upload PDF / type; targets;
companies), then Today with "Score my top matches now" when empty.

## Local run and tests

```
npm run dev          # memory stores + fake model + fake BigQuery, http://localhost:8130
npm run dev:seeded   # the same, signed-in demo account; the real jobs run on fixtures first
npm test             # pure rules, then the jobs and the app over HTTP, no network
```

`test/helpers.js` fakes every source at `fetch` (unrouted URLs throw) and
writes real .xlsx/.zip files for the LCA/OEWS reader. The fake model
(`lib/fakeai.js`) is deliberately careless (an invented quote, an email in a
resume, aggregator links, `pause_turn`, prose instead of the tool) so the
checks are exercised. `NEXTMOVE_MEMORY` and `NEXTMOVE_FAKE_AI` throw on Cloud
Run.

## Env

Service and jobs: `GOOGLE_CLOUD_PROJECT`, `FIRESTORE_DATABASE_ID=nextmove`,
`IDENTITY_DATABASE_ID=identity`, secrets `ANTHROPIC_API_KEY`
(`anthropic-api-key`) and `IDENTITY_SESSION_SECRET`
(`identity-session-secret`). Service: `PASSKEY_RP_ID=strongtechnicalconsulting.com`.
Jobs: `NEXTMOVE_BQ_DATASET=nextmove` (default), `SEC_USER_AGENT` ("Next Move
(strongtechnicalconsulting.com) <Erik's address at the domain>" - set on the
job, never written here), comp job `LCA_URLS`, `OEWS_URLS`. Optional knobs
are named above. No new secret, so no new secret binding.

## First deploy (the parent session, after review)

Order matters: the account, then BigQuery, then the service and jobs, then
the scheduler. `P=metal-celerity-236019`, `R=us-central1`,
`SA=nextmove-run@metal-celerity-236019.iam.gserviceaccount.com`, `TOKEN` from
`gcpdeploy auth`.

1. **Erik, in Cloud Shell:** `./scripts/new-app-accounts.sh nextmove`, then
   `./scripts/nextmove-extra-bindings.sh` - creates dataset `nextmove`
   (us-central1, BigQuery API enabled), grants `roles/bigquery.jobUser` on the
   project and `roles/bigquery.dataEditor` on the dataset to `nextmove-run@`.
   It skips the job bindings until the jobs exist (step 5).
2. **The service** (creates Firestore `nextmove`, Native, us-central1):
   `gcpdeploy create nextmove --env PASSKEY_RP_ID=strongtechnicalconsulting.com`
   (commit first: `create` builds the checked-out tree).
3. **The jobs** - same image digest as the service. Read it:
   `curl -H "Authorization: Bearer $TOKEN" https://run.googleapis.com/v2/projects/$P/locations/$R/services/nextmove | python3 -c "import sys,json;print(json.load(sys.stdin)['template']['containers'][0]['image'])"`.
   Then for each of `nextmove-daily` (args `jobs/run.js daily`, 2Gi),
   `nextmove-weekly` (`jobs/run.js weekly`, 2Gi), `nextmove-comp`
   (`jobs/run.js comp-refresh`, 4Gi - the downloaded files sit on the
   in-memory disk):
   ```
   curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     "https://run.googleapis.com/v2/projects/$P/locations/$R/jobs?jobId=nextmove-daily" -d '{
     "template": { "taskCount": 1, "template": {
       "serviceAccount": "'$SA'", "timeout": "3600s", "maxRetries": 1,
       "containers": [{ "image": "'$IMAGE'", "command": ["node"], "args": ["jobs/run.js", "daily"],
         "resources": { "limits": { "cpu": "1", "memory": "2Gi" } },
         "env": [
           { "name": "GOOGLE_CLOUD_PROJECT", "value": "'$P'" },
           { "name": "FIRESTORE_DATABASE_ID", "value": "nextmove" },
           { "name": "IDENTITY_DATABASE_ID", "value": "identity" },
           { "name": "NEXTMOVE_BQ_DATASET", "value": "nextmove" },
           { "name": "SEC_USER_AGENT", "value": "'"$SEC_UA"'" },
           { "name": "ANTHROPIC_API_KEY", "valueSource": { "secretKeyRef": { "secret": "anthropic-api-key", "version": "latest" } } },
           { "name": "IDENTITY_SESSION_SECRET", "valueSource": { "secretKeyRef": { "secret": "identity-session-secret", "version": "latest" } } }
         ] }] } } }'
   ```
   (`SEC_UA` is the contact line above, typed in the shell, never committed.)
   `nextmove-comp` also gets `LCA_URLS` (the latest file(s) from the OFLC
   performance-data page, e.g. `.../LCA_Disclosure_Data_FY2026_Q4.xlsx`) and
   `OEWS_URLS` (`https://www.bls.gov/oes/special-requests/oesm25nat.zip,https://www.bls.gov/oes/special-requests/oesm25st.zip`
   or the current year's). Jobs creation is a long-running operation; poll
   `GET .../jobs/nextmove-daily` until `terminalCondition.state` is
   `CONDITION_SUCCEEDED`.
4. **Tables and a first run:** run the daily job once -
   `POST https://run.googleapis.com/v2/projects/$P/locations/$R/jobs/nextmove-daily:run`
   (body `{}`). Every job creates any missing table first, so this creates
   all five; with no users yet it does nothing else. Then check the SQL with a
   dry run of every statement (free):
   `POST .../jobs/nextmove-daily:run` with
   `{"overrides":{"containerOverrides":[{"args":["jobs/run.js","check-sql"]}]}}`
   and read its log line (every value a byte count, none `ERROR`). That needs
   `run.jobs.runWithOverrides`; if the deployer lacks it, create the tables by
   REST from `bq/schema.json` instead (`POST
   https://bigquery.googleapis.com/bigquery/v2/projects/$P/datasets/nextmove/tables`
   with each entry plus `"tableReference": {"projectId": P, "datasetId":
   "nextmove", "tableId": <name>}` - the deployer then needs dataEditor too).
   Then the comp job once: `POST .../jobs/nextmove-comp:run`.
5. **Erik again:** `./scripts/nextmove-extra-bindings.sh` - now binds
   `roles/run.invoker` on the three jobs for `nextmove-run@`, the Scheduler's
   OAuth identity. (`run.invoker` carries `run.jobs.run`; if Scheduler gets
   403, bind `roles/run.developer` on the job instead.)
6. **Scheduler** - three jobs calling `jobs:run`:
   ```
   curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     "https://cloudscheduler.googleapis.com/v1/projects/$P/locations/$R/jobs" -d '{
     "name": "projects/'$P'/locations/'$R'/jobs/nextmove-daily",
     "schedule": "15 11 * * *", "timeZone": "Etc/UTC", "attemptDeadline": "60s",
     "httpTarget": { "httpMethod": "POST",
       "uri": "https://run.googleapis.com/v2/projects/'$P'/locations/'$R'/jobs/nextmove-daily:run",
       "headers": { "Content-Type": "application/json" }, "body": "e30=",
       "oauthToken": { "serviceAccountEmail": "'$SA'", "scope": "https://www.googleapis.com/auth/cloud-platform" } } }'
   ```
   `nextmove-weekly`: `"15 12 * * 0"`; `nextmove-comp`: `"30 13 20 1,4,7,10 *"`
   (quarterly - and update `LCA_URLS` when the DOL posts the quarter's file).
   `gcpdeploy verify nextmove` then forces `nextmove-daily` and reads
   `control/last-run` (it reflects the PREVIOUS run until the new one finishes).
7. **Later:** a domain mapping (`nextmove.strongtechnicalconsulting.com`) per
   `DEPLOY.md` -> "Domain mappings"; Erik adds the DNS record.

### Shipping a change

`gcpdeploy ship nextmove` updates the **service** only. The jobs keep their
own image reference: after a ship, PATCH each job's
`template.template.containers[0].image` to the new digest
(`PATCH https://run.googleapis.com/v2/projects/$P/locations/$R/jobs/<job>`
with the job's current body and the image swapped), or the jobs run old code.

## Follow-ups (not built)

- **Email delivery of the weekly digest.** The mail key lives only on the
  landing (root CLAUDE.md, "Sending: the mail key stays in one place"); a
  signed dispatch route like identity's verify mail would be the shape. The
  digest snapshot is already stored per week.
- **The landing privacy page** (`eriks-projects/site/privacy.html`) needs a
  Next Move section: what is read (public boards, EDGAR, GDELT, DOL, BLS -
  never LinkedIn/Indeed/Glassdoor), that the background lives only in the
  person's profile, that a resume upload is read once and dropped, that
  BigQuery holds a keyed hash and never the account, Anthropic as the model
  provider, what delete removes.
- Seniority-specific comp (IC grades are pooled in `title_norm` by design).
- An app card on the landing and a link to it.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
