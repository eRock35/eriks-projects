# For Claude: Tally

Close the day in a minute; know every card sale got paid. A café, a shop, a
salon or a restaurant **closes the day** by typing four numbers off the card
terminal's end-of-day report (card sales, refunds, card tips, the number of
card transactions) — or by **snapping** the report, which a model reads once.
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

The suite (23 tests) covers cents, the fee model, windows over weekends and
holidays, every status with its sentence, batches, lateness, split payouts,
exact-before-short, fee creep (and no creep on a flat rate), streaks and
buckets, the sample's story, five bank CSV layouts, export escaping, all the
validators, the model-output cleaner, and over HTTP: the sample with zero
model calls and no writes, 401s and unread big bodies for strangers, CRUD,
per-user 404s, the CSV preview writing nothing and its parser bounds, the
export, snap (400 before spend, 422, 502, 413, nothing stored), out of credit
(402 while everything free works), caps and deleting everything.

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
Metered: `POST /api/days/snap`.

## Ideas not built yet

- **Two processors** (a card terminal plus online orders): settings per
  processor and a keyword → processor map, so each deposit only matches its
  own processor's days.
- **Monthly-netted fees** (some interchange-plus merchants are paid gross
  daily and billed fees once a month): a "fees billed monthly" switch that
  matches deposits to gross and checks the fee debit separately.
- **The processor's own payout CSV** (Square, Stripe and Clover all offer
  one) as a second import that explains a short deposit line by line.
- **Chargeback/hold notes** on a short day, and "resolved" to take it out of
  unaccounted-for once the processor pays it back.
- **Reminders** ("you haven't closed yesterday") — needs a sender, which the
  platform deliberately doesn't have.
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
