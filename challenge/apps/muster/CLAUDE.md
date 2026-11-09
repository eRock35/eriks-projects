# For Claude: Muster

Find the servicemembers in your loan book - and apply the 6% cap with the
paper trail. For **servicing and compliance operations at banks, credit
unions, auto lenders, card issuers and consumer-finance servicers** subject
to the Servicemembers Civil Relief Act.

- **Load a portfolio export** (CSV or TSV) in a Web Worker on the device.
  Muster guesses which column is which - the loan id, borrower 1 and the
  co-borrower (SSN, date of birth, last, first and middle name, or one
  full-name column), origination date, note rate / APR, current balance,
  monthly payment, monthly fees, loan type, "SCRA already applied" - and the
  person confirms. Day/month order that could go either way is asked once,
  with both readings; rates that are all 1 or under are asked about too
  (0.0949 = 9.49%?). Loan types are guessed from the values and editable.
- **Row checks** before anything is built, with counts and the exact rows:
  never-issued SSNs, missing or implausible dates of birth, no last name,
  names cut to fit and folded to plain letters (before and after), the same
  SSN on two loans, unreadable rates and dates. Blocked records are left out
  and listed.
- **The request file**: DMDC's fixed-width multiple-record request, one
  record per borrower per loan, every line 119 characters by default, on a
  ruler with each field coloured; the layout table is editable and checked;
  CRLF or LF, one file or split, `muster-request-YYYYMMDD-<batch>.txt`.
  Saved as a **batch record** that holds no SSN, date of birth or name.
- **Results**: a CSV with headers (columns guessed, confirmed) or a
  fixed-width file mapped with a **ruler** (drag a span, or type start and
  length). Matched back to the batch by customer record id.
- **Decisions**, each with the rule it rests on and the **6% math** in cents
  (an estimate), then a **worklist** whose every change is appended to a
  **SHA-256-chained audit log**, an **exam pack** (per-loan CSV, a one-page
  summary, the log as JSON, the batch) and a **borrower letter** filled on
  the device.
- **Signed in (free)**: settings follow the account - never a borrower.
- **Metered AI**: "Draft the letter in plain words" - a decision code, a
  loan type, dates and amounts only.

Built 2026-11-09 as a **business** drop: Whichbox (2026-11-08) was everyday,
so today was the other kind. Veterans Day is Wednesday 2026-11-11, so the
drop lands two days before the day servicers are most likely to be asked
about their servicemember borrowers - that timing is said here, not on the
card. **Staging only**: no custom domain until Erik decides it is worth one.
**A starting checklist, not legal advice - your policy and counsel decide** -
said on the page, in every export and in the letter section.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/muster`,
served at `challenge.strongtechnicalconsulting.com/muster/`, data in
`muster_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

Inspired by the Friction problem titled **"Running SCRA 6% rate-cap checks
against DMDC batch files for a loan portfolio"** (named by title only).

- **Servicers build DMDC's fixed-width multiple-record request files by
  hand** from SSN, date-of-birth and name exports - and a wrong position, a
  long name or an accent breaks a line.
- **They match the results back to loans in spreadsheets**, decide who is
  eligible for the 6% cap, estimate what is owed, and keep a per-loan audit
  trail for the examiner - a day of error-prone stitching every cycle.
- **One on-device tool does it in minutes**: the file, the matching, the
  decision with its rule, the math, the worklist and the trail.
- **It runs on the device because the inputs are SSNs and dates of birth.**
  That is the only way a servicer could try a lab app on a real book.

**Not a repeat.** **Stray** puts suspense payments on the right loan
account; **Replay** checks automated-decision logs; **Covenant** tracks
business-loan covenants; **Feedfix** and **Tieout** fix and check bank
files. Nothing in the lab or the portfolio checks a loan book for
servicemembers or applies the SCRA cap.

