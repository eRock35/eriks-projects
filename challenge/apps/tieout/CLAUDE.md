# For Claude: Tieout

Any bank statement PDF to a clean CSV - proven to tie out to the penny. A
bookkeeper drops in a **bank or credit card statement PDF** (or photos of
its pages), one model call reads every row, and then plain arithmetic -
run on the device - **proves** the reading: the opening balance plus every
row is the closing balance, the printed running balance follows row by row,
dates sit inside the period, nothing repeats across a page break, the
statement's own totals match. When it doesn't tie out, Tieout says **which
row** is wrong and why ("Off by $1,227.60 - Row 19 looks like 1,240.00 read
as 12.40 - a slipped decimal point") and offers the fix in one tap. Every
cell is editable inline with the checks re-running, a wrong page can be
**re-read** on its own, and the export is CSV, QuickBooks Online, Xero or
OFX - one statement or a run of months, with a warning where one month's
closing isn't the next month's opening. A bank CSV you already have is
checked and cleaned **free, with no account and no request at all**.

Built 2026-10-05 as a **business** drop in the alternation (Chorus, the
newest before it, was everyday). **Staging only**: no custom domain until
Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/tieout`,
served at `challenge.strongtechnicalconsulting.com/tieout/` once it has a
`lab.js` entry, deployed with `gcpdeploy ship challenge`. See
`challenge/CLAUDE.md` for mounting, prefixes and graduation. Every browser
URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

Built for three Friction problems, by title only: **"Bank statement PDF
parsing breaks per-bank; new format = new extractor"**, **"Bank statements
arrive as PDFs and must be re-keyed before reconciliation"** and **"Bank
statement importers fail silently with zero rows and no diagnosis"**.

Every converter on the market hands over numbers. **The difference here is
that Tieout never hands over numbers it can't prove**: a statement carries
its own arithmetic, so the extraction is checked against it, and a misread
row is named rather than buried in a CSV that reconciles wrong three weeks
later. A model read means no per-bank template to break; the checks mean the
model doesn't have to be trusted.

Not a repeat: **Drip** and **Shadow** read card CSVs on the device to find
subscriptions and software; **Receipt** reads receipts; nothing in the lab or
the portfolio converts or proves a statement.

**Who it is for.** Bookkeepers and accountants with clients who send PDFs,
small-business owners doing their own books, and finance teams whose bank
feed is broken or missing a month.

**Who pays.** Almost nobody. The two examples, the checks, the review, the
fixes, checking a CSV and every export are `public/tieout-core.js` in the
browser - no account, no model call. Two things are metered and signed in:
**converting a statement** (Haiku free, Sonnet for members via
`identity.planFor`), a few cents, and **re-reading one page**, about a cent.

**The honest risk.** A model can misread a figure, and a wrong figure in a
bookkeeper's ledger costs hours. So: the prompt says copy what is printed,
never compute a balance or total, never invent a row; an unreadable figure
is kept as a row with **no amount** (so the check names it) rather than
dropped or guessed; the checks are exact integer cents; and the export
sheet refuses (a disabled button) to download a statement that doesn't tie
out until the person ticks "Export anyway - I'll reconcile it myself". The
footer says "Tieout converts and checks statements. It is not accounting
advice - look over an export before you post it."

**How it becomes an iOS app.** The core is already one UMD file; a
share-sheet extension takes the PDF from Mail or Files, VisionKit's document
camera replaces the photo path, and the exports go to the share sheet.

## The decisions that matter

- **One rules file, run three times.** `public/tieout-core.js` is UMD
  (`window.TieoutCore` in the page, `require` in the server and tests):
  money, dates, masking, `cleanStatement`, `fromModel`, `check`, the fixes,
  the CSV reader, the chain and the four exports. The server cleans with it,
  the page checks with it, the tests check one file.
- **Signs.** A row's `amount` is signed by how money moved for the account
  holder: in positive, out negative - on a card too (a purchase is negative,
  a payment positive). Balances are as printed: on a card or line of credit
  the balance is what is owed, so `dirOf(type)` is -1 and money in lowers
  it. Every sum goes through that one function.
- **Money is integer cents** from the digits (`readMoney`): "$1,240.00",
  "(12.40)", "12.40-", "−12.40", "1.240,00", "12,40", "CR"/"DR". More than
  two decimals, words, "1e9", thousands groups not in threes, or over $1B
  (`LIMITS.maxCents`) is **no figure** - never rounded into one.
- **The checks** (`check`), each pass / look / fail with a sentence:
  - **Opening + every row = closing**, to the cent.
  - **Running balance, row by row** where balances are printed (often only
    once a day): each printed balance must equal the previous printed one
    plus the rows between. The first break and every later one (it resyncs
    from each printed balance, so one misread is one break, not a cascade).
  - **The statement's own totals** (deposits / withdrawals, or payments and
    credits / purchases and charges) and **page totals**, when printed.
  - **Dates**: present (fail), inside the period (look - on a card a
    purchase dated before the period that posted inside it is normal), in
    order (one row back in time is named; many is "normal for a sectioned
    statement").
  - **Repeats across a page break** (a page carrying its last line over):
    a look with a Remove button, or the diagnosis when the arithmetic says so.
- **The diagnosis.** For a stretch of rows that must move the balance by D
  cents, each row's would-be amount is `a' = a + dir·D`; how `a'` relates to
  what was read names the misreading: **sign** (a' = -a), **decimal**
  (×/÷ 10, 100, 1000), **two digits swapped**, **one digit misread**, or the
  row is a **repeat** of its neighbour (a' = 0). Ranked in that order; one
  candidate is "looks like", several are "Likely one of these:". One digit
  misread fits too many rows to name across a whole statement, so without a
  running balance (or a page/summary total to narrow it) it is not guessed
  at. No candidate means **a missed row** of exactly D, inserted before the
  break. Separately: a printed **balance misread** (the stretch into it off
  by e and out of it by -e while the total ties), a **closing balance**
  misread (nothing after the last printed balance), and on the first
  stretch the **opening balance** is offered as a culprit too. Without
  running balances, a summary total that is off on one side narrows the
  search to that side; both sides off by the same amount is a flipped sign.
  Every fix is `{op: amount|balance|delete|insert|opening|closing}` and
  `applyFix` applies it to a copy.
- **Status.** `ties` (the total, every running balance and every printed
  total agree), `off`, or `incomplete` (an opening/closing balance or an
  amount is missing - "Can't prove it yet"). Ties out with a fail elsewhere
  (a row with no date) says "1 thing to fix before export".
- **Reading** (`POST /api/read`): `{pdf: {data}}` or `{photos: [...]}` plus
  `name`. `requireUser, requireBudget, requireDailyCap`, **then** the 30 MB
  parser, then the file checks (`lib/files.js`: a PDF by its bytes, at most
  10 MB and 15 pages, not encrypted; up to 15 JPEG/PNG/WebP photos by their
  magic bytes, 3 MB each, 18 MB together - the page shrinks them to 2000px)
  - all before anything is spent - then **streamed whitespace**
  (`lib/stream.js`): a 15-page statement can take a minute or two. After
  that a failure is a 200 `{error}`. The model call itself **streams**
  (`messages.stream(...).finalMessage()`): `max_tokens` is 32,000, and the
  SDK refuses a non-streaming call that large. Forced tool
  `record_statement`; a PDF goes as a `document` block, photos as `image`.
- **Re-reading a page** (`POST /api/reread`): the same file again (the page
  holds it in memory while open; after a reload it asks for the file once
  more - it is never kept), plus `page` and **numbers only** for the prompt
  (type, year, currency, the running balance just before the page). Forced
  tool `record_page`, 8,000 tokens. For photos only that page's photo is
  sent. The page swaps that page's rows in (`replacePage`) and says how many
  changed. On the examples it is simulated, labelled, with no AI.
- **Model output is untrusted** (`fromModel`): every string stripped of
  markup, control and bidi characters and bounded; **any run of eight or
  more digits masked to "••••" and its last four** (an ISO date excepted),
  in every string - the prompt asks for the last four only and the server
  does not trust it; `accountLast4` kept as its last four; type, currency
  and dates from fixed lists or none; "balance forward" / opening / closing
  / total lines dropped with a note (one slipping through would double the
  opening balance); at most 2,000 rows. The fake model returns a full
  account number every time to prove it.
- **Failures** (`fail()`/`failure()`, Receipt's): only the app's own errors
  reach the page in their words; a provider error is a 502 (503 "The AI is
  busy"). Nothing logged carries a figure, a description or a byte of a file.

## Nothing is stored

Tieout has **no collection of its own** - not in the lab's database, not
anywhere. A PDF or photo is read once inside one request and dropped; the
rows go back to the page. `lib/store.js` holds only the memory stand-in for
the shared account and reads `TIEOUT_COLLECTION_PREFIX` the way every lab
app does, so a collection added later is prefixed from its first write.
Tested: after reads and re-reads the identity store holds no file bytes,
description, figure, file name or last four, and no file but
`lib/identity-store.js` opens Firestore.

**In the browser:** statements converted or checked are kept in
`localStorage` `tieout-v1` (24 at most, every access in try/catch) until the
person removes them - this browser only, never sent again. The export format
choice is `tieout-format`. The examples' edits live in memory and reset.

## The first run

The page opens on the hero ("Any bank statement PDF to a clean CSV - proven
to tie out to the penny.", **Convert your statement**, and "Already have a
CSV? Check and clean it - free, no account") and two made-up examples
(`public/sample.js`, computed so every printed balance and total is exact):

- **Business checking · September** - Example Community Bank ••4417, a
  coffee shop, 42 rows on 3 pages, a balance after each day. **Sysco's
  $1,240.00 on Sep 14 was read as $12.40.** It opens "Off by $1,227.60 -
  Row 19 looks like 1,240.00 read as 12.40 - a slipped decimal point." with
  **Make row 19 −1,240.00** and **Show row 19**; the running balance breaks
  at row 20, the withdrawals total is off by the same amount; one tap ties it
  out ✓ (with Undo). **Re-read this page** on page 2 shows the re-read flow.
- **Business credit card · September** - Example Card Services ••8823, 24
  rows on 2 pages, no running balance: ties out from the total and its own
  summary.

On a phone the statement is the verdict first, then the rows (one card per
row: number, date and amount, description, printed balance), then the proof
and the checks. From 1000px the rows sit left and a sticky column holds the
verdict, the proof (opening/closing editable in place) and the checks.

**Check a CSV** (`analyzeCsv` + `fromCsv`, all in the browser): paste or
drop a bank export; the header is found under any account-summary lines;
columns are mapped by header name (editable); newest-first files are turned
round; the sign of a lone amount column is worked out from the balance
column (whichever sign makes it run), else the majority on a card (most rows
are purchases); day-first dates detected; opening and closing come from the
balance column or are typed. **It never imports zero rows silently**: an
empty result says how many rows had no readable date or amount, with an
example value and the file's own line number. "Try a sample CSV" uses the
checking example as a bank would export it.

**Export** (`exportAs`, in the browser, nothing sent): pick statements
(several are ordered and **chained** - `chain()` warns, as a fail, when one
month's closing isn't the next one's opening or the periods leave a gap, and
as a look when they overlap or are different accounts), a format, signed or
debit/credit columns (CSV, QBO), and a date format.
- **CSV**: Date, Description, Amount (or Debit, Credit), Balance, Account,
  Currency, Page.
- **QuickBooks Online**: Date, Description, Amount - or Date, Description,
  Credit, Debit - MM/DD/YYYY by default, no symbols or grouping.
- **Xero**: *Date, *Amount, Payee, Description, Reference, Check Number
  (pulled from "CHECK 1043").
- **OFX 1.0.2** (SGML header, every element closed so it is also
  well-formed): one `STMTTRNRS` per bank account, `CCSTMTTRNRS` per card;
  consecutive months of one account are one aggregate; `TRNAMT` signed as
  money moved, `TRNTYPE` CHECK/DEBIT/CREDIT, FITIDs stable across exports,
  `LEDGERBAL` the last closing (negative on a card), ASCII only, `NAME` ≤ 32.
  `ACCTID` is `XXXX` + the last four and `BANKID` 000000000 - the importer
  asks which account; Tieout never holds the full number.
All CSVs: UTF-8 with a BOM, CRLF, quoted when needed, and the formula guard
(a cell starting `= + - @` tab or CR gets a leading `'`, except a plain
number such as `-1240.00`).

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8120/tieout/
npm test        # pure rules first, then end to end over HTTP under a /tieout mount
```

`TIEOUT_MEMORY=1` and `TIEOUT_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0`. `npm run dev` leaves the email gate on, so a
fresh local account sees the 403; add `REQUIRE_VERIFIED_FOR_FREE_AI=0` to
convert. The fake model offers `messages.stream` like the SDK, refuses a call
that does not force a tool, and answers from the file's bytes: `BLANK`,
`INJECT`, `ROWS2500`, `MAXTOKENS`, `UPSTREAMnnn`, `CARD`, `BADPAGE`, else the
checking example with its misread row; `record_page` answers the page asked
for, read right.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page. Metered
(`requireUser, requireBudget, requireDailyCap`, then the 30 MB parser):
`POST /api/read`, `POST /api/reread`. That is all - there is nothing to save.

## Ideas not built yet

- **Statements in an account** (synced across devices) - deliberately not:
  "nothing kept" is the promise, and it would need a retention story.
- **Splitting a PDF over 15 pages** client-side (pdf.js) so a long
  statement converts in parts automatically.
- **Categories / payees** for the export, learned from a client's history.
- **QuickBooks Desktop .qbo** (OFX with an Intuit bank id) and **CAMT.053**
  for European banks.
- **A bookkeeper's client link** to collect statements - needs Tipout's
  link and revocation story.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`
  (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; both metered routes' gates
  run before their 30 MB parser (tested: 401/402/403, never 413).
- Model output, a CSV and every typed cell are untrusted: cleaned in the
  core, escaped on render (`esc()` on every string), and escaped again in
  every export.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
