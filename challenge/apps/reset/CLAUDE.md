# For Claude: Reset

Every rate reset worked out from the note - new rate, new payment, which
cap bit. For **servicing and loan-accounting teams at small banks and credit
unions**.

**This is a rebuild of the 2026-11-13 drop.** Reset was first built and
reviewed on 2026-11-13, then lost with its build container on 2026-11-20
before it was pushed. Erik asked for the lost drops back on 2026-11-21. Its
code and brief did not survive; this was built fresh from the
reconstructed spec in the repo-root `HANDOFF.md` ("Reset - business"),
which kept only its name, tagline, audience, emoji and colours. Everything
that spec names is here. It drops again as drop #66 on 2026-11-22.

- **One loan, one change.** A nickname ("Maple duplex 5/6" - never a
  borrower's name or a loan number), the current rate, the start rate (for a
  lifetime cap), the balance, the months left, whether this is the first
  change, the change date (optional), the index value, and the note's terms:
  the index's name, margin, rounding (nearest, up, down, none) and its
  increment, the lookback in days, months between changes, the first-change,
  periodic and lifetime caps, a floor, a ceiling, interest-only, and how the
  payment rounds (nearest cent or up). Reset gives the new rate, the new
  payment, **the rule that bound it** and the working: each rule in order,
  what it allowed and what it did, then the payment formula with the
  numbers in it. The page shows the result live as the form is typed.
- **A batch from CSV**, parsed on the phone (open a file or paste it; up to
  2,000 rows, 1 MB): the header names the columns in any order; each row is
  worked out or says what is wrong; a row whose nickname is refused shows
  "(refused nickname)" and is never echoed, on screen or in the export.
  Results as a CSV built on the phone (a Blob download) - a cell that would
  start a formula gets a leading quote, a plain negative number does not.
  A template CSV to download. The batch is never kept or sent.
- **Future resets under a what-if index**: the index stays, rises or falls
  by a step at each reset, or follows a typed list (the last value holds).
  Each later change uses the same rules (the first-change cap only once),
  the payment re-amortised over the months left, the balance paid down
  month by month at exact cents between changes. A step chart of the rate
  with the lifetime limit and floor dashed, and a table that scrolls in its
  own box.