**Who pays.** Almost nobody. The example, reading a book, the row checks,
the request file, reading results, every decision and estimate, the
worklist, the audit log, the exam pack and the template letter are free,
need no account and make no request. A free account keeps layouts and
preferences across devices. The one metered thing (Haiku for the free tier,
Sonnet for members via `identity.planFor`) costs about a cent.

**How it becomes an iPhone app.** Not for loading 250,000 loans on a phone:
for the worklist - the analyst who reduced a rate in the core system ticks
it off, with the date, from wherever they are, and the audit log follows.
The core is one dependency-free UMD file a servicer's own batch job could run
as is.

## The statute points - the only legal statements Muster makes

From 50 U.S.C. § 3937, kept in `MusterCore.RULES` and quoted from there (the
rules sheet, each decision, the summary, the AI prompt). **Do not add
others.**

- Interest on an obligation or liability incurred by the servicemember (or
  the servicemember and spouse jointly) **before** military service is capped
  at 6% a year during military service - and, for a mortgage, trust deed or
  other security in the nature of a mortgage, during service and one year
  after.
- Interest above 6% is **forgiven, not deferred**, and the periodic payment
  must be reduced by the forgiven interest.
- "Interest" includes service charges, renewal charges, fees and other
  charges (except bona fide insurance).
- The servicemember gives written notice and a copy of orders no later than
  180 days after release; the cap then applies as of the date they were
  called to military service.
- DMDC's SCRA website checks active duty on a status date, whether the
  person left active duty within the 367 days before it, and whether they
  were notified of a future call-up; the status date cannot be in the future.

Things Muster deliberately does **not** decide: whether a home-equity line
is "a security in the nature of a mortgage" (guessed as a mortgage, flagged
to check, editable); whether a co-borrower who is not a spouse makes a loan
eligible (a note on every borrower-2 case says to confirm who borrower 1 is);
anything about the Military Lending Act or other law.

## The DMDC layouts - checkable, not fact

**The request layout** (`DEFAULT_LAYOUT`) is from memory of DMDC's published
"Multiple Record Request" format; DMDC's site and user guide could not be
reached from the build session. Fixed width, 119 characters a line: SSN 1-9,
date of birth 10-17 (YYYYMMDD), last name 18-43 (26), first name 44-63
(20), customer record ID 64-91 (28), middle name 92-111 (20), active duty
status date 112-119 (YYYYMMDD). Spaces pad on the right; an empty optional
field is all spaces. The page shows it as **"Request layout - DMDC SCRA
multiple record request"** with the line "Check these positions against the
current DMDC SCRA User Guide ('Format of the Request File') before your first
upload. DMDC checks every file it receives, so a wrong layout is refused
rather than misread." Every start and length (and the line length) is
editable; `layoutProblems` refuses overlaps, a field past the line, an SSN
under 9 or a date under 8 characters, and a bad layout never builds
(`cleanLayout` falls back to the default). Saved locally and in synced
settings; Reset to default.

**The results layout is not known and not hard-coded.** Two readers:

- **CSV/TSV with headers** - `guessResultColumns` by header words (customer
  record id, active duty status / start / end, left active duty within 367
  days and its dates, notified of a future call-up and its date, component,
  match or error text, status date), confirmed on the page. **Any SSN,
  date-of-birth or name column is ignored** (`RIGNORE`) - never offered,
  shown as "(ignored)" in the preview, never read, never kept.
- **Fixed width** - a ruler mapper: the first lines in monospace under a
  ruler, a span marked by dragging (or tapping the first then the last
  position, or typing start and length), the field picked from the fixed
  list. Spans are checked (`spanProblems`: overlaps, unknown fields, no
  record id) and saved as "My results layout" (local and synced). Runs of 9+
  digits are shown as bullets of the same width unless "Show numbers of 9 or
  more digits" is ticked, in case the file echoes SSNs.

Values: Yes/No/Y/N/True/False/1/0; dates YYYYMMDD, YYYY-MM-DD or MM/DD/YYYY
(nothing else). The example's results file is a CSV Muster makes up,
labelled **"Example results (made-up layout for this demo)"**.

