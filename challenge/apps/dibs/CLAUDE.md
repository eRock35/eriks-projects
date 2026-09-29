# For Claude: Dibs

Split the bill by what everyone actually had. One person pays; Dibs reads the
receipt (**paste it** free, or **snap it** with AI), the host **shares a QR
code**, and everyone at the table **taps what they had on their own phone**
with no account. Shared plates, tax, tip, fees and discounts are split
**fairly to the cent**, the bill is **checked against the printed total**,
and each person gets a **Venmo, Cash App or PayPal link** to whoever paid,
plus a summary for the group chat.

Built 2026-09-29 as the fourteenth of Erik's lab drops, after Spar,
Snapquote, Chaser, Rave, Pop Quiz, Glowup, Booth, Receipt, Tally, Tipout,
Tells, Covenant and Hike - and the **first for everyday people rather than
businesses** (see "Who the drops are for" in `challenge/CLAUDE.md`).
**Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/dibs`,
served at `challenge.strongtechnicalconsulting.com/dibs/`, data in `dibs_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the problem)

Splitting a restaurant bill with friends is the worst part of a good night
out. One person pays, then either everyone splits evenly - and the salad
person subsidises the steak-and-cocktails person - or someone squints at the
receipt doing tax-and-tip maths on a phone calculator while the table waits.
Days later there is still a "who owes me what" thread.

Why it belongs in the lab: it is an everyday, social problem nearly everyone
has had, it is plainly an iPhone app (camera, QR, share sheet, pay links),
and it is fun at the table - the claim moment, "Everyone's claimed!", and the
fairness line are the bits people show each other. It is not a repeat:
**Tipout** splits a staff tip pool for a business by hours or points; Dibs is
friends splitting one bill by what each person ordered. A free pick (not
from Friction, whose problems are business ones).

**Who pays.** Almost nobody. Splitting a bill on one phone needs no account
and no model call (it lives in the browser). Sharing it with the table needs
a **free** account for the host only - so the table is theirs to lock or
delete - and **none** for guests, who never trigger a model call. The one
metered thing is **snapping a receipt** (Haiku for the free tier, Sonnet for
members via `identity.planFor`), a cent or two.

