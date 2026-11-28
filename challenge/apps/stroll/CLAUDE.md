# For Claude: Stroll

A shop-local passport for your street: a stamp at every counter, a prize at
the end.

Built 2026-11-28 as drop #74: **the Small Business Saturday holiday drop**
(see "Holiday drops" in `challenge/CLAUDE.md`; the table's seed was
"shop-local passport, promo planner"). A **business** app by kind - the
organizer is a main-street association, a market organizer or one shop
owner - so the next regular drop is an everyday one. Nothing in it is tied
to the date: it suits a sidewalk sale, an art walk or a holiday market as
well.

## Why it exists

Streets of independent shops run a "shop small passport" on paper: a card,
a rubber stamp at each till, a box for finished cards. The cards get lost,
the stamps get shared, and afterwards nobody can say how many people took
part or which shops they reached. Stroll is that passport on the shopper's
own phone, with the two things paper never gave the organizer: a fair draw
and the counts.

It is **not a repeat** of Hopscotch (the portfolio's beer passport: one
person's own record of breweries), Doorbuster (one shop's deal) or Booth
(trade-show leads). It is an ORGANIZER'S tool for many shops and many
anonymous shoppers.

## What it does

- **A passport in a minute, no sign-in** (`#new`): the organizer's first
  name, the passport's name, the street (optional), first and last day (at
  most 31), how many stamps finish a passport (1-40), whether every stamp
  after that is one more entry (default yes), the prize (optional), and the
  shops, one to a line.
- **Shops** (organizer): up to 40; each has a name, an optional perk for
  passport holders and its own four-character **counter code**. A new code
  can be made for a shop (its old sign stops working).
