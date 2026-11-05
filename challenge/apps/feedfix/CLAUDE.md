# For Claude: Feedfix

Your bank file imported zero rows? Find out why - and fix it. For
**bookkeepers, accountants and small-business owners** who import bank
statement files into QuickBooks Online, Xero, FreeAgent, Wave and the like
when a bank feed is broken or missing.

- **Drop a statement file**: CSV, TSV or TXT (any delimiter), OFX / QFX
  (SGML 1.x and XML 2.x) or QIF, read in a Web Worker on the device. The
  format is told by what is inside, never by the extension.
- **The diagnosis**: every problem as a finding with a severity (**Blocks
  import**, **Will import wrong**, **Worth knowing**), the exact line or
  lines and a before / after preview; the one question it cannot answer
  alone (day/month or month/day?) with both readings and the one that
  keeps the statement in order; the running balance checked row by row;
  duplicates flagged; the columns as a list to check, with an AI helper.
- **The fix**: five target profiles; every fix listed with an **Undo**; the
  output read back as a new file and checked against its profile (the
  **re-check**); **totals before and after** - "19 rows · in €4,430.85 ·
  out €1,796.90 · same as the original".
- **Exports**: the fixed file, a masked diagnosis report (Markdown) and the
  duplicates list (CSV). All made on the device.
- **Signed in (free)**: settings follow the account - never a transaction.
- **Metered AI**: "Help me read these columns" - names and shape codes only.

Built 2026-11-05 as a **business** drop: Again (2026-11-04) was everyday,
so today was the other kind. **Staging only**: no custom domain until Erik
decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/feedfix`,
served at `challenge.strongtechnicalconsulting.com/feedfix/`, data in
`feedfix_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

Inspired by the Friction problem titled **"Bank statement importers fail
silently with zero rows and no diagnosis"** (named by title only).

- **Importers reject files for reasons nobody can see**: a byte-order mark
  in front of the first header, semicolons where commas are expected, the
  bank's name and the period above the header, a closing-balance row,
  dates that could be day/month or month/day, amounts written "1.234,56"
  or "(84.12)", two OFX transactions sharing one FITID.
- **And they say only "0 transactions imported"** - or import the file with
  the closing balance as a deposit and every date in the wrong month.
- **So people re-type statements by hand**, an hour at a time.
- **Feedfix is a file doctor**: it names the exact problem and the line,
  writes a clean file, proves it with a re-check and matching totals, in a
  minute, on the device, free.

**Not a repeat.** **Tieout** (2026-10-05) turns a bank statement *PDF* into
a CSV that ties out to the penny; **Tally** matches a shop's card sales to
its payouts; **Parity** proves migrated data matches. Feedfix starts where
those stop: a statement *file* that an accounting tool's importer refuses
or silently imports as zero rows. Nothing in the lab or the portfolio
diagnoses or repairs an import file.

**Who pays.** Almost nobody. The demo, reading files, the diagnosis, every
fix, the re-check, the totals and every export are free, need no account
and make no request. A free account keeps settings across devices. The one
metered thing (Haiku for the free tier, Sonnet for members via
`identity.planFor`) costs about a cent.

**How it becomes an iPhone app.** Not for 50,000-row statements: for the
small business owner with the bank's download in Files and an accountant
waiting - share the file to Feedfix, see "3 things stop the import", share
the fixed file on. The core is one dependency-free UMD file a practice's own
tooling could run as is.

## The decisions that matter

- **No row, amount or payee ever reaches the server or a model.**
  `public/feedfix-core.js` (UMD: `window.FeedfixCore` in the page,
  `importScripts` in `public/feedfix-worker.js`, `require` in the server and
  tests) holds every rule. There is **no route that takes a file**
  (`/api/upload`, `/api/fix`, `/api/diagnose`, `/api/convert`,
  `/api/statement`, `/api/transactions`, `/api/import`... are 404s, tested);
  the page's requests are listed by the test (`api/me`, `api/settings`,
  `api/ai/columns`, the auth and billing routes); the core, the demo and the
  worker contain no `fetch`, no storage, no clock and no dice (tested).
