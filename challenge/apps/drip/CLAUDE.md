# For Claude: Drip

Find every subscription quietly draining your account. Drop in the CSV your
bank or card already lets you download - **read on your phone, never
uploaded** - and Drip lists everything that bills you on repeat: what each
costs a month and a year, the next charge, and the things that make people
say "wait, what?" (a price that crept up, a $1 trial that turned paid, two
music apps, one that went quiet, a yearly renewal three weeks away). Then a
card stack: swipe right Keep, left Cut, up Not sure, and watch the savings
meter fill ("Cutting 4 saves $612 a year - that's a weekend away"), ending
with a cancel list and a reminder calendar for the next charges.

Built 2026-10-01 as the sixteenth of Erik's lab drops - an **everyday**
day in the alternation (Leash, the newest before it, was business).
**Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/drip`,
served at `challenge.strongtechnicalconsulting.com/drip/`, data in `drip_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the problem)

Subscriptions creep: a streaming service you forgot, a free trial that turned
paid, an app that raised its price twice, two music services, a gym you
stopped going to. Banks show charges one by one, never "here is everything
that bills you on repeat, and what it costs a year". Drip reads the statement
people can already download and turns it into that list, then makes deciding
fun.

Who it is for: anyone with a bank account or a credit card - especially
people who suspect they are paying for things they do not use.

Not a repeat: **Tally** reconciles a business's card payouts; **Dibs** splits
a dinner bill; nothing in the lab or the portfolio finds personal recurring
charges. A free pick from ordinary life (Friction's problems are business
ones).

**Who pays.** Almost nobody. Reading a statement, the flags, the swipe, the
calendar and adding drips by hand are free and need no account - there is no
server step in any of them. Saving the list needs a **free** account (no AI).
The one metered thing is **snapping a subscriptions page** (Haiku for the free
tier, Sonnet for members via `identity.planFor`), a cent or two.

**The honest risk.** Pattern-finding is a guess: a monthly-ish restaurant can
look like a bill, a bill paid from another card is invisible, and a bank's
descriptor can hide two services under one name. So the rules lean towards
missing a drip rather than inventing one (an unknown merchant needs three
regular, near-fixed charges; the curated table needs two), confidence is
shown, every drip can be edited or removed, and the page says once: "Drip
finds patterns in your charges - check anything before you cancel it."

**How it becomes an iOS app.** The statement read stays on the device (the
promise only gets stronger); Files/Share-sheet import for the CSV; the swipe
stack is native; reminders go to EventKit instead of an .ics; a widget with
"next charge: Streamio, Oct 12". Later, with Erik's say-so, a FinanceKit read
of Apple Card / Apple Cash transactions would remove the download step - it
too stays on the device.

## The decisions that matter

- **The statement never reaches the server.** `public/drip-core.js` (UMD:
  `window.DripCore` in the page, `require` in the server and tests) parses it
  in the browser. There is **no route** that accepts one (a POST to
  `/api/statement` is a 404, tested), `test/run.js` reads `app.js` and holds
  every request it makes to a short allowlist (`api/me`, `api/list`,
  `api/snap`, the auth and billing routes), checks that the import path makes
  no request at all, that the list save sends `drips.map(C.toSaved)` and
  nothing else, and the server strips anything else a save carries. The
  browser render pass intercepted every request during a real import, save
  and snap and found no statement content in any body.
