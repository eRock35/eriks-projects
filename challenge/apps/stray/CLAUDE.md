# For Claude: Stray

Every stray payment home to the right account - with the reason it belongs
there. For loan servicing and cash-application teams at credit unions,
community banks and auto and consumer lenders - and anyone whose customers
pay without the right reference (property managers, schools, clubs, B2B
receivables).

- **Two files in**: the suspense list (payments: date received, amount, payer
  name as written, reference / memo, account number as given, method, an id)
  and the account list (account number, borrower, co-borrower, scheduled
  payment, past due, payoff or balance, due day, status, open invoice numbers
  for receivables). CSV or TSV, chosen or pasted. Stray **guesses which
  column is which** from header words and value shapes and shows the guess;
  the person fixes it with dropdowns before matching.
- **The matcher** scores every payment against the account list with
  plain-language reasons (below) and gives one of five verdicts: **Match,
  Check, Split, Two possible, No match**. It never posts anything.
- **The work queue**: a card per payment - the verdict, the payment beside
  the account with the differing digits marked, every signal that hit and
  every one that did not - and Accept / Pick another / Not this / Note. J/K/A/X/P/N
  on a desktop, one thumb on a phone. Filters by verdict and by days in
  suspense; a meter ("$1,555.94 of $13,246.66 out of suspense - 4 of 14
  payments") and an ageing strip (0-5, 6-15, 16-30, over 30 days, the oldest
  ringed, past "your policy's limit" counted).
- **Exports**: a posting file (a line per account a payment goes to), a
  research list (what was tried, the best candidate, the note) and the day's
  summary. All made on the device.
- **Signed in (free)**: settings follow the account - column layouts (header
  names only), extra nickname pairs, the late fee, the ageing limit,
  account-number hints. Never a value.
- **Metered AI**: the "which account is this for?" letter, and "help me map
  these columns".

Built 2026-10-29 as a **business** drop: Tada (2026-10-28) was everyday, so
today was the other kind. **Staging only**: no custom domain until Erik
decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/stray`,
served at `challenge.strongtechnicalconsulting.com/stray/`, data in `stray_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it was picked

It answers Friction's problem **"Payments arriving that can't be matched to a
loan account, held in suspense"**.

- **Every servicer has a suspense account.** Payments arrive with a
  transposed account number, a nickname, a business name, a memo nobody
  reads, or nothing at all, and land in suspense.
- **Working it is manual detective work in spreadsheets**: VLOOKUPs on account
  numbers that are a digit off, scrolling for a surname, adding up two loans
  to see if a check covers both.
- **Money sits there while a borrower thinks they paid**, and may be charged
  a late fee for a payment that arrived on time. Days in suspense are the
  metric that matters, which is why the ageing strip is on every screen.
- **It is a satisfying puzzle when done well** - "OKAFOR WM" is William
  Okafor, 104452 is 104425 with two digits swapped - and the reasons make
  that visible instead of a black box score.
- **It runs entirely on the device**, so borrower names, account numbers and
  amounts never leave it. That is the only way a credit union could try a
  lab app on real data.

Not a repeat: **Tally** matches card-terminal days to bank deposits (money to
money by date); **Tieout** checks a statement's own arithmetic; **Parity**
proves two tables match after a migration. Nothing in the lab or the portfolio
matches a payment to the account it was meant for by number, name and amount.

**Who pays.** Almost nobody. The demo, reading files, guessing columns,
matching, deciding, the meter and ageing, every export and keeping the
session are free, need no account and make no request. A free account keeps
settings across devices. The two metered things (Haiku for the free tier,
Sonnet for members via `identity.planFor`) cost about a cent each.

**How it becomes an iPhone app.** Not for loading 50,000 accounts on a phone:
for the supervisor's approval. The queue on a phone, one thumb: the reasons
side by side, Accept, next. A push when payments cross the ageing limit. The
core is one dependency-free UMD file that a core-banking integration could run
as is.