## The decisions (`decide`, pure)

| Result | Decision |
|---|---|
| Not on active duty, not released within 367 days, no call-up | **No action** |
| On active duty since S, rate (with fees) at or under 6% | **No change - at or under 6%** |
| On active duty, originated before S | **Eligible** - cap S to E (open if none); a mortgage to E + 1 year |
| On active duty, originated on or after S | **Check policy** ("taken out during service...") |
| Left active duty on R (service from Rs), originated before Rs, a mortgage | **Eligible** - the tail to R + 1 year plus back interest from Rs |
| ...not a mortgage | **Eligible** under the proactive policy (owed Rs to R; "they can ask until R + 180 days") |
| Notified of a future call-up starting C | **Watch** - check again on C |
| An error or no-match text, no status, no start date, no rate, no origination, no result line | **Check by hand** |
| The file marks the cap already applied | **Already applied - confirm the dates** |

**The policy setting**: "Apply on a DMDC match without waiting for the
borrower's request" (proactive, the default) or "Wait for written notice and
orders" - eligible cases become **Tell the borrower - awaiting notice**, and
past R + 180 days **Check policy**. Changing it re-decides at once and is
logged. Fees count: a rate under 6% whose fees take the charges over it is
Eligible with the fees rule.

## The 6% math - an estimate, everywhere

Integer cents, BigInt where it multiplies, UTC day counts, today's balance
for the whole period (said so):

- over-interest = balance x (rate - 6.00 points) x days / 365, from the cap
  start to today (or the cap's end if sooner);
- fees in the period = monthly fees x days x 12 / 365 (fees count as
  interest);
- monthly payment drop while capped = balance x (rate - 6%) / 12 + monthly
  fees (never below 0; 0 once the cap has ended);
- the cap's end date (open, E, E + 1 year, R + 1 year).

Each case shows the lines ("$18,420.00 x 2.99% x 160 days / 365 = $241.43").
Rates are ten-thousandths of a percent (6% = 60000). Totals: records
checked, on active duty, eligible, est. owed, est. monthly drop.

## Storage: one module, borrowers never

- **SSNs, dates of birth and names live only in the reader's memory** (the
  worker, or the page without one) and are gone when the page closes. The
  request file is built there and handed to the page as text to download.
- **`public/muster-store.js` is the only module that touches browser
  storage** (IndexedDB, one `kv` store, every access wrapped; falls back to
  memory with a line saying so - "download each batch to keep it"), and
  everything it writes passes a core guard: `safeBatch` (rebuilt field by
  field; refused outright if a loan id carries someone's SSN or name - some
  books key loans on SSNs - with "use a short code from Muster"),
  `safeResults` (statuses and dates; free text scrubbed), `safeEvent` /
  `nextEvent` (the audit log), `cleanSettings`, and initials
  (letters, spaces, full stops). Notes are scrubbed before they are kept:
  SSN-shaped numbers and runs of 9+ digits, anything with an @, and - while
  the portfolio is open - that session's borrowers' names and dates of birth
  become "[removed]" (`scrubText`; the page says so). `app.js` touches no
  storage itself (tested).
- Kept: settings, device preferences (initials, the dismissed hint), and per
  batch the record, the results and the audit log. **The example is never
  saved** (a memory store of its own).
- **Batch records travel as a file**: Download the batch (record, results,
  log) and Load a batch file on another device - the log is verified link by
  link before it is accepted (`restoreAudit`).

## The audit log

Append-only: the store has no edit and no delete for one event (deleting a
batch deletes its log). Each event is `{seq, at, batch, kind, crid, field,
value, by, prev, hash}`, `hash = sha256(canonical JSON of the event without
its hash)`, `prev` the previous hash (the first points at 64 zeros); kinds
`batch`, `results`, `decision` (each case needing a person, at import),
`step` (rate, refund {date, cents}, letter, done, outcome, by), `note`,
`policy`. SHA-256 is handed in: SubtleCrypto on the page and in the worker,
node:crypto in the tests, over the same canonical form from the core.
**The worklist state is the log replayed** (`workFrom`), so the two can never
disagree. The page shows "Log verified - N events, each SHA-256-chained to
the one before" or the first broken link (an edit, a missing or out-of-order
event, a wrong link).

