# For Claude: Sorted

Keep, sell, donate or toss - one swipe at a time. Watch the clutter go and
the cash add up. For anyone clearing out a closet, a garage, a kid's
outgrown clothes and toys, or a whole home before a move.

- **The decision deck**: one big card at a time. Swipe right to keep, left
  to toss, up to sell, down to donate, or tap Maybe. Five big buttons do the
  same (with the arrow and key under each), arrow keys and M on a desktop,
  Undo (U, Ctrl/Cmd+Z, or the toast). The card tilts as it is dragged and a
  stamp (KEEP / TOSS / SELL / DONATE) fades in with the distance; a light
  haptic where the phone supports it.
- **The 10-minute sprint**: pick a room (Closet, Kitchen, Kids' room, Garage,
  Bathroom, Desk, Other); the clock starts at once. Type a name (the picture
  is picked from it) or snap photos, swipe each. Pause and resume; at zero it
  says "That's ten minutes" quietly - no alarm - with "See my recap" and "5
  more minutes". The recap: "12 things in 10 minutes - 5 to donate, 3 to sell
  (about $85), 3 to toss, 1 kept", the room's progress ("Kids' room: 31
  sorted, 22 leaving") and a gentle streak of days with a sprint.
- **The piles**, each with somewhere to go:
  - **Sell**: asking price, where it will be listed (Marketplace, eBay,
    Vinted / Poshmark, a yard sale, consignment, somewhere else; a link only
    if https), status (to list / listed / sold / didn't sell, which offers
    Move to Donate), sold price. **Copy listing** builds plain text from the
    name, condition, price and note. **Money made**, and a 15% **price drop**
    suggested for anything listed more than seven days (or seven days since
    the last drop).
  - **Donate**: bags ("Put them in Bag 3"), a drop-off checklist ("Bag 1: 8
    items - dropped off ✓"), and an itemised list with the person's own
    estimated values, copied or downloaded as CSV: "Keep your donation
    receipt; values are your own estimates." No tax advice.
  - **Toss**: static, generic hints by kind (textiles, e-waste, hazardous,
    paper, kitchen, toys, furniture, decor, bathroom, tools) under one line:
    check your council's or city's rules. Never a claim about local rules.
    Each thing has "Gone ✓".
  - **Maybe**: a box with a date 30 days out. On the day, an in-app nudge on
    Home and in the pile ("Thirty days without needing it. Let it go?") and,
    if wanted, an `.ics` reminder made on the phone.
  - **Keep**: what is staying; open one to change your mind.
- **The tally**: "47 things out of the house · $312 made · 6 bags donated", a
  stacked bar chart by week (inline SVG, labelled for screen readers) and
  bars by room, the streak, and a **recap image** (1080 x 1350, drawn on a
  canvas on the device) shared with `navigator.share({files})` where allowed,
  else downloaded. Never uploaded; no photos on it unless the box is ticked
  (off by default). Two taps - draw, then share - because iOS needs a fresh
  gesture for the share sheet (trip-planner's recap card does the same).
- **Up for grabs** (signed in to make one; friends need no account): see
  below.
- **"What could this sell for?"** (metered): see below.

Built 2026-10-30 as an **everyday** drop: Stray (2026-10-29) was a business
one, so today was the other kind - and not Halloween-themed, because the
Halloween holiday drop is tomorrow. **Staging only**: no custom domain until
Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/sorted`,
served at `challenge.strongtechnicalconsulting.com/sorted/`, data in
`sorted_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it was picked (everyday life)

- **Decluttering stalls on decision fatigue.** Every object is a small
  decision with a memory or a price tag attached, and a person who faces a
  full closet faces two hundred of them at once. One card at a time, with
  four directions and a Maybe that defers without guilt, turns that into a
  fast, almost playful loop - and a ten-minute sprint makes starting easy.
- **And on the piles that never leave the house.** The sell pile nobody
  lists, the donate bag in the car boot for a month, the "maybe" box in the
  loft forever. Each pile here has a next step: listing text, a price drop
  after a week, bags ticked off at drop-off, toss hints, a Maybe date - and a
  link so friends and family claim things before they go.
- **Free on the device.** The deck, sprints, piles, tally and recap image
  work signed out and offline, with no request at all.
- **Timely.** Before the holidays people make room - for guests, for gifts,
  for a move in the new year.
- **It could be an iPhone app** (below).

**Not a repeat:** Glowup improves an existing listing (and Sorted does not
rebuild that - its listing text is a plain starting point); Boomerang tracks
things lent and borrowed; Shelflife is food. Nothing in the lab or the
portfolio decides what to do with things and gets them out of the house.

**Who pays.** Almost nobody. Everything above except two things is free,
needs no account and makes no request. A **free** account makes up-for-grabs
links. The one metered thing (Haiku for the free tier, Sonnet for members via
`identity.planFor`) costs about a cent.

**How it becomes an iPhone app.** The deck is a native swipe with real
haptics; the camera feeds a sprint directly; a Live Activity counts down the
sprint on the Lock Screen; a widget shows "3 things in the Maybe box are due";
local notifications on the Maybe date and when a friend claims something;
the share sheet sends the recap image and the link.

## The decisions that matter

- **One rules file, run three times.** `public/sorted-core.js` is UMD
  (`window.SortedCore` in the page, `require` in the server and tests): the
  emoji, cleaning, money, an item, the deck and undo, swipe thresholds, the
  sprint, the recap, the streak, rooms and weeks, the tally, the piles, the
  Maybe box and its `.ics`, what a link may carry, what the estimate may send
  and accept, and the sample closet. **No clock and no dice** (tested: no
  `Date.now()`, `new Date()` or `Math.random`): "now", "today" and every new
  id are handed in. No storage, no network, no lookbehind regexes.
- **The emoji are a curated set of 84** household pictures (`EMOJI`: emoji,
  label, kind, words). A typed name finds its **head noun** from the last
  word back, longest phrase first ("running shoes" are 👟, "wine glasses"
  🥂), and **container words** ("box", "bag", "set", "pile"...) defer to what
  they hold ("Lego Duplo box" is 🧱, "bag of socks" 🧦, "sleeping bag" still
  ⛺). Unknown is 📦. The kind drives the toss hints.
- **The deck is pure**: `decide(deck, id, decision, o)` returns a new deck
  with the old item on an undo stack (30 deep); `undo` puts it back exactly.
  The queue is oldest first; a sprint sorts only its own things. A decision
  that moves an item to another pile clears "out of the house"; it is decided
  again there. `dragDecision` / `dragHint` are the swipe's rules (a distance
  threshold of about 28% of the card, or a quick flick past a third of it).
- **The sprint** is `{startedAt, durationMs, pausedAt, pausedMs, endedAt}`:
  time left counts pauses out; "5 more minutes" starts from now if time had
  run out; finishing an hour late still records ten minutes. The page ticks
  a once-a-second display only while the sprint is on screen.
- **"Out of the house"** is an `outAt` on the item, set when it is sold, its
  bag is dropped off, it is marked gone, or a friend's claim is marked
  collected. The tally counts those, money made is the sold prices, and the
  weekly chart buckets decisions by the day they were made.
- **The first run** (put real effort into): a hero with a wobbling mock deck
  and four direction labels, **Try it** (twelve made-up closet things as
  emoji cards - a wedding guest dress worn once, a band T-shirt from 2009,
  odd socks - with a "Drag me" coach on the first card, ending in the same
  recap a sprint gets; never saved) and **Start a 10-minute sprint**, a
  three-step "How it works" and "Or add things one at a time".
- **Photos stay on the phone.** Each is redrawn through a canvas at 1200 px
  (and a 240 px thumbnail) - which drops its EXIF, location included - and
  kept in IndexedDB. The page says so in one quiet line. Only two things ever
  leave: a thumbnail on an up-for-grabs link when "include photo" is left
  ticked, and the one photo sent for an estimate, shown before the tap.
- **Neutral copy**: no he/she anywhere (tested over every string).

## Up for grabs (signed in to make; friends need no account)

The owner ticks things from the Donate pile (ticked by default) and the Sell
pile (with the price shown), writes a note friends see per item (prefilled
with the condition - **never the item's own note**, which is private), keeps
or unticks "include photo", sets the message (default "Before it goes to the
charity shop on Saturday - anything you want?"), the name friends see (a
first name or "A friend" - never the email) and 1-14 days (7 by default).

- **Data** (`sorted_grabs/<id>`, `sorted_thumbs/<id>-<item>`): a link is
  `{owner, title, from, currency, createdAt, expiresAt, closedAt, items: [{id,
  name, note, emoji, price, photo, thumb, claim}]}`; a claim is `{name,
  device, at, collected}`. Thumbnails are their own documents (no bucket, no
  new infrastructure), uploaded one at a time after the link exists
  (`PUT /api/grabs/:id/items/:iid/thumb`, 96 KB parser after sign-in), only
  for items published with `photo: true`, while the link is open.
- **The code** is 16 random bytes (22 characters, base64url) and is **never
  stored**: the document id is a hash of it (like Canon's share links). The
  owner's device keeps the code (`sorted-data-v1` → `links`); another device
  of theirs sees the claims but not the link.
- **The owner** is an HMAC tag of the account id under a key derived from
  `IDENTITY_SESSION_SECRET` ("sorted owner v1", Stray-style) - never the uid
  or the email (tested against the stored documents). No secret: 503.
- **Claims**: `POST /api/g/:code/items/:iid/claim {name}` in a **transaction**
  on the link's one document - six friends tapping at once give one 200 and
  five 409s ("Someone got there first - that one's been claimed. Have a look
  at the rest!"). The claimer's browser gets an HttpOnly `sorted_d` device
  cookie (path-scoped to the app); a claim keeps only a hash of it, so only
  that browser (or the owner) can release it; once the owner marks it
  collected the friend cannot. Other friends see "Taken", **never who**; the
  owner sees first names. Names are cleaned (no markup, no bidi or invisible
  characters, 30 characters, a letter or digit required) and escaped.
- **The owner's screen** re-asks every 30 s while it is open and visible and
  on returning to the app; the friend's page every 45 s and on return. A claim
  marked collected marks the thing out of the house on the owner's phone
  (sold at its price if it came from the Sell pile).
- **Expiry and closing**: expired, closed, unknown and malformed links all
  answer the **same 404, word for word**, to friends and their thumbnails.
  Expiry is worked out on read (no timer). The owner still sees a closed or
  expired link for 14 days to hand things over; after that, the read that
  finds it deletes it and its thumbnails. **Deleting** a link deletes its
  items and thumbnails at once.
- **Limits** (in memory, per instance - they slow a script, they do not stop
  a determined one): 3 open links per account; 10 new links an account an
  hour; 200 thumbnail uploads an account an hour; 600 owner reads an account
  per 10 minutes; 40 claims and releases per address per 10 minutes (4,000
  across the instance); 600 friend reads per address per 10 minutes; 30
  **distinct** wrong codes per address per 15 minutes, then even a real one
  waits (one dead link polled again counts once). IPv6 counts by its /64.
- `g/<code>` is the same page one level down with `<base href="../">`,
  `no-referrer` and `noindex`. Offline, the service worker answers it with a
  small page saying the list needs the internet; the page says the same if
  the network drops after it loaded.

## The model call (metered, signed in only)

**`POST /api/ai/estimate`**: `requireUser, requireBudget, requireDailyCap`
**then** the route's own 768 KB parser (401 / 402 / 403 / 503 before it,
never 413 - tested), then `ai.brief` rebuilds the request (`estimateRequest`:
`{name, cond, currency, image?}` and nothing else - a note, a price paid or a
room is a 400; the image must be a JPEG or PNG **by its bytes**, at most
560 KB and 1600 px, and its metadata is dropped before the model sees it),
then one forced tool `estimate_price` through **one call site** (`ai.ask`,
the only `messages.create`), then `cleanEstimate`: whole amounts at or above
zero, high at or above low (swapped if not), a known confidence ("high" needs
a photo), a reason, a title of 80 characters and three tips, all plain with
no links or markup. The prompt says plainly not to invent brand or model
details it cannot see, and fences the name as untrusted data. Nothing is
stored or logged.

The sheet shows exactly what is sent first ("this photo (shrunk on this
phone, location removed), the name "...", the condition "..." and your
currency - nothing else"), and the answer says "An estimate - check sold
listings". "Ask $40" puts the midpoint as the asking price; "Use the title as
its name" renames it. The currency comes from the page's locale (two-decimal
currencies only; USD otherwise), changeable on the Tally. Signed out it says
it needs a free account; 402 opens the credit sheet; 403 `verify-email` shows
its sentence and "Send the link again"; sheets size themselves below the
shared confirm-your-email banner.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8143/sorted/
npm test        # the rules first, then end to end over HTTP under a /sorted mount
```

`SORTED_MEMORY=1` and `SORTED_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `SORTED_COLLECTION_PREFIX`
(`sorted_` from the lab host) prefixes every collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that does not
force a tool, keeps every request (`fakeClient.calls`), and reads triggers in
the item's name (or `fakeClient.mode`): `BLANK`, `INJECT`, `MAXTOKENS`,
`UPSTREAMnnn`.

`test/run.js`: the emoji and the head-noun guess; text cleaning and escaping
(markup, bidi, zero-width, emoji-only names); money and currencies; a hostile
item (bounds, unknown fields, a future time, prototype pollution, unsafe
links); the deck, undo and its bound; swipe thresholds; sprint maths with
pauses, extensions and a late finish, and the recap line; the streak; rooms,
weeks and the tally headline; price drops and listing text; bags, the
itemised list and CSV injection; toss groups; the Maybe box and its floating,
escaped, folded `.ics`; the up-for-grabs and estimate payloads both ways;
thumbnails by their bytes (EXIF, comments and PNG text dropped; GIF, SVG,
oversize and too-large refused); the sample closet; contrast in both themes,
the literal colours and the lab card; 44 px targets; the page's promises
(relative URLs, no inline script, wrapped storage, IndexedDB in a try, the
banner, every received string escaped, only the listed API paths, what a
link and an estimate carry); neutral and non-Halloween copy; the local
switches and the one equality query; and over HTTP: signed out with zero
model calls and 401s before every parser, no route that takes your things,
the gate order, one door and one call site, a link's life (code never
stored, owner tag, what a friend sees, another account's 404s), thumbnails
(only with "include photo", by their bytes, deleted with the link), six
concurrent claims with one winner, releases only by the claimer's device or
the owner, collected, name cleaning, the identical 404s for expired, closed,
unknown and malformed, the owner's 14-day keep then deletion on read, the
limits (open links, distinct wrong codes, claims per address), the estimate
(400s with no model call, what the model saw, hostile output, provider
errors), and the 403 / 402 / 503 gates.

Rendered with Playwright at 390px and 1280px, light and dark: the first run,
Try it mid-swipe (the SELL stamp showing) and its recap, the room picker, a
sprint running (with the price prompt) and its recap, adding by name and by
photo, each pile, the tally and its chart, the recap image (saved as PNG),
the Maybe box, the estimate signed out, signed in before and after (and the
verify-email 403), making a link, a friend's page before and after claiming,
a second friend seeing "Taken", the owner seeing the claim, a closed link,
and the lab card on the landing page; then a hostile pass (markup, bidi and
60-character strings in names, notes, a link's message and a claim name).

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Data

- **In the browser** (every access wrapped; works in memory when storage is
  unavailable, with a one-time warning): `sorted-data-v1` (items, sprints,
  bags, the running sprint, and the codes and item maps of links this device
  made), `sorted-prefs-v1` (currency, last room, a friend's own first name for
  claiming, the coach seen, the name shown on links); IndexedDB `sorted`
  (`photos`: the 1200 px and 240 px JPEGs by item id). Clear everything on
  the Tally page.
- **In the lab database**: `sorted_grabs/<hash of code>` and
  `sorted_thumbs/<id>-<item>` (above). Nothing else - no item, no pile, no
  sprint, no estimate is ever stored by the server.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `g/:code`, the
service worker. No account: `GET /api/g/:code`, `GET
/api/g/:code/thumb/:iid`, `POST|DELETE /api/g/:code/items/:iid/claim`.
Signed in, free: `GET|POST /api/grabs`, `GET|DELETE /api/grabs/:id`, `POST
/api/grabs/:id/close`, `PUT /api/grabs/:id/items/:iid/thumb`, `POST
/api/grabs/:id/items/:iid/collected`, `DELETE
/api/grabs/:id/items/:iid/claim`. Metered: `POST /api/ai/estimate`. The
shared account at `/api/auth`.

## Ideas not built yet

- **Sync the piles to the account** for a second phone (a household clearing
  out together) - kept on the device for v1, so nothing about anyone's things
  is stored.
- **"Did it sell?" nudges** for listings with a link, by the date listed.
- **A moving-house mode**: rooms of the new home as a fifth direction
  ("pack").
- **Charity-shop opening hours** for the drop-off - would need a places API.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; every parser that takes more
  than 16 KB runs after its gates.
- Every typed name and note, every friend's name, every link and every model
  answer is untrusted: cleaned in the core, bounded, and escaped on render;
  the `.ics` and the CSV are escaped for their own formats (formulas
  defused). Thumbnails are checked by their bytes and stripped of metadata.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body, a name or a photo.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