## The decisions that matter

- **No payment, account, name or amount ever reaches the server or a model.**
  `public/stray-core.js` (UMD: `window.StrayCore` in the page,
  `importScripts` in `public/stray-worker.js`, `require` in the server and
  tests) holds every rule. There is **no route that takes a payment**
  (`/api/match`, `/api/upload`, `/api/payments`, `/api/accounts`,
  `/api/suspense` are 404s, tested), the page's requests are listed by the
  test (`api/me`, `api/settings`, `api/ai/letter`, `api/ai/columns`, the
  auth and billing routes), and the core, the demo and the worker contain no
  `fetch`, no storage, no clock and no dice (tested). "Today" is handed in.
- **The worker** (`stray-worker.js`) reads the File itself (the text never
  passes through the page), keeps the parsed tables and the index, and
  answers `parse`, `prepare`, `restore`, `relink`, `rematch`, `explain` and
  `search` - all `StrayCore.createEngine()`. Without a Worker the page runs
  the same engine itself. 60,000 rows read in ~0.2 s in Chromium with no
  main-thread lag; 5,000 payments against 50,000 accounts index and match in
  about 0.6 s in Node. Name lookups lead with the payer's rarest word (usually
  the surname); a common first name adds candidates only when 60 or fewer
  accounts carry it, so "ANA" on 5,000 accounts costs nothing.
- **Reading** (`parseTable`): RFC 4180 - quoted delimiters, doubled quotes,
  line breaks in quotes; CRLF, LF, CR; a BOM; the delimiter sniffed from the
  first rows (`,` `;` tab `|`), Excel's `sep=` line honoured; a report title
  above the header skipped (the modal width decides the header row); a
  headerless file becomes Column 1..n; ragged rows padded or cut and counted.
  **Caps**, each said in words on the page: 20 MB a file, 5,000 payments,
  50,000 accounts, 60 columns, 300 characters a cell (cut as it reads, so a
  20 MB cell costs nothing); control, zero-width and bidi characters removed
  and counted; an unclosed quote noted. Formulas and markup stay text.
- **Money** is integer cents (`readMoney`: `$1,234.56`, `1.234,56`,
  `1 234,56`, `USD 412.37`, `(12.00)` and `12.00-` as negatives - a
  negative payment is skipped as a reversal; "free" is no amount). **Dates**
  (`readDate`): ISO, n/n/yyyy with the order detected per column (a first
  part over 12 means day-first), `Oct 5, 2026`, `05-Oct-26`; `yyyymmdd` and
  Excel serial days only in a column mapped as the date.
- **Column guessing** (`guessColumns`): per field and column, header points
  (rules per field, with the usual abbreviations: Rcvd, Amt, Acct No., Inst
  Amt, Bal, Nxt Due, Sts) plus value-shape points; a header that says
  "amount" over a column of names counts a third. Greedy, best pair first,
  each column once. Each field is sure / likely / unsure; when every field is
  sure the page shows a one-line summary ("Every column recognised") with
  "Check or change", otherwise the dropdowns, with "? Check this" marked.
  `mappingProblems` blocks matching with a sentence.
- **Shapes** (`SHAPES`): a fixed vocabulary of codes (`date`,
  `money-decimals`, `digits-mid`, `name-like`, `capitals`, `few-values`...)
  with no digit in any code. They are what the column helper is told.

### The matcher (`matchPayment`)

Candidates come from indexes, never a scan: account keys (and the digit tail
of `AL-209931`), every name token, every amount an account could be paid
(payment, past due, payoff, payment or past due plus the late fee, 2 and 3
payments), open invoice numbers. A candidate's score is its best
account-number signal + best name signal + best amount signal + timing, less
conflicts. The points are round on purpose (`POINTS`), and the page has a
"How Stray scores" sheet listing them:

| Signal | Points |
|---|---|
| Account number exact / once zeros, spaces, dashes, a prefix are ignored | 60 / 55 |
| An account number in the memo / an open invoice in the memo | 50 / 50 |
| Two adjacent digits swapped / one digit wrong | 40 / 30 |
| Name the same in any order / nickname or abbreviation / initial | 40 / 38 / 32 |
| Surname one letter off / a business named for the borrower / surname only | 24 / 20 / 12 |
| Scheduled payment, payoff / past due / plus the late fee, 2-3 payments | 32 / 30 / 28 |
| Received within 5 days of the due day | 5 |
| The number given belongs to another account / account closed | -25 / -15 |

**Verdicts** (`THRESHOLDS`): **Match** needs 70+, at least two kinds of
evidence (number, name, amount), a 20-point lead and no flag. Flags send a
strong candidate to **Check**: a one-digit-off number whose amount is not one
of the account's, a business payer with no number, the number given belonging
to someone else, a closed account. **Split**: no single match, and 2-4
accounts that share the payer's surname (or are named by a number in the
payment) whose scheduled payments add up exactly - a bounded subset-sum
(12-account pool, 6,000 steps at most, tested on a pool built to explode).
**Two possible**: two candidates at 45+ less than 20 apart, with "what tells
them apart" in words. **Check**: one at 45+. **No match**: nothing at 45+,
with what was tried ("Memo: 55120 is not an account number or an open
invoice", "Amount: $350.00 fits 12 accounts - too common to tell on its
own"). An amount alone never makes a candidate worth more than 30.

- **Names** (`parseName`, `nameLevel`): accents folded, apostrophes dropped
  (O'Brien = OBRIEN), honorifics and suffixes (Mr, Dr, Jr, III) and household
  words (family) removed, business words (LLC, Inc, Co, Landscaping, Auto...)
  removed and flagged; "HECTOR & ANA MARTINEZ" is two people sharing the
  surname; "Okafor, William" is read. Token order does not matter, initials
  count, and 85 groups of nicknames and abbreviations (Bill/Will/Wm/Liam =
  William, Liz/Beth = Elizabeth, Peggy = Margaret...) plus extra pairs from
  settings. Borrower and co-borrower are both tried.
- **Account numbers** (`acctKey`): LN / LOAN / ACCT prefixes always ignored,
  others from settings; spaces, dashes, punctuation and leading zeros
  ignored and said ("once dashes and leading zeros are ignored: 0010-4881 ->
  104881"); one digit off and two adjacent swapped found by generating the
  variants and looking them up; numbers in a memo are 5-12 digits (settings),
  never an amount or a date.
- **"Not this"** rules the top account out for that payment (or the split, or
  both of two) and matches it again in the worker; "Put it back" undoes it.
  **Pick another** searches every account by number or name, explains any
  account it finds (`explain`), and offers a hand-made split with amounts
  that must add up.

### The demo (`public/demo.js`)

A **made-up** Juniper Valley Credit Union auto-loan book (30 accounts) and a
suspense list of 14, written as two CSV files with core-banking headers, so
they go through the same reading, guessing and matching as anyone's. Dates
count back from the day the page hands in, and the matched accounts' due days
sit near their payments. The test holds each payment to its intended verdict
and account on every seventh day for a year:

| Item | Shows | Verdict |
|---|---|---|
| JV-4101 | an exact match | Match |
| JV-4102 | `0010-4881` for 104881 | Match |
| JV-4103 | `LN 0104425 OCT PMT` in the memo | Match |
| JV-4104 | 105372 for 105327 | Match |
| JV-4105 | 106913 for 106918, $300.00 not the $287.40 | Check |
| JV-4106 | OKAFOR WM for William Okafor | Match |
| JV-4107 | LIZ CHEN, the co-borrower Elizabeth Chen | Match |
| JV-4108 | two months at once | Match |
| JV-4109 | a payoff | Match |
| JV-4110 | HECTOR & ANA MARTINEZ, two loans, one check | Split |
| JV-4111 | DELGADO LANDSCAPING LLC for Rosa Delgado | Check |
| JV-4112 | J PATEL: Jaya's payment or Jonah's past due | Two possible |
| JV-4113 | NORTHSIDE AUTO BODY, INV 55120 | No match |
| JV-4114 | a mobile deposit with no name | No match |

The first-run screen offers "Try the demo" (one tap to a populated queue) or
"Use my own files" (nothing leaves this device; the columns it looks for;
the example files can be downloaded to see the shape). The first card shows a
dismissible hint pointing at the reasons.

## Storage: opt-in for anything from a file

- **Payments, accounts, decisions and notes** touch the browser's storage
  only when "Keep this session on this device" is ticked (off by default,
  with Clear) - `stray-session-v1`. Files too big to keep whole (the browser's
  quota) keep the decisions and notes only, which come back when the same
  files are loaded again (by payment id). A kept demo stores decisions only.
- **Settings** (`stray-settings-v1`: late fee, ageing limit, nicknames,
  prefixes, digits, layouts by header name) and **this device's preferences**
  (`stray-device-v1`: initials for "decided_by", the phone line that fills a
  letter's `{phone}`, the dismissed hint, the keep choice) are remembered on
  this device when changed; they hold no payment data. Nothing is written
  until a person changes one of them (tested in Chromium: an untouched
  session leaves storage empty).
- Every access is wrapped in try/catch (tested: three accesses, all wrapped).
- **Lab database**: `stray_settings/<owner tag>` = `{owner, settings,
  updatedAt}` and nothing else. The tag is an HMAC of the account id under a
  key derived from `IDENTITY_SESSION_SECRET` ("stray owner v1"). `PUT
  /api/settings {settings, base}` saves in a transaction only if `base` is
  the account copy this device last saw, else **409 with the account copy**;
  the page merges (`mergeSettings`: layouts and nicknames from both, the newer
  numbers) and retries. `cleanSettings(strict)` refuses unknown keys,
  nickname pairs that are not two words of letters, and layout headers that
  look like a value (an @, a run of 3+ digits, digits joined by punctuation,
  `<>{}\`) - the whole request is a 400 and nothing is saved. No secret: 503,
  and settings stay on the device. No query anywhere.

## The model calls (metered)

Both: `requireUser, requireBudget, requireDailyCap` **then** the route's own
parser (8 KB; 401 / 402 / 403 / 503 before it, never 413 - tested), then the
request rebuilt field by field (a 400 costs nothing), one forced tool through
**one call site** (`ai.ask`, one `client.messages.create`), then the answer
cleaned. Nothing stored, nothing logged.

- **`POST /api/ai/letter`** (`write_letter`): the body is `{situation, tone}`
  and nothing else - `no-match`, `two-possible`, `split-confirm`,
  `business-for-owner`; `friendly` or `formal`. Any other field (an amount,
  even rounded; a payer; a date; a reference) is a 400. The model sees no
  digit at all (tested). Back: a subject, a letter and an email with
  placeholders; `cleanLetter` keeps only `{payer_name}`, `{amount}`,
  `{date_received}`, `{reference}`, `{phone}` (other braces removed and
  counted), strips markup, bidi and anything shaped like a web address, and
  caps lengths. The page fills the placeholders on the device
  (`letterValues`, `fillLetter`) into an editable box.
- **`POST /api/ai/columns`** (`map_columns`): `{kind, columns: [{header,
  shape}]}` and nothing else. `columnsPayload` (the page) sends a
  value-looking header as "Column N"; `columnsRequest` (the server) refuses a
  header with an @, a run of 3+ digits or digits joined by punctuation, any
  shape that is not a code from `SHAPES`, and any extra field. The headers
  are fenced (`<<<COLUMNS`) as untrusted data. `cleanColumns` keeps known
  fields on real columns, each once; the page applies them as "AI's pick" for
  the person to check.
- The sheets show exactly what is sent first ("Only your column headers and
  their shapes - never a value"; the letter's two codes as JSON). Signed
  out, both say so and offer a free account; 402 opens the credit sheet; 403
  `verify-email` shows its sentence and "Send the link again"; sheets size
  themselves below the shared confirm-your-email banner.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8142/stray/
npm test        # the rules first, then end to end over HTTP under a /stray mount
```

`STRAY_MEMORY=1` and `STRAY_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `STRAY_COLLECTION_PREFIX` (`stray_`
from the lab host) prefixes every collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that does not
force a tool and keeps every request (`fakeClient.calls`). The requests carry
only codes and header names, so there is nowhere for a trigger word; a test
sets `fakeClient.mode` (`blank`, `inject`, `maxtokens`, `upstream401`,
`upstream529`) for one call.

`test/run.js` (33 tests): CSV quoting, line endings, BOM, delimiters, `sep=`,
a preamble, no header, ragged rows, duplicate headers; hostile files (60,000
rows capped and counted, a 2 MB cell, 80 columns, bidi and zero-width,
unclosed quotes, formulas and markup kept as text); money and dates; column
guessing on the demo, awkward headers and a headerless file; shapes and saved
layouts; names (accents, honorifics, businesses, households, comma form,
order, initials, nicknames, settings pairs, a one-letter slip); account
numbers (exact, normalised, prefixes, swapped, one off, the digit named);
memos and invoices; amount signals; verdicts and flags; two possible and the
crowded amount; splits (pairs, triples, no household, "Not a split", a pool
built to explode stays under the step cap) and "Not this"; **the demo's 14
verdicts and accounts on 53 days across a year**; the meter, posting rows,
the research list and the summary; CSV injection; settings strictness and
merge; both AI payloads and answers; the worker driven in a VM context
(parse a File, prepare, rematch, explain, search, the 20 MB refusal); scale
(5,000 x 50,000); contrast in both themes and the lab card; the page's
promises; the local switches; and over HTTP: signed out with zero model
calls and 401s before every parser, no route that takes a payment, the gate
order, one model call site, settings sync (409, values refused, nothing
identifying stored), both AI routes (what the model saw, hostile output,
errors not passed on) and the 401 / 402 / 403 / 503 gates.

Screenshots at 390px and 1280px, light and dark - first run, the demo queue,
a card of each verdict, the split, Pick another with a hand split, the meter
mid-way and all decided, exports, own files with awkward headers (recognised
and opened), a headerless file and the helper signed out and applied, the
letter signed out and in, settings saved to the account - and a hostile-file
pass (markup, bidi, formulas, a 300 KB cell, an unclosed quote, 60,000
accounts; nothing injected, no dialog, no CSP violation, formulas defused in
the export) were taken with Playwright.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, the worker, the
service worker. Signed in, free: `GET|PUT|DELETE /api/settings`. Metered:
`POST /api/ai/letter`, `POST /api/ai/columns`. The shared account at
`/api/auth`.

## Ideas not built yet

- **XLSX** files (read on the device with a small parser; today: save as CSV).
- **A bank lockbox / BAI2 or NACHA return** reader for the suspense side.
- **Learning from decisions**: a payer name accepted for an account three
  times becomes an alias on this device ("NORTHSIDE AUTO BODY pays for
  Daniel Ruiz").
- **Two reviewers**: a supervisor approval step for Check and hand-picked
  decisions before they reach the posting file.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; every metered and settings
  parser runs after its gates.
- File contents, typed notes, settings and model answers are untrusted:
  cleaned in the core (control, bidi and zero-width characters removed and
  counted), bounded, and escaped on render (the test cuts out every `esc(...)`
  call and fails on any file field still concatenated into markup). Tables
  scroll in their own box. Exports defuse `= + - @` (and tab or carriage
  return) with a leading `'` and quote per RFC 4180.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