## The example (`public/demo.js`)

**Larkmoor Community Credit Union** - made up, said so everywhere; 60 loans,
70 borrowers (10 co-borrowers), invented names, every SSN in the 900-999
area (never issued; the example is the one place the check lets that area
through), the file `EXAMPLE-larkmoor-portfolio.csv` and an "EXAMPLE - do not
upload this file" banner on the request file. Dates count back from today,
so it works any day; the test holds every outcome on every fourteenth day for
a year, under both policies:

| Loan | Planted | Decision |
|---|---|---|
| LCU-40112 B1 | auto 8.99%, active, no end | Eligible |
| LCU-40127 B1 | card 24.99% + $3.95 fees | Eligible (fees counted) |
| LCU-40135 B1 | mortgage 6.875%, service ends in 65 days | Eligible, one-year tail |
| LCU-40141 B2 | personal 11.5%, the co-borrower serves | Eligible |
| LCU-40150 B1 | auto 5.25%, active | No change |
| LCU-40163 B1 | auto 7.49%, taken out during service | Check policy |
| LCU-40172 B1 | mortgage 7.125%, released 4 months ago | Eligible, tail running, back interest |
| LCU-40188 B1 | personal 9.99%, call-up in 45 days | Watch |
| LCU-40194 B1 | student 6.8%, "No match found" | Check by hand |
| LCU-40203 B1 | no date of birth | left out of the file |
| LCU-40216 B1 | a 30-letter accented last name | folded and cut, included |
| LCU-40229 B1 | SSN group 00 | left out of the file |

