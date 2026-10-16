# For Claude: Jars

Pocket money in three jars - spend, save, give - and watch the savings grow.
For parents of kids roughly 5 to 12 who want to teach money with the pocket
money they already give, but whose system is coins in a drawer, an IOU they
forget, and a kid who can't tell how long it is until the LEGO set. Jars keeps
each child's three jars **on the parent's phone**, runs **payday by itself**
(split three ways, missed weeks caught up, never twice), shows a goal as
"about 6 more paydays", pays optional **Bank of Mum & Dad interest** so
saving is visible, guards money moves with a **grown-up PIN**, and gives
grandparents a **read-only snapshot in a link** - with a "gift note" they can
send back.

Built 2026-10-16 as an **everyday** drop: Zoned (2026-10-15) was a business
one, so today was the other kind. A free pick from ordinary life (family,
money) - not from the inbox, not a holiday. Not a repeat: Chorus deliberately
left pocket money out ("Points measure effort for fairness; turning them into
pocket money is a different (and touchier) product" - `apps/chorus/CLAUDE.md`),
and Drip and Tieout are
adults' money. **Staging only**: no custom domain until Erik decides it is
worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/jars`,
served at `challenge.strongtechnicalconsulting.com/jars/` once it has a
`lab.js` entry, deployed with `gcpdeploy ship challenge`. See
`challenge/CLAUDE.md` for mounting, prefixes and graduation. Every browser
URL is relative to `BASE`; keep it that way. **It stores nothing in the lab
database** (see Data).

## Why it exists

Pocket money works when a child can *see* it: what's theirs to spend, what's
put by, how far off the big thing is. In most homes it is coins in a drawer
and a running IOU ("I owe you three weeks"), so the lesson is lost and the
parent is the only one who knows the balance. Jars is the jar on the shelf,
made exact: three jars a kid can tap, a payday that just happens, a goal
counted in paydays (the unit a 7-year-old understands), and interest that is
deliberately big enough to notice.

**Who pays.** Nobody. Everything is free, needs no account, and makes no
request.

## No model call - on purpose

Jars has **no AI anywhere**: no `/api` model route, no AI button, no
Anthropic SDK in `package.json`. A children's money app has nothing it needs
a model for, and nothing about a child - a name, an age, a balance, what
they spent their money on - should be sent to one. The test suite holds it:
no SDK dependency, no `new Anthropic`/`messages.create`/`identity.meter`/
`requireBudget` in any source, no `lib/ai.js` or `lib/fakeai.js`, every route
the app defines is a GET (writes are only the shared account's), and the
usage ledger is empty after the whole suite. If a future version wants AI,
it needs a reason good enough to undo this paragraph, and it goes behind the
lab's usual gates.

The shared identity is still mounted at `/api/auth` like every lab app (the
verify banner asks it, and the lab stays consistent), but **nothing in Jars
needs an account**, and the page shows no sign-in.

## The decisions that matter

- **One rules file, run four times.** `public/jars-core.js` is UMD
  (`window.JarsCore` in both pages, `require` in the server and tests):
  money, the split, `cleanKid`, dates, paydays, interest, goals, every move
  and undo, the history readers, the jar and ring drawings, the snapshot link
  and its renderer, the gift note, the PIN, CSV, the calendar and
  export/import. `public/demo.js` builds the example from it. The tests check
  those two files.
- **Money is integer minor units, everywhere** (pence, cents, yen). Typed
  amounts go through `parseMoney` ("2.40", "2,40", "£2.40", "1.240,50",
  "60p", "45c" - built from the digits as strings, never a float, never
  negative); out through `money` (Intl) and `short` (a kid's "£3", "60p",
  "45¢"). JPY has no minor unit. The CSV writes amounts with `plain()`, by
  integer arithmetic.
- **The split** is whole percents summing to 100 (`cleanSplit`, else
  50/40/10). `splitAmount` rounds **Spend and Give down and gives Save the
  remainder**, so the parts always add up to exactly the amount, and the page
  says "Odd pennies go to Save". The sliders (`rebalance`) move the other two
  in proportion, on 5% steps when the slider steps by 5; tested over 5,000
  random moves always summing to 100.
- **Paydays are calendar days in the phone's zone** (`localDate`), counted
  with UTC-midnight arithmetic on 'YYYY-MM-DD' strings, so a clock change
  cannot move, skip or double one (tested by opening the app every 37
  minutes for a year in London, New York and Sydney). `runPaydays` pays
  every payday on or after `start`, after `paidThrough`, up to today, oldest
  first: interest on Save as it stood, then the pocket money split.
  **Idempotent**: `paidThrough` moves, and a week already in the history is
  never paid again even if `paidThrough` were lost. Catch-up is capped at 104
  weeks (the rest counted and said). A new child's first payday is the next
  one unless today is payday and the parent ticks "pay this week's now".
  Moving payday to another weekday never pays twice in a week (the next is at
  least seven days after the last). Changes to amount or split apply from the
  next payday.
- **Interest** (`interestFor`): `bp` basis points a week (0.5, 1, 2, 3 or 5%)
  of Save, half a penny rounds up, capped per week (default: one week's
  pocket money; blank = none). 2% a week is **deliberately generous** - far
  more than a real bank, so a child sees it - and every screen that shows it
  says so. The chart and the goal ETA use the same `grow()` as payday
  (tested equal to real paydays).
- **Goals**: several, one active; the Save jar fills toward the active one
  (`fills`). `goalStatus` gives saved / pct / "About 6 more paydays" and the
  date, with interest, and "without interest it would be 9". Queued goals
  show their ETA *after* the active one. `checkReached` marks a goal reached
  once (the celebration: confetti, none under reduced motion); **Buy it**
  takes the price out of Save (grown-up) and the next goal takes over.
- **Moves** (`act`): spend (from Spend), give (from Give, "to whom", the
  child's cause prefilled), move between jars, add (birthday, gift, earned
  it, tooth fairy, other; split or one jar), buy, fix (a parent corrects a
  jar to the real coins). **No jar ever goes below zero** (a 3,000-move
  random run holds it). Undo is of the latest move only, refused once
  anything else (a payday) happened.
- **The grown-up PIN** (`needsGrownUp`): adding money, anything out of Save
  or Give, buying, correcting, editing a child, reset/remove, import, delete.
  Spending from Spend, giving from Give and moving money *into* Save are the
  kid's own. Four digits, stored only as a **salted PBKDF2-SHA256 hash**
  (60,000 rounds; a salted FNV fallback where WebCrypto is missing), compared
  in constant time, five wrong tries = 30 seconds. **A speed bump for little
  fingers, not security**, said on every PIN screen. The first time it is
  needed the parent sets one or chooses "No PIN on this phone". Forgotten:
  a times-table question removes it (kids' apps' parental gate - and the page
  admits a determined kid could do it too). Unlocked for two minutes, in
  memory. The example family's PIN is 1234, shown on the sheet.
- **First names only, by design** - said on the setup form. Age is optional
  and never leaves the phone (not even in the grandparents' link).
- **Dates** redraw when the day turns (a minute check while visible, and on
  coming back to the foreground), and payday runs then too.

### The example family (`public/demo.js`)

Maya (9, 🦊) and Leo (6, 🐸), about four months of history worked out from
today **by the app's own rules** (each payday by `runPaydays`, each spend,
gift, move and purchase by `act`). Both are paid on today's weekday and
today's payday is left unpaid, so opening the example *shows a payday*
("Paid today: £3 spend, £2.40 save, 60p give · Your savings earned 75p!").
After it, Maya is **exactly six paydays** from a £60 LEGO set at 2% a week
(the size of Grandma's birthday money is found by binary search so the
app's ETA says six, in any currency), with an art set bought earlier, a bike
bell queued and a Give jar for the animal shelter; Leo bought a dinosaur
torch and is **40p short** of his sticker book, with enough in Spend to move
it himself - the quickest way to see the celebration. The test holds the
story every third day of a year across GBP, USD, EUR, JPY, INR and SEK.
Amounts scale for rupees, kronor and the like. Taps work, never saved.

### The grandparents' link

- **Share** tab: a preview of exactly what they'll see - the child's three
  jars, the goal ring and ETA, the Give cause, and "where the money went"
  (the last 12 spends, gifts and purchases). **Hide the amounts** draws the
  jars by how full they are and the goal as a % - and leaves *no* amount in
  the link at all (tested). Never in it: the id, age, settings, history of
  money in, other children, the PIN.
- **The fragment**: `packSnapshot` JSON, deflated with `CompressionStream`,
  base64url: `gran#v1.z.<...>` (`v1.p.` plain where a browser can't
  compress). At most 6,000 characters; too long trims the oldest rows.
  **Browsers never send a fragment to a server**: the test records every
  request while a link is fetched and finds only `/jars/gran`.
