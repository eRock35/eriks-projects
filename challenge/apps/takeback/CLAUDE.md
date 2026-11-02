# For Claude: Takeback

Never miss a return window - and make sure the refund actually lands. For
anyone who shops online or in stores - especially through the holidays - and
has a "should I send this back?" pile, a return label they never printed, or
a refund they never checked arrived.

- **First run** (real effort went here): a hero with a mock stack of three
  purchases (a countdown ring on "Boots · $89 · 3 days", "Refund Mon", "$64
  back ✓"), **Try it** (thirteen made-up purchases in every state - deciding,
  closing tomorrow, label printed, dropped off, refund overdue, refunded,
  partly refunded, store credit, kept, missed - with a ribbon that says
  nothing is saved, "Add my own" and "Leave") and **Add my first purchase**;
  then how it works in three steps, three feature cards and, in October to
  December, one line on holiday windows.
- **Adding takes seconds**: the store (the stores already used are chips;
  the person's own note on that store shows up), what was bought and the
  price, **several items from one order** at once ("+ Another item from this
  order"), the day (today by default; Today / Yesterday chips) and the return
  window: **14 / 30 / 60 / 90 days or "until a date"**, with a live "Return
  by Thu Dec 3 · 30 days left". The window the person picked at that store
  last time is preselected and said ("Last time at Juniper Outfitters you
  picked 30 days") - their own choice offered again, never a store's policy.
  Under "More details": order number, how it goes back (by mail, in store, a
  drop-off point), a gift (gift receipt; refunds usually come as store
  credit), the store's returns page (https only), a receipt or order photo
  (shrunk on the phone, location removed - one quiet line says so) and a note.
- **The list**, sorted by what needs the person soonest (closing within a
  day, then late refunds, then open windows by date, then refunds on their
  way, then done): "Return by Fri Nov 6 · 4 days left", amber under a week,
  red under two days, "Missed - closed Oct 30" greyed; a countdown chip on
  each card; the header "2 decisions due this week · $240 still returnable"
  and what is on its way. Filters: All, To decide, Sending back, Refunds,
  Done. Each card's next step is one tap: **Keep it / Send it back**, the
  next checklist step ("Label printed ✓"), or **Refund received**. Nudges
  above the list for the last day, tomorrow, a return not dropped off with
  three days left, and a refund due today. The tab shows a red count of what
  is urgent.
- **Sending it back** is a checklist with the money at the end: Return
  started (with the returns page, or a field for it) → Label printed / Return
  code saved → Packed → **Dropped off** (a date, a refund-expected-by date
  that defaults to **ten business days later** and can be changed, and an
  optional photo of the drop-off receipt) → **Refund received** (amount -
  partial is fine, "$24 kept back" - the day, and back to the card or as
  store credit). In store is two steps. Every tick has Undo.
- **The refund watch** - the part most people need - sits first on a phone
  and beside the list on a desktop: every refund on its way with a bar of
  days waited, and a late one in red: "No refund yet from Juniper Outfitters
  - 4 days late. Check your card statement, then contact them with the
  drop-off receipt." with **Message to send them** (a short, polite note with
  the item, order number, drop-off day and amount, ready to copy).
- **Reminders without a server**: "Remind me" makes an `.ics` on the device
  for 3 days before and the morning of the return-by day, and for the
  refund-expected-by day, at a time the person picks (9 AM by default), in
  **floating local time** (Tada's reasoning: no TZID, no VTIMEZONE; 9 AM
  wherever the phone is, across a clock change). The sheet says it adds to
  the phone's calendar and works with the app closed. Settings has "Add every
  open return to my calendar". UIDs are stable per purchase and kind.
- **Money**: "$358 recovered this year · $240 still returnable · $227
  waiting on refunds · 1 window missed ($38)", four stat tiles, money back
  and windows missed by month (inline SVG, described for screen readers),
  where it went (card vs store credit, partial refunds, returns made, kept),
  and a **recap image** (1080 x 1350, drawn on a canvas on the device,
  shared with `navigator.share({files})` where allowed, else downloaded, in
  two taps - draw, then share - because iOS needs a fresh gesture). Totals
  and counts only; **store names only if "Show store names" is ticked (off
  by default)**; no item is ever on it.
- **Stores**: each store used, with purchases and money back, and the
  person's own note ("free returns in store", "keeps the shipping fee"),
  shown again when adding from that store. Typed by the person; Takeback
  never supplies one.
- **Export / import**: a CSV of every purchase and refund (formulas defused
  with a leading `'`, RFC 4180), and the same CSV back in (rows matched by
  id, so a re-import replaces rather than doubles; the defusing is undone).
- **Signed in (free), opt-in sync** between a phone and a laptop: below.
- **"Read my receipt or order email"** (metered, signed in): below.

Built 2026-11-02 as an **everyday** drop: Sieve (2026-11-01) was a business
one, so today was the other kind. **Staging only**: no custom domain until
Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/takeback`,
served at `challenge.strongtechnicalconsulting.com/takeback/`, data in
`takeback_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it was picked (everyday life)

- **Return windows quietly close.** A 30-day window is generous on the day
  of purchase and gone by the time the box is opened again. Most people do
  not track them at all; the receipt is in a drawer and the date is a guess.
- **Refunds go missing and nobody notices.** A parcel dropped off is the end
  of the job in most people's heads - but the money arrives days or weeks
  later, sometimes partly, sometimes as store credit, sometimes not at all.
  Nobody checks the card statement against a drop-off receipt. The refund
  watch is the feature: a date it is expected by, and a flag when it is late.
- **The holidays make both worse.** Gifts, duplicates and online orders pile
  up, and many stores run longer holiday return windows that start around
  now (the app says "many stores" and makes no claim about any one store's
  policy). January is when the pile gets dealt with - or missed.
- **Free on the device.** Adding, the countdowns, the checklist, the refund
  watch, reminders, the tally, the recap image and CSV all work signed out,
  offline, with no request at all.
- **It could be an iPhone app** (below).

**Not a repeat:** Drip finds recurring subscriptions in a bank CSV; Duly
tracks bills on AutoPay; Boomerang tracks things lent to friends; Sorted
decides what to keep or get rid of. Nothing in the lab or the portfolio
tracks a purchase from "might send this back" to the refund landing.

**Who pays.** Almost nobody. Everything except the receipt reader is free
and needs no account. A free account adds sync (opt-in). The one metered
thing (Haiku for the free tier, Sonnet for members via `identity.planFor`)
costs about a cent a receipt.

**How it becomes an iPhone app.** A Share Sheet extension that takes a
shop's order email or a receipt photo straight into the reader; a widget
("2 returns due this week · $240"); local notifications on the return-by
morning and the refund-expected day (no server needed - the same dates the
`.ics` carries); the camera for the drop-off receipt; Wallet-style cards for
return QR codes.

## The decisions that matter

- **One rules file, run three times.** `public/takeback-core.js` is UMD
  (`window.TakebackCore` in the page, `require` in the server and tests):
  text cleaning, money, days, a purchase and its window, states and status
  lines, the checklist, refunds, the list order, the summary and nudges, the
  tally, stores and notes, the `.ics`, CSV out and in, sync cleaning and
  merging, the receipt reader's request and answer, and the made-up list.
  **No clock and no dice** (tested: no `Date.now()`, `new Date()` or
  `Math.random`): "today", "now" and every new id are handed in. Days are
  `Date.UTC` day numbers, so a window across a clock change counts days, not
  hours; `localDay(ms, tz)` (Intl alone) is how a test proves "today" turns
  over at local midnight on the 25-hour Nov 1 in New York.
- **States** (`stateOf`): deciding, returning (sent back, not yet dropped
  off), waiting (dropped off, refund not yet due), overdue (past the
  expected day), refunded, kept, missed (the window closed without a
  drop-off). One door for every purchase, typed, stored, imported, synced or
  sample: `cleanPurchase` (bounded fields, https-only link, cents 0..50,000,
  a day bought not in the future or more than three years back, a window
  only as `{days: 1..365}` or `{until}` within 400 days of buying, steps and
  a refund only on a return, unknown fields dropped).
- **Takeback never guesses a store's policy.** No window without the
  person's pick (or, from the reader, words printed on the document); no
  store note it did not get from the person. Tested: no real store named in
  any string.
- **Photos stay on the phone.** Receipt photos (per order) and drop-off
  receipts (per purchase) are redrawn through a canvas at 1600 px (receipts
  need their small print) with a 240 px thumbnail - which drops EXIF,
  location included - and kept in IndexedDB. Sync never carries them, and
  the only image that ever leaves is the one the reader sends, shown first.
- **Neutral copy**: no he/she anywhere (tested over every string).

## Sync (signed in, free, opt-in)

Settings → "Phone and laptop" → **Turn on sync**, under a plain sentence:
sync stores the list - stores, items, prices, dates, the return steps,
refunds and store notes - in the lab's database so the other device can see
it; photos stay on the phone; it is filed under a code made from the
account, never the email. Signing in alone uploads nothing.

- `lists/<tag>` = `{owner, list: {purchases, notes, deleted}, version,
  updatedAt}`. The tag is an HMAC of the account id under a key derived from
  `IDENTITY_SESSION_SECRET` ("takeback owner v1") - never the id or the
  email (tested against the stored documents). No secret: 503.
- **Whole-document writes in a transaction with a version**: `PUT /api/list
  {list, base}` saves only if the account copy is still the version this
  device last saw; otherwise **409 with the account's copy**, and the page
  asks **Use theirs / Keep mine / Merge by item** with the count each would
  leave. A device that never synced cannot overwrite an account copy; two
  saves at once give one 200 and one 409 (tested).
- **Merge by item** (`mergeLists`): every purchase from both, the later
  `updatedAt` wins, a deletion (`deleted: [{id, at}]`, 500 kept) beats an
  older edit and loses to a newer one, store notes merge by store. Photo
  flags are this device's and are put back after adopting another copy.
- **Cleaned and capped on the server** (`cleanList(strict)`): at most 500
  purchases (413), 400 KB as JSON (413), a 512 KB parser after sign-in,
  unknown fields a 400, every purchase through `cleanPurchase` (links https
  or nothing, money and dates sane), photo flags removed. 120 saves per
  account in 10 minutes.
- The page saves 1.2 s after a change, re-reads on returning to the app
  (adopting silently when this device has nothing unsaved), and says
  "Offline - your changes will be saved when you're back online". "Turn off"
  keeps the account copy; "Turn off and delete the account copy" deletes it.
- **There is no query at all** - no index, no list.

## The model call (metered, signed in only)

**`POST /api/ai/receipt`**: `requireUser, requireBudget, requireDailyCap`
**then** the route's own 1.4 MB parser (401 / 402 / 403 / 503 before it,
never 413 - tested), then `ai.brief` rebuilds the request
(`receiptRequest`: exactly `{image: {type, data}}` - anything else is a
400; the image must be a JPEG or PNG **by its bytes**, at most 1 MB and
1600 px, and its EXIF, comments and PNG text are stripped before the model
sees it), then one forced tool `record_receipt` through **one call site**
(`ai.ask`, the only `messages.create`), told the image and only "Today is
<day>" - never the list, the notes or the stores - then `cleanReceipt`:

- **No card number, ever.** A run of 13-19 digits, or a 4-4-4-x / 4-6-5
  group, that passes the Luhn check anywhere in the answer (even a field
  nobody asked for) refuses it whole: 422 `code: 'card-number'`, "crop the
  card number out and try again", and the refused answer is never passed on.
  **Any other run of 12+ digits is taken out of the text instead** (2026-11-02
  review): a 12-digit UPC is printed on most store receipt lines, and
  refusing every answer that echoed one would have failed ordinary receipts.
  An order number with a run of 12+ digits is dropped (`orderDropped`, said
  under the field). The prompt says never to return card numbers, barcodes
  or any run of 12+ digits.
- **The return window only if printed on it**, with the words it was read
  from (`quote`, shown as "Printed on it: “…”"); without the words, no
  window. Days 1..365, or a date after the order and within 400 days.
- At most 30 items, names plain with no links or markup, prices whole cents
  at or above zero and bounded (or empty), the order date real, not in the
  future and not over two years old, a known currency or none, a known
  confidence ("low" when unknown), one short note. Nothing readable is a 422
  with a way forward. Nothing is stored or logged.

The page shrinks the image (1600 px, smaller until it fits) and says what is
sent before the tap: "this one image, shrunk on this phone with its location
removed. Nothing else - not your list, your notes or your stores. If a card
number is printed on it, crop it out first." The answer is an **editable
proposal**: store, day, order number, each item ticked with its name and
price, the window chips (preselected from what was read, or the person's
last pick at that store), a confidence pill, a note if the currency differs -
and nothing is added until **Add N purchases** (with Undo). The receipt image
is kept on the phone with the purchases. Signed out it says it needs a free
account; 401 opens sign-in; 402 the credit sheet; 403 `verify-email` its
sentence and "Send the link again"; sheets size themselves below the shared
confirm-your-email banner.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8146/takeback/
npm test        # the rules first, then end to end over HTTP under a /takeback mount
```

`TAKEBACK_MEMORY=1` and `TAKEBACK_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `TAKEBACK_COLLECTION_PREFIX`
(`takeback_` from the lab host) prefixes every collection. `npm test` runs
with `REQUIRE_VERIFIED_FOR_FREE_AI=0` (the gate itself is held by the
suite's last test and by the lab's). The fake refuses a call that does not
force a tool, keeps every request (`fakeClient.calls`), and takes
`fakeClient.mode` for one call: `blank`, `inject`, `card`, `cardspaced`,
`longorder`, `nowindow`, `maxtokens`, `upstreamNNN`. Card-shaped numbers in
the tests and the fake are built at run time, so no file carries one
(tested).

`test/run.js` (28 tests): text and money; return-by for each preset, a
date, a leap year and the year end, and no window without a pick; days left
and the colours (amber under a week, red under two days, grey once closed)
with a fixed clock; the **America/New_York fall-back on 2026-11-01** (the
25-hour day, "today" at local midnight, the same answers with the machine's
`TZ` set to three other zones); the checklist (mail, drop-off point, in
store, undo, changing one's mind, a missed return); business-day refund
dates; overdue detection, its words and the follow-up message; full, partial
and store-credit refunds; the made-up list (every state, the order, the
summary, the filters); the tally and months; stores, the last window and
notes; the `.ics` (floating, escaped, folded, CRLF, stable UIDs, the time,
what is offered when); CSV out and back in (identical, formulas defused and
restored, odd files, the 500 cap); hostile purchases and several items from
one order; sync cleaning and the merge; the reader's request and answer
(card runs refused, Amex and spaced and dashed, an Amazon-shaped order
number kept, a long one dropped, windows only with words, dates, bounds);
contrast in both themes, the literal colours and the lab card; 44 px
targets; the page's promises (relative URLs, no inline script, the banner,
wrapped storage, IndexedDB in a try, photos redrawn, every received string
escaped, only the listed API paths, sync opt-in, what the reader sends);
neutral copy and no store's policy; the local switches and no query; and
over HTTP: signed out with zero model calls and 401s before every parser, no
route that takes a purchase, the gate order, one door and one call site, a
sync's life (first save, 409s, two at once, keep mine, the owner tag holds no
id or email, another account sees nothing, delete), the server's cleaning
and caps, the reader (400s with no model call, what the model saw, PNG,
hostile output, card numbers, a long order number, no window, 422, 502, 503)
and the 403 / 402 / 503 gates.