- **Signs** (organizer): one poster (a square that starts a passport, the
  rules, every shop) and one sign per counter (a square that joins AND
  stamps in one scan, the code to type instead, the shop's perk). They
  print one to a page. The squares are QR codes drawn on the page by
  `public/qr.js` (the lab's vendored encoder; no service).
- **A shopper** points their phone's own camera at a sign. No app, no
  account: a first name the first time, then the stamp lands. Their three
  tabs: Passport (the count, the page of stamps, "Stamp my passport" to type
  a code), Shops (each shop's perk), Prize (the prize, the rules, the
  winners' first names, tear up my passport).
- **Overview** (organizer): passports, stamps, finished; visits shop by
  shop and day by day; the list of passports (first names and how far each
  got), where one that is not playing fair can be removed from the draw.
- **Draw** (organizer): the server picks a winner; the winner's phone shows
  a six-character claim code, the organizer sees the same code beside their
  first name and marks the prize handed over. Up to five draws.
- **See a made-up street** (`#try`): the Maple Street Shop Small Passport on
  Small Business Saturday, as a shopper with three of five stamps - pick a
  counter to "stand at" and stamp it - or, in one tap, as the organizer.
  Drawn by the same code and changed by the same rules, in memory only.

**Where it lives:** `challenge/apps/stroll`, served at
`challenge.strongtechnicalconsulting.com/stroll/`, data in `stroll_*`
collections of the lab's `challenge` database. See `challenge/CLAUDE.md`.
Every browser URL is relative to `BASE`; keep it that way.

## No model

**No model is called anywhere in Stroll**, and the page claims none (tested:
the server has no client, `package.json` has no SDK). There was nothing a
model would do better than a rule here, and a daily drop does not need one.
The shared account is mounted only so an organizer can open their passport
on a second phone.

## The rules: `public/stroll-core.js`

One UMD rules file, run three times (the page, the server, the tests). **No
clock and no dice**: `today`, `now`, every new id, every new code and the
draw's pick are handed in (tested).

- **Text.** Every text field passes `refuse`: an email address (an @ of any
  width), a link, seven digits in a row, markup - refused with a reason,
  never quietly changed. A first name is letters only, 20 at most.
- **Codes.** A 32-letter alphabet with no 0/O/1/I. Six characters open a
  passport (`#join=CODE`); four are a counter's (`#stamp=CODE.KKKK`). Both
  travel in the address's fragment, which is never sent to a server.
- **The goal** is never more than there are shops (`goalOf`): a goal of 5
  on a street of 3 is 3; with no shops nobody is finished.
- **Progress** (`progress`): only stamps for shops still on the passport
  count. A finished card has one entry; with `bonus`, one more for every
  stamp past the goal. **Nothing worked out is stored on a card** - only
  `stamps` - so removing a shop or changing the goal re-reads every card
  correctly.
- **Stamping is open** from the eve of the first day to the day after the
  last (`stampOpen`): the server's day is UTC and a street may be a day
  either side.
- **A stamp** (`stamp`): the code is normalised (case, dashes), looked up
  among the shops, and set once. A second scan is `isNew: false` and writes
  nothing. Every code that opens nothing reads the same 404, word for word.
- **The draw** (`entrants`, `draw`): every finished card that was not
  removed and has not already won, each with its entries; `pick(total)`
  chooses an ENTRY, so every entry has the same chance (tested: every pick
  from 0 to the total lands on its owner). The server hands in
  `crypto.randomInt`.
- **One door for the organizer** (`act`): `details`, `addshops`,
  `editshop`, `delshop`, `newcode`, `given`; returns exactly the keys to
  set or delete. Nothing an action carries beyond its own fields is read.
- **What each phone is shown** (`view`): the organizer gets counter codes,
  counts and the winners' claim codes. **A shopper is never sent a counter
  code, a count, another shopper's name (only a winner's first name) or a
  claim code that is not their own** - cut down on the server (tested over
  every response a shopper's phone gets).

## The data (no account)

- `strolls/<id>` - ONE versioned document: `{code, title, place, from, to,
  goal, bonus, prize, v, host: {name, keyHash, owner?}, shops: {<sid>:
  {name, perk, k, ts}}, winners: {<card tag>: {name, claim, at, given?}},
  createdAt, updatedAt}`.
- `cards/<stroll id>_<tag>` - one shopper's passport: `{sid, name, stamps:
  {<shop id>: ms}, createdAt, removed?}`. **Its own document**, unlike the
  members of Doorbuster's sale: a street can have a thousand shoppers
  (capped at 1,500), and they must neither grow nor contend on one
  document. A card is found by its id (no query); all of a stroll's cards
  by `sid ==` (single-field equality: no index to make) - only for the
  organizer's list, the draw and deleting.
- `counts/<id>` - flat counters moved by `FieldValue.increment`: `cards`,
  `stamps`, `done`, `s_<shop id>`, `d_<yyyymmdd>` (UTC). **Tallied as stamps
  happen, outside the card's transaction**, so they can drift (a shop
  removed, a goal changed, a crash between the two writes). The organizer's
  list and every draw re-read the cards and write `cards` and `done` back
  exactly; the page says "counted as they happen". The draw itself never
  reads a counter.
- `mine/<owner tag>` - a signed-in organizer's list.
- **A browser is known by `stroll_k`**, an HttpOnly cookie (22 random
  characters, `Path` = the app's base, SameSite=Lax), minted only once a
  start or a join was accepted. Stored only as `tag` = sha256("stroll
  browser v1:" + key + ":" + stroll id) - in a card's id, or as
  `host.keyHash`. Different in every stroll.
- **The same 404, word for word**, for an unknown id, a malformed one, one
  that expired and one that is not yours.
- **Expiry on read: 30 days** after the last day, by id or by code: the
  read that finds it deletes the stroll, its cards and its counts. No
  timer. The organizer can delete it at once; a shopper can tear up their
  own card (the visits stay counted).

### Privacy

Nothing about a shopper but a first name is collected, held in code
(`refuse`, `cleanName`). So **Stroll cannot contact a winner**: the page
tells shoppers to open their passport after the last day, the winner's
phone shows the claim code, and the organizer can draw again if nobody
collects. That is deliberate - do not add an email or phone field to fix
it. The store holds no browser key, no account id and no email (tested).

### Fairness, said plainly

One passport per browser, one stamp per shop, counter codes that only the
counter shows. It is not proof against someone determined: a second browser
is a second passport, and a photographed sign can be shared. What stands
against that: new passports per address are limited, wrong codes are
counted, the organizer sees every passport's first name and stamp count and
can remove one, and a shop's code can be replaced. The page does not claim
more.

### Limits (per instance, in memory: they slow a script, not a determined one)

40 shops and 1,500 passports a stroll (refused, never cut); 10 new strolls
and 60 new passports per address an hour; 30 distinct wrong passport codes
or ids per address in 15 minutes; **10 distinct wrong counter codes per
passport in 15 minutes** (then even the right one waits); 900 writes per
address and 200 per browser in 10 minutes; 30 full reads of a stroll's
cards in 10 minutes; bodies 16 KB.

## Signed in (free): the organizer's other phone

`POST /api/s/:id/keep` (organizer only) writes `host.owner` = an HMAC of
the account id AND the stroll id ("stroll seat v1") and adds the stroll to
`mine/<tag>` (the tag an HMAC of the account id, "stroll owner v1"; 30
kept). Signed in on another phone, that account is the organizer. A
shopper's card is never tied to an account.

## Offline

`public/sw.js` (network first, this app's own files only, never `api/`)
plus the last copy of the passport in `stroll-last-v1`: once loaded, the
page opens with no signal and the stamps, the shops and the perks are
there. **A stamp needs the network and is not queued** - the ribbon says
so.

## The look

The lab's house style (`public/app.css` opens with the rules): a pure white
page (true black in the dark theme), hairlines, system fonts, one accent -
a main-street brick, `#9c4a2f` where it carries text on white (`#f3b9a3` in
the dark theme), the lab card's `#b06042` as the brand dot. On phones a
floating pill: four items for the organizer (Overview, Shops, Signs, Draw),
three for a shopper (Passport, Shops, Prize); from 900px the same in the
header. Sheets are bottom sheets on phones and dialogs from 900px. The one
moment of motion is a stamp landing (`.stamp.just`), inside
`prefers-reduced-motion: no-preference` like every transition. No style
attribute anywhere: a stamp's tilt is a class (`.r0`-`.r4`), a bar's width
is a class (`.p0`-`.p20`). Signs print one to a page through `@media
print`.

**The lab card's colours** are a brick and an awning sage, `#b06042` and
`#647c5c`. No colour is 20+ in CIE Lab from every other card any more
(Doorbuster's notes said so), so the rule was loosened as little as it could
be: 20+ from every card whose own test demands 20 of every other card (the
ten from Snug to Doorbuster - their suites fail otherwise), and for the
rest the two FARTHEST free colours, 18.3 and 18.4 from their nearest
neighbours. Stroll's own test holds 18+ against the cards that existed when
it dropped and asks nothing of later ones.

## Local run and tests

```
npm run dev     # memory store, at http://localhost:8186/stroll/
npm test        # the rules first, then end to end over HTTP under a /stroll mount
```

`STROLL_MEMORY=1` **throws on Cloud Run**. There is no fake-AI switch
because there is no AI. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0` like every lab app. `test/run.js` (30
tests): text; codes; a stroll's details; the days; progress; a stamp; the
draw; the organizer's door; what each phone is shown; the words; the
example; storage; contrast and the lab card; the page's promises; the copy
and the switches; and over HTTP: signed out, cross-site writes, starting
and joining, stamping, **a shopper is never sent a counter code**, many
phones at once, outside the days, organizer-only changes, the draw, leaving
and deleting, the same 404 and expiry, the limiters, hostile input, the
account on a second phone, and what the store holds.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/passkey-client.js`, `verify-banner.js`)
are synced copies - edit them in `eriks-projects/shared/`.

## Routes

Public: `GET /api/health`, `/healthz`, `/api/me`, `/sw.js`, the page. No
account: `POST /api/strolls`, `GET|POST /api/join/:code`, `GET /api/s/:id`
(`?since=t`), `POST /api/s/:id/stamp`, `DELETE /api/s/:id/me`; organizer:
`POST /api/s/:id/act`, `GET /api/s/:id/cards`, `DELETE
/api/s/:id/cards/:tag`, `POST /api/s/:id/draw`, `DELETE /api/s/:id`. Signed
in: `GET /api/mine`, `POST /api/s/:id/keep`, `DELETE /api/mine/:id`. The
shared account at `/api/auth`.

## Not built, on purpose

- A way to contact a winner, or any shopper detail beyond a first name.
- A link for each shop to see its own count; a second organizer; a kiosk
  mode where the shop scans the shopper.
- Rotating or time-limited counter codes, location checks, a purchase
  check: a stamp is a visit, on the honour of a sign at a counter.
- Queued offline stamps; push; a map; shop logos or photos; a shopper's
  passport following them to another device.
- Legal wording for a prize draw. Sweepstakes rules differ by place; the
  sign says only "no purchase is needed for a stamp unless a shop's own
  sign says so", and the organizer is responsible for their own rules.
- Any model call.

## Security

A script CSP on every page; no inline `<script>`, `on*=` or `style=`;
clicks by one `data-act` listener. Every non-GET `/api/*` outside the
shared account refuses another site's request (403) and a body that is not
JSON (415). Every name is untrusted: cleaned in the core, escaped on
render. `Referrer-Policy: no-referrer` and `noindex` on the stroll APIs.
Only the app's own errors reach the page in their words. Maps keyed by
typed text have no prototype (a shop called "constructor" is just a shop -
tested).

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
