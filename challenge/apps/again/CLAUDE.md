# For Claude: Again

Remember what you loved - and order it again. For anyone who eats out and
forgets what was good last time ("what did we get here that we loved?",
"which one was the soggy fries?"), and anyone whose friends keep
recommending dishes they then forget.

- **First run** (real effort went here): a hero with a mock "You're at
  Orzolino" card ("❤️ Order again: Cacio e pepe ×3, The burrata · 👎 Skip:
  Tiramisu - too sweet · 💬 Friends said try: The carbonara - from Alex"),
  **Try it** (ten made-up places in Riverton and Lakeport, 26 dishes in every
  verdict, five friends' picks - open, tried and place-only - with a ribbon
  that says nothing is saved, "Start my own" and "Leave") and **Add a place
  I loved**; then how it works in three steps and three feature cards.
  **The demo is unmistakably fictional on purpose** (2026-11-04 review):
  Riverton and Lakeport are invented cities, every neighbourhood ("Old
  Mill", "Canal Row", "Southbank"...) and place ("Orzolino", "Hickory &
  Hush", "Gullwing Oyster Bar"...) is invented, because the sample puts
  "Skip - gluey", "watery", "soggy" on places. No real restaurant, city or
  neighbourhood name may appear in the sample, the hero mock, the share-card
  demo, the tests or this file - keep it that way when editing them.
- **Logging a visit takes seconds**: the place (fuzzy search over the
  places already kept, or a new one with neighbourhood, city - the cities
  already used are offered - and a cuisine chip from a curated set, each
  with its emoji), then **"What did you have?"**: type a dish and tap one of
  three big buttons - **❤️ Order again, 👍 Fine, 👎 Skip**. The same dish
  again takes the new verdict instead of doubling. Dishes already kept at
  that place are chips ("Had one of these again?") that add with one tap.
  Each added dish opens for a one-line note ("ask for it spicy"), a price
  and a photo; when and who with (first names, the recent ones as chips)
  default to today and nobody, below. Opened from a place's card ("I'm
  having…") the place is already picked. Save has Undo.
- **"I'm here"** (the moment the app exists for): search a place - "orzolino",
  "ORZOLÍNO", "the orzolino", "hickory & hush" = "hickory and hush", "hick", "hush",
  "ozrolino" (a swapped pair), "orzolina" (one wrong letter), a neighbourhood, a
  city or a cuisine - Enter opens the best match. One big card: the place
  on the gradient with its cuisine emoji, neighbourhood, city, "Last here 3
  weeks ago, with Sam and Priya · 3 visits"; **Order again** in the biggest
  type on a tinted band, most-ordered first with "×3"; **Fine**; **Skip**
  struck through with the reason; **Friends said try** for this place with
  "Tried it"; then "I'm having…" and "Read the menu". Visits (each day and
  who was there) sit under it on a phone and beside it on a desktop. Tap a
  dish to change its verdict, note, price, name or photo, or delete it.
- **Want to try**: "The mole at Casa Lunaria - from Priya · last week · Fairhollow,
  Riverton" with what they said, grouped by city. **Tried it** opens three big
  buttons; the dish is logged today at that place (added if new) and the
  pick moves to Tried as **"Priya was right ❤️"** ("Priya's pick: fine 👍",
  "Not for you 👎 - sorry, Priya"). A place-only pick adds the place and
  opens the log. **Logging the recommended dish settles it too** (logging
  "the carbonara" at Orzolino answers Alex's pick, and the toast says "Alex was
  right ❤️"). Picks also show on the home search and on the place's card.
- **Browse**: city chips (opens on the city of the most recent visit),
  cuisine chips, then Places, **❤️ Again** ("Every ❤️ in Riverton", grouped
  by place) or **Dishes** ("anything with short rib", names and notes). The
  year so far: places tried this year (and how many new), visits this
  year, favourite cuisine (most ❤️ dishes; ties by name), the share of
  dishes you'd order again, and the dish ordered again most. Nothing
  gamified.
- **Share card** (per city): "My top dishes in Riverton", 1080 x 1350, drawn
  on a canvas on the phone, never uploaded - dish and place names and ×N
  only, no notes, prices or names; **dish photos only if the box is ticked
  (off by default)**. Two taps (draw, then share) because iOS needs a fresh
  gesture for the share sheet; downloads where sharing files is not
  offered.
- **Export / import**: JSON (everything but photos) and CSV (one row per
  dish, place or pick; every day and who was there kept as "2026-10-01:
  Sam, Priya; 2026-08-12"; formulas defused with a leading `'`, RFC 4180,
  undone on the way back in). An import replaces by id rather than
  doubling.
- **Signed in (free)**: opt-in sync, and a read-only share link per city.
- **"Read the menu"** (metered, signed in): below.

Built 2026-11-04 as an **everyday** drop: Lastday (2026-11-03) was a
business one, so today was the other kind. **Staging only**: no custom
domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/again`,
served at `challenge.strongtechnicalconsulting.com/again/`, data in
`again_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it was picked (everyday life)

- **Everyday and frequent.** People eat out every week, and standing at a
  counter or sitting with a menu is exactly when the memory of last time is
  needed and gone.
- **Slightly embarrassing, and fun.** Ordering the same disappointing dish
  twice, or forgetting what everyone raved about, is a small universal
  failure. A verdict is one tap, and "Priya was right ❤️" is a small reward.
- **Notes apps and photo rolls are where this memory goes to die.** A note
  titled "restaurants" with no structure, a camera roll of plates with no
  names - neither answers "what do I order here?" in the two seconds before
  the server comes back.
- **Free on the device.** Logging, "I'm here", Want to try, browsing, the
  stats, the share card and the exports all work signed out, offline, with
  no request at all.
- **It could be an iPhone app** (below).

**Not a repeat:** Settle helps a group decide where to eat; Dibs splits a
bill; Shelflife tracks food at home; Flight and the portfolio's Hopscotch
are beer. Nothing in the lab or the portfolio remembers dishes at places
you have eaten.

**Who pays.** Almost nobody. Everything except the menu reader is free and
needs no account. A free account adds sync and share links. The one
metered thing (Haiku for the free tier, Sonnet for members via
`identityLib.planFor`) costs about a cent a menu.

**How it becomes an iPhone app.** A location-aware "You're here" card (the
place you are standing in, opened by itself), a widget with the ❤️ dishes of
the nearest kept place, the Share Sheet taking a menu photo straight into
the reader, and Live Text for a menu without the model at all.

## The decisions that matter

- **One rules file, run three times.** `public/again-core.js` is UMD
  (`window.AgainCore` in the page, `require` in the server and tests):
  text cleaning, folding and fuzzy search, places and dishes, logging a
  visit, quick-add, the "I'm here" card, Want to try, browsing and stats,
  the share link's payload and the server's door for it, JSON and CSV,
  sync cleaning and merging, the menu reader's request and answer, and the
  made-up list. **No clock and no dice** (tested): "today", "now" and every
  new id are handed in.
- **The model.** A place `{id, name, area, city, cuisine}` (a curated set of
  28 cuisines, each with its emoji; anything else is "Somewhere else"); a
  dish `{id, placeId, name, verdict, note, price, photo, orders: [{day,
  with}]}` - one row per dish per place, with every day it was ordered
  (newest first, one entry a day, up to 40) and the first names of who was
  there. A visit is a day at a place, worked out from the orders. A
  pick `{id, dish, place, area, city, cuisine, from, day, note, via, done}`.
  The same place is the same folded name in the same city.
- **One door for everything** - typed, stored, imported, synced, from a
  friend's link or from the sample: `cleanPlace`, `cleanDish`,
  `cleanWant` (no markup, bidi or invisible characters, bounded; prices
  whole cents at or above zero; days real and not in the future; first
  names letters only, so they can never carry markup or a separator; a dish
  whose place is not on the list is dropped).
- **Folding** (`fold`): NFKD with the accents dropped, lower case, "&" read
  as "and", apostrophes dropped, punctuation as spaces, a leading "the"
  dropped. **Fuzzy search** (`matchScore`): exact, prefix, a word's prefix,
  every word's prefix, a substring, then a typo (optimal string alignment,
  one edit under seven letters, two from seven), then the letters in order
  close together; the name counts most, the neighbourhood, city and cuisine
  less; ties go to the most recent visit.
- **Photos stay on the phone.** Dish photos are redrawn through a canvas at
  1200 px with a 240 px thumbnail - which drops EXIF, location included -
  and kept in IndexedDB. Sync, links and exports never carry them; the
  only image that ever leaves is a menu photo the reader sends, shown
  first, and it is not kept.
- **Neutral copy**: they and them, never a gendered pronoun (tested over
  every string and this file).

## Sync (signed in, free, opt-in)

Settings → "Phone and laptop" → **Turn on sync**, under a plain sentence:
sync stores the list - places, dishes, verdicts, notes, prices, the days
and the first names of who was there, and Want to try - in the lab's
database; photos stay on the phone; it is filed under a code made from the
account, never the email. Signing in alone uploads nothing.

- `lists/<tag>` = `{owner, list: {places, dishes, wants, deleted}, version,
  updatedAt}`. The tag is an HMAC of the account id under a key derived
  from `IDENTITY_SESSION_SECRET` ("again owner v1") - never the id or the
  email (tested against the stored documents). No secret: 503.
- **Whole-document writes in a transaction with a version**: `PUT /api/list
  {list, base}` saves only if the account copy is still the version this
  device last saw; otherwise **409 with the account's copy**, and the page
  asks **Use theirs / Keep mine / Merge by item** with the places and
  dishes each would leave. A device that never synced cannot overwrite an
  account copy; two saves at once give one 200 and one 409 (tested).
- **Merge by item** (`mergeLists`): every place, dish and pick from both,
  the later `updatedAt` wins, a deletion (`deleted: [{id, at}]`, 800 kept)
  beats an older edit and loses to a newer one, and a dish whose place is
  gone goes with it. Logging a dish touches its place, so a place deleted
  on one device and visited on the other survives. Photo flags are this
  device's and are put back after adopting another copy.
- **Cleaned and capped on the server** (`cleanList(strict)`): at most 500
  places, 2,500 dishes and 300 picks (413), 800 KB as JSON (413), a 1.1 MB
  parser after sign-in, unknown fields a 400, photo flags removed. 120
  saves per account in 10 minutes. No query: one document by its id.

## Share links (signed in to make; friends need no account)

Browse → a city → **Make a link**. The sheet shows the list it will send
(places and their dishes with ❤️, and 👎 if "Also what to skip" is ticked),
says what a link shows and never shows, takes the name the friend sees (a
first name, optional, remembered on this device) and 1, 7, 14 or 30 days.

- **What a link holds** - and the server takes nothing else
  (`shareRequest`: any other field anywhere refuses the whole request with
  a 400): the city, the sharer's "from", and per place its name,
  neighbourhood and cuisine, and per dish its name, verdict and the
  one-line note. **No prices, no companions' names, no dates, no photos**
  (tested on the payload, the request and the friend's answer). It is a
  copy of the list as it was; make a new link to update it.
- `shares/<sha256 of the code>` = `{owner, city, from, places, createdAt,
  expiresAt, opens}`. The code (16 random bytes, 22 characters) is the link
  and is **never stored** (tested). Canon's and Sorted's shape.
- **Closing deletes it**; an expired one is deleted by the read that finds
  it (no timer). Expired, closed, malformed and unknown links all answer
  **the same 404, word for word** (tested). At most **5 open** per account
  (429), 20 new an hour, 48 KB a link. The owner's list (`GET /api/shares`,
  one equality filter on `owner`, no index) shows each link's city, dishes,
  opens and expiry; the device that made one keeps its code
  (`again-links-v1`) so it can copy it again.
- **Friends**: `s/<code>` is the same page one level down (`<base
  href="../">`, `no-referrer`, `noindex`). They see "Sam's Order again list
  · Riverton · 11 dishes at 5 places · open until Nov 18" and each place's
  dishes; **"🔖 Save"** puts a dish on **their own device's** Want to try
  ("from Sam", their note) - nothing is written on the server - and "Save
  all" does the lot. Per address: 300 reads in 10 minutes, and **30 distinct
  wrong codes in 15 minutes**, then even a real link waits (the same dead
  link asked again counts once). IPv6 counts by its /64. In memory, per
  instance: they slow a script, they do not stop a determined one.
- Offline, the service worker answers `s/` with a small page saying the
  list needs the internet.

## The model call (metered, signed in only)

**`POST /api/ai/menu`**: `requireUser, requireBudget, requireDailyCap`
**then** the route's own 1.5 MB parser (401 / 402 / 403 / 503 before it,
never 413 - tested), then `ai.brief` rebuilds the request (`menuRequest`:
exactly `{image: {type, data}}`, and for "What should I order?" a
`history` of at most 120 `{dish, cuisine, verdict}` - **a place, a
companion, a date, a price or a note anywhere is a 400**; the image must be
a JPEG or PNG **by its bytes**, at most 1 MB and 1600 px, and its EXIF,
comments and PNG text are stripped before the model sees it), then one
forced tool `record_menu` through **one call site** (`ai.ask`, the only
`messages.create`), told the photo and either "no picks" or the dish names
with their cuisines and verdicts, then `cleanMenu`:

- at most 80 dishes, names plain with no links or markup and one row a
  dish, short descriptions, prices whole cents at or above zero and bounded
  (or none), a known currency or none, a known confidence ("low" when
  unknown), one short note;
- **picks only when they were asked for, only dishes from its own list**
  (matched by folded name to a row of the answer), no repeats, at most
  three, each reason plain and at most 140 characters.

The page shrinks the photo (1600 px, smaller until it fits) and shows what
is sent before the tap: "this menu photo, shrunk on this phone with its
location removed" and - only with "What should I order?" ticked - the
exact list of dish names, cuisines and verdicts from **other** places
(`historyFor`: loved and skipped first, most-ordered first, never the place
they are at), and "Never a place name, who you ate with, a date, a price or
a note." The answer is an **editable list**: "What to order" (the picks
with their reasons) on top, then every dish with its name editable and ❤️ /
👍 / 👎 to tap for what was eaten; nothing is added until **Add N dishes**
(with Undo; the Add row stays at the bottom of the sheet). Opened from a
place it adds there; otherwise it asks where. The menu photo is not kept.
Signed out it says it needs a free account; 401 opens sign-in; 402 the
credit sheet; 403 `verify-email` its sentence and "Send the link again";
sheets size themselves below the shared confirm-your-email banner.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8153/again/
npm test        # the rules first, then end to end over HTTP under an /again mount
```

`AGAIN_MEMORY=1` and `AGAIN_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `AGAIN_COLLECTION_PREFIX`
(`again_` from the lab host) prefixes every collection. `npm test` runs
with `REQUIRE_VERIFIED_FOR_FREE_AI=0` (the gate itself is held by the
suite's last test and by the lab's). The fake refuses a call that does not
force a tool, keeps every request (`fakeClient.calls`), answers picks only
when the request carried the person's dishes, and takes `fakeClient.mode`
for one call: `blank`, `inject`, `badpicks`, `maxtokens`, `upstreamNNN`.