- **Decoded defensively** (`decodeSnapshot`, never throws): version and
  charset, length cap, inflate capped at 64 KB (a deflate bomb is refused),
  strict UTF-8 and JSON, then `cleanSnapshot` field by field. The page
  (`gran.html`, `gran.js`) makes **no request** - it doesn't even load the
  verify banner - and escapes everything (`snapshotHtml`).
- **The gift note.** The grandparents' page offers "Send Maya a gift note":
  from, amount, which jar (or the usual split), a message. It makes a short
  code (`g1.<base64url JSON>`, 800 characters at most) inside a link back to
  the app (`…/jars/#gift/<code>`), sent through their own share sheet or
  copied. **A note, never money**, and it says so plainly on both sides: no
  money moves through Jars; the grandparent gives it the usual way and the
  parent adds it. Opened on the parent's phone (or pasted into Share), it
  shows the note, which child, which jar, and "Add it" behind the PIN.
  `readGift` is defensive like the snapshot.

### The calendar, the fridge, moving phones

- **No reminders** (no sender on the platform). **Paydays in my calendar**:
  `icsFor` writes one weekly all-day event per child (`RRULE:FREQ=WEEKLY;
  COUNT=26;BYDAY=..`, from the next payday, the split in the description)
  plus the active goal on its expected payday. RFC 5545: CRLF, folded at 75
  octets on whole characters, escaped. A snapshot, said so.