- **Reading a statement** (`parseStatement`, `parseStatements`): ported from
  the approach of `shared/statement.js` (Trip Planner's), not the file.
  Columns by header name (transaction date over posting date; a `Merchant`
  column over a raw `Description`, which is Apple Card's), a summary block
  above the header (Bank of America), headerless exports by shape (Wells
  Fargo), separate Debit/Credit columns (Capital One, Citi), the sign of a
  lone Amount column decided by the majority (Chase and BofA write purchases
  negative, Amex and Discover positive; payments and refunds do not vote),
  `CR`/`DR` suffixes, comma/semicolon/tab, quoted fields with commas and
  doubled quotes, BOM, CRLF, blank and junk rows, `$1,234.56`, `(12.00)`,
  `12.00-`, decimal commas, `£`/`€`. Dates: ISO, MM/DD/YYYY (day-first only
  when the file has a first part over 12), DD.MM.YYYY, YYYYMMDD,
  "Sep 12, 2026", "12 Sep 2026". **Skipped and counted, never silently**:
  card payments, transfers (Zelle, ATM, to savings, a cheque, Venmo/Cash App
  without a `*` merchant), refunds and returns, interest, other money in, and
  unreadable rows; the page reports them ("Skipped 12 payments, 1 refund and
  1 interest line"). A "payment to Verizon" from checking is a bill, not a
  card payment.
- **Several files merge** (checking + each card, up to 6): a row in two files
  counts once, two identical charges in one file (two $0.99 app charges on
  one day) both stay - each key kept as many times as the file that has it
  most.
- **Limits**: 5 MB and 20,000 rows across the files, refused with a plain
  message ("Download a shorter date range"). A 5,000-row statement reads and
  searches in about 150 ms in Node (tested under one second).
- **Merchants** (`merchantInfo`): processor prefixes (`SQ *`, `TST*`,
  `PAYPAL *`, `GOOGLE *`, ...), `POS`/`CHECKCARD`/"PURCHASE AUTHORIZED ON
  09/17", "payment to", `*`codes, URLs, phone numbers, dates, store numbers,
  mixed letter-digit codes, a trailing state/country and a well-known city,
  a trailing "bill"/"payment". A curated table of **133 well-known
  subscriptions** (streaming, music, cloud, software, news, fitness, food
  passes, dating, games, phone/internet, insurance, learning, memberships)
  maps messy descriptors to a clean name, category and emoji - **names only,
  no cancellation URLs** (they change, and a wrong one is worse than none).
  Shop-type brands match only their membership descriptors (Costco's
  "ANNUAL RENEWAL", not a Costco shop). Unknown merchants get a cleaned name
  and a category by keyword. Money is integer cents read from digits.
- **Finding drips** (`findRecurring`): charges grouped by merchant key, then
  split into series - one per thing a merchant bills (Apple bills iCloud and a
  music plan separately): a charge joins the series it matches exactly, else
  the closest within 25% once a cycle has passed. Cadence from the gaps:
  weekly 6-8 days, monthly 24-37, quarterly 84-98, yearly 350-380, one
  skipped cycle forgiven. A known service needs 2 charges; an unknown one 3
  (4 weekly), near-fixed amounts (or a clean step up), and most of that
  merchant's charges - so the coffee shop you visit three times a week, the
  Thai place you go to about monthly, and a coincidental pair are not drips.
  One charge counts only as "probably yearly", for a known yearly service or a
  descriptor that says ANNUAL, with 40+ days of statement after it. The next
  date is anchored on the usual billing day, not the last jittered posting.
- **The flags**: price creep (amounts only ever rose, ended 2%+ higher:
  "went from $15.49 to $17.99 in May - up $30 a year"); trial turned paid (a
  $0-$1 charge 3-45 days before full price); doubles (two active services in
  music, cloud, fitness, food passes or dating - streaming is left out on
  purpose - and one merchant charging twice a cycle, which becomes two drips);
  gone quiet (no charge for a cycle plus grace before the statement's end:
  not counted in the total); renewal soon (yearly, in the next 30 days).
- **The swipe**: one card at a time, flagged first, then the biggest a year.
  Right Keep, left Cut, up Not sure, or the three 64px buttons, or ← ↑ →
  (z / Backspace undoes). On a phone **in the page** the card takes
  `touch-action: pan-y`, so a vertical drag still scrolls the page and Not sure
  is a button there; **Full screen** opens the stack as its own screen where
  all three swipes work. Reduced motion skips the fly-off, the count-up and
  the confetti. The savings meter's lines are `EQUIVALENTS` by amount,
  deterministic.
- **The summary**: kept / cut / not sure, the saving and its equivalent, the
  cut list with a generic how-to-cancel line each (gyms, phone and insurance,
  Apple and Google Play get their own), and an **.ics**: a "Cancel X before
  Oct 12" all-day event two days before each cut drip's next charge, and a
  heads-up a week before each yearly renewal not being cut - never in the
  past, RFC 5545 (escaped text, CRLF, 75-octet folding, a 9am alarm, UIDs
  from the drip and the kind so a moved date moves the event).
- **Snap the subscriptions page** (`POST /api/snap`): up to 3 screenshots,
  shrunk to ~1600px in the browser, `requireUser, requireBudget,
  requireDailyCap` **then** the 12 MB parser, bytes checked before anything is
  spent, ONE forced tool `record_subscriptions` `{items: [{name, price,
  cadence, renews}]}`, whitespace streamed. The prompt: read only what is
  shown, never invent a subscription, a price or a date.
  `Core.cleanSnapItems`: 60 max, names bounded and stripped of markup,
  control and bidi characters, prices through the cents parser (words, $0 and
  negatives dropped), cadence from a fixed set (synonyms mapped, anything else
  dropped), renewal dates checked against today. The page shows an editable
  review ("Already on your list" unticked) before any of it joins the list.
  Images are never stored or logged.
- **Saving** (signed in, free): one document per account, `lists/<uid>`
  `{drips, checkedOn, createdAt, updatedAt}`, each drip **only** `id, key,
  name, cat, cents, cadence, next, decision, notes, source, quiet`
  (`SAVED_FIELDS`) - never a transaction, a flag sentence or the statement
  (tested by saving a body stuffed with all three). 150 drips max, 60 saves
  per account per 10 minutes, a per-account queue so a double tap cannot race.
  Once saved, changes save themselves. Importing again shows **what is new,
  what changed price and what was not seen** since the last check
  (`compare`), and decisions and notes carry over (`carryOver`).
- **Signed out**, the list lives in `localStorage` `drip-v1` (every access in
  try/catch): the drips, their flag sentences and how many times each was
  seen - not the charges - plus the import's counts and date range. Signing in
  offers to save it; a list already saved to that account is opened.
- **Failures** (`fail()`/`failure()`): only the app's own errors reach the
  page with their words; a provider error is a 502 (503 "The AI is busy")
  sentence. Nothing logged carries a merchant, an amount or an image.

## The first run

The page opens on **Alex's** example: a year of one made-up credit card
(`public/sample.js`, seeded, dated relative to today, invented merchants
only - "Streamio", "TuneBox", "Melodia Music", "CloudVault", "FitNest Gym",
...) with 14 drips and ordinary spending that must not be detected. A year
rather than six months, because the yearly renewal is the drip people forget
most and a shorter statement cannot show one. On a 390px phone the first
screen is: the dark strip ("This is an example statement for Alex - swipe
through it, then try your own", a big **Check my statement**, "Read on your
phone. Nothing is uploaded."), the hero ("Alex has 14 drips costing **$218**
a month - $2,616 a year", a category bar with its text legend) and the three
most surprising flags (price creep, trial turned paid, two music apps).
Scrolling: the swipe stack, then every drip (tap to edit), gone-quiet ones
apart, and Snap / Add by hand.

**Check my statement** opens the import screen: "Read on this phone. Nothing
is uploaded.", three steps (sign in to your bank's website; Activity →
Download → CSV, 6-12 months; drop it here), a drop zone (several files),
"paste the CSV text", and the other ways in - **Snap my subscriptions page**
(asks to sign in; 401 → sign in, 402 → the credit sheet, 403 `verify-email`
→ its sentence and "Send the link again") and **Add one by hand**.

On a desktop the stack sits in a sticky right column beside the total, the
flags and the list.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8115/drip/
npm test        # pure rules first, then end to end over HTTP under a /drip mount
```

`DRIP_MEMORY=1` and `DRIP_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `DRIP_COLLECTION_PREFIX` (set to
`drip_` by the lab host) prefixes every top-level collection. The fake model
refuses a call that does not force a tool. Triggers in image bytes: `BLANK`
(nothing - the 422), `INJECT` (markup, bidi, words as prices, bad cadences
and dates, 70+ items), `MAXTOKENS`, `UPSTREAMnnn`. Anything else reads as
four invented subscriptions.

`test/fixtures/` holds nine bank exports written in the real shapes: Chase
card, Capital One, Amex, Bank of America checking (summary block), Wells Fargo
(headerless), Citi (status, junk footer), a European semicolon file (BOM,
CRLF, decimal commas), a UK card ("12 Sep 2026", £, parentheses) and Apple
Card (Merchant column).

## Data (Firestore: `drip_*` in the lab database `challenge`)

- `lists/<uid>` - `{drips: [{id, key, name, cat, cents, cadence, next,
  decision, notes, source, quiet}], checkedOn, createdAt, updatedAt}`.
  Nothing else: no transaction, no statement, no image, no email.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page. Signed in,
free: `GET|PUT|DELETE /api/list`. Metered (`requireUser, requireBudget,
requireDailyCap`, then the parser): `POST /api/snap` `{photos: [{type,
data}]}`. There is deliberately no route for a statement.

## Ideas not built yet

- **Shared household view** - two people's cards, one list ("we both pay for
  Spotify").
- **Price-rise alerts** between checks - needs a sender, which the platform
  does not have; the "since last time" card is the honest version.
- **OFX/QFX import** (some banks offer only that) - the same parser shape.
- **Currency conversion** for a card abroad; today one statement's currency
  is shown as found and the sums assume one currency.
- **A "used it?" nudge** per drip (a last-used date the person types).

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`
  (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the snap's gates run before
  its 12 MB parser (tested: 401/402/403, not 413).
- Statement text and model output are untrusted: every merchant name and
  every model string is cleaned (markup, control and bidi characters gone,
  bounded) and escaped on render; the .ics escapes its text.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