Rendered with Playwright at 390px and 1280px, light and dark: the first
run, Try it (every state), the overdue refund and its message, the checklist
mid-way, Remind me (made-up and own), refund received, the money tally and
the recap image (saved as PNG, with and without store names), stores, adding
quick and with a photo (two items), the reader signed out, signed in, its
proposal and the verify-email 403, settings, sync on, a two-device 409 and
the merge, and the lab card on the landing page; no console error or CSP
violation, nothing scrolls sideways. Then a hostile pass (markup, bidi,
zero-width and long strings in stores, items, notes, order numbers and links,
and an odd CSV imported): no dialog, no injected element, no live formula in
the export. Found on the way: headless Chromium's `navigator.language` is
`en-US@posix`, which Intl refuses - the page canonicalises the locale and
falls back to en-US.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`). `lib/image.js` is
Haul's (byte checks and metadata stripping).

## Data

- **In the browser** (every access wrapped; works in memory when storage is
  unavailable, with a one-time warning): `takeback-data-v1` (purchases,
  store notes, the ids of deleted purchases for sync), `takeback-prefs-v1`
  (currency, reminder time, the list filter, sync on or off),
  `takeback-sync-v1` (the account version last seen, unsaved-change flag,
  last saved); IndexedDB `takeback` (`photos`: `r-<order>` receipt photos and
  `d-<purchase>` drop-off receipts, 1600 px and 240 px JPEGs). Clear
  everything in Settings. "Try it" is never saved.
- **In the lab database**: `takeback_lists/<tag>` (above), only after the
  person turns sync on. No image, no AI answer is ever stored by the server.

## Routes

Public: `GET /api/health`, `/healthz`, `/api/me`, the page, the service
worker. Signed in, free: `GET|PUT|DELETE /api/list`. Metered: `POST
/api/ai/receipt`. The shared account at `/api/auth`.

## Ideas not built yet

- **Forward an order email** to an address (needs a mail receiver - new
  infrastructure, so not a daily drop).
- **Price-drop watch** within the window ("it's $20 cheaper now - price
  adjust or return and rebuy") - needs a price source.
- **A household list** shared between two people (today a list is one
  account's).
- **Public holidays** in the refund-expected sum (today it skips weekends
  only, and the date is editable).

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; every parser that takes a
  body runs after its gates.
- Every typed store, item, note and order number, every imported CSV cell,
  every synced list and every model answer is untrusted: cleaned in the core
  (no markup, bidi or invisible characters, bounded), and escaped on render
  (the test cuts out every `esc(...)` and fails on a field concatenated into
  markup); the `.ics` and the CSV are escaped for their own formats; canvas
  text is drawn as text.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body or an image.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
