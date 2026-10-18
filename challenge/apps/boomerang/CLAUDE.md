# For Claude: Boomerang

Lend it. Get it back. A shelf of what you lent and what you borrowed - the
drill, the book, the jacket, the casserole dish, the board game - sorted into
**Overdue / Due soon / Out now / Back home**, a **receipt link** the other
person confirms with one tap (no app, no account), **nudges** with a tone dial
from Polite to Legal-ish, and **stats with personality** ("Your ladder has been
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
  never colour alone. Overdue cards pulse (off under reduced motion).
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
  added on its own line. **Boomerang never sends anything**: Send opens the
  phone's share sheet, else it copies.
- **The first run** is the hero, three doors (**Try a sample shelf**, I lent
  something, I borrowed something), a privacy line and a four-step "How it
  works". The sample (`sample(today)`, dated from today) is eight made-up
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

## Write it for me (the one model call)

`POST /api/write {loan: {item, who, dir, on, due}, tone, hint, today}`:
`requireUser, requireBudget, requireDailyCap` **then** the route's own 8 KB
parser (a stranger's body is never read; tested 401/402/403/503, never 413),
then `ai.brief` (an item and a name, a known tone, a hint under 80 characters -
a 400 costs nothing), then one forced tool `write_nudges` -> `{options:
[{text, tone}]}`, max 900 tokens. The model is sent **only that loan's** item,
first name, dates, direction, tone and hint - never the note, the receipt or
the rest of the shelf (tested with a spy client). `ai.cleanOptions` strips
markup, control and bidi characters, bounds each message to 480 characters,
keeps a known tone (else the one asked for), drops repeats, keeps three;
none is a 422. The system prompt keeps it good-natured: no real legal
language, nothing shaming. Nothing is stored or logged. Signed out, the button
explains it needs a free account and that the ready-made messages stay free;
402 opens the credit sheet; 403 `verify-email` shows its sentence and "Send
the link again".

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
`MAXTOKENS`, `UPSTREAMnnn`; anything else is three messages in the tone asked.

`test/run.js` (23 tests): cleaning and the emoji map; the loan, its dates and
words (overdue, due today, due soon, across a year); the shelf order and every
stat; the handshake state machine both ways (only valid steps, the borrower
cannot close, closed is final, expiry); what a receipt shows; all thirty
nudges; contrast in both themes; the local-only switches; the prefix and
single-field queries; the page (no inline script or handlers, relative URLs,
wrapped storage, no photo route); and over HTTP: signed out with zero model
calls, the gate order, a receipt's whole life, token entropy and the
identical 404s, what a link reveals (hostile input included), the anonymous
limits, signed-in sync across two phones, Write it for me, what the model
sees, and the 401/402/403/503 gates. The shared files (`lib/identity.js`,
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