**The honest risk.** A photo can be misread and a paste can be odd; so the
page always shows a review before anything becomes the bill, and the check
names any gap against the printed total rather than fixing it ("Items add up
to $3.50 less than the receipt - a line may be missing"). The footer says it
once: "Dibs does the maths; check it against your receipt." A guest could
pick the wrong name; the host can free it.

**How it becomes an iOS app.** VisionKit for the receipt, an App Clip from
the QR code so guests need nothing installed, the share sheet for the
summary, Venmo/Cash App universal links, a Live Activity with "3 of 4
claimed". The data model does not change.

## The decisions that matter

- **One rules file, run twice.** `public/dibs-core.js` is UMD
  (`window.DibsCore` in the page, `require` in the server and tests): money
  parsing, `parseReceipt`, `cleanBill`/`cleanPeople`/`cleanClaims`, the
  totals and the check, the split, fairness, handles, pay links and the
  summary. Host, guests and tests compute the same numbers from one file.
- **Money is integer cents**; typed money is read from its digits
  (`toCents`: "$1,240.50", "12,50", "£3", "45¢"; anything without a digit is
  no figure; a negative only where a discount is expected: "-4.00",
  "(4.00)", "4.00-"). Percentages are basis points. Products go through
  BigInt (`mulDiv`, `allocate`).
- **Every pool is allocated with the largest remainder** (`allocate`): each
  person gets the floor of their exact share, the spare cents go one each to
  the biggest remainders, ties to the larger weight then the earlier
  position. So the people plus the unclaimed rest add up to **exactly** the
  bill, and every phone agrees. A 3,000-bill property test holds it.
- **The split** (`split`): a line of qty q at unit u is claimed by weights.
  While the weights add up to less than q, each person pays u x their units
  and the rest is unclaimed (a qty-3 line claimed a unit at a time); once they
  reach q, the whole line is shared by weight (3 people on 2 margaritas pay
  two-thirds of one each; 2:1 on a pizza is 2/3 and 1/3). "Among everyone"
  splits what is left of a line evenly across everyone at the table. Tax,
  fees, discounts and the tip are then shared **in proportion to each
  person's items**; the unclaimed rest carries its own share, so claiming it
  later moves its tax and tip with it. The tip can instead be split evenly.
- **The tip**: a percent of the food and drink by default (toggle: of the
  total with tax), or a typed amount. A service charge or automatic gratuity
  on the bill is detected (`fees[].service`, with its rate when printed) and
  the tip starts at nothing, with "A 20% service charge is already on this
  bill". A tip printed on the receipt comes in as an amount and counts
  toward the printed total in the check.
- **Reading a paste is deterministic and free** (`parseReceipt`): the last
  money token on a line is its price (tax flags like "15.00 T" dropped), qty
  from "2 x", "x2", "2x", "Margarita x2", "2 @ 12.00", POS columns
  ("Margarita 2 12.00 24.00") and a bare leading count up to 5 ("12 Wings" is
  one order of twelve); SUBTOTAL / TAX (summed) / TIP / TOTAL / SERVICE /
  fees; discounts as negatives in three spellings; decimal commas, pounds,
  euros; "VAT included" is not added. Junk - card numbers and payment lines,
  staff, table/check/order numbers, dates and times, suggested-tip tables,
  phone numbers, "thank you" - is skipped and **listed with its reason**.
  ALL-CAPS names are tidied ("LUIGI'S TRATTORIA" -> "Luigi's Trattoria",
  IPA and BBQ kept). 120 lines max, input cut to 20,000 characters, linear
  time on hostile input.
- **Snap the receipt** (`POST /api/snap`): up to 2 photos (a long receipt in
  halves), shrunk to ~1600px in the browser, `requireUser, requireBudget,
  requireDailyCap` **then** the 12 MB parser, bytes checked before anything
  is spent, one forced tool `record_receipt`, whitespace streamed. The
  prompt: read what is printed, never invent a line or a price, and if the
  maths does not add up say so in `mathsNote` rather than fix it.
  `ai.cleanReceipt` puts every price through the cents parser (words, $0,
  negatives and over $10,000 a unit are dropped), bounds and strips every
  string, caps at 120 lines and keeps the printed subtotal and total as
  printed. The page shows an editable review with the check and the
  reader's note before anything becomes the bill. Photos are never stored or
  logged.
- **Tables are one document** (`tables/<CODE>`), so a guest's poll is one
  read and `?since=<v>` answers `{same: true}` when nothing moved. Every
  write goes through `store.transact` - a Firestore transaction, a queue in
  memory - so **two phones calling dibs at once both stick** (tested with six
  phones, eighteen claims fired together; the test also shows the same
  writes without the transaction losing one).
- **Guests need no account.** A guest key (22 random characters) lives in an
  HttpOnly cookie `dibs_k` scoped to the app's path; it is minted only on
  join, never stored - each table keeps `sha256(key + code)`, so one phone is
  unlinkable across tables. Everyone else sees only a random per-table
  person id, a name and a colour. A guest joins as one of the names the host
  typed ("I'm Ana") or as someone new, and may change only **their own**
  dibs, name/colour and "I've paid". The host (`ownerTag` = HMAC of their
  account id under a key derived from `IDENTITY_SESSION_SECRET`, so the
  table holds no account id or email) can do anything: anyone's dibs, the
  bill, people (add, rename, remove, free a name for another phone), "among
  everyone", confirm payments, lock ("Done - everyone pay up": guests can no
  longer change dibs, but can still mark paid) and delete. Every host route
  is the same 404 as a missing code for anyone else. With no secret on the
  server, sharing answers 503 rather than tagging under an empty key.
