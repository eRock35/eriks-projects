# For Claude: Boomerang

Lend it. Get it back. A shelf of what you lent and what you borrowed - the
drill, the book, the jacket, the casserole dish, the board game - sorted into
**Overdue / Due soon / Out now / Back home**, a **receipt link** the other
person confirms with one tap (no app, no account), **nudges** in a tone you
pick from Polite to Legal-ish, and **stats with personality** ("Your ladder has been
on holiday for 94 days", your return rate, your most reliable borrower).

Built 2026-10-18 as an **everyday** drop: Sniff (2026-10-17) was a business
one, so today was the other kind. A free pick from ordinary life (friends,
family, neighbours, things). Not a repeat: Dibs splits a bill, Chorus splits
chores, Pickup tracks who owes for the court, Settle decides between options;
nothing in the lab or the portfolio tracks **things** lent and borrowed.
**Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab -
`challenge/apps/boomerang`, served at
`challenge.strongtechnicalconsulting.com/boomerang/`, data in `boomerang_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

Everyone has lent something and lost track of who has it - and asking for it
back is awkward enough that most people never do, so the drill is just gone.
The fix is two small things: **a record both people agree on** (so "I never
borrowed that" is not a conversation), and **a way to ask that is not
awkward** (a message you can pick the tone of, or that reads as a joke). The
rest - the shelf, the stats, the celebration - is what makes it worth opening.

**Who it's for:** anyone with friends, family, roommates or neighbours.

**Who pays.** Almost nobody. The shelf, the emoji, the photo, the dates, the
stats, the sample, the receipt link (making it and opening it), every step on
it, and all thirty ready-made nudges are free, need no account and make no
model call. A **free** account adds sync (the shelf follows you to another
phone) and the one metered thing: **"Write it for me"** (Haiku for the free
tier, Sonnet for members via `identity.planFor`), about a cent.

**How it becomes an iPhone app.** A widget with what's overdue, a share
extension ("Lend this" from a photo), an App Clip for the receipt link so the
friend installs nothing, a local notification on the due date (no sender
needed: it would be the phone's own reminder).

## The decisions that matter

- **One rules file, run three times.** `public/boomerang-core.js` is UMD
  (`window.BoomerangCore` in the page, `require` in the server and tests):
  cleaning, the emoji map, a loan (`cleanLoan`), its status and its words, the
  shelf and the stats, the handshake state machine and what each side sees,
  the nudges and the sample. No dice and no clock of its own: every function
  that needs "today" is handed it as `YYYY-MM-DD` in the viewer's own day.
- **One door for a loan.** `cleanLoan` takes a typed loan, a synced one and
  the sample alike: item 60 characters, a name 24, a note 140 (markup,
  control and bidi characters stripped, cut on a whole character); a start
  date that is not in the future and at most ten years back; a due date not
  before it started (two years at most); a back date between the two and not
  after today. A receipt this phone made keeps its token and owner key; one a
  friend sent and this phone saved keeps the token only.
- **Status:** back (it has a back date), overdue (the due date has passed;
  due *today* is not late yet), soon (today and the next three days), out.
  Chips always carry words ("80 days late", "Due tomorrow", "Back Oct 2"),
  never colour alone.
- **The emoji guess** (`guessEmoji`) is a fixed keyword map read from the
  last word back (the head noun: a "camping chair" is a chair), a two-word
  rule ending at a word beating a one-word rule ("plant pot" is not a cooking
  pot). Unknown is 📦. The picker has 24.
- **Stats** (`stats`), worked out on read: lent out, borrowed, overdue; the
  lent thing away longest with one of four lines chosen by a hash of its id
  (the same line every time); came back = lent things back / all lent; **most
  reliable** = most things back on time (by its date, or with none set), fewer
  late as the tie-break, then the name; **your best lender** = who you have
  borrowed from most.
- **Nudges** (`nudge`): five tones x three messages x two directions (asking
  for yours back, or telling them theirs is coming home) = thirty templates,
  each filled with the first name, the item read into a sentence
  (`itemPhrase`: "my cordless drill", "my Catan"), the days and a "by when".
  The first message per loan and tone is fixed by a hash; "Another one" cycles.
  Legal-ish says it is a joke in every message. The receipt link can be
  added on its own line. The message sits in a **text box the person edits**;
  what is sent or copied is what the box holds (an edit survives the link
  toggle, and is replaced by picking another tone, "Another one" or a written
  option). **Boomerang never sends anything**: Send opens the phone's share
  sheet, else it copies.
- **The first run** is a centred hero, three doors (two pills, **Try a sample
  shelf** and I lent something, and an I borrowed something link), a privacy
  line and a four-step "How it works". The sample (`sample(today)`, dated from today) is eight made-up
  loans: a drill out 94 days with a confirmed receipt, a book due tomorrow, a
  ladder with no date, a casserole dish and a tent borrowed (Mum, Alex), and
  three back home, so every band, every stat and the receipt flow show in one
  tap. A strip says it is made up, with **Start my own** and **Clear the
  sample**; adding a real loan clears it. Sending a sample receipt makes no
  link: it opens the friend's page worked out on the phone, where every
  button works and It's back closes the loop with the celebration.
- **The celebration**: It's back draws a card ("It came back! Your cordless
  drill is home after 94 days. Thanks, Sam.") and confetti for 2.6 s, and a
  short vibration; under reduced motion it is a toast. Always announced in
  the live region.

### The receipt link (the handshake)

A receipt is made by a browser with **no account** and opened by a friend with
**no account**. Four states, timestamped:

```
sent --confirm--> confirmed --gave--> returning --back--> closed
  \_____________________back________________________/  (the lender, any time)
```

- **confirm**: the friend who opened the link ("Got it", or "That's right"
  when the friend is the lender). **gave**: the borrower, once confirmed
  ("I've given it back"). **back**: the lender, any time before closed
  ("It's back"). The borrower can never close it. Closed is final.
- The **owner** is whoever made the link: they hold a second secret, the
  owner key, sent in an `X-Boomerang-Key` header (never in the URL). Who is
  lender follows the loan's direction as the owner saw it, so a borrower can
  send the receipt too ("I've got your dish").
- **Revoking** is the owner deleting it. From then on the link is the same
  404, word for word, as one that never existed, an expired one, or a
  malformed token. A stranger's delete (no key, wrong key) is that 404 too.
- Every step is a transaction: two taps at once give one 200 and one 409.
- The owner's shelf reads its receipts when it opens and when it comes back
  to the foreground; a receipt closed on the other side marks the loan back.
  A friend can **Add it to my shelf**, which keeps the token (no key) and acts
  as the friend from then on.

**What a link reveals:** the item, its emoji, the two first names as typed,
the date lent, the due date, the note if there is one, the state, when each
step happened, which side you are and what you can tap. Nothing else: no id,
no hash, no account, no email, no device. Tested by the exact key list.

## Who may do what, and the limits

- **Tokens** are 16 random bytes (128 bits), base64url, 22 characters. The
  document id is `sha256(token)`, so the token is never stored and a reader of
  the database cannot open a receipt; the owner key is stored only as
  `sha256(key + id)`.
- **Limits** (`lib/handshakes.js` LIMITS; per instance, in memory - they slow
  a script, they do not stop a determined one): 20 new receipts per address an
  hour (IPv6 by its /64) and 2,000 across the instance; **50 open receipts per
  account or device** (signed in: an HMAC tag of the account; signed out: a
  hash of an HttpOnly `boomerang_k` device cookie, path-scoped to the app,
  minted the first time it makes one); 300 writes per address in 10 minutes;
  30 **distinct** wrong tokens per address in 15 minutes, then even a real one
  waits (one dead token polled again counts once). 240 shelf saves per account
  in 10 minutes; 200 loans a shelf.
- **Expiry:** a receipt lasts a year at most and 30 days after it is closed,
  checked on every read and deleted by the read that finds it (no timer -
  billed per request).

## Sync (signed in, free)

`shelves/<account tag>` = `{loans: {<id>: loan}, createdAt, updatedAt}`, the
tag an HMAC of the account id under a key derived from
`IDENTITY_SESSION_SECRET` ("boomerang shelf owner v1") - never the id or the
email. With no secret, sync answers 503 and the shelf stays on the phone.
Every write is a transaction; `PUT /api/shelf/:id` saves one loan,
`DELETE /api/shelf/:id` one, `POST /api/shelf/merge` brings a phone's loans
in on sign-in (a loan the account lacks is added; one it has is replaced only
by a newer `updatedAt`), `DELETE /api/shelf` forgets the account's copy (the
phone keeps its own). Only `SAVED_FIELDS` are kept: **never the photo flag,
never the sample** (sample ids are refused). Twelve saves from two phones at
once all stick (tested).

## On the phone

`localStorage`: `boomerang-shelf-v1` (the loans), `boomerang-name-v1` (your
first name, asked once when you first send a receipt), `boomerang-tab-v1`.
Every access is wrapped. **Photos** are shrunk to 360 px through a canvas
(which drops EXIF, location included) and kept in **IndexedDB on that phone
only** - never uploaded, never synced; there is no route that takes one. A
service worker (`sw.js`, network first) keeps the app's own files for offline
use, never `api/` and never a receipt page.

## Write it for me (the one model call; Claude)

Erik's per-app AI plan (2026-11-23): *"'Write it for me': a friendly nudge to
get your thing back"* on **Claude** - tone-sensitive writing. The app already
had the call; the redesign extended it rather than adding a second one.
**Provider: Claude only**, through the lab's existing Anthropic client
(`identity.meter`, `identity.clientFor`, models by `identityLib.planFor`:
Haiku free, Sonnet for members). There is no provider switch and no
federation wiring; `PROVIDER = 'claude'` is a constant in `server.js`.

`POST /api/write {loan: {item, who, dir, on, due}, tone, hint, today}`, in
this order:

1. `requireUser, requireBudget, requireDailyCap`, **then** the route's own
   8 KB parser (a stranger's body is never read; tested 401/402/403/503,
   never 413).
2. `ai.brief`: an item and a name, a known tone, a hint under 80 characters -
   a 400 costs nothing. The name is cut to its **first word** here (the page
   sends only that too).
3. **The lab's AI guard**, when the host has loaded one:
   `global.LAB_AI_GUARD.allow({provider: 'claude', req, app: 'boomerang'})`.
   A no is its own sentence plus "The ready-made nudges are free." with its
   status and code, shown where the button is; no model call. Without a
   guard (the app on its own, its tests) the identity gates stand alone.
4. One forced tool, `write_nudges` -> `{options: [{text, tone}]}`, two or
   three, max 900 tokens. **The model writes wording only**: `ai.facts`
   works out the days out, days late or days left, and the request states
   them in words ("on Thursday, July 16, 2026 (94 days ago)"); today's date
   is not sent. Sent: that loan's item, first name, the two dates,
   direction, tone and hint - never the note, the receipt, a surname or the
   rest of the shelf (tested with a spy client).
5. `ai.cleanOptions(raw, tone, brief, today)`: markup, control and bidi
   characters stripped, each message cut at 480 characters (the model is
   asked for under 280), a known tone (else the one asked for), repeats
   dropped, three kept - and `ai.refuse` **drops whole** any message that
   carries: a **number** not in the facts (the days, their weeks / months,
   the dates' own numbers) or typed by the person in the item or hint; a
   **month or weekday** not supplied (a weekday only for a return date still
   ahead); a **deadline** phrase ("by the end of", "within a week", "at the
   latest"); a **threat** ("or else", court, lawyer, late fee, final notice);
   or a **guilt trip** ("after all I've done", "I thought we were friends",
   "you never"). It is a word list and a number list, not a judge: it catches
   the plain cases, and the person still reads and edits before sending.
   Nothing left is a 422.
6. `guard.record({provider, app, usd: guard.priceUsd({provider, model,
   inputTokens, outputTokens})})` for every call that came back, whether or
   not its messages passed (in a `finally`; a failing record never loses the
   answer).

Nothing is stored or logged. On the page the first option goes into the
message box, each option has "Use this", and a line says it was written by AI
from those facts. Signed out, the button explains it needs a free account and
that the ready-made messages stay free; 402 opens the credit sheet; 403
`verify-email` shows its sentence and "Send the link again".

## Design (redesigned 2026-11-23, the HOA Desk rules)

- **White page** (`#ffffff`; true black in dark), hairlines (`--line`), 12 px
  cards, 10 px inputs and tiles, pill buttons and chips. No gradients, no
  textures, no shadows except `--lift` on what floats (the bar, a sheet, a
  toast, the celebration card). **Lists over boxes**: the shelf is
  hairline-divided rows, the stats are type and dividers. A gray fill
  (`--card2`) only for controls, tiles and the sample note.
- **One accent**: the lab's teal `#0f6b66` (dark: `#62d6c6`), for the primary
  action, links, the current nav item and the tone picked. Status colours
  (late, soon, home) only for status; `--warm` (the lab's second colour) only
  in the confetti. `lab.js` is unchanged.
- **Type**: the system stack, five sizes (13, 15, 16, 20, 28; the hero and
  the big numbers go larger), tight-tracked headings, tabular numbers.
  Spacing on a 4/8 scale.
- **Navigation**: phones - a floating translucent pill bar (`#bar`: Shelf,
  Add a loan, Account; 1.5 px line icons, a label and a small accent line
  only on the current item, safe-area aware, 48 px targets), hidden while a
  sheet is open and on a receipt page. From 900 px - a top nav with a quiet
  underline, **Add a loan** and the account button at the right. `nav()`
  moves `aria-current` (shelf, or add / account while that sheet is open).
  On a phone the list comes before the numbers; from 1100 px they sit side
  by side (`dk-split`).
- **Icons** are inline SVG (`ICON` in `app.js`, the nav in `index.html`),
  fixed strings. An item's emoji is content and stays; buttons and headings
  carry words, not emoji.
- **No `style=` anywhere** - not in `index.html`, not written by script, no
  `.style.` (tested). The return-rate meter is an SVG rect; confetti pieces
  are placed by classes (`x0-x11`, `c0-c5`, `d0-d8`).
- **Motion** (press states, the sheet, the toast, the celebration, confetti)
  only inside `@media (prefers-reduced-motion: no-preference)` (tested: no
  animation or transition outside it). Every page is complete at rest.
- **Measured in Chromium** at 390, 320 and 1440 px, both themes, every view
  (hero, shelf, a loan, the form, the nudge, written options, a receipt):
  lowest text contrast 4.87:1 light, 6.61:1 dark; nothing sideways; no target
  under 44 px; no CSP report.
- **Taps from the shelf**: add a loan 1 (then the form); nudge 1, send or copy
  2; Write it for me 2; mark it back 1; a loan up close 1, send a receipt 2;
  account 1; lent / borrowed tab 1.

## Data (Firestore: `boomerang_*` in the lab database `challenge`)

- `handshakes/<sha256 of token>` - `{item, emoji, dir, lender, borrower, on,
  due, note, state, steps: {sent, confirmed, returning, closed}, createdAt,
  expiresAt, ownerHash, creator}`. Kept until a year after it was made or 30
  days after it closed, whichever comes first, or until the owner revokes it.
- `shelves/<account tag>` - as above, until the account deletes it.

Queries are single-field equality (`creator ==`), so **no composite index**.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `h/:token`. No
account: `POST /api/h`, `GET /api/h/:token`, `POST /api/h/:token/step`,
`DELETE /api/h/:token` (owner key). Signed in, free: `GET|DELETE /api/shelf`,
`PUT|DELETE /api/shelf/:id`, `POST /api/shelf/merge`. Metered: `POST
/api/write`.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8131/boomerang/
npm test        # pure rules first, then end to end over HTTP under a /boomerang mount
```

`BOOMERANG_MEMORY=1` and `BOOMERANG_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `BOOMERANG_COLLECTION_PREFIX` (set to
`boomerang_` by the lab host) prefixes every top-level collection. `npm test`
runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call
that does not force a tool. Triggers in the hint: `BLANK`, `INJECT`,
`INVENT` (a made-up date, a threat, a guilt trip and one honest message),
`MAXTOKENS`, `UPSTREAMnnn`; anything else is three messages in the tone asked.

`test/run.js` (26 tests): cleaning and the emoji map; the loan, its dates and
words (overdue, due today, due soon, across a year); the shelf order and every
stat; the handshake state machine both ways (only valid steps, the borrower
cannot close, closed is final, expiry); what a receipt shows; all thirty
nudges; contrast in both themes; the local-only switches; the prefix and
single-field queries; the page (no inline script or handlers, relative URLs,
wrapped storage, no photo route); and over HTTP: signed out with zero model
calls, the gate order, a receipt's whole life, token entropy and the
identical 404s, what a link reveals (hostile input included), the anonymous
limits, signed-in sync across two phones, Write it for me, what the model
sees, the facts check (numbers, dates, deadlines, threats, guilt), the lab's
AI guard (asked after the gates, told the cost, a no makes no call), the
redesigned page (no style attribute, motion only when allowed, the editable
message), and the 401/402/403/503 gates. The shared files (`lib/identity.js`,
`identity-store.js`, `byok.js`, `stripe.js`, `webauthn.js`;
`public/desktop.css`, `passkey-client.js`, `verify-banner.js`) are synced
copies - edit them in `eriks-projects/shared/`.

## What is deliberately not built

- **Reminders on the due date** - there is no sender; the nudge is a message
  you send yourself. A native app could use a local notification.
- **Photos in the receipt** - a photo of someone's hallway is not something a
  link should carry; photos stay on the phone that took them.
- **Money loans** - that is Dibs and Pickup's job, and money owed is a
  different conversation from a drill.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`,
  handlers by one `data-act` listener (tested here and by
  `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the metered route's gates run
  before its parser, and the merge route's 256 KB parser runs after sign-in.
- Every typed string, every receipt field and every model message is
  untrusted: cleaned in the core and escaped on render. Checked in Chromium
  with `<img src=x onerror=…>`, `"><svg onload=…>`, quotes, ampersands and
  bidi overrides through the shelf, every sheet and the receipt page.
- `h/*` and `/api/h*` answer with `no-referrer` and `noindex`: a token is a
  key. Failures (`fail()`/`failure()`, Receipt's): only the app's own errors
  reach the page in their words; a provider error is a 502 (503 "The AI is
  busy"). Nothing logged carries an item, a name, a note or a hint.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
