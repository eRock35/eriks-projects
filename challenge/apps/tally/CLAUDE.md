# For Claude: Tally

Close the day in a minute; know every card sale got paid. A café, a shop, a
salon or a restaurant **closes the day** by typing four numbers off the card
terminal's end-of-day report (card sales, refunds, card tips, the number of
card transactions) — or by **snapping** the report, which a model reads once (and, with the
report reader switched on, a processor's payout report too: see "The
redesign and the report reader").
Tally works out what should reach the bank (sales + tips − refunds − the
estimated fee) and **by when** (1–3 business days; weekends and bank holidays
roll forward). The owner then drops in the **CSV their bank's website already
offers**; Tally keeps the lines whose description names a card processor
(Square, Stripe, Clover, Toast, SumUp, Zettle, Heartland, Worldpay, "MERCH
DEP", "BANKCARD", … — an editable list) and **matches** each deposit to the
days it paid, batched weekends included. Every day comes back **✓ matched**,
**! short** (by $ and %), **… pending** (not due yet) or **× missing** (the
window passed and nothing came) — each with the reason in plain words
("Tuesday's $1,284.50 in card sales should have landed by Wednesday; nothing
yet"). The **month** is a calendar heatmap with totals (sales, deposited,
effective fee rate, money unaccounted for), the streak of reconciled days,
**fee creep** when the rate quietly rose, "Books balanced" confetti when a day
matches, and a **CSV export**.

Built 2026-09-26 as the ninth of Erik's lab drops, after Spar, Snapquote,
Chaser, Rave, Pop Quiz, Glowup, Booth and Receipt. **Staging only**: no custom
domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab — `challenge/apps/tally`,
served at `challenge.strongtechnicalconsulting.com/tally/`, data in `tally_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

Picked from two Friction problems: **"Matching card acquirer settlement files
to daily terminal totals by hand"** and **"Reconciling marketplace/PSP
clearing balances to bank deposits by hand"**.

Every day the terminal says "we took $X"; a day or three later the processor
deposits $Y — minus fees, holds, chargebacks and refunds, sometimes batched
over a weekend, sometimes split in two. Matching the two is a spreadsheet
chore, so small businesses don't do it, and the failures are quiet: a batch
left open on the terminal never settles, a chargeback is held without a word,
a rate creeps up 0.3 points (at $40k a month in card sales, $1,440 a year).
Tally makes the check a minute a day and says what is wrong in words a shop
owner uses.

**Who pays.** Nobody, for nearly all of it: typing a day, importing deposits,
the matching, the month, the streak, fee creep and the export never call a
model and are free forever. Snapping a report is about a cent on Haiku. The
membership buys the better model.

**How it becomes an iOS app.** The camera and on-device text recognition read
the Z-report without a model at all; a 9pm "close the day" notification; a
lock-screen widget with this week's unaccounted-for total; the export to the
share sheet; Shortcuts for "add today's totals" from a POS that exports them.
The data model does not change.

**The honest risk.** Every fee is an **estimate** from a flat % + per
transaction; real processors (interchange-plus above all) vary by card type,
so the allowance has to absorb that, and a statement is the truth — the page
says so beside every rate. Matching is heuristic: an owner with two
processors, or a processor that nets fees monthly instead of daily, will see
odd results (see "Ideas"). The bank CSV is a manual step every few days; a
bank feed would remove it and is deliberately not offered. The main
alternatives are the processor's own payout reports (one processor, no bank
side) and accounting software's bank rules (reconciles the deposit, not the
day's sales).

## The decisions that matter

- **Money is integer cents everywhere.** `rules.toCents` reads typed text
  digit by digit ("$1,284.50" → 128450, "0.1 + 0.2" as a number → 30), with a
  third decimal rounding half up from its digit, never through float
  arithmetic. Fees are `round(charged × bps / 10000) + tx × fixed`; percent
  settings are stored as basis points (2.6% = 260). The tests add thirty 10¢
  lines and get exactly $3.00.
- **One rules file, run twice.** `public/rules.js` is UMD: the page loads it
  as `window.TallyRules`, the server `require`s it. It holds money, the
  calendar, presets and settings validation, day and deposit validation, the
  fee model, `reconcile`, `explain`, the month, streaks, fee creep, the bank
  CSV parser and the export. The page reconciles `GET /api/books` in the
  browser; the export route reconciles on the server with the same code, so
  the calendar and the spreadsheet cannot disagree.
- **The settlement calendar is the Federal Reserve's.** Business days skip
  weekends and the Fed's holidays, observed its way: a Sunday holiday moves
  to Monday, a Saturday one to no weekday (July 3, 2026 is a banking day).
  A day's money may arrive from the day itself up to `windowDays` business
  days later ("due by"), or up to five more business days, marked late. On
  its due date a day is still pending; the day after, missing.
- **Matching, in passes** (`reconcile`). A deposit may pay a run of up to five
  *consecutive* open days (Fri–Sun on Monday; Sat, Sun and Labor Day on
  Tuesday). Each candidate run costs its relative difference, plus a little
  per extra day, a lot for a same-day deposit, some for lateness. Pass 1:
  every deposit within tolerance of some run claims the cheapest — exact
  matches first, so a short deposit can never take a day that has an exact
  one (tested with look-alike days). Pass 2: what is left goes to the closest
  run within 35%, else stays **unplaced** and is listed ("did you close the
  day before?"). Pass 3: two leftovers that together make a run exactly are
  one payout sent as two transfers, and a leftover that brings a short run
  back within tolerance joins it. A run's deposit is shared across its days
  in proportion to what each was owed, in whole cents, the last day taking
  the rounding.
- **Matched is "within the allowance"; creep hides there, so it is named
  separately.** A deposit is short when it is under the expected amount by
  more than max($2, 0.5%) (both settable). A matched day whose fee came in
  0.15 points (and $1) over the plan is flagged "fee higher than your plan".
  **Fee creep** splits the matched runs where the effective rate rose most and
  names it only when the later part is ≥0.15 points above the earlier part
  AND above the plan, with ≥3 runs each side: "3.65% → 3.96% since Mon,
  Sep 14 · about $138 a month at your volume".
- **Every flag explains itself.** `explain()` writes the sentence the page,
  the day sheet and the export all show: what was owed after fees, when it was
  due (and which holiday pushed it), what arrived, the gap in $ and %, and the
  likely cause. A missing day whose due date is after the newest deposit on
  file says "add newer bank lines first" instead of accusing the processor.
- **No bank connection, ever.** Deposits come from a CSV the owner downloads
  (Chase, Bank of America with its summary lines, Wells Fargo's headerless
  export, credit unions with Debit/Credit columns, semicolons). Money *in*
  only; the posting date wins, because it is when the money arrived.
  `POST /api/deposits/csv` parses in the request and saves **nothing**; it
  marks each line as a card payout (keyword, whole words: "TOASTED BAGEL" is
  not Toast) and as already in the books; the page pre-ticks new card lines
  and posts the ticked ones. Adding dedupes on date + amount + description.
- **The Z-report photo is read once and kept nowhere.** It is shrunk in the
  browser (1600px JPEG), checked by magic number and size *before* anything
  is spent (`lib/photo.js`, 400), read by the model through one forced tool
  (`read_z_report`, card totals only, never cash), and dropped with the
  request. `ai.cleanReading` then trusts nothing: amounts must parse as
  non-negative money (a refund printed "-45.00" is 45.00; a negative sale or
  tip is dropped), at most $10M, two decimals; the date must be a real day,
  not future, not over 13 months back; the count must be a whole number;
  markup is stripped; the processor is a preset or nothing. Unreadable, or
  no card total → 422. The reading comes back as a **proposal**: the form
  marks the fields it filled and lists what it would not trust, and only the
  owner's Save writes the day. The tests dump the store before and after.
- **Gates exactly as the siblings.** The one model route is
  `requireUser, requireBudget, requireDailyCap` (`spend`), and its 6 MB JSON
  parser mounts **after** them on that route only. The bank-CSV route mounts
  its own 2.5 MB parser after `requireUser`. Everything else is 128 KB. Only
  the app's own errors (`B.httpError`, marked `expose`) reach the page with
  their status; an upstream error is a 502/503 with the route's fallback — a
  provider 401 never tells a signed-in owner to sign in.
- **One document per day, keyed by its date.** Closing a day again replaces
  it (`replaced: true`), so a day is never doubled; the cap counts only new
  dates. Each deposit is its own document.
- **No model call and no write for a signed-out visitor.** The sample
  (`lib/demo.js`) is an invented café, "Copper Kettle Coffee", Sep 5–25, 2026
  on Square (2.6% + 15¢, next business day), pinned to its own today (Sat,
  Sep 26) so the story holds still: Sat–Mon over Labor Day paid Tuesday in one
  deposit; every weekend paid Monday; **fee creep** — payouts cut at 2.9% from
  Sep 14's sales, every one still "matched"; a **short** Wednesday (a $86.40
  hold on top of the creep, $90.45 against the plan); a **missing** Tuesday
  ($1,284.50 in sales); a **pending** Friday. 18 matched, streak 2 (best 11),
  $1,434.54 unaccounted for. The page reconciles it in the browser and lets a
  visitor change it in that tab only: close Saturday, change the fee
  settings, and — the delight — Tuesday's late payout is in the sample's bank
  export ("1 new card deposit") and on the missing day's card ("It turned up
  Friday — add it"): adding it balances the books, confetti, streak 8.
  Nothing is sent anywhere; a reload starts it over.
- **Status is never colour alone.** Every calendar cell carries a mark badge
  (✓ ! … ×) and an aria-label with the status in words; pills say the word.
  Confetti skips reduced motion.
- **Billed per request.** No timers, no background work: the page computes,
  the server answers and stops.

### Numbers

Expected deposit = (card sales + card tips) − refunds − fee, fee =
round((sales + tips) × %) + transactions × per-transaction fee. Nothing is due
(`none`) when that is ≤ 0. Tolerance = max(`tolCents`, expected × `tolBps`).
Presets (typical published US in-person rates, labelled estimates): Square
2.6% + 15¢, 1 day; Stripe 2.7% + 5¢, 2; Clover 2.6% + 10¢, 2; Toast 2.49% +
15¢, 2; SumUp 2.75%, 2; Zettle 2.29% + 9¢, 2; Heartland and Worldpay 2.9% +
10¢ placeholders (interchange-plus), 2. Month totals are over the days in the
month: deposited is each day's share; the effective fee rate is over matched
days only (a short deposit's gap is not a fee); unaccounted = short gaps +
missing days' expected; on the way = pending. The streak counts matched and
nothing-due days back from the newest settled one; pending days are skipped.
Heatmap buckets: matched green, short amber, missing red, pending grey,
nothing-due zero, no record empty.

Model: free tier Haiku 4.5, members Sonnet 5, via `identity.planFor`. A snap
is ~1.6k input (the photo) and ~120 output tokens.

## The redesign and the report reader (2026-11-23)

Erik asked for every lab app in the HOA Desk style with an AI feature that
fits it (`lab-notes/redesign-brief.md`). Tally's row: **Gemini - "Snap the
processor or Z report to reconcile card sales and payouts."**

### The look

- **White page, hairlines, one accent.** `public/app.css` is the whole
  design: `#fff` (true black in dark mode), 1 px `#e5e5ea` hairlines, 12 px
  cards, 10 px inputs and tiles, pill buttons and chips, no shadow except a
  faint one on what floats (the phone nav, sheets, toasts). The accent is the
  lab's ledger green (`lab.js` `#0e4526`; `#6fdba0` on black), used for the
  primary button, links and the active nav. Status colours only for status;
  the calendar keeps a quiet fill per status plus its mark (✓ ! … ×).
- **Lists over boxes.** The month's totals are a hairline 2x2, flags and
  deposits are divided rows, notices are an icon and words between two
  hairlines. Cards remain only where grouping helps (an import, a settings
  group, the "should reach your bank" figure).
- **Navigation.** One `<nav id="tabbar">` in the header. Phones: a floating
  translucent pill at the bottom (1.5 px line icons, the label only on the
  active item, a small accent dot, safe-area aware, 48 px targets). From
  900 px: a top nav with an underline. **The header's blur is on
  `.top::before`**, not the header: a backdrop-filter on an ancestor would
  make it the containing block of the fixed pill.
- **desktop.css is still linked but inert.** The page no longer has
  `class="dk"` on `<body>` or `.dk-tabbar` on the nav, so none of the shared
  rules apply; `.dk-split` / `.dk-sticky` are styled by `app.css` itself.
  Do not edit or unlink the shared file.
- **Type and space.** System fonts only, five sizes (13, 15, 16, 20, 28+),
  tight-tracked headings, tabular numbers wherever money lines up, 4/8
  spacing, 24-48 px between sections. The signed-out top is a centred hero
  (headline, one line, two pill buttons).
- **Icons** are one set of line SVGs in `app.js` (`ICON`); no emoji as
  icons. **No `style=` attributes** in the HTML or written by script (the
  confetti sets CSSOM properties, which is not an attribute).
- **Motion** (press states, the view rising in, the sheet, confetti, the
  spinner) sits inside `prefers-reduced-motion: no-preference`; every page
  is complete at rest.
- **Measured in headless Chrome** at 390, 320 and 1440 px, both themes, on
  every view including the sheets and the reading: lowest text contrast
  **4.66:1 light** (secondary `#6e6e73` on the `#f5f5f7` control fill) and
  **6.61:1 dark**; no horizontal overflow; no console or CSP messages.
  Targets are 44 px or more except calendar cells at 320 px (seven columns:
  37 px wide) - the day list under the calendar has full-height rows.
- **Taps from the signed-in home (Books):** close a day 1 (the tab), snap a
  report 2, add deposits 1 (2 to the file picker), settings 1, export the
  month 1, why a day is flagged 0-1 (the list is on the home; a cell opens
  the day).

### The AI feature: snap the processor or Z report

- **The switch.** `TALLY_AI_PROVIDER=gemini` turns it on; anything else,
  unset included, is **Claude exactly as before** (`providerNow()`, read per
  request). `GET /api/me` says which with `reader`: `zreport` (Claude) or
  `report` (Gemini), and the page draws the matching UI. Merging changed
  nothing live. Turning it on needs the lab's guard deployed and Vertex AI
  usable by `challenge-run@` (Erik's step, `challenge/CLAUDE.md`).
- **What Gemini does: transcribe.** `lib/gemini.js` asks
  `gemini-3.8-flash` (through `global.LAB_AI_GUARD.gemini.generate`, a
  `responseSchema`, temperature 0) for the figures **printed** on one
  report - a Z-report, a batch slip or a processor's payout report: report
  type, date (and period end), gross sales (every tender; shown, never
  used), card sales, refunds, tips, fees, net payout, the transaction
  count, card-type lines, batch numbers, the processor. Every figure is
  `{value, confidence}` and null when it cannot be read. The schema has **no
  free-text field** and no field for a sum, a difference, a verdict, a name,
  an address, a card number or a merchant id.
- **What Tally does: everything else.** `cleanReading` checks every field
  (amounts are text read digit by digit through `rules.toCents`, and a value
  with any character that is not part of a printed amount is dropped, not
  "tidied" - "1e9" is not $19; dates bounded; counts whole; known card types
  once each; batch numbers letters, digits and dashes with anything over 8
  digits cut to its last four). `rules.checkReport` then does the
  reconciliation, in cents, on the phone: do the card types add up to the
  card sales; does sales + tips - refunds - fees equal the payout printed;
  the fee printed (or left by the payout) against the plan, with the same
  0.15-point / $1 threshold as a matched day; what should reach the bank and
  by when (`expected`, `dueBy`); how it compares with the day already
  closed; and whether a deposit of that payout is in the books (or, for a
  closed day with no payout printed, the day's own `explain` sentence).
- **Unclear figures are confirmed before they are used.** A figure under
  0.8 confidence (`UNCLEAR_BELOW`) is listed in `unclear`. The page flags
  it ("Hard to read - is 171.40 right?"), keeps Close disabled and the
  "should reach your bank" figure blank until the form's flagged fields are
  settled (tap "Yes, it's right" or type the right one), and passes
  unconfirmed keys to `checkReport` as `unknown`, so no sum is worked out as
  if a doubtful figure were zero. Fees, the payout and the card-type lines
  can also be left out. Nothing is saved until the owner's own Close (the
  ordinary `PUT /api/days/:date`).
- **What is sent.** A photo is shrunk and re-encoded on the phone (1600 px
  JPEG, which drops its location and camera data), checked by magic number
  and capped at 4 MB before anything is spent, sent inline once, never
  stored or logged. A photo's pixels cannot be redacted, so the page says to
  frame just the totals, and nothing in the answer can carry an id. **Pasted
  text** (Gemini only: `{text}` instead of `{image}`) goes through
  `rules.scrubReportText` on the phone - the page shows exactly what will be
  sent - and again on the server: card, account, merchant and terminal
  numbers cut to their last four, emails, links and phone numbers out, the
  value of any line labelled cashier / server / customer / name / address
  removed; 6,000 characters at most.
- **Gates, in order:** `requireUser, requireBudget, requireDailyCap`, the
  6 MB parser, the input check (400 before any spend), the lab guard's
  `allow` (its friendly 429/503 message and `code` go to the page; no model
  call), one schema'd call, then `record` with `priceUsd` - including a call
  that failed after it was billed. The Claude path now asks the guard too
  (a member's own key is not counted against the lab's cap). A Gemini call
  is also charged to the person's own identity ledger at its real dollars
  (written as the Haiku input tokens that cost the same, route
  `snap:gemini-3.8-flash`), so the $2 credit and the free daily cap still
  hold. With no guard (the app on its own) only the stand-in can answer;
  a real Gemini call needs the lab.
- **Claude is the fallback for a photo (2026-11-23).** With the switch on, if
  the Gemini read of a photo fails for any reason but a burst refusal (a
  thrown call, a reading the validator rejects, the Gemini `monthly-cap`, no
  helper), the Claude Z-report reader answers it unchanged, marked `reader:
  'zreport'` so the page draws the old banner (`geminiElseClaude`; log
  `[tally] gemini failed (<code>); used claude`). Pasted text is Gemini's
  alone: its failure stays the app's own sentence. Bursts go out as they are.
- **The sample shows it without a model.** `lib/demo.js` hand-writes
  Saturday's batch report as a reading (through the real cleaner): tips hard
  to read, the fee printed at the crept 2.9%. With the reader switched on,
  "See a snapped report" on the sample's Close page draws it - "no AI ran" -
  and the check names the fee. With the switch off the sample is unchanged.
- **Stand-in.** `lib/fakeai.js` `gemini()` (under `TALLY_FAKE_AI=1`, refused
  on Cloud Run): `BLANK`, `NOCARD`, `INJECT`, `UNCLEAR`, `SMUDGE`, `PAYOUT`,
  `UPSTREAMnnn` in the photo's bytes or the pasted text, or
  `TALLY_FAKE_SCENE` for a browser run (the page re-encodes a photo, so a
  trigger in its bytes would not survive).
  `TALLY_AI_PROVIDER=gemini TALLY_FAKE_SCENE="PAYOUT SMUDGE" npm run dev`.
- **Ideas:** offer "add this payout as a deposit" from a payout report
  (today the check only says whether it is in the books, so a later bank
  import cannot double it); a period report closing several days at once.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8110/tally/
npm test        # pure rules first, then end to end over HTTP under a /tally mount
```

`TALLY_MEMORY=1` and `TALLY_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE` set) — in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `TALLY_COLLECTION_PREFIX` (set
to `tally_` by the lab host) prefixes every top-level collection; the default
database is `challenge`. The fake model refuses any call that does not force
a tool and answers from the photo's bytes: `BLANK` unreadable (422), `NOCARD`
card and cash printed together (422), `INJECT` every value messy (three
decimals, a negative refund and tip, a fractional count, an impossible date,
markup, a made-up processor), `UPSTREAMnnn` fails like the SDK's APIError;
anything else is a tidy report ($1,284.50, $45.00 refunds, $96.20 tips, 96
transactions, dated today).

The suite (30 tests) covers cents, the fee model, windows over weekends and
holidays, every status with its sentence, batches, lateness, split payouts,
exact-before-short, fee creep (and no creep on a flat rate), streaks and
buckets, the sample's story, five bank CSV layouts, export escaping, all the
validators, the model-output cleaner, and over HTTP: the sample with zero
model calls and no writes, 401s and unread big bodies for strangers, CRUD,
per-user 404s, the CSV preview writing nothing and its parser bounds, the
export, snap (400 before spend, 422, 502, 413, nothing stored), out of credit
(402 while everything free works), caps and deleting everything; and for the
report reader: the schema (no free text, nullable figures), the cleaner
against hostile output, the text scrub, `checkReport`'s arithmetic and its
refusal to use unconfirmed figures, the provider switch defaulting to Claude,
and over HTTP with a stand-in guard: 400s before the guard, one schema'd call,
`allow`/`record`, the ledger charge, scrubbed text, 422/502/503, the guard's
refusal, 402 before the guard, and nothing stored.

## Data (Firestore: `tally_*` in the lab database `challenge`)

- `settings/<uid>` — business, processor, feeBps, feeFixedCents, windowDays,
  tolCents, tolBps, keywords, configured, updatedAt.
- `days/<uid>/items/<YYYY-MM-DD>` — date, grossCents, refundsCents, tipsCents,
  txCount, note, source (`typed | snap`), createdAt, updatedAt.
- `deposits/<uid>/items/<id>` — date, amountCents, description, source
  (`typed | csv`), createdAt.

Everything is under the owner's uid, so nobody else's date or id can name it —
every route is a 404 for anyone else's. Limits (`rules.LIMITS`): 400 days,
2,000 deposits, 500 deposits per add, CSV 2 MB / 5,000 rows, $10M per day or
deposit, 100,000 transactions, 40 keywords of 30 characters. JSON bodies
128 KB except snap (6 MB, after the spend gates; image 4 MB decoded) and the
CSV preview (2.5 MB, after sign-in). `clean()` cuts to four times its limit
before any pattern runs. `DELETE /api/books` (with `{confirm: "DELETE"}`)
removes every day, deposit and the settings.

Accounts are the shared identity (`identity` database), mounted at `/api/auth`
— one account and one $2 credit across the lab and every app.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/demo`, and `rules.js` (static).
Signed in: `GET /api/me`, `GET /api/books`, `PUT /api/settings`,
`PUT|GET|DELETE /api/days/:date`, `POST /api/deposits` (one, or
`{deposits: [...]}`), `PUT|DELETE /api/deposits/:id`, `POST /api/deposits/csv`
(preview only), `GET /api/export?month=YYYY-MM`, `DELETE /api/books`.
Metered: `POST /api/days/snap` (`{image}`; on Gemini also `{text}`).

## Ideas not built yet

- **Two processors** (a card terminal plus online orders): settings per
  processor and a keyword → processor map, so each deposit only matches its
  own processor's days.
- **Monthly-netted fees** (some interchange-plus merchants are paid gross
  daily and billed fees once a month): a "fees billed monthly" switch that
  matches deposits to gross and checks the fee debit separately.
- **The processor's own payout CSV** (Square, Stripe and Clover all offer
  one) as a second import that explains a short deposit line by line. (A
  photo or paste of a payout report is read since 2026-11-23, above.)
- **Chargeback/hold notes** on a short day, and "resolved" to take it out of
  unaccounted-for once the processor pays it back.
- **Reminders** ("you haven't closed yesterday") — needs a sender, which the
  platform deliberately doesn't have.
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Security fixes (2026-09-27)

- **A script CSP.** Every page now sends `script-src 'self'; object-src
  'none'; base-uri 'self'` with the existing `frame-ancestors`. Every app on
  the lab shares one origin, so injected script in one would run as all of
  them. The pages have no inline `<script>` or `on*=` handler; keep it that
  way (`challenge/test/lab.js` checks every `index.html`).

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