- **Limits** (`lib/tables.js` LIMITS, per instance, in memory, like
  Receipt's): 20 people a table; 30 new guests per address an hour; 30
  **distinct** wrong codes per address in 15 minutes, then even the right
  code waits (a dead code polled again counts once); 600 table writes per
  address in 10 minutes; 20 open tables per host. IPv6 counts by its /64.
  Codes are 6 characters from 32 unambiguous ones (no I, O, 0, 1), about a
  billion, typed however ("abc-def").
- **Tables last 14 days**, checked on every read and deleted by the read
  that finds one expired (no timer - billed per request).
- **Pay links** are built only in the core and only as https to
  `venmo.com`, `cash.app` or `paypal.me` (`safePayUrl` re-checks every one
  before it is drawn), with the amount and a note `encodeURIComponent`-ed.
  Handles have strict patterns (Venmo 5-30 of letters, digits, `-`, `_`;
  a $cashtag 1-20 letters and digits with a letter; PayPal.me 1-20 letters
  and digits) and a pasted profile link is read down to the handle. Venmo
  and Cash App are dollars only; PayPal takes the currency code. The
  example's buttons are look-alikes that go nowhere (its handle is invented).
- **The fairness line** compares each person with an even split of what has
  been claimed: "Splitting evenly would have cost Ana $18.53 more (so far)."
- **Failures** (`fail()`/`failure()`): only the app's own errors reach the
  page with their words; a provider error is a 502 (503 "The AI is busy")
  sentence. Nothing logged carries a bill, a name or a photo.

## The first run

The page opens on the example - "Dinner at Luigi's", four invented friends,
Sam paid, ten lines (a burrata shared three ways, two margaritas one each, a
bottle of Chianti four ways, tax and a 20% tip), everything claimed but the
tiramisu. A dark strip says "This is an example dinner - tap an item to call
dibs, then split your own" with a big **Split a bill**. Tapping for Ana is
already selected, so the bottom bar reads "Ana owes Sam $47.04 · Pay Sam",
and further down the settle-up, the fairness line (Ana, the salad person)
and the group-chat summary. The example can be played with but is never
saved.

**Split a bill** offers **Snap the receipt** (signed in; 401 -> sign in, 402
-> the credit sheet, 403 `verify-email` -> its sentence and "Send the link
again") and **Type or paste it** (free; "Try an example receipt"; "start
empty"). Then: the editable review with the check, "Who's splitting?"
(names, who paid), and the bill on this phone. **Share with the table** asks
a signed-out host for a free account (no AI, no cost) and lands on
`t/<code>` with the code in big type, the QR (full screen on tap), Copy link,
Lock and Delete.

A guest opening `t/<code>` lands on the claim screen with one sheet in the
way: "Which one is you?" (the host's names as big buttons, or add yours and
a colour). Then they tap what they had; the bottom bar shows "You owe Maya
$31.16 · Pay Maya", which opens Venmo / Cash App / PayPal buttons with the
amount filled in and "I've paid Maya". Every phone refreshes every 3 s while
visible and stops when hidden. When the last item is claimed, "Everyone's
claimed!" (a small emoji burst, skipped with reduced motion).

On a desktop the bill and the settle-up sit side by side.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8114/dibs/
npm test        # pure rules first, then end to end over HTTP under a /dibs mount
```

`DIBS_MEMORY=1` and `DIBS_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `DIBS_COLLECTION_PREFIX` (set to
`dibs_` by the lab host) prefixes every top-level collection. The fake model
refuses a call that does not force a tool. Triggers in photo bytes: `BLANK`,
`INJECT` (markup, bidi, words as prices, negatives, 130+ lines), `MISMATCH`
(the ribeye missing, with a note), `SERVICE` (a 20% service charge),
`MAXTOKENS`, `UPSTREAMnnn`. Anything else reads as the example receipt.

`public/qr.js` is Receipt's vendored copy of Kazuhiko Arase's MIT "QRCode for
JavaScript", with only its global renamed to `DibsQR`.

## Data (Firestore: `dibs_*` in the lab database `challenge`)

- `tables/<CODE>` - `{code, ownerTag, createdAt, updatedAt, expiresAt, v,
  locked, bill: {title, currency, items: [{id, name, unit, qty}], tax, tip:
  {mode, bp, cents, base, even, onReceipt}, fees: [{id, name, cents, service,
  rateBp}], discounts: [{id, name, cents}], printed: {subtotal, total},
  payerId, handles: {venmo, cashapp, paypal}}, people: [{id, name, color,
  keyHash, host}], claims: {itemId: {personId: weight}}, everyone: {itemId:
  true}, paid: {personId: {at, confirmed}}}`. Nothing else: no photo, no
  email, no account id, no guest key.

A bill on one phone is `localStorage` `dibs-bill-v1` (every access in
try/catch); sharing moves it to a table and clears it.

Limits (`Core.LIMITS`): 120 lines, 99 of one line, $10,000 a unit, $100,000
a bill, 20 people, names 20 characters (first name or emoji; control and bidi
characters stripped, the emoji joiner kept), 10 fees, 10 discounts, 2 photos
(4 MB each, 8 MB together, decoded). JSON bodies 64 KB except the snap (12
MB, after the gates).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `t/:code`.
Guests (no account): `GET /api/table/:code[?since=v]`,
`POST /api/table/:code/join|claim|person|paid`. Host (signed in, free):
`GET|POST /api/tables`, `PUT|DELETE /api/tables/:code`,
`POST /api/tables/:code/lock|people|everyone`,
`DELETE /api/tables/:code/people/:pid[?release=1]`. Metered
(`requireUser, requireBudget, requireDailyCap`, then the parser):
`POST /api/snap` `{photos: [{type, data}]}`.

## Ideas not built yet

- **Itemised tip per person** ("I'll tip more on mine").
- **Payer's view of who has paid across tables** and a nudge - needs a
  sender, which the platform does not have.
- **Currency conversion** for a trip abroad (Trip Planner's Frankfurter
  rates would fit).
- **Splitting a supermarket or Airbnb bill** among housemates: the core
  already handles it; the copy is all restaurants.
- **An App Clip / universal link** so the QR opens without a browser.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`
  (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor or a guest, ever; the snap's gates
  run before its 12 MB parser (tested: 401/402/403, not 413).
- Model output and guests' names are untrusted: cleaned, bounded, stripped
  of markup, control and bidi characters, and escaped on render.
- `t/*` and `/api/table/*` answer with `no-referrer` and `noindex`; the code
  is a key to the table.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