- **The worker** reads the File itself as bytes (the file never passes
  through the page as text), keeps each loaded file's bytes, and answers
  `load`, `diagnose`, `fix` and `drop` - `FeedfixCore.createEngine()`.
  Without a Worker the page runs the same engine itself. Caps, said in words
  on the page: **20 MB a file** (refused before it is read), **50,000
  transactions** (the rest counted), 60 columns, 500 characters a cell (cut
  as it reads). A 19 MB, 211,000-row file is read, fixed and re-checked in
  about 4 seconds in Chromium.
- **Bytes first.** Encodings are read by hand (`decode`): a UTF-8 or UTF-16
  byte-order mark, UTF-16 without one (every other byte zero), strict UTF-8
  with bad bytes counted, Windows-1252 when UTF-8 fails (an OFX that
  declares CHARSET:1252 is not a finding), NULs at the end, and files that
  are not text at all - an Excel workbook or a zip (`PK`), an old `.xls`, a
  PDF (pointing at Tieout), a picture, or binary junk renamed `.csv`.
  Garbled text ("CafÃ©") is repaired only when every character maps back to
  one Windows-1252 byte and the bytes are valid UTF-8 (`unmojibake`).
- **Delimited files** (`readDelimited`): the delimiter sniffed from the
  first 60 lines (`,` `;` tab `|`, Excel's `sep=` honoured), RFC 4180
  quoting. **A quote that never closes** - one that runs to the end of the
  file, or swallows a line that looks like a whole row - is read as a stray
  character on the line it opened on. **An amount split by an unquoted
  comma** ("1,250.00" written bare, so the row is one field too wide) is
  joined again where the joined field lands in an amount column.
- **The table**: the header is the first row as wide as the data, mostly
  words, none a date, with a header word in it or dates below it; rows above
  it are the **preamble**. No header: the columns are guessed from their
  values and a header is written. Below it, each row is a transaction or
  one of: **blank**, **page break** (the header repeated, "Page 2 of 3"),
  **summary** (opening / closing balance, brought / carried forward, totals,
  "End of statement", the person's own summary words; strong phrases mark
  a row whatever it holds, weak ones like "total" only a row with no date),
  and everything after the last transaction is footer. Opening and closing
  balances are kept for the checks.
- **Columns** (`guessColumns`): header words plus value-shape points, best
  pair first, each column once; Debit and Credit columns replace Amount.
  Sure / likely / unsure, shown as a list (header, sample values, a
  dropdown). The **shape codes** (`SHAPES`, no digit in any code) are what
  the AI helper is told.

### Dates

`dateParts` reads ISO (with times and zones), `yyyymmdd` only in a column
known to be dates, `dd.mm.yyyy`, `n/n/yyyy` and `n/n/yy` (00-69 is 20xx,
70-99 19xx), month names either way round ("31 Jan 2026", "Jan 31, 2026",
"31-Jan-26", a weekday in front), and Quicken's `1/31'26`. Invalid days are
refused (`2026-02-30`). `dateStyle` decides a column's n/n order: a first
part over 12 proves day/month, a second over 12 month/day, both is
**mixed** (each date is then read the only way it can be). **Every date 12
or under is the question**: `orderQuestion` reads the column both ways and
suggests the reading whose dates run in order (a statement is sorted,
oldest or newest first), else the shorter span, else the browser's own
habit (day first when it writes 14/11). Feedfix uses the suggestion until
the person answers; the answer is remembered per **named source** ("Lakeport
share draft = month/day").

### Amounts and signs

`readAmount` returns integer cents and notes on how it was written: currency
signs and codes, thousands separators (`,` `.` space, narrow space,
apostrophe), a decimal comma (decided per column by `amountStyle`; one value
like `12,50` can prove its own mark), parentheses, a trailing minus, CR / DR
spaced or glued (DR is money out), a typographic minus, more than two
decimals (rounded). "free" is not a number. Signs: a Debit column written
negative is still money out; **every amount positive** with a Type column
or OFX TRNTYPE saying debit -> those go negative; **every amount positive
with a running balance** -> each row takes the sign of the balance's move
(the first row cannot be told and is said so); **a whole file the wrong way
round** (the balance moves opposite to every amount) -> every sign flipped;
and "Flip every sign" by hand, for a card statement where purchases are
positive, remembered per named source. A mixed OFX where a few TRNTYPEs
disagree keeps the bank's amount and rewrites the type.

### The checks

- **Running balance** (`balanceCheck`): the best of four models (oldest or
  newest first, signs as written or inverted), then every row where it
  breaks - "Line 23: the balance moves $45.00 more than the amounts say, so
  a row may be missing between line 22 and line 23". Two rows on one day in
  the bank's own order are not a break. **Opening + the rows = closing**,
  from the summary rows (or the first balance less its amount).
- **Duplicates**: the same date, amount, description, payee and reference.
  Flagged, kept, listed with the line each repeats; left out only when the
  person taps "Leave out the copies".
- **OFX**: header problems strict SGML readers refuse (no blank line before
  `<OFX>`, blank lines or spaces before or inside the header, no OFXHEADER,
  DATA not OFXSGML, a missing header line; for XML no `<?OFX ...?>`),
  **duplicate FITIDs** ("importers keep the first and skip the second, with
  no error - £15.90 never arrives") and missing ones, DTPOSTED and TRNAMT
  not in OFX form, a bare `&`, sections left open, no BANKACCTFROM /
  CCACCTFROM, no CURDEF, NAME over 32 characters.
- **QIF**: a missing `!Type:` header, Quicken dates, the day/month question,
  an entry with no closing `^`, unknown codes counted.

## The targets (what each assumes)

The page says, beside the picker: "Check your software's current import
guide - these are the common shapes." Vendors change their importers; these
are the widely documented shapes, not promises about any vendor's rules.

| Target | Columns | Assumes |
|---|---|---|
| QuickBooks Online, 3-column | Date, Description, Amount | One amount, money out negative; MM/DD/YYYY or DD/MM/YYYY (chosen; starts on the browser's habit); a payee and description joined "Payee - description" |
| QuickBooks Online, 4-column | Date, Description, Credit, Debit | Money in under Credit, money out under Debit, both positive, the other cell empty |
| Xero | Date, Amount, Payee, Description, Reference | One amount, money out negative; the description goes under Payee when the file has no payee; DD/MM/YYYY or MM/DD/YYYY |
| Generic clean CSV | Date, Description, (Payee), (Reference), Amount, (Balance) | ISO dates; a bracketed column only when the file had it |
| OFX 1.0.2 | SGML statement | A clean header (`OFXHEADER:100 ... NEWFILEUID:NONE`, a blank line), CURDEF, BANKACCTFROM (BANKID 000000000 when unknown, said so) or CCACCTFROM for a card, DTSTART / DTEND, each STMTTRN with TRNTYPE (from the sign), DTPOSTED `YYYYMMDD120000` (noon, so no reader's time zone moves it to another day), a plain signed TRNAMT, a **unique FITID**, NAME up to 32 characters (the whole name kept at the start of MEMO), MEMO, CHECKNUM when short; LEDGERBAL when a closing balance is known; Windows-1252 bytes, CR LF |

Every CSV target: comma-separated, one header row, UTF-8 without a
byte-order mark, CR LF line endings, amounts as plain numbers with a dot and
two decimals, no preamble, summary, blank or page-break rows, invisible and
bidi characters removed, **formula-safe** (a text cell starting `=` `+` `-`
`@`, a tab or a carriage return gets a leading apostrophe; the diagnosis
names those cells, the fix list counts them, the report says so).

**FITIDs in the rebuild**: a FITID that was unique is kept; the second (and
third...) use of one becomes `<id>-2`, `<id>-3`; a missing one is
`FF<yyyymmdd><8 hex>` from an FNV-1a hash of the date, amount, name, memo
and its occurrence - the same every run, so importing the fixed file twice
does not duplicate it. DTSERVER is the statement's last day (no clock).

## The fix, the undo, the re-check and the totals (`fixFile`)

- **Every fix is listed** with its count and an **Undo** (Redo): the
  byte-order mark, the encoding, garbled characters, NULs, line endings,
  the delimiter, the sep= line, unclosed quotes, split amounts, the
  preamble, summary rows, blank rows, page breaks, dates, amounts, signs,
  FITIDs, TRNTYPEs, NAME length. An undone row-removal writes those rows
  back as they were. Some are **required** and say why: part of the format
  (a header for a headerless file, the OFX header, escaping `&`) or kept for
  safety (invisible characters, formula cells). Optional ones: leave out
  duplicate copies, leave out lines that cannot be read (never by default -
  an unreadable date is a real transaction), flip every sign.
  "Shaped for the target" lists what the profile itself does (payee and
  description joined, Debit / Credit combined, OFX converted to CSV...).
- **The re-check** (`recheck`) decodes the output bytes and runs the whole
  diagnosis on them (with the target's own date order and column map), plus
  a conformance check per profile: the exact header, the date format, plain
  amounts, one width, no blank rows, CR LF, no byte-order mark; for OFX a
  clean header, unique FITIDs, OFX dates and amounts, an account, a currency,
  every section closed. **Clean** means nothing that stops or spoils an
  import. Findings about the data itself (a balance that breaks, the
  opening and closing not adding up, duplicates kept) are **carried** - a
  file fix cannot change them - and listed as "still true of the data".
- **Totals**: before = the original as Feedfix reads it **with every repair
  on** (so undoing a repair that changes the money - the split amount, the
  signs, a quote - shows as a mismatch); after = the output read back.
  Rows, money in, money out, net, first and last date must match, less rows
  left out on purpose, which are listed with their lines. `ready` = a clean
  re-check and matching totals. Undoing "dates" on a Lakeport file for Xero
  re-checks clean (the dates still parse) and only the totals catch it -
  tested, on purpose.

## The demo (`public/demo.js`)

Three broken files from three **made-up** banks (tested against a list of
real bank names), payees like Lantern Hill Hardware and Cobble & Fern Café:

| File | Broken how | Diagnosis |
|---|---|---|
| Bank of Riverton, `riverton-checking-oct-2026.csv` | UTF-8 BOM, semicolons, three lines above the header, `1.250,00` amounts, a closing-balance row, a running balance | 3 stop an import · 3 would import wrong; the balance and the opening + rows = closing both check out; 19 rows · in €4,430.85 · out €1,796.90 |
| Lakeport Credit Union, `lakeport-cu-export.csv` | every date 12 or under (month/day, Feb 1 - Mar 12), `(84.12)` negatives, quoted `"2,150.00"`, a blank row, "Page 1 of 2", the header again, "Page 2 of 2" | 1 stops an import · 4 would import wrong; the question suggests month/day ("runs in order") over day/month ("jumps backwards once, 11 months") |
| Harbour Mutual, `harbour-mutual-oct-2026.ofx` | OFX 1.0.2 with no blank line after the header, FITIDs made from date + amount (two coffees and two courier charges share ids), a 39-character NAME, Windows-1252 | 2 stop an import · 2 worth knowing; "£15.90 never arrives" |

Every file re-checks clean with the same totals for **every** target (OFX
from a CSV needs an account, typed in the OFX details). The first-run
screen: two lines on the job, **Try a broken file** (one tap to Riverton's
diagnosis with a "Start here" hint ringing the semicolon finding, which
pulses) and **Check my file** ("Read on this device, never uploaded"),
the three demo cards, a drop zone (and the whole page takes a dropped file),
and what it catches.

## Storage: opt-in, settings only

- **This device**: nothing is stored unless "Keep my settings on this
  device" is ticked (Settings, off by default, with Clear) - and then only
  the settings and whether the hint was dismissed. **Never a file, a row or
  an amount**, even with it ticked. Three wrapped localStorage accesses
  (tested).
- **Lab database**: `feedfix_settings/<owner tag>` = `{owner, settings,
  updatedAt}` and nothing else (tested). The tag is an HMAC of the account id
  under a key derived from `IDENTITY_SESSION_SECRET` ("feedfix owner v1").
  `PUT /api/settings {settings, base}` saves in a transaction only if
  `base` is the account copy this device last saw, else **409 with the
  account copy**; the page offers Merge them (`mergeSettings`: every named
  source and summary word from both, this device's winning a source both
  name), Use the account's copy, or Keep this device's.
  `cleanSettings(strict)` refuses the whole body (400, nothing saved) for
  unknown fields anywhere (`rows`, `transactions`, a payee on a source...),
  more than 30 sources or 30 words, a profile, currency or date format not
  on the list, and **anything that looks like transaction data** in a label
  or word (`looksLikeData`): an `@`, a run of 4+ digits (an account or card
  number), an amount (`950.00`, `$12`), a date, markup, invisible
  characters. Settings: the default target, a date format per target, named
  sources (`{label, order?, flip?}`), extra summary-row words, a currency.
  No secret: 503, and they stay on the device. No query anywhere.

## The model call (metered): "Help me read these columns"

`requireUser, requireBudget, requireDailyCap` **then** the route's own 8 KB
parser (401 / 402 / 403 / 503 before it, never 413 - tested), then the body
rebuilt by `columnsRequest` - `{columns: [{header, shape}]}` and nothing
else. The page builds it with `columnsPayload`: each header (one that looks
like a value - an `@`, five digits in a row, digits joined like a date or an
amount, a currency sign before digits - is sent as "Column N") and up to
five shape codes from `SHAPES`. **The server refuses** an unknown field
(`sample`, `rows`, `values`), a header with an `@` or 5+ digits or a date or
amount shape (`value-in-header`), a shape code not on the list
(`unknown-shape`) - 400, no model call. The sheet shows the table of names
and shapes and **exactly the JSON** before the tap. One forced tool
(`read_columns`) through **one call site** (`ai.ask`); the names are fenced
(`<<<COLUMNS`) as untrusted. Back: `cleanColumns` keeps known fields mapped
to real columns, each column once and each field (but `ignore`) once,
Amount or Debit/Credit (never both), a confidence from the list (else low),
and a note with markup and links removed. The page applies it as a
proposal: each placed column says "AI · high" and the person checks it.
Signed out the sheet still shows what would be sent and offers a free
account; 402 opens the credit sheet; 403 `verify-email` shows its sentence
and "Send the link again"; sheets size themselves below the
confirm-your-email banner. Nothing stored, nothing logged.

## Exports

- **The fixed file** - `<name>-feedfix-<target>.csv|.ofx`, the exact bytes
  that were re-checked.
- **The diagnosis report** (`report`, Markdown): the file, the format, the
  verdict, every finding with its severity and line numbers, the day/month
  reading, every fix (undone ones struck through), what the target shaped,
  formula safety, the totals table and the re-check. **Masked**: no payee,
  no description, no single transaction's amount - counts and totals only
  (tested against the demo's payees and amounts). Markdown-escaped.
- **The duplicates list** (CSV): `line, same_as_line, date, amount,
  description, payee, reference`, formula-safe.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8148/feedfix/
npm test        # the rules, every target's bytes, every demo x target x undo, hostile files, the worker in a thread, the page, then HTTP under a /feedfix mount
```

`FEEDFIX_MEMORY=1` and `FEEDFIX_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `FEEDFIX_COLLECTION_PREFIX`
(`feedfix_` from the lab host) prefixes every collection. `npm test` runs
with `REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that
does not force a tool, keeps every request (`fakeClient.calls`), maps
columns from their names and shapes deterministically, and takes
`fakeClient.mode` (`blank`, `inject`, `maxtokens`, `upstream401`,
`upstream529`) for one call.

`test/run.js` (34 tests): encodings (UTF-8 BOM, UTF-16 both orders with and
without a mark, Windows-1252, bad bytes, NULs, Excel / old Excel / PDF /
picture / junk); hand-written UTF-8, 1252 and UTF-16 round trips, mojibake
repair and its undo, visible marks; delimiters and quoting, sep=, line
endings; unclosed quotes (to the end and mid-file) and split amounts and
their undos; preamble, header, summary rows, custom words, blank rows, page
breaks, no header; columns and shape codes; every date shape, invalid days,
two-digit years, mixed formats, unreadable dates kept and left out on
request; the day/month question (in order, shorter span, browser habit,
an answer); every amount shape; Debit/Credit, Type, balance-row and
inverted signs, the manual flip and the signs undo; balance breaks with the
gap, newest first, same-day order, opening + rows = closing; duplicates and
their CSV; OFX SGML header problems, FITIDs, DTPOSTED, TRNAMT, `&`, open
sections, no account or currency, long names, TRNTYPE signs; the OFX rebuild
(kept / suffixed / stable FITIDs, NAME into MEMO, credit cards, 1252, the
fitid undo), OFX 2 XML; QIF; **every target's exact bytes**; the demo's
findings, verdicts and hints; **every demo x every target re-checks clean
with the same totals, and every undo is noticed**; totals with removals;
formula safety, the masked report; strict settings and merge; the AI
request and answer checks; hostile files (markup, bidi, a 2 MB cell,
60,000 rows, 300 columns, quotes, broken OFX and QIF); **the real worker in
a worker thread**; contrast in both themes and the lab card; the page's
promises (no inline script, storage opt-in and wrapped, the locale fallback
for `en-US@posix`, no eval, every markup line escaped, the service worker);
made-up demo data; no invisible characters and no key-shaped strings in any
file; the local switches; and over HTTP: signed out with zero model calls
and 401 before every parser, no route that takes a file, the gate order,
one model call site, settings sync (409, transaction-looking settings
refused, nothing identifying stored), the AI route (values refused before
any call, what the model saw, hostile output, errors not passed on) and the
401 / 402 / 403 / 503 gates.

Screenshots at 390px and 1280px, light and dark - first run, each demo
file's diagnosis (Riverton with its hint), the day/month question and its
answer, Harbour's FITID before/after, the OFX rebuild and its preview,
Riverton for Xero with totals matching, the clean re-check, an undo the
re-check catches, exports, the AI sheet signed out, signed in showing
exactly what is sent, the columns it placed, settings synced - and a
hostile pass (markup and bidi in payees, a 19 MB and a 21 MB file, binary
junk and a spreadsheet renamed .csv) were taken with Playwright.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, the worker, the
service worker. Signed in, free: `GET|PUT|DELETE /api/settings`. Metered:
`POST /api/ai/columns`. The shared account at `/api/auth`.

## Ideas not built yet

- **More targets**: FreeAgent, Wave, Sage and QuickBooks Desktop's `.qbo`
  (an OFX with INTU.BID - kept when the source had one, not generated).
- **XLSX** read on the device (today: "save it as CSV" is the finding).
- **Several statements merged** into one file, overlaps found by FITID or
  by date + amount + description.
- **A watched-folder mode** on a desktop (the File System Access API) for a
  bookkeeper who imports the same banks every month.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; no eval or
  `new Function` (custom summary words become a `RegExp` with every
  character escaped); the worker is a same-origin file; clicks by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; every metered and settings
  parser runs after its gates.
- File contents, typed labels, the server's answers and the model's answers
  are untrusted: cleaned in the core (control, bidi and zero-width
  characters removed and counted - in previews they are drawn as marks
  instead, so the diagnosis can show them), bounded, and escaped on render
  (the test cuts out every `esc(...)` and fails on anything else
  concatenated into a line of markup). Previews and tables scroll in their
  own box.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