First run: two lines on the job, **Try the example** (one tap per step:
columns all recognised -> row checks -> the file with its ruler ->
"Pretend DMDC answered" -> decisions with a "Start here" hint on the top
Eligible case, open with its math) and **Check my portfolio** ("Read on this
device. SSNs never leave it and are never saved."). Saved batches are offered
on the first screen for when results come back a day later.

## Settings sync and the model call

- **Settings only**: `muster_settings/<owner tag>` = `{owner, settings,
  updatedAt}`; the tag is an HMAC of the account id under a key derived from
  `IDENTITY_SESSION_SECRET` ("muster owner v1"). The request layout, the
  results spans, column presets by header name, the policy, records per file,
  the line ending, the customer-record-id choice and the letter (template,
  servicer name, contact line). `PUT /api/settings {settings, base}` saves
  in a transaction only if `base` matches, else **409 with the account copy**
  (Merge / Use the account's / Keep this device's). Refused whole (400,
  nothing saved): unknown fields anywhere, any string with an @, an
  SSN-shaped number or 9+ digits in a row, a bad layout or span, a header
  that looks like a value. No secret: 503.
- **`POST /api/ai/letter`**: `requireUser, requireBudget, requireDailyCap`
  **then** the 8 KB parser (401 / 402 / 403 / 503 before it, never 413),
  then `letterRequest` rebuilds `{code, loanType, tone, newRate: 6, dates,
  amounts}` and refuses anything else (unknown fields, an @, SSN-shaped
  numbers, 9+ digit runs) - 400, no model call. One forced tool
  (`write_letter`) through one call site (`ai.ask`). The answer
  (`cleanAiLetter`): markup and invisible characters stripped; refused (422)
  if a required placeholder (`{{borrower_name}}`, `{{loan_number}}`,
  `{{servicer_name}}`, `{{contact_line}}`) is missing or another appears, if
  it names a web address or an email, names any law but the Servicemembers
  Civil Relief Act (or cites a section), uses any number or date not sent
  (6 and 6% excepted), or runs long. The sheet shows the exact JSON first;
  signed out it offers a free account; 402 the credit sheet; 403
  `verify-email` its sentence and "Send the link again"; sheets clear the
  confirm-your-email banner. The page fills the placeholders on the device.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8172/muster/
npm test        # the rules, the example, storage, hostile input, the worker in a thread, the page, then HTTP under /muster
```

`MUSTER_MEMORY=1` and `MUSTER_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`.
`MUSTER_COLLECTION_PREFIX` (`muster_` from the host) prefixes every
collection. `npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake
model refuses a call that does not force a tool, keeps every request, writes
a letter from the facts it was sent, and takes `fakeClient.mode` (`blank`,
`badnumber`, `url`, `law`, `placeholder`, `inject`, `maxtokens`,
`upstream401`, `upstream529`) for one call.

`test/run.js` (35 tests): reading; the column guess (the example exactly,
an awkward export with camelCase, co-borrower words, full names, P&I); rate
formats and the fraction question; ambiguous dates; **every row check**; the
fixed-width builder (exact positions, padding, truncation, folding,
119-character lines, CRLF/LF, split, file names, a future status date); the
layout (edited, overlaps and the rest refused); customer record ids
(cleaning, collisions, over-length, short codes); **the batch record holding
no SSN, date of birth or name**, and the guard against SSN-keyed loan ids;
the CSV results reader (ignored columns never kept) and the fixed-width
ruler mapping; matching back; **every decision branch**; **the math in
cents against hand-worked cases**; **the audit chain verified with
node:crypto** (edit, removal, swap, relink); the worklist; exports (CSV
injection, masking, escaped Markdown); the letter; the AI payload (built
from the decision alone) and answer checks; settings; **the example's
planted outcomes on 27 days across a year, both policies**; the example made
up (no real lender, bank, servicer or base); **storage holding no SSN, date
of birth, name or 9-digit run**; hostile input (markup, bidi, formulas, a
25 MB / 250,000-loan book in about 6 s); the real worker in a thread
(SubtleCrypto agreeing with node:crypto); contrast in both themes and the lab
card; the page's promises; no invisible characters or key-shaped strings; the
local switches; and over HTTP: signed out with zero model calls, no route
that takes a borrower, the gate order, one model call site, settings sync,
the AI route and its gates.

Screenshots at 390px and 1280px, light and dark (first run, row checks, the
request file with its ruler and layout table, decisions with the hint and the
math, a worklist card mid-way, the audit log verified, the exam-pack
summary, the letter from the template and from the fake model signed out and
in, the ruler mapper on an awkward fixed-width file, settings synced, the lab
card) and a hostile pass were taken with Playwright.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, the worker, the
service worker. Signed in, free: `GET|PUT|DELETE /api/settings`. Metered:
`POST /api/ai/letter`. The shared account at `/api/auth`. No route takes a
portfolio, a request file, results, a batch or a log (tested).

## Ideas not built yet

- **XLSX** exports read on the device (today: save as CSV).
- **A per-loan payment-history reader** to replace the estimate with the
  exact forgiven interest month by month.
- **Two reviewers**: a second set of initials before a case can be marked
  done.
- **The real results layout**, once someone checks DMDC's current guide -
  offered as a preset rather than hard-coded.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks and
  changes routed by one listener each (tested here and by
  `challenge/test/lab.js`). The worker is a same-origin file.
- No model call for a signed-out visitor, ever; every settings and metered
  parser runs after its gates.
- Files, typed notes, settings and model answers are untrusted: cleaned in
  the core (control, bidi and zero-width characters removed), bounded, and
  escaped on render (the test cuts out every `esc(...)` call and fails on
  anything else concatenated into markup). Exports defuse `= + - @` (and tab
  or CR) with a leading `'`.
- The service worker caches the app shell only - never api/, never a file a
  person loaded.
- Failures: only the app's own errors reach the page in their words; a
  provider error is a 502 (503 "The AI is busy"). Nothing logged carries a
  body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