- **Money chart for the fridge** (Grown-ups): one printed page per child -
  the split as three jars with percent and amount, a ladder of the paydays
  to the goal to colour in, the next eight paydays with tick boxes. Print CSS
  (dark ink on white whatever the theme).
- **Export CSV** (every event; `csvCell` puts an apostrophe before text
  starting `= + - @`, tab or CR, quotes when needed - our own amounts are
  numbers and left alone), **export / import JSON** (`exportFamily` without
  the PIN; `importFamily`: 2 MB, `app: 'jars'`, every child through
  `cleanKid`, 8 at most, duplicate ids remade; replacing needs the PIN).
- A service worker (`sw.js`, Sprout's pattern) keeps the app and the
  grandparents' page working offline: network first, own scope only, never
  `api/`, only `jars-*` caches.

## The screens

- **First run**: three jars, "Pocket money in three jars.", *See an example
  family* / *Set up my kids*, how it works, and the promise that nothing
  leaves the phone.
- **Jars** (the kid's screen, every target ≥ 48px, the moves 60px): the
  child's colour band, the payday line ("Paid today …" or "Next payday on
  Saturday · £6"), three jars drawn in SVG with their amounts and words
  (never colour alone), Spend / Give / Move / Add money 🔒; beside them the
  goal ring, the interest card with its 12-week "with vs without" chart, and
  what happened. Tap a jar for its history and its moves.
- **Goals**, **Share**, **Grown-ups** (all children, held for the kids,
  in/out this month, a month table, edit / money chart / reset / remove,
  tools, currency, the PIN, delete everything), and the add/edit form (name,
  age, avatar, colour, pocket money with a hedged rule of thumb, payday, the
  split sliders and presets, the Give cause, interest, starting amounts).
- Phone: a bottom tab bar. Desktop (`desktop.css`, `body.dk`): a left rail,
  the jars beside the goal; forms and Share keep a reading width.

## Local run and tests

```
npm run dev     # memory identity, at http://localhost:8131/jars/
npm test        # pure rules, the pages, then end to end over HTTP under /jars
```

`JARS_MEMORY=1` (the shared account in memory) **throws on Cloud Run**
(`K_SERVICE`) in `lib/store.js`; `JARS_FAKE_AI=1` - which the lab's `npm run
dev` sets for every app - does nothing here (there is no model to fake) and
is refused on Cloud Run in `server.js` like every sibling's. The tests spawn
both with `K_SERVICE` to prove it. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0` like the others, though nothing here spends.
Screenshots at 390px and 1280px, light and dark, were taken with
playwright-core against `npm run dev` (first run, payday, the jars, the PIN,
the celebration, the sliders, interest, Grown-ups, goals, Share, the fridge
chart in print media, the grandparents' page and a gift note).

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`.

## Data

**None in the lab database, and nothing about a child ever leaves the
phone** except in a link the parent chooses to make. Tested: after the suite
the identity store holds only `users`, `usage`, `events`, `control`, no
child's name or anything else from Jars, and no usage rows.
`lib/store.js` reads `JARS_COLLECTION_PREFIX` so that anything Jars ever
stores is prefixed from its first write. **On the phone:** `localStorage`
`jars-family-v1` - `{v, settings: {currency, curAuto}, pinMode, pin (hash),
kids, kidId}`; every access in try/catch, read back through `cleanKid`; a
browser that refuses storage is told once, and the jars last the tab. The
grandparents' page keeps nothing.

## Routes

Public: `GET /api/health` (`{stores: 'nothing', model: 'none'}`),
`/api/meta`, `/sw.js`, `/gran` (the grandparents' page; `no-referrer`,
`noindex`), the page. The shared account at `/api/auth`. **There is
deliberately no route that takes a child, a jar or an amount, and no model
route** (tested: a dozen likely paths are 404).

## Ideas not built yet

- **Two parents, one family** - Shelf Life's online-kitchen pattern would
  fit, but it would put children's data on a server; today a family is one
  phone's, and export/import moves it.
- **A kid's own view on their own device** (read-only, by link) - the
  grandparents' snapshot is most of it.
- **Chores that earn** - Chorus measures effort for fairness and keeps money
  out on purpose; a bridge would need care.
- **The iPhone shape:** a widget with the three jars, a payday notification
  (local, no sender), Family Sharing.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=` in
  either page; handlers by `data-act` and `addEventListener` (tested).
- Names, notes, causes, goals, imported files, snapshot links and gift notes
  are untrusted: cleaned (markup, control and bidi characters stripped,
  bounded), escaped on render, never `eval`'d. Emoji and colours only from
  their lists.
- The page makes no request of its own (tested: no `fetch`, XHR, beacon,
  WebSocket); the grandparents' page, the rules and the example touch no
  storage and no network.
- Nothing runs after a response (billed per request): the server has no
  timers.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