`test/run.js` (31 tests): text, money and first names; folding and the
fuzzy place search (accents, "the", "&", prefixes, typos, a city, a
cuisine, the order); the dish search; quick-add; logging a visit (a new
place, the same place again, another day and verdict, the same day twice,
the errors, purity); editing and deleting with tombstones; the "I'm here"
card and its order (ties included), and "ago"; Want to try, tried lines
and settling a pick by logging it; browse; the stats with a fixed clock
and the year boundary; the share payload, the server's door (every
forbidden field), the friend's view and saving from it; JSON and CSV round
trips with formulas defused and restored and odd files; hostile input
through every door; sync cleaning and the merge; the menu request (every
forbidden field) and answer (bounds, picks from its own list); the made-up
list; contrast in both themes, the literal colours and the lab card; 44 px
targets; the page's promises (relative URLs, no inline script, the banner,
wrapped storage, IndexedDB in a try, photos redrawn, every received string
escaped, only the listed API paths, what the reader and a link send, the
locale fallback, the service worker); neutral copy, no invisible
characters and no key-shaped strings in any source file; the local
switches, the prefix and the one query; and over HTTP: signed out with zero
model calls and 401s before every parser, the gate order, one call site, a
sync's life (409s, two at once, the owner tag holds no id or email), the
server's cleaning and caps, share links (the code never stored, only the
allowed fields reach a friend, every forbidden field a 400, the same 404 for
closed, expired, malformed and unknown, five open, only the maker closes,
the wrong-code limit), the menu reader (400s with no model call, what the
model saw with and without the history, PNG, picks from its own list,
hostile output, 422, 502, 503) and the 403 / 402 / 503 gates.