- **A draft change notice** as plain text: marked a draft for a person to
  check against the note and the rules (Regulation Z for many US consumer
  loans) and **not legal advice**; brackets for the borrower's name and
  address, the loan number and the phone - which Reset never keeps or fills;
  the institution's name from More (kept on this phone only); old and new
  rate and payment, the index as of the lookback day, the margin, the
  rounding, the limits, which limit applied and a bracketed reminder to check
  the note for carryover. Copy, share or save as a text file.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/reset`,
served at `challenge.strongtechnicalconsulting.com/reset/`, data in
`reset_*` collections of the lab's `challenge` database. See
`challenge/CLAUDE.md`. Every browser URL is relative to `BASE`. Staging only.

## Why it exists

A **business** drop. At a small bank or credit union, an adjustable-rate
change is still often worked by hand from the note: look up the index as of
45 days back, add the margin, round to the nearest eighth, check the caps,
work the payment - for every loan that resets that month. A cent off is a
corrected notice; the wrong cap is a complaint. Reset does the sums exactly
and shows them, so a second person can check them.

**Not a repeat**: no lab app does loan arithmetic. Tally, Burnrate and
Parity are other money tools.

**No real lender, brand or person anywhere.** The demo's Quillmere Community
Bank and every loan in it are invented; the suite checks every file for a
list of bank, servicer and software names built from pieces. Index names
("30-day average SOFR", "1-year Treasury (CMT)") are public benchmarks, not
brands.

**The colours.** The original card was a brass #6d5200 and a ledger slate
#33475b; both were too close to newer cards in CIE Lab, so the lab card
moved to an olive brass #6f6303 and a ledger green #2a301e (the reasoning is
in `lab.js`: every dark blue that holds white text is taken). The app itself
keeps the original brass and slate. The emoji 📈 is used by no other card.

**Who pays.** Almost nobody. Everything is free and on the phone; a free
account keeps one book of loans in step across two phones. The one metered
thing - reading a note - costs about a cent (Haiku for the free tier, Sonnet
for members, via `identityLib.planFor`).

**How it becomes an iPhone app.** The camera straight into "Read the note",
the batch from the Files app, the notice through the share sheet.

## The arithmetic

All of it is in `public/reset-core.js` and nowhere else. **Nothing about
money or a rate is ever a float.**

- **Units.** A rate is a whole number of units of **0.00001** percentage
  point (100,000 = 1%; 7.125% = 712,500; a SOFR average to five places,
  4.31234%, = 431,234). Money is **whole cents**. Typed rates are read digit
  by digit ("7.125", "7 1/8", "1/8%", "-0.15"), never through parseFloat; a
  sixth decimal or an inexact fraction (1/3) is refused, not rounded.
- **The order of the rules**, as an adjustable-rate note states them:
  1. index + margin = the fully indexed rate;
  2. rounded to the increment: **nearest (a half rounds up)**, up (to the
     next increment above), or down; or not rounded. Rounding is on the
     number line, so -0.0625% to the nearest eighth is 0.000%;
  3. the change limit from the **current** rate, up or down: at the first
     change the first-change cap (or the periodic cap when the note has no
     separate first-change cap - the step says so), after that the periodic
     cap;
  4. the lifetime cap: never above the **start** rate + the lifetime cap;
  5. the ceiling (a stated maximum rate), if lower;
  6. the floor. Floor and ceiling are absolute and come last, so they win
     over the change limit when the two disagree (a current rate under the
     floor goes to the floor);
  7. never below zero (the zero guard), when the note sets no floor.
  **Caps never carry over**: an unused part of one change's cap is not saved
  for the next, and a rate held down by a cap is not "owed" later. Some
  notes do allow carryover; the draft notice carries a bracketed reminder
  to check, and Reset does not model it.
- **Which rule bound it** is the last one that moved the rate; if none did,
  "Index + margin" (or "Rounding" when rounding moved it). If the lifetime
  cap and the ceiling are equal, the lifetime cap is named.
- **The payment**: P = B × r ÷ (1 − (1 + r)^−n), r = the annual rate ÷ 12,
  n = the months left, B the balance - worked as ONE exact fraction with
  BigInt, `B·R·(D+R)^n / (D·((D+R)^n − D^n))` with D = 120,000,000 (R in
  units, r = R/D), then rounded once to the cent: to the nearest (a half
  cent rounds up) or up, as the loan says. At 0% it is B ÷ n.
  Interest-only it is B × r. Payments are monthly.
- **Between changes** (future resets) each month's interest is B × r
  rounded to the nearest cent, the principal is the payment minus that, and
  the last month of the term pays off what is left.
- **Days** are `YYYY-MM-DD` on day numbers with no clock and no time zone;
  a month added keeps the day or clamps to the month's end (31 Jan + 1 month
  = 28 Feb). The lookback day is the change date minus the lookback days;
  the first new payment is due a month after the change.

**Not modelled** (said here so nobody assumes it): negative amortisation and
payment caps, carryover, a first-change limit stated as an absolute range
rather than points, a lifetime floor below the start rate other than the
floor, separate up and down caps, payment frequencies other than monthly,
and a term that changes at a reset.

## The decisions that matter

- **One rules file, run three times.** `public/reset-core.js` is UMD
  (`window.ResetCore` in the page, `require` in the server and the tests).
  **No clock and no dice**: every time stamp and id is passed in (tested).
- **Loans by nickname only** (`nickProblem`): the text door (markup, bidi
  and invisible characters, an @ in any width, a link, a formula, a card
  number, nine digits in any script or a tax id's 3-2-4 shape, a phone
  number), then **six or more digits in a run** (spaces, dashes or dots
  between allowed) or a number after "loan no.", "acct #" and the like, then
  **what reads as a person's name**: an honorific, "Borrower: ...", a "Jr."
  shape, or a common given name or surname as a capitalised word. Names that
  are ordinary words a nickname uses (Grant, Mark, May, Hill, Brown, Lane,
  Chase ...) are deliberately not on the list. It is a guard, not a
  guarantee, and the page says to use a nickname. The same check runs in the
  form, the batch, the store, the server, and on pasted note text
  (`pasteProblem`, which lets amounts and dates through).
- **Refused, never cleaned.** A person re-types it.
- **The one door** (`cleanBook`): strict on the server (anything out of
  shape is an error and the whole body is refused), lenient for this
  phone's own copy (the bad loan dropped).

## The example (`public/demo.js`)

**Quillmere Community Bank** is invented, and so is every loan: seven, each
showing a different rule - Maple duplex 5/6 (a first change, held by the
first-change cap to 5.250%, $1,498.12), Harbor St condo 7/1 (periodic cap),
Orchard six-plex (rounding: 7.06234% to the nearest eighth is 7.000%),
Cedar Ridge lot (the index below zero, the floor binds), Mill building
(lifetime cap), Quarry Road warehouse (ceiling, under the lifetime cap) and
Kestrel 3/1 IO (interest-only, $765.63). An example CSV of seven rows, two
of them errors (a person's name as the nickname, a missing margin), and an
invented page of a note with a pre-made reading that carries a borrower, a
loan number and a balance, which the same check as a real reading drops.
Every view says it is made up; it is never kept, sent or synced.

**The tour**, six steps: the book (open Maple), which cap bit (the payment
working), future resets (index up ¼ point a reset), the draft notice, the
batch (the example CSV), and "Read the note" (the example page), then "Add my
first loan".

## Storage: one module, on this phone

`public/reset-store.js` is the only module that touches browser storage
(IndexedDB `kv`, every access wrapped, falling back to memory and saying
so): the book (through `cleanBook`), this phone's flags (tour, the
institution's name for the notice - refused if it reads as a person's name
or carries an @) and the sync base. Never a photo, pasted text or a CSV.
`app.js` touches no storage itself (tested).

## Sync (signed in, free) and the merge

`reset_books/<owner tag>` = `{owner, book, updatedAt}`, the tag an HMAC of
the account id under a key derived from `IDENTITY_SESSION_SECRET` ("reset
owner v1"). One book per account. `PUT /api/sync {data, base}` saves in a
transaction only if `base` matches the stored `updatedAt`, else **409 with
the account's copy** (`code: 'conflict'`); a book removed on another phone
is 409 `removed`. Refused whole (400) for an unknown field anywhere, an @,
nine digits, a link, markup, an invisible character, a refused nickname, a
rate or amount that is not a whole number of units, anything out of range,
a floor over a ceiling, more than 500 loans; ~400 KB stored (413); the 1 MB
parser after the sign-in; 120 saves per account per 10 minutes. The page
re-asks when it comes to the front and every minute.

**The merge** (`ResetCore.merge`): each loan by its own time; a removal is
a change like any other. **A loan both phones changed since they last
agreed** keeps the later one, and the other is kept beside it as "Nickname
(other phone)". Symmetric and idempotent (by hand and over 150 random
pairs, each result passing the strict door).

## The model call (metered, signed in only)

**`POST /api/ai/terms`** - "Read the note". `requireUser, requireBudget,
requireDailyCap` **then** the route's own 5 MB parser (401 / 402 / 403 / 503
before it, never 413 - tested), then `termsRequest` rebuilds the body to
**exactly `{images: [{type, data}]}`** (one or two photos of the rate-change
section) **or exactly `{text}`** (that section pasted, up to 6,000
characters, refused with no model call if it carries an @, a link, a phone,
nine digits or a tax id, a loan or account number, or what reads as a
name). A nickname, a loan, a question is a 400 `extra-field`. Each photo is
checked by its magic bytes (JPEG, PNG or WebP; 1.5 MB decoded; 1600 px a
side) and its metadata stripped again (`lib/image.js`, Ladle's but for
words).

One forced tool, `record_rate_terms`: index name, margin, rounding,
increment, lookback days, months between changes, the three caps, floor,
ceiling, interest-only, unsure - every rate **as a string as written**.
**No field for a person, an address, a loan number, a balance, a payment or
the index's value.** One fixed sentence (the pasted text goes between
markers after it). `max_tokens` 400 with the arithmetic in `lib/ai.js`.
`cleanAiTerms` keeps only those fields (any other is dropped and named),
reads every rate with Reset's own exact reader and range (one it cannot
read, or out of range, is dropped and named), and returns **form strings**
for the terms only - never a nickname, balance, current rate or index value;
nothing readable is a 422. The page fills the terms, marks the unsure ones
"check this", lists what was left out, and never saves: **Save** does. Before
the tap the sheet shows the exact photos or text and says "nothing else".
Signed out it offers a free account and the example. No model call for a
signed-out visitor, ever.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8178/reset/
npm test        # the hand-worked cases, the rules, the demo, storage, the look, the page, the copy, then HTTP under /reset
```

`RESET_MEMORY=1` and `RESET_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js` (the
tests spawn each with `K_SERVICE` set). `RESET_COLLECTION_PREFIX` (`reset_`
from the host) prefixes every collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that does
not force a tool, keeps every request, reads a made-up 5/6 SOFR note, and
takes `fakeClient.mode` (`blank`, `bad`, `inject`, `maxtokens`,
`upstream401`, `upstream529`) for one call.

`test/run.js` (35 tests) starts with **ten hand-worked cases, each with its
arithmetic written out in a comment** and every payment worked separately to
80 digits: index + margin; rounding (nearest, up, down, an exact half, a
negative half, none); the periodic cap up and down; a first change (the
first-change cap, then the periodic cap at a later change, and the periodic
cap at a first change with no first-change cap); the lifetime cap; the
ceiling under it; a negative index hitting the floor (and the floor winning
over the cap); the zero guard and B ÷ n; interest-only with a half cent and
rounding up to the cent; twelve months paid between resets. Then the exact
readers, days, nicknames and pasted text, the form, future resets, the
batch, the notice, the one door, the merge, the note request and the
reading, the demo, storage, contrast in both themes and the lab card (white
text, 20+ in CIE Lab from every card, drop #66, the emoji unique), the page's
promises, the copy and the local switches; and over HTTP: images by their
bytes, signed out with zero model calls, cross-site writes refused, the
gates before every parser, sync with its 409 merge and refused bodies, the
AI route (what the model saw, the answer checked, 422 / 502 / 503 / 413),
the 403 / 402 / 503 gates, and a hostile pass that leaves nothing personal
in the store.

**Rendered** in headless Chrome over the DevTools Protocol at 390 px and
1280 px, light and dark: the first run, the example's book, a loan with its
working, payment working and future resets, the notice, the batch with
results, "Read the note" (the example page, then filled), an empty "Add a
loan" and a typed one, More. No console error or CSP violation, nothing
sideways (the tables scroll in their own box), no target under 44 px.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/healthz`, `/api/meta`, `/api/me`, the page, the
service worker. Signed in, free: `GET|PUT|DELETE /api/sync`. Metered:
`POST /api/ai/terms`. The shared account at `/api/auth`. No route hosts a
loan, a batch or a notice (tested).

## Deliberately not built

- **A borrower's name, address or loan number anywhere**: the notice has
  brackets for them, filled in after it leaves Reset.
- **Sending the notice**: it is a draft for a person to check and send
  through the bank's own process.
- **An index feed**: the index value is typed (or in the CSV). A live feed
  would need a data licence and a network call the page does not otherwise
  make.
- **Carryover, negative amortisation, payment caps** (see "Not modelled").
- **Keeping a batch or a photo of a note**: worked out in the tab, gone when
  it closes.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks,
  changes and input routed by one listener each (tested here and by
  `challenge/test/lab.js`).
- Writes come from this page: every non-GET `/api/*` outside the shared
  account refuses `Sec-Fetch-Site` other than same-origin/none (403), an
  `Origin` naming another host (403) and a body that is not JSON (415).
- No model call for a signed-out visitor, ever; every sync and metered
  parser runs after its gates.
- Everything typed, synced or written by a model is untrusted: refused at
  the door or cleaned in the core, bounded, and escaped on render.
- The service worker caches the app shell only - never api/, never a loan.
- Only the app's own errors reach the page in its words; a provider error is
  a 502 (503 "The AI is busy"). Nothing logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