Rendered with Playwright at 390px and 1280px, light and dark: the first
run, Try it, a fuzzy search, the "I'm here" card, logging a visit quickly
and with a photo, the card after (with the photo and "Alex was right ❤️"),
Want to try and turning a pick into a verdict, browse (places, every ❤️,
dish search), the stats, the share card (saved as PNG, with a photo), the
menu reader signed out, signed in with "What should I order?" and what is
sent, its answer and adding from it, a share link made, a friend's view in
a second browser with "Save" and their Want to try, Settings with the
links, a closed link, sync on, a two-device 409 and the merge, and the lab
card on the landing page and the app mounted under the lab host; no console
error or CSP violation, nothing scrolls sideways. Then a hostile pass
(markup, bidi, zero-width and very long strings in places, dishes, notes,
names, picks, a hostile CSV and a shared link opened by a friend): no
dialog, no injected element, no bidi character on the page, no live formula
in the export. Found on the way: a same-day merge of who was there threw,
note matches were weighted below the search threshold, cleaned names could
keep a stray hyphen, and a few layouts were tight at 390 px (the dish rows
in the log, the friend's Save buttons, the stats tiles in the desktop
aside, a toast with one long word).

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`). `lib/image.js` is
Sorted's byte checks and metadata stripping, by way of Haul and Takeback.

## Data

- **In the browser** (every access wrapped; works in memory when storage is
  unavailable, with a one-time warning): `again-data-v1` (places, dishes,
  picks, the ids of deleted ones for sync), `again-prefs-v1` (currency,
  sync on or off, the name friends see), `again-sync-v1` (the account
  version last seen, unsaved-change flag, last saved), `again-links-v1`
  (the codes of links this device made); IndexedDB `again` (`photos`:
  `d-<dish>` 1200 px and 240 px JPEGs). Clear everything in Settings. "Try
  it" is never saved.
- **In the lab database**: `again_lists/<tag>` (only after the person turns
  sync on) and `again_shares/<hash>` (only the allowed fields). No image and
  no AI answer is ever stored by the server.

## Routes

Public: `GET /api/health`, `/healthz`, `/api/me`, the page, the service
worker, `GET /s/:code` (the page) and `GET /api/s/:code` (a friend's view;
other methods 405). Signed in, free: `GET|PUT|DELETE /api/list`,
`POST|GET /api/shares`, `DELETE /api/shares/:id`. Metered: `POST
/api/ai/menu`. The shared account at `/api/auth`.

## Ideas not built yet

- **"You're here" by location** - needs the phone's location and a place
  lookup (an iPhone app's job, or a places API: new infrastructure).
- **A shared household list** (today a list is one account's).
- **A link that follows the list** (today a link is a copy; a new link
  updates it).
- **Picks saved to Want to try** from the menu reader.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; every parser that takes a
  body runs after its gates.
- Every typed place, dish, note and name, every imported file, every synced
  list, every friend's link and every model answer is untrusted: cleaned in
  the core (no markup, bidi or invisible characters, bounded), and escaped
  on render (the test cuts out every `esc(...)` and fails on a field
  concatenated into markup); the CSV is escaped for its own format; canvas
  text is drawn as text.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body, a photo or a dish name.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
